# Rev C: on-board RP2350, routing proof and schematic draft

Rev B with the PIM726 module replaced by its parts on our PCB: RP2350B, 16 MB flash, 16 MB PSRAM, RM2 radio, crystal, core regulator, USB-C, BOOTSEL, SWD. Every GPIO stays where the PIM726 has it, so the firmware's pin map and the pico-sdk board definition are unchanged. Same outline as rev B. Rev B's files are untouched.

**This proves it routes, and a first schematic matches it. It is not a board to order:** see "Owed before a fab order".

## Result (2026-11-05)

| Check | Result |
|---|---|
| Layers | 4: signals on F.Cu and B.Cu, GND on In1, +3.3 V on In2 |
| KiCad DRC | 0 unconnected, 0 errors. Warnings are silkscreen and library-version only |
| `verify_pins.py` | 213 of 213 against the RP2350 datasheet, firmware `board.c`, the pico-sdk header, the RM2 datasheet, and all 126 rev B pads |
| Gerbers | complete and aligned (kicad-happy analyzer). Not yet through JLC's own check |
| Tracks | 0.15 mm, necked to 0.11 mm at the QFN, vias 0.45/0.2 mm, spacing 0.127 mm: JLC's 4-layer process |

## Parts

From Pimoroni's Pico Plus 2 W schematic unless noted.

| Ref | Part | Note |
|---|---|---|
| U1 | RP2350B, QFN-80 | |
| U3 | W25Q128JVSIQ, SOIC-8 208 mil | Pimoroni's schematic names W25Q128JVPIQ: same family and capacity, check the package suffix when buying |
| U4 | IS66WVS16M8FBLL-104NLI, SOIC-8 150 mil | **16 MB, not Pimoroni's 8 MB.** APS6404L-3SQR is pin-compatible and fits the same pads |
| M1 | Raspberry Pi RM2 | Own antenna. Hand-made footprint from RM2 datasheet figure 6 |
| U5 | NCP1117ST33T3G, SOT-223 | **Not Pimoroni's AP7366** (the 2026-10-20 rev C note's part, easier to solder and cool) |
| L1 | MLZ2012M3R3HT000 | Pimoroni's, not the Abracon part in Raspberry Pi's design |

Left out as nothing here uses them: the VSYS sense divider and its MOSFET, the 1k links from GP26-28 to GP40-42, the user switch, the Qw/ST connector (its GP4/GP5 are MTR and DIR here; operator confirmed 2026-11-05), the 40-pin header.

The reset button is out (operator, 2026-11-05: BOOTSEL is needed, reset is not). The schematic has test pad TP1 on RUN instead; **the board still has SW2 and no TP1** until the next placement.

Not added yet, though decided for rev C: J5 DRIVE passthrough, the Amiga RESET line, keyed I2C connectors.

## Schematic (first draft, 2026-11-05)

`rev-c.kicad_sch` is rev B's sheet with the module out. `mcu.kicad_sch` (RP2350B, supplies, crystal, RM2) and `support.kicad_sch` (USB-C, 3.3 V, flash, PSRAM, BOOTSEL, debug) hold the module's parts, after Pimoroni's sheets. `rev-c-schematic.pdf` is the print. All new symbols are in `rev-c-lib.kicad_sym`; apart from RM2 (drawn from RM2 table 2) and the PSRAM (KiCad's APS6404L with ISSI's value) they are KiCad's own.

Check: `verify_sch.py`, with KiCad's Python. ERC 0 errors, 0 warnings. All 74 multi-pin nets match `rev-c.kicad_pcb`, leaving out SW2 and TP1. Swapping MTR and DIR, or removing a PWR_FLAG and a no-connect, in a copy made it fail. The schematic's U1 pins are chosen by KiCad's pin names, the board's by the datasheet table, so this is two sources agreeing, not one copied.

Values differing from Pimoroni, all carried over from the board: NCP1117 with 10 uF either side (AP7366, 2.2 uF); flash CS pull-up 10k (3k3); PSRAM CS pull-up 10k (100k); 10 uF added at RM2's VDDBAT; 27 ohm for 27.4 ohm; BOOTSEL as 1k and switch only, without Pimoroni's diode and user-switch network.

`draw_schematic.py` made the first draft and overwrites all three sheets: from here on edit in KiCad, not through it.

## RM2 antenna

The module sits in the bottom right corner with its antenna on the board edge. Of Raspberry Pi's 35.5 x 18.5 mm keep-out, only 26 x 5 mm is on the board; the rest is air. It is a rule area on all layers, about where rev B's was. In a case, what is beyond the edge also counts.

## 16 MB PSRAM: what is and is not known

From the ISSI datasheet and `hardware_psram/psram.c`: same pinout and commands as the APS6404 (35h, EBh with 6 wait cycles, 38h), 2.7-3.6 V, 1024-byte pages. The pico-sdk's size detection names ISSI's 16 MiB ID, and it breaks bursts at 1024 bytes, so a burst cannot cross the part's two stacked dies (its datasheet forbids that). **None of it has run on hardware.** Firmware needs `PICO_PSRAM_SIZE_BYTES` and `SLOT_COUNT` raised to use more than 8 MB.

## Owed before a fab order

1. **The schematic finished and the board made from it.** A person must read the draft. Then update the PCB from it in KiCad (the board is still `build_board.py`'s, without schematic links), drop SW2, add TP1, and point `pnpm hw:verify` at rev C: it still checks rev B's module pins. This repo's rule is to edit the board in KiCad, not generate it, and the first generated board came back mirrored.
2. **The core regulator and crystal by hand.** Raspberry Pi say a regulator layout other than theirs is at your own risk. Here L1 and the capacitors are placed close but autorouted. Copy their layout.
3. **A person reading the autorouted copper:** QSPI lengths, the USB pair (12 Mbit/s, so no impedance control needed, but keep it short), the floppy lines. It has too many vias.
4. **Footprints against samples:** RM2, USB-C, buttons.
5. **Board-edge clearances:** SW1, SW2 at 0.25 mm. M1 at the edge is intended.
6. **Sourcing:** not checked. The JLC search was down; JLCONE not used.
7. **Heat:** 5 V to 3.3 V at Wi-Fi peaks is about 0.7 W in U5. Measure it.

## Rebuild

In order, with KiCad's Python and Freerouting 2.5.0: `variants.sh` runs `build_board.py` (places), `stitch.py` (joins power pins to the planes), Freerouting on the outer layers, and `route.py` (adds the planes and pours), into `v1/`. Then by hand: `clean.py v1/rev-c.kicad_pcb v1/drc1.json` removes the router's stray vias, `finish.py` adds fiducials, `verify_pins.py` checks. The fiducials landed at free spots, not in the corners: place them properly in KiCad.
