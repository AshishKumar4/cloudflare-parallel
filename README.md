# cloudflare-parallel

> Composed-topology parallel computing for Cloudflare Workers. **4N parallel V8 isolates per request**, with hierarchical tree scaling beyond.

[![npm](https://img.shields.io/npm/v/cloudflare-parallel)](https://www.npmjs.com/package/cloudflare-parallel)
[![CI](https://github.com/AshishKumar4/cloudflare-parallel/actions/workflows/ci.yml/badge.svg)](https://github.com/AshishKumar4/cloudflare-parallel/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/cloudflare-parallel)](https://www.npmjs.com/package/cloudflare-parallel)
[![license](https://img.shields.io/npm/l/cloudflare-parallel)](LICENSE)

```ts
import { Parallel } from 'cloudflare-parallel';

const pool = Parallel.pool(env);

// Mandelbrot escape-time across 128 image rows. Each isolate computes
// one row independently. ~15 ms per row of CPU; 128 rows fan out to
// 32 leaf DOs × 4 loaders = 128 parallel V8 isolates.
const rows = await pool.map((y: number) => {
  const out = new Uint8Array(640);
  for (let x = 0; x < 640; x++) {
    let zx = 0, zy = 0;
    const cx = (x - 320) / 200, cy = (y - 64) / 200;
    let i = 0;
    while (i < 1024 && zx * zx + zy * zy < 4) {
      const t = zx * zx - zy * zy + cx;
      zy = 2 * zx * zy + cy;
      zx = t;
      i++;
    }
    out[x] = i & 255;
  }
  return Array.from(out);
}, Array.from({ length: 128 }, (_, y) => y));
```

128 image rows in flight. Up to 32 V8 isolates running concurrently inside one Worker request. No queue, no orchestration code, no infrastructure. The library picks the topology.

---

## Why

**This library is for CPU-bound parallelism on Cloudflare Workers.** If you're awaiting I/O (`fetch`, KV reads, AI calls, R2 GETs, D1 queries), `Promise.all` on a single isolate already gives you that — the JavaScript event loop interleaves I/O for free. Where this library shines is offloading **CPU-heavy work** — embeddings, hashing, image transforms, parsing, simulation, codegen — to N parallel V8 isolates so the single-threaded event loop doesn't bottleneck you.

- **4N parallel V8 isolates per request.** Composes Worker Loader + Durable Objects to break past the per-isolate 4-loader cap. `N` leaf DOs × `4` loaders each = `4N` real parallel V8 heaps, each running your code on its own thread of the runtime.
- **Tree scaling beyond.** Past 256 items the auto-selector promotes to a multi-tier coordinator → sub-coordinator → leaf shape with branching factor `F`. Total isolates `4 · F^K`.
- **Real `AbortSignal` cancellation.** Token cancel propagates end-to-end across the RPC boundary; pending awaits inside the loaded isolate reject with the cancel reason.
- **Reactive scheduler.** Durable job queue with retries, deadlines, fair per-tenant queueing, idempotency keys.
- **Live demo:** [cloudflare-parallel-demo.pages.dev](https://cloudflare-parallel-demo.pages.dev) (deployed) · [test worker](https://cloudflare-parallel-prod-tests.ashishkmr472.workers.dev/health) · [bench numbers](bench-results-live.json).

### When to use this library

- ✅ Embeddings / hashing / cryptographic chains across thousands of inputs.
- ✅ Image transforms, raytracing, mandelbrot tiles, dither passes.
- ✅ Parsing / linting / minifying / building hundreds of source files.
- ✅ Genetic / evolutionary search, Monte Carlo, simulated annealing.
- ✅ Pure-JS regex or AST work over a corpus that doesn't fit in one isolate's CPU budget.
- ✅ Any user fn where you'd reach for a worker pool on Node and feel the pain of single-threaded JS.

### When NOT to use this library

- ❌ Fetching N URLs / calling N AI endpoints / reading N KV entries. **Use plain `Promise.all`.** A single isolate's event loop interleaves I/O concurrently for free — you don't need separate V8 heaps to wait on the network.
- ❌ Sub-millisecond per-task work. Dispatch + DO RPC overhead is ≥ 5-15 ms; per-task CPU should be ≥ 10 ms before fan-out pays off.
- ❌ Workloads that fit comfortably on one isolate's `cpuMs` budget. The library exists to *escape* the single-isolate CPU ceiling, not to add ceremony.

If your task awaits I/O for most of its duration, the JavaScript event loop is already the parallelism primitive. This library is for the case where each task **burns CPU on a separate V8 thread**.

## Install

```bash
bun add cloudflare-parallel
# or: npm install cloudflare-parallel
```

## Quickstart

`wrangler.toml`:

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2026-01-20"
# Enables `ctx.exports.<WorkerEntrypoint>` loopback bindings — used by the
# in-process coordinator below to skip the DO hop on small fan-outs.
# https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-ctxexports
compatibility_flags = ["enable_ctx_exports"]

[[worker_loaders]]
binding = "LOADER"

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

`src/index.ts`:

```ts
import { Parallel, type WorkerLoader } from 'cloudflare-parallel';
export {
  CfpCoordinator,
  CfpWorkerDO,
  CfpSubCoord,
  CfpInProcessCoordinator,
} from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const pool = Parallel.pool(env, {
      // Skip the DO hop for small fan-outs (size ≤ 4) — same-process
      // dispatch via the auto-generated `ctx.exports` loopback.
      // https://developers.cloudflare.com/workers/runtime-apis/context/
      inProcess: ctx.exports.CfpInProcessCoordinator,
      // Colocate freshly-created leaf DOs with the request's incoming
      // colo. Best-effort placement hint, honored on first DO access only.
      // https://developers.cloudflare.com/durable-objects/reference/data-location/
      requestColo: req.cf?.colo as string | undefined,
    });
    const sums = await pool.map((n: number) => n * n, [1, 2, 3, 4, 5]);
    return Response.json(sums);
  },
};
```

Run `npx cloudflare-parallel doctor` to scaffold the wrangler.toml additions for an existing Worker.

## Five primitives

| Factory                  | Returns           | What it's for                                                    |
| ------------------------ | ----------------- | ---------------------------------------------------------------- |
| `Parallel.pool`          | `Pool`            | CPU-bound fan-out. The main surface.                             |
| `Parallel.loaderOnly`    | `LoaderOnlyPool`  | Fan-out without a Coordinator DO. Capped at 3 from a fetch handler. |
| `Parallel.actor`         | `ActorHandle`     | Long-lived stateful actor with pinned SQLite state.              |
| `Parallel.scheduler`     | `Scheduler`       | Durable job queue: retries, deadlines, fair-tenancy, idempotency. |
| `Parallel.vm`            | `VMHandle`        | HTTP submit-code surface with required `policy` field.           |

## `Pool` — every method

Every method below is on the `Pool` class. Same options pattern (closure-free user fn + optional trailing `SubmitOptions` bag) across the surface.

### `pool.submit(fn, ...args, opts?)` — single CPU task

```ts
const digest = await pool.submit((seed: number) => {
  let buf = new TextEncoder().encode(`seed-${seed}`);
  for (let i = 0; i < 5000; i++) buf = new Uint8Array(/* hash */ buf);
  return buf[0];
}, 42);
```

### `pool.submitSource(fnSource, args, opts?)` — submit code as a string

The source is shipped straight to the loader (no `eval` in the parent
Worker). Used by the HTTP submit-code surface; also handy for codegen
or persisted user code.

```ts
const code = `(a, b) => a * b * Math.PI`;
const result = await pool.submitSource<number>(code, [3, 4]);
```

### `pool.submitStream(fn, ...args, opts?)` — single task that streams output

```ts
const stream = await pool.submitStream((n: number) => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  (async () => {
    for (let i = 0; i < n; i++) {
      await writer.write(new TextEncoder().encode(`chunk-${i}\n`));
    }
    writer.close();
  })();
  return readable;
}, 16);
```

### `pool.map(fn, items, opts?)` — fan out one fn over N items

```ts
const tiles = await pool.map((y: number) => renderRow(y), [0, 1, 2, ..., 191]);
```

Auto-topology: ≤4 → `in-do`; 5..256 → `hybrid` (`4N`); >256 → `tree`.

### `pool.mapStream(fn, items, opts?)` — yield results in completion order

```ts
for await (const { index, value } of pool.mapStream(renderRow, rows)) {
  // value is the result for `rows[index]`; faster items arrive first.
}
```

### `pool.mapOrdered(fn, items, opts?)` — yield results in input order

```ts
for await (const value of pool.mapOrdered(renderRow, rows)) {
  // results arrive in row order even if some isolates finish out-of-order.
}
```

### `pool.scatter(fn, items, chunks, opts?)` + `pool.gather(promises)` — explicit scatter-gather

```ts
const histograms = await pool.scatter(
  (chunk: number[]) => chunk.reduce((h, n) => ((h[n & 7] = (h[n & 7] ?? 0) + 1), h), [] as number[]),
  largeArray,
  16, // 16 chunks
);
const merged = await pool.gather(histograms.map(async (h) => h));
```

`gather` is `Promise.all` for stylistic uniformity with the fan-out
surface. Use it when you've kicked off multiple `pool.submit` calls.

### `pool.pmap(fn)` — curried batched map

```ts
const embed = pool.pmap((batch: string[]) => batch.map(embedOne));
const vectors = await embed(documents, { chunks: 16 });
```

### `pool.reduce(fn, items, initial, opts?)` — tournament reduce

```ts
const totalEnergy = await pool.reduce(
  (a: number, b: number) => combineEnergies(a, b),
  candidates,
  0,
);
```

### `pool.warm()` + `pool.stats()` + `pool.handle({ policy })`

```ts
await pool.warm();                        // absorb DO cold-start (~300–400 ms)
await pool.warm({ isolates: 8 });         // also pre-spin 8 V8 isolates
const stats = await pool.stats();         // { topology, fanOutPerLevel, treeDepth, ... }
const handler = pool.handle({ policy: { kind: 'auth', auth: bearerAuth(token) } });
return handler(req);                      // HTTP submit-code endpoint
```

`autoWarm: true` is the default — the first submit fires `warm()`
implicitly in parallel with the real dispatch, so most callers never
need to call `warm()` directly. Use it explicitly when you want to pay
the cold-start cost at Worker startup rather than on first request.

### `pool.restrictTo(allowedKeys)` — capability-narrow the bindings

```ts
const safePool = pool.restrictTo(['KV']);  // user fns see only env.KV.
```

### Cancellation: `SubmitOptions.cancel: CancelToken`

```ts
import { CancelToken } from 'cloudflare-parallel';

const cancel = CancelToken.withTimeout(30_000);
const result = await pool.submit(async (n: number, env: { signal: AbortSignal }) => {
  for (let i = 0; i < n; i++) {
    env.signal.throwIfAborted();   // cooperative cancel point
    await heavyStep(i);
  }
}, 1_000_000, { cancel });
```

`env.signal` is a real `AbortSignal`. Pass it to any Web API that
accepts one: `fetch(url, { signal })`, `setTimeout` via `AbortController`,
`ReadableStream.cancel`. The token also supports `.fromAbortSignal(req.signal)`
for adapting an inbound request's cancel.

## `Parallel.loaderOnly` — for the cheap path

When you don't want to deploy the Coordinator DO and you can live with
the 3-loader-from-fetch-handler cap. Same `submit` / `submitSource` /
`map` / `scatter` / `gather` / `pmap` / `reduce` surface; no
`mapStream` / `mapOrdered` / `submitStream` / `warm` / `drain` / `stats`
/ `handle` (those need the coordinator).

```ts
const lop = Parallel.loaderOnly(env);
const sums = await lop.map((n: number) => n * n, [1, 2, 3]);
```

## `Parallel.actor` — long-lived stateful actor

State pinned in a Coordinator DO's SQLite. User fn signature is
`(state, sql, ...args, env)` — mutate `state` in place; the runtime
structured-clone-snapshots it after each submit.

```ts
const counter = Parallel.actor(env, { id: 'cart-42', initialState: { items: [] as string[] } });
await counter.submit((state, _sql, item: string) => {
  state.items.push(item);
  return state.items.length;
}, 'apple');
```

## `Parallel.scheduler` — durable job queue

Reactive dispatch (no alarm-batched delays). Retries with exponential
backoff, fair per-tenant queueing, idempotency keys.

```ts
const scheduler = Parallel.scheduler(env, {
  id: 'embeddings',
  retry: { max: 3, backoff: 'exponential', baseMs: 200 },
});

const handle = await scheduler.enqueue({
  fn: async (docId: number) => embedDocument(docId),
  args: [42],
  tenantId: 'acme',
  idempotencyKey: 'embed-doc-42',
});
const value = await handle.result();   // long-poll until done
```

## `Parallel.vm` — HTTP submit-code

Sandboxed per-request user code with required auth policy.

```ts
import { Parallel, bearerAuth } from 'cloudflare-parallel';

export default {
  fetch: (req, env) =>
    Parallel.vm(env, {
      timeout: 5_000,
      globalOutbound: null,                       // no outbound fetch from user code
      policy: {
        kind: 'auth',
        auth: bearerAuth(env.VM_TOKEN),
        allowBindings: [],                        // expose zero bindings
        maxBytes: 64 * 1024,                      // body size cap
      },
    }).fetch(req),
};
```

## Topology

The selector reads `items.length` and picks one of three shapes:

```
size ≤ 4    in-DO         coordinator + 4 loaders inside its isolate
                          ┌──────────────┐
                          │ Coordinator  │
                          │  L L L L     │ 4 loaders × 1 DO = 4 isolates
                          └──────────────┘

5 ≤ size ≤ 16²  hybrid    coordinator + ⌈size/4⌉ leaf DOs × 4 loaders each
                          ┌──────────────┐
                          │ Coordinator  │
                          └───┬────┬─────┘
                            ┌─┴┐ ┌─┴┐ …    ⌈size/4⌉ leaves
                            │LL│ │LL│       4 loaders each = 4N isolates
                            │LL│ │LL│
                            └──┘ └──┘

size > 256   tree         coordinator → sub-coords → leaves; depth K = ⌈log_F size⌉
                                                              total = 4·F^K isolates
```

Read [`DESIGN.md`](DESIGN.md) §4 for the math, ADRs, and the empirical caps that drive the selector.

## Performance

Five mechanisms cooperate to keep dispatch cheap end-to-end. The first is **the** load-bearing pattern; the remaining four trim the residual overhead.

### 1. The held-`RpcTarget` fast path (the canonical pattern)

This is the strongest workaround in any Workers RPC fan-out. A library-internal benchmark measured a **99.83 % reduction in dispatch wall-time at N=8** (5 ms pipelined vs 2913 ms sequential) — the dispatch is constant-time regardless of N once the session is open. [Workers RPC promise-pipelining reference](https://developers.cloudflare.com/workers/runtime-apis/rpc/).

The library applies this internally for every fan-out:

```ts
// Inside the Coordinator DO, when fanning out to leaf DOs:
const session = stub.openSession();              // unawaited — promise pipelining
const result  = await session.runBatch(envelope); // chained on the unresolved session
```

The runtime collapses `openSession()` + `runBatch()` into a single Cap'n Proto session per leaf. Without this pattern, each method call would pay full DO routing + `getActor` lookup + RPC round-trip. With it, the second call rides the open session for free.

Mirror the pattern in your own RPC-heavy code: keep one held `RpcTarget` per remote DO, chain method calls without awaiting between them, and let the runtime pipeline the round-trips.

### 2. In-process coordinator for small fan-outs

Pass `inProcess: ctx.exports.CfpInProcessCoordinator` to skip the Coordinator DO hop for `submit()` and any fan-out of size ≤ 4. The loopback stays inside the same Worker process — no inter-DO RPC, no cross-region routing — so per-call dispatch drops from tens of milliseconds to ~1–3 ms. Larger fan-outs still flow through the Coordinator DO (which composes 4N parallelism across leaf DOs). [`ctx.exports` reference](https://developers.cloudflare.com/workers/runtime-apis/context/).

### 3. Auto-warm of the Coordinator DO

A freshly-created Durable Object pays a one-time creation cost (empirically ~300–400 ms in production); subsequent calls on the warm channel are ~3–30 ms — a 14×–140× per-call cold-vs-warm ratio. The library fires `noop()` to the Coordinator DO in parallel with the first real dispatch (under the `autoWarm: true` default) so the cold-start cost is absorbed off the critical path.

```ts
// Default: prewarm runs concurrently with the first submit.
const pool = Parallel.pool(env, { /* autoWarm: true is the default */ });

// Explicit: pay the cold-start cost up front (e.g. at Worker startup).
await pool.warm();

// Opt out: only useful when you're benchmarking cold-start specifically.
const pool = Parallel.pool(env, { autoWarm: false });
```

### 4. `locationHint` colocation

Pass `requestColo: req.cf?.colo` (or `locationHint: 'wnam'` directly) so freshly-created leaf DOs land in the same region as the request's incoming colo. Best-effort placement, honored only on first access of each DO. [Data location reference](https://developers.cloudflare.com/durable-objects/reference/data-location/).

### 5. Selective `allowUnconfirmed` on actor writes

The actor's per-submit state checkpoint uses `ctx.storage.put(state, { allowUnconfirmed: true })` — the response races back to the caller without waiting for the storage commit, saving 46–80 % of the per-write wall-time at small N. Safe here because the Actor contract documents per-submit checkpointing as best-effort and the next submit reads the (now-committed) state from storage. The flag is **not** applied to scheduler durable-queue writes (job persistence, job-ack), which use SQL with synchronous-commit semantics. [Transactional storage API reference](https://developers.cloudflare.com/durable-objects/api/transactional-storage-api/#put).

### Putting it together

```ts
const pool = Parallel.pool(env, {
  inProcess: ctx.exports.CfpInProcessCoordinator,    // small-N skips DO hop
  requestColo: req.cf?.colo as string | undefined,   // colocate leaf DOs
  // autoWarm: true is the default — prewarm in parallel with first dispatch
});
```

The library publishes live edge benchmarks in [`bench-results-live.json`](bench-results-live.json), measured against the deployed test worker with separate cold-run / warm-run reporting, equal warmup for both paths, and a median-of-5 sampling contract.

### Observed speedup curve

Live numbers from the deployed test worker (Mandelbrot tile workload, heavy intensity — `rowsPerTile=8, maxIter=16000, width=1536`):

| Size | Topology | Per-tile (warm) | Parallel wall (warm) | Speedup |
|-----:|----------|----------------:|---------------------:|--------:|
|    4 | `in-do`  |          ~180 ms |               ~890 ms |  ~1×    |
|   16 | `hybrid` |          ~170 ms |               ~2.7 s  |  ~1×    |
|   64 | `hybrid` |          ~180 ms |               ~2.8 s  |  ~4×    |
|  128 | `hybrid` |          ~170 ms |               ~3.0 s  |  ~7×    |
|  256 | `tree`   |          ~180 ms |               ~3.0 s  | ~15×    |
|  512 | `tree`   |          ~180 ms |               ~5.4 s  | ~17×    |

GA (heavy N-body fitness eval) hits **94× at N=512** with `tree` topology (depth=3); Monte Carlo hits **30× at N=256**.

**Why small-N doesn't show 4× speedup.** The Worker Loader caches isolates by ID (per [the public API](https://developers.cloudflare.com/dynamic-workers/api-reference/#get)): concurrent `get(sameId)` calls return the SAME loaded isolate, and tasks run sequentially on that single V8 context. The library's parallelism unlocks at the **leaf-DO tier** — `hybrid` and `tree` topologies fan out across N independent leaf DOs, each with its own isolate. At N ≤ 4 (the `in-do` topology) all tasks share one isolate, so the per-tile CPU sums sequentially even though dispatch is parallel; the library's contribution there is no worse than running inline. To get genuine 4-way parallelism at N=4, pass `freshIsolate: true` per submit — but the per-call loader spin-up usually outweighs the win at that scale.

The library shines at **N ≥ 64**: each leaf DO runs its own batch in its own isolate, and the speedup is roughly `N / 4` minus dispatch overhead. At N ≥ 256 the tree topology multiplies leaf count further.

### Cache key strategy

Every factory defaults `cacheKeyStrategy: 'stable'` — one isolate per fn shape, long-lived warmth, no eviction storms. `'fresh'` forces a clean V8 heap per submission (testing, sandboxing distrusted code per-call). `'auto'` (60-second windows) is opt-in for the small-fixed-set-of-shapes / want-periodic-refresh case. With high fn-shape diversity, `'auto'` thrashes the per-owner LRU; the default was switched to `'stable'` after a third-party review surfaced the eviction storm. See [`docs/tuning.md`](docs/tuning.md).

## Examples

| Path | What it shows |
| --- | --- |
| [`examples/embeddings-batch`](examples/embeddings-batch/) | Hash-then-mix vector embeddings across thousands of synthetic docs + cosine top-K. Pure CPU. |
| [`examples/raytracer`](examples/raytracer/) | Distributed raytracing: each isolate renders one image tile. Visual, dramatic, CPU-bound. |
| [`examples/genetic-algorithm`](examples/genetic-algorithm/) | TSP evolutionary search: each isolate evaluates one candidate (with 2-opt local search). |
| [`examples/build-pipeline`](examples/build-pipeline/) | Tokenize / minify / hash N source files in parallel — `make -j` shape on Workers. |
| [`examples/scheduler`](examples/scheduler/) | Durable job queue with retries + per-tenant cancel. |
| [`examples/vm`](examples/vm/) | Sandboxed HTTP submit-code with bearer auth. |

## Documentation

- [`DESIGN.md`](DESIGN.md) — architectural spec, ADRs, threat model
- [`docs/architecture.md`](docs/architecture.md) — substrate, topology selection, dispatch pipeline
- [`docs/security.md`](docs/security.md) — submit-code threat model and mitigations
- [`docs/tuning.md`](docs/tuning.md) — every knob, default, and when to change it
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — error decode tree and common gotchas

- [`docs/when-to-use.md`](docs/when-to-use.md) — when to reach for this library vs `Promise.all`

## Live demo

[**cloudflare-parallel-demo.pages.dev**](https://cloudflare-parallel-demo.pages.dev) — every primitive, hand-on, with the same backend code that powers the prod-tests worker. CPU-bound throughout: SHA-256 chains, mandelbrot tiles, embeddings, raytracing.

The substrate test worker is also live at [`cloudflare-parallel-prod-tests.ashishkmr472.workers.dev`](https://cloudflare-parallel-prod-tests.ashishkmr472.workers.dev). Hit `/health` to verify; `/pool/map` to drive `pool.map` directly.

## Compatibility

| Requirement | Version |
| --- | --- |
| Wrangler | 3 or 4 |
| `compatibility_date` | ≥ 2025-09-01 |
| Worker Loader binding | required (private beta) |
| Bun | recommended for development |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Issues and pull requests welcome at [github.com/AshishKumar4/cloudflare-parallel](https://github.com/AshishKumar4/cloudflare-parallel).

## License

[MIT](LICENSE) © cloudflare-parallel contributors
