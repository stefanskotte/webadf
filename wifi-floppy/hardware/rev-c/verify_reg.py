#!/usr/bin/env python3
# verify_reg.py <board> [sheet...]: the core regulator against Raspberry Pi's pattern and the RP2350 datasheet's limits (6.3.8).
import re, sys, math
from reg_pattern import *
def parse(t):
    st = [[]]
    for x in re.findall(r'"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+', t):
        if x == '(': st.append([])
        elif x == ')': a = st.pop(); st[-1].append(a)
        else: st[-1].append(x[1:-1] if x[0] == '"' else x)
    return st[0][0]
F = lambda n, k: [c for c in n if isinstance(c, list) and c and c[0] == k]
G = lambda n, k: (F(n, k) or [None])[0]
def netof(n):
    x = G(n, 'net'); return '' if not x else x[-1]
bad = []
def want(ok, msg):
    if not ok: bad.append(msg)
board = parse(open(sys.argv[1]).read())
fps = {}
for f in F(board, 'footprint'):
    fps[{p[1]: p[2] for p in F(f, 'property')}.get('Reference')] = f
for ref, (x, y, rot, pads) in PARTS.items():
    f = fps[ref]; at = G(f, 'at'); fx, fy = float(at[1]), float(at[2]); ang = float(at[3]) if len(at) > 3 else 0
    want(math.dist((fx-LX[0], fy-LX[1]), (x, y)) < 0.02, f'{ref} at ({fx-LX[0]:.2f},{fy-LX[1]:.2f}), pattern ({x},{y})')
    r = math.radians(-ang)
    for p in F(f, 'pad'):
        if p[1] not in pads: continue
        a = G(p, 'at'); px, py = float(a[1]), float(a[2])
        q = (fx+px*math.cos(r)-py*math.sin(r)-LX[0], fy+px*math.sin(r)+py*math.cos(r)-LX[1]); e = pads[p[1]]
        want(math.dist(q, e[:2]) < 0.06, f'{ref} pad {p[1]} at ({q[0]:.2f},{q[1]:.2f}), pattern {e[:2]}')
        want(netof(p) == e[2], f'{ref} pad {p[1]} on {netof(p)}, pattern {e[2]}')
segs = [(netof(s), G(s, 'layer')[1], tuple(map(float, G(s, 'start')[1:3])), tuple(map(float, G(s, 'end')[1:3]))) for s in F(board, 'segment')]
vias = [(netof(v), tuple(map(float, G(v, 'at')[1:3]))) for v in F(board, 'via')]
lx = [s for s in segs if s[0] == LXN]
want(lx and all(s[1] == 'F.Cu' for s in lx), 'VREG_LX has copper off the top layer')
want(not [v for v in vias if v[0] == LXN], 'VREG_LX has a via')
want(sum(math.dist(s[2], s[3]) for s in lx) < 4.5, f'VREG_LX is {sum(math.dist(s[2], s[3]) for s in lx):.1f} mm')
near = lambda p, q: math.dist(p, abs_(q)) < 0.02
for net, x, y in VIAS:
    want(any(v[0] == net and near(v[1], (x, y)) for v in vias), f'no {net} via at ({x},{y})')
want(not [s for s in segs if s[0] == 'GND' and s[1] == 'F.Cu' and math.dist(s[2], abs_((0.4, 0))) < 0.02 and s[3][1] > LX[1]], 'VREG_PGND runs straight to the exposed pad')
def inside(p, poly):
    c = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i-1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]: c = not c
    return c
top = [abs_(p) for p in CLEAR_TOP]; own = {LXN, DV, AV, '+3.3V', 'GND'}
for s in segs:
    if s[1] == 'F.Cu' and s[0] not in own and (inside(s[2], top) or inside(s[3], top)): want(False, f'{s[0]} routed through the regulator')
# nothing but COUT's output on the back under the inductor
cut = [abs_(p) for p in CUT_IN1]
for s in segs:
    if s[1] == 'B.Cu' and s[0] != DV and (inside(s[2], cut) or inside(s[3], cut)): want(False, f'{s[0]} on the back under the regulator')
zs = F(board, 'zone')
def pts(z): return [(float(p[1]), float(p[2])) for p in G(G(z, 'polygon'), 'pts')[1:] if p[0] == 'xy']
def layers(z): return (G(z, 'layer') or G(z, 'layers'))[1:]
for net, poly in ZONES:
    want(any(netof(z) == net and layers(z) == ['F.Cu'] and len(pts(z)) == len(poly) for z in zs), f'no top copper for {net}')
want(any(G(z, 'keepout') and layers(z) == ['In1.Cu'] and inside(abs_((0, -3.75)), pts(z)) for z in zs), 'no In1 cut under the inductor')
for z in zs:
    for ff in F(z, 'filled_polygon'):
        l = G(ff, 'layer')[1]
        if l in ('F.Cu', 'In1.Cu') and netof(z) == 'GND':
            P = [(float(p[1]), float(p[2])) for p in G(ff, 'pts')[1:] if p[0] == 'xy']
            if inside(abs_((0, -3.75)), P): want(False, f'GND copper under the inductor on {l}')
# values, from the sheets
vals = {}
for sh in sys.argv[2:]:
    for blk in re.split(r'\n\t\(symbol\n', open(sh).read())[1:]:
        p = dict(re.findall(r'\(property "([^"]+)" "([^"]*)"', blk))
        if 'Reference' in p: vals[p['Reference']] = p
if vals:
    for ref, v, fp in (('L1', 'AOTA-B201610S3R3-101-T', 'rev-c-lib:L_Abracon_AOTA-B201610S3R3-101-T'), ('C21', '4.7uF', 'rev-c-lib:C_0402_1005Metric_RP_wide'),
                       ('C23', '4.7uF', 'rev-c-lib:C_0402_1005Metric_RP_wide'), ('C22', '4.7uF', 'Capacitor_SMD:C_0402_1005Metric'), ('R20', '33', 'Resistor_SMD:R_0402_1005Metric'),
                       ('C15', '4.7uF', 'Capacitor_SMD:C_0402_1005Metric'), ('Y1', 'ABM8-272-T3', 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm'),
                       ('C25', '15pF', 'Capacitor_SMD:C_0402_1005Metric'), ('C26', '15pF', 'Capacitor_SMD:C_0402_1005Metric')):
        want(vals[ref]['Value'] == v, f"{ref} is {vals[ref]['Value']}, want {v}")
        want(vals[ref]['Footprint'] == fp, f"{ref} footprint {vals[ref]['Footprint']}")
for b in bad: print('FAIL', b)
print(f'regulator: {len(bad)} differences from the pattern')
sys.exit(1 if bad else 0)
