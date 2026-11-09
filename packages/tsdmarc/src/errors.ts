// Error hierarchy, ported from parsedmarc/__init__.py and parsedmarc/utils.py.
//
//   ParserError
//   ├─ InvalidDMARCReport
//   │  ├─ InvalidAggregateReport
//   │  └─ InvalidFailureReport (alias: InvalidForensicReport)
//   ├─ InvalidSMTPTLSReport
//   └─ EmailTooLargeError
//
// Every class sets `name` so `error.name` and stack traces match the class.

/** Raised when an error parsing a report occurs. */
export class ParserError extends Error {
  override name = 'ParserError';
}

/** Raised when an invalid DMARC report is encountered. */
export class InvalidDMARCReport extends ParserError {
  override name = 'InvalidDMARCReport';
}

/** Raised when an invalid SMTP TLS report is encountered. */
export class InvalidSMTPTLSReport extends ParserError {
  override name = 'InvalidSMTPTLSReport';
}

/** Raised when an invalid DMARC aggregate report is encountered. */
export class InvalidAggregateReport extends InvalidDMARCReport {
  override name = 'InvalidAggregateReport';
}

/** Raised when an invalid DMARC failure report is encountered. */
export class InvalidFailureReport extends InvalidDMARCReport {
  override name = 'InvalidFailureReport';
}

/** Backward-compatible alias of {@link InvalidFailureReport}. */
export const InvalidForensicReport: typeof InvalidFailureReport =
  InvalidFailureReport;

/**
 * Raised when an email is over the configured size or structure limits
 * (`maxEmailSize`, `maxMimeParts`, `maxHeaderLines`,
 * `maxExpandedEmailSize`); parsedmarc has no such limits. Mailbox processing
 * treats the message as invalid.
 */
export class EmailTooLargeError extends ParserError {
  override name = 'EmailTooLargeError';
}

/** The error for an email of `size` bytes over the `limit` (`maxEmailSize`). */
export function emailTooLargeError(
  size: number,
  limit: number,
): EmailTooLargeError {
  return new EmailTooLargeError(
    `Email of ${size} bytes exceeds the ${limit} byte size limit (max_email_size)`,
  );
}

/** Raised when an error parsing the email occurs. */
export class EmailParserError extends Error {
  override name = 'EmailParserError';
}

/** Raised when an error occurs when downloading a file. */
export class DownloadError extends Error {
  override name = 'DownloadError';
}

/**
 * Enrichment can't work for any record: nothing is wrong with the report
 * being parsed. Unlike a bad record, it must not be skipped, or a report
 * loses all its records and still looks parsed. parsedmarc has no such
 * class.
 */
export class EnrichmentError extends Error {
  override name = 'EnrichmentError';
}

const MAX_CAUSE_CHAIN = 16;

/**
 * The {@link EnrichmentError} behind `error`, or `null`: report parsers wrap
 * whatever fails in a report-level error, keeping it in `cause`.
 */
export function findEnrichmentError(error: unknown): EnrichmentError | null {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN; depth += 1) {
    if (current instanceof EnrichmentError) {
      return current;
    }
    if (!(current instanceof Error)) {
      return null;
    }
    current = current.cause;
  }
  return null;
}

/** Raised when the IPinfo API rejects the configured token. */
export class InvalidIPinfoAPIKey extends EnrichmentError {
  override name = 'InvalidIPinfoAPIKey';
}

/** Raised when no IP database can be opened. */
export class IPDatabaseError extends EnrichmentError {
  override name = 'IPDatabaseError';
  /** The system error code (`ENOENT`) of a missing file, if any. */
  readonly code: string | undefined;

  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.code = options?.code;
  }
}
