import { SerializationError } from '../errors/index';
import type { UserFn } from './user-fn';

/**
 * Brand for "purity-validated" functions. Branding a function only checks
 * the library's serializability invariants (no `[native code]`, no `this`); it does not
 * (and cannot) prove referential transparency.
 */
export type Pure<F> = F & { readonly __pure: true };

export function pure<F extends UserFn>(fn: F): Pure<F> {
  if (typeof fn !== 'function') {
    throw new SerializationError(`pure() expected a function, got ${typeof fn}`);
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
        'which is not available in a remote isolate.',
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

export function isPure<F extends UserFn>(fn: F): fn is Pure<F> {
  return (fn as { __pure?: boolean }).__pure === true;
}

/** Identity wrapper — documents intent that `value` is a serializable constant. */
export function constant<T>(value: T): T {
  return value;
}
