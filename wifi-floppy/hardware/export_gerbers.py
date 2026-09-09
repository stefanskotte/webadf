#!/usr/bin/env python3
"""
Export wifi_floppy.kicad_pcb to a JLCPCB-ready Gerber + Excellon set.

Reads the .kicad_pcb (not the generator's variables) so the fab output can
only ever describe what is actually in the board file.

The B.Cu ground pour is computed here as real geometry with shapely:
  pour = board inset by edge clearance
       - clearance around every foreign (non-GND) pad, via and trace
       - annular clearance around GND through-hole pads
       + thermal spokes back onto those GND pads
Holes in the resulting polygons are emitted as clear-polarity regions, which
is the standard Gerber way to express them.

Outputs (JLCPCB-recognised extensions):
  .GTL/.GBL copper, .GTS/.GBS solder mask, .GTO silkscreen,
  .GKO board outline, .TXT Excellon drill (plated)
"""
import os, re, math, zipfile
from shapely.geometry import Polygon, box, Point, LineString
from shapely.ops import unary_union
import stroke_font

# Paths resolve against THIS FILE, not the working directory. These were
# absolute /home/claude/... paths from wherever the script was first written,
# so none of them could run on another machine -- which is why the board could
# not be regenerated here until 2026-09-04.
HERE = os.path.dirname(os.path.abspath(__file__))

SRC = os.path.join(HERE, 'wifi_floppy.kicad_pcb')
OUTDIR = os.path.join(HERE, 'gerbers')
STEM = 'wifi_floppy'

# --- fab rules -------------------------------------------------------------
POUR_CLEARANCE = 0.30      # copper-to-pour
EDGE_CLEARANCE = 0.30      # pour pullback from board edge
MASK_EXPANSION = 0.05      # matches (pad_to_mask_clearance 0.05) in the pcb
THERMAL_SPOKE_W = 0.45     # spoke width on GND through-hole pads
VIA_TENTED = True          # JLC default: vias covered by mask
SILK_MIN_W = 6 * 0.0254    # JLCPCB minimum silkscreen line width, 6 mil
SILK_MIN_H = 0.8           # ...and minimum legible text height
SILK_PAD_CLR = 0.15        # keep legend ink off pads by at least this

# ---------------------------------------------------------------- s-expr
def tokenize(s): return re.findall(r'\(|\)|"[^"]*"|[^\s()"]+', s)
def parse(t, i=0):
    node, i = [], i + 1
    while t[i] != ')':
        if t[i] == '(':
            c, i = parse(t, i); node.append(c)
        else:
            node.append(t[i].strip('"')); i += 1
    return node, i + 1

root, _ = parse(tokenize(open(SRC).read()))
def kids(n, name): return [c for c in n if isinstance(c, list) and c and c[0] == name]
def first(n, name):
    k = kids(n, name); return k[0] if k else None
def nums(n, c): return [float(v) for v in n[1:1 + c]]

# ---------------------------------------------------------------- extract
# CRITICAL: KiCad's coordinate system has Y increasing DOWNWARD; Gerber and
# Excellon have Y increasing UPWARD. Every coordinate is flipped here, once,
# at parse time, so copper, mask, silk, outline and drill all stay consistent.
# Omitting this produces a board that is a perfect mirror image of the design
# and cannot have its parts soldered to it.
YFLIP = None            # set once the board extents are known

def fy(y):
    return y if YFLIP is None else YFLIP - y

segments, vias, pads, edges, silks = [], [], [], [], []
silk_dots = []          # filled circles -> a single flash
silk_text = []          # (string, x, y, height, thickness, rotation)

_ey = [v for gl in kids(root, 'gr_line') if first(gl, 'layer')[1] == 'Edge.Cuts'
       for v in (nums(first(gl, 'start'), 2)[1], nums(first(gl, 'end'), 2)[1])]
YFLIP = min(_ey) + max(_ey)          # mirror about the board's own centre line

for s in kids(root, 'segment'):
    _a = nums(first(s, 'start'), 2); _b = nums(first(s, 'end'), 2)
    _a[1] = fy(_a[1]); _b[1] = fy(_b[1])
    segments.append((_a, _b,
                     nums(first(s, 'width'), 1)[0], first(s, 'layer')[1],
                     first(s, 'net')[1]))
