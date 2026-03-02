/**
 * WorkerPool — parallel execution via the Worker Loader API.
 *
 * Each task dispatches to a real, separate V8 isolate created on-demand
 * by the Cloudflare Worker Loader binding. No pre-deployed executor
 * worker, no `unsafe_eval`, no HTTP+JSON overhead — just RPC.
 *
 * ## v0.2 features
 *
 * - **Binding passthrough**: Forward KV, R2, AI, D1, etc. to dynamic workers
 *   via the `bindings` pool option. Functions receive `env` as their last arg.
 * - **Closure capture**: Inject serializable values as module-level constants
 *   via the `context` option (pool-level and per-call).
 * - **Timeouts & retries**: Per-pool and per-call `timeout`, `retries`, and
 *   `retryDelay` with exponential backoff. `map`/`scatter` support `onError`.
 * - **Streaming iterators**: `mapStream()` yields results as they complete
 *   (unordered); `mapOrdered()` yields in original index order.
 *
 * ## ID strategy
 *
 * Every `LOADER.get(id, callback)` call uses an ID of the form:
 *
 *     cfp:<hash>:<counter>
 *
 * - `hash` is a djb2 hash of the function source (same function = same hash).
 * - `counter` is a monotonically incrementing integer per pool instance.
 *
 * For parallel work (e.g. `map` with 10 items), each item gets a unique
 * counter value, so the loader is forced to create a separate isolate for
 * each. The hash prefix means tasks with identical function code can still
 * benefit from the loader's internal code caching.
 */

import type { WorkerLoader, WorkerCode } from './types.js';
import type { WorkerCodeOptions, GenerateSourceOptions } from './codegen.js';
import { buildWorkerCode } from './codegen.js';
import { serializeFunction, hashSource } from './serialize.js';
import {
  ExecutionError,
  BindingError,
  TimeoutError,
  RetryExhaustedError,
} from './errors.js';

// ── Option types ────────────────────────────────────────────────────

/**
 * Resilience options for timeout and retry behavior.
 * Can be set at pool level (defaults) or overridden per-call.
 */
export interface ResilienceOptions {
  /**
   * Maximum time (ms) a single task execution may take before being
   * aborted with a `TimeoutError`. `undefined` = no timeout.
   */
  timeout?: number;

  /**
   * Number of retry attempts after the initial failure. `0` = no retries (default).
   * After all retries are exhausted a `RetryExhaustedError` is thrown.
   */
  retries?: number;

  /**
   * Base delay (ms) between retries. Doubles on each subsequent attempt
   * (exponential backoff). Defaults to `100`.
   */
  retryDelay?: number;
}

export interface PoolOptions {
  /**
   * Options passed to the generated worker code.
   * Controls compatibility date, flags, env, and network access.
   */
  workerOptions?: WorkerCodeOptions;

  /**
   * Bindings to forward to dynamic workers (KV, R2, AI, D1, DO, etc.).
   * When set, each submitted function receives an `env` object as its
   * last argument containing these bindings.
   *
   * ```ts
   * const pool = Parallel.pool(env.LOADER, {
   *   bindings: { AI: env.AI, KV: env.MY_KV },
   * });
   * await pool.submit(async (prompt, env) => {
   *   return env.AI.run('@cf/meta/llama-3-8b-instruct', { ... });
   * }, "Hello!");
   * ```
   */
  bindings?: Record<string, unknown>;

  /**
   * Captured context variables injected as module-level constants into
   * every generated worker. Values must be JSON-serializable.
   *
   * ```ts
   * const pool = Parallel.pool(env.LOADER, {
   *   context: { multiplier: 3 },
   * });
   * await pool.submit((x) => x * multiplier, 5); // => 15
   * ```
   */
  context?: Record<string, unknown>;

