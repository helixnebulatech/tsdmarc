import { gzipSync, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { cpuMsSince, cpuStart } from '../test/cpu-time';
import { buildTable, TableKind, ZlibDecompressor, ZlibError } from './zlib';

// Expected values come from CPython 3.14's zlib (zlib 1.3).
const fromBase64 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'base64'));
const HELLO = new TextEncoder().encode('hello world '.repeat(100));
/** `HELLO` as raw deflate (`compressobj(9, DEFLATED, -15)`). */
const HELLO_RAW = fromBase64('y0jNyclXKM8vyklRyBhlj7JH2aPsQcwGAA==');

describe('ZlibDecompressor (zlib.decompressobj)', () => {
  it('stops at max_length and keeps the unconsumed tail', () => {
    const decompressor = new ZlibDecompressor(-15);
    const first = decompressor.decompress(HELLO_RAW, 100);
    expect([first.length, decompressor.unconsumedTail.length]).toEqual([
      100, 9,
    ]);
    expect(decompressor.eof).toBe(false);
    const second = decompressor.decompress(decompressor.unconsumedTail, 1000);
    expect([second.length, decompressor.unconsumedTail.length]).toEqual([
      1000, 1,
    ]);
    const third = decompressor.decompress(decompressor.unconsumedTail);
    expect([third.length, decompressor.unconsumedTail.length]).toEqual([
      100, 0,
    ]);
    expect(decompressor.eof).toBe(true);
    expect(Buffer.concat([first, second, third])).toEqual(Buffer.from(HELLO));
  });

  it('returns what it can from a truncated stream, without an error', () => {
    const decompressor = new ZlibDecompressor(-15);
    expect(decompressor.decompress(HELLO_RAW.subarray(0, 10)).length).toBe(9);
    expect(decompressor.eof).toBe(false);
    expect(decompressor.flush().length).toBe(0);
  });

  it('reports corrupt data with zlib messages', () => {
    const decompressor = new ZlibDecompressor(-15);
    expect(() => decompressor.decompress(Uint8Array.of(0x07))).toThrow(
      new ZlibError('Error -3 while decompressing data: invalid block type'),
    );
  });

  it('flush() returns the output before an error instead of raising', () => {
    // A 5-byte stored block, then an invalid block type.
    const raw = fromBase64('AAUA+v9hYmNkZQc=');
    const decompressor = new ZlibDecompressor(-15);
    expect(new TextDecoder().decode(decompressor.decompress(raw, 3))).toBe(
      'abc',
    );
    expect(decompressor.unconsumedTail.length).toBe(3);
    expect(new TextDecoder().decode(decompressor.flush())).toBe('de');
    expect(decompressor.eof).toBe(false);
    expect(() => decompressor.decompress(new Uint8Array(0))).toThrow(
      'invalid block type',
    );
  });

  it('decodes gzip and checks its trailer (wbits 31)', () => {
    const gzip = gzipSync(HELLO);
    expect(new ZlibDecompressor(31).decompress(gzip)).toEqual(
      new Uint8Array(HELLO),
    );
    const corrupt = Buffer.from(gzip);
    const last = corrupt.length - 1;
    corrupt.writeUInt8(corrupt.readUInt8(last) ^ 1, last);
    expect(() => new ZlibDecompressor(31).decompress(corrupt)).toThrow(
      'Error -3 while decompressing data: incorrect length check',
    );
  });

  it('keeps a 32 KiB window across calls', () => {
    const data = new Uint8Array(200_000);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = (index * 7919) % 251;
    }
    const gzip = gzipSync(data);
    const decompressor = new ZlibDecompressor(31);
    const chunks: Uint8Array[] = [];
    let input: Uint8Array = gzip;
    while (!decompressor.eof) {
      chunks.push(decompressor.decompress(input, 4096));
      input = decompressor.unconsumedTail;
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(data));
  });
});

// Raw deflate writer for dynamic blocks with chosen code lengths, which no
// real compressor produces.
class BitWriter {
  readonly bytes: number[] = [];
  private hold = 0;
  private count = 0;