for v in kids(root, 'via'):
    _at = nums(first(v, 'at'), 2); _at[1] = fy(_at[1])
    vias.append((_at, nums(first(v, 'size'), 1)[0],
                 nums(first(v, 'drill'), 1)[0], first(v, 'net')[1]))
for gl in kids(root, 'gr_line'):
    if first(gl, 'layer')[1] == 'Edge.Cuts':
        _a = nums(first(gl, 'start'), 2); _b = nums(first(gl, 'end'), 2)
        _a[1] = fy(_a[1]); _b[1] = fy(_b[1])
        edges.append((_a, _b))
for fp in kids(root, 'footprint'):
    ox, oy = nums(first(fp, 'at'), 2)
    ref = next((t[2] for t in kids(fp, 'fp_text') if t[1] == 'reference'), '')
    for fl in kids(fp, 'fp_line'):
        ly = first(fl, 'layer')
        if ly and ly[1] == 'F.SilkS':
            a = nums(first(fl, 'start'), 2); b = nums(first(fl, 'end'), 2)
            silks.append(((ox + a[0], fy(oy + a[1])), (ox + b[0], fy(oy + b[1])),
                          nums(first(first(fl, 'stroke'), 'width'), 1)[0]))
    # A circle is silkscreen too. Reading only fp_line dropped U2's pin-1 dot
    # without saying so, which is the marker that stops the part going on
    # backwards.
    for fc in kids(fp, 'fp_circle'):
        ly = first(fc, 'layer')
        if not (ly and ly[1] == 'F.SilkS'):
            continue
        c = nums(first(fc, 'center'), 2); e = nums(first(fc, 'end'), 2)
        r = math.hypot(e[0] - c[0], e[1] - c[1])
        w = nums(first(first(fc, 'stroke'), 'width'), 1)[0]
        cx, cy = ox + c[0], fy(oy + c[1])
        fill = first(fc, 'fill')
        if fill and fill[1] in ('solid', 'yes'):
            silk_dots.append((cx, cy, 2 * r + w))     # ink covers the stroke
        else:
            n = 32
            ring = [(cx + r * math.cos(2*math.pi*i/n), cy + r * math.sin(2*math.pi*i/n))
                    for i in range(n + 1)]
            for a, b in zip(ring, ring[1:]):
                silks.append((a, b, w))
    # Reference designators. Without these the board has no lettering at all.
    for t in kids(fp, 'fp_text'):
        ly = first(t, 'layer')
        if t[1] != 'reference' or not (ly and ly[1] == 'F.SilkS'):
            continue
        at = first(t, 'at'); a = nums(at, 2)
        rot = float(at[3]) if len(at) > 3 else 0.0
        font = first(first(t, 'effects'), 'font')
        h = nums(first(font, 'size'), 2)[1]
        th = nums(first(font, 'thickness'), 1)[0]
        silk_text.append((t[2], ox + a[0], fy(oy + a[1]), h, th, rot))
    for pad in kids(fp, 'pad'):
        at = nums(first(pad, 'at'), 2); size = nums(first(pad, 'size'), 2)
        dr = first(pad, 'drill'); net = first(pad, 'net')
        pads.append(dict(num=pad[1], type=pad[2], shape=pad[3],
                         x=ox + at[0], y=fy(oy + at[1]), w=size[0], h=size[1],
                         drill=float(dr[1]) if dr else 0.0,
                         net=(net[2] if net and len(net) > 2 else ''), ref=ref))

for t in kids(root, 'gr_text'):
    ly = first(t, 'layer')
    if not (ly and ly[1] == 'F.SilkS'):
        continue
    at = first(t, 'at'); a = nums(at, 2)
    rot = float(at[3]) if len(at) > 3 else 0.0
    font = first(first(t, 'effects'), 'font')
    h = nums(first(font, 'size'), 2)[1]
    th = nums(first(font, 'thickness'), 1)[0]
    # the s-expression carries a literal backslash-n, not a newline
    silk_text.append((t[1].replace('\\n', '\n'), a[0], fy(a[1]), h, th, rot))

keepouts = []
for z in kids(root, 'zone'):
    ko = first(z, 'keepout')
    if not ko: continue
    cp = first(ko, 'copperpour')
    if cp and cp[1] == 'not_allowed':
        pts = first(first(z, 'polygon'), 'pts')
        # The zone polygon is a coordinate like any other and must be
        # Y-flipped too. Flipping the pads, traces, silk, outline and
        # drill but NOT this put the void at the far end of the module
        # on the rev A2 boards, leaving copper under the RM2 antenna.
        keepouts.append([[q[0], fy(q[1])]
                         for q in (nums(p, 2) for p in kids(pts, 'xy'))])
