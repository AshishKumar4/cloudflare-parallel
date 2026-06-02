/**
 * Transient-error matchers used by the Coordinator's leaf-DO retry
 * path. Extracted to a standalone module so unit tests don't have to
 * pull `cloudflare:workers` (which only exists at runtime in a Workers
 * isolate, not in the bun test process).
 *
 * The runtime occasionally resets a freshly-created leaf DO mid-startup
 * ("Internal error while starting up Durable Object storage caused
 * object to be reset.") under heavy concurrent fan-out. A single retry
 * on a fresh stub usually clears it. Match conservatively — only
 * clearly-transient platform errors retry, never user-thrown errors.
 */
import type { RunOneResult } from './protocol';

/**
 * Maximum retries on transient platform errors (DO reset, "Network
 * connection lost") across both the leaf-batch dispatch and the
 * sub-coord tree-dispatch paths.
 */
export const MAX_TRANSIENT_RETRIES = 4;

/**
 * Jittered backoff between transient-retry attempts.
 *
 *   attempt=0 -> 100..250 ms
 *   attempt=1 -> 250..400 ms
 *   attempt=2 -> 400..550 ms
 *   attempt=3 -> 550..700 ms
 *   attempt=4 -> 700..850 ms
 *
 * Spreads the retry burst across a few hundred ms so the runtime sees
 * a sustained ramp rather than a thundering herd.
 */
export function transientBackoff(attempt: number): Promise<void> {
  const base = 100 + attempt * 150;
  const jitter = Math.random() * 150;
  return new Promise((resolve) => setTimeout(resolve, base + jitter));
}

export const TRANSIENT_LEAF_RETRY_PATTERNS: ReadonlyArray<RegExp> = [
  /caused object to be reset/i,
  /durable object reset/i,
  /durable object storage/i,
  /network connection lost/i,
  /the script will never generate a response/i,
];

export function isTransientLeafError(err: unknown): boolean {
  const msg = errorMessage(err);
  if (msg === undefined) return false;
  return TRANSIENT_LEAF_RETRY_PATTERNS.some((rx) => rx.test(msg));
}

export function hasTransientRunFailure(results: readonly RunOneResult[]): boolean {
  return results.some((result) => !result.ok && isTransientLeafError(result.error));
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return undefined;
}
