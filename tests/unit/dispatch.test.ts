import { describe, expect, it } from 'bun:test';
import { dispatchWithResilience, withRaces } from '../../src/transport/rpc-client';
import {
  BackpressureError,
  CancelledError,
  DeadlineExceededError,
  RetryExhaustedError,
  TimeoutError,
} from '../../src/errors/index';
import { CancelToken } from '../../src/api/cancel';

describe('withRaces', () => {
  it('resolves the task when no race fires', async () => {
    const result = await withRaces(Promise.resolve(42), {});
    expect(result).toBe(42);
  });

  it('throws TimeoutError when timeout fires first', async () => {
    let caught: unknown;
    try {
      await withRaces(new Promise((r) => setTimeout(() => r(1), 50)), { timeout: 10 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
  });

  it('throws CancelledError when cancel fires first', async () => {
    const ct = new CancelToken();
    setTimeout(() => ct.cancel('go'), 5);
    let caught: unknown;
    try {
      await withRaces(
        new Promise(() => {
          /* never */
        }),
        { cancel: ct },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CancelledError);
  });

  it('throws DeadlineExceededError when deadline elapses', async () => {
    let caught: unknown;
    try {
      await withRaces(
        new Promise(() => {
          /* never */
        }),
        { deadlineEpochMs: Date.now() + 10 },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DeadlineExceededError);
  });
});

describe('dispatchWithResilience', () => {
  it('retries BackpressureError', async () => {
    let calls = 0;
    const result = await dispatchWithResilience<number>(
      async () => {
        calls++;
        if (calls < 3) throw new BackpressureError('try again', 1);
        return 7;
      },
      { retries: 3, retryDelay: 1 },
    );
    expect(result).toBe(7);
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await dispatchWithResilience<number>(
        async () => {
          calls++;
          throw new Error('non-retryable');
        },
        { retries: 5 },
      );
    } catch (e) {
      caught = e;
    }
    expect(calls).toBe(1);
    expect(caught).toBeDefined();
  });

  it('throws RetryExhaustedError after exhaustion', async () => {
    let caught: unknown;
    try {
      await dispatchWithResilience<number>(
        async () => {
          throw new BackpressureError('persistent');
        },
        { retries: 2, retryDelay: 1 },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as RetryExhaustedError).attempts).toBe(3);
  });
});
