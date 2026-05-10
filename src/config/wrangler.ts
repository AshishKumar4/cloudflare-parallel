/**
 * Wrangler scaffolding helper. Not run at runtime — used by the
 * doctor CLI (`config/doctor.ts`) to compute and print wrangler.toml
 * fragments.
 */

export interface ScaffoldNeeds {
  /** Whether the user calls Parallel.pool / actor / vm (any non-loader-only path). */
  needsCoordinator: boolean;
  /** Whether they use map/scatter/etc. above size 4 (or topology pinned 'hybrid'/'tree'). */
  needsWorkerDO: boolean;
  needsSubCoord: boolean;
  needsScheduler: boolean;
  /** Whether to scaffold a Worker Loader binding. */
  needsLoader: boolean;
  /**
   * Whether to scaffold the in-process coordinator. Recommended on by
   * default — adding `CfpInProcessCoordinator` and the
   * `enable_ctx_exports` compatibility flag drops the small-N (≤ 4)
   * dispatch floor from a DO RPC hop to an in-process call.
   */
  needsInProcess?: boolean;
  /** Optional binding name override (default `LOADER`). */
  loaderName?: string;
  /** Migration tag for the [[migrations]] block. */
  migrationTag?: string;
}

export function emitWranglerFragment(needs: ScaffoldNeeds): string {
  const lines: string[] = [];

  // Compatibility flag — required for `ctx.exports.<WorkerEntrypoint>`.
  if (needs.needsInProcess !== false) {
    lines.push(
      '# Enable `ctx.exports.<WorkerEntrypoint>` loopback bindings.',
      '# Reference: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-ctxexports',
      'compatibility_flags = ["enable_ctx_exports"]',
      '',
    );
  }

  if (needs.needsLoader) {
    lines.push('# Worker Loader binding (required by all factories)');
    lines.push('[[worker_loaders]]');
    lines.push(`binding = "${needs.loaderName ?? 'LOADER'}"`);
    lines.push('');
  }

  const sqliteClasses: string[] = [];
  if (needs.needsCoordinator) sqliteClasses.push('CfpCoordinator');
  if (needs.needsWorkerDO) sqliteClasses.push('CfpWorkerDO');
  if (needs.needsSubCoord) sqliteClasses.push('CfpSubCoord');
  if (needs.needsScheduler) sqliteClasses.push('CfpSchedulerDO');

  for (const cls of sqliteClasses) {
    lines.push('[[durable_objects.bindings]]');
    lines.push(`name = "${cls}"`);
    lines.push(`class_name = "${cls}"`);
    lines.push('');
  }

  if (sqliteClasses.length > 0) {
    lines.push('[[migrations]]');
    lines.push(`tag = "${needs.migrationTag ?? 'v1-cfp'}"`);
    lines.push(`new_sqlite_classes = [${sqliteClasses.map((c) => `"${c}"`).join(', ')}]`);
    lines.push('');
  }

  lines.push('# Re-export the library DO classes (and the in-process coordinator)');
  lines.push('# from your worker entrypoint, e.g.:');
  lines.push('#');
  lines.push('#   export {');
  for (const cls of sqliteClasses) lines.push(`#     ${cls},`);
  if (needs.needsInProcess !== false) {
    lines.push('#     CfpInProcessCoordinator,');
  }
  lines.push('#   } from "cloudflare-parallel/durable-objects";');
  if (needs.needsInProcess !== false) {
    lines.push('#');
    lines.push('# Then in your fetch handler, pass the loopback to Parallel.pool:');
    lines.push('#');
    lines.push('#   const pool = Parallel.pool(env, {');
    lines.push('#     inProcess: ctx.exports.CfpInProcessCoordinator,');
    lines.push('#   });');
  }

  return lines.join('\n');
}
