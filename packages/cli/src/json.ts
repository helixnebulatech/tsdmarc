// Python's `json.dumps(value, ensure_ascii=False, indent=indent)`, used for
// the CLI's printed output and webhook payloads.

import { pyJsonDumps as dumps } from 'tsdmarc';

/**
 * Serialize like Python's `json.dumps(value, ensure_ascii=False,
 * indent=indent)`: `", "`/`": "` separators without indentation, one item
 * per line with it. Integers beyond 2^53 (`bigint`s) are written exactly.
 */
export function pyJsonDumps(
  value: unknown,
  indent: number | null = null,
): string {
  return dumps(value, { ensureAscii: false, indent });
}
