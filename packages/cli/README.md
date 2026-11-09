# @tsdmarc/cli

The `tsdmarc` command: parses DMARC aggregate, DMARC failure and SMTP TLS reports from files, mailboxes (IMAP, Microsoft Graph, Gmail API, Maildir) and mbox files, and saves the results to JSON/CSV files or to Elasticsearch, OpenSearch, Splunk, Kafka, S3, PostgreSQL, Azure Log Analytics, syslog, GELF and webhooks.

It is a port of the [parsedmarc](https://github.com/domainaware/parsedmarc) CLI: same command-line options, same INI configuration file format and keys, same environment variables (`PARSEDMARC_*` also works), and the same output.

Requires Node.js 24 or later.

## Install

```sh
npm install -g @tsdmarc/cli
tsdmarc --help
```

Or without installing:

```sh
npx @tsdmarc/cli --help
```

The package depends on every `@tsdmarc/*` package, including `@tsdmarc/ipinfo-lite` (the 25 MB IPinfo Lite GeoIP database), so it works offline out of the box.

## Usage

```sh
# Parse report files and print the results as JSON
tsdmarc samples/aggregate/*.xml

# Also accepts .zip/.gz files, report emails, mbox files and directories
# (Outlook .msg files need the msgconvert utility, as in parsedmarc)
tsdmarc -r reports/

# Write aggregate/failure/SMTP TLS JSON and CSV files to a directory
tsdmarc -o output/ reports/*.eml

# No DNS lookups or downloads (bundled GeoIP database, reverse DNS map and PSL overrides)
tsdmarc --offline reports/*.xml

# Use DNS over HTTPS or DNS over TLS (-n takes several values: put it after the files)
tsdmarc reports/*.xml -n https://cloudflare-dns.com/dns-query
tsdmarc reports/*.xml -n tls://1.1.1.1#cloudflare-dns.com

# Read everything from a configuration file (implies --silent)
tsdmarc -c config.ini
```

Watch a mailbox and process new reports as they arrive:

```ini
[general]
save_aggregate = True
save_failure = True
save_smtp_tls = True

[mailbox]
watch = True

[imap]
host = imap.example.com
user = dmarc-reports@example.com
```

```sh
TSDMARC_IMAP_PASSWORD='...' tsdmarc -c config.ini
```

`watch = True` in `[imap]` is still accepted (deprecated, with a warning, as in parsedmarc). See [examples/cli](https://github.com/helixnebulatech/tsdmarc/tree/main/examples/cli) for a commented `config.ini` and a fully offline `offline.ini`.

## Command-line options

```
Usage: tsdmarc [options] [file_path...]

Arguments:
  file_path                           one or more paths to aggregate, failure,
                                      or SMTP TLS report files, emails, mbox
                                      files, or directories containing them
```

| Option | Description |
| --- | --- |
| `-c, --config-file <config_file>` | A path to a configuration file (`--silent` implied) |
| `-r, --recursive` | Search directories given as `file_path` recursively, and enable `**` recursion in glob patterns |
| `--strip-attachment-payloads` | Remove attachment payloads from failure report output |
| `-o, --output <output>` | Write output files to the given directory |
| `--aggregate-json-filename <name>` | Filename for the aggregate JSON output file (default `aggregate.json`) |
| `--failure-json-filename <name>` | Filename for the failure JSON output file (default `failure.json`) |
| `--smtp-tls-json-filename <name>` | Filename for the SMTP TLS JSON output file (default `smtp_tls.json`) |
| `--aggregate-csv-filename <name>` | Filename for the aggregate CSV output file (default `aggregate.csv`) |
| `--failure-csv-filename <name>` | Filename for the failure CSV output file (default `failure.csv`) |
| `--smtp-tls-csv-filename <name>` | Filename for the SMTP TLS CSV output file (default `smtp_tls.csv`) |
| `-n, --nameservers <nameservers...>` | Nameservers to query: IP addresses, `https://` URLs (DNS over HTTPS) and/or `tls://ip[:port][#hostname]` (DNS over TLS) |
| `-t, --dns-timeout <seconds>` | Seconds to wait for an answer from DNS (default `2.0`; `--dns_timeout` also accepted) |
| `--dns-retries <retries>` | Times to retry DNS queries on timeout or other transient errors (default `0`) |
| `--offline` | Do not make online queries for geolocation or DNS |
| `-s, --silent` | Only print errors |
| `-w, --warnings` | Print warnings in addition to errors |
| `--verbose` | More verbose output |
| `--debug` | Print debugging information |
| `--log-file <log_file>` | Output logging to a file |
| `--no-prettify-json` | Output JSON in a single line without indentation |
| `-v, --version` | Print the version number |
| `-h, --help` | Show the help message and exit |

## Configuration file

The INI file is compatible with parsedmarc's: an existing parsedmarc configuration works unchanged. Booleans accept `True`/`False`, `yes`/`no`, `on`/`off` and `1`/`0`; lists are comma-separated. For the meaning and defaults of every key, see the [parsedmarc usage docs](https://domainaware.github.io/parsedmarc/usage.html).

| Section | Configures | Package |
| --- | --- | --- |
| `[general]` | What to save, output files, DNS, GeoIP, logging, parallelism | `tsdmarc` |
| `[mailbox]` | Folders, watch mode, deletion and batching (all mailbox types) | `tsdmarc` |
| `[imap]` | IMAP mailbox | `@tsdmarc/imap` |
| `[msgraph]` | Microsoft 365 mailbox through Microsoft Graph | `@tsdmarc/msgraph` |
| `[gmail_api]` | Gmail mailbox through the Gmail API | `@tsdmarc/gmail` |
| `[maildir]` | Local Maildir | `tsdmarc` |
| `[elasticsearch]` | Elasticsearch 9 output | `@tsdmarc/elasticsearch` |
| `[opensearch]` | OpenSearch output | `@tsdmarc/opensearch` |
| `[splunk_hec]` | Splunk HTTP Event Collector output | `tsdmarc` |
| `[kafka]` | Kafka output | `@tsdmarc/kafka` |
| `[s3]` | Amazon S3 (or compatible) output | `@tsdmarc/s3` |
| `[postgresql]` | PostgreSQL output | `@tsdmarc/postgres` |
| `[log_analytics]` | Azure Monitor Log Analytics output | `@tsdmarc/loganalytics` |
| `[syslog]` | Syslog output (UDP, TCP, TLS) | `tsdmarc` |
| `[gelf]` | GELF output (Graylog) | `tsdmarc` |
| `[webhook]` | Webhook output (JSON POST per report) | `tsdmarc` |
| `[loki]` | Grafana Loki output (one JSON log line per record) | `tsdmarc` |
| `[smtp]` | Email the results as a ZIP attachment | `@tsdmarc/smtp` |

Keys accepted in each section (aliases in parentheses):

- `[general]`: `save_aggregate`, `save_failure` (`save_forensic`), `save_smtp_tls`, `output`, `aggregate_json_filename`, `failure_json_filename` (`forensic_json_filename`), `smtp_tls_json_filename`, `aggregate_csv_filename`, `failure_csv_filename` (`forensic_csv_filename`), `smtp_tls_csv_filename`, `csv_formula_escape`, `prettify_json`, `strip_attachment_payloads`, `archive_directory`, `index_prefix_domain_map`, `normalize_timespan_threshold_hours`, `offline`, `nameservers`, `dns_test_address`, `dns_timeout`, `dns_retries`, `ip_db_path`, `ipinfo_url` (`ip_db_url`, deprecated), `ipinfo_api_token`, `always_use_local_files`, `local_reverse_dns_map_path`, `reverse_dns_map_url`, `local_psl_overrides_path`, `psl_overrides_url`, `max_email_size`, `max_mime_parts`, `max_header_lines`, `max_expanded_email_size`, `max_normalized_records`, `max_xml_depth`, `max_xml_nodes`, `max_smtp_tls_report_size`, `max_lookups_per_report`, `max_failed_lookups_per_report`, `max_lookup_time_per_report`, `job_timeout`, `max_worker_heap_mb`, `n_procs`, `silent`, `warnings`, `verbose`, `debug`, `log_file`, `fail_on_output_error`
- `[mailbox]`: `reports_folder`, `archive_folder`, `watch`, `delete`, `delete_aggregate`, `delete_failure`, `delete_smtp_tls`, `delete_invalid`, `test`, `batch_size`, `check_timeout`, `max_unsaved_retries`, `since`
- `[imap]`: `host`, `port`, `ssl`, `starttls`, `skip_certificate_verification`, `timeout`, `max_retries`, `user`, `password`; deprecated (use `[mailbox]`): `reports_folder`, `archive_folder`, `watch`, `delete`, `test`, `batch_size`
- `[msgraph]`: `auth_method` (`UsernamePassword`, `DeviceCode`, `ClientSecret`, `Certificate`, `ClientAssertion`), `user`, `password`, `client_id`, `client_secret`, `certificate_path`, `certificate_password`, `client_assertion`, `tenant_id`, `mailbox`, `graph_url` (`url`), `token_file`, `allow_unencrypted_storage`
- `[gmail_api]`: `credentials_file`, `token_file`, `auth_mode`, `service_account_user` (`delegated_user`), `include_spam_trash`, `paginate_messages`, `scopes`, `oauth2_port`
- `[maildir]`: `maildir_path` (`path`), `maildir_create` (`create`)
- `[elasticsearch]`: `hosts`, `user`, `password`, `api_key` (`apiKey`), `ssl`, `cert_path`, `skip_certificate_verification`, `timeout`, `index_prefix`, `index_suffix`, `monthly_indexes`, `number_of_shards`, `number_of_replicas`, `use_data_streams`, `serverless`, `max_indexes_per_report`
- `[opensearch]`: the `[elasticsearch]` keys except `serverless`, plus `auth_type` (`authentication_type`), `aws_region`, `aws_service`
- `[splunk_hec]`: `url`, `token`, `index`, `skip_certificate_verification`
- `[kafka]`: `hosts`, `user`, `password`, `ssl`, `skip_certificate_verification`, `aggregate_topic`, `failure_topic` (`forensic_topic`), `smtp_tls_topic`
- `[s3]`: `bucket`, `path`, `region_name`, `endpoint_url`, `access_key_id`, `secret_access_key`, `prevent_overwrite`
- `[postgresql]`: `connection_string`, or `host`, `port`, `user`, `password`, `database`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`; `query_timeout`
- `[log_analytics]`: `client_id`, `client_secret`, `tenant_id`, `dce`, `dcr_immutable_id`, `dcr_aggregate_stream`, `dcr_failure_stream` (`dcr_forensic_stream`), `dcr_smtp_tls_stream`
- `[syslog]`: `server`, `port`, `protocol`, `cafile_path`, `certfile_path`, `keyfile_path`, `timeout`, `retry_attempts`, `retry_delay`
- `[gelf]`: `host`, `port`, `mode`, `cafile`, `skip_certificate_verification`
- `[webhook]`: `aggregate_url`, `failure_url` (`forensic_url`), `smtp_tls_url`, `timeout`
- `[loki]`: `url`, `labels`, `label_fields`, `timestamp`, `username`, `password`, `token`, `tenant_id`, `skip_certificate_verification`, `timeout`, `batch_size`
- `[smtp]`: `host`, `port`, `ssl`, `starttls`, `skip_certificate_verification`, `user`, `password`, `from`, `to`, `subject`, `attachment`, `message`

### Keys not in parsedmarc

| Key | Default | Description |
| --- | --- | --- |
| `[general] csv_formula_escape` | `True` | Prefix CSV text cells starting with `=`, `+`, `-`, `@`, tab or CR with `'` (as parsedmarc 11.1.0 and later always do). `False` writes cells unchanged. |
| `[general] max_email_size` | `52428800` (50 MiB) | Largest email parsed, in bytes; larger messages are moved to the invalid folder. `0` disables the limit. |
| `[general] max_mime_parts` | `10000` | Largest number of MIME parts (lines starting with `--`) in an email. `0` disables the limit. |
| `[general] max_header_lines` | `100000` | Most header lines in an email, over all its parts. `0` disables the limit. |
| `[general] max_expanded_email_size` | `536870912` (512 MiB) | Most text, in characters, re-serializing the parts of one email may produce (size × nesting depth; characters of text beyond Latin-1 count twice). `0` disables the limit. |
| `[general] max_normalized_records` | `250000` | Most records of an aggregate report once split into daily buckets; larger reports are invalid. `0` disables the limit. |
| `[general] max_xml_depth` | `100000` | Deepest element nesting in an aggregate report's XML. `0` disables the limit. |
| `[general] max_xml_nodes` | `5000000` | Most elements and attributes in an aggregate report's XML. `0` disables the limit. |
| `[general] max_smtp_tls_report_size` | `10485760` (10 MiB) | Largest SMTP TLS report, in bytes of JSON. `0` disables the limit. |
| `[general] max_lookups_per_report` | `100000` | Most source IPs of one aggregate report looked up over the network; later IPs only get the IP database. `0` disables the limit. |
| `[general] max_failed_lookups_per_report` | `256` | Most reverse DNS lookups of one aggregate report that may fail or time out before the rest are skipped. `0` disables the limit. |
| `[general] max_lookup_time_per_report` | `600` | Seconds of network lookups (reverse DNS, IPinfo API) one aggregate report may use before the rest are skipped. `0` disables the limit. |
| `[general] job_timeout` | `3600` | Seconds one email or file may take to parse; a mailbox message over it is retried, then moved to `Unsaved`. `0` disables the limit. |
| `[general] max_worker_heap_mb` | `2048` | Heap limit of each parsing worker, in MiB (ignored by Bun). `0` keeps the runtime's limit. |
| `[elasticsearch] max_indexes_per_report`, `[opensearch] max_indexes_per_report` | `31` | Most indexes one aggregate report may spread over; later records go to its first index. `0` disables the limit. |
| `[s3] prevent_overwrite` | `False` | Never replace an existing S3 object; a different report with the same key is saved as `<id>_<hash>-<sha256>.json`. Needs `s3:GetObject` and conditional writes. |
| `[postgresql] sslmode`, `sslrootcert`, `sslcert`, `sslkey` |  | libpq TLS settings, with `host`. With `connection_string` they are ignored (an error is logged): put them in the string. |
| `[postgresql] query_timeout` | `300` | Seconds to wait for each statement. `0` waits forever (parsedmarc's behavior). |
| `[gelf] cafile` |  | With `mode = tls`, a CA bundle added to the system CAs to verify the Graylog certificate. |
| `[gelf] skip_certificate_verification` | `False` | With `mode = tls`, do not verify the Graylog certificate (parsedmarc's behavior). |

A webhook that can't be reached, times out or answers with a status other than 2xx is an output error, as with the other outputs: the mailbox keeps the email for the next attempt (up to `[mailbox] max_unsaved_retries` retries, then it moves to `Unsaved`), and `fail_on_output_error` applies. parsedmarc only logs it, so the email is archived or deleted all the same.

Other behavior that differs from parsedmarc:

- Files given on the command line are moved to `archive_directory` only after their reports reached every output; if any output fails, none is moved and the next run processes them again.
- An output error never ends the run: it is logged, the other reports and outputs are still saved, and the batch counts as not saved. Syslog and GELF messages lost over TCP/TLS are output errors too.
- Mailbox messages that time out (`job_timeout`) or crash their parsing worker are retried and then moved to `Unsaved`, never deleted. When enrichment can't work at all (a revoked IPinfo token, no IP database), mailbox processing stops and nothing more is moved or deleted.
- Run as root over a Maildir it can't switch to the owner of, the CLI exits with `Maildir Error`.
- Without the `https://mail.google.com/` scope, Gmail deletion is turned off, also after a `SIGHUP` reload.

These and every other difference are listed in [Differences from parsedmarc](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc).

## Environment variables

- Any key can be set with `TSDMARC_{SECTION}_{KEY}` (uppercase), for example `TSDMARC_IMAP_PASSWORD`, `TSDMARC_SPLUNK_HEC_TOKEN`, `TSDMARC_GENERAL_SAVE_AGGREGATE=true`. Environment variables override the configuration file.
- parsedmarc's `PARSEDMARC_{SECTION}_{KEY}` names are also accepted. If both are set, `TSDMARC_*` wins.
- `{NAME}_FILE` reads the value from a file, without trailing CR/LF (Docker and Kubernetes secrets): `TSDMARC_IMAP_PASSWORD_FILE=/run/secrets/imap_password`. It wins over the direct variable; a missing or unreadable file is a configuration error. Keys whose own name ends in `_file` (`GENERAL_LOG_FILE`, `MSGRAPH_TOKEN_FILE`, `GMAIL_API_CREDENTIALS_FILE`, `GMAIL_API_TOKEN_FILE`) take the path directly; append another `_FILE` to read them from a secret.
- `TSDMARC_CONFIG_FILE` (or `PARSEDMARC_CONFIG_FILE`) names the configuration file when `-c` is not given.
- `TSDMARC_DEBUG`, `PARSEDMARC_DEBUG` and `DEBUG` are aliases of `[general] debug`. A `DEBUG` that isn't a boolean (such as `DEBUG=*`, common with Node tools) is ignored with a warning.
- With no configuration file, `TSDMARC_*` / `PARSEDMARC_*` variables alone configure the run:

```sh
TSDMARC_GENERAL_OFFLINE=true TSDMARC_GENERAL_OUTPUT=output tsdmarc reports/*.xml
```

## Reloading the configuration

In watch mode, `SIGHUP` reloads the configuration file (and environment variables) after the current batch finishes, without restarting: output destinations, the `index_prefix_domain_map` file, DNS and GeoIP settings, processing flags and the log level. Mailbox connection settings need a restart. If the new configuration has an error, the whole reload is aborted and the previous configuration stays active.

`SIGTERM` and `SIGINT` stop the watch gracefully; a second `SIGINT` exits immediately with status 130.

## Exit status

| Status | When |
| --- | --- |
| `0` | Success, `--help`, `--version` |
| `1` | Runtime errors (mailbox or output errors, no input given, uncaught errors) |
| `2` | Usage errors (unknown option, invalid value) |
| `255` | Configuration errors (missing file or setting, invalid value) |
| `130` | Second `SIGINT` |

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
