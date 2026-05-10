# cloudflare-parallel

> Composed-topology parallel computing for Cloudflare Workers. **4N parallel V8 isolates per request**, with hierarchical tree scaling beyond.

[![npm](https://img.shields.io/npm/v/cloudflare-parallel)](https://www.npmjs.com/package/cloudflare-parallel)
[![CI](https://github.com/AshishKumar4/cloudflare-parallel/actions/workflows/ci.yml/badge.svg)](https://github.com/AshishKumar4/cloudflare-parallel/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/cloudflare-parallel)](https://www.npmjs.com/package/cloudflare-parallel)
[![license](https://img.shields.io/npm/l/cloudflare-parallel)](LICENSE)

```ts
import { Parallel, pickBindings } from 'cloudflare-parallel';

const pool = Parallel.pool(env, { bindings: pickBindings(env, ['AI']) });

const briefs = await pool.map(async (url, env) => {
  const html = await fetch(url).then((r) => r.text());
  const summary = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    prompt: `Summarize: ${html.slice(0, 8000)}`,
  });
  return { url, summary };
}, urls);
```

128 URLs in flight. Up to 32 V8 isolates running concurrently inside one Worker request. No queue, no orchestration code, no infrastructure. The library picks the topology.

---

## Why

- **Maximum parallelism on Cloudflare primitives.** Composes Worker Loader + Durable Objects to break past per-isolate concurrency caps. `4N` parallelism via hybrid topology, `4·F^K` via tree.
- **Real `AbortSignal` cancellation.** End-to-end live cancel across the RPC boundary (caller → coordinator DO → leaf DO → loaded isolate). No polling, no snapshot-only signals.
- **Reactive scheduler.** Durable job queue with retries, deadlines, fair per-tenant queueing, idempotency keys. Bench-measured ~145k jobs/s in-memory dispatch, end-to-end latency bounded by isolate cold-start, not the dispatcher.
- **HTTP submit-code with required policy.** `policy` is mandatory at construction — there is no silent default-public path. Bearer + HMAC auth recipes; library-internal bindings hard-blocklisted from forwarding.
- **First-class testing surface.** `Parallel.testing.poolFake` / `actorFake` / `schedulerFake` return canonical `IPool` / `IActorHandle` / `IScheduler` types — swap backends in tests without `as any`.

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
export { CfpCoordinator, CfpWorkerDO, CfpSubCoord } from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

export default {
  async fetch(_req: Request, env: Env) {
    const pool = Parallel.pool(env);
    const sums = await pool.map((n: number) => n * n, [1, 2, 3, 4, 5]);
    return Response.json(sums);
  },
};
```

Run `npx cloudflare-parallel doctor` to scaffold the wrangler.toml additions for an existing Worker.

## Primitives

### `Parallel.pool` — stateless fan-out

Auto-selects topology. `submit` runs one fn; `map` / `scatter` / `reduce` / `pmap` / `pipe` fan out across `4N` isolates.

```ts
const pool = Parallel.pool(env, { bindings: pickBindings(env, ['AI', 'KV']) });
const results = await pool.map(processItem, items);     // auto-topology
const out = await pool.reduce((a, b) => a + b, items, 0); // tournament reduce
const stream = pool.mapStream(processItem, items);       // completion-order stream
```

### `Parallel.actor` — long-lived stateful actor

State pinned in a Coordinator DO's SQLite. User fn signature is `(state, sql, ...args, env)` — mutate `state`; the runtime structured-clone-snapshots after each submit.

```ts
const actor = Parallel.actor(env, { id: 'cart-42', initialState: { items: [] } });
await actor.submit((state, _sql, item) => state.items.push(item), 'apple');
const items = await actor.submit((state) => state.items);
```

### `Parallel.scheduler` — durable job queue

Reactive dispatch. Retries, deadlines, fair per-tenant queueing, idempotency.

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

### `Parallel.vm` — HTTP submit-code

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
        auth: bearerAuth(env.VM_TOKEN),           // bearer-token gate
        allowBindings: [],                        // expose zero bindings
        maxBytes: 64 * 1024,                      // body size cap
      },
    }).fetch(req),
};
```

### `Parallel.loaderOnly` — no Coordinator DO

For fire-and-forget dispatch from the Worker fetch handler. Capped at 3 concurrent loaders (workerd cap from a fetch handler). No `mapStream`, `submitStream`, `warm`, `drain`, `stats`, `handle` — those need the coordinator.

```ts
const lop = Parallel.loaderOnly(env);
const results = await lop.map((n: number) => n * n, [1, 2, 3]);
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

## Examples

| Path | Shows |
| --- | --- |
| [`examples/research-agent`](examples/research-agent/) | Parallel multi-source aggregation + Workers AI synthesis |
| [`examples/web-crawler`](examples/web-crawler/) | Recursive crawl with depth-bounded fan-out |
| [`examples/scheduler`](examples/scheduler/) | Durable job queue with retries + per-tenant cancel |
| [`examples/vm`](examples/vm/) | Sandboxed HTTP submit-code with bearer auth |

## Documentation

- [`DESIGN.md`](DESIGN.md) — architectural spec, ADRs, threat model
- [`MIGRATION.md`](MIGRATION.md) — v0.2 → v0.3 migration guide
- [`docs/architecture.md`](docs/architecture.md) — substrate, topology selection, dispatch pipeline
- [`docs/security.md`](docs/security.md) — submit-code threat model and mitigations
- [`docs/tuning.md`](docs/tuning.md) — every knob, default, and when to change it
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — error decode tree and common gotchas
- [`docs/cf-internals.md`](docs/cf-internals.md) — Cloudflare Workers internals deep-dive (for contributors)

## Live demo

A reference deployment lives at [`cf-mp-vm.ashishkumarsingh.com`](https://cf-mp-vm.ashishkumarsingh.com). It exposes the substrate primitives directly (loader-only via `/a/*`, DO+loader via `/b/*`) so you can see the empirical caps the topology selector relies on.

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
