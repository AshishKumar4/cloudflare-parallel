# Changelog

All notable changes to this project will be documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`CfpInProcessCoordinator`** — a `WorkerEntrypoint` loopback target
  registered via `ctx.exports`. Pass
  `inProcess: ctx.exports.CfpInProcessCoordinator` to `Parallel.pool` to
  skip the Coordinator DO hop for `submit()` and small fan-outs (size
  ≤ 4). Per-call dispatch drops from tens of milliseconds to a couple
  of milliseconds. ([Workers `ctx.exports` reference](https://developers.cloudflare.com/workers/runtime-apis/context/))
- **Promise pipelining** at the leaf-DO tier. `CfpWorkerDO.openSession()`
  and `CfpSubCoord.openTreeSession()` return long-lived `RpcTarget`
  sessions; the coordinator chains the workload call on the
  not-yet-resolved session promise so both calls travel in a single
  Cap'n Proto round-trip per leaf. ([Workers RPC reference](https://developers.cloudflare.com/workers/runtime-apis/rpc/))
- **`PoolOptions.locationHint`** + **`PoolOptions.requestColo`**.
  `requestColo` (typed string, e.g. `'SFO'`) auto-derives a
  region hint mapping for `namespace.get(id, { locationHint })` so
  freshly-created leaf DOs colocate with the request's incoming colo.
  ([Data location reference](https://developers.cloudflare.com/durable-objects/reference/data-location/))
- **`fillCapped`** companion to `balancedFill` in `src/topology/plan.ts`.
  `balancedFill` is now true even-distribution
  (`floor(size/n)` base + 1-extra per remainder), used by the tree
  topology for true F-way parallel fan-out. `fillCapped` keeps the
  cap-first behaviour (fill-`maxPerSlot`-at-a-time, last slot remainder)
  for hybrid leaf shapes.
- **Bundler-shim stripping** in `serializeFunction`. `__name(fn,
  "literal")` and `__publicField(target, "key", value)` wrappers
  emitted by esbuild's bundler runtime are now stripped at serialize
  time, so user fns from a bundled Worker run cleanly inside loaded
  isolates without dead `__name` references.
- **Live edge bench** (`tests/prod/bench-live.ts`) rewritten with
  separate `coldRunMs` / `warmRunMs` reporting, equal warmup for both
  paths, and median-of-≥5 sampling. Output schema in
  `bench-results-live.json` adds a `methodology` block documenting the
  measurement contract.
- **Regression tests** at `tests/unit/topology/plan.test.ts` pinning
  `balancedFill` at N = 128 / 256 / 512 / 1024 and asserting tree fan-out
  is real (not a chain).
- **Cache-key rotation regression** at `tests/unit/cache-key.test.ts`
  asserts that the new `'stable'` default produces exactly one cache
  key per fn shape across time (no LRU thrash).
- **Live demo site** at [`cloudflare-parallel-demo.pages.dev`](https://cloudflare-parallel-demo.pages.dev)
  — every primitive runnable as a CPU-bound interactive panel.
- **Live test worker** at
  [`cloudflare-parallel-prod-tests.ashishkmr472.workers.dev`](https://cloudflare-parallel-prod-tests.ashishkmr472.workers.dev).
  Substrate validation + full library E2E run against this URL.
- **CPU-vs-IO positioning** as a first-class invariant in `README.md`,
  `DESIGN.md`, and the new `docs/when-to-use.md`.
- **Hero workloads** in the test worker:
  `/workload/{mandelbrot,montecarlo,pow,ga}` — Mandelbrot tile rendering,
  Monte Carlo π estimation, Bitcoin-style proof-of-work nonce search
  (with cancel-on-winner via `pool.mapStream` + `CancelToken`), and a
  genetic algorithm with N-body fitness simulation. Each is a pure-CPU
  workload sized for ~500–800 ms / task so the per-call dispatch floor
  is well-amortized.
- **CPU-bound examples**: `embeddings-batch`, `raytracer`,
  `genetic-algorithm`, `build-pipeline`. The library is for CPU-heavy
  fan-out across V8 isolates.
- **README Performance section** documenting the three RPC
  optimizations (`inProcess`, promise pipelining, `locationHint`) in
  public-doc language with links to canonical Cloudflare docs.
- **README API exposure pass.** Every public method on `Pool` /
  `LoaderOnlyPool` / `ActorHandle` / `Scheduler` / `VM` is listed
  with a short example.

### Changed

- **Default `cacheKeyStrategy: 'stable'`** across all five factories
  (`pool`, `actor`, `scheduler`, `vm`, `loaderOnly`). The previous
  default `'auto'` (60-second windows) thrashed the per-owner LRU
  whenever fn-shape diversity exceeded ~50 distinct shape-windows per
  hour, causing repeated cold-start. `'auto'` is preserved as an
  opt-in for the small-fixed-set-of-shapes / want-periodic-refresh
  case. (Surfaced in third-party review.)
- **`balancedFill` semantics.** Previously cap-first, which collapsed
  `balancedFill(N, F, N)` to `[N, 0, ..., 0]` — the tree topology
  was passing exactly that and degenerating to a chain. Now true even
  distribution; the hybrid leaf shape uses `fillCapped` instead.
  (Surfaced in third-party review; the brokenness capped peak
  parallelism at 128 regardless of size.)
- **`fanOutPerLevel`** in `PoolStats` now appends the per-leaf loader
  count for tree topologies, so the multiplicative tier structure is
  fully visible (e.g. `[8, 8, 8, 1, 4]` for size=512).
- **Bench harness methodology.** Equal warmup for both paths,
  median-of-≥5 sampling, separate cold/warm fields. (Surfaced in
  third-party review.)

### Removed

- I/O-bound examples (`research-agent`, `web-crawler`). Plain
  `Promise.all` on a single isolate is the right tool for fanning
  out `fetch` / `env.AI` / KV calls — this library is for CPU work.

## [0.3.0]

Initial public release.

### Added

- **Reactive scheduler dispatch.** `CfpSchedulerDO` no longer alarm-batches —
  a pure `Dispatcher` core (`src/scheduler/dispatcher.ts`) drives single-flight,
  fair round-robin dispatch per `tenantId`, with `inFlightLimit` /
  `maxQueueDepth` / `fairCapacityPerTenant` knobs. Old alarm-batched cap was
  ~0.8 jobs/s; new design is bounded by `inFlightLimit × loader-cap-per-isolate`
  (~128 concurrent isolates per scheduler DO).
- **Live AbortSignal cancel.** `CancelToken.signal` is a real `AbortSignal`
  driven end-to-end via a `ReadableStream` (caller → Coordinator → child DO →
  loaded isolate).
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
- **`Cfp*` PascalCase namespace** for library-internal DOs.
- **`pickBindings(env, keys)`** — typed key-filter helper.
- **Per-example READMEs** in `examples/scheduler/`, `examples/vm/`,
  `examples/embeddings-batch/`, `examples/raytracer/`,
  `examples/genetic-algorithm/`, `examples/build-pipeline/`.
- **`docs/` folder.** `architecture.md`, `security.md`, `tuning.md`,
  `troubleshooting.md`, `when-to-use.md`.
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


