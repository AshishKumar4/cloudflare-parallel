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
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
  },
};
