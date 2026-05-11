import {
  BackpressureError,
  BillingLimitError,
  CancelledError,
  ConflictError,
  DeadlineExceededError,
  DisconnectedError,
  ExecutionError,
  type ParallelError,
  OutOfMemoryError,
  ResultExpiredError,
  ReturnTooLargeError,
  SerializationError,
  TimeoutError,
  TopologyError,
} from '../errors/index';

/**
 * Reconstruct a typed library error from the leaf-RPC wire shape
 * carried in `RunOneResult.error`. Distinct from `errors.wireToError`
 * (which is the full typed-error round-trip including `code`,
 * `httpStatus`, `extra`, `cause`); this is the small per-leaf failure
 * envelope (`{name, message, stack, originalName}`) used by the
 * coordinator ↔ leaf-DO RPC. Maps by class name.
 *
 * **Lossy reconstruction.** The leaf-RPC envelope drops structured
 * fields (`DeadlineExceededError.deadlineEpochMs`, `BillingLimitError.kind`,
 * `ReturnTooLargeError.bytes`, etc), so this helper rebuilds them
 * with sentinel values (`0` / `''` / `'cpuMs'`). Callers needing the
 * full structured payload should consume `WireError` via
 * `errors.wireToError`. For most user code the name + message are
 * enough for `instanceof` narrowing and presentation.
 */
export function leafErrorToTypedError(wire: {
  name: string;
  message: string;
  stack?: string;
  originalName?: string;
}): ParallelError {
  switch (wire.name) {
    case 'CancelledError':
      return new CancelledError(wire.message);
    case 'DeadlineExceededError':
      return new DeadlineExceededError(0);
    case 'TimeoutError':
      return new TimeoutError(0);
    case 'BackpressureError':
      return new BackpressureError(wire.message);
    case 'DisconnectedError':
      return new DisconnectedError(wire.message);
    case 'OutOfMemoryError':
      return new OutOfMemoryError(wire.message);
    case 'BillingLimitError':
      return new BillingLimitError('cpuMs', wire.message);
    case 'ReturnTooLargeError':
      return new ReturnTooLargeError(0);
    case 'SerializationError':
      return new SerializationError(wire.message);
    case 'ResultExpiredError':
      return new ResultExpiredError('');
    case 'ConflictError':
      return new ConflictError(wire.message);
    case 'TopologyError':
      return new TopologyError(wire.message);
    case 'ExecutionError':
    default:
      return new ExecutionError(wire.message, {
        remoteStack: wire.stack,
        originalName: wire.originalName ?? wire.name,
      });
  }
}
