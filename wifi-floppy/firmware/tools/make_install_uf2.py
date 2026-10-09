#!/usr/bin/env python3
"""Build the single drag-and-drop first-install UF2 (python3 stdlib only).

Design: docs/superpowers/research/2026-10-09-uf2-drag-drop-first-install.md §6.
A user holds BOOTSEL, plugs the board in and drops this ONE file on the drive.
Every block is in the ABSOLUTE family (0xe48bff57), so the boot ROM writes each
256-byte page at the physical flash address the block names, across partition
boundaries, in one transfer. It carries, in address order:

  flash 0x000000          the partition table (the payload of wifi_floppy_pt.uf2)
  flash 0x001000          one 0xFF page: erases the table's second slot
  partition A start ...   wifi_floppy_install.bin (the NON-TBYB build)
  partition B start       one 0xFF page: severs B's block loop, so an older
                          image left in B can never outrank the new A

Why non-TBYB: after an absolute download the ROM's flash-update reboot targets
0x10000000, never partition A, and the ROM refuses to launch a TBYB image
outside a flash update of its own partition -- a TBYB image here would leave
the board in BOOTSEL (research §1). This script REFUSES a TBYB image.

It also refuses (exit status 1) any page outside the 16 MB flash or inside its
top five 4 KB sectors (device token, config, fw_state, display, drive_store --
the records a re-install must keep), and it never carries the RP2350-E10
workaround block (0x10ffff00, inside the token sector) that picotool adds to
the SDK's own UF2s. Addresses come from partitions.json, never hard-coded. The
output is deterministic: same inputs, same bytes.

Usage:
  make_install_uf2.py --partitions partitions.json --pt-uf2 wifi_floppy_pt.uf2 \
                      --image wifi_floppy_install.bin --out wifi-floppy-install.uf2
"""
import argparse
import json
import os
import re
import struct
import sys

UF2_MAGIC0 = 0x0A324655
UF2_MAGIC1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
UF2_FLAG_NOT_MAIN_FLASH = 0x00000001
UF2_FLAG_FAMILY_ID = 0x00002000
UF2_FLAG_EXTENSION_TAGS = 0x00008000
UF2_EXTENSION_RP2_IGNORE_BLOCK = 0x9957E304
FAMILY_ABSOLUTE = 0xE48BFF57

XIP_BASE = 0x10000000
PAGE = 256
SECTOR = 4096
FLASH_SIZE = 16 * 1024 * 1024        # PIM726 (Pimoroni Pico Plus 2 W): 16 MB
RECORD_SECTORS = 5                   # token, config, fw_state, display, drive_store
PT_SLOT1 = SECTOR                    # the boot ROM's second partition-table slot
E10_ABS_BLOCK = XIP_BASE + FLASH_SIZE - PAGE   # 0x10ffff00, picotool --abs-block

PICOBIN_BLOCK_MARKER_START = 0xFFFFDED3
PICOBIN_BLOCK_MARKER_END = 0xAB123579
PICOBIN_ITEM_IMAGE_TYPE = 0x42
PICOBIN_ITEM_LAST = 0xFF
PICOBIN_IMAGE_TYPE_EXE_TBYB = 0x8000


class Refused(Exception):
    pass


def parse_size(text):
    """partitions.json sizes: "32K", "4128K", "4M", or a plain/hex number."""
    m = re.fullmatch(r"\s*(0x[0-9a-fA-F]+|\d+)\s*([kKmM]?)\s*", str(text))
    if not m:
        raise Refused(f"cannot read a size out of {text!r}")
    n = int(m.group(1), 0)
    return n * {"": 1, "k": 1024, "m": 1024 * 1024}[m.group(2).lower()]


def partition_slots(partitions_path):
    """(A start, A size, B start, B size) in bytes from flash 0."""
    with open(partitions_path, encoding="utf-8") as f:
        pt = json.load(f)
    by_id = {p.get("id"): p for p in pt.get("partitions", [])}
    if 0 not in by_id or 1 not in by_id:
        raise Refused("partitions.json needs partitions with id 0 (A) and id 1 (B)")
    a, b = by_id[0], by_id[1]
    return parse_size(a["start"]), parse_size(a["size"]), parse_size(b["start"]), parse_size(b["size"])


def read_uf2(data):
    """Yield (flags, addr, payload, family/filesize, block bytes) per 512-byte block."""
    if len(data) % 512:
        raise Refused("UF2 length is not a multiple of 512")
    for off in range(0, len(data), 512):
        blk = data[off:off + 512]
        m0, m1, flags, addr, size, _no, _num, fam = struct.unpack_from("<8I", blk, 0)
        (mend,) = struct.unpack_from("<I", blk, 508)
        if (m0, m1, mend) != (UF2_MAGIC0, UF2_MAGIC1, UF2_MAGIC_END):
            raise Refused(f"bad UF2 magic in block at file offset {off}")
        if size > 476:
            raise Refused(f"UF2 block at file offset {off} claims {size} payload bytes")
        yield flags, addr, blk[32:32 + size], fam, blk


def is_e10_block(flags, addr, blk):
    """picotool's RP2350-E10 workaround block (`uf2 convert --abs-block`)."""
    if addr == E10_ABS_BLOCK:
        return True
    if flags & UF2_FLAG_EXTENSION_TAGS:
        # Extension tags follow the payload, 4-byte aligned. Each starts with a
        # word holding its byte size in bits 0-7 and its type in bits 8-31; the
        # ignore tag is the whole word 0x9957e304 (size 4).
        size = struct.unpack_from("<I", blk, 16)[0]
        pos = 32 + ((size + 3) & ~3)
        while pos + 4 <= 508:
            (word,) = struct.unpack_from("<I", blk, pos)
            if word == UF2_EXTENSION_RP2_IGNORE_BLOCK:
                return True
            if word & 0xFF == 0:
                break
            pos += ((word & 0xFF) + 3) & ~3
    return False


