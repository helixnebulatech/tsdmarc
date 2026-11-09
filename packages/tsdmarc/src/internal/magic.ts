// Magic bytes parsedmarc uses to tell report formats apart
// (parsedmarc/__init__.py: MAGIC_ZIP, MAGIC_GZIP, MAGIC_XML, ...).

/** `PK\x03\x04`: a zip archive (local file header). */
export const MAGIC_ZIP: readonly number[] = [0x50, 0x4b, 0x03, 0x04];
/** `\x1f\x8b`: a gzip stream. */
export const MAGIC_GZIP: readonly number[] = [0x1f, 0x8b];
/** `<?xml `: XML with a declaration. */
export const MAGIC_XML: readonly number[] = [
  0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20,
];
/** `<`: XML that starts with an element tag (no declaration). */
export const MAGIC_XML_TAG: readonly number[] = [0x3c];
/** `{`: a JSON object (RFC 8259). */
export const MAGIC_JSON: readonly number[] = [0x7b];

/** Python's `data.startswith(magic)` / `data[: len(magic)] == magic`. */
export function startsWith(
  data: Uint8Array,
  magic: readonly number[],
): boolean {
  if (data.length < magic.length) {
    return false;
  }
  return magic.every((byte, index) => data[index] === byte);
}
