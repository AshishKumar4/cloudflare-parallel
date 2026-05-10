import { DurableObject } from 'cloudflare:workers';
import {
  errorToFailedResult,
  type DispatchTreeRequest,
  type DispatchTreeResult,
  type RunOneResult,
  type RunBatchRequest,
} from './protocol.js';
import type { WorkerLoader } from '../types.js';
import { getStub } from './internal.js';
import { forkCancelStream } from '../transport/cancel-stream.js';

/**
 * `CfpSubCoord` — Mid-tier of the hierarchical tree topology.
 *
 * Receives a `DispatchTreeRequest` slice and either:
 *   - At depth=1: fans out to `CfpWorkerDO` leaves (hybrid leaves).
 *   - At depth>1: fans out to peer `CfpSubCoord` instances (deeper tier).
 *
 * Per-tier RPC fan-out is bounded by `maxFanOut` (default 32 per coord level).
 */
export interface SubCoordEnv {
  LOADER: WorkerLoader;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

interface WorkerDOStub {
  runBatch(req: RunBatchRequest): Promise<{ results: RunOneResult[] }>;
}

interface SubCoordStub {
  dispatch(req: DispatchTreeRequest): Promise<DispatchTreeResult>;
}

export class CfpSubCoord extends DurableObject<SubCoordEnv> {
  #requestCounter = 0;

  async dispatch(request: DispatchTreeRequest): Promise<DispatchTreeResult> {
    const reqIdx = ++this.#requestCounter;
    void reqIdx;
    const { argsList, planChildSizes, depth, branchingFactor } = request;

    // Slice argsList per child according to planChildSizes.
    let cursor = 0;
    const slices: unknown[][][] = [];
    for (const childSize of planChildSizes) {
      slices.push(argsList.slice(cursor, cursor + childSize));
      cursor += childSize;
    }

    // Fork upstream cancel stream per child slice.
    const childCancelStreams = forkCancelStream(request.cancelStream, slices.length);

    // Dispatch each child in parallel.
    const childPromises = slices.map(async (slice, i): Promise<RunOneResult[]> => {
      if (slice.length === 0) return [];
      try {
        if (depth <= 1) {
          // Hybrid leaf: ceil(slice/4) WorkerDOs × 4 loaders each.
          return await this.#dispatchHybridLeaf(request, slice, i, reqIdx, childCancelStreams[i]);
        } else {
          // Recurse into a deeper sub-coord.
          const nextChildSizes = balancedFillForTree(slice.length, branchingFactor);
          const subId = `${this.ctx.id.toString()}-r${reqIdx}-sub-${i}`;
          const stub = getStub<SubCoordStub>(this.env.CfpSubCoord, subId);
          const result = await stub.dispatch({
            ...request,
            argsList: slice,
            planChildSizes: nextChildSizes,
            depth: depth - 1,
            cancelStream: childCancelStreams[i],
          });
          return result.results;
        }
      } catch (err) {
        // Whole-slice failure: fan out the error across slice indices.
        return slice.map(() => errorToFailedResult(err));
      }
    });

    const childResults = await Promise.all(childPromises);
    // Flatten in plan-order.
    const flat: RunOneResult[] = [];
    for (const r of childResults) flat.push(...r);
    return { results: flat };
  }

  async #dispatchHybridLeaf(
    request: DispatchTreeRequest,
    slice: unknown[][],
    sliceIdx: number,
    reqIdx: number,
    cancelStream: ReadableStream<Uint8Array> | undefined,
  ): Promise<RunOneResult[]> {
    const PER_LEAF = 4;
    const numWorkers = Math.ceil(slice.length / PER_LEAF);
    const leafBatches: unknown[][][] = [];
    let c = 0;
    for (let i = 0; i < numWorkers && c < slice.length; i++) {
      const here = Math.min(PER_LEAF, slice.length - c);
      leafBatches.push(slice.slice(c, c + here));
      c += here;
    }
    const leafCancelStreams = forkCancelStream(cancelStream, leafBatches.length);
    const leafResults = await Promise.all(
      leafBatches.map(async (batch, leafIdx): Promise<RunOneResult[]> => {
        const stub = getStub<WorkerDOStub>(
          this.env.CfpWorkerDO,
          `${this.ctx.id.toString()}-r${reqIdx}-leaf-${sliceIdx}-${leafIdx}`,
        );
        try {
          const result = await stub.runBatch({
            fnSource: request.fnSource,
            fnHash: request.fnHash,
            context: request.context,
            workerOptions: request.workerOptions,
            cacheKeyStrategy: request.cacheKeyStrategy,
            argsList: batch,
            envelope: request.envelope,
            freshIsolate: false,
            cancelStream: leafCancelStreams[leafIdx],
          });
          return result.results;
        } catch (err) {
          return batch.map(() => errorToFailedResult(err));
        }
      }),
    );
    const flat: RunOneResult[] = [];
    for (const r of leafResults) flat.push(...r);
    return flat;
  }
}

/** Local copy to avoid cross-module dep cycle with topology/. */
function balancedFillForTree(size: number, n: number): number[] {
  if (size === 0) return new Array(n).fill(0);
  const base = Math.floor(size / n);
  const extras = size % n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + (i < extras ? 1 : 0));
  return out;
}
