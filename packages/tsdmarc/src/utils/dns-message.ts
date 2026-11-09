// DNS wire format (RFC 1035) for the DNS over HTTPS and DNS over TLS
// transports: query encoding, response decoding, dnspython's response
// validation and CNAME chaining, and rdata text matching dnspython's
// `to_text()`.
//
// Encoding and decoding use dns-packet. dns-packet decodes labels as UTF-8
// and joins them with dots, so a label holding non-UTF-8 bytes or a literal
// dot (which dnspython would print as `\DDD` / `\.`) loses those details.
// Such names don't occur in practice; everything else (validation, CNAME
// chaining, dnspython's text forms) is unaffected.

import dnsPacket from 'dns-packet';

import {
  BadResponse,
  DNSException,
  DNSFormError,
  NoMetaqueries,
  UnknownRdatatype,
} from './dns-errors';
import { escapifyString, ipv6Aton, ipv6Ntoa, nameToText } from './dns-text';

/** Record types `queryDns()` supports, with their codes. */
export interface SupportedRdatatypes {
  readonly A: number;
  readonly NS: number;
  readonly CNAME: number;
  readonly SOA: number;
  readonly PTR: number;
  readonly MX: number;
  readonly TXT: number;
  readonly AAAA: number;
  readonly SRV: number;
  readonly CAA: number;
}

export const RDATATYPES: SupportedRdatatypes = Object.freeze({
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
});

/** Meta types dnspython refuses to query (`dns.rdatatype.is_metatype`). */
const METATYPES = new Set([
  'OPT',
  'TKEY',
  'TSIG',
  'IXFR',
  'AXFR',
  'MAILB',
  'MAILA',
  'ANY',
]);

export const RDATACLASS_IN = 1;
const RDATATYPE_OPT = 41;

const RCODE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
  6: 'YXDOMAIN',
  7: 'YXRRSET',
  8: 'NXRRSET',
  9: 'NOTAUTH',
  10: 'NOTZONE',
  16: 'BADVERS',
  23: 'BADCOOKIE',
});

export interface ResponseCodes {
  readonly NOERROR: number;
  readonly FORMERR: number;
  readonly SERVFAIL: number;
  readonly NXDOMAIN: number;
  readonly NOTIMP: number;
  readonly REFUSED: number;
  readonly YXDOMAIN: number;
}

export const RCODE: ResponseCodes = Object.freeze({
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
  YXDOMAIN: 6,
});

/** Text of a response code (`dns.rcode.to_text`). */
export function rcodeToText(rcode: number): string {
  return RCODE_NAMES[rcode] ?? String(rcode);
}

/** Text of a record type code (`dns.rdatatype.to_text`). */
export function rdatatypeToText(rdtype: number): string {
  for (const [name, code] of Object.entries(RDATATYPES)) {
    if (code === rdtype) {
      return name;
    }
  }
  return `TYPE${rdtype}`;
}

/**
 * The code of a record type given as text. Meta types raise
 * `NoMetaqueries`-style errors in dnspython; types this port cannot format
 * raise `UnknownRdatatype`.
 */
export function rdatatypeFromText(text: string): number {
  if (Object.hasOwn(RDATATYPES, text)) {
    return RDATATYPES[text as keyof SupportedRdatatypes];
  }
  if (METATYPES.has(text)) {
    throw new NoMetaqueries();
  }
  throw new UnknownRdatatype(
    `DNS resource record type is unknown or not supported: ${text}`,
  );
}

const FLAG_QR = 0x80_00;
const FLAG_RD = 0x01_00;
const OPCODE_SHIFT = 11;
const OPCODE_MASK = 0xf;
const RCODE_MASK = 0xf;
const HEADER_LENGTH = 12;
const EDNS_PAYLOAD = 1232;
const MAX_CHAIN = 16;

/** A name as wire labels; absolute names end with an empty label. */
export type WireName = Uint8Array[];

export interface DnsQuestion {
  name: WireName;
  rdtype: number;
  rdclass: number;
}

export interface DnsRecord {
  name: WireName;
  rdtype: number;
  rdclass: number;
  ttl: number;
  /** Rdata as dns-packet decodes it. */
  data: unknown;
}

