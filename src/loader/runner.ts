import type { RpcEnvelope, WorkerCode, WorkerLoader } from '../types';
import { buildWorkerCode, type WorkerCodeOptions } from './codegen';
import { buildCacheKey, type CacheKeyStrategy } from './cache-key';
import { isolateSemaphore, type CallSiteKind } from './loader-budget';
import { sanitizeBindings } from './sandbox';
import { canonicalizeContext, hashSource } from './serialize';
import { validateReturn, rejectIfRpcStub } from './return-validator';
import { marshalError } from '../transport/error-marshal';


export interface LoaderRunnerOptions {
  loader: WorkerLoader;
  /**
   * Where this runner is being called from. Governs the per-isolate
   * concurrent-loader cap (cap=3 from a fetch handler, cap=4 from a
   * DO method). In the redesigned topology each leaf DO runs one
   * job at a time, so the cap is rarely binding — but the semaphore
   * still queues defensively if a caller drives `runBatch` with a
   * larger argsList.
   */
  callSite: CallSiteKind;
  /** Cache-key strategy. */
  cacheKeyStrategy: CacheKeyStrategy;
  /** Default WorkerCode options (compatibilityDate, globalOutbound, limits, tails). */
  workerOptions?: WorkerCodeOptions;
  /** Optional bindings allow-list. Default: pass everything user supplied (minus `Cfp*`). */
  allowList?: ReadonlyArray<string>;
}

export interface RunOneInput {
  /** User function source string (pre-serialized). */
  fnSource: string;
  /** Stable hash of fnSource — used for cache keys and observability. */
  fnHash: string;
  /** Module-scope context to embed. JSON-canonicalizable values only. */
  context?: Record<string, unknown>;
  /** User-supplied bindings to forward into the dynamic worker's `env`. */
  bindings?: Record<string, unknown>;
  /** Wire envelope (deadline / cancel signal / mode). */
  envelope: RpcEnvelope & { signal: { cancelled: boolean; reason?: string } };
  /** Args to the user fn. */
  args: unknown[];
  /** Per-submission opt-in to a fresh isolate. */
  freshIsolate?: boolean;
  /**
   * Task slot index within a single fan-out (0..N-1). Differentiates
   * concurrent isolates within ONE fan-out so they don't all collide on
   * one `loader.get(sameKey)` cache hit; preserves warm reuse across
   * calls because the same slot index always maps to the same isolate.
   * See `buildCacheKey` for the full rationale and POC validation.
   */
  taskSlot?: number;
  /**
   * Live cancel transport. When provided, the runner installs this stream
   * as `env.cancelStream` on the loaded isolate. The loaded isolate reads
   * one chunk and aborts a local AbortController whose signal is exposed
   * as `env.signal`. See `cancel-stream.ts` for the producer side.
   *
   * If `undefined`, the loader receives no cancel-stream and the loaded
   * isolate's `env.signal` is a never-aborting AbortSignal.
   */
  cancelStream?: ReadableStream<Uint8Array>;
}

/**
 * Run one user-fn submission against the local LOADER binding.
 *
 * Holds a per-isolate semaphore permit while the underlying `execute` call
 * is in flight. Permit is released when this function's promise settles
 * (caller-settle, NOT loader-resolve) — see DESIGN §7.5 for why.
 */
export class LoaderRunner {
  readonly #opts: LoaderRunnerOptions;
  constructor(opts: LoaderRunnerOptions) {
    this.#opts = opts;
  }

  async runOne<R>(input: RunOneInput): Promise<R> {
    return this.#runWithMode<R>(input, 'pool-fn');
  }

  /**
   * Actor-class dispatch. Uses the `actor-class` codegen mode that emits a
   * `submit(envelope, fnSource, state, args)` entrypoint, prepending
   * `(state, sql)` to the user fn args. Returns the new state alongside the
   * value so the Coordinator can persist state atomically.
   */
  async runActor<R>(
    input: RunOneInput & { state: unknown },
  ): Promise<{ state: unknown; value: R }> {
    return this.#runWithMode<{ state: unknown; value: R }>(input, 'actor-class');
  }

  async #runWithMode<R>(
    input: RunOneInput & { state?: unknown },
    mode: 'pool-fn' | 'actor-class',
  ): Promise<R> {
    const sem = isolateSemaphore(this.#opts.callSite);
    return sem.run(async () => {
      const cacheKey = buildCacheKey({
        fnSource: input.fnSource,
        contextHash: input.context ? hashSource(canonicalizeContext(input.context)) : '',
        strategy: this.#opts.cacheKeyStrategy,
        forceFresh: input.freshIsolate,
        taskSlot: input.taskSlot,
      });

      const sanitizedBindings = sanitizeBindings(input.bindings, this.#opts.allowList);

      const workerCode: () => Promise<WorkerCode> = async () =>
        buildWorkerCode({
          // Bake the fn into the module body for both pool-fn and
          // actor-class modes — the Workers runtime disallows `eval` inside loaded
          // isolates by default, so we cannot eval the source at submit
          // time. The cache key already varies by fnSource hash, so each
          // distinct fn submitted to the same actor instantiates its own
          // isolate (state still persists in the actor coordinator DO).
          fnSource: input.fnSource,
          source: {
            mode,
            context: input.context,
            injectCancelSignal: true,
            // Always pass env when injecting the cancel signal, so user fns
            // never face an undefined `env`. The codegen builds
            // `env = Object.assign({}, this.env, { signal })` regardless.
            passEnv: true,
            sealGlobals: this.#opts.workerOptions?.globalOutbound === null,
          },
          worker: {
            ...this.#opts.workerOptions,
            env: {
              ...sanitizedBindings,
              // Live cancel transport (Item 4). Stripped from user-visible env
              // by codegen `delete __env__.cancelStream`.
              ...(input.cancelStream ? { cancelStream: input.cancelStream } : {}),
            },
          },
        });

      try {
        const stub = this.#opts.loader.get(cacheKey, workerCode);
        const ep = stub.getEntrypoint();
        const result =
          mode === 'pool-fn'
            ? await ep.execute(input.envelope, ...input.args)
            : await (
                ep as unknown as {
                  submit(
                    envelope: unknown,
                    fnSource: string,
                    state: unknown,
                    args: unknown[],
                  ): Promise<unknown>;
                }
              ).submit(input.envelope, input.fnSource, input.state ?? {}, input.args);
        rejectIfRpcStub(result);
        return validateReturn(result) as R;
      } catch (err) {
        throw marshalError(err);
      }
    });
  }
}

/** Factory for a runner with sensible defaults. */
export function makeLoaderRunner(opts: LoaderRunnerOptions): LoaderRunner {
  return new LoaderRunner(opts);
}
