// Python codec semantics for decoding and encoding email text.
//
// mail-parser and Python's `email` package decode bytes with Python's codecs
// (`bytes.decode(charset, errors)`), and fall back when the codec is unknown
// (`LookupError`) or the bytes are invalid (`UnicodeError`). Matching their
// output needs the same codec names, the same tables and the same error
// handlers, which WHATWG `TextDecoder` does not provide: there `iso-8859-1`
// and `ascii` are windows-1252 and never fail, and its CJK tables differ
// between Node and Bun. So:
//
// - names resolve through Python's alias table and `normalize_encoding()`;
// - UTF-7/8/16/32, ASCII, Latin-1 and raw-unicode-escape are implemented
//   here, and the single-byte codecs use CPython's own tables;
// - the CJK codecs (big5, cp950, big5hkscs, gb2312, gbk, gb18030, hz,
//   euc_kr, cp949, euc_jp, shift_jis, cp932, iso2022_jp, iso2022_jp_1,
//   iso2022_jp_ext) are ports of CPython's decoders with its tables
//   (py-codecs-cjk.ts);
// - the JIS X 0213 codecs (euc_jis_2004, euc_jisx0213, shift_jis_2004,
//   shift_jisx0213, iso2022_jp_2004, iso2022_jp_3) and iso2022_jp_2 are
//   approximated with `TextDecoder`.
//
// Codecs that are none of these (iso2022_kr, johab, idna, punycode,
// unicode_escape) raise `LookupError`, as if Python did not know them.
//
// Valid input takes fast paths (TextDecoder for UTF-8, bulk conversion for
// ASCII/Latin-1/charmaps); the exact per-byte loops run only when there is
// something to report.

import {
  ASCII_LIMIT,
  type CodecErrors,
  decodeError,
  type ErrorContext,
  LATIN1_LIMIT,
  LookupError,
  REPLACEMENT,
  TextBuilder,
  UnicodeDecodeError,
  UnicodeEncodeError,
  UnicodeError,
  unitsToString,
  bmpUnitsToString,
} from './py-codecs-base';
import { decodeCjk } from './py-codecs-cjk';
import {
  PY_CHARMAP_TABLES,
  PY_CODEC_ALIASES,
  PY_TEXT_CODECS,
} from './py-codecs-data';

export {
  type CodecErrors,
  LookupError,
  UnicodeDecodeError,
  UnicodeEncodeError,
  UnicodeError,
} from './py-codecs-base';

const NON_TEXT_CODECS: ReadonlySet<string> = new Set([
  'base64',
  'base_64',
  'base64_codec',
  'bz2',
  'bz2_codec',
  'hex',
  'hex_codec',
  'qp',
  'quopri',
  'quopri_codec',
  'quoted_printable',
  'quotedprintable',
  'rot13',
  'rot_13',
  'uu',
  'uu_codec',
  'zip',
  'zlib',
  'zlib_codec',
]);

/** Python's `ValueError("embedded null character")` for a codec name with NUL. */
export class EmbeddedNullError extends Error {
  override name = 'ValueError';

  constructor() {
    super('embedded null character');
  }
}

const TEXT_CODECS: ReadonlySet<string> = new Set(PY_TEXT_CODECS);

// Python codecs without a port, approximated with these WHATWG labels.
const WHATWG_CODECS: Readonly<Record<string, string>> = {
  euc_jis_2004: 'euc-jp',
  euc_jisx0213: 'euc-jp',
  iso2022_jp_2: 'iso-2022-jp',
  iso2022_jp_2004: 'iso-2022-jp',
  iso2022_jp_3: 'iso-2022-jp',
  shift_jis_2004: 'shift_jis',
  shift_jisx0213: 'shift_jis',
};

const UNDEFINED_MARK = 0xfffe;
const NAME_CHAR = /^[\p{L}\p{N}.]$/u;

/** Python's `encodings.normalize_encoding()` (after lowercasing). */
export function normalizeEncoding(encoding: string): string {
  let output = '';
  let punct = false;
  for (const char of encoding.toLowerCase()) {
    if (NAME_CHAR.test(char)) {
      if (punct && output.length > 0) {
        output += '_';
      }
      if (char.charCodeAt(0) < ASCII_LIMIT) {
        output += char;
      }
      punct = false;
    } else {
      punct = true;
    }
  }
  return output;
}

