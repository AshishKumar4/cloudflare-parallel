/**
 * cloudflare-parallel v0.3 — public API surface.
 *
 * Five factories under one namespace, plus the typed primitives and errors.
 * For testing fakes, import from `cloudflare-parallel/testing`.
 * For the library DO classes, import from `cloudflare-parallel/durable-objects`.
 */

export { Parallel } from './api/parallel.js';
export { Pool } from './api/pool.js';
export type { IPool, PipeFn } from './api/pool.js';
export { LoaderOnlyPoolImpl as LoaderOnlyPool } from './api/loader-only-pool.js';
export type { LoaderOnlyPool as LoaderOnlyPoolType } from './api/loader-only-pool.js';
export { ActorHandle } from './api/actor.js';
export type { IActorHandle } from './api/actor.js';
export { Scheduler } from './api/scheduler.js';
export type { IScheduler } from './api/scheduler.js';
export { VM, vm } from './api/vm.js';
export { submitCodeHandler } from './api/submit-code-handler.js';
export type { SubmitCodePolicy } from './api/submit-code-handler.js';
export { bearerAuth, hmacAuth } from './api/auth.js';
export type { HmacAuthOptions } from './api/auth.js';
export { pickBindings } from './api/bindings.js';

// Cancellation primitive.
export { CancelToken } from './api/cancel.js';


// Purity helpers (preserved from v0.2).
export { pure, isPure, constant } from './api/primitives.js';
export type { Pure } from './api/primitives.js';

// Codegen / serialize (low-level escape hatches; most users don't need these).
export { generateWorkerSource, buildWorkerCode, DEFAULT_COMPAT_DATE } from './loader/codegen.js';
export type { WorkerCodeOptions, GenerateSourceOptions, CodegenMode } from './loader/codegen.js';
export { serializeFunction, hashSource, canonicalizeContext } from './loader/serialize.js';
export { buildCacheKey } from './loader/cache-key.js';
export type { CacheKeyStrategy } from './loader/cache-key.js';

// Topology selector (escape hatch for deterministic tests).
export { selectTopology } from './topology/selector.js';
export type { Topology, SelectorOptions } from './topology/selector.js';
export { balancedFill } from './topology/plan.js';
export type {
  TopologyName,
  TopologyPlan,
  InDoPlan,
  HybridPlan,
  TreePlan,
  LoaderOnlyPlan,
} from './topology/plan.js';

// Errors.
export {
  ParallelError,
  SerializationError,
  ReturnTooLargeError,
  DeadlineTooShortError,
  ExecutionError,
  DisconnectedError,
  OutOfMemoryError,
  BillingLimitError,
  TimeoutError,
  RetryExhaustedError,
  BindingError,
  MissingBindingError,
  CancelledError,
  DeadlineExceededError,
  BackpressureError,
  ResultExpiredError,
  ConflictError,
  TopologyError,
  PolicyRequiredError,
  AggregateExecutionError,
  errorToWire,
  wireToError,
  isParallelError,
  isBackpressureError,
  isCancelledError,
  isExecutionError,
  isAggregateExecutionError,
  isDeadlineExceededError,
  isTimeoutError,
} from './errors/index.js';
export type {
  BillingLimitKind,
  PartialResultEntry,
  ErrorCode,
  WireError,
} from './errors/index.js';

// Type re-exports for option shapes.
export type {
  PoolEnv,
  PoolOptions,
  LoaderOnlyOptions,
  ActorOptions,
  SchedulerOptions,
  VMOptions,
  SubmitOptions,
  MapOptions,
  ScatterOptions,
  PmapOptions,
  StreamOptions,
  StreamResult,
  Job,
  JobHandle,
  JobStatus,
  RetryPolicy,
  RetryBackoff,
  OnErrorStrategy,
  PoolStats,
  SchedulerStats,
  ObservabilityOptions,
  AnalyticsEngineDataset,
  WorkerCodeOptions as PublicWorkerCodeOptions,
} from './api/options.js';

// Worker Loader runtime types (until @cloudflare/workers-types ships them).
export type {
  WorkerLoader,
  WorkerCode,
  WorkerStub,
  EntrypointStub,
  EntrypointOptions,
  GetCodeCallback,
  ServiceStub,
  ModuleContent,
  WorkerCodeLimits,
  RpcEnvelope,
} from './types.js';
