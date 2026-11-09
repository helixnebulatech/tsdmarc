// opensearch-py's retry policy for opensearch-js.
//
// opensearch-py's Transport retries a request (max_retries=3) on a
// connection error and on HTTP 502/503/504, but not on a timeout
// (retry_on_timeout=False). opensearch-js retries timeouts too, with no
// option to turn that off: a write that timed out but then succeeded on the
// server would be sent again and stored twice. This transport runs each
// attempt with the client's own retries off and retries like Python.

import {
  type ApiError,
  type ApiResponse,
  errors,
  type Transport,
} from '@opensearch-project/opensearch';

type TransportClass = typeof Transport;
type TransportRequestParams = Parameters<Transport['request']>[0];
type TransportRequestOptions = NonNullable<Parameters<Transport['request']>[1]>;
type RequestCallback = (error: ApiError, result: ApiResponse) => void;
interface AbortablePromise extends Promise<ApiResponse> {
  abort: () => void;
}

/** opensearch-py's `Transport.DEFAULT_RETRY_ON_STATUS`. */
const RETRY_ON_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);

function isStream(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === 'function'
  );
}

/** Whether opensearch-py would retry after `error`. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof errors.TimeoutError) {
    return false;
  }
  if (error instanceof errors.ConnectionError) {
    return true;
  }
  return (
    error instanceof errors.ResponseError &&
    RETRY_ON_STATUS.has(error.statusCode)
  );
}

/** Hand the outcome of `promise` to a node-style callback. */
async function deliver(
  promise: Promise<ApiResponse>,
  callback: RequestCallback,
): Promise<void> {
  let result: ApiResponse;
  try {
    result = await promise;
  } catch (error) {
    callback(error as ApiError, (error as { meta: ApiResponse }).meta);
    return;
  }
  // opensearch-js passes null on success; its types leave that out.
  callback(null as unknown as ApiError, result);
}

/**
 * A subclass of `Base` (the client's Transport, or the SigV4 signer's) that
 * never retries a timed-out request.
 */
export function withPythonRetries(Base: TransportClass): TransportClass {
  class PythonRetryTransport extends Base {
    override request(
      params: TransportRequestParams,
      options: TransportRequestOptions | RequestCallback = {},
      callback?: RequestCallback,
    ): AbortablePromise {
      let requestOptions: TransportRequestOptions = {};
      let done = callback;
      if (typeof options === 'function') {
        done = options;
      } else {
        requestOptions = options;
      }
      // Like opensearch-js, never resend a stream body.
      const maxRetries =
        isStream(params.body) || isStream(params.bulkBody)
          ? 0
          : (requestOptions.maxRetries ?? this.maxRetries);
      let current: { abort: () => void } | null = null;
      let aborted = false;
      const attempt = (): Promise<ApiResponse> => {
        const pending = super.request(params, {
          ...requestOptions,
          maxRetries: 0,
        });
        current = pending;
        return pending;
      };
      const run = async (): Promise<ApiResponse> => {
        for (let retries = 0; ; retries += 1) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- attempts are sequential
            return await attempt();
          } catch (error) {
            if (aborted || retries >= maxRetries || !isRetryable(error)) {
              throw error;
            }
          }
        }
      };
      const promise = run();
      const abort = (): void => {
        aborted = true;
        current?.abort();
      };
      if (done) {
        deliver(promise, done).catch((error: unknown) => {
          // A throwing callback surfaces as an uncaught exception, as it
          // does with opensearch-js's own callbacks.
          queueMicrotask(() => {
            throw error;
          });
        });
      }
      return Object.assign(promise, { abort });
    }
  }
  return PythonRetryTransport as TransportClass;
}
