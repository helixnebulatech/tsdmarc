// Error types of the IMAP client, mirroring the Python exceptions mailsuite
// relies on: imapclient's `IMAPClientError` (imaplib's `IMAP4.error`), its
// `IMAP4.abort` subclass, `TimeoutError`, and mailsuite's
// `MaxRetriesExceeded`.

import { pyRepr } from 'tsdmarc';

/** An IMAP command failed (imapclient's `IMAPClientError`). */
export class IMAPClientError extends Error {
  override name = 'IMAPClientError';
}

/**
 * The connection was lost or broke mid-command (imaplib's `IMAP4.abort`).
 * A subclass of `IMAPClientError`, as in Python; mailsuite retries these.
 */
export class IMAPClientAbortError extends IMAPClientError {
  override name = 'IMAPClientAbortError';
}

/** A connection or command timed out (Python's `TimeoutError`). */
export class IMAPTimeoutError extends Error {
  override name = 'TimeoutError';
}

/** Raised when the maximum number of retries is exceeded. */
export class MaxRetriesExceeded extends Error {
  override name = 'MaxRetriesExceeded';
}

/** A fetched message had none of the expected keys (Python's `KeyError`). */
export class FetchKeyError extends Error {
  override name = 'KeyError';
}

/** Python's class names: imaplib's `IMAP4.error`/`abort` for the errors above. */
const PYTHON_CLASS_NAMES: Readonly<Record<string, string>> = {
  Error: 'Exception',
  IMAPClientAbortError: 'abort',
  IMAPClientError: 'error',
};

/** Python's `repr(exception)`: `error('message')`, `TimeoutError()`. */
export function errorRepr(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const name = PYTHON_CLASS_NAMES[error.name] ?? error.name;
  return error.message === ''
    ? `${name}()`
    : `${name}(${pyRepr(error.message)})`;
}

/** Python's `str(exception)`: the message without the class name. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** imapflow codes for timeouts. */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ETIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
]);

/** imapflow and Node codes for a connection that is gone or never came up. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EConnectionClosed',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'NoConnection',
  'StateLogout',
]);

interface ImapflowErrorFields {
  code?: unknown;
  responseText?: unknown;
}

/**
 * Classify an error thrown by imapflow (or Node's sockets) the way the
 * Python stack would raise it: timeouts as `IMAPTimeoutError`, lost
 * connections as `IMAPClientAbortError`, and everything else (server
 * `NO`/`BAD` responses, authentication failures, ...) as `IMAPClientError`.
 */
export function toImapError(error: unknown): Error {
  if (
    error instanceof IMAPClientError ||
    error instanceof IMAPTimeoutError ||
    error instanceof MaxRetriesExceeded
  ) {
    return error;
  }
  const fields: ImapflowErrorFields =
    typeof error === 'object' && error !== null ? error : {};
  const code = typeof fields.code === 'string' ? fields.code : '';
  let message = errorMessage(error);
  if (typeof fields.responseText === 'string' && fields.responseText) {
    message = `${message}: ${fields.responseText}`;
  }
  let converted: Error;
  if (TIMEOUT_CODES.has(code)) {
    converted = new IMAPTimeoutError(message, { cause: error });
  } else if (CONNECTION_CODES.has(code)) {
    converted = new IMAPClientAbortError(message, { cause: error });
  } else {
    converted = new IMAPClientError(message, { cause: error });
  }
  return converted;
}

/** Errors mailsuite retries after reconnecting (`TimeoutError`, `IMAP4.abort`). */
export function isRetryableError(error: unknown): boolean {
  return (
    error instanceof IMAPTimeoutError || error instanceof IMAPClientAbortError
  );
}

/**
 * Errors that are Python `OSError`s or `KeyError`s, which mailsuite's IDLE
 * loop also recovers from by reconnecting: Node system errors (an `errno`
 * and a `code`, e.g. a failed file write in the callback) and `KeyError`s
 * (`FetchKeyError`, the core's `KeyError`).
 */
export function isOsOrKeyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'KeyError') {
    return true;
  }
  return (
    'errno' in error &&
    typeof error.errno === 'number' &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

/**
 * mailsuite's `str(error).lstrip("b'").rstrip("'").rstrip(".")`, which
 * strips the `b'...'` of a bytes repr and a trailing period.
 */
export function stripErrorText(error: unknown): string {
  return errorMessage(error)
    .replace(/^[b']+/u, '')
    .replace(/'+$/u, '')
    .replace(/\.+$/u, '');
}
