// recoverXml() writes the output while parsing (no tree): cases where the
// serialization depends on state kept across nodes. Expected values come from
// lxml 6.1 (etree.tostring(root, encoding="unicode") of an
// XMLParser(recover=True, resolve_entities=False) parse, as parsedmarc 11.1.0
// does).

import { describe, expect, it } from 'vitest';

import { cpuMsSince, cpuStart } from '../test/cpu-time';
import { recoverXml } from './recover';

const REPORT_RECORD =
  '<record><row><source_ip>1.2.3.4</source_ip><count>1</count></row></record>\n';

describe('recoverXml streaming serialization', () => {
  it.each([
    [
      'an empty CDATA section keeps the element open',
      '<a><![CDATA[]]></a>',
      '<a></a>',
    ],
    [
      'text pieces merge around references',
      '<a>x&amp;y<![CDATA[z]]>&#65;</a>',
      '<a>x&amp;yzA</a>',
    ],
    [
      'elements still open at the end are closed',
      "<a><b>t<c x='1'><d/>",
      '<a><b>t<c x="1"><d/></c></b></a>',
    ],
    [
      'comments and PIs outside the root element are left out',
      '<!--c--><?p q?><a>t<!--in--><?r s?></a><!--after--><?z?>',
      '<a>t<!--in--><?r s?></a>',
    ],
    [
      'namespace declarations precede attributes',
      "<a b='1' xmlns:p='u' xmlns='v'><p:c/></a>",
      '<a xmlns:p="u" xmlns="v" b="1"><p:c/></a>',
    ],
    [
      'non-ASCII names, text and comments are written as is',
      "<é aé='é'>é\u{1F600}<!--é--></é>",
      '<é aé="é">é\u{1F600}<!--é--></é>',
    ],
    [
      'control characters from references become U+FFFD references',
      "<a b='&#1;'>&#31;x</a>",
      '<a b="&#xFFFD;">&#xFFFD;x</a>',
    ],
  ])('%s', (_name, input, expected) => {
    expect(recoverXml(input)).toEqual({ hasDoctype: false, xml: expected });
  });

  it.each([
    ["<!--c--><!DOCTYPE a [<!ENTITY e 'v'>]><?p q?><a>&e;</a>"],
    ['<!DOCTYPE b><a/>'],
    // libxml2 creates the internal subset even without a name.
    ['<!DOCTYPE><a/>'],
  ])('reports the DOCTYPE of %j', input => {
    expect(recoverXml(input)).toEqual({ hasDoctype: true, xml: '' });
  });

  it('finds no root after a DOCTYPE it cannot finish', () => {
    expect(recoverXml('<!DOCTYPE a junk><a/>')).toEqual({
      hasDoctype: false,
      xml: '',
    });
  });

  it('writes non-ASCII text across output blocks', () => {
    // Over one output block (1 MiB) of multi-byte characters.
    const body = 'é😀'.repeat(300_000);
    expect(recoverXml(`<a>${body}</a><`).xml).toBe(`<a>${body}</a>`);
  });

  it('gives "<a/>" for a surrogate reference, unless a DOCTYPE comes first', () => {
    expect(recoverXml('<a>&#xD800;<b>').xml).toBe('<a/>');
    expect(
      recoverXml("<!DOCTYPE a [<!ATTLIST a x CDATA '&#xD800;'>]><a/>"),
    ).toEqual({ hasDoctype: true, xml: '' });
  });

  it('recovers a large report with a trailing "<"', () => {
    // Larger than one output block (1 MiB).
    const body = REPORT_RECORD.repeat(30_000);
    expect(recoverXml(`<feedback>${body}</feedback><`).xml).toBe(
      `<feedback>${body}</feedback>`,
    );
  });
});

// Expected values from lxml 6.1 / libxml2 2.14: past 256 groups the
// declaration fails where it stands, so the rest decides the outcome.
describe('recoverXml DTD content models', () => {
  const model = (open: number, rest: string): string =>
    `<?xml x?><!DOCTYPE a [<!ELEMENT a ${'('.repeat(open)}${rest}`;
  const closed = (depth: number, tail: string): string =>
    model(depth, `b${')'.repeat(depth)}>${tail}`);

  it.each([
    ['256 groups', closed(256, ']><a/>'), { hasDoctype: true, xml: '' }],
    ['257 groups', closed(257, ']><a/>'), { hasDoctype: false, xml: '' }],
    ['5000 groups', closed(5000, ']><a/>'), { hasDoctype: false, xml: '' }],
    ['256 unclosed', model(256, ']><a/>'), { hasDoctype: true, xml: '' }],
    ['257 unclosed', model(257, ']><a/>'), { hasDoctype: true, xml: '' }],
    ['300 unclosed', model(300, ']><a/>'), { hasDoctype: false, xml: '' }],
  ])('%s', (_name, input, expected) => {
    expect(recoverXml(input)).toEqual(expected);
  });

  it('stays linear on nested groups and groups of many items', () => {
    const size = 2_000_000;
    const start = cpuStart();
    recoverXml(model(size, ''));
    recoverXml(`<!DOCTYPE a [<!ELEMENT a (${'b,'.repeat(size)}b)>]><a/>`);
    recoverXml(
      `<!DOCTYPE a [<!ELEMENT a ${'(b,'.repeat(200)}${'c,'.repeat(size)}c${')'.repeat(200)}>]><a/>`,
    );
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });

  it('does not build attribute declarations', () => {
    const name = 'e'.repeat(500_000);
    const attributes = Array.from(
      { length: 20_000 },
      (_, index) => ` a${index} ID #IMPLIED`,
    ).join('');
    const start = cpuStart();
    expect(
      recoverXml(`<?xml x?><!DOCTYPE a [<!ATTLIST ${name}${attributes}>]><a/>`),
    ).toEqual({ hasDoctype: true, xml: '' });
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });
});

describe('recoverXml attribute values', () => {
  it.each([
    [
      'tabs and newlines become spaces',
      "<a b='x\ty\nz\r\nw'/>",
      '<a b="x y z w"/>',
    ],
    ['references split runs', "<a b='x&amp;y&#65;z'/>", '<a b="x&amp;yAz"/>'],
    ['non-BMP characters', "<a b='x\u{1F600}y'/>", '<a b="x\u{1F600}y"/>'],
    ['an empty value', "<a b=''/>", '<a b=""/>'],
    ['control characters', "<a b='x\u0001y'/>", '<a b="x\uFFFDy"/>'],
    ['the noncharacter U+FFFE', "<a b='x\uFFFEy'/>", '<a b="x\uFFFEy"/>'],
    ['a "<" in the value', "<a b='x<y'/>", '<a b="x&lt;y"/>'],
  ])('%s', (_name, input, expected) => {
    expect(recoverXml(input)).toEqual({ hasDoctype: false, xml: expected });
  });

  it('keeps memory close to the size of an unclosed value', () => {
    // 32 bytes of rope per character would take 960 MB.
    const input = `<feedback a="${'x'.repeat(30_000_000)}`;
    const before = process.memoryUsage().heapUsed;
    expect(recoverXml(input).hasDoctype).toBe(false);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(
      200 * 1024 * 1024,
    );
  });
});
