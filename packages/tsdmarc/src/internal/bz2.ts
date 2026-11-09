// Port of the libbzip2 1.0.8 decompressor (decompress.c, bzlib.c
// BZ2_bzDecompress / unRLE_obuf_to_output_FAST, huffman.c) and of Python's
// `bz2.BZ2Decompressor` loop around it (Modules/_bz2module.c), as zipfile
// uses it for ZIP_BZIP2 members.
//
// Like the zlib port, this follows the C state machine closely because the
// outcome of a corrupt or truncated member depends on it: libbzip2 only
// reports BZ_DATA_ERROR ("Invalid data stream") for corrupt data, a
// truncated stream just stops producing output, and CPython's loop stops as
// soon as the input is used up, even if libbzip2 still holds output.

/** Python's `OSError` raised by `BZ2Decompressor`. */
export class Bz2Error extends Error {
  override name = 'OSError';
}

const NEED_INPUT = 0;
const BLOCK_READY = 1;
type Pause = typeof NEED_INPUT | typeof BLOCK_READY;

const BZ_N_GROUPS = 6;
const BZ_G_SIZE = 50;
const BZ_MAX_ALPHA_SIZE = 258;
const BZ_MAX_CODE_LEN = 23;
const BZ_MAX_SELECTORS = 2 + 900_000 / BZ_G_SIZE;
const BZ_RUNA = 0;
const BZ_RUNB = 1;
const MTFA_SIZE = 4096;
const MTFL_SIZE = 16;
const BLOCK_UNIT = 100_000;

/** CPython's output buffer block sizes (pycore_blocks_output_buffer.h). */
const KB = 1024;
const MB = 1024 * KB;
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

/** randtable.c `BZ2_rNums`, for (deprecated) randomised blocks. */
const R_NUMS: readonly number[] = (
  '619,720,127,481,931,816,813,233,566,247,985,724,205,454,863,491,741,24' +
  '2,949,214,733,859,335,708,621,574,73,654,730,472,419,436,278,496,867,2' +
  '10,399,680,480,51,878,465,811,169,869,675,611,697,867,561,862,687,507,' +
  '283,482,129,807,591,733,623,150,238,59,379,684,877,625,169,643,105,170' +
  ',607,520,932,727,476,693,425,174,647,73,122,335,530,442,853,695,249,44' +
  '5,515,909,545,703,919,874,474,882,500,594,612,641,801,220,162,819,984,' +
  '589,513,495,799,161,604,958,533,221,400,386,867,600,782,382,596,414,17' +
  '1,516,375,682,485,911,276,98,553,163,354,666,933,424,341,533,870,227,7' +
  '30,475,186,263,647,537,686,600,224,469,68,770,919,190,373,294,822,808,' +
  '206,184,943,795,384,383,461,404,758,839,887,715,67,618,276,204,918,873' +
  ',777,604,560,951,160,578,722,79,804,96,409,713,940,652,934,970,447,318' +
  ',353,859,672,112,785,645,863,803,350,139,93,354,99,820,908,609,772,154' +
  ',274,580,184,79,626,630,742,653,282,762,623,680,81,927,626,789,125,411' +
  ',521,938,300,821,78,343,175,128,250,170,774,972,275,999,639,495,78,352' +
  ',126,857,956,358,619,580,124,737,594,701,612,669,112,134,694,363,992,8' +
  '09,743,168,974,944,375,748,52,600,747,642,182,862,81,344,805,988,739,5' +
  '11,655,814,334,249,515,897,955,664,981,649,113,974,459,893,228,433,837' +
  ',553,268,926,240,102,654,459,51,686,754,806,760,493,403,415,394,687,70' +
  '0,946,670,656,610,738,392,760,799,887,653,978,321,576,617,626,502,894,' +
  '679,243,440,680,879,194,572,640,724,926,56,204,700,707,151,457,449,797' +
  ',195,791,558,945,679,297,59,87,824,713,663,412,693,342,606,134,108,571' +
  ',364,631,212,174,643,304,329,343,97,430,751,497,314,983,374,822,928,14' +
  '0,206,73,263,980,736,876,478,430,305,170,514,364,692,829,82,855,953,67' +
  '6,246,369,970,294,750,807,827,150,790,288,923,804,378,215,828,592,281,' +
  '565,555,710,82,896,831,547,261,524,462,293,465,502,56,661,821,976,991,' +
  '658,869,905,758,745,193,768,550,608,933,378,286,215,979,792,961,61,688' +
  ',793,644,986,403,106,366,905,644,372,567,466,434,645,210,389,550,919,1' +
  '35,780,773,635,389,707,100,626,958,165,504,920,176,193,713,857,265,203' +
  ',50,668,108,645,990,626,197,510,357,358,850,858,364,936,638' +
  ''
)
  .split(',')
  .map(Number);

