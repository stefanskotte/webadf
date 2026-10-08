# DF1 second drive and "insert disk 2" detection (read-only study, 2026-10-08)

Operator's request: multi-disk ideas 3 and 4 (HANDOFF.md:2321-2340).
- **Idea 3:** the board answers as DF0 **and** DF1 at once: disk N on SEL0, disk N+1 on SEL1, one per PSRAM slot.
- **Idea 4:** detect a game waiting for "insert disk 2" and swap on a tap.

Constraint: "remember someone might have a physical disk drive on the external connector as DF1, so would need to be
a setting of sorts". The second drive must be **opt-in per board** and must never fight a real DF1.

Closely related: `docs/superpowers/research/2026-09-28-df0-passthrough.md` (cited below as "passthrough").

Nothing was edited (except this file), built, flashed or measured. Each claim is either **verified** with a
file:line, or marked **(unverified here)** when it comes from general Amiga knowledge, or **(estimate)** when it is
my arithmetic.

---

## Operator rulings, 2026-10-08 (these answer §7 and override the text below where it differs)

- **Models:** the Amigas that matter are the A500, 600, 1200, 2000, 2500, 3000(T) and 4000(T). There is no "A5000":
  earlier notes mislabelled the bench machine, which was always an **A500 rev 8a.1** (corrected throughout,
  2026-10-08).
  The operator tests DF1 on a plain **A500**. Big boxes are not a v1 test target, but the help must state their
  caveat.
- **v1 DF1 is read-only.** Accepted.
- **DF1 holds only the next disk of the set.**
- **When `df1Seen` is true:** refuse, with an override behind a second confirmation. Accepted as recommended.
- **The bus sniffer** may move wherever it fits. Report any tradeoff that results.
- **Idea 4 is deferred.** Few games support multiple drives (most are NDOS), and the operator is still finding
  ones that do. The first bench tests use **Workbench disk sets** only, because AmigaDOS makes DF1 easy to query.
- **Help:** add help items covering exactly these caveats.

## 0. Verdict in one paragraph

**Idea 3 is feasible on rev B with firmware only, behind a per-board setting that defaults to off.**
- SEL1 is wired to GP3 and pulled up.
- Every board output is open-drain.
- The PIO programs can be shared between two state machines (SMs) with almost no new instructions.

Four limits:
1. **PSRAM is full.** With DF1 on there is no idle slot, so "Next disk" briefly empties DF1 instead of preloading.
2. **DF1 must be read-only in v1.** The server knows one mounted disk per board.
3. **pio0 needs a fifth SM, and a PIO block has four.** `flux_in` has to move to pio2.
4. **The board cannot sense a real DF1 when its own DF1 is on.** It can only notice one while its DF1 is off, from
   the steps it ignores.

**Idea 4 cannot be designed yet.** The bus does not show "the game is waiting for a disk". It shows seek, motor and
revolution patterns, and nobody has logged those during a real "insert disk 2" prompt. Measure first. Then ship it
as a hint ("Disk 2?" plus a tap), never as an automatic swap.

---

## 1. How the board answers today

### Hardware (rev B, verified)

