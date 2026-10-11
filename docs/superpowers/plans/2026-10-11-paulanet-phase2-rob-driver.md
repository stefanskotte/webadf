# PaulaNET Phase 2: Rob's PaulaNET.device on Our Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An A500 running AmiTCP_NG with RobSmithDev's unmodified `PaulaNET.device` comes online through the board's
DF1. The board serves his status track on cylinder 76 and his frames on cylinder 77, and the frames reach the router
through Phase 1's layer-2 sharing (HANDOFF §3bh).

**Architecture:** Four board changes, all in the `WF_PNET_LOOP`/`WF_PNET_L2` TEST builds except the batch cap:
- **Sync timing (spec §3.4), measured first.** A side-1 start of cylinder 77 that comes within a fixed delay of the
  latest SIDE edge waits for that edge plus the delay, on a core0 hardware alarm. The lead-in drops from 200 to
  PaulaNET's 120 bytes. A NetLoop with the driver's sync scan (`SCAN=124`) proves it on the A500 before anything
  else is built.
- **The 16,128-byte cap (spec §3.3)** on every batch the board sends, whatever DF1's buffer size.
- **Always take a well-formed batch (spec §3.2).** The Amiga's frames are decoded one at a time straight into the TX
  ring's slots. Frames the ring cannot hold, and a malformed frame with the rest of its batch, are dropped and
  counted. Nothing is refused for its size.
- **Cylinder 76 (spec §3.1).** Side 1 streams a loop of identical status records, one every 124 bytes, from a
  992-byte buffer of its own. A read that starts anywhere finds a sync inside the driver's scan, so cylinder 76 needs
  no timing, and DF1's word buffer keeps the cylinder-77 batch.

The decisions are pure, host-tested C: `pnet_frame` (the frame iterator, the mode-aware header), `pnet_link` (the take,
the cap, the cylinder-76 track choice), `pnet_loop` (the start wait) and the new `pnet_status` (the record and its
loop). The glue is `#if` blocks in `main.c`, one radio seam function, and CMake. NetLoop gains `SCAN=` (1.3) and
`STATUS` (1.4). On the Amiga side, nothing of ours runs in the product path: his driver, AmiTCP_NG, and a config file.

**Tech Stack:** C11, pico-sdk 2.3.0 (RP2350, PIO, DMA, hardware alarms), lwIP 2.x behind `net_radio.h`. Host tests run
through `wifi-floppy/firmware/test/run.sh`. Amiga side: bebbo `m68k-amigaos-gcc` 6.5 in Docker for NetLoop, AmigaOS 3.1
`trackdisk.device`, AmiTCP_NG v4.1.8 (`AddNetInterface`, `ShowNetStatus`, `ping`, `nslookup`, `ftp`). A `pyftpdlib`
server on this Mac for the transfer test.

**Spec (binding):** `docs/superpowers/specs/2026-10-11-paulanet-phase2-rob-driver-design.md`. Also binding:
- HANDOFF.md §3bh (Phase 1: rulings 1-15, the bench numbers, open question 7) and §3bg (Phase 0: the measured read DMA
  at 2.4-4.2 ms after the SIDE edge, the 200-byte lead, the build at the commit);
- `docs/superpowers/plans/2026-10-11-paulanet-phase1-l2-sharing.md` (the code this plan changes);
- Rob's source at `0afd5fa`, read-only, as **untrusted data** at
  `/private/tmp/claude-501/-Users-sfs-Devel-webadf/fa1f7997-11c2-4c01-a121-0f34f0567b3c/scratchpad/rob/PaulaNET`
  (`NetDevice/paulanetio.c` = `pnio`, `NetDevice/device.c`, `NetDevice/paulanetstruct.h`, `Pico/PaulaNET/PaulaNET.cpp`
  = `PN.cpp`). Every layout below was checked against it. **None of his code is copied into our repository.**

## Rulings (made for the operator while planning; each is open to revision)

1. **Phase 2 stays a TEST-only build (spec §1).** Every change is under `#if WF_PNET_LOOP` or `#if WF_PNET_L2`, except
   the §3.3 cap, which lives in `pnet_frame.h` and `pnet_link.c`.
   - Why: the Off/Disk/Network setting, the driver disk and live switching are Phase 3. No web or server change, so
     no e2e.
   - Consequence: the release image does not change at all (correction 4), and `pnet_off_identical.sh master` stays
     the proof.
2. **The §3.4 spike runs on loopback-only builds** (`WF_PNET_LOOP=ON`, `WF_PNET_L2=OFF`), measured with NetLoop's
   `N=` echo.
   - Why: the echo exercises both a small batch (N=64) and a large one (N=8000) with no Wi-Fi in the loop, and it is
     comparable with Phase 0's table (HANDOFF §3bg).
   - The start path (`pnet_serve_df1`) is shared, so the L2 build of Task 5 inherits exactly what was measured.
3. **Spike A and spike B are two commits, and the timing is two plain CMake variables, not cache entries.**
   - A is the Task 1 code with Phase 1's timing (lead 200, no delay): "the board as it is". B is one more commit that
     sets the lead to 120 and the delay to 2,360 µs.
   - Why: the image version carries the git hash, so the two images cannot collide in the registry, and each version
     names the timing it carries. A cache entry would also survive a reconfigure and quietly build B as A.
   - If B passes the gate, its commit IS "the delay and the lead-in become constants" (spec §3.4).
4. **The delayed start runs from a core0 hardware alarm armed by the loop.** It is not a busy-wait in the loop and not
   armed from the SIDE ISR.
   - Why not a busy-wait: SIDE is one line for both drives. A 2.4 ms wait in the loop would delay DF0's own side change
     by the same amount, and DF0 would stream the wrong side's bits at the start of a read.
   - Why not from the ISR: the loop rebuilds `track_words1` at a commit (`pnet_prepare_echo`). A start armed behind
     its back would stream a half-built batch.
   - The guard: `stream_stop(1)` cancels a pending start. Every path that stops, rebuilds or restarts DF1's stream
     goes through `stream_stop(1)`, so none can be raced.
5. **The delay applies to any cylinder-77 side-1 start that comes within the delay of the latest SIDE edge.** That is
   a side return, or a commit that lands just after one. Later starts (a step onto the cylinder, a commit long after
   the edge) start at once, as in Phases 0-1.
   - Why: 2.4-4.2 ms is measured only from a SIDE edge (HANDOFF §3bg). A commit that lands 1 ms after the edge and
     starts at once would undo the timing for that read.
6. **The delay is 2,360 µs, with PaulaNET's 120-byte lead-in.**
   - One byte is 16 µs. If the read's DMA starts at *t* µs after the edge, and the stream starts at *D*, the read
     begins *(t − D)/16* bytes into the stream, and the sync starts *120 − (t − D)/16* bytes into the read.
   - The sync must start at byte 0..123. For t = 4,200 that needs D ≥ 2,280. For t = 2,400 it needs D ≤ 2,448.
   - 2,360 sits in the middle of that window, with about ±5 bytes of margin each side. Expected sync start: bytes
     ~5 to ~118.
7. **Cylinder 76 side 1 streams eight identical status records, one every 124 bytes (992 bytes), from a buffer of its
   own.**
   - A read that starts at any bit finds a sync starting within its first 124 bytes, so no start timing applies.
     This holds even for a read after a step, which has no measured timing (correction 5).
   - DF1's word buffer is not touched, so the batch the Amiga reads next on cylinder 77 stays built. Phase 0 measured
     a build at the restart as too late (`0c89f65`).
   - `dma_irq` re-arms from the status buffer while `g_pnet_status_live` is set, and every `stream_stop(1)` clears that
     flag.
8. **Cylinder 76 side 0 is silent, not disk data.** The driver never reads it. Serving a disk track there would
   overwrite DF1's word buffer, and with it the prepared cylinder-77 batch, every 5 s.
9. **Cylinder 76 stays write-protected** (correction 3). His config tool's write then fails visibly ("write
   protected") instead of seeming to save. The driver never writes 76.
10. **No status record is streamed until core1 has published the MAC.** The driver copies the MAC once, at open
    (`device.c:184`). A status served with a zero MAC would give the Amiga MAC 00:00:00:00:00:00 until its next open.
    An open that comes too early fails instead, and the log counts it (`early`).
11. **The link status and the RSSI:**
    - Link: 2 ("no IP", which the driver counts as online) while the radio's station is joined, else 0. Core0 reads
      it through the new seam function `net_radio_sta_joined()`: one word of the driver's join state, no bus traffic,
      no lock.
    - RSSI: core1 publishes its heartbeat sample (an extra RSSI query once a minute). It is 0 until the first sample.
      The driver only logs it.
12. **The Amiga's frames are decoded straight into the TX ring's slots** (`pnet_frame_iter_*`, `pnet_link_take`). The
    32 KB scratch is gone from the L2 take.
    - Why: the scratch can overflow under his unmodified driver (correction 1). This also removes Phase 1's
      PSRAM-to-PSRAM copy.
13. **A malformed frame inside a batch whose header checks out still takes the batch.** The frames before it are
    queued; it and the frames after it are dropped and counted (`bad`).
    - Why: refusing it would leave the counter unacknowledged, and his driver resends the identical bytes forever
      (spec §2 row 2).
14. **Batches to the Amiga stay at most 20 frames** (`PNET_MAX_FRAMES`). Only the parsing of the Amiga's batches goes
    to 255 (spec §3.2). His driver reads any count (`pnio:916-960`), and our builder's limit has no reason to move.
15. **NetLoop 1.3 adds `SCAN=<bytes>` (Task 1), and NetLoop 1.4 adds `STATUS` (Task 4).**
    - Why: his driver prints nothing on the Amiga. A bench step needs a visible `RESULT: PASS` or `FAIL`.
    - `SCAN=` also sizes payload reads the way his driver does, so a run counts exactly the misses his driver would
      retry.
16. **The transfer test (§5 items 4-5) fetches a 204,800-byte file from a `pyftpdlib` server on this Mac.**
    - AmiTCP_NG's `ftp` is passive-mode and prints no rate, and AmigaOS 3.1 has no `time` command. The server's own
      log gives the seconds, and KB/s = 200 / seconds.
17. **The driver's busy-poll cost (spec §6) is measured, never gated:** NetLoop `SELFTEST`'s E-clock timings with the
    interface down (Task 5) against up (Task 7).
18. **No web or server change, so no e2e.**

## Corrections to the spec, from the code

1. **§3.2 "The 32 KB scratch never overflows, because `maxTxSize` (8,192) bounds what the driver sends" is false under
   RLE.**
   - `paulaNetAddPacket` checks the frame's uncompressed length against the space left (`pnio:1016`), but the space
     then shrinks by the compressed size (`pnio:1040`).
   - A 1,514-byte frame of zeros packs to about 32 bytes. Ninety-odd of them fit an 8,192-byte batch and decode to
     over 140 KB.
   - Ruling 12 therefore decodes into the ring, and the host test `a_batch_that_decodes_past_32_kb_is_taken` pins it.
2. **§3.2 "A batch larger than the scratch anyway … is still refused, as today, and counted."** There is no scratch
   any more, so nothing is refused for its size. Frames past the ring's free space are dropped and counted as `over`.
3. **§3.1 "A write to 76 (his config tool) is captured and ignored."** Nothing can capture it: `pnet_df1_wprot` asserts
   WPROT everywhere but cylinder 77, so trackdisk refuses the write before WGATE.
   - Unprotecting 76 would only make his config tool believe it saved.
   - The driver never writes 76. Only `paulaNetPutConfig` (`pnio:868-878`) does, and `device.c` never calls it.
   - Ruling 9 keeps 76 protected.
4. **§3.3 "in every build" means every build that serves batches.** That is the L2 build, with either DF1 buffer size.
   - The cap is a constant in `pnet_frame.h`, checked in `pnet_link_fit`. No release image compiles either file.
   - So §7's "release build stays source-identical outside the cap (with the cap's change accounted for)" has nothing
     to account for: `pnet_off_identical.sh master` passes unchanged. Task 2 rewrites the script's stale comment
     about its base.
5. **§3.4 "The same timing serves cylinders 76 and 77."** Cylinder 76 needs no timing (ruling 7). Its reads often
   follow a step, not a SIDE edge, and the 2.4-4.2 ms measurement covers only side returns.
6. **§3.1 offsets 138 and 140 are named both ways in his source.** The Amiga's struct calls them `maxTxSize` and
   `maxRxSize` (`paulanetstruct.h:63-64`). The Pico's calls the same offsets `maxRxSize` and `maxTxSize`
   (`PN.cpp:117-118`), named from the Pico's side. Both mean that offset 138 is the Amiga's batch budget.
   - The spec's table (the Amiga's names) is right. This is recorded so nobody "fixes" it from the Pico source.
   - Also checked: the 142-byte settings, the 14-byte live status, every offset in the table, mode 2, `compressed` 1,
     and both counters in the header (`PN.cpp:821, 871, 885, 903`).
7. **Precision, §2 row 4 ("the first ~128 bytes"):**
   - `findDataOffset` (`pnio:344-363`) accepts a sync whose first bit is at bit 1,024 or earlier.
   - The bound of 124 comes from the payload read instead. That read is `compressedSize + 24 + 128` bytes
     (`pnio:772-775`), so a sync starting at byte *s* leaves the payload whole only when *s* ≤ 124.
   - A cylinder-76 read is 1,024 bytes: 156 + 24 + 128 = 308, raised to the driver's minimum (`pnio:774`).

## Global Constraints

- **Worktree:** the executor creates `.claude/worktrees/pnet2` on a new branch `feat/paulanet-phase2` from master
  (`3e7421c` or later), as Task 1 Step 1 says. All work and every build happen there.
  - Never build into `/Users/sfs/Devel/webadf/wifi-floppy/firmware/build`: it is the main tree's shared release
    build.
  - This plan file sits untracked in the main tree. Task 1 Step 1 moves it into the worktree and commits it there.
- **Git:**
  - No `git stash`, `git checkout`, or `git reset` in any shared tree (the main tree above all; other sessions change
    it).
  - Re-check `git status` before staging, and stage files by name. Never `git add -A`.
  - Leave the main tree's untracked `.fw-target.mts`, `.hd-mount.mts` and `docs/schematic/` alone.
  - Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Kickstart ROMs under `docs/` are never committed. Rob's ADF and binaries are never committed either:
    redistribution is Phase 3, after his written grant is under `docs/` (spec §4).
- **Toolchain:** before any firmware build, run `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"`.
  The three configurations, each from `wifi-floppy/firmware/` in the worktree:
  - release: `cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=OFF && cmake --build build`
  - loopback: the same with `-B build-pnet -DWF_PNET_LOOP=ON -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=ON`
  - L2: the same with `-B build-pnet2 -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=ON`
  - Our sources must build without warnings. `cmake --build <dir> 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'`
    prints nothing.
- **Host tests:** `wifi-floppy/firmware/test/run.sh` takes 2-3 minutes. A task is green only when
  `wifi-floppy/firmware/test/run.sh; echo "exit $?"` prints `exit 0`, because `run.sh` reports a failure and carries
  on. New and changed tests also run once under `gcc:13` (Task 4 Step 15), because CI builds with Linux GCC.
- **Stack:** no function of ours may have a frame over 768 bytes (`-Werror=frame-larger-than=768`). Core0's stack is
  4 KB. The largest new frame is `pnet_build_status`, about 330 bytes (the 156-byte record and its 160-byte RLE).
- **SRAM:** the heap floor is 20,480 B. New `.bss` is the 992-byte status buffer plus a few counters (Task 4 Step 13
  measures it). Phase 1's heap low-water was 32,768 B.
- **OFF is unchanged:** `wifi-floppy/firmware/tools/pnet_off_identical.sh master` prints three `identical` lines
  (`main.c`, `flux_capture.c`, `net_radio_cyw43.c`) after every firmware task.
- **The radio's name** may appear only in `net_radio_cyw43.c`. `run.sh` greps the other sources for `cyw43` in any
  case, comments included (single-line comments are stripped first; multi-line ones are not). Write "the radio".
- **Protocol credit:** every new file that implements PaulaNET's protocol or layout starts with "PaulaNET protocol:
  Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET. Used with the author's permission
  (2026-10-09)". That is `pnet_status.{h,c}` and `test_pnet_status.c`. Files already carrying it keep it.
- **TEST builds:**
  - They are published with `pnpm firmware:publish --no-github --notes "TEST build: …"`, from the worktree root.
    They are never a GitHub release and never announced.
  - The worktree's `build/` goes back to the release configuration at once after a TEST publish.
- **Installs eject DF0:** the Amiga must be OFF first. Ask the operator for that as the last thing in a turn, then
  trigger the install from `/Users/sfs/Devel/webadf` with `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '<version>'`,
  and say in the conversation that an install was triggered.
- **Bench steps:**
  - Each operator step is one turn and ends the turn, with the request as the last thing in it. The operator is the
    only sensor: every step has a visible PASS or FAIL.
  - The serial log is taken by `serstream.py`. Run `pgrep -fl serstream.py` first. If one is already running on
    `/dev/cu.usbmodem1101`, use its log file (its last argument) and never start a second one. Otherwise start
    `python3 <scratchpad>/serstream.py /dev/cu.usbmodem1101 86400 <scratchpad>/pnet2-bench.log` in the background,
    copying `serstream.py` from
    `/private/tmp/claude-501/-Users-sfs-Devel-webadf/fa1f7997-11c2-4c01-a121-0f34f0567b3c/scratchpad/serstream.py`
    or recreating it from `docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md` Task 9 Step 5.
  - Before believing any absence in the log, run `grep -c 'records dropped' <log>`. A log that dropped records
    proves no absence.
- **Never kill a process by pattern** (no `pkill` or `killall`). Stop only a PID this session started, and ask before
  touching any other.
- **DF1 has one user at a time:** NetLoop and an AmiTCP_NG interface on PaulaNET.device both drive trackdisk unit 1.
  Never run NetLoop while `eth0` is up; a reboot takes it down.
- **e2e:** none (no web area changes). If one ever does change, run only its specs, on `PORT=3100`, serialized with
  any other e2e run.
- **Relay everything:** every subagent finding, ruling, deviation or rule break is told to the operator in the main
  conversation, and rulings go into the HANDOFF record (Task 7).

## Review Focus

1. **A batch from his driver that decodes past 32 KB:** 100 zero-filled 1,514-byte frames, about 3.2 KB on the wire.
   - Expected: taken, and all 100 frames queued while the ring has room. No scratch overflows, because there is none.
   - Test: `a_batch_that_decodes_past_32_kb_is_taken` (Task 3).
2. **A batch of 40 frames arrives at a TX ring with 29 slots free.**
   - Expected: taken (its counter moves, so the driver is acknowledged). 29 frames are queued, 11 are counted `over`,
     nothing is written past the ring, and the ring's own drop counter stays 0.
   - Test: `a_ring_overflow_is_taken_and_counted` (Task 3).
3. **A malformed frame (original size 0) as frame 6 of 10, in a batch whose header checks out.**
   - Expected: taken. Frames 1-5 are queued, and frames 6-10 are counted `bad`.
   - Test: `a_malformed_frame_ends_the_batch_but_not_the_link` (Task 3).
4. **A cylinder-76 read that starts at any byte and any bit of the 992-byte loop, wrapping included.**
   - Expected: a sync starting within its first 124 bytes, a mode-2 RLE header with the board's counters, and the
     decoded record equal to the spec's table byte for byte.
   - Test: `every_start_finds_a_record_within_124_bytes` (Task 4).
5. **A board-to-Amiga batch built in an HD-sized DF1 buffer (25,344 bytes) from full-size frames.**
   - Expected: at most 16,128 payload bytes (10 frames), with the cap and not the buffer being what stops it, and the
     whole track inside the driver's 16,640-byte read.
   - Test: `fit_caps_the_payload_at_16128_bytes` (Task 2).

