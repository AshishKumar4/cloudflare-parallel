import type { JobStore, PersistedJob } from './job-store.js';

/**
 * Pure reactive dispatcher core. Holds the ready-set / running-set /
 * round-robin state, kicks the dispatch loop, and delegates execution to a
 * caller-provided `runJob` function.
 *
 * Decoupled from the DO surface so it can be unit-tested without workerd
 * (no SqlStorage, no DurableObject required). `CfpSchedulerDO` is a thin
 * shim that wires `Dispatcher` to its own `ctx.storage` and to a
 * `LoaderRunner`-backed `runJob`.
 *
 * Architectural invariants (DESIGN §11):
 * - Storage is canonical; in-memory ready/running are derived state.
 * - `enqueue` writes to storage first, then mirrors to ready, then kicks
 *   the dispatch loop. The loop is single-flight via `#loopRunning`.
 * - Round-robin pulls fairly across `tenantId` buckets, capped by
 *   `fairCapacityPerTenant` to prevent monopolization.
 * - Runaway loops are bounded by `inFlightLimit`; backpressure surfaces
 *   via `maxQueueDepth` (enqueue throws when exceeded).
 *
 * Throughput: bounded by `inFlightLimit × loader-cap-per-isolate` (=4 from
 * a DO method). The previous alarm-batched design capped at 0.8 jobs/s.
 */
export interface DispatcherConfig {
  inFlightLimit: number;
  maxQueueDepth: number;
  resultTtlMs: number;
  fairCapacityPerTenant: number;
  defaultLeaseMs: number;
}

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  inFlightLimit: 32,
  maxQueueDepth: Number.POSITIVE_INFINITY,
  resultTtlMs: 3_600_000,
  fairCapacityPerTenant: 4,
  defaultLeaseMs: 60_000,
};

/**
 * Caller-provided job runner. Returns the value (which Dispatcher will ack)
 * or throws (which Dispatcher will fail). Receives the leased PersistedJob
 * + the leaseOwner string so retries / lease-aware logic can be threaded.
 */
export type RunJobFn = (job: PersistedJob, leaseOwner: string) => Promise<unknown>;

/** Optional hooks for backstop scheduling (alarm) and re-entry (waitUntil). */
export interface DispatcherHooks {
  /** Called when a job will be retried after `delayMs`. The DO sets an alarm. */
  onScheduleRetry?(delayMs: number): void;
  /** Called when in-flight work exists; DO can extend its lifetime. */
  onWorkScheduled?(workPromise: Promise<void>): void;
}

interface RunningJob {
  id: string;
  tenantId: string;
  startedAt: number;
}

export interface DispatcherStats {
  ready: number;
  running: number;
  tenantsReady: number;
  inFlightLimit: number;
  maxQueueDepth: number;
}

const RETRY_BACKOFF_BASE_MS = 200;
const RETRY_MAX_DELAY_MS = 60_000;

export class Dispatcher {
  readonly #store: JobStore;
  readonly #runJob: RunJobFn;
  readonly #ownerId: string;
  readonly #hooks: DispatcherHooks;
  /** Ready jobs grouped by tenantId for round-robin fair-queueing. */
  readonly #ready = new Map<string, PersistedJob[]>();
  /** Tenants in cyclic order — pulled round-robin by the dispatch loop. */
  readonly #tenantOrder: string[] = [];
  /** Currently-running jobs, by id. */
  readonly #running = new Map<string, RunningJob>();
  #config: DispatcherConfig;
  /** Single-flight guard for the dispatch loop. */
  #loopRunning = false;

  constructor(opts: {
    store: JobStore;
    runJob: RunJobFn;
    ownerId: string;
    config?: Partial<DispatcherConfig>;
    hooks?: DispatcherHooks;
  }) {
    this.#store = opts.store;
    this.#runJob = opts.runJob;
    this.#ownerId = opts.ownerId;
    this.#config = { ...DEFAULT_DISPATCHER_CONFIG, ...opts.config };
    this.#hooks = opts.hooks ?? {};
  }

