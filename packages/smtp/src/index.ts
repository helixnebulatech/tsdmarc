// Public API of @tsdmarc/smtp.

export { buildReportEmailContent, emailResults } from './email-results';
export type {
  EmailResultsOptions,
  ReportEmailContent,
  ReportEmailContentOptions,
  ReportZip,
} from './email-results';
export { sendEmail, SMTPError } from './send-email';
export type { SendEmailOptions } from './send-email';
