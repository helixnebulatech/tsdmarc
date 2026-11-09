// Masking of credentials in URLs before they reach a log line or an error
// message (parsedmarc's `redact_url_credentials()` and its helpers).

const AUTHORITY_END = /[/?#]/u;
/** Characters that can't come before the `://` of a scheme separator. */
const NOT_BEFORE_SCHEME_SEPARATOR = /[/?#@:]/u;

/** Where the userinfo of one URL or host string is (see {@link findUrlUserinfo}). */
interface UrlUserinfo {
  /** Offset of the userinfo. */
  start: number;
  /** Offset of the `@` after it. */
  at: number;
  /**
   * Whether that `@` is inside the authority and no other `@` follows it,
   * so the userinfo can only be what precedes it.
   */
  inAuthority: boolean;
}

/**
 * Locates the userinfo of one URL or host string (parsedmarc's
 * `_find_url_userinfo()`), shared by {@link redactUrlCredentials} and
 * {@link urlSecrets} so the two can't disagree about where the credentials
 * are. String methods only: linear in the length of `value`, never throws.
 *
 * The authority starts after the first `://` when nothing before it could
 * end an authority (so a URL quoted in free text is found too), after a
 * leading `//`, or at offset 0 (a bare `user:secret@host:9200` host
 * entry). parsedmarc accepts a `:` before the `://`, so in
 * `user:p://w@host` it reads `w` as the userinfo and keeps `p`; here that
 * `://` is not a scheme separator.
 *
 * The `@` used is the last one of the whole value: a password may contain
 * `@`, and an unencoded `/`, `?` or `#` in it ends the authority early
 * (RFC 3986 section 3.2), as in `https://admin:p4ss/w0rd@host`. parsedmarc
 * uses the last `@` of the authority when there is one, so it keeps
 * `ss/word` of `https://user:p@ss/word@host` and the credentials in
 * `https://a:b@host/?redirect=https://u:p@evil`; here both are masked
 * through the last `@`.
 */
function findUrlUserinfo(value: string): UrlUserinfo | null {
  let start = 0;
  const schemeEnd = value.indexOf('://');
  if (
    schemeEnd !== -1 &&
    !NOT_BEFORE_SCHEME_SEPARATOR.test(value.slice(0, schemeEnd))
  ) {
    start = schemeEnd + 3;
  } else if (value.startsWith('//')) {
    start = 2;
  }
  const at = value.lastIndexOf('@');
  if (at < start) {
    return null;
  }
  const delimiter = value.slice(start).search(AUTHORITY_END);
  const end = delimiter === -1 ? value.length : start + delimiter;
  return { start, at, inAuthority: at < end };
}

function redactOne(value: string): string {
  const found = findUrlUserinfo(value);
  if (found === null) {
    return value;
  }
  const { start, at, inAuthority } = found;
  if (!inAuthority) {
    // Which "/", "?" or "#" ended the authority is unknown, so mask
    // everything through the "@" rather than guess where the user name
    // stops.
    return `${value.slice(0, start)}***${value.slice(at)}`;
  }
  const userinfo = value.slice(start, at);
  const colon = userinfo.indexOf(':');
  const masked = colon === -1 ? '***' : `${userinfo.slice(0, colon)}:***`;
  return `${value.slice(0, start)}${masked}${value.slice(at)}`;
}

/**
 * Masks the credentials in a URL or host string so it is safe to log
 * (parsedmarc's `redact_url_credentials()`): the password, after the first
 * `:` of the userinfo, becomes `***` (`https://user:***@host:9200`), and a
 * userinfo without `:` (a bare token) is replaced whole
 * (`https://***@host`). When the last `@` is past the end of the authority
 * (a `/`, `?` or `#` in the password, or an `@` in the path or query),
 * everything from the start of the authority through that `@` is masked
 * (`https://admin:p4ss/w0rd@host:3100` becomes `https://***@host:3100`;
 * `https://host/path@file` becomes `https://***@file`).
 *
 * One URL per string: split a comma-separated list first, or pass an
 * array, which is masked element by element into a new array (non-string
 * items are kept). Never throws.
 */
export function redactUrlCredentials(value: string): string;
export function redactUrlCredentials<T>(value: readonly T[]): T[];
export function redactUrlCredentials(
  value: string | readonly unknown[],
): string | unknown[] {
  if (typeof value === 'string') {
    return redactOne(value);
  }
  return value.map(item => (typeof item === 'string' ? redactOne(item) : item));
}

/**
 * The secret text in one URL or host string's userinfo (parsedmarc's
 * `_url_secrets()`): the userinfo after its first `:`, or all of it when
 * it has none, and, when that contains a `/`, `?` or `#`, also its text
 * before the first of them (URL parsers read it as the port and quote it
 * in their errors). Longest first; never empty strings.
 */
export function urlSecrets(value: string): string[] {
  const found = findUrlUserinfo(value);
  if (found === null) {
    return [];
  }
  const userinfo = value.slice(found.start, found.at);
  const colon = userinfo.indexOf(':');
  const secret = colon === -1 ? userinfo : userinfo.slice(colon + 1);
  const prefixEnd = secret.search(AUTHORITY_END);
  const prefix = prefixEnd === -1 ? secret : secret.slice(0, prefixEnd);
  return [...new Set([secret, prefix])].filter(text => text !== '');
}

/**
 * Masks the credentials of the configured nameserver URLs in free text
 * such as an error message (parsedmarc's `_mask_nameserver_secrets()`):
 * each entry is replaced by its masked form, and each of its
 * {@link urlSecrets} by `***` wherever it still appears. A short secret
 * masks every occurrence of that text. Never throws.
 */
export function maskNameserverSecrets(
  text: string,
  nameservers: readonly string[] | null | undefined,
): string {
  let masked = text;
  for (const entry of nameservers ?? []) {
    masked = masked.replaceAll(entry, redactOne(entry));
    for (const secret of urlSecrets(entry)) {
      masked = masked.replaceAll(secret, '***');
    }
  }
  return masked;
}
