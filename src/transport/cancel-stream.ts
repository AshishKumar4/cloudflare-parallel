/**
 * Cancel-stream wire protocol.
 *
 * Live cancel from the coordinator's perspective travels to the loaded
 * isolate as a `ReadableStream<Uint8Array>` carried on the WorkerCode's
 * `env.cancelStream`. The coordinator writes a single sentinel chunk when
 * cancellation fires; the loaded isolate's prologue (emitted by codegen)
 * spawns a reader that, on first chunk, calls `controller.abort(reason)` on
 * a local `AbortController` whose signal is exposed to user code as
 * `env.signal`.
 *
 * Why streams: the Worker Loader's env shape is structured-clone (plus
 * service-stub passthrough). `ReadableStream` is part of the structured
 * clone graph. Streams traverse RPC boundaries cleanly. We use a stream
 * (rather than a one-shot value) because the load-time env is captured
 * once but cancel can fire at any later moment.
 *
 * Why one byte: the chunk content is just a sentinel; the message payload
 * (the reason string) rides as JSON in the same chunk. The reader treats
 * the very first chunk as "cancel fired" regardless of content.
 *
 * Drop-in for `env.LOADER.abort(id)` (when the runtime ships that primitive): the
 * coordinator additionally calls `loader.abort(taskId)` after writing the
 * stream byte — the public API is identical.
 */

const encoder = new TextEncoder();

export interface CancelStreamWriter {
  /** Stream to pass into the loader's `env.cancelStream`. */
  readonly stream: ReadableStream<Uint8Array>;
  /** Trip cancellation. Idempotent. */
  cancel(reason?: string): void;
  /** Close cleanly (work completed; no cancel happened). Idempotent. */
  close(): void;
}

/**
 * Create a one-shot cancel stream. The returned `stream` should be passed
 * to `env.LOADER.get(id, () => ({ env: { cancelStream: stream, ... } }))`.
 *
 * Calling `cancel(reason)` enqueues a single Uint8Array chunk containing
 * the reason and then closes the stream. Calling `close()` skips the chunk
 * and closes cleanly. Both are idempotent.
 *
 * Important: each loader call needs a fresh stream (streams are single-use
 * once read). The Coordinator builds one per dispatch.
 */
export function createCancelStream(): CancelStreamWriter {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // Stream consumer (the loaded isolate) may cancel its read; treat it
      // as a no-op. We're the producer side.
      settled = true;
    },
  });

  return {
    stream,
    cancel(reason?: string): void {
      if (settled) return;
      settled = true;
      try {
        controller?.enqueue(encoder.encode(reason ?? 'cancelled'));
        controller?.close();
      } catch {
        // Stream may already be closed/cancelled by the consumer. Idempotent.
      }
    },
    close(): void {
      if (settled) return;
      settled = true;
      try {
        controller?.close();
      } catch {
        // ditto
      }
    },
  };
}

/**
 * Fan a single upstream cancel-stream out to N downstream child streams.
 * Used at every fan-out level (hybrid leaf dispatch, tree sub-coord
 * dispatch) so each downstream leg gets its own fresh ReadableStream
 * (streams are single-reader; we can't pass the same instance twice).
 *
 * When the upstream emits a chunk (cancellation fires), every child gets
 * the same chunk and is then closed. When the upstream closes cleanly,
 * every child closes cleanly. If the upstream is `undefined` (no cancel
 * token wired), `forkCancelStream(undefined, n)` returns `n` undefined
 * slots (avoids creating dead streams).
 */
export function forkCancelStream(
  upstream: ReadableStream<Uint8Array> | undefined,
  n: number,
): Array<ReadableStream<Uint8Array> | undefined> {
  if (!upstream) return new Array(n).fill(undefined);

  const writers: CancelStreamWriter[] = [];
  for (let i = 0; i < n; i++) writers.push(createCancelStream());

  // Pump the upstream into all child writers.
  (async () => {
    try {
      const reader = upstream.getReader();
      const { value, done } = await reader.read();
      if (done) {
        for (const w of writers) w.close();
      } else if (value) {
        const reason = new TextDecoder().decode(value);
        for (const w of writers) w.cancel(reason);
      }
      try {
        reader.releaseLock();
      } catch {
        /* swallow */
      }
    } catch {
      // Upstream errored: best-effort close children.
      for (const w of writers) w.close();
    }
  })();

  return writers.map((w) => w.stream);
}
