/**
 * Heterogeneous job scheduler example.
 *
 * Demonstrates `Parallel.scheduler`: enqueue jobs from a fetch handler,
 * await their results via `JobHandle.result()` (long-poll-based), and
 * inspect status / cancel by tenant.
 *
 * User fns submitted to the scheduler MUST be idempotent — the library
 * guarantees at-most-once result observability + at-least-once execution.
 */

import { Parallel, type WorkerLoader } from 'cloudflare-parallel';

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
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const scheduler = Parallel.scheduler(env, {
      id: 'demo-jobs',
      retry: { max: 3, backoff: 'exponential', baseMs: 200 },
      deadline: { defaultMs: 60_000 },
      resultRetention: { ttlMs: 3_600_000 },
    });

    if (url.pathname === '/enqueue' && req.method === 'POST') {
      const body = await req.json<{ tenant: string; n: number; idemKey?: string }>();
      const handle = await scheduler.enqueue<[number], number>({
        fn: (n) => Array.from({ length: n }, (_, i) => i).reduce((a, b) => a + b, 0),
        args: [body.n],
        tenantId: body.tenant,
        deadlineMs: 30_000,
        idempotencyKey: body.idemKey,
      });
      return Response.json({ jobId: handle.id });
    }

    if (url.pathname === '/result') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('?id= required', { status: 400 });
      // Build a synthetic handle on the scheduler stub. We re-derive it
      // here because handles aren't serializable across requests; production
      // code typically polls /result and lets the scheduler do the work.
      try {
        const status = await new (class {
          async go(): Promise<{ status: string; value?: unknown }> {
            const stub = env.CfpSchedulerDO.get(env.CfpSchedulerDO.idFromName('demo-jobs'));

            return (
              stub as unknown as {
                result(jobId: string): Promise<{ status: string; value?: unknown }>;
              }
            ).result(id);
          }
        })().go();
        return Response.json(status);
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    }

    if (url.pathname === '/stats') {
      return Response.json(await scheduler.stats());
    }

    if (url.pathname === '/cancel-tenant' && req.method === 'POST') {
      const body = await req.json<{ tenant: string }>();
      const cancelled = await scheduler.cancelByTenant(body.tenant, 'admin requested');
      return Response.json({ cancelled });
    }

    return Response.json({
      usage: {
        'POST /enqueue': '{ "tenant": "t-1", "n": 1000, "idemKey": "optional" }',
        'GET /result?id=...': 'long-poll for a job result',
        'GET /stats': 'scheduler stats',
        'POST /cancel-tenant': '{ "tenant": "t-1" }',
      },
    });
  },
};
