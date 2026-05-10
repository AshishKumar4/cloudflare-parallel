import type { ServiceStub, WorkerCodeLimits, WorkerLoader } from '../types';
import type { SubmitCodePolicy } from './submit-code-handler';
import type { CancelToken } from './cancel';
import type { Topology } from '../topology/selector';
import type { CacheKeyStrategy } from '../loader/cache-key';
import type { LocationHint } from '../coordinator/internal';
import type {
  CoordinatorRunRequest,
  CoordinatorFanOutRequest,
  RunOneResult,
} from '../coordinator/protocol';

/**
 * Shape of a `ctx.exports.<WorkerEntrypoint>` loopback binding. The
 * library accepts an opaque object with `runOne` / `runMany` so users can
 * pass `ctx.exports.CfpInProcessCoordinator` (a WorkerEntrypoint stub)
 * directly without TypeScript complaining about generic Cloudflare types.
 */
export interface InProcessCoordinatorBinding {
  runOne(request: CoordinatorRunRequest): Promise<RunOneResult>;
  runMany(request: CoordinatorFanOutRequest): Promise<{
    results: RunOneResult[];
    topology: 'in-do';
    fanOutPerLevel: number[];
    treeDepth: number;
  }>;
}

// ---- env shape --------------------------------------------------------

/**
 * `env` argument shape passed to factories. Required:
 *   - `LOADER` — Worker Loader binding (must be present)
 *
 * Optional (full Pool requires at least Coordinator):
 *   - `CfpCoordinator` — Coordinator DO namespace
 *   - `CfpWorkerDO`    — Worker DO namespace (hybrid leaves)
 *   - `CfpSubCoord`    — Sub-coordinator DO namespace (tree)
 *   - `CfpSchedulerDO` — Scheduler DO namespace
 *
 * The in-process coordinator (`CfpInProcessCoordinator`) is wired up
 * via `PoolOptions.inProcess` rather than `env`, since it lives on the
 * `ctx.exports` shape and is not a Durable Object namespace binding.
 */
export interface PoolEnv {
  LOADER: WorkerLoader;
  CfpCoordinator?: DurableObjectNamespace;
  CfpWorkerDO?: DurableObjectNamespace;
  CfpSubCoord?: DurableObjectNamespace;
  CfpSchedulerDO?: DurableObjectNamespace;
  // User bindings flow through B (the type parameter on factories).
  [key: string]: unknown;
}

// ---- Worker code options (compat date / globalOutbound / limits / tails) ----

export interface WorkerCodeOptions {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  /** `null` = sandboxed (default), `undefined` = inherit, ServiceStub = redirect. */
  globalOutbound?: ServiceStub | null;
  limits?: WorkerCodeLimits;
}

// ---- observability ----------------------------------------------------

export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface ObservabilityOptions {
  /** Direct callback hooks (synchronous; runtime mutations forbidden). */
  hooks?: {
    onTaskStart?: (e: TaskStartEvent) => void;
    onTaskEnd?: (e: TaskEndEvent) => void;
    onTaskError?: (e: TaskErrorEvent) => void;
    onTaskOrphan?: (e: TaskOrphanEvent) => void;
    onPoolPressure?: (e: PoolPressureEvent) => void;
    onTopologyDecision?: (e: TopologyDecisionEvent) => void;
    onLruEviction?: (e: LruEvictionEvent) => void;
    onSchedulerEvent?: (e: SchedulerEvent) => void;
  };
  /**
   * Tail Worker auto-attach. Provide either:
   * - `bindingName` — the name of a Service binding on the coordinator
   *   DO's env. Ridden across the wire as a string and resolved DO-side
   *   so the loaded isolate's `tails:` array can be populated.
   * - `binding` — direct `ServiceStub` for in-process / loader-only
   *   topologies (where the call stays in the caller Worker).
   */
  tail?: { bindingName?: string; binding?: ServiceStub; sampling?: number };
  /** Analytics Engine adapter. */
  metrics?: AnalyticsEngineDataset | 'off';
}

export interface TaskStartEvent {
  ts: number;
  poolId: string;
  taskId: string;
  topology: Exclude<Topology, 'auto'> | 'loader-only';
  fnHash: string;
}

export interface TaskEndEvent extends TaskStartEvent {
  wallMs: number;
  retryCount: number;
}

export interface TaskErrorEvent extends TaskStartEvent {
  errorClass: string;
  message: string;
  retryCount: number;
}

export interface TaskOrphanEvent {
  ts: number;
  poolId: string;
  taskId: string;
  reason?: string;
}

export interface PoolPressureEvent {
  ts: number;
  kind: 'lru-thrash' | 'backpressure-retry' | 'fan-out-cap';
  detail?: string;
}

