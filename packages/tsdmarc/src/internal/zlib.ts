// Port of zlib 1.3's inflate() (inflate.c, inftrees.c) and of Python's
// `zlib.decompressobj()` wrapper around it (Modules/zlibmodule.c), for raw
// deflate (wbits -15, used by zipfile) and gzip (wbits 31, used by
// parsedmarc's `_decompress_gzip_bounded`).
//
// node:zlib is not used because its behavior differs between Node, Bun and
// Deno, and because parsedmarc's results depend on zlib details node:zlib
// does not expose: where a stream stops when the output limit is reached
// (`max_length`), how much input is left unconsumed, which error is reported
// first, and the exact error messages. The state machine below follows
// inflate.c state by state: it pulls input one byte at a time only when it
// needs more bits, and checks for output space only right before writing a
// byte, so it stops and fails at exactly the same points as zlib.

import { crc32Update } from './crc';

/** Python's `zlib.error`. */
export class ZlibError extends Error {
  override name = 'error';
}

const Z_DATA_ERROR = -3;
const NEED_INPUT = 0;
const NEED_OUTPUT = 1;
type Pause = typeof NEED_INPUT | typeof NEED_OUTPUT;

const MAX_BITS = 15;
const WINDOW_SIZE = 32_768;
const FIRST_BLOCK = 32 * 1024;
/** Table entry symbol for an unused code of an incomplete code. */
const INVALID = 0xff_ff;
const END_OF_BLOCK = 256;
/** Fixed-code symbols 286, 287 and distances 30, 31 are invalid. */
const LENGTH_SYMBOLS = 286;
const DISTANCE_SYMBOLS = 30;

const ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12_289, 16_385, 24_577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];

/**
 * A decoding table in two levels, like zlib's: `rootBits` input bits index
 * the root table, and a code longer than that continues in a subtable placed
 * after it. An entry is `(codeLength << 16) | symbol`, usable once
 * `codeLength` bits (the whole code, also in subtables) are available; a
 * negative entry points to a subtable (see {@link subtableEntry}). A flat
 * table would take 2^15 writes per code, for a block that is 30 bytes long.
 */
interface HuffmanTable {
  entries: Int32Array;
  mask: number;
  rootBits: number;
}

/** inftrees.c `codetype`: CODES, LENS or DISTS. */
export const TableKind = { Codes: 0, Dists: 2, Lens: 1 } as const;
type TableKindValue = (typeof TableKind)[keyof typeof TableKind];

/** Root table bits per kind: inflate.c's 7, 9 and 6. */
const ROOT_BITS = [7, 9, 6] as const;
/** Low bits of a decoded subtable pointer: the subtable's index bits. */
const SUBTABLE_BITS = 4;
const SUBTABLE_MASK = (1 << SUBTABLE_BITS) - 1;

/** The entry for the code under `pointer` (a negative root entry). */
function subtableEntry(
  entries: Int32Array,
  pointer: number,
  hold: number,
  rootBits: number,
): number {
  const packed = ~pointer;
  const index = (hold >>> rootBits) & ((1 << (packed & SUBTABLE_MASK)) - 1);
  return entries[(packed >>> SUBTABLE_BITS) + index] as number;
}

function reverseBits(code: number, length: number): number {
  let reversed = 0;
  for (let bit = 0; bit < length; bit += 1) {
    reversed = (reversed << 1) | ((code >>> bit) & 1);
  }
  return reversed;
}

// Scratch space of buildTable(): off-heap allocations would be most of the
// cost of a table, and a block can be 30 bytes.
const counts = new Uint16Array(MAX_BITS + 1);
const nextCode = new Uint16Array(MAX_BITS + 1);
const codes = new Uint16Array(320);
const longest = new Uint8Array(1 << 9);
const offsets = new Int32Array(1 << 9);

/**
 * inftrees.c `inflate_table()`: `null` for an over-subscribed or (where
 * zlib rejects it) incomplete code.
 */
