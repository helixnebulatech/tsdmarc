// Port of mailsuite tests/test_smtp.py (the parts parsedmarc uses: no DKIM,
// no OAuth2, no envelope_from). SMTPConnection is faked at the nodemailer
// boundary; the message is built by the real MailComposer and checked as
// sent.

import { captureLogs, INFO, WARNING } from 'tsdmarc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendEmail, SMTPError } from './send-email';
import {
  type FakeSMTPConnection,
  fakeSmtp,
  nodemailerError,
  resetFakeSmtp,
} from './test/fake-smtp-connection';

vi.mock('nodemailer/lib/smtp-connection', async () => {
  const fake = await import('./test/fake-smtp-connection');
  return { default: fake.FakeSMTPConnection };
});

beforeEach(() => {
  resetFakeSmtp();
});

function lastConnection(): FakeSMTPConnection {
  const connection = fakeSmtp.instances.at(-1);
  if (connection === undefined) {
    throw new Error('no SMTP connection was made');
  }
  return connection;
}

/** The headers of the top-level part, unfolded, by lower-case name. */
function topHeaders(message: string): Map<string, string> {
  const [head = ''] = message.split('\r\n\r\n', 1);
  const headers = new Map<string, string>();
  for (const line of head.replaceAll(/\r\n[ \t]+/gu, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    headers.set(
      line.slice(0, colon).toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return headers;
}

// mailsuite 2.3.4 tests/test_smtp.py::TestSendEmailStartTLS: `starttls`
// null upgrades when advertised, false declines, true requires.
describe('TestSendEmailStartTLS', () => {
  const CREDENTIALS = { username: 'user', password: 'pw' };

  async function send(
    hasStarttls: boolean,
    options: Parameters<typeof sendEmail>[2] = {},
    credentials: Parameters<typeof sendEmail>[2] = CREDENTIALS,
  ): Promise<{ connection: FakeSMTPConnection; output: string[] }> {
    fakeSmtp.starttls = hasStarttls;
    const capture = captureLogs(undefined, INFO);
    try {
      await sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
        ...credentials,
        ...options,
      });
      return { connection: lastConnection(), output: capture.output };
    } finally {
      capture.restore();
    }
  }

  const REFUSAL = new SMTPError(
    'The SMTP server does not advertise STARTTLS, so credentials would be sent in plain text. Use require_encryption=True for implicit TLS, or pass starttls=False to allow plain-text authentication',
  );
  const UNENCRYPTED_WARNING =
    'WARNING:tsdmarc:Sending SMTP credentials unencrypted because starttls=False';

  it('test_default_upgrades_when_advertised', async () => {
    const { connection } = await send(true);
    expect(connection.secure).toBe(true);
    expect(connection.message).not.toBeNull();
  });

  it('test_false_declines_advertised_upgrade', async () => {
    const { connection, output } = await send(true, { starttls: false });
    expect(connection.options.ignoreTLS).toBe(true);
    expect(connection.secure).toBe(false);
    expect(connection.auth).toEqual({ user: 'user', pass: 'pw' });
    expect(connection.message).not.toBeNull();
    expect(output).toEqual([
      'INFO:tsdmarc:SMTP server supports STARTTLS, but it is disabled ... staying in plain text',
      UNENCRYPTED_WARNING,
    ]);
  });

  it('test_true_upgrades_when_advertised', async () => {
    const { connection } = await send(true, { starttls: true });
    expect(connection.secure).toBe(true);
    expect(connection.message).not.toBeNull();
  });

  // Fails on mailsuite 2.3.3, which logged a warning and sent the password
  // in plain text when STARTTLS was not advertised (GHSA-3588-2mr7-vrcm).
  it('test_default_not_advertised_with_password_raises', async () => {
    await expect(send(false)).rejects.toThrow(REFUSAL);
    const connection = lastConnection();
    expect(connection.secure).toBe(false);
    expect(connection.auth).toBeNull();
    expect(connection.message).toBeNull();
    expect(connection.quitCalled).toBe(true);
  });

  it('test_default_not_advertised_without_credentials_warns', async () => {
    const { connection, output } = await send(false, {}, {});
    expect(connection.secure).toBe(false);
    expect(connection.auth).toBeNull();
    expect(connection.message).not.toBeNull();
    expect(output).toEqual([
      'WARNING:tsdmarc:SMTP server does not support STARTTLS. Proceeding in plain text!',
    ]);
  });

  it('test_false_not_advertised_stays_plain', async () => {
    const { connection, output } = await send(false, { starttls: false });
    expect(connection.secure).toBe(false);
    expect(connection.auth).toEqual({ user: 'user', pass: 'pw' });
    expect(connection.message).not.toBeNull();
    expect(output).toEqual([UNENCRYPTED_WARNING]);
  });

  it('test_false_without_credentials_does_not_warn', async () => {
    const { connection, output } = await send(false, { starttls: false }, {});
    expect(connection.secure).toBe(false);
    expect(connection.auth).toBeNull();
    expect(connection.message).not.toBeNull();
    expect(output).toEqual([]);
  });

  it('test_true_not_advertised_raises', async () => {
    await expect(send(false, { starttls: true })).rejects.toThrow(
      new SMTPError('STARTTLS required but not supported by the server'),
    );
    const connection = lastConnection();
    expect(connection.secure).toBe(false);
    expect(connection.auth).toBeNull();
    expect(connection.message).toBeNull();
  });

  it.each([false, true])(
    'test_require_encryption_ignores_starttls (starttls: %s)',
    async starttls => {
      const { connection } = await send(true, {
        requireEncryption: true,
        starttls,
      });
      expect(connection.options.secure).toBe(true);
      expect(connection.options.ignoreTLS).toBeUndefined();
      expect(connection.message).not.toBeNull();
    },
  );
});

// mailsuite 2.3.4 tests/test_smtp.py::TestSendEmailConnection: one
// connection per send (smtplib's constructors already connect).
describe('TestSendEmailConnection', () => {
  it.each([false, true])(
    'test_connects_once (requireEncryption: %s)',
    async requireEncryption => {
      await sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
        requireEncryption,
      });
      expect(fakeSmtp.instances).toHaveLength(1);
      expect(fakeSmtp.instances[0]?.connectCalls).toBe(1);
      expect(fakeSmtp.instances[0]?.message).not.toBeNull();
    },
  );
});

