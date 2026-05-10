import { BindingError } from '../errors/index';

/**
 * Library-internal DO binding names exposed for tests and tooling. The
 * runtime check uses {@link isLibraryInternalKey} (a prefix predicate)
 * so future internal DOs are blocked automatically without updating
 * this set.
 */
export const LIBRARY_INTERNAL_BINDINGS = new Set<string>([
  'CfpCoordinator',
  'CfpWorkerDO',
  'CfpSubCoord',
  'CfpSchedulerDO',
]);

/**
 * Bindings that the Workers runtime cannot structured-clone across the Worker
 * Loader boundary. Forwarding them throws
 * `Could not serialize object of type "X"` at dispatch.
 *
 * `LOADER` is the Worker Loader binding itself — re-entry would create
 * an infinite recursion path anyway. User-Worker code that wants to
 * spawn nested loaders must construct a fresh Pool inside the loaded
 * isolate via the explicit DO routing, not by capturing LOADER.
 */
export const NON_CLONEABLE_BINDINGS = new Set<string>(['LOADER']);

/**
 * Reserved-prefix predicate for library-internal binding keys.
 *
 * Matches:
 * - `^Cfp[A-Z]` — public DO classes (e.g. `CfpCoordinator`, `CfpWorkerDO`).
 *   Adding a new internal DO named `CfpFooDO` is automatically blocked.
 * - `^cfp` (lowercase) — library-internal capability proxies like
 *   `cfpSql` (Actor SQL proxy) and any future lowercase markers.
 *
 * This is the single source of truth — never forward keys matching
 * either pattern, regardless of any user `allowBindings`.
 */
export function isLibraryInternalKey(key: string): boolean {
  return /^Cfp[A-Z]/.test(key) || /^cfp/.test(key);
}

/**
 * True when the binding is library-internal OR runtime-non-cloneable.
 * Used by `sanitizeBindings` to filter env entries before crossing
 * the Worker Loader boundary.
 */
export function isUnforwardableBindingKey(key: string): boolean {
  return isLibraryInternalKey(key) || NON_CLONEABLE_BINDINGS.has(key);
}

/**
 * Filter user-supplied bindings down to the safe subset that may cross the
 * loader boundary into a dynamic worker's `env`.
 *
 * Removes:
 *   - any library-internal `Cfp*` DO bindings (prefix-checked, so future
 *     additions are auto-blocked)
 *   - keys not in `allowList` (when the caller passes one)
 *   - the library-internal `cfpSql` / `cfp*` capability proxies (caught by
 *     the same prefix check)
 */
export function sanitizeBindings(
  bindings: Record<string, unknown> | undefined,
  allowList?: ReadonlyArray<string>,
): Record<string, unknown> {
  if (!bindings) return {};
  const out: Record<string, unknown> = {};
  const allow = allowList ? new Set(allowList) : null;
  for (const [key, value] of Object.entries(bindings)) {
    if (isUnforwardableBindingKey(key)) continue;
    if (allow && !allow.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Submit-time guard. Trips when the user explicitly passes one of the
 * library-internal DO bindings — surfaces a clear error rather than
 * silently dropping it.
 */
export function assertNoLibraryInternalBindings(
  bindings: Record<string, unknown> | undefined,
): void {
  if (!bindings) return;
  for (const key of Object.keys(bindings)) {
    if (isLibraryInternalKey(key)) {
      throw new BindingError(
        `Binding '${key}' is library-internal and cannot be forwarded to ` +
          'a dynamic worker. Remove it from `bindings:`.',
      );
    }
  }
}
