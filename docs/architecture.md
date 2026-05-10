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
  RPCs and absorbs eviction shocks. Loaders run *inside* the
  coordinator's isolate when the topology selector chooses `in-do`.
- **Worker DO** (`CfpWorkerDO`). Per-leaf DO used by `hybrid` and
  `tree` topologies. Each has its own loader budget — that's where the
  `4N` math comes from.
- **Sub-coordinator DO** (`CfpSubCoord`). Used by tree topology beyond
  16 items.
- **Scheduler DO** (`CfpSchedulerDO`). Persistent job queue.

## Topology selection

The selector reads `items.length` and picks:

| size            | topology      | shape                                                   |
| --------------- | ------------- | ------------------------------------------------------- |
| `0`             | `loader-only` | trivial (returns `[]`)                                  |
| `1..4`          | `in-do`       | one coordinator DO; up to 4 loaders inside its isolate  |
| `5..16`         | `hybrid`      | `⌈size/4⌉` leaf DOs; 4 loaders each — **4N parallelism**|
| `17..256`       | `hybrid`      | same shape, more leaves                                 |
| `257..`         | `tree`        | recursive sub-coordinators, branching factor F (default 8) |

Selector inputs: `topology` (override), `branchingFactor`, `treeThreshold`,
`fanOutCap`. See `src/api/options.ts:PoolOptions`.

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
8.     │   ├─ in-do leaf: runner.runOne (loader within DO's isolate)
9.     │   ├─ hybrid leaf: leafStub.runOne (per-leaf DO's loader)
10.    │   └─ tree level: subCoordStub.runMany (recursive)
11.    │
12.    └─ aggregate results, return up
13. Pool aggregates per-call results, applies onError strategy, resolves.
```

Per-request leaf-DO sharding (`requestId` salt) ensures two concurrent
fan-out requests don't collide on the same leaf semaphore (DESIGN §13).

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

Throughput: bounded by `inFlightLimit × loader-cap-per-isolate` (=4
from a DO method). Default `inFlightLimit=32` ⇒ ~128 concurrent
isolates per scheduler DO.

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
  across requests via the leaf-id cache; evicted by LRU.
- **Loaded isolate**: cached by `(fnHash, isolateOptions)` per Worker
  Loader semantics. Up to 50 per owner.

## Caching

`cacheKeyStrategy: 'stable' | 'fresh' | 'auto'`:

- `'stable'` (default across all factories) — cache key is `fnHash`. One
  isolate per fn shape; best warmth and no eviction storms. Module-level
  state in the loaded isolate persists between calls — user fns must not
  rely on per-call freshness.
- `'fresh'` — cache key includes a per-call salt. Defeats reuse; use
  only when you genuinely need a clean V8 heap per submission (testing,
  per-call sandboxing of distrusted code).
- `'auto'` (opt-in) — buckets by 60-second windows. Fresh isolate per
  shape per 60s window. Use only when (a) you have a small fixed set of
  fn shapes AND (b) you actively want periodic isolate refresh. The
  per-owner LRU is bounded to ~50 entries, so deployments that rotate
  more than 50 distinct shape-windows per hour cause repeated
  cold-start under `'auto'`. The default was switched from `'auto'` to
  `'stable'` after a third-party review surfaced this thrash pattern.

## See also

- `DESIGN.md` — full architectural spec; ADRs; threat model.
- `docs/security.md` — submit-code threat model.
- `docs/tuning.md` — every knob, what it does, when to change it.
- `docs/troubleshooting.md` — error decode tree.
