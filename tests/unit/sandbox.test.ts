import { describe, expect, it } from 'bun:test';
import {
  assertNoLibraryInternalBindings,
  sanitizeBindings,
  LIBRARY_INTERNAL_BINDINGS,
} from '../../src/loader/sandbox';
import { BindingError } from '../../src/errors/index';

describe('library-internal-binding blocklist', () => {
  it('rejects CfpCoordinator', () => {
    expect(() => assertNoLibraryInternalBindings({ CfpCoordinator: {} })).toThrow(BindingError);
  });
  it('rejects CfpSchedulerDO', () => {
    expect(() => assertNoLibraryInternalBindings({ CfpSchedulerDO: {} })).toThrow(BindingError);
  });
  it('passes user bindings through', () => {
    expect(() => assertNoLibraryInternalBindings({ AI: {}, KV: {} })).not.toThrow();
  });
  it('exports a frozen-ish set of internal names', () => {
    expect(LIBRARY_INTERNAL_BINDINGS.has('CfpCoordinator')).toBe(true);
    expect(LIBRARY_INTERNAL_BINDINGS.has('CfpWorkerDO')).toBe(true);
    expect(LIBRARY_INTERNAL_BINDINGS.has('CfpSubCoord')).toBe(true);
    expect(LIBRARY_INTERNAL_BINDINGS.has('CfpSchedulerDO')).toBe(true);
  });
});

describe('sanitizeBindings', () => {
  it('drops library-internal bindings', () => {
    const out = sanitizeBindings({ AI: 'a', CfpCoordinator: 'x', KV: 'k' });
    expect(out).toEqual({ AI: 'a', KV: 'k' });
  });
  it('respects allowList', () => {
    const out = sanitizeBindings({ AI: 'a', KV: 'k' }, ['KV']);
    expect(out).toEqual({ KV: 'k' });
  });
  it('returns {} for undefined input', () => {
    expect(sanitizeBindings(undefined)).toEqual({});
  });
  it('drops the cfpSql shadow key', () => {
    expect(sanitizeBindings({ AI: 'a', cfpSql: 'shadow' })).toEqual({ AI: 'a' });
  });
});
