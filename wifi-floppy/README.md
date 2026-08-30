# WiFi Floppy Emulator (Amiga) — Pico 2 W

Gotek-style drive replacement that streams pre-encoded MFM tracks over
WiFi from your ADF webservice instead of reading a USB stick.

## Contents
- `hardware/schematic.svg` — full schematic (net names match the PCB)
- `hardware/wifi_floppy.kicad_pcb` — placed **and routed** 2-layer board,
  45°-only corners, B.Cu ground pour. Open directly in KiCad 7/8 and
  press `B` to refill the zone.
- `hardware/generate_pcb.py` — the generator that produced the board,
  including a DRC-lite checker (crossings, clearance ≥0.15 mm, 45° rule).
  Currently passes with 0 violations.
- `firmware/` — pico-sdk project (RP2350 / `PICO_BOARD=pimoroni_pico_plus2_w_rp2350`,
  pico-sdk >= 2.3.0 required — see "Firmware build requirements" below).

## Design
- **J1** 34-pin, Amiga internal pinout: pin 2 = /DSKCHG, pin 34 = /RDY
  (unlike PC drives where 34 is DSKCHG).
- **U2 74LVC541A** buffers all host-driven lines into the Pico
  (3.3 V part, 5 V-tolerant inputs). J1→A1..A8→GP2..GP9 are mapped in
  physical order, so the input routing is completely crossing-free.
- **Q1–Q6 BSS138** give open-drain outputs. They invert: **GPIO high =
  bus line pulled low**. Firmware and the PIO program already account
  for this (`OUT_ASSERT`).
- **Power**: 5 V from the Berg connector through D1 (SS14) into VSYS.
  Safe to co-power over USB while bench testing.
- PIO `flux_out` emits 2 µs bitcells (8 PIO cycles @ 4 MHz, clkdiv 37.5
  from 150 MHz), 750 ns read pulses; DMA restarts per revolution and
  raises a ~2 ms INDEX pulse at the wrap → exactly 300 rpm timing.
- 16-track LRU cache (~205 KB) + neighbour prefetch; a track is ~12.7 KB
  so a LAN fetch lands well inside a seek's settle time.

## Track server protocol
```
GET /tracks/<n>        n = cyl*2 + side  (0..159)
 -> 200, body = [u32 LE bit_count][raw MFM bytes]
POST /tracks/<n>       (write-back, not implemented yet)
```
Encode server-side (ADF → Amiga MFM incl. 0x4489 syncs, odd/even split);
the firmware just plays bits. Suggested next step for the webservice.

## DSKCHG / RDY
`src/dskchg.c` re-implements FlashFloppy's Amiga-interface behaviour
(chgrst=step semantics, motor-edge drive-ID shifter, spin-up delay).
It's a from-scratch implementation of the observable behaviour, not a
code port — if you later paste actual FlashFloppy code in, note its
licensing and credit Keir Fraser.

## Firmware build requirements

- **pico-sdk >= 2.3.0.** `hardware_psram` (and this board's
  `PICO_PSRAM_CS_PIN`/`PICO_PSRAM_SIZE_BYTES` board-header support) landed in
  pico-sdk PR #2919, after the 2.2.0 release; 2.3.0 is the first tag that has
  it. `CMakeLists.txt` checks `PICO_SDK_VERSION_STRING` and fails the
  configure step with an explanation if `PICO_SDK_PATH` points at anything
  older.
- **`brew install arm-none-eabi-gcc` is not sufficient** — that formula ships
  GCC and libgcc but no newlib, so linking fails with `cannot find -lg`/`-lc`
  on the very first target. Use the official ARM GNU Toolchain instead (the
  `gcc-arm-embedded` cask, or the equivalent tarball from
  developer.arm.com/downloads/-/arm-gnu-toolchain-downloads) and make sure
  its `bin/` is on `PATH` ahead of any homebrew `arm-none-eabi-*` shims.

## Honest caveats
- **Firmware is untested and has not been compiled here** — no pico-sdk
  toolchain in this environment. Expect minor compile fixes (headers,
  SDK API drift). The PIO cycle counts and DMA scheme are desk-checked.
