import type { JobStatus } from '../../api/options';
import type { ClaimRequest, JobEvent, JobStore, PersistedJob } from '../job-store';

const SCHEMA_VERSION = 2;

/**
 * Default JobStore: the SchedulerDO's own SQLite storage.
 *
 * All state transitions are CAS-shaped via WHERE predicates that match the
 * expected current status. Within a single SchedulerDO method invocation,
 * SQL writes without intervening awaits are coalesced atomically by the
 * runtime (see DESIGN §2.2 / §8.9 contract).
 */
export class DoStorageJobStore implements JobStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#init();
  }

  #init(): void {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS cfp_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    const row = [...this.#sql.exec(`SELECT value FROM cfp_meta WHERE key = 'schema'`)] as Array<{
      value: string;
    }>;
    const currentSchema = row.length > 0 ? Number(row[0].value) : 0;
    if (row.length === 0) {
      this.#sql.exec(
        `INSERT INTO cfp_meta(key, value) VALUES ('schema', ?)`,
        String(SCHEMA_VERSION),
      );
    }
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      fn_hash TEXT NOT NULL,
      fn_source TEXT NOT NULL,
      args BLOB NOT NULL,
      context BLOB,
      meta TEXT,
      created_at INTEGER NOT NULL,
      deadline_ms INTEGER NOT NULL,
      retry_max INTEGER NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_base_ms INTEGER NOT NULL,
      retry_backoff TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','leased','done','failed','cancelled')),
      lease_owner TEXT,
      lease_expires_ms INTEGER,
      result BLOB,
      result_expires_ms INTEGER,
      error TEXT,
      idempotency_key TEXT UNIQUE,
      cache_key_strategy TEXT
    )`);
    // Migration: schema v1 → v2 adds cache_key_strategy column.
    // SQLite ALTER TABLE ... ADD COLUMN is idempotent for existing
    // deployments — column is nullable and defaults to NULL (which
    // the runtime treats as `'stable'`).
    if (currentSchema > 0 && currentSchema < 2) {
      try {
        this.#sql.exec(`ALTER TABLE jobs ADD COLUMN cache_key_strategy TEXT`);
      } catch {
        // Column already exists (race or partial migration); fine.
      }
      this.#sql.exec(`UPDATE cfp_meta SET value = ? WHERE key = 'schema'`, String(SCHEMA_VERSION));
    }
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS jobs_status_tenant_created ON jobs(status, tenant_id, created_at)`,
    );
    this.#sql.exec(`CREATE INDEX IF NOT EXISTS jobs_status_deadline ON jobs(status, deadline_ms)`);
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS jobs_lease_expiry ON jobs(status, lease_expires_ms)`,
    );
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS events (
      ts INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (ts, job_id, kind)
    )`);
  }

  async enqueue(job: PersistedJob): Promise<void> {
    const args = enc(job.args);
    const ctx = job.context ? enc(job.context) : null;
    const meta = job.meta ? JSON.stringify(job.meta) : null;
    try {
      this.#sql.exec(
        `INSERT INTO jobs (
          id, tenant_id, fn_hash, fn_source, args, context, meta,
          created_at, deadline_ms, retry_max, retry_count, retry_base_ms, retry_backoff,
          status, idempotency_key, cache_key_strategy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        job.id,
        job.tenantId,
        job.fnHash,
        job.fnSource,
        args,
        ctx,
        meta,
        job.createdAt,
        job.deadlineEpochMs,
        job.retry.max,
        job.retryCount,
        job.retry.baseMs,
        job.retry.backoff,
        job.idempotencyKey ?? null,
        job.cacheKeyStrategy ?? null,
      );
      this.#emit(job.id, 'enqueued');
    } catch (err) {
      // UNIQUE(idempotency_key) collision = job already enqueued; idempotent.
      if (job.idempotencyKey && /UNIQUE/i.test(String((err as Error).message))) {
        return;
      }
      throw err;
    }
  }

  async claim(req: ClaimRequest): Promise<PersistedJob[]> {
    const now = Date.now();
    const expires = now + req.leaseMs;
    const candidates = req.jobId
      ? [
          ...this.#sql.exec<JobsRow>(
            `SELECT * FROM jobs
              WHERE id = ?
                AND status IN ('queued','leased')
                AND (status = 'queued' OR lease_expires_ms < ?)
                AND deadline_ms > ?
              LIMIT 1`,
            req.jobId,
            now,
            now,
          ),
        ]
      : [
          ...this.#sql.exec<JobsRow>(
            `SELECT * FROM jobs
              WHERE status IN ('queued','leased')
                AND (status = 'queued' OR lease_expires_ms < ?)
                AND deadline_ms > ?
              ORDER BY status DESC, created_at ASC
              LIMIT ?`,
            now,
            now,
            req.max,
          ),
        ];
    const claimed: PersistedJob[] = [];
    for (const row of candidates) {
      const cursor = [
        ...this.#sql.exec(
          `UPDATE jobs
              SET status = 'leased', lease_owner = ?, lease_expires_ms = ?
            WHERE id = ?
              AND ((status = 'queued') OR (status = 'leased' AND lease_expires_ms < ?))
          RETURNING id`,
          req.workerId,
          expires,
          row.id,
          now,
        ),
      ];
      if (cursor.length > 0) {
        claimed.push(
          rowToJob({
            ...row,
            status: 'leased',
            lease_owner: req.workerId,
            lease_expires_ms: expires,
          }),
        );
        this.#emit(row.id, 'leased');
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
    const cursor = [
      ...this.#sql.exec(
        `UPDATE jobs
            SET status = 'done', result = ?, result_expires_ms = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
        RETURNING id`,
        enc(result),
        resultExpiresMs,
        jobId,
        leaseOwner,
      ),
    ];
    if (cursor.length > 0) {
      this.#emit(jobId, 'done');
      return true;
    }
    return false;
  }

  async fail(
    jobId: string,
    leaseOwner: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<JobStatus> {
    const cursor = [
      ...this.#sql.exec<{ status: JobStatus }>(
        `UPDATE jobs
            SET status = CASE WHEN retry_count + 1 >= retry_max THEN 'failed' ELSE 'queued' END,
                retry_count = retry_count + 1,
                lease_owner = NULL,
                lease_expires_ms = NULL,
                error = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
        RETURNING status`,
        JSON.stringify(error),
        jobId,
        leaseOwner,
      ),
    ];
    if (cursor.length === 0) return 'leased';
    const next = cursor[0].status;
    this.#emit(jobId, next === 'failed' ? 'failed' : 'retrying');
    return next;
  }

  async failQueued(
    jobId: string,
    error: { name: string; message: string; stack?: string },
  ): Promise<boolean> {
    const cursor = [
      ...this.#sql.exec(
        `UPDATE jobs
            SET status = 'failed', error = ?, retry_count = retry_max
          WHERE id = ? AND status = 'queued'
        RETURNING id`,
        JSON.stringify(error),
        jobId,
      ),
    ];
    if (cursor.length > 0) {
      this.#emit(jobId, 'failed');
      return true;
    }
    return false;
  }

  async cancel(jobId: string, reason?: string): Promise<boolean> {
    const cursor = [
      ...this.#sql.exec(
        `UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status IN ('queued','leased') RETURNING id`,
        jobId,
      ),
    ];
    if (cursor.length > 0) {
      this.#emit(jobId, 'cancelled', reason);
      return true;
    }
    return false;
  }

  async status(jobId: string): Promise<JobStatus | null> {
    const cursor = [
      ...this.#sql.exec<{ status: JobStatus }>(`SELECT status FROM jobs WHERE id = ?`, jobId),
    ];
    return cursor[0]?.status ?? null;
  }

  async result(jobId: string): Promise<{
    status: JobStatus;
    value?: unknown;
    error?: { name: string; message: string; stack?: string };
  }> {
    const cursor = [
      ...this.#sql.exec<{
        status: JobStatus;
        result: ArrayBuffer | null;
        error: string | null;
        result_expires_ms: number | null;
      }>(`SELECT status, result, error, result_expires_ms FROM jobs WHERE id = ?`, jobId),
    ];
    if (cursor.length === 0) {
      return {
        status: 'failed',
        error: { name: 'NotFoundError', message: `Job ${jobId} not found (or result expired)` },
      };
    }
    const row = cursor[0];
    if (row.status === 'done') {
      if (row.result_expires_ms && row.result_expires_ms < Date.now()) {
        return {
          status: 'failed',
          error: { name: 'ResultExpiredError', message: `Job ${jobId} result expired` },
        };
      }
      return { status: 'done', value: row.result ? dec(row.result) : undefined };
    }
    if (row.status === 'failed') {
      return { status: 'failed', error: row.error ? JSON.parse(row.error) : undefined };
    }
    return { status: row.status };
  }

  async peek(opts: { tenantId?: string; limit: number }): Promise<PersistedJob[]> {
    const sql = opts.tenantId
      ? `SELECT * FROM jobs WHERE status='queued' AND tenant_id = ? ORDER BY created_at ASC LIMIT ?`
      : `SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT ?`;
    const args = opts.tenantId ? [opts.tenantId, opts.limit] : [opts.limit];
    const rows = [...this.#sql.exec<JobsRow>(sql, ...args)];
    return rows.map(rowToJob);
  }

  async sweepExpired(now: number): Promise<number> {
    const cursor = [
      ...this.#sql.exec(
        `DELETE FROM jobs WHERE status='done' AND result_expires_ms IS NOT NULL AND result_expires_ms < ? RETURNING id`,
        now,
      ),
    ];
    return cursor.length;
  }

  async reclaimExpiredLeases(now: number): Promise<number> {
    const cursor = [
      ...this.#sql.exec(
        `UPDATE jobs
            SET status = 'queued', lease_owner = NULL, lease_expires_ms = NULL
          WHERE status = 'leased' AND lease_expires_ms < ?
        RETURNING id`,
        now,
      ),
    ];
    return cursor.length;
  }

  async listActiveByTenant(tenantId: string): Promise<PersistedJob[]> {
    const rows = [
      ...this.#sql.exec<JobsRow>(
        `SELECT * FROM jobs WHERE tenant_id = ? AND status IN ('queued','leased') ORDER BY created_at ASC`,
        tenantId,
      ),
    ];
    return rows.map(rowToJob);
  }

  async *events(opts?: { since?: number; limit?: number }): AsyncIterable<JobEvent> {
    const since = opts?.since ?? 0;
    const limit = opts?.limit ?? 100;
    const rows = [
      ...this.#sql.exec<{
        ts: number;
        job_id: string;
        kind: JobEvent['kind'];
        detail: string | null;
      }>(
        `SELECT ts, job_id, kind, detail FROM events WHERE ts > ? ORDER BY ts ASC LIMIT ?`,
        since,
        limit,
      ),
    ];
    for (const r of rows) {
      yield { ts: r.ts, jobId: r.job_id, kind: r.kind, detail: r.detail ?? undefined };
    }
  }

  // ---- private --------------------------------------------------------

  #emit(jobId: string, kind: JobEvent['kind'], detail?: string): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO events(ts, job_id, kind, detail) VALUES (?, ?, ?, ?)`,
      Date.now(),
      jobId,
      kind,
      detail ?? null,
    );
  }
}

