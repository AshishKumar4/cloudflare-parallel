/**
 * cloudflare-parallel error hierarchy.
 *
 * Backwards-compatible from v0.2: every new error extends a v0.2 ancestor
 * so existing `instanceof` checks keep working. See DESIGN §9.1.
 *
 * Each error has:
 *   - `name`         human-readable class name (also the `code` lookup key)
 *   - `code`         stable, machine-readable ID (`CFP_*`)
 *   - `httpStatus`   recommended HTTP status when surfaced over a wire
 *   - `cause`        underlying Error (Error.cause; preserved across throws)
 *   - `toJSON()`     structured-clone-safe payload (round-trips via fromJSON)
 *
 * The wire-shape passed across DO-RPC boundaries is `WireError` (see below);
 * use `errorToWire` / `wireToError` to translate. Errors thrown from public
 * methods are real ParallelError subclasses with everything restored.
 */

/** Stable machine-readable error code prefix. */
export type ErrorCode =
  | 'CFP_PARALLEL'
  | 'CFP_SERIALIZATION'
  | 'CFP_RETURN_TOO_LARGE'
  | 'CFP_DEADLINE_TOO_SHORT'
  | 'CFP_EXECUTION'
  | 'CFP_DISCONNECTED'
  | 'CFP_OUT_OF_MEMORY'
  | 'CFP_BILLING_LIMIT'
  | 'CFP_TIMEOUT'
  | 'CFP_RETRY_EXHAUSTED'
  | 'CFP_BINDING'
  | 'CFP_MISSING_BINDING'
  | 'CFP_CANCELLED'
  | 'CFP_DEADLINE_EXCEEDED'
  | 'CFP_BACKPRESSURE'
  | 'CFP_RESULT_EXPIRED'
  | 'CFP_CONFLICT'
  | 'CFP_TOPOLOGY'
  | 'CFP_AGGREGATE_EXECUTION'
  | 'CFP_POLICY_REQUIRED';

/** JSON-safe wire shape. Round-trips via `errorToWire` / `wireToError`. */
export interface WireError {
  /** Class name (e.g. `BackpressureError`). */
  name: string;
  /** Stable machine-readable code. */
  code: ErrorCode;
  /** Human-readable message. */
  message: string;
  /** Recommended HTTP status when surfaced over HTTP. */
  httpStatus: number;
  /** Optional remote stack — best-effort, RPC may strip. */
  stack?: string;
  /** Original class name when wrapping a non-library Error. */
  originalName?: string;
  /** Class-specific extras (e.g. BillingLimitError.kind). */
  extra?: Record<string, unknown>;
  /** Cause chain (recursive). */
  cause?: WireError;
}

// --------------------------------------------------------------- root ----

export class ParallelError extends Error {
  /** Stable machine-readable code. Stable across versions. */
  readonly code: ErrorCode = 'CFP_PARALLEL';
  /** Recommended HTTP status when surfaced over a wire. Subclasses widen via `as number`. */
  readonly httpStatus: number = 500;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ParallelError';
    if (options?.cause !== undefined) {
      // Standard Error.cause; preserved by all modern runtimes.
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }

  /** JSON-safe representation. Use `wireToError` to round-trip. */
  toJSON(): WireError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      stack: this.stack,
      ...(this.extraJsonFields() ?? {}),
      cause: causeToWire(this.cause),
    };
  }

  /** Subclasses override to surface class-specific extras + originalName. */
  protected extraJsonFields(): Partial<WireError> | undefined {
    return undefined;
  }
}

function causeToWire(cause: unknown): WireError | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof ParallelError) return cause.toJSON();
  if (cause instanceof Error) {
    return {
      name: cause.name,
      code: 'CFP_EXECUTION',
      message: cause.message,
      httpStatus: 500,
      stack: cause.stack,
      originalName: cause.name,
    };
  }
  return {
    name: 'NonError',
    code: 'CFP_EXECUTION',
    message: String(cause),
    httpStatus: 500,
  };
}