describe('sendEmail', () => {
  it('sends a message', async () => {
    await sendEmail('smtp.example.com', 'a@example.com', {
      messageTo: ['b@example.org'],
      subject: 'hi',
      plainMessage: 'hello',
    });
    const connection = lastConnection();
    expect(connection.connected).toBe(true);
    expect(connection.options).toMatchObject({
      host: 'smtp.example.com',
      port: 25,
      secure: false,
      tls: {},
    });
    expect(connection.envelope).toEqual({
      from: 'a@example.com',
      to: ['b@example.org'],
    });
    const message = connection.message ?? '';
    const headers = topHeaders(message);
    expect(headers.get('from')).toBe('a@example.com');
    expect(headers.get('to')).toBe('b@example.org');
    expect(headers.get('subject')).toBe('hi');
    expect(headers.get('date')).toMatch(/^\w{3}, \d{2} \w{3} \d{4} /u);
    expect(headers.has('cc')).toBe(false);
    expect(message).toContain('hello');
    expect(connection.quitCalled).toBe(true);
  });

  it('logs in when credentials are given', async () => {
    await sendEmail('smtp.example.com', 'a@example.com', {
      messageTo: ['b@example.org'],
      username: 'user',
      password: 'pw',
    });
    expect(lastConnection().auth).toEqual({ user: 'user', pass: 'pw' });
  });

  it('does not log in without a password', async () => {
    await sendEmail('smtp.example.com', 'a@example.com', {
      messageTo: ['b@example.org'],
      username: 'user',
    });
    expect(lastConnection().auth).toBeNull();
  });

  it('uses STARTTLS when the server offers it, without a warning', async () => {
    const capture = captureLogs(undefined, WARNING);
    try {
      await sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
      });
      expect(lastConnection().secure).toBe(true);
      expect(capture.output).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it('warns when the server does not offer STARTTLS', async () => {
    fakeSmtp.starttls = false;
    const capture = captureLogs(undefined, WARNING);
    try {
      await sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
      });
      expect(lastConnection().secure).toBe(false);
      expect(capture.output).toEqual([
        'WARNING:tsdmarc:SMTP server does not support STARTTLS. Proceeding in plain text!',
      ]);
    } finally {
      capture.restore();
    }
  });

  it('uses implicit TLS on 465 with requireEncryption', async () => {
    fakeSmtp.starttls = false;
    const capture = captureLogs(undefined, WARNING);
    try {
      await sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
        requireEncryption: true,
      });
      expect(lastConnection().options).toMatchObject({
        port: 465,
        secure: true,
      });
      expect(capture.output).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  it('honors an explicit port and verify: false', async () => {
    await sendEmail('smtp.example.com', 'a@example.com', {
      messageTo: ['b@example.org'],
      port: 587,
      verify: false,
    });
    expect(lastConnection().options).toMatchObject({
      port: 587,
      tls: { rejectUnauthorized: false },
    });
  });

  it('puts To, Cc and Bcc in the envelope but never Bcc in the headers', async () => {
    await sendEmail('smtp.example.com', 'Sender <a@example.com>', {
      messageTo: ['b@example.org', 'Cee <c@example.org>'],
      messageCc: ['c@example.org'],
      messageBcc: ['d@example.org'],
    });
    const connection = lastConnection();
    // Every recipient, as bare addresses (smtplib's quoteaddr()). Like
    // mailsuite, duplicates are removed before the display names are
    // stripped, so "Cee <c@...>" and "c@..." both stay.
    expect(connection.envelope).toEqual({
      from: 'a@example.com',
      to: ['b@example.org', 'c@example.org', 'c@example.org', 'd@example.org'],
    });
    const headers = topHeaders(connection.message ?? '');
    expect(headers.get('to')).toBe('b@example.org, Cee <c@example.org>');
    expect(headers.get('cc')).toBe('c@example.org');
    expect(connection.message).not.toContain('d@example.org');
  });

  it('deduplicates envelope recipients', async () => {
    await sendEmail('smtp.example.com', 'a@example.com', {
      messageTo: ['b@example.org'],
      messageCc: ['b@example.org'],
      messageBcc: ['d@example.org', 'd@example.org'],
    });
    expect(lastConnection().envelope?.to).toEqual([
      'b@example.org',
      'd@example.org',
    ]);
  });

  it('does not mutate the recipient lists', async () => {
    const to = ['b@example.org'];
    const cc = ['c@example.org'];
    const bcc = ['d@example.org'];
    await sendEmail('smtp.example.com', 'a@example.com', {
      messageTo: to,
      messageCc: cc,
      messageBcc: bcc,
    });
    expect(to).toEqual(['b@example.org']);
    expect(cc).toEqual(['c@example.org']);
    expect(bcc).toEqual(['d@example.org']);
  });

  it('attaches files as application/octet-stream', async () => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    await sendEmail('smtp.example.com', 'a@example.com', {
      messageTo: ['b@example.org'],
      plainMessage: 'see attached',
      attachments: [['DMARC-2026-10-24.zip', zip]],
    });
    const message = lastConnection().message ?? '';
    expect(topHeaders(message).get('content-type')).toMatch(
      /^multipart\/mixed; boundary=/u,
    );
    const part = message.slice(
      message.indexOf('Content-Type: application/octet-stream'),
    );
    expect(part).toMatch(
      /^Content-Type: application\/octet-stream; Name="DMARC-2026-10-24\.zip"\r\n/u,
    );
    expect(part).toContain(
      'Content-Disposition: attachment; filename="DMARC-2026-10-24.zip"',
    );
    expect(part).toContain('Content-Transfer-Encoding: base64');
    const body = part.split('\r\n\r\n')[1]?.split('\r\n--')[0] ?? '';
    expect(Buffer.from(body.replaceAll('\r\n', ''), 'base64')).toEqual(
      Buffer.from(zip),
    );
    expect(message).toContain('see attached');
  });

  it('requires messageTo after connecting, like mailsuite', async () => {
    await expect(
      sendEmail('smtp.example.com', 'a@example.com'),
    ).rejects.toThrow(new TypeError('message_to cannot be None'));
    expect(lastConnection().envelope).toBeNull();
  });
});

