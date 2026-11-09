// Credential and connect() tests, ported from mailsuite's
// tests/test_mailbox_graph.py (TestAuthMethodNames, TestClientAssertionAuth,
// TestCacheName, TestSharedMailboxScopes, TestCacheAuthRecord). The
// azure-identity credential classes are replaced at the SDK boundary so the
// tests can assert on what each one is constructed with.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AuthenticationRecord } from '@azure/identity';
import { captureLogs, WARNING } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enableCachePersistence } from './cache-persistence';
import {
  AuthMethod,
  cacheAuthRecord,
  DEFAULT_TOKEN_CACHE_NAME,
  generateCredential,
  getCacheArgs,
} from './credentials';
import { MSGraphConnection } from './graph';
import { UsernamePasswordCredential } from './ropc';
import { createFakeFetch } from './test/fake-fetch';
import { TOKEN_PATH, tokenResponse } from './test/token';

const identity = vi.hoisted(() => {
  interface Constructed {
    name: string;
    args: unknown[];
  }
  const constructed: Constructed[] = [];
  const authenticateCalls: unknown[] = [];
  const getTokenCalls: unknown[] = [];
  const record = {
    authority: 'login.microsoftonline.com',
    homeAccountId: 'home-id',
    tenantId: 'tenant',
    username: 'owner@example.com',
    clientId: 'cid',
    version: '1.0',
  };

  class FakeCredential {
    readonly args: unknown[];

    constructor(...args: unknown[]) {
      this.args = args;
      constructed.push({ name: new.target.name, args });
    }

    getToken(scopes: unknown): Promise<{
      token: string;
      expiresOnTimestamp: number;
    }> {
      getTokenCalls.push(scopes);
      return Promise.resolve({
        token: 'token',
        expiresOnTimestamp: Date.now() + 3_600_000,
      });
    }
  }

  class DeviceCodeCredential extends FakeCredential {
    authenticate(scopes: unknown): Promise<typeof record> {
      authenticateCalls.push(scopes);
      return Promise.resolve(record);
    }
  }

  class ClientSecretCredential extends FakeCredential {}
  class ClientCertificateCredential extends FakeCredential {}

  class ClientAssertionCredential extends FakeCredential {
    authenticate(): never {
      throw new Error('authenticate() must not run for app-only auth');
    }
  }

  return {
    constructed,
    authenticateCalls,
    getTokenCalls,
    record,
    classes: {
      DeviceCodeCredential,
      ClientSecretCredential,
      ClientCertificateCredential,
      ClientAssertionCredential,
    },
  };
});

vi.mock('@azure/identity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...identity.classes,
}));

vi.mock('./cache-persistence', () => ({
  enableCachePersistence: vi.fn(() => Promise.resolve({ status: 'enabled' })),
}));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'tsdmarc-msgraph-'));
  identity.constructed.length = 0;
  identity.authenticateCalls.length = 0;
  identity.getTokenCalls.length = 0;
});

afterEach(async () => {
  vi.mocked(enableCachePersistence).mockResolvedValue({ status: 'enabled' });
  await rm(directory, { recursive: true, force: true });
});

function lastConstructed(): { name: string; args: unknown[] } {
  const last = identity.constructed.at(-1);
  if (last === undefined) {
    throw new Error('no credential was constructed');
  }
  return last;
}

