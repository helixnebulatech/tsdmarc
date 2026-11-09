// IMAP mailbox backend, ported from mailsuite.mailbox.imap.

import { setTimeout as sleep } from 'node:timers/promises';

import {
  type FetchMessageOptions,
  type FetchMessagesOptions,
  logger,
  MailboxConnection,
  type MessageId,
  NotImplementedError,
  type SendMessageOptions,
  type WatchOptions,
} from 'tsdmarc';

import { IMAPClient, type OAuth2TokenProvider } from './client';
import { errorMessage, errorRepr, IMAPClientError } from './errors';

const MILLISECONDS_PER_SECOND = 1000;

export interface IMAPConnectionOptions {
  /** Password (omit when using OAuth2). */
  password?: string | null;
  /** Server port. Default: 993. */
  port?: number;
  /**
   * Use TLS from the start; otherwise the connection starts in plain text
   * and `starttls` decides whether it is upgraded. Default: true.
   */
  ssl?: boolean;
  /**
   * Whether to upgrade a plain-text (`ssl: false`) connection with
   * STARTTLS: `null`/`undefined` upgrades when advertised and refuses to
   * authenticate when it is not, `false` never upgrades (credentials are
   * sent unencrypted, with a warning), `true` requires it. Ignored with
   * `ssl: true`. Also used by every reconnect and by `watch()`. See
   * `IMAPClientOptions.starttls`.
   */
  starttls?: boolean | null;
  /** Verify the server's TLS certificate. Default: true. */
  verify?: boolean;
  /** Per-operation timeout, in seconds. Default: 30. */
  timeout?: number;
  /** Retries after a timeout. Default: 4. */
  maxRetries?: number;
  /** Static OAuth2 access token. */
  oauth2Token?: string | null;
  /**
   * Returns a current token. Called again on reconnect, so it is
   * responsible for refreshing the token. Prefer it over `oauth2Token` for
   * long-running watch loops.
   */
  oauth2TokenProvider?: OAuth2TokenProvider | null;
  /** `"XOAUTH2"` (default) or `"OAUTHBEARER"`; see `IMAPClientOptions.oauth2Mechanism`. */
  oauth2Mechanism?: string;
  /** Yahoo's XOAUTH2 vendor string (not supported by imapflow). */
  oauth2Vendor?: string | null;
}

/**
 * A `MailboxConnection` backed by IMAP.
 *
 * Wraps `IMAPClient` and adds the `MailboxConnection` semantics (folder
 * management, polling via IDLE, ...). IMAP has no send capability:
 * `sendMessage()` throws `NotImplementedError`; use `sendEmail()` from
 * `@tsdmarc/smtp`.
 *
 * mailsuite connects in the constructor. Here the constructor only
 * validates; use `IMAPConnection.connect()` (or `await conn.connect()`).
 */
export class IMAPConnection extends MailboxConnection {
  readonly kind = 'imap' as const;
  private readonly host: string;
  private readonly username: string;
  private readonly options: IMAPConnectionOptions;
  private client: IMAPClient;

  constructor(host: string, user: string, options: IMAPConnectionOptions = {}) {
    super();
    this.host = host;
    this.username = user;
    this.options = options;
    this.client = new IMAPClient(host, {
      username: user,
      password: options.password ?? null,
      port: options.port ?? 993,
      ssl: options.ssl ?? true,
      starttls: options.starttls ?? null,
      verify: options.verify ?? true,
      timeout: options.timeout ?? 30,
      maxRetries: options.maxRetries ?? 4,
      oauth2Token: options.oauth2Token ?? null,
      oauth2TokenProvider: options.oauth2TokenProvider ?? null,
      oauth2Mechanism: options.oauth2Mechanism ?? 'XOAUTH2',
      oauth2Vendor: options.oauth2Vendor ?? null,
    });
  }

  /** UIDs are small integers, unique only within one account's mailbox. */
  override get mailboxIdentity(): string {
    return `${this.username}@${this.host}:${this.options.port ?? 993}`;
  }

  /** Connect and log in, like constructing mailsuite's `IMAPConnection`. */
  static async connect(
    host: string,
    user: string,
    options: IMAPConnectionOptions = {},
  ): Promise<IMAPConnection> {
    const connection = new IMAPConnection(host, user, options);
    await connection.connect();
    return connection;
  }

  /** Connect and log in. */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  /** The underlying client (replaced while watching). */
  get imapClient(): IMAPClient {
    return this.client;
  }

  override createFolder(folderName: string): Promise<void> {
    return this.client.createFolder(folderName);
  }

  override async renameFolder(oldName: string, newName: string): Promise<void> {
    await this.ensureNoFolderConflict(newName);
    await this.client.renameFolder(oldName, newName);
  }

