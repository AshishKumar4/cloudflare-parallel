/**
 * Test Worker for live prod E2E. Exposes one HTTP route per
 * library primitive so the test runner can exercise every surface
 * end-to-end against a real workerd runtime via `wrangler dev --local`.
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

      const pool = Parallel.pool(env);

      // ---- Pool primitives ----
      if (path === '/pool/submit' && req.method === 'POST') {
        const { fn, args } = (await req.json()) as { fn: string; args: unknown[] };
        // workerd disables `eval` in the parent Worker — use the
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
      // measured here — Date.now() in workerd is throttled to coarse
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
        // 80-150ms per item on workerd CPU. workerd implements
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
