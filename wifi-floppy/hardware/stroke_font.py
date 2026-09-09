#!/usr/bin/env python3
"""
A single-stroke vector font, so the Gerber exporter can put text on silkscreen.

Why this exists: export_gerbers.py drew only `fp_line`, so every reference
designator in the board file was silently dropped and the boards came back with
no lettering at all. There is no stroke font in the Python standard library and
KiCad's own (newstroke) is a separate asset, so this is a small hand-built one
covering what a designator and a board label need: A-Z, 0-9 and a few marks.

Glyphs live on a 4 x 6 grid, origin bottom-left, y UP:

      6 +--------+        cap height
        |        |
      3 |        |        (vertical centre)
        |        |
      0 +--------+        baseline
        0        4

Each glyph is a list of polylines. Strokes are centred on the path, so the ink
extends half a line width beyond these coordinates - callers that need a true
bounding box must add `width / 2`.

The zero is slashed. On a board you read designators upside down, in bad light,
next to a part you are about to solder the wrong way round; O and 0 being
distinguishable is worth one extra stroke.
"""
import math

CELL_W, CELL_H = 4.0, 6.0
ADVANCE = 5.0          # cell width plus a 1-unit gap
LINE_GAP = 8.5         # baseline-to-baseline for multi-line text

GLYPHS = {
    ' ': [],
    'A': [[(0, 0), (2, 6), (4, 0)], [(1, 2), (3, 2)]],
    'B': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)],
          [(3, 3), (4, 2), (4, 1), (3, 0), (0, 0)]],
    'C': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1)]],
    'D': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 1), (3, 0), (0, 0)]],
    'E': [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]],
    'F': [[(4, 6), (0, 6), (0, 0)], [(0, 3), (3, 3)]],
    'G': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 3), (2, 3)]],
    'H': [[(0, 0), (0, 6)], [(4, 0), (4, 6)], [(0, 3), (4, 3)]],
    'I': [[(1, 6), (3, 6)], [(2, 6), (2, 0)], [(1, 0), (3, 0)]],
    'J': [[(3, 6), (3, 1), (2, 0), (1, 0), (0, 1)]],
    'K': [[(0, 0), (0, 6)], [(4, 6), (0, 2)], [(1.5, 3.5), (4, 0)]],
    'L': [[(0, 6), (0, 0), (4, 0)]],
    'M': [[(0, 0), (0, 6), (2, 3), (4, 6), (4, 0)]],
    'N': [[(0, 0), (0, 6), (4, 0), (4, 6)]],
    'O': [[(1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0), (0, 1), (0, 5), (1, 6)]],
    'P': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)]],
    'Q': [[(1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0), (0, 1), (0, 5), (1, 6)],
          [(2.5, 1.5), (4, 0)]],
    'R': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(2, 3), (4, 0)]],
    'S': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (3, 3),
           (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    'T': [[(0, 6), (4, 6)], [(2, 6), (2, 0)]],
    'U': [[(0, 6), (0, 1), (1, 0), (3, 0), (4, 1), (4, 6)]],
    'V': [[(0, 6), (2, 0), (4, 6)]],
    'W': [[(0, 6), (1, 0), (2, 3), (3, 0), (4, 6)]],
    'X': [[(0, 0), (4, 6)], [(0, 6), (4, 0)]],
    'Y': [[(0, 6), (2, 3), (4, 6)], [(2, 3), (2, 0)]],
    'Z': [[(0, 6), (4, 6), (0, 0), (4, 0)]],
    '0': [[(1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0), (0, 1), (0, 5), (1, 6)],
          [(0, 1), (4, 5)]],
    '1': [[(1, 5), (2, 6), (2, 0)], [(1, 0), (3, 0)]],
    '2': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (0, 0), (4, 0)]],
    '3': [[(0, 6), (4, 6), (2, 3.5)],
          [(2, 3.5), (4, 2.5), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '4': [[(3, 0), (3, 6), (0, 2), (4, 2)]],
    '5': [[(4, 6), (0, 6), (0, 3.5), (3, 3.5), (4, 2.5), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '6': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0),
           (4, 1), (4, 2), (3, 3), (1, 3), (0, 2)]],
    '7': [[(0, 6), (4, 6), (1.5, 0)]],
    '8': [[(1, 3), (0, 4), (0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3),
           (0, 2), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2), (3, 3)]],
    '9': [[(0, 1), (1, 0), (3, 0), (4, 1), (4, 5), (3, 6), (1, 6), (0, 5),
           (0, 4), (1, 3), (3, 3), (4, 4)]],
    '-': [[(1, 3), (3, 3)]],
    '+': [[(2, 1), (2, 5)], [(0, 3), (4, 3)]],
    '.': [[(2, 0), (2, 0.3)]],
    ',': [[(2.2, 0.4), (1.6, -0.8)]],
    '(': [[(3, 6), (2, 4.5), (2, 1.5), (3, 0)]],
    ')': [[(1, 6), (2, 4.5), (2, 1.5), (1, 0)]],
    '*': [[(2, 5), (2, 1)], [(0.3, 4), (3.7, 2)], [(0.3, 2), (3.7, 4)]],
    '=': [[(0, 4), (4, 4)], [(0, 2), (4, 2)]],
    '#': [[(1, 6), (0.5, 0)], [(3, 6), (2.5, 0)], [(0, 4), (4, 4)], [(0, 2), (4, 2)]],
    '/': [[(0, 0), (4, 6)]],
    ':': [[(2, 1), (2, 1.3)], [(2, 4), (2, 4.3)]],
}

