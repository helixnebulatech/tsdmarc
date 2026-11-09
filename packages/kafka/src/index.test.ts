// Port of tests/test_kafkaclient.py. @platformatic/kafka's Producer is the
// SDK boundary; the error classes are the real ones.

import { readFileSync } from 'node:fs';

import {
  MultipleErrors,
  NetworkError,
  ProtocolError,
} from '@platformatic/kafka';
import {
  type AggregateReport,
  captureLogs,
  type FailureReport,
  type SMTPTLSReport,
  toCamelCaseKeys,
} from 'tsdmarc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KafkaClient,
  KafkaError,
  serializeValue,
  type SnakeCaseAggregateReport,
} from './index';

const kafka = vi.hoisted(() => {
  const instances: FakeProducer[] = [];
  const state: { metadataError: Error | null } = { metadataError: null };
  class FakeProducer {
    readonly options: Record<string, unknown>;
    readonly send = vi.fn((_options: unknown) => Promise.resolve({}));
    readonly metadata = vi.fn((_options: unknown) =>
      state.metadataError
        ? Promise.reject(state.metadataError)
        : Promise.resolve({}),
    );
    readonly close = vi.fn(() => Promise.resolve());
    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }
  }
  return { FakeProducer, instances, state };
});

type FakeProducer = InstanceType<typeof kafka.FakeProducer>;

vi.mock('@platformatic/kafka', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Producer: kafka.FakeProducer,
}));

function producerOf(client: KafkaClient): FakeProducer {
  return client.producer as unknown as FakeProducer;
}

function lastProducer(): FakeProducer {
  const producer = kafka.instances.at(-1);
  if (!producer) {
    throw new Error('no producer created');
  }
  return producer;
}

function aggregateReport(): AggregateReport {
  return {
    reportMetadata: {
      orgName: 'TestOrg',
      orgEmail: 'test@example.com',
      reportId: 'r-123',
      beginDate: '2024-01-01 00:00:00',
      endDate: '2024-01-02 00:00:00',
    },
    policyPublished: { domain: 'example.com', p: 'none' },
    records: [
      { source: { ipAddress: '192.0.2.1' }, count: 1 },
      { source: { ipAddress: '192.0.2.2' }, count: 2 },
    ],
  } as unknown as AggregateReport;
}

function snakeAggregateReport(): SnakeCaseAggregateReport {
  return {
    report_metadata: {
      org_name: 'TestOrg',
      org_email: 'test@example.com',
      report_id: 'r-123',
      begin_date: '2024-01-01 00:00:00',
      end_date: '2024-01-02 00:00:00',
    },
    policy_published: { domain: 'example.com', p: 'none' },
    records: [],
  };
}

interface SentMessage {
  topic: string;
  value: Record<string, unknown>;
}

function sentMessages(producer: FakeProducer): SentMessage[] {
  return producer.send.mock.calls.flatMap(
    ([options]) => (options as { messages: SentMessage[] }).messages,
  );
}

function client(): KafkaClient {
  return new KafkaClient(['b:9092']);
}

function unknownTopicError(): Error {
  // How the producer reports it: a ProtocolError inside a MultipleErrors.
  return new MultipleErrors('Producing messages failed.', [
    new ProtocolError('UNKNOWN_TOPIC_OR_PARTITION'),
  ]);
}

beforeEach(() => {
  kafka.instances.length = 0;
  kafka.state.metadataError = null;
});