  /** Replace the dispatcher's tunables. Pre-existing settings persist. */
  configure(c: Partial<DispatcherConfig>): DispatcherConfig {
    this.#config = { ...this.#config, ...c };
    return this.#config;
  }

  config(): DispatcherConfig {
    return this.#config;
  }

  /** Push a job into the ready set and kick the dispatch loop. */
  async enqueue(job: PersistedJob): Promise<void> {
    const queueDepth = this.totalReady();
    if (queueDepth >= this.#config.maxQueueDepth) {
      const err = new Error(
        `Dispatcher queue full (depth=${queueDepth}, max=${this.#config.maxQueueDepth})`,
      );
      err.name = 'QueueFullError';
      throw err;
    }
    await this.#store.enqueue(job);
    this.#enqueueReady(job);
    this.kick();
  }

  /** Fire the dispatch loop. Single-flight; safe to call from any context. */
  kick(): void {
    void this.#dispatchLoop();
  }

  /** Drop a queued job from the ready set. Idempotent. */
  dropFromReady(jobId: string): void {
    for (const [tid, q] of this.#ready) {
      const idx = q.findIndex((j) => j.id === jobId);
      if (idx >= 0) {
        q.splice(idx, 1);
        if (q.length === 0) this.#removeTenant(tid);
        return;
      }
    }
  }

  /** Clear a tenant's entire ready bucket (used by cancelByTenant). */
  clearTenant(tenantId: string): void {
    this.#removeTenant(tenantId);
  }

  /** Rebuild ready state from storage (called on DO init / lease reclaim). */
  async rebuildFromStorage(): Promise<void> {
    this.#ready.clear();
    this.#tenantOrder.length = 0;
    const queued = await this.#store.peek({ limit: 10_000 });
    for (const job of queued) this.#enqueueReady(job);
  }

