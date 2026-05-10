import {
  BackpressureError,
  BillingLimitError,
  DisconnectedError,
  ExecutionError,
  OutOfMemoryError,
  SerializationError,
  TimeoutError,
} from '../errors/index.js';

interface ErrorMarshalGlobals {
  cfpCpuMsPattern?: string;
}
const globals = globalThis as unknown as ErrorMarshalGlobals;

/**
 * Map a runtime / RPC error to a typed library error.
 *
 * Heuristic — public docs and workerd source don't expose canonical error
 * shapes. We pattern-match on message/name in this fixed order:
 *
 *   1. Pass-through if `err` is already a typed library error.
 *   2. Backpressure markers (per-isolate cap, owner quota).
 *   3. CPU billing-limit markers (cold-start probe pattern + fallbacks).
 *   4. Subrequest billing-limit markers.
 *   5. OOM markers.
 *   6. Disconnect / eviction markers.
 *   7. Structured-clone / serialization markers.
 *   8. Fallback: wrap as ExecutionError preserving `originalName`.
 *
 * Order matters: a single message can match multiple patterns (e.g.
 * "Worker terminated: out of memory") so we test the more specific
 * marker first. Adding new markers: prepend within the appropriate
 * category to maintain priority. (E5.)
 */
export function marshalError(err: unknown): Error {
  if (err instanceof ExecutionError) return err;
  if (err instanceof BackpressureError) return err;
  if (err instanceof TimeoutError) return err;
  if (err instanceof SerializationError) return err;

  const e = err instanceof Error ? err : new Error(String(err));
  const name = e.name;
  const msg = e.message ?? '';
  const lc = msg.toLowerCase();

  // Per-isolate concurrent-loader cap exceeded (empirical caps verbatim).
  if (msg.includes('Too many concurrent dynamic workers')) {
    return new BackpressureError(msg, 100);
  }
  // Owner-quota / runtime backpressure (best-effort match).
  if (
    lc.includes('owner quota') ||
    lc.includes('rate limit') ||
    lc.includes('overloaded') ||
    lc.includes('too many requests')
  ) {
    return new BackpressureError(msg, 250);
  }
  // CPU-limit detection. The library's cold-start probe (transport/probe)
  // populates `globalThis.cfpCpuMsPattern` at coordinator startup.
  const cpuPattern = globals.cfpCpuMsPattern;
  if (cpuPattern && msg.includes(cpuPattern)) {
    return new BillingLimitError('cpuMs', msg);
  }
  if (
    msg.includes('CPU exceeded') ||
    lc.includes('cpu time') ||
    lc.includes('cpu limit') ||
    lc.includes('exceeded cpu') // workerd variants
  ) {
    return new BillingLimitError('cpuMs', msg);
  }
  if (lc.includes('subrequest')) {
    return new BillingLimitError('subRequests', msg);
  }
  // V8 OOM markers.
  if (
    lc.includes('out of memory') ||
    lc.includes('memory limit exceeded') ||
    lc.includes('heap out of memory')
  ) {
    return new OutOfMemoryError(msg);
  }
  // Disconnections / abort (eviction-mid-flight).
  if (
    name === 'Disconnected' ||
    lc.includes('disconnected') ||
    lc.includes('worker terminated') ||
    lc.includes('isolate is no longer running') ||
    lc.includes('worker reset') // workerd variant
  ) {
    return new DisconnectedError(msg);
  }
  // Structured-clone / serialization failures (E6: also match v8's
  // "could not be serialized" + DataCloneError name).
  if (
    name === 'DataCloneError' ||
    lc.includes('could not be cloned') ||
    lc.includes('could not be serialized') ||
    lc.includes('cannot be cloned') ||
    lc.includes('not serializable')
  ) {
    return new SerializationError(msg);
  }

  // Unknown — preserve as ExecutionError with originalName for debugging.
  return new ExecutionError(msg, {
    remoteStack: e.stack,
    originalName: name === 'Error' ? undefined : name,
  });
}

/** Errors that should trigger an automatic retry (DESIGN §9.2). */
export function isRetryable(err: Error): boolean {
  if (err instanceof BackpressureError) return true;
  if (err instanceof DisconnectedError) return true;
  return false;
}