describe('KafkaClient init', () => {
  // Producer config wiring: TLS, SASL, plain. Each branch has user-facing
  // security consequences if it's wrong.
  it('configures a plain connection without TLS or SASL', () => {
    new KafkaClient(['broker:9092']);
    const { options } = lastProducer();
    expect(options.bootstrapBrokers).toEqual(['broker:9092']);
    expect(options.clientId).toMatch(/^tsdmarc-/u);
    expect(options).not.toHaveProperty('tls');
    expect(options).not.toHaveProperty('sasl');
  });

  it('enables TLS with ssl true', () => {
    new KafkaClient(['broker:9093'], { ssl: true });
    const { options } = lastProducer();
    // Node's defaults verify the broker certificate (create_default_context).
    expect(options.tls).toEqual({});
    expect(options).not.toHaveProperty('sasl');
  });

  it('implies TLS and SASL PLAIN when a username is given', () => {
    new KafkaClient(['broker:9093'], { username: 'user', password: 'pass' });
    const { options } = lastProducer();
    expect(options.tls).toEqual({});
    expect(options.sasl).toEqual({
      mechanism: 'PLAIN',
      username: 'user',
      password: 'pass',
    });
  });

  it('implies TLS when only a password is given', () => {
    new KafkaClient(['broker:9093'], { password: 'pass' });
    const { options } = lastProducer();
    expect(options.tls).toEqual({});
    expect(options.sasl).toEqual({
      mechanism: 'PLAIN',
      username: '',
      password: 'pass',
    });
  });

  it('uses the provided TLS options', () => {
    // A caller-supplied context takes precedence: ops can pin a private CA.
    const sslContext = { ca: 'PEM', servername: 'kafka.internal' };
    new KafkaClient(['b:9093'], { ssl: true, sslContext });
    expect(lastProducer().options.tls).toBe(sslContext);
  });

  it('serializes values as UTF-8 JSON', () => {
    // A regression here would corrupt every event sent.
    new KafkaClient(['b']);
    const { serializers } = lastProducer().options as {
      serializers: { value: (value: unknown) => Buffer };
    };
    expect(serializers.value).toBe(serializeValue);
    const result = serializers.value({ hello: 'wörld', n: 1 });
    expect(JSON.parse(result.toString('utf8'))).toEqual({
      hello: 'wörld',
      n: 1,
    });
  });

  it('raises KafkaError when no broker is available', async () => {
    kafka.state.metadataError = new MultipleErrors(
      'Cannot connect to any broker.',
      [new NetworkError('Connection failed to unreachable:9092')],
    );
    await expect(KafkaClient.create(['unreachable:9092'])).rejects.toThrow(
      new KafkaError('No Kafka brokers available'),
    );
    expect(lastProducer().close).toHaveBeenCalledTimes(1);
  });

  it('create() resolves once a broker answers', async () => {
    const created = await KafkaClient.create(['b:9092']);
    expect(producerOf(created).metadata).toHaveBeenCalledWith({ topics: [] });
  });

  it('connect() lets other errors through unchanged', async () => {
    const kafkaClient = client();
    const error = new Error('SASL authentication failed');
    producerOf(kafkaClient).metadata.mockRejectedValueOnce(error);
    await expect(kafkaClient.connect()).rejects.toBe(error);
  });
});

describe('KafkaClient helpers', () => {
  it('stripMetadata lifts keys to the root and drops report_metadata', () => {
    const result = KafkaClient.stripMetadata(snakeAggregateReport());
    expect(result.org_name).toBe('TestOrg');
    expect(result.org_email).toBe('test@example.com');
    expect(result.report_id).toBe('r-123');
    expect(result).not.toHaveProperty('report_metadata');
  });

  it('generateDateRange uses the ISO format', () => {
    const logs = captureLogs();
    try {
      expect(KafkaClient.generateDateRange(snakeAggregateReport())).toEqual([
        '2024-01-01T00:00:00',
        '2024-01-02T00:00:00',
      ]);
      expect(logs.output).toContain(
        "DEBUG:tsdmarc:date_range is ['2024-01-01T00:00:00', '2024-01-02T00:00:00']",
      );
    } finally {
      logs.restore();
    }
  });
});

