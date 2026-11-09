// DMARC failure (forensic, RUF) report parsing and CSV output, ported from
// parsedmarc/__init__.py (`parse_failure_report` and the CSV helpers).

import { resolveParserConfig, type ParserConfigInput } from './config';
import { csvSafe, rowsToCsv, type CsvOptions, type CsvRow } from './csv';
import { InvalidFailureReport } from './errors';
import { errorText, excOrigin, KeyError } from './internal/py';
import { setOwn } from './internal/set-own';
import { logger } from './log';
import { camelToSnake, snakeToCamel } from './serialize';
import type { FailureReport, ParsedEmail } from './types';
import type { PyDateTime } from './utils/datetime';
import { parseEmail } from './utils/email';
import { getIpAddressInfo } from './utils/ip-info';
import { PY_WS_CLASS, pyStrip } from './utils/py-str';
import { humanTimestampToDatetime } from './utils/timestamps';

/**
 * Content types of the MIME part that carries a failure report's sample
 * message (or only its headers).
 */
export const EMAIL_SAMPLE_CONTENT_TYPES: readonly string[] = [
  'text/rfc822',
  'text-rfc-822',
  'text/rfc822-headers',
  'text/rfc-822-headers',
  'message/rfc822',
  'message/rfc-822',
  'message/rfc822-headers',
  'message/rfc-822-headers',
];

// parsedmarc's `feedback_report_regex`:
//   re.compile(r"^([\w\-]+): ([^\r\n]+)\r?$", re.MULTILINE)
// JavaScript's `m` flag also treats a lone CR (and U+2028/U+2029) as a line
// boundary, Python's only LF, so the line anchors are spelled out: start of
// input or after LF, and end of input or before LF. Python's `\w` on str is
// Unicode-aware. Linear: every candidate starts at a line start, the name
// class stops at ":" and the value class stops at CR/LF.
const FEEDBACK_REPORT_REGEX =
  /(?<![^\n])([\p{L}\p{N}_-]+): ([^\r\n]+)\r?(?=\n|$)/gu;

// Python's `re.split(r"\s", ...)`: one Unicode whitespace character.
const PY_WHITESPACE = new RegExp(`[${PY_WS_CLASS}]`, 'u');

const DELIVERY_RESULTS: readonly string[] = [
  'delivered',
  'spam',
  'policy',
  'reject',
  'other',
];

const OPTIONAL_FIELDS: readonly string[] = [
  'original_envelope_id',
  'dkim_domain',
  'original_mail_from',
  'original_rcpt_to',
];

/** Fields of `parsedFailureReportsToCsv()`, in column order. */
export const FAILURE_CSV_FIELDS: readonly string[] = [
  'feedback_type',
  'user_agent',
  'version',
  'original_envelope_id',
  'original_mail_from',
  'original_rcpt_to',
  'arrival_date',
  'arrival_date_utc',
  'subject',
  'message_id',
  'authentication_results',
  'dkim_domain',
  'source_ip_address',
  'source_country',
  'source_reverse_dns',
  'source_base_domain',
  'source_name',
  'source_type',
  'source_asn',
  'source_as_name',
  'source_as_domain',
  'delivery_result',
  'auth_failure',
  'reported_domain',
  'authentication_mechanisms',
  'sample_headers_only',
];

/** Options of {@link parseFailureReport}. */
export type ParseFailureReportOptions = Omit<
  ParserConfigInput,
  'normalizeTimespanThresholdHours'
>;

/** Python's `[t.strip() for t in value.split(",") if t.strip()]`. */
function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map(token => pyStrip(token))
    .filter(token => token !== '');
}

/** Python's `dict[key]` on the working dict, raising KeyError. */
function required(parsed: Map<string, unknown>, key: string): unknown {
  if (!parsed.has(key)) {
    throw new KeyError(key);
  }
  return parsed.get(key);
}

