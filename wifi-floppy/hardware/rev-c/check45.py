#!/usr/bin/env python3
"""check45.py <board.kicad_pcb> [--kink MM] [--list N] [--json]

The rev C routing rule (operator 2026-11-15): every trace runs at a multiple of 45 deg, and each bend turns
by exactly 45 or 90 deg -- no sharp corners, and no turn built from several small kinks.

Checks, over every (segment ...) of the board (arcs are reported too: the rule allows none):
  ANGLE   a segment whose direction is not a multiple of 45 deg (tolerance ANGLE_TOL).
  SHARP   a joint (exactly two segments of one net on one layer meeting at a point with no via) that turns
          by more than 90 deg -- 135 deg (an acute corner) or 180 deg (a reversal).
  KINK    a short segment (< --kink mm, default 0.25) between two bends, unless it is the single chamfer of a
          mitred 90 deg corner (two 45 deg bends turning the same way, neighbours not short themselves).
  ODD     a joint that turns by some angle other than 0/45/90/135/180 (follows from ANGLE, listed apart).
  ARC     an (arc ...) track.
Collinear joints (0 deg, a straight line split in two) are counted as info only.
Exit status 0 when nothing is flagged, 1 otherwise.
"""
import json, math, re, sys
from collections import defaultdict

ANGLE_TOL = 0.05     # deg
POINT_TOL = 0.0005   # mm: endpoints closer than this are one point

def load(path):
    txt = open(path).read()
    segs, vias, arcs = [], set(), []
    for m in re.finditer(r'\(segment\s+\(start ([-\d.]+) ([-\d.]+)\)\s+\(end ([-\d.]+) ([-\d.]+)\)\s+'
                         r'\(width ([\d.]+)\)\s+\(layer "([^"]+)"\)\s+\(net "([^"]*)"\)', txt):
        x1, y1, x2, y2, w = map(float, m.group(1, 2, 3, 4, 5))
        segs.append(dict(a=(x1, y1), b=(x2, y2), w=w, layer=m.group(6), net=m.group(7)))
    for m in re.finditer(r'\(via\s+\(at ([-\d.]+) ([-\d.]+)\)', txt):
        vias.add(key((float(m.group(1)), float(m.group(2)))))
    for m in re.finditer(r'\(arc\s+\(start ([-\d.]+) ([-\d.]+)\).*?\(layer "([^"]+)"\)\s+\(net "([^"]*)"\)', txt, re.S):
        arcs.append(dict(a=(float(m.group(1)), float(m.group(2))), layer=m.group(3), net=m.group(4)))
    return segs, vias, arcs

def key(p):
    return (round(p[0] / POINT_TOL), round(p[1] / POINT_TOL))

def direction(p, q):
    return math.degrees(math.atan2(q[1] - p[1], q[0] - p[0]))

def length(s):
    return math.dist(s['a'], s['b'])

def off45(deg):
    r = deg % 45.0
    return min(r, 45.0 - r)

