# When to use cloudflare-parallel

This document is the load-bearing positioning of the library. **Read it
before reaching for `pool.map` for any new workload.**

## Invariant: we exist for CPU-bound work

JavaScript is single-threaded. A V8 isolate has exactly one thread of
execution. The runtime's event loop interleaves I/O for free —
`Promise.all([fetch(a), fetch(b), fetch(c)])` runs three HTTP requests
concurrently on one isolate because they spend most of their lifetime
suspended on the network, with the event loop scheduling between them.

What the event loop **cannot** interleave is CPU. If three tasks each
spin a CPU-heavy loop for 100 ms, `Promise.all` runs them sequentially —
total wall-clock 300 ms — because there's no I/O suspension point for
the loop to interleave at. Awaiting a microtask doesn't yield CPU; it
just resumes on the next tick of the same thread.

This library exists to escape that single-thread-of-execution constraint
by spawning user code into separate V8 isolates. Each isolate has its
own heap and its own thread-of-execution slot in workerd. Three CPU-heavy
tasks across three isolates run in genuine parallel — wall-clock ~100 ms.

## Decision matrix

| Workload shape | Use |
| --- | --- |
| Awaiting `fetch` / `env.AI` / `env.KV` / `env.D1` / `env.R2` calls | Plain `Promise.all([...])` on one isolate |
| `await new Promise(r => setTimeout(r, 1000))` × N | `Promise.all` |
| Reading a stream from R2 and processing chunks as they arrive | Plain async iteration |
| Each task burns ≥ 10 ms of pure CPU and you have ≥ 4 of them | `pool.map` |
| Embedding / hashing / signing thousands of items | `pool.map` |
| Image transforms / raytracing / dithering | `pool.map` (one isolate per tile) |
| Parsing / linting / building hundreds of source files | `pool.map` |
| Genetic / Monte Carlo / simulated annealing — each candidate is heavy | `pool.map` per generation |
| Running user-submitted code with a known-bounded body | `pool.handle` / `Parallel.vm` |
| Long-running stateful counter / chatlog / cart | `Parallel.actor` |
| Persistent job queue with retries and deadlines | `Parallel.scheduler` |

## The 10ms-per-task threshold

Empirically, dispatch + DO RPC + loader cold-start adds **~5-15 ms** of
overhead per task on the parallel path. Per-task CPU should be **≥ 10 ms**
before the parallelism wins. Below that, sequential on one isolate is
strictly faster.

The `embeddings-batch`, `raytracer`, `genetic-algorithm`, and
`build-pipeline` examples are all in the 10-100 ms-per-task regime.
That's deliberate — the speedup is real and visible on the bench.

## Don't fight the event loop

If you find yourself reaching for `pool.map` to fan out 100 `fetch()`
calls, stop. The event loop on one isolate happily holds 100 in-flight
requests; the CPU work is the response parsing, which is cheap. Fan-out
buys you nothing and pays you 5-15 ms of dispatch overhead per call.

If you're parsing 100 large JSON blobs after the fetches return, *that*
is the CPU work — fan out the parsing, not the fetching:

```ts
// Bad: fans out the I/O, no CPU benefit.
const blobs = await pool.map((url: string) => fetch(url).then((r) => r.text()), urls);

// Good: fetch on one isolate, fan out the CPU-bound parse.
const blobs = await Promise.all(urls.map((u) => fetch(u).then((r) => r.text())));
const parsed = await pool.map((blob: string) => expensivelyParse(blob), blobs);
```

## Topology bounds

Auto-selector picks based on `items.length`:

| Size | Topology | V8 isolates |
| --- | --- | --- |
| ≤ 4 | `in-do` | 4 (one DO, four loaders) |
| 5..256 | `hybrid` | `4N` where `N = ⌈size/4⌉` |
| > 256 | `tree` | `4·F^K` (F=8 by default; K = ⌈log_F size⌉) |

The 4N math is the load-bearing claim of this library: spawning N child
DOs around a parent DO multiplies the per-DO 4-loader cap. See
`docs/architecture.md` for the substrate evidence.

## Workerd cpuMs cap

Each loaded isolate inherits its own `cpuMs` budget. A 30-second cpu
budget × 128 isolates ≈ 64 minutes of compute available within a single
~30 s wall-clock Worker request. Use that wisely.

## Live numbers

The deployed test worker
([`cloudflare-parallel-prod-tests.ashishkmr472.workers.dev`](https://cloudflare-parallel-prod-tests.ashishkmr472.workers.dev))
runs the same SHA-256-chain CPU bench at every topology size. Latest
numbers in [`bench-results-live.json`](../bench-results-live.json):

```
size=4    in-do   speedup ≈ 1x  (dispatch overhead floor)
size=64   hybrid  speedup ≈ 1.4x
size=128  hybrid  speedup ≈ 2.2x
size=256  tree    speedup ≈ 2.6x
size=512  tree    speedup ≈ 2.4x
```

These are honest numbers. Speedup at small sizes is small because
dispatch overhead dominates; speedup grows with size because the CPU
work amortizes the overhead. At very large sizes, tree-RPC overhead
(K extra hops) starts to bite back. The sweet spot is ~64-256 items at
≥10 ms per task.