- Write support is a skeleton: flux capture PIO exists, MFM decode and
  POST are TODO. WPROT is asserted by default until that lands.
- The board passes my generator's DRC-lite, but run real KiCad DRC and
  sanity-check footprints (Pico row spacing 17.78 mm, SOIC-20W, SOT-23)
  against your parts before ordering.
- No mounting holes; outline is a plain 96×62 mm rectangle. Reshape to
  3.5"-drive dimensions if you want it inside a Gotek/drive bay.
- Board is 2-layer; several signals ride the B.Cu plane, which slices
  the pour locally. Fine at 500 kHz MFM rates, but keep the pour filled.

## PSRAM revision (Pimoroni Pico Plus 2 W)

U1 is now specified as a **Pimoroni Pico Plus 2 W** (RP2350B, 16MB flash,
8MB PSRAM, RM2 radio). It keeps the Pico footprint and pinout, so the rev A
PCB is unchanged electrically - only the module value differs.

PSRAM is the disk. The image is pulled in **one bulk transfer at mount**
(`image_loader.c`) and the floppy bus is served entirely from RAM after
that - the read path contains no network call at all.

| where | size | role |
|-------|------|------|
| SRAM double buffer | ~26 KB | only DMA source for the flux PIO |
| PSRAM disk image | 2.03 MB | the whole disk, 160 x 13 KB slots |

`GET /image/<id>` returns:

    u32 magic 'WFMF'   u32 version=1   u32 track_count   u32 reserved
    per track: u32 bit_count, ceil(bits/8) bytes, padded to 4 bytes

RDY and CHNG stay deasserted until the whole image is in PSRAM, so a slow or
failed load looks like "no disk yet" to the Amiga rather than a drive that
stalls mid-track. A track missing from PSRAM is a fault, not a cache miss:
`track_cache_get()` returns NULL and nothing is streamed.

The loader parses the blob incrementally as TCP chunks arrive, writing
straight into PSRAM (a 2 MB image never fits in SRAM). It was tested on the
host against randomly-chunked input at real track sizes, plus malformed
input: oversized tracks and bad magic are rejected without overflowing a slot.

Notes / still to verify on hardware:

* **GP0/GP1 are the board's default UART pins** and carry INDEX and CHNG here.
  `pico_enable_stdio_uart(... 0)` is set; stdio goes out over USB. Do not
  re-enable UART stdio or it will drive the floppy bus.
* The flux DMA never reads PSRAM directly - a QMI cache miss contending with
  XIP can add latency at a 2 us bitcell. Tracks are copied PSRAM -> SRAM.
* **Antenna keepout position is still the CYW43 assumption.** The Plus 2 W
  uses the RM2 module; confirm where its antenna actually sits before fab and
  move the keepout rectangle in `generate_pcb.py` (KEEPOUT) if it differs.
* Confirm GP0-GP17 map to the same physical castellations on the RP2350B
  board as on the Pico 2 W before ordering.
* Write-back path is still a skeleton: PSRAM now has TRK_DIRTY state and
  `psram_image_next_dirty()` for a flush walker, but nothing calls it yet.

## J1 floppy header - construction

J1 is a **male 2x17 through-hole pin header on 2.54 mm pitch** (both axes),
which is what a standard 34-way floppy ribbon with female IDC sockets on each
end plugs onto - same as a real 3.5" drive or a Gotek.

* Numbering is standard IDC dual-row: pin 1 and 2 adjacent across the rows,
  odd pins down one column, even down the other.
* All odd pins (1..33) are GND, matching the ribbon's alternating ground
  returns. Signals are on the even pins.
* Pin 1 now has a **square pad**, plus a silkscreen body outline and a
  chevron marker outside pin 1, so the red stripe end is unambiguous.
* Pads 1.7 mm with 1.0 mm drill - correct for the usual 0.64 mm square posts.

**Shrouded header is not a drop-in.** A keyed 2x17 IDC box header has a
10.16 mm body, which overhangs the FET drain pads by ~1.35 mm. To fit one,
the Q1-Q6 column must move about 2 mm east, which also pushes the input
routing channels. The plain header is what most drives use, so rev A keeps
it; polarity relies on the pin-1 markings and the cable's red stripe.
