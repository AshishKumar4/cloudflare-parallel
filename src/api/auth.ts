/**
 * Auth recipes for `submitCodeHandler`. Production-quality primitives — no
 * dependencies, constant-time comparisons where it matters.
 *
 * - `bearerAuth(secret)`: constant-time bearer-token comparison.
 * - `hmacAuth({ secret, header, ttlSeconds })`: HMAC-SHA-256 over the request
 *   body + a timestamp header (replay-protected).
 *
 * Both return a `(req: Request) => Promise<boolean>` ready to plug into
 * `policy: { kind: 'auth', auth: ... }`.
 */

const encoder = new TextEncoder();

/**
 * Constant-time string equality. Prefers workerd's native
 * `crypto.subtle.timingSafeEqual(ArrayBuffer)` when available; falls
 * back to a hand-rolled XOR-OR loop on environments that don't ship it.
 *
 * Length-mismatch is non-secret (header length differs from secret
 * length — it's the *content* that must not leak), so we short-circuit
 * on length and avoid the platform call when it would throw on length
 * mismatch.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Prefer the platform primitive when present (workerd ships it).
  const subtle = (globalThis as { crypto?: { subtle?: { timingSafeEqual?: unknown } } }).crypto
    ?.subtle;
  const tse = subtle as
    | { timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean }
    | undefined;
  if (typeof tse?.timingSafeEqual === 'function') {
    const ab = encoder.encode(a);
    const bb = encoder.encode(b);
    if (ab.byteLength !== bb.byteLength) return false;
    return tse.timingSafeEqual(ab, bb);
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Bearer-token auth. Expects `Authorization: Bearer <secret>` header.
 * Compares constant-time against the configured secret.
 *
 * ```ts
 * Parallel.vm(env, {
 *   pool: { ... },
 *   policy: { kind: 'auth', auth: bearerAuth(env.VM_TOKEN) },
 * });
 * ```
 */
export function bearerAuth(secret: string): (req: Request) => boolean {
  if (!secret || secret.length < 16) {
    throw new Error('bearerAuth: secret must be at least 16 characters');
  }
  const expected = `Bearer ${secret}`;
  return (req: Request): boolean => {
    const header = req.headers.get('authorization') ?? '';
    return constantTimeEqual(header, expected);
  };
}

export interface HmacAuthOptions {
  /** HMAC secret (≥ 32 bytes recommended). */
  secret: string;
  /**
   * Header carrying the hex/base64 HMAC signature. Default
   * `x-cfp-signature`.
   */
  signatureHeader?: string;
  /**
   * Header carrying the unix timestamp (seconds) when the signature was
   * minted. Default `x-cfp-timestamp`. Replay-protects against signature
   * re-use beyond `ttlSeconds`.
   */
  timestampHeader?: string;
  /** Max age of a signed request (seconds). Default 300 (5 min). */
  ttlSeconds?: number;
  /** Encoding of the signature value. Default `'hex'`. */
  encoding?: 'hex' | 'base64';
}

/**
 * HMAC-SHA-256 auth. The client signs `${timestamp}\n${body}` with the
 * shared secret and sends the hex/base64-encoded signature in the
 * `x-cfp-signature` header (configurable). Server verifies in
 * constant time and rejects requests older than `ttlSeconds`.
 *
 * Returns a body-consuming `auth` callback. Because HMAC verification reads
 * the whole body, the `submitCodeHandler` must not consume the body before
 * auth — and it doesn't: the handler reads body AFTER auth check passes.
 *
 * **Replay protection.** Reuse of a captured (timestamp, signature) pair
 * within the TTL window IS possible — pair this with idempotency keys at
 * the application layer if exactly-once submission semantics matter.
 *
 * ```ts
 * const verify = await hmacAuth({ secret: env.HMAC_KEY, ttlSeconds: 60 });
 * Parallel.vm(env, {
 *   pool: { ... },
 *   policy: { kind: 'auth', auth: verify },
 * });
 * ```
 */
export async function hmacAuth(opts: HmacAuthOptions): Promise<(req: Request) => Promise<boolean>> {
  if (!opts.secret || opts.secret.length < 32) {
    throw new Error('hmacAuth: secret must be at least 32 characters');
  }
  const sigHeader = opts.signatureHeader ?? 'x-cfp-signature';
  const tsHeader = opts.timestampHeader ?? 'x-cfp-timestamp';
  const ttlSeconds = opts.ttlSeconds ?? 300;
  const encoding = opts.encoding ?? 'hex';

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(opts.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return async (req: Request): Promise<boolean> => {
    const provided = req.headers.get(sigHeader) ?? '';
    const tsRaw = req.headers.get(tsHeader) ?? '';
    if (!provided || !tsRaw) return false;
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts)) return false;
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (ageSeconds > ttlSeconds) return false;

    // Clone before reading the body so the downstream handler can re-read.
    const cloned = req.clone();
    const body = await cloned.text();

    const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}\n${body}`));
    const expected = encoding === 'hex' ? toHex(sigBytes) : toBase64(sigBytes);
    return constantTimeEqual(provided, expected);
  };
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
