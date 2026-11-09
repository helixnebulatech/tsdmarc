// Port of the libzstd 1.5.7 frame decoder (lib/decompress/zstd_decompress.c,
// zstd_decompress_block.c, huf_decompress.c, lib/common/fse_decompress.c,
// entropy_common.c, bitstream.h, xxhash.h) and of the loop CPython 3.14's
// `compression.zstd.ZstdDecompressor().decompress(data)` runs around
// ZSTD_decompressStream() (Modules/_zstd/decompressor.c), as zipfile uses it
// for ZIP_ZSTANDARD members.
//
// Why a port and not a library: the result of a corrupt or truncated member
// (which error, after which output) depends on libzstd's exact control flow:
// its streaming stages, the single-pass shortcut it takes when the whole
// frame fits in CPython's output buffer, the ring output buffer, where
// literals are staged, the x86-64 BMI2 fast Huffman loops (which skip the
// end-of-stream checks of the generic loops) and the 64-bit bit-container
// arithmetic. This file follows the C code path by path, including the
// arithmetic of corrupt streams, so it raises the same ZSTD_getErrorName()
// message at the same point.
//
// Not ported: wildcopy writes past the end of a copy (they only matter when
// a corrupt frame later reads stale ring-buffer memory) and the legacy
// (v0.5–v0.7) frame formats, which the system libzstd also decodes; a legacy
// frame here produces no output and never ends.

/** Python's `compression.zstd.ZstdError`. */
export class ZstdError extends Error {
  override name = 'ZstdError';
}

/** lib/common/error_private.c ERR_getErrorString(). */
const ERROR_NAMES = {
  GENERIC: 'Error (generic)',
  checksum_wrong: "Restored data doesn't match checksum",
  corruption_detected: 'Data corruption detected',
  dictionary_corrupted: 'Dictionary is corrupted',
  dictionary_wrong: 'Dictionary mismatch',
  dstSize_tooSmall: 'Destination buffer is too small',
  frameParameter_unsupported: 'Unsupported frame parameter',
  frameParameter_windowTooLarge: 'Frame requires too much memory for decoding',
  literals_headerWrong:
    "Header of Literals' block doesn't respect format specification",
  prefix_unknown: 'Unknown frame descriptor',
  srcSize_wrong: 'Src size is incorrect',
} as const;
type ErrorCode = keyof typeof ERROR_NAMES;

/** An internal RETURN_ERROR(); converted to ZstdError at the API. */
class Fail extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

function fail(code: ErrorCode): never {
  throw new Fail(code);
}

const EMPTY = new Uint8Array(0);
const ZSTD_MAGICNUMBER = 0xfd_2f_b5_28;
const ZSTD_MAGIC_SKIPPABLE_START = 0x18_4d_2a_50;
const ZSTD_MAGIC_SKIPPABLE_MASK = 0xff_ff_ff_f0;
const FRAMEHEADERSIZE_PREFIX = 5;
const FRAMEHEADERSIZE_MIN = 6;
const SKIPPABLEHEADERSIZE = 8;
const BLOCK_HEADER_SIZE = 3;
const BLOCKSIZE_MAX = 1 << 17;
const WINDOWLOG_MAX = 31;
const WINDOWLOG_ABSOLUTEMIN = 10;
/** ZSTD_MAXWINDOWSIZE_DEFAULT: (1 << ZSTD_WINDOWLOG_LIMIT_DEFAULT) + 1. */
const MAX_WINDOW_SIZE = 2 ** 27 + 1;
const WILDCOPY_OVERLENGTH = 32;
const LITBUFFEREXTRASIZE = 1 << 16;
const MIN_CBLOCK_SIZE = 2;
const MIN_LITERALS_FOR_4_STREAMS = 6;
const LONGNBSEQ = 0x7f_00;
const CONTENTSIZE_UNKNOWN = 2n ** 64n - 1n;
const DID_FIELD_SIZE = [0, 1, 2, 4];
const FCS_FIELD_SIZE = [0, 2, 4, 8];
const HUF_TABLELOG_MAX = 12;
const HUF_DECODER_FAST_TABLELOG = 11;
const FSE_MIN_TABLELOG = 5;
const FSE_TABLELOG_ABSOLUTE_MAX = 15;
const MAX_LL = 35;
const MAX_ML = 52;
const MAX_OFF = 31;
const LL_FSE_LOG = 9;
const ML_FSE_LOG = 9;
const OFF_FSE_LOG = 8;

const KB = 1024;
const MB = 1024 * KB;
/** CPython's output buffer block sizes (pycore_blocks_output_buffer.h). */
const BUFFER_BLOCK_SIZE = [
  32 * KB,
  64 * KB,
  256 * KB,
  MB,
  4 * MB,
  8 * MB,
  16 * MB,
  16 * MB,
  32 * MB,
  32 * MB,
  32 * MB,
  32 * MB,
  64 * MB,
  64 * MB,
  128 * MB,
  128 * MB,
  256 * MB,
];

function byteAt(data: Uint8Array, index: number): number {
  return data[index] ?? 0;
}

function le16(data: Uint8Array, index: number): number {
  return byteAt(data, index) | (byteAt(data, index + 1) << 8);
}

function le24(data: Uint8Array, index: number): number {
  return le16(data, index) | (byteAt(data, index + 2) << 16);
}

function le32(data: Uint8Array, index: number): number {
  return (le24(data, index) | (byteAt(data, index + 3) << 24)) >>> 0;
}

function le64(data: Uint8Array, index: number): bigint {
  return BigInt(le32(data, index)) | (BigInt(le32(data, index + 4)) << 32n);
}

/** ZSTD_highbit32 (value > 0). */
function highbit32(value: number): number {
  return 31 - Math.clz32(value);
}

function ctz32(value: number): number {
  return 31 - Math.clz32(value & -value);
}

function ctz64(hi: number, lo: number): number {
  return lo === 0 ? 32 + ctz32(hi) : ctz32(lo);
}

/** Low 32 bits of the 64-bit value (hi, lo) shifted right by 0..63. */
function shiftRight64Low(hi: number, lo: number, shift: number): number {
  if (shift === 0) {
    return lo;
  }
  if (shift < 32) {
    return ((lo >>> shift) | (hi << (32 - shift))) >>> 0;
  }
  return hi >>> (shift - 32);
}

/** High 32 bits of the 64-bit value (hi, lo) shifted left by 0..63. */
function shiftLeft64High(hi: number, lo: number, shift: number): number {
  if (shift === 0) {
    return hi;
  }
  if (shift < 32) {
    return ((hi << shift) | (lo >>> (32 - shift))) >>> 0;
  }
  return (lo << (shift - 32)) >>> 0;
}

function mask(bits: number): number {
  return bits >= 32 ? 0xff_ff_ff_ff : (1 << bits) - 1;
}

// ---------------------------------------------------------------------------
// bitstream.h: BIT_DStream_t, a backward bit reader with a 64-bit container.

const BIT_UNFINISHED = 0;
const BIT_END_OF_BUFFER = 1;
const BIT_COMPLETED = 2;
const BIT_OVERFLOW = 3;
/** `bitD->ptr` once it points to the static zeroFilled word. */
const ZERO_FILLED = -1;

class BitStream {
  buf: Uint8Array = EMPTY;
  start = 0;
  limitPtr = 0;
  ptr = 0;
  hi = 0;
  lo = 0;
  consumed = 0;

  private load(at: number): void {
    this.lo = le32(this.buf, at);
    this.hi = le32(this.buf, at + 4);
  }

  /** BIT_initDStream; false for an error. */
  init(buf: Uint8Array, start: number, size: number): boolean {
    this.buf = buf;
    if (size < 1) {
      this.start = 0;
      this.limitPtr = 0;
      this.ptr = 0;
      this.hi = 0;
      this.lo = 0;
      this.consumed = 0;
      return false;
    }
    this.start = start;
    this.limitPtr = start + 8;
    const lastByte = byteAt(buf, start + size - 1);
    this.consumed = lastByte ? 8 - highbit32(lastByte) : 0;
    if (size >= 8) {
      this.ptr = start + size - 8;
      this.load(this.ptr);
      return lastByte !== 0;
    }
    this.ptr = start;
    let lo = 0;
    let hi = 0;
    for (let index = 0; index < size; index += 1) {
      const byte = byteAt(buf, start + index);
      if (index < 4) {
        lo |= byte << (8 * index);
      } else {
        hi |= byte << (8 * (index - 4));
      }
    }
    this.lo = lo >>> 0;
    this.hi = hi >>> 0;
    if (lastByte === 0) {
      return false;
    }
    this.consumed += (8 - size) * 8;
    return true;
  }

  /** BIT_lookBits (getMiddleBits with `start & 63`). */
  look(bits: number): number {
    const shift = (((64 - this.consumed - bits) % 64) + 64) % 64;
    return (shiftRight64Low(this.hi, this.lo, shift) & mask(bits)) >>> 0;
  }

  /** BIT_lookBitsFast (bits >= 1). */
  lookFast(bits: number): number {
    const high = shiftLeft64High(this.hi, this.lo, this.consumed & 63);
    return bits >= 32 ? high : high >>> (32 - bits);
  }

  read(bits: number): number {
    const value = this.look(bits);
    this.consumed += bits;
    return value;
  }

  readFast(bits: number): number {
    const value = this.lookFast(bits);
    this.consumed += bits;
    return value;
  }

  private reloadInternal(): number {
    this.ptr -= this.consumed >>> 3;
    this.consumed &= 7;
    this.load(this.ptr);
    return BIT_UNFINISHED;
  }

  reloadFast(): number {
    if (this.ptr < this.limitPtr) {
      return BIT_OVERFLOW;
    }
    return this.reloadInternal();
  }

  reload(): number {
    if (this.consumed > 64) {
      this.ptr = ZERO_FILLED;
      return BIT_OVERFLOW;
    }
    if (this.ptr >= this.limitPtr) {
      return this.reloadInternal();
    }
    if (this.ptr === this.start) {
      return this.consumed < 64 ? BIT_END_OF_BUFFER : BIT_COMPLETED;
    }
    let bytes = this.consumed >>> 3;
    let result = BIT_UNFINISHED;
    if (this.ptr - bytes < this.start) {
      bytes = this.ptr - this.start;
      result = BIT_END_OF_BUFFER;
    }
    this.ptr -= bytes;
    this.consumed -= bytes * 8;
    this.load(this.ptr);
    return result;
  }

  ended(): boolean {
    return this.ptr === this.start && this.consumed === 64;
  }
}

// ---------------------------------------------------------------------------
// xxhash.h XXH64 (seed 0), on 64-bit values held as two 32-bit halves.

const P64_1: [number, number] = [0x9e_37_79_b1, 0x85_eb_ca_87];
const P64_2: [number, number] = [0xc2_b2_ae_3d, 0x27_d4_eb_4f];
const P64_3: [number, number] = [0x16_56_67_b1, 0x9e_37_79_f9];
const P64_4: [number, number] = [0x85_eb_ca_77, 0xc2_b2_ae_63];
const P64_5: [number, number] = [0x27_d4_eb_2f, 0x16_56_67_c5];

type U64 = [number, number];

function add64(a: U64, b: U64): U64 {
  const lo = a[1] + b[1];
  const hi = (a[0] + b[0] + (lo > 0xff_ff_ff_ff ? 1 : 0)) >>> 0;
  return [hi, lo >>> 0];
}

function mul64(a: U64, b: U64): U64 {
  const al = a[1];
  const bl = b[1];
  const al0 = al & 0xff_ff;
  const al1 = al >>> 16;
  const bl0 = bl & 0xff_ff;
  const bl1 = bl >>> 16;
  const p00 = al0 * bl0;
  const p01 = al0 * bl1;
  const p10 = al1 * bl0;
  const p11 = al1 * bl1;
  const middle = (p00 >>> 16) + (p01 & 0xff_ff) + (p10 & 0xff_ff);
  const lo = (((middle & 0xff_ff) << 16) | (p00 & 0xff_ff)) >>> 0;
  let hi = p11 + (p01 >>> 16) + (p10 >>> 16) + (middle >>> 16);
  hi = (hi + Math.imul(a[0], bl) + Math.imul(al, b[0])) >>> 0;
  return [hi, lo];
}

function rotl64(a: U64, bits: number): U64 {
  const [hi, lo] = a;
  if (bits === 32) {
    return [lo, hi];
  }
  if (bits < 32) {
    return [
      ((hi << bits) | (lo >>> (32 - bits))) >>> 0,
      ((lo << bits) | (hi >>> (32 - bits))) >>> 0,
    ];
  }
  const shift = bits - 32;
  return [
    ((lo << shift) | (hi >>> (32 - shift))) >>> 0,
    ((hi << shift) | (lo >>> (32 - shift))) >>> 0,
  ];
}

