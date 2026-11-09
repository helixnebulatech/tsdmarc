import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MboxReader } from './mbox';

const directories: string[] = [];

function writeMbox(content: Uint8Array | string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-mbox-'));
  directories.push(directory);
  const file = path.join(directory, 'test.mbox');
  writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MboxReader', () => {
  it('does not keep a long line in memory to index the file', async () => {
    const long = 'x'.repeat(300_000);
    const file = writeMbox(
      `From a\nS: 1\n\n${long}\nFr${long}\nFrom b\nS: 2\n`,
    );
    // Joining the chunks of a line took twice its size, before any limit.
    const concat = vi.spyOn(Buffer, 'concat');
    const mbox = await MboxReader.open(file);
    expect(concat).not.toHaveBeenCalled();
    concat.mockRestore();
    expect(mbox.length).toBe(2);
    expect(mbox.size(0)).toBe(13 + 2 * long.length + 4);
    expect(Buffer.from(await mbox.getBytes(1)).toString()).toBe('S: 2\n');
    await mbox.close();
  });

  it('recognizes a separator split by a read chunk', async () => {
    const line = 'x'.repeat(64 * 1024 - 8);
    const file = writeMbox(`From a\n${line}\nFrom b\nS: 2\n`);
    const mbox = await MboxReader.open(file);
    expect(mbox.length).toBe(2);
    await mbox.close();
  });

  it('splits messages across read chunks', async () => {
    // Lines longer than the 64 KiB read size, and a last line with no \n.
    const long = 'x'.repeat(200_000);
    const file = writeMbox(
      `From a\nSubject: 1\n\n${long}\n\nFrom b\nSubject: 2\n\n${long}`,
    );
    const reader = await MboxReader.open(file);
    try {
      expect(reader.keys()).toEqual([0, 1]);
      expect(Buffer.from(await reader.getBytes(0)).toString()).toBe(
        `Subject: 1\n\n${long}\n`,
      );
      expect(Buffer.from(await reader.getBytes(1)).toString()).toBe(
        `Subject: 2\n\n${long}`,
      );
    } finally {
      await reader.close();
    }
  });

  it('indexes a 40 MB line in linear time', async () => {
    // Python's mailbox.mbox takes ~0.2 s; the old reader took ~23 s.
    const body = Buffer.alloc(40 * 1024 * 1024, 0x61);
    const file = writeMbox(
      Buffer.concat([Buffer.from('From a\nSubject: big\n\n'), body]),
    );
    // CPU time, so a loaded machine doesn't make the bound flaky.
    const started = process.cpuUsage();
    const reader = await MboxReader.open(file);
    try {
      expect(reader.keys()).toEqual([0]);
    } finally {
      await reader.close();
    }
    const { user, system } = process.cpuUsage(started);
    expect((user + system) / 1000).toBeLessThan(3000);
  });
});
