// Port of the raw LZMA1 decoder of liblzma 5.8 (lzma_decoder.c,
// range_decoder.h, lz_decoder.h) and of the wrappers zipfile puts around it
// for ZIP_LZMA members: zipfile's `LZMADecompressor` (a 4-byte header and
// the LZMA properties, then `lzma.LZMADecompressor(FORMAT_RAW, ...)`) and
// CPython's decompress loop (Modules/_lzmamodule.c).
//
// The checks are liblzma's: the first range coder byte must be 0, match
// distances must point inside the data decoded so far (and the
// dictionary), the stream must end with an end-of-payload marker after
// which the range coder is "finished". A truncated stream is not an error.

/** Python's `lzma.LZMAError`. */
export class LzmaError extends Error {
  override name = 'LZMAError';
}

const RC_TOP_VALUE = 1 << 24;
const RC_BIT_MODEL_TOTAL_BITS = 11;
const RC_BIT_MODEL_TOTAL = 1 << RC_BIT_MODEL_TOTAL_BITS;
const RC_MOVE_BITS = 5;
const PROB_INIT = RC_BIT_MODEL_TOTAL >>> 1;

const STATES = 12;
const LIT_STATES = 7;
const POS_STATES_MAX = 1 << 4;
const MATCH_LEN_MIN = 2;
const LEN_LOW_BITS = 3;
const LEN_MID_BITS = 3;
const LEN_HIGH_BITS = 8;
const LEN_LOW_SYMBOLS = 1 << LEN_LOW_BITS;
const LEN_MID_SYMBOLS = 1 << LEN_MID_BITS;
const DIST_STATES = 4;
const DIST_SLOT_BITS = 6;
const DIST_SLOTS = 1 << DIST_SLOT_BITS;
const DIST_MODEL_START = 4;
const DIST_MODEL_END = 14;
const FULL_DISTANCES = 1 << (DIST_MODEL_END / 2);
const ALIGN_BITS = 4;
const ALIGN_SIZE = 1 << ALIGN_BITS;
const LZMA_LCLP_MAX = 4;
const UINT32_MAX = 0xff_ff_ff_ff;
/** liblzma's smallest dictionary. */
const DICT_SIZE_MIN = 4096;

interface LengthDecoder {
  choice: Uint16Array;
  low: Uint16Array[];
  mid: Uint16Array[];
  high: Uint16Array;
}

function probabilities(count: number): Uint16Array {
  return new Uint16Array(count).fill(PROB_INIT);
}

function lengthDecoder(): LengthDecoder {
  const low: Uint16Array[] = [];
  const mid: Uint16Array[] = [];
  for (let index = 0; index < POS_STATES_MAX; index += 1) {
    low.push(probabilities(LEN_LOW_SYMBOLS));
    mid.push(probabilities(LEN_MID_SYMBOLS));
  }
  return {
    choice: probabilities(2),
    high: probabilities(1 << LEN_HIGH_BITS),
    low,
    mid,
  };
}

/** LZMA1 properties (`lzma._decode_filter_properties(FILTER_LZMA1, ...)`). */
interface LzmaProperties {
  lc: number;
  lp: number;
  pb: number;
  dictSize: number;
}

/** liblzma `lzma_lzma_props_decode`; null for LZMA_OPTIONS_ERROR. */
function decodeProperties(props: Uint8Array): LzmaProperties | null {
  if (props.length !== 5) {
    return null;
  }
  let byte = props[0] as number;
  if (byte > (4 * 5 + 4) * 9 + 8) {
    return null;
  }
  const pb = Math.floor(byte / (9 * 5));
  byte -= pb * 9 * 5;
  const lp = Math.floor(byte / 9);
  const lc = byte - lp * 9;
  if (lc + lp > LZMA_LCLP_MAX) {
    return null;
  }
  const dictSize =
    ((props[1] as number) |
      ((props[2] as number) << 8) |
      ((props[3] as number) << 16) |
      ((props[4] as number) << 24)) >>>
    0;
  return { dictSize, lc, lp, pb };
}

/** Thrown inside a symbol when the input runs out (the symbol is retried). */
const NEED_INPUT = Symbol('need input');
/** Thrown when the next byte would pass the output cap. */
const NEED_OUTPUT = Symbol('need output');
/** More than any symbol needs (liblzma: LZMA_IN_REQUIRED = 21). */
const IN_REQUIRED = 64;

/**
 * `lzma.LZMADecompressor(FORMAT_RAW, filters=[LZMA1])`, without an output
 * limit except `cap` (see `capped`).
 *
 * liblzma decodes a symbol in a resumable way when the input runs out in
 * the middle of it. Here a symbol is instead decoded again from the start
 * once more input arrives: near the end of the input (where a symbol could
 * run out of bytes) the probability updates are logged so they can be
 * rolled back. The result is the same since decoding is deterministic.
 */
