"""Generate expected parse_failure_report() output for tsdmarc's tests.

Writes one JSON file per case to packages/tsdmarc/src/__fixtures__/failure/:

- one per samples/failure/*.eml: the (feedback_report, sample, msg_date)
  arguments that parsedmarc's own parse_report_email() passes to
  parse_failure_report() for that file, captured by wrapping the function;
- the hand-made edge cases in CASES below.

Each file holds the inputs ("feedback_report", "sample", "msg_date" as an
ISO 8601 string or null, "options") and the outcome: "result" (the report as
parsedmarc's JSON output), "csv" (parsed_failure_reports_to_csv()), "rows"
(parsed_failure_reports_to_csv_rows()) and "logs" (WARNING and above), or
"error": {"type", "message"}.

Parsing is offline with bundled files only, with TZ=UTC. Run with:

    .venv/bin/python -I tools/fixtures/generate_failure.py
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples" / "failure"
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "__fixtures__" / "failure"

MSG_DATE = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

BASE_FIELDS = {
    "Feedback-Type": "auth-failure",
    "User-Agent": "test/1.0",
    "Version": "1",
    "Original-Mail-From": "sender@example.com",
    "Arrival-Date": "Thu, 1 Jan 2024 00:00:00 +0000",
    "Source-IP": "203.0.113.1",
    "Reported-Domain": "example.com",
    "Auth-Failure": "dmarc",
}

SAMPLE = (
    "From: sender@example.com\n"
    "To: recipient@example.com\n"
    "Subject: Test\n"
    "Date: Thu, 1 Jan 2024 00:00:00 +0000\n"
    "\n"
    "Test body"
)

HEADERS_ONLY_SAMPLE = (
    "From: Sender <sender@example.com>\r\n"
    "To: recipient@example.com\r\n"
    "Subject: Headers only\r\n"
    "Message-ID: <abc@example.com>\r\n"
    "Date: Thu, 1 Jan 2024 00:00:00 +0000\r\n"
)

# A multipart sample with no boundary has no body and no attachments, but
# Python's email parser records defects for it; parsedmarc drops them from a
# headers-only sample.
HEADERS_ONLY_DEFECT_SAMPLE = (
    "From: sender@example.com\r\n"
    "Subject: Defective\r\n"
    "Content-Type: multipart/mixed\r\n"
)

ATTACHMENT_SAMPLE = (
    "From: sender@example.com\n"
    "To: recipient@example.com\n"
    "Subject: With attachment\n"
    "MIME-Version: 1.0\n"
    'Content-Type: multipart/mixed; boundary="XYZ"\n'
    "\n"
    "--XYZ\n"
    "Content-Type: text/plain\n"
    "\n"
    "Hello\n"
    "--XYZ\n"
    'Content-Type: application/octet-stream; name="data.bin"\n'
    "Content-Transfer-Encoding: base64\n"
    'Content-Disposition: attachment; filename="data.bin"\n'
    "\n"
    "AAECAwQFBgc=\n"
    "--XYZ--\n"
)

LATIN1_SAMPLE = (
    "From: =?iso-8859-1?q?J=E9r=F4me?= <victim@example.com>\n"
    "To: someone@example.org\n"
    "Subject: =?iso-8859-1?q?caf=E9?=\n"
    "MIME-Version: 1.0\n"
    "Content-Type: text/plain; charset=iso-8859-1\n"
    "Content-Transfer-Encoding: quoted-printable\n"
    "\n"
    "r=E9sum=E9\n"
)

# Text decoded from non-UTF-8 bytes with errors="replace" (as
# parse_report_email does) carries U+FFFD.
REPLACED_SAMPLE = (
    "From: J�r�me <victim@example.com>\n"
    "To: someone@example.org\n"
    "Subject: caf�\n"
    "\n"
    "r�sum�\n"
)


def report(overrides: dict[str, str | None] | None = None, sep: str = "\n") -> str:
    fields: dict[str, str | None] = dict(BASE_FIELDS)
    fields.update(overrides or {})
    return sep.join(f"{k}: {v}" for k, v in fields.items() if v is not None)


CASES: dict[str, dict] = {
    "minimal": {"feedback_report": report()},
    "rfc9991-full": {
        "feedback_report": report(
            {
                "Identity-Alignment": "dkim, spf",
                "Auth-Failure": "dmarc, spf",
                "Delivery-Result": "Reject",
                "Authentication-Results": "mx.example.com; dmarc=fail header.from=example.com",
                "DKIM-Domain": "example.com",
                "Original-Rcpt-To": "rcpt@example.org",
                "Original-Envelope-Id": "envelope-1",
                "Reported-URI": "mailto:x@example.com",
                "Message-ID": "<id@example.com>",
            }
        )
    },
    # RFC 6591 / RFC 7489-era reporters: no Identity-Alignment, other cases.
    "rfc7489-names": {
        "feedback_report": (
            "feedback-type: auth-failure\n"
            "USER-AGENT: legacy/2\n"
            "version: 0.1\n"
            "Arrival-Date: 2024-02-03 04:05:06\n"
            "Source-Ip: 2001:DB8::1 (some comment)\n"
            "Reported-Domain: example.net\n"
            "Auth-Failure: spf\n"
            "Delivery-Result: Delivered to inbox\n"
        )
    },
    "cfws-lists": {
        "feedback_report": report(
            {
                "Identity-Alignment": "  dkim ,spf,, (comment) , ",
                "Auth-Failure": " dmarc ,dkim (bad sig), spf ,",
            }
        )
    },
    "identity-alignment-none": {
        "feedback_report": report({"Identity-Alignment": "  NONE "})
    },
    "identity-alignment-empty-tokens": {
        "feedback_report": report({"Identity-Alignment": ",", "Auth-Failure": ","})
    },
    "multiple-auth-failure-values": {
        "feedback_report": report(
            {"Auth-Failure": "dmarc,dkim,spf,bodyhash,revoked,signature"}
        )
    },
    "duplicate-fields-last-wins": {
        "feedback_report": report() + "\nAuth-Failure: spf\nVersion: 2"
    },
    "missing-required-fields-warn": {
        "feedback_report": report(
            {"Feedback-Type": None, "Auth-Failure": None, "User-Agent": None}
        )
    },
    "missing-version": {"feedback_report": report({"Version": None})},
    "delivery-results": {
        "feedback_report": report({"Delivery-Result": "Policy applied (spam folder)"})
    },
    "delivery-result-unknown": {
        "feedback_report": report({"Delivery-Result": "unknown-value"})
    },
    "crlf-report": {"feedback_report": report(sep="\r\n") + "\r\n"},
    "cr-only-lines": {
        "feedback_report": "Version: 1\rUser-Agent: x\n" + report({"Version": None})
    },
    "odd-field-names": {
        "feedback_report": report()
        + "\n__proto__: polluted\nconstructor: c\n123: digits\n"
        "Ünïcode-Field: value\nX_Custom-Field: custom\nNoSpace:value\n"
        "Trailing-Space: value  \nEmpty-Value: \n  Indented: no\n"
    },
    "overwritten-keys": {
        "feedback_report": report()
        + "\nSource: s\nSample: x\nParsed-Sample: y\nArrival-Date-UTC: z\n"
        "Sample-Headers-Only: maybe\nAuthentication-Mechanisms: m"
    },
    "missing-source-ip": {"feedback_report": report({"Source-IP": None})},
    "empty-feedback-report": {"feedback_report": ""},
    "bad-source-ip": {"feedback_report": report({"Source-IP": "not-an-ip"})},
    "uppercase-ipv6": {"feedback_report": report({"Source-IP": "2001:DB8::ABCD"})},
    "bad-arrival-date": {"feedback_report": report({"Arrival-Date": "not a date"})},
    "arrival-date-with-comment": {
        "feedback_report": report(
            {"Arrival-Date": "Mon, 15 Jan 2024 10:20:30 -0500 (EST)"}
        )
    },
    "arrival-date-naive": {
        "feedback_report": report({"Arrival-Date": "2024-01-15 10:20:30"})
    },
    "missing-arrival-date-msg-date": {
        "feedback_report": report({"Arrival-Date": None}),
        "msg_date": datetime(2024, 6, 15, 12, 0, 0, tzinfo=timezone.utc),
    },
    "missing-arrival-date-msg-date-offset": {
        "feedback_report": report({"Arrival-Date": None}),
        "msg_date": datetime(
            2024, 6, 15, 12, 0, 0, 123456, tzinfo=timezone(timedelta(hours=5, minutes=30))
        ),
    },
    "missing-arrival-date-msg-date-naive": {
        "feedback_report": report({"Arrival-Date": None}),
        "msg_date": datetime(2024, 6, 15, 12, 0, 0),
    },
    "missing-arrival-date-no-msg-date": {
        "feedback_report": report({"Arrival-Date": None}),
        "msg_date": None,
    },
    "missing-reported-domain-fallback": {
        "feedback_report": report({"Reported-Domain": None})
    },
    "missing-reported-domain-no-from": {
        "feedback_report": report({"Reported-Domain": None}),
        "sample": "To: someone@example.org\r\nSubject: hello\r\n",
    },
    "missing-reported-domain-bad-from": {
        "feedback_report": report({"Reported-Domain": None}),
        "sample": "From: not an address\r\nSubject: hello\r\n",
    },
    "headers-only-sample": {
        "feedback_report": report(),
        "sample": HEADERS_ONLY_SAMPLE,
    },
    "headers-only-sample-with-defects": {
        "feedback_report": report(),
        "sample": HEADERS_ONLY_DEFECT_SAMPLE,
    },
    "attachment-sample": {"feedback_report": report(), "sample": ATTACHMENT_SAMPLE},
    "attachment-sample-stripped": {
        "feedback_report": report(),
        "sample": ATTACHMENT_SAMPLE,
        "options": {"strip_attachment_payloads": True},
    },
    "latin1-sample": {"feedback_report": report(), "sample": LATIN1_SAMPLE},
    "replacement-char-sample": {
        "feedback_report": report(),
        "sample": REPLACED_SAMPLE,
    },
    "empty-sample": {"feedback_report": report(), "sample": ""},
    "nul-in-fields": {
        "feedback_report": report({"User-Agent": "Agent\x00X"}),
        "sample": "From: a@example.com\nSubject: re\x00port\n\nbody",
    },
    "csv-quoting": {
        "feedback_report": report(
            {
                "Authentication-Results": 'mx; dkim=fail reason="bad, sig"',
                "Original-Mail-From": "a,b@example.com",
            }
        ),
        "sample": 'From: a@example.com\nSubject: "quoted", subject\n\nbody',
    },
}


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(f"{record.levelname}:{record.getMessage()}")


def _run(parsedmarc, original, feedback_report, sample, msg_date, options) -> dict:
    capture = _Capture()
    parsedmarc.logger.addHandler(capture)
    try:
        config = parsedmarc.ParserConfig(
            offline=True, always_use_local_files=True, **options
        )
        result = original(feedback_report, sample, msg_date, config=config)
        outcome = {
            "result": json.loads(json.dumps(result, default=str)),
            "rows": json.loads(
                json.dumps(
                    parsedmarc.parsed_failure_reports_to_csv_rows(result), default=str
                )
            ),
            "csv": parsedmarc.parsed_failure_reports_to_csv(result),
        }
        defects = outcome["result"]["parsed_sample"].get("defects_categories")
        if isinstance(defects, list):
            # A set in Python: iteration order is hash order.
            outcome["result"]["parsed_sample"]["defects_categories"] = sorted(defects)
    except Exception as error:  # noqa: BLE001 - the error is the expectation
        outcome = {"error": {"type": type(error).__name__, "message": str(error)}}
    finally:
        parsedmarc.logger.removeHandler(capture)
    outcome["logs"] = capture.records
    return outcome


def _write(name: str, fixture: dict) -> None:
    target = TARGET / f"{name}.json"
    target.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    if os.environ.get("TZ") != "UTC":
        os.environ["TZ"] = "UTC"
        time.tzset()

    import parsedmarc

    TARGET.mkdir(parents=True, exist_ok=True)
    for old in TARGET.glob("*.json"):
        old.unlink()

    original = parsedmarc.parse_failure_report
    captured: list[tuple] = []

    def recorder(feedback_report, sample, msg_date, **kwargs):
        captured.append((feedback_report, sample, msg_date))
        return original(feedback_report, sample, msg_date, **kwargs)

    count = 0
    parsedmarc.parse_failure_report = recorder
    try:
        for path in sorted(SAMPLES.glob("*.eml")):
            captured.clear()
            parsedmarc.parse_report_email(
                path.read_bytes(), offline=True, always_use_local_files=True
            )
            assert len(captured) == 1, path
            feedback_report, sample, msg_date = captured[0]
            name = "sample." + re.sub(r"[^A-Za-z0-9._-]+", "_", path.stem).strip("_")
            fixture = {
                "input": f"samples/failure/{path.name}",
                "feedback_report": feedback_report,
                "sample": sample,
                "msg_date": None if msg_date is None else msg_date.isoformat(),
                "options": {},
            }
            fixture.update(
                _run(parsedmarc, original, feedback_report, sample, msg_date, {})
            )
            _write(name, fixture)
            count += 1
    finally:
        parsedmarc.parse_failure_report = original

    for case_name, case in CASES.items():
        sample = case.get("sample", SAMPLE)
        msg_date = case.get("msg_date", MSG_DATE)
        options = case.get("options", {})
        fixture = {
            "input": f"case {case_name}",
            "feedback_report": case["feedback_report"],
            "sample": sample,
            "msg_date": None if msg_date is None else msg_date.isoformat(),
            "options": options,
        }
        fixture.update(
            _run(parsedmarc, original, case["feedback_report"], sample, msg_date, options)
        )
        _write(f"case.{case_name}", fixture)
        count += 1

    print(f"wrote {count} fixtures to {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