  /**
   * Default resilience settings applied to every task dispatched by
   * this pool. Can be overridden per-call via `SubmitOptions`, etc.
   */
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

/** Per-call options for `submit()`. */
export interface SubmitOptions extends ResilienceOptions {
  /**
   * Per-call context variables. Merged with (and overrides) pool-level context.
   * Values must be JSON-serializable.
   */
  context?: Record<string, unknown>;
}

/** Error handling strategy for `map()` and `scatter()`. */
export type OnErrorStrategy = 'throw' | 'skip' | 'null';

export interface MapOptions extends ResilienceOptions {
  /** Max number of in-flight tasks. Defaults to `items.length` (fully parallel). */
  concurrency?: number;
  /** Per-call context overrides. */
  context?: Record<string, unknown>;
  /**
   * How to handle per-item failures:
   * - `'throw'` (default): reject immediately on first failure.
   * - `'skip'`: omit failed items from the result array.
   * - `'null'`: replace failed items with `null` in the result array.
   */
  onError?: OnErrorStrategy;
}

export interface PmapOptions {
  /** Number of chunks to split the input into. Defaults to `items.length`. */
  chunks?: number;
}

/** Options for streaming iterators (`mapStream`, `mapOrdered`). */
export interface StreamOptions extends ResilienceOptions {
  /** Max number of in-flight tasks. Defaults to `items.length`. */
  concurrency?: number;
  /** Per-call context overrides. */
  context?: Record<string, unknown>;
}

/** A single result from `mapStream()`, carrying its original index. */
export interface StreamResult<T> {
  /** The original index of this item in the input array. */
  index: number;
  /** The computed value. */
  value: T;
}

/** Options for `scatter()` with partial failure support. */
export interface ScatterOptions extends ResilienceOptions {
  /** Per-call context overrides. */
  context?: Record<string, unknown>;
  /** Error handling strategy. */
  onError?: OnErrorStrategy;
}

// ── WorkerPool ──────────────────────────────────────────────────────

export class WorkerPool {
  readonly #loader: WorkerLoader;
  readonly #workerOpts: WorkerCodeOptions | undefined;
  readonly #bindings: Record<string, unknown> | undefined;
  readonly #poolContext: Record<string, unknown> | undefined;
  readonly #defaultTimeout: number | undefined;
  readonly #defaultRetries: number;
  readonly #defaultRetryDelay: number;

  /** Monotonically increasing counter for unique isolate IDs. */
  #counter = 0;

  constructor(loader: WorkerLoader, opts?: PoolOptions) {
    if (!loader || typeof loader.get !== 'function') {
      throw new BindingError(
        'WorkerPool requires a Worker Loader binding. ' +
          'Add `[[worker_loaders]]` to your wrangler.toml and pass `env.LOADER`.',
      );
    }
    this.#loader = loader;
    this.#bindings = opts?.bindings;
    this.#poolContext = opts?.context;
    this.#defaultTimeout = opts?.timeout;
    this.#defaultRetries = opts?.retries ?? 0;
    this.#defaultRetryDelay = opts?.retryDelay ?? 100;

    // Merge bindings into workerOptions.env so the dynamic worker
    // receives them as `this.env` (the Cloudflare Worker Loader pattern).
    if (opts?.bindings) {
      const existingEnv = opts?.workerOptions?.env ?? {};
      this.#workerOpts = {
        ...opts?.workerOptions,
        env: { ...existingEnv, ...opts.bindings },
      };
    } else {
      this.#workerOpts = opts?.workerOptions;
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Merge pool-level context with per-call context.
   * Per-call values override pool-level values for the same key.
   */
  #mergeContext(
    perCall?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!this.#poolContext && !perCall) return undefined;
    if (!this.#poolContext) return perCall;
    if (!perCall) return this.#poolContext;
    return { ...this.#poolContext, ...perCall };
  }

  /**
   * Build the `GenerateSourceOptions` for a given call.
   */
  #sourceOpts(perCallContext?: Record<string, unknown>): GenerateSourceOptions | undefined {
    const context = this.#mergeContext(perCallContext);
    const passEnv = !!this.#bindings;
    if (!context && !passEnv) return undefined;
    return { context, passEnv };
  }

  /**
   * Resolve resilience settings, merging pool defaults with per-call overrides.
   */
  #resolveResilience(perCall?: ResilienceOptions): {
    timeout: number | undefined;
    retries: number;
    retryDelay: number;
  } {
    return {
      timeout: perCall?.timeout ?? this.#defaultTimeout,
      retries: perCall?.retries ?? this.#defaultRetries,
      retryDelay: perCall?.retryDelay ?? this.#defaultRetryDelay,
    };
  }

  // ── Core dispatch ────────────────────────────────────────────────

