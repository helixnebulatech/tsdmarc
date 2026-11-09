"""Generate the differential corpus for tsdmarc's XML layer (src/xml).

parsedmarc's parse_aggregate_report_xml() (11.2.1) runs, on every report:

    xmltodict.parse(xml, expat=_NoDoctypeExpat)              # pyexpat
    # A DOCTYPE aborts the parse as soon as expat reaches it (rejected).
    # When the parse fails otherwise (or the root is not <feedback>):
    tree = etree.parse(BytesIO(xml.encode("utf-8")),
                       etree.XMLParser(recover=True, resolve_entities=False))
    root = tree.getroot()        # None -> xml = ""
    # A DOCTYPE in the recovered tree is rejected too; otherwise:
    xml = str(etree.tostring(root, encoding="unicode"))
    # (any exception -> xml = "<a/>"), then xmltodict.parse(xml) again.

For each input this script records, with the real libraries:

- "parse": {"dict": <xmltodict result>} or {"error": "<Type>: <message>"},
  from a plain xmltodict.parse() (expat's own behavior, DOCTYPE included);
- "doctype": true when parsedmarc's DOCTYPE-rejecting parse aborts on it;
- "recovered": the text the lxml recovery produces ("" without a root,
  "<a/>" when lxml raises), or "recovered_doctype": true when the recovered
  tree has a DOCTYPE (parsedmarc rejects the report);
- "recovered_parse": the same as "parse", for the recovered text.

Large results are stored as the SHA-256 of their compact JSON ("dict_sha256")
to keep the fixture small.

Inputs: every XML in samples/ (also inside .zip/.gz/.eml), hand-written edge
cases, seeded mutations of small real reports (truncation, dropped or
duplicated tags, unescaped & and <, control characters, BOMs, CRLF, ...),
seeded random token soup, and seeded random well-formed documents.

Usage: .venv/bin/python -I tools/fixtures/generate_xml.py
Writes packages/tsdmarc/src/xml/__fixtures__/xml-differential.json.
"""

from __future__ import annotations

import email
import hashlib
import json
import random
import sys
from io import BytesIO
from pathlib import Path

import xmltodict
from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"
OUTPUT = ROOT / "packages" / "tsdmarc" / "src" / "xml" / "__fixtures__" / "xml-differential.json"
SEED = 20261024
LARGE = 64 * 1024


def compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def parse(text: str) -> dict:
    try:
        result = xmltodict.parse(text)
    except Exception as error:  # noqa: BLE001 - every error class is data here
        return {"error": f"{type(error).__name__}: {error}"}
    encoded = compact(result)
    if len(encoded) > LARGE:
        return {"dict_sha256": hashlib.sha256(encoded.encode("utf-8")).hexdigest()}
    return {"dict": result}


class _DoctypeFound(Exception):
    pass


def recover(text: str) -> str | None:
    """parsedmarc's recovery; None when the recovered tree has a DOCTYPE."""
    try:
        tree = etree.parse(
            BytesIO(text.encode("utf-8")),
            etree.XMLParser(recover=True, resolve_entities=False),
        )
        root = tree.getroot()
        if root is None:
            return ""
        if bool(tree.docinfo.doctype) or tree.docinfo.internalDTD is not None:
            return None
        return str(etree.tostring(root, encoding="unicode"))
    except Exception:  # noqa: BLE001 - parsedmarc's own fallback
        return "<a/>"


def doctype_rejected(text: str) -> bool:
    """Whether parsedmarc's first parse aborts on a DOCTYPE."""
    from parsedmarc import _NoDoctypeExpat, _XMLDoctypeFound

    try:
        xmltodict.parse(text, expat=_NoDoctypeExpat)
    except _XMLDoctypeFound:
        return True
    except Exception:  # noqa: BLE001 - any other outcome is in "parse"
        return False
    return False


# ---------------------------------------------------------------------------
# Inputs


