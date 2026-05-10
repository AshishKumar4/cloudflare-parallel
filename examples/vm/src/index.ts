/**
 * HTTP submit-code "VM" example.
 *
 * Demonstrates `Parallel.VM`: clients POST a function source string + args,
 * the worker runs it in a sandboxed Worker Loader isolate, returns the
 * result. `globalOutbound: null` means user code cannot make outbound
 * fetches (sandbox-on-by-default); `policy.allowBindings` filters which
 * env bindings reach user code (default: none).
 *
 * The `policy` field is REQUIRED. There is no silent default-public path.
 * Use `bearerAuth(secret)` or `hmacAuth({ secret })` for production
 * deployments; use `policy: { kind: 'public' }` only if you understand
 * what an open code-submission endpoint means.
 */

import { Parallel, bearerAuth, type WorkerLoader } from 'cloudflare-parallel';

export { CfpCoordinator, CfpWorkerDO, CfpSubCoord } from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
  /** ≥ 16-character bearer token. Set in wrangler.toml `[vars]` or via secrets. */
  VM_TOKEN: string;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return Parallel.vm<Record<string, never>>(env, {
      pool: {
        timeout: 5_000,
        retries: 1,
        globalOutbound: null,
      },
      policy: {
        kind: 'auth',
        auth: bearerAuth(env.VM_TOKEN),
        // No bindings exposed to submitted code by default.
        allowBindings: [],
        maxBytes: 64 * 1024,
      },
    }).fetch(req);
  },
};