/** Fill in parsedmarc's defaults for the RFC 9991 / RFC 5965 / RFC 6591 fields. */
function applyRequiredFieldDefaults(parsed: Map<string, unknown>): void {
  // Identity-Alignment is REQUIRED per RFC 9991 §4. Default silently for
  // backward compatibility with pre-9991 reporters, but log so the
  // offending reporter is visible.
  if (parsed.has('identity_alignment')) {
    const rawAlignment = pyStrip(String(parsed.get('identity_alignment')));
    parsed.set(
      'authentication_mechanisms',
      rawAlignment.toLowerCase() === 'none' ? [] : splitCommaList(rawAlignment),
    );
    parsed.delete('identity_alignment');
  } else {
    logger.warning(
      "Failure report missing required 'Identity-Alignment' " +
        'field (RFC 9991 §4); defaulting to no aligned mechanisms',
    );
    parsed.set('authentication_mechanisms', []);
  }

  // Auth-Failure is REQUIRED per RFC 9991 §4 (comma-separated).
  if (!parsed.has('auth_failure')) {
    logger.warning(
      "Failure report missing required 'Auth-Failure' field " +
        "(RFC 9991 §4); defaulting to 'dmarc'",
    );
    parsed.set('auth_failure', 'dmarc');
  }
  parsed.set(
    'auth_failure',
    splitCommaList(String(parsed.get('auth_failure'))),
  );

  // Feedback-Type is REQUIRED per RFC 5965 §3.1, but some gateways omit it;
  // the Elasticsearch/OpenSearch outputs require the key (issue #332).
  if (!parsed.has('feedback_type')) {
    logger.warning(
      "Failure report missing required 'Feedback-Type' field " +
        "(RFC 5965 §3.1); defaulting to 'auth-failure'",
    );
    parsed.set('feedback_type', 'auth-failure');
  }

  // Authentication-Results is REQUIRED per RFC 6591 §3.1.
  if (!parsed.has('authentication_results')) {
    logger.warning(
      "Failure report missing required 'Authentication-Results' " +
        'field (RFC 6591 §3.1); defaulting to None',
    );
    parsed.set('authentication_results', null);
  }

  for (const optionalField of OPTIONAL_FIELDS) {
    if (!parsed.has(optionalField)) {
      parsed.set(optionalField, null);
    }
  }
}

function normalizeDeliveryResult(parsed: Map<string, unknown>): void {
  if (parsed.has('delivery_result')) {
    const value = String(parsed.get('delivery_result')).toLowerCase();
    const known = DELIVERY_RESULTS.find(result => value.includes(result));
    if (known !== undefined) {
      parsed.set('delivery_result', known);
    }
  } else {
    parsed.set('delivery_result', null);
  }
  if (!DELIVERY_RESULTS.includes(parsed.get('delivery_result') as string)) {
    parsed.set('delivery_result', 'other');
  }
}

/** The domain of the sample's From address, if it has one. */
function sampleFromDomain(parsedSample: ParsedEmail): string | null {
  const sampleFrom: unknown = parsedSample.from;
  if (typeof sampleFrom !== 'object' || sampleFrom === null) {
    return null;
  }
  const domain = (sampleFrom as { domain?: unknown }).domain;
  return typeof domain === 'string' && domain !== '' ? domain : null;
}

async function buildFailureReport(
  feedbackReport: string,
  sample: string,
  msgDate: PyDateTime | null,
  options: ParseFailureReportOptions,
): Promise<FailureReport> {
  const config = resolveParserConfig(options);
  // A Map keeps Python's dict insertion order for every key, including keys
  // from the report that look like array indices ("123").
  const parsed = new Map<string, unknown>();
  for (const match of feedbackReport.matchAll(FEEDBACK_REPORT_REGEX)) {
    const [, name = '', value = ''] = match;
    parsed.set(name.toLowerCase().replaceAll('-', '_'), value);
  }

  if (!parsed.has('arrival_date')) {
    if (msgDate === null) {
      throw new InvalidFailureReport('Failure sample is not a valid email');
    }
    parsed.set('arrival_date', msgDate.isoformat());
  }
  if (!parsed.has('version')) {
    parsed.set('version', null);
  }
  if (!parsed.has('user_agent')) {
    parsed.set('user_agent', null);
  }
  normalizeDeliveryResult(parsed);

  const arrivalUtc = humanTimestampToDatetime(
    String(parsed.get('arrival_date')),
    { toUtc: true },
  );
  parsed.set('arrival_date_utc', arrivalUtc.strftime('%Y-%m-%d %H:%M:%S'));

  const sourceIp = String(required(parsed, 'source_ip'));
  const ipAddress = sourceIp.split(PY_WHITESPACE)[0] ?? '';
  parsed.set('source', await getIpAddressInfo(ipAddress, { config }));
  parsed.delete('source_ip');

  applyRequiredFieldDefaults(parsed);

  const parsedSample = await parseEmail(sample, {
    stripAttachmentPayloads: config.stripAttachmentPayloads,
    limits: config,
  });

  if (!parsed.has('reported_domain')) {
    // reported_domain is a required string of FailureReport, read directly
    // by the Elasticsearch and OpenSearch outputs, so it cannot be null.
    const domain = sampleFromDomain(parsedSample);
    if (domain === null) {
      throw new InvalidFailureReport(
        'The failure report has no Reported-Domain field, and no ' +
          'domain could be parsed from the From header of the ' +
          'included sample message',
      );
    }
    parsed.set('reported_domain', domain);
  }

  const sampleHeadersOnly =
    parsedSample.attachments.length < 1 && parsedSample.body === null;
  if (sampleHeadersOnly && parsedSample.hasDefects) {
    delete parsedSample.defects;
    delete parsedSample.defectsCategories;
    delete parsedSample.hasDefects;
  }
  parsed.set('sample_headers_only', sampleHeadersOnly);
  parsed.set('sample', sample);
  parsed.set('parsed_sample', parsedSample);

  const report: Record<string, unknown> = {};
  for (const [key, value] of parsed) {
    setOwn(report, snakeToCamel(key), value);
  }
  return report as unknown as FailureReport;
}

