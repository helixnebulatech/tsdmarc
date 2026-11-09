// Port of parsedmarc/loki.py: a client for the Grafana Loki push API.
//
// https://grafana.com/docs/loki/latest/reference/loki-http-api/#ingest-logs

import { Buffer } from 'node:buffer';
import { hostname } from 'node:os';

import { parsedAggregateReportsToCsvRows } from '../aggregate';
import { USER_AGENT } from '../constants';
import type { CsvRow } from '../csv';
import { parsedFailureReportsToCsvRows } from '../failure';
import { PyValueError } from '../internal/py';
import { pyJsonDumps } from '../internal/py-json';
import { logger } from '../log';
import { parsedSmtpTlsReportsToCsvRows } from '../smtp-tls';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';
import { pyStr } from '../utils/python';
import { redactUrlCredentials } from '../utils/redact';
import { humanTimestampToUnixTimestamp } from '../utils/timestamps';
import { describeError, httpPost } from './http';

export const LOKI_PUSH_PATH = '/loki/api/v1/push';
export const LOKI_TIMESTAMP_MODES: readonly LokiTimestampMode[] = [
  'ingest',
  'report_begin',
];
export const LOKI_DEFAULT_LABEL_FIELDS: readonly string[] = [
  'report_type',
  'domain',
];

export type LokiTimestampMode = 'ingest' | 'report_begin';
export type LokiReportType = 'aggregate' | 'failure' | 'smtp_tls';

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const DEFAULT_TIMEOUT = 60;
const DEFAULT_BATCH_SIZE = 1000;
const NS_PER_MS = 1_000_000n;
const NS_PER_SECOND = 1_000_000_000n;
/** Characters of the response body quoted in a failed push's error. */
const MAX_ERROR_BODY = 500;
/**
 * Loki answers 204 when it stored the push; 200 is also accepted. Other
 * 2xx codes are not success: with `block_ingestion_until` set it returns a
 * custom 260 and discards the logs (`block_ingestion_status_code`).
 */
const SUCCESS_STATUSES: ReadonlySet<number> = new Set([200, 204]);
const CLOSED_MESSAGE = 'Cannot send a request, as the client has been closed.';
const INVALID_URL_MESSAGE =
  'Invalid Loki URL (details withheld because they may include credentials)';

/**
 * Per report type: the row field holding the domain the report is about,
 * the row field with its begin time, and whether that value is UTC without
 * an offset (aggregate rows carry the record's interval_begin, which is
 * naive UTC wall-clock time).
 */
const REPORT_TYPES: Readonly<
  Record<LokiReportType, readonly [string, string, boolean]>
> = {
  aggregate: ['domain', 'begin_date', true],
  failure: ['reported_domain', 'arrival_date_utc', true],
  smtp_tls: ['policy_domain', 'begin_date', false],
};

/** Raised when pushing to Loki fails. */
export class LokiError extends Error {
  override name = 'LokiError';
}

export interface LokiClientOptions {
  /**
   * Static stream labels, merged over the defaults `job=parsedmarc` and
   * `host=<host name>`.
   */
  labels?: Readonly<Record<string, string>> | null;
  /**
   * Record fields used as stream labels (default `report_type`, `domain`);
   * keep them to fields with few distinct values.
   */
  labelFields?: readonly string[] | null;
  /**
   * `ingest` (time of the push, the default) or `report_begin` (begin of the
   * reported period; Loki rejects entries older than its
   * `reject_old_samples_max_age`).
   */
  timestamp?: LokiTimestampMode;
  /** Basic auth user. */
  username?: string | null;
  /** Basic auth password (used only with `username`). */
  password?: string | null;
  /** Bearer token, instead of basic auth. */
  token?: string | null;
  /** Sent as `X-Scope-OrgID`. */
  tenantId?: string | null;
  /** Verify TLS certificates (default `true`). */
  verify?: boolean;
  /** Request timeout in seconds (default 60). */
  timeout?: number;
  /** Maximum log lines per push request (default 1000). */
  batchSize?: number;
}

type Labels = readonly (readonly [string, string])[];

interface Entry {
  labels: Labels;
  timestamp: bigint;
  line: CsvRow;
}

/**
 * The push URL: `url` with {@link LOKI_PUSH_PATH} as its path when it has none
 * (keeping its query string, userinfo and port), else `url` unchanged.
 */
