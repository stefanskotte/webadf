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

## Track server protocol — SUPERSEDED

**This section describes a protocol the firmware no longer speaks.** `http_fetch.c`,
which implemented `GET /tracks/<n>`, was deleted in plan 4a. The real device contract is
`GET /api/device/poll` (long-poll for desired state), `GET /api/device/image/<sha256>`
(the whole disk as a `WFMF` container, format defined in `image_loader.c`), and
`POST /api/device/status`. See `INTEGRATION.md` and
`docs/superpowers/specs/2026-08-29-device-plane-disk-change-design.md` §10 for the actual
contract. Kept below only as a historical note; do not implement against it.

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
- **`PORTAL_AP_PASSWORD` must be set in the environment (plan 4b).** It becomes the WPA2
  PSK for the provisioning access point (see "Provisioning a board" below); CMake's
  configure step fails on purpose if it is unset or empty, because an invalid WPA2 PSK
  cannot be reported back to a console-less board at runtime. The full build command:

  ```bash
  export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
  export PORTAL_AP_PASSWORD=<your AP password>
  pnpm firmware:build
  ```

## Provisioning a board (plan 4b)

**Steps 1-3 are verified on hardware as of 2026-09-10; steps 4-5 are not.** The AP
comes up, iOS raises the sign-in sheet on its own, and the form renders at
192.168.4.1. Everything from pressing Save onwards — teardown, association,
registration — has still only ever run against the host suite. See "Honest caveats"
below.

A board with no WiFi credentials stored in flash — or one that has just failed to associate
three times in a row — raises its own WPA2 access point named `wifi-floppy-XXXX`, where
`XXXX` is the last two octets of the board's MAC address (so several boards on a bench stay
distinguishable). To provision it:

1. **Mint a pairing code in webadf.** From the web app, generate a device pairing code for
   the board (single-use, 10-minute TTL — if it expires before step 4, generate a new one).
2. **Join `wifi-floppy-XXXX`** from your phone or laptop, using the WPA2 password baked into
   that board's firmware image at build time (`PORTAL_AP_PASSWORD`, above — whoever built
   the firmware knows it).
3. **Open any page** in a browser on that device. The board's DNS responder answers every
   query with its own address and the HTTP server redirects every path to `/`, so a phone's
   captive-portal probe should bring the config form up on its own; if it does not, browse to
   `http://192.168.4.1/` directly.
4. **Enter three fields**: your real WiFi network's SSID, its password, and the pairing code
   from step 1. Submitting does not commit anything yet — the board drops its own AP,
   attempts to associate with what you typed, and only writes the credentials to flash on
   success. Your phone will briefly lose the `wifi-floppy-XXXX` network while this happens.
5. **On success**, the board joins your real network and proceeds to register with webadf
   using the pairing code; the AP does not come back. **On failure** (wrong password, or the
   network was not found — the form distinguishes the two), the AP returns with the reason
   and the form is ready to try again; re-enter all three fields, since none are echoed back.

**Recovery without reflashing.** If webadf later reports the board's token as revoked or the
device row is deleted, the board erases its stored token and returns to step 1 automatically
— generate a fresh pairing code and repeat steps 2–5. The same is true of a rejected
(expired or already-used) pairing code: the board returns to the portal rather than retrying
the dead code forever.

## Honest caveats
- **First run on real hardware: 2026-09-10.** A rev A2 board, partially populated
  (J1, J2 and U1 only), flashed with `wifi_floppy.uf2` and powered over USB. What that
  exercised, end to end, on real silicon:
  - the RP2350 boots the image, reaches `main()`, and launches core1
  - `cyw43_arch_init()` succeeds — the **RM2 radio works over SPI**, the single
    largest never-before-run piece
  - the AP comes up: `wifi-floppy-6A38`, WPA2-AES, SSID built from the chip's own MAC
  - **DHCP hands the phone an address, the DNS responder answers, and the HTTP server
    serves the form** at `192.168.4.1`
  - **iOS's captive-portal probe raises the sign-in sheet on its own** ("Wi-Fi med
    tilmelding"), which was explicitly on the unverified list
  - the page's `28:cd:c1:19:6a:38` and the SSID's `6A38` agree, so `main.c`'s
    `mac_address_string()` and `portal_net.c`'s SSID construction cross-check
  - no re-enumeration of the USB CDC device over several minutes: no crash loop

  **Still not run on hardware:** everything past pressing Save. AP teardown and the
  transition back to station mode, association with a real network, the confirmation
  page arriving before the AP drops, DHCP lease renewal after teardown, the 3-slot
  lease pool under real phone behaviour, Android's captive-portal probe, TLS, SNTP,
  device registration, and the whole floppy side — PIO cycle counts, DMA, PSRAM image
  load, bus timing — which remain desk-checked only. See
  `docs/decisions/2026-08-31-device-portal-rulings.md`'s hardware-only list for the
  full set, which plan 5 owns closing.
