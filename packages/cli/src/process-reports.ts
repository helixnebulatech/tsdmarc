// Writing parsed reports to every configured output destination
// (`process_reports` and its helpers in parsedmarc's `_main`).

import * as elastic from '@tsdmarc/elasticsearch';
import type { KafkaClient } from '@tsdmarc/kafka';
import {
  LogAnalyticsClient,
  LogAnalyticsException,
} from '@tsdmarc/loganalytics';
import * as opensearch from '@tsdmarc/opensearch';
import {
  AlreadySaved as PostgresAlreadySaved,
  type PostgreSQLClient,
  PostgreSQLError,
} from '@tsdmarc/postgres';
import type { S3Client } from '@tsdmarc/s3';
import {
  type AggregateReport,
  type FailureReport,
  type GelfClient,
  getBaseDomain,
  type HECClient,
  type LokiClient,
  InvalidDMARCReport,
  logger,
  ParserError,
  type ParsingResults,
  sanitizeForLog,
  saveOutput,
  type SMTPTLSReport,
  SplunkError,
  type SyslogClient,
  toSnakeCaseKeys,
  type WebhookClient,
} from 'tsdmarc';

import type { IndexPrefixDomainMap } from './config';
import { pyJsonDumps } from './json';
import type { CliOptions } from './options';
import { normalizeIndexPrefix, type OutputClients } from './outputs';

/** What `processReports()` reads: replaced as a whole by a SIGHUP reload. */
export interface RunState {
  opts: CliOptions;
  clients: OutputClients;
  indexPrefixDomainMap: IndexPrefixDomainMap | null;
}

type AnyReport = AggregateReport | FailureReport | SMTPTLSReport;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The index name prefix for a report from `index_prefix_domain_map`, or
 * `null` when there is no map or the report's base domain is not in it.
 */
export function getIndexPrefix(
  report: AnyReport | Record<string, unknown>,
  indexPrefixDomainMap: IndexPrefixDomainMap | null,
): string | null {
  if (indexPrefixDomainMap === null) {
    return null;
  }
  const record = report as Record<string, unknown>;
  let domain: unknown = null;
  if ('policyPublished' in record) {
    domain = (record.policyPublished as { domain?: unknown }).domain;
  } else if ('reportedDomain' in record) {
    domain = record.reportedDomain;
  } else {
    // An SMTP TLS report may have an empty policies list: nothing to map.
    const policies = record.policies as
      | { policyDomain?: unknown }[]
      | undefined;
    if (Array.isArray(policies) && policies.length > 0) {
      domain = policies[0]?.policyDomain;
    }
  }
  if (typeof domain === 'string' && domain) {
    const baseDomain = getBaseDomain(domain);
    if (baseDomain) {
      const lower = baseDomain.toLowerCase();
      for (const [key, domains] of indexPrefixDomainMap) {
        if (domains.includes(lower)) {
          return normalizeIndexPrefix(key);
        }
      }
    }
  }
  return null;
}

/**
 * Drop SMTP TLS reports whose domain isn't covered by
 * `index_prefix_domain_map` (all of them pass without a map). Used for each
 * saved batch and for the combined results that feed the summary email.
 */
export function filterSmtpTlsReportsForIndexPrefix(
  tlsReports: SMTPTLSReport[],
  indexPrefixDomainMap: IndexPrefixDomainMap | null,
): SMTPTLSReport[] {
  if (indexPrefixDomainMap === null) {
    return tlsReports;
  }
  const filtered: SMTPTLSReport[] = [];
  for (const report of tlsReports) {
    if (getIndexPrefix(report, indexPrefixDomainMap) === null) {
      let domain = 'unknown';
      const policies = (report as { policies?: { policyDomain?: string }[] })
        .policies;
      if (policies && policies.length > 0) {
        domain = policies[0]?.policyDomain ?? 'unknown';
      }
      logger.debug(
        `Ignoring SMTP TLS report for domain not in index_prefix_domain_map: ${sanitizeForLog(String(domain))}`,
      );
    } else {
      filtered.push(report);
    }
  }
  return filtered;
}

