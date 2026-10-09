# SDD ledger — plan: docs/superpowers/plans/2026-10-08-df1-second-drive.md
Spec: docs/superpowers/research/2026-10-08-df1-second-drive.md (+ operator rulings in its header). Worktree: .claude/worktrees/df1, branch feat/df1-second-drive, base 829cedd.

## Pre-flight scan
| Tasks | Shared file / interface | Finding |
|---|---|---|
| 1→2 | bus_step_t.sel_mask, bus_df1_seen | consistent |
| 2→15→18 | device_client status tails, DC_STATUS_BODY_BYTES | 2 adds 34 B (29 left), 15 raises to 1408 before 18 adds 46: order consistent |
| 2→10 | main.c step_pulse DF1 telemetry branch | 10 says keep it: consistent |
| 3→20 | second-drive.ts, DeviceListItem, recordStatus | 20 appends; consistent |
| 3→21 | SecondDriveReadings above setting | consistent |
| 6→8 | drive_id program shared; ID in Y not instr_mem | consistent (8 adds the run.sh grep) |
| 6→9→16 | flux_out SMs on pio0; flux_in/sniff to pio2 | depends on D1 (Task 5) |
| 8→10→16 | bus_out_set_drive, n_drives, dskchg_*_d | consistent |
| 12→16→19 | drive_store, drive_boot_mode, g_drive_boot_ack | 16 USES g_drive_boot_ack, 19 declares it → RULING R4 |
| 13→14→15→16 | psram_df1_*, track_cache_get_token, dc_df1_reconcile | consistent |
| 18→19 | dc_drive_take / handled, drive_ack seed | consistent |
| 21→22 | HelpTip topic="second-drive" | 21 consumes 22's topic id (HelpTopicId type) → tsc fails in 21 → RULING R3 |
| 4,11,17,24 | FIRMWARE_SEMVER, HANDOFF section | 1.7.5 and HANDOFF 3bb already used by the NFC hotfix → RULINGS R1, R2 |
| each task 1-24 | self-consistency of tests vs code | checked; no task's tests contradict its own code text. Task 15/18 tests lean on helpers "write if missing" (allowed by plan). |

Ruling R1: versions shift for the 1.7.5 NFC hotfix — Phase 0 ships 1.7.6, Phase 1 ships 1.7.7, Phase 2 1.8.0, Phase 3 1.9.0 (unchanged). Comments "firmware before 1.7.5" become "before 1.7.6". — the plan's own hotfix clause — cost if wrong: cosmetic strings.
Ruling R2: the plan's "HANDOFF 3bb" is "HANDOFF 3bc" (3bb = NFC duty cycle). — avoids clobbering — cost: none.
Ruling R3: run Task 22 (help topic) BEFORE Task 21 (card setting), since 21 renders HelpTip topic="second-drive". — tsc would fail otherwise — cost if wrong: none (22 has no dependency on 21; its source comment names the component file, which exists after 21 — fine).
Ruling R4: Task 16 declares `g_drive_boot_ack` (volatile u32) itself; Task 19 must not redeclare. — Task 16 writes it first — cost: a compile error caught at once.
Ruling R5: Phase 2 bench step 8 (two real 2-disk games) is deferred — operator 2026-10-08: tests on Workbench only until multi-drive games are found. Kickstart 1.3 line stays out of help. — cost: none.
Ruling R6: input for Task 5 — on fw 1.7.4/1.7.5 today (2026-10-08) the boot log read `pio claims: pio0=7 pio1=3 pio2=1`. These look like SM BIT MASKS (pio0 3 SMs, pio1 2, pio2 1 = 6 SMs, no radio counted), not counts. Task 5 must interpret the line from the code that prints it before applying its "pio2 must show exactly two SMs" stop rule; if the radio is not on pio2 the plan's D1 stop applies and goes to the operator.
Stops expected (not stalls): Task 4 step 3, Task 11 step 3, Task 17 step 3, Task 24 step 3 are operator bench steps (end turn, one physical step per turn); Task 5 needs Phase 0 bench numbers.

