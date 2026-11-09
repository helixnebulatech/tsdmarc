// Port of mailsuite tests/test_imap.py. imapflow is replaced by a fake that
// records the operations sent to the server (see test/fake-imapflow.ts).

import { captureLogs, DEBUG, EmailTooLargeError, ValueError } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chunks, IMAPClient, type IMAPClientOptions } from './client';
import {
  FetchKeyError,
  IMAPClientAbortError,
  IMAPClientError,
  IMAPTimeoutError,
  MaxRetriesExceeded,
} from './errors';
import {
  callsOf,
  failNext,
  type FakeImapFlow,
  type FakeServer,
  imapflowError,
  resetServer,
} from './test/fake-imapflow';

vi.mock('imapflow', async () => {
  const fake = await import('./test/fake-imapflow');
  return { ImapFlow: fake.FakeImapFlow };
});

const PASSWORD_LOGIN: IMAPClientOptions = {
  username: 'u@example.com',
  password: 'secret',
};

let fake: FakeServer;

beforeEach(() => {
  fake = resetServer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connected(options: IMAPClientOptions = {}): Promise<IMAPClient> {
  const client = await IMAPClient.connect('imap.example.com', {
    ...PASSWORD_LOGIN,
    ...options,
  });
  fake.calls.length = 0;
  return client;
}

function timeout(): Error {
  return imapflowError('Socket timeout', 'ETIMEOUT');
}

function serverNo(text: string): Error {
  return Object.assign(new Error('Command failed'), {
    responseStatus: 'NO',
    responseText: text,
  });
}

describe('chunks', () => {
  it('splits into n-sized chunks', () => {
    expect([...chunks([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('yields nothing for an empty list', () => {
    expect([...chunks([], 5)]).toEqual([]);
  });
});

// mailsuite 2.3.4 tests/test_imap.py::TestStartTLS: `starttls` null
// upgrades when advertised (and refuses to log in otherwise), false
// declines, true requires.
describe('TestStartTLS', () => {
  const PLAIN: IMAPClientOptions = {
    ...PASSWORD_LOGIN,
    port: 143,
    ssl: false,
  };
  const UNENCRYPTED_WARNING =
    'WARNING:tsdmarc:Sending IMAP credentials unencrypted because starttls=False';
  const REFUSAL = new IMAPClientError(
    'The IMAP server does not advertise STARTTLS, so credentials would be sent in plain text. Use ssl=True for implicit TLS, or pass starttls=False to allow plain-text authentication',
  );

  async function logs(run: () => Promise<unknown>): Promise<string[]> {
    const capture = captureLogs(undefined, DEBUG);
    try {
      await run();
      return capture.output;
    } finally {
      capture.restore();
    }
  }

  it('test_default_upgrades_when_advertised', async () => {
    fake.starttls = true;
    await IMAPClient.connect('h', PLAIN);
    expect(callsOf('starttls')).toHaveLength(1);
    expect(fake.instances[0]?.loggedIn).toEqual({ secure: true });
  });

  it('test_false_declines_advertised_upgrade', async () => {
    fake.starttls = true;
    const output = await logs(() =>
      IMAPClient.connect('h', { ...PLAIN, starttls: false }),
    );
    expect(callsOf('starttls')).toEqual([]);
    expect(fake.instances[0]?.options.doSTARTTLS).toBe(false);
    expect(fake.instances[0]?.loggedIn).toEqual({ secure: false });
    expect(output).toContain(
      'INFO:tsdmarc:IMAP server supports STARTTLS, but it is disabled ... staying in plain text',
    );
    expect(output).toContain(UNENCRYPTED_WARNING);
    expect(output.join('\n')).not.toContain('activating now');
  });

  it('test_true_upgrades_when_advertised', async () => {
    fake.starttls = true;
    await IMAPClient.connect('h', { ...PLAIN, starttls: true });
    expect(callsOf('starttls')).toHaveLength(1);
  });

  it('test_false_not_advertised_stays_plain_and_warns', async () => {
    const output = await logs(() =>
      IMAPClient.connect('h', { ...PLAIN, starttls: false }),
    );
    expect(callsOf('starttls')).toEqual([]);
    expect(fake.instances[0]?.loggedIn).toEqual({ secure: false });
    expect(output).toContain(UNENCRYPTED_WARNING);
  });

  // Fails on mailsuite 2.3.3, which logged in with the password in plain
  // text when STARTTLS was not advertised (GHSA-3588-2mr7-vrcm).
  it('test_default_not_advertised_raises', async () => {
    await expect(IMAPClient.connect('h', PLAIN)).rejects.toThrow(REFUSAL);
    expect(callsOf('starttls')).toEqual([]);
    expect(fake.instances[0]?.loggedIn).toBeNull();
  });

  // Same for the OAuth2 token.
  it.each(['XOAUTH2', 'OAUTHBEARER'])(
    'test_default_not_advertised_oauth_raises (%s)',
    async mechanism => {
      await expect(
        IMAPClient.connect('h', {
          username: 'u',
          port: 143,
          ssl: false,
          oauth2Token: 'tok123',
          oauth2Mechanism: mechanism,
        }),
      ).rejects.toThrow(REFUSAL);
      expect(callsOf('starttls')).toEqual([]);
      expect(fake.instances[0]?.loggedIn).toBeNull();
    },
  );

  it('test_true_not_advertised_raises', async () => {
    const promise = IMAPClient.connect('h', { ...PLAIN, starttls: true });
    await expect(promise).rejects.toThrow(
      new IMAPClientError('STARTTLS required but not supported by the server'),
    );
    expect(callsOf('starttls')).toEqual([]);
    expect(fake.instances[0]?.loggedIn).toBeNull();
  });

  it.each([null, false, true])(
    'test_ssl_never_calls_starttls (starttls: %s)',
    async starttls => {
      fake.starttls = true;
      await IMAPClient.connect('h', { ...PASSWORD_LOGIN, ssl: true, starttls });
      expect(callsOf('starttls')).toEqual([]);
      expect(fake.instances[0]?.options.doSTARTTLS).toBeUndefined();
    },
  );

  it('test_reset_connection_preserves_starttls', async () => {
    fake.starttls = true;
    const client = await IMAPClient.connect('h', { ...PLAIN, starttls: false });
    await client.resetConnection();
    expect(fake.instances).toHaveLength(2);
    expect(fake.instances[1]?.options.doSTARTTLS).toBe(false);
    expect(callsOf('starttls')).toEqual([]);
  });

  it('starttls: true requires STARTTLS in imapflow too', async () => {
    await IMAPClient.connect('h', { ...PLAIN, starttls: true }).catch(
      () => undefined,
    );
    expect(fake.instances[0]?.options.doSTARTTLS).toBe(true);
  });
});

describe('normaliseFolder', () => {
  function client(fields: Partial<IMAPClient>): IMAPClient {
    return Object.assign(new IMAPClient('h', PASSWORD_LOGIN), {
      hierarchySeparator: '/',
      ...fields,
    });
  }

  it('passes INBOX through', () => {
    expect(client({ pathPrefix: 'INBOX.' }).normaliseFolder('INBOX')).toBe(
      'INBOX',
    );
  });

  it('decodes bytes input', () => {
    expect(client({}).normaliseFolder(new TextEncoder().encode('INBOX'))).toBe(
      'INBOX',
    );
    expect(
      client({}).normaliseFolder(new TextEncoder().encode('Reports/ü')),
    ).toBe('Reports/ü');
  });

  it('translates "/" to the server separator', () => {
    expect(
      client({ hierarchySeparator: '.' }).normaliseFolder('Reports/2026'),
    ).toBe('Reports.2026');
  });

  it('drops literal native separators before translating', () => {
    expect(
      client({ hierarchySeparator: '.' }).normaliseFolder('Re.ports/2026/'),
    ).toBe('Reports.2026');
  });

  it('adds the personal namespace prefix', () => {
    expect(client({ pathPrefix: 'INBOX/' }).normaliseFolder('Reports')).toBe(
      'INBOX/Reports',
    );
  });

  // mailsuite issue #13: shared folders accessed via the "other users"
  // namespace must not get the personal prefix prepended.
  it('passes other-users namespace paths through', () => {
    const c = client({
      pathPrefix: 'INBOX/',
      otherNamespacePrefixes: ['user/'],
    });
    expect(c.normaliseFolder('user/colleague/Inbox')).toBe(
      'user/colleague/Inbox',
    );
    expect(c.normaliseFolder('Reports')).toBe('INBOX/Reports');
  });

  it('strips the prefix only at the start of the path', () => {
    expect(
      client({ pathPrefix: 'INBOX/' }).normaliseFolder('Projects/INBOX/old'),
    ).toBe('INBOX/Projects/INBOX/old');
  });

  it('leaves a prefix that is a substring of a segment alone', () => {
    expect(
      client({ pathPrefix: 'mail/' }).normaliseFolder('Work/sendmail/logs'),
    ).toBe('mail/Work/sendmail/logs');
  });

  it('round-trips an already prefixed path', () => {
    expect(
      client({ pathPrefix: 'INBOX/' }).normaliseFolder('INBOX/Archive/2024'),
    ).toBe('INBOX/Archive/2024');
  });

  it('is applied to every folder operation sent to the server', async () => {
    fake.capabilities.push('NAMESPACE');
    fake.namespaces = {
      personal: [{ prefix: 'INBOX.', delimiter: '.' }],
      other: false,
      shared: false,
    };
    const c = await connected();
    await c.selectFolder('Reports/2026');
    await c.renameFolder('Reports/2026', 'Archive/2026');
    await c.deleteFolder('Archive/2026');
    await c.copy([1], 'Archive');
    expect(fake.calls).toEqual([
      ['mailboxOpen', 'INBOX.Reports.2026'],
      ['mailboxRename', 'INBOX.Reports.2026', 'INBOX.Archive.2026'],
      ['mailboxDelete', 'INBOX.Archive.2026'],
      ['messageCopy', [1], 'INBOX.Archive', { uid: true }],
    ]);
  });
});

describe('connect', () => {
  it('logs in with a password and selects the initial folder', async () => {
    await IMAPClient.connect('imap.example.com', PASSWORD_LOGIN);
    const [flow] = fake.instances as [FakeImapFlow];
    expect(flow.options).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'u@example.com', pass: 'secret' },
      logger: false,
      disableAutoIdle: true,
      disableBinary: true,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      // An idle connection is never timed out (imaplib only bounds reads).
      socketTimeout: 2 ** 31 - 1,
    });
    // Certificates are verified by default.
    expect(flow.options.tls?.rejectUnauthorized).toBeUndefined();
    expect(fake.calls.map(([method]) => method)).toEqual([
      'connect',
      'list',
      'mailboxOpen',
    ]);
    expect(callsOf('mailboxOpen')).toEqual([['INBOX']]);
  });

  it('turns off certificate verification with verify: false', async () => {
    await IMAPClient.connect('h', { ...PASSWORD_LOGIN, verify: false });
    expect(fake.instances[0]?.options.tls?.rejectUnauthorized).toBe(false);
  });

  it('passes port, plain-text mode and timeout through', async () => {
    const capture = captureLogs(undefined, DEBUG);
    try {
      fake.starttls = true;
      await IMAPClient.connect('h', {
        ...PASSWORD_LOGIN,
        port: 143,
        ssl: false,
        timeout: 5,
        initialFolder: 'Reports',
      });
      expect(fake.instances[0]?.options).toMatchObject({
        port: 143,
        secure: false,
        // STARTTLS is required before the credentials are sent.
        doSTARTTLS: true,
        connectionTimeout: 5000,
        greetingTimeout: 5000,
      });
      expect(callsOf('mailboxOpen')).toEqual([['Reports']]);
      expect(capture.output).toEqual([
        'INFO:tsdmarc:Connecting to IMAP over plain text',
        'INFO:tsdmarc:IMAP server supports STARTTLS ... activating now',
      ]);
    } finally {
      capture.restore();
    }
  });

  it('requires STARTTLS by default without ssl', async () => {
    fake.starttls = true;
    await IMAPClient.connect('h', { ...PASSWORD_LOGIN, ssl: false });
    await IMAPClient.connect('h', PASSWORD_LOGIN);
    expect(fake.instances[0]?.options.doSTARTTLS).toBe(true);
    // Implicit TLS: imapflow refuses doSTARTTLS together with secure.
    expect(fake.instances[1]?.options.doSTARTTLS).toBeUndefined();
    expect(fake.instances[1]?.options.secure).toBe(true);
  });

  it('detects capabilities, separator and namespaces', async () => {
    fake.capabilities = ['IMAP4rev1', 'NAMESPACE'];
    fake.folders = [{ path: 'INBOX', delimiter: '/' }];
    fake.namespaces = {
      personal: [{ prefix: 'INBOX.', delimiter: '.' }],
      other: [{ prefix: 'user.', delimiter: '.' }],
      shared: [{ prefix: '', delimiter: '.' }],
    };
    const c = await IMAPClient.connect('h', PASSWORD_LOGIN);
    expect(c.moveSupported).toBe(false);
    expect(c.idleSupported).toBe(false);
    expect(c.hierarchySeparator).toBe('.');
    expect(c.pathPrefix).toBe('INBOX.');
    expect(c.otherNamespacePrefixes).toEqual(['user.']);
  });

  it('takes the separator from LIST without NAMESPACE', async () => {
    fake.capabilities = ['IMAP4rev1', 'MOVE', 'IDLE'];
    fake.folders = [{ path: 'INBOX', delimiter: '.' }];
    fake.namespaces = {
      personal: [{ prefix: 'IGNORED.', delimiter: '/' }],
      other: false,
      shared: false,
    };
    const c = await IMAPClient.connect('h', PASSWORD_LOGIN);
    expect(c.moveSupported).toBe(true);
    expect(c.idleSupported).toBe(true);
    expect(c.hierarchySeparator).toBe('.');
    expect(c.pathPrefix).toBe('');
  });

  it('wraps connection errors in IMAPClientError and closes the socket', async () => {
    failNext(
      'connect',
      imapflowError('Invalid credentials.', 'AUTHENTICATIONFAILED'),
    );
    const error = await IMAPClient.connect('h', PASSWORD_LOGIN).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(IMAPClientError);
    expect((error as Error).message).toBe('Invalid credentials');
    expect(fake.calls.at(-1)).toEqual(['close']);
  });
});

describe('startIdle', () => {
  it('fires the callback on EXISTS', async () => {
    const c = await connected();
    const controller = new AbortController();
    fake.onIdle = (flow, count) => {
      if (count === 1) {
        setImmediate(() =>
          flow.emit('exists', { path: 'INBOX', count: 5, prevCount: 4 }),
        );
      }
    };
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
        }
      },
      { idleTimeout: 60, signal: controller.signal },
    );
    // One call at startup + one for the EXISTS response.
    expect(calls).toBe(2);
    // IDLE, DONE (sent before the NOOP), IDLE again, DONE on exit.
    expect(fake.calls.map(([method]) => method)).toEqual([
      'idle',
      'noop',
      'idle',
      'noop',
    ]);
  });

  it('ignores responses that are not new mail', async () => {
    const c = await connected();
    const controller = new AbortController();
    fake.onIdle = (flow, count) => {
      if (count === 1) {
        setImmediate(() =>
          flow.emit('flags', { path: 'INBOX', seq: 1, flags: new Set() }),
        );
        setTimeout(() => controller.abort(), 50);
      }
    };
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
      },
      { idleTimeout: 60, signal: controller.signal },
    );
    // Only the startup call.
    expect(calls).toBe(1);
  });

  it('checks again when IDLE times out without a response', async () => {
    const c = await connected();
    const controller = new AbortController();
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
        if (calls === 3) {
          controller.abort();
        }
      },
      { idleTimeout: 0.01, signal: controller.signal },
    );
    expect(calls).toBe(3);
  });

  it('reconnects and re-arms IDLE when the connection drops', async () => {
    const c = await connected();
    const controller = new AbortController();
    fake.onIdle = (flow, count) => {
      if (count === 1) {
        setImmediate(() => flow.drop());
      }
    };
    const capture = captureLogs(undefined, DEBUG);
    let calls = 0;
    try {
      await c.startIdle(
        () => {
          calls += 1;
          if (calls === 2) {
            controller.abort();
          }
        },
        { idleTimeout: 60, signal: controller.signal },
      );
    } finally {
      capture.restore();
    }
    // A second connection was opened, with IDLE re-armed on it.
    expect(fake.instances).toHaveLength(2);
    expect(fake.idleCount).toBe(2);
    // The callback fired again after reconnecting (re-check for missed mail).
    expect(calls).toBe(2);
    expect(capture.output).toContain(
      'DEBUG:tsdmarc:IMAP error: Connection reset',
    );
    expect(capture.output).toContain('INFO:tsdmarc:Reconnecting to IMAP');
  });

  it.each([
    ['ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC', 'bad record mac'],
    ['EPROTO', 'write EPROTO'],
    ['UnexpectedTag', 'Unexpected tag'],
  ])(
    'reconnects after a connection error mailsuite has no class for (%s)',
    async (code, message) => {
      const c = await connected();
      const controller = new AbortController();
      fake.onIdle = (flow, count) => {
        if (count === 1) {
          setImmediate(() => flow.emit('error', imapflowError(message, code)));
        }
      };
      let calls = 0;
      await c.startIdle(
        () => {
          calls += 1;
          if (calls === 2) {
            controller.abort();
          }
        },
        { idleTimeout: 60, signal: controller.signal },
      );
      expect(fake.instances).toHaveLength(2);
      expect(fake.idleCount).toBe(2);
      expect(calls).toBe(2);
    },
  );

  it('waits longer between reconnects that keep failing, and resets after a stable connection', async () => {
    const c = await connected();
    const controller = new AbortController();
    const realNow = performance.now.bind(performance);
    let skipped = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skipped);
    fake.onIdle = (flow, count) => {
      if (count === 3) {
        // This connection stayed up for over a minute.
        skipped += 61_000;
      }
      if (count <= 3) {
        setImmediate(() => flow.drop());
      } else {
        controller.abort();
      }
    };
    const capture = captureLogs(undefined, DEBUG);
    try {
      await c.startIdle(() => undefined, {
        idleTimeout: 60,
        signal: controller.signal,
      });
    } finally {
      capture.restore();
    }
    expect(fake.instances).toHaveLength(4);
    // At once, then 1 s after a quick failure, then at once again.
    expect(
      capture.output.filter(line => line.includes('Reconnecting in')),
    ).toEqual(['DEBUG:tsdmarc:IMAP: Reconnecting in 1 s']);
  });

  it('stops waiting to reconnect when the signal aborts', async () => {
    const c = await connected();
    const controller = new AbortController();
    fake.onIdle = (flow, count) => {
      setImmediate(() => flow.drop());
      if (count === 2) {
        setTimeout(() => controller.abort(), 50);
      }
    };
    const started = performance.now();
    await c.startIdle(() => undefined, {
      idleTimeout: 60,
      signal: controller.signal,
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(fake.instances).toHaveLength(2);
  });

  it('re-enters IDLE when the server ends it, without a callback', async () => {
    const c = await connected();
    const controller = new AbortController();
    fake.onIdle = (flow, count) => {
      if (count === 1) {
        setImmediate(() => {
          flow.serverEndsIdle();
          // A response that is not new mail wakes the loop.
          flow.emit('flags', { path: 'INBOX', seq: 1, flags: new Set() });
        });
      } else {
        controller.abort();
      }
    };
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
      },
      { idleTimeout: 60, signal: controller.signal },
    );
    expect(calls).toBe(1);
    expect(fake.calls.map(([method]) => method)).toEqual([
      'idle',
      'idle',
      'noop',
    ]);
    expect(fake.instances).toHaveLength(1);
  });

  it('does not reconnect or call back once the signal aborts', async () => {
    const c = await connected();
    const controller = new AbortController();
    fake.onIdle = flow => {
      setImmediate(() => {
        // The connection fails as the loop is interrupted.
        flow.drop();
        controller.abort();
      });
    };
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
      },
      { idleTimeout: 60, signal: controller.signal },
    );
    expect(calls).toBe(1);
    expect(fake.instances).toHaveLength(1);
  });

  // mailsuite catches (OSError, KeyError, ...) around the callback too.
  it.each([
    [
      'an OSError',
      Object.assign(new Error('ENOSPC: no space left on device'), {
        errno: -28,
        code: 'ENOSPC',
      }),
    ],
    ['a KeyError', new FetchKeyError('Message UID 1 ...')],
  ])('reconnects when the callback raises %s', async (_name, error) => {
    const c = await connected();
    const controller = new AbortController();
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
        if (calls === 2) {
          throw error;
        }
        if (calls === 3) {
          controller.abort();
        }
      },
      { idleTimeout: 0.01, signal: controller.signal },
    );
    expect(calls).toBe(3);
    expect(fake.instances).toHaveLength(2);
  });

  it('propagates other errors from the callback', async () => {
    const c = await connected();
    let calls = 0;
    await expect(
      c.startIdle(
        () => {
          calls += 1;
          if (calls === 2) {
            throw new RangeError('bug');
          }
        },
        { idleTimeout: 0.01 },
      ),
    ).rejects.toThrow(RangeError);
  });

  it('exits cleanly when configReloading is truthy', async () => {
    const c = await connected();
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
      },
      { idleTimeout: 60, configReloading: () => true },
    );
    // Only the startup call; IDLE is ended on the way out.
    expect(calls).toBe(1);
    expect(fake.calls.map(([method]) => method)).toEqual(['idle', 'noop']);
  });

  it('keeps watching while configReloading is falsy', async () => {
    const c = await connected();
    const controller = new AbortController();
    fake.onIdle = (flow, count) => {
      if (count === 1) {
        setImmediate(() =>
          flow.emit('exists', { path: 'INBOX', count: 2, prevCount: 1 }),
        );
      }
    };
    let reloadCalls = 0;
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
        }
      },
      {
        idleTimeout: 60,
        signal: controller.signal,
        configReloading: () => {
          reloadCalls += 1;
          return false;
        },
      },
    );
    expect(calls).toBe(2);
    expect(reloadCalls).toBeGreaterThanOrEqual(2);
  });

  it('throws when the server does not support IDLE', async () => {
    fake.capabilities = ['IMAP4rev1'];
    const c = await connected();
    await expect(c.startIdle(() => undefined)).rejects.toThrow(
      new IMAPClientError('IDLE is not supported by the server'),
    );
  });

  it('closes the session when connect() cannot start IDLE', async () => {
    fake.capabilities = ['IMAP4rev1', 'MOVE', 'UIDPLUS'];
    await expect(
      IMAPClient.connect('imap.example.com', {
        ...PASSWORD_LOGIN,
        idleCallback: () => undefined,
      }),
    ).rejects.toThrow('IDLE is not supported by the server');
    expect(callsOf('close')).toHaveLength(1);
  });

  it('keeps the session open while connect() runs IDLE to its end', async () => {
    const controller = new AbortController();
    const client = await IMAPClient.connect('imap.example.com', {
      ...PASSWORD_LOGIN,
      idleCallback: () => controller.abort(),
      signal: controller.signal,
    });
    expect(callsOf('close')).toEqual([]);
    await client.close();
  });

  it('runs from connect() when given an idleCallback', async () => {
    const seen: IMAPClient[] = [];
    const reloader = (): boolean => true;
    const client = await IMAPClient.connect('h', {
      ...PASSWORD_LOGIN,
      idleCallback: c => {
        seen.push(c);
      },
      configReloading: reloader,
    });
    expect(seen).toEqual([client]);
    expect(fake.calls.map(([method]) => method)).toEqual([
      'connect',
      'list',
      'mailboxOpen',
      'idle',
      'noop',
    ]);
  });
});

