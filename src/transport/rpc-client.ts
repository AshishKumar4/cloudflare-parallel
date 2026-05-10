import {
  BackpressureError,
  CancelledError,
  DeadlineExceededError,
  RetryExhaustedError,
  TimeoutError,
} from '../errors/index';
import type { CancelToken } from '../api/cancel';
import { isRetryable, marshalError } from './error-marshal';

export interface DispatchOptions {
  /** Wall-clock timeout in ms (relative). Independent of deadline. */
  timeout?: number;
  /** Retry attempts after the initial failure. */
  retries?: number;
  /** Base retry backoff in ms. Exponential with jitter. */
  retryDelay?: number;
  /** Cancel token; when signalled, dispatch resolves CancelledError immediately. */
  cancel?: CancelToken;
  /** Deadline as absolute ms-since-epoch. */
  deadlineEpochMs?: number;
  /** Observability hook fired on each retry attempt. */
  onRetry?: (e: { attempt: number; error: Error; delayMs: number }) => void;
}

/**
 * Race a task against timeout + cancel + deadline. Coordinator-side primitive
 * (DESIGN §9.3a). Permit release is the caller's responsibility — this fn
 * does not know about loader semaphores; see loader/loader-budget.ts.
 */
export async function withRaces<T>(task: Promise<T>, opts: DispatchOptions): Promise<T> {
  const racers: Array<Promise<T | never>> = [task];
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;

  if (opts.timeout && opts.timeout > 0) {
    racers.push(
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new TimeoutError(opts.timeout!)), opts.timeout);
      }),
    );
  }
  if (opts.deadlineEpochMs && opts.deadlineEpochMs > 0) {
    const remaining = opts.deadlineEpochMs - Date.now();
    if (remaining <= 0) {
      throw new DeadlineExceededError(opts.deadlineEpochMs);
    }
    racers.push(
      new Promise<never>((_, reject) => {
        deadlineHandle = setTimeout(
          () => reject(new DeadlineExceededError(opts.deadlineEpochMs!)),
          remaining,
        );
      }),
    );
  }
  if (opts.cancel) {
    racers.push(opts.cancel.cancelled);
  }

  try {
    return await Promise.race(racers);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (deadlineHandle) clearTimeout(deadlineHandle);
  }
}

/**
 * Dispatch with timeout/cancel/deadline race + retry policy.
 *
 * On retryable error (Disconnected / Backpressure), retries with jittered
 * exponential backoff up to `retries`. After exhaustion, throws the last
 * error wrapped in `RetryExhaustedError` only when `retries > 0`; otherwise
 * the raw last error.
 */
export async function dispatchWithResilience<T>(
  taskFactory: () => Promise<T>,
  opts: DispatchOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 0;
  const baseDelay = opts.retryDelay ?? 100;
  const maxAttempts = 1 + retries;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.cancel?.isCancelled) {
      throw new CancelledError(opts.cancel.poll().reason);
    }
    try {
      return await withRaces(taskFactory(), opts);
    } catch (rawErr: unknown) {
      const err = marshalError(rawErr);
      lastError = err;

      // Don't retry deadline / cancel / non-retryable errors.
      if (
        err instanceof DeadlineExceededError ||
        err instanceof CancelledError ||
        !isRetryable(err)
      ) {
        throw err;
      }
      if (attempt < maxAttempts - 1) {
        const factor = err instanceof BackpressureError ? 1.5 : 2;
        const jitter = 0.5 + Math.random();
        const delay = Math.min(baseDelay * Math.pow(factor, attempt) * jitter, 5_000);
        opts.onRetry?.({ attempt: attempt + 1, error: err, delayMs: delay });
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }

  if (maxAttempts > 1) {
    throw new RetryExhaustedError(maxAttempts, lastError!);
  }
  throw lastError!;
}
