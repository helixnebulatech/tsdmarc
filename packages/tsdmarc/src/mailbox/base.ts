// Provider-agnostic mailbox interface, ported from mailsuite.mailbox.base.
//
// Backends live in their own packages (`@tsdmarc/imap`, `@tsdmarc/gmail`,
// `@tsdmarc/msgraph`) plus `MaildirConnection` in this package. Methods a
// backend does not support throw `NotImplementedError`. All operations are
// async. `kind` identifies the backend, replacing Python's `isinstance`
// checks so the core never imports backend packages.

import { PyValueError } from '../internal/py';

/** Raised by mailbox methods a backend does not implement. */
export class NotImplementedError extends Error {
  override name = 'NotImplementedError';
}

/** A folder/label operation targets a name that is already taken. */
export class FolderExistsError extends Error {
  override name = 'FolderExistsError';
}

/** A folder/label referenced by an operation does not exist. */
export class FolderNotFoundError extends Error {
  override name = 'FolderNotFoundError';
}

/** Backend identifier. */
export type MailboxKind = 'imap' | 'gmail' | 'msgraph' | 'maildir';

/** Provider-specific message identifier (IMAP UID, Graph/Gmail ID, Maildir key). */
export type MessageId = string | number;

export interface FetchMessagesOptions {
  /** Only messages received since this date (backend-specific format, e.g. `"2d"` or an ISO date). */
  since?: string | null;
  /** Maximum number of messages to return (0 or unset: all). */
  batchSize?: number;
}

export interface FetchMessageOptions {
  /** Mark the message as read after fetching it. */
  markRead?: boolean;
  /**
   * Largest message to download, in bytes. Backends that can learn the size
   * first throw `EmailTooLargeError` instead of downloading a larger one
   * (not marking it read). Not in mailsuite.
   */
  maxSize?: number | null;
}

export interface MoveFolderOptions {
  /** The folder's complete new path. */
  newPath?: string | null;
  /** The folder to move the source under, keeping its leaf name ("" = root). */
  newParent?: string | null;
  /** Create the destination's parent path if missing. */
  create?: boolean;
}

export interface MergeFoldersOptions {
  /** Create the destination if missing. */
  create?: boolean;
  /** Keep the emptied source folders. */
  keepSourceFolders?: boolean;
}

export interface WatchOptions {
  /** Called with this connection whenever the watcher fires. */
  checkCallback: (connection: MailboxConnection) => Promise<void> | void;
  /** Polling interval (or IDLE timeout), in seconds. */
  checkTimeout: number;
  /** When it returns true, the watcher returns so the caller can reload config. */
  configReloading?: (() => boolean) | null;
  /** Aborts the watch loop. */
  signal?: AbortSignal;
}

export interface SendMessageOptions {
  messageFrom: string;
  messageTo?: string[] | null;
  messageCc?: string[] | null;
  messageBcc?: string[] | null;
  subject?: string | null;
  messageHeaders?: Record<string, string> | null;
  /** `[filename, content]` pairs. */
  attachments?: [string, Uint8Array][] | null;
  plainMessage?: string | null;
  htmlMessage?: string | null;
  /** Save a copy to Sent Items (Microsoft Graph only). Default: true. */
  saveToSentItems?: boolean;
}

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new NotImplementedError(
      `${method} is not implemented by this mailbox backend`,
    ),
  );
}

export abstract class MailboxConnection {
  abstract readonly kind: MailboxKind;

  /**
   * Tells this mailbox from others whose message IDs may be the same, for
   * state kept between calls (several connection objects to one mailbox
   * share it). Backends whose IDs are unique on their own leave it empty.
   */
  get mailboxIdentity(): string {
    return '';
  }

  createFolder(_folderName: string): Promise<void> {
    return notImplemented('createFolder');
  }

  deleteFolder(_folderName: string): Promise<void> {
    return notImplemented('deleteFolder');
  }

  /**
   * Rename a folder. Implementations call `ensureNoFolderConflict()` first,
   * so renaming onto an existing name throws `FolderExistsError`.
   */
  renameFolder(_oldName: string, _newName: string): Promise<void> {
    return notImplemented('renameFolder');
  }

  folderExists(_folderName: string): Promise<boolean> {
    return notImplemented('folderExists');
  }

