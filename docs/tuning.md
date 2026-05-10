# Tuning

Knobs you can turn to adapt the runtime to your workload.

## Pool-level

| Knob                            | Default        | When to change                                                                                                                                       |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topology`                      | `'auto'`       | Pin to `'in-do' \| 'hybrid' \| 'tree'` for predictable latency. `'auto'` is best for variable input sizes.                                            |
| `branchingFactor`               | `8`            | Tree fan-out width per level. `4` for narrower trees (more depth, less coordinator pressure); `16` for wider (less depth, more leaves).             |
| `treeThreshold`                 | `256`          | Size at which auto-selector promotes from hybrid to tree. Lower if your fn is CPU-heavy and you want more leaf parallelism sooner.                  |
| `fanOutCap`                     | `1024`         | Hard ceiling on items per fan-out call. Beyond this, throws `TopologyError`.                                                                         |
| `cacheKeyStrategy`              | `'stable'`     | Default reuses one isolate per fn shape — best warmth and no LRU thrash. Use `'fresh'` only when you need a clean V8 heap per call (testing, distrusted code). `'auto'` (60s windows) is opt-in for deployments with a small fixed set of shapes that want periodic refresh. |
| `timeout`                       | `30_000`       | Wall-clock budget per submit. Set to less than your Worker's `cpuMs` cap.                                                                            |
| `retries`                       | `0`            | Number of retries on transient errors (DisconnectedError, BackpressureError). Doesn't retry user-thrown errors.                                      |
| `retryDelay`                    | `100`          | Initial backoff in ms; jittered ±25% on each retry.                                                                                                  |
| `globalOutbound`                | `undefined`    | `null` to sandbox outbound fetch; `ServiceStub` to proxy via your own Worker.                                                                        |
| `limits.cpuMs`                  | `30_000`       | Per-isolate CPU cap. enforced by the Workers runtime.                                                                                                                  |
| `limits.subRequests`            | `50`           | Per-isolate subrequest cap.                                                                                                                          |

## Scheduler-level

| Knob                          | Default                | When to change                                                                                                                          |
| ----------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `inFlightLimit`               | `32`                   | Max concurrent jobs in dispatch. Higher = more parallelism but more memory pressure on the scheduler DO.                               |
| `maxQueueDepth`               | `Infinity`             | Set a finite cap to surface backpressure early. Enqueue throws `QueueFullError` past it.                                              |
| `fairCapacityPerTenant`       | `4`                    | Per-tenant in-flight cap inside `inFlightLimit`. Lower = more fairness, higher = more throughput per tenant.                          |
| `defaultLeaseMs`              | `60_000`               | Lease duration for a claimed job. Crashed workers' leases expire and are reclaimed.                                                    |
| `retry.max`                   | `3`                    | Retries before status flips to `failed`.                                                                                                |
| `retry.backoff`               | `'exponential'`        | `'exponential'` (×2 each retry) or `'constant'`.                                                                                        |
| `retry.baseMs`                | `200`                  | Base backoff; multiplied by `factor^retryCount`.                                                                                         |
| `deadline.defaultMs`          | `60_000`               | Fallback deadline if neither `deadline` nor `deadlineMs` is set on the job.                                                              |
| `resultRetention.ttlMs`       | `3_600_000`            | How long `done` results linger before sweep. After this, `result()` throws `ResultExpiredError`.                                          |

## Observability

| Knob                              | Default     | When to change                                                                                              |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `observability.hooks.*`           | `undefined` | Wire metrics/logging. All hooks are synchronous and errors-isolated — they cannot break the submit path.    |
| `observability.metrics`           | `undefined` | An `AnalyticsEngineDataset` binding. AE points emitted for every event kind (see `src/observability/index.ts`). |
| `observability.tail.bindingName`  | `undefined` | Name of a Service binding on the Coordinator DO's env that the runtime will inject into loaded isolates' `tails:`. |

## Sizing the Worker

For a Pool processing 1000 items at peak:
- `'auto'` → tree (branchingFactor=8, depth=2) → 64 leaves, 256 isolates.
- Each leaf DO is a separate Workers instance, billed separately.
- Worker request total CPU = max(per-isolate CPU) + DO RPC overhead.
- Memory: each loaded isolate has its own V8 heap; 50/owner LRU bounds.
