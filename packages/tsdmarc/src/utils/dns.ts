// DNS queries, ported from parsedmarc/utils.py (`query_dns`,
// `get_reverse_dns`, `_nameservers_to_resolver_input`,
// `_parse_dot_nameserver`, `_SessionDoHNameserver`) together with the parts
// of dnspython's stub resolver that parsedmarc relies on: nameserver
// failover in the configured order, the per-query timeout within an overall
// lifetime, the back-off between rounds, which failures take a nameserver
// out of the mix, and the errors raised.
//
// Transports:
// - an IP address: plain DNS through `node:dns` (c-ares), one server per
//   attempt so the failover logic stays here; scoped IPv6 addresses (and
//   TXT/CAA on Bun) go out as wire-format UDP/TCP with `node:dgram`;
// - `https://...`: DNS over HTTPS (RFC 8484) with `fetch`, POST like
//   dnspython's default;
// - `tls://ip[:port][#hostname]`: DNS over TLS (RFC 7858) with `node:tls`.
//
// Answers print like dnspython's `rdata.to_text()`; `queryDns()` then
// applies parsedmarc's `.replace('"', '').rstrip('.')`.

import { createSocket, type RemoteInfo } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { connect as netConnect, isIPv6, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  connect,
  checkServerIdentity,
  type ConnectionOptions,
  type PeerCertificate,
} from 'node:tls';

import type { ExpiringDict } from '../config';
import { DEFAULT_DNS_MAX_RETRIES, DEFAULT_DNS_TIMEOUT } from '../constants';
import { logger } from '../log';
import {
  DNSException,
  DNSFormError,
  DNSTimeout,
  LifetimeTimeout,
  NoAnswer,
  NoNameservers,
  NXDOMAIN,
  YXDOMAIN,
  type ResolutionError,
} from './dns-errors';
import {
  checkResponse,
  decodeMessage,
  isResponse,
  makeQuery,
  RCODE,
  RDATACLASS_IN,
  randomMessageId,
  rcodeToText,
  rdataToText,
  rdatatypeFromText,
  questionToText,
  resolveChaining,
  type DnsMessage,
  type DnsQuery,
  type WireName,
} from './dns-message';
import {
  escapifyString,
  ipv6Aton,
  ipv6Ntoa,
  isAddress,
  nameFromText,
  nameToText,
  reverseNameFromAddress,
} from './dns-text';
import { readBody, splitUrlCredentials } from './http';
import { pyRStrip } from './py-str';
import { maskNameserverSecrets, redactUrlCredentials } from './redact';
import { sanitizeForLog } from './sanitize';
import { type SplitUrl, urlSplit } from './url-split';

/** Cache of `queryDns()` answers, keyed `<domain>_<TYPE>`. */
export type DnsCache = ExpiringDict<string, string[]>;

/** Cloudflare's public resolvers, used when no nameservers are configured. */
export const DEFAULT_NAMESERVERS: readonly string[] = Object.freeze([
  '1.1.1.1',
  '1.0.0.1',
  '2606:4700:4700::1111',
  '2606:4700:4700::1001',
]);

const DO53_PORT = 53;
const DOT_PORT = 853;
const DOH_PORT = 443;
const MAX_MESSAGE_BYTES = 65_535;
const LENGTH_PREFIX_BYTES = 2;
const MAX_PER_QUERY_TIMEOUT = 1.0;
const INITIAL_BACKOFF = 0.1;
const MAX_BACKOFF = 2;
const MS_PER_SECOND = 1000;
/** The TC (truncated) header flag. */
const FLAG_TC = 0x02_00;
const IS_BUN = typeof process.versions.bun === 'string';
/** Types whose rdata holds byte strings printed with `\DDD` escapes. */
const BYTE_STRING_RDTYPES: ReadonlySet<string> = new Set(['TXT', 'CAA']);

/**
 * A malformed nameserver entry: Python's `ValueError`, raised by
 * parsedmarc's nameserver parsing and dnspython's `Resolver.nameservers`.
 * `name` is `ValueError` so messages that print the error type (the CLI's
 * DNS pre-flight check) match parsedmarc's; it is a `RangeError` for
 * callers that catch the built-in type.
 */
export class InvalidNameserverError extends RangeError {
  override name = 'ValueError';
}

/**
 * A socket-level failure (Python's `OSError`): connection refused, network
 * unreachable, TLS handshake failure. dnspython takes the nameserver out of
 * the mix, and parsedmarc retries the whole query on it.
 */
