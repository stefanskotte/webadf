# One-file drag-and-drop first install (RP2350, PIM726) — feasibility research

Date: 2026-10-09. Read-only research; nothing was built, flashed or committed.
Requirement (operator, 2026-10-09, HANDOFF backlog): hold BOOTSEL, plug in, drop ONE `.uf2`, and the board
boots our firmware with over-the-air updates working afterwards. No picotool, no second file.

**Answer: feasible, without any first-boot self-migration code.** Ship one UF2 with the **absolute** family ID. It holds
(a) the partition table at flash 0, (b) a **non-TBYB** build of the same firmware at partition A (flash 0x8000), and
(c) two 256-byte 0xFF pages that erase stale headers. The boot ROM writes all of it in one transfer. The reboot after the
download boots partition A normally. The existing A/B + TBYB OTA path then works unchanged.

The idea that does NOT work, and why: the TBYB image we build today cannot be the image in a one-file install. An absolute
UF2's post-download reboot never "flash-update"-targets partition A, and the ROM refuses to boot a TBYB image outside a
flash update for its own partition. That is the same mechanism behind BENCH T4.8.

Sources used:
- RP2350 datasheet (`~/Downloads/RP-008373-DS-2-rp2350-datasheet.pdf`, via `pdftotext -layout`).
- The RP2350 boot ROM source: `github.com/raspberrypi/pico-bootrom-rp2350` @ c6cdb17 (2025-07-29), cloned to a scratchpad.
  This is the latest public ROM (A3/A4-era); A2 differs where erratum E10 says so.
- picotool source @ 2041936, and the installed picotool v2.3.0.
- pico-sdk 2.3.0 at `~/pico-sdk`.
- pico-examples (cloned).
- This repo: `wifi-floppy/firmware/{CMakeLists.txt,partitions.json,src/fw_rom.c,src/fw_state.*}`,
  `scripts/firmware-install-partitioned.sh`, HANDOFF.
- A header dump of the built `build/wifi_floppy.uf2` and `build/wifi_floppy_pt.uf2`.

Each claim below is tagged **[DS]** datasheet, **[ROM]** boot ROM source, **[SDK]**, **[REPO]**, **[MEASURED-offline]**
(something I ran here, against no hardware) or **[ASSUMED]**.

---

## 1. What the boot ROM does when a UF2 download completes

**It always reboots, and for flash it is a FLASH_UPDATE boot.**

- [DS 5.1.16] "The bootrom automatically performs a flash update boot after programming a flash UF2 written to the USB
  Mass Storage drive."
- [DS 5.5.2] "When rebooting after a flash download, a flash update boot is performed. As a result, the newly written
  partition is preferred when considered in an A/B choice, but it doesn't boot if another bootable image is found in an
  earlier partition."
- [ROM `src/nsboot/usb_virtual_disk.c` `write_uf2_page_complete`] Once every block has been seen
  (`valid_block_count == num_blocks`) and the target partition lacks the `no_reboot` flag, the ROM calls
  `reboot(FLASH_UPDATE, 500 ms, p0 = XIP_BASE + _uf2_info.offset)`. **The flash-update window is the start of the
  partition the UF2 was targeted at**, not the first or lowest block written.
  - An `rp2350-arm-s` UF2 sets `offset` to the target partition's first sector.
  - An **absolute** UF2 targets the "default partition" (unpartitioned space). Its first sector is 0
    (`varm_flash_permissions.h` `inline_s_varm_flashperm_get_default_partition`), so **the window is 0x10000000**: slot 0
    of the partition table, never partition A at 0x8000.
  - An arm-s UF2 also forces the reboot into Arm, and absolute adds no architecture flag. That is harmless here, because
    Arm is the default.

**Does the reboot start a TBYB image as a trial?** Only when the window equals that image's partition start.
- [ROM `src/main/arm/varm_launch_image.c` ~208]:
  `if (ctx->flash_update_boot_offset != parsed_block_loop->flash_start_offset) { ... if (image_def->core.tbyb_flagged) { printf("NOT booting TBYB flagged image which isn't the flash update"); rc = BOOTROM_ERROR_INVALID_STATE; ...`
