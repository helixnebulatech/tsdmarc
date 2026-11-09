// Port of the read path of CPython 3.14's `zipfile` (Lib/zipfile/__init__.py)
// that parsedmarc's `extract_report()` runs:
//
//     zipfile.ZipFile(BytesIO(data)).open(namelist()[0]).read(limit + 1)
//
// Every check, its order and its error message follow CPython, including
// the `io.BytesIO` seek/read errors a corrupt archive can trigger
// (`negative seek value -45`). Sizes and offsets are bigints because zip64
// fields are unsigned 64-bit values and Python's ints are unbounded.
//
// The only deliberate difference: bzip2, LZMA and Zstandard members are
// never decompressed past the bytes requested (Python's decompressors have
// no output limit in zipfile). See `readFirstZipMember()`.

import { pyDecode } from '../utils/py-codecs';
import { pyRepr } from '../utils/py-str';
import { Bz2Decompressor } from './bz2';
import { crc32Update } from './crc';
import { ZipLzmaDecompressor } from './lzma';
import { ZlibDecompressor } from './zlib';
import { ZstdDecompressor } from './zstd';

/** Python's `zipfile.BadZipFile`. */
export class BadZipFile extends Error {
  override name = 'BadZipFile';
}

/** Python's `NotImplementedError`. */
export class NotImplementedError extends Error {
  override name = 'NotImplementedError';
}

/** Python's `RuntimeError`. */
export class PyRuntimeError extends Error {
  override name = 'RuntimeError';
}

/** Python's `EOFError`. */
export class PyEOFError extends Error {
  override name = 'EOFError';
}

/** Python's `OSError`. */
export class PyOSError extends Error {
  override name = 'OSError';
}

/** Python's `ValueError` (from `io.BytesIO.seek`). */
class PyValueError extends Error {
  override name = 'ValueError';
}

/** Python's `OverflowError` (64-bit zip fields that don't fit `ssize_t`). */
class PyOverflowError extends Error {
  override name = 'OverflowError';
}

/** Python's `IndexError`. */
class PyIndexError extends Error {
  override name = 'IndexError';
}

const SSIZE_MAX = 2n ** 63n - 1n;

/** The subset of `io.BytesIO` zipfile uses, with CPython's errors. */
class BytesIO {
  private position = 0n;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get size(): bigint {
    return BigInt(this.data.length);
  }

  seek(offset: bigint, whence: 0 | 2 = 0): bigint {
    if (offset > SSIZE_MAX || offset < -SSIZE_MAX - 1n) {
      throw new PyOverflowError('Python int too large to convert to C ssize_t');
    }
    if (offset < 0n && whence === 0) {
      throw new PyValueError(`negative seek value ${offset}`);
    }
    const position = whence === 2 ? offset + this.size : offset;
    this.position = position < 0n ? 0n : position;
    return this.position;
  }

  tell(): bigint {
    return this.position;
  }

  /** `read(count)`; a negative count reads to the end. */
  read(count: bigint | number): Uint8Array {
    const wanted = BigInt(count);
    if (wanted > SSIZE_MAX) {
      throw new PyOverflowError("cannot fit 'int' into an index-sized integer");
    }
    if (this.position >= this.size) {
      return new Uint8Array(0);
    }
    const available = this.size - this.position;
    const length = wanted < 0n || wanted > available ? available : wanted;
    const start = Number(this.position);
    this.position += length;
    return this.data.subarray(start, start + Number(length));
  }
}

function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] as number) | ((data[offset + 1] as number) << 8);
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    (readUint16(data, offset) | (readUint16(data, offset + 2) << 16)) >>> 0
  );
}

function readUint64(data: Uint8Array, offset: number): bigint {
  return (
    BigInt(readUint32(data, offset)) |
    (BigInt(readUint32(data, offset + 4)) << 32n)
  );
}

function hasSignature(
  data: Uint8Array,
  offset: number,
  signature: readonly number[],
): boolean {
  return signature.every((byte, index) => data[offset + index] === byte);
}

