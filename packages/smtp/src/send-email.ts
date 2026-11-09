// Send an email over SMTP, ported from mailsuite.smtp.send_email.
//
// Only the arguments parsedmarc passes are ported (see `email_results()`):
// DKIM signing, OAuth2, `envelope_from`, custom headers and HTML bodies are
// mailsuite features parsedmarc never uses. The message is built with
// the core's createEmail() and sent with nodemailer's SMTPConnection, which gives
// the same control smtplib does: implicit TLS or opportunistic STARTTLS,
// optional login, and an explicit envelope.

import addressparser from 'nodemailer/lib/addressparser';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { createEmail, logger } from 'tsdmarc';

/** Raised when a SMTP error occurs. */
export class SMTPError extends Error {
  override name = 'SMTPError';
}

export interface SendEmailOptions {
  /** Addresses to send mail to. Required (mailsuite raises when it is missing). */
  messageTo?: string[] | null;
  /** Addresses to Carbon Copy. */
  messageCc?: string[] | null;
  /** Addresses to Blind Carbon Copy (envelope only, never in the headers). */
  messageBcc?: string[] | null;
  /** Port. 0 (the default) means 465 with `requireEncryption`, else 25, like smtplib. */
  port?: number;
  /**
   * Use TLS from the start (SMTPS). Otherwise the connection starts in
   * plain text and `starttls` decides whether it is upgraded.
   */
  requireEncryption?: boolean;
  /**
   * Whether to upgrade a plain-text (`requireEncryption: false`) connection
   * with STARTTLS (mailsuite 2.3.4). `null`/`undefined` (default) upgrades
   * when the server advertises STARTTLS. When it does not, it throws
   * `SMTPError` before authenticating if credentials (`username` and
   * `password`) were given, so they are never sent in plain text; without
   * credentials the message is sent in plain text and a warning is logged.
   * `false` never upgrades, so the connection stays plain text even when
   * STARTTLS is advertised, and any credentials are sent unencrypted (a
   * warning is logged when they are). `true` requires the upgrade and
   * throws `SMTPError("STARTTLS required but not supported by the server")`
   * if the server does not advertise STARTTLS. Ignored with
   * `requireEncryption`, because the connection is already TLS.
   */
  starttls?: boolean | null;
  /** Verify the server's TLS certificate. Default: true. */
  verify?: boolean;
  username?: string | null;
  password?: string | null;
  subject?: string | null;
  /** `[filename, content]` pairs, attached as `application/octet-stream`. */
  attachments?: [string, Uint8Array][] | null;
  /** The plain text body. */
  plainMessage?: string | null;
}

const SMTP_PORT = 25;
const SMTPS_PORT = 465;
const PLAINTEXT_REFUSAL =
  'The SMTP server does not advertise STARTTLS, so credentials would be sent in plain text. Use require_encryption=True for implicit TLS, or pass starttls=False to allow plain-text authentication';

/**
 * Build the message with the core's port of mailsuite's `create_email()`,
 * with CRLF line endings as smtplib's `sendmail()` sends it.
 */
function buildMessage(messageFrom: string, options: SendEmailOptions): string {
  return createEmail({
    attachments: options.attachments ?? null,
    messageCc: options.messageCc ?? null,
    messageFrom,
    messageTo: options.messageTo ?? null,
    plainMessage: options.plainMessage ?? null,
    subject: options.subject ?? null,
  }).replaceAll(/\r?\n/gu, '\r\n');
}

/** smtplib's `quoteaddr()`: the bare address of `Name <user@host>`. */
function envelopeAddress(address: string): string {
  const [parsed] = addressparser(address, { flatten: true });
  return parsed?.address || address;
}

interface NodemailerErrorFields {
  code?: unknown;
  originalCode?: unknown;
}

const DNS_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EDNS',
  'ENOTFOUND',
]);
const CERTIFICATE_CODE =
  /^(?:CERT_|ERR_TLS_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE)|HOSTNAME_MISMATCH)/u;
const CERTIFICATE_MESSAGE = /certificate|self[- ]signed/iu;