function xor64(a: U64, b: U64): U64 {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

function shr64(a: U64, bits: number): U64 {
  if (bits >= 32) {
    return [0, a[0] >>> (bits - 32)];
  }
  return [a[0] >>> bits, ((a[1] >>> bits) | (a[0] << (32 - bits))) >>> 0];
}

function read64(data: Uint8Array, index: number): U64 {
  return [le32(data, index + 4), le32(data, index)];
}

function xxhRound(acc: U64, input: U64): U64 {
  return mul64(rotl64(add64(acc, mul64(input, P64_2)), 31), P64_1);
}

function xxhMergeRound(acc: U64, value: U64): U64 {
  return add64(mul64(xor64(acc, xxhRound([0, 0], value)), P64_1), P64_4);
}

/** XXH64_state_t with seed 0. */
class Xxh64 {
  private total = 0;
  private v1: U64 = add64(P64_1, P64_2);
  private v2: U64 = P64_2;
  private v3: U64 = [0, 0];
  private v4: U64 = [
    (-P64_1[0] - (P64_1[1] === 0 ? 0 : 1)) >>> 0,
    -P64_1[1] >>> 0,
  ];
  private readonly buffer = new Uint8Array(32);
  private buffered = 0;

  update(data: Uint8Array, start: number, end: number): void {
    this.total += end - start;
    let index = start;
    if (this.buffered + (end - index) < 32) {
      this.buffer.set(data.subarray(index, end), this.buffered);
      this.buffered += end - index;
      return;
    }
    if (this.buffered > 0) {
      const take = 32 - this.buffered;
      this.buffer.set(data.subarray(index, index + take), this.buffered);
      index += take;
      this.stripe(this.buffer, 0);
      this.buffered = 0;
    }
    while (index + 32 <= end) {
      this.stripe(data, index);
      index += 32;
    }
    if (index < end) {
      this.buffer.set(data.subarray(index, end));
      this.buffered = end - index;
    }
  }

  private stripe(data: Uint8Array, index: number): void {
    this.v1 = xxhRound(this.v1, read64(data, index));
    this.v2 = xxhRound(this.v2, read64(data, index + 8));
    this.v3 = xxhRound(this.v3, read64(data, index + 16));
    this.v4 = xxhRound(this.v4, read64(data, index + 24));
  }

  /** Low 32 bits of XXH64_digest(). */
  digestLow32(): number {
    let hash: U64;
    if (this.total >= 32) {
      hash = add64(
        add64(rotl64(this.v1, 1), rotl64(this.v2, 7)),
        add64(rotl64(this.v3, 12), rotl64(this.v4, 18)),
      );
      hash = xxhMergeRound(hash, this.v1);
      hash = xxhMergeRound(hash, this.v2);
      hash = xxhMergeRound(hash, this.v3);
      hash = xxhMergeRound(hash, this.v4);
    } else {
      hash = add64(this.v3, P64_5);
    }
    hash = add64(hash, [
      Math.floor(this.total / 2 ** 32) >>> 0,
      this.total >>> 0,
    ]);
    const data = this.buffer;
    let index = 0;
    let length = this.buffered;
    while (length >= 8) {
      hash = xor64(hash, xxhRound([0, 0], read64(data, index)));
      hash = add64(mul64(rotl64(hash, 27), P64_1), P64_4);
      index += 8;
      length -= 8;
    }
    if (length >= 4) {
      hash = xor64(hash, mul64([0, le32(data, index)], P64_1));
      hash = add64(mul64(rotl64(hash, 23), P64_2), P64_3);
      index += 4;
      length -= 4;
    }
    while (length > 0) {
      hash = xor64(hash, mul64([0, byteAt(data, index)], P64_5));
      hash = mul64(rotl64(hash, 11), P64_1);
      index += 1;
      length -= 1;
    }
    hash = xor64(hash, shr64(hash, 33));
    hash = mul64(hash, P64_2);
    hash = xor64(hash, shr64(hash, 29));
    hash = mul64(hash, P64_3);
    hash = xor64(hash, shr64(hash, 32));
    return hash[1];
  }
}

// ---------------------------------------------------------------------------
// entropy_common.c FSE_readNCount and HUF_readStats, fse_decompress.c.
// Every caller maps their errors to corruption_detected, so they throw it.

interface NCount {
  size: number;
  maxSymbolValue: number;
  tableLog: number;
}

function readNCount(
  norm: Int16Array,
  maxSymbolValue: number,
  src: Uint8Array,
  start: number,
  size: number,
): NCount {
  if (size < 8) {
    const buffer = new Uint8Array(8);
    buffer.set(src.subarray(start, start + Math.max(size, 0)));
    const result = readNCountBody(norm, maxSymbolValue, buffer, 0, 8);
    if (result.size > size) {
      fail('corruption_detected');
    }
    return result;
  }
  return readNCountBody(norm, maxSymbolValue, src, start, size);
}

// oxlint-disable-next-line max-lines-per-function, complexity -- 1:1 port of FSE_readNCount_body
function readNCountBody(
  norm: Int16Array,
  maxSymbolValue: number,
  src: Uint8Array,
  start: number,
  size: number,
): NCount {
  const iend = start + size;
  let ip = start;
  let charnum = 0;
  const maxSV1 = maxSymbolValue + 1;
  let previous0 = false;
  norm.fill(0, 0, maxSV1);
  let bitStream = le32(src, ip);
  let nbBits = (bitStream & 0xf) + FSE_MIN_TABLELOG;
  if (nbBits > FSE_TABLELOG_ABSOLUTE_MAX) {
    fail('corruption_detected');
  }
  const tableLog = nbBits;
  bitStream >>>= 4;
  let bitCount = 4;
  let remaining = (1 << nbBits) + 1;
  let threshold = 1 << nbBits;
  nbBits += 1;
  const advance = (): void => {
    if (ip <= iend - 7 || ip + (bitCount >> 3) <= iend - 4) {
      ip += bitCount >> 3;
      bitCount &= 7;
    } else {
      bitCount -= 8 * (iend - 4 - ip);
      bitCount &= 31;
      ip = iend - 4;
    }
    bitStream = le32(src, ip) >>> bitCount;
  };
  for (;;) {
    if (previous0) {
      let repeats = ctz32((~bitStream | 0x80_00_00_00) >>> 0) >> 1;
      while (repeats >= 12) {
        charnum += 3 * 12;
        if (ip <= iend - 7) {
          ip += 3;
        } else {
          bitCount -= 8 * (iend - 7 - ip);
          bitCount &= 31;
          ip = iend - 4;
        }
        bitStream = le32(src, ip) >>> bitCount;
        repeats = ctz32((~bitStream | 0x80_00_00_00) >>> 0) >> 1;
      }
      charnum += 3 * repeats;
      bitStream >>>= 2 * repeats;
      bitCount += 2 * repeats;
      charnum += bitStream & 3;
      bitCount += 2;
      if (charnum >= maxSV1) {
        break;
      }
      advance();
    }
    const max = 2 * threshold - 1 - remaining;
    let count: number;
    if ((bitStream & (threshold - 1)) >>> 0 < max) {
      count = bitStream & (threshold - 1);
      bitCount += nbBits - 1;
    } else {
      count = bitStream & (2 * threshold - 1);
      if (count >= threshold) {
        count -= max;
      }
      bitCount += nbBits;
    }
    count -= 1;
    if (count >= 0) {
      remaining -= count;
    } else {
      remaining += count;
    }
    norm[charnum] = count;
    charnum += 1;
    previous0 = count === 0;
    if (remaining < threshold) {
      if (remaining <= 1) {
        break;
      }
      nbBits = highbit32(remaining) + 1;
      threshold = 1 << (nbBits - 1);
    }
    if (charnum >= maxSV1) {
      break;
    }
    advance();
  }
  if (remaining !== 1) {
    fail('corruption_detected');
  }
  if (charnum > maxSV1) {
    fail('corruption_detected');
  }
  if (bitCount > 32) {
    fail('corruption_detected');
  }
  ip += (bitCount + 7) >> 3;
  return { maxSymbolValue: charnum - 1, size: ip - start, tableLog };
}

/** FSE decoding table (fse_decompress.c FSE_DTable). */
interface FseTable {
  tableLog: number;
  fastMode: boolean;
  symbol: Uint8Array;
  newState: Uint16Array;
  nbBits: Uint8Array;
}

/** FSE_TABLESTEP. */
function tableStep(tableSize: number): number {
  return (tableSize >>> 1) + (tableSize >>> 3) + 3;
}

/**
 * The symbol spreading shared by FSE_buildDTable_internal and
 * ZSTD_buildFSETable: returns the symbol of each cell and the
 * nextState/nbBits columns.
 */
function spreadSymbols(
  norm: Int16Array,
  maxSymbolValue: number,
  tableLog: number,
): {
  symbols: Uint8Array;
  nextState: Uint16Array;
  nbBits: Uint8Array;
  fastMode: boolean;
} {
  const tableSize = 1 << tableLog;
  const symbols = new Uint8Array(tableSize);
  const symbolNext = new Uint16Array(maxSymbolValue + 1);
  let highThreshold = tableSize - 1;
  let fastMode = true;
  const largeLimit = 1 << (tableLog - 1);
  for (let symbol = 0; symbol <= maxSymbolValue; symbol += 1) {
    const count = norm[symbol] as number;
    if (count === -1) {
      symbols[highThreshold] = symbol;
      highThreshold -= 1;
      symbolNext[symbol] = 1;
    } else {
      if (count >= largeLimit) {
        fastMode = false;
      }
      symbolNext[symbol] = count;
    }
  }
  const tableMask = tableSize - 1;
  const step = tableStep(tableSize);
  let position = 0;
  for (let symbol = 0; symbol <= maxSymbolValue; symbol += 1) {
    const count = norm[symbol] as number;
    for (let index = 0; index < count; index += 1) {
      symbols[position] = symbol;
      position = (position + step) & tableMask;
      while (position > highThreshold) {
        position = (position + step) & tableMask;
      }
    }
  }
  if (position !== 0) {
    // FSE_buildDTable_internal's ERROR(GENERIC); unreachable after a
    // successful FSE_readNCount.
    fail('corruption_detected');
  }
  const nextState = new Uint16Array(tableSize);
  const nbBits = new Uint8Array(tableSize);
  for (let cell = 0; cell < tableSize; cell += 1) {
    const symbol = symbols[cell] as number;
    const next = symbolNext[symbol] as number;
    symbolNext[symbol] = next + 1;
    const bits = tableLog - highbit32(next);
    nbBits[cell] = bits;
    nextState[cell] = ((next << bits) - tableSize) & 0xff_ff;
  }
  return { fastMode, nbBits, nextState, symbols };
}

function buildFseTable(
  norm: Int16Array,
  maxSymbolValue: number,
  tableLog: number,
): FseTable {
  const spread = spreadSymbols(norm, maxSymbolValue, tableLog);
  return {
    fastMode: spread.fastMode,
    nbBits: spread.nbBits,
    newState: spread.nextState,
    symbol: spread.symbols,
    tableLog,
  };
}

class FseState {
  state = 0;

  private readonly table: FseTable;
  private readonly bits: BitStream;

  constructor(table: FseTable, bits: BitStream) {
    this.table = table;
    this.bits = bits;
    this.state = bits.read(table.tableLog);
    bits.reload();
  }

  decode(): number {
    const { table, bits } = this;
    const cell = this.state;
    const nbBits = table.nbBits[cell] as number;
    const symbol = table.symbol[cell] as number;
    const low = table.fastMode ? bits.readFast(nbBits) : bits.read(nbBits);
    this.state = (table.newState[cell] as number) + low;
    return symbol;
  }
}

/** FSE_decompress_wksp_bmi2 with maxLog 6 (Huffman weights). */
function fseDecompressWeights(
  dst: Uint8Array,
  dstCapacity: number,
  src: Uint8Array,
  start: number,
  size: number,
): number {
  const norm = new Int16Array(256);
  const header = readNCount(norm, 255, src, start, size);
  if (header.tableLog > 6) {
    fail('corruption_detected');
  }
  const table = buildFseTable(norm, header.maxSymbolValue, header.tableLog);
  const bits = new BitStream();
  if (!bits.init(src, start + header.size, size - header.size)) {
    fail('corruption_detected');
  }
  const state1 = new FseState(table, bits);
  const state2 = new FseState(table, bits);
  if (bits.reload() === BIT_OVERFLOW) {
    fail('corruption_detected');
  }
  let op = 0;
  const omax = dstCapacity;
  const olimit = omax - 3;
  for (;;) {
    const status = bits.reload();
    if (!(status === BIT_UNFINISHED && op < olimit)) {
      break;
    }
    dst[op] = state1.decode();
    dst[op + 1] = state2.decode();
    dst[op + 2] = state1.decode();
    dst[op + 3] = state2.decode();
    op += 4;
  }
  for (;;) {
    if (op > omax - 2) {
      fail('corruption_detected');
    }
    dst[op] = state1.decode();
    op += 1;
    if (bits.reload() === BIT_OVERFLOW) {
      dst[op] = state2.decode();
      op += 1;
      break;
    }
    if (op > omax - 2) {
      fail('corruption_detected');
    }
    dst[op] = state2.decode();
    op += 1;
    if (bits.reload() === BIT_OVERFLOW) {
      dst[op] = state1.decode();
      op += 1;
      break;
    }
  }
  return op;
}

interface HufStats {
  size: number;
  nbSymbols: number;
  tableLog: number;
}

/** HUF_readStats with hwSize 256: weights[] and rankStats[0..12]. */
function readStats(
  weights: Uint8Array,
  rankStats: Uint32Array,
  src: Uint8Array,
  start: number,
  size: number,
): HufStats {
  if (!size) {
    fail('corruption_detected');
  }
  let iSize = byteAt(src, start);
  let oSize: number;
  if (iSize >= 128) {
    oSize = iSize - 127;
    iSize = (oSize + 1) >> 1;
    if (iSize + 1 > size) {
      fail('corruption_detected');
    }
    if (oSize >= 256) {
      fail('corruption_detected');
    }
    for (let index = 0; index < oSize; index += 2) {
      const byte = byteAt(src, start + 1 + index / 2);
      weights[index] = byte >> 4;
      weights[index + 1] = byte & 15;
    }
  } else {
    if (iSize + 1 > size) {
      fail('corruption_detected');
    }
    oSize = fseDecompressWeights(weights, 255, src, start + 1, iSize);
  }
  rankStats.fill(0, 0, HUF_TABLELOG_MAX + 1);
  let weightTotal = 0;
  for (let index = 0; index < oSize; index += 1) {
    const weight = weights[index] as number;
    if (weight > HUF_TABLELOG_MAX) {
      fail('corruption_detected');
    }
    rankStats[weight] = (rankStats[weight] as number) + 1;
    weightTotal += (1 << weight) >> 1;
  }
  if (weightTotal === 0) {
    fail('corruption_detected');
  }
  const tableLog = highbit32(weightTotal) + 1;
  if (tableLog > HUF_TABLELOG_MAX) {
    fail('corruption_detected');
  }
  const rest = (1 << tableLog) - weightTotal;
  const verif = 1 << highbit32(rest);
  const lastWeight = highbit32(rest) + 1;
  if (verif !== rest) {
    fail('corruption_detected');
  }
  weights[oSize] = lastWeight;
  rankStats[lastWeight] = (rankStats[lastWeight] as number) + 1;
  const rank1 = rankStats[1] as number;
  if (rank1 < 2 || rank1 & 1) {
    fail('corruption_detected');
  }
  return { nbSymbols: oSize + 1, size: iSize + 1, tableLog };
}

// ---------------------------------------------------------------------------
// huf_decompress.c. The DTable keeps maxTableLog 12 (ZSTD_HUFFDTABLE_CAPACITY_LOG).

const HUF_MAX_TABLE_LOG = 12;

class HufTable {
  tableType = 0;
  tableLog = 0;
  /** X1 entries: (byte << 8) | nbBits. */
  readonly x1 = new Uint16Array(1 << HUF_MAX_TABLE_LOG);
  /** X2 entries: sequence | nbBits << 16 | length << 24. */
  readonly x2 = new Uint32Array(1 << HUF_MAX_TABLE_LOG);
}

/** HUF_readDTableX1_wksp. */
function readDTableX1(
  table: HufTable,
  src: Uint8Array,
  start: number,
  size: number,
): number {
  const weights = new Uint8Array(256);
  const rankVal = new Uint32Array(HUF_TABLELOG_MAX + 1);
  const stats = readStats(weights, rankVal, src, start, size);
  const { nbSymbols } = stats;
  let { tableLog } = stats;
  const targetTableLog = Math.min(
    HUF_MAX_TABLE_LOG + 1,
    HUF_DECODER_FAST_TABLELOG,
  );
  // HUF_rescaleStats
  if (tableLog < targetTableLog) {
    const scale = targetTableLog - tableLog;
    for (let symbol = 0; symbol < nbSymbols; symbol += 1) {
      const weight = weights[symbol] as number;
      weights[symbol] = weight === 0 ? 0 : weight + scale;
    }
    for (let weight = targetTableLog; weight > scale; weight -= 1) {
      rankVal[weight] = rankVal[weight - scale] as number;
    }
    for (let weight = scale; weight > 0; weight -= 1) {
      rankVal[weight] = 0;
    }
    tableLog = targetTableLog;
  }
  if (tableLog > HUF_MAX_TABLE_LOG + 1) {
    fail('corruption_detected');
  }
  table.tableType = 0;
  table.tableLog = tableLog;
  const rankStart = new Uint32Array(HUF_TABLELOG_MAX + 2);
  let nextRankStart = 0;
  for (let weight = 0; weight < tableLog + 1; weight += 1) {
    rankStart[weight] = nextRankStart;
    nextRankStart += rankVal[weight] as number;
  }
  const symbols = new Uint8Array(256);
  for (let symbol = 0; symbol < nbSymbols; symbol += 1) {
    const weight = weights[symbol] as number;
    const position = rankStart[weight] as number;
    rankStart[weight] = position + 1;
    symbols[position] = symbol;
  }
  let symbol = rankVal[0] as number;
  let uStart = 0;
  for (let weight = 1; weight < tableLog + 1; weight += 1) {
    const symbolCount = rankVal[weight] as number;
    const length = (1 << weight) >> 1;
    const nbBits = tableLog + 1 - weight;
    for (let index = 0; index < symbolCount; index += 1) {
      const entry = ((symbols[symbol + index] as number) << 8) | nbBits;
      table.x1.fill(entry, uStart, uStart + length);
      uStart += length;
    }
    symbol += symbolCount;
  }
  return stats.size;
}

function deltX2(
  symbol: number,
  nbBits: number,
  baseSeq: number,
  level: number,
): number {
  const sequence = level === 1 ? symbol : baseSeq + (symbol << 8);
  return (sequence + (nbBits << 16) + level * 2 ** 24) >>> 0;
}

/** HUF_fillDTableX2ForWeight. */
function fillX2ForWeight(
  dt: Uint32Array,
  rank: number,
  sorted: Uint8Array,
  begin: number,
  end: number,
  nbBits: number,
  tableLog: number,
  baseSeq: number,
  level: number,
): void {
  const length = 2 ** ((tableLog - nbBits) & 0x1f);
  let position = rank;
  for (let index = begin; index !== end; index += 1) {
    const entry = deltX2(sorted[index] as number, nbBits, baseSeq, level);
    dt.fill(entry, position, position + length);
    position += length;
  }
}

/** HUF_fillDTableX2Level2. */
function fillX2Level2(
  dt: Uint32Array,
  base: number,
  targetLog: number,
  consumedBits: number,
  rankVal: Uint32Array,
  minWeight: number,
  maxWeight1: number,
  sorted: Uint8Array,
  rankStart: Uint32Array,
  nbBitsBaseline: number,
  baseSeq: number,
): void {
  if (minWeight > 1) {
    const length = 2 ** ((targetLog - consumedBits) & 0x1f);
    const entry = deltX2(baseSeq, consumedBits, 0, 1);
    const skipSize = rankVal[minWeight] as number;
    if (length === 2) {
      dt.fill(entry, base, base + 2);
    } else if (length === 4) {
      dt.fill(entry, base, base + 4);
    } else {
      for (let index = 0; index < skipSize; index += 8) {
        dt.fill(entry, base + index, base + index + 8);
      }
    }
  }
  for (let weight = minWeight; weight < maxWeight1; weight += 1) {
    const begin = rankStart[weight] as number;
    const end = rankStart[weight + 1] as number;
    const nbBits = nbBitsBaseline - weight;
    fillX2ForWeight(
      dt,
      base + (rankVal[weight] as number),
      sorted,
      begin,
      end,
      nbBits + consumedBits,
      targetLog,
      baseSeq,
      2,
    );
  }
}

/** HUF_readDTableX2_wksp. */
function readDTableX2(
  table: HufTable,
  src: Uint8Array,
  start: number,
  size: number,
): number {
  let maxTableLog = HUF_MAX_TABLE_LOG;
  const rankStats = new Uint32Array(HUF_TABLELOG_MAX + 1);
  const rankStart0 = new Uint32Array(HUF_TABLELOG_MAX + 3);
  const weights = new Uint8Array(256);
  const stats = readStats(weights, rankStats, src, start, size);
  const { tableLog, nbSymbols } = stats;
  if (tableLog > maxTableLog) {
    fail('corruption_detected');
  }
  if (
    tableLog <= HUF_DECODER_FAST_TABLELOG &&
    maxTableLog > HUF_DECODER_FAST_TABLELOG
  ) {
    maxTableLog = HUF_DECODER_FAST_TABLELOG;
  }
  let maxW = tableLog;
  while (rankStats[maxW] === 0) {
    maxW -= 1;
  }
  // rankStart = rankStart0 + 1
  let nextRankStart = 0;
  for (let weight = 1; weight < maxW + 1; weight += 1) {
    rankStart0[weight + 1] = nextRankStart;
    nextRankStart += rankStats[weight] as number;
  }
  rankStart0[1] = nextRankStart;
  rankStart0[maxW + 2] = nextRankStart;
  const sorted = new Uint8Array(256);
  for (let symbol = 0; symbol < nbSymbols; symbol += 1) {
    const weight = weights[symbol] as number;
    const position = rankStart0[weight + 1] as number;
    rankStart0[weight + 1] = position + 1;
    sorted[position] = symbol;
  }
  rankStart0[1] = 0;
  const rankVal: Uint32Array[] = [];
  for (let index = 0; index < HUF_TABLELOG_MAX; index += 1) {
    rankVal.push(new Uint32Array(HUF_TABLELOG_MAX + 1));
  }
  const rankVal0 = rankVal[0] as Uint32Array;
  const rescale = maxTableLog - tableLog - 1;
  let nextRankVal = 0;
  for (let weight = 1; weight < maxW + 1; weight += 1) {
    rankVal0[weight] = nextRankVal;
    nextRankVal += (rankStats[weight] as number) * 2 ** (weight + rescale);
  }
  const minBits = tableLog + 1 - maxW;
  for (
    let consumed = minBits;
    consumed < maxTableLog - minBits + 1;
    consumed += 1
  ) {
    const column = rankVal[consumed] as Uint32Array;
    for (let weight = 1; weight < maxW + 1; weight += 1) {
      column[weight] = (rankVal0[weight] as number) >>> consumed;
    }
  }
  // HUF_fillDTableX2
  const nbBitsBaseline = tableLog + 1;
  const scaleLog = nbBitsBaseline - maxTableLog;
  const minBitsFill = nbBitsBaseline - maxW;
  const wEnd = maxW + 1;
  for (let weight = 1; weight < wEnd; weight += 1) {
    const begin = rankStart0[weight] as number;
    const end = rankStart0[weight + 1] as number;
    const nbBits = nbBitsBaseline - weight;
    if (maxTableLog - nbBits >= minBitsFill) {
      let position = rankVal0[weight] as number;
      const length = 2 ** ((maxTableLog - nbBits) & 0x1f);
      const minWeight = Math.max(nbBits + scaleLog, 1);
      for (let index = begin; index !== end; index += 1) {
        fillX2Level2(
          table.x2,
          position,
          maxTableLog,
          nbBits,
          rankVal[nbBits] as Uint32Array,
          minWeight,
          wEnd,
          sorted,
          rankStart0,
          nbBitsBaseline,
          sorted[index] as number,
        );
        position += length;
      }
    } else {
      fillX2ForWeight(
        table.x2,
        rankVal0[weight] as number,
        sorted,
        begin,
        end,
        nbBits,
        maxTableLog,
        0,
        1,
      );
    }
  }
  table.tableLog = maxTableLog;
  table.tableType = 1;
  return stats.size;
}

// Huffman decoding loops. `out` receives the literals; writes past the end
// of a stream's segment land in the next segment, like in C.

function decodeSymbolX1(
  bits: BitStream,
  dt: Uint16Array,
  dtLog: number,
): number {
  const entry = dt[bits.lookFast(dtLog)] as number;
  bits.consumed += entry & 0xff;
  return entry >>> 8;
}

/** HUF_decodeStreamX1; returns the end position (always pEnd). */
function decodeStreamX1(
  out: Uint8Array,
  start: number,
  bits: BitStream,
  pEnd: number,
  dt: Uint16Array,
  dtLog: number,
): void {
  let p = start;
  if (pEnd - p > 3) {
    for (;;) {
      const status = bits.reload();
      if (!(status === BIT_UNFINISHED && p < pEnd - 3)) {
        break;
      }
      for (let index = 0; index < 4; index += 1) {
        out[p] = decodeSymbolX1(bits, dt, dtLog);
        p += 1;
      }
    }
  } else {
    bits.reload();
  }
  while (p < pEnd) {
    out[p] = decodeSymbolX1(bits, dt, dtLog);
    p += 1;
  }
}

function decodeSymbolX2(
  out: Uint8Array,
  p: number,
  bits: BitStream,
  dt: Uint32Array,
  dtLog: number,
): number {
  const entry = dt[bits.lookFast(dtLog)] as number;
  out[p] = entry & 0xff;
  out[p + 1] = (entry >>> 8) & 0xff;
  bits.consumed += (entry >>> 16) & 0xff;
  return entry >>> 24;
}

/** HUF_decodeStreamX2; returns the end position. */
function decodeStreamX2(
  out: Uint8Array,
  start: number,
  bits: BitStream,
  pEnd: number,
  dt: Uint32Array,
  dtLog: number,
): number {
  let p = start;
  if (pEnd - p >= 8) {
    const unrolled = dtLog <= 11 ? 5 : 4;
    const bound = dtLog <= 11 ? pEnd - 9 : pEnd - 7;
    for (;;) {
      const status = bits.reload();
      if (!(status === BIT_UNFINISHED && p < bound)) {
        break;
      }
      for (let index = 0; index < unrolled; index += 1) {
        p += decodeSymbolX2(out, p, bits, dt, dtLog);
      }
    }
  } else {
    bits.reload();
  }
  if (pEnd - p >= 2) {
    for (;;) {
      const status = bits.reload();
      if (!(status === BIT_UNFINISHED && p <= pEnd - 2)) {
        break;
      }
      p += decodeSymbolX2(out, p, bits, dt, dtLog);
    }
    while (p <= pEnd - 2) {
      p += decodeSymbolX2(out, p, bits, dt, dtLog);
    }
  }
  if (p < pEnd) {
    // HUF_decodeLastSymbolX2
    const entry = dt[bits.lookFast(dtLog)] as number;
    out[p] = entry & 0xff;
    const nbBits = (entry >>> 16) & 0xff;
    if (entry >>> 24 === 1) {
      bits.consumed += nbBits;
    } else if (bits.consumed < 64) {
      bits.consumed += nbBits;
      if (bits.consumed > 64) {
        bits.consumed = 64;
      }
    }
    p += 1;
  }
  return p;
}

/** HUF_decompress1X1/1X2_usingDTable_internal (generic body). */
function decompress1X(
  table: HufTable,
  out: Uint8Array,
  dstSize: number,
  src: Uint8Array,
  start: number,
  size: number,
): void {
  const bits = new BitStream();
  if (!bits.init(src, start, size)) {
    fail('corruption_detected');
  }
  if (table.tableType === 0) {
    decodeStreamX1(out, 0, bits, dstSize, table.x1, table.tableLog);
  } else {
    decodeStreamX2(out, 0, bits, dstSize, table.x2, table.tableLog);
  }
  if (!bits.ended()) {
    fail('corruption_detected');
  }
}

/** The jump table of a 4-stream block. */
interface Streams {
  starts: number[];
  lengths: number[];
}

function readJumpTable(src: Uint8Array, start: number, size: number): Streams {
  const length1 = le16(src, start);
  const length2 = le16(src, start + 2);
  const length3 = le16(src, start + 4);
  const length4 = size - (length1 + length2 + length3 + 6);
  const start1 = start + 6;
  return {
    lengths: [length1, length2, length3, length4],
    starts: [
      start1,
      start1 + length1,
      start1 + length1 + length2,
      start1 + length1 + length2 + length3,
    ],
  };
}

/** HUF_decompress4X1_usingDTable_internal_body (generic). */
function decompress4X1Generic(
  table: HufTable,
  out: Uint8Array,
  dstSize: number,
  src: Uint8Array,
  start: number,
  size: number,
): void {
  if (size < 10 || dstSize < 6) {
    fail('corruption_detected');
  }
  const { starts, lengths } = readJumpTable(src, start, size);
  const segmentSize = Math.floor((dstSize + 3) / 4);
  const opStarts = [0, segmentSize, 2 * segmentSize, 3 * segmentSize];
  if ((lengths[3] as number) < 0 || (lengths[3] as number) > size) {
    fail('corruption_detected');
  }
  if ((opStarts[3] as number) > dstSize) {
    fail('corruption_detected');
  }
  const streams = [0, 1, 2, 3].map(() => new BitStream());
  for (let index = 0; index < 4; index += 1) {
    if (
      !(streams[index] as BitStream).init(
        src,
        starts[index] as number,
        lengths[index] as number,
      )
    ) {
      fail('corruption_detected');
    }
  }
  const dt = table.x1;
  const dtLog = table.tableLog;
  const op = [...opStarts];
  const olimit = dstSize - 3;
  if (dstSize - (op[3] as number) >= 8) {
    let endSignal = true;
    while (endSignal && (op[3] as number) < olimit) {
      for (let round = 0; round < 4; round += 1) {
        for (let index = 0; index < 4; index += 1) {
          out[op[index] as number] = decodeSymbolX1(
            streams[index] as BitStream,
            dt,
            dtLog,
          );
          op[index] = (op[index] as number) + 1;
        }
      }
      let signal = true;
      for (const stream of streams) {
        signal = stream.reloadFast() === BIT_UNFINISHED && signal;
      }
      endSignal = signal;
    }
  }
  for (let index = 0; index < 3; index += 1) {
    if ((op[index] as number) > (opStarts[index + 1] as number)) {
      fail('corruption_detected');
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const end = index === 3 ? dstSize : (opStarts[index + 1] as number);
    decodeStreamX1(
      out,
      op[index] as number,
      streams[index] as BitStream,
      end,
      dt,
      dtLog,
    );
  }
  if (!streams.every(stream => stream.ended())) {
    fail('corruption_detected');
  }
}

/** HUF_decompress4X2_usingDTable_internal_body (generic). */
function decompress4X2Generic(
  table: HufTable,
  out: Uint8Array,
  dstSize: number,
  src: Uint8Array,
  start: number,
  size: number,
): void {
  if (size < 10 || dstSize < 6) {
    fail('corruption_detected');
  }
  const { starts, lengths } = readJumpTable(src, start, size);
  const segmentSize = Math.floor((dstSize + 3) / 4);
  const opStarts = [0, segmentSize, 2 * segmentSize, 3 * segmentSize];
  if ((lengths[3] as number) < 0 || (lengths[3] as number) > size) {
    fail('corruption_detected');
  }
  if ((opStarts[3] as number) > dstSize) {
    fail('corruption_detected');
  }
  const streams = [0, 1, 2, 3].map(() => new BitStream());
  for (let index = 0; index < 4; index += 1) {
    if (
      !(streams[index] as BitStream).init(
        src,
        starts[index] as number,
        lengths[index] as number,
      )
    ) {
      fail('corruption_detected');
    }
  }
  const dt = table.x2;
  const dtLog = table.tableLog;
  const op = [...opStarts];
  const olimit = dstSize - 7;
  const decode = (index: number): void => {
    op[index] =
      (op[index] as number) +
      decodeSymbolX2(
        out,
        op[index] as number,
        streams[index] as BitStream,
        dt,
        dtLog,
      );
  };
  if (dstSize - (op[3] as number) >= 8) {
    let endSignal = true;
    while (endSignal && (op[3] as number) < olimit) {
      for (let round = 0; round < 4; round += 1) {
        decode(0);
      }
      for (let round = 0; round < 4; round += 1) {
        decode(1);
      }
      let signal = (streams[0] as BitStream).reloadFast() === BIT_UNFINISHED;
      signal =
        (streams[1] as BitStream).reloadFast() === BIT_UNFINISHED && signal;
      for (let round = 0; round < 4; round += 1) {
        decode(2);
      }
      for (let round = 0; round < 4; round += 1) {
        decode(3);
      }
      signal =
        (streams[2] as BitStream).reloadFast() === BIT_UNFINISHED && signal;
      signal =
        (streams[3] as BitStream).reloadFast() === BIT_UNFINISHED && signal;
      for (let round = 0; round < 4; round += 1) {
        for (let index = 0; index < 4; index += 1) {
          decode(index);
        }
      }
      let last = true;
      for (const stream of streams) {
        last = stream.reloadFast() === BIT_UNFINISHED && last;
      }
      // C overwrites the `endSignal &= ...` of the first two pairs.
      void signal;
      endSignal = last;
    }
  }
  for (let index = 0; index < 3; index += 1) {
    if ((op[index] as number) > (opStarts[index + 1] as number)) {
      fail('corruption_detected');
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const end = index === 3 ? dstSize : (opStarts[index + 1] as number);
    decodeStreamX2(
      out,
      op[index] as number,
      streams[index] as BitStream,
      end,
      dt,
      dtLog,
    );
  }
  if (!streams.every(stream => stream.ended())) {
    fail('corruption_detected');
  }
}

/** HUF_DecompressFastArgs. */
interface FastArgs {
  ip: number[];
  op: number[];
  bitsHi: number[];
  bitsLo: number[];
  ilowest: number;
  oend: number;
  iend: number[];
}

/**
 * HUF_DecompressFastArgs_init: null for "use the fallback", throws for
 * corruption.
 */
function fastArgsInit(
  table: HufTable,
  dstSize: number,
  src: Uint8Array,
  start: number,
  size: number,
): FastArgs | null {
  if (dstSize === 0) {
    return null;
  }
  if (size < 10) {
    fail('corruption_detected');
  }
  if (table.tableLog !== HUF_DECODER_FAST_TABLELOG) {
    return null;
  }
  const length1 = le16(src, start);
  const length2 = le16(src, start + 2);
  const length3 = le16(src, start + 4);
  const length4 = size - (length1 + length2 + length3 + 6);
  const iend0 = start + 6;
  const iend = [
    iend0,
    iend0 + length1,
    iend0 + length1 + length2,
    iend0 + length1 + length2 + length3,
  ];
  if (
    length1 < 8 ||
    length2 < 8 ||
    length3 < 8 ||
    (length4 >= 0 && length4 < 8)
  ) {
    return null;
  }
  if (length4 < 0 || length4 > size) {
    fail('corruption_detected');
  }
  const ip = [
    (iend[1] as number) - 8,
    (iend[2] as number) - 8,
    (iend[3] as number) - 8,
    start + size - 8,
  ];
  const quarter = Math.floor((dstSize + 3) / 4);
  const op = [0, quarter, 2 * quarter, 3 * quarter];
  if ((op[3] as number) >= dstSize) {
    return null;
  }
  const bitsHi: number[] = [];
  const bitsLo: number[] = [];
  for (const at of ip) {
    // HUF_initFastDStream
    const lastByte = byteAt(src, at + 7);
    const consumed = lastByte ? 8 - highbit32(lastByte) : 0;
    const [hi, lo] = read64(src, at);
    const value: U64 = [hi, (lo | 1) >>> 0];
    bitsHi.push(shiftLeft64High(value[0], value[1], consumed));
    bitsLo.push(consumed === 0 ? value[1] : (value[1] << consumed) >>> 0);
  }
  return { bitsHi, bitsLo, ilowest: start, iend, ip, oend: dstSize, op };
}

function shiftBits(args: FastArgs, stream: number, shift: number): void {
  const hi = args.bitsHi[stream] as number;
  const lo = args.bitsLo[stream] as number;
  args.bitsHi[stream] = shiftLeft64High(hi, lo, shift);
  args.bitsLo[stream] =
    shift >= 32 ? 0 : shift === 0 ? lo : (lo << shift) >>> 0;
}

/** HUF_4X1_RELOAD_STREAM / HUF_4X2_RELOAD_STREAM (without op += 5). */
function reloadFastStream(
  args: FastArgs,
  src: Uint8Array,
  stream: number,
): void {
  const ctz = ctz64(
    args.bitsHi[stream] as number,
    args.bitsLo[stream] as number,
  );
  const nbBits = ctz & 7;
  const nbBytes = ctz >> 3;
  const at = (args.ip[stream] as number) - nbBytes;
  args.ip[stream] = at;
  const [hi, lo] = read64(src, at);
  args.bitsHi[stream] = hi;
  args.bitsLo[stream] = (lo | 1) >>> 0;
  shiftBits(args, stream, nbBits);
}

/** HUF_decompress4X1_usingDTable_internal_fast_c_loop (= the BMI2 asm loop). */
function fastLoopX1(
  args: FastArgs,
  out: Uint8Array,
  src: Uint8Array,
  dt: Uint16Array,
): void {
  for (;;) {
    const oiters = Math.floor((args.oend - (args.op[3] as number)) / 5);
    const iiters = Math.floor(((args.ip[0] as number) - args.ilowest) / 7);
    const iters = Math.min(oiters, iiters);
    const olimit = (args.op[3] as number) + iters * 5;
    if (args.op[3] === olimit) {
      return;
    }
    for (let stream = 1; stream < 4; stream += 1) {
      if ((args.ip[stream] as number) < (args.ip[stream - 1] as number)) {
        return;
      }
    }
    do {
      for (let symbol = 0; symbol < 5; symbol += 1) {
        for (let stream = 0; stream < 4; stream += 1) {
          const entry = dt[(args.bitsHi[stream] as number) >>> 21] as number;
          shiftBits(args, stream, entry & 0x3f);
          out[(args.op[stream] as number) + symbol] = (entry >>> 8) & 0xff;
        }
      }
      for (let stream = 0; stream < 4; stream += 1) {
        args.op[stream] = (args.op[stream] as number) + 5;
        reloadFastStream(args, src, stream);
      }
    } while ((args.op[3] as number) < olimit);
  }
}

/** HUF_decompress4X2_usingDTable_internal_fast_c_loop (= the BMI2 asm loop). */
function fastLoopX2(
  args: FastArgs,
  out: Uint8Array,
  src: Uint8Array,
  dt: Uint32Array,
): void {
  const oend = [
    args.op[1] as number,
    args.op[2] as number,
    args.op[3] as number,
    args.oend,
  ];
  const decode = (stream: number): void => {
    const entry = dt[(args.bitsHi[stream] as number) >>> 21] as number;
    const at = args.op[stream] as number;
    out[at] = entry & 0xff;
    out[at + 1] = (entry >>> 8) & 0xff;
    shiftBits(args, stream, (entry >>> 16) & 0x3f);
    args.op[stream] = at + (entry >>> 24);
  };
  for (;;) {
    let iters = Math.floor(((args.ip[0] as number) - args.ilowest) / 7);
    for (let stream = 0; stream < 4; stream += 1) {
      const room = (oend[stream] as number) - (args.op[stream] as number);
      // size_t arithmetic: a negative room wraps to a huge value.
      const oiters =
        room < 0 ? Number.POSITIVE_INFINITY : Math.floor(room / 10);
      iters = Math.min(iters, oiters);
    }
    const olimit = (args.op[3] as number) + iters * 5;
    if (args.op[3] === olimit) {
      return;
    }
    for (let stream = 1; stream < 4; stream += 1) {
      if ((args.ip[stream] as number) < (args.ip[stream - 1] as number)) {
        return;
      }
    }
    do {
      for (let symbol = 0; symbol < 5; symbol += 1) {
        decode(0);
        decode(1);
        decode(2);
      }
      decode(3);
      for (let stream = 0; stream < 4; stream += 1) {
        decode(3);
        reloadFastStream(args, src, stream);
      }
    } while ((args.op[3] as number) < olimit);
  }
}

/**
 * HUF_decompress4X?_usingDTable_internal_fast: false for "use the
 * fallback"; the finishing streams start at `ilowest` and only the input
 * and output positions are validated, not the end of each bitstream.
 */
function decompress4XFast(
  table: HufTable,
  out: Uint8Array,
  dstSize: number,
  src: Uint8Array,
  start: number,
  size: number,
): boolean {
  const args = fastArgsInit(table, dstSize, src, start, size);
  if (args === null) {
    return false;
  }
  if (table.tableType === 0) {
    fastLoopX1(args, out, src, table.x1);
  } else {
    fastLoopX2(args, out, src, table.x2);
  }
  const segmentSize = Math.floor((dstSize + 3) / 4);
  let segmentEnd = 0;
  for (let stream = 0; stream < 4; stream += 1) {
    segmentEnd =
      segmentSize <= dstSize - segmentEnd ? segmentEnd + segmentSize : dstSize;
    // HUF_initRemainingDStream
    const op = args.op[stream] as number;
    const ip = args.ip[stream] as number;
    if (op > segmentEnd) {
      fail('corruption_detected');
    }
    if (ip < (args.iend[stream] as number) - 8) {
      fail('corruption_detected');
    }
    const bits = new BitStream();
    bits.buf = src;
    const [hi, lo] = read64(src, ip);
    bits.hi = hi;
    bits.lo = lo;
    bits.consumed = ctz64(
      args.bitsHi[stream] as number,
      args.bitsLo[stream] as number,
    );
    bits.start = args.ilowest;
    bits.limitPtr = args.ilowest + 8;
    bits.ptr = ip;
    if (table.tableType === 0) {
      decodeStreamX1(
        out,
        op,
        bits,
        segmentEnd,
        table.x1,
        HUF_DECODER_FAST_TABLELOG,
      );
    } else if (
      decodeStreamX2(
        out,
        op,
        bits,
        segmentEnd,
        table.x2,
        HUF_DECODER_FAST_TABLELOG,
      ) !== segmentEnd
    ) {
      fail('corruption_detected');
    }
  }
  return true;
}

/** HUF_decompress4X_usingDTable (BMI2 build: fast loop, then generic). */
function decompress4X(
  table: HufTable,
  out: Uint8Array,
  dstSize: number,
  src: Uint8Array,
  start: number,
  size: number,
): void {
  if (decompress4XFast(table, out, dstSize, src, start, size)) {
    return;
  }
  if (table.tableType === 0) {
    decompress4X1Generic(table, out, dstSize, src, start, size);
  } else {
    decompress4X2Generic(table, out, dstSize, src, start, size);
  }
}

const ALGO_TIME: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 1, 1],
  [0, 0, 1, 1],
  [150, 216, 381, 119],
  [170, 205, 514, 112],
  [177, 199, 539, 110],
  [197, 194, 644, 107],
  [221, 192, 735, 107],
  [256, 189, 881, 106],
  [359, 188, 1167, 109],
  [582, 187, 1570, 114],
  [688, 187, 1712, 122],
  [825, 186, 1965, 136],
  [976, 185, 2131, 150],
  [1180, 186, 2070, 175],
  [1377, 185, 1731, 202],
  [1412, 185, 1695, 202],
];

/** HUF_selectDecoder: true for the double-symbol decoder (X2). */
function selectX2(dstSize: number, srcSize: number): boolean {
  const q = srcSize >= dstSize ? 15 : Math.floor((srcSize * 16) / dstSize);
  const d256 = Math.floor(dstSize / 256);
  const row = ALGO_TIME[q] as readonly [number, number, number, number];
  const time0 = (row[0] + row[1] * d256) >>> 0;
  let time1 = (row[2] + row[3] * d256) >>> 0;
  time1 = (time1 + (time1 >>> 5)) >>> 0;
  return time1 < time0;
}

// ---------------------------------------------------------------------------
// zstd_decompress_block.c: sequence tables.

const LL_BASE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28,
  32, 40, 48, 64, 0x80, 0x1_00, 0x2_00, 0x4_00, 0x8_00, 0x10_00, 0x20_00,
  0x40_00, 0x80_00, 0x1_00_00,
];
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6,
  7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const ML_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
  24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59,
  67, 83, 99, 0x83, 0x1_03, 0x2_03, 0x4_03, 0x8_03, 0x10_03, 0x20_03, 0x40_03,
  0x80_03, 0x1_00_03,
];
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13,
  14, 15, 16,
];
const OF_BASE = [
  0, 1, 1, 5, 0xd, 0x1d, 0x3d, 0x7d, 0xfd, 0x1_fd, 0x3_fd, 0x7_fd, 0xf_fd,
  0x1f_fd, 0x3f_fd, 0x7f_fd, 0xff_fd, 0x1_ff_fd, 0x3_ff_fd, 0x7_ff_fd,
  0xf_ff_fd, 0x1f_ff_fd, 0x3f_ff_fd, 0x7f_ff_fd, 0xff_ff_fd, 0x1_ff_ff_fd,
  0x3_ff_ff_fd, 0x7_ff_ff_fd, 0xf_ff_ff_fd, 0x1f_ff_ff_fd, 0x3f_ff_ff_fd,
  0x7f_ff_ff_fd,
];
const OF_BITS = Array.from({ length: 32 }, (_, index) => index);
const LL_DEFAULT_NORM = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3,
  2, 1, 1, 1, 1, 1, -1, -1, -1, -1,
];
const ML_DEFAULT_NORM = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1,
  -1, -1, -1,
];
const OF_DEFAULT_NORM = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1,
  -1, -1, -1, -1,
];

