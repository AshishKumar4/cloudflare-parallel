import { DurableObject, RpcTarget } from 'cloudflare:workers';
import {
  errorToFailedResult,
  type DispatchTreeRequest,
  type DispatchTreeResult,
  type RunOneResult,
  type RunBatchRequest,
} from './protocol';
import type { WorkerLoader } from '../types';
import { getStub } from './internal';
import { forkCancelStream } from '../transport/cancel-stream';
import type { WorkerDOSession } from './worker-do';

/**
 * `CfpSubCoord` — Mid-tier of the hierarchical tree topology.
 *
 * Receives a `DispatchTreeRequest` slice and either:
 *   - At depth=1: fans out to `CfpWorkerDO` leaves (hybrid leaves).
 *   - At depth>1: fans out to peer `CfpSubCoord` instances (deeper tier).
 *
 * Per-tier RPC fan-out is bounded by `maxFanOut` (default 32 per coord level).
 *
 * Like `CfpCoordinator`, this DO supports promise pipelining via
 * `openTreeSession()` / `WorkerDOSession.runBatch()` chains so each tier's
 * dispatch travels in a single Cap'n Proto round-trip per child.
 */
export interface SubCoordEnv {
  LOADER: WorkerLoader;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

interface WorkerDOStub {
  openSession(): WorkerDOSession;
  runBatch(req: RunBatchRequest): Promise<{ results: RunOneResult[] }>;
}

interface SubCoordStub {
  openTreeSession(): SubCoordSessionLike;
  dispatch(req: DispatchTreeRequest): Promise<DispatchTreeResult>;
}

interface SubCoordSessionLike {
  dispatch(req: DispatchTreeRequest): Promise<DispatchTreeResult>;
}

/**
 * Long-lived per-sub-coord session, returned by `openTreeSession`.
 * Subsequent dispatch calls invoked on this target reuse the same RPC
 * session — the runtime collapses chained calls into a single round-trip.
 */
export class SubCoordSession extends RpcTarget {
  readonly #env: SubCoordEnv;
  readonly #ownerId: string;
  readonly #owner: CfpSubCoord;

  constructor(env: SubCoordEnv, ownerId: string, owner: CfpSubCoord) {
    super();
    this.#env = env;
    this.#ownerId = ownerId;
    this.#owner = owner;
  }

  async dispatch(request: DispatchTreeRequest): Promise<DispatchTreeResult> {
    // Stable leaf naming — see `CfpCoordinator.runMany` for the
    // warm-leaf rationale. `reqIdx = 0` keeps the leaf-name template
    // deterministic across dispatch calls so warm DOs are reused.
    return dispatchOnEnv(this.#env, this.#ownerId, 0, request, this.#owner);
  }
}

export class CfpSubCoord extends DurableObject<SubCoordEnv> {
  /**
   * Per-instance caches for F8/F9 (see `/workspace/perf-audit-findings.md`).
   * Leaf-DO names are stable across requests, so we amortize:
   *   - `#leafStubCache`: skip `idFromName` SHA-256 + `ns.get` for warm leaves.
   *   - `#prewarmedLeaves`: track which leaves have received a `noop()`
   *     prewarm so we only fire once per leaf per sub-coord lifetime.
   * Both maps are read/written via the helpers in `dispatchOnEnv`.
   */
  readonly leafStubCache = new Map<string, DurableObjectStub>();
  readonly prewarmedLeaves = new Set<string>();

  /**
   * Open a pipelinable session. Subsequent `dispatch(...)` calls invoked
   * on the returned target ride the same RPC session (Cap'n Proto promise
   * pipelining).
   */
  openTreeSession(): SubCoordSession {
    return new SubCoordSession(this.env, this.ctx.id.toString(), this);
  }

  /** Direct call form (kept for callers that don't need pipelining). */
  async dispatch(request: DispatchTreeRequest): Promise<DispatchTreeResult> {
    return dispatchOnEnv(this.env, this.ctx.id.toString(), 0, request, this);
  }