function isFileOutputError(error: unknown): boolean {
  // Python catches OSError and ValueError around save_output(), and its
  // UnicodeDecodeError is a ValueError.
  return (
    error instanceof Error &&
    ('code' in error ||
      error.name === 'ValueError' ||
      error.name === 'UnicodeDecodeError')
  );
}

/** An error from the system (a full disk), not from what is being written. */
function isSystemError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

function jsonText(value: unknown, opts: CliOptions): string {
  return pyJsonDumps(toSnakeCaseKeys(value), opts.prettifyJson ? 2 : null);
}

/** Write `text` to stdout (parsedmarc's `print`). */
export const stdout: { write: (text: string) => void } = {
  write(text: string): void {
    process.stdout.write(text);
  },
};

interface SaveContext {
  state: RunState;
  logOutputError: (destination: string, error: string) => void;
}

interface SearchSaveOptions {
  indexSuffix: string | null;
  indexPrefix: string | null;
  monthlyIndexes: boolean;
  useDataStreams: boolean;
  numberOfShards?: number;
  numberOfReplicas?: number;
  maxIndexesPerReport?: number;
}

function elasticOptions(
  opts: CliOptions,
  prefix: string | null,
): SearchSaveOptions {
  return {
    indexSuffix: opts.elasticsearchIndexSuffix,
    indexPrefix: opts.elasticsearchIndexPrefix || prefix,
    monthlyIndexes: opts.elasticsearchMonthlyIndexes,
    useDataStreams: opts.elasticsearchUseDataStreams,
    ...(opts.elasticsearchNumberOfShards === null
      ? {}
      : { numberOfShards: opts.elasticsearchNumberOfShards }),
    ...(opts.elasticsearchNumberOfReplicas === null
      ? {}
      : { numberOfReplicas: opts.elasticsearchNumberOfReplicas }),
    ...(opts.elasticsearchMaxIndexesPerReport === null
      ? {}
      : { maxIndexesPerReport: opts.elasticsearchMaxIndexesPerReport }),
  };
}

function opensearchOptions(
  opts: CliOptions,
  prefix: string | null,
): SearchSaveOptions {
  return {
    indexSuffix: opts.opensearchIndexSuffix,
    indexPrefix: opts.opensearchIndexPrefix || prefix,
    monthlyIndexes: opts.opensearchMonthlyIndexes,
    useDataStreams: opts.opensearchUseDataStreams,
    ...(opts.opensearchNumberOfShards === null
      ? {}
      : { numberOfShards: opts.opensearchNumberOfShards }),
    ...(opts.opensearchNumberOfReplicas === null
      ? {}
      : { numberOfReplicas: opts.opensearchNumberOfReplicas }),
    ...(opts.opensearchMaxIndexesPerReport === null
      ? {}
      : { maxIndexesPerReport: opts.opensearchMaxIndexesPerReport }),
  };
}

type ReportKind = 'aggregate' | 'failure' | 'smtp_tls';

async function saveToElasticsearch(
  context: SaveContext,
  kind: ReportKind,
  report: AnyReport,
): Promise<void> {
  const { opts, indexPrefixDomainMap } = context.state;
  try {
    if (opts.elasticsearchHosts) {
      const options = elasticOptions(
        opts,
        opts.elasticsearchIndexPrefix
          ? null
          : getIndexPrefix(report, indexPrefixDomainMap),
      );
      if (kind === 'aggregate') {
        await elastic.saveAggregateReportToElasticsearch(
          report as AggregateReport,
          options,
        );
      } else if (kind === 'failure') {
        await elastic.saveFailureReportToElasticsearch(
          report as FailureReport,
          options,
        );
      } else {
        await elastic.saveSmtpTlsReportToElasticsearch(
          report as SMTPTLSReport,
          options,
        );
      }
    }
  } catch (error) {
    if (error instanceof elastic.AlreadySaved) {
      logger.warning(sanitizeForLog(error.message));
    } else if (error instanceof elastic.ElasticsearchError) {
      context.logOutputError('Elasticsearch', error.message);
    } else if (kind !== 'aggregate' && error instanceof InvalidDMARCReport) {
      context.logOutputError('Invalid DMARC report', error.message);
    } else {
      // Whatever a report triggers is recorded: rethrown, it would end the
      // run before the retry count of the mailbox moves the message aside.
      context.logOutputError('Elasticsearch exception', errorMessage(error));
    }
  }
}

