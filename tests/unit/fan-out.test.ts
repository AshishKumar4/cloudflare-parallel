import { describe, expect, it } from 'bun:test';
import { runFanOut } from '../../src/api/fan-out';
import { AggregateExecutionError } from '../../src/errors/index';

describe('runFanOut', () => {
  it('returns all results on success', async () => {
    const out = await runFanOut<number, number>({
      items: [1, 2, 3, 4],
      onError: 'throw',
      concurrency: 4,
      mode: 'map',
      run: async (n) => n * 2,
    });
    expect(out).toEqual([2, 4, 6, 8]);
  });

  it('default throw mode raises plain error on single failure', async () => {
    let caught: unknown;
    try {
      await runFanOut<number, number>({
        items: [1, 2, 3],
        onError: 'throw',
        concurrency: 3,
        mode: 'map',
        run: async (n) => {
          if (n === 2) throw new Error('boom');
          return n * 2;
        },
      });
    } catch (e) {
      caught = e;
    }
    // Single failure with partials → AggregateExecutionError carrying partials.
    expect(caught).toBeInstanceOf(AggregateExecutionError);
    const agg = caught as AggregateExecutionError;
    expect(agg.errors.size).toBe(1);
    expect(agg.partialResults.size).toBe(2);
    expect(agg.partialResults.get(0)).toBe(2);
    expect(agg.partialResults.get(2)).toBe(6);
  });

  it('default throw mode raises AggregateExecutionError on multi-error', async () => {
    let caught: unknown;
    try {
      await runFanOut<number, number>({
        items: [1, 2, 3, 4],
        onError: 'throw',
        concurrency: 4,
        mode: 'map',
        run: async (n) => {
          if (n === 2 || n === 3) throw new Error('boom');
          return n;
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateExecutionError);
    expect((caught as AggregateExecutionError).errors.size).toBe(2);
  });

  it('null mode replaces failures with null', async () => {
    const out = await runFanOut<number, number | null>({
      items: [1, 2, 3],
      onError: 'null',
      concurrency: 3,
      mode: 'map',
      run: async (n) => {
        if (n === 2) throw new Error('x');
        return n;
      },
    });
    expect(out).toEqual([1, null, 3]);
  });

  it('skip mode omits failures', async () => {
    const out = await runFanOut<number, number>({
      items: [1, 2, 3],
      onError: 'skip',
      concurrency: 3,
      mode: 'map',
      run: async (n) => {
        if (n === 2) throw new Error('x');
        return n;
      },
    });
    expect(out).toEqual([1, 3]);
  });

  it('settled mode returns {ok, value|error} entries', async () => {
    const out = (await runFanOut({
      items: [1, 2],
      onError: 'settled',
      concurrency: 2,
      mode: 'map',
      run: async (n) => {
        if (n === 2) throw new Error('x');
        return n;
      },
    })) as Array<{ ok: boolean }>;
    expect(out[0]).toEqual({ ok: true, value: 1 });
    expect(out[1].ok).toBe(false);
  });

  it('respects concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    await runFanOut<number, number>({
      items: [1, 2, 3, 4, 5, 6],
      onError: 'throw',
      concurrency: 2,
      mode: 'map',
      run: async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return n;
      },
    });
    expect(peak).toBe(2);
  });
});
