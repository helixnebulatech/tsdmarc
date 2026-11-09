// Key conversion between the camelCase API and the snake_case output format.
//
// parsedmarc's JSON/CSV/Elasticsearch/... output uses snake_case keys, and the
// bundled dashboards query those names. tsdmarc's API uses camelCase, and
// every output integration converts at the boundary with `toSnakeCaseKeys()`.
//
// Values under an "opaque" key are copied without converting their keys:
// `headers` holds raw email header names ("Received", "X-Mailer") that are
// data, not field names.
//
// Report parsers also pass reporter data through untouched where parsedmarc
// does (an override reason dict, an `<identifiers>` child parsedmarc doesn't
// know, an SMTP TLS `contact-info` object). Such values are branded with
// `markRaw()` and objects mixing known fields with raw keys are built with
// `mixedObject()`, so the conversion never renames keys that are data
// (`<toString>` stays `toString`, `<envelopeFrom>` doesn't become
// `envelope_from`). The brands are non-enumerable symbols: a structured
// clone (worker_threads) drops them, so `parallel.ts` carries them across
// with `getRawMarks()`/`restoreRawMarks()`.

import { setOwn } from './internal/set-own';

const UPPERCASE_LETTER = /[A-Z]/gu;
const UNDERSCORE_LETTER = /_([a-z])/gu;
/** `ipAddress`, `sha256`: starts lowercase, letters and digits only. */
const CAMEL_KEY = /^[a-z][a-zA-Z0-9]*$/u;
/** `ip_address`: lowercase words joined by `_`, each starting with a letter. */
const SNAKE_KEY = /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+$/u;

const DEFAULT_OPAQUE_KEYS: ReadonlySet<string> = new Set(['headers']);

/** Brand of a value that is report data: no key inside it is converted. */
const RAW = Symbol('tsdmarc.raw');
/** On a mixed object: the own keys whose names and values are data. */
const RAW_KEYS = Symbol('tsdmarc.rawKeys');
/**
 * On a mixed object: raw entries whose key collides with a known camelCase
 * field (`<envelopeFrom>` next to `envelope_from`). JS can't hold both under
 * one name, so they only appear in the converted (snake_case) output.
 */
const SHADOWED_RAW_ENTRIES = Symbol('tsdmarc.shadowedRawEntries');

interface Branded {
  [RAW]?: true;
  [RAW_KEYS]?: ReadonlySet<string>;
  [SHADOWED_RAW_ENTRIES]?: readonly (readonly [string, unknown])[];
}

function brand(
  target: object,
  symbol: typeof RAW | typeof RAW_KEYS | typeof SHADOWED_RAW_ENTRIES,
  value: unknown,
): void {
  Object.defineProperty(target, symbol, { value, configurable: true });
}

/**
 * Mark a value taken verbatim from a report (parsed XML/JSON) so key
 * conversion copies it unchanged. Scalars are returned as they are.
 */
export function markRaw<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    brand(value, RAW, true);
  }
  return value;
}

/** One entry of {@link mixedObject}: a known field or a raw report key. */
export interface MixedEntry {
  key: string;
  value: unknown;
  /** True for a key from the report, kept verbatim (name and value). */
  raw: boolean;
}

/**
 * Build an object that holds known (camelCase) fields and raw report keys,
 * in output order. Key conversion renames only the known fields.
 */
export function mixedObject(
  entries: readonly MixedEntry[],
): Record<string, unknown> {
  const known = new Set(entries.filter(e => !e.raw).map(e => e.key));
  const result: Record<string, unknown> = {};
  const rawKeys = new Set<string>();
  const shadowed: [string, unknown][] = [];
  for (const { key, value, raw } of entries) {
    if (!raw) {
      setOwn(result, key, value);
    } else if (known.has(key)) {
      shadowed.push([key, markRaw(value)]);
    } else {
      rawKeys.add(key);
      setOwn(result, key, markRaw(value));
    }
  }
  brand(result, RAW_KEYS, rawKeys);
  if (shadowed.length > 0) {
    brand(result, SHADOWED_RAW_ENTRIES, shadowed);
  }
  return result;
}

/** The raw-data brands of one object, in a structured-clone-safe form. */
export interface RawMarks {
  /** Branded by {@link markRaw}. */
  raw: boolean;
  /** The raw keys of a {@link mixedObject}, or null. */
  rawKeys: string[] | null;
  /** The shadowed raw entries of a {@link mixedObject}, or null. */
  shadowed: [string, unknown][] | null;
}

