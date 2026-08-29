#!/usr/bin/env python3
"""
Render wifi_floppy.kicad_pcb to an SVG board view (top view, X-ray:
F.Cu solid red, B.Cu translucent blue, pads gold, keepout hatched).
Parses the s-expression file rather than re-using the generator's tables,
so what you see is what is actually in the .kicad_pcb.
"""
import re, sys

SRC = '/home/claude/wifi-floppy/hardware/wifi_floppy.kicad_pcb'
OUT = '/home/claude/wifi-floppy/hardware/pcb_render.svg'
txt = open(SRC).read()

# ---------------------------------------------------------------- s-expr
def tokenize(s):
    return re.findall(r'\(|\)|"[^"]*"|[^\s()"]+', s)

def parse(tokens, i=0):
    """returns (node, next_index); node = [atom|list...]"""
    assert tokens[i] == '('
    node, i = [], i + 1
    while tokens[i] != ')':
        if tokens[i] == '(':
            child, i = parse(tokens, i)
            node.append(child)
        else:
            node.append(tokens[i].strip('"'))
            i += 1
    return node, i + 1

root, _ = parse(tokenize(txt))

def kids(node, name):
    return [c for c in node if isinstance(c, list) and c and c[0] == name]

def first(node, name):
    k = kids(node, name)
    return k[0] if k else None

def nums(node, n):
    return [float(v) for v in node[1:1 + n]]

# ---------------------------------------------------------------- collect
segments, vias, pads, edges, texts, zones, silks = [], [], [], [], [], [], []

for seg in kids(root, 'segment'):
    s = nums(first(seg, 'start'), 2); e = nums(first(seg, 'end'), 2)
    w = nums(first(seg, 'width'), 1)[0]
    layer = first(seg, 'layer')[1]
    segments.append((s, e, w, layer))

for v in kids(root, 'via'):
    at = nums(first(v, 'at'), 2)
    size = nums(first(v, 'size'), 1)[0]
    drill = nums(first(v, 'drill'), 1)[0]
    vias.append((at, size, drill))

for gl in kids(root, 'gr_line'):
    if first(gl, 'layer')[1] == 'Edge.Cuts':
        edges.append((nums(first(gl, 'start'), 2), nums(first(gl, 'end'), 2)))

for fp in kids(root, 'footprint'):
    fat = first(fp, 'at'); ox, oy = nums(fat, 2)
    ref = ''
    for t in kids(fp, 'fp_text'):
        if t[1] == 'reference':
            ref = t[2]
    for fl in kids(fp, 'fp_line'):
        ly = first(fl, 'layer')
        if ly and ly[1] == 'F.SilkS':
            a = nums(first(fl, 'start'), 2); b = nums(first(fl, 'end'), 2)
            silks.append(((ox + a[0], oy + a[1]), (ox + b[0], oy + b[1])))
    for pad in kids(fp, 'pad'):
        num = pad[1]; ptype = pad[2]; shape = pad[3]
        at = nums(first(pad, 'at'), 2)
        size = nums(first(pad, 'size'), 2)
        drill = first(pad, 'drill')
        d = float(drill[1]) if drill else 0.0
        net = first(pad, 'net')
        netname = net[2] if net and len(net) > 2 else ''
        pads.append((ox + at[0], oy + at[1], size, shape, ptype, d, netname, ref, num))
    texts.append((ox, oy, ref))

for z in kids(root, 'zone'):
    poly = first(z, 'polygon')
    pts = first(poly, 'pts')
    xy = [nums(p, 2) for p in kids(pts, 'xy')]
    is_keepout = first(z, 'keepout') is not None
    zones.append((xy, is_keepout))

# ---------------------------------------------------------------- svg
minx = min(min(a[0], b[0]) for a, b in edges)
maxx = max(max(a[0], b[0]) for a, b in edges)
miny = min(min(a[1], b[1]) for a, b in edges)
maxy = max(max(a[1], b[1]) for a, b in edges)
M = 9.0
W, H = (maxx - minx) + 2 * M, (maxy - miny) + 2 * M
SC = 10   # px per mm

o = []
o.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W*SC:.0f}" height="{H*SC:.0f}" '
         f'viewBox="{minx-M:.2f} {miny-M:.2f} {W:.2f} {H:.2f}">')
o.append('<style>'
         '.fcu{stroke:#d94f3d;stroke-linecap:round;stroke-linejoin:round;fill:none}'
         '.bcu{stroke:#3b7dd8;stroke-linecap:round;stroke-linejoin:round;fill:none;opacity:.75}'
         '.edge{stroke:#e8e264;stroke-width:.25;fill:none}'
         '.pad{fill:#c9a227}.padh{fill:#1b1b1b}'
         '.via{fill:#7d8a99}.viah{fill:#1b1b1b}'
         '.lbl{font:1.6px sans-serif;fill:#e6e6e6;text-anchor:middle}'
         '.tiny{font:1.0px sans-serif;fill:#9fb0c0;text-anchor:middle}'
         '.ko{fill:url(#hatch);stroke:#d46bd4;stroke-width:.25}'
         '.gnd{fill:#1e4d2b;opacity:.30}'
         '</style>')