## File structure

| File | Responsibility |
|---|---|
| `wifi-floppy/firmware/CMakeLists.txt` | Task 1: `WF_PNET_TX_LEAD_BYTES` and `WF_PNET_SIDE_DELAY_US` (plain variables). Task 4: `pnet_status.c` in L2 builds |
| `wifi-floppy/firmware/src/pnet_loop.{h,c}` | Task 1: `pnet_go_wait_us`. Task 4: `PNET_DF1_STATUS` |
| `wifi-floppy/firmware/src/pnet_frame.{h,c}` | Task 2: `PNET_TO_AMIGA_MAX_PAYLOAD`. Task 3: the frame iterator, with `pnet_parse_frames` rebuilt on it. Task 4: `pnet_put_hdr_to_amiga`, `pnet_parse_hdr_to_amiga_as` |
| `wifi-floppy/firmware/src/pnet_link.{h,c}` | Task 2: the cap in `pnet_link_fit`. Task 3: `pnet_link_take` always takes, into the ring. Task 4: `pnet_df1_for_track_l2` |
| `wifi-floppy/firmware/src/pnet_status.{h,c}` (new) | Task 4: the 156-byte record, the 992-byte loop, the version bytes |
| `wifi-floppy/firmware/src/net_radio.h`, `net_radio_cyw43.c` | Task 4: `net_radio_sta_joined` under `#if WF_PNET_L2` |
| `wifi-floppy/firmware/src/main.c` | Task 1: the alarm start, its log and boot line. Task 3: the L2 take, its log. Task 4: the status buffer and serve, `dma_irq`'s source, MAC/RSSI publication |
| `wifi-floppy/firmware/test/test_pnet_{loop,frame,link}.c`, `test_pnet_status.c` (new) | Host tests |
| `wifi-floppy/firmware/tools/pnet_off_identical.sh` | Task 2: comment only (its base is master) |
| `tools/netloop/netloop.c` | Task 1: `SCAN=`, reads and sync range per read, 1.3. Task 4: `STATUS`, 1.4 |
| `tools/netloop/netloop_stats.{h,c}`, `test_netloop_stats.c` | Task 1: `nl_driver_read_len`, `NL_DRIVER_SCAN` |
| `tools/netloop/netloop_eth.{h,c}`, `test_netloop_eth.c` | Task 4: `nl_status_problem`, checked against the board's builder |
| `tools/netloop/build.sh` | Tasks 3-4: the `_allc` renames for new `pnet_frame.c` names; Task 4: the host test links `pnet_status.c` |
| `.gitignore` | Task 1: `build-pnet2/` |
| `HANDOFF.md` | Task 7: §3bi, the backlog |

---

### Task 1: The sync spike (spec §3.4): NetLoop `SCAN=`, the delayed side-1 start, and the bench gate

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (the `WF_PNET_LOOP` block), `src/pnet_loop.h`, `src/pnet_loop.c`,
  `src/main.c`, `test/test_pnet_loop.c`, `.gitignore`.
- Modify: `tools/netloop/netloop.c`, `netloop_stats.h`, `netloop_stats.c`, `test_netloop_stats.c`.

**Interfaces:**
- Consumes: Phase 1's `pnet_serve_df1`, `pnet_stream_prepared`, `g_pnet_side_us` (the SIDE ISR's stamp),
  `index_off`, and the `stream_stop` that every DF1 stream change goes through.
- Produces:

```c
/* pnet_loop.h */
uint32_t pnet_go_wait_us(uint32_t side_us, uint32_t delay_us, uint32_t now_us);
/* main.c, WF_PNET_LOOP builds */
static volatile alarm_id_t g_pnet_go_alarm;
static void pnet_go_cancel(void);          /* called by stream_stop(1) */
static void pnet_index_now(void);
static void pnet_go(void);
static int64_t pnet_go_due(alarm_id_t id, void *ud);      /* #if PNET_SIDE_DELAY_US */
static bool pnet_go_later(bool side_return);              /* #if PNET_SIDE_DELAY_US */
/* CMake -> compile definitions */
PNET_TX_LEAD_BYTES=${WF_PNET_TX_LEAD_BYTES}   PNET_SIDE_DELAY_US=${WF_PNET_SIDE_DELAY_US}
/* netloop_stats.h */
#define NL_DRIVER_SCAN 124u
unsigned long nl_driver_read_len(unsigned long data_size);
```

  - NetLoop 1.3 takes `SCAN=<bytes>`, and prints `reads` and `sync starts at byte min/max` per read kind.
  - The bench produces the miss share of today's timing, B's sync range, and the gate verdict.

- [ ] **Step 1: The worktree.** From `/Users/sfs/Devel/webadf`:

```bash
git status --short     # expect only ?? .fw-target.mts, ?? .hd-mount.mts, ?? docs/schematic/, and this plan
git worktree add .claude/worktrees/pnet2 -b feat/paulanet-phase2 master
mv docs/superpowers/plans/2026-10-11-paulanet-phase2-rob-driver.md .claude/worktrees/pnet2/docs/superpowers/plans/
cp .env.local .claude/worktrees/pnet2/.env.local
cd .claude/worktrees/pnet2 && pnpm install --offline
git add docs/superpowers/plans/2026-10-11-paulanet-phase2-rob-driver.md
git commit -m "docs(plan): PaulaNET Phase 2 -- Rob's PaulaNET.device on our board

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

  From here on, every path is relative to the worktree, and the plan is read there. A real `pnpm install --offline` is
  needed, not a symlinked `node_modules`, because `pnpm firmware:publish` runs from this tree.

- [ ] **Step 2: Ignore the L2 side build.** In `.gitignore`, after `build-pnet1/`, add the line `build-pnet2/`.

- [ ] **Step 3: The timing as two CMake variables.** In `wifi-floppy/firmware/CMakeLists.txt`, replace

```cmake
  # The echo's lead-in: 200 x AA (3.2 ms) where the Amiga's reads assume 120 (pnet_frame.c).
  list(APPEND WFMF_COMMON_DEFS PNET_TX_LEAD_BYTES=200)
```

with

```cmake
  # The side-1 stream's lead-in (bytes of AA, 16 us each) and when a side return starts it (us after
  # the SIDE edge; 0 = at once). Phases 0-1: 200 B at once -- about a quarter of the Amiga's reads
  # then found the sync 128+ bytes in, past where PaulaNET's own driver looks (HANDOFF 3bg). Phase 2
  # (plan 2026-10-11-paulanet-phase2-rob-driver, Task 1) measures a fixed delay with PaulaNET's 120.
  # Plain variables, never cache entries: a value is a commit, so an image's version names its timing.
  set(WF_PNET_TX_LEAD_BYTES 200)
  set(WF_PNET_SIDE_DELAY_US 0)
  list(APPEND WFMF_COMMON_DEFS PNET_TX_LEAD_BYTES=${WF_PNET_TX_LEAD_BYTES}
                               PNET_SIDE_DELAY_US=${WF_PNET_SIDE_DELAY_US})
```

- [ ] **Step 4: Write the failing test.** In `wifi-floppy/firmware/test/test_pnet_loop.c`, add before `int main`:

```c
/* Phase 2 (§3.4): how long a side-1 start still waits for the SIDE edge + the delay. */
static void a_side_one_start_waits_from_the_side_edge(void) {
    CHECK_EQ_INT(pnet_go_wait_us(1000u, 2360u, 1035u), 2325);             /* the loop saw it at once */
    CHECK_EQ_INT(pnet_go_wait_us(1000u, 2360u, 3360u), 0);                /* due now */
    CHECK_EQ_INT(pnet_go_wait_us(1000u, 2360u, 4000u), 0);                /* the loop came late: at once */
    CHECK_EQ_INT(pnet_go_wait_us(0xFFFFFF00u, 2360u, 0x10u), 2088);       /* across time_us_32's wrap */
    CHECK_EQ_INT(pnet_go_wait_us(5000u, 2360u, 4990u), 0);                /* a stamp a hair ahead of now */
    CHECK_EQ_INT(pnet_go_wait_us(0u, 2360u, 0x90000000u), 0);             /* a stale stamp: never far ahead */
}
```

  and `RUN(a_side_one_start_waits_from_the_side_edge);` as the last `RUN` in `main`. The wrap case: the edge is
  256 µs before the counter wraps, so 0x10 is 272 µs after it, and 2,360 − 272 = 2,088.

- [ ] **Step 5: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_loop|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_loop.c` (the function does not exist yet).

- [ ] **Step 6: Implement.** In `wifi-floppy/firmware/src/pnet_loop.h`, after the `pnet_capture_ours` declaration, add:

```c
/* Phase 2 (plan 2026-10-11-paulanet-phase2-rob-driver, Task 1): the microseconds a start of DF1's
 * side-1 stream must still wait so it begins `delay_us` after the SIDE edge stamped at side_us, at
 * now_us (time_us_32 values; wrap-safe). 0 once that moment has passed, however long ago the edge was:
 * a stale stamp (no SIDE edge for 36 minutes) or one a hair ahead of now never schedules a start
 * far in the future. */
uint32_t pnet_go_wait_us(uint32_t side_us, uint32_t delay_us, uint32_t now_us);
```

  In `wifi-floppy/firmware/src/pnet_loop.c`, after `pnet_capture_ours`, add:

```c
uint32_t pnet_go_wait_us(uint32_t side_us, uint32_t delay_us, uint32_t now_us) {
    const uint32_t since = now_us - side_us;
    return since < delay_us ? delay_us - since : 0u;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `test_pnet_loop.c: N checks, 0 failed` and `exit 0`.

- [ ] **Step 8: Mutation proof.** Replace the body with `return side_us + delay_us - now_us;`. The stale-stamp check
  must fail (it returns about 1.8 billion). Revert.

- [ ] **Step 9: The start alarm and its cancel, ahead of `stream_stop`.** In `wifi-floppy/firmware/src/main.c`,
  directly above the comment `// Stop drive d's stream at once: no re-arm at the next wrap, and the`, insert:

```c
#if WF_PNET_LOOP
// PaulaNET Phase 2 (plan 2026-10-11-paulanet-phase2-rob-driver, Task 1): a start of DF1's side-1
// stream that is due later than now runs from a core0 alarm (pnet_go_later). Its id while pending,
// else 0. Core0 only: the loop stores it with interrupts off, the alarm's callback clears it first,
// and stream_stop(1) -- the one path every stop, rebuild or restart of DF1's stream takes -- cancels
// it, so a start never lands on a buffer being rebuilt or on a stream something else stopped.
#ifndef PNET_SIDE_DELAY_US
#define PNET_SIDE_DELAY_US 0u
#endif
#define PNET_GO_MIN_US 20u        // due sooner than this: start at once (an alarm costs about as much)
static volatile alarm_id_t g_pnet_go_alarm;
static void pnet_go_cancel(void) {
    const uint32_t irq = save_and_disable_interrupts();
    const alarm_id_t id = g_pnet_go_alarm;
    g_pnet_go_alarm = 0;
    if (id > 0) cancel_alarm(id);
    restore_interrupts(irq);
}
#endif
```

  In `stream_stop`, replace

```c
    stream_t *s = &g_stream[d];
    s->live = false;
```

  with

```c
    stream_t *s = &g_stream[d];
#if WF_PNET_LOOP
    if (d == 1) pnet_go_cancel();              // a start still pending would restart what this stops
#endif
    s->live = false;
```

- [ ] **Step 10: The window statistics.** Replace

```c
static uint32_t g_pnet_rst[PNET_RST_N], g_pnet_rst_noop, g_pnet_side_idx_max;
```

  with

```c
static uint32_t g_pnet_rst[PNET_RST_N], g_pnet_rst_noop, g_pnet_side_idx_max;
// Phase 2 (Task 1): the earliest SIDE edge -> start (us) this window, and whether the start pending or
// streaming is a side return's (pnet_go measures only those). The loop and the start alarm write
// these on the same core; a torn window statistic is the worst a race can do.
static uint32_t      g_pnet_side_idx_min = UINT32_MAX;
static volatile bool g_pnet_go_side;
#if PNET_SIDE_DELAY_US
// Side-1 starts this window: from the alarm on time / at once because the loop came after the due time.
static uint32_t      g_pnet_go_delayed, g_pnet_go_late;
#endif
```

- [ ] **Step 11: The start, split out of `pnet_serve_df1`.** Replace the whole of `pnet_serve_df1`, from the line
  `// serve_drive(1, ...) for this build: cylinder 77 is the loopback, every other track the disk.` to its closing
  `}` (the line before `// The loop's half of the pre-arm`), with:

```c
// INDEX now, as PaulaNET does at the start of every transmission: the Amiga's INDEXSYNC read then
// starts at the lead-in instead of one whole buffer later (dma_irq's INDEX is at the wrap). Short
// (PNET_INDEX_PULSE_US): trackdisk arms INDEXSYNC ~1.5-2 ms after the side change and waits for a
// NEW edge; a 2 ms pulse outlasted the 1.92 ms lead-in, so that edge was the pulse's end and the DMA
// started inside the sync. Already asserted: no new edge (noop).
static void pnet_index_now(void) {
    const uint32_t now32 = time_us_32();
    if ((int32_t)(g_pnet_idx_end_us - now32) > 0) g_pnet_rst_noop++;
    g_pnet_idx_end_us = now32 + PNET_INDEX_PULSE_US;
    bus_out_set_drive(1, PIN_INDEX, true);
    add_alarm_in_us(PNET_INDEX_PULSE_US, index_off, (void *)(uintptr_t)1u, true);
}

// Starts DF1's prepared side-1 stream and its INDEX. From the loop (pnet_serve_df1), or from the
// start alarm (pnet_go_due) on the same core.
static void pnet_go(void) {
    if (!pnet_stream_prepared()) return;
    g_pnet_echo_live = true;
#if WF_PNET_L2
    g_pnet_last_ms = clock_ms() | 1u;            // the Amiga is reading cylinder 77 (never 0)
#endif
    pnet_index_now();
    if (g_pnet_go_side) {
        // The restart can precede the SIDE ISR's stamp (negative latency): that is 0, not 4,294 s.
        const int32_t lat = (int32_t)(time_us_32() - g_pnet_side_us);
        const uint32_t l = lat > 0 ? (uint32_t)lat : 0u;
        if (l > g_pnet_side_idx_max) g_pnet_side_idx_max = l;
        if (l < g_pnet_side_idx_min) g_pnet_side_idx_min = l;
    }
}

#if PNET_SIDE_DELAY_US
static int64_t pnet_go_due(alarm_id_t id, void *ud) {
    (void)id;
    (void)ud;
    g_pnet_go_alarm = 0;              // first: pnet_go's own stream_stop(1) must not cancel this alarm
    pnet_go();
    return 0;                         // once
}

// Phase 2 (Task 1, spec §3.4). A side-1 start that comes within PNET_SIDE_DELAY_US of the latest SIDE
// edge -- a side return, or a commit landing just after one -- waits until that edge + the delay, on a
// core0 alarm. The Amiga's read DMA starts 2.4-4.2 ms after the edge (HANDOFF 3bg), so with a
// PNET_TX_LEAD_BYTES (120) lead-in the sync starts in the first 124 bytes of the read, where PaulaNET's
// driver looks for it. A later start (a step onto the cylinder, a commit long after the edge) goes at
// once. Armed with interrupts off, so the alarm cannot fire before its id is stored. True when the
// alarm starts it (or already has).
static bool pnet_go_later(bool side_return) {
    const uint32_t wait = pnet_go_wait_us(g_pnet_side_us, PNET_SIDE_DELAY_US, time_us_32());
    if (wait > PNET_GO_MIN_US) {
        const uint32_t irq = save_and_disable_interrupts();
        const alarm_id_t id = add_alarm_in_us(wait, pnet_go_due, NULL, true);
        if (id > 0) g_pnet_go_alarm = id;
        restore_interrupts(irq);
        if (id >= 0) {                   // 0: it was already due and ran at once
            g_pnet_go_delayed++;
            return true;
        }
    }
    if (side_return) g_pnet_go_late++;   // the loop came after the due time (or no alarm slot was free)
    return false;
}
#endif

// serve_drive(1, ...) for this build: cylinder 77 is the loopback, every other track the disk.
static void pnet_serve_df1(int32_t tok, int *loaded) {
    const int want = want_track[1];
    const pnet_df1_t act = pnet_df1_for_track(want);
    if (act == PNET_DF1_DISK) {
        g_pnet_echo_live = false;
        g_pnet_prepared = false;                 // serve_drive refills track_words1
        serve_drive(1, tok, loaded);
        return;
    }
#if WF_PNET_L2
    // Side 1 streaming our batch counts as a read -- re-reads without a side change included -- only
    // while the Amiga really reads DF1: selected (SEL1 low) AND its motor on. The stream never stops
    // on its own, so a head parked here would otherwise hold the OTA forever; select alone is not
    // enough either (trackdisk polls a disk change selected, motor off). Review fix round 2.
    if (act == PNET_DF1_ECHO && want == *loaded && g_pnet_echo_live && !gpio_get(PIN_SEL1) &&
        dskchg_motor_on_d(1))
        g_pnet_last_ms = clock_ms() | 1u;
#endif
    if (want == *loaded) return;
    const int was = *loaded;
    const bool commit = g_pnet_rst_commit;
    g_pnet_rst_commit = false;
    *loaded = want;
    g_pnet_echo_live = false;                    // set again only once the echo streams
    stream_stop(1);                              // the DMA reads track_words1 (and a start may be pending): stop first
    if (act == PNET_DF1_SILENT) return;          // side 0: the Amiga writes, nothing to read
    const uint64_t t0 = time_us_64();
    // Normally the commit already built and packed this echo (pnet_prepare_echo): the restart
    // only starts the DMA, so how long after the SIDE edge the echo starts does not grow with N.
    if (!g_pnet_prepared && !pnet_prepare_echo()) return;
    const unsigned cause = commit ? PNET_RST_COMMIT
                         : was == PNET_TRACK_IN ? PNET_RST_SIDE : PNET_RST_OTHER;
    g_pnet_rst[cause]++;
    g_pnet_go_side = cause == PNET_RST_SIDE;
    bool later = false;
#if PNET_SIDE_DELAY_US
    later = pnet_go_later(cause == PNET_RST_SIDE);
#endif
    if (!later) pnet_go();
    const uint32_t us = (uint32_t)(time_us_64() - t0);
    if (us > g_pnet_build_max) g_pnet_build_max = us;
    g_pnet_build_sum += us;
    g_pnet_builds++;
}
```

  `pnet_go_cancel` takes an `alarm_id_t` from `pico/time.h`, and `save_and_disable_interrupts` comes from
  `hardware/sync.h`. `main.c` already includes both.

- [ ] **Step 12: Log the starts, and the timing at boot.** In `pnet_log_summary`, directly after the statement that
  ends `PNET_SAT(g_pnet_side_idx_max, 9999999u));`, insert:

```c
#if PNET_SIDE_DELAY_US
    // Phase 2 Task 1: side-1 starts this window, from the alarm / at once because the loop came after
    // the due time, and the earliest SIDE edge -> start (the latest is side-idx max above).
    wf_logf(WF_INFO, "pnet: go at %u us: delayed %lu late %lu side-idx min us %lu",
            (unsigned)PNET_SIDE_DELAY_US, PNET_SAT(g_pnet_go_delayed, 99999u), PNET_SAT(g_pnet_go_late, 99999u),
            g_pnet_side_idx_min == UINT32_MAX ? 0ul : PNET_SAT(g_pnet_side_idx_min, 9999999u));
#endif
```

  Replace `    g_pnet_rst_noop = g_pnet_side_idx_max = 0;` with