export class DNSSocketError extends Error {
  override name = 'DNSSocketError';
  /** The Node error code (`ECONNREFUSED`, ...), when known. */
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

/** A question to send: the absolute name and the record type. */
export interface DnsRequest {
  name: WireName;
  rdtype: number;
  /** The type as text (`TXT`). */
  rdtypeText: string;
}

/** What one nameserver said about one question. */
export type NameserverOutcome =
  | { kind: 'answer'; records: string[] }
  | { kind: 'nxdomain' }
  | { kind: 'noanswer' }
  | { kind: 'rcode'; rcode: number }
  | { kind: 'invalid'; error: unknown };

/** A configured nameserver (dnspython's `dns.nameserver.Nameserver`). */
export abstract class Nameserver {
  abstract kind(): string;
  abstract toString(): string;
  /** The port answers come from. */
  abstract answerPort(): number;
  /** Whether every query uses a stream transport (no UDP truncation). */
  isAlwaysMaxSize(): boolean {
    return false;
  }
  /** Ask one question. Transport failures throw; DNS-level results are returned. */
  abstract query(
    request: DnsRequest,
    timeout: number,
  ): Promise<NameserverOutcome>;
}

/** Records to text with duplicates removed, like a dnspython rdataset. */
function uniqueRecords(
  texts: readonly string[],
  caseInsensitive: boolean,
): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const text of texts) {
    const key = caseInsensitive ? text.toLowerCase() : text;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(text);
    }
  }
  return unique;
}

/** A name as c-ares prints it, made absolute like dnspython prints it. */
function absoluteName(name: string): string {
  if (name === '' || name.endsWith('.')) {
    return name === '' ? '.' : name;
  }
  return `${name}.`;
}

/** Text of a TXT/CAA string node:dns returned (c-ares gives one char per byte). */
function quotedString(value: string): string {
  return `"${escapifyString(Uint8Array.from(Buffer.from(value, 'latin1')))}"`;
}

interface MxRecord {
  priority: number;
  exchange: string;
}
interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  name: string;
}
interface SoaRecord {
  nsname: string;
  hostmaster: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minttl: number;
}
interface CaaRecord {
  critical: number;
  [tag: string]: string | number;
}

function caaToText(record: CaaRecord): string {
  const tag = Object.keys(record).find(key => key !== 'critical') ?? '';
  return `${record.critical} ${tag} ${quotedString(String(record[tag] ?? ''))}`;
}

/** Format what `Resolver.resolve()` returned as dnspython's rdata text. */
function nodeRecordsToText(rdtype: string, result: unknown): string[] {
  switch (rdtype) {
    case 'A': {
      return uniqueRecords(result as string[], false);
    }
    case 'AAAA': {
      return uniqueRecords(
        (result as string[]).map(address => ipv6Ntoa(ipv6Aton(address))),
        false,
      );
    }
    case 'CNAME':
    case 'NS':
    case 'PTR': {
      return uniqueRecords((result as string[]).map(absoluteName), true);
    }
    case 'MX': {
      return uniqueRecords(
        (result as MxRecord[]).map(
          mx => `${mx.priority} ${absoluteName(mx.exchange)}`,
        ),
        true,
      );
    }
    case 'SRV': {
      return uniqueRecords(
        (result as SrvRecord[]).map(
          srv =>
            `${srv.priority} ${srv.weight} ${srv.port} ${absoluteName(srv.name)}`,
        ),
        true,
      );
    }
    case 'SOA': {
      const soa = result as SoaRecord;
      return [
        [
          absoluteName(soa.nsname),
          absoluteName(soa.hostmaster),
          soa.serial,
          soa.refresh,
          soa.retry,
          soa.expire,
          soa.minttl,
        ].join(' '),
      ];
    }
    case 'TXT': {
      return uniqueRecords(
        (result as string[][]).map(chunks =>
          chunks.map(quotedString).join(' '),
        ),
        false,
      );
    }
    case 'CAA': {
      return uniqueRecords((result as CaaRecord[]).map(caaToText), false);
    }
    default: {
      throw new DNSException(`Unsupported record type ${rdtype}`);
    }
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : null;
  }
  return null;
}

const SOCKET_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by peer',
  EOF: 'Connection closed',
});

/** Plain DNS over UDP/TCP port 53 (dnspython's `Do53Nameserver`), through `node:dns`. */
export class Do53Nameserver extends Nameserver {
  readonly address: string;
  readonly port: number;

