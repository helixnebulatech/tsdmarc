// Differential tests of the XML layer against Python (pyexpat + xmltodict,
// lxml/libxml2 recovery). The corpus and the expected results come from
// tools/fixtures/generate_xml.py, which runs the real libraries.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { cpuMsSince, cpuStart } from '../test/cpu-time';
import { REPO_ROOT } from '../test/fixtures';
import {
  ExpatError,
  parseXmlToDict,
  recoverXml,
  XmlDoctypeFound,
  XmlUnicodeEncodeError,
  XmlValueError,
  XmlLimitError,
} from './xmltodict';

interface ParseResult {
  dict?: unknown;
  dict_sha256?: string;
  error?: string;
}

interface DifferentialCase {
  category: string;
  name: string;
  input?: string;
  input_file?: string;
  parse: ParseResult;
  doctype?: true;
  recovered?: string;
  recovered_sha256?: string;
  recovered_doctype?: true;
  recovered_parse?: ParseResult;
}

const corpus = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '__fixtures__/xml-differential.json'),
    'utf-8',
  ),
) as { cases: DifferentialCase[] };

// parsedmarc's xml_schema_regex.
const XS_SCHEMA_TAG = /<\/?xs:schema[^<>]*>/gu;

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf-8').digest('hex');

// Python's `f"{type(e).__name__}: {e}"` for the errors the parser raises,
// from a plain `xmltodict.parse()` (DOCTYPEs allowed, like the corpus).
function describeResult(text: string, expected: ParseResult): ParseResult {
  try {
    const dict = parseXmlToDict(text, { rejectDoctype: false });
    return expected.dict_sha256 === undefined
      ? { dict }
      : { dict_sha256: sha256(JSON.stringify(dict)) };
  } catch (error) {
    if (error instanceof Error) {
      return { error: `${error.name}: ${error.message}` };
    }
    throw error;
  }
}

function inputOf(testCase: DifferentialCase): string {
  if (testCase.input_file !== undefined) {
    return readFileSync(path.join(REPO_ROOT, testCase.input_file), 'utf-8');
  }
  return testCase.input ?? '';
}

describe('differential corpus (Python pyexpat + xmltodict, lxml recovery)', () => {
  it('covers samples, hand-written, mutated, random and well-formed inputs', () => {
    const categories = new Set(corpus.cases.map(testCase => testCase.category));
    expect([...categories].sort()).toEqual([
      'handmade',
      'mutated',
      'sample',
      'soup',
      'tree',
      'truncated',
    ]);
    expect(corpus.cases.length).toBeGreaterThan(800);
  });

  it.each(corpus.cases)('$category $name', testCase => {
    const input = inputOf(testCase);
    expect(describeResult(input, testCase.parse)).toEqual(testCase.parse);
    // parsedmarc's parse aborts on a DOCTYPE; otherwise it is the same.
    let rejected = false;
    try {
      parseXmlToDict(input);
    } catch (error) {
      rejected = error instanceof XmlDoctypeFound;
    }
    expect(rejected).toBe(testCase.doctype === true);

    const recovered = recoverXml(input);
    expect(recovered.hasDoctype).toBe(testCase.recovered_doctype === true);
    if (recovered.hasDoctype) {
      return;
    }
    if (testCase.recovered_sha256 === undefined) {
      expect(recovered.xml).toBe(testCase.recovered);
    } else {
      expect(sha256(recovered.xml)).toBe(testCase.recovered_sha256);
    }
    expect(
      describeResult(recovered.xml, testCase.recovered_parse ?? {}),
    ).toEqual(testCase.recovered_parse);
  });
});