export interface TopologyDecisionEvent {
  ts: number;
  size: number;
  topology: Exclude<Topology, 'auto'> | 'loader-only';
  fanOutPerLevel: number[];
  treeDepth: number;
}

export interface LruEvictionEvent {
  ts: number;
  cacheKey: string;
}

export interface SchedulerEvent {
  ts: number;
  jobId: string;
  kind: 'enqueued' | 'leased' | 'done' | 'failed' | 'cancelled' | 'retrying' | 'expired';
  detail?: string;
}

// ---- pool / actor / scheduler / vm options ----------------------------

export interface PoolOptions<B = Record<string, unknown>, C = Record<string, unknown>> {
  bindings?: B;
  context?: C;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  globalOutbound?: ServiceStub | null;
  limits?: WorkerCodeLimits;
  /** Topology pinning. Loader-only is via `Parallel.loaderOnly()`, not here. */
  topology?: Topology;
  maxFanOut?: number;
  branchingFactor?: number;
  treeThreshold?: number;
  cacheKeyStrategy?: CacheKeyStrategy;
  observability?: ObservabilityOptions;
  workerOptions?: WorkerCodeOptions;
  /** Coordinator DO id. Default = a stable per-Worker id. */
  coordinatorId?: string;
  /**
   * In-process coordinator loopback. Pass
   * `ctx.exports.CfpInProcessCoordinator` here to bypass the Coordinator
   * Durable Object for small fan-outs (size ≤ 4) and single-shot
   * `submit` calls. The loopback stays inside the same Worker process,
   * dropping per-call dispatch overhead from tens of milliseconds (DO RPC)
   * to a couple of milliseconds (in-process Cap'n Proto).
   *
   * Larger fan-outs still flow through the Coordinator DO (which fans out
   * across leaf DOs to compose 4N parallelism).
   *
   * Reference: https://developers.cloudflare.com/workers/runtime-apis/context/
   */
  inProcess?: InProcessCoordinatorBinding;
  /**
   * Region hint forwarded to `namespace.get(id, { locationHint })` when
   * materializing leaf DOs. Use to colocate freshly-created DOs with the
   * caller. Honored only on first access of each DO; subsequent gets are
   * sticky.
   *
   * If omitted and a request's `cf.colo` is available via
   * {@link PoolOptions.requestColo}, the library auto-derives a region from
   * the colo code.
   *
   * Reference: https://developers.cloudflare.com/durable-objects/reference/data-location/
   */
  locationHint?: LocationHint;
  /**
   * Optional caller colo (e.g. `'SFO'`). Pass `request.cf?.colo as string`
   * if you have a request handy. The library will pick a `locationHint`
   * for you if `locationHint` is not set.
   */
  requestColo?: string;
}

export interface LoaderOnlyOptions<B = Record<string, unknown>, C = Record<string, unknown>> {
  bindings?: B;
  context?: C;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  globalOutbound?: ServiceStub | null;
  limits?: WorkerCodeLimits;
  cacheKeyStrategy?: CacheKeyStrategy;
  workerOptions?: WorkerCodeOptions;
}

export interface ActorOptions<
  State = Record<string, unknown>,
  B = Record<string, unknown>,
  C = Record<string, unknown>,
> extends PoolOptions<B, C> {
  id: string;
  initialState?: State;
  hibernation?: { idleMs?: number; persist?: boolean };
}

export type RetryBackoff = 'exponential' | 'linear' | 'constant';

export interface RetryPolicy {
  max: number;
  backoff: RetryBackoff;
  baseMs: number;
}

/**
 * Worker-related options shared by Pool, Scheduler, Actor, and VM.
 * Extracted from `PoolOptions` so `SchedulerOptions` can compose them
 * without inheriting fan-out tuning that doesn't apply to the scheduler.
 */
export interface WorkerSharedOptions<
  B = Record<string, unknown>,
  C = Record<string, unknown>,
> {
  bindings?: B;
  context?: C;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  globalOutbound?: ServiceStub | null;
  limits?: WorkerCodeLimits;
  cacheKeyStrategy?: CacheKeyStrategy;
  observability?: ObservabilityOptions;
  workerOptions?: WorkerCodeOptions;
}

export interface SchedulerOptions<
  B = Record<string, unknown>,
  C = Record<string, unknown>,
