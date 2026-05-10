import { describe, expect, it } from 'bun:test';
import { buildCacheKey, extractFnShapeHash } from '../../src/loader/cache-key';

describe('buildCacheKey', () => {
  it('stable strategy produces a stable key', () => {
    const a = buildCacheKey({ fnSource: 'fn', contextHash: '', strategy: 'stable' });
    const b = buildCacheKey({ fnSource: 'fn', contextHash: '', strategy: 'stable' });
    expect(a).toBe(b);
    expect(a).toMatch(/^cfp:[0-9a-z]+$/);
  });

  it('fresh strategy increments the counter', () => {
    const a = buildCacheKey({ fnSource: 'fn', contextHash: '', strategy: 'fresh' });
    const b = buildCacheKey({ fnSource: 'fn', contextHash: '', strategy: 'fresh' });
    expect(a).not.toBe(b);
  });

  it('forceFresh overrides stable', () => {
    const a = buildCacheKey({
      fnSource: 'fn',
      contextHash: '',
      strategy: 'stable',
      forceFresh: true,
    });
    const b = buildCacheKey({
      fnSource: 'fn',
      contextHash: '',
      strategy: 'stable',
      forceFresh: true,
    });
    expect(a).not.toBe(b);
  });

  it('auto strategy buckets within a 60s window', () => {
    const a = buildCacheKey({ fnSource: 'fn', contextHash: '', strategy: 'auto' });
    const b = buildCacheKey({ fnSource: 'fn', contextHash: '', strategy: 'auto' });
    expect(a).toBe(b);
    expect(a).toMatch(/:w\d+$/);
  });

  it('auto strategy differentiates across fn shapes', () => {
    const a = buildCacheKey({ fnSource: 'fnA', contextHash: '', strategy: 'auto' });
    const b = buildCacheKey({ fnSource: 'fnB', contextHash: '', strategy: 'auto' });
    expect(a).not.toBe(b);
  });

  it('auto strategy differentiates across context hashes', () => {
    const a = buildCacheKey({ fnSource: 'fn', contextHash: 'h1', strategy: 'auto' });
    const b = buildCacheKey({ fnSource: 'fn', contextHash: 'h2', strategy: 'auto' });
    expect(a).not.toBe(b);
  });

  it('extractFnShapeHash recovers the shape hash', () => {
    const k = buildCacheKey({ fnSource: 'x', contextHash: '', strategy: 'stable' });
    expect(extractFnShapeHash(k)).toBeTruthy();
  });

  // ---- regression: default `'stable'` must not multiply cache keys per
  // fn shape across time. The earlier default `'auto'` bucketed each fn
  // shape into 60s windows, so any deployment that rotates >50 distinct
  // shape-windows per hour evicted hot loaders from the per-owner LRU
  // (cap ~50). Surfaced in third-party review.
  it('regression: stable default produces ONE key per fn shape across time', () => {
    // Simulate 100 calls of the same fn shape, spread across a fake clock.
    const real = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(
          buildCacheKey({ fnSource: 'fn', contextHash: '', strategy: 'stable' }),
        );
        now += 90_000; // 90s gap each iteration → would land in different `auto` buckets.
      }
      expect(keys.size).toBe(1);
    } finally {
      Date.now = real;
    }
  });

  it('regression: stable default keeps fn-shape diversity bounded by shape count, not time', () => {
    // 50 fn shapes × 100 calls each across 2 hours of fake time. With
    // `'stable'` we expect exactly 50 cache keys (one per shape). With
    // `'auto'` (60s window, 120 windows per 2h) we'd see 50 × 120 = 6000
    // keys — guaranteed LRU thrash on a 50-entry cache.
    const real = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      const keys = new Set<string>();
      for (let cycle = 0; cycle < 100; cycle++) {
        for (let shape = 0; shape < 50; shape++) {
          keys.add(
            buildCacheKey({
              fnSource: `fn-${shape}`,
              contextHash: '',
              strategy: 'stable',
            }),
          );
        }
        now += 90_000; // 90s per cycle (≥ AUTO_WINDOW_MS).
      }
      expect(keys.size).toBe(50);
    } finally {
      Date.now = real;
    }
  });

  it('opt-in `auto` still rotates buckets per window (preserved behaviour)', () => {
    const real = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      const k1 = buildCacheKey({
        fnSource: 'fn',
        contextHash: '',
        strategy: 'auto',
      });
      now += 90_000;
      const k2 = buildCacheKey({
        fnSource: 'fn',
        contextHash: '',
        strategy: 'auto',
      });
      expect(k1).not.toBe(k2);
    } finally {
      Date.now = real;
    }
  });
});
