"""Generate the dateutil differential corpus for tsdmarc's ``parseDate``.

parsedmarc parses report and email dates with ``dateutil.parser.parse``;
tsdmarc ports it (``packages/tsdmarc/src/utils/timestamps.ts``). This script
runs dateutil over deterministic pseudo-random date strings (structured
formats, hand-picked edge cases and token soup) and writes
packages/tsdmarc/src/utils/__fixtures__/dateutil-corpus.json, which
``timestamps.corpus.test.ts`` replays against the port.

The default datetime and the two-digit-year pivot are pinned (2026-01-31,
year 2026) so the output does not depend on today. The corpus is generated
under two time zones because dateutil turns a zone name in ``time.tzname``
into the local zone.

Usage: .venv/bin/python -I tools/fixtures/generate_dateutil.py
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import warnings
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "utils" / "__fixtures__" / "dateutil-corpus.json"

DEFAULT = datetime(2026, 1, 31)
CURRENT_YEAR = 2026
ZONES = ("UTC", "America/New_York", "Europe/London", "Europe/Madrid", "Australia/Sydney", "Asia/Kolkata")

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Monday", "Tuesday",
            "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
ZONE_NAMES = ["Z", "z", "UTC", "GMT", "UT", "gmt", "utc", "EST", "EDT", "CEST",
              "CET", "PST", "BRST", "ABCDEF", "Utc", "BST", "AEST", "AEDT", "IST", "WET"]


def run(value: str) -> list[str]:
    from dateutil import parser
    from dateutil.parser import ParserError

    parser.DEFAULTPARSER.info._year = CURRENT_YEAR
    parser.DEFAULTPARSER.info._century = CURRENT_YEAR // 100 * 100
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            result = parser.parse(value, default=DEFAULT)
        except ParserError as error:
            return ["ParserError", str(error)]
        except Exception as error:  # noqa: BLE001 - the error is the expectation
            return [type(error).__name__, str(error)]
    try:
        return ["ok", result.isoformat()]
    except Exception as error:  # noqa: BLE001 - offsets over 24 h fail on use
        return ["late:" + type(error).__name__, str(error)]


def structured(rng: random.Random) -> list[str]:
    def year() -> int:
        return rng.choice([rng.randint(1970, 2040)] * 6 + [rng.randint(0, 99), 1, 9999, 0, 10000, 1900, 2000])

    def two(value: int) -> str:
        return f"{value:02d}"

    def date() -> str:
        y = year()
        m = rng.choice([rng.randint(1, 12)] * 8 + [0, 13])
        d = rng.choice([rng.randint(1, 28)] * 6 + [29, 30, 31, 0, 32])
        yy = y % 100
        mon = MONTHS[(m - 1) % 12]
        month = LONG_MONTHS[(m - 1) % 12]
        weekday = rng.choice(WEEKDAYS)
        suffix = rng.choice(["st", "nd", "rd", "th"])
        forms = [
            f"{y:04d}-{two(m)}-{two(d)}", f"{y}-{m}-{d}", f"{y:04d}{two(m)}{two(d)}",
            f"{m}/{d}/{y}", f"{two(m)}/{two(d)}/{two(yy)}", f"{d}.{m}.{y}", f"{d}-{m}-{y}",
            f"{two(d)}-{two(m)}-{y}", f"{d} {mon} {y}", f"{mon} {d}, {y}", f"{month} {d}{suffix} {y}",
            f"{month} {d}{suffix}, {y}", f"{d}-{mon}-{two(yy)}", f"{weekday}, {d} {mon} {y}",
            f"{mon} {two(d)} {y}", f"{y}/{m}/{d}", f"{mon} {y}", f"{month}, {y}", f"{y}-{two(m)}",
            f"{d} of {month} {y}", f"{month} of {two(yy)}", f"{weekday} {mon} {d} {y}",
            f"{mon}-{d}-{y}", f"{mon}/{d}/{two(yy)}", f"{y}-{mon}-{d}", f"{d}/{m}/{y}",
            f"{two(yy)}{two(m)}{two(d)}", f"{d} {mon}", f"{mon} {d}", f"{weekday}", f"{m} {d} {y}",
            f"{d} {m} {two(yy)}", f"{y}.{two(m)}.{two(d)}", f"{mon}. {d}, {y}", f"{d}{mon}{y}",
        ]
        return rng.choice(forms)

    def time() -> str:
        h = rng.choice([rng.randint(0, 23)] * 8 + [24, 25])
        mi = rng.choice([rng.randint(0, 59)] * 8 + [60])
        s = rng.choice([rng.randint(0, 59)] * 8 + [60])
        h12 = rng.randint(0, 13)
        frac = "".join(rng.choice("0123456789") for _ in range(rng.randint(1, 9)))
        ampm = rng.choice(["AM", "PM", "am", "pm", "a.m.", "p.m.", "A", "p"])
        forms = [
            "", "", f"{two(h)}:{two(mi)}", f"{h}:{mi}:{s}", f"{two(h)}:{two(mi)}:{two(s)}",
            f"{two(h)}:{two(mi)}:{two(s)}.{frac}", f"{two(h)}:{two(mi)}:{two(s)},{frac}",
            f"{h12}:{two(mi)} {ampm}", f"{h12}{ampm}", f"{h12} {ampm}", f"{two(h)}{two(mi)}{two(s)}",
            f"{h}h{mi}m", f"{h}h", f"{h}h{mi}m{s}s", f"{h}:{two(mi)}:{two(s)}.{frac} {ampm}",
            f"{two(h)}", f"{two(h)}{two(mi)}", f"{h}.{frac}h", f"{mi}.{frac} minutes",
        ]
        return rng.choice(forms)

    def zone() -> str:
        sign = rng.choice("+-")
        hh = rng.choice([rng.randint(0, 14)] * 6 + [23, 24, 99])
        mm = rng.choice([0, 0, 30, 45, 99])
        name = rng.choice(ZONE_NAMES)
        forms = [
            "", "", "", name, f"{sign}{two(hh)}{two(mm)}", f"{sign}{two(hh)}:{two(mm)}",
            f"{sign}{hh}", f"{name}{sign}{hh}", f"{name}{sign}{two(hh)}{two(mm)}",
            f"{sign}{two(hh)}{two(mm)} ({name})", f"{sign}{two(hh)}{two(mm)} {name}",
            f"GMT{sign}{two(hh)}{two(mm)} ({name})", f"{name} {sign}{two(hh)}{two(mm)}",
            f"{sign}{two(hh)}{two(mm)}{two(mm)}", f"{sign}{hh}{mm}",
        ]
        return rng.choice(forms)

    out = []
    for _ in range(4000):
        d, t, z = date(), time(), zone()
        layout = rng.randrange(6)
        if layout == 0:
            text = f"{d}T{t}{z}" if t else f"{d}{z}"
        elif layout == 1:
            text = f"{t} {d} {z}"
        elif layout == 2:
            text = f"{d}, {t} {z}"
        elif layout == 3:
            text = f"{d} at {t}{z}"
        else:
            text = f"{d} {t} {z}"
        out.append(" ".join(text.split()) if rng.random() < 0.8 else text)
    return out


def realistic(rng: random.Random) -> list[str]:
    """Valid dates in the shapes reports and emails use, across the year."""
    out = []
    for _ in range(2500):
        y = rng.choice([rng.randint(1995, 2035)] * 9 + [rng.randint(1, 1900)])
        m = rng.randint(1, 12)
        d = rng.randint(1, 28 if m == 2 else 30)
        h, mi, s = rng.randint(0, 23), rng.randint(0, 59), rng.randint(0, 59)
        us = "".join(rng.choice("0123456789") for _ in range(rng.choice([1, 3, 6])))
        mon, month = MONTHS[m - 1], LONG_MONTHS[m - 1]
        weekday = rng.choice(WEEKDAYS[:7])
        sign = rng.choice("+-")
        oh, om = rng.randint(0, 12), rng.choice([0, 0, 0, 30, 45])
        zone = rng.choice(
            ["", f"{sign}{oh:02d}{om:02d}", f"{sign}{oh:02d}:{om:02d}", "Z", "UTC", "GMT"]
            + [rng.choice(ZONE_NAMES)]
            + [f"{sign}{oh:02d}{om:02d} ({rng.choice(ZONE_NAMES)})", f"GMT{sign}{oh}", f"UTC{sign}{oh}"]
        )
        forms = [
            f"{weekday}, {d} {mon} {y} {h:02d}:{mi:02d}:{s:02d} {zone}",
            f"{weekday}, {d:02d} {mon} {y} {h:02d}:{mi:02d}:{s:02d} {zone}",
            f"{d} {mon} {y} {h:02d}:{mi:02d} {zone}",
            f"{y:04d}-{m:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}{zone.split(' ')[0]}",
            f"{y:04d}-{m:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}.{us}{zone.split(' ')[0]}",
            f"{y:04d}-{m:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d}",
            f"{y:04d}-{m:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d} {zone}",
            f"{y:04d}-{m:02d}-{d:02d}",
            f"{y:04d}{m:02d}{d:02d}T{h:02d}{mi:02d}{s:02d}{zone.split(' ')[0]}",
            f"{m}/{d}/{y} {(h % 12) or 12}:{mi:02d}:{s:02d} {'AM' if h < 12 else 'PM'}",
            f"{m:02d}/{d:02d}/{y % 100:02d} {h:02d}:{mi:02d}",
            f"{d:02d}.{m:02d}.{y} {h:02d}:{mi:02d}",
            f"{mon} {d}, {y} {(h % 12) or 12}:{mi:02d} {'am' if h < 12 else 'pm'}",
            f"{month} {d}, {y} at {h}:{mi:02d}",
            f"{weekday} {mon} {d:2d} {h:02d}:{mi:02d}:{s:02d} {y}",
            f"{weekday} {mon} {d:02d} {y} {h:02d}:{mi:02d}:{s:02d} GMT{sign}{oh:02d}{om:02d} ({rng.choice(ZONE_NAMES)})",
            f"{d}-{mon}-{y} {h:02d}:{mi:02d}:{s:02d}",
            f"{y}-{m}-{d} {h}:{mi}:{s}",
        ]
        out.append(rng.choice(forms).strip())
    return out


def soup(rng: random.Random) -> list[str]:
    pieces = (
        [str(rng.randint(0, 10**n)) for n in range(1, 15) for _ in range(3)]
        + ["0", "00", "01", "1", "12", "13", "23", "24", "31", "32", "99", "100", "101", "2024",
           "10.5", "1,5", "10,5", "12.30", "1.2.3", "0.5", "123456.78"]
        + MONTHS + LONG_MONTHS[:4] + WEEKDAYS[:5] + ZONE_NAMES
        + ["am", "pm", "a.m.", "AM", "PM", "a", "p", "at", "on", "of", "and", "ad", "m", "t", "T",
           "st", "nd", "rd", "th", "h", "s", "hour", "minutes", "seconds", "sept", "MAY", "may"]
        + [" ", " ", " ", "-", "/", ".", ",", ":", ":", "+", "-", "(", ")", ";", "'", "_", "\t"]
        + ["٣", "２", "²", " ", "　", "\x1c", "﻿", "\x00", "é",
           "ß", "inf", "nan", "Infinity", "\U0001d7d9", "١٢", "x", "abc"]
    )
    out = []
    for _ in range(3000):
        count = rng.randint(1, 9)
        out.append("".join(rng.choice(pieces) for _ in range(count)))
    return out


HAND_PICKED = [
    "", " ", "at", "-", "foo", "Feb 2024", "Apr 2025", "2024-02", "February", "Feb", "1 2 3",
    "13 2 3", "1 13 3", "32 1 2", "GMT+1", "10:00 GMT+1", "10:00 UTC+1", "10:00 GMT-0300",
    "10:00 BRST+3", "Jan 01 2024 10:00:00 GMT+0000 (UTC)", "01-01-2024", "2024-1-1 1:2:3",
    "2024-01-01T10Z", "January 1st 2024", "10:00:00,5", "2024-01-01 10:00 +0000 UTC",
    "2024-01-01 10:00 gmt", "2024-01-01 10:00 ut", "2024-01-01 10:00 UT", "2024-01-01 10:00 z",
    "Mon, 01 Jan 2024 00:00:00 +0000 (UTC)", "Tue, 30 Apr 2019 02:09:00 +0000",
    "Thu, 13 Sep 2018 13:50:16 -0400", "Sep 5, 2018 4:12 PM", "2-Jan-2024", "20240102",
    "2018-09-29 06:02:22.5", "January 1, 2024 at 10:00", "2019-04-30T02:09:00+0000",
    "2024-02-30 00:00:00", "2024-13-01", "2024-01-01 25:00:00", "99999999999", "2024-01-01 10:00 +2500",
    "2024-01-01 10:00 -2400", "Monday", "Sat", "9999-12-31 Mon", "12 am", "12am", "0 pm",
    "13 pm", "10 am am", "10:00 PM", "Jan of 05", "Jan of 2005", "19990101T2359", "19990101T235959.5",
    "990101", "235959.123", "1999-01-01T23", "12h30", "12 h 30", "12h04m05s", "10.5h", "1.5 m",
    "2024-01-01 10:00:00.1234567", "10:00:00.", "inf", "nan", "2024 inf", "1/2", "13/1", "1/13",
    "2024/1", "1/2024", "99-01", "01-99", "Apr-2003-25", "99-Jan-01", "01-Jan-01", "01-99-Jan",
    "99-01-Jan", "١٩٩٩-٠١-٠٢", "２０２４",
    "2024²", "2024-01-01 10:00", "\x1c2024-01-01", "﻿2024-01-01", "2024-01-01\x00",
    "Sep.20.2009", "4:30:21.447", "a.m.", "10 a.m.", "10 p.m. EST", "2024-07-01 10:00 EST",
    "2024-07-01 10:00 EDT", "2024-01-01 10:00 EDT", "2024-11-03 01:30 EST", "2024-11-03 01:30 EDT",
    "2024-03-10 02:30 EST", "2024-03-10 02:30 EDT", "2024-07-01 10:00 GMT", "2024-07-01 10:00 UTC",
    "Feb 29", "Feb 30", "Thu 2024", "2024-01-01 10:00 -03:00 (BRST)", "10:00 - 0300",
    "2024-01-01 10:00 +", "2024-01-01 10:00 +030", "2024-01-01 10:00 +3:30", "0001-01-01", "0000-01-01",
    "2024-01-01 10:00 EST+5", "Jan 2024 Feb", "2024 2025", "1 2 3 4", "2024-01-01 Mon",
    "Wed, 5 Sep 2018 16:12:41 +0200 (CEST)", "2024-01-01 00:00:00 EST", "01/02/24 10:00",
    # A weekday alone or with a time moves the default date forward to it.
    "Tue", "Fri 10:00", "Friday at 10:00", "Sun 23:59:59 +0200", "Saturday", "Mon Feb",
    "Thu 2024-01-01", "Wed 10:00 EST",
    # int() refuses strings over 4300 digits; Decimal and int(Decimal) don't.
    "1" * 4300 + " 2024", "1" * 4301 + " 2024", "Jan " + "1" * 5000, "1" * 5000 + ".5",
]


def corpus() -> list[str]:
    rng = random.Random(20261024)
    seen: set[str] = set()
    out: list[str] = []
    for value in HAND_PICKED + realistic(rng) + structured(rng) + soup(rng):
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--run":
        values = json.load(sys.stdin)
        json.dump([[value, *run(value)] for value in values], sys.stdout, ensure_ascii=False)
        return
    values = corpus()
    results = {}
    for zone in ZONES:
        output = subprocess.run(
            [sys.executable, "-I", __file__, "--run"],
            input=json.dumps(values), capture_output=True, text=True, check=True,
            env={**os.environ, "TZ": zone},
        ).stdout
        results[zone] = json.loads(output)
    base, *others = ZONES
    # One line per case; other zones only list the cases whose result differs.
    zone_lines = []
    for zone in others:
        diffs = {
            str(index): case[1:]
            for index, case in enumerate(results[zone])
            if case != results[base][index]
        }
        zone_lines.append(f"{json.dumps(zone)}: {json.dumps(diffs, ensure_ascii=False)}")
    lines = [
        "{",
        f'"default": {json.dumps(DEFAULT.isoformat())},',
        f'"currentYear": {CURRENT_YEAR},',
        f'"zone": {json.dumps(base)},',
        '"cases": [',
        ",\n".join(json.dumps(case, ensure_ascii=False) for case in results[base]),
        "],",
        '"otherZones": {',
        ",\n".join(zone_lines),
        "}",
        "}",
    ]
    TARGET.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(values)} strings x {len(ZONES)} zones -> {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