- [DS 5.1.17] "Note that a non TBYB image will always be chosen over a TBYB image in A/B partitions during a normal
  non-FLASH_UPDATE boot."

What this means for each kind of drop:
- An **arm-s TBYB UF2** dropped on a board that already has our partition table goes to the non-booting slot
  ([DS 5.5.3.1]: "you want to drop the UF2 on the partition which isn't currently booting"). It **does** start as a trial,
  because the window is that slot. So drag-and-drop *upgrades* of a partitioned board already work with today's
  `wifi_floppy.uf2` [ROM + DS]. This is not bench-verified.
- An **absolute UF2** (the only way to deliver a partition table) gets window 0. A TBYB image inside it at 0x8000 is
  refused at launch, and the board falls back to BOOTSEL. That is exactly what BENCH T4.8 saw after a plain
  `picotool reboot`. `picotool load -x` works because picotool sends its own FLASH_UPDATE reboot with the partition's
  base (`picotool help load`: "-x … a flash update boot for binaries in flash").
- A side finding about **today's** install: an image installed with `load -p 0 -x` stays TBYB-flagged until the firmware
  proves itself and buys. The proof needs Wi-Fi and the server. A **power cycle before the first proven buy** is therefore
  a normal boot, partition A's TBYB image is refused, and the board comes up in BOOTSEL. Reading `fw_rom.c` I3
  ("A USB-install trial waits for the portal and pairing as long as they take"), a user who unplugs mid-setup today gets
  a board that looks dead. [ROM + REPO, inferred, not bench-tested.] The recommended design removes this, because the
  install image is never TBYB.

## 2. UF2 family IDs, targeting, and one UF2 carrying both table and image

Family IDs ([DS Table 455]):

| Family | ID |
|---|---|
| absolute | 0xe48bff57 |
| rp2040 | 0xe48bff56 |
| data | 0xe48bff58 |
| rp2350_arm_s | 0xe48bff59 |
| rp2350_riscv | 0xe48bff5a |
| rp2350_arm_ns | 0xe48bff5b |

Partition tables may declare user family IDs.

Placement rules:
- **No partition table in flash.** `data`, `rp2350-arm-s` and `rp2350-riscv` are accepted and written "to the start of
  flash" [DS 5.1.18, 5.5.3]. `absolute` is accepted by factory default.
- **A partition table in flash.** Non-absolute families go into one partition, mapping 0x10000000 to the partition start
  [DS 5.5.1]. Absolute "is downloaded without regard to partition boundaries" if the table's unpartitioned-space flags
  accept it: "If set for un-partitioned space, a UF2 with the ABSOLUTE family id … will be written at the addresses
  specified in the UF2 without regard to partition locations. Partition-defined flash access permissions are still
  respected" [DS, PT flags table, `FLAGS_ACCEPTS_DEFAULT_FAMILY_ABSOLUTE_BITS`].
  - **Our `partitions.json` has `"unpartitioned": { "families": ["absolute"], … bootloader: rw }`, and both partitions are
    `bootloader: rw`** [REPO]. So an absolute re-install onto an already-partitioned board is allowed.

**Mixing families in one file does not work.**
- [DS 5.5.2] "A change in the familyID will discard the current transfer in progress."
- [DS 5.5.3.2] "it is only supported to download a UF2 file containing multiple family IDs if only one of those family
  IDs is acceptable for download to the device."
- [ROM `_update_current_uf2_info`] "we don't support two downloadable family IDs in the same UF2 (unless they come 100%
  in order)". Even "in order" fails us: the 1-block absolute PT transfer completes, schedules a 500 ms reboot, and the
  arm-s transfer that follows is cut off. The arm-s target is also computed against the table cached before the new one
  landed.
