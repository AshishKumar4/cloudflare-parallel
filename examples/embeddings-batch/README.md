# embeddings-batch

CPU-bound vector embeddings over thousands of docs, parallelized across V8 isolates.

## Why this example

Each doc is hashed into a 256-dim feature vector via deterministic hashing
+ mixing passes. ~1-3 ms per doc on the Workers runtime. Single-threaded JS would
serialize all N docs behind the event loop. `pool.map` runs them across
N parallel V8 isolates so the wall-clock is bounded by the slowest one,
not the sum.

## What it shows

- **`pool.map` over a CPU-bound function.** No I/O. Each isolate computes
  its own embedding from scratch — a real doc-corpus indexing shape.
- **Auto-topology selection.** Try `?n=4` (hybrid, 4 leaf DOs), `?n=64`
  (tree, root → 8 sub-coords → 8 leaves each), `?n=512` (deeper tree).
  Read `topology.decision` in the response.
- **Two `pool` calls compose.** `pool.map(...)` for the corpus + a second
  `pool.submit(...)` for the query embedding — the single-shot stays
  on the in-do fast path, the fan-out spreads across leaf DOs.
- **Cosine similarity in the parent.** It's cheap; one dot-product per
  doc. The library is for CPU-bound *batches*, not for everything.

## Running

```bash
cd examples/embeddings-batch
bun install
bun x wrangler dev
# In another shell:
curl -s -X POST 'http://localhost:8787/?n=128&k=5' \
     -H 'content-type: application/json' \
     -d '{"query":"cloudflare workers"}' | jq
```

At N=128 you'll get topology = `'tree'` with fanOut `[8, 16]` — root
coord fans out to 8 sub-coords, each fanning out to 16 leaf DOs. That's
128 leaf DOs running one embedding each — 128 parallel V8 isolates,
each on its own workerd process.

## When NOT to use this pattern

If your corpus lives in Workers AI and you call `env.AI.run(...)` per doc —
that's I/O. `Promise.all` on a single isolate is the right tool; this
library buys you nothing. Use this library when each item is genuinely
CPU-heavy in JS.
