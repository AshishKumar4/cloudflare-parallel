/**
 * V3 prewarm regression tests.
 *
 * Empirical validation: a freshly-created Durable Object pays a one-time
 * creation cost (~300–400 ms in production); subsequent calls on the
 * warm channel are ~3–30 ms. The library's `Pool` fires a `noop()` to
 * the Coordinator DO in parallel with the first real dispatch (under
 * the `autoWarm: true` default) so the cold-start cost is absorbed off
 * the critical path.
 *
 * These tests pin three contracts:
 *   1. `Pool.warm()` calls `Coordinator.noop()` (or falls back gracefully
 *      when the binding doesn't expose `noop`).
 *   2. `autoWarm: true` (default) fires a single prewarm per Pool — never
 *      one prewarm per submit.
 *   3. `autoWarm: false` opts out and dispatches without prewarming.
 *
 * Live cold-vs-warm ratio is measured by the live edge bench, not by
 * these unit tests (the local dev runtime has no DO-creation cost to
 * amortize).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from '../../src/api/pool';
import type {
  CoordinatorFanOutRequest,
  CoordinatorRunRequest,
  RunOneResult,
} from '../../src/coordinator/protocol';
import type { PoolEnv } from '../../src/api/options';
import type { WorkerLoader } from '../../src/types';

interface DispatchTrace {
  kind: 'runOne' | 'runMany' | 'noop' | 'ping';
  ts: number;
}

/**
 * Minimal fake of a Durable Object namespace — `idFromName` returns the
 * string itself; `get` returns a stub whose RPC methods append to the
 * shared trace.
 */
function fakeNamespace(trace: DispatchTrace[]): DurableObjectNamespace {
  const stub = {
    runOne(_req: CoordinatorRunRequest): Promise<RunOneResult> {
      trace.push({ kind: 'runOne', ts: Date.now() });
      return Promise.resolve({ ok: true, value: undefined });
    },
    runMany(req: CoordinatorFanOutRequest) {
      trace.push({ kind: 'runMany', ts: Date.now() });
      return Promise.resolve({
        results: req.argsList.map(() => ({ ok: true as const, value: undefined })),
        topology: 'in-do' as const,
        fanOutPerLevel: [req.argsList.length],
        treeDepth: 1,
      });
    },
    async noop(): Promise<void> {
      trace.push({ kind: 'noop', ts: Date.now() });
    },
    async ping() {
      trace.push({ kind: 'ping', ts: Date.now() });
      return { ok: true, bindingKeys: [] };
    },
  };
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    newUniqueId: () => 'fake' as unknown as DurableObjectId,
    idFromString: (s: string) => s as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
    jurisdiction: () => {
      throw new Error('not implemented');
    },
  } as unknown as DurableObjectNamespace;
}

function fakeLoader(): WorkerLoader {
  return {
    get(_id: string, _cb: unknown) {
      throw new Error('Pool tests should not load isolates');
    },
  } as unknown as WorkerLoader;
}

