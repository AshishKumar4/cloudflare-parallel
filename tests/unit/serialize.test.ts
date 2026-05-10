import { describe, expect, it } from 'bun:test';
import { canonicalizeContext, hashSource, serializeFunction } from '../../src/loader/serialize.js';
import { SerializationError } from '../../src/errors/index.js';

describe('serializeFunction', () => {
  it('serializes arrow functions', () => {
    const src = serializeFunction((x: number) => x * 2);
    expect(src).toContain('=>');
  });

  it('serializes named function expressions', () => {
    function add(a: number, b: number): number {
      return a + b;
    }
    expect(serializeFunction(add)).toContain('a + b');
  });

  it('serializes async functions', () => {
    const src = serializeFunction(async (n: number) => n);
    expect(src).toContain('async');
  });

  it('rejects native functions', () => {
    expect(() => serializeFunction(Array.prototype.map)).toThrow(SerializationError);
  });

  it('rejects functions referencing `this`', () => {
    const fn = function () {
      return (this as { x: number }).x;
    };
    expect(() => serializeFunction(fn)).toThrow(SerializationError);
  });

  it('rejects functions with shorthand-method `this`', () => {
    const obj = {
      fn() {
        return (this as { y: number }).y;
      },
    };
    expect(() => serializeFunction(obj.fn)).toThrow(SerializationError);
  });
});

describe('hashSource', () => {
  it('is deterministic', () => {
    const a = hashSource('hello world');
    const b = hashSource('hello world');
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    expect(hashSource('a')).not.toBe(hashSource('b'));
  });

  it('returns a base-36 string', () => {
    expect(hashSource('test')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('canonicalizeContext', () => {
  it('sorts keys', () => {
    const a = canonicalizeContext({ b: 1, a: 2 });
    const b = canonicalizeContext({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('rejects Map', () => {
    expect(() => canonicalizeContext({ m: new Map() })).toThrow(SerializationError);
  });

  it('rejects Set', () => {
    expect(() => canonicalizeContext({ s: new Set() })).toThrow(SerializationError);
  });

  it('rejects Date', () => {
    expect(() => canonicalizeContext({ d: new Date() })).toThrow(SerializationError);
  });

  it('rejects RegExp', () => {
    expect(() => canonicalizeContext({ r: /x/ })).toThrow(SerializationError);
  });

  it('rejects circular structures', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalizeContext({ x: obj })).toThrow(SerializationError);
  });

  it('rejects functions', () => {
    expect(() => canonicalizeContext({ f: () => 1 })).toThrow(SerializationError);
  });

  it('handles nested objects deterministically', () => {
    const a = canonicalizeContext({ outer: { z: 1, a: 2 } });
    const b = canonicalizeContext({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('handles arrays', () => {
    expect(canonicalizeContext({ a: [1, 2, 3] })).toBe('{"a":[1,2,3]}');
  });
});
