import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import extractCases from './__fixtures__/extract-cases.json' with { type: 'json' };
import expectedHashes from './__fixtures__/extract-sha256.json' with { type: 'json' };
import { ParserError } from './errors';
import {
  decompressGzipBounded,
  extractReport,
  extractReportFromFilePath,
  extractReportFromStream,
  MAX_DECOMPRESSED_SLOW_CODEC_SIZE,
} from './extract';
import { crc32Update } from './internal/crc';
import { samplePath } from './test/fixtures';
import { parseXmlToDict } from './xml/xmltodict';

const XML = '<?xml version="1.0"?><feedback></feedback>';
const xmlBytes = new TextEncoder().encode(XML);

// Archives built by Python's gzip/zipfile modules.
const PYTHON_GZIP =
  'H4sIAAAAAAAC/7Oxr8jNUShLLSrOzM+zVTLUM1Cyt7NJS01NSUpMzraz0YczAYuTzmgqAAAA';
const PYTHON_ZIP =
  'UEsDBBQAAAAIAHQdWF2Lk85oJAAAACoAAAAKAAAAcmVwb3J0LnhtbLOxr8jNUShLLSrOzM+zVTLUM1Cyt7NJS01NSUpMzraz0YczAVBLAQIUAxQAAAAIAHQdWF2Lk85oJAAAACoAAAAKAAAAAAAAAAAAAACAAQAAAAByZXBvcnQueG1sUEsFBgAAAAABAAEAOAAAAEwAAAAAAA==';
const PYTHON_ZIP_STORED =
  'UEsDBBQAAAAAAHQdWF2Lk85oKgAAACoAAAAKAAAAcmVwb3J0LnhtbDw/eG1sIHZlcnNpb249IjEuMCI/PjxmZWVkYmFjaz48L2ZlZWRiYWNrPlBLAQIUAxQAAAAAAHQdWF2Lk85oKgAAACoAAAAKAAAAAAAAAAAAAACAAQAAAAByZXBvcnQueG1sUEsFBgAAAAABAAEAOAAAAFIAAAAAAA==';

const fromBase64 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'base64'));

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf-8').digest('hex');

describe('extractReport matches parsedmarc on every non-email sample', () => {
  for (const [relative, expected] of Object.entries(expectedHashes)) {
    it(relative, async () => {
      if (expected.startsWith('ERR ')) {
        await expect(
          extractReportFromFilePath(samplePath(relative)),
        ).rejects.toThrow(expected.slice(expected.indexOf(': ') + 2));
        return;
      }
      const text = await extractReportFromFilePath(samplePath(relative));
      expect(sha256(text)).toBe(expected);
    });
  }
});

describe('extractReport', () => {
  it('handles raw XML bytes', () => {
    const xml = new TextEncoder().encode(
      '<?xml version="1.0"?><feedback><report_metadata></report_metadata></feedback>',
    );
    expect(extractReport(xml)).toContain('<feedback>');
  });

  it('handles a base64-encoded XML string, ignoring line breaks', () => {
    const b64 = Buffer.from(XML).toString('base64');
    expect(extractReport(b64)).toBe(XML);
    expect(extractReport(`${b64.slice(0, 10)}\r\n${b64.slice(10)}`)).toBe(XML);
  });

  it('returns a string that is not strict base64 unchanged', () => {
    expect(extractReport(XML)).toBe(XML);
    expect(extractReport('abc')).toBe('abc');
  });

  it('handles gzip and zip built by Python', () => {
    expect(extractReport(fromBase64(PYTHON_GZIP))).toBe(XML);
    expect(extractReport(fromBase64(PYTHON_ZIP))).toBe(XML);
    expect(extractReport(fromBase64(PYTHON_ZIP_STORED))).toBe(XML);
  });

  it('handles gzip and zip built in JS', () => {
    expect(extractReport(gzipSync(xmlBytes))).toBe(XML);
    expect(extractReport(zipSync({ 'report.xml': xmlBytes }))).toBe(XML);
    expect(
      extractReport(zipSync({ 'report.xml': [xmlBytes, { level: 0 }] })),
    ).toBe(XML);
  });

  it('passes plain JSON through (MAGIC_JSON regression)', () => {
    const json = '{"organization-name": "Example"}';
    expect(extractReport(new TextEncoder().encode(json))).toBe(json);
  });

  it('rejects content that is not a report', () => {
    expect(() =>
      extractReport(new TextEncoder().encode('this is not a valid archive')),
    ).toThrow(
      new ParserError(
        'Invalid archive file: Not a valid zip, gzip, json, or xml file',
      ),
    );
  });

  it('drops invalid UTF-8 bytes like errors="ignore"', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<a>'),
      0xff,
      0xe2,
      0x82,
      0x41,
    ]);
    expect(extractReport(bytes)).toBe('<a>A');
  });
});

