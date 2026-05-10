import { SerializationError } from '../errors/index';
import type { UserFn } from '../api/user-fn';

/**
 * `fn.toString()` -> serializable source, with guard rails:
 * - reject native functions (`[native code]`)
 * - reject `this` references (loaded isolates have no meaningful `this`).
 *
 * Cancellation is delivered via `env.signal` rather than a positional
 * argument (see DESIGN ADR-5).
 *
 * **Bundler shim stripping.** When the caller's Worker is bundled with
 * esbuild (the default for Wrangler), `Function.prototype.toString()`
 * returns source decorated with esbuild's `__name(fn, "name")` and
 * `__publicField(...)` runtime helpers. Those helpers are not defined
 * inside the freshly-loaded isolate, so we strip them at serialize time:
 * `__name(<expr>, "...")` collapses to `<expr>`, and `__publicField(this,
 * "x", v)` collapses to `this.x = v`. This is a thin shim, not a code
 * rewrite — semantics are preserved.
 */
export function serializeFunction(fn: UserFn): string {
  if (typeof fn !== 'function') {
    throw new SerializationError(`Expected a function, got ${typeof fn}`);
  }
  const raw = fn.toString();
  if (raw.includes('[native code]')) {
    throw new SerializationError(
      `Cannot serialize native function: ${fn.name || '(anonymous)'}. ` +
        'Only user-defined functions can be dispatched to remote isolates.',
    );
  }
  const source = stripBundlerShims(raw);
  if (/\bthis\b/.test(source)) {
    throw new SerializationError(
      `Function "${fn.name || '(anonymous)'}" references \`this\`, which is ` +
        'not available in a remote isolate. Pass values as explicit arguments ' +
        'instead, or use Parallel.actor (which receives `(state, sql, ...args, env)`).',
    );
  }
  return source;
}

/**
 * Strip esbuild bundler-runtime shims from a function source string.
 *
 * - `__name(expr, "literal")` → `expr` (the second arg is always a
 *   string literal — esbuild generates this exclusively for assigning
 *   `Function.prototype.name`).
 * - `__publicField(target, "field", value)` → `target.field = value`
 *   (esbuild emits this for class field initializers).
 *
 * Implementation note: regex-based stripping is sufficient because
 * esbuild's emitted patterns are mechanical and deterministic. We do
 * not attempt to handle hand-written calls to identifiers named
 * `__name` (the convention is reserved for tooling).
 */
function stripBundlerShims(src: string): string {
  let out = src;
  // __name(expr, "literal") — collapse to `expr`. The second arg is
  // always a double- or single-quoted string with no embedded quotes
  // (esbuild emits the original identifier name verbatim).
  out = out.replace(/__name\(\s*([\s\S]*?)\s*,\s*(?:"[^"]*"|'[^']*')\s*\)/g, '$1');
  // __publicField(target, "field"|literal, value) — for class field init.
  out = out.replace(
    /__publicField\(\s*([^,]+?)\s*,\s*("[^"]*"|'[^']*'|[A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*([\s\S]+?)\s*\)\s*;?/g,
    (_m, target: string, key: string, value: string) => {
      const accessor = key.startsWith('"') || key.startsWith("'")
        ? `[${key}]`
        : `.${key}`;
      return `${target}${accessor} = ${value};`;
    },
  );
  return out;
}

/** djb2 — fast, deterministic, NOT cryptographic. Used only for cache-key differentiation. */
export function hashSource(source: string): string {
  let hash = 5381;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Identifier validator for context keys (DESIGN §7.4).
 * Keys are interpolated as `const KEY = JSON;` in generated source — anything
 * not a valid JS identifier risks code injection in multi-tenant `Parallel.VM`.
 */
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'enum',
  'await',
  'async',
  'true',
  'false',
  'null',
  'undefined',
]);

export function assertValidContextKey(key: string): void {
  if (!VALID_IDENTIFIER.test(key)) {
    throw new SerializationError(`context key "${key}" is not a valid JavaScript identifier`);
  }
  if (RESERVED_WORDS.has(key)) {
    throw new SerializationError(`context key "${key}" is a reserved word`);
  }
  if (key.startsWith('Cfp') || key.startsWith('cfp')) {
    throw new SerializationError(`context key "${key}" uses the reserved Cfp* / cfp* prefix`);
  }
}

/**
 * Canonicalize a context object for stable JSON embedding (sorted keys;
 * reject Map/Set/Date/RegExp/Symbol/circular). DESIGN §7.4.
 */
export function canonicalizeContext(ctx: Record<string, unknown>): string {
  for (const key of Object.keys(ctx)) assertValidContextKey(key);
  const seen = new WeakSet<object>();
  const stringify = (val: unknown): string => {
    if (val === null) return 'null';
    if (val === undefined) return 'null';
    const t = typeof val;
    if (t === 'number' || t === 'boolean') return JSON.stringify(val);
    if (t === 'string') return JSON.stringify(val);
    if (t === 'function') {
      throw new SerializationError('context values cannot be functions');
    }
    if (t === 'symbol' || t === 'bigint') {
      throw new SerializationError(`context values cannot be ${t}`);
    }
    if (val instanceof Date) {
      throw new SerializationError('context values cannot be Date — use timestamp number');
    }
    if (val instanceof RegExp) {
      throw new SerializationError('context values cannot be RegExp — use source string');
    }
    if (val instanceof Map || val instanceof Set) {
      throw new SerializationError('context values cannot be Map/Set — use plain object/array');
    }
    if (Array.isArray(val)) {
      if (seen.has(val)) {
        throw new SerializationError('context values cannot contain circular references');
      }
      seen.add(val);
      return '[' + val.map(stringify).join(',') + ']';
    }
    if (t === 'object') {
      if (seen.has(val as object)) {
        throw new SerializationError('context values cannot contain circular references');
      }
      seen.add(val as object);
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + stringify(obj[k])).join(',') + '}';
    }
    throw new SerializationError(`unserializable context value of type ${t}`);
  };
  return stringify(ctx);
}
