/**
 * Pin the transient-error matcher used by the Coordinator's leaf-DO
 * retry path. The list of patterns evolves with runtime symptoms — keep
 * the matcher conservative so user-thrown errors never get retried.
 */
import { describe, expect, it } from 'bun:test';
import { isTransientLeafError } from '../../src/coordinator/transient';

describe('isTransientLeafError', () => {
  const TRANSIENT_FIXTURES = [
    'Internal error while starting up Durable Object storage caused object to be reset.',
    'caused object to be reset',
    'Durable Object storage was reset',
    'Network connection lost.',
    'The script will never generate a response.',
    'durable object storage error',
  ];

  const NON_TRANSIENT_FIXTURES = [
    'TypeError: cannot read property of undefined',
    'User function threw "out of memory"',
    'BackpressureError: LRU thrash detected',
    'TimeoutError: deadline exceeded',
    'CancelledError: cancel by token',
    '',
    'random unrelated error message',
  ];

  for (const msg of TRANSIENT_FIXTURES) {
    it(`flags transient: "${msg.slice(0, 60)}"`, () => {
      expect(isTransientLeafError(new Error(msg))).toBe(true);
    });
  }

  for (const msg of NON_TRANSIENT_FIXTURES) {
    it(`does NOT flag user error: "${msg.slice(0, 60)}"`, () => {
      expect(isTransientLeafError(new Error(msg))).toBe(false);
    });
  }

  it('handles non-Error throwables', () => {
    expect(isTransientLeafError('caused object to be reset')).toBe(true);
    expect(isTransientLeafError({ message: 'caused object to be reset' })).toBe(false);
    expect(isTransientLeafError(undefined)).toBe(false);
    expect(isTransientLeafError(null)).toBe(false);
  });
});
