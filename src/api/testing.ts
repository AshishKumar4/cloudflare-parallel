/**
 * In-process fakes for unit tests. Match the production option types but
 * skip Wrangler-dev. Args/state/return go through `structuredClone()` so a
 * fn that works in the fake but breaks in production is impossible by
 * construction.
 *
 * Imported via `cloudflare-parallel/testing` (separate exports path so
 * production bundles don't pull in fakes).
 */

import { hashSource, serializeFunction } from '../loader/serialize';
import type { DispatchableFn, UserFn } from './user-fn';
import type { CancelToken } from './cancel';

import { runFanOut } from './fan-out';
import { wireToError } from './error-decode';
import { errorToFailedResult } from '../coordinator/protocol';
import { rejectIfRpcStub, validateReturn } from '../loader/return-validator';
import type {
  ActorOptions,
  Job,
  JobHandle,
  JobStatus,
  LoaderOnlyOptions,
  MapOptions,
  OnErrorStrategy,
  PmapOptions,
  PoolOptions,
  PoolStats,
  ScatterOptions,
  SchedulerOptions,
  SchedulerStats,
  StreamOptions,
  StreamResult,
  SubmitOptions,
  VMOptions,
} from './options';
import type { IPool, PipeFn } from './pool';
import type { IActorHandle } from './actor';
import type { IScheduler } from './scheduler';
import type { LoaderOnlyPool } from './loader-only-pool';
import type { SubmitCodePolicy } from './submit-code-handler';
import { deferred, type Deferred } from '../internal/deferred';

interface FakeOpts<B> {
  bindings?: B;
  /** Override how submitted fns are run. Default: structured-clone roundtrip + invoke. */
  runner?: (fn: UserFn, args: unknown[], envExtras: { signal: AbortSignal }) => Promise<unknown>;
}

const SUBMIT_OPTION_KEYS = new Set([
  'timeout',
  'retries',
  'retryDelay',
  'context',
  'cancel',
  'deadline',
  'deadlineMs',
  'freshIsolate',
  'meta',
]);

function splitOpts<A extends unknown[]>(
  rest: A,
): { args: unknown[]; opts: SubmitOptions | undefined } {
  if (rest.length === 0) return { args: [], opts: undefined };
  const last = rest[rest.length - 1];
  if (
    last !== null &&
    typeof last === 'object' &&
    !Array.isArray(last) &&
    !(last instanceof Date) &&
    !(last instanceof RegExp) &&
    !(last instanceof Map) &&
    !(last instanceof Set) &&
    Object.keys(last as Record<string, unknown>).every((k) => SUBMIT_OPTION_KEYS.has(k))
  ) {
    return { args: rest.slice(0, -1), opts: last as SubmitOptions };
  }
  return { args: rest as unknown[], opts: undefined };
}

function defaultRunner(fn: UserFn, args: unknown[]): Promise<unknown> {
  // Structured-clone roundtrip on the user-args (NOT the trailing env, which
  // contains a AbortSignal whose `cancelled` Promise isn't cloneable). The
  // env in production is reconstructed inside the loaded isolate from a
  // structured-clone-safe envelope, so the production-vs-fake mismatch we
  // care about here is on the user-supplied args, not the synthetic env.
  const last = args[args.length - 1];
  const userArgs = args.slice(0, -1).map((a) => structuredClone(a));
  const dispatch = fn as DispatchableFn;
  return Promise.resolve(dispatch(...userArgs, last)).then((r) => {
    rejectIfRpcStub(r);
    const v = validateReturn(r);
    return structuredClone(v);
  });
}

