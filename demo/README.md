# cloudflare-parallel demo assets

The interactive showcase site for [`cloudflare-parallel`](https://github.com/AshishKumar4/cloudflare-parallel).

Live: [**cloudflare-parallel.ashishkmr472.workers.dev**](https://cloudflare-parallel.ashishkmr472.workers.dev)

## Architecture

One Worker deployment:

1. **Static frontend** (this directory) — vanilla TypeScript + CSS, no
   framework. Compiles to a single `public/` tree served as Worker static
   assets. ~30 KB of JS after compile.
2. **Backend endpoints** (`tests/prod/test-worker/`) — the same Worker has
   every library DO + LOADER binding and exposes one HTTP route per
   primitive. The frontend calls those endpoints on the same origin.

The result is one deployed URL for both UI and API:
`https://cloudflare-parallel.ashishkmr472.workers.dev`.

## Run locally

```bash
cd demo
bun install
bun run build              # tsc → public/app.js
# then serve public/ with any static server, e.g.:
bun --bun -e 'Bun.serve({ port: 4173, fetch: (req) => new Response(Bun.file(`public${new URL(req.url).pathname === "/" ? "/index.html" : new URL(req.url).pathname}`)) })'
```

The frontend points at `location.origin`, so the deployed UI and API stay
on the same Worker origin. Use a local static server plus
`wrangler dev --local` only when debugging the frontend/backend split.

## Deploy

```bash
cd demo
npm run deploy             # tsc → refresh package → wrangler deploy
```

This deploys the single `cloudflare-parallel` Worker on the Cloudflare
account whose CLI is logged in.

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