/** bzlib's CRC-32 (MSB first, polynomial 0x04c11db7). */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80_00_00_00 ? (crc << 1) ^ 0x04_c1_1d_b7 : crc << 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

/** BZ_UPDATE_CRC. */
function updateCrc(crc: number, byte: number): number {
  return (
    ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0
  );
}

class DataError extends Error {}

/**
 * Python's `bz2.BZ2Decompressor` as zipfile drives it: `decompress(data)`
 * with no output limit, except that output stops at `cap` bytes (see
 * `capped`).
 */
export class Bz2Decompressor {
  /** Python's `BZ2Decompressor.eof`. */
  eof = false;
  /** The last call stopped at `cap` bytes with more output pending. */
  capped = false;

  // Input (CPython keeps unconsumed input for the next call).
  private input: Uint8Array = new Uint8Array(0);
  private position = 0;
  private bsBuff = 0;
  private bsLive = 0;

  // Output of the current call.
  private output: Uint8Array = new Uint8Array(0);
  private outputLength = 0;
  private availOut = 0;

  // DState.
  private inOutput = false;
  private blockSize100k = 0;
  private tt: Uint32Array = new Uint32Array(0);
  private storedBlockCrc = 0;
  private storedCombinedCrc = 0;
  private calculatedBlockCrc = 0;
  private calculatedCombinedCrc = 0;
  private blockRandomised = false;
  private origPtr = 0;
  private saveNblock = 0;
  private stateOutLen = 0;
  private stateOutCh = 0;
  private k0 = 0;
  private tPos = 0;
  private nblockUsed = 0;
  private rNToGo = 0;
  private rTPos = 0;
  private readonly machine: Generator<Pause, void, void> = this.run();

  /**
   * `BZ2Decompressor.decompress(data)`; throws {@link Bz2Error} on corrupt
   * data.
   */
  decompress(data: Uint8Array, _maxLength: number, cap: number): Uint8Array {
    if (this.eof) {
      throw new Error('End of stream already reached');
    }
    const rest = this.input.subarray(this.position);
    const input = new Uint8Array(rest.length + data.length);
    input.set(rest);
    input.set(data, rest.length);
    this.input = input;
    this.position = 0;
    this.capped = false;
    let blocks = 0;
    let boundary = BUFFER_BLOCK_SIZE[0] as number;
    this.output = new Uint8Array(Math.min(boundary, cap));
    this.outputLength = 0;
    this.availOut = this.output.length;
    for (;;) {
      const streamEnd = this.bzDecompress();
      if (streamEnd) {
        this.eof = true;
        break;
      }
      const availIn = this.input.length - this.position;
      if (this.availOut === 0 && this.outputLength >= cap) {
        // Python's buffer would have room for more output here, unless this
        // is also one of its block boundaries and the input is used up.
        this.capped = !(this.outputLength === boundary && availIn === 0);
        break;
      }
      if (availIn === 0) {
        break;
      }
      if (this.availOut === 0) {
        blocks += 1;
        boundary +=
          BUFFER_BLOCK_SIZE[Math.min(blocks, BUFFER_BLOCK_SIZE.length - 1)] ??
          0;
        this.grow(Math.min(boundary, cap));
      }
    }
    return this.output.subarray(0, this.outputLength);
  }

  private grow(size: number): void {
    const grown = new Uint8Array(size);
    grown.set(this.output.subarray(0, this.outputLength));
    this.output = grown;
    this.availOut = size - this.outputLength;
  }

