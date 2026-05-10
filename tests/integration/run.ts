#!/usr/bin/env bun
/**
 * Integration test runner.
 *
 * The full-fidelity integration tests require `wrangler dev` to be
 * reachable AND a Cloudflare account with Worker Loader Beta access. CI
 * environments without those credentials should set `SKIP_INTEGRATION=1`.
 *
 * In skip mode we still emit a clear "skipped because env unavailable"
 * marker so consumers (and reviewers) can see the gate explicitly.
 */

import { spawnSync } from 'node:child_process';

const skip = !!process.env.SKIP_INTEGRATION;
if (skip) {
  console.log('[integration] SKIP_INTEGRATION=1 — skipped.');
  console.log('[integration] To run locally: `bunx wrangler dev` in examples/research-agent then');
  console.log('[integration]                  `bun test tests/integration/topology.live.test.ts`.');
  process.exit(0);
}

// In a real CI with Wrangler available, we'd invoke `wrangler dev` here and
// run a live HTTP suite. For now we shell out to a Bun test file that
// performs HTTP probes against http://127.0.0.1:8787 and skips if that's
// unreachable.
const res = spawnSync('bun', ['test', 'tests/integration'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(res.status ?? 1);
