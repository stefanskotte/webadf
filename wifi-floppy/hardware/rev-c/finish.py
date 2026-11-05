#!/usr/bin/env python3
# finish.py <board>: three JLC assembly fiducials, each in the free spot nearest a corner of the board, after routing.
import sys, pcbnew
B = pcbnew.LoadBoard(sys.argv[1]); mm = pcbnew.FromMM; un = pcbnew.ToMM; keep = []
FP = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/Fiducial.pretty'
boxes = []
for f in B.Footprints():
    if f.GetReference().startswith('FID'): B.Remove(f); keep.append(f); continue
    keep.append(f)
    for p in f.Pads():
        keep.append(p); b = p.GetBoundingBox(); boxes.append((un(b.GetX()), un(b.GetY()), un(b.GetRight()), un(b.GetBottom())))
    for r in (f.GetCourtyard(pcbnew.F_CrtYd),):
        if r.OutlineCount():
            b = r.BBox(); boxes.append((un(b.GetX()), un(b.GetY()), un(b.GetRight()), un(b.GetBottom())))
for t in B.Tracks():
    keep.append(t); s, e = t.GetStart(), t.GetEnd()
    boxes.append((min(un(s.x), un(e.x)), min(un(s.y), un(e.y)), max(un(s.x), un(e.x)), max(un(s.y), un(e.y))))
def free(x, y, r=1.3):
    if y > 148.3 and x > 135.5: return False
    return all(x+r < a or x-r > c or y+r < b or y-r > d for a, b, c, d in boxes)
for ref, tx, ty in (('FID1', 103, 102.5), ('FID2', 103, 152), ('FID3', 160, 103)):
    best = min(((x/2, y/2) for x in range(204, 322) for y in range(206, 306) if free(x/2, y/2)), key=lambda q: (q[0]-tx)**2+(q[1]-ty)**2)
    f = pcbnew.FootprintLoad(FP, 'Fiducial_1mm_Mask2mm'); f.SetReference(ref); f.SetBoardOnly(True); B.Add(f); f.SetPosition(pcbnew.VECTOR2I(mm(best[0]), mm(best[1]))); keep.append(f)
    boxes.append((best[0]-1, best[1]-1, best[0]+1, best[1]+1)); print(ref, best)
# silkscreen: rev C's name, nothing left from the module; part values belong on the fab layer
for d in list(B.GetDrawings()):
    keep.append(d)
    if d.GetClass() == 'PCB_TEXT' and 'ANTENNA' in d.GetText(): B.Remove(d)
    elif d.GetClass() == 'PCB_TEXT' and 'WIFI FLOPPY' in d.GetText():
        d.SetText('WIFI FLOPPY\nREV C'); d.SetTextAngleDegrees(0); d.SetPosition(pcbnew.VECTOR2I(mm(156.5), mm(130.8)))
        d.SetTextSize(pcbnew.VECTOR2I(mm(1.0), mm(1.0)))
for f in B.Footprints():
    # data fields (MPN) are for the BOM, and a new field defaults to visible on silk
    for x in f.GetFields():
        if not x.IsReference(): x.SetVisible(False)
    if f.GetReference().startswith('FID'): f.Reference().SetVisible(False)
pcbnew.ZONE_FILLER(B).Fill(B.Zones()); pcbnew.SaveBoard(sys.argv[1], B)
