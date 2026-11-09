// IMAPClient over a real socket with the real imapflow, against a local
// fake server: imaplib's timeout semantics (only commands in flight time
// out) and long IDLE sessions.

import { captureLogs, EmailTooLargeError, WARNING } from 'tsdmarc';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { IMAPClient, type IMAPClientOptions } from './client';
import { IMAPClientError, IMAPTimeoutError } from './errors';
import {
  type FakeImapServer,
  startFakeImapServer,
} from './test/fake-imap-server';

let server: FakeImapServer;
let client: IMAPClient | null = null;

beforeEach(async () => {
  server = await startFakeImapServer();
});

afterEach(async () => {
  await client?.close();
  client = null;
  await server.close();
});

function options(extra: IMAPClientOptions = {}): IMAPClientOptions {
  return {
    username: 'u',
    password: PASSWORD,
    ssl: false,
    // The fake server has no TLS unless `server.starttls`; the tests that
    // check the STARTTLS policy override this.
    starttls: false,
    port: server.port,
    verify: false,
    ...extra,
  };
}

/** Whether a LOGIN or AUTHENTICATE reached the server, and how. */
function logins(): boolean[] {
  return server.log
    .filter(
      ({ command }) =>
        command.startsWith('LOGIN') || command.startsWith('AUTHENTICATE'),
    )
    .map(({ tls }) => tls);
}

const PASSWORD = 'Sup3rSecret-placeholder';
/** The credentials as LOGIN or `AUTHENTICATE PLAIN` sends them. */
const SECRETS = [PASSWORD, Buffer.from(`\0u\0${PASSWORD}`).toString('base64')];

function leaked(): boolean {
  return SECRETS.some(secret => server.plainText.includes(secret));
}

const REFUSAL =
  'The IMAP server does not advertise STARTTLS, so credentials would be sent in plain text. Use ssl=True for implicit TLS, or pass starttls=False to allow plain-text authentication';

// GHSA-2x4j-7g3q-wr6f with the real imapflow: credentials never cross a
// plain-text connection unless `starttls: false`.
it('refuses to log in by default when the server offers no STARTTLS', async () => {
  await expect(
    IMAPClient.connect(server.host, options({ starttls: null, timeout: 30 })),
  ).rejects.toThrow(new IMAPClientError(REFUSAL));
  expect(logins()).toEqual([]);
  expect(leaked()).toBe(false);
});

it('refuses starttls: true without logging in when STARTTLS is not advertised', async () => {
  await expect(
    IMAPClient.connect(server.host, options({ starttls: true, timeout: 30 })),
  ).rejects.toThrow('STARTTLS required but not supported by the server');
  expect(logins()).toEqual([]);
  expect(leaked()).toBe(false);
});

it.each([null, true])(
  'upgrades with STARTTLS before logging in (starttls: %s)',
  async starttls => {
    server.starttls = true;
    client = await IMAPClient.connect(
      server.host,
      options({ starttls, timeout: 30 }),
    );
    expect(
      server.log.filter(({ tls }) => !tls).map(({ command }) => command),
    ).toEqual(['CAPABILITY', 'STARTTLS']);
    expect(logins()).toEqual([true]);
    expect(leaked()).toBe(false);
  },
);

it.each([false, true])(
  'logs in over plain text with starttls: false, with a warning (advertised: %s)',
  async advertised => {
    server.starttls = advertised;
    const capture = captureLogs(undefined, WARNING);
    try {
      client = await IMAPClient.connect(server.host, options({ timeout: 30 }));
      expect(capture.output).toEqual([
        'WARNING:tsdmarc:Sending IMAP credentials unencrypted because starttls=False',
      ]);
    } finally {
      capture.restore();
    }
    expect(server.commands).not.toContain('STARTTLS');
    expect(logins()).toEqual([false]);
    expect(leaked()).toBe(true);
  },
);

// The socket timeout: short, but long enough that a loopback reply on a
// loaded machine doesn't miss it. The waits below are several times it.
const SOCKET_TIMEOUT_SECONDS = 0.5;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

it('keeps a connection with no command in flight open past the timeout', async () => {
  client = await IMAPClient.connect(
    '127.0.0.1',
    options({ timeout: SOCKET_TIMEOUT_SECONDS }),
  );
  // imaplib's timeout bounds reads, not the time between commands.
  await sleep(SOCKET_TIMEOUT_SECONDS * 3000);
  await client.noop();
  expect(server.connections).toBe(1);
});

it('times out a command the server does not answer', async () => {
  client = await IMAPClient.connect(
    '127.0.0.1',
    options({ timeout: SOCKET_TIMEOUT_SECONDS }),
  );
  server.silent.add('NOOP');
  const started = performance.now();
  await expect(client.noop()).rejects.toThrow(
    new IMAPTimeoutError('timed out'),
  );
  // The 0.5 s timeout, not some much longer default: a generous bound, as
  // timers fire late on a loaded machine.
  expect(performance.now() - started).toBeLessThan(10_000);
});

