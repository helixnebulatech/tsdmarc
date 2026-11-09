# tsdmarc CLI examples

Configuration files for the `tsdmarc` command ([`@tsdmarc/cli`](../../packages/cli/README.md)).

| File | What it does |
| --- | --- |
| [`offline.ini`](offline.ini) | Parses report files without network access and writes JSON and CSV files to `output/` |
| [`config.ini`](config.ini) | Watches an IMAP mailbox, with commented-out Elasticsearch, Splunk HEC, S3 and Gmail API sections |

## Run the offline example

From the repository root:

```sh
pnpm install
pnpm build
node packages/cli/dist/bin.js -c examples/cli/offline.ini samples/aggregate/*.xml
```

With the CLI installed (`npm install -g @tsdmarc/cli`):

```sh
tsdmarc -c examples/cli/offline.ini samples/aggregate/*.xml
```

This writes `aggregate.json`, `aggregate.csv`, `failure.csv` and `smtp_tls.csv` to `output/` in the current directory (a JSON file is only written when there are reports of that type). Pass `samples/failure` and `samples/smtp_tls` as well to fill the other files; failure report sample emails go to `output/samples/`.

Environment variables override the file, for example to write somewhere else:

```sh
TSDMARC_GENERAL_OUTPUT=/tmp/tsdmarc-output node packages/cli/dist/bin.js -c examples/cli/offline.ini samples/aggregate/*.xml
```

## Run the mailbox example

Edit `host` and `user` in `config.ini`, and pass the password through the environment:

```sh
TSDMARC_IMAP_PASSWORD='...' tsdmarc -c examples/cli/config.ini
```

It keeps running (`[mailbox] watch = True`). Send `SIGHUP` to reload the file, `SIGTERM` or `Ctrl+C` to stop.

All keys and environment variables are listed in the [`@tsdmarc/cli` README](../../packages/cli/README.md). The format is the same as parsedmarc's ([usage docs](https://domainaware.github.io/parsedmarc/usage.html)).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
