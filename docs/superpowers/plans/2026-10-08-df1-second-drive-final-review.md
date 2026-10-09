# Final whole-branch review: DF1 second drive, Phase 3 (1f343d5..91cda9a)

Reviewer: Senior Code Reviewer (superpowers code-reviewer template), read-only. I did the review myself, in three
passes: (1) the web diff (migration, routes, lib, card, help, tests); (2) the firmware diff (device_client, main.c
handoff/apply/store, df1_live, bus_out comments, tests); (3) the end-to-end protocol across both, plus the ledger's
deferred minors. The drizzle snapshot JSON was not read line by line (see "Declined to judge").

Checks run, outside the worktree (nothing in the checkout was touched):
- Device build with `-DWF_DRIVE_ID=OFF` (the one-drive build Task 19's M5 says was never built), configured into the
  scratchpad: **builds clean, no warnings from project sources.**
- Host suite, on a copy of `wifi-floppy/firmware` in the scratchpad: test_device_client 781/0 failed, test_df1_live
  25/0 failed, test_drive_store 11/0 failed. The copy's test_adf_mfm and display-wasm failures come from repo-relative
  fixture paths missing from the copy, not from this branch.
- vitest, the six touched web test files: 70/70 passed.
- e2e: not run. Every e2e run shares the live production DB, so runs have to be serialised (memory rule). The ledger
  records 32/32/22 passing for Task 23.

---

### Strengths

- **The ack follows the apply, not the handoff** (main.c:2151-2196). core1 hands the setting to core0 on a
  seq cursor, waits up to 50 ms, and acks only if core0 published `applied == want`. If it times out, it does not
  ack, sleeps 1 s and lets the server re-send. A board that is slow to apply therefore costs a poll; it never
  produces a false "Set on the board", and it cannot hot-loop.
- **The poll is byte-identical for boards that send no `driveAck`.** In poll/route.ts:99-105, 147 and 218-220, both
  the wake and the body are gated on `driveAck !== null`. The wake compares the cursor with `!==`, so a re-paired
  board with a higher ack converges. Older firmware therefore cannot be woken into a loop, and a newer board talking
  to an older server only sees its extra query parameter and status keys ignored (zod strips unknown keys).
- **The `df1Seen` refusal is enforced inside one org-scoped conditional UPDATE** (second-drive.ts:27-42). The
  fallback re-read is org-scoped too, so a foreign device returns 404, the same as a missing one. OFF and an
  explicit override are the only things that skip the guard. The migration is additive, uses
  `IF NOT EXISTS`, and every new column has a default or is nullable.
- **The PARKED state is well reasoned** (df1_live.h). Disabling the machines live would release CHNG and show a
  running Amiga a phantom disk; parking avoids that. `dskchg_on_step_d` never clears CHNG without an image, so a
  parked drive stays empty under steps. The STEP ISR's serving mask follows the machines rather than the mode, so a
  parked DF1's head moves like a real empty drive's. The transitions are pure and host-tested.
- **Order of operations across the cores is right in both directions.** OFF: device_client first (the reconcile
  ejects), then core0 parks. ON: core0 first, then device_client publishes, and the rescan inserts a disk core0 had
  already acknowledged while it was off.
- **Budgets and stack:** the poll path (128 B) and the request buffer (352 B) are static and sized for the
  worst case, with a test for each. The status tail is test-checked at the maximal body. No new large stack frames.
- The help topic is source-annotated, and each caveat has a test.

---

### Issues

#### Critical (Must Fix)

**C1. In normal use the setting never survives a board power-cycle. Switching DF1 OFF is therefore not honoured at
the next cold boot, which is exactly when a user attaches a real DF1.**
- File: main.c:3557-3569 (store condition `!disk_mounted && psram_active_slot() == SLOT_NONE && !df1_mounted`),
  with main.c:3247-3290 (the apply that sets `drive_store_pending`) and device_client.c:1907-1911 (`dc_step` runs
  `dc_handle_poll_body` → `dc_fetch_image` synchronously, so the handoff happens only after the poll's disk is
  fetched and published).
- What is wrong: the flash record is written only while DF0 is empty. A board normally holds a disk, and Next disk
  or a web mount goes straight from one slot to another. At boot, the first poll's disk is fetched and published
  inside the same `dc_step`, before core1 hands the setting to core0, so `drive_store_pending` is set with DF0
  already mounted. `drive_store_pending` is a core0 local, so a power-off forgets it. The record is therefore written
  only if the user happens to eject DF0. The plan knows this: Task 24 bench step 5 says "eject DF0 for 10 s so it
  can be stored". The user is never told.
- Why it matters: the spec says the board is powered from the Amiga's floppy +5 V (§1, line 171), so every Amiga
  power-on is also a board boot.
  - **ON, set while a disk is mounted:** every cold boot answers with the old stored mode (OFF) at Kickstart's ID
    read. DF1 appears only after a warm reset that follows the board's first poll. The card meanwhile says "Set on
    the board — takes effect when the Amiga restarts", and the help says "cold or warm" (topics.tsx:280).
  - **OFF, set while a disk is mounted (the safety direction):** suppose the stored record was ON (stored once,
    e.g. per bench step 5). Every cold boot then answers as DF1 again. After the first poll the board parks, and
    parked still asserts CHNG and WPROT on SEL1 until a board boot with OFF stored, which never comes while DF0
    holds a disk.
    - A user who followed the help ("Use it only when no other drive is DF1"), switched OFF and plugged in a real
      external drive gets two drives answering on SEL1 at every cold boot. After that the real drive reads as
      empty and write-protected, across warm resets too. This is the outcome the refusal exists to prevent.
    - `df1Seen` cannot flag it: the board answers ON at boot, then parked, and steps count as telemetry only while
      the machines are disabled.
  - Task 24 bench step 6 ("set the board's DF1 Off first if needed", then power-cycle with the real drive) will hit
    this as written.
- How to fix (operator's choice; the first is recommended):
  1. Store the record while the Amiga is not reading, rather than while DF0 is empty: for example, both drives'
     motors off for at least 1 s, with no write-back or upload in flight, under the same 5 s retry. This needs a
     bench measurement that the ~45 ms `flash_safe_execute` lockout is harmless with a mounted but idle disk
     (index pulses, STEP and SEL edges held in the PIO FIFOs). The display record can keep its rule.
  2. At least for the OFF direction, which is the one that matters for safety, write the record at the next idle
     moment by the same motor-off rule, and make the card honest until then. That means a `driveStored` status
     field and a card line such as "Applied now; stored when the Amiga is idle".
  3. If neither is done, the help and the card must say that the setting survives an Amiga power-off only after
     DF0 has been ejected once. That makes the safety caveat the user's job, so it is the weakest option.
- Add a host or bench check: switch with a disk mounted, wait idle, power-cycle, and expect "(stored)" at boot.

#### Important (Should Fix)

**I1. A re-paired board keeps running DF1 in the old row's mode, and the card shows "Off — Set on the board".**
- Files: main.c:1858 (re-entry seeds `drive_ack = 0`); device_client.c:1050
  (`if (seq == c->drive_ack && !c->drive_owed) return;` compares the seq only); second-drive.ts:47-52
  (`secondDriveStatus` ignores `secondDriveReported`).
- What happens: the board has DF1 ON (`g_df1_mode == NEXT`) and hits DC_HALTED, then is re-paired without a
  reboot. The new device row is `off` at version 0, and the board seeds ack 0. The poll sends `{seq:0, mode:"off"}`,
  which equals the ack, so nothing is owed and the board stays ON. Its status reports `secondDrive:"df1",
  driveVersion:0`. The server sees applied 0 == version 0 and shows **Off** with "Set on the board".
- The same disagreement arises from:
  - a `WF_DF1_DEFAULT=ON` TEST build with nothing stored (boots NEXT at ack 0 against a row at off/0);
  - Task 19's M1 (a handoff interrupted by a re-pair).
- Why it matters: it breaks Review Focus 2, "the server must never show a state the board isn't in". The user
  believes DF1 is off.
- Fix, both sides:
  - Firmware: also owe the setting when the mode differs:
    `if (seq == c->drive_ack && !c->drive_owed && want_mode == c->_df1_mode) return;`, plus a host test. This also
    self-heals Task 19's M1. Alternatively, follow Ruling J for the display and hand core0 an OFF request on
    re-entry.
  - Server: `secondDriveStatus` should read "Waiting for the board" while `secondDriveReported !== secondDrive`, as
    well as while the versions differ.

**I2. After a downgrade or a trial revert to 1.8.x with ON stored, DF1 stays on, the card hides that it is on, and
the web cannot switch it off.**
- Files: second-drive.ts:39 (`eq(devices.secondDriveCapable, true)` is required even for `off`, Task 20 Minor 1);
  second-drive-setting.tsx (the DF1 line renders only when capable); base main.c (1.8.x reads `drive_store` at
  boot, git show 1f343d5:main.c:2723).
- What happens: 1.8.0/1.8.1 honour the stored record, but they send no `driveAck` and cannot receive a change.
  - The card shows only "Needs firmware 1.9.0 or newer" with the select disabled.
  - The board keeps serving DF1, and the server knows it from `df1Sha256`, which 1.8.x reports.
  - Its only way back is reinstalling 1.9.0.
- Why it matters: OTA trial revert is a real path in this project. A user cannot tell from the card that DF1 is
  answering, and the I-have-a-real-DF1 scenario applies again.
- Fix (cheap): when `!secondDriveCapable && df1Sha256 !== null`, show "DF1 is on (stored on the board); this
  firmware cannot change it — install 1.9.0 or newer". Add one help line about older firmware keeping the stored
  setting. Old firmware cannot be changed, so making it visible is the remedy.

#### Minor (Nice to Have)

- **m1.** second-drive-setting.tsx:30 and 62-75: any 409 opens the refusal box, including `firmware_too_old`, which
  happens when the card was capable at render and the board reported an older build since. The box then reads
  "Needs firmware 1.9.0 or newer. Switching DF1 on would make both drives unreadable." and offers "Switch on
  anyway…", which fails again. Route `firmware_too_old` to `setFailed` instead. Together with Task 21's deferred
  "setStep not reset after a failed override", this is one small UI fix.
- **m2.** second-drive-setting.tsx:51-56: the "DF1: …" line is keyed on the desired `secondDrive`, not on
  `secondDriveReported`. While the board is still applying either way, it shows "DF1: empty" for a drive that is
  not there, or hides one that is. Use the reported mode.
- **m3.** second-drive.ts:47-52: "Set on the board — takes effect when the Amiga restarts" stays up forever,
  including on a fresh board at Off/v0, long after any restart. Consider "Set on the board" once the board has
  reported since the change. The bench step 1 text depends on the current wording, so change both together.
- **m4.** PATCH bumps the version even when the mode is unchanged (second-drive.ts:37). The UI cannot send that,
  since a select fires only on change, but an API caller can, and a re-sent NEXT on a mounted DF1 is Task 19's M4
  spurious eject. Skip the bump when `mode` equals the stored value: put `ne(devices.secondDrive, mode)` in a CASE,
  or return the current version.
- **m5.** device_client.c:1050 and main.c:3249-3253: Task 19's M2 torn `{version, mode}` read stays transient. The
  store write in the same pass could persist a torn pair only if C1's fix makes writes frequent. If C1 is fixed with
  a motor-off store rule, re-read the seq after reading both values (a seqlock) before storing.

---

### Deferred minors from the ledger: triage

**Must fix before merge:**
- **Task 19 M1** (re-entry takes a stale `g_df1_mode`). It is the same disagreement as I1, and the mode-compare
  fix there covers it. Fix it with I1, not separately.

**Resolved by this review:**
- **Task 19 M5** (the WF_DRIVE_ID=OFF build was never built): built clean.
- **Task 18 note** (18 and 19 must ship together): both are in this range; confirmed.

**Can stay deferred** (none affects correctness of what ships, or the effect is self-healing or override-able):
- Task 1 (floppy.pio header comment).
- Task 2 (power bursts can latch `df1Seen` on a USB-powered bench). Now that `df1Seen` drives a refusal, the
  effect is a false refusal, and the override exists. Keep the bench check.
- Task 3 (×3).
- Task 7 (test_board check).
- Task 8 M1, M2, M3.
- Task 9 (build-sniff/ not in .gitignore).
- Task 15 (×3). The stale "ready" from deviation-2 now also feeds m2's "DF1: disk N" label, which is cosmetic.
- Task 16 (dual-select test; the bench item stands).
- Task 17 (flaky host test: investigate separately).
- Task 18 (oversized object not blanked; no malformed-seq test).
- Task 20 Minors 2-5.
- Task 20 Minor 1: fold it into I2 if I2 is fixed.
- Task 21 (fold the setStep reset into m1).
- Task 23 (the e2e checks that pass vacuously or race; aspect bound).

---

### Declined to judge

- **Whether a ~45 ms flash lockout is safe with a mounted but idle disk** (C1, fix 1). Only a bench measurement can
  show it; I recommend the measurement and do not assert the result.
- **Electrical outcome of two drives answering SEL1** (C1, I2). I rely on the app's own claim that "both drives
  [become] unreadable", not on a measurement.
- **Kickstart's ID read happening before the board's first poll at power-on.** This is the spec's claim (§1); C1's
  severity rests on it.
- **The heap low-water of 20480 B (0 margin, Phase 2).** It is an open operator decision, outside this range.
- **The drizzle snapshot JSON beyond the six columns.** The Task 20 reviewer diffed 0031→0032. I read the SQL and
  the schema, not the 3,400-line snapshot.
- **The e2e suite.** Not re-run: it uses the shared live DB and runs must be serialised. Task 23 reports a pass.
- **Task 24 (version bump to 1.9.0, publish, Phase 3 bench).** Not in this range. FIRMWARE_SEMVER still reads
  1.8.1, so the help and card text "1.9.0" depend on Task 24 bumping it.
- **The big-box (A2000/3000/4000) DF2 caveat in the help.** It comes from the spec, not from the bench; the help's
  source comment already says so.

---

### Recommendations

- Treat "applied" and "stored" as two separate states end to end: a board field, a server column and the card
  text. For a setting that acts at power-on, "stored" is the state that matters.
- Before Task 24's bench, add a step that switches OFF with DF0 mounted and never ejects, then power-cycles. It
  should pass only after C1 is fixed.

### Assessment

**Ready to merge? No — fix first.**

**Reasoning:** The protocol, cursor, guard and parked-state mechanics are sound and well tested. However, the store
rule makes the setting not survive an Amiga power cycle in normal use. In the OFF direction that defeats the
safety purpose of the setting, and it makes the help's "cold or warm" claim false (C1). A re-pair can also leave the
card showing a state the board is not in (I1).
