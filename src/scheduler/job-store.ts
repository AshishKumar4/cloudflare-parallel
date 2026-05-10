import type { JobStatus, RetryPolicy } from '../api/options';

export interface PersistedJob {
  id: string;
  tenantId: string;
  fnHash: string;
  fnSource: string;
  args: unknown[];
  context?: Record<string, unknown>;
  meta?: Record<string, string>;
  createdAt: number;
  /** Absolute deadline epoch ms. */
  deadlineEpochMs: number;
  retry: RetryPolicy;
  retryCount: number;
  status: JobStatus;
  leaseOwner?: string;
  leaseExpiresMs?: number;
  result?: unknown;
  resultExpiresMs?: number;
  error?: { name: string; message: string; stack?: string };
  idempotencyKey?: string;
}

export interface JobEvent {
  ts: number;
  jobId: string;
  kind: 'enqueued' | 'leased' | 'done' | 'failed' | 'cancelled' | 'retrying' | 'expired';
  detail?: string;
}

export interface ClaimRequest {
  workerId: string;
  max: number;
  /** Lease duration in ms — caller must ack/fail/cancel before this elapses. */
  leaseMs: number;
  /**
   * If set, claim only the job with this id (still CAS-gated on
   * status='queued' or expired-lease). Used by the dispatcher when it has
   * already picked a specific job from its in-memory ready set via
   * fair-queueing — claiming "the oldest" via FIFO would race with the
   * fair-order pick.
   */
  jobId?: string;
}

/**
 * Pluggable job persistence. The DO-storage default is the canonical impl;
 * `queues` and `d1` are opt-in adapters (DESIGN §8.8).
 *
 * All transitions MUST be CAS-shaped — only succeed if the row is in the
 * expected state. Idempotent on retries (DESIGN §8.9 / ADR-9).
 */
export interface JobStore {
  enqueue(job: PersistedJob): Promise<void>;
  /** Atomic CAS claim. Returns leased jobs (status flipped queued→leased). */
  claim(req: ClaimRequest): Promise<PersistedJob[]>;
  /** Atomic CAS ack. Returns false if lease was lost. */
  ack(
    jobId: string,
    leaseOwner: string,
    result: unknown,
    resultExpiresMs: number,
  ): Promise<boolean>;
  /** Atomic CAS fail; advances retryCount or marks failed. Returns next status. */
  fail(
    jobId: string,
    leaseOwner: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<JobStatus>;
  /** Idempotent transition to cancelled (queued or leased only). */
  cancel(jobId: string, reason?: string): Promise<boolean>;
  /**
   * Idempotent transition queued→failed for non-retryable terminal errors
   * (deadline exceeded, schema validation). Bypasses lease ownership.
   */
  failQueued(
    jobId: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<boolean>;
  status(jobId: string): Promise<JobStatus | null>;
  result(
    jobId: string,
  ): Promise<{
    status: JobStatus;
    value?: unknown;
    error?: { name: string; message: string; stack?: string };
  }>;
  peek(opts: { tenantId?: string; limit: number }): Promise<PersistedJob[]>;
  /** Sweep expired-result rows; returns count. */
  sweepExpired(now: number): Promise<number>;
  /** Sweep expired leases (lease_expires_ms < now AND status='leased'); returns count. */
  reclaimExpiredLeases(now: number): Promise<number>;
  /** All jobs for a tenant in a non-terminal state; for cancelByTenant. */
  listActiveByTenant(tenantId: string): Promise<PersistedJob[]>;
  events(opts?: { since?: number; limit?: number }): AsyncIterable<JobEvent>;
}