describe('decompression limits (GHSA-43qf-f35w-2x4r)', () => {
  const limit = 4096;

  it('rejects gzip over the limit', () => {
    const compressed = gzipSync(new Uint8Array(limit + 1).fill(0x61));
    expect(compressed.length).toBeLessThan(limit);
    expect(() =>
      extractReport(compressed, { maxDecompressedSize: limit }),
    ).toThrow(`Decompressed report exceeds the ${limit} byte limit`);
  });

  it('extracts gzip at exactly the limit', () => {
    const result = extractReport(gzipSync(new Uint8Array(limit).fill(0x61)), {
      maxDecompressedSize: limit,
    });
    expect(result).toBe('a'.repeat(limit));
  });

  it('rejects a zip member over the limit and accepts one at it', () => {
    const over = zipSync({
      'report.xml': new Uint8Array(limit + 1).fill(0x61),
    });
    expect(over.length).toBeLessThan(limit);
    expect(() => extractReport(over, { maxDecompressedSize: limit })).toThrow(
      `Decompressed report exceeds the ${limit} byte limit`,
    );
    const at = zipSync({ 'report.xml': new Uint8Array(limit).fill(0x61) });
    expect(extractReport(at, { maxDecompressedSize: limit })).toBe(
      'a'.repeat(limit),
    );
  });

  it('rejects a stored zip member over the limit', () => {
    const over = zipSync({
      'report.xml': [new Uint8Array(limit + 1).fill(0x61), { level: 0 }],
    });
    expect(() => extractReport(over, { maxDecompressedSize: limit })).toThrow(
      `Decompressed report exceeds the ${limit} byte limit`,
    );
  });

  it('defaults to 100 MiB', () => {
    const big = gzipSync(new Uint8Array(100 * 1024 * 1024 + 1));
    expect(() => extractReport(big)).toThrow(
      `Decompressed report exceeds the ${100 * 1024 * 1024} byte limit`,
    );
  });
});

describe('gzip edge cases', () => {
  it('rejects a truncated stream', () => {
    const truncated = gzipSync(xmlBytes).subarray(0, -8);
    expect(() => extractReport(truncated)).toThrow('truncated');
    expect(() =>
      decompressGzipBounded(gzipSync(xmlBytes).subarray(0, 5)),
    ).toThrow('Incomplete or truncated gzip stream');
  });

  it('ignores bytes after the first member', () => {
    const data = Buffer.concat([
      gzipSync(xmlBytes),
      Buffer.from('trailing garbage'),
    ]);
    expect(extractReport(data)).toBe(XML);
    const twoMembers = Buffer.concat([gzipSync(xmlBytes), gzipSync('<more/>')]);
    expect(extractReport(twoMembers)).toBe(XML);
  });

  it('checks the CRC', () => {
    const data = Buffer.from(gzipSync(xmlBytes));
    data[data.length - 8] = (data.at(-8) ?? 0) ^ 0xff;
    expect(() => extractReport(data)).toThrow('incorrect data check');
  });

  it('reports corrupt deflate data like zlib.error', () => {
    const data = Buffer.from(gzipSync(xmlBytes));
    data.fill(0xff, 10, 14);
    expect(() => extractReport(data)).toThrow(
      /^Invalid archive file: Error -3 while decompressing data: /u,
    );
  });
});

