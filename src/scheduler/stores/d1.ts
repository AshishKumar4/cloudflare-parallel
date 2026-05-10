import type { JobStatus } from '../../api/options.js';
import type { ClaimRequest, JobEvent, JobStore, PersistedJob } from '../job-store.js';

/**
 * D1 (SQL over HTTP/RPC) adapter — minimal implementation that mirrors the
 * DO-storage schema and CAS predicates. Use only for very low-throughput,
 * admin-heavy workloads; default is `do-storage`.
 */
export class D1JobStore implements JobStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async init(): Promise<void> {
    await this.#db.exec(
      `CREATE TABLE IF NOT EXISTS cfp_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        fn_hash TEXT NOT NULL,
        fn_source TEXT NOT NULL,
        args TEXT NOT NULL,
        context TEXT,
        meta TEXT,
        created_at INTEGER NOT NULL,
        deadline_ms INTEGER NOT NULL,
        retry_max INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        retry_base_ms INTEGER NOT NULL,
        retry_backoff TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_ms INTEGER,
        result TEXT,
        result_expires_ms INTEGER,
        error TEXT,
        idempotency_key TEXT UNIQUE
      )`,
    );
  }

  async enqueue(job: PersistedJob): Promise<void> {
    try {
      await this.#db
        .prepare(
          `INSERT INTO cfp_jobs (
            id, tenant_id, fn_hash, fn_source, args, context, meta,
            created_at, deadline_ms, retry_max, retry_count, retry_base_ms, retry_backoff,
            status, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .bind(
          job.id,
          job.tenantId,
          job.fnHash,
          job.fnSource,
          JSON.stringify(job.args),
          job.context ? JSON.stringify(job.context) : null,
          job.meta ? JSON.stringify(job.meta) : null,
          job.createdAt,
          job.deadlineEpochMs,
          job.retry.max,
          job.retryCount,
          job.retry.baseMs,
          job.retry.backoff,
          job.idempotencyKey ?? null,
        )
        .run();
    } catch (err) {
      if (job.idempotencyKey && /UNIQUE/i.test(String((err as Error).message))) return;
      throw err;
    }
  }

  async claim(req: ClaimRequest): Promise<PersistedJob[]> {
    // D1 transactions are limited; do one CAS at a time. Best for low volume.
    const now = Date.now();
    const expires = now + req.leaseMs;
    const candidates = req.jobId
      ? (
          await this.#db
            .prepare(
              `SELECT * FROM cfp_jobs
                WHERE id = ?
                  AND status IN ('queued','leased')
                  AND (status = 'queued' OR lease_expires_ms < ?)
                  AND deadline_ms > ?
                LIMIT 1`,
            )
            .bind(req.jobId, now, now)
            .all<D1Row>()
        ).results
      : (
          await this.#db
            .prepare(
              `SELECT * FROM cfp_jobs
                WHERE status IN ('queued','leased')
                  AND (status = 'queued' OR lease_expires_ms < ?)
                  AND deadline_ms > ?
                ORDER BY status DESC, created_at ASC
                LIMIT ?`,
            )
            .bind(now, now, req.max)
            .all<D1Row>()
        ).results;

    const claimed: PersistedJob[] = [];
    for (const row of candidates) {
      const r = await this.#db
        .prepare(
          `UPDATE cfp_jobs
              SET status = 'leased', lease_owner = ?, lease_expires_ms = ?
            WHERE id = ?
              AND ((status = 'queued') OR (status = 'leased' AND lease_expires_ms < ?))`,
        )
        .bind(req.workerId, expires, row.id, now)
        .run();
      if (r.success && r.meta?.changes && r.meta.changes > 0) {
        claimed.push(
          rowToJob({
            ...row,
            status: 'leased',
            lease_owner: req.workerId,
            lease_expires_ms: expires,
          }),
        );
      }
    }
    return claimed;
  }

  async ack(
    jobId: string,
    leaseOwner: string,
    result: unknown,
    resultExpiresMs: number,
  ): Promise<boolean> {
    const r = await this.#db
      .prepare(
        `UPDATE cfp_jobs SET status='done', result=?, result_expires_ms=? WHERE id=? AND status='leased' AND lease_owner=?`,
      )
      .bind(JSON.stringify(result), resultExpiresMs, jobId, leaseOwner)
      .run();
    return Boolean(r.success && r.meta?.changes && r.meta.changes > 0);
  }

  async fail(
    jobId: string,
    leaseOwner: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<JobStatus> {
    const r = await this.#db
      .prepare(
        `UPDATE cfp_jobs
            SET status = CASE WHEN retry_count + 1 >= retry_max THEN 'failed' ELSE 'queued' END,
                retry_count = retry_count + 1,
                lease_owner = NULL,
                lease_expires_ms = NULL,
                error = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
      )
      .bind(JSON.stringify(error), jobId, leaseOwner)
      .run();
    if (!r.success) return 'leased';
    const status = (await this.status(jobId)) ?? 'leased';
    return status;
  }

  async failQueued(
    jobId: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<boolean> {
    const r = await this.#db
      .prepare(
        `UPDATE cfp_jobs SET status='failed', error=?, retry_count=retry_max WHERE id=? AND status='queued'`,
      )
      .bind(JSON.stringify(error), jobId)
      .run();
    return Boolean(r.success && r.meta?.changes && r.meta.changes > 0);
  }

  async cancel(jobId: string, _reason?: string): Promise<boolean> {
    const r = await this.#db
      .prepare(
        `UPDATE cfp_jobs SET status='cancelled' WHERE id=? AND status IN ('queued','leased')`,
      )
      .bind(jobId)
      .run();
    return Boolean(r.success && r.meta?.changes && r.meta.changes > 0);
  }

  async status(jobId: string): Promise<JobStatus | null> {
    const r = await this.#db
      .prepare(`SELECT status FROM cfp_jobs WHERE id = ?`)
      .bind(jobId)
      .first<{ status: JobStatus }>();
    return r?.status ?? null;
  }

  async result(
    jobId: string,
  ): Promise<{
    status: JobStatus;
    value?: unknown;
    error?: { name: string; message: string; stack?: string };
  }> {
    const row = await this.#db
      .prepare(`SELECT status, result, error, result_expires_ms FROM cfp_jobs WHERE id = ?`)
      .bind(jobId)
      .first<{
        status: JobStatus;
        result: string | null;
        error: string | null;
        result_expires_ms: number | null;
      }>();
    if (!row)
      return {
        status: 'failed',
        error: { name: 'NotFoundError', message: `Job ${jobId} not found` },
      };
    if (row.status === 'done') {
      if (row.result_expires_ms && row.result_expires_ms < Date.now()) {
        return {
          status: 'failed',
          error: { name: 'ResultExpiredError', message: `Job ${jobId} result expired` },
        };
      }
      return { status: 'done', value: row.result ? JSON.parse(row.result) : undefined };
    }
    if (row.status === 'failed') {
      return { status: 'failed', error: row.error ? JSON.parse(row.error) : undefined };
    }
    return { status: row.status };
  }

  async peek(opts: { tenantId?: string; limit: number }): Promise<PersistedJob[]> {
    const stmt = opts.tenantId
      ? this.#db
          .prepare(
            `SELECT * FROM cfp_jobs WHERE status='queued' AND tenant_id=? ORDER BY created_at ASC LIMIT ?`,
          )
          .bind(opts.tenantId, opts.limit)
      : this.#db
          .prepare(`SELECT * FROM cfp_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT ?`)
          .bind(opts.limit);
    return (await stmt.all<D1Row>()).results.map(rowToJob);
  }

  async sweepExpired(now: number): Promise<number> {
    const r = await this.#db
      .prepare(
        `DELETE FROM cfp_jobs WHERE status='done' AND result_expires_ms IS NOT NULL AND result_expires_ms < ?`,
      )
      .bind(now)
      .run();
    return Number(r.meta?.changes ?? 0);
  }

  async reclaimExpiredLeases(now: number): Promise<number> {
    const r = await this.#db
      .prepare(
        `UPDATE cfp_jobs SET status='queued', lease_owner=NULL, lease_expires_ms=NULL WHERE status='leased' AND lease_expires_ms<?`,
      )
      .bind(now)
      .run();
    return Number(r.meta?.changes ?? 0);
  }

  async listActiveByTenant(tenantId: string): Promise<PersistedJob[]> {
    const r = await this.#db
      .prepare(
        `SELECT * FROM cfp_jobs WHERE tenant_id=? AND status IN ('queued','leased') ORDER BY created_at ASC`,
      )
      .bind(tenantId)
      .all<D1Row>();
    return r.results.map(rowToJob);
  }

  // eslint-disable-next-line require-yield -- D1 adapter intentionally has no events log
  async *events(): AsyncIterable<JobEvent> {
    // D1 adapter does not maintain an events log (cost). Empty stream.
    return;
  }
}

interface D1Row {
  id: string;
  tenant_id: string;
  fn_hash: string;
  fn_source: string;
  args: string;
  context: string | null;
  meta: string | null;
  created_at: number;
  deadline_ms: number;
  retry_max: number;
  retry_count: number;
  retry_base_ms: number;
  retry_backoff: string;
  status: JobStatus;
  lease_owner: string | null;
  lease_expires_ms: number | null;
  result: string | null;
  result_expires_ms: number | null;
  error: string | null;
  idempotency_key: string | null;
}

function rowToJob(row: D1Row): PersistedJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fnHash: row.fn_hash,
    fnSource: row.fn_source,
    args: JSON.parse(row.args),
    context: row.context ? JSON.parse(row.context) : undefined,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
    createdAt: row.created_at,
    deadlineEpochMs: row.deadline_ms,
    retry: {
      max: row.retry_max,
      backoff: row.retry_backoff as 'exponential' | 'linear' | 'constant',
      baseMs: row.retry_base_ms,
    },
    retryCount: row.retry_count,
    status: row.status,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresMs: row.lease_expires_ms ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    resultExpiresMs: row.result_expires_ms ?? undefined,
    error: row.error ? JSON.parse(row.error) : undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}
