#!/usr/bin/env python3
# regulator.py <board>: the core regulator's copper, Raspberry Pi's pattern (reg_pattern.py), in place before anything is routed.
# Tracks hold the connections through routing; route.py adds the zones. The router stays out through two rule areas it removes after.
import sys, os, pcbnew
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reg_pattern as RP
B = pcbnew.LoadBoard(sys.argv[1]); mm = pcbnew.FromMM; keep = []
def pt(p): return pcbnew.VECTOR2I(mm(RP.LX[0]+p[0]), mm(RP.LX[1]+p[1]))
def net(n):
    x = B.FindNet(n); assert x is not None, n; return x
def line(n, w, poly, layer):
    for a, c in zip(poly, poly[1:]):
        t = pcbnew.PCB_TRACK(B); t.SetStart(pt(a)); t.SetEnd(pt(c)); t.SetWidth(mm(w)); t.SetLayer(layer); t.SetNet(net(n)); B.Add(t); keep.append(t)
for n, w, poly in RP.TRACKS: line(n, w, poly, pcbnew.F_Cu)
n, w, poly = RP.BACK; line(n, w, poly, pcbnew.B_Cu)
for n, x, y in RP.VIAS:
    v = pcbnew.PCB_VIA(B); v.SetPosition(pt((x, y))); v.SetDrill(mm(0.25)); v.SetWidth(mm(0.5)); v.SetNet(net(n)); B.Add(v); keep.append(v)
for name, poly, layer in (('REG router top', RP.CLEAR_TOP, pcbnew.F_Cu), ('REG router back', RP.CLEAR_BACK, pcbnew.B_Cu)):
    k = pcbnew.ZONE(B); k.SetIsRuleArea(True); k.SetDoNotAllowTracks(True); k.SetDoNotAllowVias(True); k.SetDoNotAllowPads(False)
    k.SetDoNotAllowZoneFills(False); k.SetDoNotAllowFootprints(False); k.SetLayer(layer); k.SetZoneName(name)
    o = k.Outline(); o.NewOutline()
    for p in poly: o.Append(mm(RP.LX[0]+p[0]), mm(RP.LX[1]+p[1]))
    B.Add(k); keep.append(k)
pcbnew.SaveBoard(sys.argv[1], B); print('regulator placed')
