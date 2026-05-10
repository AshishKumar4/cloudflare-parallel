# Changelog

All notable changes to this project will be documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0]

Major rewrite. **Breaking changes** — see [`MIGRATION.md`](MIGRATION.md).

### Added

- **Reactive scheduler dispatch.** `CfpSchedulerDO` no longer alarm-batches —
  a pure `Dispatcher` core (`src/scheduler/dispatcher.ts`) drives single-flight,
  fair round-robin dispatch per `tenantId`, with `inFlightLimit` /
  `maxQueueDepth` / `fairCapacityPerTenant` knobs. Old alarm-batched cap was
  ~0.8 jobs/s; new design is bounded by `inFlightLimit × loader-cap-per-isolate`
  (~128 concurrent isolates per scheduler DO).
- **Live AbortSignal cancel.** `CancelToken.signal` is a real `AbortSignal`
  driven end-to-end via a `ReadableStream` (caller → Coordinator → child DO →
  loaded isolate). Replaces the v0.2 snapshot-only model.
- **Unified submit-code primitive.** `pool.handle()` and `Parallel.vm` both
  compose on `submitCodeHandler` with a required `policy` field. Built-in
  `bearerAuth` and `hmacAuth` recipes; reserved `Cfp*` namespace
  hard-blocklisted from binding forwarding.
- **Required `policy` on submit-code endpoints.** No silent default-public
  path. `policy: { kind: 'public' }` is an explicit opt-in (logs a one-time
  runtime warning).
- **Observability emission.** `taskStart`, `taskEnd`, `taskError`,
  `taskOrphan`, `poolPressure`, `topologyDecision`, `lruEviction`,
  `scheduler` events fire across Pool and Scheduler. Tail Worker
  auto-injection via `tail.bindingName`. AnalyticsEngine adapter with
  per-event schemas.
- **Canonical fakes.** `Parallel.testing.poolFake` / `actorFake` /
  `schedulerFake` return the public `IPool` / `IActorHandle` /
  `IScheduler` interfaces — swap backends in tests without `as any`.
- **Error hierarchy.** All errors gain `code` (`CFP_*`), `httpStatus`,
  `cause`, `toJSON()` / `WireError` round-trip. Type guards
  (`isBackpressureError`, `isCancelledError`, `isExecutionError`,
  `isAggregateExecutionError`, `isDeadlineExceededError`, `isTimeoutError`,
  `isParallelError`) work on both class instances and cross-RPC wire shapes.
- **`Cfp*` PascalCase rename** for library-internal DOs (was `__cfp_*`).
- **`pickBindings(env, keys)`** — typed key-filter helper.
- **Per-example READMEs** in `examples/research-agent/`,
  `examples/web-crawler/`, `examples/scheduler/`, `examples/vm/`.
- **`docs/` folder.** `architecture.md`, `security.md`, `tuning.md`,
  `troubleshooting.md`, `cf-internals.md`.
- **CI gates.** ESLint flat config, Prettier, `.editorconfig`. CI runs
  format-check + lint + typecheck + tests + bench + bundle-size budget.
- **Method-level TSDoc** on every public symbol.

### Changed

- `pool.mapOrdered` and `pool.drain` use `Deferred<T>` instead of
  `setTimeout`-poll loops.
- `JobStore.claim({ jobId })` lets the scheduler claim a specific row
  chosen by fair-queueing instead of "oldest queued".
- Scheduler alarms are backstop only (retry-backoff, result-TTL,
  expired-lease reclaim); primary dispatch is reactive.
- `VMOptions` extends `PoolOptions` directly; the legacy nested
  `pool: { ... }` field still works but is deprecated.
- `SchedulerOptions` no longer extends `PoolOptions` — composes a shared
  `WorkerSharedOptions` interface instead. Drops `topology` /
  `branchingFactor` / `treeThreshold` / `maxFanOut` fields that don't
  apply to the scheduler.

### Fixed

- Pool body purged of `as unknown as Function` casts; new
  `src/api/user-fn.ts` types.
- `Parallel.vm` no longer ad-hoc-builds an HTTP shape; routes through
  `submitCodeHandler`.
- `submit-code-handler` enforces `Content-Length` pre-check before
  buffering the body; `maxBytes` measures bytes (not UTF-16 code units).
- Reserved-prefix predicate (`isLibraryInternalKey`) replaces the
  hardcoded set so future internal DOs are auto-blocked.
- Retried scheduler jobs no longer wait for the next alarm tick — the
  dispatcher schedules a `setTimeout` that re-enqueues into the
  in-memory ready set after backoff.
- `bearerAuth` prefers `crypto.subtle.timingSafeEqual` when available;
  falls back to a hand-rolled XOR-OR loop.

## [0.2.0]

See `MIGRATION.md` for the v0.2 surface and migration path.