describe('saveAggregateReportsToKafka', () => {
  // One message per record (slice), with the metadata and policy copied onto
  // each slice for Kibana parity.
  it('sends one message per record', async () => {
    const kafkaClient = client();
    await kafkaClient.saveAggregateReportsToKafka(
      aggregateReport(),
      'dmarc-aggregate',
    );
    const producer = producerOf(kafkaClient);
    // One send (and broker acknowledgement) per slice, like send() + flush().
    expect(producer.send).toHaveBeenCalledTimes(2);
    for (const message of sentMessages(producer)) {
      expect(message.topic).toBe('dmarc-aggregate');
    }
  });

  it('copies the metadata onto each slice', async () => {
    const kafkaClient = client();
    await kafkaClient.saveAggregateReportsToKafka(aggregateReport(), 'topic');
    const values = sentMessages(producerOf(kafkaClient)).map(
      message => message.value,
    );
    expect(values).toEqual([
      {
        source: { ip_address: '192.0.2.1' },
        count: 1,
        date_range: ['2024-01-01T00:00:00', '2024-01-02T00:00:00'],
        org_name: 'TestOrg',
        org_email: 'test@example.com',
        policy_published: { domain: 'example.com', p: 'none' },
        report_id: 'r-123',
      },
      {
        source: { ip_address: '192.0.2.2' },
        count: 2,
        date_range: ['2024-01-01T00:00:00', '2024-01-02T00:00:00'],
        org_name: 'TestOrg',
        org_email: 'test@example.com',
        policy_published: { domain: 'example.com', p: 'none' },
        report_id: 'r-123',
      },
    ]);
  });

  it('does not modify the caller report', async () => {
    const report = aggregateReport();
    const before = structuredClone(report);
    await client().saveAggregateReportsToKafka(report, 'topic');
    expect(report).toEqual(before);
  });

  it('is a no-op for an empty list', async () => {
    const kafkaClient = client();
    await kafkaClient.saveAggregateReportsToKafka([], 'topic');
    expect(producerOf(kafkaClient).send).not.toHaveBeenCalled();
  });

  it('normalizes a single report to a list', async () => {
    const kafkaClient = client();
    await kafkaClient.saveAggregateReportsToKafka(aggregateReport(), 'topic');
    // One report with 2 records, not multiple reports.
    expect(producerOf(kafkaClient).send).toHaveBeenCalledTimes(2);
  });

  it('translates an unknown topic to KafkaError', async () => {
    const kafkaClient = client();
    producerOf(kafkaClient).send.mockRejectedValue(unknownTopicError());
    await expect(
      kafkaClient.saveAggregateReportsToKafka(aggregateReport(), 'missing'),
    ).rejects.toThrow(
      new KafkaError('Kafka error: Unknown topic or partition on broker'),
    );
  });

  it('translates a generic send error to KafkaError', async () => {
    const kafkaClient = client();
    producerOf(kafkaClient).send.mockRejectedValue(
      new Error('transport failure'),
    );
    await expect(
      kafkaClient.saveAggregateReportsToKafka(aggregateReport(), 'topic'),
    ).rejects.toThrow(new KafkaError('Kafka error: transport failure'));
  });

  it('sends real fixture reports record by record', async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../fixtures/aggregate/example.net!example.com!1529366400!1529452799.xml.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { result: { report: { records: Record<string, unknown>[] } } };
    const report = toCamelCaseKeys(fixture.result.report) as AggregateReport;
    const kafkaClient = client();
    await kafkaClient.saveAggregateReportsToKafka(report, 'topic');
    const [message] = sentMessages(producerOf(kafkaClient));
    const [record] = fixture.result.report.records;
    expect(message?.value).toEqual({
      ...record,
      date_range: ['2018-06-19T00:00:00', '2018-06-19T23:59:59'],
      org_name: 'example.net',
      org_email: 'postmaster@example.net',
      policy_published: (fixture.result.report as Record<string, unknown>)
        .policy_published,
      report_id: 'b043f0e264cf4ea995e93765242f6dfb',
    });
  });
});

describe('saveFailureReportsToKafka', () => {
  it('sends one message per report', async () => {
    // Failure reports carry message samples; one message per report keeps
    // each under Kafka's default 1MB limit.
    const kafkaClient = client();
    const reports = [
      { reportedDomain: 'f1' },
      { reportedDomain: 'f2' },
    ] as unknown as FailureReport[];
    await kafkaClient.saveFailureReportsToKafka(reports, 'dmarc-failure');
    const producer = producerOf(kafkaClient);
    expect(producer.send).toHaveBeenCalledTimes(2);
    expect(sentMessages(producer)).toEqual([
      { topic: 'dmarc-failure', value: { reported_domain: 'f1' } },
      { topic: 'dmarc-failure', value: { reported_domain: 'f2' } },
    ]);
  });

  it('sends a single report unwrapped', async () => {
    const kafkaClient = client();
    await kafkaClient.saveFailureReportsToKafka(
      { reportedDomain: 'single' } as unknown as FailureReport,
      'topic',
    );
    expect(sentMessages(producerOf(kafkaClient))).toEqual([
      { topic: 'topic', value: { reported_domain: 'single' } },
    ]);
  });

  it('is a no-op for an empty list', async () => {
    const kafkaClient = client();
    await kafkaClient.saveFailureReportsToKafka([], 'topic');
    expect(producerOf(kafkaClient).send).not.toHaveBeenCalled();
  });

  it('translates an unknown topic to KafkaError', async () => {
    const kafkaClient = client();
    producerOf(kafkaClient).send.mockRejectedValue(unknownTopicError());
    await expect(
      kafkaClient.saveFailureReportsToKafka([{} as FailureReport], 'missing'),
    ).rejects.toThrow(
      new KafkaError('Kafka error: Unknown topic or partition on broker'),
    );
  });

  it('translates a generic send error to KafkaError', async () => {
    const kafkaClient = client();
    producerOf(kafkaClient).send.mockRejectedValue(new Error('net'));
    await expect(
      kafkaClient.saveFailureReportsToKafka([{} as FailureReport], 'topic'),
    ).rejects.toThrow(new KafkaError('Kafka error: net'));
  });

  it('keeps the backward-compatible forensic alias', async () => {
    const kafkaClient = client();
    await kafkaClient.saveForensicReportsToKafka(
      { reportedDomain: 'x' } as unknown as FailureReport,
      'topic',
    );
    expect(sentMessages(producerOf(kafkaClient))).toEqual([
      { topic: 'topic', value: { reported_domain: 'x' } },
    ]);
  });
});

