// Public API of @tsdmarc/msgraph. Grouped by module; keep each group sorted.

export {
  DEFAULT_GRAPH_TIMEOUT,
  DEFAULT_GRAPH_URL,
  encodePathSegment,
  GraphClient,
} from './client';
export type { GraphClientOptions, GraphRequestOptions, Sleep } from './client';
export {
  AuthMethod,
  cacheAuthRecord,
  DEFAULT_TOKEN_CACHE_NAME,
  generateCredential,
  getCacheArgs,
  isAppOnlyAuthMethod,
  loadToken,
} from './credentials';
export type {
  AuthMethodName,
  CacheArgs,
  ClientAssertionProvider,
  GenerateCredentialOptions,
} from './credentials';
export {
  buildReportEmailContent,
  emailResultsViaMsgraph,
} from './email-results';
export type {
  EmailResultsViaMsgraphOptions,
  ReportEmailContent,
  ReportEmailContentOptions,
  ReportZipSource,
} from './email-results';
export { APIError, ODataError, parseMainError } from './errors';
export type {
  APIErrorOptions,
  GraphInnerError,
  GraphMainError,
} from './errors';
export { MSGraphConnection } from './graph';
export type { MSGraphClientOptions, MSGraphConnectionOptions } from './graph';
export { UsernamePasswordCredential } from './ropc';
export type { UsernamePasswordCredentialOptions } from './ropc';
