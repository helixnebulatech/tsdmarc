// getCreds() tests: mailsuite's TestGetCreds and TestTokenFileMkdir, plus
// coverage of the Node-only pieces (token.json round trip, refresh, and the
// loopback OAuth flow that replaces InstalledAppFlow.run_local_server).

import { existsSync } from 'node:fs';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JWT, OAuth2Client } from 'google-auth-library';
import { captureLogs, ValueError } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizedUserCredentials } from './credentials';
import { getCreds } from './gmail';
import {
  codeChallenge,
  OAuthFlowError,
  runLocalServer,
  WSGITimeoutError,
} from './oauth-flow';
import { createFakeFetch, type FakeFetch } from './test/fake-fetch';

type Credentials = Awaited<ReturnType<typeof runLocalServer>>;

const TOKEN_URL = '/token';
const CLIENT_SECRETS = {
  installed: {
    client_id: 'cid.apps.googleusercontent.com',
    client_secret: 'csecret',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: ['http://localhost'],
  },
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'tsdmarc-gmail-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Send a raw request (fetch normalizes `//`) and return the status line. */
function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
    });
    socket.once('error', reject);
    socket.once('data', data => {
      socket.destroy();
      resolve(data.toString('latin1').split('\r\n')[0] ?? '');
    });
  });
}

/** Start the flow; resolves once the server is listening. */
async function startFlow(
  fetchImplementation: typeof fetch,
): Promise<{ port: number; state: string; finish: Promise<Credentials> }> {
  const port = await freePort();
  const opened = Promise.withResolvers<string>();
  const finish = runLocalServer(CLIENT_SECRETS.installed, ['scope'], {
    port,
    authorizationPromptMessage: '',
    fetchImplementation,
    openUrl: url => opened.resolve(url),
  });
  const authUrl = new URL(await opened.promise);
  return { port, state: authUrl.searchParams.get('state') ?? '', finish };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });
}

/** Answer the printed authorization URL by hitting the redirect URI. */
function browserStub(query: (authUrl: URL) => Record<string, string>): {
  output: { write: (text: string) => void };
  urls: URL[];
} {
  const urls: URL[] = [];
  return {
    urls,
    output: {
      write: (text: string) => {
        const match = /https:\S+/u.exec(text);
        if (!match) {
          return;
        }
        const authUrl = new URL(match[0]);
        urls.push(authUrl);
        const redirect = new URL(
          authUrl.searchParams.get('redirect_uri') ?? '',
        );
        // A stray request first: it must not end the flow.
        for (const [key, value] of Object.entries(query(authUrl))) {
          redirect.searchParams.set(key, value);
        }
        const visit = async (): Promise<void> => {
          await fetch(new URL('/favicon.ico', redirect));
          await fetch(redirect);
        };
        visit().catch(() => undefined);
      },
    },
  };
}

function tokenEndpoint(fake: FakeFetch): void {
  fake.on('POST', TOKEN_URL, {
    json: {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: 'scope',
      token_type: 'Bearer',
    },
  });
}

