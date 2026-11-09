---
title: API overview
description: A map of the public API of tsdmarc and the @tsdmarc packages, with links to the generated reference.
---

The pages under **Packages** in the sidebar are generated from the TypeScript sources and their doc comments with [TypeDoc](https://typedoc.org/). This page is a map of the most useful exports. Everything is a named export of the package root (`import { … } from 'tsdmarc'`); there are no subpath imports.

## `tsdmarc` (core)

| Area | Exports |
| --- | --- |
| Parse anything | [`parseReportFile`](../../api/tsdmarc/functions/parsereportfile/), [`parseReportEmail`](../../api/tsdmarc/functions/parsereportemail/), [`getDmarcReportsFromMbox`](../../api/tsdmarc/functions/getdmarcreportsfrommbox/) |
| Aggregate reports | [`parseAggregateReportXml`](../../api/tsdmarc/functions/parseaggregatereportxml/), `parseAggregateReportFile`, `parseAggregateReportFromFilePath`, `parsedAggregateReportsToCsv`, `parsedAggregateReportsToCsvRows`, `AGGREGATE_CSV_FIELDS` |
| Failure reports | `parseFailureReport`, `parsedFailureReportsToCsv`, `parsedFailureReportsToCsvRows`, `FAILURE_CSV_FIELDS` (aliases: `parseForensicReport`, …) |
| SMTP TLS reports | `parseSmtpTlsReportJson`, `parsedSmtpTlsReportsToCsv`, `parsedSmtpTlsReportsToCsvRows`, `SMTP_TLS_CSV_FIELDS` |
| Decompression | `extractReport`, `extractReportFromFilePath`, `extractReportFromStream`, `MAX_DECOMPRESSED_REPORT_SIZE` |
| Configuration | [`createParserConfig`](../../api/tsdmarc/functions/createparserconfig/), `resolveParserConfig`, `DEFAULT_PARSER_OPTIONS`, `ParserOptions`, `ParserConfig` |
| Mailboxes | [`getDmarcReportsFromMailbox`](../../api/tsdmarc/functions/getdmarcreportsfrommailbox/), [`watchInbox`](../../api/tsdmarc/functions/watchinbox/), `MailboxConnection`, `MaildirConnection` |
| Saving | [`saveOutput`](../../api/tsdmarc/functions/saveoutput/), `appendJson`, `appendCsv`, `getReportZip`, `rowsToCsv`, `CsvDictWriter`, `csvFormulaEscape` |
| Serialization | `toSnakeCaseKeys`, `toCamelCaseKeys`, `pyJsonDumps` |
| Light outputs | `HECClient` (Splunk), `LokiClient` (Grafana Loki), `SyslogClient`, `GelfClient`, `WebhookClient` |
| Enrichment | `loadIpDb`, `configureIpinfoApi`, `loadReverseDnsMap`, `loadPslOverrides`, `getIpAddressInfo`, `getReverseDns`, `queryDns`, `reverseNameFromAddress`, `getBaseDomain` |
| Parallelism | `parallelMap`, `parseReportFileTask`, `parseReportEmailTask`, `WorkerCrashedError`, `JobTimeoutError` |
| Logging | `logger`, `getLogger`, `configureLogging`, `captureLogs`, `DEBUG` … `CRITICAL` |
| Errors | `ParserError`, `InvalidDMARCReport`, `InvalidAggregateReport`, `InvalidFailureReport`, `InvalidSMTPTLSReport`, `EmailTooLargeError`, `DownloadError`, `LokiError` |
| Types | `AggregateReport`, `FailureReport`, `SMTPTLSReport`, `ParsedReport`, `ParsingResults`, `IPSourceInfo`, … |
| Utilities | `PyDateTime`, `parseDate`, `humanTimestampToDatetime`, `parseEmail`, `createEmail`, `sanitizeForLog`, `redactUrlCredentials`, `maskNameserverSecrets`, `VERSION` |

## Integration packages

| Package | Main exports |
| --- | --- |
| [`@tsdmarc/imap`](../../api/tsdmarc/imap/readme/) | `IMAPConnection`, `IMAPClient`, `IMAPConnectionOptions`, `IMAPClientError` |
| [`@tsdmarc/gmail`](../../api/tsdmarc/gmail/readme/) | `GmailConnection`, `GmailConnectionOptions`, `getCreds`, `runLocalServer` |
| [`@tsdmarc/msgraph`](../../api/tsdmarc/msgraph/readme/) | `MSGraphConnection`, `MSGraphConnectionOptions`, `AuthMethod`, `emailResultsViaMsgraph` |
| [`@tsdmarc/smtp`](../../api/tsdmarc/smtp/readme/) | `emailResults`, `sendEmail`, `SMTPError` |
| [`@tsdmarc/elasticsearch`](../../api/tsdmarc/elasticsearch/readme/) | `setHosts`, `saveAggregateReportToElasticsearch`, `saveFailureReportToElasticsearch`, `saveSmtpTlsReportToElasticsearch`, `createIndexes`, `migrateIndexes`, `AlreadySaved` |
| [`@tsdmarc/opensearch`](../../api/tsdmarc/opensearch/readme/) | `setHosts`, `saveAggregateReportToOpenSearch`, `saveFailureReportToOpenSearch`, `saveSmtpTlsReportToOpenSearch`, `AlreadySaved` |
| [`@tsdmarc/postgres`](../../api/tsdmarc/postgres/readme/) | `PostgreSQLClient`, `AlreadySaved` |
| [`@tsdmarc/kafka`](../../api/tsdmarc/kafka/readme/) | `KafkaClient`, `KafkaError` |
| [`@tsdmarc/s3`](../../api/tsdmarc/s3/readme/) | `S3Client` |
| [`@tsdmarc/loganalytics`](../../api/tsdmarc/loganalytics/readme/) | `LogAnalyticsClient`, `LogAnalyticsConfig`, `LogAnalyticsException` |
| [`@tsdmarc/cli`](../../api/tsdmarc/cli/readme/) | `run`, `main`, `loadConfig`, `parseConfig`, `createOptions`, `ConfigParser` (the `tsdmarc` command's internals, for embedding) |

`@tsdmarc/ipinfo-lite` only ships the database file and has no API.

## Conventions

- Python `snake_case` names are `camelCase`; classes keep their names (`InvalidAggregateReport`, `KafkaClient`).
- Keyword arguments are one options object; positional required arguments stay positional.
- Functions that do network, DNS or disk I/O are `async`.
- Report objects use camelCase keys mapped 1:1 to parsedmarc's snake_case keys; outputs convert them back with `toSnakeCaseKeys()`.
- Backward-compatible "forensic" aliases are kept.
