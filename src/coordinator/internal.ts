import type { ServiceStub } from '../types';
import type { InternalWorkerCodeOptions } from '../loader/codegen';
import type { RunOneRequest } from './protocol';

/**
 * Re-hydrate wire-shape workerOptions into the codegen.InternalWorkerCodeOptions.
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
): InternalWorkerCodeOptions | undefined {
  if (!wire) return undefined;
  const out: InternalWorkerCodeOptions = {
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
  opts: (InternalWorkerCodeOptions & { tailBindingName?: string }) | undefined,
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

/**
 * Region hints understood by Durable Objects. Passing one to
 * `namespace.get(id, { locationHint })` requests that the runtime place
 * the DO in the named region the first time the object is materialized.
 * Subsequent gets ignore the hint.
 *
 * Reference: https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
export type LocationHint = 'wnam' | 'enam' | 'sam' | 'weur' | 'eeur' | 'apac' | 'oc' | 'afr' | 'me';

/**
 * Coarse-grained mapping from a Cloudflare colo code (the three-letter IATA
 * code surfaced via `request.cf.colo`) to a `locationHint` region. The
 * library uses this to colocate freshly-created leaf DOs with the request's
 * incoming colo. Hints are best-effort — see the docs link above.
 *
 * The map is intentionally small (top colos by traffic share) and falls
 * through to `wnam` for unknowns. Users wanting precise control should
 * pass `locationHint` via `PoolOptions`.
 */
const COLO_TO_REGION: Record<string, LocationHint> = {
  // North America (west)
  SFO: 'wnam',
  SJC: 'wnam',
  LAX: 'wnam',
  SEA: 'wnam',
  PDX: 'wnam',
  PHX: 'wnam',
  DEN: 'wnam',
  SLC: 'wnam',
  LAS: 'wnam',
  YVR: 'wnam',
  // North America (east)
  IAD: 'enam',
  EWR: 'enam',
  JFK: 'enam',
  BOS: 'enam',
  ATL: 'enam',
  ORD: 'enam',
  DFW: 'enam',
  MIA: 'enam',
  YYZ: 'enam',
  YUL: 'enam',
  MCI: 'enam',
  MSP: 'enam',
  // South America
  GRU: 'sam',
  GIG: 'sam',
  EZE: 'sam',
  SCL: 'sam',
  BOG: 'sam',
  LIM: 'sam',
  // Western Europe
  LHR: 'weur',
  LON: 'weur',
  AMS: 'weur',
  CDG: 'weur',
  FRA: 'weur',
  MAD: 'weur',
  MXP: 'weur',
  DUB: 'weur',
  BRU: 'weur',
  ZRH: 'weur',
  STO: 'weur',
  ARN: 'weur',
  CPH: 'weur',
  OSL: 'weur',
  HEL: 'weur',
  VIE: 'weur',
  LIS: 'weur',
  // Eastern Europe
  WAW: 'eeur',
  PRG: 'eeur',
  BUD: 'eeur',
  SOF: 'eeur',
  OTP: 'eeur',
  KBP: 'eeur',
  IST: 'eeur',
  // Asia Pacific
  NRT: 'apac',
  KIX: 'apac',
  HND: 'apac',
  ICN: 'apac',
  HKG: 'apac',
  SIN: 'apac',
  BKK: 'apac',
  KUL: 'apac',
  TPE: 'apac',
  BOM: 'apac',
  DEL: 'apac',
  MAA: 'apac',
  BLR: 'apac',
  CGK: 'apac',
  MNL: 'apac',
  // Oceania
  SYD: 'oc',
  MEL: 'oc',
  PER: 'oc',
  AKL: 'oc',
  // Africa
  JNB: 'afr',
  CPT: 'afr',
  LOS: 'afr',
  NBO: 'afr',
  // Middle East
  DXB: 'me',
  DOH: 'me',
  RUH: 'me',
  TLV: 'me',
};

/**
 * Map a colo code to a location hint. Returns `undefined` for unknown
 * colos so `namespace.get` is called without a hint (the runtime then
 * picks placement based on first-access pattern).
 */
export function locationHintForColo(colo: string | undefined): LocationHint | undefined {
  if (!colo) return undefined;
  return COLO_TO_REGION[colo.toUpperCase()];
}

/**
 * Convenience: get a DO stub by name and call a typed RPC.
 *
 * `locationHint` is forwarded to `namespace.get` to request that the DO
 * be placed in a specific region the first time it is materialized.
 * Subsequent gets are sticky (hints are no-ops once placement is fixed).
 */
export function getStub<T>(
  ns: DurableObjectNamespace,
  name: string,
  locationHint?: LocationHint,
): DurableObjectStub & T {
  const id = ns.idFromName(name);
  // Cloudflare's TS types accept `{ locationHint }` only in some declarations
  // depending on @cloudflare/workers-types version — the runtime accepts it
  // unconditionally. Cast the options through `unknown` so we work against
  // older type packages without losing the runtime hint.
  const opts = locationHint
    ? ({ locationHint } as unknown as DurableObjectNamespaceGetDurableObjectOptions)
    : undefined;
  const stub = opts
    ? (
        ns as DurableObjectNamespace & {
          get(
            id: DurableObjectId,
            opts?: DurableObjectNamespaceGetDurableObjectOptions,
          ): DurableObjectStub;
        }
      ).get(id, opts)
    : ns.get(id);
  return stub as DurableObjectStub & T;
}

// `DurableObjectNamespaceGetDurableObjectOptions` may not be present in the
// ambient types; declare a minimal local version. Runtime accepts the shape.
interface DurableObjectNamespaceGetDurableObjectOptions {
  locationHint?: LocationHint;
}