describe('fetchMessage', () => {
  it('returns the message and marks it seen', async () => {
    fake.messages.set(42, Buffer.from('raw msg'));
    const c = await connected();
    expect(await c.fetchMessage(42)).toBe('raw msg');
    expect(fake.calls).toEqual([
      ['fetchOne', '42', { source: true }, { uid: true }],
      ['messageFlagsAdd', '42', ['\\Seen'], { uid: true, silent: true }],
    ]);
  });

  it('decodes UTF-8, replacing invalid bytes', async () => {
    fake.messages.set(7, Buffer.from([0x68, 0xc3, 0xa9, 0xff]));
    const c = await connected();
    expect(await c.fetchMessage(7)).toBe('hé�');
  });

  it('falls back to a download when the fetch has no source', async () => {
    fake.messages.set(42, Buffer.from('the body'));
    fake.fetchOverrides.push({ uid: 42, flags: new Set() });
    const c = await connected();
    expect(await c.fetchMessage(42)).toBe('the body');
    expect(callsOf('download')).toEqual([['42', undefined, { uid: true }]]);
  });

  it('raises KeyError naming the keys it got', async () => {
    fake.fetchOverrides.push({ uid: 42, flags: new Set() });
    const c = await connected();
    await expect(c.fetchMessage(42)).rejects.toThrow(
      new FetchKeyError(
        'Message UID 42 does not contain expected message keys after trying all fetch methods. ' +
          'Last response contained: ["uid","flags"]',
      ),
    );
  });

  it('raises KeyError when the message does not exist', async () => {
    const c = await connected();
    await expect(c.fetchMessage(42)).rejects.toThrow(
      new FetchKeyError(
        'Failed to fetch message UID 42 using any of the supported fetch methods',
      ),
    );
  });

  it('skips to the next method after a server error', async () => {
    fake.messages.set(42, Buffer.from('recovered'));
    failNext('fetchOne', serverNo('boom'));
    const capture = captureLogs(undefined, DEBUG);
    try {
      const c = await connected();
      expect(await c.fetchMessage(42)).toBe('recovered');
      expect(capture.output).toContain(
        'DEBUG:tsdmarc:Fetch with [BODY.PEEK[]] failed: Command failed: boom',
      );
    } finally {
      capture.restore();
    }
  });

  it('reconnects and retries after a timeout', async () => {
    fake.messages.set(42, Buffer.from('after retry'));
    failNext('fetchOne', timeout());
    const c = await connected({ maxRetries: 2 });
    expect(await c.fetchMessage(42)).toBe('after retry');
    expect(fake.instances).toHaveLength(2);
  });

  it('gives up after maxRetries', async () => {
    failNext('fetchOne', timeout(), timeout(), timeout());
    const c = await connected({ maxRetries: 2 });
    await expect(c.fetchMessage(42)).rejects.toThrow(
      new MaxRetriesExceeded('Maximum retries exceeded'),
    );
  });

  // maxSize is not in mailsuite.
  it('checks RFC822.SIZE first and skips a larger message', async () => {
    fake.messages.set(42, Buffer.from('x'.repeat(2000)));
    const c = await connected();
    await expect(c.fetchMessage(42, { maxSize: 1000 })).rejects.toThrow(
      new EmailTooLargeError(
        'Email of 2000 bytes exceeds the 1000 byte size limit (max_email_size)',
      ),
    );
    // Neither downloaded nor marked seen.
    expect(fake.calls).toEqual([
      ['fetchOne', '42', { size: true }, { uid: true }],
    ]);
  });

  it('downloads a message within maxSize', async () => {
    fake.messages.set(42, Buffer.from('raw msg'));
    const c = await connected();
    expect(await c.fetchMessage(42, { maxSize: 1000 })).toBe('raw msg');
    expect(fake.calls.map(call => call.slice(0, 3))).toEqual([
      ['fetchOne', '42', { size: true }],
      ['fetchOne', '42', { source: true }],
      ['messageFlagsAdd', '42', ['\\Seen']],
    ]);
  });

  it('refuses content larger than the size the server announced', async () => {
    fake.messages.set(42, Buffer.from('x'.repeat(2000)));
    fake.sizeOverrides.set(42, 10);
    const c = await connected();
    await expect(c.fetchMessage(42, { maxSize: 1000 })).rejects.toThrow(
      EmailTooLargeError,
    );
    expect(callsOf('messageFlagsAdd')).toEqual([]);
  });
});

