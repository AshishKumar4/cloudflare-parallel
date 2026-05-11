/**
 * P0 regression: `buildCacheKey` must return DISTINCT keys for distinct
 * `taskSlot` indices in the same fan-out, AND the same key for the same
 * (fnSource, contextHash, taskSlot) tuple across calls.
 *
 * Background: `pool.map([items], fn, opts)` hashes the same `fnSource +
 * contextHash` for every task, so the prior implementation returned the
 * SAME `cfp:<hash>` key for every concurrent `loader.get(...)`. The
 * Worker Loader's by-key caching collapsed all N concurrent calls onto
 * one loaded isolate; tasks then serialized on that single V8 context.
 * Empirical speedup at N=4: 1.05× (essentially serial).
 *
 * The fix (this test pins): when `taskSlot: i` is present, the key
 * becomes `cfp:<hash>:slot-<i>` — N distinct keys for N concurrent
 * tasks → N distinct isolates. POC validated 4.03× at N=4 with this
 * pattern.
 *
 * Reuse contract: same fn + same slot across calls → same key →
 * warm-reuse. Different fn → different `<hash>` regardless of slot.
 */
import { describe, expect, it } from 'bun:test';
import { buildCacheKey, extractFnShapeHash } from '../../src/loader/cache-key';

const FN = '(x) => x * 2';
const CTX = '';

describe('buildCacheKey — taskSlot', () => {
  it('distinct slots produce distinct keys (same fn)', () => {
    const k0 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 0 });
    const k1 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 1 });
    const k2 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 2 });
    const k3 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 3 });
    expect(new Set([k0, k1, k2, k3]).size).toBe(4);
  });

  it('same slot across calls produces same key (warm reuse)', () => {
    const a = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 0 });
    const b = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 0 });
    expect(a).toBe(b);
  });

  it('slot 0 (omitted vs explicit) — they differ; single-shot should pass `taskSlot: 0` explicitly to share with fan-out slot 0', () => {
    // No `taskSlot` → no slot suffix.
    const omitted = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable' });
    const explicit = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 0 });
    // These are intentionally different — omitted is the legacy
    // single-key behaviour; explicit slot-0 is the fan-out's slot-0.
    expect(omitted).not.toBe(explicit);
    // The library passes `taskSlot: 0` explicitly for single-shot
    // submits so they reuse the same isolate as a future fan-out's
    // slot-0 task. Verified at the dispatch layer (see prewarm /
    // coordinator changes).
  });

  it('slot keys share the same fn-shape hash', () => {
    const k0 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 0 });
    const k1 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'stable', taskSlot: 1 });
    // The fn-shape hash is the second `:` segment.
    expect(extractFnShapeHash(k0)).toBe(extractFnShapeHash(k1));
    expect(extractFnShapeHash(k0)).not.toBeNull();
  });

  it('distinct fns produce distinct keys at the same slot', () => {
    const a = buildCacheKey({ fnSource: '(x) => x * 2', contextHash: CTX, strategy: 'stable', taskSlot: 0 });
    const b = buildCacheKey({ fnSource: '(x) => x + 1', contextHash: CTX, strategy: 'stable', taskSlot: 0 });
    expect(a).not.toBe(b);
  });

  it('slot suffix is appended to `auto` strategy too', () => {
    const k0 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'auto', taskSlot: 0 });
    const k1 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'auto', taskSlot: 1 });
    expect(k0).not.toBe(k1);
    expect(k0).toMatch(/:w\d+:slot-0$/);
    expect(k1).toMatch(/:w\d+:slot-1$/);
  });

  it('`fresh` strategy ignores taskSlot (counter already differentiates)', () => {
    const k0 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'fresh', taskSlot: 0 });
    const k1 = buildCacheKey({ fnSource: FN, contextHash: CTX, strategy: 'fresh', taskSlot: 0 });
    // Counter increments — every fresh call is unique regardless of slot.
    expect(k0).not.toBe(k1);
    // And neither key contains `slot-` because `fresh` skips the
    // suffix (the counter is the differentiator).
    expect(k0).not.toContain('slot-');
    expect(k1).not.toContain('slot-');
  });

  it('forceFresh overrides taskSlot — fresh wins', () => {
    const k0 = buildCacheKey({
      fnSource: FN,
      contextHash: CTX,
      strategy: 'stable',
      taskSlot: 0,
      forceFresh: true,
    });
    const k1 = buildCacheKey({
      fnSource: FN,
      contextHash: CTX,
      strategy: 'stable',
      taskSlot: 0,
      forceFresh: true,
    });
    expect(k0).not.toBe(k1);
    expect(k0).not.toContain('slot-');
  });

  it('non-finite taskSlot is ignored (defensive)', () => {
    const k = buildCacheKey({
      fnSource: FN,
      contextHash: CTX,
      strategy: 'stable',
      taskSlot: NaN,
    });
    expect(k).not.toContain('slot-');
  });

  it('regression: N=4 fan-out produces 4 distinct keys', () => {
    // Simulate exactly what the in-DO topology does: 4 concurrent
    // `runOne` calls with the same fn but slots 0..3.
    const keys = [0, 1, 2, 3].map((i) =>
      buildCacheKey({
        fnSource: FN,
        contextHash: CTX,
        strategy: 'stable',
        taskSlot: i,
      }),
    );
    expect(new Set(keys).size).toBe(4);
    // And every key has the same fn-shape hash so they share the
    // compiled code (just different isolates).
    const hashes = keys.map(extractFnShapeHash);
    expect(new Set(hashes).size).toBe(1);
  });

  it('regression: a second fan-out at the same N=4 reuses the same 4 keys (warm)', () => {
    const first = [0, 1, 2, 3].map((i) =>
      buildCacheKey({
        fnSource: FN,
        contextHash: CTX,
        strategy: 'stable',
        taskSlot: i,
      }),
    );
    const second = [0, 1, 2, 3].map((i) =>
      buildCacheKey({
        fnSource: FN,
        contextHash: CTX,
        strategy: 'stable',
        taskSlot: i,
      }),
    );
    expect(first).toEqual(second);
  });
});
