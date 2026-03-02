# cloudflare-parallel

Parallel computing primitives for Cloudflare Workers. Dispatch functions to isolated V8 runtimes via the [Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) — no separate executor workers, no `unsafe_eval`, no HTTP/JSON overhead.

```ts
import { Parallel } from "cloudflare-parallel";

const pool = Parallel.pool(env.LOADER, {
  bindings: { AI: env.AI, KV: env.MY_KV },
  timeout: 5000,
  retries: 2,
});

const responses = await pool.map(
  async (model: string, env) => {
    const res = await env.AI.run(model, { messages: [{ role: "user", content: prompt }] });
    return res.response;
  },
  ["@cf/meta/llama-3-8b-instruct", "@cf/mistral/mistral-7b-instruct-v0.1", "@cf/google/gemma-7b-it"],
);
```

> **Note:** The Worker Loader API is in **closed beta**. Works locally in `wrangler dev` today; production requires beta access.

## Quick Start

```bash
npm install cloudflare-parallel
```

```toml
# wrangler.toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[worker_loaders]]
binding = "LOADER"
```

```ts
import { Parallel } from "cloudflare-parallel";
import type { WorkerLoader } from "cloudflare-parallel";

interface Env {
  LOADER: WorkerLoader;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pool = Parallel.pool(env.LOADER);

    const result = await pool.submit((x: number) => x * x, 42);
    const squares = await pool.map((n: number) => n * n, [1, 2, 3, 4, 5]);

    return Response.json({ result, squares });
  },
};
```

```bash
npx wrangler dev
```

## API

### `Parallel.pool(loader, opts?)`

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: { AI: env.AI },
  context: { threshold: 0.5 },
  timeout: 5000,
  retries: 3,
  retryDelay: 100,
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `bindings` | `Record<string, unknown>` | — | Env bindings forwarded to isolates |
| `context` | `Record<string, unknown>` | — | Variables injected into module scope |
| `timeout` | `number` | — | Per-task timeout in ms |
| `retries` | `number` | `0` | Retry attempts on failure |
| `retryDelay` | `number` | `100` | Base retry delay in ms (exponential backoff) |
| `globalOutbound` | `null \| undefined` | `null` | `null` = sandboxed, `undefined` = inherit |

### `pool.submit(fn, ...args, opts?)`

```ts
const result = await pool.submit((x: number) => x * x, 42);

await pool.submit(heavyFn, data, {
  timeout: 10_000,
  retries: 2,
  context: { config: myConfig },
});
```

### `pool.map(fn, items, opts?)`

```ts
const doubled = await pool.map((n: number) => n * 2, [1, 2, 3, 4]);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | `items.length` | Max in-flight tasks |
| `onError` | `'throw' \| 'skip' \| 'null'` | `'throw'` | Per-item failure handling |
| `context` | `Record<string, unknown>` | — | Per-call context variables |
| `timeout` | `number` | — | Per-task timeout override |

### `pool.reduce(fn, items, initial)`

Tree-parallel reduce — O(log n) depth.

```ts
const sum = await pool.reduce((a: number, b: number) => a + b, [1, 2, 3, 4, 5], 0);
```

### `pool.pmap(fn)`

Chunked parallel map. Returns a curried function that splits input into chunks.

```ts
const pmapped = pool.pmap((batch: number[]) => batch.map(x => x * x));
const results = await pmapped([1, 2, 3, 4, 5, 6], { chunks: 3 });
```

### `pool.pipe(fn1, fn2, ...fnN)`

Sequential pipeline, each stage on its own isolate. Up to 5 typed stages.

```ts
const pipeline = pool.pipe(
  (s: string) => s.toLowerCase(),
  (s: string) => s.split(" "),
  (words: string[]) => words.length,
);

