# Firmware update: the device half — design

**Date:** 2026-09-22
**Status:** design approved in conversation by the operator on 2026-09-22 ("this is fine…
you are free to start"). This written spec is awaiting their review.
**Increment:** 2b of the firmware-update work. 2a (the server half, HANDOFF §3aj) was merged
and deployed on 2026-09-22. This is what turns it from a protocol into a board that updates
itself.

Builds on `2026-09-22-firmware-update-server-design.md` (2a) and
`2026-09-22-firmware-release-registry-design.md` (increment 1). Where 2a's §4 and HANDOFF
§3aj disagree, **HANDOFF wins**. In particular, the wake is the `instructionVersion` /
`firmwareInstructionAck` cursor, not 2a §4.2's state check.

---

## 1. What this delivers

The operator selects a board in the Devices tab, presses Update and confirms with a password.
**The board then downloads the release, checks it, flashes it into its other slot, boots it
on trial and keeps it only once the new firmware has proven it can reach the server.** If it
can't, the board goes back to the firmware it was running, on its own.

A bad release, a truncated download, a tampered image, a power cut mid-flash and a hang on
first boot must each leave a board that still works. The worst case must stay "hold
BOOTSEL and re-flash over USB", which the RP2350's boot ROM guarantees because it cannot be
overwritten.

---

## 2. Measured on the bench, 2026-09-22

A throwaway probe was run on the operator's board (RP2350B, Pimoroni Pico Plus 2 W, 16 MB
flash, SDK 2.3.0, picotool 2.3.0) **before any of this was designed**. Each design decision
below cites the measurement it rests on. The probe code is not kept.

The probe used a partition table with **A at 0x8000–0x408000 and B at 0x408000–0x808000**
(4 MB each, B linked to A), with the rest of flash unpartitioned.

- **M1. The top of flash survives installing a partition table, and so does the pairing.**
  After the table was written and images loaded, the Wi-Fi config sector (magic `GCFW`) and
  the token sector (`TOK1`) at 16 MB − 8 KB were intact.
- **M2. An image linked at 0x10000000 runs unchanged from either slot.** `&main` read
  `0x1000xxxx` from both A and B. The boot ROM's address translation makes the booted
  partition appear at the start of flash. One build serves both slots.
- **M3. Reading the top of flash through `XIP_BASE` from a partitioned boot HARD-FAULTS.**
  Through `XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE` (0x1c000000) the same read works. Today
  `config_store.c` and `token_store.c` read through `XIP_BASE`, so the current firmware
  moved into a slot unchanged would crash on its first config read. This hung the board
  once during the probe, and only a watchdog made the next fault recoverable.
- **M4. A plain `picotool load` of an app UF2 goes to the NON-current slot.** With A empty,
  it went into B. `picotool load -p 0` targets A explicitly.
- **M5. A trial (TBYB) image boots only through a flash-update reboot, and does not survive
  an unconfirmed reboot.** After `rom_reboot(FLASH_UPDATE, base_of_B)`, boot info read
  `partition=1, type=0x04, tbyb=0x01` (buy pending). A plain reboot without buying went back
  to A, **even though the trial image had the higher version (2.0 vs 1.0)**.
- **M6. A trial image that hangs is reverted by the watchdog.** With the watchdog armed,
  the trial image hanging led to a watchdog reset, and the board came back on A.
- **M7. Once bought (`rom_explicit_buy`, rc=0), the new image stays** through both a normal
  reboot and a watchdog reset.
- **M8. The newly bought image wins even at an EQUAL version.** Buying erased the first
  sector of the other slot (read back all `FF` while the rest of that slot was intact), so
  the old image can never be picked again. The same happened in both directions (A→B and
  B→A). **So the image's own version does not have to carry the release sequence.**
- **M9. `rom_reboot` schedules the reset on the watchdog, so feeding the watchdog cancels
  the reboot.** The first attempt did not reboot because the probe's main loop kept calling
  `watchdog_update()`. After `rom_reboot` returns, the caller must stop feeding the watchdog
  and wait.
- **M10. `picotool` can reach BOOTSEL over USB without the button** (`reboot -f -u`) while
  the running firmware has USB stdio. It cannot once the firmware has faulted with USB still
  enumerated, as it did in M3. The watchdog is what keeps the board reachable.

