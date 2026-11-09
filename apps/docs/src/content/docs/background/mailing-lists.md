---
title: Mailing lists
description: Why mailing lists fail DMARC, and how to configure Mailman and LISTSERV to stay compliant.
---

When you deploy DMARC on your domain, you may find that messages relayed by mailing lists fail DMARC. This is usually because the list sends your message with your `From` address while modifying the subject, footer or another part of the message, which breaks the DKIM signature.

## Mailing list best practices

Ideally, a mailing list forwards messages without altering the headers or the body at all. [Joe Nelson](https://begriffs.com/posts/2018-09-18-dmarc-mailing-list.html) explains exactly what mailing lists should and shouldn't do to be fully DMARC compliant. In summary:

### Do

- Keep the headers of the original message.
- Add [RFC 2369](https://tools.ietf.org/html/rfc2369) `List-Unsubscribe` headers instead of unsubscribe links in the body:

  ```text
  List-Unsubscribe: <https://list.example.com/unsubscribe-link>
  ```

- Add [RFC 2919](https://tools.ietf.org/html/rfc2919) `List-Id` headers instead of modifying the subject:

  ```text
  List-Id: Example Mailing List <list.example.com>
  ```

Modern mail clients and webmail services show unsubscribe buttons based on these headers.

### Don't

- Remove or modify existing headers of the original message, including `From`, `Date`, `Subject`, etc.
- Add content to the body or remove it from it, **including traditional disclaimers and unsubscribe footers**.

Besides complying with DMARC, this makes Reply and Reply All work as with any other message: Reply goes to the sender, Reply All to the sender and the list. Even without a subject prefix or footer, users can tell a message came from the list, because it was sent to the list address rather than to them.

## Configuring common platforms

### Mailman 2

In **General Settings**:

| Setting                    | Value   |
| -------------------------- | ------- |
| `subject_prefix`           | (empty) |
| `from_is_list`             | No      |
| `first_strip_reply_to`     | No      |
| `reply_goes_to_list`       | Poster  |
| `include_rfc2369_headers`  | Yes     |
| `include_list_post_header` | Yes     |
| `include_sender_header`    | No      |

In **Non-digest options**:

| Setting           | Value   |
| ----------------- | ------- |
| `msg_header`      | (empty) |
| `msg_footer`      | (empty) |
| `scrub_nondigest` | No      |

In **Privacy Options → Sending Filters**:

| Setting                              | Value  |
| ------------------------------------ | ------ |
| `dmarc_moderation_action`            | Accept |
| `dmarc_quarantine_moderation_action` | Yes    |
| `dmarc_none_moderation_action`       | Yes    |

### Mailman 3

In **Settings → List Identity**, make the subject prefix blank.

In **Settings → Alter Messages**:

| Setting                      | Value      |
| ---------------------------- | ---------- |
| Convert html to plaintext    | No         |
| Include RFC2369 headers      | Yes        |
| Include the list post header | Yes        |
| Explicit reply-to address    | (empty)    |
| First strip replyto          | No         |
| Reply goes to list           | No munging |

In **Settings → DMARC Mitigation**:

| Setting                        | Value                |
| ------------------------------ | -------------------- |
| DMARC mitigation action        | No DMARC mitigations |
| DMARC mitigate unconditionally | No                   |

To remove the footer, create a blank footer template. The Postorius web UI won't let you create an empty template, so create it from the command line, for example:

```sh
touch var/templates/lists/list.example.com/en/list:member:regular:footer
```

where `list.example.com` is the list ID and `en` the language. Then restart Mailman core.

### LISTSERV

[LISTSERV 16.0-2017a](https://www.lsoft.com/news/dmarc-issue1-2018.asp) and later rewrite the `From` header for domains that enforce a DMARC quarantine or reject policy. Some additional steps are needed on Linux hosts.

## Workarounds

If a mailing list must go **against** best practices and modify messages (for example to add a required legal footer), its administrator must configure it to replace the `From` address with the list's own address (known as _munging_), so that it no longer spoofs addresses of domains protected by DMARC.

### Mailman 2

In **Privacy Options → Sending Filters**:

| Setting                              | Value      |
| ------------------------------------ | ---------- |
| `dmarc_moderation_action`            | Munge From |
| `dmarc_quarantine_moderation_action` | Yes        |
| `dmarc_none_moderation_action`       | Yes        |

### Mailman 3

In the **DMARC Mitigations** tab of the Settings page:

| Setting                        | Value                           |
| ------------------------------ | ------------------------------- |
| DMARC mitigation action        | Replace From: with list address |
| DMARC mitigate unconditionally | No                              |

:::note
Message wrapping can be used as the mitigation action instead: the original message is attached to the list message, which can interfere with inbox search and mobile clients. On the other hand, replacing the `From` address can lead users to reply to the whole list when they meant to reply to the original sender. Choose what best fits your community.
:::

---

Adapted from [parsedmarc's documentation](https://domainaware.github.io/parsedmarc/dmarc.html#what-about-mailing-lists) (Apache-2.0).
