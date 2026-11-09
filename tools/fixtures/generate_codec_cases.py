"""Generate packages/tsdmarc/src/utils/__fixtures__/py-codecs.json.

Differential cases for py-codecs.ts: random and structured byte strings for
each codec tsdmarc ports, decoded by CPython with every error handler the
email code uses. Each case is ``[codec, hex, strict, replace, ignore,
backslashreplace, surrogateescape]``; an outcome is the decoded text, or
``{"error": message}``.

Usage: .venv/bin/python tools/fixtures/generate_codec_cases.py
"""

from __future__ import annotations

import json
import re
import sys
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "utils" / "__fixtures__" / "py-codecs.json"
# Larger local fuzz runs: generate_codec_cases.py <cases per codec> <output> <seed>
if len(sys.argv) > 1:
    TARGET = Path(sys.argv[2])

HANDLERS = ("strict", "replace", "ignore", "backslashreplace", "surrogateescape")
CASES_PER_CODEC = int(sys.argv[1]) if len(sys.argv) > 1 else 64

rng = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 20261024)

# Characters to build valid text from (whatever each codec can encode).
POOL = (
    [chr(c) for c in range(0x20, 0x7F)]
    + [chr(c) for c in range(0xA0, 0x180)]
    + [chr(c) for c in range(0x370, 0x3D0)]
    + [chr(c) for c in range(0x400, 0x460)]
    + [chr(c) for c in range(0x2010, 0x2040)]
    + [chr(c) for c in range(0x3000, 0x3100)]
    + [chr(c) for c in range(0x3130, 0x3190)]
    + [chr(rng.randrange(0x4E00, 0x9FB0)) for _ in range(3000)]
    + [chr(rng.randrange(0xAC00, 0xD7A4)) for _ in range(1500)]
    + [chr(c) for c in range(0xFF00, 0xFFF0)]
    + [chr(c) for c in range(0xE000, 0xE100)]
    + [chr(rng.randrange(0x20000, 0x2A6D0)) for _ in range(300)]
    + ["\U0001F600", "€", "¥", "‾", "〜", "～", "∥", "－"]
)

CODECS = [
    "big5", "cp950", "big5hkscs", "gb2312", "gbk", "gb18030", "hz", "euc_kr", "cp949",
    "euc_jp", "shift_jis", "cp932", "iso2022_jp", "iso2022_jp_1", "iso2022_jp_ext",
    "utf_7", "utf_8", "ascii", "latin_1", "cp1252", "utf_16",
]


def encodable(codec: str) -> list[str]:
    chars = []
    for char in POOL:
        try:
            char.encode(codec)
        except UnicodeEncodeError:
            continue
        chars.append(char)
    return chars


def valid_text(codec: str, chars: list[str]) -> bytes:
    text = "".join(rng.choice(chars) for _ in range(rng.randint(1, 6)))
    return text.encode(codec)


SPECIAL = {
    "hz": [b"~{", b"~}", b"~~", b"~\n", b"~", b"\n", b"\x30\x21", b"\x21", b"\x7f", b"\xa1"],
    "utf_7": [b"+", b"-", b"+-", b"+AOQ", b"+2D3cAA", b"+2D0", b"A", b"/", b".", b"\x80", b"\\", b"~",
              b"+AAA", b"+AB", b"+AOQ-", b"!"],
    "iso2022_jp": [b"\x1b$B", b"\x1b(B", b"\x1b(J", b"\x1b(I", b"\x1b$@", b"\x1b$(D", b"\x1b&@\x1b$B",
                   b"\x1b$A", b"\x1b", b"\x1bx", b"\x1b(", b"\x0e", b"\x0f", b"\n", b" ", b"\x7f",
                   b"$\"", b"!@", b"\\", b"~", b"\x80", b"0!", b"\x1b.A", b"\x1bN"],
    "euc_kr": [b"\xa4\xd4", b"\xa4\xa1", b"\xa4\xbf", b"\xa4\xd4\xa4\xa1\xa4\xbf\xa4\xd4", b"\xa4"],
    "gb18030": [b"\x81\x30\x81\x30", b"\x84\x31\xa4\x39", b"\x90\x30\x81\x30", b"\xe3\x32\x9a\x35",
                b"\x84\x31\xa5\x30", b"\x81\x30", b"\x80", b"\xff"],
    "euc_jp": [b"\x8f\xa2\xaf", b"\x8f", b"\x8e\xa1", b"\x8e", b"\xa1\xc0"],
}
SPECIAL["iso2022_jp_1"] = SPECIAL["iso2022_jp"]
SPECIAL["iso2022_jp_ext"] = SPECIAL["iso2022_jp"]


def random_bytes(codec: str, chars: list[str]) -> bytes:
    pieces = []
    for _ in range(rng.randint(1, 6)):
        roll = rng.random()
        if roll < 0.3 and codec in SPECIAL:
            pieces.append(rng.choice(SPECIAL[codec]))
        elif roll < 0.55:
            pieces.append(valid_text(codec, chars))
        elif roll < 0.8:
            pieces.append(bytes([rng.randrange(0x80, 0x100)]))
        else:
            pieces.append(bytes([rng.randrange(0x100)]))
    return b"".join(pieces)


def outcome(data: bytes, codec: str, errors: str):
    try:
        return data.decode(codec, errors)
    except UnicodeDecodeError as error:
        return {"error": str(error)}


def main() -> int:
    cases = []
    for codec in CODECS:
        chars = encodable(codec)
        inputs = []
        for index in range(CASES_PER_CODEC):
            inputs.append(valid_text(codec, chars) if index % 4 == 0 else random_bytes(codec, chars))
        for data in inputs:
            cases.append([codec, data.hex(), *(outcome(data, codec, errors) for errors in HANDLERS)])
    text = json.dumps(cases, ensure_ascii=False, separators=(",", ":"))
    # Keep surrogates (surrogateescape), controls and specials escaped.
    text = re.sub(r"[\x7f-\x9f\u00ad\u2028\u2029\ud800-\udfff\ue000-\uf8ff\ufeff\ufff0-\uffff]", lambda m: f"\\u{ord(m.group()):04x}", text)
    TARGET.write_text(text.replace("],[", "],\n[") + "\n", encoding="utf-8")
    print(f"wrote {TARGET} ({len(cases)} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
