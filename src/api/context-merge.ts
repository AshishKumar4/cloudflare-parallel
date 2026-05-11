/**
 * Merge per-call context with the pool-level default context.
 *
 * Shared by `Pool.#mergeContext` and `LoaderOnlyPoolImpl.#mergeContext`
 * which previously declared identical helpers — see § 18 in
 * `/workspace/quality-audit-findings.md`.
 *
 * Returns `undefined` when neither side has any keys to merge so the
 * caller can skip the wire-level `context` field entirely.
 */
export function mergeContext(
  poolContext: Record<string, unknown> | undefined,
  perCallContext: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!poolContext && !perCallContext) return undefined;
  if (!poolContext) return perCallContext;
  if (!perCallContext) return poolContext;
  return { ...poolContext, ...perCallContext };
}
