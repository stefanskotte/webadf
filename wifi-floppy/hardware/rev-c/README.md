# Rev C: on-board RP2350, schematic and routed board

Rev B with the PIM726 module replaced by its parts on our PCB: RP2350B, 16 MB flash, 16 MB PSRAM, RM2 radio, crystal, core regulator, USB-C, BOOTSEL, SWD. Every GPIO stays where the PIM726 has it, so the firmware's pin map and the pico-sdk board definition are unchanged. Same outline as rev B. Rev B's files are untouched.

**The schematic and the routed board agree, and nothing else about the board differs from using a PIM726 on rev B. It is still not a board to order:** see "Owed before a fab order".

## Result (2026-11-05)

| Check | Result |
|---|---|
| Layers | 4: signals on F.Cu and B.Cu, GND on In1, +3.3 V on In2 |
| KiCad DRC, with schematic parity | 0 unconnected, 0 errors, 0 parity differences. 24 silkscreen warnings, 21 of them M1's outline over its own pads, and one 0.03 mm neck somewhere in the top ground pour, not located |
| ERC | 0 errors, 0 warnings |
| `verify_sch.py` | all 75 multi-pin nets match, whatever they are called |
| `verify_pins.py rev-c.kicad_pcb` | 209 of 209 against the RP2350 datasheet, firmware `board.c`, the pico-sdk header, the RM2 datasheet, and rev B's connected pads |
| `verify_reg.py` | the regulator matches Raspberry Pi's pattern: 62 differences before, 0 now |
| `pnpm hw:verify rev-c` | passes: ERC, DRC, firmware pins, J1 lines, 1k pull-ups, the regulator |
| Gerbers | analysed with kicad-happy. Not yet through JLC's own check |
| Tracks | 0.15 mm, necked as low as 0.09 mm at the QFN, vias 0.45/0.2 mm, spacing 0.127 mm: within JLC's published 4-layer limits, not confirmed by JLC |

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
3. **A person reading the autorouted copper:** QSPI lengths, the USB pair (12 Mbit/s, so no impedance control needed, but keep it short), the floppy lines. It has too many vias.
4. **Footprints against samples:** RM2, USB-C, buttons.
5. **Board-edge clearances:** SW1 moved in 0.3 mm, now about 0.55 mm. M1 at the edge is intended.
6. **Sourcing:** not checked. The JLC search was down; JLCONE not used.
7. **Heat:** 5 V to 3.3 V at Wi-Fi peaks is about 0.7 W in U5. Measure it.

## Rebuild

In order, with KiCad's Python and Freerouting 2.5.0: `variants.sh` runs `build_board.py` (places), `regulator.py` (the regulator's copper), `stitch.py` (joins power pins to the planes), Freerouting on the outer layers, and `route.py` (adds the planes and pours), into `v1/`. Then by hand: `clean.py v1/rev-c.kicad_pcb v1/drc1.json` removes the router's stray vias and widens any neck below 0.09 mm, `finish.py` adds fiducials and sets the silkscreen, `verify_pins.py` checks. The fiducials landed at free spots, not in the corners: place them properly in KiCad. Part references on the new parts are hidden until someone places them.

`package.sh` builds `rev-c-kicad-project.zip`: the project with `wifi-floppy-lib` copied in and the library tables pointed at the copies, so it opens anywhere with KiCad 10. Rebuild it after any change.
