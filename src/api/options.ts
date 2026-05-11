import type { ServiceStub, WorkerCodeLimits, WorkerLoader } from '../types';
import type { SubmitCodePolicy } from './submit-code-handler';
import type { CancelToken } from './cancel';
import type { Topology } from '../topology/selector';
import type { CacheKeyStrategy } from '../loader/cache-key';
import type { JobStore } from '../scheduler/job-store';
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

/**
 * Options forwarded to every loaded isolate the library spins up.
 * Affect cold-start behavior (`compatibilityDate`, `compatibilityFlags`),
 * sandboxing (`globalOutbound`), and resource caps (`limits`). All
 * factories accept this shape via `PoolOptions.workerOptions`.
 */
export interface WorkerCodeOptions {
  /** Workers runtime compatibility date. Defaults to the library's bundled date (`2026-01-20`). */
  compatibilityDate?: string;
  /** Additional compatibility flags for the loaded isolate. */
  compatibilityFlags?: string[];
  /** `null` = sandboxed (default), `undefined` = inherit, `ServiceStub` = redirect. */
  globalOutbound?: ServiceStub | null;
  /** Per-isolate runtime caps (cpuMs, subrequests, etc). */
  limits?: WorkerCodeLimits;
}

// ---- observability ----------------------------------------------------

/**
 * Minimal shape of a Workers Analytics Engine binding. The library
 * does not type-import `@cloudflare/workers-types` directly so this
 * mirror suffices.
 */
export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

/**
 * Observability config — direct hooks for in-process metrics + tail
 * workers for cross-Worker fan-out logging + Analytics Engine for
 * sampled aggregate metrics.
 *
 * Hooks fire synchronously and must not mutate the runtime; errors
 * inside hooks are caught and dropped so they cannot break submits.
 */
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

/**
 * Options for `Parallel.pool(env, opts)`. Every field is optional;
 * defaults match the validated production profile (Mandelbrot bench:
 * `cacheKeyStrategy: 'stable'`, `autoWarm: true`, `maxFanOut: 32`,
 * `branchingFactor: 8`).
 *
 * Two type parameters:
 *  - `B` — shape of user bindings forwarded into the loaded isolate's
 *    `env`. Defaults to a wide `Record<string, unknown>`; users
 *    typically supply their `Env` interface.
 *  - `C` — shape of module-scope context embedded as `const k = JSON`
 *    statements in the loaded source. JSON-canonicalizable only.
 */
export interface PoolOptions<B = Record<string, unknown>, C = Record<string, unknown>> {
  /** User bindings forwarded into the loaded isolate's `env`. */
  bindings?: B;
  /** Module-scope constants embedded into the loaded source. JSON-only. */
  context?: C;
  /** Wall-clock cap per submit. Default 30s. */
  timeout?: number;
  /** Number of retries on transient errors (Backpressure, Disconnected). Default 0. */
  retries?: number;
  /** Initial retry backoff in ms; jittered ±25%. Default 100. */
  retryDelay?: number;
  /** `null` (default) = sandboxed, `undefined` = inherit caller's outbound, `ServiceStub` = proxy. */
  globalOutbound?: ServiceStub | null;
  /** Per-isolate `cpuMs` / `subRequests` caps. */
  limits?: WorkerCodeLimits;
  /** Topology pinning. Loader-only is via `Parallel.loaderOnly()`, not here. */
  topology?: Topology;
  /** Per-coordinator RPC fan-out cap (default 32). Above this, auto-selector promotes to tree. */
  maxFanOut?: number;
  /** Tree branching factor F (range 4..16). Default 8. */
  branchingFactor?: number;
  /** Override hybrid→tree boundary; defaults to `maxFanOut`. */
  treeThreshold?: number;
  /** `'stable'` (default) per `(fn, slot)`, `'fresh'` per call, `'auto'` 60s buckets. */
  cacheKeyStrategy?: CacheKeyStrategy;
  /** Observability hooks + tail-Worker + Analytics Engine. */
  observability?: ObservabilityOptions;
  /** Forwarded to every loaded isolate. See {@link WorkerCodeOptions}. */
  workerOptions?: WorkerCodeOptions;
  /** Coordinator DO id. Default = a stable per-Worker id. */
  coordinatorId?: string;
  /**
   * In-process coordinator loopback. Pass
   * `ctx.exports.CfpInProcessCoordinator` here to bypass the Coordinator
   * Durable Object for single-shot `submit()` calls (and the rare
   * `pool.map([x], fn)` of size = 1). The loopback stays inside the
   * same Worker process, dropping per-call dispatch overhead from tens
   * of milliseconds (DO RPC) to a couple of milliseconds (in-process
   * Cap'n Proto).
   *
   * Fan-outs of size ≥ 2 always flow through the Coordinator DO so
   * each task lands in its own leaf DO process. CPU parallelism only
   * scales across separate workerd processes; loaders inside one
   * process share its V8 scheduler thread.
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
  /**
   * When `true` (the default), the pool fires a `noop()` against every
   * leaf DO in parallel with the first fan-out's real dispatch. This
   * absorbs the one-time DO-creation cost (empirically ~300–400 ms) on
   * the prewarm goroutine while the real call rides the warm channel.
   *
   * Empirically validated: per-call cold-path drops 14×–140× when the
   * DO is prewarmed. Cost: zero (parallelized with real dispatch). The
   * second and subsequent fan-outs in the same Pool lifetime skip
   * prewarm — the DOs are already warm.
   *
   * Set to `false` if you have a workload pattern where DO creation
   * is part of the measured wall-clock you care about (e.g. you're
   * benchmarking cold-start specifically).
   */
  autoWarm?: boolean;
}

