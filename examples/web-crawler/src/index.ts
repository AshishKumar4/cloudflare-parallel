import { Parallel, type WorkerLoader } from 'cloudflare-parallel';

interface Env {
  LOADER: WorkerLoader;
}

interface CrawlRequest {
  url: string;
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
}

interface PageResult {
  url: string;
  title: string;
  contentSnippet: string;
  links: string[];
  status: number;
  durationMs: number;
}

interface SiteMap {
  seed: string;
  pages: Record<string, { title: string; content: string; depth: number; status: number }>;
  edges: Array<[string, string]>;
  stats: {
    totalPages: number;
    maxDepthReached: number;
    totalDurationMs: number;
    pagesPerDepth: Record<number, number>;
  };
}

// Runs in a fresh isolate: fetches a single URL, extracts text content and links.
// Completely self-contained — no closures, no imports beyond web globals.
const crawlPageFn = async (url: string): Promise<PageResult> => {
  const t0 = Date.now();

  let status: number;
  let html: string;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'cloudflare-parallel-crawler/1.0' },
      redirect: 'follow',
    });
    status = resp.status;
    html = await resp.text();
  } catch {
    return {
      url,
      title: '',
      contentSnippet: '',
      links: [],
      status: 0,
      durationMs: Date.now() - t0,
    };
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim().replace(/\s+/g, ' ').slice(0, 200) || '';

  // Strip tags to get text content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] || html;
  const text = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract href links from anchor tags
  const linkRegex = /href="(https?:\/\/[^"]+)"/gi;
  const links: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    try {
      const parsed = new URL(match[1]);
      parsed.hash = '';
      const normalized = parsed.href;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        links.push(normalized);
      }
    } catch {
      // skip malformed URLs
    }
  }

  return {
    url,
    title,
    contentSnippet: text.slice(0, 500),
    links: links.slice(0, 50),
    status,
    durationMs: Date.now() - t0,
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({
        usage: 'POST { "url": "https://example.com", "maxDepth": 2, "maxPages": 20, "concurrency": 10 }',
      });
    }

    const body = await request.json<CrawlRequest>();
    const seedUrl = body.url?.trim();
    if (!seedUrl) {
      return Response.json({ error: 'url is required' }, { status: 400 });
    }

    try {
      new URL(seedUrl);
    } catch {
      return Response.json({ error: 'invalid url' }, { status: 400 });
    }

    const maxDepth = Math.min(body.maxDepth ?? 2, 5);
    const maxPages = Math.min(body.maxPages ?? 30, 100);
    const concurrency = Math.min(body.concurrency ?? 10, 25);

    const pool = Parallel.pool(env.LOADER, {
      workerOptions: { globalOutbound: undefined },
      timeout: 15_000,
      retries: 1,
    });

    const start = Date.now();
    const siteMap = await crawl(pool, seedUrl, maxDepth, maxPages, concurrency);
    siteMap.stats.totalDurationMs = Date.now() - start;

    return Response.json(siteMap);
  },
};

async function crawl(
  pool: ReturnType<typeof Parallel.pool>,
  seedUrl: string,
  maxDepth: number,
  maxPages: number,
  concurrency: number,
): Promise<SiteMap> {
  const pages: SiteMap['pages'] = {};
  const edges: SiteMap['edges'] = [];
  const visited = new Set<string>();
  const pagesPerDepth: Record<number, number> = {};

  let frontier: string[] = [seedUrl];
  let currentDepth = 0;

  while (frontier.length > 0 && currentDepth <= maxDepth && visited.size < maxPages) {
    const budget = maxPages - visited.size;
    const batch = frontier.slice(0, budget);

    const results = await pool.map(crawlPageFn, batch, {
      concurrency,
      onError: 'null',
    });

    const nextFrontier: string[] = [];
    pagesPerDepth[currentDepth] = 0;

    for (let i = 0; i < batch.length; i++) {
      const result = (results as (PageResult | null)[])[i];
      if (!result) continue;

      visited.add(result.url);
      pagesPerDepth[currentDepth]++;

      pages[result.url] = {
        title: result.title,
        content: result.contentSnippet,
        depth: currentDepth,
        status: result.status,
      };

      const seedOrigin = new URL(seedUrl).origin;
      for (const link of result.links) {
        edges.push([result.url, link]);

        try {
          const linkOrigin = new URL(link).origin;
          if (linkOrigin === seedOrigin && !visited.has(link)) {
            nextFrontier.push(link);
          }
        } catch {
          // skip
        }
      }
    }

    // Deduplicate next frontier against already-visited and within itself
    const nextSet = new Set<string>();
    frontier = [];
    for (const link of nextFrontier) {
      if (!visited.has(link) && !nextSet.has(link)) {
        nextSet.add(link);
        frontier.push(link);
      }
    }

    currentDepth++;
  }

  return {
    seed: seedUrl,
    pages,
    edges,
    stats: {
      totalPages: visited.size,
      maxDepthReached: currentDepth - 1,
      totalDurationMs: 0,
      pagesPerDepth,
    },
  };
}
