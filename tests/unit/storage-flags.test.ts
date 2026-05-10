/**
 * V4 regression: `allowUnconfirmed: true` on storage writes.
 *
 * Empirical validation: 46–80% wall-time reduction on writes, with the
 * trade-off that a not-yet-committed write can be lost if the DO crashes
 * before the commit lands. The library applies the flag selectively
 * per the validation report's classification table:
 *
 * | Write site                                   | Crash-critical? | Flag set? |
 * |----------------------------------------------|------------------|-----------|
 * | Actor state checkpoint (per-submit)          | NO  (best-effort docs) | YES |
 * | Actor initial-state seed                     | NO  (recoverable from input) | YES |
 * | Scheduler durable queue (sql INSERT INTO jobs) | YES  (losing jobs is bad) | NO |
 * | Scheduler ack writes (sql UPDATE status='done') | YES  (re-running a done job is wrong) | NO |
 *
 * These tests pin the flag set ONLY on the right writes by reading the
 * source for the relevant `storage.put` and `sql.exec` calls. A future
 * over-application would surface as a regression.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string): string =>
  readFileSync(resolve(__dirname, '../../src', rel), 'utf-8');

describe('V4 allowUnconfirmed application', () => {
  it('actor checkpoint writes pass allowUnconfirmed: true', () => {
    const coordinator = SRC('coordinator/coordinator.ts');
    // The two actor writes (initial-state seed + per-submit checkpoint)
    // should both be flagged.
    const putCalls = coordinator.match(/this\.ctx\.storage\.put\([^)]+\)/g) ?? [];
    expect(putCalls.length).toBeGreaterThanOrEqual(3); // 2 init + 1 submit
    for (const call of putCalls) {
      expect(call).toContain('allowUnconfirmed: true');
    }
  });

  it('scheduler durable queue writes do NOT use allowUnconfirmed', () => {
    // Scheduler uses SQL (sql.exec INSERT/UPDATE/DELETE) for the durable
    // queue, not key-value storage.put. allowUnconfirmed is a put-only
    // option, so SQL writes are naturally crash-durable. Defensive: any
    // future shift to ctx.storage.put inside the scheduler MUST NOT add
    // the flag.
    const schedulerDo = SRC('scheduler/scheduler-do.ts');
    const doStorageStore = SRC('scheduler/stores/do-storage.ts');
    expect(schedulerDo.match(/storage\.put\([^)]*allowUnconfirmed/)).toBeNull();
    expect(doStorageStore.match(/storage\.put\([^)]*allowUnconfirmed/)).toBeNull();
  });

  it('scheduler durable queue writes survive a synchronous-commit pattern', () => {
    // Confirm the scheduler's job-persistence path uses sql.exec INSERT
    // (which is a synchronous write to the SQLite store, no
    // allowUnconfirmed bypass available). The job-ack path uses UPDATE
    // SET status='done' RETURNING — same SQL path, same durability.
    const doStorageStore = SRC('scheduler/stores/do-storage.ts');
    expect(doStorageStore).toContain('INSERT INTO jobs');
    expect(doStorageStore).toContain("status = 'done'");
    // No raw key-value put for job state.
    expect(doStorageStore.match(/storage\.put/)).toBeNull();
  });

  it('every flagged site is preceded by an explanatory comment', () => {
    // Every `allowUnconfirmed: true` site must be accompanied by an
    // explanatory comment citing the safety rationale. Each call site
    // must have, somewhere in the preceding 20 lines, a comment block
    // that mentions the durability trade-off (one of: "best-effort",
    // "recoverable", "crash", or "wall-time").
    const coordinator = SRC('coordinator/coordinator.ts');
    const lines = coordinator.split('\n');
    const flaggedLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      // Pick out the actual call sites, not comments that happen to
      // mention `allowUnconfirmed: true`.
      if (
        lines[i].includes('allowUnconfirmed: true') &&
        lines[i].includes('storage.put')
      ) {
        flaggedLines.push(i);
      }
    }
    expect(flaggedLines.length).toBeGreaterThanOrEqual(3);
    const safetyVocab = [
      'best-effort',
      'recoverable',
      'crash',
      'wall-time',
      '46–80%',
    ];
    for (const lineIdx of flaggedLines) {
      const window = lines
        .slice(Math.max(0, lineIdx - 20), lineIdx)
        .join('\n');
      const hasComment = safetyVocab.some((v) => window.includes(v));
      expect(hasComment).toBe(true);
    }
  });
});
