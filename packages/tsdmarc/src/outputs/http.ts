// Minimal HTTP POST shared by the Splunk HEC and webhook outputs.
//
// parsedmarc uses an httpx.Client with `follow_redirects=True`. Here,
// requests go through the global `fetch` (Node, Bun and Deno all have one),
// which follows redirects too. `fetch` has no portable switch to skip TLS
// certificate verification, so when the caller turns verification off the
// request goes through `node:https` with `rejectUnauthorized: false`
// instead, following redirects the same way httpx does.
//
// Response bodies are read only on demand and capped at
// MAX_RESPONSE_BYTES on both paths (httpx reads any size).
//
// Like httpx, a URL's `user:password@` becomes Basic auth, which `fetch`
// refuses to do. URLs often are the secret (webhook tokens in the path), and
// runtimes quote them in their errors, so what `httpPost()` throws never
// carries more of a URL than its scheme and host. Header values `fetch` would
// refuse are refused first, with an error that doesn't quote them (they hold
// tokens, such as Splunk's HEC token).

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { InvalidURL } from '../utils/http';

/**
 * The largest response body read (Splunk's HEC answers with a few bytes of
 * JSON). httpx reads any size; a hostile or broken server could otherwise
 * make the client buffer without limit.
 */
export const MAX_RESPONSE_BYTES: number = 1024 * 1024;

/** httpx's default `max_redirects`. */
const MAX_REDIRECTS = 20;
const MS_PER_SECOND = 1000;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
/** `scheme://`, then `user:password@`, the host, and the rest of the URL. */
/** What `fetch` refuses in a header value (it quotes the value in its error). */
const INVALID_HEADER_VALUE = /[\0\n\r\u0100-\u{10ffff}]/u;
const URL_IN_TEXT =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@"'<>)]*@)?([^\s/?#"'<>)]*)[^\s"'<>)]*/giu;

export interface HttpPostOptions {
  headers: Record<string, string>;
  body: string | Uint8Array | URLSearchParams;
  /** Seconds before the whole request is aborted; `null` waits forever. */
  timeout: number | null;
  /** Verify TLS certificates (default `true`). */
  verify?: boolean;
  /**
   * Follow redirects like httpx's `follow_redirects=True` (default `true`).
   * With `false`, a 3xx response is returned as it is.
   */
  followRedirects?: boolean;
  /** Aborts the request (e.g. when the client is closed). */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /**
   * The body as UTF-8 text. Throws when it is larger than
   * {@link MAX_RESPONSE_BYTES} (the rest is not downloaded).
   */
  text: () => Promise<string>;
  /** Drop the body unread, releasing the connection. Never throws. */
  discard: () => Promise<void>;
}

