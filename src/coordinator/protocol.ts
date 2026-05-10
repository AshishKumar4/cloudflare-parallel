/**
 * Wire-shape types shared between the public API factories (which run in the
 * caller's Worker fetch handler) and the library's DO classes (Coordinator,
 * WorkerDO, SubCoord, SchedulerDO).
 *
 * Everything here MUST be structured-clone-safe. No closures, no functions.
 */

export interface ContextEnvelope {
  context?: Record<string, unknown>;
  /** Snapshotted user `bindings` keys. The DO injects values from its own env. */
  bindingKeys?: string[];
}

export interface DispatchEnvelope {
  /** Absolute deadline (ms epoch). 0 = no deadline. */
  deadlineEpochMs: number;
  /** Cancel state snapshot at dispatch time. */
  signal: { cancelled: boolean; reason?: string };
  /** OTel trace correlation. */
  traceId?: string;
  spanId?: string;
}

export interface RunOneRequest {
  fnSource: string;
  fnHash: string;
  args: unknown[];
  context?: Record<string, unknown>;
  freshIsolate?: boolean;
  cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
  /** Wire-level workerOptions overrides. */
  workerOptions?: {
    compatibilityDate?: string;
    compatibilityFlags?: string[];
    globalOutbound?: 'inherit' | 'sandboxed';
    limits?: { cpuMs?: number; subRequests?: number };
    /**
     * Optional Tail Worker binding *name* that the coordinator DO should
     * resolve from its own env and inject into the loaded isolate's
     * `tails:`. ServiceStub itself is not structured-clone-safe across RPC,
     * so we send the name and re-look it up at the DO. Configured via
     * `opts.observability.tail = { bindingName: 'TAIL' }`.
     */
    tailBindingName?: string;
  };
  envelope: DispatchEnvelope;
  /**
   * Live cancel transport: a `ReadableStream<Uint8Array>` originating at the
   * caller. The coordinator forwards this stream as `env.cancelStream` to
   * the loaded isolate; on first chunk, the loaded isolate aborts its local
   * `AbortController` (whose signal is exposed as user-fn `env.signal`).
   * `ReadableStream` is structured-clone across RPC; a single stream can
   * travel caller → coordinator → child DO → loader. See `cancel-stream.ts`.
   */
  cancelStream?: ReadableStream<Uint8Array>;
}

export interface RunBatchRequest {
  /** Per-leaf job descriptor. Identical fn shape across the batch. */
  fnSource: string;
  fnHash: string;
  context?: Record<string, unknown>;
  workerOptions?: RunOneRequest['workerOptions'];
  cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
  /** Each entry is the args tuple for one leaf-isolate dispatch. */
  argsList: unknown[][];
  envelope: DispatchEnvelope;
  freshIsolate?: boolean;
  /** See RunOneRequest.cancelStream. Forwarded into each leaf's env. */
  cancelStream?: ReadableStream<Uint8Array>;
}

/**
 * Result envelope from a leaf RPC. Errors travel as serializable payloads
 * because RPC across DOs strips Error prototypes.
 */
export type RunOneResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { name: string; message: string; stack?: string; originalName?: string };
    };

// Re-export coordinator-side request shapes for convenience. The actual
// classes (with method bodies) live in coordinator.ts; this module is the
// pure structural-clone-safe wire-shape declaration.
export type {
  CoordinatorEnv,
  CoordinatorFanOutRequest,
  CoordinatorRunRequest,
} from './coordinator.js';

export interface RunBatchResult {
  /** Same length as `argsList`. */
  results: RunOneResult[];
}

// ---- topology dispatch ------------------------------------------------

/** Sub-coordinator delegate: receives a slice of a tree plan. */
export interface DispatchTreeRequest {
  fnSource: string;
  fnHash: string;
  context?: Record<string, unknown>;
  workerOptions?: RunOneRequest['workerOptions'];
  cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
  /** Args for THIS slice, in caller-original index order. */
  argsList: unknown[][];
  /** Plan slice — directly delegated. Children are HybridPlan or sub-trees. */
  planChildSizes: number[];
  /** Branching factor used downstream. */
  branchingFactor: number;
  /** Depth of THIS sub-coord (1 = next call delegates to hybrid leaves). */
  depth: number;
  /** Max fan-out per coordinator level. */
  maxFanOut: number;
  envelope: DispatchEnvelope;
  /** See RunOneRequest.cancelStream. Forwarded down the tree. */
  cancelStream?: ReadableStream<Uint8Array>;
}

export interface DispatchTreeResult {
  results: RunOneResult[];
}

/**
 * Marshal a thrown library error into the per-job RunOneResult failure shape
 * (NOT the standalone WireError shape — that lives in `src/errors/index.ts`
 * and is used for typed-error JSON round-trips). The two are intentionally
 * distinct: RunOneResult is the per-leaf RPC envelope; WireError is the
 * full typed-error transport.
 */
export function errorToFailedResult(err: unknown): RunOneResult {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    ok: false,
    error: {
      name: e.name || 'Error',
      message: e.message ?? '',
      stack: e.stack,
      originalName: (e as { originalName?: string }).originalName,
    },
  };
}