function pushUrl(url: string): string {
  if (!URL.canParse(url)) {
    // URL parsers quote part of the URL (part of a password containing
    // "/", "?" or "#" ends up as the "port"), so nothing of it is kept.
    throw new PyValueError(INVALID_URL_MESSAGE);
  }
  // Like httpx's `copy_with(path=...)`, which also normalizes the URL
  // (lower-case host, no default port).
  const target = new URL(url);
  if (target.pathname !== '' && target.pathname !== '/') {
    return url;
  }
  target.pathname = LOKI_PUSH_PATH;
  return target.href;
}

/** `url` without its userinfo. */
function withoutUserinfo(url: string): string {
  const target = new URL(url);
  if (!target.username && !target.password) {
    return url;
  }
  target.username = '';
  target.password = '';
  return target.href;
}

/** The first `length` characters (code points) of `text`, like Python. */
function headChars(text: string, length: number): string {
  return Array.from(text).slice(0, length).join('');
}

/** A client for the Grafana Loki push API. */
export class LokiClient {
  /** The push URL (with its userinfo, if any). */
  readonly url: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly labelFields: readonly string[];
  readonly timestamp: LokiTimestampMode;
  readonly timeout: number;
  readonly batchSize: number;
  readonly verify: boolean;
  /** Headers sent with every request. */
  readonly headers: Readonly<Record<string, string>>;
  readonly #requestUrl: string;
  readonly #closed = new AbortController();

