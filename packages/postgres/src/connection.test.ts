// libpq semantics for pg: sslmode, ~/.postgresql certificates, the Unix
// socket default, connect_timeout and keepalives. Expected behavior and error
// messages come from libpq 18 through psycopg (the venv's psycopg-binary).

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ClientConfig } from 'pg';
import { captureLogs } from 'tsdmarc';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type ConnectionContext,
  canFallBack,
  resolveConnection,
  resolveConnectTimeout,
} from './connection';
import { parseConnectionString } from './dsn';

let home: string;
let socketDirs: string[];

function context(
  env: Record<string, string> = {},
  platform: NodeJS.Platform = 'linux',
): ConnectionContext {
  return { env, homeDir: home, platform, socketDirectories: socketDirs };
}

function resolve(
  dsn: string,
  env: Record<string, string> = {},
  connectTimeout?: number,
): ReturnType<typeof resolveConnection> {
  return resolveConnection(
    parseConnectionString(dsn),
    connectTimeout,
    context(env),
  );
}

function sslOf(attempt: ClientConfig | undefined): Record<string, unknown> {
  return (attempt?.ssl ?? {}) as Record<string, unknown>;
}

function writePostgresFile(
  name: string,
  content: string,
  mode = 0o600,
): string {
  const directory = path.join(home, '.postgresql');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'tsdmarc-pg-'));
  socketDirs = [path.join(home, 'run'), path.join(home, 'tmp')];
});

describe('sslmode', () => {
  it('defaults to prefer: TLS without verification, then plain', async () => {
    const [first, second, ...rest] = await resolve('host=db');
    expect(first?.ssl).toEqual({ rejectUnauthorized: false });
    expect(second?.ssl).toBe(false);
    expect(rest).toEqual([]);
  });

  it('takes PGSSLMODE from the environment', async () => {
    const attempts = await resolve('host=db', { PGSSLMODE: 'disable' });
    expect(attempts.map(attempt => attempt.ssl)).toEqual([false]);
  });

  it('allow tries plain first, then TLS', async () => {
    const attempts = await resolve('host=db sslmode=allow');
    expect(attempts.map(attempt => attempt.ssl)).toEqual([
      false,
      { rejectUnauthorized: false },
    ]);
  });

  it('require encrypts without verifying the certificate', async () => {
    const attempts = await resolve('host=db sslmode=require');
    expect(attempts.map(attempt => attempt.ssl)).toEqual([
      { rejectUnauthorized: false },
    ]);
  });

  it('require verifies the chain (not the name) when root.crt exists', async () => {
    writePostgresFile('root.crt', 'CA');
    const [attempt] = await resolve('host=db sslmode=require');
    const ssl = attempt?.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(String(ssl.ca)).toBe('CA');
    expect(typeof ssl.checkServerIdentity).toBe('function');
  });

  it('verify-ca checks the chain only; verify-full also the host name', async () => {
    const ca = writePostgresFile('my-ca.pem', 'MYCA');
    const [verifyCa] = await resolve(
      `host=db sslmode=verify-ca sslrootcert=${ca}`,
    );
    const caSsl = verifyCa?.ssl as Record<string, unknown>;
    expect(caSsl.rejectUnauthorized).toBe(true);
    expect(String(caSsl.ca)).toBe('MYCA');
    expect(typeof caSsl.checkServerIdentity).toBe('function');

    const [verifyFull] = await resolve('host=db sslmode=verify-full', {
      PGSSLROOTCERT: ca,
    });
    const fullSsl = verifyFull?.ssl as Record<string, unknown>;
    expect(fullSsl.rejectUnauthorized).toBe(true);
    expect(fullSsl.checkServerIdentity).toBeUndefined();
  });

  it('refuses verify-* without a root certificate, like libpq', async () => {
    await expect(resolve('host=db sslmode=verify-full')).rejects.toThrow(
      `root certificate file "${path.join(home, '.postgresql', 'root.crt')}" does not exist\nEither provide the file, use the system's trusted roots with sslrootcert=system, or change sslmode to disable server certificate verification.`,
    );
  });

  it('sslrootcert=system defaults to and requires verify-full', async () => {
    const [attempt, ...rest] = await resolve('host=db sslrootcert=system');
    expect(attempt?.ssl).toEqual({ rejectUnauthorized: true });
    expect(rest).toEqual([]);
    await expect(
      resolve('host=/socket sslmode=disable sslrootcert=system'),
    ).rejects.toThrow(
      'weak sslmode "disable" may not be used with sslrootcert=system (use "verify-full")',
    );
  });

  it('rejects an unknown sslmode', async () => {
    await expect(resolve('host=db sslmode=bogus')).rejects.toThrow(
      'invalid sslmode value: "bogus"',
    );
  });

  it('never uses TLS over a Unix socket', async () => {
    const attempts = await resolve('host=/var/run/postgresql sslmode=require');
    expect(attempts.map(attempt => attempt.ssl)).toEqual([false]);
  });

  it('sends the client certificate from ~/.postgresql', async () => {
    writePostgresFile('postgresql.crt', 'CERT');
    writePostgresFile('postgresql.key', 'KEY');
    const [attempt] = await resolve('host=db sslmode=require');
    const ssl = attempt?.ssl as Record<string, unknown>;
    expect(String(ssl.cert)).toBe('CERT');
    expect(String(ssl.key)).toBe('KEY');
  });

  it('refuses a certificate without its key, or a readable key', async () => {
    writePostgresFile('postgresql.crt', 'CERT');
    const keyFile = path.join(home, '.postgresql', 'postgresql.key');
    await expect(resolve('host=db sslmode=require')).rejects.toThrow(
      `certificate present, but not private key file "${keyFile}"`,
    );
    writePostgresFile('postgresql.key', 'KEY', 0o644);
    await expect(resolve('host=db sslmode=require')).rejects.toThrow(
      `private key file "${keyFile}" has group or world access`,
    );
  });
});