// ---- helpers ----------------------------------------------------------

/**
 * Mirrors the `jobs` table. SqlStorageValue is `ArrayBuffer | string | number
 * | null`, so this conforms to `Record<string, SqlStorageValue>` modulo the
 * narrower fields (which is allowed by structural assignment).
 */
type JobsRow = {
  [k: string]: SqlStorageValue;
} & {
  id: string;
  tenant_id: string;
  fn_hash: string;
  fn_source: string;
  args: ArrayBuffer;
  context: ArrayBuffer | null;
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
  result: ArrayBuffer | null;
  result_expires_ms: number | null;
  error: string | null;
  idempotency_key: string | null;
  cache_key_strategy: string | null;
};

function rowToJob(row: JobsRow): PersistedJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fnHash: row.fn_hash,
    fnSource: row.fn_source,
    args: dec(row.args) as unknown[],
    context: row.context ? (dec(row.context) as Record<string, unknown>) : undefined,
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
    result: row.result ? dec(row.result) : undefined,
    resultExpiresMs: row.result_expires_ms ?? undefined,
    error: row.error ? JSON.parse(row.error) : undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    cacheKeyStrategy: row.cache_key_strategy
      ? (row.cache_key_strategy as 'stable' | 'fresh' | 'auto')
      : undefined,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function enc(value: unknown): ArrayBuffer {
  // Plain JSON serialization. Structured-clone-of-args-via-JSON is lossy
  // for some values (Map/Set/Date/etc.) — Scheduler users are warned to
  // pass plain JSON-friendly args. Stricter via canonicalize for context.
  const str = JSON.stringify(value);
  const bytes = encoder.encode(str ?? 'null');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function dec(buf: ArrayBuffer | Uint8Array): unknown {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return JSON.parse(decoder.decode(view));
}
