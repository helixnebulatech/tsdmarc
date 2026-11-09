// Email utilities, ported from parsedmarc/utils.py: `decode_base64`,
// `parse_email_address`, `get_filename_safe_string`, `is_mbox`,
// `is_outlook_msg`, `convert_outlook_msg` and `parse_email`.
//
// `parse_email()` builds its result from mail-parser's JSON. mail-parser and
// the Python `email` package it sits on are ported in `./mailparser` and
// `./py-email`, so the parsed sample of a failure report has the same
// content as parsedmarc's.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';

import type { EmailLimits } from '../config';
import { EmailParserError, emailTooLargeError } from '../errors';
import { PyValueError } from '../internal/py';
import { logger } from '../log';
import type { EmailAddress, ParsedEmail } from '../types';
import { defineKey, MailParser } from './mailparser/core';
import { b64decode } from './py-binascii';
import { pyDecode, pyEncode } from './py-codecs';
import { pyLen, pyRepr, pyRStrip, pySliceStart } from './py-str';

/**
 * Python's `ValueError` (raised by {@link convertOutlookMsg} and others):
 * the public name of the core's one `PyValueError` class.
 */
export { PyValueError as ValueError } from '../internal/py';

/**
 * Decodes a base64 string, with padding being optional.
 *
 * Throws `UnicodeEncodeError` for non-ASCII input and `binascii.Error`
 * (`BinasciiError`) for undecodable data, like Python.
 */
export function decodeBase64(data: string): Uint8Array {
  const bytes = pyEncode(data, 'ascii');
  const missingPadding = bytes.length % 4;
  if (missingPadding === 0) {
    return b64decode(bytes);
  }
  const padded = new Uint8Array(bytes.length + 4 - missingPadding).fill(0x3d);
  padded.set(bytes, 0);
  return b64decode(padded);
}

/**
 * Builds an address dict from a `(display_name, address)` pair, as
 * mail-parser returns them.
 */
export function parseEmailAddress(
  originalAddress: readonly [string, string] | readonly string[],
): EmailAddress {
  const name = originalAddress[0];
  const displayName = name === '' ? null : (name ?? null);
  const address = originalAddress[1] ?? '';
  const addressParts = address.split('@');
  let local: string | null = null;
  let domain: string | null = null;
  if (addressParts.length > 1) {
    local = (addressParts[0] ?? '').toLowerCase();
    domain = (addressParts.at(-1) ?? '').toLowerCase();
  }
  return { displayName, address, local, domain };
}

const INVALID_FILENAME_CHARS = [
  '\\',
  '/',
  ':',
  '"',
  '*',
  '?',
  '|',
  '\n',
  '\r',
  '\u0000',
];
const MAX_FILENAME_LENGTH = 100;
/**
 * Byte cap on top of the 100-character cap (GHSA-j53g-34vj-g25q):
 * filesystems limit a name to 255 bytes (eCryptfs: 143), and 100 bytes
 * leaves room for a ` (N)` suffix and an extension under every one of them.
 */
const MAX_FILENAME_BYTES = 100;
// Python's `encode("utf-8", errors="ignore")` drops lone surrogates.
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;
// Control characters (C0, DEL, C1) and bidi embedding, override and
// isolate marks, which can disguise a file name (`txt.exe` shown as
// `exe.txt`).
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const UNSAFE_FILENAME_CHARS = /[\0-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/gu;

const ONE_BYTE_MAX = 0x7f;
const TWO_BYTES_MAX = 0x7_ff;
const THREE_BYTES_MAX = 0xff_ff;

/** The UTF-8 length of a code point. */
function utf8Length(codePoint: number): number {
  if (codePoint <= ONE_BYTE_MAX) {
    return 1;
  }
  if (codePoint <= TWO_BYTES_MAX) {
    return 2;
  }
  return codePoint <= THREE_BYTES_MAX ? 3 : 4;
}

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes. */
function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += utf8Length(char.codePointAt(0) ?? 0);
    if (bytes > maxBytes) {
      return text.slice(0, end);
    }
    end += char.length;
  }
  return text;
}

/**
 * Converts a string to a string that is safe to use as a filename.
 *
 * The result is a single path component: no `/`, `\`, `:`, NUL, other
 * control characters or bidi marks, never ending in `.` or a space, never
 * `.` or `..`, and at most 100 characters and 100 UTF-8 bytes (cut on a
 * character boundary; lone surrogates are dropped), like parsedmarc. It can
 * be empty, so callers that need a name must supply a fallback. `null` is
 * treated as the literal string `"None"`.
 *
 * parsedmarc removes only `\ / : " * ? |`, CR, LF and NUL; the other control
 * characters and the bidi marks are a tsdmarc addition.
 */
