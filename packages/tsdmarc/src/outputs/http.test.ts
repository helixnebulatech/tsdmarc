// Tests for the verify=false transport (node:https / node:http mocked).
// The fetch path is covered by the Splunk and webhook tests.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeError, httpPost, MAX_RESPONSE_BYTES } from './http';

interface FakeReply {
  status: number;
  location?: string;
  body?: string;
}

interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  rejectUnauthorized: boolean;
  body: string;
}

const transport = vi.hoisted(() => ({
  replies: [] as FakeReply[],
  sent: [] as SentRequest[],
}));

vi.mock('node:https', () => ({ request: fakeRequest }));
vi.mock('node:http', () => ({ request: fakeRequest }));

function fakeRequest(
  url: URL,
  options: {
    method: string;
    headers: Record<string, string>;
    rejectUnauthorized: boolean;
  },
  callback: (response: PassThrough) => void,
): EventEmitter {
  const outgoing = Object.assign(new EventEmitter(), {
    end(body?: Uint8Array): void {
      transport.sent.push({
        url: String(url),
        method: options.method,
        headers: options.headers,
        rejectUnauthorized: options.rejectUnauthorized,
        body: body ? new TextDecoder().decode(body) : '',
      });
      const reply = transport.replies.shift() ?? { status: 200 };
      if (reply.status === 0) {
        outgoing.emit('error', new Error('socket hang up'));
        return;
      }
      const response = Object.assign(new PassThrough(), {
        statusCode: reply.status,
        headers: reply.location ? { location: reply.location } : {},
      });
      response.end(reply.body ?? '');
      return callback(response);
    },
  });
  return outgoing;
}

const BASE_OPTIONS = {
  headers: { Authorization: 'Splunk t', 'User-Agent': 'tsdmarc/0.0.0' },
  body: 'payload',
  timeout: 5,
  verify: false,
} as const;

beforeEach(() => {
  transport.replies = [];
  transport.sent = [];
});

describe('httpPost with verify false', () => {
  it('posts with rejectUnauthorized false and returns the body', async () => {
    transport.replies = [{ status: 200, body: '{"code":0}' }];
    const response = await httpPost('https://h/x', { ...BASE_OPTIONS });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"code":0}');
    expect(transport.sent).toEqual([
      {
        url: 'https://h/x',
        method: 'POST',
        headers: BASE_OPTIONS.headers,
        rejectUnauthorized: false,
        body: 'payload',
      },
    ]);
  });

  it('turns a 302 after POST into a GET without a body', async () => {
    transport.replies = [{ status: 302, location: '/next' }, { status: 200 }];
    await httpPost('https://h/x', { ...BASE_OPTIONS });
    expect(transport.sent[1]).toMatchObject({
      url: 'https://h/next',
      method: 'GET',
      body: '',
    });
    expect(transport.sent[1]?.headers.Authorization).toBe('Splunk t');
  });

  it('returns a redirect as it is with followRedirects false', async () => {
    transport.replies = [{ status: 301, location: '/next' }, { status: 200 }];
    const response = await httpPost('https://h/x', {
      ...BASE_OPTIONS,
      followRedirects: false,
    });
    expect(response.status).toBe(301);
    expect(transport.sent).toHaveLength(1);
  });

  it('keeps the method and body on 307 and 308', async () => {
    transport.replies = [
      { status: 307, location: 'https://h/a' },
      { status: 308, location: 'https://h/b' },
      { status: 200 },
    ];
    await httpPost('https://h/x', { ...BASE_OPTIONS });
    expect(transport.sent.map(sent => [sent.method, sent.body])).toEqual([
      ['POST', 'payload'],
      ['POST', 'payload'],
      ['POST', 'payload'],
    ]);
  });

  it('drops the Authorization header on a cross-origin redirect', async () => {
    transport.replies = [
      { status: 307, location: 'https://other.example/x' },
      { status: 200 },
    ];
    await httpPost('https://h/x', { ...BASE_OPTIONS });
    expect(transport.sent[1]?.url).toBe('https://other.example/x');
    expect(transport.sent[1]?.headers).toEqual({
      'User-Agent': 'tsdmarc/0.0.0',
    });
  });

  it('gives up after 20 redirects', async () => {
    transport.replies = Array.from({ length: 25 }, () => ({
      status: 302,
      location: '/loop',
    }));
    await expect(httpPost('https://h/x', { ...BASE_OPTIONS })).rejects.toThrow(
      'Exceeded maximum allowed redirects.',
    );
    expect(transport.sent).toHaveLength(21);
  });

  it('form-encodes URLSearchParams bodies', async () => {
    await httpPost('https://h/x', {
      ...BASE_OPTIONS,
      body: new URLSearchParams({ a: '1', b: 'x y' }),
    });
    expect(transport.sent[0]?.body).toBe('a=1&b=x+y');
    expect(transport.sent[0]?.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('caps the response body it reads', async () => {
    transport.replies = [
      { status: 200, body: 'x'.repeat(MAX_RESPONSE_BYTES + 1) },
      { status: 200, body: 'x'.repeat(MAX_RESPONSE_BYTES) },
    ];
    const tooLarge = await httpPost('https://h/x', { ...BASE_OPTIONS });
    await expect(tooLarge.text()).rejects.toThrow(
      `Response body exceeds ${MAX_RESPONSE_BYTES} bytes`,
    );
    const atLimit = await httpPost('https://h/x', { ...BASE_OPTIONS });
    expect(await atLimit.text()).toHaveLength(MAX_RESPONSE_BYTES);
  });

  it('rejects on a socket error', async () => {
    transport.replies = [{ status: 0 }];
    await expect(httpPost('https://h/x', { ...BASE_OPTIONS })).rejects.toThrow(
      'socket hang up',
    );
  });
});

/** A body that keeps producing 64 KiB chunks; counts what was pulled. */
function endlessBody(): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

describe('httpPost through fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops reading a response body past the cap', async () => {
    const body = endlessBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body.stream, { status: 200 }))),
    );
    const response = await httpPost('https://h/x', {
      ...BASE_OPTIONS,
      verify: true,
    });
    await expect(response.text()).rejects.toThrow(
      `Response body exceeds ${MAX_RESPONSE_BYTES} bytes`,
    );
    expect(body.cancelled()).toBe(true);
    // 1 MiB in 64 KiB chunks, plus what the stream buffered ahead.
    expect(body.pulled()).toBeLessThan(40);
  });

  it('refuses a declared Content-Length past the cap without reading', async () => {
    const body = endlessBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(body.stream, {
            status: 200,
            headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) },
          }),
        ),
      ),
    );
    const response = await httpPost('https://h/x', {
      ...BASE_OPTIONS,
      verify: true,
    });
    await expect(response.text()).rejects.toThrow('Response body exceeds');
    expect(body.cancelled()).toBe(true);
  });
});

