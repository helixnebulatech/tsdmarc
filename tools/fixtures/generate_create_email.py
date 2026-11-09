"""Generate the create_email differential fixture for tsdmarc's ``createEmail``.

Runs mailsuite's ``create_email`` over the cases below and writes
packages/tsdmarc/src/utils/__fixtures__/create-email.json, which
``create-email.test.ts`` replays. The Date header is pinned to ``DATE`` and
the random MIME boundary is replaced with ``BOUNDARY``.

Usage: .venv/bin/python -I tools/fixtures/generate_create_email.py
"""

import json
import re
from pathlib import Path

import mailsuite.utils as mailsuite_utils
from mailsuite.utils import create_email

mailsuite_utils.email.utils.formatdate = lambda *args, **kwargs: "DATE"

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "utils" / "__fixtures__" / "create-email.json"

BOUNDARY = re.compile(r'={15}\d{19}==')
long_ascii = 'DMARC report for example.com from 2024-01-01 00:00:00 to 2024-01-02 00:00:00 with a very long subject line that needs folding'
cases = [
    {"from": "a@b.c", "to": ["x@y.z"], "subject": "Hello", "plain": "hi"},
    {"from": "Jörg <j@x.de>", "to": ["Zoë <z@y>", "b@c"], "cc": ["Ç <c@d>"], "subject": "Résumé report for example.com", "plain": "héllo", "html": "<b>é</b>"},
    {"from": "a@b.c", "subject": "x", "att": [["rapport é.zip", "PK\u0003\u0004abc"]]},
    {"from": "a@b.c", "subject": "x", "att": [["we\"ird\\name.zip", "abc"]]},
    {"from": "a@b.c", "subject": long_ascii, "to": [f"recipient{i}@example.com" for i in range(8)]},
    {"from": "a@b.c", "subject": "averyveryveryveryveryveryveryveryveryveryveryveryveryveryveryveryveryveryveryverylongword short"},
    {"from": "a@b.c"},
    {"from": "a@b.c", "to": [], "cc": []},
    {"from": "a@b.c", "subject": "x", "headers": {"X-Custom": "v", "X-Uni": "ñandú", "X-Empty": ""}, "plain": "line1\r\nline2\rline3\n"},
    {"from": "a@b.c", "subject": "x\nBcc: evil@x"},
    {"from": "a@b.c", "subject": "x\r\nBcc: evil@x"},
    {"from": "a@b.c", "subject": "x\n continued"},
    {"from": "a@b.c", "subject": "ñ\nBcc: evil@x"},
    {"from": "a@b.c", "subject": "日本語のとても長い件名" * 4},
    {"from": "a@b.c", "subject": "x", "plain": "From me\n.\nend"},
    {"from": "a@b.c", "subject": "x", "att": [["a.zip", ""]]},
    {"from": "a@b.c", "subject": "x", "att": [["", "abc"]]},
    {"from": "a@b.c", "subject": "x", "html": "<p>only html</p>"},
    {"from": "a@b.c", "subject": "mixed ascii and ü in a long subject line that goes over the seventy eight char limit"},
    {"from": "a@b.c", "subject": "üüüüüüüüüüüüüüüüüü"},
    {"from": "a@b.c", "subject": "a b c ü"},
    {"from": "a@b.c", "subject": "x", "plain": "ünïcödé " * 40 + "\n", "att": [["big.bin", "".join(chr(i % 256) for i in range(1000))], ["c.csv", "a,b\r\n1,2\r\n"]]},
    {"from": "a@b.c", "subject": "emoji 😀 subject", "plain": "😀"},
    {"from": "a@b.c", "subject": "  leading and trailing  ", "plain": ""},
    {"from": "a@b.c", "subject": "x", "plain": "--" + "=" * 15 + "0000000000000000000==\n"},
]
out = []
for c in cases:
    try:
        r = create_email(c['from'], c.get('to'), c.get('cc'), c.get('subject'), c.get('headers'),
                         [(a[0], a[1].encode('latin1')) for a in c.get('att', [])], c.get('plain'), c.get('html'))
        out.append(BOUNDARY.sub('BOUNDARY', r))
    except Exception as e:
        out.append('ERR ' + type(e).__name__ + ': ' + str(e))
TARGET.write_text(json.dumps({'cases': cases, 'expected': out}, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
