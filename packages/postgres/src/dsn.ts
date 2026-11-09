// libpq connection strings.
//
// psycopg passes connection strings to libpq, which accepts URIs
// (`postgresql://user@host/db?sslmode=require`) and `key=value` pairs
// (`host=db dbname=dmarc sslmode=require`). Both are parsed here into libpq
// keyword/value parameters; `connection.ts` turns them into pg options with
// libpq's semantics (pg-connection-string reads `sslmode` differently).

import { redactUrlCredentials } from 'tsdmarc';

const URI_PREFIXES = ['postgresql://', 'postgres://'] as const;
/** Any URI, to tell a wrong scheme from `key=value` pairs. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/** A `key=value` pair of a libpq connection string. */
export interface ConnectionParameter {
  keyword: string;
  value: string;
}

/**
 * Parse libpq's `keyword = value` syntax: values are single-quoted (with
 * `\'` and `\\` escapes) or a run of non-space characters.
 *
 * @throws {Error} With libpq's message for malformed input.
 */
export function parseKeywordValueString(dsn: string): ConnectionParameter[] {
  const parameters: ConnectionParameter[] = [];
  let index = 0;
  const skipSpaces = (): void => {
    while (index < dsn.length && WHITESPACE.has(dsn.charAt(index))) {
      index += 1;
    }
  };
  while (true) {
    skipSpaces();
    if (index >= dsn.length) {
      return parameters;
    }
    let keyword = '';
    while (
      index < dsn.length &&
      dsn.charAt(index) !== '=' &&
      !WHITESPACE.has(dsn.charAt(index))
    ) {
      keyword += dsn.charAt(index);
      index += 1;
    }
    skipSpaces();
    if (dsn.charAt(index) !== '=') {
      // libpq quotes the token, which is part of a password when the value
      // has an unquoted space: only a real keyword is shown.
      const shown = LIBPQ_KEYWORDS.has(keyword) ? `"${keyword}"` : 'keyword';
      throw new Error(`missing "=" after ${shown} in connection info string`);
    }
    index += 1;
    skipSpaces();
    let value = '';
    if (dsn.charAt(index) === "'") {
      index += 1;
      let terminated = false;
      while (index < dsn.length) {
        const char = dsn.charAt(index);
        if (char === '\\' && index + 1 < dsn.length) {
          value += dsn.charAt(index + 1);
          index += 2;
        } else if (char === "'") {
          index += 1;
          terminated = true;
          break;
        } else {
          value += char;
          index += 1;
        }
      }
      if (!terminated) {
        throw new Error('unterminated quoted string in connection info string');
      }
    } else {
      while (index < dsn.length && !WHITESPACE.has(dsn.charAt(index))) {
        const char = dsn.charAt(index);
        if (char === '\\' && index + 1 < dsn.length) {
          value += dsn.charAt(index + 1);
          index += 2;
        } else {
          value += char;
          index += 1;
        }
      }
    }
    parameters.push({ keyword, value });
  }
}

/** Every keyword libpq 18 accepts (`PQconndefaults()`). */
export const LIBPQ_KEYWORDS: ReadonlySet<string> = new Set([
  'service',
  'user',
  'password',
  'passfile',
  'channel_binding',
  'connect_timeout',
  'dbname',
  'host',
  'hostaddr',
  'port',
  'client_encoding',
  'options',
  'application_name',
  'fallback_application_name',
  'keepalives',
  'keepalives_idle',
  'keepalives_interval',
  'keepalives_count',
  'tcp_user_timeout',
  'sslmode',
  'sslnegotiation',
  'sslcompression',
  'sslcert',
  'sslkey',
  'sslcertmode',
  'sslpassword',
  'sslrootcert',
  'sslcrl',
  'sslcrldir',
  'sslsni',
  'requirepeer',
  'require_auth',
  'min_protocol_version',
  'max_protocol_version',
  'ssl_min_protocol_version',
  'ssl_max_protocol_version',
  'gssencmode',
  'krbsrvname',
  'gsslib',
  'gssdelegation',
  'replication',
  'target_session_attrs',
  'load_balance_hosts',
  'scram_client_key',
  'scram_server_key',
  'oauth_issuer',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_scope',
  'sslkeylogfile',
]);

/** Keywords whose values never appear in error messages. */
const SECRET_KEYWORDS = new Set([
  'password',
  'sslpassword',
  'oauth_client_secret',
  'scram_client_key',
  'scram_server_key',
]);

const REDACTED = '***';

/**
 * libpq's percent-decoding of URI parts (`+` stays a plus sign). `shown` is
 * what the error message quotes: libpq echoes the token, and a password with
 * an unencoded `/` makes any later part of the URI a piece of the password,
 * so only values of known, non-secret keywords are echoed.
 */
function uriDecode(text: string, shown = REDACTED): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new Error(`invalid percent-encoded token: "${shown}"`);
  }
}

