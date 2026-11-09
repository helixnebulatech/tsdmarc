// What Python's `email` package does with surrogate-escaped bytes (a
// message parsed with `message_from_bytes()`, as `mailbox.mbox.get_string()`
// does): `email.charset.Charset`, `Message.set_payload(payload, charset)`,
// `Message.set_param()`, the body encoders (`base64mime.body_encode`,
// `quoprimime.body_encode`, `encoders.encode_7or8bit`) and compat32's
// header sanitizing.

import { b64encode } from '../py-binascii';
import { lookupCodec, pyDecode, pyEncode } from '../py-codecs';
import { pySplitlines } from '../py-str';
import { type ParamValue, quote } from './utils';

/** `email.charset.UNKNOWN8BIT`. */
export const UNKNOWN8BIT = 'unknown-8bit';

/** Python's `email.errors.CharsetError`. */
export class CharsetError extends Error {
  override name = 'CharsetError';
}

type Encoding = 'qp' | 'base64' | 'shortest' | null;

const CHARSETS: Readonly<Record<string, [Encoding, Encoding, string | null]>> =
  {
    'iso-8859-1': ['qp', 'qp', null],
    'iso-8859-2': ['qp', 'qp', null],
    'iso-8859-3': ['qp', 'qp', null],
    'iso-8859-4': ['qp', 'qp', null],
    'iso-8859-9': ['qp', 'qp', null],
    'iso-8859-10': ['qp', 'qp', null],
    'iso-8859-13': ['qp', 'qp', null],
    'iso-8859-14': ['qp', 'qp', null],
    'iso-8859-15': ['qp', 'qp', null],
    'iso-8859-16': ['qp', 'qp', null],
    'windows-1252': ['qp', 'qp', null],
    viscii: ['qp', 'qp', null],
    'us-ascii': [null, null, null],
    big5: ['base64', 'base64', null],
    gb2312: ['base64', 'base64', null],
    'euc-jp': ['base64', null, 'iso-2022-jp'],
    shift_jis: ['base64', null, 'iso-2022-jp'],
    'iso-2022-jp': ['base64', null, null],
    'koi8-r': ['base64', 'base64', null],
    'utf-8': ['shortest', 'base64', 'utf-8'],
  };

const ALIASES: Readonly<Record<string, string>> = {
  latin_1: 'iso-8859-1',
  'latin-1': 'iso-8859-1',
  latin_2: 'iso-8859-2',
  'latin-2': 'iso-8859-2',
  latin_3: 'iso-8859-3',
  'latin-3': 'iso-8859-3',
  latin_4: 'iso-8859-4',
  'latin-4': 'iso-8859-4',
  latin_5: 'iso-8859-9',
  'latin-5': 'iso-8859-9',
  latin_6: 'iso-8859-10',
  'latin-6': 'iso-8859-10',
  latin_7: 'iso-8859-13',
  'latin-7': 'iso-8859-13',
  latin_8: 'iso-8859-14',
  'latin-8': 'iso-8859-14',
  latin_9: 'iso-8859-15',
  'latin-9': 'iso-8859-15',
  latin_10: 'iso-8859-16',
  'latin-10': 'iso-8859-16',
  cp949: 'ks_c_5601-1987',
  euc_jp: 'euc-jp',
  euc_kr: 'euc-kr',
  ascii: 'us-ascii',
};

function lookup<T>(
  table: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// Codecs that don't write ASCII as ASCII.
const NOT_ASCII_COMPATIBLE =
  /^(?:utf_(?:16|32|7)|cp(?:037|273|424|500|875|1026|1140)|hz|iso2022_kr)/u;
// ASCII plus surrogate-escaped bytes.
// oxlint-disable-next-line no-control-regex -- every ASCII code point, controls included.
const ESCAPED_BYTES = /^[\u0000-\u007f\udc80-\udcff]*$/u;

/**
 * `text.encode(encoding, errors)` for text decoded from bytes with
 * `surrogateescape`. The codec port only encodes a few codecs; for any
 * ASCII-compatible codec, such text encodes to its ASCII and escaped bytes.
 */
export function encodeEscapedText(
  text: string,
  encoding: string,
  errors: 'strict' | 'surrogateescape' = 'strict',
): Uint8Array {
  const codec = lookupCodec(encoding);
  if (
    codec === 'utf_8' ||
    codec === 'ascii' ||
    codec === 'latin_1' ||
    NOT_ASCII_COMPATIBLE.test(codec) ||
    !ESCAPED_BYTES.test(text)
  ) {
    return pyEncode(text, encoding, errors);
  }
  if (errors === 'strict' && !isAscii(text)) {
    // Python: "'<codec>' codec can't encode character ...: surrogates not allowed".
    return pyEncode(text, 'ascii');
  }
  return pyEncode(text, 'ascii', 'surrogateescape');
}

/** Python's `email.utils._has_surrogates()`: lone surrogates in `text`. */
export function hasSurrogates(text: string): boolean {
  return !text.isWellFormed();
}

/** `email.charset.Charset` (the parts the generator uses). */
export class Charset {
  readonly inputCharset: string;
  readonly bodyEncoding: Encoding;
  readonly outputCharset: string;

  constructor(inputCharset: string) {
    for (let index = 0; index < inputCharset.length; index += 1) {
      if (inputCharset.charCodeAt(index) >= 0x80) {
        throw new CharsetError(inputCharset);
      }
    }
    const lower = inputCharset.toLowerCase();
    this.inputCharset = lookup(ALIASES, lower) ?? lower;
    const [, bodyEncoding, conversion] = lookup(
      CHARSETS,
      this.inputCharset,
    ) ?? ['shortest', 'base64', null];
    this.bodyEncoding = bodyEncoding;
    const output = conversion || this.inputCharset;
    this.outputCharset = lookup(ALIASES, output) ?? output;
  }

  /** `get_output_charset()`. */
  getOutputCharset(): string {
    return this.outputCharset || this.inputCharset;
  }

  /** `body_encode(string)`. */
  bodyEncode(input: string | Uint8Array): string {
    if (input.length === 0) {
      return '';
    }
    if (this.bodyEncoding === 'base64') {
      const bytes =
        typeof input === 'string'
          ? encodeEscapedText(input, this.outputCharset)
          : input;
      return base64BodyEncode(bytes);
    }
    if (this.bodyEncoding === 'qp') {
      const bytes =
        typeof input === 'string'
          ? encodeEscapedText(input, this.outputCharset)
          : input;
      return qpBodyEncode(pyDecode(bytes, 'latin-1'));
    }
    if (typeof input === 'string') {
      return pyDecode(encodeEscapedText(input, this.outputCharset), 'ascii');
    }
    // Python returns the bytes unchanged here; no caller passes bytes.
    return pyDecode(input, 'latin-1');
  }
}

const BASE64_LINE_BYTES = 57;

/** `email.base64mime.body_encode(s)`: 76-character lines, each ending in `\n`. */
export function base64BodyEncode(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += BASE64_LINE_BYTES) {
    encoded += `${b64encode(bytes.subarray(index, index + BASE64_LINE_BYTES))}\n`;
  }
  return encoded;
}

