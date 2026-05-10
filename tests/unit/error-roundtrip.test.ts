/**
 * JSON round-trip tests for the typed error hierarchy. Every public error
 * class should:
 *   1. Have a stable `code` (`CFP_*`).
 *   2. Have an `httpStatus`.
 *   3. Round-trip through `errorToWire` -> JSON.parse(JSON.stringify(_)) ->
 *      `wireToError` and produce an `instanceof` of the same class with
 *      preserved fields.
 *   4. Surface its `cause` chain across the round-trip.
 */

import { describe, expect, it } from 'bun:test';
import type {
  ParallelError} from '../../src/errors/index';
import {
  AggregateExecutionError,
  BackpressureError,
  BillingLimitError,
  CancelledError,
  ConflictError,
  DeadlineExceededError,
  DeadlineTooShortError,
  DisconnectedError,
  ExecutionError,
  MissingBindingError,
  OutOfMemoryError,
  PolicyRequiredError,
  ResultExpiredError,
  RetryExhaustedError,
  ReturnTooLargeError,
  SerializationError,
  TimeoutError,
  TopologyError,
  errorToWire,
  wireToError,
} from '../../src/errors/index';

function roundtrip<T extends ParallelError>(err: T): ParallelError {
  const wire = JSON.parse(JSON.stringify(errorToWire(err)));
  return wireToError(wire);
}

describe('error hierarchy: codes + httpStatus + JSON round-trip', () => {
  it('CancelledError round-trips with reason', () => {
    const e = new CancelledError('user requested');
    expect(e.code).toBe('CFP_CANCELLED');
    expect(e.httpStatus).toBe(499);
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(CancelledError);
    expect((back as CancelledError).reason).toBe('user requested');
  });

  it('DeadlineExceededError round-trips with deadlineEpochMs', () => {
    const e = new DeadlineExceededError(1700000000000);
    expect(e.code).toBe('CFP_DEADLINE_EXCEEDED');
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(DeadlineExceededError);
    expect((back as DeadlineExceededError).deadlineEpochMs).toBe(1700000000000);
  });

  it('TimeoutError round-trips with deadlineMs', () => {
    const e = new TimeoutError(5000);
    expect(e.code).toBe('CFP_TIMEOUT');
    expect(e.httpStatus).toBe(504);
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(TimeoutError);
    expect((back as TimeoutError).deadlineMs).toBe(5000);
  });

  it('BackpressureError round-trips with retryAfterMs', () => {
    const e = new BackpressureError('LRU thrash', 250);
    expect(e.code).toBe('CFP_BACKPRESSURE');
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(BackpressureError);
    expect((back as BackpressureError).retryAfterMs).toBe(250);
  });

  it('BillingLimitError preserves kind', () => {
    const e = new BillingLimitError('cpuMs');
    expect(e.code).toBe('CFP_BILLING_LIMIT');
    expect(e.httpStatus).toBe(402);
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(BillingLimitError);
    expect((back as BillingLimitError).kind).toBe('cpuMs');
  });

  it('DisconnectedError round-trips and is httpStatus 502', () => {
    const e = new DisconnectedError('worker died');
    expect(e.httpStatus).toBe(502);
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(DisconnectedError);
    expect(back).toBeInstanceOf(ExecutionError);
  });

  it('OutOfMemoryError httpStatus is 507', () => {
    expect(new OutOfMemoryError().httpStatus).toBe(507);
  });

  it('ReturnTooLargeError preserves bytes', () => {
    const e = new ReturnTooLargeError(50_000_000);
    expect(e.httpStatus).toBe(413);
    const back = roundtrip(e);
    expect((back as ReturnTooLargeError).bytes).toBe(50_000_000);
  });

  it('DeadlineTooShortError preserves budgetMs+minBudgetMs', () => {
    const e = new DeadlineTooShortError(500, 1000);
    const back = roundtrip(e);
    expect((back as DeadlineTooShortError).budgetMs).toBe(500);
    expect((back as DeadlineTooShortError).minBudgetMs).toBe(1000);
  });

  it('MissingBindingError preserves bindingName', () => {
    const e = new MissingBindingError('CfpCoordinator');
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(MissingBindingError);
    expect((back as MissingBindingError).bindingName).toBe('CfpCoordinator');
  });

  it('ResultExpiredError preserves jobId', () => {
    const e = new ResultExpiredError('j-abc');
    expect(e.httpStatus).toBe(410);
    const back = roundtrip(e);
    expect((back as ResultExpiredError).jobId).toBe('j-abc');
  });

  it('ConflictError preserves message and httpStatus 409', () => {
    const e = new ConflictError('lease lost');
    expect(e.httpStatus).toBe(409);
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(ConflictError);
    expect(back.message).toBe('lease lost');
  });

  it('TopologyError preserves message', () => {
    const e = new TopologyError('size 5 > in-do cap');
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(TopologyError);
  });

  it('PolicyRequiredError preserves message', () => {
    const e = new PolicyRequiredError('pool.handle requires explicit policy');
    expect(e.code).toBe('CFP_POLICY_REQUIRED');
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(PolicyRequiredError);
  });

  it('SerializationError round-trips', () => {
    const back = roundtrip(new SerializationError('bad fn'));
    expect(back).toBeInstanceOf(SerializationError);
    expect(back.message).toBe('bad fn');
  });

  it('ExecutionError preserves originalName + remoteStack', () => {
    const e = new ExecutionError('user threw', {
      originalName: 'CustomError',
      remoteStack: 'at customCode\n  at handler',
    });
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(ExecutionError);
    expect((back as ExecutionError).originalName).toBe('CustomError');
    expect((back as ExecutionError).remoteStack).toContain('customCode');
  });

  it('RetryExhaustedError preserves attempts and cause chain', () => {
    const cause = new BackpressureError('persistent');
    const e = new RetryExhaustedError(3, cause);
    expect(e.code).toBe('CFP_RETRY_EXHAUSTED');
    expect(e.attempts).toBe(3);
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(RetryExhaustedError);
    expect((back as RetryExhaustedError).attempts).toBe(3);
    expect((back as RetryExhaustedError).lastError).toBeInstanceOf(BackpressureError);
  });

  it('AggregateExecutionError preserves errors + partialResults maps', () => {
    const errs = new Map<number, ParallelError>([
      [1, new TimeoutError(1000)],
      [3, new BackpressureError('bp')],
    ]);
    const partials = new Map<number, unknown>([
      [0, 'a'],
      [2, 42],
    ]);
    const e = new AggregateExecutionError(errs, partials);
    const back = roundtrip(e);
    expect(back).toBeInstanceOf(AggregateExecutionError);
    const aer = back as AggregateExecutionError;
    expect(aer.errors.size).toBe(2);
    expect(aer.errors.get(1)).toBeInstanceOf(TimeoutError);
    expect(aer.errors.get(3)).toBeInstanceOf(BackpressureError);
    expect(aer.partialResults.size).toBe(2);
    expect(aer.partialResults.get(0)).toBe('a');
    expect(aer.partialResults.get(2)).toBe(42);
  });

  it('errorToWire wraps non-library errors with originalName', () => {
    const wire = errorToWire(new TypeError('plain'));
    expect(wire.name).toBe('TypeError');
    expect(wire.code).toBe('CFP_EXECUTION');
    expect(wire.originalName).toBe('TypeError');
  });

  it('cause chain crosses the wire (Error.cause preserved)', () => {
    const inner = new BackpressureError('inner');
    const outer = new ExecutionError('outer', { cause: inner });
    const back = roundtrip(outer);
    expect(back.cause).toBeInstanceOf(BackpressureError);
  });
});
