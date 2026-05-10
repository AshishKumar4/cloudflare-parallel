/**
 * Typed AST describing a topology execution plan.
 *
 * The selector returns a `TopologyPlan` for a given `size` and options.
 * Coordinator implementations consume the plan: in-DO walks the leaf shape
 * directly; hybrid dispatches one RPC per leaf entry; tree recursively
 * dispatches sliced plans to sub-coordinators.
 *
 * Goldens for these shapes live in tests/unit/selector.test.ts and
 * tests/unit/topology/plan.test.ts.
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
 * Distribute `size` jobs across `n` slots as evenly as possible.
 *
 * Each slot receives `floor(size/n)` items; the first `size mod n` slots
 * receive one extra. Used by the tree topology to split a workload across
 * the branching factor — every child gets a roughly equal share so the
 * fan-out is real (not a chain).
 *
 *   balancedFill(512, 4)  -> [128, 128, 128, 128]
 *   balancedFill(128, 8)  -> [16, 16, 16, 16, 16, 16, 16, 16]
 *   balancedFill(17, 5)   -> [4, 4, 3, 3, 3]
 *   balancedFill(10, 3)   -> [4, 3, 3]
 *   balancedFill(0, 4)    -> [0, 0, 0, 0]
 *
 * The optional third argument is preserved for backward compatibility with
 * earlier callers that passed a per-slot cap. When supplied, slots are
 * capped at `maxPerSlot` and any overflow throws — i.e. the caller is
 * stating "I expect each slot to receive at most this many". This matches
 * the v0.3 hybrid-leaf usage where slots are 4-loader DOs.
 *
 * Note: callers that want the old "fill 4-at-a-time, last slot gets the
 * remainder" hybrid leaf shape should use {@link fillCapped} instead. The
 * two distributions are intentionally distinct — see DESIGN §4.2 and
 * §4.3.
 */
export function balancedFill(size: number, n: number, maxPerSlot?: number): number[] {
  if (n <= 0) return [];
  if (size <= 0) return new Array(n).fill(0);
  if (maxPerSlot !== undefined && n * maxPerSlot < size) {
    throw new RangeError(
      `balancedFill: n=${n} slots × maxPerSlot=${maxPerSlot} < size=${size}`,
    );
  }
  const out = new Array(n).fill(0) as number[];
  const base = Math.floor(size / n);
  const extras = size % n;
  for (let i = 0; i < n; i++) {
    out[i] = base + (i < extras ? 1 : 0);
  }
  // The cap is a sanity check, not a constraint: with `n * maxPerSlot >=
  // size` the per-slot value is at most `ceil(size/n)`, which is bounded
  // by `maxPerSlot` whenever `maxPerSlot >= ceil(size/n)`. Throw on any
  // overflow so misuse surfaces immediately.
  if (maxPerSlot !== undefined) {
    for (const v of out) {
      if (v > maxPerSlot) {
        throw new RangeError(
          `balancedFill: slot value ${v} exceeds maxPerSlot=${maxPerSlot}`,
        );
      }
    }
  }
  return out;
}

/**
 * Cap-first distribution. Fill `maxPerSlot`-at-a-time from index 0; the
 * last non-zero slot holds the remainder. Used by the hybrid topology to
 * shape per-leaf loader counts — each leaf DO is a 4-loader bucket, and
 * the leaf shape tracks "how many loaders per leaf DO".
 *
 *   fillCapped(17, 5, 4)  -> [4, 4, 4, 4, 1]
 *   fillCapped(20, 5, 4)  -> [4, 4, 4, 4, 4]
 *   fillCapped(10, 3, 4)  -> [4, 4, 2]
 *   fillCapped(128, 32, 4) -> 32 × [4]
 *
 * Throws `RangeError` if `n * maxPerSlot < size` (caller's distribution
 * is impossible at the requested cap).
 */
export function fillCapped(size: number, n: number, maxPerSlot: number): number[] {
  if (n <= 0) return [];
  if (size <= 0) return new Array(n).fill(0);
  if (n * maxPerSlot < size) {
    throw new RangeError(
      `fillCapped: n=${n} slots × maxPerSlot=${maxPerSlot} < size=${size}`,
    );
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
