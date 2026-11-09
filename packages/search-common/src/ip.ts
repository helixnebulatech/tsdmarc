// Python's `str(ipaddress.ip_address(value))`.
//
// The DSL's `Ip()` field validates every IP address before a document is
// saved, and writes it back in Python's canonical form (lowercase, zero runs
// compressed, IPv4-mapped IPv6 kept as `::ffff:a.b.c.d`). An invalid address
// raises `ValueError`, which parsedmarc reports as a save error.
//
// Shared by @tsdmarc/elasticsearch and @tsdmarc/opensearch, which both bundle
// it.

import { pyRepr } from 'tsdmarc';

import { ValueError } from './python';

const HEXTET_COUNT = 8;
const MAX_IPV6_LENGTH = 45;
const HEX_DIGITS = /^[0-9a-f]*$/iu;
const DECIMAL_DIGITS = /^\d+$/u;
const IPV4_MAPPED_PREFIX = 0xff_ff;

/** Parse a dotted-quad IPv4 address (strict, like Python), or `null`. */
function parseIpv4(text: string): number[] | null {
  if (text === '' || text.includes('/')) {
    return null;
  }
  const octets = text.split('.');
  if (octets.length !== 4) {
    return null;
  }
  const values: number[] = [];
  for (const octet of octets) {
    if (!DECIMAL_DIGITS.test(octet) || octet.length > 3) {
      return null;
    }
    // Leading zeros are rejected, as glibc's inet_pton() does.
    if (octet !== '0' && octet.startsWith('0')) {
      return null;
    }
    const value = Number(octet);
    if (value > 255) {
      return null;
    }
    values.push(value);
  }
  return values;
}

function parseHextet(text: string): number | null {
  if (text === '' || !HEX_DIGITS.test(text) || text.length > 4) {
    return null;
  }
  return Number.parseInt(text, 16);
}

/** Python's `_BaseV6._ip_int_from_string`, as 8 hextets, or `null`. */
function parseIpv6Hextets(text: string): number[] | null {
  if (text === '' || text.length > MAX_IPV6_LENGTH) {
    return null;
  }
  const maxParts = HEXTET_COUNT + 1;
  const parts = text.split(':');
  if (parts.length > maxParts + 1) {
    return null;
  }
  if (parts.length < 3) {
    return null;
  }
  const last = parts.at(-1) ?? '';
  if (last.includes('.')) {
    const ipv4 = parseIpv4(last);
    if (ipv4 === null) {
      return null;
    }
    parts.pop();
    const [a = 0, b = 0, c = 0, d = 0] = ipv4;
    parts.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  if (parts.length > maxParts) {
    return null;
  }
  let skipIndex: number | null = null;
  for (let index = 1; index < parts.length - 1; index++) {
    if (parts[index] === '') {
      if (skipIndex !== null) {
        return null;
      }
      skipIndex = index;
    }
  }
  let partsHi: number;
  let partsLo: number;
  let partsSkipped: number;
  if (skipIndex === null) {
    if (parts.length !== HEXTET_COUNT || parts[0] === '' || last === '') {
      return null;
    }
    partsHi = parts.length;
    partsLo = 0;
    partsSkipped = 0;
  } else {
    partsHi = skipIndex;
    partsLo = parts.length - skipIndex - 1;
    if (parts[0] === '') {
      partsHi -= 1;
      if (partsHi !== 0) {
        return null;
      }
    }
    if (parts.at(-1) === '') {
      partsLo -= 1;
      if (partsLo !== 0) {
        return null;
      }
    }
    partsSkipped = HEXTET_COUNT - (partsHi + partsLo);
    if (partsSkipped < 1) {
      return null;
    }
  }
  const hextets: number[] = [];
  for (let index = 0; index < partsHi; index++) {
    const value = parseHextet(parts[index] ?? '');
    if (value === null) {
      return null;
    }
    hextets.push(value);
  }
  for (let index = 0; index < partsSkipped; index++) {
    hextets.push(0);
  }
  for (let index = parts.length - partsLo; index < parts.length; index++) {
    const value = parseHextet(parts[index] ?? '');
    if (value === null) {
      return null;
    }
    hextets.push(value);
  }
  return hextets;
}

/** Python's `_compress_hextets`: replace the longest run of zeros with `::`. */
function compressHextets(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let length = 0;
  hextets.forEach((hextet, index) => {
    if (hextet === 0) {
      length += 1;
      if (start === -1) {
        start = index;
      }
      if (length > bestLength) {
        bestLength = length;
        bestStart = start;
      }
    } else {
      length = 0;
      start = -1;
    }
  });
  const parts = hextets.map(hextet => hextet.toString(16));
  if (bestLength > 1) {
    const end = bestStart + bestLength;
    const head = parts.slice(0, bestStart);
    const tail = parts.slice(end);
    return `${head.join(':')}::${tail.join(':')}`;
  }
  return parts.join(':');
}

function formatIpv6(text: string): string | null {
  if (text.includes('/')) {
    return null;
  }
  const percent = text.indexOf('%');
  let address = text;
  let scopeId: string | null = null;
  if (percent !== -1) {
    scopeId = text.slice(percent + 1);
    address = text.slice(0, percent);
    if (scopeId === '' || scopeId.includes('%')) {
      return null;
    }
  }
  const hextets = parseIpv6Hextets(address);
  if (hextets === null) {
    return null;
  }
  const isIpv4Mapped =
    hextets.slice(0, 5).every(hextet => hextet === 0) &&
    hextets[5] === IPV4_MAPPED_PREFIX;
  const [high = 0, low = 0] = hextets.slice(6);
  const formatted = isIpv4Mapped
    ? `::ffff:${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
    : compressHextets(hextets);
  return scopeId ? `${formatted}%${scopeId}` : formatted;
}

/**
 * Validate an IP address and return Python's canonical string for it.
 *
 * @throws {ValueError} `'<value>' does not appear to be an IPv4 or IPv6 address`
 */
export function normalizeIpAddress(value: string): string {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) {
    return ipv4.join('.');
  }
  const ipv6 = formatIpv6(value);
  if (ipv6 !== null) {
    return ipv6;
  }
  throw new ValueError(
    `${pyRepr(value)} does not appear to be an IPv4 or IPv6 address`,
  );
}
