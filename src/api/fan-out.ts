import { AggregateExecutionError, CancelledError, ParallelError } from '../errors/index.js';
import type { CancelToken } from './cancel.js';
import type { OnErrorStrategy } from './options.js';

export type FanOutMode = 'map' | 'scatter';

export interface FanOutOptions<T, R> {
  items: T[];
  concurrency: number;
  onError: OnErrorStrategy;
  mode: FanOutMode;
  run: (item: T, idx: number) => Promise<R>;
  /** Parent cancel token; used to derive per-item children for `'throw-fast'`. */
  cancel?: CancelToken;
}

interface SettledOk<R> {
  ok: true;
  value: R;
}
interface SettledErr {
  ok: false;
  error: ParallelError;
}
type Settled<R> = SettledOk<R> | SettledErr;

function asParallel(err: unknown): ParallelError {
  if (err instanceof ParallelError) return err;
  const e = err instanceof Error ? err : new Error(String(err));
  // Wrap unknowns; never bubble raw Error to user space.
  return Object.assign(new ParallelError(e.message), { stack: e.stack });
}

export async function runFanOut<T, R>(opts: FanOutOptions<T, R>): Promise<R[]> {
  const { items, run, onError } = opts;
  if (items.length === 0) return [];

  // For 'throw-fast', derive child tokens per item so we can cancel siblings
  // synchronously when the first error arrives. The parent ref is unused
  // today (children are minted-and-tripped, not minted-from-parent), but
  // staged so a future linker can wire propagation properly.
  const childTokens: CancelToken[] = [];

  const settled: Settled<R>[] = new Array(items.length);
  let cursor = 0;
  let aborted = false;

  const runOne = async (idx: number): Promise<void> => {
    if (aborted) {
      settled[idx] = {
        ok: false,
        error: new CancelledError('aborted by sibling failure'),
      };
      return;
    }
    try {
      const value = await run(items[idx], idx);
      settled[idx] = { ok: true, value };
    } catch (err) {
      const e = asParallel(err);
      settled[idx] = { ok: false, error: e };
      if (onError === 'throw-fast') {
        aborted = true;
        for (const ct of childTokens) ct.cancel('throw-fast: sibling failed');
      }
    }
  };

  const concurrency = Math.max(1, Math.min(opts.concurrency, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          if (aborted) {
            settled[idx] = {
              ok: false,
              error: new CancelledError('aborted by sibling failure'),
            };
            continue;
          }
          await runOne(idx);
        }
      })(),
    );
  }
  await Promise.all(workers);

  // Build results per onError mode.
  const errors = new Map<number, ParallelError>();
  const partial = new Map<number, unknown>();
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.ok) partial.set(i, s.value);
    else errors.set(i, s.error);
  }

  if (errors.size === 0) {
    return settled.map((s) => (s as SettledOk<R>).value);
  }

  switch (onError) {
    case 'throw': {
      if (errors.size === 1) {
        const [, only] = [...errors][0];
        // Surface partialResults on a wrapped error if any siblings succeeded.
        if (partial.size > 0) {
          throw new AggregateExecutionError(errors, partial);
        }
        throw only;
      }
      throw new AggregateExecutionError(errors, partial);
    }
    case 'throw-fast': {
      // First-error-wins; partial map carries siblings that completed before cancel.
      const first = [...errors.entries()].sort((a, b) => a[0] - b[0])[0][1];
      if (partial.size > 0) {
        // Wrap so callers can recover partials if they want.
        throw new AggregateExecutionError(errors, partial);
      }
      throw first;
    }
    case 'null':
      return settled.map((s) => (s.ok ? s.value : (null as unknown as R)));
    case 'skip':
      return settled.filter((s): s is SettledOk<R> => s.ok).map((s) => s.value);
    case 'settled':
      // Cast: caller of 'settled' should be reading via a typed accessor.
      return settled as unknown as R[];
    default: {
      const _exhaustive: never = onError;
      void _exhaustive;
      throw new Error(`unknown onError mode: ${onError as string}`);
    }
  }
}
