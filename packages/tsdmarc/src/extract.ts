// Report extraction, ported from parsedmarc/__init__.py: detect zip, gzip,
// XML or JSON content and return the report text.
//
// Decompression is capped at MAX_DECOMPRESSED_REPORT_SIZE (100 MiB): report
// attachments come from anyone who can send mail to a monitored mailbox, and
// deflate reaches ~1000:1 on degenerate input. gzip and zip go through ports
// of zlib's inflate and of CPython's `zipfile` (src/internal) so results and
// error messages match parsedmarc on corrupt input too.

import { createReadStream } from 'node:fs';

import { ParserError } from './errors';
import {
  MAGIC_GZIP,
  MAGIC_JSON,
  MAGIC_XML,
  MAGIC_XML_TAG,
  MAGIC_ZIP,
  startsWith,
} from './internal/magic';
import { errorText, excOrigin } from './internal/py';
import { readFirstZipMember, SLOW_ZIP_METHODS } from './internal/zipfile';
import { ZlibDecompressor } from './internal/zlib';
import { decodeUtf8 } from './utils/text';

/** Largest decompressed report accepted, in bytes. */
export const MAX_DECOMPRESSED_REPORT_SIZE: number = 100 * 1024 * 1024;

/**
 * Largest decompressed zip member accepted for the bzip2, LZMA and
 * Zstandard methods (12, 14, 93), in bytes. Their pure-TypeScript decoders
 * are much slower than inflate, and a 1 KB bzip2 member can expand to the
 * 100 MiB cap, costing seconds of CPU per attachment. Report senders use
 * deflate (RFC 7489 asks for zip or gzip), so these methods only need to
 * handle small reports. Not in parsedmarc.
 */
export const MAX_DECOMPRESSED_SLOW_CODEC_SIZE: number = 10 * 1024 * 1024;

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/u;

export interface ExtractOptions {
  /** Override the decompression cap (tests); defaults to 100 MiB. */
  maxDecompressedSize?: number;
  /**
   * Override the cap for bzip2, LZMA and Zstandard zip members (tests);
   * defaults to 10 MiB, and never exceeds `maxDecompressedSize`.
   */
  maxSlowCodecSize?: number;
  /**
   * Largest stream or file read, in bytes; `0` disables the check. Defaults
   * to 100 MiB, the largest report once decompressed. Not in parsedmarc.
   */
  maxInputSize?: number;
  /** Told how many bytes were decompressed (not called for plain content). */
  onDecompressed?: (size: number) => void;
}

/**
 * Python's `base64.b64decode(text, validate=True)`: `null` when the text is
 * not strict base64 (Python raises `binascii.Error` and parsedmarc then
 * returns the text unchanged).
 */
function strictBase64Decode(text: string): Uint8Array | null {
  if (!BASE64_TEXT.test(text)) {
    return null;
  }
  const data = text.replace(/=+$/u, '');
  const padding = text.length - data.length;
  const remainder = data.length % 4;
  if (remainder === 1) {
    return null;
  }
  if (remainder !== 0 && padding < 4 - remainder) {
    return null;
  }
  return new Uint8Array(Buffer.from(data, 'base64'));
}

function limitError(limit: number): ParserError {
  return new ParserError(`Decompressed report exceeds the ${limit} byte limit`);
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (second.length === 0) {
    return first;
  }
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}

/**
 * Decompress the first member of a gzip stream, refusing to produce more
 * than `limit` bytes (parsedmarc's `_decompress_gzip_bounded`). Corrupt
 * data raises zlib's errors (`Error -3 while decompressing data: ...`);
 * trailing bytes after the first member are ignored.
 */
export function decompressGzipBounded(
  data: Uint8Array,
  limit: number = MAX_DECOMPRESSED_REPORT_SIZE,
): Uint8Array {
  const decompressor = new ZlibDecompressor(31);
  const decompressed = decompressor.decompress(data, limit + 1);
  if (decompressed.length > limit) {
    throw limitError(limit);
  }
  // Bounded: a call that returned fewer than `limit + 1` bytes consumed all
  // of its input or reached the end of the stream.
  const result = concatBytes(decompressed, decompressor.flush());
  if (!decompressor.eof) {
    throw new ParserError('Incomplete or truncated gzip stream');
  }
  return result;
}

interface Limits {
  limit: number;
  slowCodecLimit: number;
  onDecompressed?: ((size: number) => void) | undefined;
}

