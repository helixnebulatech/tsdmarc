# @tsdmarc/msgraph

Microsoft Graph mailbox connection for [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme) (Microsoft 365 / Exchange Online). Port of `mailsuite.mailbox.graph`, using `fetch` against the Graph REST API and [`@azure/identity`](https://www.npmjs.com/package/@azure/identity) for tokens.

## Install

```sh
npm install tsdmarc @tsdmarc/msgraph
```

`tsdmarc` is a peer dependency. With pnpm or Bun: `pnpm add tsdmarc @tsdmarc/msgraph` / `bun add tsdmarc @tsdmarc/msgraph`. Requires Node 24 or later (Bun and Deno also work).

To keep the `DeviceCode` token cache between runs, also install the optional peer dependency `@azure/identity-cache-persistence`.

## Usage

```ts
import { emailResultsViaMsgraph, MSGraphConnection } from '@tsdmarc/msgraph';
import { getDmarcReportsFromMailbox, getReportZip, saveOutput } from 'tsdmarc';

const connection = await MSGraphConnection.connect({
  authMethod: 'ClientSecret', // DeviceCode, ClientSecret, Certificate, ClientAssertion, UsernamePassword
  mailbox: 'dmarc@example.com',
  tenantId: process.env.AZURE_TENANT_ID ?? '',
  clientId: process.env.AZURE_CLIENT_ID ?? '',
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  tokenFile: '.token',
  allowUnencryptedStorage: false,
});

try {
  const results = await getDmarcReportsFromMailbox(connection, {
    reportsFolder: 'INBOX',
    archiveFolder: 'Archive',
  });
  await saveOutput(results, { outputDirectory: 'output' });

  // Optional: email the results as a zip from the same mailbox.
  await emailResultsViaMsgraph(
    results,
    connection,
    ['dmarc-team@example.com'],
    {
      reportZip: getReportZip,
    },
  );
} finally {
  await connection.close();
}
```

`watchInbox(connection, callback, options)` from `tsdmarc` also works with Graph. It polls every `checkTimeout` seconds.

## Options

`MSGraphConnectionOptions`, the argument of `MSGraphConnection.connect()`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `authMethod` | `string` | required | `'DeviceCode'`, `'ClientSecret'`, `'Certificate'`, `'ClientAssertion'` or `'UsernamePassword'` (deprecated). |
| `mailbox` | `string` | required | The mailbox UPN, for example `dmarc@example.com`. |
| `clientId` | `string` | required | Application (client) ID. |
| `tenantId` | `string` | required | Microsoft Entra tenant ID. |
| `tokenFile` | `string` | required | File that persists the `AuthenticationRecord` between runs (delegated methods). |
| `allowUnencryptedStorage` | `boolean` | required | Allow a plain-text token cache when no OS keychain is available. |
| `clientSecret` | `string \| null` | `null` | Client secret (`ClientSecret` auth; optional for `UsernamePassword`). |
| `certificatePath` | `string \| null` | `null` | PEM certificate path (`Certificate` auth). PFX is not supported. |
| `certificatePassword` | `string \| Uint8Array \| null` | `null` | Password of the certificate's private key. |
| `clientAssertion` | `string \| null` | `null` | Static client assertion (a signed JWT, for example a federated credential) for `ClientAssertion` auth. |
| `clientAssertionProvider` | `() => string \| Promise<string>` | `null` | Returns a current client assertion each time a token is needed. Prefer it over `clientAssertion` for long-running connections. |
| `username` | `string \| null` | `null` | User principal name (`UsernamePassword` auth, deprecated). |
| `password` | `string \| null` | `null` | Password (`UsernamePassword` auth, deprecated). |
| `graphUrl` | `string \| null` | `'https://graph.microsoft.com'` | Graph endpoint. Pass a sovereign cloud URL (for example `https://graph.microsoft.us`) when needed. Must be https. |
| `tokenCacheName` | `string` | `'mailsuite'` | Token cache name. The tsdmarc CLI passes `'parsedmarc'`, like parsedmarc, so existing caches keep working. |
| `timeout` | `number` | `100` | Per-request timeout, in seconds. |
| `fetch` | `typeof fetch` | global `fetch` | `fetch` implementation for Graph requests and `UsernamePassword` token requests. |

Delegated methods (`DeviceCode`, `UsernamePassword`) sign in during `connect()` and request `Mail.ReadWrite`, or `Mail.ReadWrite.Shared` when `username` differs from `mailbox`. App-only methods get their first token on the first request.

`emailResultsViaMsgraph(results, connection, mailTo, options)` takes `reportZip` (required: the core's `getReportZip`, or the zip bytes), `subject`, `attachmentFilename`, `message`, `mailCc` and `mailBcc`. A copy is saved to Sent Items.

Also exported: `GraphClient`, `generateCredential()`, `UsernamePasswordCredential`, `AuthMethod`, and the errors `APIError` and `ODataError`.

## Notes

- Requests time out after `timeout` seconds. 429/503/504 responses are retried like the Python Graph SDK. Paging links that point to another host are refused.
- **DeviceCode token cache:** persistent caching needs the optional peer `@azure/identity-cache-persistence`, which uses native modules. If it is not installed or fails to load, tokens are cached in memory only, with a warning that says which.
- **Certificate** auth reads PEM files only (Node's `@azure/identity` does not read PFX).
- **`UsernamePassword` is deprecated.** Microsoft is retiring the ROPC flow and it fails for accounts with MFA. Prefer `DeviceCode` or an app-only method. `@azure/identity` for Node has no confidential-client version of this flow, so tsdmarc implements it with `fetch`, like mailsuite's MSAL setup:
  - it sends `client_secret` when one is given and uses the `organizations` tenant;
  - it signs in on every connect and keeps tokens in memory;
  - it saves the `AuthenticationRecord` to `tokenFile` in Python's format;
  - federated (ADFS / WS-Trust) accounts are not supported.
- **`@azure/msal-node` advisory:** this package requires `@azure/identity` `^4.14.1`, which requests `@azure/msal-node@^7.1.0`, the first release with the fix for [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) (`@azure/identity` 4.14.0 requested the affected `^6`). No override is needed; if your lockfile still holds `@azure/identity` 4.14.0, update it.
- **CLI:** the `[msgraph]` section of [`@tsdmarc/cli`](https://www.npmjs.com/package/@tsdmarc/cli) configures this connection.

All deliberate differences from parsedmarc are listed in [Differences from parsedmarc](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
