import { describe, expect, it } from 'vitest';

import { PyValueError } from '../internal/py';
import {
  FolderExistsError,
  FolderNotFoundError,
  MailboxConnection,
  type MessageId,
  NotImplementedError,
} from './base';

class BareConnection extends MailboxConnection {
  readonly kind = 'maildir' as const;
}

/** In-memory backend that records folder moves, for the base-class logic. */
class MemoryConnection extends MailboxConnection {
  readonly kind = 'maildir' as const;
  readonly folders = new Map<string, MessageId[]>();
  readonly moves: [string, string, string][] = [];

  constructor(folders: Record<string, MessageId[]>) {
    super();
    for (const [name, messages] of Object.entries(folders)) {
      this.folders.set(name, [...messages]);
    }
  }

  override folderExists(name: string): Promise<boolean> {
    return Promise.resolve(this.folders.has(name));
  }

  override createFolder(name: string): Promise<void> {
    this.folders.set(name, []);
    return Promise.resolve();
  }

  override deleteFolder(name: string): Promise<void> {
    this.folders.delete(name);
    return Promise.resolve();
  }

  override fetchMessages(folder: string): Promise<MessageId[]> {
    return Promise.resolve([...(this.folders.get(folder) ?? [])]);
  }

  override moveMessage(
    messageId: MessageId,
    folderName: string,
  ): Promise<void> {
    for (const messages of this.folders.values()) {
      const index = messages.indexOf(messageId);
      if (index !== -1) {
        messages.splice(index, 1);
      }
    }
    this.folders.get(folderName)?.push(messageId);
    return Promise.resolve();
  }

  protected override doMoveFolder(
    source: string,
    targetParent: string,
    targetPath: string,
  ): Promise<void> {
    this.moves.push([source, targetParent, targetPath]);
    this.folders.set(targetPath, this.folders.get(source) ?? []);
    this.folders.delete(source);
    return Promise.resolve();
  }

  checkConflict(name: string): Promise<void> {
    return this.ensureNoFolderConflict(name);
  }
}

describe('MailboxConnection defaults', () => {
  const connection = new BareConnection();
  const calls: [string, () => Promise<unknown>][] = [
    ['createFolder', () => connection.createFolder('Reports')],
    ['renameFolder', () => connection.renameFolder('Reports', 'Archive')],
    ['folderExists', () => connection.folderExists('Reports')],
    ['fetchMessages', () => connection.fetchMessages('INBOX')],
    ['fetchMessage', () => connection.fetchMessage('id')],
    ['deleteMessage', () => connection.deleteMessage('id')],
    ['moveMessage', () => connection.moveMessage('id', 'Archive')],
    ['keepalive', () => connection.keepalive()],
    [
      'watch',
      () =>
        connection.watch({ checkCallback: () => undefined, checkTimeout: 30 }),
    ],
    [
      'sendMessage',
      () => connection.sendMessage({ messageFrom: 'a@example.com' }),
    ],
  ];

  for (const [name, call] of calls) {
    it(`${name} rejects with NotImplementedError`, async () => {
      await expect(call()).rejects.toBeInstanceOf(NotImplementedError);
    });
  }

  it('close is a no-op', async () => {
    await expect(connection.close()).resolves.toBeUndefined();
  });
});

describe('folder conflict guard', () => {
  it('throws when the folder exists and passes when absent', async () => {
    const connection = new MemoryConnection({ Archive: [] });
    await expect(connection.checkConflict('Archive')).rejects.toBeInstanceOf(
      FolderExistsError,
    );
    await expect(connection.checkConflict('Other')).resolves.toBeUndefined();
  });
});