## Progress
Task 1: complete (commits 829cedd..091d5cb, review clean; ⚠️ counting rule is Task 2's — carried)
Task 1: minor (deferred): floppy.pio:55-57 step_dir header describes only SEL0; mention SEL1 is in the same word
Task 2: complete (commits 091d5cb..128a69b, review clean)
Task 2: minor (deferred): each power-event burst can add 1 to g_df1_steps (filter passes the first edge); 3 bursts with SEL1 low while the board stays powered (USB on the bench) would latch df1Seen falsely. Board powered from the Amiga resets the count at power-on. FINAL REVIEW: triage; bench-check in Phase 0.
Task 2: deviations accepted: dc_set_sel1 called every core1 pass (values change at runtime); sel1 log prints once on first pass.
Task 3: complete (commits 128a69b..bf2cf50, review clean). Migration 0031 applied to the live DB.
Task 3: minor (deferred): a malformed sel1Wired/df1Seen in a report with firmwareVersion nulls the stored reading (playsHd trade-off)
Task 3: minor (deferred): no unit test for recordStatus null-clearing branch / SecondDriveReadings rendering
Task 3: minor (deferred): SecondDriveReadings hides both if either is null (partial report)
Task 4: steps 1-2 done by the controller (release mechanics, no new code): bump 1.7.6, run.sh, build, merge to master, publish, target board.
Task 4: steps 1-2 done (master 4961c74, fw 1.7.6+gfeb9538 seq 45 on board, readings false/false pre-Amiga-reset). Step 3 bench: WAITING ON OPERATOR (step 1 asked).
Task 4: bench step 1 FAILED 2026-10-08 ~21:00: A500 cold boot to WB on DF0; serial shows no SEL1 edge (only boot 'sel1: wired no'); card 'no signal yet'. GP3 init + IRQ code verified. Likely: A500 internal connector pin 12 does not carry SEL1 (the 2026-09-15 68-edge capture was rev A2 with no pull-ups = floating/crosstalk). STOPPED: plan's stop rule; operator asked for continuity check pin 12 <-> DB23 pin 21 and a choice of option.
HOLD (operator 2026-10-08): DF1 paused until the operator fits a flying lead in the A500: DB23 pin 21 (SEL1B) -> internal floppy connector pin 12 on the motherboard. Resume = re-run Phase 0 bench step 1 (expect 'DF1 line: connected'), then steps 2-3, then Task 5.
CORRECTION (2026-10-08 ~21:20): HOLD LIFTED. The operator's A500 rev 6 schematic (docs/schematic/A500_R6.pdf p8) shows CN11 pin 12 = _SEL1 (pin 14 _SEL2 unconnected). The bench step did NOT fail on the board: g_sel1_wired went true; the server showed false because a SEL1 change never made a status report owed, and the serial log dropped 2,736 records over the boot. A forced status report (display re-save v16) delivered sel1Wired=true, df1Seen=false. Phase 0 bench step 1: PASS.
Task 2: fix round 1/5 OPENED — finding: a change in the SEL1 readings does not make a status report owed (bench-found). Resumed implementer.
Ruling R7: the Task 2 fix ships as 1.7.7 (Phase 0 fix), Phase 1 becomes 1.7.8. — keeps the bench honest — cost: a version number.
Phase 0 bench step 2 (from the same boot's serial, 1.7.6): `pio claims: pio0=7 pio1=3 pio2=1`; `heap: free low-water 36864 bytes` (last printed, 15 s after boot; NOTE the log dropped 2,736 records later, so a lower value could be unseen -- re-read once with less log traffic before D2 is final). D2 provisional: 36864 - 14336 = 22528 >= 20480 -> DD-only.
Task 2: fix round 1/5 (1 addressed, 0 open — status owed on SEL1 change; commits feb9538..0f5eca9)
Task 4: complete. 1.7.7+g2c23c3a (seq 46) on the board. Bench step 1 PASS on 1.7.7 (21:25:17: sel1Wired true, df1Seen false, reported unprompted). Bench step 2: pio claims line `pio0=7 pio1=3 pio2=1` (1.7.6 boot); heap low-water 36864 (seen on 1.7.0, 1.7.5, 1.7.6 boots; serial drops records, value appears 4 KB-quantized = a floor). Step 3 (external drive) optional, deferred.
Ruling R8: Task 5 records its results in the plan's Decision ledger + a findings file in the workspace; the controller copies them to HANDOFF on master (HANDOFF is edited on master during this plan; avoids merge conflicts). — cost: none.
Task 5: decisions D1 = flux_in + sniffer to pio2 (radio is on pio2, claimed after the `pio claims:` print; after Phase 1 pio2 = 3 SMs 17/32, sniff build 4 SMs 30/32); D2 = DD-only (36864 floor - 14336 = 22528 >= 20480, margin 2 KB); D4 = sniffer on pio2 IRQ1, not exclusive. Commit 7ee8b97 (plan ledger only).
Ruling R9 (Task 5 concern 1): Task 9 moves the `pio claims:` print to after net_radio_sta_enable() (so it shows the radio), corrects the expected bench values accordingly, and fixes the wrong comment at main.c:1359. — the bench must read what is true — cost: one log line moves.
Ruling R10 (concern 2): Task 9 also logs which PIO the radio landed on after Wi-Fi start and WF_WARNs if it is not pio2. — a silent fallback would break the layout unseen — cost: one log line.
Ruling R11 (concern 3): Phase 2 bench (Task 17) adds a heap low-water check after an HD mount and after an OTA with DF1 on; if it reads below 20480 stop. — the 2 KB margin was measured on a light workload only — cost: one bench step.
Task 5: complete (commits 57bf882..7ee8b97, review clean)
Task 6: transitional (accepted): WF_BUS_SNIFF builds overflow pio1 (34/32) until Task 9 moves the sniffer to pio2 — do not flash a sniff build from this branch before Task 9.
Task 6: complete (commits 7ee8b97..80c9297, review clean; 4 named risks verified)
Task 7: complete (commits 80c9297..223d9b9, review clean)
Task 7: minor (deferred): test_board.c new check uses `board_check(..) || strstr(..)`; should be a plain CHECK(board_check(..)) on the valid GP14-17 config
Ruling R12 (Task 8 NEEDS_CONTEXT): Option B — write each SM's Y without touching OSR: DD/NONE = one exec'd mov y,~null / mov y,null; HD built in the unused ISR (in-shift config line in drive_id_program_init) then one atomic mov y,isr; no PC guard, no deferral, no bus_out_drive_id_poll. — preserves today's ID-change timing and keeps an_id_change_waits_for_the_next_answer unchanged; plan's deferral was a spec-less safety mechanism with a timing change — cost if wrong: an exec'd sequence interleaving badly with a stalled WAIT; the implementer must cite the datasheet's exec-while-stalled behaviour and pin the sequence in the model.
Task 8: complete (commits 223d9b9..e97b266, review clean)
Task 8: minor (deferred) M1: the 67-exec HD Y-load burst can delay/shorten a drive_id answer in flight (only if an HD mount overlaps an Amiga ID read, e.g. web mount during reboot). ADDED to Phase 1 bench: mount an HD disk from the web while the Amiga reboots; expect HD identified.
Task 8: minor (deferred) M2: drive_id.h top comment still says "Only SEL0 is looked at".
Task 8: minor (deferred) M3: bus_out_drive_id_init(…, 0) would still hand RDY to pio0 undriven (unreachable in Phase 1).
Task 9: complete (commits e97b266..2419637, review clean; R9+R10 implemented, main.c:1369-1392)
Task 9: minor (deferred): build-sniff/ is not in .gitignore (only build/)
Task 10: complete (commits 2419637..bc61f7d, review clean; controller verified device build + run.sh)
Task 11: 1.7.8+g1dfbab3 (seq 47, TEST build) installed 2026-10-09 ~06:40 after a stalled first attempt (downloads failed transiently, board backed off; fresh offer after a board power-cycle went through). Bench step 1 PASS: pio claims pio0=3 pio1=3 pio2=7, radio on pio2 (3 -> 7).
Task 11: bench PASS on 1.7.8 (2026-10-09): 1 pio claims pio0=3 pio1=3 pio2=7, radio on pio2; 2 WB 3.1 Workbench boots DF0, info DF0 only; 3 HDBench HD ID: info 1759 KB, boots; 4 Echo >DF0:p1check -> history seq 2, p1check in image. Step 5 (real external DF1) OWED (operator later); step 6 (sniff) skipped. M1 (HD/DD swap during an ID read) not bench-testable on demand: stays a recorded minor.
Task 11: complete. Phase 1 merged to master.
Ruling R13 (Task 12): the WF_DF1_DEFAULT release guard is an image marker 'wf-df1-default-on' scanned by refuseReleaseImage (the script never reads CMakeCache; WF_FW_DEBUG uses the same image-scan pattern). Task 16 MUST verify with strings on a -DWF_DF1_DEFAULT=ON .bin that the marker survives linking, and that a default build lacks it. — follows the real code — cost if wrong: a DF1-default build could be published as a release.
Task 12: complete (commits f68a6a8..91bb786, review clean)
Task 13: complete (commits 91bb786..bc32d76, review clean)
Ruling R14 (Task 14 review Important "a DF1 fetch can overwrite the buffer DF0's DMA streams"): finding conflicts with plan/spec §4 (DF1 shares track_cache's two buffers) and its premise is false — core0 never DMAs from a cache buffer: start_streaming (main.c:490-515) repacks the returned bytes into track_words (DF1: track_words1) synchronously and the DMA reads that copy. Code stands; CALLER RULE carried into Task 16's dispatch: a track_cache_get_token pointer must be consumed (start_streaming) before the next track_cache_get* call on either drive; never held across one. Task 16 also adds this rule as a comment on track_cache_get_token in track_cache.h. — cost if wrong: torn revolutions on DF0/DF1 (bench would show read errors).
Task 14: complete (commits bc32d76..ec3c492, review: spec ✅, 1 Important ruled R14)
Ruling R15 (Task 15 concerns 3+4, carried to Task 16): main.c installs dc_set_df1_quiesce in EVERY DF1-capable build (with WF_DRIVE_ID), before the first dc_step; and when a fetch/preload is deferred for DF1 quiescence, core1's loop paces itself 1 s (same pattern as the existing "display fetch failing" sleep_ms(1000) after a poll) so a core0 that never acks cannot make the board hammer the server. Quiesce wait itself stays ~50 ms. — cost if wrong: a stuck DF1 ack blocks slot writes (logged WARN) instead of a hot loop.
Task 15: complete (commits ec3c492..be84021, review clean; deviations 1+2 accepted)
Task 15: minor (deferred): deviation-2 drop does not set preload.changed -> server shows stale "ready" until a later report (fix: set changed when dropping a slot record)
Task 15: minor (deferred): dc_df1_release logs WARN on every pass while core0 is stuck (log first deferral only)
Task 15: minor (deferred): fake_push_image_response ignores its sha arg; test_status_body_fits_at_maximum prints to stdout; redundant reconcile in next_disk test
Task 16: pre-review fix (controller finding from concerns 1+2): DF1 gate+ID SMs disabled while OFF -> d414ea5
Task 16: complete (commits be84021..d414ea5, review clean; 5 minors)
Task 16: minor -> Task 19: live OFF while both selects low leaves RDY at DF1's level until SEL0 rises; enable-while-SEL1-low writes pads at once (comment wrong). Carry both into Task 19's dispatch.
Task 16: minor (deferred): dual-select host test exercises only the model's disable flag, not bus_out_drive_enable
Task 16: minor -> bench (ON): with DF1 on and both selects low, DF1's word replaces DF0's (not wire-OR)
Task 16: minor (deferred): bus_out_drive_enabled unused until Task 19
Ruling R16 (Task 17): publish ONLY the TEST build (WF_DF1_DEFAULT=ON, notes "TEST build: ...") before the Phase 2 bench; publish the 1.8.0 release (default OFF) only after the bench passes. — the registry is append-only; an unbenched DF1 release should not sit in it — cost: none.
Task 17: minor (deferred, pre-existing?): host suite intermittently fails (~1 in 8 runs; seen twice: Task 16 implementer + controller), most likely test_nfc_handoff's pthread test; 6 clean reruns. Investigate separately.
Task 17: 1.8.0+gc80afb8 TEST (seq 48) installed 08:50 (only after a board USB power-cycle + fresh offer; OTA-uptime bug). Bench step 1 PASS: info lists DF0 Workbench3.1 + DF1 Storage3.1 (879K, 42%, Read Only, 0 errs). Board log: df1 next disk at boot (compiled default); pio claims pio0=f pio1=f pio2=7; df1: inserted the next disk.
Task 17: bench step 2 PASS (dir df1: lists); step 3 PASS (copy df0:c and copy df1: concurrently, no errors).
Task 17: bench step 4 PASS (echo >df1:x -> write protected; Storage versions still 0).
Task 17: bench step 5 PASS (Next disk: swap from preloaded slot 1 at 651.425, DF1 ejected same instant, disk 3 preloaded into slot 0, df1 inserted 655.546 = 4.1 s; Amiga info: DF0 Storage3.1, DF1 Extras3.1). Note: operator copied c:info to RAM first (WB C: leaves with DF0).
Task 17: bench step 6 PASS (Ctrl-A-A with WB in DF0: info lists DF1 Storage3.1). Heap low-water on the DF1 TEST build: 20480 B (= R11 floor, 0 margin) -- decision for operator after bench.
Task 17: bench step 7 PASS (release 1.8.0+gba6de81 seq 49, installed after a board USB power-cycle + re-offer; df1 off at boot (compiled default); Amiga info: DF0 only). Step 8 deferred (R5). Heap low-water 20480 on BOTH TEST and release (the DF1 buffer is .bss) -- operator decision raised.
Task 17: complete. Phase 2 merged to master b36f27f. Release 1.8.0+gba6de81 seq 49 on the board.
Task 18: note: until Task 19 seeds drive_ack and calls dc_drive_take/handled, a new seq re-sets drive_owed every poll (and once the server wakes on driveAck mismatch, polls would return at once). Never shipped apart: Tasks 18+19 release together in 1.9.0. FINAL REVIEW: confirm.
Task 18: complete (commits 3914d3a..3d4eb3f, review clean)
Task 18: minor (deferred, Review Focus 4 adjacent): json_object fails open without blanking for an oversized secondDrive object (device_client.c:962); server bodies never exceed it
Task 18: minor (deferred): no malformed-seq test
Task 19: complete (commits 3d4eb3f..c3b4622, review clean; deviations 2,3,4 accepted; WF_DRIVE_ID=OFF build not built -> final review)
Task 20: complete (commits c3b4622..0fe4c5f, review clean, 5 minors in task-20-review.md -> final review). Migration 0032 applied (first without IF NOT EXISTS, re-run no-op).
Task 22: fix round 1/5 (1 addressed — HD caveat; commits aba677d..3a448db). Task 22: complete.
Task 21: fix round 1/5 (2 addressed — save errors surfaced, role=alert; commits 4c49bae..886d267). Task 21: complete.
Task 21: minor (deferred): a non-JSON 409 body shows 'Could not reach the server'; setStep not reset after a failed override
Task 23: complete (commits b0a90c3..91cda9a, review clean; e2e 32/32/22 passed)
Task 23: minor (deferred): override 'one click saves nothing' DB read races the click; failed-save 'nothing saved' check is vacuous (stubbed); aspect bound < 1 -> reviewer recommends < 0.97
FINAL REVIEW (1f343d5..91cda9a): fix first. C1 setting not persisted while DF0 holds a disk (lost at power-off; Off direction defeats safety); I1 re-pair keeps DF1 running while card says Off (mode not compared, status ignores reported mode); I2 1.8.x rollback with DF1 stored on: card hides it; minor Task 19 M1 covered by I1.
Ruling R17 (C1): persist the DF1 record when the drive is IDLE (the existing swap_gate idle predicate: motor off, no write activity for the settle period, no unsent writes), not only when DF0 is empty; keep the empty fast path. The ~45 ms core0 flash lockout is acceptable while idle (no steps; a new access waits for spin-up). New bench step in Task 24: change the setting with Workbench idle and a disk mounted -> serial 'df1: setting N stored' within seconds -> power-cycle -> new mode at Kickstart's first ID read. — cost if wrong: a missed step during a 45 ms window, visible as a read error on the bench.
Final fix wave: commits 91cda9a..43de15b (C1 7fbea67, I1 fe5edb1, I2 43de15b); agent stopped by operator error before its report; controller verified run.sh, both builds, vitest 1696, tsc.
FINAL fix wave re-review: C1, I1, I2, help claim ADDRESSED; no new Critical/Important.
Final: minor (deferred): a game holding the motor on all session delays the store until the drive light goes off; a change mid-game followed by a power-off is lost (help's "cold" claim omits it; R17 accepts).
Final: minor (deferred): m5 store record fields can be read half-updated (self-corrects next pass); m3, m4 open (see final-review.md).
