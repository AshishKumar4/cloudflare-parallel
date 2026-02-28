/**
 * cloudflare-parallel — Public API
 *
 * Parallel computing primitives for Cloudflare Workers using the
 * Worker Loader API for real isolate-per-task execution.
 *
 * ## Quick start
 *
 * ```toml
 * # wrangler.toml
 * [[worker_loaders]]
 * binding = "LOADER"
 * ```
 *
 * ```ts
 * import { Parallel } from 'cloudflare-parallel';
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const pool = Parallel.pool(env.LOADER);
 *     const squares = await pool.map((n: number) => n * n, [1, 2, 3, 4]);
 *     return Response.json(squares);
 *   },
 * };
 * ```
 */

// ── Core ────────────────────────────────────────────────────────────

export { WorkerPool } from './pool.js';
export type { PoolOptions, MapOptions, PmapOptions } from './pool.js';

// ── Primitives ──────────────────────────────────────────────────────

export { pure, isPure, constant } from './primitives.js';
export type { Pure } from './primitives.js';

// ── Serialization ───────────────────────────────────────────────────

export { serializeFunction, hashSource } from './serialize.js';

// ── Code generation ─────────────────────────────────────────────────

export { generateWorkerSource, buildWorkerCode } from './codegen.js';
export type { WorkerCodeOptions } from './codegen.js';

// ── Errors ──────────────────────────────────────────────────────────

export {
  ParallelError,
  SerializationError,
  ExecutionError,
  TimeoutError,
  BindingError,
} from './errors.js';

// ── Types (Worker Loader API, beta) ─────────────────────────────────

export type {
  WorkerLoader,
  WorkerCode,
  WorkerStub,
  EntrypointStub,
  EntrypointOptions,
  GetCodeCallback,
  ServiceStub,
  ModuleContent,
} from './types.js';

// ── Convenience factory ─────────────────────────────────────────────

import { WorkerPool } from './pool.js';
import type { PoolOptions } from './pool.js';
import type { WorkerLoader } from './types.js';

/**
 * Convenience entry point.
 *
 * ```ts
 * import { Parallel } from 'cloudflare-parallel';
 * const pool = Parallel.pool(env.LOADER);
 * ```
 */
export const Parallel = {
  /**
   * Create a WorkerPool from a Worker Loader binding.
   *
   * @param loader - The `env.LOADER` binding from `[[worker_loaders]]`.
   * @param opts   - Optional pool configuration.
   */
  pool(loader: WorkerLoader, opts?: PoolOptions): WorkerPool {
    return new WorkerPool(loader, opts);
  },
} as const;
