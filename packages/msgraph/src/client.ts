// Minimal Microsoft Graph REST client over `fetch`, standing in for the
// Python Graph SDK (msgraph-sdk + kiota). It reproduces the SDK behavior
// mailsuite relies on: a bearer token from azure-identity on every request,
// 100-second request timeouts, kiota's RetryHandler (429/503/504, honoring
// Retry-After), and OData error bodies raised as `ODataError`.

import type { TokenCredential } from '@azure/identity';
import { EmailTooLargeError, emailTooLargeError, USER_AGENT } from 'tsdmarc';

import { APIError, ODataError, parseMainError } from './errors';

/** Worldwide Graph endpoint. */
export const DEFAULT_GRAPH_URL = 'https://graph.microsoft.com';
/** kiota's DEFAULT_REQUEST_TIMEOUT, in seconds. */
export const DEFAULT_GRAPH_TIMEOUT = 100;

// kiota RetryHandler / RetryHandlerOption defaults.
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_SECONDS = 3;
const BACKOFF_FACTOR = 0.5;
const MAXIMUM_BACKOFF_SECONDS = 120;
const MAX_DELAY_SECONDS = 180;
const RETRY_STATUS_CODES = new Set([429, 503, 504]);
const RETRY_AFTER_PAIR = /^\d+,\d+$/u;
const DIGITS = /^\d+$/u;
const TRAILING_SLASHES = /\/+$/u;
const MS_PER_SECOND = 1000;
const HTTP_NO_CONTENT = 204;

export type Sleep = (ms: number) => Promise<void>;

export interface GraphClientOptions {
  credential: TokenCredential;
  /** Scopes requested for each token. */
  scopes: string[];
  /** Graph endpoint, without `/v1.0`. Default: the worldwide cloud. */
  graphUrl?: string | null;
  /** Per-attempt timeout in seconds. Default: 100. */
  timeout?: number;
  /** `fetch` implementation. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Delay used between retries (tests). */
  sleep?: Sleep;
}

export interface GraphRequestOptions {
  /** Query parameters, appended in order. */
  query?: [string, string][];
  /** JSON request body. */
  body?: unknown;
  /** Read the response as bytes instead of JSON. */
  binary?: boolean;
  /**
   * With `binary`: the largest body accepted, in bytes. A larger
   * `Content-Length` is refused before the body is read, and the read
   * stops once the body grows past it; both throw `EmailTooLargeError`.
   */
  maxBytes?: number | null;
}

