#!/usr/bin/env bun
/**
 * Live library E2E runner.
 *
 * Two modes:
 *   - Default: boots `tests/prod/test-worker` via `wrangler dev --local`.
 *   - `CFP_E2E_TARGET=<url>`: hits the given URL directly (e.g. a deployed
 *     Worker on workers.dev). Skips the local boot.
 *
 * Exercises every primitive through HTTP:
 *   - Pool: submit, map (every topology size, ≤512), scatter, reduce, pmap,
 *     pipe, mapStream, mapOrdered, cancel, stats, warm
 *   - Actor: inc / state / close
 *   - Scheduler: enqueue, result, stats, cancel-tenant, configure
 *   - VM: bearer auth + sandboxed submit
 *   - LoaderOnly: map
 *   - Errors: TimeoutError + AggregateExecutionError round-trips
 */

import { spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';

const REMOTE = process.env.CFP_E2E_TARGET ?? '';
const PORT = 8787;
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const TOKEN = 'dev-prod-test-token-min-16-chars-please';
const LOG_FILE = '/tmp/cfp-prod-test-worker.log';
// Per-call timeout. Real edge can hit 10s+ on cold-start fan-outs at n=512.
const REQ_TIMEOUT_MS = REMOTE ? 60_000 : 30_000;

type Json = Record<string, unknown>;

interface BenchEntry {
  name: string;
  ok: boolean;
  ms: number;
  data?: Json | unknown;
  error?: string;
}

const results: BenchEntry[] = [];

function pass(name: string, ms: number, data?: unknown): void {
  results.push({ name, ok: true, ms, data: data as Json });
  console.log(`✓ ${name.padEnd(50)} ${String(ms).padStart(5)}ms`);
}
function fail(name: string, ms: number, err: unknown): void {
  results.push({ name, ok: false, ms, error: String(err) });
  console.log(`✗ ${name.padEnd(50)} ${String(ms).padStart(5)}ms  ERR=${err}`);
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    return await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function callJson<T = Json>(path: string, body?: unknown, headers?: HeadersInit): Promise<T> {
  const r = await call(path, {
    method: body !== undefined ? 'POST' : 'GET',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`worker did not become ready within ${timeoutMs}ms`);
}

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const v = await fn();
    pass(name, Date.now() - t0, v);
    return v;
  } catch (e) {
    fail(name, Date.now() - t0, (e as Error).message);
    return null;
  }
}

// ----- Test plan ----------------------------------------------------------

async function runTests(): Promise<void> {
  // Pool — every primitive
  await timed('pool/submit', () =>
    callJson('/pool/submit', { fn: '(a, b) => a + b', args: [2, 3] }),
  );
  // Topology coverage at every regime: in-do (≤4), hybrid (5..256), tree (>256).
  // n=512 forces the auto-selector into the tree topology.
  const sizes = REMOTE ? [4, 8, 16, 32, 64, 128, 256, 512] : [4, 8, 16, 32, 64, 128];
  for (const size of sizes) {
    const items = Array.from({ length: size }, (_, i) => i);
    await timed(`pool/map size=${size}`, () => callJson('/pool/map', { items }));
  }
  await timed('pool/scatter', () =>
    callJson('/pool/scatter', { items: [1, 2, 3, 4, 5, 6, 7, 8], chunks: 4 }),
  );
  await timed('pool/reduce', () => callJson('/pool/reduce', { items: [1, 2, 3, 4, 5] }));
  await timed('pool/pmap', () =>
    callJson('/pool/pmap', { items: [1, 2, 3, 4, 5, 6, 7, 8], chunks: 4 }),
  );
  await timed('pool/pipe', () => callJson('/pool/pipe', { input: 1 }));
  await timed('pool/mapStream', () => callJson('/pool/mapStream', { items: [1, 2, 3, 4] }));
  await timed('pool/mapOrdered', () => callJson('/pool/mapOrdered', { items: [1, 2, 3, 4] }));
  await timed('pool/cancel (mid-flight)', () =>
    callJson('/pool/cancel', { items: [1, 2, 3, 4], cancelAfterMs: 50 }),
  );
  await timed('pool/warm', () => callJson('/pool/warm', { isolates: 4 }));
  await timed('pool/stats', () => callJson('/pool/stats'));

  // Actor
  await timed('actor/inc 1', () => callJson('/actor/inc', { id: 'a-1' }));
  await timed('actor/inc 2', () => callJson('/actor/inc', { id: 'a-1' }));
  await timed('actor/inc 3', () => callJson('/actor/inc', { id: 'a-1' }));
  await timed('actor/state', () => callJson('/actor/state?id=a-1'));
  await timed('actor/close', () => callJson('/actor/close?id=a-1', {}));

  // Scheduler
  const enq = await timed<{ jobId: string }>('scheduler/enqueue', () =>
    callJson('/scheduler/enqueue', { tenant: 't-1', n: 1000, idemKey: 'key-1' }),
  );
  if (enq) {
    await new Promise((r) => setTimeout(r, 500));
    await timed('scheduler/result', () => callJson(`/scheduler/result?id=${enq.jobId}`));
  }
  await timed('scheduler/enqueue idem', () =>
    callJson('/scheduler/enqueue', { tenant: 't-1', n: 1000, idemKey: 'key-1' }),
  );
  await timed('scheduler/stats', () => callJson('/scheduler/stats'));
  await timed('scheduler/configure', () =>
    callJson('/scheduler/configure', { inFlightLimit: 8, fairCapacityPerTenant: 2 }),
  );
  await timed('scheduler/cancel-tenant', () =>
    callJson('/scheduler/cancel-tenant', { tenant: 't-2' }),
  );

  // VM (bearer auth)
  await timed('vm POST (no auth) → 401', async () => {
    const r = await call('/vm', {
      method: 'POST',
      body: JSON.stringify({ fn: '() => 1', args: [] }),
      headers: { 'content-type': 'application/json' },
    });
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
    return { status: r.status };
  });
  await timed('vm POST (with auth) → 200', () =>
    callJson('/vm', { fn: '(a, b) => a * b', args: [6, 7] }, { authorization: `Bearer ${TOKEN}` }),
  );

  // Loader-only
  await timed('loader-only/map', () => callJson('/loader-only/map', { items: [1, 2, 3] }));

  // Errors
  await timed('errors/timeout (TimeoutError)', () => callJson('/errors/timeout'));
  await timed('errors/aggregate (AggregateExecutionError)', () => callJson('/errors/aggregate'));
}

// ----- Bootstrap & teardown ----------------------------------------------

async function main(): Promise<void> {
  let wrangler: ReturnType<typeof spawn> | undefined;
  const log: string[] = [];

  if (REMOTE) {
    console.log(`==> using deployed target ${BASE}`);
  } else {
    console.log('==> booting tests/prod/test-worker via wrangler dev --local');
    wrangler = spawn(
      './node_modules/.bin/wrangler',
      ['dev', '--ip', '0.0.0.0', '--port', String(PORT), 'src/index.ts'],
      {
        cwd: 'tests/prod/test-worker',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
    wrangler.stdout?.on('data', (d) => log.push(String(d)));
    wrangler.stderr?.on('data', (d) => log.push(String(d)));
  }

  let exitCode = 0;
  try {
    await waitForReady();
    console.log(`==> worker ready at ${BASE}\n`);
    await runTests();
    console.log('');
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(
      `==> live E2E: ${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ''}`,
    );
    if (failed > 0) exitCode = 1;

    // Slim payload — record name/ok/ms + topology-relevant fields.
    const slim = results.map((r) => {
      const out: BenchEntry = { name: r.name, ok: r.ok, ms: r.ms };
      if (!r.ok && r.error) out.error = r.error;
      const d = r.data as
        | { topology?: string; fanOutPerLevel?: number[]; treeDepth?: number }
        | undefined;
      if (d && (d.topology || d.fanOutPerLevel)) {
        out.data = {
          topology: d.topology,
          fanOutPerLevel: d.fanOutPerLevel,
          treeDepth: d.treeDepth,
        };
      }
      return out;
    });
    writeFileSync(
      'bench-results.json',
      JSON.stringify(
        {
          target: REMOTE ? `live-edge:${REMOTE}` : 'wrangler-dev-local',
          ts: new Date().toISOString(),
          summary: { total: results.length, passed, failed },
          results: slim,
        },
        null,
        2,
      ),
    );
    console.log('==> wrote bench-results.json');
  } finally {
    if (wrangler) {
      wrangler.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      writeFileSync(LOG_FILE, log.join(''));
      try {
        const { rmSync } = await import('node:fs');
        rmSync('tests/prod/test-worker/.wrangler', { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  process.exit(exitCode);
}

void main().catch((e) => {
  console.error(e);
  try {
    unlinkSync(LOG_FILE);
  } catch {
    /* */
  }
  process.exit(1);
});
