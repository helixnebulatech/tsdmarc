// Microsoft Graph mailbox backend, ported from mailsuite.mailbox.graph.
//
// Python drives the Graph SDK from a private event loop; here every call
// is a plain async `fetch` through `GraphClient`, with tokens from
// azure-identity.

import type { AuthenticationRecord, TokenCredential } from '@azure/identity';
import {
  type FetchMessageOptions,
  type FetchMessagesOptions,
  FolderNotFoundError,
  logger,
  MailboxConnection,
  type MessageId,
  type SendMessageOptions,
  type WatchOptions,
} from 'tsdmarc';

import { encodePathSegment, GraphClient, type Sleep } from './client';
import {
  cacheAuthRecord,
  type ClientAssertionProvider,
  DEFAULT_TOKEN_CACHE_NAME,
  generateCredential,
  isAppOnlyAuthMethod,
} from './credentials';

const FOLDER_CACHE_SIZE = 10;
const DEFAULT_PAGE_SIZE = 100;
const MS_PER_SECOND = 1000;
const HTTP_CONFLICT = 409;

/** Folder names Graph also accepts as ids, keyed by normalized name. */
const WELL_KNOWN_FOLDERS: Readonly<Record<string, string>> = {
  inbox: 'inbox',
  archive: 'archive',
  drafts: 'drafts',
  sentitems: 'sentitems',
  deleteditems: 'deleteditems',
  junkemail: 'junkemail',
};
const WELL_KNOWN_SEPARATORS = /[ -]/gu;

export interface MSGraphConnectionOptions {
  /** One of the {@link AuthMethod} names. */
  authMethod: string;
  /** The mailbox UPN (e.g. `user@example.com`). */
  mailbox: string;
  /** Application (client) ID. */
  clientId: string;
  /** Client secret (ClientSecret auth). */
  clientSecret?: string | null;
  /**
   * User principal name (UsernamePassword auth).
   *
   * @deprecated UsernamePassword (ROPC) auth is deprecated by Microsoft and
   * fails for accounts with MFA. Use DeviceCode or an app-only method.
   */
  username?: string | null;
  /**
   * Password (UsernamePassword auth).
   *
   * @deprecated See {@link MSGraphConnectionOptions.username}.
   */
  password?: string | null;
  /** Microsoft Entra tenant ID. */
  tenantId: string;
  /** File that persists the `AuthenticationRecord` between runs. */
  tokenFile: string;
  /** Allow a plain-text token cache when no OS keychain is available. */
  allowUnencryptedStorage: boolean;
  /** PEM certificate path (Certificate auth). PFX is not supported in Node. */
  certificatePath?: string | null;
  certificatePassword?: string | Uint8Array | null;
  /**
   * Graph endpoint. Default: the worldwide cloud. Pass a sovereign cloud URL
   * (e.g. `https://graph.microsoft.us`) or any other Graph endpoint.
   */
  graphUrl?: string | null;
  /**
   * Token cache name. Default: `"mailsuite"`. parsedmarc passes
   * `"parsedmarc"` so existing caches keep working.
   */
  tokenCacheName?: string;
  /**
   * A static client assertion (a signed JWT, e.g. a federated credential) for
   * ClientAssertion auth. Prefer `clientAssertionProvider` for long-running
   * connections.
   */
  clientAssertion?: string | null;
  /** Returns a current client assertion each time a new token is needed. */
  clientAssertionProvider?: ClientAssertionProvider | null;
  /** Per-request timeout in seconds. Default: 100. */
  timeout?: number;
  /** `fetch` implementation for Graph requests. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

export interface MSGraphClientOptions {
  credential: TokenCredential;
  mailbox: string;
  /** Token scopes; default: `<graph origin>/.default` (app-only). */
  scopes?: string[] | null;
  graphUrl?: string | null;
  timeout?: number;
  fetch?: typeof fetch;
  /** Delay between retries (tests). */
  sleep?: Sleep;
}

/** A credential that signs a user in (DeviceCode, UsernamePassword). */
interface AuthenticatingCredential extends TokenCredential {
  authenticate: (
    scopes: string | string[],
  ) => Promise<AuthenticationRecord | undefined>;
}

