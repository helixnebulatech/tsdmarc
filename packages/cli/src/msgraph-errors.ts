// Logging of Microsoft Graph failures (`_msgraph_request_id_suffix`,
// `_log_msgraph_failure`).

import { APIError, ODataError } from '@tsdmarc/msgraph';
import { logger } from 'tsdmarc';

// @azure/identity's credential errors (Python's ClientAuthenticationError).
const AZURE_AUTH_ERRORS: ReadonlySet<string> = new Set([
  'AuthenticationError',
  'AuthenticationRequiredError',
  'CredentialUnavailableError',
  'AggregateAuthenticationError',
]);
// Network failures of `fetch` (Python's httpx.HTTPError).
const HTTP_ERRORS: ReadonlySet<string> = new Set([
  'AbortError',
  'TimeoutError',
]);

/**
 * Whether `error` is one of the error types parsedmarc reports as a Graph
 * failure: a Graph error response, an Azure credential error, or an HTTP
 * transport error.
 */
export function isGraphError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof APIError || AZURE_AUTH_ERRORS.has(error.name)) {
    return true;
  }
  // undici reports network failures as `TypeError: fetch failed`.
  return (
    HTTP_ERRORS.has(error.name) ||
    (error instanceof TypeError && error.message === 'fetch failed')
  );
}

/**
 * ` (request-id=..., client-request-id=...)` with only the ids that are
 * present, or `''`. Never throws.
 */
export function msgraphRequestIdSuffix(error: unknown): string {
  try {
    let requestId: string | null = null;
    let clientRequestId: string | null = null;
    if (error instanceof ODataError) {
      requestId = error.mainError.innerError?.requestId ?? null;
      clientRequestId = error.mainError.innerError?.clientRequestId ?? null;
    }
    if (!requestId && error instanceof APIError) {
      requestId = error.responseHeaders['request-id'] ?? null;
    }
    const parts: string[] = [];
    if (requestId) {
      parts.push(`request-id=${requestId}`);
    }
    if (clientRequestId) {
      parts.push(`client-request-id=${clientRequestId}`);
    }
    return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
  } catch {
    return '';
  }
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(' ');
}

export interface MsgraphFailureContext {
  stage: string;
  mailbox: string | null;
  tenantId: string | null;
  authMethod: string | null;
}

function pyNone(value: string | null): string {
  return value ?? 'None';
}

/**
 * Log one ERROR line for a Microsoft Graph connection, fetch, send or
 * watch failure, naming the mailbox, tenant, auth method and Graph request
 * ids when available. The full error follows at DEBUG.
 */
export function logMsgraphFailure(
  error: unknown,
  context: MsgraphFailureContext,
): void {
  let summary: string;
  if (error instanceof APIError) {
    const primary = error instanceof ODataError ? error.primaryMessage : null;
    const detail = collapseWhitespace(
      primary || error.message || String(error),
    );
    summary = `${error.name} status=${error.responseStatusCode}: ${detail}`;
  } else {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    summary = `${name}: ${collapseWhitespace(message)}`;
  }

  logger.error(
    `Microsoft Graph ${context.stage} failed (mailbox=${pyNone(context.mailbox)}, ` +
      `tenant_id=${pyNone(context.tenantId)}, auth_method=${pyNone(context.authMethod)}): ` +
      `${summary}${msgraphRequestIdSuffix(error)}`,
  );
  logger.debug(`Microsoft Graph ${context.stage} failure details:`, { error });
}
