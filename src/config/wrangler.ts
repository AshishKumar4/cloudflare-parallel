/**
 * Wrangler scaffolding helper. Not run at runtime — used by the codemod
 * (`scripts/migrate-v02-v03.ts`) and the doctor CLI (`config/doctor.ts`)
 * to compute and print wrangler.toml fragments.
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
  /** Optional binding name override (default `LOADER`). */
  loaderName?: string;
  /** Migration tag for the [[migrations]] block. */
  migrationTag?: string;
}

export function emitWranglerFragment(needs: ScaffoldNeeds): string {
  const lines: string[] = [];
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

  lines.push(
    '# Re-export the library DO classes from your worker entrypoint, e.g.:',
    '#',
    '#   export {',
  );
  for (const cls of sqliteClasses) lines.push(`#     ${cls},`);
  lines.push('#   } from "cloudflare-parallel/durable-objects";');

  return lines.join('\n');
}
