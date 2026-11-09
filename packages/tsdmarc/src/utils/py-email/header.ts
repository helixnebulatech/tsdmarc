// Port of Python's `email.header`: `decode_header()` (RFC 2047 encoded
// words) and the `Header.encode()` folding that compat32 uses to write
// headers back out.

import { a2bBase64, b64encode, BinasciiError } from '../py-binascii';
import { pyEncode, UnicodeEncodeError } from '../py-codecs';
import { pyIsSpace, pyLStrip, pyRepr, pySplitlines } from '../py-str';
import { hasSurrogates } from './charset';
import { HeaderParseError } from './errors';
import { rawUnicodeEscape } from './utils';

/** One `(decoded, charset)` pair of `decode_header()`. */
export type DecodedHeaderChunk = readonly [
  data: Uint8Array | string,
  charset: string | null,
];

const QP_HEADER_ESCAPE = /=[a-fA-F0-9]{2}/gu;

// `email.header.ecre`:
//   =\?(?P<charset>[^?]*?)\?(?P<encoding>[qQbB])\?(?P<encoded>.*?)\?=
// matched by hand rather than with a regular expression: a backtracking
// engine retries the lazy `.*?` from every `=?`, which is quadratic on
// values full of `=?` without a closing `?=`. Python's `[^?]` crosses
// newlines and `.` does not (it does match `\r`).

/** `str.find()` for start positions that never decrease (amortised linear). */
class ForwardFinder {
  private readonly text: string;
  private readonly needle: string;
  private from = 0;
  private found = Number.NaN;

  constructor(text: string, needle: string) {
    this.text = text;
    this.needle = needle;
  }

  find(from: number): number {
    // Nothing starts in [this.from, this.found), so the cached answer
    // holds for any start between them.
    if (from >= this.from && (this.found === -1 || this.found >= from)) {
      return this.found;
    }
    this.from = from;
    this.found = this.text.indexOf(this.needle, from);
    return this.found;
  }
}

/** One `ecre` match. */
export interface EncodedWordMatch {
  start: number;
  end: number;
  charset: string;
  encoding: string;
  encoded: string;
}

const ENCODINGS = 'qQbB';

/**
 * Finds `ecre` matches like `ecre.search(text, pos)` with a `pos` that
 * never decreases, in linear time overall.
 */
class EncodedWordScanner {
  private readonly text: string;
  private readonly opener: ForwardFinder;
  private readonly question: ForwardFinder;
  private readonly closer: ForwardFinder;
  private readonly newline: ForwardFinder;

  constructor(text: string) {
    this.text = text;
    this.opener = new ForwardFinder(text, '=?');
    this.question = new ForwardFinder(text, '?');
    this.closer = new ForwardFinder(text, '?=');
    this.newline = new ForwardFinder(text, '\n');
  }

  find(from: number): EncodedWordMatch | null {
    const { text } = this;
    let start = this.opener.find(from);
    while (start !== -1) {
      // The charset cannot hold `?`, so it ends at the first one.
      const question = this.question.find(start + 2);
      if (question === -1) {
        return null;
      }
      const encoding = text.charAt(question + 1);
      if (
        encoding !== '' &&
        ENCODINGS.includes(encoding) &&
        text.charAt(question + 2) === '?'
      ) {
        // The lazy `.*?` stops at the first `?=` unless a newline comes
        // first. Later starts only look further right, so without a `?=`
        // nothing can match.
        const close = this.closer.find(question + 3);
        if (close === -1) {
          return null;
        }
        const newline = this.newline.find(question + 3);
        if (newline === -1 || newline > close) {
          return {
            start,
            end: close + 2,
            charset: text.slice(start + 2, question),
            encoding,
            encoded: text.slice(question + 3, close),
          };
        }
      }
      start = this.opener.find(start + 1);
    }
    return null;
  }
}

/** `ecre.search(text) is not None`. */
export function hasEncodedWord(text: string): boolean {
  return new EncodedWordScanner(text).find(0) !== null;
}

