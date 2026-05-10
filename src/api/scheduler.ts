import { BindingError, MissingBindingError, ResultExpiredError } from '../errors/index.js';
import { hashSource, serializeFunction } from '../loader/serialize.js';
import { wireToError } from './error-decode.js';
import { emitObservabilityEvent } from '../observability/index.js';
import type {
  Job,
  JobHandle,
  JobStatus,
  PoolEnv,
  RetryPolicy,
  SchedulerOptions,
  SchedulerStats,
} from './options.js';
import type { SchedulerEnqueueRequest } from '../scheduler/scheduler-do.js';

interface SchedulerStub {
  enqueue(req: SchedulerEnqueueRequest): Promise<{ id: string }>;
  status(jobId: string): Promise<JobStatus | null>;
  result(jobId: string): Promise<{
    status: JobStatus;
    value?: unknown;
    error?: { name: string; message: string; stack?: string };
  }>;
  cancel(jobId: string, reason?: string): Promise<boolean>;
  cancelByTenant(tenantId: string, reason?: string): Promise<number>;
  stats(): Promise<{
    queued: number;
    leased: number;
    done: number;
    failed: number;
    cancelled: number;
    oldestQueuedAgeMs: number;
  }>;
  configure(c: SchedulerConfigureInput): Promise<{ effective: SchedulerConfigSnapshot }>;
}

/** Subset of the dispatcher tunables exposed via {@link IScheduler.configure}. */
export interface SchedulerConfigureInput {
  inFlightLimit?: number;
  maxQueueDepth?: number;
  fairCapacityPerTenant?: number;
  resultTtlMs?: number;
  defaultLeaseMs?: number;
}

export interface SchedulerConfigSnapshot {
  inFlightLimit: number;
  maxQueueDepth: number;
  fairCapacityPerTenant: number;
  resultTtlMs: number;
  defaultLeaseMs: number;
}

const DEFAULT_RETRY: RetryPolicy = { max: 3, backoff: 'exponential', baseMs: 200 };
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_RESULT_TTL = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Public Scheduler interface — implemented by both {@link Scheduler} (the
 * production class) and the testing fake (`Parallel.testing.schedulerFake`).
 */
export interface IScheduler<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  B extends Record<string, unknown> = Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  C extends Record<string, unknown> = Record<string, unknown>,
> {
  enqueue<A extends unknown[], R>(job: Job<A, R>): Promise<JobHandle<R>>;
  cancelByTenant(tenantId: string, reason?: string): Promise<number>;
  drain(): Promise<void>;
  stats(): Promise<SchedulerStats>;
  attachQueue(queue: unknown): void;
  /**
   * Tune the SchedulerDO's dispatcher knobs at runtime. Returns the
   * effective config after merge. Pre-existing settings persist;
   * passing only the fields you want to change is fine.
   */
  configure(c: SchedulerConfigureInput): Promise<SchedulerConfigSnapshot>;
}

