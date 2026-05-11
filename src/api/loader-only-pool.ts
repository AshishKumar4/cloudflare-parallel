import { BindingError } from '../errors/index';
import type {
  LoaderOnlyOptions,
  MapOptions,
  PmapOptions,
  ScatterOptions,
  SubmitOptions,
} from './options';
import { LoaderRunner } from '../loader/runner';
import { hashSource, serializeFunction } from '../loader/serialize';
import type { UserFn } from './user-fn';
import { buildEnvelope } from '../transport/deadline-prop';
import { dispatchWithResilience } from '../transport/rpc-client';
import { runFanOut, type FanOutMode } from './fan-out';
import { mergeContext } from './context-merge';
import { splitSubmitOptions } from './submit-options';
import type { PoolEnv } from './options';

/**
 * Type-narrowed Pool returned by `Parallel.loaderOnly()`. Structurally smaller
 * than `Pool` — methods that require a Coordinator DO (warm/drain/stats/
 * mapStream/mapOrdered/submitStream/handle) are absent at the type level.
 *
 * Reach the full surface via `Parallel.pool()`.
 */
export interface LoaderOnlyPool<B = Record<string, unknown>, _C = Record<string, unknown>> {
  submit<A extends unknown[], R>(
    fn: (...args: [...A, B & { signal: AbortSignal }]) => R | Promise<R>,
    ...args: [...A] | [...A, SubmitOptions]
  ): Promise<Awaited<R>>;

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
}

export class LoaderOnlyPoolImpl<
  B extends Record<string, unknown>,
  C extends Record<string, unknown>,