class RawLzma1Decoder {
  eof = false;
  capped = false;

  private input: Uint8Array = new Uint8Array(0);
  private position = 0;
  private initBytes = 0;
  private range = UINT32_MAX;
  private code = 0;
  /** Everything decoded so far: the dictionary and the output. */
  private history: Uint8Array = new Uint8Array(0);
  private total = 0;
  private outputLimit = 0;
  private readonly dictSize: number;
  private readonly posMask: number;
  private readonly literalMask: number;
  private readonly lc: number;
  private readonly literal: Uint16Array;
  private readonly isMatch = probabilities(STATES * POS_STATES_MAX);
  private readonly isRep = probabilities(STATES);
  private readonly isRep0 = probabilities(STATES);
  private readonly isRep1 = probabilities(STATES);
  private readonly isRep2 = probabilities(STATES);
  private readonly isRep0Long = probabilities(STATES * POS_STATES_MAX);
  private readonly distSlot: Uint16Array[] = [];
  private readonly posSpecial = probabilities(FULL_DISTANCES - DIST_MODEL_END);
  private readonly posAlign = probabilities(ALIGN_SIZE);
  private readonly matchLength = lengthDecoder();
  private readonly repLength = lengthDecoder();
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  /** Probability updates of the current symbol, when they may be undone. */
  private undo: { probs: Uint16Array; index: number; value: number }[] | null =
    null;

  constructor(properties: LzmaProperties) {
    // lz_decoder.c: at least 4 KiB, rounded up to a multiple of 16.
    const size = Math.max(properties.dictSize, DICT_SIZE_MIN);
    this.dictSize = Math.ceil(size / 16) * 16;
    this.posMask = (1 << properties.pb) - 1;
    this.lc = properties.lc;
    this.literalMask =
      ((0x1_00 << properties.lp) - (0x1_00 >>> properties.lc)) >>> 0;
    this.literal = probabilities(0x3_00 << (properties.lc + properties.lp));
    for (let index = 0; index < DIST_STATES; index += 1) {
      this.distSlot.push(probabilities(DIST_SLOTS));
    }
  }

  decompress(data: Uint8Array, cap: number): Uint8Array {
    // Bytes of a symbol that ran out of input are decoded again with the
    // new data (CPython keeps liblzma's unconsumed input the same way).
    const rest = this.input.subarray(this.position);
    if (rest.length === 0) {
      this.input = data;
    } else {
      this.input = new Uint8Array(rest.length + data.length);
      this.input.set(rest);
      this.input.set(data, rest.length);
    }
    this.position = 0;
    this.capped = false;
    const start = this.total;
    this.outputLimit = start + cap;
    try {
      this.readInit();
      while (this.initBytes === 5 && !this.eof) {
        this.eof = this.decodeSymbol();
      }
    } catch (error) {
      if (error === NEED_OUTPUT) {
        this.capped = true;
      } else if (error === NEED_INPUT) {
        // CPython stops calling lzma_code() once the input is used up.
      } else if (error instanceof CorruptData) {
        throw new LzmaError('Corrupt input data');
      } else {
        throw error;
      }
    }
    // Bytes before `total` are never written again: a view is enough.
    return this.history.subarray(start, this.total);
  }

  /** rc_read_init: five bytes, the first of which must be 0. */
  private readInit(): void {
    while (this.initBytes < 5) {
      if (this.position >= this.input.length) {
        throw NEED_INPUT;
      }
      const byte = this.input[this.position] as number;
      if (this.initBytes === 0 && byte !== 0) {
        throw new CorruptData();
      }
      this.code = ((this.code << 8) | byte) >>> 0;
      this.position += 1;
      this.initBytes += 1;
    }
  }

  /** One LZMA symbol, retried from its start if the input runs out. */
  private decodeSymbol(): boolean {
    if (this.input.length - this.position >= IN_REQUIRED) {
      this.undo = null;
      return this.symbol();
    }
    const saved = {
      code: this.code,
      position: this.position,
      range: this.range,
      rep0: this.rep0,
      rep1: this.rep1,
      rep2: this.rep2,
      rep3: this.rep3,
      state: this.state,
    };
    const undo: { probs: Uint16Array; index: number; value: number }[] = [];
    this.undo = undo;
    try {
      return this.symbol();
    } catch (error) {
      if (error === NEED_INPUT) {
        for (let index = undo.length - 1; index >= 0; index -= 1) {
          const entry = undo[index] as (typeof undo)[number];
          entry.probs[entry.index] = entry.value;
        }
        Object.assign(this, saved);
      }
      throw error;
    } finally {
      this.undo = null;
    }
  }