Not measured, and therefore a bench acceptance item (§8): a power cut during the flash
write, and a real download over Wi-Fi of a real release.

---

## 3. Decisions

**D1. Use the RP2350 boot ROM's A/B and try-before-you-buy (TBYB); do not write a
bootloader.**
- **Partition table:** A = 32 KB + 4 MB and B = the next 4 MB, as in M1–M8. Flash above 8 MB
  + 32 KB is left unpartitioned, which includes the config, token and new firmware-state
  sectors (D5).
- **Size cap:** the firmware is 533 KB today. A release larger than 2 MB is refused at
  publish, which keeps well clear of the 4 MB slot and of the PSRAM budget in D3.
- **Release images are built with the TBYB flag set and a hash in the image** (SDK
  `PICO_CRT0_IMAGE_TYPE_TBYB=1`, `pico_hash_binary`). The boot ROM then rejects a corrupt
  image before running it, and never boots an unconfirmed one on an ordinary reboot (M5).
- **Why:** the ROM already does slot choice, trial boot and revert, and M5–M8 show it doing
  exactly what this design needs. A bootloader of our own would be a second, unmeasured
  thing that can brick the board.

**D2. Every read of flash outside the booted image goes through the no-translate window.**
- `config_store.c` and `token_store.c` move their reads from `XIP_BASE` to
  `XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE` (M3). Their writes already use physical offsets
  through `flash_range_*`, so those don't change.
- The plan must **audit every other `XIP_BASE +` in the firmware** and apply the same rule.
- This change is also safe on an unpartitioned board, where the two windows read the same
  bytes. So it can ship first, on its own.

**D3. Download into PSRAM and verify there; flash only verified bytes.**
- The release streams over the existing TLS client into a PSRAM staging area, hashing as it
  goes.
- Only once SHA-256 and the signature (D4) both pass does anything touch flash. An
  unverified byte never reaches a slot.
- **PSRAM budget:** 8 MB total. The disk image area is 2 × 160 × 13,312 B ≈ 4.26 MB, which
  leaves ~3.7 MB, and releases are capped at 2 MB (D1). The plan must confirm the staging
  area does not overlap anything else PSRAM holds.

**D4. The signature covers a manifest, not just the hash.** This closes the gap found on
2026-09-22: today's signature (`scripts/firmware-release.ts:108`) covers only the SHA-256,
so a compromised server could send an old, validly signed image under any `sequence` it
liked.
- **The signed message** is exact ASCII, no trailing newline:
  `webadf-fw-v1\n<version>\n<sequence>\n<sha256 hex>\n<sizeBytes>`.
- **Publishing:** the publish script decides the sequence before signing, then signs the
  manifest. A `signature_format` column on `firmware_releases` records which scheme a row
  uses: 1 = hash only (release 1, as published), 2 = manifest. It is added with a guarded
  `ALTER TABLE`, **not `db:push`**.
- **Poll body:** the server offers only format-2 releases to a board with `updateProtocol`
  ≥ 1. Release 1 is never a target anyway, because it is older than any 2b firmware.
- **Verifying on the board:** ed25519 checked against the public key compiled into the
  firmware, with the `keyId` checked too. The implementation is vendored **Monocypher**
  (`crypto_eddsa_check` and its SHA-512 only; BSD-2/CC0).
  - It is host-tested against the RFC 8032 vectors.
  - **It is also tested against a manifest signed by the real publish script**, a
    cross-implementation check. A verifier tested only against vectors it computed itself
    proves nothing.
- `/admin/firmware` stops saying "(unverified)" for format-2 rows once a board has verified
  one on hardware, not before.

**D5. Anti-rollback is the board's own rule, and it rests on signed data.**
- **Where it lives:** a new 4 KB **firmware-state sector** at 16 MB − 12 KB, unpartitioned,
  next to config and token. It holds `installed_sequence`, the `pending` release (version,
  sequence), and an attempt counter, in a magic-tagged record like the other two sectors.
- **The rule:** refuse any update whose signed `sequence` ≤ `installed_sequence`. A board
  with no record (hand-flashed, or the first USB install) has `installed_sequence = 0` and
  accepts any signed release. That matches 2a's server rule 6, "unrecognised build is the
  recovery path".