describe('TestGetCreds', () => {
  it('rejects an unsupported auth mode', async () => {
    const result = getCreds(
      path.join(directory, 'tok.json'),
      path.join(directory, 'creds.json'),
      ['scope'],
      0,
      { authMode: 'bogus' },
    );
    // mailsuite: pytest.raises(ValueError, match="Unsupported").
    await expect(result).rejects.toBeInstanceOf(ValueError);
    await expect(result).rejects.toThrow(/Unsupported/u);
  });

  it('builds service account credentials with a subject', async () => {
    const credsFile = path.join(directory, 'creds.json');
    await writeFile(
      credsFile,
      JSON.stringify({
        type: 'service_account',
        client_email: 'svc@project.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
        private_key_id: 'kid',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    const creds = await getCreds('ignored', credsFile, ['scope1'], 0, {
      authMode: 'service_account',
      serviceAccountUser: 'user@example.com',
    });
    expect(creds).toBeInstanceOf(JWT);
    const jwt = creds as JWT;
    expect(jwt.scopes).toEqual(['scope1']);
    expect(jwt.subject).toBe('user@example.com');
    expect(jwt.email).toBe('svc@project.iam.gserviceaccount.com');
    expect(existsSync('ignored')).toBe(false);
  });

  it('normalizes the auth mode', async () => {
    const credsFile = path.join(directory, 'creds.json');
    await writeFile(
      credsFile,
      JSON.stringify({
        client_email: 'svc@x',
        private_key: 'k',
        token_uri: 'u',
      }),
    );
    const creds = await getCreds('ignored', credsFile, ['s'], 0, {
      authMode: ' Service_Account ',
    });
    expect(creds).toBeInstanceOf(JWT);
    expect((creds as JWT).subject).toBeUndefined();
  });

  it('rejects a service account file without client_email', async () => {
    const credsFile = path.join(directory, 'creds.json');
    await writeFile(credsFile, JSON.stringify({ token_uri: 'u' }));
    await expect(
      getCreds('ignored', credsFile, ['s'], 0, {
        authMode: 'service_account',
      }),
    ).rejects.toThrow(/missing fields client_email/u);
  });

  it('runs the installed-app flow on the configured port', async () => {
    // Regression: the configured port must be the one the redirect server
    // binds (mailsuite once passed it under the wrong keyword).
    const port = await freePort();
    const fake = createFakeFetch();
    tokenEndpoint(fake);
    const credsFile = path.join(directory, 'client_secrets.json');
    await writeFile(credsFile, JSON.stringify(CLIENT_SECRETS));
    const browser = browserStub(authUrl => ({
      code: 'the-code',
      state: authUrl.searchParams.get('state') ?? '',
    }));

    const logs = captureLogs();
    let creds: OAuth2Client;
    try {
      creds = await getCreds(
        path.join(directory, 'token.json'),
        credsFile,
        ['scope'],
        port,
        {
          transporterOptions: { fetchImplementation: fake.fetch },
          oauth2Flow: { output: browser.output },
        },
      );
    } finally {
      logs.restore();
    }
    // The sign-in URL is printed once; like google_auth_oauthlib it is
    // logged on its own logger, not the library logger (which the CLI
    // shows on the console, so it would appear twice).
    expect(browser.urls).toHaveLength(1);
    expect(logs.output.filter(line => line.includes('https://'))).toEqual([]);

    const [authUrl] = browser.urls;
    expect(authUrl?.origin + (authUrl?.pathname ?? '')).toBe(
      'https://accounts.google.com/o/oauth2/auth',
    );
    const params = authUrl?.searchParams;
    expect(params?.get('redirect_uri')).toBe(`http://localhost:${port}/`);
    expect(params?.get('client_id')).toBe(CLIENT_SECRETS.installed.client_id);
    expect(params?.get('response_type')).toBe('code');
    expect(params?.get('access_type')).toBe('offline');
    expect(params?.get('scope')).toBe('scope');
    expect(params?.get('code_challenge_method')).toBe('S256');
    expect(params?.get('state')).toMatch(/^[A-Za-z0-9]{30}$/u);

    const [exchange] = fake.find('POST', TOKEN_URL);
    const form = new URLSearchParams(exchange?.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('redirect_uri')).toBe(`http://localhost:${port}/`);
    expect(form.get('client_secret')).toBe('csecret');
    const verifier = form.get('code_verifier') ?? '';
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{128}$/u);
    expect(codeChallenge(verifier)).toBe(params?.get('code_challenge'));

    expect(creds).toBeInstanceOf(OAuth2Client);
    expect(creds.credentials.access_token).toBe('new-access');
    expect(creds.credentials.refresh_token).toBe('new-refresh');
  });

  it('ignores a redirect with the wrong state and keeps waiting', async () => {
    const fake = createFakeFetch();
    tokenEndpoint(fake);
    const credsFile = path.join(directory, 'client_secrets.json');
    await writeFile(credsFile, JSON.stringify(CLIENT_SECRETS));
    const browser = browserStub(() => ({ code: 'c', state: 'forged' }));
    await expect(
      getCreds(path.join(directory, 'token.json'), credsFile, ['scope'], 0, {
        transporterOptions: { fetchImplementation: fake.fetch },
        oauth2Flow: { output: browser.output, timeoutSeconds: 0.2 },
      }),
    ).rejects.toThrow(WSGITimeoutError);
    expect(fake.requests).toHaveLength(0);
    expect(existsSync(path.join(directory, 'token.json'))).toBe(false);
  });

  it('survives junk on the callback port and finishes with the real redirect', async () => {
    const fake = createFakeFetch();
    tokenEndpoint(fake);
    const { port, state, finish } = await startFlow(fake.fetch);
    const base = `http://127.0.0.1:${port}`;

    // `GET //` is an invalid URL: it must not throw in the request listener.
    expect(await rawRequest(port, '//')).toMatch(/^HTTP\/1\.1 400 /u);
    // Neither an attacker's error nor a missing state ends the flow.
    const forged = await fetch(`${base}/?error=x&error_description=y`);
    expect(forged.status).toBe(400);
    await forged.text();
    expect(await rawRequest(port, '/')).toMatch(/^HTTP\/1\.1 400 /u);

    const redirect = await fetch(`${base}/?code=real&state=${state}`);
    expect(redirect.status).toBe(200);
    await redirect.text();
    expect((await finish).token).toBe('new-access');
  });

  it('sanitizes the error text of a redirect with the right state', async () => {
    const { port, state, finish } = await startFlow(createFakeFetch().fetch);
    const rejected = expect(finish).rejects.toThrow(
      new OAuthFlowError('(x) a\\nb\\x1b[31m'),
    );
    const response = await fetch(
      `http://127.0.0.1:${port}/?error=x&error_description=a%0Ab%1B%5B31m&state=${state}`,
    );
    await response.text();
    await rejected;
  });

  it('reports an authorization error', async () => {
    const credsFile = path.join(directory, 'client_secrets.json');
    await writeFile(credsFile, JSON.stringify(CLIENT_SECRETS));
    const browser = browserStub(authUrl => ({
      error: 'access_denied',
      state: authUrl.searchParams.get('state') ?? '',
    }));
    await expect(
      getCreds(path.join(directory, 'token.json'), credsFile, ['scope'], 0, {
        oauth2Flow: { output: browser.output },
      }),
    ).rejects.toThrow(/access_denied/u);
  });

  it('times out waiting for the redirect', async () => {
    const credsFile = path.join(directory, 'client_secrets.json');
    await writeFile(credsFile, JSON.stringify(CLIENT_SECRETS));
    await expect(
      getCreds(path.join(directory, 'token.json'), credsFile, ['scope'], 0, {
        oauth2Flow: {
          output: { write: () => undefined },
          timeoutSeconds: 0.05,
        },
      }),
    ).rejects.toThrow(WSGITimeoutError);
  });

  it('rejects client secrets that are not web or installed', async () => {
    const credsFile = path.join(directory, 'client_secrets.json');
    await writeFile(credsFile, JSON.stringify({ other: {} }));
    await expect(
      getCreds(path.join(directory, 'token.json'), credsFile, ['scope'], 0),
    ).rejects.toThrow('Client secrets must be for a web or installed app.');
  });

  it('reuses a valid token file without any request', async () => {
    const tokenFile = path.join(directory, 'token.json');
    const expiry = new Date(Date.now() + 3_600_000);
    const stored = new AuthorizedUserCredentials({
      token: 'stored-access',
      refreshToken: 'stored-refresh',
      clientId: 'cid',
      clientSecret: 'csecret',
      scopes: ['scope'],
      expiry,
    }).toJson();
    await writeFile(tokenFile, stored);
    const fake = createFakeFetch();
    const creds = await getCreds(tokenFile, 'unused.json', ['scope'], 0, {
      transporterOptions: { fetchImplementation: fake.fetch },
    });
    expect(creds.credentials.access_token).toBe('stored-access');
    expect(fake.requests).toHaveLength(0);
    // A valid token is not rewritten.
    expect(await readFile(tokenFile, 'utf8')).toBe(stored);
  });

  it('refreshes an expired token and rewrites the file', async () => {
    const tokenFile = path.join(directory, 'token.json');
    await writeFile(
      tokenFile,
      JSON.stringify({
        token: 'old-access',
        refresh_token: 'stored-refresh',
        client_id: 'cid',
        client_secret: 'csecret',
        scopes: ['scope'],
        expiry: '2020-01-01T00:00:00.000000Z',
      }),
    );
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_URL, {
      json: { access_token: 'fresh-access', expires_in: 3600 },
    });
    const creds = await getCreds(tokenFile, 'unused.json', ['scope'], 0, {
      transporterOptions: { fetchImplementation: fake.fetch },
    });
    const [refresh] = fake.find('POST', TOKEN_URL);
    expect(refresh?.url.href).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(refresh?.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('stored-refresh');
    // google-auth's refresh_grant() sends the requested scopes.
    expect(form.get('scope')).toBe('scope');
    expect(creds.credentials.access_token).toBe('fresh-access');
    const saved = JSON.parse(await readFile(tokenFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(saved.token).toBe('fresh-access');
    expect(saved.refresh_token).toBe('stored-refresh');
  });

  // The token file holds a refresh token: an existing file (e.g. created
  // 0644 by another tool) must become private when it is rewritten.
  it('makes a rewritten token file private (0600)', async () => {
    const tokenFile = path.join(directory, 'token.json');
    await writeFile(
      tokenFile,
      JSON.stringify({
        token: 'old-access',
        refresh_token: 'stored-refresh',
        client_id: 'cid',
        client_secret: 'csecret',
        expiry: '2020-01-01T00:00:00.000000Z',
      }),
      { mode: 0o644 },
    );
    await chmod(tokenFile, 0o644);
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_URL, {
      json: { access_token: 'fresh-access', expires_in: 3600 },
    });
    await getCreds(tokenFile, 'unused.json', ['scope'], 0, {
      transporterOptions: { fetchImplementation: fake.fetch },
    });
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(tokenFile, 'utf8')) as Record<string, unknown>,
    ).toMatchObject({ token: 'fresh-access' });
  });

  // The automatic refresh before an API call goes through the same grant,
  // so it must send the scopes too.
  it('sends the scopes on automatic refreshes', async () => {
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_URL, {
      json: { access_token: 'auto-access', expires_in: 3600 },
    });
    const client = new AuthorizedUserCredentials({
      token: 'old',
      refreshToken: 'r',
      clientId: 'cid',
      clientSecret: 'csecret',
      scopes: ['a', 'b'],
      expiry: new Date(Date.now() - 1000),
    }).toOAuth2Client({ fetchImplementation: fake.fetch });
    const { token } = await client.getAccessToken();
    expect(token).toBe('auto-access');
    const [refresh] = fake.find('POST', TOKEN_URL);
    const form = new URLSearchParams(refresh?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'cid',
      client_secret: 'csecret',
      refresh_token: 'r',
      scope: 'a b',
    });
  });

  it('rejects a token file missing required fields', async () => {
    const tokenFile = path.join(directory, 'token.json');
    await writeFile(tokenFile, JSON.stringify({ token: 'x' }));
    await expect(
      getCreds(tokenFile, 'unused.json', ['scope'], 0),
    ).rejects.toThrow(
      'Authorized user info was not in the expected format, missing fields refresh_token, client_id, client_secret.',
    );
  });
});