describe('V3 prewarm', () => {
  let trace: DispatchTrace[];
  let env: PoolEnv;

  beforeEach(() => {
    trace = [];
    env = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakeNamespace(trace),
    };
  });

  afterEach(() => {
    trace = [];
  });

  it('autoWarm default fires noop() once before the first runMany', async () => {
    const pool = new Pool(env, {});
    await pool.map((x: number) => x * 2, [1, 2, 3]);
    const noops = trace.filter((t) => t.kind === 'noop');
    const runManys = trace.filter((t) => t.kind === 'runMany');
    expect(noops.length).toBe(1);
    expect(runManys.length).toBe(1);
  });

  it('autoWarm fires only once across multiple submits', async () => {
    const pool = new Pool(env, {});
    await pool.map((x: number) => x, [1, 2]);
    await pool.map((x: number) => x, [3, 4]);
    await pool.map((x: number) => x, [5, 6]);
    const noops = trace.filter((t) => t.kind === 'noop');
    expect(noops.length).toBe(1);
  });

  it('autoWarm: false opts out of prewarm', async () => {
    const pool = new Pool(env, { autoWarm: false });
    await pool.map((x: number) => x, [1, 2]);
    const noops = trace.filter((t) => t.kind === 'noop');
    expect(noops.length).toBe(0);
  });

  it('Pool.warm() fires noop() explicitly', async () => {
    const pool = new Pool(env, { autoWarm: false });
    await pool.warm();
    const noops = trace.filter((t) => t.kind === 'noop');
    expect(noops.length).toBe(1);
  });

  it('Pool.warm() is idempotent', async () => {
    const pool = new Pool(env, { autoWarm: false });
    await pool.warm();
    await pool.warm();
    await pool.warm();
    const noops = trace.filter((t) => t.kind === 'noop');
    expect(noops.length).toBe(1);
  });

  it('autoWarm + Pool.warm() do not double-prewarm', async () => {
    const pool = new Pool(env, {});
    await pool.warm();
    await pool.map((x: number) => x, [1, 2]);
    const noops = trace.filter((t) => t.kind === 'noop');
    expect(noops.length).toBe(1);
  });

  it('autoWarm fires concurrently with runMany (does not serialize)', async () => {
    // Replace the noop with a deliberately slow one to detect
    // serialization. If autoWarm awaited noop before runMany the runMany
    // would land after noop. We instrument timestamps and assert runMany
    // starts BEFORE noop completes (interleaved).
    let noopResolve: (() => void) | null = null;
    const slowNoopPromise = new Promise<void>((resolve) => {
      noopResolve = resolve;
    });
    const fakeStub = {
      runMany(req: CoordinatorFanOutRequest) {
        trace.push({ kind: 'runMany', ts: Date.now() });
        return Promise.resolve({
          results: req.argsList.map(() => ({ ok: true as const, value: undefined })),
          topology: 'in-do' as const,
          fanOutPerLevel: [req.argsList.length],
          treeDepth: 1,
        });
      },
      async noop(): Promise<void> {
        trace.push({ kind: 'noop', ts: Date.now() });
        await slowNoopPromise;
      },
    };
    const slowEnv: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        newUniqueId: () => 'fake' as unknown as DurableObjectId,
        idFromString: (s: string) => s as unknown as DurableObjectId,
        get: () => fakeStub as unknown as DurableObjectStub,
        jurisdiction: () => {
          throw new Error('not implemented');
        },
      } as unknown as DurableObjectNamespace,
    };
    const pool = new Pool(slowEnv, {});
    const fanOut = pool.map((x: number) => x, [1, 2, 3]);
    // Give the event loop a turn so both noop() and runMany() can start.
    await new Promise((r) => setTimeout(r, 5));
    // runMany should already have been called even though noop is still
    // pending — that's the parallelism contract.
    expect(trace.find((t) => t.kind === 'runMany')).toBeTruthy();
    expect(trace.find((t) => t.kind === 'noop')).toBeTruthy();
    // Unblock the noop and let everything finish.
    noopResolve!();
    await fanOut;
  });
});

/**
 * P0 regression: when `inProcess` is set, `autoWarm: true` must prime
 * the loaded isolate via the loopback (single no-op `runOne`) instead
 * of short-circuiting. Without this, every first dispatch after a
 * quiescence pays the full loader cold-start, surfacing as the user-
 * reported "the numbers change every time I refresh" complaint.
 */