  constructor(address: string, port: number = DO53_PORT) {
    super();
    this.address = address;
    this.port = port;
  }

  kind(): string {
    return 'Do53';
  }

  toString(): string {
    return `${this.kind()}:${this.address}@${this.port}`;
  }

  answerPort(): number {
    return this.port;
  }

  /**
   * c-ares can't serve these like dnspython: it drops an IPv6 `%scope`
   * (dnspython sends to the scoped address), and Bun's c-ares binding
   * decodes TXT/CAA strings as UTF-8, losing the raw bytes the `\DDD`
   * escapes need. Those queries go out as wire-format UDP (TCP when
   * truncated), the way dnspython sends every Do53 query.
   */
  private usesWirePath(request: DnsRequest): boolean {
    return (
      this.address.includes('%') ||
      (IS_BUN && BYTE_STRING_RDTYPES.has(request.rdtypeText))
    );
  }

  private async queryWire(
    request: DnsRequest,
    timeoutMs: number,
  ): Promise<NameserverOutcome> {
    const deadline = Date.now() + timeoutMs;
    const query = buildQuery(request);
    let response = await udpExchange(query, this.address, this.port, timeoutMs);
    if ((response.flags & FLAG_TC) !== 0) {
      // dnspython raises Truncated and the resolver retries over TCP.
      const wire = await streamExchange(
        () => netConnect({ host: this.address, port: this.port }),
        'connect',
        query.wire,
        Math.max(1, deadline - Date.now()),
      );
      response = decodeMessage(wire);
      checkResponse(query, response);
    }
    return wireOutcome(response);
  }

  private server(): string {
    if (this.port === DO53_PORT) {
      return this.address;
    }
    return isIPv6(this.address)
      ? `[${this.address}]:${this.port}`
      : `${this.address}:${this.port}`;
  }

  async query(
    request: DnsRequest,
    timeout: number,
  ): Promise<NameserverOutcome> {
    const timeoutMs = Math.max(1, Math.ceil(timeout * MS_PER_SECOND));
    if (this.usesWirePath(request)) {
      return this.queryWire(request, timeoutMs);
    }
    // One try per attempt: the failover and lifetime logic is the
    // resolver's, as in dnspython. c-ares still retries over TCP when a UDP
    // answer is truncated.
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers([this.server()]);
    // Our own timer bounds the query at exactly `timeout`, like dnspython:
    // c-ares' timeout is per attempt and Bun rounds it up to whole seconds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        resolver.cancel();
        reject(new DNSTimeout());
      }, timeoutMs);
    });
    const name = nameToText(request.name).replace(/\.$/u, '');
    try {
      const result: unknown = await Promise.race([
        resolver.resolve(name, request.rdtypeText),
        timedOut,
      ]);
      return {
        kind: 'answer',
        records: nodeRecordsToText(request.rdtypeText, result),
      };
    } catch (error) {
      return mapNodeError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapNodeError(error: unknown): NameserverOutcome {
  const code = errorCode(error);
  switch (code) {
    case 'ENOTFOUND': {
      return { kind: 'nxdomain' };
    }
    case 'ENODATA': {
      return { kind: 'noanswer' };
    }
    case 'ESERVFAIL': {
      return { kind: 'rcode', rcode: RCODE.SERVFAIL };
    }
    case 'EREFUSED': {
      return { kind: 'rcode', rcode: RCODE.REFUSED };
    }
    case 'ENOTIMP': {
      return { kind: 'rcode', rcode: RCODE.NOTIMP };
    }
    case 'EFORMERR': {
      return { kind: 'rcode', rcode: RCODE.FORMERR };
    }
    case 'EBADRESP': {
      throw new DNSFormError();
    }
    case 'ETIMEOUT':
    case 'ECANCELLED': {
      throw new DNSTimeout();
    }
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EOF': {
      throw new DNSSocketError(SOCKET_ERROR_MESSAGES[code] ?? code, code);
    }
    default: {
      throw error;
    }
  }
}

/** Outcome of a wire-format response that passed `checkResponse()`. */
function wireOutcome(
  response: ReturnType<typeof decodeMessage>,
): NameserverOutcome {
  if (response.rcode === RCODE.NOERROR) {
    let records: ReturnType<typeof resolveChaining>;
    try {
      records = resolveChaining(response);
    } catch (error) {
      return { kind: 'invalid', error };
    }
    if (records === null) {
      return { kind: 'noanswer' };
    }
    return { kind: 'answer', records: records.map(rdataToText) };
  }
  if (response.rcode === RCODE.NXDOMAIN) {
    try {
      resolveChaining(response);
    } catch (error) {
      return { kind: 'invalid', error };
    }
    return { kind: 'nxdomain' };
  }
  return { kind: 'rcode', rcode: response.rcode };
}

