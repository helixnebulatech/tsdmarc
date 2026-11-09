// Email parsing results as a zip file, ported from parsedmarc's
// `email_results()` and `_build_report_email_content()`.

import { AssertionError } from 'node:assert';

import { logger, type ParsingResults } from 'tsdmarc';

import { sendEmail } from './send-email';

/**
 * The zip attachment: its bytes, or a function that builds them from the
 * results. Pass the core's `getReportZip` (parsedmarc's `get_report_zip()`).
 */
export type ReportZip =
  | Uint8Array
  | ((results: ParsingResults) => Promise<Uint8Array> | Uint8Array);

export interface ReportEmailContentOptions {
  /** Overrides the default subject (`DMARC results for YYYY-MM-DD`). */
  subject?: string | null;
  /** Overrides the default attachment filename; `.zip` is appended if missing. */
  attachmentFilename?: string | null;
  /** Overrides the default plain text body. */
  message?: string | null;
  /** The zip attachment, or how to build it. */
  reportZip: ReportZip;
}

export interface ReportEmailContent {
  subject: string;
  message: string;
  attachments: [string, Uint8Array][];
}

export interface EmailResultsOptions extends ReportEmailContentOptions {
  mailCc?: string[] | null;
  mailBcc?: string[] | null;
  /** 0 (default): 465 with `requireEncryption`, else 25. */
  port?: number;
  /**
   * Connect with implicit SSL/TLS from the start (usually port 465). When
   * false, the connection starts in plain text and `starttls` decides
   * whether it is upgraded.
   */
  requireEncryption?: boolean;
  /**
   * Whether to upgrade a plain-text (`requireEncryption: false`) connection
   * with STARTTLS (parsedmarc 11.2.1). `null`/`undefined` (default)
   * upgrades when the server advertises STARTTLS; when it does not,
   * `SMTPError` is thrown before authenticating if `username` and
   * `password` are given, and without credentials the message is sent in
   * plain text with a warning. `true` requires the upgrade. `false` never
   * upgrades, so any credentials and the message are sent in plain text (a
   * warning is logged when credentials are sent). Ignored with
   * `requireEncryption`. See `SendEmailOptions.starttls`.
   */
  starttls?: boolean | null;
  /** Verify the TLS certificate. Default: true. */
  verify?: boolean;
  username?: string | null;
  password?: string | null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `datetime.now().strftime("%Y-%m-%d")`: today's local date. */
function localDateString(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Build the subject, plain text body and zip attachment shared by every
 * report-summary email transport (SMTP here, Microsoft Graph in
 * `@tsdmarc/msgraph`).
 */
export async function buildReportEmailContent(
  results: ParsingResults,
  options: ReportEmailContentOptions,
): Promise<ReportEmailContent> {
  const dateString = localDateString();
  let filename: string;
  if (options.attachmentFilename) {
    filename = options.attachmentFilename;
    if (!filename.toLowerCase().endsWith('.zip')) {
      filename += '.zip';
    }
  } else {
    filename = `DMARC-${dateString}.zip`;
  }
  const subject = options.subject ?? `DMARC results for ${dateString}`;
  const message = options.message ?? `DMARC results for ${dateString}`;
  const { reportZip } = options;
  const zipBytes =
    typeof reportZip === 'function' ? await reportZip(results) : reportZip;
  return { subject, message, attachments: [[filename, zipBytes]] };
}

/**
 * Email parsing results as a zip file.
 *
 * `options.reportZip` provides the attachment: pass the core's
 * `getReportZip` (or bytes already built). parsedmarc calls
 * `get_report_zip()` itself; taking it as an argument keeps this package
 * independent of the output module.
 */
export async function emailResults(
  results: ParsingResults,
  host: string,
  mailFrom: string,
  mailTo: string[] | null,
  options: EmailResultsOptions,
): Promise<void> {
  logger.debug('Emailing report');
  if (!Array.isArray(mailTo)) {
    throw new AssertionError({
      message: 'mail_to must be a list',
      actual: mailTo,
      expected: 'an array',
      operator: 'Array.isArray',
    });
  }
  const { subject, message, attachments } = await buildReportEmailContent(
    results,
    options,
  );
  await sendEmail(host, mailFrom, {
    messageTo: mailTo,
    messageCc: options.mailCc ?? null,
    messageBcc: options.mailBcc ?? null,
    port: options.port ?? 0,
    requireEncryption: options.requireEncryption ?? false,
    verify: options.verify ?? true,
    username: options.username ?? null,
    password: options.password ?? null,
    subject,
    attachments,
    plainMessage: message,
    starttls: options.starttls ?? null,
  });
}
