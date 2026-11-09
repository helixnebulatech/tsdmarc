# @tsdmarc/gmail

Gmail API mailbox connection for [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme). Port of `mailsuite.mailbox.gmail`.

## Install

```sh
npm install tsdmarc @tsdmarc/gmail
```

`tsdmarc` is a peer dependency. With pnpm or Bun: `pnpm add tsdmarc @tsdmarc/gmail` / `bun add tsdmarc @tsdmarc/gmail`. Requires Node 24 or later (Bun and Deno also work).

## Usage

```ts
import { GmailConnection } from '@tsdmarc/gmail';
import { getDmarcReportsFromMailbox, saveOutput } from 'tsdmarc';

const connection = await GmailConnection.connect({
  credentialsFile: 'credentials.json', // OAuth client secrets or a service account key
  tokenFile: 'token.json',
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  includeSpamTrash: false,
  reportsFolder: 'INBOX',
  oauth2Port: 8080,
  paginateMessages: true,
  oauth2Flow: { openBrowser: true },
});

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

With a service account and domain-wide delegation:

```ts
const connection = await GmailConnection.connect({
  authMode: 'service_account',
  serviceAccountUser: 'dmarc@example.com', // the user to impersonate
  credentialsFile: 'service-account.json',
  tokenFile: 'token.json',
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  includeSpamTrash: false,
  reportsFolder: 'INBOX',
  oauth2Port: 8080,
  paginateMessages: true,
});
```

`watchInbox(connection, callback, options)` from `tsdmarc` also works with Gmail. It polls every `checkTimeout` seconds.

## Options

`GmailConnectionOptions`, the argument of `GmailConnection.connect()`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `credentialsFile` | `string` | required | OAuth client secrets file (installed app) or service account key file. |
| `tokenFile` | `string` | required | Where the installed-app OAuth token is stored (`token.json`). |
| `scopes` | `string[]` | required | OAuth scopes, for example `https://www.googleapis.com/auth/gmail.modify`. |
| `includeSpamTrash` | `boolean` | required | Include messages in Spam and Trash when listing. |
| `reportsFolder` | `string` | required | Label holding the reports. Messages moved elsewhere lose this label. |
| `oauth2Port` | `number` | required | Port of the local OAuth redirect server. `0` picks a free port. |
| `paginateMessages` | `boolean` | required | Follow `nextPageToken` when listing messages. |
| `authMode` | `string \| null` | `'installed_app'` | `'installed_app'` or `'service_account'`. |
| `serviceAccountUser` | `string \| null` | `null` | User to impersonate with domain-wide delegation (service accounts). |
| `timeout` | `number` | `60000` | Per-request timeout for Gmail API and token calls, in milliseconds. |
| `oauth2Flow` | `Omit<RunLocalServerOptions, 'port'>` | `{ openBrowser: false }` | Extra settings for the installed-app flow (see below). |
| `fetchImplementation` | `typeof fetch` | global `fetch` | `fetch` used for every Google request (tests, proxies). |

`oauth2Flow` (`RunLocalServerOptions`):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `openBrowser` | `boolean` | `false` | Open the sign-in URL in the default browser. The URL is always printed. |
| `timeoutSeconds` | `number \| null` | `null` | Seconds to wait for the redirect. `null` waits forever. On timeout, `WSGITimeoutError` is thrown. |
| `host` | `string` | `'localhost'` | Hostname used in the redirect URI. |
| `bindAddr` | `string` | `'127.0.0.1'` | Address the server listens on (loopback only by default). |
| `authorizationPromptMessage` | `string` |  | Message printed with the URL (`{url}` is replaced). Empty: print nothing. |
| `successMessage` | `string` |  | Text shown in the browser once the redirect is received. |
| `requestTimeout` | `number` | `60000` | HTTP timeout for the token exchange, in milliseconds. |
| `output` | `{ write(text: string): unknown }` | `process.stdout` | Where the prompt is printed. |
| `openUrl` | `(url: string) => void` | built-in launcher | Called instead of the built-in browser launcher when `openBrowser` is true. |

Also exported: `getCreds()` (port of mailsuite's `_get_creds`), `runLocalServer()`, `loadClientSecretsFile()`, `AuthorizedUserCredentials`, `GmailConnection.fromService()` (wraps an existing `@googleapis/gmail` client) and `OAuthFlowError`.

## Notes

- Folders are labels; `/` in a label name means nesting.
- **Installed-app sign-in.** In `installed_app` mode, `tokenFile` is reused while valid and refreshed when it expires. When there is no usable token, the OAuth flow runs. It replaces google-auth-oauthlib's `run_local_server` with a loopback server on `oauth2Port`, PKCE and a `state` check. The sign-in URL is printed once (through the `google_auth_oauthlib.flow` logger).
- **`token.json`** keeps the format of Python's google-auth, so a token created by parsedmarc works here and the other way round. It is always written with mode 0600: a new 0600 file atomically replaces the old one. mailsuite writes it with the process umask.
- `sendMessage()` sends through the Gmail API, which always saves a copy to Sent Mail.
- **CLI:** the `[gmail_api]` section of [`@tsdmarc/cli`](https://www.npmjs.com/package/@tsdmarc/cli) configures this connection.

All deliberate differences from parsedmarc are listed in [Differences from parsedmarc](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
