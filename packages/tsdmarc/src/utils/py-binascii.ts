// Ports of CPython's `binascii` decoders (and `base64.b64decode`).
//
// Node's base64 decoder silently accepts what Python rejects (bad padding)
// and the reverse, and has no quoted-printable or uuencode decoder. The
// email code depends on Python's exact leniency, so the C loops are ported.

import { pyEncode, UnicodeEncodeError } from './py-codecs';

/** Python's `binascii.Error` (a `ValueError`); `type(e).__name__` is `Error`. */
export class BinasciiError extends Error {
  override name = 'Error';
}

const BYTE_VALUES = 256;
const BASE64_PAD = 0x3d;
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_TABLE: Uint8Array = (() => {
  const table = new Uint8Array(BYTE_VALUES).fill(0xff);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

function toBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data !== 'string') {
    return data;
  }
  try {
    return pyEncode(data, 'ascii');
  } catch (error) {
    if (error instanceof UnicodeEncodeError) {
      throw new BinasciiError(
        'string argument should contain only ASCII characters',
      );
    }
    throw error;
  }
}

function lengthError(output: { readonly length: number }): BinasciiError {
  const count = Math.floor(output.length / 3) * 4 + 1;
  return new BinasciiError(
    `Invalid base64-encoded string: number of data characters (${count}) cannot be 1 more than a multiple of 4`,
  );
}

/**
 * `binascii.a2b_base64(data, strict_mode=strict)`, a port of CPython
 * 3.14's loop. Lenient mode skips every non-alphabet byte (padding
 * included); an incomplete final quad must be followed by enough `=`.
 * Output goes into a preallocated buffer: attachments are megabytes.
 */
export function a2bBase64(
  data: Uint8Array | string,
  strict = false,
): Uint8Array {
  const input = toBytes(data);
  const output = new Uint8Array(Math.floor((input.length + 3) / 4) * 3);
  let length = 0;
  let quadPos = 0;
  let leftChar = 0;
  let pads = 0;
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as number;
    if (raw === BASE64_PAD) {
      pads += 1;
      if (quadPos >= 2 && quadPos + pads <= 4) {
        continue;
      }
      // RFC 4648 3.3: pad characters before the end MAY be ignored.
      if (!strict) {
        continue;
      }
      if (quadPos === 1) {
        break; // The length error below.
      }
      throw new BinasciiError(
        quadPos === 0 && index === 0
          ? 'Leading padding not allowed'
          : 'Excess padding not allowed',
      );
    }
    const value = BASE64_TABLE[raw] as number;
    if (value >= 64) {
      if (strict) {
        throw new BinasciiError('Only base64 data is allowed');
      }
      continue;
    }
    if (pads !== 0 && strict) {
      throw new BinasciiError(
        quadPos + pads === 4
          ? 'Excess data after padding'
          : 'Discontinuous padding not allowed',
      );
    }
    pads = 0;
    switch (quadPos) {
      case 0: {
        quadPos = 1;
        leftChar = value;
        break;
      }
      case 1: {
        quadPos = 2;
        output[length] = (leftChar << 2) | (value >> 4);
        length += 1;
        leftChar = value & 0x0f;
        break;
      }
      case 2: {
        quadPos = 3;
        output[length] = (leftChar << 4) | (value >> 2);
        length += 1;
        leftChar = value & 0x03;
        break;
      }
      default: {
        quadPos = 0;
        output[length] = (leftChar << 6) | value;
        length += 1;
        leftChar = 0;
        break;
      }
    }
  }
  if (quadPos === 1) {
    throw lengthError({ length });
  }
  if (quadPos !== 0 && quadPos + pads < 4) {
    throw new BinasciiError('Incorrect padding');
  }
  return output.slice(0, length);
}

/** `base64.b64decode(s, validate=validate)`. */
export function b64decode(
  data: Uint8Array | string,
  validate = false,
): Uint8Array {
  if (typeof data === 'string') {
    try {
      return a2bBase64(pyEncode(data, 'ascii'), validate);
    } catch (error) {
      if (error instanceof UnicodeEncodeError) {
        throw new TypeError(
          'string argument should contain only ASCII characters',
        );
      }
      throw error;
    }
  }
  return a2bBase64(data, validate);
}

/** `base64.b64encode(data).decode('ascii')`. */
export function b64encode(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    'base64',
  );
}

function hexValue(byte: number | undefined): number {
  if (byte === undefined) {
    return -1;
  }
  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30;
  }
  if (byte >= 0x41 && byte <= 0x46) {
    return byte - 0x37;
  }
  if (byte >= 0x61 && byte <= 0x66) {
    return byte - 0x57;
  }
  return -1;
}

/** `binascii.a2b_qp(data, header=header)` (what `quopri.decodestring` uses). */
export function a2bQp(data: Uint8Array, header = false): Uint8Array {
  // Never longer than the input; indexed writes for large attachments.
  const output = new Uint8Array(data.length);
  let written = 0;
  let index = 0;
  while (index < data.length) {
    const byte = data[index] ?? 0;
    if (byte === 0x3d) {
      index += 1;
      if (index >= data.length) {
        break;
      }
      const next = data[index] ?? 0;
      if (next === 0x0a || next === 0x0d) {
        // Soft line break: skip to the end of the line.
        if (next !== 0x0a) {
          while (index < data.length && data[index] !== 0x0a) {
            index += 1;
          }
        }
        if (index < data.length) {
          index += 1;
        }
      } else if (next === 0x3d) {
        output[written] = 0x3d;
        written += 1;
        index += 1;
      } else {
        const high = hexValue(next);
        const low = hexValue(data[index + 1]);
        if (index + 1 < data.length && high >= 0 && low >= 0) {
          output[written] = (high << 4) | low;
          written += 1;
          index += 2;
        } else {
          output[written] = 0x3d;
          written += 1;
        }
      }
    } else if (header && byte === 0x5f) {
      output[written] = 0x20;
      written += 1;
      index += 1;
    } else {
      output[written] = byte;
      written += 1;
      index += 1;
    }
  }
  return output.slice(0, written);
}

const UU_SPACE = 0x20;
const UU_BACKTICK = 0x60;

/** `binascii.a2b_uu(line)`. */
export function a2bUu(line: Uint8Array): Uint8Array {
  if (line.length === 0) {
    throw new BinasciiError('Missing length byte');
  }
  let binLength = ((line[0] ?? 0) - UU_SPACE) & 0o77;
  const output: number[] = [];
  let leftChar = 0;
  let leftBits = 0;
  let position = 1;
  let remaining = line.length - 1;
  for (; binLength > 0; remaining -= 1, position += 1) {
    let value = remaining > 0 ? (line[position] ?? 0) : 0;
    if (value === 0x0a || value === 0x0d || remaining <= 0) {
      value = 0;
    } else {
      if (value < UU_SPACE || value > UU_SPACE + 64) {
        throw new BinasciiError('Illegal char');
      }
      value = (value - UU_SPACE) & 0o77;
    }
    leftChar = (leftChar << 6) | value;
    leftBits += 6;
    if (leftBits >= 8) {
      leftBits -= 8;
      output.push((leftChar >> leftBits) & 0xff);
      leftChar &= (1 << leftBits) - 1;
      binLength -= 1;
    }
  }
  while (remaining > 0) {
    const value = line[position] ?? 0;
    remaining -= 1;
    position += 1;
    if (
      value !== UU_SPACE &&
      value !== UU_BACKTICK &&
      value !== 0x0a &&
      value !== 0x0d
    ) {
      throw new BinasciiError('Trailing garbage');
    }
  }
  return Uint8Array.from(output);
}
