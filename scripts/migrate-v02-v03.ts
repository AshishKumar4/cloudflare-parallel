#!/usr/bin/env bun
/**
 * v0.2 → v0.3 codemod.
 *
 * Walks the user's source tree, rewrites `Parallel.pool(env.LOADER, opts)` to
 * `Parallel.pool(env, opts)` (full Pool) or `Parallel.loaderOnly(env, opts)`
 * (zero-DO) depending on `--prefer-loader-only`.
 *
 * Usage:
 *   bun run scripts/migrate-v02-v03.ts                # preview (default)
 *   bun run scripts/migrate-v02-v03.ts --apply        # write
 *   bun run scripts/migrate-v02-v03.ts --prefer-loader-only --apply
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from '../src/config/doctor.js';
import { emitWranglerFragment, type ScaffoldNeeds } from '../src/config/wrangler.js';

interface Cli {
  apply: boolean;
  preferLoaderOnly: boolean;
  root: string;
}

function parseCli(argv: string[]): Cli {
  return {
    apply: argv.includes('--apply'),
    preferLoaderOnly: argv.includes('--prefer-loader-only'),
    root: argv.find((a) => !a.startsWith('--')) ?? process.cwd(),
  };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) yield full;
  }
}

const cli = parseCli(process.argv.slice(2));
let touched = 0;
let suggestionsPrinted = false;

for (const file of walk(cli.root)) {
  const original = readFileSync(file, 'utf8');
  // Heuristic rewrite: `Parallel.pool(env.LOADER` → `Parallel.pool(env`
  // (or `Parallel.loaderOnly(env`).
  const target = cli.preferLoaderOnly ? 'Parallel.loaderOnly(env' : 'Parallel.pool(env';
  const next = original.replace(/Parallel\.pool\(\s*env\.LOADER\b/g, target);
  if (next !== original) {
    touched++;
    if (cli.apply) {
      writeFileSync(file, next, 'utf8');
      console.log(`updated  ${file}`);
    } else {
      console.log(`would update  ${file}`);
    }
  }
  // Surface doctor advice for any wrangler.toml siblings.
  if (/wrangler\.toml$/.test(file)) {
    // Look for neighboring source files referencing Parallel.*
    const neighborSrc = readdirSync(join(file, '..'))
      .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
      .map((f) => readFileSync(join(file, '..', f), 'utf8'))
      .join('\n');
    const report = runDoctor({ wranglerToml: original, sourceCode: neighborSrc });
    if (!report.ok && !suggestionsPrinted) {
      console.log('\n--- wrangler.toml suggestions ---');
      for (const m of report.missing) console.log(`  missing: ${m}`);
      if (report.suggestion) console.log('\n' + report.suggestion);
      suggestionsPrinted = true;
    }
  }
}

if (!cli.apply && touched > 0) {
  console.log(`\n(preview) Would update ${touched} file(s). Re-run with --apply to write.`);
} else if (cli.apply) {
  console.log(`\nUpdated ${touched} file(s).`);
}

if (!cli.apply && touched === 0 && !suggestionsPrinted) {
  // No v0.2 patterns found. Emit a generic scaffold for greenfield users.
  const needs: ScaffoldNeeds = {
    needsCoordinator: true,
    needsWorkerDO: true,
    needsSubCoord: true,
    needsScheduler: false,
    needsLoader: true,
  };
  console.log('\nNo v0.2 patterns detected. Greenfield wrangler.toml fragment:\n');
  console.log(emitWranglerFragment(needs));
}
