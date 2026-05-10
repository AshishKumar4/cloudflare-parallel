# Architecture

Design spec for `cloudflare-parallel`. Public Cloudflare documentation
([developers.cloudflare.com](https://developers.cloudflare.com/)) is the
source of every external claim in this document; runtime constraints are
either drawn from there or measured empirically against deployed Workers.

## §1 — Goals & non-goals

### Goals

1. **Absolute maximum parallelism** within Cloudflare's runtime constraints. The composed-topology math (the loader-cap × DO fan-out composition: N child DOs × 4 loaders each = 4N parallel isolates) is the design driver. Hierarchical tree extends 4N to 4 × F^K for branching factor F and K tiers.
2. **Pleasant, type-safe ergonomic** for the common case. `pool.submit(fn, ...args)` / `pool.map(fn, items)` should look like ordinary async code; closures, options, cancel tokens flow through without ceremony.
3. **Add a job scheduler primitive** (`Parallel.scheduler`) with backpressure, retries, deadlines, cancellation, optional persistence (DO-storage default; Queues / D1 / custom adapters).
4. **Add long-lived stateful actors** (`Parallel.actor`, pinned-state only — see §5.2).
5. **Add an HTTP submit-code "VM" frontend** (`Parallel.VM` + `pool.handle()`).
6. **Strong typing, zero-config defaults, excellent DX.**

### Non-goals

- **Cost optimization.** Cost is not a concern. Library never refuses work on cost grounds; never hedges; never adds back-pressure surfaces motivated by billing. Documented orphan-isolate behavior is contract, not concern.
- **DO Facets as a backend.** v0.3 does not use them; the hybrid + tree topology already gives strictly more parallelism than a same-metal facet pool would. Reconsider once facets ship capabilities-in-props.
- Container Durable Objects as a backend (reserved namespace `Parallel.container(...)` for future).
- Cross-region replication of state. v0.3 is single-region per coordinator.
- Python user code. JS-only in v0.3 (`WorkerCode.modules` extension supports Python; forward-compat).
- Replacing Workflows.

### What "$1000 bet" means here

The architecture must survive: a 4N-way composed fan-out under runtime contention; an LRU-thrash storm at the per-owner cache cap; a coordinator-DO restart mid-flight; a user fn that infinite-loops; a runtime where `cpuMs` limits behave differently locally than in production; high-fan-out FD pressure under deep tree fan-out. §11 enumerates these and the mitigations.

### Invariant: CPU-bound parallelism only — first-class positioning

This library exists for **CPU-bound parallel work** on Cloudflare Workers. It does **not** target I/O fan-out; the JavaScript event loop on a single isolate already interleaves I/O concurrently for free. Where this library wins is offloading user code to **N parallel V8 isolates** so that genuinely CPU-heavy tasks run on separate threads of the runtime, escaping the single-threaded V8 ceiling.

**Use the library when:** each task burns ≥ 10 ms of CPU and you have ≥ 4 of them. Embeddings, hashing, signing, image transforms, parsing, simulation, codegen, evolutionary search, raytracing, build pipelines.

**Do NOT use the library when:** you are awaiting I/O (`fetch`, `env.AI.run`, `env.KV.get`, `env.D1.prepare`, `env.R2.get`). Plain `Promise.all` on one isolate gives you that for free — the event loop suspends each pending await without consuming CPU. Adding fan-out across isolates buys nothing and pays 5-15 ms of dispatch overhead per task.

This positioning is load-bearing for every API decision in this document. The 4N parallelism math, the tree extension, the topology selector, the `Pool` surface — all of it is justified by the CPU-bound use case. `docs/when-to-use.md` is the user-facing version of this invariant.

---

## §2 — Mental model

Five earned abstractions. Every other type sits underneath one of these.

| Abstraction | What it is | Backed by |
|---|---|---|
| **Pool** | Stateless fan-out unit. `submit/map/scatter/...`. | A *Coordinator* DO + a topology strategy (in-DO, hybrid, or hierarchical-tree) selected by the topology selector. |
| **Actor** | Long-lived stateful actor. State pinned in the Coordinator's SQLite; user fn receives `(state, sql, ...args)`. | A Coordinator DO with per-actor SQLite namespacing. |
| **Scheduler** | Heterogeneous job queue with retries / deadlines / cancellation / fairness / persistence. | A Coordinator DO with a `JobStore` adapter (DO-storage default; Queues / D1 / custom opt-in). |
| **VM** | HTTP submit-code surface; opinionated wrapper around `pool.handle()`. | A `fetch` handler around a Pool + code-validation + capability-gating. |
| **Coordinator** | Internal: the DO that holds the loaded class, brokers RPCs, and absorbs eviction shocks. | `WorkerEntrypoint`-extending DO classes shipped by the library (`CfpCoordinator`, `CfpWorkerDO`, `CfpSubCoord`, `CfpSchedulerDO`). |

A `Pool` is a stateless façade in front of a `Coordinator`. An `Actor` is a `Coordinator` you keep referring to by name. A `Scheduler` is a `Coordinator` that *also* persists a queue. A `VM` is a Worker that uses a `Pool`. There is one engine and four lenses.

**Loader-only is a separate factory, not a `Pool` topology**. `Parallel.loaderOnly(env, opts)` returns a `LoaderOnlyPool<B, C>` — a structurally smaller surface than `Pool`. Methods unimplementable without a Coordinator DO (`warm`, `drain`, `stats`, `mapStream`, `mapOrdered`, `submitStream`, `handle`) are simply absent. `Parallel.pool(env, opts)` always returns a full `Pool<B, C>`. The two factories never overlap; type narrowing is by-construction, not by overload-on-literal-string.

---

## §3 — Architecture overview

### 3.1 The three auto-selectable topologies (and the opt-in fourth)

```
                 ┌────────────────────────────────────────────────┐
Topology A:      │  Caller Worker (fetch handler)                 │
in-DO fan-out    │      │ RPC                                     │
size ≤ 4         │      ▼                                         │
                 │  Coordinator DO                                │
                 │      │  parallel env.LOADER.get(id, cb)        │
                 │      ├──▶ Loader-1 (fresh isolate, exec)       │
                 │      ├──▶ Loader-2                             │
                 │      └──▶ Loader-N (cap = 4 from a DO method)  │
                 │      ◀── results ──                            │
                 └────────────────────────────────────────────────┘
   Ceiling: 4 parallel isolates per coordinator request.
   the DO+loader test validated 4.03× speedup at N=4. Lowest dispatch overhead
   (no DO-to-DO RPC).
```

```
                 ┌──────────────────────────────────────────────────┐
Topology B:      │  Caller Worker                                   │
hybrid pool      │      │ RPC                                       │
size 5..128      │      ▼                                           │
(default for     │  Coordinator DO                                  │
 most workloads) │      │  parallel RPCs to ceil(size/4) child DOs  │
                 │      ├──▶ Worker DO #1 ─┬─▶ LOADER.get('A1') ─▶ isolate
                 │      │                  ├─▶ LOADER.get('A2') ─▶ isolate
                 │      │                  ├─▶ LOADER.get('A3') ─▶ isolate
                 │      │                  └─▶ LOADER.get('A4') ─▶ isolate (cap=4 per DO)
                 │      ├──▶ Worker DO #2  (same shape; up to 4 isolates)
                 │      ⋮                                           │
                 │      └──▶ Worker DO #N  (N = ceil(size/4) ≤ 32)  │
                 │      ◀── results ──                              │
                 └──────────────────────────────────────────────────┘
   Ceiling: 4 × N = up to 128 parallel isolates per coordinator request.
   N is bounded by ~32 RPC fan-out per request (dossier I2; the DO-RPC fan-out test
   validated N=32 fully parallel). Each isolate has its own ~128 MiB
   heap; cross-host placement (DOs spread within a colo).
   This is the MAX-parallel default for everyday workloads.
```

```
                 ┌──────────────────────────────────────────────────────┐
Topology C:      │  Caller Worker                                       │
hierarchical     │      │ RPC                                           │
tree             │      ▼                                               │
size > 128       │  Root Coordinator DO                                 │
(or explicit     │      │ parallel RPCs to F tier-1 sub-coords          │
 maxFanOut=B)    │      ├──▶ Sub-coord A ─┬─▶ Leaf DO A1 (4 loaders)    │
                 │      │                 ├─▶ Leaf DO A2 (4 loaders)    │
                 │      │                 ⋮                             │
                 │      │                 └─▶ Leaf DO A_F (4 loaders)   │
                 │      ├──▶ Sub-coord B  (same shape)                  │
                 │      ⋮                                               │
                 │      └──▶ Sub-coord F  (same shape)                  │
                 │      ◀── reduced results ──                          │
                 └──────────────────────────────────────────────────────┘
   Ceiling: 4 × F^K parallel isolates for K tiers, branching factor F.
   tiers = ceil(log_F(size / 4)). With F=8 default:
     size=128 → K=2 (up to 256 isolates)
     size=1024 → K=3 (up to 2048)
      size=8192 → K=4 (up to 16384)
    Latency cost: K × DO-RPC hop (~3 ms warm, 30–80 ms cold per hop).
    Used past 128 because (a) single-coord ~32 fan-out cap, (b) deep
    fan-out from a single DO causes back-pressure under sustained load.
```

```
                 ┌────────────────────────────────────────────────┐
Topology 0:      │  Caller Worker (fetch handler)                 │
loader-only      │      │ env.LOADER.get(id, cb)                  │
(separate        │      ├──▶ Loader-1 (fresh isolate, exec)       │
 factory only;   │      ├──▶ Loader-2                             │
 not a `Pool`    │      └──▶ Loader-3 (cap = 3 from fetch handler)│
 topology)       │      ◀── results ──                            │
                 └────────────────────────────────────────────────┘
   Reachable EXCLUSIVELY via Parallel.loaderOnly(env, opts), which
   returns a structurally smaller LoaderOnlyPool type. Hard cap at
   size=3. Use only when you specifically need zero DO ops.
```

### 3.2 Why loader-only is a separate factory

In-DO Topology A is strictly more parallel (4 vs 3) and only adds ~30–80 ms cold-start on first call (warm subsequent). For any production workload that ever needs `warm`, `drain`, `stats`, streaming, or `pool.handle`, the in-DO topology is correct from start. Users who specifically want zero-DO ops call `Parallel.loaderOnly(env, opts)`, which returns a structurally smaller `LoaderOnlyPool` type. Methods unimplementable without a coordinator (`warm`, `drain`, `stats`, `mapStream`, `mapOrdered`, `submitStream`, `handle`) are *absent at the type level* — calling them is a compile-time error, not a runtime no-op.

### 3.3 Why `WorkerEntrypoint` RPC everywhere on the wire

All inter-Worker hops in the library use RPC method calls (`WorkerEntrypoint`-extending classes), never `fetch()`:

- I13: per-pipeline 6-concurrent-connection limit applies to `fetch()` but **not** to `BINDING.fetch` / RPC.
- I14: RPC sessions roll up billing better (one DO RPC session = one billed DO request, regardless of nested calls).
- Smart Placement is *ignored* for inter-Worker RPC — co-location preserved.

The HTTP submit-code "VM" surface in §5.4 is the *only* `fetch`-shaped public surface, and it terminates at the library boundary (the request immediately becomes an RPC call to the coordinator).

---

## §4 — Topology selection

### 4.1 Auto-selector

```ts
type Topology = 'auto' | 'in-do' | 'hybrid' | 'tree';
// Note: 'loader-only' is NOT in this union — it's a separate factory (Parallel.loaderOnly()).

function selectTopology(size: number, opts: PoolOptions, env: PoolEnv): Exclude<Topology, 'auto'> {
  const explicit = opts.topology;
  if (explicit && explicit !== 'auto') return explicit;       // honor pinning

  const threshold = opts.treeThreshold ?? 128;
  if (size <= 4)         return 'in-do';                       // single DO + ≤4 loaders (the DO+loader test)
  if (size <= threshold) return 'hybrid';                      // ceil(size/4) DOs × 4 loaders (the loader-cap × DO fan-out composition)
  return 'tree';                                               // hierarchical multi-coord
}
```

Loader-only is reachable exclusively via `Parallel.loaderOnly()`. The auto-selector cannot return it (it's not in the type union). This makes the type-narrowing structural and unbypassable.

### 4.2 Hybrid leaf-shape — the new MAX-parallel default

For `5 ≤ size ≤ treeThreshold` (default 128):

- Number of child DOs: `N = ceil(size / 4)`.
- Each child DO method, when called from the Coordinator, runs up to 4 concurrent loaders (the DO+loader test cap).
- Coordinator → child DO is RPC, NOT loader-bound (RPC fan-out is not loader-capped).
- Each isolate has its own ~128 MiB heap and lives on the host where its child DO lives (cross-host within a colo).

**Capacity vs load — distinguish two numbers**:
- *Capacity ceiling* `C = 4N = 4·ceil(size/4)`. Always ≥ size, ≤ size + 3. The maximum number of isolates the topology *could* spin up.
- *Actual concurrent isolates dispatched* = `size`. Library never exceeds this.

**Leaf-shape distribution algorithm**. Distribute `size` jobs across `N` DOs with no DO exceeding 4 loaders. The library uses **balanced-fill** — the first `(size mod N)` DOs get `ceil(size/N)` loaders, the remaining `(N - size mod N)` DOs get `floor(size/N)` loaders. With `N = ceil(size/4)`, this is equivalent to: fill DOs 4-at-a-time from index 0 until we run out of work; the last DO gets the remainder.

```
size=17, N=5:  [4, 4, 4, 4, 1]      // first four DOs full (16), last gets remainder (1)
size=20, N=5:  [4, 4, 4, 4, 4]      // exact fill
size=10, N=3:  [4, 3, 3]            // ceil(10/3) = 4; size mod N = 1; first DO gets 4, rest get 3
size=128, N=32: 32 × 4               // exact fill — the hybrid ceiling
```

`topology/plan.ts` exposes the resulting distribution as a typed `TopologyPlan.fanOut: number[]`. Selector golden tests in §11.1 pin the algorithm.

### 4.3 Hierarchical tree for size > treeThreshold (default 128)

In tree topology, every tier *except the deepest* is a coordinator-only DO that fans out RPCs; the deepest tier is a hybrid leaf — child DOs each running up to 4 loaders. **K counts coordinator tiers above the hybrid leaf**, so total depth from caller to loader is K+1 RPC hops + 1 LOADER.get.

Branching factor F (default `8`, configurable via `opts.branchingFactor`, range 4..16). Depth `K = ceil(log_F(size / 4))`.

- size=128 fits in hybrid (no tree).
- size=129..1024 → K=2 with F=8 (up to 4 × 8² = 256 isolates).
- size=1025..8192 → K=3 (up to 4 × 8³ = 2048).
- size > 8192 → K=4 (up to 4 × 8⁴ = 16384).
- size > 65536 → K=5 (up to 4 × 8⁵ ≈ 131k).

**Tree work-distribution algorithm** (extends §4.2 balanced-fill recursively): each tier divides its incoming `size` evenly across `F` sub-coords using balanced-fill. The bottom tier's hybrid leaves use balanced-fill to pin loaders to ≤4 per DO. `topology/plan.ts` builds a typed `TopologyPlan` AST and §11.1 pins the per-size leaf-shape vector.

```
size=200, F=8, K=2:
  root → 8 sub-coords (each receives 25 jobs) → each sub-coord → 7 leaf DOs (balanced-fill: [4,4,4,4,4,4,1])
  total leaves: 8 × 7 = 56;  total isolates: 200
size=2000, F=8, K=3:
  root → 8 sub-coords (250 each) → each → 8 sub-coords (32 each) → each → 8 leaf DOs (balanced-fill 4×8)
  total leaves: 8 × 8 × 8 = 512;  total isolates: 2000
```

Each tier consumes one DO RPC hop (~5 ms warm, 30–80 ms cold). Total request latency adds (K+1) × hop. The library does NOT cap aggregate fan-out (cost is not a concern); for latency-sensitive paths, raise `treeThreshold` (defer tree onset) or pin `topology: 'hybrid'` (refuse to cascade — fails at runtime if `size > maxFanOut * 4`).

### 4.4 Choice of branching factor F = 8

F = 8 is a balance between:
- **Latency**: depth = ceil(log_F(size/4)). F=8 gives K=2 up to 256, K=3 up to 2048, K=4 up to 16k. Shallower trees mean fewer RPC hops.
- **Per-tier RPC fan-out**: each tier emits F outbound RPCs. F=8 keeps each tier well below the documented ~32 RPC fan-out cap. Avoids deep-fan-out back-pressure on a single DO.
- **Subrequest budget per Worker invocation**: each tier consumes F outbound RPCs + 1 inbound. F=8 → 9 subrequests per tier; trivial against Bundled 50 / Unbound 1000.
- **LRU thrash per leaf**: each leaf DO sees ~`size/F^K` jobs. With F=8 and 50/owner LRU per leaf process, leaves hit thrash at very different sizes.
- **Simplicity**: `ceil(log_8(N))` is human-legible.

`F = 4` is the principled alternative for high-fn-shape-diversity workloads: it gets you to ≥`size` leaves with smaller per-tier fan-out (less single-DO back-pressure when you have many concurrent users) at the cost of one extra tier on large sizes (K=4 with F=4 reaches 1024 leaves; F=8 reaches 4096). Recommend `branchingFactor: 4` when each leaf process is likely to see >25 distinct fn shapes (≈ 50/2 LRU headroom).

F is exposed as `opts.branchingFactor` (range 4..16). Below 4 is rejected (forces excessive depth); above 16 saturates per-tier RPC fan-out.

### 4.5 Override surface

```ts
Parallel.pool(env, {
  topology: 'auto' | 'in-do' | 'hybrid' | 'tree',  // default 'auto' (loader-only via Parallel.loaderOnly())
  maxFanOut: 32,           // per-coordinator RPC fan-out cap; default 32
  branchingFactor: 8,      // hierarchical-tree branching; default 8 (range 4..16)
  treeThreshold: 128,      // hybrid → tree boundary; default 128
});
```

Explicit `topology: 'in-do'` with `size > 4` throws `TopologyError` at first dispatch (loud failure). Same for `'hybrid'` with `size > maxFanOut * 4` if the user pinned it.

---

## §5 — Public TypeScript API

The user-facing surface is small and generic-typed end-to-end. Five entry points: `pool` (and the type-narrowed `loader-only` variant), `actor`, `scheduler`, `vm`, `testing`.

### 5.0 Generic typing model

`bindings`, `context`, and `Actor` state flow through the type system as type parameters. Defaults are `{}`. **The library uses two factory functions, not overloads, to distinguish loader-only from full pools** — overload-based discrimination on a `topology` literal is type-soundness-broken when the literal is computed.

```ts
namespace Parallel {
  // Full Pool. Requires DO bindings (auto-selector picks in-do/hybrid/tree).
  function pool<B = {}, C = {}>(
    env: PoolEnv,
    opts?: PoolOptions<B, C>,
  ): Pool<B, C>;

  // Type-narrowed loader-only pool. Hard-cap at size=3 from a Worker fetch handler.
  // Distinct factory (NOT a topology option on `pool`) so the return type is
  // unambiguously narrowed regardless of how `opts` is constructed.
  function loaderOnly<B = {}, C = {}>(
    env: PoolEnv,
    opts?: LoaderOnlyOptions<B, C>,
  ): LoaderOnlyPool<B, C>;

  function actor<State = {}, B = {}, C = {}>(
    env: PoolEnv,
    opts: ActorOptions<State, B, C>,
  ): ActorHandle<State, B, C>;

  function scheduler<B = {}, C = {}>(
    env: PoolEnv,
    opts: SchedulerOptions<B, C>,
  ): Scheduler<B, C>;

  class VM { /* see §5.4 */ }
  function vm<B = {}>(env: PoolEnv, opts: VMOptions<B>): VMHandle;

  namespace testing {
    function poolFake<B = {}>(opts?: { bindings?: B; runner?: ... }): Pool<B>;
    function loaderOnlyFake<B = {}>(opts?: ...): LoaderOnlyPool<B>;
    function actorFake<State, B = {}>(opts: ...): ActorHandle<State, B>;
    function schedulerFake<B = {}>(opts?: ...): Scheduler<B>;
    function vmFake<B = {}>(opts: VMOptions<B>): VMHandle;
  }
}
```

Every `submit` / `enqueue` call infers fn arg/result types end-to-end. `bindings: { AI: env.AI }` makes `env.AI` typed in the user-fn signature, not `any`.

**Cancel signal lives inside `env`, not as a positional argument**. When `SubmitOptions.cancel: CancelToken` is provided OR `SubmitOptions.deadline*` is set, the user fn's `env` parameter receives an additional `signal` field of type `AbortSignal` (a synchronous-pollable shape). When neither is provided, `env.signal` is still present but always-non-cancelled. User fns typed `(x, env) => env.AI.run(...)` work unchanged because `signal` is not an extra positional arg.

```ts
type AbortSignal = {
  poll(): { cancelled: boolean; reason?: string };
  /** Promise that rejects with CancelledError when signalled (for Promise.race). */
  cancelled: Promise<never>;
};

// User fn signature when bindings are configured:
//   (...userArgs, env: B & { signal: AbortSignal }) => R
// User fn signature when bindings are not configured:
//   (...userArgs, env: { signal: AbortSignal }) => R
// `env.signal` is a real `AbortSignal`. Use `env.signal.aborted`,
// `env.signal.throwIfAborted()`, or pass directly to `fetch(url, { signal })`.
```

This decouples fn arity from runtime SubmitOptions shape. **All §5.x examples below assume this shape.**

### 5.1 `Parallel.pool<B, C>(env, opts) → Pool<B, C>`

```ts
const pool = Parallel.pool(env, {
  bindings: { AI: env.AI, KV: env.MY_KV },     // B inferred = { AI, KV }
  context: { multiplier: 3 },                  // C inferred = { multiplier: number }
  timeout: 5000,
  retries: 2,
  retryDelay: 100,
  globalOutbound: null,
  limits: { cpuMs: 30_000, subRequests: 50 },
  topology: 'auto',
  maxFanOut: 32,
  branchingFactor: 8,
  cacheKeyStrategy: 'stable',
  observability: { metrics: 'analytics-engine' },
});

// Public Pool surface (signatures generic-extended for inference):
await pool.submit((x: number) => x * x, 42);                          // → number
await pool.submit((x: number, env) => env.AI.run(...), 42);           // env: B & { signal }
await pool.map((n: number) => n * 2, [1, 2, 3, 4, 5]);                // → number[]
await pool.reduce((a, b) => a + b, [1, 2, 3], 0);                     // → number
await pool.scatter((batch: number[]) => batch.length, dataset, 8);
await pool.gather([pool.submit(f, x), pool.submit(g, y)]);
const pmapped = pool.pmap((batch: T[]) => batch.map(f));
const pipeline = pool.pipe(stage1, stage2, stage3);

for await (const { index, value } of pool.mapStream(fn, items)) { /* ... */ }
for await (const value of pool.mapOrdered(fn, items)) { /* ... */ }

// Cooperative cancel inside user fn (per §5.0 contract):
await pool.submit(async (chunks: Chunk[], env) => {
  for (const chunk of chunks) {
    if (env.signal.aborted) return null;     // cooperative cancel point
    await processChunk(chunk);
  }
}, payload, { cancel: token });

// New in v0.3:
const stream = pool.submitStream<Chunk>((args) => buildReadableStream(...), arg);
                                              // single-submission streaming return
await pool.warm({ isolates: 4 });             // pre-warm coordinator + N loaders
await pool.drain();                            // wait for all in-flight to complete
const stats = await pool.stats();              // PoolStats (see §5.7)
const handler = pool.handle({                  // user-defined HTTP exposure (§5.5)
  auth: (req) => verify(req),
  allowBindings: ['KV'],
});
```

`SubmitOptions` is the trailing options bag:

```ts
await pool.submit(fn, ...args);                       // bare
await pool.submit(fn, ...args, { cancel, timeout });  // with options (last positional)
```

There is no `pool.cancel(...)` method. Cancellation is via `SubmitOptions.cancel: CancelToken` passed at submit time; the user fn's `env.signal` is a real Web-platform `AbortSignal` driven by that token (best-effort cooperative — see §9.3).

### 5.2 `Parallel.actor<State, B, C>(env, opts) → ActorHandle<State, B, C>`

A long-lived stateful actor. Every `actor.submit(fn, ...)` runs against the *same* DO (same in-memory state, same SQLite). Use cases: per-session caches, accumulators, stateful pipelines, event sourcing on user code.

**Single backend: pinned-state.** State is owned by the Coordinator DO's SQLite under a per-actor namespace. The user fn receives `(state, sql, ...userArgs, env)` — `state` and `sql` are prepended; `env` (with `env.signal`) is appended per the §5.0 contract. State is structured-clone-passed in/out of every `submit` call; mutations during the call are persisted before return.

```ts
type SessionState = { history: string[]; total: number };

const session = Parallel.actor<SessionState>(env, {
  id: `session-${sessionId}`,
  bindings: { AI: env.AI },
  initialState: { history: [], total: 0 },
});

const n = await session.submit(
  (state, sql, msg: string, env) => {
    if (env.signal.aborted) return state.history.length;
    state.history.push(msg);
    sql.exec`INSERT INTO log(msg, ts) VALUES (?, ?)`(msg, Date.now());
    return state.history.length;
  },
  'hello',
);

await session.close();                   // graceful shutdown
await session.evict({ persist: true });  // force hibernate; rehydrate on next submit
```

**16 MiB state limit.** State must structured-clone-serialize into ≤ 16 MiB per submit boundary. For larger state, recommend Workflows or partition the state across multiple actors keyed on a sub-id. Documented in §13 R-Actor.

`sql` is a capability-restricted SQLite proxy bound to the actor's per-id namespace inside the Coordinator's storage. It can read and write only its own rows (the library's storage layer enforces the namespace prefix).

### 5.3 `Parallel.scheduler<B, C>(env, opts) → Scheduler<B, C>`

```ts
const scheduler = Parallel.scheduler(env, {
  id: 'jobs-prod',
  store: 'do-storage',                  // 'do-storage' (default) | 'queues' | 'd1' | { custom JobStore }
  fairness: { keyFrom: (job) => job.tenantId, capacityPerKey: 4 },
  retry: { max: 3, backoff: 'exponential', baseMs: 200 },
  deadline: { defaultMs: 60_000 },
  resultRetention: { ttlMs: 3600_000 },
});

// Typed enqueue. Returns a typed JobHandle<R>.
const handle: JobHandle<Result> = await scheduler.enqueue<[Data], Result>({
  fn: heavyJob,
  args: [data],
  tenantId: 't-42',
  deadlineMs: 90_000,                   // relative-from-now (convenience). Or `deadline: <absolute epoch ms>`.
  cancel: parentToken,                  // optional CancelToken
  idempotencyKey: `tenant-42-${requestId}`,
});

const result: Result = await handle.result();   // long-poll-based; reconnects across SchedulerDO restarts
await handle.cancel('user requested');
const status = await handle.status();           // 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

const stats = await scheduler.stats();
for await (const ev of scheduler.events()) { /* ... */ }
await scheduler.cancelByTenant('t-42');
await scheduler.drain();
```

**Idempotency contract.** User fns submitted via `scheduler` MUST be idempotent. Library guarantees at-most-once *result observability* (one `JobHandle.result()` call yields one outcome) but at-least-once *execution* across restarts and lease-expiry retries. Storage CAS predicates (§8.9) make state transitions atomic.

### 5.4 `Parallel.VM` — HTTP submit-code surface

Class-shaped export. `env` is request-scoped (you cannot read it at module top-level); the class form bakes config into a static field.

```ts
import { Parallel } from 'cloudflare-parallel';

export default class extends Parallel.VM {
  static opts: Parallel.VMOptions = {
    pool: { /* PoolOptions */ },
    auth: (req) => req.headers.get('authorization') === 'Bearer …',
    allowBindings: ['KV'],
    language: 'js',                            // 'js' | 'py' (when ready)
    maxBytes: 64 * 1024,                       // request body cap
  };
}
```

Functional form:

```ts
export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return Parallel.vm(env, vmOpts).fetch(req, ctx);
  },
};
```

POST body:

```jsonc
{ "fn": "(x) => x*2", "args": [21], "options": { "timeout": 5000 } }
// → { "ok": true, "value": 42, "stats": { "cpuMs": 0.4 } }
```

Built on `pool.handle()` — users wanting bespoke HTTP routing use that directly.

### 5.5 `pool.handle(opts) → (req, ctx) => Response`

```ts
const handler = pool.handle({
  auth: (req) => verify(req),                           // (req) => boolean | Promise<boolean>
  allowBindings: ['KV'],                                // capability allowlist (intersected with pool.bindings)
  parse: async (req) => ({ fn, args, options }),       // optional custom parser; default = JSON
  format: (result) => Response.json({ ok: true, value: result }),
});

// Hook into your own router:
app.post('/run', handler);
```

### 5.6 Core types (exported)

```ts
export interface PoolOptions<B = {}, C = {}> {
  bindings?: B;
  context?: C;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  globalOutbound?: ServiceStub | null;
  limits?: { cpuMs?: number; subRequests?: number };
  topology?: Exclude<Topology, 'loader-only'>;            // 'auto' | 'in-do' | 'hybrid' | 'tree'; loader-only is via Parallel.loaderOnly()
  maxFanOut?: number;                                     // default 32 (per coordinator level)
  branchingFactor?: number;                               // tree only; default 8 (range 4..16)
  treeThreshold?: number;                                 // hybrid → tree boundary; default 128
  cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';         // default 'stable' (one isolate per fn shape; long-lived warmth)
  observability?: ObservabilityOptions;
  workerOptions?: WorkerCodeOptions;                       // compatibilityDate, etc.
}

/**
 * Options for the type-narrowed Parallel.loaderOnly() factory.
 * No topology field (always 'loader-only'); no DO-coordinator-related options.
 */
export interface LoaderOnlyOptions<B = {}, C = {}> {
  bindings?: B;
  context?: C;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  globalOutbound?: ServiceStub | null;
  limits?: { cpuMs?: number; subRequests?: number };
  cacheKeyStrategy?: 'stable' | 'fresh' | 'auto';
  workerOptions?: WorkerCodeOptions;
}

export interface ActorOptions<State = {}, B = {}, C = {}> extends PoolOptions<B, C> {
  id: string;                                             // routes the actor to a specific DO
  initialState?: State;
  hibernation?: { idleMs?: number; persist?: boolean };   // default { idleMs: 60_000, persist: true }
}

export interface SchedulerOptions<B = {}, C = {}> extends PoolOptions<B, C> {
  id: string;
  store?: 'do-storage' | 'queues' | 'd1' | JobStore;
  fairness?: { keyFrom: (job: Job<any, any>) => string; capacityPerKey: number };
  retry?: { max: number; backoff: 'exponential' | 'linear'; baseMs: number };
  deadline?: { defaultMs: number };
  resultRetention?: { ttlMs: number };                   // default 1h
  alarmCadence?: { activeMs: number; idleMs: number };   // default { active: 5000, idle: 60_000 }
}

export interface VMOptions<B = {}> {
  pool: PoolOptions<B>;
  auth: (req: Request) => boolean | Promise<boolean>;
  allowBindings?: (keyof B & string)[];
  language?: 'js' | 'py';
  maxBytes?: number;
}

export interface SubmitOptions {
  timeout?: number;                                        // wall-clock ms, relative
  retries?: number;
  retryDelay?: number;
  context?: Record<string, unknown>;
  cancel?: CancelToken;
  /** Deadline as ABSOLUTE ms-since-epoch. */
  deadline?: number;
  /** Convenience: relative-from-now ms. Mutually exclusive with `deadline`. Library converts internally. */
  deadlineMs?: number;
  freshIsolate?: boolean;                                  // override stable cache key
  meta?: Record<string, string>;
}

/** Pool topologies. `loader-only` is intentionally NOT in this union — it lives behind a separate Parallel.loaderOnly() factory (§3.2, ADR-1). */
export type Topology = 'auto' | 'in-do' | 'hybrid' | 'tree';

// Cancellation primitive. AbortSignal doesn't cross DO RPC.
// `cancelled` REJECTS (does not resolve) so it composes with Promise.race.
export class CancelToken implements AsyncDisposable {
  static fromAbortSignal(signal: AbortSignal): CancelToken;
  static withTimeout(ms: number): CancelToken;
  child(): CancelToken;                                            // hierarchical
  cancel(reason?: string): void;
  readonly cancelled: Promise<never>;                              // rejects with CancelledError
  readonly isCancelled: boolean;
  /** Synchronous poll for cooperative cancel inside user fns. */
  poll(): { cancelled: boolean; reason?: string };
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Job<A extends unknown[], R> {
  fn: (...args: A) => R | Promise<R>;
  args: A;
  tenantId?: string;
  /** Relative-from-submission ms. */
  deadlineMs?: number;
  /** Or absolute ms-since-epoch. Mutually exclusive with `deadlineMs`. */
  deadline?: number;
  retry?: RetryPolicy;
  cancel?: CancelToken;
  idempotencyKey?: string;
  meta?: Record<string, string>;
}

export interface JobHandle<R> {
  readonly id: string;
  result(): Promise<R>;                                             // long-poll
  status(): Promise<JobStatus>;
  cancel(reason?: string): Promise<void>;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type OnErrorStrategy = 'throw' | 'throw-fast' | 'null' | 'skip' | 'settled';

// Type-narrowed pool returned by Parallel.loaderOnly().
// All Pool primitives accept SubmitOptions.cancel.
// Removed methods (NOT category-error redirects to Parallel.* namespace):
//    warm, drain, stats, mapStream, mapOrdered, submitStream, handle
// Removal rationale: each of those requires a Coordinator DO to either
// (a) hold streaming-iterator state across requests (mapStream/mapOrdered/submitStream),
// (b) maintain pool-level metrics (stats/drain), (c) prewarm DO+loader pairs (warm),
// or (d) terminate at a coordinator-managed HTTP route (handle).
// On loader-only there is no coordinator, so these are unimplementable —
// and surfacing them as runtime errors recreates the silent-fallback
// footgun the v0.3 design fixes.
export interface LoaderOnlyPool<B = {}, C = {}> {
  submit<A extends unknown[], R>(
    fn: (...args: [...A, B & { signal: AbortSignal }]) => R,
    ...args: A
  ): Promise<Awaited<R>>;
  map<T, R>(fn: (item: T, env: B & { signal: AbortSignal }) => R, items: T[], opts?: MapOptions): Promise<Awaited<R>[]>;
  reduce<T>(fn: (a: T, b: T) => T, items: T[], initial: T): Promise<T>;
  scatter<T, R>(fn: (items: T[], env: B & { signal: AbortSignal }) => R, items: T[], chunks: number): Promise<Awaited<R>[]>;
  gather<T>(promises: Promise<T>[]): Promise<T[]>;
  pmap<T, R>(fn: (batch: T[], env: B & { signal: AbortSignal }) => R[]): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]>;
  pipe<A, B2>(f1: (a: A, env: B & { signal: AbortSignal }) => B2): (input: A) => Promise<Awaited<B2>>;
  // ...further pipe overloads identical to Pool.
}
```

### 5.7 Stats shapes (pinned)

```ts
export interface PoolStats {
  inFlight: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
  topology: Exclude<Topology, 'auto'>;     // 'in-do' | 'hybrid' | 'tree'
  topologyDecisionAt: number;        // ms epoch
  warmIsolatesEstimate: number;
  uniqueFnShapesToday: number;
  lruEvictionLast60sCount: number;   // observability for LRU thrash inflection
  treeDepth: number;                 // 1 for in-do/hybrid, K for tree
  fanOutPerLevel: number[];          // e.g. [8, 8, 4] for K=3 with mixed leaves
}

export interface SchedulerStats extends PoolStats {
  byTenant: Record<string, { queued: number; running: number }>;
  oldestQueuedAgeMs: number;
  resultRetentionTtlMs: number;
}
```

### 5.8 Testing surface — `Parallel.testing.*`

```ts
import { Parallel } from 'cloudflare-parallel/testing';
import { test, expect } from 'bun:test';

test('user fn produces correct sum', async () => {
  const pool = Parallel.testing.poolFake<typeof bindings>({
    bindings: { KV: kvStub },
    runner: async (fn, args) => {
      // Default: round-trips args through structuredClone before invoking,
      // and through structuredClone on the return — catches non-cloneable I/O at test time.
      return fn(...args);
    },
  });

  expect(await pool.submit((x, y) => x + y, 2, 3)).toBe(5);
});
```

`poolFake`, `actorFake`, `schedulerFake`, `vmFake`. Each enforces structured-clone-roundtrip on args/state/return so a fn that works in the fake but breaks in production is impossible by construction. Production-shaped option types accepted identically.

---

## §6 — Internal module layout

```
src/
  api/
    pool.ts           — public Pool<B, C> + LoaderOnlyPool<B, C> classes (RPC façade)
    actor.ts          — ActorHandle<State, B, C> (pinned-state)
    scheduler.ts      — Scheduler<B, C>; JobHandle<R>; cancelByTenant
    vm.ts             — Parallel.VM class + Parallel.vm() functional form
    parallel.ts       — Parallel.{pool, actor, scheduler, vm, testing} top-level
    primitives.ts     — pure(), constant()
    cancel.ts         — CancelToken (rejects, hierarchical, AsyncDisposable, fromAbortSignal, poll)
    errors.ts         — typed error hierarchy
    testing.ts        — poolFake / actorFake / schedulerFake / vmFake (in-process, structured-clone-enforcing)

  topology/
    selector.ts       — selectTopology(size, opts, env) → Topology
    loader-only.ts    — `Parallel.loaderOnly()` factory + `LoaderOnlyPool` impl (no DO needed)
    in-do.ts          — Topology A (single coordinator + 4 loaders)
    hybrid.ts         — Topology B: ceil(size/4) child DOs × 4 loaders each
    tree.ts           — Topology C: hierarchical multi-coord; branching factor F
    plan.ts           — TopologyPlan typed AST: { topology, fanOut[], leafShape }

  coordinator/
    coordinator.ts    — Coordinator DO class. Cancel race at coordinator. Per-DO loader semaphore (≤4).
    worker-do.ts      — Worker DO (hybrid leaf): receives RPC, runs up to 4 loaders concurrently
    sub-coordinator.ts — Sub-coordinator DO (tree mid-tier)
    do-class.ts       — exported DO classes (CfpCoordinator / CfpWorkerDO / CfpSubCoord / CfpSchedulerDO)

  scheduler/
    scheduler-do.ts   — CfpSchedulerDO; thin shim around Dispatcher core
    dispatcher.ts     — pure reactive dispatcher (fair-queueing, single-flight)
    job-store.ts      — JobStore interface (CAS-shaped enqueue/claim/ack/fail/peek/list/cancel)
    stores/
      do-storage.ts   — default backend (SQLite, CAS predicates)
      queues.ts       — Cloudflare Queues adapter (attachQueue)
      d1.ts           — D1 adapter
    policies/
      fairness.ts     — token-bucket per tenantId
      retry.ts        — exponential / linear / custom; jitter built in
      deadline.ts     — monotonic deadlines, ≥1s minimum, skew tolerance
      idempotency.ts  — at-least-once contract enforcement + result retention TTL

  loader/
    codegen.ts        — module source generation per mode (pool-fn, actor-class, sub-coord)
    serialize.ts      — fn.toString + this-rejection + return-value validator
    sandbox.ts        — allow/deny lists; default-deny library-internal bindings; sealed globalThis when globalOutbound=null
    loader-budget.ts  — per-isolate concurrent-load semaphore (cap = 3 from Worker, 4 from DO; auto-detected)
    cache-key.ts      — stable (workerId, codeHash) generation; counter only when freshIsolate=true
    return-validator.ts — rejects RPC stubs in returns; auto-converts >16 MiB to streams; >32 MiB raises
    canonicalize.ts   — JSON canonicalizer for context (sorted keys, rejects Map/Set/Date/RegExp/Symbol)

  transport/
    rpc-client.ts     — typed RPC client wrapper around generated stubs
    error-marshal.ts  — remote-throw → typed-error mapping; CPU-limit detection (probe path §10.4)
    deadline-prop.ts  — deadline propagation as cookie-shaped wrapper (not positional arg)

  observability/
    metrics.ts        — counters, histograms (Analytics Engine writes)
    tracing.ts        — span-shaped events; tracestate propagation
    tail.ts           — Tail-Worker auto-attach (sampling default 0.1)

  config/
    wrangler.ts       — programmatic wrangler.toml fragments (reserved Cfp* namespace)
    doctor.ts         — `cloudflare-parallel doctor` CLI: validates wrangler.toml ↔ code shape
    defaults.ts       — single source of truth for default values

  index.ts            — public re-exports

testing/                — separate exports path (production bundles do not pull in fakes)
  index.ts             — re-exports api/testing.ts as cloudflare-parallel/testing
```

---

## §7 — Codegen / sandboxing / serialization

### 7.1 Source generation modes

`generateWorkerSource(fnSource, { context, passEnv, mode })` produces an ES module per mode:

- `'pool-fn'`: `WorkerEntrypoint` exposing `execute(...args)`. Used in all loader-backed paths.
- `'actor-class'`: a class with a `submit(fnSource, state, args)` method that lazily evaluates user fns and prepends `(state, sql)` as the first two arguments — explicit args, NOT `this`. Lives inside the Coordinator's per-actor namespace.
- `'sub-coord'`: a Coordinator-shaped class loaded into a fresh Worker so a parent coordinator can delegate to it (used in Topology C). Receives a typed `TopologyPlan` describing its slice of the tree.

### 7.2 Cache-key strategy

```
loader id = `cfp:${codeHash}`              // stable, dedups across submissions; default
loader id = `cfp:${codeHash}:${i}`         // forced fresh isolate; opt-in per-call
loader id = `cfp:${codeHash}:${windowMs}`  // opt-in 'auto': fresh-per-60s-window
```

`PoolOptions.cacheKeyStrategy: 'stable' | 'fresh' | 'auto'` controls behavior:
- `'stable'` (default): one isolate per fn shape; long-lived heap reuse. Best for steady-state throughput. Module-level state in the loaded isolate persists between calls — user fns must not rely on per-call freshness.
- `'fresh'`: counter-suffixed; forces a fresh isolate per call. Use only when you genuinely need a clean V8 heap per submission (testing, sandboxing distrusted code per-call). Pays full isolate-load cost on every call.
- `'auto'` (opt-in): hybrid — buckets by 60-second windows. Fresh isolate per shape per 60s window. Use only when (a) you have a small fixed set of fn shapes AND (b) you actively want periodic isolate refresh. With high fn-shape diversity (>50 distinct shape-windows/hour) this thrashes the per-owner LRU and causes cold-start storms; the default was changed away from `'auto'` after a third-party review surfaced the eviction storm.

Per-submission `{ freshIsolate: true }` overrides for hot calls.

### 7.3 Sandbox controls

- `globalOutbound: null` is the default; users opt out per-pool.
- When `null`, codegen seals `globalThis.fetch`, `globalThis.connect`, `caches.default` — defensive even though the runtime already throws.
- **Default-deny library-internal bindings.** The library's own DO bindings (`CfpCoordinator`, `CfpWorkerDO`, `CfpSubCoord`, `CfpSchedulerDO`) are NEVER forwarded to dynamic workers regardless of what user passes in `bindings:`. Hard-coded blocklist.
- `Parallel.VM.allowBindings` and `pool.handle({ allowBindings })` further constrain what reaches user code's `env` (intersected with `pool.bindings`).
- `ctx.exports` is opt-in inside dynamic workers (`opts.sandbox.allowCtxExports: true`); default off. Library-internal DOs are also blocklisted from `ctx.exports.X` (defense in depth).
- Optional `sandbox.semaphoreFetch: true` wraps `globalThis.fetch` in a 6-permit semaphore inside the dynamic worker so user code sees clean back-pressure rather than mysterious stalls. Opt-in.

### 7.4 Serialization rules

- Args must be structured-cloneable (RPC enforces).
- Context values must be JSON-canonicalizable (sorted keys; reject `Map`/`Set`/`Date`/`RegExp`/`Symbol`/circular). Errors raised as `SerializationError` at submit time.
- Functions referencing `this` are rejected at submit time (actor mode uses explicit `(state, sql)` args).
- **Return-value validation.** The dynamic worker's `execute` wrapper inspects every return:
  - If the value contains `RpcStub`/`RpcTarget`, throw `SerializationError('returned values cannot include RPC stubs')`.
  - If structured-clone size > 16 MiB and value is not a `ReadableStream`, auto-convert to `ReadableStream<Uint8Array>` of structured-clone-encoded chunks; coordinator de-streams.
  - If structured-clone size > 32 MiB and conversion not possible, throw `ReturnTooLargeError`.
  - Circular structures: `DataCloneError` mapped to `SerializationError`.
- **Submit options heuristic.** The "last-positional-looks-like-options" heuristic: a final positional arg is treated as `SubmitOptions` only if it's a plain object with at least one option key (`timeout`, `retries`, `retryDelay`, `context`, `cancel`, `deadline`, `deadlineMs`, `freshIsolate`, `meta`) and not a `Date`/`RegExp`/`Map`. To force a final-positional plain-object arg through, wrap in an array.

### 7.5 Per-V8-isolate loader budget enforcement

The library never issues more than `cap` concurrent `env.LOADER.get(...)` calls from a single V8 isolate, where `cap = 3` from a Worker fetch handler and `cap = 4` from a DO method. Implementation: a per-isolate semaphore in `loader/loader-budget.ts`. Auto-detected at coordinator startup via a small probe (cost: one cancelled DW invocation; result cached in `globalThis.cfpLoaderCap`). The cache is per-V8-isolate (per-process); a fresh DO instance re-probes once on first dispatch. Library does NOT share the value via DO storage or KV.

**The per-isolate invariant.** A V8 isolate is a closed world: each isolate has its own heap, its own bag-of-globals, and its own `globalThis`. There is no shared module state across isolates — every `import` evaluates per-isolate, every top-level `let` is per-isolate, and every property assigned to `globalThis` is per-isolate by construction. We rely on this for the loader semaphore: stashing the semaphore on `globalThis.cfpLoaderSem` gives us exactly one semaphore per isolate, with zero cross-isolate coupling. Two DO instances on the same metal but in different isolates do not see each other's semaphore state — which is precisely what the hybrid topology needs to compose `4 × N` parallelism.

**Permit released on caller-settle, not on `LOADER.get` resolution**. The semaphore permit returns to the pool the moment the caller's outer promise settles (success / error / cancel), regardless of whether the underlying loader call has actually completed. This avoids a deadlock where 4 cancelled-but-orphaned isolates hold all permits while the caller has moved on. Consistent with ADR-11 ("library does NOT track or cap orphan isolates"): the orphan continues running in the runtime's view, but the library's semaphore book-keeping treats the slot as available for the next dispatch.

Topology selector knows the leaf cap; at runtime the in-DO topology never exceeds it, the hybrid topology splits work across child DOs (each with its own per-isolate semaphore), and the tree topology splits across sub-coords (each with its own).

---

## §8 — Job scheduler / queue

### 8.1 `JobStore` interface

```ts
export interface JobStore {
  enqueue(job: PersistedJob): Promise<void>;
  claim(opts: { workerId: string; max: number }): Promise<PersistedJob[]>;
  ack(jobId: string, result: unknown): Promise<void>;
  fail(jobId: string, err: SerializableError, retryAt?: number): Promise<void>;
  cancel(jobId: string, reason?: string): Promise<void>;
  status(jobId: string): Promise<JobStatus>;
  peek(opts: { tenantId?: string; limit: number }): Promise<PersistedJob[]>;
  events(opts?: { since?: number }): AsyncIterable<JobEvent>;
}
```

### 8.2 DO-storage default schema

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  fn_hash TEXT NOT NULL,
  fn_source TEXT NOT NULL,
  args BLOB NOT NULL,
  meta JSON,
  created_at INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,            -- absolute epoch ms
  retry_max INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_base_ms INTEGER NOT NULL,
  retry_backoff TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','leased','done','failed','cancelled')),
  lease_owner TEXT,
  lease_expires_ms INTEGER,
  result BLOB,
  result_expires_ms INTEGER,               -- TTL for ack'd results
  error TEXT,
  idempotency_key TEXT,
  UNIQUE(idempotency_key)
);
CREATE INDEX jobs_status_tenant_created ON jobs(status, tenant_id, created_at);
CREATE INDEX jobs_status_deadline ON jobs(status, deadline_ms);
CREATE INDEX jobs_lease_expiry ON jobs(status, lease_expires_ms);
CREATE INDEX jobs_result_expiry ON jobs(status, result_expires_ms) WHERE status = 'done';
```

### 8.3 Fairness

Token-bucket per `tenantId` with `capacityPerKey` tokens. Scheduler picks next eligible jobs by `ORDER BY (tokens_available_for_tenant DESC, created_at ASC)`.

### 8.4 Backpressure

Cost is not a concern; library never refuses work on cost grounds. Queue is unbounded by default. Users who want a cap can pass `opts.maxQueued`; default = `Infinity`. Multi-tier scheduler is auto-engaged when sustained queue depth would exceed reasonable single-DO storage performance (default threshold 100k, configurable).

### 8.5 Retries

`retryAt = now + base * factor^attempt + jitter(±25%)` (default exponential). `retry_count` updated atomically with `status` flip. DLQ: after `retry_max`, status flips to `failed`. With `store: 'queues'`, real `dead_letter_queue` configured.

### 8.6 Cancellation

`scheduler.cancel(jobId)` flips `status` to `cancelled` if `queued`, or signals the running worker's cooperative `CancelToken` if `leased`. Cooperative poll model — see §9.3.

### 8.7 Deadlines

Absolute epoch ms internally. Scheduler enforces by:
1. The dispatcher pre-claim deadline check (see §8.10) marks expired queued jobs `failed` immediately via `JobStore.failQueued`. No retry.
2. Alarm tick sweeps `jobs WHERE deadline_ms < now AND status='leased'` to reclaim leases that outlived their deadline. **Adaptive cadence**: 5s when active jobs exist, 60s when idle.
3. `deadline_ms` propagates as a structured-clone *cookie* on the RPC envelope. The worker's `execute` wrapper races against the remaining budget.

Minimum 1s deadline budget. Sub-second deadlines rejected at submit.

### 8.10 Reactive dispatch (replaces alarm-batched dispatch)

The SchedulerDO uses a pure {@link Dispatcher} core (`src/scheduler/dispatcher.ts`) with three sets:
- **Storage** (canonical): DO SQLite via `DoStorageJobStore`.
- **Ready** (in-memory, derived): `Map<tenantId, PersistedJob[]>` for fair round-robin.
- **Running** (in-memory, derived): `Map<jobId, RunningJob>` for in-flight bookkeeping.

Flow:
1. `enqueue` writes to storage → mirrors to ready → kicks the dispatch loop.
2. The dispatch loop is single-flight (`#loopRunning` guard); pulls jobs round-robin across tenants up to `inFlightLimit`, capped by `fairCapacityPerTenant` per tenant. For each pick: `claim({ jobId })` (CAS on the specific row chosen by fair-queueing — never "oldest queued"); fire-and-forget `runJob`. On settle: ack/fail in storage; `kick()` re-enters.
3. Alarms exist only as a backstop: retry-after-backoff (`onScheduleRetry`), result-TTL sweep, expired-lease reclaim.

Throughput: bounded by `inFlightLimit × loader-cap-per-isolate` (=4 from a DO method); default `inFlightLimit=32` ⇒ ~128 concurrent isolates per DO. The previous alarm-batched model capped at `MAX_BATCH_PER_ALARM / ALARM_SWEEP_MS = 4 / 5s = 0.8 jobs/s`. Measured throughput in `tests/unit/dispatcher.test.ts` exceeds 50 jobs/s on the test runner; production worker throughput is bounded by isolate cold-start and downstream latency, not by dispatch.

### 8.8 Persistence-flavor matrix

| Backend | Pros | Cons | When |
|---|---|---|---|
| `do-storage` (default) | zero-RPC, transactional, co-located, ordered | ties scheduler to a single DO | jobs ≤ ~5k/s sustained, single-tenant or sharded scheduler IDs |
| `queues` | DLQ, ack-after-side-effect, external producers | 2 hops, unordered visibility | external producers, durability across restarts. Use `Scheduler.attachQueue(env.MY_QUEUE)` when you already operate a Queue. |
| `d1` | SQL admin queries, multi-DO consumers | network hop | very low throughput, admin-heavy |
| `{ custom JobStore }` | escape hatch | user owns correctness | testing, foreign systems |

### 8.9 Idempotency contract

The scheduler is at-least-once, not exactly-once. User fns submitted via `scheduler` MUST be idempotent. Library enforces correctness *at the storage layer* via CAS predicates; users enforce *side-effect* idempotency via `idempotencyKey` and downstream API idempotency.

```sql
-- claim: only succeeds if status was 'queued' or lease expired
UPDATE jobs
   SET status = 'leased', lease_owner = ?, lease_expires_ms = ?
 WHERE id = ?
   AND (status = 'queued'
        OR (status = 'leased' AND lease_expires_ms < ?))
RETURNING *;

-- ack: only succeeds if owner matches and status is leased
UPDATE jobs
   SET status = 'done', result = ?, result_expires_ms = ? + ?
 WHERE id = ? AND status = 'leased' AND lease_owner = ?
RETURNING id;

-- fail with retry: idempotent retry_count increment
UPDATE jobs
   SET status = CASE WHEN retry_count + 1 >= retry_max THEN 'failed' ELSE 'queued' END,
       retry_count = retry_count + 1,
       lease_owner = NULL, lease_expires_ms = NULL, error = ?
 WHERE id = ? AND status = 'leased' AND lease_owner = ?
RETURNING status;

-- cancel: idempotent transition
UPDATE jobs SET status = 'cancelled'
 WHERE id = ? AND status IN ('queued', 'leased');
```

If `ack` returns 0 rows, the worker's lease was lost (likely deadline expiry). Result discarded; no error surfaced.

`JobHandle.result()` long-polls (200ms jittered) until `status` ∈ `{done, failed, cancelled}` or deadline. Survives SchedulerDO restarts because each call is independent.

`result_expires_ms` is set on `ack`. Default `resultRetention.ttlMs = 1h`. After expiry, alarm sweep deletes the row. `JobHandle.result()` resolves with `ResultExpiredError` if called after TTL.

---

## §9 — Failure model

### 9.1 Error hierarchy

All errors derive from `ParallelError` so a single `instanceof` catches the family.

```
ParallelError
├── SerializationError
│   ├── ReturnTooLargeError                (return >32 MiB)
│   └── DeadlineTooShortError              (deadline budget < min for tree depth)
├── ExecutionError
│   ├── DisconnectedError                  (eviction-mid-flight or abortIsolate)
│   ├── OutOfMemoryError                   (V8 OOM; no retry)
│   └── BillingLimitError                  (cpuMs, subRequests; { kind: 'cpuMs' | 'subRequests' | 'memory' })
├── TimeoutError
├── RetryExhaustedError
├── BindingError
├── CancelledError                         (explicit cancel, carries reason)
├── DeadlineExceededError
├── BackpressureError                      (runtime LRU/owner-quota pressure; RETRYABLE — see §9.2)
├── ResultExpiredError
├── ConflictError                          (CAS failure on scheduler ops)
├── TopologyError                          (explicit topology pinned beyond its size)
└── AggregateExecutionError                (multi-error fan-out under default 'throw'; .errors + .partialResults)
```

`AggregateExecutionError` (multi-error, default `onError: 'throw'`):

```ts
class AggregateExecutionError extends ParallelError {
  /** All per-item errors, indexed by item position. */
  readonly errors: ReadonlyMap<number, ParallelError>;
  /** Partial successes preserved alongside the error. */
  readonly partialResults: ReadonlyMap<number, unknown>;
}
```

Single-error case still throws the plain `ParallelError` (no `partialResults` wrapper). `'throw-fast'` opts into fail-on-first behavior — also surfaces `partialResults` if any sibling completed before the cancel propagated.

### 9.2 Eviction & failure matrix

| Event | Detection | Library response |
|---|---|---|
| LRU evicts cached isolate, no in-flight | invisible | Next call rebuilds; transparent. |
| LRU evicts during in-flight | refcount pin | Call completes; transparent. |
| LRU thrash (>50 distinct ids in flight) | empirical (PoolStats.lruEvictionLast60sCount) | Cold-start tax on evictees; no error. Document the inflection. |
| Loaded-isolate hard abort mid-flight | RPC throws opaque disconnection | `DisconnectedError`; one auto-retry on a fresh isolate. |
| Coordinator DO restart | RPC throws, alarms re-fire | `DisconnectedError`; library auto-retries the DO RPC once with backoff. |
| Sub-coordinator crash mid-tree | sub-coord RPC throws | Root partial-results: completed sub-coords delivered; failed sub-coords aggregated into `AggregateExecutionError` per `onError`. One auto-retry on a different sub-coord shard. |
| Sub-coordinator deadline mid-chain | child-token deadline race | Child cancel fires; root receives `DeadlineExceededError` from that branch; surface per `onError`. |
| Cancel propagation fails mid-chain (middle hop dies) | hierarchical-token RPC unreachable | Coordinator's local children continue running until cooperative-poll catches it or `cpuMs` kills them. Surface via `onTaskOrphan` event. |
| Streaming RPC across coordinator restart | downstream `ReadableStream` errors | Surface `DisconnectedError` to consumer (no silent truncation). v0.4 will add resumable cursors. |
| User fn throws | wrapped in `ExecutionError` (preserves `originalName`/`originalMessage`/`originalStack`) | Per-call `retries` policy applies. |
| User fn timeout (wall-clock) | `setTimeout` race in `execute` | `TimeoutError`; `retries` policy applies. |
| User fn CPU limit (production) | RPC error shape match (probe path §10.4) | `BillingLimitError(kind:'cpuMs')`; **no retry**. (Fallback: `DisconnectedError` until probe matches.) |
| Global deadline exceeded | scheduler/coordinator clock check | `DeadlineExceededError`; **no retry**. |
| Cancel before start | `CancelToken` polled | `CancelledError`; no remote call made. |
| Cancel during run, fn cooperative | `CancelToken.poll()` checked at user's await boundaries | `CancelledError` returned; user fn returns gracefully. |
| Cancel during run, fn in tight loop | Coordinator races `Promise.race([rpc, cancelToken.cancelled])` | `CancelledError` to caller IMMEDIATELY; isolate continues until `cpuMs`/wall-clock self-terminates. (Documented contract; no library back-pressure on this — cost is not a concern .) |
| Cascading cancel | hierarchical `CancelToken.child()` | All in-flight tasks dispatched under children receive `CancelledError`. |
| Multi-error fan-out | `Promise.allSettled` collected | `AggregateExecutionError` with all errors when count > 1. |
| Return value > 16 MiB | `return-validator.ts` | Auto-converted to `ReadableStream<Uint8Array>`. |
| Return value > 32 MiB and not stream | `return-validator.ts` | `ReturnTooLargeError`. |
| Returned RPC stub | `return-validator.ts` | `SerializationError('returned values cannot include RPC stubs')`. |
| Runtime BackpressureError ("Too many concurrent dynamic workers"; LRU/owner-quota exhaustion; per-isolate cap miscount) | error-shape match in `error-marshal.ts` | **Retryable.** Exponential backoff with jitter (`base × random(0.5, 1.5) × 2^attempt`), capped at `retries` policy. |
| User fn calls library-internal DO | sandbox blocklist | `BindingError` at codegen time. |

### 9.3 Cancellation contract — live `AbortSignal` over an RPC stream

`env.signal` is a real Web-platform `AbortSignal`. User code uses every standard idiom:

```ts
await pool.submit(async (data, env) => {
  // Pass straight to fetch:
  const res = await fetch(url, { signal: env.signal });
  // Throw on cancel:
  env.signal.throwIfAborted();
  // Listen for cancel:
  env.signal.addEventListener('abort', () => stopWork());
  // Or just check:
  if (env.signal.aborted) return null;
}, payload, { cancel: token });
```

**Live transport.** Cancel state travels caller → coordinator → child DO → loaded isolate as a `ReadableStream<Uint8Array>` carried in the loader's `env.cancelStream`. The Workers runtime structured-clones streams across DO RPC, so a single stream end-to-end is real. When the user's `CancelToken.cancel(reason)` fires, the producer enqueues a single chunk; the consumer at the loaded-isolate end reads the chunk and calls `controller.abort(new CancelledError(reason))` on a local `AbortController` whose signal is exposed as `env.signal`. Latency: bounded by RPC stream propagation (typically < 50 ms in-colo).

**Fan-out forking.** At every level (in-DO 4-loader fan-out, hybrid leaf fan-out, tree sub-coord fan-out) the upstream stream is **tee'd** by `forkCancelStream(stream, n)` so each downstream leg gets its own single-reader copy. Cancel propagates to all branches.

**Caller-side `Promise.race`.** The caller's outer promise is also raced against `cancel.cancelled`, so the caller observes `CancelledError` immediately (even if the loaded isolate is in a tight loop with no awaits). The orphan isolate continues to `cpuMs` / wall-clock — that's a runtime constraint (the Worker Loader API does not yet expose an `abort(id)` primitive; the moment it ships, the runner will additionally actively abort with no public-API change).

**`AbortSignal` not `AbortSignal`.** Web Platform alignment: no invented sigil. `signal.throwIfAborted()`, `signal.addEventListener('abort', ...)`, `signal.reason`, and any consumer that accepts an `AbortSignal` (fetch, ReadableStream.cancel, your own helpers) all work. `CancelToken.fromAbortSignal(signal)` adapts an existing AbortController; `CancelToken.signal` exposes the underlying real AbortSignal.

### 9.4 Partial-failure modes (`onError`)

| Mode | Behavior |
|---|---|
| `'throw'` (default) | Wait for all in-flight (Promise.allSettled-shape internally), then throw. Single error → that error. Multi error → `AggregateExecutionError` with `.errors`. |
| `'throw-fast'` | Cancel all in-flight on first error via hierarchical CancelToken; throw that error immediately. |
| `'null'` | Failed items become `null`. |
| `'skip'` | Failed items omitted. |
| `'settled'` | Returns `Array<{ ok: true; value: R } \| { ok: false; error: ParallelError }>`. |

### 9.5 Deadline propagation

Canonical wire format: absolute ms-since-epoch. User-facing inputs accept either relative (`deadlineMs`) or absolute (`deadline`) and the API converts at submit boundary. Specifying both → `SerializationError`. Minimum 1s budget. Each hop validates against its *own* clock; skew tolerance documented as ~50ms typical.

Hierarchical cancel propagation: when a coordinator dispatches sub-jobs to sub-coordinators or worker DOs, it passes a `child = parent.child()` token. Parent cancel propagates through the entire fan-out tree.

---

## §10 — Observability

### 10.1 Hooks

```ts
export interface Observability {
  onTaskStart?: (e: TaskStartEvent) => void;
  onTaskEnd?: (e: TaskEndEvent) => void;
  onTaskError?: (e: TaskErrorEvent) => void;
  onTaskOrphan?: (e: TaskOrphanEvent) => void;          // tight-loop cancels that didn't return
  onPoolPressure?: (e: PoolPressureEvent) => void;
  onTopologyDecision?: (e: TopologyDecisionEvent) => void;
  onSchedulerEvent?: (e: SchedulerEvent) => void;
  onLruEviction?: (e: LruEvictionEvent) => void;        // observability for LRU thrash inflection
}

const pool = Parallel.pool(env, {
  observability: {
    hooks: { onTaskError: (e) => env.AE.writeDataPoint(...) },
    tail: { binding: env.TAIL_AE, sampling: 0.1 },
    metrics: 'analytics-engine',
  },
});
```

### 10.2 Auto-attach Tail Worker

When `observability.tail.binding` is set, library auto-injects `tails: [tailServiceStub]` into every `WorkerCode` it loads. Default sampling 0.1.

### 10.3 Metrics shape (Analytics Engine)

```
blobs:    [poolId, tenantId, topology, status, errorClass, treeDepth]
doubles:  [cpuMs, wallMs, queueWaitMs, retryCount, deadlineDeltaMs, fanOutSize]
indexes:  [poolId]
```

### 10.4 CPU-limit runtime probe

The shape of `cpuMs exceeded` in production is undocumented. Library response: at coordinator cold-start, run a one-shot probe loading a tiny dynamic worker with `limits: { cpuMs: 1 }` and a busy-loop. The captured error pattern is cached in `globalThis.cfpCpuMsMatcher` for the coordinator's V8 isolate lifetime. Subsequent matched errors map to `BillingLimitError({kind: 'cpuMs'})`. Probe also runs to detect the per-V8-isolate concurrent-loader cap (3 vs 4) at the same time, caching as `globalThis.cfpLoaderCap`.

### 10.5 Tracing

Span-shaped events with `traceId`/`spanId` propagated as `tracestate`-style header across RPC. OpenTelemetry-compatible. Library emits events; no shipped exporter.

---

## §11 — Test strategy

### 11.1 Unit (`bun test`)

- `serialize.ts`: golden suite — serializeFunction over arrow / async / generator / class-method / object-shorthand. `this`-rejection golden.
- `codegen.ts`: golden module-source files per mode (`pool-fn`, `actor-class`, `sub-coord`).
- `topology/selector.ts`: parameterized table pinning expected topology + leaf-shape vector. Goldens:
  - size=1   → `in-do`,  shape=`[1]`
  - size=4   → `in-do`,  shape=`[4]`
  - size=5   → `hybrid`, N=2, shape=`[4,1]`
  - size=10  → `hybrid`, N=3, shape=`[4,3,3]`
  - size=17  → `hybrid`, N=5, shape=`[4,4,4,4,1]`
  - size=20  → `hybrid`, N=5, shape=`[4,4,4,4,4]`
  - size=128 → `hybrid`, N=32, shape=32×`[4]`
  - size=129 → `tree`,   K=2, F=8 (full plan AST asserted)
  - size=200 → `tree`,   K=2, leaves=`8 × [4,4,4,4,4,4,1]`
  - size=2000 → `tree`,  K=3
  - size=8192 → `tree`,  K=3
  - size=8193 → `tree`,  K=4
- `cancel.ts`: cancellation race conditions, hierarchical child cancel.
- `scheduler/policies/*.ts`: token-bucket fairness, retry backoff math, deadline arithmetic.

### 11.2 Wrangler-dev integration

Per topology:

- `Parallel.loaderOnly()` (separate factory): assert N=1..3 succeed, N=4 fails with `Too many concurrent dynamic workers`. Type-check: returned value's type does NOT have `.warm`, `.drain`, `.stats`, `.mapStream`, `.mapOrdered`, `.submitStream`, `.handle`.
- `in-do`: assert N=1..4 succeed with full N× speedup; N=5 picked up by selector → `hybrid`.
- `hybrid`: assert size=8 runs as 2 child DOs × 4 loaders = 8 isolates; size=128 runs as 32 × 4 = 128 isolates; flat scaling.
- `tree`: assert K=2 (size=129..1024) and K=3 (size=1025..8192). Fan-out per level matches.
  - **Chaos tests**: kill K/4 of K sub-coordinators mid-fan-out at random offsets; assert root delivers partial results per `onError` mode. Send `parent.cancel()` to a 1024-way tree at t=200ms; assert all sub-coords stop dispatching new work within 500ms. Induce sub-coord deadline expiry on 1 of K; assert that branch is correctly attributed.

Eviction simulation: `LOADER.get(id, cb)` with callback that logs invocations; force eviction by spawning >50 unique ids; assert library handles re-invocation transparently.

LRU thrash: spawn 60 distinct fn shapes at hybrid size=64; observe `PoolStats.lruEvictionLast60sCount` increases; aggregate throughput drops gracefully (cold-start tax on ~10 evictees per cycle).

### 11.3 Bench harness

Replicate the loader-from-fetch test/B/C/D matrix; CI gate:
- `in-do` size 4: ≥ the DO+loader test baseline ± 10% (4.03× speedup).
- `hybrid` size 32: ≥ the DO-RPC fan-out test baseline ± 10% (the original the DO-RPC fan-out test, 1 loader/DO; new hybrid should be strictly faster).
- `hybrid` size 128: validate 4N math — assert ≥80 simultaneous unique loader isolates.
- `tree` size 1024: scaling factor ≥ 0.7× linear vs hybrid size 128 (latency K-hop overhead dominates linear scaling).
- `vm` size 1: end-to-end p50 ≤ the HTTP submit-code test baseline + 50ms.

### 11.4 Fuzz

`fast-check` table:
- random sizes 1..256, random fn shapes
- random `onError` strategy
- random failure injection (timeout / throw / oom / cancel)
- random cancellation timing
- assert: invariants hold (results length, no orphan in-flight on success path, no leaked timers, no stuck status='leased' rows past lease deadline).

### 11.5 Multi-tenant safety

- A binding NOT in `allowBindings` is unreachable from user code (negative test).
- `globalOutbound: null` blocks `fetch` and `connect`.
- User fn cannot reach `CfpCoordinator`/`CfpSchedulerDO` even if user passes them in `bindings` — must throw `BindingError` at submit time.
- User fn returning an RPC stub raises `SerializationError`.
- User fn returning >32 MiB raises `ReturnTooLargeError`.
- Cascading cancel propagates through 3 hops.
- `globalThis.process.exit` raises `ExecutionError` when `nodejs_compat` is on.
- Custom error class names round-trip via `originalName`.

### 11.6 Testing-surface coverage

- `Parallel.testing.poolFake` runs production-shape examples end-to-end with no `wrangler dev`.
- `Parallel.testing.actorFake` preserves state across `submit` calls.
- `Parallel.testing.schedulerFake` honors retries, deadlines, cancellation in-process.
- All fakes structured-clone-roundtrip args/state/return.

### 11.7 Type-narrowed pool tests

- `Parallel.loaderOnly(env, opts)` returns a value whose type does NOT have `warm`, `drain`, `stats`, `mapStream`, `mapOrdered`, `submitStream`, `handle` — verified via `tsd` or `expect-type`. (Cancel via `SubmitOptions.cancel` IS supported on LoaderOnlyPool — best-effort cooperative same as full Pool.)
- `Parallel.pool(env, { topology: 'in-do' })` returns the full `Pool` type with all methods present.
- Calling `Parallel.pool(env, opts)` always returns `Pool`; there is no compile-time path to a narrowed pool from `.pool()`.

---

## §13 — Open risks + mitigations + ADRs

### 13.1 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Per-V8-isolate concurrent-loader cap (3/4) is undocumented and may shift across runtime versions. | Cold-start probe in `loader-budget.ts` measures empirically; topology selector adapts. Fail-open (use measured value, fall back to 3 if probe fails). |
| R2 | High-fan-out from a single DO causes back-pressure on the inter-DO transport. | `maxFanOut: 32` per coordinator level; tree topology automatically engaged for size > 128. |
| R3 | Worker Loader pricing dedupes by `(workerId, codeHash)`/day. | v0.3 default is stable-id reuse; counter only via opt-in `freshIsolate`. (Cost is documented but not a design driver.) |
| R4 | `AbortSignal` does not cross DO RPC. | `CancelToken` is the cancellation primitive; `CancelToken.fromAbortSignal` adapts at the caller boundary. |
| R5 | Stub forwarding lifetime ≤ introducer's request. | `Actor` and `Scheduler` are DOs; never cache forwarded stubs across requests; rebuild via `ctx.exports` loopback each call. |
| R6 | `cpuMs` may behave differently in local dev than in production. | Set `limits` anyway; runtime probe at startup to learn the production error shape (§10.4). Fuzz with deliberately-overrun fns; document drift. |
| R7 | LRU thrash at >50 distinct loader ids per process per owner. | Document inflection in `PoolStats.lruEvictionLast60sCount`. Cost is graceful (cold-start tax, no error). Library does NOT cap aggregate fan-out . |
| R-Actor | Pinned-state Actor's 16 MiB structured-clone-per-submit cap. | Documented in §5.2; recommend Workflows for larger state, or partition state across actor sub-ids. |
| R-Tree | Subrequest budgets are **per-Worker invocation**, not aggregate cross-tier. Each tree tier consumes ~F outbound RPCs + 1 inbound (≤F+1 ≈ 9 with default F=8) per Worker invocation. The real Bundled risk is at the LEAF if user-fn subrequests + 4 LOADER.get + 1 result-write > 50. | `doctor` CLI flags pools with declared user-fn subrequest count > 45. Library does NOT refuse tree topology on Bundled at construction; the per-tier ≤9 fits within Bundled 50 with massive headroom. |
| R-Cancel | Cooperative cancel relies on user fn polling. Tight loops never see cancel until `cpuMs` kills them. | Documented contract. Coordinator's Promise.race surfaces `CancelledError` immediately to caller. When `env.LOADER.abort(id)` ships, library actively aborts. |

### 13.2 ADR-1: Composed-topology ladder; loader-only is a separate factory (not a Pool topology)

**Decision.** `Parallel.pool` auto-selector picks one of `in-do` (size ≤ 4), `hybrid` (size 5..`treeThreshold`, default 128), or `tree` (size > threshold). `loader-only` is exposed via a *separate* `Parallel.loaderOnly()` factory that returns a structurally smaller `LoaderOnlyPool`. The `Pool` `Topology` type union does NOT include `'loader-only'`.

**Reasoning.**
- The composed math (the loader-cap × DO fan-out composition: N child DOs × 4 loaders each = 4N) gives strictly more parallelism than either pure topology alone.
- Loader-only's 3-cap ceiling is strictly worse than in-do's 4-cap with only ~30–80 ms cold-start tax.
- TypeScript overload-on-string-literal narrowing is unsound when the literal is computed (e.g., `const opts = { topology: someVar }` collapses to `Topology` and silently picks the wrong overload). The factory split makes type narrowing structural, not literal-dependent.

**Cost.** Two factories instead of one. Two factories with structurally distinct return types is the right answer for compile-time soundness.

### 13.3 ADR-2: JobStore default = DO storage

**Decision.** Default `Scheduler.store = 'do-storage'`. Queues / D1 / custom are opt-in adapters.

**Reasoning.** Coordinator already lives in the DO; reading the queue is a same-actor SQL call (zero RPC hop). Transactional `claim/ack` semantics are easier in SQLite than in at-least-once Queues. Ordered visibility is free in SQL.

### 13.4 ADR-3: No-bindings = loader-only opt-in only; codemod adds bindings for advanced features

**Decision.** v0.3 *adds* DO bindings to `wrangler.toml` for users who want anything beyond `topology: 'loader-only'`. Reserved `Cfp*` namespace. The auto-selector requires DO bindings; explicit `topology: 'loader-only'` does not.

**Reasoning.** Loud-fail at construction time when a topology is requested without its required bindings. Codemod handles wrangler.toml generation. Reserved namespace prevents collisions.

### 13.5 ADR-4: `WorkerEntrypoint` RPC everywhere; `fetch` only at the VM boundary

**Decision.** All inter-Worker hops use RPC. `Parallel.VM` HTTP is the only `fetch` shape.

**Reasoning.** Per-pipeline 6-concurrent-`fetch` limit doesn't apply to RPC. Smart Placement is ignored for RPC — co-location preserved. Smaller billing footprint.

### 13.6 ADR-5: `CancelToken` not `AbortSignal`; signal delivered via `env.signal`, not last positional arg

**Decision.** Library's cancellation primitive is `CancelToken`. `CancelToken.fromAbortSignal` adapts at the caller boundary. The user fn's `env` parameter receives an additional `signal: AbortSignal` field (`env: B & { signal: AbortSignal }`). User fns poll `env.signal.aborted` at await boundaries; coordinator's `Promise.race` returns the caller's promise immediately on cancel.

**Reasoning.** `AbortSignal` does not cross DO RPC. Delivering the signal as a positional argument collides with the `(...userArgs, env)` user-fn shape: a fn `(x, env) => env.AI.run(...)` would receive `(42, signal)` if the signal were appended positionally. Placing the signal inside `env` keeps user-fn arity stable across cancel-on/cancel-off invocations. There is no orphan-budget concern; cost is not a design driver. When `env.LOADER.abort(id)` ships, the library will additionally actively abort.

### 13.7 ADR-6: Stable cache keys; opt-in fresh isolate

**Decision.** Default loader id is `cfp:${codeHash}` (`cacheKeyStrategy: 'stable'`). `'auto'` (60s windows) is opt-in. `freshIsolate: true` per call forces a counter-suffixed key.

**Reasoning.** Stable keys reuse warm isolates and never multiply cache entries per fn shape across time. The earlier default `'auto'` (60s windows) proved unsafe in deployments with high fn-shape diversity: with the per-owner LRU bounded to ~50 entries, any deployment that rotates more than 50 distinct shape-windows per hour evicts hot loaders and pays repeated cold-start cost. A third-party review surfaced this as the dominant cause of unexpected p99 latency tails. `'auto'` is preserved as an opt-in for the small-set-of-shapes / want-periodic-refresh case.

### 13.8 ADR-7: `Parallel.actor` is pinned-state only; no facet backend

**Decision.** Actor's only backend is pinned-state (state in Coordinator SQLite, structured-clone-passed to user fn). Hybrid + tree topology already exceeds anything DO Facets could provide for parallelism (32 + child DOs each with its own per-isolate loader budget; not bound to one metal), so the choice incurs no parallelism cost. Facets remain on the table for v0.4 if they grow capabilities-in-props support.

**Cost.** Per-submit structured-clone hop on state, capped at 16 MiB. Recommend Workflows or sub-id partitioning for larger state.

### 13.9 ADR-8: `LoaderOnlyPool` is a structurally smaller type returned by a separate factory

**Decision.** `Parallel.loaderOnly(env, opts)` returns a `LoaderOnlyPool<B, C>` whose type does NOT have `warm`, `drain`, `stats`, `mapStream`, `mapOrdered`, `submitStream`, or `handle`. Calling any of these is a *compile-time* error, not a runtime no-op. Cancellation via `SubmitOptions.cancel` is supported (cooperative-poll inside user fn — same contract as full Pool).

**Reasoning.** A runtime silent-no-op (call a method that needs a coordinator on a loader-only pool, get nothing) is a footgun. Type narrowing at the factory boundary makes constraints explicit at construction. The removed-method list is justified by impl-impossibility (each requires a Coordinator DO to host iterator state, metrics, or a coordinator-managed HTTP route). `actor` / `scheduler` are NOT on the removed list because they are top-level `Parallel.actor` / `Parallel.scheduler` factories — they were never methods on `Pool`.

### 13.10 ADR-9: At-least-once execution + at-most-once result observability for Scheduler

**Decision.** Scheduler guarantees at-most-once *result observation* (one `JobHandle.result()` call yields one outcome) but at-least-once *execution* across SchedulerDO restarts and lease-expiry retries. User fns submitted via the scheduler MUST be idempotent.

**Reasoning.** Cloudflare Queues already operate this way. CAS predicates in DO storage ensure visible result is consistent; user code is responsible for external idempotency.

### 13.11 ADR-10: Default-deny library-internal bindings in dynamic workers

**Decision.** The library's own DO bindings (`CfpCoordinator`, `CfpWorkerDO`, `CfpSubCoord`, `CfpSchedulerDO`) are *never* forwarded to dynamic workers, regardless of what user code passes in `bindings:`.

**Reasoning.** Otherwise a user fn could re-enter the library and create infinite recursion or escalation paths.

### 13.12 ADR-11: Cancel is best-effort cooperative; no orphan budget

**Decision.** Library does NOT track or cap orphan isolates. Cancel resolves the caller's promise immediately via coordinator-side `Promise.race`. The user fn's own `CancelToken.poll()` is the cooperative cancel point inside the dynamic worker. Orphans run to `cpuMs` / wall-clock.

**Reasoning.** Cost is not a concern. Adding `orphanBudget` or any rate-limit on cancels is hedging the library doesn't need. Document the contract; ship.

### 13.13 ADR-12: Branching factor F = 8 for tree topology

**Decision.** Default `branchingFactor: 8`. Configurable 4..16.

**Reasoning.** F=8 gives K=2 up to 256, K=3 up to 2048, K=4 up to 16k. Latency vs LRU-thrash tradeoff. `ceil(log_8(N))` is human-legible.

### 13.14 ADR-13: Auto-prewarm of the Coordinator DO (default-on)

**Decision.** `Pool` defaults to `autoWarm: true` — the first `submit()` / `map()` / `scatter()` / etc. fires `Coordinator.noop()` in parallel with the real dispatch. Subsequent calls in the same Pool lifetime skip prewarm. `Pool.warm()` exposes the prewarm explicitly for callers that want to pay cold-start at construction.

**Reasoning.** Empirical validation (live-edge measurements against a deployed Worker) shows a 14×–140× per-call cold-vs-warm latency ratio: a freshly-created DO costs ~300–400 ms on first call; subsequent calls on the warm channel are ~3–30 ms. The cold cost is unavoidable, but it can be moved off the critical path. The auto-warm dispatch is fire-and-forget (deduped via a one-shot promise), so cost is zero (parallelized with the real dispatch). Subsequent calls within the same Pool reuse the warm channel without re-prewarming. The opt-out exists for benchmarks that want to measure cold-start specifically.

### 13.15 ADR-14: Selective `allowUnconfirmed` on actor checkpoint writes

**Decision.** The actor's per-submit `storage.put(state, …)` and one-time `storage.put(initial-state, …)` calls pass `{ allowUnconfirmed: true }`. Scheduler `INSERT INTO jobs` and `UPDATE … SET status='done'` do **not** (the scheduler uses SQL writes, which don't have the option, and durability is the contract anyway).

**Reasoning.** Empirical validation: 46–80 % wall-time reduction on writes at small N (32–36 ms saved). The trade-off is at-most-once durability — a write may be lost if the DO crashes before the commit lands. This is acceptable for the actor's per-submit checkpoint because:
1. The Actor contract documents per-submit checkpointing as best-effort;
2. The next submit reads the most-recent committed state, so a lost write surfaces as the prior state — exactly what a synchronous-commit crash would surface in the same order;
3. The `state` is a single-shard in-memory snapshot; there's no cross-shard consistency to violate.

It is **not** acceptable for the scheduler's durable queue (losing jobs is bad) or for ack writes (re-running a completed job is wrong) — but those use SQL, not key-value `put`, and the option doesn't apply.

The audit table lives at `tests/unit/storage-flags.test.ts` and is mechanically pinned: a future `storage.put` added to scheduler-DO without the explanatory comment fails the test.

---

## §14 — Decision log + version metadata

| Date | Decision | Owner |
|---|---|---|
| 2026-05-08 | ADR-1: Composed topology, no loader-only auto-default | architect |
| 2026-05-08 | ADR-2: JobStore default = DO storage | architect |
| 2026-05-08 | ADR-3: Codemod adds bindings for advanced features | architect |
| 2026-05-08 | ADR-4: RPC everywhere; fetch only at VM | architect |
| 2026-05-08 | ADR-5: CancelToken cooperative-poll | architect |
| 2026-05-08 | ADR-6: Stable cache keys, opt-in fresh isolate | architect |
| 2026-05-08 | ADR-7: Actor pinned-state only; no facet backend | architect |
| 2026-05-08 | ADR-8: Type-narrowed `LoaderOnlyPool` | architect |
| 2026-05-08 | ADR-9: At-least-once + at-most-once result for Scheduler | architect |
| 2026-05-08 | ADR-10: Default-deny library-internal bindings | architect |
| 2026-05-08 | ADR-11: Cancel best-effort cooperative; no orphan budget | architect |
| 2026-05-08 | ADR-12: Branching factor F=8 for tree topology (range 4..16) | architect |
| 2026-05-09 | ADR-1 revised: loader-only is a separate factory, not a topology overload | architect |
| 2026-05-09 | ADR-5 revised: cancel signal in `env.signal`, not last positional | architect |
| 2026-05-09 | ADR-13: `AggregateExecutionError` carries `partialResults` | architect |
| 2026-05-09 | ADR-14: `BackpressureError` is retry-eligible | architect |

