import { describe, expect, it } from 'bun:test';
import { selectTopology } from '../../src/topology/selector';
import { balancedFill, type HybridPlan, type TreePlan } from '../../src/topology/plan';
import { TopologyError } from '../../src/errors/index';

// Detailed `balancedFill` coverage lives in
// `tests/unit/topology/plan.test.ts`. The cases here pin the helper at
// sizes the topology selector cares about plus sanity for direct
// callers.
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

  // `in-do` is now the single-job fast path. Fan-outs of size ≥ 2 must
  // route to `hybrid` so each task lands in its own leaf DO process
  // (loaders inside one workerd process share its V8 scheduler thread
  // and serialize on CPU).
  it('size=1 → in-do (single-job fast path)', () => {
    const plan = selectTopology(1);
    expect(plan.topology).toBe('in-do');
    if (plan.topology === 'in-do') expect(plan.size).toBe(1);
  });

  it('size=2..4 → hybrid (one job per leaf DO)', () => {
    for (const s of [2, 3, 4]) {
      const plan = selectTopology(s);
      expect(plan.topology).toBe('hybrid');
      if (plan.topology === 'hybrid') {
        expect(plan.leafShape).toEqual(new Array(s).fill(1));
      }
    }
  });

  it('size=5 → hybrid with N=5 leaves (one job each)', () => {
    const plan = selectTopology(5);
    expect(plan.topology).toBe('hybrid');
    expect((plan as HybridPlan).leafShape).toEqual([1, 1, 1, 1, 1]);
  });

  it('size=17 → hybrid with N=17 leaves', () => {
    const plan = selectTopology(17);
    expect((plan as HybridPlan).leafShape.length).toBe(17);
    expect((plan as HybridPlan).leafShape.every((v) => v === 1)).toBe(true);
  });

  it('size=32 → hybrid (at the default maxFanOut boundary)', () => {
    const plan = selectTopology(32);
    expect(plan.topology).toBe('hybrid');
    expect((plan as HybridPlan).leafShape.length).toBe(32);
  });

  it('size=33 → tree (auto-promotes once size exceeds maxFanOut)', () => {
    const plan = selectTopology(33);
    expect(plan.topology).toBe('tree');
    expect((plan as TreePlan).branchingFactor).toBe(8);
  });

  it('size=2000 → tree with depth >= 2', () => {
    const plan = selectTopology(2000);
    expect(plan.topology).toBe('tree');
    expect((plan as TreePlan).depth).toBeGreaterThanOrEqual(2);
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
    expect(Math.max(...childSizes)).toBeLessThan(512);
    expect(childSizes.reduce((a, b) => a + b, 0)).toBe(512);
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

  it("explicit topology: 'in-do' with size > 1 throws", () => {
    expect(() => selectTopology(2, { topology: 'in-do' })).toThrow(TopologyError);
    expect(() => selectTopology(4, { topology: 'in-do' })).toThrow(TopologyError);
  });

  it("explicit topology: 'hybrid' with size > maxFanOut throws", () => {
    expect(() => selectTopology(33, { topology: 'hybrid', maxFanOut: 32 })).toThrow(
      TopologyError,
    );
  });

  it('rejects invalid branchingFactor', () => {
    expect(() => selectTopology(100, { branchingFactor: 2 })).toThrow(TopologyError);
    expect(() => selectTopology(100, { branchingFactor: 32 })).toThrow(TopologyError);
  });

  it('treeThreshold raises hybrid→tree boundary', () => {
    // Default treeThreshold = maxFanOut (32). Raise maxFanOut to 64
    // (the implementation cap) and threshold to 64; size=60 should
    // then stay hybrid instead of auto-promoting to tree.
    const plan = selectTopology(60, { treeThreshold: 64, maxFanOut: 64 });
    expect(plan.topology).toBe('hybrid');
  });
});
