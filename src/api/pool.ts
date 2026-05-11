import type { ParallelError } from '../errors/index';
import { BindingError, MissingBindingError } from '../errors/index';
import type {
  InProcessCoordinatorBinding,
  MapOptions,
  OnErrorStrategy,
  PmapOptions,
  PoolEnv,
  PoolOptions,
  PoolStats,
  ScatterOptions,
  StreamOptions,
  StreamResult,
  SubmitOptions,
} from './options';
import type { CancelToken } from './cancel';
import { hashSource, serializeFunction } from '../loader/serialize';
import { runFanOut } from './fan-out';
import { mergeContext } from './context-merge';
import { splitSubmitOptions } from './loader-only-pool';
import type { UserFn } from './user-fn';
import type {
  CoordinatorFanOutRequest,
  CoordinatorRunRequest,
  DispatchEnvelope,
  RunOneRequest,
  RunOneResult,
} from '../coordinator/protocol';
import {
  getStub,
  locationHintForColo,
  workerOptionsToWire,
  type LocationHint,
} from '../coordinator/internal';
import { dispatchWithResilience } from '../transport/rpc-client';
import { buildEnvelope } from '../transport/deadline-prop';
import { createCancelStream } from '../transport/cancel-stream';
import { deferred, type Deferred } from '../internal/deferred';
import { emitObservabilityEvent } from '../observability/index';
import { assertNoLibraryInternalBindings } from '../loader/sandbox';
import { leafErrorToTypedError } from './error-decode';
import { submitCodeHandler, type SubmitCodePolicy } from './submit-code-handler';
import { pickBindings } from './bindings';

const DEFAULT_COORDINATOR_NAME = 'cfp:default';

interface FanOutResponse {
  results: RunOneResult[];
  topology: 'in-do' | 'hybrid' | 'tree';
  fanOutPerLevel: number[];
  treeDepth: number;
}

interface CoordinatorStub {
  runOne(req: CoordinatorRunRequest): Promise<RunOneResult>;
  runMany(req: CoordinatorFanOutRequest): Promise<FanOutResponse>;
  noop(): Promise<void>;
  actorEnsureInitialized(initialState: unknown): Promise<void>;
  actorSubmit(req: {
    fnSource: string;
    fnHash: string;
    args: unknown[];
    context?: Record<string, unknown>;
    workerOptions?: RunOneRequest['workerOptions'];
    cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
    envelope: DispatchEnvelope;
  }): Promise<RunOneResult>;
  actorClose(): Promise<void>;
}

/** Minimal type to abstract over real DO stubs and testing fakes. */
interface DurableObjectStubLike {
  runOne(req: CoordinatorRunRequest): Promise<RunOneResult>;
  runMany(req: CoordinatorFanOutRequest): Promise<FanOutResponse>;
}

/**
 * Loopback target for the single-job dispatch path
 * (`ctx.exports.CfpInProcessCoordinator`). Same call shape as the DO
 * Coordinator, but the runtime keeps the call inside the same Worker
 * process — no DO routing, no Cap'n Proto over the network. Honored
 * when the user supplies `inProcess: ctx.exports.CfpInProcessCoordinator`
 * via {@link PoolOptions}.
 *
 * Only `submit()` and `pool.map([x], fn)` (size = 1) use this path.
 * Fan-outs of size ≥ 2 always route through the Coordinator DO because
 * CPU parallelism requires one job per leaf DO process — loaders inside
 * a single workerd process (loopback or otherwise) share that process's
 * V8 scheduler thread and serialize on CPU.
 */
const IN_PROCESS_THRESHOLD = 1;

/**
 * Public Pool interface — implemented by both {@link Pool} (the production
 * class) and the testing fake (`Parallel.testing.poolFake`). Library users
 * who want to write code against either backend can type their reference
 * as `IPool<B, C>`.
 *
 * The class methods on `Pool` are the canonical signatures; this interface
 * mirrors them.
 */
export interface IPool<
  B extends Record<string, unknown> = Record<string, unknown>,
  C extends Record<string, unknown> = Record<string, unknown>,
