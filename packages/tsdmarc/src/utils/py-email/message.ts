// Port of Python's `email.message.Message` with the compat32 policy, as the
// feed parser builds it from a `str` (no surrogate-escaped bytes).

import { KeyError } from '../../internal/py';
import { a2bBase64, a2bQp, a2bUu, BinasciiError } from '../py-binascii';
import { LookupError, pyDecode, pyEncode, UnicodeError } from '../py-codecs';
import { pyLStrip, pyRepr, pyRStrip, pyStrip } from '../py-str';
import {
  Charset,
  encodeEscapedText,
  formatParam,
  hasSurrogates,
  sanitizeHeaderValue,
} from './charset';
import {
  InvalidBase64CharactersDefect,
  InvalidBase64LengthDefect,
  InvalidBase64PaddingDefect,
  HeaderParseError,
  type MessageDefect,
} from './errors';
import { asString, type FlattenCache } from './generator';
import {
  collapseRfc2231Value,
  decodeParams,
  type ParamValue,
  type Rfc2231Value,
  rawUnicodeEscape,
  unquote,
} from './utils';

/** A message payload: text, sub-messages, or nothing yet. */
export type Payload = string | Message[] | null;

/** `_splitparam()`: split `value; params` at the first semicolon. */
function splitParam(param: string): [string, string | null] {
  const index = param.indexOf(';');
  if (index === -1) {
    return [pyStrip(param), null];
  }
  return [pyStrip(param.slice(0, index)), pyStrip(param.slice(index + 1))];
}

// Python's `str.count(sub, start, end)` with slice-index normalization.
function pyCount(
  text: string,
  sub: string,
  start: number,
  end: number,
): number {
  const length = text.length;
  const from =
    start < 0 ? Math.max(0, length + start) : Math.min(start, length);
  const to = end < 0 ? Math.max(0, length + end) : Math.min(end, length);
  if (to < from) {
    return 0;
  }
  const slice = text.slice(from, to);
  let count = 0;
  let index = slice.indexOf(sub);
  while (index !== -1) {
    count += 1;
    index = slice.indexOf(sub, index + sub.length);
  }
  return count;
}

// Python's `str.find(sub, start, end)` for a non-empty `sub`. The search
// stops at `end`: `_parseparam()` is only linear if it does.
function pyFind(
  text: string,
  sub: string,
  start: number,
  end = text.length,
): number {
  const from = Math.max(0, start);
  if (end >= text.length) {
    return text.indexOf(sub, from);
  }
  if (end - from < sub.length) {
    return -1;
  }
  const index = text.slice(from, end).indexOf(sub);
  return index === -1 ? -1 : from + index;
}

/** `email.message._parseparam()`, quirks included. */
export function parseParam(value: string): string[] {
  const text = `;${value}`;
  const plist: string[] = [];
  let start = 0;
  while (pyFind(text, ';', start) === start) {
    start += 1;
    let end = pyFind(text, ';', start);
    let ind = start;
    let diff = 0;
    while (end > 0) {
      diff += pyCount(text, '"', ind, end) - pyCount(text, '\\"', ind, end);
      if (diff % 2 === 0) {
        break;
      }
      const next = pyFind(text, ';', end + 1);
      end = ind;
      ind = next;
    }
    if (end < 0) {
      end = text.length;
    }
    const equals = end >= start ? pyFind(text, '=', start, end) : -1;
    let field: string;
    if (equals === -1) {
      field = text.slice(start, end);
    } else {
      field = `${pyRStrip(text.slice(start, equals)).toLowerCase()}=${pyLStrip(text.slice(equals + 1, end))}`;
    }
    plist.push(pyStrip(field));
    start = end;
  }
  return plist;
}

// `str()` of an RFC 2231 `(charset, language, value)` tuple.
function formatTuple(value: Rfc2231Value): string {
  const items = value.map(item => (item === null ? 'None' : pyRepr(item)));
  return `(${items.join(', ')})`;
}

function unquoteValue(value: ParamValue): ParamValue {
  if (typeof value === 'string') {
    return unquote(value);
  }
  return [value[0], value[1], unquote(value[2])];
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

// `b''.join(bytes.splitlines())`, in one copy: `bytes.splitlines()` splits
// only on \r, \n and \r\n. A view per line would make a body of bare line
// endings cost a hundred times its size.
function removeLineEndings(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte !== 0x0a && byte !== 0x0d) {
      output[length] = byte;
      length += 1;
    }
  }
  return output.subarray(0, length);
}

