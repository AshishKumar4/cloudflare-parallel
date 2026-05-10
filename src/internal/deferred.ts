/**
 * Tiny `Deferred<T>` — a `Promise<T>` whose `resolve`/`reject` are exposed.
 *
 * Use cases inside the library:
 * - per-slot completion signals in `pool.mapOrdered` (replaces 1ms
 *   `setTimeout` busy-wait).
 * - drain barrier in `pool.drain` (replaces 5ms `setTimeout` busy-wait).
 *
 * `Promise.withResolvers()` would be ideal but is gated on TS lib level
 * upgrades; keep this until the codebase moves the lib target up.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
