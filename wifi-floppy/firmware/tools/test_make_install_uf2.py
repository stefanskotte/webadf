#!/usr/bin/env python3
"""Tests for make_install_uf2.py (python3 stdlib unittest; run by test/run.sh).

The UF2 is parsed here with its own reader, not the tool's, so a bug in the
tool's writer cannot hide behind the same bug in its reader. When a real build
output exists (build/wifi-floppy-install.uf2, or $WF_INSTALL_UF2), the same
structural checks run against it too.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FW = os.path.dirname(HERE)
TOOL = os.path.join(HERE, "make_install_uf2.py")
PARTITIONS = os.path.join(FW, "partitions.json")

ABSOLUTE = 0xE48BFF57
XIP = 0x10000000
FLASH_END = XIP + 16 * 1024 * 1024
TOP5 = FLASH_END - 5 * 4096            # 0x10ffb000: token/config/fw_state/display/drive_store
E10 = 0x10FFFF00


def uf2_block(addr, payload, n, total, family=ABSOLUTE, flags=0x2000, ext=b""):
    payload = payload.ljust(256, b"\x00")
    body = payload + ext
    return (struct.pack("<8I", 0x0A324655, 0x9E5D5157, flags, addr, 256, n, total, family)
            + body.ljust(476, b"\x00") + struct.pack("<I", 0x0AB16F30))


def parse(data):
    assert len(data) % 512 == 0, "length not a multiple of 512"
    blocks = []
    for off in range(0, len(data), 512):
        m0, m1, flags, addr, size, no, num, fam = struct.unpack_from("<8I", data, off)
        (mend,) = struct.unpack_from("<I", data, off + 508)
        assert (m0, m1, mend) == (0x0A324655, 0x9E5D5157, 0x0AB16F30), f"magic at {off}"
        blocks.append(dict(flags=flags, addr=addr, size=size, no=no, num=num, fam=fam,
                           data=data[off + 32: off + 32 + size]))
    return blocks


def picobin_image(tbyb, length=5000):
    """A fake image with one picobin block whose IMAGE_TYPE item has or lacks TBYB."""
    flags = 0x1021 | (0x8000 if tbyb else 0)            # EXE, ARM, RP2350 (+ TBYB)
    block = struct.pack("<5I",
                        0xFFFFDED3,                     # start marker
                        (flags << 16) | (1 << 8) | 0x42,  # IMAGE_TYPE, 1 word
                        (1 << 8) | 0xFF,                # LAST item, size 1
                        0,                              # link (to itself)
                        0xAB123579)                     # end marker
    img = bytearray((bytes(range(256)) * (length // 256 + 1))[:length])
    img[0x10:0x10 + len(block)] = block
    return bytes(img)


def slots():
    with open(PARTITIONS) as f:
        pt = json.load(f)
    k = {p["id"]: p for p in pt["partitions"]}
    size = lambda s: int(s[:-1]) * 1024 if s.endswith("K") else int(s)
    return size(k[0]["start"]), size(k[0]["size"]), size(k[1]["start"])


class Run:
    def __init__(self, tc):
        self.tc = tc
        tmp = tempfile.TemporaryDirectory(prefix="wf-uf2-test-")
        tc.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def path(self, name):
        return os.path.join(self.dir, name)

    def write(self, name, data):
        with open(self.path(name), "wb") as f:
            f.write(data)
        return self.path(name)

    def tool(self, pt, image, partitions=PARTITIONS):
        out = self.path("out.uf2")
        if os.path.exists(out):
            os.remove(out)
        r = subprocess.run([sys.executable, TOOL, "--partitions", partitions, "--pt-uf2", pt,
                            "--image", image, "--out", out], capture_output=True, text=True)
        data = None
        if os.path.exists(out):
            with open(out, "rb") as f:
                data = f.read()
        return r, data


def pt_uf2(with_e10=True):
    pt_page = bytes([0xD3, 0xDE, 0xFF, 0xFF]) + bytes(range(252))
    blocks = []
    if with_e10:
        # Exactly what picotool --abs-block emits: flags 0xa000, RP2_IGNORE tag.
        blocks.append(uf2_block(E10, b"\xef" * 256, 0, 2, flags=0xA000,
                                ext=struct.pack("<I", 0x9957E304)))
    blocks.append(uf2_block(XIP, pt_page, 0, 1))
    return b"".join(blocks), pt_page


class StructuralChecks:
    """Shared by the synthetic run and the real build output."""

    def check_structure(self, blocks, image=None):
        a_start, a_size, b_start = slots()
        n = len(blocks)
        self.assertGreater(n, 3)
        for i, b in enumerate(blocks):
            self.assertEqual(b["fam"], ABSOLUTE, f"block {i} not in the absolute family")
            self.assertEqual(b["flags"], 0x2000, f"block {i} flags {b['flags']:#x}")
            self.assertEqual(b["size"], 256)
            self.assertEqual(b["no"], i, "blockNo not sequential")
            self.assertEqual(b["num"], n, "numBlocks inconsistent")
            self.assertEqual(b["addr"] % 256, 0)
            self.assertGreaterEqual(b["addr"], XIP)
            self.assertLessEqual(b["addr"] + 256, TOP5, f"block at {b['addr']:#x} in the top 5 sectors")
            self.assertNotEqual(b["addr"], E10, "E10 abs-block present")
        addrs = [b["addr"] for b in blocks]
        self.assertEqual(addrs, sorted(set(addrs)), "addresses not strictly ascending / duplicated")
        by = {b["addr"]: b["data"] for b in blocks}
        self.assertIn(XIP, by, "no partition table at flash 0")
        self.assertEqual(by[XIP][:4], bytes([0xD3, 0xDE, 0xFF, 0xFF]), "flash 0 is not a picobin block")
        self.assertEqual(by.get(XIP + 0x1000), b"\xff" * 256, "PT slot 1 not blanked")
        self.assertEqual(by.get(XIP + b_start), b"\xff" * 256, "slot B start not blanked")
        img = [a for a in addrs if XIP + a_start <= a < XIP + a_start + a_size]
        self.assertTrue(img, "no image in slot A")
        self.assertEqual(img[0], XIP + a_start)
        self.assertEqual(img, list(range(img[0], img[-1] + 256, 256)), "slot A image has a gap")
        others = set(addrs) - set(img) - {XIP + 0x1000, XIP + b_start}
        self.assertTrue(all(XIP <= a < XIP + 0x1000 for a in others), f"stray blocks {sorted(map(hex, others))}")
        if image is not None:
            got = b"".join(by[a] for a in img)
            self.assertEqual(got[:len(image)], image)
            self.assertEqual(got[len(image):], b"\x00" * (len(got) - len(image)))


class SyntheticTests(unittest.TestCase, StructuralChecks):
    def setUp(self):
        self.r = Run(self)

    def test_layout(self):
        pt, pt_page = pt_uf2()
        image = picobin_image(tbyb=False)
        r, data = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", image))
        self.assertEqual(r.returncode, 0, r.stderr)
        blocks = parse(data)
        self.check_structure(blocks, image)
        self.assertEqual(blocks[0]["data"], pt_page)
        self.assertEqual(len(blocks), 1 + 1 + (len(image) + 255) // 256 + 1)

    def test_deterministic(self):
        pt, _ = pt_uf2()
        args = (self.r.write("pt.uf2", pt), self.r.write("img.bin", picobin_image(False)))
        _, one = self.r.tool(*args)
        _, two = self.r.tool(*args)
        self.assertEqual(one, two)

    def test_refuses_tbyb_image(self):
        pt, _ = pt_uf2()
        r, data = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", picobin_image(True)))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("TBYB", r.stderr)
        self.assertIsNone(data)

    def test_refuses_image_without_image_def(self):
        pt, _ = pt_uf2()
        r, _ = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", b"\x00" * 1024))
        self.assertNotEqual(r.returncode, 0)

    def test_refuses_image_larger_than_slot_a(self):
        _, a_size, _ = slots()
        pt, _ = pt_uf2()
        r, _ = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", picobin_image(False, a_size + 256)))
        self.assertNotEqual(r.returncode, 0)

    def test_refuses_slot_in_top_sectors(self):
        with open(PARTITIONS) as f:
            p = json.load(f)
        p["partitions"][1]["start"] = "16364K"     # B's blank page at 0x10ffb000, the first record sector
        part = self.r.write("partitions.json", json.dumps(p).encode())
        pt, _ = pt_uf2()
        r, _ = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", picobin_image(False)), part)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("top 5", r.stderr)

    def test_refuses_slot_outside_flash(self):
        with open(PARTITIONS) as f:
            p = json.load(f)
        p["partitions"][1]["start"] = "16384K"
        part = self.r.write("partitions.json", json.dumps(p).encode())
        pt, _ = pt_uf2()
        r, _ = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", picobin_image(False)), part)
        self.assertNotEqual(r.returncode, 0)

    def test_refuses_stray_block_in_partition_table_uf2(self):
        pt = uf2_block(XIP, b"\xd3\xde\xff\xff", 0, 2) + uf2_block(XIP + 0x10000, b"x", 1, 2)
        r, _ = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", picobin_image(False)))
        self.assertNotEqual(r.returncode, 0)

    def test_drops_the_e10_block_from_the_partition_table_uf2(self):
        pt, _ = pt_uf2(with_e10=True)
        r, data = self.r.tool(self.r.write("pt.uf2", pt), self.r.write("img.bin", picobin_image(False)))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(E10, [b["addr"] for b in parse(data)])


REAL = os.environ.get("WF_INSTALL_UF2") or os.path.join(FW, "build", "wifi-floppy-install.uf2")


# Named explicitly (CI, after the build): it must exist. Defaulted: optional.
@unittest.skipUnless(os.environ.get("WF_INSTALL_UF2") or os.path.exists(REAL), f"no build output at {REAL}")
class RealBuildTests(unittest.TestCase, StructuralChecks):
    def test_real_install_uf2(self):
        with open(REAL, "rb") as f:
            blocks = parse(f.read())
        build = os.path.dirname(REAL)
        image = pt = None
        if os.path.exists(os.path.join(build, "wifi_floppy_install.bin")):
            with open(os.path.join(build, "wifi_floppy_install.bin"), "rb") as f:
                image = f.read()
        self.check_structure(blocks, image)
        if os.path.exists(os.path.join(build, "wifi_floppy_pt.uf2")):
            with open(os.path.join(build, "wifi_floppy_pt.uf2"), "rb") as f:
                pt = [b for b in parse(f.read()) if b["addr"] != E10]
            for b in pt:   # the table's own pages, carried over unchanged
                self.assertEqual(next(x["data"] for x in blocks if x["addr"] == b["addr"]), b["data"])

    def test_real_tbyb_image_is_refused(self):
        build = os.path.dirname(REAL)
        tbyb = os.path.join(build, "wifi_floppy.bin")
        pt = os.path.join(build, "wifi_floppy_pt.uf2")
        if not (os.path.exists(tbyb) and os.path.exists(pt)):
            self.skipTest("no wifi_floppy.bin / wifi_floppy_pt.uf2 beside the install UF2")
        r, _ = Run(self).tool(pt, tbyb)
        self.assertNotEqual(r.returncode, 0, "the OTA (TBYB) image must never go into an install UF2")
        self.assertIn("TBYB", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
