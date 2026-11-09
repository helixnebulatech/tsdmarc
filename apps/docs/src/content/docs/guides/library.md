---
title: Using the library
description: Parse report files, emails, mbox files and mailboxes from TypeScript, configure enrichment and save the results.
---

Everything the `tsdmarc` command does is available as a library. The main entry points are exported by the `tsdmarc` package:

| Function | Parses |
| --- | --- |
| `parseReportFile(input, options?)` | Any report: a path, `URL`, bytes or stream; zip/gzip, XML, JSON or an email |
| `parseReportEmail(input, options?)` | An RFC 822 email (bytes or text) with a report attached |
| `parseAggregateReportXml(xml, options?)` | Aggregate report XML text |
| `parseAggregateReportFile(content, options?)` | Aggregate report content (bytes, base64 or XML, compressed or not) |
| `parseAggregateReportFromFilePath(path, options?)` | An aggregate report file |
| `parseFailureReport(...)` | A failure report's parts (used by `parseReportEmail()`) |
| `parseSmtpTlsReportJson(json)` | SMTP TLS report JSON |
| `getDmarcReportsFromMbox(path, options?)` | Every report in an mbox file |
| `getDmarcReportsFromMailbox(connection, options?)` | Every report in a mailbox folder |
| `watchInbox(connection, callback, options?)` | New reports as they arrive in a mailbox |

Python's `snake_case` names became `camelCase`, and keyword arguments became an options object: parsedmarc's `parse_report_file(path, offline=True)` is `parseReportFile(path, { offline: true })`. Anything that touches the network, DNS or the disk returns a `Promise`.

## Parsing a file

`parseReportFile()` accepts a file path, a `file:` `URL`, a `Uint8Array`, an `ArrayBuffer` or an async iterable of bytes (such as a Node.js readable stream). It decompresses zip and gzip content, then tries, in order, an aggregate report, an SMTP TLS report and a report email:

```ts
import { parseReportFile } from 'tsdmarc';
import type { ParsedReport } from 'tsdmarc';

const parsed: ParsedReport = await parseReportFile('report.xml.zip');

switch (parsed.reportType) {
  case 'aggregate':
    console.log(parsed.report.policyPublished.domain);
    break;
  case 'failure':
    console.log(parsed.report.reportedDomain, parsed.report.authFailure);
    break;
  case 'smtp_tls':
    console.log(parsed.report.organizationName, parsed.report.policies.length);
    break;
}
```

The result is a discriminated union: `reportType` is `'aggregate'`, `'failure'` or `'smtp_tls'` (the same strings as parsedmarc), and `report` is an `AggregateReport`, `FailureReport` or `SMTPTLSReport`.

When nothing matches, a `ParserError` is thrown whose message explains why, based on what the content looks like. Every error class parsedmarc raises is exported:

```ts
import {
  InvalidAggregateReport,
  InvalidDMARCReport,
  InvalidSMTPTLSReport,
  ParserError,
  parseReportFile,
} from 'tsdmarc';

try {
  await parseReportFile('maybe-a-report.bin');
} catch (error) {
  if (error instanceof ParserError) {
    console.warn(`Not a report: ${error.message}`);
  } else {
    throw error;
  }
}
```

The hierarchy is the same as parsedmarc's: `ParserError` → `InvalidDMARCReport` → `InvalidAggregateReport` / `InvalidFailureReport`, plus `InvalidSMTPTLSReport`. tsdmarc adds `EmailTooLargeError` (a `ParserError`), thrown when an email exceeds the size limits described below. The legacy aliases `InvalidForensicReport`, `parseForensicReport` and `parsedForensicReportsToCsv` are kept.

## Parsing emails and raw content

```ts
import { readFile } from 'node:fs/promises';

import {
  extractReport,
  parseAggregateReportXml,
  parseReportEmail,
  parseSmtpTlsReportJson,
} from 'tsdmarc';

// An email with a report attached (aggregate, failure or SMTP TLS)
const email = await readFile('report.eml');
const fromEmail = await parseReportEmail(email);

// Decompress zip/gzip/plain report content to text, then parse it
const xml = extractReport(await readFile('report.xml.gz'));
const aggregate = await parseAggregateReportXml(xml);

// SMTP TLS JSON (synchronous: no enrichment)
const tls = parseSmtpTlsReportJson(await readFile('tls.json', 'utf8'));
```

## Parsing an mbox file

```ts
import { getDmarcReportsFromMbox } from 'tsdmarc';

const results = await getDmarcReportsFromMbox('/var/mail/dmarc', {
  nProcs: 4, // parse messages in 4 worker threads
});
console.log(results.aggregateReports.length);
```