async function saveToOpenSearch(
  context: SaveContext,
  kind: ReportKind,
  report: AnyReport,
): Promise<void> {
  const { opts, indexPrefixDomainMap } = context.state;
  try {
    if (opts.opensearchHosts) {
      const options = opensearchOptions(
        opts,
        opts.opensearchIndexPrefix
          ? null
          : getIndexPrefix(report, indexPrefixDomainMap),
      );
      if (kind === 'aggregate') {
        await opensearch.saveAggregateReportToOpenSearch(
          report as AggregateReport,
          options,
        );
      } else if (kind === 'failure') {
        await opensearch.saveFailureReportToOpenSearch(
          report as FailureReport,
          options,
        );
      } else {
        await opensearch.saveSmtpTlsReportToOpenSearch(
          report as SMTPTLSReport,
          options,
        );
      }
    }
  } catch (error) {
    if (error instanceof opensearch.AlreadySaved) {
      logger.warning(sanitizeForLog(error.message));
    } else if (error instanceof opensearch.OpenSearchError) {
      context.logOutputError('OpenSearch', error.message);
    } else if (kind !== 'aggregate' && error instanceof InvalidDMARCReport) {
      context.logOutputError('Invalid DMARC report', error.message);
    } else {
      context.logOutputError('OpenSearch exception', errorMessage(error));
    }
  }
}

async function attempt(
  context: SaveContext,
  destination: string,
  action: () => Promise<void> | void,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    context.logOutputError(destination, errorMessage(error));
  }
}

async function saveToPostgres(
  context: SaveContext,
  pgClient: PostgreSQLClient | undefined,
  save: (client: PostgreSQLClient) => Promise<void>,
): Promise<void> {
  try {
    if (pgClient) {
      await save(pgClient);
    }
  } catch (error) {
    if (error instanceof PostgresAlreadySaved) {
      logger.warning(sanitizeForLog(error.message));
    } else if (error instanceof PostgreSQLError) {
      context.logOutputError('PostgreSQL', error.message);
    } else {
      context.logOutputError('PostgreSQL exception', errorMessage(error));
    }
  }
}

async function saveToSplunk(
  context: SaveContext,
  reports: AnyReport[],
  save: (reports: never[]) => Promise<void>,
): Promise<void> {
  try {
    if (reports.length > 0) {
      await save(reports as never[]);
    }
  } catch (error) {
    if (error instanceof SplunkError) {
      context.logOutputError('Splunk HEC', error.message);
    } else {
      context.logOutputError('Splunk HEC exception', errorMessage(error));
    }
  }
}

function logFileOutputError(context: SaveContext, error: unknown): void {
  context.logOutputError(
    isFileOutputError(error) ? 'File output' : 'File output exception',
    errorMessage(error),
  );
}

async function saveToFiles(
  context: SaveContext,
  reports: ParsingResults,
): Promise<void> {
  const { opts } = context.state;
  const save = async (results: ParsingResults): Promise<void> => {
    await saveOutput(results, {
      outputDirectory: opts.output ?? undefined,
      aggregateJsonFilename: opts.aggregateJsonFilename,
      failureJsonFilename: opts.failureJsonFilename,
      smtpTlsJsonFilename: opts.smtpTlsJsonFilename,
      aggregateCsvFilename: opts.aggregateCsvFilename,
      failureCsvFilename: opts.failureCsvFilename,
      smtpTlsCsvFilename: opts.smtpTlsCsvFilename,
      csvFormulaEscape: opts.csvFormulaEscape,
    });
  };
  try {
    await save(reports);
    return;
  } catch (error) {
    // A full disk or an unwritable directory is recorded like any other
    // destination's failure, so a mailbox batch is not archived.
    logFileOutputError(context, error);
    if (isSystemError(error)) {
      return;
    }
  }
  // What failed can be one report: the others still get written, one at a
  // time. Files written before the failure get those entries again, like
  // any destination on the retry of a batch held back.
  const empty = {
    aggregateReports: [],
    failureReports: [],
    smtpTlsReports: [],
  };
  const single: ParsingResults[] = [
    ...reports.aggregateReports.map(report => ({
      ...empty,
      aggregateReports: [report],
    })),
    ...reports.failureReports.map(report => ({
      ...empty,
      failureReports: [report],
    })),
    ...reports.smtpTlsReports.map(report => ({
      ...empty,
      smtpTlsReports: [report],
    })),
  ];
  if (single.length < 2) {
    return;
  }
  for (const results of single) {
    try {
      await save(results);
    } catch (error) {
      logFileOutputError(context, error);
    }
  }
}

