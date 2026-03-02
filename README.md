# cloudflare-parallel

**True parallelism on Cloudflare Workers.** Dispatch functions to isolated V8 runtimes, fan out across hundreds of cores, and collect results — all from a single Worker deployment.

`cloudflare-parallel` uses the [Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) to spin up fresh isolates on demand. No separate executor workers. No `unsafe_eval`. No HTTP/JSON overhead. Just native RPC.

```ts
import { Parallel } from "cloudflare-parallel";

const pool = Parallel.pool(env.LOADER, {
  bindings: { AI: env.AI, KV: env.MY_KV },
  timeout: 5000,
  retries: 2,
});

// Fan out AI inference across 3 models simultaneously
const responses = await pool.map(
  async (model: string, env) => {
    const res = await env.AI.run(model, { messages: [{ role: "user", content: prompt }] });
    return res.response;
  },
  ["@cf/meta/llama-3-8b-instruct", "@cf/mistral/mistral-7b-instruct-v0.1", "@cf/google/gemma-7b-it"],
);
```

> **Note:** The Worker Loader API is currently in **closed beta**. It works locally in `wrangler dev` (miniflare) today. Production deployment requires beta access.

---

## Table of Contents

- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Binding Passthrough](#binding-passthrough)
- [Context Capture](#context-capture)
- [Timeouts and Retries](#timeouts-and-retries)
- [Error Handling](#error-handling)
- [Streaming](#streaming)
- [Examples](#examples)
- [How It Works](#how-it-works)

---

## Quick Start

### Install

```bash
npm install cloudflare-parallel
```

### Configure `wrangler.toml`

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[worker_loaders]]
binding = "LOADER"
```

### Write your worker

```ts
import { Parallel } from "cloudflare-parallel";
import type { WorkerLoader } from "cloudflare-parallel";

interface Env {
  LOADER: WorkerLoader;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pool = Parallel.pool(env.LOADER);

    // Single task on a remote isolate
    const result = await pool.submit((x: number) => x * x, 42);

    // Parallel map across isolates
    const squares = await pool.map((n: number) => n * n, [1, 2, 3, 4, 5]);

    return Response.json({ result, squares });
  },
};
```

### Run

```bash
npx wrangler dev
```

One worker, one deployment. Each task runs in its own V8 isolate.

---

## API Reference

### `Parallel.pool(loader, opts?)`

Create a `WorkerPool` from a Worker Loader binding.

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: { AI: env.AI },     // forward bindings to isolates
  context: { threshold: 0.5 },  // capture variables for all tasks
  timeout: 5000,                // per-task timeout (ms)
  retries: 3,                   // retry failed tasks
  retryDelay: 100,              // base delay between retries (doubles each time)
});
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `bindings` | `Record<string, unknown>` | — | Env bindings forwarded to isolates (KV, R2, AI, D1, DO) |
| `context` | `Record<string, unknown>` | — | Variables injected into module scope |
| `timeout` | `number` | — | Per-task timeout in ms |
| `retries` | `number` | `0` | Max retry attempts on failure |
| `retryDelay` | `number` | `100` | Base retry delay in ms (exponential backoff) |
| `globalOutbound` | `null \| undefined` | `null` | Network access: `null` = sandboxed, `undefined` = inherit |

---

### `pool.submit(fn, ...args, opts?)`

Execute a single function on a remote isolate.

```ts
const result = await pool.submit((x: number) => x * x, 42);
// => 1764

// With per-call options:
const result = await pool.submit(heavyFn, data, {
  timeout: 10_000,
  retries: 2,
  context: { config: myConfig },
});
```

---

### `pool.map(fn, items, opts?)`

Parallel map: invoke `fn` once per item, each in its own isolate.

```ts
const doubled = await pool.map((n: number) => n * 2, [1, 2, 3, 4]);
// => [2, 4, 6, 8]
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | `items.length` | Max in-flight tasks |
| `onError` | `'throw' \| 'skip' \| 'null'` | `'throw'` | How to handle per-item failures |
| `context` | `Record<string, unknown>` | — | Per-call context variables |
| `timeout` | `number` | — | Per-task timeout override |

---

### `pool.reduce(fn, items, initial)`

Tree-parallel reduce. Pairs adjacent items and reduces in parallel rounds — **O(log n)** depth instead of O(n).

```ts
const sum = await pool.reduce((a: number, b: number) => a + b, [1, 2, 3, 4, 5], 0);
// => 15
```

---

### `pool.pmap(fn)`

Chunked parallel map (JAX-style). Returns a curried function that splits input into chunks and maps each chunk on a separate isolate.

```ts
const pmapped = pool.pmap((batch: number[]) => batch.map(x => x * x));
const results = await pmapped([1, 2, 3, 4, 5, 6], { chunks: 3 });
// => [1, 4, 9, 16, 25, 36]
```

---

### `pool.pipe(fn1, fn2, ...fnN)`

Sequential pipeline where each stage runs on its own isolate. Output of one stage feeds into the next.

```ts
const pipeline = pool.pipe(
  (s: string) => s.toLowerCase(),
  (s: string) => s.split(" "),
  (words: string[]) => words.length,
);

const count = await pipeline("Hello World");
// => 2
```

Supports up to 5 typed stages; additional stages fall back to `any`.

---

### `pool.scatter(fn, items, chunks)`

Split items into N chunks, invoke `fn` on each chunk in parallel, return per-chunk results.

```ts
const chunkSums = await pool.scatter(
  (chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
  [1, 2, 3, 4, 5, 6],
  3,
);
// => [3, 7, 11]
```

---

### `pool.gather(promises)`

`Promise.all` wrapper for symmetry with `scatter`.

```ts
const results = await pool.gather([
  pool.submit((x: number) => x + 1, 1),
  pool.submit((x: number) => x + 2, 2),
]);
// => [2, 4]
```

---

### `pool.mapStream(fn, items, opts?)`

Returns results as they complete (unordered). Yields `{ index, value }` pairs.

```ts
for await (const { index, value } of pool.mapStream(fn, items)) {
  console.log(`Item ${index} = ${value}`);
}
```

---

### `pool.mapOrdered(fn, items, opts?)`

Ordered async iterator. Buffers internally and yields values in original index order.

```ts
for await (const value of pool.mapOrdered(fn, items, { concurrency: 10 })) {
  process.stdout.write(value);
}
```

---

### `pure(fn)` / `constant(value)`

Utility functions for purity validation and intent signaling.

```ts
import { pure, constant } from "cloudflare-parallel";

const double = pure((x: number) => x * 2);   // validates no `this` references
const threshold = constant(0.5);              // documents serializable intent
```

---

## Binding Passthrough

Dynamic isolates created by the Worker Loader have no bindings by default — no KV, no AI, no network access. Binding passthrough solves this by forwarding your env bindings to the isolates.

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: {
    AI: env.AI,           // Workers AI
    KV: env.MY_KV,        // KV namespace
    DB: env.DB,           // D1 database
    BUCKET: env.R2,       // R2 bucket
    COUNTER: env.DO,      // Durable Object namespace
  },
});
```

When `bindings` are configured, your dispatched function receives `env` as its **last argument**:

```ts
// env is automatically appended when bindings are set
await pool.submit(async (prompt: string, env) => {
  const result = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });
  return result.response;
}, "What is the meaning of life?");
```

This works with all pool methods — `map`, `scatter`, `pmap`, etc.:

```ts
// Fan out AI inference across models
const models = ["@cf/meta/llama-3-8b-instruct", "@cf/mistral/mistral-7b-instruct-v0.1"];

const responses = await pool.map(
  async (model: string, env) => {
    const res = await env.AI.run(model, {
      messages: [{ role: "user", content: "Hello" }],
    });
    return { model, response: res.response };
  },
  models,
);
```

### Network Access

Control outbound network access with `globalOutbound`:

```ts
// Sandboxed (default) — fetch() and connect() throw inside isolates
Parallel.pool(env.LOADER, { bindings: { AI: env.AI } });

// Inherit parent's network — isolates can make arbitrary HTTP requests
Parallel.pool(env.LOADER, { globalOutbound: undefined });
```

---

## Context Capture

Functions dispatched to isolates are serialized via `.toString()`, which means closed-over variables are lost. Context capture lets you explicitly declare values to embed in the isolate's module scope.

```ts
const multiplier = 3;
const prefix = "result";

// Without context capture — BROKEN: multiplier and prefix are undefined
await pool.submit((x) => `${prefix}: ${x * multiplier}`, 5);

// With context capture — works: values are injected as module-level constants
await pool.submit(
  (x) => `${prefix}: ${x * multiplier}`,
  5,
  { context: { multiplier, prefix } },
);
// => "result: 15"
```

Context can be set at the pool level (applies to all tasks) or per-call (merges with and overrides pool-level context):

```ts
// Pool-level context
const pool = Parallel.pool(env.LOADER, {
  context: { version: "2.0", maxRetries: 3 },
});

// Per-call context (overrides pool-level for this call)
await pool.submit(fn, arg, {
  context: { version: "2.1" },  // overrides pool-level version
});
```

The generated isolate module looks like:

```js
// Injected context variables
const multiplier = 3;
const prefix = "result";

const __fn__ = (x) => `${prefix}: ${x * multiplier}`;
// ...
```

Context values must be JSON-serializable.

---

## Timeouts and Retries

### Timeouts

Set per-task deadlines at the pool or per-call level. Tasks that exceed their deadline throw `TimeoutError`.

```ts
const pool = Parallel.pool(env.LOADER, {
  timeout: 5000,  // 5s default for all tasks
});

// Override per-call
await pool.submit(slowFn, data, { timeout: 30_000 });
```

### Retries

Failed tasks can be automatically retried with exponential backoff.

```ts
const pool = Parallel.pool(env.LOADER, {
  retries: 3,       // up to 3 retry attempts
  retryDelay: 100,  // 100ms, 200ms, 400ms between retries
});
```

After all retries are exhausted, a `RetryExhaustedError` is thrown containing the last error and the number of attempts.

### Partial Failure with `onError`

When using `map` or `scatter`, you can handle per-item failures gracefully instead of failing the entire batch:

```ts
// 'throw' (default) — one failure aborts everything
const results = await pool.map(fn, items);

// 'null' — failed items become null in the results array
const results = await pool.map(fn, items, { onError: "null" });
// => [value, null, value, value, null]

// 'skip' — failed items are omitted entirely
const results = await pool.map(fn, items, { onError: "skip" });
// => [value, value, value]
```

---

## Error Handling

All library errors extend `ParallelError`:

| Error | When |
|---|---|
| `SerializationError` | Function cannot be serialized (e.g., contains unsupported syntax) |
| `ExecutionError` | Remote isolate throws during execution |
| `TimeoutError` | Task exceeds its deadline |
| `RetryExhaustedError` | All retry attempts failed |
| `BindingError` | Worker Loader binding is missing or misconfigured |

```ts
import {
  ExecutionError,
  TimeoutError,
  RetryExhaustedError,
} from "cloudflare-parallel";

try {
  await pool.submit(riskyFn, data, { timeout: 5000, retries: 2 });
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(`Timed out after ${err.deadlineMs}ms`);
  } else if (err instanceof RetryExhaustedError) {
    console.log(`Failed after ${err.attempts} attempts: ${err.lastError.message}`);
  } else if (err instanceof ExecutionError) {
    console.log(`Remote error: ${err.remoteMessage}`);
    console.log(err.remoteStack);
  }
}
```

---

## Streaming

Process results as they arrive instead of waiting for all tasks to complete.

### `mapStream` — Unordered, as-completed

```ts
for await (const { index, value } of pool.mapStream(processItem, items, { concurrency: 20 })) {
  // Results arrive as isolates finish — not necessarily in order
  await writeToStream(`Item #${index}: ${value}\n`);
}
```

### `mapOrdered` — Buffered, original order

```ts
for await (const value of pool.mapOrdered(processItem, items, { concurrency: 20 })) {
  // Values yield in original index order
  // Internally buffers fast-completing items until their turn
  results.push(value);
}
```

Both methods respect `concurrency` limits and integrate with timeouts and retries.

---

## Examples

### Basic Parallel Map

```ts
const pool = Parallel.pool(env.LOADER);
const results = await pool.map((url: string) => {
  return fetch(url).then(r => r.status);
}, urls);
```

### AI Fanout (Binding Passthrough)

Fan out a prompt to multiple AI models and collect responses. See [`examples/ai-fanout/`](./examples/ai-fanout/) for the full runnable example.

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: { AI: env.AI },
  timeout: 30_000,
  retries: 1,
});

const models = [
  "@cf/meta/llama-3-8b-instruct",
  "@cf/mistral/mistral-7b-instruct-v0.1",
  "@cf/google/gemma-7b-it",
];

const responses = await pool.map(
  async (model: string, env) => {
    const res = await env.AI.run(model, {
      messages: [{ role: "user", content: "Explain quantum computing" }],
    });
    return { model, response: res.response };
  },
  models,
  { onError: "null" },
);
```

