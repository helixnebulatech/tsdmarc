// SMTP TLS (RFC 8460) report parsing and CSV output, ported from
// parsedmarc/__init__.py.

import { DEFAULT_MAX_SMTP_TLS_REPORT_SIZE, type ParserOptions } from './config';
import { csvSafe, rowsToCsv, type CsvOptions, type CsvRow } from './csv';
import { InvalidSMTPTLSReport } from './errors';
import {
  errorText,
  excOrigin,
  getItem,
  getOptional,
  KeyError,
  pyContains,
  pyIter,
  pyStrJoin,
  pyTypeRepr,
} from './internal/py';
import { pyJsonLoads } from './internal/py-json-loads';
import { setOwn } from './internal/set-own';
import {
  camelToSnake,
  MAX_REPORT_DEPTH,
  markRaw,
  nestsDeeperThan,
} from './serialize';
import type {
  SMTPTLSFailureDetails,
  SMTPTLSPolicy,
  SMTPTLSReport,
} from './types';
import { pyStr } from './utils/python';
import { sanitizeForLog } from './utils/sanitize';
import { decodeUtf8 } from './utils/text';
import { humanTimestampToDatetime } from './utils/timestamps';

const POLICY_TYPES: readonly string[] = ['tlsa', 'sts', 'no-policy-found'];

const REQUIRED_FIELDS: readonly string[] = [
  'organization-name',
  'date-range',
  'contact-info',
  'report-id',
  'policies',
];

const OPTIONAL_FAILURE_FIELDS: readonly [
  string,
  keyof SMTPTLSFailureDetails,
][] = [
  ['sending-mta-ip', 'sendingMtaIp'],
  ['receiving-ip', 'receivingIp'],
  ['receiving-mx-hostname', 'receivingMxHostname'],
  ['receiving-mx-helo', 'receivingMxHelo'],
  ['failure-reason-code', 'failureReasonCode'],
];

/** Fields of `parsedSmtpTlsReportsToCsv()`, in column order. */
export const SMTP_TLS_CSV_FIELDS: readonly string[] = [
  'organization_name',
  'begin_date',
  'end_date',
  'report_id',
  'result_type',
  'successful_session_count',
  'failed_session_count',
  'policy_domain',
  'policy_type',
  'policy_strings',
  'mx_host_patterns',
  'sending_mta_ip',
  'receiving_ip',
  'receiving_mx_hostname',
  'receiving_mx_helo',
  'additional_info_uri',
  'failure_reason_code',
];

/**
 * Treat `null`/`undefined` or a blank string as absent: some reporters send
 * `""` for optional failure-details fields, which is not a valid IP and
 * broke INET/Ip() columns downstream (parsedmarc issue #915).
 */
function nonBlank(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  return value;
}

function wrap(error: unknown, keyErrorPrefix: string): InvalidSMTPTLSReport {
  if (error instanceof KeyError) {
    return new InvalidSMTPTLSReport(`${keyErrorPrefix}: ${error.message}`, {
      cause: error,
    });
  }
  return new InvalidSMTPTLSReport(errorText(error) + excOrigin(error), {
    cause: error,
  });
}

// Deviation: parsedmarc keeps the reporter's JSON values whatever their type,
// and a wrong type then fails in the outputs (`str.join`, date parsing, SQL
// parameters), where one report takes its whole batch down. They are checked
// here, so such a report is an invalid report.

/** RFC 3339 date-times are short; `parseDate()` is linear but not free. */
const MAX_DATETIME_LENGTH = 64;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidSMTPTLSReport(
      `${field} must be a string, not ${pyTypeRepr(value)}`,
    );
  }
  return value;
}

function requireStringList(value: readonly unknown[], field: string): void {
  for (const item of value) {
    requireString(item, `${field} item`);
  }
}

/** A session count: an integer, or `null` (harmless in every output). */
function requireCount(value: unknown, field: string): unknown {
  if (
    value !== null &&
    typeof value !== 'bigint' &&
    !Number.isSafeInteger(value)
  ) {
    throw new InvalidSMTPTLSReport(
      `${field} must be an integer, not ${pyTypeRepr(value)}`,
    );
  }
  return value;
}

/** Numbers pass: outputs store these optional fields as text. */
function requireScalar(value: unknown, field: string): unknown {
  if (typeof value === 'object' && value !== null) {
    throw new InvalidSMTPTLSReport(
      `${field} must be a string, not ${pyTypeRepr(value)}`,
    );
  }
  return value;
}

