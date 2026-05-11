# Changelog

All notable changes to this project will be documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Chore (quality audit + cleanup pass)

A deep audit (see `/workspace/quality-audit-findings.md`) drove a
cleanup pass with zero perf regressions:

- **P0 fixes**:
  - `scheduler-do.ts#runJob` now honors the per-job
    `cacheKeyStrategy` — previously hard-coded to `'stable'`. Schema
    bumped to v2 with idempotent `ALTER TABLE ADD COLUMN` migrations
    on both DO-storage and D1 stores.
  - `pool.map(opts: { onError: 'throw-fast' })` no longer iterates a
    never-populated `childTokens` array. Behavior unchanged
    (`Promise.all` semantics for in-flight in-process tasks; pass a
    `CancelToken` to abort in-flight RPCs).
  - Test fakes (`poolFake`, `actorFake`, `schedulerFake`,
    `loaderOnlyFake`, `vmFake`) no longer leak into the production
    bundle. `Parallel.testing.*` is **removed** from the
    `Parallel` namespace — use `import { poolFake, ... } from
    'cloudflare-parallel/testing'`. `dist/index.js` is now genuinely
    fakes-free.
- **Topology cleanup**:
  - Dropped `LoaderOnlyPlan` from the `TopologyPlan` union (the
    selector never returned it; the coordinator threw on it).
  - Dropped `'sub-coord'` from `CodegenMode` (the codegen arm emitted
    a placeholder that threw on call; never reached).
  - Renamed the codegen-internal `WorkerCodeOptions` →
    `InternalWorkerCodeOptions`. The user-facing one keeps its name.
  - Raised `maxFanOut` cap from 64 → 256 in the selector. Defaults
    unchanged.
- **De-duplication**:
  - The four `#stub()` hand-rolls in `pool.ts`, `scheduler.ts`,
    `actor.ts`, `submit-code-handler.ts` all route through
    `coordinator/internal.ts:getStub` now. Three redundant
    `DurableObjectNamespaceGetDurableObjectOptions` redeclarations
    deleted.
  - Extracted shared `mergeContext` (`api/context-merge.ts`),
    shared `splitSubmitOptions` / `isSubmitOptionsBag` /
    `SUBMIT_OPTION_KEYS` (`api/submit-options.ts`), shared
    `errorToRecord` (`coordinator/protocol.ts`) helpers.
  - Replaced `sub-coordinator.ts#balancedFillForTree` with
    `balancedFill` from `topology/plan.ts` (no cross-module cycle
    actually exists; the local copy was redundant).
  - Hoisted `MAX_TRANSIENT_RETRIES = 2` and `transientBackoff()`
    helper in `coordinator.ts`. Tree-dispatch retry and leaf-batch
    retry both use them now.
- **Dead code removed**:
  - `src/config/` (doctor.ts + wrangler.ts) — the CLI it referenced
    was never built. All `cloudflare-parallel doctor` mentions purged
    from error messages and TSDoc.
  - `makeLoaderRunner`, `serializeFunctionAllowingState`,
    `envelopeRemainingMs`, `checkDeadline`, `idFromName`,
    `restrictPoolBindings` — one-line wrappers / never-called helpers.
  - `Scheduler.attachQueue` — runtime no-op placeholder for the
    (non-existent) doctor CLI.
  - `Pool.#cancelOff` variable — `CancelToken.onCancel` is one-shot
    so the manual unsubscribe path was dead. Replaced with a comment.
  - `'sub-coord'` codegen arm.
  - Stale `bench-results.json` (one-shot e2e summary; the live bench
    writes `bench-results-live.json`).
- **Error hierarchy**:
  - `QueueFullError extends BackpressureError` — scheduler now throws
    a typed error with structured `depth` / `maxDepth` fields. Added
    `CFP_QUEUE_FULL` to the `ErrorCode` union. Replaces the hand-rolled
    `new Error()` + `.name = 'QueueFullError'` shim.
- **API consistency**:
  - `ActorOptions` now extends `WorkerSharedOptions` instead of
    `PoolOptions`. Topology / fan-out / autoWarm / inProcess fields
    don't bleed onto the actor surface anymore (they were no-ops on
    actors, which are single-DO single-job).
  - `SchedulerOptions.store` typed as `'do-storage' | 'queues' | 'd1' |
    JobStore` instead of `... | unknown`.
  - Renamed the leaf-RPC error decoder from
    `api/error-decode.ts:wireToError` → `leafErrorToTypedError` to
    end the name collision with `errors/index.ts:wireToError` (full
    `WireError` reconstruction). The two are deliberately distinct.
