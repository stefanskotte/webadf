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

  3. A KEEPOUT THAT DID NOT GET FLIPPED WITH EVERYTHING ELSE - the rev A2
     follow-up. Pads, traces, silk, outline and drill were flipped but the
     antenna keepout polygon was not, so the ground-pour void landed at the
     far end of U1 and copper stayed under the RM2 antenna. Checked by
     reading copper out of the emitted B.Cu Gerber, not by re-deriving the
     void from the exporter - re-deriving is what missed it the first time.

Run this before sending anything to a fab.
"""
import re, sys, math, os

PCB = os.path.join(os.path.dirname(__file__), 'wifi_floppy.kicad_pcb')
GERBERS = os.path.join(os.path.dirname(__file__), 'gerbers')
REFDIR = os.path.join(os.path.dirname(__file__), 'ref_footprints')

# U1's pins at the antenna end of the module. The PIM726's header is the
# standard Pico header pin for pin (confirmed 2026-09-09 against its
# schematic sheet 3/3), so pin 1 = GP0 at the USB end and 19-22 = GP14-GP17
# at the far end. What is STILL unconfirmed is that the RM2's antenna is at
# that far end: a schematic carries no placement. This check enforces the
# design's assumption, it does not validate it.
ANTENNA_PINS = ['19', '20', '21', '22']

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
# exists. Named explicitly so they read as a known gap rather than an
# oversight.
#
# U1 is the operator's Pimoroni module, part PIM726, on a standard 2x20 THT
# Pico land pattern (rows 17.78 mm apart, 19 x 2.54 mm along). There is no
# KiCad library footprint to compare that against, so it is the one part on
# this board that must be checked by hand against the module's own mechanical
# drawing.
#
# CONFIRMED by the operator 2026-09-04: the PIM726 carries the PSRAM this
# design needs. That matters because nothing here can check it -- the firmware
# builds for PICO_BOARD=pimoroni_pico_plus2_w_rp2350 and psram_image.c is a
# 2.03 MB image store, which is how a disk is served at all. A module without
# PSRAM would fit this footprint perfectly and then fail to run the firmware,
# so the part number is a requirement, not a preference.
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

# Rounded ONCE, after the flip. Rounding to 2 dp and then flipping rounds
# twice, which moved 8 of the 122 pads across a boundary and reported a
# healthy board as 114/122 - noise that makes a real miss easy to wave off.
pcb_pts = {(ox + x, oy + y)
           for fpn, pads, (ox, oy) in board.values() for (x, y) in pads.values()}
gtl = open(os.path.join(GERBERS, 'wifi_floppy.GTL')).read()
ger_pts = {(round(int(m.group(1))/1e6, 2), round(int(m.group(2))/1e6, 2))
           for m in re.finditer(r'X(-?\d+)Y(-?\d+)D03\*', gtl)}

want_flip   = {(round(x, 2), round(yflip - y, 2)) for x, y in pcb_pts}
hit_flipped = len(want_flip & ger_pts)
hit_plain   = len({(round(x, 2), round(y, 2)) for x, y in pcb_pts} & ger_pts)
print(f"  mirror axis Y = {yflip/2:.1f} mm")
print(f"  pads landing at mirrored Y : {hit_flipped}/{len(pcb_pts)}")
print(f"  pads landing at un-mirrored Y: {hit_plain}/{len(pcb_pts)}")
if hit_flipped > hit_plain:
    print("  gerber is correctly Y-flipped: OK")
else:
    print("  *** FAIL: gerber is MIRRORED - parts cannot be soldered ***")
    fail += 1


print("\n== antenna keepout placement ==")
# Bug 3 of the rev A2 errata. export_gerbers.py flipped Y for pads, traces,
# silk, outline and drill but NOT for the keepout zone polygon, so the void
# landed at the far end of the module and copper stayed under the RM2
# antenna.
#
# The audit that missed it re-derived the void from the same unflipped
# polygon it was checking - self-consistent, and self-consistently wrong.
# So this check does NOT ask the exporter what it meant to do. It reads the
# emitted B.Cu gerber and asks where the copper actually is. Pure stdlib:
# `pnpm hw:verify` runs under system python3, which has no shapely.

def keepout_from_pcb(src):
    """The (unflipped) keepout rectangle, as x/y bounds."""
    # Bound each zone at the next one. A fixed-size window runs past the end
    # of the keepout into the GND pour's own outline, and the union of the
    # two is the whole board - which silently "covers" every pin.
    starts = [m.start() for m in re.finditer(r'\(zone\b', src)] + [len(src)]
    for a, b in zip(starts, starts[1:]):
        blk = src[a:b]
        if 'copperpour not_allowed' not in blk:
            continue
        poly = re.search(r'\(polygon\s*\(pts(.*?)\)\s*\)\s*\)', blk, re.S)
        if not poly:
            continue
        pts = [(float(x), float(y)) for x, y in
               re.findall(r'\(xy ([\-\d\.]+) ([\-\d\.]+)\)', poly.group(1))]
        if pts:
            return (min(q[0] for q in pts), min(q[1] for q in pts),
                    max(q[0] for q in pts), max(q[1] for q in pts))
    return None

def gbl_regions(path):
    """(dark, clear) region rings from a gerber, in mm."""
    dark, clear, ring = [], [], []
    inside, pol = False, 'D'
    for line in open(path):
        line = line.strip()
        if line == '%LPD*%': pol = 'D'
        elif line == '%LPC*%': pol = 'C'
        elif line == 'G36*': inside, ring = True, []
        elif line == 'G37*':
            inside = False
            (dark if pol == 'D' else clear).append(ring)
        elif inside:
            m = re.match(r'X(-?\d+)Y(-?\d+)D0[12]\*', line)
            if m:
                ring.append((int(m.group(1)) / 1e6, int(m.group(2)) / 1e6))
    return dark, clear

def in_ring(pt, ring):
    x, y = pt
    inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside

def copper_at(pt, dark, clear):
    return (any(in_ring(pt, r) for r in dark)
            and not any(in_ring(pt, r) for r in clear))

def sample(x1, y1, x2, y2, dark, clear, n=5):
    """Fraction of an inset grid over a rectangle that is copper."""
    ix, iy = (x2 - x1) * 0.15, (y2 - y1) * 0.15
    pts = [(x1 + ix + (x2 - x1 - 2 * ix) * i / (n - 1),
            y1 + iy + (y2 - y1 - 2 * iy) * j / (n - 1))
           for i in range(n) for j in range(n)]
    return sum(copper_at(p, dark, clear) for p in pts), len(pts)

ko = keepout_from_pcb(src)
if not ko:
    print("  no keepout zone in the pcb *** FAIL ***"); fail += 1
else:
    kx1, ky1, kx2, ky2 = ko
    # where the void belongs, and the mirror-image rectangle where the A2
    # bug put it instead
    want = (kx1, yflip - ky2, kx2, yflip - ky1)
    wrong = (kx1, ky1, kx2, ky2)

    u1 = board.get('U1')
    if u1:
        _fpn, u1pads, (ox, oy) = u1
        covered = sorted((n for n, (x, y) in u1pads.items()
                          if want[0] <= ox + x <= want[2]
                          and want[1] <= yflip - (oy + y) <= want[3]), key=int)
        print(f"  keepout covers U1 pins {covered}")
        if covered != ANTENNA_PINS:
            print(f"  *** FAIL: expected the antenna-end pins {ANTENNA_PINS} ***")
            fail += 1

    dark, clear = gbl_regions(os.path.join(GERBERS, 'wifi_floppy.GBL'))
    got_cu, n = sample(*want, dark, clear)
    bad_cu, _ = sample(*wrong, dark, clear)
    print(f"  emitted B.Cu at the antenna end: {got_cu}/{n} sample points are copper "
          f"(want 0)")
    print(f"  emitted B.Cu at the far end    : {bad_cu}/{n} sample points are copper "
          f"(want {n})")
    if got_cu:
        print("  *** FAIL: ground pour under the RM2 antenna ***"); fail += 1
    elif bad_cu < n:
        print("  *** FAIL: the void mirrored to the wrong end of the module ***")
        fail += 1
    else:
        print("  void is at the antenna end and nowhere else: OK")


print("\n== silkscreen manufacturability ==")
# Rev A and rev A2 both went out below JLCPCB's published 6 mil minimum -
# 0.12 mm for the outlines, 0.15 for the J1 chevron. JLC printed them anyway,
# so this is a spec violation rather than a proven failure, but a layer that
# only prints because the fab was lenient is not one to ship again. Read out
# of the emitted .GTO, like the keepout check: the question is what the fab
# receives, not what the exporter intended.
SILK_MIN_W = 6 * 0.0254        # JLCPCB minimum silkscreen line width, 6 mil
SILK_MIN_H = 0.8               # ...and minimum legible text height

gto = open(os.path.join(GERBERS, 'wifi_floppy.GTO')).read()
aps = {int(m.group(1)): [float(v) for v in m.group(3).split('X')]
       for m in re.finditer(r'%ADD(\d+)([CR]),([\d.X]+)\*%', gto)}
used = {int(m.group(1)) for m in re.finditer(r'^D(\d+)\*$', gto, re.M)}
strokes = len(re.findall(r'D01\*', gto))
flashes = len(re.findall(r'D03\*', gto))
widths = sorted({w for d in used if d in aps for w in aps[d]})
print(f"  {strokes} strokes, {flashes} flashes, widths {widths} mm")

if strokes + flashes == 0:
    print("  *** FAIL: the silkscreen layer is empty ***"); fail += 1
elif widths and widths[0] < SILK_MIN_W:
    thin = [w for w in widths if w < SILK_MIN_W]
    print(f"  *** FAIL: {thin} below JLCPCB's {SILK_MIN_W:.4f} mm minimum - "
          f"below the fab's published minimum - printing is not guaranteed ***")
    fail += 1
else:
    print(f"  every feature is at or above {SILK_MIN_W:.4f} mm: OK")

# Text height cannot be recovered from a stroked gerber, so it is checked at
# the source instead - stated plainly rather than left looking covered.
# bounded window, and DOTALL: a gr_text puts its layer and its effects on
# separate lines, so a newline-shy pattern silently skips every one of them
heights = sorted({float(m.group(1)) for m in
                  re.finditer(r'F\.SilkS.{0,160}?\(font \(size [\d.]+ ([\d.]+)\)',
                              src, re.S)})
if heights:
    print(f"  text heights in the .kicad_pcb (not the gerber): {heights} mm")
    if heights[0] < SILK_MIN_H:
        print(f"  *** FAIL: below the {SILK_MIN_H} mm legible minimum ***"); fail += 1

if unchecked:
    print(f"\n{unchecked} footprint(s) had no reference and were NOT checked.")
print(f"\n{'ALL CHECKS PASSED' if fail == 0 else f'*** {fail} FAILURE(S) - DO NOT FAB ***'}")
sys.exit(1 if fail else 0)