// Port of tests/test_init.py::TestMalformedXmlRecovery at the XML level. The
// report-level assertions (InvalidAggregateReport, missing fields) live in
// aggregate.test.ts.
describe('TestMalformedXmlRecovery (XML level)', () => {
  const REPORT_BODY = `
  <report_metadata>
    <org_name>example.com</org_name>
    <email>dmarc@example.com</email>
    <report_id>12345</report_id>
    <date_range><begin>1680000000</begin><end>1680086400</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain><p>none</p>
  </policy_published>
  <record>
    <row><source_ip>203.0.113.1</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>`;

  it('testRecoversMalformedXml', () => {
    const malformed = `<?xml version="1.0"?>\n<feedback>${REPORT_BODY}\n  <broken_tag\n</feedback>`;
    expect(() => parseXmlToDict(malformed)).toThrow(ExpatError);
    const recovered = parseXmlToDict(recoverXml(malformed).xml);
    const feedback = recovered?.feedback as Record<string, unknown>;
    expect(feedback.report_metadata).toMatchObject({
      org_name: 'example.com',
      report_id: '12345',
    });
    // libxml2 keeps the broken tag as an empty element.
    expect(feedback.broken_tag).toBeNull();
  });

  it('testBytesXmlInput', () => {
    const xml = `<?xml version="1.0"?>\n<feedback>${REPORT_BODY.replace('12345', 'test-bytes-input')}\n</feedback>`;
    const decoded = new TextDecoder().decode(new TextEncoder().encode(xml));
    const feedback = parseXmlToDict(decoded)?.feedback as Record<
      string,
      Record<string, unknown>
    >;
    expect(feedback.report_metadata?.report_id).toBe('test-bytes-input');
  });

  it('testExpatErrorRaises', () => {
    expect(() => parseXmlToDict('not xml at all {}')).toThrow(
      'syntax error: line 1, column 0',
    );
    // lxml finds no root: parsedmarc parses "" and fails again.
    expect(recoverXml('not xml at all {}').xml).toBe('');
    expect(() => parseXmlToDict('')).toThrow(
      'no element found: line 1, column 0',
    );
  });

  it('testReportMetadataNotAStructureRaises: report_metadata parses as text', () => {
    const xml =
      '<feedback><report_metadata>x</report_metadata>' +
      '<policy_published><domain>x.com</domain></policy_published>' +
      '<record></record></feedback>';
    expect(parseXmlToDict(xml)).toEqual({
      feedback: {
        policy_published: { domain: 'x.com' },
        record: null,
        report_metadata: 'x',
      },
    });
  });

  it('testXmlSchemaRegexRejectsRepeatedTagsQuickly: linear time', () => {
    // The Python regression (GHSA-4h9r-c435-j834) was a quadratic regex;
    // both the parser and the recovery must stay linear on this input.
    const input = '<xs:schema'.repeat(500_000);
    const start = performance.now();
    expect(() => parseXmlToDict(input)).toThrow(ExpatError);
    expect(recoverXml(input).xml).toBe('<xs:schema/>');
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  it('testMinifiedAggregateReportWithSchemaTag', () => {
    const original = readFileSync(
      path.join(
        REPO_ROOT,
        'samples/aggregate/ikea.com!example.de!1538690400!1538776800.xml',
      ),
      'utf-8',
    );
    const minified = original
      .split(/\r\n|\r|\n/u)
      .map(line => line.trim())
      .join('');
    expect(minified).toContain('<xs:schema');
    expect(minified).not.toContain('\n');
    // The sample is truncated: both forms fail and recover the same records.
    expect(() => parseXmlToDict(original)).toThrow(
      'no element found: line 47, column 11',
    );
    // parsedmarc then drops the xs:schema tags (xml_schema_regex) and parses.
    const reparse = (text: string): Record<string, unknown> =>
      parseXmlToDict(recoverXml(text).xml.replaceAll(XS_SCHEMA_TAG, ''))
        ?.feedback as Record<string, unknown>;
    const fromOriginal = reparse(original);
    const fromMinified = reparse(minified);
    expect(fromOriginal.report_metadata).toMatchObject({
      org_name: 'ikea.com',
    });
    expect(fromMinified.report_metadata).toEqual(fromOriginal.report_metadata);
    expect(fromMinified.record).toEqual(fromOriginal.record);
  });
});

describe('xmltodict output shapes', () => {
  it('keeps element names that collide with Object.prototype as plain keys', () => {
    const result = parseXmlToDict(
      '<a><__proto__>1</__proto__><constructor/></a>',
    );
    const a = result?.a as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(a, '__proto__')?.value).toBe('1');
    expect(Object.getPrototypeOf(a)).toBeNull();
  });

  it('puts attributes first, then children, then #text', () => {
    const result = parseXmlToDict('<a z="1">x<b/>y</a>');
    expect(JSON.stringify(result)).toBe(
      '{"a":{"@z":"1","b":null,"#text":"xy"}}',
    );
  });

  it('strips whitespace with Python str.strip() rules', () => {
    expect(parseXmlToDict('<a> x　</a>')).toEqual({ a: 'x' });
    expect(parseXmlToDict('<a>​x﻿</a>')).toEqual({ a: '​x﻿' });
  });
});

describe('errors Python raises outside Expat', () => {
  it('rejects entity declarations like xmltodict (no expansion at all)', () => {
    const billionLaughs =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    const plain = { rejectDoctype: false };
    expect(() => parseXmlToDict(billionLaughs, plain)).toThrow(XmlValueError);
    expect(() => parseXmlToDict(billionLaughs, plain)).toThrow(
      'entities are disabled',
    );
    expect(() =>
      parseXmlToDict(
        '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
        plain,
      ),
    ).toThrow('entities are disabled');
    // parsedmarc's parse stops at the DOCTYPE, before any declaration.
    expect(() => parseXmlToDict(billionLaughs)).toThrow(XmlDoctypeFound);
  });

  it('reports lone surrogates like str.encode("utf-8")', () => {
    expect(() => parseXmlToDict('<a>\udc80</a>')).toThrow(
      XmlUnicodeEncodeError,
    );
    expect(() => parseXmlToDict('<a>\udc80</a>')).toThrow(
      "'utf-8' codec can't encode character '\\udc80' in position 3: surrogates not allowed",
    );
    expect(() => parseXmlToDict('😀<\udc80\udc81')).toThrow(
      "'utf-8' codec can't encode characters in position 2-3: surrogates not allowed",
    );
    expect(recoverXml('<a>\udc80</a>').xml).toBe('<a/>');
  });
});

describe('ExpatError', () => {
  it('carries the code, line and column like pyexpat', () => {
    try {
      parseXmlToDict('<a>\n  <b></c>\n</a>');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExpatError);
      const expatError = error as ExpatError;
      expect(expatError.message).toBe('mismatched tag: line 2, column 7');
      expect(expatError.code).toBe(7);
      expect(expatError.lineno).toBe(2);
      expect(expatError.offset).toBe(7);
      expect(expatError.name).toBe('ExpatError');
    }
  });

  it('counts columns in characters, astral ones included', () => {
    expect(() => parseXmlToDict('<a>😀😀<b></c></a>')).toThrow(
      'mismatched tag: line 1, column 10',
    );
  });
});

