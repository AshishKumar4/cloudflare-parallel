/**
 * Lightweight validator for `wrangler.toml` ↔ source-code shape.
 *
 * Runs as `cloudflare-parallel doctor` (CLI shim is `scripts/doctor.ts`).
 * Reads a `wrangler.toml` and a representative source file, emits a unified
 * diff suggestion when bindings are missing.
 */

import { emitWranglerFragment, type ScaffoldNeeds } from './wrangler';

export interface DoctorReport {
  ok: boolean;
  missing: string[];
  suggestion?: string;
}

export interface DoctorInput {
  wranglerToml: string;
  sourceCode: string;
}

const KNOWN_FACTORIES = [
  { name: 'pool', binding: 'CfpCoordinator', also: ['CfpWorkerDO', 'CfpSubCoord'] },
  { name: 'actor', binding: 'CfpCoordinator', also: [] as string[] },
  { name: 'scheduler', binding: 'CfpSchedulerDO', also: [] as string[] },
  { name: 'vm', binding: 'CfpCoordinator', also: ['CfpWorkerDO', 'CfpSubCoord'] },
];

export function runDoctor(input: DoctorInput): DoctorReport {
  const usesParallel: { factory: string; line: number }[] = [];
  const lines = input.sourceCode.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/Parallel\.(pool|loaderOnly|actor|scheduler|vm)\b/);
    if (m) usesParallel.push({ factory: m[1], line: i + 1 });
  }

  const declaredBindings = new Set<string>();
  const tomlBindings = input.wranglerToml.matchAll(/name\s*=\s*"(Cfp[A-Za-z]+)"/g);
  for (const match of tomlBindings) declaredBindings.add(match[1]);

  const missing: string[] = [];
  const needs: ScaffoldNeeds = {
    needsCoordinator: false,
    needsWorkerDO: false,
    needsSubCoord: false,
    needsScheduler: false,
    needsLoader: !/\[\[worker_loaders\]\]/.test(input.wranglerToml),
    needsInProcess: !/enable_ctx_exports/.test(input.wranglerToml),
  };

  for (const use of usesParallel) {
    const factory = KNOWN_FACTORIES.find((f) => f.name === use.factory);
    if (!factory) continue;
    if (factory.binding === 'CfpCoordinator') needs.needsCoordinator = true;
    if (factory.binding === 'CfpSchedulerDO') needs.needsScheduler = true;
    if (factory.also.includes('CfpWorkerDO')) needs.needsWorkerDO = true;
    if (factory.also.includes('CfpSubCoord')) needs.needsSubCoord = true;
    if (!declaredBindings.has(factory.binding)) {
      missing.push(`${factory.binding} (used by Parallel.${use.factory} at line ${use.line})`);
    }
    for (const extra of factory.also) {
      if (!declaredBindings.has(extra))
        missing.push(`${extra} (required for Parallel.${use.factory} fan-out)`);
    }
  }

  if (missing.length === 0 && !needs.needsLoader) {
    return { ok: true, missing: [] };
  }
  return {
    ok: false,
    missing,
    suggestion: emitWranglerFragment(needs),
  };
}
