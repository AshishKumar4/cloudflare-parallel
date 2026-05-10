// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for cloudflare-parallel.
 * Targets: src/, tests/, examples/, scripts/.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '**/.wrangler/**', '**/dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        // Cloudflare Workers globals.
        Request: 'readonly',
        Response: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        TransformStream: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        caches: 'readonly',
        addEventListener: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        console: 'readonly',
        process: 'readonly',
        // Node-test (bun:test) globals
        Bun: 'readonly',
      },
    },
    rules: {
      // World-class library: forbid `any`, but allow it in tests.
      '@typescript-eslint/no-explicit-any': 'error',
      // We use `unknown` and narrow; allow named-but-unused vars prefixed with _.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Prefer `import type` for type-only imports — keeps compiled JS clean.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Library convention: no semantic relevance, but keep public API stable.
      '@typescript-eslint/no-empty-object-type': 'off',
      // Allow function-typed prop signatures via `Function` only with caution.
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      // Allow non-null assertions where TypeScript narrowing falls short
      // (refactoring exhaustively is post-1.0 work).
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Allow `// eslint-disable-next-line` only with a justification.
      'no-empty-function': ['warn', { allow: ['arrowFunctions'] }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Tests can use `any` and inline casts.
    files: ['tests/**', 'examples/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
  {
    // Scripts run as Bun CLI — Node-style globals.
    files: ['scripts/**', 'tests/integration/**', 'tests/bench/**', 'tests/prod/**'],
    languageOptions: {
      globals: {
        process: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
