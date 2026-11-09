---
title: CLI usage
description: The tsdmarc command, its options, and how it processes files and mailboxes.
---

The `tsdmarc` command (package `@tsdmarc/cli`) is a port of the `parsedmarc` command. It takes the same arguments and the same [configuration file](../configuration/).

## Help

```text
Usage: tsdmarc [options] [file_path...]

Parses DMARC and SMTP TLS reports

Arguments:
  file_path                           one or more paths to aggregate, failure,
                                      or SMTP TLS report files, emails, mbox
                                      files, or directories containing them

Options:
  -c, --config-file <config_file>     a path to a configuration file (--silent
                                      implied)
  -r, --recursive                     search directories given as file_path
                                      recursively, and enable '**' recursion in
                                      glob patterns
  --strip-attachment-payloads         remove attachment payloads from failure
                                      report output
  -o, --output <output>               write output files to the given directory
  --aggregate-json-filename <name>    filename for the aggregate JSON output
                                      file (default: "aggregate.json")
  --failure-json-filename <name>      filename for the failure JSON output file
                                      (default: "failure.json")
  --smtp-tls-json-filename <name>     filename for the SMTP TLS JSON output file
                                      (default: "smtp_tls.json")
  --aggregate-csv-filename <name>     filename for the aggregate CSV output file
                                      (default: "aggregate.csv")
  --failure-csv-filename <name>       filename for the failure CSV output file
                                      (default: "failure.csv")
  --smtp-tls-csv-filename <name>      filename for the SMTP TLS CSV output file
                                      (default: "smtp_tls.csv")
  -n, --nameservers <nameservers...>  nameservers to query: IP addresses,
                                      https:// URLs (DNS over HTTPS), and/or
                                      tls://ip[:port][#hostname] (DNS over TLS)
  -t, --dns-timeout <seconds>         number of seconds to wait for an answer
                                      from DNS (default: 2.0) (also accepted as
                                      --dns_timeout) (default: 2)
  --dns-retries <retries>             number of times to retry DNS queries on
                                      timeout or other transient errors
                                      (default: 0) (default: 0)
  --offline                           do not make online queries for geolocation
                                      or DNS
  -s, --silent                        only print errors
  -w, --warnings                      print warnings in addition to errors
  --verbose                           more verbose output
  --debug                             print debugging information
  --log-file <log_file>               output logging to a file
  --no-prettify-json                  output JSON in a single line without
                                      indentation
  -v, --version                       output the version number
  -h, --help                          show this help message and exit
```

Most settings live in the configuration file, as in parsedmarc since 6.0.0.

## Parsing files

```sh
# Print the parsed reports as JSON
tsdmarc report.xml.gz failure.eml tls-report.json

# Directories and glob patterns; ** needs --recursive
tsdmarc --recursive 'reports/**/*.zip' archive/

# Write JSON and CSV files instead of printing
tsdmarc --output ./output reports/

# No DNS or IP database downloads
tsdmarc --offline reports/
```

Each argument can be a report file (XML, JSON, zip, gzip), an email (`.eml`, or an Outlook `.msg` file when `msgconvert` is installed), an **mbox** file, or a directory. Files that are not reports are logged and skipped.

Unless it is silent, `tsdmarc` prints the results to standard output as one JSON object with `aggregate_reports`, `failure_reports` and `smtp_tls_reports` arrays, in parsedmarc's snake_case format:

```sh
tsdmarc --offline samples/smtp_tls/rfc8460.json
```

```json
{
  "aggregate_reports": [],
  "failure_reports": [],
  "smtp_tls_reports": [
    {
      "organization_name": "Company-X",
      "begin_date": "2016-04-01T00:00:00Z",
      "end_date": "2016-04-01T23:59:59Z",
      "contact_info": "sts-reporting@company-x.example",
      "report_id": "5065427c-23d3-47ca-b6e0-946ea0e8c4be",
      "policies": ["..."]
    }
  ]
}
```

:::note
`-c/--config-file` implies `--silent`: with a configuration file, results are not printed unless `[general] silent = False` is set.
:::

