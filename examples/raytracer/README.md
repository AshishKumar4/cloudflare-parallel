# raytracer

CPU-bound distributed raytracing. The image is sliced into N horizontal
tiles; each isolate renders one tile against a tiny scene; tiles are
reassembled into a PPM image.

## Why this example

This is the canonical "embarrassingly parallel CPU work" demo. Every
ray costs ~50 µs on the Workers runtime; a 192-row tile of a 320-wide image is
~60k rays = a couple of seconds single-threaded. Splitting across
N tiles and N isolates collapses wall-clock by the parallelism factor.

Visual, dramatic, *visibly* CPU-bound. There's no I/O — the scene and
camera are baked into the user fn.

## What it shows

- **`pool.map` over a TileSpec list.** Each tile is independent; perfect
  fan-out shape.
- **Tree topology when tiles > 16².** Try `?tiles=64` or `?tiles=128`.
- **Pure JS raytracing.** ~60 lines of trace + Lambertian shading +
  one shadow ray per pixel + a checker plane. Works because each
  isolate gets its own V8 heap.
- **PPM output.** Open with macOS Preview or `convert out.ppm out.png`.

## Running

```bash
cd examples/raytracer
bun install
bun x wrangler dev
# In another shell:
curl -o out.ppm 'http://localhost:8787/render?w=320&h=192&tiles=16'
open out.ppm
```

Add `?json=1` (or `Accept: application/json`) to get topology metadata
and timings without the image bytes.

## When NOT to use this pattern

If you're rendering a single thumbnail synchronously at ≤32 px on a
side, the dispatch overhead won't pay off — keep it on one isolate.
This library starts winning when each task takes ≥10 ms of CPU and
you have ≥4 of them.