def sample_inputs() -> list[tuple[str, str]]:
    import parsedmarc

    cases: list[tuple[str, str]] = []
    for path in sorted(SAMPLES.rglob("*")):
        if not path.is_file():
            continue
        name = str(path.relative_to(ROOT))
        data = path.read_bytes()
        if path.suffix == ".eml":
            message = email.message_from_bytes(data)
            for index, part in enumerate(message.walk()):
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                try:
                    text = parsedmarc.extract_report(payload)
                except Exception:  # noqa: BLE001 - not a report attachment
                    continue
                if text.lstrip("﻿ \r\n\t").startswith("<"):
                    cases.append((f"{name}#part{index}", text))
            continue
        if path.suffix not in {".xml", ".gz", ".zip"}:
            continue
        try:
            text = parsedmarc.extract_report(data)
        except Exception:  # noqa: BLE001 - recorded as-is below when it is XML
            text = data.decode(errors="ignore")
        if path.suffix == ".xml" or text.lstrip().startswith("<"):
            cases.append((name, text))
    return cases


HANDMADE: list[str] = [
    # Encodings, BOMs, NULs, surrogates.
    "",
    "\x00<a/>",
    "a\x00<a/>",
    "<",
    "﻿<a/>",
    " ﻿<a/>",
    "﻿",
    "﻿﻿<a/>",
    "﻿\x00<a/>",
    "<\x00a\x00/\x00>\x00",
    "\x00<\x00a\x00/\x00>",
    "<\x00?\x00x\x00m\x00l\x00 \x00v\x00e\x00r\x00s\x00i\x00o\x00n\x00=\x00'\x001\x00.\x000\x00'\x00?\x00>\x00<\x00a\x00>\x00x\x00<\x00/\x00a\x00>\x00",
    "<a>\ud800</a>",
    "<a>\udc00\udc01</a>",
    "<a>\U0001f600 é</a>",
    "<a>\r\n x\r</a>",
    "<a b='x\r\ny\rz'/>",
    "<a>\x85 　 x \xa0</a>",
    "<?xml version=\"1.0\" encoding=\"windows-1252\"?><a>é€</a>",
    "<?xml version='1.0' encoding='latin1'?><a>é</a>",
    "<?xml version='1.0' encoding='us-ascii'?><a>é</a>",
    "<?xml version='1.0' encoding='ISO-8859-15'?><a>é</a>",
    "<?xml version='1.0' encoding='x-unknown'?><a>é</a>",
    "<?xml version='1.0' encoding=''?><a>é</a>",
    "<?xml version='1.0' encoding='utf8'?><a>é</a>",
    # XML declarations.
    "<?xml version=\"1.1\"?><a/>",
    "<?xml version=\"2.0\"?><a>&amp;</a>",
    "<?xml version='1.0' standalone='maybe'?><a>&amp;</a>",
    "<?xml version='1.0' foo='bar'?><a>&amp;</a>",
    "<?xml version='1.0'><a>&amp;</a>",
    "<?xml?><a>&amp;</a>",
    "<?xml ?><a/>",
    "<?xml encoding='utf-8'?><a>&amp;</a>",
    "<?XML version='1.0'?><a/>",
    "  <?xml version='1.0'?><a/>",
    "<?xml version='1.0'?>\n<?xml version='1.0'?><a>&amp;</a>",
    "<?xml vers\x00ion=\"1.0\"?>\n<a/>",
    # Entities and references.
    "<a>&foo;</a>",
    "<a>x & y</a>",
    "<a>x &y z</a>",
    "<a>x &amp y</a>",
    "<a>& &amp; &lt; &#65; &#x42;</a>",
    "<a>&lt;&gt;&amp;&quot;&apos;</a>",
    "<a>[&#0;][&#1;][&#8;][&#9;][&#11;][&#31;][&#xFFFE;][&#xFFFF;][&#x110000;]</a>",
    "<a b='[&#1;][&#9;][&#10;][&#13;][&#xFFFE;][&#x110000;]'/>",
    "<a>&#xD800;</a>",
    "<a>&#99999999999999999999;</a>",
    "<a>x&#12a;y</a>",
    "<a>&#;</a>",
    "<a b='&undef;' c='&amp;'/>",
    "<a b='x&y'/>",
    "<a b='x&#0;y'/>",
    "<a b=\"a\x01b￾\"/>",
    "<!DOCTYPE a SYSTEM \"x\"><a>&foo;&amp;</a>",
    "<?xml version='1.0' standalone='yes'?><!DOCTYPE a SYSTEM 'x'><a>&foo;&amp;</a>",
    "<!DOCTYPE a [<!ENTITY x \"y\">]><a>&x;</a>",
    "<!DOCTYPE a [<!ENTITY lt \"&#60;\">]><a>&lt;</a>",
    "<!DOCTYPE a [<!ENTITY % p 'v'>]><a/>",
    "<!DOCTYPE a [<!ENTITY e SYSTEM 'u' NDATA n>]><a/>",
    "<!DOCTYPE a [ %p; <!ENTITY e 'v'> ]><a>&e;&amp;</a>",
    "<!DOCTYPE lolz [<!ENTITY lol \"lol\"><!ENTITY lol2 \"&lol;&lol;&lol;&lol;\">]><lolz>&lol2;</lolz>",
    "<!DOCTYPE a [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><a>&xxe;</a>",
    # DTDs.
    "<!DOCTYPE a [<!ATTLIST a x CDATA \"1\">]><a/>",
    "<!DOCTYPE a [<!ATTLIST a x CDATA #IMPLIED y (p|q) 'p' w CDATA #FIXED 'f&amp;\"'>]><a/>",
    "<!DOCTYPE a [<!ATTLIST a w NMTOKENS '  p   q  '>]><a w=' r  s '/>",
    "<!DOCTYPE a [<!ELEMENT a ((b | c)*, d?)><!ELEMENT b EMPTY><!ELEMENT c (#PCDATA|b)*>]><a/>",
    "<!DOCTYPE a [<!NOTATION n PUBLIC 'p'><!-- c --><?p x?>]><a/>",
    "<!DOCTYPE a PUBLIC 'p' 's'><a/>",
    "<!DOCTYPE a PUBLIC 'p\t' 's'><a/>",
    "<!DOCTYPE a [<!BAD>]><a/>",
    "<!DOCTYPE a [<!ELEMENT a ANY>",
    "<!DOCTYPE a [1<a x='1'/>",
    "<!DOCTYPE a []<a/>",
    "<!DOCTYPE a junk><a/>",
    "<!DOCTYPE><a/>",
    "<!-- c --><!DOCTYPE a><!-- d --><?p x?>\n<a/><!--e-->",
    # Truncation and tag mismatches.
    "<a><b>x</b><c>y",
    "<a><b>x</b><c>y</c",
    "<a><b>x</b><c",
    "<a><b>x</b><c attr='1",
    "<a><b>x</b><",
    "<a><b>x</b></",
    "<a><b>x</c></a>",
    "<a><b>x</b></c></a>",
    "<a><b><c>x</b></a>",
    "<a></a></a>",
    "</a><a/>",
    "<a/>junk",
    "<a/><b/>",
    "<a/>  <!-- c --> <?p?>",
    "x<a/>",
    "   ",
    "not xml at all {}",
    # Broken attributes and markup.
    "<a x=1/>",
    "<a x='1' x='2'/>",
    "<a x='1' y/>",
    "<a x='<'/>",
    "<a><b x=1>text</b>tail</a>",
    "<a><b b c='1'>t</b>u</a>",
    "<a><b =\"1\">t</b>u</a>",
    "<a><b x=\"1\"y=\"2\">t</b>u</a>",
    "<a><b x='1'/ >t</b>u</a>",
    "<a><b>t</ b></a>",
    "<a><b x='1'>t</b x></a>",
    "<a x='1' xmlns:p='u' y='2' xmlns='v'/>",
    "<a xmlns:p='u' xmlns:p='v'/>",
    "<a xmlns:p=''/>",
    "<p:a xmlns:q='u'><q:b q:c='1'/></p:a>",
    "<a:b:c/>",
    "<a>x <3 y</a>",
    "<a>\"'<>&amp;</a>",
    "<a>x\x01y</a>",
    "<a>\x01&amp;</a>",
    "<a>a￾b</a>",
    "\r<c/><￾]>",
    "<a>x]]>y</a>",
    "<a>x é ]]> y</a>",
    "<a>p\r]]> q</a>",
    "<a>x<!-- a -- b -->y</a>",
    "<a>x<!-- a --->y</a>",
    "<a>x<!-- é --->y</a>",
    "<a>x<!-- \x01 -->y</a>",
    "<a>x<![CDATA[ a ]] ]]>y</a>",
    "<a>x<![CDATA[ab",
    "<a>x<?p a?b?>y</a>",
    "<a>x<?p\x01?>y</a>",
    "<a>x<? p?>y</a>",
    "<a>x<!DOCTYPE b>y</a>",
    "<a><<<<<</a>",
    "<é attr='1'>t</é>",
    # xmltodict shapes.
    "<feedback><a>1</a><b x='y'>2</b><a>3</a></feedback>",
    "<a>x<b/>y<b>z</b>  </a>",
    "<a b='1'>  text  <c/></a>",
    "<a><__proto__>1</__proto__><constructor/><toString x='y'/></a>",
    "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'><xs:e/></xs:schema>",
    "<a xml:lang='en'>t</a>",
    "<a><![CDATA[]]></a>",
    "<a>&#32;</a>",
    "<a> &#160; </a>",
    "<a>​</a>",
    "<a>﻿</a>",
]