print(f'keepout zones: {len(keepouts)}')

xs = [p for e in edges for p in (e[0][0], e[1][0])]
ys = [p for e in edges for p in (e[0][1], e[1][1])]
BX1, BX2, BY1, BY2 = min(xs), max(xs), min(ys), max(ys)
print(f'Y flipped about {YFLIP/2:.1f} mm (KiCad Y-down -> Gerber Y-up)')
print(f'board {BX2-BX1:.1f} x {BY2-BY1:.1f} mm  '
      f'{len(segments)} segs {len(vias)} vias {len(pads)} pads')

# ---------------------------------------------------------------- geometry
def pad_shape(p, grow=0.0):
    if p['shape'] == 'circle' or (p['type'] == 'thru_hole' and p['shape'] != 'rect'):
        return Point(p['x'], p['y']).buffer(p['w'] / 2 + grow, 64)
    return box(p['x'] - p['w']/2 - grow, p['y'] - p['h']/2 - grow,
               p['x'] + p['w']/2 + grow, p['y'] + p['h']/2 + grow)

def seg_shape(s, grow=0.0):
    return LineString([s[0], s[1]]).buffer(s[2]/2 + grow, 16, cap_style=1)

def on_layer(p, layer):
    return p['type'] == 'thru_hole' or layer == 'F.Cu'   # SMD pads are top-side

# --- B.Cu pour -------------------------------------------------------------
pour = box(BX1 + EDGE_CLEARANCE, BY1 + EDGE_CLEARANCE,
           BX2 - EDGE_CLEARANCE, BY2 - EDGE_CLEARANCE)

cutters, foreign, spokes = [], [], []
for p in pads:
    if not on_layer(p, 'B.Cu'):
        continue
    if p['net'] == 'GND':
        # annular clearance + thermal spokes so the pad is still solderable
        cutters.append(pad_shape(p, POUR_CLEARANCE))
        r = max(p['w'], p['h']) / 2 + POUR_CLEARANCE + 0.15
        for ang in (0, 90, 180, 270):
            a = math.radians(ang)
            spokes.append(LineString([
                (p['x'], p['y']),
                (p['x'] + r * math.cos(a), p['y'] + r * math.sin(a))
            ]).buffer(THERMAL_SPOKE_W / 2, 8, cap_style=2))
    else:
        c = pad_shape(p, POUR_CLEARANCE); cutters.append(c); foreign.append(c)

for s in segments:
    if s[3] == 'B.Cu' and s[4] != '1':          # net 1 == GND
        c = seg_shape(s, POUR_CLEARANCE); cutters.append(c); foreign.append(c)
for v in vias:
    if v[3] != '1':
        c = Point(v[0]).buffer(v[1]/2 + POUR_CLEARANCE, 64)
        cutters.append(c); foreign.append(c)

ko_shapes = [Polygon(k) for k in keepouts]
if ko_shapes:
    cutters.extend(ko_shapes)          # no pour under the antenna
    foreign.extend(ko_shapes)
pour = pour.difference(unary_union(cutters))
if spokes:
    inner = box(BX1 + EDGE_CLEARANCE, BY1 + EDGE_CLEARANCE,
                BX2 - EDGE_CLEARANCE, BY2 - EDGE_CLEARANCE)
    sp = unary_union(spokes).intersection(inner)
    if foreign:
        sp = sp.difference(unary_union(foreign))   # keep foreign clearance
    pour = pour.union(sp)
# drop slivers thinner than the zone min_thickness
pour = pour.buffer(-0.125, 16).buffer(0.125, 16)
polys = [pour] if pour.geom_type == 'Polygon' else list(pour.geoms)
polys = [g for g in polys if g.area > 0.05]
print(f'pour: {len(polys)} islands, {pour.area:.0f} mm2, '
      f'{sum(len(g.interiors) for g in polys)} holes')