export function poolFake<B extends Record<string, unknown>>(
  opts: FakeOpts<B> & PoolOptions<B> = {} as never,
): IPool<B, Record<string, unknown>> {
  const fnShapes = new Set<string>();
  let completed = 0;
  let failed = 0;
  let cancelledCount = 0;
  const bindings = opts.bindings ?? ({} as B);
  const runner = opts.runner ?? defaultRunner;

  const runOne = async (
    fn: UserFn,
    args: unknown[],
    submitOpts?: SubmitOptions,
  ): Promise<unknown> => {
    fnShapes.add(hashSource(serializeFunction(fn)));
    const signal: AbortSignal = submitOpts?.cancel
      ? submitOpts.cancel.signal
      : new AbortController().signal;
    const env = { ...bindings, signal };
    try {
      const v = await runner(fn, [...args, env], env);
      completed++;
      return v;
    } catch (err) {
      failed++;
      if ((err as Error).name === 'CancelledError') cancelledCount++;
      throw err;
    }
  };

  const fan = async <T, R>(
    fn: UserFn,
    items: T[],
    onError: OnErrorStrategy,
    cancel: CancelToken | undefined,
    submitOpts?: SubmitOptions,
  ): Promise<R[]> =>
    runFanOut<T, R>({
      items,
      onError,
      concurrency: items.length,
      mode: 'map',
      run: (item) => runOne(fn, [item], submitOpts) as Promise<R>,
      cancel,
    });

  const pipe: PipeFn = ((...fns: UserFn[]) =>
    async (input: unknown): Promise<unknown> => {
      let value: unknown = input;
      for (const fn of fns) {
        value = await runOne(fn, [value], undefined);
      }
      return value;
    }) as unknown as PipeFn;

  const fake: IPool<B, Record<string, unknown>> = {
    async submit<A extends unknown[], R>(
      fn: (...args: [...A, B & { signal: AbortSignal }]) => R | Promise<R>,
      ...rest: [...A] | [...A, SubmitOptions]
    ): Promise<Awaited<R>> {
      const { args, opts: o } = splitOpts(rest);
      return (await runOne(fn as UserFn, args, o)) as Awaited<R>;
    },
    async submitSource<R>(fnSource: string, args: unknown[], o?: SubmitOptions): Promise<R> {
      // Fake: parse the source synchronously via Function constructor —
      // the fake runs in Bun where Function() is allowed. Production
      // ships the source straight to the loader.
      const fn = new Function('return (' + fnSource + ')')() as UserFn;
      return (await runOne(fn, args, o)) as R;
    },
    async map<T, R>(
      fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
      items: T[],
      mopts?: MapOptions,
    ): Promise<Awaited<R>[]> {
      return fan<T, Awaited<R>>(
        fn as UserFn,
        items,
        mopts?.onError ?? 'throw',
        mopts?.cancel,
        mopts,
      );
    },
    async scatter<T, R>(
      fn: (items: T[], env: B & { signal: AbortSignal }) => R | Promise<R>,
      items: T[],
      chunks: number,
      sopts?: ScatterOptions,
    ): Promise<Awaited<R>[]> {
      const chunkSize = Math.ceil(items.length / chunks);
      const batches: T[][] = [];
      for (let i = 0; i < items.length; i += chunkSize) batches.push(items.slice(i, i + chunkSize));
      return fan<T[], Awaited<R>>(
        fn as UserFn,
        batches,
        sopts?.onError ?? 'throw',
        sopts?.cancel,
        sopts,
      );
    },
    async reduce<T>(
      fn: (a: T, b: T, env: B & { signal: AbortSignal }) => T | Promise<T>,
      items: T[],
      initial: T,
    ): Promise<Awaited<T>> {
      let cur: T[] = [initial, ...items];
      while (cur.length > 1) {
        const next: T[] = [];
        for (let i = 0; i < cur.length; i += 2) {
          if (i + 1 < cur.length) {
            next.push((await runOne(fn as UserFn, [cur[i], cur[i + 1]])) as T);
          } else {
            next.push(cur[i]);
          }
        }
        cur = next;
      }
      return cur[0] as Awaited<T>;
    },
    pmap<T, R>(
      fn: (batch: T[], env: B & { signal: AbortSignal }) => R[] | Promise<R[]>,
    ): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]> {
      return async (items: T[], popts?: PmapOptions): Promise<Awaited<R>[]> => {
        const numChunks = popts?.chunks ?? items.length;
        const chunkSize = Math.ceil(items.length / numChunks);
        const chunks: T[][] = [];
        for (let i = 0; i < items.length; i += chunkSize) {
          chunks.push(items.slice(i, i + chunkSize));
        }
        const results = await Promise.all(chunks.map((c) => runOne(fn as UserFn, [c])));
        return (results as Awaited<R>[][]).flat();
      };
    },
    pipe,
    gather<T>(p: Promise<T>[]): Promise<T[]> {
      return Promise.all(p);
    },
    async *mapStream<T, R>(
      fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
      items: T[],
      mopts?: StreamOptions,
    ): AsyncIterable<StreamResult<Awaited<R>>> {
      for (let i = 0; i < items.length; i++) {
        const value = await runOne(fn as UserFn, [items[i]], mopts);
        yield { index: i, value: value as Awaited<R> };
      }
    },
    async *mapOrdered<T, R>(
      fn: (item: T, env: B & { signal: AbortSignal }) => R | Promise<R>,
      items: T[],
      mopts?: StreamOptions,
    ): AsyncIterable<Awaited<R>> {
      for (let i = 0; i < items.length; i++) {
        const value = await runOne(fn as UserFn, [items[i]], mopts);
        yield value as Awaited<R>;
      }
    },
    async submitStream<A extends unknown[], R>(
      fn: (
        ...args: [...A, B & { signal: AbortSignal }]
      ) => ReadableStream<R> | Promise<ReadableStream<R>>,
      ...rest: [...A] | [...A, SubmitOptions]
    ): Promise<ReadableStream<R>> {
      const { args, opts: o } = splitOpts(rest);
      return (await runOne(fn as UserFn, args, o)) as ReadableStream<R>;
    },
    async warm(_o?: { isolates?: number }): Promise<void> {
      return;
    },
    async drain(): Promise<void> {
      return;
    },
    async stats(): Promise<PoolStats> {
      return {
        completed,
        failed,
        cancelled: cancelledCount,
        inFlight: 0,
        queued: 0,
        topology: 'in-do',
        topologyDecisionAt: 0,
        warmIsolatesEstimate: 0,
        uniqueFnShapesToday: fnShapes.size,
        lruEvictionLast60sCount: 0,
        treeDepth: 1,
        fanOutPerLevel: [],
      };
    },
    handle(_o: {
      policy: SubmitCodePolicy<B>;
      parse?: (req: Request) => Promise<{ fn: string; args: unknown[]; options?: SubmitOptions }>;
      format?: (result: unknown) => Response;
    }): (req: Request) => Promise<Response> {
      // Testing fake: there is no real HTTP transport. Return a stub
      // handler so tests can still wire things up; it dispatches via the
      // fake's runOne.
      return async (req: Request): Promise<Response> => {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        const body = (await req.json()) as { fn: string; args?: unknown[] };
        const fn = new Function('return (' + body.fn + ')')() as UserFn;
        try {
          const value = await runOne(fn, body.args ?? []);
          return Response.json({ ok: true, value });
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          return Response.json(
            { ok: false, error: { name: e.name, message: e.message } },
            { status: 500 },
          );
        }
      };
    },
    restrictTo(allow: ReadonlyArray<string>): IPool<B, Record<string, unknown>> {
      const filtered: Record<string, unknown> = {};
      for (const key of allow) {
        if (key in bindings) filtered[key] = (bindings as Record<string, unknown>)[key];
      }
      return poolFake<B>({ ...opts, bindings: filtered as B });
    },
  };
  return fake;
}