MISSING = '?'
GLYPHS['?'] = [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (2, 3), (2, 2)],
               [(2, 0), (2, 0.3)]]


def unsupported(s):
    """
    Characters this font has no glyph for, in order of appearance.

    They still render - as '?' - which is exactly the problem: a designator
    with a character the font is missing looks deliberate on the board and is
    only noticed when the panel arrives. Callers are expected to print this.
    """
    seen, out = set(), []
    for ch in s:
        c = ch.upper()
        if c not in GLYPHS and c != '\n' and c not in seen:
            seen.add(c); out.append(ch)
    return out


def text_width(s, height):
    """Width in mm of one line, ignoring the trailing inter-character gap."""
    if not s:
        return 0.0
    scale = height / CELL_H
    return (len(s) * ADVANCE - (ADVANCE - CELL_W)) * scale


def text_extents(s, height):
    """(width, height) in mm of possibly-multi-line text."""
    lines = s.split('\n')
    w = max((text_width(l, height) for l in lines), default=0.0)
    scale = height / CELL_H
    h = CELL_H * scale + (len(lines) - 1) * LINE_GAP * scale
    return w, h


def strokes(s, x, y, height, rotation=0.0, y_up=True):
    """
    Segments for `s` centred on (x, y).

    Returns [((x1, y1), (x2, y2)), ...] in mm. `rotation` is in degrees,
    counter-clockwise. `y_up` False mirrors the glyphs vertically, for callers
    still working in KiCad's Y-down space.

    Centred both ways, because that is what KiCad's default text justification
    does and the board file's positions assume it.
    """
    scale = height / CELL_H
    lines = s.split('\n')
    block_h = CELL_H * scale + (len(lines) - 1) * LINE_GAP * scale

    raw = []
    # first baseline so the whole block straddles y = 0
    top = block_h / 2.0
    for li, line in enumerate(lines):
        base = top - CELL_H * scale - li * LINE_GAP * scale
        x0 = -text_width(line, height) / 2.0
        for ch in line:
            g = GLYPHS.get(ch.upper(), GLYPHS[MISSING])
            for poly in g:
                for a, b in zip(poly, poly[1:]):
                    raw.append(((x0 + a[0] * scale, base + a[1] * scale),
                                (x0 + b[0] * scale, base + b[1] * scale)))
            x0 += ADVANCE * scale

    r = math.radians(rotation)
    cos, sin = math.cos(r), math.sin(r)
    out = []
    for a, b in raw:
        pts = []
        for px, py in (a, b):
            if not y_up:
                py = -py
            pts.append((x + px * cos - py * sin, y + px * sin + py * cos))
        out.append((pts[0], pts[1]))
    return out
