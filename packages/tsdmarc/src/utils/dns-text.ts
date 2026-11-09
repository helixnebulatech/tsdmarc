// Text forms used by DNS: IP addresses, domain names and quoted strings,
// ported from dnspython (`dns.ipv4`, `dns.ipv6`, `dns.inet`, `dns.name`,
// `dns.rdata._escapify`, `dns.reversename`) so parsed answers print exactly
// like dnspython's `to_text()`.

import { domainToASCII } from 'node:url';

import {
  BadEscape,
  DNSSyntaxError,
  EmptyLabel,
  IDNAException,
  LabelTooLong,
  NameTooLong,
} from './dns-errors';
import { IDNA_CONTEXTJ, IDNA_CONTEXTO, IDNA_PVALID } from './idna-data';
import { pyRepr } from './py-str';

const IPV4_LENGTH = 4;
const IPV6_LENGTH = 16;
const IPV6_CHUNKS = 8;
const MAX_LABEL_LENGTH = 63;
const MAX_NAME_LENGTH = 255;
const MAX_BYTE = 255;
const PRINTABLE_LOW = 0x20;
const PRINTABLE_HIGH = 0x7f;

const DIGITS_RE = /^[0-9]+$/u;
const HEX_RE = /^[0-9a-fA-F]*$/u;
const V4_ENDING_RE = /^(.*):(\d+\.\d+\.\d+\.\d+)$/su;
const LEADING_ZEROS_RE = /^0+(?=.)/u;

/** Convert an IPv4 address to its 4 bytes (`dns.ipv4.inet_aton`). */
export function ipv4Aton(text: string): Uint8Array {
  const parts = text.split('.');
  if (parts.length !== IPV4_LENGTH) {
    throw new DNSSyntaxError();
  }
  const bytes = new Uint8Array(IPV4_LENGTH);
  for (const [index, part] of parts.entries()) {
    if (!DIGITS_RE.test(part)) {
      throw new DNSSyntaxError();
    }
    // No leading zeros
    if (part.length > 1 && part.startsWith('0')) {
      throw new DNSSyntaxError();
    }
    const value = Number(part);
    if (value > MAX_BYTE) {
      throw new DNSSyntaxError();
    }
    bytes[index] = value;
  }
  return bytes;
}

/** Convert 4 bytes to an IPv4 address (`dns.ipv4.inet_ntoa`). */
export function ipv4Ntoa(bytes: Uint8Array): string {
  if (bytes.length !== IPV4_LENGTH) {
    throw new DNSSyntaxError();
  }
  return [...bytes].join('.');
}

/**
 * Convert an IPv6 address to its 16 bytes (`dns.ipv6.inet_aton`). With
 * `ignoreScope`, a `%scope` suffix is dropped instead of rejected.
 */