- **TSDoc**:
  - Added TSDoc to every user-facing option interface in
    `api/options.ts`: `PoolOptions`, `LoaderOnlyOptions`,
    `ActorOptions`, `SchedulerOptions`, `VMOptions`, `SubmitOptions`,
    `MapOptions`, `PmapOptions`, `ScatterOptions`, `StreamOptions`,
    `StreamResult`, `Job`, `JobHandle`, `JobStatus`, `RetryPolicy`,
    `RetryBackoff`, `OnErrorStrategy`, `PoolStats`, `SchedulerStats`,
    `ObservabilityOptions`, `AnalyticsEngineDataset`,
    `WorkerCodeOptions`.
- **Repo hygiene**:
  - `package.json` gained `homepage`, `bugs`, `author`,
    `publishConfig: { access: 'public', registry: ... }`. Repo URL
    follows `git+https://...git` convention.
  - CI bundle-size budget bumped 250 → 300 KB packed / 1 → 1.5 MB
    unpacked. Source maps continue to ship — they're 50 % of the
    tarball and worth the debug ergonomics.
  - `bench-results.json` gitignored (the per-run e2e output file);
    `bench-results-live.json` remains the committed reference.
  - Cleaned up v0.2-era TSDoc callouts that were doc-debt residue
    from prior majors.

### Performance (dispatch-overhead audit fixes)

Forensic audit of the dispatch path (see
`/workspace/perf-audit-findings.md` for the full breakdown) identified
five high-impact wins. Combined, they move large-N speedups
dramatically:

| N | Pre-audit speedup | Post-audit speedup |
|---:|---:|---:|
| 4  | 3.3× | **3.1×** (Coordinator-hop bound; not fixable without splitting the API) |
| 16 | 12.6× | **12.0×** |
| 64 | 19.7× | **37.1×** (1.9× lift) |
| 128 | 35.7× | **53.9×** (1.5× lift) |
| 256 | 91.0× | **187.4×** (2.1× lift) |
| 512 | 144.4× | **358.4×** (2.5× lift) |

Mandelbrot workload, median-of-5 warm samples with WARMUP_RUNS=4.

The fixes:

- **F9: Leaf-DO prewarm at dispatch entry**
  (`src/coordinator/coordinator.ts`, `sub-coordinator.ts`). On every
  `runMany`, the Coordinator now fires `noop()` to each leaf DO that
  hasn't been seen yet — UNAWAITED, in parallel with the real
  dispatch. The noop arrives at the leaf first and kicks off DO
  creation; the real `runBatch` rides the warm channel. Tracked in a
  per-Coordinator-DO `#prewarmedLeaves: Set<string>` so subsequent
  fan-outs don't refire. Same pattern in `CfpSubCoord` for tree
  leaves. Closes the cold-leaf variance that was dragging the median
  by 3-5× the platform floor at N≥64.
- **F1 + F7: Leaf-DO single-job fast path** (`src/coordinator/worker-do.ts`).
  The redesigned topology dispatches one job per leaf so
  `argsList.length === 1` is always true on the hot path. Specialize
  it to skip `forkCancelStream(stream, 1)` (a 1-child ReadableStream
  alloc + async pump for nothing) and `Promise.all([one])` (extra
  microtask + array alloc). Pass the cancel stream straight through
  to `runner.runOne`.
- **F8: Stub caches on Coordinator + SubCoord DOs**. Each
  Coordinator instance keeps `Map<leafName, DurableObjectStub>` and
  `Map<subCoordName, DurableObjectStub>`. Leaf-DO names are stable
  across requests (commit `e671cc1` already pinned this), so
  `idFromName` (SHA-256 over the name) + `ns.get` is paid once per
  leaf per Coordinator lifetime. Invalidated on transient leaf reset
  so retries get a fresh routing handle.
- **F12: Pool-instance Coordinator-stub memoization**. `Pool.#stub()`
  now caches its single Coordinator stub on first call — saves one
  SHA-256 + `ns.get` per `pool.map` / `pool.submit`.
- **maxFanOut cap raised from 64 → 256** (`src/topology/selector.ts`).
  Lets users pin single-tier hybrid shapes for larger N when they
  want predictable latency / no tree-tier hop. Default `maxFanOut`
  (32) and default tree-promotion behavior are unchanged.