export class Scheduler<B extends Record<string, unknown>, C extends Record<string, unknown>>
  implements IScheduler<B, C> {
  readonly #env: PoolEnv;
  readonly #opts: SchedulerOptions<B, C>;

  constructor(env: PoolEnv, opts: SchedulerOptions<B, C>) {
    if (!env.LOADER || typeof env.LOADER.get !== 'function') {
      throw new BindingError('Parallel.scheduler() requires a Worker Loader binding.');
    }
    if (!env.CfpSchedulerDO) {
      throw new MissingBindingError('CfpSchedulerDO');
    }
    if (!opts.id) {
      throw new BindingError('Parallel.scheduler() requires `opts.id`');
    }
    this.#env = env;
    this.#opts = opts;
  }

  #stub(): SchedulerStub {
    const ns = this.#env.CfpSchedulerDO!;
    return ns.get(ns.idFromName(this.#opts.id)) as unknown as SchedulerStub;
  }

  /**
   * Enqueue a job. Returns a {@link JobHandle} that can be polled for
   * status, awaited for the result, or cancelled.
   *
   * Jobs are at-least-once: a worker that loses its lease on a crash
   * will be retried up to `retry.max` times. User fns submitted via the
   * scheduler MUST be idempotent (or use `idempotencyKey` to dedupe via
   * the JobStore CAS).
   *
   * @param job {@link Job} — `fn`, `args`, optional `tenantId`,
   *   `deadline`/`deadlineMs`, `retry`, `meta`, `idempotencyKey`.
   * @returns a handle whose `result()` long-polls until terminal.
   * @throws BackpressureError if the SchedulerDO's queue is at
   *   `maxQueueDepth`.
   */
  async enqueue<A extends unknown[], R>(job: Job<A, R>): Promise<JobHandle<R>> {
    const fnSource = serializeFunction(job.fn);
    const fnHash = hashSource(fnSource);
    const id = `j-${fnHash}-${Math.random().toString(36).slice(2, 10)}`;
    const deadlineEpochMs =
      job.deadline ??
      (job.deadlineMs !== undefined
        ? Date.now() + job.deadlineMs
        : Date.now() + (this.#opts.deadline?.defaultMs ?? DEFAULT_DEADLINE_MS));

    await this.#stub().enqueue({
      id,
      tenantId: job.tenantId ?? 'default',
      fnSource,
      fnHash,
      args: job.args as unknown[],
      context: this.#opts.context as Record<string, unknown> | undefined,
      deadlineEpochMs,
      retry: job.retry ?? this.#opts.retry ?? DEFAULT_RETRY,
      meta: job.meta,
      idempotencyKey: job.idempotencyKey,
      cacheKeyStrategy: this.#opts.cacheKeyStrategy ?? 'stable',
    });
    emitObservabilityEvent(this.#opts.observability, {
      kind: 'scheduler',
      payload: { ts: Date.now(), jobId: id, kind: 'enqueued' },
    });

    const stub = this.#stub();
    const opts = this.#opts;
    const obs = this.#opts.observability;
    return {
      id,
      async result(): Promise<R> {
        const ttl = opts.resultRetention?.ttlMs ?? DEFAULT_RESULT_TTL;
        const giveUpAfter = Date.now() + Math.max(deadlineEpochMs - Date.now() + ttl, ttl);
        for (;;) {
          if (Date.now() > giveUpAfter) throw new ResultExpiredError(id);
          const r = await stub.result(id);
          if (r.status === 'done') {
            emitObservabilityEvent(obs, {
              kind: 'scheduler',
              payload: { ts: Date.now(), jobId: id, kind: 'done' },
            });
            return r.value as R;
          }
          if (r.status === 'cancelled') {
            emitObservabilityEvent(obs, {
              kind: 'scheduler',
              payload: { ts: Date.now(), jobId: id, kind: 'cancelled' },
            });
            throw wireToError({ name: 'CancelledError', message: 'Job cancelled' });
          }
          if (r.status === 'failed') {
            const e = r.error ?? { name: 'ExecutionError', message: 'job failed' };
            emitObservabilityEvent(obs, {
              kind: 'scheduler',
              payload: { ts: Date.now(), jobId: id, kind: 'failed', detail: e.message },
            });
            if (e.name === 'ResultExpiredError') throw new ResultExpiredError(id);
            throw wireToError(e);
          }
          // queued / leased / running — long-poll.
          await new Promise((res) => setTimeout(res, jitter(DEFAULT_POLL_INTERVAL_MS)));
        }
      },
      async status(): Promise<JobStatus> {
        const raw = (await stub.status(id)) ?? 'failed';
        // Internal `leased` status is plumbing — surface it as `running`
        // to user code per the JobStatus TSDoc contract.
        return raw === 'leased' ? 'running' : raw;
      },
      async cancel(reason?: string): Promise<void> {
        await stub.cancel(id, reason);
        emitObservabilityEvent(obs, {
          kind: 'scheduler',
          payload: { ts: Date.now(), jobId: id, kind: 'cancelled', detail: reason },
        });
      },
    };
  }

  /**
   * Cancel every active (queued or leased) job for `tenantId`. Returns
   * the number of jobs cancelled.
   *
   * Useful for multi-tenant SaaS shutdown: revoke a tenant's access and
   * stop their pending work in one call.
   */
  async cancelByTenant(tenantId: string, reason?: string): Promise<number> {
    return this.#stub().cancelByTenant(tenantId, reason);
  }

  /**
   * Long-poll until the SchedulerDO reports `queued === 0` and
   * `leased === 0`. End-of-test convenience.
   */
  async drain(): Promise<void> {
    for (;;) {
      const s = await this.#stub().stats();
      if (s.queued === 0 && s.leased === 0) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Snapshot of scheduler counters (queued / running / done / failed /
   * cancelled), oldest-queued-age, and `resultRetentionTtlMs`.
   * See {@link SchedulerStats}.
   */
  async stats(): Promise<SchedulerStats> {
    const s = await this.#stub().stats();
    return {
      inFlight: s.leased,
      queued: s.queued,
      completed: s.done,
      failed: s.failed,
      cancelled: s.cancelled,
      topology: 'in-do',
      topologyDecisionAt: 0,
      warmIsolatesEstimate: 0,
      uniqueFnShapesToday: 0,
      lruEvictionLast60sCount: 0,
      treeDepth: 1,
      fanOutPerLevel: [],
      byTenant: {},
      oldestQueuedAgeMs: s.oldestQueuedAgeMs,
      resultRetentionTtlMs: this.#opts.resultRetention?.ttlMs ?? DEFAULT_RESULT_TTL,
    };
  }

  /** Hook a Cloudflare Queue's consumer into this scheduler (DESIGN §8.8). */
  attachQueue(_queue: unknown): void {
    // Queue consumer wiring is deployment-time (the user's Worker becomes the
    // queue consumer). This method is a marker for the doctor CLI to
    // recognize the integration; runtime no-op.
    void _queue;
  }

  /**
   * Tune the SchedulerDO's dispatcher knobs at runtime.
   * Returns the effective config after merge.
   *
   * @example
   * await scheduler.configure({ inFlightLimit: 64, fairCapacityPerTenant: 8 });
   */
  async configure(c: SchedulerConfigureInput): Promise<SchedulerConfigSnapshot> {
    const r = await this.#stub().configure(c);
    return r.effective;
  }
}

function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}
