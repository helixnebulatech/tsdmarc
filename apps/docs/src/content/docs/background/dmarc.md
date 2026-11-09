---
title: Understanding DMARC
description: A short guide to DMARC, SPF and DKIM alignment, and what to do when a sender can't comply.
---

DMARC (Domain-based Message Authentication, Reporting and Conformance) lets a domain owner tell receivers how to handle email that claims to come from their domain but fails authentication, and asks them to send reports about it:

- **Aggregate reports** (`rua`) are daily XML summaries: which IP addresses sent mail as your domain, how much, and whether it passed SPF, DKIM and DMARC. Defined by RFC 7489 and, in the final standard, RFC 9990.
- **Failure reports** (`ruf`, formerly called forensic reports) are sent per failing message, with its headers and sometimes its body. Defined by RFC 6591 and RFC 9991. Few receivers send them, for privacy reasons.
- **SMTP TLS reports** (TLS-RPT, RFC 8460) are a related mechanism: daily JSON reports about failures to establish TLS with your mail servers under MTA-STS or DANE policies.

tsdmarc parses all three.

## Resources

- [Demystifying DMARC](https://seanthegeek.net/459/demystifying-dmarc/) — a complete guide to SPF, DKIM and DMARC, by parsedmarc's author.
- [checkdmarc](https://domainaware.github.io/checkdmarc/) — SPF and DMARC record validation and parsing.
- DMARC protects against spoofing of your exact domain, not lookalike domains. For open source lookalike domain monitoring, see [DomainAware](https://github.com/seanthegeek/domainaware).

## DMARC alignment

DMARC makes sure that SPF and DKIM actually authenticate the domain the reader sees in the `From` header. A message passes DMARC by passing DKIM **or** SPF, **as long as the corresponding identifier is aligned**:

|  | DKIM | SPF |
| --- | --- | --- |
| **Passing** | The signature in the DKIM header validates with a public key published in DNS for the domain named in the signature | The sending server's IP address is listed in the SPF record of the domain in the SMTP envelope's `MAIL FROM` |
| **Alignment** | The signing domain aligns with the domain in the message's `From` header | The domain in the SMTP envelope's `MAIL FROM` aligns with the domain in the message's `From` header |

In tsdmarc's output, each aggregate record's `alignment` object (`spf`, `dkim`, `dmarc`) gives these results, and `auth_results` the raw SPF and DKIM results reported by the receiver.

Only DKIM survives forwarding: a forwarded message keeps its DKIM signature (part of the message) but is sent from a new server with a new envelope, so SPF alignment fails. That is why DKIM matters so much.

## What if a sender won't support DKIM/DMARC?

1. Some vendors don't know about DMARC yet; ask them about SPF and DKIM/email authentication.
2. Check whether they can send through your own email relays instead of theirs.
3. Do they really need to send as your domain? Why not use the display name instead?
4. Worst case, have the vendor send as a specific subdomain of your domain (such as `noreply@news.example.com`), and create separate SPF and DMARC records on `news.example.com` with `p=none`.

:::caution
Don't change the `p` or `sp` values of the DMARC record of your organizational domain to accommodate a vendor: that would leave the domain and its subdomains open to spoofing.
:::

## Mailing lists

Mailing lists that modify messages break DKIM and fail DMARC. See [Mailing lists](../mailing-lists/).

---

Adapted from [parsedmarc's documentation](https://domainaware.github.io/parsedmarc/dmarc.html) (Apache-2.0).