function bodyTooLarge(): Error {
  return new Error(`Response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
}

/** Read a fetch body up to {@link MAX_RESPONSE_BYTES}. */
async function readFetchBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw bodyTooLarge();
  }
  if (response.body === null) {
    return '';
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
    if (total > MAX_RESPONSE_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- leaves the loop
      await reader.cancel();
      throw bodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function fetchResponse(response: Response): HttpResponse {
  return {
    status: response.status,
    text: () => readFetchBody(response),
    discard: async () => {
      try {
        await response.body?.cancel();
      } catch {
        // Already consumed or errored: nothing left to release.
      }
    },
  };
}

function requestSignal(options: HttpPostOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (options.timeout !== null) {
    signals.push(AbortSignal.timeout(options.timeout * MS_PER_SECOND));
  }
  if (options.signal) {
    signals.push(options.signal);
  }
  if (signals.length === 0) {
    return undefined;
  }
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/**
 * The URL to request, like httpx refusing what it can't send (no URL
 * quoted). An unparsable URL with a scheme throws {@link InvalidURL}: a
 * password with an unencoded `/`, `?` or `#` ends the authority early, and
 * httpx's `InvalidURL` then quotes part of it as the port.
 */
function parseRequestUrl(url: string): URL {
  if (!URL.canParse(url)) {
    if (URL_SCHEME.test(url)) {
      throw new InvalidURL('Invalid URL');
    }
    throw new Error(
      "Request URL is missing an 'http://' or 'https://' protocol.",
    );
  }
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(
      `Request URL has an unsupported protocol '${target.protocol}//'.`,
    );
  }
  return target;
}

/** httpx's `unquote()`: invalid percent-encoding stays as it is. */
function unquote(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Basic auth from a URL's userinfo; it replaces any `Authorization`, like httpx. */
function withUrlCredentials(
  target: URL,
  headers: Record<string, string>,
): Record<string, string> {
  const credentials = `${unquote(target.username)}:${unquote(target.password)}`;
  return {
    ...withoutHeader(headers, ['Authorization']),
    Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
  };
}

/** `text` with each URL cut down to its scheme and host. */
function redactUrls(text: string): string {
  return text.replaceAll(URL_IN_TEXT, '$1$2');
}

/** `error`, or a copy of it (and its causes) without the URLs it quotes. */
function withoutUrlSecrets(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const { cause } = error;
  const safeCause = withoutUrlSecrets(cause);
  const message = redactUrls(error.message);
  if (message === error.message && safeCause === cause) {
    return error;
  }
  const safe = new Error(message, { cause: safeCause });
  safe.name = error.name;
  return safe;
}

/** POST `body` to `url`, following redirects unless `followRedirects` is `false`. */
export async function httpPost(
  url: string,
  options: HttpPostOptions,
): Promise<HttpResponse> {
  const target = parseRequestUrl(url);
  let request = options;
  let requestUrl = url;
  if (target.username || target.password) {
    request = {
      ...options,
      headers: withUrlCredentials(target, options.headers),
    };
    target.username = '';
    target.password = '';
    requestUrl = target.href;
  }
  for (const [name, value] of Object.entries(request.headers)) {
    if (INVALID_HEADER_VALUE.test(value)) {
      throw new Error(`Invalid value for the ${name} header`);
    }
  }
  const signal = requestSignal(request);
  try {
    if (request.verify === false && target.protocol === 'https:') {
      return await insecurePost(requestUrl, request, signal);
    }
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: request.followRedirects === false ? 'manual' : 'follow',
      signal,
    });
    return fetchResponse(response);
  } catch (error) {
    throw withoutUrlSecrets(error);
  }
}

/** Read a node:http body up to {@link MAX_RESPONSE_BYTES}. */
function readNodeBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      response.destroy();
      reject(bodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(bodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () =>
      resolve(Buffer.concat(chunks, total).toString('utf8')),
    );
    response.on('error', reject);
  });
}

function nodeRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array | undefined,
  signal: AbortSignal | undefined,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      { method, headers, rejectUnauthorized: false, signal },
      resolve,
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function encodeBody(body: HttpPostOptions['body']): Uint8Array {
  if (body instanceof Uint8Array) {
    return body;
  }
  return new TextEncoder().encode(body.toString());
}

function withoutHeader(
  headers: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  const lowered = new Set(names.map(name => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !lowered.has(key.toLowerCase())),
  );
}

async function insecurePost(
  url: string,
  options: HttpPostOptions,
  signal: AbortSignal | undefined,
): Promise<HttpResponse> {
  let target = new URL(url);
  let method = 'POST';
  let body: Uint8Array | undefined = encodeBody(options.body);
  let headers = { ...options.headers };
  if (options.body instanceof URLSearchParams && !hasHeader(headers)) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  for (let redirects = 0; ; redirects += 1) {
    // oxlint-disable-next-line no-await-in-loop -- redirects are sequential
    const response = await nodeRequest(target, method, headers, body, signal);
    const status = response.statusCode ?? 0;
    const { location } = response.headers;
    if (
      options.followRedirects === false ||
      !REDIRECT_STATUSES.has(status) ||
      location === undefined
    ) {
      return {
        status,
        text: () => readNodeBody(response),
        discard: () => {
          response.destroy();
          return Promise.resolve();
        },
      };
    }
    // A redirect's body is never read.
    response.destroy();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error('Exceeded maximum allowed redirects.');
    }
    const next = new URL(location, target);
    // Same rules as httpx: 303 (and 301/302 after a POST) switch to a
    // body-less GET; credentials never follow a redirect to another origin.
    if (status !== 307 && status !== 308) {
      method = 'GET';
      body = undefined;
      headers = withoutHeader(headers, ['Content-Type', 'Content-Length']);
    }
    if (next.origin !== target.origin) {
      headers = withoutHeader(headers, ['Authorization']);
    }
    target = next;
  }
}

function hasHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === 'content-type');
}

/** The message of an error, with the low-level cause `fetch` wraps. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { cause } = error;
  if (
    cause instanceof Error &&
    cause.message &&
    cause.message !== error.message
  ) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}
