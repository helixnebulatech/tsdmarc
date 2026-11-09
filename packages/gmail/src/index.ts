// Public API of @tsdmarc/gmail. Grouped by module; keep each group sorted.

export {
  AuthorizedUserCredentials,
  GOOGLE_OAUTH2_TOKEN_ENDPOINT,
} from './credentials';
export type {
  AuthorizedUserCredentialsFields,
  TransporterOptions,
} from './credentials';
export { DEFAULT_GMAIL_TIMEOUT_MS, getCreds, GmailConnection } from './gmail';
export type {
  GetCredsOptions,
  GmailConnectionOptions,
  GmailConnectionSettings,
  GmailCredentials,
} from './gmail';
export {
  codeChallenge,
  loadClientSecretsFile,
  OAuthFlowError,
  runLocalServer,
  WSGITimeoutError,
} from './oauth-flow';
export type { ClientConfig, RunLocalServerOptions } from './oauth-flow';