export function buildTable(
  lengths: Uint8Array,
  start: number,
  count: number,
  kind: TableKindValue,
  /** Reused for the entries when large enough. */
  buffer?: Int32Array,
): HuffmanTable | null {
  counts.fill(0);
  for (let symbol = 0; symbol < count; symbol += 1) {
    const length = lengths[start + symbol] as number;
    counts[length] = (counts[length] as number) + 1;
  }
  let max = MAX_BITS;
  while (max >= 1 && counts[max] === 0) {
    max -= 1;
  }
  if (max === 0) {
    // No symbols: zlib builds a 1-bit table of invalid entries so the
    // error is reported when a code is decoded.
    const invalid = (1 << 16) | INVALID;
    return { entries: Int32Array.of(invalid, invalid), mask: 1, rootBits: 1 };
  }
  let left = 1;
  for (let length = 1; length <= MAX_BITS; length += 1) {
    left <<= 1;
    left -= counts[length] as number;
    if (left < 0) {
      return null;
    }
  }
  if (left > 0 && (kind === TableKind.Codes || max !== 1)) {
    return null;
  }
  // Canonical codes: consecutive values per length, shorter codes first.
  let code = 0;
  for (let length = 1; length <= MAX_BITS; length += 1) {
    nextCode[length] = code;
    code = (code + (counts[length] as number)) << 1;
  }
  const rootBits = Math.min(max, ROOT_BITS[kind]);
  const rootSize = 1 << rootBits;
  const mask = rootSize - 1;
  // Each symbol's code, as the bit-reversed index it is looked up by, and the
  // longest code under each root entry, which sets its subtable's size.
  const hasSubtables = max > rootBits;
  if (hasSubtables) {
    longest.fill(0, 0, rootSize);
  }
  for (let symbol = 0; symbol < count; symbol += 1) {
    const length = lengths[start + symbol] as number;
    if (length === 0) {
      continue;
    }
    const assigned = nextCode[length] as number;
    nextCode[length] = assigned + 1;
    const reversed = reverseBits(assigned, length);
    codes[symbol] = reversed;
    if (length > rootBits && length > (longest[reversed & mask] as number)) {
      longest[reversed & mask] = length;
    }
  }
  // Subtables follow the root table.
  let size = rootSize;
  if (hasSubtables) {
    for (let root = 0; root < rootSize; root += 1) {
      const deepest = longest[root] as number;
      if (deepest > 0) {
        offsets[root] = size;
        size += 1 << (deepest - rootBits);
      }
    }
  }
  const entries =
    buffer !== undefined && size <= buffer.length
      ? buffer
      : new Int32Array(size);
  if (left > 0) {
    // Only an incomplete 1-bit code leaves entries unfilled.
    entries.fill((1 << 16) | INVALID);
  }
  if (hasSubtables) {
    for (let root = 0; root < rootSize; root += 1) {
      const deepest = longest[root] as number;
      if (deepest > 0) {
        const offset = offsets[root] as number;
        entries[root] = ~((offset << SUBTABLE_BITS) | (deepest - rootBits));
      }
    }
  }
  for (let symbol = 0; symbol < count; symbol += 1) {
    const length = lengths[start + symbol] as number;
    if (length === 0) {
      continue;
    }
    const entry = (length << 16) | symbol;
    const reversed = codes[symbol] as number;
    if (length <= rootBits) {
      for (let index = reversed; index < rootSize; index += 1 << length) {
        entries[index] = entry;
      }
      continue;
    }
    const root = reversed & mask;
    const offset = offsets[root] as number;
    const subtableSize = 1 << ((longest[root] as number) - rootBits);
    const step = 1 << (length - rootBits);
    for (
      let index = reversed >>> rootBits;
      index < subtableSize;
      index += step
    ) {
      entries[offset + index] = entry;
    }
  }
  return { entries, mask, rootBits };
}

const FIXED_TABLES: { lengths: HuffmanTable; distances: HuffmanTable } =
  (() => {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    const distances = new Uint8Array(32).fill(5);
    return {
      distances: buildTable(distances, 0, 32, TableKind.Dists) as HuffmanTable,
      lengths: buildTable(lengths, 0, 288, TableKind.Lens) as HuffmanTable,
    };
  })();

