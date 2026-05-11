import { DurableObject } from 'cloudflare:workers';
import type { WorkerLoader } from '../types';
import { LoaderRunner } from '../loader/runner';
import { DoStorageJobStore } from './stores/do-storage';
import type { JobStore, PersistedJob } from './job-store';
import { type DispatchEnvelope, type RunOneRequest } from '../coordinator/protocol';
import type { JobStatus, RetryPolicy } from '../api/options';
import {
  Dispatcher,
  DEFAULT_DISPATCHER_CONFIG,
  type DispatcherConfig,
} from './dispatcher';

const ALARM_SWEEP_MS = 5_000;
const IDLE_ALARM_MS = 60_000;

/**
 * `CfpSchedulerDO` — DO shim wiring the pure {@link Dispatcher} core to
 * SQLite storage + a `LoaderRunner`-backed job runner.
 *
 * Architecture (replaces the v0.2 alarm-batched dispatch):
 *
 * - Storage (DO SQLite, via {@link DoStorageJobStore}) is canonical.
 * - {@link Dispatcher} owns the in-memory ready/running sets, fair-queueing,
 *   single-flight loop, and reactive re-entry on each settle.
 * - Alarms exist only for retry-after-backoff and result-TTL sweep —
 *   never for primary dispatch.
 *
 * Throughput: the previous alarm-batched model capped at
 * `MAX_BATCH_PER_ALARM / ALARM_SWEEP_MS = 4 / 5s = 0.8 jobs/s`. The
 * reactive design here is bounded by `inFlightLimit` (default 32),
 * which is the max number of jobs the scheduler DO will keep in flight
 * concurrently. Each in-flight job runs in a freshly-loaded isolate on
 * the scheduler DO's V8 thread; jobs cooperatively yield on I/O so 32
 * in-flight is a comfortable working set, but CPU-bound jobs serialize
 * on that one thread. For CPU-heavy workloads, wire the scheduler to
 * `Parallel.pool` and submit map fan-outs — those spread across leaf
 * DOs and scale CPU linearly with leaf count.
 */
export interface SchedulerDOEnv {
  LOADER: WorkerLoader;
}

export interface SchedulerEnqueueRequest {
  id: string;
  tenantId: string;
  fnSource: string;
  fnHash: string;
  args: unknown[];
  context?: Record<string, unknown>;
  deadlineEpochMs: number;
  retry: RetryPolicy;
  meta?: Record<string, string>;
  idempotencyKey?: string;
  workerOptions?: RunOneRequest['workerOptions'];
  cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
}

export class CfpSchedulerDO extends DurableObject<SchedulerDOEnv> {
  #store?: JobStore;
  #dispatcher?: Dispatcher;
  /** True once we've rebuilt ready state from storage on the first call. */
  #initialized = false;
  /** Persisted dispatcher config — applied on dispatcher construction. */
  #configOverrides: Partial<DispatcherConfig> = {};

  // ---------------------------------------------------------- public RPC