// ---- serialization-class -----------------------------------------------

/**
 * Fires when a value cannot cross the structured-clone boundary into a
 * loaded isolate or back as a return value. Causes: closures over
 * non-cloneable refs, RPC stubs returned from user fns, return values
 * exceeding 32 MiB.
 *
 * **User action.** Confine fns to JSON-friendly args and returns; for
 * larger payloads, return a `ReadableStream` via `submitStream`.
 */
export class SerializationError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_SERIALIZATION';
  override readonly httpStatus: number = 400;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SerializationError';
  }
}

/** Return value structured-cloned > 32 MiB and not a stream. */
export class ReturnTooLargeError extends SerializationError {
  override readonly code: ErrorCode = 'CFP_RETURN_TOO_LARGE';
  override readonly httpStatus = 413; // payload too large
  readonly bytes: number;
  constructor(bytes: number, options?: { cause?: unknown }) {
    super(`Return value of ${bytes} bytes exceeds RPC max payload (32 MiB)`, options);
    this.name = 'ReturnTooLargeError';
    this.bytes = bytes;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { bytes: this.bytes } };
  }
}

/**
 * Deadline budget too short for the topology (sub-second deadlines or
 * tree-depth-incompatible budgets). See DESIGN §9.4 / §9.5.
 */
export class DeadlineTooShortError extends SerializationError {
  override readonly code: ErrorCode = 'CFP_DEADLINE_TOO_SHORT';
  override readonly httpStatus = 400;
  readonly budgetMs: number;
  readonly minBudgetMs: number;
  constructor(budgetMs: number, minBudgetMs: number, options?: { cause?: unknown }) {
    super(
      `Deadline budget ${budgetMs}ms is below minimum ${minBudgetMs}ms ` +
        `(may not survive coordinator clock skew + RPC overhead)`,
      options,
    );
    this.name = 'DeadlineTooShortError';
    this.budgetMs = budgetMs;
    this.minBudgetMs = minBudgetMs;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { budgetMs: this.budgetMs, minBudgetMs: this.minBudgetMs } };
  }
}

// ---- execution-class ---------------------------------------------------

/**
 * Fires when the user fn throws inside the loaded isolate. Carries the
 * remote error's `name` (as `originalName`), `message`, and `stack` —
 * RPC strips prototypes, so `instanceof` against the user's specific
 * Error subclass won't work. Compare via `originalName`.
 *
 * **User action.** Catch and inspect `originalName` / `remoteStack`.
 */
export class ExecutionError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_EXECUTION';
  override readonly httpStatus: number = 500;
  readonly remoteMessage: string;
  readonly remoteStack?: string;
  /** Original error class name when reconstructable (RPC strips prototypes). */
  readonly originalName?: string;

  constructor(
    message: string,
    opts: { remoteStack?: string; originalName?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ExecutionError';
    this.remoteMessage = message;
    this.remoteStack = opts.remoteStack;
    this.originalName = opts.originalName;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return {
      stack: this.remoteStack ?? this.stack,
      originalName: this.originalName,
    };
  }
}

/**
 * Eviction-mid-flight or workerd `abortIsolate` TODO surfaces as opaque
 * disconnection. Library auto-retries once on a fresh isolate (DESIGN §9.2).
 */
export class DisconnectedError extends ExecutionError {
  override readonly code: ErrorCode = 'CFP_DISCONNECTED';
  override readonly httpStatus = 502; // bad gateway — upstream worker died
  constructor(message = 'Dynamic worker disconnected (eviction or abortIsolate)', opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = 'DisconnectedError';
  }
}

/** V8 OOM in the loaded isolate. No retry — same memory pressure on retry. */
export class OutOfMemoryError extends ExecutionError {
  override readonly code: ErrorCode = 'CFP_OUT_OF_MEMORY';
  override readonly httpStatus = 507; // insufficient storage — closest fit
  constructor(message = 'Dynamic worker out of memory', opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = 'OutOfMemoryError';
  }
}

