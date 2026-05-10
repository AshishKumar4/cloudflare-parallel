import type { JobStatus } from '../../api/options';
import type { ClaimRequest, JobEvent, JobStore, PersistedJob } from '../job-store';

interface CFQueue<T = unknown> {
  send(message: T, opts?: { delaySeconds?: number }): Promise<void>;
}

/**
 * Cloudflare Queues adapter.
 *
 * The Queues backend is for users who already operate a Queue and want to
 * enqueue jobs externally OR want a real DLQ. Result observability still
 * requires a small DO-storage shadow table for `JobHandle.result()` long-poll.
 *
 * This adapter delegates **persistence + result lookup** to a wrapped
 * `DoStorageJobStore` and **delivery** to the Queue. Claim is a no-op (the
 * Queue's consumer Worker dispatches; the SchedulerDO just bookkeeps).
 *
 * Use `Scheduler.attachQueue(env.MY_QUEUE)` to wire one.
 */
export class QueuesJobStore implements JobStore {
  readonly #queue: CFQueue<PersistedJob>;
  readonly #shadow: JobStore;

  constructor(queue: CFQueue<PersistedJob>, shadow: JobStore) {
    this.#queue = queue;
    this.#shadow = shadow;
  }

  async enqueue(job: PersistedJob): Promise<void> {
    await this.#shadow.enqueue(job);
    await this.#queue.send(job);
  }

  // The Queue consumer drives execution; SchedulerDO doesn't claim.
  async claim(_req: ClaimRequest): Promise<PersistedJob[]> {
    return [];
  }

  ack(
    jobId: string,
    leaseOwner: string,
    result: unknown,
    resultExpiresMs: number,
  ): Promise<boolean> {
    return this.#shadow.ack(jobId, leaseOwner, result, resultExpiresMs);
  }

  fail(
    jobId: string,
    leaseOwner: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<JobStatus> {
    return this.#shadow.fail(jobId, leaseOwner, error);
  }

  cancel(jobId: string, reason?: string): Promise<boolean> {
    return this.#shadow.cancel(jobId, reason);
  }

  failQueued(
    jobId: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<boolean> {
    return this.#shadow.failQueued(jobId, error);
  }

  status(jobId: string): Promise<JobStatus | null> {
    return this.#shadow.status(jobId);
  }

  result(
    jobId: string,
  ): Promise<{
    status: JobStatus;
    value?: unknown;
    error?: { name: string; message: string; stack?: string };
  }> {
    return this.#shadow.result(jobId);
  }

  peek(opts: { tenantId?: string; limit: number }): Promise<PersistedJob[]> {
    return this.#shadow.peek(opts);
  }

  sweepExpired(now: number): Promise<number> {
    return this.#shadow.sweepExpired(now);
  }

  reclaimExpiredLeases(_now: number): Promise<number> {
    // Queues handles lease/visibility-timeouts on its own; no-op here.
    return Promise.resolve(0);
  }

  listActiveByTenant(tenantId: string): Promise<PersistedJob[]> {
    return this.#shadow.listActiveByTenant(tenantId);
  }

  events(opts?: { since?: number; limit?: number }): AsyncIterable<JobEvent> {
    return this.#shadow.events(opts);
  }
}
