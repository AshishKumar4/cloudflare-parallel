/**
 * TypeScript types for the Cloudflare Worker Loader API (closed beta).
 *
 * These types are NOT yet included in @cloudflare/workers-types.
 * They are derived from the official documentation at:
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
 *
 * When the API reaches GA and types ship in @cloudflare/workers-types,
 * this file can be removed and imports updated.
 */

// ── Module content types ────────────────────────────────────────────

/** ES module source. */
export interface JsModule {
  js: string;
}

/** CommonJS module source. */
export interface CjsModule {
  cjs: string;
}

/** Python module source. */
export interface PyModule {
  py: string;
}

/** Importable string value. */
export interface TextModule {
  text: string;
}

/** Importable ArrayBuffer value. */
export interface DataModule {
  data: ArrayBuffer;
}

/** Importable JSON object. */
export interface JsonModule {
  json: unknown;
}

/**
 * A module's content, either as a plain string (type inferred from file
 * extension: `.js` or `.py`) or as a typed object.
 */
export type ModuleContent =
  | string
  | JsModule
  | CjsModule
  | PyModule
  | TextModule
  | DataModule
  | JsonModule;

// ── WorkerCode ──────────────────────────────────────────────────────

/**
 * Describes a dynamically-loaded Worker. Returned by the callback
 * passed to `WorkerLoader.get()`.
 */
export interface WorkerCode {
  /** Compatibility date for the Worker (e.g. "2025-06-01"). */
  compatibilityDate: string;

  /** Optional compatibility flags (e.g. ["nodejs_compat"]). */
  compatibilityFlags?: string[];

  /**
   * Allow experimental compatibility flags. Requires the parent Worker
   * to have the "experimental" flag set.
   */
  allowExperimental?: boolean;

  /** Name of the main module. Must be a key in `modules`. */
  mainModule: string;

  /** Map of module names to their source content. */
  modules: Record<string, ModuleContent>;

  /**
   * Environment object provided to the dynamic Worker as `env`.
   * May contain structured-clonable values and service bindings.
   */
  env?: Record<string, unknown>;

  /**
   * Controls network access for the dynamic Worker.
   * - `undefined`: inherit parent's network access (full internet).
   * - `null`: block all network access (`fetch()` / `connect()` throw).
   * - A service stub: redirect all outbound through that binding.
   */
  globalOutbound?: ServiceStub | null;

  /**
   * Tail Workers to observe the dynamic Worker's execution.
   */
  tails?: ServiceStub[];
}

// ── Service stub (minimal, for globalOutbound / env values) ─────────

/**
 * Opaque handle to a service binding or entrypoint stub.
 * In practice this comes from `ctx.exports.SomeClass(...)` or
 * from service bindings in `env`. We only need the shape for typing
 * the WorkerCode fields.
 */
export interface ServiceStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  // RPC methods are dynamically typed -- callers use `as any`.
}

// ── WorkerStub ──────────────────────────────────────────────────────

/** Options for `WorkerStub.getEntrypoint()`. */
export interface EntrypointOptions {
  props?: Record<string, unknown>;
}

/**
 * A stub representing a dynamically-loaded Worker.
 * Returned synchronously by `WorkerLoader.get()`. Requests made
 * to the stub wait for the Worker to finish loading.
 */
export interface WorkerStub {
  /**
   * Get the default entrypoint (the Worker's default export).
   * Returns a proxy supporting `fetch()` and any RPC methods
   * defined on the Worker's `WorkerEntrypoint` class.
   */
  getEntrypoint(): EntrypointStub;

  /**
   * Get a named entrypoint (a named `WorkerEntrypoint` export).
   */
  getEntrypoint(name: string, opts?: EntrypointOptions): EntrypointStub;
}

/**
 * A proxy to a dynamic Worker's entrypoint. Supports `fetch()` and
 * arbitrary RPC method calls.
 *
 * We only type the methods cloudflare-parallel actually uses. For
 * arbitrary RPC calls, callers should cast to their own interface.
 */
export interface EntrypointStub {
  /** Send an HTTP request to the entrypoint's fetch() handler. */
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;

  /**
   * RPC call to the `execute` method on the dynamic Worker's entrypoint.
   * This is the method our generated workers expose.
   */
  execute(...args: unknown[]): Promise<unknown>;
}

// ── WorkerLoader ────────────────────────────────────────────────────

/** Callback that provides the Worker's code when the loader needs it. */
export type GetCodeCallback = () => Promise<WorkerCode>;

/**
 * The Worker Loader binding. Added to a Worker's `env` via:
 *
 * ```toml
 * [[worker_loaders]]
 * binding = "LOADER"
 * ```
 *
 * Has a single method: `get()`.
 */
export interface WorkerLoader {
  /**
   * Load a Worker by ID. If a warm isolate with this ID exists, it may
   * be reused. Otherwise `getCodeCallback` is invoked to fetch the code.
   *
   * Returns a `WorkerStub` synchronously -- requests to it will wait
   * for the Worker to load if needed.
   *
   * @param id - Unique identifier for caching. Same ID + same code = may reuse isolate.
   *             Different ID = always fresh isolate.
   * @param getCodeCallback - Async function returning a `WorkerCode` object.
   *                          Must always return the same content for the same ID.
   */
  get(id: string, getCodeCallback: GetCodeCallback): WorkerStub;
}