/** Split `host[:port]` or `[ipv6][:port]` of a URI. */
function splitHostPort(hostPort: string, fullUri: string): [string, string] {
  // libpq quotes the whole URI in these errors; never with its password.
  const uri = redactUrlCredentials(fullUri);
  if (!hostPort.startsWith('[')) {
    const colon = hostPort.indexOf(':');
    return colon === -1
      ? [hostPort, '']
      : [hostPort.slice(0, colon), hostPort.slice(colon + 1)];
  }
  const close = hostPort.indexOf(']');
  if (close === -1) {
    throw new Error(
      `end of string reached when looking for matching "]" in IPv6 host address in URI: "${uri}"`,
    );
  }
  const after = hostPort.slice(close + 1);
  if (after !== '' && !after.startsWith(':')) {
    throw new Error(
      `unexpected character "${after.charAt(0)}" in URI (expected ":" or "/"): "${uri}"`,
    );
  }
  return [hostPort.slice(1, close), after.slice(1)];
}

/** Parse the `?keyword=value&...` part of a URI into `parameters`. */
function parseUriQuery(query: string, parameters: Map<string, string>): void {
  for (const pair of query.split('&')) {
    if (pair === '') {
      continue;
    }
    const equals = pair.indexOf('=');
    if (equals === -1) {
      throw new Error('missing key/value separator "=" in URI query parameter');
    }
    let keyword = uriDecode(pair.slice(0, equals));
    const rawValue = pair.slice(equals + 1);
    let value = uriDecode(
      rawValue,
      LIBPQ_KEYWORDS.has(keyword) && !SECRET_KEYWORDS.has(keyword)
        ? rawValue
        : REDACTED,
    );
    if (keyword === 'ssl' && value === 'true') {
      keyword = 'sslmode';
      value = 'require';
    }
    if (!LIBPQ_KEYWORDS.has(keyword)) {
      throw new Error('invalid URI query parameter: not a libpq keyword');
    }
    parameters.set(keyword, value);
  }
}

/**
 * Parse a libpq URI like `PQconninfoParse()`:
 * `postgresql://[user[:password]@][host][:port][/dbname][?keyword=value&...]`.
 * Parts are percent-decoded; `ssl=true` is libpq's alias of `sslmode=require`.
 * Like libpq, the credentials end at the first `@` before any `/`, so a
 * password may hold a `?`.
 */
function parseUri(uri: string, prefix: string): Map<string, string> {
  const parameters = new Map<string, string>();
  let rest = uri.slice(prefix.length);
  const credentialsEnd = rest.search(/[@/]/u);
  if (credentialsEnd !== -1 && rest.charAt(credentialsEnd) === '@') {
    const userInfo = rest.slice(0, credentialsEnd);
    rest = rest.slice(credentialsEnd + 1);
    const colon = userInfo.indexOf(':');
    const user = colon === -1 ? userInfo : userInfo.slice(0, colon);
    if (user !== '') {
      parameters.set('user', uriDecode(user));
    }
    if (colon !== -1) {
      parameters.set('password', uriDecode(userInfo.slice(colon + 1)));
    }
  }
  const queryStart = rest.indexOf('?');
  const query = queryStart === -1 ? '' : rest.slice(queryStart + 1);
  if (queryStart !== -1) {
    rest = rest.slice(0, queryStart);
  }
  const pathStart = rest.indexOf('/');
  const hostPort = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const path = pathStart === -1 ? '' : rest.slice(pathStart + 1);

  const [host, port] = splitHostPort(hostPort, uri);
  if (host !== '') {
    parameters.set('host', uriDecode(host));
  }
  if (port !== '') {
    parameters.set('port', uriDecode(port));
  }
  if (path !== '') {
    parameters.set('dbname', uriDecode(path));
  }
  parseUriQuery(query, parameters);
  return parameters;
}

/**
 * Parse a libpq connection string (URI or `key=value` pairs) into its
 * keyword/value parameters, rejecting unknown keywords like libpq.
 *
 * @throws {Error} With libpq's message for malformed input.
 */
export function parseConnectionString(
  connectionString: string,
): Map<string, string> {
  const trimmed = connectionString.trim();
  const prefix = URI_PREFIXES.find(candidate => trimmed.startsWith(candidate));
  if (prefix !== undefined) {
    return parseUri(trimmed, prefix);
  }
  if (URI_SCHEME.test(trimmed)) {
    // Deviation: libpq reads it as `key=value` pairs and quotes the whole
    // string, password included, in its error.
    throw new Error(
      'unsupported URI scheme in connection string (use postgresql:// or postgres://)',
    );
  }
  const parameters = new Map<string, string>();
  for (const { keyword, value } of parseKeywordValueString(trimmed)) {
    if (!LIBPQ_KEYWORDS.has(keyword)) {
      // Not quoted: with an unquoted space in a password, this is part of it.
      throw new Error('invalid connection option: not a libpq keyword');
    }
    parameters.set(keyword, value);
  }
  return parameters;
}
