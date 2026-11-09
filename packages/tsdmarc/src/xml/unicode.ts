// Python's `str.encode("utf-8")` check, which runs before both pyexpat and
// lxml see the text: lone surrogates (possible in JavaScript strings, and in
// Python strings built with surrogateescape) cannot be encoded.

const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;
const LOW_SURROGATE_MIN = 0xdc_00;
const LOW_SURROGATE_MAX = 0xdf_ff;

/** Python's `UnicodeEncodeError` from `str.encode("utf-8")`. */
export class XmlUnicodeEncodeError extends Error {
  override name = 'UnicodeEncodeError';
}

/**
 * Throws Python's UnicodeEncodeError if `text` has lone surrogates. Positions
 * are in code points, and a run of consecutive surrogates is reported as one
 * range, like CPython's encoder.
 */
export function assertEncodableUtf8(text: string): void {
  // The common case, natively: no lone surrogate anywhere.
  if (text.isWellFormed()) {
    return;
  }
  let codePoint = 0;
  let runStart = -1;
  let runEnd = -1;
  let runFirst = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    const isPair =
      code >= HIGH_SURROGATE_MIN &&
      code <= HIGH_SURROGATE_MAX &&
      next >= LOW_SURROGATE_MIN &&
      next <= LOW_SURROGATE_MAX;
    const lone =
      !isPair && code >= HIGH_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
    if (lone) {
      if (runStart < 0) {
        runStart = codePoint;
        runFirst = code;
      }
      runEnd = codePoint;
    } else if (runStart >= 0) {
      break;
    }
    if (isPair) {
      index += 1;
    }
    codePoint += 1;
  }
  if (runStart < 0) {
    return;
  }
  const where =
    runStart === runEnd
      ? `character '\\u${runFirst.toString(16)}' in position ${runStart}`
      : `characters in position ${runStart}-${runEnd}`;
  throw new XmlUnicodeEncodeError(
    `'utf-8' codec can't encode ${where}: surrogates not allowed`,
  );
}