/** ZSTD_seqSymbol table. */
interface SeqTable {
  tableLog: number;
  nextState: Uint16Array;
  nbAdditionalBits: Uint8Array;
  nbBits: Uint8Array;
  baseValue: Uint32Array;
}

/** ZSTD_buildFSETable. */
function buildSeqTable(
  norm: Int16Array,
  maxSymbolValue: number,
  baseValue: readonly number[],
  nbAdditionalBits: readonly number[],
  tableLog: number,
): SeqTable {
  const spread = spreadSymbols(norm, maxSymbolValue, tableLog);
  const size = 1 << tableLog;
  const table: SeqTable = {
    baseValue: new Uint32Array(size),
    nbAdditionalBits: new Uint8Array(size),
    nbBits: spread.nbBits,
    nextState: spread.nextState,
    tableLog,
  };
  for (let cell = 0; cell < size; cell += 1) {
    const symbol = spread.symbols[cell] as number;
    table.baseValue[cell] = baseValue[symbol] as number;
    table.nbAdditionalBits[cell] = nbAdditionalBits[symbol] as number;
  }
  return table;
}

/** ZSTD_buildSeqTable_rle. */
function rleSeqTable(baseValue: number, nbAdditionalBits: number): SeqTable {
  return {
    baseValue: Uint32Array.of(baseValue),
    nbAdditionalBits: Uint8Array.of(nbAdditionalBits),
    nbBits: Uint8Array.of(0),
    nextState: Uint16Array.of(0),
    tableLog: 0,
  };
}