/**
 * Resolve a codec name like `codecs.lookup()`, returning Python's module
 * name (`utf_8`, `iso8859_15`, ...). Throws {@link LookupError} for unknown
 * names and for non-text codecs (`base64`, `rot13`...).
 */
export function lookupCodec(encoding: string): string {
  // Python rejects the name before looking it up (`bytes.decode`,
  // `str.encode`, `str(b, enc)` and `codecs.lookup` all parse it as a C
  // string), so mail-parser's LookupError fallback never sees it.
  if (encoding.includes('\0')) {
    throw new EmbeddedNullError();
  }
  const normalized = normalizeEncoding(encoding);
  if (NON_TEXT_CODECS.has(normalized)) {
    throw new LookupError(
      `'${encoding}' is not a text encoding; use codecs.decode() to handle arbitrary codecs`,
    );
  }
  if (normalized === 'cp65001') {
    return 'utf_8';
  }
  const aliased =
    PY_CODEC_ALIASES[normalized] ??
    PY_CODEC_ALIASES[normalized.replaceAll('.', '_')];
  for (const candidate of [aliased, normalized]) {
    if (candidate !== undefined && TEXT_CODECS.has(candidate)) {
      return candidate;
    }
  }
  throw new LookupError(`unknown encoding: ${encoding}`);
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_LENIENT = new TextDecoder('utf-8', { ignoreBOM: true });

/** Index of the first byte at or above `limit` from `start`, or the length. */
function firstAtLeast(bytes: Uint8Array, limit: number, start = 0): number {
  for (let index = start; index < bytes.length; index += 1) {
    if ((bytes[index] ?? 0) >= limit) {
      return index;
    }
  }
  return bytes.length;
}

function decodeAscii(context: ErrorContext): string {
  const { bytes } = context;
  let invalid = firstAtLeast(bytes, ASCII_LIMIT);
  if (invalid === bytes.length) {
    return unitsToString(bytes);
  }
  const output = new TextBuilder();
  let start = 0;
  while (invalid < bytes.length) {
    output.latin1(bytes.subarray(start, invalid));
    start = decodeError(
      output,
      context,
      invalid,
      invalid + 1,
      'ordinal not in range(128)',
    );
    invalid = firstAtLeast(bytes, ASCII_LIMIT, start);
  }
  output.latin1(bytes.subarray(start));
  return output.toString();
}

const UTF8_ERRORS = [
  'invalid start byte',
  'unexpected end of data',
  'invalid continuation byte',
] as const;

/**
 * Length of the valid UTF-8 sequence at `index`; for an invalid one,
 * `-(length * 4 + reason)` with `reason` an index into UTF8_ERRORS (no
 * allocation: this runs once per invalid byte).
 */
function utf8Sequence(bytes: Uint8Array, index: number): number {
  const byte = bytes[index] ?? 0;
  let needed: number;
  let lower = 0x80;
  let upper = 0xbf;
  if (byte >= 0xc2 && byte <= 0xdf) {
    needed = 1;
  } else if (byte >= 0xe0 && byte <= 0xef) {
    needed = 2;
    lower = byte === 0xe0 ? 0xa0 : 0x80;
    upper = byte === 0xed ? 0x9f : 0xbf;
  } else if (byte >= 0xf0 && byte <= 0xf4) {
    needed = 3;
    lower = byte === 0xf0 ? 0x90 : 0x80;
    upper = byte === 0xf4 ? 0x8f : 0xbf;
  } else {
    return -4;
  }
  for (let offset = 1; offset <= needed; offset += 1) {
    const next = bytes[index + offset];
    if (next === undefined) {
      return -(offset * 4 + 1);
    }
    const min = offset === 1 ? lower : 0x80;
    const max = offset === 1 ? upper : 0xbf;
    if (next < min || next > max) {
      return -(offset * 4 + 2);
    }
  }
  return needed + 1;
}

// UTF-8 as CPython decodes it: one error per maximal invalid subpart. Valid
// runs are decoded in bulk with TextDecoder.
function decodeUtf8(context: ErrorContext, start = 0): string {
  const { bytes } = context;
  const input = start === 0 ? bytes : bytes.subarray(start);
  try {
    return UTF8_STRICT.decode(input);
  } catch {
    // Invalid somewhere: report it exactly below.
  }
  const output = new TextBuilder();
  let runStart = start;
  let index = start;
  while (index < bytes.length) {
    if ((bytes[index] ?? 0) < ASCII_LIMIT) {
      index += 1;
      continue;
    }
    const sequence = utf8Sequence(bytes, index);
    if (sequence > 0) {
      index += sequence;
      continue;
    }
    if (runStart < index) {
      output.text(UTF8_LENIENT.decode(bytes.subarray(runStart, index)));
    }
    const length = -sequence >> 2;
    const reason = UTF8_ERRORS[-sequence & 3] ?? '';
    index = decodeError(output, context, index, index + length, reason);
    runStart = index;
  }
  if (runStart < bytes.length) {
    output.text(UTF8_LENIENT.decode(bytes.subarray(runStart)));
  }
  return output.toString();
}

// Python names UTF-16/32 errors after the byte order in use.
function withByteOrder(
  context: ErrorContext,
  bits: 16 | 32,
  little: boolean,
): ErrorContext {
  return { ...context, codec: `utf_${bits}_${little ? 'le' : 'be'}` };
}

function decodeUtf16(
  input: ErrorContext,
  littleEndian: boolean | null,
): string {
  const { bytes } = input;
  let start = 0;
  let little = littleEndian ?? true;
  if (littleEndian === null && bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      start = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      start = 2;
      little = false;
    }
  }
  const context = withByteOrder(input, 16, little);
  const output = new TextBuilder();
  let index = start;
  while (index < bytes.length) {
    if (index + 1 >= bytes.length) {
      index = decodeError(
        output,
        context,
        index,
        bytes.length,
        'truncated data',
      );
      continue;
    }
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const unit = little ? first | (second << 8) : (first << 8) | second;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const third = bytes[index + 2];
      const fourth = bytes[index + 3];
      if (third === undefined || fourth === undefined) {
        index = decodeError(
          output,
          context,
          index,
          bytes.length,
          'unexpected end of data',
        );
        continue;
      }
      const low = little ? third | (fourth << 8) : (third << 8) | fourth;
      if (low >= 0xdc00 && low <= 0xdfff) {
        output.unit(unit);
        output.unit(low);
        index += 4;
        continue;
      }
      index = decodeError(
        output,
        context,
        index,
        index + 2,
        'illegal UTF-16 surrogate',
      );
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      index = decodeError(
        output,
        context,
        index,
        index + 2,
        'illegal encoding',
      );
      continue;
    }
    output.unit(unit);
    index += 2;
  }
  return output.toString();
}