/**
 * Parse a DMARC failure report (the `message/feedback-report` part) and its
 * sample (the RFC 822 message or headers).
 *
 * `msgDate` (the report email's date) is the arrival date when the report
 * has no `Arrival-Date` field. Feedback-report fields parsedmarc doesn't
 * know are kept, with camelCase keys (`Reported-URI` → `reportedUri`).
 */
export async function parseFailureReport(
  feedbackReport: string,
  sample: string,
  msgDate: PyDateTime | null,
  options: ParseFailureReportOptions = {},
): Promise<FailureReport> {
  try {
    return await buildFailureReport(feedbackReport, sample, msgDate, options);
  } catch (error) {
    if (error instanceof InvalidFailureReport) {
      // Already a clear, specific message.
      throw error;
    }
    if (error instanceof KeyError) {
      throw new InvalidFailureReport(`Missing value: ${error.message}`, {
        cause: error,
      });
    }
    throw new InvalidFailureReport(
      `Unexpected error: ${errorText(error)}${excOrigin(error)}`,
      { cause: error },
    );
  }
}

/** Backward-compatible alias of {@link parseFailureReport}. */
export const parseForensicReport: typeof parseFailureReport =
  parseFailureReport;

/**
 * Flatten failure reports into CSV rows (snake_case keys): every report
 * field except the sample, with the source flattened into `source_*`, the
 * sample's subject, and the list fields joined with commas.
 */
export function parsedFailureReportsToCsvRows(
  reports: FailureReport | FailureReport[],
): CsvRow[] {
  const reportList = Array.isArray(reports) ? reports : [reports];
  const rows: CsvRow[] = [];
  for (const report of reportList) {
    const row: CsvRow = {};
    for (const [key, value] of Object.entries(report)) {
      setOwn(row, camelToSnake(key), value);
    }
    const { source } = report;
    row.source_ip_address = source.ipAddress;
    row.source_reverse_dns = source.reverseDns;
    row.source_base_domain = source.baseDomain;
    row.source_name = source.name;
    row.source_type = source.type;
    row.source_asn = source.asn;
    row.source_as_name = source.asName;
    row.source_as_domain = source.asDomain;
    row.source_country = source.country;
    delete row.source;
    row.subject = report.parsedSample.subject ?? null;
    row.auth_failure = report.authFailure.join(',');
    row.authentication_mechanisms = report.authenticationMechanisms.join(',');
    delete row.sample;
    delete row.parsed_sample;
    rows.push(row);
  }
  return rows;
}

/** Backward-compatible alias of {@link parsedFailureReportsToCsvRows}. */
export const parsedForensicReportsToCsvRows: typeof parsedFailureReportsToCsvRows =
  parsedFailureReportsToCsvRows;

/** Failure reports as flat CSV, with headers. */
export function parsedFailureReportsToCsv(
  reports: FailureReport | FailureReport[],
  options: CsvOptions = {},
): string {
  const rows = parsedFailureReportsToCsvRows(reports).map(row => {
    const newRow: CsvRow = {};
    for (const key of FAILURE_CSV_FIELDS) {
      newRow[key] = csvSafe(Object.hasOwn(row, key) ? row[key] : null);
    }
    return newRow;
  });
  return rowsToCsv(FAILURE_CSV_FIELDS, rows, options);
}

/** Backward-compatible alias of {@link parsedFailureReportsToCsv}. */
export const parsedForensicReportsToCsv: typeof parsedFailureReportsToCsv =
  parsedFailureReportsToCsv;