describe('sendEmail errors', () => {
  it('wraps SMTP errors in SMTPError', async () => {
    fakeSmtp.failures.send = {
      error: nodemailerError(
        'Message failed: 550 mailbox unavailable.',
        'EMESSAGE',
      ),
    };
    await expect(
      sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
      }),
    ).rejects.toThrow(new SMTPError('Message failed: 550 mailbox unavailable'));
  });

  it('wraps authentication failures', async () => {
    fakeSmtp.failures.login = {
      error: nodemailerError(
        'Invalid login: 535 5.7.8 Bad credentials',
        'EAUTH',
      ),
    };
    await expect(
      sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
        username: 'u',
        password: 'p',
      }),
    ).rejects.toThrow(
      new SMTPError('Invalid login: 535 5.7.8 Bad credentials'),
    );
  });

  it.each([
    [
      nodemailerError(
        'getaddrinfo ENOTFOUND smtp.example.com',
        'EDNS',
        'ENOTFOUND',
      ),
      'DNS resolution failed',
    ],
    [
      nodemailerError('connect ECONNREFUSED', 'ESOCKET', 'ECONNREFUSED'),
      'Connection refused',
    ],
    [
      nodemailerError('read ECONNRESET', 'ESOCKET', 'ECONNRESET'),
      'Connection reset',
    ],
    [
      nodemailerError('aborted', 'ESOCKET', 'ECONNABORTED'),
      'Connection aborted',
    ],
    [
      nodemailerError('Connection timeout', 'ETIMEDOUT'),
      'Connection timed out',
    ],
    [
      nodemailerError(
        'wrong version number',
        'ESOCKET',
        'ERR_SSL_WRONG_VERSION_NUMBER',
      ),
      'SSL error: wrong version number',
    ],
    [
      nodemailerError('Error initiating TLS - socket hang up', 'ETLS'),
      'SSL error: Error initiating TLS - socket hang up',
    ],
    [
      nodemailerError('certificate has expired', 'ESOCKET', 'CERT_HAS_EXPIRED'),
      'Certificate error: certificate has expired',
    ],
    [
      nodemailerError('Error initiating TLS - self-signed certificate', 'ETLS'),
      'Certificate error: Error initiating TLS - self-signed certificate',
    ],
  ])('wraps connection error %#', async (error, expected) => {
    fakeSmtp.failures.connect = { error, asEvent: true };
    await expect(
      sendEmail('smtp.example.com', 'a@example.com', {
        messageTo: ['b@example.org'],
      }),
    ).rejects.toThrow(new SMTPError(expected));
  });
});
