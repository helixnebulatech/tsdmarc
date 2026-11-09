// Port of mailsuite tests/test_mailbox_maildir.py, on real temp directories.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogs, WARNING } from '../log';
import {
  FolderExistsError,
  FolderNotFoundError,
  MailboxConnection,
  NotImplementedError,
} from './base';
import {
  ExternalClashError,
  MaildirConnection,
  MaildirKeyError,
  NoSuchMailboxError,
  PrivilegeDropError,
  NotEmptyError,
} from './maildir';

const MESSAGE = 'From: a\r\nSubject: t\r\n\r\nbody\r\n';

let tmp: string;
let maildirPath: string;
let deliveries = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'tsdmarc-maildir-'));
  maildirPath = path.join(tmp, 'Maildir');
  mkdirSync(maildirPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Deliver a message the way Python's `mailbox.Maildir.add()` lays it out:
 * `<subdir>/<key>[:<info>]`. Returns the key.
 */
function deliver(
  folder: string,
  content: string | Buffer,
  { subdir = 'new', info = '2,S' }: { subdir?: string; info?: string } = {},
): string {
  deliveries += 1;
  const key = `1761300000.M${deliveries}P1Q${deliveries}.testhost`;
  const name = info ? `${key}:${info}` : key;
  writeFileSync(path.join(folder, subdir, name), content);
  return key;
}

function folderDir(name: string): string {
  return path.join(maildirPath, `.${name}`);
}

describe('MaildirConnection', () => {
  it('subclasses MailboxConnection', () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    expect(conn).toBeInstanceOf(MailboxConnection);
    expect(conn.kind).toBe('maildir');
  });

  it('creates with subdirs', () => {
    new MaildirConnection(maildirPath, { maildirCreate: true });
    for (const sub of ['cur', 'new', 'tmp']) {
      expect(statSync(path.join(maildirPath, sub)).isDirectory()).toBe(true);
    }
  });

  it('creates the Maildir itself when it does not exist', () => {
    const missing = path.join(tmp, 'Fresh');
    new MaildirConnection(missing, { maildirCreate: true });
    expect(readdirSync(missing).sort()).toEqual(['cur', 'new', 'tmp']);
  });

  it('throws NoSuchMailboxError for a missing Maildir without create', () => {
    expect(() => new MaildirConnection(path.join(tmp, 'Missing'))).toThrow(
      NoSuchMailboxError,
    );
  });

  it('creates folders as .Folder (Maildir++)', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    expect(statSync(folderDir('Reports')).isDirectory()).toBe(true);
    expect(readdirSync(folderDir('Reports')).sort()).toEqual([
      'cur',
      'maildirfolder',
      'new',
      'tmp',
    ]);
  });

  it('renames a folder and keeps its messages', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    const key = deliver(folderDir('Reports'), MESSAGE);

    await conn.renameFolder('Reports', 'Archive');

    expect(existsSync(folderDir('Reports'))).toBe(false);
    expect(statSync(folderDir('Archive')).isDirectory()).toBe(true);
    expect(await conn.fetchMessages('Archive')).toContain(key);
  });

  it('rejects renaming a missing folder with ENOENT (OSError)', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await expect(
      conn.renameFolder('DoesNotExist', 'Whatever'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a rename onto an existing folder and leaves both intact', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    await conn.createFolder('Archive');
    await expect(conn.renameFolder('Reports', 'Archive')).rejects.toThrow(
      FolderExistsError,
    );
    expect(await conn.folderExists('Reports')).toBe(true);
    expect(await conn.folderExists('Archive')).toBe(true);
  });

  it('reports whether a folder exists', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    expect(await conn.folderExists('Reports')).toBe(false);
    await conn.createFolder('Reports');
    expect(await conn.folderExists('Reports')).toBe(true);
  });

  it('deletes a folder', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    await conn.deleteFolder('Reports');
    expect(await conn.folderExists('Reports')).toBe(false);
    expect(existsSync(folderDir('Reports'))).toBe(false);
  });

  it('refuses to delete a folder that still holds messages', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    deliver(folderDir('Reports'), MESSAGE);
    await expect(conn.deleteFolder('Reports')).rejects.toThrow(
      new NotEmptyError('Folder contains message(s): Reports'),
    );
    expect(await conn.folderExists('Reports')).toBe(true);
  });

  it('refuses to delete a folder that has subfolders', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    mkdirSync(path.join(folderDir('Reports'), '.Child'));
    await expect(conn.deleteFolder('Reports')).rejects.toThrow(
      new NotEmptyError("Folder contains subdirectory 'Reports': .Child"),
    );
  });

  it('moves a folder to a new path', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Old');
    await conn.moveFolder('Old', { newPath: 'New' });
    expect(await conn.folderExists('Old')).toBe(false);
    expect(await conn.folderExists('New')).toBe(true);
  });

  it('moves a folder into a parent, creating it', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Forensic');
    await conn.moveFolder('Forensic', { newParent: 'Reports', create: true });
    expect(await conn.folderExists('Reports')).toBe(true);
    expect(await conn.folderExists('Reports/Forensic')).toBe(true);
    expect(await conn.folderExists('Forensic')).toBe(false);
  });

  it('rejects a move into a missing parent', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Forensic');
    await expect(
      conn.moveFolder('Forensic', { newPath: 'Reports/Forensic' }),
    ).rejects.toThrow(FolderNotFoundError);
  });

  it('merges folders, moving messages and deleting the source', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Forensic');
    await conn.createFolder('Failure');
    deliver(folderDir('Forensic'), MESSAGE);

    await conn.mergeFolders('Forensic', 'Failure');

    expect(await conn.folderExists('Forensic')).toBe(false);
    expect(await conn.fetchMessages('Failure')).toHaveLength(1);
  });

  it('merges folders keeping the source', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Forensic');
    await conn.createFolder('Failure');
    deliver(folderDir('Forensic'), MESSAGE);

    await conn.mergeFolders('Forensic', 'Failure', { keepSourceFolders: true });

    expect(await conn.folderExists('Forensic')).toBe(true);
    expect(await conn.fetchMessages('Failure')).toHaveLength(1);
  });

  it('fetches INBOX messages for "INBOX" and ""', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const key = deliver(maildirPath, MESSAGE);
    expect(await conn.fetchMessages('INBOX')).toContain(key);
    expect(await conn.fetchMessages('')).toContain(key);
  });

  it('lists messages in both new/ and cur/, skipping dot files', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const fresh = deliver(maildirPath, MESSAGE, { info: '' });
    const seen = deliver(maildirPath, MESSAGE, { subdir: 'cur' });
    writeFileSync(path.join(maildirPath, 'cur', '.hidden'), 'x');
    expect((await conn.fetchMessages('INBOX')).sort()).toEqual(
      [fresh, seen].sort(),
    );
  });

  it('fetches messages of a subfolder', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    const key = deliver(folderDir('Reports'), MESSAGE);
    expect(await conn.fetchMessages('Reports')).toContain(key);
  });

  it('fetches a message', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    const key = deliver(
      folderDir('Reports'),
      'From: a\r\nSubject: hi\r\n\r\nbody\r\n',
    );
    await conn.fetchMessages('Reports'); // selects the active folder
    const raw = await conn.fetchMessage(key);
    expect(raw).toContain('Subject: hi');
    expect(raw).toContain('body');
    // The stored bytes, as is (mailsuite 2.3.3 no longer re-serializes).
    expect(raw).toBe('From: a\r\nSubject: hi\r\n\r\nbody\r\n');
  });

  // Expected values are Python's `get_bytes(key).decode("utf-8", "replace")`.
  it('decodes the stored bytes as UTF-8, replacing invalid bytes', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const latin1 = deliver(
      maildirPath,
      Buffer.from(
        'From: Jos\xe9 <a@b>\nSubject: t\nContent-Type: text/plain; charset="iso-8859-1"\n\ncaf\xe9\n',
        'latin1',
      ),
    );
    const utf8 = deliver(
      maildirPath,
      Buffer.from('\uFEFFFrom: a\nSubject: naïve €\n\nbody\n'),
    );
    await conn.fetchMessages('INBOX');
    expect(await conn.fetchMessage(latin1)).toBe(
      'From: Jos\uFFFD <a@b>\nSubject: t\nContent-Type: text/plain; charset="iso-8859-1"\n\ncaf\uFFFD\n',
    );
    // A byte order mark is kept, like bytes.decode("utf-8").
    expect(await conn.fetchMessage(utf8)).toBe(
      '\uFEFFFrom: a\nSubject: naïve €\n\nbody\n',
    );
  });

  it('returns "" for a missing message', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.fetchMessages('INBOX');
    expect(await conn.fetchMessage('does-not-exist')).toBe('');
  });

  it('marks a fetched message read: cur/ with the S flag, same key', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Reports');
    // The message starts in new/ with no info.
    const key = deliver(folderDir('Reports'), MESSAGE, { info: '' });
    await conn.fetchMessages('Reports');
    await conn.fetchMessage(key, { markRead: true });

    expect(readdirSync(path.join(folderDir('Reports'), 'new'))).toEqual([]);
    expect(readdirSync(path.join(folderDir('Reports'), 'cur'))).toEqual([
      `${key}:2,S`,
    ]);
    expect(await conn.fetchMessages('Reports')).toEqual([key]);
  });

  it('merges the S flag into existing flags, sorted', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const key = deliver(maildirPath, MESSAGE, { subdir: 'cur', info: '2,RF' });
    await conn.fetchMessages('INBOX');
    await conn.fetchMessage(key, { markRead: true });
    expect(readdirSync(path.join(maildirPath, 'cur'))).toEqual([
      `${key}:2,FRS`,
    ]);
  });

  it('does not mark read without markRead', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const key = deliver(maildirPath, MESSAGE, { info: '' });
    await conn.fetchMessages('INBOX');
    await conn.fetchMessage(key);
    expect(readdirSync(path.join(maildirPath, 'new'))).toEqual([key]);
  });

  it('deletes a message', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const key = deliver(maildirPath, MESSAGE);
    await conn.fetchMessages('INBOX');
    await conn.deleteMessage(key);
    expect(await conn.fetchMessages('INBOX')).not.toContain(key);
  });

  it('rejects deleting a missing message with KeyError', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.fetchMessages('INBOX');
    await expect(conn.deleteMessage('missing')).rejects.toThrow(
      new MaildirKeyError('No message with key: missing'),
    );
  });

  it('moves a message, keeping its key, content, subdir, flags and mtime', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Archive');
    const key = deliver(maildirPath, MESSAGE);
    const mtime = new Date('2026-01-02T03:04:05Z');
    utimesSync(path.join(maildirPath, 'new', `${key}:2,S`), mtime, mtime);
    await conn.fetchMessages('INBOX');

    await conn.moveMessage(key, 'Archive');

    expect(await conn.fetchMessages('INBOX')).not.toContain(key);
    // The file is renamed, so the key stays the same.
    expect(await conn.fetchMessages('Archive')).toEqual([key]);
    expect(readdirSync(path.join(folderDir('Archive'), 'new'))).toEqual([
      `${key}:2,S`,
    ]);
    const moved = path.join(folderDir('Archive'), 'new', `${key}:2,S`);
    expect(statSync(moved).mtime.getTime()).toBe(mtime.getTime());
    expect(await conn.fetchMessage(key)).toBe(MESSAGE);
    expect(readdirSync(path.join(folderDir('Archive'), 'tmp'))).toEqual([]);
  });

  it('moving a missing message is a no-op', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await conn.createFolder('Archive');
    await conn.fetchMessages('INBOX');
    await expect(conn.moveMessage('missing', 'Archive')).resolves.toBe(
      undefined,
    );
    expect(await conn.fetchMessages('Archive')).toEqual([]);
  });

  it('keepalive is a no-op', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await expect(conn.keepalive()).resolves.toBe(undefined);
  });

  it('sendMessage throws NotImplementedError', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    await expect(
      conn.sendMessage({
        messageFrom: 'a@example.com',
        messageTo: ['b@example.org'],
      }),
    ).rejects.toThrow(NotImplementedError);
    await expect(
      conn.sendMessage({ messageFrom: 'a@example.com' }),
    ).rejects.toThrow(/Maildir/u);
  });

  it('watch exits on config reload without calling the callback', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    let calls = 0;
    await conn.watch({
      checkCallback: () => {
        calls += 1;
      },
      checkTimeout: 1,
      configReloading: () => true,
    });
    expect(calls).toBe(0);
  });

  it('watch calls the callback', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    let calls = 0;
    let reload = false;
    await conn.watch({
      checkCallback: connection => {
        expect(connection).toBe(conn);
        calls += 1;
      },
      checkTimeout: 0,
      configReloading: () => {
        // First check returns false so the callback runs; after the
        // callback flip and exit.
        if (calls >= 1) {
          reload = true;
        }
        return reload;
      },
    });
    expect(calls).toBe(1);
  });

  it('watch logs a callback error and keeps going', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const capture = captureLogs();
    try {
      let first = true;
      await conn.watch({
        checkCallback: () => {
          throw new Error('boom');
        },
        checkTimeout: 0,
        configReloading: () => {
          if (first) {
            first = false;
            return false;
          }
          return true;
        },
      });
      expect(capture.output).toEqual([
        'WARNING:tsdmarc:Maildir init error. boom',
      ]);
    } finally {
      capture.restore();
    }
  });

  it('watch stops when its signal is aborted', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    const controller = new AbortController();
    let calls = 0;
    await conn.watch({
      checkCallback: () => {
        calls += 1;
        controller.abort();
      },
      checkTimeout: 3600,
      signal: controller.signal,
    });
    expect(calls).toBe(1);
  });
});

