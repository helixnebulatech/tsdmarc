// Port of mail-parser 4.8.0 (`mailparser/core.py` and the helpers of
// `mailparser/utils.py` it uses) for `parse_from_string()`.
//
// The output mirrors `json.loads(parser.mail_json)` and
// `json.loads(parser.headers_json)`: plain objects with mail-parser's own
// (snake_case / header-name) keys, address tuples as two-item arrays and
// datetimes as ISO strings. Python builds `mail` by iterating a `set`, so
// its key order (and the order of `to_domains` and `defects_categories`)
// varies between runs; here it is deterministic.

import { randomInt } from 'node:crypto';

import { DEFAULT_EMAIL_LIMITS, type EmailLimits } from '../../config';
import { getLogger } from '../../log';
import { b64encode } from '../py-binascii';
import { LookupError, pyDecode, UnicodeError } from '../py-codecs';
import { HeaderParseError, RecursionError } from '../py-email/errors';
import { FlattenCache } from '../py-email/generator';
import { decodeHeader } from '../py-email/header';
import { Message } from '../py-email/message';
import { messageFromString } from '../py-email/parser';
import type { AddressPair } from '../py-email/utils';
import { pyRepr, pyStrip } from '../py-str';
import { type AddressDiagnostic, getAddresses } from './addresses';
import {
  type DateDiagnostic,
  dateDiagnostics,
  parseMailDate,
  type UtcDateTime,
  utcIsoformat,
} from './dates';
import { MailParserRecursionError } from './exceptions';
import {
  type ReceivedDiagnostic,
  type ReceivedHop,
  receivedsParsing,
} from './received';

const log = getLogger('mailparser');

/** Address headers mail-parser parses into `(name, address)` pairs. */
export const ADDRESSES_HEADERS: readonly string[] = [
  'bcc',
  'cc',
  'delivered-to',
  'from',
  'reply-to',
  'to',
];
const ADDRESS_HEADER_SET: ReadonlySet<string> = new Set(ADDRESSES_HEADERS);

const OTHERS_PARTS: readonly string[] = [
  'attachments',
  'body',
  'date',
  'message-id',
  'received',
  'subject',
  'timezone',
  'to_domains',
  'user-agent',
  'x-mailer',
  'x-original-to',
];

const COMPUTED_PARTS: ReadonlySet<string> = new Set([
  'attachments',
  'body',
  'date',
  'received',
  'timezone',
  'to_domains',
]);

const RESERVED_MAIL_KEYS: ReadonlySet<string> = new Set([
  'defects',
  'defects_categories',
  'has_defects',
  'address_header_defects',
  'received_header_defects',
  'date_header_defects',
]);

const EPILOGUE_DEFECT = 'StartBoundaryNotFoundDefect';
const BODY_SEPARATOR = '\n--- mail_boundary ---\n';
const MIME_VIEW_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-disposition',
  'content-id',
  'content-transfer-encoding',
]);

/** One attachment as mail-parser reports it. */
export interface MailParserAttachment {
  filename: string;
  safe_filename: string | null;
  payload: string;
  binary: boolean;
  mail_content_type: string;
  'content-id': string;
  'content-disposition': string;
  charset: string | null;
  content_transfer_encoding: string;
}

/** A header value: decoded text, several of them, or address pairs. */
export type HeaderValue = string | string[] | [string, string][];

/**
 * A longer run of consecutive combining marks is left alone by {@link nfc}.
 * ICU reorders marks with an insertion sort: 80,000 marks take 26 s, and at
 * this length a whole email stays linear. No language needs a run this long.
 * The lookbehind only starts matching where a run starts.
 */
const LONG_MARK_RUN = /(?<!\p{M})\p{M}{129}/u;

/** `normalize("NFC", text)`, except for {@link LONG_MARK_RUN} (Python's sort is linear). */
function nfc(text: string): string {
  return LONG_MARK_RUN.test(text) ? text : text.normalize('NFC');
}