- **SEL1 is wired.** J1-12 -> `SEL1_B` -> U2-3 ('541 A-side) -> U2-17 -> `SEL1` -> U1-5 = **GP3**, with **R7**,
  1 kΩ to +5 V (`wifi-floppy/hardware/production/netlist.ipc:170, 96, 110, 51, 34`).
- **Pin map.** `.sel0 = 2, .sel1 = 3, .mtr = 4, .dir = 5` (`wifi-floppy/firmware/src/board.c:7`).
  `board_check` insists that SEL0..DIR are consecutive and that SEL0 is GP2 (board.c:26-29).
- **One set of outputs.** Six open-drain BSS138s: CHNG, INDEX, TRK0, WPROT, RDATA, RDY (passthrough §1;
  `floppy_io.h:17-23`). The board drives **no** host line.
- **These six lines are shared by every drive on the cable.** A drive should touch them only while its own select
  is low (HANDOFF.md:3412-3460, §4e).

**Can one board serve two drive identities with one set of outputs? Yes, electrically.** The Amiga selects one
drive at a time. Each output only needs to carry "the selected drive's level" during that select, and to be
released otherwise. Nothing needs duplicating on the copper.

**The board has no bus-side input on any of the six output lines.** Each GPIO drives only its FET gate
(passthrough §1). So the board **cannot see what another drive puts on RDY, RDATA, CHNG and the rest**. This
matters for §3.

### Firmware: everything is gated on SEL0 (verified)

**Outputs:**

| Program | What it does | Where |
|---|---|---|
| `status_gate` (pio1, 1 SM) | Drives INDEX/CHNG/WPROT/TRK0 from one mask while SEL0 is low; `mov pins, null` otherwise | `floppy.pio:105-115`; fed by `bus_out_set` (`bus_out.c:56-90`), one shadow word |
| `flux_out` (pio0) | Pulses RDATA only while SEL0 is low; `jmp pin` = SEL0 | `floppy.pio:19-32`, `main.c:2555-2557` |
| `drive_id` (pio0) | Owns RDY: the ID shifter on motor-off selects, the CPU's level on motor-on selects | `floppy.pio:224-246` |

`drive_id` waits on **GP2 literally** (`wait 0 gpio 2`, `floppy.pio:227, 232, 238, 244`). That is why
`board_check` pins SEL0 to GP2. It is on by default (`CMakeLists.txt:164`).

**Inputs:**

- **`step_dir` (pio2)** samples **SEL0 SEL1 MTR DIR** as four bits at STEP's fall (`floppy.pio:82`). So **SEL1 is
  already in every step word**. `bus_step_decode` only looks at SEL0 (`bus_gate.c:16-22`). Steps with SEL0 high
  are counted as `steps_other_drive` and dropped (`main.c:575-578`).
- **`sel_mtr` (pio1)** latches MTR on SEL0's fall (`floppy.pio:128-146`, `main.c:2588-2595`).
- **WGATE ISR:** a write with SEL0 high is counted in `writes_other_drive` and ignored (`main.c:1057-1059`).
- **SIDE:** global and ungated: `cur_side` (`main.c:1075-1076`).

**Drive state is global and single:**

- `cur_cyl`, `cur_side`, `want_track` (`main.c:432-434`);
- one DMA channel and one `track_words` buffer (`main.c:430, 439, 452-500`);
- one `dskchg` state (`dskchg.c:36-41`);
- one published active slot (`psram_image.h:132-144`).

### PIO budget today (verified)

| Block | State machines | Instructions |
|---|---|---|
| **pio0** | 3 of 4: flux_out, flux_in, drive_id | 7 + 7 + 15 = **29 of 32** (`floppy.pio:220-222`) |
| **pio1** | status_gate, sel_mtr (+ bus_sniff in a sniff build) | 6 + 12 (+13) = 18, or **31 of 32** in a sniff build (HANDOFF.md:3443) |
| **pio2** | step_dir (4 instructions) + the CYW43 radio's SPI program | radio size not measured. The `pio claims:` boot line records the real assignment (main.c:1346) but has never been read for pio2 |

### PSRAM and SRAM (verified from `build/wifi_floppy.elf`)

- **PSRAM:** `.psram_noload` = 6,684,672 B.
  - That is two image slots of 160 x 14,336 = 2,293,760 B each (`psram_image.h:42-47`), plus the 2 MiB firmware
    stage (`main.c:1258`, `fw_offer.h:9`).
  - The PIM726's PSRAM is 8 MiB (`psram_image.c:100`), so **1,703,936 B is free: less than one slot**.
- **SRAM:** `.bss` 402,656 + `.data` 9,776. About **105 KB** is left between heap start and the stack for lwIP and
  mbedTLS heap. Peak heap use is unmeasured.

---

## 2. The Amiga side: where DF1 lives and whether the board can see SEL1

### Known (from this repo)

- **The board sits on the internal 34-pin floppy cable**, in place of the internal DF0.
  - A500 bench, case off (HANDOFF.md:1487).
  - A500 rev 8a.1 (HANDOFF.md:5128).
  - On big-box machines it would sit on the internal cable inside the case (HANDOFF.md:1484).
- **A real external DF1 worked beside the board** on an "A500-class machine" (HANDOFF.md:3414-3417, §4e):
  2,063 DF0 steps followed, 250 DF1 steps ignored. The machine is not named more precisely.
- **SEL1 reached J1 pin 12 on the 2026-09-15 bench machine.**
  - A rev A2 sniff capture counted **68 SEL1 edges** in a no-disk boot (HANDOFF.md:3644).
  - 68 is exactly 2 x 34, and Kickstart reads DF1's ID with **34 selects** right after DF0's 33
    (HANDOFF.md:3481).
  - So pin 12 carried a real SEL1, not noise. Which of the A500 that was is **not recorded**.
  - "SEL1 on pin 12 of the A500 cables" is still listed as an owed bench item (HANDOFF.md:2270).
- **Kickstart reads every drive's ID at power-on.** For DF1-3:
  - **0x00000000 means "no drive"**: RDY is never asserted on the 32 motor-off selects.
  - **0xFFFFFFFF means DD; 0xAAAAAAAA means HD.**

  Sources: research `2026-09-24-hfe-and-hd-floppies.md:326-333` and `drive_id.h:36-37`. The responder's phase
  (bit 31 on the first motor-off select after a motor-on one) was verified on the bench (`drive_id.h:22-27`,
  HANDOFF §3an).
- **Absent DF1 behaves correctly today.** The board's RDY and status lines are released whenever SEL0 is high, so
  DF1's ID reads as 0 unless a real drive answers. Without that, an ungated RDY made Kickstart believe in a DF1
  that was not there (HANDOFF.md:3481-3485).

### Assumed (unverified here)

- **A500/A600/A1200:** the internal connector carries SEL0 on pin 10 and SEL1 on pin 12. The external DB23 port
  also carries SEL1, so an external DF1 and pin 12 inside are **the same signal**.
  - The 68-edge capture supports this for one machine only.
  - If some model leaves pin 12 unconnected, the board cannot be DF1 from the internal connector. Pin 12 would
    idle high on R7, and the self-test in §6 step 0 detects that.
- **A2000/A3000/A4000:** the internal ribbon has two drive connectors with SEL0 and SEL1. A second internal drive
  is jumpered as DF1. On those machines the external port is usually DF2, i.e. SEL2, which the board does not see
  (J1 has no SEL2/SEL3).
  - So on a big box, the **real** DF1 that would conflict is a **second internal drive** on the same ribbon.
- **Kickstart creates trackdisk units only for drives found at boot.** A DF1 that appears after boot is not used
  until the Amiga resets. Kickstart 2.0+ can boot from DF1 via Early Startup; 1.3 boots only DF0.
- **"Many multi-disk games read disk 2 from DF1"** is the operator's experience. Some loaders hard-code DF0.
  Measure on real titles (§6 step 3).

### Consequence

**The DF1 answer must be live before Kickstart's power-on ID read.** That read happens seconds before Wi-Fi is up,
so it cannot wait for a poll.
- The setting therefore has to be **persisted on the board** and applied at board boot, before `bus_out_init`
  (main.c:2449).
- The board is powered from the Amiga's floppy +5 V (J2), so an Amiga power-on is also a board boot.
- After a warm reset (Ctrl-A-A) the board is already running and answering, so a setting applied live takes
  effect at the next reset of either kind.

---

## 3. Conflict with a real DF1

**Electrically: no damage.** Every board output is an open-drain FET (passthrough §1), and drive outputs are
open-collector by Shugart convention (`docs/decisions/2026-09-20-floppy-bus-pullups.md:191-195`). Two sinks on one
pulled-up line wired-OR; nothing fights.

**Logically: it breaks, in this order of harm:**

1. **Writes are captured into the board's DF1 image.** A save to the real disk, with SEL1 low and WGATE low, would
   be decoded and applied to the board's DF1 slot. Once DF1 writes are supported, it would also be uploaded as a
   library version. The passthrough study found the same class of bug (passthrough §3a.2).
   - **v1 DF1 is read-only, and the board ignores WGATE on SEL1 entirely.**
2. **RDATA mixes two flux streams.** Every read from the real DF1 fails, and so does every read from the board's.
3. **Status lines OR together.** The real drive's CHNG and WPROT spoil the board's DF1 (an empty real drive holds
   CHNG asserted), and the board's WPROT makes the real disk look write-protected.
4. **IDs OR together** (DD | DD = DD). So Kickstart sees nothing odd at boot, and the failure only shows on use.

**The board cannot detect the conflict while its DF1 is on.** It has no input on RDY or RDATA (§1).

**It can notice a real DF1 while its own DF1 is off:**
- Steps with SEL1 low happen only when a real DF1 exists: the disk-change click and recalibrates. With DF1 absent,
  all 1,838 STEP falls in a whole boot came with SEL0 (`floppy.pio:59-64`). With a real DF1, 250 DF1 steps were
  counted (HANDOFF.md:3415-3417).
- `step_dir` already captures SEL1 in each word, so the board can count "SEL1 steps while my DF1 is off" with no
  PIO change.

### What the setting must look like (recommendation)

**Per board, in the web app's device panel, next to the OLED layout:**

> **Second drive (DF1):** Off | Next disk of the set
> *"Only if no other drive is connected as DF1 (an external drive, or a second internal drive). Takes effect when
> the Amiga restarts."*

- **Default Off**, and stays off for every existing board.
- **Refuse to switch on while the board reports `df1Seen`.** The UI says why ("a drive already answers as DF1 on
  this Amiga") and offers an explicit override only behind a second confirmation. The heuristic misses one case: a
  real DF1 the Amiga never stepped since the board booted.

**Delivery: copy the OLED-layout pattern, which already solves "board setting, held poll, older firmware".**
- **Column on `devices`:** `secondDrive` (`'off' | 'df1'`), plus `secondDriveVersion`. Compare `displayVersion` and
  `displayLayouts`, `src/db/schema/devices.ts:142-156`.
- **Capability flag:** `secondDrive: true` in the status report, the way `displayLayouts` is
  (`src/app/api/device/status/route.ts:57-62`). The UI hides the control for older firmware.
- **Poll:**
  - The board sends `driveAck` like `displayAck`, and the poll wakes on any mismatch (`poll/route.ts:73-149`).
  - The value goes **inline in the poll body**. It is one byte, so it needs no separate GET the way the display
    blob does.
- **DF1's disk is the existing `next`** (`readNextForPoll`, `src/lib/next-disk.ts:96`; `poll/route.ts:154`). No new
  server-side disk choice.
- **On the board:**
  - A small flash record, written only while the drive is empty, like `display_store`
    (`display_store.h:1-27`, `display_store_should_write`).
  - Not inside `config_store`, so a setting change never touches credentials (display_store.h:5-7).
  - Read at boot before `bus_out_init`.
- **New status fields:** `df1Seen` (the SEL1-steps heuristic) and `sel1Wired` (any SEL1 select seen since boot; see
  §6 step 0). Shown on the device card as plain readings, both values, per the "show both values of a state" rule.

---

## 4. Firmware cost of DF1

### What DF1 serves

**Rule: one slot, one drive, never the same slot on both drives.** Otherwise writes, even future ones, could land
twice.

- **On mount of disk N** (DF1 on):
  - DF0 = slot A;
  - the existing preload fetches N+1 into slot B (spec `2026-09-28-multi-disk-next-design.md:110-123`);
  - **DF1 = slot B once the preload is ready**, empty (CHNG asserted) until then.
- **2-disk games: no swap ever happens.** That is the whole point of the feature.
- **"Next disk" with DF1 on:**
  1. DF0 publishes slot B (N+1, instant).
  2. DF1 is **ejected** at the same moment, because slot B is now DF0's.
  3. Slot A (disk N) is free. The board fetches N+2 into it and inserts it into DF1 when ready.

  So DF1 is empty for one fetch (~5 s, multi-disk spec). That is a normal eject and insert to the Amiga.
- **No third slot.** 3 x 2,293,760 + 2 MiB stage = 8,978,432 B > 8 MiB (§1).
  - A third slot would mean the firmware stage overlapping an image slot, with OTA allowed only with DF1 empty.
  - Not worth it for v1.

### Per-drive state (all of it is single today)

- **Head and side:**
  - `cur_cyl[2]`.
  - `want_track[2]` and `loaded[2]` in the core0 loop (main.c:2850-2864).
  - SIDE is shared and ungated, so a SIDE change re-aims **both** drives' streams.
- **Steps:** `bus_step_decode` returns which select was low (bus_gate.c:16-22). DF1 steps move `cur_cyl[1]` and
  TRK0 in DF1's mask.
  - The 1 ms too-fast filter (main.c:607) must be per drive, or a DF0 step would make a DF1 step look like a
    burst.
- **Motor:** `sel_mtr` on a second SM with in_base = SEL1. Same program, 0 new instructions, because `wait pin 0`
  is relative to in_base. `dskchg` becomes `st[2]` (dskchg.c:36-41).
- **CHNG:** per drive, cleared by that drive's step with a disk in (dskchg.c:82-87).
- **INDEX:** per drive, from that drive's own DMA wrap (main.c:537-546). This needs a second DMA channel and
  `track_words` buffer:
  - +14,336 B for DD-only DF1;
  - +25,344 B to allow HD.

  Measure the heap high-water mark before choosing (§1: ~105 KB headroom, peak unmeasured).
- **WPROT:** DF1 always asserted in v1.
- **RDY:** DF1's own level and ID.
- **Writes:** the WGATE ISR ignores SEL1 writes in v1.
  - DF1 write-back needs the server to accept writes for a **second** mounted disk. Today `holdsMount` checks one
    `devices.mountedDiskId` and answers 409 `not_mounted` for anything else (`src/lib/device-write.ts:51-85`).
  - That is a separate, later piece.

### PIO changes (the real work)

- **`status_gate`: two SMs, one per select, each with its own mask.** The current loop writes `mov pins, null`
  continuously while deselected (floppy.pio:113-114). Two such SMs would overwrite each other every ~33 ns.
  - The released path must write null **once, on the transition**, then only pull. This is about +2 instructions,
    with a "was selected" flag in Y.
  - Both SMs run the same program with different `jmp_pin`.
  - `bus_out_set` gains a drive index: two shadows, two FIFOs.
- **`flux_out`: second SM, same program, 0 new instructions, if `side 0` is dropped from every non-pulse
  instruction.** `.side_set 1 opt` allows that (floppy.pio:20).
  - Then a deselected SM never writes RDATA, and only the pulsing SM sets it to 1 and then 0.
  - The cycle counts are unchanged.
  - **(unverified here, RP2350 datasheet):** when two SMs of one PIO write a pin in the same cycle, the
    higher-numbered SM wins; otherwise the last write holds. Read this in the datasheet before building.
- **`drive_id`: second SM, same program.** Replace `wait 0/1 gpio 2` with `wait 0/1 pin 0`, with in_base = that
  drive's select: 0 new instructions.
  - It already writes RDY only at select transitions (floppy.pio:225-246), so two SMs coexist.
  - `board_check`'s "SEL0 must be GP2" rule (board.c:28-29) can then go. That was P2 of the unified firmware plan.
- **SM count:**

  | Block | SMs with DF1 | Fix |
  |---|---|---|
  | pio0 | flux_out x2 + drive_id x2 + flux_in = **5 > 4** | **Move `flux_in` to pio2.** `flux_capture_init` already takes the PIO as a parameter (flux_capture.h:17); its pin is any GPIO. |
  | pio1 | status_gate x2 + sel_mtr x2 = 4 SMs, ~20 instructions | **The sniffer no longer fits** (it needs a 5th SM). Move `bus_sniff` to pio2 too, or build sniff and DF1 exclusively. |
  | pio2 | step_dir + CYW43 + flux_in (+ sniff) | Read the `pio claims:` boot line first: the radio's instruction count there is unmeasured. |

- **Simultaneous selects.** Some loaders select several drives at once to switch all motors off **(unverified
  here)**. Real drives would wire-OR. The two-SM gate gives last-writer instead. That is harmless for a motor-off
  select, but noted.

### Core0 timing budget

- **Measured:** STEP -> TRACK-SERVED median 1 ms, p99 3 ms, against ~15 ms of head settle (HANDOFF.md:3838).
- **HD track encode:** ~4 ms (track_cache.h:59).
- **DF1 doubles the work only on a SIDE change**, which reloads both streams: worst case ~2 x 3 ms DD, or
  ~2 x 4 ms + copy with HD on both **(estimate)**. That stays inside the settle window, but HD on both drives is
  the tight case.
- **Seeks are per drive.** trackdisk drives one unit's DMA at a time **(unverified here)**.
- **SRAM staging:** `track_cache`'s two buffers are a cache keyed on (track, token) (track_cache.c:15-30), so DF1
  can share them with a slot parameter. Expect more misses, not more SRAM.

---

## 5. Idea 4: detecting "insert disk 2"

### What the board can see, and what it cannot

- **It can see:** selects, motor on/off per select, STEP with direction, SIDE, WGATE, and how many revolutions each
  stream turned.
- **It cannot see:** which sectors Paula decoded, or what the game printed. The flux streams whether or not anyone
  reads it.
- A re-read of the same track does not change `want_track`, so **retries are invisible to every trace there is
  today** (HANDOFF.md:3847-3850). That is exactly the signal idea 4 needs.

### Candidate signatures (all hypotheses, unmeasured)

- **Custom loaders (most multi-disk games) (unverified here):** the loader reads its disk-ID track, finds the wrong
  disk and loops.
  - On the bus: a **periodic cycle with the same shape**: motor on, seek to the same cylinder (often 0 or 1), dwell
    for one or two revolutions, motor off. It repeats every 0.5-3 s, and **no new cylinder is visited**.
  - Some loaders also step to clear CHNG and wait for it to assert, i.e. they expect an eject first.
- **AmigaDOS "Please insert volume X"**: DOS waits for a disk change. On the bus it looks like ordinary
  disk-change polling (selects, maybe clicks), and **is the same as idle**. It is undetectable except by the board
  knowing the volume name the requester wants, which it does not.

### False-positive risks

- A game that leaves the motor on and re-reads one track as copy protection or a music streamer.
- Title screens that poll the drive.
- Copylock-style protection retries (`tools/protection/`, the Gods case).
- A user who simply has not swapped yet.

**An automatic swap on a false positive changes the disk under a running game.** The swap gate's idle rule
(`swap_gate_idle`, main.c:1299-1311) keeps writes safe, but a game mid-load would read the wrong disk.

### Measurement needed first

1. **A logging build that records per-drive activity summaries.** At each motor-off, log one line: cylinders
   visited, revolutions per stream, motor-on duration and the step count. Logging every revolution floods the
   ring (main.c:547-565).
2. **Logs from about eight real multi-disk titles across different loaders**, with the "insert disk 2" prompt left
   on screen for 60 s. Note what is on screen and when.
3. **Baselines:** normal play, title screens, a protected game, idle Workbench.
4. **Decide only then:** if a signature separates cleanly, show **"Disk 2?" on the OLED and in the web app**, and
   swap on a tap: the NFC card, the board button, or the web "Next disk", which already exists (3ap). Never swap
   automatically.

**With idea 3 on, many 2-disk games never prompt at all.** That makes idea 4 matter mainly for 3+ disk titles and
for loaders that hard-code DF0. Build idea 3 first, then see what is left.

---

## 6. Recommended design and plan

**Design:** per-board setting "Second drive (DF1): Off | Next disk of the set", default Off, as in §3.
- DF1 serves the preloaded next disk from the idle slot, **read-only**.
- It answers the Amiga ID as DD, or HD for an HD disk.
- It empties for one fetch on "Next disk".
- The board reports `sel1Wired` and `df1Seen`, and the UI refuses to switch DF1 on while `df1Seen` is true.

**Plan, each step shippable on its own:**

0. **Measure SEL1 first (no feature, firmware telemetry only).**
   - Add a SEL1 select counter (a GPIO falling-edge IRQ on GP3 is enough to see "any") and the SEL1-steps count.
   - Report both in status.
   - **Bench:** cold-boot each machine (A500, and a big box if available) with no DF1. Expect `sel1Wired`
     true and `df1Seen` false. Then add the real external DF1 and expect `df1Seen` true after a disk-change
     click.
   - This also settles the owed "SEL1 on pin 12" item (HANDOFF.md:2270) without a multimeter.
1. **Firmware refactor, behaviour unchanged.**
   - The select becomes a per-SM parameter: `drive_id` uses `wait pin`, and `flux_out` sets its side only on the
     pulse.
   - `status_gate` releases on the transition only.
   - `flux_in` moves to pio2.
   - Drive state becomes per drive in `dskchg`, `cur_cyl` and `bus_out`, with one drive configured.
   - Host-test in the `bus_gate` / `drive_id` model style.
   - **Bench:** the §4e regression (real external DF1 beside the board: both list, 0 DF1 steps acted on), an HD
     ID read, writes on DF0, and the sniffer showing no output asserted while both selects are released.
2. **DF1 read-only behind a compile flag, then behind the stored setting.**
   - **Bench, without a real DF1:**
     - cold boot: Workbench shows DF1 (`info`) with disk N+1, and `dir df1:` lists it;
     - read a whole disk from each drive at once (`copy df0: ... & copy df1: ...`);
     - "Next disk": DF1 ejects, then re-inserts N+2;
     - a write to DF1 fails as write-protected;
     - turning the setting off then a reset: DF1 disappears from Workbench.
   - Then **two real 2-disk games** that use DF1.
3. **Web setting, poll delivery, flash record, `df1Seen` guard,** and help text in `src/lib/help/topics.tsx`.
   - e2e for the setting and the refusal.
   - **Bench:** with a real external DF1, the switch is refused in the UI.
4. **Idea 4 measurement build (§5),** then a decision.
5. **Later, only if asked:**
   - DF1 write-back (the server needs a second mounted disk per board);
   - a third slot (stage overlap);
   - **rev C:** a bus-side sense input on RDY. A real DF1 asserts RDY during Kickstart's DF1 ID read, so the board
     could detect a real DF1 at **every** boot. That turns the heuristic into a reading and fits the J5 "DRIVE"
     header already planned for passthrough (HANDOFF.md:2271-2275).

---

## 7. Open questions for the operator

1. **Which machines should DF1 support first?** A500 on the internal connector are the expected case.
   Is a big box (with or without a second internal drive) in scope?
2. **Is DF1 read-only acceptable for v1?** Saves to disk 2 would fail as write-protected. DF0 writes keep working.
3. **When `df1Seen` is true: refuse outright, or allow with a second confirmation?** I recommend refusing, with an
   override that the user has to type or confirm twice.
4. **Should DF1 offer anything besides "Next disk of the set"** (e.g. "a disk I pick")? That would need a second
   "desired" on the server. I recommend not for v1.
5. **May the bus sniffer become a pio2 diagnostic (or exclusive with DF1)?** pio1 has no room for both.
6. **Idea 4: will you run the measurement sessions** (about eight titles, prompt on screen for 60 s each), and
   which multi-disk titles from the library should be on the list?
