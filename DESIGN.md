# DESIGN

This document describes the current implementation of
`cloudflare-parallel`. It is intentionally source-aligned: when in
doubt, verify against `src/`.

## Purpose

`cloudflare-parallel` is a TypeScript library for CPU-bound parallelism
on Cloudflare Workers. It decomposes one request into many independent
Worker Loader isolates. For real CPU parallelism, fan-out tasks are
placed on separate leaf Durable Objects, because each leaf DO runs in a
separate workerd process with its own V8 scheduler thread.

Use the library for CPU-heavy tasks such as hashing, parsing, image
transforms, simulations, raytracing, and build steps. Do not use it for
plain I/O fan-out; one isolate plus `Promise.all` already overlaps I/O.

## Public Entry Points

The package exports five runtime factories:

- `Parallel.pool(env, opts?)`: main DO-backed CPU fan-out surface.
- `Parallel.loaderOnly(env, opts?)`: direct Worker Loader path, capped
  by the fetch-handler loader budget.
- `Parallel.actor(env, opts)`: stateful actor backed by the coordinator
  DO's storage.
- `Parallel.scheduler(env, opts)`: durable queued jobs backed by
  `CfpSchedulerDO`.
- `Parallel.vm(env, opts)`: HTTP submit-code wrapper around
  `submitCodeHandler`.

The durable-object classes are exported from
`cloudflare-parallel/durable-objects`:

- `CfpCoordinator`
- `CfpWorkerDO`
- `CfpSubCoord`
- `CfpInProcessCoordinator`
- `CfpSchedulerDO`

Testing fakes are exported from `cloudflare-parallel/testing`.

## Topology

The selector in `src/topology/selector.ts` is the topology source of
truth.

| Size | Topology | Behavior |
| ---: | --- | --- |
| `0` | `in-do` | Empty result fast path. |
| `1` | `in-do` | Single loaded isolate, no fan-out. |
| `2..maxFanOut` | `hybrid` | One leaf DO per job. Default `maxFanOut` is 32. |
| `> maxFanOut` | `tree` | Root coordinator delegates to sub-coordinators, then leaf DOs. |

`branchingFactor` defaults to 8 and must be in `[4, 16]`.
`treeThreshold` defaults to `maxFanOut`. Explicit `topology: 'in-do'`
rejects size greater than 1. Explicit `topology: 'hybrid'` rejects
sizes greater than `maxFanOut`.

The important invariant: the library dispatches one job per leaf DO for
fan-outs. Loaders inside one workerd process share that process's V8
thread and serialize on CPU; DO count is what multiplies CPU.

## Dispatch Pipeline

For `pool.map(fn, items)`:

1. `Pool` serializes `fn` with `Function.prototype.toString()`.
2. `hashSource` produces a stable base-36 hash used for cache keys and
   observability.
3. `Pool` builds a deadline/cancel envelope and sends `runMany` to the
   dispatch target.
4. Size 1 may use the in-process loopback when
   `inProcess: ctx.exports.CfpInProcessCoordinator` is configured.
5. Size 2 and above routes through `CfpCoordinator`.
6. Hybrid dispatch opens one pipelinable session per `CfpWorkerDO` leaf.
7. Tree dispatch recursively delegates to `CfpSubCoord` tiers until the
   bottom tier opens leaf sessions.
8. Leaf DOs call Worker Loader with generated module source and return
   structured-clone-safe results or marshalled errors.

`ctx.exports.CfpInProcessCoordinator` is only for single-job dispatch:
`submit()` and the rare `pool.map([x], fn)`. Fan-outs of size 2 or more
use the coordinator DO so each task lands on a separate leaf process.

## Worker Loader Code

`src/loader/codegen.ts` generates ES module source exporting a
`WorkerEntrypoint` class. User functions are baked into the generated
module; the parent Worker does not `eval` submitted source.

Generated source:

- embeds JSON-canonicalized `context` values as module-scope `const`
  declarations;
- reconstructs `env.signal` as a real `AbortSignal`;
- removes internal `cancelStream` and `cfpSql` keys from user-visible
  env;
- validates return values and rejects RPC stubs;
- seals `caches.default` when `globalOutbound: null`.

`buildWorkerCode` sets `globalOutbound: null` when no worker options are
provided. Pool/Actor/Scheduler intentionally pass worker options so
their omitted `globalOutbound` means inherit. Submit-code paths override
that default to sandboxed unless the original pool explicitly opted into
another outbound policy.

## Cache Keys

Default `cacheKeyStrategy` is `'stable'`.

Stable keys are shaped like `cfp:<fnHash>:slot-<i>`. Each task in one
fan-out receives a distinct slot so concurrent work gets distinct
isolates. The same function shape and slot reuse a warm isolate across
later calls.

