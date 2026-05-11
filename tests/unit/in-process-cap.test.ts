/**
 * P0 regression: `CfpInProcessCoordinator` must use the `'do-method'`
 * loader-cap (4 concurrent loaders), NOT the `'fetch-handler'` cap (3).
 *
 * Background: the loopback is invoked via `ctx.exports.<WorkerEntrypoint>`.
 * Although the entry surface looks like a `WorkerEntrypoint`, the
 * dispatch context is an isolate-already-running invocation — not a
 * fresh fetch event handler. The runtime's per-isolate concurrent-loader
 * budget is 4 (the DO-method cap), not 3 (the fetch-handler cap).
 *
 * The earlier code used `'fetch-handler'` for both
 * `CfpInProcessCoordinator.runOne` and `.runMany`. When the topology
 * selector routed N=4 fan-out through the loopback, the third-arg
 * `LoaderRunner` queued the fourth task behind the cap=3 semaphore →
 * N=4 ran as 3-parallel + 1-queued, surfacing as a "N=4 is barely
 * faster than sequential" complaint in the live demo.
 *
 * This test reads the source for `CfpInProcessCoordinator` and pins
 * that both `LoaderRunner` constructions specify `callSite: 'do-method'`.
 * The static check is the right shape for this regression — runtime
 * verification requires the live Workers runtime (4-loader concurrency
 * can't be observed in a bun-test process where every loader is a fake).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, '../../src/coordinator/in-process.ts'), 'utf-8');

describe('CfpInProcessCoordinator loader-cap', () => {
  it('runOne uses callSite: do-method (cap=4), not fetch-handler (cap=3)', () => {
    // Find the runOne method body.
    const runOneIdx = SRC.indexOf('async runOne(');
    expect(runOneIdx).toBeGreaterThan(-1);
    // Find the LoaderRunner constructor inside it.
    const runnerIdx = SRC.indexOf('new LoaderRunner', runOneIdx);
    expect(runnerIdx).toBeGreaterThan(-1);
    // Find the closing `})` of the LoaderRunner options.
    const closeIdx = SRC.indexOf('});', runnerIdx);
    expect(closeIdx).toBeGreaterThan(-1);
    const constructorBody = SRC.slice(runnerIdx, closeIdx);
    expect(constructorBody).toContain("callSite: 'do-method'");
    expect(constructorBody).not.toContain("callSite: 'fetch-handler'");
  });

  it('runMany uses callSite: do-method (cap=4), not fetch-handler (cap=3)', () => {
    const runManyIdx = SRC.indexOf('async runMany(');
    expect(runManyIdx).toBeGreaterThan(-1);
    const runnerIdx = SRC.indexOf('new LoaderRunner', runManyIdx);
    expect(runnerIdx).toBeGreaterThan(-1);
    const closeIdx = SRC.indexOf('});', runnerIdx);
    expect(closeIdx).toBeGreaterThan(-1);
    const constructorBody = SRC.slice(runnerIdx, closeIdx);
    expect(constructorBody).toContain("callSite: 'do-method'");
    expect(constructorBody).not.toContain("callSite: 'fetch-handler'");
  });

  it('the explanatory comment cites the rationale', () => {
    // Anchor the comment to a banned-substitution check — if a future
    // refactor reverts the callSite, the comment block should be the
    // first thing reviewers notice in the diff.
    expect(SRC).toMatch(/DO[- ]method[- ]equivalent/i);
  });

  it('the loader-budget exports the expected caps', async () => {
    // Re-import the cap-table to make sure these constants haven't shifted.
    const mod = await import('../../src/loader/loader-budget');
    expect(mod.defaultCapFor('fetch-handler')).toBe(3);
    expect(mod.defaultCapFor('do-method')).toBe(4);
  });
});