export type BillingLimitKind = 'cpuMs' | 'subRequests' | 'memory';

/** Production-side resource cap exceeded (cpuMs / subRequests / memory). */
export class BillingLimitError extends ExecutionError {
  override readonly code: ErrorCode = 'CFP_BILLING_LIMIT';
  override readonly httpStatus = 402; // payment required — closest fit for "limit hit"
  readonly kind: BillingLimitKind;
  constructor(kind: BillingLimitKind, message?: string, opts?: { cause?: unknown }) {
    super(message ?? `Billing limit exceeded: ${kind}`, opts);
    this.name = 'BillingLimitError';
    this.kind = kind;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { kind: this.kind }, originalName: this.originalName };
  }
}

// ---- timeout / retry / binding (preserved from v0.2) -------------------

/**
 * Fires when a task exceeds its `timeout` budget (wall-clock from
 * dispatch). Different from {@link DeadlineExceededError}, which is an
 * absolute epoch deadline. Retries respect the original budget.
 *
 * **User action.** Increase `timeout` or break work into smaller submits.
 */
export class TimeoutError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_TIMEOUT';
  override readonly httpStatus = 504; // gateway timeout
  readonly deadlineMs: number;
  constructor(deadlineMs: number, options?: { cause?: unknown }) {
    super(`Task exceeded ${deadlineMs}ms wall-clock timeout`, options);
    this.name = 'TimeoutError';
    this.deadlineMs = deadlineMs;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { deadlineMs: this.deadlineMs } };
  }
}

/**
 * Fires when all retry attempts have been consumed. The original
 * failure is on `.cause`; the count is on `.attempts`.
 *
 * **User action.** Inspect `.lastError` for the underlying cause; if
 * transient (network), increase `retries`; if persistent, fix the fn.
 */
export class RetryExhaustedError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_RETRY_EXHAUSTED';
  override readonly httpStatus = 503;
  readonly lastError: Error;
  readonly attempts: number;
  constructor(attempts: number, lastError: Error) {
    super(`Task failed after ${attempts} attempt(s): ${lastError.message}`, { cause: lastError });
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { attempts: this.attempts } };
  }
}

/**
 * Fires when the runtime can't find a required binding (Worker Loader,
 * Coordinator DO, etc.) or when the user passes an unsupported binding
 * (e.g. attempts to forward a library-internal `Cfp*` DO).
 *
 * **User action.** Add the binding to wrangler.toml; for missing
 * bindings the {@link MissingBindingError} subclass tells you which one.
 * Run `npx cloudflare-parallel doctor` to scaffold the right config.
 */
export class BindingError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_BINDING';
  override readonly httpStatus = 500;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BindingError';
  }
}

/**
 * Compat shim throws this when v0.2 → v0.3 migration is incomplete (the
 * `CfpCoordinator` DO binding is missing). See MIGRATION §7.
 */
export class MissingBindingError extends BindingError {
  override readonly code: ErrorCode = 'CFP_MISSING_BINDING';
  readonly bindingName: string;
  constructor(bindingName: string, options?: { cause?: unknown }) {
    super(
      `Required binding '${bindingName}' is missing. ` +
        `Run 'cloudflare-parallel doctor' to scaffold wrangler.toml.`,
      options,
    );
    this.name = 'MissingBindingError';
    this.bindingName = bindingName;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { bindingName: this.bindingName } };
  }
}

// ---- new in v0.3 -------------------------------------------------------