  /** rc_normalize: pull a byte when the range gets small. */
  private normalize(): void {
    if (this.range < RC_TOP_VALUE) {
      if (this.position >= this.input.length) {
        throw NEED_INPUT;
      }
      this.range = (this.range << 8) >>> 0;
      this.code =
        ((this.code << 8) | (this.input[this.position] as number)) >>> 0;
      this.position += 1;
    }
  }

  /** rc_bit: decode one bit with `probs[index]`. */
  private bit(probs: Uint16Array, index: number): number {
    this.normalize();
    const prob = probs[index] as number;
    this.undo?.push({ index, probs, value: prob });
    const bound = (this.range >>> RC_BIT_MODEL_TOTAL_BITS) * prob;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = prob + ((RC_BIT_MODEL_TOTAL - prob) >>> RC_MOVE_BITS);
      return 0;
    }
    this.range = (this.range - bound) >>> 0;
    this.code = (this.code - bound) >>> 0;
    probs[index] = prob - (prob >>> RC_MOVE_BITS);
    return 1;
  }

  /** Bit tree of `limit` leaves; returns symbol - limit. */
  private bitTree(probs: Uint16Array, limit: number): number {
    let symbol = 1;
    while (symbol < limit) {
      symbol = (symbol << 1) | this.bit(probs, symbol);
    }
    return symbol - limit;
  }

  private length(decoder: LengthDecoder, posState: number): number {
    if (this.bit(decoder.choice, 0) === 0) {
      return (
        MATCH_LEN_MIN +
        this.bitTree(decoder.low[posState] as Uint16Array, LEN_LOW_SYMBOLS)
      );
    }
    if (this.bit(decoder.choice, 1) === 0) {
      return (
        MATCH_LEN_MIN +
        LEN_LOW_SYMBOLS +
        this.bitTree(decoder.mid[posState] as Uint16Array, LEN_MID_SYMBOLS)
      );
    }
    return (
      MATCH_LEN_MIN +
      LEN_LOW_SYMBOLS +
      LEN_MID_SYMBOLS +
      this.bitTree(decoder.high, 1 << LEN_HIGH_BITS)
    );
  }

  /** dict_is_distance_valid: `dict.full > distance`. */
  private distanceValid(distance: number): boolean {
    return Math.min(this.total, this.dictSize) > distance;
  }

  private byteAt(distance: number): number {
    return this.history[this.total - distance - 1] as number;
  }

  private put(byte: number): void {
    if (this.total >= this.outputLimit) {
      throw NEED_OUTPUT;
    }
    if (this.total >= this.history.length) {
      const grown = new Uint8Array(
        Math.max(64 * 1024, this.history.length * 2),
      );
      grown.set(this.history);
      this.history = grown;
    }
    this.history[this.total] = byte;
    this.total += 1;
  }

  /** A literal; `state` was already updated. */
  private decodeLiteral(matched: boolean): number {
    const previous = this.total > 0 ? this.byteAt(0) : 0;
    const base =
      3 * ((((this.total << 8) + previous) & this.literalMask) << this.lc);
    let symbol = 1;
    if (!matched) {
      while (symbol < 0x1_00) {
        symbol = (symbol << 1) | this.bit(this.literal, base + symbol);
      }
      return symbol & 0xff;
    }
    let matchByte = this.byteAt(this.rep0) << 1;
    let offset = 0x1_00;
    while (symbol < 0x1_00) {
      const matchBit = matchByte & offset;
      const bit = this.bit(this.literal, base + offset + matchBit + symbol);
      symbol = (symbol << 1) | bit;
      offset &= bit === 0 ? ~matchBit : matchBit;
      matchByte <<= 1;
    }
    return symbol & 0xff;
  }

  /** A simple match's distance; UINT32_MAX is the end marker. */
  private decodeDistance(length: number): number {
    const lengthState =
      length < DIST_STATES + MATCH_LEN_MIN
        ? length - MATCH_LEN_MIN
        : DIST_STATES - 1;
    const slot = this.bitTree(
      this.distSlot[lengthState] as Uint16Array,
      DIST_SLOTS,
    );
    if (slot < DIST_MODEL_START) {
      return slot;
    }
    let limit = (slot >>> 1) - 1;
    let distance = 2 + (slot & 1);
    if (slot < DIST_MODEL_END) {
      distance = (distance << limit) >>> 0;
      // probs = pos_special + rep0 - slot - 1, indexed from 1.
      const base = distance - slot - 1;
      let symbol = 1;
      for (let bitIndex = 0; bitIndex < limit; bitIndex += 1) {
        const bit = this.bit(this.posSpecial, base + symbol);
        symbol = (symbol << 1) | bit;
        if (bit === 1) {
          distance = (distance + (1 << bitIndex)) >>> 0;
        }
      }
      return distance;
    }
    // rc_direct
    limit -= ALIGN_BITS;
    for (let count = limit; count > 0; count -= 1) {
      this.normalize();
      this.range >>>= 1;
      this.code = (this.code - this.range) >>> 0;
      const bound = (0 - (this.code >>> 31)) >>> 0;
      this.code = (this.code + (this.range & bound)) >>> 0;
      distance = ((distance << 1) + ((bound + 1) >>> 0)) >>> 0;
    }
    distance = (distance << ALIGN_BITS) >>> 0;
    let symbol = 0;
    for (let offset = 1; offset < ALIGN_SIZE; offset <<= 1) {
      if (this.bit(this.posAlign, offset + symbol) === 1) {
        symbol += offset;
      }
    }
    return (distance + symbol) >>> 0;
  }

  /** lzma_decode, one symbol: true at the end of the stream. */
  private symbol(): boolean {
    const posState = this.total & this.posMask;
    const state = this.state;
    if (this.bit(this.isMatch, state * POS_STATES_MAX + posState) === 0) {
      let matched = false;
      if (state < LIT_STATES) {
        this.state = state <= 3 ? 0 : state - 3;
      } else {
        this.state = state <= 9 ? state - 3 : state - 6;
        matched = true;
      }
      this.put(this.decodeLiteral(matched));
      return false;
    }
    let length: number;
    if (this.bit(this.isRep, state) === 0) {
      // Simple match.
      this.state = state < LIT_STATES ? 7 : 10;
      this.rep3 = this.rep2;
      this.rep2 = this.rep1;
      this.rep1 = this.rep0;
      length = this.length(this.matchLength, posState);
      this.rep0 = this.decodeDistance(length);
      if (this.rep0 === UINT32_MAX) {
        // End of payload marker: the range coder must be finished.
        this.normalize();
        if (this.code !== 0) {
          throw new CorruptData();
        }
        return true;
      }
      if (!this.distanceValid(this.rep0)) {
        throw new CorruptData();
      }
    } else {
      // Repeated match.
      if (!this.distanceValid(0)) {
        throw new CorruptData();
      }
      if (this.bit(this.isRep0, state) === 0) {
        if (
          this.bit(this.isRep0Long, state * POS_STATES_MAX + posState) === 0
        ) {
          this.state = state < LIT_STATES ? 9 : 11;
          this.put(this.byteAt(this.rep0));
          return false;
        }
      } else {
        let distance: number;
        if (this.bit(this.isRep1, state) === 0) {
          distance = this.rep1;
        } else {
          if (this.bit(this.isRep2, state) === 0) {
            distance = this.rep2;
          } else {
            distance = this.rep3;
            this.rep3 = this.rep2;
          }
          this.rep2 = this.rep1;
        }
        this.rep1 = this.rep0;
        this.rep0 = distance;
      }
      this.state = state < LIT_STATES ? 8 : 11;
      length = this.length(this.repLength, posState);
    }
    for (let index = 0; index < length; index += 1) {
      this.put(this.byteAt(this.rep0));
    }
    return false;
  }
}