describe('zip edge cases', () => {
  it('rejects an empty archive and a bad CRC', () => {
    expect(() => extractReport(zipSync({}))).toThrow(ParserError);
    const zip = Buffer.from(
      zipSync({ 'report.xml': [xmlBytes, { level: 0 }] }),
    );
    // Corrupt the stored data (after the 30-byte header and the name); like
    // zipfile, the CRC checked is the central directory's.
    const dataOffset = 30 + 'report.xml'.length;
    zip[dataOffset + 5] = (zip[dataOffset + 5] ?? 0) ^ 0xff;
    expect(() => extractReport(zip)).toThrow(
      "Bad CRC-32 for file 'report.xml'",
    );
  });

  it('reads only the first member', () => {
    const zip = zipSync({
      'a.xml': xmlBytes,
      'b.xml': new TextEncoder().encode('<b/>'),
    });
    expect(extractReport(zip)).toBe(XML);
  });
});

/** `[name, limit (0 = default), base64 input, parsedmarc's result]`. */
type ExtractCase = [string, number, string, { ok: string } | { error: string }];

describe('extractReport matches parsedmarc on corrupt archives', () => {
  // tools/fixtures/generate_extract_cases.py: one case per zipfile / zlib /
  // bz2 / lzma / zstd check, plus random mutations.
  for (const [name, limit, input, expected] of extractCases as ExtractCase[]) {
    it(name, () => {
      const options = limit === 0 ? {} : { maxDecompressedSize: limit };
      const extract = (): string => extractReport(fromBase64(input), options);
      if ('error' in expected) {
        expect(extract).toThrow(new ParserError(expected.error));
      } else {
        expect(extract()).toBe(expected.ok);
      }
    });
  }
});

describe('zipfile and zlib checks', () => {
  const gzipWithHeaderCrc = (crc?: number): Uint8Array => {
    const plain = gzipSync(xmlBytes);
    const header = Buffer.from(plain.subarray(0, 10));
    header[3] = 0x02;
    const headerCrc = Buffer.alloc(2);
    headerCrc.writeUInt16LE(crc ?? crc32Update(0, header) & 0xff_ff);
    return Buffer.concat([header, headerCrc, plain.subarray(10)]);
  };

  it('checks the gzip header CRC (FHCRC) like zlib', () => {
    expect(extractReport(gzipWithHeaderCrc())).toBe(XML);
    expect(() => extractReport(gzipWithHeaderCrc(0x12_34))).toThrow(
      new ParserError(
        'Invalid archive file: Error -3 while decompressing data: header crc mismatch',
      ),
    );
  });

  it('reports a negative member offset like io.BytesIO.seek', () => {
    const zip = Buffer.from(zipSync({ 'a.xml': xmlBytes }));
    const end = zip.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    // Move the central directory offset 45 bytes past its real position.
    zip.writeUInt32LE(zip.readUInt32LE(end + 16) + 45, end + 16);
    expect(() => extractReport(zip)).toThrow(
      new ParserError('Invalid archive file: negative seek value -45'),
    );
  });
});

describe('streams and files', () => {
  it('reads byte streams (Node and web)', async () => {
    expect(await extractReportFromStream(Readable.from([xmlBytes]))).toBe(XML);
    expect(await extractReportFromStream(new Blob([xmlBytes]).stream())).toBe(
      XML,
    );
  });

  it('rejects text streams', async () => {
    await expect(
      extractReportFromStream(
        Readable.from(['text data'], { objectMode: true }),
      ),
    ).rejects.toThrow('File objects must be opened in binary (rb) mode');
  });

  it('reports a missing file', async () => {
    await expect(
      extractReportFromFilePath('/nonexistent/report.xml'),
    ).rejects.toThrow(new ParserError('File was not found'));
  });

  it('reads the gzip sample', async () => {
    const text = await extractReportFromFilePath(
      samplePath('extract_report/nice-input.xml.gz'),
    );
    expect(text).toBe(
      readFileSync(samplePath('extract_report/nice-input.xml'), 'utf-8'),
    );
  });
});