/**
 * `ecre.split(text)`: the text before each match, then its charset,
 * encoding and encoded text, and the text after the last match.
 */
export function splitEncodedWords(text: string): string[] {
  const scanner = new EncodedWordScanner(text);
  const parts: string[] = [];
  let position = 0;
  let match = scanner.find(0);
  while (match !== null) {
    parts.push(
      text.slice(position, match.start),
      match.charset,
      match.encoding,
      match.encoded,
    );
    position = match.end;
    match = scanner.find(position);
  }
  parts.push(text.slice(position));
  return parts;
}

const COLON = 0x3a;
const NEWLINE = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;

/**
 * `email.header._embedded_header.search(text)` (`\n[^ \t]+:`) as a linear
 * scan: a colon preceded by a newline and at least one character, none of
 * them a space or a tab (newlines and colons do count).
 */
export function hasEmbeddedHeader(text: string): boolean {
  let lastNewline = -1;
  let previousNewline = -1;
  let lastBlank = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === COLON) {
      // The latest newline that leaves at least one character before the colon.
      const newline = lastNewline <= index - 2 ? lastNewline : previousNewline;
      if (newline !== -1 && newline > lastBlank) {
        return true;
      }
    } else if (char === NEWLINE) {
      previousNewline = lastNewline;
      lastNewline = index;
    } else if (char === SPACE || char === TAB) {
      lastBlank = index;
    }
  }
  return false;
}

/** `email.quoprimime.header_decode()`. */
export function quoprimimeHeaderDecode(text: string): string {
  return text
    .replaceAll('_', ' ')
    .replace(QP_HEADER_ESCAPE, match =>
      String.fromCharCode(Number.parseInt(match.slice(1), 16)),
    );
}

/** `email.base64mime.decode()`. */
export function base64mimeDecode(text: string): Uint8Array {
  if (!text) {
    return new Uint8Array();
  }
  return a2bBase64(rawUnicodeEscape(text));
}

function concatAll(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) {
    return chunks[0];
  }
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

const SPACE_BYTES = Uint8Array.of(0x20);

interface Word {
  text: string;
  encoding: 'q' | 'b' | null;
  charset: string | null;
}

/**
 * `email.header.decode_header()`: split a header value into decoded chunks.
 * Without encoded words it returns `[[header, null]]`; otherwise a list of
 * `[bytes, charset]`, where plain text is converted with
 * `raw-unicode-escape` exactly like Python.
 */