  totalReady(): number {
    let n = 0;
    for (const q of this.#ready.values()) n += q.length;
    return n;
  }

  runningCount(): number {
    return this.#running.size;
  }

  stats(): DispatcherStats {
    return {
      ready: this.totalReady(),
      running: this.#running.size,
      tenantsReady: this.#ready.size,
      inFlightLimit: this.#config.inFlightLimit,
      maxQueueDepth: this.#config.maxQueueDepth,
    };
  }

  /** Returns a snapshot of ready jobs per tenant — for tests. */
  inspectReady(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [tid, q] of this.#ready) out.set(tid, q.map((j) => j.id));
    return out;
  }

  // ---------------------------------------------------------- internals

  async #dispatchLoop(): Promise<void> {
    if (this.#loopRunning) return;
    this.#loopRunning = true;
    try {
      while (this.totalReady() > 0 && this.#running.size < this.#config.inFlightLimit) {
        const job = this.#takeNextReady();
        if (!job) break;
        // Cheap pre-claim deadline check — the JobStore.claim filter
        // excludes deadline-expired rows from CAS, leaking them in queued
        // state. Sweep here so the dispatcher actually fails them.
        if (job.deadlineEpochMs > 0 && Date.now() >= job.deadlineEpochMs) {
          await this.#failExpired(job);
          continue;
        }
        // Claim by id — fair-queueing already chose this specific row;
        // claiming "oldest queued" would race with our pick.
        const claimed = await this.#store.claim({
          workerId: this.#ownerId,
          max: 1,
          leaseMs: this.#config.defaultLeaseMs,
          jobId: job.id,
        });
        const target = claimed[0];
        if (!target) {
          // Concurrently cancelled or claimed by alarm sweep — skip.
          continue;
        }
        this.#running.set(target.id, {
          id: target.id,
          tenantId: target.tenantId,
          startedAt: Date.now(),
        });
        const work = this.#runOne(target).finally(() => {
          this.#running.delete(target.id);
          // Reactive re-entry: pulling the next job the moment one settles.
          if (this.totalReady() > 0 && this.#running.size < this.#config.inFlightLimit) {
            this.kick();
          }
        });
        this.#hooks.onWorkScheduled?.(work);
      }
    } finally {
      this.#loopRunning = false;
    }
  }

  /**
   * Mark a deadline-expired queued job as failed (no retry). The standard
   * `JobStore.fail` CAS requires `status='leased'`; deadline expiry hits
   * before claim, so we use the dedicated `failQueued` transition.
   */
  async #failExpired(job: PersistedJob): Promise<void> {
    await this.#store.failQueued(job.id, {
      name: 'DeadlineExceededError',
      message: `Deadline ${new Date(job.deadlineEpochMs).toISOString()} elapsed before dispatch`,
    });
  }

  async #runOne(job: PersistedJob): Promise<void> {
    try {
      const value = await this.#runJob(job, this.#ownerId);
      await this.#store.ack(job.id, this.#ownerId, value, Date.now() + this.#config.resultTtlMs);
    } catch (rawErr) {
      const err = toErrorRecord(rawErr);
      const next = await this.#store.fail(job.id, this.#ownerId, err);
      if (next === 'queued') {
        // Re-queued for retry. Compute backoff and schedule a setTimeout
        // that re-adds the job to the in-memory ready set. Storage already
        // has it at status='queued'; without this, the job would only be
        // picked up on the next alarm tick. Also fire the
        // backstop alarm hook for cross-DO-restart durability.
        const base = job.retry?.baseMs ?? RETRY_BACKOFF_BASE_MS;
        const factor = Math.pow(
          job.retry?.backoff === 'exponential' ? 2 : 1,
          job.retryCount,
        );
        const delayMs = Math.min(base * factor, RETRY_MAX_DELAY_MS);
        this.#hooks.onScheduleRetry?.(delayMs);
        // Construct an updated job snapshot — retryCount has been
        // incremented in storage but the local copy is stale.
        const retryJob: PersistedJob = {
          ...job,
          retryCount: job.retryCount + 1,
          status: 'queued',
          leaseOwner: undefined,
          leaseExpiresMs: undefined,
        };
        const reSchedule = (): void => {
          // Re-add to ready and kick the loop. If the job has been cancelled
          // in the meantime, the dispatcher's claim step will return empty
          // and we silently skip.
          this.#enqueueReady(retryJob);
          this.kick();
        };
        if (delayMs <= 0) {
          reSchedule();
        } else {
          setTimeout(reSchedule, delayMs);
        }
      }
    }
  }

  #enqueueReady(job: PersistedJob): void {
    let q = this.#ready.get(job.tenantId);
    if (!q) {
      q = [];
      this.#ready.set(job.tenantId, q);
      this.#tenantOrder.push(job.tenantId);
    }
    q.push(job);
  }

  /**
   * Round-robin pull across tenants. Honors per-tenant
   * `fairCapacityPerTenant` budget so one chatty tenant cannot starve
   * others while inFlight is below the global limit.
   */
  #takeNextReady(): PersistedJob | undefined {
    if (this.#tenantOrder.length === 0) return undefined;
    const tenantInFlight = new Map<string, number>();
    for (const r of this.#running.values()) {
      tenantInFlight.set(r.tenantId, (tenantInFlight.get(r.tenantId) ?? 0) + 1);
    }
    const cap = this.#config.fairCapacityPerTenant;
    for (let i = 0; i < this.#tenantOrder.length; i++) {
      const tid = this.#tenantOrder[0];
      this.#tenantOrder.push(this.#tenantOrder.shift()!);
      const inflight = tenantInFlight.get(tid) ?? 0;
      const q = this.#ready.get(tid);
      if (!q || q.length === 0) {
        this.#removeTenant(tid);
        continue;
      }
      if (inflight >= cap) continue;
      const job = q.shift()!;
      if (q.length === 0) this.#removeTenant(tid);
      return job;
    }
    return undefined;
  }

  #removeTenant(tid: string): void {
    this.#ready.delete(tid);
    const idx = this.#tenantOrder.indexOf(tid);
    if (idx >= 0) this.#tenantOrder.splice(idx, 1);
  }
}

function toErrorRecord(e: unknown): { name: string; message: string; stack?: string } {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { name: 'UnknownError', message: String(e) };
}
