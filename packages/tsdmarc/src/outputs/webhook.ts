// Port of parsedmarc/webhook.py.

import { USER_AGENT } from '../constants';
import { logger } from '../log';
import { InvalidURL } from '../utils/http';
import { describeError, httpPost } from './http';

const DEFAULT_TIMEOUT = 60;

/** Raised (and logged) when a request is made after {@link WebhookClient.close}. */
const CLOSED_MESSAGE = 'Cannot send a request, as the client has been closed.';

/** Logged (or thrown) for a URL that can't be parsed; see {@link InvalidURL}. */
const INVALID_URL_MESSAGE =
  'invalid webhook URL (details withheld because they may include credentials)';

const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 299;

function isSuccess(status: number): boolean {
  return status >= HTTP_SUCCESS_MIN && status <= HTTP_SUCCESS_MAX;
}

export type WebhookPayload = string | Uint8Array | Record<string, string>;

export interface WebhookClientOptions {
  /** Seconds to wait for each webhook call (default 60); `null` waits forever. */
  timeout?: number | null;
  /**
   * Throw network errors, timeouts and non-2xx responses instead of only
   * logging them (default `false`, as parsedmarc). Turn it on when the
   * caller has to know a report was not delivered, e.g. before deleting
   * its email; the CLI does.
   */
  throwOnError?: boolean;
}

/** A client for webhooks. */
export class WebhookClient {
  readonly aggregateUrl: string;
  readonly failureUrl: string;
  readonly smtpTlsUrl: string;
  readonly timeout: number | null;
  readonly throwOnError: boolean;
  /** Headers sent with every request. */
  readonly headers: Readonly<Record<string, string>>;
  readonly #closed = new AbortController();

  /**
   * @param aggregateUrl - The aggregate report webhook URL
   * @param failureUrl - The failure report webhook URL
   * @param smtpTlsUrl - The SMTP TLS report webhook URL
   */
  constructor(
    aggregateUrl: string,
    failureUrl: string,
    smtpTlsUrl: string,
    options: WebhookClientOptions = {},
  ) {
    this.aggregateUrl = aggregateUrl;
    this.failureUrl = failureUrl;
    this.smtpTlsUrl = smtpTlsUrl;
    this.timeout =
      options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout;
    this.throwOnError = options.throwOnError ?? false;
    this.headers = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    };
  }

  async saveFailureReportToWebhook(report: string): Promise<void> {
    await this.sendToWebhook(this.failureUrl, report);
  }

  /** Backward-compatible alias of {@link saveFailureReportToWebhook}. */
  async saveForensicReportToWebhook(report: string): Promise<void> {
    await this.saveFailureReportToWebhook(report);
  }

  async saveSmtpTlsReportToWebhook(report: string): Promise<void> {
    await this.sendToWebhook(this.smtpTlsUrl, report);
  }

  async saveAggregateReportToWebhook(report: string): Promise<void> {
    await this.sendToWebhook(this.aggregateUrl, report);
  }

  /**
   * POST `payload` to `webhookUrl`. A string or bytes payload is sent as
   * is; an object is form-encoded. Network errors are logged and swallowed
   * and HTTP error statuses ignored, so a failing webhook never aborts the
   * surrounding batch; with `throwOnError`, both are thrown instead (and
   * not logged here).
   */
  async sendToWebhook(
    webhookUrl: string,
    payload: WebhookPayload,
  ): Promise<void> {
    let status: number;
    try {
      if (this.#closed.signal.aborted) {
        throw new Error(CLOSED_MESSAGE);
      }
      const body =
        typeof payload === 'string' || payload instanceof Uint8Array
          ? payload
          : new URLSearchParams(payload);
      const response = await httpPost(webhookUrl, {
        headers: { ...this.headers },
        body,
        timeout: this.timeout,
        signal: this.#closed.signal,
      });
      // The body is not used (parsedmarc doesn't look at it either); drop
      // it so the connection is released now rather than at GC.
      await response.discard();
      ({ status } = response);
    } catch (error) {
      if (error instanceof InvalidURL) {
        // httpx quotes part of the URL, which can be part of a password
        if (this.throwOnError) {
          throw new Error(INVALID_URL_MESSAGE);
        }
        logger.error(`Webhook Error: ${INVALID_URL_MESSAGE}`);
        return;
      }
      if (this.throwOnError) {
        throw new Error(describeError(error), { cause: error });
      }
      logger.error(`Webhook Error: ${describeError(error)}`);
      return;
    }
    if (this.throwOnError && !isSuccess(status)) {
      // No URL in the message: webhook URLs often carry a token.
      throw new Error(`Webhook responded with HTTP ${status}`);
    }
  }

  /** Close the client: abort in-flight requests and refuse new ones. */
  close(): void {
    this.#closed.abort(new Error(CLOSED_MESSAGE));
  }
}
