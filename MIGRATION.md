# Migrating from cloudflare-parallel 0.2 → 0.3

> Read alongside `DESIGN.md` (full architecture) and `docs/cf-internals.md` (the empirical / runtime facts the design rests on).
>
> 0.3 is a **pre-1.0 minor bump with API breaks**. SemVer allows it. We tried to keep the v0.2 ergonomic and provide an automatic codemod plus a compat-shim package so 50-Worker fleets can upgrade in stages.

## TL;DR by user shape

| Your v0.2 usage | What you do |
|---|---|
| `pool.submit(fn, x)` / `pool.map(fn, items)` only, ≤ 3 concurrent isolates per request | Run codemod. **You have two paths**: (a) call `Parallel.loaderOnly(env, opts)` and keep zero-DO ops (no `wrangler.toml` change); (b) call `Parallel.pool(env, opts)` for the full surface (adds one `CfpCoordinator` DO binding). Path (b) gets you 4 concurrent isolates from a DO method instead of 3 from a fetch handler. |
| Anything > 3 concurrent isolates per request | Run codemod. Add the `Cfp*` DO bindings to `wrangler.toml` (codemod prints the snippet). The auto-selector picks `in-do` (size ≤ 4), `hybrid` (5..128, **N DOs × 4 loaders each**, max 128 parallel isolates per coordinator request), or `tree` (>128, hierarchical multi-coord). All correct under load — v0.2 silently dropped tasks above ~3 concurrent. |
| You want the new primitives (`Actor`, `Scheduler`, `VM`) | Run codemod. Add DO bindings. Read §5 below. |
| You manage 50 deployed Workers and can't migrate them in lockstep | Use `cloudflare-parallel-compat@0.2` as a transitional dependency (see §7). Lets you upgrade dependency-first, source-second. |

The fastest path: `npx cloudflare-parallel migrate` then `npx cloudflare-parallel doctor`.

---

## §1 — What changed and why

| Topic | v0.2 | v0.3 | Why |
|---|---|---|---|
| Constructor signature | `Parallel.pool(env.LOADER, opts)` | `Parallel.pool(env, opts)` *or* `Parallel.loaderOnly(env, opts)` | Two factories so the type system can statically distinguish "full pool with DO coordinator" from "loader-only, zero-DO" without overloads-on-literal-strings. Codemod handles. |
| Scaling above N=3 | Silent failure / dropped tasks above the per-V8-isolate concurrent-loader cap (3 from fetch handler / 4 from DO method). | Topology selector picks `in-do` (≤4), `hybrid` (5..128, **N DOs × 4 loaders each**, up to 128 parallel isolates per request), or `tree` (>128, hierarchical multi-coord). Flat scaling. | The 3-from-fetch-handler / 4-from-DO cap on Worker Loader is real and undocumented. v0.2 silently lost work; v0.3 is correct. The new hybrid topology is . RPC fan-out from a parent DO is NOT loader-capped, so you compose `N×4` parallel isolates. |
| Loader id (cache key) | `cfp:<fnHash>:<counter>` (counter forces fresh isolate every submission) | `cfp:<fnHash>` (stable; same isolate reused) by default; `cacheKeyStrategy: 'auto'` adds 60s windows | Stable keys reuse warm isolates. **Behavioral change** — read §3.1. |
| Cancellation | Not supported. | `SubmitOptions.cancel: CancelToken`; signal delivered as `env.signal` inside the user fn. Best-effort cooperative — orphans run to `cpuMs`. | `AbortSignal` does not cross DO RPC; required a custom primitive.  |
| Stateful actors | Not supported. | `Parallel.actor<State>(env, opts)`. Pinned-state only (no facet backend). 16 MiB cap on state. | New in v0.3. Facets dropped entirely (docs/cf-internals.md). |
| Job scheduler | Not supported. | `Parallel.scheduler(env, opts)`. | New in v0.3. |
| HTTP submit-code | Not supported. | `Parallel.VM` + `pool.handle()`. | New in v0.3 (HTTP submit-code pattern). |
| Error hierarchy | 5 types. | 5 + 12 new; all new types extend a v0.2 ancestor so existing `instanceof` keeps working. `AggregateExecutionError` carries `partialResults`. | Backwards compat for catchers. |
| Default `compatibilityDate` | `2025-06-01` | `2026-01-20` | Picks up `enable_ctx_exports` and `rpc_params_dup_stubs` defaults. Override with `workerOptions.compatibilityDate` if needed. |
| Default sandboxing | `globalOutbound: null` | unchanged | Plus library-internal DOs are blocklisted from `bindings` passthrough. |
| Streaming returns | `mapStream` / `mapOrdered` for fan-out | + `pool.submitStream<T>(fn) → ReadableStream<T>` for single-task streaming | Common pattern (LLM streams, log tails, large datasets). |