describe('saveSmtpTlsReportsToKafka', () => {
  it('sends one message per report', async () => {
    const kafkaClient = client();
    const reports = [
      { organizationName: 'x' },
      { organizationName: 'y' },
    ] as unknown as SMTPTLSReport[];
    await kafkaClient.saveSmtpTlsReportsToKafka(reports, 'smtp-tls');
    const producer = producerOf(kafkaClient);
    expect(producer.send).toHaveBeenCalledTimes(2);
    expect(sentMessages(producer)).toEqual([
      { topic: 'smtp-tls', value: { organization_name: 'x' } },
      { topic: 'smtp-tls', value: { organization_name: 'y' } },
    ]);
  });

  it('sends a single report unwrapped', async () => {
    const kafkaClient = client();
    await kafkaClient.saveSmtpTlsReportsToKafka(
      { organizationName: 'x' } as unknown as SMTPTLSReport,
      'topic',
    );
    expect(sentMessages(producerOf(kafkaClient))).toEqual([
      { topic: 'topic', value: { organization_name: 'x' } },
    ]);
  });

  it('is a no-op for an empty list', async () => {
    const kafkaClient = client();
    await kafkaClient.saveSmtpTlsReportsToKafka([], 'topic');
    expect(producerOf(kafkaClient).send).not.toHaveBeenCalled();
  });

  it('translates an unknown topic to KafkaError', async () => {
    const kafkaClient = client();
    producerOf(kafkaClient).send.mockRejectedValue(unknownTopicError());
    await expect(
      kafkaClient.saveSmtpTlsReportsToKafka([{} as SMTPTLSReport], 'missing'),
    ).rejects.toThrow(
      new KafkaError('Kafka error: Unknown topic or partition on broker'),
    );
  });

  it('translates a generic send error to KafkaError', async () => {
    const kafkaClient = client();
    producerOf(kafkaClient).send.mockRejectedValue(new Error('oops'));
    await expect(
      kafkaClient.saveSmtpTlsReportsToKafka([{} as SMTPTLSReport], 'topic'),
    ).rejects.toThrow(new KafkaError('Kafka error: oops'));
  });
});

describe('KafkaClient close', () => {
  it('closes the underlying producer', async () => {
    const kafkaClient = client();
    await kafkaClient.close();
    expect(producerOf(kafkaClient).close).toHaveBeenCalledTimes(1);
  });
});

describe('integers beyond 2^53', () => {
  it('serializes like json.dumps(v), with exact integers', () => {
    expect(
      serializeValue({
        hello: 'wörld',
        n: 99_999_999_999_999_999_999n,
      }).toString('utf8'),
    ).toBe('{"hello": "w\\u00f6rld", "n": 99999999999999999999}');
  });

  it('sends a record count beyond 2^53 exactly', async () => {
    const report = aggregateReport();
    const [record] = report.records;
    if (!record) {
      throw new Error('fixture has no record');
    }
    record.count = 99_999_999_999_999_999_999n;
    const kafkaClient = client();
    await kafkaClient.saveAggregateReportsToKafka(report, 'topic');
    const [message] = sentMessages(producerOf(kafkaClient));
    expect(serializeValue(message?.value).toString('utf8')).toContain(
      '"count": 99999999999999999999',
    );
  });
});