/**
 * Options for `Parallel.loaderOnly(env, opts)`. Strictly narrower than
 * `PoolOptions` — no Coordinator DO is involved, so topology /
 * autoWarm / inProcess / locationHint fields are not supported.
 * Concurrent loaders are capped at 3 per Worker fetch handler by the
 * runtime; use {@link PoolOptions} for higher fan-out.
 */
export interface LoaderOnlyOptions<B = Record<string, unknown>, C = Record<string, unknown>> {
  /** User bindings forwarded into the loaded isolate's `env`. */
  bindings?: B;
  /** Module-scope context. JSON-canonicalizable only. */
  context?: C;
  /** Wall-clock cap per submit. */
  timeout?: number;
  /** Retries on transient errors. */
  retries?: number;
  /** Initial retry backoff in ms. */
  retryDelay?: number;
  /** `null` = sandboxed (default), `undefined` = inherit. */
  globalOutbound?: ServiceStub | null;
  /** Per-isolate runtime caps. */
  limits?: WorkerCodeLimits;
  /** Loader cache-key strategy. */
  cacheKeyStrategy?: CacheKeyStrategy;
  /** Worker code options (compatibilityDate, flags, limits). */
  workerOptions?: WorkerCodeOptions;
}

/**
 * Options for a long-lived stateful actor. Extends
 * `WorkerSharedOptions` rather than `PoolOptions` because actors are
 * single-DO / single-job — topology knobs (`topology`, `maxFanOut`,
 * `branchingFactor`, `treeThreshold`) and the auto-warm / inProcess
 * pool-only fields don't apply.
 */
export interface ActorOptions<
  State = Record<string, unknown>,
  B = Record<string, unknown>,
  C = Record<string, unknown>,
> extends WorkerSharedOptions<B, C> {
  /** Stable actor instance key. */
  id: string;
  /** Initial state if the actor is materialized for the first time. */
  initialState?: State;
  /** Reserved for future use — hibernation is not wired in the current release. */
  hibernation?: { idleMs?: number; persist?: boolean };
}

/** Retry backoff curve. */
export type RetryBackoff = 'exponential' | 'linear' | 'constant';

/** Retry policy for `Job.retry` and `PoolOptions.retries`-driven submits. */
export interface RetryPolicy {
  /** Maximum retry attempts. */
  max: number;
  /** Backoff curve — `'exponential'` doubles per attempt, `'linear'` adds, `'constant'` flat. */
  backoff: RetryBackoff;
  /** Initial backoff in ms; multiplied per the chosen curve. */
  baseMs: number;
}

/**
 * Worker-related options shared by Pool, Scheduler, Actor, and VM.
 * Extracted from `PoolOptions` so `SchedulerOptions` can compose them
 * without inheriting fan-out tuning that doesn't apply to the scheduler.
 */
