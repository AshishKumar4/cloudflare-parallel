import { describe, expect, it } from 'bun:test';
import { rejectIfRpcStub, validateReturn } from '../../src/loader/return-validator';
import { ReturnTooLargeError, SerializationError } from '../../src/errors/index';

describe('validateReturn', () => {
  it('passes small values through', () => {
    expect(validateReturn(42)).toBe(42);
    expect(validateReturn({ a: 1 })).toEqual({ a: 1 });
  });
  it('passes ReadableStream through unchanged', () => {
    const s = new ReadableStream();
    expect(validateReturn(s)).toBe(s);
  });
  it('throws ReturnTooLargeError on > 32 MiB', () => {
    // Build a payload whose serialized size exceeds 32 MiB.
    const big = 'x'.repeat(20 * 1024 * 1024); // 20 MiB string × 2 bytes per char ≈ 40 MiB
    expect(() => validateReturn(big)).toThrow(ReturnTooLargeError);
  });
});

describe('rejectIfRpcStub', () => {
  it('does nothing for plain objects', () => {
    expect(() => rejectIfRpcStub({ x: 1 })).not.toThrow();
  });
  it('rejects RpcStub-like prototypes', () => {
    class RpcStub {}
    expect(() => rejectIfRpcStub(new RpcStub())).toThrow(SerializationError);
  });
  it('rejects RpcTarget-like prototypes', () => {
    class RpcTarget {}
    expect(() => rejectIfRpcStub(new RpcTarget())).toThrow(SerializationError);
  });
});
