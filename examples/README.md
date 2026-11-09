# tsdmarc examples

Small runnable examples. They use the repository's `samples/` and run offline: GeoIP data comes from `@tsdmarc/ipinfo-lite` and the reverse DNS map from the copy bundled with `tsdmarc`.

| Directory | Runtime | Examples |
| --- | --- | --- |
| [`node/`](node) | Node.js ≥ 24 | `src/parse-file.ts`: parse one report file and print it as JSON and CSV. `src/maildir.ts`: process a Maildir with `getDmarcReportsFromMailbox()` and save the results with `saveOutput()`. |
| [`bun/`](bun) | Bun | `src/parse-file.ts` (same as Node) |
| [`deno/`](deno) | Deno 2 | `src/parse-file.ts` (same as Node) |
| [`cli/`](cli) | any | Example `config.ini` files for the `tsdmarc` command |

## Running

The examples are private workspace packages that import the built packages (`dist/`), so build first:

```bash
pnpm install
pnpm build:packages
```

Node.js (≥ 24 runs TypeScript files directly):

```bash
cd examples/node
node src/parse-file.ts                                   # a sample aggregate report
node src/parse-file.ts ../../samples/smtp_tls/rfc8460.json
node src/maildir.ts                                      # a temporary Maildir built from samples/
node src/maildir.ts ~/Maildir ./output                   # your own Maildir (messages are moved to Archive/*)
```

Bun:

```bash
cd examples/bun
bun src/parse-file.ts ../../samples/failure/dmarc_ruf_report_linkedin.eml
```

Deno (uses the workspace's `node_modules`):

```bash
cd examples/deno
deno run --allow-read --allow-env --node-modules-dir=manual src/parse-file.ts
```

Each package also has a `parse-file` script (`pnpm --filter @tsdmarc/example-node parse-file`).

## Outside this repository

Install the packages from npm and import them the same way:

```bash
npm install tsdmarc @tsdmarc/ipinfo-lite
```

`@tsdmarc/ipinfo-lite` is optional. Without it, tsdmarc downloads the IP database the first time it needs it (unless `offline: true`).

---

Created by [HelixNebula](https://helixnebula.tech).
