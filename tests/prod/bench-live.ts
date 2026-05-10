#!/usr/bin/env bun
/**
 * Live edge bench harness.
 *
 * Drives the deployed `cloudflare-parallel-prod-tests` worker through the
 * four hero workloads at every topology-relevant size, with separate
 * cold-run / warm-run reporting and equal warmup for both paths. Outputs
 * to `bench-results-live.json` so the demo site can render the results.
 *
 * Methodology (rewritten after a third-party review flagged the prior
 * harness as "70% bench-methodology bug + 30% real cold-start"):
 *
 *   1. **Equal warmup.** Before measuring either path, run two throwaway
 *      iterations of BOTH the parallel and sequential-sample endpoints at
 *      the size in question. This burns the coordinator-DO spin-up, the
 *      LRU loader cache primer, and any first-RPC `getActor` resolution.
 *
 *   2. **Median-of-≥5.** Each measurement is a median of `SAMPLES = 5`
 *      runs. Median-of-3 (the prior default) is too noisy: a single cold
 *      run dominates a 3-sample window.
 *
 *   3. **Separate cold/warm fields.** `coldRunMs` is the FIRST measured
 *      run after warmup; `warmRunMs` is the median of subsequent runs.
 *      Speedup is computed against `warmRunMs` so we report steady-state
 *      throughput, not first-call cost.
 *
 *   4. **Sequential-sample × N extrapolation.** workloads expose a
 *      `mode: 'sequential-sample'` route that runs ONE task inline and
 *      returns its wall-clock; the harness multiplies by N to get the
 *      sequential baseline. This avoids burning the parent Worker's
 *      cpuMs budget on a 64-task sequential SHA chain.
 *
 *   5. **Honest client-side timing.** The Workers runtime throttles `Date.now()` for
 *      timing-attack mitigation, so sub-second wall-clock often reports
 *      0 ms server-side. We fall back to client-side fetch round-trip
 *      whenever the server reports 0.
 *
 * Usage: `CFP_E2E_TARGET=<url> bun run tests/prod/bench-live.ts`
 */
import { writeFileSync } from 'node:fs';

const TARGET =
  process.env.CFP_E2E_TARGET ??
  'https://cloudflare-parallel-prod-tests.ashishkmr472.workers.dev';

// Sizes / samples / warmup runs are configurable via env so bench runs
// can be scoped down for quick directional checks (e.g.
// `CFP_BENCH_SIZES=4,128 CFP_BENCH_SAMPLES=3 CFP_BENCH_WARMUP=1`).
const SIZES = (process.env.CFP_BENCH_SIZES ?? '4,16,64,128,256,512')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((s) => Number.isFinite(s) && s > 0);
const SAMPLES = Number(process.env.CFP_BENCH_SAMPLES ?? 5);
const WARMUP_RUNS = Number(process.env.CFP_BENCH_WARMUP ?? 2);
const WORKLOAD_FILTER = (process.env.CFP_BENCH_WORKLOADS ?? '').trim();
const FETCH_TIMEOUT_MS = 180_000;

type Workload = 'mandelbrot' | 'montecarlo' | 'ga';

interface BaseResponse {
  ms: number;
  topology: string;
  treeDepth: number;
  fanOutPerLevel: number[];
  perTaskSampleMs?: number;
  perTileSampleMs?: number;
}

interface MandelbrotResponse extends BaseResponse {
  tiles: number;
}
interface MonteCarloResponse extends BaseResponse {
  tasks: number;
}
interface PowResponse extends BaseResponse {
  winner: { taskId: number; nonce: number; hashPrefix: string } | null;
  cancelledTasksApprox: number;
  totalNonceSpace: number;
}
interface GaResponse extends BaseResponse {
  population: number;
}

type WorkloadResponse =
  | MandelbrotResponse
  | MonteCarloResponse
  | PowResponse
  | GaResponse;

type WithRt<T> = T & { _clientRtMs: number };