const count = await pipeline("Hello World");
// => 2
```

### `pool.scatter(fn, items, chunks)`

Split items into N chunks, process each chunk in parallel.

```ts
const chunkSums = await pool.scatter(
  (chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
  [1, 2, 3, 4, 5, 6],
  3,
);
// => [3, 7, 11]
```

### `pool.gather(promises)`

`Promise.all` wrapper for symmetry with `scatter`.

```ts
const results = await pool.gather([
  pool.submit((x: number) => x + 1, 1),
  pool.submit((x: number) => x + 2, 2),
]);
```

### `pool.mapStream(fn, items, opts?)`

Yields `{ index, value }` as tasks complete (unordered).

```ts
for await (const { index, value } of pool.mapStream(fn, items)) {
  console.log(`Item ${index} = ${value}`);
}
```

### `pool.mapOrdered(fn, items, opts?)`

Yields values in original order, buffering internally.

```ts
for await (const value of pool.mapOrdered(fn, items, { concurrency: 10 })) {
  process.stdout.write(value);
}
```

### `pure(fn)` / `constant(value)`

```ts
import { pure, constant } from "cloudflare-parallel";

const double = pure((x: number) => x * 2);   // validates no `this` references
const threshold = constant(0.5);              // documents serializable intent
```

## Binding Passthrough

Dynamic isolates have no bindings by default. Forward them via the `bindings` option — your function then receives `env` as its last argument:

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: { AI: env.AI, KV: env.MY_KV, DB: env.DB },
});

await pool.submit(async (prompt: string, env) => {
  const result = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });
  return result.response;
}, "What is the meaning of life?");
```

Works with all pool methods (`map`, `scatter`, `pmap`, etc.).

### Network Access

```ts
// Sandboxed (default) — fetch() and connect() throw inside isolates
Parallel.pool(env.LOADER, { bindings: { AI: env.AI } });

// Inherit parent's network
Parallel.pool(env.LOADER, { globalOutbound: undefined });
```

## Context Capture

Functions are serialized via `.toString()`, so closed-over variables are lost. Use `context` to inject values as module-level constants:

```ts
const multiplier = 3;
const prefix = "result";

// BROKEN: multiplier and prefix are undefined in the isolate
await pool.submit((x) => `${prefix}: ${x * multiplier}`, 5);

// Works: values injected as module-level constants
await pool.submit(
  (x) => `${prefix}: ${x * multiplier}`,
  5,
  { context: { multiplier, prefix } },
);
// => "result: 15"
```

Context can be set at pool level or per-call (per-call overrides pool-level):

```ts
const pool = Parallel.pool(env.LOADER, {
  context: { version: "2.0", maxRetries: 3 },
});

await pool.submit(fn, arg, {
  context: { version: "2.1" },
});
```

Values must be JSON-serializable.

## Timeouts and Retries

```ts
const pool = Parallel.pool(env.LOADER, {
  timeout: 5000,
  retries: 3,
  retryDelay: 100,  // 100ms, 200ms, 400ms (exponential backoff)
});

// Override per-call
await pool.submit(slowFn, data, { timeout: 30_000 });
```

After all retries are exhausted, `RetryExhaustedError` is thrown.

### Partial Failure (`onError`)

```ts
// 'throw' (default) — one failure aborts everything
const results = await pool.map(fn, items);

// 'null' — failed items become null
const results = await pool.map(fn, items, { onError: "null" });

// 'skip' — failed items omitted
const results = await pool.map(fn, items, { onError: "skip" });
```

## Error Handling

All errors extend `ParallelError`:

| Error | When |
|---|---|
| `SerializationError` | Function can't be serialized |
| `ExecutionError` | Remote isolate throws |
| `TimeoutError` | Task exceeds deadline |
| `RetryExhaustedError` | All retries failed |
| `BindingError` | Worker Loader binding missing/misconfigured |

```ts
import { ExecutionError, TimeoutError, RetryExhaustedError } from "cloudflare-parallel";

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

## Examples

### AI Fanout

See [`examples/ai-fanout/`](./examples/ai-fanout/) for the full runnable example.

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: { AI: env.AI },
  timeout: 30_000,
  retries: 1,
});

const responses = await pool.map(
  async (model: string, env) => {
    const res = await env.AI.run(model, {
      messages: [{ role: "user", content: "Explain quantum computing" }],
    });
    return { model, response: res.response };
  },
  ["@cf/meta/llama-3-8b-instruct", "@cf/mistral/mistral-7b-instruct-v0.1", "@cf/google/gemma-7b-it"],
  { onError: "null" },
);
```

### Scatter-Gather

```ts
const pool = Parallel.pool(env.LOADER, {
  bindings: { KV: env.RESULTS },
  context: { batchId: crypto.randomUUID() },
});

const chunkResults = await pool.scatter(
  (chunk: DataRow[]) => {
    const processed = chunk.map(row => transform(row));
    return { count: processed.length, checksum: hash(processed) };
  },
  dataset,
  10,
);
```

## How It Works

1. `pool.submit(fn, ...args)` serializes `fn` via `.toString()` and generates an ES module with a `WorkerEntrypoint` that exposes `execute(...args)`.
2. Context values (if any) become `const` declarations in the module scope. Bindings (if any) are forwarded as the worker's `env` and appended as the function's last argument.
3. `env.LOADER.get(uniqueId, callback)` spins up a fresh V8 isolate. Each task gets a unique ID (`cfp:<hash>:<counter>`), guaranteeing separate isolates. The hash enables the loader's internal code caching for identical functions.
4. `stub.getEntrypoint().execute(...args)` is called via native RPC — no HTTP, no JSON on the wire.

## Exports

| Export | Description |
|---|---|
| `Parallel` | `.pool(loader, opts?)` factory |
| `WorkerPool` | Pool class |
| `pure` | Purity validation |
| `constant` | Serializable constant annotation |
| `ParallelError` | Base error |
| `SerializationError` | Serialization failure |
| `ExecutionError` | Remote execution failure |
| `TimeoutError` | Deadline exceeded |
| `RetryExhaustedError` | Retries exhausted |
| `BindingError` | Binding misconfiguration |

**Types:** `WorkerLoader`, `WorkerCode`, `WorkerStub`, `EntrypointStub`, `Pure<F>`, `PoolOptions`, `MapOptions`, `PmapOptions`

## License

[MIT](./LICENSE)
