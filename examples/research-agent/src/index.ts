import { Parallel, type WorkerLoader } from 'cloudflare-parallel';

interface Env {
  LOADER: WorkerLoader;
  AI: Ai;
}

interface SourceSpec {
  name: string;
  endpoint: string;
  type: string;
}

interface SourceResult {
  source: string;
  content: string;
  summary: string;
  durationMs: number;
}

interface ResearchBrief {
  query: string;
  sources: SourceResult[];
  synthesis: string;
  totalDurationMs: number;
}

const SOURCES: SourceSpec[] = [
  {
    name: 'Wikipedia',
    endpoint: 'https://en.wikipedia.org/api/rest_v1/page/summary/',
    type: 'wikipedia',
  },
  {
    name: 'Hacker News',
    endpoint: 'https://hn.algolia.com/api/v1/search?query=',
    type: 'hackernews',
  },
  {
    name: 'Reddit',
    endpoint: 'https://www.reddit.com/search.json?limit=5&q=',
    type: 'reddit',
  },
  {
    name: 'arXiv',
    endpoint: 'https://export.arxiv.org/api/query?max_results=3&search_query=all:',
    type: 'arxiv',
  },
];

const researchFn = async (
  spec: SourceSpec,
  env: { AI: Ai },
): Promise<SourceResult> => {
  const t0 = Date.now();

  const resp = await fetch(spec.endpoint + encodeURIComponent(query));
  const raw = await resp.text();

  let content: string;
  if (spec.type === 'wikipedia') {
    const data = JSON.parse(raw);
    content = data.extract || data.description || 'No content found.';
  } else if (spec.type === 'hackernews') {
    const data = JSON.parse(raw);
    content = (data.hits || [])
      .slice(0, 5)
      .map((h: Record<string, unknown>) =>
        `${h.title} (${h.points ?? 0} pts) ${h.url ?? ''}`,
      )
      .join('\n');
  } else if (spec.type === 'reddit') {
    const data = JSON.parse(raw);
    content = ((data?.data?.children as Record<string, unknown>[]) || [])
      .slice(0, 5)
      .map((p: Record<string, unknown>) => {
        const d = p.data as Record<string, unknown>;
        return `${d.title} (score: ${d.score}) ${String(d.selftext || '').slice(0, 200)}`;
      })
      .join('\n');
  } else if (spec.type === 'arxiv') {
    content = raw
      .split('<entry>')
      .slice(1)
      .map((e: string) => {
        const title = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || '';
        const summary = e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '';
        return `${title}: ${summary.slice(0, 300)}`;
      })
      .join('\n');
  } else {
    content = raw.slice(0, 1000);
  }

  if (!content.trim()) content = 'No relevant content found.';

  const aiResult = await env.AI.run(
    '@cf/meta/llama-3.1-8b-instruct' as BaseAiTextGenerationModels,
    {
      messages: [
        {
          role: 'system',
          content:
            'Summarize the following content in 2-3 concise sentences. Be factual.',
        },
        {
          role: 'user',
          content: `Source: ${spec.name}\nQuery: "${query}"\n\nContent:\n${content.slice(0, 2000)}`,
        },
      ],
      max_tokens: 256,
    },
  );

  const summary =
    typeof aiResult === 'object' && aiResult !== null && 'response' in aiResult
      ? String((aiResult as Record<string, unknown>).response)
      : String(aiResult);

  return {
    source: spec.name,
    content: content.slice(0, 500),
    summary: summary || 'No summary generated.',
    durationMs: Date.now() - t0,
  };
};

const synthesizeFn = async (a: string, b: string, env: { AI: Ai }): Promise<string> => {
  const aiResult = await env.AI.run(
    '@cf/meta/llama-3.1-8b-instruct' as BaseAiTextGenerationModels,
    {
      messages: [
        {
          role: 'system',
          content:
            'Merge these two research summaries into one coherent paragraph. Preserve key facts from both.',
        },
        { role: 'user', content: `Summary A:\n${a}\n\nSummary B:\n${b}` },
      ],
      max_tokens: 512,
    },
  );

  return typeof aiResult === 'object' && aiResult !== null && 'response' in aiResult
    ? String((aiResult as Record<string, unknown>).response)
    : String(aiResult);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({
        usage: 'POST { "query": "your research topic", "stream": false }',
      });
    }

    const body = await request.json<{ query: string; stream?: boolean }>();
    const query = body.query?.trim();
    if (!query) {
      return Response.json({ error: 'query is required' }, { status: 400 });
    }

    const pool = Parallel.pool(env.LOADER, {
      bindings: { AI: env.AI },
      workerOptions: { globalOutbound: undefined },
      timeout: 30_000,
      retries: 1,
    });

    const start = Date.now();

    if (body.stream) {
      return streamResults(pool, query, start);
    }

    const results = await pool.map(researchFn, SOURCES, {
      onError: 'null',
      context: { query },
    });

    const sources = (results as (SourceResult | null)[]).filter(
      (r): r is SourceResult => r !== null,
    );

    const synthesis = await buildSynthesis(pool, query, sources);

    return Response.json({
      query,
      sources,
      synthesis,
      totalDurationMs: Date.now() - start,
    } satisfies ResearchBrief);
  },
};

async function streamResults(
  pool: ReturnType<typeof Parallel.pool>,
  query: string,
  start: number,
): Promise<Response> {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    const sources: SourceResult[] = [];

    for await (const { index, value } of pool.mapStream(researchFn, SOURCES, {
      context: { query },
    })) {
      sources.push(value);
      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({ type: 'source', index, result: value })}\n\n`,
        ),
      );
    }

    const synthesis = await buildSynthesis(pool, query, sources);

    await writer.write(
      encoder.encode(
        `data: ${JSON.stringify({
          type: 'brief',
          synthesis,
          totalDurationMs: Date.now() - start,
        })}\n\n`,
      ),
    );
    await writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
  })();

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}

async function buildSynthesis(
  pool: ReturnType<typeof Parallel.pool>,
  query: string,
  sources: SourceResult[],
): Promise<string> {
  if (sources.length === 0) return 'No sources returned usable results.';
  if (sources.length === 1) return sources[0].summary;

  return pool.reduce(
    synthesizeFn,
    sources.map((s) => s.summary),
    `Research synthesis for: "${query}".`,
  );
}
