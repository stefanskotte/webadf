#!/usr/bin/env python3
"""
Render wifi_floppy.kicad_pcb to an SVG board view (top view, X-ray:
F.Cu solid red, B.Cu translucent blue, pads gold, keepout hatched).
Parses the s-expression file rather than re-using the generator's tables,
so what you see is what is actually in the .kicad_pcb.
"""
import re, sys, os, math
import stroke_font

# Paths resolve against THIS FILE, not the working directory. These were
# absolute /home/claude/... paths from wherever the script was first written,
# so none of them could run on another machine -- which is why the board could
# not be regenerated here until 2026-09-04.
HERE = os.path.dirname(os.path.abspath(__file__))

SRC = os.path.join(HERE, 'wifi_floppy.kicad_pcb')
OUT = os.path.join(HERE, 'pcb_render.svg')
OUT_PNG = os.path.join(HERE, 'pcb_render.png')
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
silk_dots = []      # (x, y, diameter) filled circles
silk_text = []      # (string, x, y, height, thickness, rotation)

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
            silks.append(((ox + a[0], oy + a[1]), (ox + b[0], oy + b[1]),
                          nums(first(first(fl, 'stroke'), 'width'), 1)[0]))
    for fc in kids(fp, 'fp_circle'):
        ly = first(fc, 'layer')
        if ly and ly[1] == 'F.SilkS':
            c = nums(first(fc, 'center'), 2); e = nums(first(fc, 'end'), 2)
            r = math.hypot(e[0] - c[0], e[1] - c[1])
            w = nums(first(first(fc, 'stroke'), 'width'), 1)[0]
            silk_dots.append((ox + c[0], oy + c[1], 2 * r + w))
    # The designators are real silkscreen now, at the position the board file
    # gives them. This used to draw a sans-serif label at the pad centroid
    # instead - a picture of a board that did not exist.
    for t in kids(fp, 'fp_text'):
        ly = first(t, 'layer')
        if t[1] != 'reference' or not (ly and ly[1] == 'F.SilkS'):
            continue
        at = first(t, 'at'); a = nums(at, 2)
        rot = float(at[3]) if len(at) > 3 else 0.0
        font = first(first(t, 'effects'), 'font')
        silk_text.append((t[2], ox + a[0], oy + a[1],
                          nums(first(font, 'size'), 2)[1],
                          nums(first(font, 'thickness'), 1)[0], rot))
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

for t in kids(root, 'gr_text'):
    ly = first(t, 'layer')
    if ly and ly[1] == 'F.SilkS':
        at = first(t, 'at'); a = nums(at, 2)
        rot = float(at[3]) if len(at) > 3 else 0.0
        font = first(first(t, 'effects'), 'font')
        silk_text.append((t[1].replace('\\n', '\n'), a[0], a[1],
                          nums(first(font, 'size'), 2)[1],
                          nums(first(font, 'thickness'), 1)[0], rot))

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

# silkscreen - outlines, stroke-font text and the pin-1 dot, at their real
# widths, so the picture and the .GTO show the same ink.
legend = list(silks)
for txt, tx, ty, h, th, rot in silk_text:
    for a, b in stroke_font.strokes(txt, tx, ty, h, rotation=rot, y_up=False):
        legend.append((a, b, th))
o.append('<g stroke="#dcdcdc" fill="none" stroke-linecap="round" opacity="0.9">')
for a, b, w in legend:
    o.append(f'<line x1="{a[0]:.3f}" y1="{a[1]:.3f}" x2="{b[0]:.3f}" y2="{b[1]:.3f}" '
             f'stroke-width="{w}"/>')
o.append('</g>')
for x, y, d in silk_dots:
    o.append(f'<circle cx="{x}" cy="{y}" r="{d/2:.3f}" fill="#dcdcdc" opacity="0.9"/>')

# board outline
for a, b in edges:
    o.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" class="edge"/>')

# Designators and the keepout caption used to be drawn here as SVG text at
# the pad centroid. They are on the board itself now, so drawing them again
# would show ink twice - and at positions the board does not use.

# Commentary about the picture, as opposed to ink on the board, lives in the
# margins - one line above, two below. Putting the title and the statistics on
# the same line overlapped them once the title was set in the stroke font,
# which is far wider than the sans-serif this used to measure against.
CAP_TITLE = 'WiFi Floppy Emulator - rev B - top view'
CAP_STATS = (f'F.Cu red / B.Cu blue / keepout magenta / {len(segments)} segs, '
             f'{len(vias)} vias, {len(legend)} silk strokes')
CAP_NOTE = 'antenna keepout: no copper either layer - GP14..GP17 left unused'
o.append(f'<text x="{minx}" y="{miny-3.4}" class="lbl" '
         f'style="font-size:2.4px;text-anchor:start">{CAP_TITLE}</text>')
o.append(f'<text x="{minx}" y="{maxy+4.0}" class="tiny" '
         f'style="font-size:1.5px;text-anchor:start">{CAP_STATS}</text>')
