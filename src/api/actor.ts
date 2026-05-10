import { BindingError, MissingBindingError } from '../errors/index';
import { hashSource, serializeFunction } from '../loader/serialize';
import type { UserFn } from './user-fn';
import { workerOptionsToWire } from '../coordinator/internal';
import { buildEnvelope } from '../transport/deadline-prop';
import { dispatchWithResilience } from '../transport/rpc-client';
import type { ActorOptions, PoolEnv, SubmitOptions } from './options';

import type {
  CoordinatorRunRequest,
  DispatchEnvelope,
  RunOneResult,
} from '../coordinator/protocol';
import { wireToError } from './error-decode';
import { splitSubmitOptions } from './loader-only-pool';

interface ActorCoordinatorStub {
  actorEnsureInitialized(state: unknown): Promise<void>;
  actorSubmit(req: {
    fnSource: string;
    fnHash: string;
    args: unknown[];
    context?: Record<string, unknown>;
    workerOptions?: CoordinatorRunRequest['workerOptions'];
    cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
    envelope: DispatchEnvelope;
  }): Promise<RunOneResult>;
  actorClose(): Promise<void>;
}

/**
 * Public ActorHandle interface — implemented by both {@link ActorHandle}
 * (the production class) and the testing fake (`Parallel.testing.actorFake`).
 */
export interface IActorHandle<
  State extends Record<string, unknown>,
  B extends Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  C extends Record<string, unknown> = Record<string, unknown>,
> {
  submit<A extends unknown[], R>(
    fn: (
      state: State,
      sql: SqlStorage | null,
      ...rest: [...A, B & { signal: AbortSignal }]
    ) => R | Promise<R>,
    ...rest: [...A] | [...A, SubmitOptions]
  ): Promise<Awaited<R>>;
  close(): Promise<void>;
  evict(opts?: { persist?: boolean }): Promise<void>;
}

/**
 * Long-lived stateful actor. State is pinned in the Coordinator DO's SQLite;
 * user fn receives `(state, sql, ...args, env)` per ADR-7.
 *
 * 16 MiB structured-clone cap on state; recommend Workflows or sub-id
 * partitioning for larger state.
 */
export class ActorHandle<
  State extends Record<string, unknown>,
  B extends Record<string, unknown>,
  _C extends Record<string, unknown>,
> implements IActorHandle<State, B, _C> {
  readonly #env: PoolEnv;
  readonly #opts: ActorOptions<State, B, _C>;
  #initialized = false;

  constructor(env: PoolEnv, opts: ActorOptions<State, B, _C>) {
    if (!env.LOADER || typeof env.LOADER.get !== 'function') {
      throw new BindingError(
        'Parallel.actor() requires a Worker Loader binding. ' +
          'Add `[[worker_loaders]]\\nbinding = "LOADER"` to wrangler.toml.',
      );
    }
    if (!env.CfpCoordinator) {
      throw new MissingBindingError('CfpCoordinator');
    }
    if (!opts.id) {
      throw new BindingError('Parallel.actor() requires `opts.id`');
    }
    this.#env = env;
    this.#opts = opts;
  }

  #stub(): ActorCoordinatorStub {
    const ns = this.#env.CfpCoordinator!;
    // Per-actor DO instance keyed on `actor:${id}`.
    return ns.get(ns.idFromName(`actor:${this.#opts.id}`)) as unknown as ActorCoordinatorStub;
  }

  /**
   * Submit a fn to run against this actor's pinned state.
   *
   * The fn signature is `(state, sql, ...args, env)` — mutate `state`
   * in place; the runtime takes a `structuredClone()` of state on
   * success and persists it. `sql` is the actor DO's `SqlStorage` for
   * larger-than-state datasets.
   *
   * On the first submit, the actor lazily initializes from
   * `opts.initialState`.
   *
   * @throws BindingError if the actor's `id` is not configured.
   * @throws ExecutionError if the user fn throws.
   * @throws CancelledError if the cancel token fires.
   */
  async submit<A extends unknown[], R>(
    fn: (
      state: State,
      sql: SqlStorage | null,
      ...rest: [...A, B & { signal: AbortSignal }]
    ) => R | Promise<R>,
    ...rest: [...A] | [...A, SubmitOptions]
  ): Promise<Awaited<R>> {
    if (!this.#initialized) {
      await this.#stub().actorEnsureInitialized(this.#opts.initialState ?? {});
      this.#initialized = true;
    }
    const { args, opts } = splitSubmitOptions(rest);
    const fnSource = serializeFunctionAllowingState(fn);
    const fnHash = hashSource(fnSource);
    const envelope = buildEnvelope({
      cancel: opts?.cancel,
      deadline: opts?.deadline,
      deadlineMs: opts?.deadlineMs,
      mode: 'actor-class',
    });

    const stub = this.#stub();
    const result = await dispatchWithResilience<RunOneResult>(
      () =>
        stub.actorSubmit({
          fnSource,
          fnHash,
          args,
          context: this.#opts.context as Record<string, unknown> | undefined,
          workerOptions: workerOptionsToWire({
            compatibilityDate: this.#opts.workerOptions?.compatibilityDate,
            compatibilityFlags: this.#opts.workerOptions?.compatibilityFlags,
            globalOutbound:
              this.#opts.globalOutbound !== undefined
                ? this.#opts.globalOutbound
                : this.#opts.workerOptions?.globalOutbound,
            limits: this.#opts.limits ?? this.#opts.workerOptions?.limits,
          }),
          cacheKeyStrategy: this.#opts.cacheKeyStrategy ?? 'stable',
          envelope,
        }),
      {
        timeout: opts?.timeout ?? this.#opts.timeout,
        retries: opts?.retries ?? this.#opts.retries ?? 0,
        retryDelay: opts?.retryDelay ?? this.#opts.retryDelay ?? 100,
        cancel: opts?.cancel,
        deadlineEpochMs: envelope.deadlineEpochMs || undefined,
      },
    );
    if (!result.ok) throw wireToError(result.error);
    return result.value as Awaited<R>;
  }

  /**
   * Tear down the actor — clear state in the coordinator DO's storage.
   * Subsequent `submit` calls will re-initialize from `opts.initialState`.
   */
  async close(): Promise<void> {
    await this.#stub().actorClose();
    this.#initialized = false;
  }

  /**
   * Best-effort hibernation hint. DO hibernation is runtime-driven (no
   * explicit "hibernate now" primitive in the runtime today); the call is a
   * no-op kept for forward-compat. State persists across hibernation
   * cycles via DO storage.
   */
  async evict(_opts?: { persist?: boolean }): Promise<void> {
    return;
  }
}

/**
 * Like `serializeFunction` but allows `(state, sql, ...args)` shape — the
 * actor codegen path receives state/sql as positional args, NOT via `this`.
 * The v0.2 `this`-rejection still applies at the user-fn boundary.
 */
function serializeFunctionAllowingState(fn: UserFn): string {
  return serializeFunction(fn);
}