**What's NOT in v0.3 :**

- No DO Facet topology. No `useFacets` flag. (Why: facets share parent placement, depth-cap=4, no capabilities-in-props, active VULN-131748 — see docs/cf-internals.md. Hybrid + tree topology already exceeds anything facets could give for parallelism.)
- No `orphanBudget` or cancel rate-limiting. Cancel is best-effort cooperative; orphans run to `cpuMs`. Cost is not a design concern.
- No Actor backend choice. Pinned-state is the only Actor backend.

---

## §2 — Codemod: `npx cloudflare-parallel migrate`

### What the codemod does

1. Rewrites `Parallel.pool(env.LOADER, opts)` → `Parallel.pool(env, opts)` (full pool with DO coordinator) **or** `Parallel.loaderOnly(env, opts)` (zero-DO opt-in). Default is `Parallel.pool` unless your call site only ever uses `submit`/`map` of fixed size ≤ 3 *and* you pass `--prefer-loader-only`.
2. Identifies whether you need DO bindings (any `pool.map(fn, items)` where `items.length` is dynamic, or any use of cancellation, Actor, Scheduler, VM). If yes, prints the wrangler.toml snippet.
3. Updates imports (no path changes in 0.3 itself, but it normalizes them).
4. **Preview by default.** Runs in dry-run mode and prints the diff to stdout. Use `--apply` to write.
5. Refuses if it can't unambiguously parse a call site; emits a TODO comment for manual review.

### What it doesn't do

- It does NOT modify your `wrangler.toml` — it only prints what to add. We do not silently edit infrastructure config across multiple Workers.
- It does NOT pin a fresh `compatibilityDate`. If you depend on older flags, your existing `wrangler.toml` keeps them; v0.3's library-internal default is independent.
- It does NOT migrate your error-handling code. Existing `instanceof` checks continue to work because the new error types extend v0.2 ancestors.

### Run it

```bash
npx cloudflare-parallel migrate                    # preview
npx cloudflare-parallel migrate --apply            # write
npx cloudflare-parallel doctor                     # validate wrangler.toml ↔ source-code shape
```

`doctor` is the stronger of the two — run it before deploys. It catches:
- "you call `Parallel.scheduler` but no `CfpSchedulerDO` binding is configured"
- "you set `topology: 'hybrid'` but no `CfpCoordinator` binding"
- "your `compatibilityDate` is older than `2025-09-26` but you call `ctx.exports`"
- "your wrangler.toml has a DO named `Coordinator` colliding with the library's `CfpCoordinator`"
- "you call `Parallel.loaderOnly` but pass options (e.g., `topology`) that aren't valid on the loader-only factory"

---

## §3 — Behavioral changes that don't show up in your diff

These are the silent-behavior items the codemod can't catch. Read carefully.

### 3.1 Stable cache keys ⇒ shared heap across submissions

v0.2: each `pool.submit(fn, x)` got a fresh isolate. A user fn doing `let cache = new Map()` at module scope was reset every call.

v0.3: same `fn` shape reuses the same isolate. The `cache` Map persists between calls. Two consequences:
- If your fn used module-scope state for *correctness* (assuming each call had a fresh heap), it now leaks state.
- If your fn used module-scope state for *performance* (memoization), it now memoizes — desirable.

