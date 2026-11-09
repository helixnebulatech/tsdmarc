// Port of parsedmarc/splunk.py: a client for a Splunk HTTP Event Collector.
//
// http://docs.splunk.com/Documentation/Splunk/latest/Data/AboutHEC
// http://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTinput#services.2Fcollector

import { hostname } from 'node:os';

import { USER_AGENT } from '../constants';
import { pyJsonDumps } from '../internal/py-json';
import { logger } from '../log';
import { toSnakeCaseKeys } from '../serialize';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';
import { InvalidURL } from '../utils/http';
import { sanitizeForLog } from '../utils/sanitize';
import { humanTimestampToUnixTimestamp } from '../utils/timestamps';
import { describeError, httpPost } from './http';

const DEFAULT_TIMEOUT = 60;
const CLOSED_MESSAGE = 'Cannot send a request, as the client has been closed.';
// Python's `str.lstrip("Splunk ")` strips any of these characters, not the
// prefix (see `lstripChars`).
const TOKEN_PREFIX_CHARS = 'Splunk ';
// `urlparse()`: an optional scheme, then `//netloc` up to the path.
const URL_SCHEME_AND_NETLOC = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?/u;
// httpx's InvalidURL quotes part of the URL, which can be part of a
// password (one containing "/", "?" or "#" ends up as the "port"), so its
// text is replaced by this fixed message.
const INVALID_URL_MESSAGE =
  'Invalid Splunk HEC URL (details withheld because they may include credentials)';
/** Characters of a sender's date quoted in a warning. */
const MAX_LOGGED_DATE = 100;

/** Raised when a Splunk API error occurs. */
export class SplunkError extends Error {
  override name = 'SplunkError';
}

export interface HECClientOptions {
  /** The source name (default `"tsdmarc"`). */
  source?: string;
  /** Verify TLS certificates (default `true`). */
  verify?: boolean;
  /** Seconds to wait for the server before giving up (default 60). */
  timeout?: number;
}

type JsonObject = Record<string, unknown>;

// Deviation: `json.dumps()` writes a reporter's `NaN` or `1e999` bare, which
// is not JSON, and HEC answers for the whole request: one report would fail
// every other event of the POST.
const HEC_JSON = { nonFiniteAsNull: true } as const;

/** Python's `str.lstrip(chars)`: drop leading characters found in `chars`. */
function lstripChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value.charAt(start))) {
    start += 1;
  }
  return value.slice(start);
}

/** `{scheme}://{netloc}` as Python's `urlparse()` splits them. */
function schemeAndNetloc(url: string): string {
  const match = URL_SCHEME_AND_NETLOC.exec(url);
  const scheme = match?.[1]?.toLowerCase() ?? '';
  const netloc = match?.[2] ?? '';
  return `${scheme}://${netloc}`;
}

/**
 * The event time of an SMTP TLS report, or `null` when its `start-datetime`
 * is no date: the parser keeps that value as the sender wrote it (any JSON
 * type), and one such report must not cost the batch its Splunk events.
 */
function smtpTlsEventTime(report: SMTPTLSReport): number | null {
  try {
    return humanTimestampToUnixTimestamp(report.beginDate);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const value = sanitizeForLog(
      String(report.beginDate).slice(0, MAX_LOGGED_DATE),
    );
    logger.warning(
      `Sending SMTP TLS report to Splunk without an event time: invalid begin_date ${value}`,
    );
    return null;
  }
}

function snake(value: unknown): JsonObject {
  return toSnakeCaseKeys(value) as JsonObject;
}

/** A client for a Splunk HTTP Events Collector (HEC). */
export class HECClient {
  readonly url: string;
  readonly accessToken: string;
  readonly index: string;
  readonly host: string;
  readonly source: string;
  readonly timeout: number;
  readonly verify: boolean;
  /** Headers sent with every request. */
  readonly headers: Readonly<Record<string, string>>;
  readonly #commonData: JsonObject;
  readonly #closed = new AbortController();