/** `ported_string()` for text: NFC-normalized, `''` for missing values. */
function portedString(value: string | null | undefined): string {
  return value ? nfc(value) : '';
}

/** `ported_string(raw_bytes, encoding, "ignore")`. */
function portedBytes(raw: Uint8Array, encoding: string): string {
  if (raw.length === 0) {
    return '';
  }
  let text: string;
  try {
    text = pyDecode(raw, encoding);
  } catch (error) {
    if (!(error instanceof LookupError || error instanceof UnicodeError)) {
      throw error;
    }
    text = pyDecode(raw, 'utf-8', 'ignore');
  }
  return nfc(text);
}

/** mail-parser `decode_header_part()`. */
export function decodeHeaderPart(header: string | null | undefined): string {
  if (!header) {
    return '';
  }
  let output = '';
  try {
    for (const [data, charset] of decodeHeader(header)) {
      output +=
        typeof data === 'string'
          ? portedString(data)
          : portedBytes(data, charset || 'utf-8');
    }
  } catch (error) {
    if (!(error instanceof HeaderParseError || error instanceof UnicodeError)) {
      throw error;
    }
    log.error(`Failed decoding header part: ${header}`);
    output += header;
  }
  return pyStrip(output);
}

/** mail-parser `decode_headers()`. */
function decodeHeaders(
  values: readonly string[] | undefined,
): string | string[] {
  if (values === undefined || values.length === 0) {
    return '';
  }
  const decoded = values.map(value => decodeHeaderPart(value));
  if (decoded.length === 1) {
    return pyStrip(decoded[0] ?? '');
  }
  return decoded;
}

/** `find_between()`, including its `AttributeError` on `None`. */
function findBetween(
  text: string | null,
  first: string,
  last: string,
): string | null {
  if (text === null) {
    throw new TypeError("'NoneType' object has no attribute 'index'");
  }
  const firstIndex = text.indexOf(first);
  if (firstIndex === -1) {
    return null;
  }
  const start = firstIndex + first.length;
  const end = text.indexOf(last, start);
  if (end === -1) {
    return null;
  }
  return pyStrip(text.slice(start, end));
}

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';

/** `random_string()`: ten random lowercase letters. */
function randomString(length = 10): string {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += LOWERCASE.charAt(randomInt(LOWERCASE.length));
  }
  return output;
}

const COMPOUND_EXTENSIONS = [
  '.tar.bz2',
  '.tar.gz',
  '.tar.lz',
  '.tar.lzma',
  '.tar.xz',
  '.tar.z',
  '.tar.zst',
] as const;
const MAX_FILENAME_BYTES = 240;

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

// `os.path.splitext()` (POSIX): leading dots do not start an extension.
function splitext(filename: string): [string, string] {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) {
    return [filename, ''];
  }
  let leading = 0;
  while (filename.charAt(leading) === '.') {
    leading += 1;
  }
  if (dot < leading) {
    return [filename, ''];
  }
  return [filename.slice(0, dot), filename.slice(dot)];
}

function splitAttachmentExtension(filename: string): [string, string] {
  const lower = filename.toLowerCase();
  for (const extension of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(extension) && filename.length > extension.length) {
      return [
        filename.slice(0, -extension.length),
        filename.slice(-extension.length),
      ];
    }
  }
  return splitext(filename);
}

function clampToBudget(text: string, budget: number): string {
  let output = '';
  let used = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (used + size > Math.max(0, budget)) {
      break;
    }
    output += char;
    used += size;
  }
  return output;
}

/** `_safe_attachment_filename()`; `null` where Python raises ValueError. */
export function safeAttachmentFilename(filename: string): string | null {
  if (filename.includes('\u0000')) {
    return null;
  }
  const normalized = filename.replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (basename === '' || basename === '.' || basename === '..') {
    return null;
  }
  if (utf8Length(basename) <= MAX_FILENAME_BYTES) {
    return basename;
  }
  let [root, extension] = splitAttachmentExtension(basename);
  if (utf8Length(extension) > MAX_FILENAME_BYTES / 2) {
    root = basename;
    extension = '';
  }
  return (
    clampToBudget(root, MAX_FILENAME_BYTES - utf8Length(extension)) + extension
  );
}

