import { PolicyRequiredError, errorToWire, type WireError } from '../errors/index';
import type { Pool } from './pool';
import type { SubmitOptions } from './options';

/**
 * Shared HTTP submit-code primitive used by both `pool.handle()` and
 * `Parallel.vm()`. There is exactly one secure surface; `Parallel.VM` is
 * an opinionated wrapper around `submitCodeHandler` with sensible defaults.
 *
 * **Threat model.**
 *   1. **Code injection.** Submitted JS runs inside a sandboxed
 *      `Worker Loader` isolate with `globalOutbound: null` (no
 *      `fetch()`/`connect()`) and a defensive `caches.default` seal at
 *      codegen time. The library's own DO bindings (`Cfp*`) are
 *      blocklisted from the dynamic worker's env regardless of what the
 *      caller put in `pool.bindings:`. See `src/loader/sandbox.ts`.
 *   2. **Capability escalation via env.** Only bindings on
 *      `policy.allowBindings` reach the dynamic worker's `env`. Default
 *      `allowBindings = []` — submitted code sees no user bindings unless
 *      explicitly enumerated. See `Pool.restrictTo` in pool.ts.
 *   3. **Fan-out amplification.** Submissions go through a single
 *      `pool.submit` (size=1). To prevent submitted code from spinning
 *      up ITS OWN pool from inside the loaded isolate, library-internal
 *      DO bindings are blocklisted (see point 1). A buggy submission
 *      cannot escalate to size > 1.
 *   4. **DoS via large bodies / large fns.** `policy.maxBytes` (default
 *      64 KiB) bounds the request body; `policy.maxFnSourceBytes` (also
 *      64 KiB) bounds the function source string.
 *   5. **Auth bypass.** `policy` is REQUIRED. Calling `submitCodeHandler`
 *      without a policy throws `PolicyRequiredError` at construction (no
 *      "default-public" silent path). Use `policy: 'public'` to opt in
 *      explicitly; this also emits a one-time runtime warning.
 *
 * **Auth recipes** are exposed via `policy.auth(req)`. See `auth.ts` for
 * `hmacAuth` (HMAC-signed payloads) and `bearerAuth` (constant-time bearer
 * token).
 */

/** Required security policy for accepting submitted code over HTTP. */
export type SubmitCodePolicy<B> =
  | {
      /** Accept submissions from anyone. Logs a one-time warning. */
      kind: 'public';
      /**
       * Per-tenant rate-limiting hook. Throw to reject; return otherwise.
       * Called before the user fn runs.
       */
      onSubmit?: (req: Request) => void | Promise<void>;
      /** Allowed bindings forwarded to user code. Default: none. */
      allowBindings?: ReadonlyArray<keyof B & string>;
      /** Body size cap (bytes). Default 64 KiB. */
      maxBytes?: number;
      /** Function source size cap (bytes). Default 64 KiB. */
      maxFnSourceBytes?: number;
    }
  | {
      /** Authenticate every request. Reject by returning false / throwing. */
      kind: 'auth';
      auth: (req: Request) => boolean | Promise<boolean>;
      onSubmit?: (req: Request) => void | Promise<void>;
      allowBindings?: ReadonlyArray<keyof B & string>;
      maxBytes?: number;
      maxFnSourceBytes?: number;
    };

const PUBLIC_WARN =
  '[cloudflare-parallel] submitCodeHandler is running with policy:"public" — anyone can submit code. Use auth in production.';
let publicWarned = false;

const DEFAULT_MAX_BYTES = 64 * 1024;

export interface SubmitCodeOptions<B extends Record<string, unknown>> {
  /** The pool that runs the submitted code. */
  pool: Pool<B, Record<string, unknown>>;
  /** Required security policy. */
  policy: SubmitCodePolicy<B>;
  /**
   * Optional custom request parser. Default = JSON `{fn, args, options}`.
   *
   * **Caveat.** When you provide `parse:`, you bypass the library's
   * built-in `maxBytes` body-size cap. Custom parsers are responsible
   * for enforcing their own size limits and rejecting oversized bodies
   * (the `Content-Length` pre-check still runs, but custom parsers
   * receive the raw `req` and decide how to read it).
   */
  parse?: (req: Request) => Promise<{ fn: string; args: unknown[]; options?: SubmitOptions }>;
  /** Optional response formatter. Default emits `{ok, value}` JSON. */
  format?: (result: unknown) => Response;
}

/**
 * Build a `(req: Request) => Promise<Response>` handler that accepts
 * submitted code and runs it through `opts.pool`. Both `pool.handle` and
 * `Parallel.vm` route through this single primitive.
 */