  /**
   * Every report record becomes one JSON log line.
   *
   * @param url - Loki base URL (`/loki/api/v1/push` is appended when the URL
   *   has no path) or the full push URL
   */
  constructor(url: string, options: LokiClientOptions = {}) {
    const timestamp = options.timestamp ?? 'ingest';
    if (!LOKI_TIMESTAMP_MODES.includes(timestamp)) {
      throw new PyValueError(
        `Invalid Loki timestamp '${pyStr(timestamp)}'. Must be one of: ${LOKI_TIMESTAMP_MODES.join(', ')}`,
      );
    }
    const { username, password, token, tenantId } = options;
    if (token && (username || password)) {
      throw new PyValueError('Loki token and username/password are exclusive');
    }
    // parsedmarc uses socket.getfqdn(); there is no synchronous FQDN lookup
    // in Node, so this is the host name the OS reports.
    const labels: Record<string, string> = {
      job: 'parsedmarc',
      host: hostname(),
    };
    for (const [name, value] of Object.entries(options.labels ?? {})) {
      labels[name] = value;
    }
    this.labels = labels;
    this.labelFields = [...(options.labelFields ?? LOKI_DEFAULT_LABEL_FIELDS)];
    for (const name of [...Object.keys(labels), ...this.labelFields]) {
      if (!LABEL_NAME.test(name)) {
        throw new PyValueError(`Invalid Loki label name '${name}'`);
      }
    }
    this.url = pushUrl(url);
    this.timestamp = timestamp;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.batchSize = Math.max(
      1,
      Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE),
    );
    if (Number.isNaN(this.batchSize)) {
      throw new PyValueError('Invalid Loki batch size');
    }
    this.verify = options.verify ?? true;

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (tenantId) {
      headers['X-Scope-OrgID'] = tenantId;
    }
    // Like httpx's `auth=BasicAuth(...)`, which wins over credentials in
    // the URL; without it, URL credentials become Basic auth (httpPost).
    this.#requestUrl = this.url;
    if (username) {
      const credentials = Buffer.from(
        `${username}:${password ?? ''}`,
        'utf8',
      ).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
      this.#requestUrl = withoutUserinfo(this.url);
    }
    this.headers = headers;
  }

  async saveAggregateReportToLoki(
    aggregateReports: AggregateReport | AggregateReport[],
  ): Promise<void> {
    await this.#save(
      'aggregate',
      parsedAggregateReportsToCsvRows(aggregateReports),
    );
  }

  async saveFailureReportToLoki(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    await this.#save('failure', parsedFailureReportsToCsvRows(failureReports));
  }

  /** Backward-compatible alias of {@link saveFailureReportToLoki}. */
  async saveForensicReportToLoki(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    await this.saveFailureReportToLoki(failureReports);
  }

  async saveSmtpTlsReportToLoki(
    smtpTlsReports: SMTPTLSReport | SMTPTLSReport[],
  ): Promise<void> {
    await this.#save('smtp_tls', parsedSmtpTlsReportsToCsvRows(smtpTlsReports));
  }

  async #save(reportType: LokiReportType, rows: CsvRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    logger.debug(`Saving ${rows.length} ${reportType} records to Loki`);
    const [domainField, beginField, beginIsUtc] = REPORT_TYPES[reportType];
    const now = BigInt(Date.now()) * NS_PER_MS;
    const entries: Entry[] = rows.map((row, index) => {
      const line: CsvRow = { ...row, report_type: reportType };
      if (!Object.hasOwn(line, 'domain')) {
        line.domain = row[domainField];
      }
      let timestamp = now;
      if (this.timestamp === 'report_begin') {
        try {
          if (!Object.hasOwn(row, beginField)) {
            throw new PyValueError(`'${beginField}'`);
          }
          const begin = humanTimestampToUnixTimestamp(pyStr(row[beginField]), {
            assumeUtc: beginIsUtc,
          });
          timestamp = BigInt(begin) * NS_PER_SECOND;
        } catch {
          logger.debug(`Unparsable ${beginField}, using ingest time`);
        }
      }
      return {
        labels: this.#streamLabels(line),
        timestamp: timestamp + BigInt(index),
        line,
      };
    });

    // Loki only accepts out-of-order entries within half of max_chunk_age
    // (so 1h by default) of the newest line in a stream, else it rejects
    // them with too_far_behind. Aggregate rows come source-major then per
    // day, so sort the whole list (not per push, which would still go
    // backwards across batches). The sort is stable, like Python's.
    const sorted = entries.toSorted((a, b) => {
      if (a.timestamp === b.timestamp) {
        return 0;
      }
      return a.timestamp < b.timestamp ? -1 : 1;
    });

    for (let start = 0; start < sorted.length; start += this.batchSize) {
      // oxlint-disable-next-line no-await-in-loop -- pushes are sequential
      await this.#push(sorted.slice(start, start + this.batchSize));
    }
  }

  #streamLabels(line: CsvRow): Labels {
    const labels: Record<string, string> = { ...this.labels };
    for (const field of this.labelFields) {
      const value = Object.hasOwn(line, field) ? line[field] : undefined;
      if (value !== null && value !== undefined && value !== '') {
        labels[field] = pyStr(value);
      }
    }
    return Object.entries(labels);
  }

  async #push(entries: readonly Entry[]): Promise<void> {
    const streams = new Map<string, { labels: Labels; values: string[][] }>();
    for (const { labels, timestamp, line } of entries) {
      const key = JSON.stringify(labels);
      let stream = streams.get(key);
      if (stream === undefined) {
        stream = { labels, values: [] };
        streams.set(key, stream);
      }
      stream.values.push([
        timestamp.toString(),
        pyJsonDumps(line, { ensureAscii: false, default: pyStr }),
      ]);
    }
    const body = {
      streams: [...streams.values()].map(({ labels, values }) => ({
        stream: Object.fromEntries(labels),
        values,
      })),
    };
    const redactedUrl = redactUrlCredentials(this.url);
    let status: number;
    let text: string;
    try {
      if (this.#closed.signal.aborted) {
        throw new Error(CLOSED_MESSAGE);
      }
      // Redirects are not followed: httpx re-sends a 301/302 POST as a GET,
      // which the target can answer 200 without storing anything.
      const response = await httpPost(this.#requestUrl, {
        headers: { ...this.headers },
        body: pyJsonDumps(body),
        timeout: this.timeout,
        verify: this.verify,
        followRedirects: false,
        signal: this.#closed.signal,
      });
      ({ status } = response);
      if (SUCCESS_STATUSES.has(status)) {
        await response.discard();
        return;
      }
      try {
        text = await response.text();
      } catch {
        text = '';
      }
    } catch (error) {
      if (this.#closed.signal.aborted) {
        throw new Error(CLOSED_MESSAGE, { cause: error });
      }
      throw new LokiError(
        `Loki push to ${redactedUrl} failed: ${describeError(error)}`,
        { cause: error },
      );
    }
    throw new LokiError(
      `Loki push to ${redactedUrl} failed with HTTP ${status}: ${headChars(text, MAX_ERROR_BODY)}`,
    );
  }

  /** Close the client: abort in-flight requests and refuse new ones. */
  close(): void {
    this.#closed.abort(new Error(CLOSED_MESSAGE));
  }
}
