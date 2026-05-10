/**
 * Typed AST describing a topology execution plan.
 *
 * The selector returns a `TopologyPlan` for a given `size` and options.
 * Coordinator implementations consume the plan: in-DO walks the leaf shape
 * directly; hybrid dispatches one RPC per leaf entry; tree recursively
 * dispatches sliced plans to sub-coordinators.
 *
 * Goldens for these shapes live in tests/unit/selector.test.ts.
 */

export type TopologyName = 'loader-only' | 'in-do' | 'hybrid' | 'tree';

export interface InDoPlan {
  topology: 'in-do';
  /** size in 1..4. Each entry = one loader to spawn inside the coordinator DO. */
  size: number;
}

export interface HybridPlan {
  topology: 'hybrid';
  /** Total number of jobs. Sum of `leafShape`. */
  size: number;
  /** Per-child-DO loader count. Length = N = ceil(size/4). Each entry ≤ 4. */
  leafShape: number[];
}

export interface TreePlan {
  topology: 'tree';
  size: number;
  /** Branching factor (4..16). */
  branchingFactor: number;
  /** Depth K (coordinator tiers above the hybrid leaf). */
  depth: number;
  /**
   * Recursive children. At the deepest level, each child is a HybridPlan
   * (the leaf hybrid); above that, each child is a TreePlan with depth K-1.
   */
  children: Array<HybridPlan | TreePlan>;
}

export interface LoaderOnlyPlan {
  topology: 'loader-only';
  /** size in 1..3 (Worker fetch handler cap). */
  size: number;
}

export type TopologyPlan = InDoPlan | HybridPlan | TreePlan | LoaderOnlyPlan;

// ---- balanced-fill leaf-shape distribution -----------------------------

/**
 * Distribute `size` jobs across `n` slots with no slot exceeding `maxPerSlot`.
 *
 * Algorithm: fill slots 4-at-a-time from index 0; the last slot gets the
 * remainder. This matches DESIGN §4.2 worked examples:
 *   size=17, n=5  -> [4,4,4,4,1]
 *   size=20, n=5  -> [4,4,4,4,4]
 *   size=10, n=3  -> [4,3,3]
 *   size=128,n=32 -> 32×[4]
 */
export function balancedFill(size: number, n: number, maxPerSlot = 4): number[] {
  if (n <= 0) return [];
  if (size <= 0) return new Array(n).fill(0);
  if (n * maxPerSlot < size) {
    throw new RangeError(`balancedFill: n=${n} slots × maxPerSlot=${maxPerSlot} < size=${size}`);
  }
  const out = new Array(n).fill(0) as number[];
  let remaining = size;
  for (let i = 0; i < n && remaining > 0; i++) {
    const here = Math.min(maxPerSlot, remaining);
    out[i] = here;
    remaining -= here;
  }
  return out;
}
