#!/usr/bin/env python3
# centre.py <board>: every track that ends on an SMD pad away from its centre is brought in along the pad's long axis
# and ended on the centre (LIV2's review, 2026-11-08: the mask opening is 0.05 mm larger than the pad, so copper that
# joins off-centre lies bare beside the pad and invites solder bridges). After routing, before finish.py.
# A change that would come closer to other copper than its clearance is not made; those are listed for a person.
import sys, math, pcbnew
B = pcbnew.LoadBoard(sys.argv[1]); mm, un = pcbnew.FromMM, pcbnew.ToMM; keep = []
OUT = 0.25          # how far beyond the pad's end the track turns onto the axis
V = pcbnew.VECTOR2I

items = []          # copper that a moved track must keep clear of
for f in B.Footprints():
    keep.append(f)
    for p in f.Pads(): keep.append(p); items.append(p)
for t in B.Tracks(): keep.append(t); items.append(t)
for z in B.Zones():
    keep.append(z)
    if not z.GetIsRuleArea() and z.GetAssignedPriority() > 0: items.append(z)   # fixed copper (the regulator's), not the pours
keepouts = [z for z in B.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowTracks()]

def clear(t):
    layer = t.GetLayer(); s = t.GetEffectiveShape(layer)
    for k in keepouts:
        if k.IsOnLayer(layer) and any(k.Outline().Contains(q) for q in (t.GetStart(), t.GetEnd())): return 'keep-out'
    for x in items:
        if x is t or x.GetNetCode() == t.GetNetCode() or not x.IsOnLayer(layer): continue
        cl = max(t.GetOwnClearance(layer), x.GetOwnClearance(layer))
        if x.GetEffectiveShape(layer).Collide(s, cl):
            return '%s %s' % (x.GetParentFootprint().GetReference() + '.' + x.GetNumber() if x.GetClass() == 'PAD' else x.GetClass(), x.GetNetname())
    return None

def axis(p):
    """unit vector along the pad's longer side, and half that length"""
    sz = p.GetSize(pcbnew.F_Cu); a = math.radians(-p.GetOrientationDegrees())
    ux, uy = (math.cos(a), math.sin(a)) if sz.x >= sz.y else (-math.sin(a), math.cos(a))
    return ux, uy, un(max(sz.x, sz.y)) / 2, un(min(sz.x, sz.y)) / 2

smd = [p for f in B.Footprints() for p in f.Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD]
vias = [t for t in B.Tracks() if t.GetClass() == 'PCB_VIA']
done, left = 0, []
for t in [t for t in B.Tracks() if t.GetClass() == 'PCB_TRACK']:
    for which in ('start', 'end'):
        e = t.GetStart() if which == 'start' else t.GetEnd(); o = t.GetEnd() if which == 'start' else t.GetStart()
        p = next((p for p in smd if p.GetNetCode() == t.GetNetCode() and p.IsOnLayer(t.GetLayer()) and p.HitTest(e)), None)
        if p is None: continue
        c = p.GetPosition()
        if math.hypot(un(e.x - c.x), un(e.y - c.y)) <= 0.01: continue
        if any(v.GetPosition() == e for v in vias): continue          # a via on the pad: leave it to a person
        ux, uy, half, _ = axis(p)
        ox, oy = un(o.x - c.x), un(o.y - c.y)
        side = 1 if ox * ux + oy * uy >= 0 else -1
        along = (ox * ux + oy * uy) * side
        ref = '%s.%s %s' % (p.GetParentFootprint().GetReference(), p.GetNumber(), t.GetNetname())
        old = (V(t.GetStart()), V(t.GetEnd()))
        def setend(pt):
            if which == 'start': t.SetStart(pt)
            else: t.SetEnd(pt)
        if along > half + OUT + 0.05:
            # turn onto the axis just beyond the pad, then straight in to the centre
            a = V(c.x + mm(side * ux * (half + OUT)), c.y + mm(side * uy * (half + OUT)))
            setend(a)
            n = pcbnew.PCB_TRACK(B); n.SetStart(a); n.SetEnd(V(c)); n.SetWidth(t.GetWidth()); n.SetLayer(t.GetLayer()); n.SetNet(t.GetNet())
            why = clear(t) or clear(n)
            if why: t.SetStart(old[0]); t.SetEnd(old[1]); left.append((ref, why)); continue
            B.Add(n); keep.append(n); items.append(n); done += 1
        else:
            # too short to turn: end it on the centre
            setend(V(c)); why = clear(t)
            if why: t.SetStart(old[0]); t.SetEnd(old[1]); left.append((ref, why)); continue
            done += 1
print('centred', done, 'left for a person', len(left))
for r, why in left: print('  ', r, '-', why)
pcbnew.ZONE_FILLER(B).Fill(B.Zones()); pcbnew.SaveBoard(sys.argv[1], B)