- So **"PT UF2 + firmware UF2 concatenated" is out**, and so is `wifi_floppy_pt.uf2` + `wifi_floppy.uf2`.

**An all-absolute file carrying both does work.** Every block uses the absolute family, the same `numBlocks` and
sequential `blockNo`. Block addresses are physical flash addresses:
- the PT at 0x10000000;
- the image at 0x10008000 (partition A's start, from `partitions.json` `"start": "32K"`).

The image is linked for 0x10000000 and runs from partition A through the ROM's address translation ("roll"), exactly as
after `picotool load -p 0`, which writes the same bytes to the same physical place.
[ROM `varm_launch_image.c` roll/ATRANS; REPO HANDOFF D2 on `XIP_BASE` vs NOTRANSLATE.]
Prior art for an absolute-family UF2 at flash 0 carrying a partition table: pico-examples `bootloaders/encrypted`
(`pico_set_uf2_family(enc_bootloader "absolute")` + `pico_package_uf2_output`).

**Already partitioned (re-install / upgrade by drag).**
- An absolute download rewrites the table bytes in slot 0. They are identical, and with window 0 the slot-0 table is
  chosen "irrespective of version" [DS 5.1.16].
- It rewrites partition A. Partition B is untouched unless the UF2 writes there. That is why the design adds one 0xFF page
  at B's start (§6).
- The arm-s release UF2 goes to the non-booting slot as a trial (§1).

**Erratum RP2350-E10 (A2 silicon only)** [DS errata]: "UF2 drag-and-drop doesn't work with partition tables". The
workaround is "a single block … with an Absolute family ID, targeting the end of Flash … This workaround means that the
last block of flash is erased when downloading such a UF2". picotool 2.1+ tags that block `UF2_EXTENSION_RP2_IGNORE_BLOCK`,
and A3+ ROMs skip it [ROM `vd_write_block`].
- **Finding [MEASURED-offline]: our current `build/wifi_floppy.uf2` begins with that block at 0x10ffff00 (flags 0xa000,
  ext 0x9957e304).** The SDK board file `pimoroni_pico_plus2_w_rp2350.h` sets `PICO_RP2350_A2_SUPPORTED=1`, and
  `tools/CMakeLists.txt` then adds `--abs-block` (default location 0x10ffff00).
- **0x10ffff00 is inside the last 4 KB sector, which is our device-token record (sector −1).** On an **A2** chip,
  drag-dropping today's UF2 would erase the token. On A3/A4 the block is ignored.
- The install UF2 must therefore **not** carry an abs-block. It does not need one: it is absolute already, and E10 concerns
  non-absolute targeting through the table. [ASSUMED for A2: inferred from the workaround's own mechanism, an absolute
  first block, and not tested on A2 silicon.]
- **Open:** which stepping is on the operator's PIM726? `picotool info -d` reports the chip revision (picotool
  `determine_chip_revision` → rp2350_a2/a3/a4).

## 3. Embedded partition table (`pico_embed_pt_in_binary`) and first-boot self-install

What the SDK does: `pico_embed_pt_in_binary(TARGET PTFILE)` runs `picotool partition create PTFILE in.elf out.elf`. That
adds a PARTITION_TABLE block to the image's own block loop [SDK `tools/CMakeLists.txt` 480-494, 687-717].

What the ROM does with it:
- [DS 5.1.14, "Partition-Table-in-Image boot"] "If both a PARTITION_TABLE and an IMAGE_DEF block are found in the valid
  block loop that starts within the first 4 kB of flash … The PARTITION_TABLE is loaded as the current partition table, and
  the IMAGE_DEF is launched directly. The table defined by the PARTITION_TABLE is not searched for IMAGE_DEFs to boot."
- **It is loaded into RAM for that boot only. Nothing writes it to flash.** The image must sit at flash 0, so it occupies
  where a flash table would go.
- There is no ROM API that writes a partition table to flash. `load_partition_table()` [DS 5.4.8.20] only loads one.

