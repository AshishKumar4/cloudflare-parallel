import type { PoolEnv, PoolOptions, VMOptions } from './options.js';
import { Pool } from './pool.js';
import { submitCodeHandler, type SubmitCodePolicy } from './submit-code-handler.js';

/**
 * `Parallel.VM` — opinionated HTTP submit-code surface. Composes on top of
 * `submitCodeHandler` (the same primitive that backs `pool.handle`) so
 * there is exactly one secure path through the library; this just bundles
 * the pool construction with sensible defaults.
 */
export interface VMHandle {
  fetch(req: Request, ctx?: ExecutionContext): Promise<Response>;
}

export function vm<B extends Record<string, unknown>>(
  env: PoolEnv,
  opts: VMOptions<B>,
): VMHandle {
  // Prefer the flat shape. If caller passes `pool: PoolOptions<B>`
  // we use that; otherwise pull pool fields off the top-level VMOptions.
  // VMOptions extends PoolOptions, so the top-level fields are valid
  // PoolOptions inputs.
  const poolOpts: PoolOptions<B> | undefined = opts.pool ?? (opts as PoolOptions<B>);
  const pool = new Pool<B, Record<string, unknown>>(env, poolOpts);
  // VMOptions historically had `auth` as a top-level callback. We adapt
  // it into the new policy shape so the underlying primitive is unified.
  // If the caller already passes `opts.policy`, that wins.
  let policy: SubmitCodePolicy<B>;
  if (opts.policy) {
    policy = opts.policy;
  } else if (opts.auth) {
    policy = {
      kind: 'auth',
      auth: opts.auth,
      allowBindings: opts.allowBindings,
      maxBytes: opts.maxBytes,
    };
  } else {
    // Forces submitCodeHandler to throw PolicyRequiredError at construction.
    policy = undefined as unknown as SubmitCodePolicy<B>;
  }
  const handler = submitCodeHandler<B>({
    pool,
    policy,
  });
  return {
    fetch(req: Request): Promise<Response> {
      return handler(req);
    },
  };
}

/**
 * Class-form of `Parallel.vm` — subclass and set `static opts` to wire a
 * Worker default-export. The class delegates to `vm(env, opts)` on every
 * `fetch`.
 *
 * ```ts
 * export default class extends Parallel.VM {
 *   static opts: Parallel.VMOptions = {
 *     pool: { bindings: { KV: env.MY_KV } },
 *     policy: { kind: 'auth', auth: (req) => verifyHmac(req, env.HMAC_KEY) },
 *   };
 * }
 * ```
 */
export class VM {
  static opts: VMOptions<Record<string, unknown>>;
  static fetch(
    this: { opts: VMOptions<Record<string, unknown>> },
    req: Request,
    env: PoolEnv,
  ): Promise<Response> {
    if (!this.opts) {
      throw new Error('Parallel.VM subclass must set `static opts`');
    }
    return vm(env, this.opts).fetch(req);
  }
}