  /**
   * @param url - The URL of the HEC; only its scheme and host are used
   * @param accessToken - The HEC access token
   * @param index - The name of the index
   */
  constructor(
    url: string,
    accessToken: string,
    index: string,
    options: HECClientOptions = {},
  ) {
    this.url = `${schemeAndNetloc(url)}/services/collector/event/1.0`;
    // Same as parsedmarc's `access_token.lstrip("Splunk ")`: it strips a
    // pasted "Splunk " prefix, and also any leading S/p/l/u/n/k/space.
    this.accessToken = lstripChars(accessToken, TOKEN_PREFIX_CHARS);
    this.index = index;
    // parsedmarc uses socket.getfqdn(); there is no synchronous FQDN lookup
    // in Node, so this is the host name the OS reports.
    this.host = hostname();
    this.source = options.source ?? 'tsdmarc';
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.verify = options.verify ?? true;
    this.#commonData = {
      host: this.host,
      source: this.source,
      index: this.index,
    };
    this.headers = {
      'User-Agent': USER_AGENT,
      Authorization: `Splunk ${this.accessToken}`,
    };
  }

  /** The `host`, `source` and `index` fields every event carries. */
  get commonData(): Readonly<JsonObject> {
    return { ...this.#commonData };
  }

  /** Saves aggregate DMARC reports to Splunk, one event per record. */
  async saveAggregateReportsToSplunk(
    aggregateReports: AggregateReport | AggregateReport[],
  ): Promise<void> {
    logger.debug('Saving aggregate reports to Splunk');
    const reports = Array.isArray(aggregateReports)
      ? aggregateReports
      : [aggregateReports];
    if (reports.length < 1) {
      return;
    }

    const data: JsonObject = { ...this.#commonData };
    const jsonLines: string[] = [];
    for (const report of reports) {
      const metadata = snake(report.reportMetadata);
      const policyPublished = snake(report.policyPublished);
      for (const record of report.records) {
        const snakeRecord = snake(record);
        const { source, alignment, identifiers } = record;
        const newReport: JsonObject = { ...metadata };
        newReport.interval_begin = record.intervalBegin;
        newReport.interval_end = record.intervalEnd;
        newReport.normalized_timespan = snakeRecord.normalized_timespan;
        newReport.published_policy = policyPublished;
        newReport.source_ip_address = source.ipAddress;
        newReport.source_country = source.country;
        newReport.source_reverse_dns = source.reverseDns;
        newReport.source_base_domain = source.baseDomain;
        newReport.source_type = source.type;
        newReport.source_name = source.name;
        newReport.source_asn = source.asn;
        newReport.source_as_name = source.asName;
        newReport.source_as_domain = source.asDomain;
        newReport.message_count = record.count;
        newReport.disposition = record.policyEvaluated.disposition;
        newReport.spf_aligned = alignment.spf;
        newReport.dkim_aligned = alignment.dkim;
        newReport.passed_dmarc = alignment.dmarc;
        newReport.header_from = identifiers.headerFrom;
        newReport.envelope_from = identifiers.envelopeFrom;
        const authResults = snakeRecord.auth_results as JsonObject;
        if ('dkim' in authResults) {
          newReport.dkim_results = authResults.dkim;
        }
        if ('spf' in authResults) {
          newReport.spf_results = authResults.spf;
        }

        data.sourcetype = 'dmarc:aggregate';
        // interval_begin is a UTC wall-clock string; assumeUtc keeps it
        // from being re-interpreted as local time on non-UTC hosts.
        data.time = humanTimestampToUnixTimestamp(record.intervalBegin, {
          assumeUtc: true,
        });
        data.event = newReport;
        jsonLines.push(`${pyJsonDumps(data, HEC_JSON)}\n`);
      }
    }
    await this.#post(jsonLines);
  }

  /** Saves failure DMARC reports to Splunk, one event per report. */
  async saveFailureReportsToSplunk(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    logger.debug('Saving failure reports to Splunk');
    const reports = Array.isArray(failureReports)
      ? failureReports
      : [failureReports];
    if (reports.length < 1) {
      return;
    }

    const jsonLines: string[] = [];
    for (const report of reports) {
      const data: JsonObject = { ...this.#commonData };
      data.sourcetype = 'dmarc:failure';
      // arrival_date_utc is a UTC wall-clock string; assumeUtc keeps it
      // from being re-interpreted as local time on non-UTC hosts.
      data.time = humanTimestampToUnixTimestamp(report.arrivalDateUtc, {
        assumeUtc: true,
      });
      data.event = snake(report);
      jsonLines.push(`${pyJsonDumps(data, HEC_JSON)}\n`);
    }
    await this.#post(jsonLines);
  }

  /** Backward-compatible alias of {@link saveFailureReportsToSplunk}. */
  async saveForensicReportsToSplunk(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    await this.saveFailureReportsToSplunk(failureReports);
  }

  /** Saves SMTP TLS reports to Splunk, one event per report. */
  async saveSmtpTlsReportsToSplunk(
    reports: SMTPTLSReport | SMTPTLSReport[],
  ): Promise<void> {
    logger.debug('Saving SMTP TLS reports to Splunk');
    const reportList = Array.isArray(reports) ? reports : [reports];
    if (reportList.length < 1) {
      return;
    }

    const jsonLines: string[] = [];
    for (const report of reportList) {
      const data: JsonObject = { ...this.#commonData, sourcetype: 'smtp:tls' };
      const time = smtpTlsEventTime(report);
      if (time !== null) {
        data.time = time;
      }
      data.event = snake(report);
      jsonLines.push(`${pyJsonDumps(data, HEC_JSON)}\n`);
    }
    await this.#post(jsonLines);
  }

  async #post(jsonLines: string[]): Promise<void> {
    if (!this.verify) {
      logger.debug('Skipping certificate verification for Splunk HEC');
    }
    let response: unknown;
    try {
      if (this.#closed.signal.aborted) {
        throw new Error(CLOSED_MESSAGE);
      }
      const result = await httpPost(this.url, {
        headers: { ...this.headers },
        // Bytes, so no Content-Type is added (httpx sends none either).
        body: new TextEncoder().encode(jsonLines.join('')),
        timeout: this.timeout,
        verify: this.verify,
        signal: this.#closed.signal,
      });
      response = JSON.parse(await result.text());
    } catch (error) {
      if (error instanceof InvalidURL) {
        throw new SplunkError(INVALID_URL_MESSAGE);
      }
      throw new SplunkError(describeError(error), { cause: error });
    }
    const { code, text } = (response ?? {}) as {
      code?: unknown;
      text?: unknown;
    };
    if (code !== 0) {
      throw new SplunkError(String(text));
    }
  }

  /** Close the client: abort in-flight requests and refuse new ones. */
  close(): void {
    this.#closed.abort(new Error(CLOSED_MESSAGE));
  }
}