A first-boot self-install (an image at flash 0 with an embedded table that writes the real table and moves itself to slot
A) is possible in principle. **I recommend against it:**
- The move overlaps: 0x0 → 0x8000, ~600 KB. It has to copy top-down from a RAM-resident routine, because the code being
  copied is the code running.
- The image cannot be copied to RAM whole: the 600,280-byte `.bin` [REPO] exceeds the 520 KB SRAM. That rules out
  `copy_to_ram` and RAM-only UF2s (0x20000000-0x20082000, [DS 5.5.2]) too.
- A power cut mid-move leaves neither image whole. The ROM's BOOTSEL is still there, so the board can be recovered, but
  this adds new code on the riskiest path for no gain over §6.
- It would also need its own build target, a no-PT/at-0 link, and table-writing code. The absolute UF2 gets the same
  result with zero firmware code, because the ROM does the flash writes.

The other risks the brief asked about:
- **TBYB buy timing / the PSRAM buy hang** (memory, HANDOFF "THE FINDING": `rom_explicit_buy` wedges with PSRAM
  configured, and the watchdog does not rescue it). The recommended install image is **non-TBYB**, so first boot needs no
  buy. The first buy happens on the first OTA, through the existing bench-proven `fw_rom_boot_early` (buy before
  `runtime_init_setup_psram`). No new exposure.
- **Power loss mid-drag.** Nothing of ours runs during the write. The ROM erases and programs sector by sector. A partial
  image fails its SHA-256 hash (`pico_hash_binary`) and is not booted, so the board shows BOOTSEL again and the user
  re-drops. [ROM: hash verify before launch; ASSUMED that a partial slot-0 table write behaves as "no PT": it is hashed
  too (`partition create` output). Bench item 8 covers it.]
- A **RAM installer UF2** carrying the firmware as payload does not fit (600 KB > 520 KB) without compression and a
  decompressor. Rejected.

## 4. Does a drag-and-drop keep the top-of-flash records?

**Yes, apart from the A2 abs-block caveat. The ROM erases only the 4 KB sectors that the UF2 writes into.**
- [DS 5.5.2] "The flash is always erased a 4 kB sector at a time, so including data for only a subset of the 256-byte pages
  within a sector … will leave the remaining 256-byte pages of the sector erased but undefined." Sectors with no block are
  not touched.
- [ROM `_write_uf2_page`] Per block it computes `sector_num` and erases that sector only the first time
  (`erased_sectors` bitset). No other erase happens.
- The recommended install UF2 writes sectors 0x0000, 0x1000, 0x8000–0x9AFFF and 0x408000 [MEASURED-offline prototype,
  §6]. **Token (−1), config (−2), fw_state (−3), display (−4) and drive_store (−5) at the top of 16 MB are untouched.** A
  user who re-drags keeps Wi-Fi, pairing, layout and drives.
