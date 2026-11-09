# @tsdmarc/postgres

Save tsdmarc reports to PostgreSQL. Port of parsedmarc's `postgres.py`, on [`pg`](https://www.npmjs.com/package/pg) (node-postgres), with libpq's connection rules rebuilt on top.

## Install

```sh
npm install tsdmarc @tsdmarc/postgres
```

`tsdmarc` is a peer dependency. Node.js 24 or later, Bun or Deno.

## Usage

```ts
import { AlreadySaved, PostgreSQLClient } from '@tsdmarc/postgres';
import { parseReportFile } from 'tsdmarc';

// create() opens the connection, so a bad configuration fails here.
const db = await PostgreSQLClient.create({
  connectionString:
    'postgresql://dmarc:secret@db.example.com/dmarc?sslmode=verify-full',
});

try {
  await db.createTables(); // idempotent, safe on every startup
  const parsed = await parseReportFile('report.xml.gz');
  try {
    if (parsed.reportType === 'aggregate') {
      await db.saveAggregateReportToPostgresql(parsed.report);
    } else if (parsed.reportType === 'failure') {
      await db.saveFailureReportToPostgresql(parsed.report);
    } else {
      await db.saveSmtpTlsReportToPostgresql(parsed.report);
    }
  } catch (error) {
    if (!(error instanceof AlreadySaved)) {
      throw error;
    }
  }
} finally {
  await db.close();
}
```

