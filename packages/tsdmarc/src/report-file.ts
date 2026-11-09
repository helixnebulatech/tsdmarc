// Report file parsing, ported from parsedmarc/__init__.py:
// `parse_report_file()`, `_looks_like_email()`, `_describe_parse_failure()`
// and `get_dmarc_reports_from_mbox()`.

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseAggregateReportXml } from './aggregate';
import {
  resolveParserConfig,
  type ParserConfig,
  type ParserConfigInput,
} from './config';
import {
  EmailTooLargeError,
  emailTooLargeError,
  findEnrichmentError,
  InvalidAggregateReport,
  InvalidDMARCReport,
  InvalidSMTPTLSReport,
  ParserError,
} from './errors';
import {
  extractReport,
  MAX_DECOMPRESSED_REPORT_SIZE,
  type ReportStream,
} from './extract';
import { MAGIC_GZIP, MAGIC_ZIP, startsWith } from './internal/magic';
import { errorText, excOrigin } from './internal/py';
import { logger } from './log';
import { parallelMap, parseReportEmailTask } from './parallel';
import { classifyParsedEmail, parseReportEmail } from './report-email';
import { parseSmtpTlsReportJson } from './smtp-tls';
import type {
  AggregateReport,
  FailureReport,
  ParsedReport,
  ParsingResults,
  SMTPTLSReport,
} from './types';
import { MboxReader } from './utils/mbox';
import { pyLStrip } from './utils/py-str';
import { sanitizeForLog } from './utils/sanitize';
import { decodeUtf8 } from './utils/text';

/**
 * An RFC 5322 header field name (printable ASCII except the colon) followed
 * by a colon at the start of the text, or an mbox `From ` separator.
 */
const EMAIL_HEADER_REGEX = /^(?:From |[\x21-\x39\x3b-\x7e]+:)/u;

const SNIFF_LENGTH = 512;

/**
 * True if the first line looks like an email header (parsedmarc's
 * `_looks_like_email`). Callers pass already left-stripped text.
 */
export function looksLikeEmail(text: string): boolean {
  const newline = text.indexOf('\n');
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  return EMAIL_HEADER_REGEX.test(firstLine);
}

/** The first `count` code points of `text` (Python's `text[:count]`). */
function codePointPrefix(text: string, count: number): string {
  let result = '';
  let taken = 0;
  for (const char of text) {
    if (taken === count) {
      break;
    }
    result += char;
    taken += 1;
  }
  return result;
}

/**
 * The reason a `parseReportFile()` call failed: only the parser for the
 * format the content resembles produced a meaningful error, so sniff the
 * leading non-whitespace text (parsedmarc's `_describe_parse_failure`).
 */
export function describeParseFailure(
  content: string | Uint8Array,
  aggregateError: Error,
  smtpTlsError: Error,
  emailError: Error,
): string {
  const sniff = pyLStrip(
    typeof content === 'string'
      ? codePointPrefix(content, SNIFF_LENGTH)
      : decodeUtf8(content.subarray(0, SNIFF_LENGTH), 'replace'),
  );
  if (sniff.startsWith('<')) {
    return `Invalid aggregate report: ${aggregateError.message}`;
  }
  if (sniff.startsWith('{')) {
    return `Invalid SMTP TLS report: ${smtpTlsError.message}`;
  }
  if (looksLikeEmail(sniff)) {
    return `Invalid report email: ${emailError.message}`;
  }
  return 'Not a recognized report format (not a DMARC aggregate XML report, an SMTP TLS JSON report, or a DMARC report email)';
}

/** Input of {@link parseReportFile}: a path, bytes, or a binary stream. */
export type ReportFileInput =
  | string
  | URL
  | Uint8Array
  | ArrayBuffer
  | ReportStream;

/** Options of {@link parseReportFile}. */
export interface ParseReportFileOptions extends ParserConfigInput {
  /** Keep-alive callback for large aggregate reports (not part of `config`). */
  keepAlive?: (() => unknown) | null;
}

/**
 * The largest report file read: the email size limit, but never below the
 * 100 MiB decompression cap (a bare XML report can be that large). `null`
 * when `maxEmailSize` is 0 (no limit).
 */
function maxReportFileSize(config: ParserConfig): number | null {
  return config.maxEmailSize > 0
    ? Math.max(config.maxEmailSize, MAX_DECOMPRESSED_REPORT_SIZE)
    : null;
}