- **The firmware has no console output whatsoever.** `stdio_init_all()` brings up the
  USB CDC device — so `/dev/cu.usbmodem*` appears and `tio` connects — but there is not
  one `printf` in `src/`, no logging macro, and `CYW43_VERBOSE_DEBUG`, `LWIP_DEBUG` and
  `MBEDTLS_DEBUG` are all off. Listening to that port returns zero bytes, which is
  correct behaviour and not a symptom. It cost nothing while the portal was externally
  visible; it will cost a great deal at the first failure that is not.
- It compiles (`pnpm firmware:build` produces `firmware/build/wifi_floppy.uf2`) and has
  a green host suite (`pnpm firmware:test`, 506 checks across 13 binaries, plain C under
  clang). Treat anything not covered by a host test or by the hardware run above as
  unverified.
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
8MB PSRAM, RM2 radio). It keeps the Pico footprint and pinout, so the PCB is
unchanged electrically - only the module value differs.

PSRAM is the disk. The image is pulled in **one bulk transfer at mount**
(`image_loader.c`) and the floppy bus is served entirely from RAM after
that - the read path contains no network call at all.

| where | size | role |
|-------|------|------|
| SRAM double buffer | ~26 KB | only DMA source for the flux PIO |
| PSRAM disk image | 2.03 MB | the whole disk, 160 x 13 KB slots |

**The route below is superseded** — the firmware fetches
`GET /api/device/image/<sha256>` (keyed by digest, not an integer id; see
`INTEGRATION.md` and disk-change spec §10), but the `WFMF` container body format
itself is current and matches `image_loader.c`:

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
* **Antenna keepout position is still an assumption, and the PIM726 documents
  do not settle it.** A schematic carries no placement, and the "Pins and
  Dims" sheet's board illustration is not something to read a fab decision
  off. What the keepout currently claims, so it can be checked against a
  module in hand: it spans the module's full 21 mm width and the last 5.4 mm
  of its 51 mm length at the **non-USB end** - the pin 19-22 end, GP14-GP17.
  If the RM2's antenna is anywhere else, there is ground plane under it.
  Costs nothing to keep: GP14-GP17 are unused on this board, so the keepout
  is only wrong if it is in the wrong *place*, never merely expensive.
* ~~Confirm GP0-GP17 map to the same physical castellations on the RP2350B
  board as on the Pico 2 W.~~ **CONFIRMED 2026-09-09** against the PIM726
  schematic (sheet 3/3, "Output headers"). The Plus 2 W's header is the
  standard Pico header pin for pin: pin 1 = GP0 through pin 22 = GP17, with
  GND on 3/8/13/18/23. The only difference is that pins 6 and 7 are labelled
  `GP4_SDA` and `GP5_SCL` because they also feed the QW/ST connector - same
  GPIOs, alternate function. Every U1 signal this board uses lands where it
  was assumed to.
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
routing channels. The plain header is what most drives use, so rev B keeps
it; polarity relies on the pin-1 markings and the cable's red stripe.

## Revision history - rev B is current

| rev | state |
|-----|-------|
| A   | fabricated, **scrap** - every layer mirrored, and four SOT-23s reflected |
| A2  | fabricated, **usable with a caveat** - correct except that the ground pour runs under the RM2 antenna |
| B   | **current**, not yet fabricated - A2 with the antenna keepout at the right end; copper, mask, drill and outline are byte-identical to A2 |

### Rev A2 errata - rev A boards are scrap

The first batch (rev A) came back from JLCPCB mirrored and cannot be used.
Two independent bugs, both now fixed and both now covered by
`hardware/verify_board.py`, which must be run before any future fab order.

**1. Gerber Y axis.** KiCad's coordinate system has Y increasing downward;
Gerber and Excellon have Y increasing upward, and KiCad negates Y when it
plots. `export_gerbers.py` wrote coordinates straight through, so every
layer was reflected. The renderer used the same Y-down convention, so the
preview looked correct and the verification compared the Gerbers against an
equally wrong-handed source - self-consistent, and self-consistently
mirrored.

**2. SOT-23 gate/source.** Q1, Q2, Q3 and Q6 were reflections of the
canonical KiCad SOT-23 land pattern - gate and source swapped - so a real
part would have had its gate on the GND pad and never switched. Only Q4 and
Q5 were right. Independent of bug 1; it would have shipped either way.

Fixing 2 moved the gate and source pads, which made Q3's gate pad overlap
Q4's source pad, so Q3 moved 0.6 mm north and its drain now jogs to J1 row
13 the way Q2 and Q5 already did. The INDEX, TRK0, RDY and CHNG gate routes
were re-run to suit.

`verify_board.py` now checks every footprint against the canonical KiCad land
pattern (rotation = fine, reflection = fail) and confirms the Gerber pads sit
at the mirrored Y of the .kicad_pcb. Regression-tested against the old broken
export: it reports 118/122 pads at un-mirrored Y and fails.

