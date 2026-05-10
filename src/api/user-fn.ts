/**
 * Internal alias for "any user-supplied function we plan to serialize and
 * dispatch into a loaded isolate." Replaces the bare `Function` type used in
 * v0.2's internals — `Function` is a typed alias for the wide JS function
 * type, which lints as unsafe and forces `as unknown as Function` casts at
 * every public-API call site.
 *
 * `UserFn` is structurally identical to "a function from any tuple of args
 * to any value (sync or async)" but typed in a way that variadic call sites
 * can target without inline casts.
 *
 * Public typed signatures (Pool.submit, ActorHandle.submit, etc.) keep their
 * sharply-typed shapes; this alias is only used at the internal boundary
 * where we serialize via `fn.toString()`.
 */
export type UserFn<R = unknown> = (...args: never[]) => R;

/**
 * The internal-dispatch type for invoking a `UserFn` with arbitrary args.
 * Keeps `UserFn` strict at the public type-position (so generic inference
 * works in `pool.submit<A,R>(fn, ...args)`), while allowing the runtime
 * dispatch site to pass `unknown[]` without an explicit cast.
 */
export type DispatchableFn = (...args: unknown[]) => unknown;
