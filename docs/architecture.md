# Architecture

`cloudflare-parallel` decomposes one Worker request into N independent
V8 isolates running on Cloudflare's edge. This document describes how
the dispatch happens and why.

## The substrate

Three Cloudflare primitives compose:

```
[Worker request]
       │
       ▼
[Coordinator DO] ──► [Worker Loader] ──► [Loaded V8 isolate]
       │                                        │
       │                                        └─ runs user fn(...args, env)
       │
       └─► [Sub-coordinator DO] ──► [Worker Loader] ──► [Loaded V8 isolate]
                                                                 │
                                                                 └─ runs user fn(...)
```

- **Worker Loader.** A Cloudflare runtime API that loads arbitrary
  ES-module source into a fresh V8 isolate, cached by the source hash.
  Empirical caps: 3 concurrent loaders from a Worker fetch handler;
  4 from a DO method; 50 distinct cache keys per owner before LRU
  eviction kicks in.
- **Coordinator DO** (`CfpCoordinator`). A Durable Object that brokers
  RPCs and absorbs eviction shocks. For single-shot `submit()` (and
  the rare `pool.map([x], fn)` of size = 1) the loader can run inside
  the coordinator's own isolate; for fan-outs of size ≥ 2 the
  coordinator dispatches one job per leaf DO so each task lands in
  its own workerd process.
- **Worker DO** (`CfpWorkerDO`). Per-leaf DO used by `hybrid` and
  `tree` topologies. **Each leaf is a separate workerd process with
  its own V8 scheduler thread — that's where CPU parallelism comes
  from.** The library dispatches one job per leaf so the per-leaf
  thread is dedicated to a single user fn at a time. Loaders inside
  one process share its V8 thread and serialize on CPU; we deliberately
  avoid bundling jobs into one leaf.
- **Sub-coordinator DO** (`CfpSubCoord`). Used by tree topology when
  the fan-out exceeds the per-coordinator RPC cap (default 32).
- **Scheduler DO** (`CfpSchedulerDO`). Persistent job queue.

## Topology selection

The selector reads `items.length` and picks:

| size                 | topology      | shape                                                  |
| -------------------- | ------------- | ------------------------------------------------------ |
| `0`                  | `in-do`       | trivial (returns `[]`)                                 |
| `1`                  | `in-do`       | single loaded isolate; no fan-out                      |
| `2..maxFanOut` (32)  | `hybrid`      | N leaf DOs, **one job each** — N-way CPU parallelism   |
| `> maxFanOut`        | `tree`        | recursive sub-coordinators, branching factor F (default 8), one job per leaf |

CPU parallelism scales linearly with leaf count because each leaf DO
is its own workerd process. Selector inputs: `topology` (override),
`maxFanOut`, `branchingFactor`, `treeThreshold`. See
`src/api/options.ts:PoolOptions`.

## Dispatch pipeline (`pool.map`)

```
1. Pool.map(fn, items)
2. ├─ serialize fn → fnSource (string), fnHash (sha256)
3. ├─ build envelope { deadlineEpochMs, mode, signal: { cancelled: false } }
4. ├─ select topology(items.length) → plan
5. ├─ stub = ns.get(coordinatorId)
6. └─ stub.runMany({ fnSource, fnHash, argsList, plan, ... })
       │
7.     ├─ Coordinator.runMany → walk plan
8.     │   ├─ in-do leaf (size = 1): runner.runOne in the coordinator's isolate
9.     │   ├─ hybrid leaf:  leafStub.runBatch on one CfpWorkerDO (one job)
10.    │   └─ tree level:   subCoordStub.dispatch (recursive; each branch
                              fans out further until the bottom tier is a
                              hybrid leaf — one job per leaf DO)
11.    │
12.    └─ aggregate results, return up
13. Pool aggregates per-call results, applies onError strategy, resolves.
```

Leaf DO names are stable (`${coordId}-leaf-${i}` and
`${subCoordId}-r0-leaf-${sliceIdx}-${leafIdx}`) so subsequent
fan-outs of the same shape reuse the same warm leaves and skip the
~300–400 ms first-RPC creation cost (DESIGN §13).

## Reactive scheduler dispatch

