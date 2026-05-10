import { ReturnTooLargeError, SerializationError } from '../errors/index';

/**
 * Soft threshold: above this we should auto-stream when possible (the
 * coordinator-side stream re-encoder is wired in `transport/`). Today
 * the size estimate is conservative; we let the runtime's structured-clone
 * serializer be the authoritative size enforcer.
 */
export const SOFT_STREAM_THRESHOLD_BYTES = 16 * 1024 * 1024;
const HARD_RPC_PAYLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Estimate structured-clone size for a return value. Cheap and conservative —
 * we just want to catch the obvious >16 MiB / >32 MiB cases. The runtime's
 * real structured-clone serializer is the authoritative size enforcer.
 */
function estimateBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (value === null || value === undefined) return 4;
  const t = typeof value;
  if (t === 'boolean') return 4;
  if (t === 'number') return 8;
  if (t === 'bigint') return 16;
  if (t === 'string') return 2 + (value as string).length * 2;
  if (t === 'symbol' || t === 'function') return 0; // not cloneable; caller's problem
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Date) return 16;
  if (value instanceof RegExp) return 32;
  if (value instanceof Map) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let total = 32;
    for (const [k, v] of value as Map<unknown, unknown>)
      total += estimateBytes(k, seen) + estimateBytes(v, seen);
    return total;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let total = 32;
    for (const v of value as Set<unknown>) total += estimateBytes(v, seen);
    return total;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return 0;
    seen.add(value);
    let total = 16;
    for (const v of value) total += estimateBytes(v, seen);
    return total;
  }
  if (t === 'object') {
    if (seen.has(value as object)) return 0;
    seen.add(value as object);
    let total = 16;
    for (const k of Object.keys(value as object)) {
      total += k.length * 2 + estimateBytes((value as Record<string, unknown>)[k], seen);
    }
    return total;
  }
  return 0;
}

/**
 * Coordinator-side return validation.
 *
 * - >32 MiB structured-clone size (and not already a stream) → ReturnTooLargeError
 * - 16..32 MiB → caller is expected to have wrapped in a ReadableStream;
 *   we let it pass and rely on the RPC layer for the hard 32 MiB enforcement
 *   (the runtime will throw on the wire if it actually exceeds).
 * - RPC-stub-shaped values are rejected at codegen-side (loader/codegen.ts).
 */
export function validateReturn<T>(value: T): T {
  if (value instanceof ReadableStream) return value;
  const bytes = estimateBytes(value);
  if (bytes > HARD_RPC_PAYLOAD_BYTES) {
    throw new ReturnTooLargeError(bytes);
  }
  return value;
}

/**
 * Heuristic detector for RPC stubs leaking out of a generated worker.
 * The codegen-side validator catches these at the dynamic-worker boundary;
 * this is a defense-in-depth check on the coordinator side.
 */
export function rejectIfRpcStub(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  const proto = Object.getPrototypeOf(value);
  const ctorName = proto?.constructor?.name;
  if (ctorName === 'RpcStub' || ctorName === 'RpcTarget' || ctorName === 'RpcPromise') {
    throw new SerializationError('returned values cannot include RPC stubs');
  }
}