  bits(value: number, count: number): void {
    for (let bit = 0; bit < count; bit += 1) {
      this.hold |= ((value >>> bit) & 1) << this.count;
      this.count += 1;
      if (this.count === 8) {
        this.bytes.push(this.hold);
        this.hold = 0;
        this.count = 0;
      }
    }
  }

  /** A Huffman code: most significant bit first. */
  code(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.bits((value >>> bit) & 1, 1);
    }
  }

  finish(): Uint8Array {
    if (this.count > 0) {
      this.bytes.push(this.hold);
    }
    return Uint8Array.from(this.bytes);
  }
}

function canonicalCodes(lengths: number[]): number[] {
  const next = new Array<number>(17).fill(0);
  for (let code = 0, length = 1; length <= 15; length += 1) {
    code =
      (code + lengths.filter(item => item === length - 1 && item > 0).length) <<
      1;
    next[length] = code;
  }
  return lengths.map(length => {
    const code = next[length] as number;
    next[length] = code + 1;
    return code;
  });
}

const LITERAL_SYMBOLS = 286;
const DISTANCE_CODES = 30;
const LENGTH_EXTRA_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DISTANCE_EXTRA_BITS = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];

/** Lengths of a complete code over `symbols`, deep when `random` says so. */
function completeLengths(
  symbols: number[],
  size: number,
  random: () => number,
): number[] {
  // Split leaves of a binary tree until there is one per symbol.
  const leaves = [1, 1];
  while (leaves.length < symbols.length) {
    const candidates = leaves.flatMap((depth, index) =>
      depth < 15 ? [index] : [],
    );
    const pick =
      random() < 0.7
        ? (candidates.at(-1) as number)
        : Math.floor(random() * candidates.length);
    const index = candidates[pick] ?? pick;
    const depth = (leaves[index] as number) + 1;
    leaves[index] = depth;
    leaves.push(depth);
  }
  const lengths = new Array<number>(size).fill(0);
  for (const [index, symbol] of symbols.entries()) {
    lengths[symbol] = leaves[index] as number;
  }
  return lengths;
}

function writeBlockHeader(
  writer: BitWriter,
  final: boolean,
  literals: number[],
  distances: number[],
): void {
  writer.bits(final ? 1 : 0, 1);
  writer.bits(2, 2);
  writer.bits(LITERAL_SYMBOLS - 257, 5);
  writer.bits(DISTANCE_CODES - 1, 5);
  writer.bits(19 - 4, 4);
  // Lengths 0-15 get a 4-bit code each; 16, 17 and 18 are unused.
  for (const symbol of [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
  ]) {
    writer.bits(symbol < 16 ? 4 : 0, 3);
  }
  for (const length of [...literals, ...distances]) {
    writer.code(length, 4);
  }
}

/** One deflate block of literals and matches, with a seeded random code. */
function randomStream(seed: number): Uint8Array {
  let state = seed + 1;
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const writer = new BitWriter();
  for (let block = 0; block < 3; block += 1) {
    const literalSymbols = [256, 65, 66, 257, 260, 270, 280, 285];
    for (let index = 0; index < 8 + random() * 200; index += 1) {
      const symbol = Math.floor(random() * LITERAL_SYMBOLS);
      if (!literalSymbols.includes(symbol)) {
        literalSymbols.push(symbol);
      }
    }
    const distanceSymbols = [0, 1, 2, 3];
    for (let index = 0; index < random() * 26; index += 1) {
      const symbol = 4 + Math.floor(random() * 6);
      if (!distanceSymbols.includes(symbol)) {
        distanceSymbols.push(symbol);
      }
    }
    const literals = completeLengths(literalSymbols, LITERAL_SYMBOLS, random);
    const distances = completeLengths(distanceSymbols, DISTANCE_CODES, random);
    const literalCodes = canonicalCodes(literals);
    const distanceCodes = canonicalCodes(distances);
    writeBlockHeader(writer, block === 2, literals, distances);
    const writeSymbol = (symbol: number): void =>
      writer.code(literalCodes[symbol] as number, literals[symbol] as number);
    for (let index = 0; index < 64; index += 1) {
      writeSymbol(65);
    }
    for (let index = 0; index < 2000; index += 1) {
      const symbol = literalSymbols[
        Math.floor(random() * literalSymbols.length)
      ] as number;
      if (symbol === 256) {
        continue;
      }
      writeSymbol(symbol);
      if (symbol < 256) {
        continue;
      }
      const extra = LENGTH_EXTRA_BITS[symbol - 257] as number;
      writer.bits(Math.floor(random() * 2 ** extra), extra);
      const distance = distanceSymbols[
        Math.floor(random() * distanceSymbols.length)
      ] as number;
      writer.code(
        distanceCodes[distance] as number,
        distances[distance] as number,
      );
      const distanceExtra = DISTANCE_EXTRA_BITS[distance] as number;
      writer.bits(0, distanceExtra);
    }
    writeSymbol(256);
  }
  return writer.finish();
}

