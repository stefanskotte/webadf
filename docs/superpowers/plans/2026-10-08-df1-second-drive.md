# DF1 Second Drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board can answer as DF0 and DF1 at once. DF1 serves the next disk of the mounted set, read-only. It is a
per-board setting, Off by default, set from the web app, and it refuses to switch on where a real DF1 has been seen.

**Architecture:** Four phases, each shippable on its own and each ending with a bench checklist:
- **Phase 0:** SEL1 telemetry only (`sel1Wired`, `df1Seen`).
- **Phase 1:** a behaviour-unchanged refactor. The PIO programs take their select as a parameter, the status gate
  releases only on the deselect edge, `flux_in` (and the sniffer) move to pio2, and drive state becomes per drive.
- **Phase 2:** DF1 serves the preloaded idle PSRAM slot behind a stored flash setting with a compile-time default.
- **Phase 3:** the web setting, delivered inline in the poll, with the `df1Seen` guard and its help topic.

**Tech Stack:** C11 + pico-sdk 2.3.0 (RP2350, PIO), host tests under `cc` (`wifi-floppy/firmware/test/run.sh`);
Next.js 16.3.2 (this repo's version has breaking changes: read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
before touching a route), Drizzle/Neon, zod, vitest, Playwright.

**Spec:** `docs/superpowers/research/2026-10-08-df1-second-drive.md` (§3 setting, §4 firmware cost, §6 plan). The
operator rulings of 2026-10-08 (below) override it where they differ.

## Operator rulings (2026-10-08), binding

- **Models.** Supported Amiga models are A500/600/1200/2000/2500/3000(T)/4000(T).
  - The bench machine is an **A500 rev 8a.1, Kickstart 3.1, board on the internal connector**.
  - Big-box machines are not a v1 test target. The setting and the help still state the caveat: on a big box the
    conflicting DF1 is a second internal drive, and the external port there is DF2, which the board does not see.
- **DF1 is read-only in v1.** The board ignores WGATE on SEL1, and WPROT is asserted on DF1.
- **DF1 holds only "the next disk of the set"** in v1. There is no disk picker.
- **Real DF1 detected (`df1Seen`):** the web app refuses to switch DF1 on. An explicit override sits behind a second
  confirmation.
- **The setting:**
  - default Off, per board;
  - takes effect at the next Amiga restart;
  - persisted on the board and applied at boot, before `bus_out_init`.
- **The bus sniffer may move** (e.g. to pio2). Every layout tradeoff is a decision point, measured first (Task 5).
- **Idea 4 ("insert disk 2" detection) is OUT** of this plan.
- **Bench uses the library's Workbench 3.1 disk set** (Install/Workbench/Locale/Extras/Fonts/Storage). DF1 = next
  disk of the set. Query it with `info` and `dir df1:`.
- **Help** covers exactly these caveats:
  - read-only DF1;
  - takes effect at the next Amiga restart (cold or warm);
  - only when no other drive is DF1;
  - DF1 empties for ~5 s on Next disk;
  - DF1 holds only the next disk;
  - the `df1Seen` refusal and its override;
  - Kickstart 1.3 vs 2.0+ notes, **only if verified on the bench**;
  - the firmware version needed.
- **Verification is scaled down:**
  - e2e runs only the specs named per phase, on `PORT=3100`, serialized (the e2e suite shares the live DB);
  - firmware runs `test/run.sh` plus the device build;
  - bench steps are the operator's, one physical step per turn, with pass or fail visible at a glance.

## Global Constraints

- **Firmware versions.** `FIRMWARE_SEMVER` in `wifi-floppy/firmware/CMakeLists.txt` is 1.7.4 today. Each phase bumps
  it once, in its last task:
  - Phase 0 → **1.7.5**;
  - Phase 1 → **1.7.6**;
  - Phase 2 → **1.8.0**;
  - Phase 3 → **1.9.0**.

  If a hotfix lands in between, take the next free number and change every "1.9.0" string in this plan's Phase 3
  code (help text, UI copy, tests) to match. The help topic's version claim must equal the version that ships
  the web-settable setting.
- **Releases:** `pnpm firmware:publish --notes "..."` (registry is append-only; installs go over the air to boards
  someone targets). A bench-only build is published with notes starting `TEST build` and is never announced.
  **Never install 1.7.0 or 1.7.1** (HANDOFF 3ax).
- **Stack:**
  - core0's stack is 4 KB (`PICO_STACK_SIZE=0x1000`);
  - the device build fails any frame over 768 bytes (`-Werror=frame-larger-than=768`);
  - new buffers are `static`, never on the stack.
- **Status pads:**
  - `bus_out_set*()` is the only writer of INDEX/CHNG/WPROT/RDY/TRK0;
  - `gpio_put` on them does nothing (`test/run.sh` fails on one);
  - **never `pio_encode_mov(pio_osr|pio_exec, …)`**: build MOV words from fields, as `drive_id_load` does
    (`test/run.sh` fails on one).
- **Flash map (top of flash, one sector each):**
  - -1 token, -2 config, -3 fw_state, -4 display;
  - **-5 drive_store (new)**.
- **DF1 needs `WF_DRIVE_ID=ON`** (without the responder DF1's ID reads 0 = no drive). With `WF_DRIVE_ID=OFF` the board
  never reports `secondDrive` and DF1 stays released.
- **PSRAM is unchanged:**
  - two slots of 2,293,760 B plus the 2 MiB stage;
  - no third slot;
  - DF1 only ever serves the idle slot, holding the preloaded next disk.
- **Slot invariants (pinned in `psram_image.c`, tested):**
  - DF1's slot is never DF0's slot;
  - DF1 holds a disk only while DF0 does;
  - nothing writes into a slot DF1 publishes until core0 has acknowledged DF1's eject.
- **Help text rules (`src/lib/help/topics.tsx`):**
  - every claim carries a source comment;
  - banned words: PSRAM, TBYB, poll, sha256, cursor, WPROT;
  - the body is 60-260 words, the short 1-2 sentences.
- **Migrations:** hand-trimmed SQL in `drizzle/`, `IF NOT EXISTS`, additive. Generate with
  `pnpm db:generate --name <name>` to keep the snapshot and journal, then trim. Apply to the live DB with `psql`
  **before** e2e and before the merge to master (master deploys to production).
- **e2e:**
  - `PORT=3100`, serialized, never two runs at once;
  - each command split to finish in under 9 minutes, in the foreground;
  - never `pkill` by pattern; stop only your own PIDs;
  - no `git stash`, `git checkout` or `git reset` in this shared tree; check `git status` before staging.
- **"Show both values of a state":** every new reading on the device card renders both of its values in words.

## Decision points (each is settled by a measurement in this plan, before the code that depends on it)

| ID | Question | Measured in | Default if the measurement agrees |
|---|---|---|---|
| D1 | PIO layout with DF1: does pio2 hold `step_dir` + `flux_in` + radio (+ sniffer)? | Task 5 (SDK source + the operator reads `pio claims:` on the bench) | flux_in AND the sniffer move to pio2 (4 SMs, 30 of 32 instructions in a sniff build) |
| D2 | DF1's DMA word buffer: DD-only (+14,336 B), HD-capable (+25,344 B), or zero-copy (+0 B, DMA byte-swap from a 3-buffer pool) | Task 5 (heap low-water from the board log + `arm-none-eabi-size`) | DD-only if `low-water − 14,336 ≥ 20,480`; else stop and ask the operator |
| D3 | What switching DF1 off at runtime does before the board next boots | Ruled in this plan (Task 19), bench-checked in Phase 3 | "parked": DF1 empty, CHNG asserted, ID 0; fully released from the next board boot |
| D4 | Sniffer: on pio2, or exclusive with DF1 | Same as D1 | on pio2 if D1's count fits; otherwise `WF_BUS_SNIFF` builds with DF1 compiled out (CMake `FATAL_ERROR` if both are set) |

**Already verified while writing this plan (re-confirm in Task 5, do not assume):**
- **Pin-write priority.** RP2350 datasheet RP-008373-DS-2, §11.2.6 "Pin mapping" (p. 883-884, the local copy is
  `~/Downloads/RP-008373-DS-2-rp2350-datasheet.pdf`): "For each individual GPIO output (level and direction
  separately), PIO considers all 8 writes that may have occurred on that cycle, and applies the write from the
  highest-numbered state machine … If no state machine writes to this GPIO output, its value does not change from
  the previous cycle."
  - The spec's "(unverified here)" is answered: highest-numbered wins, otherwise the last write holds.
- **Side-set during a stall.** Same datasheet, §11.2.5 note: "Side-set … always takes place on the first cycle of
  the attached instruction", even if it stalls.
  - So a DF1 `flux_out` stalled on an empty FIFO at `out x, 1 side 0` would hold RDATA low forever and veto DF0's
    pulses. Dropping `side 0` from every non-pulse instruction is required, not optional.
- **The radio's PIO program.** `~/pico-sdk/src/rp2_common/pico_cyw43_driver/cyw43_bus_pio_spi.pio`: the default
  `spi_gap01_sample0` is 6 instructions (`cyw43_bus_pio_spi.c:37`), and it is claimed with
  `pio_claim_free_sm_and_add_program_for_gpio_range` (`:119`).

## Review Focus

These failure modes are not exercised by any single task's happy-path tests. Each has a pinning test in the
named task.

1. **Core1 overwrites the slot DF1 is streaming:** a regular mount or a preload writes into the idle slot while
   core0 is still copying a DF1 track from it.
   - Expected: DF1 is ejected and core0 acknowledges before the first byte is written.
   - Pinned in Task 13 (`test_psram_image`: quiescence cursor) and Task 15 (`test_device_client`: a fetch that
     finds DF1 un-acknowledged writes nothing).
2. **"Next disk" with DF1 holding that same slot:** DF0 publishes slot B while DF1 serves slot B.
   - Expected: DF1 is ejected in the same publish, never two drives on one slot.
   - Pinned in Task 13 (`psram_publish_slot` ejects a DF1 on the same slot).
3. **An eject of DF0 (desired null) while DF1 holds a disk.**
   - Expected: DF1 empties too. DF1 never holds a disk while DF0 is empty.
   - This also keeps every existing flash-write guard (`psram_active_slot() != SLOT_NONE`) sufficient.
   - Pinned in Task 13.
4. **The poll body's `secondDrive` object carries a key that collides with the top-level `version`.**
   - Expected: it is lifted and blanked before any flat lookup, and named `seq`, not `version`.
   - Pinned in Task 18 (`a_second_drive_object_never_shadows_the_poll_version`).
5. **An HD next disk with a DD-only DF1 buffer (D2).**
   - Expected: DF1 stays empty and reports `df1Sha256: null`. It never streams a truncated HD track.
   - Pinned in Task 15 (`an_hd_next_disk_stays_off_a_dd_only_df1`).

Also covered:
- the power-event burst (16 STEP edges in 1 ms, all lines floating) must not latch `df1Seen`: Task 1;
- a re-paired board with a higher stored `driveAck`: Task 18;
- the status body at its maximum with every new field: Tasks 2, 15 and 18.

---

## File Structure

**Firmware (`wifi-floppy/firmware/`)**

| File | Responsibility | Phase |
|---|---|---|
| `src/bus_gate.{h,c}` | `bus_step_t.sel_mask` (both selects); `bus_df1_seen()` threshold | 0 |
| `src/main.c` | SEL1 IRQ latch, DF1 step count (0); per-drive bus state, pio2 moves (1); DF1 stream, DMA, reader ack, boot mode (2); live mode handoff, deferred store write (3) | 0-3 |
| `src/device_client.{h,c}` | status `sel1Wired`/`df1Seen` (0); `df1Sha256`, DF1 reconcile, write-guard (2); `driveAck`, `secondDrive` lift, status `secondDrive`/`driveVersion` (3) | 0,2,3 |
| `src/floppy.pio` | status_gate release-on-edge; flux_out side-set only on the pulse; drive_id `wait pin` | 1 |
| `src/bus_model.{h,c}` (new, host-only like `drive_id.c`) | model of N status_gate + N flux_out SMs on shared pads with the datasheet's priority rule | 1 |
| `src/drive_id.h` | `drive_id_kind_t`, `drive_id_load_kind()` incl. NONE | 1 |
| `src/bus_out.{h,c}` | per-drive shadows, status_gate SM per drive, drive_id SM per drive | 1 |
| `src/board.c` | drop "SEL0 must be GP2" | 1 |
| `src/dskchg.{h,c}` | `st[2]`, `_d(drive)` API, old names as drive-0 wrappers | 1 |
| `src/psram_image.{h,c}` | DF1 published word, reader-ack cursor, slot invariants | 2 |
| `src/track_cache.{h,c}` | `track_cache_get_token()` | 2 |
| `src/drive_store.{h,c}` (new) | flash record {version, mode} at top-5 sector | 2 |
| `CMakeLists.txt` | new sources; `WF_DF1_DEFAULT`; `WF_DF1_HD`; sniff/DF1 guard; version bumps | 0-3 |
| `test/test_bus_gate.c`, `test/test_bus_model.c` (new), `test/test_floppy_pio_golden.c` (new), `test/test_drive_id_pio.c`, `test/test_board.c`, `test/test_psram_image.c`, `test/test_track_cache.c`, `test/test_drive_store.c` (new), `test/test_device_client.c` | host tests | 0-3 |

**Web**

| File | Responsibility | Phase |
|---|---|---|
| `drizzle/0031_sel1_telemetry.sql`, `drizzle/0032_second_drive.sql` | columns | 0, 3 |
| `src/db/schema/devices.ts` | columns | 0, 3 |
| `src/app/api/device/status/route.ts` (+ `route.test.ts`) | parse new telemetry | 0, 2, 3 |
| `src/lib/mount.ts` | `recordStatus` fields; `PollTick` gains second-drive cursor | 0, 3 |
| `src/lib/queries.ts` | `DeviceListItem` fields | 0, 3 |
| `src/lib/second-drive.ts` (new, + test) | `saveSecondDrive` (guarded UPDATE), texts | 0, 3 |
| `src/app/api/devices/[id]/second-drive/route.ts` (new, + test) | PATCH | 3 |
| `src/app/api/device/poll/route.ts` (+ test) | `driveAck`, `secondDrive` body | 3 |
| `src/lib/device-limits.test.ts` | poll body budget | 3 |
| `src/components/devices/second-drive-readings.tsx` (new) | the two readings on the card | 0 |
| `src/components/devices/second-drive-setting.tsx` (new) | Off / Next disk of the set, refusal, override | 3 |
| `src/components/devices/device-card.tsx` | wire both | 0, 3 |
| `src/lib/help/topics.tsx` (+ test) | topic `second-drive` | 3 |
| `e2e/second-drive.spec.ts` (new) | setting + refusal + override | 3 |

---

# PHASE 0 — SEL1 telemetry (firmware 1.7.5, migration 0031)

### Task 1: Decode both selects in a step word; the df1-seen rule

**Files:**
- Modify: `wifi-floppy/firmware/src/bus_gate.h`, `wifi-floppy/firmware/src/bus_gate.c`
- Test: `wifi-floppy/firmware/test/test_bus_gate.c`

**Interfaces:**
- Produces:
  - `#define BUS_SEL_DF0 0x1u`, `#define BUS_SEL_DF1 0x2u`;
  - `bus_step_t` gains `uint8_t sel_mask`, a bitwise OR of the selects that were low. `selected` keeps meaning
    "SEL0 low".
  - `#define BUS_DF1_SEEN_STEPS 3u`;
  - `bool bus_df1_seen(uint32_t df1_steps)`.

- [ ] **Step 1: Write the failing tests** (append to `test/test_bus_gate.c`, register in `main` with `RUN`)

```c
// SEL1 is bit 1 of the step word (GP3 when SEL0 is GP2). Both active low.
static void step_word_names_every_select_that_was_low(void) {
    // bits: 0 SEL0, 1 SEL1, 2 MTR, 3 DIR (1 = released / outwards)
    bus_step_t a = bus_step_decode(0x2u);          // SEL0 low, SEL1 high
    CHECK_EQ_INT(a.sel_mask, BUS_SEL_DF0);
    CHECK(a.selected, "SEL0 low: DF0's step");
    bus_step_t b = bus_step_decode(0x1u);          // SEL0 high, SEL1 low
    CHECK_EQ_INT(b.sel_mask, BUS_SEL_DF1);
    CHECK(!b.selected, "a DF1 step is not DF0's");
    bus_step_t c = bus_step_decode(0x0u);          // both low: both drives step, as real ones would
    CHECK_EQ_INT(c.sel_mask, BUS_SEL_DF0 | BUS_SEL_DF1);
    bus_step_t d = bus_step_decode(0x3u | 0x8u);   // neither, DIR outwards
    CHECK_EQ_INT(d.sel_mask, 0);
    CHECK(d.outwards, "DIR still decoded");
}

// A real DF1 steps (disk-change clicks, recalibrates); an absent one never does:
// all 1,838 STEP falls of a no-DF1 boot came with SEL0 (floppy.pio step_dir header).
// Three, not one: the power-event burst (HANDOFF, main.c step filter comment) is
// rejected by the 1 ms filter BEFORE counting, but one stray filtered pulse at a
// power edge must still not read as a drive.
static void df1_is_seen_only_after_several_steps(void) {
    CHECK(!bus_df1_seen(0), "no steps: none seen");
    CHECK(!bus_df1_seen(BUS_DF1_SEEN_STEPS - 1), "below the threshold: none seen");
    CHECK(bus_df1_seen(BUS_DF1_SEEN_STEPS), "at the threshold: seen");
    CHECK(bus_df1_seen(250), "the 4e bench count: seen");
}
```