/** Read a response body, refusing more than `maxBytes` bytes. */
async function readBoundedBody(
  response: Response,
  maxBytes: number | null,
): Promise<Uint8Array> {
  if (maxBytes === null || maxBytes <= 0) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw emailTooLargeError(declared, maxBytes);
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new EmailTooLargeError(
        `Email exceeds the ${maxBytes} byte size limit (max_email_size)`,
      );
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const defaultSleep: Sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** Percent-encode a path segment (RFC 6570 simple expansion). */
export function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    character =>
      `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
  );
}

/** kiota's `_parse_retry_after`: seconds, or an HTTP date. */
function parseRetryAfter(value: string): number | null {
  const first = RETRY_AFTER_PAIR.test(value)
    ? (value.split(',')[0] ?? '')
    : value;
  if (DIGITS.test(first)) {
    return Math.max(0, Number(first));
  }
  const date = Date.parse(first);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, (date - Date.now()) / MS_PER_SECOND);
}

/** kiota's `get_delay_time`, in seconds. */
function retryDelaySeconds(retryCount: number, response: Response): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const parsed = parseRetryAfter(retryAfter);
    if (parsed) {
      return parsed;
    }
  }
  const exponential = BACKOFF_FACTOR * 2 ** (retryCount - 1);
  const jitter = Math.floor(Math.random() * 1001) / MS_PER_SECOND;
  return Math.min(
    MAXIMUM_BACKOFF_SECONDS,
    exponential + jitter + RETRY_BASE_DELAY_SECONDS,
  );
}

function headersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of headers) {
    record[name] = value;
  }
  return record;
}

async function errorFromResponse(response: Response): Promise<APIError> {
  const options = {
    responseStatusCode: response.status,
    responseHeaders: headersRecord(response.headers),
  };
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const mainError = parseMainError(body);
  if (mainError !== null) {
    return new ODataError(mainError, options);
  }
  return new APIError(
    `The server returned an unexpected status code and the error registered for this code failed to deserialize: ${response.status}`,
    options,
  );
}

export class GraphClient {
  readonly baseUrl: string;
  private readonly origin: string;
  private readonly credential: TokenCredential;
  private readonly scopes: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;

  constructor(options: GraphClientOptions) {
    const graphUrl = (options.graphUrl ?? DEFAULT_GRAPH_URL).replace(
      TRAILING_SLASHES,
      '',
    );
    const parsed = new URL(graphUrl);
    if (parsed.protocol !== 'https:') {
      // kiota's Azure authentication provider refuses to send tokens over http.
      throw new Error('Only https is supported');
    }
    this.baseUrl = `${graphUrl}/v1.0`;
    this.origin = parsed.origin;
    this.credential = options.credential;
    this.scopes = options.scopes;
    this.timeoutMs = (options.timeout ?? DEFAULT_GRAPH_TIMEOUT) * MS_PER_SECOND;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Absolute URL for a path under `/v1.0`, or a full URL on the Graph host. */
  resolveUrl(pathOrUrl: string, query: [string, string][] = []): URL {
    const url = pathOrUrl.startsWith('/')
      ? new URL(`${this.baseUrl}${pathOrUrl}`)
      : new URL(pathOrUrl);
    if (url.origin !== this.origin) {
      // Never send the bearer token to another host (e.g. a forged nextLink).
      throw new Error(
        `Refusing to send a Microsoft Graph request to ${url.origin}`,
      );
    }
    if (query.length > 0) {
      const encoded = query
        .map(
          ([name, value]) =>
            `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
        )
        .join('&');
      url.search = url.search ? `${url.search}&${encoded}` : encoded;
    }
    return url;
  }

  private async authorization(signal: AbortSignal): Promise<string> {
    const token = await this.credential.getToken(this.scopes, {
      abortSignal: signal,
    });
    if (!token) {
      throw new Error('Could not acquire a Microsoft Graph access token');
    }
    return `Bearer ${token.token}`;
  }

  /** Send a request; returns parsed JSON, bytes (`binary`), or `null` if empty. */
  async request(
    method: string,
    pathOrUrl: string,
    options: GraphRequestOptions = {},
  ): Promise<unknown> {
    const url = this.resolveUrl(pathOrUrl, options.query);
    const hasBody = options.body !== undefined;
    const body = hasBody ? JSON.stringify(options.body) : undefined;
    let retryCount = 0;
    for (;;) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const headers: Record<string, string> = {
        Authorization: await this.authorization(signal),
        Accept: options.binary
          ? 'application/octet-stream, application/json'
          : 'application/json',
        'User-Agent': USER_AGENT,
      };
      if (hasBody) {
        headers['Content-Type'] = 'application/json';
      }
      if (retryCount > 0) {
        headers['Retry-Attempt'] = String(retryCount);
      }
      const response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
      });

      if (RETRY_STATUS_CODES.has(response.status) && retryCount < MAX_RETRIES) {
        const delay = retryDelaySeconds(retryCount, response);
        if (delay < MAX_DELAY_SECONDS) {
          // Release the discarded response before retrying.
          await response.body?.cancel();
          await this.sleep(delay * MS_PER_SECOND);
          retryCount += 1;
          continue;
        }
      }

      if (!response.ok) {
        throw await errorFromResponse(response);
      }
      if (options.binary) {
        const bytes = await readBoundedBody(response, options.maxBytes ?? null);
        return bytes.length === 0 ? null : bytes;
      }
      if (response.status === HTTP_NO_CONTENT) {
        return null;
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as unknown) : null;
    }
  }
}