def main():
    args = sys.argv[1:]
    if not args or args[0].startswith('-'):
        sys.exit(__doc__)
    path = args[0]
    kink = float(args[args.index('--kink') + 1]) if '--kink' in args else 0.25
    nlist = int(args[args.index('--list') + 1]) if '--list' in args else 30
    segs, vias, arcs = load(path)
    flags = []

    for i, s in enumerate(segs):
        if length(s) < 1e-6:
            flags.append(dict(kind='ZERO', net=s['net'], layer=s['layer'], at=s['a'], detail='zero-length segment'))
            continue
        d = direction(s['a'], s['b'])
        if off45(d) > ANGLE_TOL:
            flags.append(dict(kind='ANGLE', net=s['net'], layer=s['layer'], at=s['a'],
                              detail=f'{d % 180:.2f} deg, {off45(d):.2f} off, {length(s):.3f} mm'))
    for a in arcs:
        flags.append(dict(kind='ARC', net=a['net'], layer=a['layer'], at=a['a'], detail='arc track'))

    # Joints: endpoints shared by exactly two segments of one net on one layer, not at a via.
    ends = defaultdict(list)   # (layer, net, point) -> [(seg index, which end)]
    for i, s in enumerate(segs):
        if length(s) < 1e-6:
            continue
        ends[(s['layer'], s['net'], key(s['a']))].append((i, 'a'))
        ends[(s['layer'], s['net'], key(s['b']))].append((i, 'b'))
    turn_at = {}   # (seg index, end) -> (turn deg, signed)
    collinear = 0
    for (layer, net, k), lst in ends.items():
        if len(lst) != 2 or k in vias:
            continue
        (i, ei), (j, ej) = lst
        si, sj = segs[i], segs[j]
        p = si[ei]
        far_i = si['b' if ei == 'a' else 'a']
        far_j = sj['b' if ej == 'a' else 'a']
        d_in = direction(far_i, p)
        d_out = direction(p, far_j)
        t = (d_out - d_in + 180.0) % 360.0 - 180.0   # signed turn, -180..180
        a = abs(t)
        turn_at[(i, ei)] = (a, t)
        turn_at[(j, ej)] = (a, t)
        if a < ANGLE_TOL:
            collinear += 1
        elif abs(a - 45) <= ANGLE_TOL or abs(a - 90) <= ANGLE_TOL:
            pass
        elif abs(a - 135) <= ANGLE_TOL or a >= 180 - ANGLE_TOL:
            flags.append(dict(kind='SHARP', net=net, layer=layer, at=p, detail=f'turns {a:.1f} deg'))
        else:
            flags.append(dict(kind='ODD', net=net, layer=layer, at=p, detail=f'turns {a:.2f} deg'))

    def is_bend(i, e):
        t = turn_at.get((i, e))
        return t is not None and t[0] > ANGLE_TOL

    def short_bent(i):
        return length(segs[i]) < kink and is_bend(i, 'a') and is_bend(i, 'b')

    # Neighbours through joints, for "the chamfer's neighbours are not short themselves".
    nb = defaultdict(list)
    for lst in ends.values():
        if len(lst) == 2:
            (i, _), (j, _) = lst
            nb[i].append(j); nb[j].append(i)
    for i, s in enumerate(segs):
        if length(s) < 1e-6 or not short_bent(i):
            continue
        ta, tb = turn_at[(i, 'a')], turn_at[(i, 'b')]
        mitre = (abs(ta[0] - 45) <= ANGLE_TOL and abs(tb[0] - 45) <= ANGLE_TOL and (ta[1] > 0) == (tb[1] > 0)
                 and not any(short_bent(j) for j in nb[i]))
        if not mitre:
            flags.append(dict(kind='KINK', net=s['net'], layer=s['layer'], at=s['a'],
                              detail=f'{length(s):.3f} mm between bends of {ta[0]:.0f} and {tb[0]:.0f} deg'))

    counts = defaultdict(int)
    for f in flags:
        counts[f['kind']] += 1
    if '--json' in args:
        print(json.dumps(dict(segments=len(segs), arcs=len(arcs), joints=len(turn_at) // 2, collinear=collinear,
                              counts=counts, flags=flags), indent=1))
    else:
        print(f'{path}: {len(segs)} segments, {len(arcs)} arcs, {len(turn_at) // 2} joints ({collinear} collinear)')
        if not flags:
            print('PASS: every segment at a multiple of 45 deg, every bend 45 or 90 deg, no kinks')
        else:
            print('FAIL: ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
            for f in flags[:nlist]:
                print(f"  {f['kind']:5} {f['layer']:5} {f['net']:20} ({f['at'][0]:.4f}, {f['at'][1]:.4f})  {f['detail']}")
            if len(flags) > nlist:
                print(f'  ... {len(flags) - nlist} more (--list N)')
    sys.exit(1 if flags else 0)

if __name__ == '__main__':
    main()
