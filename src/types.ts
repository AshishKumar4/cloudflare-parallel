/**
 * Worker Loader API types (closed/open beta — not yet in @cloudflare/workers-types).
 * Mirrors the v0.2 shape; remove when @cloudflare/workers-types ships them.
 * https://developers.cloudflare.com/dynamic-workers/api-reference/
 */

export interface JsModule {
  js: string;
}
export interface CjsModule {
  cjs: string;
}
export interface PyModule {
  py: string;
}
export interface TextModule {
  text: string;
}
export interface DataModule {
  data: ArrayBuffer;
}
export interface JsonModule {
  json: unknown;
}

export type ModuleContent =
  | string
  | JsModule
  | CjsModule
  | PyModule
  | TextModule
  | DataModule
  | JsonModule;

export interface WorkerCodeLimits {
  cpuMs?: number;
  subRequests?: number;
}

export interface ServiceStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  allowExperimental?: boolean;
  mainModule: string;
  modules: Record<string, ModuleContent>;
  env?: Record<string, unknown>;
  /**
   * Network access control:
   * - `undefined`: inherit parent's network access.
   * - `null`: block all outbound (fetch/connect throw).
   * - A service stub: redirect outbound through that binding.
   */
  globalOutbound?: ServiceStub | null;
  tails?: ServiceStub[];
  limits?: WorkerCodeLimits;
}

export interface EntrypointOptions {
  props?: Record<string, unknown>;
}

export interface EntrypointStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  // RPC dispatch — the target is `cloudflare:workers` WorkerEntrypoint.
  // Generated user modules expose `execute(envelope, ...args)`.
  execute(...args: unknown[]): Promise<unknown>;
  // Streaming variant returns a ReadableStream-of-encoded-chunks (impl in coordinator).
  executeStream?(...args: unknown[]): Promise<ReadableStream<Uint8Array>>;
}

export interface WorkerStub {
  getEntrypoint(): EntrypointStub;
  getEntrypoint(name: string, opts?: EntrypointOptions): EntrypointStub;
}

export type GetCodeCallback = () => Promise<WorkerCode>;

export interface WorkerLoader {
  /**
   * Load or reuse an isolate by ID. Same ID + same code = isolate reuse;
   * different IDs always get fresh isolates. The callback may be called any
   * number of times for a given ID; it MUST return identical content.
   */
  get(id: string, getCodeCallback: GetCodeCallback): WorkerStub;
}

// ---- library-internal envelope shape ----------------------------------

/**
 * Wire envelope for every internal RPC. Carries the cancel token id, deadline
 * cookie, and tracing metadata so user-fn signatures stay clean
 * (`(...userArgs, env)` with `env.signal` injected on the loaded side).
 */
export interface RpcEnvelope {
  /** Absolute deadline in ms-since-epoch. 0 means "no deadline". */
  deadlineEpochMs: number;
  /** Cancel-token correlation id; matched against coordinator-side state. */
  cancelTokenId?: string;
  /** OTel-style trace correlation. */
  traceId?: string;
  spanId?: string;
  /** Marker so dispatched fns know which mode they're running under. */
  mode: 'pool-fn' | 'actor-class' | 'sub-coord';
}