describe('TestAuthMethodNames', () => {
  it('has the enum names', () => {
    expect(Object.keys(AuthMethod)).toEqual([
      'DeviceCode',
      'UsernamePassword',
      'ClientSecret',
      'Certificate',
      'ClientAssertion',
    ]);
    expect(AuthMethod.DeviceCode).toBe(1);
    expect(AuthMethod.ClientSecret).toBe(3);
  });

  it('rejects an unknown auth method', async () => {
    await expect(
      generateCredential('BogusAuth', path.join(directory, 'tok')),
    ).rejects.toThrow('Auth method BogusAuth not found');
  });

  it('requires certificatePath for Certificate', async () => {
    await expect(
      generateCredential('Certificate', path.join(directory, 'tok'), {
        clientId: 'c',
        tenantId: 't',
      }),
    ).rejects.toThrow(/certificate_path/u);
  });

  it('builds a certificate credential', async () => {
    await generateCredential('Certificate', path.join(directory, 'tok'), {
      clientId: 'c',
      tenantId: 't',
      certificatePath: '/certs/app.pem',
      certificatePassword: new TextEncoder().encode('pw'),
    });
    expect(lastConstructed()).toEqual({
      name: 'ClientCertificateCredential',
      args: [
        't',
        'c',
        { certificatePath: '/certs/app.pem', certificatePassword: 'pw' },
      ],
    });
  });

  it('builds a client secret credential', async () => {
    await generateCredential('ClientSecret', path.join(directory, 'tok'), {
      clientId: 'c',
      tenantId: 't',
      clientSecret: 's',
    });
    expect(lastConstructed()).toEqual({
      name: 'ClientSecretCredential',
      args: ['t', 'c', 's'],
    });
  });

  it('wires the client assertion provider', async () => {
    await generateCredential('ClientAssertion', path.join(directory, 'tok'), {
      clientId: 'c',
      tenantId: 't',
      clientAssertionProvider: () => 'the-assertion',
    });
    const { name, args } = lastConstructed();
    expect(name).toBe('ClientAssertionCredential');
    expect(args.slice(0, 2)).toEqual(['t', 'c']);
    // The credential calls it to obtain the assertion it exchanges.
    const getAssertion = args[2] as () => Promise<string>;
    expect(await getAssertion()).toBe('the-assertion');
  });

  it('requires a client assertion provider', async () => {
    await expect(
      generateCredential('ClientAssertion', path.join(directory, 'tok'), {
        clientId: 'c',
        tenantId: 't',
      }),
    ).rejects.toThrow(/client_assertion/u);
  });
});

describe('TestClientAssertionAuth', () => {
  function connect(clientAssertion: string): Promise<MSGraphConnection> {
    return MSGraphConnection.connect({
      authMethod: 'ClientAssertion',
      mailbox: 'user@example.com',
      clientId: 'c',
      clientSecret: null,
      username: null,
      password: null,
      tenantId: 't',
      tokenFile: path.join(directory, 'unused-token'),
      allowUnencryptedStorage: false,
      graphUrl: 'https://graph.example.test',
      clientAssertion,
    });
  }

  it('wraps a static assertion in a provider', async () => {
    await connect('abc');
    const getAssertion = lastConstructed().args[2] as () => Promise<string>;
    expect(await getAssertion()).toBe('abc');
  });

  it('skips authenticate()', async () => {
    // The fake's authenticate() throws; a clean connect proves app-only
    // auth never calls it, and no token request happens yet.
    const conn = await connect('abc');
    expect(conn.mailboxName).toBe('user@example.com');
    expect(identity.getTokenCalls).toEqual([]);
    expect(existsSync(path.join(directory, 'unused-token'))).toBe(false);
  });
});