const STRING_END_ARCHIVE = [0x50, 0x4b, 0x05, 0x06];
const STRING_CENTRAL_DIR = [0x50, 0x4b, 0x01, 0x02];
const STRING_FILE_HEADER = [0x50, 0x4b, 0x03, 0x04];
const STRING_END_ARCHIVE64_LOCATOR = [0x50, 0x4b, 0x06, 0x07];
const STRING_END_ARCHIVE64 = [0x50, 0x4b, 0x06, 0x06];
const SIZE_END_CENT_DIR = 22;
const SIZE_CENTRAL_DIR = 46;
const SIZE_FILE_HEADER = 30;
const SIZE_END_CENT_DIR64_LOCATOR = 20;
const SIZE_END_CENT_DIR64 = 56;
const ZIP_MAX_COMMENT = 0xff_ff;
const MAX_EXTRACT_VERSION = 63;

const MASK_ENCRYPTED = 1 << 0;
const MASK_COMPRESSED_PATCH = 1 << 5;
const MASK_STRONG_ENCRYPTION = 1 << 6;
const MASK_UTF_FILENAME = 1 << 11;

const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const ZIP_BZIP2 = 12;
const ZIP_LZMA = 14;
const ZIP_ZSTANDARD = 93;

const UINT32_MAX = 0xff_ff_ff_ffn;
const UINT64_MAX = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/** zipfile's `_EndRecData` result ("end of central directory" record). */
interface EndRecord {
  diskNumber: number;
  diskStart: number;
  size: bigint;
  offset: bigint;
  /** File offset of the record (`_ECD_LOCATION`). */
  location: bigint;
}

function unpackEndRecord(data: Uint8Array, location: bigint): EndRecord {
  return {
    diskNumber: readUint16(data, 4),
    diskStart: readUint16(data, 6),
    location,
    offset: BigInt(readUint32(data, 16)),
    size: BigInt(readUint32(data, 12)),
  };
}

/** zipfile `_EndRecData64`: update `endrec` from the zip64 records. */
function endRecData64(
  file: BytesIO,
  location: bigint,
  endrec: EndRecord,
): EndRecord {
  let offset = location - BigInt(SIZE_END_CENT_DIR64_LOCATOR);
  if (offset < 0n) {
    return endrec;
  }
  file.seek(offset);
  let data = file.read(SIZE_END_CENT_DIR64_LOCATOR);
  if (data.length !== SIZE_END_CENT_DIR64_LOCATOR) {
    throw new PyOSError('Unknown I/O error');
  }
  if (!hasSignature(data, 0, STRING_END_ARCHIVE64_LOCATOR)) {
    return endrec;
  }
  const diskNumber = readUint32(data, 4);
  const relativeOffset = readUint64(data, 8);
  const disks = readUint32(data, 16);
  if (diskNumber !== 0 || disks > 1) {
    throw new BadZipFile('zipfiles that span multiple disks are not supported');
  }
  offset -= BigInt(SIZE_END_CENT_DIR64);
  if (relativeOffset > offset) {
    throw new BadZipFile('Corrupt zip64 end of central directory locator');
  }
  file.seek(relativeOffset);
  let extraSize = offset - relativeOffset;
  data = file.read(SIZE_END_CENT_DIR64);
  if (data.length !== SIZE_END_CENT_DIR64) {
    throw new PyOSError('Unknown I/O error');
  }
  if (
    !hasSignature(data, 0, STRING_END_ARCHIVE64) &&
    relativeOffset !== offset
  ) {
    // Maybe prepended data: assume no "zip64 extensible data".
    file.seek(offset);
    extraSize = 0n;
    data = file.read(SIZE_END_CENT_DIR64);
    if (data.length !== SIZE_END_CENT_DIR64) {
      throw new PyOSError('Unknown I/O error');
    }
  }
  if (!hasSignature(data, 0, STRING_END_ARCHIVE64)) {
    throw new BadZipFile('Zip64 end of central directory record not found');
  }
  const recordSize = readUint64(data, 4);
  const directorySize = readUint64(data, 40);
  const directoryOffset = readUint64(data, 48);
  if (
    directoryOffset + directorySize !== relativeOffset ||
    recordSize + 12n !== BigInt(SIZE_END_CENT_DIR64) + extraSize
  ) {
    throw new BadZipFile('Corrupt zip64 end of central directory record');
  }
  return {
    diskNumber: readUint32(data, 16),
    diskStart: readUint32(data, 20),
    location: offset - extraSize,
    offset: directoryOffset,
    size: directorySize,
  };
}

