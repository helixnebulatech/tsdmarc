// xmltodict.parse() with its default options (xmltodict 1.0.4), on top of the
// Expat port: the same dicts, lists, `@attr` / `#text` keys, whitespace
// stripping and errors as parsedmarc gets from Python. This module is the
// entry point of the XML layer; recoverXml() emulates parsedmarc's lxml
// fallback for malformed reports.

import { pyStrip } from '../utils/py-str';
import { expatParse } from './expat';
import { TextBuffer } from './text-buffer';
import { assertEncodableUtf8 } from './unicode';

export { ExpatError } from './expat';
export { recoverXml, type RecoveredXml } from './recover';
export { XmlUnicodeEncodeError } from './unicode';

/** A value in xmltodict's output. */
export type XmlValue = string | null | XmlObject | XmlValue[];

/** An element with attributes and/or children (a Python dict). */
export interface XmlObject {
  [key: string]: XmlValue;
}

/**
 * Python's `ValueError` that xmltodict raises (`"entities are disabled"`)
 * when the document declares an entity, before any could be expanded.
 */
export class XmlValueError extends Error {
  override name = 'ValueError';
}

/** parsedmarc's `_DOCTYPE_ERROR`. */
export const DOCTYPE_ERROR =
  'Aggregate reports must not contain a DOCTYPE declaration';

/**
 * parsedmarc's `_XMLDoctypeFound`: raised as soon as Expat reports the start
 * of a `<!DOCTYPE` declaration, before it reads the internal subset (whose
 * `<!ATTLIST>` defaults would otherwise be copied into every matching
 * element: GHSA-m47j-wp78-fqjg).
 */
export class XmlDoctypeFound extends Error {
  override name = '_XMLDoctypeFound';

  constructor() {
    super(DOCTYPE_ERROR);
  }
}

/**
 * The document is over `maxDepth` or `maxNodes`. Not in Python: there, memory
 * only runs out at the machine's limit and raises; a full V8 heap ends the
 * process. Unlike a syntax error, this is final: recovery must not try again.
 */
export class XmlLimitError extends Error {
  override name = 'XmlLimitError';
}

export interface ParseXmlOptions {
  /**
   * Abort on any DOCTYPE with {@link XmlDoctypeFound}, as parsedmarc's
   * `xmltodict.parse(xml, expat=_NoDoctypeExpat)` does. Default true; false
   * gives plain `xmltodict.parse(xml)` (used to check the Expat port).
   */
  rejectDoctype?: boolean;
  /** Most elements open at once; `0` or absent: no limit. */
  maxDepth?: number;
  /** Most elements and attributes in the document; `0` or absent: no limit. */
  maxNodes?: number;
}

function createObject(): XmlObject {
  // No prototype, so element names like "__proto__" or "constructor" are
  // plain keys.
  return Object.create(null) as XmlObject;
}

// _DictSAXHandler.push_data with no postprocessor / force_list.
function pushData(
  item: XmlObject | null,
  key: string,
  data: XmlValue,
): XmlObject {
  const target = item ?? createObject();
  if (Object.hasOwn(target, key)) {
    const existing = target[key] as XmlValue;
    if (Array.isArray(existing)) {
      existing.push(data);
    } else {
      target[key] = [existing, data];
    }
  } else {
    target[key] = data;
  }
  return target;
}

interface Frame {
  item: XmlObject | null;
  data: TextBuffer;
}

function raiseDoctypeFound(): never {
  throw new XmlDoctypeFound();
}

/**
 * Parse XML exactly like Python's `xmltodict.parse(text,
 * expat=_NoDoctypeExpat)` with otherwise default options, as parsedmarc calls
 * it. Throws {@link XmlDoctypeFound} on a DOCTYPE (unless `rejectDoctype` is
 * false), {@link ExpatError} for malformed XML (with Expat's message, line
 * and column), {@link XmlValueError} when the document declares entities, and
 * {@link XmlUnicodeEncodeError} for lone surrogates, and
 * {@link XmlLimitError} past `maxDepth` or `maxNodes`. Linear in the input
 * size. Nesting never overflows the call stack, but every open element costs
 * about 170 bytes of heap, so untrusted text needs the limits.
 */
export function parseXmlToDict(
  text: string,
  options: ParseXmlOptions = {},
): XmlObject | null {
  assertEncodableUtf8(text);
  const startDoctypeDecl =
    options.rejectDoctype === false ? undefined : raiseDoctypeFound;
  const maxDepth = options.maxDepth || Number.POSITIVE_INFINITY;
  const maxNodes = options.maxNodes || Number.POSITIVE_INFINITY;
  const stack: Frame[] = [];
  let nodes = 0;
  let item: XmlObject | null = null;
  let data = new TextBuffer();
  const countNode = (): void => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new XmlLimitError(
        `XML has more than ${maxNodes} elements and attributes`,
      );
    }
  };
  expatParse(text, {
    attribute: countNode,
    characterData(chunk: string): void {
      data.push(chunk);
    },
    endElement(name: string): void {
      const frame = stack.pop();
      if (!frame) {
        return;
      }
      let value = data.text();
      const element = item;
      ({ item, data } = frame);
      if (value) {
        value = pyStrip(value) || null;
      }
      if (element === null) {
        item = pushData(item, name, value);
      } else {
        if (value) {
          pushData(element, '#text', value);
        }
        item = pushData(item, name, element);
      }
    },
    entityDecl(): void {
      throw new XmlValueError('entities are disabled');
    },
    startDoctypeDecl,
    startElement(_name: string, attributes: string[]): void {
      countNode();
      if (stack.length >= maxDepth) {
        throw new XmlLimitError(`XML nests more than ${maxDepth} elements`);
      }
      stack.push({ data, item });
      let attrs: XmlObject | null = null;
      for (let index = 0; index < attributes.length; index += 2) {
        attrs ??= createObject();
        attrs[`@${attributes[index]}`] = attributes[index + 1] ?? '';
      }
      item = attrs;
      data = new TextBuffer();
    },
  });
  return item;
}