function buildQuery(request: DnsRequest): DnsQuery {
  return makeQuery(request.name, request.rdtype, randomMessageId());
}

/**
 * DNS over HTTPS (parsedmarc's `_SessionDoHNameserver`). Queries go through
 * the global `fetch`, which pools connections across queries.
 *
 * No `verify` option: parsedmarc's queries go through its shared httpx
 * client, whose certificate verification is always on (dnspython ignores
 * the nameserver's `verify` when a session is given). `fetch` always
 * verifies too.
 */
export class DoHNameserver extends Nameserver {
  readonly url: string;
  /** POST (dnspython's default) unless true. */
  readonly wantGet: boolean;

  constructor(url: string, wantGet: boolean = false) {
    super();
    this.url = url;
    this.wantGet = wantGet;
  }

  kind(): string {
    return 'DoH';
  }

  toString(): string {
    return redactUrlCredentials(this.url);
  }

  answerPort(): number {
    return urlSplit(this.url).port() ?? DOH_PORT;
  }

  override isAlwaysMaxSize(): boolean {
    return true;
  }

  async query(
    request: DnsRequest,
    timeout: number,
  ): Promise<NameserverOutcome> {
    // fetch quotes a URL it can't parse, or one with credentials, in its
    // error, which ends up in the resolution error's text.
    if (!URL.canParse(this.url)) {
      throw new TypeError(`Invalid URL: ${this.toString()}`);
    }
    const query = buildQuery(request);
    const headers: Record<string, string> = {
      accept: 'application/dns-message',
    };
    const split = splitUrlCredentials(this.url);
    if (split.authorization !== null) {
      headers.authorization = split.authorization;
    }
    let target = split.url;
    let init: RequestInit;
    if (this.wantGet) {
      const encoded = Buffer.from(query.wire).toString('base64url');
      const separator = target.includes('?') ? '&' : '?';
      target = `${target}${separator}dns=${encoded}`;
      init = { method: 'GET', headers };
    } else {
      headers['content-type'] = 'application/dns-message';
      init = { method: 'POST', headers, body: query.wire };
    }
    let body: Uint8Array;
    try {
      const response = await fetch(target, {
        ...init,
        // httpx clients do not follow redirects; a 3xx fails below
        redirect: 'manual',
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(timeout * MS_PER_SECOND)),
        ),
      });
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel();
        throw new Error(
          `${this.toString()} responded with status code ${response.status}`,
        );
      }
      body = await readBody(response, MAX_MESSAGE_BYTES);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new DNSTimeout();
      }
      throw error;
    }
    const response = decodeMessage(body);
    checkResponse(query, response);
    return wireOutcome(response);
  }
}

/** DNS over TLS (dnspython's `DoTNameserver`), through `node:tls`. */
export class DoTNameserver extends Nameserver {
  readonly address: string;
  readonly port: number;
  /** TLS certificate identity (SNI and verification); `null` checks the chain only. */
  readonly hostname: string | null;

  constructor(
    address: string,
    port: number = DOT_PORT,
    hostname: string | null = null,
  ) {
    super();
    this.address = address;
    this.port = port;
    this.hostname = hostname;
  }

  kind(): string {
    return 'DoT';
  }

  toString(): string {
    return `${this.kind()}:${this.address}@${this.port}`;
  }

  answerPort(): number {
    return this.port;
  }

  override isAlwaysMaxSize(): boolean {
    return true;
  }

  async query(
    request: DnsRequest,
    timeout: number,
  ): Promise<NameserverOutcome> {
    const query = buildQuery(request);
    const wire = await this.exchange(query.wire, timeout);
    const response = decodeMessage(wire);
    checkResponse(query, response);
    return wireOutcome(response);
  }

