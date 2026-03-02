/**
 * AI Fanout Example — Parallel AI Inference with cloudflare-parallel
 *
 * Takes a prompt, fans it out to multiple AI models via the Workers AI
 * binding, and returns all responses. Demonstrates binding passthrough
 * (forwarding env.AI to dynamic isolates), context capture, and timeouts.
 *
 * Usage:
 *   curl http://localhost:8787 -d '{"prompt": "Explain quantum computing in one sentence"}'
 *   curl http://localhost:8787/compare?prompt=What+is+Rust
 */

import { Parallel } from "cloudflare-parallel";
import type { WorkerLoader } from "cloudflare-parallel";

// ── Types ─────────────────────────────────────────────────────────────

export interface Env {
  LOADER: WorkerLoader;
  AI: Ai;
}

interface ModelResult {
  model: string;
  response: string;
  durationMs: number;
}

interface FanoutResponse {
  prompt: string;
  results: ModelResult[];
  totalMs: number;
  errors?: string[];
}

// Models to fan out to — all available on Workers AI
const MODELS = [
  "@cf/meta/llama-3-8b-instruct",
  "@cf/mistral/mistral-7b-instruct-v0.1",
  "@cf/google/gemma-7b-it",
] as const;

// ── Worker ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Create a pool with the AI binding forwarded to dynamic isolates
    const pool = Parallel.pool(env.LOADER, {
      bindings: { AI: env.AI },
      timeout: 30_000,
      retries: 1,
    });

    try {
      if (url.pathname === "/compare" && request.method === "GET") {
        return handleCompare(pool, url);
      }
      if (request.method === "POST") {
        return handleFanout(pool, request);
      }
      return new Response(USAGE_TEXT, {
        headers: { "content-type": "text/plain" },
      });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
};

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * POST / — Fan out a prompt to all models in parallel.
 *
 * Each model runs in its own isolate via pool.map(), with the AI
 * binding available as `env.AI` inside the dynamic worker.
 */
async function handleFanout(pool: any, request: Request): Promise<Response> {
  const body = (await request.json()) as { prompt?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) {
    return Response.json({ error: "Missing 'prompt' in request body" }, { status: 400 });
  }

  const start = Date.now();
  const errors: string[] = [];

  // Fan out: one isolate per model, all running in parallel.
  // Each function receives the model name as an argument and env.AI
  // is available via binding passthrough.
  const results = await pool.map(
    async (model: string, env: { AI: Ai }) => {
      const t0 = Date.now();
      const result = await env.AI.run(model as BaseAiTextGenerationModels, {
        messages: [{ role: "user", content: prompt }],
      });
      return {
        model,
        response: (result as { response: string }).response,
        durationMs: Date.now() - t0,
      } satisfies ModelResult;
    },
    [...MODELS],
    {
      context: { prompt },
      onError: "null" as const,
    },
  );

  // Separate successes from failures
  const successResults: ModelResult[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) {
      errors.push(`${MODELS[i]}: inference failed`);
    } else {
      successResults.push(results[i] as ModelResult);
    }
  }

  const response: FanoutResponse = {
    prompt,
    results: successResults,
    totalMs: Date.now() - start,
    ...(errors.length > 0 ? { errors } : {}),
  };

  return Response.json(response, {
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /compare?prompt=... — Quick comparison via query param.
 *
 * Uses pool.scatter to split models into individual chunks, then
 * runs each in a separate isolate.
 */
async function handleCompare(pool: any, url: URL): Promise<Response> {
  const prompt = url.searchParams.get("prompt")?.trim();
  if (!prompt) {
    return Response.json(
      { error: "Missing 'prompt' query parameter" },
      { status: 400 },
    );
  }

  const start = Date.now();

  // Use submit for each model — demonstrates individual task dispatch
  // with binding passthrough and per-call context capture.
  const tasks = MODELS.map((model) =>
    pool.submit(
      async (modelName: string, env: { AI: Ai }) => {
        const t0 = Date.now();
        const result = await env.AI.run(modelName as BaseAiTextGenerationModels, {
          messages: [{ role: "user", content: prompt }],
        });
        return {
          model: modelName,
          response: (result as { response: string }).response,
          durationMs: Date.now() - t0,
        };
      },
      model,
      { context: { prompt }, timeout: 30_000 },
    ),
  );

  const results = await pool.gather(tasks);

  return Response.json({
    prompt,
    results,
    totalMs: Date.now() - start,
  });
}

// ── Usage ─────────────────────────────────────────────────────────────

const USAGE_TEXT = `AI Fanout — Parallel AI Inference with cloudflare-parallel

Endpoints:
  POST /              Fan out a prompt to multiple AI models
                      Body: { "prompt": "your question here" }

  GET  /compare?prompt=...  Quick comparison via query param

Example:
  curl http://localhost:8787 \\
    -H "Content-Type: application/json" \\
    -d '{"prompt": "Explain quantum computing in one sentence"}'
`;