/**
 * Fires when a `CancelToken` is fired while a task is in flight. The
 * task's `env.signal.aborted` becomes true; pending awaits inside the
 * loaded isolate reject with `signal.reason` (this `CancelledError`).
 *
 * Caller-side, the surfaces are immediate (the coordinator races
 * against the token). The loaded isolate may continue to run until its
 * cpuMs / wall budget elapses — observe via the `taskOrphan` event.
 *
 * **User action.** Cooperative pattern: `env.signal.throwIfAborted()`
 * inside long-running loops; `fetch(url, { signal: env.signal })` for
 * IO. The runtime cannot terminate sync infinite loops.
 */
export class CancelledError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_CANCELLED';
  override readonly httpStatus = 499; // client closed request
  readonly reason?: string;
  constructor(reason?: string, options?: { cause?: unknown }) {
    super(reason ? `Cancelled: ${reason}` : 'Cancelled', options);
    this.name = 'CancelledError';
    this.reason = reason;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { reason: this.reason } };
  }
}

/**
 * Fires when an absolute `deadline` (epoch ms) elapses before the task
 * completes. Distinct from {@link TimeoutError}, which is wall-clock
 * from dispatch. Deadlines propagate end-to-end as a structured-clone
 * cookie on the RPC envelope; sub-coordinators race the remaining
 * budget. **No retry** — re-running won't fit in the budget.
 *
 * **User action.** Choose deadlines that account for tree depth (each
 * level eats a few ms of RPC overhead).
 */
export class DeadlineExceededError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_DEADLINE_EXCEEDED';
  override readonly httpStatus = 504;
  readonly deadlineEpochMs: number;
  constructor(deadlineEpochMs: number, options?: { cause?: unknown }) {
    super(`Deadline exceeded (target=${new Date(deadlineEpochMs).toISOString()})`, options);
    this.name = 'DeadlineExceededError';
    this.deadlineEpochMs = deadlineEpochMs;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { deadlineEpochMs: this.deadlineEpochMs } };
  }
}

/**
 * Runtime saturation: 50/owner LRU / per-isolate cap miscount /
 * "Too many concurrent dynamic workers". Retry-eligible with jittered
 * exponential backoff (DESIGN §9.2 + ADR-14).
 */
export class BackpressureError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_BACKPRESSURE';
  override readonly httpStatus = 503;
  readonly retryAfterMs: number;
  constructor(message = 'Runtime backpressure', retryAfterMs = 100, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BackpressureError';
    this.retryAfterMs = retryAfterMs;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { retryAfterMs: this.retryAfterMs } };
  }
}

/** Scheduler result fetched after `resultRetention.ttlMs` expired. */
export class ResultExpiredError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_RESULT_EXPIRED';
  override readonly httpStatus = 410; // gone
  readonly jobId: string;
  constructor(jobId: string, options?: { cause?: unknown }) {
    super(`Job ${jobId} result expired (TTL elapsed before result() was called)`, options);
    this.name = 'ResultExpiredError';
    this.jobId = jobId;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return { extra: { jobId: this.jobId } };
  }
}

/** Compare-and-swap predicate failure on scheduler ops. */
export class ConflictError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_CONFLICT';
  override readonly httpStatus = 409;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConflictError';
  }
}

/** Topology pinned beyond its valid size range. */
export class TopologyError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_TOPOLOGY';
  override readonly httpStatus = 400;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TopologyError';
  }
}

/**
 * Required when calling `pool.handle(...)` to make security choices explicit.
 * The library has no default that lets you accept submitted code
 * without authentication — `policy` is mandatory at construction.
 */
export class PolicyRequiredError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_POLICY_REQUIRED';
  override readonly httpStatus = 500;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PolicyRequiredError';
  }
}

export interface PartialResultEntry {
  ok: boolean;
  value?: unknown;
  error?: ParallelError;
}

/**
 * Multi-error fan-out under default `onError: 'throw'`.
 * Carries `partialResults` so completed siblings survive on the error object
 * (DESIGN §9.1, ADR-13). Single-error case throws the plain ParallelError.
 */