class CorruptData extends Error {}

/**
 * zipfile's `LZMADecompressor`: reads the 4-byte zip LZMA header and the
 * properties, then decodes raw LZMA1.
 */
export class ZipLzmaDecompressor {
  capped = false;

  private decoder: RawLzma1Decoder | null = null;
  private unconsumed: Uint8Array = new Uint8Array(0);

  get eof(): boolean {
    return this.decoder?.eof ?? false;
  }

  decompress(data: Uint8Array, _maxLength: number, cap: number): Uint8Array {
    let input = data;
    if (this.decoder === null) {
      const joined = new Uint8Array(this.unconsumed.length + data.length);
      joined.set(this.unconsumed);
      joined.set(data, this.unconsumed.length);
      this.unconsumed = joined;
      if (joined.length <= 4) {
        return new Uint8Array(0);
      }
      const propertiesSize =
        (joined[2] as number) | ((joined[3] as number) << 8);
      if (joined.length <= 4 + propertiesSize) {
        return new Uint8Array(0);
      }
      const properties = decodeProperties(
        joined.subarray(4, 4 + propertiesSize),
      );
      if (properties === null) {
        throw new LzmaError('Invalid or unsupported options');
      }
      this.decoder = new RawLzma1Decoder(properties);
      input = joined.subarray(4 + propertiesSize);
      this.unconsumed = new Uint8Array(0);
    }
    const output = this.decoder.decompress(input, cap);
    this.capped = this.decoder.capped;
    return output;
  }
}