  private exchange(wire: Uint8Array, timeout: number): Promise<Uint8Array> {
    const { hostname } = this;
    const options: ConnectionOptions = {
      host: this.address,
      port: this.port,
      ALPNProtocols: ['dot'],
      minVersion: 'TLSv1.2',
      // parsedmarc builds DoTNameserver with dnspython's default
      // `verify=True` and offers no way to turn it off.
      rejectUnauthorized: true,
      // dnspython checks the hostname only when one is given; without it
      // the certificate chain is still verified.
      checkServerIdentity: (_host: string, certificate: PeerCertificate) =>
        hostname === null
          ? undefined
          : checkServerIdentity(hostname, certificate),
    };
    if (hostname !== null) {
      options.servername = hostname;
    }
    return streamExchange(
      () => connect(options),
      'secureConnect',
      wire,
      Math.max(1, timeout * MS_PER_SECOND),
    );
  }
}

/** Whether two addresses are the same, ignoring an IPv6 scope and spelling. */
function sameAddress(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  try {
    return Buffer.from(ipv6Aton(a, true)).equals(
      Buffer.from(ipv6Aton(b, true)),
    );
  } catch {
    return false;
  }
}

/**
 * One query over UDP (`dns.query.udp` with `ignore_unexpected` and
 * `ignore_errors`, as dnspython's resolver calls it): datagrams from other
 * sources, malformed ones and answers to other questions are skipped until
 * the timeout.
 */
function udpExchange(
  query: DnsQuery,
  address: string,
  port: number,
  timeoutMs: number,
): Promise<DnsMessage> {
  return new Promise<DnsMessage>((resolve, reject) => {
    const bareAddress = address.split('%')[0] ?? address;
    const socket = createSocket(isIPv6(bareAddress) ? 'udp6' : 'udp4');
    let settled = false;
    const finish = (error: Error | null, response?: DnsMessage): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error === null) {
        resolve(response as DnsMessage);
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(() => finish(new DNSTimeout()), timeoutMs);
    socket.on('message', (data: Buffer, source: RemoteInfo) => {
      if (source.port !== port || !sameAddress(source.address, address)) {
        return;
      }
      let response: DnsMessage;
      try {
        response = decodeMessage(data);
      } catch {
        return;
      }
      if (isResponse(query, response)) {
        finish(null, response);
      }
    });
    socket.once('error', (error: Error) =>
      finish(new DNSSocketError(error.message, errorCode(error))),
    );
    socket.send(query.wire, port, address, (error: Error | null) => {
      if (error !== null) {
        finish(new DNSSocketError(error.message, errorCode(error)));
      }
    });
  });
}

/**
 * One length-prefixed query/response over a stream (RFC 1035 4.2.2), the
 * framing DNS over TCP and DNS over TLS share.
 */
function streamExchange(
  open: () => Socket,
  readyEvent: 'connect' | 'secureConnect',
  wire: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const socket = open();
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (error: Error | null, result?: Uint8Array): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === null) {
        resolve(result as Uint8Array);
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(() => finish(new DNSTimeout()), timeoutMs);
    socket.once(readyEvent, () => {
      const frame = Buffer.alloc(LENGTH_PREFIX_BYTES + wire.length);
      frame.writeUInt16BE(wire.length, 0);
      frame.set(wire, LENGTH_PREFIX_BYTES);
      socket.write(frame);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received > LENGTH_PREFIX_BYTES + MAX_MESSAGE_BYTES) {
        finish(new DNSFormError('The DNS message is too big.'));
        return;
      }
      const data = Buffer.concat(chunks);
      if (data.length >= LENGTH_PREFIX_BYTES) {
        const length = data.readUInt16BE(0);
        if (data.length >= LENGTH_PREFIX_BYTES + length) {
          finish(
            null,
            Uint8Array.from(
              data.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length),
            ),
          );
        }
      }
    });
    socket.once('end', () =>
      finish(new DNSSocketError('Connection closed', 'EOF')),
    );
    socket.once('error', (error: Error) =>
      finish(new DNSSocketError(error.message, errorCode(error))),
    );
  });
}

/**
 * The port of a parsed DNS over HTTPS or TLS nameserver URL (parsedmarc's
 * `_nameserver_port()`). urlsplit only validates the port when it is read,
 * and its error quotes the text it rejected: a password with an unencoded
 * `/`, `?` or `#` ends the authority early (RFC 3986 section 3.2), which
 * makes the start of the password that text. So a bad port is reported
 * with the entry's credentials masked and without the original error.
 *
 * Throws `InvalidNameserverError` (Python's `ValueError`) when the port is not an
 * integer from 0 to 65535.
 */
