---
title: Configuration reference
description: Every section and option of the tsdmarc INI configuration file, with types and defaults.
---

The `tsdmarc` command is configured with an INI file, compatible with parsedmarc's. Every option can also be set with an [environment variable](../environment-variables/).

```sh
tsdmarc -c /etc/tsdmarc.ini
```

Values in the file (and in environment variables) override the matching command-line options, and using a configuration file implies `silent`.

## Example

```ini title="/etc/tsdmarc.ini"
# This is an example comment

[general]
save_aggregate = True
save_failure = True

[imap]
host = imap.example.com
user = dmarcreports@example.com
password = $uperSecure

[mailbox]
watch = True
delete = False

[elasticsearch]
hosts = 127.0.0.1:9200
ssl = False

[opensearch]
hosts = https://127.0.0.1:9200
user = admin
password = admin
ssl = True

[splunk_hec]
url = https://splunkhec.example.com
token = HECTokenGoesHere
index = email

[s3]
bucket = my-bucket
path = tsdmarc

[syslog]
server = localhost
port = 514

[gelf]
host = logger
port = 12201
mode = tcp

[webhook]
aggregate_url = https://aggregate_url.example.com
failure_url = https://failure_url.example.com
smtp_tls_url = https://smtp_tls_url.example.com
timeout = 60

[loki]
url = http://loki.example.com:3100
labels = host=mail.example.com
```

## File format

- Python `configparser` syntax: `key = value` (or `key: value`), `#` and `;` full-line comments, indented continuation lines. No interpolation: `%` and `$` are taken literally, except that **path** options expand `~` and `$VARIABLES`.
- **Booleans** accept `true`/`false`, `yes`/`no`, `on`/`off` and `1`/`0`, in any case.
- **Lists** are comma-separated (`hosts = a:9200, b:9200`).
- Option types below: `str`, `int`, `float`, `bool`, `list` (comma-separated) and `path` (a string with `~` and `$VAR` expanded).
- Options marked **tsdmarc only** don't exist in parsedmarc; parsedmarc ignores them, so a file using them still works there.
- Deprecated aliases from older parsedmarc versions are still accepted.

