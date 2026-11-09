// Gmail mailbox backend, ported from mailsuite.mailbox.gmail.
//
// Gmail has no folders, only labels: a "folder" is a label, nesting is the
// `/` in a label's name, and moving a message swaps its labels. Watching
// polls, since the Gmail API push model needs Pub/Sub.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { JWT, type OAuth2Client } from 'google-auth-library';
import {
  emailTooLargeError,
  type FetchMessageOptions,
  type FetchMessagesOptions,
  FolderNotFoundError,
  logger,
  MailboxConnection,
  type MessageId,
  type SendMessageOptions,
  ValueError,
  type WatchOptions,
  createEmail,
} from 'tsdmarc';

import {
  AuthorizedUserCredentials,
  type TransporterOptions,
} from './credentials';
import {
  loadClientSecretsFile,
  type RunLocalServerOptions,
  runLocalServer,
} from './oauth-flow';

/** Per-request timeout for Gmail API and token calls, in milliseconds. */
export const DEFAULT_GMAIL_TIMEOUT_MS = 60_000;
const LABEL_CACHE_SIZE = 10;
const MS_PER_SECOND = 1000;
const HTTP_CONFLICT = 409;
const SERVICE_ACCOUNT_REQUIRED_FIELDS = ['token_uri', 'client_email'];

export interface GetCredsOptions {
  /** `installed_app` (default) or `service_account`. */
  authMode?: string | null;
  /** User to impersonate with domain-wide delegation (service accounts). */
  serviceAccountUser?: string | null;
  /** Extra settings for the installed-app flow (the port comes from `oauth2Port`). */
  oauth2Flow?: Omit<RunLocalServerOptions, 'port'>;
  /** Transport settings for token requests (timeout, `fetchImplementation`). */
  transporterOptions?: TransporterOptions;
}

/** A Google auth client: `OAuth2Client` (user) or `JWT` (service account). */
export type GmailCredentials = OAuth2Client;

async function serviceAccountCredentials(
  credentialsFile: string,
  scopes: string[],
  serviceAccountUser: string | null | undefined,
  transporterOptions: TransporterOptions | undefined,
): Promise<JWT> {
  const info = JSON.parse(await readFile(credentialsFile, 'utf8')) as Record<
    string,
    unknown
  >;
  const missing = SERVICE_ACCOUNT_REQUIRED_FIELDS.filter(
    field => !(field in info),
  );
  if (missing.length > 0) {
    throw new Error(
      `Service account info was not in the expected format, missing fields ${missing.join(', ')}.`,
    );
  }
  if (typeof info.private_key !== 'string') {
    throw new Error(
      'Service account info was not in the expected format, missing fields private_key.',
    );
  }
  return new JWT({
    email: String(info.client_email),
    key: info.private_key,
    keyId:
      typeof info.private_key_id === 'string' ? info.private_key_id : undefined,
    scopes,
    // `with_subject()`: impersonate this user through domain-wide delegation.
    subject: serviceAccountUser || undefined,
    ...(transporterOptions ? { transporterOptions } : {}),
  });
}

/**
 * Write `contents` to `file` with mode 0600, whether or not it exists: the
 * token file holds a refresh token, so it must stay private to the user even
 * when an older copy had wider permissions. A fresh 0600 file in the same
 * directory replaces the old one atomically (no partially written token).
 */
async function writePrivateFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Port of mailsuite's `_get_creds`. Service accounts load the key file
 * (optionally impersonating `serviceAccountUser`). The installed-app mode
 * reuses `tokenFile` when valid, refreshes it when expired, or else runs the
 * local-server OAuth flow on `oauth2Port`; new or refreshed tokens are
 * written back to `tokenFile` (creating its parent directories).
 */
