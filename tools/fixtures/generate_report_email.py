"""Generate expected parse_report_email() and mbox output for tsdmarc's tests.

Writes packages/tsdmarc/src/__fixtures__/report-email/cases.json:

- "emails": report emails built like parsedmarc's own tests do (MIME
  messages from email.mime, raw 8bit messages, legacy text notices, bad
  attachments), each with parse_report_email()'s outcome: "result"
  (parsedmarc's JSON output) or "error": {"type", "message"};
- "mbox": raw mbox files (base64) with what Python's mailbox.mbox reads from
  them: the get_string() text of every message, or "error";
- "mbox_reports": an mbox built with mailbox.mbox from samples/ (as
  TestGetDmarcReportsFromMboxParallel does) and the
  get_dmarc_reports_from_mbox() result.

Parsing is offline with bundled files only, with TZ=UTC. Run with:

    .venv/bin/python -I tools/fixtures/generate_report_email.py
"""

from __future__ import annotations

import base64
import gzip
import json
import mailbox
import os
import quopri
import sys
import tempfile
import time
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.nonmultipart import MIMENonMultipart
from email.mime.text import MIMEText
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "__fixtures__" / "report-email"

# Copied from parsedmarc's tests/test_init.py.
FEEDBACK_REPORT_HEADERS = (
    "Feedback-Type: auth-failure\r\n"
    "User-Agent: parsedmarc-tests/1.0\r\n"
    "Version: 1\r\n"
    "Original-Mail-From: <bounce@example.com>\r\n"
    "Arrival-Date: Thu, 27 Aug 2026 10:00:00 +0000\r\n"
    "Source-IP: 203.0.113.10\r\n"
    "Authentication-Results: mx.example.com; dmarc=fail\r\n"
)

SAMPLE_HEADERS = (
    "Received: from mail.example.com (mail.example.com [203.0.113.10])\r\n"
    "\tby mx.example.com with ESMTPS id abc123;\r\n"
    "\tThu, 27 Aug 2026 10:00:00 +0000\r\n"
    "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com;\r\n"
    "\ts=selector1; h=from:to:subject;\r\n"
    "\tbh=" + "a" * 76 + "=;\r\n"
    "\tb=" + "b" * 120 + "\r\n"
    "From: victim@example.com\r\n"
    "To: someone@example.org\r\n"
    "Subject: hello\r\n"
)


def build_failure_report_email(
    feedback_report=FEEDBACK_REPORT_HEADERS,
    sample=SAMPLE_HEADERS,
    feedback_report_cte=None,
    sample_cte=None,
):
    def encode(text, cte):
        if cte == "quoted-printable":
            return quopri.encodestring(text.encode()).decode("ascii")
        if cte == "base64":
            return base64.b64encode(text.encode()).decode("ascii")
        raise ValueError(f"Unsupported test encoding: {cte}")

    msg = MIMEMultipart("report", report_type="feedback-report")
    msg["From"] = "dmarc-noreply@example.org"
    msg["To"] = "dmarc-reports@example.com"
    msg["Subject"] = "DMARC Authentication Failure Report"
    msg.attach(MIMEText("This is a DMARC authentication failure report.", "plain"))

    report_part = MIMENonMultipart("message", "feedback-report")
    if feedback_report_cte is None:
        report_part.set_payload(feedback_report)
    else:
        report_part.set_payload(encode(feedback_report, feedback_report_cte))
        report_part["Content-Transfer-Encoding"] = feedback_report_cte
    msg.attach(report_part)

    sample_part = MIMEText(sample, _subtype="rfc822-headers")
    if sample_cte is not None:
        sample_part.set_payload(encode(sample, sample_cte))
        del sample_part["Content-Transfer-Encoding"]
        sample_part["Content-Transfer-Encoding"] = sample_cte
    msg.attach(sample_part)

    return msg.as_string()


def build_raw_failure_report_email(sample, sample_charset="utf-8"):
    return "\n".join(
        [
            "From: dmarc-noreply@example.org",
            "To: dmarc-reports@example.com",
            "Subject: DMARC Authentication Failure Report",
            "MIME-Version: 1.0",
            "Content-Type: multipart/report; report-type=feedback-report;",
            '\tboundary="BOUNDARY"',
            "",
            "--BOUNDARY",
            "Content-Type: text/plain; charset=us-ascii",
            "",
            "This is a DMARC authentication failure report.",
            "",
            "--BOUNDARY",
            "Content-Type: message/feedback-report",
            "",
            FEEDBACK_REPORT_HEADERS,
            "--BOUNDARY",
            f'Content-Type: text/rfc822-headers; charset="{sample_charset}"',
            "",
            sample,
            "--BOUNDARY--",
            "",
        ]
    )


