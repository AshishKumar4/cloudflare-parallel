/**
 * Test Worker for live prod E2E. Exposes one HTTP route per
 * library primitive so the test runner can exercise every surface
 * end-to-end against a live Workers runtime via `wrangler dev --local`.
 *
 * Routes:
 *   GET  /health
 *   POST /pool/submit            { fn, args }
 *   POST /pool/map               { items[], n? }    auto-topology
 *   POST /pool/scatter           { items[], chunks }
 *   POST /pool/reduce            { items[] }
 *   POST /pool/pmap              { items[], chunks }
 *   POST /pool/pipe              { input }
 *   POST /pool/mapStream         { items[] }       SSE-ish JSON-line stream
 *   POST /pool/mapOrdered        { items[] }
 *   POST /pool/cancel            { items[], cancelAfterMs }
 *   POST /pool/warm              { isolates? }
 *   GET  /pool/stats
 *   POST /actor/inc              { id }
 *   GET  /actor/state            ?id=...
 *   POST /actor/close            ?id=...
 *   POST /scheduler/enqueue      { tenant, n, idemKey? }
 *   GET  /scheduler/result       ?id=...
 *   GET  /scheduler/stats
 *   POST /scheduler/cancel-tenant { tenant }
 *   POST /scheduler/configure    { inFlightLimit?, maxQueueDepth?, fairCapacityPerTenant? }
 *   POST /vm                     { fn, args }    (auth: Bearer VM_TOKEN)
 *   POST /loader-only/map        { items[] }
 *   POST /bench/sequential       { items[] }     CPU-bound seq baseline
 *   POST /bench/parallel-map     { items[] }     CPU-bound parallel
 *   POST /demo/mandelbrot        { width, height, maxIter, cx, cy, zoom }
 *   POST /demo/bench             { size }        live SHA-chain bench
 *   POST /demo/cancel-start      { iters }       SSE; cancel by closing
 *   POST /demo/scheduler-burst   { tenant, count }
 *   GET  /errors/timeout
 *   GET  /errors/aggregate
 */

import { Parallel, CancelToken, bearerAuth, type WorkerLoader } from 'cloudflare-parallel';
export {
  CfpCoordinator,
  CfpWorkerDO,
  CfpSubCoord,
  CfpSchedulerDO,
  CfpInProcessCoordinator,
} from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
  CfpSchedulerDO: DurableObjectNamespace;
  VM_TOKEN: string;
  [key: string]: unknown;
}

// Cloudflare's `ExecutionContext.exports` carries one auto-generated
// loopback binding per top-level export. The runtime types make this
// available via `Cloudflare.Exports`; we mirror just the shape we need.
interface CtxWithExports extends ExecutionContext {
  exports?: {
    CfpInProcessCoordinator?: unknown;
  };
}



