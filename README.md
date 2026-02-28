# cloudflare-parallel

**Parallel computing for Cloudflare Workers.**

Ship parallel workloads across Cloudflare Workers isolates using the **Worker Loader API**. Serialize pure functions, dispatch them to dynamically-created isolates, and collect results — with primitives like `submit`, `map`, `reduce`, `pmap`, `pipe`, and `scatter`.

> **Note:** The Worker Loader API is currently in **closed beta**. It works locally in `wrangler dev` (miniflare) today. Production deployment requires access to the beta.

## Architecture

`cloudflare-parallel` uses a **single-worker architecture** powered by the Worker Loader API:

- Your application worker has a `[[worker_loaders]]` binding.
- When you dispatch work, the library dynamically generates ES module source code containing your function and hands it to the loader.
- The loader spins up a fresh V8 isolate for each task, executes it via RPC, and returns the result.
- No separate executor worker to deploy. No `unsafe_eval`. No HTTP/JSON overhead — just native RPC.

## Install

The package is not yet published to npm. Install directly from GitHub:

```bash
npm install github:AshishKumar4/cloudflare-parallel
```

## Quick Start

### 1. Configure `wrangler.toml`

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[worker_loaders]]
binding = "LOADER"
```

### 2. Write your worker

```ts
import { Parallel } from "cloudflare-parallel";
import type { WorkerLoader } from "cloudflare-parallel";

export interface Env {
  LOADER: WorkerLoader;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pool = Parallel.pool(env.LOADER);

    // Run a function on a remote isolate
    const result = await pool.submit((x: number) => x * x, 42);

    // Map in parallel across isolates
    const squares = await pool.map(
      (n: number) => n * n,
      [1, 2, 3, 4, 5],
    );

    return Response.json({ result, squares });
  },
};
```

### 3. Run locally

```bash
npx wrangler dev
```

That's it — one worker, one deployment.

## API Reference

### `Parallel.pool(loader, opts?)`

Create a `WorkerPool` from a Worker Loader binding.

```ts
import { Parallel } from "cloudflare-parallel";

const pool = Parallel.pool(env.LOADER);
```

---

### `pool.submit(fn, ...args)`

Execute a single function on a remote isolate and return the result.

```ts
const squared = await pool.submit((x: number) => x * x, 42);
// => 1764
```

---

### `pool.map(fn, items, opts?)`

Invoke `fn` once per item, each in its own isolate. All calls run in parallel by default.

```ts
const results = await pool.map(
  (n: number) => n * 2,
  [1, 2, 3, 4],
);
// => [2, 4, 6, 8]
```

**Options:**

| Option        | Type     | Default        | Description                      |
|---------------|----------|----------------|----------------------------------|
| `concurrency` | `number` | `items.length` | Max number of in-flight requests |

---

### `pool.reduce(fn, items, initial)`

Tree-parallel reduce. Pairs adjacent items and reduces them in parallel rounds until a single value remains — O(log n) depth instead of O(n).

```ts
const sum = await pool.reduce(
  (a: number, b: number) => a + b,
  [1, 2, 3, 4, 5],
  0,
);
// => 15
```

---

### `pool.pmap(fn)`

Chunked parallel map (inspired by JAX's `pmap`). Returns a curried function that splits its input array into chunks and maps each chunk in parallel.

```ts
const pmapped = pool.pmap(
  (batch: number[]) => batch.map((x) => x * x),
);

const results = await pmapped([1, 2, 3, 4, 5, 6], { chunks: 3 });
// => [1, 4, 9, 16, 25, 36]
```

---

### `pool.pipe(fn1, fn2, ...fnN)`

Compose a sequential pipeline where each stage runs on a remote isolate. The output of one stage becomes the input to the next.

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

Split `items` into `chunks` pieces, invoke `fn` on each chunk in parallel, and return the array of per-chunk results.

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

A thin `Promise.all` wrapper for symmetry with `scatter`.

```ts
const results = await pool.gather([
  pool.submit((x: number) => x + 1, 1),
  pool.submit((x: number) => x + 2, 2),
]);
// => [2, 4]
```

---

### `pure(fn)`

Mark a function as verified-pure. Performs basic validation:

- Rejects functions that reference `this` (which cannot survive serialization).
- Brands the function with `__pure: true` for downstream checks.

```ts
import { pure } from "cloudflare-parallel";

const double = pure((x: number) => x * 2); // OK
const bad = pure(function () { return this.x; }); // throws
```

---

### `constant(value)`

Identity function that signals a value is intended to be captured as a serializable constant. At runtime this is a no-op — its purpose is documentation and intent signaling.

```ts
import { constant } from "cloudflare-parallel";

const threshold = constant(0.5);
pool.submit((x: number, t: number) => x > t ? 1 : 0, value, threshold);
```

## Purity Constraints

**Functions you dispatch must be pure.**

### What "pure" means here

- **No closures over mutable state.** The function is serialized via `.toString()` and reconstructed in a fresh isolate. Any closed-over variables will be `undefined` at execution time.
- **No `this` references.** There is no receiver object in the remote isolate.
- **Arguments and return values must be JSON-serializable.** They cross an RPC boundary.
- **No side effects that need to be observed.** Each invocation runs in an isolated context. Console logs, global mutations, etc. are invisible to the caller.

### Best practices

1. Use `pure()` to annotate and validate functions before dispatch.
2. Pass all data as explicit arguments — never rely on closure capture.
3. Use `constant()` to document values that are intended as serializable constants.
4. Keep dispatched functions small and self-contained.

## Configuration Reference

### `wrangler.toml`

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[worker_loaders]]
binding = "LOADER"
```

The `[[worker_loaders]]` binding provides a `WorkerLoader` object in `env.LOADER`. That's the only configuration needed — no separate executor worker, no service bindings.

## How It Works

1. You call `pool.submit(fn, ...args)`.
2. The library serializes `fn` via `.toString()` and generates an ES module that imports `WorkerEntrypoint` from `cloudflare:workers`, embeds the function, and exposes an `execute(...args)` RPC method.
3. It calls `env.LOADER.get(uniqueId, callback)` where the callback returns the generated `WorkerCode` descriptor.
4. The Worker Loader spins up a fresh V8 isolate, loads the module, and returns a `WorkerStub`.
5. The library calls `stub.getEntrypoint().execute(...args)` via RPC.
6. The result is returned directly — no HTTP serialization, no JSON encoding on the wire.

Each task gets a unique ID, so the loader creates a separate isolate per task (true parallelism). The ID includes a hash of the function source, so the loader can cache compiled code across tasks with the same function.

## Exports

| Export               | Description                                      |
|----------------------|--------------------------------------------------|
| `Parallel`           | Convenience object with `.pool(loader)` factory  |
| `WorkerPool`         | Pool class for dispatching parallel work         |
| `pure`               | Purity validation and branding                   |
| `constant`           | Serializable constant annotation                 |
| `ParallelError`      | Base error class                                 |
| `SerializationError` | Thrown when a function cannot be serialized       |
| `ExecutionError`     | Thrown when remote execution fails                |
| `TimeoutError`       | Thrown when a task exceeds its deadline           |
| `BindingError`       | Thrown when the Worker Loader binding is missing  |

**Types:** `WorkerLoader`, `WorkerCode`, `WorkerStub`, `EntrypointStub`, `Pure<F>`, `PoolOptions`, `MapOptions`, `PmapOptions`

## License

[MIT](./LICENSE)
