// Maildir mailbox backend, ported from mailsuite.mailbox.maildir.
//
// mailsuite builds on Python's `mailbox.Maildir`; this module reimplements
// the parts of it the connection relies on with `node:fs`: the
// `new`/`cur`/`tmp` layout, Maildir++ subfolders stored as sibling
// `.<folder>` directories, and the `:2,<flags>` info suffix. Like mailsuite
// 2.3.3, messages are read as stored and marked read or moved by renaming
// their files, never re-serialized. Keys, file names and folder names are the
// same as Python's, so a Maildir can be shared with mailsuite/parsedmarc.

import { constants as fsConstants, mkdirSync, statSync } from 'node:fs';
import {
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { EOL } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { emailTooLargeError } from '../errors';
import { logger } from '../log';
import {
  type FetchMessageOptions,
  type FetchMessagesOptions,
  MailboxConnection,
  type MessageId,
  NotImplementedError,
  type SendMessageOptions,
  type WatchOptions,
} from './base';

/** The Maildir directory does not exist and `maildirCreate` was not set. */
export class NoSuchMailboxError extends Error {
  override name = 'NoSuchMailboxError';
}

/** A folder can't be removed because it still holds messages or subfolders. */
export class NotEmptyError extends Error {
  override name = 'NotEmptyError';
}

/** A move would overwrite a message with the same key (`mailbox.ExternalClashError`). */
export class ExternalClashError extends Error {
  override name = 'ExternalClashError';
}

/**
 * Running as root, the process could not fully drop to the Maildir's owner
 * (uid, gid and supplementary groups). mailsuite only warns and stays root.
 */
export class PrivilegeDropError extends Error {
  override name = 'PrivilegeDropError';
}

/** No message has the given key (Python's `KeyError`). */
export class MaildirKeyError extends Error {
  override name = 'KeyError';
}

export interface MaildirConnectionOptions {
  /** Create the Maildir (`cur`, `new`, `tmp`) if it doesn't exist. Default: false. */
  maildirCreate?: boolean;
}

/** Separator between a message's unique name and its info (`:2,S`). */
const COLON = ':';
const SUBDIRS = ['tmp', 'new', 'cur'] as const;
const TOC_SUBDIRS = ['new', 'cur'] as const;
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o666;
const MILLISECONDS_PER_SECOND = 1000;
const MAILDIR_INFO_PREFIX = '2,';
const SEEN_FLAG = 'S';

// `bytes.decode("utf-8", "replace")`, which keeps a byte order mark.
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Python's `str(exception)`: the message without the class name. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Python's `os.path.isdir`: false for anything missing or unreadable. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** The flags of an info suffix (`2,RS` → `RS`), like `MaildirMessage.get_flags()`. */
function flagsOf(info: string): string {
  return info.startsWith(MAILDIR_INFO_PREFIX)
    ? info.slice(MAILDIR_INFO_PREFIX.length)
    : '';
}

/** `MaildirMessage.add_flag()`: merge, deduplicate and sort the flags. */
function addFlag(info: string, flag: string): string {
  const flags = new Set([...flagsOf(info), ...flag]);
  return `${MAILDIR_INFO_PREFIX}${[...flags].sort().join('')}`;
}

/**
 * The parts of Python's `mailbox.Maildir` that `MaildirConnection` uses.
 *
 * Keys are the unique part of a file name (before the colon). The table of
 * contents is rebuilt on every lookup miss and every `keys()` call, which is
 * what Python's `_refresh()` amounts to when files change underneath it.
 */
class Maildir {
  readonly root: string;
  private toc = new Map<string, string>();

  private constructor(root: string) {
    this.root = root;
  }

  /** Open (and with `create`, make) a Maildir, like `mailbox.Maildir(path, create=...)`. */
  static openSync(dirname: string, create: boolean): Maildir {
    const root = path.resolve(dirname);
    let exists = true;
    try {
      statSync(root);
    } catch {
      exists = false;
    }
    if (!exists) {
      if (!create) {
        throw new NoSuchMailboxError(root);
      }
      mkdirSync(root, { mode: FOLDER_MODE });
      for (const subdir of SUBDIRS) {
        mkdirSync(path.join(root, subdir), { mode: FOLDER_MODE });
      }
    }
    return new Maildir(root);
  }

  /** `Maildir.add_folder()`: open or create `.<folder>` and its `maildirfolder` marker. */
  async addFolder(folder: string): Promise<Maildir> {
    const folderPath = path.join(this.root, `.${folder}`);
    const result = Maildir.openSync(folderPath, true);
    const markerPath = path.join(folderPath, 'maildirfolder');
    // O_CREAT without O_EXCL/O_TRUNC: create the marker, keep an existing one.
    const handle = await open(
      markerPath,
      fsConstants.O_CREAT | fsConstants.O_WRONLY,
      FILE_MODE,
    );
    await handle.close();
    return result;
  }

  /** `Maildir.remove_folder()`: delete an empty folder. */
  async removeFolder(folder: string): Promise<void> {
    const folderPath = path.join(this.root, `.${folder}`);
    const entries = [
      ...(await readdir(path.join(folderPath, 'new'))),
      ...(await readdir(path.join(folderPath, 'cur'))),
    ];
    for (const entry of entries) {
      if (entry.length < 1 || !entry.startsWith('.')) {
        throw new NotEmptyError(`Folder contains message(s): ${folder}`);
      }
    }
    for (const entry of await readdir(folderPath)) {
      if (
        entry !== 'new' &&
        entry !== 'cur' &&
        entry !== 'tmp' &&
        (await isDirectory(path.join(folderPath, entry)))
      ) {
        throw new NotEmptyError(
          `Folder contains subdirectory '${folder}': ${entry}`,
        );
      }
    }
    // What is left are new/cur/tmp (holding only dot files) and plain files.
    for (const entry of await readdir(folderPath)) {
      await rm(path.join(folderPath, entry), { recursive: true });
    }
    await rmdir(folderPath);
  }

  /** `Maildir._refresh()`: map each key to its `new/...` or `cur/...` subpath. */
  private async refresh(): Promise<void> {
    const toc = new Map<string, string>();
    for (const subdir of TOC_SUBDIRS) {
      const subdirPath = path.join(this.root, subdir);
      for (const entry of await readdir(subdirPath)) {
        if (entry.startsWith('.')) {
          continue;
        }
        if (await isDirectory(path.join(subdirPath, entry))) {
          continue;
        }
        const key = entry.split(COLON)[0] ?? entry;
        toc.set(key, path.join(subdir, entry));
      }
    }
    this.toc = toc;
  }

  /** `Maildir._lookup()`: the subpath of a key, or `MaildirKeyError`. */
  private async lookup(key: string): Promise<string> {
    const cached = this.toc.get(key);
    if (cached !== undefined) {
      try {
        await stat(path.join(this.root, cached));
        return cached;
      } catch {
        // Moved or deleted since the last refresh: rescan below.
      }
    }
    await this.refresh();
    const subpath = this.toc.get(key);
    if (subpath === undefined) {
      throw new MaildirKeyError(`No message with key: ${key}`);
    }
    return subpath;
  }

  async keys(): Promise<string[]> {
    await this.refresh();
    return [...this.toc.keys()];
  }

  /** The size of a message file in bytes, or `null` when the key is unknown. */
  async size(key: string): Promise<number | null> {
    let subpath: string;
    try {
      subpath = await this.lookup(key);
    } catch (error) {
      if (error instanceof MaildirKeyError) {
        return null;
      }
      throw error;
    }
    return (await stat(path.join(this.root, subpath))).size;
  }

  /**
   * `Maildir.get_bytes()`: the stored bytes, or `null` when the key is
   * unknown. Python converts `os.linesep` to `\n` (a no-op on POSIX).
   */
  async getBytes(key: string): Promise<Buffer | null> {
    let subpath: string;
    try {
      subpath = await this.lookup(key);
    } catch (error) {
      if (error instanceof MaildirKeyError) {
        return null;
      }
      throw error;
    }
    const content = await readFile(path.join(this.root, subpath));
    return EOL === '\n'
      ? content
      : Buffer.from(content.toString('latin1').replaceAll(EOL, '\n'), 'latin1');
  }

  /** `key in maildir`. */
  async has(key: string): Promise<boolean> {
    await this.refresh();
    return this.toc.has(key);
  }

  /**
   * Move a message's file into the same subdirectory (`new`/`cur`) of
   * `destination`, keeping its name; `MaildirKeyError` for an unknown key.
   */
  async moveTo(key: string, destination: Maildir): Promise<void> {
    const subpath = await this.lookup(key);
    await rename(
      path.join(this.root, subpath),
      path.join(destination.root, subpath),
    );
    this.toc.delete(key);
    destination.toc.set(key, subpath);
  }

  /** `Maildir.remove()`: delete a message, or `MaildirKeyError`. */
  async remove(key: string): Promise<void> {
    await unlink(path.join(this.root, await this.lookup(key)));
  }

  /**
   * Mark a message read like mailsuite 2.3.3: rename its file into `cur/`
   * with the `S` (Seen) flag added to its info suffix, which is what the
   * Maildir spec defines a flag change to be; the content is untouched.
   */
  async markRead(key: string): Promise<void> {
    const subpath = await this.lookup(key);
    const name = path.basename(subpath);
    const info = name.includes(COLON) ? (name.split(COLON).at(-1) ?? '') : '';
    const newSubpath = path.join(
      'cur',
      `${key}${COLON}${addFlag(info, SEEN_FLAG)}`,
    );
    await rename(
      path.join(this.root, subpath),
      path.join(this.root, newSubpath),
    );
    this.toc.set(key, newSubpath);
  }
}

/**
 * Drop root to the Maildir's owner: its group as the only group, then its uid.
 *
 * Unlike mailsuite, which keeps root's groups and, if `setuid` fails, only
 * warns and goes on as root, any failure throws `PrivilegeDropError`, so the
 * process never keeps working as root (or half-dropped) by accident.
 */
function dropPrivileges(maildirPath: string, uid: number, gid: number): void {
  const { setuid, setgid, setgroups } = process;
  const fix =
    `Run tsdmarc as the Maildir's owner (uid ${uid}), or chown ${maildirPath} ` +
    'to the user tsdmarc runs as.';
  // Deno has no process.setgroups(): root's groups (gid 0) would be kept.
  if (setgroups === undefined || setgid === undefined || setuid === undefined) {
    throw new PrivilegeDropError(
      `Running as root over ${maildirPath} (owner uid ${uid}), but this ` +
        `runtime can't drop root's groups. ${fix}`,
    );
  }
  try {
    // Groups first: without root they can no longer be changed.
    setgroups([gid]);
    setgid(gid);
    setuid(uid);
  } catch (error) {
    throw new PrivilegeDropError(
      `Failed to switch to uid ${uid} and gid ${gid} to access Maildir ` +
        `${maildirPath}: ${errorMessage(error)}. ${fix}`,
      { cause: error },
    );
  }
}

/**
 * A `MailboxConnection` backed by an on-disk Maildir.
 *
 * Useful for local processing of messages dropped into a Maildir by an MTA
 * (e.g. postfix delivering DMARC reports). Maildir has no concept of
 * sending: `sendMessage()` throws `NotImplementedError`.
 *
 * The constructor does its filesystem checks synchronously, like
 * mailsuite's: uid checks (warn, don't crash, but throw `PrivilegeDropError`
 * if root can't drop to the Maildir's owner), the optional `cur`/`new`/`tmp`
 * creation, and opening the Maildir.
 */
export class MaildirConnection extends MailboxConnection {
  readonly kind = 'maildir' as const;
  private readonly maildirPath: string;
  private readonly maildirCreate: boolean;
  private readonly client: Maildir;
  private activeFolder: Maildir;
  private readonly subfolderClient = new Map<string, Maildir>();

  constructor(maildirPath: string, options: MaildirConnectionOptions = {}) {
    super();
    this.maildirPath = maildirPath;
    this.maildirCreate = options.maildirCreate ?? false;

    // When run as root over a user-owned Maildir, drop privileges to the
    // Maildir's owner so file creation works correctly. Only on systems
    // with getuid()/setuid() (not Windows).
    const { getuid, setuid } = process;
    if (getuid !== undefined && setuid !== undefined) {
      let maildirOwner: number | null = null;
      let maildirGroup = 0;
      try {
        ({ uid: maildirOwner, gid: maildirGroup } = statSync(maildirPath));
      } catch {
        maildirOwner = null;
      }
      const currentUid = getuid();
      if (maildirOwner !== null && currentUid !== maildirOwner) {
        if (currentUid === 0) {
          logger.warning(`Switching uid to ${maildirOwner} to access Maildir`);
          dropPrivileges(maildirPath, maildirOwner, maildirGroup);
        } else {
          logger.warning(
            `Runtime uid ${currentUid} differs from maildir ${maildirPath} owner ${maildirOwner}. ` +
              'Access may fail if permissions are insufficient.',
          );
        }
      }
    }

    if (this.maildirCreate) {
      for (const subdir of ['cur', 'new', 'tmp']) {
        mkdirSync(path.join(maildirPath, subdir), { recursive: true });
      }
    }
    this.client = Maildir.openSync(maildirPath, this.maildirCreate);
    this.activeFolder = this.client;
  }

  private async getFolder(folderName: string): Promise<Maildir> {
    let folder = this.subfolderClient.get(folderName);
    if (folder === undefined) {
      folder = await this.client.addFolder(folderName);
      this.subfolderClient.set(folderName, folder);
    }
    return folder;
  }

  private folderPath(folderName: string): string {
    return path.join(this.maildirPath, `.${folderName}`);
  }

  override async createFolder(folderName: string): Promise<void> {
    await this.getFolder(folderName);
  }

  override async renameFolder(oldName: string, newName: string): Promise<void> {
    // Maildir++ stores each folder as a sibling directory named ".<folder>",
    // so a rename moves the directory. Guard first: rename(2) would
    // otherwise silently replace an empty target.
    await this.ensureNoFolderConflict(newName);
    await rename(this.folderPath(oldName), this.folderPath(newName));
    this.subfolderClient.delete(oldName);
    this.subfolderClient.delete(newName);
  }

  override folderExists(folderName: string): Promise<boolean> {
    return isDirectory(this.folderPath(folderName));
  }

  override async deleteFolder(folderName: string): Promise<void> {
    // The folder must be empty of messages and subfolders; mergeFolders()
    // empties it first.
    await this.client.removeFolder(folderName);
    this.subfolderClient.delete(folderName);
  }

  protected override async doMoveFolder(
    source: string,
    _targetParent: string,
    targetPath: string,
  ): Promise<void> {
    await rename(this.folderPath(source), this.folderPath(targetPath));
    this.subfolderClient.delete(source);
    this.subfolderClient.delete(targetPath);
  }

  override async fetchMessages(
    reportsFolder: string,
    _options?: FetchMessagesOptions,
  ): Promise<MessageId[]> {
    this.activeFolder =
      reportsFolder && reportsFolder !== 'INBOX'
        ? await this.getFolder(reportsFolder)
        : this.client;
    return this.activeFolder.keys();
  }

  /**
   * The message's stored bytes decoded as UTF-8 (undecodable bytes
   * replaced), like mailsuite 2.3.3 and its IMAP backend's raw fetch, or
   * `""` for an unknown key. The file is not parsed or re-serialized, so a
   * message Python's `email` package can parse but not generate (a `\x1c`
   * in a nested header, deep multipart nesting) is returned as is.
   *
   * With `markRead` the file is renamed into `cur/` with the `S` flag (see
   * `Maildir.markRead`). With `maxSize`, a larger file throws
   * `EmailTooLargeError` without being read (not in mailsuite).
   */
  override async fetchMessage(
    messageId: MessageId,
    options: FetchMessageOptions = {},
  ): Promise<string> {
    const key = String(messageId);
    const maxSize = options.maxSize ?? 0;
    if (maxSize > 0) {
      const size = await this.activeFolder.size(key);
      if (size !== null && size > maxSize) {
        throw emailTooLargeError(size, maxSize);
      }
    }
    const content = await this.activeFolder.getBytes(key);
    if (content === null) {
      return '';
    }
    const text = utf8Decoder.decode(content);
    if (options.markRead) {
      await this.activeFolder.markRead(key);
    }
    return text;
  }

  override async deleteMessage(messageId: MessageId): Promise<void> {
    await this.activeFolder.remove(String(messageId));
  }

  /**
   * Move the message's file into the same subdirectory (`new`/`cur`) of
   * `folderName`, keeping its file name, flags and bytes, like mailsuite
   * 2.3.3 (it no longer re-serializes the message). Maildir++ folders live
   * under the same root, so this is a same-filesystem rename; a folder on
   * another mount fails with `EXDEV`. Throws {@link ExternalClashError}
   * rather than overwriting when the destination already holds a message
   * with the same key (including a move into the active folder itself).
   */
  override async moveMessage(
    messageId: MessageId,
    folderName: string,
  ): Promise<void> {
    const key = String(messageId);
    if (!(await this.activeFolder.has(key))) {
      return;
    }
    const destination = await this.getFolder(folderName);
    if (await destination.has(key)) {
      throw new ExternalClashError(
        `Folder ${folderName} already contains message ${key}`,
      );
    }
    await this.activeFolder.moveTo(key, destination);
  }

  override keepalive(): Promise<void> {
    return Promise.resolve();
  }

  override async watch(options: WatchOptions): Promise<void> {
    const { checkCallback, checkTimeout, configReloading, signal } = options;
    while (true) {
      if (signal?.aborted || configReloading?.()) {
        return;
      }
      try {
        await checkCallback(this);
      } catch (error) {
        logger.warning(`Maildir init error. ${errorMessage(error)}`);
      }
      if (configReloading?.()) {
        return;
      }
      try {
        await sleep(checkTimeout * MILLISECONDS_PER_SECOND, undefined, {
          signal,
        });
      } catch {
        // Aborted while sleeping.
        return;
      }
    }
  }

  override sendMessage(_options: SendMessageOptions): Promise<string | null> {
    return Promise.reject(
      new NotImplementedError(
        'Maildir cannot send mail; use sendEmail from @tsdmarc/smtp',
      ),
    );
  }
}