  /** BZ2_bzDecompress: true at the end of the stream. */
  private bzDecompress(): boolean {
    try {
      for (;;) {
        if (this.inOutput) {
          if (
            this.blockRandomised ? this.unRleRandomised() : this.unRleFast()
          ) {
            throw new DataError();
          }
          if (
            this.nblockUsed !== this.saveNblock + 1 ||
            this.stateOutLen !== 0
          ) {
            return false;
          }
          if (~this.calculatedBlockCrc >>> 0 !== this.storedBlockCrc) {
            throw new DataError();
          }
          this.calculatedCombinedCrc =
            (((this.calculatedCombinedCrc << 1) |
              (this.calculatedCombinedCrc >>> 31)) ^
              ~this.calculatedBlockCrc) >>>
            0;
          this.inOutput = false;
        }
        const step = this.machine.next();
        if (step.done === true) {
          if (this.calculatedCombinedCrc !== this.storedCombinedCrc) {
            throw new DataError();
          }
          return true;
        }
        if (step.value === NEED_INPUT) {
          return false;
        }
        this.inOutput = true;
      }
    } catch (error) {
      if (error instanceof DataError) {
        throw new Bz2Error('Invalid data stream');
      }
      throw error;
    }
  }

  /** Pull input bytes until `count` bits are buffered (GET_BITS). */
  private fill(count: number): boolean {
    while (this.bsLive < count) {
      if (this.position >= this.input.length) {
        return false;
      }
      this.bsBuff =
        ((this.bsBuff << 8) | (this.input[this.position] as number)) >>> 0;
      this.position += 1;
      this.bsLive += 8;
    }
    return true;
  }

  private take(count: number): number {
    this.bsLive -= count;
    return (this.bsBuff >>> this.bsLive) & ((1 << count) - 1);
  }

  private *bits(count: number): Generator<Pause, number, void> {
    while (!this.fill(count)) {
      yield NEED_INPUT;
    }
    return this.take(count);
  }

