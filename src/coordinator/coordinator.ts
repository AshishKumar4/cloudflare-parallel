import { DurableObject } from 'cloudflare:workers';
import type { WorkerLoader } from '../types';
import { LoaderRunner } from '../loader/runner';
import { selectTopology } from '../topology/selector';
import type { HybridPlan, TopologyPlan, TreePlan } from '../topology/plan';
import {
  errorToFailedResult,
  type ContextEnvelope,
  type DispatchEnvelope,
  type DispatchTreeRequest,
  type RunBatchRequest,
  type RunOneRequest,
  type RunOneResult,
} from './protocol';
import { getStub, wireToWorkerOptions, type LocationHint } from './internal';
import { forkCancelStream } from '../transport/cancel-stream';
import type { WorkerDOSession } from './worker-do';

/**
 * `CfpCoordinator` — Pool's primary DO.
 *
 * Public RPC methods:
 *   - `runOne(req)`  : single-task submit.
 *   - `runMany(req)` : fan-out (in-do / hybrid / tree) — returns per-index results.
 *   - `runStream(req, idx)` : streaming submit (returns ReadableStream-of-bytes).
 *   - `actorSubmit(...)` : pinned-state actor submit (Actor mode).
 *
 * Topology selection is deterministic from `req.argsList.length`. The DO
 * never picks `loader-only` (that path lives in the caller's Worker via
 * `Parallel.loaderOnly()` and never enters the Coordinator).
 *
 * **Promise pipelining.** Hybrid and tree dispatch acquire a long-lived
 * session per leaf via `stub.openSession()` / `stub.openTreeSession()`
 * and chain the workload call without awaiting between calls. The
 * runtime collapses these into a single round-trip per leaf
 * (Cap'n Proto promise pipelining). Reference:
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/
 */
export interface CoordinatorEnv {
  LOADER: WorkerLoader;
  CfpWorkerDO?: DurableObjectNamespace;
  CfpSubCoord?: DurableObjectNamespace;
  // The DO inherits user bindings through its own env when the user's
  // wrangler.toml exposes them on the Coordinator class.
}

interface WorkerDOStub {
  /** Pipelinable session — reuse one Cap'n Proto session per leaf. */
  openSession(): WorkerDOSession;
  /** Direct call form (kept for callers that don't need pipelining). */
  runBatch(req: RunBatchRequest): Promise<{ results: RunOneResult[] }>;
}
interface SubCoordStub {
  openTreeSession(): SubCoordSessionLike;
  dispatch(req: DispatchTreeRequest): Promise<{ results: RunOneResult[] }>;
}
interface SubCoordSessionLike {
  dispatch(req: DispatchTreeRequest): Promise<{ results: RunOneResult[] }>;
}

export interface CoordinatorRunRequest extends RunOneRequest {
  /** Bindings allow-list (intersected with the DO's own env). */
  allowList?: string[];
}

export interface CoordinatorFanOutRequest {
  fnSource: string;
  fnHash: string;
  context?: Record<string, unknown>;
  cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
  workerOptions?: RunOneRequest['workerOptions'];
  argsList: unknown[][];
  envelope: DispatchEnvelope;
  freshIsolate?: boolean;
  /** Topology selector knobs (the API copies them from PoolOptions). */
  selector?: {
    topology?: 'auto' | 'in-do' | 'hybrid' | 'tree';
    maxFanOut?: number;
    branchingFactor?: number;
    treeThreshold?: number;
  };
  /** Live cancel stream forwarded into all loaded isolates. */
  cancelStream?: ReadableStream<Uint8Array>;
  /**
   * Optional DO placement hint, passed to `namespace.get(id, { locationHint })`
   * when materializing leaf DOs. Best-effort; only honored on first access.
   * Reference: https://developers.cloudflare.com/durable-objects/reference/data-location/
   */
  locationHint?: LocationHint;
}

const ACTOR_STATE_KEY = 'cfp:actor-state';
const ACTOR_INITIALIZED_KEY = 'cfp:actor-initialized';

export class CfpCoordinator extends DurableObject<CoordinatorEnv> {
  // ---- single-shot submit --------------------------------------------

