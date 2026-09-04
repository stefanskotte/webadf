#!/usr/bin/env python3
"""
Pre-fab verification. Catches the two failures that got the first batch of
boards scrapped:

  1. MIRRORED FOOTPRINTS - a footprint that is a reflection (not a rotation)
     of the canonical KiCad land pattern cannot have a real part soldered to
     it. Checked against footprints fetched from the KiCad library.

  2. MIRRORED GERBERS - Gerber/Excellon use Y-up, KiCad uses Y-down. If the
     exporter forgets to flip, every layer comes out reflected and the board
     is scrap. Checked by comparing the emitted Gerber against the .kicad_pcb.

Run this before sending anything to a fab.
"""
import re, sys, math, os

PCB = os.path.join(os.path.dirname(__file__), 'wifi_floppy.kicad_pcb')
GERBERS = os.path.join(os.path.dirname(__file__), 'gerbers')
REFDIR = os.path.join(os.path.dirname(__file__), 'ref_footprints')

# canonical KiCad land patterns, {ref_prefix: (file, {pad: (x, y)})}
# fetched from github.com/KiCad/kicad-footprints
REFS = {
    'SOT-23': 'SOT-23.kicad_mod',
    'SOIC-20W': 'SOIC-20W_7.5x12.8mm_P1.27mm.kicad_mod',
}

def pads_from_mod(path):
    t = open(path).read()
    return {m.group(1): (float(m.group(2)), float(m.group(3)))
            for m in re.finditer(r'\(pad (\w+) smd \w+ \(at ([\-\d\.]+) ([\-\d\.]+)\)', t)}

def pads_from_pcb(path):
    src = open(path).read()
    idx = [m.start() for m in re.finditer(r'\n \(footprint "', src)] + [len(src)]
    out = {}
    for a, b in zip(idx, idx[1:]):
        blk = src[a:b]
        ref = re.search(r'fp_text reference "([^"]+)"', blk).group(1)
        fpn = re.search(r'\(footprint "([^"]+)"', blk).group(1)
        org = re.search(r'\(at ([\-\d\.]+) ([\-\d\.]+)\)', blk)
        ox, oy = float(org.group(1)), float(org.group(2))
        pads = {m.group(1): (float(m.group(2)), float(m.group(3)))
                for m in re.finditer(r'\(pad "(\w+)" \w+ \w+ \(at ([\-\d\.]+) ([\-\d\.]+)\)', blk)}
        out[ref] = (fpn, pads, (ox, oy))
    return out

def centre(p):
    cx = sum(v[0] for v in p.values()) / len(p)
    cy = sum(v[1] for v in p.values()) / len(p)
    return {k: (v[0] - cx, v[1] - cy) for k, v in p.items()}

def rot(p, deg):
    r = math.radians(deg); c, s = round(math.cos(r)), round(math.sin(r))
    return {k: (v[0]*c - v[1]*s, v[0]*s + v[1]*c) for k, v in p.items()}

def refl(p):
    return {k: (v[0], -v[1]) for k, v in p.items()}

def same(a, b, tol=0.4):
    return set(a) == set(b) and all(
        abs(a[k][0]-b[k][0]) < tol and abs(a[k][1]-b[k][1]) < tol for k in a)

def classify(mine, canon):
    A, B = centre(mine), centre(canon)
    for d in (0, 90, 180, 270):
        if same(A, rot(B, d)): return True, f"rotation {d} deg"
    for d in (0, 90, 180, 270):
        if same(A, rot(refl(B), d)): return False, f"REFLECTION + {d} deg"
    return None, "no match"

fail = 0
print("== footprint chirality ==")
board = pads_from_pcb(PCB)
for ref, (fpn, pads, _org) in sorted(board.items()):
    key = next((k for k in REFS if k in fpn), None)
    if not key:
        print(f"  {ref:4s} {fpn:45s} no reference - check by hand")
        continue
    refpath = os.path.join(REFDIR, REFS[key])
    if not os.path.exists(refpath):
        print(f"  {ref:4s} reference {REFS[key]} missing"); continue
    ok, how = classify(pads, pads_from_mod(refpath))
    mark = "OK " if ok else "*** FAIL ***"
    print(f"  {ref:4s} {key:10s} {mark} ({how})")
    if not ok: fail += 1

print("\n== gerber orientation ==")
# The real test: every pad flash in the Gerber must sit at the MIRRORED Y of
# its position in the .kicad_pcb. If the exporter forgot the flip, the pads
# land at the un-mirrored Y instead - which is exactly how the first batch of
# boards came back reflected.
src = open(PCB).read()
ey = [float(v) for m in re.finditer(
        r'\(gr_line \(start ([\-\d\.]+) ([\-\d\.]+)\) \(end ([\-\d\.]+) ([\-\d\.]+)\)', src)
      for v in (m.group(2), m.group(4))]
yflip = min(ey) + max(ey)

pcb_pts = {(round(ox + x, 2), round(oy + y, 2))
           for fpn, pads, (ox, oy) in board.values() for (x, y) in pads.values()}
gtl = open(os.path.join(GERBERS, 'wifi_floppy.GTL')).read()
ger_pts = {(round(int(m.group(1))/1e6, 2), round(int(m.group(2))/1e6, 2))
           for m in re.finditer(r'X(-?\d+)Y(-?\d+)D03\*', gtl)}

want_flip   = {(x, round(yflip - y, 2)) for x, y in pcb_pts}
hit_flipped = len(want_flip & ger_pts)
hit_plain   = len(pcb_pts & ger_pts)
print(f"  mirror axis Y = {yflip/2:.1f} mm")
print(f"  pads landing at mirrored Y : {hit_flipped}/{len(pcb_pts)}")
print(f"  pads landing at un-mirrored Y: {hit_plain}/{len(pcb_pts)}")
if hit_flipped > hit_plain:
    print("  gerber is correctly Y-flipped: OK")
else:
    print("  *** FAIL: gerber is MIRRORED - parts cannot be soldered ***")
    fail += 1

print(f"\n{'ALL CHECKS PASSED' if fail == 0 else f'*** {fail} FAILURE(S) - DO NOT FAB ***'}")
sys.exit(1 if fail else 0)
