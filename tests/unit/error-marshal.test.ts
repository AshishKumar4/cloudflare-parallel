import { describe, expect, it } from 'bun:test';
import { isRetryable, marshalError } from '../../src/transport/error-marshal.js';
import {
  BackpressureError,
  BillingLimitError,
  DisconnectedError,
  ExecutionError,
  OutOfMemoryError,
  SerializationError,
} from '../../src/errors/index.js';

describe('marshalError', () => {
  it('maps "Too many concurrent dynamic workers" → BackpressureError', () => {
    const e = marshalError(new Error('Too many concurrent dynamic workers. at index 4'));
    expect(e).toBeInstanceOf(BackpressureError);
  });

  it('maps "out of memory" → OutOfMemoryError', () => {
    const e = marshalError(new Error('out of memory'));
    expect(e).toBeInstanceOf(OutOfMemoryError);
  });

  it('maps "Memory limit exceeded" → OutOfMemoryError', () => {
    const e = marshalError(new Error('Memory limit exceeded'));
    expect(e).toBeInstanceOf(OutOfMemoryError);
  });

  it('maps disconnections → DisconnectedError', () => {
    const e = marshalError(new Error('Worker terminated unexpectedly'));
    expect(e).toBeInstanceOf(DisconnectedError);
  });

  it('maps DataCloneError → SerializationError', () => {
    const dataClone = new Error('value could not be cloned');
    dataClone.name = 'DataCloneError';
    const e = marshalError(dataClone);
    expect(e).toBeInstanceOf(SerializationError);
  });

  it('maps "CPU exceeded" → BillingLimitError(cpuMs)', () => {
    const e = marshalError(new Error('CPU exceeded the allowed time'));
    expect(e).toBeInstanceOf(BillingLimitError);
    expect((e as BillingLimitError).kind).toBe('cpuMs');
  });

  it('preserves unknown errors as ExecutionError with originalName', () => {
    const original = new Error('something happened');
    original.name = 'CustomError';
    const e = marshalError(original);
    expect(e).toBeInstanceOf(ExecutionError);
    expect((e as ExecutionError).originalName).toBe('CustomError');
  });

  it('passes through already-marshaled errors', () => {
    const bp = new BackpressureError();
    expect(marshalError(bp)).toBe(bp);
  });

  // E5/E6 polish: extended pattern coverage.
  it('maps "could not be serialized" → SerializationError (E6)', () => {
    expect(marshalError(new Error('value could not be serialized'))).toBeInstanceOf(
      SerializationError,
    );
  });

  it('maps "cannot be cloned" → SerializationError (E6)', () => {
    expect(marshalError(new Error('Argument cannot be cloned'))).toBeInstanceOf(
      SerializationError,
    );
  });

  it('maps "not serializable" → SerializationError (E6)', () => {
    expect(marshalError(new Error('value is not serializable'))).toBeInstanceOf(
      SerializationError,
    );
  });

  it('maps "too many requests" → BackpressureError (E5)', () => {
    expect(marshalError(new Error('Too many requests in flight'))).toBeInstanceOf(
      BackpressureError,
    );
  });

  it('maps "worker reset" → DisconnectedError (E5)', () => {
    expect(marshalError(new Error('worker reset by runtime'))).toBeInstanceOf(DisconnectedError);
  });

  it('maps "exceeded cpu" → BillingLimitError(cpuMs) (E5)', () => {
    const e = marshalError(new Error('worker exceeded cpu budget'));
    expect(e).toBeInstanceOf(BillingLimitError);
    expect((e as BillingLimitError).kind).toBe('cpuMs');
  });

  it('case-insensitive matching for backpressure / disconnect markers', () => {
    expect(marshalError(new Error('OWNER QUOTA exceeded'))).toBeInstanceOf(BackpressureError);
    expect(marshalError(new Error('Isolate Is No Longer Running'))).toBeInstanceOf(
      DisconnectedError,
    );
  });
});

describe('isRetryable', () => {
  it('marks BackpressureError retryable', () => {
    expect(isRetryable(new BackpressureError())).toBe(true);
  });
  it('marks DisconnectedError retryable', () => {
    expect(isRetryable(new DisconnectedError())).toBe(true);
  });
  it('does not mark ExecutionError retryable', () => {
    expect(isRetryable(new ExecutionError('x'))).toBe(false);
  });
  it('does not mark OutOfMemoryError retryable', () => {
    expect(isRetryable(new OutOfMemoryError())).toBe(false);
  });
});