describe('deleteMessages', () => {
  it('coerces a single UID to a list', async () => {
    const c = await connected();
    await c.deleteMessages(42);
    expect(callsOf('messageFlagsAdd')).toEqual([
      [[42], ['\\Deleted'], { uid: true, silent: true }],
    ]);
  });

  it('retries after a timeout', async () => {
    failNext('messageFlagsAdd', timeout());
    const c = await connected({ maxRetries: 3 });
    await c.deleteMessages([1, 2]);
    expect(callsOf('messageFlagsAdd')).toHaveLength(2);
    expect(fake.instances).toHaveLength(2);
  });

  it('raises MaxRetriesExceeded', async () => {
    failNext('messageFlagsAdd', timeout(), timeout());
    const c = await connected({ maxRetries: 2 });
    await expect(c.deleteMessages([1])).rejects.toThrow(MaxRetriesExceeded);
  });

  it('expunges only the given UIDs with UIDPLUS', async () => {
    const c = await connected();
    await c.deleteMessages([1, 2]);
    expect(callsOf('messageDelete')).toEqual([[[1, 2], { uid: true }]]);
  });

  it('falls back to a plain EXPUNGE without UIDPLUS', async () => {
    fake.capabilities = ['IMAP4rev1', 'IDLE', 'MOVE'];
    const c = await connected();
    await c.deleteMessages([1, 2]);
    // A sequence-number delete of the \Deleted messages: plain EXPUNGE.
    expect(callsOf('messageDelete')).toEqual([[{ deleted: true }]]);
  });

  describe('without UIDPLUS', () => {
    const NO_UIDPLUS = ['IMAP4rev1', 'IDLE', 'MOVE'];

    it('raises when EXPUNGE fails and the message stays flagged', async () => {
      fake.capabilities = NO_UIDPLUS;
      fake.messages.set(1, Buffer.from('m'));
      failNext('messageDelete', false);
      const c = await connected();
      await expect(c.deleteMessages([1])).rejects.toThrow(
        new IMAPClientError('EXPUNGE command failed'),
      );
    });

    it('does not fail when nothing was left to expunge', async () => {
      fake.capabilities = NO_UIDPLUS;
      failNext('messageDelete', false);
      const c = await connected();
      await c.deleteMessages([1]);
      expect(callsOf('search')).toEqual([[{ deleted: true }, undefined]]);
    });

    it('raises when the check itself fails', async () => {
      fake.capabilities = NO_UIDPLUS;
      failNext('messageDelete', false);
      failNext('search', false);
      const c = await connected();
      await expect(c.expunge()).rejects.toThrow(
        new IMAPClientError('EXPUNGE command failed'),
      );
    });

    it('reconnects and retries when the connection is lost mid-EXPUNGE', async () => {
      fake.capabilities = NO_UIDPLUS;
      failNext('messageDelete', false);
      failNext('search', imapflowError('Connection lost', 'NoConnection'));
      const c = await connected();
      await c.deleteMessages([1]);
      expect(fake.instances).toHaveLength(2);
      expect(callsOf('messageDelete')).toHaveLength(2);
    });
  });

  it('propagates server errors without retrying', async () => {
    failNext('messageFlagsAdd', false);
    const c = await connected();
    await expect(c.deleteMessages([1])).rejects.toThrow(
      new IMAPClientError('STORE command failed'),
    );
    expect(fake.instances).toHaveLength(1);
  });
});