- [ ] **Step 2: Run, expect a compile failure** — `cd wifi-floppy/firmware && test/run.sh 2>&1 | grep -A3 test_bus_gate`
  Expected: `COMPILE FAIL: test_bus_gate.c` (no `sel_mask`, no `bus_df1_seen`).

- [ ] **Step 3: Implement**

In `bus_gate.h`, replace the `bus_step_t` block with:

```c
#define BUS_SEL_DF0 0x1u
#define BUS_SEL_DF1 0x2u
// One step_dir word: GP(SEL0)..GP(SEL0+3) (SEL0 SEL1 MTR DIR) as sampled when STEP fell.
typedef struct {
    bool    selected;   // SEL0 asserted (low): the step is DF0's
    bool    outwards;   // DIR high: towards track 0
    uint8_t sel_mask;   // BUS_SEL_DF0 | BUS_SEL_DF1: every select that was low
} bus_step_t;
bus_step_t bus_step_decode(uint32_t word);

// A real DF1 on the bus (spec §3): it steps; an absent DF1 never does. Counts
// only steps that passed the 1 ms too-fast filter, taken while the board's own
// DF1 is off.
#define BUS_DF1_SEEN_STEPS 3u
bool bus_df1_seen(uint32_t df1_steps);
```

In `bus_gate.c`:

```c
bus_step_t bus_step_decode(uint32_t word) {
    // Bit n = GP(PIN_SEL0 + n), active low through the '541.
    bus_step_t s;
    s.selected = (word & BIT(PIN_SEL0 - PIN_SEL0)) == 0;
    s.outwards = (word & BIT(PIN_DIR - PIN_SEL0)) != 0;
    s.sel_mask = (uint8_t)((s.selected ? BUS_SEL_DF0 : 0u) |
                           ((word & BIT(PIN_SEL1 - PIN_SEL0)) == 0 ? BUS_SEL_DF1 : 0u));
    return s;
}

bool bus_df1_seen(uint32_t df1_steps) { return df1_steps >= BUS_DF1_SEEN_STEPS; }
```

- [ ] **Step 4: Run, expect PASS** — `test/run.sh 2>&1 | grep test_bus_gate.c` → `test_bus_gate.c: N checks, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/bus_gate.h wifi-floppy/firmware/src/bus_gate.c wifi-floppy/firmware/test/test_bus_gate.c
git commit -m "feat(bus): decode SEL1 in step words; df1-seen threshold"
```

### Task 2: Firmware reports `sel1Wired` and `df1Seen`

