/**
 * Live-cancel end-to-end tests for the RPC-stream + AbortSignal model.
 *
 * The cancel-stream mechanism: `pool.submit` builds a `ReadableStream`, the
 * coordinator forwards it into the loaded isolate's `env.cancelStream`,
 * the loaded isolate's prologue reads the first chunk and aborts a real
 * AbortController whose signal is exposed as `env.signal`.
 *
 * These tests exercise the producer (cancel-stream) and the codegen-emitted
 * consumer side end-to-end, in-process.
 */

import { describe, expect, it } from 'bun:test';
import { CancelToken } from '../../src/api/cancel.js';
import { createCancelStream, forkCancelStream } from '../../src/transport/cancel-stream.js';

describe('CancelToken exposes a real AbortSignal', () => {
  it('signal is an AbortSignal instance', () => {
    const t = new CancelToken();
    expect(t.signal).toBeInstanceOf(AbortSignal);
    expect(t.signal.aborted).toBe(false);
  });

  it('cancel() trips signal.aborted', () => {
    const t = new CancelToken();
    t.cancel('user requested');
    expect(t.signal.aborted).toBe(true);
  });

  it('signal.throwIfAborted() throws CancelledError', () => {
    const t = new CancelToken();
    t.cancel('go');
    expect(() => t.signal.throwIfAborted()).toThrow();
    let caught: unknown;
    try {
      t.signal.throwIfAborted();
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).name).toBe('CancelledError');
  });

  it('addEventListener("abort", ...) fires once', () => {
    const t = new CancelToken();
    let count = 0;
    t.signal.addEventListener('abort', () => count++);
    t.cancel();
    t.cancel(); // idempotent
    expect(count).toBe(1);
  });

  it('child cancel cascades when parent cancels', () => {
    const parent = new CancelToken();
    const child = parent.child();
    expect(child.signal.aborted).toBe(false);
    parent.cancel('parent cancel');
    expect(child.signal.aborted).toBe(true);
  });

  it('fromAbortSignal adapts an existing AbortController', () => {
    const ac = new AbortController();
    const t = CancelToken.fromAbortSignal(ac.signal);
    expect(t.signal.aborted).toBe(false);
    ac.abort('outer abort');
    // Listener fires sync.
    expect(t.signal.aborted).toBe(true);
  });

  it('withTimeout cancels after the delay', async () => {
    const t = CancelToken.withTimeout(10);
    await new Promise((r) => setTimeout(r, 25));
    expect(t.signal.aborted).toBe(true);
  });
});

describe('cancel-stream wire transport', () => {
  it('createCancelStream emits one chunk on cancel', async () => {
    const w = createCancelStream();
    w.cancel('abort-now');
    const reader = w.stream.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe('abort-now');
    const next = await reader.read();
    expect(next.done).toBe(true);
  });

  it('createCancelStream close() yields no chunk', async () => {
    const w = createCancelStream();
    w.close();
    const reader = w.stream.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it('cancel() is idempotent', () => {
    const w = createCancelStream();
    w.cancel('first');
    expect(() => w.cancel('second')).not.toThrow();
  });

  it('forkCancelStream(undefined, n) returns n undefined slots', () => {
    const out = forkCancelStream(undefined, 3);
    expect(out).toEqual([undefined, undefined, undefined]);
  });

  it('forkCancelStream broadcasts upstream cancel to all children', async () => {
    const upstream = createCancelStream();
    const children = forkCancelStream(upstream.stream, 3);
    expect(children.every((c) => c instanceof ReadableStream)).toBe(true);
    upstream.cancel('go');
    const decoded = await Promise.all(
      children.map(async (c) => {
        const r = c!.getReader();
        const { value } = await r.read();
        return new TextDecoder().decode(value);
      }),
    );
    expect(decoded).toEqual(['go', 'go', 'go']);
  });

  it('forkCancelStream broadcasts clean close to all children', async () => {
    const upstream = createCancelStream();
    const children = forkCancelStream(upstream.stream, 2);
    upstream.close();
    const dones = await Promise.all(
      children.map(async (c) => {
        const r = c!.getReader();
        const { done } = await r.read();
        return done;
      }),
    );
    expect(dones).toEqual([true, true]);
  });
});

describe('live cancel end-to-end via codegen-emitted reader', () => {
  // Simulate the loaded isolate's prologue: read first chunk from the
  // cancel stream, abort a local AbortController. Mirrors codegen logic.
  function emitAbortController(stream: ReadableStream<Uint8Array>): AbortController {
    const ac = new AbortController();
    (async () => {
      try {
        const reader = stream.getReader();
        const { value, done } = await reader.read();
        if (!done && value) {
          const reason = new TextDecoder().decode(value);
          if (!ac.signal.aborted) {
            ac.abort(Object.assign(new Error(reason), { name: 'CancelledError' }));
          }
        }
        try {
          reader.releaseLock();
        } catch {
          /* swallow */
        }
      } catch {
        /* swallow */
      }
    })();
    return ac;
  }

  it('user-fn-style code observes signal.aborted shortly after caller cancels', async () => {
    const ct = new CancelToken();
    const writer = createCancelStream();
    ct.onCancel((reason) => writer.cancel(reason));

    const ac = emitAbortController(writer.stream);
    const userSignal = ac.signal;

    // Simulated user fn: long loop that polls env.signal.aborted.
    const userPromise = (async () => {
      for (let i = 0; i < 500; i++) {
        if (userSignal.aborted) return { observedAbort: true, iter: i };
        await new Promise((r) => setTimeout(r, 1));
      }
      return { observedAbort: false, iter: -1 };
    })();

    // Fire cancel after a short delay.
    setTimeout(() => ct.cancel('user requested'), 10);

    const result = await userPromise;
    expect(result.observedAbort).toBe(true);
    // The user fn observes the abort within ~50 iterations (~50ms in this
    // setup; in production it's bounded by the stream RPC latency).
    expect(result.iter).toBeLessThan(200);
  });

  it('user-fn fetch(url, { signal }) is short-circuited by cancel', async () => {
    const ct = new CancelToken();
    const writer = createCancelStream();
    ct.onCancel((reason) => writer.cancel(reason));

    const ac = emitAbortController(writer.stream);

    // Simulate a fetch that respects AbortSignal — we use `Promise.race`
    // against signal abort, mirroring what fetch() does internally.
    const longRunning = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('completed without abort')), 5_000);
      ac.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(ac.signal.reason ?? new Error('AbortError'));
      });
    });

    setTimeout(() => ct.cancel('done'), 10);

    let caught: unknown;
    try {
      await longRunning;
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).name).toBe('CancelledError');
  });
});