```c
    g_pnet_rst_noop = g_pnet_side_idx_max = 0;
    g_pnet_side_idx_min = UINT32_MAX;
#if PNET_SIDE_DELAY_US
    g_pnet_go_delayed = g_pnet_go_late = 0;
#endif
```

  In `main`, directly after `wf_logf(WF_WARN, "%s: DF1 cylinder 77 is a PaulaNET loopback (bench only)", wf_pnet_loop_marker);`, add:

```c
    wf_logf(WF_INFO, "pnet: side-1 lead-in %u B, side-return start %u us after SIDE",
            (unsigned)PNET_TX_LEAD_BYTES, (unsigned)PNET_SIDE_DELAY_US);
```

- [ ] **Step 13: Build the three configurations, check identity, run the tests**

Run:
```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
F="-G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350"
cmake -B build $F -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=OFF && cmake --build build 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'
cmake -B build-pnet $F -DWF_PNET_LOOP=ON -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=ON && cmake --build build-pnet 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'
cmake -B build-pnet2 $F -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=ON && cmake --build build-pnet2 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'
tools/pnet_off_identical.sh master
cd ../.. && wifi-floppy/firmware/test/run.sh; echo "exit $?"
```
Expected:
- the three builds succeed, and none of the `grep`s prints anything;
- three `identical with WF_PNET_LOOP=0 WF_PNET_L2=0` lines;
- `exit 0`.

  Then check that the delayed path (`#if PNET_SIDE_DELAY_US`) compiles too:
  - edit `set(WF_PNET_SIDE_DELAY_US 0)` to `2360` by hand;
  - run `cmake --build build-pnet 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'`, and expect a clean build with no
    output;
  - revert the edit (`git diff --stat` shows nothing under `CMakeLists.txt`), and rebuild `build-pnet`.

- [ ] **Step 14: Write NetLoop's failing host test.** In `tools/netloop/test_netloop_stats.c`, before `int main`, add:

```c
/* SCAN= (Phase 2): payload reads sized as PaulaNET's driver sizes them (its receiveFromPaulaNet). */
static void driver_read_sizes(void) {
    CHECK(nl_driver_read_len(0) == 1024u, "a header read: the driver's 1,024-byte minimum");
    CHECK(nl_driver_read_len(64) == 1024u, "a small payload: the minimum too");
    CHECK(nl_driver_read_len(8000) == 8152u, "8,000 + 24 + 128");
    CHECK(nl_driver_read_len(8001) == 8154u, "rounded up to even first");
    CHECK(nl_driver_read_len(16600) == 16640u, "capped at 16,640");
}
```

  and `RUN(driver_read_sizes);` as the last `RUN`. Run `tools/netloop/build.sh test` and expect a compile error for
  `nl_driver_read_len`.

- [ ] **Step 15: Implement the helper.** In `tools/netloop/netloop_stats.h`, before `#endif`:

```c
/* PaulaNET's driver (Phase 2): it looks for the sync in about the first 128 bytes of a read, and its
 * payload read has 128 bytes of slack, so a sync STARTING by byte 124 is the one that always works. */
#define NL_DRIVER_SCAN 124u
/* The length of his driver's read for a payload of data_size bytes: the payload rounded up to even,
 * its 24-byte MFM header and 128 bytes of slack, at least 1,024 and at most 16,640. */
unsigned long nl_driver_read_len(unsigned long data_size);
```

  In `tools/netloop/netloop_stats.c`, at the end:

```c
unsigned long nl_driver_read_len(unsigned long data_size) {
    unsigned long n = ((data_size + 1u) & ~1ul) + 24u + 128u;
    if (n < 1024u) n = 1024u;
    if (n > 16640u) n = 16640u;
    return n;
}
```

  Run `tools/netloop/build.sh test`, and expect `test_netloop_stats.c: N checks, 0 failed`.

- [ ] **Step 16: NetLoop's `SCAN=`.** In `tools/netloop/netloop.c`:

(a) In the header comment, after the `NetLoop ARP …` usage line, add:

```c
 *   NetLoop ... SCAN=<bytes>                     (Phase 2: read as PaulaNET's own driver reads)
```

  and after the paragraph that begins ` * The summary splits`, add:

```c
 * SCAN=<bytes> (Phase 2): the sync must START within a read's first <bytes> bytes, as in PaulaNET's
 * own driver (NL_DRIVER_SCAN, 124), and payload reads are sized as his driver sizes them
 * (nl_driver_read_len). A miss counts as nosync, so a run's nosync is what his driver would retry.
```

(b) Change the version string to `"$VER: NetLoop 1.3 (11.10.2026) PaulaNET protocol by RobSmithDev, used with permission"`
  and the banner `printf` to `"NetLoop 1.3 -- PaulaNET protocol by RobSmithDev, used with permission\n"`.

(c) After `static BOOL diag;`, add:

```c
/* SCAN= (Phase 2): every read's sync-scan limit, and whether payload reads are sized as PaulaNET's
 * driver sizes them. The defaults are Phases 0-1's: a 512-byte scan and NetLoop's own sizes. */
static ULONG sync_scan = SYNC_SCAN;
static BOOL drv_reads;
/* Per read kind: reads made, and the earliest and latest byte at which a found sync STARTS. */
static unsigned long c_reads_k[2], off_lo[2] = { ~0ul, ~0ul }, off_hi[2];
```

(d) In `read_once`, replace

```c
    const int rk = with_payload ? RK_PAY : RK_HDR;
    const uint64_t t0 = ticks();
```

  with

```c
    const int rk = with_payload ? RK_PAY : RK_HDR;
    c_reads_k[rk]++;
    const uint64_t t0 = ticks();
```

  replace `const long off = pnet_find_sync(rbuf, len, scan_all ? len : SYNC_SCAN);` with
  `const long off = pnet_find_sync(rbuf, len, scan_all ? len : sync_scan);`, and after
  `c_off_k[rk][ob >= 128u ? OFF_BINS - 1u : ob >> 3]++;` add:

```c
    {
        const unsigned long st = ((unsigned long)off - 32u) >> 3;   /* where the sync starts */
        if (st < off_lo[rk]) off_lo[rk] = st;
        if (st > off_hi[rk]) off_hi[rk] = st;
    }
```

(e) In `read_echo`, replace

```c
            len = (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h->data_size + 64u + 1u) & ~1ul;
```

  with

```c
            len = drv_reads ? nl_driver_read_len(h->data_size)
                            : (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h->data_size + 64u + 1u) & ~1ul;
```

  In `l2_exchange`, replace

```c
        ULONG len = (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h.data_size + 64u + 1u) & ~1ul;
```

  with

```c
        ULONG len = drv_reads ? nl_driver_read_len(h.data_size)
                              : (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h.data_size + 64u + 1u) & ~1ul;
```

(f) In `main`:
  - Change `LONG args[11] = {0};` to `LONG args[12] = {0};`, and append `,SCAN/K/N` to the `ReadArgs` template.
  - Directly before `FreeArgs(rd);`, add:

```c
    if (args[11]) {
        const LONG v = *(LONG *)args[11];
        if (v < 32 || v > 1024) { FreeArgs(rd); printf("SCAN=32..1024\n"); return RETURN_ERROR; }
        sync_scan = (ULONG)v;
        drv_reads = TRUE;
    }
```

  - After `memset(c_off_k, 0, sizeof c_off_k);`, add:

```c
    memset(c_reads_k, 0, sizeof c_reads_k);
    off_lo[0] = off_lo[1] = ~0ul;
    off_hi[0] = off_hi[1] = 0;
```

  - After the `printf("N=%lu ROUNDS=%lu READS=%lu%s\n", …);` line, add:

```c
    if (drv_reads)
        printf("SCAN=%lu: the sync must start in a read's first %lu bytes; payload reads sized as PaulaNET's driver's\n",
               (unsigned long)sync_scan, (unsigned long)sync_scan);
```

  - Replace the per-kind summary line

```c
        printf("%s read: nosync %lu  badhdr short %lu checksum %lu magic %lu other %lu\n", rk_name[k],
               c_nosync_k[k], c_bad_k[k][0], c_bad_k[k][1], c_bad_k[k][2], c_bad_k[k][3]);
```

  with

```c
        printf("%s read: %lu reads, nosync %lu  badhdr short %lu checksum %lu magic %lu other %lu\n", rk_name[k],
               c_reads_k[k], c_nosync_k[k], c_bad_k[k][0], c_bad_k[k][1], c_bad_k[k][2], c_bad_k[k][3]);
```

  - After the histogram loop (the `for` that prints each `rk_name[k]` row), add:

```c
    for (int k = 0; k < 2; k++)
        if (off_lo[k] != ~0ul)
            printf("%s sync starts at byte: min %lu max %lu\n", rk_name[k], off_lo[k], off_hi[k]);
```

- [ ] **Step 17: Build NetLoop and its ADF; the 68000 runs the selftest under vamos**

Run: `tools/netloop/build.sh`
Expected: `test_netloop_stats.c: … 0 failed`, `test_netloop_eth.c: ok`, then three `RESULT: PASS` lines (the
equivalence test, the odd-address trace, `NetLoop SELFTEST`), and `NetLoop.adf` listed. Copy it for the operator:
`cp tools/netloop/build/NetLoop.adf ~/Downloads/NetLoop-1.3.adf`.

- [ ] **Step 18: Commit (spike A)**

```bash
git add .gitignore wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/src/pnet_loop.h \
  wifi-floppy/firmware/src/pnet_loop.c wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/test_pnet_loop.c \
  tools/netloop/netloop.c tools/netloop/netloop_stats.h tools/netloop/netloop_stats.c tools/netloop/test_netloop_stats.c
git commit -m "feat(fw,netloop): PaulaNET Phase 2 spike -- side-1 start on a timer after SIDE, NetLoop SCAN=

The lead-in and the start delay are CMake variables (200 B, 0 us: Phase 1's timing). A start
within the delay of the latest SIDE edge waits on a core0 alarm that stream_stop(1) cancels.
NetLoop 1.3: SCAN=<bytes> scans and sizes reads as PaulaNET's driver does.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 19: Build and publish spike A** (a loopback TEST image in the worktree's `build/`):

```bash
git status --short     # nothing under wifi-floppy/ or tools/
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
      -DWF_PNET_LOOP=ON -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=ON && cmake --build build
strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test      # 1
grep WF_FIRMWARE_VERSION build/generated/wifi_floppy_version.h  # 1.10.2+g<hash>, no +dirty
cd ../..
pnpm firmware:publish --dry-run --no-github --notes "TEST build: PaulaNET Phase 2 spike A -- loopback, Phase 1 timing (lead 200, at once); bench only, never a release"
pnpm firmware:publish --no-github --notes "TEST build: PaulaNET Phase 2 spike A -- loopback, Phase 1 timing (lead 200, at once); bench only, never a release"
cd wifi-floppy/firmware && cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=OFF && cmake --build build >/dev/null \
  && strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test   # 0
```

  Expected: the dry run refuses nothing, the publish prints a sequence above 71 (record it with the version), and
  `GitHub release skipped (--no-github)`.

- [ ] **Step 20: Operator, one step: switch the A500 OFF.** End the turn asking for exactly that, because the install
  ejects DF0.

- [ ] **Step 21: The log, then the install.**
  - Make sure the serial logger runs (Global Constraints).
  - From `/Users/sfs/Devel/webadf`, run `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '<spike A version>'`,
    and say in the conversation that an install was triggered.
  - Expected in the log after the reboot:
    - `wf-pnet-loop-test: DF1 cylinder 77 is a PaulaNET loopback (bench only)`;
    - `pnet: side-1 lead-in 200 B, side-return start 0 us after SIDE`;
    - `df1: next disk of the set at boot (stored)`;
    - no `not backed by PSRAM`.
  - The Devices card shows the version.

- [ ] **Step 22: Operator, one step: switch the A500 on, then NetLoop 1.3.**
  - Switch on, and let Workbench boot from the IDE drive.
  - Upload `~/Downloads/NetLoop-1.3.adf` on the Library page, and press **Mount** for the board.
  - In a Shell, run `copy df0:NetLoop SYS:C/` and then `NetLoop SELFTEST`.
  - PASS: the banner says `NetLoop 1.3`, and the last line is `RESULT: PASS`.

- [ ] **Step 23: Operator, one step: give DF1 its disk.** On the web, mount the Workbench 3.1 set's disk 1 (Workbench3.1)
  on DF0. Wait about 10 s, then run `info`. PASS: DF1 is listed (Storage3.1, HANDOFF §3bh). Do not open files on DF1.

- [ ] **Step 24: Operator, one step: today's miss share, small batches.** Run `NetLoop N=64 ROUNDS=1000 SCAN=124`.
  Record:
  - both `… read: R reads, nosync M …` lines;
  - both `sync starts at byte` lines;
  - `rounds …`, and the `RESULT:` line.

  This is information, not a gate. A FAIL here is the measurement. The share is M / R per read kind.

- [ ] **Step 25: Operator, one step: today's miss share, large batches.** Run `NetLoop N=8000 ROUNDS=300 SCAN=124`.
  Record the same lines.

- [ ] **Step 26: Spike B: the timing as constants.** In `wifi-floppy/firmware/CMakeLists.txt`, replace

```cmake
  set(WF_PNET_TX_LEAD_BYTES 200)
  set(WF_PNET_SIDE_DELAY_US 0)
```

  with

```cmake
  # Spike B (Task 1 Step 26; plan ruling 6): the window that keeps the sync in bytes 0..123 of every
  # read for a DMA start 2.4-4.2 ms after SIDE is 2,280-2,448 us at a 120-byte lead; 2,360 is its middle.
  set(WF_PNET_TX_LEAD_BYTES 120)
  set(WF_PNET_SIDE_DELAY_US 2360)
```

  Then rebuild `build-pnet` and `build-pnet2` (Step 13's commands) with no warnings, and commit:

```bash
git add wifi-floppy/firmware/CMakeLists.txt
git commit -m "feat(fw): PaulaNET Phase 2 spike B -- 120-byte lead-in, side-1 start 2,360 us after SIDE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

  Build and publish exactly as Step 19, with the notes `"TEST build: PaulaNET Phase 2 spike B -- loopback, lead 120,
  start 2360 us after SIDE; bench only, never a release"`, and put `build/` back. Record the sequence.

- [ ] **Step 27: Operator, one step: switch the A500 OFF.**

- [ ] **Step 28: Install spike B** as in Step 21. Expected:
  `pnet: side-1 lead-in 120 B, side-return start 2360 us after SIDE`.

- [ ] **Step 29: Operator, one step:** switch the A500 on. Once Workbench is up, mount the Workbench 3.1 set's disk 1
  on DF0 again (the install ejected it), wait about 10 s, and run `info`. PASS: DF1 is listed.

- [ ] **Step 30: Operator, one step: where the sync lands now.** Run `NetLoop N=64 ROUNDS=200` (no `SCAN=`: the full
  scan, so a sync found late is still seen). Record both `sync starts at byte` lines and the histogram. Ruling 6
  predicts about 5..118.

- [ ] **Step 31: Operator, one step: gate (a).** Run `NetLoop N=64 ROUNDS=1000 SCAN=124`.
  PASS: both `… nosync 0` and `RESULT: PASS`.

- [ ] **Step 32: Operator, one step: gate (b).** Run `NetLoop N=8000 ROUNDS=1000 SCAN=124`.
  PASS: both `… nosync 0` and `RESULT: PASS`.

- [ ] **Step 33: Read the log, and decide the gate** (no operator step).
  - Run `grep -c 'records dropped' <log>`.
  - Record, over Steps 30-32:
    - the `pnet: go at 2360 us: delayed … late … side-idx min us …` lines, and `side-idx max us` from the `restart`
      lines. The delayed starts should sit at about 2,360-2,400 µs;
    - `late` (side returns started at once because the loop came after the due time). Each one is a candidate for a
      miss;
    - `pnet: bad` and `refused` (expected none, as in Phase 0).
  - **Gate passed** (Steps 31 and 32 both PASS with `nosync 0`):
    - spike B's commit stands as the constants;
    - write the numbers of Steps 24-25 and 30-33 into the SDD ledger for Task 7's record;
    - tell the operator in one paragraph, and go on to Task 2. No question is needed.
  - **Gate failed: STOP** (spec §3.4: the spec does not guess a fallback).
    - Tell the operator Steps 24-25 and 30-32's numbers, `late`, and the `side-idx` range.
    - Give the delay the measured range implies. If Step 30's sync starts span *lo..hi* bytes, centring them on 61
      takes *D' = 2360 + 16 × (61 − (lo + hi)/2)* µs. A span wider than 123 bytes cannot be centred at all.
    - End the turn asking how to proceed.

---

### Task 2: Batches to the Amiga carry at most 16,128 payload bytes (spec §3.3)

**Files:**
- Modify: `wifi-floppy/firmware/src/pnet_frame.h`, `src/pnet_link.h`, `src/pnet_link.c`, `test/test_pnet_link.c`.
- Modify: `wifi-floppy/firmware/tools/pnet_off_identical.sh` (its comment only).

**Interfaces:**
- Consumes: `pnet_payload_bound`, `pnet_to_amiga_bound`, `pnet_build_to_amiga`, `pnet_parse_hdr_to_amiga`.
- Produces: `#define PNET_TO_AMIGA_MAX_PAYLOAD 16128u` (`pnet_frame.h`). `pnet_link_fit(const uint16_t *lens,
  unsigned avail, size_t cap)` keeps its signature, and now also holds a batch's payload bound within the cap.

- [ ] **Step 1: Write the failing test.** In `wifi-floppy/firmware/test/test_pnet_link.c`, before `int main`:

```c
/* Phase 2 (§3.3): whatever DF1's buffer, a batch to the Amiga carries at most 16,128 payload bytes, so
 * its whole track sits inside PaulaNET's driver's largest read (16,640 bytes). */
static void fit_caps_the_payload_at_16128_bytes(void) {
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) lens[i] = PNET_ETH_MTU;
    const size_t hd = 25344u - 80u;                          /* a WF_DF1_HD buffer, as PNET_BATCH_CAP has it */
    const unsigned n = pnet_link_fit(lens, 25, hd);
    CHECK_EQ_INT(n, 10);                                     /* 4 + 10 x 1,539 = 15,394; 11 would be 16,933 */
    CHECK(pnet_payload_bound(lens, n) <= PNET_TO_AMIGA_MAX_PAYLOAD, "n is inside the cap");
    CHECK(pnet_payload_bound(lens, n + 1) > PNET_TO_AMIGA_MAX_PAYLOAD, "n + 1 is not");
    CHECK(pnet_to_amiga_bound(lens, n + 1) <= hd, "and the cap, not the buffer, is what stops it");
    static uint8_t frame[PNET_ETH_MTU], out[25344];
    for (unsigned i = 0; i < sizeof frame; i++) frame[i] = (uint8_t)(i * 37u);
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
    for (unsigned i = 0; i < n; i++) { f[i].data = frame; f[i].len = PNET_ETH_MTU; }
    CHECK(pnet_build_to_amiga(out, hd, 0, 0, 0, f, n) != 0, "built");
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + PNET_LEAD_BYTES + 4u, sizeof out - PNET_LEAD_BYTES - 4u, &h, true),
                 PNET_OK);
    CHECK(h.data_size <= PNET_TO_AMIGA_MAX_PAYLOAD, "the built batch is inside the cap");
    CHECK(PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h.data_size <= 16640u, "inside the driver's largest read");
}
```

  Add `RUN(fit_caps_the_payload_at_16128_bytes);` after `RUN(fit_respects_the_buffer_and_twenty_frames);`. The
  numbers: `pnet_rle_bound(1518)` is 1518 + 11 + 2 = 1,531, plus 8 for the frame's header, so each frame is 1,539
  bytes and the payload's own header is 4. The host build sends a 120-byte lead-in, because `pnet_frame.c`'s
  `PNET_TX_LEAD_BYTES` fallback is 120.

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_link|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_link.c` (`PNET_TO_AMIGA_MAX_PAYLOAD` is undeclared).

- [ ] **Step 3: Implement.** In `wifi-floppy/firmware/src/pnet_frame.h`, after `#define PNET_MAX_FRAMES      20u`, add:

