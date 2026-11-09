// How Python's maxminddb reads an IP address string: through the C
// library's numeric getaddrinfo(), which accepts the classic inet_aton forms
// for IPv4 ("1.2.3" is 1.2.0.3, "010.1.1.1" is octal, "0x7f.1" is hex) and
// standard IPv6. The `maxmind` npm package parses addresses differently, so
// lookups go through `numericHost()` first to get the same address.

import { isIPv6 } from 'node:net';

import { PyTypeError, PyValueError } from '../internal/py';

const DECIMAL = /^[1-9]\d*$|^0$/u;
const OCTAL = /^0[0-7]+$/u;
const HEX = /^0[xX][0-9a-fA-F]*$/u;

function parsePart(part: string): number | null {
  if (DECIMAL.test(part)) {
    return Number(part);
  }
  if (OCTAL.test(part)) {
    return Number.parseInt(part.slice(1), 8);
  }
  if (HEX.test(part)) {
    return part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
  }
  return null;
}

/** glibc's exact `inet_aton()`: dotted quad, or `null` when invalid. */
export function inetAton(text: string): string | null {
  const parts = text.split('.');
  if (parts.length > 4) {
    return null;
  }
  const values: number[] = [];
  for (const part of parts) {
    const value = parsePart(part);
    if (value === null) {
      return null;
    }
    values.push(value);
  }
  const last = values.pop() ?? 0;
  if (values.some(value => value > 255)) {
    return null;
  }
  const lastBytes = 4 - values.length;
  if (last >= 2 ** (8 * lastBytes)) {
    return null;
  }
  const bytes = [...values];
  for (let index = lastBytes - 1; index >= 0; index -= 1) {
    bytes.push(Math.floor(last / 2 ** (8 * index)) % 256);
  }
  return bytes.join('.');
}

/**
 * The address maxminddb would look up for `ip`, or Python's `ValueError`
 * (`'<ip>' does not appear to be an IPv4 or IPv6 address.`) when it isn't one.
 * maxminddb's C extension quotes the text verbatim (no `repr()` escaping)
 * and rejects a NUL with a `TypeError` before parsing.
 */
export function numericHost(ip: string): string {
  if (ip.includes('\0')) {
    throw new PyTypeError('argument 1 contains an embedded null character');
  }
  const ipv4 = inetAton(ip);
  if (ipv4 !== null) {
    return ipv4;
  }
  if (isIPv6(ip)) {
    return ip;
  }
  throw new PyValueError(
    `'${ip}' does not appear to be an IPv4 or IPv6 address.`,
  );
}