## `[general]`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `save_aggregate` | bool | `False` | Send aggregate reports to the configured outputs (Elasticsearch, OpenSearch, Splunk, Kafka, S3, PostgreSQL, syslog, GELF, webhook, Log Analytics) |
| `save_failure` | bool | `False` | The same for failure reports. Alias: `save_forensic` |
| `save_smtp_tls` | bool | `False` | The same for SMTP TLS reports |
| `output` | path | — | Directory for the JSON and CSV files. The filename options below only apply when this is set |
| `aggregate_json_filename` | str | `aggregate.json` | Aggregate JSON file name |
| `failure_json_filename` | str | `failure.json` | Failure JSON file name. Alias: `forensic_json_filename` |
| `smtp_tls_json_filename` | str | `smtp_tls.json` | SMTP TLS JSON file name |
| `aggregate_csv_filename` | str | `aggregate.csv` | Aggregate CSV file name |
| `failure_csv_filename` | str | `failure.csv` | Failure CSV file name. Alias: `forensic_csv_filename` |
| `smtp_tls_csv_filename` | str | `smtp_tls.csv` | SMTP TLS CSV file name |
| `csv_formula_escape` | bool | `True` | **tsdmarc only.** Prefix CSV text cells starting with `=`, `+`, `-`, `@`, a tab or a carriage return with `'`, so spreadsheets don't run them as formulas ([CSV injection](https://owasp.org/www-community/attacks/CSV_Injection)). `False` writes cells unchanged |
| `prettify_json` | bool | `True` | `False` prints JSON on a single line |
| `archive_directory` | path | — | Move processed report files given on the command line to `<archive_directory>/<year>/<month>/<Aggregate\|Failure\|SMTP-TLS>/`, and files that are not reports to `<archive_directory>/Invalid/` (see below) |
| `strip_attachment_payloads` | bool | `False` | Remove attachment payloads from failure report samples |
| `silent` | bool | `True` | Only print errors and don't print the results. `True` whenever a configuration file is used; set `False` to print results to standard output |
| `warnings` | bool | `False` | Print warnings in addition to errors |
| `verbose` | bool | `False` | More verbose output (info messages) |
| `debug` | bool | `False` | Print debugging messages |
| `log_file` | path | — | Also write log messages to this file |
| `fail_on_output_error` | bool | `False` | Exit with a non-zero status if any output fails while saving. Only affects the exit status: unsaved mailbox messages are always kept |
| `n_procs` | int | `1` | Worker threads used to parse files given on the command line, mbox messages and mailbox messages (also in watch mode) |
| `normalize_timespan_threshold_hours` | float | `24` | Aggregate reports covering more hours than this have their records split into per-day records |
| `index_prefix_domain_map` | path | — | YAML file mapping tenant names to domains, for per-tenant Elasticsearch/OpenSearch index prefixes ([multi-tenant support](../cli/#multi-tenant-support)) |
| `offline` | bool | `False` | No online queries: no DNS lookups, no downloads of the IP database, reverse DNS map or PSL overrides |
| `always_use_local_files` | bool | `False` | Don't download the IP database, reverse DNS map and PSL overrides; use local or bundled copies |
| `ip_db_path` | path | — | An MMDB file from IPinfo, MaxMind or DB-IP to use instead of IPinfo Lite |
| `ipinfo_url` | str | parsedmarc's IPinfo Lite file on GitHub | Download URL of the IPinfo Lite MMDB, for self-hosted mirrors. Deprecated alias: `ip_db_url` (logs a warning) |
| `ipinfo_api_token` | str | — | An [IPinfo Lite API](https://ipinfo.io/developers/lite-api) token. Lookups query the API first and fall back to the database on errors. An invalid token is a fatal error. Ignored with `offline` |
| `local_reverse_dns_map_path` | path | — | Local reverse DNS map CSV file to use instead of the bundled one |
| `reverse_dns_map_url` | str | parsedmarc's map on GitHub | Download URL of the reverse DNS map |
| `local_psl_overrides_path` | path | — | Local public suffix list overrides file |
| `psl_overrides_url` | str | parsedmarc's file on GitHub | Download URL of the PSL overrides file |
| `nameservers` | list | Cloudflare (`1.1.1.1`, `1.0.0.1`) | DNS resolvers: IP addresses (plain DNS), `https://` URLs (DNS over HTTPS) or `tls://ip[:port][#hostname]` (DNS over TLS). See [encrypted DNS](#encrypted-dns) |
| `dns_test_address` | str | `1.1.1.1` | Address looked up in the DNS pre-flight check that runs when `nameservers` is set |
| `dns_timeout` | float | `2.0` | DNS timeout, in seconds |
| `dns_retries` | int | `0` | Retries after a DNS timeout or transient error |
| `max_email_size` | int | `52428800` (50 MiB) | **tsdmarc only.** Largest email parsed, in bytes; `0` disables the limit. Larger messages are moved to the `Invalid` folder without being downloaded when the server reports their size |
| `max_mime_parts` | int | `10000` | **tsdmarc only.** Most MIME boundary lines in an email, and most parts the parser may create from it; `0` disables the limit |
| `max_header_lines` | int | `100000` | **tsdmarc only.** Most header lines in an email, over all its parts; `0` disables the limit |
| `max_expanded_email_size` | int | `536870912` (512 MiB) | **tsdmarc only.** Most text, in characters, that re-serializing the parts of one email may produce (size × nesting depth; characters of text beyond Latin-1 count twice); `0` disables the limit |
| `max_normalized_records` | int | `250000` | **tsdmarc only.** Most records of an aggregate report once split into daily buckets; larger reports are invalid. `0` disables the limit |
| `max_xml_depth` | int | `100000` | **tsdmarc only.** Deepest element nesting in an aggregate report's XML; `0` disables the limit |
| `max_xml_nodes` | int | `5000000` | **tsdmarc only.** Most elements and attributes in an aggregate report's XML; `0` disables the limit |
| `max_smtp_tls_report_size` | int | `10485760` (10 MiB) | **tsdmarc only.** Largest SMTP TLS report, in bytes of JSON; `0` disables the limit |
| `max_lookups_per_report` | int | `100000` | **tsdmarc only.** Most source IPs of one aggregate report looked up over the network; later IPs only get the IP database. `0` disables the limit |
| `max_failed_lookups_per_report` | int | `256` | **tsdmarc only.** Most reverse DNS lookups of one aggregate report that may fail or time out before the rest are skipped; `0` disables the limit |
| `max_lookup_time_per_report` | int | `600` | **tsdmarc only.** Seconds of network lookups (reverse DNS, IPinfo API) one aggregate report may use before the rest are skipped; `0` disables the limit |
| `job_timeout` | int | `3600` | **tsdmarc only.** Seconds one email or file may take to parse. A mailbox message over it is retried, then moved to `Unsaved`, never deleted; a file given on the command line counts as failed. With `n_procs = 1` only mailbox messages are checked, between records. `0` disables the limit |
| `max_worker_heap_mb` | int | `2048` | **tsdmarc only.** Heap limit of each parsing worker, in MiB (Bun ignores it); `0` keeps the runtime's limit. A mailbox message whose worker runs out of memory or crashes is handled as with `job_timeout` |

The size and work limits above (`max_email_size` to `max_worker_heap_mb`) reject negative values as invalid configuration. A report over one of them is invalid, like any other unparseable report; see [Security](../security/#parsing-untrusted-input).

:::caution
It is strongly recommended **not** to set `nameservers`. By default tsdmarc uses [Cloudflare's public resolvers](https://1.1.1.1/), which are much faster and more reliable than most alternatives. Use it only if your network blocks DNS requests to outside resolvers, or blocks plain DNS entirely.
:::

:::note
`save_aggregate` and `save_failure` are separate because you may not want to store failure reports, particularly in highly regulated industries such as healthcare or finance. Failure reports contain the original headers of an email that failed a DMARC check, and sometimes the full message body. Most reporting organizations don't send failure reports at all for privacy reasons, so it is normal to receive very few. An alternative is to collect them in your DMARC inbox and run tsdmarc with `save_failure = True` manually on a separate folder (with `reports_folder`) after moving the samples you want to keep there.
:::

### File archiving

With `archive_directory`, files given on the command line whose reports reached every output are moved to `<archive_directory>/<year>/<month>/<Aggregate|Failure|SMTP-TLS>/` (year and month from the report's own begin or arrival date). A report whose date can't be determined stays in place with a warning. Files that are not reports go to `<archive_directory>/Invalid/`; files that fail for other reasons (such as I/O errors) are left for a later run. If any output fails, none of the run's parsed files is moved (a warning says so) and the next run processes them again; parsedmarc archives them anyway. Existing files are never overwritten: a numeric suffix is added (`report-1.xml`). Mailbox messages use `[mailbox] archive_folder` instead, mbox files are never moved, and files already inside `archive_directory` are skipped, so the archive can live inside an input directory.

### Encrypted DNS

Each `nameservers` entry picks its transport, and entries are tried in order:

- An IP address: plain DNS over UDP and TCP port 53.
- An `https://` URL: DNS over HTTPS (DoH).
- `tls://ip[:port][#hostname]`: DNS over TLS (DoT). The port defaults to 853; `#hostname` is the server's certificate name. The host must be an IP address; wrap IPv6 in brackets: `tls://[2620:fe::fe]#dns.quad9.net`.

```ini
[general]
nameservers = https://cloudflare-dns.com/dns-query, tls://9.9.9.9#dns.quad9.net
```

On a network where outbound DNS is blocked but an HTTP proxy is available, use DoH nameservers and the proxy variables (with `NODE_USE_ENV_PROXY=1` on Node.js; see [Installation](../../getting-started/installation/#using-a-web-proxy)). DoT connects directly to TCP port 853 and never uses a proxy.

## `[mailbox]`

Settings shared by every mailbox type.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `reports_folder` | str | `INBOX` (`Inbox` with `[msgraph]`) | Folder (Gmail: label) where reports arrive |
| `archive_folder` | str | `Archive` | Folder (Gmail: label) for processed messages, in `Aggregate`, `Failure`, `SMTP-TLS`, `Invalid` and `Unsaved` subfolders |
| `watch` | bool | `False` | Keep running and process new messages as they arrive (IMAP IDLE; polling for the other types) |
| `delete` | bool | `False` | Delete processed messages instead of archiving them |
| `delete_aggregate` | bool | value of `delete` | Delete aggregate report messages instead of archiving them |
| `delete_failure` | bool | value of `delete` | Delete failure report messages instead of archiving them |
| `delete_smtp_tls` | bool | value of `delete` | Delete SMTP TLS report messages instead of archiving them |
| `delete_invalid` | bool | value of `delete` | Delete unparseable messages instead of moving them to `Invalid` |
| `test` | bool | `False` | Don't move or delete any message |
| `batch_size` | int | `10` | Messages read and processed before saving; `0` for no limit |
| `check_timeout` | int | `30` | Seconds to wait for an IMAP IDLE response, or between checks |
| `max_unsaved_retries` | int | `2` | Retries of a batch whose reports couldn't be saved before its messages move to `<archive_folder>/Unsaved`. `0` moves them on the first failure; negative values are rejected. Counted in memory, per process |
| `since` | str | — | Only messages newer than this: a number and a unit, `m` (minutes), `h` (hours), `d` (days) or `w` (weeks), such as `5m`, `3h`, `2d`, `1w`. Invalid values fall back to `1d` |

The four `delete_*` options each override `delete` for one kind of message; the others keep inheriting it. `delete = True` with `delete_failure = False` archives failure report messages and deletes the others.

## `[imap]`

Requires `@tsdmarc/imap` (included in the CLI).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | str | **required** | IMAP server hostname or IP address |
| `port` | int | `993` | IMAP server port. If your host recommends another port, still try 993 |
| `ssl` | bool | `True` | Use TLS from the start (implicit TLS, usually port 993). With `False`, the connection starts in plain text and must be upgraded with STARTTLS before logging in (usually port 143); see `starttls` |
| `starttls` | bool | unset | With `ssl = False`: unset upgrades when the server advertises STARTTLS and refuses to log in when it doesn't, so the credentials are never sent in plain text; `True` always requires the upgrade; `False` never upgrades, so credentials and messages go in plain text (a warning is logged at startup). Use `False` only for a server on the same host, such as [DavMail](../../background/davmail/) on `127.0.0.1`. Ignored with `ssl = True` |
| `skip_certificate_verification` | bool | `False` | Don't verify the server's certificate (not recommended) |
| `timeout` | int | `30` | Seconds to wait for an IMAP operation |
| `max_retries` | int | `4` | Retries after an IMAP timeout |
| `user` | str | **required** | IMAP user |
| `password` | str | **required** | IMAP password |

Deprecated (moved to `[mailbox]` in parsedmarc 8.0.0; still read, with a warning): `reports_folder`, `archive_folder`, `watch`, `test`, `batch_size`. `[imap] delete` only logs the warning and is ignored; use `[mailbox] delete`.

## `[msgraph]`

Reads a Microsoft 365 mailbox through the Microsoft Graph API. Requires `@tsdmarc/msgraph`. See [Mailboxes](../mailboxes/#microsoft-graph-microsoft-365) for permissions and examples.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `auth_method` | str | `UsernamePassword` | `DeviceCode`, `ClientSecret`, `Certificate`, `ClientAssertion` or `UsernamePassword` (case-insensitive). `UsernamePassword` is deprecated by Microsoft and fails with MFA |
| `client_id` | str | **required** | The app registration's client ID |
| `tenant_id` | str | required except for `UsernamePassword` | Microsoft Entra ID tenant ID |
| `mailbox` | str | required except for `UsernamePassword` | Mailbox to read (UPN); can be a shared mailbox |
| `client_secret` | str | required for `ClientSecret` and `UsernamePassword` | The app registration's secret |
| `certificate_path` | path | required for `Certificate` | PEM file with the certificate and private key (PKCS#12 is not supported) |
| `certificate_password` | str | — | Password of the certificate's private key |
| `client_assertion` | str | required for `ClientAssertion` | A signed JWT client assertion (static, so only valid until it expires) |
| `user` | str | required for `UsernamePassword` | User to sign in as; with `DeviceCode`, the signing-in account |
| `password` | str | required for `UsernamePassword` | The user's password |
| `graph_url` | str | `https://graph.microsoft.com` | Graph API root, for national clouds. Alias: `url` |
| `token_file` | path | `.token` | File storing the authentication record between runs |
| `allow_unencrypted_storage` | bool | `False` | Allow an unencrypted token cache when no OS keychain is available |

## `[gmail_api]`

Reads a Gmail mailbox through the Gmail API. Requires `@tsdmarc/gmail`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `credentials_file` | path | — | OAuth client secrets file (`installed_app`) or service account key (`service_account`). Setting it enables the Gmail mailbox |
| `token_file` | path | `.token` | Where the OAuth token is stored (`installed_app` only); compatible with parsedmarc's `token.json` |
| `auth_mode` | str | `installed_app` | `installed_app` or `service_account` |
| `service_account_user` | str | — | Mailbox to impersonate with domain-wide delegation (`service_account`). Alias: `delegated_user` |
| `scopes` | list | `https://www.googleapis.com/auth/gmail.modify` | OAuth scopes. Deleting messages needs `https://mail.google.com/`; without it every `delete` option is turned off with an error, also after a `SIGHUP` reload, which keeps the running connection's scopes |
| `include_spam_trash` | bool | `False` | Also search Spam and Trash |
| `oauth2_port` | int | `8080` | Port of the local server receiving the OAuth response (`installed_app`) |
| `paginate_messages` | bool | `True` | Fetch every matching message; `False` fetches at most 100 per run |

## `[maildir]`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maildir_path` | path | — | Path of the Maildir; setting it enables the Maildir mailbox. Alias: `path` |
| `maildir_create` | bool | `False` | Create the Maildir if it doesn't exist. Alias: `create` |

Run as root over a Maildir owned by another user, tsdmarc switches to the owner's uid and group, and exits with `Maildir Error` if it can't (see [Mailboxes](../mailboxes/#maildir)).

## `[elasticsearch]`

Requires `@tsdmarc/elasticsearch` (client v9; works with Elasticsearch 8 and 9).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hosts` | list | **required** | Hosts and ports or URLs, such as `127.0.0.1:9200` or `https://localhost:9200`. Don't put credentials in the URL; use `user` and `password` (or `api_key`) |
| `user` | str | — | Basic auth username |
| `password` | str | — | Basic auth password |
| `api_key` | str | — | API key (Base64). Alias: `apiKey` |
| `ssl` | bool | `True` | Use `https://` for hosts given without a scheme |
| `cert_path` | path | — | CA certificates file to trust |
| `skip_certificate_verification` | bool | `False` | Don't verify the server's certificate (not recommended) |
| `timeout` | float | `60` | Request timeout, in seconds |
| `index_prefix` | str | — | Prefix of the index names |
| `index_suffix` | str | — | Suffix of the index names |
| `monthly_indexes` | bool | `False` | One index per month instead of per day (ignored, with a warning, with `use_data_streams`) |
| `number_of_shards` | int | `1` | Shards of new indexes, or of each backing index of a data stream |
| `number_of_replicas` | int | `0` | Replicas of new indexes, or of each backing index of a data stream |
| `use_data_streams` | bool | `False` | Save each report type to a data stream named like the index without the date (`dmarc_aggregate`, …) instead of dated indexes. tsdmarc creates the stream and its index template; retention is left to an ILM policy you attach. Requires Elasticsearch 8.7 or later. See [Data streams](../outputs/#data-streams-and-records-retention) |
| `serverless` | bool | `False` | Target an Elastic Cloud Serverless project: `number_of_shards` and `number_of_replicas` are not sent (at index creation or in a data stream's template) |
| `max_indexes_per_report` | int | `31` | **tsdmarc only.** Most indexes one aggregate report may spread over (its sender picks the dates); later records go to its first index. `0` disables the limit. Doesn't apply to data streams |

## `[opensearch]`

Requires `@tsdmarc/opensearch`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hosts` | list | **required** | Hosts and ports or URLs, as for Elasticsearch. Don't put credentials in the URL; use `user` and `password` |
| `user` | str | — | Basic auth username |
| `password` | str | — | Basic auth password |
| `api_key` | str | — | Accepted like parsedmarc, but never sent (opensearch-py ignores a client-level API key). Alias: `apiKey` |
| `auth_type` | str | `basic` | `basic` or `awssigv4`. Alias: `authentication_type` |
| `aws_region` | str | — | AWS region for SigV4 (required with `awssigv4`) |
| `aws_service` | str | `es` | AWS service for SigV4 (`aoss` for OpenSearch Serverless) |
| `ssl` | bool | `True` | Use `https://` for hosts given without a scheme |
| `cert_path` | path | — | CA certificates file to trust |
| `skip_certificate_verification` | bool | `False` | Don't verify the server's certificate (not recommended) |
| `timeout` | float | `60` | Request timeout, in seconds |
| `index_prefix` | str | — | Prefix of the index names |
| `index_suffix` | str | — | Suffix of the index names |
| `monthly_indexes` | bool | `False` | One index per month instead of per day (ignored, with a warning, with `use_data_streams`) |
| `number_of_shards` | int | `1` | Shards of new indexes, or of each backing index of a data stream |
| `number_of_replicas` | int | `0` | Replicas of new indexes, or of each backing index of a data stream |
| `use_data_streams` | bool | `False` | Save each report type to a data stream instead of dated indexes; retention is left to an ISM policy you attach. An `index_prefix` starting with `.` can't be used with it, and OpenSearch Serverless doesn't support it. See [Data streams on OpenSearch](../outputs/#data-streams-on-opensearch) |
| `max_indexes_per_report` | int | `31` | **tsdmarc only.** As for Elasticsearch. Doesn't apply to data streams |

## `[splunk_hec]`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | str | **required** | URL of the Splunk HTTP Event Collector (only the scheme and host are used). Don't put credentials in the URL; use `token` |
| `token` | str | **required** | HEC token |
| `index` | str | **required** | Splunk index |
| `skip_certificate_verification` | bool | `False` | Don't verify the server's certificate (not recommended) |

## `[kafka]`

Requires `@tsdmarc/kafka`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hosts` | list | **required** | Kafka bootstrap brokers (`host:port`) |
| `user` | str | — | SASL PLAIN username (implies TLS) |
| `password` | str | — | SASL PLAIN password (implies TLS) |
| `ssl` | bool | `False` | Use TLS (always on with a user or password) |
| `skip_certificate_verification` | bool | `False` | Don't verify the broker's certificate (not recommended) |
| `aggregate_topic` | str | **required** | Topic for aggregate reports |
| `failure_topic` | str | **required** | Topic for failure reports. Alias: `forensic_topic` |
| `smtp_tls_topic` | str | **required** | Topic for SMTP TLS reports |

## `[smtp]`

Emails the results (a zip of the JSON and CSV files) after a run that parsed at least one report. Requires `@tsdmarc/smtp`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | str | required unless `[msgraph]` is configured | SMTP server. Without it and with `[msgraph]`, the email is sent through Microsoft Graph |
| `port` | int | `25` | SMTP port. Usually `587` for STARTTLS, or `465` with `ssl = True` |
| `ssl` | bool | `False` | Use TLS from the start (implicit TLS, usually port 465). With `False`, the connection starts in plain text and must be upgraded with STARTTLS before authenticating; see `starttls` |
| `starttls` | bool | unset | With `ssl = False`: unset upgrades when the server advertises STARTTLS and refuses to authenticate when it doesn't (`Failed to email results` is logged); `True` always requires the upgrade; `False` never upgrades, so the credentials and the email go in plain text (a warning is logged at startup). Use `False` only for a server on the same host. Ignored with `ssl = True` |
| `skip_certificate_verification` | bool | `False` | Don't verify the server's certificate (not recommended) |
| `user` | str | required with `host` | SMTP username |
| `password` | str | required with `host` | SMTP password |
| `from` | str | — | `From` address; a critical error is logged when `host` is set without it. With Graph, the `[msgraph]` mailbox is always the sender |
| `to` | list | — | Recipients; a critical error is logged when it is missing |
| `subject` | str | `tsdmarc report` | Subject (parsedmarc: `parsedmarc report`) |
| `attachment` | str | `DMARC-<YYYY-MM-DD>.zip` | Attachment file name |
| `message` | str | `Please see the attached DMARC results.` | Message body |

## `[s3]`

Requires `@tsdmarc/s3`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `bucket` | str | **required** | Bucket name |
| `path` | str | bucket root | Key prefix to upload under (leading and trailing `/` removed) |
| `region_name` | str | SDK default chain, then `us-east-1` | AWS region |
| `endpoint_url` | str | — | Endpoint of an S3-compatible service (path-style addressing is used) |
| `access_key_id` | str | SDK default chain | Access key ID |
| `secret_access_key` | str | SDK default chain | Secret access key |
| `prevent_overwrite` | bool | `False` | **tsdmarc only.** Never replace an existing object: objects are written with `If-None-Match: *`, a different report with the same key is saved as `<report_id>_<hash>-<sha256>.json` and an identical one is skipped. Needs `s3:GetObject` besides `s3:PutObject`, and a service that supports conditional writes (checked on the first save) |

## `[postgresql]`

Requires `@tsdmarc/postgres`. Tables are created on first use.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connection_string` | str | — | A libpq URI (`postgresql://user@host/dbname`) or `key=value` string. When set, the options below except `query_timeout` are ignored. Prefer the separate `host`, `user`, `password` and `database` options, and don't put the password in the string: a malformed connection string can make the driver quote it in an error (tsdmarc masks it in the log) |
| `host` | str | required unless `connection_string` | Server hostname or IP address |
| `port` | int | `5432` | Server port |
| `user` | str | — | Database user |
| `password` | str | — | Database password |
| `database` | str | — | Database name |
| `sslmode` | str | `prefer` | **tsdmarc only.** libpq `sslmode`: `disable`, `allow`, `prefer`, `require`, `verify-ca` or `verify-full`. Only `verify-full` checks the server's identity; `prefer` falls back to plain text (see [PostgreSQL TLS](../outputs/#tls)) |
| `sslrootcert` | path | `~/.postgresql/root.crt` if present | **tsdmarc only.** CA file to verify the server with, or `system` for the system's trusted roots (requires `verify-full`) |
| `sslcert` | path | `~/.postgresql/postgresql.crt` if present | **tsdmarc only.** Client certificate |
| `sslkey` | path | `~/.postgresql/postgresql.key` | **tsdmarc only.** Client private key (mode `0600` or stricter) |
| `query_timeout` | int | `300` | **tsdmarc only.** Seconds to wait for each statement; `0` waits forever, as parsedmarc does. A statement over it fails the save and the next save reconnects. Also applies with `connection_string` |

With `connection_string`, put the `ssl*` options in the string instead; in the section they are ignored with an error. Missing values fall back to the libpq `PG*` environment variables (`PGPASSWORD`, `PGSSLMODE`, …).

## `[syslog]`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `server` | str | **required** | Syslog server name or IP address |
| `port` | int | `514` | Port |
| `protocol` | str | `udp` | `udp`, `tcp` or `tls` |
| `cafile_path` | path | — | CA certificate file to verify the server (TLS), added to the system CAs |
| `certfile_path` | path | — | Client certificate (TLS mutual authentication) |
| `keyfile_path` | path | — | Client private key (TLS mutual authentication) |
| `timeout` | float | `5.0` | Connection timeout for TCP/TLS, in seconds |
| `retry_attempts` | int | `3` | Connection attempts for TCP/TLS |
| `retry_delay` | int | `5` | Seconds between attempts |

## `[gelf]`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | str | **required** | Graylog (GELF) server |
| `port` | int | **required** | Port |
| `mode` | str | **required** | `udp`, `tcp` or `tls` |
| `cafile` | path | — | **tsdmarc only.** CA bundle added to the system CAs to verify the server (`mode = tls`) |
| `skip_certificate_verification` | bool | `False` | **tsdmarc only.** Don't verify the server's certificate (`mode = tls`), as parsedmarc does |

## `[webhook]`

Posts each report as a JSON body.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `aggregate_url` | str | — | URL receiving aggregate reports |
| `failure_url` | str | — | URL receiving failure reports. Alias: `forensic_url` |
| `smtp_tls_url` | str | — | URL receiving SMTP TLS reports |
| `timeout` | int | `60` | Request timeout, in seconds |

A webhook that can't be reached, times out or answers with a status other than 2xx is an output error, as with the other outputs: mailbox messages are kept for the next attempt (see `[mailbox] max_unsaved_retries`) and `fail_on_output_error` applies. parsedmarc only logs it, so the messages are archived or deleted all the same.

## `[loki]`

Pushes every report record as one JSON log line to Grafana Loki. See [Outputs](../outputs/#grafana-loki).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | str | **required** | Loki base URL; `/loki/api/v1/push` is appended when the URL has no path, and a URL with a path is used as is. Don't put credentials in the URL; use `username` and `password` (or `token`) |
| `labels` | list | — | Comma-separated `name=value` stream labels, merged over the defaults `job=parsedmarc` and `host=<host name>`. An entry without `=` or with an empty name is an error |
| `label_fields` | list | `report_type, domain` | Record fields used as stream labels; empty for none. Keep them to fields with few distinct values. Records without a value for a field get no such label |
| `timestamp` | str | `ingest` | `ingest` (the time of the push) or `report_begin` (the begin of the reported period, or the arrival date of a failure report). Loki rejects entries older than its `reject_old_samples_max_age` |
| `username` | str | — | Basic authentication user |
| `password` | str | — | Basic authentication password |
| `token` | str | — | Bearer token, instead of basic authentication (not together with `username`/`password`) |
| `tenant_id` | str | — | Tenant ID, sent as the `X-Scope-OrgID` header |
| `skip_certificate_verification` | bool | `False` | Don't verify the server's certificate (not recommended) |
| `timeout` | float | `60` | Request timeout, in seconds |
| `batch_size` | int | `1000` | Maximum log lines per push request |

## `[log_analytics]`

Sends reports to Azure Log Analytics (Microsoft Sentinel) through the Logs Ingestion API. Requires `@tsdmarc/loganalytics`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `client_id` | str | — | The app registration's client ID |
| `client_secret` | str | — | The app registration's client secret |
| `tenant_id` | str | — | Tenant of the app registration |
| `dce` | str | — | Data Collection Endpoint, such as `https://{DCE-NAME}.{REGION}.ingest.monitor.azure.com`. Setting it enables the output |
| `dcr_immutable_id` | str | — | Immutable ID of the Data Collection Rule |
| `dcr_aggregate_stream` | str | — | DCR stream for aggregate reports |
| `dcr_failure_stream` | str | — | DCR stream for failure reports. Alias: `dcr_forensic_stream` |
| `dcr_smtp_tls_stream` | str | — | DCR stream for SMTP TLS reports |

See the [Azure documentation](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/tutorial-logs-ingestion-portal) for setting up the Data Collection Rule.