describe('moveFolder', () => {
  it('requires exactly one of newPath or newParent', async () => {
    const connection = new MemoryConnection({ A: [] });
    // mailsuite raises ValueError.
    await expect(connection.moveFolder('A', {})).rejects.toBeInstanceOf(
      PyValueError,
    );
    await expect(
      connection.moveFolder('A', { newPath: 'B', newParent: 'C' }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: 'ValueError',
        message: 'provide exactly one of newPath or newParent',
      }),
    );
  });

  it('keeps the leaf name under a new parent, creating it when asked', async () => {
    const connection = new MemoryConnection({ 'Archive/Forensic': [1] });
    await expect(
      connection.moveFolder('Archive/Forensic', { newParent: 'Reports' }),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
    await connection.moveFolder('Archive/Forensic', {
      newParent: 'Reports',
      create: true,
    });
    expect(connection.moves).toEqual([
      ['Archive/Forensic', 'Reports', 'Reports/Forensic'],
    ]);
  });

  it('moves to a full new path and to the root', async () => {
    const connection = new MemoryConnection({
      'Archive/Forensic': [],
      Reports: [],
    });
    await connection.moveFolder('Archive/Forensic', {
      newPath: 'Reports/Failure',
    });
    await connection.moveFolder('Reports/Failure', { newParent: '' });
    expect(connection.moves).toEqual([
      ['Archive/Forensic', 'Reports', 'Reports/Failure'],
      ['Reports/Failure', '', 'Failure'],
    ]);
  });

  it('rejects missing sources and taken targets', async () => {
    const connection = new MemoryConnection({ A: [], B: [] });
    await expect(
      connection.moveFolder('Missing', { newPath: 'X' }),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
    await expect(
      connection.moveFolder('A', { newPath: 'B' }),
    ).rejects.toBeInstanceOf(FolderExistsError);
    expect(connection.moves).toEqual([]);
  });
});

describe('mergeFolders', () => {
  it('moves every message and deletes emptied sources unless kept', async () => {
    const connection = new MemoryConnection({ A: [1, 2], B: [3], Dest: [] });
    await connection.mergeFolders(['A', 'Dest'], 'Dest');
    await connection.mergeFolders('B', 'Dest', { keepSourceFolders: true });
    expect(connection.folders.get('Dest')).toEqual([1, 2, 3]);
    expect(connection.folders.has('A')).toBe(false);
    expect(connection.folders.get('B')).toEqual([]);
  });

  it('requires the destination unless create is set, and every source', async () => {
    const connection = new MemoryConnection({ A: [1] });
    await expect(connection.mergeFolders('A', 'Dest')).rejects.toBeInstanceOf(
      FolderNotFoundError,
    );
    await expect(
      connection.mergeFolders('Missing', 'Dest', { create: true }),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
    await connection.mergeFolders('A', 'Dest', { create: true });
    expect(connection.folders.get('Dest')).toEqual([1]);
  });
});

/** MemoryConnection that also records calls, like mailsuite's _FakeConn. */
class RecordingConnection extends MemoryConnection {
  readonly created: string[] = [];
  readonly deletedFolders: string[] = [];
  readonly movedMessages: [MessageId, string][] = [];

  override createFolder(name: string): Promise<void> {
    this.created.push(name);
    return super.createFolder(name);
  }

  override deleteFolder(name: string): Promise<void> {
    this.deletedFolders.push(name);
    return super.deleteFolder(name);
  }

  override moveMessage(
    messageId: MessageId,
    folderName: string,
  ): Promise<void> {
    this.movedMessages.push([messageId, folderName]);
    return super.moveMessage(messageId, folderName);
  }
}

describe('moveFolder and mergeFolders (mailsuite TestMoveFolder/TestMergeFolders)', () => {
  it('test_new_path_top_level_has_no_parent', async () => {
    const connection = new RecordingConnection({ 'A/X': [] });
    await connection.moveFolder('A/X', { newPath: 'Y' });
    expect(connection.moves).toEqual([['A/X', '', 'Y']]);
  });

  it('test_missing_parent_created_when_requested', async () => {
    const connection = new RecordingConnection({ 'A/X': [] });
    await connection.moveFolder('A/X', { newParent: 'B', create: true });
    expect(connection.created).toEqual(['B']);
    expect(connection.moves).toEqual([['A/X', 'B', 'B/X']]);
  });

  it('test_moves_then_deletes_sources', async () => {
    const connection = new RecordingConnection({
      Src: ['m1', 'm2'],
      Dest: [],
    });
    await connection.mergeFolders('Src', 'Dest');
    expect(connection.movedMessages).toEqual([
      ['m1', 'Dest'],
      ['m2', 'Dest'],
    ]);
    expect(connection.deletedFolders).toEqual(['Src']);
  });

  it('test_multiple_sources', async () => {
    const connection = new RecordingConnection({
      S1: ['a'],
      S2: ['b'],
      Dest: [],
    });
    await connection.mergeFolders(['S1', 'S2'], 'Dest');
    expect(connection.movedMessages).toEqual([
      ['a', 'Dest'],
      ['b', 'Dest'],
    ]);
    expect(connection.deletedFolders).toEqual(['S1', 'S2']);
  });

  it('test_merging_into_itself_is_a_no_op', async () => {
    const connection = new RecordingConnection({ Dest: ['m1'] });
    await connection.mergeFolders('Dest', 'Dest');
    expect(connection.movedMessages).toEqual([]);
    expect(connection.deletedFolders).toEqual([]);
    expect(connection.folders.get('Dest')).toEqual(['m1']);
  });
});