/** zipfile `_EndRecData`: `null` when no end record is found. */
function endRecData(file: BytesIO): EndRecord | null {
  const fileSize = file.seek(0n, 2);
  file.seek(BigInt(-SIZE_END_CENT_DIR), 2);
  let data = file.read(SIZE_END_CENT_DIR);
  if (
    data.length === SIZE_END_CENT_DIR &&
    hasSignature(data, 0, STRING_END_ARCHIVE) &&
    data[20] === 0 &&
    data[21] === 0
  ) {
    const location = fileSize - BigInt(SIZE_END_CENT_DIR);
    return endRecData64(file, location, unpackEndRecord(data, location));
  }
  const maxCommentStart = Math.max(
    Number(fileSize) - ZIP_MAX_COMMENT - SIZE_END_CENT_DIR,
    0,
  );
  file.seek(BigInt(maxCommentStart));
  data = file.read(ZIP_MAX_COMMENT + SIZE_END_CENT_DIR);
  const start = lastIndexOf(data, STRING_END_ARCHIVE);
  if (start < 0) {
    return null;
  }
  const record = data.subarray(start, start + SIZE_END_CENT_DIR);
  if (record.length !== SIZE_END_CENT_DIR) {
    // The archive is corrupt.
    return null;
  }
  const location = BigInt(maxCommentStart + start);
  return endRecData64(file, location, unpackEndRecord(record, location));
}

function lastIndexOf(data: Uint8Array, needle: readonly number[]): number {
  for (let index = data.length - needle.length; index >= 0; index -= 1) {
    if (hasSignature(data, index, needle)) {
      return index;
    }
  }
  return -1;
}

/** Python's `repr(bytes)`. */
export function pyBytesRepr(data: Uint8Array): string {
  const quote = data.includes(0x27) && !data.includes(0x22) ? '"' : "'";
  let body = '';
  for (const byte of data) {
    if (byte === 0x5c) {
      body += '\\\\';
    } else if (byte === quote.charCodeAt(0)) {
      body += `\\${quote}`;
    } else if (byte === 0x09) {
      body += '\\t';
    } else if (byte === 0x0a) {
      body += '\\n';
    } else if (byte === 0x0d) {
      body += '\\r';
    } else if (byte < 0x20 || byte >= 0x7f) {
      body += `\\x${byte.toString(16).padStart(2, '0')}`;
    } else {
      body += String.fromCharCode(byte);
    }
  }
  return `b${quote}${body}${quote}`;
}

/** zipfile `_sanitize_filename` on POSIX: cut at the first NUL. */
function sanitizeFilename(filename: string): string {
  const nul = filename.indexOf('\0');
  return nul >= 0 ? filename.slice(0, nul) : filename;
}

/** The `ZipInfo` attributes the read path uses. */
interface ZipInfo {
  origFilename: string;
  filename: string;
  flagBits: number;
  compressType: number;
  crc: number;
  compressSize: bigint;
  fileSize: bigint;
  headerOffset: bigint;
  extra: Uint8Array;
  endOffset: bigint | null;
}

/** `ZipInfo._decodeExtra`: zip64 sizes and the Unicode path field. */
function decodeExtra(info: ZipInfo, filenameCrc: number): void {
  let extra = info.extra;
  while (extra.length >= 4) {
    const type = readUint16(extra, 0);
    const length = readUint16(extra, 2);
    if (length + 4 > extra.length) {
      throw new BadZipFile(
        `Corrupt extra field ${type.toString(16).padStart(4, '0')} (size=${length})`,
      );
    }
    const data = extra.subarray(4, length + 4);
    if (type === 0x00_01) {
      decodeZip64Extra(info, data);
    } else if (type === 0x70_75) {
      decodeUnicodePathExtra(info, data, filenameCrc);
    }
    extra = extra.subarray(length + 4);
  }
}

function decodeZip64Extra(info: ZipInfo, field: Uint8Array): void {
  let data = field;
  const take = (name: string): bigint => {
    if (data.length < 8) {
      throw new BadZipFile(`Corrupt zip64 extra field. ${name} not found.`);
    }
    const value = readUint64(data, 0);
    data = data.subarray(8);
    return value;
  };
  if (info.fileSize === UINT64_MAX || info.fileSize === UINT32_MAX) {
    info.fileSize = take('File size');
  }
  if (info.compressSize === UINT32_MAX) {
    info.compressSize = take('Compress size');
  }
  if (info.headerOffset === UINT32_MAX) {
    info.headerOffset = take('Header offset');
  }
}