/** `mime_header_view()`: a header-only view of the MIME metadata. */
function mimeHeaderView(part: Message): Message {
  const view = new Message();
  view.setDefaultType(part.getDefaultType());
  for (const [name, value] of part.rawItems()) {
    if (MIME_VIEW_HEADERS.has(name.toLowerCase())) {
      view.set(name, value);
    }
  }
  return view;
}

type DefectEntry = Record<string, string[]>;

/**
 * Nesting levels `mailparser.parse_from_string()` parses when called from a
 * module's top level: its four extra frames leave 983 of CPython's default
 * recursion limit for the parser (measured with Python 3.14).
 */
export const MAIL_PARSER_MAX_NESTING = 983;

/** Port of mail-parser's `MailParser`, built with `parse_from_string()`. */
export class MailParser {
  readonly message: Message;
  readonly attachments: MailParserAttachment[] = [];
  readonly textPlain: string[] = [];
  readonly textHtml: string[] = [];
  readonly textNotManaged: string[] = [];
  readonly defects: DefectEntry[] = [];
  readonly defectsCategories: Set<string> = new Set();
  hasDefects = false;
  readonly addressHeaderDefects: AddressDiagnostic[] = [];
  readonly receivedHeaderDefects: ReceivedDiagnostic[] = [];
  readonly dateHeaderDefects: DateDiagnostic[] = [];
  readonly received: ReceivedHop[];
  readonly date: UtcDateTime | null = null;
  readonly timezone: string | 0 = 0;
  private readonly headerIndex = new Map<string, string[]>();
  private readonly addressHeaders = new Map<string, AddressPair[]>();
  private readonly mailObject: Record<string, unknown>;
  private readonly limits: EmailLimits;
  private flattened: FlattenCache | null = null;

  /**
   * `mailparser.parse_from_string(text)`. A message nested deeper than
   * {@link MAIL_PARSER_MAX_NESTING} levels throws
   * {@link MailParserRecursionError}, as `_parse_guarded()` turns Python's
   * `RecursionError` into it. Throws `EmailTooLargeError` past `limits`.
   */
  static fromString(
    text: string,
    limits: EmailLimits = DEFAULT_EMAIL_LIMITS,
  ): MailParser {
    try {
      return new MailParser(
        messageFromString(text, MAIL_PARSER_MAX_NESTING, limits),
        limits,
      );
    } catch (error) {
      if (!(error instanceof RecursionError)) {
        throw error;
      }
      throw new MailParserRecursionError(
        'Message nesting too deep to parse (possible malicious multipart structure)',
        { cause: error },
      );
    }
  }

  constructor(message: Message, limits: EmailLimits = DEFAULT_EMAIL_LIMITS) {
    this.message = message;
    this.limits = limits;
    for (const [name, value] of message.items()) {
      const key = name.toLowerCase();
      const list = this.headerIndex.get(key) ?? [];
      list.push(value);
      this.headerIndex.set(key, list);
    }
    this.collectAddressHeaders();
    const occurrences = new Map<string, number>();
    for (const [name, raw] of message.rawItems()) {
      const header = name.toLowerCase();
      if (header !== 'date' && header !== 'resent-date') {
        continue;
      }
      const occurrence = occurrences.get(header) ?? 0;
      occurrences.set(header, occurrence + 1);
      const result = parseMailDate(raw);
      if (header === 'date' && occurrence === 0) {
        this.date = result.value;
        this.timezone = result.timezone;
      }
      this.dateHeaderDefects.push(
        ...dateDiagnostics(result, raw, header, occurrence),
      );
    }
    this.received = receivedsParsing(
      message
        .rawItems()
        .filter(([name]) => name.toLowerCase() === 'received')
        .map(([, value]) => value),
      this.receivedHeaderDefects,
      this.dateHeaderDefects,
    );
    if (this.receivedHeaderDefects.length > 0) {
      this.flagDefect('ReceivedHeaderDefect', {
        'received-headers': this.receivedHeaderDefects.map(
          defect =>
            `ReceivedHeaderDefect: received[${defect.occurrence}]: ${defect.reason}`,
        ),
      });
    }
    if (this.dateHeaderDefects.length > 0) {
      this.flagDefect('DateHeaderDefect', {
        'date-headers': this.dateHeaderDefects.map(
          defect =>
            `DateHeaderDefect: ${defect.header}[${defect.occurrence}]: ${defect.reason}`,
        ),
      });
    }
    this.parseParts();
    this.mailObject = this.makeMail();
  }

