"""Generate packages/tsdmarc/src/__fixtures__/extract-cases.json.

Differential cases for extract.ts and its ports of zipfile, zlib, bz2, lzma
and zstd: hand-made archives that each hit one check of CPython 3.14's
zipfile / zlib (corrupt headers, zip64 records, bad CRCs, unsupported
methods, ...) plus seeded random mutations of zip and gzip files. Each case
is ``[name, limit, base64]`` with parsedmarc's result: ``{"ok": text}`` or
``{"error": message}``. ``limit`` overrides MAX_DECOMPRESSED_REPORT_SIZE
(0 keeps the default).

Usage: .venv/bin/python tools/fixtures/generate_extract_cases.py
"""

from __future__ import annotations

import base64
import bz2
import gzip
import io
import json
import random
import struct
import warnings
import zipfile
import zlib
from pathlib import Path

from compression import zstd

import parsedmarc

warnings.simplefilter("ignore")

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages" / "tsdmarc" / "src" / "__fixtures__" / "extract-cases.json"
rng = random.Random(20261024)

XML = b"<?xml version='1.0'?><feedback><report_metadata/></feedback>"
cases: list[tuple[str, int, bytes]] = []


def case(name: str, data: bytes, limit: int = 0) -> None:
    cases.append((name, limit, bytes(data)))


def deflate(data: bytes) -> bytes:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def lzma_member(data: bytes) -> bytes:
    c = zipfile.LZMACompressor()
    return c.compress(data) + c.flush()


COMPRESS = {
    0: lambda d: d,
    8: deflate,
    12: bz2.compress,
    14: lzma_member,
    93: zstd.compress,
}


def build_zip(
    entries=None,
    *,
    method=8,
    data=XML,
    name=b"a.xml",
    header_name=None,
    flags=0,
    header_flags=None,
    version=20,
    extra=b"",
    crc=None,
    csize=None,
    fsize=None,
    offset=None,
    cd_offset_delta=0,
    cd_size_delta=0,
    comment=b"",
    prefix=b"",
    descriptor=False,
) -> bytes:
    """A zip archive with full control over every header field."""
    entries = entries or [dict()]
    body = b""
    central = b""
    for entry in entries:
        e_method = entry.get("method", method)
        e_data = entry.get("data", data)
        e_name = entry.get("name", name)
        comp = COMPRESS[e_method](e_data) if e_method in COMPRESS else e_data
        e_crc = zlib.crc32(e_data) if crc is None else crc
        h_name = e_name if header_name is None else header_name
        h_flags = flags if header_flags is None else header_flags
        local_offset = len(body)
        body += struct.pack(
            "<4s2B4HL2L2H", b"PK\x03\x04", 20, 0, h_flags, e_method, 0, 0x21,
            e_crc, len(comp), len(e_data), len(h_name), 0,
        ) + h_name + comp
        if descriptor:
            body += struct.pack("<4sLLL", b"PK\x07\x08", e_crc, len(comp), len(e_data))
        central += struct.pack(
            "<4s4B4HL2L5H2L", b"PK\x01\x02", 20, 3, version, 0, flags, e_method, 0, 0x21,
            e_crc,
            len(comp) if csize is None else csize,
            len(e_data) if fsize is None else fsize,
            len(e_name), len(extra), 0, 0, 0, 0,
            local_offset if offset is None else offset,
        ) + e_name + extra
    end = struct.pack(
        "<4s4H2LH", b"PK\x05\x06", 0, 0, len(entries), len(entries),
        len(central) + cd_size_delta, len(body) + cd_offset_delta, len(comment),
    )
    return prefix + body + central + end + comment


def build_zip64(*, locator_disk=0, disks=1, reloff_delta=0, record_size=44, sig=b"PK\x06\x06", dir_offset_delta=0) -> bytes:
    """A stored member with a zip64 end of central directory record."""
    comp = XML
    name = b"a.xml"
    local = struct.pack("<4s2B4HL2L2H", b"PK\x03\x04", 45, 0, 0, 0, 0, 0x21, zlib.crc32(XML), len(comp), len(XML), len(name), 0) + name
    body = local + comp
    central = struct.pack("<4s4B4HL2L5H2L", b"PK\x01\x02", 45, 3, 45, 0, 0, 0, 0, 0x21, zlib.crc32(XML), len(comp), len(XML), len(name), 0, 0, 0, 0, 0, 0) + name
    z64_offset = len(body) + len(central)
    record = struct.pack("<4sQ2H2L4Q", sig, record_size, 45, 45, 0, 0, 1, 1, len(central), len(body) + dir_offset_delta)
    locator = struct.pack("<4sLQL", b"PK\x06\x07", locator_disk, z64_offset + reloff_delta, disks)
    end = struct.pack("<4s4H2LH", b"PK\x05\x06", 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)
    return body + central + record + locator + end


