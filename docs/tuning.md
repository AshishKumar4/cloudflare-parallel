# Tuning

Knobs you can turn to adapt the runtime to your workload.

## Pool-level

| Knob                            | Default        | When to change                                                                                                                                       |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topology`                      | `'auto'`       | Pin to `'in-do' \| 'hybrid' \| 'tree'` for predictable latency. `'auto'` is best for variable input sizes. `'in-do'` only accepts size ≤ 1.          |
| `maxFanOut`                     | `32`           | Per-coordinator RPC fan-out cap. Hybrid topology can dispatch up to this many leaf DOs in one Promise.all turn; sizes above auto-promote to tree.   |
| `branchingFactor`               | `8`            | Tree fan-out width per level. Raise it only after benchmarking a workload that benefits from a wider first tier.                                  |
| `treeThreshold`                 | `maxFanOut`    | Size at which auto-selector promotes from hybrid to tree. Defaults to `maxFanOut`. Raise (and `maxFanOut`) together to keep larger fan-outs flat.   |
| `cacheKeyStrategy`              | `'stable'`     | Default uses `cfp:<fnHash>:slot-<i>` — one isolate per (fn shape, slot). Same slot across calls reuses the same warm isolate; distinct slots within a fan-out give each task its own V8 heap (memory isolation). Use `'fresh'` only when you need a clean heap per call (testing, distrusted code). `'auto'` (60s windows) is opt-in for deployments with a small fixed set of shapes that want periodic refresh. |
| `autoWarm`                      | `true`         | When `true`, the first submit fires `Coordinator.noop()` in parallel with the real dispatch — absorbs the ~300–400 ms DO cold-start off the critical path. Set to `false` only when benchmarking cold-start specifically. Validated 14×–140× per-call speedup. |
| `inProcess`                     | `undefined`    | Pass `ctx.exports.CfpInProcessCoordinator` to skip the Coordinator DO hop for `submit()` (and the rare `pool.map([x], fn)` of size = 1). Per-call dispatch drops from tens of ms to ~1–3 ms. Fan-outs of size ≥ 2 always go through the Coordinator DO so each task lands in its own leaf process. |
| `requestColo`                   | `undefined`    | Pass `req.cf?.colo as string \| undefined` so freshly-created leaf DOs colocate with the request's incoming colo. Best-effort placement, only honored on first DO access.                                                                              |
| `locationHint`                  | `undefined`    | Explicit override for `requestColo`. One of `'wnam' \| 'enam' \| 'sam' \| 'weur' \| 'eeur' \| 'apac' \| 'oc' \| 'afr' \| 'me'`.                                                                                                          |
| `timeout`                       | `30_000`       | Wall-clock budget per submit. Set to less than your Worker's `cpuMs` cap.                                                                            |
| `retries`                       | `0`            | Number of retries on transient errors (DisconnectedError, BackpressureError). Doesn't retry user-thrown errors.                                      |
| `retryDelay`                    | `100`          | Initial backoff in ms; jittered ±25% on each retry.                                                                                                  |
| `bindings`                      | `undefined`    | DO-backed paths use this as a binding-key allow-list resolved against the receiving DO's env. Omit to forward all safe env keys after internal blocklists; pass `pickBindings(env, [...])` to be explicit. |
| `globalOutbound`                | `undefined`    | Omitted/`undefined` inherits outbound fetch for trusted Pool jobs. Set `null` to sandbox outbound fetch; set a `ServiceStub` to proxy via your own Worker. Submit-code surfaces default to `null` unless explicitly overridden. |
| `limits.cpuMs`                  | `30_000`       | Per-isolate CPU cap. enforced by the Workers runtime.                                                                                                                  |
| `limits.subRequests`            | `50`           | Per-isolate subrequest cap.                                                                                                                          |

## Scheduler-level

| Knob                          | Default                | When to change                                                                                                                          |
| ----------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `inFlightLimit`               | `32`                   | Max concurrent jobs in dispatch. Higher = more parallelism but more memory pressure on the scheduler DO.                               |
| `maxQueueDepth`               | `Infinity`             | Set a finite cap to surface backpressure early. Enqueue throws `QueueFullError` past it.                                              |
| `fairCapacityPerTenant`       | `4`                    | Per-tenant in-flight cap inside `inFlightLimit`. Lower = more fairness, higher = more throughput per tenant.                          |
| `retry.max`                   | `3`                    | Retries before status flips to `failed`.                                                                                                |
| `retry.backoff`               | `'exponential'`        | `'exponential'` (×2 each retry) or `'constant'`.                                                                                        |
| `retry.baseMs`                | `200`                  | Base backoff; multiplied by `factor^retryCount`.                                                                                         |
| `deadline.defaultMs`          | `60_000`               | Fallback deadline if neither `deadline` nor `deadlineMs` is set on the job.                                                              |
| `resultRetention.ttlMs`       | `3_600_000`            | How long `done` results linger before sweep. After this, `result()` throws `ResultExpiredError`.                                          |
| `cacheKeyStrategy`            | `'stable'`             | Per-job loader cache strategy. Persisted with the job so retries/restarts keep the same strategy.                                        |
| `bindings`                    | `undefined`            | Binding-key allow-list for scheduled jobs, resolved against the SchedulerDO's env at execution time.                                     |
| `globalOutbound` / `limits` / `workerOptions` | `undefined` | Forwarded to the loaded isolate for scheduled jobs and persisted with each job.                                            |

Unsupported public-constructor fields fail loudly: `store` values other
than `'do-storage'`, `fairness.keyFrom`, and `alarmCadence` throw
`BindingError` instead of being silently ignored. D1 and Queues job
stores remain lower-level adapters; the public `Scheduler` uses the
SQLite-backed SchedulerDO store.

## Observability

| Knob                              | Default     | When to change                                                                                              |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `observability.hooks.*`           | `undefined` | Wire metrics/logging. All hooks are synchronous and errors-isolated — they cannot break the submit path.    |
| `observability.metrics`           | `undefined` | An `AnalyticsEngineDataset` binding. AE points emitted for every event kind (see `src/observability/index.ts`). |
| `observability.tail.bindingName`  | `undefined` | Name of a Service binding on the Coordinator DO's env that the runtime will inject into loaded isolates' `tails:`. |

## Sizing the Worker

For a Pool processing 1000 items at peak:
- `'auto'` → tree (branchingFactor=8, K=2) → root → 8 sub-coords → 8 sub-coords each → about 16 leaves each → **1000 leaf DOs** (one job each).
- Each leaf DO is a separate workerd process with its own V8 scheduler
  thread; CPU parallelism scales with leaf count.
- Worker request total wall = max(per-isolate CPU) + (K+1) × DO RPC hop.
- Memory: each loaded isolate has its own V8 heap; 50/owner LRU bounds
  per leaf process.