  /**
   * Dispatch a single task to a fresh isolate via the Worker Loader.
   *
   * 1. Build a `WorkerCode` with the function embedded as a module.
   * 2. Call `loader.get()` with a unique ID to get a `WorkerStub`.
   * 3. Call `stub.getEntrypoint().execute(...args)` via RPC.
   *
   * @param fnSource       - Serialized function source.
   * @param fnHash         - Hash of the function source (for ID generation).
   * @param args           - Arguments to pass to the function.
   * @param perCallContext - Optional per-call context overrides.
   */
  async #dispatch(
    fnSource: string,
    fnHash: string,
    args: unknown[],
    perCallContext?: Record<string, unknown>,
  ): Promise<unknown> {
    const id = `cfp:${fnHash}:${this.#counter++}`;
    const workerCode = buildWorkerCode(
      fnSource,
      this.#workerOpts,
      this.#sourceOpts(perCallContext),
    );

    const stub = this.#loader.get(id, async () => workerCode);
    const entrypoint = stub.getEntrypoint();

    try {
      return await entrypoint.execute(...args);
    } catch (err: unknown) {
      // Wrap remote errors in ExecutionError for consistent handling.
      if (err instanceof Error) {
        throw new ExecutionError(err.message, err.stack);
      }
      throw new ExecutionError(String(err));
    }
  }