### Changed (BREAKING — topology redesign: N parallel = N DOs, not 4N)

- **The "4 loaders per leaf DO" model is gone.** The library now
  dispatches **one job per leaf Durable Object** at every fan-out size
  ≥ 2. CPU parallelism scales linearly with DO count because each
  leaf is a separate workerd process with its own V8 scheduler thread.
  Loaders inside a single workerd process share its V8 thread and
  serialize on CPU — so the previous "4N math" (`N` leaf DOs × `4`
  loaders each) was wrong; multiplying loaders within a DO never
  multiplies CPU. The empirical baseline that drove this redesign:
  cf-mp-vm's `/b/benchmark?n=4&iters=10000000` measures **4.07×
  speedup** with the `parallel-diff` pattern (4 DOs, 1 loader each)
  versus 1.09× with `parallel-same` (1 DO, 4 loaders).
- **Topology selector rewrite** (`src/topology/selector.ts`):
  - `size = 0..1` → `in-do` (single-loaded-isolate fast path,
    no fan-out). Pinning `topology: 'in-do'` at size ≥ 2 now throws
    `TopologyError` — what used to be a silent serialize is now a
    loud configuration error.
  - `size 2..maxFanOut` (default 32) → `hybrid`. Leaf shape is
    `[1, 1, ..., 1]` (length `N = size`); one job per leaf DO.
  - `size > maxFanOut` → `tree`. Each tier divides work evenly across
    `branchingFactor` (default 8) sub-coords; the bottom tier is a
    hybrid leaf with one job per leaf DO. Depth
    `K = max(1, ceil(log_F(size / maxFanOut)))`.
  - `treeThreshold` defaults to `maxFanOut` (was 128) so the
    auto-selector promotes to tree exactly when a single coordinator
    would otherwise exceed its outbound RPC fan-out budget. Override
    both knobs together to keep larger fan-outs flat.
  - `PER_DO_LOADER_CAP = 4` constant deleted. `fillCapped` helper
    deprecated (still exported for backward compat; no longer used by
    the selector).
- **Coordinator dispatch** (`src/coordinator/coordinator.ts`):
  - `#dispatchInDo` is now a single-job path — refuses size > 1
    defensively (the selector should have rejected it first).
  - Leaf-DO naming is **stable across requests**: `${coordId}-leaf-${i}`
    (previously included a per-request UUID). Subsequent fan-outs of
    the same shape now hit warm leaves and skip the ~300–400 ms
    first-RPC DO creation cost. Warm-of-many wall at N=4 dropped from
    ~900 ms (sequential-equivalent) to ~300 ms (≈3× speedup, matching
    the platform-floor measured via raw `parallel-diff`).
- **Sub-coordinator** (`src/coordinator/sub-coordinator.ts`):
  - `PER_LEAF = 4` constant deleted from `dispatchHybridLeaf`. The
    sub-coord dispatches one leaf DO per job; per-request counter
    removed in favor of stable leaf naming.
- **CHANGED `fanOutPerLevel`** (`PoolStats`): used to emit
  `[leafCount, ...perLeafLoaderCounts]` (e.g. `[32, 4, 4, ..., 4]` at
  size=128); now emits just `[leafCount]` at every hybrid tier and
  the leaf-tier width at the bottom of the tree (`[8, 16]` at
  size=128, `[8, 32]` at size=256). The total leaf count is
  `product(fanOutPerLevel)` of every tier.

### Fixed (cache-key collision — per-task isolate isolation)