describe('TestCacheName', () => {
  it('has the default constant', () => {
    expect(DEFAULT_TOKEN_CACHE_NAME).toBe('mailsuite');
  });

  it('passes the default cache name through', async () => {
    await generateCredential('DeviceCode', path.join(directory, 'tok'), {
      clientId: 'c',
      tenantId: 't',
      allowUnencryptedStorage: true,
    });
    const { name, args } = lastConstructed();
    expect(name).toBe('DeviceCodeCredential');
    expect(args[0]).toEqual({
      clientId: 'c',
      disableAutomaticAuthentication: true,
      tenantId: 't',
      tokenCachePersistenceOptions: {
        enabled: true,
        name: 'mailsuite',
        unsafeAllowUnencryptedStorage: true,
      },
    });
  });

  it('passes an overridden cache name through', async () => {
    await generateCredential('DeviceCode', path.join(directory, 'tok'), {
      clientId: 'c',
      tenantId: 't',
      allowUnencryptedStorage: false,
      cacheName: 'parsedmarc',
    });
    expect(lastConstructed().args[0]).toMatchObject({
      tokenCachePersistenceOptions: {
        name: 'parsedmarc',
        unsafeAllowUnencryptedStorage: false,
      },
    });
  });

  it('builds a confidential UsernamePassword credential', async () => {
    // Python passes client_credential=client_secret (a confidential MSAL
    // client) and no tenant ("organizations").
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_PATH, { json: tokenResponse('at') });
    const credential = await generateCredential(
      'UsernamePassword',
      path.join(directory, 'tok'),
      {
        clientId: 'c',
        clientSecret: 's',
        username: 'u',
        password: 'p',
        tenantId: 't',
        allowUnencryptedStorage: true,
        cacheName: 'parsedmarc',
        fetch: fake.fetch,
      },
    );
    expect(credential).toBeInstanceOf(UsernamePasswordCredential);
    await (credential as UsernamePasswordCredential).authenticate([
      'Mail.ReadWrite',
    ]);
    const body = new URLSearchParams(fake.requests[0]?.body);
    expect(body.get('client_secret')).toBe('s');
    expect(body.get('client_id')).toBe('c');
    expect(body.get('username')).toBe('u');
  });

  it('rejects a malformed token file for UsernamePassword, like Python', async () => {
    const tokenPath = path.join(directory, 'tok');
    await writeFile(tokenPath, 'not json');
    await expect(
      generateCredential('UsernamePassword', tokenPath, {
        clientId: 'c',
        username: 'u',
        password: 'p',
      }),
    ).rejects.toThrow();
  });

  it('loads a saved AuthenticationRecord', async () => {
    const tokenPath = path.join(directory, 'tok');
    await writeFile(tokenPath, JSON.stringify(identity.record));
    const args = await getCacheArgs(tokenPath, false, 'parsedmarc');
    expect(args.authenticationRecord).toEqual(identity.record);
  });

  it('reads a record written by Python', async () => {
    const tokenPath = path.join(directory, 'tok');
    await writeFile(
      tokenPath,
      '{"authority": "login.microsoftonline.com", "clientId": "cid", "homeAccountId": "home-id", "tenantId": "tenant", "username": "owner@example.com", "version": "1.0"}',
    );
    const args = await getCacheArgs(tokenPath, false);
    expect(args.authenticationRecord).toEqual(identity.record);
  });

  it('warns and keeps tokens in memory without the persistence plugin', async () => {
    vi.mocked(enableCachePersistence).mockResolvedValue({ status: 'missing' });
    const capture = captureLogs();
    try {
      const args = await getCacheArgs(path.join(directory, 'tok'), false);
      expect(args).toEqual({});
      expect(capture.records.map(record => record.level)).toEqual([WARNING]);
      expect(capture.records[0]?.message).toMatch(/^Install /u);
    } finally {
      capture.restore();
    }
  });

  it('says when the persistence plugin is installed but fails to load', async () => {
    vi.mocked(enableCachePersistence).mockResolvedValue({
      status: 'failed',
      error: new Error('keytar.node: invalid ELF header'),
    });
    const capture = captureLogs();
    try {
      const args = await getCacheArgs(path.join(directory, 'tok'), false);
      expect(args).toEqual({});
      expect(capture.records.map(record => record.message)).toEqual([
        'Failed to load @azure/identity-cache-persistence (keytar.node: invalid ELF header); the Microsoft Graph token cache is kept in memory only',
      ]);
    } finally {
      capture.restore();
    }
  });
});