  async runOne(request: CoordinatorRunRequest): Promise<RunOneResult> {
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      callSite: 'do-method',
      cacheKeyStrategy: request.cacheKeyStrategy ?? 'stable',
      workerOptions: wireToWorkerOptions(request.workerOptions, this.env as unknown as Record<string, unknown>),
      allowList: request.allowList,
    });
    try {
      const value = await runner.runOne({
        fnSource: request.fnSource,
        fnHash: request.fnHash,
        context: request.context,
        bindings: this.env as unknown as Record<string, unknown>,
        envelope: {
          ...request.envelope,
          mode: 'pool-fn' as const,
        },
        args: request.args,
        freshIsolate: request.freshIsolate,
        cancelStream: request.cancelStream,
      });
      return { ok: true, value };
    } catch (err) {
      return errorToFailedResult(err);
    }
  }

  // ---- fan-out (auto-selects in-do / hybrid / tree) ------------------

  async runMany(request: CoordinatorFanOutRequest): Promise<{
    results: RunOneResult[];
    topology: 'in-do' | 'hybrid' | 'tree';
    fanOutPerLevel: number[];
    treeDepth: number;
  }> {
    const size = request.argsList.length;
    if (size === 0) return { results: [], topology: 'in-do', fanOutPerLevel: [], treeDepth: 1 };
    const plan = selectTopology(size, request.selector ?? {});
    // Per-request leaf-DO sharding. Without this, two concurrent fan-out
    // requests would target the same `${coordId}-leaf-${i}` DOs and contend
    // on those DOs' per-isolate loader semaphore — silently halving the
    // headline 4N parallelism. We accept fresh leaves per request: max
    // parallelism wins.
    const requestId = `r${++this.#requestCounter}-${crypto.randomUUID().slice(0, 8)}`;
    const dispatched = await this.#dispatchPlan(plan, request, requestId);
    return {
      results: dispatched.results,
      topology: plan.topology === 'loader-only' ? 'in-do' : plan.topology,
      fanOutPerLevel: planFanOutPerLevel(plan),
      treeDepth: plan.topology === 'tree' ? plan.depth : 1,
    };
  }

  #requestCounter = 0;

  async #dispatchPlan(
    plan: TopologyPlan,
    request: CoordinatorFanOutRequest,
    requestId: string,
  ): Promise<{ results: RunOneResult[] }> {
    if (plan.topology === 'loader-only') {
      // Auto-selector never returns loader-only. If a caller pins this
      // topology, they should have used Parallel.loaderOnly() instead.
      throw new Error('BUG: loader-only topology should not reach the Coordinator DO');
    }

    if (plan.topology === 'in-do') {
      return this.#dispatchInDo(plan.size, request);
    }
    if (plan.topology === 'hybrid') {
      return this.#dispatchHybrid(plan, request, requestId);
    }
    // tree
    return this.#dispatchTree(plan, request, requestId);
  }

  async #dispatchInDo(
    size: number,
    request: CoordinatorFanOutRequest,
  ): Promise<{ results: RunOneResult[] }> {
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      callSite: 'do-method',
      cacheKeyStrategy: request.cacheKeyStrategy ?? 'stable',
      workerOptions: wireToWorkerOptions(request.workerOptions, this.env as unknown as Record<string, unknown>),
    });
    // Fork the upstream cancel stream so each parallel loader gets its own
    // single-reader copy. Live cancel propagates to all in-DO loaders.
    const slice = request.argsList.slice(0, size);
    const childStreams = forkCancelStream(request.cancelStream, slice.length);
    const results = await Promise.all(
      slice.map(async (args, i): Promise<RunOneResult> => {
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
    return { results };
  }

  async #dispatchHybrid(
    plan: HybridPlan,
    request: CoordinatorFanOutRequest,
    requestId: string,
  ): Promise<{ results: RunOneResult[] }> {
    if (!this.env.CfpWorkerDO) {
      throw new Error(
        'hybrid topology requires CfpWorkerDO binding; ' + 'add it to wrangler.toml and re-deploy',
      );
    }
    const ns = this.env.CfpWorkerDO;

    // Slice argsList according to the leaf shape.
    let cursor = 0;
    const slices: unknown[][][] = [];
    for (const leafSize of plan.leafShape) {
      slices.push(request.argsList.slice(cursor, cursor + leafSize));
      cursor += leafSize;
    }

    // One forked cancel stream per child WorkerDO leaf. Each leaf forks
    // again internally for its 4 loaders.
    const childStreams = forkCancelStream(request.cancelStream, slices.length);
    const leafResults = await Promise.all(
      slices.map(async (slice, leafIdx): Promise<RunOneResult[]> => {
        if (slice.length === 0) return [];
        const leafName = `${this.ctx.id.toString()}-${requestId}-leaf-${leafIdx}`;
        try {
          return await invokeLeafBatchWithRetry(ns, leafName, request, slice, childStreams[leafIdx]);
        } catch (err) {
          return slice.map(() => errorToFailedResult(err));
        }
      }),
    );
    const flat: RunOneResult[] = [];
    for (const r of leafResults) flat.push(...r);
    return { results: flat };
  }

  async #dispatchTree(
    plan: TreePlan,
    request: CoordinatorFanOutRequest,
    requestId: string,
  ): Promise<{ results: RunOneResult[] }> {
    if (!this.env.CfpSubCoord) {
      throw new Error(
        'tree topology requires CfpSubCoord binding; ' + 'add it to wrangler.toml and re-deploy',
      );
    }
    if (!this.env.CfpWorkerDO) {
      throw new Error('tree topology requires CfpWorkerDO binding');
    }
    const ns = this.env.CfpSubCoord;

    // Slice argsList per child plan size.
    const childSizes = plan.children.map((c) => c.size);
    let cursor = 0;
    const slices: unknown[][][] = [];
    for (const childSize of childSizes) {
      slices.push(request.argsList.slice(cursor, cursor + childSize));
      cursor += childSize;
    }

    const childStreams = forkCancelStream(request.cancelStream, slices.length);
    const subResults = await Promise.all(
      slices.map(async (slice, subIdx): Promise<RunOneResult[]> => {
        if (slice.length === 0) return [];
        const subName = `${this.ctx.id.toString()}-${requestId}-sub-${subIdx}`;
        const buildReq = (cancelStream: ReadableStream<Uint8Array> | undefined): DispatchTreeRequest => ({
          fnSource: request.fnSource,
          fnHash: request.fnHash,
          context: request.context,
          workerOptions: request.workerOptions,
          cacheKeyStrategy: request.cacheKeyStrategy,
          argsList: slice,
          // Tell the sub-coord to slice its received argsList per its own children.
          planChildSizes: planSliceChildSizes(plan.children[subIdx]),
          branchingFactor: plan.branchingFactor,
          depth: plan.depth - 1,
          maxFanOut: request.selector?.maxFanOut ?? 32,
          envelope: request.envelope,
          cancelStream,
          locationHint: request.locationHint,
        });
        // Same retry policy as `invokeLeafBatchWithRetry`: up to 2
        // retries on transient platform errors, jittered backoff to
        // avoid retry thundering herds. See that helper for the
        // rationale; tree dispatch hits the same DO creation pressure
        // at large N.
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const stub = getStub<SubCoordStub>(ns, subName, request.locationHint);
            const session = stub.openTreeSession();
            const result = await session.dispatch(
              buildReq(attempt === 0 ? childStreams[subIdx] : undefined),
            );
            return result.results;
          } catch (err) {
            if (!isTransientLeafError(err) || attempt === MAX_RETRIES) {
              return slice.map(() => errorToFailedResult(err));
            }
            const base = 100 + attempt * 150;
            const jitter = Math.random() * 150;
            await new Promise<void>((resolve) => setTimeout(resolve, base + jitter));
          }
        }
        return slice.map(() => errorToFailedResult(new Error('sub-coord retry exhausted')));
      }),
    );
    const flat: RunOneResult[] = [];
    for (const r of subResults) flat.push(...r);
    return { results: flat };
  }

  // ---- actor (pinned-state) ------------------------------------------

  async actorEnsureInitialized(initialState: unknown): Promise<void> {
    const initialized = (await this.ctx.storage.get(ACTOR_INITIALIZED_KEY)) === true;
    if (initialized) return;
    // `allowUnconfirmed: true` lets these initial writes race the response
    // back to the caller without waiting for the storage commit. Empirically
    // 46–80% lower wall-time on small-N writes. Safe here: the actor's
    // initial-state seed is recoverable from the caller's input — if the
    // DO crashes before the commit lands, the next `actorEnsureInitialized`
    // call simply re-seeds from the same `initialState` argument. No
    // application-visible information is lost.
    //
    // Reference: https://developers.cloudflare.com/durable-objects/api/transactional-storage-api/#put
    await this.ctx.storage.put(ACTOR_STATE_KEY, initialState ?? {}, { allowUnconfirmed: true });
    await this.ctx.storage.put(ACTOR_INITIALIZED_KEY, true, { allowUnconfirmed: true });
  }

  async actorSubmit(req: {
    fnSource: string;
    fnHash: string;
    args: unknown[];
    context?: Record<string, unknown>;
    workerOptions?: RunOneRequest['workerOptions'];
    cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
    envelope: DispatchEnvelope;
  }): Promise<RunOneResult> {
    const state = (await this.ctx.storage.get<unknown>(ACTOR_STATE_KEY)) ?? {};
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      callSite: 'do-method',
      cacheKeyStrategy: req.cacheKeyStrategy ?? 'stable',
      workerOptions: wireToWorkerOptions(req.workerOptions, this.env as unknown as Record<string, unknown>),
    });
    try {
      // Actor mode dispatches the actor-class codegen. The runner
      // calls `submit(envelope, fnSource, state, args)`, which prepends
      // `(state, sql)` to the user-fn invocation and returns
      // `{ state, value: <user-return> }`.
      const result = await runner.runActor<unknown>({
        fnSource: req.fnSource,
        fnHash: req.fnHash,
        context: req.context,
        bindings: this.env as unknown as Record<string, unknown>,
        envelope: { ...req.envelope, mode: 'actor-class' as const },
        args: req.args,
        state,
      });
      // Persist state with `allowUnconfirmed: true`. Empirically 46–80%
      // lower per-write wall-time; safe here because the Actor contract
      // already documents per-submit checkpointing as best-effort and
      // because the `state` is an in-memory snapshot that the next
      // submit will re-read from storage. If a crash drops the
      // not-yet-committed write, the caller observes the prior state
      // (which is what they would observe with a synchronous-commit
      // crash too — the surfaced semantics are identical for the
      // single-state-shard model the actor uses).
      //
      // Reference: https://developers.cloudflare.com/durable-objects/api/transactional-storage-api/#put
      await this.ctx.storage.put(ACTOR_STATE_KEY, result.state, { allowUnconfirmed: true });
      return { ok: true, value: result.value };
    } catch (err) {
      return errorToFailedResult(err);
    }
  }

  // Live in-isolate cancel polling is deferred to v0.4 (DESIGN §13
  // Y-Cancel). For v0.3 the cooperative-cancel contract is **snapshot-only**:
  // env.signal reflects cancel state at submit time. The coordinator's
  // Promise.race surfaces CancelledError to the caller immediately on cancel
  // even when the loaded isolate is in a tight loop; the orphan runs to
  // cpuMs / wall-clock per ADR-9 / ADR-11.

  async actorClose(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  // ---- ContextEnvelope-style passthrough (used by Pool.handle) -------

  async ping(env: ContextEnvelope): Promise<{ ok: true; bindingKeys: string[] }> {
    void env;
    return {
      ok: true,
      bindingKeys: Object.keys(this.env as unknown as Record<string, unknown>),
    };
  }

  /**
   * No-op prewarm method. The first RPC against a freshly-created DO
   * pays a one-time creation cost; calling `noop()` in parallel with
   * `runOne` / `runMany` lets the DO finish creating while the real
   * work rides the warm channel. See `Pool.warm()` for the public hook.
   */
  async noop(): Promise<void> {
    /* intentionally empty */
  }
}