function canAuthenticate(
  credential: TokenCredential,
): credential is AuthenticatingCredential {
  return (
    typeof (credential as Partial<AuthenticatingCredential>).authenticate ===
    'function'
  );
}

interface MailFolder {
  id?: string | null;
  displayName?: string | null;
}

interface Page<T> {
  value?: T[] | null;
  '@odata.nextLink'?: string | null;
}

/** Small LRU cache, standing in for Python's `functools.lru_cache`. */
class LruCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCode(error: unknown): number | undefined {
  const code = (error as { responseStatusCode?: unknown } | null)
    ?.responseStatusCode;
  return typeof code === 'number' ? code : undefined;
}

function toRecipients(
  addresses: string[] | null | undefined,
): { emailAddress: { address: string } }[] | undefined {
  if (!addresses || addresses.length === 0) {
    return undefined;
  }
  return addresses.map(address => ({ emailAddress: { address } }));
}

/**
 * A `MailboxConnection` backed by Microsoft Graph.
 *
 * Supports DeviceCode, UsernamePassword (deprecated), ClientSecret,
 * ClientAssertion and Certificate auth via `@azure/identity`. Mail is sent
 * through `/users/{mailbox}/sendMail`, saving a copy to Sent Items unless
 * `saveToSentItems` is false.
 *
 * Required API permissions: `Mail.Read` (fetch), `Mail.ReadWrite` (mark
 * read, delete, move, folders), `Mail.Send` (send). Delegated flows on a
 * shared mailbox (`mailbox !== username`) need the `.Shared` variants;
 * app-only flows don't. Delegated flows always request `Mail.ReadWrite`.
 *
 * Create one with {@link MSGraphConnection.connect}.
 */
export class MSGraphConnection extends MailboxConnection {
  readonly kind = 'msgraph' as const;
  readonly mailboxName: string;
  readonly client: GraphClient;
  private readonly folderCache = new LruCache<string>(FOLDER_CACHE_SIZE);