Messages that are not valid reports are logged as warnings and skipped. Duplicate aggregate reports (same organization and report ID) are dropped.

## Options

Every parsing function takes the same parser options, with parsedmarc's defaults:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `offline` | `boolean` | `false` | No network: no DNS lookups and no downloads (IP database, reverse DNS map) |
| `ipDbPath` | `string \| null` | `null` | Path to an MMDB database from IPinfo, MaxMind or DB-IP |
| `alwaysUseLocalFiles` | `boolean` | `false` | Don't download the reverse DNS map; use the bundled or local copy |
| `reverseDnsMapPath` | `string \| null` | `null` | A local reverse DNS map CSV file |
| `reverseDnsMapUrl` | `string \| null` | `null` | URL to download the reverse DNS map from |
| `nameservers` | `string[] \| null` | `null` | DNS resolvers: IP addresses, `https://` URLs (DoH) or `tls://ip[:port][#hostname]` (DoT). Default: Cloudflare |
| `dnsTimeout` | `number` | `2` | DNS timeout, in seconds |
| `dnsRetries` | `number` | `0` | Retries after a DNS timeout or transient error |
| `stripAttachmentPayloads` | `boolean` | `false` | Remove attachment payloads from failure report samples |
| `normalizeTimespanThresholdHours` | `number` | `24` | Aggregate reports spanning more hours are split into per-day records |
| `maxEmailSize` | `number` | 50 MiB | Largest email accepted, in bytes; `0` disables the check (tsdmarc only) |
| `maxMimeParts` | `number` | `10000` | Most MIME boundary lines accepted in an email; `0` disables the check (tsdmarc only) |
| `maxHeaderLines` | `number` | `100000` | Most header lines in an email, over all its parts (tsdmarc only) |
| `maxExpandedEmailSize` | `number` | 512 MiB | Most text, in characters (twice for text beyond Latin-1), re-serializing the parts of one email may produce (tsdmarc only) |
| `maxNormalizedRecords` | `number` | `250000` | Most records of an aggregate report after splitting it into daily buckets (tsdmarc only) |
| `maxXmlDepth` | `number` | `100000` | Deepest element nesting in an aggregate report's XML (tsdmarc only) |
| `maxXmlNodes` | `number` | `5000000` | Most elements and attributes in an aggregate report's XML (tsdmarc only) |
| `maxSmtpTlsReportSize` | `number` | 10 MiB | Largest SMTP TLS report, in bytes of JSON (tsdmarc only) |
| `maxLookupsPerReport` | `number` | `100000` | Most source IPs of one aggregate report looked up over the network; later ones only get the IP database (tsdmarc only) |
| `maxFailedLookupsPerReport` | `number` | `256` | Most failed or timed-out reverse DNS lookups per aggregate report before the rest are skipped (tsdmarc only) |
| `maxLookupTimePerReport` | `number` | `600` | Seconds of network lookups (reverse DNS, IPinfo API) per aggregate report before the rest are skipped (tsdmarc only) |
| `jobTimeout` | `number` | `3600` | Seconds one email or file may take to parse in a worker or a mailbox (tsdmarc only) |
| `maxWorkerHeapMb` | `number` | `2048` | Heap limit of each parsing worker, in MiB; Bun ignores it (tsdmarc only) |
| `config` | `ParserConfig` |  | A config object; when given, the options above are ignored |

For every limit, `0` disables the check. The defaults are exported as `DEFAULT_MAX_HEADER_LINES`, `DEFAULT_JOB_TIMEOUT` and so on.

```ts
await parseReportFile('report.xml', {
  offline: true,
  stripAttachmentPayloads: true,
});
```

### Reusing a configuration

Pass `config` to share one set of options **and caches** between calls, exactly like parsedmarc's `ParserConfig`:

```ts
import { createParserConfig, parseReportFile } from 'tsdmarc';

const config = createParserConfig({
  nameservers: ['1.1.1.1', '1.0.0.1'],
  dnsTimeout: 5,
});

const first = await parseReportFile('a.xml.gz', { config });
const second = await parseReportFile('b.xml.gz', { config });
```

- When `config` is given, the individual options are ignored.
- Each config created with `createParserConfig()` owns isolated caches: IP address information (4 hours), seen aggregate report IDs (1 hour, used to drop duplicates) and the reverse DNS map. Calls without `config` share the module-wide caches.
- `nProcs` and `keepAlive` are not part of the config; pass them separately.

### Enrichment data

The CLI refreshes enrichment data at startup. In the library, do it yourself when you need current data:

```ts
import { configureIpinfoApi, loadIpDb, loadPslOverrides } from 'tsdmarc';

// Download (and cache) the current IPinfo Lite database
await loadIpDb();
// Optional: query the IPinfo Lite API first, falling back to the database
await configureIpinfoApi(process.env.IPINFO_TOKEN ?? null);
// Download the current public suffix list overrides
await loadPslOverrides();
```

