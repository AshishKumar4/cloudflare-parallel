# Contributing

Thanks for your interest! `cloudflare-parallel` is open to issues and
pull requests.

## Reporting issues

- Search [existing issues](https://github.com/cloudflare/cloudflare-parallel/issues) first.
- Include a minimal reproduction (Worker source + wrangler.toml + a
  curl command).
- For security findings: email `security@cloudflare.com`. Do not file
  a public GitHub issue.

## Development

```bash
git clone https://github.com/cloudflare/cloudflare-parallel
cd cloudflare-parallel
bun install
bun run typecheck
bun run lint
bun run test
```

The full pre-publish gate runs `prepublishOnly`:

```bash
bun run prepublishOnly
# clean → typecheck → lint → test → build
```

## Local end-to-end testing

```bash
cd examples/research-agent
bun x wrangler dev
# In another shell:
curl 'http://localhost:8787/?q=test'
```

Live tests against deployed workers require `CLOUDFLARE_API_TOKEN` and
are skipped in fork CI.

## Pull requests

1. Branch from `main`. Use a descriptive branch name
   (`feat/scheduler-fairness`, `fix/cancel-race`).
2. Granular commits — one logical change per commit. Conventional
   Commit format encouraged (`feat:`, `fix:`, `docs:`, `perf:`,
   `refactor:`, `test:`, `chore:`).
3. Add / update tests. New public surface needs unit tests; bug fixes
   need a regression test.
4. Run the full gate (`bun run prepublishOnly`). All checks must pass.
5. Update `CHANGELOG.md` under `[Unreleased]`.
6. Update relevant docs (`README.md`, `docs/*`, TSDoc on public
   symbols).
7. Open a PR with a clear title + description. Link the issue if there
   is one.

## Code style

- Strict DRY. No duplicated logic.
- Comments explain *why*, never *what*. If a comment is needed to
  explain what code does, rewrite the code.
- TypeScript strict mode. No `any`. No `as never`. Cast only at the
  trust boundary (RPC envelope) and document why.
- Public APIs use `Awaited<R>` for return types so consumers see
  unwrapped values.
- ESLint + Prettier configured; `bun run format` before committing.

## Architecture changes

For changes that touch the topology selector, dispatch pipeline,
cancel transport, scheduler core, or DO lifetimes:

1. Read [`DESIGN.md`](DESIGN.md) end-to-end.
2. If the change crosses an ADR boundary, update or add an ADR.
3. Discuss in an issue before implementing.

## Releases

The maintainers publish to npm. Process:

1. Bump `version` in `package.json`.
2. Move `[Unreleased]` to a dated release in `CHANGELOG.md`.
3. Run `bun run prepublishOnly`.
4. Tag `vX.Y.Z` and push.
5. `npm publish` (prepublish hook re-runs the gate).

## License

By contributing, you agree your contributions will be licensed under
the [MIT License](LICENSE).