  constructor(options: MSGraphClientOptions) {
    super();
    const graphUrl = options.graphUrl ?? null;
    const origin = new URL(graphUrl ?? 'https://graph.microsoft.com').origin;
    this.client = new GraphClient({
      credential: options.credential,
      scopes: options.scopes ?? [`${origin}/.default`],
      graphUrl,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    this.mailboxName = options.mailbox;
  }

  /**
   * Build the credential and connect. Delegated methods sign in now
   * (DeviceCode prompts unless the token cache has a session) and save the
   * AuthenticationRecord to `tokenFile`; app-only methods get their first
   * token on the first request.
   */
  static async connect(
    options: MSGraphConnectionOptions,
  ): Promise<MSGraphConnection> {
    let clientAssertionProvider = options.clientAssertionProvider ?? null;
    const staticAssertion = options.clientAssertion;
    if (
      staticAssertion !== null &&
      staticAssertion !== undefined &&
      clientAssertionProvider === null
    ) {
      clientAssertionProvider = (): string => staticAssertion;
    }
    const credential = await generateCredential(
      options.authMethod,
      options.tokenFile,
      {
        clientId: options.clientId,
        clientSecret: options.clientSecret ?? null,
        certificatePath: options.certificatePath ?? null,
        certificatePassword: options.certificatePassword ?? null,
        username: options.username ?? null,
        password: options.password ?? null,
        tenantId: options.tenantId,
        allowUnencryptedStorage: options.allowUnencryptedStorage,
        cacheName: options.tokenCacheName ?? DEFAULT_TOKEN_CACHE_NAME,
        clientAssertionProvider,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
    );

    let scopes: string[] | null = null;
    if (!isAppOnlyAuthMethod(options.authMethod)) {
      scopes = ['Mail.ReadWrite'];
      // Detect if mailbox is shared
      if (
        options.mailbox &&
        options.username &&
        options.username !== options.mailbox
      ) {
        scopes = ['Mail.ReadWrite.Shared'];
      }
      // DeviceCodeCredential and our UsernamePasswordCredential both have
      // authenticate(); the record is saved for the next run.
      if (canAuthenticate(credential)) {
        const authRecord = await credential.authenticate(scopes);
        if (authRecord) {
          await cacheAuthRecord(authRecord, options.tokenFile);
        }
      }
    }

    return new MSGraphConnection({
      credential,
      mailbox: options.mailbox,
      scopes,
      graphUrl: options.graphUrl ?? null,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  private get userPath(): string {
    return `/users/${encodePathSegment(this.mailboxName)}`;
  }

  private folderPath(folderId: string): string {
    return `${this.userPath}/mailFolders/${encodePathSegment(folderId)}`;
  }

  private messagePath(messageId: MessageId): string {
    return `${this.userPath}/messages/${encodePathSegment(String(messageId))}`;
  }

  // — folder management —

  override async createFolder(folderName: string): Promise<void> {
    const pathParts = folderName.split('/');
    let parentFolderId: string | null = null;
    let leafName = folderName;
    if (pathParts.length > 1) {
      for (const folder of pathParts.slice(0, -1)) {
        parentFolderId = await this.findFolderIdWithParent(
          folder,
          parentFolderId,
        );
      }
      leafName = pathParts.at(-1) ?? '';
    }

    const body = { displayName: leafName };
    try {
      if (parentFolderId === null) {
        await this.client.request('POST', `${this.userPath}/mailFolders`, {
          body,
        });
      } else {
        await this.client.request(
          'POST',
          `${this.folderPath(parentFolderId)}/childFolders`,
          { body },
        );
      }
      logger.debug(`Created folder ${leafName}`);
    } catch (error) {
      if (statusCode(error) === HTTP_CONFLICT) {
        logger.debug(`Folder ${leafName} already exists, skipping`);
        return;
      }
      throw error;
    }
  }

  /**
   * Rename a mail folder in place (`PATCH .../mailFolders/{id}`, needs
   * `Mail.ReadWrite`). Graph only changes the display name, never the
   * parent, so only the leaf segment of `newName` is used. The folder id is
   * unchanged.
   *
   * @throws {FolderExistsError} if `newName` already resolves to a folder.
   */
  override async renameFolder(oldName: string, newName: string): Promise<void> {
    await this.ensureNoFolderConflict(newName);
    const folderId = await this.findFolderIdFromFolderPath(oldName);
    const displayName = newName.split('/').at(-1) ?? '';
    await this.client.request('PATCH', this.folderPath(folderId), {
      body: { displayName },
    });
    // The path→id cache now holds a stale name; the id itself is unchanged.
    this.clearFolderCache();
  }

  /**
   * True if the folder (by name or `parent/child` path) resolves to an id.
   * A failed listing call (auth/network) propagates instead of reading as
   * a missing folder.
   */
  override async folderExists(folderName: string): Promise<boolean> {
    try {
      return Boolean(await this.findFolderIdFromFolderPath(folderName));
    } catch (error) {
      if (error instanceof FolderNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  override async deleteFolder(folderName: string): Promise<void> {
    const folderId = await this.findFolderIdFromFolderPath(folderName);
    await this.client.request('DELETE', this.folderPath(folderId));
    this.clearFolderCache();
  }

  protected override async doMoveFolder(
    source: string,
    targetParent: string,
    targetPath: string,
  ): Promise<void> {
    // Graph's move action relocates the folder and its contents under a new
    // parent, keeping the display name. A move can change the folder id, so
    // the follow-up rename uses the id from the response. "" means the root.
    let folderId = await this.findFolderIdFromFolderPath(source);
    const parentId = targetParent
      ? await this.findFolderIdFromFolderPath(targetParent)
      : 'msgfolderroot';
    const moved = (await this.client.request(
      'POST',
      `${this.folderPath(folderId)}/move`,
      { body: { DestinationId: parentId } },
    )) as MailFolder | null;
    if (moved?.id) {
      folderId = moved.id;
    }
    // Full-path moves may also rename the leaf; the native move doesn't.
    const targetLeaf = targetPath.split('/').at(-1) ?? '';
    if (targetLeaf !== source.split('/').at(-1)) {
      await this.client.request('PATCH', this.folderPath(folderId), {
        body: { displayName: targetLeaf },
      });
    }
    this.clearFolderCache();
  }

  // — message reading —

  override async fetchMessages(
    reportsFolder: string,
    options: FetchMessagesOptions = {},
  ): Promise<string[]> {
    const folderId = await this.findFolderIdFromFolderPath(reportsFolder);
    const since = options.since || null;
    const batchSize = options.batchSize || 0;
    return this.fetchMessagesFromFolder(folderId, batchSize, since);
  }

  /** Page through a folder's message ids, stopping once `batchSize` is reached. */
  protected async fetchMessagesFromFolder(
    folderId: string,
    batchSize: number,
    since: string | null,
  ): Promise<string[]> {
    const query: [string, string][] = [];
    if (since) {
      query.push(['$filter', `receivedDateTime ge ${since}`]);
    }
    query.push(
      ['$select', 'id'],
      ['$top', String(batchSize > 0 ? batchSize : DEFAULT_PAGE_SIZE)],
    );
    let page = (await this.client.request(
      'GET',
      `${this.folderPath(folderId)}/messages`,
      { query },
    )) as Page<{ id?: string | null }> | null;
    const ids: string[] = [];
    while (page?.value && page.value.length > 0) {
      for (const message of page.value) {
        if (message.id) {
          ids.push(message.id);
        }
      }
      const nextLink = page['@odata.nextLink'];
      const keepGoing = batchSize === 0 || ids.length < batchSize;
      if (!(nextLink && keepGoing)) {
        break;
      }
      page = (await this.client.request('GET', nextLink)) as Page<{
        id?: string | null;
      }> | null;
    }
    return ids;
  }

  /**
   * Raw MIME content (`GET .../messages/{id}/$value`). With `maxSize`, a
   * larger message (by `Content-Length`, or while reading) is not read in
   * full nor marked read: `EmailTooLargeError` is thrown.
   */
  override async fetchMessage(
    messageId: MessageId,
    options: FetchMessageOptions = {},
  ): Promise<string> {
    const raw = (await this.client.request(
      'GET',
      `${this.messagePath(messageId)}/$value`,
      { binary: true, maxBytes: options.maxSize ?? null },
    )) as Uint8Array | null;
    if (options.markRead) {
      await this.markMessageRead(String(messageId));
    }
    if (raw === null) {
      return '';
    }
    return new TextDecoder('utf-8').decode(raw);
  }

  /** Mark a message as read (Graph-only; not part of `MailboxConnection`). */
  async markMessageRead(messageId: string): Promise<void> {
    await this.client.request('PATCH', this.messagePath(messageId), {
      body: { '@odata.type': '#microsoft.graph.message', isRead: true },
    });
  }

  override async deleteMessage(messageId: MessageId): Promise<void> {
    await this.client.request('DELETE', this.messagePath(messageId));
  }

  override async moveMessage(
    messageId: MessageId,
    folderName: string,
  ): Promise<void> {
    const folderId = await this.findFolderIdFromFolderPath(folderName);
    await this.client.request('POST', `${this.messagePath(messageId)}/move`, {
      body: { DestinationId: folderId },
    });
  }

  override keepalive(): Promise<void> {
    // Graph uses bearer tokens; nothing to ping
    return Promise.resolve();
  }

  /** Poll the mailbox every `checkTimeout` seconds. */
  override async watch(options: WatchOptions): Promise<void> {
    const { checkCallback, checkTimeout, configReloading, signal } = options;
    for (;;) {
      if (signal?.aborted || configReloading?.()) {
        return;
      }
      await sleep(checkTimeout * MS_PER_SECOND, signal);
      if (signal?.aborted || configReloading?.()) {
        return;
      }
      await checkCallback(this);
    }
  }

  // — sending —

  /**
   * Send through `/users/{mailbox}/sendMail`. Graph derives `From` from the
   * mailbox, so `messageFrom` and `messageHeaders` are accepted for API
   * parity but not used. Returns `null` (Graph returns no message id).
   */
  override async sendMessage(
    options: SendMessageOptions,
  ): Promise<string | null> {
    const body =
      options.htmlMessage !== null && options.htmlMessage !== undefined
        ? { content: options.htmlMessage, contentType: 'html' }
        : { content: options.plainMessage ?? '', contentType: 'text' };

    const attachments =
      options.attachments && options.attachments.length > 0
        ? options.attachments.map(([filename, payload]) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: filename,
            contentBytes: Buffer.from(payload).toString('base64'),
          }))
        : undefined;

    // Same keys and order as the Python SDK's serialized Message.
    const message: Record<string, unknown> = {
      '@odata.type': '#microsoft.graph.message',
    };
    const fields: [string, unknown][] = [
      ['attachments', attachments],
      ['bccRecipients', toRecipients(options.messageBcc)],
      ['body', body],
      ['ccRecipients', toRecipients(options.messageCc)],
      ['subject', options.subject ?? undefined],
      ['toRecipients', toRecipients(options.messageTo)],
    ];
    for (const [key, value] of fields) {
      if (value !== undefined) {
        message[key] = value;
      }
    }
    await this.client.request('POST', `${this.userPath}/sendMail`, {
      body: {
        Message: message,
        SaveToSentItems: options.saveToSentItems ?? true,
      },
    });
    return null;
  }

  // — folder ID resolution —

  /** Drop the folder path→id cache (Python's `cache_clear()`). */
  clearFolderCache(): void {
    this.folderCache.clear();
  }

  /** Id of a folder by name or `parent/child` path (cached). */
  async findFolderIdFromFolderPath(folderName: string): Promise<string> {
    const cached = this.folderCache.get(folderName);
    if (cached !== undefined) {
      return cached;
    }
    const pathParts = folderName.split('/');
    let folderId: string;
    if (pathParts.length > 1) {
      let parentFolderId: string | null = null;
      for (const folder of pathParts.slice(0, -1)) {
        parentFolderId = await this.findFolderIdWithParent(
          folder,
          parentFolderId,
        );
      }
      folderId = await this.findFolderIdWithParent(
        pathParts.at(-1) ?? '',
        parentFolderId,
      );
    } else {
      folderId = await this.findFolderIdWithParent(folderName, null);
    }
    this.folderCache.set(folderName, folderId);
    return folderId;
  }

  /** Id of a well-known folder (Inbox, Archive, ...) by name, or `null`. */
  protected async getWellKnownFolderId(
    folderName: string,
  ): Promise<string | null> {
    const folderKey = folderName
      .toLowerCase()
      .replace(WELL_KNOWN_SEPARATORS, '');
    const alias = WELL_KNOWN_FOLDERS[folderKey];
    if (alias === undefined) {
      return null;
    }
    try {
      const folder = (await this.client.request(
        'GET',
        this.folderPath(alias),
      )) as MailFolder | null;
      return folder?.id ?? null;
    } catch {
      return null;
    }
  }

  protected async findFolderIdWithParent(
    folderName: string,
    parentFolderId: string | null,
  ): Promise<string> {
    let folders: MailFolder[];
    try {
      folders = await this.listFoldersFiltered(folderName, parentFolderId);
    } catch (error) {
      if (parentFolderId === null) {
        const wellKnown = await this.getWellKnownFolderId(folderName);
        if (wellKnown) {
          return wellKnown;
        }
      }
      throw new Error(`Failed to list folders: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    for (const folder of folders) {
      if (folder.displayName === folderName && folder.id) {
        return folder.id;
      }
    }

    if (parentFolderId === null) {
      const wellKnown = await this.getWellKnownFolderId(folderName);
      if (wellKnown) {
        return wellKnown;
      }
    }
    // A distinct type from "Failed to list folders", so folderExists() reads
    // a genuine miss as false while listing failures propagate.
    throw new FolderNotFoundError(`folder ${folderName} not found`);
  }

  protected async listFoldersFiltered(
    folderName: string,
    parentFolderId: string | null,
  ): Promise<MailFolder[]> {
    // OData string-literal escape: single quotes are doubled.
    const escaped = folderName.replaceAll("'", "''");
    const query: [string, string][] = [
      ['$filter', `displayName eq '${escaped}'`],
    ];
    const path =
      parentFolderId === null
        ? `${this.userPath}/mailFolders`
        : `${this.folderPath(parentFolderId)}/childFolders`;
    const page = (await this.client.request('GET', path, {
      query,
    })) as Page<MailFolder> | null;
    return page?.value ? [...page.value] : [];
  }
}