const EMPTY = new Uint8Array(0);
/** Over zlib's ENOUGH_LENS (852) and ENOUGH_DISTS (592). */
const ENTRIES_BUFFER_SIZE = 2048;
/** inflate_fast() needs 6 input bytes and 258 bytes of output space. */
const FAST_INPUT = 6;
const FAST_OUTPUT = 258;

/**
 * Python's `zlib.decompressobj(wbits)` for wbits -15 (raw) and 31 (gzip).
 */
export class ZlibDecompressor {
  /** Python's `Decompress.eof`. */
  eof = false;

  private readonly gzip: boolean;
  private input: Uint8Array = EMPTY;
  private position = 0;
  private hold = 0;
  private bits = 0;
  /** The last 32 KiB of earlier output (the window), then this call's. */
  private buffer: Uint8Array = EMPTY;
  /** Where this call's output starts in `buffer`. */
  private start = 0;
  /** Next write position in `buffer`. */
  private out = 0;
  /** `start + max_length`: zlib stops when it needs to write here. */
  private outEnd = 0;
  /** Bytes produced by earlier calls. */
  private totalBefore = 0;
  private crcFrom = 0;
  private check = 0;
  private failure: ZlibError | null = null;
  private readonly machine: Generator<Pause, void, void>;
  // A dynamic block's tables live until the next one, so they are reused
  // (per decompressor: decoding pauses at the end of the input).
  private readonly codeLengths = new Uint8Array(19);
  private readonly symbolLengths = new Uint8Array(320);
  private readonly codeEntries = new Int32Array(
    1 << ROOT_BITS[TableKind.Codes],
  );
  private readonly lengthEntries = new Int32Array(ENTRIES_BUFFER_SIZE);
  private readonly distanceEntries = new Int32Array(ENTRIES_BUFFER_SIZE);

  constructor(wbits: -15 | 31) {
    this.gzip = wbits === 31;
    this.machine = this.run();
  }

  /** Python's `Decompress.unconsumed_tail`. */
  get unconsumedTail(): Uint8Array {
    return this.eof ? EMPTY : this.input.subarray(this.position);
  }

  /**
   * Python's `Decompress.decompress(data, max_length)`; `maxLength` 0
   * means unlimited. Throws {@link ZlibError} on corrupt data.
   */
  decompress(data: Uint8Array, maxLength = 0): Uint8Array {
    if (this.failure !== null) {
      throw this.failure;
    }
    this.input = data;
    this.position = 0;
    this.startOutput(maxLength === 0 ? Number.POSITIVE_INFINITY : maxLength);
    this.pump(true);
    return this.finishOutput();
  }

  /**
   * Python's `Decompress.flush()`: decompress the unconsumed tail without
   * an output limit. Like CPython, errors here are not raised: the output
   * produced before the error is returned.
   */
  flush(): Uint8Array {
    if (this.failure !== null) {
      return EMPTY;
    }
    this.input = this.unconsumedTail;
    this.position = 0;
    this.startOutput(Number.POSITIVE_INFINITY);
    this.pump(false);
    return this.finishOutput();
  }

  private startOutput(limit: number): void {
    const keep = Math.min(WINDOW_SIZE, this.totalBefore);
    const buffer = new Uint8Array(keep + Math.min(limit, FIRST_BLOCK));
    buffer.set(this.buffer.subarray(this.out - keep, this.out));
    this.buffer = buffer;
    this.start = keep;
    this.out = keep;
    this.outEnd = keep + limit;
    this.crcFrom = keep;
  }

  private finishOutput(): Uint8Array {
    this.updateCheck();
    this.totalBefore += this.out - this.start;
    return this.buffer.subarray(this.start, this.out);
  }

  private pump(raise: boolean): void {
    if (this.eof) {
      return;
    }
    let step: IteratorResult<Pause, void>;
    try {
      // NEED_OUTPUT is only yielded at `outEnd`: either way, stop.
      step = this.machine.next();
    } catch (error) {
      if (error instanceof ZlibError) {
        this.failure = error;
        if (!raise) {
          return;
        }
      }
      throw error;
    }
    if (step.done === true) {
      this.eof = true;
    }
  }