def zip64_extra(*values: int) -> bytes:
    payload = b"".join(struct.pack("<Q", v) for v in values)
    return struct.pack("<HH", 1, len(payload)) + payload


# --- zip: every compression method -----------------------------------------
for method in COMPRESS:
    case(f"zip method {method}", build_zip(method=method))
    case(f"zip method {method} bad CRC", build_zip(method=method, crc=0x12345678))
    case(f"zip method {method} over the limit", build_zip(method=method, data=XML * 3), limit=100)
    case(f"zip method {method} at the limit", build_zip(method=method, data=XML[:100]), limit=100)
    comp = COMPRESS[method](XML * 20)
    for cut in (len(comp) // 3, len(comp) - 3):
        member = bytearray(build_zip(method=method, data=XML * 20))
        start = 30 + 5
        del member[start + cut: start + len(comp)]
        # Keep the central directory sizes: the member is short.
        case(f"zip method {method} truncated member at {cut}", build_zip(method=method, data=XML * 20, csize=cut))
    corrupt = bytearray(build_zip(method=method, data=XML * 20))
    corrupt[30 + 5 + len(comp) // 2] ^= 0x55
    case(f"zip method {method} corrupt member", corrupt)

case("zip unsupported method", build_zip(method=99))
case("zip deflate64 method", build_zip(method=9))
case("zip file size smaller than the data", build_zip(method=0, fsize=5, crc=zlib.crc32(XML[:5])))
case("zip file size zero", build_zip(method=8, fsize=0, crc=0))
case("zip compressed size past the end", build_zip(method=0, csize=10_000))
case("zip deflate compressed size past the end", build_zip(method=8, csize=10_000))

# --- zip: structure ---------------------------------------------------------
case("zip with a comment", build_zip(comment=b"archive comment"))
case("zip with prepended data", build_zip(prefix=b"PK\x03\x04prepended"))
case("zip with a data descriptor", build_zip(flags=0x08, descriptor=True))
case("zip duplicate names: the last entry wins", build_zip([dict(data=b"<first/>"), dict(data=b"<second/>")]))
case("zip several entries", build_zip([dict(name=b"a.xml"), dict(name=b"b.xml", data=b"<b/>")]))
empty = io.BytesIO()
zipfile.ZipFile(empty, "w").close()
case("zip with no entries", b"PK\x03\x04" + empty.getvalue())
case("zip without an end record", b"PK\x03\x04" + b"\x00" * 40)
case("zip with a truncated end record", build_zip()[:-5])
case("zip central directory offset too large", build_zip(cd_offset_delta=50))
case("zip central directory offset too small", build_zip(cd_offset_delta=-10))
case("zip central directory size too large", build_zip(cd_size_delta=1000))
case("zip central directory size too small", build_zip(cd_size_delta=-10))
bad_magic = bytearray(build_zip())
bad_magic[bad_magic.rfind(b"PK\x01\x02") + 3] = 0x03
case("zip bad central directory magic", bad_magic)
case("zip extract version too new", build_zip(version=64))
case("zip extract version 255", build_zip(version=255))
case("zip corrupt extra field", build_zip(extra=struct.pack("<HH", 0xABCD, 10) + b"x"))
case("zip zip64 extra field: file size", build_zip(fsize=0xFFFFFFFF, extra=zip64_extra(len(XML))))
case("zip zip64 extra field: all sizes", build_zip(fsize=0xFFFFFFFF, csize=0xFFFFFFFF, offset=0xFFFFFFFF, extra=zip64_extra(len(XML), len(deflate(XML)), 0)))
case("zip zip64 extra field: missing file size", build_zip(fsize=0xFFFFFFFF, extra=struct.pack("<HH", 1, 0)))
case("zip zip64 extra field: missing compress size", build_zip(csize=0xFFFFFFFF, extra=struct.pack("<HH", 1, 4) + b"1234"))
case("zip zip64 extra field: missing header offset", build_zip(offset=0xFFFFFFFF, extra=struct.pack("<HH", 1, 0)))
case("zip zip64 header offset 2**63", build_zip(offset=0xFFFFFFFF, extra=zip64_extra(2**63)))
case("zip zip64 header offset 2**64-1", build_zip(offset=0xFFFFFFFF, extra=zip64_extra(2**64 - 1)))
case("zip zip64 compress size 2**64-1", build_zip(csize=0xFFFFFFFF, extra=zip64_extra(2**64 - 1)))
up_name = "über.xml".encode()
case("zip unicode path extra field", build_zip(extra=struct.pack("<HHBL", 0x7075, 5 + len(up_name), 1, zlib.crc32(b"a.xml")) + up_name, crc=1))
case("zip unicode path extra field with a wrong CRC", build_zip(extra=struct.pack("<HHBL", 0x7075, 5 + len(up_name), 1, 0) + up_name, crc=1))
case("zip unicode path extra field too short", build_zip(extra=struct.pack("<HHB", 0x7075, 1, 1)))
case("zip unicode path extra field with invalid UTF-8", build_zip(extra=struct.pack("<HHBL", 0x7075, 6, 1, zlib.crc32(b"a.xml")) + b"\xff"))
case("zip UTF-8 file name", build_zip(name="réport.xml".encode(), flags=0x800))
case("zip cp437 file name", build_zip(name="réport.xml".encode("cp437"), crc=1))
case("zip invalid UTF-8 file name", build_zip(name=b"\xffa.xml", flags=0x800))
case("zip truncated UTF-8 file name", build_zip(name=b"a\xc3", flags=0x800))
case("zip NUL in the file name", build_zip(name=b"a.xml\x00evil", crc=1))
case("zip header name differs", build_zip(header_name=b"b.xml"))
case("zip header name differs (quotes)", build_zip(name=b"it's.xml", header_name=b"it's\x01.xml"))
case("zip header name with invalid UTF-8", build_zip(header_name=b"\xff.xml", header_flags=0x800))
case("zip header name in cp437", build_zip(name="é.xml".encode(), flags=0x800, header_name="é.xml".encode("cp437"), header_flags=0))
case("zip encrypted", build_zip(flags=0x01))
case("zip encrypted with a quote in the name", build_zip(flags=0x01, name=b"it's.xml"))
case("zip compressed patched data", build_zip(flags=0x20))
case("zip strong encryption", build_zip(flags=0x40))
case("zip overlapped entries", build_zip(csize=10_000))
case("zip entries sharing a header", build_zip([dict(), dict(name=b"b.xml")], offset=0))
case("zip entries sharing a header, member past the end", build_zip([dict(), dict(name=b"b.xml")], offset=0, csize=10_000))
case("zip member data ends early (EOFError)", build_zip([dict(), dict(name=b"b.xml")], method=0, offset=0, csize=10_000, fsize=10_000))
case("zip local header offset past the end", build_zip(offset=10_000))
case("zip truncated local header", build_zip(offset=len(build_zip()) - 25))
case("zip bad local header magic", build_zip(offset=1))
case("zip64 end of central directory", build_zip64())
case("zip64 spanning disks", build_zip64(disks=2))
case("zip64 locator on another disk", build_zip64(locator_disk=1))
case("zip64 corrupt locator", build_zip64(reloff_delta=100))
case("zip64 record not found", build_zip64(sig=b"PK\x06\x05"))
case("zip64 record not found (moved)", build_zip64(reloff_delta=-8))
case("zip64 corrupt record size", build_zip64(record_size=45))
case("zip64 corrupt record offset", build_zip64(dir_offset_delta=1))

# --- gzip ---------------------------------------------------------------------
GZ = gzip.compress(XML, mtime=0)
BODY = deflate(XML)
TRAILER = struct.pack("<LL", zlib.crc32(XML), len(XML))


class BitWriter:
    """Deflate bit packing: fields LSB first, Huffman codes MSB first."""

    def __init__(self) -> None:
        self.value = 0
        self.count = 0

    def bits(self, value: int, count: int) -> "BitWriter":
        self.value |= value << self.count
        self.count += count
        return self

    def code(self, code: int, length: int) -> "BitWriter":
        reversed_code = int(format(code, f"0{length}b")[::-1], 2)
        return self.bits(reversed_code, length)

    def bytes(self) -> bytes:
        return self.value.to_bytes((self.count + 7) // 8, "little")


# Fixed block: literal "a", then a length 3 / distance 2 match (too far back).
TOO_FAR = BitWriter().bits(1, 1).bits(1, 2).code(0x30 + 0x61, 8).code(1, 7).code(1, 5).code(0, 7).bytes()
# Dynamic block whose code length code is over-subscribed (four 1-bit codes).
OVERSUBSCRIBED = BitWriter().bits(1, 1).bits(2, 2).bits(0, 5).bits(0, 5).bits(0, 4).bits(1, 3).bits(1, 3).bits(1, 3).bits(1, 3).bytes()
# Dynamic block whose code length code is empty: every length reads as 0.
NO_END_OF_BLOCK = BitWriter().bits(1, 1).bits(2, 2).bits(0, 5).bits(0, 5).bits(0, 4).bits(0, 12).bits(0, 258).bytes()


def gzip_with(flags: int, rest: bytes = b"", *, method: int = 8, hcrc=None, body=BODY, trailer=TRAILER) -> bytes:
    header = bytes([0x1F, 0x8B, method, flags, 0, 0, 0, 0, 0, 0xFF]) + rest
    if flags & 0x02:
        header += struct.pack("<H", zlib.crc32(header) & 0xFFFF if hcrc is None else hcrc)
    return header + body + trailer


case("gzip", GZ)
case("gzip with FHCRC", gzip_with(0x02))
case("gzip with a bad FHCRC", gzip_with(0x02, hcrc=0x1234))
case("gzip with FHCRC and all fields", gzip_with(0x1E, struct.pack("<H", 3) + b"abc" + b"name\x00comment\x00"))
case("gzip with FEXTRA past the end", gzip_with(0x04, struct.pack("<H", 0xFFFF), body=b"", trailer=b""))
case("gzip with FNAME without a terminator", gzip_with(0x08, b"name", body=b"", trailer=b""))
case("gzip with FTEXT", gzip_with(0x01))
case("gzip unknown compression method", gzip_with(0, method=7))
case("gzip reserved flags", gzip_with(0x20))
case("gzip magic only", b"\x1f\x8b")
case("gzip truncated header", GZ[:6])
case("gzip truncated body", GZ[:20])
case("gzip truncated trailer", GZ[:-3])
case("gzip bad CRC", gzip_with(0, trailer=struct.pack("<LL", 0, len(XML))))
case("gzip bad ISIZE", gzip_with(0, trailer=struct.pack("<LL", zlib.crc32(XML), 1)))
case("gzip trailing garbage", GZ + b"garbage")
case("gzip two members", GZ + gzip.compress(b"<second/>"))
case("gzip invalid block type", gzip_with(0, body=b"\x07", trailer=b""))
case("gzip invalid stored block lengths", gzip_with(0, body=b"\x01\x05\x00\x05\x00", trailer=b""))
case("gzip invalid distance too far back", gzip_with(0, body=TOO_FAR, trailer=b""))
case("zip invalid distance too far back", build_zip(method=0, data=TOO_FAR, crc=0) .replace(b"PK\x03\x04\x14\x00\x00\x00\x00\x00", b"PK\x03\x04\x14\x00\x00\x00\x08\x00").replace(b"PK\x01\x02\x14\x03\x14\x00\x00\x00\x00\x00", b"PK\x01\x02\x14\x03\x14\x00\x00\x00\x08\x00"))
case("gzip missing end-of-block code", gzip_with(0, body=NO_END_OF_BLOCK, trailer=b""))
case("gzip too many length or distance symbols", gzip_with(0, body=b"\xfd\xff\xff\xff", trailer=b""))
case("gzip invalid code lengths set", gzip_with(0, body=OVERSUBSCRIBED, trailer=b""))
case("gzip over the limit", gzip.compress(XML * 3), limit=100)
case("gzip at the limit", gzip.compress(XML[:100]), limit=100)

# --- random mutations ----------------------------------------------------------
for index in range(400):
    method = rng.choice(list(COMPRESS))
    data = rng.choice([XML, XML * 50, bytes(rng.getrandbits(8) for _ in range(300))])
    is_gzip = rng.random() < 0.25
    if is_gzip:
        base = bytearray(gzip.compress(data, mtime=0))
    else:
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w", method) as z:
            z.writestr("a.xml", data)
        base = bytearray(b.getvalue())
    for _ in range(rng.randint(1, 3)):
        op = rng.random()
        pos = rng.randrange(4, len(base))
        if op < 0.5:
            base[pos] ^= 1 << rng.randint(0, 7)
        elif op < 0.7:
            base[pos] = rng.getrandbits(8)
        elif op < 0.85:
            del base[pos: pos + rng.randint(1, 4)]
        else:
            base = base[:pos]
    # bz2, lzma and zstd members stop at the limit, where Python goes on
    # decompressing (see readFirstZipMember): only zlib gets small limits.
    small_limits = is_gzip or method in (0, 8)
    case(f"mutation {index}", base, rng.choice([0, 0, 0, 10, 100]) if small_limits else 0)

result = []
default = parsedmarc.MAX_DECOMPRESSED_REPORT_SIZE
for name, limit, data in cases:
    parsedmarc.MAX_DECOMPRESSED_REPORT_SIZE = limit or default
    try:
        expected = {"ok": parsedmarc.extract_report(data)}
    except Exception as error:  # noqa: BLE001
        expected = {"error": str(error)}
    result.append([name, limit, base64.b64encode(data).decode(), expected])
parsedmarc.MAX_DECOMPRESSED_REPORT_SIZE = default

TARGET.write_text(json.dumps(result, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
print(f"{len(result)} cases -> {TARGET.relative_to(ROOT)}")