  private flagDefect(category: string, entry: DefectEntry): void {
    this.hasDefects = true;
    this.defectsCategories.add(category);
    this.defects.push(entry);
  }

  private collectAddressHeaders(): void {
    for (const header of ADDRESSES_HEADERS) {
      for (const [occurrence, value] of (
        this.headerIndex.get(header) ?? []
      ).entries()) {
        const diagnostics: AddressDiagnostic[] = [];
        const addresses = getAddresses(value, diagnostics, true);
        if (occurrence === 0) {
          this.addressHeaders.set(header, addresses);
        }
        for (const defect of diagnostics) {
          defect.header = header;
          defect.occurrence = occurrence;
          this.addressHeaderDefects.push(defect);
        }
      }
    }
    if (this.addressHeaderDefects.length > 0) {
      this.flagDefect('AddressHeaderDefect', {
        'address-headers': this.addressHeaderDefects.map(
          defect =>
            `AddressHeaderDefect: ${defect.header}[${defect.occurrence}]: ${defect.reason}`,
        ),
      });
    }
  }

  /** `_header_value()`: a header by its exact name off the wire. */
  headerValue(name: string): HeaderValue {
    const lower = name.toLowerCase();
    if (ADDRESS_HEADER_SET.has(lower)) {
      return (this.addressHeaders.get(lower) ?? [])
        .filter(([, address]) => address)
        .map(([displayName, address]): [string, string] => [
          displayName === address ? '' : displayName,
          address,
        ]);
    }
    return decodeHeaders(this.headerIndex.get(lower));
  }

  private appendDefects(part: Message, contentType: string): void {
    const messages: string[] = [];
    for (const defect of part.defects) {
      messages.push(`${defect.name}: ${defect.doc}`);
      this.defectsCategories.add(defect.name);
    }
    if (messages.length > 0) {
      this.hasDefects = true;
      this.defects.push({ [contentType]: messages });
    }
  }

  private parseParts(): void {
    const parts: [Message, boolean][] = [];
    const attachmentDescendants = new Set<Message>();
    for (const part of this.message.walk()) {
      this.appendDefects(part, part.getContentType());
      const inside = attachmentDescendants.has(part);
      parts.push([part, inside]);
      if (part.isMultipart()) {
        const disposition = part.getContentDisposition();
        const blocksInline =
          (disposition !== undefined && disposition !== 'inline') ||
          (disposition !== 'inline' && Boolean(part.getFilename()));
        if (inside || blocksInline) {
          const payload = part.getPayload();
          for (const child of Array.isArray(payload) ? payload : []) {
            attachmentDescendants.add(child);
          }
        }
      }
    }
    if (this.defectsCategories.has(EPILOGUE_DEFECT)) {
      const boundary = this.message.getBoundary();
      if (boundary === undefined) {
        throw new TypeError('can only concatenate str (not "NoneType") to str');
      }
      const epilogue = findBetween(
        this.message.epilogue,
        `--${boundary}`,
        `--${boundary}--`,
      );
      if (epilogue !== null) {
        parts.push([
          messageFromString(epilogue, MAIL_PARSER_MAX_NESTING, this.limits),
          true,
        ]);
      }
    }
    // Nested message attachments reuse each other's flattened text.
    this.flattened = new FlattenCache(this.limits.maxExpandedEmailSize);
    try {
      for (const [index, [part, inside]] of parts.entries()) {
        this.parsePart(part, inside, index);
      }
    } finally {
      this.flattened = null;
    }
  }

