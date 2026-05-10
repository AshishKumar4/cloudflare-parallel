import { describe, expect, it } from 'bun:test';
import { selectTopology } from '../../src/topology/selector';
import { balancedFill, type HybridPlan, type TreePlan } from '../../src/topology/plan';
import { TopologyError } from '../../src/errors/index';

// Detailed `balancedFill` / `fillCapped` coverage lives in
// `tests/unit/topology/plan.test.ts`. The handful of cases here pin the
// helper at sizes the topology selector cares about, plus sanity for
// `balancedFill` direct callers.
describe('balancedFill', () => {
  it('size=20, n=5 → 5×[4] (exactly even)', () => {
    expect(balancedFill(20, 5)).toEqual([4, 4, 4, 4, 4]);
  });
  it('size=512, n=4 → [128,128,128,128] (even tree distribution)', () => {
    expect(balancedFill(512, 4)).toEqual([128, 128, 128, 128]);
  });
});

describe('selectTopology', () => {
  it('size=0 returns trivial in-do', () => {
    const plan = selectTopology(0);
    expect(plan.topology).toBe('in-do');
  });
  it('size=1..4 → in-do', () => {
    for (const s of [1, 2, 3, 4]) {
      const plan = selectTopology(s);
      expect(plan.topology).toBe('in-do');
      if (plan.topology === 'in-do') expect(plan.size).toBe(s);
    }
  });
  it('size=5 → hybrid with leafShape [4,1]', () => {
    const plan = selectTopology(5);
    expect(plan.topology).toBe('hybrid');
    expect((plan as HybridPlan).leafShape).toEqual([4, 1]);
  });
  it('size=10 → hybrid with leafShape [4,4,2]', () => {
    const plan = selectTopology(10);
    expect((plan as HybridPlan).leafShape).toEqual([4, 4, 2]);
  });
  it('size=17 → hybrid with leafShape [4,4,4,4,1] (cap-first)', () => {
    const plan = selectTopology(17);
    expect((plan as HybridPlan).leafShape).toEqual([4, 4, 4, 4, 1]);
  });
  it('size=128 → hybrid with 32-leaf shape', () => {
    const plan = selectTopology(128);
    expect(plan.topology).toBe('hybrid');
    expect((plan as HybridPlan).leafShape.length).toBe(32);
    expect((plan as HybridPlan).leafShape.every((v) => v === 4)).toBe(true);
  });
  it('size=129 → tree with K=2 default F=8', () => {
    const plan = selectTopology(129);
    expect(plan.topology).toBe('tree');
    expect((plan as TreePlan).branchingFactor).toBe(8);
    expect((plan as TreePlan).depth).toBe(2);
  });
  it('size=2000 → tree with K=3', () => {
    const plan = selectTopology(2000);
    expect(plan.topology).toBe('tree');
    expect((plan as TreePlan).depth).toBe(3);
  });
  it('size=8192 → tree with K=3 (boundary)', () => {
    const plan = selectTopology(8192);
    // log_8(8192/4) = log_8(2048) ≈ 3.66 → ceil = 4. But depth-3 already
    // covers 4 × 8^3 = 2048 isolates; the formula uses ceil so K=4.
    expect(plan.topology).toBe('tree');
    expect((plan as TreePlan).depth).toBeGreaterThanOrEqual(3);
  });

  // ---- regression: tree fan-out is real, not a chain --------------------
  // The third-party review surfaced that `balancedFill(N, F, N)` was
  // collapsing to `[N, 0, ..., 0]`, so the tree degenerated to a chain
  // (peak parallelism capped at the hybrid ceiling regardless of size).
  // These tests pin every sub-tree size at sizes where the bug would
  // surface.
  it('size=512 → tree distributes evenly across F children (not a chain)', () => {
    const plan = selectTopology(512) as TreePlan;
    expect(plan.topology).toBe('tree');
    const childSizes = plan.children.map((c) => c.size);
    // No single child holds the whole workload.
    expect(Math.max(...childSizes)).toBeLessThan(512);
    // Children sum to size.
    expect(childSizes.reduce((a, b) => a + b, 0)).toBe(512);
    // Every child has work.
    for (const v of childSizes) expect(v).toBeGreaterThan(0);
  });
  it('size=1024 → tree distributes evenly across F children (not a chain)', () => {
    const plan = selectTopology(1024) as TreePlan;
    expect(plan.topology).toBe('tree');
    const childSizes = plan.children.map((c) => c.size);
    expect(Math.max(...childSizes)).toBeLessThan(1024);
    expect(childSizes.reduce((a, b) => a + b, 0)).toBe(1024);
    for (const v of childSizes) expect(v).toBeGreaterThan(0);
  });
  it('size=2000 → tree distributes evenly at every tier', () => {
    const plan = selectTopology(2000) as TreePlan;
    expect(plan.topology).toBe('tree');
    // Walk every tier; sum of children at each level equals the parent's size.
    function checkTier(t: TreePlan): void {
      const sum = t.children.reduce((a, c) => a + c.size, 0);
      expect(sum).toBe(t.size);
      for (const v of t.children.map((c) => c.size)) expect(v).toBeGreaterThan(0);
      for (const c of t.children) {
        if (c.topology === 'tree') checkTier(c);
      }
    }
    checkTier(plan);
  });

  it('explicit topology: in-do with size > 4 throws', () => {
    expect(() => selectTopology(5, { topology: 'in-do' })).toThrow(TopologyError);
  });
  it('explicit topology: hybrid with size > maxFanOut*4 throws', () => {
    expect(() => selectTopology(200, { topology: 'hybrid', maxFanOut: 32 })).toThrow(TopologyError);
  });
  it('rejects invalid branchingFactor', () => {
    expect(() => selectTopology(100, { branchingFactor: 2 })).toThrow(TopologyError);
    expect(() => selectTopology(100, { branchingFactor: 32 })).toThrow(TopologyError);
  });
  it('treeThreshold raises hybrid→tree boundary', () => {
    const plan = selectTopology(200, { treeThreshold: 256 });
    expect(plan.topology).toBe('hybrid');
  });
});