# ---------------------------------------------------------------- gerber
class G:
    def __init__(self, fn, title):
        self.f = open(fn, 'w'); self.ap = {}; self.n = 10
        w = self.f.write
        w('%TF.GenerationSoftware,wifi_floppy,export_gerbers*%\n')
        w(f'%TF.FileFunction,{title}*%\n')
        w('%FSLAX36Y36*%\n%MOMM*%\n%LPD*%\n')
    def aperture(self, kind, *a):
        key = (kind, a)
        if key not in self.ap:
            self.ap[key] = self.n
            spec = 'C,%.4f' % a[0] if kind == 'C' else 'R,%.4fX%.4f' % a
            self.f.write(f'%ADD{self.n}{spec}*%\n'); self.n += 1
        return self.ap[key]
    def use(self, d): self.f.write(f'D{d}*\n')
    @staticmethod
    def c(v): return f'{round(v*1e6):d}'
    def flash(self, x, y): self.f.write(f'X{self.c(x)}Y{self.c(y)}D03*\n')
    def line(self, a, b):
        self.f.write(f'X{self.c(a[0])}Y{self.c(a[1])}D02*\n')
        self.f.write(f'X{self.c(b[0])}Y{self.c(b[1])}D01*\n')
    def region(self, ring, dark=True):
        self.f.write('%LPD*%\n' if dark else '%LPC*%\n')
        self.f.write('G36*\n')
        pts = list(ring.coords)
        self.f.write(f'X{self.c(pts[0][0])}Y{self.c(pts[0][1])}D02*\n')
        for x, y in pts[1:]:
            self.f.write(f'X{self.c(x)}Y{self.c(y)}D01*\n')
        self.f.write('G37*\n')
        if not dark: self.f.write('%LPD*%\n')
    def close(self): self.f.write('M02*\n'); self.f.close()

os.makedirs(OUTDIR, exist_ok=True)
def path(ext): return os.path.join(OUTDIR, f'{STEM}.{ext}')

import shutil
_notes = os.path.join(HERE, 'README_JLCPCB.txt')
if os.path.exists(_notes):
    shutil.copy(_notes, os.path.join(OUTDIR, 'README_JLCPCB.txt'))

def draw_copper(g, layer, with_pour=False):
    if with_pour:
        for poly in polys:
            g.region(poly.exterior, dark=True)
            for hole in poly.interiors:
                g.region(hole, dark=False)
    for s in segments:
        if s[3] != layer: continue
        g.use(g.aperture('C', s[2])); g.line(s[0], s[1])
    for p in pads:
        if not on_layer(p, layer): continue
        if p['shape'] == 'rect':
            g.use(g.aperture('R', p['w'], p['h']))
        else:
            g.use(g.aperture('C', p['w']))
        g.flash(p['x'], p['y'])
    for v in vias:
        g.use(g.aperture('C', v[1])); g.flash(v[0][0], v[0][1])

for layer, ext, fn in (('F.Cu', 'GTL', 'Copper,L1,Top'),
                       ('B.Cu', 'GBL', 'Copper,L2,Bot')):
    g = G(path(ext), fn)
    draw_copper(g, layer, with_pour=(layer == 'B.Cu'))
    g.close()

# solder mask: openings over pads (vias tented)
for layer, ext, fn in (('F.Cu', 'GTS', 'Soldermask,Top'),
                       ('B.Cu', 'GBS', 'Soldermask,Bot')):
    g = G(path(ext), fn)
    for p in pads:
        if not on_layer(p, layer): continue
        if p['shape'] == 'rect':
            g.use(g.aperture('R', p['w'] + 2*MASK_EXPANSION, p['h'] + 2*MASK_EXPANSION))
        else:
            g.use(g.aperture('C', p['w'] + 2*MASK_EXPANSION))
        g.flash(p['x'], p['y'])
    if not VIA_TENTED:
        for v in vias:
            g.use(g.aperture('C', v[1])); g.flash(v[0][0], v[0][1])
    g.close()

# silkscreen: outlines, pin-1 markers and stroke-font text
legend = [(a, b, w, 'outline') for a, b, w in silks]
for txt, tx, ty, h, th, rot in silk_text:
    # KiCad rotates counter-clockwise in a Y-DOWN frame; after the Y flip that
    # is clockwise, hence the sign. Every text on this board is at rotation 0,
    # so the sign is reasoned, not observed - check it if you ever rotate one.
    for a, b in stroke_font.strokes(txt, tx, ty, h, rotation=-rot):
        legend.append((a, b, th, f'text {txt!r}'))