// --- Test (tests/test_init.py): extract_report ------------------------------

/**
 * parsedmarc's `compare_xml()`: equal element trees once blank text is
 * dropped. xmltodict's dict (which strips whitespace-only text) stands in
 * for lxml's `remove_blank_text` tree.
 */
const compareXml = (xml1: string, xml2: string): boolean =>
  JSON.stringify(parseXmlToDict(xml1)) === JSON.stringify(parseXmlToDict(xml2));

/** parsedmarc's `minify_xml()`: drop whitespace between tags. */
const minifyXml = (xml: string): string => xml.replaceAll(/>\s+</gu, '><');

const readSample = (relative: string): string =>
  readFileSync(samplePath(relative), 'utf-8');

describe('Test (extract)', () => {
  const NICE = 'extract_report/nice-input.xml';
  const CHANGED = 'extract_report/changed-input.xml';

  it('testExtractReportXMLComparator', () => {
    const xmlnice = readSample(NICE);
    const xmlchanged = minifyXml(readSample(CHANGED));
    expect(compareXml(xmlnice, xmlnice)).toBe(true);
    expect(compareXml(xmlchanged, xmlchanged)).toBe(true);
    expect(compareXml(xmlnice, xmlchanged)).toBe(false);
    expect(compareXml(xmlchanged, xmlnice)).toBe(false);
  });

  it('testExtractReportBytes', () => {
    const data = new Uint8Array(readFileSync(samplePath(NICE)));
    expect(compareXml(extractReport(data), readSample(NICE))).toBe(true);
  });

  it('testExtractReportXML', async () => {
    const xmlout = await extractReportFromFilePath(samplePath(NICE));
    expect(compareXml(xmlout, readSample(NICE))).toBe(true);
  });

  it('testExtractReportXMLFromPath', async () => {
    // Python passes a pathlib.Path; tsdmarc takes path strings.
    const xmlout = await extractReportFromFilePath(samplePath(NICE));
    expect(compareXml(xmlout, readSample(NICE))).toBe(true);
  });

  it('testExtractReportGZip', async () => {
    const xmlout = await extractReportFromFilePath(samplePath(`${NICE}.gz`));
    expect(compareXml(xmlout, readSample(NICE))).toBe(true);
  });

  it('testExtractReportZip', async () => {
    const xmlout = await extractReportFromFilePath(samplePath(`${NICE}.zip`));
    expect(compareXml(xmlout, minifyXml(readSample(NICE)))).toBe(true);
    expect(compareXml(xmlout, readSample(CHANGED))).toBe(false);
  });

  it('testExtractReportFromFilePathNotFound', async () => {
    await expect(
      extractReportFromFilePath('nonexistent_file.xml'),
    ).rejects.toThrow(ParserError);
  });

  it('testExtractReportInvalidArchive', () => {
    expect(() =>
      extractReport(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])),
    ).toThrow(ParserError);
  });
});