function defaultSeqTable(
  norm: readonly number[],
  baseValue: readonly number[],
  nbAdditionalBits: readonly number[],
  tableLog: number,
): SeqTable {
  return buildSeqTable(
    Int16Array.from(norm),
    norm.length - 1,
    baseValue,
    nbAdditionalBits,
    tableLog,
  );
}

const LL_DEFAULT_TABLE = defaultSeqTable(LL_DEFAULT_NORM, LL_BASE, LL_BITS, 6);
const OF_DEFAULT_TABLE = defaultSeqTable(OF_DEFAULT_NORM, OF_BASE, OF_BITS, 5);
const ML_DEFAULT_TABLE = defaultSeqTable(ML_DEFAULT_NORM, ML_BASE, ML_BITS, 6);

class SeqState {
  state = 0;

  readonly table: SeqTable;

  constructor(table: SeqTable, bits: BitStream) {
    this.table = table;
    this.state = bits.read(table.tableLog);
    bits.reload();
  }
}

interface Sequence {
  litLength: number;
  matchLength: number;
  /** size_t; negative values stand for 2^64 + value. */
  offset: number;
}

/** An unsigned (size_t) `value > limit`, negative values being huge. */
function above(value: number, limit: number): boolean {
  if (value < 0 && limit < 0) {
    return value > limit;
  }
  if (value < 0 || limit < 0) {
    return value < 0;
  }
  return value > limit;
}

