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
}

/**
 * Compute the loader id for a submission.
 *
 * - `'stable'` (default across all factories): `cfp:<hash>` — same
 *   isolate forever for this fn shape. Best warmth, no eviction storms.
 *   Module-level state in the loaded isolate persists between calls;
 *   user fns must not rely on per-call freshness (they shouldn't anyway —
 *   the Workers runtime reuses isolates across requests in steady state).
 * - `'fresh'` or `forceFresh`: `cfp:<hash>:<counter>` — fresh isolate
 *   every call. Use only when you genuinely need a clean V8 heap per
 *   submission (testing, sandboxing distrusted code per-call). Pays full
 *   isolate-load cost on every call.
 * - `'auto'` (opt-in): `cfp:<hash>:<windowEpochSec>` — fresh isolate per
 *   60s window. Use only when (a) you have a small fixed set of fn
 *   shapes, AND (b) you actively want periodic isolate refresh. With
 *   high fn-shape diversity this thrashes the per-owner LRU.
 */
export function buildCacheKey(input: CacheKeyInput): string {
  const combined = hashSource(input.fnSource + ':' + input.contextHash);

  if (input.forceFresh || input.strategy === 'fresh') {
    return `${PREFIX}:${combined}:${__counter++}`;
  }
  if (input.strategy === 'auto') {
    const window = Math.floor(Date.now() / AUTO_WINDOW_MS);
    return `${PREFIX}:${combined}:w${window}`;
  }
  return `${PREFIX}:${combined}`;
}

/** For tests / observability: surface the embedded fn-shape hash. */
export function extractFnShapeHash(cacheKey: string): string | null {
  const parts = cacheKey.split(':');
  return parts[1] ?? null;
}