function decodeUtf32(
  input: ErrorContext,
  littleEndian: boolean | null,
): string {
  const { bytes } = input;
  let start = 0;
  let little = littleEndian ?? true;
  if (littleEndian === null && bytes.length >= 4) {
    const bom = Array.from(bytes.subarray(0, 4)).join(',');
    if (bom === '255,254,0,0') {
      start = 4;
    } else if (bom === '0,0,254,255') {
      start = 4;
      little = false;
    }
  }
  const context = withByteOrder(input, 32, little);
  const output = new TextBuilder();
  let index = start;
  while (index < bytes.length) {
    if (index + 3 >= bytes.length) {
      index = decodeError(
        output,
        context,
        index,
        bytes.length,
        'truncated data',
      );
      continue;
    }
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1] ?? 0;
    const b2 = bytes[index + 2] ?? 0;
    const b3 = bytes[index + 3] ?? 0;
    const code = little
      ? (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
      : ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      index = decodeError(
        output,
        context,
        index,
        index + 4,
        code > 0x10ffff
          ? 'code point not in range(0x110000)'
          : 'code point in surrogate code point range(0xd800, 0xe000)',
      );
      continue;
    }
    output.codePoint(code);
    index += 4;
  }
  return output.toString();
}

// UTF-7 (RFC 2152), ported from CPython's PyUnicode_DecodeUTF7Stateful.
const PLUS = 0x2b;
const MINUS = 0x2d;

function base64Value(byte: number): number {
  if (byte >= 0x41 && byte <= 0x5a) {
    return byte - 0x41;
  }
  if (byte >= 0x61 && byte <= 0x7a) {
    return byte - 0x61 + 26;
  }
  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30 + 52;
  }
  if (byte === PLUS) {
    return 62;
  }
  if (byte === 0x2f) {
    return 63;
  }
  return -1;
}

