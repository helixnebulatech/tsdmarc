// Port of parsedmarc/loganalytics.py: push reports to Azure Log Analytics
// via Data Collection Rules (DCR).

import { Buffer } from 'node:buffer';

import { ClientSecretCredential } from '@azure/identity';
import {
  isAggregateLogsUploadError,
  LogsIngestionClient,
} from '@azure/monitor-ingestion';
import {
  type AggregateReport,
  type FailureReport,
  logger,
  pyStr,
  rawJsonIntegers,
  sanitizeForLog,
  type SMTPTLSReport,
  toSnakeCaseKeys,
} from 'tsdmarc';

/** Raised when a Log Analytics error occurs. */
export class LogAnalyticsException extends Error {
  override name = 'LogAnalyticsException';
}

/** The settings of a {@link LogAnalyticsClient}. */
export interface LogAnalyticsSettings {
  /** The client ID of the service principal. */
  clientId: string;
  /** The client secret of the service principal. */
  clientSecret: string;
  /** The tenant ID where the service principal resides. */
  tenantId: string;
  /** The Data Collection Endpoint (DCE) used by the DCR. */
  dce: string;
  /** The immutable ID of the Data Collection Rule (DCR). */
  dcrImmutableId: string;
  /** The stream for aggregate DMARC reports. */
  dcrAggregateStream: string;
  /** The stream for failure DMARC reports. */
  dcrFailureStream: string;
  /** The stream for SMTP TLS reports. */
  dcrSmtpTlsStream: string;
}

/** The configuration of the Log Analytics client. */
export class LogAnalyticsConfig implements LogAnalyticsSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tenantId: string;
  readonly dce: string;
  readonly dcrImmutableId: string;
  readonly dcrAggregateStream: string;
  readonly dcrFailureStream: string;
  readonly dcrSmtpTlsStream: string;

  constructor(settings: LogAnalyticsSettings) {
    this.clientId = settings.clientId;
    this.clientSecret = settings.clientSecret;
    this.tenantId = settings.tenantId;
    this.dce = settings.dce;
    this.dcrImmutableId = settings.dcrImmutableId;
    this.dcrAggregateStream = settings.dcrAggregateStream;
    this.dcrFailureStream = settings.dcrFailureStream;
    this.dcrSmtpTlsStream = settings.dcrSmtpTlsStream;
  }
}

/** The reports to publish (parsedmarc's parsing results). */
export interface LogAnalyticsResults {
  aggregateReports: AggregateReport[];
  failureReports: FailureReport[];
  smtpTlsReports: SMTPTLSReport[];
}

/** The part of `LogsIngestionClient` {@link LogAnalyticsClient.publishJson} uses. */
export interface LogsUploader {
  upload: (
    ruleId: string,
    streamName: string,
    logs: Record<string, unknown>[],
  ) => Promise<void>;
}

/**
 * azure-core's default timeout (Python `ConnectionConfiguration`: 300 s to
 * connect, 300 s to read). The JS pipeline has no default, so a stalled
 * endpoint would hang the upload forever.
 */
const REQUEST_TIMEOUT_MS = 300_000;

type IngestionClientOptions = NonNullable<
  ConstructorParameters<typeof LogsIngestionClient>[2]
>;
type AdditionalPolicy = NonNullable<
  IngestionClientOptions['additionalPolicies']
>[number];

/**
 * A pipeline policy that gives every HTTP attempt (each chunk, each retry,
 * each token request) azure-core's default timeout, like Python's per-request
 * transport timeouts. `LogsIngestionClient.upload()` doesn't forward
 * per-request options, so this is the way to set it.
 */
const requestTimeoutPolicy: AdditionalPolicy = {
  position: 'perRetry',
  policy: {
    name: 'tsdmarcRequestTimeout',
    sendRequest: (request, next) => {
      if (!request.timeout) {
        request.timeout = REQUEST_TIMEOUT_MS;
      }
      return next(request);
    },
  },
};

/**
 * The Logs Ingestion API's limit on one request. The SDK packs reports into
 * chunks of this size, but sends a larger report alone and it is rejected.
 */
const MAX_REPORT_BYTES = 1_000_000;

/** The report's ID, for the warning about a report that was left out. */
function reportLabel(report: Record<string, unknown>): string {
  const metadata = report.report_metadata as
    | Record<string, unknown>
    | null
    | undefined;
  const id = metadata?.report_id ?? report.report_id ?? report.arrival_date_utc;
  return sanitizeForLog(pyStr(id));
}

/**
 * Deviation: leaves out the reports the service would reject, with a warning
 * (parsedmarc fails, so one sender's report keeps the batch unsaved).
 */