/** Growable byte memory addressed from 0 (outBuff or the caller's buffer). */
class Memory {
  data: Uint8Array = new Uint8Array(0);

  ensure(end: number): void {
    if (end > this.data.length) {
      const grown = new Uint8Array(
        Math.max(end, this.data.length * 2, 64 * 1024),
      );
      grown.set(this.data);
      this.data = grown;
    }
  }
}

const NOT_IN_DST = 0;
const IN_DST = 1;
const SPLIT = 2;
const LIT_MEM = 0;
const LIT_EXTRA = 1;
const LIT_SRC = 2;

// ---------------------------------------------------------------------------
// zstd_decompress.c: frame headers.

const FRAME = 0;
const SKIPPABLE_FRAME = 1;

/** ZSTD_FrameHeader. */
interface FrameParams {
  frameContentSize: bigint;
  windowSize: bigint;
  blockSizeMax: number;
  frameType: number;
  headerSize: number;
  dictID: number;
  checksumFlag: boolean;
}

/** ZSTD_getFrameHeader_advanced: `need` > 0 asks for more bytes. */
interface FrameHeaderResult {
  need: number;
  params: FrameParams | null;
}

/** ZSTD_frameHeaderSize_internal (size >= 5). */
function frameHeaderSize(src: Uint8Array, start: number): number {
  const fhd = byteAt(src, start + FRAMEHEADERSIZE_PREFIX - 1);
  const dictID = fhd & 3;
  const singleSegment = (fhd >> 5) & 1;
  const fcsId = fhd >> 6;
  return (
    FRAMEHEADERSIZE_PREFIX +
    (singleSegment ? 0 : 1) +
    (DID_FIELD_SIZE[dictID] as number) +
    (FCS_FIELD_SIZE[fcsId] as number) +
    (singleSegment && !fcsId ? 1 : 0)
  );
}

