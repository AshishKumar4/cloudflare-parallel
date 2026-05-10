import { describe, expect, test } from 'bun:test';
import {
  Dispatcher,
  DEFAULT_DISPATCHER_CONFIG,
  type DispatcherConfig,
  type RunJobFn,
} from '../../src/scheduler/dispatcher';
import type { JobStore, PersistedJob } from '../../src/scheduler/job-store';
import { MemoryJobStore } from '../bench/mem-job-store';

function makeJob(overrides: Partial<PersistedJob>): PersistedJob {
  return {
    id: 'j1',
    tenantId: 't1',
    fnHash: 'h1',
    fnSource: '() => 1',
    args: [],
    createdAt: Date.now(),
    deadlineEpochMs: Date.now() + 60_000,
    retry: { max: 1, baseMs: 100, backoff: 'constant' },
    retryCount: 0,
    status: 'queued',
    ...overrides,
  };
}

function makeDispatcher(
  store: JobStore,
  runJob: RunJobFn,
  config?: Partial<DispatcherConfig>,
  hooks?: ConstructorParameters<typeof Dispatcher>[0]['hooks'],
): Dispatcher {
  return new Dispatcher({ store, runJob, ownerId: 'test-owner', config, hooks });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Dispatcher', () => {
  test('reactive dispatch — single job runs immediately on enqueue', async () => {
    const store = new MemoryJobStore();
    let invoked = false;
    const d = makeDispatcher(store, async () => {
      invoked = true;
      return 42;
    });
    const t0 = Date.now();
    await d.enqueue(makeJob({ id: 'j1' }));
    // give the loop one microtask to run
    await wait(10);
    expect(invoked).toBe(true);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200); // way under the old 5s alarm cycle
    expect((await store.result('j1')).value).toBe(42);
  });

  test('parallelism up to inFlightLimit; over-limit jobs queue', async () => {
    const store = new MemoryJobStore();
    let active = 0;
    let peakActive = 0;
    const d = makeDispatcher(
      store,
      async () => {
        active++;
        peakActive = Math.max(peakActive, active);
        await wait(30);
        active--;
        return 1;
      },
      { inFlightLimit: 4, fairCapacityPerTenant: 100 },
    );
    for (let i = 0; i < 20; i++) {
      // unique tenants so fairCapacityPerTenant doesn't gate
      await d.enqueue(makeJob({ id: `j${i}`, tenantId: `t${i}` }));
    }
    while ([...store.jobs.values()].some((j) => j.status !== 'done' && j.status !== 'failed')) {
      await wait(10);
    }
    expect(peakActive).toBeLessThanOrEqual(4);
    expect(peakActive).toBeGreaterThanOrEqual(2);
  });

  test('fair-queueing — one chatty tenant cannot starve others', async () => {
    const store = new MemoryJobStore();
    const order: string[] = [];
    const d = makeDispatcher(
      store,
      async (job) => {
        order.push(job.tenantId);
        await wait(5);
        return null;
      },
      { inFlightLimit: 1, fairCapacityPerTenant: 1 },
    );
    // tenant A: 4 jobs; tenant B: 2 jobs interleaved later
    for (let i = 0; i < 4; i++) {
      await d.enqueue(makeJob({ id: `a${i}`, tenantId: 'A' }));
    }
    for (let i = 0; i < 2; i++) {
      await d.enqueue(makeJob({ id: `b${i}`, tenantId: 'B' }));
    }
    while ([...store.jobs.values()].some((j) => j.status !== 'done')) {
      await wait(10);
    }
    // Round-robin must interleave A and B, not run all of A first
    const firstB = order.indexOf('B');
    const lastA = order.lastIndexOf('A');
    expect(firstB).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeLessThan(lastA);
  });

  test('maxQueueDepth — enqueue throws QueueFullError', async () => {
    const store = new MemoryJobStore();
    let block = true;
    const d = makeDispatcher(
      store,
      async () => {
        while (block) await wait(5);
        return 1;
      },
      { inFlightLimit: 1, maxQueueDepth: 2, fairCapacityPerTenant: 100 },
    );
    await d.enqueue(makeJob({ id: 'j1', tenantId: 't1' }));
    await wait(5);
    await d.enqueue(makeJob({ id: 'j2', tenantId: 't2' }));
    await d.enqueue(makeJob({ id: 'j3', tenantId: 't3' }));
    await expect(d.enqueue(makeJob({ id: 'j4', tenantId: 't4' }))).rejects.toThrow(/queue full/i);
    block = false;
    while ([...store.jobs.values()].some((j) => j.status !== 'done' && j.status !== 'failed')) {
      await wait(10);
    }
  });

  test('single-flight loop — concurrent kicks do not double-run', async () => {
    const store = new MemoryJobStore();
    let active = 0;
    let peakActive = 0;
    const d = makeDispatcher(
      store,
      async () => {
        active++;
        peakActive = Math.max(peakActive, active);
        await wait(20);
        active--;
        return 1;
      },
      { inFlightLimit: 1, fairCapacityPerTenant: 100 },
    );
    await d.enqueue(makeJob({ id: 'j1', tenantId: 't1' }));
    // hammer kicks — they should be no-ops while loop is in-flight
    for (let i = 0; i < 20; i++) d.kick();
    while ((await store.status('j1')) !== 'done') await wait(5);
    expect(peakActive).toBe(1);
  });

  test('reactive re-entry — settle of one job pulls next within ms (not seconds)', async () => {
    const store = new MemoryJobStore();
    const settles: number[] = [];
    const d = makeDispatcher(
      store,
      async () => {
        settles.push(Date.now());
        await wait(5);
        return 1;
      },
      { inFlightLimit: 1, fairCapacityPerTenant: 100 },
    );
    await d.enqueue(makeJob({ id: 'j1', tenantId: 't1' }));
    await d.enqueue(makeJob({ id: 'j2', tenantId: 't2' }));
    await d.enqueue(makeJob({ id: 'j3', tenantId: 't3' }));
    while ([...store.jobs.values()].some((j) => j.status !== 'done')) await wait(5);
    expect(settles.length).toBe(3);
    const gap1 = settles[1] - settles[0];
    const gap2 = settles[2] - settles[1];
    // Old alarm-batched dispatch had >= 5000ms between batches.
    // Reactive dispatch should be sub-100ms.
    expect(gap1).toBeLessThan(100);
    expect(gap2).toBeLessThan(100);
  });

  test('retry-on-fail — onScheduleRetry hook fires with backoff', async () => {
    const store = new MemoryJobStore();
    const delays: number[] = [];
    let calls = 0;
    const d = makeDispatcher(
      store,
      async () => {
        calls++;
        throw new Error('boom');
      },
      DEFAULT_DISPATCHER_CONFIG,
      { onScheduleRetry: (ms) => delays.push(ms) },
    );
    await d.enqueue(
      makeJob({
        id: 'j1',
        retry: { max: 3, backoff: 'exponential', baseMs: 100 },
      }),
    );
    await wait(50);
    // First call failed → re-queued → onScheduleRetry called with 100ms (base * 2^0).
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(delays.length).toBeGreaterThanOrEqual(1);
    expect(delays[0]).toBe(100);
  });

  test('retried jobs run after backoff (no alarm-tick wait)', async () => {
    const store = new MemoryJobStore();
    let calls = 0;
    const d = makeDispatcher(
      store,
      async () => {
        calls++;
        if (calls < 3) throw new Error(`boom-${calls}`);
        return 'ok';
      },
      DEFAULT_DISPATCHER_CONFIG,
    );
    const t0 = Date.now();
    await d.enqueue(
      makeJob({
        id: 'retry-job',
        retry: { max: 5, backoff: 'constant', baseMs: 50 },
      }),
    );
    // Wait long enough for 2 retries with 50ms backoff each (~100ms total).
    while (calls < 3) await wait(10);
    const elapsed = Date.now() - t0;
    expect(calls).toBe(3);
    // Three calls × ~50ms backoff between retries should fit in 500ms,
    // proving we don't wait for an alarm tick (which would be 5000+ms).
    expect(elapsed).toBeLessThan(500);
    expect((await store.result('retry-job')).value).toBe('ok');
  });

  test('rebuild from storage on init recovers ready set after restart', async () => {
    const store = new MemoryJobStore();
    await store.enqueue(makeJob({ id: 'j1', tenantId: 't1' }));
    await store.enqueue(makeJob({ id: 'j2', tenantId: 't2' }));
    let ran = 0;
    const d = makeDispatcher(store, async () => {
      ran++;
      return 1;
    });
    expect(d.totalReady()).toBe(0); // not yet rebuilt
    await d.rebuildFromStorage();
    expect(d.totalReady()).toBe(2);
    d.kick();
    while ([...store.jobs.values()].some((j) => j.status !== 'done')) await wait(10);
    expect(ran).toBe(2);
  });

  test('drop-from-ready removes a queued job by id', async () => {
    const store = new MemoryJobStore();
    let block = true;
    const d = makeDispatcher(
      store,
      async () => {
        while (block) await wait(2);
        return 1;
      },
      { inFlightLimit: 1, fairCapacityPerTenant: 100 },
    );
    await d.enqueue(makeJob({ id: 'j1', tenantId: 't1' }));
    await d.enqueue(makeJob({ id: 'j2', tenantId: 't1' }));
    await d.enqueue(makeJob({ id: 'j3', tenantId: 't1' }));
    await wait(10);
    // j1 leased and blocked; j2 + j3 queued in ready.
    expect(d.totalReady()).toBeGreaterThanOrEqual(2);
    d.dropFromReady('j2');
    const ready = d.inspectReady();
    const ids = [...ready.values()].flat();
    expect(ids).not.toContain('j2');
    expect(ids).toContain('j3');
    // Storage still has j2 as queued — dropFromReady is in-memory only.
    expect(await store.status('j2')).toBe('queued');
    block = false;
  });

  test('clearTenant drops all ready jobs for a tenant', async () => {
    const store = new MemoryJobStore();
    let block = true;
    const d = makeDispatcher(
      store,
      async () => {
        while (block) await wait(2);
        return 1;
      },
      { inFlightLimit: 1, fairCapacityPerTenant: 100 },
    );
    await d.enqueue(makeJob({ id: 'a1', tenantId: 'A' }));
    await d.enqueue(makeJob({ id: 'a2', tenantId: 'A' }));
    await d.enqueue(makeJob({ id: 'b1', tenantId: 'B' }));
    await wait(10);
    d.clearTenant('A');
    const ready = d.inspectReady();
    expect(ready.has('A')).toBe(false);
    expect(ready.has('B')).toBe(true);
    block = false;
  });

  test('deadline-exceeded jobs fail without invoking runJob', async () => {
    const store = new MemoryJobStore();
    let invoked = false;
    const d = makeDispatcher(store, async () => {
      invoked = true;
      return 1;
    });
    await d.enqueue(
      makeJob({
        id: 'late',
        deadlineEpochMs: Date.now() - 1000,
        retry: { max: 1, baseMs: 100, backoff: 'constant' },
      }),
    );
    await wait(50);
    expect(invoked).toBe(false);
    expect(await store.status('late')).toBe('failed');
  });

  test('configure() merges into effective config', async () => {
    const store = new MemoryJobStore();
    const d = makeDispatcher(store, async () => 1);
    expect(d.config().inFlightLimit).toBe(DEFAULT_DISPATCHER_CONFIG.inFlightLimit);
    d.configure({ inFlightLimit: 7 });
    expect(d.config().inFlightLimit).toBe(7);
    expect(d.config().fairCapacityPerTenant).toBe(DEFAULT_DISPATCHER_CONFIG.fairCapacityPerTenant);
  });

  test('stats() reflects ready/running/limits', async () => {
    const store = new MemoryJobStore();
    let block = true;
    const d = makeDispatcher(
      store,
      async () => {
        while (block) await wait(2);
        return 1;
      },
      { inFlightLimit: 2, fairCapacityPerTenant: 100, maxQueueDepth: 50 },
    );
    await d.enqueue(makeJob({ id: 'j1', tenantId: 't1' }));
    await d.enqueue(makeJob({ id: 'j2', tenantId: 't2' }));
    await d.enqueue(makeJob({ id: 'j3', tenantId: 't3' }));
    await wait(10);
    const s = d.stats();
    expect(s.inFlightLimit).toBe(2);
    expect(s.maxQueueDepth).toBe(50);
    expect(s.running).toBeGreaterThanOrEqual(0);
    block = false;
    while ([...store.jobs.values()].some((j) => j.status !== 'done')) await wait(10);
  });

  test('throughput — measured >> 0.8 jobs/s (old alarm-batched cap)', async () => {
    const store = new MemoryJobStore();
    let done = 0;
    const d = makeDispatcher(
      store,
      async () => {
        done++;
        return 1;
      },
      { inFlightLimit: 16, fairCapacityPerTenant: 100 },
    );
    const N = 100;
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      await d.enqueue(makeJob({ id: `j${i}`, tenantId: `t${i % 8}` }));
    }
    while (done < N) await wait(5);
    const elapsedMs = Date.now() - t0;
    const throughput = (N / elapsedMs) * 1000;
    // Old design: 4 jobs / 5000ms = 0.8 jobs/s. New design should be 100x+.
    expect(throughput).toBeGreaterThan(50);
  });
});
