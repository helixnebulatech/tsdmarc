---
title: Credits and license
description: tsdmarc's license, the projects it is ported from, and third-party data.
---

## tsdmarc

tsdmarc is licensed under the [Apache License 2.0](https://github.com/helixnebulatech/tsdmarc/blob/main/LICENSE). The documentation website was created by [HelixNebula](https://helixnebula.tech).

## parsedmarc

tsdmarc is a TypeScript port of [parsedmarc](https://github.com/domainaware/parsedmarc) 11.2.1 (commit `7bbc405c01a1c4c37811b2a3746e8881c00cda39`), Copyright Sean Whalen and parsedmarc contributors, licensed under the Apache License 2.0.

**Most of this documentation is adapted from [parsedmarc's documentation](https://domainaware.github.io/parsedmarc/)** (Apache-2.0): the configuration reference, the output samples, the dashboards guide, the DMARC and mailing list guides, the DavMail guide and the service instructions, rewritten for TypeScript, Node.js, Bun and Deno. The dashboard screenshots and the dashboards themselves come from parsedmarc; the Grafana dashboards were contributed to parsedmarc by GitHub user Bhozar.

parsedmarc is maintained by one developer. If it (or tsdmarc) is useful to you, consider [sponsoring Sean Whalen's work](https://github.com/sponsors/seanthegeek).

tsdmarc is not affiliated with or endorsed by the parsedmarc project, and its packages don't use the parsedmarc name.

## mailsuite

The mailbox connections and the SMTP code are a port of [mailsuite](https://github.com/seanthegeek/mailsuite) 2.3.4 (commit `3bd62831d137c9aa7884be33b83323ca3a1bd1de`), Copyright Sean Whalen, licensed under the Apache License 2.0.

## Third-party code and data

- **IPinfo Lite** (`ipinfo_lite.mmdb`, in `@tsdmarc/ipinfo-lite`), © IPinfo, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The reverse DNS map from parsedmarc is derived in part from IPinfo Lite data, also CC BY-SA 4.0.
- Ports of parts of Expat (MIT), xmltodict (MIT), libxml2's recovery behavior (MIT), the CPython standard library (PSF License), mail-parser (Apache-2.0), dnspython (ISC), python-dateutil (Apache-2.0 / BSD-3-Clause), zlib (zlib License), libbzip2 (BSD-style), liblzma (0BSD) and libzstd (BSD-3-Clause).

The full list, with copyright notices, is in the repository's [`NOTICE`](https://github.com/helixnebulatech/tsdmarc/blob/main/NOTICE) file.

## This website

Built with [Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/); the API reference is generated with [TypeDoc](https://typedoc.org/) and [starlight-typedoc](https://github.com/HiDeoo/starlight-typedoc).
