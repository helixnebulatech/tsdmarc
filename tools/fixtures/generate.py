"""Generate reference fixtures from parsedmarc (Python) for tsdmarc's tests.

Runs parsedmarc 11.2.1 over every file in samples/ and writes, per sample,
fixtures/<relative sample path>.json with:

- "result": the parsed report ({"report_type", "report"}) as parsedmarc's
  JSON output, or "error": {"type", "message"} when parsing fails;
- "csv": the CSV that parsedmarc's parsed_*_reports_to_csv() produces for it.

Parsing is offline with bundled files only (no DNS, no downloads) so the
output is deterministic. Run with TZ=UTC (the npm script does), because
parsedmarc renders timestamps in local time.

Usage: pnpm fixtures   (needs .venv with parsedmarc: see tools/fixtures/README.md)
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"
FIXTURES = ROOT / "fixtures"


def main() -> int:
    if os.environ.get("TZ") != "UTC":
        os.environ["TZ"] = "UTC"
        time.tzset()

    import parsedmarc

    csv_writers = {
        "aggregate": parsedmarc.parsed_aggregate_reports_to_csv,
        "failure": parsedmarc.parsed_failure_reports_to_csv,
        "smtp_tls": parsedmarc.parsed_smtp_tls_reports_to_csv,
    }

    count = 0
    for sample in sorted(p for p in SAMPLES.rglob("*") if p.is_file()):
        relative = sample.relative_to(SAMPLES)
        fixture = {"sample": str(relative), "parsedmarc": parsedmarc.__version__}
        try:
            result = parsedmarc.parse_report_file(
                str(sample),
                offline=True,
                always_use_local_files=True,
                config=parsedmarc.ParserConfig(
                    offline=True, always_use_local_files=True
                ),
            )
            fixture["result"] = result
            fixture["csv"] = csv_writers[result["report_type"]](result["report"])
        except Exception as error:  # noqa: BLE001 - recorded as the expected outcome
            fixture["error"] = {"type": type(error).__name__, "message": str(error)}
        target = FIXTURES / f"{relative}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(fixture, indent=2, ensure_ascii=False, sort_keys=True, default=str)
            + "\n",
            encoding="utf-8",
        )
        count += 1
    print(f"wrote {count} fixtures to {FIXTURES.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