> {
  submit<A extends unknown[], R>(
    fn: (...args: [...A, B & { signal: AbortSignal }]) => R | Promise<R>,
    ...rest: [...A] | [...A, SubmitOptions]
  ): Promise<Awaited<R>>;
  /**
   * Run a function from its source string. Skips `Function.prototype.toString()`
   * in the parent Worker — used by the HTTP submit-code surface where the
   * user posted the source directly. The loader is the platform-sanctioned
   * path for dynamic code; `eval` is disabled in the Workers runtime by default.
   */
  submitSource<R>(fnSource: string, args: unknown[], opts?: SubmitOptions): Promise<R>;
  map<T, R>(
    fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    opts?: MapOptions,
  ): Promise<Awaited<R>[]>;
  reduce<T>(
    fn: (a: T, b: T, env: B & { signal: AbortSignal }) => T | Promise<T>,
    items: T[],
    initial: T,
  ): Promise<Awaited<T>>;
  scatter<T, R>(
    fn: (items: T[], env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    chunks: number,
    opts?: ScatterOptions,
  ): Promise<Awaited<R>[]>;
  gather<T>(promises: Promise<T>[]): Promise<T[]>;
  pmap<T, R>(
    fn: (batch: T[], env: B & { signal: AbortSignal }) => R[] | Promise<R[]>,
  ): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]>;
  pipe: PipeFn;
  mapStream<T, R>(
    fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamResult<Awaited<R>>>;
  mapOrdered<T, R>(
    fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<Awaited<R>>;
  submitStream<A extends unknown[], R>(
    fn: (
      ...args: [...A, B & { signal: AbortSignal }]
    ) => ReadableStream<R> | Promise<ReadableStream<R>>,
    ...rest: [...A] | [...A, SubmitOptions]
  ): Promise<ReadableStream<R>>;
  warm(opts?: { isolates?: number }): Promise<void>;
  drain(): Promise<void>;
  stats(): Promise<PoolStats>;
  handle(opts: {
    policy: SubmitCodePolicy<B>;
    parse?: (req: Request) => Promise<{ fn: string; args: unknown[]; options?: SubmitOptions }>;
    format?: (result: unknown) => Response;
  }): (req: Request) => Promise<Response>;
  restrictTo(allow: ReadonlyArray<string>): IPool<B, C>;
}

export interface PipeFn {
  <A, B>(
    f1: (a: A, env: { signal: AbortSignal }) => B | Promise<B>,
  ): (input: A) => Promise<Awaited<B>>;
  <A, B, C>(
    f1: (a: A, env: { signal: AbortSignal }) => B | Promise<B>,
    f2: (b: Awaited<B>, env: { signal: AbortSignal }) => C | Promise<C>,
  ): (input: A) => Promise<Awaited<C>>;
  <A, B, C, D>(
    f1: (a: A, env: { signal: AbortSignal }) => B | Promise<B>,
    f2: (b: Awaited<B>, env: { signal: AbortSignal }) => C | Promise<C>,
    f3: (c: Awaited<C>, env: { signal: AbortSignal }) => D | Promise<D>,
  ): (input: A) => Promise<Awaited<D>>;
  <A, B, C, D, E>(
    f1: (a: A, env: { signal: AbortSignal }) => B | Promise<B>,
    f2: (b: Awaited<B>, env: { signal: AbortSignal }) => C | Promise<C>,
    f3: (c: Awaited<C>, env: { signal: AbortSignal }) => D | Promise<D>,
    f4: (d: Awaited<D>, env: { signal: AbortSignal }) => E | Promise<E>,
  ): (input: A) => Promise<Awaited<E>>;
}

/**
 * Stateless façade over a Coordinator DO. Submitting fns goes:
 * `Pool` → `CfpCoordinator` (DO) → Worker Loader isolate.
 *
 * **Cancellation.** Cancel is always via `SubmitOptions.cancel: CancelToken`.
 * There is no `pool.cancel(...)` — the token is the single mechanism. The
 * token's `signal` is forwarded as a real `AbortSignal` end-to-end via a
 * `ReadableStream` (caller → coordinator → child DO → loaded isolate).
 * User fns observe `env.signal.aborted` synchronously; pending awaits
 * reject with `signal.reason`.
 *
 * **Topology selection.** `submit` always uses in-DO. `map` / `scatter`
 * / `reduce` / `pmap` auto-select between in-DO (≤4 items), hybrid
 * (≤16), and tree (recursive sub-coordinators). See
 * {@link PoolStats.topology}.
 *
 * **Bindings.** Pass `bindings:` at construction. They are forwarded to
 * the loaded isolate's `env`. Library-internal DO bindings
 * (`CfpCoordinator`, `CfpWorkerDO`, etc.) are hard-blocklisted from
 * forwarding regardless of what the user passes.
 *
 * @typeParam B user-bindings shape (e.g. `{ AI: Ai; KV: KVNamespace }`).
 * @typeParam C reserved for context-shape generic.
 */
export class Pool<
  B extends Record<string, unknown>,
  C extends Record<string, unknown>,
> implements IPool<B, C> {
  readonly #env: PoolEnv;
  readonly #opts: PoolOptions<B, C>;
  readonly #coordinatorName: string;

  // Observability counters.
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #inFlight = 0;
  readonly #fnShapesToday = new Set<string>();
  #lastTopologyDecisionAt = 0;
  #lastFanOutPerLevel: number[] = [];
  #lastTreeDepth = 1;
  #lastTopology: 'in-do' | 'hybrid' | 'tree' | undefined;
  #lruEvictionLast60s: number[] = [];
  /** Resolved when `#inFlight` next reaches 0; reset on next submit. */
  #drainBarrier: Deferred<void> | undefined;

  /**
   * Resolved `locationHint` for this Pool. Either set explicitly via
   * `opts.locationHint`, derived from `opts.requestColo`, or `undefined`
   * (in which case the runtime picks placement on first DO access).
   */
  readonly #locationHint: LocationHint | undefined;
  readonly #inProcess: InProcessCoordinatorBinding | undefined;

  /**
   * Auto-warm: when the first fan-out / submit lands, fire a `noop()` to
   * the Coordinator DO in parallel with the real dispatch. The Coordinator
   * DO's own RPC handler does the same for leaf DOs. Validated 14×–140×
   * cold-path speedup at zero cost (parallelized).
   */
  readonly #autoWarm: boolean;
  /**
   * One-shot promise that resolves after the first prewarm dispatch
   * fires. Subsequent calls await it as a no-op so they don't re-prewarm
   * a hot pool.
   */
  #prewarmFlight: Promise<void> | undefined;

  constructor(env: PoolEnv, opts: PoolOptions<B, C> = {}) {
    if (!env.LOADER || typeof env.LOADER.get !== 'function') {
      throw new BindingError(
        'Parallel.pool() requires a Worker Loader binding. ' +
          'Add `[[worker_loaders]]\\nbinding = "LOADER"` to wrangler.toml.',
      );
    }
    if (!env.CfpCoordinator) {
      throw new MissingBindingError('CfpCoordinator');
    }
    // Surface user mistakes (passing Cfp* DOs in bindings:) at construction
    // time, before any submit. The dispatch layer also strips them — this
    // is defense in depth + a clear error message.
    if (opts.bindings) {
      assertNoLibraryInternalBindings(opts.bindings as Record<string, unknown>);
    }
    this.#env = env;
    this.#opts = opts;
    this.#coordinatorName = opts.coordinatorId ?? DEFAULT_COORDINATOR_NAME;
    this.#locationHint = opts.locationHint ?? locationHintForColo(opts.requestColo);
    this.#inProcess = opts.inProcess;
    this.#autoWarm = opts.autoWarm ?? true;
  }

  /**
   * Fire a prewarm in parallel with the first real dispatch. Returns the
   * in-flight promise (or starts one) so concurrent callers share a
   * single prewarm round-trip.
   *
   * Two paths depending on what's wired:
   *
   * - **DO path** (default): send `noop()` to the Coordinator DO. The
   *   first call after a quiescence pays the ~300–400 ms DO cold-start;
   *   firing noop in parallel with the real dispatch absorbs that cost
   *   off the critical path.
   * - **Loopback path** (`inProcess` set): there's no DO to warm, but
   *   the loaded isolate inside the loopback still pays the loader
   *   cold-start on first call. Fire a single no-op `runOne` through
   *   the loopback to spin up the isolate. Subsequent calls reuse it
   *   via the stable cache key. Without this, every "first call after
   *   idle" in the loopback path paid full cold-start, surfacing as
   *   run-to-run inconsistency (the user-reported "the numbers change
   *   every time I refresh" complaint).
   *
   * The prewarm is fire-and-forget at the call sites (`void
   * this.#ensurePrewarm()`) so it never serializes the real dispatch.
   *
   * @param force when `true`, fires the prewarm even if `autoWarm: false`.
   *   Used by `Pool.warm()` (explicit user request). The dispatch path
   *   uses `force: false` so `autoWarm: false` opts out of automatic prewarm.
   */
  #ensurePrewarm(force = false): Promise<void> {
    if (!force && !this.#autoWarm) return Promise.resolve();
    if (this.#prewarmFlight) return this.#prewarmFlight;
    if (this.#inProcess) {
      // Loopback path: prime the loaded isolate with a tiny no-op
      // submit. The fn returns `undefined` and has zero CPU; the only
      // work is the loader-isolate spin-up, which is exactly what we
      // want to pay off the critical path.
      this.#prewarmFlight = this.#primeInProcessIsolate();
      return this.#prewarmFlight;
    }
    const stub = this.#stub();
    this.#prewarmFlight = (async () => {
      try {
        await stub.noop();
      } catch {
        // Prewarm is best-effort. The real dispatch will surface any
        // genuine connectivity issue immediately afterwards.
      }
    })();
    return this.#prewarmFlight;
  }

  /**
   * Loopback-path prewarm: fire a single no-op `runOne` so the
   * Worker Loader spins the isolate up. We bypass `pool.submit` (which
   * would loop back through `#ensurePrewarm` and deadlock) and bypass
   * resilience wrapping (a single timeout-free best-effort call is the
   * right shape for prewarm). The fn's source is the no-op `() => 0`;
   * it pays zero user-fn CPU. Errors are swallowed — same best-effort
   * contract as the DO `noop()` path.
   */
  async #primeInProcessIsolate(): Promise<void> {
    if (!this.#inProcess) return;
    const fnSource = '() => 0';
    const fnHash = hashSource(fnSource);
    const envelope = buildEnvelope({
      cancel: undefined,
      deadline: undefined,
      deadlineMs: undefined,
      mode: 'pool-fn',
    });
    try {
      await this.#inProcess.runOne({
        fnSource,
        fnHash,
        args: [],
        cacheKeyStrategy: this.#opts.cacheKeyStrategy ?? 'stable',
        // Borrow the user's workerOptions so the prewarmed isolate
        // matches the shape of the real dispatches. Without this, the
        // first real call would still cache-miss and pay cold-start.
        workerOptions: workerOptionsToWire({
          compatibilityDate: this.#opts.workerOptions?.compatibilityDate,
          compatibilityFlags: this.#opts.workerOptions?.compatibilityFlags,
          globalOutbound:
            this.#opts.globalOutbound !== undefined
              ? this.#opts.globalOutbound
              : this.#opts.workerOptions?.globalOutbound,
          limits: this.#opts.limits ?? this.#opts.workerOptions?.limits,
          tailBindingName: this.#opts.observability?.tail?.bindingName,
        }),
        envelope,
      });
    } catch {
      // Best-effort prewarm. Real dispatches surface genuine errors.
    }
  }

  // ---- internal helpers ---------------------------------------------

  /**
   * Cached Coordinator-DO stub. The coordinator name and locationHint
   * are constant per `Pool` instance, so `idFromName` (SHA-256 over
   * the name) + `ns.get` is paid once per pool. See
   * `/workspace/perf-audit-findings.md` § F12.
   */
  #cachedStub: (CoordinatorStub & DurableObjectStubLike) | undefined;

  #stub(): CoordinatorStub & DurableObjectStubLike {
    if (this.#cachedStub) return this.#cachedStub;
    const ns = this.#env.CfpCoordinator!;
    // `locationHint` is best-effort and only honored on first access —
    // the runtime types vary across versions, so the cast lives behind
    // `getStub`'s `as unknown as` shim.
    this.#cachedStub = getStub<CoordinatorStub & DurableObjectStubLike>(
      ns,
      this.#coordinatorName,
      this.#locationHint,
    );
    return this.#cachedStub;
  }

  /**
   * Pick the dispatch target for a single-shot submit. When the user
   * has wired up `inProcess: ctx.exports.CfpInProcessCoordinator`,
   * `submit(...)` calls (and `pool.map` of exactly size = 1) route
   * through the loopback (no DO RPC). Otherwise they route through the
   * Coordinator DO stub.
   */
  #runOneTarget(): DurableObjectStubLike {
    if (this.#inProcess) {
      return this.#inProcess as unknown as DurableObjectStubLike;
    }
    return this.#stub();
  }

  /**
   * Pick the dispatch target for a fan-out of `size` items. Same logic as
   * {@link Pool.#runOneTarget}, but the in-process path is only valid when
   * the pool has not pinned a `topology` that requires the DO tree (e.g.
   * `'hybrid'` / `'tree'` always need the Coordinator DO).
   */
  #runManyTarget(size: number): DurableObjectStubLike {
    const pinned = this.#opts.topology;
    const canLoopback =
      this.#inProcess !== undefined &&
      size > 0 &&
      size <= IN_PROCESS_THRESHOLD &&
      (pinned === undefined || pinned === 'auto' || pinned === 'in-do');
    if (canLoopback) {
      return this.#inProcess as unknown as DurableObjectStubLike;
    }
    return this.#stub();
  }

  /**
   * Memoize per fn reference. Repeated `pool.submit(sameFn, x)` calls
   * recompute neither `fn.toString()` nor `hashSource()`. Bounded by the
   * lifetime of the user's fn references — WeakMap doesn't pin them.
   *
   */
  #serializeCache = new WeakMap<UserFn, { fnSource: string; fnHash: string }>();

  #serialize(fn: UserFn): { fnSource: string; fnHash: string } {
    const cached = this.#serializeCache.get(fn);
    if (cached) {
      this.#fnShapesToday.add(cached.fnHash);
      return cached;
    }
    const fnSource = serializeFunction(fn);
    const fnHash = hashSource(fnSource);
    this.#fnShapesToday.add(fnHash);
    const entry = { fnSource, fnHash };
    this.#serializeCache.set(fn, entry);
    return entry;
  }

  #mergeContext(perCall?: Record<string, unknown>): Record<string, unknown> | undefined {
    return mergeContext(this.#opts.context as Record<string, unknown> | undefined, perCall);
  }

  #selector(): CoordinatorFanOutRequest['selector'] {
    return {
      topology: this.#opts.topology,
      maxFanOut: this.#opts.maxFanOut,
      branchingFactor: this.#opts.branchingFactor,
      treeThreshold: this.#opts.treeThreshold,
    };
  }

  // ---- single-shot submit -------------------------------------------

  /**
   * Run `fn` once on a freshly-loaded isolate.
   *
   * The function source is serialized (`Function.prototype.toString`),
   * dispatched to the coordinator DO, and executed in a Worker Loader
   * isolate. The trailing argument is `env` — the isolate-side
   * `bindings & { signal: AbortSignal }`. `signal` reflects the caller's
   * `SubmitOptions.cancel` token; user fns should `signal.throwIfAborted()`
   * inside long-running loops to short-circuit cleanly.
   *
   * @param fn user function. Pure JS by serialization; closures over outer
   *   variables WILL silently lose them — only what's reachable from
   *   `args` and `bindings` is in scope.
   * @param rest positional args optionally followed by a {@link SubmitOptions}
   *   bag. The bag is detected by shape (only allowed keys present).
   * @returns the user fn's resolved return value (`structuredClone`-safe).
   * @throws ExecutionError when the user fn throws; CancelledError when
   *   the cancel token fires; DeadlineExceededError when the deadline
   *   elapses before completion; BackpressureError when LRU thrash forces
   *   retry exhaustion.
   */
  async submit<A extends unknown[], R>(
    fn: (...args: [...A, B & { signal: AbortSignal }]) => R | Promise<R>,
    ...rest: [...A] | [...A, SubmitOptions]
  ): Promise<Awaited<R>> {
    const { args, opts } = splitSubmitOptions(rest);
    return this.#runOne<Awaited<R>>(fn, args, opts);
  }

  async #runOne<R>(fn: UserFn, args: unknown[], opts: SubmitOptions | undefined): Promise<R> {
    const { fnSource, fnHash } = this.#serialize(fn);
    return this.#runOneSource<R>(fnSource, fnHash, args, opts);
  }

  /**
   * Dispatch a pre-serialized function source. Used by `submitCodeHandler`
   * (HTTP submit-code) to avoid round-tripping through `eval` in the
   * parent Worker — the Workers runtime disables `eval` by default. The source is
   * passed straight to the loader, which is the platform-sanctioned path
   * for dynamic code.
   *
   * @internal
   */
  async submitSource<R>(fnSource: string, args: unknown[], opts?: SubmitOptions): Promise<R> {
    const fnHash = hashSource(fnSource);
    this.#fnShapesToday.add(fnHash);
    return this.#runOneSource<R>(fnSource, fnHash, args, opts);
  }

  async #runOneSource<R>(
    fnSource: string,
    fnHash: string,
    args: unknown[],
    opts: SubmitOptions | undefined,
  ): Promise<R> {
    const envelope = buildEnvelope({
      cancel: opts?.cancel,
      deadline: opts?.deadline,
      deadlineMs: opts?.deadlineMs,
      mode: 'pool-fn',
    });

    const taskId = `${fnHash}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startTs = Date.now();
    const obs = this.#opts.observability;
    const topology = this.#lastTopology ?? 'in-do';
    let retryCount = 0;
    emitObservabilityEvent(obs, {
      kind: 'taskStart',
      payload: { ts: startTs, poolId: this.#coordinatorName, taskId, topology, fnHash },
    });

    // Live cancel transport. Build a fresh ReadableStream per dispatch and
    // wire the user's CancelToken to write a single chunk on cancel. The
    // stream traverses caller -> Coordinator DO -> [child DO] -> loaded
    // isolate, where it drives a real AbortController.
    const cancelWriter = opts?.cancel ? createCancelStream() : undefined;
    if (cancelWriter && opts?.cancel) {
      const tok = opts.cancel;
      if (tok.isCancelled) {
        cancelWriter.cancel(tok.poll().reason);
      } else {
        // `onCancel` is one-shot — the registered handler is removed
        // automatically after firing — so we don't need to unsubscribe.
        tok.onCancel(() => cancelWriter.cancel(tok.poll().reason));
      }
    }

    // Single-shot submits go through the in-process loopback when wired up
    // (skipping the DO hop). Fan-outs use a different target picker —
    // see `#runManyTarget`.
    const target = this.#runOneTarget();
    // Fire prewarm in parallel with the real dispatch. The prewarm
    // promise is shared across concurrent calls so a hot pool doesn't
    // re-prewarm on every submit. No-op when `autoWarm: false` or when
    // the in-process loopback is in play (no DO to warm).
    void this.#ensurePrewarm();
    let errorEmitted = false;
    this.#inFlightInc(1);
    try {
      const result = await dispatchWithResilience<RunOneResult>(
        () =>
          target.runOne({
            fnSource,
            fnHash,
            args,
            context: this.#mergeContext(opts?.context),
            cacheKeyStrategy: this.#opts.cacheKeyStrategy ?? 'stable',
            workerOptions: workerOptionsToWire({
              compatibilityDate: this.#opts.workerOptions?.compatibilityDate,
              compatibilityFlags: this.#opts.workerOptions?.compatibilityFlags,
              globalOutbound:
                this.#opts.globalOutbound !== undefined
                  ? this.#opts.globalOutbound
                  : this.#opts.workerOptions?.globalOutbound,
              limits: this.#opts.limits ?? this.#opts.workerOptions?.limits,
              tailBindingName: this.#opts.observability?.tail?.bindingName,
            }),
            envelope,
            freshIsolate: opts?.freshIsolate,
            // Single-shot `submit` uses slot 0 — compatible with the
            // first slot of a future `map`. Across calls the same
            // shape+slot reuses one isolate; across tasks in ONE fan-out,
            // distinct slots produce distinct isolates (see
            // `src/loader/cache-key.ts` for the full rationale).
            taskSlot: 0,
            allowList: undefined,
            cancelStream: cancelWriter?.stream,
          }),
        {
          timeout: opts?.timeout ?? this.#opts.timeout,
          retries: opts?.retries ?? this.#opts.retries ?? 0,
          retryDelay: opts?.retryDelay ?? this.#opts.retryDelay ?? 100,
          cancel: opts?.cancel,
          deadlineEpochMs: envelope.deadlineEpochMs || undefined,
          onRetry: ({ error }) => {
            retryCount++;
            // BackpressureError on retry = LRU thrash signal.
            if (error.name === 'BackpressureError') {
              this.#lruEvictionLast60s.push(Date.now());
              emitObservabilityEvent(obs, {
                kind: 'poolPressure',
                payload: {
                  ts: Date.now(),
                  kind: 'lru-thrash',
                  detail: error.message,
                },
              });
            }
          },
        },
      );
      if (!result.ok) {
        this.#failed++;
        const err = leafErrorToTypedError(result.error);
        emitObservabilityEvent(obs, {
          kind: 'taskError',
          payload: {
            ts: Date.now(),
            poolId: this.#coordinatorName,
            taskId,
            topology,
            fnHash,
            errorClass: err.name,
            message: err.message,
            retryCount,
          },
        });
        errorEmitted = true;
        throw err;
      }
      this.#completed++;
      cancelWriter?.close();
      emitObservabilityEvent(obs, {
        kind: 'taskEnd',
        payload: {
          ts: Date.now(),
          poolId: this.#coordinatorName,
          taskId,
          topology,
          fnHash,
          wallMs: Date.now() - startTs,
          retryCount,
        },
      });
      return result.value as R;
    } catch (err) {
      cancelWriter?.close();
      if ((err as ParallelError).name === 'CancelledError') {
        this.#cancelled++;
        // The caller-side cancel surfaced here, but the loaded isolate may
        // still be running until its cpuMs / wall-clock budget elapses
        // (the Worker Loader API has no `abort(id)` primitive yet; AbortController short-circuits
        // user `await`s but cannot terminate sync loops). Surface this as
        // `taskOrphan` so users can observe the asymmetry in their metrics.
        emitObservabilityEvent(obs, {
          kind: 'taskOrphan',
          payload: {
            ts: Date.now(),
            poolId: this.#coordinatorName,
            taskId,
            reason: (err as Error).message,
          },
        });
      }
      // taskError already emitted on the !ok path; emit here only for
      // pre-RPC throws (CancelledError, network, etc.) that bypass it.
      if (!errorEmitted) {
        emitObservabilityEvent(obs, {
          kind: 'taskError',
          payload: {
            ts: Date.now(),
            poolId: this.#coordinatorName,
            taskId,
            topology,
            fnHash,
            errorClass: (err as Error).name ?? 'UnknownError',
            message: (err as Error).message ?? String(err),
            retryCount,
          },
        });
      }
      throw err;
    } finally {
      this.#inFlightDec(1);
    }
  }

  // ---- fan-out: map / scatter / reduce / pmap / pipe -----------------

  /**
   * Apply `fn` to each element of `items` in parallel.
   *
   * The runtime auto-selects topology by `items.length`:
   * - `0..1`: in-DO (single loaded isolate; no fan-out).
   * - `2..maxFanOut`: hybrid (one job per leaf DO; CPU parallelism
   *   scales linearly with leaf-DO count).
   * - `> maxFanOut`: tree (recursive sub-coordinators, depth
   *   `K = ⌈log_F (size / maxFanOut)⌉`).
   *
   * Throughput scales linearly with leaf-DO count because each leaf is
   * a separate workerd process on its own V8 scheduler thread. See
   * {@link PoolStats.topology} for the decision the pool actually made.
   *
   * @param fn function applied to each item. Receives `(item, env)`.
   * @param items items to map. Order preserved in the result.
   * @param opts {@link MapOptions}. The `onError` strategy controls
   *   failure handling:
   *   - `'throw'` (default) — throw `AggregateExecutionError` if any
   *     item fails; siblings that completed are on `.partialResults`.
   *   - `'throw-fast'` — first error wins; cancels remaining work.
   *   - `'null'` — replace failures with `null` in the result array.
   *   - `'skip'` — drop failures from the result array (length shrinks).
   *   - `'settled'` — return `SettledResult<R>[]` (Promise.allSettled
   *     shape) so callers inspect `{ ok, value | error }` per item.
   * @returns array of results in input order (lengths may differ for
   *   `'skip'`).
   * @throws AggregateExecutionError on `'throw'` / `'throw-fast'`
   *   when any item fails. Individual error details on `.errors` map.
   */
  async map<T, R>(
    fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    opts?: MapOptions,
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];
    return this.#fanOut<Awaited<R>>(
      fn,
      items.map((i) => [i] as unknown[]),
      {
        onError: opts?.onError ?? 'throw',
        cancel: opts?.cancel,
        perCall: opts,
      },
    );
  }

  /**
   * Tournament-style parallel reduce. Pairs are reduced concurrently per
   * round; the result tree halves each round until one value remains.
   *
   * The reducer must be **associative** — `fn(fn(a,b), c) === fn(a, fn(b,c))` —
   * for the result to be deterministic. Non-associative reducers (e.g.
   * subtraction) will produce different results from a sequential left fold.
   *
   * @param fn associative reducer `(a, b, env) => combined`.
   * @param items items to reduce.
   * @param initial seed value; included as the first element of round 1.
   * @returns the reduced value.
   */
  async reduce<T>(
    fn: (a: T, b: T, env: B & { signal: AbortSignal }) => T | Promise<T>,
    items: T[],
    initial: T,
  ): Promise<Awaited<T>> {
    if (items.length === 0) return initial as Awaited<T>;
    let current: T[] = [initial, ...items];
    while (current.length > 1) {
      const pairs: T[][] = [];
      const carry: { idx: number; value: T }[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          pairs.push([current[i], current[i + 1]]);
        } else {
          carry.push({ idx: pairs.length, value: current[i] });
          pairs.push([current[i]]); // single-element placeholder
        }
      }
      const validPairs = pairs.filter((p) => p.length === 2);
      const valuesPromise = this.#fanOut<T>(fn, validPairs as unknown as unknown[][], {
        onError: 'throw',
        cancel: undefined,
        perCall: undefined,
      });
      const reduced = await valuesPromise;
      const next: T[] = [];
      let reducedIdx = 0;
      for (let i = 0; i < pairs.length; i++) {
        const c = carry.find((x) => x.idx === i);
        if (c) next.push(c.value);
        else next.push(reduced[reducedIdx++]);
      }
      current = next;
    }
    return current[0] as Awaited<T>;
  }

  /**
   * Split `items` into `chunks` batches, run `fn` once per batch in
   * parallel.
   *
   * Use `scatter` when the per-call overhead (RPC + loader cold-start)
   * outweighs the per-item work — e.g. small CPU-bound items where you
   * want one isolate per batch instead of one per item.
   *
   * @param fn batch function `(batch[], env) => result`.
   * @param items full input list; chunked across `chunks` batches of
   *   size `⌈items.length / chunks⌉`.
   * @param chunks number of batches. Capped by topology selector.
   * @param opts {@link ScatterOptions}.
   * @returns one result per batch, in input order.
   */
  async scatter<T, R>(
    fn: (items: T[], env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    chunks: number,
    opts?: ScatterOptions,
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];
    const chunkSize = Math.ceil(items.length / chunks);
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) batches.push(items.slice(i, i + chunkSize));
    return this.#fanOut<Awaited<R>>(
      fn,
      batches.map((b) => [b] as unknown[]),
      {
        onError: opts?.onError ?? 'throw',
        cancel: opts?.cancel,
        perCall: opts,
      },
    );
  }

  /**
   * Local `Promise.all` shorthand. Accepts a list of in-flight pool
   * promises (e.g. from `pool.submit`) and returns when all resolve.
   * **Equivalent to `Promise.all(promises)`** — no additional fan-out
   * happens; this exists for stylistic uniformity with the rest of the
   * Pool API.
   */
  async gather<T>(promises: Promise<T>[]): Promise<T[]> {
    return Promise.all(promises);
  }

  /**
   * Curried batched-map. Returns a function `(items, opts?) => results`
   * that splits `items` into batches and calls `fn(batch)` once per
   * batch. Different from `scatter` in that the batch function returns
   * `R[]` (per-item results) and the pool flattens.
   *
   * @example
   * const embed = pool.pmap(async (texts: string[]) => embedAll(texts));
   * const vectors = await embed(documents, { chunks: 16 });
   */
  pmap<T, R>(
    fn: (batch: T[], env: B & { signal: AbortSignal }) => R[] | Promise<R[]>,
  ): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]> {
    return async (items: T[], opts?: PmapOptions): Promise<Awaited<R>[]> => {
      if (items.length === 0) return [];
      const numChunks = opts?.chunks ?? items.length;
      const chunkSize = Math.ceil(items.length / numChunks);
      const chunks: T[][] = [];
      for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
      const batchResults = await this.#fanOut<R[]>(
        fn,
        chunks.map((c) => [c] as unknown[]),
        { onError: 'throw', cancel: undefined, perCall: undefined },
      );
      return (batchResults as Awaited<R>[][]).flat();
    };
  }

  /**
   * Sequential pipeline. `pool.pipe(f1, f2, f3)(input)` runs `f1(input)` →
   * `f2(f1(input))` → `f3(f2(f1(input)))`, each on a fresh isolate.
   *
   * Stages are sequential by data dependency — for independent stages,
   * use `gather` (`Promise.all`) on `pool.submit` calls.
   */
  pipe: PipeFn = ((...fns: UserFn[]) =>
    async (input: unknown): Promise<unknown> => {
      let value: unknown = input;
      for (const fn of fns) {
        value = await this.#runOne(fn, [value], undefined);
      }
      return value;
    }) as unknown as PipeFn;

  // ---- streaming ----------------------------------------------------

  /**
   * Streaming map yielding results in **completion order** (fastest first).
   *
   * Each yielded entry is `{ index, value }` — `index` is the original
   * position in `items` so callers can re-order if needed. Use when
   * downstream work can begin on partial results without waiting for
   * the slowest item.
   *
   * @param opts.concurrency max in-flight isolates (default: items.length).
   */
  async *mapStream<T, R>(
    fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamResult<Awaited<R>>> {
    if (items.length === 0) return;
    const concurrency = opts?.concurrency ?? items.length;
    // Fire dispatches; yield in completion order.
    type Slot = { idx: number; promise: Promise<{ idx: number; value: Awaited<R> }> };
    const slots: Slot[] = [];
    let cursor = 0;
    while (slots.length < concurrency && cursor < items.length) {
      const idx = cursor++;
      slots.push({
        idx,
        promise: this.#runOne<Awaited<R>>(fn, [items[idx]], opts).then((v) => ({ idx, value: v })),
      });
    }
    while (slots.length > 0) {
      const winner = await Promise.race(
        slots.map((s, i) => s.promise.then((r) => ({ ...r, slot: i }))),
      );
      yield { index: winner.idx, value: winner.value };
      slots.splice(winner.slot, 1);
      if (cursor < items.length) {
        const idx = cursor++;
        slots.push({
          idx,
          promise: this.#runOne<Awaited<R>>(fn, [items[idx]], opts).then((v) => ({
            idx,
            value: v,
          })),
        });
      }
    }
  }

  /**
   * Streaming map yielding results in **input order**, with up to
   * `opts.concurrency` items in flight at once.
   *
   * Slower than `mapStream` for variable-latency workloads (head-of-line
   * blocking) but lets the consumer process results in deterministic
   * order without re-sorting.
   */
  async *mapOrdered<T, R>(
    fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<Awaited<R>> {
    if (items.length === 0) return;
    const concurrency = opts?.concurrency ?? items.length;
    // Pre-allocate a Deferred per slot so consumers `await` directly on
    // the slot's promise — no setTimeout-poll spin loop.
    const slots: Array<Deferred<Awaited<R>>> = Array.from({ length: items.length }, () =>
      deferred<Awaited<R>>(),
    );
    let cursor = 0;
    const dispatch = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          const value = await this.#runOne<Awaited<R>>(fn, [items[idx]], opts);
          slots[idx].resolve(value);
        } catch (err) {
          slots[idx].reject(err);
        }
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => dispatch());
    for (let i = 0; i < items.length; i++) {
      yield await slots[i].promise;
    }
    await Promise.all(workers);
  }

  /**
   * Single-task streaming submit. The user fn must return a
   * `ReadableStream<R>`. Useful for SSE / chunked AI responses where
   * the isolate produces output incrementally.
   *
   * **v0.3 implementation note.** The current implementation wraps
   * `submit` and casts the return to `ReadableStream<R>`. A native
   * RPC streaming codegen mode (`executeStream`) is planned for v0.4
   * and will provide true backpressure-aware streaming. For now,
   * the user-fn must return a complete `ReadableStream` — backpressure
   * is the caller's responsibility.
   */
  async submitStream<A extends unknown[], R>(
    fn: (
      ...args: [...A, B & { signal: AbortSignal }]
    ) => ReadableStream<R> | Promise<ReadableStream<R>>,
    ...rest: [...A] | [...A, SubmitOptions]
  ): Promise<ReadableStream<R>> {
    return this.submit(fn as unknown as never, ...rest) as unknown as Promise<ReadableStream<R>>;
  }

  // ---- admin / observability ----------------------------------------

  /**
   * Pre-warm the Coordinator DO and (optionally) `n` loaded isolates.
   *
   * Cold-vs-warm validated empirically: a freshly-created DO costs
   * ~300–400 ms on first call; subsequent calls on the warm channel are
   * ~3–30 ms. Calling `warm()` once at Pool construction (or letting
   * `autoWarm: true` do it automatically on the first dispatch) absorbs
   * that cost out of the critical path.
   *
   * @param opts.isolates how many loaded isolates to warm (default: 0,
   *   coordinator-ping only). Pass a positive number to additionally
   *   pay the loader-cache primer for `n` distinct fn-shape slots.
   */
  async warm(opts?: { isolates?: number }): Promise<void> {
    const n = opts?.isolates ?? 0;
    // Coordinator ping — paid in parallel with anything else the user
    // dispatches. `#ensurePrewarm(true)` forces prewarm even if the
    // user constructed the Pool with `autoWarm: false`; `warm()` is an
    // explicit opt-in regardless of the auto-warm setting.
    await this.#ensurePrewarm(true);
    if (n === 0) return;
    // Loader-cache primer: paid via N no-op submits. The user controls
    // `n` because each submit is a real dispatch (subrequest budget) and
    // the right number depends on the workload's fn-shape diversity.
    await this.map(async () => undefined, new Array(n).fill(0));
  }

  /**
   * Resolves when the pool's in-flight work counter reaches 0. Idempotent
   * — calling on an idle pool resolves immediately. Useful at end-of-test
   * or before shutting down the host Worker.
   */
  async drain(): Promise<void> {
    if (this.#inFlight === 0) return;
    if (!this.#drainBarrier) this.#drainBarrier = deferred<void>();
    return this.#drainBarrier.promise;
  }

  #inFlightInc(n: number): void {
    this.#inFlight += n;
  }

  #inFlightDec(n: number): void {
    this.#inFlight -= n;
    if (this.#inFlight === 0 && this.#drainBarrier) {
      const b = this.#drainBarrier;
      this.#drainBarrier = undefined;
      b.resolve();
    }
  }

  /**
   * Snapshot of pool state — counters (completed/failed/cancelled/inFlight),
   * the last topology decision, and rolling LRU-thrash signals over a
   * 60s window. See {@link PoolStats}.
   */
  async stats(): Promise<PoolStats> {
    // Trim LRU thrash counter to a 60s sliding window.
    const cutoff = Date.now() - 60_000;
    while (this.#lruEvictionLast60s.length > 0 && this.#lruEvictionLast60s[0] < cutoff) {
      this.#lruEvictionLast60s.shift();
    }
    const lastTopology =
      this.#lastTopology ??
      (this.#opts.topology && this.#opts.topology !== 'auto' ? this.#opts.topology : 'in-do');
    return {
      inFlight: this.#inFlight,
      queued: 0,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      topology: lastTopology,
      topologyDecisionAt: this.#lastTopologyDecisionAt,
      warmIsolatesEstimate: Math.min(this.#fnShapesToday.size, 50),
      uniqueFnShapesToday: this.#fnShapesToday.size,
      lruEvictionLast60sCount: this.#lruEvictionLast60s.length,
      treeDepth: this.#lastTreeDepth,
      fanOutPerLevel: this.#lastFanOutPerLevel,
    };
  }

  /**
   * Build an HTTP request handler that accepts submitted code and runs it
   * through this pool. **`policy` is required** — there is no silent
   * unauthenticated default. Use `policy: { kind: 'public' }` to opt into
   * an open endpoint (a one-time runtime warning is logged); use
   * `policy: { kind: 'auth', auth: (req) => ... }` for authenticated
   * submissions. See `submitCodeHandler` for the full threat model.
   */
  handle(opts: {
    policy: SubmitCodePolicy<B>;
    parse?: (req: Request) => Promise<{ fn: string; args: unknown[]; options?: SubmitOptions }>;
    format?: (result: unknown) => Response;
  }): (req: Request) => Promise<Response> {
    return submitCodeHandler<B>({
      pool: this as unknown as Pool<B, Record<string, unknown>>,
      policy: opts.policy,
      parse: opts.parse,
      format: opts.format,
    });
  }

  /**
   * Build a new Pool that exposes only the named bindings from this pool's
   * `bindings`. Intended for capability-gated endpoints (e.g. `submitCodeHandler`
   * uses this to enforce its `allowBindings` policy).
   */
  restrictTo(allow: ReadonlyArray<string>): Pool<B, C> {
    const src = (this.#opts.bindings ?? {}) as Record<string, unknown>;
    return new Pool<B, C>(this.#env, {
      ...this.#opts,
      bindings: pickBindings(src, allow as ReadonlyArray<string & keyof typeof src>) as B,
    });
  }

  // ---- fan-out shared --------------------------------------------------

  async #fanOut<TRes>(
    fn: UserFn,
    argsList: unknown[][],
    opts: { onError: OnErrorStrategy; cancel?: CancelToken; perCall: SubmitOptions | undefined },
  ): Promise<TRes[]> {
    const { fnSource, fnHash } = this.#serialize(fn);
    const envelope = buildEnvelope({
      cancel: opts.cancel,
      deadline: opts.perCall?.deadline,
      deadlineMs: opts.perCall?.deadlineMs,
      mode: 'pool-fn',
    });

    const cancelWriter = opts.cancel ? createCancelStream() : undefined;
    if (cancelWriter && opts.cancel) {
      const tok = opts.cancel;
      if (tok.isCancelled) {
        cancelWriter.cancel(tok.poll().reason);
      } else {
        // `onCancel` is one-shot; no unsubscribe needed.
        tok.onCancel(() => cancelWriter.cancel(tok.poll().reason));
      }
    }

    // Pick dispatch target. Small-N (≤4) routes through the in-process
    // loopback when wired up; larger fan-outs use the Coordinator DO.
    const target = this.#runManyTarget(argsList.length);
    // Fire prewarm in parallel with the real dispatch. Validated 14×–140×
    // cold-path speedup; cost is zero (parallelized, deduped).
    void this.#ensurePrewarm();
    this.#inFlightInc(argsList.length);
    let result: FanOutResponse;
    try {
      result = await dispatchWithResilience(
        () =>
          target.runMany({
            fnSource,
            fnHash,
            argsList,
            context: this.#mergeContext(opts.perCall?.context),
            cacheKeyStrategy: this.#opts.cacheKeyStrategy ?? 'stable',
            workerOptions: workerOptionsToWire({
              compatibilityDate: this.#opts.workerOptions?.compatibilityDate,
              compatibilityFlags: this.#opts.workerOptions?.compatibilityFlags,
              globalOutbound:
                this.#opts.globalOutbound !== undefined
                  ? this.#opts.globalOutbound
                  : this.#opts.workerOptions?.globalOutbound,
              limits: this.#opts.limits ?? this.#opts.workerOptions?.limits,
              tailBindingName: this.#opts.observability?.tail?.bindingName,
            }),
            envelope,
            freshIsolate: opts.perCall?.freshIsolate,
            selector: this.#selector(),
            cancelStream: cancelWriter?.stream,
            locationHint: this.#locationHint,
          }),
        {
          timeout: opts.perCall?.timeout ?? this.#opts.timeout,
          retries: opts.perCall?.retries ?? this.#opts.retries ?? 0,
          retryDelay: opts.perCall?.retryDelay ?? this.#opts.retryDelay ?? 100,
          cancel: opts.cancel,
          onRetry: ({ error }) => {
            if (error.name === 'BackpressureError') this.#lruEvictionLast60s.push(Date.now());
          },
          deadlineEpochMs: envelope.deadlineEpochMs || undefined,
        },
      );
    } finally {
      this.#inFlightDec(argsList.length);
      cancelWriter?.close();
    }

    // Record topology decision for PoolStats.
    this.#lastTopologyDecisionAt = Date.now();
    this.#lastFanOutPerLevel = result.fanOutPerLevel;
    this.#lastTreeDepth = result.treeDepth;
    this.#lastTopology = result.topology;
    emitObservabilityEvent(this.#opts.observability, {
      kind: 'topologyDecision',
      payload: {
        ts: this.#lastTopologyDecisionAt,
        size: argsList.length,
        topology: result.topology,
        fanOutPerLevel: result.fanOutPerLevel,
        treeDepth: result.treeDepth,
      },
    });

    return runFanOut<number, TRes>({
      items: result.results.map((_, i) => i),
      onError: opts.onError,
      concurrency: result.results.length,
      mode: 'map',
      run: async (idx) => {
        const r = result.results[idx];
        if (r.ok) {
          this.#completed++;
          return r.value as TRes;
        }
        this.#failed++;
        throw leafErrorToTypedError(r.error);
      },
    });
  }
}