**Files:**
- Modify: `wifi-floppy/firmware/src/main.c` (`gpio_isr` ~1031, `step_pulse` ~570, the GPIO IRQ setup ~2617,
  core1's status call site where `dc_set_plays_hd` is called), `wifi-floppy/firmware/src/device_client.{h,c}`
- Test: `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Consumes: `bus_step_decode().sel_mask`, `bus_df1_seen()` (Task 1).
- Produces:
  - `void dc_set_sel1(device_client_t *c, bool wired, bool df1_seen)`;
  - status body tail `,"sel1Wired":true|false,"df1Seen":true|false`, present once `dc_set_sel1` was called;
  - in `main.c`, the volatiles `g_sel1_wired` (bool) and `g_df1_steps` (u32), read by core1.

- [ ] **Step 1: Write the failing tests** (`test/test_device_client.c`; register both with `RUN` next to
  `test_status_reports_plays_hd_only_when_set`)

```c
static void test_status_reports_both_sel1_readings_once_known(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.5"), "sent");
    CHECK(strstr(fake_last_request(), "sel1Wired") == NULL, "not known yet: no key");

    dc_set_sel1(&c, false, false);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.5"), "sent");
    CHECK(strstr(fake_last_request(), "\"sel1Wired\":false,\"df1Seen\":false") != NULL,
          "both values, false too -- an absent key is not a reading");

    dc_set_sel1(&c, true, true);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.5"), "sent");
    CHECK(strstr(fake_last_request(), "\"sel1Wired\":true,\"df1Seen\":true") != NULL, "true values");
}
```

Also, in `test_status_body_fits_at_maximum`, add `dc_set_sel1(&c, false, false);` (the longer spelling) before
the send, and this check after the existing ones:

```c
    CHECK(strstr(r, "\"df1Seen\":false") != NULL, "the SEL1 readings survive a maximal body");
```

- [ ] **Step 2: Run, expect a compile failure** — `test/run.sh 2>&1 | grep -B2 -A5 test_device_client`
  Expected: `implicit declaration of function 'dc_set_sel1'`.

- [ ] **Step 3: Implement in `device_client`**

`device_client.h`, in `device_client_t` after `display_reset_to_default`:

```c
    // --- DF1 second drive (spec 2026-10-08) ---
    // SEL1 telemetry: sent as both values once main.c has said anything.
    bool     _sel1_known;
    bool     _sel1_wired;      // a SEL1 select was seen since boot
    bool     _df1_seen;        // bus_df1_seen(): a real DF1 stepped while ours was off
```

and the declaration:

```c
// SEL1 telemetry (spec §3/§6 step 0). Both values are always sent once set.
void dc_set_sel1(device_client_t *c, bool wired, bool df1_seen);
```

`device_client.c`, next to `dc_set_plays_hd`:

```c
void dc_set_sel1(device_client_t *c, bool wired, bool df1_seen) {
    c->_sel1_known = true;
    c->_sel1_wired = wired;
    c->_df1_seen = df1_seen;
}
```

In `dc_report_status`, before `static char body[...]`:

```c
    // SEL1 (spec §6 step 0): both readings, both values, once main.c knows.
    // 34 bytes at most; DC_STATUS_BODY_BYTES had 63 to spare (header note).
    static char sel1_tail[48];
    if (c->_sel1_known) {
        snprintf(sel1_tail, sizeof sel1_tail, ",\"sel1Wired\":%s,\"df1Seen\":%s",
                 c->_sel1_wired ? "true" : "false", c->_df1_seen ? "true" : "false");
    } else {
        sel1_tail[0] = '\0';
    }
```

Change the body format's tail from `"\"trackMaxBytes\":%u%s%s%s%s%s}"` to `"\"trackMaxBytes\":%u%s%s%s%s%s%s}"`, and
add `sel1_tail` as the last argument (after the `playsHd` conditional). In the header note above
`DC_STATUS_BODY_BYTES`, append: "SEL1 telemetry (2026-10-08) adds 34; the body then has 29 left."

- [ ] **Step 4: Run, expect PASS** — `test/run.sh 2>&1 | grep test_device_client.c` → `0 failed`.

- [ ] **Step 5: Wire `main.c`**

Near `steps_other_drive`:

```c
// SEL1 telemetry (spec 2026-10-08 §6 step 0). g_sel1_wired: any SEL1 fall
// since boot -- Kickstart reads DF1's ID with 34 selects at every reset
// (HANDOFF 4d), so a wired pin 12 shows within a second of power-on. The
// GPIO interrupt switches itself off after the first edge: a real DF1 being
// read would otherwise interrupt on every select. g_df1_steps: SEL1 steps that
// passed the 1 ms filter while the board's own DF1 is off.
static volatile bool     g_sel1_wired;
static volatile uint32_t g_df1_steps;
static absolute_time_t   g_df1_last_step;   // STEP ISR only
```

In `step_pulse`, replace the `if (!st.selected) { steps_other_drive++; return; }` block with:

```c
    if (!st.selected) {
        steps_other_drive++;
        if (st.sel_mask & BUS_SEL_DF1) {
            const absolute_time_t t = get_absolute_time();
            // Same 1 ms rule as DF0's, with its own clock: the power-event
            // burst must not count as a drive.
            if (absolute_time_diff_us(g_df1_last_step, t) >= STEP_MIN_INTERVAL_US) g_df1_steps++;
            g_df1_last_step = t;
        }
        return;
    }
```

In `gpio_isr`, add a first branch:

```c
    if (gpio == PIN_SEL1 && (events & GPIO_IRQ_EDGE_FALL)) {
        g_sel1_wired = true;
        gpio_set_irq_enabled(PIN_SEL1, GPIO_IRQ_EDGE_FALL, false);   // one edge is the reading
        return;
    }
```

After `gpio_set_irq_enabled(PIN_SIDE, ...)`, add:

```c
    gpio_set_irq_enabled(PIN_SEL1, GPIO_IRQ_EDGE_FALL, true);
```

Where core1 calls `dc_set_plays_hd(&c, ...)` before each status report, add:

```c
        dc_set_sel1(&c, g_sel1_wired, bus_df1_seen(g_df1_steps));
```

Add a log line to the existing periodic `steps_other_drive` report (the `uint32_t os = steps_other_drive` block near
the end of `main`). Print `sel1: wired %s, df1 steps %lu` only when either value changed since the last print.

- [ ] **Step 6: Device build** — `pnpm firmware:build 2>&1 | tail -5`. Expected: links with no
  `frame-larger-than` error.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/main.c wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c wifi-floppy/firmware/test/test_device_client.c
git commit -m "feat(fw): report sel1Wired and df1Seen in status"
```

### Task 3: Web stores and shows the two readings

**Files:**
- Create: `drizzle/0031_sel1_telemetry.sql`, `src/lib/second-drive.ts`, `src/lib/second-drive.test.ts`,
  `src/components/devices/second-drive-readings.tsx`
- Modify: `src/db/schema/devices.ts`, `src/app/api/device/status/route.ts`, `src/app/api/device/status/route.test.ts`,
  `src/lib/mount.ts` (`recordStatus`), `src/lib/queries.ts` (`DeviceListItem` + select), `src/components/devices/device-card.tsx`

**Interfaces:**
- Produces:
  - `DeviceListItem.sel1Wired: boolean | null`, `DeviceListItem.df1Seen: boolean | null`;
  - `sel1Text(wired: boolean): string`, `df1SeenText(seen: boolean): string` in `src/lib/second-drive.ts`;
  - test ids `device-sel1-<id>`, `device-df1seen-<id>`.

- [ ] **Step 1: Migration and schema**

```sql
-- drizzle/0031_sel1_telemetry.sql  (spec 2026-10-08 df1-second-drive §6 step 0; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "sel1_wired" boolean;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "df1_seen" boolean;
```

In `devices.ts`, after `displayLayouts`:

```ts
  // --- DF1 second drive (spec 2026-10-08) ---
  /** A SEL1 select reached the board since its last boot; null = firmware before 1.7.5. */
  sel1Wired: boolean('sel1_wired'),
  /** A real drive stepped as DF1 while the board's own DF1 was off; null = firmware before 1.7.5. */
  df1Seen: boolean('df1_seen'),
```

Run `pnpm db:generate --name sel1_telemetry`, then trim the generated SQL to exactly the file above, keeping the
snapshot and journal (as 0030 did).

- [ ] **Step 2: Failing tests**

`src/lib/second-drive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sel1Text, df1SeenText } from './second-drive';

describe('second-drive readings', () => {
  it('names both values of the SEL1 line', () => {
    expect(sel1Text(true)).toBe('DF1 line: connected');
    expect(sel1Text(false)).toBe('DF1 line: no signal yet');
  });
  it('names both values of the other-drive check', () => {
    expect(df1SeenText(true)).toBe('Other DF1 drive: detected');
    expect(df1SeenText(false)).toBe('Other DF1 drive: none seen');
  });
});
```

Append to `src/app/api/device/status/route.test.ts`, in the file's existing style. Read the file first and reuse
its `post()` helper and its `recordStatus` mock name:

```ts
it('passes sel1Wired and df1Seen through, and drops malformed values instead of rejecting', async () => {
  let res = await post({ mountedSha256: null, sel1Wired: true, df1Seen: false });
  expect(res.status).toBe(204);
  expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ sel1Wired: true, df1Seen: false }));
  res = await post({ mountedSha256: null, sel1Wired: 'yes', df1Seen: 3 });
  expect(res.status).toBe(204);
  expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ sel1Wired: undefined, df1Seen: undefined }));
});
```

- [ ] **Step 3: Run, expect FAIL** — `pnpm vitest run src/lib/second-drive.test.ts src/app/api/device/status/route.test.ts`

- [ ] **Step 4: Implement**

`src/lib/second-drive.ts`:

```ts
// DF1 second drive (spec docs/superpowers/research/2026-10-08-df1-second-drive.md).
// Texts for the device card's readings: both values of each state, in words.

export function sel1Text(wired: boolean): string {
  return wired ? 'DF1 line: connected' : 'DF1 line: no signal yet';
}

export function df1SeenText(seen: boolean): string {
  return seen ? 'Other DF1 drive: detected' : 'Other DF1 drive: none seen';
}
```

`status/route.ts`, in `statusBody` after `displayError`:

```ts
  // DF1 telemetry (fw 1.7.5+). Dropped, never rejected -- the telemetry rule above.
  sel1Wired: z.boolean().optional().catch(undefined),
  df1Seen: z.boolean().optional().catch(undefined),
```

and in the `recordStatus` call: `sel1Wired: parsed.data.sel1Wired, df1Seen: parsed.data.df1Seen,`.

In `mount.ts`, extend `recordStatus`'s parameter type with `sel1Wired?: boolean; df1Seen?: boolean;` and add after
the display block:

```ts
  // Build-bound, the playsHd rule: a report naming its firmware but silent on
  // SEL1 comes from a build before 1.7.5 (or a reverted trial) -- no reading.
  if (s.sel1Wired !== undefined) patch.sel1Wired = s.sel1Wired;
  else if (s.firmwareVersion !== undefined) patch.sel1Wired = null;
  if (s.df1Seen !== undefined) patch.df1Seen = s.df1Seen;
  else if (s.firmwareVersion !== undefined) patch.df1Seen = null;
```

In `queries.ts`, add `sel1Wired: boolean | null; df1Seen: boolean | null;` to `DeviceListItem`, and add
`sel1Wired: devices.sel1Wired, df1Seen: devices.df1Seen,` to the select next to `displayLayouts`.

`src/components/devices/second-drive-readings.tsx`:

```tsx
import type { DeviceListItem } from '@/lib/queries';
import { sel1Text, df1SeenText } from '@/lib/second-drive';

/** The board's two SEL1 readings, as words. Nothing for firmware too old to make them. */
export function SecondDriveReadings({ device }: { device: DeviceListItem }) {
  if (device.sel1Wired === null || device.df1Seen === null) return null;
  return (
    <span className="flex flex-col text-[11px]" style={{ color: 'var(--muted)' }}>
      <span data-testid={`device-sel1-${device.id}`} data-value={String(device.sel1Wired)}>
        {sel1Text(device.sel1Wired)}
      </span>
      <span data-testid={`device-df1seen-${device.id}`} data-value={String(device.df1Seen)}>
        {df1SeenText(device.df1Seen)}
      </span>
    </span>
  );
}
```

In `device-card.tsx`, import it and render `<SecondDriveReadings device={device} />` inside the BOTTOM block, just
above the protection tag.

- [ ] **Step 5: Run, expect PASS** — `pnpm vitest run src/lib src/app/api/device/status` and `pnpm tsc --noEmit`.

- [ ] **Step 6: Apply the migration to the live DB** (additive; same as 0030)

```bash
DB=$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"'); psql "$DB" -v ON_ERROR_STOP=1 -f drizzle/0031_sel1_telemetry.sql
```

- [ ] **Step 7: Scoped e2e** (serialized, PORT=3100, each command under 9 min):
  `PORT=3100 pnpm e2e e2e/device-status.spec.ts e2e/devices-page.spec.ts`, then
  `PORT=3100 pnpm e2e e2e/mobile.spec.ts`. All pass.
  - If any of them seeds a device with fixtures typed as `DeviceListItem`, add `sel1Wired: null, df1Seen: null`.

- [ ] **Step 8: Commit** (body: "Migration 0031 applied to the live DB before e2e.")

```bash
git add drizzle/0031_sel1_telemetry.sql drizzle/meta src/db/schema/devices.ts src/app/api/device/status src/lib/mount.ts src/lib/queries.ts src/lib/second-drive.ts src/lib/second-drive.test.ts src/components/devices/second-drive-readings.tsx src/components/devices/device-card.tsx
git commit -m "feat(devices): store and show the board's SEL1 readings"
```

### Task 4: Ship 1.7.5 and Phase 0 bench

**Files:** Modify `wifi-floppy/firmware/CMakeLists.txt` (`set(FIRMWARE_SEMVER "1.7.5")`), `HANDOFF.md` (new section 3bb)

- [ ] **Step 1:** Bump the version. Run `test/run.sh` (all green) and `pnpm firmware:build` (clean). Commit
  `chore(fw): 1.7.5 -- SEL1 telemetry`.
- [ ] **Step 2:** Merge to master after the scoped e2e (deploys the web part). Then run
  `pnpm firmware:publish --notes "SEL1 telemetry (DF1 groundwork)"` and target WifiFloppy1 (installs are authorized;
  same path as the Update button).
- [ ] **Step 3: Bench checklist, Phase 0** (operator; one physical step per turn; A500 rev 8a.1, internal connector)
  1. **Without the external drive:** switch the Amiga off, then on (this also reboots the board), and let Workbench
     boot from DF0.
     - PASS: the device card shows **"DF1 line: connected"** and **"Other DF1 drive: none seen"**.
     - FAIL: "no signal yet" means pin 12 does not carry SEL1 on this machine. Stop: DF1 cannot work from the
       internal connector here.
  2. **Pio claims and heap.** With USB serial attached before power-on, switch the Amiga off and on. Record:
     - the `pio claims: pio0=.. pio1=.. pio2=..` line;
     - the lowest `heap: free low-water N bytes` line after Workbench has booted and a disk has been mounted
       for one minute.

     Paste both into HANDOFF 3bb. These are Task 5's inputs.
  3. **Only if the operator wants the conflict check now** (needs the real external drive): switch the Amiga off,
     fit the external drive with a disk in it, and switch on.
     - PASS: within a minute the card reads **"Other DF1 drive: detected"**.
     - Then switch off, remove the drive, and switch on again: the card reads **"none seen"**.
  - This settles HANDOFF's owed "SEL1 on pin 12" item for the A500.

---

# PHASE 1 — Behaviour-unchanged refactor (firmware 1.7.6)

### Task 5: Measure before choosing a layout (D1, D2, D4)

**Files:** Modify `HANDOFF.md` (3bb), and this plan's "Decision ledger" at the end (append rows). No code.

- [ ] **Step 1: Pin-write priority.** Open the datasheet at §11.2.6 and confirm the quote in "Already verified"
  above, word for word. If it differs, STOP: the two-SM designs in Tasks 6-8 rest on it.
- [ ] **Step 2: Radio program size.** Run:
  `grep -n "SPI_PROGRAM_NAME\|CYW43_SPI_PROGRAM_NAME" ~/pico-sdk/src/rp2_common/pico_cyw43_driver/cyw43_bus_pio_spi.c`
  and `grep -rn CYW43_SPI_PROGRAM_NAME wifi-floppy/firmware`.
  - Expected: the default `spi_gap01_sample0`, 6 instructions, not overridden here.
- [ ] **Step 3: PIO IRQ use by the radio.** Run
  `grep -n "pio_set_irq\|PIO_IRQ\|irq_set" ~/pico-sdk/src/rp2_common/pico_cyw43_driver/cyw43_bus_pio_spi.c`.
  - Expected: none. Then the sniffer can use pio2's IRQ1 and `step_dir` keeps IRQ0.
  - If it uses a PIO IRQ, note which one and pick the other for the sniffer.
- [ ] **Step 4: D1/D4 arithmetic** from Phase 0's bench line `pio claims:`. pio2 must show exactly two SMs today
  (step_dir + radio). The planned pio2 load in a sniff build:

  | Program | SMs | Instructions |
  |---|---|---|
  | step_dir | 1 | 4 |
  | flux_in | 1 | 7 |
  | radio | 1 | 6 |
  | bus_sniff | 1 | 13 |
  | total | 4 of 4 | 30 of 32 |

  - Without the sniffer: 3 SMs and 17 instructions.
  - If `pio claims` shows pio2 with more than two SMs, or the radio not on pio2, STOP and report to the
    operator. The layout then needs an operator decision.
  - **D4 recommendation to record:** the sniffer moves to pio2 alongside DF1. It is not made exclusive.
- [ ] **Step 5: D2 arithmetic.** Run
  `arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | grep -E "\.bss|\.data|\.heap"`
  and take the Phase 0 bench heap low-water `H`.
  - DD-only DF1 costs 14,336 B of `.bss` (one `uint32_t[3584]`).
  - Record `H − 14,336`. If it is ≥ 20,480 (the floor from HANDOFF 3ao step 5), D2 = **DD-only**:
    `WF_DF1_HD=OFF` and an HD next disk leaves DF1 empty.
  - If it is below 20,480, STOP. Ask the operator whether to fund the zero-copy option (DMA byte-swap
    `channel_config_set_bswap` streaming straight from a 3-buffer track_cache pool, +0 B, which touches DF0's hot
    path) or to drop DF1. Note: HD-capable (+25,344 B) cannot pass the floor if DD-only does not.
- [ ] **Step 6: Commit** the ledger rows and HANDOFF 3bb: `docs: DF1 layout measurements (D1, D2, D4)`.

### Task 6: PIO programs take their select as a parameter; a model of shared pads

**Files:**
- Modify: `wifi-floppy/firmware/src/floppy.pio`, `wifi-floppy/firmware/src/drive_id.h`
- Create: `wifi-floppy/firmware/src/bus_model.h`, `wifi-floppy/firmware/src/bus_model.c` (host-only, NOT added to
  `add_executable`, like `drive_id.c`), `wifi-floppy/firmware/test/test_bus_model.c`,
  `wifi-floppy/firmware/test/test_floppy_pio_golden.c`
- Modify: `wifi-floppy/firmware/test/test_drive_id_pio.c` (golden array + `drive_id_load_kind`)

**Interfaces:**
- Produces:
  - `typedef enum { DRIVE_ID_KIND_NONE, DRIVE_ID_KIND_DD, DRIVE_ID_KIND_HD } drive_id_kind_t;`
  - `static inline uint16_t drive_id_load_kind(drive_id_kind_t k)`;
  - `drive_id_load(bool hd)` stays as `drive_id_load_kind(hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD)`;
  - `drive_id_program_init(pio, sm, offset, sel_pin, rdy_pin, mtr_pin, hd_id)`;
  - `status_gate_program_init(pio, sm, offset, sel_pin, out_count, pin_mask)`, a parameter rename only;
  - `flux_out_program_init(pio, sm, offset, pin, sel_pin)`, unchanged.
  - `bus_model.h` (below).

- [ ] **Step 1: Write the model's failing test** `test/test_bus_model.c`

```c
#include "harness.h"
#include "../src/bus_model.h"

// Two status_gate SMs and two flux_out SMs on ONE PIO, sharing the status pads
// and RDATA, under RP2350 datasheet §11.2.6: the highest-numbered SM writing a
// pin in a cycle wins; a pin nobody writes keeps its level. The board is right
// iff the pads show drive k's word while only SEL_k is low, and nothing while
// neither is.

static void each_drive_owns_the_pads_only_during_its_own_select(void) {
    bus_model_t m; bus_model_init(&m, 2);
    bus_model_set_word(&m, 0, 0x0F);   // DF0 asserts four status pins
    bus_model_set_word(&m, 1, 0x30);   // DF1 asserts two others
    bus_model_select(&m, 0x1);  bus_model_run(&m, 20);
    CHECK_EQ_INT(bus_model_pads(&m), 0x0F);
    bus_model_select(&m, 0x0);  bus_model_run(&m, 20);
    CHECK_EQ_INT(bus_model_pads(&m), 0x00);
    bus_model_select(&m, 0x2);  bus_model_run(&m, 20);
    CHECK_EQ_INT(bus_model_pads(&m), 0x30);
    bus_model_select(&m, 0x1);  bus_model_run(&m, 20);   // straight from DF1 to DF0
    CHECK_EQ_INT(bus_model_pads(&m), 0x0F);
}

// The 1.7.4 program wrote `mov pins, null` on every released loop: a second
// SM doing that would overwrite the first ~every 33 ns.
static void a_released_gate_writes_only_once_on_the_deselect(void) {
    bus_model_t m; bus_model_init(&m, 2);
    bus_model_set_word(&m, 0, 0x0F);
    bus_model_select(&m, 0x1); bus_model_run(&m, 20);
    bus_model_select(&m, 0x2); bus_model_run(&m, 40);
    CHECK_EQ_INT(bus_model_released_writes(&m, 0), 1);   // one null write on SEL0's rise
    CHECK_EQ_INT(bus_model_released_writes(&m, 1), 0);   // DF1 was never selected before
}

// flux_out: a deselected SM, or one stalled on an empty FIFO, never writes RDATA.
static void rdata_pulses_only_for_the_selected_drive_and_a_stall_holds_nothing(void) {
    bus_model_t m; bus_model_init(&m, 2);
    bus_model_feed_bits(&m, 0, 0xFFFFFFFFu);   // DF0 has a stream
    // DF1 has none: its SM stalls at `out` with no side-set.
    bus_model_select(&m, 0x1);
    CHECK(bus_model_run_count_rdata_pulses(&m, 8 * 32) == 32, "DF0 pulses every 1 cell");
    bus_model_select(&m, 0x2);
    CHECK(bus_model_run_count_rdata_pulses(&m, 8 * 32) == 0, "DF1 selected, empty: no pulse");
    CHECK(bus_model_rdata(&m) == 0, "and RDATA was left released");
}

int main(void) {
    RUN(each_drive_owns_the_pads_only_during_its_own_select);
    RUN(a_released_gate_writes_only_once_on_the_deselect);
    RUN(rdata_pulses_only_for_the_selected_drive_and_a_stall_holds_nothing);
    return REPORT();
}
```

- [ ] **Step 2: Run, expect COMPILE FAIL** (`bus_model.h` missing).

- [ ] **Step 3: Write the model** (one function per program path, each line naming its instruction, as
  `drive_id.c` does)

`src/bus_model.h`:

```c
#ifndef BUS_MODEL_H
#define BUS_MODEL_H
// Host-only model of floppy.pio's status_gate and flux_out running as one SM
// per drive on a shared PIO (spec 2026-10-08 §4 "PIO changes"). Each step of
// bus_model_run() is one PIO cycle; pin writes follow RP2350 datasheet
// §11.2.6 (highest-numbered SM wins; unwritten pins hold). Change floppy.pio's
// status_gate/flux_out only together with this model and
// test_floppy_pio_golden.c's arrays.
#include <stdbool.h>
#include <stdint.h>
#define BUS_MODEL_MAX 2
typedef struct {
    unsigned n;
    uint32_t sel;                    // bit k set = SEL_k asserted
    uint32_t word[BUS_MODEL_MAX];    // the shadow pushed to drive k's gate (X)
    bool     was_sel[BUS_MODEL_MAX]; // status_gate Y
    unsigned released_writes[BUS_MODEL_MAX];
    uint32_t pads;
    // flux_out
    uint32_t fifo[BUS_MODEL_MAX]; bool fifo_full[BUS_MODEL_MAX];
    uint32_t osr[BUS_MODEL_MAX]; unsigned osr_left[BUS_MODEL_MAX];
    unsigned pc[BUS_MODEL_MAX]; unsigned delay[BUS_MODEL_MAX];
    bool     rdata;
} bus_model_t;
void     bus_model_init(bus_model_t *m, unsigned n);
void     bus_model_set_word(bus_model_t *m, unsigned d, uint32_t w);
void     bus_model_select(bus_model_t *m, uint32_t sel_mask);
void     bus_model_run(bus_model_t *m, unsigned cycles);
uint32_t bus_model_pads(const bus_model_t *m);
unsigned bus_model_released_writes(const bus_model_t *m, unsigned d);
void     bus_model_feed_bits(bus_model_t *m, unsigned d, uint32_t word);
unsigned bus_model_run_count_rdata_pulses(bus_model_t *m, unsigned cycles);
bool     bus_model_rdata(const bus_model_t *m);
#endif
```

`src/bus_model.c` models the new status_gate as one call per loop pass (the gate is cycle-insensitive at this
level). It models flux_out cycle by cycle on its 8-cycle bit cell: pc 0 `out x,1` (stalls when the OSR is empty
and the FIFO is empty; writes nothing); pc 1 `jmp !x`; pc 2 `jmp pin`; pc 3 `nop side 1 [2]`; pc 4
`jmp top side 0`; pc 5 `nop`; pc 6 `nop [3]`. Pin writes are collected per cycle and applied in SM order
0..n-1, so the highest index wins. Write it from this sketch:

```c
#include "bus_model.h"
#include <string.h>

void bus_model_init(bus_model_t *m, unsigned n) { memset(m, 0, sizeof *m); m->n = n; }
void bus_model_set_word(bus_model_t *m, unsigned d, uint32_t w) { m->word[d] = w; }
void bus_model_select(bus_model_t *m, uint32_t s) { m->sel = s; }
uint32_t bus_model_pads(const bus_model_t *m) { return m->pads; }
unsigned bus_model_released_writes(const bus_model_t *m, unsigned d) { return m->released_writes[d]; }
bool bus_model_rdata(const bus_model_t *m) { return m->rdata; }
void bus_model_feed_bits(bus_model_t *m, unsigned d, uint32_t w) { m->fifo[d] = w; m->fifo_full[d] = true; }

// status_gate, one pass: pull noblock; mov x, osr; jmp pin, released;
// selected: mov pins, x; set y, 1; jmp top.  released: jmp !y, top; mov pins, null; set y, 0.
static void gate_pass(bus_model_t *m, unsigned d, bool *wrote, uint32_t *val) {
    const bool selected = (m->sel >> d) & 1u;
    *wrote = false;
    if (selected) { *wrote = true; *val = m->word[d]; m->was_sel[d] = true; return; }
    if (!m->was_sel[d]) return;                       // jmp !y, top: nothing written
    *wrote = true; *val = 0; m->was_sel[d] = false;   // mov pins, null -- once
    m->released_writes[d]++;
}

// flux_out, one cycle. Returns true and sets *level if this SM writes RDATA this cycle.
static bool flux_cycle(bus_model_t *m, unsigned d, bool *level) {
    if (m->delay[d]) { m->delay[d]--; return false; }
    const bool selected = (m->sel >> d) & 1u;
    switch (m->pc[d]) {
    case 0:                                            // out x, 1 [1]   (no side-set)
        if (m->osr_left[d] == 0) {
            if (!m->fifo_full[d]) return false;        // stall: writes nothing
            m->osr[d] = m->fifo[d]; m->osr_left[d] = 32; m->fifo_full[d] = false;
        }
        m->pc[d] = ((m->osr[d] >> 31) & 1u) ? 2 : 5;   // folds jmp !x into the next pc
        m->osr[d] <<= 1; m->osr_left[d]--; m->delay[d] = 2;   // [1] + the jmp !x cycle
        return false;
    case 2: m->pc[d] = selected ? 3 : 6; return false;          // jmp pin, skip4
    case 3: m->pc[d] = 4; m->delay[d] = 2; *level = true; return true;   // nop side 1 [2]
    case 4: m->pc[d] = 0; *level = false; return true;          // jmp top side 0
    case 5: m->pc[d] = 6; return false;                         // skip5: nop
    case 6: m->pc[d] = 0; m->delay[d] = 3; return false;        // skip4: nop [3]
    }
    return false;
}

void bus_model_run(bus_model_t *m, unsigned cycles) {
    for (unsigned c = 0; c < cycles; c++) {
        for (unsigned d = 0; d < m->n; d++) {          // ascending: the last (highest) wins
            bool w; uint32_t v = 0;
            gate_pass(m, d, &w, &v);
            if (w) m->pads = v;
        }
    }
}

unsigned bus_model_run_count_rdata_pulses(bus_model_t *m, unsigned cycles) {
    unsigned pulses = 0;
    for (unsigned c = 0; c < cycles; c++) {
        bool before = m->rdata;
        for (unsigned d = 0; d < m->n; d++) {
            bool lvl;
            if (flux_cycle(m, d, &lvl)) m->rdata = lvl;
        }
        if (!before && m->rdata) pulses++;
    }
    return pulses;
}
```

  The jmp-pin cycle counts in `flux_cycle` are approximate. The exact cycle accounting is pinned by the golden
  test (Step 6), not by this model. The model checks ownership and stalls.

- [ ] **Step 4: Change `floppy.pio`**

`flux_out`. Every path is still 8 cycles. Side-set appears only on the pulse and on the instruction that ends it.
Update the header comment: a deselected or stalled SM writes nothing (datasheet §11.2.5 and §11.2.6), which is
what lets two SMs share RDATA.

```
.program flux_out
.side_set 1 opt
.wrap_target
top:
    out x, 1                 [1]   ; 2 cycles; NO side-set: a stall here must hold nothing
    jmp !x, skip5                  ; 1
    jmp pin, skip4                 ; 1  our select high: not ours
    nop                 side 1 [2] ; 3 cycles asserted = 750 ns pulse
    jmp top             side 0     ; 1  the pulsing SM alone releases RDATA
skip5:
    nop                            ; 1
skip4:
    nop                        [3] ; 4
.wrap
```

`status_gate` (9 instructions; header: "released on the deselect edge only, Y = was selected"):

```
.program status_gate
.wrap_target
top:
    pull noblock        ; OSR = newest mask, or X if none is waiting
    mov x, osr
    jmp pin, released   ; our select high
    mov pins, x
    set y, 1            ; selected
    jmp top
released:
    jmp !y, top         ; already released: write NOTHING (a second SM shares these pads)
    mov pins, null
    set y, 0
.wrap
```

`drive_id`: replace each `wait 0 gpio 2` / `wait 1 gpio 2` with `wait 0 pin 0` / `wait 1 pin 0`, keeping the
delays. Update the header: "in_base = this drive's select; SEL0 is no longer pinned to GP2", "15 instructions".
Its init gains `sel_pin`:

```c
static inline void drive_id_program_init(PIO pio, uint sm, uint offset, uint sel_pin, uint rdy_pin,
                                         uint mtr_pin, uint32_t hd_id) {
    pio_sm_config c = drive_id_program_get_default_config(offset);
    sm_config_set_in_pins(&c, sel_pin);                  // `wait pin 0` = this drive's select
    sm_config_set_out_pins(&c, rdy_pin, 1);
    /* ...every remaining line exactly as today... */
}
```

`status_gate_program_init`: rename `sel0_pin` to `sel_pin` (no behaviour change).

- [ ] **Step 5: `drive_id.h`**: add the kinds and the NONE load (`mov osr, null`: op 00, src 011):

```c
typedef enum { DRIVE_ID_KIND_NONE = 0, DRIVE_ID_KIND_DD, DRIVE_ID_KIND_HD } drive_id_kind_t;
// NONE answers 0x00000000 = "no drive" to Kickstart (spec §2): DF1 while off or parked.
static inline uint16_t drive_id_load_kind(drive_id_kind_t k) {
    const unsigned op  = k == DRIVE_ID_KIND_DD ? 1u : 0u;      // invert for DD's all-ones
    const unsigned src = k == DRIVE_ID_KIND_HD ? 2u : 3u;      // Y (HD word) / NULL
    return (uint16_t)((0x5u << 13) | (0x7u << 5) | (op << 3) | src);
}
static inline uint16_t drive_id_load(bool hd) {
    return drive_id_load_kind(hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD);
}
```

  In `test_drive_id_pio.c`, add: `CHECK_EQ_INT(drive_id_load_kind(DRIVE_ID_KIND_NONE), 0xA0E3);`,
  `CHECK_EQ_INT(drive_id_load_kind(DRIVE_ID_KIND_DD), drive_id_load(false));`,
  `CHECK_EQ_INT(drive_id_load_kind(DRIVE_ID_KIND_HD), drive_id_load(true));`.
  - NONE must also decode as a MOV to OSR. Reuse the file's existing decode check.

- [ ] **Step 6: Golden arrays.** Run `pnpm firmware:build`, then copy into the tests:
  - `status_gate_program_instructions[]` and `flux_out_program_instructions[]` from
    `build/floppy.pio.h` into a new `test/test_floppy_pio_golden.c`, written in `test_drive_id_pio.c`'s style
    (golden array plus a live text comparison when the header exists);
  - the new `drive_id_program_instructions[]` into `test_drive_id_pio.c`.
  - Check in each: status_gate is 9 instructions; flux_out is 7 and only words 3 and 4 carry a side-set bit
    (`.side_set 1 opt` puts the enable in bit 12); drive_id is 15 and has no `wait gpio` (WAIT source field
    `00` = GPIO must not appear).
  - In `test_drive_id.c`, nothing changes: the protocol is the same.
- [ ] **Step 7: Run** `test/run.sh`. Expected: all green, including the 3 new test files.
- [ ] **Step 8: Commit** `feat(pio): select-parameterised drive_id, edge-released status gate, side-set only on the RDATA pulse`.

### Task 7: `board_check` no longer pins SEL0 to GP2

**Files:** Modify `wifi-floppy/firmware/src/board.c`, `wifi-floppy/firmware/test/test_board.c`

- [ ] **Step 1: Failing test.** In `test_board.c`, replace the `expect_fail(b, "GP2", ...)` case with:

```c
    b = broken(); b.sel0 = 26; b.sel1 = 27; b.mtr = 28; b.dir = 29;
    b.step = 6;   // keep the other roles where broken() put them; only the select block moved
    char why[96];
    CHECK(board_check(&b, why, sizeof why) || strstr(why, "GP2") == NULL,
          "drive_id waits on `pin 0` now: SEL0 may be any GPIO (P2 rule gone)");
```

- [ ] **Step 2: Run, expect FAIL** (the GP2 message still fires).
- [ ] **Step 3:** Delete the `if (b->sel0 != 2)` rule from `board_check`, and delete the "SEL0 is GP2" comment in
  `bus_out.c`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `refactor(board): SEL0 may be any GPIO now that drive_id waits on its in_base`.

### Task 8: `bus_out` per drive (one drive configured)

**Files:** Modify `wifi-floppy/firmware/src/bus_out.h`, `wifi-floppy/firmware/src/bus_out.c`, the `main.c` call
sites (`bus_out_init`, `bus_out_drive_id_init`). The file is device-only: verify with the build and the Task 11
bench.

**Interfaces:**
- Produces:
  - `#define WF_DRIVES 2` (in `bus_out.h`);
  - `void bus_out_init(PIO pio, unsigned ndrives, const uint32_t initial[])`;
  - `void bus_out_set_drive(unsigned d, unsigned pin, bool assert)`;
  - `void bus_out_set(unsigned pin, bool assert)`, i.e. drive 0, unchanged for every existing caller;
  - `void bus_out_drive_id_init(PIO pio, unsigned ndrives)`;
  - `bool bus_out_drive_id_set(unsigned d, drive_id_kind_t k)`;
  - `bool bus_out_drive_id_set_hd(bool hd)`, i.e. drive 0 DD/HD, unchanged.

- [ ] **Step 1: Implement** (shape below; keep every existing comment that still holds)

```c
static PIO          gate_pio;
static spin_lock_t *gate_lock;
static unsigned     n_drives;
static uint         gate_sm[WF_DRIVES];
static uint32_t     shadow[WF_DRIVES];
static const uint   *sel_pin_of(unsigned d) { static uint p[WF_DRIVES]; p[0] = PIN_SEL0; p[1] = PIN_SEL1; return &p[d]; }

void bus_out_init(PIO pio, unsigned ndrives, const uint32_t initial[]) {
    gate_pio  = pio;
    n_drives  = ndrives;
    gate_lock = spin_lock_instance((uint)spin_lock_claim_unused(true));
    uint off = (uint)pio_add_program(pio, &status_gate_program);   // one copy, shared
    for (unsigned d = 0; d < ndrives; d++) {
        shadow[d] = initial[d] & bus_gate_status_mask();
        gate_sm[d] = (uint)pio_claim_unused_sm(pio, true);
        status_gate_program_init(pio, gate_sm[d], off, *sel_pin_of(d), BUS_GATE_OUT_COUNT,
                                 bus_gate_status_mask());
        pio_sm_put(pio, gate_sm[d], shadow[d]);
    }
    for (unsigned d = 0; d < ndrives; d++) pio_sm_set_enabled(pio, gate_sm[d], true);
}

void __not_in_flash_func(bus_out_set_drive)(unsigned d, unsigned pin, bool assert) {
    if (d >= n_drives) return;
    uint32_t save = spin_lock_blocking(gate_lock);
    uint32_t next = bus_gate_apply(shadow[d], pin, assert);
    if (next != shadow[d]) {
        const uint32_t was = shadow[d];
        shadow[d] = next;
        pio_sm_put(gate_pio, gate_sm[d], next);
#if WF_DRIVE_ID
        if (id_sm[d] >= 0 && ((next ^ was) & (1u << PIN_RDY))) { /* today's block, indexed by d */ }
#else
        (void)was;
#endif
    }
    spin_unlock(gate_lock, save);
}

void __not_in_flash_func(bus_out_set)(unsigned pin, bool assert) { bus_out_set_drive(0, pin, assert); }
```

  - `status_gate_program_init` calls `pio_gpio_init` on the status pads. Calling it once per SM is harmless (same
    PIO). Keep it, and keep the comment that the pads are handed over only once.
  - drive_id: `id_sm[WF_DRIVES]` (init -1), `id_kind[WF_DRIVES]`, and one shared `id_off` (one program copy).
    `id_write_loads(d, k)` cannot rewrite `instr_mem` per drive, because the program is shared. **The loads move
    to per-SM state:** keep `reset_load` / `repeat_load` as `mov osr, y`, and make each SM's Y hold its own ID
    word.
    - DD = `0xFFFFFFFF`, HD = `0xAAAAAAAA`, NONE = `0`.
    - Write Y with exec'd `pull`+`mov y, osr` while the SM is at `on_released` or `on_selected_wait`, i.e. not
      mid-answer.
    - **This is a protocol-visible change:** update `drive_id.h`'s comment, keep the
      `an_id_change_waits_for_the_next_answer` model test green, and pin "no `instr_mem` writes after init" by
      grepping `bus_out.c` for `instr_mem` in `test/run.sh`:

```bash
if grep -n 'instr_mem\[' ../src/bus_out.c; then
  echo "FAIL: drive_id is shared by two SMs -- an ID lives in each SM's Y, never in instr_mem"; fail=1
fi
```

    - With the loads fixed, `drive_id_load_kind()` is used only by the golden test. Keep it: it documents the
      encodings, and Task 6 pins it.
    - `bus_out_drive_id_set(d, k)`, inside `gate_lock`:

```c
bool bus_out_drive_id_set(unsigned d, drive_id_kind_t k) {
    if (d >= n_drives || id_sm[d] < 0 || k == id_kind[d]) return false;
    const uint32_t word = k == DRIVE_ID_KIND_HD ? DRIVE_ID_HD : k == DRIVE_ID_KIND_DD ? DRIVE_ID_DD : 0u;
    uint32_t save = spin_lock_blocking(gate_lock);
    // TX FIFO is never read by the program, so a put + exec'd pull is ours alone.
    pio_sm_put(id_pio, (uint)id_sm[d], word);
    pio_sm_exec(id_pio, (uint)id_sm[d], pio_encode_pull(false, true));
    pio_sm_exec(id_pio, (uint)id_sm[d], pio_encode_mov(pio_y, pio_osr));   // dest Y: safe (drive_id.h)
    id_kind[d] = k;
    spin_unlock(gate_lock, save);
    return true;
}
```

  - Exec'ing `pull` clobbers the OSR mid-answer. Guard it: only exec when
    `pio_sm_get_pc() == id_off + drive_id_offset_on_selected_wait` or `on_released`'s wait. Otherwise record
    `id_pending[d] = k` and retry from `bus_out_drive_id_poll()`, which core0's loop calls every pass.
    - Add `void bus_out_drive_id_poll(void)` to the header.
    - Model it in `drive_id.c`: `drive_id_model_set_id` is taken only at those PCs. Add a test in
      `test_drive_id.c`: `an_id_change_mid_answer_is_deferred_not_torn`.
    - Check the model's PC names against `floppy.pio` labels before writing the guard.
- [ ] **Step 2: Call sites in `main.c`.**
  - Replace `bus_out_init(bus_pio, (1u << PIN_TRK0) | (1u << PIN_WPROT));` with:

```c
    static const uint32_t boot_lines[WF_DRIVES] = {
        (1u << PIN_TRK0) | (1u << PIN_WPROT),   // DF0, as before
        0,                                      // DF1: unused until Phase 2
    };
    bus_out_init(bus_pio, 1, boot_lines);       // Phase 1: one drive, behaviour unchanged
```

    Note: `boot_lines` cannot be a static initializer if `PIN_*` are runtime reads. Make it a plain local
    `uint32_t boot_lines[WF_DRIVES]` filled in code.
  - Replace `bus_out_drive_id_init(pio);` with `bus_out_drive_id_init(pio, 1);`.
- [ ] **Step 3:** `test/run.sh` green and `pnpm firmware:build` clean.
- [ ] **Step 4: Commit** `refactor(bus_out): per-drive status gate and drive-ID, one drive configured`.

### Task 9: `flux_in` and the sniffer move to pio2

**Files:** Modify `wifi-floppy/firmware/src/main.c` (PIO block ~2554-2614, `sniff_isr`), `wifi-floppy/firmware/CMakeLists.txt` (comment only)

- [ ] **Step 1:** Change the `flux_in` lines to `step_pio` (pio2):

```c
    uint off_in = pio_add_program(step_pio, &flux_in_program);
    sm_in = pio_claim_unused_sm(step_pio, true);
    flux_in_program_init(step_pio, sm_in, off_in, PIN_WDATA);
    flux_capture_init(step_pio, sm_in);
```

  Confirm `flux_capture.c` uses only its `pio`/`sm` parameters. Run `grep -n "pio0\|pio1\|pio2" src/flux_capture.c`;
  the expected result is no match. Do the `flux_in` claims **before** `step_dir`'s, so the order on pio2 is
  flux_in, step_dir, and then the radio.
- [ ] **Step 2:** Move the sniffer block from `bus_pio` to `step_pio`, on IRQ1 (Task 5 Step 3):

```c
    uint off_sniff = pio_add_program(step_pio, &bus_sniff_program);
    sniff_sm = pio_claim_unused_sm(step_pio, true);
    bus_sniff_program_init(step_pio, sniff_sm, off_sniff);
    pio_set_irq1_source_enabled(step_pio, pio_get_rx_fifo_not_empty_interrupt_source(sniff_sm), true);
    irq_set_exclusive_handler(pio_get_irq_num(step_pio, 1), sniff_isr);
    irq_set_enabled(pio_get_irq_num(step_pio, 1), true);
    pio_sm_set_enabled(step_pio, sniff_sm, true);
```

  and in `sniff_isr` use `step_pio` (`fdebug` and `pio_sm_get`).
- [ ] **Step 3:** Update the comments: the "pio1 carries the SEL0 gating" comment, the drive_id "29 of its 32" line
  (pio0 is now flux_out 7 + drive_id 15 = 22), and HANDOFF's PIO budget line.
  - Expected `pio claims:` on Phase 1 firmware: pio0=3 (flux_out, drive_id), pio1=3 (status_gate, sel_mtr),
    pio2=7 (flux_in, step_dir, radio).
  - In a sniff build: pio1=3, pio2=f.
- [ ] **Step 4:** Build twice: `pnpm firmware:build`, and a sniff build in a separate dir
  (`cmake -B build-sniff -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_BUS_SNIFF=ON && cmake --build build-sniff`).
  Both must be clean.
- [ ] **Step 5: Commit** `refactor(pio): flux_in and the bus sniffer move to pio2 (pio0/pio1 free for DF1)`.

### Task 10: Drive state per drive (dskchg, cylinder, step filter), one drive configured

**Files:** Modify `wifi-floppy/firmware/src/dskchg.{h,c}`, `wifi-floppy/firmware/src/main.c`

**Interfaces:**
- Produces:
  - `dskchg_init(void)` (both drives); `dskchg_image_inserted_d(unsigned d)`, `dskchg_image_ejected_d(unsigned d)`,
    `dskchg_on_step_d(unsigned d)`, `dskchg_on_motor_d(unsigned d, bool on)`;
  - `dskchg_poll(void)` (every configured drive); `bool dskchg_image_in_d(unsigned d)`,
    `bool dskchg_motor_on_d(unsigned d)`, `uint32_t dskchg_motor_on_ms_d(unsigned d)`;
  - `void dskchg_set_drives(unsigned n)`;
  - the old names as `static inline` drive-0 wrappers in `dskchg.h`.
  - In `main.c`: `cur_cyl[WF_DRIVES]`, `want_track[WF_DRIVES]`, `last_step[WF_DRIVES]`, `n_drives`.

- [ ] **Step 1:** `dskchg.c`:
  - `static volatile struct {...} st[WF_DRIVES]`;
  - every function takes `d` and calls `bus_out_set_drive(d, ...)`;
  - `dskchg_poll` loops `d < s_ndrives`;
  - `dskchg_init` sets up both, but drive 1's pins are written only once configured. `bus_out_set_drive` ignores
    `d >= n_drives`, so this is automatic.
- [ ] **Step 2:** `main.c`:
  - `cur_cyl` becomes `cur_cyl[WF_DRIVES]`; every DF0 use becomes `cur_cyl[0]`, including `ui.cyl`, the WGATE ISR's
    `write_track` and the SIDE ISR. `want_track` becomes `want_track[WF_DRIVES]`; the SIDE ISR sets every
    configured drive's `want_track[d] = cur_cyl[d] * 2 + cur_side`.
  - `step_pulse` loops `for (d = 0; d < n_drives; d++) if (st.sel_mask & (1u << d)) step_drive(d, st.outwards, late);`.
    `step_drive` is today's body with `last_step[d]`, `cur_cyl[d]`, `bus_out_set_drive(d, PIN_TRK0, …)`,
    `dskchg_on_step_d(d)`, and `want_track[d]`.
    - Keep the DF1 telemetry branch from Task 2 for steps whose select's drive is not configured.
    - `steps_seen`, `steps_dir_late` and `led_blip` stay DF0-only.
  - `mtr_pio_isr` becomes `dskchg_on_motor_d(0, running)` (one sel_mtr SM in Phase 1).
- [ ] **Step 3:** `test/run.sh` green (dskchg.c is excluded from host tests, so nothing new runs) and
  `pnpm firmware:build` clean. Check `main` stays ≤ 616 bytes of frame: run
  `grep -A1 "main.c" build/CMakeFiles/wifi_floppy.dir/src/main.c.su 2>/dev/null | sort -k2 -n | tail -3`
  if `-fstack-usage` is on, else rely on `-Werror=frame-larger-than=768`.
- [ ] **Step 4: Commit** `refactor(fw): per-drive head, step filter and disk-change state (DF0 only)`.

### Task 11: Ship 1.7.6 and Phase 1 bench

**Files:** `CMakeLists.txt` (`1.7.6`), `HANDOFF.md` 3bb.

- [ ] **Step 1:** Bump, `test/run.sh`, `pnpm firmware:build`. Commit `chore(fw): 1.7.6 -- DF1 refactor, behaviour unchanged`.
- [ ] **Step 2:** Publish as a TEST build first: `pnpm firmware:publish --notes "TEST build: 1.7.6 DF1 refactor"`.
  Target WifiFloppy1. Announce it only after the bench passes.
- [ ] **Step 3: Bench checklist, Phase 1** (operator, one step per turn; A500 rev 8a.1):
  1. **Boot log:** serial attached, then power-on.
     - PASS: `pio claims: pio0=3 pio1=3 pio2=7`, the expected masks.
     - Record the actual line.
  2. **DF0 regression:** mount Workbench 3.1 (Workbench disk), cold boot.
     - PASS: it boots to Workbench. `info` lists DF0 only. `dir df0:` lists.
  3. **HD ID:** mount `HDBench.adf` and cold boot.
     - PASS: `info` shows DF0 with 1,760 KB capacity (HD), and `dir df0:` lists.
  4. **DF0 write:** with a writable DD scratch disk, `Echo >DF0:p1check hi`.
     - PASS: a new version appears in the library's history.
  5. **Real external DF1 (4e regression), if the drive is at hand.** Fit it with a DOS disk and cold boot.
     - PASS: `dir df0:` and `dir df1:` both list, and the serial line `sel0: ignored N step(s)` has N > 0.
  6. **Sniff build (optional):** install the sniff build over USB, boot, then copy a file on DF0.
     - PASS: zero `sniff: … violation` ERR lines.
     - FAIL: any violation, i.e. an output asserted while released, means the edge-released gate is wrong.

---

# PHASE 2 — DF1 read-only, stored setting (firmware 1.8.0)

### Task 12: `drive_store` — the DF1 setting's own flash record

**Files:** Create `wifi-floppy/firmware/src/drive_store.{h,c}`, `wifi-floppy/firmware/test/test_drive_store.c`;
modify `CMakeLists.txt` (add `src/drive_store.c` to `add_executable`; add the option below).

**Interfaces:**
- Produces:
  - `typedef enum { DF1_MODE_OFF = 0, DF1_MODE_NEXT = 1 } df1_mode_t;`
  - `typedef struct { uint32_t version; uint8_t mode; } drive_record_t;`
  - `bool drive_store_load(drive_record_t *out)`, `bool drive_store_save(const drive_record_t *r)`,
    `void drive_store_erase(void)`, `bool drive_store_should_write(bool pending, bool drive_empty)`;
  - `df1_mode_t drive_boot_mode(bool loaded, const drive_record_t *r)`;
  - CMake `WF_DF1_DEFAULT` (0/1, default OFF).

- [ ] **Step 1: Failing test** `test/test_drive_store.c`

```c
#include "harness.h"
#include "../src/drive_store.h"
#include "../src/psram_image.h"
#include <string.h>

static void nothing_stored_boots_with_the_compiled_default(void) {
    drive_store_erase();
    drive_record_t r;
    CHECK(!drive_store_load(&r), "erased: nothing");
    CHECK_EQ_INT(drive_boot_mode(false, NULL), WF_DF1_DEFAULT);
}

static void a_stored_mode_round_trips_and_wins_over_the_default(void) {
    drive_store_erase();
    drive_record_t a = { 7, DF1_MODE_NEXT }, b;
    CHECK(drive_store_save(&a), "saved");
    CHECK(drive_store_load(&b), "loaded");
    CHECK_EQ_INT(b.version, 7);
    CHECK_EQ_INT(drive_boot_mode(true, &b), DF1_MODE_NEXT);
}

static void an_out_of_range_mode_boots_off(void) {
    drive_record_t r = { 3, 9 };
    CHECK_EQ_INT(drive_boot_mode(true, &r), DF1_MODE_OFF);   // never guess "on"
}

static void a_corrupt_record_does_not_load(void) {
    drive_store_erase();
    drive_record_t a = { 5, DF1_MODE_NEXT }, b;
    drive_store_save(&a);
    drive_store_corrupt_for_test();
    CHECK(!drive_store_load(&b), "a bit flip fails the CRC");
}

static void writes_wait_for_an_empty_drive(void) {
    CHECK(drive_store_should_write(true, true), "pending + empty: write");
    CHECK(!drive_store_should_write(true, false), "a disk is in: wait");
    CHECK(!drive_store_should_write(false, true), "nothing pending");
}

int main(void) {
    static uint8_t backing[2 * 160 * 14336];
    psram_image_set_backing(backing, sizeof backing);
    psram_image_init();
    RUN(nothing_stored_boots_with_the_compiled_default);
    RUN(a_stored_mode_round_trips_and_wins_over_the_default);
    RUN(an_out_of_range_mode_boots_off);
    RUN(a_corrupt_record_does_not_load);
    RUN(writes_wait_for_an_empty_drive);
    return REPORT();
}
```

- [ ] **Step 2: Run, expect COMPILE FAIL.**
- [ ] **Step 3: Implement** by copying `display_store.c`'s structure exactly (pure page build/load, then the
  device backing and the host backing), with these differences:
  - magic `0x44525631` ('DRV1');
  - payload `version(4) . mode(1)`, CRC over those 5 bytes;
  - `DRIVE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 5 * FLASH_SECTOR_SIZE)`, and update the top-of-flash map comment
    in BOTH `display_store.c` and this file (-5 drive_store);
  - the device guard refuses while `psram_active_slot() != SLOT_NONE`. The slot invariant "DF1 holds a disk only
    while DF0 does" (Task 13) makes that sufficient; say so in the comment.

