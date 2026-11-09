// parsedmarc.utils.sanitize_for_log().

// Python's str.isprintable() is false for the categories Cc, Cf, Cs, Co, Cn
// (\p{C}) and Zs, Zl, Zp (\p{Z}), except the ASCII space. The Unicode version
// is the JS engine's (Python 3.14 uses 16.0), so a code point assigned in a
// newer version counts as printable here and as unassigned there.
const NON_PRINTABLE = /[\p{C}\p{Z}]/gu;

const SHORT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\t', '\\t'],
  ['\n', '\\n'],
  ['\r', '\\r'],
]);

const LATIN1_MAX = 0xff;
const BMP_MAX = 0xff_ff;

// Python's `unicode_escape` codec for one character.
function unicodeEscape(char: string): string {
  if (char === ' ') {
    return char;
  }
  const short = SHORT_ESCAPES.get(char);
  if (short !== undefined) {
    return short;
  }
  const code = char.codePointAt(0) ?? 0;
  if (code <= LATIN1_MAX) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  if (code <= BMP_MAX) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `\\U${code.toString(16).padStart(8, '0')}`;
}

/**
 * Escapes the non-printable characters of a sender-controlled string so it
 * is safe to put in a log line or an error message.
 *
 * Every character for which Python's `str.isprintable()` is false (CR, LF,
 * tab, ESC, U+2028, NUL, and so on) is replaced by its `unicode_escape`
 * form, e.g. `\r\n`. A sender can plant such characters in a header through
 * an RFC 2047 encoded-word (`=?utf-8?q?a=0D=0Ab?=` decodes to a raw CR LF),
 * and an unescaped CR/LF would let it forge extra log lines. The ASCII
 * space, letters in any script, and most emoji pass through unchanged;
 * non-ASCII spaces (NBSP, U+3000) and format characters such as the
 * zero-width joiner or the bidi marks are escaped.
 */
export function sanitizeForLog(value: string): string {
  return value.replaceAll(NON_PRINTABLE, unicodeEscape);
}