/** Read the whole content; a text stream fails like Python's `bytes` check. */
async function readContent(
  input: ReportFileInput,
  maxSize: number | null,
): Promise<Uint8Array> {
  if (typeof input === 'string' || input instanceof URL) {
    const filePath = typeof input === 'string' ? input : fileURLToPath(input);
    logger.debug(`Parsing ${filePath}`);
    if (maxSize !== null) {
      const { size } = await stat(filePath);
      if (size > maxSize) {
        throw new EmailTooLargeError(
          `File of ${size} bytes exceeds the ${maxSize} byte size limit (max_email_size)`,
        );
      }
    }
    return new Uint8Array(await readFile(filePath));
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  // A caller-supplied stream is read but never closed or cancelled, not even
  // when over the limit: `for await` would call the iterator's `return()`.
  const stream = input as AsyncIterable<Uint8Array | string>;
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value: chunk } = await iterator.next();
    if (done) {
      return new Uint8Array(Buffer.concat(chunks));
    }
    if (typeof chunk === 'string') {
      // Python: `str.startswith(bytes)` on a text-mode file's content.
      throw new TypeError(
        'startswith first arg must be str or a tuple of str, not bytes',
      );
    }
    size += chunk.byteLength;
    if (maxSize !== null && size > maxSize) {
      throw new EmailTooLargeError(
        `Stream of more than ${maxSize} bytes exceeds the byte size limit (max_email_size)`,
      );
    }
    chunks.push(chunk);
  }
}

/** parsedmarc's `parse_aggregate_report_file()` on already-read content. */
async function parseAggregateContent(
  content: string | Uint8Array,
  config: ParserConfig,
  keepAlive: (() => unknown) | null,
): Promise<AggregateReport> {
  let xml: string;
  try {
    xml = extractReport(content);
  } catch (error) {
    throw new InvalidAggregateReport(errorText(error) + excOrigin(error), {
      cause: error,
    });
  }
  return parseAggregateReportXml(xml, { config, keepAlive });
}

/**
 * Parses a DMARC aggregate report, DMARC failure report or SMTP TLS report
 * from a file path, bytes or a binary stream (compressed or not, report
 * email or bare report).
 *
 * A path is opened and closed here; a caller-supplied stream is read but
 * left for the caller to close. When no format matches, the
 * {@link ParserError} explains why, based on what the content looks like.
 */
export async function parseReportFile(
  input: ReportFileInput,
  options: ParseReportFileOptions = {},
): Promise<ParsedReport> {
  const { keepAlive = null, ...configOptions } = options;
  const config = resolveParserConfig(configOptions);
  const raw = await readContent(input, maxReportFileSize(config));
  const content: string | Uint8Array =
    startsWith(raw, MAGIC_ZIP) || startsWith(raw, MAGIC_GZIP)
      ? extractReport(raw)
      : raw;

  try {
    return {
      reportType: 'aggregate',
      report: await parseAggregateContent(content, config, keepAlive),
    };
  } catch (aggregateError) {
    if (!(aggregateError instanceof InvalidAggregateReport)) {
      throw aggregateError;
    }
    try {
      return {
        reportType: 'smtp_tls',
        report: parseSmtpTlsReportJson(content, config),
      };
    } catch (smtpTlsError) {
      if (!(smtpTlsError instanceof InvalidSMTPTLSReport)) {
        throw smtpTlsError;
      }
      try {
        return await parseReportEmail(content, { config, keepAlive });
      } catch (emailError) {
        if (!(emailError instanceof InvalidDMARCReport)) {
          throw emailError;
        }
        throw new ParserError(
          describeParseFailure(
            content,
            aggregateError,
            smtpTlsError,
            emailError,
          ),
          { cause: emailError },
        );
      }
    }
  }
}

/**
 * Worker job that parses one report file (parsedmarc's
 * `parallel._parse_report_file_job`). Any error is returned with the path
 * instead of being thrown, so the caller can log it and move on.
 */
export async function parseReportFileJob(
  filePath: string,
  options: { config: ParserConfig },
): Promise<[string, ParsedReport | Error]> {
  try {
    return [
      filePath,
      await parseReportFile(filePath, { config: options.config }),
    ];
  } catch (error) {
    return [
      filePath,
      error instanceof Error ? error : new Error(String(error)),
    ];
  }
}

/** The error for an mbox message over `maxEmailSize`, or `null`. */
function mboxMessageTooLarge(
  mbox: MboxReader,
  key: number,
  config: ParserConfig,
): EmailTooLargeError | null {
  const size = mbox.size(key);
  if (config.maxEmailSize > 0 && size > config.maxEmailSize) {
    return emailTooLargeError(size, config.maxEmailSize);
  }
  return null;
}