export class AggregateExecutionError extends ParallelError {
  override readonly code: ErrorCode = 'CFP_AGGREGATE_EXECUTION';
  override readonly httpStatus = 500;
  readonly errors: ReadonlyMap<number, ParallelError>;
  readonly partialResults: ReadonlyMap<number, unknown>;
  constructor(
    errors: Map<number, ParallelError>,
    partialResults: Map<number, unknown>,
  ) {
    const first = errors.values().next().value;
    super(`${errors.size} task(s) failed: ${first?.message ?? '(unknown)'}`);
    this.name = 'AggregateExecutionError';
    this.errors = errors;
    this.partialResults = partialResults;
  }
  protected override extraJsonFields(): Partial<WireError> {
    return {
      extra: {
        errorEntries: [...this.errors.entries()].map(([idx, err]) => ({
          index: idx,
          error: err.toJSON(),
        })),
        partialResultEntries: [...this.partialResults.entries()].map(([idx, value]) => ({
          index: idx,
          value,
        })),
      },
    };
  }
}

// --------------------------------------------- wire <-> error round-trip

/**
 * Reconstruct a typed library error from its `WireError` shape.
 * Used by the RPC layer (where DO RPC strips Error prototypes) and by
 * `Pool.handle` HTTP responses.
 */
export function wireToError(wire: WireError): ParallelError {
  const cause = wire.cause ? wireToError(wire.cause) : undefined;
  const extra = (wire.extra ?? {}) as Record<string, unknown>;
  switch (wire.code) {
    case 'CFP_CANCELLED':
      return new CancelledError((extra.reason as string | undefined) ?? wire.message, { cause });
    case 'CFP_DEADLINE_EXCEEDED':
      return new DeadlineExceededError((extra.deadlineEpochMs as number) ?? 0, { cause });
    case 'CFP_TIMEOUT':
      return new TimeoutError((extra.deadlineMs as number) ?? 0, { cause });
    case 'CFP_BACKPRESSURE':
      return new BackpressureError(wire.message, (extra.retryAfterMs as number) ?? 100, { cause });
    case 'CFP_DISCONNECTED':
      return new DisconnectedError(wire.message, { cause });
    case 'CFP_OUT_OF_MEMORY':
      return new OutOfMemoryError(wire.message, { cause });
    case 'CFP_BILLING_LIMIT':
      return new BillingLimitError((extra.kind as BillingLimitKind) ?? 'cpuMs', wire.message, { cause });
    case 'CFP_RETURN_TOO_LARGE':
      return new ReturnTooLargeError((extra.bytes as number) ?? 0, { cause });
    case 'CFP_DEADLINE_TOO_SHORT':
      return new DeadlineTooShortError(
        (extra.budgetMs as number) ?? 0,
        (extra.minBudgetMs as number) ?? 1000,
        { cause },
      );
    case 'CFP_SERIALIZATION':
      return new SerializationError(wire.message, { cause });
    case 'CFP_RESULT_EXPIRED':
      return new ResultExpiredError((extra.jobId as string) ?? '', { cause });
    case 'CFP_CONFLICT':
      return new ConflictError(wire.message, { cause });
    case 'CFP_TOPOLOGY':
      return new TopologyError(wire.message, { cause });
    case 'CFP_RETRY_EXHAUSTED': {
      const inner = cause instanceof Error ? cause : new Error(wire.message);
      return new RetryExhaustedError((extra.attempts as number) ?? 1, inner);
    }
    case 'CFP_BINDING':
      return new BindingError(wire.message, { cause });
    case 'CFP_MISSING_BINDING':
      return new MissingBindingError((extra.bindingName as string) ?? 'unknown', { cause });
    case 'CFP_POLICY_REQUIRED':
      return new PolicyRequiredError(wire.message, { cause });
    case 'CFP_AGGREGATE_EXECUTION': {
      const errMap = new Map<number, ParallelError>();
      const partMap = new Map<number, unknown>();
      const ee = (extra.errorEntries as Array<{ index: number; error: WireError }> | undefined) ?? [];
      const pe = (extra.partialResultEntries as Array<{ index: number; value: unknown }> | undefined) ?? [];
      for (const { index, error } of ee) errMap.set(index, wireToError(error));
      for (const { index, value } of pe) partMap.set(index, value);
      return new AggregateExecutionError(errMap, partMap);
    }
    case 'CFP_EXECUTION':
    default:
      return new ExecutionError(wire.message, {
        remoteStack: wire.stack,
        originalName: wire.originalName ?? wire.name,
        cause,
      });
  }
}