What to do:
- For per-call isolation, opt in: `pool.submit(fn, x, { freshIsolate: true })` or `pool.opts.cacheKeyStrategy: 'fresh'`.
- For 60s-window isolation (good middle ground): `cacheKeyStrategy: 'auto'` (current default). Caveat: workloads with >50 fn-shape-windows/hour will thrash the 50/owner LRU; consider `'stable'` for those.

### 3.2 Coordinator-DO routing ⇒ cold-start latency for first call

v0.2: `pool.submit(fn, x)` made one Worker Loader RPC. Tail latency ≤ ~10ms warm, ≤ ~80ms cold (loader-only).

v0.3 with topology = `in-do` / `hybrid` / `tree`: adds a Coordinator DO hop (~30–80ms additional cold-start; ~3–10ms warm). `Parallel.loaderOnly()` preserves v0.2 latency exactly (and caps at size=3).

What to do:
- If your call sites only need ≤ 3 concurrent isolates, choose `Parallel.loaderOnly(env, opts)` to avoid the DO hop entirely. (Caveat: structurally smaller surface — no `warm`/`drain`/`stats`/streaming/handle methods.)
- For larger fan-out, accept the cold-start tax once per cold edge instance per pool, or call `pool.warm({ isolates: 4 })` at the start of your `fetch` handler to amortize.

### 3.3 Cancel is delivered via `env.signal`, not as a positional arg

v0.2: no cancellation.

v0.3: when `SubmitOptions.cancel` is set, the user fn's `env` parameter has an additional `signal: AbortSignal` field. Inside the fn, poll via `env.signal.aborted`. v0.2 fn signatures `(x, env) => env.AI.run(...)` keep working unchanged because `signal` is *inside* `env`, not a separate positional argument.

```ts
await pool.submit(async (data, env) => {
  for (const chunk of data.chunks) {
    if (env.signal.aborted) return null;   // cooperative cancel point
    await processChunk(chunk);
  }
}, payload, { cancel: token });
```

When you don't pass `cancel`, `env.signal` is still present but always-non-cancelled.

### 3.4 Cancel is not free (and the library does not pretend otherwise)

v0.3 cancellation immediately resolves the caller's promise with `CancelledError`. The dynamic isolate may keep running until `cpuMs`/wall-clock kills it (typically 30s by default). You pay for that CPU time.

The library does NOT cap or rate-limit this . When `env.LOADER.abort(id)` ships in workerd, the library will additionally actively abort.

`PoolStats.cancelled` counts user-visible cancels. Orphan-isolate count is not surfaced as a separate concern.

### 3.5 Deadlines: relative or absolute, but never both

v0.2: `timeout` was the only knob (relative ms).

v0.3: you can set `timeout` (still relative wall-clock), or `deadlineMs` (relative-from-submission, library converts to absolute internally), or `deadline` (absolute ms-since-epoch). **You cannot set both `deadlineMs` and `deadline`** — the library throws `SerializationError` at submit time if you do. `timeout` is independent and additive.

### 3.6 Errors: extended hierarchy, backwards compatible, plus `partialResults`

v0.2 `instanceof` checks keep working. New errors *also* match their v0.2 ancestor:
- `DisconnectedError extends ExecutionError` (eviction-mid-flight, abortIsolate)
- `OutOfMemoryError extends ExecutionError` (V8 OOM)
- `BillingLimitError extends ExecutionError` (cpuMs / subRequests / memory)
- `ReturnTooLargeError extends SerializationError` (return > 32 MiB)
- `DeadlineTooShortError extends SerializationError`

If you want to catch the new behavior specifically, add finer `instanceof` clauses; if you don't, your `catch (err) { if (err instanceof ExecutionError) ... }` still handles them.

`AggregateExecutionError` is new and *thrown by `pool.map` / `pool.scatter` under default `onError: 'throw'`* when 2+ items fail. It carries:
```ts
class AggregateExecutionError extends ParallelError {
  readonly errors: ReadonlyMap<number, ParallelError>;     // per-item errors
  readonly partialResults: ReadonlyMap<number, unknown>;   // siblings that completed
}
```
Successful sibling results are preserved on the error object — you don't have to use `'settled'` to recover them. To restore v0.2's first-error-wins behavior, opt in: `onError: 'throw-fast'`.