export interface DnsMessage {
  id: number;
  flags: number;
  /** Full response code, including the EDNS extended bits. */
  rcode: number;
  question: DnsQuestion[];
  answer: DnsRecord[];
  authority: DnsRecord[];
  additional: DnsRecord[];
}

/** A query message, as dnspython's resolver builds it (RD set, EDNS0 with a 1232-byte payload). */
export interface DnsQuery {
  id: number;
  flags: number;
  question: DnsQuestion;
  wire: Uint8Array;
}

const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** dns-packet's name text (no trailing dot) from wire labels. */
function nameToPacketText(name: WireName): string {
  const labels = name.filter(label => label.length > 0);
  return labels.length === 0 ? '.' : labels.map(l => utf8.decode(l)).join('.');
}

/**
 * Wire labels from a name as dns-packet decodes it. With `mail`, dots
 * escaped as `\.` (SOA rname) stay inside their label.
 */
function nameFromPacketText(text: string, mail = false): WireName {
  const labels: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (mail && char === '\\' && text.charAt(index + 1) === '.') {
      current += '.';
      index += 1;
    } else if (char === '.') {
      labels.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  labels.push(current);
  const wire = labels
    .filter(label => label !== '')
    .map(label => utf8Encoder.encode(label));
  wire.push(new Uint8Array(0));
  return wire;
}

const CLASS_CODES: Readonly<Record<string, number>> = Object.freeze({
  ANY: 255,
  CH: 3,
  CS: 2,
  HS: 4,
  IN: 1,
});

function classCode(value: string | undefined): number {
  if (value === undefined) {
    return RDATACLASS_IN;
  }
  return CLASS_CODES[value] ?? Number(value.replace(/^UNKNOWN_/u, ''));
}

function typeCode(value: string): number {
  if (Object.hasOwn(RDATATYPES, value)) {
    return RDATATYPES[value as keyof SupportedRdatatypes];
  }
  if (value === 'OPT') {
    return RDATATYPE_OPT;
  }
  const match = /^UNKNOWN_(?<code>\d+)$/u.exec(value);
  return match?.groups ? Number(match.groups.code) : -1;
}

/** Build a query (`dns.message.make_query` plus `use_edns(0, 0, 1232)`). */
export function makeQuery(
  name: WireName,
  rdtype: number,
  id: number,
): DnsQuery {
  const flags = FLAG_RD;
  const wire = dnsPacket.encode({
    additionals: [
      {
        ednsVersion: 0,
        extendedRcode: 0,
        flag_do: false,
        flags: 0,
        name: '.',
        options: [],
        type: 'OPT',
        udpPayloadSize: EDNS_PAYLOAD,
      },
    ],
    flags,
    id,
    questions: [
      {
        class: 'IN',
        name: nameToPacketText(name),
        type: rdatatypeToText(rdtype) as dnsPacket.RecordType,
      },
    ],
    type: 'query',
  });
  return {
    flags,
    id,
    question: { name, rdclass: RDATACLASS_IN, rdtype },
    wire: new Uint8Array(wire),
  };
}

function toRecords(
  answers: readonly dnsPacket.Answer[] | undefined,
): DnsRecord[] {
  return (answers ?? []).map(answer => {
    const record = answer as unknown as {
      name: string;
      type: string;
      class?: string;
      ttl?: number;
      data?: unknown;
      udpPayloadSize?: number;
    };
    const rdtype = typeCode(record.type);
    const mail = rdtype === RDATATYPES.SOA;
    return {
      data: mail ? { ...(record.data as object), mail } : record.data,
      name: nameFromPacketText(record.name),
      // An OPT record's class field carries the EDNS payload size.
      rdclass:
        rdtype === RDATATYPE_OPT
          ? (record.udpPayloadSize ?? 0)
          : classCode(record.class),
      rdtype,
      ttl: record.ttl ?? 0,
    };
  });
}

/** Decode a message (`dns.message.from_wire`). Raises `DNSFormError` when malformed. */
export function decodeMessage(bytes: Uint8Array): DnsMessage {
  if (bytes.length < HEADER_LENGTH) {
    throw new DNSFormError(
      'The DNS packet passed to from_wire() is too short.',
    );
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let packet: dnsPacket.DecodedPacket;
  try {
    packet = dnsPacket.decode(buffer);
  } catch (error) {
    throw new DNSFormError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const consumed = (dnsPacket.decode as unknown as { bytes: number }).bytes;
  if (consumed !== bytes.length) {
    throw new DNSFormError(
      'The DNS packet passed to from_wire() has extra junk at the end of it.',
    );
  }
  const id = buffer.readUInt16BE(0);
  const flags = buffer.readUInt16BE(2);
  const question: DnsQuestion[] = (packet.questions ?? []).map(q => ({
    name: nameFromPacketText(q.name),
    rdclass: classCode(q.class),
    rdtype: typeCode(q.type),
  }));
  const answer = toRecords(packet.answers);
  const authority = toRecords(packet.authorities);
  const additional = toRecords(packet.additionals);
  let rcode = flags & RCODE_MASK;
  const opt = (packet.additionals ?? []).find(
    record => record.type === 'OPT',
  ) as { extendedRcode?: number } | undefined;
  if (opt !== undefined) {
    rcode |= (opt.extendedRcode ?? 0) << 4;
  }
  return { additional, answer, authority, flags, id, question, rcode };
}

function labelsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const lower = (byte: number): number =>
    byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  return a.every((byte, index) => lower(byte) === lower(b[index] as number));
}

/** Case-insensitive name comparison, like dnspython's `Name.__eq__`. */
export function namesEqual(a: WireName, b: WireName): boolean {
  return (
    a.length === b.length &&
    a.every((label, index) => labelsEqual(label, b[index] as Uint8Array))
  );
}

function questionsEqual(a: DnsQuestion, b: DnsQuestion): boolean {
  return (
    a.rdtype === b.rdtype &&
    a.rdclass === b.rdclass &&
    namesEqual(a.name, b.name)
  );
}

/** Whether `response` answers `query` (`dns.message.Message.is_response`). */
export function isResponse(query: DnsQuery, response: DnsMessage): boolean {
  const opcode = (flags: number): number =>
    (flags >> OPCODE_SHIFT) & OPCODE_MASK;
  if (
    (response.flags & FLAG_QR) === 0 ||
    query.id !== response.id ||
    opcode(query.flags) !== opcode(response.flags)
  ) {
    return false;
  }
  const noQuestionAllowed = [
    RCODE.FORMERR,
    RCODE.SERVFAIL,
    RCODE.NOTIMP,
    RCODE.REFUSED,
  ];
  if (
    noQuestionAllowed.includes(response.rcode) &&
    response.question.length === 0
  ) {
    return true;
  }
  return (
    response.question.some(q => questionsEqual(q, query.question)) &&
    response.question.every(q => questionsEqual(q, query.question))
  );
}

/** Raise `BadResponse` unless `response` answers `query`. */
export function checkResponse(query: DnsQuery, response: DnsMessage): void {
  if (!isResponse(query, response)) {
    throw new BadResponse();
  }
}

function nameData(value: unknown): WireName {
  return nameFromPacketText(typeof value === 'string' ? value : '');
}

/** The target of a CNAME record. */
function cnameTarget(record: DnsRecord): WireName {
  return nameData(record.data);
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return utf8Encoder.encode(String(value ?? ''));
}

/** Text form of a record's rdata, like dnspython's `Rdata.to_text()`. */
export function rdataToText(record: DnsRecord): string {
  const data = record.data as Record<string, unknown>;
  switch (record.rdtype) {
    case RDATATYPES.A: {
      return String(record.data);
    }
    case RDATATYPES.AAAA: {
      return ipv6Ntoa(ipv6Aton(String(record.data)));
    }
    case RDATATYPES.CNAME:
    case RDATATYPES.NS:
    case RDATATYPES.PTR: {
      return nameToText(nameData(record.data));
    }
    case RDATATYPES.MX: {
      return `${String(data.preference)} ${nameToText(nameData(data.exchange))}`;
    }
    case RDATATYPES.SOA: {
      const mname = nameToText(nameData(data.mname));
      const rname = nameToText(
        nameFromPacketText(String(data.rname ?? ''), true),
      );
      const numbers = [
        data.serial,
        data.refresh,
        data.retry,
        data.expire,
        data.minimum,
      ].map(String);
      return [mname, rname, ...numbers].join(' ');
    }
    case RDATATYPES.SRV: {
      return `${String(data.priority)} ${String(data.weight)} ${String(data.port)} ${nameToText(nameData(data.target))}`;
    }
    case RDATATYPES.TXT: {
      const strings = Array.isArray(record.data) ? record.data : [record.data];
      return strings
        .map(value => `"${escapifyString(bytesOf(value))}"`)
        .join(' ');
    }
    case RDATATYPES.CAA: {
      return `${String(data.flags)} ${escapifyString(bytesOf(data.tag))} "${escapifyString(bytesOf(data.value))}"`;
    }
    default: {
      // dnspython's generic rdata form
      const raw = bytesOf(record.data);
      return `\\# ${raw.length} ${Buffer.from(raw).toString('hex')}`;
    }
  }
}

/** Question text as dnspython prints a question RRset (`example.com. IN TXT`). */
export function questionToText(question: DnsQuestion): string {
  const rdclass =
    question.rdclass === RDATACLASS_IN ? 'IN' : `CLASS${question.rdclass}`;
  return `${nameToText(question.name)} ${rdclass} ${rdatatypeToText(question.rdtype)}`;
}

function findRecords(
  records: readonly DnsRecord[],
  name: WireName,
  rdclass: number,
  rdtype: number,
): DnsRecord[] {
  return records.filter(
    record =>
      record.rdtype === rdtype &&
      record.rdclass === rdclass &&
      namesEqual(record.name, name),
  );
}

/**
 * The answer records of a response, following CNAMEs from the question
 * name (`dns.message.Message.resolve_chaining`). Returns `null` when the
 * response has no answer for the question. Duplicate rdata is dropped, as
 * dnspython's rdatasets do.
 */
export function resolveChaining(response: DnsMessage): DnsRecord[] | null {
  if ((response.flags & FLAG_QR) === 0) {
    throw new DNSException('The DNS message is not a response to a query.');
  }
  const [question] = response.question;
  if (question === undefined || response.question.length !== 1) {
    throw new DNSFormError();
  }
  let qname = question.name;
  let answer: DnsRecord[] | null = null;
  let count = 0;
  while (count < MAX_CHAIN) {
    const found = findRecords(
      response.answer,
      qname,
      question.rdclass,
      question.rdtype,
    );
    if (found.length > 0) {
      answer = found;
      break;
    }
    if (question.rdtype === RDATATYPES.CNAME) {
      break;
    }
    const [cname] = findRecords(
      response.answer,
      qname,
      question.rdclass,
      RDATATYPES.CNAME,
    );
    if (cname === undefined) {
      break;
    }
    qname = cnameTarget(cname);
    count += 1;
  }
  if (count >= MAX_CHAIN) {
    throw new DNSException('The CNAME chain is too long.');
  }
  if (response.rcode === RCODE.NXDOMAIN && answer !== null) {
    throw new DNSException('The rcode is NXDOMAIN but an answer was found.');
  }
  if (answer === null) {
    return null;
  }
  const seen = new Set<string>();
  const unique: DnsRecord[] = [];
  for (const record of answer) {
    const key = rdataKey(record);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(record);
    }
  }
  return unique;
}

const NAME_TYPES = new Set<number>([
  RDATATYPES.CNAME,
  RDATATYPES.NS,
  RDATATYPES.PTR,
  RDATATYPES.MX,
  RDATATYPES.SOA,
  RDATATYPES.SRV,
]);

/** Identity of a record's rdata: names compare case-insensitively. */
function rdataKey(record: DnsRecord): string {
  const text = rdataToText(record);
  return NAME_TYPES.has(record.rdtype) ? text.toLowerCase() : text;
}

/** A random 16-bit message ID. */
export function randomMessageId(): number {
  return crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
}
