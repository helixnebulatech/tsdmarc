// Port of parsedmarc/kafkaclient.py, on @platformatic/kafka.

import type { ConnectionOptions as TLSConnectionOptions } from 'node:tls';

import { Producer } from '@platformatic/kafka';
import {
  type AggregateReport,
  type FailureReport,
  humanTimestampToDatetime,
  logger,
  pyJsonDumps,
  type SMTPTLSReport,
  toSnakeCaseKeys,
  VERSION,
} from 'tsdmarc';

const UNKNOWN_TOPIC_OR_PARTITION = 'UNKNOWN_TOPIC_OR_PARTITION';
// @platformatic/kafka error codes for "could not reach any broker".
const BOOTSTRAP_ERROR_CODES: ReadonlySet<string> = new Set([
  'PLT_KFK_NETWORK',
  'PLT_KFK_TIMEOUT',
]);

/** Raised when a Kafka error occurs. */
export class KafkaError extends Error {
  override name = 'KafkaError';
}

export interface KafkaClientOptions {
  /** Use a SSL/TLS connection (implied by `username` or `password`). */
  ssl?: boolean;
  /** An optional SASL PLAIN username. */
  username?: string | null;
  /** An optional SASL PLAIN password. */
  password?: string | null;
  /**
   * TLS options (CA, client certificate, ...), parsedmarc's `ssl_context`.
   * Defaults to Node's defaults, which verify the broker certificate.
   */
  sslContext?: TLSConnectionOptions | null;
}

/** A JSON object with snake_case keys, as parsedmarc builds them. */
export type KafkaMessage = Record<string, unknown>;

/** A snake_case aggregate report, as {@link KafkaClient.stripMetadata} takes it. */
export interface SnakeCaseAggregateReport {
  report_metadata: Record<string, unknown> & {
    org_name?: unknown;
    org_email?: unknown;
    report_id?: unknown;
    begin_date: string;
    end_date: string;
  };
  [key: string]: unknown;
}

/**
 * The value serializer: `json.dumps(v).encode("utf-8")`, so integers
 * beyond 2^53 (`bigint`s) are written exactly, like Python's.
 */
export function serializeValue(value: unknown): Buffer {
  return Buffer.from(pyJsonDumps(value), 'utf8');
}

function errorChain(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (error === null || typeof error !== 'object' || seen.has(error)) {
    return [];
  }
  seen.add(error);
  const found: unknown[] = [error];
  const { errors, cause } = error as { errors?: unknown; cause?: unknown };
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      found.push(...errorChain(inner, seen));
    }
  }
  found.push(...errorChain(cause, seen));
  return found;
}

