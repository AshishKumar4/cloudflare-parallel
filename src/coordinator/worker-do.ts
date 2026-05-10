import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import type { WorkerLoader } from '../types.js';
import { LoaderRunner } from '../loader/runner.js';
import { errorToFailedResult, type RunBatchRequest, type RunBatchResult } from './protocol.js';
import { wireToWorkerOptions } from './internal.js';
import { forkCancelStream } from '../transport/cancel-stream.js';

/**
 * `CfpWorkerDO` — Hybrid-topology leaf.
 *
 * Receives a `RunBatchRequest` describing 1..4 jobs and runs each via
 * `env.LOADER.get(...)`. The DO's V8 isolate has its own per-isolate
 * concurrent-loader budget (cap=4 from a DO method, empirical caps).
 *
 * Each leaf RPC is independent of any other leaf: the parent Coordinator
 * fan-outs across N leaves and N's loader budgets compose to 4N.
 */
export interface WorkerDOEnv {
  LOADER: WorkerLoader;
}

export class CfpWorkerDO extends DurableObject<WorkerDOEnv> {
  async runBatch(request: RunBatchRequest): Promise<RunBatchResult> {
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      callSite: 'do-method',
      cacheKeyStrategy: request.cacheKeyStrategy ?? 'auto',
      workerOptions: wireToWorkerOptions(request.workerOptions, this.env as unknown as Record<string, unknown>),
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
            bindings: this.env as unknown as Record<string, unknown>,
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
}

/**
 * Tiny WorkerEntrypoint shim so the DO is also addressable as a service
 * binding (some runtime configurations prefer service bindings over DO
 * namespaces for inter-Worker dispatch). Optional; default API uses DO.
 */
export class CfpWorkerDOEntry extends WorkerEntrypoint<WorkerDOEnv> {}
