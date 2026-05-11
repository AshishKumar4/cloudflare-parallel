/**
 * Typed AST describing a topology execution plan.
 *
 * The selector returns a `TopologyPlan` for a given `size` and options.
 * Coordinator implementations consume the plan: `in-do` is a single-job
 * fast path (one loaded isolate in the parent process); `hybrid`
 * dispatches one RPC per leaf entry to one worker DO; `tree` recursively
 * dispatches sliced plans to sub-coordinators.
 *
 * **Parallelism model.** Each worker DO runs as its own workerd process
 * on its own V8 scheduler thread. CPU parallelism therefore scales with
 * DO count, not with loaders-per-DO. The library dispatches one job per
 * leaf DO so the per-leaf loader cap is irrelevant; the binding
 * constraint is the per-coordinator RPC fan-out (default 32).
 *
 * Goldens for these shapes live in `tests/unit/selector.test.ts` and
 * `tests/unit/topology/plan.test.ts`.
 */

export type TopologyName = 'loader-only' | 'in-do' | 'hybrid' | 'tree';

export interface InDoPlan {
  topology: 'in-do';
  /**
   * size in {0, 1}. Reserved for single-shot `submit()` and empty
   * `pool.map([], fn)`. Fan-outs of size ≥ 2 route to `hybrid` because
   * loaders inside a single DO process share its V8 scheduler thread.
   */
  size: number;
}

export interface HybridPlan {
  topology: 'hybrid';
  /** Total number of jobs. Equal to `leafShape.length`; each leaf gets one job. */
  size: number;
  /**
   * One entry per leaf DO. Every entry is `1` — the library dispatches
   * one job per leaf DO so CPU parallelism scales linearly with DO
   * count. Length = `size`.
   *
   * The shape is retained as an array (rather than just `size`) so the
   * dispatch path doesn't need a special case for "all-ones" and so
   * sub-coordinators can carve out arbitrary leaf ranges.
   */
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
   * Recursive children. At the deepest level, each child is a
   * `HybridPlan` (one leaf DO per job); above that, each child is a
   * `TreePlan` with depth K-1.
   */
  children: Array<HybridPlan | TreePlan>;
}

export interface LoaderOnlyPlan {
  topology: 'loader-only';
  /** size in 1..3 (Worker fetch handler cap). */
  size: number;
}

export type TopologyPlan = InDoPlan | HybridPlan | TreePlan | LoaderOnlyPlan;

// ---- balanced-fill distribution helper ---------------------------------

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
 * The optional third argument is preserved as a sanity check for
 * callers that want to assert each slot stays under some maximum.
 * Overflow throws so misuse surfaces immediately.
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
 * @deprecated Pre-redesign helper for the "4 loaders per leaf DO"
 * topology. Retained for backward compatibility — the current
 * selector dispatches one job per leaf DO, so the cap-first
 * distribution is no longer used internally.
 *
 * Cap-first distribution. Fill `maxPerSlot`-at-a-time from index 0; the
 * last non-zero slot holds the remainder.
 *
 *   fillCapped(17, 5, 4)  -> [4, 4, 4, 4, 1]
 *   fillCapped(20, 5, 4)  -> [4, 4, 4, 4, 4]
 *   fillCapped(10, 3, 4)  -> [4, 4, 2]
 *
 * Throws `RangeError` if `n * maxPerSlot < size`.
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