```c
/* The most payload one board -> Amiga batch carries (Phase 2, spec 2026-10-11 §3.3), in EVERY build
 * that sends batches: PaulaNET's driver reads at most compressed_size + 24 + 128 bytes, capped at
 * 16,640, so 16,128 (16 KB - 256, his own board's cap on a transfer) keeps the whole track inside it
 * -- a WF_DF1_HD buffer (25,344 B) would otherwise allow a batch the driver cannot read whole. */
#define PNET_TO_AMIGA_MAX_PAYLOAD 16128u
```

  In `wifi-floppy/firmware/src/pnet_link.c`, replace `pnet_link_fit` with:

```c
unsigned pnet_link_fit(const uint16_t *lens, unsigned avail, size_t cap) {
    if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
    unsigned n = 0;
    while (n < avail && pnet_to_amiga_bound(lens, n + 1u) <= cap &&
           pnet_payload_bound(lens, n + 1u) <= PNET_TO_AMIGA_MAX_PAYLOAD) n++;
    return n;
}
```

  In `src/pnet_link.h`, replace the `pnet_link_fit` comment with:

```c
/* How many of the first `avail` waiting frames (lengths lens[]) one batch to the Amiga holds: within
 * `cap` bytes on the wire (pnet_to_amiga_bound) and PNET_TO_AMIGA_MAX_PAYLOAD bytes of payload
 * (pnet_payload_bound), at most PNET_MAX_FRAMES. The rest stay in the ring for the next batch. */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `test_pnet_link.c: N checks, 0 failed` and `exit 0`.

- [ ] **Step 5: Mutation proof.** Delete the `&& pnet_payload_bound(…) <= PNET_TO_AMIGA_MAX_PAYLOAD` condition. Then
  `fit_caps_the_payload_at_16128_bytes` must fail with `expected 10, got 16`. Revert.

- [ ] **Step 6: The identity script's stale comment.** In `wifi-floppy/firmware/tools/pnet_off_identical.sh`, replace

```bash
# <base> is Task 1's commit of plan 2026-10-11 until that plan merges (its pio2 fix
# changes flux_capture.c in every build).
```

  with

```bash
# <base> is master. PaulaNET Phase 2 (plan 2026-10-11-paulanet-phase2-rob-driver) changes these files
# only inside #if WF_PNET_LOOP / WF_PNET_L2. Its one every-build rule, the 16,128-byte batch cap
# (Task 2), lives in pnet_frame.h and pnet_link.c, which no release image compiles.
```

- [ ] **Step 7: Build, identity, tests.** Run Task 1 Step 13's commands.
  Expected: no warnings, three `identical` lines, `exit 0`. The release image is unchanged by the cap, because
  neither file is in it.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_frame.h wifi-floppy/firmware/src/pnet_link.h wifi-floppy/firmware/src/pnet_link.c \
  wifi-floppy/firmware/test/test_pnet_link.c wifi-floppy/firmware/tools/pnet_off_identical.sh
git commit -m "feat(fw): PaulaNET batches to the Amiga carry at most 16,128 payload bytes, any DF1 buffer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Always take a well-formed batch (spec §3.2): frames straight into the TX ring, drops counted

**Files:**
- Modify: `wifi-floppy/firmware/src/pnet_frame.h`, `src/pnet_frame.c` (the iterator; `pnet_parse_frames` rebuilt on
  it).
- Modify: `src/pnet_link.h`, `src/pnet_link.c` (the take).
- Modify: `src/main.c` (`pnet_take_capture`'s L2 block, `pnet_l2_log`).
- Test: `test/test_pnet_frame.c`, `test/test_pnet_link.c`.
- Modify: `tools/netloop/build.sh` (two `_allc` renames).

**Interfaces:**
- Consumes: `pnet_ring_space`, `pnet_ring_claim`, `pnet_ring_commit`, `PNET_RING_MTU` (`pnet_ring.h`), and
  `pnet_parse_hdr_from_amiga`, which still checks magic, mode, size and checksum first (in `main.c`).
- Produces:

```c
/* pnet_frame.h */
typedef struct {
    const uint8_t *p;
    size_t     len, pos;
    pnet_dir_t dir;
    unsigned   count;   /* the batch's frame count (its PacketsHeader), 0..255 */
    unsigned   i;       /* frames read so far */
} pnet_frame_iter_t;
pnet_err_t pnet_frame_iter_init(pnet_frame_iter_t *it, const uint8_t *p, size_t len, pnet_dir_t dir);
pnet_err_t pnet_frame_iter_next(pnet_frame_iter_t *it, uint8_t *out, size_t cap, uint16_t *len);
/* pnet_link.h */
typedef enum { PNET_TAKE_NEW, PNET_TAKE_DUP } pnet_take_t;
typedef struct {
    uint8_t  last_amiga, pico;
    bool     backup;
    uint8_t  nframes;
    uint32_t fresh, dup, acked;
    uint32_t queued, over, malformed;
} pnet_link_t;
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx);
```

  `txfull` and `PNET_TAKE_FULL` are gone. The log gains `pnet: l2 from amiga new … dup … frames … over … bad …`.

- [ ] **Step 1: Write the iterator's failing test.** In `wifi-floppy/firmware/test/test_pnet_frame.c`, before
  `int main`:

```c
/* Phase 2: one frame at a time, as the board now decodes the Amiga's batch into its TX ring. */
static void frames_come_one_at_a_time(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    const uint8_t *pay = out + 4 + PNET_HDR_BYTES;
    pnet_frame_iter_t it;
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, h.compressed_size, PNET_TO_BOARD), PNET_OK);
    CHECK_EQ_INT(it.count, 3);
    size_t at = 0;
    for (unsigned i = 0; i < 3; i++) {
        uint16_t len = 0;
        CHECK_EQ_INT(pnet_frame_iter_next(&it, dec, PNET_ETH_MTU, &len), PNET_OK);
        CHECK_EQ_INT(len, lens[i]);
        CHECK(memcmp(dec, payload + at, len) == 0, "the frame's bytes");
        at += len;
    }
    uint16_t len = 0;
    CHECK_EQ_INT(pnet_frame_iter_next(&it, dec, PNET_ETH_MTU, &len), PNET_E_FRAMES);   /* none left */
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, 0, PNET_TO_BOARD), PNET_OK);
    CHECK_EQ_INT(it.count, 0);                                                         /* an empty payload */
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, 3, PNET_TO_BOARD), PNET_E_FRAMES);     /* under 4 bytes */
    CHECK_EQ_INT(pnet_frame_iter_init(&it, pay, h.compressed_size, PNET_TO_BOARD), PNET_OK);
    CHECK_EQ_INT(pnet_frame_iter_next(&it, dec, 63, &len), PNET_E_FULL);               /* 64 bytes into 63 */
    CHECK_EQ_INT(it.i, 0);                                                             /* an error stays put */
}
```

  and `RUN(frames_come_one_at_a_time);` as the last `RUN`.

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_frame|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_frame.c`.

- [ ] **Step 3: Implement the iterator, and rebuild `pnet_parse_frames` on it.** In
  `wifi-floppy/firmware/src/pnet_frame.h`, directly before the `/* Decodes a payload's frames, back to back` comment,
  add:

```c
/* One frame at a time (PaulaNET Phase 2): the board decodes the Amiga's frames straight into its TX
 * ring's slots, so no batch is ever refused for its decoded size -- an RLE batch inside the driver's
 * 8,192-byte budget can decode to over 140 KB (plan 2026-10-11-paulanet-phase2-rob-driver,
 * correction 1). pnet_parse_frames is built on it. */
typedef struct {
    const uint8_t *p;
    size_t     len, pos;
    pnet_dir_t dir;
    unsigned   count;   /* the batch's frame count (its PacketsHeader), 0..255 */
    unsigned   i;       /* frames read so far */
} pnet_frame_iter_t;
/* PNET_OK (count 0 for an empty payload), or PNET_E_FRAMES for a payload of 1..3 bytes. */
pnet_err_t pnet_frame_iter_init(pnet_frame_iter_t *it, const uint8_t *p, size_t len, pnet_dir_t dir);
/* Frame it->i into out[0..cap), its length into *len, then on to the next. PNET_E_FRAMES when none
 * is left. Any error leaves it->i where it was: that frame and the rest are unreadable. */
pnet_err_t pnet_frame_iter_next(pnet_frame_iter_t *it, uint8_t *out, size_t cap, uint16_t *len);
```

  In `wifi-floppy/firmware/src/pnet_frame.c`, replace the whole of `pnet_parse_frames` with:

```c
pnet_err_t pnet_frame_iter_init(pnet_frame_iter_t *it, const uint8_t *p, size_t len, pnet_dir_t dir) {
    it->p = p;
    it->len = len;
    it->pos = 4;
    it->dir = dir;
    it->count = 0;
    it->i = 0;
    if (len == 0) return PNET_OK;
    if (len < 4) return PNET_E_FRAMES;
    uint8_t ph[2];
    pnet_mfm_decode(p, 2, ph);
    it->count = ph[0];
    return PNET_OK;
}

pnet_err_t pnet_frame_iter_next(pnet_frame_iter_t *it, uint8_t *out, size_t cap, uint16_t *len) {
    if (it->i >= it->count) return PNET_E_FRAMES;
    if (8u > it->len - it->pos) return PNET_E_FRAMES;
    uint8_t ch[4];
    pnet_mfm_decode(it->p + it->pos, 4, ch);
    const size_t at = it->pos + 8u;
    const uint16_t field = get16(ch), os = get16(ch + 2);
    const size_t size = field & 0x7FFFu;
    const bool rle = it->dir == PNET_TO_BOARD ? (field & 0x8000u) != 0 : (field & 0x8000u) == 0;
    if (size > it->len - at) return PNET_E_FRAMES;
    if (os == 0 || os > PNET_ETH_MTU) return PNET_E_FRAME_SIZE;
    if (os > cap) return PNET_E_FULL;
    if (rle) {
        if (pnet_rle_decode(it->p + at, size, out, os) != (long)os) return PNET_E_RLE;
    } else {
        if (size != 2u * os) return PNET_E_FRAME_SIZE;
        pnet_mfm_decode(it->p + at, os, out);
    }
    *len = os;
    const size_t next = at + size + (size & 1u);
    it->pos = next > it->len ? it->len : next;
    it->i++;
    return PNET_OK;
}

pnet_err_t pnet_parse_frames(const uint8_t *p, size_t len, pnet_dir_t dir, uint8_t *out,
                             size_t cap, uint16_t *lens, unsigned max, unsigned *n) {
    *n = 0;
    pnet_frame_iter_t it;
    pnet_err_t e = pnet_frame_iter_init(&it, p, len, dir);
    if (e != PNET_OK) return e;
    if (it.count > max) return PNET_E_FRAMES;
    size_t used = 0;
    for (unsigned k = 0; k < it.count; k++) {
        e = pnet_frame_iter_next(&it, out + used, cap - used, &lens[k]);
        if (e != PNET_OK) return e;
        used += lens[k];
    }
    *n = it.count;
    return PNET_OK;
}
```

  This keeps `pnet_parse_frames`' behaviour, every error included. Its existing tests, NetLoop's selftest and the
  loopback echo pin that.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `test_pnet_frame.c: N checks, 0 failed` (every old test unchanged) and `exit 0`. Any failure means the
rebuilt `pnet_parse_frames` changed behaviour: fix it before going on.

- [ ] **Step 5: Write the take's failing tests.** In `wifi-floppy/firmware/test/test_pnet_link.c`:

(a) After `#include "../src/pnet_link.h"`, add `#include "../src/pnet_mfm.h"` and `#include <stdbool.h>`. After
  `hdr()`, add:

```c
static uint8_t g_mem[256 * PNET_RING_SLOT];   /* the TX ring's slots */
static uint8_t g_pay[32768];                  /* one batch's payload */

/* A to-board payload of n frames of `len` bytes, packed as PaulaNET's driver packs them with RLE on:
 * the PacketsHeader, then per frame its CompressionHeader (bit 15 set: RLE) and the RLE bytes. Built
 * by hand, because pnet_build_to_board stops at 20 frames and his driver does not. Frame i's bytes
 * are i + 7k (no runs), or all zeros, which RLE packs about 60 to 1. */
static size_t payload_of(uint8_t *out, unsigned n, uint16_t len, bool zeros) {
    static uint8_t f[PNET_ETH_MTU];
    const uint8_t ph[2] = { (uint8_t)n, 0 };
    uint16_t last = 0;
    size_t pos = pnet_mfm_encode(ph, 2, out, &last);
    for (unsigned i = 0; i < n; i++) {
        for (unsigned k = 0; k < len; k++) f[k] = zeros ? 0u : (uint8_t)(i + 7u * k);
        const size_t r = pnet_rle_encode(f, len, out + pos + 8);
        const uint8_t ch[4] = { (uint8_t)(0x80u | (r >> 8)), (uint8_t)r, (uint8_t)(len >> 8), (uint8_t)len };
        last = 0;
        pnet_mfm_encode(ch, 4, out + pos, &last);
        pos += 8u + r;
    }
    return pos;
}

static void tx_ring(pnet_ring_t *r, uint32_t slots) { CHECK(pnet_ring_init(r, g_mem, slots), "ring"); }
```

(b) Replace `a_new_batch_is_taken_once` and `a_batch_that_does_not_fit_the_tx_ring_is_not_taken` with:

```c
static void a_new_batch_is_taken_once(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    pnet_hdr_t h = hdr(0x00, 0x7F);
    h.compressed_size = (uint16_t)payload_of(g_pay, 2, 60, false);
    CHECK(pnet_link_is_new(&s, &h), "new");
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x00);
    CHECK_EQ_INT(pnet_ring_count(&tx), 2);
    CHECK(!pnet_link_is_new(&s, &h), "now a resend");
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_DUP);
    CHECK_EQ_INT(pnet_ring_count(&tx), 2);                   /* a resend queues nothing */
    CHECK_EQ_INT(s.fresh, 1);
    CHECK_EQ_INT(s.dup, 1);
    CHECK_EQ_INT(s.queued, 2);
    h = hdr(0x01, 0x7F);                                     /* an empty batch: compressed_size 0 */
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x01);
}

static void batches_of_21_to_255_frames_are_taken_whole(void) {
    static const unsigned sizes[3] = { 21, 100, 255 };
    for (unsigned k = 0; k < 3; k++) {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 256);
        const unsigned n = sizes[k];
        pnet_hdr_t h = hdr(0x10, 0x7F);
        h.compressed_size = (uint16_t)payload_of(g_pay, n, 60, false);
        CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
        CHECK_EQ_INT(pnet_ring_count(&tx), n);
        CHECK_EQ_INT(s.over + s.malformed, 0);
        uint16_t len = 0;
        const uint8_t *f = pnet_ring_peek(&tx, n - 1u, &len);
        CHECK(f && len == 60 && f[0] == (uint8_t)(n - 1u) && f[59] == (uint8_t)(n - 1u + 7u * 59u),
              "the last frame, intact");
    }
}

static void a_ring_overflow_is_taken_and_counted(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    static const uint8_t earlier[60];
    for (unsigned i = 0; i < 3; i++) CHECK(pnet_ring_push(&tx, earlier, 60), "frames already waiting");
    pnet_hdr_t h = hdr(0x05, 0x7F);
    h.compressed_size = (uint16_t)payload_of(g_pay, 40, 60, false);
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x05);                        /* taken: acknowledged, never resent */
    CHECK_EQ_INT(pnet_ring_count(&tx), 32);                  /* full, and nothing written past it */
    CHECK_EQ_INT(s.queued, 29);
    CHECK_EQ_INT(s.over, 11);
    CHECK_EQ_INT(tx.drops, 0);                               /* the take never claims a slot it lacks */
    uint16_t len = 0;
    const uint8_t *f = pnet_ring_peek(&tx, 31, &len);
    CHECK(f && f[0] == 28, "the batch's 29th frame is the last one in");
}

static void a_batch_that_decodes_past_32_kb_is_taken(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 128);
    pnet_hdr_t h = hdr(0x06, 0x7F);
    const size_t n = payload_of(g_pay, 100, 1514, true);
    CHECK(n <= 8192u, "inside the driver's 8,192-byte budget");
    h.compressed_size = (uint16_t)n;
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.queued, 100);                             /* 151,400 bytes: Phase 1's 32 KB scratch refused it */
    CHECK_EQ_INT(s.over, 0);
}

static void a_malformed_frame_ends_the_batch_but_not_the_link(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    pnet_hdr_t h = hdr(0x07, 0x7F);
    h.compressed_size = (uint16_t)payload_of(g_pay, 10, 60, false);
    CHECK_EQ_INT(h.compressed_size, 4 + 10 * 70);            /* each frame: 8 + 62 (61 bytes of RLE, padded) */
    const uint8_t bad[4] = { 0x80, 62, 0, 0 };               /* frame 6 (index 5): original size 0 */
    uint16_t last = 0;
    pnet_mfm_encode(bad, 4, g_pay + 4 + 5u * 70u, &last);
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x07);
    CHECK_EQ_INT(s.queued, 5);
    CHECK_EQ_INT(s.malformed, 5);                            /* frame 6 and the four after it */
}
```

(c) In `an_unacknowledged_batch_is_rebuilt_unchanged`, replace `CHECK_EQ_INT(pnet_link_take(&s, &h, 0, 32), PNET_TAKE_NEW);`
  with

```c
    pnet_ring_t tx;
    tx_ring(&tx, 32);
    CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);   /* h: an empty batch */
```

(d) In `main`, replace `RUN(a_batch_that_does_not_fit_the_tx_ring_is_not_taken);` with:

```c
    RUN(batches_of_21_to_255_frames_are_taken_whole);
    RUN(a_ring_overflow_is_taken_and_counted);
    RUN(a_batch_that_decodes_past_32_kb_is_taken);
    RUN(a_malformed_frame_ends_the_batch_but_not_the_link);
```

  The sizes: 60 bytes with no run of three are one literal block (1 + 60 = 61, padded to 62). A frame of 1,514 zeros
  is twelve repeats (2 bytes each), so 24 + 8 bytes per frame, and 100 frames are 3,204 bytes. The 255-frame batch is
  4 + 255 × 70 = 17,854 bytes, inside `g_pay`.

- [ ] **Step 6: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_link|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_link.c` (`pnet_link_take` has the old signature, and `queued` does not exist).

- [ ] **Step 7: Implement the take.** In `wifi-floppy/firmware/src/pnet_link.h`:

(a) Replace the bullet that begins ` *  - The Amiga's batch: new when its amiga counter differs` (two lines, through
  `unacknowledged and the Amiga resends it (no frame goes out half or twice).`) with:

```c
 *  - The Amiga's batch: new when its amiga counter differs from the last one taken. A new batch is
 *    ALWAYS taken (Phase 2, spec 2026-10-11 §3.2): its counter becomes the last taken, so the next
 *    header acknowledges it, and its frames go into the TX ring while the ring has room. Frames that
 *    do not fit, and a malformed frame with every frame after it, are dropped and counted. Rob's own
 *    board drops on a full queue too, TCP resends, and a batch never acknowledged is resent by his
 *    driver forever, which locks its sending up. (Phase 1 refused a batch the ring could not hold.)
```

(b) Add `#include "pnet_ring.h"` after `#include "pnet_frame.h"`.

(c) Replace