/** A date-time the outputs can parse; kept as the reporter wrote it. */
function requireDatetime(value: unknown, field: string): string {
  const text = requireString(value, field);
  let valid = text.length <= MAX_DATETIME_LENGTH;
  if (valid) {
    try {
      humanTimestampToDatetime(text, { toUtc: true });
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw new InvalidSMTPTLSReport(`${field} is not a valid date-time`);
  }
  return text;
}

/** Parse one `failure-details` entry (parsedmarc's `_parse_smtp_tls_failure_details`). */
export function parseSmtpTlsFailureDetails(
  failureDetails: unknown,
): SMTPTLSFailureDetails {
  try {
    const details: SMTPTLSFailureDetails = {
      resultType: markRaw(
        requireString(getItem(failureDetails, 'result-type'), 'result-type'),
      ) as string,
      failedSessionCount: markRaw(
        requireCount(
          getItem(failureDetails, 'failed-session-count'),
          'failed-session-count',
        ),
      ) as number,
    };
    for (const [sourceKey, destinationKey] of OPTIONAL_FAILURE_FIELDS) {
      const value = nonBlank(getOptional(failureDetails, sourceKey));
      if (value !== null) {
        setOwn(
          details as unknown as Record<string, unknown>,
          destinationKey,
          markRaw(requireScalar(value, sourceKey)),
        );
      }
    }
    // RFC 8460 §4.4 names the key "additional-information"; some reporters
    // send the non-RFC "additional-info-uri" instead.
    let additionalInfoUri = nonBlank(
      getOptional(failureDetails, 'additional-information'),
    );
    if (additionalInfoUri === null) {
      additionalInfoUri = nonBlank(
        getOptional(failureDetails, 'additional-info-uri'),
      );
    }
    if (additionalInfoUri !== null) {
      details.additionalInfoUri = markRaw(
        requireScalar(additionalInfoUri, 'additional-information'),
      ) as string;
    }
    return details;
  } catch (error) {
    throw wrap(error, 'Missing required failure details field');
  }
}

/** Parse one policy entry (parsedmarc's `_parse_smtp_tls_report_policy`). */
export function parseSmtpTlsReportPolicy(policy: unknown): SMTPTLSPolicy {
  try {
    const policyInfo = getItem(policy, 'policy');
    const policyDomain = getItem(policyInfo, 'policy-domain') as string;
    const policyType = getItem(policyInfo, 'policy-type') as string;
    // `in` on a list compares with ==, so any JSON value is accepted here.
    if (!POLICY_TYPES.includes(policyType)) {
      throw new InvalidSMTPTLSReport(
        `Invalid policy type ${sanitizeForLog(pyStr(policyType))}`,
      );
    }
    const newPolicy: SMTPTLSPolicy = {
      policyDomain: markRaw(requireString(policyDomain, 'policy-domain')),
      policyType,
    } as SMTPTLSPolicy;
    if (pyContains(policyInfo, 'policy-string')) {
      const policyStrings = getItem(policyInfo, 'policy-string');
      if (Array.isArray(policyStrings) && policyStrings.length > 0) {
        requireStringList(policyStrings, 'policy-string');
        newPolicy.policyStrings = markRaw(policyStrings) as string[];
      }
    }
    if (pyContains(policyInfo, 'mx-host-pattern')) {
      const patterns = getItem(policyInfo, 'mx-host-pattern');
      if (Array.isArray(patterns) && patterns.length > 0) {
        requireStringList(patterns, 'mx-host-pattern');
        newPolicy.mxHostPatterns = markRaw(patterns) as string[];
      }
    }
    const summary = getItem(policy, 'summary');
    newPolicy.successfulSessionCount = markRaw(
      requireCount(
        getItem(summary, 'total-successful-session-count'),
        'total-successful-session-count',
      ),
    ) as number;
    newPolicy.failedSessionCount = markRaw(
      requireCount(
        getItem(summary, 'total-failure-session-count'),
        'total-failure-session-count',
      ),
    ) as number;
    if (pyContains(policy, 'failure-details')) {
      const failureDetails: SMTPTLSFailureDetails[] = [];
      for (const details of pyIter(getItem(policy, 'failure-details'))) {
        failureDetails.push(parseSmtpTlsFailureDetails(details));
      }
      newPolicy.failureDetails = failureDetails;
    }
    return newPolicy;
  } catch (error) {
    throw wrap(error, 'Missing required policy field');
  }
}

/** Parse and validate an SMTP TLS report (RFC 8460 JSON). */
export function parseSmtpTlsReportJson(
  report: string | Uint8Array,
  options: Partial<Pick<ParserOptions, 'maxSmtpTlsReportSize'>> = {},
): SMTPTLSReport {
  const maxSize =
    options.maxSmtpTlsReportSize ?? DEFAULT_MAX_SMTP_TLS_REPORT_SIZE;
  try {
    // Before parsing: 100 MiB of "{}," is 35 million objects, which take over
    // 2 GB of heap. Real reports are a few KB.
    if (maxSize > 0 && report.length > maxSize) {
      throw new InvalidSMTPTLSReport(
        `SMTP TLS report of ${report.length} bytes exceeds the ${maxSize} byte limit (max_smtp_tls_report_size)`,
      );
    }
    // Like Python's `decode("utf-8", errors="replace")`, a BOM is kept (and
    // then rejected by json.loads).
    const text =
      typeof report === 'string' ? report : decodeUtf8(report, 'replace');
    // The depth is checked while scanning: the tree of a compressed report
    // full of "[" would not fit in the heap.
    const reportDict: unknown = pyJsonLoads(text, {
      bigIntegers: true,
      maxDepth: MAX_REPORT_DEPTH,
    });
    for (const requiredField of REQUIRED_FIELDS) {
      if (!pyContains(reportDict, requiredField)) {
        throw new Error(`Missing required field: ${requiredField}]`);
      }
    }
    const policiesValue = getItem(reportDict, 'policies');
    if (!Array.isArray(policiesValue)) {
      throw new InvalidSMTPTLSReport(
        `policies must be a list, not ${pyTypeRepr(policiesValue)}`,
      );
    }
    const policies = policiesValue.map(policy =>
      parseSmtpTlsReportPolicy(policy),
    );
    const dateRange = getItem(reportDict, 'date-range');
    // Deviation: raw-kept values deeper than this would break JSON output and
    // worker messages (native recursion), so the report is rejected here. The
    // scan counts open containers, so this also sees a last, empty level.
    if (nestsDeeperThan(reportDict, MAX_REPORT_DEPTH)) {
      throw new Error(
        `report data nested more than ${MAX_REPORT_DEPTH} levels deep`,
      );
    }
    const contactInfo = getItem(reportDict, 'contact-info');
    if (Array.isArray(contactInfo)) {
      requireStringList(contactInfo, 'contact-info');
    } else {
      requireString(contactInfo, 'contact-info');
    }
    return {
      organizationName: markRaw(
        requireString(
          getItem(reportDict, 'organization-name'),
          'organization-name',
        ),
      ) as string,
      beginDate: markRaw(
        requireDatetime(getItem(dateRange, 'start-datetime'), 'start-datetime'),
      ) as string,
      endDate: markRaw(
        requireDatetime(getItem(dateRange, 'end-datetime'), 'end-datetime'),
      ) as string,
      contactInfo: markRaw(contactInfo) as string | string[],
      reportId: markRaw(
        requireString(getItem(reportDict, 'report-id'), 'report-id'),
      ) as string,
      policies,
    };
  } catch (error) {
    throw wrap(error, 'Missing required field');
  }
}

/**
 * Flatten SMTP TLS reports into CSV rows (snake_case keys): one row per
 * policy, plus one per failure-details entry.
 */
export function parsedSmtpTlsReportsToCsvRows(
  reports: SMTPTLSReport | SMTPTLSReport[],
): CsvRow[] {
  const reportList = Array.isArray(reports) ? reports : [reports];
  const rows: CsvRow[] = [];
  for (const report of reportList) {
    const record: CsvRow = {
      organization_name: report.organizationName,
      begin_date: report.beginDate,
      end_date: report.endDate,
      report_id: report.reportId,
    };
    for (const policy of report.policies) {
      // Deviation: parsedmarc reuses one dict, so a policy without these
      // fields shows the previous policy's values.
      const policyRecord: CsvRow = { ...record };
      if (policy.policyStrings !== undefined) {
        policyRecord.policy_strings = pyStrJoin('|', policy.policyStrings);
      }
      if (policy.mxHostPatterns !== undefined) {
        policyRecord.mx_host_patterns = pyStrJoin('|', policy.mxHostPatterns);
      }
      rows.push({
        ...policyRecord,
        policy_domain: policy.policyDomain,
        policy_type: policy.policyType,
        successful_session_count: policy.successfulSessionCount,
        failed_session_count: policy.failedSessionCount,
      });
      for (const failureDetails of policy.failureDetails ?? []) {
        const failureRecord: CsvRow = { ...policyRecord };
        for (const [key, value] of Object.entries(failureDetails)) {
          setOwn(failureRecord, camelToSnake(key), value);
        }
        rows.push(failureRecord);
      }
    }
  }
  return rows;
}

/** SMTP TLS reports as flat CSV, with headers. */
export function parsedSmtpTlsReportsToCsv(
  reports: SMTPTLSReport | SMTPTLSReport[],
  options: CsvOptions = {},
): string {
  const rows = parsedSmtpTlsReportsToCsvRows(reports).map(row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, csvSafe(value)]),
    ),
  );
  return rowsToCsv(SMTP_TLS_CSV_FIELDS, rows, options);
}