```c
#ifndef WF_DF1_DEFAULT
#define WF_DF1_DEFAULT 0
#endif
df1_mode_t drive_boot_mode(bool loaded, const drive_record_t *r) {
    if (!loaded || !r) return WF_DF1_DEFAULT ? DF1_MODE_NEXT : DF1_MODE_OFF;
    return r->mode == DF1_MODE_NEXT ? DF1_MODE_NEXT : DF1_MODE_OFF;
}
bool drive_store_should_write(bool pending, bool drive_empty) { return pending && drive_empty; }
```

  In CMake, beside `WF_DRIVE_ID`:

```cmake
option(WF_DF1_DEFAULT "DF1 second drive ON when the board has no stored setting (bench TEST builds only)" OFF)
target_compile_definitions(wifi_floppy PRIVATE WF_DF1_DEFAULT=$<IF:$<BOOL:${WF_DF1_DEFAULT}>,1,0>)
if (WF_DF1_DEFAULT AND NOT WF_DRIVE_ID)
  message(FATAL_ERROR "WF_DF1_DEFAULT needs WF_DRIVE_ID: DF1 answers its ID through the responder")
endif ()
```

  Add `-DWF_DF1_DEFAULT=0` to `test/run.sh`'s `cc` line next to `-DWFMF_HOST_TEST=1`, so the host test checks the
  release value.