export interface WorkerSharedOptions<B = Record<string, unknown>, C = Record<string, unknown>> {
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
  /**
   * Region hint forwarded to `namespace.get(id, { locationHint })` when
   * the underlying Durable Object is materialized. Best-effort; only
   * honored on first access. Use to colocate freshly-created DOs with
   * the request's incoming colo.
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

export interface SchedulerOptions<
  B = Record<string, unknown>,
  C = Record<string, unknown>,
> extends WorkerSharedOptions<B, C> {
  /** Stable Scheduler id (also the SchedulerDO instance key). Required. */
  id: string;
  /**
   * JobStore backend. Default `'do-storage'` (canonical, transactional).
   * `'queues'` and `'d1'` are opt-in adapter names; pass a `JobStore`
   * implementation directly for custom backends.
   */
  store?: 'do-storage' | 'queues' | 'd1' | JobStore;
  /** Per-tenant fairness key + capacity for round-robin dispatch. */
  fairness?: { keyFrom: (job: Job<unknown[], unknown>) => string; capacityPerKey: number };
  /** Retry policy applied to jobs that don't carry their own. */
  retry?: RetryPolicy;
  /** Default per-job deadline when `Job.deadline` is omitted. */
  deadline?: { defaultMs: number };
  /** How long `done` results linger before sweep. After this, `result()` throws `ResultExpiredError`. */
  resultRetention?: { ttlMs: number };
  /** Backstop alarm cadence (retry + result-TTL sweep + expired-lease reclaim). */
  alarmCadence?: { activeMs: number; idleMs: number };
  /** Max concurrent jobs in dispatch (default 32). */
  inFlightLimit?: number;
  /** Max queued jobs before backpressure (default Infinity). */
  maxQueueDepth?: number;
  /** Per-tenant in-flight cap inside `inFlightLimit` (default 4). */
  fairCapacityPerTenant?: number;
}

/**
 * VM options. `VMOptions<B>` extends `PoolOptions<B>` directly so all
 * pool tuning knobs (topology, autoWarm, cacheKeyStrategy, etc.) are
 * accepted at the top level. A handful of fields are kept as
 * `@deprecated` aliases for the earlier nested `pool: PoolOptions<B>`
 * shape — slated for removal in the next major.
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

/**
 * Failure-handling strategy for fan-out operations. Choose based on
 * how aggressively you want sibling tasks to keep running after one
 * fails:
 *  - `'throw'` (default) — wait for all siblings, throw `AggregateExecutionError`.
 *  - `'throw-fast'` — first error wins; abort newer dispatches.
 *  - `'null'` — replace failures with `null` in the result array.
 *  - `'skip'` — drop failures (output length shrinks).
 *  - `'settled'` — return `SettledResult<R>[]` (Promise.allSettled shape).
 */
export type OnErrorStrategy = 'throw' | 'throw-fast' | 'null' | 'skip' | 'settled';

/**
 * Per-submission overrides. Trail any submit-shape (`pool.submit`,
 * `pool.map`, `pool.scatter`, `Scheduler.enqueue`'s job options) — the
 * library detects the bag by key shape.
 */
export interface SubmitOptions {
  /** Wall-clock cap for this call. */
  timeout?: number;
  /** Retries on transient errors for this call. */
  retries?: number;
  /** Initial retry backoff in ms. */
  retryDelay?: number;
  /** Per-call module-scope context overlaid on `PoolOptions.context`. */
  context?: Record<string, unknown>;
  /** Cooperative cancel token. The library plumbs it into `env.signal`. */
  cancel?: CancelToken;
  /** Absolute ms-since-epoch deadline. Mutually exclusive with `deadlineMs`. */
  deadline?: number;
  /** Relative-from-now ms deadline (convenience). Mutually exclusive with `deadline`. */
  deadlineMs?: number;
  /** Force a fresh V8 heap for this submission. */
  freshIsolate?: boolean;
  /** Free-form metadata stored alongside the job; surfaced in observability events. */
  meta?: Record<string, string>;
}