- **Why the board records the sequence rather than compiling it in:** the sequence is
  assigned at publish, after the build, so the firmware cannot know its own. The board writes
  it after a successful buy (D8).

**D6. Update only when the drive is idle, and let the board enforce it.** Download may start
at any time. **Flashing starts only when all of these hold:**
- no disk mounted
- motor off
- no write-back session open and no dirty tracks unsent

The board reports `queued` until then. This is 2a's D2 rule, enforced on the device, so it
holds even if the server is wrong. While flashing, a mount instruction waits. Flashing ~0.5
MB takes seconds, and the Amiga has no disk in this drive anyway.

**D7. Apply order: write so that a power cut never leaves a bootable half-image.**
1. Write the other slot, **the first sector last**. Until that sector is written the slot
   has no valid IMAGE_DEF, so a power cut mid-write leaves the old slot as the only bootable
   one.
2. Read the whole slot back through the no-translate window and compare its SHA-256 with
   the manifest.
3. Write `pending` to the firmware-state sector.
4. `rom_reboot(FLASH_UPDATE, base_of_slot)`, then **stop feeding the watchdog** (M9).

This is the item bench acceptance tests with a real power cut (§8).

**D8. The trial boot confirms itself only after proving it works.** On boot, if boot info
says a buy is pending:
- **Buy only after all of these:** Wi-Fi joined, TLS to webadf up, and a heartbeat answered
  2xx that reported this firmware's own version.
- **Version check:** before buying, check that version equals `pending.version`. A mismatch
  means the release was mislabelled at publish. Do not buy; reboot, which reverts (M5), and
  let the old firmware report `failed: version mismatch`. Without this check the server
  would wait forever for a version that never arrives, because completion is derived from
  the reported version (2a §3.2).
- **Deadline:** 5 minutes from boot. Missing it means a reboot, which reverts (M5). A hang
  is caught by the watchdog (M6).
- **After a successful buy:** set `installed_sequence = pending.sequence` and clear
  `pending`.
- **A trial boot with NO `pending` record** is a USB install (D11). It buys on the same
  connectivity proof, skips the version check because there is nothing to compare against,
  and leaves `installed_sequence` as it is (0 on a first install).
- **On a boot that is NOT a trial but finds `pending` set:** that is a revert. Report
  `failed: reverted (<reason>)`, where the reason is taken from the attempt record, then
  clear `pending`. A human decides whether to try again (2a §8: no automatic retry).

**D9. The protocol is 2a's, with nothing new invented on the board.**
- **Capability:** register and status carry `updateProtocol: 1`.
- **Instruction cursor:** the board echoes `firmwareInstructionAck = instructionVersion`
  after acting on every poll body that carries it, including one with no `update`, which is
  how a cancellation is acknowledged (HANDOFF §3aj).
- **Progress:** it reports `firmwareUpdateState` as `queued`, `downloading`, `applying` or
  `failed`, with `firmwareUpdateError` bounded at 200 characters.
- **Completion:** never reported by the board. The server derives it from the heartbeat's
  `firmwareVersion` (2a §3.2).
- **Download:** `GET /api/device/firmware/[version]` as 2a built it. A 503 is retried with
  backoff, and a 404 is `failed: not published`.

**D10. The build and publish pipeline makes the unsafe release impossible.**
- `pnpm firmware:build` produces the TBYB-flagged, hashed release image and a separate
  `pt.uf2` for first installs.
- **The publish script refuses** an image that `picotool info` does not report as TBYB and
  hashed, and anything over 2 MB. A release without TBYB would boot unconditionally on update
  and could never revert. That is the one packaging mistake that removes the whole safety
  net, so a machine checks it rather than a person.
- CI builds the same artifacts but still does not publish. The signing key stays offline
  (increment 1).

**D11. The first install is over USB, once per board, and keeps the pairing.**
1. `picotool reboot -f -u`
2. `picotool load pt.uf2`
3. `picotool reboot -u`
4. `picotool load -p 0 <release>.uf2`
5. `picotool reboot`