`'fresh'` forces a fresh key per call. `'auto'` buckets by 60-second
windows and is useful only for a small fixed set of function shapes that
need periodic refresh.

## Bindings And Capabilities

`src/loader/sandbox.ts` is the binding security source of truth.

The loader strips:

- `LOADER`
- `Cfp*` internal Durable Object bindings
- lowercase `cfp*` internal capability proxies

For DO-backed paths, `bindings:` is an allow-list declaration. The
actual values are resolved from the receiving DO's env, then filtered by
that allow-list before crossing into the loaded isolate. If `bindings`
is omitted, the historical behavior is preserved: all safe env keys are
forwarded after the internal blocklist.

For `Parallel.loaderOnly`, `bindings` values are passed directly because
there is no intermediate DO RPC hop.

`pickBindings(env, keys)` is a convenience helper for building explicit
allow-lists. It is not the security boundary; the loader sanitizer is.

## Submitted Code

`submitCodeHandler` and `Parallel.vm` require a `policy`. There is no
implicit public endpoint. `{ kind: 'public' }` is an explicit opt-in and
logs a one-time warning.

Submitted-code paths apply three extra restrictions:

- `policy.allowBindings` defaults to `[]`.
- request body and function source default to 64 KiB limits.
- loaded workers default to `globalOutbound: null` unless the original
  pool explicitly opted into a different outbound policy.

`bearerAuth(secret)` compares the full `Authorization: Bearer <secret>`
header in constant time. `hmacAuth` signs
`${timestamp}\n${bodyText}` with HMAC-SHA-256, where `bodyText` is read
from `req.clone().text()`.

## Cancellation And Deadlines

Cancellation uses `CancelToken`. The caller-side token writes one chunk
to a `ReadableStream`; coordinator and leaf DOs forward or fork that
stream; generated worker code converts it into `env.signal`.

The signal is cooperative. Awaiting Web APIs can reject promptly, and
user code can call `env.signal.throwIfAborted()`. Tight synchronous
loops still run until runtime CPU/deadline limits because Worker Loader
does not expose a kill primitive.

Deadlines are absolute epoch milliseconds internally. The deadline
builder rejects budgets below the minimum required for safe RPC
propagation.

## Scheduler

`Parallel.scheduler` uses `CfpSchedulerDO` with SQLite-backed DO
storage. `Dispatcher` is a pure reactive core:

- storage is canonical;
- ready/running sets are derived in memory;
- jobs are claimed with CAS by job id;
- round-robin dispatch uses `tenantId`;
- `inFlightLimit`, `maxQueueDepth`, and `fairCapacityPerTenant` govern
  throughput and fairness;
- retries use the persisted `RetryPolicy`;
- alarms are only a backstop for retry wakeups, result TTL sweep, and
  expired lease reclaim.

The public constructor wires these options:

- `deadline.defaultMs`
- `retry`
- `resultRetention.ttlMs`
- `inFlightLimit`
- `maxQueueDepth`
- `fairCapacityPerTenant`
- `cacheKeyStrategy`
- `bindings`
- `globalOutbound`, `limits`, and `workerOptions`
- `locationHint` / `requestColo`
- `observability`

Unsupported public-constructor fields fail loudly:

- `store` other than `'do-storage'`
- `fairness.keyFrom`
- `alarmCadence`

D1 and Queues job-store adapters exist as lower-level implementations,
but they are not selectable through `Parallel.scheduler(...)`.

## Observability

`observability.hooks` receives in-process events and is error-isolated.
`observability.metrics` accepts an `AnalyticsEngineDataset` binding or
`'off'`. `observability.tail.bindingName` sends a Service binding name
over RPC so the receiving DO can resolve it from its own env and inject
it into loaded isolates' `tails`.

## Return Values

Return values must be structured-clone-safe or a `ReadableStream`.
RPC stubs are rejected. Non-stream payloads above the runtime payload
limit surface as typed serialization errors; the library does not
auto-convert large returns into streams.

`submitStream` is currently a convenience for a single task that returns
a `ReadableStream`. It is not a separate fan-out streaming protocol.

## Error Model

All public errors extend `ParallelError` and carry stable `CFP_*` codes,
recommended HTTP status, JSON round-tripping, and cause chains where
available. Errors thrown inside loaded isolates are marshalled back into
typed library errors at the API boundary.

## Compatibility

Use `compatibility_date = "2026-01-20"` or newer. The in-process
coordinator loopback requires `compatibility_flags = ["enable_ctx_exports"]`.

The required Worker Loader binding is named `LOADER`. Full pool fan-out
requires `CfpCoordinator`, `CfpWorkerDO`, and `CfpSubCoord` Durable
Object bindings. Scheduler requires `CfpSchedulerDO`.
