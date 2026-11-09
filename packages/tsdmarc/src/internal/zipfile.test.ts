import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { BadZipFile, pyBytesRepr, readFirstZipMember } from './zipfile';

// The behavior of every zipfile check against CPython is covered by the
// fixture cases in extract.test.ts; these tests cover the read(count) API.
const fromBase64 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'base64'));
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * `<a>` + 1000 × `x` + `</a>` as a ZIP_BZIP2 member whose central directory
 * CRC is wrong (built with CPython's zipfile).
 */
const BZIP2_BAD_CRC =
  'UEsDBC4AAAAMAGlaWF3i8I6ZNwAAAO8DAAAFAAAAYS54bWxCWmg5MUFZJlNZica95gAAARmBgACABSAAAEAAgAAIIAAhKD1NCGAvtRZTADxdyRThQkInGveYUEsBAi4DLgAAAAwAaVpYXR3wjpk3AAAA7wMAAAUAAAAAAAAAAAAAAIABAAAAAGEueG1sUEsFBgAAAAABAAEAMwAAAFoAAAAAAA==';

describe('readFirstZipMember', () => {
  it('reads at most `count` bytes, like ZipExtFile.read(count)', () => {
    const zip = zipSync({ 'a.xml': new TextEncoder().encode('<a>12345</a>') });
    expect(text(readFirstZipMember(zip, 5))).toBe('<a>12');
    expect(text(readFirstZipMember(zip, 100))).toBe('<a>12345</a>');
  });

  it('checks the CRC once the whole member is read', () => {
    expect(() => readFirstZipMember(fromBase64(BZIP2_BAD_CRC), 2000)).toThrow(
      new BadZipFile("Bad CRC-32 for file 'a.xml'"),
    );
  });

  it('never decompresses a bzip2 member past `count` bytes', () => {
    // CPython decompresses the whole bzip2 chunk and then reports the bad
    // CRC; here the output stops at `count` bytes, so the CRC is unknown.
    const member = readFirstZipMember(fromBase64(BZIP2_BAD_CRC), 101);
    expect(member.length).toBe(101);
    expect(text(member)).toBe(`<a>${'x'.repeat(98)}`);
  });
});

describe('pyBytesRepr', () => {
  it("formats bytes like Python's repr()", () => {
    const bytes = (...values: number[]): Uint8Array => Uint8Array.of(...values);
    expect(pyBytesRepr(new TextEncoder().encode('a.xml'))).toBe("b'a.xml'");
    expect(pyBytesRepr(new TextEncoder().encode("it's"))).toBe('b"it\'s"');
    expect(pyBytesRepr(new TextEncoder().encode('\'"'))).toBe("b'\\'\"'");
    expect(pyBytesRepr(bytes(0x00, 0x09, 0x0a, 0x0d, 0x5c, 0x7f, 0xff))).toBe(
      "b'\\x00\\t\\n\\r\\\\\\x7f\\xff'",
    );
  });
});