### 3.7 Per-Worker subrequest budgets are per-tier, not aggregate

If you used to worry about Bundled-plan subrequest caps, the v0.3 tree topology does NOT compound subrequests across tiers — each tier of the tree is a separate Worker invocation with its own 50/1000 budget. Only the leaf invocation might exceed Bundled 50 (4 LOADER.get + 1 result-write + your user fn's own subrequests). `cloudflare-parallel doctor` flags pools with declared user-fn subrequest count > 45 on Bundled.

---

## §4 — Step-by-step migration

```bash
# 1. Update dependency.
bun add cloudflare-parallel@^0.3.0

# 2. Run the codemod in preview.
npx cloudflare-parallel migrate

# 3. Apply the codemod.
npx cloudflare-parallel migrate --apply

# 4. Add DO bindings to wrangler.toml if doctor asks for them:
npx cloudflare-parallel doctor

# Sample wrangler.toml deltas (from doctor):
#
#   [[durable_objects.bindings]]
#   name = "CfpCoordinator"
#   class_name = "CfpCoordinator"
#
#   [[migrations]]
#   tag = "v1-cfp"
#   new_sqlite_classes = ["CfpCoordinator"]
#
# Plus mirrors for CfpWorkerDO, CfpSubCoord, CfpSchedulerDO if you use those primitives.

# 5. Re-export the library's DO classes from your entrypoint.
#    (The codemod adds these imports; doctor verifies presence.)
#
#    import {
#      CfpCoordinator,
#      CfpWorkerDO,
#      CfpSubCoord,
#      CfpSchedulerDO,
#    } from 'cloudflare-parallel/durable-objects';
#    export { CfpCoordinator, CfpWorkerDO, CfpSubCoord, CfpSchedulerDO };

# 6. Local sanity:
bun test
bunx wrangler dev --ip 0.0.0.0

# 7. Deploy.
bunx wrangler deploy
```

If you only need the v0.2 ergonomic with no DO bindings, skip steps 4–5 and use `Parallel.loaderOnly(env, opts)` instead of `Parallel.pool(env, opts)` — but be aware of the structural surface differences (no `warm`/`drain`/`stats`/`mapStream`/`mapOrdered`/`submitStream`/`handle`).

---

## §5 — New surfaces, in 5 lines each

### 5.1 `Parallel.actor<State>` — long-lived stateful actor

```ts
const session = Parallel.actor<{ history: string[] }>(env, {
  id: 'session-' + sessionId,
  initialState: { history: [] },
});
const n = await session.submit(
  (state, sql, msg: string, env) => {
    if (env.signal.aborted) return state.history.length;
    state.history.push(msg);
    sql.exec`INSERT INTO log VALUES (?, ?)`(msg, Date.now());
    return state.history.length;
  },
  'hello',
);
```

Actor user-fns receive `(state, sql, ...userArgs, env)` — `state` and `sql` prepended; `env` (with `env.signal`) appended. State must structured-clone-serialize into ≤ 16 MiB per submit. For larger state, partition by sub-id or use Workflows.

### 5.2 `Parallel.scheduler` — heterogeneous job queue

```ts
const scheduler = Parallel.scheduler(env, { id: 'jobs' });
const handle = await scheduler.enqueue<[Data], Result>({
  fn: heavyJob,
  args: [data],
  tenantId: 't-42',
  deadlineMs: 90_000,
  idempotencyKey: `tenant-42-${requestId}`,
});
const result: Result = await handle.result();
```

User fns submitted to the scheduler MUST be idempotent. The library enforces *result*-level at-most-once observability via storage CAS; your code must enforce *side-effect*-level idempotency.

### 5.3 `Parallel.VM` — HTTP submit-code surface

```ts
import { Parallel } from 'cloudflare-parallel';
export default class extends Parallel.VM {
  static opts: Parallel.VMOptions = {
    pool: { /* PoolOptions */ },
    auth: (req) => req.headers.get('authorization') === `Bearer ${env.VM_TOKEN}`,
    allowBindings: ['KV'],
    maxBytes: 64 * 1024,
  };
}
// POST /run with { "fn": "(x) => x*2", "args": [21] }
```

Functional form (recommended when `pool.bindings` references request-scoped `env`): `Parallel.vm(env, opts).fetch(req, ctx)`.

### 5.4 `pool.handle()` — bring-your-own HTTP routing

```ts
const handler = pool.handle({
  auth: (req) => verify(req),
  allowBindings: ['KV'],
});
app.post('/run', handler);
```

### 5.5 `Parallel.testing.poolFake` / `actorFake` / `schedulerFake` / `vmFake` / `loaderOnlyFake`

```ts
import { Parallel } from 'cloudflare-parallel/testing';

const pool = Parallel.testing.poolFake<{ KV: typeof kvStub }>({ bindings: { KV: kvStub } });
expect(await pool.submit((x, y) => x + y, 2, 3)).toBe(5);
```

Runs user fns in-process; matches production option types but skips `wrangler dev`. Structured-clone-roundtrips args/state/return so a fn that works in the fake but breaks in production is impossible by construction.

---

## §6 — Plan-tier and pricing notes

| Plan | What works |
|---|---|
| Workers Free | v0.3 does NOT support free-tier deployments. Worker Loader is paid-only (changelog 2026-03-24). |
| Workers Paid Bundled | All topologies. Caveat: leaf-stage user-fns doing > 45 of their own subrequests can hit Bundled's 50-subrequest limit per leaf invocation (4 LOADER.get + 1 result-write + your subrequests). |
| Workers Paid Unbound | All topologies. Effectively unbounded subrequests at every tier. |

Cost-shape changes (documented for reference; the library does not optimize for cost):
- Stable cache keys ⇒ per-`(fn-shape, day)` billable Dynamic Workers, not per-submission. Net cost reduction for high-throughput pools.
- Coordinator DO ⇒ adds DO RPC sessions to your bill (one per `pool.submit`/`map` etc.). Negligible compared to compute.
- Tree topology ⇒ adds K extra DO RPC sessions per request. Each is its own billed DO request.
- Tail Worker auto-attach defaults to **0.1 sampling** to keep tail-event count proportional.

---

## §7 — `cloudflare-parallel-compat@0.2`: staged-rollout package

If you can't migrate all your Workers in lockstep:

```bash
# In each Worker:
bun add cloudflare-parallel-compat@^0.2.0

# In source: change ONLY the import path.
- import { Parallel } from 'cloudflare-parallel';
+ import { Parallel } from 'cloudflare-parallel-compat';
# Everything else stays v0.2-shape.
```

The compat shim:
- Re-exports the v0.2 surface against v0.3 internals.
- Routes v0.2's `Parallel.pool(env.LOADER, opts)` to a full `Pool` with `topology: 'in-do'` (NOT `loaderOnly`, because v0.2 had `mapStream`/`mapOrdered`/etc. that loader-only doesn't expose).
- **Requires you to add the `CfpCoordinator` DO binding to `wrangler.toml`** (one-line scaffolded by `cloudflare-parallel doctor`). Without it, the shim throws a clear `MissingBindingError("v0.2 → v0.3 requires CfpCoordinator DO binding; run 'cloudflare-parallel doctor' to scaffold")` at construction time — not an opaque runtime crash.
- Logs a one-time deprecation warning per cold start.

