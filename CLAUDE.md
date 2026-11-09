# tsdmarc

A 1:1 TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc) (and the parts of mailsuite it uses). pnpm + Turborepo monorepo laid out like the Vercel AI SDK: the `tsdmarc` core plus one `@tsdmarc/*` package per integration. The ported upstream commits are in `NOTICE`.

@architecture/README.md @AGENTS.md

## The 1:1 rule

Parsing results, CSV/JSON output, documents sent to outputs, log messages (level and text) and error classes must match parsedmarc's. Before changing behavior, read the Python original:

- `upstream/parsedmarc` and `upstream/mailsuite` (gitignored; clone them as described in `CONTRIBUTING.md` → "Porting a new parsedmarc version" if missing). Their `AGENTS.md`/`CLAUDE.md` describe parsedmarc, not this repo — but their regex and testing rules apply here too.
- `fixtures/` is parsedmarc's own output for every file in `samples/`. Never edit it by hand: regenerate it with `pnpm fixtures` (needs `.venv`, see `tools/fixtures/README.md`). If a fixture test fails, the port is wrong, not the fixture.
- Every deliberate difference (security hardening, runtime limitation) goes in the numbered list in `architecture/README.md` → "Differences from parsedmarc".

## Commands

```bash
pnpm fix                               # format + lint fix (run before committing)
pnpm check                             # ultracite: oxlint + oxfmt
pnpm type-check                        # tsrs --noEmit in every package
pnpm test                              # vitest, all packages
pnpm --filter tsdmarc test             # one package
cd packages/tsdmarc && pnpm vitest --run src/aggregate.test.ts   # one file
pnpm build:packages && pnpm publint && pnpm pack:check           # packaging
pnpm test:smoke                        # built packages on Node, Bun, Deno
```

- Type check with `tsrs`, never `tsc` — not in scripts, Turborepo or CI either.
- Tests that need `dist/` of another package (integrations import `tsdmarc` by name) need `pnpm build:packages` first; Turborepo does it for `pnpm test`.

## Rules that are easy to get wrong

- **Keys:** report objects are camelCase; outputs are parsedmarc's snake_case, converted in one place with `toSnakeCaseKeys()`. Don't hand-write snake_case keys in output code, and never rename keys inside `markRaw()` data or email `headers`.
- **JSON:** serialize reports with `pyJsonDumps()`, not `JSON.stringify()` (integers beyond 2^53 are `bigint`).
- **Dates:** use `PyDateTime` wherever Python uses `datetime`; naive values are local time. Timezone-sensitive tests use `withTz()`/`forceTz()` from `src/test/tz.ts`.
- **Regexes:** `u` flag, `\p{…}` where Python's Unicode-aware `\w`/`\d` matter, and parsedmarc's anti-backtracking rules for anything that touches untrusted input.
- **Untrusted input everywhere:** keep the 100 MiB decompression cap, no XML entity expansion, timeouts on every network call, TLS verification on by default, no secrets in logs (`sanitizeForLog()`, `redactUrlCredentials()`).
- **Package boundaries:** the core never imports an integration package. Integrations import from `'tsdmarc'` by package name. `@tsdmarc/search-common` is private and is bundled into the Elasticsearch/OpenSearch builds; it must never appear as a runtime import in `dist/`.
- **Runtimes:** Node ≥ 24, Bun and Deno. Only `node:*` modules all three support. ESM only.
- **Tests:** colocated `*.test.ts`; mock only at SDK/network boundaries and assert on what is sent; no real network.
- **Public API:** explicit named exports in `packages/tsdmarc/src/index.ts`; explicit types on exports (`isolatedDeclarations`).

## Changes and releases

- A change to a published package (`packages/*/src`, resources, or the published fields of its `package.json`) needs a changeset: `pnpm changeset`. CI's "Verify Changesets" fails without one.
- Commits are signed. Never publish to npm or push tags from a local machine: releases only go through `.github/workflows/release.yml` (Version Packages PR → tarballs → `Release` environment with OIDC and provenance).
- Workflow changes must pass actionlint and zizmor; pin actions by full SHA with a `# vX.Y.Z` comment and keep `persist-credentials: false`.
