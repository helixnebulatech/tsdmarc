// Port of parsedmarc's email_results_via_msgraph() and the
// _build_report_email_content() helper it shares with email_results().

import { logger, type ParsingResults, PyDateTime } from 'tsdmarc';

import type { MSGraphConnection } from './graph';

/**
 * The zip attachment: the bytes, or a function building them from the
 * results. Pass tsdmarc's `getReportZip` (from `saveOutput`'s module) to
 * match parsedmarc, which always attaches `get_report_zip(results)`.
 */
export type ReportZipSource =
  | Uint8Array
  | ((results: ParsingResults) => Uint8Array | Promise<Uint8Array>);

export interface ReportEmailContentOptions {
  /** Overrides the default subject. */
  subject?: string | null;
  /** Overrides the default attachment filename (`.zip` is appended if missing). */
  attachmentFilename?: string | null;
  /** Overrides the default plain-text body. */
  message?: string | null;
  /** The report zip (see {@link ReportZipSource}). */
  reportZip: ReportZipSource;
}

export interface ReportEmailContent {
  subject: string;
  message: string;
  attachments: [string, Uint8Array][];
}

/**
 * Subject, plain-text body and zip attachment shared by every
 * report-summary email transport (`_build_report_email_content`).
 */
export async function buildReportEmailContent(
  results: ParsingResults,
  options: ReportEmailContentOptions,
): Promise<ReportEmailContent> {
  const dateString = PyDateTime.now().strftime('%Y-%m-%d');
  let filename: string;
  let attachmentFilename = options.attachmentFilename;
  if (attachmentFilename) {
    if (!attachmentFilename.toLowerCase().endsWith('.zip')) {
      attachmentFilename += '.zip';
    }
    filename = attachmentFilename;
  } else {
    filename = `DMARC-${dateString}.zip`;
  }

  const subject = options.subject ?? `DMARC results for ${dateString}`;
  const message = options.message ?? `DMARC results for ${dateString}`;
  const zipBytes =
    typeof options.reportZip === 'function'
      ? await options.reportZip(results)
      : options.reportZip;
  return { subject, message, attachments: [[filename, zipBytes]] };
}

export interface EmailResultsViaMsgraphOptions extends ReportEmailContentOptions {
  mailCc?: string[] | null;
  mailBcc?: string[] | null;
}

/**
 * Email parsing results as a zip file through an already-authenticated
 * Microsoft Graph connection (`/users/{mailbox}/sendMail`), saving a copy
 * to Sent Items.
 *
 * `reportZip` is required here because the zip builder lives in the core's
 * output module: pass `getReportZip` (or the zip bytes).
 */
export async function emailResultsViaMsgraph(
  results: ParsingResults,
  connection: MSGraphConnection,
  mailTo: string[],
  options: EmailResultsViaMsgraphOptions,
): Promise<void> {
  logger.debug('Emailing report via Microsoft Graph');

  const { subject, message, attachments } = await buildReportEmailContent(
    results,
    options,
  );

  // Graph derives From from the authenticated mailbox and ignores
  // messageFrom; it's still passed for parity with sendMessage().
  await connection.sendMessage({
    messageFrom: connection.mailboxName || '',
    messageTo: mailTo,
    messageCc: options.mailCc ?? null,
    messageBcc: options.mailBcc ?? null,
    subject,
    attachments,
    plainMessage: message,
  });
}
