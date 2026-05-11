import { hashSource } from './serialize';

export type CacheKeyStrategy = 'stable' | 'fresh' | 'auto';

const PREFIX = 'cfp';
/**
 * 60-second window for the opt-in `'auto'` strategy.
 *
 * `'auto'` is intentionally NOT the default — it splits each fn shape
 * across 60s buckets, and with a per-owner LRU bounded to ~50 entries any
 * deployment that rotates more than 50 distinct fn-shape buckets per
 * hour will evict hot loaders, causing cold-start storms and tail-latency
 * spikes. The default is `'stable'` (one isolate per fn shape, period);
 * users who actively want freshness windows opt into `'auto'`.
 */
const AUTO_WINDOW_MS = 60_000;

let __counter = 0;

export interface CacheKeyInput {
  fnSource: string;
  contextHash: string;
  strategy: CacheKeyStrategy;
  /** Per-submission override: force a fresh isolate. */
  forceFresh?: boolean;
  /**
   * Task slot index within a single fan-out (0..N-1). When present,
   * appends `:slot-<taskSlot>` to differentiate concurrent isolates
   * within ONE fan-out while preserving warm reuse across calls.
   *
   * **Why this exists.** Without `taskSlot`, every task in a single
   * `pool.map([a,b,c,d], fn)` call hashes the SAME `fnSource +
   * contextHash`, produces the SAME cache key, and the Worker Loader's
   * by-key caching returns the SAME loaded isolate. All N concurrent
   * `loader.get(sameKey)` calls collide on one V8 context and tasks
   * serialize on that single thread — no parallel CPU.
   *
   * With `taskSlot`, a fan-out at N=4 produces four keys:
   * `cfp:<hash>:slot-0` … `cfp:<hash>:slot-3` — four distinct isolates,
   * each on its own thread, running concurrently. A subsequent
   * `pool.map([...4 more items], fn)` hits the same four keys → warm
   * reuse, fast AND parallel.
   *
   * Empirical validation (`/workspace/local/poc-multi-backend-findings.md`):
   * the POC measured 4.03× speedup at N=4 in the in-DO topology using
   * exactly this pattern. Without it the speedup collapses to ~1×.
   *
   * Single-shot `submit` calls use `taskSlot: 0` so they share the
   * same isolate as `slot-0` in a future `map` — compatible reuse.
   */
  taskSlot?: number;
}

/**
 * Compute the loader id for a submission.
 *
 * - `'stable'` (default across all factories): `cfp:<hash>[:slot-<i>]`
 *   — same isolate forever for this fn shape and slot. Best warmth, no
 *   eviction storms. Module-level state in the loaded isolate persists
 *   between calls; user fns must not rely on per-call freshness (they
 *   shouldn't anyway — the Workers runtime reuses isolates across
 *   requests in steady state).
 * - `'fresh'` or `forceFresh`: `cfp:<hash>:<counter>` — fresh isolate
 *   every call. Use only when you genuinely need a clean V8 heap per
 *   submission (testing, sandboxing distrusted code per-call). Pays full
 *   isolate-load cost on every call. `taskSlot` is ignored under
 *   `'fresh'` — the unique counter already differentiates every call.
 * - `'auto'` (opt-in): `cfp:<hash>:w<window>[:slot-<i>]` — fresh isolate
 *   per 60s window per slot. Use only when (a) you have a small fixed
 *   set of fn shapes, AND (b) you actively want periodic isolate
 *   refresh. With high fn-shape diversity this thrashes the per-owner
 *   LRU.
 *
 * The `taskSlot` suffix is appended to BOTH `stable` and `auto` keys
 * when present; only `fresh` skips it (the counter already provides
 * uniqueness).
 */
export function buildCacheKey(input: CacheKeyInput): string {
  const combined = hashSource(input.fnSource + ':' + input.contextHash);

  if (input.forceFresh || input.strategy === 'fresh') {
    return `${PREFIX}:${combined}:${__counter++}`;
  }
  const slotSuffix =
    input.taskSlot !== undefined && Number.isFinite(input.taskSlot)
      ? `:slot-${input.taskSlot}`
      : '';
  if (input.strategy === 'auto') {
    const window = Math.floor(Date.now() / AUTO_WINDOW_MS);
    return `${PREFIX}:${combined}:w${window}${slotSuffix}`;
  }
  return `${PREFIX}:${combined}${slotSuffix}`;
}

/** For tests / observability: surface the embedded fn-shape hash. */
export function extractFnShapeHash(cacheKey: string): string | null {
  const parts = cacheKey.split(':');
  return parts[1] ?? null;
}