def partition_table_pages(pt_uf2_bytes):
    """The partition table's pages, all inside flash sector 0. The E10 block is dropped."""
    pages = {}
    for flags, addr, payload, _fam, blk in read_uf2(pt_uf2_bytes):
        if is_e10_block(flags, addr, blk):
            continue
        if flags & UF2_FLAG_NOT_MAIN_FLASH:
            continue
        if not (XIP_BASE <= addr and addr + len(payload) <= XIP_BASE + SECTOR):
            raise Refused(f"partition-table UF2 has a block at {addr:#010x}, outside flash sector 0")
        if addr % PAGE or len(payload) != PAGE:
            raise Refused(f"partition-table UF2 block at {addr:#010x} is not one aligned 256-byte page")
        if addr in pages:
            raise Refused(f"partition-table UF2 writes {addr:#010x} twice")
        pages[addr] = bytes(payload)
    if XIP_BASE not in pages:
        raise Refused("partition-table UF2 has no page at flash 0")
    return pages


def image_type_flags(image):
    """Every IMAGE_TYPE item's flags found in the image's picobin blocks."""
    found = []
    start = struct.pack("<I", PICOBIN_BLOCK_MARKER_START)
    pos = image.find(start)
    while pos != -1:
        if pos % 4 == 0:
            p = pos + 4
            items = []
            ok = False
            while p + 4 <= len(image):
                (w,) = struct.unpack_from("<I", image, p)
                t = w & 0xFF
                size = (w >> 8) & (0xFFFF if t & 0x80 else 0xFF)
                if t == PICOBIN_ITEM_LAST:
                    # LAST item, then the link word, then the end marker.
                    q = p + 4 + 4
                    if q + 4 <= len(image) and struct.unpack_from("<I", image, q)[0] == PICOBIN_BLOCK_MARKER_END:
                        ok = True
                    break
                if size == 0:
                    break
                if t == PICOBIN_ITEM_IMAGE_TYPE:
                    items.append(w >> 16)
                p += size * 4
            if ok:
                found.extend(items)
        pos = image.find(start, pos + 1)
    return found


def build(partitions_path, pt_uf2_bytes, image):
    a_start, a_size, b_start, b_size = partition_slots(partitions_path)
    for name, start, size in (("A", a_start, a_size), ("B", b_start, b_size)):
        if start % SECTOR or size % SECTOR:
            raise Refused(f"partition {name} is not 4 KB aligned")
    if a_start <= PT_SLOT1:
        raise Refused("partition A overlaps the partition-table sectors")
    if not image:
        raise Refused("the image is empty")
    if len(image) > a_size:
        raise Refused(f"the image is {len(image)} bytes; partition A holds {a_size}")
    flags = image_type_flags(image)
    if not flags:
        raise Refused("the image carries no IMAGE_DEF (no picobin IMAGE_TYPE item found)")
    if any(f & PICOBIN_IMAGE_TYPE_EXE_TBYB for f in flags):
        raise Refused("the image is TBYB: build wifi_floppy_install (PICO_CRT0_IMAGE_TYPE_TBYB off); "
                      "an absolute UF2's reboot never starts a TBYB image")

    pages = dict(partition_table_pages(pt_uf2_bytes))
    blank = b"\xff" * PAGE

    def put(addr, data):
        if addr in pages:
            raise Refused(f"two pages for {addr:#010x}")
        pages[addr] = data

    put(XIP_BASE + PT_SLOT1, blank)
    for off in range(0, len(image), PAGE):
        chunk = image[off:off + PAGE]
        put(XIP_BASE + a_start + off, chunk + b"\x00" * (PAGE - len(chunk)))
    put(XIP_BASE + b_start, blank)

    limit = XIP_BASE + FLASH_SIZE - RECORD_SECTORS * SECTOR
    for addr in pages:
        if addr % PAGE:
            raise Refused(f"page at {addr:#010x} is not 256-byte aligned")
        if addr < XIP_BASE or addr + PAGE > XIP_BASE + FLASH_SIZE:
            raise Refused(f"page at {addr:#010x} is outside the 16 MB flash")
        if addr + PAGE > limit:
            raise Refused(f"page at {addr:#010x} is inside the top {RECORD_SECTORS} settings sectors "
                          f"(from {limit:#010x}): token, config, fw_state, display, drive_store")

    order = sorted(pages)
    out = bytearray()
    for n, addr in enumerate(order):
        blk = struct.pack("<8I", UF2_MAGIC0, UF2_MAGIC1, UF2_FLAG_FAMILY_ID, addr, PAGE, n, len(order), FAMILY_ABSOLUTE)
        blk += pages[addr] + b"\x00" * (476 - PAGE) + struct.pack("<I", UF2_MAGIC_END)
        out += blk
    return bytes(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--partitions", required=True)
    ap.add_argument("--pt-uf2", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    try:
        with open(args.pt_uf2, "rb") as f:
            pt = f.read()
        with open(args.image, "rb") as f:
            image = f.read()
        uf2 = build(args.partitions, pt, image)
    except (Refused, OSError, ValueError, KeyError) as e:
        print(f"make_install_uf2: REFUSED: {e}", file=sys.stderr)
        return 1
    tmp = args.out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(uf2)
    os.replace(tmp, args.out)
    print(f"make_install_uf2: {args.out}: {len(uf2) // 512} blocks, {len(uf2)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
