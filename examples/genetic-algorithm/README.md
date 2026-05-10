# genetic-algorithm

CPU-bound evolutionary search for the Travelling Salesperson Problem.
Each generation evaluates a population of candidate tours in parallel
across V8 isolates.

## Why this example

This is the **killer demo** for CPU-bound fan-out. Each candidate
evaluation is:

1. Compute total tour distance — cheap.
2. **2-opt local search refinement** — `O(n²)` per evaluation, ~5-15 ms
   on the Workers runtime at 50 cities.

A population of 256 over 30 generations is 7,680 evaluations. Single
threaded JS would serialize them all behind the event loop. `pool.map`
runs each generation across N parallel isolates so wall-clock per
generation becomes `~max(eval)` instead of `sum(eval)`.

The 2-opt step is what makes it dramatic: without it the per-task work
is too cheap and dispatch overhead dominates. With it, each task is
genuinely CPU-heavy and the parallelism wins.

## What it shows

- **`pool.map` over a population.** Each isolate evaluates one
  candidate; results are aggregated by the parent for breeding.
- **Iterative fan-out.** Each generation is its own `pool.map` call;
  selection + crossover + mutation happen in the parent (cheap, no need
  to fan out).
- **Hybrid → tree topology.** Try `?pop=256` (hybrid 4N), `?pop=512`
  (tree). Topology shows in the response.
- **Honest history.** The response returns per-generation `bestDistance`
  + `ms` so you can see the convergence curve and the per-gen wall-clock.

## Running

```bash
cd examples/genetic-algorithm
bun install
bun x wrangler dev
# In another shell:
curl -s 'http://localhost:8787/?gen=20&pop=128&cities=50' | jq .history
```

You should see `bestDistance` decrease monotonically (or near-monotonically)
across generations. Each `ms` is the wall-clock of one parallel
evaluation pass — multiply by `gen` to get the total.

## When NOT to use this pattern

If your fitness function is sub-millisecond, dispatch overhead will
dominate. Rule of thumb: each task should be ≥10 ms of CPU before
fan-out pays off. The 2-opt refinement here is what gets us above that
threshold.