function mockGroupCalls() {
  return {
    setgroups: vi.spyOn(process, 'setgroups').mockReturnValue(undefined),
    setgid: vi.spyOn(process, 'setgid').mockReturnValue(undefined),
  };
}

// Maildir on Linux/Docker often runs with a non-root user that doesn't own
// the maildir directory. It must warn, not crash, so the operator can fix
// permissions. Root that can't drop to the owner throws instead.
describe.skipIf(process.getuid === undefined)('uid mismatch', () => {
  it('warns when a non-root runtime uid differs from the owner', () => {
    const owner = statSync(maildirPath).uid;
    vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    const capture = captureLogs(undefined, WARNING);
    try {
      new MaildirConnection(maildirPath);
      expect(capture.output).toEqual([
        `WARNING:tsdmarc:Runtime uid ${owner + 1} differs from maildir ${maildirPath} owner ${owner}. Access may fail if permissions are insufficient.`,
      ]);
    } finally {
      capture.restore();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'switches uid to the owner when running as root',
    () => {
      const owner = statSync(maildirPath).uid;
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      const setuid = vi.spyOn(process, 'setuid').mockReturnValue(undefined);
      const { setgroups, setgid } = mockGroupCalls();
      const capture = captureLogs(undefined, WARNING);
      try {
        new MaildirConnection(maildirPath);
        expect(setuid).toHaveBeenCalledExactlyOnceWith(owner);
        expect(capture.output).toEqual([
          `WARNING:tsdmarc:Switching uid to ${owner} to access Maildir`,
        ]);
        // Root can't change its groups once the uid is gone.
        const { gid } = statSync(maildirPath);
        expect(setgroups).toHaveBeenCalledExactlyOnceWith([gid]);
        expect(setgid).toHaveBeenCalledExactlyOnceWith(gid);
        const [setgroupsOrder] = setgroups.mock.invocationCallOrder;
        const [setgidOrder] = setgid.mock.invocationCallOrder;
        const [setuidOrder] = setuid.mock.invocationCallOrder;
        expect(setgroupsOrder).toBeLessThan(setgidOrder as number);
        expect(setgidOrder).toBeLessThan(setuidOrder as number);
      } finally {
        capture.restore();
      }
    },
  );

  // mailsuite warns and goes on as root (or with root's groups); a failed
  // drop must stop instead, before the Maildir is touched.
  it.skipIf(process.getuid?.() === 0)(
    'throws PrivilegeDropError, keeping root, when the groups cannot be changed',
    () => {
      const { uid: owner, gid } = statSync(maildirPath);
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      const setuid = vi.spyOn(process, 'setuid').mockReturnValue(undefined);
      mockGroupCalls().setgroups.mockImplementation(() => {
        throw new Error('EPERM, Operation not permitted');
      });
      expect(() => new MaildirConnection(maildirPath)).toThrow(
        new PrivilegeDropError(
          `Failed to switch to uid ${owner} and gid ${gid} to access Maildir ${maildirPath}: ` +
            `EPERM, Operation not permitted. Run tsdmarc as the Maildir's owner (uid ${owner}), ` +
            `or chown ${maildirPath} to the user tsdmarc runs as.`,
        ),
      );
      expect(setuid).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'throws PrivilegeDropError when setuid fails',
    () => {
      const { uid: owner, gid } = statSync(maildirPath);
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      const cause = new Error('EINVAL, Invalid argument');
      vi.spyOn(process, 'setuid').mockImplementation(() => {
        throw cause;
      });
      mockGroupCalls();
      const capture = captureLogs(undefined, WARNING);
      try {
        let thrown: unknown;
        try {
          new MaildirConnection(maildirPath);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(PrivilegeDropError);
        expect((thrown as PrivilegeDropError).message).toBe(
          `Failed to switch to uid ${owner} and gid ${gid} to access Maildir ${maildirPath}: ` +
            `EINVAL, Invalid argument. Run tsdmarc as the Maildir's owner (uid ${owner}), ` +
            `or chown ${maildirPath} to the user tsdmarc runs as.`,
        );
        expect((thrown as PrivilegeDropError).cause).toBe(cause);
        expect(capture.output).toEqual([
          `WARNING:tsdmarc:Switching uid to ${owner} to access Maildir`,
        ]);
      } finally {
        capture.restore();
      }
    },
  );

  // Deno's node:process has setuid() and setgid() but no setgroups().
  it.skipIf(process.getuid?.() === 0)(
    'throws PrivilegeDropError when the runtime has no setgroups()',
    () => {
      const owner = statSync(maildirPath).uid;
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      const setuid = vi.spyOn(process, 'setuid').mockReturnValue(undefined);
      const setgid = vi.spyOn(process, 'setgid').mockReturnValue(undefined);
      vi.stubGlobal('process', { ...process, setgroups: undefined });
      try {
        expect(() => new MaildirConnection(maildirPath)).toThrow(
          new PrivilegeDropError(
            `Running as root over ${maildirPath} (owner uid ${owner}), but this runtime ` +
              `can't drop root's groups. Run tsdmarc as the Maildir's owner (uid ${owner}), ` +
              `or chown ${maildirPath} to the user tsdmarc runs as.`,
          ),
        );
        expect(setgid).not.toHaveBeenCalled();
        expect(setuid).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('neither warns nor switches uid when the owner matches', () => {
    const owner = statSync(maildirPath).uid;
    vi.spyOn(process, 'getuid').mockReturnValue(owner);
    const setuid = vi.spyOn(process, 'setuid');
    const capture = captureLogs(undefined, WARNING);
    try {
      new MaildirConnection(maildirPath);
      expect(capture.output).toEqual([]);
      expect(setuid).not.toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });
});

// Port of mailsuite 2.3.3 TestMaildirPoisonMessages: messages Python's
// `email` package can parse but not re-serialize (parsedmarc
// GHSA-qxwv-2vwj-v828) are fetched, marked read, moved and deleted as the
// stored files, never round-tripped through a message object.
describe('TestMaildirPoisonMessages', () => {
  // A failure report whose message/rfc822 part carries `X-A: a\x1cb`.
  const HEADER_INJECTION = Buffer.from(
    'From: reporter@example.com\n' +
      'Subject: failure report\n' +
      'MIME-Version: 1.0\n' +
      'Content-Type: multipart/report; report-type=feedback-report; boundary=B\n' +
      '\n--B\nContent-Type: text/plain\n\nhi\n' +
      '--B\nContent-Type: message/rfc822\n\n' +
      'X-A: a\u001Cb\nSubject: x\n\nbody\n--B--\n',
  );

  function deeplyNested(depth = 400): Buffer {
    let data =
      'From: reporter@example.com\nSubject: nested\nMIME-Version: 1.0\n';
    for (let index = 0; index < depth; index += 1) {
      data += `Content-Type: multipart/mixed; boundary=b${index}\n\n--b${index}\n`;
    }
    data += 'Content-Type: text/plain\n\nx\n';
    for (let index = depth - 1; index >= 0; index -= 1) {
      data += `--b${index}--\n`;
    }
    return Buffer.from(data);
  }

  const POISON1 = '1700000000.poison1.host';
  const POISON2 = '1700000000.poison2.host';

  /** The two poison messages written straight into new/, as an MTA would. */
  function poisonMaildir(): Map<string, Buffer> {
    new MaildirConnection(maildirPath, { maildirCreate: true });
    const messages = new Map([
      [POISON1, HEADER_INJECTION],
      [POISON2, deeplyNested()],
    ]);
    for (const [key, data] of messages) {
      writeFileSync(path.join(maildirPath, 'new', key), data);
    }
    return messages;
  }

  const decoded = (data: Buffer): string => new TextDecoder().decode(data);

  it('test_fetch_message_returns_raw_text', async () => {
    const messages = poisonMaildir();
    const conn = new MaildirConnection(maildirPath);
    expect((await conn.fetchMessages('INBOX')).toSorted()).toEqual(
      [...messages.keys()].toSorted(),
    );
    for (const [key, data] of messages) {
      expect(await conn.fetchMessage(key)).toBe(decoded(data));
      // Not marked read: still in new/ with no info suffix.
      expect(readdirSync(path.join(maildirPath, 'new'))).toContain(key);
    }
  });

  it('test_fetch_message_mark_read_renames_into_cur', async () => {
    const messages = poisonMaildir();
    const conn = new MaildirConnection(maildirPath);
    await conn.fetchMessages('INBOX');
    for (const [key, data] of messages) {
      expect(await conn.fetchMessage(key, { markRead: true })).toBe(
        decoded(data),
      );
      expect(existsSync(path.join(maildirPath, 'new', key))).toBe(false);
      expect(
        readFileSync(path.join(maildirPath, 'cur', `${key}:2,S`)).equals(data),
      ).toBe(true);
    }
    expect((await conn.fetchMessages('INBOX')).toSorted()).toEqual(
      [...messages.keys()].toSorted(),
    );
    for (const [key, data] of messages) {
      expect(await conn.fetchMessage(key)).toBe(decoded(data));
    }
  });

  it('test_mark_read_keeps_existing_flags', async () => {
    const conn = new MaildirConnection(maildirPath, { maildirCreate: true });
    writeFileSync(path.join(maildirPath, 'cur', 'k1:2,F'), deeplyNested());
    await conn.fetchMessages('INBOX');
    await conn.fetchMessage('k1', { markRead: true });
    expect(readdirSync(path.join(maildirPath, 'cur'))).toEqual(['k1:2,FS']);
  });

  it('test_move_message_relocates_file', async () => {
    const messages = poisonMaildir();
    const conn = new MaildirConnection(maildirPath);
    await conn.createFolder('Invalid');
    await conn.fetchMessages('INBOX');
    await conn.fetchMessage(POISON1, { markRead: true });
    for (const key of messages.keys()) {
      await conn.moveMessage(key, 'Invalid');
    }
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(readdirSync(path.join(maildirPath, 'new'))).toEqual([]);
    expect(readdirSync(path.join(maildirPath, 'cur'))).toEqual([]);
    // Subdirectory and flags travel with the file; content is identical.
    const dest = folderDir('Invalid');
    expect(readdirSync(path.join(dest, 'cur'))).toEqual([`${POISON1}:2,S`]);
    expect(readdirSync(path.join(dest, 'new'))).toEqual([POISON2]);
    expect((await conn.fetchMessages('Invalid')).toSorted()).toEqual(
      [...messages.keys()].toSorted(),
    );
    for (const [key, data] of messages) {
      expect(await conn.fetchMessage(key)).toBe(decoded(data));
      await conn.deleteMessage(key);
    }
    expect(await conn.fetchMessages('Invalid')).toEqual([]);
    expect(readdirSync(path.join(dest, 'new'))).toEqual([]);
    expect(readdirSync(path.join(dest, 'cur'))).toEqual([]);
  });

  it('test_move_message_refuses_to_overwrite', async () => {
    const messages = poisonMaildir();
    const conn = new MaildirConnection(maildirPath);
    await conn.createFolder('Invalid');
    const clash = path.join(folderDir('Invalid'), 'cur', `${POISON2}:2,S`);
    writeFileSync(clash, 'Subject: other\n\nother\n');
    await conn.fetchMessages('INBOX');
    await expect(conn.moveMessage(POISON2, 'Invalid')).rejects.toThrow(
      new ExternalClashError(
        `Folder Invalid already contains message ${POISON2}`,
      ),
    );
    expect(readFileSync(clash, 'utf8')).toBe('Subject: other\n\nother\n');
    expect(
      readFileSync(path.join(maildirPath, 'new', POISON2)).equals(
        messages.get(POISON2) as Buffer,
      ),
    ).toBe(true);
  });

  it('refuses to move a message into the active folder itself', async () => {
    poisonMaildir();
    const conn = new MaildirConnection(maildirPath);
    await conn.createFolder('Reports');
    writeFileSync(
      path.join(folderDir('Reports'), 'new', 'k1'),
      'Subject: s\n\nx\n',
    );
    await conn.fetchMessages('Reports');
    await expect(conn.moveMessage('k1', 'Reports')).rejects.toThrow(
      ExternalClashError,
    );
    expect(readdirSync(path.join(folderDir('Reports'), 'new'))).toEqual(['k1']);
  });

  it('test_rename_keeps_toc_current: fetch, move and delete after mark-read', async () => {
    const messages = poisonMaildir();
    const conn = new MaildirConnection(maildirPath);
    await conn.createFolder('Invalid');
    await conn.fetchMessages('INBOX');
    await conn.fetchMessage(POISON2, { markRead: true });
    const expected = decoded(messages.get(POISON2) as Buffer);
    expect(await conn.fetchMessage(POISON2)).toBe(expected);

    await conn.moveMessage(POISON2, 'Invalid');
    expect(await conn.fetchMessages('INBOX')).not.toContain(POISON2);
    expect(await conn.fetchMessages('Invalid')).toEqual([POISON2]);
    expect(await conn.fetchMessage(POISON2)).toBe(expected);
    await conn.deleteMessage(POISON2);
    expect(readdirSync(path.join(folderDir('Invalid'), 'cur'))).toEqual([]);
  });

  it('test_mark_read_then_delete', async () => {
    poisonMaildir();
    const conn = new MaildirConnection(maildirPath);
    await conn.fetchMessages('INBOX');
    await conn.fetchMessage(POISON1, { markRead: true });
    await conn.deleteMessage(POISON1);
    expect(readdirSync(path.join(maildirPath, 'cur'))).toEqual([]);
  });
});
