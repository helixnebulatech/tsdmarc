// Port of mailsuite.utils.create_email: builds the RFC 822 message that SMTP
// and the Gmail API send. The message is assembled like Python's
// `MIMEMultipart` + `MIMEText` + `MIMEApplication` (compat32 policy) with the
// port of the `email` package, and `Message.as_string()` writes it, so the
// output is Python's: headers are never folded, non-ASCII header values
// become one RFC 2047 `utf-8` encoded word (Q or B, whichever is shorter),
// body line endings become `\n`, and a value with an embedded header
// (a line break followed by a non-blank) throws `HeaderParseError`.

import { base64BodyEncode, formatParam } from './py-email/charset';
import { Message } from './py-email/message';

export interface CreateEmailOptions {
  messageFrom: string;
  messageTo?: string[] | null;
  messageCc?: string[] | null;
  subject?: string | null;
  messageHeaders?: Record<string, string> | null;
  /** `[filename, content]` pairs. */
  attachments?: [string, Uint8Array][] | null;
  plainMessage?: string | null;
  htmlMessage?: string | null;
}

const NON_ASCII = /\P{ASCII}/u;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `email.utils.formatdate(localtime=True)`: RFC 2822 date in local time. */
export function formatDate(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absolute / 60))}${pad2(absolute % 60)}`;
  const day = DAY_NAMES[date.getDay()] ?? '';
  const month = MONTH_NAMES[date.getMonth()] ?? '';
  return `${day}, ${pad2(date.getDate())} ${month} ${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${offset}`;
}

/** `MIMEBase.__init__`: Content-Type (with `add_header` params) and MIME-Version. */
function mimeBase(
  maintype: string,
  subtype: string,
  params: [string, string][],
): Message {
  const message = new Message();
  const parts = [`${maintype}/${subtype}`];
  for (const [name, value] of params) {
    parts.push(formatParam(name, value));
  }
  message.set('Content-Type', parts.join('; '));
  message.set('MIME-Version', '1.0');
  return message;
}

/** `MIMEText(text, subtype)`: us-ascii when it encodes, else utf-8 (base64). */
function mimeText(text: string, subtype: string): Message {
  const charset = NON_ASCII.test(text) ? 'utf-8' : 'us-ascii';
  const message = mimeBase('text', subtype, [['charset', charset]]);
  message.setPayload(text, charset);
  return message;
}

/** `MIMEApplication(data, Name=filename)` with `encode_base64`. */
function mimeApplication(data: Uint8Array, filename: string): Message {
  const message = mimeBase('application', 'octet-stream', [['Name', filename]]);
  message.setPayload(base64BodyEncode(data));
  message.set('Content-Transfer-Encoding', 'base64');
  return message;
}

/**
 * Create an RFC 822 email message and return it as a string.
 *
 * Port of `mailsuite.utils.create_email`: a `multipart/mixed` message with
 * the plain and/or HTML body followed by one `application/octet-stream`
 * part per attachment.
 */
export function createEmail(options: CreateEmailOptions): string {
  const message = mimeBase('multipart', 'mixed', []);
  message.payload = [];
  message.set('From', options.messageFrom);
  if (options.messageTo && options.messageTo.length > 0) {
    message.set('To', options.messageTo.join(', '));
  }
  if (options.messageCc && options.messageCc.length > 0) {
    message.set('Cc', options.messageCc.join(', '));
  }
  message.set('Date', formatDate());
  if (options.subject) {
    message.set('Subject', options.subject);
  }
  for (const [name, value] of Object.entries(options.messageHeaders ?? {})) {
    message.set(name, value);
  }
  if (options.plainMessage !== null && options.plainMessage !== undefined) {
    message.attach(mimeText(options.plainMessage, 'plain'));
  }
  if (options.htmlMessage !== null && options.htmlMessage !== undefined) {
    message.attach(mimeText(options.htmlMessage, 'html'));
  }
  for (const [filename, payload] of options.attachments ?? []) {
    const part = mimeApplication(payload, filename);
    part.set('Content-Disposition', `attachment; filename="${filename}"`);
    message.attach(part);
  }
  return message.asString();
}
