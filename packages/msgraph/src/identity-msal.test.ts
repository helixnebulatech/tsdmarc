// The real @azure/identity + @azure/msal-node stack, for every flow tsdmarc
// builds with them (ClientSecret, Certificate, ClientAssertion, DeviceCode),
// against a fake Microsoft Entra ID behind the credentials' `httpClient`.
// It also checks that @azure/identity resolves an msal-node with the
// GHSA-xcx6-jx8p-x3h5 fix (>= 7.1.0), which @azure/identity >= 4.14.1 requests.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ClientAssertionCredential,
  ClientCertificateCredential,
  type ClientSecretCredentialOptions,
  ClientSecretCredential,
  DeviceCodeCredential,
} from '@azure/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type HttpClient = NonNullable<ClientSecretCredentialOptions['httpClient']>;
type PipelineRequest = Parameters<HttpClient['sendRequest']>[0];
type PipelineResponse = Awaited<ReturnType<HttpClient['sendRequest']>>;

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;
const SCOPE = 'https://graph.microsoft.com/.default';

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An unsigned ID token: MSAL reads its claims, it doesn't verify it. */
function idToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: CLIENT_ID,
    iss: `${AUTHORITY}/v2.0`,
    iat: now,
    nbf: now,
    exp: now + 3600,
    oid: 'user-oid',
    sub: 'user-sub',
    tid: TENANT,
    preferred_username: 'user@example.com',
    name: 'User',
  };
  return `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url(claims)}.`;
}

class Headers {
  readonly #values = new Map<string, string>();

  constructor(values: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(values)) {
      this.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.#values.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.#values.has(name.toLowerCase());
  }

  set(name: string, value: string | number | boolean): void {
    this.#values.set(name.toLowerCase(), String(value));
  }

  delete(name: string): void {
    this.#values.delete(name.toLowerCase());
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.#values);
  }

  [Symbol.iterator](): Iterator<[string, string]> {
    return this.#values.entries();
  }
}

interface TokenRequest {
  url: string;
  form: URLSearchParams;
}

/** A fake Entra ID: discovery, token and device code endpoints. */
function fakeEntra(): { client: HttpClient; tokenRequests: TokenRequest[] } {
  const tokenRequests: TokenRequest[] = [];
  const respond = (
    request: PipelineRequest,
    body: object,
    status = 200,
  ): PipelineResponse =>
    ({
      request,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      bodyAsText: JSON.stringify(body),
    }) as unknown as PipelineResponse;
  const client: HttpClient = {
    sendRequest: request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/discovery/instance')) {
        return Promise.resolve(
          respond(request, {
            tenant_discovery_endpoint: `${AUTHORITY}/v2.0/.well-known/openid-configuration`,
            'api-version': '1.1',
            metadata: [
              {
                preferred_network: 'login.microsoftonline.com',
                preferred_cache: 'login.windows.net',
                aliases: ['login.microsoftonline.com', 'login.windows.net'],
              },
            ],
          }),
        );
      }
      if (url.pathname.endsWith('/.well-known/openid-configuration')) {
        return Promise.resolve(
          respond(request, {
            issuer: `${AUTHORITY}/v2.0`,
            authorization_endpoint: `${AUTHORITY}/oauth2/v2.0/authorize`,
            token_endpoint: `${AUTHORITY}/oauth2/v2.0/token`,
            device_authorization_endpoint: `${AUTHORITY}/oauth2/v2.0/devicecode`,
            end_session_endpoint: `${AUTHORITY}/oauth2/v2.0/logout`,
            jwks_uri: `${AUTHORITY}/discovery/v2.0/keys`,
          }),
        );
      }
      const form = new URLSearchParams(String(request.body ?? ''));
      if (url.pathname.endsWith('/oauth2/v2.0/devicecode')) {
        return Promise.resolve(
          respond(request, {
            device_code: 'device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://microsoft.com/devicelogin',
            expires_in: 900,
            interval: 1,
            message: 'Sign in with ABCD-EFGH',
          }),
        );
      }
      if (url.pathname.endsWith('/oauth2/v2.0/token')) {
        tokenRequests.push({ url: request.url, form });
        const user = form.get('grant_type')?.includes('device_code') === true;
        return Promise.resolve(
          respond(request, {
            token_type: 'Bearer',
            access_token: `token-for-${form.get('grant_type')}`,
            expires_in: 3600,
            ext_expires_in: 3600,
            scope: SCOPE,
            ...(user
              ? {
                  id_token: idToken(),
                  refresh_token: 'refresh',
                  client_info: base64Url({ uid: 'user-oid', utid: TENANT }),
                }
              : {}),
          }),
        );
      }
      return Promise.resolve(
        respond(request, { error: 'not_found', url: request.url }, 404),
      );
    },
  };
  return { client, tokenRequests };
}

