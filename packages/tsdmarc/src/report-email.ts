// Report email parsing, ported from parsedmarc/__init__.py:
// `parse_report_email()`, `_decode_mime_payload()` and
// `_classify_parsed_email()`.
//
// The message is walked with the port of Python's `email` package (compat32)
// and mail-parser, so MIME structure, payload text and decoding match
// parsedmarc byte for byte.

import { createHash } from 'node:crypto';

import { parseAggregateReportXml, withKeepAlive } from './aggregate';
import {
  resolveParserConfig,
  type ParserConfig,
  type ParserConfigInput,
  type SeenAggregateReportIds,
} from './config';
import {
  EmailTooLargeError,
  emailTooLargeError,
  InvalidDMARCReport,
  InvalidFailureReport,
  ParserError,
} from './errors';
import { extractReport, MAX_DECOMPRESSED_REPORT_SIZE } from './extract';
import { EMAIL_SAMPLE_CONTENT_TYPES, parseFailureReport } from './failure';
import { MAGIC_GZIP, MAGIC_ZIP, startsWith } from './internal/magic';
import {
  errorText,
  excOrigin,
  KeyError,
  noAttribute,
  PyIndexError,
} from './internal/py';
import { logger } from './log';
import { parseSmtpTlsReportJson } from './smtp-tls';
import type {
  AggregateReport,
  FailureReport,
  ParsedReport,
  ReportType,
  SMTPTLSReport,
} from './types';
import { PyDateTime } from './utils/datetime';
import { convertOutlookMsg, isOutlookMsg } from './utils/email';
import { MailParser } from './utils/mailparser/core';
import { a2bQp, b64decode, BinasciiError } from './utils/py-binascii';
import { LookupError, pyDecode, pyEncode } from './utils/py-codecs';
import {
  MissingHeaderBodySeparatorDefect,
  RecursionError,
} from './utils/py-email/errors';
import { FlattenCache } from './utils/py-email/generator';
import { Message } from './utils/py-email/message';
import {
  MESSAGE_FROM_STRING_MAX_NESTING,
  messageFromString,
} from './utils/py-email/parser';
import { pyLStrip, pyRStrip, pyStrip } from './utils/py-str';
import { pyStr } from './utils/python';
import { sanitizeForLog } from './utils/sanitize';
import { decodeUtf8 } from './utils/text';
import { humanTimestampToDatetime } from './utils/timestamps';

/**
 * parsedmarc's `text_report_regex`: `Name: value` fields of a legacy
 * plain-text failure notice. Anchored at line starts (`(?<![^\n])` is
 * Python's `^` under `re.MULTILINE`, which, unlike JS's `m` flag, does not
 * treat `\r` as a line break); the classes are disjoint so it runs in linear
 * time (GHSA-7grx-mj6g-qxmc).
 */
export const TEXT_REPORT_REGEX: RegExp =
  /(?<![^\n])[ \t]*([A-Za-z]+(?: [A-Za-z]+)*):[ \t]+([^\r\n]+)/gu;

const FAILURE_NOTICE = 'A message claiming to be from you has failed';