This is the sequence measured in M1/M4. It becomes `pnpm firmware:install-partitioned`, and
it **saves a full flash backup first** (`picotool save -a`), as the probe did. The board then
boots on trial and buys itself through D8 like any update, so the first install exercises
the same path.

---

## 4. Units, each testable on its own

| Unit | Does | Tested by |
|---|---|---|
| `fw_manifest` | builds the canonical manifest text; parses the poll body's `update` object | host tests |
| `fw_verify` | ed25519 over the manifest (Monocypher), keyId match | RFC 8032 vectors + a real publish-script signature |
| `fw_state` | the firmware-state sector record: read, write, magic, attempt counter | host tests, as `config_store` already is |
| `fw_stage` | streams the download into PSRAM with a running SHA-256 and a size cap | host tests with truncated and oversized streams |
| `fw_apply` | slot choice, first-sector-last write, readback hash, pending, reboot | host tests against a fake flash; bench |
| `fw_trial` | boot-time trial logic: buy conditions, deadline, revert detection and the failure report | host tests of the decision table; bench |
| `device_client` changes | `updateProtocol`, cursor echo, state reporting, idle gate | the existing host-test harness |
| publish script changes | manifest signing, `signature_format`, TBYB/hash/size refusal | vitest |
| server change | offer only format-2 releases to `updateProtocol` ≥ 1 | vitest + the existing e2e simulated device |

`main.c` only wires these together. The decisions live in units that the host tests can run.

---

## 5. Order of work

Each step leaves the board working.

1. **D2 alone:** the no-translate reads. Safe on today's unpartitioned layout. Flash it and
   check the board still pairs and heartbeats.
2. **D10 build side + D11:** a partitioned, TBYB image of the *current* firmware, installed
   over USB. The board runs from slot A and buys itself. Nothing downloads yet, and the
   board must behave exactly as before.
3. **D4 + D5 + the units**, all host-tested, plus the server and publish changes.
4. **D6–D9 wired in:** the first over-the-air update, on the bench.

---

## 6. What this cannot prove on the host

That the ROM behaves as M5–M8 say on every boot, that Wi-Fi downloads complete, and that a
power cut mid-write is survived. Each is a bench acceptance item, not a unit test.

---

## 7. Out of scope

- **Automatic updates.** Every update is still a human pressing Update (2a D5).
- **RP2350 secure boot and the OTP rollback version.** Both burn one-time-programmable
  fuses. That is irreversible, and on a bench board it is the one way to brick it for real.
  The ed25519 check in D4 gives the property we need without touching OTP.
- **Moving the CYW43 Wi-Fi firmware into its own partition.** The SDK supports it and it
  would shrink the image, but it is not needed at 533 KB.

---

## 8. Bench acceptance

Each item is run on the operator's board and read from both the serial log and the
`devices` row.

1. **USB install (D11):** the board comes up in slot A, buys itself, and keeps its pairing
   and Wi-Fi config.
2. **Real update N → N+1 from the Devices tab:** it goes queued → downloading → applying,
   reboots into B, buys, and the card reads up to date.
3. **Then N+1 → N+2,** which exercises the B → A direction.
4. **A deliberately broken release that never buys** (for example a build with no network):
   it reverts within the deadline, and the card reads `failed: reverted`.
5. **A tampered signature** is refused before any flash write, and the slot is untouched.
6. **A rollback target** is refused by the board even when the server is bypassed.

   The board only talks to production, so a forged poll body cannot come from the server
   without forging production traffic. Items 5 and 6 are driven through a **debug-build-only
   serial command** that hands a crafted `update` object to the same function the poll path
   calls. The release build must not contain that command, and the plan must include a check
   that it doesn't. The same functions are also covered by the host tests in §4.
7. **An update requested while a disk is mounted** waits in `queued` until the eject, then
   proceeds.
8. **A power cut during `applying`:** the board boots the old firmware and reports the
   failure.

---

## 9. Addenda from the bench (2026-09-23)

Everything below was measured after this spec was written and approved, during Task 4's
bench work (HANDOFF §3ak carries the full account, with log lines and DB rows). Each addendum
records what M1-M10 and D8 did not, and correspondingly the design change it forced. Nothing
above this line is rewritten; where the bench and the text above disagree, this section wins.

