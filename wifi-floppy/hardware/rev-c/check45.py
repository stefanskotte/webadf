#!/usr/bin/env python3
"""check45.py <board.kicad_pcb> [--kink MM] [--list N] [--json] [--no-exempt] [--exceptions FILE]

The rev C routing rule (operator 2026-11-15): every trace runs at a multiple of 45 deg, and each bend turns
by exactly 45 or 90 deg -- no sharp corners, and no turn built from several small kinks.

Checks, over every (segment ...) of the board (arcs are reported too: the rule allows none):
  ANGLE   a segment whose direction is not a multiple of 45 deg (tolerance ANGLE_TOL).
  SHARP   a joint (exactly two segments of one net on one layer meeting at a point with no via) that turns
          by more than 90 deg -- 135 deg (an acute corner) or 180 deg (a reversal).
  KINK    a short leg (< --kink mm, default 0.25) between two bends, unless it is the single chamfer of a
          mitred 90 deg corner (two 45 deg bends turning the same way, neighbours not short themselves).
          A leg is a straight run: segments joined in line at plain joints are measured together.
  ODD     a joint that turns by some angle other than 0/45/90/135/180 (follows from ANGLE, listed apart).
  ARC     an (arc ...) track.
Collinear joints (0 deg, a straight line split in two) are counted as info only.

Not counted, but listed every run (--no-exempt counts them like the rest):
  - the core regulator's own tracks. A top-layer segment of one of the regulator's nets with both ends inside
    reg_pattern.py's CLEAR_TOP is Raspberry Pi's pattern (reg_pattern.TRACKS), which this board copies and verify_reg.py
    guards; those tracks lie inside the pattern's zones, which are the copper there.
  - the flags named in check45-exceptions.json beside the board (or --exceptions FILE): one entry per flag, by kind, net,
    layer and place, each with its reason. An entry that matches nothing is reported as stale.
Exit status 0 when nothing else is flagged, 1 otherwise.
Exit status 0 when nothing is flagged, 1 otherwise.
"""
import json, math, os, re, sys
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reg_pattern as RP

REG_NETS = {RP.DV, RP.AV, RP.LXN, '+3.3V', 'GND'}
REG_TOP = [RP.abs_(p) for p in RP.CLEAR_TOP]

def inside(p, poly):
    c = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i - 1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
            c = not c
    return c

