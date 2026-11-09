"""Generate packages/tsdmarc/src/utils/__fixtures__/csv-reader.json.

Random short texts over the characters that drive Python's csv state
machine, with what `csv.reader` and `csv.DictReader` (over `io.StringIO`,
as parsedmarc reads a downloaded reverse DNS map) return or raise.

Usage: .venv/bin/python -I tools/fixtures/generate_csv_cases.py
"""

from __future__ import annotations

import csv
import io
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/tsdmarc/src/utils/__fixtures__/csv-reader.json"
ALPHABET = ["a", "b", ",", '"', "\n", "\r", " ", "\r\n"]


def main() -> None:
    rng = random.Random(1)
    cases = []
    for _ in range(2000):
        text = "".join(rng.choice(ALPHABET) for _ in range(rng.randint(0, 12)))
        try:
            rows = list(csv.reader(io.StringIO(text)))
        except csv.Error as error:
            rows = f"ERR {error}"
        try:
            dicts = [
                {("__None__" if key is None else key): value for key, value in row.items()}
                for row in csv.DictReader(io.StringIO(text))
            ]
        except csv.Error as error:
            dicts = f"ERR {error}"
        cases.append([text, rows, dicts])
    OUT.write_text(json.dumps(cases, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
