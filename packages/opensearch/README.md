# @tsdmarc/opensearch

Save tsdmarc reports to OpenSearch (self-managed or Amazon OpenSearch Service). Port of parsedmarc's `opensearch.py`, on [`@opensearch-project/opensearch`](https://www.npmjs.com/package/@opensearch-project/opensearch): same index names, documents, duplicate checks and migrations, so parsedmarc's OpenSearch Dashboards and Grafana dashboards ([`dashboards/`](https://github.com/helixnebulatech/tsdmarc/tree/main/dashboards)) work unchanged.

## Install

```sh
npm install tsdmarc @tsdmarc/opensearch
```

`tsdmarc` is a peer dependency. Node.js 24 or later, Bun or Deno.

## Usage

```ts
import {
  AlreadySaved,
  getDefaultConnection,
  migrateIndexes,
  saveAggregateReportToOpenSearch,
  saveFailureReportToOpenSearch,
  saveSmtpTlsReportToOpenSearch,
  setDefaultConnection,
  setHosts,
} from '@tsdmarc/opensearch';
import { parseReportFile } from 'tsdmarc';

await setHosts('search.example.com:9200', {
  useSsl: true,
  username: process.env.OPENSEARCH_USER,
  password: process.env.OPENSEARCH_PASSWORD,
});
await migrateIndexes({
  aggregateIndexes: ['dmarc_aggregate'],
  smtpTlsIndexes: ['smtp_tls'],
});

try {
  const parsed = await parseReportFile('report.xml.gz');
  if (parsed.reportType === 'aggregate') {
    await saveAggregateReportToOpenSearch(parsed.report);
  } else if (parsed.reportType === 'failure') {
    await saveFailureReportToOpenSearch(parsed.report);
  } else {
    await saveSmtpTlsReportToOpenSearch(parsed.report);
  }
} catch (error) {
  if (!(error instanceof AlreadySaved)) {
    throw error;
  }
} finally {
  await getDefaultConnection()?.close();
  setDefaultConnection(null);
}
```

`setHosts()` registers a module-wide default client that the other functions use, like parsedmarc's DSL connection. The save functions create the index if needed and throw `AlreadySaved` when the report is already stored.

### Several clusters

The default connection is module state, shared by everything in the process: a later `setHosts()` or `setDefaultConnection()` redirects the requests of saves still in progress. One connection at a time is supported that way. An application that writes to several clusters at once (one per tenant, say) creates a client per cluster with `createClient()`, which takes the same options as `setHosts()` but registers nothing, and passes it as `client`:

```ts
import {
  createClient,
  saveAggregateReportToOpenSearch,
} from '@tsdmarc/opensearch';

const tenantClient = await createClient('https://tenant-a.example.com:9200', {
  username: 'tsdmarc',
  password: process.env.TENANT_A_PASSWORD,
});
await saveAggregateReportToOpenSearch(report, { client: tenantClient });
await tenantClient.close();
```

`client` is accepted by the save functions, `createIndexes()` (fourth argument, `{ client }`) and `migrateIndexes()`. A client from anywhere else works too, with its own settings.

Documents go to `[indexPrefix]<base>[_indexSuffix]-YYYY-MM-DD` (or `-YYYY-MM` with `monthlyIndexes`), with `<base>` one of `dmarc_aggregate`, `dmarc_failure` and `smtp_tls`. Field names are snake_case, as in parsedmarc. Every document carries an `@timestamp`: the record's begin date for aggregate reports, the arrival date for failure reports and the begin date for SMTP TLS reports.

### Data streams

With `useDataStreams: true`, each report type goes to one data stream named like the index without the date (`[indexPrefix]<base>[_indexSuffix]`), and `monthlyIndexes` is ignored. The save functions put an index template named after the stream, whose `index_patterns` is the exact name, and create the stream; an ISM policy attaches itself to the backing indices through its `ism_template`. tsdmarc puts its template again in every process, so edit the policy, not the template. Retention is up to you. Dated indexes saved before the switch stay where they are, and the duplicate search covers both. If an index or alias already holds a stream's name (such as an undated index from parsedmarc before 5.0.0), saving fails with `OpenSearchError`.

## Amazon OpenSearch Service

`authType: 'awssigv4'` signs requests with AWS Signature Version 4. Credentials come from the AWS SDK's default provider chain (environment, shared config files, SSO, instance or container roles), and are checked when `setHosts()` runs. The AWS SDK is loaded only in this mode.

```ts
await setHosts('search-domain.eu-west-1.es.amazonaws.com:443', {
  useSsl: true,
  authType: 'awssigv4',
  awsRegion: 'eu-west-1',
  awsService: 'es', // 'aoss' for OpenSearch Serverless
});
```

## API

| Function | Description |
| --- | --- |
| `setHosts(hosts, options?)` | Create the client for one host or an array of hosts and register it as the default connection. Returns the client. |
| `createClient(hosts, options?)` | Create a client like `setHosts()` without registering it, to pass as `client` (see [Several clusters](#several-clusters)). |
| `saveAggregateReportToOpenSearch(report, options?)` | Save an aggregate report, one document per record. |
| `saveFailureReportToOpenSearch(report, options?)` | Save a failure report. `saveForensicReportToOpenSearch` is a backward-compatible alias. |
| `saveSmtpTlsReportToOpenSearch(report, options?)` | Save an SMTP TLS report. |
| `migrateIndexes(options?)` | Run parsedmarc's index migrations and backfills. Logs warnings instead of throwing. |
| `createIndexes(names, settings?, mappings?, { client }?)` | Create indexes that don't exist yet (default settings: 1 shard, 0 replicas). |
| `createDataStreams(names, settings?, mappings?, { client }?)` | Put the index template of each data stream and create the streams that don't exist yet (see [Data streams](#data-streams)). |
| `getDefaultConnection()` / `setDefaultConnection(client)` | Read or replace the registered client (`null` removes it). |
| `AlreadySaved`, `OpenSearchError`, `BulkIndexError`, `ScanError` | Errors. |
| `DOCUMENT_MAPPINGS`, `BACKFILL` | The mappings parsedmarc's document classes declare, and the backfill queries/scripts `migrateIndexes()` submits. |

### `setHosts()` options

Hosts without a scheme default to port 9200; `https://` hosts default to port 443.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `useSsl` | `boolean \| null` | `false` | Use HTTPS for every host. |
| `sslCertPath` | `string \| null` | `null` | Path to the CA certificate chain (with `useSsl`). |
| `skipCertificateVerification` | `boolean` | `false` | Skip certificate verification (with `useSsl`). |
| `username` | `string \| null` | `null` | Basic auth user name (used only with `password`). |
| `password` | `string \| null` | `null` | Basic auth password. |
| `apiKey` | `string \| null` | `null` | Accepted but not sent, like parsedmarc (opensearch-py ignores a client-level `api_key`). |
| `timeout` | `number \| null` | `60` | Request timeout in seconds. `null` disables it; `0` or less throws `ValueError`. |
| `authType` | `string` | `'basic'` | `'basic'` or `'awssigv4'`. |
| `awsRegion` | `string \| null` | `null` | AWS region; required with `awssigv4`. |
| `awsService` | `string` | `'es'` | Service name to sign for; `'aoss'` for OpenSearch Serverless. |

### Save options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `indexSuffix` | `string \| null` | — | Appended to the index name as `_<suffix>`. |
| `indexPrefix` | `string \| null` | — | Prepended to the index name as is. |
| `monthlyIndexes` | `boolean \| null` | `false` | Monthly indexes instead of daily ones (ignored with `useDataStreams`). |
| `useDataStreams` | `boolean` | `false` | Save to a data stream instead of dated indexes (see [Data streams](#data-streams)). |
| `numberOfShards` | `number` | `1` | Shards for a new index. |
| `numberOfReplicas` | `number` | `0` | Replicas for a new index. |
| `maxIndexesPerReport` | `number` | `31` | Most indexes one aggregate report may spread over; later records go to its first index. `0` removes the limit. tsdmarc only. |
| `client` | `Client \| null` | default connection | The OpenSearch client to use (see [Several clusters](#several-clusters)). |

### `migrateIndexes()` options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `aggregateIndexes` | `string[] \| null` | — | Aggregate index names, backfilled as `name*`. |
| `failureIndexes` | `string[] \| null` | — | Accepted for API compatibility; unused. |
| `smtpTlsIndexes` | `string[] \| null` | — | SMTP TLS index names, backfilled as `name*`. |
| `legacyFoIndexes` | `string[] \| null` | — | Exact index names to check for the pre-5.0.0 `published_policy.fo` `long` mapping. |
| `client` | `Client \| null` | default connection | The client to use. |

## CLI

With [`@tsdmarc/cli`](https://github.com/helixnebulatech/tsdmarc/tree/main/packages/cli#readme), use the `[opensearch]` section of the configuration file (the same as parsedmarc's): `hosts`, `user`, `password`, `api_key`, `ssl`, `cert_path`, `skip_certificate_verification`, `timeout`, `index_suffix`, `index_prefix`, `monthly_indexes`, `number_of_shards`, `number_of_replicas`, `auth_type` (or `authentication_type`), `aws_region` and `aws_service`.

## Notes

Differences from parsedmarc (full list in [architecture/README.md](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc)):

- Functions are `async` and take an options object.
- Retries follow opensearch-py: 3 retries on connection errors and HTTP 502/503/504, none on a timeout (opensearch-js alone would also resend timed-out requests).
- The JavaScript client sends `/{index}/_mapping` as POST where the Python client uses PUT; servers accept both.
- `setHosts()` replaces the default connection without closing the previous client, like the Python DSL registry. On shutdown, call `await getDefaultConnection()?.close()` and `setDefaultConnection(null)`.
- Logged host URLs show the password as `***` (`user:***@`), as in parsedmarc 11.2; tsdmarc also masks everything up to the last `@` of a malformed URL.
- Error messages that include an SDK error carry the JavaScript client's message.
- Like parsedmarc, `createIndexes()` does not install `DOCUMENT_MAPPINGS`. The save functions, however, create new indexes with `date_detection: false` and mappings for the date fields only (`@timestamp`, `date_range`, `date_begin`, `date_end`, `arrival_date`, `sample.date`), so a text value that looks like a date can't map its field as `date`. parsedmarc creates bare indexes. Existing indexes are not changed.
- Data stream templates carry the same date mappings and `sample.headers` mapping as the indexes the save functions create (parsedmarc's map only `@timestamp`), and their description names tsdmarc. A data stream created by another writer between the checks, or an alias holding the name, is told apart from a name collision.
- One aggregate report spreads over at most `maxIndexesPerReport` (31) indexes: its sender picks the `date_range`, and in parsedmarc a few KB can create more than 1,000 daily indexes and use up `cluster.max_shards_per_node`. Records past the limit go to the report's first index with their dates intact.
- Dots in failure sample header names become `_`, so a `Subject.x` header can't turn `sample.headers.subject` into an object.
- New failure indexes map only a fixed list of `sample.headers` fields (those the shipped dashboards use, plus a few such as `cc` and `received-spf`) and set `dynamic: false` on the rest: every header stays in `_source` and shows in Discover, but the others cannot be searched. parsedmarc maps every header name a sender invents, which can use up `index.mapping.total_fields.limit` and get the samples of the rest of that day (or month) rejected. Indexes that already exist keep their mapping.

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