  private *uint32(): Generator<Pause, number, void> {
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      value = ((value << 8) | (yield* this.bits(8))) >>> 0;
    }
    return value;
  }

  private *expect(bytes: readonly number[]): Generator<Pause, void, void> {
    for (const byte of bytes) {
      if ((yield* this.bits(8)) !== byte) {
        throw new DataError();
      }
    }
  }

  // BZ2_decompress: yields BLOCK_READY when a block can be output.
  private *run(): Generator<Pause, void, void> {
    for (const byte of [0x42, 0x5a, 0x68]) {
      if ((yield* this.bits(8)) !== byte) {
        throw new DataError();
      }
    }
    const level = yield* this.bits(8);
    if (level < 0x31 || level > 0x39) {
      throw new DataError();
    }
    this.blockSize100k = level - 0x30;
    this.tt = new Uint32Array(this.blockSize100k * BLOCK_UNIT);
    for (;;) {
      const first = yield* this.bits(8);
      if (first === 0x17) {
        break;
      }
      if (first !== 0x31) {
        throw new DataError();
      }
      yield* this.expect([0x41, 0x59, 0x26, 0x53, 0x59]);
      this.storedBlockCrc = yield* this.uint32();
      yield* this.block();
      yield BLOCK_READY;
    }
    yield* this.expect([0x72, 0x45, 0x38, 0x50, 0x90]);
    this.storedCombinedCrc = yield* this.uint32();
  }

  // oxlint-disable-next-line max-lines-per-function, complexity -- a 1:1 port of BZ2_decompress
  private *block(): Generator<Pause, void, void> {
    this.blockRandomised = (yield* this.bits(1)) === 1;
    let origPtr = 0;
    for (let index = 0; index < 3; index += 1) {
      origPtr = (origPtr << 8) | (yield* this.bits(8));
    }
    if (origPtr > 10 + BLOCK_UNIT * this.blockSize100k) {
      throw new DataError();
    }
    this.origPtr = origPtr;

    // The mapping table.
    const inUse16: boolean[] = [];
    for (let index = 0; index < 16; index += 1) {
      inUse16.push((yield* this.bits(1)) === 1);
    }
    const seqToUnseq = new Uint8Array(256);
    let nInUse = 0;
    const inUse = new Uint8Array(256);
    for (let high = 0; high < 16; high += 1) {
      if (inUse16[high] === true) {
        for (let low = 0; low < 16; low += 1) {
          if ((yield* this.bits(1)) === 1) {
            inUse[high * 16 + low] = 1;
          }
        }
      }
    }
    for (let index = 0; index < 256; index += 1) {
      if (inUse[index] === 1) {
        seqToUnseq[nInUse] = index;
        nInUse += 1;
      }
    }
    if (nInUse === 0) {
      throw new DataError();
    }
    const alphaSize = nInUse + 2;

    // The selectors.
    const nGroups = yield* this.bits(3);
    if (nGroups < 2 || nGroups > BZ_N_GROUPS) {
      throw new DataError();
    }
    let nSelectors = yield* this.bits(15);
    if (nSelectors < 1) {
      throw new DataError();
    }
    const selectorMtf = new Uint8Array(BZ_MAX_SELECTORS);
    for (let index = 0; index < nSelectors; index += 1) {
      let value = 0;
      while ((yield* this.bits(1)) !== 0) {
        value += 1;
        if (value >= nGroups) {
          throw new DataError();
        }
      }
      if (index < BZ_MAX_SELECTORS) {
        selectorMtf[index] = value;
      }
    }
    if (nSelectors > BZ_MAX_SELECTORS) {
      nSelectors = BZ_MAX_SELECTORS;
    }
    const selector = new Uint8Array(BZ_MAX_SELECTORS);
    const groupOrder = [0, 1, 2, 3, 4, 5];
    for (let index = 0; index < nSelectors; index += 1) {
      let value = selectorMtf[index] as number;
      const picked = groupOrder[value] as number;
      while (value > 0) {
        groupOrder[value] = groupOrder[value - 1] as number;
        value -= 1;
      }
      groupOrder[0] = picked;
      selector[index] = picked;
    }

    // The coding tables.
    const lengths: Uint8Array[] = [];
    for (let group = 0; group < nGroups; group += 1) {
      const groupLengths = new Uint8Array(BZ_MAX_ALPHA_SIZE);
      let current = yield* this.bits(5);
      for (let symbol = 0; symbol < alphaSize; symbol += 1) {
        for (;;) {
          if (current < 1 || current > 20) {
            throw new DataError();
          }
          if ((yield* this.bits(1)) === 0) {
            break;
          }
          current += (yield* this.bits(1)) === 0 ? 1 : -1;
        }
        groupLengths[symbol] = current;
      }
      lengths.push(groupLengths);
    }
    const limits: Int32Array[] = [];
    const bases: Int32Array[] = [];
    const perms: Int32Array[] = [];
    const minLens: number[] = [];
    for (const groupLengths of lengths) {
      let minLen = 32;
      let maxLen = 0;
      for (let symbol = 0; symbol < alphaSize; symbol += 1) {
        const length = groupLengths[symbol] as number;
        maxLen = Math.max(maxLen, length);
        minLen = Math.min(minLen, length);
      }
      const limit = new Int32Array(BZ_MAX_ALPHA_SIZE);
      const base = new Int32Array(BZ_MAX_ALPHA_SIZE);
      const perm = new Int32Array(BZ_MAX_ALPHA_SIZE);
      createDecodeTables(
        limit,
        base,
        perm,
        groupLengths,
        minLen,
        maxLen,
        alphaSize,
      );
      limits.push(limit);
      bases.push(base);
      perms.push(perm);
      minLens.push(minLen);
    }

    // The MTF values.
    const eob = nInUse + 1;
    const nblockMax = BLOCK_UNIT * this.blockSize100k;
    let groupNo = -1;
    let groupPos = 0;
    let gMinlen = 0;
    let gLimit = limits[0] as Int32Array;
    let gBase = bases[0] as Int32Array;
    let gPerm = perms[0] as Int32Array;
    const unzftab = new Int32Array(256);
    const mtfa = new Uint8Array(MTFA_SIZE);
    const mtfbase = new Int32Array(256 / MTFL_SIZE);
    {
      let kk = MTFA_SIZE - 1;
      for (let ii = 256 / MTFL_SIZE - 1; ii >= 0; ii -= 1) {
        for (let jj = MTFL_SIZE - 1; jj >= 0; jj -= 1) {
          mtfa[kk] = ii * MTFL_SIZE + jj;
          kk -= 1;
        }
        mtfbase[ii] = kk + 1;
      }
    }
    const tt = this.tt;
    let nblock = 0;

    // GET_MTF_VAL. `nextGroup` and `finish` are shared by the fast path
    // (enough input buffered for any code: at most 21 bits) and the
    // resumable one.
    const nextGroup = (): void => {
      if (groupPos === 0) {
        groupNo += 1;
        if (groupNo >= nSelectors) {
          throw new DataError();
        }
        groupPos = BZ_G_SIZE;
        const gSel = selector[groupNo] as number;
        gMinlen = minLens[gSel] as number;
        gLimit = limits[gSel] as Int32Array;
        gPerm = perms[gSel] as Int32Array;
        gBase = bases[gSel] as Int32Array;
      }
      groupPos -= 1;
    };
    const finish = (zn: number, zvec: number): number => {
      const index = zvec - (gBase[zn] as number);
      if (index < 0 || index >= BZ_MAX_ALPHA_SIZE) {
        throw new DataError();
      }
      return gPerm[index] as number;
    };
    const mtfValFast = (): number => {
      nextGroup();
      let zn = gMinlen;
      this.fill(zn);
      let zvec = this.take(zn);
      for (;;) {
        if (zn > 20) {
          throw new DataError();
        }
        if (zvec <= (gLimit[zn] as number)) {
          return finish(zn, zvec);
        }
        zn += 1;
        this.fill(1);
        zvec = (zvec << 1) | this.take(1);
      }
    };
    const mtfValSlow = function* (
      this: Bz2Decompressor,
    ): Generator<Pause, number, void> {
      nextGroup();
      let zn = gMinlen;
      while (!this.fill(zn)) {
        yield NEED_INPUT;
      }
      let zvec = this.take(zn);
      for (;;) {
        if (zn > 20) {
          throw new DataError();
        }
        if (zvec <= (gLimit[zn] as number)) {
          return finish(zn, zvec);
        }
        zn += 1;
        while (!this.fill(1)) {
          yield NEED_INPUT;
        }
        zvec = (zvec << 1) | this.take(1);
      }
    }.bind(this);
    const fastInput = (): boolean => this.input.length - this.position >= 4;

    let nextSym = fastInput() ? mtfValFast() : yield* mtfValSlow();
    for (;;) {
      if (nextSym === eob) {
        break;
      }
      if (nextSym === BZ_RUNA || nextSym === BZ_RUNB) {
        let es = -1;
        let n = 1;
        do {
          if (n >= 2 * 1024 * 1024) {
            throw new DataError();
          }
          es += nextSym === BZ_RUNA ? n : 2 * n;
          n *= 2;
          nextSym = fastInput() ? mtfValFast() : yield* mtfValSlow();
        } while (nextSym === BZ_RUNA || nextSym === BZ_RUNB);
        es += 1;
        const uc = seqToUnseq[mtfa[mtfbase[0] as number] as number] as number;
        unzftab[uc] = (unzftab[uc] as number) + es;
        while (es > 0) {
          if (nblock >= nblockMax) {
            throw new DataError();
          }
          tt[nblock] = uc;
          nblock += 1;
          es -= 1;
        }
        continue;
      }
      if (nblock >= nblockMax) {
        throw new DataError();
      }
      let uc: number;
      let nn = nextSym - 1;
      if (nn < MTFL_SIZE) {
        const pp = mtfbase[0] as number;
        uc = mtfa[pp + nn] as number;
        while (nn > 0) {
          mtfa[pp + nn] = mtfa[pp + nn - 1] as number;
          nn -= 1;
        }
        mtfa[pp] = uc;
      } else {
        let lno = Math.floor(nn / MTFL_SIZE);
        const off = nn % MTFL_SIZE;
        let pp = (mtfbase[lno] as number) + off;
        uc = mtfa[pp] as number;
        while (pp > (mtfbase[lno] as number)) {
          mtfa[pp] = mtfa[pp - 1] as number;
          pp -= 1;
        }
        mtfbase[lno] = (mtfbase[lno] as number) + 1;
        while (lno > 0) {
          mtfbase[lno] = (mtfbase[lno] as number) - 1;
          mtfa[mtfbase[lno] as number] = mtfa[
            (mtfbase[lno - 1] as number) + MTFL_SIZE - 1
          ] as number;
          lno -= 1;
        }
        mtfbase[0] = (mtfbase[0] as number) - 1;
        mtfa[mtfbase[0] as number] = uc;
        if (mtfbase[0] === 0) {
          let kk = MTFA_SIZE - 1;
          for (let ii = 256 / MTFL_SIZE - 1; ii >= 0; ii -= 1) {
            for (let jj = MTFL_SIZE - 1; jj >= 0; jj -= 1) {
              mtfa[kk] = mtfa[(mtfbase[ii] as number) + jj] as number;
              kk -= 1;
            }
            mtfbase[ii] = kk + 1;
          }
        }
      }
      const symbol = seqToUnseq[uc] as number;
      unzftab[symbol] = (unzftab[symbol] as number) + 1;
      tt[nblock] = symbol;
      nblock += 1;
      nextSym = fastInput() ? mtfValFast() : yield* mtfValSlow();
    }

    if (this.origPtr < 0 || this.origPtr >= nblock) {
      throw new DataError();
    }
    for (let index = 0; index <= 255; index += 1) {
      const count = unzftab[index] as number;
      if (count < 0 || count > nblock) {
        throw new DataError();
      }
    }
    const cftab = new Int32Array(257);
    for (let index = 1; index <= 256; index += 1) {
      cftab[index] =
        (unzftab[index - 1] as number) + (cftab[index - 1] as number);
    }
    for (let index = 0; index <= 256; index += 1) {
      const value = cftab[index] as number;
      if (value < 0 || value > nblock) {
        throw new DataError();
      }
      if (index > 0 && (cftab[index - 1] as number) > value) {
        throw new DataError();
      }
    }
    this.stateOutLen = 0;
    this.stateOutCh = 0;
    this.calculatedBlockCrc = 0xff_ff_ff_ff;
    for (let index = 0; index < nblock; index += 1) {
      const uc = (tt[index] as number) & 0xff;
      const target = cftab[uc] as number;
      tt[target] = ((tt[target] as number) | (index << 8)) >>> 0;
      cftab[uc] = target + 1;
    }
    this.saveNblock = nblock;
    this.tPos = (tt[this.origPtr] as number) >>> 8;
    this.nblockUsed = 0;
    if (this.blockRandomised) {
      this.rNToGo = 0;
      this.rTPos = 0;
      this.k0 = this.getFast();
      this.nblockUsed += 1;
      this.k0 ^= this.randMask();
    } else {
      this.k0 = this.getFast();
      this.nblockUsed += 1;
    }
  }

  /** BZ_GET_FAST; the bound check never fails on a well-formed T vector. */
  private getFast(): number {
    if (this.tPos >= BLOCK_UNIT * this.blockSize100k) {
      throw new DataError();
    }
    const entry = this.tt[this.tPos] as number;
    this.tPos = entry >>> 8;
    return entry & 0xff;
  }

  /** BZ_RAND_UPD_MASK, then BZ_RAND_MASK. */
  private randMask(): number {
    if (this.rNToGo === 0) {
      this.rNToGo = R_NUMS[this.rTPos] as number;
      this.rTPos += 1;
      if (this.rTPos === 512) {
        this.rTPos = 0;
      }
    }
    this.rNToGo -= 1;
    return this.rNToGo === 1 ? 1 : 0;
  }

  private writeByte(byte: number): void {
    this.output[this.outputLength] = byte;
    this.outputLength += 1;
    this.availOut -= 1;
    this.calculatedBlockCrc = updateCrc(this.calculatedBlockCrc, byte);
  }

  /** unRLE_obuf_to_output_FAST, randomised branch: true if corrupt. */
  private unRleRandomised(): boolean {
    const end = this.saveNblock + 1;
    for (;;) {
      for (;;) {
        if (this.availOut === 0) {
          return false;
        }
        if (this.stateOutLen === 0) {
          break;
        }
        this.writeByte(this.stateOutCh);
        this.stateOutLen -= 1;
      }
      if (this.nblockUsed === end) {
        return false;
      }
      if (this.nblockUsed > end) {
        return true;
      }
      this.stateOutLen = 1;
      this.stateOutCh = this.k0;
      let k1 = this.getFast() ^ this.randMask();
      this.nblockUsed += 1;
      if (this.nblockUsed === end) {
        continue;
      }
      if (k1 !== this.k0) {
        this.k0 = k1;
        continue;
      }
      this.stateOutLen = 2;
      k1 = this.getFast() ^ this.randMask();
      this.nblockUsed += 1;
      if (this.nblockUsed === end) {
        continue;
      }
      if (k1 !== this.k0) {
        this.k0 = k1;
        continue;
      }
      this.stateOutLen = 3;
      k1 = this.getFast() ^ this.randMask();
      this.nblockUsed += 1;
      if (this.nblockUsed === end) {
        continue;
      }
      if (k1 !== this.k0) {
        this.k0 = k1;
        continue;
      }
      k1 = this.getFast() ^ this.randMask();
      this.nblockUsed += 1;
      this.stateOutLen = k1 + 4;
      this.k0 = this.getFast() ^ this.randMask();
      this.nblockUsed += 1;
    }
  }

  /**
   * unRLE_obuf_to_output_FAST, non-randomised branch (with its read-ahead
   * and `goto s_state_out_len_eq_one`): true if corrupt. Works on local
   * copies of the state, like the C code, for speed.
   */
  // oxlint-disable-next-line complexity, max-statements -- mirrors the C loop
  private unRleFast(): boolean {
    const tt = this.tt;
    const output = this.output;
    const end = this.saveNblock + 1;
    const tPosLimit = BLOCK_UNIT * this.blockSize100k;
    let crc = this.calculatedBlockCrc;
    let ch = this.stateOutCh;
    let len = this.stateOutLen;
    let used = this.nblockUsed;
    let k0 = this.k0;
    let tPos = this.tPos;
    let out = this.outputLength;
    let avail = this.availOut;
    let jumpToLastByte = false;
    let corrupt = false;
    // BZ_GET_FAST_C
    const getFast = (): number => {
      if (tPos >= tPosLimit) {
        throw new DataError();
      }
      const entry = tt[tPos] as number;
      tPos = entry >>> 8;
      return entry & 0xff;
    };
    const write = (): void => {
      output[out] = ch;
      out += 1;
      avail -= 1;
      crc = updateCrc(crc, ch);
    };
    for (;;) {
      if (jumpToLastByte || len > 0) {
        if (!jumpToLastByte) {
          while (len !== 1 && avail > 0) {
            output[out] = ch;
            out += 1;
            avail -= 1;
            crc = updateCrc(crc, ch);
            len -= 1;
          }
          if (avail === 0) {
            break;
          }
        }
        jumpToLastByte = false;
        if (avail === 0) {
          len = 1;
          break;
        }
        write();
      }
      if (used > end) {
        corrupt = true;
        break;
      }
      if (used === end) {
        len = 0;
        break;
      }
      ch = k0;
      let k1 = getFast();
      used += 1;
      if (k1 !== k0) {
        k0 = k1;
        jumpToLastByte = true;
        continue;
      }
      if (used === end) {
        jumpToLastByte = true;
        continue;
      }
      len = 2;
      k1 = getFast();
      used += 1;
      if (used === end) {
        continue;
      }
      if (k1 !== k0) {
        k0 = k1;
        continue;
      }
      len = 3;
      k1 = getFast();
      used += 1;
      if (used === end) {
        continue;
      }
      if (k1 !== k0) {
        k0 = k1;
        continue;
      }
      k1 = getFast();
      used += 1;
      len = k1 + 4;
      k0 = getFast();
      used += 1;
    }
    this.calculatedBlockCrc = crc;
    this.stateOutCh = ch;
    this.stateOutLen = len;
    this.nblockUsed = used;
    this.k0 = k0;
    this.tPos = tPos;
    this.outputLength = out;
    this.availOut = avail;
    return corrupt;
  }
}