- [ ] **Step 4: Run, expect PASS.** Then make `scripts/firmware-release.ts` refuse a build configured with
  `WF_DF1_DEFAULT=ON` unless `--notes` starts with `TEST build`, in the same way it refuses `WF_FW_DEBUG`. Read
  how it detects that first (`grep -n WF_FW_DEBUG scripts/firmware-release.ts`) and mirror it; it reads
  `build/CMakeCache.txt`.
- [ ] **Step 5: Commit** `feat(fw): drive_store -- the DF1 setting's own flash sector`.

### Task 13: PSRAM — DF1's published slot and the reader-acknowledge cursor

**Files:** Modify `wifi-floppy/firmware/src/psram_image.{h,c}`, `wifi-floppy/firmware/test/test_psram_image.c`

**Interfaces:**
- Produces:
  - `bool psram_publish_df1(int slot)`: false, with nothing changed, if `slot` is the active slot or DF0 is empty
    and `slot != SLOT_NONE`;
  - `int32_t psram_df1_token(void)` (acquire barrier);
  - `int psram_df1_slot(void)`;
  - `void psram_df1_reader_ack(int32_t token)` (core0 only);
  - `bool psram_df1_quiescent(void)` (core1): true iff core0 acked the current DF1 word.
  - `psram_publish_slot()` also ejects DF1 when DF0 takes DF1's slot or DF0 ejects.

- [ ] **Step 1: Failing tests** (append; register with `RUN`)

```c
static void df1_never_shares_a_slot_with_df0(void) {
    psram_publish_slot(0);
    CHECK(!psram_publish_df1(0), "DF0's slot is refused");
    CHECK(psram_publish_df1(1), "the idle slot is fine");
    CHECK_EQ_INT(psram_df1_slot(), 1);
    psram_publish_slot(1);   // "Next disk": DF0 takes the preloaded slot
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);   // ejected in the same publish
}

static void df1_holds_a_disk_only_while_df0_does(void) {
    psram_publish_slot(0);
    psram_publish_df1(1);
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);
    CHECK(!psram_publish_df1(1), "DF0 empty: DF1 may not be filled");
}

// Review Focus 1: core1 writes into a slot only once core0 has stopped reading it.
static void the_writer_waits_for_core0_to_acknowledge_df1s_eject(void) {
    psram_publish_slot(0);
    psram_publish_df1(1);
    psram_df1_reader_ack(psram_df1_token());
    CHECK(psram_df1_quiescent(), "acked");
    psram_publish_df1(SLOT_NONE);
    CHECK(!psram_df1_quiescent(), "the eject is not yet seen by core0");
    psram_df1_reader_ack(psram_df1_token());
    CHECK(psram_df1_quiescent(), "now it is");
}

static void df1_tokens_never_repeat_a_df0_token(void) {
    psram_publish_slot(0);
    int32_t a = psram_active_token();
    psram_publish_df1(1);
    CHECK(psram_df1_token() != a, "one generation counter for both words");
}
```

- [ ] **Step 2: Run, expect COMPILE FAIL.**
- [ ] **Step 3: Implement** in `psram_image.c`. Use the same `g_gen` and `pack_word`, so a token is unique across
  both drives and `track_cache`'s (track, token) keys stay sound:

```c
static volatile int32_t df1_word;        // core1 writes; core0 reads
static volatile int32_t df1_reader_ack;  // core0 writes; core1 reads

bool psram_publish_df1(int slot) {
    const int a = slot_of_word(active_word);
    if (slot != SLOT_NONE && (a == SLOT_NONE || slot == a || !slot_ok(slot))) return false;
    wfmf_barrier();
    g_gen++;
    df1_word = pack_word(g_gen, slot);
    return true;
}
int32_t psram_df1_token(void) { int32_t w = df1_word; wfmf_barrier(); return w; }
int psram_df1_slot(void) { return slot_of_word(psram_df1_token()); }
void psram_df1_reader_ack(int32_t token) { wfmf_barrier(); df1_reader_ack = token; }
bool psram_df1_quiescent(void) { return df1_reader_ack == df1_word; }
```

  At the top of `psram_publish_slot`, before its barrier:

```c
    // DF1 invariants (spec 2026-10-08 §4): never the same slot as DF0, and no
    // disk at all while DF0 is empty.
    {
        const int d1 = slot_of_word(df1_word);
        if (d1 != SLOT_NONE && (slot == SLOT_NONE || slot == d1)) { g_gen++; df1_word = pack_word(g_gen, SLOT_NONE); }
    }
```

  `psram_image_init` zeroes both new words. 0 is "no disk, never published"; core0 acks 0 at boot.
- [ ] **Step 4: Run, expect PASS** (and every existing `test_psram_image` case).
- [ ] **Step 5: Commit** `feat(psram): DF1's published slot, its invariants, and core0's acknowledge cursor`.

### Task 14: `track_cache_get_token`

**Files:** Modify `wifi-floppy/firmware/src/track_cache.{h,c}`, `wifi-floppy/firmware/test/test_track_cache.c`

**Interfaces:**
- Produces: `const uint8_t *track_cache_get_token(int32_t token, int track, uint32_t *bit_count)`.
  `track_cache_get(track, bits)` stays as `track_cache_get_token(psram_active_token(), track, bits)`.

- [ ] **Step 1: Failing test**

```c
static void two_drives_get_their_own_tracks_by_token(void) {
    // slot 0 holds track 3 = pattern A, slot 1 holds track 3 = pattern B
    load_track(0, 3, 0xA5);  load_track(1, 3, 0x5A);    // the file's existing fill helper
    psram_publish_slot(0);
    psram_publish_df1(1);
    uint32_t b0, b1;
    const uint8_t *p0 = track_cache_get_token(psram_active_token(), 3, &b0);
    CHECK(p0 && p0[0] == 0xA5, "DF0 reads slot 0");
    uint8_t first0 = p0[0];
    const uint8_t *p1 = track_cache_get_token(psram_df1_token(), 3, &b1);
    CHECK(p1 && p1[0] == 0x5A, "DF1 reads slot 1, same track number");
    CHECK(track_cache_get_token(psram_active_token(), 3, &b0)[0] == first0, "DF0's copy not confused with DF1's");
    CHECK(track_cache_get_token(pack_none(), 3, &b0) == NULL, "an eject token gives nothing");
}
```

  Read `test_track_cache.c` first. Use its existing helper that writes and commits a track. Get the eject token
  from `psram_publish_df1(SLOT_NONE); psram_df1_token()` instead of a `pack_none` helper.
- [ ] **Step 2: FAIL. Step 3:** In `track_cache.c`, rename the body of `track_cache_get` to
  `track_cache_get_token` with `int32_t token` as its first parameter, and delete its own
  `psram_active_token()` read. Add the wrapper.
- [ ] **Step 4: PASS. Step 5: Commit** `feat(track_cache): fetch a track for any published token (DF1)`.

### Task 15: core1 policy — DF1 follows the preload record; nothing writes under it

**Files:** Modify `wifi-floppy/firmware/src/device_client.{h,c}`, `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Consumes: Task 13's API; `dc_preload_t` (existing).
- Produces:
  - `void dc_set_df1(device_client_t *c, df1_mode_t mode, bool hd_ok)`;
  - `void dc_set_df1_quiesce(device_client_t *c, bool (*fn)(void *ctx), void *ctx)`: blocks up to its own
    timeout, true when quiescent;
  - `void dc_df1_reconcile(device_client_t *c)`;
  - status tail `,"df1Sha256":null|"<64 hex>"`, present when the build is DF1-capable (`dc_set_df1` called);
  - `DC_STATUS_BODY_BYTES` 1408, `DC_STATUS_REQ_BYTES` 1920.

- [ ] **Step 1: Failing tests** (use the file's `boot()`, its fake transport and its existing preload helpers;
  read `test_preload_*` cases first and copy their setup for "mounted A, preload B verified")

```c
static bool quiesce_true(void *ctx) { (void)ctx; psram_df1_reader_ack(psram_df1_token()); return true; }
static bool quiesce_false(void *ctx) { (void)ctx; return false; }

static void df1_serves_the_verified_preload_while_on(void) {
    boot_mounted_with_preload_ready();        // helper: mounts A in slot 0, preload B verified in slot 1
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), 1);
    dc_set_df1(&c, DF1_MODE_OFF, true);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);   // off: ejected
}

// Review Focus 5
static void an_hd_next_disk_stays_off_a_dd_only_df1(void) {
    boot_mounted_with_preload_ready();
    psram_image_set_slot_kind(1, SLOT_KIND_ADF_HD);
    dc_set_df1(&c, DF1_MODE_NEXT, /*hd_ok=*/false);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.8.0");
    CHECK(strstr(fake_last_request(), "\"df1Sha256\":null") != NULL, "reported empty");
}

// Review Focus 1
static void a_fetch_that_finds_df1_unacknowledged_writes_nothing(void) {
    boot_mounted_with_preload_ready();
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_df1_reconcile(&c);
    dc_set_df1_quiesce(&c, quiesce_false, NULL);
    // the server now names a different next: the preload step would overwrite slot 1
    set_next_sha(&c, SHA_C);                 // helper: what dc_take_next would store
    CHECK(!dc_preload_step(&c), "no work while core0 may still read slot 1");
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);  // DF1 was ejected first
    CHECK_EQ_INT(fake_request_count_since_mark(), 0);  // no image request went out
    dc_set_df1_quiesce(&c, quiesce_true, NULL);
    fake_push_image_response(SHA_C);         // the file's image-response helper
    CHECK(dc_preload_step(&c), "acknowledged: the preload proceeds");
}

static void next_disk_ejects_df1_and_refills_it_with_the_following_disk(void) {
    boot_mounted_with_preload_ready();      // A in 0, B ready in 1
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_set_df1_quiesce(&c, quiesce_true, NULL);
    dc_df1_reconcile(&c);
    deliver_poll_desiring(SHA_B, /*next=*/SHA_C);   // helper: the file's poll-body path
    CHECK_EQ_INT(psram_active_slot(), 1);           // instant swap
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);      // DF1 empty during the fetch (~5 s)
    fake_push_image_response(SHA_C);
    CHECK(dc_preload_step(&c), "C into slot 0");
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), 0);              // DF1 = C
}
```

  Also extend `test_status_body_fits_at_maximum`: call `dc_set_df1(&c, DF1_MODE_NEXT, true)` with a 64-hex
  preload record published to DF1, and check `"df1Sha256":"` plus the closing quote.

  Where a helper named above does not exist in the file, write it next to the tests from the existing preload
  tests' setup. Each is 5-15 lines.
- [ ] **Step 2: Run, expect COMPILE FAIL.**
- [ ] **Step 3: Implement**

  In `device_client_t`:

```c
    uint8_t  _df1_mode;            // df1_mode_t, as core0 runs it (main.c keeps it current)
    bool     _df1_capable;         // dc_set_df1 was called: the build serves DF1
    bool     _df1_hd_ok;           // D2: DF1's buffer holds an HD track
    bool   (*_df1_quiesce)(void *ctx);
    void    *_df1_quiesce_ctx;
```

  `device_client.c`:

```c
void dc_set_df1(device_client_t *c, df1_mode_t mode, bool hd_ok) {
    c->_df1_capable = true; c->_df1_mode = (uint8_t)mode; c->_df1_hd_ok = hd_ok;
}
void dc_set_df1_quiesce(device_client_t *c, bool (*fn)(void *), void *ctx) {
    c->_df1_quiesce = fn; c->_df1_quiesce_ctx = ctx;
}

// The slot DF1 should hold right now (spec §4 "What DF1 serves"): the verified
// preload, only while DF1 is on, DF0 holds a disk, the record still names the
// idle slot, and the disk fits DF1's buffer.
static int dc_df1_want(const device_client_t *c) {
    const dc_preload_t *p = &c->preload;
    if (c->_df1_mode != DF1_MODE_NEXT || p->slot == SLOT_NONE || p->loading) return SLOT_NONE;
    if (psram_active_slot() == SLOT_NONE || p->slot != psram_inactive_slot()) return SLOT_NONE;
    if (!c->_df1_hd_ok && psram_image_slot_kind(p->slot) == SLOT_KIND_ADF_HD) return SLOT_NONE;
    return p->slot;
}

void dc_df1_reconcile(device_client_t *c) {
    const int want = dc_df1_want(c);
    if (psram_df1_slot() == want) return;
    if (psram_publish_df1(want))
        wf_logf(WF_INFO, "df1: %s", want == SLOT_NONE ? "ejected" : "inserted the next disk");
}

// Before ANY write into `target` (Review Focus 1): if DF1 holds it, eject DF1
// and wait for core0 to say it stopped reading. False = do not write now.
static bool dc_df1_release(device_client_t *c, int target) {
    if (psram_df1_slot() != target && psram_df1_quiescent()) return true;
    if (psram_df1_slot() == target) psram_publish_df1(SLOT_NONE);
    if (!c->_df1_quiesce) return psram_df1_quiescent();
    if (c->_df1_quiesce(c->_df1_quiesce_ctx)) return true;
    wf_logf(WF_WARN, "df1: core0 has not let go of slot %d -- write deferred", target);
    return false;
}
```

  Call sites:
  - **`dc_preload_step`:** after the gate check (`_preload_ok`) and before `dc_preload_drop`, add
    `if (!dc_df1_release(c, psram_inactive_slot())) return false;`.
  - **`dc_fetch_image`:** at its top, before the record is dropped:

```c
    if (!dc_df1_release(c, psram_inactive_slot())) { c->state = DC_IDLE_POLL; return c->state; }
```

    `since` is not advanced, so the next poll redelivers at once.
  - **End of `dc_step` and of `dc_preload_step`, on every return path:** wrap the bodies as
    `dc_state_t s = dc_step_inner(c); dc_df1_reconcile(c); return s;`. Do it by renaming, not by editing each
    return.
  - **The preload swap path** needs no wait: `psram_publish_slot` ejects DF1 itself (Task 13).
  - **Status:** next to `sel1_tail`:

```c
    static char df1_tail[96];   // ,"df1Sha256":"<64>" = 79
    if (c->_df1_capable) {
        const int s = psram_df1_slot();
        if (s != SLOT_NONE && s == c->preload.slot && c->preload.sha256[0])
            snprintf(df1_tail, sizeof df1_tail, ",\"df1Sha256\":\"%s\"", c->preload.sha256);
        else snprintf(df1_tail, sizeof df1_tail, ",\"df1Sha256\":null");
    } else df1_tail[0] = '\0';
```

    Raise `DC_STATUS_BODY_BYTES` to 1408 and `DC_STATUS_REQ_BYTES` to 1920, and say why in the header note: SEL1
    34 + df1Sha256 79 + Phase 3's 46 = 159 over 1217.
- [ ] **Step 4: Run, expect PASS** (all of `test_device_client`, including every preload and swap test).
- [ ] **Step 5: Commit** `feat(fw): DF1 follows the verified preload; no slot write under a DF1 reader`.

### Task 16: core0 serves DF1

**Files:** Modify `wifi-floppy/firmware/src/main.c`, `wifi-floppy/firmware/CMakeLists.txt` (`WF_DF1_HD`, sniff guard)

**Interfaces:**
- Consumes: Tasks 8, 10, 12-15.
- Produces:
  - core0 globals `g_df1_mode` (volatile `df1_mode_t`) and `n_drives` (2 in a DF1-capable build);
  - `static uint32_t track_words1[DF1_WORD_BUF_BYTES / 4]`;
  - `DF1_HOLDS_HD`.

- [ ] **Step 1: CMake**

```cmake
# D2 (plan 2026-10-08 Task 5): DF1's DMA word buffer. OFF = DD-sized (+14,336 B);
# an HD next disk then leaves DF1 empty.
option(WF_DF1_HD "DF1 can hold an HD disk (+25,344 B SRAM instead of +14,336)" OFF)
target_compile_definitions(wifi_floppy PRIVATE WF_DF1_HD=$<IF:$<BOOL:${WF_DF1_HD}>,1,0>)
```

- [ ] **Step 2: Boot, before `bus_out_init`** (spec §2 "Consequence")

```c
    // DF1 (spec 2026-10-08): the stored setting, before the first ID read --
    // Kickstart reads every drive's ID at power-on, seconds before Wi-Fi.
    static drive_record_t drv_rec;           // static: off core0's stack
    const bool drv_loaded = drive_store_load(&drv_rec);
    g_df1_mode = drive_boot_mode(drv_loaded, &drv_rec);
    g_drive_boot_ack = drv_loaded ? drv_rec.version : 0;   // core1 seeds driveAck (Phase 3)
    wf_logf(WF_INFO, "df1: %s at boot (%s)", g_df1_mode == DF1_MODE_NEXT ? "next disk of the set" : "off",
            drv_loaded ? "stored" : "compiled default");
    uint32_t boot_lines[WF_DRIVES];
    boot_lines[0] = (1u << PIN_TRK0) | (1u << PIN_WPROT);
    // DF1 on: an empty, write-protected drive at track 0 until a disk is inserted.
    // Off: nothing at all -- every line released while SEL1 is low.
    boot_lines[1] = g_df1_mode == DF1_MODE_NEXT
        ? (1u << PIN_TRK0) | (1u << PIN_WPROT) | (1u << PIN_CHNG) : 0u;
    bus_out_init(bus_pio, WF_DRIVE_ID ? 2 : 1, boot_lines);
    dskchg_set_drives(WF_DRIVE_ID ? 2 : 1);
```

  - After `bus_out_drive_id_init(pio, 2)`, set DF1's ID:
    `bus_out_drive_id_set(1, g_df1_mode == DF1_MODE_NEXT ? DRIVE_ID_KIND_DD : DRIVE_ID_KIND_NONE)`.
  - Then `psram_df1_reader_ack(psram_df1_token())`, which acks the boot word 0.
- [ ] **Step 3: Second PIO SMs** in the PIO block:
  - a second `flux_out` SM on `pio` with `sel_pin = PIN_SEL1` (`sm_out1`; same `off_out`, no second
    `pio_add_program`);
  - a second `sel_mtr` SM on `bus_pio` with in_base `PIN_SEL1` (`mtr_sm1`; same offset);
  - `mtr_pio_isr` drains both, calling `dskchg_on_motor_d(0/1, running)`.
- [ ] **Step 4: Second DMA stream.**
  - `dma_ch1`, `track_words1`, `track_word_count1`, `track_live1`, `rev_count1`.
  - `start_streaming(d, mfm, bits)` takes a drive and picks the channel, buffer and SM.
  - `dma_irq` checks both bits of `dma_hw->ints0` and raises `bus_out_set_drive(d, PIN_INDEX, true)`.
  - `index_off` receives `d` through `user_data` (`(void *)(uintptr_t)d`).
  - The DF1 word buffer:

```c
#if WF_DF1_HD
#define DF1_WORD_BUF_BYTES TRACK_BUF_BYTES
#else
#define DF1_WORD_BUF_BYTES TRACK_MAX_BYTES       // DD/HFE only (D2)
#endif
#define DF1_HOLDS_HD (DF1_WORD_BUF_BYTES >= ADF_MFM_HD_TRACK_BYTES)
static uint32_t track_words1[DF1_WORD_BUF_BYTES / 4];
```

    `start_streaming(1, …)` refuses `bits > DF1_WORD_BUF_BYTES * 8` with a `wf_logf(WF_ERR, …)`, never an
    overflow.
- [ ] **Step 5: DF1 mount and eject on core0**, in the loop next to `track_cache_check_swap`:

```c
        // DF1: core1 published a new word (dc_df1_reconcile). Stop the old stream
        // FIRST, then acknowledge -- the ack is core1's licence to overwrite the slot.
        {
            static int32_t df1_seen_tok;
            const int32_t t = psram_df1_token();
            if (t != df1_seen_tok) {
                df1_seen_tok = t;
                track_live1 = false;
                dma_channel_abort(dma_ch1);
                loaded1 = -1;
                const int s = psram_token_slot(t);
                const bool hd = s != SLOT_NONE && psram_image_slot_kind(s) == SLOT_KIND_ADF_HD;
                if (s != SLOT_NONE && (!hd || DF1_HOLDS_HD) && g_df1_mode == DF1_MODE_NEXT) {
                    bus_out_drive_id_set(1, hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD);
                    dskchg_image_inserted_d(1);
                    wf_trace(WF_EV_MOUNT, (uint32_t)t, 1);
                } else {
                    if (g_df1_mode == DF1_MODE_NEXT) bus_out_drive_id_set(1, DRIVE_ID_KIND_DD);
                    dskchg_image_ejected_d(1);
                    wf_trace(WF_EV_EJECT, 0, 1);
                }
                psram_df1_reader_ack(t);
            }
        }
```

  - **Serving.** Factor today's `want != loaded` block into `serve_drive(d, token_fn)`. DF0 calls it with
    `psram_active_token()`; DF1, only while its token names a slot, with `psram_df1_token()`.
  - **WPROT on DF1:** `bus_out_set_drive(1, PIN_WPROT, true)` at boot and never released. The WPROT writer in
    core1's loop is DF0-only (`bus_out_set`), so nothing else touches DF1's.
  - **WGATE:** unchanged. A write with SEL0 high is `writes_other_drive`, which covers every DF1 write.
- [ ] **Step 6: Step routing.** In `step_pulse`:
  - a DF1 step moves DF1's head only while `g_df1_mode == DF1_MODE_NEXT`;
  - otherwise it counts toward `g_df1_steps`, the Task 2 branch. Spec §3: the heuristic counts only while our
    DF1 is off.
- [ ] **Step 7: core1 hooks**, at `dc_set_preload_gate`'s site:

```c
        dc_set_df1(&c, g_df1_mode, DF1_HOLDS_HD);
        dc_set_df1_quiesce(&c, df1_quiesce_wait, NULL);
```

  with

```c
// core1: up to 50 ms for core0 (a ~1 ms loop) to acknowledge DF1's new word.
static bool df1_quiesce_wait(void *ctx) {
    (void)ctx;
    for (int i = 0; i < 50; i++) { if (psram_df1_quiescent()) return true; sleep_ms(1); }
    return psram_df1_quiescent();
}
```

- [ ] **Step 8: Sniff + DF1 guard (D4).** If Task 5 found the sniffer fits on pio2, nothing changes. If it does
  not, add a CMake `FATAL_ERROR` when `WF_BUS_SNIFF` is set without `-DWF_DF1_OFF_FOR_SNIFF=ON`, and compile DF1
  out under that flag.
- [ ] **Step 9:** `test/run.sh` and `pnpm firmware:build` (release), and also
  `cmake -B build-df1 … -DWF_DF1_DEFAULT=ON && cmake --build build-df1`. Run
  `arm-none-eabi-size build/wifi_floppy.elf`: `.bss` must grow by about 14.4 KB (DD-only), not more. Record it.
- [ ] **Step 10: Commit** `feat(fw): DF1 serves the next disk of the set, read-only`.

### Task 17: Ship 1.8.0 and Phase 2 bench

**Files:** `CMakeLists.txt` (`1.8.0`), `HANDOFF.md` 3bb.

- [ ] **Step 1:** Bump. `test/run.sh` and both builds. Commit `chore(fw): 1.8.0 -- DF1 second drive (stored setting, default off)`.
- [ ] **Step 2:** Publish the release build. It defaults to OFF, and with nothing stored it behaves as 1.7.6.
  Then build `-DWF_DF1_DEFAULT=ON` in `build-df1` and publish it with
  `--notes "TEST build: 1.8.0 with DF1 on by default (bench)"`. Target WifiFloppy1 at the TEST build.
- [ ] **Step 3: Bench checklist, Phase 2** (operator; one step per turn; A500 rev 8a.1, NO external drive). Use
  the library's Workbench 3.1 set and mount disk 2 (Workbench). Next disk = 3 (Locale).
  1. **Cold boot.**
     - PASS: Workbench boots from DF0, and within ~10 s `info` lists **DF1:** with the volume **Locale**.
     - FAIL: no DF1 line means the ID answer is wrong. DF1 listed but "No disk present" for more than 30 s
       means the preload did not reach DF1.
  2. **`dir df1:`**
     - PASS: Locale's directory lists.
  3. **Both at once:** `copy df0:c/#? ram:a/ ALL` and, in a second shell, `copy df1:#? ram:b/ ALL` at the same
     time.
     - PASS: both finish with no read error requester.
  4. **Write to DF1:** `echo >df1:x hi`.
     - PASS: AmigaDOS says **"Disk is write protected"**, and no new version appears for Locale.
  5. **Next disk** (web button or card).
     - PASS: DF0 becomes Locale at once; `info` shows DF1 with no disk; within ~10 s DF1 shows **Extras**.
  6. **Warm reset (Ctrl-A-A).**
     - PASS: DF1 is still listed after the reset.
  7. **Setting off** (needs the release build, not the TEST one): target the 1.8.0 release build. It still
     reads the stored record; with none stored it boots OFF. Cold boot.
     - PASS: `info` lists DF0 only.
  8. **Two real 2-disk games that use DF1** (operator's pick from the library): each loads disk 2 from DF1 with
     no swap prompt.
  - Record which titles passed. If Kickstart 1.3 is available on any machine, record whether DF1 appears there.
    The help text says nothing about 1.3 unless this is recorded.

---

# PHASE 3 — Web setting, poll delivery, guard, help (firmware 1.9.0, migration 0032)

### Task 18: Firmware — `driveAck` / `secondDrive` on the poll; status `secondDrive`

**Files:** Modify `wifi-floppy/firmware/src/device_client.{h,c}`, `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Produces:
  - poll path `…&displayAck=%lu&driveAck=%lu`;
  - fields `uint32_t drive_ack` (seeded by main.c), `uint32_t drive_want_seq`, `uint8_t drive_want_mode`,
    `bool drive_owed`;
  - `bool dc_drive_take(device_client_t *c, uint32_t *seq, df1_mode_t *mode)` (true once per owed change);
  - `void dc_drive_handled(device_client_t *c, uint32_t seq)`;
  - status tail `,"secondDrive":"off"|"df1","driveVersion":N`, sent when `_df1_capable`.

- [ ] **Step 1: Failing tests**

```c
static void test_poll_url_carries_drive_ack(void) {
    boot(); dc_set_df1(&c, DF1_MODE_OFF, false);
    c.drive_ack = 4294967295u; c.display_ack = 4294967295u; c.nfc_ack = 4294967295u; c.since = 4294967295u;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "&driveAck=4294967295") != NULL, "worst-case path fits");
}

// Review Focus 4
static void a_second_drive_object_never_shadows_the_poll_version(void) {
    boot(); dc_set_df1(&c, DF1_MODE_OFF, false);
    push_poll_body("{\"secondDrive\":{\"seq\":9,\"mode\":\"df1\"},\"version\":3,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(dc_drive_take(&c, &seq, &mode), "owed");
    CHECK_EQ_INT(seq, 9); CHECK_EQ_INT(mode, DF1_MODE_NEXT);
    CHECK_EQ_INT(c.since, 3);      // the top-level version, not anything inside the object
    CHECK(!dc_drive_take(&c, &seq, &mode), "taken once");
}

static void a_re_paired_board_with_a_higher_ack_takes_the_lower_seq(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false); c.drive_ack = 12;
    push_poll_body("{\"secondDrive\":{\"seq\":0,\"mode\":\"off\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(dc_drive_take(&c, &seq, &mode), "a mismatch either way is owed");
    CHECK_EQ_INT(seq, 0); CHECK_EQ_INT(mode, DF1_MODE_OFF);
}

static void a_bad_mode_is_handled_as_off_and_still_acked(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false);
    push_poll_body("{\"secondDrive\":{\"seq\":4,\"mode\":\"df9\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(dc_drive_take(&c, &seq, &mode) && mode == DF1_MODE_OFF, "unknown -> off, never on");
}

static void test_status_reports_second_drive_and_its_ack(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false); dc_drive_handled(&c, 7);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.9.0");
    CHECK(strstr(fake_last_request(), "\"secondDrive\":\"df1\",\"driveVersion\":7") != NULL, "both");
}
```

  Use the file's existing poll-body helper; read how `test_poll_url_carries_display_ack` pushes a 200 body. In
  `test_status_body_fits_at_maximum`, also set `c.drive_ack = 4294967295u` with mode NEXT, and check
  `"driveVersion":4294967295` arrives.
- [ ] **Step 2: Run, expect COMPILE FAIL.**
- [ ] **Step 3: Implement**
  - Path: `static char path[128];` with the format
    `"/api/device/poll?since=%lu&nfcAck=%lu&displayAck=%lu&driveAck=%lu"`, appending `&driveAck=` only when
    `c->_df1_capable`. An older build sends nothing, and the server then never wakes it for this. The worst case
    is 93 characters.
  - `DC_REQ_BUF_BYTES` goes to 352. Update its comment: 290 + 20 = 310 worst.
  - First thing in `dc_handle_poll_body`, before the `displayVersion` read:

```c
    dc_take_second_drive(c, json);   // lifted and BLANKED first: its keys must never shadow ours