function nameserverPort(
  entry: string,
  parts: SplitUrl,
  kind: string,
): number | null {
  try {
    return parts.port();
  } catch {
    // Rethrown below, without the original error as its cause
  }
  throw new InvalidNameserverError(
    `Invalid ${kind} nameserver ${redactUrlCredentials(entry)}: the port is ` +
      'not an integer from 0 to 65535 (percent-encode any /, ? or # in a ' +
      'password)',
  );
}

/**
 * Parses a `tls://ip[:port][#hostname]` nameserver entry. The optional
 * `#hostname` names the TLS certificate identity used for SNI and
 * verification, matching systemd-resolved's syntax.
 *
 * Throws `InvalidNameserverError` (Python's `ValueError`) when the entry has no host, an
 * unusable port, a host that is not a literal IP address, or extra URL
 * components.
 */
export function parseDotNameserver(entry: string): DoTNameserver {
  const parts = urlSplit(entry);
  const port = nameserverPort(entry, parts, 'DNS over TLS');
  // The entry may carry userinfo, which is rejected below, so the messages
  // quote it with its credentials masked
  const shown = redactUrlCredentials(entry);
  if (parts.username || parts.path || parts.query) {
    // Catch tls://9.9.9.9/dns.quad9.net, a plausible slash-for-# typo that
    // would otherwise "work" with no certificate identity and fail only at
    // query time with an opaque TLS error
    throw new InvalidNameserverError(
      `Invalid DNS over TLS nameserver ${shown}: only ` +
        'tls://ip[:port][#hostname] is supported — the TLS certificate ' +
        'identity is given after #, not /',
    );
  }
  const address = parts.hostname;
  if (!address) {
    throw new InvalidNameserverError(
      `Invalid DNS over TLS nameserver ${shown}: missing IP address`,
    );
  }
  if (!isAddress(address)) {
    throw new InvalidNameserverError(
      `Invalid DNS over TLS nameserver ${shown}: ${address} is not an IP ` +
        'address. Use tls://ip[:port][#hostname], where the optional ' +
        '#hostname is the TLS certificate identity of the server',
    );
  }
  const hostname = parts.fragment || null;
  if (hostname === null && !warnedDotWithoutHostname.has(entry)) {
    warnedDotWithoutHostname.add(entry);
    logger.warning(
      `DNS over TLS nameserver ${entry} has no #hostname: only the ` +
        'certificate chain is verified, so any server with a publicly ' +
        'trusted certificate for any name can answer. Use ' +
        'tls://ip[:port]#hostname with the TLS certificate identity of the ' +
        'server',
    );
  }
  return new DoTNameserver(address, port ?? DOT_PORT, hostname);
}

/** DoT entries already warned about (warn once per entry, not per query). */
const warnedDotWithoutHostname = new Set<string>();

/**
 * Converts configured nameserver strings into resolver input: `https://`
 * entries become DNS over HTTPS nameservers, `tls://ip[:port][#hostname]`
 * entries DNS over TLS nameservers, and everything else (plain IPv4/IPv6
 * addresses) is passed through untouched, in the configured order.
 *
 * Throws `InvalidNameserverError` when a `tls://` entry is malformed, or an `https://`
 * entry has an unusable port.
 */
export function nameserversToResolverInput(
  nameservers: readonly string[],
): (string | Nameserver)[] {
  const resolverInput: (string | Nameserver)[] = [];
  for (const entry of nameservers) {
    let parts: SplitUrl;
    try {
      // urlsplit lowercases the scheme, so HTTPS:// and TLS:// work too
      parts = urlSplit(entry);
    } catch {
      // e.g. an unbalanced IPv6 bracket; let the resolver reject it with
      // its own message about what a nameserver may be
      resolverInput.push(entry);
      continue;
    }
    if (parts.scheme === 'https') {
      // Validated now: the resolver reads the port only after a query
      // fails, and the error then quotes the rejected text
      nameserverPort(entry, parts, 'DNS over HTTPS');
      resolverInput.push(new DoHNameserver(entry));
    } else if (parts.scheme === 'tls') {
      resolverInput.push(parseDotNameserver(entry));
    } else {
      resolverInput.push(entry);
    }
  }
  return resolverInput;
}

/**
 * Turns resolver input into nameservers (dnspython's
 * `Resolver._enrich_nameservers`). Throws `InvalidNameserverError` for a string that is
 * neither an IP address nor an `https://` URL.
 */