describe('TestTokenFileMkdir', () => {
  it('creates parent directories for the token file', async () => {
    // Callers point the token file at paths inside fresh config directories.
    const tokenPath = path.join(directory, 'deep', 'nested', 'token.json');
    const credsFile = path.join(directory, 'client_secrets.json');
    await writeFile(credsFile, JSON.stringify(CLIENT_SECRETS));
    const fake = createFakeFetch();
    tokenEndpoint(fake);
    const browser = browserStub(authUrl => ({
      code: 'c',
      state: authUrl.searchParams.get('state') ?? '',
    }));

    expect(existsSync(path.join(directory, 'deep'))).toBe(false);
    await getCreds(tokenPath, credsFile, ['scope'], 0, {
      transporterOptions: { fetchImplementation: fake.fetch },
      oauth2Flow: { output: browser.output },
    });

    const saved = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(saved)).toEqual([
      'token',
      'refresh_token',
      'token_uri',
      'client_id',
      'client_secret',
      'scopes',
      'universe_domain',
      'account',
      'expiry',
    ]);
    expect(saved).toMatchObject({
      token: 'new-access',
      refresh_token: 'new-refresh',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: CLIENT_SECRETS.installed.client_id,
      client_secret: 'csecret',
      scopes: ['scope'],
      universe_domain: 'googleapis.com',
      account: '',
    });
    expect(saved.expiry).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?Z$/u,
    );
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });
});

