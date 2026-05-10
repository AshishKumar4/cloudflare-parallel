/**
 * In-memory `JobStore` for tests/benches. Faithful to the CAS contract:
 * claims only succeed if status='queued' (or lease expired); ack/fail
 * only if the caller still owns the lease.
 *
 * NOT used in production — production uses {@link DoStorageJobStore}.
 */
import type { JobStatus } from '../../src/api/options.js';
import type {
  ClaimRequest,
  JobEvent,
  JobStore,
  PersistedJob,
} from '../../src/scheduler/job-store.js';

export class MemoryJobStore implements JobStore {
  readonly jobs = new Map<string, PersistedJob>();
  readonly events: JobEvent[] = [];

  async enqueue(job: PersistedJob): Promise<void> {
    if (job.idempotencyKey) {
      for (const existing of this.jobs.values()) {
        if (existing.idempotencyKey === job.idempotencyKey) return;
      }
    }
    this.jobs.set(job.id, { ...job });
    this.events.push({ ts: Date.now(), jobId: job.id, kind: 'enqueued' });
  }

  async claim(req: ClaimRequest): Promise<PersistedJob[]> {
    const now = Date.now();
    const eligible = (j: PersistedJob): boolean =>
      j.deadlineEpochMs > now &&
      (j.status === 'queued' || (j.status === 'leased' && (j.leaseExpiresMs ?? 0) < now));
    let candidates: PersistedJob[];
    if (req.jobId) {
      const j = this.jobs.get(req.jobId);
      candidates = j && eligible(j) ? [j] : [];
    } else {
      candidates = [...this.jobs.values()]
        .filter(eligible)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, req.max);
    }
    const out: PersistedJob[] = [];
    for (const j of candidates) {
      j.status = 'leased';
      j.leaseOwner = req.workerId;
      j.leaseExpiresMs = now + req.leaseMs;
      out.push({ ...j });
    }
    return out;
  }

  async ack(
    jobId: string,
    leaseOwner: string,
    result: unknown,
    resultExpiresMs: number,
  ): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'leased' || j.leaseOwner !== leaseOwner) return false;
    j.status = 'done';
    j.result = result;
    j.resultExpiresMs = resultExpiresMs;
    this.events.push({ ts: Date.now(), jobId, kind: 'done' });
    return true;
  }

  async fail(
    jobId: string,
    leaseOwner: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<JobStatus> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'leased' || j.leaseOwner !== leaseOwner) return 'leased';
    j.retryCount += 1;
    j.error = error;
    j.leaseOwner = undefined;
    j.leaseExpiresMs = undefined;
    if (j.retryCount >= j.retry.max) {
      j.status = 'failed';
      this.events.push({ ts: Date.now(), jobId, kind: 'failed' });
      return 'failed';
    }
    j.status = 'queued';
    this.events.push({ ts: Date.now(), jobId, kind: 'retrying' });
    return 'queued';
  }

  async failQueued(
    jobId: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'queued') return false;
    j.status = 'failed';
    j.error = error;
    j.retryCount = j.retry.max;
    this.events.push({ ts: Date.now(), jobId, kind: 'failed' });
    return true;
  }

  async cancel(jobId: string, _reason?: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || (j.status !== 'queued' && j.status !== 'leased')) return false;
    j.status = 'cancelled';
    this.events.push({ ts: Date.now(), jobId, kind: 'cancelled' });
    return true;
  }

  async status(jobId: string): Promise<JobStatus | null> {
    return this.jobs.get(jobId)?.status ?? null;
  }

  async result(jobId: string): Promise<{
    status: JobStatus;
    value?: unknown;
    error?: { name: string; message: string; stack?: string };
  }> {
    const j = this.jobs.get(jobId);
    if (!j) return { status: 'failed', error: { name: 'NotFoundError', message: 'unknown' } };
    if (j.status === 'done') return { status: 'done', value: j.result };
    if (j.status === 'failed') return { status: 'failed', error: j.error };
    return { status: j.status };
  }

  async peek(opts: { tenantId?: string; limit: number }): Promise<PersistedJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'queued' && (!opts.tenantId || j.tenantId === opts.tenantId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, opts.limit)
      .map((j) => ({ ...j }));
  }

  async sweepExpired(now: number): Promise<number> {
    let n = 0;
    for (const [id, j] of this.jobs) {
      if (j.status === 'done' && j.resultExpiresMs && j.resultExpiresMs < now) {
        this.jobs.delete(id);
        n++;
      }
    }
    return n;
  }

  async reclaimExpiredLeases(now: number): Promise<number> {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'leased' && (j.leaseExpiresMs ?? 0) < now) {
        j.status = 'queued';
        j.leaseOwner = undefined;
        j.leaseExpiresMs = undefined;
        n++;
      }
    }
    return n;
  }

  async listActiveByTenant(tenantId: string): Promise<PersistedJob[]> {
    return [...this.jobs.values()]
      .filter(
        (j) => j.tenantId === tenantId && (j.status === 'queued' || j.status === 'leased'),
      )
      .map((j) => ({ ...j }));
  }

  async *events_(_opts?: { since?: number; limit?: number }): AsyncIterable<JobEvent> {
    for (const e of this.events) yield e;
  }

  events(opts?: { since?: number; limit?: number }): AsyncIterable<JobEvent> {
    return this.events_(opts);
  }
}