it('idles past the socket timeout on one connection, re-issuing IDLE each check', async () => {
  const controller = new AbortController();
  const wantedCalls = 3;
  let calls = 0;
  // Resolves when the IDLE loop ends, leaving the connection open. It ends
  // after a number of checks, not after a wall-clock delay, so a loaded
  // machine can't make it stop early.
  client = await IMAPClient.connect(
    '127.0.0.1',
    options({
      timeout: SOCKET_TIMEOUT_SECONDS,
      idleTimeout: SOCKET_TIMEOUT_SECONDS * 2,
      signal: controller.signal,
      idleCallback: () => {
        calls += 1;
        if (calls === wantedCalls) {
          controller.abort();
        }
      },
    }),
  );
  expect(server.connections).toBe(1);
  // The startup call plus one per idleTimeout (longer than the socket
  // timeout) without new mail, each followed by a fresh IDLE on that
  // connection.
  expect(calls).toBe(wantedCalls);
  const idles = server.commands.filter(command => command === 'IDLE');
  expect(idles).toHaveLength(calls);
});

// Mocked equivalents of mailsuite's Docker tests
// (tests/test_imap_idle_integration.py), against the fake server instead of
// GreenMail.

it('test_idle_detects_new_mail', async () => {
  const controller = new AbortController();
  server.onIdle = (socket, count) => {
    if (count === 1) {
      setImmediate(() => socket.write('* 1 EXISTS\r\n'));
    }
  };
  let calls = 0;
  client = await IMAPClient.connect(
    '127.0.0.1',
    options({
      // Far longer than the test: only the EXISTS can wake the loop.
      idleTimeout: 600,
      signal: controller.signal,
      idleCallback: () => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
        }
      },
    }),
  );
  // One call at startup + one for the EXISTS pushed during IDLE.
  expect(calls).toBe(2);
  expect(server.connections).toBe(1);
});

it('test_reconnect_during_idle_recovers_without_recursion', async () => {
  const controller = new AbortController();
  // Count entries into the IDLE loop and reconnects: a reconnect must re-arm
  // the existing loop, not start a nested one from connect().
  const startIdle = vi.spyOn(IMAPClient.prototype, 'startIdle');
  const resetConnection = vi.spyOn(IMAPClient.prototype, 'resetConnection');
  server.onIdle = (socket, count) => {
    if (count === 1) {
      // Drop the connection mid-IDLE.
      setImmediate(() => socket.destroy());
    } else if (count === 2) {
      // New mail delivered only after the reconnect: seeing it proves the
      // loop re-armed IDLE on the new connection.
      setImmediate(() => socket.write('* 1 EXISTS\r\n'));
    }
  };
  let calls = 0;
  try {
    client = await IMAPClient.connect(
      '127.0.0.1',
      options({
        idleTimeout: 600,
        signal: controller.signal,
        idleCallback: () => {
          calls += 1;
          // Startup, re-check after reconnecting, then the EXISTS.
          if (calls === 3) {
            controller.abort();
          }
        },
      }),
    );
    expect(calls).toBe(3);
    expect(server.connections).toBe(2);
    expect(resetConnection).toHaveBeenCalledTimes(1);
    // Python: `len(entries) == 1` (no recursion on reconnect).
    expect(startIdle).toHaveBeenCalledTimes(1);
  } finally {
    startIdle.mockRestore();
    resetConnection.mockRestore();
  }
});

it('reconnects when an unlisted connection error arrives during IDLE, without starving the event loop', async () => {
  const controller = new AbortController();
  server.onIdle = (socket, count) => {
    if (count === 1) {
      // imapflow refuses this marker and closes the connection.
      setImmediate(() => socket.write('* 1 FETCH (BODY[] {9999999999}\r\n'));
    } else if (count === 2) {
      setImmediate(() => socket.write('* 1 EXISTS\r\n'));
    }
  };
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
  }, 5);
  let calls = 0;
  try {
    client = await IMAPClient.connect(
      '127.0.0.1',
      options({
        idleTimeout: 600,
        signal: controller.signal,
        idleCallback: () => {
          calls += 1;
          // Startup, re-check after reconnecting, then the EXISTS.
          if (calls === 3) {
            controller.abort();
          }
        },
      }),
    );
  } finally {
    clearInterval(heartbeat);
  }
  expect(calls).toBe(3);
  expect(server.connections).toBe(2);
  expect(ticks).toBeGreaterThan(0);
});

it('backs off when the server drops every IDLE connection at once', async () => {
  const controller = new AbortController();
  server.onIdle = socket => {
    setImmediate(() => socket.destroy());
  };
  setTimeout(() => controller.abort(), 2500);
  let calls = 0;
  client = await IMAPClient.connect(
    '127.0.0.1',
    options({
      idleTimeout: 600,
      signal: controller.signal,
      idleCallback: () => {
        calls += 1;
      },
    }),
  );
  // Connections at 0 s, at once, after 1 s and after 2 s more (3 s).
  expect(server.connections).toBe(3);
  expect(calls).toBe(3);
});

const MAX_SIZE = 1024;
const OVERSIZED = 8 * 1024 * 1024;

