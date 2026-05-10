import { TopologyError } from '../errors/index.js';
import {
  type HybridPlan,
  type InDoPlan,
  type TopologyPlan,
  type TreePlan,
  balancedFill,
} from './plan.js';

/** Pool topologies. `loader-only` is intentionally NOT in this union — it lives behind `Parallel.loaderOnly()`. */
export type Topology = 'auto' | 'in-do' | 'hybrid' | 'tree';

export interface SelectorOptions {
  topology?: Topology;
  /** Per-coordinator RPC fan-out cap (default 32). */
  maxFanOut?: number;
  /** Tree branching factor (range 4..16, default 8). */
  branchingFactor?: number;
  /** Hybrid → tree boundary (default 128). */
  treeThreshold?: number;
}

const DEFAULT_MAX_FAN_OUT = 32;
const DEFAULT_BRANCHING_FACTOR = 8;
const DEFAULT_TREE_THRESHOLD = 128;
const PER_DO_LOADER_CAP = 4;

/**
 * Decide the topology and build the dispatch plan.
 *
 * Rules (DESIGN §4.1):
 *   size ≤ 4                     → in-do
 *   size 5..treeThreshold (128)  → hybrid (ceil(size/4) child DOs × 4 loaders)
 *   size > treeThreshold         → tree (multi-tier with branching factor F)
 *
 * `loader-only` is NOT auto-selectable. Reach it via `Parallel.loaderOnly()`.
 */
export function selectTopology(size: number, opts: SelectorOptions = {}): TopologyPlan {
  if (!Number.isFinite(size) || size < 0) {
    throw new TopologyError(`size must be a non-negative integer, got ${size}`);
  }
  const requested = opts.topology ?? 'auto';
  const branchingFactor = opts.branchingFactor ?? DEFAULT_BRANCHING_FACTOR;
  const maxFanOut = opts.maxFanOut ?? DEFAULT_MAX_FAN_OUT;
  const treeThreshold = opts.treeThreshold ?? DEFAULT_TREE_THRESHOLD;

  if (branchingFactor < 4 || branchingFactor > 16) {
    throw new TopologyError(`branchingFactor must be in [4,16], got ${branchingFactor}`);
  }
  if (maxFanOut < 1 || maxFanOut > 64) {
    throw new TopologyError(`maxFanOut must be in [1,64], got ${maxFanOut}`);
  }

  if (size === 0) {
    return { topology: 'in-do', size: 0 } satisfies InDoPlan;
  }

  if (requested !== 'auto') {
    return buildPinnedPlan(size, requested, { branchingFactor, maxFanOut });
  }

  // Auto.
  if (size <= PER_DO_LOADER_CAP) {
    return { topology: 'in-do', size } satisfies InDoPlan;
  }
  if (size <= treeThreshold) {
    return buildHybridPlan(size, maxFanOut);
  }
  return buildTreePlan(size, branchingFactor, maxFanOut);
}

function buildPinnedPlan(
  size: number,
  requested: Exclude<Topology, 'auto'>,
  opts: { branchingFactor: number; maxFanOut: number },
): TopologyPlan {
  if (requested === 'in-do') {
    if (size > PER_DO_LOADER_CAP) {
      throw new TopologyError(
        `topology: 'in-do' supports size <= ${PER_DO_LOADER_CAP}; got ${size}. ` +
          `Use 'auto' or 'hybrid' for larger sizes.`,
      );
    }
    return { topology: 'in-do', size } satisfies InDoPlan;
  }
  if (requested === 'hybrid') {
    const ceiling = opts.maxFanOut * PER_DO_LOADER_CAP;
    if (size > ceiling) {
      throw new TopologyError(
        `topology: 'hybrid' with maxFanOut=${opts.maxFanOut} supports size <= ${ceiling}; got ${size}.`,
      );
    }
    return buildHybridPlan(size, opts.maxFanOut);
  }
  // tree
  return buildTreePlan(size, opts.branchingFactor, opts.maxFanOut);
}

function buildHybridPlan(size: number, maxFanOut: number): HybridPlan {
  // `n = ceil(size/4)`. Normally `n ≤ maxFanOut` because the auto-selector
  // routes to `tree` once `size > treeThreshold` (default 128 = maxFanOut × 4).
  // When the caller raises `treeThreshold` past that ceiling to keep hybrid
  // in play, `n` grows past `maxFanOut`; we honor it because the user has
  // opted in. (`maxFanOut` remains the per-tier RPC fan-out cap inside the
  // tree topology — see buildTreePlan.)
  void maxFanOut;
  const n = Math.ceil(size / PER_DO_LOADER_CAP);
  const leafShape = balancedFill(size, n, PER_DO_LOADER_CAP);
  return { topology: 'hybrid', size, leafShape };
}

/**
 * Build a tree plan recursively. Each tier divides `size` evenly across
 * `branchingFactor` sub-coords; the deepest tier is a hybrid leaf.
 *
 * Math (DESIGN §4.3): K = ceil(log_F(size / 4)). `K` counts the coordinator
 * tiers ABOVE the hybrid leaf (so total RPC depth = K+1).
 */
function buildTreePlan(
  size: number,
  branchingFactor: number,
  maxFanOut: number,
  forcedDepth?: number,
): TreePlan {
  const F = branchingFactor;
  const K = forcedDepth ?? Math.max(1, Math.ceil(Math.log(size / PER_DO_LOADER_CAP) / Math.log(F)));

  // Distribute `size` across F children. No per-slot cap above the hybrid
  // leaf — a child can hold up to `size` (with one branch full, others empty).
  const childSizes = balancedFill(size, F, size);
  const usedChildren = childSizes.filter((s) => s > 0);

  // Hybrid-leaf threshold per child: maxFanOut × 4 (the hybrid ceiling).
  const HYBRID_LEAF_CEILING = maxFanOut * PER_DO_LOADER_CAP;

  const children = usedChildren.map((slice): HybridPlan | TreePlan => {
    // Bottom tier: child is a hybrid leaf.
    if (K <= 1) return buildHybridPlan(Math.min(slice, HYBRID_LEAF_CEILING), maxFanOut);
    // Above the bottom tier: recurse into a deeper sub-coord with depth K-1.
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