function hasErrorProperty(
  error: unknown,
  property: 'apiId' | 'code',
  values: ReadonlySet<string>,
): boolean {
  return errorChain(error).some(inner => {
    const value = (inner as Record<string, unknown>)[property];
    return typeof value === 'string' && values.has(value);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class KafkaClient {
  readonly producer: Producer<Buffer, unknown, Buffer, Buffer>;

  /**
   * Initializes the Kafka client. The producer connects lazily; call
   * {@link connect} (or use {@link KafkaClient.create}) to check the
   * brokers up front, as parsedmarc's constructor does.
   *
   * `ssl: true` is implied when a username or password is supplied. When
   * using Azure Event Hubs, the username is literally `$ConnectionString`,
   * and the password is the Azure Event Hub connection string.
   *
   * @param kafkaHosts - Kafka hostnames, with optional port numbers
   */
  constructor(kafkaHosts: string[], options: KafkaClientOptions = {}) {
    const { ssl = false, username, password, sslContext } = options;
    const config: ConstructorParameters<
      typeof Producer<Buffer, unknown, Buffer, Buffer>
    >[0] = {
      bootstrapBrokers: kafkaHosts,
      clientId: `tsdmarc-${VERSION}`,
      serializers: { value: serializeValue },
      // kafka-python's producer lets the broker auto-create topics.
      autocreateTopics: true,
    };
    if (ssl || username || password) {
      config.tls = sslContext ?? {};
      if (username || password) {
        config.sasl = {
          mechanism: 'PLAIN',
          username: username ?? '',
          password: password ?? '',
        };
      }
    }
    this.producer = new Producer(config);
  }

  /** Create a client and check that a broker is reachable. */
  static async create(
    kafkaHosts: string[],
    options: KafkaClientOptions = {},
  ): Promise<KafkaClient> {
    const client = new KafkaClient(kafkaHosts, options);
    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  }

  /**
   * Connect to the bootstrap brokers.
   *
   * @throws {KafkaError} "No Kafka brokers available" when none responds.
   */
  async connect(): Promise<void> {
    try {
      await this.producer.metadata({ topics: [] });
    } catch (error) {
      if (hasErrorProperty(error, 'code', BOOTSTRAP_ERROR_CODES)) {
        throw new KafkaError('No Kafka brokers available', { cause: error });
      }
      throw error;
    }
  }

  /** Close the Kafka producer, releasing its sockets. */
  async close(): Promise<void> {
    await this.producer.close();
  }

  /**
   * Duplicates org_name, org_email and report_id into the JSON root and
   * removes the report_metadata key to bring it more in line with the
   * Elastic output. Mutates and returns `report`, like parsedmarc.
   */
  static stripMetadata(report: SnakeCaseAggregateReport): KafkaMessage {
    const message: KafkaMessage = report;
    const metadata = report.report_metadata;
    message.org_name = metadata.org_name;
    message.org_email = metadata.org_email;
    message.report_id = metadata.report_id;
    delete message.report_metadata;
    return message;
  }

  /**
   * Creates a date_range with format YYYY-MM-DDTHH:MM:SS from the begin and
   * end dates, for easier parsing in Kibana.
   */
  static generateDateRange(report: SnakeCaseAggregateReport): string[] {
    const metadata = report.report_metadata;
    const beginDate = humanTimestampToDatetime(metadata.begin_date);
    const endDate = humanTimestampToDatetime(metadata.end_date);
    const dateRange = [
      beginDate.strftime('%Y-%m-%dT%H:%M:%S'),
      endDate.strftime('%Y-%m-%dT%H:%M:%S'),
    ];
    logger.debug(`date_range is ${pyList(dateRange)}`);
    return dateRange;
  }

  /** Send one message and wait for the broker, like send() + flush(). */
  async #send(topic: string, value: KafkaMessage): Promise<void> {
    try {
      await this.producer.send({ messages: [{ topic, value }] });
    } catch (error) {
      if (
        hasErrorProperty(error, 'apiId', new Set([UNKNOWN_TOPIC_OR_PARTITION]))
      ) {
        throw new KafkaError(
          'Kafka error: Unknown topic or partition on broker',
          { cause: error },
        );
      }
      throw new KafkaError(`Kafka error: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Saves aggregate DMARC reports to Kafka: one message per record, with
   * the report metadata and published policy copied onto each record.
   */
  async saveAggregateReportsToKafka(
    aggregateReports: AggregateReport | AggregateReport[],
    aggregateTopic: string,
  ): Promise<void> {
    const reports = Array.isArray(aggregateReports)
      ? aggregateReports
      : [aggregateReports];
    if (reports.length < 1) {
      return;
    }

    for (const camelReport of reports) {
      const snakeReport = toSnakeCaseKeys(
        camelReport,
      ) as SnakeCaseAggregateReport;
      snakeReport.date_range = KafkaClient.generateDateRange(snakeReport);
      const report = KafkaClient.stripMetadata(snakeReport);

      for (const slice of report.records as KafkaMessage[]) {
        slice.date_range = report.date_range;
        slice.org_name = report.org_name;
        slice.org_email = report.org_email;
        slice.policy_published = report.policy_published;
        slice.report_id = report.report_id;
        logger.debug('Sending slice.');
        logger.debug('Saving aggregate report to Kafka');
        await this.#send(aggregateTopic, slice);
      }
    }
  }

  /**
   * Saves failure DMARC reports to Kafka, one message per report, so a
   * large batch is far less likely to exceed Kafka's default 1MB message
   * limit (failure reports carry message samples).
   */
  async saveFailureReportsToKafka(
    failureReports: FailureReport | FailureReport[],
    failureTopic: string,
  ): Promise<void> {
    const reports = Array.isArray(failureReports)
      ? failureReports
      : [failureReports];
    if (reports.length < 1) {
      return;
    }

    for (const report of reports) {
      logger.debug('Saving failure report to Kafka');
      await this.#send(failureTopic, toSnakeCaseKeys(report) as KafkaMessage);
    }
  }

  /** Backward-compatible alias of {@link saveFailureReportsToKafka}. */
  async saveForensicReportsToKafka(
    failureReports: FailureReport | FailureReport[],
    failureTopic: string,
  ): Promise<void> {
    await this.saveFailureReportsToKafka(failureReports, failureTopic);
  }

  /** Saves SMTP TLS reports to Kafka, one message per report. */
  async saveSmtpTlsReportsToKafka(
    smtpTlsReports: SMTPTLSReport | SMTPTLSReport[],
    smtpTlsTopic: string,
  ): Promise<void> {
    const reports = Array.isArray(smtpTlsReports)
      ? smtpTlsReports
      : [smtpTlsReports];
    if (reports.length < 1) {
      return;
    }

    for (const report of reports) {
      logger.debug('Saving SMTP TLS report to Kafka');
      await this.#send(smtpTlsTopic, toSnakeCaseKeys(report) as KafkaMessage);
    }
  }
}

/** Python's `str()` of a list of strings (`['a', 'b']`). */
function pyList(values: string[]): string {
  return `[${values.map(value => `'${value}'`).join(', ')}]`;
}
