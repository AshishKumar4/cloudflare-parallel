import { describe, expect, it } from 'bun:test';
import { Parallel } from '../../src/api/parallel';
import { CancelToken } from '../../src/api/cancel';
import type { IPool } from '../../src/api/pool';
import type { IActorHandle } from '../../src/api/actor';
import type { IScheduler } from '../../src/api/scheduler';

describe('Parallel.testing.poolFake', () => {
  it('returns a canonical IPool (no `as` casts needed)', () => {
    const pool: IPool = Parallel.testing.poolFake();
    void pool; // type-only assertion — fails compile if return type drifts
  });

  it('runs a basic submit', async () => {
    const pool = Parallel.testing.poolFake();
    const r = await pool.submit((x: number, y: number) => x + y, 2, 3);
    expect(r).toBe(5);
  });

  it('passes typed bindings through env', async () => {
    const pool = Parallel.testing.poolFake<{ MULT: number }>({ bindings: { MULT: 3 } });
    const r = await pool.submit((x: number, env) => x * env.MULT, 4);
    expect(r).toBe(12);
  });

  it('runs map', async () => {
    const pool = Parallel.testing.poolFake();
    const out = await pool.map((n: number) => n * n, [1, 2, 3, 4]);
    expect(out).toEqual([1, 4, 9, 16]);
  });

  it('structured-clones args (catches non-cloneable)', async () => {
    const pool = Parallel.testing.poolFake();
    const fn = () => 1;
    let caught: unknown;
    try {
      await pool.submit((arg: unknown) => arg, fn as unknown as number);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });

  it('respects cancellation via env.signal (real AbortSignal)', async () => {
    const pool = Parallel.testing.poolFake();
    const ct = new CancelToken();
    setTimeout(() => ct.cancel('done'), 5);
    const r = await pool.submit(
      async (n: number, env: { signal: AbortSignal }) => {
        for (let i = 0; i < 100; i++) {
          if (env.signal.aborted) return -1;
          await new Promise((res) => setTimeout(res, 1));
        }
        return n;
      },
      42,
      { cancel: ct },
    );
    expect(r).toBe(-1);
  });
});

describe('Parallel.testing.actorFake', () => {
  it('returns a canonical IActorHandle', () => {
    const actor: IActorHandle<{ count: number }, Record<string, unknown>> =
      Parallel.testing.actorFake<{ count: number }, Record<string, unknown>>({
        id: 't0',
        initialState: { count: 0 },
      });
    void actor;
  });

  it('persists state across submits', async () => {
    const actor = Parallel.testing.actorFake<{ count: number }, Record<string, unknown>>({
      id: 't',
      initialState: { count: 0 },
    });
    await actor.submit((state) => {
      state.count = 1;
      return state.count;
    });
    const r = await actor.submit((state) => {
      state.count++;
      return state.count;
    });
    expect(r).toBe(2);
  });

  it('serializes concurrent submits (no race on state)', async () => {
    // Production actors are DO-serialized. The fake must match. Without
    // serialization, 100 concurrent increments would race and lose updates.
    const actor = Parallel.testing.actorFake<{ count: number }, Record<string, unknown>>({
      id: 'race',
      initialState: { count: 0 },
    });
    const submits = Array.from({ length: 100 }, () =>
      actor.submit((state) => {
        // Observable mid-mutation slot: do an async tick to maximize the
        // race window — without serialization, two reads return the same
        // count and we'd lose increments.
        const before = state.count;
        return Promise.resolve().then(() => {
          state.count = before + 1;
          return state.count;
        });
      }),
    );
    const results = await Promise.all(submits);
    // All 100 submits must complete with strictly increasing values.
    expect(results.length).toBe(100);
    expect(Math.max(...results)).toBe(100);
    expect(new Set(results).size).toBe(100);
  });
});

describe('Parallel.testing.schedulerFake', () => {
  it('returns a canonical IScheduler', () => {
    const sched: IScheduler = Parallel.testing.schedulerFake({ id: 's0' });
    void sched;
  });

  it('runs an enqueued job to completion', async () => {
    const sched = Parallel.testing.schedulerFake({ id: 's' });
    const handle = await sched.enqueue<[number, number], number>({
      fn: (a, b) => a + b,
      args: [3, 4],
    });
    expect(await handle.result()).toBe(7);
  });
});
