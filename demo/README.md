# cloudflare-parallel-demo

The interactive showcase site for [`cloudflare-parallel`](https://github.com/AshishKumar4/cloudflare-parallel).

Live: [**cloudflare-parallel-demo.pages.dev**](https://cloudflare-parallel-demo.pages.dev)

## Architecture

Two pieces:

1. **Static frontend** (this directory) — vanilla TypeScript + CSS, no
   framework. Compiles to a single `public/` tree served by Cloudflare
   Pages. ~30 KB of JS after compile.
2. **Backend** — the already-deployed test worker
   `cloudflare-parallel-prod-tests` (see `tests/prod/test-worker/`). It
   has every library DO + LOADER binding and exposes one HTTP route per
   primitive. The frontend calls it cross-origin with CORS.

This split avoids re-deploying the same backend twice. Pages site
serves the UI; the test worker serves the live primitive endpoints.

## Run locally

```bash
cd demo
bun install
bun run build              # tsc → public/app.js
# then serve public/ with any static server, e.g.:
bun --bun -e 'Bun.serve({ port: 4173, fetch: (req) => new Response(Bun.file(`public${new URL(req.url).pathname === "/" ? "/index.html" : new URL(req.url).pathname}`)) })'
```

The frontend always points at the deployed test worker (`API` constant
at the top of `src/app.ts`). Edit it to point at a local
`wrangler dev --local` instance if you're modifying the backend.

## Deploy

```bash
cd demo
npm run deploy             # tsc → wrangler pages deploy
```

This deploys to the `cloudflare-parallel-demo` Pages project on the
Cloudflare account whose CLI is logged in.

## Panels

Every panel is CPU-bound work. No I/O simulators, no `fetch` fan-out
demos — that's what the README explicitly tells you to use plain
`Promise.all` for.

| #  | Panel                  | What it shows                                             |
| -- | ---------------------- | --------------------------------------------------------- |
| ①  | Hero fan-out           | Pick N (4, 32, 128, 256, 512); SHA-256-chain × N          |
| ②  | Topology visualizer    | Per-row "Run" updates fan-out shape live                  |
| ③  | Primitive playgrounds  | One card per `Pool` method, all CPU work                  |
| ④  | Scheduler dashboard    | Enqueue burst (each job: 1M LCG iters), watch stats       |
| ⑤  | Actor demo             | Counter Actor; state persists across submits              |
| ⑥  | VM submit-code         | Bearer-auth, sandboxed; user-pasted JS function           |
| ⑦  | Cancel showcase        | SSE-streamed long task; close request → AbortSignal trips |
| ⑧  | Bench leaderboard      | Per-topology speedup curve from `bench-results-live.json` |

## Why no framework

The library being demoed is what matters. The demo site is a thin
shell: ~600 lines of TS, ~400 lines of CSS, no build step beyond
`tsc`. Loads under 2 s on first visit, no client-side hydration cost.