/**
 * Write `reports` to every configured output destination.
 *
 * @returns The output-error messages recorded along the way, empty when
 * every destination accepted the reports (the "was this batch saved?"
 * signal of the mailbox save callback).
 * @throws {ParserError} With `fail_on_output_error`, instead of returning a
 * non-empty list.
 */
export async function processReports(
  state: RunState,
  reports: ParsingResults,
): Promise<string[]> {
  const { opts, clients, indexPrefixDomainMap } = state;
  const outputErrors: string[] = [];
  const context: SaveContext = {
    state,
    logOutputError(destination: string, error: string): void {
      // Sanitized here for every later use: fail_on_output_error turns
      // these into a ParserError, and an error can echo a report's values.
      const message = sanitizeForLog(`${destination} Error: ${error}`);
      logger.error(message);
      outputErrors.push(message);
    },
  };

  if (indexPrefixDomainMap !== null) {
    reports.smtpTlsReports = filterSmtpTlsReportsForIndexPrefix(
      reports.smtpTlsReports ?? [],
      indexPrefixDomainMap,
    );
  }

  if (!opts.silent) {
    // A small report can expand past the longest string the runtime allows.
    await attempt(context, 'JSON output', () => {
      stdout.write(`${jsonText(reports, opts)}\n\n`);
    });
  }
  if (opts.output) {
    await saveToFiles(context, reports);
  }

  const kafkaClient = clients.get('kafka_client') as KafkaClient | undefined;
  const s3Client = clients.get('s3_client') as S3Client | undefined;
  const syslogClient = clients.get('syslog_client') as SyslogClient | undefined;
  const hecClient = clients.get('hec_client') as HECClient | undefined;
  const gelfClient = clients.get('gelf_client') as GelfClient | undefined;
  const webhookClient = clients.get('webhook_client') as
    | WebhookClient
    | undefined;
  const lokiClient = clients.get('loki_client') as LokiClient | undefined;
  const pgClient = clients.get('postgresql_client') as
    | PostgreSQLClient
    | undefined;

  if (opts.saveAggregate) {
    for (const report of reports.aggregateReports) {
      await saveToElasticsearch(context, 'aggregate', report);
      await saveToOpenSearch(context, 'aggregate', report);
      await attempt(context, 'Kafka', async () => {
        if (kafkaClient) {
          await kafkaClient.saveAggregateReportsToKafka(
            report,
            opts.kafkaAggregateTopic ?? '',
          );
        }
      });
      await attempt(context, 'S3', async () => {
        if (s3Client) {
          await s3Client.saveAggregateReportToS3(report);
        }
      });
      await saveToPostgres(context, pgClient, async client => {
        await client.saveAggregateReportToPostgresql(report);
      });
      await attempt(context, 'Syslog', async () => {
        if (syslogClient) {
          await syslogClient.saveAggregateReportToSyslog(report);
        }
      });
      await attempt(context, 'GELF', async () => {
        if (gelfClient) {
          await gelfClient.saveAggregateReportToGelf(report);
        }
      });
      await attempt(context, 'Webhook', async () => {
        if (opts.webhookAggregateUrl && webhookClient) {
          await webhookClient.saveAggregateReportToWebhook(
            jsonText(report, opts),
          );
        }
      });
      await attempt(context, 'Loki', async () => {
        if (lokiClient) {
          await lokiClient.saveAggregateReportToLoki(report);
        }
      });
    }
    if (hecClient) {
      await saveToSplunk(context, reports.aggregateReports, async batch => {
        await hecClient.saveAggregateReportsToSplunk(batch);
      });
    }
  }

  if (opts.saveFailure) {
    for (const report of reports.failureReports) {
      await saveToElasticsearch(context, 'failure', report);
      await saveToOpenSearch(context, 'failure', report);
      await attempt(context, 'Kafka', async () => {
        if (kafkaClient) {
          await kafkaClient.saveFailureReportsToKafka(
            report,
            opts.kafkaFailureTopic ?? '',
          );
        }
      });
      await attempt(context, 'S3', async () => {
        if (s3Client) {
          await s3Client.saveFailureReportToS3(report);
        }
      });
      await saveToPostgres(context, pgClient, async client => {
        await client.saveFailureReportToPostgresql(report);
      });
      await attempt(context, 'Syslog', async () => {
        if (syslogClient) {
          await syslogClient.saveFailureReportToSyslog(report);
        }
      });
      await attempt(context, 'GELF', async () => {
        if (gelfClient) {
          await gelfClient.saveFailureReportToGelf(report);
        }
      });
      await attempt(context, 'Webhook', async () => {
        if (opts.webhookFailureUrl && webhookClient) {
          await webhookClient.saveFailureReportToWebhook(
            jsonText(report, opts),
          );
        }
      });
      await attempt(context, 'Loki', async () => {
        if (lokiClient) {
          await lokiClient.saveFailureReportToLoki(report);
        }
      });
    }
    if (hecClient) {
      await saveToSplunk(context, reports.failureReports, async batch => {
        await hecClient.saveFailureReportsToSplunk(batch);
      });
    }
  }

  if (opts.saveSmtpTls) {
    for (const report of reports.smtpTlsReports) {
      await saveToElasticsearch(context, 'smtp_tls', report);
      await saveToOpenSearch(context, 'smtp_tls', report);
      await attempt(context, 'Kafka', async () => {
        if (kafkaClient) {
          await kafkaClient.saveSmtpTlsReportsToKafka(
            [report],
            opts.kafkaSmtpTlsTopic ?? '',
          );
        }
      });
      await attempt(context, 'S3', async () => {
        if (s3Client) {
          await s3Client.saveSmtpTlsReportToS3(report);
        }
      });
      await saveToPostgres(context, pgClient, async client => {
        await client.saveSmtpTlsReportToPostgresql(report);
      });
      await attempt(context, 'Syslog', async () => {
        if (syslogClient) {
          await syslogClient.saveSmtpTlsReportToSyslog(report);
        }
      });
      await attempt(context, 'GELF', async () => {
        if (gelfClient) {
          await gelfClient.saveSmtpTlsReportToGelf(report);
        }
      });
      await attempt(context, 'Webhook', async () => {
        if (opts.webhookSmtpTlsUrl && webhookClient) {
          await webhookClient.saveSmtpTlsReportToWebhook(
            jsonText(report, opts),
          );
        }
      });
      await attempt(context, 'Loki', async () => {
        if (lokiClient) {
          await lokiClient.saveSmtpTlsReportToLoki(report);
        }
      });
    }
    if (hecClient) {
      await saveToSplunk(context, reports.smtpTlsReports, async batch => {
        await hecClient.saveSmtpTlsReportsToSplunk(batch);
      });
    }
  }

  if (opts.laDce) {
    try {
      const laClient = new LogAnalyticsClient({
        clientId: opts.laClientId ?? '',
        clientSecret: opts.laClientSecret ?? '',
        tenantId: opts.laTenantId ?? '',
        dce: opts.laDce,
        dcrImmutableId: opts.laDcrImmutableId ?? '',
        dcrAggregateStream: opts.laDcrAggregateStream ?? '',
        dcrFailureStream: opts.laDcrFailureStream ?? '',
        dcrSmtpTlsStream: opts.laDcrSmtpTlsStream ?? '',
      });
      await laClient.publishResults(
        reports,
        opts.saveAggregate,
        opts.saveFailure,
        opts.saveSmtpTls,
      );
    } catch (error) {
      if (error instanceof LogAnalyticsException) {
        context.logOutputError('Log Analytics', error.message);
      } else {
        context.logOutputError(
          'Log Analytics',
          `Unknown publishing error: ${errorMessage(error)}`,
        );
      }
    }
  }

  if (opts.failOnOutputError && outputErrors.length > 0) {
    throw new ParserError(
      `Output destination failures detected: ${outputErrors.join(' | ')}`,
    );
  }

  return outputErrors;
}
