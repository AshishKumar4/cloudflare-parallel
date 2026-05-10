import { Pool } from './pool';
import { LoaderOnlyPoolImpl, type LoaderOnlyPool } from './loader-only-pool';
import { ActorHandle } from './actor';
import { Scheduler } from './scheduler';
import { VM, vm, type VMHandle } from './vm';
import { poolFake, loaderOnlyFake, actorFake, schedulerFake, vmFake } from './testing';
import type {
  ActorOptions,
  LoaderOnlyOptions,
  PoolEnv,
  PoolOptions,
  SchedulerOptions,
  VMOptions,
} from './options';

/**
 * Top-level namespace. Each factory has a clear, narrow purpose:
 *
 *   - `Parallel.pool(env, opts)`         → full Pool with Coordinator DO
 *   - `Parallel.loaderOnly(env, opts)`   → type-narrowed loader-only (no DO)
 *   - `Parallel.actor(env, opts)`        → long-lived stateful actor
 *   - `Parallel.scheduler(env, opts)`    → heterogeneous job scheduler
 *   - `Parallel.vm(env, opts)`           → HTTP submit-code surface
 *   - `Parallel.testing.*`               → in-process fakes for unit tests
 *
 * `Parallel.VM` is the class form of `Parallel.vm`.
 */
export const Parallel = {
  /**
   * Construct a Pool. Requires a Worker Loader binding (`LOADER`) and the
   * `CfpCoordinator` DO binding in `env`. Returns a stateless façade —
   * cheap to construct per request.
   *
   * @example
   * export default {
   *   async fetch(req: Request, env: Env) {
   *     const pool = Parallel.pool(env, { bindings: { AI: env.AI } });
   *     return pool.handle({ policy: { kind: 'auth', auth: bearerAuth(env.SECRET) } })(req);
   *   }
   * }
   */
  pool<
    B extends Record<string, unknown> = Record<string, unknown>,
    C extends Record<string, unknown> = Record<string, unknown>,
  >(env: PoolEnv, opts?: PoolOptions<B, C>): Pool<B, C> {
    return new Pool<B, C>(env, opts);
  },

  /**
   * Loader-only pool — no Coordinator DO. Use for fire-and-forget
   * dispatches from the Worker fetch handler. Limited to 3 concurrent
   * loaders per fetch handler (documented runtime cap). Lacks `mapStream`,
   * `mapOrdered`, `submitStream`, `warm`, `drain`, `stats`, `handle`,
   * `restrictTo` — those require the coordinator.
   */
  loaderOnly<
    B extends Record<string, unknown> = Record<string, unknown>,
    C extends Record<string, unknown> = Record<string, unknown>,
  >(env: PoolEnv, opts?: LoaderOnlyOptions<B, C>): LoaderOnlyPool<B, C> {
    return new LoaderOnlyPoolImpl<B, C>(env, opts);
  },

  /**
   * Long-lived stateful actor. State is pinned in the Coordinator DO's
   * SQLite. The user fn signature is `(state, sql, ...args, env)` —
   * mutate `state` in place; the runtime structured-clone-snapshots it
   * after each submit. 16 MiB structured-clone cap per submit.
   *
   * Requires `CfpCoordinator` DO binding.
   */
  actor<
    State extends Record<string, unknown> = Record<string, unknown>,
    B extends Record<string, unknown> = Record<string, unknown>,
    C extends Record<string, unknown> = Record<string, unknown>,
  >(env: PoolEnv, opts: ActorOptions<State, B, C>): ActorHandle<State, B, C> {
    return new ActorHandle<State, B, C>(env, opts);
  },

  /**
   * Heterogeneous job scheduler with retries / deadlines / fair-queueing
   * / per-tenant cancellation. Persistent (`do-storage` default; opt-in
   * `queues` / `d1` / custom `JobStore`). Reactive dispatch — no
   * alarm-batched delay. Requires `CfpSchedulerDO` binding.
   */
  scheduler<
    B extends Record<string, unknown> = Record<string, unknown>,
    C extends Record<string, unknown> = Record<string, unknown>,
  >(env: PoolEnv, opts: SchedulerOptions<B, C>): Scheduler<B, C> {
    return new Scheduler<B, C>(env, opts);
  },

  /**
   * Build an HTTP submit-code surface. Equivalent to
   * `Parallel.pool(env, opts.pool).handle({ policy: opts.policy })`.
   * `policy` is required — the library refuses to expose a default open
   * endpoint.
   */
  vm<B extends Record<string, unknown> = Record<string, unknown>>(
    env: PoolEnv,
    opts: VMOptions<B>,
  ): VMHandle {
    return vm<B>(env, opts);
  },

  /** Class form of {@link Parallel.vm} for `new Parallel.VM(...)` callers. */
  VM,

  /**
   * In-process fakes for unit tests. Same return types as production
   * (canonical `IPool` / `IActorHandle` / `IScheduler`); structured-clone
   * roundtrip on args catches non-cloneable values.
   *
   * Imported via `cloudflare-parallel/testing` (separate exports path
   * so production bundles don't pull in fakes).
   */
  testing: {
    poolFake,
    loaderOnlyFake,
    actorFake,
    schedulerFake,
    vmFake,
  },
} as const;