describe('bzip2, LZMA and Zstandard zip members (not in parsedmarc)', () => {
  // `<a>` + 2000 × `x` + `</a>` with each method (CPython's zipfile).
  const MEMBERS: [string, string][] = [
    [
      'bzip2',
      'UEsDBC4AAAAMAPm1Wl2UpNpbNwAAANcHAAAFAAAAYS54bWxCWmg5MUFZJlNZelVQHQAAARmCgACABSAAAEAIAAAIIAAhJD1AhgK3EXpHgA8XckU4UJB6VVAdUEsBAi4DLgAAAAwA+bVaXZSk2ls3AAAA1wcAAAUAAAAAAAAAAAAAAIABAAAAAGEueG1sUEsFBgAAAAABAAEAMwAAAFoAAAAAAA==',
    ],
    [
      'LZMA',
      'UEsDBD8AAgAOAPm1Wl2UpNpbKAAAANcHAAAFAAAAYS54bWwJBAUAXQAAgAAAHhhDx8bvLMOTLdKLbGVAbHD1Qjn9EQNt1f/9/sAAUEsBAj8DPwACAA4A+bVaXZSk2lsoAAAA1wcAAAUAAAAAAAAAAAAAAIABAAAAAGEueG1sUEsFBgAAAAABAAEAMwAAAEsAAAAAAA==',
    ],
    [
      'Zstandard',
      'UEsDBD8AAABdAPm1Wl2UpNpbGAAAANcHAAAFAAAAYS54bWwotS/9AFh9AABAPGE+eDwvYT4BAMz/gAhQSwECPwM/AAAAXQD5tVpdlKTaWxgAAADXBwAABQAAAAAAAAAAAAAAgAEAAAAAYS54bWxQSwUGAAAAAAEAAQAzAAAAOwAAAAAA',
    ],
  ];
  const expected = `<a>${'x'.repeat(2000)}</a>`;

  for (const [codec, zip] of MEMBERS) {
    it(`caps ${codec} members at the lower slow-codec limit`, () => {
      expect(extractReport(fromBase64(zip))).toBe(expected);
      expect(extractReport(fromBase64(zip), { maxSlowCodecSize: 2007 })).toBe(
        expected,
      );
      expect(() =>
        extractReport(fromBase64(zip), { maxSlowCodecSize: 2006 }),
      ).toThrow(
        new ParserError(
          `Invalid archive file: Decompressed ${codec} report exceeds the 2006 byte limit for bzip2, LZMA and Zstandard zip members`,
        ),
      );
    });
  }

  it('keeps the 100 MiB cap for deflate members', () => {
    const zip = zipSync({ 'a.xml': new TextEncoder().encode(expected) });
    expect(extractReport(zip, { maxSlowCodecSize: 10 })).toBe(expected);
  });

  it('stops a 1.7 KB bzip2 bomb (1 GiB) at 10 MiB', () => {
    // At the 100 MiB cap this took 10-14 s of CPU in the pure-TypeScript
    // bzip2 decoder.
    const bomb =
      'UEsDBC4AAAAMAAAAIQDvhatm//////////8FABQAci54bWwBABAAAAAAQAAAAACNBAAAAAAAAEJaaDkxQVkmU1kDLZeVAAArTACACAAEIAAACCAAUGaaBSSOpNSe6A1IqKD2lQkTUnESpVSfMUFZJlNZOgoqPQBU/cwAgAgABCAAAAggAFBmmgUkjimKYg9SKig9pUJE1JwJUqpPmKCskyms4zb5aIBUxuYAQAQAAhAAAAQQACgzTQKSRxTFMQepFRQe0qEiak4EqVUnzFBWSZTWcxEZrcA/h3MAIAIAAQgAAAIIABQZpoFJI4pimIPUiooPaVCRNScCVKqT5igrJMprL0Gm3wApXMmAEAEAAIQAAAEEAAoM00CkkdSak0B6FJFJ5JhUFuIlSqk+YoKyTKayxsflWgCLj5gBABAACEAAABBAAKDNNApJHFMUxB6kVFB7SoSJqTgSpVSfMUFZJlNZEqqKhwCaV8wAgAgABCAAAAggAFBmmgUkjimKYg9SKig9pUJE1JwJUqpPmKCskymslM6XrQB3c+YAQAQAAhAAAAQQACgzTQKSRxTFMQepFRQe0qEiak4EqVUnzFBWSZTWZTymJgBPAjMAIAIAAQgAAAIIABQZpoFJI6k1JoD0KSKTyTCoLcRKlVJ8xQVkmU1mVaj22ADaRzACACAAEIAAACCAAUGaaBSSOKYpiD1IqKD2lQkTUnAlSqk+YoKyTKazkM60kgEWQ5gBABAACEAAABBAAKDNNApJHFMUxB6kVFB7SoSJqTgSpVSfMUFZJlNZp+O3HADfscwAgAgABCAAAAggAFBmmgUkjimKYg9SKig9pUJE1JwJUqpPmKCskyms8UsG6YCWlaYAQAQAAhAAAAQQACgzTQKSR1JqTQHoUkUnkmFQW4iVKqT5igrJMprJ7Fp2eAE63mAEAEAAIQAAAEEAAoM00CkkcUxTEHqRUUHtKhImpOBKlVJ8xQVkmU1lKda4kAHvrzACACAAEIAAACCAAUGaaBSSOKYpiD1IqKD2lQkTUnAlSqk+YoKyTKay0A7kEAGg95gBABAACEAAABBAAKDNNApJHFMUxB6kVFB7SoSJqTgSpVSfMUFZJlNZsqe5kQEeTcwAgAgABCAAAAggAFBmmgUkjqTUmgPQpIpPJMKgtxEqVUnzFBWSZTWSvLvf0AGCXMAIAIAAQgAAAIIABQZpoFJI4pimIPUiooPaVCRNScCVKqT5igrJMprMyHDAyANlrmAEAEAAIQAAAEEAAoM00CkkcUxTEHqRUUHtKhImpOBKlVJ8xQVkmU1lob4w7AMFFzACACAAEIAAACCAAUGaaBSSOKYpiD1IqKD2lQkTUnAlSqk+YoKyTKazSF8JJgIe4JgBABAACEAAABBAAKDNNApJHUmpNAehSRSeSYVBbiJUqpPmKCskymsllXgKIAEd+YAQAQAAhAAAAQQACgzTQKSRxTFMQepFRQe0qEiak4EqVUnzFBWSZTWYKJ6dkAXX/MAIAIAAQgAAAIIABQZpoFJI4pimIPUiooPaVCRNScCVKqT5igrJMprKDjwniAJGdmAEAEAAIQAAAEEAAgKUAzTTUZDFLiEhG4qlVB0OEIih4u5IpwoSEBiWyqBQSwECLgMuAAAADAAAACEA74WrZo0EAAAAAABABQAAAAAAAAAAAAAAgAEAAAAAci54bWxQSwUGAAAAAAEAAQAzAAAAxAQAAAAA';
    expect(() => extractReport(fromBase64(bomb))).toThrow(
      new ParserError(
        `Invalid archive file: Decompressed bzip2 report exceeds the ${MAX_DECOMPRESSED_SLOW_CODEC_SIZE} byte limit for bzip2, LZMA and Zstandard zip members`,
      ),
    );
  });
});

