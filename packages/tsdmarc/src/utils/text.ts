// UTF-8 decoding with Python's error handlers. `TextDecoder` only offers
// "replace" and "fatal"; parsedmarc often decodes with `errors="ignore"`,
// which drops invalid sequences instead of inserting U+FFFD.

export type DecodeErrors = 'strict' | 'replace' | 'ignore';

const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const REPLACE = new TextDecoder('utf-8', { ignoreBOM: true });

/** Length of the valid UTF-8 sequence at `index`, or 0 if invalid there. */
function sequenceLength(bytes: Uint8Array, index: number): number {
  const first = bytes[index] ?? 0;
  if (first < 0x80) {
    return 1;
  }
  let length: number;
  let lower = 0x80;
  let upper = 0xbf;
  if (first >= 0xc2 && first <= 0xdf) {
    length = 2;
  } else if (first >= 0xe0 && first <= 0xef) {
    length = 3;
    if (first === 0xe0) {
      lower = 0xa0;
    } else if (first === 0xed) {
      upper = 0x9f;
    }
  } else if (first >= 0xf0 && first <= 0xf4) {
    length = 4;
    if (first === 0xf0) {
      lower = 0x90;
    } else if (first === 0xf4) {
      upper = 0x8f;
    }
  } else {
    return 0;
  }
  for (let offset = 1; offset < length; offset += 1) {
    const byte = bytes[index + offset];
    if (byte === undefined) {
      return 0;
    }
    const min = offset === 1 ? lower : 0x80;
    const max = offset === 1 ? upper : 0xbf;
    if (byte < min || byte > max) {
      return 0;
    }
  }
  return length;
}

/** Decode UTF-8 like Python's `bytes.decode("utf-8", errors=...)`. */
export function decodeUtf8(
  bytes: Uint8Array,
  errors: DecodeErrors = 'strict',
): string {
  if (errors === 'strict') {
    return STRICT.decode(bytes);
  }
  if (errors === 'replace') {
    return REPLACE.decode(bytes);
  }
  try {
    return STRICT.decode(bytes);
  } catch {
    // Fall through to the slow path only for invalid input.
  }
  // The valid sequences, moved together in one copy: a view per valid run
  // would cost a hundred times the size of input that alternates with
  // invalid bytes.
  const kept = new Uint8Array(bytes.length);
  let keptLength = 0;
  let index = 0;
  while (index < bytes.length) {
    const length = sequenceLength(bytes, index);
    for (let offset = 0; offset < length; offset += 1) {
      kept[keptLength] = bytes[index + offset] ?? 0;
      keptLength += 1;
    }
    index += Math.max(length, 1);
  }
  return STRICT.decode(kept.subarray(0, keptLength));
}