  private parsePart(part: Message, inside: boolean, index: number): void {
    const metadata = mimeHeaderView(part);
    let filename = decodeHeaderPart(metadata.getFilename());
    const disposition = portedString(
      metadata.getContentDisposition(),
    ).toLowerCase();
    if (part.isMultipart() && disposition !== 'attachment') {
      return;
    }
    const charset = metadata.getContentCharset() ?? 'utf-8';
    const charsetRaw = metadata.getContentCharset() ?? null;
    const contentId = portedString(metadata.get('content-id'));
    const contentSubtype = portedString(metadata.getContentSubtype());
    const isInlineBody =
      !inside &&
      !part.isMultipart() &&
      disposition === 'inline' &&
      ['text/plain', 'text/html'].includes(part.getContentType());
    let isAttachment = false;
    if (filename) {
      isAttachment = true;
    } else if (
      contentId &&
      contentSubtype !== 'html' &&
      contentSubtype !== 'plain'
    ) {
      isAttachment = true;
      filename = contentId;
    } else if ('rtf'.includes(contentSubtype)) {
      // Python's `content_subtype in ("rtf")` is a substring test.
      isAttachment = true;
      filename = `${randomString()}.rtf`;
    } else if (disposition === 'attachment') {
      isAttachment = true;
      filename = `${randomString()}.txt`;
    }
    if (isAttachment) {
      this.addAttachment(part, metadata, filename, charsetRaw, contentId);
    }
    if (!isAttachment || isInlineBody) {
      const payload = this.decodeBodyPayload(part, charset, index);
      if (payload) {
        const subtype = part.getContentSubtype();
        if (subtype === 'html') {
          this.textHtml.push(payload);
        } else if (subtype === 'plain') {
          this.textPlain.push(payload);
        } else {
          log.warning(`Email content ${pyRepr(subtype)} not handled`);
          this.textNotManaged.push(payload);
        }
      }
    }
  }

  private addAttachment(
    part: Message,
    metadata: Message,
    filename: string,
    charsetRaw: string | null,
    contentId: string,
  ): void {
    const mailContentType = portedString(metadata.getContentType());
    let transferEncoding = pyStrip(
      portedString(metadata.get('content-transfer-encoding') ?? ''),
    ).toLowerCase();
    const contentDisposition = portedString(
      metadata.get('content-disposition'),
    );
    let payload: string;
    let binary: boolean;
    const raw = part.getPayload();
    if (Array.isArray(raw)) {
      // Appended, not joined: nested attachments keep sharing their parts'
      // text (see FlattenCache) instead of holding a flat copy per level.
      payload = '';
      for (const child of raw) {
        payload += child.asString(this.flattened);
      }
      binary = false;
    } else if (transferEncoding === 'base64') {
      payload = raw ?? '';
      binary = true;
    } else {
      // Every other encoding is re-encoded to base64 from the decoded bytes.
      payload = b64encode(part.getDecodedPayload() ?? new Uint8Array());
      binary = true;
      transferEncoding = 'base64';
    }
    this.attachments.push({
      filename,
      safe_filename: safeAttachmentFilename(filename),
      payload,
      binary,
      mail_content_type: mailContentType,
      'content-id': contentId,
      'content-disposition': contentDisposition,
      charset: charsetRaw,
      content_transfer_encoding: transferEncoding,
    });
  }