async function fetchJson<T>(path: string, body: unknown): Promise<WithRt<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const t0 = Date.now();
    const r = await fetch(`${TARGET}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 160)}`);
    }
    const j = (await r.json()) as T;
    return { ...j, _clientRtMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

/** Pick whichever timing is non-zero. the runtime clamps small Date.now() diffs. */
function honestMs(serverMs: number, clientRtMs: number): number {
  return serverMs > 0 ? serverMs : clientRtMs;
}

interface WorkloadConfig {
  workload: Workload;
  /** Endpoint path on the test worker. */
  path: string;
  /** Build the parallel-mode body for size N. */
  parallelBody(n: number): Record<string, unknown>;
  /** Build the sequential-sample body. Uses the same task params as parallel
   * but with mode='sequential-sample' so the worker runs ONE task and
   * returns its measured time. */
  sequentialSampleBody(n: number): Record<string, unknown>;
  /** Workloads where one task ≠ 1/N of the work (e.g. PoW races) skip the
   * sequential-sample path; we report parallel only. */
  hasSequentialSample: boolean;
}

const WORKLOADS: WorkloadConfig[] = [
  {
    workload: 'mandelbrot',
    path: '/workload/mandelbrot',
    // The bench only needs timings; the iters array is opt-in via
    // `includeIters: true` (default `false`) and would otherwise hit
    // the 32 MiB RPC payload cap at N ≥ 256.
    parallelBody: (n) => ({ mode: 'parallel', tiles: n }),
    sequentialSampleBody: (n) => ({ mode: 'sequential-sample', tiles: n }),
    hasSequentialSample: true,
  },
  {
    workload: 'montecarlo',
    path: '/workload/montecarlo',
    parallelBody: (n) => ({ mode: 'parallel', tasks: n }),
    sequentialSampleBody: (n) => ({ mode: 'sequential-sample', tasks: n }),
    hasSequentialSample: true,
  },
  {
    workload: 'ga',
    path: '/workload/ga',
    parallelBody: (n) => ({ mode: 'parallel', population: n }),
    sequentialSampleBody: (n) => ({ mode: 'sequential-sample', population: n }),
    hasSequentialSample: true,
  },
  // PoW (winner-takes-all + cancel-on-first-success) is benched as a
  // demo-mode feature, not a speedup workload — comparing against
  // sequential is apples-to-oranges (sequential is a linear scan, parallel
  // is a parallel race). The demo surface drives `/workload/pow` directly.
];

interface Aggregate {
  workload: Workload;
  size: number;
  topology: string;
  treeDepth: number;
  fanOutPerLevel: number[];
  parallelColdMs: number;
  parallelWarmRuns: number[];
  parallelWarmMs: number;
  /** Median of ALL parallel samples (cold + warm) — for cross-checking. */
  parallelOverallMedianMs: number;
  /** Sequential per-task wall-clock × N (extrapolated). 0 when no sample. */
  sequentialExtrapolatedMs: number;
  /** Speedup against the WARM parallel run (steady-state). 0 when no sequential sample. */
  speedup: number;
  /** Speedup against the COLD parallel run — includes first-call dispatch cost. */
  speedupColdParallel: number;
  /** Per-task sequential wall-clock from the sample run. 0 when N/A. */
  perTaskSampleMs: number;
}

async function runOne(
  cfg: WorkloadConfig,
  size: number,
): Promise<Aggregate> {
  const path = cfg.path;
  const parallelBody = cfg.parallelBody(size);

  // Phase 1: warmup. Run BOTH parallel and (if applicable) sequential-sample
  // a few times, throwing the results away. This burns coordinator spin-up,
  // initial DO routing, and any first-call cold-start cost.
  for (let i = 0; i < WARMUP_RUNS; i++) {
    await fetchJson<WorkloadResponse>(path, parallelBody);
    if (cfg.hasSequentialSample) {
      await fetchJson<WorkloadResponse>(path, cfg.sequentialSampleBody(size));
    }
  }

  // Phase 2: measure. The first sample is the cold run; subsequent ones
  // are the warm runs. Both come from the same fully-warm worker and DO,
  // so cold is "first measured call" — not "isolate cold-start".
  const parSamples: number[] = [];
  let firstTopology = '';
  let firstTreeDepth = 1;
  let firstFanOutPerLevel: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = await fetchJson<WorkloadResponse>(path, parallelBody);
    parSamples.push(honestMs(r.ms, r._clientRtMs));
    if (i === 0) {
      firstTopology = r.topology;
      firstTreeDepth = r.treeDepth;
      firstFanOutPerLevel = r.fanOutPerLevel;
    }
  }
  const parallelColdMs = parSamples[0];
  const parallelWarmRuns = parSamples.slice(1);
  const parallelWarmMs = median(parallelWarmRuns);
  const parallelOverallMedianMs = median(parSamples);

  // Phase 3: sequential per-task sample (when applicable).
  let perTaskSampleMs = 0;
  let sequentialExtrapolatedMs = 0;
  let speedup = 0;
  let speedupColdParallel = 0;
  if (cfg.hasSequentialSample) {
    const seqSamples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const r = await fetchJson<MandelbrotResponse | MonteCarloResponse | GaResponse>(
        path,
        cfg.sequentialSampleBody(size),
      );
      // The worker reports `perTileSampleMs` (mandelbrot) or
      // `perTaskSampleMs` (montecarlo / ga). Take whichever is non-zero,
      // fall back to `ms`, then to client RT.
      const tileMs = (r as MandelbrotResponse).perTileSampleMs ?? 0;
      const taskMs = (r as MonteCarloResponse | GaResponse).perTaskSampleMs ?? 0;
      const sample = tileMs > 0 ? tileMs : taskMs > 0 ? taskMs : honestMs(r.ms, r._clientRtMs);
      seqSamples.push(sample);
    }
    perTaskSampleMs = median(seqSamples);
    sequentialExtrapolatedMs = perTaskSampleMs * size;
    speedup = parallelWarmMs > 0 ? +(sequentialExtrapolatedMs / parallelWarmMs).toFixed(2) : 0;
    speedupColdParallel = parallelColdMs > 0 ? +(sequentialExtrapolatedMs / parallelColdMs).toFixed(2) : 0;
  }

  return {
    workload: cfg.workload,
    size,
    topology: firstTopology,
    treeDepth: firstTreeDepth,
    fanOutPerLevel: firstFanOutPerLevel,
    parallelColdMs,
    parallelWarmRuns,
    parallelWarmMs,
    parallelOverallMedianMs,
    sequentialExtrapolatedMs,
    speedup,
    speedupColdParallel,
    perTaskSampleMs,
  };
}

