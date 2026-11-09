// Ported from parsedmarc tests/test_utils.py (Test: base64, filename-safe
// strings, email addresses, mbox and MSG checks; TestUtilsParseEmail;
// TestUtilsOutlookMsg; TestIsMbox) and from mailsuite tests/test_utils.py
// (TestDecodeBase64, TestGetFilenameSafeString, TestParseEmailAddress,
// TestIsOutlookMsg, TestParseEmail) where they apply to parsedmarc's
// versions of these functions.

import type * as ChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailParserError, EmailTooLargeError } from '../errors';
import { captureLogs, type LogCapture } from '../log';
import { toSnakeCaseKeys } from '../serialize';

const spawnMock = vi.hoisted(() => ({
  /** A fake child for the next spawn; `null` runs the real command. */
  fake: null as (() => EventEmitter & { kill: () => boolean }) | null,
  calls: [] as unknown[][],
}));

// Mock only the subprocess boundary: `msgconvert` is an external Perl tool.
// Most tests run a fake `msgconvert` script from PATH through the real
// spawn; the timeout test swaps in a child that never exits.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnMock.calls.push(args);
      return spawnMock.fake === null ? actual.spawn(...args) : spawnMock.fake();
    },
  };
});

const {
  convertOutlookMsg,
  decodeBase64,
  getFilenameSafeString,
  isMbox,
  isOutlookMsg,
  MSGCONVERT_TIMEOUT_MS,
  parseEmail,
  parseEmailAddress,
  ValueError,
} = await import('./email');

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const MSG_MAGIC = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const encoder = new TextEncoder();

