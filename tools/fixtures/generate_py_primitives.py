"""Generate expected outputs of the Python primitives tsdmarc ports.

tsdmarc ports pieces of CPython (``binascii``, codecs, ``email.header``,
``email.utils``) and of mail-parser (date and address parsing). This script
runs the originals over deterministic pseudo-random and hand-picked inputs
and writes packages/tsdmarc/src/utils/__fixtures__/py-primitives.json, which
the unit tests replay against the ports.

Usage: .venv/bin/python tools/fixtures/generate_py_primitives.py
"""

from __future__ import annotations

import base64
import binascii
import email.header
import email.utils
import json
import random
from pathlib import Path

from mailparser.addresses import parse_address_header
from mailparser.dates import parse_mail_date
from mailparser.utils import _getaddresses

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "utils" / "__fixtures__" / "py-primitives.json"

rng = random.Random(20261024)


def outcome(function, *args):
    try:
        value = function(*args)
    except Exception as error:  # noqa: BLE001 - the error is the expectation
        return {"error": type(error).__name__, "message": str(error)}
    if isinstance(value, bytes):
        return {"hex": value.hex()}
    return {"value": value}


def base64_cases():
    alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    extra = b"=\n\r !-_.\x00\xff"
    cases = []
    for _ in range(400):
        length = rng.randint(0, 14)
        data = bytes(
            rng.choice(alphabet if rng.random() < 0.8 else extra) for _ in range(length)
        )
        cases.append(data)
    cases += [b"QQ==QQ==", b"QUI=Q", b"QUJD=QQ==", b"=QUI=", b"QU=I", b"", b"===="]
    # Padding-heavy inputs for strict mode's error messages, from their
    # own generator so the cases above stay the same.
    padding_rng = random.Random(1)
    padding_alphabet = b"ABab01+/=\n -_*"
    for _ in range(2000):
        length = padding_rng.randint(0, 12)
        cases.append(bytes(padding_rng.choice(padding_alphabet) for _ in range(length)))
    return [
        {
            "input": data.hex(),
            "lenient": outcome(binascii.a2b_base64, data),
            "strict": outcome(lambda d: binascii.a2b_base64(d, strict_mode=True), data),
        }
        for data in cases
    ]


def qp_cases():
    pieces = [b"=", b"=3D", b"=41", b"=4", b"=\n", b"=\r\n", b"=\r", b"_", b"a", b" ", b"\n",
              b"=zz", b"==", b"\xe9", b"=e9", b"=E9", b"\t"]
    cases = []
    for _ in range(200):
        cases.append(b"".join(rng.choice(pieces) for _ in range(rng.randint(0, 8))))
    return [
        {
            "input": data.hex(),
            "body": outcome(binascii.a2b_qp, data),
            "header": outcome(lambda d: binascii.a2b_qp(d, header=True), data),
        }
        for data in cases
    ]


def uu_cases():
    cases = [binascii.b2a_uu(bytes(rng.randrange(256) for _ in range(rng.randint(0, 45))))
             for _ in range(50)]
    cases += [b"", b"!", b"#86)C", b"#86)C\n", b"#86)C  \n", b"#86)Cxx\n", b"$86)C\n", b"\x7f", b"`\n"]
    return [{"input": data.hex(), "output": outcome(binascii.a2b_uu, data)} for data in cases]


CODECS = ["utf-8", "ascii", "latin-1", "iso-8859-1", "cp1252", "windows-1252", "iso-8859-2",
          "iso-8859-9", "iso-8859-15", "koi8-r", "koi8-u", "cp437", "utf-16", "utf-16-le",
          "utf-32", "utf-8-sig", "gb2312", "gbk", "big5", "shift_jis", "cp932", "euc-jp",
          "euc-kr", "cp949", "iso-2022-jp", "gb18030", "raw-unicode-escape", "mac-roman",
          "tis-620", "x-unknown", "base64", "UTF8", "Latin_1", "unknown-8bit", "utf_8"]
TEXTS = ["Café", "Привет", "日本語のテキスト", "中文文本", "€ 100", "한국어", "plain", "‘quotes’",
         "繁體中文", "ｶﾀｶﾅ", "\\u00e9 raw \\U0001f600"]


def codec_cases():
    cases = []
    for codec in CODECS:
        inputs = []
        for text in TEXTS:
            try:
                inputs.append(text.encode(codec))
            except (LookupError, UnicodeError):
                pass
        for _ in range(12):
            inputs.append(bytes(rng.randrange(256) for _ in range(rng.randint(1, 6))))
        for data in inputs:
            case = {"codec": codec, "input": data.hex()}
            for errors in ("strict", "replace", "ignore"):
                case[errors] = outcome(lambda d, e=errors: d.decode(codec, e), data)
            cases.append(case)
    return cases


