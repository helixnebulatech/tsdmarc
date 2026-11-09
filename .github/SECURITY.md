# Security policy

tsdmarc parses email and attachments sent by anyone on the internet, so security reports are welcome and taken seriously.

## Supported versions

Security fixes are released for the latest published version of each package (`tsdmarc` and `@tsdmarc/*`). Please update to it before reporting.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Older releases | No        |

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and click **Report a vulnerability**. Only the maintainers can see the report, and we can work on the fix and the advisory together there.

Please include:

- The affected package(s) and version(s), and the runtime (Node.js, Bun or Deno, with its version).
- The kind of issue (for example: denial of service through a crafted report, path traversal, credential exposure, TLS bypass, injection into an output).
- Steps to reproduce, ideally a minimal report file, email or config that triggers it. Remove real email addresses, IP addresses and secrets from samples.
- The impact you expect, and a suggested fix if you have one.

We aim to acknowledge reports within a few days, and will keep you informed about the fix and the release. We will credit you in the advisory unless you prefer otherwise.

## Issues inherited from parsedmarc

tsdmarc reproduces [parsedmarc](https://github.com/domainaware/parsedmarc)'s behavior on purpose. If a vulnerability also affects parsedmarc (or [mailsuite](https://github.com/seanthegeek/mailsuite)), please report it to that project as well, through its own security policy, so both can be fixed. Tell us whether you have done so.

## Hardening

The protections tsdmarc adds on top of parsedmarc (size limits, no credentials over plain text, redacted URLs, ...) are listed in [architecture/README.md](../architecture/README.md#differences-from-parsedmarc).
