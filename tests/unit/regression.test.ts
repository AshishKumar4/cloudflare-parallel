/**
 * Regression tests for v0.2 → v0.3 review-discovered bugs.
 * These pin behaviors the code-reviewer flagged as broken; they exist
 * specifically so a future change can't silently re-break them.
 */

import { describe, expect, it } from 'bun:test';
import { generateWorkerSource } from '../../src/loader/codegen';
import { canonicalizeContext, assertValidContextKey } from '../../src/loader/serialize';
import { poolFake, actorFake } from '../../src/api/testing';
import { SerializationError } from '../../src/errors/index';

describe('context-key injection guard', () => {
  it('rejects keys with semicolons', () => {
    expect(() => assertValidContextKey('x;process.exit(1);y')).toThrow(SerializationError);
  });
  it('rejects reserved words', () => {
    expect(() => assertValidContextKey('return')).toThrow(SerializationError);
    expect(() => assertValidContextKey('class')).toThrow(SerializationError);
  });
  it('rejects Cfp-prefixed keys (library-reserved)', () => {
    expect(() => assertValidContextKey('CfpSignalHost')).toThrow(SerializationError);
    expect(() => assertValidContextKey('cfpSignalHost')).toThrow(SerializationError);
  });
  it('rejects keys with operators', () => {
    expect(() => assertValidContextKey('x = 1; const y')).toThrow(SerializationError);
  });
  it('accepts plain identifiers', () => {
    expect(() => assertValidContextKey('multiplier')).not.toThrow();
    expect(() => assertValidContextKey('_$abc123')).not.toThrow();
  });
  it('canonicalizeContext rejects malicious keys', () => {
    expect(() => canonicalizeContext({ 'x;evil(): 1; y': 1 })).toThrow(SerializationError);
  });
  it('codegen rejects malicious context keys', () => {
    expect(() =>
      generateWorkerSource('(x) => x', {
        mode: 'pool-fn',
        context: { 'x; globalThis.fetch = stolen': 1 },
        injectCancelSignal: false,
        passEnv: false,
        sealGlobals: false,
      }),
    ).toThrow(SerializationError);
  });
});

describe('env always passed when cancel-signal injected', () => {
  it('codegen passes env even with empty bindings', () => {
    const src = generateWorkerSource('(x) => x', {
      mode: 'pool-fn',
      injectCancelSignal: true,
      passEnv: false, // even with passEnv: false, env must be present so env.signal works
      sealGlobals: false,
    });
    expect(src).toContain('__fn__(...args, __env__)');
    expect(src).toContain('__signal__');
  });
});

describe('PoolStats fields wired on the poolFake surface', () => {
  it('uniqueFnShapesToday counts distinct fn shapes', async () => {
    const fake = poolFake();
    await fake.submit((x: number) => x + 1, 1);
    await fake.submit((x: number) => x * 2, 1); // distinct shape
    await fake.submit((x: number) => x + 1, 1); // same as first
    const s = await fake.stats();
    expect(s.uniqueFnShapesToday).toBe(2);
  });
});

describe('Actor mode persists state across submits', () => {
  it('actorFake roundtrips state across submits', async () => {
    const actor = actorFake<{ count: number }, Record<string, unknown>>({
      id: 'a',
      initialState: { count: 0 },
    });
    await actor.submit((state) => {
      state.count = 1;
    });
    await actor.submit((state) => {
      state.count++;
    });
    const final = await actor.submit((state) => state.count);
    expect(final).toBe(2);
  });

  it('codegen actor-class mode bakes the fn into the module body (the runtime has no eval)', () => {
    const src = generateWorkerSource('(state, sql, n) => state.x + n', {
      mode: 'actor-class',
      injectCancelSignal: true,
      passEnv: true,
      sealGlobals: false,
    });
    expect(src).toContain('async submit(envelope, _fnSource, state, args)');
    expect(src).toContain('const __fn__ = (state, sql, n) => state.x + n');
    expect(src).toContain('return { state, value:');
    expect(src).toContain('__fn__(state, sql, ...args, __env__)');
  });
});

describe('env.signal is a real AbortSignal driven by RPC stream', () => {
  // Pin the v0.3 final contract: `env.signal` is a Web-platform `AbortSignal`,
  // tripped by reading the first chunk from `env.cancelStream`. Live cancel
  // works today; the v0.2 snapshot-only model is replaced.
  it('codegen emits a real AbortController + reads cancelStream', () => {
    const src = generateWorkerSource('(x) => x', {
      mode: 'pool-fn',
      injectCancelSignal: true,
      passEnv: true,
      sealGlobals: false,
    });
    // The new helper builds a real AbortController.
    expect(src).toContain('cfpMakeAbortSignal');
    expect(src).toContain('new AbortController()');
    expect(src).toContain('controller.abort');
    expect(src).toContain('return controller.signal');
    // Reads cancelStream: getReader() + first-chunk-fires-abort.
    expect(src).toContain('cancelStream.getReader()');
    expect(src).toContain('reader.read()');
    // env.signal is the AbortController.signal (not a custom poll() shape).
    expect(src).not.toContain('poll: () =>');
  });
});
