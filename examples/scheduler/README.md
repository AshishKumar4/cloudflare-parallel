# scheduler

Heterogeneous job scheduler with retries, deadlines, idempotency keys,
and per-tenant cancel.

## What it shows

- **`Parallel.scheduler` end-to-end.** Enqueue jobs from a fetch
  handler, store them in a `CfpSchedulerDO`-backed durable queue, run
  them on Worker Loader isolates, observe results via long-poll.
- **Reactive dispatch.** No alarm-batched delay — jobs start the moment
  they hit the queue. Throughput bounded only by `inFlightLimit ×
  loader-cap-per-isolate`. See DESIGN §8.10.
- **Fair queueing across tenants.** `tenantId` keys round-robin so
  one chatty tenant cannot starve others.
- **Idempotency.** `idempotencyKey` collisions are deduped at the
  storage layer (CAS on `UNIQUE` index); user fns submitted twice with
  the same key run once.
- **Result retention.** `resultRetention.ttlMs` controls how long the
  result row lingers after `done`. Reads after expiry surface as
  `ResultExpiredError`.

## How to run

```bash
cd examples/scheduler
bun install
bun x wrangler dev
# Enqueue:
curl -X POST 'http://localhost:8787/enqueue' \
  -H 'Content-Type: application/json' \
  -d '{"tenant":"acme","n":1000000}'
# → { "jobId": "j-..." }

# Poll for result:
curl 'http://localhost:8787/result?id=j-...'
# → { "status": "done", "value": 499999500000 }
```

## What to learn

- Scheduler-submitted fns **must be idempotent.** The library
  guarantees at-most-once *result observability* but at-least-once
  *execution*. Lease expiry on a crashed worker triggers a re-run.
- The handle returned by `enqueue` is not serializable across requests.
  Production code typically polls `/result?id=...` and lets the
  scheduler DO do the work.
- `cancelByTenant('acme')` flips every active job for that tenant to
  `cancelled` in one call.
