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

export const TRANSIENT_LEAF_RETRY_PATTERNS: ReadonlyArray<RegExp> = [
  /caused object to be reset/i,
  /durable object storage/i,
  /network connection lost/i,
  /the script will never generate a response/i,
];

export function isTransientLeafError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    if (typeof err === 'string') {
      return TRANSIENT_LEAF_RETRY_PATTERNS.some((rx) => rx.test(err));
    }
    return false;
  }
  const msg = err.message;
  return TRANSIENT_LEAF_RETRY_PATTERNS.some((rx) => rx.test(msg));
}