> extends WorkerSharedOptions<B, C> {
  /** Stable Scheduler id (also the SchedulerDO instance key). Required. */
  id: string;
  /**
   * JobStore backend. Default `'do-storage'` (canonical, transactional).
   * `'queues'` and `'d1'` are opt-in adapters; passing a `JobStore`
   * implementation directly is supported (typed `unknown` here for the
   * wire shape).
   */
  store?: 'do-storage' | 'queues' | 'd1' | unknown;
  fairness?: { keyFrom: (job: Job<unknown[], unknown>) => string; capacityPerKey: number };
  retry?: RetryPolicy;
  deadline?: { defaultMs: number };
  resultRetention?: { ttlMs: number };
  alarmCadence?: { activeMs: number; idleMs: number };
  /** Max concurrent jobs in dispatch (default 32). */
  inFlightLimit?: number;
  /** Max queued jobs before backpressure (default Infinity). */
  maxQueueDepth?: number;
  /** Per-tenant in-flight cap inside `inFlightLimit` (default 4). */
  fairCapacityPerTenant?: number;
}

/**
 * VM options. `VMOptions<B>` extends `PoolOptions<B>` directly — the v0.2
 * nested `pool: PoolOptions<B>` shape was awkward. The legacy
 * `pool:` field is still honored for backward-compat; new code should
 * pass pool options at the top level.
 */
export interface VMOptions<B = Record<string, unknown>> extends PoolOptions<B> {
  /**
   * Security policy. Required (at least one of `policy` or `auth` must
   * be set). There is no default-public path; constructing `Parallel.VM`
   * without `policy` and `auth` throws `PolicyRequiredError`.
   */
  policy?: SubmitCodePolicy<B>;
  /**
   * @deprecated Pass `policy: { kind: 'auth', auth }` instead. The
   * top-level `auth` field is folded into a `policy` shape on
   * construction.
   */
  auth?: (req: Request) => boolean | Promise<boolean>;
  /**
   * @deprecated Use `policy.allowBindings`. Top-level `allowBindings` is
   * only consulted with the legacy `auth` field.
   */
  allowBindings?: ReadonlyArray<keyof B & string>;
  /**
   * @deprecated Use `policy.maxBytes`. Top-level `maxBytes` is only
   * consulted with the legacy `auth` field.
   */
  maxBytes?: number;
  /**
   * @deprecated Pass pool options at the top level of `VMOptions`. The
   * nested `pool:` field is still honored when present, but the flat
   * shape is preferred.
   */
  pool?: PoolOptions<B>;
}

// ---- submit / job shapes ---------------------------------------------

export type OnErrorStrategy = 'throw' | 'throw-fast' | 'null' | 'skip' | 'settled';

export interface SubmitOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  context?: Record<string, unknown>;
  cancel?: CancelToken;
  /** Absolute ms-since-epoch deadline. Mutually exclusive with `deadlineMs`. */
  deadline?: number;
  /** Relative-from-now ms deadline (convenience). Mutually exclusive with `deadline`. */
  deadlineMs?: number;
  /** Override stable cache key for this submission. */
  freshIsolate?: boolean;
  meta?: Record<string, string>;
}

export interface MapOptions extends SubmitOptions {
  concurrency?: number;
  onError?: OnErrorStrategy;
}

export interface PmapOptions {
  chunks?: number;
}

export interface ScatterOptions extends SubmitOptions {
  onError?: OnErrorStrategy;
}

export interface StreamOptions extends SubmitOptions {
  concurrency?: number;
}

export interface StreamResult<T> {
  index: number;
  value: T;
}

export interface Job<A extends unknown[], R> {
  fn: (...args: A) => R | Promise<R>;
  args: A;
  tenantId?: string;
  /** Relative-from-submission ms. */
  deadlineMs?: number;
  /** Absolute ms-since-epoch. Mutually exclusive with `deadlineMs`. */
  deadline?: number;
  retry?: RetryPolicy;
  idempotencyKey?: string;
  meta?: Record<string, string>;
}

/** Job lifecycle status. `leased` = claimed by a worker but not yet ack'd; user-facing `JobHandle.status()` collapses `leased` to `running`. */
export type JobStatus = 'queued' | 'leased' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobHandle<R> {
  readonly id: string;
  result(): Promise<R>;
  status(): Promise<JobStatus>;
  cancel(reason?: string): Promise<void>;
}

// ---- stats ------------------------------------------------------------

export interface PoolStats {
  inFlight: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
  topology: Exclude<Topology, 'auto'> | 'loader-only';
  topologyDecisionAt: number;
  warmIsolatesEstimate: number;
  uniqueFnShapesToday: number;
  lruEvictionLast60sCount: number;
  treeDepth: number;
  fanOutPerLevel: number[];
}

export interface SchedulerStats extends PoolStats {
  byTenant: Record<string, { queued: number; running: number }>;
  oldestQueuedAgeMs: number;
  resultRetentionTtlMs: number;
}
