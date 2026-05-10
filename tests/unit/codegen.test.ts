import { describe, expect, it } from 'bun:test';
import {
  buildWorkerCode,
  generateWorkerSource,
  DEFAULT_COMPAT_DATE,
} from '../../src/loader/codegen';

describe('generateWorkerSource', () => {
  it('emits a pool-fn module with execute() that injects env.signal', () => {
    const src = generateWorkerSource('(x) => x * 2', {
      mode: 'pool-fn',
      injectCancelSignal: true,
      passEnv: true,
      sealGlobals: false,
    });
    expect(src).toContain('import { WorkerEntrypoint } from "cloudflare:workers"');
    expect(src).toContain('export default class extends WorkerEntrypoint');
    expect(src).toContain('async execute(envelope, ...args)');
    expect(src).toContain('cfpMakeAbortSignal');
    expect(src).toContain('Object.assign({}, this.env, { signal: __signal__ })');
  });

  it('omits signal injection when injectCancelSignal=false', () => {
    const src = generateWorkerSource('(x) => x', {
      mode: 'pool-fn',
      injectCancelSignal: false,
      passEnv: false,
      sealGlobals: false,
    });
    expect(src).not.toContain('cfpMakeAbortSignal');
    // env is always passed as the trailing arg so user fns reading
    // `env.signal` never NPE on cancel-fast paths.
    expect(src).toContain('__fn__(...args, __env__)');
  });

  it('seals caches.default when sealGlobals=true', () => {
    const src = generateWorkerSource('(x) => x', {
      mode: 'pool-fn',
      injectCancelSignal: false,
      passEnv: false,
      sealGlobals: true,
    });
    expect(src).toContain('seal(caches, "default"');
  });

  it('embeds context as canonicalized const declarations', () => {
    const src = generateWorkerSource('(x) => x', {
      mode: 'pool-fn',
      context: { multiplier: 3, prefix: 'r' },
      injectCancelSignal: false,
      passEnv: false,
      sealGlobals: false,
    });
    expect(src).toContain('const multiplier = 3');
    expect(src).toContain('const prefix = "r"');
  });

  it('emits actor-class shape when mode=actor-class with fnSource baked in', () => {
    const src = generateWorkerSource('(s) => s', {
      mode: 'actor-class',
      injectCancelSignal: true,
      passEnv: true,
      sealGlobals: false,
    });
    expect(src).toContain('async submit(envelope, _fnSource, state, args)');
    expect(src).toContain('const __fn__ = (s) => s');
    expect(src).toContain('return { state, value:');
  });

  it('rejects RPC stubs in returns', () => {
    const src = generateWorkerSource('(x) => x', {
      mode: 'pool-fn',
      injectCancelSignal: false,
      passEnv: false,
      sealGlobals: false,
    });
    expect(src).toContain('cfpValidateReturn');
    expect(src).toContain('returned values cannot include RPC stubs');
  });
});

describe('buildWorkerCode', () => {
  it('uses the v0.3 default compatibility date', () => {
    const code = buildWorkerCode({
      fnSource: '(x) => x',
      source: { mode: 'pool-fn', injectCancelSignal: false, passEnv: false, sealGlobals: false },
    });
    expect(code.compatibilityDate).toBe(DEFAULT_COMPAT_DATE);
    expect(DEFAULT_COMPAT_DATE).toBe('2026-01-20');
  });

  it('defaults globalOutbound: null when worker is undefined', () => {
    const code = buildWorkerCode({
      fnSource: '(x) => x',
      source: { mode: 'pool-fn', injectCancelSignal: false, passEnv: false, sealGlobals: false },
    });
    expect(code.globalOutbound).toBeNull();
  });

  it('respects explicit globalOutbound: undefined for "inherit"', () => {
    const code = buildWorkerCode({
      fnSource: '(x) => x',
      source: { mode: 'pool-fn', injectCancelSignal: false, passEnv: false, sealGlobals: false },
      worker: { globalOutbound: undefined },
    });
    expect('globalOutbound' in code).toBe(false);
  });
});
