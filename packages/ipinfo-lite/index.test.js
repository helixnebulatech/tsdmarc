// The package's one export must point at a readable MMDB database.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ipinfoLiteDbPath } from './index.js';

/** The MaxMind DB metadata section starts after this marker, near the end. */
const METADATA_MARKER = Buffer.concat([
  Buffer.from([0xab, 0xcd, 0xef]),
  Buffer.from('MaxMind.com', 'latin1'),
]);

describe('ipinfoLiteDbPath', () => {
  it('is the absolute path of the bundled database', () => {
    expect(path.isAbsolute(ipinfoLiteDbPath)).toBe(true);
    expect(path.basename(ipinfoLiteDbPath)).toBe('ipinfo_lite.mmdb');
  });

  it('points at an IPinfo Lite MaxMind DB file', () => {
    const data = readFileSync(ipinfoLiteDbPath);
    const marker = data.lastIndexOf(METADATA_MARKER);
    expect(marker).toBeGreaterThan(0);
    const metadata = data.subarray(marker).toString('latin1');
    expect(metadata).toContain('database_type');
    expect(metadata.toLowerCase()).toContain('ipinfo');
  });
});