export function ipv6Aton(input: string, ignoreScope = false): Uint8Array {
  let text = input;
  if (ignoreScope) {
    const parts = text.split('%');
    if (parts.length === 2) {
      [text] = parts as [string, string];
    } else if (parts.length > 2) {
      throw new DNSSyntaxError();
    }
  }
  if (text === '') {
    throw new DNSSyntaxError();
  }
  if (text.endsWith(':') && !text.endsWith('::')) {
    throw new DNSSyntaxError();
  }
  if (text.startsWith(':') && !text.startsWith('::')) {
    throw new DNSSyntaxError();
  }
  if (text === '::') {
    text = '0::';
  }
  // Get rid of the dot-quad syntax if we have it.
  const v4 = V4_ENDING_RE.exec(text);
  if (v4 !== null) {
    const b = ipv4Aton(v4[2] as string);
    const hex = (value: number): string => value.toString(16).padStart(2, '0');
    text = `${v4[1]}:${hex(b[0] as number)}${hex(b[1] as number)}:${hex(b[2] as number)}${hex(b[3] as number)}`;
  }
  // Turn '::<whatever>' into ':<whatever>', or '<whatever>::' into '<whatever>:'
  if (text.startsWith('::')) {
    text = text.slice(1);
  } else if (text.endsWith('::')) {
    text = text.slice(0, -1);
  }
  const chunks = text.split(':');
  if (chunks.length > IPV6_CHUNKS) {
    throw new DNSSyntaxError();
  }
  let seenEmpty = false;
  const canonical: string[] = [];
  for (const chunk of chunks) {
    if (chunk === '') {
      if (seenEmpty) {
        throw new DNSSyntaxError();
      }
      seenEmpty = true;
      for (let i = 0; i < IPV6_CHUNKS - chunks.length + 1; i += 1) {
        canonical.push('0000');
      }
    } else {
      if (chunk.length > 4) {
        throw new DNSSyntaxError();
      }
      canonical.push(chunk.padStart(4, '0'));
    }
  }
  if (chunks.length < IPV6_CHUNKS && !seenEmpty) {
    throw new DNSSyntaxError();
  }
  const hex = canonical.join('');
  if (!HEX_RE.test(hex) || hex.length !== IPV6_LENGTH * 2) {
    throw new DNSSyntaxError();
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Convert 16 bytes to an IPv6 address (`dns.ipv6.inet_ntoa`). */
export function ipv6Ntoa(bytes: Uint8Array): string {
  if (bytes.length !== IPV6_LENGTH) {
    throw new RangeError('IPv6 addresses are 16 bytes long');
  }
  const hex = Buffer.from(bytes).toString('hex');
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    chunks.push(hex.slice(i, i + 4).replace(LEADING_ZEROS_RE, ''));
  }
  // Compress the longest run of 0-value chunks to ::
  let bestStart = 0;
  let bestLength = 0;
  let start = -1;
  let lastWasZero = false;
  for (let i = 0; i < IPV6_CHUNKS; i += 1) {
    if (chunks[i] !== '0') {
      if (lastWasZero) {
        if (i - start > bestLength) {
          bestStart = start;
          bestLength = i - start;
        }
        lastWasZero = false;
      }
    } else if (!lastWasZero) {
      start = i;
      lastWasZero = true;
    }
  }
  if (lastWasZero && IPV6_CHUNKS - start > bestLength) {
    bestStart = start;
    bestLength = IPV6_CHUNKS - start;
  }
  if (bestLength <= 1) {
    return chunks.join(':');
  }
  const embeddedV4 =
    bestStart === 0 &&
    (bestLength === 6 || (bestLength === 5 && chunks[5] === 'ffff'));
  if (embeddedV4) {
    const prefix = bestLength === 6 ? '::' : '::ffff:';
    return prefix + ipv4Ntoa(bytes.subarray(12));
  }
  return `${chunks.slice(0, bestStart).join(':')}::${chunks.slice(bestStart + bestLength).join(':')}`;
}

/** Whether `text` is an IPv4 or IPv6 address (`dns.inet.is_address`). */
export function isAddress(text: string): boolean {
  try {
    ipv4Aton(text);
    return true;
  } catch {
    try {
      ipv6Aton(text, true);
      return true;
    } catch {
      return false;
    }
  }
}

const NAME_ESCAPED = new Set([...'"().;\\@$'].map(c => c.charCodeAt(0)));
const STRING_ESCAPED = new Set([...'"\\'].map(c => c.charCodeAt(0)));

function decimalEscape(byte: number): string {
  return `\\${byte.toString().padStart(3, '0')}`;
}

/** Escape one wire-format label for text (`dns.name._escapify`). */
export function escapifyLabel(label: Uint8Array): string {
  let text = '';
  for (const byte of label) {
    if (NAME_ESCAPED.has(byte)) {
      text += `\\${String.fromCharCode(byte)}`;
    } else if (byte > PRINTABLE_LOW && byte < PRINTABLE_HIGH) {
      text += String.fromCharCode(byte);
    } else {
      text += decimalEscape(byte);
    }
  }
  return text;
}

/** Escape a character-string for quoting (`dns.rdata._escapify`). */
export function escapifyString(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    if (STRING_ESCAPED.has(byte)) {
      text += `\\${String.fromCharCode(byte)}`;
    } else if (byte >= PRINTABLE_LOW && byte < PRINTABLE_HIGH) {
      text += String.fromCharCode(byte);
    } else {
      text += decimalEscape(byte);
    }
  }
  return text;
}

/**
 * Text form of a name given as wire labels (`dns.name.Name.to_text`). An
 * absolute name ends with an empty label and prints with a final dot.
 */