```c
typedef enum { PNET_TAKE_NEW, PNET_TAKE_DUP, PNET_TAKE_FULL } pnet_take_t;

typedef struct {
    uint8_t  last_amiga, pico;
    bool     backup;
    uint8_t  nframes;
    uint32_t fresh, dup, txfull, acked;
} pnet_link_t;
```

  with

```c
typedef enum { PNET_TAKE_NEW, PNET_TAKE_DUP } pnet_take_t;

typedef struct {
    uint8_t  last_amiga, pico;
    bool     backup;
    uint8_t  nframes;
    uint32_t fresh, dup, acked;
    uint32_t queued;      /* the Amiga's frames into the TX ring */
    uint32_t over;        /* ...dropped: the ring was full */
    uint32_t malformed;   /* ...dropped: a malformed frame, and every frame after it in its batch */
} pnet_link_t;
```

(d) Replace the `pnet_link_take` declaration and its comment with:

```c
/* The Amiga's batch, its header already checked (pnet_parse_hdr_from_amiga); `payload` is its
 * h->compressed_size bytes. DUP (counted, nothing queued) when its counter is the last taken;
 * otherwise NEW, always -- see above. Never claims a slot the ring does not have. */
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx);
```

  In `wifi-floppy/firmware/src/pnet_link.c`, replace `pnet_link_take` with:

```c
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx) {
    if (!pnet_link_is_new(s, h)) { s->dup++; return PNET_TAKE_DUP; }
    s->last_amiga = h->amiga_ctr;
    s->fresh++;
    pnet_frame_iter_t it;
    if (pnet_frame_iter_init(&it, payload, h->compressed_size, PNET_TO_BOARD) != PNET_OK) {
        s->malformed++;                                 /* a 1..3-byte payload: one unreadable frame */
        return PNET_TAKE_NEW;
    }
    while (it.i < it.count) {
        if (pnet_ring_space(tx) == 0u) { s->over += it.count - it.i; break; }
        uint8_t *slot = pnet_ring_claim(tx);
        uint16_t len = 0;
        if (pnet_frame_iter_next(&it, slot, PNET_RING_MTU, &len) != PNET_OK) {
            s->malformed += it.count - it.i;            /* this frame and the rest: unreadable */
            break;
        }
        pnet_ring_commit(tx, len);
        s->queued++;
    }
    return PNET_TAKE_NEW;
}
```

  `pnet_ring_claim` after a nonzero `pnet_ring_space` never returns NULL. A claimed slot that is not committed is
  simply claimed again by the next frame.

- [ ] **Step 8: Core0 takes batches this way.** In `wifi-floppy/firmware/src/main.c`, in `pnet_take_capture`, replace
  the whole `#if WF_PNET_L2` branch (from `    // Phase 1: the acknowledgement first (it may free our batch out), then the Amiga's frames into`
  to the line before `#else`) with:

```c
    // Phase 2 (spec 2026-10-11 §3.2): the acknowledgement first (it may free our batch out), then the
    // Amiga's batch -- ALWAYS taken once its header checks out. Its frames are decoded straight into
    // the TX ring's slots while the ring has room; the rest, and a malformed frame with those after it,
    // are dropped and counted (pnet_link.h). No scratch: an RLE batch can decode past any fixed size.
    const unsigned acked = pnet_link_ack(&g_link, &h);
    if (acked) pnet_ring_drop(&g_pnet_rx, acked);
    pnet_link_take(&g_link, &h, cap.bytes + PNET_HDR_BYTES, &g_pnet_tx);
```

- [ ] **Step 9: The log.** In `pnet_l2_log`, replace

```c
    const uint32_t sum = st.in_amiga + st.in_both + st.rx_drops + st.tx_sent + st.tx_err + no +
                         g_link.txfull + g_link.acked + st.clash + st.hooks;
```

  with

```c
    const uint32_t sum = st.in_amiga + st.in_both + st.rx_drops + st.tx_sent + st.tx_err + no +
                         g_link.fresh + g_link.dup + g_link.queued + g_link.over + g_link.malformed +
                         g_link.acked + st.clash + st.hooks;
```

  and replace

```c
    wf_logf(no ? WF_WARN : WF_INFO, "pnet: l2 tx no len %lu mac %lu type %lu clash %lu full %lu ack %lu",
            (unsigned long)st.tx_no[PNET_TX_LEN], (unsigned long)st.tx_no[PNET_TX_MAC],
            (unsigned long)st.tx_no[PNET_TX_TYPE], (unsigned long)st.tx_no[PNET_TX_CLASH],
            (unsigned long)g_link.txfull, (unsigned long)g_link.acked);
```

  with

```c
    wf_logf(no ? WF_WARN : WF_INFO, "pnet: l2 tx no len %lu mac %lu type %lu clash %lu ack %lu",
            (unsigned long)st.tx_no[PNET_TX_LEN], (unsigned long)st.tx_no[PNET_TX_MAC],
            (unsigned long)st.tx_no[PNET_TX_TYPE], (unsigned long)st.tx_no[PNET_TX_CLASH],
            (unsigned long)g_link.acked);
    // Phase 2: the Amiga's batches -- taken, resent; their frames queued, dropped on a full ring, and
    // dropped as malformed (spec §3.2: every drop counted).
    wf_logf(g_link.over || g_link.malformed ? WF_WARN : WF_INFO,
            "pnet: l2 from amiga new %lu dup %lu frames %lu over %lu bad %lu",
            (unsigned long)g_link.fresh, (unsigned long)g_link.dup, (unsigned long)g_link.queued,
            (unsigned long)g_link.over, (unsigned long)g_link.malformed);
```

  Each line fits `WF_LOG_MSG` (88) at five-digit widths.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `test_pnet_frame.c … 0 failed`, `test_pnet_link.c … 0 failed`, `exit 0`.

- [ ] **Step 11: Mutation proofs.** Do each, see the named test fail, then revert:
  - Put Phase 1's limit back, by adding `if (it.count > PNET_MAX_FRAMES) return PNET_TAKE_NEW;` after the init: then
    `batches_of_21_to_255_frames_are_taken_whole` fails.
  - In the take, replace `s->over += it.count - it.i; break;` with `return PNET_TAKE_DUP;`: then
    `a_ring_overflow_is_taken_and_counted` fails.
  - In `pnet_frame_iter_next`, move `it->i++;` above the `os == 0` check: then
    `a_malformed_frame_ends_the_batch_but_not_the_link` fails (4 malformed, not 5), and so does
    `frames_come_one_at_a_time`.

- [ ] **Step 12: NetLoop still builds.** `pnet_frame.c` is compiled twice into NetLoop, once under `_allc` names. In
  `tools/netloop/build.sh`, in the `A="…"` list, after `-Dpnet_parse_frames=pnet_parse_frames_allc`, add
  ` -Dpnet_frame_iter_init=pnet_frame_iter_init_allc -Dpnet_frame_iter_next=pnet_frame_iter_next_allc`, inside the
  quotes. Then run `tools/netloop/build.sh`.
  Expected: the host tests pass, there are no duplicate symbols at link, and three `RESULT: PASS` lines.

- [ ] **Step 13: Build, identity.** Run Task 1 Step 13's commands. Expected: no warnings, three `identical` lines,
  `exit 0`.

- [ ] **Step 14: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_frame.h wifi-floppy/firmware/src/pnet_frame.c wifi-floppy/firmware/src/pnet_link.h \
  wifi-floppy/firmware/src/pnet_link.c wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/test_pnet_frame.c \
  wifi-floppy/firmware/test/test_pnet_link.c tools/netloop/build.sh
git commit -m "feat(fw): PaulaNET always takes a well-formed batch; frames decode straight into the TX ring

Up to 255 frames; a full ring or a malformed frame drops and counts the rest (over, bad), and the
counter still moves, so PaulaNET's driver never resends a batch forever. No 32 KB scratch: an RLE
batch inside his 8,192-byte budget can decode past it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Cylinder 76, the status track (spec §3.1), and NetLoop `STATUS`

**Files:**
- Modify: `wifi-floppy/firmware/src/pnet_frame.{h,c}` (`pnet_put_hdr_to_amiga`, `pnet_parse_hdr_to_amiga_as`).
- Create: `wifi-floppy/firmware/src/pnet_status.h`, `src/pnet_status.c`, `test/test_pnet_status.c`.
- Modify: `src/pnet_loop.h` (`PNET_DF1_STATUS`), `src/pnet_link.{h,c}` (`pnet_df1_for_track_l2`),
  `test/test_pnet_link.c`.
- Modify: `src/net_radio.h`, `src/net_radio_cyw43.c` (`net_radio_sta_joined`).
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (`pnet_status.c` in L2 builds), `src/main.c`.
- Modify: `tools/netloop/netloop.c`, `netloop_eth.{h,c}`, `test_netloop_eth.c`, `build.sh`.

**Interfaces:**
- Consumes: Task 1's `pnet_index_now`, `pnet_go_cancel`, `stream_stop`; Task 2's `PNET_TO_AMIGA_MAX_PAYLOAD`;
  `g_link` (last taken, pico); `pnet_rle_encode`, `pnet_mfm_encode`, `pnet_checksum`.
- Produces:

```c
/* pnet_frame.h */
size_t pnet_put_hdr_to_amiga(uint8_t *s, const pnet_hdr_t *h);
pnet_err_t pnet_parse_hdr_to_amiga_as(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload, uint8_t mode);
/* pnet_status.h */
typedef struct { uint8_t mac[6]; int16_t rssi; uint8_t link; uint8_t ver_major, ver_minor; } pnet_status_t;
void   pnet_status_payload(const pnet_status_t *st, uint8_t out[PNET_STATUS_BYTES]);
size_t pnet_build_status(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, const pnet_status_t *st);
void   pnet_version_bytes(const char *v, uint8_t *major, uint8_t *minor);
/* pnet_loop.h */
typedef enum { PNET_DF1_DISK = 0, PNET_DF1_SILENT, PNET_DF1_ECHO, PNET_DF1_STATUS } pnet_df1_t;
/* pnet_link.h */
pnet_df1_t pnet_df1_for_track_l2(int want);
/* net_radio.h, WF_PNET_L2 */
bool net_radio_sta_joined(void);
/* netloop_eth.h */
const char *nl_status_problem(const uint8_t *st, size_t n, const uint8_t mac[6]);
```

  NetLoop 1.4 takes `NetLoop STATUS MAC=<mac> [ROUNDS=<n>] [SCAN=<bytes>]`.

- [ ] **Step 1: The header writer and the mode-aware parser: failing test.** In `wifi-floppy/firmware/test/test_pnet_frame.c`,
  before `int main`:

```c
/* Phase 2: cylinder 76's header is mode 2 with an RLE payload; its checksum covers the bytes sent. */
static void a_mode_2_rle_header_parses_as_mode_2_only(void) {
    uint8_t rec[4 + PNET_HDR_MFM_BYTES + 32];
    uint8_t pay[32];
    for (unsigned i = 0; i < sizeof pay; i++) pay[i] = (uint8_t)(0x81u + i);
    const pnet_hdr_t h = { .checksum = pnet_checksum(pay, sizeof pay), .data_size = 156, .compressed_size = 32,
                           .mode = 2, .compressed = 1, .amiga_ctr = 0x37, .pico_ctr = 0x81 };
    CHECK_EQ_INT(pnet_put_hdr_to_amiga(rec, &h), 4 + PNET_HDR_MFM_BYTES);
    CHECK(rec[0] == 0x44 && rec[1] == 0x89 && rec[2] == 0x44 && rec[3] == 0x89, "the sync");
    memcpy(rec + 4 + PNET_HDR_MFM_BYTES, pay, sizeof pay);
    pnet_hdr_t g;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga_as(rec + 4, sizeof rec - 4, &g, true, 2), PNET_OK);
    CHECK(g.data_size == 156 && g.compressed_size == 32 && g.compressed == 1 && g.amiga_ctr == 0x37 &&
          g.pico_ctr == 0x81, "the fields");
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(rec + 4, sizeof rec - 4, &g, true), PNET_E_MODE);   /* not cylinder 77's */
    rec[sizeof rec - 1] ^= 1u;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga_as(rec + 4, sizeof rec - 4, &g, true, 2), PNET_E_CHECKSUM);
}
```

  and `RUN(a_mode_2_rle_header_parses_as_mode_2_only);` as the last `RUN`. Run `run.sh` and expect
  `COMPILE FAIL: test_pnet_frame.c`.

- [ ] **Step 2: Implement.** In `wifi-floppy/firmware/src/pnet_frame.h`, after the `pnet_parse_hdr_to_amiga`
  declaration, add:

```c
/* As pnet_parse_hdr_to_amiga, for the given mode (2: cylinder 76's status, PaulaNET Phase 2). With
 * with_payload, the bytes checked are the bytes sent: compressed_size when h->compressed is set,
 * else data_size -- PaulaNET's driver's own rule (cylinder 77's batches from the board are never
 * compressed, so for them it is data_size, as before). */
pnet_err_t pnet_parse_hdr_to_amiga_as(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload,
                                      uint8_t mode);
/* Board side: the sync 44 89 44 89 and h, MFM-encoded (the magic set here), at s. Returns 28. */
size_t pnet_put_hdr_to_amiga(uint8_t *s, const pnet_hdr_t *h);
```

  In `wifi-floppy/firmware/src/pnet_frame.c`, replace `pnet_parse_hdr_to_amiga` with:

```c
pnet_err_t pnet_parse_hdr_to_amiga_as(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload,
                                      uint8_t mode) {
    if (len < PNET_HDR_MFM_BYTES) return PNET_E_SHORT;
    uint8_t raw[PNET_HDR_BYTES];
    pnet_mfm_decode(b, PNET_HDR_BYTES, raw);
    if (!hdr_unpack(raw, h)) return PNET_E_MAGIC;
    if (h->mode != mode) return PNET_E_MODE;
    if (!with_payload) return PNET_OK;
    const size_t sent = h->compressed ? h->compressed_size : h->data_size;
    if (sent & 1u) return PNET_E_SIZE;
    if (PNET_HDR_MFM_BYTES + sent > len) return PNET_E_SHORT;
    if (pnet_checksum(b + PNET_HDR_MFM_BYTES, sent) != h->checksum) return PNET_E_CHECKSUM;
    return PNET_OK;
}

pnet_err_t pnet_parse_hdr_to_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload) {
    return pnet_parse_hdr_to_amiga_as(b, len, h, with_payload, PNET_MODE_ETHERNET);
}

size_t pnet_put_hdr_to_amiga(uint8_t *s, const pnet_hdr_t *h) {
    s[0] = 0x44; s[1] = 0x89; s[2] = 0x44; s[3] = 0x89;
    uint8_t raw[PNET_HDR_BYTES];
    hdr_pack(h, raw);
    uint16_t last = 0;
    pnet_mfm_encode(raw, PNET_HDR_BYTES, s + 4, &last);   // MFM in this direction
    return 4u + PNET_HDR_MFM_BYTES;
}
```

  Move the new `pnet_put_hdr_to_amiga` above `pnet_build_to_amiga`, because the builder now uses it. In
  `pnet_build_to_amiga`:
  - delete the line `    s[0] = 0x44; s[1] = 0x89; s[2] = 0x44; s[3] = 0x89;`;
  - replace the four lines from `    uint8_t raw[PNET_HDR_BYTES];` to
    `    pnet_mfm_encode(raw, PNET_HDR_BYTES, s + 4, &last);   // MFM in this direction` with
    `    pnet_put_hdr_to_amiga(s, &h);`.

  The bytes are unchanged. `to_amiga_track_has_lead_in_sync_and_words` and the rest pin that.

- [ ] **Step 3: Run the tests.** Run `run.sh; echo "exit $?"` and expect `test_pnet_frame.c … 0 failed`, `exit 0`.

- [ ] **Step 4: The status record: failing test.** Create `wifi-floppy/firmware/test/test_pnet_status.c`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_status.h"
#include "../src/pnet_mfm.h"
#include <stdint.h>
#include <string.h>

/* Cylinder 76's status track, as PaulaNET's driver reads it (spec 2026-10-11 §3.1). */

static const pnet_status_t BENCH = { {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x38}, -55, 2, 1, 10 };

/* The spec's table, byte for byte, written from the table and not from pnet_status.h. */
static void expected(uint8_t e[156]) {
    memset(e, 0, 156);
    e[0] = 0x00; e[1] = 142;                  /* PaulaNETSettings.length */
    /* 2..135: SSID[34], password[66], hostname[34]: zeros */
    e[136] = 0x00; e[137] = 0x03;             /* flags: RLE both ways */
    e[138] = 0x20; e[139] = 0x00;             /* maxTxSize 8,192 */
    e[140] = 0x3F; e[141] = 0x00;             /* maxRxSize 16,128 */
    e[142] = 0x00; e[143] = 14;               /* LiveStatus.length */
    e[144] = 1; e[145] = 10;                  /* version 1.10 */
    e[146] = 0x28; e[147] = 0xcd; e[148] = 0xc1; e[149] = 0x19; e[150] = 0x6a; e[151] = 0x38;
    e[152] = 0xFF; e[153] = 0xC9;             /* RSSI -55, big-endian */
    e[154] = 2;                               /* link: associated (the driver: online) */
    e[155] = 0;                               /* reserved */
}

static void the_record_is_robs_layout_byte_for_byte(void) {
    uint8_t p[PNET_STATUS_BYTES], e[156];
    pnet_status_payload(&BENCH, p);
    expected(e);
    CHECK(memcmp(p, e, 156) == 0, "the payload");
    for (unsigned i = 0; i < 156; i++)
        if (p[i] != e[i]) { printf("  first difference at byte %u: %02x, want %02x\n", i, p[i], e[i]); break; }
}

/* A 1,024-byte read starting `bit` bits into the looping track, as Paula's DMA sees it. */
static void read_from(const uint8_t *loop, size_t bit, uint8_t *rd, size_t n) {
    for (size_t i = 0; i < n; i++) {
        const size_t b = bit / 8u + i;
        const unsigned k = (unsigned)(bit % 8u);
        const uint8_t hi = loop[b % PNET_STATUS_LOOP_BYTES], lo = loop[(b + 1u) % PNET_STATUS_LOOP_BYTES];
        rd[i] = k ? (uint8_t)((hi << k) | (lo >> (8u - k))) : hi;
    }
}

static void every_start_finds_a_record_within_124_bytes(void) {
    static uint8_t loop[PNET_STATUS_LOOP_BYTES], rd[1024];
    CHECK_EQ_INT(pnet_build_status(loop, sizeof loop, 0x37, 0x81, &BENCH), PNET_STATUS_LOOP_BYTES);
    uint8_t e[156], pay[PNET_STATUS_BYTES];
    expected(e);
    unsigned ok = 0, tried = 0;
    for (size_t bit = 0; bit < PNET_STATUS_LOOP_BYTES * 8u; bit += 3u) {   /* every byte, several bits */
        tried++;
        read_from(loop, bit, rd, sizeof rd);
        const long off = pnet_find_sync(rd, sizeof rd, 124);
        if (off < 0) continue;
        const size_t valid = pnet_shift_left(rd, sizeof rd, (size_t)off);
        pnet_hdr_t h;
        if (pnet_parse_hdr_to_amiga_as(rd, valid, &h, true, PNET_MODE_CONFIG) != PNET_OK) continue;
        if (h.data_size != 156 || h.compressed != 1 || h.amiga_ctr != 0x37 || h.pico_ctr != 0x81) continue;
        if (pnet_rle_decode(rd + PNET_HDR_MFM_BYTES, h.compressed_size, pay, sizeof pay) != 156) continue;
        if (memcmp(pay, e, 156) == 0) ok++;
    }
    CHECK_EQ_INT(ok, tried);
    pnet_hdr_t h;
    read_from(loop, 0, rd, sizeof rd);
    const long off = pnet_find_sync(rd, sizeof rd, 124);
    CHECK(off > 0, "a read from the loop's start");
    (void)pnet_shift_left(rd, sizeof rd, (size_t)off);
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(rd, sizeof rd, &h, false), PNET_E_MODE);   /* never mistaken for 77 */
}

