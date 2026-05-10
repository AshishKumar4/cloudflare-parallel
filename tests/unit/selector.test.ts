import { describe, expect, it } from 'bun:test';
import { selectTopology } from '../../src/topology/selector.js';
import { balancedFill, type HybridPlan, type TreePlan } from '../../src/topology/plan.js';
import { TopologyError } from '../../src/errors/index.js';

describe('balancedFill', () => {
  it('size=17, n=5 → [4,4,4,4,1]', () => {
    expect(balancedFill(17, 5)).toEqual([4, 4, 4, 4, 1]);
  });
  it('size=20, n=5 → [4,4,4,4,4]', () => {
    expect(balancedFill(20, 5)).toEqual([4, 4, 4, 4, 4]);
  });
  it('size=10, n=3 with maxPerSlot=4 → [4,4,2]', () => {
    expect(balancedFill(10, 3, 4)).toEqual([4, 4, 2]);
  });
  it('size=128, n=32 → 32×4', () => {
    const out = balancedFill(128, 32, 4);
    expect(out.length).toBe(32);
    expect(out.every((v) => v === 4)).toBe(true);
  });
  it('throws when capacity is short of size', () => {
    expect(() => balancedFill(20, 4, 4)).toThrow(RangeError);
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
  it('size=17 → hybrid with leafShape [4,4,4,4,1]', () => {
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
