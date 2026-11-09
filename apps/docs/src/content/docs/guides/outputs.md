---
title: Outputs and integrations
description: Send parsed reports to Elasticsearch, OpenSearch, Splunk, PostgreSQL, Kafka, S3, Azure Log Analytics, Grafana Loki, syslog, GELF, webhooks and email.
---

Besides JSON and CSV files, tsdmarc can send every report to the destinations below. In the CLI, configure the section and turn on `save_aggregate`, `save_failure` and/or `save_smtp_tls` in `[general]`: **without them nothing is sent**, even when a section is configured. Section options are listed in the [configuration reference](../configuration/).

| Destination | CLI section | Library |
| --- | --- | --- |
| Elasticsearch 8 / 9 | `[elasticsearch]` | `@tsdmarc/elasticsearch` |
| OpenSearch | `[opensearch]` | `@tsdmarc/opensearch` |
| Splunk HTTP Event Collector | `[splunk_hec]` | `HECClient` from `tsdmarc` |
| PostgreSQL | `[postgresql]` | `@tsdmarc/postgres` |
| Apache Kafka | `[kafka]` | `@tsdmarc/kafka` |
| Amazon S3 / S3-compatible | `[s3]` | `@tsdmarc/s3` |
| Azure Log Analytics | `[log_analytics]` | `@tsdmarc/loganalytics` |
| Syslog (UDP, TCP, TLS) | `[syslog]` | `SyslogClient` from `tsdmarc` |
| Graylog GELF (UDP, TCP, TLS) | `[gelf]` | `GelfClient` from `tsdmarc` |
| HTTP webhook | `[webhook]` | `WebhookClient` from `tsdmarc` |
| Grafana Loki | `[loki]` | `LokiClient` from `tsdmarc` |
| Email (SMTP or Graph) | `[smtp]` | `@tsdmarc/smtp`, `@tsdmarc/msgraph` |

Every output writes parsedmarc's snake_case fields, so existing dashboards, queries and consumers keep working. Close clients when you are done: an open socket keeps Node.js running.