```

```c
static void dc_take_second_drive(device_client_t *c, char *json) {
    static char obj[128];   // {"seq":4294967295,"mode":"df1"} is 31; static: STACK note
    if (!c->_df1_capable || !json_object(json, "secondDrive", obj, sizeof obj, true)) return;
    uint32_t seq;
    if (!json_u32_strict(obj, "seq", &seq)) return;
    char mode[8] = "";
    json_str(obj, "mode", mode, sizeof mode);
    if (seq == c->drive_ack && !c->drive_owed) return;   // nothing new
    c->drive_want_seq = seq;
    c->drive_want_mode = strcmp(mode, "df1") == 0 ? DF1_MODE_NEXT : DF1_MODE_OFF;
    c->drive_owed = true;
}
bool dc_drive_take(device_client_t *c, uint32_t *seq, df1_mode_t *mode) {
    if (!c->drive_owed) return false;
    c->drive_owed = false; *seq = c->drive_want_seq; *mode = (df1_mode_t)c->drive_want_mode;
    return true;
}
void dc_drive_handled(device_client_t *c, uint32_t seq) { c->drive_ack = seq; }
```

  - Note: `dc_handle_poll_body` takes `const char *json`. The display path already handles mutation for
    `nfcWrite`/`next`. Follow how `dc_take_next` receives a mutable buffer (it is called with `char *json`) and
    make the signature match.
  - Status tail (46 max):

```c
    static char drive_tail[64];
    if (c->_df1_capable)
        snprintf(drive_tail, sizeof drive_tail, ",\"secondDrive\":\"%s\",\"driveVersion\":%lu",
                 c->_df1_mode == DF1_MODE_NEXT ? "df1" : "off", (unsigned long)c->drive_ack);
    else drive_tail[0] = '\0';
```

- [ ] **Step 4: PASS. Step 5: Commit** `feat(fw): the DF1 setting rides the poll (driveAck/secondDrive) and the status`.

### Task 19: core0 applies the setting live; the store write waits for an empty drive (D3)

**Files:** Modify `wifi-floppy/firmware/src/main.c`

**D3, as implemented:**
- **Off → on:** at once, DF1 answers its ID as DD with an empty, write-protected drive. `dc_df1_reconcile`
  inserts the next disk when one is ready.
  - A running Amiga has no DF1 unit until it resets. At the next reset of either kind, Kickstart's ID read
    finds DF1.
- **On → off:** core1 sets `_df1_mode = OFF` first, so reconcile ejects DF1. Then core0 enters **parked**:
  - CHNG and WPROT stay asserted on DF1, and its ID answers NONE (0);
  - a running Amiga sees an empty drive, not a phantom disk (which is what releasing CHNG would show);
  - at the next reset Kickstart reads ID 0, so there is no DF1;
  - from the next board boot (stored OFF) every line is released.
- The ack follows apply on core0, and the flash record follows when both drives are empty.

- [ ] **Step 1: The handoff** (cursor, not a flag)

```c
// core1 -> core0: a new DF1 mode. core1 writes mode then seq; core0 applies
// when seq != applied, then publishes applied = seq. (A wake signal needs a
// cursor: a second change before the first is applied is just the next seq.)
static volatile uint8_t  g_df1_req_mode;
static volatile uint32_t g_df1_req_seq, g_df1_applied_seq;
static volatile uint32_t g_drive_boot_ack;          // the stored version at boot
```

  core1, after each `dc_step`:

```c
            {
                uint32_t seq; df1_mode_t mode;
                if (dc_drive_take(&c, &seq, &mode)) {
                    if (mode == DF1_MODE_OFF) { dc_set_df1(&c, DF1_MODE_OFF, DF1_HOLDS_HD); dc_df1_reconcile(&c); }
                    g_drive_req_version = seq;          // what the store record will say
                    g_df1_req_mode = (uint8_t)mode;
                    __dmb();
                    g_df1_req_seq++;
                    for (int i = 0; i < 50 && g_df1_applied_seq != g_df1_req_seq; i++) sleep_ms(1);
                    if (mode == DF1_MODE_NEXT) dc_set_df1(&c, DF1_MODE_NEXT, DF1_HOLDS_HD);
                    dc_drive_handled(&c, seq);         // handled = applied live (store may lag)
                    wf_logf(WF_INFO, "df1: setting %lu -> %s (takes effect at the Amiga's next reset)",
                            (unsigned long)seq, mode == DF1_MODE_NEXT ? "next disk" : "off");
                }
            }
```

  At core1 start, after `dc_init`: `c.drive_ack = g_drive_boot_ack;`.
- [ ] **Step 2: core0 apply + deferred store**, in the loop:

```c
        if (g_df1_req_seq != g_df1_applied_seq) {
            const df1_mode_t m = (df1_mode_t)g_df1_req_mode;
            g_df1_mode = m;
            if (m == DF1_MODE_NEXT) {
                bus_out_drive_id_set(1, DRIVE_ID_KIND_DD);
                bus_out_set_drive(1, PIN_WPROT, true);
                bus_out_set_drive(1, PIN_TRK0, cur_cyl[1] == 0);
                dskchg_image_ejected_d(1);                 // empty until reconcile inserts
            } else {                                       // parked (D3)
                bus_out_drive_id_set(1, DRIVE_ID_KIND_NONE);
                dskchg_image_ejected_d(1);
            }
            drive_store_pending = true;
            drive_store_rec.version = g_drive_req_version;
            drive_store_rec.mode = (uint8_t)m;
            g_df1_applied_seq = g_df1_req_seq;
        }
        if (drive_store_should_write(drive_store_pending, psram_active_slot() == SLOT_NONE) &&
            (int32_t)(clock_ms() - drive_save_retry_at) >= 0) {
            if (drive_store_save(&drive_store_rec)) {
                drive_store_pending = false;
                wf_logf(WF_INFO, "df1: setting %lu stored", (unsigned long)drive_store_rec.version);
            } else drive_save_retry_at = clock_ms() + 5000u;
        }
```

  Declare `drive_store_pending`, `drive_store_rec` (static) and `drive_save_retry_at` next to
  `display_save_retry_at`, and `g_drive_req_version` next to the handoff. Mirror the display store's comments on
  flash timing: the write runs only with no disk mounted, and core0 is locked out for its ~45 ms.
- [ ] **Step 3:** `test/run.sh`, `pnpm firmware:build` and the `build-df1` build. Commit
  `feat(fw): apply the DF1 setting live (parked when switched off) and store it when the drive is empty`.

### Task 20: Web — columns, guarded save, PATCH route, poll and status

**Files:**
- Create: `drizzle/0032_second_drive.sql`, `src/app/api/devices/[id]/second-drive/route.ts`,
  `src/app/api/devices/[id]/second-drive/route.test.ts`
- Modify: `src/db/schema/devices.ts`, `src/lib/second-drive.ts` (+ test), `src/lib/mount.ts` (`PollTick`,
  `readPollTick`, `recordStatus`), `src/app/api/device/poll/route.ts` (+ test), `src/app/api/device/status/route.ts`
  (+ test), `src/lib/queries.ts`, `src/lib/device-limits.test.ts`

**Interfaces:**
- Produces:
  - `type SecondDriveMode = 'off' | 'df1'`;
  - `saveSecondDrive(orgId, deviceId, mode, override): Promise<{ version: number } | 'not_found' | 'firmware_too_old' | 'df1_seen'>`;
  - `PATCH /api/devices/[id]/second-drive` with body `{ mode: 'off'|'df1', override?: boolean }`, answering
    200 `{version}` / 404 / 409 `{error:'firmware_too_old'|'df1_seen', reason}`;
  - `PollTick.secondDriveVersion: number`, `PollTick.secondDrive: SecondDriveMode`;
  - `DeviceListItem`: `secondDrive`, `secondDriveVersion`, `secondDriveAppliedVersion: number|null`,
    `secondDriveReported: SecondDriveMode|null`, `secondDriveCapable: boolean`, `df1Sha256: string|null`.

- [ ] **Step 1: Read** `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` (the dynamic
  `params` shape). Then write the migration.

```sql
-- drizzle/0032_second_drive.sql  (spec 2026-10-08 df1-second-drive §3; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive" text DEFAULT 'off' NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_applied_version" integer;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_reported" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_capable" boolean;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "df1_sha256" text;
```

  Schema:

```ts
  /** 'off' | 'df1' -- what the user chose (spec §3). Default off for every board. */
  secondDrive: text('second_drive').notNull().default('off'),
  /** Cursor, bumped on every change; the board echoes ?driveAck=. */
  secondDriveVersion: integer('second_drive_version').notNull().default(0),
  /** The board's driveAck as last reported; null = never. */
  secondDriveAppliedVersion: integer('second_drive_applied_version'),
  /** 'off' | 'df1' as the board runs it; null = firmware without DF1. */
  secondDriveReported: text('second_drive_reported'),
  /** The capability; null = never said, false = firmware before 1.9.0. */
  secondDriveCapable: boolean('second_drive_capable'),
  /** What DF1 holds now (a sha256), null = empty or off. */
  df1Sha256: text('df1_sha256'),
```

  Then `pnpm db:generate --name second_drive`, trimmed to the file above.
- [ ] **Step 2: Failing tests.**

  `src/app/api/devices/[id]/second-drive/route.test.ts` mocks `requireOrg` and `saveSecondDrive`, in
  `display/route.test.ts`'s style if it exists. Otherwise copy `next/route.test.ts`'s mocking pattern.

```ts
it('refuses DF1 when a real DF1 was seen, and says why', async () => {
  saveSecondDrive.mockResolvedValue('df1_seen');
  const res = await PATCH(req({ mode: 'df1' }), ctx('dev-1'));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'df1_seen', reason: 'A drive already answers as DF1 on this Amiga' });
  expect(saveSecondDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'df1', false);
});
it('passes an explicit override through', async () => {
  saveSecondDrive.mockResolvedValue({ version: 3 });
  const res = await PATCH(req({ mode: 'df1', override: true }), ctx('dev-1'));
  expect(res.status).toBe(200);
  expect(saveSecondDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'df1', true);
});
it('needs firmware 1.9.0', async () => {
  saveSecondDrive.mockResolvedValue('firmware_too_old');
  const res = await PATCH(req({ mode: 'df1' }), ctx('dev-1'));
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.9.0 or newer' });
});
it('rejects anything but off/df1', async () => {
  expect((await PATCH(req({ mode: 'df2' }), ctx('dev-1'))).status).toBe(400);
});
```

  Poll route test (append; `baseTick` gains `secondDriveVersion: 0, secondDrive: 'off'`):

```ts
it('wakes on a driveAck mismatch and carries secondDrive inline', async () => {
  readPollTick.mockResolvedValue(baseTick({ secondDriveVersion: 2, secondDrive: 'df1' }));
  const res = await GET(get('?since=1&driveAck=1'));
  expect(res.status).toBe(200);
  expect((await res.json()).secondDrive).toEqual({ seq: 2, mode: 'df1' });
});
it('never wakes or sends secondDrive to a board without driveAck', async () => {
  readPollTick.mockResolvedValue(baseTick({ version: 2, secondDriveVersion: 5, secondDrive: 'df1' }));
  const body = await (await GET(get('?since=1'))).json();
  expect(body.secondDrive).toBeUndefined();
});
```

  Status route test: `secondDrive: 'df1', driveVersion: 3, df1Sha256: 'a'.repeat(64)` pass through; `'df2'` and
  `driveVersion: -1` are dropped (undefined).

  `src/lib/second-drive.test.ts`, for the pure text helper:

```ts
import { secondDriveStatus } from './second-drive';
it('says what the board is doing with the setting', () => {
  const base = { secondDriveCapable: true, secondDriveVersion: 2, secondDriveAppliedVersion: 2 };
  expect(secondDriveStatus({ ...base, secondDriveCapable: false })).toBe('Needs firmware 1.9.0 or newer');
  expect(secondDriveStatus({ ...base, secondDriveAppliedVersion: 1 })).toBe('Waiting for the board');
  expect(secondDriveStatus(base)).toBe('Set on the board — takes effect when the Amiga restarts');
});
```

  `device-limits.test.ts`: add `const drive = ',"secondDrive":{"seq":4294967295,"mode":"df1"}';` to `worst`, and
  update the margin comment (≈1462 of 1536).
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement**

  `src/lib/second-drive.ts` (append):

```ts
import { and, eq, or, sql, isNull, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

export type SecondDriveMode = 'off' | 'df1';
export type SaveSecondDriveOutcome = { version: number } | 'not_found' | 'firmware_too_old' | 'df1_seen';

export const SECOND_DRIVE_FW = '1.9.0';
export const DF1_SEEN_REASON = 'A drive already answers as DF1 on this Amiga';

/**
 * One org-scoped conditional UPDATE (the saveDisplay pattern): the capability and
 * the df1Seen guard live in the WHERE, so a report landing between a read and a
 * write cannot slip a refused setting through. Switching OFF is never refused.
 */
export async function saveSecondDrive(
  orgId: string, deviceId: string, mode: SecondDriveMode, override: boolean,
): Promise<SaveSecondDriveOutcome> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const guard = mode === 'off' || override
    ? sql`true`
    : or(isNull(devices.df1Seen), ne(devices.df1Seen, true));
  const [row] = await db.update(devices)
    .set({ secondDrive: mode, secondDriveVersion: sql`${devices.secondDriveVersion} + 1` })
    .where(and(scope, eq(devices.secondDriveCapable, true), guard))
    .returning({ version: devices.secondDriveVersion });
  if (row) return { version: row.version };
  const [r] = await db.select({ capable: devices.secondDriveCapable, seen: devices.df1Seen })
    .from(devices).where(scope).limit(1);
  if (!r) return 'not_found';
  if (r.capable !== true) return 'firmware_too_old';
  return 'df1_seen';
}

export function secondDriveStatus(d: {
  secondDriveCapable: boolean; secondDriveVersion: number; secondDriveAppliedVersion: number | null;
}): string {
  if (!d.secondDriveCapable) return `Needs firmware ${SECOND_DRIVE_FW} or newer`;
  if (d.secondDriveAppliedVersion !== d.secondDriveVersion) return 'Waiting for the board';
  return 'Set on the board — takes effect when the Amiga restarts';
}
```

  `src/app/api/devices/[id]/second-drive/route.ts`:

```ts
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { saveSecondDrive, SECOND_DRIVE_FW, DF1_SEEN_REASON } from '@/lib/second-drive';

const body = z.object({ mode: z.enum(['off', 'df1']), override: z.boolean().optional() });

// CSRF: as every device route here, Better Auth's SameSite=Lax session cookie (see ../mount/route.ts).
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  const r = await saveSecondDrive(orgId, id, parsed.data.mode, parsed.data.override === true);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (r === 'firmware_too_old') {
    return Response.json({ error: 'firmware_too_old', reason: `Needs firmware ${SECOND_DRIVE_FW} or newer` }, { status: 409 });
  }
  if (r === 'df1_seen') return Response.json({ error: 'df1_seen', reason: DF1_SEEN_REASON }, { status: 409 });
  return Response.json({ version: r.version });
}
```

  - `mount.ts`: `PollTick` gains `secondDriveVersion: number; secondDrive: SecondDriveMode;`, and `readPollTick`
    selects `secondDriveVersion: devices.secondDriveVersion, secondDrive: devices.secondDrive` (cast the text to
    the union with a `=== 'df1' ? 'df1' : 'off'` map in the return).
  - `recordStatus` gains `secondDrive?`, `driveVersion?` and `df1Sha256?`:

```ts
  // Build-bound (the playsHd rule): silent on secondDrive with a firmwareVersion = a build without DF1.
  if (s.secondDrive !== undefined) { patch.secondDriveCapable = true; patch.secondDriveReported = s.secondDrive; }
  else if (s.firmwareVersion !== undefined) { patch.secondDriveCapable = false; patch.secondDriveReported = null; }
  // Plain assignment: a re-paired board's ack can go down (the displayVersion rule).
  if (s.driveVersion !== undefined) patch.secondDriveAppliedVersion = s.driveVersion;
  if (s.df1Sha256 !== undefined) patch.df1Sha256 = s.df1Sha256;
  else if (s.firmwareVersion !== undefined && s.secondDrive === undefined) patch.df1Sha256 = null;
```

  - Status zod:

```ts
  secondDrive: z.enum(['off', 'df1']).optional().catch(undefined),
  driveVersion: z.number().int().min(0).max(2_147_483_647).optional().catch(undefined),
  df1Sha256: z.string().regex(SHA256_RE).nullable().optional().catch(undefined),
```

    Pass the three into `recordStatus`. Note: `df1Sha256` arrives with Phase 2 firmware (1.8.0); before this task
    the server dropped it as an unknown key, which is harmless.
  - Poll route: parse `driveAck` exactly like `displayAck` (copy the block and its reasoning in one line:
    "Parsed like displayAck, for the same reasons"). Then:

```ts
    const driveMoved = driveAck !== null && tick.secondDriveVersion !== driveAck;