let certDirectory: string;
let certificatePath: string;

beforeAll(() => {
  certDirectory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-msal-'));
  const keyPath = path.join(certDirectory, 'key.pem');
  const certPath = path.join(certDirectory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=tsdmarc-test',
    ],
    { stdio: 'ignore' },
  );
  // ClientCertificateCredential reads one PEM with the key and certificate.
  certificatePath = path.join(certDirectory, 'both.pem');
  writeFileSync(
    certificatePath,
    readFileSync(keyPath, 'utf8') + readFileSync(certPath, 'utf8'),
  );
});

afterAll(() => {
  rmSync(certDirectory, { recursive: true, force: true });
});

describe('@azure/identity on a patched @azure/msal-node', () => {
  it('runs a patched msal-node (GHSA-xcx6-jx8p-x3h5)', () => {
    const requireFromIdentity = createRequire(
      createRequire(import.meta.url).resolve('@azure/identity'),
    );
    const manifest = JSON.parse(
      readFileSync(
        requireFromIdentity.resolve('@azure/msal-node/package.json'),
        'utf8',
      ),
    ) as { version: string };
    const [major = 0, minor = 0] = manifest.version.split('.').map(Number);
    expect(major > 7 || (major === 7 && minor >= 1)).toBe(true);
  });

  it('ClientSecretCredential gets a token', async () => {
    const { client, tokenRequests } = fakeEntra();
    const credential = new ClientSecretCredential(TENANT, CLIENT_ID, 'secret', {
      httpClient: client,
    });
    const token = await credential.getToken(SCOPE);
    expect(token?.token).toBe('token-for-client_credentials');
    expect(tokenRequests[0]?.form.get('client_secret')).toBe('secret');
  });

  it('ClientCertificateCredential signs a client assertion', async () => {
    const { client, tokenRequests } = fakeEntra();
    const credential = new ClientCertificateCredential(
      TENANT,
      CLIENT_ID,
      { certificatePath },
      { httpClient: client },
    );
    const token = await credential.getToken(SCOPE);
    expect(token?.token).toBe('token-for-client_credentials');
    const assertion = tokenRequests[0]?.form.get('client_assertion') ?? '';
    expect(assertion.split('.')).toHaveLength(3);
  });

  it('ClientAssertionCredential sends the given assertion', async () => {
    const { client, tokenRequests } = fakeEntra();
    const credential = new ClientAssertionCredential(
      TENANT,
      CLIENT_ID,
      () => Promise.resolve('my.signed.assertion'),
      { httpClient: client },
    );
    const token = await credential.getToken(SCOPE);
    expect(token?.token).toBe('token-for-client_credentials');
    expect(tokenRequests[0]?.form.get('client_assertion')).toBe(
      'my.signed.assertion',
    );
  });

  it('DeviceCodeCredential signs in and returns an authentication record', async () => {
    const { client } = fakeEntra();
    const prompts: string[] = [];
    const credential = new DeviceCodeCredential({
      tenantId: TENANT,
      clientId: CLIENT_ID,
      disableAutomaticAuthentication: true,
      httpClient: client,
      userPromptCallback: info => {
        prompts.push(info.userCode);
      },
    });
    const record = await credential.authenticate(SCOPE);
    expect(prompts).toEqual(['ABCD-EFGH']);
    expect(record).toMatchObject({
      username: 'user@example.com',
      tenantId: TENANT,
      clientId: CLIENT_ID,
    });
    // Later tokens come from the cache, without a new sign-in.
    const token = await credential.getToken(SCOPE);
    expect(token?.token).toBe('token-for-device_code');
  });
});