describe('adversarial input', () => {
  it('stops at maxDepth and maxNodes, as soon as they are passed', () => {
    expect(() =>
      parseXmlToDict('<a><a><a></a></a></a>', { maxDepth: 2 }),
    ).toThrow(new XmlLimitError('XML nests more than 2 elements'));
    expect(
      parseXmlToDict('<a><a><a></a></a></a>', { maxDepth: 3 }),
    ).toBeDefined();
    expect(() =>
      parseXmlToDict('<a><b c="1"/><b/></a>', { maxNodes: 3 }),
    ).toThrow(new XmlLimitError('XML has more than 3 elements and attributes'));
    expect(
      parseXmlToDict('<a><b c="1"/><b/></a>', { maxNodes: 4 }),
    ).toBeDefined();
    expect(
      parseXmlToDict('<a><b c="1"/><b/></a>', { maxDepth: 0, maxNodes: 0 }),
    ).toBeDefined();
  });

  it('counts attributes before storing them', () => {
    const attributes = Array.from({ length: 1000 }, (_, i) => `a${i}=""`);
    expect(() =>
      parseXmlToDict(`<a ${attributes.join(' ')}/>`, { maxNodes: 10 }),
    ).toThrow(XmlLimitError);
  });

  it('handles 200,000 nested elements without recursion', () => {
    const depth = 200_000;
    const input = '<e>'.repeat(depth) + '</e>'.repeat(depth);
    let value = parseXmlToDict(input) as unknown;
    let levels = 0;
    while (value !== null && typeof value === 'object') {
      value = (value as Record<string, unknown>).e;
      levels += 1;
    }
    expect(levels).toBe(depth);
    // libxml2 stops at a depth of 256.
    const recovered = recoverXml(input).xml;
    expect(recovered).toBe(`${'<e>'.repeat(255)}<e/>${'</e>'.repeat(255)}`);
  });

  it('stays linear on a megabyte of "<" and of "&"', () => {
    // CPU time, generous: quadratic behavior would take minutes.
    const start = cpuStart();
    for (const char of ['<', '&', '<a ', '<!--', '<![CDATA[', '&#']) {
      const input = `<a>${char.repeat(Math.ceil(1_000_000 / char.length))}`;
      expect(() => parseXmlToDict(input)).toThrow(ExpatError);
      recoverXml(input);
    }
    expect(cpuMsSince(start)).toBeLessThan(30_000);
  });

  it('still applies attribute defaults from the internal subset', () => {
    const input = `<!DOCTYPE r [<!ATTLIST z a CDATA "1" b CDATA "2">]><r>${'<z b="x"/>'.repeat(3)}</r>`;
    expect(parseXmlToDict(input, { rejectDoctype: false })).toEqual({
      r: { z: Array.from({ length: 3 }, () => ({ '@b': 'x', '@a': '1' })) },
    });
  });

  it('rejects a DOCTYPE before reading its internal subset', () => {
    // GHSA-m47j-wp78-fqjg: 3,000 defaults on each of 3,000 four-byte tags
    // would be 9 million attributes from 63 KB, a "billion laughs" without
    // entities. The parse stops at the "[", so the cost is the prolog only.
    const attributes = Array.from(
      { length: 3000 },
      (_, index) => `a${index} CDATA "v"`,
    ).join(' ');
    const input = `<!DOCTYPE r [<!ATTLIST z ${attributes}>]><r>${'<z/>'.repeat(3000)}</r>`;
    const start = cpuStart();
    expect(() => parseXmlToDict(input)).toThrow(XmlDoctypeFound);
    expect(() => parseXmlToDict(input)).toThrow(
      'Aggregate reports must not contain a DOCTYPE declaration',
    );
    expect(cpuMsSince(start)).toBeLessThan(5000);
    // libxml2's recovery keeps the declaration: the tree has a DOCTYPE.
    expect(recoverXml(input)).toEqual({ hasDoctype: true, xml: '' });
  });

  it('calls the DOCTYPE handler where Expat does', () => {
    // At the "[" of an internal subset, or at the ">" without one; a DOCTYPE
    // Expat finds malformed first is an ExpatError.
    expect(() => parseXmlToDict('<!DOCTYPE a [<!ENTITY')).toThrow(
      XmlDoctypeFound,
    );
    expect(() => parseXmlToDict('<!DOCTYPE a><a/>')).toThrow(XmlDoctypeFound);
    expect(() => parseXmlToDict('<!DOCTYPE a junk><a/>')).toThrow(
      'syntax error: line 1, column 12',
    );
    expect(() => parseXmlToDict('<!DOCTYPE a SYSTEM')).toThrow(
      'no element found: line 1, column 18',
    );
    expect(() => parseXmlToDict("<?xml vers='1'?><!DOCTYPE a><a/>")).toThrow(
      'XML declaration not well-formed: line 1, column 6',
    );
  });

  it('reads long UTF-16 documents across block boundaries', () => {
    // A document whose first byte is NUL is read as UTF-16 big endian.
    const text = 'abc'.repeat(10_000);
    const ascii = `<a>${text}</a>`;
    const bigEndian = [...ascii].map(char => `\0${char}`).join('');
    expect(parseXmlToDict(bigEndian)).toEqual({ a: text });
    const littleEndian = [...ascii].map(char => `${char}\0`).join('');
    expect(parseXmlToDict(littleEndian)).toEqual({ a: text });
  });

  it('converts a large UTF-16 view in linear time', () => {
    // A NUL first byte makes 20 MB of text a UTF-16 view of 10 million units.
    const input = `\0${'a'.repeat(20_000_000)}`;
    const start = cpuStart();
    expect(() => parseXmlToDict(input)).toThrow(ExpatError);
    expect(cpuMsSince(start)).toBeLessThan(20_000);
  });

  it('joins text reported in many chunks', () => {
    // Expat reports each newline and entity as its own chunk.
    const pieces = Array.from({ length: 5000 }, (_, index) =>
      index % 2 === 0 ? `x${index}\n` : '&amp;',
    );
    const expected = pieces.join('').replaceAll('&amp;', '&').trim();
    expect(parseXmlToDict(`<a>${pieces.join('')}</a>`)).toEqual({
      a: expected,
    });
    expect(parseXmlToDict(`<a>${'\n'.repeat(3000)}</a>`)).toEqual({ a: null });
  });
});