describe('createFolder', () => {
  it('skips an existing folder', async () => {
    fake.folders.push({ path: 'Reports', delimiter: '/' });
    const c = await connected();
    await c.createFolder('Reports');
    expect(callsOf('mailboxCreate')).toEqual([]);
  });

  it('creates a missing folder', async () => {
    const c = await connected();
    await c.createFolder('Reports');
    expect(callsOf('mailboxCreate')).toEqual([['Reports']]);
  });

  it('raises MaxRetriesExceeded on repeated timeouts', async () => {
    failNext('mailboxCreate', timeout(), timeout());
    const c = await connected({ maxRetries: 2 });
    await expect(c.createFolder('Reports')).rejects.toThrow(MaxRetriesExceeded);
  });
});

describe('folderExists', () => {
  it('compares listed paths, INBOX case-insensitively', async () => {
    fake.folders = [
      { path: 'Inbox', delimiter: '/' },
      { path: 'Reports/2026', delimiter: '/' },
    ];
    const c = await connected();
    expect(await c.folderExists('INBOX')).toBe(true);
    expect(await c.folderExists('Reports/2026/')).toBe(true);
    expect(await c.folderExists('reports/2026')).toBe(false);
  });
});

describe('search', () => {
  it('searches all UIDs by default', async () => {
    fake.messages.set(1, Buffer.from('a')).set(2, Buffer.from('b'));
    const c = await connected();
    expect(await c.search()).toEqual([1, 2]);
    expect(callsOf('search')).toEqual([[{ all: true }, { uid: true }]]);
  });

  it('translates SINCE dd-Mon-yyyy', async () => {
    const c = await connected();
    await c.search('SINCE 01-Jan-2026');
    expect(callsOf('search')).toEqual([
      [{ since: new Date('2026-01-01T00:00:00Z') }, { uid: true }],
    ]);
  });

  it('rejects criteria it cannot translate', async () => {
    const c = await connected();
    await expect(c.search('SINCE yesterday')).rejects.toThrow(IMAPClientError);
  });
});

