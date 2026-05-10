/**
 * P1 regression: `Parallel.actor` and `Parallel.scheduler` must plumb
 * `locationHint` (or auto-derive from `requestColo`) to `namespace.get`
 * — same shape as `Parallel.pool`.
 *
 * Before this fix, `actor.ts:#stub` and `scheduler.ts:#stub` called
 * `ns.get(ns.idFromName(...))` without the placement hint. Actors and
 * schedulers are sticky long-lived DOs, so first-placement matters
 * permanently. The miss was P1 in the audit.
 */
import { describe, expect, it } from 'bun:test';
import { ActorHandle } from '../../src/api/actor';
import { Scheduler } from '../../src/api/scheduler';
import type { PoolEnv } from '../../src/api/options';
import type { WorkerLoader } from '../../src/types';

interface GetCall {
  id: unknown;
  opts: unknown;
}

function fakeLoader(): WorkerLoader {
  return {
    get: (() => {
      throw new Error('LOADER.get unused in these tests');
    }) as unknown as WorkerLoader['get'],
  } as unknown as WorkerLoader;
}

/**
 * Build a fake `DurableObjectNamespace` that records every `get(id, opts)`
 * call. Mirrors the shape used elsewhere in the unit tests.
 */
function fakeNs(calls: GetCall[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    newUniqueId: () => 'fake' as unknown as DurableObjectId,
    idFromString: (s: string) => s as unknown as DurableObjectId,
    get: ((id: unknown, opts?: unknown) => {
      calls.push({ id, opts });
      // Minimal stub the call sites never actually invoke methods on in
      // these tests; the assertion lives on the `calls` recorder.
      return {
        actorEnsureInitialized: async () => undefined,
        actorSubmit: async () => ({ ok: true, value: undefined }),
        actorClose: async () => undefined,
        enqueue: async () => ({ id: 'job-1' }),
        status: async () => 'queued',
        result: async () => ({ status: 'done' }),
        cancel: async () => true,
        cancelByTenant: async () => 0,
        stats: async () => ({
          queued: 0, leased: 0, done: 0, failed: 0, cancelled: 0, oldestQueuedAgeMs: 0,
        }),
        configure: async () => ({ effective: {} }),
      } as unknown as DurableObjectStub;
    }) as unknown as DurableObjectNamespace['get'],
    jurisdiction: () => {
      throw new Error('not implemented');
    },
  } as unknown as DurableObjectNamespace;
}

describe('Actor — locationHint plumbing', () => {
  it('explicit locationHint is forwarded to ns.get', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakeNs(calls),
    };
    const handle = new ActorHandle(env, {
      id: 'a1',
      initialState: { count: 0 },
      locationHint: 'wnam',
    });
    // First submit triggers actorEnsureInitialized + actorSubmit.
    // We don't await the user fn (the fake stubs return immediately),
    // just trigger the stub access.
    await handle.submit(((state: { count: number }) => state.count) as never);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c.opts).toEqual({ locationHint: 'wnam' });
    }
  });

  it('requestColo auto-derives to locationHint', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakeNs(calls),
    };
    const handle = new ActorHandle(env, {
      id: 'a2',
      initialState: { count: 0 },
      requestColo: 'SJC', // SJC → wnam per the map
    });
    await handle.submit(((state: { count: number }) => state.count) as never);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c.opts).toEqual({ locationHint: 'wnam' });
    }
  });

  it('explicit locationHint wins over requestColo', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakeNs(calls),
    };
    const handle = new ActorHandle(env, {
      id: 'a3',
      initialState: { count: 0 },
      requestColo: 'SJC', // would give wnam
      locationHint: 'weur', // explicit override
    });
    await handle.submit(((state: { count: number }) => state.count) as never);
    for (const c of calls) {
      expect(c.opts).toEqual({ locationHint: 'weur' });
    }
  });

  it('no hint at all: ns.get is called without opts', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakeNs(calls),
    };
    const handle = new ActorHandle(env, {
      id: 'a4',
      initialState: { count: 0 },
    });
    await handle.submit(((state: { count: number }) => state.count) as never);
    for (const c of calls) {
      expect(c.opts).toBeUndefined();
    }
  });

  it('unknown colo: ns.get is called without opts (no false hint)', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakeNs(calls),
    };
    const handle = new ActorHandle(env, {
      id: 'a5',
      initialState: { count: 0 },
      requestColo: 'ZZZ', // not in the map
    });
    await handle.submit(((state: { count: number }) => state.count) as never);
    for (const c of calls) {
      expect(c.opts).toBeUndefined();
    }
  });
});

describe('Scheduler — locationHint plumbing', () => {
  it('explicit locationHint is forwarded to ns.get', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpSchedulerDO: fakeNs(calls),
    };
    const sched = new Scheduler(env, {
      id: 's1',
      locationHint: 'enam',
    });
    await sched.stats();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c.opts).toEqual({ locationHint: 'enam' });
    }
  });

  it('requestColo auto-derives', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpSchedulerDO: fakeNs(calls),
    };
    const sched = new Scheduler(env, {
      id: 's2',
      requestColo: 'IAD', // IAD → enam
    });
    await sched.stats();
    for (const c of calls) {
      expect(c.opts).toEqual({ locationHint: 'enam' });
    }
  });

  it('no hint: ns.get without opts', async () => {
    const calls: GetCall[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpSchedulerDO: fakeNs(calls),
    };
    const sched = new Scheduler(env, { id: 's3' });
    await sched.stats();
    for (const c of calls) {
      expect(c.opts).toBeUndefined();
    }
  });
});