describe('input size limit (not in parsedmarc)', () => {
  async function* endless(chunks: { seen: number }) {
    const chunk = new Uint8Array(1024 * 1024).fill(0x3c);
    for (;;) {
      chunks.seen += 1;
      yield chunk;
    }
  }

  it('stops reading a stream once it passes the limit', async () => {
    const chunks = { seen: 0 };
    await expect(extractReportFromStream(endless(chunks))).rejects.toThrow(
      'Invalid archive file: Report input exceeds the 104857600 byte limit',
    );
    expect(chunks.seen).toBe(101);
  });

  it('honors maxInputSize, with 0 for no limit', async () => {
    const xml = Buffer.from('<feedback/>');
    const stream = () =>
      (async function* () {
        yield xml;
      })();
    await expect(
      extractReportFromStream(stream(), { maxInputSize: xml.length - 1 }),
    ).rejects.toThrow(ParserError);
    await expect(
      extractReportFromStream(stream(), { maxInputSize: xml.length }),
    ).resolves.toBe('<feedback/>');
    await expect(
      extractReportFromStream(stream(), { maxInputSize: 0 }),
    ).resolves.toBe('<feedback/>');
  });

  it('applies the limit to files', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-extract-'));
    const file = path.join(directory, 'report.xml');
    writeFileSync(file, '<feedback/>');
    try {
      await expect(
        extractReportFromFilePath(file, { maxInputSize: 5 }),
      ).rejects.toThrow('Report input exceeds the 5 byte limit');
      await expect(extractReportFromFilePath(file)).resolves.toBe(
        '<feedback/>',
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
