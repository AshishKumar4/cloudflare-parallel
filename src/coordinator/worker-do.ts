import { DurableObject, RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import type { WorkerLoader } from '../types';
import { LoaderRunner } from '../loader/runner';
import { errorToFailedResult, type RunBatchRequest, type RunBatchResult } from './protocol';
import { wireToWorkerOptions } from './internal';
import { forkCancelStream } from '../transport/cancel-stream';

/**
 * `CfpWorkerDO` — Hybrid-topology leaf.
 *
 * Receives a `RunBatchRequest` describing 1..4 jobs and runs each via
 * `env.LOADER.get(...)`. The DO's V8 isolate has its own per-isolate
 * concurrent-loader budget (cap=4 from a DO method, empirical caps).
 *
 * Each leaf RPC is independent of any other leaf: the parent Coordinator
 * fan-outs across N leaves and N's loader budgets compose to 4N.
 *
 * **Promise pipelining.** Callers can obtain a long-lived
 * {@link WorkerDOSession} via `stub.openSession()` and chain
 * `runBatch(...)` calls on the session without awaiting between calls. The
 * runtime's RPC pipeline (Cap'n Proto promise pipelining) collapses chained
 * calls on the same session into a single round-trip. The Coordinator
 * uses this for hybrid/tree fan-out so each leaf DO is exercised through
 * a single Cap'n Proto session per request.
 *
 * Reference: https://developers.cloudflare.com/workers/runtime-apis/rpc/
 */
export interface WorkerDOEnv {
  LOADER: WorkerLoader;
}

/**
 * Long-lived per-leaf session returned by `openSession`. Methods invoked
 * on this target ride the same RPC session as the call that produced
 * it, enabling promise pipelining and amortizing routing setup across
 * multiple calls in a single request.
 */
export class WorkerDOSession extends RpcTarget {
  readonly #env: WorkerDOEnv;
  constructor(env: WorkerDOEnv) {
    super();
    this.#env = env;
  }

  async runBatch(request: RunBatchRequest): Promise<RunBatchResult> {
    return runBatchOnEnv(this.#env, request);
  }

  /**
   * No-op used by the prewarm pass. Returns immediately; intentionally
   * does no storage I/O and dispatches no loader calls. The first call
   * to a freshly-created leaf DO pays a one-time DO-creation cost
   * (empirically ~300–400 ms in production); calling `noop()` in
   * parallel with the real workload dispatch lets the DO finish creating
   * while the application's first method call rides the warm channel.
   */
  async noop(): Promise<void> {
    /* intentionally empty */
  }
}

export class CfpWorkerDO extends DurableObject<WorkerDOEnv> {
  /**
   * Open a pipelinable session against this leaf. Subsequent calls on
   * the returned target reuse the same RPC session — the second method
   * invocation is sent without waiting for `openSession()` to resolve,
   * collapsing N method calls into one round-trip.
   */
  openSession(): WorkerDOSession {
    return new WorkerDOSession(this.env);
  }

  /** Direct call form (kept for backward compat / single-batch dispatch). */
  async runBatch(request: RunBatchRequest): Promise<RunBatchResult> {
    return runBatchOnEnv(this.env, request);
  }

  /**
   * No-op prewarm method. The first RPC against a freshly-created DO
   * pays a one-time creation cost (empirically ~300–400 ms in
   * production). Library-level prewarm fires `noop()` in parallel with
   * the real fan-out so the DO finishes creating while the workload's
   * first call rides the warm channel.
   *
   * Per-call cold→warm speedup measured at 14×–140×: ~380 ms cold,
   * ~3–30 ms warm. Cost: zero (parallelized with real dispatch).
   */
  async noop(): Promise<void> {
    /* intentionally empty */
  }
}

/**
 * Internal: shared between `CfpWorkerDO.runBatch` and the pipelinable
 * `WorkerDOSession.runBatch`.
 */
async function runBatchOnEnv(
  env: WorkerDOEnv,
  request: RunBatchRequest,
): Promise<RunBatchResult> {
  const runner = new LoaderRunner({
    loader: env.LOADER,
    callSite: 'do-method',
    cacheKeyStrategy: request.cacheKeyStrategy ?? 'stable',
    workerOptions: wireToWorkerOptions(
      request.workerOptions,
      env as unknown as Record<string, unknown>,
    ),
  });

  // Fork the upstream cancel stream so each of the 4 in-DO loaders gets
  // its own single-reader copy. Live cancel propagates to all of them.
  const childStreams = forkCancelStream(request.cancelStream, request.argsList.length);

  // The 4-loader cap is enforced by `LoaderRunner` (semaphore) — we can
  // safely Promise.all here; the semaphore queues anything beyond cap.
  const results = await Promise.all(
    request.argsList.map(async (args, i) => {
      try {
        const value = await runner.runOne({
          fnSource: request.fnSource,
          fnHash: request.fnHash,
          context: request.context,
          // Inherit the DO's own bindings (the user-Worker env merged into
          // the DO via wrangler.toml). Library-internal bindings are
          // filtered by sanitizeBindings inside runOne.
          bindings: env as unknown as Record<string, unknown>,
          envelope: {
            ...request.envelope,
            cancelTokenId: undefined,
            mode: 'pool-fn' as const,
          },
          args,
          freshIsolate: request.freshIsolate,
          cancelStream: childStreams[i],
        });
        return { ok: true as const, value };
      } catch (err) {
        return errorToFailedResult(err);
      }
    }),
  );
  return { results };
}

/**
 * Tiny WorkerEntrypoint shim so the DO is also addressable as a service
 * binding (some runtime configurations prefer service bindings over DO
 * namespaces for inter-Worker dispatch). Optional; default API uses DO.
 */
export class CfpWorkerDOEntry extends WorkerEntrypoint<WorkerDOEnv> {}