describe('moveMessages', () => {
  it('uses MOVE when supported', async () => {
    const c = await connected();
    await c.moveMessages([1, 2, 3], 'Archive');
    expect(callsOf('messageMove')).toEqual([
      [[1, 2, 3], 'Archive', { uid: true }],
    ]);
    expect(callsOf('messageCopy')).toEqual([]);
  });

  it('copies and deletes when MOVE is unsupported', async () => {
    fake.capabilities = ['IMAP4rev1', 'UIDPLUS'];
    const c = await connected();
    await c.moveMessages([1], 'Archive\\Sub/');
    expect(callsOf('messageMove')).toEqual([]);
    expect(callsOf('messageCopy')).toEqual([
      [[1], 'Archive/Sub', { uid: true }],
    ]);
    expect(callsOf('messageDelete')).toEqual([[[1], { uid: true }]]);
  });

  it('falls back to copy + delete when MOVE fails', async () => {
    failNext('messageMove', false);
    const capture = captureLogs(undefined, DEBUG);
    try {
      const c = await connected();
      await c.moveMessages([1], 'Archive');
      expect(callsOf('messageCopy')).toEqual([[[1], 'Archive', { uid: true }]]);
      expect(callsOf('messageDelete')).toEqual([[[1], { uid: true }]]);
      expect(capture.output).toContain(
        'INFO:tsdmarc:IMAP error: Error moving message UIDs [1]: MOVE command failed',
      );
    } finally {
      capture.restore();
    }
  });

  it('copies and deletes each 100-UID chunk once', async () => {
    fake.capabilities = ['IMAP4rev1', 'UIDPLUS'];
    const c = await connected();
    const uids = Array.from({ length: 150 }, (_, index) => index);
    await c.moveMessages(uids, 'Archive');
    const first = uids.slice(0, 100);
    const rest = uids.slice(100);
    expect(callsOf('messageCopy').map(([range]) => range)).toEqual([
      first,
      rest,
    ]);
    expect(callsOf('messageDelete').map(([range]) => range)).toEqual([
      first,
      rest,
    ]);
  });

  it('retries once after a timeout', async () => {
    failNext('messageMove', timeout());
    const c = await connected();
    await c.moveMessages([5], 'Archive');
    expect(callsOf('messageMove')).toHaveLength(2);
    expect(fake.instances).toHaveLength(2);
  });

  // mailsuite's reset re-selects INBOX, so its retry moves INBOX's UID 5.
  it('retries in the folder that was selected, not INBOX', async () => {
    failNext('messageMove', timeout());
    const c = await connected();
    await c.selectFolder('Reports');
    fake.calls.length = 0;
    await c.moveMessages([5], 'Archive');
    expect(
      fake.calls
        .filter(
          ([method]) => method === 'mailboxOpen' || method === 'messageMove',
        )
        .map(([method, first]) => [method, first]),
    ).toEqual([
      ['messageMove', [5]],
      ['mailboxOpen', 'Reports'],
      ['messageMove', [5]],
    ]);
  });

  it('times out a MOVE the server never answers, then retries', async () => {
    fake.hangs.push('messageMove');
    const c = await connected({ timeout: 0.05 });
    await c.moveMessages([5], 'Archive');
    // The stuck connection was closed and a new one retried the move.
    expect(fake.calls.map(([method]) => method)).toContain('close');
    expect(fake.instances).toHaveLength(2);
    expect(callsOf('messageMove')).toHaveLength(2);
  });
});

