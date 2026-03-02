/**
 * Code generation for dynamic worker modules.
 *
 * Generates ES module source strings that can be loaded by the
 * Worker Loader API. Each generated module exports a default class
 * extending `WorkerEntrypoint` with an `execute(...args)` RPC method
 * that runs the serialized user function.
 *
 * Supports two optional enhancements:
 * - **Context injection**: Module-level `const` declarations for captured
 *   closure variables, so the function body can reference them naturally.
 * - **Binding passthrough**: Appends `this.env` as the last argument to the
 *   user function, giving it access to forwarded KV/R2/AI/etc. bindings.
 */

import type { WorkerCode } from './types.js';

/** Default compatibility date for generated workers. */
const DEFAULT_COMPAT_DATE = '2025-06-01';

/**
 * Options that control what gets embedded in the generated module source.
 */
export interface GenerateSourceOptions {
  /**
   * Key/value pairs to inject as module-level constants.
   * Each entry becomes `const <key> = <JSON.stringify(value)>;` before
   * the function declaration, so the function body can reference them
   * as if they were in closure scope.
   *
   * Values must be JSON-serializable.
   */
  context?: Record<string, unknown>;

  /**
   * When `true`, the generated `execute()` method appends `this.env`
   * as the last argument to the user function. This is enabled
   * automatically when the pool is configured with `bindings`.
   */
  passEnv?: boolean;
}

/**
 * Generate the ES module source for a dynamic executor worker.
 *
 * The generated module looks like:
 *
 * ```js
 * import { WorkerEntrypoint } from "cloudflare:workers";
 *
 * // (optional) context constants
 * const multiplier = 3;
 *
 * const __fn__ = <serialized function source>;
 *
 * export default class extends WorkerEntrypoint {
 *   execute(...args) {
 *     return __fn__(...args);             // without env
 *     return __fn__(...args, this.env);   // with env passthrough
 *   }
 * }
 * ```
 *
 * @param fnSource - The serialized function source (from `fn.toString()`).
 *                   Must be a valid JS expression that produces a function.
 * @param opts     - Optional context injection and env passthrough settings.
 */
export function generateWorkerSource(
  fnSource: string,
  opts?: GenerateSourceOptions,
): string {
  const lines: string[] = [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    '',
  ];

  // ── Context injection ───────────────────────────────────────────
  // Emit module-level constants so the function body can reference
  // captured variables naturally (e.g. `multiplier` instead of `ctx.multiplier`).
  if (opts?.context) {
    for (const [key, value] of Object.entries(opts.context)) {
      lines.push(`const ${key} = ${JSON.stringify(value)};`);
    }
    lines.push('');
  }

  // ── Function declaration ────────────────────────────────────────
  lines.push(`const __fn__ = ${fnSource};`);
  lines.push('');

  // ── Entrypoint class ────────────────────────────────────────────
  // When passEnv is true, append `this.env` so the user function
  // receives the forwarded bindings as its last argument.
  const callExpr = opts?.passEnv
    ? '__fn__(...args, this.env)'
    : '__fn__(...args)';

  lines.push(
    'export default class extends WorkerEntrypoint {',
    '  execute(...args) {',
    `    const result = ${callExpr};`,
    '    // Transparently await async/promise-returning functions.',
    '    if (result instanceof Promise) {',
    '      return result;',
    '    }',
    '    return result;',
    '  }',
    '}',
  );

  return lines.join('\n');
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
 * @param fnSource    - Serialized function source string.
 * @param opts        - Optional configuration for the dynamic worker.
 * @param sourceOpts  - Optional context/env passthrough for source generation.
 * @returns A `WorkerCode` ready to pass to `loader.get()`.
 */
export function buildWorkerCode(
  fnSource: string,
  opts?: WorkerCodeOptions,
  sourceOpts?: GenerateSourceOptions,
): WorkerCode {
  const moduleSource = generateWorkerSource(fnSource, sourceOpts);

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