describe('AuthorizedUserCredentials', () => {
  it('writes token.json like google-auth to_json()', () => {
    const creds = new AuthorizedUserCredentials({
      token: 't',
      refreshToken: 'r',
      clientId: 'c',
      clientSecret: 's',
      scopes: ['a', 'b'],
      expiry: new Date(Date.UTC(2026, 9, 24, 10, 0, 0, 123)),
    });
    expect(creds.toJson()).toBe(
      '{"token": "t", "refresh_token": "r", "token_uri": "https://oauth2.googleapis.com/token", "client_id": "c", "client_secret": "s", "scopes": ["a", "b"], "universe_domain": "googleapis.com", "account": "", "expiry": "2026-10-24T10:00:00.123000Z"}',
    );
  });

  it('reads a Python token file', () => {
    const creds = AuthorizedUserCredentials.fromAuthorizedUserInfo({
      token: 't',
      refresh_token: 'r',
      token_uri: 'https://example.invalid/token',
      client_id: 'c',
      client_secret: 's',
      scopes: 'a b',
      expiry: '2026-10-24T10:00:00.123456Z',
    });
    expect(creds.scopes).toEqual(['a', 'b']);
    expect(creds.expiry?.toISOString()).toBe('2026-10-24T10:00:00.000Z');
    // google-auth always overrides the stored token_uri.
    expect(creds.tokenUri).toBe('https://oauth2.googleapis.com/token');
  });

  it('treats a token without expiry as expired', () => {
    const creds = AuthorizedUserCredentials.fromAuthorizedUserInfo({
      token: 't',
      refresh_token: 'r',
      client_id: 'c',
      client_secret: 's',
    });
    expect(creds.expired).toBe(true);
    expect(creds.valid).toBe(false);
  });

  it('treats a token within 3m45s of expiry as expired', () => {
    const creds = new AuthorizedUserCredentials({
      token: 't',
      refreshToken: 'r',
      clientId: 'c',
      clientSecret: 's',
      scopes: null,
      expiry: new Date(Date.now() + 200_000),
    });
    expect(creds.expired).toBe(true);
  });
});
