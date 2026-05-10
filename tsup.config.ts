import { defineConfig } from 'tsup';

/**
 * Bundled ESM build via esbuild. Three entries map to the three
 * `exports` paths in package.json:
 *   - `cloudflare-parallel`              → src/index.ts
 *   - `cloudflare-parallel/testing`      → src/testing.ts
 *   - `cloudflare-parallel/durable-objects` → src/durable-objects.ts
 *
 * Why bundled? Source can use plain `from './foo'` imports — no `.js`
 * extensions, no NodeNext quirks. The bundler resolves at build time;
 * the published `dist/` is a flat ESM tree consumable by Workers, Bun,
 * and modern Node (≥20).
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing.ts',
    'durable-objects': 'src/durable-objects.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  outDir: 'dist',
  // Mark workers-types and runtime globals as external. The `cloudflare:workers`
  // module is provided by the Workers runtime at execution time; never inline.
  external: ['cloudflare:workers', '@cloudflare/workers-types'],
  // No banner, no shims — the consumer sets `type: "module"`.
});
