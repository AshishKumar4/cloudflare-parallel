/**
 * cloudflare-parallel v0.3 — public API surface.
 *
 * Five factories under one namespace, plus the typed primitives and errors.
 * For testing fakes, import from `cloudflare-parallel/testing`.
 * For the library DO classes, import from `cloudflare-parallel/durable-objects`.
 */

export { Parallel } from './api/parallel';
export { Pool } from './api/pool';
export type { IPool, PipeFn } from './api/pool';
export { LoaderOnlyPoolImpl } from './api/loader-only-pool';
export type { LoaderOnlyPool } from './api/loader-only-pool';
export { ActorHandle } from './api/actor';
export type { IActorHandle } from './api/actor';
export { Scheduler } from './api/scheduler';
export type { IScheduler } from './api/scheduler';
export { VM, vm } from './api/vm';
export { submitCodeHandler } from './api/submit-code-handler';
export type { SubmitCodePolicy } from './api/submit-code-handler';
export { bearerAuth, hmacAuth } from './api/auth';
export type { HmacAuthOptions } from './api/auth';
export { pickBindings } from './api/bindings';

// Cancellation primitive.
export { CancelToken } from './api/cancel';

// Purity helpers.
export { pure, isPure, constant } from './api/primitives';
export type { Pure } from './api/primitives';

// Codegen / serialize (low-level escape hatches; most users don't need these).
export { generateWorkerSource, buildWorkerCode, DEFAULT_COMPAT_DATE } from './loader/codegen';
export type {
  InternalWorkerCodeOptions,
  GenerateSourceOptions,
  CodegenMode,
} from './loader/codegen';
export { serializeFunction, hashSource, canonicalizeContext } from './loader/serialize';
export { buildCacheKey } from './loader/cache-key';
export type { CacheKeyStrategy } from './loader/cache-key';

// Topology selector (escape hatch for deterministic tests).
export { selectTopology } from './topology/selector';
export type { Topology, SelectorOptions } from './topology/selector';
export { balancedFill } from './topology/plan';
export type { TopologyName, TopologyPlan, InDoPlan, HybridPlan, TreePlan } from './topology/plan';

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
  QueueFullError,
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
} from './errors/index';
export type { BillingLimitKind, PartialResultEntry, ErrorCode, WireError } from './errors/index';

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
  WorkerCodeOptions,
} from './api/options';

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
} from './types';
