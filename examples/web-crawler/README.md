# web-crawler

Recursive web crawler with bounded depth, fair concurrency, and a
per-page-isolate execution model.

## What it shows

- **Tree topology in action.** Each level of the crawl is a `pool.map`
  call that fans out across loaded isolates. Once the pending set
  exceeds the in-DO cap (4), the runtime auto-promotes to hybrid; past
  16, to tree.
- **Per-isolate work isolation.** A page that hangs / OOMs / loops
  affects only its own isolate; siblings keep running.
- **`onError: 'partial'`.** A 404 / network error returns a placeholder
  for that URL but doesn't fail the whole crawl frontier.
- **No closures, no shared state.** The page-fetch fn is a self-
  contained function that takes a URL string and returns a structured
  page result. Easy to serialize, easy to reason about.
- **`PoolStats.topology`.** Read after each level to see which
  topology the runtime selected for that frontier size.

## How to run

```bash
cd examples/web-crawler
bun install
bun x wrangler dev
curl 'http://localhost:8787/?seed=https://example.com&maxDepth=2&maxPages=50' | jq
```

## What to learn

- The 4N parallelism math: with `maxPages=50` at depth 2, you'll see
  the pool report `topology: 'hybrid'` (or `'tree'` if N>16) on the
  level-2 frontier.
- Wall-clock for a 100-page crawl scales sub-linearly — the bottleneck
  becomes upstream RTT, not the runtime.
- Closures are a footgun: `crawlPageFn` deliberately doesn't reference
  any outer variables. If you mutate an outer set / map, the runtime
  will silently lose those mutations across isolates.
