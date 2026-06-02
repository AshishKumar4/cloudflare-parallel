# Security

The threat model for `cloudflare-parallel` centers on submit-code
endpoints (`pool.handle` and `Parallel.vm`). This document enumerates
the threats and the mitigations.

## Threats

| #  | Threat                                                                                          | Severity |
| -- | ----------------------------------------------------------------------------------------------- | -------- |
| T1 | Anonymous code execution — anyone POSTs a fn that exfiltrates secrets via env bindings           | Critical |
| T2 | Capability escalation — submitted code accesses library-internal DOs and writes to their storage | Critical |
| T3 | Outbound exfiltration — submitted code makes outbound `fetch()` to an attacker-controlled host    | High     |
| T4 | Resource amplification — submitted code triggers large fan-out, exhausting CPU/memory           | High     |
| T5 | Persistence — submitted code writes to KV / D1 / R2 to maintain state across requests           | Medium   |
| T6 | Side-channel — submitted code measures timing to fingerprint co-tenants                          | Low      |

## Mitigations

### T1: Anonymous code execution

`pool.handle({ policy })` and `Parallel.vm({ policy })` **require** a
`policy` field. There is no silent default-public path. The policy
contract:

```ts
type SubmitCodePolicy<B> =
  | { kind: 'auth'; auth: (req: Request) => boolean | Promise<boolean>; allowBindings?: string[]; maxBytes?: number; maxFnSourceBytes?: number }
  | { kind: 'public'; allowBindings?: string[]; maxBytes?: number; maxFnSourceBytes?: number };
```

`{ kind: 'public' }` is an explicit opt-in; the runtime logs a
one-time console.warn so deployments cannot silently expose an open
endpoint.

Built-in `auth`:
- `bearerAuth(token)` — expects `Authorization: Bearer <token>` and
  compares the full header string in constant time. Minimum token length
  is 16 characters.
- `hmacAuth({ secret })` — verifies HMAC-SHA-256 over
  `${timestamp}\n${bodyText}` where `bodyText` is read from
  `req.clone().text()`. Headers default to `x-cfp-signature` and
  `x-cfp-timestamp`; signatures may be hex or base64.

Test coverage: `tests/unit/submit-code-handler.test.ts` (13 tests).

### T2: Capability escalation

The user can pass `bindings: { ... }` to construct a Pool. The
library's own DO bindings (`CfpCoordinator`, `CfpWorkerDO`,
`CfpSubCoord`, `CfpSchedulerDO`) are **hard-blocklisted** from
forwarding to loaded isolates regardless of what the user passes.
Source: `src/loader/sandbox.ts` blocks `^Cfp[A-Z]`, lowercase `^cfp`,
and the non-cloneable `LOADER` binding.

Additionally, `policy.allowBindings: string[]` filters the pool's
bindings declaration to only the named keys before dispatch. Default is
`[]` — zero exposure. On DO-backed paths, binding values are resolved
from the receiving DO's env; the allow-list controls which env keys may
cross into the loaded isolate.

### T3: Outbound exfiltration

`submitCodeHandler` and `Parallel.vm` default submitted-code workers to
`globalOutbound: null` unless the original pool explicitly configured a
different outbound policy. That blocks outbound `fetch()` / `connect()`
from inside the user fn.

If you need outbound access, set `globalOutbound: env.MY_OUTBOUND_SERVICE` —
a Service binding that proxies allowed destinations. Library does not
ship a default URL allowlist.

Normal trusted `Parallel.pool`, `Parallel.actor`, and
`Parallel.scheduler` jobs inherit outbound access unless you set
`globalOutbound: null`. `Parallel.loaderOnly` defaults to sandboxed
outbound unless you explicitly opt into inherit through
`workerOptions.globalOutbound`.

### T4: Resource amplification

`policy.maxBytes` caps the request body (default 64 KiB). The default
parser also enforces `policy.maxFnSourceBytes` (default 64 KiB) on the
function source string. Custom `parse` hooks are responsible for their
own body-size enforcement after the initial `Content-Length` pre-check.
Submitted fns are bounded by the runtime's per-request `cpuMs` and
`subRequests` limits.

For fan-out from inside a submitted fn: the loaded isolate has no
direct DO bindings (capability-gated), so it cannot recursively
construct a Pool. Fan-out amplification requires explicit binding
forwarding via `allowBindings`.

### T5: Persistence

Same mitigation as T2 + T3 — the isolate sees only `allowBindings`
keys. If KV / D1 / R2 is not in `allowBindings`, the user fn cannot
persist anything beyond its return value.

### T6: Side-channel timing

Mitigated only by isolate isolation — Cloudflare's runtime separates
co-tenants. Library does not introduce additional timing oracles
beyond what the platform provides.

## Trust boundary clarifications

### Scheduler `tenantId` is a label, not a credential

The Scheduler's `tenantId` is purely an organizational key for fair
queueing and `cancelByTenant` operations. It is **not** authenticated
inside the SchedulerDO — anyone holding the Scheduler stub can enqueue
jobs under any `tenantId` and cancel any tenant's jobs.

This is by design: the Scheduler stub is held by your trusted Worker.
The Worker is the trust boundary; it must enforce that authenticated
users can only act on their own tenants. Do not expose the Scheduler
stub to user code via `bindings:` — that would let submitted code
target arbitrary tenants.

### `pickBindings` is convenience, not a security boundary

`pickBindings(env, keys)` is a typed key filter. It does not enforce
any security property: a user passing `keys: ['CfpCoordinator']` would
have it returned, but the dispatch path's `sanitizeBindings` strips
`Cfp*` regardless. The actual security boundary is in
`src/loader/sandbox.ts:isLibraryInternalKey` — a prefix predicate
that blocks any `^Cfp[A-Z]` or `^cfp` key from ever crossing the
loader boundary into a dynamic worker's `env`.

### Public-policy error responses are sanitized

When `policy: { kind: 'public' }`, error responses redact `stack` and
`cause` from the wire shape. Anonymous callers see only `{ name,
message, code, httpStatus }`. Authenticated callers (`policy: { kind:
'auth' }`) receive the full WireError including stack — they are
trusted enough to use it for debugging.

## Reporting

Report security issues to `security@cloudflare.com` (PGP key on
[cloudflare.com/security](https://www.cloudflare.com/security/)). Do
not file public GitHub issues for security findings.
