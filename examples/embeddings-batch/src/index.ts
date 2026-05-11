/**
 * embeddings-batch — CPU-bound vector embedding over thousands of docs.
 *
 * Each document is hashed into a fixed-length vector via a deterministic
 * feature-hashing scheme (no real model — pure CPU work that mirrors the
 * shape of an embedding pass). Then we compute cosine similarity to a
 * query vector and return the top-K most similar.
 *
 * The `embed` step is the CPU-heavy part: ~1-3ms per doc on the Workers runtime.
 * Single-threaded JS would serialize all N docs behind the event loop.
 * `pool.map` runs them across N parallel V8 isolates.
 *
 * Try it:
 *   curl -X POST localhost:8787/?n=512 -d '{"query":"cloudflare workers"}'
 */
import { Parallel, type WorkerLoader } from 'cloudflare-parallel';

export {
  CfpCoordinator,
  CfpWorkerDO,
  CfpSubCoord,
  CfpInProcessCoordinator,
} from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

interface CtxWithExports extends ExecutionContext {
  exports?: { CfpInProcessCoordinator?: unknown };
}

// Synthetic corpus: deterministic per-id text. Production would read
// from D1 / R2 / KV — but those are I/O, not the demo's point.
function corpusDoc(id: number): string {
  const tags = ['cloudflare', 'workers', 'durable-objects', 'rpc', 'isolates', 'parallel', 'edge'];
  const verbs = [
    'scales',
    'composes',
    'fans-out',
    'parallelizes',
    'runs',
    'dispatches',
    'executes',
  ];
  const nouns = ['compute', 'work', 'tasks', 'jobs', 'requests', 'isolates', 'tenants'];
  const i = id;
  return [
    `Document ${id}: ${tags[i % tags.length]} ${verbs[i % verbs.length]} ${nouns[i % nouns.length]}.`,
    `Sub-topic ${i % 13}: feature-hashed corpus entry. ${tags[(i * 7) % tags.length]}.`,
    `Filler ${'x'.repeat((i * 17) % 64)}.`,
  ].join(' ');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/' && url.pathname !== '/embed') {
      return Response.json(
        {
          usage: {
            'POST /?n=<count>':
              '{ query: "..." } — embed N docs in parallel + top-K cosine similarity',
          },
        },
        { status: 200 },
      );
    }

    const n = Math.min(Number(url.searchParams.get('n') ?? 64), 1024);
    const k = Math.min(Number(url.searchParams.get('k') ?? 5), 50);
    const body =
      req.method === 'POST' ? ((await req.json().catch(() => ({}))) as { query?: string }) : {};
    const query = body.query ?? 'cloudflare workers';

    const pool = Parallel.pool(env, {
      // Skip the DO hop for size-≤4 fan-outs (e.g. the query embed below).
      inProcess: (ctx as CtxWithExports).exports?.CfpInProcessCoordinator as
        | NonNullable<Parameters<typeof Parallel.pool>[1]>['inProcess']
        | undefined,
      // Colocate freshly-created leaf DOs with this colo.
      requestColo: (req as Request & { cf?: { colo?: string } }).cf?.colo,
    });

    const t0 = Date.now();

    // ① Build the doc list (cheap; just numeric IDs).
    const docs = Array.from({ length: n }, (_, i) => i);

    // ② Embed N docs in parallel. Each isolate hashes its own doc text
    //    into a 256-dim vector. Pure CPU. The `embed` user fn closes
    //    over no host state — it gets the doc id and returns the vector.
    const vectors = await pool.map((id: number) => {
      // Feature-hashing into a 256-dim float vector. ~1-3ms per doc.
      const dims = 256;
      const vec = new Array<number>(dims).fill(0);
      const tags = [
        'cloudflare',
        'workers',
        'durable-objects',
        'rpc',
        'isolates',
        'parallel',
        'edge',
      ];
      const verbs = [
        'scales',
        'composes',
        'fans-out',
        'parallelizes',
        'runs',
        'dispatches',
        'executes',
      ];
      const nouns = ['compute', 'work', 'tasks', 'jobs', 'requests', 'isolates', 'tenants'];
      const text = [
        `Document ${id}: ${tags[id % tags.length]} ${verbs[id % verbs.length]} ${nouns[id % nouns.length]}.`,
        `Sub-topic ${id % 13}: feature-hashed corpus entry. ${tags[(id * 7) % tags.length]}.`,
        `Filler ${'x'.repeat((id * 17) % 64)}.`,
      ].join(' ');
      const tokens = text.toLowerCase().split(/\s+/);
      // djb2 hash + mod into vector slots, weighted by token-length.
      for (const tok of tokens) {
        let h = 5381;
        for (let i = 0; i < tok.length; i++) h = ((h << 5) + h + tok.charCodeAt(i)) | 0;
        const slot = ((h | 0) >>> 0) % dims;
        vec[slot] += 1 + tok.length / 8;
      }
      // Tighten the embedding: 64 SHA-mixing passes (CPU-amplifier).
      for (let pass = 0; pass < 64; pass++) {
        for (let i = 0; i < dims; i++) {
          const j = (i * 1103515245 + 12345 + pass) % dims;
          const a = vec[i];
          const b = vec[j];
          vec[i] = a + b * 0.5;
          vec[j] = b + a * 0.25;
        }
      }
      // L2-normalize.
      let norm = 0;
      for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dims; i++) vec[i] /= norm;
      return { id, vec };
    }, docs);
    const tEmbed = Date.now() - t0;

    // ③ Embed the query (single-shot; no need to fan out).
    const queryVec = await pool.submit((q: string) => {
      const dims = 256;
      const vec = new Array<number>(dims).fill(0);
      const tokens = q.toLowerCase().split(/\s+/);
      for (const tok of tokens) {
        let h = 5381;
        for (let i = 0; i < tok.length; i++) h = ((h << 5) + h + tok.charCodeAt(i)) | 0;
        const slot = ((h | 0) >>> 0) % dims;
        vec[slot] += 1 + tok.length / 8;
      }
      for (let pass = 0; pass < 64; pass++) {
        for (let i = 0; i < dims; i++) {
          const j = (i * 1103515245 + 12345 + pass) % dims;
          const a = vec[i];
          const b = vec[j];
          vec[i] = a + b * 0.5;
          vec[j] = b + a * 0.25;
        }
      }
      let norm = 0;
      for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dims; i++) vec[i] /= norm;
      return vec;
    }, query);

    // ④ Cosine similarity is cheap (one dot product per doc) — do it
    //    locally rather than pay another fan-out RPC.
    const scored = vectors
      .map(({ id, vec }) => {
        let dot = 0;
        for (let i = 0; i < vec.length; i++) dot += vec[i] * queryVec[i];
        return { id, similarity: dot };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);

    const stats = await pool.stats();

    return Response.json({
      query,
      n,
      k,
      topK: scored.map((s) => ({
        id: s.id,
        similarity: +s.similarity.toFixed(4),
        snippet: corpusDoc(s.id).slice(0, 100),
      })),
      timing: {
        totalMs: Date.now() - t0,
        embedMs: tEmbed,
      },
      topology: {
        decision: stats.topology,
        treeDepth: stats.treeDepth,
        fanOutPerLevel: stats.fanOutPerLevel,
      },
    });
  },
};