- **Exception:** dropping a UF2 that carries the E10 abs-block (today's `wifi_floppy.uf2`) on an **A2** chip erases sector
  −1, the token. On A3/A4 it is ignored.

Consequences on a re-install:
- `fw_state` keeps `installed_sequence`. Dragging an *older* version than the board last bought leaves the anti-rollback
  floor high. The server still offers newer releases (sequence > installed), so this is harmless.
- A stale `pending` from an interrupted OTA survives too. `fw_boot_reconcile` should already treat "pending, but booted
  image is not a trial" as reverted/failed. Check this in review; I did not trace it here.
- First install on a new board: if the board shipped with other firmware (Pimoroni may ship MicroPython, whose
  filesystem lives in high flash [ASSUMED]), the top sectors can hold foreign bytes. Our records carry a magic and a CRC
  (`fw_state.c` "FWS1" + CRC32; `config_store.c`/`token_store.c` magic word) [REPO], so foreign bytes read as "empty".
  This is worth one bench run (item 7).

## 5. Prior art

- **pico-examples `pico_w/wifi/ota_update`** (the official A/B OTA example on Pico 2 W) still documents a multi-step
  install: drag `pt.uf2` (or `picotool load pt.uf2; picotool reboot -u`), then the Wi-Fi firmware UF2, then
  `picotool load -x` the app, or "dragging and dropping them in order". It does not solve one-file install.
- **SDK `pico_use_wifi_firmware_partition`** [SDK `pico_cyw43_driver/CMakeLists.txt`]: "You will need to flash your chosen
  version to each new device once, after loading the partition table … `picotool load TARGET.uf2; picotool reboot -u;
  picotool load -ux TARGET_wifi_firmware.uf2`". Also multi-step. Notably, the SDK builds **both a regular and a TBYB
  variant** of that firmware for exactly this "first install vs update" split. That is the same split recommended here.
- **pico-examples `bootloaders/encrypted`**: an absolute-family UF2 at flash 0 with an embedded partition table, a
  one-file install for a *custom bootloader* design. We use the ROM as the bootloader, so we take only the absolute-family
  idea.
- **pico-examples `flash/partition_info`**: uses `pico_embed_pt_in_binary`, partition-table-in-image boot (§3).
- **picotool `uf2 convert`** has `--family`, `-o/--offset` and `--abs-block [loc]`, and cannot merge files. `seal` can add
  a hash/signature/version but **cannot clear TBYB** (TBYB is only *set*, in the encrypt path, `main.cpp` ~5505). So the
  non-TBYB image must be a second build of the same sources.
- I found no community recipe for a one-file PT+image install. Everything published uses picotool or several drops.
  [Local sources only; I did not search the web.]

## 6. Recommended design

### What the single UF2 contains

`wifi-floppy-install-<semver>.uf2`, all blocks family **absolute (0xe48bff57)**, one `numBlocks`, `blockNo` 0..N−1 in
address order, **no E10 abs-block**:

| Flash address | Content | Why |
|---|---|---|
| 0x10000000 (1 page) | the 256-byte partition table block from `picotool partition create partitions.json` (today's `wifi_floppy_pt.uf2` payload) | installs / re-asserts the A/B table in slot 0 |
| 0x10001000 (1 page, 0xFF) | erases sector 1 (PT slot 1) | no stale second table can outrank slot 0 [ASSUMED belt-and-braces; the slot-0 flash-update choice already erases slot 1 per DS 5.1.16 (1)] |
| 0x10008000 … | `wifi_floppy_install.bin`: the **same firmware, built without `PICO_CRT0_IMAGE_TYPE_TBYB`**, hashed | partition A |
| 0x10408000 (1 page, 0xFF) | erases B's first sector, which severs its block loop | on a re-install, an older/equal B can never outrank the new A; same effect as a buy's erase |

Addresses come from `partitions.json` (A `start: 32K`, B `start: 4128K`), never hard-coded.

**[MEASURED-offline]** A prototype built in the scratchpad from today's artifacts is 2,348 blocks / 1,202,176 bytes,
with the last image page at 0x1009a800. It is about the size of today's `wifi_floppy.uf2`.

### Why non-TBYB is correct, not a shortcut

A bought image is a non-TBYB image: the ROM's buy clears the TBYB flag [DS 5.1.17]. A board after a drag-install is
therefore in exactly the state it is in after any successful OTA: one non-TBYB image in one slot, the other slot empty or
invalid. Every later step is the existing, bench-proven path.
- First OTA: a TBYB image goes to B. FLASH_UPDATE window = B → trial → proven → early buy (before PSRAM) → A's first sector
  is erased.
- A failed trial reverts to A: "a non TBYB image will always be chosen over a TBYB image … during a normal
  non-FLASH_UPDATE boot".

The ROM tie-break is [ROM `s_varm_crit_choose_by_tbyb_flash_update_boot_and_version`]. Our images carry no IMAGE_DEF
version (no `PICO_CRT0_VERSION_*` [REPO/SDK]). When two non-TBYB images are both valid, a tie keeps partition A (X): the
ROM verifies X and uses it unless Y is greater. The B-erase page makes even that moot on re-install.

`fw_rom.c` already handles a non-trial boot (`g_trial` false → `EARLY_NO_MARK`, `g_partition` 0 → OTA target is
partition 1) [REPO]. **No firmware code change is needed.**

### Build steps (CMake / tools)

1. Factor the firmware's sources/links into something two executables can share: an `INTERFACE` library or a
   helper function, since the SDK's crt0 is compiled per executable.
2. Add `add_executable(wifi_floppy_install …)`, identical except it does **not** set `PICO_CRT0_IMAGE_TYPE_TBYB=1`.
   - Keep `PICO_RUNTIME_SKIP_INIT_PSRAM=1` and every other definition.
   - Add `pico_hash_binary(wifi_floppy_install)`.
   - Turn off its default UF2 (or ignore it), so nobody ships an arm-s non-TBYB UF2 that would land in a slot as a
     non-trial.
3. Add a host-side tool, `wifi-floppy/firmware/tools/make_install_uf2.py` (~40 lines, unit-testable in the existing
   tools tests), with inputs `partitions.json`, `wifi_floppy_pt.uf2` (or the PT bin) and `wifi_floppy_install.bin`. It
   emits the table above. Keep it in a script rather than `picotool uf2 convert` of a padded bin: padding out to B's start
   would mean ~16k blocks of 0xFF. Have it assert:
   - single family;
   - addresses 256-aligned and inside partitions/sectors as expected;
   - no page in the top 5 record sectors;
   - image length ≤ partition size.
4. Add a custom target `wifi_floppy_install_uf2 ALL` that depends on `wifi_floppy_pt` and `wifi_floppy_install`.
5. Release workflow (commit 573342e publishes fw-<semver>): attach `wifi-floppy-install-<semver>.uf2` as **the**
   user-facing asset.
   - `refuseReleaseImage` already refuses a non-TBYB `.bin` for OTA, so the install image cannot leak into the OTA
     channel [REPO HANDOFF]. Add a test that proves it.
6. README quickstart: hold BOOTSEL, plug in, drag `wifi-floppy-install-x.y.z.uf2`, then pair. Keep
   `scripts/firmware-install-partitioned.sh` for the bench, but point it at the same single UF2 (`picotool load` of an
   absolute UF2 + `picotool reboot`) so both paths exercise one artifact.

### First-boot sequence (user's view)

1. The drop completes. The ROM reboots in 500 ms with FLASH_UPDATE, window 0x10000000.
2. The ROM finds the table in slot 0 (chosen; slot 1 erased) and scans A/B.
3. A holds a valid non-TBYB IMAGE_DEF and B is invalid, so A boots normally. No trial and no 16.7 s TBYB watchdog.
4. `fw_rom_boot_early`: not a trial, no mark → nothing to buy → PSRAM up → normal start → AP/portal → pairing.
5. If the user unplugs during setup, the next power-on boots A again. Today's TBYB install would land in BOOTSEL (§1).

### Coexistence with OTA, TBYB and fw_state

- OTA unchanged: TBYB images, signed manifests, header-last slot writer, prove → FLASH_UPDATE → early buy.
- fw_state: a blank or foreign sector reads as zeroed (`installed_sequence` 0 = "hand-flashed / first install"), as with
  today's picotool install.
- Drag-upgrading a partitioned board with the regular `wifi_floppy.uf2` also works (trial in the other slot, §1). Users
  should still be told to use the install UF2 for every USB install, because it works in all three states: blank board,
  foreign firmware, already ours.

## 7. Bench plan (operator; picotool used only for safety and inspection)

Prep (no hardware): build, then dump the UF2 headers. Expect:
- one family 0xe48bff57;
- pages at 0x10000000, 0x10001000, 0x10008000.., 0x10408000;
- nothing ≥ 0x10FFB000;
- `picotool info -a` on `wifi_floppy_install.bin` showing no `tbyb` line and `hash: verified`.

| # | Step | Pass if |
|---|---|---|
| 0 | `picotool reboot -f -u`; `picotool info -d` | note chip revision **A2/A3/A4** (decides the E10 question) |
| 1 | **Full backup**: `picotool save -a ~/.webadf/board-backups/<date>-before-dragdrop.bin`, `chmod 600`, sha256 (same as the install script) | file is 16 MB; hash recorded |
| 2 | Also save the top 20 KB alone: `picotool save -r 0x10FFB000 0x11000000 top.bin` | for the step 6 comparison |
| 3 | **Blank-board install**: `picotool erase -a` (wipes token/config; the backup restores them), unplug, hold BOOTSEL, plug, **drag the install UF2 in Finder** | board reboots by itself; serial shows `boot: partition 0 type …` with no `TRIAL`; `picotool info -a` (after `reboot -f -u`) shows the PT, A = image, no `tbyb`, B empty |
| 4 | Power-cycle before pairing | boots our firmware again, not BOOTSEL (today's design fails this) |
| 5 | Pair; OTA N → N+1 (into B), then N+1 → N+2 (into A) | trial → proven → buy in both directions, as in HANDOFF acceptance 2/3 |
| 6 | **Re-install over a board running from B** (after one OTA): drag the install UF2 | boots A, not trial; still paired and on Wi-Fi; a fresh `save -r` of the top 20 KB equals step 2 except fw_state if an OTA ran in between (compare token/config sectors) |
| 7 | **Foreign firmware first**: drag a MicroPython RP2350 UF2, write a file from its REPL, then drag the install UF2 | our firmware boots; records read as empty (fresh pairing), no crash |
| 8 | **Interrupted drop**: unplug at ~50 % of the copy | next BOOTSEL plug shows the drive; re-drag completes and boots |
| 9 | (optional) Drag the regular `wifi_floppy.uf2` onto a partitioned board | it goes to the non-booting slot as a trial and buys after proof |
| R | **Restore**: `picotool load --ignore-partitions -v <backup>.bin -t bin -o 0x10000000` (it is a `.bin`, so the offset is needed; in picotool 2.3.0 `-t`/`-o` go after the file name), `picotool verify`, `picotool reboot` | board back to its pre-test token/config/slots |

Steps 3 and 7 need the operator's hands (BOOTSEL, Finder). Run them as end-of-turn manual steps.

## 8. Verified vs assumed

Verified, from documents, source or offline measurement:
- The post-UF2 reboot is FLASH_UPDATE with the window at the target partition's start; for absolute, 0x10000000.
- A TBYB image outside the window is refused at launch.
- Mixed families in one UF2 do not work.
- Absolute UF2s cross partitions when the table's unpartitioned flags accept absolute (ours do).
- The ROM erases only the sectors it writes.
- An embedded table is RAM-only and requires the image at flash 0.
- Today's `wifi_floppy.uf2` carries an E10 abs-block on the token sector.
- The firmware `.bin` is 600 KB, larger than SRAM.
- `fw_rom.c` needs no change for a non-TBYB boot.
- The prototype UF2 layout and size.

Assumed, to settle on the bench or in review:
- The behaviour on A2 silicon, and the operator board's stepping.
- That the ROM build on the operator's chip matches public source c6cdb17. A3/A4 ROMs are what that source describes.
- That a partially written table or image is treated as absent (hash).
- How Finder/OS write order affects the B-erase page (harmless either way).
- What Pimoroni ships in flash.
- `fw_boot_reconcile`'s handling of a stale `pending` after a re-install.
- That the install image's first boot needs no other first-run code: no picotool step does anything else today, so I
  expect none.

Open questions for the operator:
- (1) The chip stepping (step 0).
- (2) Should the release still publish the bare `wifi_floppy.uf2`? Recommend not as a user download: it is the OTA image,
  and on A2 it erases the token.
- (3) Accept a second compile of the firmware in CI (~doubles firmware build time) for the non-TBYB variant?
