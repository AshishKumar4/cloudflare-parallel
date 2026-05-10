import { describe, expect, it } from 'bun:test';
import { canonicalizeContext, hashSource, serializeFunction } from '../../src/loader/serialize';
import { SerializationError } from '../../src/errors/index';
import type { UserFn } from '../../src/api/user-fn';

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

  // ---- bundler-shim stripping ------------------------------------------
  // esbuild (the default Wrangler bundler) wraps named function values with
  // `__name(fn, "literal")` to preserve `Function.prototype.name`. The
  // wrapper is not defined in the loaded isolate, so calling
  // `Function.prototype.toString()` on a bundled fn ships dead references.
  // serializeFunction strips the wrappers at serialize time.
  //
  // We test the stripping by passing a fn whose source string already
  // contains the wrappers — bun-test runs unbundled, so we construct a
  // fn whose `.toString()` returns the wrapped form by overriding it.
  describe('bundler-shim stripping', () => {
    function fnWithSource(sourceText: string): UserFn {
      // Construct a real callable; override .toString() to return the
      // bundled-looking source text.
      const real = (x: unknown) => x;
      Object.defineProperty(real, 'toString', {
        value: () => sourceText,
        enumerable: false,
      });
      return real as UserFn;
    }

    it('strips a single __name(arrow, "name") wrapper', () => {
      const fn = fnWithSource('__name((x) => x * 2, "double")');
      const stripped = serializeFunction(fn);
      expect(stripped).not.toContain('__name(');
      expect(stripped).toContain('=>');
      expect(stripped).toContain('x * 2');
    });

    it('strips __name with single-quoted name', () => {
      const fn = fnWithSource("__name(function (n) { return n; }, 'single')");
      const stripped = serializeFunction(fn);
      expect(stripped).not.toContain('__name(');
    });

    it('strips multiple __name calls in one source', () => {
      const fn = fnWithSource(
        'function outer() {\n' +
          '  const inner = __name((x) => x + 1, "inner");\n' +
          '  const other = __name(function double(y) { return y * 2; }, "double");\n' +
          '  return [inner, other];\n' +
          '}',
      );
      const stripped = serializeFunction(fn);
      expect(stripped).not.toContain('__name(');
      expect(stripped).toContain('x + 1');
      expect(stripped).toContain('y * 2');
    });

    it('strips __publicField shim into property assignment', () => {
      const fn = fnWithSource(
        'function () {\n' +
          '  var obj = {};\n' +
          '  __publicField(obj, "k", 42);\n' +
          '  return obj;\n' +
          '}',
      );
      const stripped = serializeFunction(fn);
      expect(stripped).not.toContain('__publicField(');
      expect(stripped).toContain('"k"');
      expect(stripped).toContain('42');
    });

    it('preserves source that has no shims', () => {
      const fn = fnWithSource('(x) => x * 2');
      const stripped = serializeFunction(fn);
      expect(stripped).toBe('(x) => x * 2');
    });
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
