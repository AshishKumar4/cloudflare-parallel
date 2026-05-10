import { describe, expect, it } from 'bun:test';
import { buildCacheKey, extractFnShapeHash } from '../../src/loader/cache-key.js';

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
});
