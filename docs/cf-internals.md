# Cloudflare Workers internals

> Reference notes for contributors. Combines public Cloudflare docs, public
> `workerd` source citations, and empirical caps measured against running
> Workers infrastructure (the `cf-mp-vm` substrate test worker).
>
> Reproducible numbers used by the topology selector are explicit; cross-refs to
> Cloudflare-internal sources have been redacted from this public copy.

---

## §0 — TL;DR mental model (the load-bearing equations)

Three numbers, composed:

```
   per-V8-isolate concurrent-loader cap
       = 3 from a Worker fetch handler (the loader-from-fetch test)
       = 4 from a DO method            (the DO+loader test)

   per-coordinator DO RPC fan-out cap
       ≈ 32 child-DO calls in flight (validated the substrate test at N=32, 319 ms wall)
       (DO RPC fan-out is NOT loader-capped — see §3)

   per-process per-owner loader LRU
       = 50 (config.capnp:692, validated to the digit )

   ⇒ ABSOLUTE MAX PARALLELISM at one coordinator-DO request:
        4N  parallel V8 isolates,  where N = ceil(size / 4),
        N ≤ 32 ⇒ supports size ≤ 128 in one coordinator level.

   ⇒ Tree-scale further: K-tier hierarchy gives 32^K leaf DOs at the bottom,
     each running 4 loaders ⇒ 4 × 32^K parallel isolates.
     (Limited by 50/owner LRU thrash, not concurrent-execution cap.)
```

Six load-bearing invariants the design rests on:

1. **Loader-cap is per V8 isolate, per request turn** — not per process, not per Worker, not per binding. Adding a fresh V8 isolate (= a child DO) adds a fresh budget. (validated empirically.)
2. **DO RPC fan-out from a parent (Worker → DO, or DO → DO) is NOT loader-capped.** Only direct `env.LOADER.get()` calls fall under the 3/4 cap. This is the keystone insight that makes hierarchical scaling work.
3. **N DOs × 4 loaders compose** — initial benchmarks were taken at "1 loader per DO" but the topology ceiling is 4 per DO. Compose them: N DOs × 4 loaders each = 4N parallel isolates. (Flows from invariant #1.)
4. **50/owner LRU is a cache-eviction threshold, not a concurrent-execution cap.** Going wider than 50 thrashes the warm-code cache (cold-start tax on evicted entries) but is correctness-safe.  confirmed cap is exactly 50.
5. **Stub forwarding lifetime ≤ introducer's request.** Long-lived state must live in a DO; you cannot cache forwarded RPC stubs across requests. (Public docs.)
6. **`abortIsolate` does NOT abort outstanding RPCs in workerd today** (`server.c++:3557-3574` TODO). Eviction-mid-flight is real; in-flight calls survive eviction-from-cache via refcount pin (`SubrequestChannelImpl`); a hard abort produces opaque disconnection.

Everything else in this document is supporting detail for these six.

---

## §1 — Worker Loader / Dynamic Workers

### 1.1 The single-most-important invariant: per-V8-isolate concurrent-loader cap

**This is not in any public Cloudflare doc.** It is the binding
constraint on the topology selector and was discovered empirically by
running 3/4/5 concurrent loader calls against a deployed test Worker
and observing the cap.

| Calling site | Concurrent-loader cap | Source |
|---|---:|---|
| Worker fetch handler | **3** | the loader-from-fetch test: `n=4` returns `Too many concurrent dynamic workers` |
| DO method | **4** | the DO+loader test: `n=4` succeeds, `n=5` fails |
| Verbatim error | `Too many concurrent dynamic workers. at async Promise.all (index 4)` |  |

The 1-difference between fetch-handler (3) and DO method (4) is consistent with one slot being reserved for the calling Worker handler in the no-DO case.

**Critical: this cap is per V8 isolate per request turn.** Adding more isolates (= more DOs) adds more budget. It is not per-process, not per-binding, not per Worker script.

Cloudflare-internal documentation confirms the existence of a
"per-request concurrent dynamic worker limit … handled at the parent
worker level." That source does not state the value; the 3/4 numbers
are empirical. Public `workerd` source has no such cap; the limit
is enforced in the proprietary edgeworker layer.

### 1.2 RPC fan-out is NOT loader-capped (the keystone)

The cap above applies only to direct `env.LOADER.get(...)` calls. Calling another DO via RPC — `env.WORKER_DO.idFromName(...).fetch(...)` or `stub.someMethod(...)` — does NOT consume a loader-slot budget. The budget is exclusively for *creating new dynamic-worker isolates from the calling isolate*.

This means a parent DO can fan out RPCs to ≥32 child DOs (the DO-RPC fan-out test validated 32 in 319 ms wall, fully parallel) **with each child DO independently spawning up to 4 loader isolates of its own**. That gives 4 × 32 = 128 concurrent loader isolates at one coordinator level — and there's no per-coordinator-isolate budget thrash because the fan-out itself isn't going through `LOADER.get`.

> Empirical proof (the substrate test at N=32, parallel-diff): 32 unique DO instances, 32 unique loader isolates, 319 ms wall. If RPC fan-out shared the loader budget, this would have hit the 4-cap and serialized.

### 1.3 50/owner LRU — cache eviction, not concurrency

`dynamicWorkersPerOwnerLimit = 50` lives in the proprietary edgeworker
config schema. The empirical substrate test (`cf-mp-vm /a/lru-probe?n=60`)
confirms the cap is exactly 50: the first 5 isolates allocated are
evicted by the time we re-query them after spinning up 60 distinct
codeKeys.

**Distinction.** The 50 is a *per-process per-owner cache size for warm loader isolates*. When the 51st distinct loader id is requested, the LRU evicts the oldest. The evicted isolate's next access pays a cold-start; it does not error.

This is **NOT** a concurrent-execution cap. the DO-RPC fan-out test already validated 32 simultaneous distinct loader-isolates (well below 50, well above the per-isolate 4-cap) succeeding fully parallel. Going past 50 thrashes the warm-cache hit rate but is correctness-safe.

### 1.4 Eviction-mid-flight semantics

| Event | Behavior | Source |
|---|---|---|
| Soft LRU eviction with no in-flight | Next access cold-starts | `worker-loader.c++:87-91` doc-comment |
| Soft LRU eviction with in-flight | `SubrequestChannelImpl` refcount-pins `WorkerService` for request lifetime; in-flight call completes normally | `workerd:server.c++:4417-4441` |
| Hard `abortIsolate` (Python fatal / OOM / explicit) | RPC throws opaque disconnection — workerd has open TODO at `server.c++:3557-3574` *"Should abort all outstanding calls causing them to throw the reason as the error"* | workerd source |

Library response: classify opaque disconnection as `DisconnectedError`; one auto-retry on a fresh isolate.

### 1.5 WorkerCode shape (verified)

`compatibilityDate` (required), `compatibilityFlags?: string[]`, `allowExperimental?: boolean`, `mainModule` (required), `modules: Record<string, string | Module>`, `globalOutbound?: ServiceStub | null`, `env?: object`, `tails?: ServiceStub[]`, `limits?: { cpuMs, subRequests }`. All HIGH confidence — https://developers.cloudflare.com/dynamic-workers/api-reference/.

`env` is rewritten on entry: RPC stubs become server-level capabilities in the new isolate (workerd `server.c++:4298-4323`). This is the canonical channel for capability passing into a loaded Worker.

### 1.6 `globalOutbound`

| Value | Effect |
|---|---|
| absent / `undefined` | inherit parent's network access |
| `null` | both `fetch()` and `connect()` throw |
| ServiceStub | every `fetch()` and `connect()` is routed through it |

Library default = `null` (sandboxed). Doc-silent on `caches.default` interaction; library defensively seals `caches.default` when `globalOutbound: null`.

### 1.7 Cache-key strategy

Worker Loader caches by `(loaderBindingId, id)`. Same-id same-code is reused. Different ids always get fresh isolates. Pricing meter: per `(workerId, codeHash)` per day.

The library uses **stable** keys: `cfp:<codeHash>` for repeated calls with the same fn shape. the HTTP submit-code test demonstrated this pattern works: `codeKey = sha256(code).slice(0,16)`.

---

## §2 — Durable Objects

### 2.1 Lifecycle, hibernation, isolate boundary

Five states (Active in-memory / Idle non-hibernateable / Idle hibernateable / Hibernated / Inactive). 10s idle hibernation timer when no in-flight requests / no `setTimeout` / no standard WebSocket. Sources: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/.

Each DO instance is a single-threaded V8 isolate routable by id, globally unique. The isolate has its own ~128 MiB heap budget (Workers Limits wiki, soft).

### 2.2 SQLite storage

`ctx.storage.sql.exec(...)` synchronous; `ctx.storage.transaction(closure)` for explicit. *"Any series of write operations with no intervening `await` will automatically be submitted atomically."* Per-object cap 10 GB. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/.

`blockConcurrencyWhile()` ceiling of ~200 req/s if used per-request — reserve for init/migration.

### 2.3 Input/output gates

Input gate blocks new events while sync JS runs; awaiting async opens it. Output gate holds outgoing messages until pending storage writes complete.

### 2.4 RPC cost & capability passing

- *"Each RPC session is billed as one request to your Durable Object"*; nested calls on stubs returned from an RPC method are part of the same session and not separately billed. https://developers.cloudflare.com/durable-objects/platform/pricing/.
- Capabilities passable through RPC: functions, `RpcTarget` subclasses, `ReadableStream`/`WritableStream`, `Request`/`Response`, RPC stubs themselves.
- `ctx.exports.X({props})` is the canonical loopback for per-tenant capability scoping.
- **Stub forwarding lifetime ≤ introducer's execution context.** *"This proxying only lasts until the end of the Workers' execution contexts. A proxy connection cannot be persisted for later use."* https://developers.cloudflare.com/workers/runtime-apis/rpc/.
- Max RPC payload 32 MiB; use `ReadableStream` for larger.

---

## §3 — The composed-topology math

This section pins the v0.3 mental model.

### 3.1 Single-DO ceiling

the DO+loader test: a coordinator DO can host up to 4 concurrent loader isolates inside a single method call. 4× parallel CPU; 4 separate ~128 MiB heaps; same-host placement.

```
Coordinator DO method
   ├─ env.LOADER.get('cfp:hashA') ─▶ isolate A
   ├─ env.LOADER.get('cfp:hashB') ─▶ isolate B
   ├─ env.LOADER.get('cfp:hashC') ─▶ isolate C
   └─ env.LOADER.get('cfp:hashD') ─▶ isolate D       (cap = 4)
```

### 3.2 Hybrid pool ceiling — the v0.3 default

The v0.2 plan modeled `size > 4` as "N DOs × 1 loader each" (the DO-RPC fan-out test as measured). The actual ceiling is **N DOs × 4 loaders each**:

```
Coordinator DO
   ├─ stub.run() ─▶ Worker DO #1                ─┐
   │                  ├─ LOADER.get('A1') ─▶ isolate A1   ┐
   │                  ├─ LOADER.get('A2') ─▶ isolate A2   │  4 isolates
   │                  ├─ LOADER.get('A3') ─▶ isolate A3   │  per child DO
   │                  └─ LOADER.get('A4') ─▶ isolate A4   ┘  (cap = 4 per DO method)
   ├─ stub.run() ─▶ Worker DO #2 (same shape)
   ├─ stub.run() ─▶ Worker DO #3 (same shape)
   ⋮                                                       ┘  RPC fan-out cap ≈ 32
   └─ stub.run() ─▶ Worker DO #N (same shape, N ≤ 32)         (NOT loader-capped)
```

Math:
- Each child DO method has its own per-isolate loader budget (4).
- Coordinator → child-DO fan-out is RPC, not `LOADER.get`, so it's NOT loader-capped.
- Ceiling per coordinator request: **N × 4 = 4N parallel V8 isolates**, where N is the child-DO count.
- N is bounded by the per-coordinator DO RPC fan-out cap (~32 per public docs / dossier I2; the DO-RPC fan-out test validated N=32 fully parallel).
- ⇒ **128 parallel isolates at one coordinator level for size ≤ 128**.

### 3.3 Hierarchical tree scaling — beyond a single coordinator

For sizes beyond ~64 (where a single coordinator's 32-way fan-out + 4-loader leaf becomes either contended or LRU-thrashy at 50/owner cache size), use a multi-tier tree:

```
Worker fetch handler
   └─ root coordinator DO
        ├─ tier-1 sub-coord DO #1 ─▶ leaf DOs (each 4 loaders)
        ├─ tier-1 sub-coord DO #2 ─▶ leaf DOs
        ⋮
        └─ tier-1 sub-coord DO #B
```

Math:
- Each tier has its own RPC fan-out cap (~32) and its own per-isolate loader budget.
- For branching factor F (default F=8 to balance latency vs LRU thrash) and K tiers:
  - Number of leaf DOs = F^K.
  - Parallel isolates = 4 × F^K.
- Tiers needed for target size: `tiers = ceil(log_F(size / 4))`.
  - size=128: F^K ≥ 32 ⇒ K=2 with F=8.
  - size=1024: F^K ≥ 256 ⇒ K=3 with F=8 (can do ≥512).
  - size=8192: F^K ≥ 2048 ⇒ K=4 with F=8.

Each tier consumes one DO RPC hop (~3 ms warm, ~30–80 ms cold). Total request latency ≈ K × hop + leaf execution time.

### 3.4 What stops the tree

The 50/owner LRU. At any point, the warm-cache hit rate matters more than concurrent-execution cap. Empirically (, confirmed via capnp config) the cap is exactly 50 distinct loader ids per process per owner. Beyond that, eviction trashing dominates.

Practical implication: at very large fan-outs (>~5000 leaves), each leaf DO sees ~size/(5000) unique fn shapes, and the LRU thrash hit ratio determines aggregate throughput. The library does not cap aggregate fan-out (cost is not a design driver), but documents the LRU thrash inflection so users can choose to reduce fn-shape diversity if their workload spans more than ~50 distinct fn hashes per leaf process.

### 3.5 Why `topology: 'loader-only'` is not a default

The 3-from-fetch-handler cap means it can never exceed 3 isolates. The auto-selector picks `in-do` (single coordinator DO, 4 loaders) at size ≤ 4 — strictly more parallel than loader-only and only 30–80 ms colder on cold-edge. `loader-only` is preserved as an explicit opt-in for users who specifically want zero DO ops; the auto-selector never picks it.

---

## §4 — RPC / WorkerEntrypoint / ctx.exports

### 4.1 WorkerEntrypoint

`class extends WorkerEntrypoint` from `cloudflare:workers`. Public methods callable across isolates via service binding or `ctx.exports`. Smart Placement is *ignored* for inter-Worker RPC — co-location preserved. https://developers.cloudflare.com/workers/runtime-apis/rpc/.

### 4.2 ctx.exports

*"Automatically-configured loopback bindings for all of your top-level exports."* `ctx.exports.X({ props: { … } })` lets the caller specify `ctx.props` delivered to the callee. Requires `enable_ctx_exports` compatibility flag (default since 2025-09-26). https://developers.cloudflare.com/workers/runtime-apis/context/.

The library uses `ctx.exports` to give a loaded Worker a stub back to its parent coordinator (per POC pattern), enabling cooperative cancel signaling without re-deploying anything.

### 4.3 Stub lifetime

Auto-disposed at end-of-execution-context. `stub.dup()` survives independent disposal. Forwarded/proxied stubs cannot persist beyond introducer's request. With the `rpc_params_dup_stubs` compat flag (default since 2026-01-20), stubs in RPC params are duplicated rather than ownership-transferred — fixes the Cap'n Web compatibility footgun.

### 4.4 Cancellation

*"AbortSignal objects cannot cross Durable Object RPC boundaries."* https://developers.cloudflare.com/agents/api-reference/chat-agents/. The library defines its own `CancelToken` and adapts `AbortSignal` at the caller boundary. Cooperative cancel: the token (a structured-cloneable shape with a poll method) is passed into the loader closure; user fn checks it. When `env.LOADER.abort(id)` ships in workerd, the library will additionally actively abort. Until then, orphan isolates run to `cpuMs`/wall-clock.

---

## §5 — Failure modes (consolidated)

| Mode | Source | Library response |
|---|---|---|
| `abortIsolate` does NOT cancel in-flight RPCs (workerd TODO) | `server.c++:3557-3574` | Classify opaque disconnection as `DisconnectedError`; one auto-retry on a fresh isolate. |
| Eviction-mid-flight (LRU rolls): in-flight calls survive | `server.c++:4417-4441` | No retry needed; transparent. |
| `cpuMs` plumbed but unenforced in workerd | `io-channels.h:316`, `server.c++:4263` | Set anyway — production enforces. Coordinator runs cold-start probe to learn the production error shape. |
| 50/owner LRU thrash | empirical | Cold-start tax on evicted entries; no error. |
| Per-V8-isolate concurrent-loader cap (3/4) | empirical | Topology selector ensures direct `LOADER.get` calls within any one isolate stay ≤ 3 (Worker) or ≤ 4 (DO). |
| User fn throws | RPC marshals | `ExecutionError`; per-call `retries` policy applies. |
| User fn timeout | wall-clock race in `execute` | `TimeoutError`; `retries` policy applies. |
| Cancel: cooperative poll fails (tight loop) | `CancelToken` not polled | Coordinator's `Promise.race` resolves caller with `CancelledError`; isolate runs to `cpuMs`. Documented contract. |
| Stub forwarding lifetime ≤ introducer's request | public docs | Long-lived `Actor` is a DO; pool members never cache forwarded stubs across requests. |
| 6 simultaneous open connections per pipeline (`fetch`) | EW Workers Limits wiki | `BINDING.fetch`/RPC does NOT count. Library uses RPC for inter-coordinator hops. |
| 50/1000 subrequest limit per Worker | EW Workers Limits | Each loader RPC and DO RPC counts. Multi-tier tree: each tier is `~32` subrequests. Tiers ≤ 3 fits within Unbound 1000 cap with margin. |
| 128 MB per-Worker soft memory | EW Workers Limits | Document for user-fn authors; stream large results. |
| RPC max payload 32 MiB | public docs | Library validates returns; >16 MiB auto-converts to streams; >32 MiB raises `ReturnTooLargeError`. |
| Single-DO fan-out file-descriptor pressure (internal incident report) | n/a (Cloudflare-internal) | Multi-tier tree past size 64 distributes FD pressure across tier-1 sub-coords. |

---

## §6 — Workflows / Queues / Containers (sanity)

### 6.1 Workflows

`step.do(name, [config], callback)` durable; resumes from last successful step. Default `retries: { limit: 5, delay: 10000ms, backoff: 'exponential' }`, `timeout: '10 minutes'`. https://developers.cloudflare.com/workflows/build/. Workflows is a **user-side wrapper** around our pool, not a backend we own. Document the integration; no library coupling.

### 6.2 Queues

Per-queue throughput 5,000 msg/s; backlog 25 GB; auto-scaling consumers up to 250. At-least-once; idempotency keys recommended. https://developers.cloudflare.com/queues/. Library exposes Queues as an opt-in `JobStore` adapter for `Scheduler` only; default is DO-storage.

### 6.3 Containers (sanity)

Container DO + Linux VM. Cold start 1–3s. Container may not co-locate with parent DO. Cloudflare's positioning: *"Dynamic Workers can be used as a lightweight alternative to containers for securely sandboxing code you don't trust."* Out of scope for v0.3.

---

## §7 — Observability surfaces

- **Tail Workers** receive `tail` events from a producer Worker after invocation; sub-request events from Service Bindings and Dynamic Dispatch are included. https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/.
- **Tails for Dynamic Workers** must be wired explicitly via `tails: [...]` in `WorkerCode`; one event per dynamic-worker invocation.
- **Workers Trace Events Logpush** for raw logs by Outcome / Script Name.
- **Analytics Engine** for SQL-queryable, high-cardinality, time-series; non-blocking writes.

Library auto-attaches Tail Worker per dynamic isolate when `observability.tail.binding` is set; default sampling 0.1 to keep tail-event counts proportional.

---

## §8 — Cross-cutting invariants table

The library MUST respect all of these. Source per row.

| # | Invariant | Source | Implication |
|---|---|---|---|
| I1 | 50 isolates / owner / process LRU | `config.capnp:692` (verbatim) | Cache-eviction threshold; not a concurrency cap. |
| I2 | ~32 RPC fan-out per request | dossier-prim §1; the DO-RPC fan-out test validated 32 | Single-coordinator ceiling; multi-tier tree past it. |
| I3 | Stub forwarding lifetime ≤ introducer's request | RPC docs | Coordinator must be a DO if jobs span requests. |
| I4 | **Per-V8-isolate concurrent-loader cap = 3/4** |  (NEW; not in any doc) | Topology selector caps direct `LOADER.get` calls per isolate; multiple isolates compose. |
| I5 | **DO RPC fan-out is NOT loader-capped** | empirical caps + 32-way fan-out validation | Hybrid topology + tree topology can multiply 4-cap by RPC fan-out without saturating any single isolate. |
| I6 | Loader env capabilities are rewritten on entry | `server.c++:4298-4323` | Coordinator passes a stub back to itself into the loaded Worker — basis for cooperative cancel + Actor capability. |
| I7 | `DurableObjectClass` is RPC-serialisable | `actor.h:382` | One Worker can load a class and another use it. |
| I8 | Compat flags inherit DOWN; `experimental` requires parent experimental | `worker-loader.c++:267-295` | Library default compat date 2026-01-20 to pick up `enable_ctx_exports` + `rpc_params_dup_stubs`. |
| I9 | Per-day per-(workerId, codeHash) Dynamic Worker billing | Pricing PRD | Library uses stable cache keys. Cost is documented but not a design driver. |
| I10 | `AbortSignal` does not cross DO RPC | docs | Library defines `CancelToken`; `fromAbortSignal` adapter at caller. |
| I11 | Per-pipeline 6 simultaneous open `fetch` connections (NOT `BINDING.fetch`) | EW Workers Limits | Library uses RPC for inter-coordinator hops. |
| I12 | Per-Worker 50 (Bundled) / 1000 (Unbound) subrequest limits | EW Workers Limits | Each tier of the tree is its own Worker invocation with its own budget; no aggregate cross-tier cap. |
| I13 | 128 MB per-Worker soft memory; 32 MiB max RPC payload | EW Workers Limits + RPC docs | Library validates returns; auto-streams when needed. |
| I14 | `abortIsolate` does NOT cancel in-flight RPCs (TODO) | `workerd:server.c++:3557` | `DisconnectedError`; one retry. |
| I15 | STOR-5202 active production FD pressure on single-DO fan-out | Jira | Multi-tier tree past size 128. |
| I16 | Worker Loader = Open Beta; Paid only | changelog | wrangler scaffolding paid-tier only. |

---

## §9 — DO Facets — why v0.3 does NOT use them (1-paragraph footnote)

Facets share parent placement (Khanna verbatim: *"Facets need to run on the same metal as the parent DO as they share the same underlying storage"*); the runtime caps facet trees at `MAX_FACET_TREE_DEPTH = 4` (workerd `actor-state.c++:942`); capabilities-in-props is **not** supported (`workerd:pipeline.c++:1838` `JSG_FAIL_REQUIRE` *"Facet classes do not yet support ctx.props containing capabilities"*); cross-facet output gate ordering is weaker than within a facet (`worker-set.c++:2142` TODO); and there is an active CVE-class issue VULN-131748 in the facet `ctx.exports` startup path (Jira). Because a non-facet topology already gives strictly more parallelism (RPC fan-out ≥ 32 child DOs each with its own 4-loader budget; not bound to one metal) and avoids every constraint above, v0.3 does not use facets at all. Reconsider in v0.4 once VULN-131748 closes and capabilities-in-props lands — at that point a hybrid same-host facet pool may give a latency win for stateful size-≤-50 workloads, but it will not add parallelism.

---

## §10 — Verdicts on the load-bearing unknowns from the prior design

| # | Question | Verdict | Source |
|---|---|---|---|
| 1 | Does the per-V8-isolate concurrent-loader cap multiply across child DOs? | **YES.** Each DO is its own V8 isolate with its own 4-loader budget. (the DO-RPC fan-out test validated 32 child DOs each running 1 loader concurrently; hybrid topology extends to 4 each.) | empirical |
| 2 | Is RPC fan-out (DO → DO) loader-capped? | **NO.** Only direct `env.LOADER.get` calls fall under the 3/4 cap. RPC fan-out is bounded only by the ~32-per-request fan-out cap. | empirical + invariant I2 |
| 3 | Is the 50/owner LRU a concurrency cap? | **NO.** It's a cache-eviction threshold. Going past it cold-starts evictees but doesn't error. POC validated 32 simultaneous distinct isolates well below 50. |  |
| 4 | Eviction-mid-flight | Soft (LRU): refcount pin keeps `WorkerService` alive; in-flight calls complete. Hard (`abortIsolate`): opaque disconnection (workerd TODO). Library: `DisconnectedError`, one retry. | workerd source |
| 5 | Capability passing into loaded Workers | `env` is rewritten at load time; coordinator can pass arbitrary stubs in (including `ctx.exports.Coordinator` for self-reference, the basis of Actor and cooperative cancel). | workerd `server.c++:4298-4323` |

---

## §11 — Citations

Public sources only. Cloudflare-internal sources (wiki / Jira / Drive)
are referenced in the proprietary edgeworker config and incident
reports; the empirical caps used by the topology selector come from
direct measurement against deployed Workers.

### `workerd` source

- `src/workerd/server/server.c++:3557-3574` — `abortIsolate` TODO
- `src/workerd/server/server.c++:4298-4323` — `env` capability rewrite at load time
- `src/workerd/server/server.c++:4417-4441` — `SubrequestChannelImpl` refcount pin (eviction-mid-flight)
- `src/workerd/api/actor-state.c++:942-952` — `MAX_FACET_TREE_DEPTH = 4`
- `src/workerd/api/worker-loader.c++:87-91` — eviction-while-stub-exists doc-comment

### Empirical caps

Reproducible against the substrate test worker at
`cf-mp-vm.ashishkumarsingh.com`:

- `/a/benchmark?n=8&iters=1000&mode=parallel-diff` — fails with
  `Too many concurrent dynamic workers` (Worker fetch handler cap = 3).
- `/b/benchmark?n=4&iters=10000&mode=parallel-diff` — succeeds with
  `uniqueIsolates=4` (DO method cap = 4).
- `/a/lru-probe?n=60&iters=10` — `evictedFirst5=5` (50/owner LRU).