/** huffman.c BZ2_hbCreateDecodeTables. */
function createDecodeTables(
  limit: Int32Array,
  base: Int32Array,
  perm: Int32Array,
  length: Uint8Array,
  minLen: number,
  maxLen: number,
  alphaSize: number,
): void {
  let pp = 0;
  for (let len = minLen; len <= maxLen; len += 1) {
    for (let symbol = 0; symbol < alphaSize; symbol += 1) {
      if (length[symbol] === len) {
        perm[pp] = symbol;
        pp += 1;
      }
    }
  }
  base.fill(0, 0, BZ_MAX_CODE_LEN);
  for (let symbol = 0; symbol < alphaSize; symbol += 1) {
    const index = (length[symbol] as number) + 1;
    base[index] = (base[index] as number) + 1;
  }
  for (let index = 1; index < BZ_MAX_CODE_LEN; index += 1) {
    base[index] = (base[index] as number) + (base[index - 1] as number);
  }
  limit.fill(0, 0, BZ_MAX_CODE_LEN);
  let vec = 0;
  for (let len = minLen; len <= maxLen; len += 1) {
    vec += (base[len + 1] as number) - (base[len] as number);
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len += 1) {
    base[len] = (((limit[len - 1] as number) + 1) << 1) - (base[len] as number);
  }
}
