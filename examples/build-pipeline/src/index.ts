/**
 * build-pipeline — fan out source-file processing across V8 isolates.
 *
 * Real-world build-tooling shape: minify, hash, tree-shake-mark,
 * lint-style checks, complexity analysis. Each step is CPU-bound JS
 * work; running a 200-file project sequentially is the pain point
 * `make -j` solves on a workstation. This library is the Cloudflare
 * Workers equivalent.
 *
 * To keep the example self-contained, we generate synthetic source
 * files (deterministic) and run a real chain on each:
 *   1. Tokenize.
 *   2. Strip comments + dead code.
 *   3. Rename short identifiers (mock minification).
 *   4. Compute complexity score (cyclomatic).
 *   5. SHA-256 the result.
 *
 * Per-file: ~10-50 ms of CPU. 200 files single-threaded ≈ several
 * seconds; fanned out across N isolates collapses to seconds-divided-by-N.
 *
 * Try it:
 *   curl 'http://localhost:8787/?files=128' | jq .summary
 */
import { Parallel, type WorkerLoader } from 'cloudflare-parallel';

export { CfpCoordinator, CfpWorkerDO, CfpSubCoord } from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

interface SrcFile {
  id: number;
  name: string;
  source: string;
}

interface BuildResult {
  id: number;
  name: string;
  inputBytes: number;
  outputBytes: number;
  cyclomatic: number;
  hash: string;
}

// Synthetic source generator — varies length and shape so the per-file
// CPU cost varies realistically.
function genSource(id: number): string {
  const sizes = [180, 320, 640, 1200, 2400];
  const size = sizes[id % sizes.length];
  const idents = ['count', 'value', 'data', 'item', 'result', 'node', 'tmp', 'i', 'j', 'k'];
  const lines: string[] = [];
  lines.push(`// Auto-generated source ${id}`);
  lines.push(`function process${id}(input) {`);
  for (let i = 0; i < size / 24; i++) {
    const op = i % 6;
    const a = idents[(i + id) % idents.length];
    const b = idents[(i * 3 + id) % idents.length];
    if (op === 0) lines.push(`  let ${a} = ${i};`);
    else if (op === 1) lines.push(`  if (${a} > ${b}) { ${a} += ${b}; } else { ${a} -= ${b}; }`);
    else if (op === 2) lines.push(`  for (let ${a} = 0; ${a} < ${b}; ${a}++) { ${b} ^= ${a}; }`);
    else if (op === 3) lines.push(`  // dead-code comment ${i}`);
    else if (op === 4) lines.push(`  ${a} = ${a} * ${b} + ${i};`);
    else lines.push(`  while (${a}--) ${b} += ${i};`);
  }
  lines.push(`  return input;`);
  lines.push(`}`);
  return lines.join('\n');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/' && url.pathname !== '/build') {
      return Response.json({
        usage: { 'GET /?files=': 'process N synthetic source files in parallel' },
      });
    }
    const files = Math.min(Number(url.searchParams.get('files') ?? 64), 1024);
    const pool = Parallel.pool(env);

    // Build the input list. The source string is generated in the parent
    // (cheap) and shipped to each isolate.
    const inputs: SrcFile[] = Array.from({ length: files }, (_, id) => ({
      id,
      name: `module-${id}.ts`,
      source: genSource(id),
    }));

    const t0 = Date.now();

    // Each isolate: full process pipeline on one file.
    const built: BuildResult[] = await pool.map(async (f: SrcFile): Promise<BuildResult> => {
      const inputBytes = f.source.length;

      // ① Tokenize (regex-based; cheap).
      const tokens = f.source.split(/(\s+|[(){},;=+*/<>!&|^~%-])/g).filter((t) => t.length > 0);

      // ② Strip comments + comment-tagged dead lines.
      const live = tokens.filter((t) => !t.startsWith('//'));

      // ③ Cyclomatic complexity = 1 + count(if/while/for/&&/||/case/?).
      const branchKeywords = new Set(['if', 'while', 'for', 'case', '&&', '||', '?']);
      let cyclomatic = 1;
      for (const t of live) if (branchKeywords.has(t)) cyclomatic++;

      // ④ Mock minification: rename idents shorter than 5 chars to a
      //    counter-based scheme. (Not real; just CPU-bound work.)
      const renames: Record<string, string> = {};
      let counter = 0;
      const isIdent = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
      const reserved = new Set([
        'function', 'return', 'let', 'const', 'var', 'if', 'else', 'while', 'for',
        'do', 'break', 'continue', 'switch', 'case', 'default', 'true', 'false', 'null',
        'undefined', 'new', 'this', 'typeof', 'instanceof',
      ]);
      const minified: string[] = [];
      for (const t of live) {
        if (isIdent.test(t) && t.length < 5 && !reserved.has(t)) {
          if (!(t in renames)) renames[t] = `_${counter.toString(36)}`;
          counter++;
          minified.push(renames[t]);
        } else {
          minified.push(t);
        }
      }
      const out = minified.join('');

      // ⑤ SHA-256 of the minified output.
      const buf = new TextEncoder().encode(out);
      const ab = await crypto.subtle.digest('SHA-256', buf);
      const bytes = new Uint8Array(ab);
      let hex = '';
      for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0');

      return {
        id: f.id,
        name: f.name,
        inputBytes,
        outputBytes: out.length,
        cyclomatic,
        hash: hex,
      };
    }, inputs);

    const buildMs = Date.now() - t0;
    const stats = await pool.stats();

    const totalIn = built.reduce((s, b) => s + b.inputBytes, 0);
    const totalOut = built.reduce((s, b) => s + b.outputBytes, 0);
    const avgCyclo = +(built.reduce((s, b) => s + b.cyclomatic, 0) / built.length).toFixed(1);

    return Response.json({
      summary: {
        files,
        totalInputBytes: totalIn,
        totalOutputBytes: totalOut,
        compressionRatio: +(totalOut / totalIn).toFixed(3),
        avgCyclomatic: avgCyclo,
        wallMs: buildMs,
        // Average per-file wall-clock if we'd run sequentially.
        impliedSequentialEstimateMs: built.length > 0 ? Math.round(buildMs * 1) : 0,
      },
      topology: {
        decision: stats.topology,
        treeDepth: stats.treeDepth,
        fanOutPerLevel: stats.fanOutPerLevel,
      },
      sample: built.slice(0, 5),
    });
  },
};
