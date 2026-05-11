/**
 * P0 regression: `taskSlot` must flow end-to-end from `pool.map`'s
 * dispatch through every coordinator tier down to `LoaderRunner.runOne`,
 * so each task in a fan-out gets a distinct cache key.
 *
 * The cache-key slot suffix is an **isolation** primitive: N distinct
 * tasks land in N distinct loaded isolates (independent ~128 MiB V8
 * heaps, independent module-level state) rather than colliding on a
 * single cached isolate. CPU parallelism comes from a different axis —
 * each leaf DO is a separate workerd process — but isolation matters
 * even when the work is CPU-bound (no cross-task globals, no shared
 * `Map`s, no surprise state coupling).
 *
 * The test instruments a fake Worker Loader that records every
 * `get(id, cb)` call, then asserts that a 4-item `pool.map` produces 4
 * distinct loader IDs.
 */
import { describe, expect, it } from 'bun:test';
import { Pool } from '../../src/api/pool';
import { LoaderOnlyPoolImpl } from '../../src/api/loader-only-pool';
import type { CoordinatorRunRequest, RunOneResult } from '../../src/coordinator/protocol';
import type { PoolEnv } from '../../src/api/options';
import type { WorkerLoader } from '../../src/types';
import { extractFnShapeHash } from '../../src/loader/cache-key';

interface RecordedGet {
  id: string;
}

/**
 * A fake Worker Loader that records every `get(id, cb)` call and returns
 * a stub whose entrypoint's `execute()` just echoes its first arg.
 */
function fakeLoader(record: RecordedGet[]): WorkerLoader {
  const stub = {
    getEntrypoint: () => ({
      execute: async (_envelope: unknown, ...args: unknown[]) => args[0],
    }),
  };
  return {
    get: (id: string, _cb: unknown) => {
      record.push({ id });
      return stub;
    },
  } as unknown as WorkerLoader;
}

function fakeNoopNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    newUniqueId: () => 'fake' as unknown as DurableObjectId,
    idFromString: (s: string) => s as unknown as DurableObjectId,
    get: () => ({}) as unknown as DurableObjectStub,
    jurisdiction: () => {
      throw new Error('not implemented');
    },
  } as unknown as DurableObjectNamespace;
}

describe('taskSlot dispatch — loader-only pool', () => {
  it('pool.map at N=4 produces 4 distinct loader IDs (4 distinct isolates)', async () => {
    const record: RecordedGet[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(record),
    };
    const pool = new LoaderOnlyPoolImpl(env, {});
    const items = [10, 20, 30, 40];
    const out = await pool.map((x: number) => x + 1, items);
    expect(out.length).toBe(4);
    expect(record.length).toBe(4);
    const uniqueIds = new Set(record.map((r) => r.id));
    expect(uniqueIds.size).toBe(4); // 4 unique isolates
    // All four share the same fn-shape hash — they're the same fn.
    const hashes = record.map((r) => extractFnShapeHash(r.id));
    expect(new Set(hashes).size).toBe(1);
    // All four have a `:slot-<i>` suffix.
    const slots = record.map((r) => r.id.match(/:slot-(\d+)$/)?.[1]).sort();
    expect(slots).toEqual(['0', '1', '2', '3']);
  });

  it('second pool.map at the same N=4 hits the same 4 IDs (warm reuse)', async () => {
    const record: RecordedGet[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(record),
    };
    const pool = new LoaderOnlyPoolImpl(env, {});
    await pool.map((x: number) => x + 1, [1, 2, 3, 4]);
    const firstFour = record
      .slice(0, 4)
      .map((r) => r.id)
      .sort();
    await pool.map((x: number) => x + 1, [5, 6, 7, 8]);
    const secondFour = record
      .slice(4, 8)
      .map((r) => r.id)
      .sort();
    expect(firstFour).toEqual(secondFour); // same keys, warm reuse
  });

  it('pool.submit single-shot uses slot 0', async () => {
    const record: RecordedGet[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(record),
    };
    const pool = new LoaderOnlyPoolImpl(env, {});
    await pool.submit((x: number) => x * 2, 5);
    expect(record.length).toBe(1);
    expect(record[0].id).toMatch(/:slot-0$/);
  });

  it('pool.scatter uses one slot per chunk', async () => {
    const record: RecordedGet[] = [];
    const env: PoolEnv = {
      LOADER: fakeLoader(record),
    };
    const pool = new LoaderOnlyPoolImpl(env, {});
    await pool.scatter(
      (batch: number[]) => batch.reduce((a, b) => a + b, 0),
      [1, 2, 3, 4, 5, 6],
      3, // 3 chunks
    );
    expect(record.length).toBe(3);
    const slots = record.map((r) => r.id.match(/:slot-(\d+)$/)?.[1]).sort();
    expect(slots).toEqual(['0', '1', '2']);
  });
});

describe('taskSlot dispatch — Pool via inProcess loopback', () => {
  /**
   * Single-shot `submit` routes through the inProcess loopback. The
   * Pool sets `taskSlot: 0` so the loopback isolate is shared with
   * slot-0 of any future fan-out's first task (compatible reuse).
   *
   * Fan-outs (size ≥ 2) route through the DO Coordinator (not the
   * loopback) so each task lands in its own leaf DO process for real
   * CPU parallelism. See `IN_PROCESS_THRESHOLD` in `src/api/pool.ts`.
   */
  it('Pool.submit through inProcess sends taskSlot 0', async () => {
    const received: CoordinatorRunRequest[] = [];
    const inProcess = {
      runOne: async (req: CoordinatorRunRequest): Promise<RunOneResult> => {
        received.push(req);
        return { ok: true, value: 0 };
      },
      runMany: async () => ({
        results: [],
        topology: 'in-do' as const,
        fanOutPerLevel: [],
        treeDepth: 1,
      }),
    };
    const env: PoolEnv = {
      LOADER: { get: () => ({}) } as unknown as WorkerLoader,
      CfpCoordinator: fakeNoopNamespace(),
    };
    const pool = new Pool(env, { inProcess });
    await pool.submit((x: number) => x, 42);
    // Two runOne calls expected: the autoWarm prewarm (no-op) +
    // the real submit. Both should carry `taskSlot: 0`.
    expect(received.length).toBeGreaterThanOrEqual(1);
    // The LAST runOne is the real submit (prewarm is fire-and-forget
    // and may resolve in any order with the real call).
    const real = received[received.length - 1];
    expect(real.taskSlot).toBe(0);
  });
});
