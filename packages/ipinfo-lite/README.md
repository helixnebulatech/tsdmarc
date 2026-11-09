# @tsdmarc/ipinfo-lite

The [IPinfo Lite](https://ipinfo.io/lite) IP-to-country and ASN database (`data/ipinfo_lite.mmdb`, MMDB format, about 25 MB), packaged so [`tsdmarc`](https://www.npmjs.com/package/tsdmarc) can look up IP addresses without a download. It is the same file parsedmarc ships, unmodified.

## Install

```sh
npm install tsdmarc @tsdmarc/ipinfo-lite
```

`tsdmarc` declares it as an optional peer dependency and loads it automatically when it is installed. [`@tsdmarc/cli`](https://github.com/helixnebulatech/tsdmarc/tree/main/packages/cli#readme) depends on it, so the CLI always has it.

## How tsdmarc picks the database

For each IP lookup, `tsdmarc` uses the first of:

1. The `ipDbPath` option (CLI: `[general] ip_db_path`), if the file exists. Any MMDB from IPinfo, MaxMind or DB-IP works.
2. The database selected by `loadIpDb()`, if it was called.
3. This package.
4. A GeoLite2 or DB-IP file in a standard system location (for example `/usr/share/GeoIP/GeoLite2-Country.mmdb`).

`loadIpDb()` is what downloads the database. The CLI calls it at startup; library code calls it when it wants an up-to-date copy. It selects the first of:

1. `localFilePath` (CLI: `ip_db_path`), if the file exists.
2. A fresh download from parsedmarc's repository (or `url`, CLI: `ipinfo_url`), cached per user in `$XDG_CACHE_HOME/tsdmarc`, `~/.cache/tsdmarc` or `%LOCALAPPDATA%\tsdmarc`. Skipped with `offline` or `alwaysUseLocalFile` (CLI: `offline`, `always_use_local_files`).
3. A previously cached download.
4. This package.

So without this package, the CLI downloads the database on its first run and reuses the cached copy when a later download fails. With it, lookups also work offline and in library code that never calls `loadIpDb()`. A warning is logged when the selected file is more than a month old.

## Usage

Nothing to do: install it next to `tsdmarc`. To force the bundled copy, or pass its path explicitly:

```ts
import { ipinfoLiteDbPath } from '@tsdmarc/ipinfo-lite';
import { loadIpDb, parseReportFile } from 'tsdmarc';

// No download: a cached copy if there is one, otherwise this package.
await loadIpDb({ offline: true });

// Or point lookups at this file directly.
const parsed = await parseReportFile('report.xml.gz', {
  ipDbPath: ipinfoLiteDbPath,
});
```

The package exports one value, `ipinfoLiteDbPath`: the absolute path of `data/ipinfo_lite.mmdb`.

## License

The data is provided by [IPinfo](https://ipinfo.io/lite) under the [Creative Commons Attribution-ShareAlike 4.0 License](https://creativecommons.org/licenses/by-sa/4.0/).

---

Part of [tsdmarc](https://github.com/helixnebulatech/tsdmarc#readme), a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc). The data is licensed under CC BY-SA 4.0.

Created by [HelixNebula](https://helixnebula.tech).