SOFT_BREAK_RESULTS = (
    "mx.example.com; dkim=fail header.d=example.com header.s=selector1 "
    'reason="signature verification failed"; spf=fail '
    "smtp.mailfrom=bounce@example.com; dmarc=fail"
)

AGGREGATE_XML = (
    b'<?xml version="1.0"?>\n<feedback><report_metadata><org_name>example.com'
    b"</org_name><email>dmarc@example.com</email><report_id>mbox-test-123"
    b"</report_id><date_range><begin>1680000000</begin><end>1680086400</end>"
    b"</date_range></report_metadata><policy_published><domain>example.com"
    b"</domain><p>none</p></policy_published><record><row><source_ip>"
    b"203.0.113.1</source_ip><count>1</count><policy_evaluated><disposition>"
    b"none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>"
    b"</row><identifiers><header_from>example.com</header_from></identifiers>"
    b"<auth_results><spf><domain>example.com</domain><result>pass</result>"
    b"</spf></auth_results></record></feedback>"
)

SMTP_TLS_JSON = json.dumps(
    {
        "organization-name": "Example",
        "date-range": {
            "start-datetime": "2024-01-01T00:00:00Z",
            "end-datetime": "2024-01-01T23:59:59Z",
        },
        "contact-info": "tls@example.com",
        "report-id": "tls-1",
        "policies": [
            {
                "policy": {"policy-type": "no-policy-found", "policy-domain": "example.com"},
                "summary": {
                    "total-successful-session-count": 1,
                    "total-failure-session-count": 0,
                },
            }
        ],
    }
)


def gzip_attachment_email(content_type: str) -> str:
    msg = MIMEMultipart()
    msg["From"] = "dmarc@example.com"
    msg["Subject"] = "Report"
    msg["Date"] = "Thu, 1 Jan 2024 00:00:00 +0000"
    maintype, subtype = content_type.split("/")
    data = AGGREGATE_XML if "xml" in subtype or subtype == "gzip" else SMTP_TLS_JSON.encode()
    att = MIMEApplication(gzip.compress(data, mtime=0), subtype)
    att.add_header("Content-Disposition", "attachment", filename="report.gz")
    msg.attach(att)
    return msg.as_string()


def tlsrpt_email(content_type: str, body: str, cte: str | None = None) -> str:
    lines = [
        "From: tls@example.com",
        "Subject: TLS report",
        "Date: Mon, 01 Jan 2024 00:00:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type=tlsrpt; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain",
        "",
        "TLS report",
        "--B",
        f"Content-Type: {content_type}",
    ]
    if cte:
        lines.append(f"Content-Transfer-Encoding: {cte}")
    lines += ["", body, "--B--", ""]
    return "\n".join(lines)


