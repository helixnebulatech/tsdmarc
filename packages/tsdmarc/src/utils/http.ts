// Minimal HTTP GET over `fetch`, shaped like the parts of httpx parsedmarc
// uses (`httpx.get`, `raise_for_status()`, `httpx.HTTPError`), so the
// ported `except httpx.HTTPError` branches map to `instanceof HTTPError`.
//
// Differences from httpx, on purpose:
// - Bodies are capped (`maxBytes`): every download is untrusted input.
// - Error messages never include the query string, which may carry an API
//   token, or the password of a URL.
// - `fetch` refuses credentials in a URL, and quotes the URL when it does:
//   they are sent as a Basic `Authorization` header, as httpx does.
// - Proxies: Node's `fetch` honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY only when
//   the process runs with NODE_USE_ENV_PROXY=1 (httpx honors them always).

import { STATUS_CODES } from 'node:http';

import { LookupError, lookupCodec, pyDecode } from './py-codecs';
import { Message } from './py-email/message';
import { redactUrlCredentials } from './redact';

/** Base class of HTTP errors (httpx's `HTTPError`). */
export class HTTPError extends Error {
  override name = 'HTTPError';
}

/** The request could not be sent or the response could not be read (httpx's `TransportError`). */
export class TransportError extends HTTPError {
  override name = 'TransportError';
}

/** The request timed out (httpx's `TimeoutException`). */
export class TimeoutException extends TransportError {
  override name = 'TimeoutException';
}

/** The connection or the request failed before a response arrived (httpx's `ConnectError`). */
export class ConnectError extends TransportError {
  override name = 'ConnectError';
}

/** The response body could not be read (httpx's `ReadError`). */
export class ReadError extends TransportError {
  override name = 'ReadError';
}

/** The URL's scheme is missing or is not HTTP(S) (httpx's `UnsupportedProtocol`). */
export class UnsupportedProtocol extends TransportError {
  override name = 'UnsupportedProtocol';
}

/**
 * The URL could not be parsed (httpx's `InvalidURL`, which, like it, is
 * not an `HTTPError`). httpx quotes the rejected part, which can be part of
 * a password; the message here never quotes the URL.
 */
export class InvalidURL extends Error {
  override name = 'InvalidURL';
}

/** `raiseForStatus()` found a non-2xx status (httpx's `HTTPStatusError`). */
export class HTTPStatusError extends HTTPError {
  override name = 'HTTPStatusError';
  readonly status: number;
  /** The request URL, without its query string and with credentials masked. */
  readonly url: string;

  constructor(message: string, status: number, url: string = '') {
    super(message);
    this.status = status;
    this.url = url;
  }
}

/**
 * Describes an HTTP error for the log without leaking URL credentials
 * (parsedmarc's `_describe_http_error()`): a status error as
 * `HTTP <status> for url '<url>'`, an unparsable URL with a fixed message,
 * and any other error as `<type>: <message>`. parsedmarc's status line
 * keeps the query string, which this one drops.
 */
export function describeHttpError(error: HTTPError | InvalidURL): string {
  if (error instanceof InvalidURL) {
    return 'invalid URL (details withheld because they may include credentials)';
  }
  if (error instanceof HTTPStatusError) {
    return `HTTP ${error.status} for url '${error.url}'`;
  }
  return `${error.name}: ${error.message}`;
}

/** Default cap on downloaded bodies. */
export const DEFAULT_MAX_BODY_BYTES: number = 64 * 1024 * 1024;

export interface HttpGetOptions {
  headers?: Record<string, string>;
  /** Query parameters, appended to the URL. */
  params?: Record<string, string>;
  /** Timeout for the whole request, in seconds. */
  timeout: number;
  /** Largest body accepted, in bytes. */
  maxBytes?: number;
}

/** A fully read response. */
export interface HttpResponse {
  status: number;
  /** Whether the status is 2xx (httpx's `is_success`). */
  isSuccess: boolean;
  /** The URL, without its query string, with its password masked. */
  url: string;
  body: Uint8Array;
  /** The body decoded like httpx's `.text` (charset or UTF-8, errors replaced). */
  text: () => string;
  /** The body parsed as JSON; throws `SyntaxError` when it is not JSON. */
  json: () => unknown;
  /** Throw `HTTPStatusError` unless the status is 2xx. */
  raiseForStatus: () => void;
}

