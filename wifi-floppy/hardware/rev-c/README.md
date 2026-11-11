# Rev C: on-board RP2350, schematic and routed board

Rev B with the PIM726 module replaced by its parts on our PCB: RP2350B, 16 MB flash, 16 MB PSRAM, RM2 radio, crystal, core regulator, USB-C, BOOTSEL, SWD. Every GPIO stays where the PIM726 has it, so the firmware's pin map and the pico-sdk board definition are unchanged. Same outline as rev B. Rev B's files are untouched.

**The schematic and the routed board agree, and nothing else about the board differs from using a PIM726 on rev B. It is still not a board to order:** see "Owed before a fab order".

## Result (2026-11-05, copper revised 2026-11-11)

| Check | Result |
|---|---|
| Layers | 4: signals on F.Cu and B.Cu, GND on In1, +3.3 V on In2 |
| KiCad DRC, with schematic parity | 0 unconnected, 0 errors, 0 parity differences. 24 silkscreen warnings, 21 of them M1's outline over its own pads, and one 0.03 mm neck somewhere in the top ground pour, not located |
| ERC | 0 errors, 0 warnings |
| `verify_sch.py` | all 75 multi-pin nets match, whatever they are called |
| `verify_pins.py rev-c.kicad_pcb` | 209 of 209 against the RP2350 datasheet, firmware `board.c`, the pico-sdk header, the RM2 datasheet, and rev B's connected pads |
| `verify_reg.py` | the regulator matches Raspberry Pi's pattern: 62 differences before, 0 now |
| `pnpm hw:verify rev-c` | passes: ERC, DRC, firmware pins, J1 lines, 1k pull-ups, the regulator |
| Gerbers | regenerated 2026-11-11 after the placement changes below, same 14 files and export settings (they reproduce the earlier sets from their boards); 233 holes for 168 vias and 65 drilled pads. The 2026-11-08 set was analysed with kicad-happy, this one was not. Not yet through JLC's own check |
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

**Scope (operator, 2026-11-05): everything stays as it is with a PIM726.** So the J5 DRIVE passthrough, Amiga RESET line and keyed I2C connectors from the earlier rev C plan are not on this board. Firmware does not use what is left out: GP26-28, GP43 and GP45 appear in comments only.

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

**Since 2026-11-11 the board file is the source for the copper.** The review's fixes were made on `rev-c.kicad_pcb` itself; the steps above would rebuild the board without them. `rules.py` still holds the net classes.

`package.sh` builds `rev-c-kicad-project.zip`: the project with `wifi-floppy-lib` copied in and the library tables pointed at the copies, so it opens anywhere with KiCad 10. Rebuild it after any change.