  private decodeBodyPayload(
    part: Message,
    charset: string,
    index: number,
  ): string {
    const payload = part.getDecodedPayload();
    const cte = pyStrip(
      portedString(part.get('Content-Transfer-Encoding') ?? ''),
    ).toLowerCase();
    if (
      (!cte || cte === '7bit' || cte === '8bit') &&
      typeof part.payload === 'string'
    ) {
      return part.payload;
    }
    if (payload === null || payload.length === 0) {
      return '';
    }
    let text: string;
    try {
      text = pyDecode(payload, charset);
    } catch (error) {
      if (!(error instanceof LookupError || error instanceof UnicodeError)) {
        throw error;
      }
      let recovery: string;
      try {
        text = pyDecode(payload, 'utf-8');
        recovery = 'decoded with utf-8';
      } catch {
        text = pyDecode(payload, 'utf-8', 'replace');
        recovery = 'decoded with utf-8 replacement characters';
      }
      this.flagDefect('CharsetDecodeDefect', {
        [part.getContentType()]: [
          `CharsetDecodeDefect: part ${index}, charset ${pyRepr(charset)} failed; ${recovery}. Original bytes remain in the MIME part.`,
        ],
      });
    }
    return nfc(text);
  }

  /** `body`: text parts joined with the mail boundary marker. */
  get body(): string {
    return [...this.textPlain, ...this.textHtml, ...this.textNotManaged].join(
      BODY_SEPARATOR,
    );
  }

  /** `to_domains`: domains of the To and Reply-To addresses. */
  get toDomains(): string[] {
    const domains = new Set<string>();
    const pairs = [this.headerValue('to'), this.headerValue('reply-to')];
    for (const list of pairs) {
      for (const pair of Array.isArray(list) ? list : []) {
        if (Array.isArray(pair)) {
          domains.add(pyStrip((pair[1].split('@').at(-1) ?? '').toLowerCase()));
        }
      }
    }
    return [...domains];
  }

  private computedPart(name: string): unknown {
    switch (name) {
      case 'attachments':
        return this.attachments;
      case 'body':
        return this.body;
      case 'date':
        return this.date;
      case 'received':
        return this.received;
      case 'timezone':
        return this.timezone;
      default:
        return this.toDomains;
    }
  }

  private makeMail(): Record<string, unknown> {
    const mail: Record<string, unknown> = {};
    const keys = new Set<string>([
      ...this.message.keys().map(key => key.toLowerCase()),
      ...ADDRESSES_HEADERS,
      ...OTHERS_PARTS,
    ]);
    for (const key of keys) {
      if (RESERVED_MAIL_KEYS.has(key)) {
        continue;
      }
      const value = COMPUTED_PARTS.has(key)
        ? this.computedPart(key)
        : this.headerValue(key);
      if (isTruthy(value)) {
        defineKey(mail, key, value);
      }
    }
    if (this.addressHeaderDefects.length > 0) {
      mail.address_header_defects = this.addressHeaderDefects;
    }
    if (this.receivedHeaderDefects.length > 0) {
      mail.received_header_defects = this.receivedHeaderDefects;
    }
    if (this.dateHeaderDefects.length > 0) {
      mail.date_header_defects = this.dateHeaderDefects;
    }
    mail.has_defects = this.hasDefects;
    if (this.hasDefects) {
      mail.defects = this.defects;
      mail.defects_categories = [...this.defectsCategories];
    }
    return mail;
  }

  /** `json.loads(mail_json)`: a deep copy with the date as ISO text. */
  get mail(): Record<string, unknown> {
    const copy = structuredClone(this.mailObject);
    if (this.date !== null && copy.date) {
      copy.date = utcIsoformat(this.date);
    }
    return copy;
  }

  /** `json.loads(headers_json)`: every header, first spelling wins. */
  get headers(): Record<string, HeaderValue> {
    const names = new Map<string, string>();
    for (const key of this.message.keys()) {
      if (!names.has(key.toLowerCase())) {
        names.set(key.toLowerCase(), key);
      }
    }
    const headers: Record<string, HeaderValue> = {};
    for (const name of names.values()) {
      defineKey(headers, name, this.headerValue(name));
    }
    return headers;
  }
}

/** Set an own enumerable property, even for names like `__proto__`. */
export function defineKey(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}
