import { TopologyError } from '../errors/index';
import {
  type HybridPlan,
  type InDoPlan,
  type TopologyPlan,
  type TreePlan,
  balancedFill,
} from './plan';

/** Pool topologies. `loader-only` is intentionally NOT in this union — it lives behind `Parallel.loaderOnly()`. */
export type Topology = 'auto' | 'in-do' | 'hybrid' | 'tree';

export interface SelectorOptions {
  topology?: Topology;
  /**
   * Per-coordinator RPC fan-out cap (default 32). This is the binding
   * constraint on `hybrid`: each coordinator-DO can dispatch up to
   * `maxFanOut` leaf-DO calls in one Promise.all turn before hitting
   * workerd's outgoing-RPC ceiling. Sizes above this auto-promote to
   * `tree`.
   */
  maxFanOut?: number;
  /** Tree branching factor (range 4..16, default 8). */
  branchingFactor?: number;
  /**
   * Override the hybrid → tree boundary. Defaults to `maxFanOut` (so
   * the auto-selector promotes to tree exactly when a single
   * coordinator would otherwise exceed its fan-out cap).
   */
  treeThreshold?: number;
}

const DEFAULT_MAX_FAN_OUT = 32;
const DEFAULT_BRANCHING_FACTOR = 8;

/**
 * Decide the topology and build the dispatch plan.
 *
 * Parallelism model (DESIGN §4): each worker DO is a separate workerd
 * process on its own V8 scheduler thread. Loaders inside a single DO
 * share that process's thread, so CPU parallelism scales with DO count,
 * not with loaders-per-DO. The selector therefore dispatches **one job
 * per leaf DO** at every size > 1.
 *
 * Rules:
 *   size = 0        → in-do (empty fast path)
 *   size = 1        → in-do (single-shot, single loaded isolate)
 *   2 ≤ size ≤ K    → hybrid (N leaf DOs, one job each)
 *   size > K        → tree (root coord → sub-coords → hybrid leaves)
 *
 * where K = `treeThreshold` (defaults to `maxFanOut`). `loader-only` is
 * NOT auto-selectable — reach it via `Parallel.loaderOnly()`.
 */
export function selectTopology(size: number, opts: SelectorOptions = {}): TopologyPlan {
  if (!Number.isFinite(size) || size < 0) {
    throw new TopologyError(`size must be a non-negative integer, got ${size}`);
  }
  const requested = opts.topology ?? 'auto';
  const branchingFactor = opts.branchingFactor ?? DEFAULT_BRANCHING_FACTOR;
  const maxFanOut = opts.maxFanOut ?? DEFAULT_MAX_FAN_OUT;
  const treeThreshold = opts.treeThreshold ?? maxFanOut;

  if (branchingFactor < 4 || branchingFactor > 16) {
    throw new TopologyError(`branchingFactor must be in [4,16], got ${branchingFactor}`);
  }
  if (maxFanOut < 1 || maxFanOut > 256) {
    throw new TopologyError(`maxFanOut must be in [1,256], got ${maxFanOut}`);
  }

  if (size === 0) {
    return { topology: 'in-do', size: 0 } satisfies InDoPlan;
  }

  if (requested !== 'auto') {
    return buildPinnedPlan(size, requested, { branchingFactor, maxFanOut });
  }

  // Auto-selector. N=1 stays in-do (single loaded isolate, no leaf DO
  // RPC). N ≥ 2 fans out across leaf DOs for real CPU parallelism.
  if (size === 1) {
    return { topology: 'in-do', size: 1 } satisfies InDoPlan;
  }
  if (size <= treeThreshold) {
    return buildHybridPlan(size);
  }
  return buildTreePlan(size, branchingFactor, maxFanOut);
}

function buildPinnedPlan(
  size: number,
  requested: Exclude<Topology, 'auto'>,
  opts: { branchingFactor: number; maxFanOut: number },
): TopologyPlan {
  if (requested === 'in-do') {
    // `in-do` is the single-isolate fast path. Pinning it for size ≥ 2
    // is a configuration error: the four (or more) loaders would share
    // the parent process's V8 thread and serialize on CPU. Surface the
    // mistake loudly instead of silently giving up parallelism.
    if (size > 1) {
      throw new TopologyError(
        `topology: 'in-do' supports size <= 1 (single-shot loaded isolate); got ${size}. ` +
          `Use 'auto' or 'hybrid' for larger fan-outs — each leaf DO is a separate workerd ` +
          `process with its own V8 scheduler thread, which is where CPU parallelism comes from.`,
      );
    }
    return { topology: 'in-do', size } satisfies InDoPlan;
  }
  if (requested === 'hybrid') {
    // Hybrid is the one-job-per-leaf-DO fan-out. The per-coordinator
    // fan-out cap is `maxFanOut`; sizes above that should pin `tree`.
    if (size > opts.maxFanOut) {
      throw new TopologyError(
        `topology: 'hybrid' with maxFanOut=${opts.maxFanOut} supports size <= ${opts.maxFanOut}; ` +
          `got ${size}. Use 'tree' or raise maxFanOut.`,
      );
    }
    return buildHybridPlan(size);
  }
  // tree
  return buildTreePlan(size, opts.branchingFactor, opts.maxFanOut);
}

function buildHybridPlan(size: number): HybridPlan {
  // One job per leaf DO. Each leaf is a separate workerd process; CPU
  // parallelism is `N`-way where `N = size`.
  const leafShape = new Array<number>(size).fill(1);
  return { topology: 'hybrid', size, leafShape };
}

/**
 * Build a tree plan recursively. Each tier divides `size` evenly across
 * `branchingFactor` sub-coords; the deepest tier is a hybrid leaf with
 * one job per leaf DO.
 *
 * Math: `K = max(1, ceil(log_F(size / maxFanOut)))`. Each leaf-tier
 * hybrid is bounded by `maxFanOut` jobs.
 */
function buildTreePlan(
  size: number,
  branchingFactor: number,
  maxFanOut: number,
  forcedDepth?: number,
): TreePlan {
  const F = branchingFactor;
  // Depth required so each leaf-tier hybrid stays under the per-coord
  // fan-out cap. Using `maxFanOut` (not the legacy `maxFanOut × 4`)
  // because each leaf hybrid now dispatches one job per leaf DO.
  const K =
    forcedDepth ??
    Math.max(1, Math.ceil(Math.log(size / Math.max(1, maxFanOut)) / Math.log(F)));

  const childSizes = balancedFill(size, F);
  const usedChildren = childSizes.filter((s) => s > 0);

  const children = usedChildren.map((slice): HybridPlan | TreePlan => {
    // Bottom tier: child is a hybrid leaf, capped at maxFanOut jobs.
    if (K <= 1) return buildHybridPlan(Math.min(slice, maxFanOut));
    // Above the bottom tier: recurse with depth K-1.
    return buildTreePlan(slice, F, maxFanOut, K - 1);
  });

  return {
    topology: 'tree',
    size,
    branchingFactor: F,
    depth: K,
    children,
  };
}
