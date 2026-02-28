/**
 * Code generation for dynamic worker modules.
 *
 * Generates ES module source strings that can be loaded by the
 * Worker Loader API. Each generated module exports a default class
 * extending `WorkerEntrypoint` with an `execute(...args)` RPC method
 * that runs the serialized user function.
 */

import type { WorkerCode } from './types.js';

/** Default compatibility date for generated workers. */
const DEFAULT_COMPAT_DATE = '2025-06-01';

/**
 * Generate the ES module source for a dynamic executor worker.
 *
 * The generated module looks like:
 *
 * ```js
 * import { WorkerEntrypoint } from "cloudflare:workers";
 *
 * const __fn__ = <serialized function source>;
 *
 * export default class extends WorkerEntrypoint {
 *   execute(...args) {
 *     return __fn__(...args);
 *   }
 * }
 * ```
 *
 * The function source is embedded directly as a JS expression, not
 * eval'd -- the Worker Loader loads it as a native ES module.
 *
 * @param fnSource - The serialized function source (from `fn.toString()`).
 *                   Must be a valid JS expression that produces a function.
 */
export function generateWorkerSource(fnSource: string): string {
  // The function source from fn.toString() produces either:
  //   - Arrow:     "(x) => x * x"  or  "async (x) => { ... }"
  //   - Function:  "function foo(x) { ... }"  or  "async function(x) { ... }"
  //
  // Both are valid as the RHS of `const __fn__ = <source>;`
  // Arrow functions are expressions. Named function declarations become
  // function expressions when used as an assignment RHS.
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    '',
    `const __fn__ = ${fnSource};`,
    '',
    'export default class extends WorkerEntrypoint {',
    '  execute(...args) {',
    '    const result = __fn__(...args);',
    '    // Transparently await async/promise-returning functions.',
    '    if (result instanceof Promise) {',
    '      return result;',
    '    }',
    '    return result;',
    '  }',
    '}',
  ].join('\n');
}

/**
 * Options for building a `WorkerCode` descriptor.
 */
export interface WorkerCodeOptions {
  /** Compatibility date. Defaults to `2025-06-01`. */
  compatibilityDate?: string;
  /** Additional compatibility flags. */
  compatibilityFlags?: string[];
  /** Environment bindings for the dynamic worker. */
  env?: Record<string, unknown>;
  /**
   * Network access control.
   * - `null` (default): block all outbound network access.
   * - `undefined`: inherit parent's network access.
   * - A service stub: redirect outbound through that binding.
   */
  globalOutbound?: WorkerCode['globalOutbound'];
}

/**
 * Build a complete `WorkerCode` descriptor for the Worker Loader.
 *
 * @param fnSource - Serialized function source string.
 * @param opts - Optional configuration for the dynamic worker.
 * @returns A `WorkerCode` ready to pass to `loader.get()`.
 */
export function buildWorkerCode(
  fnSource: string,
  opts?: WorkerCodeOptions,
): WorkerCode {
  const moduleSource = generateWorkerSource(fnSource);

  return {
    compatibilityDate: opts?.compatibilityDate ?? DEFAULT_COMPAT_DATE,
    compatibilityFlags: opts?.compatibilityFlags,
    mainModule: 'worker.js',
    modules: {
      'worker.js': moduleSource,
    },
    env: opts?.env,
    // Default: sandboxed (no network access).
    globalOutbound: opts?.globalOutbound === undefined ? null : opts.globalOutbound,
  };
}