export function getFilenameSafeString(value: string | null): string {
  let text = value ?? 'None';
  for (const char of INVALID_FILENAME_CHARS) {
    text = text.replaceAll(char, '');
  }
  text = text.replaceAll(UNSAFE_FILENAME_CHARS, '');
  // Truncate before stripping, so a cut name cannot end in a dot or space.
  if (pyLen(text) > MAX_FILENAME_LENGTH) {
    text = pySliceStart(text, MAX_FILENAME_LENGTH);
  }
  text = truncateUtf8(text.replaceAll(LONE_SURROGATE, ''), MAX_FILENAME_BYTES);
  return pyRStrip(text, '. ');
}

// Python's OSError text for the errors `open()` raises most often.
const ERRNO_TEXT: Readonly<Record<string, [number, string]>> = {
  EACCES: [13, 'Permission denied'],
  EISDIR: [21, 'Is a directory'],
  ENOENT: [2, 'No such file or directory'],
  ENOTDIR: [20, 'Not a directory'],
};

function osErrorText(error: unknown, path: string): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    const known = ERRNO_TEXT[error.code];
    if (known !== undefined) {
      return `[Errno ${known[0]}] ${known[1]}: ${pyRepr(path)}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// mailbox.mbox counts one message per line that starts with "From ".
async function hasFromLine(path: string): Promise<boolean> {
  const stream = createReadStream(path);
  let atLineStart = true;
  let carry = '';
  try {
    for await (const chunk of stream) {
      const text = carry + Buffer.from(chunk as Uint8Array).toString('latin1');
      for (let index = 0; index < text.length; index += 1) {
        if (atLineStart && text.startsWith('From ', index)) {
          return true;
        }
        if (
          atLineStart &&
          index + 5 > text.length &&
          'From '.startsWith(text.slice(index))
        ) {
          carry = text.slice(index);
          break;
        }
        atLineStart = text.charAt(index) === '\n';
        carry = '';
      }
    }
  } finally {
    stream.destroy();
  }
  return false;
}

/**
 * Checks if the file at the given path is an mbox mailbox file (it holds at
 * least one message). Errors are logged at debug level and give `false`.
 */
export async function isMbox(path: string): Promise<boolean> {
  try {
    return await hasFromLine(path);
  } catch (error) {
    logger.debug(`Error checking for MBOX file: ${osErrorText(error, path)}`);
    return false;
  }
}

const OUTLOOK_MAGIC = Uint8Array.of(
  0xd0,
  0xcf,
  0x11,
  0xe0,
  0xa1,
  0xb1,
  0x1a,
  0xe1,
);

/** Checks if the given content is an Outlook msg OLE/MSG file. */
export function isOutlookMsg(content: unknown): boolean {
  if (
    !(content instanceof Uint8Array) ||
    content.length < OUTLOOK_MAGIC.length
  ) {
    return false;
  }
  return OUTLOOK_MAGIC.every((byte, index) => content[index] === byte);
}

/** How long `msgconvert` may run before it is killed (milliseconds). */
export const MSGCONVERT_TIMEOUT_MS = 60_000;

/** Python's `subprocess.CalledProcessError`. */
export class CalledProcessError extends Error {
  override name = 'CalledProcessError';
}

const MSGCONVERT_COMMAND = "['msgconvert', 'sample.msg']";

/**
 * `subprocess.check_call(["msgconvert", "sample.msg"], stdout=DEVNULL,
 * stderr=DEVNULL)`: output is discarded (never buffered), plus a timeout.
 */
function runMsgconvert(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const settle = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    const child = spawn('msgconvert', ['sample.msg'], {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, MSGCONVERT_TIMEOUT_MS);
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        settle(
          new EmailParserError(
            'Failed to convert Outlook MSG: msgconvert utility not found',
          ),
        );
        return;
      }
      settle(error);
    });
    child.once(
      'close',
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          settle(
            new EmailParserError(
              `Failed to convert Outlook MSG: msgconvert did not finish within ${MSGCONVERT_TIMEOUT_MS / 1000}s`,
            ),
          );
        } else if (signal !== null) {
          const number = osConstants.signals[signal];
          settle(
            new CalledProcessError(
              `Command '${MSGCONVERT_COMMAND}' died with <Signals.${signal}: ${number}>.`,
            ),
          );
        } else if (code === 0) {
          settle(null);
        } else {
          settle(
            new CalledProcessError(
              `Command '${MSGCONVERT_COMMAND}' returned non-zero exit status ${String(code)}.`,
            ),
          );
        }
      },
    );
  });
}

/**
 * Uses the `msgconvert` Perl utility to convert an Outlook MSG file to
 * standard RFC 822 format.
 *
 * Throws {@link ValueError} when the bytes are not an Outlook MSG file and
 * {@link EmailParserError} when `msgconvert` is not installed (or, unlike
 * parsedmarc, runs longer than {@link MSGCONVERT_TIMEOUT_MS}). Throws
 * `EmailTooLargeError` when `maxSize` is not 0 and the converted message is
 * larger, before reading it: a small MSG can expand a lot.
 */
export async function convertOutlookMsg(
  msgBytes: Uint8Array,
  maxSize = 0,
): Promise<Uint8Array> {
  if (!isOutlookMsg(msgBytes)) {
    throw new PyValueError('The supplied bytes are not an Outlook MSG file');
  }
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'tsdmarc-'));
  try {
    await writeFile(path.join(tmpDir, 'sample.msg'), msgBytes);
    await runMsgconvert(tmpDir);
    const converted = path.join(tmpDir, 'sample.eml');
    try {
      if (maxSize > 0) {
        const { size } = await stat(converted);
        if (size > maxSize) {
          throw emailTooLargeError(size, maxSize);
        }
      }
      return new Uint8Array(await readFile(converted));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EmailParserError(
          'Failed to convert Outlook MSG: msgconvert utility not found',
        );
      }
      throw error;
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Options of {@link parseEmail}. */
export interface ParseEmailOptions {
  /** Remove attachment payloads. */
  stripAttachmentPayloads?: boolean;
  /** Limits on the message's structure (not in parsedmarc). */
  limits?: EmailLimits;
}

type PyDict = Record<string, unknown>;

function isRecord(value: unknown): value is PyDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `parse_email()` on mail-parser's JSON, exactly as parsedmarc does it.
 * Returns the snake_case dict that parsedmarc returns.
 */
function postProcess(
  parser: MailParser,
  stripAttachmentPayloads: boolean,
): PyDict {
  const headers = parser.headers;
  const parsed = parser.mail;
  parsed.headers = headers;

  if (Array.isArray(parsed.received)) {
    for (const received of parsed.received as PyDict[]) {
      if ('date_utc' in received) {
        if (received.date_utc === null) {
          delete received.date_utc;
        } else {
          received.date_utc = String(received.date_utc).replaceAll('T', ' ');
        }
      }
    }
  }

  if (!('from' in parsed)) {
    // mail-parser omits "from" when the From header is present but
    // unparseable; the headers may still carry an empty "From" list.
    const fromHeader = (headers as PyDict).From;
    parsed.from = isTruthyValue(fromHeader) ? fromHeader : null;
  }
  if (parsed.from !== null && parsed.from !== undefined) {
    const first = (parsed.from as unknown[])[0];
    parsed.from = parseEmailAddress(first as [string, string]);
  }

  parsed.date =
    typeof parsed.date === 'string' ? parsed.date.replaceAll('T', ' ') : null;

  // mail-parser names these headers with hyphens; parsedmarc renames them.
  if ('reply-to' in parsed) {
    parsed.reply_to = (parsed['reply-to'] as [string, string][]).map(
      parseEmailAddress,
    );
    delete parsed['reply-to'];
  } else {
    parsed.reply_to = [];
  }
  for (const key of ['to', 'cc', 'bcc']) {
    parsed[key] =
      key in parsed
        ? (parsed[key] as [string, string][]).map(parseEmailAddress)
        : [];
  }
  if ('delivered-to' in parsed) {
    parsed.delivered_to = (parsed['delivered-to'] as [string, string][]).map(
      parseEmailAddress,
    );
    delete parsed['delivered-to'];
  }

  if ('attachments' in parsed) {
    const attachments = parsed.attachments as PyDict[];
    for (const attachment of attachments) {
      if (!('payload' in attachment)) {
        continue;
      }
      const payload = String(attachment.payload);
      try {
        const bytes =
          attachment.content_transfer_encoding === 'base64'
            ? decodeBase64(payload)
            : pyEncode(payload, 'utf-8');
        attachment.sha256 = createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        logger.debug(`Unable to decode attachment: ${errorMessage(error)}`);
      }
    }
    if (stripAttachmentPayloads) {
      for (const attachment of attachments) {
        delete attachment.payload;
      }
    }
  } else {
    parsed.attachments = [];
  }

  if (!('subject' in parsed)) {
    parsed.subject = null;
  }
  if (Array.isArray(parsed.subject)) {
    // Several Subject headers: mail-parser returns a list, and parsedmarc's
    // get_filename_safe_string() fails on it (AttributeError).
    throw new TypeError("'list' object has no attribute 'replace'");
  }
  parsed.filename_safe_subject = getFilenameSafeString(
    parsed.subject === null ? null : String(parsed.subject),
  );
  if (!('body' in parsed)) {
    parsed.body = null;
  }
  return parsed;
}

function isTruthyValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

// snake_case keys of parse_email()'s output → the camelCase API. Every other
// key is a header name (or a computed name without underscores) and stays.
const TOP_LEVEL_KEYS: Readonly<Record<string, string>> = {
  address_header_defects: 'addressHeaderDefects',
  date_header_defects: 'dateHeaderDefects',
  defects_categories: 'defectsCategories',
  delivered_to: 'deliveredTo',
  filename_safe_subject: 'filenameSafeSubject',
  has_defects: 'hasDefects',
  received_header_defects: 'receivedHeaderDefects',
  reply_to: 'replyTo',
  to_domains: 'toDomains',
};
const RECEIVED_KEYS: Readonly<Record<string, string>> = {
  date_utc: 'dateUtc',
  envelope_from: 'envelopeFrom',
  envelope_sender: 'envelopeSender',
};
const ATTACHMENT_KEYS: Readonly<Record<string, string>> = {
  content_transfer_encoding: 'contentTransferEncoding',
  mail_content_type: 'mailContentType',
  safe_filename: 'safeFilename',
};
const CANDIDATE_KEYS: Readonly<Record<string, string>> = {
  display_name: 'displayName',
};

function renameKeys(
  value: unknown,
  mapping: Readonly<Record<string, string>>,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const result: PyDict = {};
  for (const [key, child] of Object.entries(value)) {
    defineKey(
      result,
      Object.hasOwn(mapping, key) ? (mapping[key] ?? key) : key,
      child,
    );
  }
  return result;
}

function toApiShape(parsed: PyDict): ParsedEmail {
  const result: PyDict = {};
  for (const [key, value] of Object.entries(parsed)) {
    let converted = value;
    if (key === 'received' && Array.isArray(value)) {
      converted = value.map(hop => renameKeys(hop, RECEIVED_KEYS));
    } else if (key === 'attachments' && Array.isArray(value)) {
      converted = value.map(attachment =>
        renameKeys(attachment, ATTACHMENT_KEYS),
      );
    } else if (key === 'address_header_defects' && Array.isArray(value)) {
      converted = value.map(defect => {
        const renamed = renameKeys(defect, {}) as PyDict;
        if (Array.isArray(renamed.candidates)) {
          renamed.candidates = renamed.candidates.map(candidate =>
            renameKeys(candidate, CANDIDATE_KEYS),
          );
        }
        return renamed;
      });
    }
    const apiKey = Object.hasOwn(TOP_LEVEL_KEYS, key)
      ? (TOP_LEVEL_KEYS[key] ?? key)
      : key;
    defineKey(result, apiKey, converted);
  }
  return result as unknown as ParsedEmail;
}

/**
 * A simplified email parser.
 *
 * `data` is the RFC 822 message text, or its bytes (Outlook MSG bytes are
 * converted with `msgconvert` first; other bytes are decoded as UTF-8 with
 * replacement). `toSnakeCaseKeys()` of the result is parsedmarc's
 * `parse_email()` output.
 */
export async function parseEmail(
  data: Uint8Array | string,
  options: ParseEmailOptions = {},
): Promise<ParsedEmail> {
  let text: string;
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    // What `email.message_from_string()` raises for other types.
    throw new TypeError(
      `initial_value must be str or None, not ${typeof data}`,
    );
  }
  if (typeof data === 'string') {
    // JavaScript strings may hold lone surrogates, Python's decoded text
    // cannot: replace them like a UTF-8 round trip would.
    text = data.toWellFormed();
  } else {
    const bytes = isOutlookMsg(data) ? await convertOutlookMsg(data) : data;
    text = pyDecode(bytes, 'utf-8', 'replace');
  }
  return parseEmailText(text, options);
}

/**
 * The synchronous part of {@link parseEmail}, for already-decoded text (no
 * Outlook MSG conversion).
 */
export function parseEmailText(
  text: string,
  options: ParseEmailOptions = {},
): ParsedEmail {
  const parser = MailParser.fromString(text, options.limits);
  return toApiShape(
    postProcess(parser, options.stripAttachmentPayloads ?? false),
  );
}