/** The brands on `value`, or null when it has none. */
export function getRawMarks(value: object): RawMarks | null {
  const branded = value as Branded;
  const raw = branded[RAW] === true;
  const rawKeys = branded[RAW_KEYS];
  const shadowed = branded[SHADOWED_RAW_ENTRIES];
  if (!raw && rawKeys === undefined && shadowed === undefined) {
    return null;
  }
  return {
    raw,
    rawKeys: rawKeys === undefined ? null : [...rawKeys],
    shadowed:
      shadowed === undefined
        ? null
        : shadowed.map(([key, child]) => [key, child]),
  };
}

/** Put back the brands read by {@link getRawMarks} (after a structured clone). */
export function restoreRawMarks(value: object, marks: RawMarks): void {
  if (marks.raw) {
    markRaw(value);
  }
  if (marks.rawKeys !== null) {
    brand(value, RAW_KEYS, new Set(marks.rawKeys));
  }
  if (marks.shadowed !== null) {
    brand(
      value,
      SHADOWED_RAW_ENTRIES,
      marks.shadowed.map(([key, child]) => [key, markRaw(child)] as const),
    );
  }
}

/**
 * Convert one camelCase key to snake_case (`ipAddress` → `ip_address`).
 * Keys that aren't plain camelCase (`x-mailer`, `@lang`, `Header_From`) are
 * data from the report and are returned unchanged.
 */
export function camelToSnake(key: string): string {
  if (!CAMEL_KEY.test(key)) {
    return key;
  }
  return key.replace(UPPERCASE_LETTER, letter => `_${letter.toLowerCase()}`);
}

/**
 * Convert one snake_case key to camelCase (`ip_address` → `ipAddress`).
 * Keys that aren't plain snake_case are returned unchanged, so the two
 * functions are inverses for every key either produces.
 */
