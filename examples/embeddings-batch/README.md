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
- **Auto-topology selection.** Try `?n=4` (in-DO), `?n=64` (hybrid 4N),
  `?n=512` (tree). Read `topology.decision` in the response.
- **Two `pool` calls compose.** `pool.map(...)` for the corpus + a second
  `pool.submit(...)` for the query embedding — the small one stays
  in-DO, the big one fans out.
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

You'll get topology = `'hybrid'` and a fanOut shape like `[32, 4, 4, ...]`
— that's 32 leaf DOs each running 4 loaders = up to 128 parallel embeddings.

## When NOT to use this pattern

If your corpus lives in Workers AI and you call `env.AI.run(...)` per doc —
that's I/O. `Promise.all` on a single isolate is the right tool; this
library buys you nothing. Use this library when each item is genuinely
CPU-heavy in JS.