Keep credentials out of URLs: use `user` and `password` (or `api_key`) for Elasticsearch and OpenSearch, `user` and `password` for PostgreSQL, `username` and `password` (or `token`) for Loki, and `token` for Splunk HEC. URLs written to the log have their password replaced with `***` (`https://user:***@host:9200`, or `https://***@host` when the userinfo can't be told apart from the rest), but the error messages of drivers and URL parsers can still quote a malformed URL or connection string.

## Elasticsearch

`@tsdmarc/elasticsearch` uses the official Elasticsearch **v9** client (parsedmarc pins v8). It sends `compatible-with=8` headers by default, so it works with both Elasticsearch 8 and 9 servers.

```ini
[general]
save_aggregate = True
save_failure = True

[elasticsearch]
hosts = https://elastic.example.com:9200
user = tsdmarc
password = ...
```

```ts
import {
  AlreadySaved,
  getDefaultConnection,
  saveAggregateReportToElasticsearch,
  setDefaultConnection,
  setHosts,
} from '@tsdmarc/elasticsearch';

await setHosts(['elastic.example.com:9200'], {
  useSsl: true,
  username: 'tsdmarc',
  password: process.env.ES_PASSWORD,
});

for (const report of results.aggregateReports) {
  try {
    await saveAggregateReportToElasticsearch(report, { monthlyIndexes: false });
  } catch (error) {
    if (!(error instanceof AlreadySaved)) throw error; // duplicates are skipped
  }
}

await getDefaultConnection()?.close();
setDefaultConnection(null);
```

Reports are stored in daily indexes (`dmarc_aggregate-YYYY-MM-DD`, `dmarc_failure-…`, `smtp_tls-…`; monthly with `monthly_indexes`), which makes records retention (GDPR and similar) easy: delete old indexes. Or write to [data streams](#data-streams-and-records-retention) instead. An already-saved report raises `AlreadySaved` and is skipped.

:::caution[Shard limit]
Elasticsearch limits shards to 1,000 per node by default, and each daily index uses one. With more than about three years of data, raise the limit (Dev Tools → Console):

```text
PUT _cluster/settings
{ "persistent": { "cluster.max_shards_per_node": 2000 } }
```

Check current usage with `GET /_cluster/health?pretty`.
:::

`setHosts()` registers one default client for the whole process, and a later call redirects the saves still in progress. To write to several clusters at once (one per tenant, say), create a client per cluster with `createClient()`, which takes the same options as `setHosts()` without registering anything, and pass it as `client` to the save functions, `createIndexes()` and `migrateIndexes()`:

```ts
import {
  createClient,
  saveAggregateReportToElasticsearch,
} from '@tsdmarc/elasticsearch';

const tenantClient = await createClient('https://tenant-a.example.com:9200', {
  apiKey: process.env.TENANT_A_KEY,
});
await saveAggregateReportToElasticsearch(report, { client: tenantClient });
await tenantClient.close();
```

The save functions create new indexes with `date_detection: false` and explicit mappings for the date fields (`date_range`, `date_begin`, `date_end`, `arrival_date`, `sample.date`), so a text field that happens to look like a date (a report ID such as `2026-11-01`) can't be mapped as `date` by the first document. parsedmarc creates bare indexes. Existing indexes are not changed, and `createIndexes()` without `mappings` still creates bare ones.

The sender of an aggregate report picks its `date_range`, and each day gets its own index, so a small report could create hundreds of indexes and use up the shard limit. tsdmarc spreads one report over at most 31 indexes (`max_indexes_per_report`, `maxIndexesPerReport` in the save options; `0` removes the limit): later records go to the report's first index, with their dates unchanged.

Failure indexes map a fixed list of `sample.headers` fields (those the shipped dashboards use, plus a few such as `cc` and `received-spf`), with `dynamic: false` for the rest. Every header is still saved and shown, but only the listed ones can be searched; dots in header names become `_`. Mapping every header name a sender sends, as parsedmarc does, can reach the index's 1,000-field limit and get later samples of that index rejected. Indexes created by earlier versions keep their mapping.

Every saved document carries an `@timestamp` field, with or without data streams: each record's begin date (`date_begin`) for aggregate reports (the report's begin date unless a report spanning more than a day was split into daily records), the arrival date for failure reports, and the report's begin date for SMTP TLS reports. These are the same dates that pick the dated index. Documents are written with `op_type=create`, which data streams require.

At startup the CLI checks the aggregate, failure and SMTP TLS indexes for documents saved by older versions without the combined DKIM/SPF result fields the dashboards use, and backfills them in the background with `_update_by_query`, as parsedmarc does. Errors only produce a warning.

### Data streams and records retention

Set `use_data_streams = True` in `[elasticsearch]` (`useDataStreams: true` in the save functions' options) to write to [data streams](https://www.elastic.co/docs/manage-data/data-store/data-streams) instead of dated indexes. Each report type then goes to one data stream named like the indexes without the date: `dmarc_aggregate`, `dmarc_failure` and `smtp_tls`, with `index_prefix`, `index_suffix` or the `index_prefix_domain_map` prefix applied as usual. The cluster creates the stream's backing indices (`.ds-dmarc_aggregate-…`), and an ILM policy you attach rolls them over and deletes old ones, so there is one stable name per report type and far fewer shards. `monthly_indexes` is ignored, with the warning `[elasticsearch] monthly_indexes is ignored because use_data_streams is enabled`, and `max_indexes_per_report` doesn't apply.

Before a process first saves to a stream, tsdmarc puts an index template named after the stream and creates the stream if it doesn't exist yet. The template:

- matches exactly the stream's name, with no wildcard, so it never applies to the dated indexes;
- has priority 501 and sets `number_of_shards` and `number_of_replicas` from the configuration, for each new backing index;
- maps `@timestamp` as a date, plus the same date fields and `sample.headers` mapping as the dated indexes tsdmarc creates (parsedmarc's template maps only `@timestamp`);
- includes a component template named `<stream>@custom`, such as `dmarc_aggregate@custom`, if one exists.

Data streams need Elasticsearch 8.7 or later, because the template uses `ignore_missing_component_templates` to make the `@custom` component template optional. The template is put again in every process, so changes made to it directly don't last: put your own settings, such as the ILM policy, in the `@custom` component template.

tsdmarc doesn't create or change any ILM policy. This example rolls each stream over every 30 days, or sooner when a primary shard reaches 50 GB, and deletes a backing index 180 days after its rollover:

```text
PUT _ilm/policy/tsdmarc
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": {
            "max_age": "30d",
            "max_primary_shard_size": "50gb"
          }
        }
      },
      "delete": {
        "min_age": "180d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

Attach it to each stream through its `@custom` component template:

```text
PUT _component_template/dmarc_aggregate@custom
{
  "template": {
    "settings": {
      "index.lifecycle.name": "tsdmarc"
    }
  }
}
```

Repeat that for `dmarc_failure@custom` and `smtp_tls@custom`, and for the prefixed or suffixed names if you use them. The component template applies only to backing indices created after it. A stream that already exists has a write index with no policy, so nothing would ever roll it over; attach the policy to its existing backing indices as well:

```text
PUT dmarc_aggregate/_settings
{
  "index.lifecycle.name": "tsdmarc"
}
```

The delete phase's `min_age` counts from the rollover, not from the report dates, so a backing index is deleted 180 days after it stopped receiving documents, whatever dates its reports cover. If you need retention by report date, keep using dated indexes and delete them by name.

On Elastic Cloud Serverless, which has no ILM, use a [data stream lifecycle](https://www.elastic.co/docs/manage-data/lifecycle/data-stream) instead:

```text
PUT _data_stream/dmarc_aggregate/_lifecycle
{
  "data_retention": "180d"
}
```

#### Switching an existing installation to data streams

Dated indexes that already exist are left alone. They keep working next to the streams: the shipped dashboards use the `dmarc_aggregate*`, `dmarc_f*` and `smtp_tls*` index patterns, which match both, and the duplicate check searches both (`<name>-*,<name>`), so a report already in a dated index is not saved again into a stream. Delete the dated indexes when they age out of your retention period, or move their documents into the streams. Documents saved by earlier releases have no `@timestamp`, which a data stream requires, so add it while reindexing. Run tsdmarc once with `use_data_streams = True` first, so the stream and its template exist; a reindex into a name that is not a data stream yet creates an ordinary index of that name instead:

```text
POST _reindex
{
  "source": {"index": "dmarc_aggregate-*"},
  "dest": {"index": "dmarc_aggregate", "op_type": "create"},
  "script": {
    "lang": "painless",
    "source": "ctx._source['@timestamp'] = ctx._source.date_begin"
  }
}
```

Use `date_begin` for `smtp_tls-*` too, and `arrival_date` for `dmarc_failure-*`. Delete the dated indexes once the reindex has finished; until then, the dashboards count every document twice.

If saving fails with `cannot create the data stream dmarc_aggregate: an index or alias with that name already exists`, an index or alias already uses the stream's name (parsedmarc releases before 5.0.0 wrote to an undated `dmarc_aggregate` index, for example). tsdmarc refuses to write into it rather than mix new documents in. Move its documents to a dated name, which the dashboards still match, and delete it:

```text
POST _reindex
{
  "source": {"index": "dmarc_aggregate"},
  "dest": {"index": "dmarc_aggregate-legacy"}
}

DELETE dmarc_aggregate
```

## OpenSearch

```ini
[opensearch]
hosts = https://opensearch.example.com:9200
user = admin
password = ...
```

For Amazon OpenSearch Service with IAM authentication:

```ini
[opensearch]
hosts = https://search-domain.eu-west-1.es.amazonaws.com
auth_type = awssigv4
aws_region = eu-west-1
# aws_service = aoss   (OpenSearch Serverless)
```

The library API mirrors Elasticsearch's, including `createClient()` and the `client` option: `setHosts()`, `saveAggregateReportToOpenSearch()`, `saveFailureReportToOpenSearch()`, `saveSmtpTlsReportToOpenSearch()`, `createIndexes()`, `migrateIndexes()`.

### Data streams on OpenSearch

`use_data_streams = True` in `[opensearch]` (`useDataStreams: true`) works as for [Elasticsearch](#data-streams-and-records-retention): same stream names, template (priority 501, exact-name pattern, `@timestamp` and date mappings), duplicate check, `@timestamp` field and migration steps (the `_reindex` commands are the same). The differences:

- There is no `@custom` component template: an [ISM](https://docs.opensearch.org/latest/im-plugin/ism/index/) policy attaches itself to the backing indices (`.ds-dmarc_aggregate-000001`, …) through its `ism_template`.
- OpenSearch rejects data stream names that start with `.`, so an `index_prefix` starting with `.` can't be used with this option.
- Amazon OpenSearch Serverless (`aws_service = aoss`) has no data streams or ISM, so leave `use_data_streams` off there.

tsdmarc doesn't create or change any ISM policy. This example rolls each stream over every 30 days, or sooner when a primary shard reaches 50 GB, and deletes a backing index 180 days after it was created. List the stream names themselves in `ism_template`, including any prefix or suffix: a `.ds-dmarc_aggregate-*` pattern doesn't match the backing indices.

```text
PUT _plugins/_ism/policies/tsdmarc
{
  "policy": {
    "description": "tsdmarc data stream retention",
    "default_state": "hot",
    "states": [
      {
        "name": "hot",
        "actions": [
          {
            "rollover": {
              "min_index_age": "30d",
              "min_primary_shard_size": "50gb"
            }
          }
        ],
        "transitions": [
          {
            "state_name": "delete",
            "conditions": {"min_index_age": "180d"}
          }
        ]
      },
      {
        "name": "delete",
        "actions": [{"delete": {}}],
        "transitions": []
      }
    ],
    "ism_template": [
      {
        "index_patterns": ["dmarc_aggregate", "dmarc_failure", "smtp_tls"],
        "priority": 100
      }
    ]
  }
}
```

The `ism_template` only applies to backing indices created after the policy. To attach the policy to the backing indices of a stream that already exists:

```text
POST _plugins/_ism/add/dmarc_aggregate
{
  "policy_id": "tsdmarc"
}
```

`min_index_age` counts from when the backing index was created, not from the report dates. If you need retention by report date, keep using dated indexes and delete them by name.

## Splunk

tsdmarc sends aggregate, failure and SMTP TLS reports to a Splunk [HTTP Event Collector (HEC)](https://docs.splunk.com/Documentation/Splunk/latest/Data/AboutHEC), with the source types `dmarc:aggregate`, `dmarc:failure` and `smtp:tls` that the [Splunk dashboards](../dashboards/#splunk) use.

```ini
[splunk_hec]
url = https://splunkhec.example.com
token = HECTokenGoesHere
index = email
```

```ts
import { HECClient } from 'tsdmarc';

const hec = new HECClient('https://splunkhec.example.com', token, 'email');
await hec.saveAggregateReportsToSplunk(results.aggregateReports);
await hec.saveSmtpTlsReportsToSplunk(results.smtpTlsReports);
hec.close();
```

Events carry `source: "tsdmarc"` (parsedmarc sends `parsedmarc`) and the host name reported by the OS.

## PostgreSQL

```ini
[postgresql]
host = localhost
user = tsdmarc
password = ...
database = dmarc
```

A `connection_string` (a libpq URI or `key=value` string) also works. Leave the password out of it (`postgresql://tsdmarc@localhost/dmarc`, with `PGPASSWORD` or `~/.pgpass` supplying it): a malformed connection string can make the driver quote it in an error.

Tables are created automatically on first use (`CREATE TABLE IF NOT EXISTS`), with the same schema as parsedmarc, so the Grafana PostgreSQL dashboard works. Connection strings, `sslmode` and the `PG*` variables follow libpq's rules; without a host, tsdmarc connects to the local Unix socket.

```ts
import { AlreadySaved, PostgreSQLClient } from '@tsdmarc/postgres';

const pg = await PostgreSQLClient.create({
  connectionString: process.env.DATABASE_URL,
});
try {
  for (const report of results.aggregateReports) {
    await pg.saveAggregateReportToPostgresql(report).catch(error => {
      if (!(error instanceof AlreadySaved)) throw error;
    });
  }
} finally {
  await pg.close();
}
```

### TLS

The default `sslmode` is libpq's (and parsedmarc's) `prefer`: TLS without checking the server's certificate, and a plain-text reconnection, logged as a warning, if TLS fails. Anyone on the network path can force that fallback or present their own certificate and read the password and the reports. `require` refuses the fallback but still accepts any certificate; only `verify-full` checks that the server is the one you configured:

```ini
[postgresql]
host = db.example.com
user = tsdmarc
password = ...
database = dmarc
sslmode = verify-full
# CA file, or `system` for the system's trusted roots
sslrootcert = system
```

The default stays `prefer` so that parsedmarc configurations keep working against servers without TLS, such as the official PostgreSQL container image. Over a Unix socket TLS is never used, as in libpq. `sslmode` keeps libpq's meaning, not node-postgres's (which treats `prefer`, `require` and `verify-ca` as `verify-full`).

libpq options that demand a protection pg can't provide (`channel_binding=require`, `require_auth`, `requirepeer`, `sslcertmode=require`, `gssencmode=require`, and `sslcrldir` with TLS), in the connection string or as `PG*` variables, refuse the connection instead of being ignored. `sslcrl` and `ssl_min_protocol_version`/`ssl_max_protocol_version` are honored.

Each statement times out after `query_timeout` seconds (300; `queryTimeout` in the library, `0` for none, parsedmarc's behavior): the save fails with `PostgreSQLError` and the next one reconnects, so a hung server can't block the run.

## Kafka

```ini
[kafka]
hosts = kafka1.example.com:9093, kafka2.example.com:9093
user = tsdmarc
password = ...
aggregate_topic = dmarc_aggregate
failure_topic = dmarc_failure
smtp_tls_topic = smtp_tls
```

With a user or password, tsdmarc connects with TLS and SASL PLAIN, as parsedmarc documents (parsedmarc's own client silently skips SASL). Each aggregate record is sent as one message.

```ts
import { KafkaClient } from '@tsdmarc/kafka';

const kafka = await KafkaClient.create(['kafka1.example.com:9093'], {
  username: 'tsdmarc',
  password: process.env.KAFKA_PASSWORD,
});
await kafka.saveAggregateReportsToKafka(
  results.aggregateReports,
  'dmarc_aggregate',
);
await kafka.close();
```

## Amazon S3

```ini
[s3]
bucket = my-bucket
path = tsdmarc
region_name = eu-west-1
# endpoint_url = https://minio.example.com   (S3-compatible services)
```

Each report is stored as a JSON object under `<path>/<type>/year=YYYY/month=MM/day=DD/<report id>_<hash>.json`, with the same keys and metadata as parsedmarc 11.2. The date is the report's begin date. The report ID is percent-encoded into a single key segment (`/`, `%`, control characters, non-ASCII characters and the characters AWS lists as "characters to avoid") and shortened so the key fits in 1,024 bytes. `<hash>` is the first 16 hex characters of a SHA-256 hash of the report type and the fields that identify the report (aggregate: organization name, report ID, policy domain, begin and end dates; SMTP TLS: organization name, report ID, begin and end dates and each policy domain), never of enrichment such as reverse DNS, so a retried report overwrites its own object. Metadata values are percent-encoded (`%`, control and non-ASCII characters) and cut to 256 characters. Credentials and region come from the options or the AWS SDK's default chain (environment, shared config, instance role).

Failure reports are saved as `<path>/failure/year=…/month=…/day=…/<reported domain>_<hash>.json`, dated by their UTC arrival date, with `reported_domain` and `arrival_date` metadata; their hash covers the arrival date, reported domain, original mail from, recipient and envelope ID, source IP address and the sample.

The hashed fields aren't secret, so, as in parsedmarc, a forged report whose reporter name, report ID, policy domain and dates all match a real one overwrites it (S3 Versioning keeps both). `preventOverwrite: true` (`prevent_overwrite = True`, tsdmarc only) writes with `If-None-Match: *` instead: an identical object is left alone, and a different report with the same key is saved next to it as `<report id>_<hash>-<sha256 of the JSON>.json`, with a warning. It needs `s3:GetObject` besides `s3:PutObject` and a service with conditional writes (Amazon S3, Cloudflare R2; older MinIO and Ceph ignore them). The first save checks the service by writing `<path>/.tsdmarc-conditional-write-check` twice and refuses to save if it ignores the header.

```ts
import { S3Client } from '@tsdmarc/s3';

const s3 = new S3Client('my-bucket', 'tsdmarc', { regionName: 'eu-west-1' });
for (const report of results.aggregateReports) {
  await s3.saveAggregateReportToS3(report);
}
s3.close();
```

## Azure Log Analytics

Sends reports to Log Analytics workspaces (and Microsoft Sentinel) through a Data Collection Endpoint and Data Collection Rule:

```ini
[log_analytics]
client_id = ...
client_secret = ...
tenant_id = ...
dce = https://my-dce.westeurope-1.ingest.monitor.azure.com
dcr_immutable_id = dcr-...
dcr_aggregate_stream = Custom-DMARCAggregate
dcr_failure_stream = Custom-DMARCFailure
dcr_smtp_tls_stream = Custom-SMTPTLS
```

```ts
import { LogAnalyticsClient } from '@tsdmarc/loganalytics';

const la = new LogAnalyticsClient({
  clientId,
  clientSecret,
  tenantId,
  dce,
  dcrImmutableId,
  dcrAggregateStream,
  dcrFailureStream,
  dcrSmtpTlsStream,
});
await la.publishResults(results, true, true, true); // aggregate, failure, SMTP TLS
```

A report over 1,000,000 bytes of JSON (the service's request limit) is left out with a warning, so it doesn't hold back the rest of the batch. A stream that fails doesn't stop the other two; `publishResults()` throws afterwards (parsedmarc stops at the first failure).

## Syslog

Each row of the [CSV output](../output-formats/) (an aggregate record, a failure report, an SMTP TLS policy or failure detail) is sent as one JSON message, byte-for-byte like Python's `SysLogHandler`.

```ini
[syslog]
server = syslog.example.com
port = 6514
protocol = tls
cafile_path = /path/to/ca-cert.pem
```

```ts
import { SyslogClient } from 'tsdmarc';

const syslog = await SyslogClient.create('syslog.example.com', 514, {
  protocol: 'udp',
});
await syslog.saveAggregateReportToSyslog(results.aggregateReports);
await syslog.close();
```

Over TCP and TLS a dropped connection is reopened (with a 1–30 s back-off) and the message sent again; if messages are still lost, the save throws `SyslogError`, so the CLI counts it as an output error. Python's `SysLogHandler` keeps writing to a dead socket and reports success. UDP stays best-effort. Each client has its own logger (`client.logger`): with two clients, rows only go to their own server, while parsedmarc's shared logger sends them to both.

## GELF (Graylog)

```ini
[gelf]
host = graylog.example.com
port = 12201
mode = tls
# cafile = /path/to/ca.pem              (tsdmarc only)
# skip_certificate_verification = True  (tsdmarc only; parsedmarc's behavior)
```

GELF over TLS verifies the server certificate by default (pygelf doesn't). Messages keep parsedmarc's `_parsedmarc` field and `short_message` texts, so existing Graylog streams and dashboards work.

```ts
import { GelfClient } from 'tsdmarc';

const gelf = new GelfClient('graylog.example.com', 12201, 'udp');
await gelf.saveAggregateReportToGelf(results.aggregateReports);
await gelf.close();
```

As with syslog, TCP and TLS connections reconnect, lost messages make the save throw `GelfError` (pygelf drops them without a trace), and each client has its own logger.

## Webhooks

Each report is POSTed as a JSON body (snake_case, as in the JSON files) to the URL configured for its type:

```ini
[webhook]
aggregate_url = https://hooks.example.com/dmarc/aggregate
failure_url = https://hooks.example.com/dmarc/failure
smtp_tls_url = https://hooks.example.com/dmarc/smtp-tls
timeout = 60
```

```ts
import { pyJsonDumps, toSnakeCaseKeys, WebhookClient } from 'tsdmarc';

const webhook = new WebhookClient(aggregateUrl, failureUrl, smtpTlsUrl, {
  timeout: 60,
});
for (const report of results.aggregateReports) {
  await webhook.saveAggregateReportToWebhook(
    pyJsonDumps(toSnakeCaseKeys(report), { ensureAscii: false }),
  );
}
webhook.close();
```

By default, HTTP and network errors are logged, not thrown, as in parsedmarc. With `throwOnError: true` (what the CLI uses), network errors, timeouts and non-2xx responses throw instead, without the URL in the message, so the CLI counts them as output errors and keeps the mailbox messages for a retry.

## Grafana Loki

Pushes every report record as one JSON log line to the [Loki push API](https://grafana.com/docs/loki/latest/reference/loki-http-api/#ingest-logs) (`/loki/api/v1/push`). The lines are the same flat records the syslog and GELF outputs send, plus `report_type` (`aggregate`, `failure` or `smtp_tls`) and `domain` (the record's `domain`, `reported_domain` or `policy_domain`), so LogQL's `| json` parser can filter and sum them. For example, messages failing DMARC per domain:

```text
sum by (domain) (sum_over_time({job="parsedmarc", report_type="aggregate"} | json dmarc_aligned, count | dmarc_aligned="false" | unwrap count [1d]))
```

Name the fields to extract: a bare `| json` turns every field into a label, and the many distinct values quickly exceed Loki's per-query series limit (`max_query_series`, 500 by default). A Grafana dashboard for these lines ships in `dashboards/grafana/Grafana-DMARC_Reports-Loki.json` (see [Dashboards](../dashboards/)); import it and pick your Loki datasource for its `DS_LOKI` input. It expects the default `job=parsedmarc` label and `label_fields`.

```ini
[loki]
url = https://loki.example.com:3100
username = tsdmarc
password = ...
labels = env=prod
```

Streams are labeled `job=parsedmarc` and `host=<host name>` (the name the OS reports, `os.hostname()`; parsedmarc uses the FQDN), overridable and extendable with `labels`, plus the record fields named in `label_fields` (`report_type` and `domain` by default). Keep label fields to fields with few distinct values: every combination is its own Loki stream. Entries are timestamped at the push by default, or at the begin of the reported period (the arrival date for failure reports) with `timestamp = report_begin`; Loki rejects entries older than its `reject_old_samples_max_age` (a week by default), so that mode loses late reports unless Loki is configured for them. Large reports are split into pushes of `batch_size` lines. Basic authentication, a bearer token and a tenant ID (`X-Scope-OrgID`) are supported.

Redirects are not followed, so a 3xx response is a failed push. Any failed push throws `LokiError`, so the CLI counts it as an output error and keeps the batch's mailbox messages for a retry. Loki doesn't deduplicate: each retry adds another copy of the batch's lines.

```ts
import { LokiClient } from 'tsdmarc';

const loki = new LokiClient('https://loki.example.com:3100', {
  username: 'tsdmarc',
  password: process.env.LOKI_PASSWORD,
  labels: { env: 'prod' },
});
await loki.saveAggregateReportToLoki(results.aggregateReports);
await loki.saveFailureReportToLoki(results.failureReports);
await loki.saveSmtpTlsReportToLoki(results.smtpTlsReports);
loki.close();
```

## Email (SMTP or Microsoft Graph)

The CLI emails a zip of the JSON and CSV files after a run that parsed at least one report:

```ini
[smtp]
host = smtp.example.com
port = 587
user = dmarc@example.com
password = ...
from = dmarc@example.com
to = admin@example.com, security@example.com
subject = DMARC report
```

With `ssl = False` (the default), the connection starts in plain text and must be upgraded with STARTTLS before authenticating: as in parsedmarc 11.2.1, if the server doesn't advertise STARTTLS the username and password are not sent and `Failed to email results` is logged. `starttls = True` always requires the upgrade; `starttls = False` never upgrades, so the credentials and the email go in plain text (a warning is logged at startup with `ssl = False`). Use it only for a relay on the same host. Without `host` and with `[msgraph]` configured, the email is sent through Microsoft Graph instead (see [Mailboxes](../mailboxes/#sending-the-summary-email-through-graph)).

```ts
import { emailResults } from '@tsdmarc/smtp';
import { getReportZip } from 'tsdmarc';

await emailResults(
  results,
  'smtp.example.com',
  'dmarc@example.com',
  ['admin@example.com'],
  {
    port: 587,
    username: 'dmarc@example.com',
    password: process.env.SMTP_PASSWORD,
    reportZip: getReportZip, // builds the attachment from the results
  },
);
```

`sendEmail(host, from, options)` sends an arbitrary message with attachments.

## Saving is all-or-nothing per mailbox batch

When reading a mailbox, a batch's messages are archived only after every output accepted the batch; see [CLI usage](../cli/#processing-a-mailbox). In the library, the same happens through `saveCallback`.