/**
 * Convert any value into a `WireError`. ParallelError instances pass through
 * via `.toJSON()`; non-library Errors are wrapped as ExecutionError-shaped
 * wire entries with `originalName` preserved.
 */
export function errorToWire(err: unknown): WireError {
  if (err instanceof ParallelError) return err.toJSON();
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    name: e.name || 'Error',
    code: 'CFP_EXECUTION',
    message: e.message ?? '',
    httpStatus: 500,
    stack: e.stack,
    originalName: e.name === 'Error' ? undefined : e.name,
  };
}

// ---- type guards -------------------------------------------------
//
// Library users can `instanceof` any of the exported classes; these guards
// are convenience wrappers that also narrow correctly when the error has
// crossed an RPC boundary and lost its prototype (we fall back to comparing
// `code` in that case). Use these in error-handling chains:
//
// ```ts
// try { await pool.submit(fn); }
// catch (err) {
//   if (isBackpressureError(err)) await sleep(err.retryAfterMs);
//   else if (isCancelledError(err)) return;
//   else throw err;
// }
// ```

/** True for any library-emitted error (preserves type narrowing). */
export function isParallelError(err: unknown): err is ParallelError {
  if (err instanceof ParallelError) return true;
  return Boolean(
    err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' && /^CFP_/.test((err as { code: string }).code),
  );
}

/** True when the error is the `BackpressureError` class (or a wire copy). */
export function isBackpressureError(err: unknown): err is BackpressureError {
  return (
    err instanceof BackpressureError ||
    (isParallelError(err) && (err as ParallelError).code === 'CFP_BACKPRESSURE')
  );
}

/** True when cancel fired. Prefer `signal.aborted` inside user fns. */
export function isCancelledError(err: unknown): err is CancelledError {
  return (
    err instanceof CancelledError ||
    (isParallelError(err) && (err as ParallelError).code === 'CFP_CANCELLED')
  );
}

/** True for any user-fn-thrown error surfaced through the library. */
export function isExecutionError(err: unknown): err is ExecutionError {
  return (
    err instanceof ExecutionError ||
    (isParallelError(err) &&
      ['CFP_EXECUTION', 'CFP_DISCONNECTED', 'CFP_OUT_OF_MEMORY', 'CFP_BILLING_LIMIT'].includes(
        (err as ParallelError).code,
      ))
  );
}

/** True when a fan-out fails with `onError: 'throw' | 'throw-fast'`. */
export function isAggregateExecutionError(
  err: unknown,
): err is AggregateExecutionError {
  return (
    err instanceof AggregateExecutionError ||
    (isParallelError(err) && (err as ParallelError).code === 'CFP_AGGREGATE_EXECUTION')
  );
}

/** True when an absolute deadline elapsed. No retry. */
export function isDeadlineExceededError(err: unknown): err is DeadlineExceededError {
  return (
    err instanceof DeadlineExceededError ||
    (isParallelError(err) && (err as ParallelError).code === 'CFP_DEADLINE_EXCEEDED')
  );
}

/** True when a wall-clock timeout elapsed (relative to dispatch). */
export function isTimeoutError(err: unknown): err is TimeoutError {
  return (
    err instanceof TimeoutError ||
    (isParallelError(err) && (err as ParallelError).code === 'CFP_TIMEOUT')
  );
}