  /**
   * No-op prewarm method. See `CfpWorkerDO.noop()` — a fresh
   * sub-coordinator pays the same DO-creation cost on first call. Library
   * prewarm fires `noop()` in parallel with the real fan-out so the DO
   * is hot when the workload arrives.
   */
  async noop(): Promise<void> {
    /* intentionally empty */
  }
}

async function dispatchOnEnv(
  env: SubCoordEnv,
  ownerId: string,
  reqIdx: number,
  request: DispatchTreeRequest,
  owner: CfpSubCoord,
): Promise<DispatchTreeResult> {
  const { argsList, planChildSizes, depth, branchingFactor } = request;
  // Global slot offset for this sub-coord's slice — propagated down from
  // the parent coordinator. Each child gets `parentSlotBase + sliceOffset`
  // so the leaf-tier sees the SAME global slot indices the caller's
  // `pool.map` saw at indices [taskSlotBase, taskSlotBase + size).
  const parentSlotBase = request.taskSlotBase ?? 0;

  // Slice argsList per child according to planChildSizes, tracking the
  // running cursor for the global slot space.
  let cursor = 0;
  const slices: Array<{ args: unknown[][]; slotBase: number }> = [];
  for (const childSize of planChildSizes) {
    slices.push({
      args: argsList.slice(cursor, cursor + childSize),
      slotBase: parentSlotBase + cursor,
    });
    cursor += childSize;
  }

  // Fork upstream cancel stream per child slice.
  const childCancelStreams = forkCancelStream(request.cancelStream, slices.length);

  // Dispatch each child in parallel.
  const childPromises = slices.map(async ({ args: slice, slotBase }, i): Promise<RunOneResult[]> => {
    if (slice.length === 0) return [];
    try {
      if (depth <= 1) {
        // Hybrid leaf: one worker DO per job. CPU parallelism scales
        // with leaf-DO count because each leaf runs in its own
        // workerd process / V8 scheduler thread.
        return await dispatchHybridLeaf(
          env,
          ownerId,
          request,
          slice,
          slotBase,
          i,
          reqIdx,
          childCancelStreams[i],
          owner,
        );
      } else {
        // Recurse into a deeper sub-coord with promise pipelining.
        const nextChildSizes = balancedFillForTree(slice.length, branchingFactor);
        const subId = `${ownerId}-r${reqIdx}-sub-${i}`;
        const stub = getStub<SubCoordStub>(env.CfpSubCoord, subId, request.locationHint);
        const session = stub.openTreeSession();
        const result = await session.dispatch({
          ...request,
          argsList: slice,
          planChildSizes: nextChildSizes,
          depth: depth - 1,
          // Propagate the global slot base into the next tier.
          taskSlotBase: slotBase,
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

async function dispatchHybridLeaf(
  env: SubCoordEnv,
  ownerId: string,
  request: DispatchTreeRequest,
  slice: unknown[][],
  sliceSlotBase: number,
  sliceIdx: number,
  reqIdx: number,
  cancelStream: ReadableStream<Uint8Array> | undefined,
  owner: CfpSubCoord,
): Promise<RunOneResult[]> {
  // One leaf DO per job — each leaf is a separate workerd process with
  // its own V8 scheduler thread. CPU parallelism scales linearly with
  // leaf count.
  const leafBatches: Array<{ args: unknown[][]; slotBase: number; leafName: string }> =
    slice.map((args, i) => ({
      args: [args],
      slotBase: sliceSlotBase + i,
      leafName: `${ownerId}-r${reqIdx}-leaf-${sliceIdx}-${i}`,
    }));
  const leafCancelStreams = forkCancelStream(cancelStream, leafBatches.length);

  // F9 (perf-audit-findings.md): fire `noop()` to leaves that haven't
  // been prewarmed yet from this sub-coord instance. Unawaited — the
  // noop rides outbound in parallel with the real dispatch and lands
  // first; the real `runBatch` rides the warm channel.
  for (const { leafName } of leafBatches) {
    if (owner.prewarmedLeaves.has(leafName)) continue;
    owner.prewarmedLeaves.add(leafName);
    let s = owner.leafStubCache.get(leafName);
    if (!s) {
      s = getStub<WorkerDOStub>(
        env.CfpWorkerDO,
        leafName,
        request.locationHint,
      ) as DurableObjectStub;
      owner.leafStubCache.set(leafName, s);
    }
    (s as unknown as { noop(): Promise<void> }).noop().catch(() => {
      owner.prewarmedLeaves.delete(leafName);
    });
  }

  const leafResults = await Promise.all(
    leafBatches.map(async ({ args: batch, slotBase, leafName }, leafIdx): Promise<RunOneResult[]> => {
      // F8: use the cached leaf stub.
      let stub = owner.leafStubCache.get(leafName) as WorkerDOStub | undefined;
      if (!stub) {
        stub = getStub<WorkerDOStub>(
          env.CfpWorkerDO,
          leafName,
          request.locationHint,
        );
        owner.leafStubCache.set(leafName, stub as unknown as DurableObjectStub);
      }
      try {
        // Promise pipelining on the leaf DO.
        const session = stub.openSession();
        const result = await session.runBatch({
          fnSource: request.fnSource,
          fnHash: request.fnHash,
          context: request.context,
          workerOptions: request.workerOptions,
          cacheKeyStrategy: request.cacheKeyStrategy,
          argsList: batch,
          envelope: request.envelope,
          freshIsolate: false,
          // Global slot offset for this leaf. With one job per leaf
          // `batch.length === 1`, but the indexing is preserved for
          // multi-job batches (e.g. callers driving `runBatch` directly).
          taskSlotBase: slotBase,
          cancelStream: leafCancelStreams[leafIdx],
        });
        return result.results;
      } catch (err) {
        // Invalidate cached stub on error — may be a transient leaf
        // reset and the routing handle is stale.
        owner.leafStubCache.delete(leafName);
        return batch.map(() => errorToFailedResult(err));
      }
    }),
  );
  const flat: RunOneResult[] = [];
  for (const r of leafResults) flat.push(...r);
  return flat;
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