export function nameToText(labels: readonly Uint8Array[]): string {
  if (labels.length === 0) {
    return '@';
  }
  if (labels.length === 1 && labels[0]?.length === 0) {
    return '.';
  }
  return labels.map(label => escapifyLabel(label)).join('.');
}

const LABEL_SEPARATORS = new Set(['.', '。', '．', '｡']);
const MAX_ASCII = 0x7f;

function isAscii(text: string): boolean {
  return [...text].every(c => c.charCodeAt(0) <= MAX_ASCII);
}

function inRanges(ranges: readonly number[], codePoint: number): boolean {
  // Binary search over sorted [start, end) pairs.
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = ranges[middle * 2] as number;
    const end = ranges[middle * 2 + 1] as number;
    if (codePoint < start) {
      high = middle - 1;
    } else if (codePoint >= end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

const GREEK_RE = /^\p{Script=Greek}$/u;
const HEBREW_RE = /^\p{Script=Hebrew}$/u;
const KANA_HAN_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]$/u;
const KATAKANA_MIDDLE_DOT = '・';
const ARABIC_INDIC: readonly [number, number] = [0x6_60, 0x6_6a];
const EXTENDED_ARABIC_INDIC: readonly [number, number] = [0x6_f0, 0x6_fa];

function hasCodePointIn(
  chars: readonly string[],
  [start, end]: readonly [number, number],
): boolean {
  return chars.some(c => {
    const cp = c.codePointAt(0) as number;
    return cp >= start && cp < end;
  });
}

/** idna's `valid_contexto` (RFC 5892 appendix A). */
function validContexto(chars: readonly string[], pos: number): boolean {
  const cp = chars[pos]?.codePointAt(0) as number;
  const previous = chars[pos - 1] ?? '';
  const next = chars[pos + 1] ?? '';
  switch (cp) {
    case 0xb7: {
      return previous === 'l' && next === 'l';
    }
    case 0x3_75: {
      return GREEK_RE.test(next);
    }
    case 0x5_f3:
    case 0x5_f4: {
      return HEBREW_RE.test(previous);
    }
    case 0x30_fb: {
      return chars.some(c => c !== KATAKANA_MIDDLE_DOT && KANA_HAN_RE.test(c));
    }
    default: {
      if (cp >= ARABIC_INDIC[0] && cp < ARABIC_INDIC[1]) {
        return !hasCodePointIn(chars, EXTENDED_ARABIC_INDIC);
      }
      if (cp >= EXTENDED_ARABIC_INDIC[0] && cp < EXTENDED_ARABIC_INDIC[1]) {
        return !hasCodePointIn(chars, ARABIC_INDIC);
      }
      return false;
    }
  }
}

function codePointName(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The per-code-point part of idna's `check_label` (IDNA 2008, RFC 5892),
 * with idna's messages. UTS 46 (`domainToASCII`) accepts code points IDNA
 * 2008 disallows, such as emoji and symbols. Joiners are left to
 * `domainToASCII`, which applies the same CONTEXTJ rules.
 */
function checkIdna2008Label(label: string): void {
  const chars = [...label];
  for (const [pos, c] of chars.entries()) {
    const cp = c.codePointAt(0) as number;
    if (inRanges(IDNA_PVALID, cp) || inRanges(IDNA_CONTEXTJ, cp)) {
      continue;
    }
    if (inRanges(IDNA_CONTEXTO, cp)) {
      if (!validContexto(chars, pos)) {
        throw new IDNAException(
          `Codepoint ${codePointName(cp)} not allowed at position ${pos + 1} in ${pyRepr(label)}`,
        );
      }
      continue;
    }
    throw new IDNAException(
      `Codepoint ${codePointName(cp)} at position ${pos + 1} of ${pyRepr(label)} not allowed`,
    );
  }
}

/** The idna message for a joiner `domainToASCII` rejected, if there is one. */
function joinerFailure(label: string): string | null {
  const chars = [...label];
  const pos = chars.findIndex(c =>
    inRanges(IDNA_CONTEXTJ, c.codePointAt(0) as number),
  );
  if (pos === -1) {
    return null;
  }
  const cp = chars[pos]?.codePointAt(0) as number;
  return `Joiner ${codePointName(cp)} not allowed at position ${pos + 1} in ${pyRepr(label)}`;
}

function encodeLabel(label: string): Uint8Array {
  if (label === '') {
    return new Uint8Array();
  }
  let ascii = label;
  if (!isAscii(label)) {
    // dnspython encodes non-ASCII labels with IDNA 2008 after the UTS 46
    // mapping (non-transitional). `domainToASCII` does that mapping and the
    // joiner/bidi checks; the code point classes are checked here, on an
    // approximation of the mapped label (NFKC + lowercase), to raise
    // idna's errors for what UTS 46 alone accepts (emoji, symbols).
    const mapped = label.normalize('NFKC').toLowerCase().normalize('NFC');
    if (!isAscii(mapped)) {
      checkIdna2008Label(mapped);
    }
    ascii = domainToASCII(label);
    if (ascii === '') {
      // Bidi-rule and other failures: idna's exact text is not reproduced.
      throw new IDNAException(
        joinerFailure(mapped) ?? `Invalid label ${pyRepr(mapped)}`,
      );
    }
  }
  const encoded = Buffer.from(ascii, 'latin1');
  if (encoded.length > MAX_LABEL_LENGTH) {
    throw new LabelTooLong();
  }
  return Uint8Array.from(encoded);
}

function validateLabels(labels: readonly Uint8Array[]): void {
  let total = 0;
  for (const [index, label] of labels.entries()) {
    if (label.length > MAX_LABEL_LENGTH) {
      throw new LabelTooLong();
    }
    if (label.length === 0 && index !== labels.length - 1) {
      throw new EmptyLabel();
    }
    total += label.length + 1;
  }
  if (total > MAX_NAME_LENGTH) {
    throw new NameTooLong();
  }
}

/**
 * Parse a name in text form into absolute wire labels
 * (`dns.name.from_text(text)` made absolute, as the resolver does).
 */
export function nameFromText(text: string): Uint8Array[] {
  const labels: Uint8Array[] = [];
  if (LABEL_SEPARATORS.has(text)) {
    return [new Uint8Array()];
  }
  const source = text === '@' ? '' : text;
  // Bytes from \DDD escapes are kept as raw bytes; other text is encoded.
  let label: number[] = [];
  let pending = '';
  const flush = (): void => {
    if (pending !== '') {
      label.push(...encodeLabel(pending));
      pending = '';
    }
  };
  const chars = [...source];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    if (c === '\\') {
      const next = chars[i + 1];
      if (next === undefined) {
        throw new BadEscape();
      }
      if (DIGITS_RE.test(next)) {
        const digits = chars.slice(i + 1, i + 4).join('');
        if (!/^[0-9]{3}$/u.test(digits) || Number(digits) > MAX_BYTE) {
          throw new BadEscape();
        }
        flush();
        label.push(Number(digits));
        i += 3;
      } else {
        pending += next;
        i += 1;
      }
    } else if (LABEL_SEPARATORS.has(c)) {
      flush();
      if (label.length === 0) {
        throw new EmptyLabel();
      }
      labels.push(Uint8Array.from(label));
      label = [];
    } else {
      pending += c;
    }
  }
  flush();
  if (label.length > 0) {
    labels.push(Uint8Array.from(label));
  }
  // Relative names are made absolute (the resolver appends the root).
  labels.push(new Uint8Array());
  validateLabels(labels);
  return labels;
}

const MAPPED_PREFIX_LENGTH = 10;

function isMapped(address: Uint8Array): boolean {
  return (
    address.subarray(0, MAPPED_PREFIX_LENGTH).every(byte => byte === 0) &&
    address[10] === MAX_BYTE &&
    address[11] === MAX_BYTE
  );
}

/**
 * Reverse-map domain name of an IP address, with the final dot
 * (`str(dns.reversename.from_address(text))`). Raises `DNSSyntaxError` for
 * text that is not an IP address.
 */
export function reverseNameFromAddress(text: string): string {
  let parts: string[];
  let origin: string;
  try {
    const v6 = ipv6Aton(text);
    if (isMapped(v6)) {
      parts = [...v6.subarray(12)].map(String);
      origin = 'in-addr.arpa.';
    } else {
      parts = [...Buffer.from(v6).toString('hex')];
      origin = 'ip6.arpa.';
    }
  } catch {
    parts = [...ipv4Aton(text)].map(String);
    origin = 'in-addr.arpa.';
  }
  return `${parts.reverse().join('.')}.${origin}`;
}
