// The parts of elasticsearch-dsl / opensearch-dsl that parsedmarc relies on.
//
// parsedmarc declares its documents as DSL `Document`/`InnerDoc` classes.
// It never installs their mappings (create_indexes() deliberately creates
// bare indexes), but the classes still decide what a saved document looks
// like: `Document.save()` cleans every declared field (`Integer` → int,
// `Ip` → validated canonical address, `Date` → datetime) and serializes with
// `to_dict(skip_empty=True)`, which drops `None`, `[]` and `{}` values at
// each object level. This module reproduces that from a field schema, and
// renders the schema as the mapping the DSL classes declare.
//
// Shared by @tsdmarc/elasticsearch and @tsdmarc/opensearch, which both bundle
// it.

import {
  logger,
  parseDate,
  PyDateTime,
  pyRepr,
  pyStr,
  sanitizeForLog,
} from 'tsdmarc';

import { normalizeIpAddress } from './ip';
import { errorMessage, pyBool, pyInt, setOwn, ValueError } from './python';

export type ScalarFieldType =
  | 'boolean'
  | 'date'
  | 'integer'
  | 'ip'
  | 'keyword'
  | 'text';

export interface SubField {
  readonly type: 'keyword';
  readonly ignore_above?: number;
}

export interface ScalarField {
  readonly type: ScalarFieldType;
  /** Multi-fields, such as `.keyword` on the `*_combined` text fields. */
  readonly fields?: Readonly<Record<string, SubField>>;
}

export interface ObjectField {
  readonly type: 'nested' | 'object';
  /** Declared inner fields; `undefined` for a dynamic `Object()`. */
  readonly properties?: DocumentSchema;
  /**
   * The mapping {@link indexMapping} installs for this field, beyond what
   * the DSL class declares (see `FAILURE_SAMPLE_DOC.headers`).
   */
  readonly indexMapping?: Readonly<Record<string, unknown>>;
}

export type Field = ObjectField | ScalarField;

/** Declared fields of a document, in declaration order. */
export type DocumentSchema = Readonly<Record<string, Field>>;

export interface IndexMapping {
  readonly date_detection: boolean;
  readonly properties: Record<string, unknown>;
}

const MS_PER_SECOND = 1000;

function isObjectField(field: Field): field is ObjectField {
  return field.type === 'object' || field.type === 'nested';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `value in ([], {}, None)`: what `to_dict(skip_empty=True)` leaves out. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/** The DSL's `Date._deserialize`, then the JSON serializer's `isoformat()`. */
function serializeDate(value: unknown): string {
  if (value instanceof PyDateTime) {
    return value.isoformat();
  }
  if (typeof value === 'string') {
    return parseDate(value).isoformat();
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    // datetime.utcfromtimestamp(value / 1000.0): naive UTC wall clock.
    return PyDateTime.fromTimestamp(value / MS_PER_SECOND, true)
      .withOffset(null)
      .isoformat();
  }
  throw new ValueError(
    `Could not parse date from the value (${pyRepr(value)})`,
  );
}

/**
 * A report value as a text field holds it. The parser leaves an element with
 * children as an object; left alone it would map the field as an object in
 * the index (rejecting every later text value) and turn into parameters of
 * the duplicate search.
 */
export function textValue(value: unknown): unknown {
  return isPlainObject(value) ? pyStr(value) : value;
}

/**
 * `value`, or `null` with a warning when `clean` rejects it. For values a
 * sender controls and the parser accepts: the DSL's ValueError would fail the
 * save of the whole report on every retry, for one field nothing depends on.
 */
function validOrNull(
  value: unknown,
  field: string,
  clean: (value: unknown) => unknown,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    clean(value);
    return value;
  } catch (error) {
    if (!(error instanceof ValueError)) {
      throw error;
    }
    logger.warning(
      `Dropping ${field} from a report: ${sanitizeForLog(errorMessage(error))}`,
    );
    return null;
  }
}

/** `value` if an `Ip()` field can hold it, otherwise `null` (see above). */
export function ipOrNull(value: unknown, field: string): unknown {
  return validOrNull(value, field, item => normalizeIpAddress(String(item)));
}

/** `value` if an `Integer()` field can hold it, otherwise `null` (see above). */
export function integerOrNull(value: unknown, field: string): unknown {
  return validOrNull(value, field, pyInt);
}

function serializeScalar(field: ScalarField, value: unknown): unknown {
  switch (field.type) {
    case 'integer':
      return pyInt(value);
    case 'boolean':
      return value === 'false' ? false : pyBool(value);
    case 'date':
      return serializeDate(value);
    case 'ip':
      return normalizeIpAddress(String(value));
    default:
      return textValue(value);
  }
}