The scheduler does **not** alarm-batch. The {@link Dispatcher} core
(`src/scheduler/dispatcher.ts`) holds three sets:

- **Storage** (canonical): DO SQLite, via `DoStorageJobStore`.
- **Ready** (in-memory, derived): `Map<tenantId, PersistedJob[]>` for
  fair round-robin.
- **Running** (in-memory, derived): in-flight bookkeeping.

`enqueue` writes storage → mirrors to ready → kicks the dispatch loop.
The loop is single-flight (`#loopRunning` guard); pulls jobs round-robin
across tenants up to `inFlightLimit`, capped by `fairCapacityPerTenant`.
For each pick: `claim({ jobId })` (CAS on the specific row chosen by
fair-queueing — never "oldest queued"); fire-and-forget `runJob`. On
settle: ack/fail in storage; `kick()` re-enters.

Alarms exist as a backstop: retry-after-backoff (`onScheduleRetry`),
result-TTL sweep, expired-lease reclaim.

Throughput: bounded by `inFlightLimit` (default 32 in-flight jobs).
Jobs running on the scheduler DO's own thread serialize on CPU but
overlap on I/O. For CPU-heavy workloads, submit map fan-outs via
`Parallel.pool` so the work spreads across leaf DOs.

## Cancellation

`SubmitOptions.cancel: CancelToken` ─ token-driven, end-to-end:

```
CancelToken.cancel('reason')
    │
    ▼
Pool builds ReadableStream<Uint8Array>; writes one chunk on cancel
    │
    ▼
Coordinator forks the stream; forwards `cancelStream` to leaf DOs
    │
    ▼
WorkerDO forks again; passes `cancelStream` into the loaded isolate's env
    │
    ▼
Loaded isolate's `env.signal` is a real AbortSignal driven by the stream.
On first chunk, signal.aborted = true; pending awaits reject with reason.
```

Sync infinite loops run to `cpuMs` (the Worker Loader API has no `abort(id)` primitive
yet); the runtime emits a `taskOrphan` event so users see the
asymmetry in metrics.

## Lifetimes

- **Pool / Scheduler / VM**: stateless façades — cheap to construct
  per request. Hold only RPC stubs.
- **Coordinator DO**: lives for the duration of one fan-out (or one
  Actor / Scheduler instance lifetime). Storage persists across restarts.
- **Worker DO**: spun up by Coordinator on first leaf submit; reused
  across requests via the stable leaf-name; evicted by platform LRU.
- **Loaded isolate**: cached by `(fnHash, taskSlot, isolateOptions)` per
  Worker Loader semantics. Up to 50 per owner. Each task in a fan-out
  receives a distinct `taskSlot` so concurrent `loader.get` calls return
  N distinct isolates (memory isolation across tasks); the same
  `(fnHash, slot)` reuses the same warm isolate across calls.

## Caching

`cacheKeyStrategy: 'stable' | 'fresh' | 'auto'`:

- `'stable'` (default across all factories) — cache key is
  `cfp:<fnHash>:slot-<i>`. Per `(fn shape, slot)` isolate: distinct
  isolates for concurrent tasks within ONE fan-out (memory isolation),
  same isolate for the same slot across calls (warm reuse).
  Module-level state in the loaded isolate persists between calls —
  user fns must not rely on per-call freshness.
- `'fresh'` — cache key includes a per-call counter. Defeats reuse;
  use only when you genuinely need a clean V8 heap per submission
  (testing, per-call sandboxing of distrusted code). Pays full
  isolate-load cost on every call.
- `'auto'` (opt-in) — buckets by 60-second windows, slot-suffixed.
  Fresh isolate per `(shape, slot, window)`. Use only when (a) you
  have a small fixed set of fn shapes AND (b) you actively want
  periodic isolate refresh. The per-owner LRU is bounded to ~50
  entries, so deployments that rotate more than 50 distinct
  shape-windows per hour cause repeated cold-start under `'auto'`.
  The default was switched from `'auto'` to `'stable'` after a
  third-party review surfaced this thrash pattern.

## See also

- `DESIGN.md` — full architectural spec; ADRs; threat model.
- `docs/security.md` — submit-code threat model.
- `docs/tuning.md` — every knob, what it does, when to change it.
- `docs/troubleshooting.md` — error decode tree.
