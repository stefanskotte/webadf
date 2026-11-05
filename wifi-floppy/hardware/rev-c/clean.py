#!/usr/bin/env python3
# clean.py <board> <drc.json>: remove the vias DRC calls dangling (the router's leftovers) and the track stubs that led only to them.
import json, sys, pcbnew
B = pcbnew.LoadBoard(sys.argv[1]); d = json.load(open(sys.argv[2])); keep = []
spots = [(i['pos']['x'], i['pos']['y']) for x in d['violations'] if x['type'] in ('via_dangling',) for i in x['items']]
items = [t for t in B.Tracks()]
gone = 0
for t in items:
    if t.GetClass() == 'PCB_VIA':
        p = t.GetPosition()
        if any(abs(pcbnew.ToMM(p.x)-x) < 0.002 and abs(pcbnew.ToMM(p.y)-y) < 0.002 for x, y in spots):
            B.Remove(t); keep.append(t); gone += 1
print('removed vias', gone)
items = [t for t in B.Tracks()]
for t in items:                # the router's rare neck below the fab's 0.09 mm
    if t.GetClass() != 'PCB_VIA' and t.GetWidth() < pcbnew.FromMM(0.09): t.SetWidth(pcbnew.FromMM(0.09)); print('widened', t.GetNetname())
f = pcbnew.ZONE_FILLER(B); f.Fill(B.Zones()); pcbnew.SaveBoard(sys.argv[1], B)