const QP_BODY_SAFE = new Set(
  ' !"#$%&\'()*+,-./0123456789:;<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\t\r\n',
);

function qpQuote(char: string): string {
  return `=${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

const QP_MAX_LINE_LENGTH = 76;

/** `email.quoprimime.body_encode(body)` with `maxlinelen=76`, `eol="\n"`. */
export function qpBodyEncode(body: string): string {
  if (body.length === 0) {
    return body;
  }
  let translated = '';
  for (const char of body) {
    translated +=
      char.charCodeAt(0) < 256 && !QP_BODY_SAFE.has(char)
        ? qpQuote(char)
        : char;
  }
  const softBreak = '=\n';
  const maxLineLength1 = QP_MAX_LINE_LENGTH - 1;
  const encoded: string[] = [];
  for (const line of pySplitlines(translated)) {
    let start = 0;
    const lastStart = line.length - 1 - QP_MAX_LINE_LENGTH;
    while (start <= lastStart) {
      const stop = start + maxLineLength1;
      if (line[stop - 2] === '=') {
        encoded.push(line.slice(start, stop - 1));
        start = stop - 2;
      } else if (line[stop - 1] === '=') {
        encoded.push(line.slice(start, stop));
        start = stop - 1;
      } else {
        encoded.push(`${line.slice(start, stop)}=`);
        start = stop;
      }
    }
    const last = line.at(-1);
    if (last === ' ' || last === '\t') {
      const room = start - lastStart;
      let quoted: string;
      if (room >= 3) {
        quoted = qpQuote(last);
      } else if (room === 2) {
        quoted = last + softBreak;
      } else {
        quoted = softBreak + qpQuote(last);
      }
      encoded.push(line.slice(start, -1) + quoted);
    } else {
      encoded.push(line.slice(start));
    }
  }
  const end = translated.at(-1);
  if (end === '\r' || end === '\n') {
    encoded.push('');
  }
  return encoded.join('\n');
}

const URL_ALWAYS_SAFE = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~',
);

/** `email.utils.encode_rfc2231(s, charset, language)`. */
function encodeRfc2231(
  text: string,
  charset: string | null,
  language: string | null,
): string {
  let quoted = '';
  for (const byte of pyEncode(text, charset || 'ascii')) {
    const char = String.fromCharCode(byte);
    quoted += URL_ALWAYS_SAFE.has(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (charset === null && language === null) {
    return quoted;
  }
  return `${charset ?? 'None'}'${language ?? ''}'${quoted}`;
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x80) {
      return false;
    }
  }
  return true;
}

/** `email.message._formatparam(param, value, quote=True)`. */
export function formatParam(param: string, value: ParamValue | null): string {
  if (value === null || value.length === 0) {
    return param;
  }
  if (typeof value !== 'string') {
    const [charset, language, text] = value;
    return `${param}*=${encodeRfc2231(text, charset, language)}`;
  }
  if (!isAscii(value)) {
    return `${param}*=${encodeRfc2231(value, 'utf-8', '')}`;
  }
  return `${param}="${quote(value)}"`;
}

/**
 * compat32's `header_fetch_parse()` as `str()` sees it: a value holding
 * surrogate-escaped bytes reads as those bytes decoded as ASCII with
 * replacement characters.
 */
export function sanitizeHeaderValue(value: string): string {
  if (!hasSurrogates(value)) {
    return value;
  }
  return pyDecode(
    pyEncode(value, 'ascii', 'surrogateescape'),
    'ascii',
    'replace',
  );
}

/** Python's `str(value, 'ascii')` on a non-bytes charset parameter. */
export function charsetName(value: ParamValue): string {
  if (typeof value !== 'string') {
    throw new TypeError(
      'decoding to str: need a bytes-like object, tuple found',
    );
  }
  return value;
}