function decodesDirect(byte: number): boolean {
  return byte < ASCII_LIMIT && byte !== PLUS;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

interface Utf7State {
  inShift: boolean;
  bits: number;
  buffer: number;
  surrogate: number;
  /** Where the current shift sequence (its `+`) starts. */
  shiftStart: number;
}

// One base-64 character of a shift sequence.
function utf7ShiftByte(
  state: Utf7State,
  value: number,
  output: TextBuilder,
): void {
  state.buffer = (state.buffer << 6) | value;
  state.bits += 6;
  if (state.bits < 16) {
    return;
  }
  const unit = state.buffer >>> (state.bits - 16);
  state.bits -= 16;
  state.buffer &= (1 << state.bits) - 1;
  if (state.surrogate !== 0) {
    if (isLowSurrogate(unit)) {
      output.unit(state.surrogate);
      output.unit(unit);
      state.surrogate = 0;
      return;
    }
    output.unit(state.surrogate);
    state.surrogate = 0;
  }
  if (isHighSurrogate(unit)) {
    state.surrogate = unit;
  } else {
    output.unit(unit);
  }
}

// The end of a base-64 section at `index` (a byte that isn't base 64):
// returns where decoding continues.
function leaveUtf7Shift(
  context: ErrorContext,
  state: Utf7State,
  index: number,
  output: TextBuilder,
): number {
  const byte = context.bytes[index] ?? 0;
  state.inShift = false;
  if (state.bits >= 6) {
    return decodeError(
      output,
      context,
      state.shiftStart,
      index + 1,
      'partial character in shift sequence',
    );
  }
  if (state.bits > 0 && state.buffer !== 0) {
    return decodeError(
      output,
      context,
      state.shiftStart,
      index + 1,
      'non-zero padding bits in shift sequence',
    );
  }
  if (state.surrogate !== 0 && decodesDirect(byte)) {
    output.unit(state.surrogate);
  }
  state.surrogate = 0;
  // '-' is absorbed; other terminating characters are kept.
  return byte === MINUS ? index + 1 : index;
}

function decodeUtf7(context: ErrorContext): string {
  const { bytes } = context;
  const output = new TextBuilder();
  const state: Utf7State = {
    inShift: false,
    bits: 0,
    buffer: 0,
    surrogate: 0,
    shiftStart: 0,
  };
  let index = 0;
  for (;;) {
    while (index < bytes.length) {
      const byte = bytes[index] ?? 0;
      if (state.inShift) {
        const value = base64Value(byte);
        if (value >= 0) {
          index += 1;
          utf7ShiftByte(state, value, output);
        } else {
          index = leaveUtf7Shift(context, state, index, output);
        }
        continue;
      }
      if (byte === PLUS) {
        const next = bytes[index + 1];
        if (next === MINUS) {
          output.unit(PLUS);
          index += 2;
        } else if (next !== undefined && base64Value(next) < 0) {
          index = decodeError(
            output,
            context,
            index,
            index + 2,
            'ill-formed sequence',
          );
        } else {
          state.inShift = true;
          state.surrogate = 0;
          state.bits = 0;
          state.buffer = 0;
          state.shiftStart = index;
          index += 1;
        }
        continue;
      }
      if (decodesDirect(byte)) {
        let end = index + 1;
        while (end < bytes.length && decodesDirect(bytes[end] ?? 0)) {
          end += 1;
        }
        output.latin1(bytes.subarray(index, end));
        index = end;
        continue;
      }
      index = decodeError(
        output,
        context,
        index,
        index + 1,
        'unexpected special character',
      );
    }
    const unterminated =
      state.inShift &&
      (state.surrogate !== 0 ||
        state.bits >= 6 ||
        (state.bits > 0 && state.buffer !== 0));
    state.inShift = false;
    if (!unterminated) {
      break;
    }
    index = decodeError(
      output,
      context,
      state.shiftStart,
      bytes.length,
      'unterminated shift sequence',
    );
    if (index >= bytes.length) {
      break;
    }
  }
  return output.toString();
}

const HEX_DIGIT = /^[0-9a-fA-F]$/u;

function decodeRawUnicodeEscape(context: ErrorContext): string {
  const { bytes } = context;
  const output = new TextBuilder();
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    if (byte !== 0x5c) {
      let end = index + 1;
      while (end < bytes.length && bytes[end] !== 0x5c) {
        end += 1;
      }
      output.latin1(bytes.subarray(index, end));
      index = end;
      continue;
    }
    // Only an odd run of backslashes before `u`/`U` starts an escape.
    let run = 0;
    while (bytes[index + run] === 0x5c) {
      run += 1;
    }
    const next = bytes[index + run];
    if (run % 2 === 0 || (next !== 0x75 && next !== 0x55)) {
      output.text('\\'.repeat(run));
      index += run;
      continue;
    }
    output.text('\\'.repeat(run - 1));
    const escapeStart = index + run - 1;
    const digits = next === 0x75 ? 4 : 8;
    let hex = '';
    let position = escapeStart + 2;
    while (
      hex.length < digits &&
      HEX_DIGIT.test(String.fromCharCode(bytes[position] ?? 0))
    ) {
      hex += String.fromCharCode(bytes[position] ?? 0);
      position += 1;
    }
    const code = hex.length < digits ? -1 : Number.parseInt(hex, 16);
    if (code === -1) {
      index = decodeError(
        output,
        context,
        escapeStart,
        position,
        `truncated \\${next === 0x75 ? 'u' : 'U'}XXXX escape`,
      );
    } else if (code > 0x10ffff) {
      index = decodeError(
        output,
        context,
        escapeStart,
        position,
        '\\Uxxxxxxxx out of range',
      );
    } else {
      output.codePoint(code);
      index = position;
    }
  }
  return output.toString();
}