function serializeOne(field: Field, value: unknown): unknown {
  if (isObjectField(field)) {
    // A raw dict is wrapped in an InnerDoc of the declared class (or a
    // dynamic one for a bare Object()) and serialized the same way.
    return isPlainObject(value)
      ? serializeDocument(field.properties ?? {}, value)
      : value;
  }
  return serializeScalar(field, value);
}

function serializeField(field: Field, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item =>
      item === null || item === undefined ? null : serializeOne(field, item),
    );
  }
  return serializeOne(field, value);
}

/**
 * Clean and serialize a document like `Document.save()` does: declared
 * fields are converted to their type, undeclared fields are kept as they
 * are, and empty values are dropped. Throws like the DSL does for values a
 * field cannot hold (an invalid IP address, a non-numeric integer), except
 * objects in text fields (see {@link textValue}).
 */
export function serializeDocument(
  schema: DocumentSchema,
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined;
    const serialized =
      field === undefined || value === null || value === undefined
        ? value
        : serializeField(field, value);
    if (!isEmptyValue(serialized)) {
      setOwn(out, key, serialized);
    }
  }
  return out;
}

function fieldMapping(field: Field): Record<string, unknown> {
  if (isObjectField(field)) {
    if (field.properties === undefined) {
      return { type: field.type };
    }
    return { ...schemaMapping(field.properties), type: field.type };
  }
  const mapping: Record<string, unknown> = { type: field.type };
  if (field.fields !== undefined) {
    mapping.fields = structuredClone(field.fields);
  }
  return mapping;
}

/** The mapping a DSL class declares (`Document._doc_type.mapping.to_dict()`). */
export function schemaMapping(schema: DocumentSchema): {
  properties: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    properties[name] = fieldMapping(field);
  }
  return { properties };
}

function indexProperties(schema: DocumentSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    if (field.type === 'date') {
      properties[name] = { type: 'date' };
    } else if (isObjectField(field) && field.indexMapping !== undefined) {
      properties[name] = structuredClone(field.indexMapping);
    } else if (field.type === 'object' && field.properties !== undefined) {
      const inner = indexProperties(field.properties);
      if (Object.keys(inner).length > 0) {
        properties[name] = { properties: inner };
      }
    }
  }
  return properties;
}

/**
 * The field parsedmarc 11.2 adds to every saved document: the date that
 * picks the dated index (or that a data stream sorts by). Not declared on
 * the DSL classes, so it is serialized as given (an ISO 8601 string).
 */
export const TIMESTAMP_FIELD = '@timestamp';

/**
 * What the index template of a data stream maps without other mappings
 * (parsedmarc's `create_data_streams()`): only {@link TIMESTAMP_FIELD}.
 */
export const TIMESTAMP_MAPPING: {
  readonly properties: Readonly<Record<string, unknown>>;
} = {
  properties: { [TIMESTAMP_FIELD]: { type: 'date' } },
};

/**
 * The mappings of an index the save functions create: the declared date
 * fields, and date detection off. Otherwise the first document of an index
 * decides whether a text field is a date (`<report_id>2026-11-01</report_id>`),
 * and the index name comes from a date the sender picks too, so one report can
 * break the indexes of days to come. Plus the `indexMapping` of object fields
 * that carry one. Nothing else is declared: the dashboards need the dynamic
 * `object` mapping of the rest (see `createIndexes()`). With date detection
 * off, `@timestamp` is declared too (see {@link TIMESTAMP_FIELD}).
 */
export function indexMapping(schema: DocumentSchema): IndexMapping {
  return {
    date_detection: false,
    properties: { ...TIMESTAMP_MAPPING.properties, ...indexProperties(schema) },
  };
}

/**
 * The mappings of a data stream's index template: `mappings` (such as the
 * ones the save functions create dated indexes with) with
 * {@link TIMESTAMP_FIELD} as a date, which a data stream requires, or only
 * that field.
 */
export function dataStreamMapping(
  mappings: IndexMapping | null,
): Record<string, unknown> {
  if (mappings === null) {
    return structuredClone(TIMESTAMP_MAPPING);
  }
  return {
    ...structuredClone(mappings),
    properties: {
      ...structuredClone(mappings.properties),
      ...structuredClone(TIMESTAMP_MAPPING.properties),
    },
  };
}

/** A query clause, as the DSL's `Q()` renders it. */
export type Query = Record<string, unknown>;

/**
 * `q1 & q2 & ...`: the DSL combines queries into one `bool.must` list; a
 * single query stays as it is.
 */
export function andQueries(queries: readonly Query[]): Query {
  const [first] = queries;
  if (queries.length === 1 && first !== undefined) {
    return first;
  }
  return { bool: { must: [...queries] } };
}

/** Append to a list field, creating it on first use (an `AttrList`). */
export function appendTo(
  doc: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const current = doc[key];
  if (Array.isArray(current)) {
    current.push(value);
  } else {
    doc[key] = [value];
  }
}