def deep(depth: int) -> str:
    return "".join(f"<e{i}>" for i in range(depth)) + "x" + "".join(
        f"</e{i}>" for i in reversed(range(depth))
    )


HANDMADE += [deep(255), deep(256), deep(257)]


SOUP = [
    "<", ">", "</", "/>", "<a>", "</a>", "<b>", "</b>", "<a x='1'>", '<a x="1" y="2">', "&amp;",
    "&lt;", "&foo;", "&#65;", "&#x41;", "&#0;", "&#xD800;", "&#", "&", ";", "<![CDATA[", "]]>", "]]",
    "]", "<!--", "-->", "--", "<?xml version='1.0'?>",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', "<?pi data?>", "?>", "<!DOCTYPE a>",
    "<!DOCTYPE a [", "]>", "<!ENTITY e 'v'>", "<!ATTLIST a z CDATA 'd'>", "<!ELEMENT a (b|c)*>", "%pe;",
    "<!DOCTYPE a SYSTEM 'x.dtd'>", "<!DOCTYPE a PUBLIC 'p' 's'>", " ", "\n", "\r", "\r\n", "\t", "x",
    "é", "\U0001f600", "\x00", "\x01", "￾", "﻿", "=", "'", '"', "a", ":", "xs:schema",
    "<xs:schema>", "<a:b c:d='e'>", "</a:b>", "<a\tz = ' v\t\nw ' >", "<c/>", "<c a='1' a='2'/>",
    "<!-- c -->", "<é>", "<a·b>",
]