describe('httpPost URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('ok', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('turns userinfo into Basic auth, percent-decoded, like httpx', async () => {
    const fetchMock = stubFetch();
    await httpPost('https://user:p%40ss@hooks.example.com/x?a=1', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      timeout: null,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://hooks.example.com/x?a=1');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Basic dXNlcjpwQHNz',
    );
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('lets userinfo replace an Authorization header, like httpx', async () => {
    const fetchMock = stubFetch();
    await httpPost('http://user:pass@splunk.example.com/x', {
      headers: { authorization: 'Splunk token' },
      body: '{}',
      timeout: null,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Basic dXNlcjpwYXNz',
    );
  });

  it('keeps invalid percent-encoding in a password as it is', async () => {
    const fetchMock = stubFetch();
    await httpPost('http://user:100%@example.com/x', {
      headers: {},
      body: '{}',
      timeout: null,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('user:100%').toString('base64')}`,
    );
  });

  it('sends userinfo as Basic auth with verify false too', async () => {
    await httpPost('https://user:pass@splunk.example.com/x', {
      headers: {},
      body: 'x',
      timeout: null,
      verify: false,
    });
    expect(transport.sent[0]).toMatchObject({
      url: 'https://splunk.example.com/x',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
  });

  it('refuses a URL without a scheme like httpx, without quoting it', async () => {
    const fetchMock = stubFetch();
    await expect(
      httpPost('hooks.example.com/services/T/B/SECRET', {
        headers: {},
        body: '{}',
        timeout: null,
      }),
    ).rejects.toThrow(
      /^Request URL is missing an 'http:\/\/' or 'https:\/\/' protocol\.$/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses another protocol like httpx', async () => {
    await expect(
      httpPost('hooks.example.com:8080/services/T/B/SECRET', {
        headers: {},
        body: '{}',
        timeout: null,
      }),
    ).rejects.toThrow(
      /^Request URL has an unsupported protocol 'hooks\.example\.com:\/\/'\.$/u,
    );
  });

  it('keeps only scheme and host of a URL in a runtime error', async () => {
    // Deno: `error sending request for url (<url>): <reason>`.
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(
      new TypeError(
        'error sending request for url (https://hooks.example.com/services/T/B/SECRET?sig=TOKEN): refused',
        { cause: new Error('at https://user:pw@other.example.com/SECRET') },
      ),
    );
    const error = await httpPost(
      'https://hooks.example.com/services/T/B/SECRET',
      {
        headers: {},
        body: '{}',
        timeout: null,
      },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'TypeError' });
    expect(describeError(error)).toBe(
      'error sending request for url (https://hooks.example.com): refused: at https://other.example.com',
    );
    expect(String((error as Error).stack)).not.toContain('SECRET');
  });

  it('rethrows an error without URLs as it is', async () => {
    const fetchMock = stubFetch();
    const failure = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValue(failure);
    await expect(
      httpPost('https://example.com/x', {
        headers: {},
        body: '{}',
        timeout: null,
      }),
    ).rejects.toBe(failure);
  });
});

describe('httpPost header values', () => {
  it.each([
    ['a line break', 'Splunk SECRET\nTOKEN'],
    ['a NUL', 'Splunk SECRET\0TOKEN'],
    ['a character over U+00FF', 'Splunk SECRET\u{20ac}TOKEN'],
  ])('refuses %s without quoting the value', async (_name, value) => {
    for (const verify of [true, false]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const error = await httpPost('https://hec.example/x', {
        headers: { Authorization: value },
        body: 'x',
        timeout: 1,
        verify,
      }).catch((caught: unknown) => caught);
      expect(describeError(error)).toBe(
        'Invalid value for the Authorization header',
      );
    }
    expect(transport.sent).toEqual([]);
  });
});

describe('describeError', () => {
  it('appends the cause message', () => {
    expect(
      describeError(
        new TypeError('fetch failed', { cause: new Error('boom') }),
      ),
    ).toBe('fetch failed: boom');
  });

  it('stringifies non-errors', () => {
    expect(describeError('plain')).toBe('plain');
  });
});
