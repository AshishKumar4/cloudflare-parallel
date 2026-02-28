/**
 * WorkerPool — parallel execution via the Worker Loader API.
 *
 * Each task dispatches to a real, separate V8 isolate created on-demand
 * by the Cloudflare Worker Loader binding. No pre-deployed executor
 * worker, no `unsafe_eval`, no HTTP+JSON overhead — just RPC.
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
 * benefit from the loader's internal code caching (it caches the compiled
 * module even when creating new isolates).
 *
 * For sequential work (e.g. `pipe` stages), each stage gets its own
 * counter anyway since stages have different function sources.
 */

import type { WorkerLoader, WorkerCode } from './types.js';
import type { WorkerCodeOptions } from './codegen.js';
import { buildWorkerCode } from './codegen.js';
import { serializeFunction, hashSource } from './serialize.js';
import { ExecutionError, BindingError } from './errors.js';

// ── Pool options ────────────────────────────────────────────────────

export interface PoolOptions {
  /**
   * Options passed to the generated worker code.
   * Controls compatibility date, flags, env, and network access.
   */
  workerOptions?: WorkerCodeOptions;
}

export interface MapOptions {
  /** Max number of in-flight tasks. Defaults to `items.length` (fully parallel). */
  concurrency?: number;
}

export interface PmapOptions {
  /** Number of chunks to split the input into. Defaults to `items.length`. */
  chunks?: number;
}

// ── WorkerPool ──────────────────────────────────────────────────────

export class WorkerPool {
  readonly #loader: WorkerLoader;
  readonly #workerOpts: WorkerCodeOptions | undefined;

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
    this.#workerOpts = opts?.workerOptions;
  }

  // ── Internal dispatch ────────────────────────────────────────────

  /**
   * Dispatch a single task to a fresh isolate via the Worker Loader.
   *
   * 1. Build a `WorkerCode` with the function embedded as a module.
   * 2. Call `loader.get()` with a unique ID to get a `WorkerStub`.
   * 3. Call `stub.getEntrypoint().execute(...args)` via RPC.
   *
   * @param fnSource - Serialized function source.
   * @param fnHash  - Hash of the function source (for ID generation).
   * @param args    - Arguments to pass to the function.
   */
  async #dispatch(fnSource: string, fnHash: string, args: unknown[]): Promise<unknown> {
    const id = `cfp:${fnHash}:${this.#counter++}`;
    const workerCode = buildWorkerCode(fnSource, this.#workerOpts);

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
   * ```ts
   * const squared = await pool.submit((x: number) => x * x, 42);
   * // => 1764
   * ```
   */
  async submit<T>(fn: (...args: any[]) => T, ...args: unknown[]): Promise<Awaited<T>> {
    const { fnSource, fnHash } = this.#prepare(fn);
    return this.#dispatch(fnSource, fnHash, args) as Promise<Awaited<T>>;
  }

  /**
   * Parallel map: invoke `fn` once per item, each in its own isolate.
   *
   * By default every item is dispatched concurrently (each gets a unique
   * loader ID, guaranteeing separate isolates). Use `concurrency` to
   * limit the number of in-flight tasks.
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

    if (concurrency >= items.length) {
      // Fully parallel -- fire all at once.
      return Promise.all(
        items.map((item) =>
          this.#dispatch(fnSource, fnHash, [item]) as Promise<Awaited<R>>,
        ),
      );
    }

    // Bounded concurrency via a semaphore pattern.
    const results = new Array<Awaited<R>>(items.length);
    let cursor = 0;

    const runNext = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await this.#dispatch(fnSource, fnHash, [items[idx]]) as Awaited<R>;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()),
    );

    return results;
  }

  /**
   * Tree-parallel reduce.
   *
   * Pairs adjacent items and reduces them in parallel rounds until a
   * single value remains -- O(log n) depth instead of O(n).
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
          // Odd element -- carry forward without dispatching.
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
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];

    const { fnSource, fnHash } = this.#prepare(fn);
    const chunkSize = Math.ceil(items.length / chunks);
    const batches: T[][] = [];

    for (let i = 0; i < items.length; i += chunkSize) {
      batches.push(items.slice(i, i + chunkSize));
    }

    return Promise.all(
      batches.map((batch) =>
        this.#dispatch(fnSource, fnHash, [batch]) as Promise<Awaited<R>>,
      ),
    );
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
}