HEADERS = [
    "plain text", "=?utf-8?q?caf=C3=A9?=", "=?utf-8?b?w6k=?= =?utf-8?b?w6k=?=",
    "pre =?iso-8859-1?q?caf=E9?= post", "Café =?utf-8?q?x?= 日本", "=?utf-8?b?A===?=",
    "=?x-unknown?q?abc?=", "a\n b =?utf-8?q?c?=\n\t=?utf-8?q?d?=", "=?UTF-8?Q?a_b?=",
    "=?utf-8*en?q?hi?=", "=?utf-8?q?a?==?utf-8?q?b?=", "=?bad", "x =?utf-8?b?eHh4eHg=�?=",
    "=?utf-8?q?=E2=82?=", "=?gb2312?b?1tDOxA==?=", "  lead\r\n trail  ",
]


def header_cases():
    cases = []
    for header in HEADERS:
        try:
            chunks = [
                [data if isinstance(data, str) else {"hex": data.hex()}, charset]
                for data, charset in email.header.decode_header(header)
            ]
            cases.append({"input": header, "chunks": chunks})
        except Exception as error:  # noqa: BLE001
            cases.append({"input": header, "error": type(error).__name__})
    return cases


ADDRESSES = [
    "a@example.com", "Alice <alice@example.com>", '"Doe, John" <john@example.com>',
    "bob@example.com (Bob)", "<angle@example.com>", "broken <", "not an address",
    "x@y@z.com", "Group: g1@example.com, g2@example.com;", "undisclosed-recipients:;",
    "a@[192.0.2.1]", '"weird local"@example.com', "Name <one@example.com> <two@example.com>",
    "", "a@b", "@route:a@b.com", "<@r1,@r2:x@y.com>", "(comment only)",
    "a@example.com,,b@example.com", 'Bad"Quote <q@x.com>', "Nested (a (b) c) <n@x.com>",
    "ünï@exämple.com", "Name\n <folded@example.com>", "=?utf-8?b?w4lsw6hu?= <e@example.com>",
    '"=?utf-8?b?w4lsw6hu?=" <q@example.com>', "a@example.com (=?utf-8?q?caf=C3=A9?=)",
    "Last, First <lf@example.com>", "a.b.@example.com", "a@b.c, d@e.f", "a <b@c.d> e",
]


def address_cases():
    cases = []
    for raw in ADDRESSES:
        for decode in (False, True):
            parsed, diagnostics = parse_address_header(raw, _getaddresses, decode_names=decode)
            cases.append({
                "input": raw,
                "decode_names": decode,
                "parsed": [list(pair) for pair in parsed],
                "diagnostics": diagnostics,
            })
        cases.append({"input": raw, "getaddresses": [list(p) for p in email.utils.getaddresses([raw])]})
    return cases


DATES = [
    "Tue, 30 Apr 2019 04:09:09 +0200", "30 Apr 2019 04:09:09 GMT", "Mon, 30 Apr 2019 04:09:09 -0430",
    "Tue, 31 Apr 2019 01:00:00 +0000", "1 Jan 49 00:00 PST", "garbage", "Tue, 30 Apr 2019 04:09:60 +0000",
    "Wed, 30 Apr 2019 01:00:00 EST", "Tue, 30 Apr 2019 04:09:09 +0960", "Tue, 30 Apr 2019 04:09:09+0200",
    "Tue, 30 Apr 2019 04:09:09 Z", "Tue, 30 Apr 2019 04:09:09 J", "Tue,30 Apr 2019 04:09 (UTC) +0000",
    "30 Apr 99999 04:09:09 +0000", "0 Jan 2019 00:00:00 +0000", "1 Jan 1899 00:00:00 +0000",
    "31 Dec 9999 23:59:59 -1200", "Fri, 29 Feb 2019 00:00:00 +0000", "Tue, 30 Apr 2019 04:09:09 +0015",
    "Tue, 30 Apr 2019 04:09:09 +0045", "Tue, 30 Apr 2019 04:09:09 -0015", "1 Jan 100 00:00 +0000",
    "1 Jan 0099 00:00 +0000", "Thu, 29 Feb 2024 12:00:00 -0001", "(c) 1 Jan 2020 00:00 +0000",
    "1 Jan 2020 00:00 +0000 (comment", "1 Jan 2020 00:00 +0000)", "1 jan 2020 00:00 ut",
    "1 Jan 2020 25:00 +0000", "1 Jan 2020 00:00:00 +12345", "",
]


def date_cases():
    cases = []
    for raw in DATES:
        result = parse_mail_date(raw)
        cases.append({
            "input": raw,
            "value": result.value.isoformat() if result.value else None,
            "timezone": result.timezone,
            "reasons": list(result.reasons),
        })
    return cases


def main() -> int:
    fixture = {
        "base64": base64_cases(),
        "qp": qp_cases(),
        "uu": uu_cases(),
        "codecs": codec_cases(),
        "decode_header": header_cases(),
        "addresses": address_cases(),
        "dates": date_cases(),
    }
    TARGET.write_text(json.dumps(fixture, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(f"wrote {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
