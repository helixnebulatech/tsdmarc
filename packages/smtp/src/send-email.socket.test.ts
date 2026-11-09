// sendEmail() and emailResults() with the real nodemailer, over a socket,
// against a local fake SMTP server: credentials never cross a plain-text
// connection unless `starttls: false` (GHSA-2x4j-7g3q-wr6f), including
// parsedmarc 11.2.1 tests/test_init.py TestEmailResultsStartTLS.

import { captureLogs, INFO, type ParsingResults, WARNING } from 'tsdmarc';
import { afterEach, describe, expect, it } from 'vitest';

import { emailResults } from './email-results';
import { sendEmail, SMTPError, type SendEmailOptions } from './send-email';
import {
  type FakeSmtpServer,
  startFakeSmtpServer,
} from './test/fake-smtp-server';

const USERNAME = 'user@example.com';
const PASSWORD = 'Sup3rSecret-placeholder';
/** The `AUTH PLAIN` initial response nodemailer sends. */
const AUTH_PLAIN = Buffer.from(`\0${USERNAME}\0${PASSWORD}`).toString('base64');
const REFUSAL =
  'The SMTP server does not advertise STARTTLS, so credentials would be sent in plain text. Use require_encryption=True for implicit TLS, or pass starttls=False to allow plain-text authentication';

let server: FakeSmtpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(
  starttls: boolean,
  implicitTls = false,
): Promise<FakeSmtpServer> {
  server = await startFakeSmtpServer({ implicitTls });
  server.starttls = starttls;
  return server;
}

async function send(
  smtp: FakeSmtpServer,
  options: SendEmailOptions,
): Promise<{ error: unknown; output: string[] }> {
  const capture = captureLogs(undefined, INFO);
  try {
    await sendEmail(smtp.host, 'a@example.com', {
      messageTo: ['b@example.org'],
      port: smtp.port,
      verify: false,
      ...options,
    });
    return { error: null, output: capture.output };
  } catch (error) {
    return { error, output: capture.output };
  } finally {
    capture.restore();
  }
}

/** The command verbs received, without QUIT (sent after sendEmail() returns). */
function verbs(smtp: FakeSmtpServer, tls?: boolean): string[] {
  return smtp.commands
    .filter(command => tls === undefined || command.tls === tls)
    .map(command => (command.line.split(' ', 1)[0] ?? '').toUpperCase())
    .filter(verb => verb !== 'QUIT');
}

const CREDENTIALS = { username: USERNAME, password: PASSWORD };

describe('STARTTLS over a socket', () => {
  it.each([null, true])(
    'upgrades before AUTH when advertised (starttls: %s)',
    async starttls => {
      const smtp = await start(true);
      const { error } = await send(smtp, { ...CREDENTIALS, starttls });
      expect(error).toBeNull();
      expect(verbs(smtp, false)).toEqual(['EHLO', 'STARTTLS']);
      expect(verbs(smtp, true)).toEqual([
        'EHLO',
        'AUTH',
        'MAIL',
        'RCPT',
        'DATA',
      ]);
      expect(smtp.plainText).not.toContain(AUTH_PLAIN);
      expect(smtp.messages).toHaveLength(1);
    },
  );

  it('refuses credentials by default when STARTTLS is not advertised', async () => {
    const smtp = await start(false);
    const { error } = await send(smtp, CREDENTIALS);
    expect(error).toEqual(new SMTPError(REFUSAL));
    expect(verbs(smtp)).not.toContain('AUTH');
    expect(verbs(smtp)).not.toContain('MAIL');
    expect(smtp.plainText).not.toContain(AUTH_PLAIN);
    expect(smtp.messages).toEqual([]);
  });

  it.each([{}, CREDENTIALS])(
    'starttls: true refuses when STARTTLS is not advertised (%o)',
    async credentials => {
      const smtp = await start(false);
      const { error } = await send(smtp, { ...credentials, starttls: true });
      expect(error).toEqual(
        new SMTPError('STARTTLS required but not supported by the server'),
      );
      expect(verbs(smtp)).toEqual(['EHLO']);
      expect(smtp.messages).toEqual([]);
    },
  );

  it('sends without credentials in plain text by default, with a warning', async () => {
    const smtp = await start(false);
    const { error, output } = await send(smtp, {});
    expect(error).toBeNull();
    expect(verbs(smtp)).not.toContain('AUTH');
    expect(smtp.messages).toHaveLength(1);
    expect(output).toEqual([
      'WARNING:tsdmarc:SMTP server does not support STARTTLS. Proceeding in plain text!',
    ]);
  });

  it.each([true, false])(
    'starttls: false sends the credentials in plain text (advertised: %s)',
    async advertised => {
      const smtp = await start(advertised);
      const { error, output } = await send(smtp, {
        ...CREDENTIALS,
        starttls: false,
      });
      expect(error).toBeNull();
      expect(verbs(smtp, true)).toEqual([]);
      expect(verbs(smtp)).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']);
      expect(smtp.plainText).toContain(AUTH_PLAIN);
      expect(output).toEqual([
        ...(advertised
          ? [
              'INFO:tsdmarc:SMTP server supports STARTTLS, but it is disabled ... staying in plain text',
            ]
          : []),
        'WARNING:tsdmarc:Sending SMTP credentials unencrypted because starttls=False',
      ]);
    },
  );

  it.each([null, true, false])(
    'uses implicit TLS with requireEncryption (starttls: %s)',
    async starttls => {
      const smtp = await start(false, true);
      const { error } = await send(smtp, {
        ...CREDENTIALS,
        requireEncryption: true,
        starttls,
      });
      expect(error).toBeNull();
      expect(verbs(smtp, false)).toEqual([]);
      expect(verbs(smtp)).not.toContain('STARTTLS');
      expect(verbs(smtp)).toContain('AUTH');
      expect(smtp.plainText).toBe('');
    },
  );
});

