import { Parallel } from "cloudflare-parallel";
import type { WorkerLoader } from "cloudflare-parallel";

export interface Env {
  LOADER: WorkerLoader;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pool = Parallel.pool(env.LOADER);
    const results: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    // ── 1. submit ─────────────────────────────────────────────────
    try {
      const squared = await pool.submit((x: number) => x * x, 42);
      results.submit = { input: 42, output: squared, expected: 1764 };
    } catch (e: unknown) {
      errors.submit = e instanceof Error ? e.message : String(e);
    }

    // ── 2. map ────────────────────────────────────────────────────
    try {
      const doubled = await pool.map(
        (n: number) => n * 2,
        [1, 2, 3, 4, 5],
      );
      results.map = { input: [1, 2, 3, 4, 5], output: doubled, expected: [2, 4, 6, 8, 10] };
    } catch (e: unknown) {
      errors.map = e instanceof Error ? e.message : String(e);
    }

    // ── 3. reduce ─────────────────────────────────────────────────
    try {
      const sum = await pool.reduce(
        (a: number, b: number) => a + b,
        [1, 2, 3, 4, 5],
        0,
      );
      results.reduce = { input: [1, 2, 3, 4, 5], output: sum, expected: 15 };
    } catch (e: unknown) {
      errors.reduce = e instanceof Error ? e.message : String(e);
    }

    // ── 4. pmap ───────────────────────────────────────────────────
    try {
      const pmapped = pool.pmap(
        (batch: number[]) => batch.map((x) => x * x),
      );
      const pmapResult = await pmapped([1, 2, 3, 4, 5, 6], { chunks: 3 });
      results.pmap = {
        input: [1, 2, 3, 4, 5, 6],
        chunks: 3,
        output: pmapResult,
        expected: [1, 4, 9, 16, 25, 36],
      };
    } catch (e: unknown) {
      errors.pmap = e instanceof Error ? e.message : String(e);
    }

    // ── 5. pipe ───────────────────────────────────────────────────
    try {
      const pipeline = pool.pipe(
        (s: string) => s.toLowerCase(),
        (s: string) => s.split(" "),
        (words: string[]) => words.length,
      );
      const pipeResult = await pipeline("Hello World From Cloudflare");
      results.pipe = {
        input: "Hello World From Cloudflare",
        output: pipeResult,
        expected: 4,
      };
    } catch (e: unknown) {
      errors.pipe = e instanceof Error ? e.message : String(e);
    }

    // ── 6. scatter ────────────────────────────────────────────────
    try {
      const chunkSums = await pool.scatter(
        (chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
        [1, 2, 3, 4, 5, 6],
        3,
      );
      results.scatter = {
        input: [1, 2, 3, 4, 5, 6],
        chunks: 3,
        output: chunkSums,
        expected: [3, 7, 11],
      };
    } catch (e: unknown) {
      errors.scatter = e instanceof Error ? e.message : String(e);
    }

    // ── Summary ───────────────────────────────────────────────────
    const allPassed =
      Object.keys(errors).length === 0 &&
      Object.entries(results).every(([, v]) => {
        const r = v as { output: unknown; expected: unknown };
        return JSON.stringify(r.output) === JSON.stringify(r.expected);
      });

    return Response.json(
      {
        ok: allPassed,
        results,
        errors: Object.keys(errors).length > 0 ? errors : undefined,
      },
      {
        status: allPassed ? 200 : 500,
        headers: { "content-type": "application/json" },
      },
    );
  },
};