function decodeUnicodePathExtra(
  info: ZipInfo,
  data: Uint8Array,
  filenameCrc: number,
): void {
  if (data.length < 5) {
    throw new BadZipFile('Corrupt unicode path extra field (0x7075)');
  }
  if (data[0] !== 1 || readUint32(data, 1) !== filenameCrc) {
    return;
  }
  let name: string;
  try {
    name = pyDecode(data.subarray(5), 'utf-8');
  } catch {
    throw new BadZipFile(
      'Corrupt unicode path extra field (0x7075): invalid utf-8 bytes',
    );
  }
  // An empty name only triggers a warning in Python.
  if (name !== '') {
    info.filename = sanitizeFilename(name);
  }
}

/** `ZipFile._RealGetContents`: parse every central directory entry. */
function realGetContents(file: BytesIO): {
  filelist: ZipInfo[];
  nameToInfo: Map<string, ZipInfo>;
} {
  const endrec = endRecData(file);
  if (endrec === null) {
    throw new BadZipFile('File is not a zip file');
  }
  const concat = endrec.location - endrec.size - endrec.offset;
  const startDir = endrec.offset + concat;
  if (startDir < 0n) {
    throw new BadZipFile('Bad offset for central directory');
  }
  file.seek(startDir);
  const directory = new BytesIO(file.read(endrec.size));
  const filelist: ZipInfo[] = [];
  const nameToInfo = new Map<string, ZipInfo>();
  let total = 0n;
  while (total < endrec.size) {
    const centdir = directory.read(SIZE_CENTRAL_DIR);
    if (centdir.length !== SIZE_CENTRAL_DIR) {
      throw new BadZipFile('Truncated central directory');
    }
    if (!hasSignature(centdir, 0, STRING_CENTRAL_DIR)) {
      throw new BadZipFile('Bad magic number for central directory');
    }
    const filenameLength = readUint16(centdir, 28);
    const extraLength = readUint16(centdir, 30);
    const commentLength = readUint16(centdir, 32);
    const rawFilename = directory.read(filenameLength);
    const filenameCrc = crc32Update(0, rawFilename);
    const flagBits = readUint16(centdir, 8);
    const filename = pyDecode(
      rawFilename,
      flagBits & MASK_UTF_FILENAME ? 'utf-8' : 'cp437',
    );
    const extra = directory.read(extraLength);
    directory.read(commentLength);
    const info: ZipInfo = {
      compressSize: BigInt(readUint32(centdir, 20)),
      compressType: readUint16(centdir, 10),
      crc: readUint32(centdir, 16),
      endOffset: null,
      extra,
      fileSize: BigInt(readUint32(centdir, 24)),
      filename: sanitizeFilename(filename),
      flagBits,
      headerOffset: BigInt(readUint32(centdir, 42)),
      origFilename: filename,
    };
    const extractVersion = centdir[6] as number;
    if (extractVersion > MAX_EXTRACT_VERSION) {
      throw new NotImplementedError(
        `zip file version ${Math.floor(extractVersion / 10)}.${extractVersion % 10}`,
      );
    }
    decodeExtra(info, filenameCrc);
    info.headerOffset += concat;
    filelist.push(info);
    nameToInfo.set(info.filename, info);
    total +=
      BigInt(SIZE_CENTRAL_DIR) +
      BigInt(filenameLength + extraLength + commentLength);
  }
  // `reversed(sorted(filelist, key=header_offset))`: sorted() is stable.
  const sorted = filelist.toSorted((a, b) =>
    a.headerOffset < b.headerOffset
      ? -1
      : Number(a.headerOffset > b.headerOffset),
  );
  let endOffset = startDir;
  for (const info of sorted.toReversed()) {
    info.endOffset = endOffset;
    endOffset = info.headerOffset;
  }
  return { filelist, nameToInfo };
}

/** zipfile `_SharedFile`: a position of its own over the archive. */
class SharedFile {
  private readonly file: BytesIO;
  private position: bigint;

  constructor(file: BytesIO, position: bigint) {
    this.file = file;
    this.position = position;
  }

  tell(): bigint {
    return this.position;
  }

  /** `seek(offset, whence=1)`. */
  skip(offset: number): void {
    this.file.seek(this.position + BigInt(offset));
    this.position = this.file.tell();
  }

