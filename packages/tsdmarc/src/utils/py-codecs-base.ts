// Shared pieces of the Python codec ports (py-codecs.ts, py-codecs-cjk.ts):
// error classes, Python's decode error handlers and a fast text builder.

/** Python's `LookupError` (unknown codec). */
export class LookupError extends Error {
  override name = 'LookupError';
}

/** Python's `UnicodeError`. */
export class UnicodeError extends Error {
  override name = 'UnicodeError';
}

/** Python's `UnicodeDecodeError`. */
export class UnicodeDecodeError extends UnicodeError {
  override name = 'UnicodeDecodeError';
}

/** Python's `UnicodeEncodeError`. */
export class UnicodeEncodeError extends UnicodeError {
  override name = 'UnicodeEncodeError';
}

/** Python's codec error handlers that the email code uses. */
export type CodecErrors =
  | 'strict'
  | 'replace'
  | 'ignore'
  | 'surrogateescape'
  | 'backslashreplace';

export const ASCII_LIMIT = 0x80;
export const LATIN1_LIMIT = 0x100;
export const REPLACEMENT = '�';
const REPLACEMENT_UNIT = 0xfffd;

/** A decode call: the codec (Python module name), input and error handler. */
export interface ErrorContext {
  codec: string;
  bytes: Uint8Array;
  errors: CodecErrors;
}

// The name Python reports in UnicodeDecodeError messages.
const ERROR_NAMES: Readonly<Record<string, string>> = {
  ascii: 'ascii',
  latin_1: 'latin-1',
  utf_7: 'utf7',
  utf_8: 'utf-8',
  utf_8_sig: 'utf-8',
  utf_16: 'utf-16',
  utf_16_be: 'utf-16-be',
  utf_16_le: 'utf-16-le',
  utf_32: 'utf-32',
  utf_32_be: 'utf-32-be',
  utf_32_le: 'utf-32-le',
  raw_unicode_escape: 'rawunicodeescape',
};

function failDecode(
  context: ErrorContext,
  start: number,
  end: number,
  reason: string,
): never {
  const name = ERROR_NAMES[context.codec] ?? context.codec;
  if (end - start === 1) {
    const byte = (context.bytes[start] ?? 0).toString(16).padStart(2, '0');
    throw new UnicodeDecodeError(
      `'${name}' codec can't decode byte 0x${byte} in position ${start}: ${reason}`,
    );
  }
  throw new UnicodeDecodeError(
    `'${name}' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`,
  );
}

// CPython's surrogateescape handler escapes at most this many bytes per
// call, stopping at the first ASCII byte; decoding resumes after them.
const SURROGATEESCAPE_MAX = 4;

/**
 * Python's decode error handlers for the bytes `start..end`: appends the
 * replacement text to `output` and returns where decoding resumes, or
 * throws a {@link UnicodeDecodeError}.
 */
export function decodeError(
  output: TextBuilder,
  context: ErrorContext,
  start: number,
  end: number,
  reason: string,
): number {
  const { bytes } = context;
  switch (context.errors) {
    case 'replace':
      output.unit(REPLACEMENT_UNIT);
      return end;
    case 'ignore':
      return end;
    case 'surrogateescape': {
      let resume = start;
      while (
        resume - start < SURROGATEESCAPE_MAX &&
        resume < end &&
        (bytes[resume] ?? 0) >= ASCII_LIMIT
      ) {
        resume += 1;
      }
      if (resume === start) {
        return failDecode(context, start, end, reason);
      }
      for (let index = start; index < resume; index += 1) {
        output.unit(0xdc00 + (bytes[index] ?? 0));
      }
      return resume;
    }
    case 'backslashreplace':
      for (let index = start; index < end; index += 1) {
        output.text(`\\x${(bytes[index] ?? 0).toString(16).padStart(2, '0')}`);
      }
      return end;
    default:
      return failDecode(context, start, end, reason);
  }
}

const CHUNK_UNITS = 0x2000;
const ASCII_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

