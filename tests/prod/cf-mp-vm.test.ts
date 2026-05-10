/**
 * Live prod tests against the cf-mp-vm reference worker
 * (https://cf-mp-vm.ashishkumarsingh.com) — the empirical baseline our
 * 4N math is calibrated against.
 *
 * These tests do NOT exercise the `cloudflare-parallel` library shape;
 * they validate the *substrate* (Worker Loader + DO loader semaphore)
 * still has the empirical caps documented in DESIGN §2 and our
 * topology selector relies on:
 *
 *   - `/a/benchmark` (loader-only, from Worker fetch handler) caps at 3
 *     concurrent loaders.
 *   - `/b/benchmark` (DO method) caps at 4 concurrent loaders.
 *   - `/a/lru-probe` exhibits 50/owner LRU eviction.
 *   - With `mode=parallel-diff` and `n` distinct codeKeys, `uniqueIsolates`
 *     equals min(n, owner cap).
 *
 * If ANY of these break, the topology selector's assumptions break, and
 * we want to know before users do.
 *
 * To run: `bun test tests/prod/cf-mp-vm.test.ts`
 * Skip if offline: `SKIP_PROD_TESTS=1 bun test ...`
 */
import { describe, expect, test } from 'bun:test';

const BASE = process.env.CFP_PROD_BASE ?? 'https://cf-mp-vm.ashishkumarsingh.com';
const SKIP = process.env.SKIP_PROD_TESTS === '1';

type ABenchResult = {
  backend: 'loader-only' | 'vm-do+loader';
  mode: string;
  n: number;
  wallTotalMs: number;
  uniqueIsolates: number;
  isolateIds: string[];
  results: Array<{ idx: number; isolateId: string; callCount: number; finalX: number }>;
  err: string | null;
};

type BBenchResult = ABenchResult & { uniqueDOs: number; doIds?: string[] };