/**
 * `bytes.splitlines()`, one line at a time.
 * @yields {Uint8Array} Each line, without its line ending.
 */
function* byteLines(bytes: Uint8Array): Generator<Uint8Array> {
  let start = 0;
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === 0x0a || byte === 0x0d) {
      yield bytes.subarray(start, index);
      index += byte === 0x0d && bytes[index + 1] === 0x0a ? 2 : 1;
      start = index;
    } else {
      index += 1;
    }
  }
  if (start < bytes.length) {
    yield bytes.subarray(start);
  }
}

function tryB64(data: Uint8Array, strict: boolean): Uint8Array | null {
  try {
    return a2bBase64(data, strict);
  } catch (error) {
    if (error instanceof BinasciiError) {
      return null;
    }
    throw error;
  }
}

/** `email._encoded_words.decode_b()`. */
export function decodeB(encoded: Uint8Array): [Uint8Array, MessageDefect[]] {
  const padError = encoded.length % 4;
  const padding = new Uint8Array(padError ? 4 - padError : 0).fill(0x3d);
  const strict = tryB64(concatBytes([encoded, padding]), true);
  if (strict !== null) {
    return [strict, padError ? [new InvalidBase64PaddingDefect()] : []];
  }
  const lenient = tryB64(encoded, false);
  if (lenient !== null) {
    return [lenient, [new InvalidBase64CharactersDefect()]];
  }
  const padded = tryB64(
    concatBytes([encoded, Uint8Array.of(0x3d, 0x3d)]),
    false,
  );
  if (padded !== null) {
    return [
      padded,
      [new InvalidBase64CharactersDefect(), new InvalidBase64PaddingDefect()],
    ];
  }
  return [encoded, [new InvalidBase64LengthDefect()]];
}