/**
 * For TreePlan child slicing: walk a child plan's `size` budgets one level
 * down. For HybridPlan children the next level is the leaf shape. For
 * deeper TreePlan children we balance-fill across F children.
 */
function planSliceChildSizes(child: TreePlan | HybridPlan): number[] {
  if (child.topology === 'hybrid') {
    return child.leafShape;
  }
  // tree — return its child sizes.
  return child.children.map((c) => c.size);
}

/**
 * Fan-out widths per level for observability (PoolStats.fanOutPerLevel).
 *
 * Reports a list whose entries are the parallelism width at each tier,
 * top to bottom. For the hybrid topology that's `[leafCount, …perLeafLoaderCounts]`;
 * for the tree topology the report walks the leftmost branch top-down,
 * appending the leaf count at the deepest tier and finally the per-leaf
 * loader count (typically 4).
 */
function planFanOutPerLevel(plan: TopologyPlan): number[] {
  if (plan.topology === 'in-do' || plan.topology === 'loader-only') return [plan.size];
  if (plan.topology === 'hybrid') return [plan.leafShape.length, ...plan.leafShape];
  // tree — root fan-out first, then walk the leftmost branch reporting
  // the children-count at each tier; at the deepest hybrid leaf, append
  // the leaf count AND the per-leaf loader count so the user sees all
  // multiplicative tiers.
  const widths: number[] = [plan.children.length];
  let cursor: TreePlan | HybridPlan | undefined = plan.children[0];
  while (cursor) {
    if (cursor.topology === 'hybrid') {
      widths.push(cursor.leafShape.length);
      // Per-leaf loader count (the bottommost tier that gives 4N parallelism).
      // Use the largest leaf in the shape; balanced shapes are uniform but
      // the tail leaf may hold a remainder.
      const maxLoadersPerLeaf = cursor.leafShape.reduce((a, b) => Math.max(a, b), 0);
      widths.push(maxLoadersPerLeaf);
      break;
    }
    widths.push(cursor.children.length);
    cursor = cursor.children[0];
  }
  return widths;
}