function reportsWithinLimit(
  reports: Record<string, unknown>[],
): Record<string, unknown>[] {
  return reports.filter(report => {
    const size = Buffer.byteLength(JSON.stringify(report));
    if (size <= MAX_REPORT_BYTES) {
      return true;
    }
    logger.warning(
      `Report ${reportLabel(report)} not sent to Log Analytics: ${size} bytes exceeds the ${MAX_REPORT_BYTES}-byte limit`,
    );
    return false;
  });
}

function causeMessage(error: unknown): string {
  // The SDK collects every failed batch; Python raises the first error.
  if (isAggregateLogsUploadError(error)) {
    const [first] = error.errors;
    if (first) {
      return first.cause.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function isUploadError(error: unknown): boolean {
  return (
    isAggregateLogsUploadError(error) ||
    (error instanceof Error && error.name === 'RestError')
  );
}

/**
 * Pushes the generated DMARC reports to Log Analytics via Data Collection
 * Rules.
 */
export class LogAnalyticsClient {
  readonly conf: LogAnalyticsConfig;

  /** @throws {LogAnalyticsException} When a required setting is missing. */
  constructor(settings: LogAnalyticsSettings) {
    this.conf = new LogAnalyticsConfig(settings);
    if (
      !this.conf.clientId ||
      !this.conf.clientSecret ||
      !this.conf.tenantId ||
      !this.conf.dce ||
      !this.conf.dcrImmutableId
    ) {
      throw new LogAnalyticsException(
        'Invalid configuration. One or more required settings are missing.',
      );
    }
  }

  /**
   * Publishes the given reports (already in snake_case) to a Data
   * Collection Rule stream.
   */
  async publishJson(
    results: Record<string, unknown>[],
    logsClient: LogsUploader,
    dcrStream: string,
  ): Promise<void> {
    // The SDK serializes with JSON.stringify(), which throws on the
    // bigints of counts beyond 2^53; Python's json sends them exactly.
    const reports = reportsWithinLimit(
      rawJsonIntegers(results) as Record<string, unknown>[],
    );
    if (reports.length === 0) {
      return;
    }
    try {
      await logsClient.upload(this.conf.dcrImmutableId, dcrStream, reports);
    } catch (error) {
      if (isUploadError(error)) {
        throw new LogAnalyticsException(
          `Upload failed: ${causeMessage(error)}`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /**
   * Publishes DMARC and/or SMTP TLS reports to Log Analytics via Data
   * Collection Rules (DCR). A report type is skipped when its stream is not
   * configured or its `save*` flag is false.
   * See https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview
   */
  async publishResults(
    results: LogAnalyticsResults,
    saveAggregate: boolean,
    saveFailure: boolean,
    saveSmtpTls: boolean,
  ): Promise<void> {
    const { conf } = this;
    const credential = new ClientSecretCredential(
      conf.tenantId,
      conf.clientId,
      conf.clientSecret,
      { additionalPolicies: [requestTimeoutPolicy] },
    );
    const logsClient = new LogsIngestionClient(conf.dce, credential, {
      additionalPolicies: [requestTimeoutPolicy],
    });
    const streams = [
      {
        label: 'aggregate',
        reports: results.aggregateReports,
        stream: conf.dcrAggregateStream,
        save: saveAggregate,
      },
      {
        label: 'failure',
        reports: results.failureReports,
        stream: conf.dcrFailureStream,
        save: saveFailure,
      },
      {
        label: 'SMTP TLS',
        reports: results.smtpTlsReports,
        stream: conf.dcrSmtpTlsStream,
        save: saveSmtpTls,
      },
    ];
    // Deviation: a failed stream doesn't stop the others (parsedmarc stops at
    // the first), so one rejected report type can't hold the other two back.
    const errors: unknown[] = [];
    for (const { label, reports, stream, save } of streams) {
      if (reports.length === 0 || !stream || !save) {
        continue;
      }
      logger.info(`Publishing ${label} reports.`);
      try {
        // oxlint-disable-next-line no-await-in-loop -- streams go in order
        await this.publishJson(
          toSnakeCaseKeys(reports) as Record<string, unknown>[],
          logsClient,
          stream,
        );
        logger.info(`Successfully pushed ${label} reports.`);
      } catch (error) {
        errors.push(error);
      }
    }
    const [first, ...others] = errors;
    if (first !== undefined) {
      if (others.length === 0) {
        throw first;
      }
      throw new LogAnalyticsException(
        errors
          .map(error =>
            error instanceof Error ? error.message : String(error),
          )
          .join('; '),
        { cause: first },
      );
    }
  }
}