The eventual goal is to drop the compat dep once all Workers are migrated. The compat package's own deprecation is targeted for cloudflare-parallel 0.5.0 (no firm date).

---

## §8 — Frequently-encountered errors after migration

| Error | Likely cause | Fix |
|---|---|---|
| `BindingError: WorkerPool requires a Worker Loader binding.` | `wrangler.toml` missing `[[worker_loaders]]` (same as v0.2). | Add `[[worker_loaders]]\nbinding = "LOADER"` |
| `MissingBindingError: ... CfpCoordinator ...` | Topology higher than `loaderOnly` selected, but DO not bound. | Run `cloudflare-parallel doctor`; add the DO binding it suggests. (Or call `Parallel.loaderOnly()` instead if you don't need DOs.) |
| `TopologyError: 'in-do' requires size <= 4` | You pinned `topology: 'in-do'` but called with `size > 4`. | Remove the pin (use `'auto'`) or pick `'hybrid'` / `'tree'`. |
| `SerializationError: returned values cannot include RPC stubs` | Your user fn returned a stub it received via `bindings`. | Restructure to extract the value at call time and return that. |
| `ReturnTooLargeError: return > 32 MiB` | Your user fn returns a giant blob. | Use `pool.submitStream` or partition the result. |
| `BackpressureError` from `submit()` | Cloudflare runtime saturation (LRU thrash, owner-quota, per-isolate cap miscount). | Library auto-retries with exponential backoff + jitter, capped at `retries` policy. If persistent: reduce concurrency or shard your pool across multiple owner accounts. |
| `DisconnectedError` | Eviction-mid-flight or `abortIsolate`. | Library auto-retried once. If persistent: file a bug — likely a runtime-version-specific shape we don't yet recognize. |
| `AggregateExecutionError` from `pool.map` | 2+ items failed under default `onError: 'throw'`. | Inspect `.errors` and `.partialResults`. To restore v0.2 fail-fast, set `onError: 'throw-fast'`. |
| `DeadlineTooShortError` | Sub-second deadline, OR `deadlineMs` budget < min for the tree depth. | Raise the deadline; minimum budget scales with tree depth K. |
| `console.warn: function uses module-scope state — pass {freshIsolate: true} for per-call isolation` | Stable cache key heuristic detected mutable module-scope binding. | If state-leak is intentional, ignore. If not, opt into `freshIsolate: true` or `cacheKeyStrategy: 'auto'`/`'fresh'`. |
| `process.exit is undefined` in user fn | `nodejs_compat` not enabled. | Either add `compatibility_flags = ["nodejs_compat"]` to your wrangler.toml, or remove the call. |
| User fn ran twice when retried by Scheduler | At-least-once execution per ADR-9. | Use `idempotencyKey` on `Job` and idempotent downstream calls (HTTP Idempotency-Key, `INSERT ... ON CONFLICT`, etc.). |

---

## §9 — Things you might have to live with

These are documented constraints, not bugs:

- **Worker Loader is Open Beta and Paid-only.** v0.3 cannot run on Workers Free.
- **The 3-from-fetch-handler / 4-from-DO-method per-V8-isolate concurrent-loader cap** is empirically validated but not in any public Cloudflare doc. The library probes for it at coordinator cold-start. If you call `Parallel.loaderOnly()`, you're capped at 3 concurrent isolates per request.
- **The 50/owner LRU on Worker Loader is a per-process cap.** Under heavy multi-tenant pressure on a single metal you'll see `BackpressureError`. Library retries with jittered backoff; persistent saturation is a Cloudflare-side concern you can't work around.
- **`AbortSignal` does not cross DO RPC.** Use `CancelToken.fromAbortSignal(signal)` at the caller boundary; library cancels on signal but the wire format is `CancelToken`, not `AbortSignal`.
- **Cancel is not free** — orphans run to `cpuMs`. This is the contract. 
- **Streaming results across coordinator restart** raise `DisconnectedError` to the consumer in v0.3. Resumable cursors land in v0.4 (forward-compat: the wire format already carries sequence numbers).
- **No DO Facets.** The docs/cf-internals.md explains why (depth=4, no capabilities-in-props, VULN-131748). Hybrid + tree topology already exceeds anything facets could provide.

---

## §10 — Reporting issues

- v0.3 bugs: GitHub issues (preferred) or PRs.
- Surprising errors after migration: please include `cloudflare-parallel doctor --json` output and the codemod's last `--apply` log so we can reproduce.
- Production cost surprises: the library does not optimize for cost. Include `PoolStats` and `SchedulerStats` snapshots if you'd like input.

End of MIGRATION.md.
