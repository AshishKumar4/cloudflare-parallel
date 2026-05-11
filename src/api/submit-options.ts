import type { SubmitOptions } from './options';

/**
 * Submit-time helpers shared by `Pool`, `LoaderOnlyPool`,
 * `ActorHandle`, and the in-process fakes.
 *
 * Each `submit(fn, ...args)` overload accepts the user-fn's positional
 * args optionally followed by a `SubmitOptions` bag. The bag is
 * detected structurally (by key set) so users don't need to wrap their
 * options. The detection lives here to keep the rule in one place.
 */

/**
 * Keys recognized as belonging to {@link SubmitOptions}. Updated in
 * lockstep with `options.ts:SubmitOptions`.
 */
export const SUBMIT_OPTION_KEYS: ReadonlySet<string> = new Set([
  'timeout',
  'retries',
  'retryDelay',
  'context',
  'cancel',
  'deadline',
  'deadlineMs',
  'freshIsolate',
  'meta',
]);

/**
 * Structural shape-check for a {@link SubmitOptions} bag. Plain
 * objects whose every key is in {@link SUBMIT_OPTION_KEYS} are
 * treated as the options bag; everything else is a user arg.
 */
export function isSubmitOptionsBag(value: unknown): value is SubmitOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  return keys.every((k) => SUBMIT_OPTION_KEYS.has(k));
}

/**
 * Split a variadic submit-args tuple into `(args, opts)`. The bag is
 * the last element when {@link isSubmitOptionsBag} matches; otherwise
 * the entire tuple is `args`.
 */
export function splitSubmitOptions<A extends unknown[]>(
  rest: A,
): { args: unknown[]; opts: SubmitOptions | undefined } {
  if (rest.length === 0) return { args: [], opts: undefined };
  const last = rest[rest.length - 1];
  if (isSubmitOptionsBag(last)) {
    return { args: rest.slice(0, -1) as unknown[], opts: last as SubmitOptions };
  }
  return { args: rest as unknown[], opts: undefined };
}
