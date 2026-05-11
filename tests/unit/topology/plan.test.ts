/**
 * Regression tests for `balancedFill` in `src/topology/plan.ts`.
 *
 * Background: a third-party review surfaced that the prior
 * `balancedFill` implementation was cap-first (fill 4-at-a-time, last
 * slot remainder), which the tree topology selector was calling with
 * `maxPerSlot = size`. That collapsed the tree to a chain —
 * `balancedFill(512, 4, 512)` returned `[512, 0, 0, 0]` instead of
 * `[128, 128, 128, 128]`. Peak parallelism was capped at the hybrid
 * ceiling regardless of size.
 *
 * Fix: `balancedFill` now does true even distribution
 * (`floor(size/n)` base + 1-extra to first `size mod n` slots).
 *
 * These tests pin the function at the sizes the tree topology cares
 * about (N = 128 / 256 / 512 / 1024 / 2000 / 8192) so the regression
 * can never silently come back.
 */
import { describe, expect, it } from 'bun:test';
import { balancedFill } from '../../../src/topology/plan';

describe('balancedFill — even distribution across slots', () => {
  it('exactly even: 512 across 4 slots', () => {
    expect(balancedFill(512, 4)).toEqual([128, 128, 128, 128]);
  });

  it('exactly even: 128 across 8 slots', () => {
    expect(balancedFill(128, 8)).toEqual([16, 16, 16, 16, 16, 16, 16, 16]);
  });

  it('exactly even: 256 across 8 slots', () => {
    expect(balancedFill(256, 8)).toEqual([32, 32, 32, 32, 32, 32, 32, 32]);
  });

  it('exactly even: 1024 across 8 slots', () => {
    expect(balancedFill(1024, 8)).toEqual([128, 128, 128, 128, 128, 128, 128, 128]);
  });

  it('with remainder: 17 across 5 slots → [4,4,3,3,3]', () => {
    // 17/5 = 3 base, 2 slots get +1.
    expect(balancedFill(17, 5)).toEqual([4, 4, 3, 3, 3]);
  });

  it('with remainder: 10 across 3 slots → [4,3,3]', () => {
    expect(balancedFill(10, 3)).toEqual([4, 3, 3]);
  });

  it('with remainder: 2000 across 8 slots → 250 each', () => {
    // 2000/8 = 250 exactly.
    expect(balancedFill(2000, 8)).toEqual([250, 250, 250, 250, 250, 250, 250, 250]);
  });

  it('with remainder: 2001 across 8 slots → first slot has the extra', () => {
    expect(balancedFill(2001, 8)).toEqual([251, 250, 250, 250, 250, 250, 250, 250]);
  });

  it('size=0 returns all zeros', () => {
    expect(balancedFill(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('n=0 returns empty array', () => {
    expect(balancedFill(10, 0)).toEqual([]);
  });

  it('summing the output recovers the original size', () => {
    for (const N of [1, 5, 17, 100, 128, 256, 512, 1024, 2000, 8192]) {
      for (const F of [4, 5, 8, 13, 16]) {
        const out = balancedFill(N, F);
        expect(out.length).toBe(F);
        expect(out.reduce((a, b) => a + b, 0)).toBe(N);
      }
    }
  });

  it('output is monotone non-increasing (max-min ≤ 1)', () => {
    // Even distribution: any two slots differ by at most 1.
    for (const N of [1, 17, 100, 513, 1023, 2001, 8192]) {
      for (const F of [4, 8, 13, 16]) {
        const out = balancedFill(N, F);
        const max = Math.max(...out);
        const min = Math.min(...out);
        expect(max - min).toBeLessThanOrEqual(1);
      }
    }
  });

  it('regression: balancedFill(N, F, ceil(N/F)) is balanced (the corrected call shape)', () => {
    // The reviewer's repro: tree topology was passing `maxPerSlot = size`,
    // collapsing to a chain. The corrected pattern is to pass either no
    // cap or `ceil(N/F)` (which is the maximum value any balanced slot can
    // take). Pin both for sizes 128/256/512/1024.
    const cases: Array<[number, number]> = [
      [128, 4],
      [128, 8],
      [256, 4],
      [256, 8],
      [512, 4],
      [512, 8],
      [1024, 4],
      [1024, 8],
    ];
    for (const [N, F] of cases) {
      const cap = Math.ceil(N / F);
      const out = balancedFill(N, F, cap);
      expect(out.length).toBe(F);
      expect(out.reduce((a, b) => a + b, 0)).toBe(N);
      // No slot may be 0 when N >= F.
      if (N >= F) {
        for (const v of out) expect(v).toBeGreaterThan(0);
      }
      // Every slot is within 1 of the others.
      const max = Math.max(...out);
      const min = Math.min(...out);
      expect(max - min).toBeLessThanOrEqual(1);
    }
  });

  it('regression: balancedFill(512, 4) is NOT [512, 0, 0, 0]', () => {
    // The exact reviewer reproduction. Without the fix this returned
    // [512, 0, 0, 0] and tree fan-out collapsed to a chain.
    expect(balancedFill(512, 4)).not.toEqual([512, 0, 0, 0]);
    expect(balancedFill(512, 4)).toEqual([128, 128, 128, 128]);
  });

  it('regression: balancedFill(128, 4) is NOT [128, 0, 0, 0]', () => {
    expect(balancedFill(128, 4)).not.toEqual([128, 0, 0, 0]);
    expect(balancedFill(128, 4)).toEqual([32, 32, 32, 32]);
  });

  it('with maxPerSlot sanity check: throws if cap is below the balanced ceiling', () => {
    // 17/5 = 4 ceiling. A cap of 3 is impossible.
    expect(() => balancedFill(17, 5, 3)).toThrow(RangeError);
  });

  it('with maxPerSlot at exactly the ceiling: passes through', () => {
    expect(balancedFill(17, 5, 4)).toEqual([4, 4, 3, 3, 3]);
  });
});
