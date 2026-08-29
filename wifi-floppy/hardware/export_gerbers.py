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

SRC = '/home/claude/wifi-floppy/hardware/wifi_floppy.kicad_pcb'
OUTDIR = '/home/claude/wifi-floppy/hardware/gerbers'
STEM = 'wifi_floppy'

# --- fab rules -------------------------------------------------------------
POUR_CLEARANCE = 0.30      # copper-to-pour
EDGE_CLEARANCE = 0.30      # pour pullback from board edge
MASK_EXPANSION = 0.05      # matches (pad_to_mask_clearance 0.05) in the pcb
THERMAL_SPOKE_W = 0.45     # spoke width on GND through-hole pads
VIA_TENTED = True          # JLC default: vias covered by mask

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
segments, vias, pads, edges, silks = [], [], [], [], []

for s in kids(root, 'segment'):
    segments.append((nums(first(s, 'start'), 2), nums(first(s, 'end'), 2),
                     nums(first(s, 'width'), 1)[0], first(s, 'layer')[1],
                     first(s, 'net')[1]))
for v in kids(root, 'via'):
    vias.append((nums(first(v, 'at'), 2), nums(first(v, 'size'), 1)[0],
                 nums(first(v, 'drill'), 1)[0], first(v, 'net')[1]))
for gl in kids(root, 'gr_line'):
    if first(gl, 'layer')[1] == 'Edge.Cuts':
        edges.append((nums(first(gl, 'start'), 2), nums(first(gl, 'end'), 2)))
for fp in kids(root, 'footprint'):
    ox, oy = nums(first(fp, 'at'), 2)
    ref = next((t[2] for t in kids(fp, 'fp_text') if t[1] == 'reference'), '')
    for fl in kids(fp, 'fp_line'):
        ly = first(fl, 'layer')
        if ly and ly[1] == 'F.SilkS':
            a = nums(first(fl, 'start'), 2); b = nums(first(fl, 'end'), 2)
            silks.append(((ox + a[0], oy + a[1]), (ox + b[0], oy + b[1]),
                          nums(first(first(fl, 'stroke'), 'width'), 1)[0]))
    for pad in kids(fp, 'pad'):
        at = nums(first(pad, 'at'), 2); size = nums(first(pad, 'size'), 2)
        dr = first(pad, 'drill'); net = first(pad, 'net')
        pads.append(dict(num=pad[1], type=pad[2], shape=pad[3],
                         x=ox + at[0], y=oy + at[1], w=size[0], h=size[1],
                         drill=float(dr[1]) if dr else 0.0,
                         net=(net[2] if net and len(net) > 2 else ''), ref=ref))

keepouts = []
for z in kids(root, 'zone'):
    ko = first(z, 'keepout')
    if not ko: continue
    cp = first(ko, 'copperpour')
    if cp and cp[1] == 'not_allowed':
        pts = first(first(z, 'polygon'), 'pts')
        keepouts.append([nums(p, 2) for p in kids(pts, 'xy')])
print(f'keepout zones: {len(keepouts)}')

xs = [p for e in edges for p in (e[0][0], e[1][0])]
ys = [p for e in edges for p in (e[0][1], e[1][1])]
BX1, BX2, BY1, BY2 = min(xs), max(xs), min(ys), max(ys)
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

# silkscreen (outlines only - no stroke-font text in this export)
g = G(path('GTO'), 'Legend,Top')
for a, b, w in silks:
    g.use(g.aperture('C', w)); g.line(a, b)
g.close()

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
zp = '/home/claude/wifi-floppy/hardware/wifi_floppy_gerbers.zip'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
    for ext in ('GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GKO', 'TXT'):
        z.write(path(ext), f'{STEM}.{ext}')
print('wrote', zp)