export function enrichNameservers(
  input: readonly (string | Nameserver)[],
): Nameserver[] {
  return input.map(nameserver => {
    if (nameserver instanceof Nameserver) {
      return nameserver;
    }
    if (isAddress(nameserver)) {
      return new Do53Nameserver(nameserver, DO53_PORT);
    }
    let scheme = '';
    try {
      ({ scheme } = urlSplit(nameserver));
    } catch {
      scheme = '';
    }
    if (scheme !== 'https') {
      throw new InvalidNameserverError(
        `nameserver ${nameserver} is not a dns.nameserver.Nameserver instance ` +
          'or text form, IP address, nor a valid https URL',
      );
    }
    return new DoHNameserver(nameserver);
  });
}

/** Failures that take a nameserver out of the mix (dnspython's `query_result`). */
function isNameserverBroken(error: unknown): boolean {
  return error instanceof DNSFormError || error instanceof DNSSocketError;
}

export interface ResolveOptions {
  /** Per-attempt timeout, in seconds (dnspython's `Resolver.timeout`). */
  timeout: number;
  /** Overall budget, in seconds (dnspython's `Resolver.lifetime`). */
  lifetime: number;
}

function nowSeconds(): number {
  return performance.now() / MS_PER_SECOND;
}

/**
 * Resolve one question against `nameservers` (dnspython's
 * `Resolver.resolve()` for an absolute name, without search lists or a
 * resolver cache). Returns the answer records as text.
 */
export async function resolve(
  qname: string,
  rdtypeText: string,
  nameservers: readonly Nameserver[],
  options: ResolveOptions,
): Promise<string[]> {
  const name = nameFromText(qname);
  const rdtype = rdatatypeFromText(rdtypeText);
  const request: DnsRequest = { name, rdtype, rdtypeText };
  const question = questionToText({ name, rdtype, rdclass: RDATACLASS_IN });
  const start = nowSeconds();
  const usable = [...nameservers];
  let current = [...usable];
  const errors: ResolutionError[] = [];
  let backoff = INITIAL_BACKOFF;
  for (;;) {
    let wait = 0;
    if (current.length === 0) {
      if (usable.length === 0) {
        // Out of things to try!
        throw new NoNameservers(question, errors);
      }
      current = [...usable];
      wait = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
    const nameserver = current.shift() as Nameserver;
    if (wait > 0) {
      await sleep(wait * MS_PER_SECOND);
    }
    const duration = nowSeconds() - start;
    if (duration >= options.lifetime) {
      throw new LifetimeTimeout(duration, errors);
    }
    const timeout = Math.min(options.lifetime - duration, options.timeout);
    const record = (error: unknown): void => {
      errors.push({
        nameserver: nameserver.toString(),
        tcp: nameserver.isAlwaysMaxSize(),
        port: nameserver.answerPort(),
        error,
      });
    };
    const remove = (): void => {
      usable.splice(usable.indexOf(nameserver), 1);
    };
    let outcome: NameserverOutcome;
    try {
      outcome = await nameserver.query(request, timeout);
    } catch (error) {
      record(error);
      if (isNameserverBroken(error)) {
        remove();
      }
      continue;
    }
    switch (outcome.kind) {
      case 'answer': {
        return outcome.records;
      }
      case 'noanswer': {
        throw new NoAnswer(question);
      }
      case 'nxdomain': {
        throw new NXDOMAIN([nameToText(name)]);
      }
      case 'invalid': {
        record(outcome.error);
        remove();
        break;
      }
      case 'rcode': {
        if (outcome.rcode === RCODE.YXDOMAIN) {
          const error = new YXDOMAIN();
          record(error);
          throw error;
        }
        // dnspython's retry_servfail is off, so SERVFAIL also removes it.
        remove();
        record(rcodeToText(outcome.rcode));
        break;
      }
      default: {
        throw new Error('unreachable');
      }
    }
  }
}

/** Errors `queryDns()` retries (parsedmarc's `_RETRYABLE_DNS_ERRORS`). */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof LifetimeTimeout ||
    error instanceof NoNameservers ||
    error instanceof DNSSocketError
  );
}

export interface DnsQueryOptions {
  /** Cache storage. */
  cache?: DnsCache | null;
  /**
   * Nameservers to use (Cloudflare's public resolvers by default). Each
   * entry is an IP address (DNS over UDP/TCP port 53), an `https://` URL
   * (DNS over HTTPS) or `tls://ip[:port][#hostname]` (DNS over TLS, port
   * 853 by default, `#hostname` naming the server's TLS certificate
   * identity). Pass `RECOMMENDED_DNS_NAMESERVERS` for a cross-provider mix.
   */
  nameservers?: readonly string[] | null;
  /**
   * Overall DNS lifetime budget in seconds per configured nameserver.
   * Per-query attempts are capped at `min(1, timeout)` so a lost UDP packet
   * is retried within the lifetime, and a slow nameserver falls through to
   * the next quickly.
   */
  timeout?: number;
  /**
   * Times to retry the whole query after a timeout or other transient error
   * (`LifetimeTimeout`, `NoNameservers`, `DNSSocketError`).
   */
  retries?: number;
}

