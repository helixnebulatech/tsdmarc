# @tsdmarc/loganalytics

Send tsdmarc reports to Azure Monitor Log Analytics through the Logs Ingestion API (Data Collection Rules). Port of parsedmarc's `loganalytics.py`, on [`@azure/monitor-ingestion`](https://www.npmjs.com/package/@azure/monitor-ingestion) and [`@azure/identity`](https://www.npmjs.com/package/@azure/identity).

## Install

```sh
npm install tsdmarc @tsdmarc/loganalytics
```

`tsdmarc` is a peer dependency. Node.js 24 or later, Bun or Deno.

## Usage

```ts
import { LogAnalyticsClient } from '@tsdmarc/loganalytics';
import { getDmarcReportsFromMailbox, MaildirConnection } from 'tsdmarc';

const client = new LogAnalyticsClient({
  clientId: process.env.AZURE_CLIENT_ID ?? '',
  clientSecret: process.env.AZURE_CLIENT_SECRET ?? '',
  tenantId: process.env.AZURE_TENANT_ID ?? '',
  dce: 'https://my-dce.westeurope-1.ingest.monitor.azure.com',
  dcrImmutableId: 'dcr-00000000000000000000000000000000',
  dcrAggregateStream: 'Custom-DMARCAggregate_CL',
  dcrFailureStream: 'Custom-DMARCFailure_CL',
  dcrSmtpTlsStream: 'Custom-SMTPTLS_CL',
});

const results = await getDmarcReportsFromMailbox(
  new MaildirConnection('/var/mail/dmarc'),
);
// saveAggregate, saveFailure, saveSmtpTls
await client.publishResults(results, true, true, true);
```

`publishResults()` authenticates with a service principal (`ClientSecretCredential`) and uploads each report type to its stream. A report type is skipped when it has no reports, its stream is empty, or its `save*` flag is `false`. Records are sent with snake_case keys, like parsedmarc.

## API

| Member | Description |
| --- | --- |
| `new LogAnalyticsClient(settings)` | Create a client. Throws `LogAnalyticsException` when `clientId`, `clientSecret`, `tenantId`, `dce` or `dcrImmutableId` is empty. |
| `publishResults(results, saveAggregate, saveFailure, saveSmtpTls)` | Upload `results` (`{ aggregateReports, failureReports, smtpTlsReports }`, as returned by `getDmarcReportsFromMailbox()`). |
| `publishJson(results, logsClient, dcrStream)` | Upload already snake_case records to one stream with a given uploader. |
| `conf` | The `LogAnalyticsConfig` built from the settings. |
| `LogAnalyticsException` | Thrown on invalid settings and failed uploads (`Upload failed: ...`). |

### Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `clientId` | `string` | required | Client ID of the service principal. |
| `clientSecret` | `string` | required | Client secret of the service principal. |
| `tenantId` | `string` | required | Tenant ID where the service principal resides. |
| `dce` | `string` | required | Data Collection Endpoint (DCE) used by the DCR. |
| `dcrImmutableId` | `string` | required | Immutable ID of the Data Collection Rule. |
| `dcrAggregateStream` | `string` | required (may be `''`) | Stream for aggregate reports. Empty skips them. |
| `dcrFailureStream` | `string` | required (may be `''`) | Stream for failure reports. Empty skips them. |
| `dcrSmtpTlsStream` | `string` | required (may be `''`) | Stream for SMTP TLS reports. Empty skips them. |

See Microsoft's [Logs Ingestion API overview](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview) to set up the DCE, DCR and table.

## CLI

With [`@tsdmarc/cli`](https://github.com/helixnebulatech/tsdmarc/tree/main/packages/cli#readme), use the `[log_analytics]` section of the configuration file (the same as parsedmarc's): `client_id`, `client_secret`, `tenant_id`, `dce`, `dcr_immutable_id`, `dcr_aggregate_stream`, `dcr_failure_stream` (or the legacy `dcr_forensic_stream`) and `dcr_smtp_tls_stream`.

## Notes

- Each HTTP attempt (upload chunks, retries, token requests) gets azure-core's 300 s timeout as a single per-request limit. The JavaScript pipeline has no separate connect and read timeouts, and no default timeout at all.
- Integers larger than 2^53 are sent exactly, like Python's `json`.
- A report over 1,000,000 bytes of JSON (the SDK's chunk size and the service's request limit) is left out with the warning `Report <id> not sent to Log Analytics: <n> bytes exceeds the 1000000-byte limit`, and the rest of the batch is sent; sent alone, the service would reject it.
- `publishResults()` tries all three streams before throwing: the one error unchanged, or a `LogAnalyticsException` joining several. parsedmarc stops at the first. On a retry the streams that succeeded are uploaded again.
- **`@azure/msal-node`.** This package requires `@azure/identity` `^4.14.1`, which requests `@azure/msal-node@^7.1.0`, the first release with the fix for [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) (`@azure/identity` 4.14.0 requested the affected `^6`). No override is needed; if your lockfile still holds `@azure/identity` 4.14.0, update it.

Full list of differences from parsedmarc: [architecture/README.md](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