/** Options for `pool.map(fn, items, opts)`. */
export interface MapOptions extends SubmitOptions {
  /** Cap on concurrent dispatches; defaults to `items.length`. */
  concurrency?: number;
  /** Failure mode. See {@link OnErrorStrategy}. */
  onError?: OnErrorStrategy;
}

/** Options for the `pool.pmap(fn)` returned mapper. */
export interface PmapOptions {
  /** Number of partitions; the items array is sliced N ways. */
  chunks?: number;
}

/** Options for `pool.scatter(fn, items, chunks, opts)`. */
export interface ScatterOptions extends SubmitOptions {
  /** Failure mode. See {@link OnErrorStrategy}. */
  onError?: OnErrorStrategy;
}

/** Options for `pool.mapStream(fn, items, opts)`. */
export interface StreamOptions extends SubmitOptions {
  /** Cap on concurrent dispatches; defaults to `items.length`. */
  concurrency?: number;
}

/** One yielded result from `pool.mapStream`. */
export interface StreamResult<T> {
  /** Original index of the corresponding item. */
  index: number;
  /** User-fn return value for that item. */
  value: T;
}

/** A job submission to {@link Scheduler.enqueue}. */
export interface Job<A extends unknown[], R> {
  /** The user function. Must be pure / closure-free (per {@link Pure}). */
  fn: (...args: A) => R | Promise<R>;
  /** Positional arguments for `fn`. */
  args: A;
  /** Optional tenant key for fair-queueing. */
  tenantId?: string;
  /** Relative-from-submission ms. */
  deadlineMs?: number;
  /** Absolute ms-since-epoch. Mutually exclusive with `deadlineMs`. */
  deadline?: number;
  /** Per-job retry policy override. */
  retry?: RetryPolicy;
  /** Dedup key — repeat submissions are no-ops once a matching job exists. */
  idempotencyKey?: string;
  /** Free-form metadata persisted with the job. */
  meta?: Record<string, string>;
}

/**
 * Job lifecycle status.
 *
 * `leased` = claimed by a worker but not yet ack'd; user-facing
 * `JobHandle.status()` collapses `leased` to `running`.
 */
export type JobStatus = 'queued' | 'leased' | 'running' | 'done' | 'failed' | 'cancelled';

/** Handle to an in-flight Scheduler job. */
export interface JobHandle<R> {
  /** Stable job id (also the idempotency key when one was supplied). */
  readonly id: string;
  /** Resolve with the job result; reject with the typed library error if it failed. */
  result(): Promise<R>;
  /** Snapshot the current status. */
  status(): Promise<JobStatus>;
  /** Cancel the job. No-op if already terminal. */
  cancel(reason?: string): Promise<void>;
}

// ---- stats ------------------------------------------------------------

/** Snapshot of pool state returned by `Pool.stats()`. */
export interface PoolStats {
  /** Submits currently in flight. */
  inFlight: number;
  /** Submits queued (in-process backpressure). */
  queued: number;
  /** Total submits completed successfully since pool construction. */
  completed: number;
  /** Total submits that threw a typed error. */
  failed: number;
  /** Total submits cancelled by token / deadline / parent-cancel. */
  cancelled: number;
  /** Last topology decision made by the auto-selector. */
  topology: Exclude<Topology, 'auto'> | 'loader-only';
  /** When that decision was made (epoch ms). */
  topologyDecisionAt: number;
  /** Best-effort estimate of warm loaded isolates currently cached. */
  warmIsolatesEstimate: number;
  /** Distinct fn-shape hashes seen so far today. */
  uniqueFnShapesToday: number;
  /** Loader LRU evictions in the last rolling 60s window. */
  lruEvictionLast60sCount: number;
  /** Depth of the last topology decision (1 = hybrid, K = tree). */
  treeDepth: number;
  /** Fan-out widths per coordinator tier (root → leaf). */
  fanOutPerLevel: number[];
}

/** Snapshot of scheduler state returned by `Scheduler.stats()`. */
export interface SchedulerStats extends PoolStats {
  /** Per-tenant `{ queued, running }` counts. */
  byTenant: Record<string, { queued: number; running: number }>;
  /** Age of the oldest still-queued job (ms). */
  oldestQueuedAgeMs: number;
  /** Configured result retention TTL. */
  resultRetentionTtlMs: number;
}
