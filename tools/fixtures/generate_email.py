"""Generate expected parse_email() output for tsdmarc's differential tests.

For every input below, runs parsedmarc's ``parse_email()`` (with the
mail-parser and Python ``email`` package installed in .venv) and writes the
result to packages/tsdmarc/src/utils/__fixtures__/email/expected/<name>.json:

- every ``.eml`` file under samples/ (parsed from its bytes);
- every ``message/rfc822`` and ``text/rfc822-headers`` part of those files,
  written out as ``__fixtures__/email/inputs/<name>`` first (that is the
  sample a failure report carries);
- the hand-made edge cases in ``__fixtures__/email/cases/*.eml``.

Each fixture is ``{"result": ...}`` or ``{"error": {"type", "message"}}``,
plus the input file it was generated from. Run with:

    .venv/bin/python tools/fixtures/generate_email.py
"""

from __future__ import annotations

import email
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"
FIXTURES = ROOT / "packages" / "tsdmarc" / "src" / "utils" / "__fixtures__" / "email"
CASES = FIXTURES / "cases"
INPUTS = FIXTURES / "inputs"
EXPECTED = FIXTURES / "expected"

SAMPLE_PART_TYPES = ("message/rfc822", "text/rfc822-headers")


def _safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("_")


def _run(data: bytes | str, strip: bool = False) -> dict:
    from parsedmarc.utils import parse_email

    try:
        result = parse_email(data, strip_attachment_payloads=strip)
    except Exception as error:  # noqa: BLE001 - the error is the expectation
        return {"error": {"type": type(error).__name__, "message": str(error)}}
    # Sets are serialized in hash order; sort them for stable fixtures.
    for key in ("to_domains", "defects_categories"):
        if isinstance(result.get(key), list):
            result[key] = sorted(result[key])
    return {"result": result}


def _write(name: str, source: str, fixture: dict) -> None:
    fixture = {"input": source, **fixture}
    target = EXPECTED / f"{name}.json"
    target.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        # Stable set iteration order while generating.
        os.environ["PYTHONHASHSEED"] = "0"
        os.execv(sys.executable, [sys.executable, *sys.argv])
    EXPECTED.mkdir(parents=True, exist_ok=True)
    INPUTS.mkdir(parents=True, exist_ok=True)
    for old in EXPECTED.glob("*.json"):
        old.unlink()
    for old in INPUTS.glob("*"):
        old.unlink()

    count = 0
    for sample in sorted(SAMPLES.rglob("*.eml")):
        relative = sample.relative_to(SAMPLES)
        base = _safe_name(str(relative))
        data = sample.read_bytes()
        _write(base, f"samples/{relative}", _run(data))
        count += 1
        message = email.message_from_bytes(data)
        for index, part in enumerate(message.walk()):
            if part.get_content_type() not in SAMPLE_PART_TYPES:
                continue
            payload = part.get_payload()
            text = str(payload[0]) if isinstance(payload, list) else str(payload)
            part_bytes = text.encode("utf-8", "surrogateescape")
            name = f"{base}.part{index}"
            (INPUTS / f"{name}.eml").write_bytes(part_bytes)
            _write(name, f"inputs/{name}.eml", _run(part_bytes))
            count += 1

    for case in sorted(CASES.glob("*.eml")):
        data = case.read_bytes()
        name = f"case.{case.stem}"
        _write(name, f"cases/{case.name}", _run(data))
        count += 1
        if case.stem.startswith("attachments"):
            _write(f"{name}.stripped", f"cases/{case.name}", _run(data, strip=True))
            count += 1

    print(f"wrote {count} fixtures to {EXPECTED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
