#!/usr/bin/env python3
# stitch.py <board>: every GND and +3.3V pad the router left without a way to its inner plane gets a short stub and a via.
# Works only on 4-layer boards. Reports what it could not place.
import sys, math, pcbnew
B = pcbnew.LoadBoard(sys.argv[1]); mm = pcbnew.FromMM; un = pcbnew.ToMM
VD, VH, TW, CL = 0.5, 0.25, 0.2, 0.15
def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx-ax, by-ay; l = dx*dx+dy*dy
    t = 0 if l == 0 else max(0, min(1, ((px-ax)*dx+(py-ay)*dy)/l))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))
def seg_seg(a, b):
    return min(seg_dist(*a[:2], *b), seg_dist(*a[2:], *b), seg_dist(*b[:2], *a), seg_dist(*b[2:], *a))
tracks = []; vias = []
keep = []
for t in B.Tracks():
    keep.append(t); s, e = t.GetStart(), t.GetEnd()
    if t.GetClass() == 'PCB_VIA': vias.append((un(s.x), un(s.y), t.GetNetname(), un(t.GetWidth(pcbnew.F_Cu))))
    else: tracks.append((un(s.x), un(s.y), un(e.x), un(e.y), un(t.GetWidth()), t.GetLayer(), t.GetNetname()))
pads = []
fps = []
for f in B.Footprints():
    fps.append(f)
    for p in f.Pads():
        keep.append(p); bb = p.GetBoundingBox(); th = p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)
        pads.append((un(bb.GetX()), un(bb.GetY()), un(bb.GetRight()), un(bb.GetBottom()), p.GetNetname(), p.IsOnLayer(pcbnew.F_Cu), p.IsOnLayer(pcbnew.B_Cu) or th, p))
def box_dist(x, y, q):
    dx = max(q[0]-x, 0, x-q[2]); dy = max(q[1]-y, 0, y-q[3]); return math.hypot(dx, dy)
def via_ok(x, y, net):
    if not (101.6 < x < 161.9 and 102.8 < y < 153.5) or (y > 148.4 and x > 135.9): return False
    for q in pads:
        if q[4] != net and box_dist(x, y, q) < VD/2+CL: return False
        if q[4] == net and q[7].GetDrillSizeX() > 0 and box_dist(x, y, q) < VD/2+0.25: return False
    for t in tracks:
        if t[6] != net and seg_dist(x, y, *t[:4]) < VD/2+t[4]/2+CL: return False
    for v in vias:
        d = math.hypot(x-v[0], y-v[1])
        if d < (VD+v[3])/2+0.2 : return False
    return True
def stub_ok(ax, ay, bx, by, net):
    for q in pads:
        if q[4] == net or not q[5]: continue
        n = 12
        for i in range(n+1):
            if box_dist(ax+(bx-ax)*i/n, ay+(by-ay)*i/n, q) < TW/2+CL: return False
    for t in tracks:
        if t[6] != net and t[5] == pcbnew.F_Cu and seg_seg((ax, ay, bx, by), t[:4]) < TW/2+t[4]/2+CL: return False
    for v in vias:
        if v[2] != net and seg_dist(v[0], v[1], ax, ay, bx, by) < TW/2+v[3]/2+CL: return False
    return True
done = fail = 0
def add_track(ax, ay, bx, by, net, layer=pcbnew.F_Cu, w=TW):
    t = pcbnew.PCB_TRACK(B); t.SetStart(pcbnew.VECTOR2I(mm(ax), mm(ay))); t.SetEnd(pcbnew.VECTOR2I(mm(bx), mm(by))); t.SetWidth(mm(w)); t.SetLayer(layer); t.SetNet(net); B.Add(t); keep.append(t)
    tracks.append((ax, ay, bx, by, w, layer, net.GetNetname()))
def add_via(x, y, net, d=VD, h=VH):
    v = pcbnew.PCB_VIA(B); v.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y))); v.SetDrill(mm(h)); v.SetWidth(mm(d)); v.SetNet(net); B.Add(v); keep.append(v)
    vias.append((x, y, net.GetNetname(), d))
# RP2350 power pins: the vias go inside the package outline, between the pads and the exposed pad, so the perimeter stays
# free for the signals. +3.3V drops to its plane; DVDD joins a ring on B.Cu under the chip.
U1 = B.FindFootprintByReference('U1'); ux, uy = un(U1.GetPosition().x), un(U1.GetPosition().y)
upad = {p.GetNumber(): p for p in U1.Pads()}; keep.append(U1); keep.extend(upad.values())
def inward(pn, r, slide=0.0):
    p = upad[str(pn)]; x, y = un(p.GetPosition().x), un(p.GetPosition().y)
    if abs(x-ux) > abs(y-uy): return (x, y), (ux+math.copysign(r, x-ux), y+slide)
    return (x, y), (x+slide, uy+math.copysign(r, y-uy))