export function submitCodeHandler<B extends Record<string, unknown>>(
  opts: SubmitCodeOptions<B>,
): (req: Request) => Promise<Response> {
  if (!opts.policy) {
    throw new PolicyRequiredError(
      'submitCodeHandler requires `policy`. Use `policy: { kind: "public" }` to ' +
        'accept anonymous submissions (with a one-time warning) or ' +
        '`policy: { kind: "auth", auth: (req) => ... }` for authenticated submissions.',
    );
  }
  if (opts.policy.kind === 'public' && !publicWarned) {
    publicWarned = true;
    console.warn(PUBLIC_WARN);
  }

  const policy = opts.policy;
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFnSrc = policy.maxFnSourceBytes ?? DEFAULT_MAX_BYTES;

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (policy.kind === 'auth') {
      let authed: boolean;
      try {
        authed = await policy.auth(req);
      } catch (err) {
        return jsonError(err, 401);
      }
      if (!authed) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    if (policy.onSubmit) {
      try {
        await policy.onSubmit(req);
      } catch (err) {
        return jsonError(err, 429, /* forceStatus */ true);
      }
    }

    // Body-size cap. Two layers of defense:
    //   1. Cheap pre-check on Content-Length when present — reject before
    //      buffering anything.
    //   2. Stream-read with a byte counter for chunked-encoded bodies that
    //      omit Content-Length. We abort the read past `maxBytes` instead
    //      of buffering the entire body.
    const declared = req.headers.get('content-length');
    if (declared !== null) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > maxBytes) {
        return new Response(`Body exceeds ${maxBytes} bytes`, { status: 413 });
      }
    }

    let parsed: { fn: string; args: unknown[]; options?: SubmitOptions };
    try {
      if (opts.parse) {
        parsed = await opts.parse(req);
      } else {
        const text = await readBodyBounded(req, maxBytes);
        if (text === null) {
          return new Response(`Body exceeds ${maxBytes} bytes`, { status: 413 });
        }
        const body = JSON.parse(text) as {
          fn?: unknown;
          args?: unknown;
          options?: unknown;
        };
        if (typeof body.fn !== 'string') {
          return jsonError(new Error('body.fn must be a string'), 400);
        }
        parsed = {
          fn: body.fn,
          args: Array.isArray(body.args) ? body.args : [],
          options: body.options as SubmitOptions | undefined,
        };
      }
    } catch (err) {
      return jsonError(err, 400, /* forceStatus */ true);
    }

    if (typeof parsed.fn !== 'string' || parsed.fn.length > maxFnSrc) {
      return jsonError(new Error(`fn must be a string ≤ ${maxFnSrc} bytes`), 400, true);
    }

    // Capability gate: rebuild the pool with only the allow-listed
    // bindings visible. Default `allowBindings = []` means submitted
    // code sees NO user bindings unless the policy explicitly
    // enumerates them. `Pool.restrictTo` re-uses the same coordinator;
    // only the bindings filter is rebuilt.
    const restrictedPool = opts.pool.restrictTo(policy.allowBindings ?? []);

    try {
      // The submitted source is shipped to the loader directly — the
      // Workers runtime disables `eval` in the parent Worker, so we never round-trip
      // through `Function.prototype.toString()`. The loader is the
      // platform-sanctioned path for dynamic code; the loaded isolate
      // runs in its own V8 context with `globalOutbound: null` and no
      // user bindings unless `policy.allowBindings` opts in.
      const value = await restrictedPool.submitSource(parsed.fn, parsed.args ?? [], parsed.options);
      return opts.format ? opts.format(value) : Response.json({ ok: true, value });
    } catch (err) {
      // For `policy.kind === 'public'`, scrub stack traces and `cause`
      // chains from the response — anonymous callers don't get internal
      // implementation details. Auth'd callers get the full wire shape
      // for debugging.
      const sanitize = policy.kind === 'public';
      return jsonError(err, statusOfError(err), false, sanitize);
    }
  };
}

/**
 * Stream-read a request body, capped at `maxBytes`. Returns the decoded
 * UTF-8 string, or `null` if the body exceeds the cap.
 *
 * Counts BYTES (not chars) — `text.length` is char count and inflates
 * 2-4x for non-ASCII bodies. We measure on the raw stream and
 * decode only after the cap check passes.
 */
async function readBodyBounded(req: Request, maxBytes: number): Promise<string | null> {
  // Fast path: when no body, return ''.
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  if (chunks.length === 0) return '';
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function jsonError(
  err: unknown,
  fallbackStatus: number,
  forceStatus = false,
  sanitize = false,
): Response {
  const wire: WireError = errorToWire(err);
  const status = forceStatus ? fallbackStatus : wire.httpStatus || fallbackStatus;
  // Public-policy responses redact stack and cause chains so anonymous
  // callers never see internal implementation details.
  const body = sanitize
    ? {
        ok: false,
        error: {
          name: wire.name,
          message: wire.message,
          code: wire.code,
          httpStatus: wire.httpStatus,
        },
      }
    : { ok: false, error: wire };
  return Response.json(body, { status });
}

function statusOfError(err: unknown): number {
  if (err && typeof err === 'object' && 'httpStatus' in err) {
    const s = (err as { httpStatus: unknown }).httpStatus;
    if (typeof s === 'number' && s >= 100 && s < 600) return s;
  }
  return 500;
}