export function decodeHeader(header: string): DecodedHeaderChunk[] {
  if (!hasEncodedWord(header)) {
    return [[header, null]];
  }
  const words: Word[] = [];
  for (const line of pySplitlines(header)) {
    const parts = splitEncodedWords(line);
    // `parts` is text, then (charset, encoding, encoded, text) per match.
    for (let index = 0; index < parts.length; index += 4) {
      let unencoded = parts[index] ?? '';
      if (index === 0) {
        unencoded = pyLStrip(unencoded);
      }
      if (unencoded) {
        words.push({ text: unencoded, encoding: null, charset: null });
      }
      if (index + 1 < parts.length) {
        const charset = (parts[index + 1] ?? '').toLowerCase();
        const encoding = (parts[index + 2] ?? '').toLowerCase() as 'q' | 'b';
        const encoded = parts[index + 3] ?? '';
        words.push({ text: encoded, encoding, charset });
      }
    }
  }
  // Drop whitespace between two encoded words.
  // (Python collects the indexes and deletes them afterwards; deciding on
  // the original list and filtering is the same, without the quadratic
  // `del`.)
  const kept: Word[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as Word;
    const previous = words[index - 1];
    const next = words[index + 1];
    const dropped =
      previous !== undefined &&
      next !== undefined &&
      previous.encoding !== null &&
      next.encoding !== null &&
      pyIsSpace(word.text);
    if (!dropped) {
      kept.push(word);
    }
  }
  const decoded: [Uint8Array | string, string | null][] = [];
  for (const word of kept) {
    if (word.encoding === null) {
      decoded.push([word.text, word.charset]);
    } else if (word.encoding === 'q') {
      decoded.push([quoprimimeHeaderDecode(word.text), word.charset]);
    } else {
      let encoded = word.text;
      const padError = encoded.length % 4;
      if (padError) {
        encoded += '==='.slice(0, 4 - padError);
      }
      try {
        decoded.push([base64mimeDecode(encoded), word.charset]);
      } catch (error) {
        if (error instanceof BinasciiError) {
          throw new HeaderParseError('Base64 decoding error');
        }
        throw error;
      }
    }
  }
  // Runs of words with the same charset are joined (with a space between
  // unencoded ones); each run is concatenated once.
  const collapsed: [Uint8Array, string | null][] = [];
  let run: Uint8Array[] = [];
  let lastCharset: string | null = null;
  for (const [word, charset] of decoded) {
    const bytes = typeof word === 'string' ? rawUnicodeEscape(word) : word;
    if (run.length === 0) {
      run.push(bytes);
      lastCharset = charset;
    } else if (charset !== lastCharset) {
      collapsed.push([concatAll(run), lastCharset]);
      run = [bytes];
      lastCharset = charset;
    } else if (lastCharset === null) {
      run.push(SPACE_BYTES, bytes);
    } else {
      run.push(bytes);
    }
  }
  collapsed.push([concatAll(run), lastCharset]);
  return collapsed;
}

// ---------------------------------------------------------------------------
// Header.encode(), as compat32's `_fold()` calls it from the generator:
// `Header(value, header_name=name).encode(linesep='\n', maxlinelen=0)`.
//
// With maxlinelen=0 the line limit is 1,000,000 characters, so the
// splitting branch of `_ValueFormatter._append_chunk()` never runs for
// real-world values and is not ported.

const QP_HEADER_SAFE = new Set(
  '-!*+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
);

function qpHeaderLength(bytes: Uint8Array): number {
  let length = 0;
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    length += QP_HEADER_SAFE.has(char) || byte === 0x20 ? 1 : 3;
  }
  return length;
}

