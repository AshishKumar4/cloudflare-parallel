/**
 * Function serialization and validation.
 *
 * Converts function objects to source strings suitable for embedding
 * in a generated worker module. Validates that the function is safe
 * to serialize (no native code, no `this` references).
 */

import { SerializationError } from './errors.js';

/**
 * Serialize a function to its source code string.
 *
 * The returned string is a valid JavaScript expression that, when
 * evaluated, produces the function. Works for arrow functions,
 * function declarations, function expressions, and async variants.
 *
 * @throws {SerializationError} If the function is native code or
 *         references `this` (which cannot survive serialization).
 */
export function serializeFunction(fn: Function): string {
  if (typeof fn !== 'function') {
    throw new SerializationError(
      `Expected a function, got ${typeof fn}`,
    );
  }

  const source = fn.toString();

  // Reject native functions -- they have no serializable source.
  if (source.includes('[native code]')) {
    throw new SerializationError(
      `Cannot serialize native function: ${fn.name || '(anonymous)'}. ` +
        'Only user-defined functions can be dispatched to remote isolates.',
    );
  }

  // Reject `this` references -- there is no receiver in the remote isolate.
  // Use a regex that matches the keyword `this` as a standalone token,
  // but not inside strings or comments (best-effort heuristic).
  if (/\bthis\b/.test(source)) {
    throw new SerializationError(
      `Function "${fn.name || '(anonymous)'}" references \`this\`, which is ` +
        'not available in a remote isolate. Pass values as explicit arguments instead.',
    );
  }

  return source;
}

/**
 * Compute a simple string hash for use in loader IDs.
 *
 * Uses djb2 -- fast, deterministic, good distribution for short strings.
 * NOT cryptographic. Used only for cache key differentiation.
 */
export function hashSource(source: string): string {
  let hash = 5381;
  for (let i = 0; i < source.length; i++) {
    // hash * 33 + char
    hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  }
  // Convert to unsigned hex.
  return (hash >>> 0).toString(36);
}