// CORS: the demo site (cloudflare-parallel-demo.pages.dev) calls this
// worker cross-origin. Allow any origin; the surface is read-only +
// auth-gated where it matters.
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/health') {
        return Response.json({ ok: true, ts: Date.now() });
      }

      // Wire up the in-process coordinator loopback (skips the DO hop for
      // small-N submits) and forward the request's colo as a placement
      // hint so freshly-created leaf DOs land in the same region.
      // References:
      //   https://developers.cloudflare.com/workers/runtime-apis/context/
      //   https://developers.cloudflare.com/durable-objects/reference/data-location/
      const inProcess = (ctx as CtxWithExports).exports?.CfpInProcessCoordinator as
        | NonNullable<Parameters<typeof Parallel.pool>[1]>['inProcess']
        | undefined;
      const requestColo = (req as Request & { cf?: { colo?: string } }).cf?.colo;
      const pool = Parallel.pool(env, {
        inProcess,
        requestColo,
      });

      // ---- Pool primitives ----
      if (path === '/pool/submit' && req.method === 'POST') {
        const { fn, args } = (await req.json()) as { fn: string; args: unknown[] };
        // the Workers runtime disables `eval` in the parent Worker — use the
        // submitSource path which ships the source straight to the loader.
        const v = await pool.submitSource(fn, args ?? []);
        return Response.json({ value: v });
      }

      if (path === '/pool/map' && req.method === 'POST') {
        const t0 = Date.now();
        const { items } = (await req.json()) as { items: number[] };
        const out = await pool.map((n: number) => n * n, items);
        const stats = await pool.stats();
        return Response.json({
          out,
          ms: Date.now() - t0,
          topology: stats.topology,
          fanOutPerLevel: stats.fanOutPerLevel,
          treeDepth: stats.treeDepth,
        });
      }

      if (path === '/pool/scatter' && req.method === 'POST') {
        const { items, chunks } = (await req.json()) as { items: number[]; chunks: number };
        const out = await pool.scatter(
          (chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
          items,
          chunks,
        );
        return Response.json({ out });
      }

      if (path === '/pool/reduce' && req.method === 'POST') {
        const { items } = (await req.json()) as { items: number[] };
        const r = await pool.reduce((a: number, b: number) => a + b, items, 0);
        return Response.json({ result: r });
      }

      if (path === '/pool/pmap' && req.method === 'POST') {
        const { items, chunks } = (await req.json()) as { items: number[]; chunks?: number };
        const fn = pool.pmap((batch: number[]) => batch.map((n) => n * 2));
        const out = await fn(items, { chunks: chunks ?? 4 });
        return Response.json({ out });
      }

      if (path === '/pool/pipe' && req.method === 'POST') {
        const { input } = (await req.json()) as { input: number };
        const stage = pool.pipe(
          (n: number) => n + 1,
          (n: number) => n * 2,
          (n: number) => n.toString(),
        );
        const out = await stage(input);
        return Response.json({ out });
      }

      if (path === '/pool/mapStream' && req.method === 'POST') {
        const { items } = (await req.json()) as { items: number[] };
        const collected: { index: number; value: number }[] = [];
        for await (const r of pool.mapStream((n: number) => n * n, items)) {
          collected.push(r);
        }
        return Response.json({ collected });
      }

      if (path === '/pool/mapOrdered' && req.method === 'POST') {
        const { items } = (await req.json()) as { items: number[] };
        const collected: number[] = [];
        for await (const v of pool.mapOrdered((n: number) => n * n, items)) {
          collected.push(v);
        }
        return Response.json({ collected });
      }

      if (path === '/pool/cancel' && req.method === 'POST') {
        const { items, cancelAfterMs } = (await req.json()) as {
          items: number[];
          cancelAfterMs: number;
        };
        const cancel = CancelToken.withTimeout(cancelAfterMs);
        const t0 = Date.now();
        try {
          await pool.map(
            async (n: number, env) => {
              for (let i = 0; i < 50; i++) {
                if (env.signal.aborted) return -1;
                await new Promise((r) => setTimeout(r, 20));
              }
              return n;
            },
            items,
            { cancel },
          );
          return Response.json({ cancelled: false, ms: Date.now() - t0 });
        } catch (e) {
          return Response.json({
            cancelled: true,
            ms: Date.now() - t0,
            error: (e as Error).name,
          });
        }
      }

      if (path === '/pool/warm' && req.method === 'POST') {
        const { isolates } = (await req.json()) as { isolates?: number };
        const t0 = Date.now();
        await pool.warm({ isolates: isolates ?? 4 });
        return Response.json({ warmed: isolates ?? 4, ms: Date.now() - t0 });
      }

      if (path === '/pool/stats') {
        return Response.json(await pool.stats());
      }

      // ---- Actor ----
      if (path === '/actor/inc' && req.method === 'POST') {
        const { id } = (await req.json()) as { id: string };
        const actor = Parallel.actor<{ count: number }>(env, {
          id,
          initialState: { count: 0 },
        });
        const v = await actor.submit((state) => {
          state.count += 1;
          return state.count;
        });
        return Response.json({ count: v });
      }

      if (path === '/actor/state') {
        const id = url.searchParams.get('id');
        if (!id) return new Response('?id= required', { status: 400 });
        const actor = Parallel.actor<{ count: number }>(env, {
          id,
          initialState: { count: 0 },
        });
        const v = await actor.submit((state) => state.count);
        return Response.json({ count: v });
      }

      if (path === '/actor/close' && req.method === 'POST') {
        const id = url.searchParams.get('id');
        if (!id) return new Response('?id= required', { status: 400 });
        const actor = Parallel.actor<{ count: number }>(env, {
          id,
          initialState: { count: 0 },
        });
        await actor.close();
        return Response.json({ closed: true });
      }

      // ---- Scheduler ----
      const scheduler = Parallel.scheduler(env, {
        id: 'prod-tests',
        retry: { max: 3, backoff: 'exponential', baseMs: 100 },
        deadline: { defaultMs: 30_000 },
        resultRetention: { ttlMs: 600_000 },
      });

      if (path === '/scheduler/enqueue' && req.method === 'POST') {
        const body = (await req.json()) as { tenant: string; n: number; idemKey?: string };
        const handle = await scheduler.enqueue<[number], number>({
          fn: (n) =>
            Array.from({ length: n }, (_, i) => i).reduce((a, b) => a + b, 0),
          args: [body.n],
          tenantId: body.tenant,
          deadlineMs: 10_000,
          idempotencyKey: body.idemKey,
        });
        return Response.json({ jobId: handle.id });
      }

      if (path === '/scheduler/result') {
        const id = url.searchParams.get('id');
        if (!id) return new Response('?id= required', { status: 400 });
        // Re-derive a handle from the SchedulerDO directly (handles aren't
        // serializable across requests).
        const stub = env.CfpSchedulerDO.get(env.CfpSchedulerDO.idFromName('prod-tests'));
        const r = await (stub as unknown as { result: (id: string) => Promise<unknown> }).result(
          id,
        );
        return Response.json(r);
      }

      if (path === '/scheduler/stats') {
        return Response.json(await scheduler.stats());
      }

      if (path === '/scheduler/cancel-tenant' && req.method === 'POST') {
        const { tenant } = (await req.json()) as { tenant: string };
        const cancelled = await scheduler.cancelByTenant(tenant);
        return Response.json({ cancelled });
      }

      if (path === '/scheduler/configure' && req.method === 'POST') {
        const cfg = (await req.json()) as Parameters<typeof scheduler.configure>[0];
        const eff = await scheduler.configure(cfg);
        return Response.json(eff);
      }

      // ---- VM (HTTP submit-code with bearer auth) ----
      if (path === '/vm') {
        const vmHandler = Parallel.vm(env, {
          timeout: 5_000,
          globalOutbound: null,
          policy: {
            kind: 'auth',
            auth: bearerAuth(env.VM_TOKEN),
            allowBindings: [],
            maxBytes: 64 * 1024,
          },
        });
        return vmHandler.fetch(req);
      }

      // ---- Loader-only ----
      if (path === '/loader-only/map' && req.method === 'POST') {
        const { items } = (await req.json()) as { items: number[] };
        const lop = Parallel.loaderOnly(env);
        const out = await lop.map((n: number) => n * n, items);
        return Response.json({ out });
      }

      // ---- Hero workloads ----
      //
      // Each workload supports `mode: 'parallel' | 'sequential'`. The
      // sequential path runs inline (cpuMs cap = 30s) on a single
      // sample then extrapolates linearly so the demo can show
      // "would-take-Xs" without burning the cpuMs budget. Parallel
      // runs the full N via pool.map.
      //
      // All workloads are pure CPU. Each task is sized to ~500ms+ on
      // the Workers runtime so dispatch overhead is amortized.
      //
      // CRITICAL: each user fn is closure-free. Constants come from the
      // task argument (a context object), NOT from outer-scope captures.

      // A. Mandelbrot — N tiles, each renders a horizontal slab.
      //
      // Per-tile work targets ~500–800 ms so the 4N composition dominates
      // dispatch overhead. The default scene is the full Mandelbrot set
      // at zoom=350 around the origin: the cardioid's interior fills most
      // of the frame, every interior pixel iterates to maxIter, and
      // shading detail along the boundary is rich. Deeper zooms with
      // small `cx, cy` offsets escape too quickly to dominate the CPU.
      if (path === '/workload/mandelbrot' && req.method === 'POST') {
        const body = (await req.json()) as {
          mode?: 'parallel' | 'sequential' | 'sequential-sample';
          width?: number;
          height?: number;
          maxIter?: number;
          tiles?: number;
          cx?: number;
          cy?: number;
          zoom?: number;
        };
        const width = Math.min(body.width ?? 2048, 4096);
        const height = Math.min(body.height ?? 1536, 4096);
        // maxIter chosen so a worst-case tile (mostly inside the
        // cardioid) stays well under the 30 s per-task cpuMs ceiling.
        // 2048 × 1536 / tiles rows × 2048 cols × 12 000 iters ≈ 5–10 s
        // per tile at tiles=128.
        const maxIter = Math.min(body.maxIter ?? 12000, 100000);
        const tiles = Math.min(body.tiles ?? 128, 512);
        // Full set, modest zoom — interior pixels dominate iteration cost.
        const cx = body.cx ?? -0.5;
        const cy = body.cy ?? 0;
        const zoom = body.zoom ?? 350;
        const mode = body.mode ?? 'parallel';

        // Slice the image into `tiles` horizontal slabs.
        const rowsPerTile = Math.max(1, Math.ceil(height / tiles));
        type TileSpec = {
          idx: number;
          y0: number;
          y1: number;
          width: number;
          height: number;
          maxIter: number;
          cx: number;
          cy: number;
          zoom: number;
        };
        const slabs: TileSpec[] = [];
        for (let i = 0; i < tiles; i++) {
          const y0 = i * rowsPerTile;
          const y1 = Math.min(height, y0 + rowsPerTile);
          if (y0 >= y1) break;
          slabs.push({ idx: i, y0, y1, width, height, maxIter, cx, cy, zoom });
        }

        // Closure-free user fn — all params come from `slab`.
        const renderTile = (slab: TileSpec): { idx: number; y0: number; y1: number; iters: number[] } => {
          const W = slab.width;
          const H = slab.height;
          const M = slab.maxIter;
          const CX = slab.cx;
          const CY = slab.cy;
          const Z = slab.zoom;
          const stepX = 1 / Z;
          const out = new Array<number>((slab.y1 - slab.y0) * W);
          let cursor = 0;
          for (let py = slab.y0; py < slab.y1; py++) {
            const fy = CY + (py - H / 2) * stepX;
            for (let px = 0; px < W; px++) {
              const fx = CX + (px - W / 2) * stepX;
              let zx = 0, zy = 0, zx2 = 0, zy2 = 0;
              let i = 0;
              while (i < M && zx2 + zy2 < 4) {
                zy = 2 * zx * zy + fy;
                zx = zx2 - zy2 + fx;
                zx2 = zx * zx;
                zy2 = zy * zy;
                i++;
              }
              out[cursor++] = i;
            }
          }
          return { idx: slab.idx, y0: slab.y0, y1: slab.y1, iters: out };
        };

        const t0 = Date.now();
        let result: { idx: number; y0: number; y1: number; iters: number[] }[] = [];
        let stats: { topology: string; treeDepth: number; fanOutPerLevel: number[] };
        let perTileSampleMs = 0;
        if (mode === 'sequential') {
          // Run inline. Cap tile count for safety; caller is responsible.
          for (const s of slabs) result.push(renderTile(s));
          stats = { topology: 'sequential', treeDepth: 0, fanOutPerLevel: [] };
        } else if (mode === 'sequential-sample') {
          // Render the MIDDLE tile, measure its time, return as sample.
          // Picking the middle slab is important for Mandelbrot: the
          // first tile covers the image top, which sits outside the set
          // (every pixel escapes in a few iterations), so its CPU is
          // dominated by escape time and dramatically under-represents
          // the average tile cost. The middle tile crosses the cardioid
          // and main bulb where most pixels iterate to maxIter.
          const sampleIdx = Math.floor(slabs.length / 2);
          const sampleSlab = slabs[sampleIdx];
          const ts0 = Date.now();
          const sampleResult = renderTile(sampleSlab);
          perTileSampleMs = Date.now() - ts0;
          result.push(sampleResult);
          stats = { topology: 'sequential-sample', treeDepth: 0, fanOutPerLevel: [] };
        } else {
          result = await pool.map(renderTile, slabs);
          const s = await pool.stats();
          stats = {
            topology: s.topology,
            treeDepth: s.treeDepth,
            fanOutPerLevel: s.fanOutPerLevel,
          };
        }
        const ms = Date.now() - t0;
        result.sort((a, b) => a.idx - b.idx);
        return Response.json({
          mode,
          ms,
          width,
          height,
          maxIter,
          tiles: slabs.length,
          cx,
          cy,
          zoom,
          perTileSampleMs,
          tileResults: result.map((r) => ({ idx: r.idx, y0: r.y0, y1: r.y1, iters: r.iters })),
          topology: stats.topology,
          treeDepth: stats.treeDepth,
          fanOutPerLevel: stats.fanOutPerLevel,
        });
      }

      // B. Monte Carlo π — each task throws N darts, returns hit count.
      if (path === '/workload/montecarlo' && req.method === 'POST') {
        const body = (await req.json()) as {
          mode?: 'parallel' | 'sequential' | 'sequential-sample';
          tasks?: number;
          dartsPerTask?: number;
        };
        const tasks = Math.min(body.tasks ?? 128, 512);
        // 400M darts/task → ~5.5 s on edge CPU. Per-task work has to
        // dominate the dispatch floor by ≥10× to extract the full
        // 4N-isolate parallelism at N=128 (32 leaf DOs × 4 loaders).
        // Integer mul / mod is fast on V8 — empirically 200M darts ≈
        // 2.8 s; 400M lands around 5.5 s. The full sequential mode
        // at N=4 does 4 × 5.5 ≈ 22 s, just under the per-Worker CPU
        // budget; larger sizes use mode='sequential-sample' which runs
        // exactly one task and extrapolates ×N.
        const dartsPerTask = Math.min(body.dartsPerTask ?? 400_000_000, 2_000_000_000);
        const mode = body.mode ?? 'parallel';

        // Closure-free; all params come from the task object.
        type DartTask = { taskId: number; darts: number };
        const throwDarts = (task: DartTask): { taskId: number; inside: number; total: number } => {
          const N = task.darts;
          let s = ((task.taskId + 1) * 2654435761) | 0;
          let inside = 0;
          for (let i = 0; i < N; i++) {
            s = (s * 1103515245 + 12345) | 0;
            const x = ((s >>> 0) / 4294967295) * 2 - 1;
            s = (s * 1103515245 + 12345) | 0;
            const y = ((s >>> 0) / 4294967295) * 2 - 1;
            if (x * x + y * y <= 1) inside++;
          }
          return { taskId: task.taskId, inside, total: N };
        };

        const items: DartTask[] = Array.from({ length: tasks }, (_, i) => ({
          taskId: i,
          darts: dartsPerTask,
        }));

        const t0 = Date.now();
        let results: { taskId: number; inside: number; total: number }[] = [];
        let stats: { topology: string; treeDepth: number; fanOutPerLevel: number[] };
        let perTaskSampleMs = 0;
        if (mode === 'sequential') {
          for (const it of items) results.push(throwDarts(it));
          stats = { topology: 'sequential', treeDepth: 0, fanOutPerLevel: [] };
        } else if (mode === 'sequential-sample') {
          const ts0 = Date.now();
          results.push(throwDarts(items[0]));
          perTaskSampleMs = Date.now() - ts0;
          stats = { topology: 'sequential-sample', treeDepth: 0, fanOutPerLevel: [] };
        } else {
          results = await pool.map(throwDarts, items);
          const s = await pool.stats();
          stats = {
            topology: s.topology,
            treeDepth: s.treeDepth,
            fanOutPerLevel: s.fanOutPerLevel,
          };
        }
        const ms = Date.now() - t0;
        const totalInside = results.reduce((a, r) => a + r.inside, 0);
        const totalDarts = results.reduce((a, r) => a + r.total, 0);
        const piEstimate = totalDarts > 0 ? (4 * totalInside) / totalDarts : 0;

        return Response.json({
          mode,
          ms,
          tasks,
          dartsPerTask,
          perTaskSampleMs,
          totalDarts,
          totalInside,
          piEstimate,
          piError: Math.abs(piEstimate - Math.PI),
          topology: stats.topology,
          treeDepth: stats.treeDepth,
          fanOutPerLevel: stats.fanOutPerLevel,
        });
      }

      // C. Proof-of-Work — find a nonce so SHA-256(prefix || nonce) starts
      // with K zero bits. Each task explores a fixed-size nonce range.
      // Parallel mode uses pool.mapStream + CancelToken to stop the rest
      // as soon as one isolate finds a winner.
      if (path === '/workload/pow' && req.method === 'POST') {
        const body = (await req.json()) as {
          mode?: 'parallel' | 'sequential';
          prefix?: string;
          difficultyBits?: number;
          tasks?: number;
          rangePerTask?: number;
        };
        const prefix = body.prefix ?? `cfp-pow-${Date.now()}`;
        // 22-bit prefix → expected ~4M attempts; 16 tasks × 250k each.
        // Hash is a pure-JS xxhash (synchronous) — `crypto.subtle.digest`
        // is async and adds a microtask per nonce, so a 1M-nonce range
        // would burn the parent Worker's cpuMs budget on awaits alone.
        const difficultyBits = Math.min(body.difficultyBits ?? 22, 28);
        const tasks = Math.min(body.tasks ?? 32, 256);
        const rangePerTask = Math.min(body.rangePerTask ?? 250_000, 2_000_000);
        const mode = body.mode ?? 'parallel';

        type PowTask = { taskId: number; prefix: string; range: number; bits: number };
        // Pure-JS xxhash32 — synchronous, ~1M ops/sec/loader on edge.
        // Closure-free user fn: every constant comes from the task arg.
        const findNonce = (
          t: PowTask,
        ): { taskId: number; found: boolean; nonce: number; hashHex: string } => {
          // xxhash32 mixing primes (PRIME1 unused at this seed; the
          // streaming variant only mixes with PRIME3/PRIME4 internally
          // and PRIME2/PRIME3 on the avalanche, plus PRIME5 in the seed).
          const PRIME2 = 0x85ebca77 | 0;
          const PRIME3 = 0xc2b2ae3d | 0;
          const PRIME4 = 0x27d4eb2f | 0;
          const PRIME5 = 0x165667b1 | 0;
          const SEED = 0x12345678 | 0;
          const enc = new TextEncoder();
          const start = t.taskId * t.range;
          const end = start + t.range;
          const target = (1 << (32 - t.bits)) >>> 0;
          const prefixBytes = enc.encode(t.prefix);
          for (let n = start; n < end; n++) {
            // Build the input bytes: prefix + decimal nonce. Avoid
            // allocating a fresh Uint8Array per call — use a small
            // stack-allocated buffer of bounded size (prefix + 11 digits).
            const len = prefixBytes.length + 11;
            const buf = new Uint8Array(len);
            buf.set(prefixBytes, 0);
            let nv = n;
            let pos = len;
            do {
              buf[--pos] = 48 + (nv % 10);
              nv = Math.floor(nv / 10);
            } while (nv > 0);
            const inLen = len - pos + prefixBytes.length;
            // xxhash32 over buf[0..prefixBytes.length] + buf[pos..len].
            // Simplification: hash directly as a stream over the digits.
            let h = (SEED + PRIME5) | 0;
            h = (h + inLen) | 0;
            // Mix prefix bytes.
            for (let i = 0; i < prefixBytes.length; i++) {
              h = Math.imul(h ^ buf[i], PRIME3);
              h = (((h << 17) | (h >>> 15)) * PRIME4) | 0;
            }
            // Mix digit bytes.
            for (let i = pos; i < len; i++) {
              h = Math.imul(h ^ buf[i], PRIME3);
              h = (((h << 17) | (h >>> 15)) * PRIME4) | 0;
            }
            // Avalanche.
            h = Math.imul(h ^ (h >>> 15), PRIME2);
            h = Math.imul(h ^ (h >>> 13), PRIME3);
            h = (h ^ (h >>> 16)) >>> 0;
            if (h < target) {
              const hex = h.toString(16).padStart(8, '0');
              return { taskId: t.taskId, found: true, nonce: n, hashHex: hex };
            }
          }
          return { taskId: t.taskId, found: false, nonce: -1, hashHex: '' };
        };

        const items: PowTask[] = Array.from({ length: tasks }, (_, i) => ({
          taskId: i,
          prefix,
          range: rangePerTask,
          bits: difficultyBits,
        }));

        const t0 = Date.now();
        let winner: { taskId: number; nonce: number; hashHex: string } | null = null;
        let cancelled = 0;
        let stats: { topology: string; treeDepth: number; fanOutPerLevel: number[] };
        if (mode === 'sequential') {
          for (const it of items) {
            const r = findNonce(it);
            if (r.found) {
              winner = { taskId: r.taskId, nonce: r.nonce, hashHex: r.hashHex };
              break;
            }
          }
          stats = { topology: 'sequential', treeDepth: 0, fanOutPerLevel: [] };
        } else {
          const cancel = new CancelToken();
          try {
            for await (const result of pool.mapStream(findNonce, items, { cancel })) {
              const v = result.value;
              if (v.found) {
                winner = { taskId: v.taskId, nonce: v.nonce, hashHex: v.hashHex };
                cancel.cancel('winner-found');
                break;
              }
            }
          } catch (e) {
            if ((e as Error).name !== 'CancelledError') throw e;
          }
          cancelled = winner ? Math.max(0, tasks - 1) : 0;
          const s = await pool.stats();
          stats = {
            topology: s.topology,
            treeDepth: s.treeDepth,
            fanOutPerLevel: s.fanOutPerLevel,
          };
        }
        const ms = Date.now() - t0;

        return Response.json({
          mode,
          ms,
          difficultyBits,
          tasks,
          rangePerTask,
          totalNonceSpace: tasks * rangePerTask,
          winner,
          cancelledTasksApprox: cancelled,
          topology: stats.topology,
          treeDepth: stats.treeDepth,
          fanOutPerLevel: stats.fanOutPerLevel,
        });
      }

      // D. Genetic algorithm with N-body sim fitness eval.
      if (path === '/workload/ga' && req.method === 'POST') {
        const body = (await req.json()) as {
          mode?: 'parallel' | 'sequential' | 'sequential-sample';
          population?: number;
          fitnessSteps?: number;
          bodies?: number;
        };
        const population = Math.min(body.population ?? 128, 512);
        // 200k-step N-body sim with 24 bodies → ~1.5–2 s / candidate.
        // The pairwise force loop is O(N²) per step; with 24 bodies the
        // inner loop is 276 pair force evaluations per step. The hybrid
        // topology at N=128 splits across 32 leaf DOs × 4 loaders, so
        // ~2 s/candidate amortizes the per-leaf dispatch (50–150 ms)
        // by ~10×, which is what we need to clear the 50× speedup target.
        const fitnessSteps = Math.min(body.fitnessSteps ?? 200_000, 500_000);
        const bodies = Math.min(body.bodies ?? 24, 48);
        const mode = body.mode ?? 'parallel';

        type Candidate = {
          seed: number;
          steps: number;
          bodies: number;
        };
        const evalCandidate = (
          c: Candidate,
        ): {
          seed: number;
          fitness: number;
          stableSteps: number;
          finalKE: number;
          positions: number[][];
        } => {
          const N = c.bodies;
          const STEPS = c.steps;
          const G = 1.0;
          const dt = 0.001;
          let s = ((c.seed + 1) * 2654435761) | 0;
          const rand = (): number => {
            s = (s * 1103515245 + 12345) | 0;
            return (s >>> 0) / 4294967295;
          };
          const x = new Float64Array(N);
          const y = new Float64Array(N);
          const z = new Float64Array(N);
          const vx = new Float64Array(N);
          const vy = new Float64Array(N);
          const vz = new Float64Array(N);
          const m = new Float64Array(N);
          // Initial positions on a tight ball; small initial velocities.
          for (let i = 0; i < N; i++) {
            x[i] = rand() * 2 - 1;
            y[i] = rand() * 2 - 1;
            z[i] = rand() * 2 - 1;
            vx[i] = (rand() - 0.5) * 0.2;
            vy[i] = (rand() - 0.5) * 0.2;
            vz[i] = (rand() - 0.5) * 0.2;
            m[i] = 0.5 + rand();
          }
          const eps2 = 0.05 * 0.05;
          // Bodies that exit the box are damped back, not aborted — we
          // want every candidate to run the full STEPS so per-task work
          // is deterministic. Fitness reflects energy retention.
          const BOX = 200;
          const stable = STEPS;
          const ax = new Float64Array(N);
          const ay = new Float64Array(N);
          const az = new Float64Array(N);
          for (let step = 0; step < STEPS; step++) {
            for (let i = 0; i < N; i++) {
              ax[i] = 0;
              ay[i] = 0;
              az[i] = 0;
            }
            for (let i = 0; i < N; i++) {
              for (let j = i + 1; j < N; j++) {
                const dx = x[j] - x[i];
                const dy = y[j] - y[i];
                const dz = z[j] - z[i];
                const r2 = dx * dx + dy * dy + dz * dz + eps2;
                const invR3 = 1 / (r2 * Math.sqrt(r2));
                const fij = G * invR3;
                const aix = fij * m[j] * dx;
                const aiy = fij * m[j] * dy;
                const aiz = fij * m[j] * dz;
                ax[i] += aix;
                ay[i] += aiy;
                az[i] += aiz;
                ax[j] -= fij * m[i] * dx;
                ay[j] -= fij * m[i] * dy;
                az[j] -= fij * m[i] * dz;
              }
            }
            for (let i = 0; i < N; i++) {
              vx[i] += ax[i] * dt;
              vy[i] += ay[i] * dt;
              vz[i] += az[i] * dt;
              x[i] += vx[i] * dt;
              y[i] += vy[i] * dt;
              z[i] += vz[i] * dt;
              // Reflective boundary — keep the body in-domain so the
              // simulation runs the full STEPS deterministically.
              if (x[i] > BOX) { x[i] = BOX; vx[i] = -vx[i] * 0.5; }
              if (x[i] < -BOX) { x[i] = -BOX; vx[i] = -vx[i] * 0.5; }
              if (y[i] > BOX) { y[i] = BOX; vy[i] = -vy[i] * 0.5; }
              if (y[i] < -BOX) { y[i] = -BOX; vy[i] = -vy[i] * 0.5; }
              if (z[i] > BOX) { z[i] = BOX; vz[i] = -vz[i] * 0.5; }
              if (z[i] < -BOX) { z[i] = -BOX; vz[i] = -vz[i] * 0.5; }
            }
          }
          let ke = 0;
          for (let i = 0; i < N; i++) {
            ke += 0.5 * m[i] * (vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
          }
          const fitness = stable + 1 / (1 + ke);
          return {
            seed: c.seed,
            fitness,
            stableSteps: stable,
            finalKE: ke,
            positions: [
              [x[0], y[0], z[0]],
              [x[1], y[1], z[1]],
              [x[2], y[2], z[2]],
            ],
          };
        };

        const items: Candidate[] = Array.from({ length: population }, (_, i) => ({
          seed: i,
          steps: fitnessSteps,
          bodies,
        }));

        const t0 = Date.now();
        let results: {
          seed: number;
          fitness: number;
          stableSteps: number;
          finalKE: number;
          positions: number[][];
        }[] = [];
        let stats: { topology: string; treeDepth: number; fanOutPerLevel: number[] };
        let perTaskSampleMs = 0;
        if (mode === 'sequential') {
          for (const it of items) results.push(evalCandidate(it));
          stats = { topology: 'sequential', treeDepth: 0, fanOutPerLevel: [] };
        } else if (mode === 'sequential-sample') {
          const ts0 = Date.now();
          results.push(evalCandidate(items[0]));
          perTaskSampleMs = Date.now() - ts0;
          stats = { topology: 'sequential-sample', treeDepth: 0, fanOutPerLevel: [] };
        } else {
          results = await pool.map(evalCandidate, items);
          const s = await pool.stats();
          stats = {
            topology: s.topology,
            treeDepth: s.treeDepth,
            fanOutPerLevel: s.fanOutPerLevel,
          };
        }
        const ms = Date.now() - t0;
        results.sort((a, b) => b.fitness - a.fitness);

        return Response.json({
          mode,
          ms,
          population,
          fitnessSteps,
          bodies,
          perTaskSampleMs,
          best: results.slice(0, 5),
          worst: results.slice(-3),
          avgFitness: results.reduce((a, r) => a + r.fitness, 0) / Math.max(1, results.length),
          topology: stats.topology,
          treeDepth: stats.treeDepth,
          fanOutPerLevel: stats.fanOutPerLevel,
        });
      }

      // ---- Demo-specific endpoints ----

      // Mandelbrot escape-time, fanned out one isolate per row.
      // Returns rows[].iters as Uint8 (`out: number[][]`) + topology.
      if (path === '/demo/mandelbrot' && req.method === 'POST') {
        const body = (await req.json()) as {
          width?: number;
          height?: number;
          maxIter?: number;
          cx?: number;
          cy?: number;
          zoom?: number;
        };
        const width = Math.min(body.width ?? 320, 640);
        const height = Math.min(body.height ?? 192, 384);
        const maxIter = Math.min(body.maxIter ?? 512, 4096);
        const cx = body.cx ?? -0.5;
        const cy = body.cy ?? 0;
        const zoom = body.zoom ?? 200;

        const rows = Array.from({ length: height }, (_, y) => y);
        const t0 = Date.now();
        const out = await pool.map((y: number) => {
          // Closure-free: re-derive constants from y. Width / height /
          // maxIter / cx / cy / zoom are baked in below — `y` is the
          // only varying input.
          const W = 640, H = 384, M = 4096, CX = -0.5, CY = 0, Z = 200;
          // Trim to actual size at the end.
          const row = new Array<number>(W).fill(0);
          for (let x = 0; x < W; x++) {
            const fx = (x - W / 2) / Z + CX;
            const fy = (y - H / 2) / Z + CY;
            let zx = 0, zy = 0;
            let i = 0;
            while (i < M && zx * zx + zy * zy < 4) {
              const t = zx * zx - zy * zy + fx;
              zy = 2 * zx * zy + fy;
              zx = t;
              i++;
            }
            row[x] = i & 255;
          }
          return row;
        }, rows);
        // Trim each row to width, only return as many rows as height.
        const trimmed = out.slice(0, height).map((r) => r.slice(0, width));
        const stats = await pool.stats();
        return Response.json({
          width,
          height,
          maxIter,
          cx,
          cy,
          zoom,
          ms: Date.now() - t0,
          rows: trimmed,
          topology: stats.topology,
          treeDepth: stats.treeDepth,
          fanOutPerLevel: stats.fanOutPerLevel,
        });
      }

      // SHA-256-chain bench at a given size. Returns parallel timings
      // measured on the worker side. Sequential is intentionally NOT
      // measured here — Date.now() in the Workers runtime is throttled to coarse
      // resolution (timing-attack mitigation), so a same-isolate
      // sequential SHA loop reports 0ms even when it takes 100ms+ wall.
      // The demo's bench panel measures the sequential side via a
      // separate /bench/sequential request and computes speedup
      // client-side, where the timer is honest.
      if (path === '/demo/bench' && req.method === 'POST') {
        const body = (await req.json()) as { size?: number };
        const size = Math.min(body.size ?? 64, 512);
        const items = Array.from({ length: size }, (_, i) => i + 1);
        const t0 = Date.now();
        await pool.map(async (n: number) => {
          const enc = new TextEncoder();
          let buf = enc.encode(`seed-${n}`.repeat(64));
          for (let i = 0; i < 5000; i++) {
            buf = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
          }
          return buf[0];
        }, items);
        const parMs = Date.now() - t0;
        const stats = await pool.stats();
        return Response.json({
          size,
          parallelMs: parMs,
          topology: stats.topology,
          treeDepth: stats.treeDepth,
          fanOutPerLevel: stats.fanOutPerLevel,
        });
      }

      // Cancel showcase: 1M-iteration SHA chain. Streams progress as SSE.
      // Hit /demo/cancel-start to begin (returns SSE), close the EventSource
      // to cancel — the in-progress chain observes env.signal.aborted.
      if (path === '/demo/cancel-start' && req.method === 'POST') {
        const body = (await req.json()) as { iters?: number };
        const iters = Math.min(body.iters ?? 1_000_000, 5_000_000);

        const cancel = new CancelToken();
        // Pipe the cancel-on-abort.
        const reqAbort = req.signal;
        if (reqAbort) {
          if (reqAbort.aborted) cancel.cancel('client disconnected');
          else reqAbort.addEventListener(
            'abort',
            () => cancel.cancel('client disconnected'),
            { once: true },
          );
        }

        const stream = new TransformStream<Uint8Array, Uint8Array>();
        const writer = stream.writable.getWriter();
        const enc = new TextEncoder();

        // Run the long task in the background; stream progress.
        ctx.waitUntil(
          (async () => {
            try {
              const result = await pool.submit(
                async (target: number, env: { signal: AbortSignal }) => {
                  let buf = new TextEncoder().encode('seed');
                  let lastReport = 0;
                  const reports: number[] = [];
                  for (let i = 0; i < target; i++) {
                    if (env.signal.aborted) {
                      return { cancelled: true, atIteration: i, totalTarget: target, reports };
                    }
                    if (i % 50 === 0) {
                      // Hash 50x for a unit of work that yields back to the
                      // event loop frequently enough for cancel polling.
                      buf = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
                    }
                    if (i - lastReport >= Math.max(1000, Math.floor(target / 50))) {
                      reports.push(i);
                      lastReport = i;
                    }
                  }
                  return { cancelled: false, atIteration: target, totalTarget: target, reports };
                },
                iters,
                { cancel },
              );
              await writer.write(
                enc.encode(
                  `data: ${JSON.stringify({ kind: 'done', ...result })}\n\n`,
                ),
              );
            } catch (e) {
              await writer.write(
                enc.encode(
                  `data: ${JSON.stringify({
                    kind: 'error',
                    name: (e as Error).name,
                    message: (e as Error).message,
                  })}\n\n`,
                ),
              );
            } finally {
              try {
                await writer.close();
              } catch {
                /* ignore */
              }
            }
          })(),
        );

        return new Response(stream.readable, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no',
          },
        });
      }

      // Scheduler dashboard: enqueue N jobs, poll stats.
      if (path === '/demo/scheduler-burst' && req.method === 'POST') {
        const body = (await req.json()) as { tenant?: string; count?: number };
        const tenant = body.tenant ?? `demo-${Date.now()}`;
        const count = Math.min(body.count ?? 64, 1024);
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const handle = await scheduler.enqueue<[number], number>({
            fn: (n: number) => {
              // Cheap CPU work per job; enough to saturate ~50 concurrent.
              let x = (n + 1) | 0;
              for (let j = 0; j < 1_000_000; j++) {
                x = ((x * 1103515245 + 12345) | 0) >>> 0;
              }
              return x;
            },
            args: [i],
            tenantId: tenant,
            deadlineMs: 30_000,
            idempotencyKey: `${tenant}-${i}`,
          });
          ids.push(handle.id);
        }
        const stats = await scheduler.stats();
        return Response.json({ tenant, count, sampleIds: ids.slice(0, 5), stats });
      }

      // ---- Error round-trips ----
      if (path === '/errors/timeout') {
        try {
          await pool.submit(
            async () => {
              await new Promise((r) => setTimeout(r, 5_000));
              return 'done';
            },
            { timeout: 200 },
          );
          return Response.json({ error: 'should-have-thrown' }, { status: 500 });
        } catch (e) {
          const err = e as Error & { code?: string };
          return Response.json({
            name: err.name,
            code: err.code,
            message: err.message,
          });
        }
      }

      // ---- Bench helpers ----
      if (path === '/bench/sequential' && req.method === 'POST') {
        // CPU-bound work using SHA-256 over a growing buffer — roughly
        // 80-150ms per item on the Workers runtime CPU. the Workers runtime implements
        // `crypto.subtle.digest` synchronously in C++; the JS wrapper
        // returns a microtask-resolved Promise. The size grows each
        // iteration so the work is non-trivial.
        const { items } = (await req.json()) as { items: number[] };
        const t0 = Date.now();
        const out: number[] = [];
        const enc = new TextEncoder();
        for (const n of items) {
          let buf = enc.encode(`seed-${n}`.repeat(64));
          for (let i = 0; i < 5000; i++) {
            buf = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
          }
          out.push(buf[0]);
        }
        return Response.json({ out, ms: Date.now() - t0 });
      }

      if (path === '/bench/parallel-map' && req.method === 'POST') {
        // Same SHA-256 chain via pool.map (one isolate per item up to topology cap).
        const { items } = (await req.json()) as { items: number[] };
        const t0 = Date.now();
        const out = await pool.map(async (n: number) => {
          const enc = new TextEncoder();
          let buf = enc.encode(`seed-${n}`.repeat(64));
          for (let i = 0; i < 5000; i++) {
            buf = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
          }
          return buf[0];
        }, items);
        const stats = await pool.stats();
        return Response.json({
          out,
          ms: Date.now() - t0,
          topology: stats.topology,
          fanOutPerLevel: stats.fanOutPerLevel,
          treeDepth: stats.treeDepth,
        });
      }

      if (path === '/errors/aggregate') {
        try {
          await pool.map(
            (n: number) => {
              if (n === 2 || n === 3) throw new Error(`fail-${n}`);
              return n * 2;
            },
            [1, 2, 3, 4],
          );
          return Response.json({ error: 'should-have-thrown' }, { status: 500 });
        } catch (e) {
          const err = e as Error & { code?: string; errors?: Map<number, unknown> };
          return Response.json({
            name: err.name,
            code: err.code,
            errorCount: err.errors instanceof Map ? err.errors.size : undefined,
          });
        }
      }

      return Response.json({ error: 'not-found', path }, { status: 404 });
    } catch (e) {
      return Response.json(
        { error: (e as Error).name, message: (e as Error).message },
        { status: 500 },
      );
    }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const res = await handle(req, env, ctx);
    return withCors(res);
  },
};
