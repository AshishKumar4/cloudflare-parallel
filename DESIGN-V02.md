# cloudflare-parallel v0.2.0 — Design Spec

## 1. Binding Passthrough (env forwarding via ctx.exports)

### Problem
Dynamic workers currently get `globalOutbound: null` and no bindings. They can't access KV, R2, D1, Durable Objects, AI, or make network requests.

### Solution
Add a `bindings` option to PoolOptions that lets users forward their env bindings to dynamic workers. The pool wraps these as service binding stubs via the `ctx.exports` pattern.

### API Design
```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: {
    AI: env.AI,
    KV: env.MY_KV,
    DB: env.DB,
  },
  // globalOutbound controls network access:
  // null = sandboxed (default), undefined = inherit parent's network
  globalOutbound: null,
});

// Now tasks can access bindings:
await pool.submit(async (prompt, env) => {
  const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
    messages: [{ role: 'user', content: prompt }],
  });
  return result.response;
}, "Hello!");
```

### Implementation
- In `codegen.ts`: The generated worker source needs to pass `env` through to the function. Change `execute(...args)` to `execute(...args)` where the function receives `env` as the last argument automatically when bindings are configured.
- In `pool.ts`: Accept `bindings` in PoolOptions. Pass them into `buildWorkerCode()` as the `env` field of WorkerCode.
- The `env` field in WorkerCode supports structured-clonable values AND service binding stubs. Cloudflare service bindings (KV, R2, AI, DO namespaces) are already service stubs — they pass through directly.
- IMPORTANT: The function signature changes. When bindings are configured, the generated worker passes `env` as an additional argument. The codegen must handle this.

### Generated Worker Source (with bindings)
```js
import { WorkerEntrypoint } from "cloudflare:workers";

const __fn__ = (prompt, env) => { /* user code */ };

export default class extends WorkerEntrypoint {
  execute(...args) {
    // Pass env as the last argument when bindings are present
    return __fn__(...args, this.env);
  }
}
```

Wait — actually simpler: the dynamic worker's `this.env` IS the bindings we passed. So the function just needs `env` appended. But we need the user to know their function will receive `env` as the last arg.

Actually, better API — make it explicit:

```ts
// Option A: env is always last arg when bindings are set
await pool.submit((x: number, env: Env) => env.KV.get("key"), 42);

// Option B: pool.withEnv() returns pool where all fns get env  
const envPool = pool.withEnv({ AI: env.AI });
await envPool.submit(async (prompt: string, env) => { ... }, "hello");
```

Go with Option A — simpler, one pool config, env is always last arg when bindings exist.

## 2. Closure Capture (context serialization)

### Problem
```ts
const multiplier = 3;
await pool.submit((x) => x * multiplier, 5); // BREAKS — multiplier is undefined
```
Functions are serialized via `fn.toString()` which loses closure scope.

### Solution
Add a `pool.capture()` or `withContext()` method that lets users explicitly declare variables to capture. These get JSON-serialized and embedded as constants in the generated module.

### API Design
```ts
const multiplier = 3;
const prefix = "result";

// Explicit capture via context object
await pool.submit(
  (x, ctx) => `${ctx.prefix}: ${x * ctx.multiplier}`,
  5,
  { context: { multiplier, prefix } }
);

// Or via submit options:
await pool.submit(fn, ...args, { context: { multiplier } });
```

Wait, that's ambiguous with args. Better:

```ts
// Clean API: context is a pool-level or per-call option
const pool = Parallel.pool(env.LOADER, {
  context: { multiplier: 3, prefix: "result" }
});

// OR per-call:
await pool.submit((x) => x * multiplier, [5], {
  context: { multiplier, prefix }
});
```

Hmm, but the function body references `multiplier` directly — we need to inject it into the module scope. The generated worker should look like:

```js
import { WorkerEntrypoint } from "cloudflare:workers";

// Injected context variables
const multiplier = 3;
const prefix = "result";

const __fn__ = (x) => `${prefix}: ${x * multiplier}`;

export default class extends WorkerEntrypoint {
  execute(...args) {
    return __fn__(...args);
  }
}
```

This way the function body references `multiplier` and `prefix` naturally — they're module-level constants. The user writes normal code, we embed the captured values.

### Implementation
- Add `context?: Record<string, unknown>` to PoolOptions and to per-call options (SubmitOptions, MapOptions, etc.)
- In `codegen.ts`: Serialize each context value as `const <key> = <JSON.stringify(value)>;` and prepend to the module source before the function.
- Context values must be JSON-serializable (structured clonable).
- Per-call context merges with (and overrides) pool-level context.

## 3. Timeouts & Retries

### API Design
```ts
const pool = Parallel.pool(env.LOADER, {
  timeout: 5000,        // 5s per task
  retries: 3,           // retry up to 3 times
  retryDelay: 100,      // 100ms between retries (doubles each time)
});

// Or per-call:
await pool.submit(fn, 42, { timeout: 10000, retries: 2 });

// Map with partial failure handling:
const results = await pool.map(fn, items, {
  onError: 'skip',  // 'throw' (default) | 'skip' | 'null'
});
// With 'skip': failed items are omitted from results
// With 'null': failed items become null in results array
```

### Implementation
- In `pool.ts` `#dispatch`: Wrap the RPC call with `Promise.race([task, timeout])`.
- On timeout, throw `TimeoutError` (already exists in errors.ts).
- Retry logic wraps `#dispatch` — on failure, wait `retryDelay * 2^attempt`, retry up to N times.
- `map()` and `scatter()` get `onError` option for partial failure handling.

## 4. Streaming Results (Async Iterators)

### API Design
```ts
// Returns results as they complete (not in order)
for await (const { index, value } of pool.mapStream(fn, items)) {
  console.log(`Item ${index} = ${value}`);
}

// Ordered async iterator
for await (const value of pool.mapOrdered(fn, items, { concurrency: 10 })) {
  // yields in original order, buffering as needed
}
```

### Implementation
- `mapStream()` returns `AsyncIterable<{ index: number, value: T }>` — yields results as isolates complete, unordered.
- `mapOrdered()` returns `AsyncIterable<T>` — buffers and yields in original index order.
- Both support `concurrency` option.
- Use a simple channel pattern: dispatch tasks, resolve promises into a shared queue, yield from queue.

## File Changes Summary

- `src/errors.ts` — Add `RetryExhaustedError`
- `src/serialize.ts` — No changes needed
- `src/codegen.ts` — Add context variable injection, env passthrough in execute()
- `src/pool.ts` — Major changes: new options types, timeout/retry wrapper, streaming methods, binding/context forwarding
- `src/types.ts` — No changes needed  
- `src/index.ts` — Export new types
- `src/primitives.ts` — No changes needed
