#!/usr/bin/env bun
/**
 * Prod test runner. Two layers:
 *
 *   1. Substrate validation against the public reference worker
 *      (cf-mp-vm.ashishkumarsingh.com) — confirms the empirical caps
 *      our topology selector relies on still hold upstream.
 *
 *   2. Live library E2E via `wrangler dev --local` — boots a real
 *      the Workers runtime with the library's DO + Worker Loader bindings,
 *      exercises every primitive over HTTP. No deploy, no account
 *      credentials needed.
 *
 * Skip path: `SKIP_PROD_TESTS=1` (CI on forks should set this).
 */

import { spawnSync } from 'node:child_process';

const SKIP = process.env.SKIP_PROD_TESTS === '1';
const BASE = process.env.CFP_PROD_BASE ?? 'https://cf-mp-vm.ashishkumarsingh.com';

if (SKIP) {
  console.log('[prod] SKIP_PROD_TESTS=1 — skipped.');
  process.exit(0);
}

async function main(): Promise<void> {
  console.log('==== Layer 1: cf-mp-vm substrate validation ====\n');

  // Probe health.
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`[prod] health probe failed at ${BASE}/health — aborting.`);
    process.exit(2);
  }
  const h = (await health.json()) as { hasLoader: boolean; hasDoNs: boolean };
  if (!h.hasLoader || !h.hasDoNs) {
    console.error('[prod] target lacks LOADER or DO bindings — cannot test.');
    process.exit(2);
  }
  console.log(`[prod] target OK: ${BASE}`);

  const t = spawnSync('bun', ['test', 'tests/prod/cf-mp-vm.test.ts'], {
    stdio: 'inherit',
    env: { ...process.env, CFP_PROD_BASE: BASE },
  });
  if ((t.status ?? 0) !== 0) {
    console.error('[prod] substrate test suite failed.');
    process.exit(1);
  }

  console.log('\n[bench] cf-mp-vm substrate measurements:');
  await benchMeasure('a', 'parallel-diff', 4);
  await benchMeasure('a', 'parallel-same', 4);
  await benchMeasure('b', 'parallel-diff', 4);
  await benchMeasure('b', 'parallel-same', 4);
  await benchMeasure('b', 'parallel-diff', 16, 100000);
  await benchMeasure('b', 'sequential', 16, 100000);
  console.log('[bench] complete.\n');

  console.log('==== Layer 2: live library E2E (wrangler dev --local) ====\n');
  const e = spawnSync('bun', ['run', 'tests/prod/e2e-live.ts'], {
    stdio: 'inherit',
    env: process.env,
  });
  if ((e.status ?? 0) !== 0) {
    console.error('[prod] live library E2E failed.');
    process.exit(1);
  }
  console.log('\n[prod] all layers passed.');
}

async function benchMeasure(
  prefix: 'a' | 'b',
  mode: string,
  n: number,
  iters = 10000,
): Promise<void> {
  const url = `${BASE}/${prefix}/benchmark?n=${n}&iters=${iters}&mode=${mode}`;
  const t0 = Date.now();
  const r = (await fetch(url).then((x) => x.json())) as {
    backend?: string;
    uniqueIsolates: number;
    wallTotalMs?: number;
    err?: string | null;
  };
  const elapsed = Date.now() - t0;
  if (r.err) {
    console.log(`  ${prefix}/${mode} n=${n} iters=${iters}: ERR=${r.err.slice(0, 80)}`);
    return;
  }
  console.log(
    `  ${prefix}/${mode} n=${n} iters=${iters}: backend=${r.backend} ` +
      `uniqueIsolates=${r.uniqueIsolates} wallTotalMs=${r.wallTotalMs ?? '?'} (rt=${elapsed}ms)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
