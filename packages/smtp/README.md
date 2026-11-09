# @tsdmarc/smtp

Send [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme) results by email over SMTP, built on [nodemailer](https://nodemailer.com). Port of `mailsuite.smtp.send_email` and parsedmarc's `email_results()`.

## Install

```sh
npm install tsdmarc @tsdmarc/smtp
```

`tsdmarc` is a peer dependency. With pnpm or Bun: `pnpm add tsdmarc @tsdmarc/smtp` / `bun add tsdmarc @tsdmarc/smtp`. Requires Node 24 or later (Bun and Deno also work).

## Usage

Email parsing results as a zip file (the same JSON and CSV files that `saveOutput()` writes):

```ts
import { emailResults } from '@tsdmarc/smtp';
import { getDmarcReportsFromMailbox, getReportZip } from 'tsdmarc';

const results = await getDmarcReportsFromMailbox(connection, {
  reportsFolder: 'INBOX',
});

await emailResults(
  results,
  'smtp.example.com', // host
  'dmarc@example.com', // from
  ['dmarc-team@example.com'], // to
  {
    reportZip: getReportZip,
    port: 587,
    username: 'dmarc@example.com',
    password: process.env.SMTP_PASSWORD,
  },
);
```

`connection` is any mailbox connection, for example from [`@tsdmarc/imap`](https://www.npmjs.com/package/@tsdmarc/imap). Any `ParsingResults` object works.

Send an arbitrary message:

```ts
import { readFile } from 'node:fs/promises';

import { sendEmail } from '@tsdmarc/smtp';

await sendEmail('smtp.example.com', 'dmarc@example.com', {
  messageTo: ['dmarc-team@example.com'],
  requireEncryption: true, // SMTPS on port 465
  username: 'dmarc@example.com',
  password: process.env.SMTP_PASSWORD,
  subject: 'Weekly DMARC summary',
  plainMessage: 'See the attachment.',
  attachments: [['summary.csv', await readFile('summary.csv')]],
});
```

## Options

`emailResults(results, host, mailFrom, mailTo, options)`. `EmailResultsOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `reportZip` | `Uint8Array \| (results) => Uint8Array \| Promise<Uint8Array>` | required | The zip attachment, or how to build it. Pass the core's `getReportZip`. |
| `subject` | `string \| null` | `DMARC results for YYYY-MM-DD` | Subject. |
| `message` | `string \| null` | `DMARC results for YYYY-MM-DD` | Plain text body. |
| `attachmentFilename` | `string \| null` | `DMARC-YYYY-MM-DD.zip` | Attachment filename. `.zip` is appended if missing. |
| `mailCc` | `string[] \| null` | `null` | Cc addresses. |
| `mailBcc` | `string[] \| null` | `null` | Bcc addresses. |
| `port` | `number` | `0` | `0` means 465 with `requireEncryption`, else 25. |
| `requireEncryption` | `boolean` | `false` | Use TLS from the start (SMTPS). Otherwise the connection starts in plain text and `starttls` decides whether it is upgraded. |
| `verify` | `boolean` | `true` | Verify the server's TLS certificate. |
| `starttls` | `boolean \| null` | `null` | Without `requireEncryption`: `null` upgrades when the server advertises STARTTLS and refuses to send credentials otherwise, `true` requires the upgrade, `false` never upgrades (credentials are sent in plain text, with a warning). |
| `username` | `string \| null` | `null` | SMTP username. |
| `password` | `string \| null` | `null` | SMTP password. |

`sendEmail(host, messageFrom, options)`. `SendEmailOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `messageTo` | `string[] \| null` | required | Recipients. A missing value throws `TypeError`. |
| `messageCc` | `string[] \| null` | `null` | Cc addresses. |
| `messageBcc` | `string[] \| null` | `null` | Bcc addresses (SMTP envelope only, never in the headers). |
| `port` | `number` | `0` | `0` means 465 with `requireEncryption`, else 25, like smtplib. |
| `requireEncryption` | `boolean` | `false` | Use TLS from the start (SMTPS). |
| `starttls` | `boolean \| null` | `null` | As in `EmailResultsOptions`. |
| `verify` | `boolean` | `true` | Verify the server's TLS certificate. |
| `username` | `string \| null` | `null` | SMTP username. Credentials are sent only when both `username` and `password` are set. |
| `password` | `string \| null` | `null` | SMTP password. |
| `subject` | `string \| null` | `null` | Subject. |
| `plainMessage` | `string \| null` | `null` | Plain text body. |
| `attachments` | `[filename, Uint8Array][] \| null` | `null` | Attached as `application/octet-stream`. |

`EmailResultsOptions` also takes `starttls`, like parsedmarc 11.2.1's `email_results()`.

Connection and protocol failures throw `SMTPError`.

## Notes

- **No credentials over plain text** (mailsuite 2.3.4, GHSA-2x4j-7g3q-wr6f). `starttls` is ignored with `requireEncryption`:
  - `null` (default) upgrades when STARTTLS is advertised. When it is not, a username and password make it throw `SMTPError("The SMTP server does not advertise STARTTLS, so credentials would be sent in plain text. ...")` before `AUTH`; without credentials the mail is sent in plain text with a warning.
  - `true` requires the upgrade and throws `SMTPError("STARTTLS required but not supported by the server")`.
  - `false` never upgrades: credentials and mail are sent in plain text, with the warning `Sending SMTP credentials unencrypted because starttls=False` when there are credentials. Only for local or otherwise trusted servers.
- **CLI:** the `[smtp]` section of [`@tsdmarc/cli`](https://www.npmjs.com/package/@tsdmarc/cli) configures `emailResults()`. Its `starttls` key (or `TSDMARC_SMTP_STARTTLS`), as in parsedmarc 11.2.1, is passed as `starttls`; with `starttls = False` and `ssl = False` a warning is logged at startup.

All deliberate differences from parsedmarc are listed in [Differences from parsedmarc](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
