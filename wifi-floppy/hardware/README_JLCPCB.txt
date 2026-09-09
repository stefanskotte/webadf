wifi_floppy - rev B - JLCPCB order settings
===========================================
Upload wifi_floppy_gerbers.zip directly to the JLCPCB quote page.

  Base material    FR-4
  Layers           2
  Dimensions       96 x 62 mm  (detected from wifi_floppy.GKO)
  PCB thickness    1.6 mm
  Surface finish   HASL or ENIG (either is fine)
  Outer copper     1 oz
  Via covering     Tented   <-- mask files have no via openings
  Min hole / track 0.35 mm drill, 0.30 mm track  (well inside JLC capability)

Files
  wifi_floppy.GTL   top copper
  wifi_floppy.GBL   bottom copper (incl. GND plane)
  wifi_floppy.GTS   top solder mask
  wifi_floppy.GBS   bottom solder mask
  wifi_floppy.GTO   top silkscreen (outlines, pin-1 markers, designators)
  wifi_floppy.GKO   board outline
  wifi_floppy.TXT   Excellon drill, metric, plated (102 holes: 78x1.0, 24x0.35)

Notes
  * All holes are plated; the board has no NPTH and no mounting holes.
  * Silkscreen carries component outlines, the J1/J2/U1 pin-1 markers, U2's
    pin-1 dot, D1's body outline and cathode bar, every reference designator,
    the antenna-keepout label and the board's "WIFI FLOPPY REV B" marking. Text is drawn with the single-stroke
    font in stroke_font.py; there is no filled type, which is normal for
    silkscreen.
  * EVERY silk feature is >= 0.2 mm, against JLCPCB's 0.15 mm (6 mil) minimum,
    and text is 1.0-1.5 mm against their 0.8 mm minimum, checked by
    verify_board.py out of the emitted .GTO. Rev A and rev A2 went out at
    0.12 mm, under spec; JLC printed them anyway, so it is a violation rather
    than a proven failure - but not one to rely on batch to batch.
  * The GND plane was computed by export_gerbers.py, not by KiCad. It was
    verified by re-parsing the emitted Gerber: 0.30 mm clearance to all
    foreign copper, 27/27 GND pads bonded via thermal spokes, 51/51 signal
    pads clear, no copper inside the antenna keepout, single connected island.
  * Still worth doing before you commit money: open the .kicad_pcb in KiCad,
    refill zones, and run the real DRC, and confirm the three footprints
    (Pico 17.78 mm rows, SOIC-20W, SOT-23) against your actual parts.


REV A2 - corrections after the first batch came back mirrored
------------------------------------------------------------
1. Gerber/Excellon Y axis is now flipped (KiCad is Y-down, Gerber is Y-up).
   The rev A files were exported without this, so every layer was reflected
   and the boards were unbuildable. Verified by verify_board.py, which
   compares pad coordinates in the Gerber against the .kicad_pcb.
2. SOT-23 gate/source assignment corrected. Q1/Q2/Q3/Q6 were reflections of
   the canonical KiCad land pattern (gate and source swapped) and could not
   have taken a real part. All six now match by rotation.
3. Q3 moved 0.6 mm north; with the corrected orientation its gate pad and
   Q4's source pad overlapped. Its drain now jogs to J1 row 13.
4. INDEX, TRK0, RDY and CHNG gate routes re-run to follow the moved pads.

155 segments, 24 vias, 0 DRC violations. Order settings above are unchanged.

The rev A2 boards were fabricated from these files and ARE NOT SCRAP, but see
rev B below before ordering more of them.


REV B - antenna keepout moved, and the silkscreen finally lettered
------------------------------------------------------------------
export_gerbers.py flipped Y for pads, traces, silk, outline and drill but not
for the antenna keepout polygon, so on rev A2 the ground-pour void landed over
U1 pins 1/2/39/40 - the USB end - and copper stayed under the RM2 antenna.
Fixed; the void is now over pins 19-22.

Separately: rev A and rev A2 carry body outlines but NO LETTERING AT ALL,
because export_gerbers.py read only fp_line and silently dropped all 13
reference designators, the keepout label and U2's pin-1 dot. Rev B renders
them through stroke_font.py and draws circles.

Their silk was also 0.12 mm (0.15 for the J1 chevron), under JLCPCB's 6 mil
minimum. It printed regardless - J2's and U1's outlines are legible on an
assembled rev A2 board - so that is a spec violation, not a proven failure.
Rev B draws silk at 0.2 mm and text at 1.0-1.5 mm anyway, because a layer that
prints only because the fab was lenient is not one to ship twice.

verify_board.py checks this by reading copper out of the emitted .GBL rather
than re-deriving the void from the exporter, which is how the rev A2 audit
agreed with the exporter's own mistake. It fails on the rev A2 .GBL and passes
on these files.

Copper, mask, drill and outline are byte-identical to rev A2 (.GTL, .GTS,
.GBS, .GKO, .TXT). Two files change: .GBL, for the keepout, and .GTO, because
rev B is the first revision that puts any lettering on the board. A rev A2
board is still electrically correct - it has outlines but no designators, and
ground plane under its antenna.

REV B IS MARKED. The board now says "WIFI FLOPPY REV B" on the silkscreen, and
carries its reference designators. Rev A and rev A2 have neither, so an
unmarked board in a drawer is one of the older two - and which of those it is
you tell from the pour void: A2 has it at the USB end of U1, B at the opposite
end.

UNCONFIRMED, and worth 30 seconds before you spend money: that the RM2's
antenna is at the pin 19-22 end at all. That is the design's assumption,
inherited from the CYW43 Pico 2 W, and no one has checked it against a
Pimoroni PIM726 in hand. verify_board.py enforces the assumption; it cannot
validate it.

155 segments, 24 vias, 0 DRC violations. Order settings above are unchanged.
