import { CancelledError } from '../errors/index.js';

/**
 * Cancellation primitive for cloudflare-parallel.
 *
 * **Web-platform alignment.** `CancelToken.signal` is a real `AbortSignal`
 * — the same shape `fetch`, `addEventListener`, `ReadableStream.cancel`, and
 * every modern Web/Workers API consumes. User functions receive an
 * `env.signal: AbortSignal` and can:
 *
 * ```ts
 * await fetch(url, { signal: env.signal });    // standard fetch cancel
 * env.signal.throwIfAborted();                  // standard short-circuit
 * env.signal.addEventListener('abort', () => stopWork());
 * if (env.signal.aborted) return null;
 * ```
 *
 * **Hierarchical.** `parent.child()` returns a token cancelled when the
 * parent is. Used for cascading fan-out cancel.
 *
 * **AbortSignal adapter.** `CancelToken.fromAbortSignal(signal)` adapts an
 * existing `AbortController.signal` into a CancelToken (so library APIs
 * expecting CancelToken compose with caller-provided AbortControllers).
 *
 * **Wire transport.** Across a DO RPC boundary we transport cancel state via
 * a `ReadableStream<Uint8Array>` carried in the loader's `env.cancelStream`;
 * the loaded isolate reads a single sentinel byte and aborts its own local
 * AbortController. See `cancel-stream.ts`.
 */

export class CancelToken implements AsyncDisposable {
  /** Stable correlation id (used for observability and deduplication). */
  readonly id: string;
  readonly #controller: AbortController;
  readonly #children = new Set<CancelToken>();
  readonly #abortListener?: () => void;
  readonly #abortSource?: AbortSignal;

  /**
   * @param opts.id - stable correlation id (defaults to a random tag)
   * @param opts.abortSignal - existing AbortSignal to mirror (cancel when it aborts)
   */
  constructor(opts: { id?: string; abortSignal?: AbortSignal } = {}) {
    this.id = opts.id ?? `ct-${Math.random().toString(36).slice(2, 10)}`;
    this.#controller = new AbortController();

    if (opts.abortSignal) {
      this.#abortSource = opts.abortSignal;
      if (opts.abortSignal.aborted) {
        // Schedule cancel in microtask so subscribers attach first.
        queueMicrotask(() => this.cancel(reasonOf(opts.abortSignal)));
      } else {
        this.#abortListener = () => this.cancel(reasonOf(opts.abortSignal));
        opts.abortSignal.addEventListener('abort', this.#abortListener, { once: true });
      }
    }
  }

  /** Adapt an existing `AbortSignal` into a `CancelToken`. */
  static fromAbortSignal(signal: AbortSignal): CancelToken {
    return new CancelToken({ abortSignal: signal });
  }

  /**
   * Cancel after `ms` milliseconds (using a `setTimeout`). When `ms <= 0`
   * the token is constructed already-cancelled (synchronously observable
   * via `signal.aborted === true`).
   */
  static withTimeout(ms: number): CancelToken {
    const t = new CancelToken();
    if (ms <= 0) {
      t.cancel(`timeout after ${ms}ms`);
      return t;
    }
    const timer = setTimeout(() => t.cancel(`timeout after ${ms}ms`), ms);
    t.#controller.signal.addEventListener('abort', () => clearTimeout(timer), {
      once: true,
    });
    return t;
  }

  /**
   * Real Web-platform `AbortSignal`. Use this with `fetch`, `setTimeout`,
   * `ReadableStream.cancel`, and any API that accepts an AbortSignal.
   */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** True if cancel has fired. */
  get isCancelled(): boolean {
    return this.#controller.signal.aborted;
  }

  /**
   * Promise that **rejects** with `CancelledError` when cancelled. For
   * `Promise.race([work, token.cancelled])` patterns. Never resolves.
   */
  get cancelled(): Promise<never> {
    return new Promise<never>((_, reject) => {
      if (this.#controller.signal.aborted) {
        reject(this.#cancelledError());
      } else {
        this.#controller.signal.addEventListener(
          'abort',
          () => reject(this.#cancelledError()),
          { once: true },
        );
      }
    });
  }

  /** Cancel this token (and all children). Idempotent. */
  cancel(reason?: string): void {
    if (this.#controller.signal.aborted) return;
    // Store both the typed error (for `signal.throwIfAborted()`) and the raw
    // reason (for `poll().reason`). We pass the typed error to the
    // AbortController so user code's `signal.throwIfAborted()` produces a
    // CancelledError, and we preserve the original reason string for
    // observability via `poll()`.
    this.#rawReason = reason;
    const err = new CancelledError(reason);
    this.#controller.abort(err);
    for (const child of this.#children) child.cancel(reason);
    this.#children.clear();
  }

  /** The raw `reason` string passed to `cancel()`. Set before `signal.aborted` is true. */
  #rawReason?: string;

  /** Create a child token cancelled when this is cancelled. */
  child(): CancelToken {
    const c = new CancelToken();
    if (this.#controller.signal.aborted) {
      c.cancel(reasonOf(this.#controller.signal));
    } else {
      this.#children.add(c);
      // If the child gets cancelled directly, drop it from our set so we
      // don't keep a stale reference.
      c.#controller.signal.addEventListener(
        'abort',
        () => this.#children.delete(c),
        { once: true },
      );
    }
    return c;
  }

  /** Synchronous poll. Use `signal.aborted` directly when possible. */
  poll(): { cancelled: boolean; reason?: string } {
    return {
      cancelled: this.#controller.signal.aborted,
      reason: this.#rawReason,
    };
  }

  /**
   * Subscribe to cancel without consuming the cancelled promise. Internal
   * helper. Hook fires once.
   */
  onCancel(hook: (reason?: string) => void): void {
    if (this.#controller.signal.aborted) {
      hook(this.#rawReason);
      return;
    }
    this.#controller.signal.addEventListener('abort', () => hook(this.#rawReason), { once: true });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#abortListener && this.#abortSource) {
      this.#abortSource.removeEventListener('abort', this.#abortListener);
    }
    this.#children.clear();
  }

  // -- internals -----------------------------------------------------------

  #cancelledError(): CancelledError {
    return new CancelledError(this.#rawReason);
  }
}

/**
 * Extract a string `reason` from an `AbortSignal`. Browsers and workerd
 * usually surface `signal.reason` as either a `DOMException`/`Error` or the
 * value passed to `controller.abort(...)`.
 */
function reasonOf(signal: AbortSignal | undefined): string | undefined {
  if (!signal) return undefined;
  const r = (signal as AbortSignal & { reason?: unknown }).reason;
  if (r === undefined) return undefined;
  if (typeof r === 'string') return r;
  if (r instanceof Error) return r.message;
  try {
    return String(r);
  } catch {
    return undefined;
  }
}