export function snakeToCamel(key: string): string {
  if (!SNAKE_KEY.test(key)) {
    return key;
  }
  return key.replace(UNDERSCORE_LETTER, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** How a value is copied by {@link convertKeys}. */
const CONVERT = 0;
/** Raw report data: copied without converting any key. */
const RAW_COPY = 1;
/** Under an opaque key: a structured clone. */
const OPAQUE = 2;
type CopyMode = typeof CONVERT | typeof RAW_COPY | typeof OPAQUE;

/** A child to copy: its key in the copy (null: appended to an array). */
type CopyEntry = readonly [key: string | null, child: unknown, mode: CopyMode];

/** A container being filled, with the children still to copy into it. */
interface CopyFrame {
  target: Record<string, unknown> | unknown[];
  entries: readonly CopyEntry[];
  index: number;
}

interface StartedCopy {
  copy: unknown;
  frame: CopyFrame | null;
}

/**
 * Start copying one value: scalars and other objects are copied (or kept)
 * at once; arrays and plain objects get an empty copy and a frame listing
 * the children to fill it with.
 */
function startCopy(
  value: unknown,
  requestedMode: CopyMode,
  convert: (key: string) => string,
  opaqueKeys: ReadonlySet<string>,
): StartedCopy {
  if (requestedMode === OPAQUE) {
    return { copy: structuredClone(value), frame: null };
  }
  let mode = requestedMode;
  let source = value;
  if (
    typeof source === 'object' &&
    source !== null &&
    (source as Branded)[RAW]
  ) {
    mode = RAW_COPY;
  }
  if (Array.isArray(source)) {
    const target: unknown[] = [];
    const entries = source.map(item => [null, item, mode] as const);
    return { copy: target, frame: { target, entries, index: 0 } };
  }
  if (mode === CONVERT && source instanceof Map) {
    source = Object.fromEntries(source);
  }
  if (!isPlainObject(source)) {
    return { copy: source, frame: null };
  }
  const target: Record<string, unknown> = {};
  const entries: CopyEntry[] = [];
  const rawKeys = mode === CONVERT ? (source as Branded)[RAW_KEYS] : undefined;
  for (const [key, child] of Object.entries(source)) {
    if (mode === RAW_COPY || rawKeys?.has(key)) {
      entries.push([key, child, RAW_COPY]);
    } else {
      entries.push([
        convert(key),
        child,
        opaqueKeys.has(key) ? OPAQUE : CONVERT,
      ]);
    }
  }
  if (mode === CONVERT) {
    for (const [key, child] of (source as Branded)[SHADOWED_RAW_ENTRIES] ??
      []) {
      entries.push([key, child, RAW_COPY]);
    }
  }
  return { copy: target, frame: { target, entries, index: 0 } };
}

/**
 * Deep-copy `value`, converting keys outside raw data. Iterative, so data
 * nested deeper than the call stack allows is still copied.
 */
function convertKeys(
  value: unknown,
  convert: (key: string) => string,
  opaqueKeys: ReadonlySet<string>,
): unknown {
  const root = startCopy(value, CONVERT, convert, opaqueKeys);
  const stack: CopyFrame[] = root.frame ? [root.frame] : [];
  let frame = stack.at(-1);
  while (frame) {
    const entry = frame.entries[frame.index];
    if (entry === undefined) {
      stack.pop();
      frame = stack.at(-1);
      continue;
    }
    frame.index += 1;
    const [key, child, mode] = entry;
    const started = startCopy(child, mode, convert, opaqueKeys);
    if (key === null) {
      (frame.target as unknown[]).push(started.copy);
    } else {
      // setOwn: a key from the data (an email header named `__proto__`)
      // must become an own property, not the prototype.
      setOwn(frame.target as Record<string, unknown>, key, started.copy);
    }
    if (started.frame) {
      stack.push(started.frame);
      frame = started.frame;
    }
  }
  return root.copy;
}

/**
 * Deep-copy `value`, converting every object key from camelCase to
 * snake_case, except inside values whose key is in `opaqueKeys`.
 */
export function toSnakeCaseKeys(
  value: unknown,
  opaqueKeys: ReadonlySet<string> = DEFAULT_OPAQUE_KEYS,
): unknown {
  return convertKeys(value, camelToSnake, opaqueKeys);
}

/**
 * Deep-copy `value`, converting every object key from snake_case to
 * camelCase, except inside values whose key is in `opaqueKeys`. The inverse of
 * {@link toSnakeCaseKeys}.
 */
export function toCamelCaseKeys(
  value: unknown,
  opaqueKeys: ReadonlySet<string> = DEFAULT_OPAQUE_KEYS,
): unknown {
  return convertKeys(value, snakeToCamel, opaqueKeys);
}

/**
 * The deepest nesting of objects and arrays a parsed report may hold.
 * parsedmarc keeps some reporter elements verbatim (unknown `<identifiers>`
 * children, a dict-shaped field), so their nesting reaches the output;
 * `JSON.stringify()`, `structuredClone()` and SDK serializers recurse and
 * would overflow the call stack on deep enough data. libxml2 (parsedmarc's
 * recovering parser) caps nesting at 256 elements; this allows at least that
 * much XML even when every level also adds a list of repeated elements.
 */
export const MAX_REPORT_DEPTH = 512;

/** Whether `item` is an array or a plain object. */
function isContainer(item: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(item);
  return (
    Array.isArray(item) || prototype === Object.prototype || prototype === null
  );
}

/**
 * Whether arrays and plain objects in `value` nest deeper than `limit`. The
 * day buckets of a record share its objects, so each one is walked once per
 * depth it is reached at, not once per reference.
 */
export function nestsDeeperThan(value: unknown, limit: number): boolean {
  // Iterative: the value may be too deep for recursion.
  const pending: [unknown, number][] = [[value, 0]];
  const deepestWalk = new Map<object, number>();
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [item, depth] = next;
    if (typeof item !== 'object' || item === null || !isContainer(item)) {
      continue;
    }
    if (depth >= limit) {
      return true;
    }
    if ((deepestWalk.get(item) ?? -1) >= depth) {
      continue;
    }
    deepestWalk.set(item, depth);
    for (const child of Object.values(item)) {
      pending.push([child, depth + 1]);
    }
    // Raw entries shadowed by a known field still reach the output.
    for (const [, child] of (item as Branded)[SHADOWED_RAW_ENTRIES] ?? []) {
      pending.push([child, depth + 1]);
    }
  }
  return false;
}

/** What {@link estimatedSize} charges for any value, besides its text. */
const VALUE_SIZE = 16;

/**
 * Roughly how many characters `value` takes in the outputs: the length of
 * its strings and keys, and a fixed amount for each value. Every reference
 * counts, as every copy reaches the output.
 */
export function estimatedSize(value: unknown): number {
  // Iterative: the value may be too deep for recursion.
  const pending: unknown[] = [value];
  let size = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    size += VALUE_SIZE;
    if (typeof item === 'string') {
      size += item.length;
    } else if (typeof item === 'object' && item !== null && isContainer(item)) {
      for (const [key, child] of Object.entries(item)) {
        size += key.length;
        pending.push(child);
      }
      for (const [key, child] of (item as Branded)[SHADOWED_RAW_ENTRIES] ??
        []) {
        size += key.length;
        pending.push(child);
      }
    }
  }
  return size;
}
