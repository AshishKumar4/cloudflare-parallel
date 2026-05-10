/**
 * Per-V8-isolate concurrent-loader budget enforcement.
 *
 * Empirical caps (empirical caps, NOT in any public Cloudflare doc):
 *   - 3 concurrent loaders from a Worker fetch handler
 *   - 4 concurrent loaders from a DO method
 *
 * The semaphore here only counts direct `env.LOADER.get(...)` calls from
 * THIS isolate. RPC fan-out to other DOs does NOT count (RPC fan-out is not loader-capped).
 *
 * **Critical invariant (DESIGN §7.5)**: the permit is released when the
 * caller's outer promise settles, NOT when `LOADER.get` resolves. This
 * avoids deadlocks where 4 cancelled-but-orphaned loaders hold all permits
 * while the caller has moved on.
 */

// Per-V8-isolate cache lives on `globalThis` so DO methods on the same
// isolate share one budget. Type stays narrow per-key (set/get below).
interface LoaderBudgetGlobals {
  cfpLoaderCap?: number;
  cfpLoaderSem?: LoaderSemaphore;
}
const globals = globalThis as unknown as LoaderBudgetGlobals;

export type CallSiteKind = 'fetch-handler' | 'do-method';

const DEFAULT_CAP_FETCH = 3;
const DEFAULT_CAP_DO = 4;

export function defaultCapFor(kind: CallSiteKind): number {
  return kind === 'do-method' ? DEFAULT_CAP_DO : DEFAULT_CAP_FETCH;
}

/** Resolve the current isolate's measured cap, falling back to the default. */
export function getMeasuredCap(kind: CallSiteKind): number {
  const measured = globals.cfpLoaderCap;
  if (typeof measured === 'number' && measured > 0) return measured;
  return defaultCapFor(kind);
}

/** Override for testing only. */
export function _setMeasuredCapForTesting(cap: number | undefined): void {
  if (cap === undefined) {
    delete globals.cfpLoaderCap;
  } else {
    globals.cfpLoaderCap = cap;
  }
}

interface Waiter {
  resolve: () => void;
}

export class LoaderSemaphore {
  #cap: number;
  #inFlight = 0;
  readonly #waiters: Waiter[] = [];

  constructor(cap: number) {
    if (!Number.isFinite(cap) || cap < 1) {
      throw new RangeError(`LoaderSemaphore cap must be >= 1, got ${cap}`);
    }
    this.#cap = Math.floor(cap);
  }

  get cap(): number {
    return this.#cap;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get queueDepth(): number {
    return this.#waiters.length;
  }

  /**
   * Run `task` while holding one permit. The permit is released when
   * `task`'s returned promise settles — even if cancellation has caused
   * the caller to move on (the orphan isolate is the runtime's problem).
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#inFlight < this.#cap) {
      this.#inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push({ resolve });
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      // Hand the permit to the next waiter without changing inFlight.
      next.resolve();
    } else {
      this.#inFlight--;
    }
  }
}

/** Per-isolate semaphore lookup. Lives on globalThis so DO methods share one. */
export function isolateSemaphore(kind: CallSiteKind): LoaderSemaphore {
  const existing = globals.cfpLoaderSem;
  if (existing) return existing;
  const sem = new LoaderSemaphore(getMeasuredCap(kind));
  globals.cfpLoaderSem = sem;
  return sem;
}

/** For tests only. */
export function _resetIsolateSemaphoreForTesting(): void {
  delete globals.cfpLoaderSem;
}