- **`taskSlot` plumbing in the cache-key path** (P0): `pool.map`'s
  default `'stable'` strategy returned the SAME loader key for every
  task in a fan-out because the key was just `cfp:<hash>` with no
  per-task differentiator. The Worker Loader's by-key caching collapsed
  all N concurrent `loader.get(sameKey)` calls onto one shared loaded
  isolate — distinct tasks ended up sharing the same V8 heap and
  module-level state, a correctness hazard for any fn that stashes
  per-call state in a top-level `let` or `Map`.
  - New `taskSlot?: number` field on `CacheKeyInput`. When present,
    appends `:slot-<taskSlot>` to the cache key — N distinct keys for
    N concurrent tasks → N distinct V8 isolates with independent
    heaps and module state.
  - **Note.** The slot suffix is an **isolation** primitive. CPU
    parallelism comes from the redesigned topology above (one job per
    leaf DO process); the slot keeps each task's isolate independent
    of every other task's isolate, which matters whenever multiple
    user fns might land on the same workerd process (e.g. through
    `LoaderOnlyPool` from a fetch handler).
  - `taskSlot` is plumbed end-to-end:
    `pool.{submit,map,scatter,reduce,pmap}` → `runMany` /
    `runOne` → `CoordinatorFanOutRequest` → `Coordinator.#dispatchInDo`
    / `#dispatchHybrid` / `#dispatchTree` → `RunBatchRequest.taskSlotBase`
    / `DispatchTreeRequest.taskSlotBase` → `WorkerDO.runBatch` /
    `SubCoord.dispatch` → `LoaderRunner.runOne({ taskSlot })` →
    `buildCacheKey({ taskSlot })`.
  - Slot indices are GLOBAL across the fan-out: the i-th task in the
    caller's `argsList` always lands at global slot `i`, regardless of
    which leaf DO ends up running it. Same task position reliably
    reuses the same isolate across calls.
  - Single-shot `submit()` uses slot 0 — compatible with the slot-0
    isolate of a future `map`.
  - New regressions:
    - `tests/unit/cache-key-slot.test.ts` (11 tests) pins the
      `buildCacheKey` taskSlot semantics: distinct slots → distinct
      keys, same (fn, slot) across calls → same key, slot suffix
      applies to `stable` and `auto`, `fresh` ignores it.
    - `tests/unit/task-slot-dispatch.test.ts` (6 tests) pins that
      `pool.map(items, fn)` issues N distinct `loader.get` IDs to a
      fake Worker Loader (4 isolates at N=4).

### Fixed (audit-findings sweep)

- **`CfpInProcessCoordinator` loader-cap** (P0): the two `LoaderRunner`
  constructions in `src/coordinator/in-process.ts` used
  `callSite: 'fetch-handler'` (cap = 3) instead of `'do-method'`
  (cap = 4). Surfaced as a "N=4 fan-out is barely faster than
  sequential" complaint in the live demo. Now uses `'do-method'`; new
  regression at `tests/unit/in-process-cap.test.ts` pins both call
  sites.
- **Auto-prewarm of the loaded isolate** (P0): when `inProcess` was
  wired, `Pool#ensurePrewarm` short-circuited entirely, leaving the
  loopback's loaded isolate to pay full cold-start on the first
  dispatch in any quiescent window. Surfaced as the "the numbers
  change every time I refresh" run-to-run inconsistency. Now fires a
  single no-op `runOne` through the loopback (parallel with the real
  dispatch) so the loaded isolate is hot when the workload arrives.
  Cold→warm spread dropped from ~2.1× to ~1.01× empirically. New
  regression at `tests/unit/prewarm.test.ts` (5 new tests in the
  "inProcess loopback" describe block).
- **Examples wire `inProcess`** (P1): `examples/build-pipeline`,
  `examples/genetic-algorithm`, `examples/raytracer`,
  `examples/vm` now pass
  `inProcess: ctx.exports.CfpInProcessCoordinator` + `requestColo:
  req.cf?.colo` to `Parallel.pool` (mirror of `examples/embeddings-batch`).
  Previously these examples re-exported the entrypoint but never
  wired it.
- **Actor + Scheduler honor `locationHint` / `requestColo`** (P1):
  `Parallel.actor` and `Parallel.scheduler` now accept the same
  placement options as `Parallel.pool` and pass `locationHint` to
  `namespace.get`. Picks colo placement at construction time;
  honored on first DO access (sticky after). New regression at
  `tests/unit/actor-scheduler-locationhint.test.ts`.
- **Bench methodology samples=5** (P2): the committed
  `bench-results-live.json` is now regenerated at the documented
  contract (`samples=5`, `warmupRuns=2`).
- **`examples/vm` migrated off deprecated nested `pool: {}` shape**:
  pool options now live at the top level of the `Parallel.vm` opts,
  matching the v0.3 API.
- **`fillCapped` exported from the public API**: symmetric with
  `balancedFill`. Both helpers were referenced in the CHANGELOG and
  the tests but only `balancedFill` was on the public surface.
- **`CfpWorkerDOEntry` removed**: empty placeholder class that nothing
  referenced — implement-or-delete decision per the audit; deleted.

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