The reverse DNS map is downloaded on first use unless `offline` or `alwaysUseLocalFiles` is set. Lower-level helpers are exported too: `getIpAddressInfo()`, `getReverseDns()`, `queryDns()`, `getBaseDomain()`.

## Results

Report objects use **camelCase** keys; each maps 1:1 to parsedmarc's snake_case key (`ipAddress` ↔ `ip_address`). The main types:

```ts
import type {
  AggregateReport, // xmlSchema, reportMetadata, policyPublished, records[]
  AggregateRecord, // source, count, alignment, policyEvaluated, identifiers, authResults, ...
  FailureReport, // feedbackType, arrivalDate, source, authFailure, sample, parsedSample, ...
  IPSourceInfo, // ipAddress, country, reverseDns, baseDomain, name, type, asn, asName, asDomain
  ParsedReport, // { reportType, report }
  ParsingResults, // { aggregateReports, failureReports, smtpTlsReports }
  SMTPTLSReport, // organizationName, beginDate, endDate, contactInfo, reportId, policies[]
} from 'tsdmarc';
```

Some details carried over from Python:

- Dates are strings formatted like parsedmarc's (`2018-06-19 00:00:00`), in the machine's local time zone where parsedmarc uses local time. Set `TZ` (for example `TZ=UTC`) for reproducible output.
- Python integers are unbounded: an aggregate `count`, `originalTimespanSeconds` or an SMTP TLS session count beyond ±2^53 is a `bigint` (safe values stay `number`). Serialize reports with `pyJsonDumps()`, not `JSON.stringify()`, which throws on `bigint`.

### Converting to parsedmarc's JSON

Outputs use parsedmarc's snake_case names. Convert a report (or whole results) with `toSnakeCaseKeys()` and serialize with `pyJsonDumps()`:

```ts
import { pyJsonDumps, toSnakeCaseKeys } from 'tsdmarc';

const json = pyJsonDumps(toSnakeCaseKeys(parsed.report), {
  indent: 2,
  ensureAscii: false,
});
```

`toCamelCaseKeys()` goes the other way, for reading parsedmarc JSON back in. Email header names under `headers` and reporter data that parsedmarc passes through untouched are never renamed.

## Saving the results

```ts
import { getReportZip, parsedAggregateReportsToCsv, saveOutput } from 'tsdmarc';

// JSON + CSV files and failure samples, appended to existing files
await saveOutput(results, {
  outputDirectory: 'output',
  aggregateJsonFilename: 'aggregate.json', // the default
});

// CSV text in memory (also parsedFailureReportsToCsv, parsedSmtpTlsReportsToCsv)
const csv = parsedAggregateReportsToCsv(results.aggregateReports);

// The zip file the CLI attaches to its summary email
const zip: Uint8Array = await getReportZip(results);
```

`saveOutput()` options: `outputDirectory` (default `output`), `aggregateJsonFilename`, `failureJsonFilename`, `smtpTlsJsonFilename`, `aggregateCsvFilename`, `failureCsvFilename`, `smtpTlsCsvFilename` and `csvFormulaEscape`. JSON files are kept as one valid JSON array, and new reports are appended to it.

Text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return are written with a leading `'` so spreadsheet applications don't run them as formulas ([CSV injection](https://owasp.org/www-community/attacks/CSV_Injection)). tsdmarc lets you turn this off with `csvFormulaEscape: false` (or `{ formulaEscape: false }` in the `parsed*ReportsToCsv()` functions).

To send results elsewhere, see [Outputs and integrations](../outputs/).

## Reading mailboxes

Mailbox connections come from the integration packages (`MaildirConnection` is in the core). They all extend `MailboxConnection`, expose `kind` (`'imap' | 'gmail' | 'msgraph' | 'maildir'`) and must be closed with `close()`:

```ts
import { IMAPConnection } from '@tsdmarc/imap';
import { getDmarcReportsFromMailbox, saveOutput } from 'tsdmarc';

const connection = await IMAPConnection.connect(
  'imap.example.com',
  'dmarc@example.com',
  {
    password: process.env.IMAP_PASSWORD,
  },
);
try {
  const results = await getDmarcReportsFromMailbox(connection, {
    reportsFolder: 'INBOX',
    archiveFolder: 'Archive',
    // Called for each batch before its messages are archived or deleted
    saveCallback: async batch => {
      await saveOutput(batch, { outputDirectory: 'output' });
      return true; // false (or throwing) leaves the batch in the mailbox
    },
  });
  console.log(results.aggregateReports.length);
} finally {
  await connection.close();
}
```

