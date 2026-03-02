/**
 * Structured error types for cloudflare-parallel.
 */

/** Base error for all library errors. */
export class ParallelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParallelError';
  }
}

/** Thrown when a function cannot be serialized for remote execution. */
export class SerializationError extends ParallelError {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/**
 * Thrown when the remote isolate fails to execute the task.
 * Wraps errors from inside the dynamic Worker.
 */
export class ExecutionError extends ParallelError {
  /** The original error message from the remote isolate. */
  readonly remoteMessage: string;
  /** The stack trace from the remote isolate, if available. */
  readonly remoteStack?: string;

  constructor(message: string, remoteStack?: string) {
    super(message);
    this.name = 'ExecutionError';
    this.remoteMessage = message;
    this.remoteStack = remoteStack;
  }
}

/** Thrown when a task exceeds its deadline. */
export class TimeoutError extends ParallelError {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`Task exceeded ${deadlineMs}ms deadline`);
    this.name = 'TimeoutError';
    this.deadlineMs = deadlineMs;
  }
}

/**
 * Thrown when all retry attempts for a task have been exhausted.
 * Contains the last error encountered and the number of attempts made.
 */
export class RetryExhaustedError extends ParallelError {
  /** The last error that caused the final retry to fail. */
  readonly lastError: Error;
  /** Total number of attempts made (initial + retries). */
  readonly attempts: number;

  constructor(attempts: number, lastError: Error) {
    super(
      `Task failed after ${attempts} attempt(s): ${lastError.message}`,
    );
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** Thrown when the Worker Loader binding is missing or misconfigured. */
export class BindingError extends ParallelError {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}