**M11. `rom_explicit_buy` hangs whenever PSRAM (QMI CS1) is configured, and the watchdog does
NOT rescue it.** Three real wedges on the operator's board (BENCH T4.8 and two more during
fix rounds 4-5) before this was isolated with a throwaway probe on the same board and
partition table:
- no PSRAM configured: buy returns rc=0 fine (probe V2H).
- PSRAM configured (`hardware_psram`, SDK runtime PSRAM init pre-main, size=8388608): buy
  WEDGES; an armed 4 s watchdog does not reset it (probe V2P).
- `PICO_RUNTIME_SKIP_INIT_PSRAM=1`, buy first (PSRAM reads size 0 at that point), THEN
  `runtime_init_setup_psram()` explicitly afterward: buy rc=0, PSRAM comes up right after
  (size=8388608), a normal reboot keeps the bought slot (probe V2L). **Root cause confirmed**:
  the boot ROM's explicit-buy path does not save/restore QMI M1 (PSRAM) around its flash
  operations the way `hardware_flash` does for ordinary flash ops; buying with PSRAM live
  corrupts that state and hangs.

  **This supersedes D8's in-place buy.** D8 said: on boot, if a buy is pending, prove
  connectivity and buy right there, in the trial boot, with PSRAM already up (the trial has
  already fetched a mounted disk into PSRAM by the time it proves itself). That is exactly the
  wedging condition. The design that replaces it (implemented in `fw_rom.c`, HANDOFF §3ak):
  the trial proves itself with a heartbeat naming its own version, marks itself "proven" in
  watchdog `scratch[0..1]` (magic + hash of `WF_FIRMWARE_VERSION`), and requests a
  `FLASH_UPDATE` reboot into its own slot. The NEXT boot calls the buy first, single-core,
  before core1 launches and before PSRAM is brought up at all (build sets
  `PICO_RUNTIME_SKIP_INIT_PSRAM=1`; `main()` calls `runtime_init_setup_psram()` explicitly
  right after the early buy). Post-buy bookkeeping runs afterward on the existing
  `fw_boot_reconcile` CONFIRMED_LATE path. One extra reboot per update; the buy never again
  runs with PSRAM live.

**M12. `picotool load -p 0 -x <uf2>` starts a TBYB image directly; a plain `picotool reboot`
after a separate `picotool load -p 0` does not — it leaves the board in BOOTSEL.** (BENCH
T4.8.) D11's install sequence needed correcting for this — `scripts/firmware-install-partitioned.sh`
now ends with the combined `load -p 0 -x` step, not a `load` followed by a bare `reboot`.

**M13. The watchdog DOES rescue a core1 `flash_safe_execute` lockout wedge, but does NOT
rescue a hang inside the ROM buy itself.** `fwdbg-wdtest` (WF_FW_DEBUG only) deliberately
wedges core1 inside `flash_safe_execute`; the board reset ~21 s later (one long poll plus the
8 s watchdog) and came back on the same bought image. This is the opposite of M11's hang,
which the same watchdog does not catch — confirming the fix has to keep the buy away from
PSRAM rather than lean on the watchdog to catch a PSRAM-induced hang.

**M14. The SDK's `rom_explicit_buy` already wraps itself in `flash_safe_execute`**
(`bootrom.h:974-987`). Do not nest another `flash_safe_execute` around a call to it — fix
round 3's bug was exactly this: a second wrapper around an already-wrapped call produced a
nested multicore lockout and deadlocked every buy, independent of M11's PSRAM finding. Call
`rom_explicit_buy` directly.

**The instruction-cursor sync rule** (device-side, carried into this branch from §3aj's fix
round 1, and re-confirmed on this bench): the first `instructionVersion` seen after `dc_init`
with no `update` attached is a CURSOR SYNC, not a cancellation — ack it (echo
`firmwareInstructionAck`) but never route it through `fwu_on_instruction`. This is what lets a
boot-time REVERTED failure (D8/M11's revert path) still reach the server: the boot's first
poll after a revert carries no `update`, and treating that as a cancel would silently wipe the
failure report before it was ever sent. Verified on the bench in acceptance item 4 (§8): the
"reverted: no heartbeat within 5 minutes" state survived the next cursor sync.
