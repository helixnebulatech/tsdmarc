"""Generate packages/tsdmarc/src/utils/py-codecs-data.ts from CPython.

tsdmarc decodes email text the way Python's codecs do (mail-parser and the
``email`` package rely on them). WHATWG ``TextDecoder`` disagrees with
Python on many charsets (``iso-8859-1`` is windows-1252 there, ``ascii`` is
not strict, undefined windows-125x bytes decode to C1 controls, ``gb2312`` is
GBK, ``euc-kr`` is windows-949...), and its CJK tables differ between Node
and Bun. So this script writes, read from CPython itself:

- Python's codec alias table;
- the decoding tables of Python's single-byte (charmap) codecs;
- the complete decoding tables of the CJK multibyte codecs, plus the few
  algorithmic pieces their decoders use (GB18030 four-byte ranges, the
  EUC-KR jamo make-up sequences).

Usage: .venv/bin/python tools/fixtures/generate_codecs.py
"""

from __future__ import annotations

import codecs
import encodings
import encodings.aliases
import importlib
import json
import pkgutil
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "utils" / "py-codecs-data.ts"

ASCII = "".join(chr(i) for i in range(128))

# Multibyte codecs shipped as tables, in dependency order. A codec with a
# base stores only what differs from the base codec's table.
MULTIBYTE_CODECS: dict[str, str | None] = {
    "big5": None,
    "cp950": "big5",
    "big5hkscs": "big5",
    "shift_jis": None,
    "cp932": "shift_jis",
    "euc_jp": None,
    "gb2312": None,
    "gbk": "gb2312",
    "gb18030": "gbk",
    "euc_kr": None,
    "cp949": "euc_kr",
}

FIRST_TRAIL = 0x40
ROW_WIDTH = 0x100 - FIRST_TRAIL
INVALID = " "  # never a decoded character (checked below)
INHERIT = "="  # same as the base codec
MULTI = "￿"  # the text is in `multi` (more than one character)


def _decode(data: bytes, codec: str) -> str | None:
    try:
        return data.decode(codec)
    except UnicodeDecodeError:
        return None


def _is_uhc(lead: int, trail: int) -> bool:
    """The Unified Hangul Code area of cp949 (computed by py-codecs.ts)."""
    if not 0x81 <= lead <= 0xC6:
        return False
    if 0x41 <= trail <= 0x5A or 0x61 <= trail <= 0x7A:
        return True
    return 0x81 <= trail <= (0xFE if lead <= 0xA0 else 0xA0)


def _table(codec: str) -> dict:
    single = ""
    pairs: dict[int, str | None] = {}
    for lead in range(0x80, 0x100):
        char = _decode(bytes([lead]), codec)
        if char is not None:
            assert len(char) == 1, (codec, lead)
            single += char
            continue
        single += INVALID
        for trail in range(0x100):
            text = _decode(bytes([lead, trail]), codec)
            if trail < FIRST_TRAIL:
                assert text is None, (codec, lead, trail)
                continue
            if text is not None:
                assert INVALID not in text and INHERIT not in text, (codec, lead, trail)
            pairs[(lead << 8) | trail] = text
    triples: dict[int, str | None] = {}
    if codec == "euc_jp":
        # JIS X 0212 behind the SS3 byte 0x8F.
        for second in range(0xA1, 0xFF):
            for third in range(0xA1, 0xFF):
                triples[(second << 8) | third] = _decode(bytes([0x8F, second, third]), codec)
    return {"single": single, "pairs": pairs, "triples": triples}


def _rows(
    pairs: dict[int, str | None],
    base: dict[int, str | None] | None,
    multi: dict[str, str],
    skip=lambda lead, trail: False,
) -> dict[str, str]:
    rows: dict[str, str] = {}
    leads = sorted({code >> 8 for code in pairs})
    for lead in leads:
        row = ""
        for trail in range(FIRST_TRAIL, 0x100):
            code = (lead << 8) | trail
            text = pairs.get(code)
            if skip(lead, trail):
                row += INVALID
            elif base is not None and code in base and base[code] == text:
                row += INHERIT
            elif text is None:
                row += INVALID
            elif len(text) == 1:
                row += text
            else:
                row += MULTI
                multi[f"{code:04x}"] = text
        filler = INHERIT if base is not None else INVALID
        row = row.rstrip(filler)
        if row:
            rows[f"{lead:02x}"] = row
    return rows