function msgBytes(padding = 100): Uint8Array {
  const bytes = new Uint8Array(MSG_MAGIC.length + padding);
  bytes.set(MSG_MAGIC, 0);
  return bytes;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let savedPath: string | undefined;
let binDir = '';

/** Put a fake `msgconvert` shell script first on PATH. */
function fakeMsgconvert(script: string): void {
  binDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-bin-'));
  const file = path.join(binDir, 'msgconvert');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
}

afterEach(() => {
  spawnMock.fake = null;
  spawnMock.calls.length = 0;
  if (binDir !== '') {
    process.env.PATH = savedPath;
    rmSync(binDir, { recursive: true, force: true });
    binDir = '';
  }
});

describe('Test (parsedmarc kitchen-sink tests)', () => {
  it('testBase64Decoding', () => {
    // Example from Wikipedia Base64 article
    expect(
      new TextDecoder().decode(decodeBase64('YW55IGNhcm5hbCBwbGVhcw')),
    ).toBe('any carnal pleas');
  });

  it('testParseEmailAddressWithDisplayName', () => {
    const result = parseEmailAddress(['John Doe', 'john@example.com']);
    expect(result.displayName).toBe('John Doe');
    expect(result.address).toBe('john@example.com');
    expect(result.local).toBe('john');
    expect(result.domain).toBe('example.com');
  });

  it('testParseEmailAddressWithoutDisplayName', () => {
    const result = parseEmailAddress(['', 'john@example.com']);
    expect(result.displayName).toBeNull();
    expect(result.address).toBe('john@example.com');
  });

  it('testParseEmailAddressNoAt', () => {
    const result = parseEmailAddress(['', 'localonly']);
    expect(result.local).toBeNull();
    expect(result.domain).toBeNull();
  });

  it('testGetFilenameSafeString', () => {
    const result = getFilenameSafeString('file/name:with"bad*chars');
    for (const char of ['/', ':', '"', '*']) {
      expect(result).not.toContain(char);
    }
  });

  it('testGetFilenameSafeStringNone', () => {
    expect(getFilenameSafeString(null)).toBe('None');
  });

  it('testGetFilenameSafeStringTraversalSequencesCollapseToEmpty', () => {
    for (const traversal of [
      '../../../',
      '/',
      '..',
      '.',
      '..\\..\\',
      './../',
    ]) {
      expect(getFilenameSafeString(traversal)).toBe('');
    }
  });

  it('testGetFilenameSafeStringStripsNullByte', () => {
    expect(getFilenameSafeString('re\u0000port')).toBe('report');
  });

  it('testGetFilenameSafeStringHasNoPathSeparators', () => {
    const result = getFilenameSafeString('a/b\\c:d..\\..\\e/../f');
    expect(result).toBe('abcd....e..f');
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
  });

  it('testGetFilenameSafeStringTruncatedNameHasNoTrailingDot', () => {
    const result = getFilenameSafeString(`${'a'.repeat(99)}.${'b'.repeat(50)}`);
    expect(result).toBe('a'.repeat(99));
    expect(result.endsWith('.')).toBe(false);
  });

  it('testGetFilenameSafeStringStripsTrailingSpaces', () => {
    expect(getFilenameSafeString('report ')).toBe('report');
    expect(getFilenameSafeString('report . .')).toBe('report');
  });

  it('testGetFilenameSafeStringLong', () => {
    expect(getFilenameSafeString('a'.repeat(200))).toHaveLength(100);
  });

  it('testGetFilenameSafeStringBoundsUtf8Bytes', () => {
    // GHSA-j53g-34vj-g25q: 84 CJK characters or 63 emoji plus ".eml" were
    // 256 bytes, over the filesystem's 255-byte name limit.
    const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-name-'));
    try {
      for (const [subject, expected] of [
        // 33 whole characters (99 bytes); the 34th would straddle byte 100.
        ['\u4E2D'.repeat(84), '\u4E2D'.repeat(33)],
        // Exactly 25 four-byte characters fit in 100 bytes.
        ['\u{1F600}'.repeat(63), '\u{1F600}'.repeat(25)],
      ] as const) {
        const result = getFilenameSafeString(subject);
        expect(result).toBe(expected);
        const encoded = Buffer.from(result, 'utf8');
        expect(encoded.length).toBeLessThanOrEqual(100);
        // A strict round trip proves no partial character survived.
        expect(new TextDecoder('utf-8', { fatal: true }).decode(encoded)).toBe(
          result,
        );
        const file = path.join(directory, `${result}.eml`);
        writeFileSync(file, 'sample');
        expect(statSync(file).isFile()).toBe(true);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('testGetFilenameSafeStringByteCutAfterDotIsStripped', () => {
    // 33 CJK characters (99 bytes) and a dot fill exactly 100 bytes.
    const subject = `${'\u4E2D'.repeat(33)}.${'\u4E2D'.repeat(10)}`;
    expect(getFilenameSafeString(subject)).toBe('\u4E2D'.repeat(33));
  });

  it('testGetFilenameSafeStringDropsLoneSurrogates', () => {
    expect(getFilenameSafeString('re\uD800port')).toBe('report');
  });

  it('testGetFilenameSafeStringTrailingDot', () => {
    expect(getFilenameSafeString('filename...').endsWith('.')).toBe(false);
  });

  it('testIsMboxNonMbox', async () => {
    expect(await isMbox(path.join(ROOT, 'samples', 'empty.xml'))).toBe(false);
  });

  it('testIsOutlookMsgNonMsg', () => {
    expect(isOutlookMsg(encoder.encode('not an outlook msg'))).toBe(false);
    expect(isOutlookMsg('string content')).toBe(false);
  });

  it('testIsOutlookMsgMagic', () => {
    expect(isOutlookMsg(msgBytes())).toBe(true);
  });
});

describe('TestUtilsParseEmail', () => {
  it('testMinimalEmail', async () => {
    const result = await parseEmail(
      'From: test@example.com\nSubject: Test\n\nBody text',
    );
    expect(result.subject).toBe('Test');
    expect(result.replyTo).toEqual([]);
  });

  it('testReplyToHeaderIsParsed', async () => {
    const result = await parseEmail(
      'From: Sender <sender@example.com>\r\n' +
        'Reply-To: Real One <real@phish.example>, Second <two@phish.example>\r\n' +
        'To: victim@example.org\r\n' +
        'Subject: Hi\r\n\r\nBody\r\n',
    );
    expect(result.replyTo.map(address => address.address)).toEqual([
      'real@phish.example',
      'two@phish.example',
    ]);
    expect(result.replyTo[0]?.displayName).toBe('Real One');
  });

  it('testDeliveredToHeaderIsParsed', async () => {
    const result = await parseEmail(
      'From: Sender <sender@example.com>\r\n' +
        'Delivered-To: box@example.org\r\n' +
        'To: box@example.org\r\n' +
        'Subject: Hi\r\n\r\nBody\r\n',
    );
    expect(result.deliveredTo?.map(address => address.address)).toEqual([
      'box@example.org',
    ]);
  });

  it('testEmailWithNoSubject', async () => {
    const result = await parseEmail(
      'From: test@example.com\nTo: other@example.com\n\nBody',
    );
    expect(result.subject).toBeNull();
  });

  it('testEmailBytesInput', async () => {
    const result = await parseEmail(
      encoder.encode(
        'From: test@example.com\nSubject: Bytes Test\nTo: other@example.com\n\nBody',
      ),
    );
    expect(result.subject).toBe('Bytes Test');
  });

  it('testEmailWithAttachments', async () => {
    // MIMEMultipart(...).as_string() of the upstream test, with a fixed boundary.
    const message =
      'Content-Type: multipart/mixed; boundary="===============0123456789=="\nMIME-Version: 1.0\n' +
      'From: test@example.com\nTo: other@example.com\nSubject: Attachment Test\n\n' +
      '--===============0123456789==\nContent-Type: text/plain; charset="us-ascii"\n' +
      'MIME-Version: 1.0\nContent-Transfer-Encoding: 7bit\n\nBody text\n' +
      '--===============0123456789==\nContent-Type: application/octet-stream\n' +
      'MIME-Version: 1.0\nContent-Transfer-Encoding: base64\n' +
      'Content-Disposition: attachment; filename="test.bin"\n\nZmlsZSBjb250ZW50IGhlcmU=\n\n' +
      '--===============0123456789==--\n';
    const result = await parseEmail(message, { stripAttachmentPayloads: true });
    expect(result.attachments).toHaveLength(1);
    for (const attachment of result.attachments) {
      expect(attachment).not.toHaveProperty('payload');
      expect(attachment.sha256).toBe(sha256('file content here'));
    }
  });

  it('testEmptyFromHeaderYieldsNone', async () => {
    const result = await parseEmail(
      'From:\r\nTo: a@b.com\r\nSubject: t\r\n\r\nbody\r\n',
    );
    expect(result.from).toBeNull();
  });

  it('testCcAndBccHeadersAreParsed', async () => {
    const result = await parseEmail(
      'From: a@b.com\r\nTo: t@e.com\r\nCc: c@d.com, C Two <c2@d.com>\r\n' +
        'Bcc: e@f.com\r\nSubject: Hi\r\n\r\nBody\r\n',
    );
    expect(result.cc.map(address => address.address)).toEqual([
      'c@d.com',
      'c2@d.com',
    ]);
    expect(result.cc[1]?.displayName).toBe('C Two');
    expect(result.bcc.map(address => address.address)).toEqual(['e@f.com']);
  });

  const multipartEmail = (transferEncoding: string, payload: string): string =>
    'From: a@b.com\r\nTo: t@e.com\r\nSubject: att\r\nMIME-Version: 1.0\r\n' +
    'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
    '--B\r\nContent-Type: text/plain\r\n\r\nbody\r\n' +
    '--B\r\nContent-Type: application/octet-stream; name="a.bin"\r\n' +
    `Content-Transfer-Encoding: ${transferEncoding}\r\n` +
    'Content-Disposition: attachment; filename="a.bin"\r\n\r\n' +
    `${payload}\r\n--B--\r\n`;

  it('testNonBase64AttachmentIsHashed', async () => {
    const result = await parseEmail(multipartEmail('7bit', 'hello world'));
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.sha256).toBe(sha256('hello world'));
  });

  describe('with captured logs', () => {
    let capture: LogCapture;
    beforeEach(() => {
      capture = captureLogs();
    });
    afterEach(() => {
      capture.restore();
    });

    it('testUndecodableAttachmentIsKeptWithoutHash', async () => {
      const result = await parseEmail(multipartEmail('base64', '!!!notb64!!!'));
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).not.toHaveProperty('sha256');
      expect(result.attachments[0]?.payload).toBe('!!!notb64!!!');
      expect(capture.output).toContain(
        'DEBUG:tsdmarc:Unable to decode attachment: Incorrect padding',
      );
    });
  });
});

describe('TestUtilsOutlookMsg', () => {
  it('testIsOutlookMsg', () => {
    expect(isOutlookMsg(msgBytes())).toBe(true);
  });

  it('testIsNotOutlookMsg', () => {
    expect(isOutlookMsg(encoder.encode('not an msg file'))).toBe(false);
    expect(isOutlookMsg('string input')).toBe(false);
  });

  it('testConvertOutlookMsgInvalidInput', async () => {
    await expect(
      convertOutlookMsg(encoder.encode('not an msg file')),
    ).rejects.toBeInstanceOf(ValueError);
  });

  it('testConvertOutlookMsgMissingUtility', async () => {
    const oldCwd = process.cwd();
    // An empty directory as the whole PATH: no msgconvert anywhere.
    binDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-bin-'));
    savedPath = process.env.PATH;
    process.env.PATH = binDir;
    await expect(convertOutlookMsg(msgBytes())).rejects.toThrow(
      new EmailParserError(
        'Failed to convert Outlook MSG: msgconvert utility not found',
      ),
    );
    expect(process.cwd()).toBe(oldCwd);
    // The temporary directory is removed.
    const [call] = spawnMock.calls;
    const { cwd } = (call as unknown[])[2] as { cwd: string };
    expect(existsSync(cwd)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a converted message over the limit before reading it',
    async () => {
      fakeMsgconvert(
        "printf 'From: a@b.com\\r\\n\\r\\n0123456789\\r\\n' > sample.eml",
      );
      await expect(convertOutlookMsg(msgBytes(), 10)).rejects.toThrow(
        new EmailTooLargeError(
          'Email of 29 bytes exceeds the 10 byte size limit (max_email_size)',
        ),
      );
      expect(await convertOutlookMsg(msgBytes(), 29)).toHaveLength(29);
      expect(await convertOutlookMsg(msgBytes(), 0)).toHaveLength(29);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'testConvertOutlookMsgReadsConvertedFile',
    async () => {
      const oldCwd = process.cwd();
      // msgconvert runs in a temp dir holding sample.msg, writing sample.eml.
      fakeMsgconvert(
        '[ "$1" = sample.msg ] && [ -s sample.msg ] || exit 9\n' +
          "printf 'From: a@b.com\\r\\nSubject: converted\\r\\n\\r\\nhi\\r\\n' > sample.eml",
      );
      expect(await convertOutlookMsg(msgBytes())).toEqual(
        encoder.encode('From: a@b.com\r\nSubject: converted\r\n\r\nhi\r\n'),
      );
      expect(process.cwd()).toBe(oldCwd);
      expect(spawnMock.calls[0]?.slice(0, 2)).toEqual([
        'msgconvert',
        ['sample.msg'],
      ]);
      expect(spawnMock.calls[0]?.[2]).toMatchObject({ stdio: 'ignore' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'testParseEmailConvertsOutlookMsgBytes',
    async () => {
      fakeMsgconvert(
        "printf 'From: a@b.com\\r\\nSubject: from msg\\r\\n\\r\\nhi\\r\\n' > sample.eml",
      );
      const result = await parseEmail(msgBytes());
      expect(result.subject).toBe('from msg');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'discards chatty output like DEVNULL (no buffer limit)',
    async () => {
      fakeMsgconvert(
        'head -c 4000000 /dev/zero | tr "\\0" x\n' +
          'head -c 4000000 /dev/zero | tr "\\0" y >&2\n' +
          "printf 'Subject: quiet\\n\\nhi\\n' > sample.eml",
      );
      expect(await convertOutlookMsg(msgBytes())).toEqual(
        encoder.encode('Subject: quiet\n\nhi\n'),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a msgconvert that exits with an error',
    async () => {
      fakeMsgconvert('exit 2');
      await expect(convertOutlookMsg(msgBytes())).rejects.toThrow(
        "Command '['msgconvert', 'sample.msg']' returned non-zero exit status 2.",
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a msgconvert killed by a signal like CalledProcessError',
    async () => {
      fakeMsgconvert('kill -9 $$');
      await expect(convertOutlookMsg(msgBytes())).rejects.toThrow(
        "Command '['msgconvert', 'sample.msg']' died with <Signals.SIGKILL: 9>.",
      );
    },
  );

  it('kills a msgconvert that runs past the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let killed = false;
      spawnMock.fake = () => {
        const child = Object.assign(new EventEmitter(), {
          kill: (): boolean => {
            killed = true;
            child.emit('close', null, 'SIGKILL');
            return true;
          },
        });
        return child;
      };
      const result = convertOutlookMsg(msgBytes()).catch(
        (error: unknown) => error,
      );
      while (spawnMock.calls.length === 0) {
        // oxlint-disable-next-line no-await-in-loop -- waits for the spawn
        await new Promise(resolve => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(MSGCONVERT_TIMEOUT_MS);
      const error = await result;
      expect(killed).toBe(true);
      expect(error).toBeInstanceOf(EmailParserError);
      expect((error as Error).message).toBe(
        'Failed to convert Outlook MSG: msgconvert did not finish within 60s',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TestIsMbox', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-mbox-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('testValidMbox', async () => {
    const file = path.join(dir, 'test.mbox');
    writeFileSync(
      file,
      'From test@example.com Thu Jan  1 00:00:00 2024\nSubject: Test\n\nBody\n\n',
    );
    expect(await isMbox(file)).toBe(true);
  });

  it('testEmptyFileNotMbox', async () => {
    const file = path.join(dir, 'empty.mbox');
    writeFileSync(file, '');
    expect(await isMbox(file)).toBe(false);
  });

  it('testNonExistentNotMbox', async () => {
    const capture = captureLogs();
    try {
      expect(await isMbox('/nonexistent/file.mbox')).toBe(false);
      expect(capture.output).toEqual([
        "DEBUG:tsdmarc:Error checking for MBOX file: [Errno 2] No such file or directory: '/nonexistent/file.mbox'",
      ]);
    } finally {
      capture.restore();
    }
  });

  it('finds a From_ line after other lines', async () => {
    const file = path.join(dir, 'later.mbox');
    writeFileSync(file, `${'x'.repeat(70_000)}\nFrom someone\nbody\n`);
    expect(await isMbox(file)).toBe(true);
  });

  it('does not take "From:" headers for From_ lines', async () => {
    const file = path.join(dir, 'message.eml');
    writeFileSync(file, 'From: a@example.com\nSubject: x\n\nbody\n');
    expect(await isMbox(file)).toBe(false);
  });
});

describe('mailsuite TestDecodeBase64', () => {
  const decode = (text: string): string =>
    new TextDecoder().decode(decodeBase64(text));

  it('test_padded', () => {
    expect(decode('aGVsbG8=')).toBe('hello');
  });

  it('test_unpadded', () => {
    expect(decode('aGVsbG8')).toBe('hello');
  });

  it('test_empty', () => {
    expect(decodeBase64('')).toEqual(new Uint8Array());
  });

  it('test_unicode_payload', () => {
    const encoded = Buffer.from('héllo').toString('base64').replace(/=+$/u, '');
    expect(decode(encoded)).toBe('héllo');
  });
});

describe('mailsuite TestGetFilenameSafeString', () => {
  // parsedmarc's version strips \ / : " * ? | CR LF NUL (not < >) and has no
  // max_length argument; expectations follow parsedmarc.
  it.each([
    ['hello world', 'hello world'],
    ['a/b\\c:d*e?f<g>h|i', 'abcdef<g>hi'],
    ['with\nnewlines\rhere', 'withnewlineshere'],
    ['"quoted"', 'quoted'],
    ['trailing.', 'trailing'],
  ])('test_invalid_chars(%s)', (raw, expected) => {
    expect(getFilenameSafeString(raw)).toBe(expected);
  });

  it('test_none_becomes_string', () => {
    expect(getFilenameSafeString(null)).toBe('None');
  });

  it('truncates by code points, not UTF-16 units, then by UTF-8 bytes', () => {
    expect(getFilenameSafeString('a'.repeat(150))).toBe('a'.repeat(100));
    expect(getFilenameSafeString('é'.repeat(150))).toBe('é'.repeat(50));
    // 99 emoji are 198 UTF-16 units but 99 characters: the character cap
    // keeps them all, the byte cap keeps 24 after the "a".
    expect(getFilenameSafeString(`a${'😀'.repeat(99)}`)).toBe(
      `a${'😀'.repeat(24)}`,
    );
  });

  it('removes control characters and bidi marks', () => {
    expect(getFilenameSafeString('a\u001B[31mb\tc\u0085d')).toBe('a[31mbcd');
    expect(getFilenameSafeString('invoice‮gpj.exe')).toBe('invoicegpj.exe');
    expect(getFilenameSafeString('x⁦y⁩‏z')).toBe('xyz');
  });
});

describe('mailsuite TestParseEmailAddress', () => {
  it('test_tuple_input', () => {
    const result = parseEmailAddress(['Alice', 'alice@example.com']);
    expect(result.displayName).toBe('Alice');
    expect(result.domain).toBe('example.com');
  });

  it('test_uppercase_normalized', () => {
    const result = parseEmailAddress(['', 'USER@EXAMPLE.COM']);
    expect(result.local).toBe('user');
    expect(result.domain).toBe('example.com');
    expect(result.address).toBe('USER@EXAMPLE.COM');
  });
});

describe('mailsuite TestIsOutlookMsg', () => {
  it('test_recognises_ole_signature', () => {
    expect(isOutlookMsg(msgBytes(24))).toBe(true);
  });

  it('test_rejects_plain_text', () => {
    expect(isOutlookMsg(encoder.encode('From: a@b.c\r\n\r\nbody'))).toBe(false);
  });

  it('test_rejects_non_bytes', () => {
    expect(isOutlookMsg('string-not-bytes')).toBe(false);
  });
});

describe('mailsuite TestParseEmail', () => {
  const sampleEmail =
    'From: Sender <sender@example.com>\r\nTo: recipient@example.org\r\nSubject: Hello\r\n' +
    'Date: Mon, 27 Apr 2026 12:00:00 +0000\r\nMessage-ID: <test@example.com>\r\n' +
    'MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nHello world\r\n';

  it('test_basic_message', async () => {
    const parsed = await parseEmail(sampleEmail);
    expect(parsed.from?.address).toBe('sender@example.com');
    expect(parsed.from?.domain).toBe('example.com');
    expect(parsed.subject).toBe('Hello');
    expect(parsed.to[0]?.address).toBe('recipient@example.org');
    expect(parsed.body?.trim()).toBe('Hello world');
    expect(parsed.filenameSafeSubject).toBe('Hello');
    expect(parsed.date).toBe('2026-04-27 12:00:00+00:00');
  });

  it('test_bytes_input', async () => {
    expect((await parseEmail(encoder.encode(sampleEmail))).subject).toBe(
      'Hello',
    );
  });

  it('test_invalid_input_type', async () => {
    await expect(
      parseEmail(12_345 as unknown as string),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('test_missing_from_header_does_not_raise', async () => {
    const parsed = await parseEmail(
      'To: b@example.org\r\nSubject: No sender\r\n\r\nbody\r\n',
    );
    expect(parsed.from).toBeNull();
  });

  it('test_reply_to_preserved', async () => {
    const parsed = await parseEmail(
      'From: Alice <alice@example.com>\r\nReply-To: Carol <carol@example.com>, dave@example.com\r\n' +
        'To: bob@example.com\r\nSubject: Hello\r\n\r\nbody\r\n',
    );
    expect(new Set(parsed.replyTo.map(address => address.address))).toEqual(
      new Set(['carol@example.com', 'dave@example.com']),
    );
  });

  it('test_subject_with_regex_metacharacters', async () => {
    for (const subject of [
      'Backup \\1 done',
      'Price \\g<0> off',
      '100\\% \\8 \\k',
      'cost $& $1',
    ]) {
      const parsed = await parseEmail(
        `From: a@example.com\r\nTo: b@example.org\r\nSubject: ${subject}\r\n\r\nbody\r\n`,
      );
      expect(parsed.subject).toBe(subject);
      expect(parsed.headers.Subject).toBe(subject);
    }
  });
});

describe('parseEmail: JavaScript-specific behavior', () => {
  it('keeps header names like __proto__ as own data', async () => {
    const parsed = await parseEmail(
      'From: a@b.com\n__proto__: x\nconstructor: y\n\nbody\n',
    );
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed.headers, '__proto__')).toBe(true);
    const snake = toSnakeCaseKeys(parsed) as Record<string, unknown>;
    expect(Object.hasOwn(snake, '__proto__')).toBe(true);
    expect(snake.constructor).toBe('y');
  });

  it('replaces lone surrogates in string input', async () => {
    const parsed = await parseEmail(
      'From: a@b.com\nSubject: bad \ud800 text\n\nbody\n',
    );
    expect(parsed.subject).toBe('bad � text');
  });

  it('decodes bytes as UTF-8 with replacement, keeping a BOM-less start', async () => {
    const parsed = await parseEmail(
      Uint8Array.of(
        ...encoder.encode('Subject: caf'),
        0xe9,
        ...encoder.encode('\n\nbody\n'),
      ),
    );
    expect(parsed.subject).toBe('caf�');
  });

  it('fails like parsedmarc when there are several Subject headers', async () => {
    await expect(
      parseEmail('Subject: one\nSubject: two\n\nbody\n'),
    ).rejects.toThrow("'list' object has no attribute 'replace'");
  });

  it('uses camelCase keys that convert back to parsedmarc keys', async () => {
    const parsed = await parseEmail(
      readFileSync(
        path.join(ROOT, 'samples', 'failure', 'dmarc_ruf_report_linkedin.eml'),
      ),
    );
    expect(parsed).toHaveProperty('filenameSafeSubject');
    expect(parsed).toHaveProperty('hasDefects', false);
    expect(parsed.received?.[0]).toHaveProperty('dateUtc');
    const snake = toSnakeCaseKeys(parsed) as Record<string, unknown>;
    expect(snake).toHaveProperty('filename_safe_subject');
    expect(snake).not.toHaveProperty('filenameSafeSubject');
  });
});