def soup(rnd: random.Random) -> str:
    return "".join(rnd.choice(SOUP) for _ in range(rnd.randint(1, 12)))


NAMES = ["a", "b", "x:y", "feedback", "record", "__proto__", "é", "a.b-c"]
TEXTS = ["", " ", "t", "  hi  ", "\n  ", "a&amp;b", "&lt;&gt;&quot;&apos;", "&#xa0;x&#xa0;",
         "　y　", "\x85", "&#13;", "\r\n z \r", "<![CDATA[ <x> & ]]>", "<!-- c -->", "<?p x?>",
         "\U0001f600", " &#32; "]
ATTRV = ["v", " lead", "trail ", "a  b", "x\ty", "l\nm", "&amp;", "&#9;", "", "\r\n", "&lt;q&gt;"]


def tree(rnd: random.Random) -> str:
    # Iterative construction keeps this generator flat.
    def element(depth: int) -> str:
        name = rnd.choice(NAMES)
        attrs = ""
        used: set[str] = set()
        for _ in range(rnd.choice([0, 0, 1, 2])):
            attribute = rnd.choice(["id", "lang", "xml:lang", "xmlns", "xmlns:p", "z"])
            if attribute not in used:
                used.add(attribute)
                quote = rnd.choice("'\"")
                attrs += f" {attribute}={quote}{rnd.choice(ATTRV)}{quote}"
        if depth > 3 or rnd.random() < 0.3:
            return f"<{name}{attrs}/>" if rnd.random() < 0.5 else f"<{name}{attrs}>{rnd.choice(TEXTS)}</{name}>"
        kids = "".join(
            element(depth + 1) if rnd.random() < 0.5 else rnd.choice(TEXTS)
            for _ in range(rnd.randint(0, 4))
        )
        return f"<{name}{attrs}>{kids}</{name}>"

    prolog = rnd.choice(["", "<?xml version='1.0'?>\n", "﻿",
                         '<?xml version="1.0" standalone="yes"?>'])
    doctype = rnd.choice(["", "", "<!DOCTYPE r>", "<!DOCTYPE r SYSTEM 'x'>",
                          "<!DOCTYPE r [<!ATTLIST z t CDATA 'X'>]>", "<!DOCTYPE r [%p; <!ENTITY e 'v'>]>"])
    return prolog + doctype + element(0) + rnd.choice(["", "\n", " <!-- post --> "])