  /** Make room for `needed` more bytes (never past `outEnd`). */
  private grow(needed: number): void {
    const size = Math.min(
      this.outEnd,
      Math.max(this.out + needed, this.buffer.length * 2),
    );
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.out));
    this.buffer = grown;
  }

  private get total(): number {
    return this.totalBefore + this.out - this.start;
  }

  private updateCheck(): void {
    if (this.gzip && this.out > this.crcFrom) {
      this.check = crc32Update(this.check, this.buffer, this.crcFrom, this.out);
    }
    this.crcFrom = this.out;
  }

  private error(message: string): ZlibError {
    return new ZlibError(
      `Error ${Z_DATA_ERROR} while decompressing data: ${message}`,
    );
  }

  /** NEEDBITS(count) for count <= 16: false when input runs out. */
  private pull(count: number): boolean {
    while (this.bits < count) {
      if (this.position >= this.input.length) {
        return false;
      }
      this.hold |= (this.input[this.position] as number) << this.bits;
      this.position += 1;
      this.bits += 8;
    }
    return true;
  }

  private drop(count: number): void {
    this.hold >>>= count;
    this.bits -= count;
  }

  // Read a 16-bit little-endian word (two of these make NEEDBITS(32)).
  private *word(): Generator<Pause, number, void> {
    while (!this.pull(16)) {
      yield NEED_INPUT;
    }
    const value = this.hold & 0xff_ff;
    this.drop(16);
    return value;
  }

  private *bitsValue(count: number): Generator<Pause, number, void> {
    while (!this.pull(count)) {
      yield NEED_INPUT;
    }
    const value = this.hold & ((1 << count) - 1);
    this.drop(count);
    return value;
  }

  /**
   * One table lookup, pulling input bytes until the code is complete
   * (inflate.c LEN/DIST/CODELENS loops); -1 when input runs out.
   */
  private lookup(table: HuffmanTable): number {
    for (;;) {
      let entry = table.entries[this.hold & table.mask] as number;
      if (entry < 0) {
        entry = subtableEntry(table.entries, entry, this.hold, table.rootBits);
      }
      if (entry >>> 16 <= this.bits) {
        this.drop(entry >>> 16);
        return entry & 0xff_ff;
      }
      if (this.position >= this.input.length) {
        return -1;
      }
      this.hold |= (this.input[this.position] as number) << this.bits;
      this.position += 1;
      this.bits += 8;
    }
  }

  private *decode(table: HuffmanTable): Generator<Pause, number, void> {
    let symbol = this.lookup(table);
    while (symbol < 0) {
      yield NEED_INPUT;
      symbol = this.lookup(table);
    }
    return symbol;
  }

  // Wait until a byte can be written at `out`.
  private *room(): Generator<Pause, void, void> {
    while (this.out >= this.outEnd) {
      yield NEED_OUTPUT;
    }
    if (this.out >= this.buffer.length) {
      this.grow(1);
    }
  }

  private *run(): Generator<Pause, void, void> {
    if (this.gzip) {
      yield* this.gzipHeader();
    }
    let last = false;
    while (!last) {
      const header = yield* this.bitsValue(3);
      last = (header & 1) === 1;
      const type = header >>> 1;
      if (type === 0) {
        yield* this.storedBlock();
      } else if (type === 1) {
        yield* this.codes(FIXED_TABLES.lengths, FIXED_TABLES.distances);
      } else if (type === 2) {
        const tables = yield* this.dynamicTables();
        yield* this.codes(tables.lengths, tables.distances);
      } else {
        throw this.error('invalid block type');
      }
    }
    // BYTEBITS: go to a byte boundary.
    this.drop(this.bits & 7);
    if (this.gzip) {
      yield* this.gzipTrailer();
    }
  }

  private crcWord(word: number): void {
    this.check = crc32Update(
      this.check,
      Uint8Array.of(word & 0xff, word >>> 8),
    );
  }

  private *gzipHeader(): Generator<Pause, void, void> {
    const magic = yield* this.word();
    if (magic !== 0x8b_1f) {
      throw this.error('incorrect header check');
    }
    this.check = 0;
    this.crcWord(magic);
    while (!this.pull(16)) {
      yield NEED_INPUT;
    }
    const flags = this.hold & 0xff_ff;
    if ((flags & 0xff) !== 8) {
      throw this.error('unknown compression method');
    }
    if (flags & 0xe0_00) {
      throw this.error('unknown header flags set');
    }
    this.drop(16);
    const headerCrc = (flags & 0x02_00) !== 0;
    const crcWord = (word: number): void => {
      if (headerCrc) {
        this.crcWord(word);
      }
    };
    crcWord(flags);
    // TIME (32 bits) and OS (16 bits).
    for (let index = 0; index < 3; index += 1) {
      crcWord(yield* this.word());
    }
    if (flags & 0x04_00) {
      const extraLength = yield* this.word();
      crcWord(extraLength);
      yield* this.skipInput(extraLength, headerCrc);
    }
    for (const flag of [0x08_00, 0x10_00]) {
      if (flags & flag) {
        yield* this.skipString(headerCrc);
      }
    }
    if (headerCrc) {
      while (!this.pull(16)) {
        yield NEED_INPUT;
      }
      if ((this.hold & 0xff_ff) !== (this.check & 0xff_ff)) {
        throw this.error('header crc mismatch');
      }
      this.drop(16);
    }
    this.check = 0;
  }

  // EXTRA: skip header bytes straight from the input.
  private *skipInput(
    length: number,
    headerCrc: boolean,
  ): Generator<Pause, void, void> {
    let left = length;
    while (left > 0) {
      if (this.position >= this.input.length) {
        yield NEED_INPUT;
        continue;
      }
      const end = Math.min(this.position + left, this.input.length);
      if (headerCrc) {
        this.check = crc32Update(this.check, this.input, this.position, end);
      }
      left -= end - this.position;
      this.position = end;
    }
  }

  // NAME / COMMENT: skip a zero-terminated header string.
  private *skipString(headerCrc: boolean): Generator<Pause, void, void> {
    for (;;) {
      if (this.position >= this.input.length) {
        yield NEED_INPUT;
        continue;
      }
      const byte = this.input[this.position] as number;
      if (headerCrc) {
        this.check = crc32Update(
          this.check,
          this.input,
          this.position,
          this.position + 1,
        );
      }
      this.position += 1;
      if (byte === 0) {
        return;
      }
    }
  }

  private *gzipTrailer(): Generator<Pause, void, void> {
    const crcLow = yield* this.word();
    const crcHigh = yield* this.word();
    this.updateCheck();
    if (((crcHigh << 16) | crcLow) >>> 0 !== this.check) {
      throw this.error('incorrect data check');
    }
    const sizeLow = yield* this.word();
    const sizeHigh = yield* this.word();
    if (((sizeHigh << 16) | sizeLow) >>> 0 !== this.total % 2 ** 32) {
      throw this.error('incorrect length check');
    }
  }

  private *storedBlock(): Generator<Pause, void, void> {
    this.drop(this.bits & 7);
    const length = yield* this.word();
    const complement = yield* this.word();
    if (length !== (complement ^ 0xff_ff)) {
      throw this.error('invalid stored block lengths');
    }
    let left = length;
    while (left > 0) {
      if (this.position >= this.input.length) {
        yield NEED_INPUT;
        continue;
      }
      yield* this.room();
      const copy = Math.min(
        left,
        this.input.length - this.position,
        this.buffer.length - this.out,
      );
      this.buffer.set(
        this.input.subarray(this.position, this.position + copy),
        this.out,
      );
      this.out += copy;
      this.position += copy;
      left -= copy;
    }
  }

  private *dynamicTables(): Generator<
    Pause,
    { lengths: HuffmanTable; distances: HuffmanTable },
    void
  > {
    while (!this.pull(14)) {
      yield NEED_INPUT;
    }
    const lengthCount = (this.hold & 31) + 257;
    const distanceCount = ((this.hold >>> 5) & 31) + 1;
    const codeCount = ((this.hold >>> 10) & 15) + 4;
    this.drop(14);
    if (lengthCount > 286 || distanceCount > 30) {
      throw this.error('too many length or distance symbols');
    }
    const { codeLengths, symbolLengths: lengths } = this;
    codeLengths.fill(0);
    for (let index = 0; index < codeCount; index += 1) {
      codeLengths[ORDER[index] as number] = yield* this.bitsValue(3);
    }
    const codeTable = buildTable(
      codeLengths,
      0,
      19,
      TableKind.Codes,
      this.codeEntries,
    );
    if (codeTable === null) {
      throw this.error('invalid code lengths set');
    }
    const total = lengthCount + distanceCount;
    let have = 0;
    while (have < total) {
      let symbol = yield* this.decode(codeTable);
      if (symbol === INVALID) {
        // zlib's invalid entry in an empty code-length code has value 0.
        symbol = 0;
      }
      if (symbol < 16) {
        lengths[have] = symbol;
        have += 1;
        continue;
      }
      let repeat: number;
      let value = 0;
      if (symbol === 16) {
        while (!this.pull(2)) {
          yield NEED_INPUT;
        }
        if (have === 0) {
          throw this.error('invalid bit length repeat');
        }
        value = lengths[have - 1] as number;
        repeat = 3 + (yield* this.bitsValue(2));
      } else if (symbol === 17) {
        repeat = 3 + (yield* this.bitsValue(3));
      } else {
        repeat = 11 + (yield* this.bitsValue(7));
      }
      if (have + repeat > total) {
        throw this.error('invalid bit length repeat');
      }
      lengths.fill(value, have, have + repeat);
      have += repeat;
    }
    if (lengths[END_OF_BLOCK] === 0) {
      throw this.error('invalid code -- missing end-of-block');
    }
    const lengthTable = buildTable(
      lengths,
      0,
      lengthCount,
      TableKind.Lens,
      this.lengthEntries,
    );
    if (lengthTable === null) {
      throw this.error('invalid literal/lengths set');
    }
    const distanceTable = buildTable(
      lengths,
      lengthCount,
      distanceCount,
      TableKind.Dists,
      this.distanceEntries,
    );
    if (distanceTable === null) {
      throw this.error('invalid distances set');
    }
    return { distances: distanceTable, lengths: lengthTable };
  }

  private *codes(
    lengthTable: HuffmanTable,
    distanceTable: HuffmanTable,
  ): Generator<Pause, void, void> {
    for (;;) {
      if (
        this.input.length - this.position >= FAST_INPUT &&
        this.out + FAST_OUTPUT <= this.outEnd
      ) {
        if (this.out + FAST_OUTPUT > this.buffer.length) {
          this.grow(FAST_OUTPUT);
        }
        if (this.fastCodes(lengthTable, distanceTable)) {
          return;
        }
        continue;
      }
      // inflate.c's slow path, one symbol at a time.
      const symbol = yield* this.decode(lengthTable);
      if (symbol < END_OF_BLOCK) {
        yield* this.room();
        this.buffer[this.out] = symbol;
        this.out += 1;
        continue;
      }
      if (symbol === END_OF_BLOCK) {
        return;
      }
      if (symbol >= LENGTH_SYMBOLS) {
        throw this.error('invalid literal/length code');
      }
      const lengthIndex = symbol - 257;
      const length =
        (LENGTH_BASE[lengthIndex] as number) +
        (yield* this.bitsValue(LENGTH_EXTRA[lengthIndex] as number));
      const distanceSymbol = yield* this.decode(distanceTable);
      if (distanceSymbol >= DISTANCE_SYMBOLS) {
        throw this.error('invalid distance code');
      }
      const distance =
        (DIST_BASE[distanceSymbol] as number) +
        (yield* this.bitsValue(DIST_EXTRA[distanceSymbol] as number));
      for (let left = length; left > 0; left -= 1) {
        yield* this.room();
        if (distance > this.total) {
          throw this.error('invalid distance too far back');
        }
        this.buffer[this.out] = this.buffer[this.out - distance] as number;
        this.out += 1;
      }
    }
  }

  /**
   * inffast.c `inflate_fast()`: decode while at least 6 input bytes (one
   * length/distance pair needs at most 48 bits) and 258 bytes of output
   * space are available. Returns true at the end of the block.
   */
  // oxlint-disable-next-line complexity -- mirrors inflate_fast
  private fastCodes(
    lengthTable: HuffmanTable,
    distanceTable: HuffmanTable,
  ): boolean {
    const input = this.input;
    const buffer = this.buffer;
    const lengthEntries = lengthTable.entries;
    const lengthMask = lengthTable.mask;
    const distanceEntries = distanceTable.entries;
    const distanceMask = distanceTable.mask;
    const lengthRootBits = lengthTable.rootBits;
    const distanceRootBits = distanceTable.rootBits;
    const lastInput = input.length - (FAST_INPUT - 1);
    const lastOutput = Math.min(this.outEnd, buffer.length) - FAST_OUTPUT;
    const totalBase = this.totalBefore - this.start;
    let position = this.position;
    let hold = this.hold;
    let bits = this.bits;
    let out = this.out;
    let endOfBlock = false;
    let failure: string | null = null;
    while (position < lastInput && out <= lastOutput) {
      if (bits < 15) {
        hold |= (input[position] as number) << bits;
        hold |= (input[position + 1] as number) << (bits + 8);
        position += 2;
        bits += 16;
      }
      let entry = lengthEntries[hold & lengthMask] as number;
      if (entry < 0) {
        entry = subtableEntry(lengthEntries, entry, hold, lengthRootBits);
      }
      let size = entry >>> 16;
      hold >>>= size;
      bits -= size;
      const symbol = entry & 0xff_ff;
      if (symbol < END_OF_BLOCK) {
        buffer[out] = symbol;
        out += 1;
        continue;
      }
      if (symbol === END_OF_BLOCK) {
        endOfBlock = true;
        break;
      }
      if (symbol >= LENGTH_SYMBOLS) {
        failure = 'invalid literal/length code';
        break;
      }
      let length = LENGTH_BASE[symbol - 257] as number;
      let extra = LENGTH_EXTRA[symbol - 257] as number;
      if (extra > 0) {
        if (bits < extra) {
          hold |= (input[position] as number) << bits;
          position += 1;
          bits += 8;
        }
        length += hold & ((1 << extra) - 1);
        hold >>>= extra;
        bits -= extra;
      }
      if (bits < 15) {
        hold |= (input[position] as number) << bits;
        hold |= (input[position + 1] as number) << (bits + 8);
        position += 2;
        bits += 16;
      }
      entry = distanceEntries[hold & distanceMask] as number;
      if (entry < 0) {
        entry = subtableEntry(distanceEntries, entry, hold, distanceRootBits);
      }
      size = entry >>> 16;
      hold >>>= size;
      bits -= size;
      const distanceSymbol = entry & 0xff_ff;
      if (distanceSymbol >= DISTANCE_SYMBOLS) {
        failure = 'invalid distance code';
        break;
      }
      let distance = DIST_BASE[distanceSymbol] as number;
      extra = DIST_EXTRA[distanceSymbol] as number;
      if (extra > 0) {
        while (bits < extra) {
          hold |= (input[position] as number) << bits;
          position += 1;
          bits += 8;
        }
        distance += hold & ((1 << extra) - 1);
        hold >>>= extra;
        bits -= extra;
      }
      if (distance > totalBase + out) {
        failure = 'invalid distance too far back';
        break;
      }
      for (let index = 0; index < length; index += 1) {
        buffer[out] = buffer[out - distance] as number;
        out += 1;
      }
    }
    // Return whole unused bytes to the input, like inflate_fast.
    const unused = bits >>> 3;
    position -= unused;
    bits -= unused << 3;
    this.position = position;
    this.hold = hold & ((1 << bits) - 1);
    this.bits = bits;
    this.out = out;
    if (failure !== null) {
      throw this.error(failure);
    }
    return endOfBlock;
  }
}
