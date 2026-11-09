---
title: Output formats
description: The JSON and CSV formats tsdmarc writes, field by field, and how they relate to the camelCase API.
---

tsdmarc produces consistent, normalized output whatever the report schema. Every output — JSON and CSV files, Elasticsearch/OpenSearch documents, Splunk, Kafka, S3, Loki, webhook and Log Analytics payloads, PostgreSQL columns, syslog and GELF fields — uses **parsedmarc's snake_case field names**, so data and dashboards built for parsedmarc keep working.

In the library, the same data uses camelCase keys (`report.reportMetadata.orgName` ↔ `report_metadata.org_name`). `toSnakeCaseKeys()` converts a report to the output form; see [Using the library](../library/#converting-to-parsedmarcs-json).

The samples below were produced by tsdmarc from the [sample reports](https://github.com/helixnebulatech/tsdmarc/tree/main/samples) with `TZ=UTC tsdmarc --offline --output out …`.

## Aggregate reports

This is the [example report](https://dmarc.org/wiki/FAQ#I_need_to_implement_aggregate_reports.2C_what_do_they_look_like.3F) from the dmarc.org wiki, an older draft of the 1.0 schema standardized in [RFC 7489 Appendix C](https://tools.ietf.org/html/rfc7489#appendix-C) that is still in wide use.

### JSON

```json
{
  "xml_schema": "draft",
  "xml_namespace": null,
  "report_metadata": {
    "org_name": "acme.com",
    "org_email": "noreply-dmarc-support@acme.com",
    "org_extra_contact_info": "http://acme.com/dmarc/support",
    "report_id": "9391651994964116463",
    "begin_date": "2012-04-28 00:00:00",
    "end_date": "2012-04-28 23:59:59",
    "timespan_requires_normalization": false,
    "original_timespan_seconds": 86399,
    "errors": [],
    "generator": null
  },
  "policy_published": {
    "domain": "example.com",
    "adkim": "r",
    "aspf": "r",
    "p": "none",
    "sp": "none",
    "pct": "100",
    "fo": null,
    "np": null,
    "testing": null,
    "discovery_method": null
  },
  "records": [
    {
      "source": {
        "ip_address": "72.150.241.94",
        "reverse_dns": null,
        "country": "US",
        "base_domain": null,
        "name": "Amazon",
        "type": "Technology",
        "asn": 16509,
        "as_name": "Amazon.com, Inc.",
        "as_domain": "amazon.com"
      },
      "count": 2,
      "alignment": { "spf": true, "dkim": false, "dmarc": true },
      "policy_evaluated": {
        "disposition": "none",
        "dkim": "fail",
        "spf": "pass",
        "policy_override_reasons": []
      },
      "identifiers": {
        "header_from": "example.com",
        "envelope_from": "example.com",
        "envelope_to": null
      },
      "auth_results": {
        "dkim": [
          {
            "domain": "example.com",
            "selector": "none",
            "result": "fail",
            "human_result": null
          }
        ],
        "spf": [
          {
            "domain": "example.com",
            "scope": "mfrom",
            "result": "pass",
            "human_result": null
          }
        ]
      },
      "normalized_timespan": false,
      "interval_begin": "2012-04-28 00:00:00",
      "interval_end": "2012-04-28 23:59:59"
    }
  ]
}
```

Notes on the fields:

- `xml_schema` is `draft`, `1.0` or the RFC 9990 schema; `xml_namespace` is the report's XML namespace, if any (`urn:ietf:params:xml:ns:dmarc-2.0` for RFC 9990).
- RFC 9990 adds `np` (non-existent subdomain policy), `testing` (`t=y`), `discovery_method` (`psl` or `treewalk`), `generator` and `human_result`. `pct` was removed by RFC 9990 and is `null` when absent.
- `source` is the enrichment of the sending IP: reverse DNS, its base domain, the service `name` and `type` from the reverse DNS map, and the country and ASN from the IP database.
- Reports covering more than `normalize_timespan_threshold_hours` (24) are split into per-day records: `timespan_requires_normalization` is set on the report, `normalized_timespan` on each record, and `interval_begin` / `interval_end` give each record's day.
- `begin_date`, `end_date` and the intervals are in the machine's local time zone, as in parsedmarc. Set `TZ` for predictable output.

### CSV

One row per record, with the report's metadata repeated on each row:

```text
xml_schema,org_name,org_email,org_extra_contact_info,report_id,begin_date,end_date,normalized_timespan,errors,domain,adkim,aspf,p,sp,np,pct,fo,testing,discovery_method,source_ip_address,source_country,source_reverse_dns,source_base_domain,source_name,source_type,source_asn,source_as_name,source_as_domain,count,spf_aligned,dkim_aligned,dmarc_aligned,disposition,policy_override_reasons,policy_override_comments,envelope_from,header_from,envelope_to,dkim_domains,dkim_selectors,dkim_results,spf_domains,spf_scopes,spf_results
draft,acme.com,noreply-dmarc-support@acme.com,http://acme.com/dmarc/support,9391651994964116463,2012-04-28 00:00:00,2012-04-28 23:59:59,False,,example.com,r,r,none,none,,100,,,,72.150.241.94,US,,,Amazon,Technology,16509,"Amazon.com, Inc.",amazon.com,2,True,False,True,none,,,example.com,example.com,,example.com,none,fail,example.com,mfrom,pass
```

## Failure reports

From the anonymized [failure report email sample](https://github.com/helixnebulatech/tsdmarc/tree/main/samples/failure) contributed to parsedmarc by GitHub user [xennn](https://github.com/xennn).

### JSON

```json
{
  "feedback_type": "auth-failure",
  "user_agent": "Lua/1.0",
  "version": "1.0",
  "original_mail_from": "sharepoint@domain.de",
  "original_rcpt_to": "peter.pan@domain.de",
  "arrival_date": "Mon, 01 Oct 2018 11:20:27 +0200",
  "message_id": "<38.E7.30937.BD6E1BB5@ mailrelay.de>",
  "authentication_results": "dmarc=fail (p=none, dis=none) header.from=domain.de",
  "delivery_result": "policy",
  "auth_failure": ["dmarc"],
  "reported_domain": "domain.de",
  "arrival_date_utc": "2018-10-01 09:20:27",
  "source": {
    "ip_address": "10.10.10.10",
    "reverse_dns": null,
    "country": null,
    "base_domain": null,
    "name": null,
    "type": null,
    "asn": null,
    "as_name": null,
    "as_domain": null
  },
  "authentication_mechanisms": [],
  "original_envelope_id": null,
  "dkim_domain": null,
  "sample_headers_only": false,
  "sample": "Received: from Servernameone.domain.local …",
  "parsed_sample": {
    "received": [
      {
        "from": "…",
        "by": "…",
        "with": "SMTP",
        "hop": 1,
        "date_utc": "2018-10-01 09:20:27+00:00",
        "delay": 0
      }
    ],
    "date": "2018-10-01 09:20:27+00:00",
    "message-id": "<38.E7.30937.BD6E1BB5@ mailrelay.de>",
    "to": [
      {
        "display_name": null,
        "address": "peter.pan@domain.de",
        "local": "peter.pan",
        "domain": "domain.de"
      }
    ],
    "from": {
      "display_name": "…",
      "address": "sharepoint@domain.de",
      "local": "sharepoint",
      "domain": "domain.de"
    },
    "subject": "Subject",
    "x-mailer": "Microsoft SharePoint Foundation 2010",
    "body": "<html>…</html>",
    "timezone": "+2.0",
    "to_domains": ["domain.de"],
    "has_defects": false,
    "headers": {
      "Received": "…",
      "Date": "01 Oct 2018 11:20:27 +0200",
      "Subject": "Subject"
    },
    "reply_to": [],
    "cc": [],
    "bcc": [],
    "attachments": [],
    "filename_safe_subject": "Subject"
  }
}
```

- `sample` is the original message (or only its headers, with `sample_headers_only: true`), and `parsed_sample` its parsed form.
- Header names inside `headers`, and keys taken from headers such as `message-id` or `x-mailer`, are kept as they appear; they are data, not field names.
- With `strip_attachment_payloads`, attachment `payload`s are removed.
- Any other field of the feedback report is kept, named in lower case with `-` replaced by `_`.

### CSV

```text
feedback_type,user_agent,version,original_envelope_id,original_mail_from,original_rcpt_to,arrival_date,arrival_date_utc,subject,message_id,authentication_results,dkim_domain,source_ip_address,source_country,source_reverse_dns,source_base_domain,source_name,source_type,source_asn,source_as_name,source_as_domain,delivery_result,auth_failure,reported_domain,authentication_mechanisms,sample_headers_only
auth-failure,Lua/1.0,1.0,,sharepoint@domain.de,peter.pan@domain.de,"Mon, 01 Oct 2018 11:20:27 +0200",2018-10-01 09:20:27,Subject,<38.E7.30937.BD6E1BB5@ mailrelay.de>,"dmarc=fail (p=none, dis=none) header.from=domain.de",,10.10.10.10,,,,,,,,,policy,dmarc,domain.de,,False
```

When saving to a directory, each failure report's sample is also written to `samples/<subject>.eml`, with a sanitized file name. An existing sample is never replaced: the next free ` (n)` suffix is used, also across runs (parsedmarc overwrites samples from earlier runs).

## SMTP TLS reports

### JSON

```json
{
  "organization_name": "Example Inc.",
  "begin_date": "2024-01-09T00:00:00Z",
  "end_date": "2024-01-09T23:59:59Z",
  "contact_info": "smtp-tls-reporting@example.com",
  "report_id": "2024-01-09T00:00:00Z_example.com",
  "policies": [
    {
      "policy_domain": "example.com",
      "policy_type": "sts",
      "policy_strings": [
        "version: STSv1",
        "mode: testing",
        "mx: example.com",
        "max_age: 86400"
      ],
      "successful_session_count": 0,
      "failed_session_count": 3,
      "failure_details": [
        {
          "result_type": "validation-failure",
          "failed_session_count": 2,
          "sending_mta_ip": "209.85.222.201",
          "receiving_ip": "173.212.201.41",
          "receiving_mx_hostname": "example.com"
        },
        {
          "result_type": "validation-failure",
          "failed_session_count": 1,
          "sending_mta_ip": "209.85.208.176",
          "receiving_ip": "173.212.201.41",
          "receiving_mx_hostname": "example.com"
        }
      ]
    }
  ]
}
```

### CSV

One row per policy, plus one row per failure detail:

```text
organization_name,begin_date,end_date,report_id,result_type,successful_session_count,failed_session_count,policy_domain,policy_type,policy_strings,mx_host_patterns,sending_mta_ip,receiving_ip,receiving_mx_hostname,receiving_mx_helo,additional_info_uri,failure_reason_code
```

## File details

- **JSON files** (`aggregate.json`, `failure.json`, `smtp_tls.json`) hold one JSON array. New reports are appended to an existing file, which is rewritten as a single valid array, indented by 2, like parsedmarc's `json.dump(…, ensure_ascii=False, indent=2)`. The new file is written next to the old one and renamed over it, so a crash or a full disk leaves the old content whole (the directory must be writable). A file that is corrupt, unreadable or not an array is moved to `<file>.corrupt-<timestamp>` with a warning and a new one is started; parsedmarc overwrites it. Large files already in this layout only get the new entries added.
- **CSV files** follow Python's `csv.DictWriter`: `\r\n` line endings, quotes only when needed, `True`/`False` for booleans, empty cells for `null`. Rows are appended; the header is written once.
- Text cells starting with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'` ([CSV injection](https://owasp.org/www-community/attacks/CSV_Injection) protection, as in parsedmarc 11.1.0 and later). Turn it off with `csv_formula_escape = False` (tsdmarc only).
- Integers beyond 2^53 (such as a huge `count` in a malformed report) are written exactly, as Python does.
- Non-ASCII text is written as is, not `\u`-escaped. The content is equal to parsedmarc's; printed JSON may differ in escaping only.
