# @tsdmarc/s3

Save tsdmarc reports to Amazon S3 or an S3-compatible service. Port of parsedmarc's `s3.py`, on the AWS SDK for JavaScript v3 ([`@aws-sdk/client-s3`](https://www.npmjs.com/package/@aws-sdk/client-s3)).

## Install

```sh
npm install tsdmarc @tsdmarc/s3
```

`tsdmarc` is a peer dependency. Node.js 24 or later, Bun or Deno.

## Usage

```ts
import { S3Client } from '@tsdmarc/s3';
import { parseReportFile } from 'tsdmarc';

const s3 = new S3Client('my-dmarc-bucket', 'dmarc', {
  regionName: 'eu-west-1',
});

try {
  const parsed = await parseReportFile('report.xml.gz');
  if (parsed.reportType === 'aggregate') {
    await s3.saveAggregateReportToS3(parsed.report);
  } else if (parsed.reportType === 'smtp_tls') {
    await s3.saveSmtpTlsReportToS3(parsed.report);
  }
} finally {
  s3.close();
}
```

Each report is written as JSON (snake_case keys, like parsedmarc) to:

```
<bucketPath>/<aggregate|failure|smtp_tls>/year=YYYY/month=MM/day=DD/<report_id>_<hash>.json
```

Keys and metadata are the same as parsedmarc's (11.2.0 and later). The date is the report's begin date. The report ID is percent-encoded into one key segment (`/`, `%`, control characters, non-ASCII and the characters AWS says to avoid) and shortened so the key fits in 1,024 bytes. `<hash>` is the first 16 hex characters of a SHA-256 hash of the report type and the fields that identify the report (aggregate: organization name, report ID, policy domain, begin and end dates; SMTP TLS: organization name, report ID, begin and end dates and the policy domains), never of enrichment, so a retried report overwrites its own object. The object metadata carries `org_name`, `org_email`, `report_id`, `begin_date` and `end_date`, each percent-encoded (`%`, control and non-ASCII characters) and cut to 256 characters.

Failure reports have no report ID: they are saved as `<reported domain>_<hash>.json` under their UTC arrival date, with `reported_domain` and `arrival_date` metadata; their hash covers the arrival date, reported domain, original mail from, recipient and envelope ID, source IP address and the sample.

## API

| Member | Description |
| --- | --- |
| `new S3Client(bucketName, bucketPath, options?)` | Create a client. `bucketPath` is the key prefix (no leading or trailing `/`). |
| `saveAggregateReportToS3(report)` | Save an aggregate report. |
| `saveSmtpTlsReportToS3(report)` | Save an SMTP TLS report. |
| `saveFailureReportToS3(report)` | Save a failure report (see Notes). `saveForensicReportToS3` is a backward-compatible alias. |
| `saveReportToS3(report, reportType)` | Save any report under `reportType` (`'aggregate'`, `'failure'` or `'smtp_tls'`). |
| `close()` | Release the SDK client's sockets. Never throws. |
| `s3` | The underlying AWS SDK `S3Client`. |

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `regionName` | `string \| null` | SDK default chain, then `us-east-1` | AWS region. |
| `endpointUrl` | `string \| null` | AWS | Endpoint of an S3-compatible service. Turns on path-style addressing, like boto3. |
| `accessKeyId` | `string \| null` | SDK default credential chain | Access key ID. |
| `secretAccessKey` | `string \| null` | SDK default credential chain | Secret access key. |
| `preventOverwrite` | `boolean` | `false` | Never replace an existing object (see below). tsdmarc only. |

Without keys, credentials come from the SDK's default chain (environment variables, shared config files, SSO, instance or container roles).

### Keeping reports that share an ID

The hashed fields aren't secret, and anyone can send a report with any of them, so by default (as in parsedmarc) a forged report that copies the reporter name, report ID, policy domain and dates of a real one overwrites it. With `preventOverwrite: true`:

- Objects are written with `If-None-Match: *`, so an existing key is never replaced.
- If the key is taken by an identical object (a retry or a reprocessed message), nothing is written.
- If it holds a different report, this one is saved as `<report_id>_<hash>-<sha256 of the JSON>.json` next to it, with a warning. Both are kept; the first one saved keeps the plain name. A retry whose enrichment (reverse DNS, GeoIP) changed is a different JSON too, so it is also kept as a copy.

It needs `s3:GetObject` as well as `s3:PutObject`, and a service that supports conditional writes (Amazon S3 since August 2024, Cloudflare R2; older MinIO and Ceph releases ignore the header and would overwrite in silence). The first save of each client checks this by writing `<bucketPath>/.tsdmarc-conditional-write-check` twice, and refuses to save if the second write isn't rejected.

## CLI

With [`@tsdmarc/cli`](https://github.com/helixnebulatech/tsdmarc/tree/main/packages/cli#readme), use the `[s3]` section of the configuration file (the same as parsedmarc's): `bucket`, `path`, `region_name`, `endpoint_url`, `access_key_id` and `secret_access_key`, plus `prevent_overwrite` (tsdmarc only).

## Notes

Differences from parsedmarc (full list in [architecture/README.md](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc)):

- Timeouts match boto3: 60 s to connect and 60 s without data on the socket (the SDK's own defaults are unlimited). The default region is looked up once per client.
- `preventOverwrite` (above).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