  override deleteFolder(folderName: string): Promise<void> {
    return this.client.deleteFolder(folderName);
  }

  override folderExists(folderName: string): Promise<boolean> {
    return this.client.folderExists(folderName);
  }

  protected override async doMoveFolder(
    source: string,
    _targetParent: string,
    targetPath: string,
  ): Promise<void> {
    // IMAP RENAME relocates within the hierarchy in one step, so a move is
    // a rename to the full target path (normaliseFolder() maps "/" to the
    // server's separator).
    await this.client.renameFolder(source, targetPath);
  }

  override async fetchMessages(
    reportsFolder: string,
    options: FetchMessagesOptions = {},
  ): Promise<MessageId[]> {
    await this.client.selectFolder(reportsFolder);
    const since = options.since ?? null;
    if (since !== null) {
      return this.client.search(`SINCE ${since}`);
    }
    return this.client.search();
  }

  override fetchMessage(
    messageId: MessageId,
    options: FetchMessageOptions = {},
  ): Promise<string> {
    return this.client.fetchMessage(Number(messageId), {
      maxSize: options.maxSize ?? null,
    });
  }

  override async deleteMessage(messageId: MessageId): Promise<void> {
    const uid = Number(messageId);
    try {
      await this.client.deleteMessages([uid]);
    } catch (error) {
      if (!(error instanceof IMAPClientError)) {
        throw error;
      }
      logger.warning(
        `IMAP delete fallback for message ${messageId} due to server error: ${errorMessage(error)}`,
      );
      await this.client.addFlags([uid], ['\\Deleted'], { silent: true });
      await this.client.expunge();
    }
  }

  override async moveMessage(
    messageId: MessageId,
    folderName: string,
  ): Promise<void> {
    const uid = Number(messageId);
    try {
      await this.client.moveMessages([uid], folderName);
    } catch (error) {
      if (!(error instanceof IMAPClientError)) {
        throw error;
      }
      logger.warning(
        `IMAP move fallback for message ${messageId} due to server error: ${errorMessage(error)}`,
      );
      await this.client.copy([uid], folderName);
      await this.deleteMessage(messageId);
    }
  }

  override keepalive(): Promise<void> {
    return this.client.noop();
  }

  /**
   * Watch for new messages over an IDLE connection and pass each batch to
   * `checkCallback`. Reconnects after errors, waiting `checkTimeout`
   * seconds first. When it returns, the IDLE connection is left open as
   * this connection's client (like mailsuite); `close()` releases it.
   */
  override async watch(options: WatchOptions): Promise<void> {
    const { checkCallback, checkTimeout, signal } = options;
    const configReloading = options.configReloading ?? null;

    const idleCallbackWrapper = async (client: IMAPClient): Promise<void> => {
      if (client !== this.client) {
        // mailsuite drops the previous client without closing it; close it
        // so its socket doesn't linger until the server times it out.
        const previous = this.client;
        this.client = client;
        await previous.close().catch(() => undefined);
      }
      await checkCallback(this);
    };

    while (true) {
      if (configReloading?.() || signal?.aborted) {
        return;
      }
      try {
        await IMAPClient.connect(this.client.host, {
          username: this.username,
          password: this.options.password ?? null,
          port: this.client.port,
          ssl: this.client.ssl,
          starttls: this.options.starttls ?? null,
          verify: this.options.verify ?? true,
          idleCallback: idleCallbackWrapper,
          idleTimeout: checkTimeout,
          oauth2Token: this.options.oauth2Token ?? null,
          oauth2TokenProvider: this.options.oauth2TokenProvider ?? null,
          oauth2Mechanism: this.options.oauth2Mechanism ?? 'XOAUTH2',
          oauth2Vendor: this.options.oauth2Vendor ?? null,
          configReloading,
          signal: signal ?? null,
        });
      } catch (error) {
        // mailsuite 2.3.4 logs every error with its text (it used to call
        // every IMAPClientError a timeout, hiding the STARTTLS refusal).
        logger.warning(
          `IMAP connection error: ${errorRepr(error)}. Reconnecting...`,
        );
        try {
          await sleep(checkTimeout * MILLISECONDS_PER_SECOND, undefined, {
            signal: signal ?? undefined,
          });
        } catch {
          return;
        }
      }
      if (configReloading?.()) {
        return;
      }
    }
  }

  override sendMessage(_options: SendMessageOptions): Promise<string | null> {
    return Promise.reject(
      new NotImplementedError(
        'IMAP cannot send mail; use sendEmail from @tsdmarc/smtp',
      ),
    );
  }

  /** Log out and close the connection. */
  override close(): Promise<void> {
    return this.client.close();
  }
}