describe('command timeout', () => {
  it('raises TimeoutError("timed out") and closes the connection', async () => {
    fake.hangs.push('noop');
    const c = await connected({ timeout: 0.05 });
    await expect(c.noop()).rejects.toThrow(new IMAPTimeoutError('timed out'));
    expect(fake.calls.map(([method]) => method)).toEqual(['noop', 'close']);
  });

  it('does not time out while no command is in flight', async () => {
    const c = await connected({ timeout: 0.05 });
    await new Promise(resolve => setTimeout(resolve, 150));
    await c.noop();
    expect(fake.calls.map(([method]) => method)).toEqual(['noop']);
  });
});

describe('errors', () => {
  it('MaxRetriesExceeded is an Error', () => {
    expect(new MaxRetriesExceeded('x')).toBeInstanceOf(Error);
  });

  it('IMAPClientAbortError is an IMAPClientError, like IMAP4.abort', () => {
    expect(new IMAPClientAbortError('x')).toBeInstanceOf(IMAPClientError);
    expect(new IMAPTimeoutError('x')).not.toBeInstanceOf(IMAPClientError);
  });
});

describe('OAuth2 login', () => {
  it('uses password auth when no token is given', async () => {
    await IMAPClient.connect('h', PASSWORD_LOGIN);
    expect(fake.instances[0]?.options.auth).toEqual({
      user: 'u@example.com',
      pass: 'secret',
    });
  });

  it('sends a static token as an access token', async () => {
    await IMAPClient.connect('h', {
      username: 'u@example.com',
      oauth2Token: 'tok-123',
    });
    expect(fake.instances[0]?.options.auth).toEqual({
      user: 'u@example.com',
      accessToken: 'tok-123',
    });
  });

  it('calls the token provider on every connect', async () => {
    const tokens = ['tok-1', 'tok-2', 'tok-3'];
    let providerCalls = 0;
    const client = await IMAPClient.connect('h', {
      username: 'u@example.com',
      oauth2TokenProvider: () => {
        providerCalls += 1;
        return tokens.shift() ?? '';
      },
    });
    // Reconnect: the provider is called again for a fresh token.
    await client.resetConnection();
    expect(providerCalls).toBe(2);
    expect(fake.instances.map(flow => flow.options.auth?.accessToken)).toEqual([
      'tok-1',
      'tok-2',
    ]);
  });

  it('prefers the provider over a static token', async () => {
    await IMAPClient.connect('h', {
      username: 'u@example.com',
      oauth2Token: 'static',
      oauth2TokenProvider: () => Promise.resolve('dynamic'),
    });
    expect(fake.instances[0]?.options.auth?.accessToken).toBe('dynamic');
  });

  it('accepts OAUTHBEARER (imapflow negotiates the mechanism)', async () => {
    await IMAPClient.connect('h', {
      username: 'u@example.com',
      oauth2Token: 'tok',
      oauth2Mechanism: 'OAUTHBEARER',
    });
    expect(fake.instances[0]?.options.auth).toEqual({
      user: 'u@example.com',
      accessToken: 'tok',
    });
  });

  it('rejects an XOAUTH2 vendor, which imapflow cannot send', () => {
    expect(
      () =>
        new IMAPClient('h', {
          username: 'u@yahoo.com',
          oauth2Token: 'tok',
          oauth2Vendor: 'yahoo',
        }),
    ).toThrow(/oauth2Vendor/u);
  });

  // mailsuite raises ValueError for both.
  it('requires a password or a token', () => {
    expect(() => new IMAPClient('h', { username: 'u@example.com' })).toThrow(
      /password or an OAuth2/u,
    );
    expect(() => new IMAPClient('h', { username: 'u@example.com' })).toThrow(
      ValueError,
    );
  });

  it('requires a username with OAuth2', () => {
    expect(() => new IMAPClient('h', { oauth2Token: 'tok' })).toThrow(
      new ValueError('username is required when authenticating with OAuth2'),
    );
    expect(() => new IMAPClient('h', { oauth2Token: 'tok' })).toThrow(
      ValueError,
    );
  });
});

