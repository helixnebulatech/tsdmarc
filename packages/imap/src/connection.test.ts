// Port of mailsuite tests/test_mailbox_imap.py, against the fake imapflow
// (mailsuite mocks its own IMAPClient; here only the SDK is faked, so the
// assertions are on the IMAP operations sent).
//
// tests/test_imap_idle_integration.py is not ported: it needs a live IMAP
// server (a Dovecot container) to drop connections mid-IDLE. The reconnect
// path it covers is exercised against the fake in client.test.ts.

import {
  captureLogs,
  FolderExistsError,
  MailboxConnection,
  NotImplementedError,
  WARNING,
} from 'tsdmarc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAPConnection } from './connection';
import {
  callsOf,
  failNext,
  type FakeServer,
  imapflowError,
  resetServer,
} from './test/fake-imapflow';

vi.mock('imapflow', async () => {
  const fake = await import('./test/fake-imapflow');
  return { ImapFlow: fake.FakeImapFlow };
});

let fake: FakeServer;

beforeEach(() => {
  fake = resetServer();
});

async function connected(): Promise<IMAPConnection> {
  const connection = await IMAPConnection.connect('imap.example.com', 'user', {
    password: 'pw',
  });
  fake.calls.length = 0;
  return connection;
}

describe('IMAPConnection', () => {
  it('is a MailboxConnection of kind imap', async () => {
    const conn = await connected();
    expect(conn).toBeInstanceOf(MailboxConnection);
    expect(conn.kind).toBe('imap');
  });

  it('identifies the account, since UIDs are only unique within it', () => {
    const identity = (user: string, port?: number): string =>
      new IMAPConnection('imap.example.com', user, { password: 'x', port })
        .mailboxIdentity;
    expect(identity('a')).toBe('a@imap.example.com:993');
    expect(identity('a')).toBe(identity('a', 993));
    expect(identity('a')).not.toBe(identity('b'));
    expect(identity('a')).not.toBe(identity('a', 143));
  });

  it('passes the connection options to imapflow', async () => {
    await IMAPConnection.connect('imap.example.com', 'user', {
      password: 'pw',
      port: 1993,
      verify: false,
      timeout: 10,
    });
    expect(fake.instances[0]?.options).toMatchObject({
      host: 'imap.example.com',
      port: 1993,
      secure: true,
      tls: { rejectUnauthorized: false },
      auth: { user: 'user', pass: 'pw' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 2 ** 31 - 1,
    });
  });

  it('requires STARTTLS without ssl, also when watching', async () => {
    fake.starttls = true;
    const strict = await IMAPConnection.connect('h', 'user', {
      password: 'pw',
      ssl: false,
    });
    expect(fake.instances[0]?.options.doSTARTTLS).toBe(true);
    const states = [false];
    await strict.watch({
      checkCallback: () => undefined,
      checkTimeout: 1,
      configReloading: () => states.shift() ?? true,
    });
    expect(fake.instances[1]?.options.doSTARTTLS).toBe(true);
  });

  // mailsuite 2.3.3 tests/test_mailbox_imap.py
  it('test_starttls_forwarded_to_client', async () => {
    fake.starttls = true;
    const conn = await IMAPConnection.connect('h', 'user', {
      password: 'pw',
      port: 143,
      ssl: false,
      starttls: false,
    });
    expect(fake.instances[0]?.options).toMatchObject({
      secure: false,
      doSTARTTLS: false,
    });
    // The watch loop builds its own IMAPClient; it must carry the choice
    // too, or watch mode would silently upgrade again.
    const states = [false];
    await conn.watch({
      checkCallback: () => undefined,
      checkTimeout: 1,
      configReloading: () => states.shift() ?? true,
    });
    expect(fake.instances[1]?.options.doSTARTTLS).toBe(false);
    expect(callsOf('starttls')).toEqual([]);
  });

  it('creates a folder', async () => {
    const conn = await connected();
    await conn.createFolder('Reports');
    expect(callsOf('mailboxCreate')).toEqual([['Reports']]);
  });

  it('renames a folder', async () => {
    const conn = await connected();
    await conn.renameFolder('Reports', 'Archive');
    expect(callsOf('mailboxRename')).toEqual([['Reports', 'Archive']]);
  });

  it('refuses a rename onto an existing folder', async () => {
    fake.folders.push({ path: 'Archive', delimiter: '/' });
    const conn = await connected();
    await expect(conn.renameFolder('Reports', 'Archive')).rejects.toThrow(
      FolderExistsError,
    );
    expect(callsOf('mailboxRename')).toEqual([]);
  });

  it('reports whether a folder exists', async () => {
    fake.folders.push({ path: 'Reports', delimiter: '/' });
    const conn = await connected();
    expect(await conn.folderExists('Reports')).toBe(true);
    expect(await conn.folderExists('Nope')).toBe(false);
  });

  it('deletes a folder', async () => {
    const conn = await connected();
    await conn.deleteFolder('Junk');
    expect(callsOf('mailboxDelete')).toEqual([['Junk']]);
  });

  it('moves a folder by renaming it to the full target path', async () => {
    fake.folders.push(
      { path: 'Archive/Forensic', delimiter: '/' },
      { path: 'Reports', delimiter: '/' },
    );
    const conn = await connected();
    await conn.moveFolder('Archive/Forensic', { newParent: 'Reports' });
    expect(callsOf('mailboxRename')).toEqual([
      ['Archive/Forensic', 'Reports/Forensic'],
    ]);
  });

  it('fetches all messages of a folder', async () => {
    fake.messages.set(1, Buffer.from('a')).set(2, Buffer.from('b'));
    const conn = await connected();
    expect(await conn.fetchMessages('INBOX')).toEqual([1, 2]);
    expect(fake.calls).toEqual([
      ['mailboxOpen', 'INBOX'],
      ['search', { all: true }, { uid: true }],
    ]);
  });

  it('fetches messages since a date', async () => {
    const conn = await connected();
    await conn.fetchMessages('INBOX', { since: '01-Jan-2026' });
    expect(callsOf('search')).toEqual([
      [{ since: new Date('2026-01-01T00:00:00Z') }, { uid: true }],
    ]);
  });

  it('fetches a message', async () => {
    fake.messages.set(42, Buffer.from('raw msg'));
    const conn = await connected();
    expect(await conn.fetchMessage(42)).toBe('raw msg');
    expect(callsOf('fetchOne')).toEqual([
      ['42', { source: true }, { uid: true }],
    ]);
  });

  it('deletes a message', async () => {
    const conn = await connected();
    await conn.deleteMessage(42);
    expect(callsOf('messageFlagsAdd')).toEqual([
      [[42], ['\\Deleted'], { uid: true, silent: true }],
    ]);
    expect(callsOf('messageDelete')).toEqual([[[42], { uid: true }]]);
  });

  it('falls back to flag + expunge when a delete fails', async () => {
    failNext('messageDelete', false);
    const capture = captureLogs(undefined, WARNING);
    try {
      const conn = await connected();
      await conn.deleteMessage(42);
      expect(capture.output).toEqual([
        'WARNING:tsdmarc:IMAP delete fallback for message 42 due to server error: EXPUNGE command failed',
      ]);
    } finally {
      capture.restore();
    }
    expect(callsOf('messageFlagsAdd')).toEqual([
      [[42], ['\\Deleted'], { uid: true, silent: true }],
      [[42], ['\\Deleted'], { uid: true, silent: true }],
    ]);
    // The fallback's plain EXPUNGE.
    expect(callsOf('messageDelete').at(-1)).toEqual([{ deleted: true }]);
  });

  it('moves a message', async () => {
    const conn = await connected();
    await conn.moveMessage(42, 'Archive');
    expect(callsOf('messageMove')).toEqual([[[42], 'Archive', { uid: true }]]);
  });

  it('falls back to copy + delete when a move fails', async () => {
    // MOVE fails, then so does the client's own COPY fallback: the
    // connection-level fallback copies and deletes.
    failNext('messageMove', false);
    failNext('messageCopy', false);
    const capture = captureLogs(undefined, WARNING);
    try {
      const conn = await connected();
      await conn.moveMessage(42, 'Archive');
      expect(capture.output).toEqual([
        'WARNING:tsdmarc:IMAP move fallback for message 42 due to server error: COPY command failed',
      ]);
    } finally {
      capture.restore();
    }
    expect(callsOf('messageCopy')).toEqual([
      [[42], 'Archive', { uid: true }],
      [[42], 'Archive', { uid: true }],
    ]);
    expect(callsOf('messageDelete')).toEqual([[[42], { uid: true }]]);
  });

  it('keepalive sends NOOP', async () => {
    const conn = await connected();
    await conn.keepalive();
    expect(fake.calls).toEqual([['noop']]);
  });

  it('sendMessage throws NotImplementedError', async () => {
    const conn = await connected();
    await expect(
      conn.sendMessage({ messageFrom: 'a@example.com' }),
    ).rejects.toThrow(NotImplementedError);
    await expect(
      conn.sendMessage({ messageFrom: 'a@example.com' }),
    ).rejects.toThrow(/IMAP/u);
  });

  it('close logs out', async () => {
    const conn = await connected();
    await conn.close();
    expect(fake.calls).toEqual([['logout']]);
  });

  it('forwards OAuth2 options to the client', async () => {
    await IMAPConnection.connect('host', 'u@example.com', {
      oauth2TokenProvider: () => 'tok',
      oauth2Mechanism: 'OAUTHBEARER',
    });
    expect(fake.instances[0]?.options.auth).toEqual({
      user: 'u@example.com',
      accessToken: 'tok',
    });
  });
});

describe('IMAPConnection.watch', () => {
  it('returns before connecting when configReloading is truthy', async () => {
    const conn = await connected();
    let calls = 0;
    await conn.watch({
      checkCallback: () => {
        calls += 1;
      },
      checkTimeout: 1,
      configReloading: () => true,
    });
    expect(calls).toBe(0);
    expect(fake.instances).toHaveLength(1);
  });

  it('opens an IDLE connection that honors configReloading', async () => {
    const conn = await connected();
    const original = conn.imapClient;
    const states = [false];
    const seen: unknown[] = [];
    await conn.watch({
      checkCallback: connection => {
        seen.push(connection);
      },
      checkTimeout: 1,
      // False once (enter the loop and connect), then true: the IDLE loop
      // itself exits on it, then watch() does.
      configReloading: () => states.shift() ?? true,
    });
    expect(seen).toEqual([conn]);
    // A second connection, with IDLE started and ended on it.
    expect(fake.instances).toHaveLength(2);
    expect(fake.calls.map(([method]) => method)).toEqual([
      'connect',
      'list',
      'mailboxOpen',
      'logout',
      'idle',
      'noop',
    ]);
    // The watch connection replaced (and logged out) the original one.
    expect(conn.imapClient).not.toBe(original);
  });

  it('logs and reconnects after a connection error', async () => {
    const conn = await connected();
    failNext('connect', imapflowError('connect ECONNREFUSED', 'ECONNREFUSED'));
    const states = [false, false];
    const capture = captureLogs(undefined, WARNING);
    try {
      await conn.watch({
        checkCallback: () => undefined,
        checkTimeout: 0,
        configReloading: () => states.shift() ?? true,
      });
      expect(capture.output).toEqual([
        "WARNING:tsdmarc:IMAP connection error: error('connect ECONNREFUSED'). Reconnecting...",
      ]);
    } finally {
      capture.restore();
    }
  });

  // mailsuite 2.3.4 tests/test_mailbox_imap.py: fails on 2.3.3 and
  // earlier, which reported every IMAPClientError in the watch loop as a
  // "timeout", hiding the STARTTLS refusal (GHSA-3588-2mr7-vrcm).
  it('test_watch_logs_client_error_text_and_retries', async () => {
    const refusal =
      'The IMAP server does not advertise STARTTLS, so credentials would be sent in plain text. Use ssl=True for implicit TLS, or pass starttls=False to allow plain-text authentication';
    fake.starttls = true;
    const conn = await IMAPConnection.connect('h', 'user', {
      password: 'pw',
      ssl: false,
    });
    fake.starttls = false;
    fake.calls.length = 0;
    // Enter the loop once, then stop after the failed attempt.
    const states = [false, true];
    const capture = captureLogs(undefined, WARNING);
    try {
      await conn.watch({
        checkCallback: () => undefined,
        checkTimeout: 0,
        configReloading: () => states.shift() ?? true,
      });
      expect(fake.instances).toHaveLength(2);
      // Failed in connect(), before the login and the first LIST.
      expect(fake.calls.map(([method]) => method)).toEqual([
        'connect',
        'close',
      ]);
      expect(capture.output).toEqual([
        `WARNING:tsdmarc:IMAP connection error: error('${refusal}'). Reconnecting...`,
      ]);
      expect(capture.output.join('\n')).not.toContain('timeout');
    } finally {
      capture.restore();
    }
  });

  it('logs other errors as connection errors', async () => {
    const conn = await connected();
    const states = [false];
    const capture = captureLogs(undefined, WARNING);
    try {
      await conn.watch({
        checkCallback: () => {
          throw new Error('callback broke');
        },
        checkTimeout: 0,
        configReloading: () => states.shift() ?? true,
      });
      expect(capture.output).toEqual([
        "WARNING:tsdmarc:IMAP connection error: Exception('callback broke'). Reconnecting...",
      ]);
    } finally {
      capture.restore();
    }
  });
});