/** The output or zlib's message, read in `step`-byte output calls. */
function ours(data: Uint8Array, step: number): string {
  try {
    const decompressor = new ZlibDecompressor(-15);
    const chunks: Uint8Array[] = [];
    let input = data;
    while (!decompressor.eof) {
      const chunk = decompressor.decompress(input, step);
      chunks.push(chunk.slice());
      input = decompressor.unconsumedTail;
      if (chunk.length === 0 && input.length === 0) {
        break;
      }
    }
    return Buffer.concat(chunks).toString('latin1');
  } catch (error) {
    return (error as Error).message.replace(
      'Error -3 while decompressing data: ',
      '',
    );
  }
}

function theirs(data: Uint8Array): string {
  try {
    return inflateRawSync(data, { finishFlush: 2 }).toString('latin1');
  } catch (error) {
    return (error as Error).message;
  }
}

describe('two-level Huffman tables', () => {
  const chain = (size: number): Uint8Array => {
    // A complete code of depth 15 over 16 symbols: 1, 2, ..., 15, 15.
    const lengths = new Uint8Array(size);
    for (let length = 1; length <= 15; length += 1) {
      lengths[length - 1] = length;
    }
    lengths[15] = 15;
    return lengths;
  };

  it('keeps tables small for codes of depth 15', () => {
    // A flat table has 32768 entries, written for a block of 28 bytes.
    const lens = buildTable(chain(286), 0, 286, TableKind.Lens);
    const dists = buildTable(chain(30), 0, 30, TableKind.Dists);
    expect(lens?.entries.length).toBeLessThanOrEqual(512 + 64);
    expect(dists?.entries.length).toBeLessThanOrEqual(64 + 512);
  });

  it('decodes codes of any depth like zlib, valid or corrupt', () => {
    const mismatches: number[] = [];
    let corruptSeen = 0;
    for (let seed = 0; seed < 150; seed += 1) {
      const stream = randomStream(seed);
      const expected = theirs(stream);
      if (expected.length < 1000) {
        corruptSeen += 1;
      }
      if (ours(stream, 0) !== expected || ours(stream, 777) !== expected) {
        mismatches.push(seed);
      }
      const flipped = stream.slice();
      const position = 30 + ((seed * 7919) % (flipped.length - 30));
      flipped[position] = (flipped[position] as number) ^ (1 << (seed % 8));
      if (ours(flipped, 0) !== theirs(flipped)) {
        mismatches.push(-seed - 1);
      }
    }
    expect(mismatches).toEqual([]);
    expect(corruptSeen).toBeLessThan(150);
  });

  it('decompresses many empty blocks of depth 15 in linear time', () => {
    const writer = new BitWriter();
    const literals = new Array<number>(LITERAL_SYMBOLS).fill(0);
    const distances = new Array<number>(DISTANCE_CODES).fill(0);
    literals[256] = 1;
    for (let length = 2; length <= 15; length += 1) {
      literals[length - 2] = length;
      distances[length - 2] = length;
    }
    literals[14] = 15;
    distances[14] = 15;
    distances[15] = 1;
    const blocks = 10_000;
    for (let block = 0; block < blocks; block += 1) {
      writeBlockHeader(writer, block === blocks - 1, literals, distances);
      writer.code(0, 1);
    }
    const stream = writer.finish();
    expect(stream.length).toBeLessThan(2_000_000);
    const start = cpuStart();
    expect(new ZlibDecompressor(-15).decompress(stream).length).toBe(0);
    // Flat tables took over 7 ms per block here.
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });
});