// parsedmarc 11.2.1 tests/test_init.py::TestEmailResultsStartTLS
describe('TestEmailResultsStartTLS', () => {
  const RESULTS: ParsingResults = {
    aggregateReports: [],
    failureReports: [],
    smtpTlsReports: [],
  };
  const ZIP = Uint8Array.from([0x50, 0x4b, 0x05, 0x06]);

  async function results(
    smtp: FakeSmtpServer,
    options: Partial<Parameters<typeof emailResults>[4]> = {},
  ): Promise<{ error: unknown; output: string[] }> {
    const capture = captureLogs(undefined, WARNING);
    try {
      await emailResults(
        RESULTS,
        smtp.host,
        'a@example.com',
        ['b@example.org'],
        { port: smtp.port, verify: false, reportZip: ZIP, ...options },
      );
      return { error: null, output: capture.output };
    } catch (error) {
      return { error, output: capture.output };
    } finally {
      capture.restore();
    }
  }

  it('testCredentialsWithoutStartTLSAreRefused', async () => {
    const smtp = await start(false);
    const { error } = await results(smtp, CREDENTIALS);
    expect(error).toBeInstanceOf(SMTPError);
    expect(String(error)).toContain('STARTTLS');
    expect(String(error)).not.toContain(PASSWORD);
    expect((error as Error).stack).not.toContain(PASSWORD);
    expect(verbs(smtp)).not.toContain('AUTH');
    expect(verbs(smtp)).not.toContain('MAIL');
  });

  it('testStartTLSPrecedesLoginAndSend', async () => {
    const smtp = await start(true);
    const { error } = await results(smtp, CREDENTIALS);
    expect(error).toBeNull();
    const names = verbs(smtp);
    expect(names.indexOf('STARTTLS')).toBeLessThan(names.indexOf('AUTH'));
    expect(names.indexOf('AUTH')).toBeLessThan(names.indexOf('MAIL'));
    const auth = smtp.commands.find(command => command.line.startsWith('AUTH'));
    expect(auth).toEqual({ line: `AUTH PLAIN ${AUTH_PLAIN}`, tls: true });
    expect(
      smtp.commands.filter(command => /^(?:MAIL|RCPT)/u.test(command.line)),
    ).toEqual([
      { line: 'MAIL FROM:<a@example.com>', tls: true },
      { line: 'RCPT TO:<b@example.org>', tls: true },
    ]);
    expect(smtp.messages[0]).toContain('Subject: DMARC results for ');
    expect(smtp.messages[0]).toContain('filename="DMARC-');
  });

  it.each([null, true, false])(
    'testRequireEncryptionUsesImplicitTLS (starttls: %s)',
    async starttls => {
      const smtp = await start(false, true);
      const { error } = await results(smtp, {
        ...CREDENTIALS,
        requireEncryption: true,
        starttls,
      });
      expect(error).toBeNull();
      const names = verbs(smtp, true);
      expect(verbs(smtp, false)).toEqual([]);
      expect(names).not.toContain('STARTTLS');
      expect(names.indexOf('AUTH')).toBeLessThan(names.indexOf('MAIL'));
    },
  );

  it('testNoCredentialsWithoutStartTLSSendsWithWarning', async () => {
    const smtp = await start(false);
    const { error, output } = await results(smtp);
    expect(error).toBeNull();
    const names = verbs(smtp);
    expect(names).not.toContain('STARTTLS');
    expect(names).not.toContain('AUTH');
    expect(smtp.messages).toHaveLength(1);
    expect(
      output.some(line => line.includes('does not support STARTTLS')),
    ).toBe(true);
  });

  it('testStartTLSFalseAuthenticatesInPlainText', async () => {
    const smtp = await start(false);
    const { error, output } = await results(smtp, {
      ...CREDENTIALS,
      starttls: false,
    });
    expect(error).toBeNull();
    const names = verbs(smtp);
    expect(names).not.toContain('STARTTLS');
    expect(
      smtp.commands.find(command => command.line.startsWith('AUTH')),
    ).toEqual({ line: `AUTH PLAIN ${AUTH_PLAIN}`, tls: false });
    expect(names.indexOf('AUTH')).toBeLessThan(names.indexOf('MAIL'));
    expect(output.some(line => line.includes('unencrypted'))).toBe(true);
  });

  it('testStartTLSFalseNeverUpgradesEvenWhenAdvertised', async () => {
    const smtp = await start(true);
    const { error } = await results(smtp, { ...CREDENTIALS, starttls: false });
    expect(error).toBeNull();
    const names = verbs(smtp);
    expect(names).not.toContain('STARTTLS');
    expect(names.indexOf('AUTH')).toBeLessThan(names.indexOf('MAIL'));
  });

  it('testStartTLSTrueRefusesWithoutAdvertisement', async () => {
    const smtp = await start(false);
    const { error } = await results(smtp, { starttls: true });
    expect(error).toBeInstanceOf(SMTPError);
    expect(verbs(smtp)).not.toContain('MAIL');
    expect(verbs(smtp)).not.toContain('AUTH');
  });
});