def _multibyte_tables() -> dict[str, dict]:
    raw = {codec: _table(codec) for codec in MULTIBYTE_CODECS}
    output = {}
    for codec, base_name in MULTIBYTE_CODECS.items():
        table = raw[codec]
        base = raw[base_name] if base_name else None
        multi: dict[str, str] = {}
        skip = (lambda lead, trail: _is_uhc(lead, trail)) if codec == "cp949" else (lambda lead, trail: False)
        if codec == "cp949":
            # Check the runtime algorithm: UHC holds, in order, the Hangul
            # syllables that euc_kr lacks.
            known = {text for text in raw["euc_kr"]["pairs"].values() if text}
            missing = [chr(c) for c in range(0xAC00, 0xD7A4) if chr(c) not in known]
            computed = [
                table["pairs"][(lead << 8) | trail]
                for lead in range(0x81, 0xC7)
                for trail in range(0x41, 0xFF)
                if _is_uhc(lead, trail)
            ]
            # The area ends at 0xC652; the rest of its last row is invalid.
            assert computed[: len(missing)] == missing, "cp949 UHC layout"
            assert not any(computed[len(missing) :]), "cp949 UHC end"
        entry: dict = {
            "single": "".join(
                INHERIT if base and base["single"][i] == ch else ch
                for i, ch in enumerate(table["single"])
            ),
            "rows": _rows(table["pairs"], base["pairs"] if base else None, multi, skip),
        }
        if base_name:
            entry["base"] = base_name
        if table["triples"]:
            entry["triples"] = _rows(table["triples"], None, multi)
        if multi:
            entry["multi"] = multi
        output[codec] = entry
    return output


def _gb18030_ranges() -> list[list[int]]:
    """``[linear index, first code point]`` runs of GB18030's four-byte BMP area."""
    ranges: list[list[int]] = []
    for index in range(39420):
        b1, rest = divmod(index, 12600)
        b2, rest = divmod(rest, 1260)
        b3, b4 = divmod(rest, 10)
        data = bytes([0x81 + b1, 0x30 + b2, 0x81 + b3, 0x30 + b4])
        text = data.decode("gb18030")
        assert len(text) == 1
        code = ord(text)
        if not ranges or code - index != ranges[-1][1] - ranges[-1][0]:
            ranges.append([index, code])
    # Past the table: invalid (39420 and up, below the supplementary area).
    assert _decode(bytes([0x84, 0x31, 0xA5, 0x30]), "gb18030") is None
    return ranges


