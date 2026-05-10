# build-pipeline

CPU-bound build-tool fan-out: tokenize, minify, complexity-analyze,
hash N source files in parallel.

## Why this example

Real-world build tooling is CPU-bound: parsing, AST transforms, code
generation, hashing. A 200-file project takes seconds single-threaded.
This example shows what `make -j` looks like on Cloudflare Workers.

The pipeline runs five stages on each file:

1. Tokenize (regex split).
2. Strip comments + dead lines.
3. Compute cyclomatic complexity.
4. Mock minification (rename short identifiers).
5. SHA-256 hash the output.

Per-file: ~10-50 ms on workerd CPU. 200 files single-threaded ≈ several
seconds. `pool.map` runs them across N parallel V8 isolates.

## What it shows

- **`pool.map` over a heterogeneous workload.** Each file has different
  size and structure, so per-task wall-clock varies. Real fan-out
  patterns benefit when the long-tail is short relative to the average.
- **Auto-topology selection.** `?files=512` forces tree topology.
- **Synthetic but realistic.** No reading from R2 or a Git tree — the
  source is generated deterministically in the parent and shipped to
  each isolate. The CPU cost is real.

## Running

```bash
cd examples/build-pipeline
bun install
bun x wrangler dev
# In another shell:
curl -s 'http://localhost:8787/?files=128' | jq .summary
```

## When NOT to use this pattern

If your "build" is reading 200 files from R2 and concatenating them,
that's I/O — `Promise.all([env.R2.get(...), ...])` is the right tool.
This library helps when each file requires non-trivial JS-side
transformation (parse, lint, transform, hash).