function qpHeaderEncode(bytes: Uint8Array, charset: string): string {
  if (bytes.length === 0) {
    return '';
  }
  let encoded = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (byte === 0x20) {
      encoded += '_';
    } else if (QP_HEADER_SAFE.has(char)) {
      encoded += char;
    } else {
      encoded += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return `=?${charset}?q?${encoded}?=`;
}

function base64HeaderLength(bytes: Uint8Array): number {
  const groups = Math.floor(bytes.length / 3);
  return groups * 4 + (bytes.length % 3 ? 4 : 0);
}

function base64HeaderEncode(bytes: Uint8Array, charset: string): string {
  if (bytes.length === 0) {
    return '';
  }
  return `=?${charset}?b?${b64encode(bytes)}?=`;
}

function shortestHeaderEncode(bytes: Uint8Array, charset: string): string {
  return base64HeaderLength(bytes) < qpHeaderLength(bytes)
    ? base64HeaderEncode(bytes, charset)
    : qpHeaderEncode(bytes, charset);
}

// `Charset('utf-8').header_encode_lines()` for a single line: SHORTEST of
// base64 and Q, chosen on the whole string.
function utf8HeaderEncode(text: string): string {
  return shortestHeaderEncode(pyEncode(text, 'utf-8'), 'utf-8');
}

// The same with `Charset('unknown-8bit')`, which compat32 uses for values
// holding surrogate-escaped bytes: the bytes are written back as they were.
function unknown8bitHeaderEncode(text: string): string {
  return shortestHeaderEncode(
    pyEncode(text, 'ascii', 'surrogateescape'),
    'unknown-8bit',
  );
}

type HeaderEncoder = (text: string) => string;

type Chunk = readonly [fws: string, text: string];

class Accumulator {
  parts: Chunk[] = [];
  initialSize: number;

  constructor(initialSize = 0) {
    this.initialSize = initialSize;
  }

  push(fws: string, text: string): void {
    this.parts.push([fws, text]);
  }

  pop(): Chunk {
    return this.parts.pop() ?? ['', ''];
  }

  get length(): number {
    let total = this.initialSize;
    for (const [fws, text] of this.parts) {
      total += fws.length + text.length;
    }
    return total;
  }

  toString(): string {
    return this.parts.map(([fws, text]) => fws + text).join('');
  }

  reset(): void {
    this.parts = [];
    this.initialSize = 0;
  }

  isOnlyWs(): boolean {
    return (
      this.initialSize === 0 &&
      (this.parts.length === 0 || pyIsSpace(this.toString()))
    );
  }
}

const FWS_RUN_SPLIT = /([ \t]+)/u;

class ValueFormatter {
  readonly lines: string[] = [];
  readonly current: Accumulator;

  constructor(headerLength: number) {
    this.current = new Accumulator(headerLength);
  }

  toString(linesep: string): string {
    this.newline();
    return this.lines.join(linesep);
  }

  newline(): void {
    const end = this.current.pop();
    if (end[0] !== ' ' || end[1] !== '') {
      this.current.push(end[0], end[1]);
    }
    if (this.current.length > 0) {
      if (this.current.isOnlyWs() && this.lines.length > 0) {
        this.lines[this.lines.length - 1] += this.current.toString();
      } else {
        this.lines.push(this.current.toString());
      }
    }
    this.current.reset();
  }

  addTransition(): void {
    this.current.push(' ', '');
  }

  /** `feed()`; `encoder` is `null` for us-ascii text (no encoded words). */
  feed(fws: string, text: string, encoder: HeaderEncoder | null): void {
    if (encoder === null) {
      const parts = (fws + text).split(FWS_RUN_SPLIT);
      if (parts[0]) {
        parts.unshift('');
      } else {
        parts.shift();
      }
      for (let index = 0; index + 1 < parts.length; index += 2) {
        this.current.push(parts[index] ?? '', parts[index + 1] ?? '');
      }
      return;
    }
    this.current.push(fws, encoder(text));
  }
}

/**
 * Fold one header for output like compat32's `policy.fold(name, value)`
 * with `max_line_length=0`, without the trailing line separator.
 */
export function encodeHeaderValue(
  name: string,
  value: string,
  linesep = '\n',
): string {
  // compat32 folds a value holding surrogate-escaped bytes as an
  // unknown-8bit Header; other non-ASCII text becomes UTF-8 encoded words.
  let encoder: HeaderEncoder | null = null;
  if (hasSurrogates(value)) {
    encoder = unknown8bitHeaderEncode;
  } else {
    try {
      pyEncode(value, 'ascii');
    } catch (error) {
      if (!(error instanceof UnicodeEncodeError)) {
        throw error;
      }
      encoder = utf8HeaderEncode;
    }
  }
  const formatter = new ValueFormatter(name.length + 2);
  // A single chunk: the transition logic between chunks never applies.
  const lines = pySplitlines(value);
  formatter.feed('', lines[0] ?? '', encoder);
  for (const line of lines.slice(1)) {
    formatter.newline();
    if (encoder === null) {
      const stripped = pyLStrip(line);
      formatter.feed(
        line.slice(0, line.length - stripped.length),
        stripped,
        encoder,
      );
    } else {
      formatter.feed(' ', ` ${pyLStrip(line)}`, encoder);
    }
  }
  if (lines.length > 1) {
    formatter.newline();
  }
  formatter.addTransition();
  const encoded = formatter.toString(linesep);
  if (hasEmbeddedHeader(encoded)) {
    throw new HeaderParseError(
      `header value appears to contain an embedded header: ${pyRepr(encoded)}`,
    );
  }
  return encoded;
}