// Access to the IDLE loop's internals, for the mailsuite tests that inspect
// `_idle_running` or feed `idle_check()` directly.
interface IdleInternals {
  idleRunning: boolean;
  idling: boolean;
  idleResponses: [number, string][];
  wakeIdleCheck: (() => void) | null;
}

function internals(client: IMAPClient): IdleInternals {
  return client as unknown as IdleInternals;
}

describe('startIdle (mailsuite parity)', () => {
  // imapflow has no event for an untagged RECENT (it was dropped from
  // IMAP4rev2), so the RECENT branch kept from mailsuite can't be reached
  // through the fake imapflow: the response is buffered the way the event
  // listeners do it.
  it.each([
    [1, 2],
    [0, 1],
  ])('test_fires_callback_on_recent (count %i)', async (count, expected) => {
    const c = await connected();
    const controller = new AbortController();
    let idlingWhenPushed = false;
    fake.onIdle = (_flow, idleCount) => {
      if (idleCount === 1) {
        setImmediate(() => {
          const state = internals(c);
          idlingWhenPushed = state.idling;
          state.idleResponses.push([count, 'RECENT']);
          state.wakeIdleCheck?.();
          setTimeout(() => controller.abort(), 50);
        });
      }
    };
    let calls = 0;
    await c.startIdle(
      () => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
        }
      },
      { idleTimeout: 60, signal: controller.signal },
    );
    expect(idlingWhenPushed).toBe(true);
    // Startup call, plus one for a non-zero RECENT.
    expect(calls).toBe(expected);
  });

  it('test_config_reloading_truthy_exits_cleanly: the loop is no longer running', async () => {
    const c = await connected();
    let runningDuringCallback = false;
    await c.startIdle(
      client => {
        runningDuringCallback = internals(client).idleRunning;
      },
      { idleTimeout: 60, configReloading: () => true },
    );
    expect(runningDuringCallback).toBe(true);
    // Python: `client._idle_running is False`.
    expect(internals(c).idleRunning).toBe(false);
  });

  it('test_reconnect_during_idle_recovers_without_recursion (mocked)', async () => {
    // tests/test_imap_idle_integration.py: a reconnect from inside the loop
    // started by connect() re-arms that loop, and connect() does not start
    // a nested one (`len(entries) == 1`).
    const controller = new AbortController();
    const startIdle = vi.spyOn(IMAPClient.prototype, 'startIdle');
    const resetConnection = vi.spyOn(IMAPClient.prototype, 'resetConnection');
    fake.onIdle = (flow, count) => {
      if (count === 1) {
        setImmediate(() => flow.drop());
      } else if (count === 2) {
        // Mail delivered only after the reconnect.
        setImmediate(() =>
          flow.emit('exists', { path: 'INBOX', count: 1, prevCount: 0 }),
        );
      }
    };
    let calls = 0;
    await IMAPClient.connect('imap.example.com', {
      ...PASSWORD_LOGIN,
      idleTimeout: 60,
      signal: controller.signal,
      idleCallback: () => {
        calls += 1;
        // Startup, re-check after reconnecting, then the EXISTS.
        if (calls === 3) {
          controller.abort();
        }
      },
    });
    expect(calls).toBe(3);
    expect(fake.instances).toHaveLength(2);
    expect(resetConnection).toHaveBeenCalledTimes(1);
    expect(startIdle).toHaveBeenCalledTimes(1);
  });
});