function startsWithBytes(line: Uint8Array, prefix: string): boolean {
  if (line.length < prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (line[index] !== prefix.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

// What `int(mode, base=8)` accepts.
const OCTAL_INT =
  /^[ \t\n\r\f\v]*[+-]?(?:0[oO]_?)?[0-7](?:_?[0-7])*[ \t\n\r\f\v]*$/u;
const UU_STRIP = ' \t\r\n\f';

function isUuBeginLine(line: Uint8Array): boolean {
  if (!startsWithBytes(line, 'begin ')) {
    return false;
  }
  const rest = bytesToLatin1(line.subarray(6));
  const space = rest.indexOf(' ');
  return OCTAL_INT.test(space === -1 ? rest : rest.slice(0, space));
}

function decodeUuLine(line: Uint8Array): Uint8Array {
  try {
    return a2bUu(line);
  } catch (error) {
    if (!(error instanceof BinasciiError)) {
      throw error;
    }
    const nbytes = Math.floor(((((line[0] ?? 0) - 32) & 63) * 4 + 5) / 3);
    return a2bUu(line.subarray(0, nbytes));
  }
}

/**
 * `email.message._decode_uu()`; throws `Error` on "ValueError". Real uuencode
 * shrinks by a quarter, but a line's length byte promises 45 bytes whatever
 * follows it, so a line of 2 bytes would decode to 45: output larger than the
 * input is refused like any other invalid input (not in Python).
 */
function decodeUu(encoded: Uint8Array): Uint8Array {
  const lines = byteLines(encoded);
  let next = lines.next();
  while (!next.done && !isUuBeginLine(next.value)) {
    next = lines.next();
  }
  if (next.done) {
    throw new Error('`begin` line not found');
  }
  const output = new Uint8Array(encoded.length);
  let length = 0;
  for (next = lines.next(); !next.done; next = lines.next()) {
    const line = next.value;
    if (line.length === 0) {
      throw new Error('Truncated input');
    }
    if (pyStrip(bytesToLatin1(line), UU_STRIP) === 'end') {
      break;
    }
    const decoded = decodeUuLine(line);
    if (length + decoded.length > output.length) {
      throw new Error('Decoded uuencode is larger than its input');
    }
    output.set(decoded, length);
    length += decoded.length;
  }
  return output.subarray(0, length);
}

/** Python's `email.message.Message` (compat32). */
export class Message {
  /** `(name, value)` pairs in wire order (`_headers`). */
  headers: [string, string][] = [];
  unixfrom: string | null = null;
  /** `_payload`. */
  payload: Payload = null;
  preamble: string | null = null;
  epilogue: string | null = null;
  defects: MessageDefect[] = [];
  private defaultType = 'text/plain';

  /** `msg.as_string()`; see {@link FlattenCache} for `cache`. */
  asString(cache: FlattenCache | null = null): string {
    return asString(this, cache);
  }

  /** `str(msg)`. */
  toString(): string {
    return this.asString();
  }

  isMultipart(): boolean {
    return Array.isArray(this.payload);
  }

  attach(payload: Message): void {
    if (this.payload === null) {
      this.payload = [payload];
    } else if (Array.isArray(this.payload)) {
      this.payload.push(payload);
    } else {
      throw new TypeError(
        'Attach is not valid on a message with a non-multipart payload',
      );
    }
  }

  /**
   * `get_payload()` (decode=False). Text holding surrogate-escaped bytes
   * reads as those bytes decoded with the content charset (default ASCII),
   * with replacement characters.
   */
  getPayload(): Payload {
    const { payload } = this;
    if (typeof payload !== 'string' || !hasSurrogates(payload)) {
      return payload;
    }
    let bpayload: Uint8Array;
    try {
      bpayload = pyEncode(payload, 'ascii', 'surrogateescape');
    } catch (error) {
      if (error instanceof UnicodeError) {
        return payload;
      }
      throw error;
    }
    try {
      return pyDecode(bpayload, this.getContentCharset() ?? 'ascii', 'replace');
    } catch (error) {
      if (error instanceof LookupError) {
        return pyDecode(bpayload, 'ascii', 'replace');
      }
      throw error;
    }
  }

  /**
   * `get_payload(decode=True)`: the payload with its
   * Content-Transfer-Encoding undone, or `null` for multipart messages.
   */
  getDecodedPayload(): Uint8Array | null {
    if (Array.isArray(this.payload)) {
      return null;
    }
    const payload = this.payload ?? '';
    const cte = pyStrip(
      this.get('content-transfer-encoding') ?? '',
    ).toLowerCase();
    let bpayload: Uint8Array;
    try {
      bpayload = pyEncode(payload, 'ascii', 'surrogateescape');
    } catch {
      bpayload = rawUnicodeEscape(payload);
    }
    if (cte === 'quoted-printable') {
      return a2bQp(bpayload);
    }
    if (cte === 'base64') {
      const [value, defects] = decodeB(removeLineEndings(bpayload));
      this.defects.push(...defects);
      return value;
    }
    if (
      cte === 'x-uuencode' ||
      cte === 'uuencode' ||
      cte === 'uue' ||
      cte === 'x-uue'
    ) {
      try {
        return decodeUu(bpayload);
      } catch {
        return bpayload;
      }
    }
    return bpayload;
  }

  /**
   * `set_payload(payload, charset=None)`. With a charset, the text is
   * encoded with it (surrogate-escaped bytes kept as-is) and
   * {@link setCharset} applies its body encoding.
   */
  setPayload(payload: string, charset: string | Charset | null = null): void {
    if (charset === null) {
      this.payload = payload;
      return;
    }
    const cs = charset instanceof Charset ? charset : new Charset(charset);
    this.payload = pyDecode(
      encodeEscapedText(payload, cs.outputCharset, 'surrogateescape'),
      'ascii',
      'surrogateescape',
    );
    this.setCharset(cs);
  }

  /** `set_charset(charset)` (the non-`None` case). */
  setCharset(charset: string | Charset): void {
    const cs = charset instanceof Charset ? charset : new Charset(charset);
    if (!this.has('MIME-Version')) {
      this.set('MIME-Version', '1.0');
    }
    if (this.has('Content-Type')) {
      this.setParam('charset', cs.getOutputCharset());
    } else {
      this.set(
        'Content-Type',
        `text/plain; ${formatParam('charset', cs.getOutputCharset())}`,
      );
    }
    if (cs.inputCharset !== cs.getOutputCharset().toLowerCase()) {
      this.payload = cs.bodyEncode((this.payload as string | null) ?? '');
    }
    if (this.has('Content-Transfer-Encoding')) {
      return;
    }
    if (cs.bodyEncoding === 'qp' || cs.bodyEncoding === 'base64') {
      // Python calls the encoding name, fails with TypeError and encodes
      // the payload bytes itself.
      const text = (this.payload as string | null) ?? '';
      let payload: string | Uint8Array = text;
      if (text) {
        try {
          payload = pyEncode(text, 'ascii', 'surrogateescape');
        } catch (error) {
          if (!(error instanceof UnicodeError)) {
            throw error;
          }
          payload = encodeEscapedText(text, cs.outputCharset);
        }
      }
      this.payload = cs.bodyEncode(payload);
      this.set(
        'Content-Transfer-Encoding',
        cs.bodyEncoding === 'qp' ? 'quoted-printable' : 'base64',
      );
      return;
    }
    // `encoders.encode_7or8bit`.
    const orig = this.getDecodedPayload();
    let cte = '7bit';
    if (orig !== null) {
      try {
        pyDecode(orig, 'ascii');
      } catch (error) {
        if (!(error instanceof UnicodeError)) {
          throw error;
        }
        cte = '8bit';
      }
    }
    this.set('Content-Transfer-Encoding', cte);
  }

  /** `set_param(param, value)` on Content-Type (requote, not replace). */
  setParam(param: string, value: string): void {
    const header = 'Content-Type';
    let ctype: string | undefined = this.has(header)
      ? this.get(header)
      : 'text/plain';
    if (this.getParam(param, header)) {
      ctype = '';
      for (const [oldParam, oldValue] of this.getParams(header) ?? []) {
        const appendParam =
          oldParam.toLowerCase() === param.toLowerCase()
            ? formatParam(param, value)
            : formatParam(oldParam, oldValue);
        ctype = ctype ? `${ctype}; ${appendParam}` : appendParam;
      }
    } else if (ctype) {
      ctype = `${ctype}; ${formatParam(param, value)}`;
    } else {
      ctype = formatParam(param, value);
    }
    if (ctype !== this.get(header)) {
      this.delete(header);
      this.set(header, ctype);
    }
  }

  /** `replace_header(name, value)`: the first match, keeping its position. */
  replaceHeader(name: string, value: string): void {
    const lower = name.toLowerCase();
    const index = this.headers.findIndex(
      ([key]) => key.toLowerCase() === lower,
    );
    if (index === -1) {
      throw new KeyError(lower);
    }
    this.headers[index] = [this.headers[index]?.[0] ?? name, value];
  }

  /** A copy whose headers can change without touching this message. */
  copy(): Message {
    const copy = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as Message,
      this,
    );
    copy.headers = this.headers.map(([key, value]) => [key, value]);
    copy.defects = [...this.defects];
    return copy;
  }

  get length(): number {
    return this.headers.length;
  }

  has(name: string): boolean {
    const lower = name.toLowerCase();
    return this.headers.some(([key]) => key.toLowerCase() === lower);
  }

  keys(): string[] {
    return this.headers.map(([key]) => key);
  }

  // Header values holding surrogate-escaped bytes read as compat32's
  // unknown-8bit Header objects do under str() (see sanitizeHeaderValue).

  values(): string[] {
    return this.headers.map(([, value]) => sanitizeHeaderValue(value));
  }

  items(): [string, string][] {
    return this.headers.map(([key, value]) => [
      key,
      sanitizeHeaderValue(value),
    ]);
  }

  /** `raw_items()`: values as stored. */
  rawItems(): [string, string][] {
    return this.headers.map(([key, value]) => [key, value]);
  }

  get(name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of this.headers) {
      if (key.toLowerCase() === lower) {
        return sanitizeHeaderValue(value);
      }
    }
    return undefined;
  }

  getAll(name: string): string[] | undefined {
    const lower = name.toLowerCase();
    const values = this.headers
      .filter(([key]) => key.toLowerCase() === lower)
      .map(([, value]) => sanitizeHeaderValue(value));
    return values.length > 0 ? values : undefined;
  }

  /** `msg[name] = value` (appends). */
  set(name: string, value: string): void {
    this.headers.push([name, value]);
  }

  /** `set_raw()`. */
  setRaw(name: string, value: string): void {
    this.headers.push([name, value]);
  }

  /** `del msg[name]`. */
  delete(name: string): void {
    const lower = name.toLowerCase();
    this.headers = this.headers.filter(([key]) => key.toLowerCase() !== lower);
  }

  getContentType(): string {
    const value = this.get('content-type');
    if (value === undefined) {
      return this.getDefaultType();
    }
    const ctype = splitParam(value)[0].toLowerCase();
    if (ctype.split('/').length !== 2) {
      return 'text/plain';
    }
    return ctype;
  }

  getContentMaintype(): string {
    return this.getContentType().split('/')[0] ?? '';
  }

  getContentSubtype(): string {
    return this.getContentType().split('/')[1] ?? '';
  }

  getDefaultType(): string {
    return this.defaultType;
  }

  setDefaultType(ctype: string): void {
    this.defaultType = ctype;
  }

  private getParamsPreserve(
    header: string,
  ): [string, ParamValue][] | undefined {
    const value = this.get(header);
    if (value === undefined) {
      return undefined;
    }
    const params: [string, string][] = [];
    for (const param of parseParam(value)) {
      const index = param.indexOf('=');
      if (index === -1) {
        params.push([pyStrip(param), '']);
      } else {
        params.push([
          pyStrip(param.slice(0, index)),
          pyStrip(param.slice(index + 1)),
        ]);
      }
    }
    return decodeParams(params);
  }

  /** `get_params(header=header)` (unquoted). */
  getParams(header = 'content-type'): [string, ParamValue][] | undefined {
    return this.getParamsPreserve(header)?.map(([key, value]) => [
      key,
      unquoteValue(value),
    ]);
  }

  /** `get_param(param, header=header)`; `undefined` when missing. */
  getParam(param: string, header = 'content-type'): ParamValue | undefined {
    if (!this.has(header)) {
      return undefined;
    }
    const lower = param.toLowerCase();
    for (const [key, value] of this.getParamsPreserve(header) ?? []) {
      if (key.toLowerCase() === lower) {
        return unquoteValue(value);
      }
    }
    return undefined;
  }

  /** `get_filename()`; `undefined` when there is none. */
  getFilename(): string | undefined {
    let filename = this.getParam('filename', 'content-disposition');
    if (filename === undefined) {
      filename = this.getParam('name', 'content-type');
    }
    if (filename === undefined) {
      return undefined;
    }
    return pyStrip(collapseRfc2231Value(filename));
  }

  /** `get_boundary()`; `undefined` when there is none. */
  getBoundary(): string | undefined {
    const boundary = this.getParam('boundary');
    if (boundary === undefined) {
      return undefined;
    }
    // RFC 2046: boundaries may begin but not end with whitespace.
    return pyRStrip(collapseRfc2231Value(boundary));
  }

  /** `set_boundary()`: rewrite the boundary of every Content-Type header. */
  setBoundary(boundary: string): void {
    const params = this.getParamsPreserve('content-type');
    if (params === undefined) {
      throw new HeaderParseError('No Content-Type header found');
    }
    let found = false;
    const newParams: [string, ParamValue][] = params.map(([key, value]) => {
      if (key.toLowerCase() === 'boundary') {
        found = true;
        return ['boundary', `"${boundary}"`];
      }
      return [key, value];
    });
    if (!found) {
      newParams.push(['boundary', `"${boundary}"`]);
    }
    const formatted = newParams
      .map(([key, value]) => {
        if (value === '') {
          return key;
        }
        return `${key}=${typeof value === 'string' ? value : formatTuple(value)}`;
      })
      .join('; ');
    this.headers = this.headers.map(([name, value]) =>
      name.toLowerCase() === 'content-type' ? [name, formatted] : [name, value],
    );
  }

  /** `get_content_charset()`; `undefined` when there is none. */
  getContentCharset(): string | undefined {
    const raw = this.getParam('charset');
    if (raw === undefined) {
      return undefined;
    }
    let charset: string;
    if (typeof raw === 'string') {
      charset = raw;
    } else {
      const pcharset = raw[0] || 'us-ascii';
      try {
        charset = pyDecode(rawUnicodeEscape(raw[2]), pcharset);
      } catch (error) {
        if (!(error instanceof LookupError || error instanceof UnicodeError)) {
          throw error;
        }
        charset = raw[2];
      }
    }
    for (let index = 0; index < charset.length; index += 1) {
      if (charset.charCodeAt(index) >= 0x80) {
        return undefined;
      }
    }
    return charset.toLowerCase();
  }

  /** `get_content_disposition()`; `undefined` when there is none. */
  getContentDisposition(): string | undefined {
    const value = this.get('content-disposition');
    if (value === undefined) {
      return undefined;
    }
    return splitParam(value)[0].toLowerCase();
  }

  /**
   * `walk()`: this message, then every subpart, depth first.
   * @yields {Message} Each message of the tree.
   */
  *walk(): Generator<Message> {
    yield this;
    // An explicit stack, not `yield* part.walk()`: each message would pass
    // through a generator per ancestor.
    const stack: { parts: Message[]; next: number }[] = [];
    if (Array.isArray(this.payload)) {
      stack.push({ parts: this.payload, next: 0 });
    }
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      const part = top.parts[top.next];
      if (part === undefined) {
        stack.pop();
        continue;
      }
      top.next += 1;
      yield part;
      if (Array.isArray(part.payload)) {
        stack.push({ parts: part.payload, next: 0 });
      }
    }
  }
}
