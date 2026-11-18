# Rev C: on-board RP2350, schematic and routed board

Rev B with the PIM726 module replaced by its parts on our PCB: RP2350B, 16 MB flash, 16 MB PSRAM, RM2 radio, crystal, core regulator, USB-C, BOOTSEL, SWD. Every GPIO stays where the PIM726 has it, so the firmware's pin map and the pico-sdk board definition are unchanged. Same outline as rev B, widened 13.1 mm to the left on 2026-11-17 for a second floppy connector (J5 EXT DRV, an original drive as DF0) and made 2 mm taller at the top on 2026-11-18 for larger connector labels: see "Original drive connector". Rev B's files are untouched.

**The schematic and the routed board agree, and nothing else about the board differs from using a PIM726 on rev B. It is still not a board to order:** see "Owed before a fab order".

## Result (2026-11-05, copper revised 2026-11-11 and 2026-11-16, original-drive connector added 2026-11-17)

| Check | Result |
|---|---|
| Layers | 4: signals on F.Cu and B.Cu, GND on In1, +3.3 V on In2 |
| KiCad DRC, with schematic parity | 0 unconnected, 0 errors, 0 parity differences. 40 warnings: the 25 from before (21 M1's outline over its own pads, 3 silkscreen at the board edge, one 0.03 mm neck somewhere in the top ground pour, not located) and 15 new: 11 where the SOT-23 and MSOP outlines of U6, U7, U8 and Q9 reach the new left edge, and 4 where the side labels SEL2, DRV PWR and J8 touch J5's and J9's outlines (the strip is 3.6 mm wide) |
| ERC | 0 errors, 0 warnings |
| `verify_sch.py` | all 82 multi-pin nets match, whatever they are called |
| `verify_pins.py rev-c.kicad_pcb` | 210 of 210 against the RP2350 datasheet, firmware `board.c`, the pico-sdk header, the RM2 datasheet, and rev B's connected pads (U2 pin 2 is checked as the mux's output, SEL0M_B, and the mux's SEL0 input as rev B's U2 pin 2 net) |
| `verify_reg.py` | the regulator matches Raspberry Pi's pattern: 62 differences before, 0 now |
| `pnpm hw:verify rev-c` | passes: ERC, DRC, firmware pins, J1 lines, 1k pull-ups, the regulator, and the original-drive checks (J5's pins against J1's, the sense pins, the pull-ups, U6/Q9/U7/U8/J8/J9 pins) |
| `check45.py rev-c.kicad_pcb` | passes: every track at a multiple of 45 degrees, every bend 45 or 90 degrees, no short leg between two bends. It lets through, and lists on every run, the regulator's own tracks (10 flags) and two 0.1 mm steps at U1 pins 71 and 73; see "Routing rule" |
| Gerbers | regenerated 2026-11-18 for the buzzer header, same 14 files and export settings; 307 holes for 204 vias and 103 drilled pads. Not analysed with kicad-happy, not through JLC's own check |
| Tracks | 0.15 mm, necked to 0.11 mm at the QFN, vias 0.45/0.2 mm, spacing 0.127 mm: within JLC's published 4-layer limits, not confirmed by JLC |

## Copper review, 2026-11-11

A read of the autorouted copper found nine things to fix. Shanshe's hand re-route had not arrived, so they were fixed on this board with scripted and hand-placed tracks. Seven were fixed with the parts where they stood; the operator then allowed placement changes for the last two, QSPI and the USB pair. Each change was kept only if DRC (with parity), `verify_reg.py`, `verify_pins.py` and `hw:verify rev-c` still passed. The regulator's pattern is untouched.

