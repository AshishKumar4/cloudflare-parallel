# Troubleshooting

Error decode tree and common gotchas.

## Errors

Every library error extends `ParallelError` and carries `code`,
`httpStatus`, `cause`, and a `toJSON()` round-trip. The hierarchy:

```
ParallelError
├── SerializationError              CFP_SERIALIZATION              400
│   ├── ReturnTooLargeError         CFP_RETURN_TOO_LARGE           413
│   └── DeadlineTooShortError       CFP_DEADLINE_TOO_SHORT         400
├── ExecutionError                  CFP_EXECUTION                  500
│   ├── DisconnectedError           CFP_DISCONNECTED               502
│   ├── OutOfMemoryError            CFP_OUT_OF_MEMORY              507
│   └── BillingLimitError           CFP_BILLING_LIMIT              429
├── TimeoutError                    CFP_TIMEOUT                    504
├── RetryExhaustedError             CFP_RETRY_EXHAUSTED            503
├── BindingError                    CFP_BINDING                    500
│   └── MissingBindingError         CFP_MISSING_BINDING            500
├── CancelledError                  CFP_CANCELLED                  499
├── DeadlineExceededError           CFP_DEADLINE_EXCEEDED          504
├── BackpressureError               CFP_BACKPRESSURE               503
├── ResultExpiredError              CFP_RESULT_EXPIRED             410
├── ConflictError                   CFP_CONFLICT                   409
├── TopologyError                   CFP_TOPOLOGY                   400
├── PolicyRequiredError             CFP_POLICY_REQUIRED            500
└── AggregateExecutionError         CFP_AGGREGATE_EXECUTION        500
```

## Common gotchas

### "Required binding 'CfpCoordinator' is missing"

Add to `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "CfpCoordinator"
class_name = "CfpCoordinator"

[[durable_objects.bindings]]
name = "CfpWorkerDO"
class_name = "CfpWorkerDO"

[[durable_objects.bindings]]
name = "CfpSubCoord"
class_name = "CfpSubCoord"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CfpCoordinator", "CfpWorkerDO", "CfpSubCoord"]
```

And re-export the DO classes from your worker's entry:

```ts
export { CfpCoordinator, CfpWorkerDO, CfpSubCoord } from 'cloudflare-parallel/durable-objects';
```

See the README "Wiring up" section for the full wrangler.toml snippet.

### "this is undefined inside my user fn"

User fns are serialized via `Function.prototype.toString` and reloaded
in a fresh isolate. **Closures over outer variables are silently lost.**

Bad:
```ts
const greeting = 'hello';
pool.submit(async (name: string) => `${greeting}, ${name}`, 'world');
// ❌ greeting is undefined inside the isolate
```

Good:
```ts
pool.submit(async (greeting: string, name: string) => `${greeting}, ${name}`, 'hello', 'world');
// ✅ pass everything as args
```

Or use `pool.context`:
```ts
const pool = Parallel.pool(env, { context: { greeting: 'hello' } });
pool.submit(
  async (name: string, env: { greeting: string }) => `${env.greeting}, ${name}`,
  'world',
);
```

### "BackpressureError on every submit"

Symptoms: 503 + `code: CFP_BACKPRESSURE` repeatedly. Cause: 50/owner
LRU is thrashing — your fn shapes are too varied (each unique
`(fnHash, isolateOptions)` pair is one cache slot).

Fixes:
1. Set `cacheKeyStrategy: 'stable'` if your fn doesn't close over
   per-call values. This collapses isolate variants.
2. Reduce the number of distinct `workerOptions` (compatibilityFlags,
   limits) you pass per call — each variant is its own cache key.
3. Inspect `pool.stats().lruEvictionLast60sCount` — if non-zero,
   you're hitting the LRU.

### "Sub-second deadlines rejected"

By design. The library enforces a 1s minimum budget — sub-second
deadlines do not survive coordinator clock skew + RPC overhead in
practice. See DESIGN §9.5.

If you need sub-second cancellation, use `CancelToken` instead of
deadlines.

### "User fn returned an RPC stub"

The validator catches this — RPC stubs cannot cross isolate
boundaries (same restriction as Cloudflare RPC). Return a serializable
representation instead.

### "structuredClone failed: function could not be cloned"

Your args contain a function. Move it into the fn body or pass via
`pool.context`. The runtime structured-clones args before they cross
the wire.

### Tail Worker not receiving events

Set `observability.tail.bindingName: 'TAIL_WORKER'` on the Pool, where
`TAIL_WORKER` is a Service binding on the Coordinator DO's env (NOT
the caller Worker's env). The library resolves the name DO-side
because `ServiceStub` itself isn't structured-clone-safe.

### "PolicyRequiredError" from `Parallel.vm`

`policy` is required. There is no default. Pick one:

```ts
{ kind: 'auth', auth: bearerAuth(token) }   // bearer token
{ kind: 'auth', auth: hmacAuth({ secret }) } // HMAC body signing
{ kind: 'public' }                           // explicit opt-in (logs warning)
```

## Debug tips

- `pool.stats()` reports the last topology decision and LRU thrash count.
- `pool.observability.hooks.onTaskError` fires for every failure.
- Check tail worker output — `console.log` from inside loaded isolates
  shows up in tail.