// Transient-error matchers live in a standalone module so unit tests
// don't have to load `cloudflare:workers` to exercise them.
import { isTransientLeafError } from './transient';

/**
 * Invoke `runBatch` on a leaf DO with up to 2 auto-retries on transient
 * platform errors. Each retry uses a fresh stub (a runtime-reset DO is
 * effectively dead until re-addressed) and waits a small jittered
 * backoff so a thundering herd of fresh-DO creations doesn't slam the
 * runtime in lockstep. Empirically resolves the vast majority of the
 * "object to be reset" failures observed at large fan-out sizes (N≥256).
 *
 * Why two retries: a single retry is enough on a quiescent platform,
 * but under heavy concurrent DO creation (e.g. a bench burst right at
 * the size cliff) the runtime occasionally hits the transient twice in
 * a row. Two retries × N leaves running in parallel is bounded
 * cost — the worst case is `2 × backoff_max = ~600 ms` added wall.
 */
async function invokeLeafBatchWithRetry(
  ns: DurableObjectNamespace,
  leafName: string,
  request: CoordinatorFanOutRequest,
  slice: unknown[][],
  cancelStream: ReadableStream<Uint8Array> | undefined,
): Promise<RunOneResult[]> {
  const MAX_RETRIES = 2;
  const buildBatch = (cs: ReadableStream<Uint8Array> | undefined): RunBatchRequest => ({
    fnSource: request.fnSource,
    fnHash: request.fnHash,
    context: request.context,
    workerOptions: request.workerOptions,
    cacheKeyStrategy: request.cacheKeyStrategy,
    argsList: slice,
    envelope: request.envelope,
    freshIsolate: request.freshIsolate,
    cancelStream: cs,
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stub = getStub<WorkerDOStub>(ns, leafName, request.locationHint);
      // Promise pipelining: openSession() and runBatch() ride one Cap'n
      // Proto round-trip. Reference:
      // https://developers.cloudflare.com/workers/runtime-apis/rpc/
      const session = stub.openSession();
      // On the first attempt we forward the live cancel-stream; retries
      // pass `undefined` because a ReadableStream cannot be re-read.
      // Semantically equivalent to "no cancel arrived at this point in
      // the fan-out", which is true at the retry boundary (a leaf reset
      // means nothing got delivered).
      const result = await session.runBatch(buildBatch(attempt === 0 ? cancelStream : undefined));
      return result.results;
    } catch (err) {
      if (!isTransientLeafError(err) || attempt === MAX_RETRIES) throw err;
      // Jittered backoff: 100–250 ms on attempt 1, 250–500 ms on attempt 2.
      // Spreads the retry burst out so the runtime sees a sustained ramp
      // rather than another thundering herd.
      const base = 100 + attempt * 150;
      const jitter = Math.random() * 150;
      await new Promise<void>((resolve) => setTimeout(resolve, base + jitter));
    }
  }
  // Unreachable — the loop either returns or rethrows.
  throw new Error('invokeLeafBatchWithRetry: exhausted retries');
}