const CHARMAP_CACHE = new Map<string, Uint16Array>();

// A charmap table as 256 code units (U+FFFE where undefined).
function charmapUnits(codec: string, table: string): Uint16Array {
  let units = CHARMAP_CACHE.get(codec);
  if (units === undefined) {
    units = new Uint16Array(LATIN1_LIMIT);
    const offset = table.length === LATIN1_LIMIT ? 0 : ASCII_LIMIT;
    for (let byte = 0; byte < offset; byte += 1) {
      units[byte] = byte;
    }
    for (let index = 0; index < table.length; index += 1) {
      units[offset + index] = table.charCodeAt(index);
    }
    CHARMAP_CACHE.set(codec, units);
  }
  return units;
}

function decodeCharmap(input: ErrorContext, table: string): string {
  const units = charmapUnits(input.codec, table);
  // Python reports these errors as the 'charmap' codec's.
  const context = { ...input, codec: 'charmap' };
  const { bytes } = context;
  // Fast path: map every byte into one array, up to the first undefined one.
  const mapped = new Uint16Array(bytes.length);
  let index = 0;
  for (; index < bytes.length; index += 1) {
    const unit = units[bytes[index] ?? 0] ?? UNDEFINED_MARK;
    if (unit === UNDEFINED_MARK) {
      break;
    }
    mapped[index] = unit;
  }
  if (index === bytes.length) {
    return bmpUnitsToString(mapped);
  }
  const output = new TextBuilder();
  output.text(bmpUnitsToString(mapped.subarray(0, index)));
  while (index < bytes.length) {
    const unit = units[bytes[index] ?? 0] ?? UNDEFINED_MARK;
    if (unit === UNDEFINED_MARK) {
      index = decodeError(
        output,
        context,
        index,
        index + 1,
        'character maps to <undefined>',
      );
    } else {
      output.unit(unit);
      index += 1;
    }
  }
  return output.toString();
}

const ESC = 0x1b;
const ISO2022_ESCAPES: ReadonlySet<string> = new Set([
  '(B',
  '(J',
  '(I',
  '$@',
  '$B',
]);

function isIso2022Escape(bytes: Uint8Array, index: number): boolean {
  return (
    bytes[index] === ESC &&
    ISO2022_ESCAPES.has(
      String.fromCharCode(bytes[index + 1] ?? 0, bytes[index + 2] ?? 0),
    )
  );
}

// WHATWG's iso-2022-jp decoder rejects an escape sequence directly followed
// by another one (as when two encoded words are joined); Python accepts it.
// The first sequence has no effect, so drop it.
function dropRedundantEscapes(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (isIso2022Escape(bytes, index) && isIso2022Escape(bytes, index + 3)) {
      index += 2;
      continue;
    }
    output[length] = bytes[index] ?? 0;
    length += 1;
  }
  return output.subarray(0, length);
}