  read(count: bigint | number): Uint8Array {
    this.file.seek(this.position);
    const data = this.file.read(count);
    this.position = this.file.tell();
    return data;
  }
}

/** A decompressor as `ZipExtFile` drives it. */
interface MemberDecompressor {
  eof: boolean;
  /** True when output was cut at `cap` (see `ZipExtFile.read1`). */
  capped?: boolean;
  decompress: (data: Uint8Array, maxLength: number, cap: number) => Uint8Array;
  readonly unconsumedTail?: Uint8Array;
  flush?: () => Uint8Array;
}

class DeflateDecompressor implements MemberDecompressor {
  private readonly zlib = new ZlibDecompressor(-15);

  get eof(): boolean {
    return this.zlib.eof;
  }

  get unconsumedTail(): Uint8Array {
    return this.zlib.unconsumedTail;
  }

  decompress(data: Uint8Array, maxLength: number): Uint8Array {
    return this.zlib.decompress(data, maxLength);
  }

  flush(): Uint8Array {
    return this.zlib.flush();
  }
}

/** zipfile `_check_compression` + `_get_decompressor`. */
function getDecompressor(compressType: number): MemberDecompressor | null {
  switch (compressType) {
    case ZIP_STORED:
      return null;
    case ZIP_DEFLATED:
      return new DeflateDecompressor();
    case ZIP_BZIP2:
      return new Bz2Decompressor();
    case ZIP_LZMA:
      return new ZipLzmaDecompressor();
    case ZIP_ZSTANDARD:
      return new ZstdDecompressor();
    default:
      throw new NotImplementedError('That compression method is not supported');
  }
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) {
    return second;
  }
  if (second.length === 0) {
    return first;
  }
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}

const MIN_READ_SIZE = 4096;

/** zipfile `ZipExtFile`, reading only (no seek, no decryption). */
class ZipExtFile {
  private readonly decompressor: MemberDecompressor | null;
  private compressLeft: bigint;
  private left: bigint;
  private eof = false;
  private runningCrc = 0;
  /** Python checks the CRC only when it has every byte of the member. */
  private crcUnknown = false;

  private readonly file: SharedFile;
  private readonly info: ZipInfo;

  constructor(file: SharedFile, info: ZipInfo) {
    this.file = file;
    this.info = info;
    this.compressLeft = info.compressSize;
    this.left = info.fileSize;
    this.decompressor = getDecompressor(info.compressType);
  }

