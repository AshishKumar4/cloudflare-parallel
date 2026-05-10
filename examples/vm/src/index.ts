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

export {
  CfpCoordinator,
  CfpWorkerDO,
  CfpSubCoord,
  CfpInProcessCoordinator,
} from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
  /** ≥ 16-character bearer token. Set in wrangler.toml `[vars]` or via secrets. */
  VM_TOKEN: string;
}

interface CtxWithExports extends ExecutionContext {
  exports?: { CfpInProcessCoordinator?: unknown };
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Pool options live at the top level (the deprecated nested `pool:`
    // shape was removed; see CHANGELOG for v0.3). `inProcess` skips the
    // DO hop for size-≤4 submits — single-shot VM calls land there.
    return Parallel.vm<Record<string, never>>(env, {
      timeout: 5_000,
      retries: 1,
      globalOutbound: null,
      inProcess: (ctx as CtxWithExports).exports?.CfpInProcessCoordinator as
        | NonNullable<Parameters<typeof Parallel.pool>[1]>['inProcess']
        | undefined,
      requestColo: (req as Request & { cf?: { colo?: string } }).cf?.colo,
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