function getFrameHeader(
  src: Uint8Array,
  start: number,
  size: number,
): FrameHeaderResult {
  if (size < FRAMEHEADERSIZE_PREFIX) {
    if (size > 0) {
      const toCopy = Math.min(4, size);
      const buffer = new Uint8Array(4);
      new DataView(buffer.buffer).setUint32(0, ZSTD_MAGICNUMBER, true);
      buffer.set(src.subarray(start, start + toCopy));
      if (le32(buffer, 0) !== ZSTD_MAGICNUMBER) {
        new DataView(buffer.buffer).setUint32(
          0,
          ZSTD_MAGIC_SKIPPABLE_START,
          true,
        );
        buffer.set(src.subarray(start, start + toCopy));
        if (
          (le32(buffer, 0) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 !==
          ZSTD_MAGIC_SKIPPABLE_START
        ) {
          fail('prefix_unknown');
        }
      }
    }
    return { need: FRAMEHEADERSIZE_PREFIX, params: null };
  }
  const magic = le32(src, start);
  if (magic !== ZSTD_MAGICNUMBER) {
    if (
      (magic & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 ===
      ZSTD_MAGIC_SKIPPABLE_START
    ) {
      if (size < SKIPPABLEHEADERSIZE) {
        return { need: SKIPPABLEHEADERSIZE, params: null };
      }
      return {
        need: 0,
        params: {
          blockSizeMax: 0,
          checksumFlag: false,
          dictID: magic - ZSTD_MAGIC_SKIPPABLE_START,
          frameContentSize: BigInt(le32(src, start + 4)),
          frameType: SKIPPABLE_FRAME,
          headerSize: SKIPPABLEHEADERSIZE,
          windowSize: 0n,
        },
      };
    }
    fail('prefix_unknown');
  }
  const headerSize = frameHeaderSize(src, start);
  if (size < headerSize) {
    return { need: headerSize, params: null };
  }
  const fhd = byteAt(src, start + 4);
  let pos = start + 5;
  const dictIDSizeCode = fhd & 3;
  const checksumFlag = ((fhd >> 2) & 1) === 1;
  const singleSegment = ((fhd >> 5) & 1) === 1;
  const fcsID = fhd >> 6;
  let windowSize = 0n;
  let dictID = 0;
  let frameContentSize = CONTENTSIZE_UNKNOWN;
  if (fhd & 0x08) {
    fail('frameParameter_unsupported');
  }
  if (!singleSegment) {
    const wlByte = byteAt(src, pos);
    pos += 1;
    const windowLog = (wlByte >> 3) + WINDOWLOG_ABSOLUTEMIN;
    if (windowLog > WINDOWLOG_MAX) {
      fail('frameParameter_windowTooLarge');
    }
    windowSize = 1n << BigInt(windowLog);
    windowSize += (windowSize >> 3n) * BigInt(wlByte & 7);
  }
  if (dictIDSizeCode === 1) {
    dictID = byteAt(src, pos);
    pos += 1;
  } else if (dictIDSizeCode === 2) {
    dictID = le16(src, pos);
    pos += 2;
  } else if (dictIDSizeCode === 3) {
    dictID = le32(src, pos);
    pos += 4;
  }
  if (fcsID === 0) {
    if (singleSegment) {
      frameContentSize = BigInt(byteAt(src, pos));
    }
  } else if (fcsID === 1) {
    frameContentSize = BigInt(le16(src, pos) + 256);
  } else if (fcsID === 2) {
    frameContentSize = BigInt(le32(src, pos));
  } else {
    frameContentSize = le64(src, pos);
  }
  if (singleSegment) {
    windowSize = frameContentSize;
  }
  return {
    need: 0,
    params: {
      blockSizeMax: Number(
        windowSize < BigInt(BLOCKSIZE_MAX) ? windowSize : BigInt(BLOCKSIZE_MAX),
      ),
      checksumFlag,
      dictID,
      frameContentSize,
      frameType: FRAME,
      headerSize,
      windowSize,
    },
  };
}

/** zstd_legacy.h ZSTD_isLegacy with ZSTD_LEGACY_SUPPORT 5. */
function isLegacy(src: Uint8Array, start: number, size: number): boolean {
  if (size < 4) {
    return false;
  }
  const magic = le32(src, start);
  return (
    magic === 0xfd_2f_b5_25 ||
    magic === 0xfd_2f_b5_26 ||
    magic === 0xfd_2f_b5_27
  );
}

/** readSkippableFrameSize. */
function readSkippableFrameSize(
  src: Uint8Array,
  start: number,
  size: number,
): number {
  if (size < SKIPPABLEHEADERSIZE) {
    fail('srcSize_wrong');
  }
  const sizeU32 = le32(src, start + 4);
  if ((sizeU32 + SKIPPABLEHEADERSIZE) >>> 0 < sizeU32) {
    fail('frameParameter_unsupported');
  }
  const skippableSize = SKIPPABLEHEADERSIZE + sizeU32;
  if (skippableSize > size) {
    fail('srcSize_wrong');
  }
  return skippableSize;
}

const BT_RAW = 0;
const BT_RLE = 1;
const BT_COMPRESSED = 2;
const BT_RESERVED = 3;

interface BlockProperties {
  cSize: number;
  lastBlock: boolean;
  blockType: number;
  origSize: number;
}

/** ZSTD_getcBlockSize. */
function getcBlockSize(
  src: Uint8Array,
  start: number,
  size: number,
): BlockProperties {
  if (size < BLOCK_HEADER_SIZE) {
    fail('srcSize_wrong');
  }
  const header = le24(src, start);
  const cSize = header >>> 3;
  const blockType = (header >>> 1) & 3;
  const properties = {
    blockType,
    cSize,
    lastBlock: (header & 1) === 1,
    origSize: cSize,
  };
  if (blockType === BT_RLE) {
    return { ...properties, cSize: 1 };
  }
  if (blockType === BT_RESERVED) {
    fail('corruption_detected');
  }
  return properties;
}

/** ZSTD_findFrameSizeInfo().compressedSize; -1 for an error. */
function findFrameCompressedSize(
  src: Uint8Array,
  start: number,
  size: number,
): number {
  try {
    if (isLegacy(src, start, size)) {
      // Legacy frames are out of scope (see the header comment).
      return -1;
    }
    if (
      size >= SKIPPABLEHEADERSIZE &&
      (le32(src, start) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 ===
        ZSTD_MAGIC_SKIPPABLE_START
    ) {
      return readSkippableFrameSize(src, start, size);
    }
    const header = getFrameHeader(src, start, size);
    if (header.need > 0 || header.params === null) {
      return -1;
    }
    let ip = start + header.params.headerSize;
    let remaining = size - header.params.headerSize;
    for (;;) {
      const block = getcBlockSize(src, ip, remaining);
      if (BLOCK_HEADER_SIZE + block.cSize > remaining) {
        return -1;
      }
      ip += BLOCK_HEADER_SIZE + block.cSize;
      remaining -= BLOCK_HEADER_SIZE + block.cSize;
      if (block.lastBlock) {
        break;
      }
    }
    if (header.params.checksumFlag) {
      if (remaining < 4) {
        return -1;
      }
      ip += 4;
    }
    return ip - start;
  } catch (error) {
    if (error instanceof Fail) {
      return -1;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The decoder state: ZSTD_DCtx / ZSTD_DStream.

const STAGE_GET_FRAME_HEADER_SIZE = 0;
const STAGE_DECODE_BLOCK_HEADER = 1;
const STAGE_DECOMPRESS_BLOCK = 2;
const STAGE_DECOMPRESS_LAST_BLOCK = 3;
const STAGE_CHECK_CHECKSUM = 4;
const STAGE_SKIP_FRAME = 5;

const STREAM_INIT = 0;
const STREAM_LOAD_HEADER = 1;
const STREAM_READ = 2;
const STREAM_LOAD = 3;
const STREAM_FLUSH = 4;

interface Input {
  data: Uint8Array;
  pos: number;
  size: number;
}

/**
 * The part of CPython's output buffer ZSTD_decompressStream() sees: `pos`
 * and `pyEnd` are positions in the current CPython block; `size` is `pyEnd`
 * or less, where `cap` cuts the output short.
 */
class Output {
  readonly chunks: Uint8Array[] = [];
  kept = 0;
  pos = 0;
  size = 0;
  pyEnd = 0;
  truncated = false;

  write(data: Uint8Array): void {
    const room = Math.max(0, this.size - this.pos);
    if (data.length > room) {
      this.truncated = true;
    }
    const kept = data.subarray(0, Math.min(room, data.length));
    if (kept.length > 0) {
      this.chunks.push(kept.slice());
      this.kept += kept.length;
    }
    this.pos += data.length;
  }
}

interface FrameResult {
  decoded: number;
  consumed: number;
}

class ZstdStream {
  legacy = false;

  // ZSTD_DCtx
  private stage = STAGE_GET_FRAME_HEADER_SIZE;
  private expected = 0;
  private bType = BT_RESERVED;
  private rleSize = 0;
  private decodedSize = 0;
  private frame: FrameParams = {
    blockSizeMax: 0,
    checksumFlag: false,
    dictID: 0,
    frameContentSize: 0n,
    frameType: FRAME,
    headerSize: 0,
    windowSize: 0n,
  };
  private previousDstEnd: number | null = null;
  private prefixStart: number | null = null;
  private virtualStart: number | null = null;
  private dictEnd: number | null = null;
  private mem: Memory = new Memory();
  private readonly outBuff: Memory = this.mem;
  private readonly huf = new HufTable();
  private llTable: SeqTable = LL_DEFAULT_TABLE;
  private ofTable: SeqTable = OF_DEFAULT_TABLE;
  private mlTable: SeqTable = ML_DEFAULT_TABLE;
  private rep: number[] = [1, 4, 8];
  private litEntropy = false;
  private fseEntropy = false;
  private xxh = new Xxh64();
  private validateChecksum = false;
  private litLocation = NOT_IN_DST;
  private litBuffer = 0;
  private litBufferEnd = 0;
  private litKind = LIT_EXTRA;
  private litSrc: Uint8Array = EMPTY;
  private litPtr = 0;
  private litSize = 0;
  private readonly litExtra = new Uint8Array(
    LITBUFFEREXTRASIZE + WILDCOPY_OVERLENGTH,
  );

  // ZSTD_DStream
  private streamStage = STREAM_INIT;
  private readonly headerBuffer = new Uint8Array(18);
  private lhSize = 0;
  private inBuff: Uint8Array = EMPTY;
  private inBuffSize = 0;
  private inPos = 0;
  private outBuffSize = 0;
  private outStart = 0;
  private outEnd = 0;
  private hostageByte = false;

  /** ZSTD_decompressStream; 0 once the frame is decoded and flushed. */
  // oxlint-disable-next-line max-lines-per-function, complexity -- 1:1 port of ZSTD_decompressStream
  decompressStream(input: Input, out: Output): number {
    const istart = input.pos;
    const iend = input.size;
    let ip = istart;
    let someMoreWork = true;
    while (someMoreWork) {
      if (this.streamStage === STREAM_INIT) {
        this.streamStage = STREAM_LOAD_HEADER;
        this.lhSize = 0;
        this.inPos = 0;
        this.outStart = 0;
        this.outEnd = 0;
        this.hostageByte = false;
      }
      if (this.streamStage === STREAM_LOAD_HEADER) {
        let header: FrameHeaderResult;
        try {
          header = getFrameHeader(this.headerBuffer, 0, this.lhSize);
        } catch (error) {
          if (
            error instanceof Fail &&
            isLegacy(input.data, istart, iend - istart)
          ) {
            this.legacy = true;
            input.pos = iend;
            return 1;
          }
          throw error;
        }
        if (header.need !== 0) {
          const toLoad = header.need - this.lhSize;
          const remaining = iend - ip;
          if (toLoad > remaining) {
            this.headerBuffer.set(input.data.subarray(ip, iend), this.lhSize);
            this.lhSize += remaining;
            input.pos = iend;
            getFrameHeader(this.headerBuffer, 0, this.lhSize);
            return (
              Math.max(FRAMEHEADERSIZE_MIN, header.need) -
              this.lhSize +
              BLOCK_HEADER_SIZE
            );
          }
          this.headerBuffer.set(
            input.data.subarray(ip, ip + toLoad),
            this.lhSize,
          );
          this.lhSize = header.need;
          ip += toLoad;
          continue;
        }
        const params = header.params as FrameParams;
        this.frame = params;
        if (
          params.frameContentSize !== CONTENTSIZE_UNKNOWN &&
          params.frameType !== SKIPPABLE_FRAME &&
          BigInt(out.pyEnd - out.pos) >= params.frameContentSize
        ) {
          const cSize = findFrameCompressedSize(
            input.data,
            istart,
            iend - istart,
          );
          if (cSize >= 0 && cSize <= iend - istart) {
            // Single-pass shortcut: ZSTD_decompress_usingDDict on the frame.
            this.decompressMultiFrame(out, input.data, istart, cSize);
            ip = istart + cSize;
            this.expected = 0;
            this.streamStage = STREAM_INIT;
            someMoreWork = false;
            continue;
          }
        }
        this.decompressBegin();
        if (
          (le32(this.headerBuffer, 0) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 ===
          ZSTD_MAGIC_SKIPPABLE_START
        ) {
          this.expected = le32(this.headerBuffer, 4);
          this.stage = STAGE_SKIP_FRAME;
        } else {
          this.decodeFrameHeader(this.headerBuffer, 0, this.lhSize);
          this.expected = BLOCK_HEADER_SIZE;
          this.stage = STAGE_DECODE_BLOCK_HEADER;
        }
        const frame = this.frame;
        if (frame.windowSize < 1n << BigInt(WINDOWLOG_ABSOLUTEMIN)) {
          frame.windowSize = 1n << BigInt(WINDOWLOG_ABSOLUTEMIN);
        }
        if (frame.windowSize > BigInt(MAX_WINDOW_SIZE)) {
          fail('frameParameter_windowTooLarge');
        }
        const windowSize = Number(frame.windowSize);
        const neededInBuffSize = Math.max(frame.blockSizeMax, 4);
        const blockSize = Math.min(
          windowSize,
          BLOCKSIZE_MAX,
          frame.blockSizeMax,
        );
        const neededRBSize = BigInt(
          windowSize + blockSize * 2 + WILDCOPY_OVERLENGTH * 2,
        );
        const neededOutBuffSize = Number(
          frame.frameContentSize < neededRBSize
            ? frame.frameContentSize
            : neededRBSize,
        );
        if (
          this.inBuffSize < neededInBuffSize ||
          this.outBuffSize < neededOutBuffSize
        ) {
          this.inBuff = new Uint8Array(neededInBuffSize);
          this.inBuffSize = neededInBuffSize;
          this.outBuffSize = neededOutBuffSize;
        }
        this.streamStage = STREAM_READ;
      }
      if (this.streamStage === STREAM_READ) {
        const neededInSize = this.nextSrcSizeWithInputSize(iend - ip);
        if (neededInSize === 0) {
          this.streamStage = STREAM_INIT;
          someMoreWork = false;
          continue;
        }
        if (iend - ip >= neededInSize) {
          this.decompressContinueStream(input.data, ip, neededInSize);
          ip += neededInSize;
          continue;
        }
        if (ip === iend) {
          someMoreWork = false;
          continue;
        }
        this.streamStage = STREAM_LOAD;
      }
      if (this.streamStage === STREAM_LOAD) {
        const neededInSize = this.expected;
        const toLoad = neededInSize - this.inPos;
        let loadedSize: number;
        if (this.stage === STAGE_SKIP_FRAME) {
          loadedSize = Math.min(toLoad, iend - ip);
        } else {
          if (toLoad > this.inBuffSize - this.inPos) {
            fail('corruption_detected');
          }
          loadedSize = Math.min(toLoad, iend - ip);
          this.inBuff.set(input.data.subarray(ip, ip + loadedSize), this.inPos);
        }
        ip += loadedSize;
        this.inPos += loadedSize;
        if (loadedSize < toLoad) {
          someMoreWork = false;
          continue;
        }
        this.inPos = 0;
        this.decompressContinueStream(this.inBuff, 0, neededInSize);
        continue;
      }
      if (this.streamStage === STREAM_FLUSH) {
        const toFlushSize = this.outEnd - this.outStart;
        const flushedSize = Math.min(
          Math.max(0, out.size - out.pos),
          toFlushSize,
        );
        out.write(
          this.outBuff.data.subarray(
            this.outStart,
            this.outStart + flushedSize,
          ),
        );
        this.outStart += flushedSize;
        if (flushedSize === toFlushSize) {
          this.streamStage = STREAM_READ;
          if (
            BigInt(this.outBuffSize) < this.frame.frameContentSize &&
            this.outStart + this.frame.blockSizeMax > this.outBuffSize
          ) {
            this.outStart = 0;
            this.outEnd = 0;
          }
          continue;
        }
        someMoreWork = false;
      }
    }
    input.pos = ip;
    if (this.expected === 0) {
      if (this.outEnd === this.outStart) {
        if (this.hostageByte) {
          if (input.pos >= input.size) {
            this.streamStage = STREAM_READ;
            return 1;
          }
          input.pos += 1;
        }
        return 0;
      }
      if (!this.hostageByte) {
        input.pos -= 1;
        this.hostageByte = true;
      }
      return 1;
    }
    return this.expected;
  }

  /** ZSTD_decompressBegin. */
  private decompressBegin(): void {
    this.expected = FRAMEHEADERSIZE_PREFIX;
    this.stage = STAGE_GET_FRAME_HEADER_SIZE;
    this.decodedSize = 0;
    this.previousDstEnd = null;
    this.prefixStart = null;
    this.virtualStart = null;
    this.dictEnd = null;
    this.huf.tableType = 0;
    this.huf.tableLog = 0;
    this.litEntropy = false;
    this.fseEntropy = false;
    this.bType = BT_RESERVED;
    this.rep = [1, 4, 8];
  }

  /** ZSTD_decodeFrameHeader (no dictionary: dctx->dictID is 0). */
  private decodeFrameHeader(
    src: Uint8Array,
    start: number,
    headerSize: number,
  ): void {
    const header = getFrameHeader(src, start, headerSize);
    if (header.need > 0 || header.params === null) {
      fail('srcSize_wrong');
    }
    this.frame = header.params;
    if (this.frame.dictID !== 0) {
      fail('dictionary_wrong');
    }
    this.validateChecksum = this.frame.checksumFlag;
    this.xxh = new Xxh64();
  }

  /** ZSTD_checkContinuity. */
  private checkContinuity(dst: number, dstSize: number): void {
    if (dst !== this.previousDstEnd && dstSize > 0) {
      this.dictEnd = this.previousDstEnd;
      this.virtualStart =
        dst - ((this.previousDstEnd ?? 0) - (this.prefixStart ?? 0));
      this.prefixStart = dst;
      this.previousDstEnd = dst;
    }
  }

  private nextSrcSizeWithInputSize(inputSize: number): number {
    if (
      this.stage !== STAGE_DECOMPRESS_BLOCK &&
      this.stage !== STAGE_DECOMPRESS_LAST_BLOCK
    ) {
      return this.expected;
    }
    if (this.bType !== BT_RAW) {
      return this.expected;
    }
    return Math.max(1, Math.min(inputSize, this.expected));
  }

  /** ZSTD_decompressContinueStream (buffered output mode). */
  private decompressContinueStream(
    src: Uint8Array,
    start: number,
    size: number,
  ): void {
    const isSkipFrame = this.stage === STAGE_SKIP_FRAME;
    const dstSize = isSkipFrame ? 0 : this.outBuffSize - this.outStart;
    const decodedSize = this.decompressContinue(
      this.outStart,
      dstSize,
      src,
      start,
      size,
    );
    if (!decodedSize && !isSkipFrame) {
      this.streamStage = STREAM_READ;
    } else {
      this.outEnd = this.outStart + decodedSize;
      this.streamStage = STREAM_FLUSH;
    }
  }

  private finishFrameAfterLastBlock(): void {
    if (this.frame.checksumFlag) {
      this.expected = 4;
      this.stage = STAGE_CHECK_CHECKSUM;
    } else {
      this.expected = 0;
      this.stage = STAGE_GET_FRAME_HEADER_SIZE;
    }
  }

  /** ZSTD_decompressContinue for the stages streaming reaches. */
  // oxlint-disable-next-line max-lines-per-function, complexity -- 1:1 port of ZSTD_decompressContinue
  private decompressContinue(
    dst: number,
    dstCapacity: number,
    src: Uint8Array,
    start: number,
    size: number,
  ): number {
    if (size !== this.nextSrcSizeWithInputSize(size)) {
      fail('srcSize_wrong');
    }
    this.mem = this.outBuff;
    this.checkContinuity(dst, dstCapacity);
    if (this.stage === STAGE_DECODE_BLOCK_HEADER) {
      const block = getcBlockSize(src, start, BLOCK_HEADER_SIZE);
      if (block.cSize > this.frame.blockSizeMax) {
        fail('corruption_detected');
      }
      this.expected = block.cSize;
      this.bType = block.blockType;
      this.rleSize = block.origSize;
      if (block.cSize) {
        this.stage = block.lastBlock
          ? STAGE_DECOMPRESS_LAST_BLOCK
          : STAGE_DECOMPRESS_BLOCK;
        return 0;
      }
      if (block.lastBlock) {
        this.finishFrameAfterLastBlock();
      } else {
        this.expected = BLOCK_HEADER_SIZE;
        this.stage = STAGE_DECODE_BLOCK_HEADER;
      }
      return 0;
    }
    if (
      this.stage === STAGE_DECOMPRESS_BLOCK ||
      this.stage === STAGE_DECOMPRESS_LAST_BLOCK
    ) {
      let rSize: number;
      if (this.bType === BT_COMPRESSED) {
        rSize = this.decompressBlock(dst, dstCapacity, src, start, size, true);
        this.expected = 0;
      } else if (this.bType === BT_RAW) {
        if (size > dstCapacity) {
          fail('dstSize_tooSmall');
        }
        this.mem.ensure(dst + size);
        this.mem.data.set(src.subarray(start, start + size), dst);
        rSize = size;
        this.expected -= rSize;
      } else if (this.bType === BT_RLE) {
        if (this.rleSize > dstCapacity) {
          fail('dstSize_tooSmall');
        }
        this.mem.ensure(dst + this.rleSize);
        this.mem.data.fill(byteAt(src, start), dst, dst + this.rleSize);
        rSize = this.rleSize;
        this.expected = 0;
      } else {
        fail('corruption_detected');
      }
      if (rSize > this.frame.blockSizeMax) {
        fail('corruption_detected');
      }
      this.decodedSize += rSize;
      if (this.validateChecksum) {
        this.xxh.update(this.mem.data, dst, dst + rSize);
      }
      this.previousDstEnd = dst + rSize;
      if (this.expected > 0) {
        return rSize;
      }
      if (this.stage === STAGE_DECOMPRESS_LAST_BLOCK) {
        if (
          this.frame.frameContentSize !== CONTENTSIZE_UNKNOWN &&
          BigInt(this.decodedSize) !== this.frame.frameContentSize
        ) {
          fail('corruption_detected');
        }
        this.finishFrameAfterLastBlock();
      } else {
        this.stage = STAGE_DECODE_BLOCK_HEADER;
        this.expected = BLOCK_HEADER_SIZE;
      }
      return rSize;
    }
    if (this.stage === STAGE_CHECK_CHECKSUM) {
      if (
        this.validateChecksum &&
        this.xxh.digestLow32() !== le32(src, start)
      ) {
        fail('checksum_wrong');
      }
      this.expected = 0;
      this.stage = STAGE_GET_FRAME_HEADER_SIZE;
      return 0;
    }
    if (this.stage === STAGE_SKIP_FRAME) {
      this.expected = 0;
      this.stage = STAGE_GET_FRAME_HEADER_SIZE;
      return 0;
    }
    return fail('GENERIC');
  }

  /**
   * ZSTD_decompress_usingDDict(zds, op, oend - op, istart, cSize, NULL) for
   * the single-pass shortcut, writing into CPython's output buffer.
   */
  private decompressMultiFrame(
    out: Output,
    src: Uint8Array,
    start: number,
    size: number,
  ): void {
    const scratch = new Memory();
    this.mem = scratch;
    let dst = 0;
    let dstCapacity = out.pyEnd - out.pos;
    let ip = start;
    let remaining = size;
    let moreThan1Frame = false;
    while (remaining >= FRAMEHEADERSIZE_PREFIX) {
      if (isLegacy(src, ip, remaining)) {
        // Out of scope (see the header comment): treat as no output.
        this.legacy = true;
        break;
      }
      if (remaining >= 4) {
        const magic = le32(src, ip);
        if (
          (magic & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 ===
          ZSTD_MAGIC_SKIPPABLE_START
        ) {
          const skippableSize = readSkippableFrameSize(src, ip, remaining);
          ip += skippableSize;
          remaining -= skippableSize;
          continue;
        }
      }
      this.decompressBegin();
      this.checkContinuity(dst, dstCapacity);
      let result: FrameResult;
      try {
        result = this.decompressFrame(dst, dstCapacity, src, ip, remaining);
      } catch (error) {
        if (
          error instanceof Fail &&
          error.code === 'prefix_unknown' &&
          moreThan1Frame
        ) {
          fail('srcSize_wrong');
        }
        throw error;
      }
      dst += result.decoded;
      dstCapacity -= result.decoded;
      ip += result.consumed;
      remaining -= result.consumed;
      moreThan1Frame = true;
    }
    if (remaining && !this.legacy) {
      fail('srcSize_wrong');
    }
    out.write(scratch.data.subarray(0, dst));
    this.mem = this.outBuff;
  }

  /** ZSTD_decompressFrame. */
  private decompressFrame(
    dst: number,
    dstCapacity: number,
    src: Uint8Array,
    start: number,
    size: number,
  ): FrameResult {
    const oend = dst + dstCapacity;
    let op = dst;
    let ip = start;
    let remaining = size;
    if (remaining < FRAMEHEADERSIZE_MIN + BLOCK_HEADER_SIZE) {
      fail('srcSize_wrong');
    }
    const headerSize = frameHeaderSize(src, ip);
    if (remaining < headerSize + BLOCK_HEADER_SIZE) {
      fail('srcSize_wrong');
    }
    this.decodeFrameHeader(src, ip, headerSize);
    ip += headerSize;
    remaining -= headerSize;
    for (;;) {
      const block = getcBlockSize(src, ip, remaining);
      ip += BLOCK_HEADER_SIZE;
      remaining -= BLOCK_HEADER_SIZE;
      if (block.cSize > remaining) {
        fail('srcSize_wrong');
      }
      let decodedSize: number;
      if (block.blockType === BT_COMPRESSED) {
        decodedSize = this.decompressBlock(
          op,
          oend - op,
          src,
          ip,
          block.cSize,
          false,
        );
      } else if (block.blockType === BT_RAW) {
        if (block.cSize > oend - op) {
          fail('dstSize_tooSmall');
        }
        this.mem.ensure(op + block.cSize);
        this.mem.data.set(src.subarray(ip, ip + block.cSize), op);
        decodedSize = block.cSize;
      } else {
        if (block.origSize > oend - op) {
          fail('dstSize_tooSmall');
        }
        this.mem.ensure(op + block.origSize);
        this.mem.data.fill(byteAt(src, ip), op, op + block.origSize);
        decodedSize = block.origSize;
      }
      if (this.validateChecksum) {
        this.xxh.update(this.mem.data, op, op + decodedSize);
      }
      op += decodedSize;
      ip += block.cSize;
      remaining -= block.cSize;
      if (block.lastBlock) {
        break;
      }
    }
    if (
      this.frame.frameContentSize !== CONTENTSIZE_UNKNOWN &&
      BigInt(op - dst) !== this.frame.frameContentSize
    ) {
      fail('corruption_detected');
    }
    if (this.frame.checksumFlag) {
      if (remaining < 4) {
        fail('checksum_wrong');
      }
      if (this.xxh.digestLow32() !== le32(src, ip)) {
        fail('checksum_wrong');
      }
      ip += 4;
      remaining -= 4;
    }
    return { consumed: ip - start, decoded: op - dst };
  }

  // -------------------------------------------------------------------------
  // zstd_decompress_block.c

  /** ZSTD_decompressBlock_internal. */
  private decompressBlock(
    dst: number,
    dstCapacity: number,
    src: Uint8Array,
    start: number,
    size: number,
    streaming: boolean,
  ): number {
    const blockSizeMax = this.frame.blockSizeMax;
    if (size > blockSizeMax) {
      fail('srcSize_wrong');
    }
    const litCSize = this.decodeLiterals(
      src,
      start,
      size,
      dst,
      dstCapacity,
      streaming,
    );
    let ip = start + litCSize;
    let remaining = size - litCSize;
    const historyEnd = dst + Math.min(dstCapacity, blockSizeMax);
    const totalHistorySize = historyEnd - (this.virtualStart ?? 0);
    const headers = this.decodeSeqHeaders(src, ip, remaining);
    const { nbSeq } = headers;
    ip += headers.size;
    remaining -= headers.size;
    if (dstCapacity === 0 && nbSeq > 0) {
      fail('dstSize_tooSmall');
    }
    let usePrefetchDecoder = false;
    if (totalHistorySize > 1 << 24 && nbSeq > 8) {
      // ZSTD_getOffsetInfo(OFTptr).longOffsetShare >= 7 (64-bit)
      const table = this.ofTable;
      let share = 0;
      for (let cell = 0; cell < 1 << table.tableLog; cell += 1) {
        if ((table.nbAdditionalBits[cell] as number) > 22) {
          share += 1;
        }
      }
      share <<= OFF_FSE_LOG - table.tableLog;
      usePrefetchDecoder = share >= 7;
    }
    if (usePrefetchDecoder) {
      return this.sequencesLong(dst, dstCapacity, src, ip, remaining, nbSeq);
    }
    if (this.litLocation === SPLIT) {
      return this.sequencesSplit(dst, dstCapacity, src, ip, remaining, nbSeq);
    }
    return this.sequences(dst, dstCapacity, src, ip, remaining, nbSeq);
  }

  /** ZSTD_allocateLiteralsBuffer. */
  private allocateLiterals(
    dst: number,
    dstCapacity: number,
    litSize: number,
    streaming: boolean,
    expectedWriteSize: number,
    splitImmediately: boolean,
  ): void {
    const blockSizeMax = this.frame.blockSizeMax;
    if (
      !streaming &&
      dstCapacity >
        blockSizeMax + WILDCOPY_OVERLENGTH + litSize + WILDCOPY_OVERLENGTH
    ) {
      this.litBuffer = dst + blockSizeMax + WILDCOPY_OVERLENGTH;
      this.litBufferEnd = this.litBuffer + litSize;
      this.litLocation = IN_DST;
      this.litKind = LIT_MEM;
    } else if (litSize <= LITBUFFEREXTRASIZE) {
      this.litBuffer = 0;
      this.litBufferEnd = litSize;
      this.litLocation = NOT_IN_DST;
      this.litKind = LIT_EXTRA;
    } else {
      if (splitImmediately) {
        this.litBuffer =
          dst +
          expectedWriteSize -
          litSize +
          LITBUFFEREXTRASIZE -
          WILDCOPY_OVERLENGTH;
        this.litBufferEnd = this.litBuffer + litSize - LITBUFFEREXTRASIZE;
      } else {
        this.litBuffer = dst + expectedWriteSize - litSize;
        this.litBufferEnd = dst + expectedWriteSize;
      }
      this.litLocation = SPLIT;
      this.litKind = LIT_MEM;
    }
  }

  /** Store literal bytes where ZSTD_allocateLiteralsBuffer put them. */
  private storeLiterals(literals: Uint8Array, splitImmediately: boolean): void {
    const litSize = literals.length;
    if (this.litLocation === NOT_IN_DST) {
      this.litExtra.set(literals, 0);
      return;
    }
    if (this.litLocation === IN_DST) {
      this.mem.ensure(this.litBuffer + litSize);
      this.mem.data.set(literals, this.litBuffer);
      return;
    }
    if (splitImmediately) {
      const head = litSize - LITBUFFEREXTRASIZE;
      this.mem.ensure(this.litBuffer + head);
      this.mem.data.set(literals.subarray(0, head), this.litBuffer);
      this.litExtra.set(literals.subarray(head), 0);
      return;
    }
    // Decoded into dst, then the tail moves to litExtraBuffer and the head
    // is shifted forward (ZSTD_decodeLiteralsBlock, ZSTD_split).
    const data = (): Uint8Array => this.mem.data;
    this.mem.ensure(this.litBufferEnd);
    data().set(literals, this.litBuffer);
    this.litExtra.set(
      data().subarray(
        this.litBufferEnd - LITBUFFEREXTRASIZE,
        this.litBufferEnd,
      ),
      0,
    );
    const target = this.litBuffer + LITBUFFEREXTRASIZE - WILDCOPY_OVERLENGTH;
    this.mem.ensure(target + litSize - LITBUFFEREXTRASIZE);
    data().copyWithin(
      target,
      this.litBuffer,
      this.litBuffer + litSize - LITBUFFEREXTRASIZE,
    );
    this.litBuffer = target;
    this.litBufferEnd -= WILDCOPY_OVERLENGTH;
  }

  /** ZSTD_decodeLiteralsBlock; returns the bytes read. */
  // oxlint-disable-next-line max-lines-per-function, complexity -- 1:1 port of ZSTD_decodeLiteralsBlock
  private decodeLiterals(
    src: Uint8Array,
    start: number,
    size: number,
    dst: number,
    dstCapacity: number,
    streaming: boolean,
  ): number {
    if (size < MIN_CBLOCK_SIZE) {
      fail('corruption_detected');
    }
    const first = byteAt(src, start);
    const litEncType = first & 3;
    const blockSizeMax = this.frame.blockSizeMax;
    const lhlCode = (first >> 2) & 3;
    const expectedWriteSize = Math.min(blockSizeMax, dstCapacity);
    if (litEncType === 3 || litEncType === 2) {
      if (litEncType === 3 && !this.litEntropy) {
        fail('dictionary_corrupted');
      }
      if (size < 5) {
        fail('corruption_detected');
      }
      const lhc = le32(src, start);
      let singleStream = false;
      let lhSize: number;
      let litSize: number;
      let litCSize: number;
      if (lhlCode <= 1) {
        singleStream = lhlCode === 0;
        lhSize = 3;
        litSize = (lhc >>> 4) & 0x3_ff;
        litCSize = (lhc >>> 14) & 0x3_ff;
      } else if (lhlCode === 2) {
        lhSize = 4;
        litSize = (lhc >>> 4) & 0x3f_ff;
        litCSize = lhc >>> 18;
      } else {
        lhSize = 5;
        litSize = (lhc >>> 4) & 0x3_ff_ff;
        litCSize = (lhc >>> 22) + byteAt(src, start + 4) * 1024;
      }
      if (litSize > blockSizeMax) {
        fail('corruption_detected');
      }
      if (!singleStream && litSize < MIN_LITERALS_FOR_4_STREAMS) {
        fail('literals_headerWrong');
      }
      if (litCSize + lhSize > size) {
        fail('corruption_detected');
      }
      if (expectedWriteSize < litSize) {
        fail('dstSize_tooSmall');
      }
      this.allocateLiterals(
        dst,
        dstCapacity,
        litSize,
        streaming,
        expectedWriteSize,
        false,
      );
      const literals = new Uint8Array(litSize + 2 * WILDCOPY_OVERLENGTH);
      const hufStart = start + lhSize;
      let hufFailed = false;
      try {
        this.decodeHuffmanLiterals(
          litEncType === 3,
          singleStream,
          literals,
          litSize,
          src,
          hufStart,
          litCSize,
        );
      } catch (error) {
        if (!(error instanceof Fail)) {
          throw error;
        }
        hufFailed = true;
      }
      this.storeLiterals(literals.subarray(0, litSize), false);
      if (hufFailed) {
        fail('corruption_detected');
      }
      this.litPtr = this.litBuffer;
      this.litSize = litSize;
      this.litEntropy = true;
      return litCSize + lhSize;
    }
    let lhSize: number;
    let litSize: number;
    if (lhlCode === 1) {
      lhSize = 2;
      if (litEncType === 1 && size < 3) {
        fail('corruption_detected');
      }
      litSize = le16(src, start) >> 4;
    } else if (lhlCode === 3) {
      lhSize = 3;
      if (size < (litEncType === 1 ? 4 : 3)) {
        fail('corruption_detected');
      }
      litSize = le24(src, start) >> 4;
    } else {
      lhSize = 1;
      litSize = first >> 3;
    }
    if (litSize > blockSizeMax) {
      fail('corruption_detected');
    }
    if (expectedWriteSize < litSize) {
      fail('dstSize_tooSmall');
    }
    this.allocateLiterals(
      dst,
      dstCapacity,
      litSize,
      streaming,
      expectedWriteSize,
      true,
    );
    if (litEncType === 1) {
      // set_rle
      this.storeLiterals(
        new Uint8Array(litSize).fill(byteAt(src, start + lhSize)),
        true,
      );
      this.litPtr = this.litBuffer;
      this.litSize = litSize;
      return lhSize + 1;
    }
    // set_basic
    if (lhSize + litSize + WILDCOPY_OVERLENGTH > size) {
      if (litSize + lhSize > size) {
        fail('corruption_detected');
      }
      this.storeLiterals(
        src.subarray(start + lhSize, start + lhSize + litSize),
        true,
      );
      this.litPtr = this.litBuffer;
      this.litSize = litSize;
      return lhSize + litSize;
    }
    this.litKind = LIT_SRC;
    this.litSrc = src;
    this.litPtr = start + lhSize;
    this.litSize = litSize;
    this.litBufferEnd = this.litPtr + litSize;
    this.litLocation = NOT_IN_DST;
    return lhSize + litSize;
  }

  /** The HUF_* calls of ZSTD_decodeLiteralsBlock (set_compressed/repeat). */
  private decodeHuffmanLiterals(
    repeat: boolean,
    singleStream: boolean,
    out: Uint8Array,
    litSize: number,
    src: Uint8Array,
    start: number,
    size: number,
  ): void {
    const table = this.huf;
    if (repeat) {
      if (singleStream) {
        decompress1X(table, out, litSize, src, start, size);
      } else {
        decompress4X(table, out, litSize, src, start, size);
      }
      return;
    }
    if (singleStream) {
      // HUF_decompress1X1_DCtx_wksp
      const headerSize = readDTableX1(table, src, start, size);
      if (headerSize >= size) {
        fail('srcSize_wrong');
      }
      decompress1X(
        table,
        out,
        litSize,
        src,
        start + headerSize,
        size - headerSize,
      );
      return;
    }
    // HUF_decompress4X_hufOnly_wksp
    if (litSize === 0) {
      fail('dstSize_tooSmall');
    }
    if (size === 0) {
      fail('corruption_detected');
    }
    const headerSize = selectX2(litSize, size)
      ? readDTableX2(table, src, start, size)
      : readDTableX1(table, src, start, size);
    if (headerSize >= size) {
      fail('srcSize_wrong');
    }
    decompress4X(
      table,
      out,
      litSize,
      src,
      start + headerSize,
      size - headerSize,
    );
  }

  /** ZSTD_decodeSeqHeaders + ZSTD_buildSeqTable. */
  private decodeSeqHeaders(
    src: Uint8Array,
    start: number,
    size: number,
  ): { nbSeq: number; size: number } {
    const iend = start + size;
    let ip = start;
    if (size < 1) {
      fail('srcSize_wrong');
    }
    let nbSeq = byteAt(src, ip);
    ip += 1;
    if (nbSeq > 0x7f) {
      if (nbSeq === 0xff) {
        if (ip + 2 > iend) {
          fail('srcSize_wrong');
        }
        nbSeq = le16(src, ip) + LONGNBSEQ;
        ip += 2;
      } else {
        if (ip >= iend) {
          fail('srcSize_wrong');
        }
        nbSeq = ((nbSeq - 0x80) << 8) + byteAt(src, ip);
        ip += 1;
      }
    }
    if (nbSeq === 0) {
      if (ip !== iend) {
        fail('corruption_detected');
      }
      return { nbSeq, size: ip - start };
    }
    if (ip + 1 > iend) {
      fail('srcSize_wrong');
    }
    const types = byteAt(src, ip);
    if (types & 3) {
      fail('corruption_detected');
    }
    ip += 1;
    const build = (
      type: number,
      max: number,
      maxLog: number,
      baseValue: readonly number[],
      bits: readonly number[],
      defaultTable: SeqTable,
      current: SeqTable,
    ): { table: SeqTable; size: number } => {
      const available = iend - ip;
      if (type === 1) {
        // set_rle
        if (!available) {
          fail('corruption_detected');
        }
        const symbol = byteAt(src, ip);
        if (symbol > max) {
          fail('corruption_detected');
        }
        return {
          size: 1,
          table: rleSeqTable(
            baseValue[symbol] as number,
            bits[symbol] as number,
          ),
        };
      }
      if (type === 0) {
        return { size: 0, table: defaultTable };
      }
      if (type === 3) {
        if (!this.fseEntropy) {
          fail('corruption_detected');
        }
        return { size: 0, table: current };
      }
      const norm = new Int16Array(256);
      const header = readNCount(norm, max, src, ip, available);
      if (header.tableLog > maxLog) {
        fail('corruption_detected');
      }
      return {
        size: header.size,
        table: buildSeqTable(
          norm,
          header.maxSymbolValue,
          baseValue,
          bits,
          header.tableLog,
        ),
      };
    };
    const ll = build(
      types >> 6,
      MAX_LL,
      LL_FSE_LOG,
      LL_BASE,
      LL_BITS,
      LL_DEFAULT_TABLE,
      this.llTable,
    );
    this.llTable = ll.table;
    ip += ll.size;
    const of = build(
      (types >> 4) & 3,
      MAX_OFF,
      OFF_FSE_LOG,
      OF_BASE,
      OF_BITS,
      OF_DEFAULT_TABLE,
      this.ofTable,
    );
    this.ofTable = of.table;
    ip += of.size;
    const ml = build(
      (types >> 2) & 3,
      MAX_ML,
      ML_FSE_LOG,
      ML_BASE,
      ML_BITS,
      ML_DEFAULT_TABLE,
      this.mlTable,
    );
    this.mlTable = ml.table;
    ip += ml.size;
    return { nbSeq, size: ip - start };
  }

  // Sequences.

  private litByteSource(): Uint8Array {
    if (this.litKind === LIT_MEM) {
      return this.mem.data;
    }
    return this.litKind === LIT_EXTRA ? this.litExtra : this.litSrc;
  }

  /** Copy `length` literals to `op` (forward: dst is before src). */
  private copyLiterals(op: number, length: number): void {
    this.mem.ensure(op + length);
    const data = this.mem.data;
    if (this.litKind === LIT_MEM) {
      this.mem.ensure(this.litPtr + length);
      this.mem.data.copyWithin(op, this.litPtr, this.litPtr + length);
    } else {
      const source = this.litByteSource();
      for (let index = 0; index < length; index += 1) {
        data[op + index] = source[this.litPtr + index] ?? 0;
      }
    }
    this.litPtr += length;
  }

  /** LZ77 copy (source before destination, overlap repeats bytes). */
  private copyMatch(op: number, match: number, length: number): void {
    this.mem.ensure(op + length);
    const data = this.mem.data;
    if (op - match >= length) {
      data.copyWithin(op, match, match + length);
      return;
    }
    for (let index = 0; index < length; index += 1) {
      data[op + index] = data[match + index] as number;
    }
  }

  /**
   * ZSTD_execSequence / ZSTD_execSequenceSplitLitBuffer: the checks of their
   * *End variants (the fast paths can't fail them), then the copies.
   */
  private execSequence(
    op: number,
    oend: number,
    sequence: Sequence,
    litLimit: number,
    split: boolean,
  ): number {
    const oLitEnd = op + sequence.litLength;
    const sequenceLength = sequence.litLength + sequence.matchLength;
    if (above(sequenceLength, oend - op)) {
      fail('dstSize_tooSmall');
    }
    if (above(sequence.litLength, litLimit - this.litPtr)) {
      fail('corruption_detected');
    }
    if (split && op > this.litPtr && op < this.litPtr + sequence.litLength) {
      fail('dstSize_tooSmall');
    }
    this.copyLiterals(op, sequence.litLength);
    const prefixStart = this.prefixStart ?? 0;
    let matchLength = sequence.matchLength;
    let target = oLitEnd;
    let match = oLitEnd - sequence.offset;
    if (above(sequence.offset, oLitEnd - prefixStart)) {
      if (above(sequence.offset, oLitEnd - (this.virtualStart ?? 0))) {
        fail('corruption_detected');
      }
      const dictEnd = this.dictEnd ?? 0;
      match = dictEnd - (prefixStart - match);
      this.mem.ensure(Math.max(oLitEnd + matchLength, dictEnd));
      if (match + matchLength <= dictEnd) {
        this.mem.data.copyWithin(oLitEnd, match, match + matchLength);
        return op + sequenceLength;
      }
      const length1 = dictEnd - match;
      this.mem.data.copyWithin(oLitEnd, match, match + length1);
      target = oLitEnd + length1;
      matchLength -= length1;
      match = prefixStart;
    }
    this.copyMatch(target, match, matchLength);
    return op + sequenceLength;
  }

  private decodeSequence(
    bits: BitStream,
    ll: SeqState,
    ml: SeqState,
    of: SeqState,
    prevOffset: number[],
    isLastSeq: boolean,
  ): Sequence {
    const llCell = ll.state;
    const mlCell = ml.state;
    const ofCell = of.state;
    const llBase = ll.table.baseValue[llCell] as number;
    const mlBase = ml.table.baseValue[mlCell] as number;
    const ofBase = of.table.baseValue[ofCell] as number;
    const llBits = ll.table.nbAdditionalBits[llCell] as number;
    const mlBits = ml.table.nbAdditionalBits[mlCell] as number;
    const ofBits = of.table.nbAdditionalBits[ofCell] as number;
    const totalBits = llBits + mlBits + ofBits;
    let offset: number;
    if (ofBits > 1) {
      offset = ofBase + bits.readFast(ofBits);
      prevOffset[2] = prevOffset[1] as number;
      prevOffset[1] = prevOffset[0] as number;
      prevOffset[0] = offset;
    } else {
      const ll0 = llBase === 0 ? 1 : 0;
      if (ofBits === 0) {
        offset = prevOffset[ll0] as number;
        prevOffset[1] = prevOffset[1 - ll0] as number;
        prevOffset[0] = offset;
      } else {
        offset = ofBase + ll0 + bits.readFast(1);
        let temp =
          offset === 3
            ? (prevOffset[0] as number) - 1
            : (prevOffset[offset] as number);
        if (temp === 0) {
          temp = -1;
        }
        if (offset !== 1) {
          prevOffset[2] = prevOffset[1] as number;
        }
        prevOffset[1] = prevOffset[0] as number;
        prevOffset[0] = temp;
        offset = temp;
      }
    }
    let matchLength = mlBase;
    if (mlBits > 0) {
      matchLength += bits.readFast(mlBits);
    }
    if (totalBits >= 57 - (LL_FSE_LOG + ML_FSE_LOG + OFF_FSE_LOG)) {
      bits.reload();
    }
    let litLength = llBase;
    if (llBits > 0) {
      litLength += bits.readFast(llBits);
    }
    if (!isLastSeq) {
      ll.state =
        (ll.table.nextState[llCell] as number) +
        bits.read(ll.table.nbBits[llCell] as number);
      ml.state =
        (ml.table.nextState[mlCell] as number) +
        bits.read(ml.table.nbBits[mlCell] as number);
      of.state =
        (of.table.nextState[ofCell] as number) +
        bits.read(of.table.nbBits[ofCell] as number);
      bits.reload();
    }
    return { litLength, matchLength, offset };
  }

  /** The common start of the ZSTD_decompressSequences* bodies. */
  private startSequences(
    src: Uint8Array,
    start: number,
    size: number,
  ): {
    bits: BitStream;
    ll: SeqState;
    of: SeqState;
    ml: SeqState;
    prevOffset: number[];
  } {
    this.fseEntropy = true;
    const prevOffset = [...this.rep];
    const bits = new BitStream();
    if (!bits.init(src, start, size)) {
      fail('corruption_detected');
    }
    const ll = new SeqState(this.llTable, bits);
    const of = new SeqState(this.ofTable, bits);
    const ml = new SeqState(this.mlTable, bits);
    return { bits, ll, ml, of, prevOffset };
  }

  private saveRep(prevOffset: number[]): void {
    this.rep = prevOffset.map(value => value >>> 0);
  }

  /** ZSTD_decompressSequences_body. */
  private sequences(
    dst: number,
    maxDstSize: number,
    src: Uint8Array,
    start: number,
    size: number,
    nbSeqIn: number,
  ): number {
    const oend =
      this.litLocation === NOT_IN_DST ? dst + maxDstSize : this.litBuffer;
    let op = dst;
    const litEnd = this.litPtr + this.litSize;
    if (nbSeqIn) {
      const state = this.startSequences(src, start, size);
      for (let nbSeq = nbSeqIn; nbSeq; nbSeq -= 1) {
        const sequence = this.decodeSequence(
          state.bits,
          state.ll,
          state.ml,
          state.of,
          state.prevOffset,
          nbSeq === 1,
        );
        op = this.execSequence(op, oend, sequence, litEnd, false);
      }
      if (!state.bits.ended()) {
        fail('corruption_detected');
      }
      this.saveRep(state.prevOffset);
    }
    const lastLLSize = litEnd - this.litPtr;
    if (above(lastLLSize, oend - op)) {
      fail('dstSize_tooSmall');
    }
    this.copyLiterals(op, lastLLSize);
    op += lastLLSize;
    return op - dst;
  }

  /** Switch from the literals in dst to litExtraBuffer (ZSTD_split). */
  private switchToExtraLiterals(): void {
    this.litKind = LIT_EXTRA;
    this.litPtr = 0;
    this.litLocation = NOT_IN_DST;
  }

  /** ZSTD_decompressSequences_bodySplitLitBuffer. */
  // oxlint-disable-next-line max-lines-per-function -- 1:1 port
  private sequencesSplit(
    dst: number,
    maxDstSize: number,
    src: Uint8Array,
    start: number,
    size: number,
    nbSeqIn: number,
  ): number {
    const oend = dst + maxDstSize;
    let op = dst;
    let litBufferEnd = this.litBufferEnd;
    const dstLitEnd = this.litBufferEnd;
    if (nbSeqIn) {
      const state = this.startSequences(src, start, size);
      let nbSeq = nbSeqIn;
      let sequence: Sequence = { litLength: 0, matchLength: 0, offset: 0 };
      let broke = false;
      for (; nbSeq; nbSeq -= 1) {
        sequence = this.decodeSequence(
          state.bits,
          state.ll,
          state.ml,
          state.of,
          state.prevOffset,
          nbSeq === 1,
        );
        if (this.litPtr + sequence.litLength > dstLitEnd) {
          broke = true;
          break;
        }
        op = this.execSequence(op, oend, sequence, litBufferEnd, true);
      }
      if (broke && nbSeq > 0) {
        const leftoverLit = dstLitEnd - this.litPtr;
        if (leftoverLit) {
          if (above(leftoverLit, oend - op)) {
            fail('dstSize_tooSmall');
          }
          this.copyLiterals(op, leftoverLit);
          sequence.litLength -= leftoverLit;
          op += leftoverLit;
        }
        this.switchToExtraLiterals();
        litBufferEnd = LITBUFFEREXTRASIZE;
        op = this.execSequence(op, oend, sequence, litBufferEnd, false);
        nbSeq -= 1;
      }
      for (; nbSeq > 0; nbSeq -= 1) {
        const next = this.decodeSequence(
          state.bits,
          state.ll,
          state.ml,
          state.of,
          state.prevOffset,
          nbSeq === 1,
        );
        op = this.execSequence(op, oend, next, litBufferEnd, false);
      }
      if (!state.bits.ended()) {
        fail('corruption_detected');
      }
      this.saveRep(state.prevOffset);
    }
    if (this.litLocation === SPLIT) {
      const lastLLSize = litBufferEnd - this.litPtr;
      if (above(lastLLSize, oend - op)) {
        fail('dstSize_tooSmall');
      }
      this.copyLiterals(op, lastLLSize);
      op += lastLLSize;
      this.switchToExtraLiterals();
      litBufferEnd = LITBUFFEREXTRASIZE;
    }
    const lastLLSize = litBufferEnd - this.litPtr;
    if (above(lastLLSize, oend - op)) {
      fail('dstSize_tooSmall');
    }
    this.copyLiterals(op, lastLLSize);
    op += lastLLSize;
    return op - dst;
  }

  /** ZSTD_decompressSequencesLong_body (prefetching decoder). */
  // oxlint-disable-next-line max-lines-per-function, complexity -- 1:1 port
  private sequencesLong(
    dst: number,
    maxDstSize: number,
    src: Uint8Array,
    start: number,
    size: number,
    nbSeq: number,
  ): number {
    const oend =
      this.litLocation === IN_DST ? this.litBuffer : dst + maxDstSize;
    let op = dst;
    let litBufferEnd = this.litBufferEnd;
    const dstLitEnd = this.litBufferEnd;
    const execStored = (sequence: Sequence): void => {
      if (
        this.litLocation === SPLIT &&
        this.litPtr + sequence.litLength > dstLitEnd
      ) {
        const leftoverLit = dstLitEnd - this.litPtr;
        if (leftoverLit) {
          if (above(leftoverLit, oend - op)) {
            fail('dstSize_tooSmall');
          }
          this.copyLiterals(op, leftoverLit);
          sequence.litLength -= leftoverLit;
          op += leftoverLit;
        }
        this.switchToExtraLiterals();
        litBufferEnd = LITBUFFEREXTRASIZE;
        op = this.execSequence(op, oend, sequence, litBufferEnd, false);
        return;
      }
      op = this.execSequence(
        op,
        oend,
        sequence,
        litBufferEnd,
        this.litLocation === SPLIT,
      );
    };
    if (nbSeq) {
      const stored = 8;
      const sequences: Sequence[] = [];
      const seqAdvance = Math.min(nbSeq, stored);
      const state = this.startSequences(src, start, size);
      let seqNb = 0;
      for (; seqNb < seqAdvance; seqNb += 1) {
        sequences[seqNb] = this.decodeSequence(
          state.bits,
          state.ll,
          state.ml,
          state.of,
          state.prevOffset,
          seqNb === nbSeq - 1,
        );
      }
      for (; seqNb < nbSeq; seqNb += 1) {
        const sequence = this.decodeSequence(
          state.bits,
          state.ll,
          state.ml,
          state.of,
          state.prevOffset,
          seqNb === nbSeq - 1,
        );
        execStored(sequences[(seqNb - stored) & 7] as Sequence);
        sequences[seqNb & 7] = sequence;
      }
      if (!state.bits.ended()) {
        fail('corruption_detected');
      }
      seqNb -= seqAdvance;
      for (; seqNb < nbSeq; seqNb += 1) {
        execStored(sequences[seqNb & 7] as Sequence);
      }
      this.saveRep(state.prevOffset);
    }
    if (this.litLocation === SPLIT) {
      const lastLLSize = litBufferEnd - this.litPtr;
      if (above(lastLLSize, oend - op)) {
        fail('dstSize_tooSmall');
      }
      this.copyLiterals(op, lastLLSize);
      op += lastLLSize;
      this.litKind = LIT_EXTRA;
      this.litPtr = 0;
      litBufferEnd = LITBUFFEREXTRASIZE;
    }
    const lastLLSize = litBufferEnd - this.litPtr;
    if (above(lastLLSize, oend - op)) {
      fail('dstSize_tooSmall');
    }
    this.copyLiterals(op, lastLLSize);
    op += lastLLSize;
    return op - dst;
  }
}

// ---------------------------------------------------------------------------
// Modules/_zstd/decompressor.c

/**
 * `compression.zstd.ZstdDecompressor` as zipfile drives it:
 * `decompress(data)` with no output limit, except that output stops at
 * `cap` bytes (see `capped`). Throws {@link ZstdError}.
 */
export class ZstdDecompressor {
  /** Python's `ZstdDecompressor.eof`. */
  eof = false;
  /** The last call stopped at `cap` bytes with more output pending. */
  capped = false;

  private readonly stream = new ZstdStream();

  decompress(data: Uint8Array, _maxLength: number, cap: number): Uint8Array {
    this.capped = false;
    if (this.eof) {
      throw new Error('Already at the end of a Zstandard frame.');
    }
    if (this.stream.legacy) {
      return EMPTY;
    }
    const input: Input = { data, pos: 0, size: data.length };
    const out = new Output();
    let blocks = 0;
    const startBlock = (size: number): void => {
      out.pos = 0;
      out.pyEnd = size;
      out.size = Math.min(size, cap - out.kept);
    };
    startBlock(BUFFER_BLOCK_SIZE[0] as number);
    try {
      for (;;) {
        const result = this.stream.decompressStream(input, out);
        if (this.stream.legacy) {
          break;
        }
        if (result === 0) {
          this.eof = true;
          break;
        }
        if (out.pos >= out.size) {
          if (out.size < out.pyEnd || out.kept >= cap) {
            this.capped = true;
            break;
          }
          blocks += 1;
          startBlock(
            BUFFER_BLOCK_SIZE[
              Math.min(blocks, BUFFER_BLOCK_SIZE.length - 1)
            ] as number,
          );
        } else if (input.pos === input.size) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof Fail) {
        throw new ZstdError(
          `Unable to decompress Zstandard data: ${ERROR_NAMES[error.code]}`,
        );
      }
      throw error;
    }
    if (out.truncated) {
      this.capped = true;
    }
    const result = new Uint8Array(out.kept);
    let offset = 0;
    for (const chunk of out.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