  /**
   * Dispatch with timeout and retry logic.
   *
   * - Wraps each attempt with `Promise.race` against a timeout (if set).
   * - On failure, retries up to `retries` times with exponential backoff.
   * - After all retries, throws `RetryExhaustedError`.
   */
  async #dispatchWithResilience(
    fnSource: string,
    fnHash: string,
    args: unknown[],
    resilience: ResilienceOptions,
    perCallContext?: Record<string, unknown>,
  ): Promise<unknown> {
    const { timeout, retries, retryDelay } = this.#resolveResilience(resilience);
    const maxAttempts = 1 + (retries ?? 0);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const taskPromise = this.#dispatch(fnSource, fnHash, args, perCallContext);

        if (timeout !== undefined && timeout > 0) {
          const result = await Promise.race([
            taskPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new TimeoutError(timeout)), timeout),
            ),
          ]);
          return result;
        }

        return await taskPromise;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // If we have retries left, wait with exponential backoff.
        if (attempt < maxAttempts - 1) {
          const delay = (retryDelay ?? 100) * Math.pow(2, attempt);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All attempts exhausted.
    if (maxAttempts > 1) {
      throw new RetryExhaustedError(maxAttempts, lastError!);
    }
    throw lastError!;
  }

  /**
   * Serialize a function and return both its source and hash.
   */
  #prepare(fn: Function): { fnSource: string; fnHash: string } {
    const fnSource = serializeFunction(fn);
    const fnHash = hashSource(fnSource);
    return { fnSource, fnHash };
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Execute a single function on a remote isolate and return the result.
   *
   * When the pool has `bindings` configured, the function receives an
   * `env` object as its last argument with the forwarded bindings.
   *
   * ```ts
   * const squared = await pool.submit((x: number) => x * x, 42);
   * // => 1764
   * ```
   *
   * With options:
   * ```ts
   * await pool.submit(fn, 42, { timeout: 5000, retries: 2 });
   * ```
   */
  async submit<T>(
    fn: (...args: any[]) => T,
    ...rest: unknown[]
  ): Promise<Awaited<T>> {
    // The last element of `rest` may be a SubmitOptions object.
    // We detect this by checking for a plain object with known option keys.
    let args: unknown[];
    let opts: SubmitOptions | undefined;

    const last = rest[rest.length - 1];
    if (rest.length > 0 && isSubmitOptions(last)) {
      opts = last as SubmitOptions;
      args = rest.slice(0, -1);
    } else {
      args = rest;
    }

    const { fnSource, fnHash } = this.#prepare(fn);
    return this.#dispatchWithResilience(
      fnSource,
      fnHash,
      args,
      opts ?? {},
      opts?.context,
    ) as Promise<Awaited<T>>;
  }

  /**
   * Parallel map: invoke `fn` once per item, each in its own isolate.
   *
   * By default every item is dispatched concurrently. Use `concurrency`
   * to limit the number of in-flight tasks.
   *
   * Supports partial failure handling via `onError`:
   * - `'throw'` (default): reject on first failure.
   * - `'skip'`: omit failed items from results.
   * - `'null'`: replace failed items with `null`.
   *
   * ```ts
   * const results = await pool.map((n: number) => n * 2, [1, 2, 3, 4]);
   * // => [2, 4, 6, 8]
   * ```
   */
  async map<T, R>(
    fn: (item: T) => R,
    items: T[],
    opts?: MapOptions,
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];

    const { fnSource, fnHash } = this.#prepare(fn);
    const concurrency = opts?.concurrency ?? items.length;
    const onError = opts?.onError ?? 'throw';
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    if (onError === 'throw' && concurrency >= items.length) {
      // Fully parallel, fail-fast — fire all at once.
      return Promise.all(
        items.map((item) =>
          this.#dispatchWithResilience(
            fnSource, fnHash, [item], resilience, opts?.context,
          ) as Promise<Awaited<R>>,
        ),
      );
    }

    // Bounded concurrency and/or partial failure handling.
    const settled: Array<{ ok: true; value: Awaited<R> } | { ok: false; error: Error }> =
      new Array(items.length);
    let cursor = 0;

    const runNext = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        try {
          const value = await this.#dispatchWithResilience(
            fnSource, fnHash, [items[idx]], resilience, opts?.context,
          ) as Awaited<R>;
          settled[idx] = { ok: true, value };
        } catch (err: unknown) {
          if (onError === 'throw') throw err;
          settled[idx] = {
            ok: false,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()),
    );

    // Assemble results based on onError strategy.
    if (onError === 'null') {
      return settled.map((s) => (s.ok ? s.value : null)) as Awaited<R>[];
    }
    // 'skip': only include successful results.
    return settled.filter((s) => s.ok).map((s) => (s as { ok: true; value: Awaited<R> }).value);
  }

  /**
   * Tree-parallel reduce.
   *
   * Pairs adjacent items and reduces them in parallel rounds until a
   * single value remains — O(log n) depth instead of O(n).
   *
   * ```ts
   * const sum = await pool.reduce((a, b) => a + b, [1, 2, 3, 4, 5], 0);
   * // => 15
   * ```
   */
  async reduce<T>(
    fn: (a: T, b: T) => T,
    items: T[],
    initial: T,
  ): Promise<Awaited<T>> {
    if (items.length === 0) return initial as Awaited<T>;

    const { fnSource, fnHash } = this.#prepare(fn);
    let current: T[] = [initial, ...items];

    while (current.length > 1) {
      const tasks: Promise<unknown>[] = [];
      const carryForward: { index: number; value: T }[] = [];

      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          tasks.push(this.#dispatch(fnSource, fnHash, [current[i], current[i + 1]]));
        } else {
          // Odd element — carry forward without dispatching.
          carryForward.push({ index: tasks.length, value: current[i] });
          tasks.push(Promise.resolve(current[i]));
        }
      }

      const round = await Promise.all(tasks);
      current = round as T[];
    }

    return current[0] as Awaited<T>;
  }

  /**
   * Chunked parallel map (pmap).
   *
   * Returns a curried function that splits its input array into chunks
   * and maps each chunk in parallel on a separate isolate.
   *
   * ```ts
   * const pmapped = pool.pmap((batch: number[]) => batch.map(x => x * x));
   * const results = await pmapped([1, 2, 3, 4, 5, 6], { chunks: 3 });
   * // => [1, 4, 9, 16, 25, 36]
   * ```
   */
  pmap<T, R>(
    fn: (batch: T[]) => R[],
  ): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]> {
    const { fnSource, fnHash } = this.#prepare(fn);

    return async (items: T[], opts?: PmapOptions): Promise<Awaited<R>[]> => {
      if (items.length === 0) return [];

      const numChunks = opts?.chunks ?? items.length;
      const chunkSize = Math.ceil(items.length / numChunks);
      const chunks: T[][] = [];

      for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
      }

      const chunkResults = await Promise.all(
        chunks.map((chunk) =>
          this.#dispatch(fnSource, fnHash, [chunk]),
        ),
      );

      return (chunkResults as Awaited<R>[][]).flat();
    };
  }

  /**
   * Compose a sequential pipeline where each stage runs on its own
   * remote isolate. The output of one stage becomes the input to the next.
   *
   * ```ts
   * const pipeline = pool.pipe(
   *   (s: string) => s.toLowerCase(),
   *   (s: string) => s.split(' '),
   *   (words: string[]) => words.length,
   * );
   * const count = await pipeline("Hello World");
   * // => 2
   * ```
   */
  pipe<A, B>(f1: (a: A) => B): (input: A) => Promise<Awaited<B>>;
  pipe<A, B, C>(f1: (a: A) => B, f2: (b: Awaited<B>) => C): (input: A) => Promise<Awaited<C>>;
  pipe<A, B, C, D>(
    f1: (a: A) => B,
    f2: (b: Awaited<B>) => C,
    f3: (c: Awaited<C>) => D,
  ): (input: A) => Promise<Awaited<D>>;
  pipe<A, B, C, D, E>(
    f1: (a: A) => B,
    f2: (b: Awaited<B>) => C,
    f3: (c: Awaited<C>) => D,
    f4: (d: Awaited<D>) => E,
  ): (input: A) => Promise<Awaited<E>>;
  pipe<A, B, C, D, E, F>(
    f1: (a: A) => B,
    f2: (b: Awaited<B>) => C,
    f3: (c: Awaited<C>) => D,
    f4: (d: Awaited<D>) => E,
    f5: (e: Awaited<E>) => F,
  ): (input: A) => Promise<Awaited<F>>;
  pipe(...fns: ((...args: any[]) => any)[]): (input: any) => Promise<any>;
  pipe(...fns: ((...args: any[]) => any)[]): (input: any) => Promise<any> {
    const stages = fns.map((fn) => this.#prepare(fn));

    return async (input: unknown): Promise<unknown> => {
      let value = input;
      for (const { fnSource, fnHash } of stages) {
        value = await this.#dispatch(fnSource, fnHash, [value]);
      }
      return value;
    };
  }

  /**
   * Scatter data across N isolates: split `items` into `chunks` pieces,
   * invoke `fn` on each chunk in parallel, and return the array of
   * per-chunk results.
   *
   * Supports `onError` for partial failure handling (same as `map()`).
   *
   * ```ts
   * const chunkSums = await pool.scatter(
   *   (chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
   *   [1, 2, 3, 4, 5, 6],
   *   3,
   * );
   * // => [3, 7, 11]
   * ```
   */
  async scatter<T, R>(
    fn: (items: T[]) => R,
    items: T[],
    chunks: number,
    opts?: ScatterOptions,
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];

    const { fnSource, fnHash } = this.#prepare(fn);
    const chunkSize = Math.ceil(items.length / chunks);
    const batches: T[][] = [];

    for (let i = 0; i < items.length; i += chunkSize) {
      batches.push(items.slice(i, i + chunkSize));
    }

    const onError = opts?.onError ?? 'throw';
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    if (onError === 'throw') {
      return Promise.all(
        batches.map((batch) =>
          this.#dispatchWithResilience(
            fnSource, fnHash, [batch], resilience, opts?.context,
          ) as Promise<Awaited<R>>,
        ),
      );
    }

    // Partial failure handling.
    const results = await Promise.all(
      batches.map(async (batch) => {
        try {
          const value = await this.#dispatchWithResilience(
            fnSource, fnHash, [batch], resilience, opts?.context,
          ) as Awaited<R>;
          return { ok: true as const, value };
        } catch (err: unknown) {
          return {
            ok: false as const,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }),
    );

    if (onError === 'null') {
      return results.map((r) => (r.ok ? r.value : null)) as Awaited<R>[];
    }
    // 'skip'
    return results.filter((r) => r.ok).map((r) => (r as { ok: true; value: Awaited<R> }).value);
  }

  /**
   * Gather: a `Promise.all` wrapper for symmetry with `scatter`.
   *
   * ```ts
   * const results = await pool.gather([
   *   pool.submit((x: number) => x + 1, 1),
   *   pool.submit((x: number) => x + 2, 2),
   * ]);
   * // => [2, 4]
   * ```
   */
  async gather<T>(promises: Promise<T>[]): Promise<T[]> {
    return Promise.all(promises);
  }

  // ── Streaming iterators (Feature 4) ──────────────────────────────

  /**
   * Streaming unordered map: yields `{ index, value }` results as they
   * complete, without waiting for earlier items to finish first.
   *
   * Ideal for progress reporting, early processing, or when order
   * doesn't matter.
   *
   * ```ts
   * for await (const { index, value } of pool.mapStream(fn, items)) {
   *   console.log(`Item ${index} = ${value}`);
   * }
   * ```
   */
  async *mapStream<T, R>(
    fn: (item: T) => R,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamResult<Awaited<R>>> {
    if (items.length === 0) return;

    const { fnSource, fnHash } = this.#prepare(fn);
    const concurrency = opts?.concurrency ?? items.length;
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    // Channel: a queue of promises that resolve to results.
    // Producers push resolve/reject callbacks; the consumer awaits them.
    const queue: Array<{
      resolve: (v: StreamResult<Awaited<R>>) => void;
      reject: (e: Error) => void;
      promise: Promise<StreamResult<Awaited<R>>>;
    }> = [];

    // Pre-allocate a promise for each item so the consumer can
    // yield them in completion order.
    for (let i = 0; i < items.length; i++) {
      let resolve!: (v: StreamResult<Awaited<R>>) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<StreamResult<Awaited<R>>>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      queue.push({ resolve, reject, promise });
    }

    // Completion-order tracking: the next slot a completing task should fill.
    let completionSlot = 0;

    // Cursor for the next item to dispatch.
    let cursor = 0;

    const dispatchNext = async (): Promise<void> => {
      while (cursor < items.length) {
        const itemIdx = cursor++;
        // Grab the next completion slot atomically.
        const slot = completionSlot++;
        try {
          const value = await this.#dispatchWithResilience(
            fnSource, fnHash, [items[itemIdx]], resilience, opts?.context,
          ) as Awaited<R>;
          queue[slot].resolve({ index: itemIdx, value });
        } catch (err: unknown) {
          queue[slot].reject(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    };

    // Launch workers.
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => dispatchNext(),
    );

    // Yield results as they arrive.
    for (let i = 0; i < items.length; i++) {
      yield await queue[i].promise;
    }

    // Ensure all workers are settled (they should be by now).
    await Promise.all(workers);
  }

  /**
   * Ordered streaming map: yields values in the original input order,
   * buffering out-of-order completions internally.
   *
   * ```ts
   * for await (const value of pool.mapOrdered(fn, items, { concurrency: 10 })) {
   *   // values arrive in items[0], items[1], items[2], ... order
   * }
   * ```
   */
  async *mapOrdered<T, R>(
    fn: (item: T) => R,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<Awaited<R>> {
    if (items.length === 0) return;

    const { fnSource, fnHash } = this.#prepare(fn);
    const concurrency = opts?.concurrency ?? items.length;
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    // One promise per item, indexed by original position.
    // This lets us yield in order regardless of completion order.
    const slots: Array<Promise<Awaited<R>>> = new Array(items.length);

    let cursor = 0;

    const dispatchNext = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        // Create a promise for this specific index and store it.
        slots[idx] = this.#dispatchWithResilience(
          fnSource, fnHash, [items[idx]], resilience, opts?.context,
        ) as Promise<Awaited<R>>;
        // Await it before picking up the next item (respects concurrency).
        await slots[idx].catch(() => {});
      }
    };

    // Launch concurrent workers.
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => dispatchNext(),
    );

    // Yield in order. Each `slots[i]` is set before or concurrently
    // with the worker processing. We just await each in sequence.
    for (let i = 0; i < items.length; i++) {
      // The slot is assigned before the worker awaits, so this is safe.
      // We need to wait until the slot is populated if a slow concurrent
      // worker hasn't dispatched it yet.
      while (slots[i] === undefined) {
        await new Promise<void>((r) => setTimeout(r, 1));
      }
      yield await slots[i];
    }

    await Promise.all(workers);
  }
}

// ── Utilities ───────────────────────────────────────────────────────

/**
 * Heuristic to detect whether the last argument to `submit()` is a
 * `SubmitOptions` object rather than a regular argument.
 *
 * We check for a plain object (not an array, Date, etc.) that has at
 * least one recognized option key. This avoids ambiguity with user args.
 */
function isSubmitOptions(value: unknown): value is SubmitOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  // Must not be a special built-in type.
  if (value instanceof Date || value instanceof RegExp || value instanceof Map) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const optionKeys = new Set([
    'timeout', 'retries', 'retryDelay', 'context',
  ]);
  return keys.length > 0 && keys.some((k) => optionKeys.has(k));
}
