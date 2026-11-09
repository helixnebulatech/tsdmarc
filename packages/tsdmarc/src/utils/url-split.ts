// Python's `urllib.parse.urlsplit()`, for parsing nameserver entries the
// way parsedmarc does. The WHATWG `URL` parser accepts and rejects
// different inputs (and normalizes hosts), which would change which entries
// count as DNS over HTTPS / DNS over TLS and which error is raised.

import { isIPv6 } from 'node:net';

const SCHEME_CHARS_RE = /^[A-Za-z][A-Za-z0-9+.-]*$/u;
const UNSAFE_CHARS_RE = /[\t\r\n]/gu;
const DIGITS_RE = /^[0-9]+$/u;
const IPV_FUTURE_RE = /^v[a-fA-F0-9]+\.[a-zA-Z0-9._~!$&'()*+,;=:-]+$/u;
const MAX_PORT = 65_535;
const SPACE_CODE = 0x20;

export interface SplitUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
  /** The user name, or `null` without an `@` in the netloc. */
  username: string | null;
  /** The lowercased host, without brackets, or `null` when empty. */
  hostname: string | null;
  /** The port; throws `RangeError` like urlsplit's `.port` when it is invalid. */
  port: () => number | null;
}

function partition(
  value: string,
  separator: string,
): [string, boolean, string] {
  const index = value.indexOf(separator);
  if (index === -1) {
    return [value, false, ''];
  }
  return [value.slice(0, index), true, value.slice(index + separator.length)];
}

function rpartition(
  value: string,
  separator: string,
): [string, boolean, string] {
  const index = value.lastIndexOf(separator);
  if (index === -1) {
    return ['', false, value];
  }
  return [value.slice(0, index), true, value.slice(index + separator.length)];
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith('v')) {
    if (!IPV_FUTURE_RE.test(hostname)) {
      throw new RangeError('IPvFuture address is invalid');
    }
    return;
  }
  if (!isIPv6(hostname)) {
    throw new RangeError(
      `'${hostname}' does not appear to be an IPv4 or IPv6 address`,
    );
  }
}

function checkBracketedNetloc(netloc: string): void {
  const hostAndPort = rpartition(netloc, '@')[2];
  const [beforeBracket, hasOpenBracket, bracketed] = partition(
    hostAndPort,
    '[',
  );
  let hostname: string;
  if (hasOpenBracket) {
    if (beforeBracket) {
      throw new RangeError('Invalid IPv6 URL');
    }
    let port: string;
    [hostname, , port] = partition(bracketed, ']');
    if (port && !port.startsWith(':')) {
      throw new RangeError('Invalid IPv6 URL');
    }
  } else {
    [hostname] = partition(hostAndPort, ':');
  }
  checkBracketedHost(hostname);
}

function hostInfo(netloc: string): [string, string | null] {
  const info = rpartition(netloc, '@')[2];
  const [, hasOpenBracket, bracketed] = partition(info, '[');
  let hostname: string;
  let port: string;
  if (hasOpenBracket) {
    let rest: string;
    [hostname, , rest] = partition(bracketed, ']');
    port = partition(rest, ':')[2];
  } else {
    [hostname, , port] = partition(info, ':');
  }
  return [hostname, port === '' ? null : port];
}

/** Split a URL like Python's `urlsplit()`. Throws `RangeError` where it raises `ValueError`. */
export function urlSplit(input: string): SplitUrl {
  // Leading C0 control characters and spaces are stripped, as urlsplit does.
  let start = 0;
  while (start < input.length && input.charCodeAt(start) <= SPACE_CODE) {
    start += 1;
  }
  let url = input.slice(start).replaceAll(UNSAFE_CHARS_RE, '');
  let scheme = '';
  let netloc = '';
  let query = '';
  let fragment = '';
  const colon = url.indexOf(':');
  if (colon > 0 && SCHEME_CHARS_RE.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith('//')) {
    let end = url.length;
    for (const delimiter of ['/', '?', '#']) {
      const index = url.indexOf(delimiter, 2);
      if (index !== -1) {
        end = Math.min(end, index);
      }
    }
    netloc = url.slice(2, end);
    url = url.slice(end);
    const hasOpen = netloc.includes('[');
    const hasClose = netloc.includes(']');
    if (hasOpen !== hasClose) {
      throw new RangeError('Invalid IPv6 URL');
    }
    if (hasOpen && hasClose) {
      checkBracketedNetloc(netloc);
    }
  }
  if (url.includes('#')) {
    [url, , fragment] = partition(url, '#');
  }
  if (url.includes('?')) {
    [url, , query] = partition(url, '?');
  }
  const [userinfo, hasUserinfo] = rpartition(netloc, '@');
  const username = hasUserinfo ? partition(userinfo, ':')[0] : null;
  const [rawHost, rawPort] = hostInfo(netloc);
  let hostname: string | null = null;
  if (rawHost) {
    const [address, hasPercent, zone] = partition(rawHost, '%');
    hostname = address.toLowerCase() + (hasPercent ? `%${zone}` : '');
  }
  return {
    scheme,
    netloc,
    path: url,
    query,
    fragment,
    username,
    hostname,
    port: () => {
      if (rawPort === null) {
        return null;
      }
      if (!DIGITS_RE.test(rawPort)) {
        throw new RangeError(
          `Port could not be cast to integer value as '${rawPort}'`,
        );
      }
      const port = Number(rawPort);
      if (port > MAX_PORT) {
        throw new RangeError('Port out of range 0-65535');
      }
      return port;
    },
  };
}