o.append('<defs><pattern id="hatch" width="1.2" height="1.2" '
         'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
         '<rect width="1.2" height="1.2" fill="#3a1636"/>'
         '<line x1="0" y1="0" x2="0" y2="1.2" stroke="#d46bd4" stroke-width="0.3"/>'
         '</pattern></defs>')
o.append(f'<rect x="{minx-M}" y="{miny-M}" width="{W}" height="{H}" fill="#15181c"/>')

# zones (GND pour outline then keepout)
for xy, ko in zones:
    d = ' '.join(f'{x},{y}' for x, y in xy)
    o.append(f'<polygon points="{d}" class="{"ko" if ko else "gnd"}"/>')

# tracks: back first, then front
for layer, cls in (('B.Cu', 'bcu'), ('F.Cu', 'fcu')):
    o.append(f'<g class="{cls}">')
    for s, e, w, ly in segments:
        if ly != layer: continue
        o.append(f'<line x1="{s[0]}" y1="{s[1]}" x2="{e[0]}" y2="{e[1]}" stroke-width="{w}"/>')
    o.append('</g>')

# pads
for x, y, size, shape, ptype, drill, netname, ref, num in pads:
    if ptype == 'thru_hole':
        if shape == 'rect':
            o.append(f'<rect x="{x-size[0]/2}" y="{y-size[1]/2}" width="{size[0]}" '
                     f'height="{size[1]}" class="pad"/>')
        else:
            o.append(f'<circle cx="{x}" cy="{y}" r="{size[0]/2}" class="pad"/>')
        o.append(f'<circle cx="{x}" cy="{y}" r="{drill/2}" class="padh"/>')
    else:
        o.append(f'<rect x="{x-size[0]/2}" y="{y-size[1]/2}" width="{size[0]}" '
                 f'height="{size[1]}" rx="0.12" class="pad"/>')

# vias
for at, size, drill in vias:
    o.append(f'<circle cx="{at[0]}" cy="{at[1]}" r="{size/2}" class="via"/>')
    o.append(f'<circle cx="{at[0]}" cy="{at[1]}" r="{drill/2}" class="viah"/>')

# silkscreen
o.append('<g stroke="#dcdcdc" stroke-width="0.13" fill="none" opacity="0.85">')
for a, b in silks:
    o.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}"/>')
o.append('</g>')

# board outline
for a, b in edges:
    o.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" class="edge"/>')

# reference designators
REFPOS = {}
for x, y, size, shape, ptype, drill, netname, ref, num in pads:
    REFPOS.setdefault(ref, []).append((x, y))
for ref, pts in REFPOS.items():
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    dy = -1.9 if ref in ('Q1','Q2','Q3','Q4','Q5','Q6','C1','C3','D1') else 0.5
    o.append(f'<text x="{cx}" y="{cy+dy}" class="lbl">{ref}</text>')

# keepout caption
for xy, ko in zones:
    if not ko: continue
    cx = sum(p[0] for p in xy) / len(xy); top = min(p[1] for p in xy)
    o.append(f'<text x="{cx}" y="{top-2.4}" class="lbl" style="font-size:1.5px;fill:#f0b6f0">'
             f'ANTENNA KEEPOUT</text>')
    o.append(f'<text x="{cx}" y="{top-1.0}" class="tiny" style="fill:#c89ac8">'
             f'no copper either layer - GP14..GP17 left unused</text>')

# annotations
o.append(f'<text x="{minx}" y="{miny-4.0}" class="lbl" '
         f'style="font-size:2.4px;text-anchor:start">WiFi Floppy Emulator - rev A - top view</text>')
o.append(f'<text x="{maxx}" y="{miny-4.0}" class="tiny" '
         f'style="font-size:1.6px;text-anchor:end">F.Cu red / B.Cu blue / keepout magenta / '
         f'{len(segments)} segs, {len(vias)} vias, {len(silks)} silk</text>')
# pin-1 markers
for x, y, size, shape, ptype, drill, netname, ref, num in pads:
    if num == '1' and ref in ('J1', 'J2', 'U1', 'U2'):
        o.append(f'<circle cx="{x}" cy="{y}" r="{size[0]/2+0.55}" fill="none" '
                 f'stroke="#ffffff" stroke-width="0.18"/>')
o.append('</svg>')

open(OUT, 'w').write('\n'.join(o))
print(f'wrote {OUT}: {len(segments)} segments, {len(vias)} vias, {len(pads)} pads, '
      f'{len(zones)} zones, {len(edges)} edges')