describe('host and port', () => {
  it('defaults to the Unix socket directory, not TCP localhost', async () => {
    const [attempt] = await resolve('');
    expect(attempt?.host).toBe(socketDirs[0]);
    expect(attempt?.port).toBe(5432);
    expect(attempt?.ssl).toBe(false);
  });

  it('picks the socket directory where the server socket exists', async () => {
    const second = socketDirs[1] ?? '';
    mkdirSync(second, { recursive: true });
    writeFileSync(path.join(second, '.s.PGSQL.5433'), '');
    const [attempt] = await resolve('port=5433');
    expect(attempt?.host).toBe(second);
  });

  it('takes PGHOST and PGPORT from the environment', async () => {
    const [attempt] = await resolve('', { PGHOST: 'db', PGPORT: '6000' });
    expect(attempt?.host).toBe('db');
    expect(attempt?.port).toBe(6000);
  });

  it('uses localhost on Windows', async () => {
    const [attempt] = await resolveConnection(
      new Map(),
      undefined,
      context({}, 'win32'),
    );
    expect(attempt?.host).toBe('localhost');
  });

  it('rejects an invalid port and multiple hosts', async () => {
    await expect(resolve('host=db port=abc')).rejects.toThrow(
      'invalid integer value for connection option "port"',
    );
    await expect(resolve('host=a,b')).rejects.toThrow(
      'multiple hosts in "host" are not supported',
    );
  });

  it('passes the user, password, database and session settings', async () => {
    const [attempt] = await resolve(
      'postgresql://u:p@db/reports?application_name=tsdmarc&options=-c%20search_path%3Ddmarc',
    );
    expect(attempt).toMatchObject({
      user: 'u',
      password: 'p',
      database: 'reports',
      application_name: 'tsdmarc',
      options: '-c search_path=dmarc',
    });
  });

  it.each([
    ['channel_binding=require', {}],
    ['require_auth=scram-sha-256', {}],
    ['require_auth=!password', {}],
    ['requirepeer=postgres', {}],
    ['sslcertmode=require', {}],
    ['gssencmode=require', {}],
    ['', { PGCHANNELBINDING: 'require' }],
    ['', { PGREQUIREAUTH: 'scram-sha-256' }],
    ['', { PGREQUIREPEER: 'postgres' }],
    ['', { PGSSLCERTMODE: 'require' }],
    ['', { PGGSSENCMODE: 'require' }],
  ])(
    'refuses to connect without %s %j, which pg cannot enforce',
    async (option, env) => {
      await expect(resolve(`host=db ${option}`, env)).rejects.toThrow(
        /is not supported: pg cannot enforce it, so the connection was refused/u,
      );
    },
  );

  it('still ignores the same options when they demand nothing', async () => {
    const logs = captureLogs();
    try {
      await resolve('host=db channel_binding=disable gssencmode=prefer');
    } finally {
      logs.restore();
    }
    expect(logs.output).toHaveLength(2);
  });

  it('applies ssl_min/max_protocol_version, also from the environment', async () => {
    const [attempt] = await resolve(
      'host=db sslmode=require ssl_min_protocol_version=TLSv1.3',
      { PGSSLMAXPROTOCOLVERSION: 'TLSv1.3' },
    );
    expect(attempt?.ssl).toMatchObject({
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    });
    await expect(
      resolve('host=db sslmode=require ssl_min_protocol_version=SSLv3'),
    ).rejects.toThrow('invalid ssl_min_protocol_version value: "SSLv3"');
  });

  it('loads the revocation list when verifying, like libpq', async () => {
    writePostgresFile('root.crt', 'CA');
    const crl = writePostgresFile('my.crl', 'MYCRL');
    const [explicit] = await resolve(`host=db sslmode=require sslcrl=${crl}`);
    expect(String(sslOf(explicit).crl)).toBe('MYCRL');
    const [fromEnv] = await resolve('host=db sslmode=require', {
      PGSSLCRL: crl,
    });
    expect(String(sslOf(fromEnv).crl)).toBe('MYCRL');

    writePostgresFile('root.crl', 'DEFAULTCRL');
    const [byDefault] = await resolve('host=db sslmode=require');
    expect(String(sslOf(byDefault).crl)).toBe('DEFAULTCRL');

    await expect(
      resolve(`host=db sslmode=require sslcrl=${crl}.missing`),
    ).rejects.toThrow(/could not read certificate revocation list/u);
  });

  it('does not load a revocation list without verification', async () => {
    const [attempt] = await resolve('host=db sslmode=require sslcrl=/missing');
    expect(attempt?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('refuses sslcrldir, whose revocation checks it cannot apply', async () => {
    await expect(
      resolve('host=db sslmode=require sslcrldir=/crls'),
    ).rejects.toThrow(/sslcrldir is not supported/u);
    // Over a Unix socket there is no TLS, so it is irrelevant, as in libpq.
    await expect(resolve('host=/run/pg sslcrldir=/crls')).resolves.toHaveLength(
      1,
    );
  });

  it('skips the private key permission check on Windows, like libpq', async () => {
    writePostgresFile('postgresql.crt', 'CERT');
    writePostgresFile('postgresql.key', 'KEY', 0o644);
    await expect(resolve('host=db sslmode=require')).rejects.toThrow(
      /has group or world access/u,
    );
    const [attempt] = await resolveConnection(
      parseConnectionString('host=db sslmode=require'),
      undefined,
      context({}, 'win32'),
    );
    expect(String(sslOf(attempt).key)).toBe('KEY');
  });

  it('warns about libpq options pg cannot honor', async () => {
    const logs = captureLogs();
    try {
      await resolve('host=db target_session_attrs=read-write');
      expect(logs.output).toEqual([
        'WARNING:tsdmarc:PostgreSQL connection option "target_session_attrs" is not supported and was ignored',
      ]);
    } finally {
      logs.restore();
    }
  });
});

describe('timeouts and keepalives', () => {
  it('follows psycopg: 130 s default, at least 2 s, 0 means default', () => {
    expect(resolveConnectTimeout(undefined)).toBe(130);
    expect(resolveConnectTimeout('10')).toBe(10);
    expect(resolveConnectTimeout('1')).toBe(2);
    expect(resolveConnectTimeout('0')).toBe(130);
    expect(resolveConnectTimeout(' 7.9 ')).toBe(7);
    expect(() => resolveConnectTimeout('abc')).toThrow(
      "bad value for connect_timeout: 'abc'",
    );
  });

  it("honors the connection string's connect_timeout over the option", async () => {
    const [fromDsn] = await resolve('host=db connect_timeout=5', {}, 60);
    expect(fromDsn?.connectionTimeoutMillis).toBe(5000);
    const [fromOption] = await resolve(
      'host=db',
      { PGCONNECT_TIMEOUT: '9' },
      60,
    );
    expect(fromOption?.connectionTimeoutMillis).toBe(60_000);
    const [fromEnv] = await resolve('host=db', { PGCONNECT_TIMEOUT: '9' });
    expect(fromEnv?.connectionTimeoutMillis).toBe(9000);
  });

  it('turns TCP keepalives on like libpq, unless keepalives=0', async () => {
    const [on] = await resolve('host=db keepalives_idle=30');
    expect(on?.keepAlive).toBe(true);
    expect(on?.keepAliveInitialDelayMillis).toBe(30_000);
    const [off] = await resolve('host=db keepalives=0');
    expect(off?.keepAlive).toBe(false);
  });
});

describe('fallback between attempts', () => {
  it('does not retry when the server cannot be reached', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      syscall: 'connect',
    });
    expect(canFallBack(refused)).toBe(false);
    expect(
      canFallBack(new Error('Connection terminated due to connection timeout')),
    ).toBe(false);
    expect(
      canFallBack(new Error('The server does not support SSL connections')),
    ).toBe(true);
  });
});

describe('malformed connection strings', () => {
  it('never quotes the password in error messages', () => {
    const cases = [
      'postgresql://user:S3cretPass@[::1',
      'postgresql://user:S3cretPass@[::1]x/db',
      'postgresql://user:S3cret%zzPass@db/x',
      'postgresql://db/x?password=S3cret%zzPass',
      'postgresql://db/x?sslpassword=S3cret%zzPass',
    ];
    for (const dsn of cases) {
      expect(() => parseConnectionString(dsn)).toThrow(Error);
      expect(() => parseConnectionString(dsn)).not.toThrow(/S3cret/u);
    }
    expect(() =>
      parseConnectionString('postgresql://user:S3cretPass@[::1'),
    ).toThrow(
      'end of string reached when looking for matching "]" in IPv6 host address in URI: "postgresql://user:***@[::1"',
    );
    // Non-secret tokens are still quoted like libpq.
    expect(() => parseConnectionString('postgresql://db/x?host=%zz')).toThrow(
      'invalid percent-encoded token: "%zz"',
    );
  });
});