// Approximation for the codecs without a port (see WHATWG_CODECS).
function decodeWhatwg(context: ErrorContext, label: string): string {
  const bytes =
    label === 'iso-2022-jp'
      ? dropRedundantEscapes(context.bytes)
      : context.bytes;
  if (context.errors === 'strict') {
    try {
      return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new UnicodeDecodeError(
        `'${context.codec}' codec can't decode bytes: illegal multibyte sequence`,
      );
    }
  }
  const text = new TextDecoder(label, { ignoreBOM: true }).decode(bytes);
  // WHATWG only reports errors as U+FFFD.
  return context.errors === 'ignore' ? text.replaceAll(REPLACEMENT, '') : text;
}

/**
 * Python's `bytes.decode(encoding, errors)`. Throws {@link LookupError} for
 * unknown codecs and {@link UnicodeDecodeError} under `strict`.
 */
export function pyDecode(
  bytes: Uint8Array,
  encoding: string,
  errors: CodecErrors = 'strict',
): string {
  const codec = lookupCodec(encoding);
  const context: ErrorContext = { codec, bytes, errors };
  switch (codec) {
    case 'ascii':
      return decodeAscii(context);
    case 'latin_1':
      return unitsToString(bytes);
    case 'utf_7':
      return decodeUtf7(context);
    case 'utf_8':
      return decodeUtf8(context);
    case 'utf_8_sig':
      return decodeUtf8(
        context,
        bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0,
      );
    case 'utf_16':
      return decodeUtf16(context, null);
    case 'utf_16_le':
      return decodeUtf16(context, true);
    case 'utf_16_be':
      return decodeUtf16(context, false);
    case 'utf_32':
      return decodeUtf32(context, null);
    case 'utf_32_le':
      return decodeUtf32(context, true);
    case 'utf_32_be':
      return decodeUtf32(context, false);
    case 'raw_unicode_escape':
      return decodeRawUnicodeEscape(context);
    case 'undefined':
      throw new UnicodeError('undefined encoding');
    default:
      break;
  }
  const table = PY_CHARMAP_TABLES[codec];
  if (table !== undefined) {
    return decodeCharmap(context, table);
  }
  const cjk = decodeCjk(context);
  if (cjk !== undefined) {
    return cjk;
  }
  const label = WHATWG_CODECS[codec];
  if (label !== undefined) {
    return decodeWhatwg(context, label);
  }
  throw new LookupError(`unknown encoding: ${encoding}`);
}

function escapeForBackslash(code: number): string {
  if (code < LATIN1_LIMIT) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  if (code < 0x10000) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `\\U${code.toString(16).padStart(8, '0')}`;
}

/** A growable byte buffer for the encoders' slow paths. */
class ByteBuilder {
  private buffer: Uint8Array;
  length = 0;

  constructor(capacity: number) {
    this.buffer = new Uint8Array(Math.max(capacity, 16));
  }