function isAscii(bytes: Uint8Array): boolean {
  // Indexed loops: typed array iterators are slow on JavaScriptCore.
  for (let index = 0; index < bytes.length; index += 1) {
    if ((bytes[index] ?? 0) >= ASCII_LIMIT) {
      return false;
    }
  }
  return true;
}

// `fromCharCode.apply` takes a typed array as is; spreading it iterates
// element by element and is several times slower on JavaScriptCore.
function fromCharCodes(units: Uint16Array | Uint8Array): string {
  return Reflect.apply(String.fromCharCode, null, units) as string;
}

/** UTF-16 code units (or Latin-1 bytes) as a string, in chunks. */
export function unitsToString(units: Uint16Array | Uint8Array): string {
  if (units instanceof Uint8Array && isAscii(units)) {
    return ASCII_DECODER.decode(units);
  }
  if (units.length <= CHUNK_UNITS) {
    return fromCharCodes(units);
  }
  const parts: string[] = [];
  for (let start = 0; start < units.length; start += CHUNK_UNITS) {
    parts.push(fromCharCodes(units.subarray(start, start + CHUNK_UNITS)));
  }
  return parts.join('');
}

const LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
const UTF16LE_DECODER = new TextDecoder('utf-16le', { ignoreBOM: true });

/**
 * Code units known to hold no surrogates (BMP characters only) as a
 * string: TextDecoder is much faster than `fromCharCode` for these on
 * JavaScriptCore. It would replace lone surrogates, hence the restriction.
 */
export function bmpUnitsToString(units: Uint16Array): string {
  return LITTLE_ENDIAN ? UTF16LE_DECODER.decode(units) : unitsToString(units);
}

const BUILDER_UNITS = 0x10000;
// Most decoded text is a short header word: the buffer starts small and
// doubles, instead of costing every decode 128 KiB.
const BUILDER_INITIAL_UNITS = 0x100;
// Shorter pieces are copied into the builder's buffer instead of being
// kept as separate strings.
const SHORT_COPY = 256;

/**
 * Collects decoded text as UTF-16 code units: one string concatenation per
 * 64 Ki units instead of one per character, which is what makes decoding
 * large attachments fast.
 */
export class TextBuilder {
  private buffer = new Uint16Array(BUILDER_INITIAL_UNITS);
  private length = 0;
  private readonly parts: string[] = [];

  /** Append one UTF-16 code unit. */
  unit(unit: number): void {
    if (this.length === this.buffer.length) {
      this.makeRoom();
    }
    this.buffer[this.length] = unit;
    this.length += 1;
  }

  /** Append a code point (two units above U+FFFF). */
  codePoint(code: number): void {
    if (code > 0xffff) {
      const offset = code - 0x10000;
      this.unit(0xd800 + (offset >> 10));
      this.unit(0xdc00 + (offset & 0x3ff));
    } else {
      this.unit(code);
    }
  }

  /** Append bytes as Latin-1 (or ASCII) characters. */
  latin1(bytes: Uint8Array): void {
    if (bytes.length <= SHORT_COPY) {
      for (let index = 0; index < bytes.length; index += 1) {
        this.unit(bytes[index] ?? 0);
      }
      return;
    }
    this.flush();
    this.parts.push(unitsToString(bytes));
  }

  /** Append a string. */
  text(text: string): void {
    if (text.length <= SHORT_COPY) {
      for (let index = 0; index < text.length; index += 1) {
        this.unit(text.charCodeAt(index));
      }
      return;
    }
    this.flush();
    this.parts.push(text);
  }

  private makeRoom(): void {
    if (this.buffer.length === BUILDER_UNITS) {
      this.flush();
      return;
    }
    const larger = new Uint16Array(this.buffer.length * 2);
    larger.set(this.buffer);
    this.buffer = larger;
  }

  private flush(): void {
    if (this.length > 0) {
      this.parts.push(unitsToString(this.buffer.subarray(0, this.length)));
      this.length = 0;
    }
  }

  toString(): string {
    this.flush();
    return this.parts.join('');
  }
}
