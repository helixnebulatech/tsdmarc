---
title: Security
description: How tsdmarc handles untrusted reports and credentials, and how to report a vulnerability.
---

DMARC reports arrive from anyone on the Internet: every report, email and attachment tsdmarc parses is untrusted input. tsdmarc keeps parsedmarc's protections and adds some of its own.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/helixnebulatech/tsdmarc/security/advisories/new) for the tsdmarc repository, not in public issues. See the [security policy](https://github.com/helixnebulatech/tsdmarc/security/policy) for details.

If the issue also affects parsedmarc (for example a parsing bug present in both), please consider reporting it to [parsedmarc](https://github.com/domainaware/parsedmarc/security) as well.

## Parsing untrusted input

- **Decompression bombs:** zip and gzip content is capped at 100 MiB decompressed; bzip2, LZMA and Zstandard zip members at 10 MiB (their decoders are slower). The attachments of one email may decompress to 100 MiB in total.
- **XML:** entities are never expanded (no XXE, no "billion laughs"), and aggregate report data nested more than 512 levels deep is rejected.
- **Email size:** emails over `max_email_size` (50 MiB) or with more than `max_mime_parts` (10,000) MIME boundaries are refused before parsing. Mailbox backends check the size before downloading where the server reports it, and IMAP also stops reading a message that turns out larger than its reported size. While parsing, emails are also limited to `max_header_lines` (100,000) header lines and `max_expanded_email_size` (512 MiB) of re-serialized nested parts.
- **Report size:** aggregate report XML is limited to `max_xml_depth` (100,000) levels and `max_xml_nodes` (5,000,000) elements and attributes, and to `max_normalized_records` (250,000) records once split into daily buckets, so a few KB with a sender-chosen date range can't fill memory. SMTP TLS reports over `max_smtp_tls_report_size` (10 MiB) are rejected before parsing.
- **Work per report:** each aggregate report gets at most `max_lookups_per_report` (100,000) network lookups, `max_failed_lookups_per_report` (256) failed reverse DNS lookups and `max_lookup_time_per_report` (600) seconds of lookups; a source IP repeated in a report is looked up once. Later IPs only get the IP database. Parsing one email or file stops after `job_timeout` (one hour), and each parsing worker has a `max_worker_heap_mb` (2 GiB) heap. A mailbox message that hits either limit, or crashes its worker, is retried and then moved to `Unsaved`, never deleted.
- These limits are tsdmarc only (parsedmarc has none); `0` disables each one and negative values are rejected. See the [configuration reference](../configuration/#general).
- **Regular expressions** follow parsedmarc's anti-backtracking rules, so crafted input can't cause catastrophic backtracking.
- **CSV injection:** text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return are prefixed with `'`.
- **Files written:** failure report samples get sanitized file names (control and bidi characters removed) and never replace an existing file; JSON output files are replaced atomically, and one that can't be read as a JSON array is kept as `<file>.corrupt-<timestamp>` instead of being overwritten; summary zip files contain no `../` entries; S3 object keys can't be steered by a report ID, and with `[s3] prevent_overwrite` a forged report can't replace a saved one.
- **Logs:** text from reports is escaped before logging, so a report can't inject fake log lines or terminal escape sequences.

## Network and credentials

- **TLS verification is on by default** everywhere (IMAP, SMTP, Elasticsearch, OpenSearch, Splunk, Kafka, syslog, GELF, PostgreSQL `verify-*` modes, DoT, DoH). PostgreSQL's default is libpq's `sslmode=prefer`, which neither verifies the server nor refuses plain text: use `sslmode = verify-full` (see [PostgreSQL TLS](../outputs/#tls)). `skip_certificate_verification` exists for testing; avoid it in production.
- **Timeouts** bound every network connection.
- **Downloads** (IP database, reverse DNS map, PSL overrides) only follow `http(s)` URLs, are size-capped, and are cached in a private per-user directory (mode `0700`, never a symlink or another user's directory) through atomic renames.
- **Secrets never reach the logs.** Passwords, tokens and client secrets are not logged, and the password in a URL is shown as `***` (`https://user:***@host:9200`; everything up to the last `@` when the URL is malformed). Still, prefer the separate credential options (`user`/`password` or `api_key` for Elasticsearch and OpenSearch, `user`/`password` for PostgreSQL, `username`/`password` or `token` for Loki, `token` for Splunk HEC) to credentials in URLs. Errors from webhooks and other HTTP requests keep only the scheme and host of a URL, since a webhook URL often is the credential.
- **PostgreSQL options that pg can't enforce** (`channel_binding=require`, `require_auth`, `requirepeer`, `sslcertmode=require`, `gssencmode=require`, `sslcrldir`) refuse the connection instead of being ignored.
- **Maildir as root:** when run as root over a Maildir owned by another user, tsdmarc switches to that user's uid and group. If it can't, it stops (`Maildir Error`) instead of going on as root, as mailsuite does. Run it as the Maildir's owner instead.

### No credentials over plain text

With `ssl = False`, IMAP and SMTP connections start in plain text. Up to mailsuite 2.3.3 (parsedmarc 11.2.0), they were upgraded with STARTTLS only when the server offered it and otherwise sent the password in plain text, so an attacker on the network could strip the STARTTLS offer and read it (GHSA-2x4j-7g3q-wr6f, GHSA-3588-2mr7-vrcm). tsdmarc, like mailsuite 2.3.4 and parsedmarc 11.2.1, requires the upgrade before sending credentials:

- IMAP fails before logging in with `The IMAP server does not advertise STARTTLS, so credentials would be sent in plain text. …` (logged as `IMAP Error`).
- SMTP with a username and password fails before `AUTH` with an `SMTPError` (`Failed to email results`). Without credentials, SMTP still sends in plain text with a warning, as in parsedmarc.

The `starttls` option of `[imap]` and `[smtp]` (and of the library's `IMAPConnection` and `emailResults()`/`sendEmail()`) controls this. Unset (`null`) is the behavior above; `True` also fails when the server doesn't advertise STARTTLS, with or without credentials; `False` never upgrades and sends the credentials in plain text, with a warning at startup when `ssl = False`. Use `starttls = False` only for a server on the same host, such as [DavMail](../../background/davmail/) on the loopback address, or switch to `ssl = True`.

### Secrets in configuration

- Keep the configuration file readable only by the service user (`chmod 640`, owned by `root:tsdmarc`).
- In containers, prefer `_FILE` variables ([secrets in files](../environment-variables/#secrets-in-files-_file-suffix)) over plain environment variables.
- The Gmail token file is written with mode `0600`.

## Privacy

Failure reports can contain the headers, and sometimes the body, of real emails. Only enable `save_failure` if you need it, and think about who can access the outputs where they are stored. See the note in the [configuration reference](../configuration/#general).

## Dependencies

The repository's CI pins GitHub Actions by commit, and Dependabot proposes dependency updates weekly after a cooldown. `@tsdmarc/msgraph` and `@tsdmarc/loganalytics` require `@azure/identity` `^4.14.1`, which brings an `@azure/msal-node` with the fix for GHSA-xcx6-jx8p-x3h5 (7.1.0 or later); if your lockfile still holds `@azure/identity` 4.14.0, update it.