```

    Add `|| driveMoved` to the wake condition, and to the body after `displayVersion`:

```ts
          // Inline: one byte of setting needs no fetch (spec §3). Every body for a board
          // that sent driveAck, so a re-paired board's higher ack is reset at its first 200.
          ...(driveAck !== null ? { secondDrive: { seq: tick.secondDriveVersion, mode: tick.secondDrive } } : {}),
```

  - `queries.ts`: select the six columns. Map `secondDriveCapable: r.secondDriveCapable === true`, and map
    `secondDrive` / `secondDriveReported` to the union, or null.
- [ ] **Step 5: Run, expect PASS** — `pnpm vitest run src/lib src/app/api` and `pnpm tsc --noEmit`.
- [ ] **Step 6: Apply 0032 to the live DB** (psql, as Task 3 Step 6).
- [ ] **Step 7: Commit** (body: "Migration 0032 applied to the live DB before e2e.")
  `feat(devices): DF1 setting -- columns, guarded save, PATCH, poll delivery, status`.

### Task 21: The setting on the device card (refusal, override, readings)

**Files:** Create `src/components/devices/second-drive-setting.tsx`; modify `src/components/devices/device-card.tsx`.

**Interfaces:**
- Consumes: `secondDriveStatus`, `DF1_SEEN_REASON`, the PATCH route, `HelpTip topic="second-drive"` (Task 22).
- Produces test ids:
  - `second-drive-${id}` (select), `second-drive-status-${id}`, `second-drive-refused-${id}`;
  - `second-drive-override-${id}` (first button), `second-drive-override-confirm-${id}` (second);
  - `device-df1-disk-${id}`.

- [ ] **Step 1: Implement**

```tsx
'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceListItem } from '@/lib/queries';
import { secondDriveStatus, DF1_SEEN_REASON } from '@/lib/second-drive';
import { HelpTip } from '@/components/help/help-tip';

/** Second drive (DF1): Off | Next disk of the set (spec §3). Refused while a real DF1 was seen,
 *  with an override behind a second confirmation (operator ruling 2026-10-08). */
export function SecondDriveSetting({ device }: { device: DeviceListItem }) {
  const id = device.id;
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [step, setStep] = useState<0 | 1>(0);   // 1 = "are you sure" shown

  async function save(mode: 'off' | 'df1', override = false) {
    setBusy(true);
    try {
      const res = await fetch(`/api/devices/${id}/second-drive`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, override }),
      });
      if (res.status === 409) {
        const j = await res.json() as { error: string; reason: string };
        setRefused(j.error === 'df1_seen' ? DF1_SEEN_REASON : j.reason);
        return;
      }
      setRefused(null); setStep(0);
      startRefresh(() => router.refresh());
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
      <label className="flex items-center gap-2">
        Second drive (DF1)
        <select data-testid={`second-drive-${id}`} value={device.secondDrive}
                disabled={!device.secondDriveCapable || busy || refreshing}
                onChange={(e) => save(e.target.value as 'off' | 'df1')}
                className="rounded border px-1 py-0.5" style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
          <option value="off">Off</option>
          <option value="df1">Next disk of the set</option>
        </select>
        <HelpTip topic="second-drive" />
      </label>
      <span data-testid={`second-drive-status-${id}`}>{secondDriveStatus(device)}</span>
      {refused && (
        <div className="flex flex-col gap-1 rounded-lg px-2 py-1" style={{ background: 'var(--input-bg)', color: 'var(--amber-text)' }}
             data-testid={`second-drive-refused-${id}`}>
          <span>{refused}. Switching DF1 on would make both drives unreadable.</span>
          {step === 0 ? (
            <button type="button" className="self-start underline" onClick={() => setStep(1)}
                    data-testid={`second-drive-override-${id}`}>Switch on anyway…</button>
          ) : (
            <button type="button" className="self-start font-semibold underline" disabled={busy}
                    onClick={() => save('df1', true)}
                    data-testid={`second-drive-override-confirm-${id}`}>
              Yes, I have removed the other DF1 drive — switch DF1 on
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

  In `device-card.tsx`, under the `SecondDriveReadings` from Task 3, render `<SecondDriveSetting device={device} />`.
  When `device.secondDrive === 'df1'`, also render a line with `data-testid={`device-df1-disk-${device.id}`}`:
  - `"DF1: empty"` when `df1Sha256` is null;
  - otherwise `"DF1: next disk ready"`.

  Name the disk only if `readNextForDevices` already gives its number. Check `next` on the card: if
  `next?.preload === 'ready'`, say `DF1: disk ${next.diskNo}`. Both values are shown.
- [ ] **Step 2:** `pnpm tsc --noEmit` and `pnpm lint` clean.
- [ ] **Step 3: Commit** `feat(devices): Second drive (DF1) setting on the card, with refusal and override`.

### Task 22: Help topic `second-drive`

**Files:** Modify `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`

- [ ] **Step 1: Failing tests** (`topics.test.ts`)
  - Add `'second-drive'` to `IDS`.
  - Rename the test title "has exactly the eight spec topics" to "has exactly the spec topics".
  - Then append:

```ts
describe('second-drive states every caveat the operator asked for', () => {
  const all = () => HELP_TOPICS['second-drive'].short + ' ' + bodyText('second-drive');
  it('DF1 is read-only: saves fail as write-protected', () => expect(all()).toMatch(/write-protected/i));
  it('takes effect at the next Amiga restart, cold or warm', () => {
    expect(all()).toMatch(/restart/i);
    expect(all()).toMatch(/Ctrl-Amiga-Amiga|warm/i);
  });
  it('only when no other drive is DF1, naming both kinds', () => {
    expect(all()).toMatch(/external drive/i);
    expect(all()).toMatch(/second internal drive/i);
  });
  it('big boxes: the external port is DF2 there', () => expect(all()).toMatch(/DF2/));
  it('DF1 empties for about five seconds on Next disk', () => expect(all()).toMatch(/five seconds|5 seconds/i));
  it('only the next disk of the set', () => expect(all()).toMatch(/next disk of the set/i));
  it('the refusal and its override', () => {
    expect(all()).toMatch(/refuse/i);
    expect(all()).toMatch(/anyway/i);
  });
  it('names the firmware it needs', () => expect(all()).toMatch(/1\.9\.0/));
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (append to `HELP_TOPICS`; add `'second-drive'` to `HELP_ORDER` after `'next-disk'`).
  Count the body words: 60-260. Avoid the banned words.

```tsx
  // Sources: second-drive-setting.tsx (texts, refusal, override); src/lib/second-drive.ts (SECOND_DRIVE_FW,
  // DF1_SEEN_REASON, saveSecondDrive guard); firmware main.c (DF1 WPROT always asserted -> "write-protected";
  // WGATE ignored with SEL0 high); drive_store.c + main.c boot read before bus_out_init and the live apply
  // (Task 19: Kickstart reads drive IDs at every reset -> "restart, cold or warm"); device_client.c
  // dc_df1_want (only the verified next disk; empty during the fetch after Next disk, ~5 s per HANDOFF 3ap);
  // spec §2 (big boxes: second internal drive is DF1, the external port is DF2 and SEL2 is not on J1);
  // bus_gate.h bus_df1_seen (a real DF1 seen when it steps). Kickstart 1.3: add a line ONLY once Phase 2
  // bench step 8 records it.
  'second-drive': {
    title: 'Second drive (DF1)',
    short:
      'The board can also be your DF1, holding the next disk of the set, so games that read disk 2 from DF1 need no swapping. Off unless you switch it on.',
    body: (
      <>
        <p>
          Choose <em>Next disk of the set</em> under <em>Second drive (DF1)</em> on the board&apos;s card. DF1 then
          holds the disk after the one in DF0. When you press <em>Next disk</em>, DF0 moves on at once and DF1 is
          empty for about five seconds while the following disk is fetched.
        </p>
        <p>
          The change takes effect when the Amiga restarts: switch it off and on, or press Ctrl-Amiga-Amiga for a
          warm restart.
        </p>
        <p>
          Use it only when no other drive is DF1. On an A500, A600 or A1200 that means no external drive. On an
          A2000, A3000 or A4000 it means no second internal drive; the external port there is DF2, which the board
          does not affect. If the board has seen another drive answer as DF1, the setting refuses to switch on. You
          can override it with <em>Switch on anyway</em> and a second confirmation, after removing that drive.
        </p>
        <GoodToKnow items={[
          'DF1 is read-only: saving to it fails as write-protected. Saves to DF0 work as usual.',
          'DF1 only ever holds the next disk of the set. You cannot pick another disk for it.',
          'Needs board firmware 1.9.0 or newer.',
        ]} />
      </>
    ),
  },
```

- [ ] **Step 4: Run, expect PASS** (including the word-count and banned-word tests for the new id).
- [ ] **Step 5: Commit** `feat(help): Second drive (DF1) topic with every operator caveat`.

### Task 23: e2e — the setting, the refusal and the override

**Files:** Create `e2e/second-drive.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect, type APIRequestContext } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

async function report(request: APIRequestContext, token: string, extra: Record<string, unknown>) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: '1.9.0', ...extra },
  });
  expect(res.status()).toBe(204);
}
const row = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];

test('a board without DF1 support is told which firmware it needs', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.7.4' });
  await page.goto('/devices');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Needs firmware 1.9.0 or newer');
  await expect(page.getByTestId(`second-drive-${deviceId}`)).toBeDisabled();
});

test('switching DF1 on reaches the board through the poll and reads applied once acked', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await expect(page.getByTestId(`device-df1seen-${deviceId}`)).toHaveText('Other DF1 drive: none seen');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('df1');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Waiting for the board');
  expect((await row(deviceId)).secondDriveVersion).toBe(1);

  const poll = await request.get('/api/device/poll?since=0&driveAck=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).secondDrive).toEqual({ seq: 1, mode: 'df1' });

  await report(request, token, { secondDrive: 'df1', driveVersion: 1, sel1Wired: true, df1Seen: false });
  await page.reload();
  await expect(page.getByTestId(`second-drive-status-${deviceId}`))
    .toHaveText('Set on the board — takes effect when the Amiga restarts');
});

test('a seen DF1 refuses the switch; the override needs a second confirmation', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: true });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('df1');
  await expect(page.getByTestId(`second-drive-refused-${deviceId}`)).toContainText('A drive already answers as DF1 on this Amiga');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);           // nothing saved
  await page.getByTestId(`second-drive-override-${deviceId}`).click();
  expect((await row(deviceId)).secondDriveVersion).toBe(0);           // one click is not enough
  await page.getByTestId(`second-drive-override-confirm-${deviceId}`).click();
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('df1');
});

test('the help tip opens and names the caveats', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  await report(request, token, { secondDrive: 'off', driveVersion: 0 });
  await page.goto('/devices');
  await page.getByTestId('help-tip-second-drive').first().click();
  await expect(page.getByText(/next disk of the set/i).first()).toBeVisible();
});
```

  - The select reverts visually after a refusal because the server value is unchanged and `router.refresh()`
    is not called. That is intended: the control shows what is stored.
- [ ] **Step 2: Run the scoped e2e, serialized, PORT=3100**, each under 9 minutes:
  1. `PORT=3100 pnpm e2e e2e/second-drive.spec.ts e2e/device-poll.spec.ts e2e/device-status.spec.ts`
  2. `PORT=3100 pnpm e2e e2e/devices-page.spec.ts e2e/display-layout.spec.ts e2e/next-disk.spec.ts`
  3. `PORT=3100 pnpm e2e e2e/help.spec.ts e2e/help.mobile.spec.ts e2e/mobile.spec.ts`

  All green. If `help.spec.ts` counts topics, update its count to include `second-drive`.
- [ ] **Step 3: Commit** `test(e2e): DF1 setting, refusal and override`.

### Task 24: Ship 1.9.0 and Phase 3 bench

**Files:** `CMakeLists.txt` (`1.9.0`), `HANDOFF.md` 3bb (rulings D1-D4 as decided, versions, bench results).

- [ ] **Step 1:** Bump. `test/run.sh` and `pnpm firmware:build`. `pnpm vitest run`. Commit
  `chore(fw): 1.9.0 -- DF1 setting from the web app`.
- [ ] **Step 2:** Merge to master; the migrations were applied in Tasks 3 and 20. Then run
  `pnpm firmware:publish --notes "Second drive (DF1): next disk of the set, read-only, set per board"` and target
  WifiFloppy1.
- [ ] **Step 3: Bench checklist, Phase 3** (operator; one step per turn; A500 rev 8a.1)
  1. **Install 1.9.0** (Amiga on, idle, no disk).
     - PASS: the card shows the **Second drive (DF1)** control enabled, set to **Off**, with "Set on the board".
  2. **Switch on from the web**, with the Workbench 3.1 set disk 2 mounted.
     - PASS: within one poll the status reads **"Set on the board — takes effect when the Amiga restarts"**,
       and `info` on the running Amiga does **not** yet list DF1.
  3. **Ctrl-Amiga-Amiga.**
     - PASS: `info` lists **DF1: Locale**.
  4. **Switch off from the web, then Ctrl-Amiga-Amiga.**
     - PASS: `info` lists DF0 only, and DF1 shows no phantom disk before the reset.
  5. **Power cycle with the setting On** (switch on, wait for "Set on the board", eject DF0 for 10 s so it can be
     stored, mount disk 2 again, then power off and on).
     - PASS: DF1 is listed at the first boot after power-on. The serial line `df1: next disk of the set at boot
       (stored)` appears.
  6. **Refusal, with the real external drive** (power off, fit the drive with a disk, power on, wait for
     **"Other DF1 drive: detected"**, set the board's DF1 Off first if needed). Choose "Next disk of the set".
     - PASS: the card shows the refusal, and nothing changes on the board.
  - Record every result in HANDOFF 3bb, and in the help topic only what passed. Add a Kickstart 1.3 line only if
    Phase 2 step 8 recorded it.

---

## Decision ledger (fill in as Task 5 and the benches settle each)

| ID | Measured value | Decision | Date |
|---|---|---|---|
| D1 | `pio claims:` = … | … | |
| D2 | heap low-water H = …; H − 14,336 = … | … | |
| D3 | ruled in Task 19 | parked on live-off | 2026-10-08 (plan) |
| D4 | per D1 | … | |

## Self-review (done while writing)

- **Spec coverage:**
  - §6 step 0 → Tasks 1-4. Step 1 → Tasks 5-11. Step 2 → Tasks 12-17. Step 3 → Tasks 18-24.
  - Step 4 (idea 4) is out by ruling. Step 5 (write-back, third slot, rev C sense) is not planned.
  - §3's delivery pattern: the column, capability, `driveAck` and inline value → Tasks 18 and 20. The flash
    record → Task 12. Boot read → Task 16. The `df1Seen` guard → Task 20. Readings → Task 3.
  - §4: per-drive state → Task 10. PIO → Tasks 6-9. WPROT/WGATE → Task 16. Slot rule → Task 13. The 5 s gap →
    Task 15.
- **Spec items found wrong or risky, and how the plan treats them:**
  1. **`drive_id` with two SMs cannot keep the ID in `instr_mem`.** The program is shared, so rewriting
     `reset_load` would change both drives' answers. Task 8 moves each drive's ID into its own Y.
  2. **`flux_out`'s `out x, 1 side 0` applies its side-set even while stalled** (datasheet §11.2.5). An idle DF1
     SM (no stream, so stalled on `out`) would write RDATA = 0 on every cycle. Being the higher-numbered SM, it
     would win over DF0's `side 1` pulse (§11.2.6), and DF0 would read as a dead drive. The spec presents
     dropping `side 0` as an option; it is mandatory. Task 6 pins it in the model.
  3. **The spec's heap headroom is optimistic.** It quotes ~105 KB, but the 1.7.0 bench low-water was 36,864 B.
     An HD-capable DF1 buffer (+25,344) would breach the 20 KB floor. D2 defaults to DD-only, gated on
     measurement.
  4. **The spec says "a setting applied live takes effect at the next reset".** Switching DF1 *off* live by
     releasing its lines would show a running Amiga a phantom disk (CHNG released = disk present). D3 parks
     instead.
  5. **The spec has DF1 empty "until the preload is ready" but no write-safety handshake.** Today core0 never
     reads the idle slot, and DF1 makes it do so. Task 13 adds the acknowledge cursor and Task 15 enforces it.
  6. **A `version` key inside the poll's `secondDrive` object** would be blanked-or-shadowed against the
     top-level `version`. It is named `seq` and lifted first (Task 18).
  7. **Status-body headroom was 63 bytes.** The three new tails need 159, so Task 15 raises the budget. The poll
     path's 96-byte buffer would hold 93, so Task 18 raises it.
- **Placeholder scan:** the code steps carry code. Where a step depends on an existing test helper, the step
  names it and says to read the file first. Those are pointers to real code, not "TBD".
- **Type consistency:** `df1_mode_t`/`DF1_MODE_*`, `drive_id_kind_t`/`DRIVE_ID_KIND_*`, `bus_out_set_drive`,
  `psram_publish_df1`/`psram_df1_*`, `dc_set_df1`/`dc_df1_reconcile`/`dc_drive_take`/`dc_drive_handled`,
  `SecondDriveMode`/`saveSecondDrive`/`secondDriveStatus`, and the test ids are used identically across tasks.