placed = {}
for pn, slide in ((5,0),(15,0),(24,0),(29,0),(41,0),(50,0),(60,0),(76,0),(64,0),(69,0),(68,None)):
    p = upad[str(pn)]
    if slide is None:               # 68 sits beside 69: they share 69's via
        (ax, ay), _ = inward(68, 3.75); vx, vy = placed[69]; add_track(ax, ay, vx, vy, p.GetNet()); continue
    (ax, ay), (vx, vy) = inward(pn, 4.0 if pn == 60 else 3.75, slide); add_track(ax, ay, vx, vy, p.GetNet()); add_via(vx, vy, p.GetNet()); placed[pn] = (vx, vy); done += 1
ring = 2.9
dv = upad['10'].GetNet()
for pn, slide in ((10,0),(32,0),(51,-0.4),(65,-0.5)):
    (ax, ay), (vx, vy) = inward(pn, ring, slide)
    (_, _), (ix, iy) = inward(pn, 4.2)   # straight off the pad first: it must not clip the pad beside it
    add_track(ax, ay, ix, iy, dv); add_track(ix, iy, vx, vy, dv); add_via(vx, vy, dv); done += 1
c = [(ux-ring, uy-ring), (ux+ring, uy-ring), (ux+ring, uy+ring), (ux-ring, uy+ring)]
for i in range(4): add_track(*c[i], *c[(i+1) % 4], dv, pcbnew.B_Cu, 0.4)

planes = {'GND', '+3.3V'}
for q in pads:
    net = q[4]; p = q[7]
    if net not in planes: continue
    if p.GetDrillSizeX() > 0: continue         # through-hole: on the plane already
    if p.GetParentFootprint().GetReference() == 'U1' and p.GetNumber() != '62': continue
    cx, cy = (q[0]+q[2])/2, (q[1]+q[3])/2
    # already joined: a via of this net touching, or a track of this net leading to a via is left to DRC's report
    if any(t[6] == net and t[5] == pcbnew.F_Cu and (box_dist(t[0], t[1], q) < 0.01 or box_dist(t[2], t[3], q) < 0.01) for t in tracks): continue
    best = None
    if p.GetParentFootprint().GetReference() == 'U1' and p.GetNumber() == '62':
        # VREG_PGND joins the exposed pad directly.
        pp = p.GetPosition(); mid = pcbnew.VECTOR2I(pp.x, mm(uy-2.6)); end = pcbnew.VECTOR2I(mm(ux+1.5), mm(uy-1.5))
        for a, c in ((pp, mid), (mid, end)):
            t = pcbnew.PCB_TRACK(B); t.SetStart(a); t.SetEnd(c); t.SetWidth(mm(0.15)); t.SetLayer(pcbnew.F_Cu); t.SetNet(p.GetNet()); B.Add(t); keep.append(t)
        done += 1; continue
    for r in (0.7, 0.9, 1.1, 1.3, 1.6, 2.0, 2.5, 3.0):
        away = math.degrees(math.atan2(cy-uy, cx-ux))
        for a in sorted(range(0, 360, 15), key=lambda a: abs((a-away+180) % 360-180)):   # away from the chip first
            x, y = cx+r*math.cos(math.radians(a)), cy+r*math.sin(math.radians(a))
            if via_ok(x, y, net) and stub_ok(cx, cy, x, y, net):
                best = (x, y); break
        if best: break
    if not best:
        fail += 1; print('no room', p.GetParentFootprint().GetReference(), p.GetNumber(), net); continue
    x, y = best
    t = pcbnew.PCB_TRACK(B); t.SetStart(pcbnew.VECTOR2I(mm(cx), mm(cy))); t.SetEnd(pcbnew.VECTOR2I(mm(x), mm(y))); t.SetWidth(mm(TW)); t.SetLayer(pcbnew.F_Cu); t.SetNet(p.GetNet()); B.Add(t); keep.append(t)
    v = pcbnew.PCB_VIA(B); v.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y))); v.SetDrill(mm(VH)); v.SetWidth(mm(VD)); v.SetNet(p.GetNet()); B.Add(v); keep.append(v)
    tracks.append((cx, cy, x, y, TW, pcbnew.F_Cu, net)); vias.append((x, y, net, VD)); done += 1
print('stitched', done, 'failed', fail)
f = pcbnew.ZONE_FILLER(B); f.Fill(B.Zones()); pcbnew.SaveBoard(sys.argv[1], B)
