import { afterEach, describe, expect, it } from 'bun:test';
import {
  LoaderSemaphore,
  _resetIsolateSemaphoreForTesting,
  _setMeasuredCapForTesting,
  defaultCapFor,
  getMeasuredCap,
  isolateSemaphore,
} from '../../src/loader/loader-budget';

afterEach(() => {
  _resetIsolateSemaphoreForTesting();
  _setMeasuredCapForTesting(undefined);
});

describe('defaultCapFor / getMeasuredCap', () => {
  it('fetch handler default = 3', () => {
    expect(defaultCapFor('fetch-handler')).toBe(3);
  });
  it('DO method default = 4', () => {
    expect(defaultCapFor('do-method')).toBe(4);
  });
  it('measured cap overrides default', () => {
    _setMeasuredCapForTesting(8);
    expect(getMeasuredCap('fetch-handler')).toBe(8);
  });
});

describe('LoaderSemaphore', () => {
  it('rejects cap < 1', () => {
    expect(() => new LoaderSemaphore(0)).toThrow(RangeError);
  });

  it('runs up to `cap` tasks concurrently', async () => {
    const sem = new LoaderSemaphore(2);
    let inFlight = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    };
    await Promise.all(Array.from({ length: 5 }, () => sem.run(work)));
    expect(peak).toBe(2);
  });

  it('releases the permit when the task settles even if it throws', async () => {
    const sem = new LoaderSemaphore(1);
    let resolved = false;
    await sem.run(async () => {
      /* ok */
    });
    try {
      await sem.run(async () => {
        throw new Error('boom');
      });
    } catch {
      /* swallow */
    }
    await sem.run(async () => {
      resolved = true;
    });
    expect(resolved).toBe(true);
    expect(sem.inFlight).toBe(0);
  });
});

describe('isolateSemaphore', () => {
  it('returns the same instance across calls (per-isolate cache)', () => {
    const a = isolateSemaphore('do-method');
    const b = isolateSemaphore('do-method');
    expect(a).toBe(b);
  });
});