def email_cases() -> dict[str, str]:
    feedback_without_type = FEEDBACK_REPORT_HEADERS.replace(
        "Feedback-Type: auth-failure\r\n", ""
    ).replace("User-Agent: parsedmarc-tests/1.0\r\n", "")
    soft_break_feedback = FEEDBACK_REPORT_HEADERS.replace(
        "Authentication-Results: mx.example.com; dmarc=fail\r\n",
        f"Authentication-Results: {SOFT_BREAK_RESULTS}\r\n",
    )
    quoted_feedback = FEEDBACK_REPORT_HEADERS.replace(
        "User-Agent: parsedmarc-tests/1.0", "User-Agent: it's \"quoted\"\\path"
    )
    xml_attachment = base64.b64encode(b"<feedback></feedback>").decode()
    json_attachment = base64.b64encode(b"{not valid json").decode()
    gz_tls = base64.b64encode(gzip.compress(SMTP_TLS_JSON.encode(), mtime=0)).decode()
    return {
        "failure-plain": build_failure_report_email(),
        "failure-qp-sample": build_failure_report_email(sample_cte="quoted-printable"),
        "failure-base64-sample": build_failure_report_email(sample_cte="base64"),
        "failure-qp-feedback-report": build_failure_report_email(
            feedback_report_cte="quoted-printable"
        ),
        "failure-base64-feedback-report": build_failure_report_email(
            feedback_report_cte="base64"
        ),
        "failure-base64-feedback-body-without-cte": build_failure_report_email(
            feedback_report=base64.b64encode(FEEDBACK_REPORT_HEADERS.encode()).decode()
        ),
        "failure-base64-feedback-body-with-quotes": build_failure_report_email(
            feedback_report=base64.b64encode(quoted_feedback.encode()).decode()
        ),
        "failure-qp-feedback-missing-feedback-type": build_failure_report_email(
            feedback_report=feedback_without_type,
            feedback_report_cte="quoted-printable",
        ),
        "failure-qp-feedback-soft-line-break": build_failure_report_email(
            feedback_report=soft_break_feedback,
            feedback_report_cte="quoted-printable",
        ),
        "failure-no-reported-domain-no-sample-from": build_failure_report_email(
            sample="To: someone@example.org\r\nSubject: hello\r\n"
        ),
        "failure-raw-8bit-sample": build_raw_failure_report_email(
            "From: Jérôme <victim@example.com>\r\n"
            "To: someone@example.org\r\n"
            "Subject: café résumé\r\n"
        ),
        "failure-raw-latin1-declared-sample": build_raw_failure_report_email(
            "From: Jérôme <victim@example.com>\r\nSubject: café\r\n",
            sample_charset="iso-8859-1",
        ),
        "text-failure-notice": (
            "From: report@example.com\nSubject: Failure Report\n"
            "Content-Type: text/plain\n\n"
            "A message claiming to be from you has failed authentication.\n"
            "Received Date: Mon, 01 Jan 2024 00:00:00 +0000\n"
            "Sender IP Address: 192.0.2.1\n"
            "detected.\n"
            "From: spoof@example.com\nTo: victim@example.com\nSubject: spam\n"
        ),
        "text-failure-notice-missing-fields": (
            "From: a@b.c\nSubject: Failure\nContent-Type: text/plain\n\n"
            "A message claiming to be from you has failed. "
            "No fields here detected. nothing\n"
        ),
        "text-failure-notice-without-detected": (
            "From: a@b.c\nSubject: Failure\nContent-Type: text/plain\n\n"
            "A message claiming to be from you has failed.\n"
            "Received Date: Mon, 01 Jan 2024 00:00:00 +0000\n"
            "Sender IP Address: 192.0.2.1\n"
        ),
        "attachment-malformed-xml": (
            "From: a@b.c\nSubject: Agg\nMIME-Version: 1.0\n"
            "Content-Type: application/octet-stream\n"
            "Content-Transfer-Encoding: base64\n\n" + xml_attachment + "\n"
        ),
        "attachment-invalid-json": (
            "From: a@b.c\nSubject: Tls\nMIME-Version: 1.0\n"
            "Content-Type: application/octet-stream\n"
            "Content-Transfer-Encoding: base64\n\n" + json_attachment + "\n"
        ),
        "attachment-gzip-aggregate": gzip_attachment_email("application/gzip"),
        "attachment-gzip-smtp-tls": gzip_attachment_email("application/tlsrpt-gz"),
        "tlsrpt-json": tlsrpt_email("application/tlsrpt+json", SMTP_TLS_JSON),
        "tlsrpt-json-base64": tlsrpt_email(
            "application/tlsrpt+json",
            base64.b64encode(SMTP_TLS_JSON.encode()).decode(),
            "base64",
        ),
        "tlsrpt-gzip": tlsrpt_email("application/tlsrpt+gzip", gz_tls, "base64"),
        "not-a-report": (
            "From: test@example.com\nSubject: Hello World\n"
            "Content-Type: text/plain\n\nThis is not a DMARC report."
        ),
        "not-a-report-two-subjects": (
            "From: test@example.com\nSubject: one\nSubject: two\n\nhello"
        ),
        "unparseable-date": "From: a@b.c\nDate: not-a-real-date\nSubject: x\n\nbody",
        "two-date-headers": (
            "From: a@b.c\nDate: Mon, 01 Jan 2024 00:00:00 +0000\n"
            "Date: Tue, 02 Jan 2024 00:00:00 +0000\nSubject: x\n\nbody"
        ),
        "no-headers": "not a valid email",
    }


def outcome(function, *args, **kwargs) -> dict:
    try:
        return {"result": function(*args, **kwargs)}
    except Exception as error:  # noqa: BLE001 - recorded as the expected outcome
        return {"error": {"type": type(error).__name__, "message": str(error)}}