/** mailsuite's `str(error).lstrip("b'").rstrip("'").rstrip(".")`. */
function stripErrorText(text: string): string {
  return text
    .replace(/^[b']+/u, '')
    .replace(/'+$/u, '')
    .replace(/\.+$/u, '');
}

/**
 * Translate a nodemailer/socket error into mailsuite's `SMTPError`
 * messages. Errors that don't come from the connection (no `code`) are
 * returned unchanged, as Python lets non-SMTP exceptions propagate.
 */
function toSMTPError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof SMTPError) {
    return error;
  }
  const fields = error as NodemailerErrorFields;
  const code = typeof fields.code === 'string' ? fields.code : '';
  const originalCode =
    typeof fields.originalCode === 'string' ? fields.originalCode : code;
  if (code === '') {
    return error;
  }
  const options = { cause: error };
  if (DNS_CODES.has(originalCode) || code === 'EDNS') {
    return new SMTPError('DNS resolution failed', options);
  }
  if (originalCode === 'ECONNREFUSED') {
    return new SMTPError('Connection refused', options);
  }
  if (originalCode === 'ECONNRESET') {
    return new SMTPError('Connection reset', options);
  }
  if (originalCode === 'ECONNABORTED') {
    return new SMTPError('Connection aborted', options);
  }
  if (originalCode === 'ETIMEDOUT' || code === 'ETIMEDOUT') {
    return new SMTPError('Connection timed out', options);
  }
  if (
    CERTIFICATE_CODE.test(originalCode) ||
    (code === 'ETLS' && CERTIFICATE_MESSAGE.test(error.message))
  ) {
    return new SMTPError(`Certificate error: ${error.message}`, options);
  }
  if (code === 'ETLS' || originalCode.startsWith('ERR_SSL_')) {
    return new SMTPError(`SSL error: ${error.message}`, options);
  }
  return new SMTPError(stripErrorText(error.message), options);
}

/**
 * Whether the server's (plain-text) EHLO reply advertised STARTTLS. With
 * `ignoreTLS`, nodemailer keeps that reply in `_ehloLines` (it has no public
 * accessor); without it, the answer is false.
 */
function advertisesStartTls(connection: SMTPConnection): boolean {
  const lines = (connection as unknown as { _ehloLines?: unknown })._ehloLines;
  return (
    Array.isArray(lines) &&
    lines.some(
      line => typeof line === 'string' && /^STARTTLS\b/iu.test(line.trim()),
    )
  );
}

/** Run one callback-style SMTPConnection step, failing on an 'error' event too. */
function step<T>(
  connection: SMTPConnection,
  start: (done: (error: Error | null | undefined, value?: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    connection.once('error', onError);
    start((error, value) => {
      connection.removeListener('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    });
  });
}

/**
 * Send an email using a SMTP relay.
 *
 * Without `requireEncryption` the connection starts in plain text and is
 * upgraded with STARTTLS when the server offers it (see `starttls` to never
 * or always upgrade). When it is not offered, credentials are refused with
 * `SMTPError` before they are sent, and a message without credentials goes
 * out unencrypted with a warning, as with mailsuite. Every
 * recipient (To, Cc and Bcc) is in the SMTP envelope; Bcc is never in the
 * headers. Connection and protocol failures raise `SMTPError`.
 */
export async function sendEmail(
  host: string,
  messageFrom: string,
  options: SendEmailOptions = {},
): Promise<void> {
  const message = buildMessage(messageFrom, options);
  const requireEncryption = options.requireEncryption ?? false;
  // Ignored with implicit TLS, like mailsuite.
  const starttls = requireEncryption ? null : (options.starttls ?? null);
  const { username, password } = options;
  const auth = username && password ? { user: username, pass: password } : null;
  let connection: SMTPConnection | null = null;
  try {
    connection = new SMTPConnection({
      host,
      port: options.port || (requireEncryption ? SMTPS_PORT : SMTP_PORT),
      secure: requireEncryption,
      // starttls: false never upgrades; otherwise nodemailer upgrades when
      // STARTTLS is advertised (a failed upgrade is an error).
      ...(starttls === false ? { ignoreTLS: true } : {}),
      tls: options.verify === false ? { rejectUnauthorized: false } : {},
      logger: false,
    });
    // Late errors (after a step settled) must not crash the process.
    connection.on('error', () => undefined);
    const active = connection;
    await step<void>(active, done => active.connect(error => done(error)));
    if (!(requireEncryption || active.secure)) {
      if (starttls === false) {
        if (advertisesStartTls(active)) {
          logger.info(
            'SMTP server supports STARTTLS, but it is disabled ... staying in plain text',
          );
        }
        if (auth !== null) {
          logger.warning(
            'Sending SMTP credentials unencrypted because starttls=False',
          );
        }
      } else if (starttls === true) {
        // Not upgraded without ignoreTLS: STARTTLS was not advertised.
        throw new SMTPError(
          'STARTTLS required but not supported by the server',
        );
      } else if (auth === null) {
        logger.warning(
          'SMTP server does not support STARTTLS. Proceeding in plain text!',
        );
      } else {
        // Checked before AUTH: an attacker can strip STARTTLS from the
        // plain-text EHLO reply (GHSA-2x4j-7g3q-wr6f).
        throw new SMTPError(PLAINTEXT_REFUSAL);
      }
    }
    if (auth !== null) {
      await step<boolean>(active, done => active.login(auth, done));
    }
    const messageTo = options.messageTo ?? null;
    if (messageTo === null) {
      throw new TypeError('message_to cannot be None');
    }
    // Every recipient, deduplicated: the envelope is Bcc's only path.
    const envelopeTo = [
      ...new Set([
        ...messageTo,
        ...(options.messageCc ?? []),
        ...(options.messageBcc ?? []),
      ]),
    ].map(envelopeAddress);
    const envelope = { from: envelopeAddress(messageFrom), to: envelopeTo };
    await step(active, done => active.send(envelope, message, done));
  } catch (error) {
    throw toSMTPError(error);
  } finally {
    connection?.quit();
  }
}