g = G(path('GTO'), 'Legend,Top')
for a, b, w, _src in legend:
    g.use(g.aperture('C', w)); g.line(a, b)
for x, y, d in silk_dots:
    g.use(g.aperture('C', d)); g.flash(x, y)
g.close()

# --- silkscreen DFM --------------------------------------------------------
# The first two batches went out at 0.12 or 0.15 mm, under JLCPCB's 6 mil
# minimum. They printed anyway, but nothing here was checking, so nobody knew
# the layer was out of spec until a photo of a finished board raised it. This
# checks, and it is loud.
thin = sorted({w for _a, _b, w, _s in legend if w < SILK_MIN_W} |
              {d for _x, _y, d in silk_dots if d < SILK_MIN_W})
short = sorted({h for _t, _x, _y, h, _th, _r in silk_text if h < SILK_MIN_H})
print(f'silk: {len(legend)} strokes, {len(silk_dots)} dots, {len(silk_text)} text items')
_missing = {c for t, *_ in silk_text for c in stroke_font.unsupported(t)}
if _missing:
    print(f'  *** stroke font has no glyph for {sorted(_missing)} - they print as \"?\" ***')
if thin:
    print(f'  *** {len(thin)} silk width(s) below {SILK_MIN_W:.4f} mm: {thin} '
          f'- JLCPCB WILL STRIP THIS LAYER ***')
if short:
    print(f'  *** text height(s) below {SILK_MIN_H} mm: {short} ***')

# ink on a pad is a solder defect, not a cosmetic one
_padshapes = unary_union([pad_shape(p, SILK_PAD_CLR) for p in pads])
_hits = {}
for a, b, w, src in legend:
    if LineString([a, b]).buffer(w / 2, 8).intersects(_padshapes):
        _hits[src] = _hits.get(src, 0) + 1
for x, y, d in silk_dots:
    if Point(x, y).buffer(d / 2, 16).intersects(_padshapes):
        _hits['pin-1 dot'] = _hits.get('pin-1 dot', 0) + 1
if _hits:
    print(f'  *** silk within {SILK_PAD_CLR} mm of a pad - a solder defect, '
          f'not a cosmetic one:')
    for src, n in sorted(_hits.items(), key=lambda kv: -kv[1]):
        print(f'        {src}: {n} stroke(s)')
else:
    print(f'  no silk within {SILK_PAD_CLR} mm of any pad')

# board outline
g = G(path('GKO'), 'Profile,NP')
for a, b in edges:
    g.use(g.aperture('C', 0.1)); g.line(a, b)
g.close()

# ---------------------------------------------------------------- drill
holes = {}
for p in pads:
    if p['type'] == 'thru_hole':
        holes.setdefault(round(p['drill'], 3), []).append((p['x'], p['y']))
for v in vias:
    holes.setdefault(round(v[2], 3), []).append((v[0][0], v[0][1]))

with open(path('TXT'), 'w') as f:
    f.write('M48\n')
    f.write(';FORMAT={-:-/ absolute / metric / decimal}\n')
    f.write('; #@! TF.FileFunction,Plated,1,2,PTH\n')
    f.write('; #@! TF.FilePolarity,Positive\n')
    f.write('FMAT,2\nMETRIC,TZ\n')
    for i, d in enumerate(sorted(holes), start=1):
        f.write(f'T{i}C{d:.3f}\n')
    f.write('G90\nG05\n%\n')
    for i, d in enumerate(sorted(holes), start=1):
        f.write(f'T{i}\n')
        for x, y in holes[d]:
            f.write(f'X{x:.3f}Y{y:.3f}\n')
    f.write('T0\nM30\n')
print('drill sizes:', {d: len(v) for d, v in sorted(holes.items())})

# ---------------------------------------------------------------- zip
zp = os.path.join(HERE, 'wifi_floppy_gerbers.zip')
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
    for ext in ('GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GKO', 'TXT'):
        z.write(path(ext), f'{STEM}.{ext}')
    # Hand-written order settings, not generated. Kept beside this script
    # rather than in OUTDIR, because OUTDIR is gitignored - a clean checkout
    # would lose the file and the zip would quietly ship without it.
    notes = os.path.join(HERE, 'README_JLCPCB.txt')
    if not os.path.exists(notes):
        raise SystemExit(f'missing {notes} - the fab order settings')
    z.write(notes, 'README_JLCPCB.txt')
print('wrote', zp)
