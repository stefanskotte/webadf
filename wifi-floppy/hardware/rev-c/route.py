#!/usr/bin/env python3
# route.py export|import <board> <dsn-or-ses>
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[2])
if sys.argv[1] == 'export':
    print(pcbnew.ExportSpecctraDSN(b, sys.argv[3]))
else:
    print(pcbnew.ImportSpecctraSES(b, sys.argv[3]))
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import reg_pattern as RP
    keep = []
    for k in list(b.Zones()):
        keep.append(k)
        if k.GetIsRuleArea() and k.GetZoneName().startswith('REG router'): b.Remove(k)   # for the router only
    mm = pcbnew.FromMM
    LAYERS = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    want = [(pcbnew.F_Cu, 'GND'), (pcbnew.B_Cu, 'GND')]
    if LAYERS == 4:
        b.SetCopperLayerCount(4)
        want += [(pcbnew.In1_Cu, 'GND'), (pcbnew.In2_Cu, '+3.3V')]
        for k in b.Zones():
            if k.GetIsRuleArea(): k.SetLayerSet(pcbnew.LSET.AllCuMask(4))
        k = pcbnew.ZONE(b); k.SetIsRuleArea(True); k.SetDoNotAllowZoneFills(True); k.SetDoNotAllowTracks(False); k.SetDoNotAllowVias(False)
        k.SetDoNotAllowPads(False); k.SetDoNotAllowFootprints(False); k.SetLayer(pcbnew.In1_Cu); k.SetZoneName('Regulator: datasheet figure 24 cut-out')
        o = k.Outline(); o.NewOutline()
        for p in RP.CUT_IN1: o.Append(mm(RP.LX[0]+p[0]), mm(RP.LX[1]+p[1]))
        b.Add(k)
    for layer, netname in ([] if LAYERS == 0 else want):
        z = pcbnew.ZONE(b); z.SetLayer(layer); z.SetNet(b.FindNet(netname)); o = z.Outline(); o.NewOutline()
        for x, y in ((101.05,100),(162.4,100),(162.4,154),(101.05,154)): o.Append(mm(x), mm(y))
        if layer == pcbnew.F_Cu:      # the regulator's ground joins the rest only through its vias
            o.NewHole()
            for p in RP.CLEAR_TOP: o.Append(mm(RP.LX[0]+p[0]), mm(RP.LX[1]+p[1]), 0, 0)
        z.SetLocalClearance(mm(0.2)); z.SetMinThickness(mm(0.15)); z.SetThermalReliefGap(mm(0.2)); z.SetThermalReliefSpokeWidth(mm(0.25))
        b.Add(z)
    for netname, poly in RP.ZONES:    # Raspberry Pi's copper, above any pour
        z = pcbnew.ZONE(b); z.SetLayer(pcbnew.F_Cu); z.SetNet(b.FindNet(netname)); o = z.Outline(); o.NewOutline()
        for p in poly: o.Append(mm(RP.LX[0]+p[0]), mm(RP.LX[1]+p[1]))
        z.SetAssignedPriority(5); z.SetLocalClearance(mm(0.127)); z.SetMinThickness(mm(0.1)); z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
        z.SetZoneName('Regulator ' + netname); b.Add(z)
    f = pcbnew.ZONE_FILLER(b); f.Fill(b.Zones()); pcbnew.SaveBoard(sys.argv[2], b)