MBOX_CASES: dict[str, bytes] = {
    "empty": b"",
    "no-from-line": b"Subject: x\n\nbody\n",
    "two-messages": (
        b"From a@example.com Thu Jan  1 00:00:00 2024\nSubject: one\n\nfirst\n\n"
        b"From b@example.com Thu Jan  1 00:00:00 2024\nSubject: two\n\nsecond\n"
    ),
    "garbage-before-first-from": (
        b"junk line\nFrom a@example.com Thu Jan  1 00:00:00 2024\nSubject: x\n\nbody\n"
    ),
    "no-blank-line-between": (
        b"From a Thu Jan  1 00:00:00 2024\nSubject: one\n\nfirst\n"
        b"From b Thu Jan  1 00:00:00 2024\nSubject: two\n\nsecond"
    ),
    "escaped-from-lines": (
        b"From a Thu Jan  1 00:00:00 2024\nSubject: x\n\n>From here\n>>From there\n"
    ),
    "crlf-lines": (
        b"From a Thu Jan  1 00:00:00 2024\r\nSubject: x\r\n\r\nbody\r\n\r\n"
        b"From b Thu Jan  1 00:00:00 2024\r\nSubject: y\r\n\r\nbody2\r\n"
    ),
    "8bit-utf8-header-and-body": (
        "From x Thu Jan  1 00:00:00 2024\nSubject: café\n"
        "Content-Type: text/plain; charset=utf-8\n\nhé llo\n".encode()
    ),
    "8bit-body-without-charset": (
        "From x Thu Jan  1 00:00:00 2024\nSubject: x\n\nnaïve\n".encode()
    ),
    "8bit-body-latin1-charset": (
        b"From x Thu Jan  1 00:00:00 2024\nSubject: x\n"
        b"Content-Type: text/plain; charset=latin-1\n\nna\xefve caf\xe9\n"
    ),
    "8bit-body-us-ascii-charset": (
        b"From x Thu Jan  1 00:00:00 2024\nSubject: x\n"
        b"Content-Type: text/plain; charset=us-ascii\n"
        b"Content-Transfer-Encoding: 8bit\n\nna\xc3\xafve\n"
    ),
    "8bit-folded-header": (
        "From x Thu Jan  1 00:00:00 2024\nSubject: première ligne\n"
        " deuxième ligne\nX-Other: plain\n\nbody\n".encode()
    ),
    "8bit-multipart": (
        "From x Thu Jan  1 00:00:00 2024\nSubject: multi\nMIME-Version: 1.0\n"
        'Content-Type: multipart/mixed; boundary="B"\n\npréambule\n--B\n'
        "Content-Type: text/plain; charset=utf-8\n\nhé\n--B\n"
        "Content-Type: text/html; charset=iso-8859-15\n"
        "Content-Transfer-Encoding: quoted-printable\n\n<p>é</p>\n--B--\n".encode()
    ),
    "8bit-unknown-charset": (
        b"From x Thu Jan  1 00:00:00 2024\nSubject: x\n"
        b"Content-Type: text/plain; charset=x-not-a-charset\n\nna\xc3\xafve\n"
    ),
}


def mbox_outcome(data: bytes) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "case.mbox")
        with open(path, "wb") as mbox_file:
            mbox_file.write(data)
        box = mailbox.mbox(path)
        try:
            messages = []
            for key in box.keys():
                try:
                    messages.append({"string": box.get_string(key)})
                except Exception as error:  # noqa: BLE001
                    messages.append(
                        {"error": {"type": type(error).__name__, "message": str(error)}}
                    )
            return {"messages": messages}
        finally:
            box.close()


def mbox_reports(parsedmarc) -> dict:
    sources = [
        "aggregate/twilight.eml",
        "failure/dmarc_ruf_report_linkedin.eml",
        "smtp_tls/google.com_smtp_tls_report.eml",
        "aggregate/twilight.eml",
    ]
    junk = b"From: noise@example.com\nSubject: not a report\n\nplain text\n"
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "reports.mbox")
        box = mailbox.mbox(path)
        box.lock()
        try:
            for source in sources:
                box.add(mailbox.mboxMessage((SAMPLES / source).read_bytes()))
            box.add(mailbox.mboxMessage(junk))
            box.flush()
        finally:
            box.unlock()
        box.close()
        data = Path(path).read_bytes()
        result = parsedmarc.get_dmarc_reports_from_mbox(
            path, config=parsedmarc.ParserConfig(offline=True, always_use_local_files=True)
        )
    return {"mbox": base64.b64encode(data).decode("ascii"), "result": result}


def main() -> int:
    if os.environ.get("TZ") != "UTC":
        os.environ["TZ"] = "UTC"
        time.tzset()

    import parsedmarc

    emails = {}
    for name, message in email_cases().items():
        emails[name] = {
            "message": message,
            **outcome(
                parsedmarc.parse_report_email,
                message,
                config=parsedmarc.ParserConfig(offline=True, always_use_local_files=True),
            ),
        }
    mboxes = {
        name: {"data": base64.b64encode(data).decode("ascii"), **mbox_outcome(data)}
        for name, data in MBOX_CASES.items()
    }
    cases = {
        "parsedmarc": parsedmarc.__version__,
        "emails": emails,
        "mbox": mboxes,
        "mbox_reports": mbox_reports(parsedmarc),
    }
    TARGET.mkdir(parents=True, exist_ok=True)
    target = TARGET / "cases.json"
    target.write_text(
        json.dumps(cases, indent=2, ensure_ascii=True, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(emails)} email and {len(mboxes)} mbox cases to {target.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
