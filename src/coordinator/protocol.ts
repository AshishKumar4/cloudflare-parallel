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
  /**
   * Task slot index within a single fan-out (0..N-1). Differentiates
   * concurrent isolates within ONE fan-out so they don't all collide on
   * one shared loaded isolate. Stable across calls (slot-0 stays
   * slot-0 next time), distinct within ONE fan-out (slot-0 ≠ slot-1).
   *
   * Single-shot `submit` calls pass `taskSlot: 0` so they share the
   * same isolate as `slot-0` in a future `map` — compatible reuse.
   *
   * See `src/loader/cache-key.ts` for the full rationale.
   */
  taskSlot?: number;
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
  /**
   * Slot index of the FIRST task in this batch — global across the fan-out.
   * Leaf-0 receives `taskSlotBase: 0`, leaf-1 receives `taskSlotBase:
   * <leaf-0.size>`, and so on, so the i-th task in this batch maps to
   * `taskSlot: taskSlotBase + i` in the leaf's `LoaderRunner.runOne`
   * dispatch. Global slots ensure stable isolate reuse across calls.
   */
  taskSlotBase?: number;
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
} from './coordinator';

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
  /**
   * Slot index of the FIRST task in this slice — global across the
   * entire fan-out. Propagates down the tree so the leaf DO knows
   * which global slot each of its tasks maps to. See
   * `RunBatchRequest.taskSlotBase` for the rationale.
   */
  taskSlotBase?: number;
  /** See RunOneRequest.cancelStream. Forwarded down the tree. */
  cancelStream?: ReadableStream<Uint8Array>;
  /**
   * Optional DO placement hint, forwarded down the tree so deeper tiers
   * place their DOs in the same region as the request's incoming colo.
   * Best-effort; only honored on first access of each DO.
   * Reference: https://developers.cloudflare.com/durable-objects/reference/data-location/
   */
  locationHint?: 'wnam' | 'enam' | 'sam' | 'weur' | 'eeur' | 'apac' | 'oc' | 'afr' | 'me';
}

export interface DispatchTreeResult {
  results: RunOneResult[];
}

/**
 * Marshal a thrown library error into the per-leaf failure record
 * carried on the wire — `{ name, message, stack?, originalName? }`.
 * Used by both the per-leaf `RunOneResult.error` envelope and the
 * Scheduler's persisted-job failure column.
 *
 * Distinct from the standalone `WireError` shape in
 * `src/errors/index.ts` (which carries the full typed-error transport
 * with `code`, `httpStatus`, `extra`, `cause`).
 */
export function errorToRecord(err: unknown): {
  name: string;
  message: string;
  stack?: string;
  originalName?: string;
} {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    name: e.name || 'Error',
    message: e.message ?? '',
    stack: e.stack,
    originalName: (e as { originalName?: string }).originalName,
  };
}

/**
 * Wrap an error in the leaf-RPC failure envelope expected by
 * `RunOneResult`. Composed from `errorToRecord`.
 */
export function errorToFailedResult(err: unknown): RunOneResult {
  return { ok: false, error: errorToRecord(err) };
}
