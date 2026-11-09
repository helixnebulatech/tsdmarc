// Errors for failed Microsoft Graph responses, mirroring the Python Graph
// SDK (kiota's `APIError` and msgraph's `ODataError`) so callers can log the
// same details parsedmarc's CLI does: status, Graph error message and the
// request ids.

export interface GraphInnerError {
  requestId: string | null;
  clientRequestId: string | null;
  date: string | null;
}

/** The `error` object of a Graph error response. */
export interface GraphMainError {
  code: string | null;
  message: string | null;
  innerError: GraphInnerError | null;
}

export interface APIErrorOptions {
  responseStatusCode: number;
  responseHeaders: Record<string, string>;
  cause?: unknown;
}

/** A Graph request returned an error status (kiota's `APIError`). */
export class APIError extends Error {
  override name = 'APIError';
  readonly responseStatusCode: number;
  readonly responseHeaders: Record<string, string>;

  constructor(message: string, options: APIErrorOptions) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.responseStatusCode = options.responseStatusCode;
    this.responseHeaders = options.responseHeaders;
  }
}

/** A Graph error response with an OData `error` body (msgraph's `ODataError`). */
export class ODataError extends APIError {
  override name = 'ODataError';
  /** The parsed `error` object of the response body. */
  readonly mainError: GraphMainError;

  constructor(mainError: GraphMainError, options: APIErrorOptions) {
    super(
      mainError.message ??
        `Graph request failed with status ${options.responseStatusCode}`,
      options,
    );
    this.mainError = mainError;
  }

  /** The Graph error message (Python's `primary_message`). */
  get primaryMessage(): string | null {
    return this.mainError.message;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parse a Graph OData error body; `null` if it isn't one. */
export function parseMainError(body: unknown): GraphMainError | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  const inner = record.innerError ?? record.innererror;
  let innerError: GraphInnerError | null = null;
  if (typeof inner === 'object' && inner !== null) {
    const innerRecord = inner as Record<string, unknown>;
    innerError = {
      requestId: text(innerRecord['request-id']),
      clientRequestId: text(innerRecord['client-request-id']),
      date: text(innerRecord.date),
    };
  }
  return {
    code: text(record.code),
    message: text(record.message),
    innerError,
  };
}
