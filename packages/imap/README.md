# @tsdmarc/imap

IMAP mailbox connection for [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), built on [imapflow](https://github.com/postalsys/imapflow). Port of `mailsuite.mailbox.imap` and `mailsuite.imap`.

## Install

```sh
npm install tsdmarc @tsdmarc/imap
```

`tsdmarc` is a peer dependency. With pnpm or Bun: `pnpm add tsdmarc @tsdmarc/imap` / `bun add tsdmarc @tsdmarc/imap`. Requires Node 24 or later (Bun and Deno also work).

## Usage

```ts
import { IMAPConnection } from '@tsdmarc/imap';
import { getDmarcReportsFromMailbox, saveOutput } from 'tsdmarc';

const connection = await IMAPConnection.connect(
  'imap.example.com',
  'dmarc@example.com',
  { password: process.env.IMAP_PASSWORD },
);

try {
  const results = await getDmarcReportsFromMailbox(connection, {
    reportsFolder: 'INBOX',
    archiveFolder: 'Archive',
  });
  await saveOutput(results, { outputDirectory: 'output' });
} finally {
  await connection.close();
}
```

To process new reports as they arrive, pass the connection to `watchInbox(connection, callback, options)` from `tsdmarc`. IMAP watching uses IDLE and reconnects after errors.

```ts
import { saveOutput, watchInbox } from 'tsdmarc';

const controller = new AbortController();
await watchInbox(
  connection,
  async results => {
    await saveOutput(results, { outputDirectory: 'output' });
  },
  { reportsFolder: 'INBOX', checkTimeout: 30, signal: controller.signal },
);
```

`IMAPConnection.connect(host, user, options)` connects and logs in. `new IMAPConnection(host, user, options)` only validates; call `await connection.connect()` afterwards.

## Options

`IMAPConnectionOptions`, the third argument of `IMAPConnection.connect()`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `password` | `string \| null` | `null` | Password. Omit when using OAuth2. |
| `port` | `number` | `993` | Server port. |
| `ssl` | `boolean` | `true` | Use TLS from the start. With `false`, the connection starts in plain text and is upgraded with STARTTLS (see Notes). |
| `starttls` | `boolean \| null` | `null` | With `ssl: false`: `null` upgrades when the server advertises STARTTLS and refuses to log in otherwise, `true` requires the upgrade, `false` never upgrades (credentials are sent in plain text, with a warning). Ignored with `ssl: true`. |
| `verify` | `boolean` | `true` | Verify the server's TLS certificate. |
| `timeout` | `number` | `30` | Seconds to wait for the server while a command is in flight. An idle connection never times out. |
| `maxRetries` | `number` | `4` | Retries after a timeout. |
| `oauth2Token` | `string \| null` | `null` | Static OAuth2 access token. |
| `oauth2TokenProvider` | `() => string \| Promise<string>` | `null` | Returns a current access token. Called on every (re)connect, so prefer it over `oauth2Token` for long-running watch loops. |
| `oauth2Mechanism` | `string` | `'XOAUTH2'` | `'XOAUTH2'` or `'OAUTHBEARER'`. Kept for API parity: imapflow picks the mechanism from the server's capabilities. |
| `oauth2Vendor` | `string \| null` | `null` | Yahoo's XOAUTH2 vendor string. Not supported by imapflow; setting it throws. |

The lower-level `IMAPClient` (port of `mailsuite.imap.IMAPClient`) is also exported. Its `IMAPClientOptions` add `username`, `tls` (extra TLS options, mailsuite's `ssl_context`), `initialFolder` (default `'INBOX'`), `idleCallback`, `idleTimeout` (default `30`), `configReloading` and `signal`.

Errors: `IMAPClientError`, `IMAPTimeoutError`, `IMAPClientAbortError`, `MaxRetriesExceeded` and `FetchKeyError`.

## Notes

- **No credentials over plain text** (mailsuite 2.3.4, GHSA-2x4j-7g3q-wr6f). `starttls` is ignored with `ssl: true`:
  - `null` (default) upgrades when STARTTLS is advertised, and otherwise fails before logging in with `IMAPClientError("The IMAP server does not advertise STARTTLS, so credentials would be sent in plain text. ...")`.
  - `true` requires the upgrade and fails with `STARTTLS required but not supported by the server`.
  - `false` never upgrades and logs in over plain text, with the warning `Sending IMAP credentials unencrypted because starttls=False`. Only for local or otherwise trusted servers.
- **imapflow differences.** Connecting is async (`IMAPConnection.connect()`). OAuth2 picks OAUTHBEARER or XOAUTH2 by itself. imapflow prefixes the personal namespace to folder paths, which may affect shared-namespace paths. Messages are fetched with `BODY.PEEK[]` and then flagged `\Seen`, which matches Python's RFC822 fetch.
- **Reconnects** re-select the folder that was selected before, not `INBOX`. mailsuite re-selects INBOX, so its retried move or delete applies the reports folder's UIDs to INBOX. `timeout` works like imaplib's socket timeout: it only runs while a command waits for the server.
- IMAP cannot send mail: `sendMessage()` throws `NotImplementedError`. Use `sendEmail()` from [`@tsdmarc/smtp`](https://www.npmjs.com/package/@tsdmarc/smtp).
- **CLI:** the `[imap]` section of [`@tsdmarc/cli`](https://www.npmjs.com/package/@tsdmarc/cli) configures this connection. Its `starttls` key (or `TSDMARC_IMAP_STARTTLS`), as in parsedmarc 11.2.1, is passed as `starttls`; with `starttls = False` and `ssl = False` a warning is logged at startup.

All deliberate differences from parsedmarc are listed in [Differences from parsedmarc](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