describe('TestSharedMailboxScopes', () => {
  // When mailbox != username, the Mail.ReadWrite.Shared scope is requested
  // instead of Mail.ReadWrite: the only signal of a shared mailbox.
  function connect(
    mailbox: string,
    username: string,
  ): Promise<MSGraphConnection> {
    return MSGraphConnection.connect({
      authMethod: 'DeviceCode',
      mailbox,
      clientId: 'cid',
      clientSecret: 'secret',
      username,
      password: 'pass',
      tenantId: 'tenant',
      tokenFile: path.join(directory, 'token'),
      allowUnencryptedStorage: true,
    });
  }

  it('uses the shared scope for a shared mailbox', async () => {
    await connect('shared@example.com', 'owner@example.com');
    expect(identity.authenticateCalls).toEqual([['Mail.ReadWrite.Shared']]);
  });

  it('uses the personal scope for the own mailbox', async () => {
    await connect('user@example.com', 'user@example.com');
    expect(identity.authenticateCalls).toEqual([['Mail.ReadWrite']]);
  });

  it('saves the AuthenticationRecord and uses the delegated scope', async () => {
    const conn = await connect('user@example.com', 'user@example.com');
    const saved = JSON.parse(
      await readFile(path.join(directory, 'token'), 'utf8'),
    ) as AuthenticationRecord;
    expect(saved).toEqual(identity.record);
    expect(conn.client.baseUrl).toBe('https://graph.microsoft.com/v1.0');
  });

  it('signs in UsernamePassword with the client secret and saves the record', async () => {
    const fake = createFakeFetch();
    fake.on('POST', TOKEN_PATH, { json: tokenResponse('at') });
    const tokenPath = path.join(directory, 'token');
    await MSGraphConnection.connect({
      authMethod: 'UsernamePassword',
      mailbox: 'user@example.com',
      clientId: 'cid',
      clientSecret: 'secret',
      username: 'user@example.com',
      password: 'pass',
      tenantId: 'tenant',
      tokenFile: tokenPath,
      allowUnencryptedStorage: true,
      fetch: fake.fetch,
    });
    expect(fake.requests).toHaveLength(1);
    const body = new URLSearchParams(fake.requests[0]?.body);
    expect(body.get('grant_type')).toBe('password');
    expect(body.get('client_secret')).toBe('secret');
    expect(body.get('scope')).toBe(
      'Mail.ReadWrite openid profile offline_access',
    );
    // Same JSON as Python's AuthenticationRecord.serialize().
    expect(JSON.parse(await readFile(tokenPath, 'utf8'))).toEqual({
      authority: 'login.microsoftonline.com',
      clientId: 'cid',
      homeAccountId: 'uid.utid',
      tenantId: 'tenant-guid',
      username: 'user@example.com',
      version: '1.0',
    });
  });
});

describe('TestCacheAuthRecord', () => {
  it('creates nested parent directories', async () => {
    const tokenPath = path.join(directory, 'subdir', 'nested', '.token');
    expect(existsSync(path.join(directory, 'subdir'))).toBe(false);
    await cacheAuthRecord(identity.record, tokenPath);
    expect(JSON.parse(await readFile(tokenPath, 'utf8'))).toEqual(
      identity.record,
    );
  });

  it('overwrites an existing file', async () => {
    const tokenPath = path.join(directory, '.token');
    await cacheAuthRecord(identity.record, tokenPath);
    await cacheAuthRecord({ ...identity.record, username: 'other' }, tokenPath);
    expect(JSON.parse(await readFile(tokenPath, 'utf8'))).toMatchObject({
      username: 'other',
    });
  });
});

describe('TestGraphUrl via connect()', () => {
  // mailsuite builds the connection through its constructor (ClientSecret
  // auth, credential stubbed) and checks the HTTP client's base URL: here,
  // connect() must pass graphUrl on to the Graph client.
  it.each([
    'https://graph.microsoft.us',
    'https://dod-graph.microsoft.us',
    'https://microsoftgraph.chinacloudapi.cn',
    'https://graph.microsoft.de',
    'https://graph.example.test',
    'https://graph.microsoft.us/', // trailing slash stripped
  ])('test_overrides_base_url: %s', async url => {
    const conn = await MSGraphConnection.connect({
      authMethod: 'ClientSecret',
      mailbox: 'user@example.com',
      clientId: 'c',
      clientSecret: 's',
      username: null,
      password: null,
      tenantId: 't',
      tokenFile: path.join(directory, 'unused-token'),
      allowUnencryptedStorage: false,
      graphUrl: url,
    });
    const base = conn.client.baseUrl;
    expect(base).toContain(url.replace(/\/$/u, ''));
    expect(base.endsWith('/v1.0')).toBe(true);
  });
});
