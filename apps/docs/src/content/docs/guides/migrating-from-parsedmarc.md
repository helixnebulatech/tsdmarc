---
title: Migrating from parsedmarc
description: What stays identical when you move from parsedmarc to tsdmarc, and the deliberate differences.
---

tsdmarc is a 1:1 port of parsedmarc 11.2.1 and mailsuite 2.3.4. For most deployments, migrating means installing `@tsdmarc/cli` and running `tsdmarc` with your existing configuration.

## What stays the same

- **Configuration file.** The INI format, sections, options, defaults and deprecated aliases are parsedmarc's. Point `tsdmarc -c` at your existing `parsedmarc.ini`.
- **Environment variables.** `PARSEDMARC_*` variables (including `_FILE` secrets, `PARSEDMARC_CONFIG_FILE` and `DEBUG`) still work.
- **Command line.** Same arguments and options, including `--dns_timeout`.
- **Output.** JSON, CSV, Elasticsearch/OpenSearch documents and index names, PostgreSQL tables, Splunk, Kafka, S3, webhook, Log Analytics, syslog and GELF payloads have the same fields and content. tsdmarc's tests compare its output for every sample report with parsedmarc's.
- **Dashboards.** Kibana, OpenSearch Dashboards, Grafana and Splunk dashboards work unchanged, on data written by either tool.
- **Mailboxes.** Same folder layout (`Archive/Aggregate`, `Failure`, `SMTP-TLS`, `Invalid`, `Unsaved`). The Gmail `token.json` and the Microsoft Graph token cache (still named `parsedmarc`) are reused.
- **Behavior.** Log messages, error types, retries, batching, deduplication, `SIGHUP` reloads and the enrichment data sources (IPinfo Lite, parsedmarc's reverse DNS map and PSL overrides) are the same.

## Moving a deployment

1. Install Node.js 24+ and `@tsdmarc/cli` (see [Installation](../../getting-started/installation/)).
2. Stop parsedmarc.
3. Start `tsdmarc -c /etc/parsedmarc.ini` (or rename the file), in the same systemd unit with a new `ExecStart` (see [Running as a service](../running-as-a-service/)).
4. Optionally rename `PARSEDMARC_*` variables to `TSDMARC_*`. If both exist, `TSDMARC_*` wins.
5. Check whether the stricter defaults below affect you: plain-text IMAP/SMTP logins, GELF TLS verification, the size and time limits, webhook errors that now hold a batch back, and Maildir access as root.

There are no "extras" to install: `@tsdmarc/cli` includes every integration.

## Differences

The authoritative, numbered list is in [architecture/README.md — Differences from parsedmarc](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc). The main ones, grouped by theme:

### API and naming

- The library API is camelCase (`parse_report_file` → `parseReportFile`, `report["policy_published"]["domain"]` → `report.policyPublished.domain`); keyword arguments become an options object; I/O is `async`. Output content is unchanged.
- Mailbox connections expose `kind` and have `close()`. IMAP, Kafka, PostgreSQL and syslog clients connect with an explicit async step (`IMAPConnection.connect()`, `KafkaClient.create()`, …).
- `getDmarcReportsFromMailbox()` takes `since` as a string, accepts an async `saveCallback`, and `watchInbox()` accepts an `AbortSignal`.
- The CLI's `main()` throws `SystemExit` instead of exiting; output clients and mailboxes are always closed on exit. Console log lines are `LEVEL:tsdmarc:message`; the default SMTP subject is `tsdmarc report`.
- JSON is equal in content to parsedmarc's but non-ASCII text is not `\u`-escaped.

### Security hardening

- **GELF over TLS verifies certificates** by default (pygelf doesn't); new `cafile` and `skip_certificate_verification` options.
- **Email size limits:** `max_email_size` (50 MiB) and `max_mime_parts` (10,000), new in tsdmarc; oversized messages go to `Invalid`. Also `max_header_lines` and `max_expanded_email_size`.
- **Report and work limits:** `max_xml_depth`, `max_xml_nodes`, `max_normalized_records`, `max_smtp_tls_report_size`, `max_lookups_per_report`, `max_failed_lookups_per_report`, `max_lookup_time_per_report`, `job_timeout` and `max_worker_heap_mb`, new in tsdmarc, so one hostile report can't exhaust memory or stall a run (see [Security](../security/#parsing-untrusted-input)). `0` disables each one.
- **PostgreSQL TLS:** new `[postgresql]` `sslmode`, `sslrootcert`, `sslcert` and `sslkey`; the default stays `prefer`, and falling back to plain text now logs a warning recommending `sslmode = verify-full`. Options pg can't enforce (`channel_binding=require`, …) refuse the connection.
- **Maildir as root:** if root can't switch to the Maildir's owner, tsdmarc exits with `Maildir Error` instead of going on as root.
- **Decompression caps:** 100 MiB, and 10 MiB for bzip2/LZMA/Zstandard zip members.
- **No credentials in logs:** as in parsedmarc 11.2, URL passwords are shown as `***` (`user:***@`); tsdmarc also masks credentials in the query string and in more error messages.
- **Safer files:** zip attachments leave out parsedmarc's `../` sample entries; sample file names drop control and bidi characters; the download cache is a private per-user directory; the Gmail token is written with mode `0600`.
- Response bodies from Splunk and webhooks are capped at 1 MiB; deeply nested reports (over 512 levels) are rejected.

### Saving and archiving

- Files given on the command line are moved to `archive_directory` only after their reports reached every output; parsedmarc archives them right after parsing.
- An output error never ends the run, and a webhook that fails, or syslog/GELF messages lost over TCP/TLS, count as output errors (parsedmarc only logs them, then archives or deletes the messages).
- Messages that time out or crash their parsing worker go to `Unsaved` after their retries, never to `Invalid`; enrichment failures (a revoked IPinfo token, no IP database) stop the run instead of filing reports as invalid.
- JSON files are replaced atomically and a corrupt one is kept as `.corrupt-<timestamp>`; failure samples are never overwritten.

### Integrations

- **Elasticsearch** uses the v9 client (parsedmarc pins v8), sending `compatible-with=8` so it works with Elasticsearch 8 and 9.
- **Elasticsearch and OpenSearch** spread one aggregate report over at most `max_indexes_per_report` (31) indexes, create new indexes with explicit date mappings, and map only a fixed list of failure sample headers. In the library, `createClient()` and the `client` option allow several clusters in one process.
- **Kafka** with a username and password uses TLS + SASL PLAIN (parsedmarc's client silently skips SASL). `[kafka] ssl` is honored.
- **PostgreSQL** uses `pg` with libpq's rules (connection strings, `PG*` variables, `sslmode`) rebuilt on top.
- **IMAP** uses imapflow; OAuth2 picks OAUTHBEARER or XOAUTH2 itself.
- **Microsoft Graph:** certificates must be PEM; a persistent `DeviceCode` token cache needs the optional `@azure/identity-cache-persistence`.
- **Gmail:** the browser sign-in is a local loopback server with PKCE.
- **S3** keys and metadata are the same as parsedmarc 11.2's; with `prevent_overwrite = True` (tsdmarc only), an existing object is never replaced.
- **Loki** labels streams with the host name the OS reports (`os.hostname()`), where parsedmarc uses the FQDN.
- **PostgreSQL** statements time out after `query_timeout` (300 s).
- **Log Analytics** leaves out reports over its 1,000,000-byte request limit, with a warning.
- **Syslog and GELF** clients have their own logger each and reconnect over TCP/TLS.
- **Splunk** events use the OS host name and `source: "tsdmarc"`.
- **`@tsdmarc/smtp`** only ports what parsedmarc uses from mailsuite (no DKIM signing or SMTP OAuth2).

### Runtime and environment

- Environment variables: `TSDMARC_*`, with `PARSEDMARC_*` accepted. A bare `DEBUG` that isn't a boolean (`DEBUG=*`) is ignored with a warning instead of stopping the start.
- Proxies apply to downloads only with `NODE_USE_ENV_PROXY=1` (Node.js); extra CAs go in `NODE_EXTRA_CA_CERTS` instead of `SSL_CERT_FILE`.
- Downloads are cached in `~/.cache/tsdmarc` (or `$XDG_CACHE_HOME/tsdmarc`, `%LOCALAPPDATA%\tsdmarc`) instead of a shared temporary directory.
- Parallel parsing (`n_procs`) uses worker threads instead of processes; a crashed worker fails only its job.
- `--dns_timeout` is accepted; signals stop a waiting watch immediately.

### Edge cases

Dates are parsed by a port of dateutil, email by ports of Python's `email` package and mail-parser, zip/zlib by ports of CPython's `zipfile` and zlib, and XML by a port of Expat, so error messages and edge cases match parsedmarc. The few remaining differences (some time zone abbreviations, legacy Zstandard frames, a few rare codecs, recursion limits) are documented in the list linked above.

## Changing code that used parsedmarc

```python
# parsedmarc
from parsedmarc import parse_report_file, ParserConfig
config = ParserConfig(offline=True)
report = parse_report_file("report.xml.gz", config=config)
print(report["report"]["policy_published"]["domain"])
```

```ts
// tsdmarc
import { createParserConfig, parseReportFile } from 'tsdmarc';
const config = createParserConfig({ offline: true });
const parsed = await parseReportFile('report.xml.gz', { config });
if (parsed.reportType === 'aggregate') {
  console.log(parsed.report.policyPublished.domain);
}
```
