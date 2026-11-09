import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectError,
  decodeResponseText,
  describeHttpError,
  HTTPError,
  HTTPStatusError,
  httpGet,
  InvalidURL,
  readBody,
  redactUrl,
  splitUrlCredentials,
  TransportError,
  UnsupportedProtocol,
} from './http';

function streamedResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(next);
      }
    },
  });
  // No Content-Length: the cap must be enforced while streaming.
  return new Response(body);
}

describe('readBody', () => {
  it('throws TransportError when a streamed body exceeds the cap', async () => {
    const response = streamedResponse([
      new Uint8Array(600),
      new Uint8Array(600),
    ]);
    const error = await readBody(response, 1000).catch(caught => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe('Response body exceeds 1000 bytes');
  });

  it('returns the joined body', async () => {
    const response = streamedResponse([Uint8Array.of(1, 2), Uint8Array.of(3)]);
    expect([...(await readBody(response, 10))]).toEqual([1, 2, 3]);
  });

  it('reads 32 MiB in many chunks quickly', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const chunks = Array.from({ length: 512 }, () => chunk);
    // CPU time, so a loaded machine doesn't make the bound flaky.
    const started = process.cpuUsage();
    const body = await readBody(streamedResponse(chunks), 64 * 1024 * 1024);
    expect(body.length).toBe(32 * 1024 * 1024);
    const { user, system } = process.cpuUsage(started);
    expect((user + system) / 1000).toBeLessThan(2000);
  });
});

describe('decodeResponseText (httpx Response.text)', () => {
  it('keeps a UTF-8 byte order mark like Python', () => {
    expect(
      decodeResponseText(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61), null),
    ).toBe('﻿a');
  });

  it('uses a known Content-Type charset', () => {
    expect(
      decodeResponseText(
        Uint8Array.of(0x63, 0xe9),
        'text/plain; charset=iso-8859-1',
      ),
    ).toBe('cé');
  });

  it('falls back to UTF-8 with replacement for unknown charsets', () => {
    expect(
      decodeResponseText(
        Uint8Array.of(0x63, 0xe9),
        'text/plain; charset=bogus',
      ),
    ).toBe('c�');
    expect(decodeResponseText(Uint8Array.of(0xff, 0xfe), 'text/csv')).toBe(
      '��',
    );
  });

  it('returns an empty string for an empty body', () => {
    expect(decodeResponseText(new Uint8Array(), null)).toBe('');
  });
});

describe('httpGet: credentials and tokens in URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A `fetch` that refuses credentials, quoting the URL, as undici does. */
  function stubFetch(status: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: URL, _init: RequestInit) => {
      if (url.username !== '' || url.password !== '') {
        throw new TypeError(
          `Request cannot be constructed from a URL that includes credentials: ${url.href}`,
        );
      }
      return new Response('body', { status });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends URL credentials as Basic auth, like httpx', async () => {
    const fetchMock = stubFetch(200);
    const response = await httpGet(
      'https://us%40er:p%23ss%C3%A9@example.com/x?sig=abc',
      { timeout: 1, headers: { Accept: '*/*' } },
    );
    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('https://example.com/x?sig=abc');
    expect(init.headers).toEqual({
      Accept: '*/*',
      // base64 of the UTF-8 "us@er:p#ssé"
      Authorization: `Basic ${Buffer.from('us@er:p#ssé').toString('base64')}`,
    });
  });

  it('keeps credentials and the query out of a status error', async () => {
    stubFetch(404);
    const response = await httpGet(
      'https://user:s3cret@example.com/a?sig=abc',
      { timeout: 1 },
    );
    expect(response.url).toBe('https://user:***@example.com/a');
    expect(() => response.raiseForStatus()).toThrow(HTTPStatusError);
    expect(() => response.raiseForStatus()).toThrow(
      "Client error '404 Not Found' for url 'https://user:***@example.com/a'",
    );
    let caught: unknown;
    try {
      response.raiseForStatus();
    } catch (error) {
      caught = error;
    }
    expect(describeHttpError(caught as HTTPStatusError)).toBe(
      "HTTP 404 for url 'https://user:***@example.com/a'",
    );
  });

  it('keeps the password out of an unparsable URL error', async () => {
    const error = await httpGet('https://user:s3c#ret@host:bad/a?sig=1', {
      timeout: 1,
    }).catch((caught: unknown) => caught);
    // httpx's InvalidURL, which is not an HTTPError, as in httpx
    expect(error).toBeInstanceOf(InvalidURL);
    expect(error).not.toBeInstanceOf(HTTPError);
    expect(String(error)).not.toContain('s3c');
    expect(describeHttpError(error as InvalidURL)).toBe(
      'invalid URL (details withheld because they may include credentials)',
    );
  });

  it.each([
    ['foo', "Request URL is missing an 'http://' or 'https://' protocol."],
    ['', "Request URL is missing an 'http://' or 'https://' protocol."],
    ['ftp://host/x', "Request URL has an unsupported protocol 'ftp://'."],
  ])('rejects %j like httpx', async (url, message) => {
    const error = await httpGet(url, { timeout: 1 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UnsupportedProtocol);
    expect(error).toBeInstanceOf(TransportError);
    expect(describeHttpError(error as UnsupportedProtocol)).toBe(
      `UnsupportedProtocol: ${message}`,
    );
  });

  it('names a refused connection ConnectError, like httpx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 192.0.2.1:443'),
        });
      }),
    );
    const error = await httpGet('https://dl:SECRET@192.0.2.1/x', {
      timeout: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectError);
    expect(describeHttpError(error as ConnectError)).toBe(
      'ConnectError: connect ECONNREFUSED 192.0.2.1:443',
    );
  });

  it('removes the query of a URL quoted in a transport error', async () => {
    // The real text of a refused connection in Deno 2.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: new Error(
            'error sending request for url (https://api.example/lite/8.8.8.8?token=SECRET): client error (Connect)',
          ),
        });
      }),
    );
    const error = await httpGet('https://api.example/lite/8.8.8.8', {
      timeout: 1,
      params: { token: 'SECRET' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe(
      'error sending request for url (https://api.example/lite/8.8.8.8): client error (Connect)',
    );
  });

  it('keeps a plain URL as it is', async () => {
    const fetchMock = stubFetch(200);
    await httpGet('https://example.com/x@y', { timeout: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('https://example.com/x@y');
    expect(init.headers).toEqual({});
    expect(splitUrlCredentials('https://example.com/x')).toEqual({
      url: 'https://example.com/x',
      authorization: null,
    });
  });

  it('redactUrl removes userinfo as well as the query', () => {
    expect(redactUrl('https://u:p@host/x?token=1#f')).toBe(
      'https://u:***@host/x',
    );
    expect(redactUrl('https://host/x?token=1')).toBe('https://host/x');
  });
});
