import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { INDEX_MAPPINGS, INDEXED_SAMPLE_HEADERS } from './documents';
import { dataStreamMapping } from './dsl';

const DASHBOARDS = [
  'grafana/Grafana-DMARC_Reports.json',
  'opensearch/opensearch_dashboards.ndjson',
];
const HEADER_FIELD = /sample\.headers\.([a-z0-9_-]+)/gu;

function dashboardHeaders(): Set<string> {
  const names = new Set<string>();
  for (const file of DASHBOARDS) {
    const url = new URL(`../../../dashboards/${file}`, import.meta.url);
    for (const match of readFileSync(url, 'utf8').matchAll(HEADER_FIELD)) {
      names.add(match[1] ?? '');
    }
  }
  return names;
}

describe('sample.headers mapping of failure indexes', () => {
  it('maps every header the shipped dashboards use', () => {
    const used = dashboardHeaders();
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      expect(INDEXED_SAMPLE_HEADERS).toContain(name);
    }
  });

  it('turns dynamic mapping off for the other headers', () => {
    const sample = INDEX_MAPPINGS.failure.properties.sample as {
      properties: Record<string, { dynamic?: boolean; properties?: object }>;
    };
    const headers = sample.properties.headers;
    expect(headers?.dynamic).toBe(false);
    expect(Object.keys(headers?.properties ?? {})).toEqual([
      ...INDEXED_SAMPLE_HEADERS,
    ]);
  });
});

describe('@timestamp', () => {
  const DATE = { type: 'date' };

  it('is a date in every index the save functions create', () => {
    // Date detection is off, so without it @timestamp would be text.
    for (const mapping of Object.values(INDEX_MAPPINGS)) {
      expect(mapping.properties['@timestamp']).toEqual(DATE);
    }
  });

  it('is all a data stream template maps without other mappings', () => {
    expect(dataStreamMapping(null)).toEqual({
      properties: { '@timestamp': DATE },
    });
  });

  it('is added to the mappings a data stream template gets', () => {
    const mapping = dataStreamMapping({
      date_detection: false,
      properties: { date_begin: DATE },
    });
    expect(mapping).toEqual({
      date_detection: false,
      properties: { date_begin: DATE, '@timestamp': DATE },
    });
  });
});
