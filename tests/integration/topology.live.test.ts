/**
 * Live integration test against `wrangler dev` running examples/research-agent
 * (or a sibling worker exposing the same routes). Skipped when no listener
 * is reachable on http://127.0.0.1:8787.
 *
 * Real CI should run this against a deployed test worker. The skip-marker
 * is honest: we do NOT mark a missing wrangler-dev as a passing test.
 */

import { describe, expect, it } from 'bun:test';

const BASE = process.env.CFP_INTEGRATION_BASE ?? 'http://127.0.0.1:8787';

async function alive(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { method: 'GET' });
    return res.status < 600;
  } catch {
    return false;
  }
}

describe('integration: topology end-to-end', () => {
  it.skipIf(!(await alive()))('size=4 in-do fan-out returns 4 results', async () => {
    const res = await fetch(`${BASE}/_test/in-do?n=4`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results.length).toBe(4);
  });

  it.skipIf(!(await alive()))('size=20 hybrid uses balanced-fill leaves', async () => {
    const res = await fetch(`${BASE}/_test/hybrid?n=20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; leafShape: number[] };
    expect(body.results.length).toBe(20);
    expect(body.leafShape).toEqual([4, 4, 4, 4, 4]);
  });

  it.skipIf(!(await alive()))('size=200 tree depth=2 with F=8', async () => {
    const res = await fetch(`${BASE}/_test/tree?n=200`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; treeDepth: number };
    expect(body.results.length).toBe(200);
    expect(body.treeDepth).toBeGreaterThanOrEqual(2);
  });
});