describe('V3 prewarm — inProcess loopback', () => {
  let trace: DispatchTrace[];
  let env: PoolEnv;
  let inProcessRunOneCalls: number;
  let inProcessRunManyCalls: number;

  beforeEach(() => {
    trace = [];
    inProcessRunOneCalls = 0;
    inProcessRunManyCalls = 0;
    env = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakeNamespace(trace),
    };
  });

  function makeInProcess() {
    return {
      runOne: async (_req: CoordinatorRunRequest) => {
        inProcessRunOneCalls++;
        return { ok: true as const, value: undefined };
      },
      runMany: async (req: CoordinatorFanOutRequest) => {
        inProcessRunManyCalls++;
        return {
          results: req.argsList.map(() => ({ ok: true as const, value: undefined })),
          topology: 'in-do' as const,
          fanOutPerLevel: [req.argsList.length],
          treeDepth: 1,
        };
      },
    };
  }

  it('autoWarm + inProcess: fires a single prewarm runOne before the first runMany', async () => {
    const inProcess = makeInProcess();
    const pool = new Pool(env, { inProcess });
    await pool.map((x: number) => x, [1, 2]);
    // The prewarm uses runOne (no-op), the actual fan-out uses runMany.
    expect(inProcessRunOneCalls).toBe(1);
    expect(inProcessRunManyCalls).toBe(1);
    // The DO Coordinator noop must NOT fire when inProcess is set —
    // there's no DO to warm; the prewarm targets the loopback isolate.
    expect(trace.filter((t) => t.kind === 'noop')).toHaveLength(0);
  });

  it('autoWarm + inProcess: prewarm fires only once across multiple submits', async () => {
    const inProcess = makeInProcess();
    const pool = new Pool(env, { inProcess });
    await pool.map((x: number) => x, [1, 2]);
    await pool.map((x: number) => x, [3, 4]);
    await pool.map((x: number) => x, [5, 6]);
    expect(inProcessRunOneCalls).toBe(1); // prewarm dedupe'd
    expect(inProcessRunManyCalls).toBe(3); // three real fan-outs
  });

  it('autoWarm: false + inProcess: no prewarm fires', async () => {
    const inProcess = makeInProcess();
    const pool = new Pool(env, { inProcess, autoWarm: false });
    await pool.map((x: number) => x, [1, 2]);
    expect(inProcessRunOneCalls).toBe(0);
    expect(inProcessRunManyCalls).toBe(1);
  });

  it('Pool.warm() + inProcess: explicit warm forces prewarm even with autoWarm: false', async () => {
    const inProcess = makeInProcess();
    const pool = new Pool(env, { inProcess, autoWarm: false });
    await pool.warm();
    expect(inProcessRunOneCalls).toBe(1);
  });

  it('autoWarm + inProcess: prewarm runs concurrently with real dispatch (does not serialize)', async () => {
    // Slow prewarm; runMany should still fire promptly.
    let prewarmResolve: (() => void) | null = null;
    const prewarmPromise = new Promise<void>((r) => {
      prewarmResolve = r;
    });
    const events: string[] = [];
    const inProcess = {
      runOne: async (_req: CoordinatorRunRequest) => {
        events.push('prewarm-start');
        await prewarmPromise;
        events.push('prewarm-end');
        return { ok: true as const, value: undefined };
      },
      runMany: async (req: CoordinatorFanOutRequest) => {
        events.push('runMany-start');
        return {
          results: req.argsList.map(() => ({ ok: true as const, value: undefined })),
          topology: 'in-do' as const,
          fanOutPerLevel: [req.argsList.length],
          treeDepth: 1,
        };
      },
    };
    const pool = new Pool(env, { inProcess });
    const fanOut = pool.map((x: number) => x, [1, 2]);
    await new Promise((r) => setTimeout(r, 5));
    // The prewarm is still pending (we haven't called prewarmResolve
    // yet), but the real runMany should have STARTED already — that's
    // the parallelism contract for the loopback path.
    expect(events).toContain('prewarm-start');
    expect(events).toContain('runMany-start');
    // `prewarm-end` MUST NOT have fired yet — it's gated on prewarmPromise.
    expect(events).not.toContain('prewarm-end');
    // Unblock and let everything finish.
    prewarmResolve!();
    await fanOut;
    // Now prewarm-end has fired.
    expect(events).toContain('prewarm-end');
  });
});
