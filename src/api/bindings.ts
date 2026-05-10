/**
 * `pickBindings(env, keys)` — capability-narrow an `env` object to a
 * named subset.
 *
 * Useful when you have a heterogeneous Worker `env` and want to pass
 * only specific keys to a Pool's `bindings:` (avoiding accidental
 * exposure of unrelated bindings to loaded isolates).
 *
 * @example
 * import { Parallel, pickBindings } from 'cloudflare-parallel';
 *
 * const pool = Parallel.pool(env, {
 *   bindings: pickBindings(env, ['AI', 'KV', 'R2']),
 * });
 *
 * Type-safe: TS infers the picked-key shape, so loaded isolates see
 * `{ AI: Ai; KV: KVNamespace; R2: R2Bucket }` exactly.
 *
 * Library-internal `Cfp*` bindings are still hard-blocklisted at the
 * dispatch layer regardless of what `pickBindings` returns — this
 * helper is a convenience, not a security boundary.
 */
export function pickBindings<E, K extends keyof E & string>(
  env: E,
  keys: ReadonlyArray<K>,
): Pick<E, K> {
  if (!env || typeof env !== 'object') return {} as Pick<E, K>;
  const src = env as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in src) out[key] = src[key];
  return out as Pick<E, K>;
}