  /** Throw `FolderExistsError` if `folderName` already exists. */
  protected async ensureNoFolderConflict(folderName: string): Promise<void> {
    if (await this.folderExists(folderName)) {
      throw new FolderExistsError(
        `cannot rename to ${JSON.stringify(folderName)}: a folder or label with that name already exists`,
      );
    }
  }

  /**
   * Move a folder (and its contents). Give exactly one of `newPath` (the
   * complete new path) or `newParent` (keep the leaf name).
   */
  async moveFolder(source: string, options: MoveFolderOptions): Promise<void> {
    const newPath = options.newPath ?? null;
    const newParent = options.newParent ?? null;
    if ((newPath === null) === (newParent === null)) {
      throw new PyValueError('provide exactly one of newPath or newParent');
    }
    if (!(await this.folderExists(source))) {
      throw new FolderNotFoundError(
        `folder ${JSON.stringify(source)} not found`,
      );
    }

    let targetParent: string;
    let targetPath: string;
    if (newParent === null) {
      const path = newPath as string;
      const slash = path.lastIndexOf('/');
      targetParent = slash === -1 ? '' : path.slice(0, slash);
      targetPath = path;
    } else {
      const sourceLeaf = source.slice(source.lastIndexOf('/') + 1);
      targetParent = newParent;
      targetPath = newParent ? `${newParent}/${sourceLeaf}` : sourceLeaf;
    }

    if (targetParent && !(await this.folderExists(targetParent))) {
      if (options.create) {
        await this.createFolder(targetParent);
      } else {
        throw new FolderNotFoundError(
          `destination parent ${JSON.stringify(targetParent)} not found (pass create: true to create it)`,
        );
      }
    }

    await this.ensureNoFolderConflict(targetPath);
    await this.doMoveFolder(source, targetParent, targetPath);
  }

  /** Move every message of each source folder into `destination`. */
  async mergeFolders(
    sources: string | string[],
    destination: string,
    options: MergeFoldersOptions = {},
  ): Promise<void> {
    const sourceList = typeof sources === 'string' ? [sources] : sources;
    if (!(await this.folderExists(destination))) {
      if (options.create) {
        await this.createFolder(destination);
      } else {
        throw new FolderNotFoundError(
          `destination ${JSON.stringify(destination)} not found (pass create: true to create it)`,
        );
      }
    }
    for (const source of sourceList) {
      if (source === destination) {
        continue;
      }
      if (!(await this.folderExists(source))) {
        throw new FolderNotFoundError(
          `folder ${JSON.stringify(source)} not found`,
        );
      }
      for (const messageId of await this.fetchMessages(source)) {
        await this.moveMessageFrom(messageId, source, destination);
      }
      if (!options.keepSourceFolders) {
        await this.deleteFolder(source);
      }
    }
  }

  /** Backend-specific relocation, called by `moveFolder()` after validation. */
  protected doMoveFolder(
    _source: string,
    _targetParent: string,
    _targetPath: string,
  ): Promise<void> {
    return notImplemented('moveFolder');
  }

  /** Move one message during `mergeFolders()`. Defaults to `moveMessage()`. */
  protected moveMessageFrom(
    messageId: MessageId,
    _source: string,
    destination: string,
  ): Promise<void> {
    return this.moveMessage(messageId, destination);
  }

  /** Identifiers of the messages in a folder. */
  fetchMessages(
    _reportsFolder: string,
    _options?: FetchMessagesOptions,
  ): Promise<MessageId[]> {
    return notImplemented('fetchMessages');
  }

  /** Raw RFC 822 contents of a message. */
  fetchMessage(
    _messageId: MessageId,
    _options?: FetchMessageOptions,
  ): Promise<string> {
    return notImplemented('fetchMessage');
  }

  deleteMessage(_messageId: MessageId): Promise<void> {
    return notImplemented('deleteMessage');
  }

  moveMessage(_messageId: MessageId, _folderName: string): Promise<void> {
    return notImplemented('moveMessage');
  }

  /** Send a no-op to keep the connection alive (if applicable). */
  keepalive(): Promise<void> {
    return notImplemented('keepalive');
  }

  /** Watch for new messages, calling `checkCallback` on new mail or each interval. */
  watch(_options: WatchOptions): Promise<void> {
    return notImplemented('watch');
  }

  /** Send through the backend's native API. Returns a message ID when available. */
  sendMessage(_options: SendMessageOptions): Promise<string | null> {
    return notImplemented('sendMessage');
  }

  /** Release network resources. No-op for backends without a connection. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
