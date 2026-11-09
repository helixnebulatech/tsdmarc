// UsernamePasswordCredential: the confidential/public ROPC flow mailsuite
// gets from azure-identity + MSAL. A fake `fetch` plays the token endpoint;
// the tests assert on the requests MSAL would send.

import {
  AuthenticationError,
  AuthenticationRequiredError,
} from '@azure/identity';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAuthRecord, UsernamePasswordCredential } from './ropc';
import { createFakeFetch, type FakeFetch } from './test/fake-fetch';
import { fakeIdToken, TOKEN_PATH, tokenResponse } from './test/token';

function form(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function credential(
  fake: FakeFetch,
  clientSecret: string | null = 'the-secret',
): UsernamePasswordCredential {
  return new UsernamePasswordCredential({
    clientId: 'cid',
    clientSecret,
    username: 'user@example.com',
    password: 'p@ss word',
    fetch: fake.fetch,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('UsernamePasswordCredential', () => {
  it('signs in as a confidential client with the client secret', async () => {
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_PATH, { json: tokenResponse('at1') });
    const record = await credential(fake).authenticate(['Mail.ReadWrite']);

    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.url.origin).toBe('https://login.microsoftonline.com');
    expect(request?.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=utf-8',
    );
    expect(form(request?.body ?? '')).toEqual({
      client_id: 'cid',
      grant_type: 'password',
      username: 'user@example.com',
      password: 'p@ss word',
      scope: 'Mail.ReadWrite openid profile offline_access',
      client_info: '1',
      client_secret: 'the-secret',
    });
    expect(record).toEqual({
      authority: 'login.microsoftonline.com',
      clientId: 'cid',
      homeAccountId: 'uid.utid',
      tenantId: 'tenant-guid',
      username: 'user@example.com',
      version: '1.0',
    });
  });

  it('signs in as a public client without a client secret', async () => {
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_PATH, { json: tokenResponse('at1') });
    await credential(fake, null).authenticate('Mail.ReadWrite');
    expect(form(fake.requests[0]?.body ?? '')).not.toHaveProperty(
      'client_secret',
    );
  });

  it('bounds token requests with a timeout', async () => {
    const fake = createFakeFetch();
    let signal: AbortSignal | null | undefined;
    const fetchWithSignal = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      signal = init?.signal;
      return fake.fetch(input, init);
    };
    fake.on('POST', TOKEN_PATH, { json: tokenResponse('at1') });
    await new UsernamePasswordCredential({
      clientId: 'cid',
      username: 'u',
      password: 'p',
      fetch: fetchWithSignal as typeof fetch,
    }).authenticate(['Mail.ReadWrite']);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('uses AZURE_AUTHORITY_HOST like azure-identity', async () => {
    vi.stubEnv('AZURE_AUTHORITY_HOST', 'https://login.microsoftonline.us/');
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_PATH, { json: tokenResponse('at1') });
    await credential(fake).authenticate(['Mail.ReadWrite']);
    expect(fake.requests[0]?.url.href).toBe(
      'https://login.microsoftonline.us/organizations/oauth2/v2.0/token',
    );
  });

  it('refuses a non-https authority', () => {
    expect(
      () =>
        new UsernamePasswordCredential({
          clientId: 'c',
          username: 'u',
          password: 'p',
          authorityHost: 'http://login.example.test',
        }),
    ).toThrow(/https/u);
  });

  it('throws AuthenticationError with the error description', async () => {
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_PATH, {
      status: 400,
      json: {
        error: 'invalid_grant',
        error_description: 'AADSTS50126: Invalid username or password.',
      },
    });
    const error = await credential(fake)
      .authenticate(['Mail.ReadWrite'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).message).toContain('AADSTS50126');
  });

  it('does not sign in automatically', async () => {
    // Python passes disable_automatic_authentication=True.
    const fake = createFakeFetch();
    await expect(
      credential(fake).getToken(['Mail.ReadWrite']),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(fake.requests).toEqual([]);
  });

  it('serves the cached token, then refreshes it near expiry', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fake = createFakeFetch();
    fake.on(
      'POST',
      TOKEN_PATH,
      { json: tokenResponse('at1') },
      { json: tokenResponse('at2') },
    );
    const cred = credential(fake);
    await cred.authenticate(['Mail.ReadWrite']);
    expect((await cred.getToken(['Mail.ReadWrite'])).token).toBe('at1');
    expect(fake.requests).toHaveLength(1);

    // Within MSAL's 5-minute margin the token counts as expired.
    vi.setSystemTime(1_000_000 + (3600 - 299) * 1000);
    const refreshed = await cred.getToken('Mail.ReadWrite');
    expect(refreshed.token).toBe('at2');
    expect(form(fake.requests[1]?.body ?? '')).toEqual({
      client_id: 'cid',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-at1',
      scope: 'Mail.ReadWrite openid profile offline_access',
      client_info: '1',
      client_secret: 'the-secret',
    });
  });

  it('asks for authentication when the refresh fails', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fake = createFakeFetch();
    fake.on(
      'POST',
      TOKEN_PATH,
      { json: tokenResponse('at1') },
      { status: 400, json: { error: 'invalid_grant' } },
    );
    const cred = credential(fake);
    await cred.authenticate(['Mail.ReadWrite']);
    vi.setSystemTime(1_000_000 + 3600 * 1000);
    await expect(cred.getToken(['Mail.ReadWrite'])).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
  });
});

describe('buildAuthRecord', () => {
  it('falls back to sub, the issuer path and upn (ADFS)', () => {
    expect(
      buildAuthRecord({
        access_token: 'x',
        id_token: fakeIdToken({
          aud: 'cid',
          iss: 'https://adfs.example.test/adfs',
          upn: 'user@example.test',
          sub: 'subject',
        }),
      }),
    ).toEqual({
      authority: 'adfs.example.test',
      clientId: 'cid',
      homeAccountId: 'subject',
      tenantId: 'adfs',
      username: 'user@example.test',
      version: '1.0',
    });
  });

  it('rejects an unexpected id token', () => {
    expect(() => buildAuthRecord({ access_token: 'x' })).toThrow(
      'Failed to build AuthenticationRecord from unexpected identity token',
    );
  });
});