def regulator(s):
    return s['layer'] == 'F.Cu' and s['net'] in REG_NETS and inside(s['a'], REG_TOP) and inside(s['b'], REG_TOP)

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
    exempt_on = '--no-exempt' not in args
    reg = [exempt_on and regulator(s) for s in segs]
    def flag(idx, **f):
        f['exempt'] = all(reg[i] for i in idx)
        flags.append(f)

    for i, s in enumerate(segs):
        if length(s) < 1e-6:
            flag([i], kind='ZERO', net=s['net'], layer=s['layer'], at=s['a'], detail='zero-length segment')
            continue
        d = direction(s['a'], s['b'])
        if off45(d) > ANGLE_TOL:
            flag([i], kind='ANGLE', net=s['net'], layer=s['layer'], at=s['a'],
                 detail=f'{d % 180:.2f} deg, {off45(d):.2f} off, {length(s):.3f} mm')
    for a in arcs:
        flag([], kind='ARC', net=a['net'], layer=a['layer'], at=a['a'], detail='arc track')
        flags[-1]['exempt'] = False

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
        # Signed as seen walking each segment from its a to its b, so the two ends of one segment compare:
        # t is for the walk i -> j; it flips for a segment walked against its own a -> b.
        turn_at[(i, ei)] = (a, t if ei == 'b' else -t)
        turn_at[(j, ej)] = (a, t if ej == 'a' else -t)
        if a < ANGLE_TOL:
            collinear += 1
        elif abs(a - 45) <= ANGLE_TOL or abs(a - 90) <= ANGLE_TOL:
            pass
        elif abs(a - 135) <= ANGLE_TOL or a >= 180 - ANGLE_TOL:
            flag([i, j], kind='SHARP', net=net, layer=layer, at=p, detail=f'turns {a:.1f} deg')
        else:
            flag([i, j], kind='ODD', net=net, layer=layer, at=p, detail=f'turns {a:.2f} deg')

    # A straight run: segments joined end to end at collinear joints count as one leg, so a short leg cut in two
    # (the router does it where it changes width) is still seen as short.
    joint_of = {}   # (seg index, end) -> (other seg index, its end), for joints of exactly two
    for (layer, net, k), lst in ends.items():
        if len(lst) == 2 and k not in vias:
            joint_of[lst[0]] = lst[1]; joint_of[lst[1]] = lst[0]

    def other(e):
        return 'b' if e == 'a' else 'a'

    def walk(i, e):
        """From segment i out through its end e along collinear joints: the run's last (segment, end) that way."""
        seen = {i}
        while (i, e) in turn_at and turn_at[(i, e)][0] <= ANGLE_TOL:
            j, ej = joint_of[(i, e)]
            if j in seen:
                break
            seen.add(j)
            i, e = j, other(ej)
        return i, e, seen

    def run_of(i):
        ia, ea, sa = walk(i, 'a')
        ib, eb, sb = walk(i, 'b')
        members = sa | sb
        return (ia, ea), (ib, eb), members

    def bend(i, e, outward_is_b):
        """(turn, signed turn as seen walking the run towards its b end) at an outer end, or None."""
        t = turn_at.get((i, e))
        if t is None or t[0] <= ANGLE_TOL:
            return None
        own_dir_is_run_dir = (e == 'b') == outward_is_b     # is this segment's a->b the way the run is walked?
        return t[0], (t[1] if own_dir_is_run_dir else -t[1])

    runs = {}       # lowest member index -> dict
    for i, s in enumerate(segs):
        if length(s) < 1e-6:
            continue
        enda, endb, members = run_of(i)
        key_ = min(members)
        if key_ in runs:
            continue
        runs[key_] = dict(members=members, total=sum(length(segs[m]) for m in members),
                          ta=bend(enda[0], enda[1], False), tb=bend(endb[0], endb[1], True), enda=enda, endb=endb)
    run_id = {m: k_ for k_, r in runs.items() for m in r['members']}

    def short_bent(r):
        return r['total'] < kink and r['ta'] is not None and r['tb'] is not None

    def neighbours(r):
        out = []
        for end in (r['enda'], r['endb']):
            j = joint_of.get(end)
            if j is not None:
                out.append(runs[run_id[j[0]]])
        return out

    for key_, r in sorted(runs.items()):
        if not short_bent(r):
            continue
        ta, tb = r['ta'], r['tb']
        mitre = (abs(ta[0] - 45) <= ANGLE_TOL and abs(tb[0] - 45) <= ANGLE_TOL and (ta[1] > 0) == (tb[1] > 0)
                 and not any(short_bent(n) for n in neighbours(r)))
        if not mitre:
            s = segs[key_]
            flag(sorted(r['members']), kind='KINK', net=s['net'], layer=s['layer'], at=s['a'],
                 detail=f"{r['total']:.3f} mm between bends of {ta[0]:.0f} and {tb[0]:.0f} deg"
                        + (f" ({len(r['members'])} segments in line)" if len(r['members']) > 1 else ''))

    exempt = [f for f in flags if f['exempt']]
    flags = [f for f in flags if not f['exempt']]
    # Accepted exceptions, each with its reason, from a file beside the board.
    xpath = args[args.index('--exceptions') + 1] if '--exceptions' in args else os.path.join(os.path.dirname(os.path.abspath(path)), 'check45-exceptions.json')
    wanted = json.load(open(xpath)) if exempt_on and os.path.exists(xpath) else []
    accepted, stale = [], []
    for x in wanted:
        hit = [f for f in flags if f['kind'] == x['kind'] and f['net'] == x['net'] and f['layer'] == x['layer']
               and math.dist(f['at'], x['at']) < 0.01]
        if hit:
            hit[0]['why'] = x['why']; accepted.append(hit[0]); flags.remove(hit[0])
        else:
            stale.append(x)
    counts = defaultdict(int)
    for f in flags:
        counts[f['kind']] += 1
    if '--json' in args:
        print(json.dumps(dict(segments=len(segs), arcs=len(arcs), joints=len(turn_at) // 2, collinear=collinear,
                              counts=counts, flags=flags, exempt=exempt, accepted=accepted, stale=stale), indent=1))
    else:
        print(f'{path}: {len(segs)} segments, {len(arcs)} arcs, {len(turn_at) // 2} joints ({collinear} collinear)')
        def show(f):
            print(f"  {f['kind']:5} {f['layer']:5} {f['net']:20} ({f['at'][0]:.4f}, {f['at'][1]:.4f})  {f['detail']}")
        if not flags:
            print('PASS: every segment at a multiple of 45 deg, every bend 45 or 90 deg, no kinks'
                  + (f', but for {len(accepted)} accepted and {len(exempt)} regulator flags below' if accepted or exempt else ''))
        else:
            print('FAIL: ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
            for f in flags[:nlist]:
                show(f)
            if len(flags) > nlist:
                print(f'  ... {len(flags) - nlist} more (--list N)')
        if accepted:
            print(f'accepted exceptions ({os.path.basename(xpath)}): {len(accepted)}')
            for f in accepted:
                show(f)
                print('        ' + f['why'])
        for x in stale:
            print(f"stale exception, nothing flagged there now: {x['kind']} {x['net']} {x['layer']} {x['at']}")
        if exempt:
            print(f'exempt, the core regulator\'s own tracks (reg_pattern.py, not to be changed): {len(exempt)} on '
                  f'{len(set(f["net"] for f in exempt))} nets')
            for f in exempt[:nlist]:
                show(f)
    sys.exit(1 if flags else 0)

if __name__ == '__main__':
    main()