PIECES = ["&", "<", ">", "&amp;", "]]>", "\x00", "\x01", "\x0b", "￾", "﻿", "</x>", "<y>",
          "\"", "'", "=", "&nbsp;", "&#0;", "<!--", "<![CDATA[", "\U0001f600"]


def mutate(rnd: random.Random, text: str) -> str:
    for _ in range(rnd.randint(1, 3)):
        if not text:
            return text
        index = rnd.randrange(len(text) + 1)
        operation = rnd.randrange(9)
        if operation == 0:
            text = text[:index]
        elif operation == 1:
            text = text[:index] + text[index + rnd.randint(1, 20):]
        elif operation == 2:
            text = text[:index] + rnd.choice(PIECES) + text[index:]
        elif operation == 3:
            end = min(len(text), index + rnd.randint(1, 40))
            text = text[:index] + text[index:end] + text[index:end] + text[end:]
        elif operation == 4:
            # Drop one tag (start or end).
            start = text.find("<", index)
            if start >= 0:
                close = text.find(">", start)
                if close >= 0:
                    text = text[:start] + text[close + 1:]
        elif operation == 5:
            text = text.replace("\n", "\r\n")
        elif operation == 6:
            # Bytes lost to decode(errors="ignore"): drop a non-ASCII char.
            positions = [i for i, char in enumerate(text) if ord(char) > 0x7F]
            if positions:
                position = rnd.choice(positions)
                text = text[:position] + text[position + 1:]
            else:
                text = text[:index] + "\x80"[:0] + text[index:]
        elif operation == 7:
            text = "﻿" + text
        else:
            text = text + rnd.choice(["junk", "<extra/>", "</feedback>", "\n\x00", "<!-- tail -->"])
    return text


def main() -> int:
    rnd = random.Random(SEED)
    named: list[tuple[str, str, str]] = []
    samples = sample_inputs()
    for name, text in samples:
        named.append(("sample", name, text))
    for index, text in enumerate(HANDMADE):
        named.append(("handmade", f"handmade-{index}", text))
    small = [text for _, text in samples if 500 < len(text) < 2500]
    for index in range(40):
        base = small[index % len(small)]
        cut = rnd.randrange(len(base))
        named.append(("truncated", f"truncated-{index}", base[:cut]))
    for index in range(260):
        named.append(("mutated", f"mutated-{index}", mutate(rnd, rnd.choice(small))))
    for index in range(300):
        named.append(("soup", f"soup-{index}", soup(rnd)))
    for index in range(150):
        named.append(("tree", f"tree-{index}", tree(rnd)))

    cases = []
    for category, name, text in named:
        recovered = recover(text)
        case = {"category": category, "name": name, "input": text}
        if len(text) > LARGE:
            # Big plain-XML samples are read from samples/ by the test.
            assert name.endswith(".xml") and (ROOT / name).read_text("utf-8") == text, name
            del case["input"]
            case["input_file"] = name
        case["parse"] = parse(text)
        if doctype_rejected(text):
            case["doctype"] = True
        if recovered is None:
            case["recovered_doctype"] = True
        else:
            if len(recovered) > LARGE:
                case["recovered_sha256"] = hashlib.sha256(recovered.encode("utf-8")).hexdigest()
            else:
                case["recovered"] = recovered
            case["recovered_parse"] = parse(recovered)
        cases.append(case)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8") as handle:
        json.dump(
            {
                "generator": "tools/fixtures/generate_xml.py",
                "versions": {
                    "python": sys.version.split()[0],
                    "expat": __import__("pyexpat").EXPAT_VERSION,
                    "lxml": ".".join(map(str, etree.LXML_VERSION)),
                    "libxml2": ".".join(map(str, etree.LIBXML_VERSION)),
                },
                "cases": cases,
            },
            handle,
            ensure_ascii=True,
            indent=None,
            separators=(",", ":"),
        )
        handle.write("\n")
    print(f"{len(cases)} cases -> {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