/**
 * Whether a cache would be used. parsedmarc tests `if cache:`, and an empty
 * ExpiringDict is falsy, so a fresh (empty) cache is neither read nor
 * written: it only fills once something else put an entry in it. Kept as
 * is for 1:1 behavior.
 */
function cacheIsUsable(cache: DnsCache | null | undefined): cache is DnsCache {
  return cache !== null && cache !== undefined && cache.size > 0;
}

/**
 * Queries DNS and returns the answers as text. Throws
 * `InvalidNameserverError` (a `RangeError`) when a
 * nameserver is malformed, with the nameservers' URL credentials masked.
 */
export async function queryDns(
  domain: string,
  recordType: string,
  options: DnsQueryOptions = {},
): Promise<string[]> {
  const name = String(domain).toLowerCase();
  const rdtype = recordType.toUpperCase();
  const cacheKey = `${name}_${rdtype}`;
  const { cache } = options;
  if (cacheIsUsable(cache)) {
    const cachedRecords = cache.get(cacheKey);
    if (Array.isArray(cachedRecords)) {
      return cachedRecords;
    }
  }

  const nameservers = options.nameservers ?? DEFAULT_NAMESERVERS;
  const timeout = Number(options.timeout ?? DEFAULT_DNS_TIMEOUT);
  const retries = options.retries ?? DEFAULT_DNS_MAX_RETRIES;
  let resolverNameservers: Nameserver[];
  try {
    resolverNameservers = enrichNameservers(
      nameserversToResolverInput(nameservers),
    );
  } catch (error) {
    if (!(error instanceof InvalidNameserverError)) {
      throw error;
    }
    // The resolver's own rejection quotes the entry as configured
    // ("nameserver https://user:pw@[x is not ..."), credentials and all;
    // the masked error has no cause that would keep the original.
    throw new InvalidNameserverError(
      maskNameserverSecrets(error.message, nameservers),
    );
  }
  // Cap the per-query timeout at 1s so a dropped UDP datagram is retried
  // within the lifetime instead of consuming the whole budget (dig's
  // default +tries=3 masks this case). With multiple nameservers the same
  // cap lets a slow or broken one fall through.
  const resolveOptions: ResolveOptions = {
    timeout: Math.min(MAX_PER_QUERY_TIMEOUT, timeout),
    lifetime:
      resolverNameservers.length > 1
        ? timeout * resolverNameservers.length
        : timeout,
  };
  let answers: string[];
  for (let attempt = 0; ;) {
    try {
      answers = await resolve(
        name,
        rdtype,
        resolverNameservers,
        resolveOptions,
      );
      break;
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      attempt += 1;
      if (attempt > retries) {
        throw error;
      }
    }
  }
  const records = answers.map(answer =>
    pyRStrip(answer.replaceAll('"', ''), '.'),
  );
  if (cacheIsUsable(cache)) {
    cache.set(cacheKey, records);
  }
  return records;
}

export interface GetReverseDnsOptions extends DnsQueryOptions {
  /** Called with the DNS error when there is one, before returning `null`. */
  onError?: (error: DNSException) => void;
}

/**
 * Resolves an IP address to a hostname using a reverse DNS query. Returns
 * `null` on any DNS error.
 */
export async function getReverseDns(
  ipAddress: string,
  options: GetReverseDnsOptions = {},
): Promise<string | null> {
  let hostname: string | null = null;
  try {
    const address = reverseNameFromAddress(ipAddress);
    const records = await queryDns(address, 'PTR', options);
    hostname = records[0] ?? null;
  } catch (error) {
    if (!(error instanceof DNSException)) {
      throw error;
    }
    options.onError?.(error);
    // LifetimeTimeout and NoNameservers quote each nameserver URL
    const message = maskNameserverSecrets(error.message, options.nameservers);
    logger.debug(
      `get_reverse_dns(${sanitizeForLog(ipAddress)}) exception: ${sanitizeForLog(message)}`,
    );
  }
  return hostname;
}