/**
 * Read the first member of a zip archive, bounded to `limit` bytes, or to
 * `slowCodecLimit` for the bzip2, LZMA and Zstandard methods.
 */
function readZipReport(data: Uint8Array, limits: Limits): Uint8Array {
  const chosen = { limit: limits.limit, codec: '' };
  const member = readFirstZipMember(data, compressType => {
    const codec = SLOW_ZIP_METHODS.get(compressType);
    if (codec !== undefined && limits.slowCodecLimit < limits.limit) {
      chosen.limit = limits.slowCodecLimit;
      chosen.codec = codec;
    }
    return chosen.limit + 1;
  });
  if (member.length > chosen.limit) {
    if (chosen.codec) {
      throw new ParserError(
        `Decompressed ${chosen.codec} report exceeds the ${chosen.limit} byte limit for bzip2, LZMA and Zstandard zip members`,
      );
    }
    throw limitError(chosen.limit);
  }
  return member;
}

function extractFromBytes(data: Uint8Array, limits: Limits): string {
  const { limit } = limits;
  if (startsWith(data, MAGIC_ZIP)) {
    const member = readZipReport(data, limits);
    limits.onDecompressed?.(member.length);
    return decodeUtf8(member, 'ignore');
  }
  if (startsWith(data, MAGIC_GZIP)) {
    const decompressed = decompressGzipBounded(data, limit);
    limits.onDecompressed?.(decompressed.length);
    return decodeUtf8(decompressed, 'ignore');
  }
  if (
    startsWith(data, MAGIC_XML) ||
    startsWith(data, MAGIC_XML_TAG) ||
    startsWith(data, MAGIC_JSON)
  ) {
    return decodeUtf8(data, 'ignore');
  }
  throw new ParserError('Not a valid zip, gzip, json, or xml file');
}

function invalidArchive(error: unknown): ParserError {
  return new ParserError(
    `Invalid archive file: ${errorText(error)}${excOrigin(error)}`,
    { cause: error },
  );
}

/**
 * Extract report text from zip- or gzip-compressed content, or return
 * plain XML/JSON content decoded as-is. A string is first decoded as strict
 * base64; a string that is not valid base64 is returned unchanged.
 */
export function extractReport(
  content: string | Uint8Array | ArrayBuffer,
  options: ExtractOptions = {},
): string {
  const limits: Limits = {
    limit: options.maxDecompressedSize ?? MAX_DECOMPRESSED_REPORT_SIZE,
    slowCodecLimit:
      options.maxSlowCodecSize ?? MAX_DECOMPRESSED_SLOW_CODEC_SIZE,
    onDecompressed: options.onDecompressed,
  };
  let data: Uint8Array;
  if (typeof content === 'string') {
    const decoded = strictBase64Decode(content.replaceAll(/[\r\n]/gu, ''));
    if (decoded === null) {
      return content;
    }
    data = decoded;
  } else {
    data = content instanceof Uint8Array ? content : new Uint8Array(content);
  }
  try {
    return extractFromBytes(data, limits);
  } catch (error) {
    throw invalidArchive(error);
  }
}

export type ReportStream =
  | AsyncIterable<Uint8Array | string>
  | ReadableStream<Uint8Array>;

/** Read a whole stream, failing as soon as it passes `limit` bytes. */
async function readBounded(
  stream: ReportStream,
  limit: number,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    if (typeof chunk === 'string') {
      throw new ParserError('File objects must be opened in binary (rb) mode');
    }
    size += chunk.length;
    if (limit > 0 && size > limit) {
      throw new ParserError(`Report input exceeds the ${limit} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Read a whole stream and extract the report from it. A stream that yields
 * text instead of bytes is rejected, like a Python file opened in text mode.
 */
export async function extractReportFromStream(
  stream: ReportStream,
  options: ExtractOptions = {},
): Promise<string> {
  let data: Buffer;
  try {
    data = await readBounded(
      stream,
      options.maxInputSize ?? MAX_DECOMPRESSED_REPORT_SIZE,
    );
  } catch (error) {
    throw invalidArchive(error);
  }
  return extractReport(data, options);
}

/** Extract the report from a file. */
export async function extractReportFromFilePath(
  filePath: string,
  options: ExtractOptions = {},
): Promise<string> {
  let data: Uint8Array;
  try {
    data = await readBounded(
      createReadStream(filePath),
      options.maxInputSize ?? MAX_DECOMPRESSED_REPORT_SIZE,
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new ParserError('File was not found', { cause: error });
    }
    throw error;
  }
  return extractReport(data, options);
}
