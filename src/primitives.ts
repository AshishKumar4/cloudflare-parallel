/**
 * Purity primitives for function validation and annotation.
 */

import { SerializationError } from './errors.js';

// ── Pure ────────────────────────────────────────────────────────────

/** Branded type marking a function as verified-pure. */
export type Pure<F> = F & { readonly __pure: true };

/**
 * Validate and brand a function as pure.
 *
 * Checks:
 *  - Must be a function.
 *  - Source must not contain `[native code]`.
 *  - Source must not reference `this` (cannot survive serialization).
 *
 * The returned value is the same function reference with a `__pure`
 * brand attached. Use `isPure()` to check the brand at runtime.
 *
 * @throws {SerializationError} If the function fails validation.
 */
export function pure<F extends Function>(fn: F): Pure<F> {
  if (typeof fn !== 'function') {
    throw new SerializationError(
      `pure() expected a function, got ${typeof fn}`,
    );
  }

  const source = fn.toString();

  if (source.includes('[native code]')) {
    throw new SerializationError(
      `pure(): cannot brand native function "${fn.name || '(anonymous)'}"`,
    );
  }

  if (/\bthis\b/.test(source)) {
    throw new SerializationError(
      `pure(): function "${fn.name || '(anonymous)'}" references \`this\`, ` +
        'which is not available in a remote isolate. Remove `this` usage or ' +
        'pass the value as an explicit argument.',
    );
  }

  const branded = fn as Pure<F>;
  Object.defineProperty(branded, '__pure', {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return branded;
}

/**
 * Check if a function has been branded as pure via `pure()`.
 */
export function isPure(fn: Function): fn is Pure<typeof fn> {
  return (fn as any).__pure === true;
}

// ── Constant ────────────────────────────────────────────────────────

/**
 * Identity function that signals a value is intended as a serializable
 * constant for remote execution.
 *
 * At runtime this is a no-op -- it returns the value unchanged.
 * Its purpose is documentation and intent signaling: values marked
 * with `constant()` are meant to be passed as explicit arguments
 * rather than captured via closure.
 *
 * ```ts
 * const threshold = constant(0.5);
 * pool.submit((x: number, t: number) => x > t ? 1 : 0, value, threshold);
 * ```
 */
export function constant<T>(value: T): T {
  return value;
}