export async function getCreds(
  tokenFile: string,
  credentialsFile: string,
  scopes: string[],
  oauth2Port: number,
  options: GetCredsOptions = {},
): Promise<GmailCredentials> {
  const authMode = options.authMode;
  const normalizedAuthMode = (authMode || 'installed_app').trim().toLowerCase();
  if (normalizedAuthMode === 'service_account') {
    return serviceAccountCredentials(
      credentialsFile,
      scopes,
      options.serviceAccountUser,
      options.transporterOptions,
    );
  }
  if (normalizedAuthMode !== 'installed_app') {
    throw new ValueError(
      `Unsupported Gmail auth_mode '${String(authMode)}'. Expected 'installed_app' or 'service_account'.`,
    );
  }

  let creds: AuthorizedUserCredentials | null = null;
  if (existsSync(tokenFile)) {
    creds = await AuthorizedUserCredentials.fromAuthorizedUserFile(
      tokenFile,
      scopes,
    );
  }

  if (!creds?.valid) {
    if (creds?.expired && creds.refreshToken) {
      await creds.refresh(options.transporterOptions);
    } else {
      const clientConfig = await loadClientSecretsFile(credentialsFile);
      const fetchImplementation =
        options.transporterOptions?.fetchImplementation;
      creds = await runLocalServer(clientConfig, scopes, {
        openBrowser: false,
        ...(fetchImplementation ? { fetchImplementation } : {}),
        ...options.oauth2Flow,
        port: oauth2Port,
      });
    }
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writePrivateFile(tokenFile, creds.toJson());
  }
  return creds.toOAuth2Client(options.transporterOptions);
}

export interface GmailConnectionOptions {
  /** Where the installed-app OAuth token is stored (`token.json`). */
  tokenFile: string;
  /** Client secrets (installed app) or service account key file. */
  credentialsFile: string;
  scopes: string[];
  includeSpamTrash: boolean;
  /** Label holding the reports; messages moved elsewhere lose this label. */
  reportsFolder: string;
  /** Port of the local OAuth redirect server (`0`: any free port). */
  oauth2Port: number;
  /** Follow `nextPageToken` when listing messages. */
  paginateMessages: boolean;
  /** `installed_app` (default) or `service_account`. */
  authMode?: string | null;
  serviceAccountUser?: string | null;
  /** Per-request timeout in milliseconds. Default: 60000. */
  timeout?: number;
  /** Extra settings for the installed-app flow (browser, prompt, timeout). */
  oauth2Flow?: Omit<RunLocalServerOptions, 'port'>;
  /** `fetch` used for every Google request (tests, proxies). */
  fetchImplementation?: typeof fetch;
}

export interface GmailConnectionSettings {
  includeSpamTrash: boolean;
  /** Id of the reports label (`""` when it does not exist). */
  reportsLabelId: string;
  paginateMessages: boolean;
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

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { status, response } = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  if (typeof status === 'number') {
    return status;
  }
  return typeof response?.status === 'number' ? response.status : undefined;
}

