# research-agent

Parallel research over four heterogeneous public APIs, then synthesis via
Workers AI — all in a single Worker request.

## What it shows

- **`pool.map` with auto-topology selection.** Four sources fan out
  across loaded isolates concurrently. Every source query runs in its
  own isolate so a slow / broken upstream cannot block the others.
- **Per-isolate context injection.** The user fn declares
  `declare const query: string;` at module scope; the runtime materializes
  it inside each isolate via `pool.context`.
- **Workers AI binding propagation.** `bindings: { AI: env.AI }` makes
  `env.AI.run('@cf/meta/llama-3.1-8b-instruct', ...)` available inside
  every isolate, no extra plumbing.
- **Graceful degradation via `onError: 'partial'`.** A single failing
  source returns `null` in its slot; the synthesis step deals with
  whichever sources came back.

## How to run

```bash
cd examples/research-agent
bun install
bun x wrangler dev
# In another shell:
curl 'http://localhost:8787/?q=large+language+models' | jq
```

You'll get a JSON brief with one entry per source plus a top-level
`synthesis` field assembled by the AI model from the four summaries.

## What to learn

- This is the canonical "parallel API aggregation" shape. Replace the
  four sources with your own — Algolia, HackerNews, internal search,
  RAG store — and the topology stays the same.
- Notice there are **no closures** in `crawlSourceFn`. Every variable
  it touches is either `query` (injected via context), an arg, or a
  web global. That's the contract for serializable user fns.
