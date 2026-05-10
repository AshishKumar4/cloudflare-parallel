/**
 * Tests for the error type-guard helpers. Guards must:
 *   1. narrow correctly for the canonical class instances.
 *   2. work on cross-RPC-boundary errors that have lost their prototype
 *      (we fall back to checking `code === 'CFP_*'`).
 *   3. not match plain Errors / random objects.
 */
import { describe, expect, test } from 'bun:test';
import {
  BackpressureError,
  CancelledError,
  DeadlineExceededError,
  ExecutionError,
  TimeoutError,
  AggregateExecutionError,
  isAggregateExecutionError,
  isBackpressureError,
  isCancelledError,
  isDeadlineExceededError,
  isExecutionError,
  isParallelError,
  isTimeoutError,
} from '../../src/errors/index';
import type { ParallelError } from '../../src/errors/index';

describe('error type guards', () => {
  test('isParallelError matches class instances and CFP_* codes', () => {
    expect(isParallelError(new BackpressureError('p'))).toBe(true);
    expect(isParallelError({ code: 'CFP_EXECUTION', message: 'm' })).toBe(true);
    expect(isParallelError(new Error('plain'))).toBe(false);
    expect(isParallelError(null)).toBe(false);
    expect(isParallelError({})).toBe(false);
    expect(isParallelError({ code: 'OTHER_LIB_ERROR' })).toBe(false);
  });

  test('isBackpressureError narrows correctly', () => {
    const err = new BackpressureError('busy', 250);
    expect(isBackpressureError(err)).toBe(true);
    if (isBackpressureError(err)) {
      // Type narrowing should make .retryAfterMs accessible.
      expect(err.retryAfterMs).toBe(250);
    }
    // Wire-shape match.
    expect(isBackpressureError({ code: 'CFP_BACKPRESSURE', message: 'x' })).toBe(true);
    expect(isBackpressureError(new Error('plain'))).toBe(false);
  });

  test('isCancelledError matches both class and wire shape', () => {
    expect(isCancelledError(new CancelledError('user-stop'))).toBe(true);
    expect(isCancelledError({ code: 'CFP_CANCELLED', message: 'cancelled' })).toBe(true);
    expect(isCancelledError(new TimeoutError(5000))).toBe(false);
  });

  test('isExecutionError covers class hierarchy + Disconnected/OOM/Billing', async () => {
    const { DisconnectedError, OutOfMemoryError, BillingLimitError } = await import(
      '../../src/errors/index.js'
    );
    expect(isExecutionError(new ExecutionError('m'))).toBe(true);
    expect(isExecutionError(new DisconnectedError())).toBe(true);
    expect(isExecutionError(new OutOfMemoryError())).toBe(true);
    expect(isExecutionError(
      new BillingLimitError({ kind: 'cpuMs', limit: 30_000 }),
    )).toBe(true);
    expect(isExecutionError({ code: 'CFP_DISCONNECTED', message: 'm' })).toBe(true);
    expect(isExecutionError({ code: 'CFP_BACKPRESSURE', message: 'm' })).toBe(false);
  });

  test('isAggregateExecutionError', () => {
    const err = new AggregateExecutionError(
      new Map([[0, new ExecutionError('a')]]),
      new Map([[1, 'partial']]),
    );
    expect(isAggregateExecutionError(err)).toBe(true);
    if (isAggregateExecutionError(err)) {
      // narrow gives us .errors map
      expect(err.errors.size).toBe(1);
    }
    expect(isAggregateExecutionError(new ExecutionError('m'))).toBe(false);
  });

  test('isDeadlineExceededError vs isTimeoutError are distinct', () => {
    const t = new TimeoutError(5000);
    const d = new DeadlineExceededError(Date.now() + 1000);
    expect(isTimeoutError(t)).toBe(true);
    expect(isDeadlineExceededError(d)).toBe(true);
    expect(isTimeoutError(d)).toBe(false);
    expect(isDeadlineExceededError(t)).toBe(false);
  });

  test('guards work after instanceof is broken (RPC boundary simulation)', () => {
    // Simulate an error that has lost its prototype across RPC.
    const wireShape: Partial<ParallelError> = {
      name: 'BackpressureError',
      code: 'CFP_BACKPRESSURE',
      message: 'lru-thrash',
      httpStatus: 503,
    };
    expect(wireShape instanceof BackpressureError).toBe(false); // prototype lost
    expect(isBackpressureError(wireShape)).toBe(true); // but still detected
  });
});