`getDmarcReportsFromMailbox()` and `watchInbox()` take the parser options plus:

| Option | Default | Description |
| --- | --- | --- |
| `reportsFolder` | `'INBOX'` | Folder (or Gmail label) holding the reports |
| `archiveFolder` | `'Archive'` | Folder to move processed messages to (`Aggregate`, `Failure`, `SMTP-TLS`, `Invalid`, `Unsaved` subfolders) |
| `delete` | `false` | Delete processed messages instead of archiving them |
| `deleteAggregate`, `deleteFailure`, `deleteSmtpTls`, `deleteInvalid` | `null` | Per-type override of `delete`; `null` inherits it |
| `test` | `false` | Don't move or delete anything |
| `batchSize` | `10` | Messages per batch; `0` for no limit |
| `since` | `null` | Only messages newer than `5m`, `3h`, `2d`, `1w`, … |
| `nProcs` | `1` | Worker threads used for parsing |
| `maxUnsavedRetries` | `2` | Retries of an unsaved batch before its messages move to `Archive/Unsaved` |
| `results` | `null` | (`getDmarcReportsFromMailbox`) results of a previous run to add to |
| `createFolders` | `true` | (`getDmarcReportsFromMailbox`) create the archive folders |
| `saveCallback` | `null` | (`getDmarcReportsFromMailbox`) called once per batch; see above |
| `checkTimeout` | `30` | (`watchInbox`) seconds to wait for IMAP IDLE, or between checks |
| `signal` | — | (`watchInbox`) an `AbortSignal` that stops watching |

To process reports as they arrive:

```ts
import { MaildirConnection, watchInbox } from 'tsdmarc';

const connection = new MaildirConnection('/home/dmarc/Maildir');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());

await watchInbox(
  connection,
  async results => {
    console.log(`${results.aggregateReports.length} new aggregate reports`);
    return true;
  },
  { signal: controller.signal, checkTimeout: 60 },
);
await connection.close();
```

See [Mailboxes](../mailboxes/) for each backend's connection options and authentication modes.

A message that times out (`jobTimeout`) or whose worker crashes is not treated as invalid: it stays in the reports folder for a retry and then moves to `Archive/Unsaved`, even with `delete` or `deleteInvalid`. When enrichment can't work at all (a revoked IPinfo token, no readable IP database), `getDmarcReportsFromMailbox()` throws the `EnrichmentError` (`InvalidIPinfoAPIKey`, `IPDatabaseError`) and nothing more is saved, moved or deleted, so the next run retries; parsedmarc files those reports as invalid or empty.

## Parallel parsing

`nProcs` (in `getDmarcReportsFromMbox()`, `getDmarcReportsFromMailbox()` and `watchInbox()`) parses messages in `worker_threads`. Only parsing is parallel; fetching, deduplication, archiving and saving stay in the calling thread. For your own jobs, `parallelMap(task, jobs, nProcs, options?)` runs the tasks built by `parseReportFileTask(config)` or `parseReportEmailTask(config)` in a worker pool and yields the results. A worker that crashes fails only its job (`WorkerCrashedError`), and `jobTimeout` fails a stuck job with `JobTimeoutError`. `jobTimeout` and `maxWorkerHeapMb` default to the task's config (one hour and 2 GiB); pass them to `parallelMap()` to override. A worker over its heap limit normally dies alone, but V8 can still abort the whole process when a single allocation crosses it.

## Logging

tsdmarc logs through a Python-style logger named `tsdmarc` that has no handler by default, so the library is silent. To see its messages on stderr (and optionally in a file):

```ts
import { configureLogging, INFO } from 'tsdmarc';

configureLogging(INFO, '/var/log/tsdmarc.log');
```

`logger`, `getLogger()`, the level constants (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`), handlers and `captureLogs()` (handy in tests) are exported. Log messages match parsedmarc's.

## Limits

To protect against hostile input (see [Security](../security/)):

- Decompressed reports are capped at 100 MiB (10 MiB for bzip2, LZMA and Zstandard zip members).
- Emails over `maxEmailSize` (50 MiB) or with more than `maxMimeParts` (10,000) MIME boundaries throw `EmailTooLargeError` before parsing; mailbox backends move such messages to the `Invalid` folder, without downloading them when the server reports the size first. `maxHeaderLines` and `maxExpandedEmailSize` throw the same error while parsing.
- Aggregate reports over `maxXmlDepth`, `maxXmlNodes` or `maxNormalizedRecords` throw `InvalidAggregateReport`; SMTP TLS reports over `maxSmtpTlsReportSize` throw `InvalidSMTPTLSReport`.
- XML entities are never expanded.