  /** `read(n)` for `n >= 0` on a freshly opened member. */
  read(count: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let wanted = count;
    while (wanted > 0 && !this.eof) {
      const data = this.read1(wanted);
      if (wanted < data.length) {
        chunks.push(data.subarray(0, wanted));
        length += wanted;
        break;
      }
      chunks.push(data);
      length += data.length;
      wanted -= data.length;
    }
    if (chunks.length === 1) {
      return chunks[0] as Uint8Array;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /** `_read1(n)`. */
  private read1(count: number): Uint8Array {
    if (this.eof || count <= 0) {
      return new Uint8Array(0);
    }
    const decompressor = this.decompressor;
    let data: Uint8Array;
    if (decompressor === null) {
      data = this.read2(count);
      this.eof = this.compressLeft <= 0n;
    } else if (this.info.compressType === ZIP_DEFLATED) {
      data = decompressor.unconsumedTail ?? new Uint8Array(0);
      if (count > data.length) {
        data = concatBytes(data, this.read2(count - data.length));
      }
      const maxLength = Math.max(count, MIN_READ_SIZE);
      data = decompressor.decompress(data, maxLength, maxLength);
      this.eof =
        decompressor.eof ||
        (this.compressLeft <= 0n &&
          (decompressor.unconsumedTail?.length ?? 0) === 0);
      if (this.eof && decompressor.flush !== undefined) {
        data = concatBytes(data, decompressor.flush());
      }
    } else {
      data = this.read2(count);
      // Python decompresses the whole chunk; output past `count` bytes is
      // only needed for the CRC, so it is bounded here.
      data = decompressor.decompress(data, 0, count);
      this.eof = decompressor.eof || this.compressLeft <= 0n;
      if (decompressor.capped === true) {
        this.crcUnknown = true;
      }
    }
    if (BigInt(data.length) > this.left) {
      data = data.subarray(0, Number(this.left));
    }
    this.left -= BigInt(data.length);
    if (this.left <= 0n) {
      this.eof = true;
      this.crcUnknown = false;
    }
    this.updateCrc(data);
    return data;
  }

  /** `_read2(n)`. */
  private read2(count: number): Uint8Array {
    if (this.compressLeft <= 0n) {
      return new Uint8Array(0);
    }
    let wanted = BigInt(Math.max(count, MIN_READ_SIZE));
    if (wanted > this.compressLeft) {
      wanted = this.compressLeft;
    }
    const data = this.file.read(wanted);
    this.compressLeft -= BigInt(data.length);
    if (data.length === 0) {
      throw new PyEOFError('');
    }
    return data;
  }

  /** `_update_crc`. */
  private updateCrc(data: Uint8Array): void {
    this.runningCrc = crc32Update(this.runningCrc, data);
    if (this.eof && !this.crcUnknown && this.runningCrc !== this.info.crc) {
      throw new BadZipFile(`Bad CRC-32 for file ${pyRepr(this.info.filename)}`);
    }
  }
}

/** `ZipFile.open(name)` for reading, without a password. */
function openMember(file: BytesIO, info: ZipInfo, name: string): ZipExtFile {
  const shared = new SharedFile(file, info.headerOffset);
  const header = shared.read(SIZE_FILE_HEADER);
  if (header.length !== SIZE_FILE_HEADER) {
    throw new BadZipFile('Truncated file header');
  }
  if (!hasSignature(header, 0, STRING_FILE_HEADER)) {
    throw new BadZipFile('Bad magic number for file header');
  }
  const headerName = shared.read(readUint16(header, 26));
  const headerExtraLength = readUint16(header, 28);
  if (headerExtraLength) {
    shared.skip(headerExtraLength);
  }
  if (info.flagBits & MASK_COMPRESSED_PATCH) {
    throw new NotImplementedError('compressed patched data (flag bit 5)');
  }
  if (info.flagBits & MASK_STRONG_ENCRYPTION) {
    throw new NotImplementedError('strong encryption (flag bit 6)');
  }
  const headerNameText = pyDecode(
    headerName,
    readUint16(header, 6) & MASK_UTF_FILENAME ? 'utf-8' : 'cp437',
  );
  if (headerNameText !== info.origFilename) {
    throw new BadZipFile(
      `File name in directory ${pyRepr(info.origFilename)} and header ${pyBytesRepr(headerName)} differ.`,
    );
  }
  if (
    info.endOffset !== null &&
    shared.tell() + info.compressSize > info.endOffset &&
    // Python only warns when the entry starts where the next one does.
    info.endOffset !== info.headerOffset
  ) {
    throw new BadZipFile(
      `Overlapped entries: ${pyRepr(info.origFilename)} (possible zip bomb)`,
    );
  }
  if (info.flagBits & MASK_ENCRYPTED) {
    throw new PyRuntimeError(
      `File ${pyRepr(name)} is encrypted, password required for extraction`,
    );
  }
  return new ZipExtFile(shared, info);
}

/**
 * `zipfile.ZipFile(BytesIO(data)).open(namelist()[0]).read(count)`, with
 * the exceptions CPython 3.14 raises for corrupt archives.
 *
 * zipfile decompresses bzip2, LZMA and Zstandard members one input chunk at
 * a time with no output limit. Here their output stops at `count` bytes, so
 * a member that decompresses to more than that comes back as `count` bytes
 * (too big for the caller) even where CPython would go on to find corrupt
 * data or a bad CRC further on, or run out of memory on a bomb. `count`
 * may be a function of the member's compression method.
 */
export function readFirstZipMember(
  data: Uint8Array,
  count: number | ((compressType: number) => number),
): Uint8Array {
  const file = new BytesIO(data);
  const { filelist, nameToInfo } = realGetContents(file);
  const first = filelist[0];
  if (first === undefined) {
    throw new PyIndexError('list index out of range');
  }
  const info = nameToInfo.get(first.filename) as ZipInfo;
  const member = openMember(file, info, first.filename);
  return member.read(
    typeof count === 'number' ? count : count(info.compressType),
  );
}

/** Zip compression methods decoded by the slow pure-TypeScript codecs. */
export const SLOW_ZIP_METHODS: ReadonlyMap<number, string> = new Map([
  [ZIP_BZIP2, 'bzip2'],
  [ZIP_LZMA, 'LZMA'],
  [ZIP_ZSTANDARD, 'Zstandard'],
]);