The tables, columns and duplicate checks are the same as parsedmarc's (`dmarc_aggregate_report`, `dmarc_aggregate_record`, ..., `dmarc_failure_report`, `smtp_tls_report`, ...), so parsedmarc's Grafana dashboard for PostgreSQL ([`Grafana-DMARC_Reports-PostgreSQL.json`](https://github.com/helixnebulatech/tsdmarc/tree/main/dashboards/grafana)) works unchanged. JSONB columns use snake_case keys, like parsedmarc.

## API

| Member | Description |
| --- | --- |
| `new PostgreSQLClient(options?)` | Create a client. Does not connect. |
| `PostgreSQLClient.create(options?)` | Create a client and open its connection. |
| `connect()` | Open a new connection. Throws `PostgreSQLError` on failure. |
| `close()` | Close the connection. Safe to call repeatedly. |
| `closed` | Whether the connection is closed (or was never opened). |
| `createTables()` | Create the tables and indexes that don't exist yet. |
| `saveAggregateReportToPostgresql(report)` | Save an aggregate report in one transaction. |
| `saveFailureReportToPostgresql(report)` | Save a failure report. `saveForensicReportToPostgresql` is a backward-compatible alias. |
| `saveSmtpTlsReportToPostgresql(report)` | Save an SMTP TLS report. |
| `AlreadySaved` | Thrown when an identical report is already in the database. |
| `PostgreSQLError` | Thrown on database errors. |
| `DDL_STATEMENTS`, `SQL` | The SQL statements the client runs. |

Save methods connect, or reconnect after a dropped connection, as needed. Transactions run one at a time on a single connection.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connectionString` | `string \| null` | — | libpq connection string: a URI (`postgresql://user:pass@host/db`) or `key=value` pairs (`host=db dbname=dmarc sslmode=require`). When set, the options below except `connectTimeout` and `queryTimeout` are ignored. |
| `host` | `string \| null` | `PGHOST`, else the Unix socket | Server hostname or IP address. Without a host, connects to `/var/run/postgresql` (or `/tmp` if only that socket exists). |
| `port` | `number` | `5432` | Server port. |
| `user` | `string \| null` | `PGUSER`, then the OS user | User name. |
| `password` | `string \| null` | `PGPASSWORD` | Password. |
| `database` | `string \| null` | `PGDATABASE`, then the user name | Database name. |
| `connectTimeout` | `number` | `PGCONNECT_TIMEOUT`, then 130 | Seconds to wait for a connection. `connect_timeout` in the connection string wins. Values below 2 become 2; `0` or less means the default. |
| `sslmode` | `string \| null` | `PGSSLMODE`, then `prefer` | `disable`, `allow`, `prefer`, `require`, `verify-ca` or `verify-full`. |
| `sslrootcert` | `string \| null` | `PGSSLROOTCERT`, then `~/.postgresql/root.crt` if present | CA file to verify the server with, or `system`. |
| `sslcert` | `string \| null` | `PGSSLCERT`, then `~/.postgresql/postgresql.crt` if present | Client certificate. |
| `sslkey` | `string \| null` | `PGSSLKEY`, then `~/.postgresql/postgresql.key` | Client private key. |
| `queryTimeout` | `number` | `300` | Seconds to wait for each statement. On expiry the save throws `PostgreSQLError`, the connection is dropped and the next save reconnects. `0` waits forever, as parsedmarc does. tsdmarc only. |

Missing values fall back to the `PG*` environment variables and libpq's defaults, like psycopg.

### TLS

The default is libpq's (and therefore parsedmarc's) `sslmode=prefer`: TLS is tried first **without verifying the server's certificate**, and if the TLS attempt fails the client reconnects in plain text, logging a warning. Anyone on the network path can force that fallback, or answer the TLS handshake with their own certificate, and read the password and the reports. Only `verify-full` (or `verify-ca` with a private CA) protects against that:

```ini
[postgresql]
host = db.example.com
sslmode = verify-full
sslrootcert = system
```

| `sslmode` | TLS | Certificate checked | Plain-text fallback |
| --- | --- | --- | --- |
| `disable` | never | — | — |
| `allow` | only if plain text fails | if a root certificate is available | — |
| `prefer` (default) | first | if a root certificate is available | yes, with a warning |
| `require` | always | chain only, if a root certificate is available | no |
| `verify-ca` | always | chain (a root certificate is required) | no |
| `verify-full` | always | chain and host name | no |

"A root certificate is available" means `sslrootcert`, `PGSSLROOTCERT` or `~/.postgresql/root.crt`; `sslrootcert=system` uses the system's trusted roots and requires `verify-full`. Unix-socket connections never use TLS, as in libpq.

These are libpq's meanings, not pg's: `sslmode` is never handed to pg or pg-connection-string, which treat `prefer`, `require` and `verify-ca` as `verify-full` (with a deprecation warning) and never fall back to plain text.

The default stays `prefer` so that parsedmarc configurations keep working against servers without TLS (such as the official PostgreSQL container image). `require` would not be a real fix: an attacker who can force the plain-text fallback can just as well present a self-signed certificate, which `require` accepts.

## CLI

With [`@tsdmarc/cli`](https://github.com/helixnebulatech/tsdmarc/tree/main/packages/cli#readme), use the `[postgresql]` section of the configuration file (the same as parsedmarc's): `connection_string`, or `host`, `port`, `user`, `password` and `database`, plus `sslmode`, `sslrootcert`, `sslcert` and `sslkey` (tsdmarc only; with `connection_string`, put them in the string: in the section they are ignored with an error), and `query_timeout` (tsdmarc only, also with `connection_string`). The CLI calls `createTables()` at startup.

## Notes

Differences from parsedmarc (full list in [architecture/README.md](https://github.com/helixnebulatech/tsdmarc/blob/main/architecture/README.md#differences-from-parsedmarc)):

- The client connects lazily. Use `PostgreSQLClient.create()` or `connect()` to fail at startup, like parsedmarc's constructor.
- Connection strings and `PG*` variables are parsed like libpq. `sslmode` follows libpq (see [TLS](#tls)): `prefer` and `allow` reconnect instead of falling back on the same socket, `prefer`'s fallback to plain text is logged as a warning, and `verify-*` without a root certificate fails. TCP keepalive is on.
- libpq options pg can't honor (for example `hostaddr`, `target_session_attrs`, `channel_binding=disable`) are ignored with a warning. Several hosts in `host` are refused.
- Options that demand a protection pg can't enforce fail closed: `channel_binding=require`, `require_auth`, `requirepeer`, `sslcertmode=require` and `gssencmode=require` (also as `PGCHANNELBINDING`, `PGREQUIREAUTH`, `PGREQUIREPEER`, `PGSSLCERTMODE`, `PGGSSENCMODE`) refuse the connection, and `sslcrldir` refuses a TLS connection. `sslcrl` (`PGSSLCRL`, default `~/.postgresql/root.crl`, applied when the certificate is verified) and `ssl_min_protocol_version` / `ssl_max_protocol_version` are honored.
- Connection-string errors that libpq would print with the password show `***` instead.

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). Licensed under Apache-2.0.

Created by [HelixNebula](https://helixnebula.tech).
