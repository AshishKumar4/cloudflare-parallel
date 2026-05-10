# vm

HTTP "submit-code" endpoint — clients POST a function source string +
args, the worker runs it in a sandboxed Worker Loader isolate.

## What it shows

- **`Parallel.VM` / `Parallel.vm`.** The HTTP equivalent of
  `pool.handle({...})`. Same threat model.
- **Required `policy`.** There is no silent default-public path. You
  pick one of:
  - `{ kind: 'auth', auth: bearerAuth(token) }` — bearer token gate.
  - `{ kind: 'auth', auth: hmacAuth({ secret }) }` — HMAC-signed body.
  - `{ kind: 'public' }` — explicit opt-in to an open endpoint (a
    one-time runtime warning is logged).
- **Sandboxing.** `globalOutbound: null` removes the loaded isolate's
  ability to make outbound `fetch()` calls. `policy.allowBindings: []`
  exposes zero env bindings — submitted code sees only its args.
- **Capability gating per tenant.** Pass `allowBindings: ['KV_TENANT_A']`
  to expose only one tenant's KV namespace; library-internal `Cfp*`
  bindings are hard-blocklisted regardless.
- **Body-size cap.** `maxBytes: 64 * 1024` rejects oversized fn
  submissions before they hit the runtime.

## How to run

```bash
cd examples/vm
bun install
# Set a bearer token (≥16 chars):
echo 'VM_TOKEN = "supersecret-bearer-token-min-16-chars"' >> .dev.vars
bun x wrangler dev
# Submit:
curl -X POST 'http://localhost:8787/' \
  -H 'Authorization: Bearer supersecret-bearer-token-min-16-chars' \
  -H 'Content-Type: application/json' \
  -d '{"fn":"async (a, b) => a + b","args":[2, 3]}'
# → { "ok": true, "value": 5 }
```

## What to learn

- This is the threat-modelled primitive at the heart of the library.
  Every other surface (`pool.handle`, `Parallel.VM`) composes on the
  same `submitCodeHandler` with the same policy contract.
- Bearer auth (`bearerAuth`) is timing-safe via `crypto.subtle.digest`.
- Submitted code **cannot** access library-internal DO bindings even
  if you accidentally list them in `allowBindings`.
- See `docs/security.md` for the full threat model.
