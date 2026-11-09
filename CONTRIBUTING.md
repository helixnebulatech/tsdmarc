# Contributing to tsdmarc

Thanks for your interest in tsdmarc. Bug reports, reproductions (a sanitized report file that fails is very valuable), failing tests, docs fixes and pull requests are all welcome.

Before you start:

- Read the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security issues privately, as described in [SECURITY.md](.github/SECURITY.md), never in a public issue.
- For larger changes, open an issue first so we can agree on the approach.
- Read [architecture/README.md](architecture/README.md): packages, module map, conventions and the list of differences from parsedmarc.

## The 1:1 rule

tsdmarc is a 1:1 port of [parsedmarc](https://github.com/domainaware/parsedmarc). Parsing results, CSV/JSON output, documents sent to outputs, log messages and error types must match parsedmarc's. That is what lets users switch between the two, reuse parsedmarc's config files and dashboards, and trust the fixture tests.

- A bug that parsedmarc also has is usually fixed in parsedmarc first and then ported. Security fixes are the exception.
- Any deliberate difference (security hardening, a JavaScript runtime limitation, an API convention) must be added to the numbered list in [architecture/README.md](architecture/README.md#differences-from-parsedmarc), with what parsedmarc does and why tsdmarc differs.
- New features that change parsing or output belong in parsedmarc. Features specific to the TypeScript API, packaging or runtimes belong here.

## Setup

You need Node.js ≥ 24, [pnpm](https://pnpm.io) (the version in `package.json` → `packageManager`; `corepack enable` picks it up), and [tsrs](https://www.npmjs.com/package/tsrs) for type checking (`bun add -g tsrs`; CI pins the version in `.github/workflows/ci.yml`). Bun and Deno are only needed to run the smoke tests on those runtimes.

```bash
git clone https://github.com/helixnebulatech/tsdmarc.git
cd tsdmarc
pnpm install
pnpm build:packages
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Build every package with tsdown (`dist/`) |
| `pnpm type-check` | Type check every package with `tsrs --noEmit` |
| `pnpm test` | Run the Vitest suites of every package |
| `pnpm check` | Lint and format check (Ultracite: oxlint + oxfmt) |
| `pnpm fix` | Fix lint and formatting issues automatically |
| `pnpm publint` | Check package metadata (publint + Are The Types Wrong) |
| `pnpm pack:check` | Pack every package and check the tarballs (LICENSE, NOTICE, entry points) |
| `pnpm test:smoke` | Build, then run the built packages on Node, Bun and Deno against the fixtures |
| `pnpm changeset` | Add a changeset |

Type checking uses `tsrs` (a Rust port of the TypeScript 7 compiler) everywhere: scripts, Turborepo and CI. Don't add `tsc` to scripts or CI.

Run a single package's tests with `pnpm --filter tsdmarc test` (or `cd packages/tsdmarc && pnpm vitest --run src/aggregate.test.ts`).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change with tests. Tests live next to the module (`*.test.ts`). Mock only at the boundary with external SDKs (`vi.mock('@elastic/elasticsearch')`, a fake `fetch`, ...) and assert on what is sent; tests never need network access. See the "Tests" section of [architecture/README.md](architecture/README.md#tests).
3. Run `pnpm fix`, then `pnpm check`, `pnpm type-check` and `pnpm test`.
4. Add a changeset if you changed a published package (`packages/*`): run `pnpm changeset`, pick the packages and the bump type, and describe the change for the changelog. CI fails without one (maintainers can add the `no-changeset` label for changes that don't need a release).
5. Sign your commits; unsigned commits can't be merged.
6. Open the pull request and fill in the template.

## Releases

Releases go through [changesets](https://github.com/changesets/changesets) and `.github/workflows/release.yml`:

1. Every PR that changes a published package adds a changeset (`pnpm changeset`).
2. On `main`, the release workflow opens or updates the "Version Packages" PR and runs CI on it.
3. Merging that PR starts the "Publish to npm" job in the protected `Release` environment. A maintainer approves it, and it publishes with npm trusted publishing (OIDC) and provenance; no npm token is stored anywhere.
4. A separate job then creates the `name@version` tags and GitHub Releases and attaches the provenance.

Snapshot releases (`workflow_dispatch` with `snapshot`) also go through the `Release` environment and use the `snapshot` dist-tag.

## Porting a new parsedmarc version

parsedmarc and mailsuite are followed commit by commit. The commits currently ported are recorded in [NOTICE](NOTICE).

1. **Get the sources.** Clone both projects into `upstream/` (ignored by git) at the new release:

   ```bash
   git clone https://github.com/domainaware/parsedmarc.git upstream/parsedmarc
   git clone https://github.com/seanthegeek/mailsuite.git upstream/mailsuite
   git -C upstream/parsedmarc checkout <new tag or commit>
   git -C upstream/mailsuite checkout <new tag or commit>
   ```

2. **Read the diff** between the commit in `NOTICE` and the new one (`git -C upstream/parsedmarc diff <old>..<new>`), including the tests and the changelog. Only the parts of mailsuite that parsedmarc uses are ported (`mailsuite.mailbox` and `mailsuite.smtp.send_email`).
3. **Regenerate the fixtures** with the new parsedmarc, as described in [tools/fixtures/README.md](tools/fixtures/README.md):

   ```bash
   uv venv .venv -p python3.14
   uv pip install -p .venv/bin/python "./upstream/parsedmarc[all,postgresql]" ./upstream/mailsuite
   pnpm fixtures
   ```

   Copy new files from parsedmarc's `samples/` into `samples/` first, and new resource files (`base_reverse_dns_map.csv`, `psl_overrides.txt`, ...) into `packages/tsdmarc/resources/`. Copy updated dashboards into `dashboards/`.

4. **Port the diff**, module by module (the module map in `architecture/README.md` says which TypeScript file ports which Python file), and port the new or changed tests.
5. **Check:** `pnpm test`, `pnpm test:smoke`, `pnpm type-check`, `pnpm check`. The fixture tests show any output that no longer matches.
6. **Update the records:** the version and commits in `NOTICE`, `PARSEDMARC_COMPAT_VERSION` in `packages/tsdmarc/src/constants.ts`, the version in `architecture/README.md`, and any new difference in its list. Add a changeset describing what changed for users.

## Questions

Open a [discussion or issue](https://github.com/helixnebulatech/tsdmarc/issues). For questions about what a config option or a dashboard does, parsedmarc's [documentation](https://domainaware.github.io/parsedmarc/) applies to tsdmarc too.

---

Created by [HelixNebula](https://helixnebula.tech).
