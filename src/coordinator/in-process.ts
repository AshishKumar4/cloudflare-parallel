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

/**
 * In-process coordinator — `ctx.exports` loopback target.
 *
 * Single-job fast path. For `submit()` calls (and the rare `pool.map([x],
 * fn)` of size = 1), the library skips the Coordinator DO entirely and
 * routes through this WorkerEntrypoint. The loopback stays inside the
 * same Worker process and bypasses Durable Object routing — typical
 * dispatch overhead drops from tens of milliseconds (DO RPC over the
 * network) to a couple of milliseconds (same-process Cap'n Proto).
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
 * **Why only N=1.** Loaders inside a single workerd process share that
 * process's V8 scheduler thread — fan-outs of N concurrent loaders here
 * serialize on CPU even with distinct cache keys. Real parallelism comes
 * from leaf DOs, each running as its own workerd process. Fan-outs of
 * size ≥ 2 therefore route through the Coordinator DO to the hybrid
 * topology (one job per leaf DO) instead of through this loopback.
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
      // `'do-method'` (cap = 4 concurrent loaders), NOT
      // `'fetch-handler'` (cap = 3). The loopback is a
      // `WorkerEntrypoint` invoked via `ctx.exports`, which is
      // semantically a DO-method-equivalent dispatch surface — the
      // call lands inside an isolate that's already been spun up, not
      // a fresh `fetch` event handler.
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
        // Honor the caller's slot if set; default to 0 so single-shot
        // submits share the slot-0 isolate as a future `map`'s first
        // task. See `src/loader/cache-key.ts` for the slot↔isolate
        // mapping.
        taskSlot: request.taskSlot ?? 0,
        cancelStream: request.cancelStream,
      });
      return { ok: true, value };
    } catch (err) {
      return errorToFailedResult(err);
    }
  }

  /**
   * Single-job fan-out path. Refuses size > 1: loaders inside the
   * loopback's own V8 process share its scheduler thread, so larger
   * fan-outs must go through the Coordinator DO to spread across
   * separate leaf DO processes. The pool router enforces this — see
   * `Pool.#runManyTarget` — but we double-check here to surface
   * misuse loudly if a caller hits the binding directly.
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
    if (size > 1) {
      throw new Error(
        `CfpInProcessCoordinator.runMany: size=${size} unsupported; the loopback ` +
          `is single-job only. Fan-outs of size ≥ 2 must route through CfpCoordinator ` +
          `so each task lands in its own leaf DO process for real CPU parallelism.`,
      );
    }
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      callSite: 'do-method',
      cacheKeyStrategy: request.cacheKeyStrategy ?? 'stable',
      workerOptions: wireToWorkerOptions(
        request.workerOptions,
        this.env as unknown as Record<string, unknown>,
      ),
    });
    try {
      const value = await runner.runOne({
        fnSource: request.fnSource,
        fnHash: request.fnHash,
        context: request.context,
        bindings: this.env as unknown as Record<string, unknown>,
        envelope: { ...request.envelope, mode: 'pool-fn' as const },
        args: request.argsList[0],
        freshIsolate: request.freshIsolate,
        taskSlot: 0,
        cancelStream: request.cancelStream,
      });
      return {
        results: [{ ok: true, value }],
        topology: 'in-do',
        fanOutPerLevel: [1],
        treeDepth: 1,
      };
    } catch (err) {
      return {
        results: [errorToFailedResult(err)],
        topology: 'in-do',
        fanOutPerLevel: [1],
        treeDepth: 1,
      };
    }
  }
}