o.append(f'<text x="{minx}" y="{maxy+6.4}" class="tiny" '
         f'style="font-size:1.5px;text-anchor:start;fill:#c89ac8">{CAP_NOTE}</text>')
# pin-1 markers
for x, y, size, shape, ptype, drill, netname, ref, num in pads:
    if num == '1' and ref in ('J1', 'J2', 'U1', 'U2'):
        o.append(f'<circle cx="{x}" cy="{y}" r="{size[0]/2+0.55}" fill="none" '
                 f'stroke="#ffffff" stroke-width="0.18"/>')
_missing = {c for t, *_ in silk_text for c in stroke_font.unsupported(t)}
if _missing:
    print(f'  *** stroke font has no glyph for {sorted(_missing)} - they print as "?" ***')
o.append('</svg>')

open(OUT, 'w').write('\n'.join(o))
print(f'wrote {OUT}: {len(segments)} segments, {len(vias)} vias, {len(pads)} pads, '
      f'{len(zones)} zones, {len(edges)} edges')

# ---------------------------------------------------------------- png
# Pillow, not a converter: rsvg/cairosvg/inkscape are not on this machine and
# ImageMagick's built-in SVG renderer mangles the hatch pattern. Drawing the
# same primitives a second time is duplication, but it is 40 lines and it
# cannot silently disagree with the SVG about geometry - both read the same
# lists above.
try:
    from PIL import Image, ImageDraw
except ImportError:
    print('Pillow not installed - skipped pcb_render.png '
          '(pip install pillow, or run under a python that has it)')
else:
    SS = 3                       # supersample, then downscale: Pillow lines alias
    PX = 12 * SS                 # px per mm in the supersampled image
    def T(x, y):
        return ((x - (minx - M)) * PX, (y - (miny - M)) * PX)
    def wpx(w):
        return max(1, int(round(w * PX)))
    img = Image.new('RGB', (int(W * PX), int(H * PX)), '#15181c')
    d = ImageDraw.Draw(img, 'RGBA')

    for xy, ko in zones:
        pts = [T(x, y) for x, y in xy]
        d.polygon(pts, fill=(212, 107, 212, 60) if ko else (30, 77, 43, 77),
                  outline='#d46bd4' if ko else None, width=wpx(0.25))
    for layer, col in (('B.Cu', (59, 125, 216, 190)), ('F.Cu', (217, 79, 61, 255))):
        for a, b, w, ly in segments:
            if ly != layer: continue
            d.line([T(*a), T(*b)], fill=col, width=wpx(w), joint='curve')
    for x, y, size, shape, ptype, drill, netname, ref, num in pads:
        if shape == 'rect':
            d.rectangle([T(x - size[0]/2, y - size[1]/2), T(x + size[0]/2, y + size[1]/2)],
                        fill='#c9a227')
        else:
            d.ellipse([T(x - size[0]/2, y - size[0]/2), T(x + size[0]/2, y + size[0]/2)],
                      fill='#c9a227')
        if drill:
            d.ellipse([T(x - drill/2, y - drill/2), T(x + drill/2, y + drill/2)], fill='#1b1b1b')
    for at, size, drill in vias:
        d.ellipse([T(at[0]-size/2, at[1]-size/2), T(at[0]+size/2, at[1]+size/2)], fill='#7d8a99')
        d.ellipse([T(at[0]-drill/2, at[1]-drill/2), T(at[0]+drill/2, at[1]+drill/2)], fill='#1b1b1b')
    for a, b, w in legend:
        d.line([T(*a), T(*b)], fill=(220, 220, 220, 235), width=wpx(w), joint='curve')
    for x, y, dia in silk_dots:
        d.ellipse([T(x-dia/2, y-dia/2), T(x+dia/2, y+dia/2)], fill=(220, 220, 220, 235))
    for a, b in edges:
        d.line([T(*a), T(*b)], fill='#e8e264', width=wpx(0.25))

    # the SVG's caption overlay, drawn with the same stroke font so the two
    # outputs say the same things
    def caption(txt, x, y, h, col, anchor='start'):
        w = stroke_font.text_width(txt, h)
        cx = x + w / 2 if anchor == 'start' else x - w / 2
        for a, b in stroke_font.strokes(txt, cx, y, h, y_up=False):
            d.line([T(*a), T(*b)], fill=col, width=wpx(h * 0.14), joint='curve')
    caption(CAP_TITLE.upper(), minx, miny - 3.4, 2.4, '#e6e6e6')
    caption(CAP_STATS.upper(), minx, maxy + 4.0, 1.5, '#9fb0c0')
    caption(CAP_NOTE.upper(), minx, maxy + 6.4, 1.5, '#c89ac8')

    img = img.resize((int(W * PX / SS), int(H * PX / SS)), Image.LANCZOS)
    img.save(OUT_PNG)
    print(f'wrote {OUT_PNG}: {img.width}x{img.height} px')