> implements LoaderOnlyPool<B, C> {
  readonly #runner: LoaderRunner;
  readonly #opts: LoaderOnlyOptions<B, C>;

  constructor(env: PoolEnv, opts: LoaderOnlyOptions<B, C> = {}) {
    if (!env.LOADER || typeof env.LOADER.get !== 'function') {
      throw new BindingError(
        'Parallel.loaderOnly() requires a Worker Loader binding. ' +
          'Add `[[worker_loaders]]\\nbinding = "LOADER"` to wrangler.toml.',
      );
    }
    this.#opts = opts;
    this.#runner = new LoaderRunner({
      loader: env.LOADER,
      callSite: 'fetch-handler',
      cacheKeyStrategy: opts.cacheKeyStrategy ?? 'stable',
      workerOptions: {
        ...opts.workerOptions,
        globalOutbound:
          opts.globalOutbound !== undefined
            ? opts.globalOutbound
            : opts.workerOptions?.globalOutbound !== undefined
              ? opts.workerOptions.globalOutbound
              : null,
        limits: opts.limits ?? opts.workerOptions?.limits,
      },
    });
  }

  // ---- private helper ------------------------------------------------

  #serialize(fn: UserFn): { fnSource: string; fnHash: string } {
    const fnSource = serializeFunction(fn);
    const fnHash = hashSource(fnSource);
    return { fnSource, fnHash };
  }

  #mergeContext(perCall?: Record<string, unknown>): Record<string, unknown> | undefined {
    return mergeContext(this.#opts.context as Record<string, unknown> | undefined, perCall);
  }

  async #runOnce<R>(
    fn: UserFn,
    args: unknown[],
    perCallOpts: SubmitOptions | undefined,
    taskSlot = 0,
  ): Promise<R> {
    const { fnSource, fnHash } = this.#serialize(fn);
    const envelope = buildEnvelope({
      cancel: perCallOpts?.cancel,
      deadline: perCallOpts?.deadline,
      deadlineMs: perCallOpts?.deadlineMs,
      mode: 'pool-fn',
    });
    return dispatchWithResilience<R>(
      () =>
        this.#runner.runOne<R>({
          fnSource,
          fnHash,
          context: this.#mergeContext(perCallOpts?.context),
          bindings: this.#opts.bindings as Record<string, unknown> | undefined,
          envelope,
          args,
          freshIsolate: perCallOpts?.freshIsolate,
          taskSlot,
        }),
      {
        timeout: perCallOpts?.timeout ?? this.#opts.timeout,
        retries: perCallOpts?.retries ?? this.#opts.retries ?? 0,
        retryDelay: perCallOpts?.retryDelay ?? this.#opts.retryDelay ?? 100,
        cancel: perCallOpts?.cancel,
        deadlineEpochMs: envelope.deadlineEpochMs || undefined,
      },
    );
  }

  // ---- public API ----------------------------------------------------

  async submit<A extends unknown[], R>(
    fn: (...args: [...A, B & { signal: AbortSignal }]) => R | Promise<R>,
    ...rest: [...A] | [...A, SubmitOptions]
  ): Promise<Awaited<R>> {
    const { args, opts } = splitSubmitOptions(rest);
    // Single-shot: slot 0, compatible with future `map`'s slot-0.
    return this.#runOnce<Awaited<R>>(fn, args, opts, 0);
  }

  async map<T, R>(
    fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    opts?: MapOptions,
  ): Promise<Awaited<R>[]> {
    return runFanOut<T, Awaited<R>>({
      items,
      onError: opts?.onError ?? 'throw',
      concurrency: opts?.concurrency ?? items.length,
      mode: 'map' as FanOutMode,
      // `idx` is the task position within this fan-out — exactly the
      // `taskSlot` we need to give each task its own loader cache key.
      run: (item, idx) => this.#runOnce<Awaited<R>>(fn, [item], opts, idx),
    });
  }

  async reduce<T>(
    fn: (a: T, b: T, env: B & { signal: AbortSignal }) => T | Promise<T>,
    items: T[],
    initial: T,
  ): Promise<Awaited<T>> {
    if (items.length === 0) return initial as Awaited<T>;
    let current: T[] = [initial, ...items];
    while (current.length > 1) {
      const next: T[] = [];
      const round: Promise<T>[] = [];
      const carryIdx: Array<{ from: number; value: T }> = [];
      let slot = 0;
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          // Per-pair slot index so the concurrent reductions in this
          // round each get their own isolate.
          round.push(this.#runOnce<T>(fn, [current[i], current[i + 1]], undefined, slot++));
        } else {
          carryIdx.push({ from: round.length, value: current[i] });
          round.push(Promise.resolve(current[i]));
        }
      }
      const settled = await Promise.all(round);
      for (const r of settled) next.push(r);
      current = next;
    }
    return current[0] as Awaited<T>;
  }

  async scatter<T, R>(
    fn: (items: T[], env: B & { signal: AbortSignal }) => R | Promise<R>,
    items: T[],
    chunks: number,
    opts?: ScatterOptions,
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];
    const chunkSize = Math.ceil(items.length / chunks);
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      batches.push(items.slice(i, i + chunkSize));
    }
    return runFanOut<T[], Awaited<R>>({
      items: batches,
      onError: opts?.onError ?? 'throw',
      concurrency: batches.length,
      mode: 'scatter' as FanOutMode,
      // `idx` is the chunk position — use it as the slot so each chunk
      // gets its own isolate.
      run: (batch, idx) => this.#runOnce<Awaited<R>>(fn, [batch], opts, idx),
    });
  }

  async gather<T>(promises: Promise<T>[]): Promise<T[]> {
    return Promise.all(promises);
  }

  pmap<T, R>(
    fn: (batch: T[], env: B & { signal: AbortSignal }) => R[] | Promise<R[]>,
  ): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]> {
    return async (items: T[], opts?: PmapOptions): Promise<Awaited<R>[]> => {
      if (items.length === 0) return [];
      const numChunks = opts?.chunks ?? items.length;
      const chunkSize = Math.ceil(items.length / numChunks);
      const chunks: T[][] = [];
      for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
      const results = await Promise.all(
        chunks.map((c, idx) => this.#runOnce<R[]>(fn, [c], undefined, idx)),
      );
      return (results as Awaited<R>[][]).flat();
    };
  }
}

// Submit-options helpers live in `./submit-options`. Re-export for
// callers that already import them from here.
export { isSubmitOptionsBag, splitSubmitOptions } from './submit-options';
