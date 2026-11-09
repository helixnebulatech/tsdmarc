# @tsdmarc/kafka

Save tsdmarc reports to Apache Kafka (or Azure Event Hubs). Port of parsedmarc's `kafkaclient.py`, on [`@platformatic/kafka`](https://www.npmjs.com/package/@platformatic/kafka).

## Install

```sh
npm install tsdmarc @tsdmarc/kafka
```

`tsdmarc` is a peer dependency. Node.js 24 or later, Bun or Deno.

## Usage

```ts
import { KafkaClient } from '@tsdmarc/kafka';
import { parseReportFile } from 'tsdmarc';

// create() connects and fails fast when no broker is reachable.
const kafka = await KafkaClient.create(['kafka1.example.com:9092'], {
  username: process.env.KAFKA_USERNAME,
  password: process.env.KAFKA_PASSWORD,
});

try {
  const parsed = await parseReportFile('report.xml.gz');
  if (parsed.reportType === 'aggregate') {
    await kafka.saveAggregateReportsToKafka(parsed.report, 'dmarc_aggregate');
  } else if (parsed.reportType === 'failure') {
    await kafka.saveFailureReportsToKafka(parsed.report, 'dmarc_failure');
  } else {
    await kafka.saveSmtpTlsReportsToKafka(parsed.report, 'smtp_tls');
  }
} finally {
  await kafka.close();
}
```

Each save method takes one report or an array, plus the topic name. Topics are auto-created by the broker if it allows it.

## API

| Member | Description |
| --- | --- |
| `new KafkaClient(kafkaHosts, options?)` | Create a client. The producer connects lazily. |
| `KafkaClient.create(kafkaHosts, options?)` | Create a client and call `connect()`. |
| `connect()` | Check that a broker is reachable. Throws `KafkaError('No Kafka brokers available')` otherwise. |
| `close()` | Close the producer and its sockets. |
| `saveAggregateReportsToKafka(reports, topic)` | One message per record, with `date_range`, `org_name`, `org_email`, `report_id` and `policy_published` copied onto each record. |
| `saveFailureReportsToKafka(reports, topic)` | One message per failure report. `saveForensicReportsToKafka` is a backward-compatible alias. |
| `saveSmtpTlsReportsToKafka(reports, topic)` | One message per SMTP TLS report. |
| `KafkaError` | Thrown on broker errors (`Kafka error: ...`). |

`kafkaHosts` is an array of `host[:port]` strings.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `ssl` | `boolean` | `false` | Connect with TLS. Implied when `username` or `password` is set. |
| `username` | `string \| null` | — | SASL PLAIN username. For Azure Event Hubs use the literal `$ConnectionString`. |
| `password` | `string \| null` | — | SASL PLAIN password. For Azure Event Hubs, the Event Hub connection string. |
| `sslContext` | `tls.ConnectionOptions \| null` | Node's defaults | TLS options (CA, client certificate, ...), parsedmarc's `ssl_context`. The defaults verify the broker certificate. |

## Message format

Messages are JSON with snake_case keys, the same as parsedmarc's, so existing consumers keep working. Integers larger than 2^53 are written exactly.

## CLI

With [`@tsdmarc/cli`](https://github.com/helixnebulatech/tsdmarc/tree/main/packages/cli#readme), use the `[kafka]` section of the configuration file (the same as parsedmarc's): `hosts`, `user`, `password`, `ssl`, `skip_certificate_verification`, `aggregate_topic`, `failure_topic` (or the legacy `forensic_topic`) and `smtp_tls_topic`.

## Notes

Differences from parsedmarc (full list in [architecture/README.md](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc)):

- With a username or password, the client uses TLS + SASL PLAIN, as parsedmarc documents. parsedmarc sets `security_protocol="SSL"`, so kafka-python skips SASL and never authenticates.
- The client connects lazily. Use `KafkaClient.create()` or `connect()` to fail at startup, like parsedmarc's constructor.
- The CLI's `Initializing Kafka client: hosts=[...]` log line shows the password in host URLs as `***` (`user:***@`); parsedmarc logs Kafka hosts as given.

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