  push(byte: number): void {
    if (this.length === this.buffer.length) {
      this.grow(1);
    }
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  bytes(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.buffer.length) {
      this.grow(bytes.length);
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  private grow(extra: number): void {
    const next = new Uint8Array(
      Math.max(this.buffer.length * 2, this.length + extra),
    );
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  result(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

const TEXT_ENCODER = new TextEncoder();

/** Code point at UTF-16 index `index` of `text`. */
function codePointAt(text: string, index: number): number {
  return text.codePointAt(index) ?? 0;
}

function encodeError(
  codec: string,
  text: string,
  unitIndex: number,
  position: number,
  limit: number,
  reason: string,
): never {
  const first = codePointAt(text, unitIndex);
  let end = position + 1;
  let next = unitIndex + (first > 0xffff ? 2 : 1);
  while (next < text.length) {
    const code = codePointAt(text, next);
    if (code < limit) {
      break;
    }
    end += 1;
    next += code > 0xffff ? 2 : 1;
  }
  if (end - position === 1) {
    throw new UnicodeEncodeError(
      `'${codec}' codec can't encode character '${escapeForBackslash(first)}' in position ${position}: ${reason}`,
    );
  }
  throw new UnicodeEncodeError(
    `'${codec}' codec can't encode characters in position ${position}-${end - 1}: ${reason}`,
  );
}

// Index of the first UTF-16 unit at or above `limit`, or the length.
function firstUnitAtLeast(text: string, limit: number): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= limit) {
      return index;
    }
  }
  return text.length;
}

function encodeLimited(
  text: string,
  codec: string,
  limit: number,
  errors: CodecErrors,
): Uint8Array {
  const firstInvalid = firstUnitAtLeast(text, limit);
  if (
    firstInvalid === text.length &&
    (limit === ASCII_LIMIT ||
      firstUnitAtLeast(text, ASCII_LIMIT) === text.length)
  ) {
    // ASCII: the same bytes as UTF-8, and TextEncoder is native.
    return TEXT_ENCODER.encode(text);
  }
  const output = new Uint8Array(text.length);
  for (let index = 0; index < firstInvalid; index += 1) {
    output[index] = text.charCodeAt(index);
  }
  if (firstInvalid === text.length) {
    return output;
  }
  // Exact slow path: Python counts positions in code points.
  const builder = new ByteBuilder(text.length);
  builder.bytes(output.subarray(0, firstInvalid));
  let position = firstInvalid;
  let index = firstInvalid;
  while (index < text.length) {
    const code = codePointAt(text, index);
    const units = code > 0xffff ? 2 : 1;
    if (code < limit) {
      builder.push(code);
    } else if (
      errors === 'surrogateescape' &&
      code >= 0xdc80 &&
      code <= 0xdcff
    ) {
      builder.push(code - 0xdc00);
    } else if (errors === 'replace') {
      builder.push(0x3f);
    } else if (errors === 'backslashreplace') {
      builder.bytes(TEXT_ENCODER.encode(escapeForBackslash(code)));
    } else if (errors !== 'ignore') {
      encodeError(
        codec,
        text,
        index,
        position,
        limit,
        `ordinal not in range(${limit})`,
      );
    }
    index += units;
    position += 1;
  }
  return builder.result();
}

function encodeUtf8(text: string, errors: CodecErrors): Uint8Array {
  if (text.isWellFormed()) {
    return TEXT_ENCODER.encode(text);
  }
  // Lone surrogates: encode the well-formed runs in bulk.
  const builder = new ByteBuilder(text.length * 3);
  let position = 0;
  let runStart = 0;
  let index = 0;
  while (index < text.length) {
    const code = codePointAt(text, index);
    const units = code > 0xffff ? 2 : 1;
    if (code >= 0xd800 && code <= 0xdfff) {
      builder.bytes(TEXT_ENCODER.encode(text.slice(runStart, index)));
      if (errors === 'surrogateescape' && code >= 0xdc80 && code <= 0xdcff) {
        builder.push(code - 0xdc00);
      } else if (errors === 'replace') {
        builder.push(0x3f);
      } else if (errors === 'backslashreplace') {
        builder.bytes(TEXT_ENCODER.encode(escapeForBackslash(code)));
      } else if (errors !== 'ignore') {
        throw new UnicodeEncodeError(
          `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${position}: surrogates not allowed`,
        );
      }
      runStart = index + 1;
    }
    index += units;
    position += 1;
  }
  builder.bytes(TEXT_ENCODER.encode(text.slice(runStart)));
  return builder.result();
}

/** Python's `raw-unicode-escape` encoding. */
function encodeRawUnicodeEscape(text: string): Uint8Array {
  const firstWide = firstUnitAtLeast(text, LATIN1_LIMIT);
  const builder = new ByteBuilder(text.length);
  for (let index = 0; index < firstWide; index += 1) {
    builder.push(text.charCodeAt(index));
  }
  let index = firstWide;
  while (index < text.length) {
    const code = codePointAt(text, index);
    if (code < LATIN1_LIMIT) {
      builder.push(code);
    } else {
      const escape =
        code < 0x10000
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : `\\U${code.toString(16).padStart(8, '0')}`;
      builder.bytes(TEXT_ENCODER.encode(escape));
    }
    index += code > 0xffff ? 2 : 1;
  }
  return builder.result();
}

/**
 * Python's `str.encode(encoding, errors)` for the codecs the email code
 * needs: UTF-8, ASCII, Latin-1 and raw-unicode-escape.
 */
export function pyEncode(
  text: string,
  encoding: string,
  errors: CodecErrors = 'strict',
): Uint8Array {
  const codec = lookupCodec(encoding);
  switch (codec) {
    case 'utf_8':
      return encodeUtf8(text, errors);
    case 'ascii':
      return encodeLimited(text, 'ascii', ASCII_LIMIT, errors);
    case 'latin_1':
      return encodeLimited(text, 'latin-1', LATIN1_LIMIT, errors);
    case 'raw_unicode_escape':
      return encodeRawUnicodeEscape(text);
    default:
      throw new LookupError(`encoding not supported for encoding: ${encoding}`);
  }
}