def _euc_kr_jamo() -> dict[str, list[int]]:
    """Choseong and jongseong indexes of KS X 1001 Annex 3 make-up sequences."""
    choseong = []
    jongseong = []
    for byte in range(0xA1, 0xBF):
        text = _decode(bytes([0xA4, 0xD4, 0xA4, byte, 0xA4, 0xBF, 0xA4, 0xD4]), "euc_kr")
        choseong.append(-1 if text is None else (ord(text) - 0xAC00) // 588)
        text = _decode(bytes([0xA4, 0xD4, 0xA4, 0xA1, 0xA4, 0xBF, 0xA4, byte]), "euc_kr")
        jongseong.append(-1 if text is None else (ord(text) - 0xAC00) % 28)
    return {"choseong": choseong, "jongseong": jongseong}


def main() -> int:
    tables: dict[str, str] = {}
    text_codecs: list[str] = []
    for module in sorted(m.name for m in pkgutil.iter_modules(encodings.__path__)):
        if module in ("aliases", "mbcs", "oem", "cp65001"):
            continue
        try:
            info = codecs.lookup(module)
        except LookupError:
            continue
        if not info._is_text_encoding:
            continue
        text_codecs.append(module)
        mod = importlib.import_module(f"encodings.{module}")
        table = getattr(mod, "decoding_table", None)
        if isinstance(table, str) and len(table) == 256:
            # Most tables are ASCII-compatible: keep only the upper half.
            tables[module] = table[128:] if table[:128] == ASCII else table
    aliases = {
        alias: target
        for alias, target in sorted(encodings.aliases.aliases.items())
        if target in text_codecs
    }
    multibyte = _multibyte_tables()
    lines = [
        "// Generated by tools/fixtures/generate_codecs.py from CPython "
        f"{sys.version.split()[0]}. Do not edit.",
        "// Codec aliases and decoding data of Python's `encodings` package.",
        "",
        "/** Python codec module names that are text encodings. */",
        "export const PY_TEXT_CODECS: readonly string[] = "
        + json.dumps(text_codecs, ensure_ascii=True)
        + ";",
        "",
        "/** `encodings.aliases.aliases`, restricted to text encodings. */",
        "export const PY_CODEC_ALIASES: Readonly<Record<string, string>> = "
        + json.dumps(aliases, ensure_ascii=True, indent=2)
        + ";",
        "",
        "/**",
        " * Decoding tables of the charmap codecs. U+FFFE marks a byte the codec",
        " * cannot decode; 128-character tables cover bytes 0x80-0xFF of",
        " * ASCII-compatible codecs.",
        " */",
        "export const PY_CHARMAP_TABLES: Readonly<Record<string, string>> = "
        + _escape_controls(json.dumps(tables, ensure_ascii=False, indent=2))
        + ";",
        "",
        "/** Decoding table of a CJK multibyte codec (see py-codecs.ts). */",
        "export interface PyMultibyteTable {",
        "  /** Codec whose table this one patches (`=` entries inherit from it). */",
        "  readonly base?: string;",
        "  /** Bytes 0x80-0xFF decoded alone; a space is a lead (or invalid) byte. */",
        "  readonly single: string;",
        "  /**",
        "   * Two-byte sequences by lead byte (hex): one code point per trail byte",
        "   * from 0x40, a space where Python fails, U+FFFF where the text is in",
        "   * `multi`. Missing entries at the end are spaces (`=` with a base).",
        "   */",
        "  readonly rows: Readonly<Record<string, string>>;",
        "  /** EUC-JP's JIS X 0212 sequences (0x8F, second byte, third byte). */",
        "  readonly triples?: Readonly<Record<string, string>>;",
        "  /** Sequences (hex) that decode to more than one character. */",
        "  readonly multi?: Readonly<Record<string, string>>;",
        "}",
        "",
        "/** Python's CJK multibyte codecs (`_codecs_cn`, `_codecs_hk`, `_codecs_jp`...). */",
        "export const PY_MULTIBYTE_TABLES: Readonly<Record<string, PyMultibyteTable>> = "
        + _escape_controls(json.dumps(multibyte, ensure_ascii=False, sort_keys=True, indent=1))
        + ";",
        "",
        "/** GB18030 four-byte BMP area: `[linear index, first code point]` runs. */",
        "export const PY_GB18030_RANGES: readonly (readonly [number, number])[] = "
        + json.dumps(_gb18030_ranges(), separators=(",", ":"))
        + ";",
        "",
        "/**",
        " * EUC-KR (KS X 1001:1998 Annex 3) make-up sequences: syllable indexes of",
        " * jamo bytes 0xA1-0xBE (-1 where invalid).",
        " */",
        "export const PY_EUC_KR_JAMO: Readonly<Record<'choseong' | 'jongseong', readonly number[]>> = "
        + json.dumps(_euc_kr_jamo(), separators=(",", ":"))
        + ";",
        "",
    ]
    TARGET.write_text("\n".join(lines), encoding="utf-8")
    sizes = {codec: len(entry["rows"]) for codec, entry in multibyte.items()}
    print(f"wrote {TARGET} ({len(tables)} tables, {len(aliases)} aliases, rows {sizes})")
    return 0


def _escape_controls(text: str) -> str:
    """Keep C0/C1 controls, separators and non-characters out of the source."""
    return re.sub(
        r"[\x7f-\x9f­  -﻿￾￿\U000f0000-\U0010ffff]",
        lambda m: "".join(f"\\u{unit:04x}" for unit in _utf16(m.group())),
        text,
    )


def _utf16(char: str) -> list[int]:
    data = char.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(data[i : i + 2], "little") for i in range(0, len(data), 2)]


if __name__ == "__main__":
    raise SystemExit(main())