export function loaderOnlyFake<B extends Record<string, unknown>>(
  opts: FakeOpts<B> & LoaderOnlyOptions<B> = {} as never,
): LoaderOnlyPool<B> {
  // The fake's interface is a strict subset of poolFake's; safe to upcast.
  const fake = poolFake<B>(opts as FakeOpts<B>);
  return {
    submit: fake.submit.bind(fake),
    map: fake.map.bind(fake),
    reduce: fake.reduce.bind(fake),
    scatter: fake.scatter.bind(fake),
    gather: fake.gather.bind(fake),
    pmap: fake.pmap.bind(fake),
  };
}

export function actorFake<State extends Record<string, unknown>, B extends Record<string, unknown>>(
  opts: FakeOpts<B> & ActorOptions<State, B>,
): IActorHandle<State, B, Record<string, unknown>> {
  let state: State = opts.initialState ?? ({} as State);
  // Serial submit chain — production actors are DO-serialized; the fake
  // must match. Without this, two concurrent fake.submit() calls would
  // race on `state`.
  let chain: Promise<void> = Promise.resolve();
  const fake: IActorHandle<State, B, Record<string, unknown>> = {
    submit<A extends unknown[], R>(
      fn: (
        state: State,
        sql: SqlStorage | null,
        ...rest: [...A, B & { signal: AbortSignal }]
      ) => R | Promise<R>,
      ...rest: [...A] | [...A, SubmitOptions]
    ): Promise<Awaited<R>> {
      const next: Promise<Awaited<R>> = chain.then(async (): Promise<Awaited<R>> => {
        const { args, opts: o } = splitOpts(rest);
        const signal: AbortSignal = o?.cancel ? o.cancel.signal : new AbortController().signal;
        const env = { ...(opts.bindings ?? {}), signal } as B & { signal: AbortSignal };
        const cloned = structuredClone(state);
        const result = await fn(cloned, null, ...(args as A), env);
        state = structuredClone(cloned);
        rejectIfRpcStub(result);
        return validateReturn(result) as Awaited<R>;
      });
      // Keep the chain alive even if `next` rejects, so subsequent
      // submits still run (mirrors DO behavior of one-failure-per-submit).
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async close() {
      // Wait for any in-flight submit to settle before clearing state.
      await chain.catch(() => undefined);
      state = {} as State;
    },
    async evict() {
      return;
    },
  };
  return fake;
}

export function schedulerFake<B extends Record<string, unknown>>(
  opts: FakeOpts<B> & SchedulerOptions<B>,
): IScheduler<B, Record<string, unknown>> {
  interface Entry {
    id: string;
    status: JobStatus;
    value?: unknown;
    error?: unknown;
    /** Resolved on terminal status. */
    settle: Deferred<void>;
  }
  const jobs = new Map<string, Entry>();
  let counter = 0;
  let drainBarrier: Deferred<void> | undefined;
  const checkDrain = (): void => {
    if (!drainBarrier) return;
    if (![...jobs.values()].some((e) => e.status === 'queued' || e.status === 'running')) {
      const b = drainBarrier;
      drainBarrier = undefined;
      b.resolve();
    }
  };
  return {
    async enqueue<A extends unknown[], R>(job: Job<A, R>): Promise<JobHandle<R>> {
      const id = `j-${counter++}`;
      const entry: Entry = { id, status: 'queued', settle: deferred<void>() };
      jobs.set(id, entry);
      // Run inline.
      void (async () => {
        entry.status = 'running';
        try {
          const r = await job.fn(...(job.args as A));
          entry.status = 'done';
          entry.value = structuredClone(r);
        } catch (err) {
          entry.status = 'failed';
          entry.error = errorToFailedResult(err);
        } finally {
          entry.settle.resolve();
          checkDrain();
        }
      })();
      void opts;
      const handle: JobHandle<R> = {
        id,
        async result(): Promise<R> {
          if (entry.status === 'queued' || entry.status === 'running' || entry.status === 'leased') {
            await entry.settle.promise;
          }
          if (entry.status === 'done') return entry.value as R;
          throw wireToError(
            (entry.error as { error: { name: string; message: string; stack?: string } }).error,
          );
        },
        async status() {
          return entry.status === 'leased' ? 'running' : entry.status;
        },
        async cancel() {
          entry.status = 'cancelled';
          entry.settle.resolve();
          checkDrain();
        },
      };
      return handle;
    },
    async cancelByTenant(_t) {
      return 0;
    },
    async drain() {
      if (![...jobs.values()].some((e) => e.status === 'queued' || e.status === 'running')) {
        return;
      }
      if (!drainBarrier) drainBarrier = deferred<void>();
      return drainBarrier.promise;
    },
    async stats(): Promise<SchedulerStats> {
      const out = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
      for (const e of jobs.values()) {
        if (e.status === 'queued') out.queued++;
        else if (e.status === 'running' || e.status === 'leased') out.running++;
        else if (e.status === 'done') out.done++;
        else if (e.status === 'failed') out.failed++;
        else if (e.status === 'cancelled') out.cancelled++;
      }
      return {
        inFlight: out.running,
        queued: out.queued,
        completed: out.done,
        failed: out.failed,
        cancelled: out.cancelled,
        topology: 'in-do',
        topologyDecisionAt: 0,
        warmIsolatesEstimate: 0,
        uniqueFnShapesToday: 0,
        lruEvictionLast60sCount: 0,
        treeDepth: 1,
        fanOutPerLevel: [],
        byTenant: {},
        oldestQueuedAgeMs: 0,
        resultRetentionTtlMs: opts.resultRetention?.ttlMs ?? 3_600_000,
      };
    },
    attachQueue(_q: unknown): void {
      // testing fake: no-op
    },
    async configure(c) {
      // testing fake: echo merged config; the fake doesn't actually run
      // a dispatcher.
      const merged = {
        inFlightLimit: c.inFlightLimit ?? 32,
        maxQueueDepth: c.maxQueueDepth ?? Number.POSITIVE_INFINITY,
        fairCapacityPerTenant: c.fairCapacityPerTenant ?? 4,
        resultTtlMs: c.resultTtlMs ?? 3_600_000,
        defaultLeaseMs: c.defaultLeaseMs ?? 60_000,
      };
      return merged;
    },
  };
}

interface FakeVM {
  fetch(req: Request): Promise<Response>;
}

export function vmFake<B extends Record<string, unknown>>(
  opts: FakeOpts<B> & VMOptions<B>,
): FakeVM {
  // Honor both shapes: legacy `pool: { bindings }` and the flat
  // VMOptions extends PoolOptions shape.
  const bindings = (opts.pool?.bindings ?? opts.bindings ?? ({} as B)) as B;
  const fakePool = poolFake<B>({ bindings });
  return {
    async fetch(req: Request): Promise<Response> {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (opts.auth) {
        const ok = await opts.auth(req);
        if (!ok) return new Response('Unauthorized', { status: 401 });
      }
      const body = (await req.json()) as { fn: string; args?: unknown[] };
      const fn = new Function('return (' + body.fn + ')')() as (
        ...args: unknown[]
      ) => unknown | Promise<unknown>;
      try {
        const value = await fakePool.submit(fn, ...(body.args ?? []));
        return Response.json({ ok: true, value });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        return Response.json(
          { ok: false, error: { name: e.name, message: e.message } },
          { status: 500 },
        );
      }
    },
  };
}