### Scatter-Gather Data Processing

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: { KV: env.RESULTS },
  context: { batchId: crypto.randomUUID() },
});

// Process a large dataset in chunks across isolates
const chunkResults = await pool.scatter(
  (chunk: DataRow[]) => {
    const processed = chunk.map(row => transform(row));
    return { count: processed.length, checksum: hash(processed) };
  },
  dataset,
  10,
);
```

### Pipeline with Context

```ts
const pipeline = pool.pipe(
  (raw: string) => JSON.parse(raw),
  (data: Record<string, unknown>) => validate(data),
  (valid: ValidData) => enrich(valid),
);

const result = await pipeline(rawInput);
```

---

## How It Works

1. You call `pool.submit(fn, ...args)`.
2. The library serializes `fn` via `.toString()` and generates an ES module that imports `WorkerEntrypoint`, embeds the function, and exposes an `execute(...args)` RPC method.
3. If `context` is configured, captured values are injected as `const` declarations in the module scope.
4. If `bindings` are configured, they're forwarded as the dynamic worker's `env` and appended as the last argument to the function.
5. `env.LOADER.get(uniqueId, callback)` is called — the loader spins up a fresh V8 isolate and returns a `WorkerStub`.
6. `stub.getEntrypoint().execute(...args)` is called via native RPC — no HTTP, no JSON serialization on the wire.
7. Timeouts and retries wrap the dispatch automatically.

Each task gets a unique ID (`cfp:<hash>:<counter>`), guaranteeing separate isolates for parallel work. The hash component enables the loader's internal code caching across tasks with the same function.

---

## Exports

| Export | Description |
|---|---|
| `Parallel` | Convenience object with `.pool(loader, opts?)` factory |
| `WorkerPool` | Pool class for dispatching parallel work |
| `pure` | Purity validation and branding |
| `constant` | Serializable constant annotation |
| `ParallelError` | Base error class |
| `SerializationError` | Function cannot be serialized |
| `ExecutionError` | Remote execution failed |
| `TimeoutError` | Task exceeded deadline |
| `RetryExhaustedError` | All retries exhausted |
| `BindingError` | Worker Loader binding missing |

**Types:** `WorkerLoader`, `WorkerCode`, `WorkerStub`, `EntrypointStub`, `Pure<F>`, `PoolOptions`, `MapOptions`, `PmapOptions`

## License

[MIT](./LICENSE)