With `[general] archive_directory` set, files given on the command line are moved to `<archive_directory>/<year>/<month>/<Aggregate|Failure|SMTP-TLS>/` once their reports reached every output (if any output fails, they stay in place for the next run), and files that are not reports to `<archive_directory>/Invalid/`. See the [configuration reference](../configuration/#file-archiving).

## Processing a mailbox

When the configuration has an `[imap]`, `[msgraph]`, `[gmail_api]` or `[maildir]` section, `tsdmarc` reads reports from that mailbox (after any files given as arguments), files processed messages into the archive folder, and sends the results to every configured output:

```sh
tsdmarc -c /etc/tsdmarc.ini
```

With `[mailbox] watch = True`, it keeps running and processes new messages as they arrive (IMAP IDLE, or polling every `check_timeout` seconds for the other mailbox types). See [Mailboxes](../mailboxes/).

Messages are processed in batches of `batch_size`. Each batch is written to every output **before** its messages are archived or deleted; if any output fails, the batch stays in the reports folder and is retried, so a report is never removed from the mailbox while it exists nowhere else. After `max_unsaved_retries + 1` failed attempts (three by default) in the same process, the messages move to `<archive_folder>/Unsaved` instead (they are never deleted on this path). To recover after fixing the output, move them back to the reports folder or run once with `reports_folder = Archive/Unsaved`.

:::caution
Retrying a batch re-sends it. Elasticsearch, OpenSearch and PostgreSQL skip reports they already have, and S3 overwrites the same object key (or, with `prevent_overwrite`, leaves an identical object alone), but Kafka, Splunk HEC, syslog, GELF, webhooks, Loki, Log Analytics and the JSON/CSV files append, so each retry adds another copy. Unlike parsedmarc, a webhook that fails or answers with a non-2xx status, and syslog or GELF messages lost over TCP/TLS, count as output errors and hold the batch back; UDP syslog and GELF are best-effort.
:::

An output error never ends the run: it is logged (`Elasticsearch exception Error: …`, `PostgreSQL`, `Splunk HEC`, `File output`, …), the other reports and outputs are still saved, and the batch counts as not saved. parsedmarc lets some of these errors end the process, which with a mailbox repeats on every start.

Some messages are held back without being invalid:

- **Parsing timeouts and crashed workers.** A message that takes longer than `[general] job_timeout` to parse, or whose worker runs out of memory (`max_worker_heap_mb`) or crashes, is logged (`Timed out parsing message UID …`, `Worker failed parsing message UID …`), retried, and then moved to `Unsaved`, even with `delete` or `delete_invalid`. parsedmarc has no timeout, and a crashed worker ends its run.
- **Enrichment failures.** When enrichment can't work at all (a revoked `ipinfo_api_token`, no readable IP database), processing stops: nothing more is saved, moved or deleted, and the next run retries. In watch mode, IMAP and Maildir log the error and check again; Gmail and Microsoft Graph end the watch; a one-shot run exits with status 1. parsedmarc files those reports as invalid or empty, and deletes them with `delete`.

## Emailing the results

With an `[smtp]` section, a summary email with a zip of the JSON and CSV files is sent after a run that parsed at least one report. With `[msgraph]` configured and no `[smtp] host`, the email goes through Microsoft Graph instead. See [Outputs: email](../outputs/#email-smtp-or-microsoft-graph).

## Logging

Messages go to standard error as `LEVEL:tsdmarc:message`. By default only errors are shown; `--warnings`, `--verbose` (info) and `--debug` show more, and `--log-file` (or `[general] log_file`) also writes them to a file. Secret values and URL credentials are never logged.

## Exit status

| Status | Meaning |
| --- | --- |
| `0` | Success (including `--help` and `--version`) |
| `1` | Error: no input, a connection or setup failure (including `Maildir Error` when root can't switch to the Maildir's owner), an enrichment failure, or an output failure with `fail_on_output_error = True` |
| `2` | Invalid command-line arguments |
| `255` | Invalid configuration (missing or invalid settings), like parsedmarc's `sys.exit(-1)` |

## Reloading and stopping

In watch mode, `SIGHUP` reloads the configuration after the current batch, and `SIGTERM`/`SIGINT` stop after the current batch, closing every connection. See [Running as a service](../running-as-a-service/).

## Performance tuning

For large mailbox imports or backfills:

- Lower `[mailbox] batch_size` (for example `100`–`500` instead of no limit) to reduce peak memory and pressure on the outputs.
- Raise `[general] n_procs` to parse in several worker threads. It helps most when a run is bound by DNS/GeoIP enrichment. Each worker keeps its own DNS/GeoIP cache, at most about `2 × n_procs` messages are in flight, and DNS query volume can multiply by up to `n_procs`.
- Use `[mailbox] since` to catch up in smaller time windows (`1d`, `7d`, …).
- Set `strip_attachment_payloads = True` if failure reports carry large attachments you don't need.
- Run tsdmarc on a different host from Elasticsearch/OpenSearch, or reserve enough memory for both.
- Prefer frequent supervised runs (a systemd service or timer) over rare massive backfills.

## Multi-tenant support

tsdmarc can save each tenant's reports in Elasticsearch or OpenSearch indexes with their own prefix. Create a YAML file where each key is a tenant name and each value a list of that tenant's domains (without subdomains):

```yaml
example:
  - example.com
  - example.net
  - example.org

whalensolutions:
  - whalensolutions.com
```

Set `index_prefix_domain_map` to its path in `[general]`, and don't set `index_prefix` in `[elasticsearch]` or `[opensearch]`. A report for a domain in the map is saved in indexes prefixed with the tenant name and `_`; use your cluster's security features to give each user access to their indexes only. A domain can only belong to one tenant (the first list that contains it wins), and a file of any other shape is rejected at startup. `SIGHUP` re-reads the file.
