// Public API of @tsdmarc/imap.

export { chunks, IMAPClient } from './client';
export type {
  IdleCallback,
  IdleResponse,
  IMAPClientOptions,
  OAuth2TokenProvider,
  StartIdleOptions,
} from './client';
export { IMAPConnection } from './connection';
export type { IMAPConnectionOptions } from './connection';
export {
  FetchKeyError,
  IMAPClientAbortError,
  IMAPClientError,
  IMAPTimeoutError,
  MaxRetriesExceeded,
} from './errors';