**A2 follow-up: antenna keepout was at the wrong end.** The rev A2 boards
were fabricated with the ground pour void over U1 pins 1/2/39/40 instead of
19/20/21/22 - the opposite end of the module. Cause: `export_gerbers.py`
flipped Y for pads, traces, silk, outline and drill, but not for the keepout
zone polygon, so the void mirrored away from the antenna. The pour audit
missed it because it used the same unflipped polygon on both sides of the
comparison - self-consistent again. Fixed, and `verify_board.py` now asserts
the keepout covers U1 pins 19-22 - reading copper out of the emitted `.GBL`
rather than re-deriving the void from the exporter, so the check cannot agree
with the exporter's mistake the way the last one did. Regression-tested both
ways: it fails on the rev A2 `.GBL` (25/25 sample points copper under the
antenna) and passes on the current one (0/25).

Consequence for the rev A2 boards in hand: they are electrically fine (all 27
GND pads still bond, no signal pad is affected) but there is ground plane
under the RM2 antenna and a harmless void near pins 1/2. Build one and check
signal strength before respinning - the whole-image PSRAM load means WiFi only
has to work at mount time.

### Rev B

The corrected files are **rev B** and have not been fabricated. Copper, mask,
drill and outline are byte-identical to rev A2 - `.GTL`, `.GTS`, `.GBS`, `.GKO`
and `.TXT` all unchanged - so an assembled rev A2 board remains a valid bring-up
target and nothing in the BOM changes. Two files differ: `.GBL` for the keepout,
and `.GTO`, because rev B is the first revision whose silkscreen will print.

**Rev B is marked.** The board says `WIFI FLOPPY REV B` on the silkscreen and
carries its reference designators; rev A and rev A2 have neither, so an unmarked
board is one of the older two. Which of those it is you tell from the pour void:
on A2 it sits at the USB end of U1, on B at the opposite end.

### Rev A and rev A2 have outlines but no lettering

**Corrected 2026-09-09 from a photograph of an assembled rev A2 board.** An
earlier version of this section said the silkscreen never printed at all and
blamed the fab for stripping it. That was wrong, and it was wrong in the
direction that flatters the diagnosis: I inferred it from a spec table instead
of from the board. J2's and U1's body outlines are plainly legible on a real
board, at 0.12 mm. Two separate things are true:

1. **The exporter dropped everything that was not an `fp_line`, and that is why
   there is no lettering.** All 13 reference designators, the antenna-keepout
   label and U2's pin-1 dot never reached the `.GTO` at all - silently, because
   nothing counted what it skipped. `export_gerbers.py` now renders text through
   `stroke_font.py`, a single-stroke vector font, and draws circles.
2. **Every silk feature was also below the fab's published minimum**, which is a
   real DFM violation even though it printed. JLCPCB's minimum silkscreen line
   width is 6 mil (0.1524 mm); the outlines were 0.12 mm and the J1 chevron
   0.15 mm, so all 17 features were under it. They came out this time. A layer
   that prints only because the fab was lenient is not one to ship again, so rev
   B draws silk at 0.2 mm and text at 1.0-1.5 mm.

Neither was visible to any check, which is the third time something wrong in the
fab output got there because nothing was looking at it. `verify_board.py` now
reads feature widths back out of the emitted `.GTO` and fails on anything below
the fab minimum, and `export_gerbers.py` reports any legend stroke that lands
within 0.15 mm of a pad. Designator placement was moved to suit: the FET column
is on a 3.14 mm pitch, so Q1-Q6 label to the east rather than above.

### Orienting the parts

D1 is the only part you can silently fit the wrong way round, so rev B marks
it: a body outline closed at the cathode end, drawn with a heavier bar than
the sides. **The SS14's banded end goes to that bar** - pad 1, the pad whose
trace runs the long way up the board, away from J2. Pad 2 is the anode, fed by
the +5V run that comes along the bottom edge from J2.

Pad 1 is the cathode by what KiCad's own `D_SMA` draws, not by convention: its
`F.Fab` layer puts the diode symbol's bar on the pad-1 side with the triangle
pointing at it, and its `F.SilkS` outline closes that end. The netlist agrees -
pad 1 is `VSYS`, pad 2 is `+5V`, and current runs anode to cathode. Reversed,
the board simply will not power from the floppy connector while still working
over USB, which is an annoying thing to debug.

Everything else is keyed:

| part | how you orient it |
|------|-------------------|
| J1, J2, U1 | square pad 1 (J1 also has the chevron). U1 matters - a 2x20 header footprint is symmetric, so the module fits rotated 180 degrees |
| U2 | pin-1 dot on the silkscreen |
| Q1-Q6 | no marking, and none needed: SOT-23 has two pads one side and one the other, so it cannot land rotated |
| C1, C3 | ceramic, not polarised |

**Still unconfirmed:** that the RM2's antenna is at the pin 19-22 end at all.
That is inherited from the CYW43 Pico 2 W and has never been checked against a
PIM726 in hand. `verify_board.py` enforces the assumption; it cannot validate
it. Confirm before ordering rev B, because moving the void is the only thing
rev B does.

Component orders are unaffected - every part in the Mouser order is still
correct for rev A2 and for rev B.