type LruProbeResult = {
  n: number;
  iters: number;
  prefix: string;
  evictedFirst5: number;
  phase1Count: number;
  phase1: Array<{ idx: number; isolateId: string; bornAt: number }>;
  phase2?: Array<{ idx: number; isolateId: string }>;
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${url}`);
  return r.json() as Promise<T>;
}

const it = SKIP ? test.skip : test;

describe('cf-mp-vm substrate', () => {
  it('health endpoint reports loader + DO availability', async () => {
    const h = await fetchJson<{ ok: boolean; hasLoader: boolean; hasDoNs: boolean }>(
      `${BASE}/health`,
    );
    expect(h.ok).toBe(true);
    expect(h.hasLoader).toBe(true);
    expect(h.hasDoNs).toBe(true);
  }, 10_000);

  it('loader-only (/a) parallel-diff: spins up N distinct isolates for N codeKeys', async () => {
    const r = await fetchJson<ABenchResult>(
      `${BASE}/a/benchmark?n=4&iters=1000&mode=parallel-diff`,
    );
    expect(r.err).toBeNull();
    expect(r.backend).toBe('loader-only');
    // From a Worker fetch handler the empirical cap is 3 concurrent
    // loaders. With n=4, at minimum 3 distinct isolates should appear;
    // the 4th may either join an existing or spin a 4th if scheduling
    // serializes one. Allow either.
    expect(r.uniqueIsolates).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('do+loader (/b) parallel-diff with n=4: hits the 4-loader DO cap', async () => {
    const r = await fetchJson<BBenchResult>(
      `${BASE}/b/benchmark?n=4&iters=1000&mode=parallel-diff`,
    );
    expect(r.err).toBeNull();
    // cf-mp-vm reports `do+loader`; we treat any backend mentioning
    // both terms as DO-routed.
    expect(r.backend).toMatch(/do.*loader|loader.*do/);
    expect(r.uniqueIsolates).toBeGreaterThanOrEqual(3);
    expect(r.uniqueIsolates).toBeLessThanOrEqual(4);
  }, 30_000);

  it('parallel-same: identical codeKeys reuse one isolate', async () => {
    const r = await fetchJson<ABenchResult>(
      `${BASE}/a/benchmark?n=4&iters=1000&mode=parallel-same`,
    );
    expect(r.err).toBeNull();
    // All 4 calls share one codeKey → one isolate.
    expect(r.uniqueIsolates).toBe(1);
  }, 30_000);

  it('lru-probe: owner cap kicks in beyond 50 distinct isolates', async () => {
    // Probe 60 distinct codeKeys; we expect to see eviction once we
    // cross 50. The probe response surfaces `evictedFirst5` — count of
    // first-5 codeKeys whose isolate-id changed in phase 2.
    const r = await fetchJson<LruProbeResult>(`${BASE}/a/lru-probe?n=60&iters=10`);
    expect(r.phase1Count).toBe(60);
    expect(r.phase1.length).toBe(60);
    // 60 > 50 → at least some of the early isolates should have been
    // evicted by the time we re-call them in phase 2.
    expect(r.evictedFirst5).toBeGreaterThan(0);
  }, 60_000);

  it('worker-fetch loader cap: n=8 distinct loaders saturates at 3 concurrent', async () => {
    // Substrate empirical bound: a Worker fetch handler can dispatch
    // at most 3 concurrent loader calls. Our 4N math relies on this —
    // it's why /b (DO method, cap=4) gives more parallelism per leaf
    // than /a. Validate by failing in the expected way at n=8.
    const r = await fetchJson<ABenchResult>(
      `${BASE}/a/benchmark?n=8&iters=1000&mode=parallel-diff`,
    );
    expect(r.err).toBeTruthy();
    expect(r.err!).toMatch(/too many concurrent/i);
  }, 60_000);

  it('do-method loader cap: /b with n=4 succeeds (DO cap is 4)', async () => {
    // Same n=4 from inside a DO method (the /b path) succeeds — DO
    // method cap is 4, not 3. This is the asymmetry the topology
    // selector exploits.
    const r = await fetchJson<BBenchResult>(
      `${BASE}/b/benchmark?n=4&iters=1000&mode=parallel-diff`,
    );
    expect(r.err).toBeNull();
    expect(r.uniqueIsolates).toBe(4);
  }, 60_000);

  it('CPU-bound parallel beats sequential by ≥2x at n=4 (DO topology)', async () => {
    // The headline 4-isolate parallel claim. Use 100k iters so the per-call
    // CPU work (~100ms sequential) dominates dispatch overhead. Best-of-3
    // to absorb cf-mp-vm wallTotalMs jitter.
    const samples: number[] = [];
    let lastUnique = 0;
    for (let i = 0; i < 3; i++) {
      const seq = await fetchJson<BBenchResult>(
        `${BASE}/b/benchmark?n=4&iters=100000&mode=sequential`,
      );
      const par = await fetchJson<BBenchResult>(
        `${BASE}/b/benchmark?n=4&iters=100000&mode=parallel-diff`,
      );
      expect(seq.err).toBeNull();
      expect(par.err).toBeNull();
      lastUnique = par.uniqueIsolates;
      if (par.wallTotalMs > 0) {
        samples.push(seq.wallTotalMs / par.wallTotalMs);
      }
    }
    expect(lastUnique).toBe(4);
    expect(samples.length).toBeGreaterThan(0);
    const bestSpeedup = Math.max(...samples);
    // Theoretical max 4x (4 isolates); demand ≥2x best-of-3 to stay above noise.
    expect(bestSpeedup).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('CPU-bound parallel scales beyond n=4 (cf-mp-vm reference caps at 32)', async () => {
    // At n=8 / n=16 / n=32, cf-mp-vm's reference fan-out exceeds the
    // 4-loader-per-DO cap by spinning up multiple DOs. We verify the
    // speedup stays high — the topology selector in our library uses
    // exactly this asymmetry. Take best-of-3 to dampen network jitter.
    const samples: number[] = [];
    let lastUnique = 0;
    for (let i = 0; i < 3; i++) {
      const par = await fetchJson<BBenchResult>(
        `${BASE}/b/benchmark?n=16&iters=100000&mode=parallel-diff`,
      );
      const seq = await fetchJson<BBenchResult>(
        `${BASE}/b/benchmark?n=16&iters=100000&mode=sequential`,
      );
      expect(par.err).toBeNull();
      expect(seq.err).toBeNull();
      lastUnique = par.uniqueIsolates;
      if (par.wallTotalMs > 0) {
        samples.push(seq.wallTotalMs / par.wallTotalMs);
      }
    }
    expect(lastUnique).toBe(16);
    expect(samples.length).toBeGreaterThan(0);
    const bestSpeedup = Math.max(...samples);
    // n=16 cpu-heavy: empirically 5-10x in cf-mp-vm. Demand ≥2x best-of-3.
    expect(bestSpeedup).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it('isolate identity stable across same-codeKey calls (cache works)', async () => {
    const r = await fetchJson<BBenchResult>(
      `${BASE}/b/benchmark?n=8&iters=1000&mode=parallel-same`,
    );
    expect(r.err).toBeNull();
    // 8 calls, all same codeKey → exactly 1 isolate.
    expect(r.uniqueIsolates).toBe(1);
    // And each call's reported isolateId must be that same one.
    const unique = new Set(r.results.map((x) => x.isolateId));
    expect(unique.size).toBe(1);
  }, 30_000);

  it('isolate identity differs across distinct codeKeys (cache is per-key)', async () => {
    const r = await fetchJson<BBenchResult>(
      `${BASE}/b/benchmark?n=8&iters=1000&mode=parallel-diff`,
    );
    expect(r.err).toBeNull();
    expect(r.uniqueIsolates).toBe(8);
    const unique = new Set(r.results.map((x) => x.isolateId));
    expect(unique.size).toBe(8);
  }, 30_000);
});