  async enqueue(req: SchedulerEnqueueRequest): Promise<{ id: string; queueDepth: number }> {
    await this.#ensureInit();
    const job: PersistedJob = {
      id: req.id,
      tenantId: req.tenantId,
      fnHash: req.fnHash,
      fnSource: req.fnSource,
      args: req.args,
      context: req.context,
      meta: req.meta,
      createdAt: Date.now(),
      deadlineEpochMs: req.deadlineEpochMs,
      retry: req.retry,
      retryCount: 0,
      status: 'queued',
      idempotencyKey: req.idempotencyKey,
    };
    await this.#getDispatcher().enqueue(job);
    return { id: req.id, queueDepth: this.#getDispatcher().totalReady() };
  }

  async status(jobId: string): Promise<JobStatus | null> {
    return this.#getStore().status(jobId);
  }

  async result(jobId: string): Promise<{
    status: JobStatus;
    value?: unknown;
    error?: { name: string; message: string; stack?: string };
  }> {
    return this.#getStore().result(jobId);
  }

  async cancel(jobId: string, reason?: string): Promise<boolean> {
    const ok = await this.#getStore().cancel(jobId, reason);
    if (ok) this.#getDispatcher().dropFromReady(jobId);
    return ok;
  }

  async cancelByTenant(tenantId: string, reason?: string): Promise<number> {
    const store = this.#getStore();
    const active = await store.listActiveByTenant(tenantId);
    let count = 0;
    for (const job of active) {
      if (await store.cancel(job.id, reason)) count++;
    }
    this.#getDispatcher().clearTenant(tenantId);
    return count;
  }

  async stats(): Promise<{
    queued: number;
    running: number;
    done: number;
    failed: number;
    cancelled: number;
    oldestQueuedAgeMs: number;
    inFlightLimit: number;
    maxQueueDepth: number;
  }> {
    const sql = this.#sql();
    const counts = [
      ...sql.exec<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`,
      ),
    ];
    const out = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const row of counts) {
      switch (row.status) {
        case 'queued':
          out.queued = row.n;
          break;
        case 'leased':
          out.running = row.n;
          break;
        case 'done':
          out.done = row.n;
          break;
        case 'failed':
          out.failed = row.n;
          break;
        case 'cancelled':
          out.cancelled = row.n;
          break;
      }
    }
    const [oldest] = [
      ...sql.exec<{ oldest: number | null }>(
        `SELECT MIN(created_at) AS oldest FROM jobs WHERE status='queued'`,
      ),
    ];
    const cfg = this.#getDispatcher().config();
    return {
      ...out,
      oldestQueuedAgeMs: oldest?.oldest ? Date.now() - oldest.oldest : 0,
      inFlightLimit: cfg.inFlightLimit,
      maxQueueDepth: cfg.maxQueueDepth,
    };
  }

  /** Configure the dispatcher knobs. Idempotent; pre-existing settings persist. */
  configure(c: Partial<DispatcherConfig>): { effective: DispatcherConfig } {
    this.#configOverrides = { ...this.#configOverrides, ...c };
    if (this.#dispatcher) this.#dispatcher.configure(c);
    return { effective: this.#dispatcher?.config() ?? { ...DEFAULT_DISPATCHER_CONFIG, ...c } };
  }

  // ---------------------------------------------------------- alarm sweep

  override async alarm(): Promise<void> {
    await this.#ensureInit();
    const store = this.#getStore();
    const dispatcher = this.#getDispatcher();
    const now = Date.now();

    // 1. Reclaim expired leases — push back to ready.
    const reclaimed = await store.reclaimExpiredLeases(now);
    if (reclaimed > 0) {
      await dispatcher.rebuildFromStorage();
    }
    // 2. Sweep done-rows whose result TTL has elapsed.
    await store.sweepExpired(now);
    // 3. Backstop: if we're saturated (ready+running ≥ inFlightLimit),
    //    skip the rebuild — there's no slot for new ready entries to fill.
    //    Otherwise rebuild to pick up any retry-backoff'd jobs that the
    //    in-DO setTimeout missed (cross-restart durability).
    const cfg = dispatcher.config();
    const saturated =
      dispatcher.totalReady() + dispatcher.runningCount() >= cfg.inFlightLimit;
    if (!saturated) {
      await dispatcher.rebuildFromStorage();
    }
    // 4. Kick the dispatch loop in case ready is non-empty.
    dispatcher.kick();
    // 5. Schedule the next alarm: short while busy, long while idle.
    const nextDelay =
      dispatcher.totalReady() + dispatcher.runningCount() > 0 ? ALARM_SWEEP_MS : IDLE_ALARM_MS;
    await this.ctx.storage.setAlarm(now + nextDelay);
  }

  // ---------------------------------------------------------- internals

  async #ensureInit(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    await this.#getDispatcher().rebuildFromStorage();
  }

  #sql(): SqlStorage {
    const sql = (this.ctx.storage as unknown as { sql: SqlStorage }).sql;
    if (!sql) {
      throw new Error(
        'CfpSchedulerDO requires SQLite-backed DO storage. Add ' +
          '`new_sqlite_classes = ["CfpSchedulerDO"]` to your wrangler.toml [[migrations]] tag.',
      );
    }
    return sql;
  }

  #getStore(): JobStore {
    if (!this.#store) this.#store = new DoStorageJobStore(this.#sql());
    return this.#store;
  }

  #getDispatcher(): Dispatcher {
    if (!this.#dispatcher) {
      this.#dispatcher = new Dispatcher({
        store: this.#getStore(),
        ownerId: `sched-${this.ctx.id.toString()}`,
        config: this.#configOverrides,
        runJob: (job) => this.#runJob(job),
        hooks: {
          onScheduleRetry: (delayMs) => {
            // Backstop alarm — only if no nearer alarm already pending.
            void this.#scheduleAlarmAt(Date.now() + delayMs);
          },
          onWorkScheduled: (p) => {
            // Extend DO lifetime past response return.
            this.ctx.waitUntil(p.catch(() => undefined));
          },
        },
      });
    }
    return this.#dispatcher;
  }

  async #scheduleAlarmAt(wakeAt: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (!existing || existing > wakeAt) {
      await this.ctx.storage.setAlarm(wakeAt);
    }
  }

  async #runJob(job: PersistedJob): Promise<unknown> {
    const runner = new LoaderRunner({
      loader: this.env.LOADER,
      callSite: 'do-method',
      cacheKeyStrategy: 'stable',
    });
    const envelope: DispatchEnvelope = {
      deadlineEpochMs: job.deadlineEpochMs,
      signal: { cancelled: false },
    };
    return runner.runOne({
      fnSource: job.fnSource,
      fnHash: job.fnHash,
      context: job.context,
      bindings: this.env as unknown as Record<string, unknown>,
      envelope: { ...envelope, mode: 'pool-fn' as const },
      args: job.args,
    });
  }
}