/** Python's `base64.urlsafe_b64encode` (padded, `-`/`_` alphabet). */
function urlsafeBase64Encode(data: Uint8Array): string {
  return Buffer.from(data)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

/** Resolve after `ms`, or early (without error) when `signal` aborts. */
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

/**
 * A `MailboxConnection` backed by the Gmail API.
 *
 * Sends mail through `users.messages.send` with the message built by
 * `createEmail()`. Sending requires a scope that includes the send
 * permission (`gmail.send`, `gmail.modify`, or full `mail.google.com`).
 *
 * Create one with {@link GmailConnection.connect}; the constructor takes an
 * already-built Gmail client.
 */
export class GmailConnection extends MailboxConnection {
  readonly kind = 'gmail' as const;
  readonly service: gmail_v1.Gmail;
  includeSpamTrash: boolean;
  reportsLabelId: string;
  paginateMessages: boolean;
  private readonly labelCache = new LruCache<string>(LABEL_CACHE_SIZE);

  constructor(service: gmail_v1.Gmail, settings: GmailConnectionSettings) {
    super();
    this.service = service;
    this.includeSpamTrash = settings.includeSpamTrash;
    this.reportsLabelId = settings.reportsLabelId;
    this.paginateMessages = settings.paginateMessages;
  }

  /** Authenticate, build the Gmail client and resolve the reports label. */
  static async connect(
    options: GmailConnectionOptions,
  ): Promise<GmailConnection> {
    const timeout = options.timeout ?? DEFAULT_GMAIL_TIMEOUT_MS;
    const fetchOptions = options.fetchImplementation
      ? { fetchImplementation: options.fetchImplementation }
      : {};
    const creds = await getCreds(
      options.tokenFile,
      options.credentialsFile,
      options.scopes,
      options.oauth2Port,
      {
        authMode: options.authMode ?? null,
        serviceAccountUser: options.serviceAccountUser ?? null,
        transporterOptions: { timeout, retry: false, ...fetchOptions },
        ...(options.oauth2Flow ? { oauth2Flow: options.oauth2Flow } : {}),
      },
    );
    // Python's googleapiclient does not retry by default (num_retries=0).
    const service = gmail({
      version: 'v1',
      auth: creds,
      timeout,
      retry: false,
      ...fetchOptions,
    });
    return GmailConnection.fromService(service, options);
  }

  /** Wrap an existing Gmail client, resolving `reportsFolder` to its label id. */
  static async fromService(
    service: gmail_v1.Gmail,
    options: Pick<
      GmailConnectionOptions,
      'includeSpamTrash' | 'reportsFolder' | 'paginateMessages'
    >,
  ): Promise<GmailConnection> {
    const connection = new GmailConnection(service, {
      includeSpamTrash: options.includeSpamTrash,
      reportsLabelId: '',
      paginateMessages: options.paginateMessages,
    });
    connection.reportsLabelId = await connection.findLabelIdForLabel(
      options.reportsFolder,
    );
    return connection;
  }

  override async createFolder(folderName: string): Promise<void> {
    // Gmail uses labels; "Archive" isn't a real Gmail concept
    if (folderName === 'Archive') {
      return;
    }

    logger.debug(`Creating label ${folderName}`);
    const requestBody = { name: folderName, messageListVisibility: 'show' };
    try {
      await this.service.users.labels.create({ userId: 'me', requestBody });
    } catch (error) {
      if (httpStatus(error) === HTTP_CONFLICT) {
        logger.debug(`Folder ${folderName} already exists, skipping creation`);
      } else {
        throw error;
      }
    }
    // The label now exists; drop any cached "missing" (empty-id) result so
    // later lookups resolve it (matches rename/delete/moveFolder).
    this.clearLabelCache();
  }

  /**
   * Rename a label.
   *
   * Gmail has no folders, only labels, so renaming patches the label's
   * display name; its immutable id is kept, so message associations stay
   * valid. System labels (`INBOX`, `SENT`, ...) can't be renamed: Gmail
   * rejects it with an HTTP error. Nested labels are independent: renaming
   * `Work` does not touch `Work/Projects`.
   *
   * @throws {FolderExistsError} if a label named `newName` already exists.
   */
  override async renameFolder(oldName: string, newName: string): Promise<void> {
    await this.ensureNoFolderConflict(newName);
    const labelId = await this.findLabelIdForLabel(oldName);
    if (!labelId) {
      // Without this guard we'd PATCH id="" and get a confusing API error.
      throw new FolderNotFoundError(`label ${oldName} not found`);
    }
    logger.debug(`Renaming label ${oldName} to ${newName}`);
    await this.service.users.labels.patch({
      userId: 'me',
      id: labelId,
      requestBody: { name: newName },
    });
    // Only the name→id cache is stale now; the label id is unchanged.
    this.clearLabelCache();
  }

  override async deleteFolder(folderName: string): Promise<void> {
    const labelId = await this.findLabelIdForLabel(folderName);
    if (!labelId) {
      throw new FolderNotFoundError(`label ${folderName} not found`);
    }
    logger.debug(`Deleting label ${folderName}`);
    await this.service.users.labels.delete({ userId: 'me', id: labelId });
    this.clearLabelCache();
  }

  override async folderExists(folderName: string): Promise<boolean> {
    // findLabelIdForLabel returns "" when no label matches the name/id.
    return Boolean(await this.findLabelIdForLabel(folderName));
  }

  protected override async doMoveFolder(
    source: string,
    _targetParent: string,
    targetPath: string,
  ): Promise<void> {
    // Relocating is renaming the label's "/"-path. The label keeps its id,
    // so its messages follow; independently named descendants do not.
    const labelId = await this.findLabelIdForLabel(source);
    if (!labelId) {
      throw new FolderNotFoundError(`label ${source} not found`);
    }
    await this.service.users.labels.patch({
      userId: 'me',
      id: labelId,
      requestBody: { name: targetPath },
    });
    this.clearLabelCache();
  }

  protected override async moveMessageFrom(
    messageId: MessageId,
    source: string,
    destination: string,
  ): Promise<void> {
    // moveMessage drops the configured reports label; a merge must drop the
    // actual source label instead.
    const sourceLabel = await this.findLabelIdForLabel(source);
    const destinationLabel = await this.findLabelIdForLabel(destination);
    await this.service.users.messages.modify({
      userId: 'me',
      id: String(messageId),
      requestBody: {
        addLabelIds: [destinationLabel],
        removeLabelIds: [sourceLabel],
      },
    });
  }

  /** Every message id with the label, following pages when enabled. */
  protected async fetchAllMessageIds(
    reportsLabelId: string,
    since?: string | null,
  ): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.service.users.messages.list({
        userId: 'me',
        includeSpamTrash: this.includeSpamTrash,
        labelIds: [reportsLabelId],
        ...(pageToken === undefined ? {} : { pageToken }),
        ...(since ? { q: `after:${since}` } : {}),
      });
      for (const message of data.messages ?? []) {
        if (message.id) {
          ids.push(message.id);
        }
      }
      pageToken =
        data.nextPageToken && this.paginateMessages
          ? data.nextPageToken
          : undefined;
    } while (pageToken !== undefined);
    return ids;
  }

  override async fetchMessages(
    reportsFolder: string,
    options: FetchMessagesOptions = {},
  ): Promise<string[]> {
    const reportsLabelId = await this.findLabelIdForLabel(reportsFolder);
    return this.fetchAllMessageIds(reportsLabelId, options.since || null);
  }

  /**
   * The raw message. With `maxSize`, a message whose `sizeEstimate` (or
   * decoded size) is larger throws `EmailTooLargeError` before it is
   * decoded. The API returns the content with the size, so it is still
   * downloaded: Gmail's own message size limit bounds it.
   */
  override async fetchMessage(
    messageId: MessageId,
    options: FetchMessageOptions = {},
  ): Promise<string> {
    const { data } = await this.service.users.messages.get({
      userId: 'me',
      id: String(messageId),
      format: 'raw',
    });
    if (typeof data.raw !== 'string') {
      throw new Error(`Gmail returned no raw content for message ${messageId}`);
    }
    const maxSize = options.maxSize ?? 0;
    if (
      maxSize > 0 &&
      typeof data.sizeEstimate === 'number' &&
      data.sizeEstimate > maxSize
    ) {
      throw emailTooLargeError(data.sizeEstimate, maxSize);
    }
    const raw = Buffer.from(data.raw, 'base64url');
    if (maxSize > 0 && raw.length > maxSize) {
      throw emailTooLargeError(raw.length, maxSize);
    }
    return new TextDecoder('utf-8').decode(raw);
  }

  override async deleteMessage(messageId: MessageId): Promise<void> {
    await this.service.users.messages.delete({
      userId: 'me',
      id: String(messageId),
    });
  }

  override async moveMessage(
    messageId: MessageId,
    folderName: string,
  ): Promise<void> {
    const labelId = await this.findLabelIdForLabel(folderName);
    logger.debug(`Moving message UID ${messageId} to ${folderName}`);
    await this.service.users.messages.modify({
      userId: 'me',
      id: String(messageId),
      requestBody: {
        addLabelIds: [labelId],
        removeLabelIds: [this.reportsLabelId],
      },
    });
  }

  override keepalive(): Promise<void> {
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

  /**
   * Send a message through the Gmail API. `saveToSentItems` is accepted for
   * parity with `MSGraphConnection.sendMessage()` but ignored: Gmail always
   * saves a copy to Sent Mail. Like mailsuite, `messageBcc` is not used.
   */
  override async sendMessage(
    options: SendMessageOptions,
  ): Promise<string | null> {
    const raw = createEmail({
      messageFrom: options.messageFrom,
      messageTo: options.messageTo ?? null,
      messageCc: options.messageCc ?? null,
      subject: options.subject ?? null,
      messageHeaders: options.messageHeaders ?? null,
      attachments: options.attachments ?? null,
      plainMessage: options.plainMessage ?? null,
      htmlMessage: options.htmlMessage ?? null,
    });
    const encoded = urlsafeBase64Encode(new TextEncoder().encode(raw));
    const { data } = await this.service.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded },
    });
    return data.id ?? null;
  }

  /** Drop the label name→id cache (Python's `cache_clear()`). */
  clearLabelCache(): void {
    this.labelCache.clear();
  }

  /** Id of the label whose id or name is `labelName`, or `""` if none. */
  async findLabelIdForLabel(labelName: string): Promise<string> {
    const cached = this.labelCache.get(labelName);
    if (cached !== undefined) {
      return cached;
    }
    const { data } = await this.service.users.labels.list({ userId: 'me' });
    let labelId = '';
    for (const label of data.labels ?? []) {
      if (labelName === label.id || labelName === label.name) {
        labelId = label.id ?? '';
        break;
      }
    }
    this.labelCache.set(labelName, labelId);
    return labelId;
  }
}