it('stops at the literal marker when the server under-reports a message', async () => {
  server.onUidFetch = (socket, tag, fetchItems) => {
    if (fetchItems.includes('RFC822.SIZE')) {
      socket.write(`* 1 FETCH (UID 1 RFC822.SIZE 10)\r\n${tag} OK done\r\n`);
      return;
    }
    socket.write(`* 1 FETCH (UID 1 BODY[] {${OVERSIZED}}\r\n`);
    socket.write(Buffer.alloc(OVERSIZED, 0x41));
  };
  client = await IMAPClient.connect('127.0.0.1', options());
  const error = await client
    .fetchMessage(1, { maxSize: MAX_SIZE })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmailTooLargeError);
  expect((error as Error).message).toBe(
    `Email of ${OVERSIZED} bytes exceeds the ${MAX_SIZE} byte size limit (max_email_size)`,
  );
  // imapflow closed that connection: the client has a working one again.
  expect(server.connections).toBe(2);
  await client.noop();
  // Refused once, not retried, and the message was not flagged \Seen.
  const bodyFetches = server.commands.filter(command =>
    command.includes('BODY.PEEK[]'),
  );
  expect(bodyFetches).toHaveLength(1);
  expect(server.commands.some(command => command.includes('Seen'))).toBe(false);
});

it('stops the chunked fallback at the limit when the server reports no size', async () => {
  // imapflow asks for 64 KiB at a time and stops at a shorter chunk.
  const chunkLiteral = Buffer.alloc(64 * 1024, 0x41);
  const maxSize = chunkLiteral.length * 3;
  let chunks = 0;
  server.onUidFetch = (socket, tag, fetchItems) => {
    const start = /BODY\.PEEK\[\]<(\d+)\./u.exec(fetchItems)?.[1];
    if (start !== undefined) {
      chunks += 1;
      socket.write(
        `* 1 FETCH (UID 1 BODY[]<${start}> {${chunkLiteral.length}}\r\n`,
      );
      socket.write(chunkLiteral);
      socket.write(`)\r\n${tag} OK done\r\n`);
    } else if (fetchItems.includes('BODY.PEEK[]')) {
      socket.write(`${tag} NO not today\r\n`);
    } else {
      socket.write(`* 1 FETCH (UID 1)\r\n${tag} OK done\r\n`);
    }
  };
  client = await IMAPClient.connect('127.0.0.1', options());
  await expect(client.fetchMessage(1, { maxSize })).rejects.toThrow(
    EmailTooLargeError,
  );
  // The chunks that reach maxSize + 1 bytes, and none after them.
  expect(chunks).toBe(4);
});

it('caps the bytes of a whole FETCH, not only of each response', async () => {
  // Each row is within the limits; together they are 64 times the limit.
  const maxSize = 256 * 1024;
  const row = Buffer.concat([
    Buffer.from(`* 1 FETCH (UID 1 BODY[] {${maxSize}}\r\n`),
    Buffer.alloc(maxSize, 0x41),
    Buffer.from(')\r\n'),
  ]);
  server.onUidFetch = (socket, tag, fetchItems) => {
    if (fetchItems.includes('RFC822.SIZE')) {
      socket.write(`* 1 FETCH (UID 1 RFC822.SIZE 10)\r\n${tag} OK done\r\n`);
      return;
    }
    for (let rows = 0; rows < 64; rows += 1) {
      socket.write(row);
    }
    socket.write(`${tag} OK done\r\n`);
  };
  client = await IMAPClient.connect('127.0.0.1', options());
  const error = await client
    .fetchMessage(1, { maxSize })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmailTooLargeError);
  // The connection was closed there; the client has a working one again.
  expect(server.connections).toBe(2);
  await client.noop();
  expect(server.commands.some(command => command.includes('Seen'))).toBe(false);
});

it('fetches a message of exactly the limit, and restores the limits afterwards', async () => {
  const body = Buffer.alloc(MAX_SIZE, 0x41);
  server.onUidFetch = (socket, tag, fetchItems) => {
    if (fetchItems.includes('RFC822.SIZE')) {
      socket.write(
        `* 1 FETCH (UID 1 RFC822.SIZE ${body.length})\r\n${tag} OK done\r\n`,
      );
    } else if (fetchItems.includes('BODY.PEEK[]')) {
      socket.write(`* 1 FETCH (UID 1 BODY[] {${body.length}}\r\n`);
      socket.write(body);
      socket.write(`)\r\n${tag} OK done\r\n`);
    } else {
      socket.write(`${tag} OK done\r\n`);
    }
  };
  client = await IMAPClient.connect('127.0.0.1', options());
  const content = await client.fetchMessage(1, { maxSize: MAX_SIZE });
  expect(content).toHaveLength(MAX_SIZE);
  expect(server.connections).toBe(1);
  // A later, unlimited fetch of a larger message is not held to that limit.
  server.onUidFetch = (socket, tag) => {
    socket.write(`* 1 FETCH (UID 1 BODY[] {${MAX_SIZE * 2}}\r\n`);
    socket.write(Buffer.alloc(MAX_SIZE * 2, 0x41));
    socket.write(`)\r\n${tag} OK done\r\n`);
  };
  expect(await client.fetchMessage(1)).toHaveLength(MAX_SIZE * 2);
});