/**
 * An mbox message that failed to parse is logged and skipped. Unlike
 * parsedmarc, where any `ParserError` but `InvalidDMARCReport` ends the run
 * and loses the reports already parsed, whatever the rest of the file holds:
 * one bad attachment is such an error. A worker that crashed or timed out on
 * a message is skipped the same way. An {@link EnrichmentError} (an unusable
 * IP database, a revoked IPinfo token) ends the run instead: it would skip
 * every message.
 */
function handleMboxError(error: unknown, index: number): void {
  // Not the message's fault: every other one would fail too.
  const enrichmentError = findEnrichmentError(error);
  if (enrichmentError !== null) {
    throw enrichmentError;
  }
  if (error instanceof InvalidDMARCReport) {
    logger.warning(sanitizeForLog(error.message));
    return;
  }
  const name = error instanceof Error ? error.name : 'Error';
  logger.warning(
    sanitizeForLog(
      `Skipping message ${index + 1}: ${name}: ${errorText(error)}`,
    ),
  );
}

/** Options of {@link getDmarcReportsFromMbox}. */
export interface GetDmarcReportsFromMboxOptions extends ParserConfigInput {
  /**
   * Worker threads used to parse messages in parallel (not part of
   * `config`). Reading, dedup and result assembly stay in the caller.
   */
  nProcs?: number;
}

/**
 * Parses an mbox file containing emails with attached DMARC and SMTP TLS
 * reports. Each message's stored bytes are parsed. A message that can't be
 * parsed or is over `maxEmailSize` is logged as a warning and skipped.
 * Duplicate aggregate reports are dropped using the config's seen-report
 * cache.
 */
export async function getDmarcReportsFromMbox(
  input: string,
  options: GetDmarcReportsFromMboxOptions = {},
): Promise<ParsingResults> {
  const { nProcs = 1, ...configOptions } = options;
  const config = resolveParserConfig(configOptions);
  const aggregateReports: AggregateReport[] = [];
  const failureReports: FailureReport[] = [];
  const smtpTlsReports: SMTPTLSReport[] = [];
  const classify = (parsedEmail: ParsedReport): void => {
    classifyParsedEmail(
      parsedEmail,
      aggregateReports,
      failureReports,
      smtpTlsReports,
      { seenAggregateReportIds: config.seenAggregateReportIds },
    );
  };

  const mbox = await MboxReader.open(input);
  try {
    const messageKeys = mbox.keys();
    const totalMessages = messageKeys.length;
    logger.debug(`Found ${totalMessages} messages in ${input}`);

    if (nProcs > 1 && totalMessages > 1) {
      // Positions of the messages sent to workers, oldest first.
      const positions: number[] = [];
      async function* jobs(): AsyncGenerator<Uint8Array> {
        for (const [index, key] of messageKeys.entries()) {
          logger.info(`Processing message ${index + 1} of ${totalMessages}`);
          const tooLarge = mboxMessageTooLarge(mbox, key, config);
          if (tooLarge !== null) {
            handleMboxError(tooLarge, index);
            continue;
          }
          const content = await mbox.getBytes(key);
          positions.push(index);
          yield content;
        }
      }
      for await (const result of parallelMap<
        Uint8Array,
        ParsedReport | ParserError | Error
      >(parseReportEmailTask(config), jobs(), nProcs, {
        onJobError: error =>
          error instanceof Error ? error : new Error(String(error)),
      })) {
        const index = positions.shift() ?? 0;
        if (result instanceof Error) {
          handleMboxError(result, index);
        } else {
          classify(result);
        }
      }
    } else {
      for (const [index, key] of messageKeys.entries()) {
        logger.info(`Processing message ${index + 1} of ${totalMessages}`);
        const tooLarge = mboxMessageTooLarge(mbox, key, config);
        if (tooLarge !== null) {
          handleMboxError(tooLarge, index);
          continue;
        }
        const messageContent = await mbox.getBytes(key);
        let parsedEmail: ParsedReport;
        try {
          parsedEmail = await parseReportEmail(messageContent, { config });
        } catch (error) {
          handleMboxError(error, index);
          continue;
        }
        classify(parsedEmail);
      }
    }
  } finally {
    await mbox.close();
  }
  // parsedmarc maps mailbox.NoSuchMailboxError to InvalidDMARCReport, but
  // mailbox.mbox() creates missing files, so that branch never runs.
  return { aggregateReports, failureReports, smtpTlsReports };
}