static void the_lead_in_never_runs_short(void) {
    static const pnet_status_t odd[4] = {
        { {0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa}, -1, 2, 255, 255 },
        { {0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 0, 0, 0, 0 },
        { {0x01, 0x23, 0x45, 0x67, 0x89, 0xab}, 32767, 2, 1, 10 },
        { {0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55}, -32768, 0, 9, 99 },
    };
    static uint8_t loop[PNET_STATUS_LOOP_BYTES];
    for (unsigned i = 0; i < 4; i++) {
        CHECK_EQ_INT(pnet_build_status(loop, sizeof loop, 0, 0, &odd[i]), PNET_STATUS_LOOP_BYTES);
        unsigned lead = 0;
        while (lead < PNET_STATUS_PERIOD && loop[lead] == 0xAA) lead++;
        CHECK(lead >= PNET_STATUS_MIN_LEAD, "a lead-in of at least PNET_STATUS_MIN_LEAD bytes");
        CHECK(memcmp(loop, loop + PNET_STATUS_PERIOD, PNET_STATUS_PERIOD) == 0, "every record the same");
    }
    CHECK_EQ_INT(pnet_build_status(loop, sizeof loop - 1u, 0, 0, &BENCH), 0);   /* too small a buffer */
}

static void version_bytes_come_from_the_version_string(void) {
    uint8_t a = 9, b = 9;
    pnet_version_bytes("1.10.2+g74c2b2e", &a, &b);
    CHECK(a == 1 && b == 10, "1.10.2+g...");
    pnet_version_bytes("2.0", &a, &b);
    CHECK(a == 2 && b == 0, "2.0");
    pnet_version_bytes("1.x", &a, &b);
    CHECK(a == 0 && b == 0, "unreadable: 0.0");
    pnet_version_bytes("256.1.0", &a, &b);
    CHECK(a == 0 && b == 0, "over a byte: 0.0");
    pnet_version_bytes("", &a, &b);
    CHECK(a == 0 && b == 0, "empty: 0.0");
}

int main(void) {
    RUN(the_record_is_robs_layout_byte_for_byte);
    RUN(every_start_finds_a_record_within_124_bytes);
    RUN(the_lead_in_never_runs_short);
    RUN(version_bytes_come_from_the_version_string);
    return REPORT();
}
```

  The 156-byte record is checked against a table written out by hand. The track is decoded with our own parser from
  a read that starts at every third bit of the loop, wrap included.

- [ ] **Step 5: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_status|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_status.c`.

- [ ] **Step 6: Implement the status record.** Create `wifi-floppy/firmware/src/pnet_status.h`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_STATUS_H
#define PNET_STATUS_H
/*
 * PaulaNET Phase 2: the status track on DF1's cylinder 76, side 1, which Rob's PaulaNET.device reads
 * when it opens and every 5 s after (spec 2026-10-11 §3.1). Pure; main.c streams it. Implemented from
 * the layout in his paulanetstruct.h; no code of his.
 *
 * One record: a lead-in of AA, 44 89 44 89, the 12-byte DataHeader MFM-encoded (mode 2 "config",
 * compressed 1 = RLE, the board's counters: amiga = the last batch taken, which the driver reads as
 * its acknowledgement), then the RLE of a 156-byte payload -- PaulaNETSettings (142 bytes) and
 * LiveStatus (14), big-endian:
 *     0 length 142 | 2 SSID[34] 0 | 36 password[66] 0 | 102 hostname[34] 0 | 136 flags 3
 *   138 maxTxSize 8192 (the Amiga's batch budget) | 140 maxRxSize 16128
 *   142 length 14 | 144 version major, minor | 146 MAC[6] | 152 RSSI (int16) | 154 link | 155 0
 * The track repeats the record every PNET_STATUS_PERIOD bytes, so a read that starts at any bit finds
 * a sync STARTING within its first 124 bytes, inside the driver's scan, with no start timing at all.
 */
#include <stdint.h>
#include <stddef.h>
#include "pnet_frame.h"

#define PNET_CYL_STATUS         76
#define PNET_TRACK_STATUS       (PNET_CYL_STATUS * 2 + 1)   /* 153: side 1, the Amiga reads */
#define PNET_MODE_CONFIG        2u
#define PNET_COMPRESSED_RLE     1u
#define PNET_STATUS_BYTES       156u
#define PNET_STATUS_RLE_MAX     160u     /* >= pnet_rle_bound(156) = 159, even */
#define PNET_STATUS_PERIOD      124u     /* one record's start to the next; a multiple of 4 */
#define PNET_STATUS_RECORDS     8u
#define PNET_STATUS_LOOP_BYTES  (PNET_STATUS_PERIOD * PNET_STATUS_RECORDS)   /* 992: what DF1 loops */
#define PNET_STATUS_MIN_LEAD    16u      /* AA bytes before each sync, at the least */

/* The payload's fields (his paulanetstruct.h). */
#define PNET_ST_LENGTH          0u
#define PNET_ST_FLAGS           136u
#define PNET_ST_MAX_TX          138u
#define PNET_ST_MAX_RX          140u
#define PNET_ST_LIVE            142u
#define PNET_ST_VERSION         144u
#define PNET_ST_MAC             146u
#define PNET_ST_RSSI            152u
#define PNET_ST_LINK            154u
#define PNET_ST_SETTINGS_BYTES  142u
#define PNET_ST_LIVE_BYTES      14u
#define PNET_ST_FLAGS_RLE_BOTH  3u       /* bit 1: the Amiga sends RLE; bit 0: so does the board */
#define PNET_ST_MAX_TX_BYTES    8192u    /* never 0 or small: the driver's 16-bit space sum would wrap */
#define PNET_LINK_DOWN          0u
#define PNET_LINK_NOIP          2u       /* associated; the driver counts 1, 2, 3 and 5 as online */

typedef struct {
    uint8_t mac[6];
    int16_t rssi;                        /* dBm; 0 = not known */
    uint8_t link;                        /* PNET_LINK_* */
    uint8_t ver_major, ver_minor;
} pnet_status_t;

/* The 156-byte payload. SSID, password and hostname are always zeros. */
void pnet_status_payload(const pnet_status_t *st, uint8_t out[PNET_STATUS_BYTES]);
/* What DF1 loops: PNET_STATUS_RECORDS copies of the record, PNET_STATUS_PERIOD bytes apart, at out.
 * Returns PNET_STATUS_LOOP_BYTES, or 0 if cap is smaller or a record would leave under
 * PNET_STATUS_MIN_LEAD bytes of lead-in (it cannot: the payload's RLE is about 30 bytes). */
size_t pnet_build_status(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                         const pnet_status_t *st);
/* Major and minor from "M.m[.p][+...]" (WF_FIRMWARE_VERSION); 0, 0 when unreadable. */
void pnet_version_bytes(const char *v, uint8_t *major, uint8_t *minor);
#endif
```

  Create `wifi-floppy/firmware/src/pnet_status.c`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Implemented from the layout in his paulanetstruct.h; no code of his (see pnet_status.h). */
#include "pnet_status.h"
#include "pnet_mfm.h"
#include <string.h>

_Static_assert(PNET_STATUS_RLE_MAX >= PNET_STATUS_BYTES + PNET_STATUS_BYTES / 127u + 2u,
               "the record's RLE fits its buffer (pnet_rle_bound)");
_Static_assert(PNET_STATUS_PERIOD % 4u == 0u, "records start on DMA words");

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

void pnet_status_payload(const pnet_status_t *st, uint8_t out[PNET_STATUS_BYTES]) {
    memset(out, 0, PNET_STATUS_BYTES);
    put16(out + PNET_ST_LENGTH, PNET_ST_SETTINGS_BYTES);
    put16(out + PNET_ST_FLAGS, PNET_ST_FLAGS_RLE_BOTH);
    put16(out + PNET_ST_MAX_TX, PNET_ST_MAX_TX_BYTES);
    put16(out + PNET_ST_MAX_RX, PNET_TO_AMIGA_MAX_PAYLOAD);
    put16(out + PNET_ST_LIVE, PNET_ST_LIVE_BYTES);
    out[PNET_ST_VERSION] = st->ver_major;
    out[PNET_ST_VERSION + 1u] = st->ver_minor;
    memcpy(out + PNET_ST_MAC, st->mac, 6);
    put16(out + PNET_ST_RSSI, (uint16_t)st->rssi);
    out[PNET_ST_LINK] = st->link;
}

size_t pnet_build_status(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                         const pnet_status_t *st) {
    if (cap < PNET_STATUS_LOOP_BYTES) return 0;
    uint8_t raw[PNET_STATUS_BYTES], rle[PNET_STATUS_RLE_MAX];
    pnet_status_payload(st, raw);
    const size_t r = pnet_rle_encode(raw, sizeof raw, rle);              /* even: padded */
    const size_t body = 4u + PNET_HDR_MFM_BYTES + r;
    if (body + PNET_STATUS_MIN_LEAD > PNET_STATUS_PERIOD) return 0;
    const size_t lead = PNET_STATUS_PERIOD - body;
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(rle, r), .data_size = PNET_STATUS_BYTES, .compressed_size = (uint16_t)r,
        .mode = PNET_MODE_CONFIG, .compressed = PNET_COMPRESSED_RLE, .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    memset(out, 0xAA, lead);
    pnet_put_hdr_to_amiga(out + lead, &h);
    memcpy(out + lead + 4u + PNET_HDR_MFM_BYTES, rle, r);
    for (unsigned i = 1; i < PNET_STATUS_RECORDS; i++)
        memcpy(out + (size_t)i * PNET_STATUS_PERIOD, out, PNET_STATUS_PERIOD);
    return PNET_STATUS_LOOP_BYTES;
}

/* Decimal digits at *p, at most 255: their value (and *p moved past them), or -1. */
static int number(const char **p) {
    int v = -1;
    while (**p >= '0' && **p <= '9') {
        v = (v < 0 ? 0 : v) * 10 + (**p - '0');
        if (v > 255) return -1;
        (*p)++;
    }
    return v;
}

void pnet_version_bytes(const char *v, uint8_t *major, uint8_t *minor) {
    *major = *minor = 0;
    const int a = number(&v);
    if (a < 0 || *v != '.') return;
    v++;
    const int b = number(&v);
    if (b < 0 || (*v != '.' && *v != '+' && *v != '\0')) return;
    *major = (uint8_t)a;
    *minor = (uint8_t)b;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `test_pnet_status.c: N checks, 0 failed` and `exit 0`.

- [ ] **Step 8: Mutation proofs.** Do each, see the named test fail, then revert:
  - Swap the `PNET_ST_MAX_TX` and `PNET_ST_MAX_RX` values in the header (the Pico-side naming, correction 6):
    `the_record_is_robs_layout_byte_for_byte` fails at byte 138.
  - Set `PNET_STATUS_PERIOD` to 248 and `PNET_STATUS_RECORDS` to 4 (the same 992 bytes): then
    `every_start_finds_a_record_within_124_bytes` fails, because a read can start where the next sync is more than
    124 bytes away.

- [ ] **Step 9: Cylinder 76's tracks.** In `wifi-floppy/firmware/src/pnet_loop.h`, replace
  `typedef enum { PNET_DF1_DISK = 0, PNET_DF1_SILENT, PNET_DF1_ECHO } pnet_df1_t;` with:

```c
/* PNET_DF1_STATUS: Phase 2's cylinder 76, side 1 (pnet_df1_for_track_l2, L2 builds only). */
typedef enum { PNET_DF1_DISK = 0, PNET_DF1_SILENT, PNET_DF1_ECHO, PNET_DF1_STATUS } pnet_df1_t;
```

  In `src/pnet_link.h`, add `#include "pnet_loop.h"` after `#include "pnet_ring.h"`, and before `#endif`:

```c
/* What DF1 streams in an L2 build (Phase 2): cylinder 76 side 1 is the status track (pnet_status.h),
 * side 0 nothing -- the driver never reads it, and a disk track there would overwrite the batch
 * prepared in DF1's buffer every 5 s -- and every other track as pnet_df1_for_track. */
pnet_df1_t pnet_df1_for_track_l2(int want);
```

  In `src/pnet_link.c`, add `#include "pnet_status.h"` after `#include "pnet_link.h"`, and at the end:

```c
pnet_df1_t pnet_df1_for_track_l2(int want) {
    if (want == PNET_TRACK_STATUS) return PNET_DF1_STATUS;
    if (want == PNET_TRACK_STATUS - 1) return PNET_DF1_SILENT;
    return pnet_df1_for_track(want);
}
```

  In `test/test_pnet_link.c`, before `int main`:

```c
static void cylinder_76_is_the_status_track_in_l2(void) {
    CHECK_EQ_INT(pnet_df1_for_track_l2(153), PNET_DF1_STATUS);
    CHECK_EQ_INT(pnet_df1_for_track_l2(152), PNET_DF1_SILENT);
    CHECK_EQ_INT(pnet_df1_for_track_l2(155), PNET_DF1_ECHO);
    CHECK_EQ_INT(pnet_df1_for_track_l2(154), PNET_DF1_SILENT);
    CHECK_EQ_INT(pnet_df1_for_track_l2(150), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_wprot(76), true);                  /* 76 stays write-protected (correction 3) */
}
```

  and `RUN(cylinder_76_is_the_status_track_in_l2);` as the last `RUN`. Run `run.sh; echo "exit $?"` and expect
  `exit 0`.

- [ ] **Step 10: The radio seam.** In `wifi-floppy/firmware/src/net_radio.h`, inside the `#if WF_PNET_L2` block, after
  the `net_radio_every_ms` declaration:

```c
/** PaulaNET Phase 2: the station is associated. Any core: one word of the driver's join state, read
 *  with no lock and no bus traffic -- a stale answer is at most one status read old. */
bool net_radio_sta_joined(void);
```

  In `wifi-floppy/firmware/src/net_radio_cyw43.c`, inside its `#if WF_PNET_L2` block, after `net_radio_every_ms`:

```c
// The join state is a field the driver updates from core1; core0 reads it for cylinder 76's status
// track. CYW43_LINK_JOIN is the station associated (the SDK's name for it).
bool net_radio_sta_joined(void) {
    return cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA) == CYW43_LINK_JOIN;
}
```

- [ ] **Step 11: The build.** In `wifi-floppy/firmware/CMakeLists.txt`, in the `if (WF_PNET_L2)` block, append
  `src/pnet_status.c` to the `list(APPEND WFMF_FIRMWARE_SOURCES …)` line.

- [ ] **Step 12: `main.c`.** Every change below is under `#if WF_PNET_L2` unless it says otherwise.

(a) In the includes, after `#include "pnet_bridge.h"     //   the rings and core1's radio side`, add
  `#include "pnet_status.h"     //   Phase 2: cylinder 76's status track`.

(b) In Task 1's block above `stream_stop`, before its closing `#endif`, add:

```c
#if WF_PNET_L2
// Phase 2 (Task 4): DF1 streams cylinder 76's status loop (pnet_serve_status) from its own buffer, so
// DF1's word buffer keeps the batch the Amiga reads next on cylinder 77. dma_irq re-arms from it while
// this is set; stream_stop(1) clears it, so every other start streams `words` again.
static volatile bool g_pnet_status_live;
static uint32_t      g_pnet_status_words[PNET_STATUS_LOOP_BYTES / 4u];
#endif
```

(c) In `stream_stop`, after `    s->live = false;`, add:

```c
#if WF_PNET_L2
    if (d == 1) g_pnet_status_live = false;    // dma_irq re-arms from `words` again
#endif
```

(d) In `dma_irq`, replace `        dma_channel_set_read_addr((uint)s->dma, s->words, false);` with:

```c
#if WF_PNET_L2
        // DF1 on cylinder 76 loops the status records from their own buffer (pnet_serve_status).
        dma_channel_set_read_addr((uint)s->dma, (d == 1 && g_pnet_status_live) ? g_pnet_status_words : s->words,
                                  false);
#else
        dma_channel_set_read_addr((uint)s->dma, s->words, false);
#endif
```

(e) After `static volatile uint32_t g_pnet_last_ms;` (inside its `#if WF_PNET_L2`), add:

```c
// Phase 2: what core0 needs from core1 for cylinder 76's status track (pnet_serve_status). The MAC is
// written once by core1 after the bridge starts, then g_pnet_mac_ok, with a barrier between. The RSSI
// is core1's heartbeat sample, dBm (0 until the first).
static uint8_t          g_pnet_mac[6];
static volatile bool    g_pnet_mac_ok;
static volatile int16_t g_pnet_rssi;
```

(f) In `core1_main`, replace

```c
#if WF_PNET_L2
    pnet_bridge_start();          // the input hook and the send worker (plan 2026-10-11)
#endif
```

  with

```c
#if WF_PNET_L2
    pnet_bridge_start();          // the input hook and the send worker (plan 2026-10-11)
    net_radio_mac(g_pnet_mac);    // Phase 2: for cylinder 76's status track, published once
    __dmb();
    g_pnet_mac_ok = true;
#endif
```

(g) In core1's heartbeat, directly after the line `            g_ui_bars = rssi_bars(wifi_rssi());` (12 spaces of
  indent, the one after the comment that ends `loop reacts.`), add:

```c
#if WF_PNET_L2
            g_pnet_rssi = (int16_t)wifi_rssi();   // Phase 2: cylinder 76's RSSI, once a heartbeat
#endif
```

(h) After `static pnet_link_t g_link;`, add:

```c
// Phase 2: cylinder-76 status loops streamed, and reads of it before core1 had the MAC (ruling 10).
static uint32_t g_pnet_status_serves, g_pnet_status_early;
```

(i) The packing, shared. This one applies to every `WF_PNET_LOOP` build. Directly above the comment
  `// Builds the echo for the latest commit into track_words1 and packs it into words, with DF1's`, add:

```c
// Bytes built at w (the wire's order) repacked IN PLACE into the words the DMA reads: safe, since word
// i is written only after bytes 4i..4i+3 are read, and no later word reads a byte before 4(i+1). The
// builders pad to whole words. Returns the word count.
static uint32_t pnet_pack_words(uint32_t *w, size_t bytes) {
    const uint8_t *b = (const uint8_t *)w;
    const uint32_t n = ((uint32_t)bytes + 3u) / 4u;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t v = 0;
        for (int k = 0; k < 4; k++) v = (v << 8) | b[i * 4u + (uint32_t)k];
        w[i] = v;
    }
    return n;
}
```

  In `pnet_prepare_echo`:
  - replace the comment
    `    // Built as bytes straight into the word buffer, then repacked IN PLACE. That is safe: the`
    and the two lines after it with `    // Built as bytes straight into the word buffer, then repacked in place (pnet_pack_words).`;
  - replace the five lines from `    const uint32_t nwords = ((uint32_t)bytes + 3u) / 4u;` through its loop's closing
    `    }` with `    const uint32_t nwords = pnet_pack_words(track_words1, bytes);`.

(j) Replace `pnet_stream_prepared` (its comment and body) with the following, which applies to every `WF_PNET_LOOP`
  build:

```c
// start_streaming's DMA start for words already packed: DF1's prepared batch (track_words1), or, in L2
// builds, cylinder 76's status loop (g_pnet_status_words, which dma_irq then re-arms from).
static bool pnet_stream_words(const uint32_t *src, uint32_t nwords) {
    stream_t *s = &g_stream[1];
    stream_stop(1);
    if (s->dma < 0 || s->words != track_words1) return false;
    s->prev_revs = s->rev_count;
    s->rev_count = 0;
    s->index_traced = false;
    s->count = nwords;
#if WF_PNET_L2
    g_pnet_status_live = src != track_words1;
#endif
    const uint ch = (uint)s->dma;
    dma_channel_config c = dma_channel_get_default_config(ch);
    channel_config_set_transfer_data_size(&c, DMA_SIZE_32);
    channel_config_set_read_increment(&c, true);
    channel_config_set_write_increment(&c, false);
    channel_config_set_dreq(&c, pio_get_dreq(pio, s->sm, true));
    dma_channel_configure(ch, &c, &pio->txf[s->sm], src, s->count, true);
    dma_channel_set_irq0_enabled(ch, true);
    s->live = true;
    return true;
}

static bool pnet_stream_prepared(void) { return pnet_stream_words(track_words1, g_pnet_prepared_words); }
```

(k) Directly above `// serve_drive(1, ...) for this build: cylinder 77 is the loopback, every other track the disk.`,
  add:

```c
#if WF_PNET_L2
// Phase 2 (spec 2026-10-11 §3.1): DF1's head on cylinder 76 side 1 -- Rob's PaulaNET.device reading the
// board's status when it opens and every 5 s after. Built fresh at every arrival, so the link state is
// current, and streamed from its own buffer (g_pnet_status_live). The loop repeats one record every
// 124 bytes, so a read that starts anywhere finds a sync inside the driver's scan: no start timing
// applies here (plan ruling 7). Nothing streams before core1 has published the MAC -- the driver keeps
// the MAC it reads at open -- so a too-early open fails, visibly, and is counted (ruling 10).
static void pnet_serve_status(void) {
    if (!g_pnet_mac_ok) { g_pnet_status_early++; return; }
    __dmb();                                     // the MAC's bytes were written before the flag
    pnet_status_t st;
    memset(&st, 0, sizeof st);
    memcpy(st.mac, g_pnet_mac, sizeof st.mac);
    st.rssi = g_pnet_rssi;
    st.link = net_radio_sta_joined() ? PNET_LINK_NOIP : PNET_LINK_DOWN;
    pnet_version_bytes(WF_FIRMWARE_VERSION, &st.ver_major, &st.ver_minor);
    if (pnet_build_status((uint8_t *)g_pnet_status_words, sizeof g_pnet_status_words,
                          g_link.last_amiga, g_link.pico, &st) == 0) {
        wf_logf(WF_ERR, "pnet: the status record does not fit its %u-byte period -- not served",
                (unsigned)PNET_STATUS_PERIOD);
        return;
    }
    const uint32_t n = pnet_pack_words(g_pnet_status_words, PNET_STATUS_LOOP_BYTES);
    if (!pnet_stream_words(g_pnet_status_words, n)) return;
    g_pnet_echo_live = true;                     // the short INDEX at each wrap, as on cylinder 77
    g_pnet_last_ms = clock_ms() | 1u;            // cylinder 76 is network use too (the OTA rule)
    g_pnet_status_serves++;
    pnet_index_now();
}
#endif
```

  The buffer is rebuilt only while nothing streams it: `pnet_serve_df1` has already called `stream_stop(1)`, which
  cleared `g_pnet_status_live`.

(l) In `pnet_serve_df1`, replace `    const pnet_df1_t act = pnet_df1_for_track(want);` with:

```c
#if WF_PNET_L2
    const pnet_df1_t act = pnet_df1_for_track_l2(want);   // Phase 2: cylinder 76 as well
#else
    const pnet_df1_t act = pnet_df1_for_track(want);
#endif
```

  Replace `    if (act == PNET_DF1_ECHO && want == *loaded && g_pnet_echo_live && !gpio_get(PIN_SEL1) &&` with
  `    if ((act == PNET_DF1_ECHO || act == PNET_DF1_STATUS) && want == *loaded && g_pnet_echo_live && !gpio_get(PIN_SEL1) &&`.
  After `    if (act == PNET_DF1_SILENT) return;          // side 0: the Amiga writes, nothing to read`, add:

```c
#if WF_PNET_L2
    if (act == PNET_DF1_STATUS) { pnet_serve_status(); return; }
#endif
```

(m) In `pnet_l2_log`, add `+ g_pnet_status_serves + g_pnet_status_early` to `sum`, and after the
  `pnet: l2 amiga … heap` line, add:

```c
    // Phase 2: cylinder 76 -- loops streamed, reads before the MAC was known, and what it tells the driver.
    wf_logf(WF_INFO, "pnet: l2 status %lu early %lu link %s rssi %d",
            (unsigned long)g_pnet_status_serves, (unsigned long)g_pnet_status_early,
            net_radio_sta_joined() ? "up" : "DOWN", (int)g_pnet_rssi);
```

- [ ] **Step 13: Build, measure the SRAM, check identity, run the tests**

  `build-pnet2` still holds Task 3's image, because Steps 1-12 build nothing. So measure it first:

```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
arm-none-eabi-size -A build-pnet2/wifi_floppy.elf | grep -E '^\.(bss|data) '   # before: Task 3's build
```

  Then run Task 1 Step 13's commands, then `arm-none-eabi-size -A build-pnet2/wifi_floppy.elf | grep -E '^\.(bss|data) '`
  again.
  Expected:
  - no warnings, three `identical` lines, `exit 0`;
  - `.bss` grows by about 1,000 bytes (the 992-byte buffer and the counters);
  - `cmake --build build-pnet2` passes the 768-byte frame limit.

  Record the delta for Task 7.

- [ ] **Step 14: NetLoop `STATUS`: failing host test.** In `tools/netloop/test_netloop_eth.c`:
  - after `#include "pnet_sort.h"`, add `#include "pnet_status.h"`, `#include "pnet_mfm.h"`, `#include "pnet_frame.h"`
    and `#include "netloop_stats.h"` (for `NL_DRIVER_SCAN`, a macro only, so nothing more to link);
  - before `printf("%s: %s\n", __FILE__, …);`, add:

```c
    /* Phase 2: the board's own status track passes NetLoop's check, read as the driver reads it. */
    {
        static uint8_t loop[PNET_STATUS_LOOP_BYTES], rd[1024], st[PNET_STATUS_BYTES];
        static const uint8_t bm[6] = {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x38};
        pnet_status_t s76 = { {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x38}, -55, PNET_LINK_NOIP, 1, 10 };
        CHECK(pnet_build_status(loop, sizeof loop, 1, 2, &s76) == PNET_STATUS_LOOP_BYTES, "status built");
        for (size_t i = 0; i < sizeof rd; i++) rd[i] = loop[(i + 37u) % PNET_STATUS_LOOP_BYTES];
        const long off = pnet_find_sync(rd, sizeof rd, NL_DRIVER_SCAN);
        CHECK(off >= 0, "status sync");
        const size_t valid = off >= 0 ? pnet_shift_left(rd, sizeof rd, (size_t)off) : 0;
        pnet_hdr_t h;
        CHECK(pnet_parse_hdr_to_amiga_as(rd, valid, &h, 1, PNET_MODE_CONFIG) == PNET_OK, "status header");
        CHECK(pnet_rle_decode(rd + PNET_HDR_MFM_BYTES, h.compressed_size, st, sizeof st) == (long)PNET_STATUS_BYTES,
              "status payload");
        CHECK(nl_status_problem(st, sizeof st, bm) == NULL, "the board's status passes");
        static const uint8_t other[6] = {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x39};
        CHECK(nl_status_problem(st, sizeof st, other) != NULL, "a different MAC does not");
        st[PNET_ST_LINK] = PNET_LINK_DOWN;
        CHECK(nl_status_problem(st, sizeof st, bm) != NULL, "nor does a link that is down");
    }
```

  In `tools/netloop/build.sh`, change the `test_netloop_eth` compile line's sources to
  `"$here/test_netloop_eth.c" "$here/netloop_eth.c" "$fw/pnet_sort.c" "$fw/pnet_status.c" "$fw/pnet_frame.c" "$fw/pnet_mfm.c"`.
  Run `tools/netloop/build.sh test` and expect a compile error for `nl_status_problem`.

- [ ] **Step 15: Implement NetLoop `STATUS`.**

(a) In `tools/netloop/netloop_eth.h`, before `#endif`:

```c
/* Phase 2: the board's status record (cylinder 76, its 156 decoded bytes). NULL when it is what
 * PaulaNET's driver needs -- lengths 142 and 14, flags 3, a batch budget of 8,192, the board's `mac`,
 * link up -- else what is wrong. */
const char *nl_status_problem(const uint8_t *st, size_t n, const uint8_t mac[6]);
```

  In `tools/netloop/netloop_eth.c`, add `#include "pnet_status.h"` after `#include "netloop_eth.h"`, and at the end:

```c
const char *nl_status_problem(const uint8_t *st, size_t n, const uint8_t mac[6]) {
    if (n < PNET_STATUS_BYTES) return "short";
    if (get16(st + PNET_ST_LENGTH) != PNET_ST_SETTINGS_BYTES) return "settings length";
    if (get16(st + PNET_ST_LIVE) != PNET_ST_LIVE_BYTES) return "status length";
    if (get16(st + PNET_ST_FLAGS) != PNET_ST_FLAGS_RLE_BOTH) return "flags";
    if (get16(st + PNET_ST_MAX_TX) != PNET_ST_MAX_TX_BYTES) return "batch budget";
    if (memcmp(st + PNET_ST_MAC, mac, 6) != 0) return "MAC";
    if (st[PNET_ST_LINK] != PNET_LINK_NOIP) return "link down";
    return NULL;
}
```

(b) In `tools/netloop/netloop.c`:
  - Add `#include "pnet_status.h"` after `#include "netloop_eth.h"`.
  - Add the usage line `NetLoop STATUS MAC=<board mac> [ROUNDS=<n>] [SCAN=<bytes>]   (Phase 2: cylinder 76, as PaulaNET's driver reads it)`
    to the header comment.
  - Change the version to `1.4` in both the `$VER` string and the banner.
  - After `run_arp`, add:

```c
/* ---- Phase 2: cylinder 76, the board's status track ------------------------------------------ */
static unsigned long c_st_reads, c_st_nosync, c_st_bad, st_lo = ~0ul, st_hi;
static uint8_t st_rec[PNET_STATUS_BYTES];

/* One read of cylinder 76 side 1 as PaulaNET's driver reads it at open and every 5 s: 1,024 bytes
 * with INDEXSYNC, the sync within the first sync_scan bytes, a mode-2 header, the RLE record. NULL
 * when st_rec holds a record that passes nl_status_problem, else what failed. */
static const char *status_once(void) {
    c_st_reads++;
    if (td_io(ETD_RAWREAD, IOTDF_INDEXSYNC, rbuf, HDR_READ, PNET_TRACK_STATUS)) { c_ioerr++; return "read error"; }
    const long off = pnet_find_sync(rbuf, HDR_READ, sync_scan);
    if (off < 0) { c_st_nosync++; return "no sync"; }
    const unsigned long at = ((unsigned long)off - 32u) >> 3;      /* where the sync starts */
    if (at < st_lo) st_lo = at;
    if (at > st_hi) st_hi = at;
    const size_t valid = pnet_shift_left(rbuf, HDR_READ, (size_t)off);
    pnet_hdr_t h;
    if (pnet_parse_hdr_to_amiga_as(rbuf, valid, &h, TRUE, PNET_MODE_CONFIG) != PNET_OK ||
        h.compressed != PNET_COMPRESSED_RLE || h.data_size != PNET_STATUS_BYTES ||
        pnet_rle_decode(rbuf + PNET_HDR_MFM_BYTES, h.compressed_size, st_rec, sizeof st_rec) !=
            (long)PNET_STATUS_BYTES) {
        c_st_bad++;
        return "bad record";
    }
    return nl_status_problem(st_rec, sizeof st_rec, l2_mac);
}

/* `rounds` status reads, each with the driver's three tries, each followed by one cylinder-77 exchange
 * (the driver goes straight back to 77). PASS: every status read decoded and passed. */
static int run_status(UBYTE *ctr, UBYTE *last_pico, ULONG rounds) {
    unsigned long ok = 0, acked = 0;
    const char *last_why = NULL;
    for (ULONG i = 0; i < rounds; i++) {
        if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { printf("*** Break\n"); break; }
        const char *why = "no read";
        for (int r = 0; r < 3 && why; r++) why = status_once();
        if (why) last_why = why;
        else if (ok++ == 0) {
            const uint8_t *m = st_rec + PNET_ST_MAC;
            printf("status: MAC %02x:%02x:%02x:%02x:%02x:%02x link %u rssi %d dBm version %u.%u flags %u budget %u B\n",
                   m[0], m[1], m[2], m[3], m[4], m[5], (unsigned)st_rec[PNET_ST_LINK],
                   (int)(int16_t)((st_rec[PNET_ST_RSSI] << 8) | st_rec[PNET_ST_RSSI + 1u]),
                   (unsigned)st_rec[PNET_ST_VERSION], (unsigned)st_rec[PNET_ST_VERSION + 1u],
                   (unsigned)((st_rec[PNET_ST_FLAGS] << 8) | st_rec[PNET_ST_FLAGS + 1u]),
                   (unsigned)((st_rec[PNET_ST_MAX_TX] << 8) | st_rec[PNET_ST_MAX_TX + 1u]));
        }
        if (l2_exchange(ctr, last_pico, NULL, 0u, NULL, NULL) != 2) acked++;
    }
    printf("status: %lu/%lu read; %lu reads, nosync %lu bad %lu; sync starts at byte %lu..%lu (scan %lu)\n",
           ok, (unsigned long)rounds, c_st_reads, c_st_nosync, c_st_bad, st_lo == ~0ul ? 0ul : st_lo, st_hi,
           (unsigned long)sync_scan);
    printf("cylinder 77 right after: %lu/%lu exchanges acknowledged (information)\n", acked, (unsigned long)rounds);
    if (last_why) printf("last failure: %s\n", last_why);
    const BOOL pass = ok == rounds;
    printf("RESULT: %s\n", pass ? "PASS" : "FAIL");
    return pass ? RETURN_OK : RETURN_WARN;
}
```

  - In `main`:
    - `LONG args[12]` becomes `LONG args[13]`, and `,STATUS/S` is appended to the template.
    - After `const BOOL do_arp = …, do_dhcp = …;`, add `const BOOL do_status = args[12] != 0;`.
    - Directly before `FreeArgs(rd);` (after Task 1's `SCAN` block), add
      `if (do_status && !args[11]) sync_scan = NL_DRIVER_SCAN;   /* the driver's own window */`.
    - In the `rounds` default, `(do_arp || do_dhcp)` becomes `(do_arp || do_dhcp || do_status)`. Make the same
      change in the `MAC=` check, whose message becomes `"ARP, DHCP and STATUS need MAC=<the board's MAC>, as its boot log prints it\n"`,
      and in the `resync(…, do_arp || do_dhcp)` and `if (do_arp || do_dhcp) l2_drain(…)` lines.
    - After `if (do_dhcp) { rc = run_dhcp(&ctr, &last_pico); goto out; }`, add
      `if (do_status) { rc = run_status(&ctr, &last_pico, rounds); goto out; }`.

(c) In `tools/netloop/build.sh`'s `A="…"` list, add
  ` -Dpnet_put_hdr_to_amiga=pnet_put_hdr_to_amiga_allc -Dpnet_parse_hdr_to_amiga_as=pnet_parse_hdr_to_amiga_as_allc`.
  `pnet_status.c` is not linked into the 68000 binary: NetLoop uses its header's constants only.

- [ ] **Step 16: Build NetLoop 1.4**

Run: `tools/netloop/build.sh`
Expected:
- `test_netloop_eth.c: ok` (the status block included);
- three `RESULT: PASS` lines;
- `NetLoop.adf` listed.

  Then `cp tools/netloop/build/NetLoop.adf ~/Downloads/NetLoop-1.4.adf`.

- [ ] **Step 17: The new and changed tests under Linux GCC** (CI's compiler). From the worktree root:

```bash
docker run --rm -v "$PWD/wifi-floppy/firmware":/fw -w /fw/test gcc:13 bash -c '
  for t in test_pnet_frame test_pnet_link test_pnet_loop test_pnet_status test_pnet_ring; do
    gcc -std=c11 -D_DEFAULT_SOURCE -O1 -pthread -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 -o /tmp/$t $t.c \
      ../src/pnet_frame.c ../src/pnet_mfm.c ../src/pnet_link.c ../src/pnet_ring.c ../src/pnet_loop.c \
      ../src/pnet_status.c && /tmp/$t || exit 1
  done; echo GCC-OK'
```

Expected: five `… 0 failed` lines, then `GCC-OK`.

- [ ] **Step 18: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/pnet_frame.h wifi-floppy/firmware/src/pnet_frame.c wifi-floppy/firmware/src/pnet_status.h \
  wifi-floppy/firmware/src/pnet_status.c wifi-floppy/firmware/src/pnet_loop.h wifi-floppy/firmware/src/pnet_link.h \
  wifi-floppy/firmware/src/pnet_link.c wifi-floppy/firmware/src/net_radio.h wifi-floppy/firmware/src/net_radio_cyw43.c \
  wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/test/test_pnet_frame.c \
  wifi-floppy/firmware/test/test_pnet_status.c wifi-floppy/firmware/test/test_pnet_link.c \
  tools/netloop/netloop.c tools/netloop/netloop_eth.h tools/netloop/netloop_eth.c tools/netloop/test_netloop_eth.c \
  tools/netloop/build.sh
git commit -m "feat(fw,netloop): PaulaNET cylinder 76 -- the status track Rob's driver reads; NetLoop STATUS

Side 1 loops eight identical mode-2 RLE records, 124 bytes apart, from a buffer of their own: any
read finds a sync inside the driver's scan, and DF1's buffer keeps the cylinder-77 batch. Side 0 is
silent; 76 stays write-protected. MAC from core1 (nothing streams before it), link from the radio's
join state, RSSI from the heartbeat. NetLoop 1.4: STATUS reads 76 as the driver does.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Publish the TEST build, install it, and get NetLoop 1.4 onto the bench

**Files:** none changed. This task produces a registry entry, an install, and NetLoop 1.4 in `SYS:C`.

**Interfaces:**
- Consumes: Tasks 1-4. The image comes from the worktree's `build/`, because `firmware-release.ts` reads only that
  directory.
- Produces:
  - the board running `1.10.2+g<hash>` with `pnet: L2 sharing on` and the Task 1 timing;
  - the board's MAC and IP;
  - NetLoop 1.4 on the Amiga;
  - the offline `SELFTEST` timings (ruling 17).

- [ ] **Step 1: Build the TEST image in `build/`** from a clean, committed tree:

```bash
git status --short     # nothing under wifi-floppy/ or tools/
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
      -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=ON && cmake --build build
strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test        # 1
strings build/wifi_floppy.bin | grep -c 'L2 sharing on'           # 1
strings build/wifi_floppy.bin | grep -c 'status record does not fit'   # 1
grep WF_FIRMWARE_VERSION build/generated/wifi_floppy_version.h
```

Expected: `1`, `1`, `1`, and a version `1.10.2+g<hash>` with no `+dirty` and no `+nogit`.

- [ ] **Step 2: Dry run, then publish.** From the worktree root:

```bash
pnpm firmware:publish --dry-run --no-github --notes "TEST build: PaulaNET Phase 2 -- Rob's PaulaNET.device: cylinder 76 status, always-take, 16,128-byte cap, timed side-1 start (bench only; never a release)"
pnpm firmware:publish --no-github --notes "TEST build: PaulaNET Phase 2 -- Rob's PaulaNET.device: cylinder 76 status, always-take, 16,128-byte cap, timed side-1 start (bench only; never a release)"
```

  Expected: the dry run refuses nothing, and the publish prints a sequence above spike B's and
  `GitHub release skipped (--no-github)`. Record the sequence.

- [ ] **Step 3: Put `build/` back to a release configuration at once:**

```bash
cd wifi-floppy/firmware && cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=OFF && cmake --build build >/dev/null \
  && strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test
```

Expected: `0`.

- [ ] **Step 4: Operator, one step: switch the A500 OFF.** End the turn asking for exactly that.

- [ ] **Step 5: Install.**
  - Make sure the serial logger runs (Global Constraints).
  - From `/Users/sfs/Devel/webadf`, run `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '<version from Step 1>'`,
    and say in the conversation that an install was triggered.
  - Expected in the log after the reboot:
    - `wf-pnet-loop-test: DF1 cylinder 77 is a PaulaNET loopback (bench only)`;
    - `pnet: side-1 lead-in 120 B, side-return start 2360 us after SIDE`, or the values the gate settled on;
    - `pio claims: radio on pio2`;
    - `pnet: L2 sharing on (TEST build), MAC <mac>`: record the MAC (3bh: 28:cd:c1:19:6a:38);
    - `associated, default route w00 ip=<board ip>`: record it;
    - the first `heap: free low-water` line: record it (the baseline for acceptance 7);
    - no `not backed by PSRAM`, and no `no send worker`.
  - The Devices card shows the TEST version.

- [ ] **Step 6: Operator, one step: switch the A500 on, then NetLoop 1.4.**
  - Switch on, and let Workbench boot from the IDE drive.
  - Upload `~/Downloads/NetLoop-1.4.adf` on the Library page, and press **Mount** for the board.
  - In a Shell, run `copy df0:NetLoop SYS:C/`, then `NetLoop SELFTEST`.
  - PASS: the banner says `NetLoop 1.4`, and the last line is `RESULT: PASS`.
  - Also read out the `selftest: … align … ms, parse … ms` and `equivalence ok (… ms)` lines. These are the offline
    timings for ruling 17.

---

### Task 6: The Amiga side: Rob's driver, the interface file, and cylinder 76 checked as his driver reads it

**Files:** none in the repository. The Amiga's IDE Workbench gains `DEVS:Networks/PaulaNET.device` and
`DEVS:NetInterfaces/eth0`.

**Interfaces:**
- Consumes: Task 5's board (its MAC), and the rebuilt ADF at
  `/private/tmp/claude-501/-Users-sfs-Devel-webadf/fa1f7997-11c2-4c01-a121-0f34f0567b3c/scratchpad/rob/adf/paulanet.adf`.
  It is rebuilt from `Pico/PaulaNET/DiskImage.cpp` at `0afd5fa`: FFS, 12.06.2026, holding `PaulaNET.device`
  (13,872 bytes) and `PaulaNET Config`.
- Produces: the driver installed, `eth0` configured, and a `NetLoop STATUS` verdict on cylinder 76.

- [ ] **Step 1: The ADF, where the operator's browser can reach it** (no operator step):

```bash
A=/private/tmp/claude-501/-Users-sfs-Devel-webadf/fa1f7997-11c2-4c01-a121-0f34f0567b3c/scratchpad/rob/adf/paulanet.adf
shasum -a 256 "$A"        # d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0
xdftool "$A" list | grep -E 'PaulaNET.device +13872'
cp "$A" ~/Downloads/paulanet-0afd5fa.adf
```

  If the file is gone (`/private/tmp` does not survive a reboot) or the digest differs, stop, and ask the operator.
  Never rebuild it from a source that has not been read. The ADF is never committed (Global Constraints).

- [ ] **Step 2: Operator, one step: what is already configured.** In a Shell, run:

```
list DEVS:NetInterfaces
list DEVS:Networks
search S:User-Startup Network-Startup
```

  Report or photograph the output. Expected: no `eth0` in `DEVS:NetInterfaces`, and no `Network-Startup` line in
  `S:User-Startup` (the AmiTCP_NG installer does not add one).
  - If either `eth0` already exists or `Network-Startup` runs at boot, stop, and ask the operator.
    `Network-Startup` brings up every file in `DEVS:NetInterfaces`, so a second interface on another device would
    confuse every step below.
  - If `DEVS:Networks` does not exist, Step 3 creates it.

- [ ] **Step 3: Operator, one step: install the driver.**
  - Upload `~/Downloads/paulanet-0afd5fa.adf` on the Library page, and press **Mount** for the board. DF0 now holds
    "PaulaNET", and DF1 is empty.
  - In a Shell, run (the `makedir` only if Step 2 found no `DEVS:Networks`):

```
makedir DEVS:Networks
copy "DF0:PaulaNET.device" DEVS:Networks/
list DEVS:Networks/PaulaNET.device
echo >DEVS:NetInterfaces/eth0 "device=PaulaNET.device"
echo >>DEVS:NetInterfaces/eth0 "unit=0"
echo >>DEVS:NetInterfaces/eth0 "configure=dhcp"
type DEVS:NetInterfaces/eth0
```

  - PASS: `list` shows `PaulaNET.device` at 13872 bytes, and `type` prints exactly the three lines
    `device=PaulaNET.device`, `unit=0`, `configure=dhcp`. The driver serves only unit 0 (`device.c:166`).

- [ ] **Step 4: Operator, one step: give DF1 its disk again.** On the web, mount the Workbench 3.1 set's disk 1 on
  DF0. Wait about 10 s, then run `info`. PASS: DF1 is listed (Storage3.1). His driver checks for a disk in DF1 at
  open (`TD_CHANGESTATE`, `pnio:638-653`).

- [ ] **Step 5: Operator, one step: cylinder 76 as his driver reads it.** Run
  `NetLoop STATUS MAC=<the MAC from Task 5 Step 5> ROUNDS=200`.
  - PASS:
    - `status: MAC <that MAC> link 2 rssi <n> dBm version 1.10 flags 3 budget 8192 B`;
    - `status: 200/200 read; … nosync 0 bad 0; sync starts at byte a..b (scan 124)`;
    - `RESULT: PASS`.
  - Record `a..b` and the `cylinder 77 right after:` line. That line is information only: it shows whether the
    board's start after a step back onto 77 suits a header read (Open question 2).
  - FAIL with `last failure: MAC` means a wrong `MAC=`. Check the boot line and run it again.
  - FAIL with `link down` while the Devices card says online: stop and report it. `net_radio_sta_joined` would then
    disagree with the board's own state.

---

### Task 7: Bench acceptance (spec §5), and the record

**Files:**
- Modify: `HANDOFF.md`: a new section `### 3bi. …` directly above `### 3bh.`, and the backlog's "Amiga networking over
  the floppy port" entry.

**Interfaces:**
- Consumes: Tasks 5-6, the serial log, and Task 1's spike numbers from the SDD ledger.
- Produces: the seven acceptance verdicts, the measured rates, the heap low-water, the record, and the operator's next
  decision.

Every operator step below is one turn. Steps 2-7 run with `eth0` up. NetLoop is not run again until a reboot has
taken `eth0` down (Global Constraints).

- [ ] **Step 1: The FTP server for items 4-5** (no operator step). From the worktree, with `S` = this session's
  scratchpad directory:

```bash
python3 -m venv "$S/ftpvenv" && "$S/ftpvenv/bin/pip" install pyftpdlib==1.5.10
mkdir -p "$S/ftproot" && head -c 204800 /dev/urandom > "$S/ftproot/t200k.bin" && ls -l "$S/ftproot/t200k.bin"
MAC_IP=$(ipconfig getifaddr en0); echo "$MAC_IP"
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
```

  Then start the server in the background (record its PID; it is the only process this task may stop):
  `"$S/ftpvenv/bin/python" -I -m pyftpdlib -i "$MAC_IP" -p 2121 -d "$S/ftproot" -r 60000-60100 >>"$S/ftpd.log" 2>&1`.
  Check it from this Mac with `curl -s --max-time 5 "ftp://$MAC_IP:2121/" | head -3`, which should list `t200k.bin`.
  If the firewall is enabled, macOS may ask to allow incoming connections for Python. That click is folded into
  Step 5's request.

- [ ] **Step 2: Operator, one step: acceptance 1, the stack comes online.** In a Shell:

```
AddNetInterface eth0
ShowNetStatus
ShowNetStatus INTERFACE eth0
```

  - PASS:
    - `AddNetInterface` returns without an error;
    - `ShowNetStatus` shows `eth0` up with an address from the router;
    - that address differs from the board's (Task 5 Step 5).
  - Record the address, the router and the DNS server.
  - Also watch the log for one `pnet: l2 status N early 0 link up …` line. `N` grows once at open, then about every
    5 s.
  - If it fails with no address: wait 30 s and run `ShowNetStatus` once more in the same turn. A DHCP OFFER from this
    router took about 1 s in Phase 1.

- [ ] **Step 3: Operator, one step: the busy-poll cost (spec §6, information only).** Run `NetLoop SELFTEST` (it does
  not touch DF1). Record the same lines as Task 5 Step 6. Their ratio to the offline timings is the CPU share his
  driver's priority-1 poll leaves a priority-0 task. Also ask the operator one question: does the mouse pointer and
  Workbench feel usable?

- [ ] **Step 4: Operator, one step: acceptance 2 and 3.** Run:

```
ping -c 10 <the router from Step 2>
ping -c 10 8.8.8.8
nslookup amiga.org
```

  PASS: both pings print replies with 0% loss (or at most 1 lost of 10), and `nslookup` prints an address. Record
  each ping's `min/avg/max` line.

- [ ] **Step 5: Operator, one step: acceptance 4, a 200 KB transfer.** If Step 1 found the firewall enabled, first
  click **Allow** on any macOS dialog about Python. Then run `ftp GET <MAC_IP> t200k.bin RAM:t200k PORT 2121` and
  `list RAM:t200k`.
  - PASS: `ftp: received 204800 bytes into RAM:t200k`, and `list` shows 204800 bytes.
  - Then read the server's log: `grep RETR "$S/ftpd.log" | tail -1` shows `bytes=204800 seconds=<s>`.
    KB/s = 200 / s. Record it.

- [ ] **Step 6: Operator, one step: acceptance 5, the same transfer while DF0 writes.** Open a second Shell. Type
  `ftp GET <MAC_IP> t200k.bin RAM:t200k2 PORT 2121` in one, and `copy c:dir df0:pnettest` in the other, then press
  Return in both, about at once.
  - PASS:
    - `ftp: received 204800 bytes into RAM:t200k2`;
    - the copy completes with no requester;
    - every board `write: trk … ALL bad 0 …` line in this window is followed by `applied`.
  - Record the transfer's seconds from the server log, and the `pnet: lost N batches to DF0 writes` lines (a loss is
    allowed, because his driver resends; record it).

- [ ] **Step 7: Operator, one step: acceptance 6, after Ctrl-A-A.** Press Ctrl-A-A. Once Workbench is back:

```
AddNetInterface eth0
ShowNetStatus
ping -c 3 <the router>
```

  PASS: `eth0` is up again with an address (the same lease is likely), and the pings reply. The board kept its
  counters through the reset; spec §6's 1-in-256 first-batch loss is accepted and would show only as one lost frame.

- [ ] **Step 8: Read the serial log: acceptance 7** (no operator step).
  - First run `grep -c 'records dropped' <log>`. A log that dropped records proves no absence.
  - Then record:
    - **the heap:** the lowest `heap` in the `pnet: l2 amiga …` lines and the lowest `heap: free low-water` line.
      Both must be at least 20,480 B; below that, stop and report;
    - **no lock-up:**
      - the `pnet: rx … new …` counts keep growing to the end;
      - `pnet: l2 from amiga new` grows through Steps 4-7;
      - the Devices card stayed online;
      - nothing went quiet for more than 10 s while `eth0` was up;
    - **every drop counted:**
      - `pnet: l2 in … drop` (the RX ring);
      - `pnet: l2 from amiga … over … bad`;
      - the `pnet: l2 tx no len/mac/type/clash` reasons and `err`;
      - the `pnet: bad …` and `refused` lines.
      A drop is allowed. A drop with no counter is not: compare `rounds` of traffic against the counts;
    - **the timing in the product path:** the `pnet: go at … delayed … late …` lines (`late` per 1,000 side
      returns), and `side-idx min/max`;
    - **cylinder 76:** `pnet: l2 status N early E link up rssi R`. `E` should be 0 unless the Amiga opened the driver
      before the board had associated;
    - `clash`, `SAME` or `distinct` in the `l2 amiga` lines, and whether `fw: update held` ever appeared (it should
      not: no update was offered).
  - Stop the FTP server by the PID recorded in Step 1 (and only that PID).

- [ ] **Step 9: Record in `HANDOFF.md`.** Add
  `### 3bi. PaulaNET Phase 2 (Rob's PaulaNET.device) -- TEST build <version>, seq <n>: <PASSED / FAILED at item N> on the A500 (<date>)`
  directly above `### 3bh.`, containing:
  - the bench (A500 PAL, KS 3.1, Workbench 3.1 + AmiTCP_NG v4.1.8 on IDE, his driver from `0afd5fa`, NetLoop 1.4,
    DF0/DF1 disks);
  - the spike (Task 1):
    - spike A's miss shares per read kind (N=64, N=8000);
    - spike B's sync start range, both gate runs, `late`, `side-idx`;
    - the constants kept;
  - a table of acceptance 1-7 as PASS or FAIL with their numbers (lease, both pings, nslookup, KB/s alone and during
    the DF0 copy, Ctrl-A-A, heap baseline and low-water);
  - the `NetLoop STATUS` line, and the busy-poll timings (online against offline);
  - the log counts of Step 8;
  - the SRAM delta of Task 4 Step 13;
  - this plan's rulings 1-18 and "Corrections to the spec" 1-7, one line each, plus every ruling and deviation made
    during execution (the SDD ledger);
  - the open questions below, with what the bench answered;
  - the off switch and the rollback (Step 11).

  Then, in the backlog's "Amiga networking over the floppy port" entry, append
  `**Phase 2 <PASSED / FAILED at item N> <date> (3bi): AmiTCP_NG online through Rob's unmodified PaulaNET.device, <KB/s> KB/s.**`

- [ ] **Step 10: Commit the record**

```bash
git add HANDOFF.md
git commit -m "HANDOFF 3bi: PaulaNET Phase 2 on the A500 -- <verdict in five words>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Off switch, rollback, and the next question.** Tell the operator all three, then ask the question as
  the turn's last thing.
  - **Off at runtime:** on the Amiga, reboot without running `AddNetInterface eth0`. On the board, set DF1 to Off on
    the card: every Phase 2 path needs DF1 on with a disk.
  - **Rollback:** the registry refuses a lower sequence, so leaving this TEST build needs a release at a higher one.
    The release image is unchanged by Phase 2 (ruling 1). That release is master (with this branch merged or not)
    built with both options OFF, as 1.10.3. The operator decides when.
  - The question: "Phase 2 <passed / failed at item N>. Merge `feat/paulanet-phase2` (TEST-only code; the release
    image is unchanged) and plan Phase 3 -- the Off/Disk/Network setting, the driver disk with Rob's written grant
    under docs/, live switching -- and cut 1.10.3 to take the board off TEST?"

---

## Open questions (not settled by the code or the spec)

1. **Why the Amiga's read DMA starts 2.4-4.2 ms after a SIDE edge** (HANDOFF §3bg), and whether trackdisk honours
   INDEXSYNC at all on a side return. The spike measures the result, not the cause.
   - If INDEXSYNC is honoured, the start's INDEX (or the next wrap) lands the sync at about byte 117 instead. That
     is still inside 124, so either cause passes.
   - The Kickstart 3.1 ROM in `docs/` could answer it by disassembly, if the gate fails in a way the numbers cannot
     explain.
2. **Reads of cylinder 77 that follow a step from 76 rather than a SIDE edge start at once** (ruling 5), and their
   timing is unmeasured.
   - His driver goes 76 → 77 side 1 every 5 s. The worst case is one retried header read per 5 s.
   - `NetLoop STATUS`'s "cylinder 77 right after" line measures it (Task 6 Step 5) without gating it.
3. **AmiTCP_NG's own DHCP and ARP through the sorter** (HANDOFF §3bh open question 5). NetLoop's hand-made frames
   passed. AmiTCP_NG may set the broadcast flag, ARP-probe its new address, or fall back to RFC 3927 link-local.
   Acceptance 1 answers it.
4. **Rob's written grant under `docs/`** is still owed (HANDOFF backlog). Phase 2 copies his driver onto one bench
   Amiga from his public source and redistributes nothing. Phase 3's driver disk needs the grant first (spec §4).
5. **Whether the bench Mac's firewall lets the FTP server in.** It is logistics, not the product, but acceptance 4-5
   depend on it (Task 7 Step 1).
6. **RSSI staleness:** up to one heartbeat (60 s) old, and 0 before the first. The driver only logs it (ruling 11).

## Self-review (done while writing this plan)

1. **Spec coverage:**
   - §3.4: spike first, then the gate and the constants: Task 1, rulings 3-6. The stop-and-ask on failure is Task 1
     Step 33.
   - §3.3: the cap, its host test, and the off-identical effect: Task 2, correction 4.
   - §3.2: always take, drops counted, 21-255 frames, the ring overflow: Task 3. The size refusal is corrected
     (corrections 1-2).
   - §3.1: the 156-byte payload byte for byte, mode 2 RLE, both counters, never delivering or freeing a batch
     (`pnet_serve_status` touches neither ring), the link state, RSSI or 0, and writes to 76: Task 4, rulings 7-11,
     correction 3.
   - §4: the ADF, `DEVS:Networks`, the `eth0` file, unit 0: Task 6.
   - §5 items 1-7: Task 7 Steps 2 and 4-8.
   - §6's busy-poll measurement: ruling 17, Task 5 Step 6, Task 7 Step 3.
   - §7's tests: Tasks 2-4. The bench: Tasks 1 and 7.
   - The only gap: no host test of the alarm itself (device-only timing). Its pure half (`pnet_go_wait_us`, with the
     wrap and the stale stamp) is tested, and its effect is measured by the gate and the `go` log line.
2. **Placeholder scan:** no "TBD", "TODO" or "similar to".
   - Values only a run produces are named as such: `<version>`, `<n>`, `<mac>`, `<MAC_IP>`, the router, and
     `<verdict>`.
   - Two edits are given by exact old text and position rather than retyped whole: `pnet_prepare_echo`'s pack loop
     (Task 4 Step 12 (i)) and NetLoop's `main` flags (Task 4 Step 15 (b)).
3. **Type consistency:**
   - `pnet_go_wait_us` returns `uint32_t`, compared against `PNET_GO_MIN_US` (unsigned) and passed to
     `add_alarm_in_us` (`uint64_t`).
   - `pnet_link_take`'s ring is the `pnet_ring_t *` that `g_pnet_tx` is. `pnet_frame_iter_next`'s `uint16_t *len`
     matches `pnet_ring_commit(…, uint16_t)` and `lens[]`.
   - `pnet_status_t.rssi` is `int16_t`, like `g_pnet_rssi`.
   - `PNET_TRACK_STATUS` (153) is used by `pnet_df1_for_track_l2` and NetLoop's `td_io`, whose raw-read offset is a
     track number, as `PNET_TRACK_OUT` is.
   - `pnet_stream_words(const uint32_t *, uint32_t)` accepts both `track_words1` and `g_pnet_status_words`.
4. **Ordering:**
   - `g_pnet_go_alarm` and `pnet_go_cancel` (Task 1), and `g_pnet_status_live` (Task 4), are declared above
     `stream_stop`, which uses them.
   - `pnet_index_now` and `pnet_stream_words` are defined above `pnet_serve_status`, which is above
     `pnet_serve_df1`.
   - `pnet_pack_words` is above `pnet_prepare_echo`.
5. **Review Focus:** each of the five lines has its test in the owning task: Task 3 (1, 2, 3), Task 4 (4), Task 2 (5).
