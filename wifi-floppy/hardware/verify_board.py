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
    # Added 2026-09-04 so the run has no unexplained "check by hand" lines.
    # These four are MIRROR-SYMMETRIC, so they cannot catch a reflection --
    # the report says so per part. What they do catch is a land pattern that
    # is the wrong SIZE or pitch, or a footprint swapped for a similar one,
    # which is worth having and is not what the first board got wrong.
    'C_0603': 'C_0603_1608Metric.kicad_mod',
    'C_0805': 'C_0805_2012Metric.kicad_mod',
    'D_SMA': 'D_SMA.kicad_mod',
    'PinHeader_2x17': 'PinHeader_2x17_P2.54mm_Vertical.kicad_mod',
    'PinHeader_1x04': 'PinHeader_1x04_P2.54mm_Vertical.kicad_mod',
}

# Footprints this project draws itself, for which no upstream reference
# exists. Named explicitly so they read as a known gap rather than as an
# oversight -- U1 is the Pico 2 W land pattern and has to be eyeballed against
# the module's own datasheet.
NO_UPSTREAM = ('Pico2W_THT',)

def pads_from_mod(path):
    """
    Pads from a .kicad_mod, in EITHER format and for any pad type.

    The first version of this matched only `(pad 1 smd rect (at x y)` on one
    line and unquoted -- which is how the two hand-fetched references happened
    to be written. Everything KiCad emits today quotes the pad name and puts
    `(at ...)` on its own line, and a thru_hole pad says thru_hole rather than
    smd. Against a modern file the old pattern matched NOTHING, so a reference
    added from the local KiCad library would have compared an empty pad set
    and reported a cheerful pass.
    """
    t = open(path).read()
    out = {}
    for m in re.finditer(r'\(pad\s+"?([^\s")]+)"?\s+(\w+)\s+\w+', t):
        at = re.search(r'\(at\s+([\-\d\.]+)\s+([\-\d\.]+)', t[m.end():m.end() + 400])
        if at:
            out[m.group(1)] = (float(at.group(1)), float(at.group(2)))
    return out

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

def mirror_symmetric(canon):
    """
    True when the canonical land pattern is its own mirror image.

    For such a footprint CHIRALITY IS NOT DECIDABLE: a reflection is
    indistinguishable from a rotation, so the check below can never fail and
    reporting "OK" would claim a guarantee that was never tested. A two-pad
    0805, an SMA diode and a straight pin header are all in this class; a
    SOT-23 and a SOIC are not, which is why those two catch a real mirror.
    """
    B = centre(canon)
    return any(same(B, rot(refl(B), d)) for d in (0, 90, 180, 270))


def classify(mine, canon):
    A, B = centre(mine), centre(canon)
    for d in (0, 90, 180, 270):
        if same(A, rot(B, d)):
            # The land pattern matches. Say whether that actually proves
            # anything about chirality, rather than implying it always does.
            if mirror_symmetric(canon):
                return True, f"rotation {d} deg; symmetric, so chirality is not decidable"
            return True, f"rotation {d} deg"
    for d in (0, 90, 180, 270):
        if same(A, rot(refl(B), d)): return False, f"REFLECTION + {d} deg"
    return None, "no match"

fail = 0
unchecked = 0
print("== footprint chirality ==")
board = pads_from_pcb(PCB)
for ref, (fpn, pads, _org) in sorted(board.items()):
    key = next((k for k in REFS if k in fpn), None)
    if not key:
        why = ("this project's own footprint - check against the datasheet"
               if any(n in fpn for n in NO_UPSTREAM)
               else "NO REFERENCE - add one to ref_footprints/")
        print(f"  {ref:4s} {fpn:45s} {why}")
        # An unreferenced footprint that is NOT a known-custom one is a gap in
        # this check, not a pass. Counting it keeps the summary honest.
        if not any(n in fpn for n in NO_UPSTREAM):
            unchecked += 1
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

if unchecked:
    print(f"\n{unchecked} footprint(s) had no reference and were NOT checked.")
print(f"\n{'ALL CHECKS PASSED' if fail == 0 else f'*** {fail} FAILURE(S) - DO NOT FAB ***'}")
sys.exit(1 if fail else 0)