| | Before | Now |
|---|---|---|
| 1. IOVDD pins tracked to their 100 nF capacitor on the top layer | 1 of 11 (pin 64) | 7 of 11: 5, 29, 41, 50, 60, 76 added, 1.5 to 2.4 mm each; their vias under the chip are gone, so the capacitor's via is the pin's way to the plane |
| 2. C15 to DVDD pin 32 | 15.4 mm, 2 vias | 2.2 mm on the top layer |
| 3. QSPI, U1 to PSRAM (CLK, SD0, SD1, SD2, SD3) | 14.5, 27.7, 33.7, 14.3, 15.1 mm | 8.3, 8.1, 15.0, 13.8, 8.2 mm |
| 3. QSPI, U1 to flash | 13.1, 13.5, 19.4, 18.4, 15.5 mm | 12.9, 10.0, 19.1, 16.5, 15.4 mm |
| 3. QSPI, vias on those five lines | 9 | 5: none on CLK, SD0 and SD3, three on SD1, two on SD2 |
| 3. QSPI, longest branch past a junction | 16.0 mm (SD0, through the flash to the PSRAM) | 13.5 mm (SD1 to the flash); CLK, SD0 and SD3 have no branch |
| 3. Chip selects | QCS 23.0 mm, 3 vias; PSRAM_CS 20.5 mm, none | QCS **unchanged**; PSRAM_CS 21.5 mm, none |
| 4. USB D+/D-, gap between the two, median | 3.8 mm, one each side of L1 | 0.15 mm, together on the back |
| 4. USB D+/D-, resistor to pin | 15.7 and 17.5 mm, 2 vias each | 16.6 and 17.1 mm, 2 vias each |
| 5. Crystal: XIN, pin to Y1 | 9.7 mm, 2 vias, through C25's pad | 7.2 mm, no vias, between Y1's ground pads |
| 5. WL_D beside the crystal | between R22's pads, 0.65 mm from Y1 | crosses under XIN and XOUT on the back at the pins; 0.7 mm from R22 and 1.8 mm from Y1; 4 vias instead of 2 |
| 5. WL_ON below Y1 | 0.5 mm from the XIN pad | 1.0 mm |
| 5. Ground plane under Y1 | 98% | 100% |
| 6. VBUS, J6 A4/B9 to D3 | 0.2 mm wide, 9.3 mm, 0.5/0.25 vias | 0.5 mm wide, 6.9 mm, 0.7/0.35 vias; VBUS is in the Reg class (`rules.py`) |
| 7. Plane vias inside an SMD pad | 28 | 9 |
| 8. Segments under 0.05 mm | 82 (58 of zero length) | 0 |
| 8. Joints under 45 degrees | 6 | 0 |
| 9. CC1 between R26 and R28 | 0.09 mm for 0.3 mm | 0.15 mm |
| Whole board | 972 segments, 180 vias | 855 segments, 168 vias |

What was not done, and why:

- **QSPI (3), placement changed.** U4 is turned half a turn and moved 0.9 mm west; R24 moved onto the PSRAM_CS run by R20, and C28 to below U4's supply pin. U3 and C20 stay. With U4 this way round, SD0, CLK and SD3 run on the top layer from U1 into U4's pads and out of them to U3's: no vias and no branch, over unbroken ground. SD1 and SD2 are on U4's far row and U3's far column, and U1's pin order puts them on the wrong side of the other three, so each branches at a via below U4 and hops under them on the back. What is not better: SD1 is still 19 mm to the flash, now through two vias; the flash lengths are spread wider (6.3 mm before, 9.1 now) because the short lines got shorter, none longer; PSRAM_CS is 1.0 mm longer; QCS was not touched, because C20 stands over its pin and it can only leave U1 inwards.
- **USB pair (4), placement not changed.** Both lines leave pins 67 and 66 to the north-west on the top layer (the only way pin 66 can go), drop through a via each beside the regulator's keep-out, run the back 0.15 mm apart above the regulator, and come up at a via each beside R25 and R26. R25 and R26 were not swapped: at J6 the D+ pads come out west of D-, and CC2 and CC1 pass west, south and east of the two resistors, so a top-layer pair has no way out of that pocket whichever resistor stands where; with the vias the present order needs no crossing. Two vias a line is the least this layout allows. A pair with no vias would need R28 moved to J6's west side (or vias on CC2) and vias on PSRAM_CS instead; not done. The pair is on the back, so its reference is the +3.3 V plane, not ground; both planes are whole under it but for the vias' own holes. It is 12 Mbit/s.
- **IOVDD pins 15 and 24** keep their vias under the chip: TRK0 on the top layer lies between pin 15 and C12, and WL_ON's via sits below pin 24 with WPROT on the back leaving it nowhere else to go. **Pins 68 and 69** have no capacitor this side of the USB pins.
- **C23 to DVDD pins 51 and 10** (9.6 and 13.0 mm, two vias) is Raspberry Pi's back track and the ring under the chip: the pattern, so it stays.
- **Via-in-pad, 9 left:** RM2's six ground castellations (the only free copper beside them is under the module), U5's two tab vias (the regulator's output and heat go through them) and U2 pin 19 (no free spot within 2 mm).
- **VSYS and VBUS still cross under Y1 on the back**, behind both planes.
- The link between J6's two VBUS pin pairs is still 0.2 mm: the connector's locating holes leave no room for more.

XIN now runs under the crystal's body, between its two ground pads. That is short and has ground on both sides, but it is under the can: say if you would rather have it go round.

## Routing rule, 2026-11-16

The operator's rule (2026-11-15): every track runs at a multiple of 45 degrees, and each bend turns by exactly 45 or 90 degrees: no sharp corners, and no turn built from several small kinks. `check45.py` is the rule as a check; it read 203 flags on the 2026-11-11 board. The copper was fixed where it lay, not routed again, so the copper review's fixes above are kept. Each change was kept only if nothing came closer than its clearance, and the whole board was then put through DRC (with parity), `verify_reg.py`, `verify_pins.py` and `hw:verify rev-c`.

Where the 203 came from, and what was done:

- **Plane stubs.** `stitch.py` tried its vias every 15 degrees round a pad, so most stubs stood at 15, 30, 60 or 75 degrees. 19 vias moved round their pad onto a 45 degree direction (under 0.4 mm); the other stubs keep their via and bend once. The nine vias inside a pad stay inside it.
- **Joins at pads.** `centre.py` (LIV2's off-centre joins, 2026-11-08) pulled track ends onto pad centres and left the last leg at whatever angle that gave: most of the 1 to 20 degree legs at U1's pins and the 0402 pads. Each such stretch was drawn again between its fixed points as straight legs and 45 degree diagonals that end exactly on them.
- **Steps, teeth and points** the autorouter left where it changed track width: the neighbouring legs were slid until the short one was gone.

| | 2026-11-11 | Now |
|---|---|---|
| `check45.py --no-exempt` (counts everything) | 203: 91 angles, 76 odd bends, 35 short legs, 1 sharp corner | 12: the regulator's 10 and the 2 steps below |
| Segments, vias | 855, 168 | 819, 168 |
| Vias moved | | 22: 19 plane stubs' vias, and WGATE's, STEP's and SWDIO's by under 0.1 mm each |
| Vias inside an SMD pad | 9 | 9, the same ones |
| Track, both layers | 1646.1 mm | 1643.3 mm |
| Track necked to 0.11 mm | 73 segments, 50.5 mm | 39 segments, 34.2 mm |
| Segments under 0.05 mm, joints under 45 degrees | 0, 0 | 0, 0 |
| QFN pins whose track leaves through the side of the pad | 5 (pins 1, 9, 21, 61, 80) | the same 5 |
| Track ends inside a pad, off its centre | 15 | the same 15, and C23's ground track (below) |
| QSPI lengths, C15 to pin 32, XIN | | unchanged |
| USB pair, gap between the two, median | 0.15 mm | 0.15 mm |
| USB D-, J6 to R26 | 4.55 mm | 3.76 mm |
| DRC | 0 errors, 0 unconnected, 0 parity, 25 warnings | the same |

**The check itself was wrong in two ways, and is stricter now.** A step (two 45 degree bends turning opposite ways) passed or failed by the order its segments stand in the file, and a short leg cut into two collinear segments was never seen as short. By the check as first written the old board had 191 flags; by the corrected one, 203.

**Two steps are left, and `check45-exceptions.json` names them:** QSD2 at U1 pin 73 (0.10 mm sideways, a 0.14 mm leg) and QSCLK at pin 71 (0.12 mm, a 0.17 mm leg). The five QSPI lines leave pins 74 to 70, 0.4 mm apart, and run north side by side at 0.277 mm (0.15 mm track, 0.127 mm clearance). QSD1 can be no further west than x = 145.75 (C20's ground pad and its via), QSD3 no further east than x = 146.96 (the USB D+ via): 1.23 mm for four gaps of 0.277 mm, so 0.12 mm to spare. A step whose leg is 0.25 mm or longer moves a line at least 0.18 mm sideways, so each line must stand either on its pin or at least 0.18 mm off it. QSD1 must be at least 0.18 mm east of pin 74; QSD2 then cannot stand on pin 73 (0.22 mm from QSD1) and would have to be 0.18 mm east as well, then QSD0, then QSCLK, which puts QSD3 0.29 mm past its limit. Counting from QSD3 westwards fails the same way at QSD1. So at least two of the five steps are short. Moving C20, its via or the USB pair's vias would free them; those are the 2026-11-11 placement and its hand fixes, and were not touched.

**The regulator's tracks are Raspberry Pi's pattern and were not redrawn.** Five of its legs are off 45 degrees and one is a 0.17 mm step, as `reg_pattern.py` has them; they lie inside the pattern's copper zones. A sixth leg was ours, not Raspberry Pi's: `centre.py` had moved the start of C23's ground track to its via 0.05 mm onto the pad centre, which tilted it 5 degrees. On the operator's ruling it is back as `reg_pattern.TRACKS` has it, level from (150.52, 115.0) to the via at (151.1, 115.0): it starts 0.05 mm below the pad's centre, on the ground track that runs through the pad, inside the pad and the pattern's ground zone, so the copper is the same. `reg_pattern.py` already held the straight version and was not changed; `verify_reg.py` does not compare tracks, and reads 0 differences before and after.

**Operator's rulings, 2026-11-16:** the two QSPI steps are accepted as `check45-exceptions.json` records them; the regulator's exemption in `check45.py` is accepted; C23's ground track is to be straight, as above.

For whoever reads the copper next:

- Where a pad's centre does not lie on a 45 degree line from its track, the track now ends in a short diagonal inside the pad or via copper instead of a slightly tilted last leg: 27 end legs under 0.2 mm, 21 before. Nine of them reach outside the pad or via they end in, as nine did before (not all the same nine: WGATE's on the back and USB D-'s at R26 are new, STEP's and WPROT's are gone).
- WGATE's via under U1's west side moved 0.075 mm down, not up onto pin 6's line: ACT_LED and then SWDIO lie above it on the back at their clearance, with nothing over. Pin 6's track ends in it by a 0.14 mm diagonal, inside the via's ring.
- BOOT_R on the back now crosses under U4 at y = 105.2 instead of going round by the top edge: 2.2 mm shorter, 0.18 mm clear of the QSD1 and QSD2 vias below U4's pads and 0.14 mm from the QCS via where it turns, behind both planes from the QSPI lines on top.
- TRK0_B, RDATA_B, INDEX_B, the end of MTR_B, and the buzzer's and D2's tracks on the left were drawn again whole; they are slow lines with room round them.
- Several tracks keep their clearance to a neighbour and no more (0.127 mm, as the autorouter packed them): CHNG along SEL0 into pins 78 and 79, RDY at RDATA's corner near x = 126, y = 148, SWCLK between RDATA and the BUZZER via (0.01 mm over).

Freerouting has a 45 degree mode: `(snap_angle fortyfive_degree)` in the DSN file's `structure` section (its `Structure` and `AngleRestriction` classes read it). It was not used here, because routing again would have lost the hand fixes; a rebuild from `variants.sh` should set it, and will still need `check45.py`, since `stitch.py` and `centre.py` make their own off-angle legs.

## Original drive connector, 2026-11-17

The operator's request (2026-11-17): "lets build rev c with the floppy connector on it - use the odd pins as detection mechanism. We need silkscreen to clear say "FROM MB", "EXT DRV" so people don't wire it wrong". Then: "yeah just extend the board slightly"; "I would like it to be automatic, so when a physical drive is present it just 'works', by becoming df0: as default, then df1, df2 is the wififloppy"; and "we dont want an option to switch the physical drive to df1, its not needed. We just need an option to turn it off, as it wasn't there".

### What is on the board

| Ref | Part | What it does |
|---|---|---|
| J5 | 2x17 keyed IDC header, same footprint as J1, silk **EXT DRV** | The original drive's ribbon. Every even pin is J1's, straight through, except pin 10 (the drive's select, gated below), pin 12 (SEL1, **not** passed on: the board is DF1 when the drive is fitted) and pins 4, 6, 14 (unconnected, as on J1). Odd pins are ground except **1 and 33** |
| J5 pins 1, 33 | presence sense, net DRV_DET_B | A floppy drive grounds its odd pins. R37 (10k) pulls the net to 3.3 V, so: drive on the ribbon, low; nothing plugged in, or a ribbon with no drive, high. R38 (1k) in series to U8 |
| U6, Q9, R35 | 74LVC1G02 NOR + BSS138, 1k pull-up to +5 V | J5 pin 10 is pulled low (drive selected) only while the Amiga's SEL0 is low **and** DRV_EN_N is low. U6's input is 5 V tolerant and reads SEL0_B straight from J1 pin 10 |
| R36 | 10k pull-up on DRV_EN_N | A board that is unpowered, in reset, in BOOTSEL or not yet flashed leaves the drive deselected (it then releases every line) |
| U8 | PCA9536 (VSSOP-8), I2C address 0x41, on the OLED/NFC bus | IO0 reads DRV_DET, IO1 drives DRV_EN_N. IO2 and IO3 unused |
| U7 | 74LVC1G97 wired as a 2:1 mux | Feeds U2's A0 (rev B: SEL0_B): SEL0_B while DRV_EN_N is high, **SEL2_B** while it is low. So with the drive on, the GPIO the firmware reads as SEL0 (GP2) carries SEL2 |
| J9, R39 | 2-pin header, silk **SEL2**, 1k pull-up to +5 V | SEL2 by a wire from the external DB23 port (pin 9). The A500's CN11 has no SEL2 (pin 14 is not connected, schematic p.8). Unwired, the pull-up keeps it deselected |
| J8 | 1x4 vertical header, silk **DRV PWR** | +5 V, GND, GND, NC for the drive's power, in parallel with J2, by a 0.6 mm track on the back from J2's +5 V |
| C32-C34 | 100 nF | U6, U7, U8 |

### Changes from the plan, and the operator's rulings (2026-11-18)

The plan was a free RP2350 GPIO each for the sense, the enable and SEL2, with SEL0 reaching U2 as on rev B. Two parts of that changed; the operator approved both on 2026-11-18 ("APPROVED both deviations").

- **Ruling 1, the PCA9536 for the sense and the enable (no new RP2350 GPIOs).** The plan was a GPIO each for the sense, the enable and SEL2. Every free U1 pad is boxed in: GPIO14-17 have TRK0's track 0.3 mm from their pad ends with WPROT, ACT_LED, WGATE and SWCLK running north-south on the back under them; GPIO20's escape via is shut in by the same back tracks; GPIO26-28 are behind the crystal's and WL_CS's copper; GPIO30-46 on the east and south sides could only be reached by tracks under the QFN body, 3 to 5 vias and about 60 mm each, across the board. So the sense and the enable go through U8 on the existing I2C bus (two tracks from J4 along the top edge).
- **Ruling 2, the SEL0/SEL2 mux in front of U2 (net SEL0M_B).** SEL0 no longer reaches U2's A0 directly: U7 passes SEL0_B while DRV_EN_N is high and SEL2_B while it is low. With no GPIO free for SEL2, this puts SEL2 on GP2 when the original drive is DF0, and the firmware needs no new PIO input: SEL0, SEL1, MTR and DIR stay the four consecutive GPIOs GP2-5. The cost: a dead U7 takes away the board's own select; with DRV_EN_N's pull-up a board in reset still hands U2 SEL0.
- **U6 reads SEL0_B (5 V side)**, not U2's 3.3 V output: the 74LVC1G02's inputs are 5 V tolerant, and J1 pin 10 is next to J5 while U2's output is across the board.
- **J8 and J9 are vertical headers on the outer edge**, not J2's horizontal footprint: a horizontal header needs its pins over a board edge, and the plugs must not sit between the two ribbon shrouds.
- **Refs:** J7 is the SWD connector, so the drive's power is J8 and SEL2 is J9.
- **Outline:** 74.55 x 56.1 mm (was 61.45 x 54.1), widened 13.1 mm to the left, and 2 mm taller at the top (operator, 2026-11-18: "make the board 2mm taller for bigger labels"); the antenna corner is unchanged. J5 stands 10.75 mm left of J1 (0.24 mm between the two shrouds' silk), and a 3.6 mm strip outside J5 holds the small parts, J8 and J9.
- **Off is the hardware default.** DRV_EN_N is pulled high: the drive is never selected unless the firmware asks for it.

### Layout

- **Outline** 74.55 x 56.1 mm, from 61.45 x 54.1: the left edge moved from x 101.05 to 87.9, and the top edge from y 100 to 98 (2026-11-18). The 45 degree cut by the USB connector runs on along its own line, so J6 still sits at its edge. The whole-board zones (GND on F.Cu, B.Cu and In1, +3.3 V on In2) moved with both. The antenna corner (bottom right) is unchanged.
- **J5** at x 95.25 (J1 at 106.0), rows level with J1's. Its 12 straight-through lines run on the back between the two headers, each at mid-row past J1's ground pins (0.218 mm over clearance each).
- **The strip** left of J5 (x 87.9 to 91.6) holds, top to bottom: U8, C34, R36, R37, R38 (on its side, to keep the courtyards apart), J9, R39, U7, C33, U6, C32, Q9, R35, J8. Everything is 0402 or SOT-23 and on the top.
- **Long runs:** OLED_SCL and OLED_SDA leave U8 along the top edge on F.Cu, above both headers, to J4 pins 3 and 4; SEL0_B leaves J1 pin 10 west in row 5's gap; SEL0M_B crosses both headers in row 7's gap on F.Cu and reaches U2 pin 2 over both layers (3 vias); DRV_SEL_B reaches J5 pin 10 on the back between J5's two rows; DRV_DET_B runs from J5 pin 1 diagonally into the strip, and down the back beside J5's odd row to pin 33; +5V comes from J2's via on the back along the bottom edge (0.6 mm) and up the strip at 0.25 mm.
- **Copper:** 140 more segments and 35 more vias (959 and 203 on the board, from 819 and 168; 957 segments after the 2026-11-18 edge fix). The SEL0_B run from R8 to U2 pin 2 (4 segments) is the only copper of the old board taken out. The OLED tracks between J4 and J3 are untouched.
- **Close to the edge:** fixed 2026-11-18. DRV_EN_N ran 0.295 mm from the left edge beside R37. R37's +3.3 V via moved 0.15 mm east, next to its own pad, and DRV_EN_N now runs straight down with its centre 0.48 mm in from the edge (0.405 mm from copper to edge) from R36 to U7 pin 6, 0.145 mm from R38's pad; check45 still passes. U8's ground via is 0.3 mm from the edge.
- **Checks after the change:** `check45.py` passes (the same 2 accepted steps and the regulator's 10), DRC 0 errors / 0 unconnected / 0 parity, ERC 0, `verify_sch.py` 82 of 82 nets, `verify_pins.py` 210 of 210, `verify_reg.py` 0 differences, `pnpm hw:verify rev-c` passes.
- **Silkscreen:** top, in the 3.4 mm above the two shrouds: "EXT DRV" and "FROM MB", 1.6 mm high (1.4 mm wide, 0.25 mm stroke), one over each shroud. Each header is 11 mm wide, so the names alone fit at that size and the references J5/J1 moved to the back labels. J5 has the same pin-1 triangle as J1. Beside the strip: "SEL2" at J9, "J8 DRV PWR" at J8 (0.8 mm). Back: "J5 EXT DRV" and "J1 FROM MB" at 1.5 mm between the two headers, and "J9: SEL2 from EXT port". The small parts' references are hidden, like the other new parts'.
- **Buzzer is off the board (operator, 2026-11-18):** BZ1 is now a 2-pin 2.54 mm header (pin 1 +, marked "+"; pin 2 to the switching FET) in place of the 12 mm PS1240, so any buzzer can sit on Dupont wires. It stands on the old part's right-hand pads; a via joins the + track where the old part's left pad was. **Hand-fitted:** J1, J5 and BZ1 are excluded from the BOM and the position file (not DNP, so they still show in the 3D view), so JLC does not place them.

### Owed in firmware (operator's spec, 2026-11-17)

One setting, **Original drive: Auto (default) / Off**.

- **Auto:** at power-on, read DRV_DET through U8 (I2C 0x41, IO0) **before Kickstart's drive-ID read** (so before `bus_out_init` asserts anything). Low: the board stops answering SEL0 (all six outputs released, write capture off), then sets IO1 (DRV_EN_N) low. From then on: the original drive is **DF0**; **GP3 = SEL1 = DF1** (the board's first drive); **GP2 = SEL2 = DF2** (the board's second drive, through U7) if J9 is wired, and never selected if it is not (R39 holds SEL2 high), in which case DF1 can be PaulaNET as today. No drive: today's behaviour, board DF0 + DF1, DRV_EN_N stays high.
- **Off:** DRV_EN_N stays high; the drive is never selected and releases every line; the board is DF0 + DF1 exactly as with no drive.
- **A change while running** (a drive plugged or unplugged, or the setting changed): the study's handover rules (docs/superpowers/research/2026-09-28-df0-passthrough.md §3a) apply: an eject/insert handshake on CHNG, never while a motor is latched on or WGATE is active, and never answer SEL0 while DRV_DET is low and the drive is enabled.
- **Web app:** show the original drive as DF0 and renumber the board's drives (`drive_base` already exists on the server).
- The firmware must treat a missing or silent U8 (I2C error) as "no drive" and leave DRV_EN_N alone.

### Owed on the bench

- That the operator's drives ground pins 1 and 33 (continuity from each to the drive's ground), and that a bare ribbon reads high.
- SEL2 from the DB23 port on a real A500, with the board as DF2.
- VOL on the shared lines with the board and a drive both on the bus (the study's measurement 2).

## Parts

From Pimoroni's Pico Plus 2 W schematic unless noted.

| Ref | Part | Note |
|---|---|---|
| U1 | RP2350B, QFN-80 | |
| U3 | W25Q128JVSIQ, SOIC-8 208 mil | Pimoroni's schematic names W25Q128JVPIQ: same family and capacity, check the package suffix when buying |
| U4 | IS66WVS16M8FBLL-104NLI, SOIC-8 150 mil | **16 MB, not Pimoroni's 8 MB.** APS6404L-3SQR is pin-compatible and fits the same pads |
| M1 | Raspberry Pi RM2 | Own antenna. Hand-made footprint from RM2 datasheet figure 6 |
| U5 | NCP1117ST33T3G, SOT-223 | **Not Pimoroni's AP7366** (the 2026-10-20 rev C note's part, easier to solder and cool) |
| L1 | Abracon AOTA-B201610S3R3-101-T | Raspberry Pi's polarity-marked inductor, LCSC C42411119. **Not Pimoroni's MLZ2012M3R3HT000**: see "Core regulator" |
| Y1 | Abracon ABM8-272-T3, 15 pF load caps | Raspberry Pi's crystal, LCSC C20625731; JLC's RP2350B page names the same one |

Left out as nothing here uses them: the VSYS sense divider and its MOSFET, the 1k links from GP26-28 to GP40-42, the user switch, the Qw/ST connector (its GP4/GP5 are MTR and DIR here; operator confirmed 2026-11-05), the 40-pin header.

The reset button is out (operator, 2026-11-05: BOOTSEL is needed, PIM726's RESET is not). Test pad TP1 on RUN replaces it; RUN keeps its internal pull-up (RP2350 pin table), as on Pimoroni's sheet.

**Scope (operator, 2026-11-05): everything stays as it is with a PIM726.** So the Amiga RESET line and keyed I2C connectors from the earlier rev C plan are not on this board. The original-drive connector came back on 2026-11-17 (operator's request), as J5 EXT DRV with its own select gate: see "Original drive connector". Firmware does not use what is left out: GP26-28, GP43 and GP45 appear in comments only.

## Schematic

`rev-c.kicad_sch` is rev B's sheet with the module out. `mcu.kicad_sch` (RP2350B, supplies, crystal, RM2) and `support.kicad_sch` (USB-C, 3.3 V, flash, PSRAM, BOOTSEL, debug) hold the module's parts, after Pimoroni's sheets. `rev-c-schematic.pdf` is the print. All new symbols are in `rev-c-lib.kicad_sym`; apart from RM2 (drawn from RM2 table 2) and the PSRAM (KiCad's APS6404L with ISSI's value) they are KiCad's own.

The sheets are the source: edit them in KiCad. `build_board.py` reads their netlist for names, values, footprints and links, which is why parity is clean. Swapping MTR and DIR, or removing a PWR_FLAG and a no-connect, in a copy made `verify_sch.py` fail, as it should.

Differences from Pimoroni: the core regulator and crystal (below), NCP1117 with 10 uF either side (AP7366, 2.2 uF; the 2026-10-20 note's part), 16 MB PSRAM, 10 uF added at RM2's VDDBAT, BOOTSEL as 1k and switch without their diode and user-switch network. Pull-ups (flash CS 3k3, PSRAM CS 100k) and the USB series resistors (27.4 ohm) are Pimoroni's.

## Core regulator

Operator's decision, 2026-11-05: Raspberry Pi's pattern, an exception to "same as a PIM726". `reg_pattern.py` holds it, taken from Raspberry Pi's RP2350 minimal design R4 (MIT, see `../NOTICE.md`) and datasheet section 6.3.8; `verify_reg.py` checks the board and sheets against it. The VREG pins have the same order and pitch on our QFN-80 as on the QFN-60 it was drawn for.

| | Pimoroni's sheet, and rev C before | Now | Datasheet |
|---|---|---|---|
| L1 | MLZ2012M3R3HT000, about 350 mA, 260 mOhm max, unmarked | AOTA-B201610S3R3-101-T, 2.4 A, 140 mOhm max, marked | at least 1.5 A, at most 250 mOhm, polarity-marked |
| COUT, C23 | 10 uF | 4.7 uF | 4.7 uF +/-20% |
| CIN, C21 | 10 uF | 4.7 uF | at least 4.7 uF |
| RFILT, CFILT (R20, C22) | 27.4 ohm, 2.2 uF | 33 ohm, 4.7 uF | Raspberry Pi's design |
| Second COUT, C15 at DVDD pin 32 | 100 nF | 4.7 uF | recommended |

LX is 4.0 mm on the top layer with no vias. In1 is cut away under L1 and LX (figure 24). The top pour stays out, so the regulator's high-current ground meets the rest at two vias, and CFILT has its own via. VREG_FB comes from COUT, and COUT reaches the DVDD ring by a 0.6 mm track on the back, as Raspberry Pi route it. Moving one of these parts means moving them all.

**L1 has a right way round.** Pad 1, the dot, goes to DVDD: the symbol was flipped so its pin 1 is DVDD. RPROM's README warns that JLC's placement file needed L1's orientation fixing by hand: check it on the assembly preview.

The pattern is copied, not proven here: Raspberry Pi test it on their board, and no rev C board has been built. CIN and COUT need low ESR (50 and 250 mOhm); Raspberry Pi use GRM155R60J475ME47D for all three 4.7 uF parts.

## RM2 antenna

The module sits in the bottom right corner with its antenna on the board edge. Of Raspberry Pi's 35.5 x 18.5 mm keep-out, only 26 x 5 mm is on the board; the rest is air. It is a rule area on all layers, about where rev B's was. In a case, what is beyond the edge also counts.

## 16 MB PSRAM: what is and is not known

The operator confirms the RP2350B supports 16 MB of PSRAM (2026-11-05). What follows is what was checked here.

From the ISSI datasheet and `hardware_psram/psram.c`: same pinout and commands as the APS6404 (35h, EBh with 6 wait cycles, 38h), 2.7-3.6 V, 1024-byte pages. The pico-sdk's size detection names ISSI's 16 MiB ID, and it breaks bursts at 1024 bytes, so a burst cannot cross the part's two stacked dies (its datasheet forbids that). **None of it has run on hardware.** Firmware needs `PICO_PSRAM_SIZE_BYTES` and `SLOT_COUNT` raised to use more than 8 MB.

## Owed before a fab order

0. **The original-drive connector** (2026-11-17): its firmware mode and bench checks, listed in "Original drive connector". The strip's parts and copper are generated and hand-placed like the rest; nobody has read them.
1. **A person reading the schematic.** Nobody has yet.
2. **A person checking the core regulator against datasheet figures 23 and 24**, and the crystal: Y1's placement and tracks are still autorouted, its part and caps are now Raspberry Pi's.
3. **A person reading the autorouted copper:** QSPI lengths, the USB pair (12 Mbit/s, so no impedance control needed, but keep it short), the floppy lines. It has too many vias. The 2026-11-11 review fixed its nine findings as far as the table above says (QCS and SD1's length to the flash are the leftovers); the copper it did not touch is still autorouted.
   LIV2 read it on 2026-11-08: tracks joined pads off-centre (the mask opening is 0.05 mm larger than the pad, so the copper beside it lies bare and invites bridges), U5 is in the way of U1's left-side signals, and the autorouter's copper is untidy generally. `centre.py` fixed 106 of the joins on this board, with DRC unchanged and the regulator untouched; 22 signal joins would come too close to other copper and need a person (it lists them), and 28 power stubs end on a via inside an SMD pad (via-in-pad, a solder-wicking risk). Moving U5, C29 and C30 4 mm down took 22% of the bottom-layer copper out of that corner (309 to 241 mm) and 6 vias, but Freerouting then leaves 5 connections unrouted, and this pipeline also leaves 4 unrouted without the move, so the move is not on this board yet.
4. **Footprints against samples:** RM2, USB-C, buttons.
5. **Board-edge clearances:** SW1 moved in 0.3 mm, now about 0.55 mm. M1 at the edge is intended.
6. **Sourcing:** not checked. The JLC search was down; JLCONE not used.
7. **Heat:** 5 V to 3.3 V at Wi-Fi peaks is about 0.7 W in U5. Measure it.

## Rebuild

In order, with KiCad's Python and Freerouting 2.5.0: `variants.sh` runs `build_board.py` (places), `regulator.py` (the regulator's copper), `stitch.py` (joins power pins to the planes), Freerouting on the outer layers, and `route.py` (adds the planes and pours), into `v1/`. Then by hand: `clean.py v1/rev-c.kicad_pcb v1/drc1.json` removes the router's stray vias and widens any neck below 0.09 mm, `finish.py` adds fiducials and sets the silkscreen, `centre.py v1/rev-c.kicad_pcb` brings tracks onto their pads' centres, `verify_pins.py` checks. The fiducials landed at free spots, not in the corners: place them properly in KiCad. Part references on the new parts are hidden until someone places them.

**Since 2026-11-11 the board file is the source for the copper.** The review's fixes and the 2026-11-16 routing-rule pass were made on `rev-c.kicad_pcb` itself; the steps above would rebuild the board without them, and with `stitch.py`'s and `centre.py`'s off-angle legs. `rules.py` still holds the net classes. `check45.py rev-c.kicad_pcb` belongs with DRC after any change to the copper.

`package.sh` builds `rev-c-kicad-project.zip`: the project with `wifi-floppy-lib` copied in and the library tables pointed at the copies, so it opens anywhere with KiCad 10. Rebuild it after any change.