/** Python's `repr(bytes)`, e.g. `b'abc\n'`. */
function bytesRepr(data: Uint8Array): string {
  const hasSingle = data.includes(0x27);
  const quote = hasSingle && !data.includes(0x22) ? '"' : "'";
  const quoteByte = quote.charCodeAt(0);
  let body = '';
  for (const byte of data) {
    if (byte === quoteByte || byte === 0x5c) {
      body += `\\${String.fromCharCode(byte)}`;
    } else if (byte === 0x09) {
      body += '\\t';
    } else if (byte === 0x0a) {
      body += '\\n';
    } else if (byte === 0x0d) {
      body += '\\r';
    } else if (byte >= 0x20 && byte < 0x7f) {
      body += String.fromCharCode(byte);
    } else {
      body += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return `b${quote}${body}${quote}`;
}

/**
 * Python's `base64.b64decode(text)` (non-strict), or `null` where Python
 * raises `binascii.Error` / `ValueError` (bad padding, non-ASCII text).
 */
function lenientB64decode(text: string): Uint8Array | null {
  try {
    return b64decode(text);
  } catch (error) {
    if (error instanceof BinasciiError || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Python's `email.utils.format_datetime(dt)`. */
export function formatDatetime(datetime: PyDateTime): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  let zone = '-0000';
  if (datetime.utcOffsetMinutes !== null) {
    const offset = datetime.utcOffsetMinutes;
    const absolute = Math.abs(offset);
    zone = `${offset < 0 ? '-' : '+'}${two(Math.floor(absolute / 60))}${two(absolute % 60)}`;
  }
  const day = DAY_NAMES[datetime.weekday()] ?? '';
  const month = MONTH_NAMES[datetime.month - 1] ?? '';
  return `${day}, ${two(datetime.day)} ${month} ${String(datetime.year).padStart(4, '0')} ${two(datetime.hour)}:${two(datetime.minute)}:${two(datetime.second)} ${zone}`;
}

/**
 * Container levels (multipart or message parts) that `str(part)` can
 * flatten when parse_report_email is called from a module's top level.
 * `email.generator.Generator` recurses four Python frames per level
 * (`flatten`, `_write`, `_dispatch`, `_handle_multipart`), so a deeper part
 * exhausts CPython's default recursion limit (1000) and parse_report_email
 * and parse_report_file fail with a bare `RecursionError` (measured with
 * Python 3.14: a chain of 248 nested multiparts fails, 247 parses). Python's
 * exact limit shifts by one level per four frames of caller stack.
 */
export const STR_PART_MAX_NESTING = 246;

/** Each message's container height (0 for a leaf), computed without recursion. */
function containerHeights(root: Message): Map<Message, number> {
  const heights = new Map<Message, number>();
  const stack: [Message, boolean][] = [[root, false]];
  while (stack.length > 0) {
    const [message, childrenDone] = stack.pop() as [Message, boolean];
    const payload = message.getPayload();
    const children = Array.isArray(payload)
      ? payload.filter(child => child instanceof Message)
      : [];
    if (childrenDone) {
      let height = 0;
      for (const child of children) {
        height = Math.max(height, (heights.get(child) ?? 0) + 1);
      }
      heights.set(message, height);
      continue;
    }
    stack.push([message, true]);
    for (const child of children) {
      if (!heights.has(child)) {
        stack.push([child, false]);
      }
    }
  }
  return heights;
}

/**
 * Python's `str(value)` of a `get_payload()` item. `flattened` is shared
 * by the whole walk (nothing modifies the parts meanwhile): the first part
 * of every multipart is flattened once instead of once per ancestor. Each
 * item is asked for once, and reading it leaves a flat copy behind it, so
 * its text is dropped from the cache here.
 */
function payloadText(
  value: string | Message | null | undefined,
  heights: Map<Message, number>,
  flattened: FlattenCache,
): string {
  if (value instanceof Message) {
    if ((heights.get(value) ?? 0) > STR_PART_MAX_NESTING) {
      throw new RecursionError();
    }
    const text = value.asString(flattened);
    flattened.delete(value);
    return text;
  }
  return pyStr(value);
}

/**
 * Returns a MIME part's payload decoded per its Content-Transfer-Encoding
 * (parsedmarc's `_decode_mime_payload`).
 *
 * - Only quoted-printable and base64 parts are touched: the message was
 *   parsed from text, so 7bit/8bit parts have nothing to undo and return
 *   `fallback` (the payload text as-is).
 * - Nested `message/*` parts have no `decode=True` payload; the caller's
 *   re-serialization of the child message is `fallback`, and the transfer
 *   encoding is undone here. If parsing the still-encoded text recorded a
 *   MissingHeaderBodySeparatorDefect (a quoted-printable soft line break
 *   split a field), the blank line the parser inserted is dropped first.
 *
 * Any unexpected failure returns `fallback` unchanged.
 */
export function decodeMimePayload(part: Message, fallback: string): string {
  try {
    const cte = pyStrip(
      part.get('Content-Transfer-Encoding') ?? '',
    ).toLowerCase();
    if (cte !== 'quoted-printable' && cte !== 'base64') {
      return fallback;
    }

    const payloadBytes = part.getDecodedPayload();
    if (payloadBytes !== null) {
      const charset = part.getContentCharset() || 'utf-8';
      try {
        return pyDecode(payloadBytes, charset, 'replace');
      } catch (error) {
        if (error instanceof LookupError) {
          return pyDecode(payloadBytes, 'utf-8', 'replace');
        }
        throw error;
      }
    }

    let text = fallback;
    let child: unknown = part.getPayload();
    if (Array.isArray(child) && child.length > 0) {
      child = child[0];
    }
    if (
      child instanceof Message &&
      child.defects.some(
        defect => defect instanceof MissingHeaderBodySeparatorDefect,
      )
    ) {
      text = fallback.replace('\n\n', '\n');
    }

    if (cte === 'quoted-printable') {
      return pyDecode(
        a2bQp(pyEncode(text, 'utf-8', 'replace')),
        'utf-8',
        'replace',
      );
    }
    return decodeUtf8(b64decode(text), 'replace');
  } catch {
    return fallback;
  }
}

/** The size of an email in bytes (UTF-8 for text). */
export function emailByteLength(input: string | Uint8Array): number {
  return typeof input === 'string'
    ? Buffer.byteLength(input, 'utf8')
    : input.byteLength;
}

const DASH = 0x2d;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const LINE_STARTS_WITH_DASHES = /(?:\r\n?|\n)--/gu;

/**
 * Lines starting with `--` (every MIME boundary line does), counting up to
 * `stopAfter + 1`. The parser also ends a line at a lone CR.
 */
function countBoundaryLines(
  input: string | Uint8Array,
  stopAfter: number,
): number {
  let count = 0;
  if (typeof input === 'string') {
    count = input.startsWith('--') ? 1 : 0;
    LINE_STARTS_WITH_DASHES.lastIndex = 0;
    while (count <= stopAfter && LINE_STARTS_WITH_DASHES.test(input)) {
      count += 1;
    }
    return count;
  }
  let atLineStart = true;
  for (let index = 0; index < input.length - 1; index += 1) {
    const byte = input[index];
    if (atLineStart && byte === DASH && input[index + 1] === DASH) {
      count += 1;
      if (count > stopAfter) {
        return count;
      }
    }
    atLineStart = byte === LINE_FEED || byte === CARRIAGE_RETURN;
  }
  return count;
}

/**
 * Throw {@link EmailTooLargeError} when an email is over the config's
 * `maxEmailSize` bytes or has more than `maxMimeParts` MIME boundary
 * lines. Both checks are linear and run before any parsing; the parser then
 * counts the parts that need no boundary line, see `messageFromString()`.
 */
export function checkEmailLimits(
  input: string | Uint8Array,
  config: Pick<ParserConfig, 'maxEmailSize' | 'maxMimeParts'>,
): void {
  const { maxEmailSize, maxMimeParts } = config;
  if (maxEmailSize > 0) {
    const size = emailByteLength(input);
    if (size > maxEmailSize) {
      throw emailTooLargeError(size, maxEmailSize);
    }
  }
  if (
    maxMimeParts > 0 &&
    countBoundaryLines(input, maxMimeParts) > maxMimeParts
  ) {
    throw new EmailTooLargeError(
      `Email has more than ${maxMimeParts} MIME boundary lines (max_mime_parts)`,
    );
  }
}

/** Options of {@link parseReportEmail}. */
export interface ParseReportEmailOptions extends ParserConfigInput {
  /** Keep-alive callback for large aggregate reports (not part of `config`). */
  keepAlive?: (() => unknown) | null;
}

interface DecodedInput {
  text: string;
  headers: Record<string, unknown>;
  msgDate: PyDateTime;
  date: string;
  message: Message;
}

async function readInput(
  input: string | Uint8Array,
  config: ParserConfig,
): Promise<DecodedInput> {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (isOutlookMsg(input)) {
    // The limits checked so far were on the MSG, not on what it expands to.
    const converted = await convertOutlookMsg(input, config.maxEmailSize);
    checkEmailLimits(converted, config);
    text = decodeUtf8(converted, 'replace');
  } else {
    text = decodeUtf8(input, 'replace');
  }
  const headers = MailParser.fromString(text, config).headers as Record<
    string,
    unknown
  >;
  let msgDate = PyDateTime.now(true);
  if (Object.hasOwn(headers, 'Date')) {
    const value = headers.Date;
    if (typeof value !== 'string') {
      throw noAttribute(value, 'replace');
    }
    msgDate = humanTimestampToDatetime(value);
  }
  const date = formatDatetime(msgDate);
  return {
    text,
    headers,
    msgDate,
    date,
    message: messageFromString(text, MESSAGE_FROM_STRING_MAX_NESTING, config),
  };
}

/**
 * The legacy plain-text failure notice: build a feedback report from its
 * `Received Date` and `Sender IP Address` fields; the text after
 * `detected.` is the sample.
 */
function parseTextFailureNotice(
  payload: string,
  subjectText: string,
): { feedbackReport: string; sample: string } {
  const separator = payload.indexOf('detected.');
  const parts =
    separator === -1
      ? [payload]
      : [
          payload.slice(0, separator),
          payload.slice(separator + 'detected.'.length),
        ];
  let feedbackReport: string;
  try {
    const fields = new Map<string, string>();
    for (const match of (parts[0] ?? '').matchAll(TEXT_REPORT_REGEX)) {
      const fieldName = (match[1] ?? '').toLowerCase().replaceAll(' ', '-');
      fields.set(fieldName, pyStrip(match[2] ?? ''));
    }
    const field = (name: string): string => {
      const value = fields.get(name);
      if (value === undefined) {
        throw new KeyError(name);
      }
      return value;
    };
    feedbackReport = `Arrival-Date: ${field('received-date')}\nSource-IP: ${field('sender-ip-address')}`;
  } catch (error) {
    throw new InvalidDMARCReport(
      `Unable to parse message with subject "${subjectText}": ${errorText(error)}${excOrigin(error)}`,
      { cause: error },
    );
  }
  const rest = parts[1];
  if (rest === undefined) {
    // Python's `parts[1]` on a one-element list.
    throw new PyIndexError('list index out of range');
  }
  const sample = pyLStrip(rest);
  logger.debug(sanitizeForLog(sample));
  return { feedbackReport, sample };
}

/** The `message/feedback-report` part's text, base64-decoded if needed. */
function feedbackReportText(decodedPayload: string): string {
  let report: string;
  if (decodedPayload.includes('Feedback-Type')) {
    report = decodedPayload;
  } else {
    const decoded = lenientB64decode(decodedPayload);
    if (decoded === null) {
      return decodedPayload;
    }
    // parsedmarc formats the bytes with repr() and strips the b'...'.
    report = bytesRepr(decoded);
  }
  report = pyRStrip(pyLStrip(report, "b'"), "'");
  return report.replaceAll('\\r', '').replaceAll('\\n', '\n');
}

/**
 * Parses a DMARC or SMTP TLS report from an email (RFC 822 bytes or text).
 *
 * Throws {@link ParserError} when the email can't be read,
 * {@link InvalidDMARCReport} when it holds no valid report, and
 * {@link InvalidFailureReport} when its failure report is invalid. Throws
 * {@link EmailTooLargeError} when the email is over the config's
 * `maxEmailSize`, `maxMimeParts`, `maxHeaderLines` or `maxExpandedEmailSize`
 * (not in parsedmarc). Whatever the input, only `ParserError` subclasses are
 * thrown, apart from what `keepAlive` throws: that is rethrown as is, since
 * it says nothing about the email (parsedmarc reports a `ParserError`).
 */
export async function parseReportEmail(
  input: string | Uint8Array,
  options: ParseReportEmailOptions = {},
): Promise<ParsedReport> {
  const { keepAlive = null, ...configOptions } = options;
  const config = resolveParserConfig(configOptions);
  return withKeepAlive(keepAlive, async tracked =>
    parseEmail(input, config, tracked),
  );
}

async function parseEmail(
  input: string | Uint8Array,
  config: ParserConfig,
  keepAlive: (() => unknown) | null,
): Promise<ParsedReport> {
  checkEmailLimits(input, config);

  let decoded: DecodedInput;
  try {
    decoded = await readInput(input, config);
  } catch (error) {
    if (error instanceof EmailTooLargeError) {
      throw error;
    }
    throw new ParserError(errorText(error) + excOrigin(error), {
      cause: error,
    });
  }
  const { headers, msgDate, date, message } = decoded;

  let subjectText = 'None';
  let feedbackReport: string | null = null;
  let sample: string | null = null;
  if (Object.hasOwn(headers, 'From')) {
    logger.info(
      `Parsing mail from ${sanitizeForLog(pyStr(headers.From))} on ${date}`,
    );
  }
  if (Object.hasOwn(headers, 'Subject')) {
    // RFC 2047 decoding can yield raw CR/LF, so escape control characters
    // before the subject reaches an error message or log.
    subjectText = sanitizeForLog(pyStr(headers.Subject));
  }

  // Serializing a part (`str(payload_obj[0])`) re-renders any message/rfc822
  // sub-message, which can throw e.g. HeaderWriteError on a control
  // character in a header or RecursionError on deeply nested multiparts.
  // Callers rely on this function throwing only ParserError subclasses, so
  // that one bad message is skipped (and moved to Invalid) rather than
  // aborting a whole mailbox batch (GHSA-qxwv-2vwj-v828).
  try {
    const result = await walkMessage(message, subjectText, config, keepAlive);
    if ('reportType' in result) {
      return result;
    }
    ({ feedbackReport, sample } = result);
  } catch (error) {
    if (error instanceof ParserError) {
      throw error;
    }
    throw new ParserError(
      `Unable to parse message with subject "${subjectText}": ${errorText(error)}${excOrigin(error)}`,
      { cause: error },
    );
  }

  if (feedbackReport && sample) {
    let failureReport: FailureReport;
    try {
      failureReport = await parseFailureReport(
        feedbackReport,
        sample,
        msgDate,
        { config },
      );
    } catch (error) {
      if (error instanceof InvalidFailureReport) {
        throw new InvalidFailureReport(
          `Message with subject "${subjectText}" is not a valid failure DMARC report: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    return { reportType: 'failure', report: failureReport };
  }

  // Every branch that finds a report returns, so reaching this point always
  // means no report was found.
  throw new InvalidDMARCReport(
    `Message with subject "${subjectText}" is not a valid report`,
  );
}

interface FailureParts {
  feedbackReport: string | null;
  sample: string | null;
}

/**
 * parse_report_email's walk over the message parts: the first SMTP TLS or
 * aggregate report found, else the failure report and sample collected.
 */
async function walkMessage(
  message: Message,
  subjectText: string,
  config: ParserConfig,
  keepAlive: (() => unknown) | null,
): Promise<ParsedReport | FailureParts> {
  let feedbackReport: string | null = null;
  let sample: string | null = null;
  let isFeedbackReport = false;
  const heights = containerHeights(message);
  const flattened = new FlattenCache(config.maxExpandedEmailSize);
  const decompressed: DecompressedBudget = { size: 0 };
  for (const part of message.walk()) {
    const contentType = part.getContentType().toLowerCase();
    const payloadObject = part.getPayload();
    const payloadList = Array.isArray(payloadObject)
      ? payloadObject
      : [payloadObject];
    if (payloadList.length === 0) {
      throw new PyIndexError('list index out of range');
    }
    let payload = payloadText(payloadList[0], heights, flattened);
    if (contentType.startsWith('multipart/') || contentType === 'text/html') {
      continue;
    }
    if (contentType === 'message/feedback-report') {
      isFeedbackReport = true;
      feedbackReport = feedbackReportText(decodeMimePayload(part, payload));
    } else if (
      isFeedbackReport &&
      EMAIL_SAMPLE_CONTENT_TYPES.includes(contentType)
    ) {
      sample = decodeMimePayload(part, payload);
    } else if (contentType === 'application/tlsrpt+json') {
      if (!pyStrip(payload).startsWith('{')) {
        payload = decodeUtf8(b64decode(payload), 'replace');
      }
      return {
        reportType: 'smtp_tls',
        report: parseSmtpTlsReportJson(payload, config),
      };
    } else if (contentType === 'application/tlsrpt+gzip') {
      return {
        reportType: 'smtp_tls',
        report: parseSmtpTlsReportJson(extractReport(payload), config),
      };
    } else if (contentType === 'text/plain') {
      if (payload.includes(FAILURE_NOTICE)) {
        ({ feedbackReport, sample } = parseTextFailureNotice(
          payload,
          subjectText,
        ));
      }
    } else {
      const result = await parseAttachment(
        payload,
        subjectText,
        config,
        keepAlive,
        decompressed,
      );
      if (result !== null) {
        return result;
      }
    }
  }
  return { feedbackReport, sample };
}

/**
 * The bytes decompressed from one email's attachments so far. Each one is
 * capped at {@link MAX_DECOMPRESSED_REPORT_SIZE}, and so are all of them
 * together (not in parsedmarc): a part that decompresses to something that
 * is not a report lets the walk go on to the next one, so with only a cap
 * per part, a 50 MiB email of 700 small gzip parts took minutes of CPU.
 */
interface DecompressedBudget {
  size: number;
}

/**
 * Any other part: a base64 attachment holding an aggregate (XML) or SMTP
 * TLS (JSON) report, possibly zipped or gzipped. `null` when the part is
 * not base64 or holds neither, so the walk continues.
 */
async function parseAttachment(
  payload: string,
  subjectText: string,
  config: ParserConfig,
  keepAlive: (() => unknown) | null,
  decompressed: DecompressedBudget = { size: 0 },
): Promise<ParsedReport | null> {
  const payloadBytes = lenientB64decode(payload);
  if (payloadBytes === null) {
    // Not base64, so not a report attachment.
    return null;
  }
  try {
    const payloadText =
      startsWith(payloadBytes, MAGIC_ZIP) ||
      startsWith(payloadBytes, MAGIC_GZIP)
        ? extractReport(payloadBytes, {
            onDecompressed: size => {
              decompressed.size += size;
            },
          })
        : decodeUtf8(payloadBytes, 'replace');
    const stripped = pyStrip(payloadText);
    if (stripped.startsWith('{')) {
      return {
        reportType: 'smtp_tls',
        report: parseSmtpTlsReportJson(payloadText, config),
      };
    }
    if (stripped.startsWith('<')) {
      return {
        reportType: 'aggregate',
        report: await parseAggregateReportXml(payloadText, {
          config,
          keepAlive,
        }),
      };
    }
    // Not a report: the walk goes on, if the email has decompressed
    // little enough so far.
    if (decompressed.size > MAX_DECOMPRESSED_REPORT_SIZE) {
      throw new EmailTooLargeError(
        `Email attachments decompress to more than ${MAX_DECOMPRESSED_REPORT_SIZE} bytes`,
      );
    }
    return null;
  } catch (error) {
    if (error instanceof EmailTooLargeError) {
      throw error;
    }
    if (error instanceof InvalidDMARCReport) {
      throw new ParserError(
        `Message with subject "${subjectText}" is not a valid DMARC report: ${error.message}`,
        { cause: error },
      );
    }
    throw new ParserError(
      `Unable to parse message with subject "${subjectText}": ${errorText(error)}${excOrigin(error)}`,
      { cause: error },
    );
  }
}

/**
 * Worker job that parses one report email (parsedmarc's
 * `parallel._parse_report_email_job`). A {@link ParserError} is returned as
 * a value, never thrown, so one invalid message needs no special handling.
 * `parseReportEmail` throws only `ParserError` subclasses, whatever the
 * input, so no other error is expected from here.
 */
export async function parseReportEmailJob(
  messageContent: string | Uint8Array,
  options: { config: ParserConfig },
): Promise<ParsedReport | ParserError> {
  try {
    return await parseReportEmail(messageContent, { config: options.config });
  } catch (error) {
    if (error instanceof ParserError) {
      return error;
    }
    throw error;
  }
}

/** Longest dedup key kept as is; any longer is stored as its hash. */
const MAX_REPORT_KEY_LENGTH = 1024;
const ASCII_UPPERCASE = /[A-Z]+/gu;

/** A key field as JSON can hold it: strings and null as is, anything else as `str()`. */
function keyField(value: unknown): string | null {
  if (typeof value === 'string' || value === null || value === undefined) {
    return value ?? null;
  }
  return pyStr(value);
}

/**
 * The dedup key of an aggregate report (parsedmarc's
 * `_aggregate_report_dedup_key()`): RFC 9990 section 3.5.1 defines a
 * Report-ID as unique only "among reports to the same domain", so the key
 * is the reporter, the Report-ID and the policy domain, as a JSON array
 * (no delimiter a field could contain). ASCII letters of the domain are
 * compared without case (RFC 4343 section 3); the report is unchanged.
 * Every writer of the seen report ID cache (mbox, mailbox, the CLI's
 * direct files) must use it. The key outlives parsing in that cache and
 * every part comes from the sender, so a long one is replaced by its hash
 * (parsedmarc keeps it whole).
 */
export function aggregateReportKey(report: AggregateReport): string {
  const { reportMetadata, policyPublished } = report;
  let domain = keyField(policyPublished.domain);
  // The XML parser returns null for an empty <domain/>.
  if (typeof domain === 'string') {
    domain = domain.replaceAll(ASCII_UPPERCASE, letters =>
      letters.toLowerCase(),
    );
  }
  const key = JSON.stringify([
    keyField(reportMetadata.orgName),
    keyField(reportMetadata.reportId),
    domain,
  ]);
  return key.length > MAX_REPORT_KEY_LENGTH
    ? createHash('sha256').update(key).digest('hex')
    : key;
}

/** Options of {@link classifyParsedEmail}. */
export interface ClassifyParsedEmailOptions {
  /** Seen aggregate report keys ({@link aggregateReportKey}) used for dedup. */
  seenAggregateReportIds: SeenAggregateReportIds;
  /**
   * When given, newly seen aggregate keys are staged here instead of being
   * written to `seenAggregateReportIds` (the caller commits them once the
   * batch is saved); dedup checks both.
   */
  pendingAggregateKeys?: Set<string> | null;
}

/**
 * Append a parsed report email to the list for its type, dropping
 * aggregate reports already seen (parsedmarc's `_classify_parsed_email`).
 * Returns the report type.
 */
export function classifyParsedEmail(
  parsedEmail: ParsedReport,
  aggregateReports: AggregateReport[],
  failureReports: FailureReport[],
  smtpTlsReports: SMTPTLSReport[],
  options: ClassifyParsedEmailOptions,
): ReportType {
  const { seenAggregateReportIds, pendingAggregateKeys = null } = options;
  if (parsedEmail.reportType === 'aggregate') {
    const reportOrg = parsedEmail.report.reportMetadata.orgName;
    const reportId = parsedEmail.report.reportMetadata.reportId;
    const reportKey = aggregateReportKey(parsedEmail.report);
    const alreadySeen =
      seenAggregateReportIds.has(reportKey) ||
      (pendingAggregateKeys !== null && pendingAggregateKeys.has(reportKey));
    if (alreadySeen) {
      logger.debug(
        `Skipping duplicate aggregate report from ${sanitizeForLog(pyStr(reportOrg))} with ID: ${sanitizeForLog(pyStr(reportId))}`,
      );
    } else {
      if (pendingAggregateKeys === null) {
        seenAggregateReportIds.set(reportKey, true);
      } else {
        pendingAggregateKeys.add(reportKey);
      }
      aggregateReports.push(parsedEmail.report);
    }
  } else if (parsedEmail.reportType === 'failure') {
    failureReports.push(parsedEmail.report);
  } else if (parsedEmail.reportType === 'smtp_tls') {
    smtpTlsReports.push(parsedEmail.report);
  }
  return parsedEmail.reportType;
}
