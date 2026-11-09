---
title: Mailboxes
description: Read DMARC reports from IMAP, Gmail, Microsoft 365 (Microsoft Graph) or a Maildir, with the CLI or the library.
---

tsdmarc reads reports from four kinds of mailbox. In the CLI, configure one of the `[imap]`, `[msgraph]`, `[gmail_api]` or `[maildir]` sections plus the shared [`[mailbox]`](../configuration/#mailbox) section. In the library, create a connection and pass it to `getDmarcReportsFromMailbox()` or `watchInbox()` (see [Using the library](../library/#reading-mailboxes)).

| Mailbox         | Package            | Class               | Watch mode |
| --------------- | ------------------ | ------------------- | ---------- |
| IMAP            | `@tsdmarc/imap`    | `IMAPConnection`    | IMAP IDLE  |
| Microsoft Graph | `@tsdmarc/msgraph` | `MSGraphConnection` | polling    |
| Gmail API       | `@tsdmarc/gmail`   | `GmailConnection`   | polling    |
| Maildir         | `tsdmarc`          | `MaildirConnection` | polling    |

Processed messages are moved to subfolders of the archive folder: `Archive/Aggregate`, `Archive/Failure`, `Archive/SMTP-TLS`, `Archive/Invalid` (messages that are not reports) and `Archive/Unsaved` (messages whose reports could not be saved after the allowed retries). Existing `Archive/Forensic` folders from older parsedmarc versions are migrated to `Archive/Failure`.

## IMAP

```ini
[imap]
host = imap.example.com
user = dmarcreports@example.com
password = $uperSecure

[mailbox]
watch = True
```

```ts
import { IMAPConnection } from '@tsdmarc/imap';

const connection = await IMAPConnection.connect(
  'imap.example.com',
  'dmarcreports@example.com',
  {
    password: process.env.IMAP_PASSWORD,
    // port: 993, ssl: true, verify: true, timeout: 30, maxRetries: 4
  },
);
```

### Encryption and plain-text logins

- `ssl = True` (the default, port 993): TLS from the start.
- `ssl = False` (usually port 143): the connection starts in plain text and must be upgraded with STARTTLS before logging in.

As in parsedmarc 11.2.1 (see [Security](../security/#no-credentials-over-plain-text)), when the server doesn't advertise STARTTLS the password is not sent: the connection fails with `The IMAP server does not advertise STARTTLS, so credentials would be sent in plain text. …`, since an attacker could have stripped the STARTTLS offer. `starttls = True` always requires the upgrade (`STARTTLS required but not supported by the server` otherwise). For a server on the same host that has no TLS (such as [DavMail](../../background/davmail/) on `127.0.0.1`), `starttls = False` allows logging in over plain text; it never upgrades, even when STARTTLS is advertised, and a warning is logged at startup:

```ini
[imap]
host = 127.0.0.1
port = 1143
ssl = False
starttls = False
```

In the library, the same options are `ssl` and `starttls` of `IMAPConnection.connect()`: `starttls` is `null` by default (upgrade when advertised, refuse to log in otherwise), `true` or `false`, and is ignored with `ssl: true`.

### OAuth2

For providers that require OAuth2 for IMAP, pass a token instead of a password (library only):

```ts
const connection = await IMAPConnection.connect(
  'imap.gmail.com',
  'dmarc@example.com',
  {
    // Called on every (re)connect, so it can refresh the token
    oauth2TokenProvider: async () => getAccessToken(),
  },
);
```

imapflow picks OAUTHBEARER or XOAUTH2 itself.

## Microsoft Graph (Microsoft 365)

Reading through the Graph API is preferred over IMAP for Microsoft 365. You need an app registration in Microsoft Entra ID with the right Microsoft Graph permissions, granted by an administrator.

| Auth method | Kind | Reading own mailbox | Reading a shared mailbox |
| --- | --- | --- | --- |
| `DeviceCode`, `UsernamePassword` | delegated | `Mail.ReadWrite` | `Mail.ReadWrite.Shared` |
| `ClientSecret`, `Certificate`, `ClientAssertion` | app-only | `Mail.ReadWrite` (application), scoped with `New-ApplicationAccessPolicy` | same |

:::caution
App-only permissions allow access to **every** mailbox by default. Restrict the application to the reports mailbox with the Exchange PowerShell module (to scope it to shared mailboxes, put them in a mail-enabled security group and use the group):

```powershell
New-ApplicationAccessPolicy -AccessRight RestrictAccess `
  -AppId "<CLIENT_ID>" -PolicyScopeGroupId "<MAILBOX>" `
  -Description "Restrict access to dmarc reports mailbox."
```
:::

### Minimal configurations

`ClientSecret` (app-only):

```ini
[msgraph]
auth_method = ClientSecret
client_id = ...
tenant_id = ...
client_secret = ...
mailbox = dmarc-reports@example.com
```

`Certificate` (app-only; a PEM file with the certificate and private key):

```ini
[msgraph]
auth_method = Certificate
client_id = ...
tenant_id = ...
certificate_path = /path/to/cert.pem
mailbox = dmarc-reports@example.com
```

`ClientAssertion` (app-only; a static signed JWT, usually short-lived, so best for one-shot runs rather than watch mode):

```ini
[msgraph]
auth_method = ClientAssertion
client_id = ...
tenant_id = ...
client_assertion = ...
mailbox = dmarc-reports@example.com
```

`DeviceCode` (delegated; prompts for an interactive sign-in on the first run, then reuses the cached session; `user` signs in, `mailbox` may be a shared mailbox):

```ini
[msgraph]
auth_method = DeviceCode
client_id = ...
tenant_id = ...
user = signing-in-user@example.com
mailbox = dmarc-reports@example.com
```

`UsernamePassword` (delegated; **deprecated by Microsoft** and fails for accounts with MFA):

```ini
[msgraph]
auth_method = UsernamePassword
client_id = ...
client_secret = ...
user = dmarc-reports@example.com
password = ...
```

The default `reports_folder` is `Inbox` when `[msgraph]` is configured.

### Token cache

`token_file` (default `.token`) stores the authentication record between runs. For `DeviceCode`, a persistent token cache needs the optional package `@azure/identity-cache-persistence` (native modules); without it, tokens are cached in memory and you are asked to sign in again after a restart (a warning says so). The cache keeps parsedmarc's name, `parsedmarc`, so existing caches keep working. `allow_unencrypted_storage = True` allows a plain-text cache when no OS keychain is available.

### National clouds

`graph_url` changes the Graph API root (for example `https://graph.microsoft.us`), but sign-in always uses `https://login.microsoftonline.com`, so it only helps tenants registered in the global cloud. Graph URLs must use `https`.

### Sending the summary email through Graph

With `[msgraph]` configured and an `[smtp]` section that has `to` but no `host`, the summary email is sent through the same Graph mailbox (`/users/{mailbox}/sendMail`) and saved to Sent Items. This needs `Mail.Send` (application) with an app-only auth method; delegated methods don't request `Mail.Send`, so sending fails with them.

```ini
[msgraph]
auth_method = Certificate
client_id = ...
tenant_id = ...
mailbox = dmarc-reports@example.com
certificate_path = /path/to/cert.pem

[smtp]
to = admin@example.com
subject = DMARC Summary
```

### Library

```ts
import { MSGraphConnection } from '@tsdmarc/msgraph';

const connection = await MSGraphConnection.connect({
  authMethod: 'ClientSecret',
  clientId: process.env.GRAPH_CLIENT_ID!,
  clientSecret: process.env.GRAPH_CLIENT_SECRET!,
  tenantId: process.env.GRAPH_TENANT_ID!,
  mailbox: 'dmarc-reports@example.com',
  tokenFile: '.token',
  allowUnencryptedStorage: false,
});
```

### Troubleshooting

Run with `--verbose` to log a summary of the connection (auth method, tenant, client ID, mailbox, Graph URL) and with `--debug` to also see Azure Identity token activity (including `AADSTS` error codes) and Graph requests. Secrets are never logged.

| Error | Cause | Fix |
| --- | --- | --- |
| "…needs permission to access resources in your organization that only an admin can grant" | A delegated method requests a scope the tenant admin hasn't consented to | Grant admin consent: Entra ID → Enterprise applications → your app → Permissions → Grant admin consent |
| `ErrorItemNotFound: … Default folder Root not found` | A custom `reports_folder` on a mailbox whose folders aren't fully provisioned | Use (or nest under) a well-known folder (`Inbox`, `Archive`, …), or sign in to the mailbox once in Outlook to provision it |

## Gmail API

### Installed app (OAuth in a browser)

1. In the Google Cloud console, enable the Gmail API and create an **OAuth client ID** of type _Desktop app_. Download its JSON as `credentials.json`.
2. Configure tsdmarc:

   ```ini
   [gmail_api]
   credentials_file = /etc/tsdmarc/credentials.json
   token_file = /var/lib/tsdmarc/token.json
   scopes = https://www.googleapis.com/auth/gmail.modify

   [mailbox]
   reports_folder = dmarc
   archive_folder = dmarc/archive
   ```

3. On the first run, tsdmarc prints a sign-in URL and listens on `localhost:<oauth2_port>` (8080) for the redirect. After you approve access, the token is saved to `token_file` and refreshed automatically.

tsdmarc's local OAuth server uses PKCE and checks the `state` parameter. The `token.json` file has the same format as parsedmarc's (so an existing token works) and is always written with mode `0600`.

### Service account (Google Workspace)

With domain-wide delegation, a service account can read a user's mailbox without a browser:

```ini
[gmail_api]
auth_mode = service_account
credentials_file = /etc/tsdmarc/service-account.json
service_account_user = dmarc@example.com
```

`token_file` is not used in this mode.

Gmail labels play the role of folders: `reports_folder` and `archive_folder` are label names, and moving a message replaces its label.

Deleting messages (`[mailbox] delete` or any `delete_*`) needs the `https://mail.google.com/` scope. Without it, tsdmarc logs an error and archives instead. A `SIGHUP` reload checks again against the scopes of the running connection, which the reload keeps, so adding the scope takes a restart (and a new token); parsedmarc only checks at startup, so a reload turns deletion back on.

### Library

```ts
import { GmailConnection } from '@tsdmarc/gmail';

const connection = await GmailConnection.connect({
  credentialsFile: 'credentials.json',
  tokenFile: 'token.json',
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  includeSpamTrash: false,
  reportsFolder: 'INBOX',
  oauth2Port: 8080,
  paginateMessages: true,
});
```

## Maildir

For mail delivered to a local Maildir (Postfix, Dovecot, fetchmail, …):

```ini
[maildir]
maildir_path = /home/dmarc/Maildir
maildir_create = False
```

```ts
import { MaildirConnection } from 'tsdmarc';

const connection = new MaildirConnection('/home/dmarc/Maildir', {
  maildirCreate: false,
});
```

Archive folders are created as Maildir++ subfolders (sibling directories whose names start with `.`). When tsdmarc runs as root and the Maildir belongs to another user, it switches to that user's uid, with the Maildir's group as its only group. If that fails (common in containers without `CAP_SETUID`/`CAP_SETGID`, and always on Deno), `MaildirConnection` throws `PrivilegeDropError` and the CLI exits with `Maildir Error`; mailsuite only warns and goes on as root. Run tsdmarc as the Maildir's owner, or `chown` the Maildir to the user tsdmarc runs as. Run as another non-root user, tsdmarc only warns that access may fail.

## Exchange without IMAP or Graph

If your organization only allows Exchange Web Services (EWS) / Outlook Web Access, use [DavMail](../../background/davmail/) as a local IMAP gateway.
