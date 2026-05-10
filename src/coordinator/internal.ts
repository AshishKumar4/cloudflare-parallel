import type { ServiceStub } from '../types.js';
import type { WorkerCodeOptions } from '../loader/codegen.js';
import type { RunOneRequest } from './protocol.js';

/**
 * Re-hydrate wire-shape workerOptions into the codegen.WorkerCodeOptions.
 *
 * @param wire - the structured-clone-safe wire shape from the caller.
 * @param env - the receiving DO's env. Used to resolve `tailBindingName`
 *   into a real `ServiceStub` for the loaded isolate's `tails:` array.
 *   ServiceStubs are not structured-clone-safe across RPC, so we ride a
 *   binding *name* across the wire and look up the stub here.
 */
export function wireToWorkerOptions(
  wire: RunOneRequest['workerOptions'],
  env?: Record<string, unknown>,
): WorkerCodeOptions | undefined {
  if (!wire) return undefined;
  const out: WorkerCodeOptions = {
    compatibilityDate: wire.compatibilityDate,
    compatibilityFlags: wire.compatibilityFlags,
    limits: wire.limits,
  };
  if (wire.globalOutbound === 'sandboxed') {
    out.globalOutbound = null;
  } else if (wire.globalOutbound === 'inherit') {
    out.globalOutbound = undefined;
  } else {
    out.globalOutbound = null; // sandboxed by default
  }
  if (wire.tailBindingName && env) {
    const stub = env[wire.tailBindingName];
    if (stub && typeof (stub as ServiceStub).fetch === 'function') {
      out.tails = [stub as ServiceStub];
    }
  }
  return out;
}

/** Marshal user-supplied workerOptions to the structured-clone-safe wire shape. */
export function workerOptionsToWire(
  opts: (WorkerCodeOptions & { tailBindingName?: string }) | undefined,
): RunOneRequest['workerOptions'] | undefined {
  if (!opts) return undefined;
  let outbound: 'inherit' | 'sandboxed' | undefined;
  if (opts.globalOutbound === null) outbound = 'sandboxed';
  else if (opts.globalOutbound === undefined) outbound = 'inherit';
  else outbound = 'sandboxed'; // a service-stub redirector is treated as sandboxed for the wire shape
  // Note: ServiceStub-shaped globalOutbound forwarding is per-DO config and
  // cannot cross the structured-clone wire — DOs must opt into this via
  // their own bindings.
  return {
    compatibilityDate: opts.compatibilityDate,
    compatibilityFlags: opts.compatibilityFlags,
    globalOutbound: outbound,
    limits: opts.limits,
    tailBindingName: opts.tailBindingName,
  };
}

/** Pick a deterministic DO id from a stable string. */
export function idFromName(ns: DurableObjectNamespace, name: string): DurableObjectId {
  return ns.idFromName(name);
}

/** Convenience: get a DO stub by name and call a typed RPC. */
export function getStub<T>(ns: DurableObjectNamespace, name: string): DurableObjectStub & T {
  return ns.get(ns.idFromName(name)) as DurableObjectStub & T;
}

// Re-export ServiceStub so consumers of this internal module needn't import it from types.
export type { ServiceStub };