const URL_QUERY_START = /[?#]/u;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s)]+/giu;
const PERCENT_ESCAPES = /(?:%[0-9a-f]{2})+/giu;

/** A URL with its password masked and without query string or fragment, for messages. */
export function redactUrl(url: string): string {
  const masked = redactUrlCredentials(url);
  const end = masked.search(URL_QUERY_START);
  return end === -1 ? masked : masked.slice(0, end);
}

/** Python's `urllib.parse.unquote()`: bad escapes stay, bad UTF-8 is replaced. */
function unquote(text: string): string {
  return text.replaceAll(PERCENT_ESCAPES, escapes =>
    Buffer.from(escapes.replaceAll('%', ''), 'hex').toString('utf8'),
  );
}

/**
 * `url` without its `user:password@`, and the `Authorization` header httpx
 * derives from them. A URL without credentials, or one that can't be
 * parsed, comes back unchanged.
 */
export function splitUrlCredentials(url: string): {
  url: string;
  authorization: string | null;
} {
  if (!URL.canParse(url)) {
    return { url, authorization: null };
  }
  const parsed = new URL(url);
  if (parsed.username === '' && parsed.password === '') {
    return { url, authorization: null };
  }
  const credentials = `${unquote(parsed.username)}:${unquote(parsed.password)}`;
  parsed.username = '';
  parsed.password = '';
  return {
    url: parsed.href,
    authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
  };
}

function statusErrorType(status: number): string {
  if (status < 200) {
    return 'Informational response';
  }
  if (status < 400) {
    return 'Redirect response';
  }
  if (status < 500) {
    return 'Client error';
  }
  return 'Server error';
}

function transportError(
  error: unknown,
  ErrorType: typeof TransportError,
): HTTPError {
  if (error instanceof HTTPError) {
    return error;
  }
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new TimeoutException('timed out');
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const message =
    cause instanceof Error
      ? cause.message
      : error instanceof Error
        ? error.message
        : String(error);
  // Some runtimes quote the request URL (Deno) or a redirect target.
  return new ErrorType(
    message.replaceAll(URL_IN_TEXT, quoted => redactUrl(quoted)),
  );
}

function bodyTooLarge(maxBytes: number): TransportError {
  return new TransportError(`Response body exceeds ${maxBytes} bytes`);
}

/** Read a response body, throwing `TransportError` past `maxBytes`. */
export async function readBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw bodyTooLarge(maxBytes);
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  // An explicit reader: cancelling the stream itself while an async
  // iterator holds its lock throws "ReadableStream is locked".
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- chunks arrive in order
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- leaves the loop
      await reader.cancel();
      throw bodyTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  // A view over the joined buffer: copying it again into a fresh
  // Uint8Array is very slow on Bun for large bodies.
  const joined = Buffer.concat(chunks, total);
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}

/** httpx's `_is_known_encoding`: only `LookupError` means unknown (a NUL raises). */
function isKnownEncoding(encoding: string): boolean {
  try {
    lookupCodec(encoding);
    return true;
  } catch (error) {
    if (error instanceof LookupError) {
      return false;
    }
    throw error;
  }
}

/**
 * httpx's `Response.text`: the Content-Type charset when Python knows the
 * codec, else UTF-8, with errors replaced. Python's `utf-8` codec keeps a
 * byte order mark (as U+FEFF), unlike `TextDecoder`'s default.
 */
export function decodeResponseText(
  body: Uint8Array,
  contentType: string | null,
): string {
  if (body.length === 0) {
    return '';
  }
  let encoding = 'utf-8';
  if (contentType !== null) {
    const message = new Message();
    message.set('content-type', contentType);
    const charset = message.getContentCharset();
    if (charset !== undefined && isKnownEncoding(charset)) {
      encoding = charset;
    }
  }
  return pyDecode(body, encoding, 'replace');
}

/** GET a URL, following redirects, and read the whole body. Throws `HTTPError` subclasses. */
export async function httpGet(
  url: string,
  options: HttpGetOptions,
): Promise<HttpResponse> {
  if (!URL.canParse(url)) {
    if (URL_SCHEME.test(url)) {
      throw new InvalidURL('Invalid URL');
    }
    throw new UnsupportedProtocol(
      "Request URL is missing an 'http://' or 'https://' protocol.",
    );
  }
  const original = new URL(url);
  const { url: requestUrl, authorization } = splitUrlCredentials(url);
  const target = new URL(requestUrl);
  // Like httpx, only HTTP(S): fetch would also read data: URLs.
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new UnsupportedProtocol(
      `Request URL has an unsupported protocol '${target.protocol}//'.`,
    );
  }
  for (const [key, value] of Object.entries(options.params ?? {})) {
    target.searchParams.set(key, value);
  }
  let userinfo = '';
  if (authorization !== null) {
    userinfo = original.password
      ? `${original.username}:${original.password}@`
      : `${original.username}@`;
  }
  const shownUrl = redactUrlCredentials(
    `${target.protocol}//${userinfo}${target.host}${target.pathname}`,
  );
  const headers = { ...options.headers };
  if (authorization !== null) {
    headers.Authorization = authorization;
  }
  let response: Response;
  try {
    response = await fetch(target, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeout * 1000),
    });
  } catch (error) {
    throw transportError(error, ConnectError);
  }
  const { status } = response;
  const contentType = response.headers.get('content-type');
  let body: Uint8Array;
  try {
    body = await readBody(response, options.maxBytes ?? DEFAULT_MAX_BODY_BYTES);
  } catch (error) {
    throw transportError(error, ReadError);
  }
  const isSuccess = status >= 200 && status < 300;
  return {
    status,
    isSuccess,
    url: shownUrl,
    body,
    text: () => decodeResponseText(body, contentType),
    json: (): unknown => JSON.parse(new TextDecoder('utf-8').decode(body)),
    raiseForStatus: () => {
      if (!isSuccess) {
        const reason = STATUS_CODES[status] ?? '';
        throw new HTTPStatusError(
          `${statusErrorType(status)} '${status} ${reason}' for url '${shownUrl}'\n` +
            `For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${status}`,
          status,
          shownUrl,
        );
      }
    },
  };
}
