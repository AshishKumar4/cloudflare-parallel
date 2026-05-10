import { hashSource } from './serialize.js';

export type CacheKeyStrategy = 'stable' | 'fresh' | 'auto';

const PREFIX = 'cfp';
/** 60-second window for `'auto'` strategy — balances reuse against state-leak risk. */
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
 * - `'stable'`: `cfp:<hash>` — same isolate forever for this fn shape.
 * - `'fresh'` or `forceFresh`: `cfp:<hash>:<counter>` — fresh isolate every call.
 * - `'auto'` (default): `cfp:<hash>:<windowEpochSec>` — fresh isolate per 60s window.
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