async function main(): Promise<void> {
  console.log(`==> live edge bench against ${TARGET}`);
  console.log(`==> ${WORKLOADS.length} workloads × ${SIZES.length} sizes × ${SAMPLES} samples`);
  console.log(`==> warmup=${WARMUP_RUNS} runs/size, separate cold/warm reporting\n`);

  const aggregates: Aggregate[] = [];
  const filterSet = WORKLOAD_FILTER
    ? new Set(WORKLOAD_FILTER.split(',').map((s) => s.trim()))
    : null;
  for (const cfg of WORKLOADS) {
    if (filterSet && !filterSet.has(cfg.workload)) continue;
    console.log(`-- workload=${cfg.workload}`);
    for (const size of SIZES) {
      try {
        const agg = await runOne(cfg, size);
        aggregates.push(agg);
        const s = String(agg.size).padStart(3);
        const top = agg.topology.padEnd(8);
        const cold = String(agg.parallelColdMs).padStart(6);
        const warm = String(agg.parallelWarmMs).padStart(6);
        const seq = String(agg.sequentialExtrapolatedMs).padStart(7);
        const sp = String(agg.speedup).padStart(6);
        console.log(
          `   size=${s}  ${top}  depth=${agg.treeDepth}  cold=${cold}ms  warm=${warm}ms  seq≈${seq}ms  speedup=${sp}x`,
        );
      } catch (e) {
        console.error(`   size=${size} FAILED: ${(e as Error).message}`);
      }
    }
  }

  const out = {
    target: TARGET,
    ts: new Date().toISOString(),
    methodology: {
      warmupRuns: WARMUP_RUNS,
      samples: SAMPLES,
      coldDefinition:
        'first measured run after warmup — captures any per-call dispatch cost not amortized by warmup',
      warmDefinition:
        'median of remaining samples after the cold run — steady-state throughput',
      sequentialDefinition:
        'per-task wall-clock from a single inline run (sequential-sample mode), multiplied by N',
      timerNote:
        'The Workers runtime throttles Date.now() for timing-attack mitigation; sub-second wall-clock falls back to client RT',
    },
    sizes: SIZES,
    workloads: WORKLOADS.map((w) => w.workload),
    aggregates,
  };
  writeFileSync('bench-results-live.json', JSON.stringify(out, null, 2));
  console.log(`\n==> wrote bench-results-live.json with ${aggregates.length} aggregates`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
