import { WorkerEntrypoint } from 'cloudflare:workers';
import type { WorkerLoader } from '../types';
import { LoaderRunner } from '../loader/runner';
import {
  errorToFailedResult,
  type CoordinatorFanOutRequest,
  type CoordinatorRunRequest,
  type RunOneResult,
} from './protocol';
import { wireToWorkerOptions } from './internal';
import { forkCancelStream } from '../transport/cancel-stream';

/**
 * In-process coordinator — `ctx.exports` loopback target.
 *
 * For small fan-outs (size ≤ 4) and single-shot submits, the library skips
 * the Coordinator DO entirely and routes through this WorkerEntrypoint. The
 * loopback stays inside the same Worker process and bypasses Durable Object
 * routing — typical dispatch overhead drops from tens of milliseconds (DO
 * RPC over the network) to a couple of milliseconds (same-process Cap'n
 * Proto).
 *
 * Wire it up by re-exporting this class from your Worker entrypoint and
 * passing `ctx.exports.CfpInProcessCoordinator` via {@link Parallel.pool}'s
 * `inProcess` option:
 *
 *     import { CfpInProcessCoordinator } from 'cloudflare-parallel/durable-objects';
 *     export { CfpInProcessCoordinator };
 *
 *     export default {
 *       async fetch(req, env, ctx) {
 *         const pool = Parallel.pool(env, {
 *           inProcess: ctx.exports.CfpInProcessCoordinator,
 *         });
 *         // ...
 *       }
 *     };
 *
 * Size > 4 fan-outs still flow through the DO Coordinator (which fans out
 * across leaf DOs to compose 4N parallelism). The in-process coordinator is
 * a pure dispatch shortcut for the in-DO topology — the loaded Worker
 * isolates are still the unit of parallelism.
 *
 * Reference: https://developers.cloudflare.com/workers/runtime-apis/context/
 */
export interface InProcessCoordinatorEnv {
  LOADER: WorkerLoader;
  // The user's bindings flow through this env directly. Library DO bindings
  // are stripped by `sanitizeBindings` inside the loader.
  [key: string]: unknown;
}

export class CfpInProcessCoordinator extends WorkerEntrypoint<InProcessCoordinatorEnv> {
  /** Single-shot submit. Mirror of `CfpCoordinator.runOne`. */
  async runOne(request: CoordinatorRunRequest): Promise<RunOneResult> {
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      // `'do-method'` (cap = 4 concurrent loaders), NOT `'fetch-handler'`
      // (cap = 3). The loopback is a `WorkerEntrypoint` invoked via
      // `ctx.exports`, which is semantically a DO-method-equivalent
      // dispatch surface — the call lands inside an isolate that's
      // already been spun up, not a fresh `fetch` event handler. Using
      // the fetch-handler cap here silently caps N=4 fan-out at 3
      // concurrent loaders + 1 queued, costing ~25% of the achievable
      // parallelism and surfacing as a "N=4 is barely faster than
      // sequential" complaint.
      callSite: 'do-method',
      cacheKeyStrategy: request.cacheKeyStrategy ?? 'stable',
      workerOptions: wireToWorkerOptions(
        request.workerOptions,
        this.env as unknown as Record<string, unknown>,
      ),
      allowList: request.allowList,
    });
    try {
      const value = await runner.runOne({
        fnSource: request.fnSource,
        fnHash: request.fnHash,
        context: request.context,
        bindings: this.env as unknown as Record<string, unknown>,
        envelope: { ...request.envelope, mode: 'pool-fn' as const },
        args: request.args,
        freshIsolate: request.freshIsolate,
        cancelStream: request.cancelStream,
      });
      return { ok: true, value };
    } catch (err) {
      return errorToFailedResult(err);
    }
  }

  /**
   * In-DO fan-out (≤ 4 items). Sized identically to `CfpCoordinator`'s
   * in-DO path — the Worker Loader's per-isolate concurrent-loader cap
   * caps this at 4. Caller is expected to route only `size ≤ 4` here.
   */
  async runMany(request: CoordinatorFanOutRequest): Promise<{
    results: RunOneResult[];
    topology: 'in-do';
    fanOutPerLevel: number[];
    treeDepth: number;
  }> {
    const size = request.argsList.length;
    if (size === 0) {
      return { results: [], topology: 'in-do', fanOutPerLevel: [], treeDepth: 1 };
    }
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      // See `runOne` for the rationale — `'do-method'` is the correct
      // cap for the loopback's dispatch surface.
      callSite: 'do-method',
      cacheKeyStrategy: request.cacheKeyStrategy ?? 'stable',
      workerOptions: wireToWorkerOptions(
        request.workerOptions,
        this.env as unknown as Record<string, unknown>,
      ),
    });
    const childStreams = forkCancelStream(request.cancelStream, request.argsList.length);
    const results = await Promise.all(
      request.argsList.map(async (args, i): Promise<RunOneResult> => {
        try {
          const value = await runner.runOne({
            fnSource: request.fnSource,
            fnHash: request.fnHash,
            context: request.context,
            bindings: this.env as unknown as Record<string, unknown>,
            envelope: { ...request.envelope, mode: 'pool-fn' as const },
            args,
            freshIsolate: request.freshIsolate,
            cancelStream: childStreams[i],
          });
          return { ok: true, value };
        } catch (err) {
          return errorToFailedResult(err);
        }
      }),
    );
    return { results, topology: 'in-do', fanOutPerLevel: [size], treeDepth: 1 };
  }
}
