// Incremental CRC-32 (IEEE 802.3, as zlib.crc32): the decompressors check
// it over output produced across several calls.

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Python's `zlib.crc32(data[start:end], crc)`. */
export function crc32Update(
  crc: number,
  data: Uint8Array,
  start = 0,
  end: number = data.length,
): number {
  let value = ~crc;
  for (let index = start; index < end; index += 1) {
    value =
      (TABLE[(value ^ (data[index] as number)) & 0xff] as number) ^
      (value >>> 8);
  }
  return ~value >>> 0;
}
