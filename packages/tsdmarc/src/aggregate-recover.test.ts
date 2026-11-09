// parsedmarc wraps its lxml recovery in `except Exception: xml = "<a/>"`:
// whatever goes wrong while recovering, the report is parsed from "<a/>".

import { describe, expect, it, vi } from 'vitest';

import { parseAggregateReportXml } from './aggregate';
import { InvalidAggregateReport } from './errors';

vi.mock('./xml/recover', () => ({
  recoverXml: (): never => {
    throw new RangeError('Invalid string length');
  },
}));

describe('a failing XML recovery', () => {
  it('falls back to "<a/>" like parsedmarc', async () => {
    const promise = parseAggregateReportXml('<feedback><bad></feedback>', {
      offline: true,
    });
    await expect(promise).rejects.toThrow(InvalidAggregateReport);
    await expect(promise).rejects.toThrow("Missing field: 'feedback'");
  });
});
