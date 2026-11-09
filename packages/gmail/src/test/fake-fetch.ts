// A fake `fetch` for tests: records every request and answers from a list
// of routes, so tests assert on exactly what was sent over the wire.

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type Responder = FakeResponse | ((request: RecordedRequest) => FakeResponse);

interface Route {
  method: string;
  path: string | RegExp;
  responses: Responder[];
}

export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** Answer `method path` with these responses, in order (the last repeats). */
  on: (
    method: string,
    path: string | RegExp,
    ...responses: Responder[]
  ) => void;
  /** Requests whose path matches. */
  find: (method: string, path: string | RegExp) => RecordedRequest[];
}

function matches(route: Route, method: string, url: URL): boolean {
  if (route.method !== method) {
    return false;
  }
  return typeof route.path === 'string'
    ? route.path === url.pathname
    : route.path.test(url.pathname);
}

async function readBody(body: unknown): Promise<string> {
  if (body === undefined || body === null) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return await new Response(
    body as ConstructorParameters<typeof Response>[0],
  ).text();
}

export function createFakeFetch(): FakeFetch {
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];

  const fakeFetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const request: RecordedRequest = {
      method,
      url,
      headers: new Headers(init.headers),
      body: await readBody(init.body),
    };
    requests.push(request);
    const route = routes.find(candidate => matches(candidate, method, url));
    if (route === undefined) {
      return new Response(JSON.stringify({ error: 'no route' }), {
        status: 599,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const responder =
      route.responses.length > 1 ? route.responses.shift() : route.responses[0];
    const answer =
      typeof responder === 'function' ? responder(request) : (responder ?? {});
    const headers = new Headers(answer.headers);
    let body: string | null = answer.text ?? null;
    if (answer.json !== undefined) {
      body = JSON.stringify(answer.json);
      headers.set('Content-Type', 'application/json');
    }
    const status = answer.status ?? 200;
    return new Response(status === 204 ? null : body, { status, headers });
  };

  return {
    fetch: fakeFetch as typeof fetch,
    requests,
    on: (method, path, ...responses) => {
      routes.push({ method, path, responses });
    },
    find: (method, path) =>
      requests.filter(request =>
        matches({ method, path, responses: [] }, request.method, request.url),
      ),
  };
}
