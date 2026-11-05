#!/usr/bin/env python3
# route.py export|import <board> <dsn-or-ses>
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[2])
if sys.argv[1] == 'export':
    print(pcbnew.ExportSpecctraDSN(b, sys.argv[3]))
else:
    print(pcbnew.ImportSpecctraSES(b, sys.argv[3]))
    mm = pcbnew.FromMM
    LAYERS = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    want = [(pcbnew.F_Cu, 'GND'), (pcbnew.B_Cu, 'GND')]
    if LAYERS == 4:
        b.SetCopperLayerCount(4)
        want += [(pcbnew.In1_Cu, 'GND'), (pcbnew.In2_Cu, '+3.3V')]
        for k in b.Zones():
            if k.GetIsRuleArea(): k.SetLayerSet(pcbnew.LSET.AllCuMask(4))
    for layer, netname in ([] if LAYERS == 0 else want):
        z = pcbnew.ZONE(b); z.SetLayer(layer); z.SetNet(b.FindNet(netname)); o = z.Outline(); o.NewOutline()
        for x, y in ((101.05,100),(162.4,100),(162.4,154),(101.05,154)): o.Append(mm(x), mm(y))
        z.SetLocalClearance(mm(0.2)); z.SetMinThickness(mm(0.15)); z.SetThermalReliefGap(mm(0.2)); z.SetThermalReliefSpokeWidth(mm(0.25))
        b.Add(z)
    f = pcbnew.ZONE_FILLER(b); f.Fill(b.Zones()); pcbnew.SaveBoard(sys.argv[2], b)
