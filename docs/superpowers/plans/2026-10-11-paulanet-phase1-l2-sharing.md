# PaulaNET Phase 1: Layer-2 Sharing on DF1 Cylinder 77 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 0 echo with real Ethernet frames on DF1 cylinder 77. The board shares its own Wi-Fi
MAC with the Amiga and sorts inbound frames by IP (research §2.2, option A), so a hand-made ARP request and a DHCP
exchange from the A500 reach the home router and come back, while the board's own TLS session, DF0 mounts and DF0
write-back keep working.

**Architecture:** Core1 owns the radio side:
- a netif input hook sorts every received frame (board, Amiga or both) and copies Amiga-bound frames into a PSRAM
  RX ring;
- a 2 ms worker in the network context drains a PSRAM TX ring into the radio;
- a DHCP hook gives the board a client-id of its own.

Core0 owns the floppy side. It keeps Phase 0's cylinder-77 transport (pre-armed raw capture, the 200-byte lead-in,
the build at the commit, the 200 µs INDEX pulse). A batch the Amiga writes is now parsed into the TX ring instead of
an echo store, and the batch the Amiga reads is built from the RX ring under PaulaNET's counter/ack rule.

All decisions are pure, host-tested C: `pnet_sort`, `pnet_ring` and `pnet_link`. The glue is device-only:
`pnet_bridge.c`, `net_radio_cyw43.c`, and `#if WF_PNET_L2` blocks in `main.c` and `lwipopts.h`. All of it sits
behind a new TEST-only CMake option, `WF_PNET_L2`, which needs `WF_PNET_LOOP`. `NetLoop` gains `ARP` and `DHCP`
modes.

**Tech Stack:** C11, pico-sdk 2.3.0 (RP2350, PIO, DMA, `pico_async_context`), lwIP 2.x (`NO_SYS`, threadsafe
background), the CYW43439 behind `net_radio.h`. Host tests run through `wifi-floppy/firmware/test/run.sh`. On the
Amiga side: bebbo `m68k-amigaos-gcc` 6.5 in Docker, AmigaOS 3.1 `trackdisk.device`, `timer.device` and
`dos.library` variables.

**Spec:** `docs/superpowers/research/2026-10-09-paulanet-df1.md`. The core is §8 "Phase 1", read with §2.2 (option A,
the client-id, the filter list), §3 (board headroom) and §5 (DF0/DF1 sharing). Also binding:
- HANDOFF.md §3bg (Phase 0 results and measured facts);
- the HANDOFF backlog entry "pio2 CTRL shared by flux_in and the radio driver without a lock";
- `docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md` (the transport this plan keeps).

## Rulings (made for the operator while planning; each is open to revision)

1. **Phase 1 stays a TEST-only build.** The new CMake option `WF_PNET_L2` (OFF) requires `WF_PNET_LOOP=ON`.
   - Why: Phase 1 hard-wires cylinder 77, and it only works while DF1 holds the next disk of a set. That is Phase 0's
     bench arrangement, not a product mode.
   - The Off/Disk/Network setting, the driver disk, the `df1Seen` refusal and live switching are Phase 3 (spec §8),
     and they touch the server and the web.
   - Product integration now would mean e2e, a migration and a release, all for a mode nobody can use until Phase 2
     gives the Amiga a stack.
   - The L2 image carries Phase 0's `wf-pnet-loop-test` marker (it is a `WF_PNET_LOOP` build). So the existing
     publish guard already refuses it without "TEST build" notes, and no web change is needed.
2. **The pio2 CTRL race is fixed in ALL builds (Task 1), not only in TEST builds.** It is a latent defect on master
   that network traffic makes likelier.
   - The fix: `flux_in` is enabled once, before core1 starts, and its enable bit is never written again. A capture is
     started and stopped by its DMA channel instead.
   - Why not only `hw_set_bits`/`hw_clear_bits` on our side: the other writer is SDK code. `cyw43_bus_pio_spi.c` lines
     250, 277, 292, 311 and 320 call `pio_sm_set_enabled`, which is `pio->ctrl = (pio->ctrl & ~bit) | …`
     (`hardware/pio.h:1098`). Its read-modify-write can still undo an atomic set or clear of ours that lands between
     its read and its write.
   - Why not another PIO block: the boot log reads `pio0=f pio1=f pio2=7`. pio0 and pio1 have no free state machine.
   - What it costs: it changes DF0's write-capture arm and disarm. Task 9 re-proves DF0 write-back on hardware. The fix
     reaches releases with the next release, which the bench board needs anyway to leave TEST sequence 67 (HANDOFF
     §3bg).
3. **The board changes as little as possible.** Every frame the board's lwIP saw before, it still sees, except two
   kinds:
   - IPv4 unicast to the Amiga's learned address;
   - DHCP replies whose `xid` is one the Amiga sent.

   Those two go to the Amiga only. ARP that concerns the Amiga's address goes to both. Multicast, IPv6, other
   ethertypes and all IPv4 broadcast except DHCP replies never reach the Amiga.
   - This narrows the spec §2.2 table's "broadcasts go to both" to the filter list in the same section. The filter
     list governs, because the link is ~18 KB/s.
4. **The Amiga's identity is learned on core1, from its own frames.** Its IP comes from:
   - the sender address of its ARP;
   - the source address of its IPv4 (when not 0.0.0.0);
   - the `yiaddr` of a DHCP ACK to one of its `xid`s.

   Its DHCP `xid`s come from its BOOTREQUESTs. All sorter state is written and read only in core1's network context,
   so nothing in the sorter crosses cores.
5. **DHCP replies are sorted by `xid`, not `chaddr`:** both stacks put the same MAC in `chaddr`. lwIP's own
   `dhcp_recv` drops a reply with a foreign `xid`, so the board loses nothing.
6. **The board's client-id is `61, 9, 0x00, 'w', 'f', MAC[6]`, in L2 builds only.** AmiTCP_NG sends type 1 + MAC
   (spec §2.2), so the two differ.
   - Consequence: after the first L2 install the router may lease the board a new address once. Nothing on the board
     or the server depends on a fixed address.
7. **Clash handling (spec §2.2, mitigation 2).** These are refused and counted:
   - an Amiga DHCP ACK whose `yiaddr` equals the board's address is dropped, never forwarded;
   - Amiga frames whose source IP (or ARP sender) is the board's address are not sent.

   A board ACK that names the Amiga's address is logged. A clash never moves the board's own traffic to the Amiga.
   **Option B (MAC rewrite) is not built in Phase 1.** If acceptance item 2 fails on the operator's router, stop and
   decide.
8. **The rings are fixed-slot, single-producer/single-consumer, in PSRAM:**
   - RX: 64 slots of 1,536 B. Core1's input hook produces; core0 consumes.
   - TX: 32 slots of 1,536 B. Core0 produces; core1's worker consumes.

   The indices are SRAM words. The handoff: the producer writes the slot, issues `__dmb()`, then stores `head`; the
   consumer loads `head`, issues `__dmb()`, then reads the slot. Freeing works the same way with `tail`.
   - PSRAM is read through the RP2350's one XIP cache, which both cores share. `psram_image.c` already relies on that
     for core1-written slots that core0 reads.
   - The TX ring holds at least `PNET_MAX_FRAMES` (20), so one batch always fits an empty ring.
9. **Frames reach the radio from an `async_context` at-time worker on core1 (every 2 ms, at most 8 frames),** not
   from core1's loop.
   - Why: core1's loop blocks for tens of seconds inside the long poll (`wf_log.h:23-26`).
   - Why not a cross-core wake from core0: that path manipulates core1's alarm pool from core0
     (`async_context_threadsafe_background.c:44-70`).
   - The worker runs with the lwIP lock held, on the same path lwIP's own output uses.
10. **Frames leave the RX ring only when the Amiga acknowledges their batch (PaulaNET's rule).** A batch is rebuilt,
    with the same frames and the same pico counter, after every commit and whenever DF1's buffer was used for a disk
    track.
    - A new batch is started only while nothing is out and the head is not streaming side 1. The one exception is
      Phase 0's commit restart.
    - A batch whose frames do not all fit the TX ring is not taken: its counter is not acknowledged, so the Amiga
      resends it.
11. **NetLoop learns the board's MAC from `MAC=`.** The board logs its MAC at boot (`pnet: L2 sharing on …`), and it
    drops (and counts) Amiga frames with any other source MAC, so a typo shows at once. The status cylinder 76 that
    Rob's driver reads the MAC from is Phase 2 (spec §8 Phase 2, §6 question 6).
12. **The OTA idle rule for Network mode:** an update may install only when cylinder 77 has been quiet for
    `PNET_OTA_QUIET_MS` (10 s) and the TX ring is empty. This is ANDed with the existing gate.
    - In Phase 1 the existing gate already refuses while DF0 holds a disk, which Phase 1 needs (Phase 0 correction 5).
      The rule matters from Phase 3 on, and it is built now because §8 asks for it.
    - It is verified by host tests and a log line, **not on the bench**: an install ejects DF0, so the Amiga must be
      off first.
13. **The heap low-water is sampled on every core0 loop pass** in L2 builds and printed with the L2 summary. The
    existing 5 s `heap:` line can miss a dip.
14. **NetLoop increments its counter on every write,** including the empty writes that only poll or acknowledge.
    This is simpler than PaulaNET's skip-when-idle, and it is correct under the board's rule (a new counter with no
    frames is taken as an empty batch).
15. **No web or server change, so no e2e.** The Global Constraints keep the e2e rule for completeness.

## Corrections to the spec, from the code

1. **The send cannot run from core1's loop under `cyw43_arch_lwip_begin/end`** (spec §3.3). The loop is blocked inside
   the long poll for seconds at a time, so a frame would wait out the poll. Ruling 9 moves the send into the network
   context.
2. **"Broadcasts go to both"** (spec §2.2 table) conflicts with the filter list in the same section. Ruling 3 follows
   the filter list.
3. **The input hook is confirmed.** `cyw43_cb_process_ethernet` (`lib/cyw43-driver/src/cyw43_lwip.c:272-289`)
   allocates one `PBUF_POOL` pbuf, copies the frame into it, and calls `netif->input`. The hook frees that pbuf at
   once for Amiga-only frames.
   - The netif is added by `cyw43_cb_tcpip_init` (`:168-244`), which `net_radio_sta_enable()` reaches once
     (`main.c:1700`). The SDK re-adds it, resetting `input` to `ethernet_input`, only if STA mode is disabled and
     enabled again. So core1 re-checks the hook on every loop pass (`pnet_bridge_check`).
4. **`LWIP_HOOK_DHCP_APPEND_OPTIONS` is confirmed** (`lib/lwip/src/core/ipv4/dhcp.c:89-90`). It is called for
   DISCOVER, REQUEST (selecting, renewing, rebooting), REBIND, DECLINE, INFORM and RELEASE (`:485, 917, 996, 1055,
   1186, 1241, 1298, 1366`), so the client-id is consistent across a lease's life.
   - `DHCP_OPTIONS_LEN` is 68 (`prot/dhcp.h:80-88`). A REQUEST plus our 11 bytes is about 46, and the hook refuses
     cleanly if it would not fit.
5. **The OTA gate (spec §3.4) reads DF0's motor only** (Phase 0 correction 5, still true). Ruling 12 records what the
   new rule covers.
6. **Spec §3.1 says frames are "parsed into a PSRAM TX ring".** `pnet_parse_frames` writes frames back to back, and
   the ring's slots are fixed. So a batch is parsed into Phase 0's PSRAM echo store first (both halves: 32 KB, which
   holds 20 × 1,518 B), then copied into slots. That is about 8 KB of PSRAM-to-PSRAM copy per full batch.
7. **pio2 has no lock and no free sibling block.** See ruling 2.

## Global Constraints

- **Toolchain:** before any firmware build, run `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"`.
  - The release build is `cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 && cmake --build build`.
  - The L2 side build adds `-DWF_PNET_LOOP=ON -DWF_PNET_L2=ON` and uses `build-pnet1/`.
- **Host tests:** `pnpm firmware:test` (= `wifi-floppy/firmware/test/run.sh`).
  - A task is green only when `wifi-floppy/firmware/test/run.sh; echo "exit $?"` prints `exit 0`. `run.sh` reports a
    failure and carries on, so only the exit code counts.
  - New tests run once under `gcc:13` (Task 4), because CI builds with Linux GCC.
- **Stack:**
  - No function of ours may have a stack frame over 768 bytes (`-Werror=frame-larger-than=768`, the CMake comment
    above the `foreach`).
  - core0's stack is 4 KB, and nothing new keeps a buffer on the stack. The largest new frame is
    `pnet_prepare_echo`'s 20 frame refs plus 20 lengths (200 B).
- **SRAM:**
  - The heap floor is 20,480 B (R11). New `.bss` is ring and sorter state, counters, one DMA config and one async
    worker: a few hundred bytes.
  - Task 5 Step 9 measures it: `arm-none-eabi-size -A` on `build-pnet1` against `build`.
  - Large buffers live in PSRAM: RX 98,304 B, TX 49,152 B, plus Phase 0's echo store, 32,768 B. Spec §3.2 says
    1,703,936 B of PSRAM are free.
- **OFF is unchanged.** `WF_PNET_L2` defaults to OFF, the new sources are compiled into the image only when it is
  ON, and every hook is under `#if WF_PNET_L2`.
  - `wifi-floppy/firmware/tools/pnet_off_identical.sh <base>` proves it for `main.c`, `flux_capture.c` and
    `net_radio_cyw43.c`.
  - `<base>` is Task 1's commit: Task 1 changes `flux_capture.c` in every build, on purpose (ruling 2).
- **TEST builds:**
  - They are published with `--notes` starting `TEST build`. They are never pushed to GitHub as a release and never
    announced.
  - `build/` goes back to the release configuration at once after a TEST publish.
- **Installs eject DF0:** the Amiga must be OFF first. Ask the operator for that as the last thing in a turn, and say
  in the conversation that an install was triggered.
- **Bench steps** are operator steps, one per turn, each ending the turn. PASS or FAIL must be visible at a glance:
  NetLoop prints `RESULT: PASS` or `RESULT: FAIL`.
- **The radio's name** may appear only in `net_radio_cyw43.c`.
  - `run.sh` greps `../src/*.c`, `../src/*.h` and `lwipopts.h` for `cyw43` in any case, after stripping `//` and
    single-line `/* */` comments. A multi-line comment that names the chip FAILS it.
  - Write "the radio" in new files.
- **Device-only files** (lwIP- or SDK-dependent) are excluded from the host build by name in `run.sh`'s `grep -vE`:
  `pnet_bridge.c` joins that list. Every other new `src/*.c` must compile on the host.
- **Protocol credit:**
  - Every new file that implements PaulaNET's protocol starts with: "PaulaNET protocol: Copyright (C) 2026
    RobSmithDev, https://github.com/RobSmithDev/PaulaNET. Used with the author's permission (2026-10-09)". That is
    `pnet_link.{h,c}`, `pnet_bridge.c`, `test_pnet_link.c`, and the NetLoop files.
  - `pnet_sort` and `pnet_ring` are ours (Ethernet and rings), so they need no notice.
  - No code of his is pasted.
- **e2e:** none is needed: no web area changes. If one ever does, run only its specs, on `PORT=3100`, serialized with
  any other e2e run.
- **Git:**
  - Work in a worktree on branch `feat/paulanet-phase1` from master `7a2aaab`.
  - No `git stash`.
  - Re-check `git status` before staging, and never `git add -A`.
  - Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A DHCP OFFER sent unicast to the not-yet-assigned `yiaddr`**, with the shared MAC as destination, before the
   board knows any Amiga address.
   - Expected: it reaches the Amiga by its `xid`, and never the board's lwIP as a foreign unicast.
   - Test: `an_offer_to_an_unknown_address_goes_by_xid` (Task 2).
2. **The board renews its own lease while the Amiga holds one.**
   - Expected: the board's ACK (its own `xid`) stays the board's, even when its `yiaddr` equals the Amiga's address
     (that is logged as a clash). Traffic to the board's address never goes to the Amiga.
   - Tests: `the_boards_own_dhcp_replies_stay_the_boards` and `a_clash_never_steals_the_boards_traffic` (Task 2).
3. **Frames for the Amiga while nothing on it polls** (NetLoop not running, Amiga off).
   - Expected: the RX ring fills, then drops and counts. The board's own traffic is unaffected, and nothing is written
     past the ring.
   - Test: `a_full_ring_drops_and_counts` (Task 3).
4. **A batch from the Amiga that the TX ring cannot hold whole** (the radio slow, the link down).
   - Expected: the batch is not taken, so its counter is not acknowledged and the Amiga resends it. No frame of it
     goes out twice or half.
   - Test: `a_batch_that_does_not_fit_the_tx_ring_is_not_taken` (Task 4).
5. **The Amiga resets (Ctrl-A-A), or NetLoop restarts, while a batch is out unacknowledged.**
   - Expected: the board keeps serving the same frames under the same pico counter until something acknowledges them.
     None is lost or duplicated, and no new batch starts over it.
   - Test: `an_unacknowledged_batch_is_rebuilt_unchanged` (Task 4). On hardware: Task 9 Step 8.

## File structure

| File | Responsibility |
|---|---|
| `wifi-floppy/firmware/src/flux_capture.c` | Task 1: flux_in stays enabled; a capture is gated by its DMA channel (all builds) |
| `wifi-floppy/firmware/test/run.sh` | Task 1: the pio2 guard. Task 3: `-pthread`. Task 5: exclude `pnet_bridge.c` |
| `wifi-floppy/firmware/src/pnet_sort.{h,c}` (new) | Pure: inbound frame → board/Amiga/both/drop; outbound check and learning; the client-id option; IP text |
| `wifi-floppy/firmware/src/pnet_ring.{h,c}` (new) | Pure: fixed-slot SPSC frame ring with the cross-core barriers |
| `wifi-floppy/firmware/src/pnet_link.{h,c}` (new) | Pure: PaulaNET's counter/ack for real frames, the batch fit, the OTA quiet rule |
| `wifi-floppy/firmware/test/test_pnet_{sort,ring,link}.c` (new) | Host tests |
| `wifi-floppy/firmware/src/pnet_bridge.{h,c}` (new) | Device, core1: the rings' PSRAM, the netif input hook, the send worker, stats |
| `wifi-floppy/firmware/src/pnet_lwip_hooks.h` (new) | `LWIP_HOOK_DHCP_APPEND_OPTIONS` → `pnet_dhcp_client_id` |
| `wifi-floppy/firmware/lwipopts.h` | `LWIP_HOOK_FILENAME` under `#if WF_PNET_L2` |
| `wifi-floppy/firmware/src/net_radio.h`, `net_radio_cyw43.c` | `net_radio_send_ethernet`, `net_radio_every_ms` under `#if WF_PNET_L2` |
| `wifi-floppy/firmware/CMakeLists.txt` | Option `WF_PNET_L2` (OFF, needs `WF_PNET_LOOP`) |
| `wifi-floppy/firmware/src/main.c` | `#if WF_PNET_L2`: batches from the RX ring, commits to the TX ring, OTA rule, heap low, L2 log, bridge start |
| `wifi-floppy/firmware/tools/pnet_off_identical.sh` | Also checks `net_radio_cyw43.c` |
| `tools/netloop/netloop_eth.{h,c}`, `test_netloop_eth.c` (new) | Pure Ethernet/ARP/DHCP build and parse for NetLoop, and its host test against the board's sorter |
| `tools/netloop/netloop.c`, `build.sh` | `ARP` and `DHCP` modes, NetLoop 1.2 |
| `.gitignore` | `build-pnet1/` |
| `HANDOFF.md` | Task 9's record |

---

### Task 1: pio2's CTRL is never written after boot: flux_in stays enabled, its DMA channel gates a capture

**Files:**
- Modify: `wifi-floppy/firmware/src/flux_capture.c`, in the statics, `flux_capture_init`, `arm` (the
  `flux_capture_arm` body), `flux_capture_disarm`, `flux_capture_timeout` and `flux_capture_prearm_cancel`.
- Modify: `wifi-floppy/firmware/src/main.c`, the comment after `flux_capture_init(step_pio, sm_in);` (comment only).
- Modify: `wifi-floppy/firmware/test/run.sh`: a new guard before `exit $fail`.

**Interfaces:**
- Consumes: nothing new.
- Produces: the same `flux_capture.h` API, unchanged. From now on `flux_in` is enabled from `flux_capture_init` on,
  in every build. `cap_pc0` is now set in every build, not only under `WF_PNET_LOOP`.

- [ ] **Step 1: Write the failing guard.** In `wifi-floppy/firmware/test/run.sh`, insert before the final
  `exit $fail`:

```bash
# pio2's CTRL holds the enable bit of every state machine on the block, the radio's included, and
# the radio's SDK driver read-modify-writes it from core1 with no lock (cyw43_bus_pio_spi.c). Any
# enable or disable of ours racing one of those undoes the other (HANDOFF backlog, "pio2 CTRL";
# plan 2026-10-11 Task 1). So flux_in is enabled ONCE, in flux_capture_init, before core1 starts,
# and a capture is gated by its DMA channel. Comments are stripped first.
pio2_toggles=$(sed -E -e 's#//.*##' -e 's#/\*.*\*/##g' ../src/flux_capture.c |
  { grep -cE 'pio_sm_set_enabled|pio_set_sm_mask_enabled|pio_enable_sm_mask_in_sync|pio_enable_sm_multi_mask_in_sync' || true; })
if [ "$pio2_toggles" != 1 ]; then
  echo "FAIL: flux_capture.c writes flux_in's enable bit $pio2_toggles times (exactly 1, in flux_capture_init)"
  fail=1
fi
```

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'pio2|enable bit'; wifi-floppy/firmware/test/run.sh >/dev/null 2>&1; echo "exit $?"`
Expected: `FAIL: flux_capture.c writes flux_in's enable bit 5 times (exactly 1, in flux_capture_init)`, then
`exit 1`. Today's file has calls in `arm`, `disarm`, `timeout` and `prearm_cancel`, and none in init; if the count
differs, read the file and say so before going on.

- [ ] **Step 3: Gate the capture by its channel.** In `wifi-floppy/firmware/src/flux_capture.c`:

(a) After `static uint32_t pio_hz;`, add:

```c
/* The capture channel's configuration, EN set: arm() re-applies it to start a capture. Between
 * captures the channel is paused (cap_pause) and flux_in keeps running (flux_capture_init). */
static dma_channel_config cap_cfg;
/* flux_in's first instruction: an arm sends the machine there instead of disabling it. */
static uint     cap_pc0;
```

and delete `static uint     cap_pc0;` from the `#if WF_PNET_LOOP` block below. Keep `static volatile bool prearmed;`
there.

(b) In `flux_capture_init`, replace from `dma_channel_configure(cap_dma, &c, ring, &pio->rxf[sm], 0xffffffffu, false);`
to the end of the function with:

```c
    cap_cfg = c;
    dma_channel_configure(cap_dma, &c, ring, &pio->rxf[sm], 0xffffffffu, false);

    flux_bits_init(&bits, mfm_buf, sizeof mfm_buf);
    cap_pc0 = pio_sm_get_pc(pio, sm);    // flux_in_program_init left it at the program's start
    // flux_in runs from here on, and its enable bit is never written again. pio2's CTRL holds the
    // enable bits of every machine on the block -- the radio's too -- and the radio's SDK driver
    // read-modify-writes that register from core1 with no lock: an enable or disable here racing
    // one of those would undo the other (HANDOFF backlog, "pio2 CTRL"). This runs on core0 before
    // core1 starts. With no capture running, the channel is paused and flux_in's FIFO, which it
    // pushes with `noblock`, fills and then drops: nothing reaches the ring.
    pio_sm_set_enabled(pio, sm, true);
}

/* Stops the capture's channel through the atomic CLR alias of its non-triggering control
 * register: no more words reach the ring. flux_in keeps running. */
static void cap_pause(void) {
    hw_clear_bits(&dma_hw->ch[cap_dma].al1_ctrl, DMA_CH0_CTRL_TRIG_EN_BITS);
}
```

(c) In `arm` (the body shared by `flux_capture_arm`/`flux_capture_arm_raw`), replace these lines:

```c
    pio_sm_set_enabled(cap_pio, cap_sm, false);
    pio_sm_clear_fifos(cap_pio, cap_sm);
    pio_sm_restart(cap_pio, cap_sm);

    dma_channel_abort(cap_dma);
    dma_channel_set_write_addr(cap_dma, ring, false);
    dma_channel_set_trans_count(cap_dma, 0xffffffffu, true);
```

with

```c
    // flux_in is never disabled (flux_capture_init): the channel stops, the machine restarts at its
    // first instruction (`start: set x, 0`, so word 0 is arm -> first edge), and only THEN is the
    // FIFO emptied -- a word pushed from a stale count before the jump is cleared with the rest.
    // pio_sm_restart writes CTRL's self-clearing SM_RESTART bit through the atomic SET alias.
    cap_pause();
    dma_channel_abort(cap_dma);
    pio_sm_restart(cap_pio, cap_sm);
    pio_sm_exec(cap_pio, cap_sm, pio_encode_jmp(cap_pc0));
    pio_sm_clear_fifos(cap_pio, cap_sm);
```

  Then, inside `#if WF_PNET_LOOP … if (raw) {`, delete the two `pio_sm_exec` calls and the four comment lines above
  them (`pio_sm_restart keeps X…` through `…a stray edge, to a pre-arm.`): the jump above now does that for every
  arm. Keep `pnet_rx_init(...)` and the `ring[0] = 0u;` sentinel with its comment. The channel is aborted above, so
  nothing lands before that store.

  Finally replace the function's last line, `pio_sm_set_enabled(cap_pio, cap_sm, true);`, with:

```c
    // Last: the channel runs again from the ring's start (cap_cfg has EN set, and this triggers it).
    dma_channel_configure(cap_dma, &cap_cfg, ring, &cap_pio->rxf[cap_sm], 0xffffffffu, true);
```

(d) In `flux_capture_disarm`, `flux_capture_timeout` and `flux_capture_prearm_cancel`, replace each
  `pio_sm_set_enabled(cap_pio, cap_sm, false);` with `cap_pause();`.

- [ ] **Step 4: Fix the comment in `main.c`** that now lies. After `flux_capture_init(step_pio, sm_in);`, replace

```c
    // Claims a DMA channel and points it at sm_in's RX FIFO. The state machine
    // stays DISABLED until WGATE says the Amiga is writing -- see
    // flux_capture_arm().
```

  (the three lines just above the call) and the `// (enabled when WGATE asserts; write path TODO)` line below it with:

```c
    // Claims a DMA channel, points it at sm_in's RX FIFO, and ENABLES sm_in for good:
    // nothing writes pio2's CTRL enable bits after this (core1, which shares the
    // block through the radio, starts below). A capture is gated by the channel --
    // see flux_capture_arm().
```

- [ ] **Step 5: Run the host tests**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `exit 0`, and no `FAIL: flux_capture.c writes flux_in's enable bit` line.

- [ ] **Step 6: Mutation proof.** Temporarily add `pio_sm_set_enabled(cap_pio, cap_sm, false);` as the first line of
  `flux_capture_disarm`. Run `run.sh; echo "exit $?"`, and expect the guard's FAIL line with `2 times` and `exit 1`.
  Remove the line again, and re-run to `exit 0`.

- [ ] **Step 7: Both builds compile.**

Run:
```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=OFF && cmake --build build >/dev/null && echo "OFF ok"
cmake -B build-pnet -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=ON && cmake --build build-pnet >/dev/null && echo "LOOP ok"
```
Expected: `OFF ok`, then `LOOP ok`.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/src/flux_capture.c wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/run.sh
git commit -m "fix(fw): flux_in stays enabled, its DMA channel gates a capture (pio2 CTRL race)

The radio's SDK driver read-modify-writes pio2's CTRL from core1 unlocked; our
enable/disable of flux_in on core0 could undo its bit or have ours undone. flux_in
is now enabled once, before core1 starts, and never toggled; run.sh enforces it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

  Record the commit hash: it is `<base>` for `pnet_off_identical.sh` in Tasks 5 and 6. Find it later with
  `git log -1 --format=%H --grep='flux_in stays enabled'`.

---

### Task 2: The frame sorter (`pnet_sort`)

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_sort.h`, `wifi-floppy/firmware/src/pnet_sort.c`
- Test: `wifi-floppy/firmware/test/test_pnet_sort.c`

**Interfaces:**
- Consumes: nothing.
- Produces (IPv4 addresses are host-order `uint32_t`: `192.168.1.57` is `0xC0A80139`; 0 means unknown):

```c
typedef enum { PNET_SORT_DROP = 0, PNET_SORT_BOARD = 1, PNET_SORT_AMIGA = 2, PNET_SORT_BOTH = 3 } pnet_sort_to_t;
typedef enum { PNET_TX_SEND = 0, PNET_TX_LEN, PNET_TX_MAC, PNET_TX_TYPE, PNET_TX_CLASH, PNET_TX_N } pnet_tx_t;
typedef struct {
    uint32_t amiga_ip;          /* learned; 0 = unknown */
    uint32_t xid[PNET_SORT_XIDS];
    uint8_t  nxid, xid_next;
    uint32_t clash;             /* ACKs refused, a board ACK naming the Amiga's address */
    uint32_t to_amiga, to_both; /* inbound decisions, by kind */
} pnet_sort_t;
void pnet_sort_init(pnet_sort_t *s);
pnet_sort_to_t pnet_sort_rx(pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip);
pnet_tx_t pnet_sort_tx(pnet_sort_t *s, const uint8_t *f, size_t len, const uint8_t mac[6], uint32_t board_ip);
size_t pnet_dhcp_client_id(uint8_t *opts, size_t used, size_t cap, const uint8_t mac[6]);
void pnet_ip_text(uint32_t ip, char out[16]);
#define PNET_SORT_MTU 1518u
#define PNET_SORT_XIDS 4u
#define PNET_CLIENT_ID_BYTES 11u
```

- [ ] **Step 1: Write the header** `wifi-floppy/firmware/src/pnet_sort.h`:

```c
#ifndef PNET_SORT_H
#define PNET_SORT_H
/*
 * PaulaNET Phase 1 (plan docs/superpowers/plans/2026-10-11-paulanet-phase1-l2-sharing.md): the
 * board and the Amiga share the board's Wi-Fi MAC (research 2026-10-09 §2.2, option A). This
 * decides, per frame, whose it is. Pure: board (core1's network context) and host.
 *
 * Inbound (pnet_sort_rx), the board loses nothing it had before except two kinds of frame:
 *   - IPv4 unicast to the Amiga's address          -> the Amiga only
 *   - a DHCP reply (UDP 67 -> 68) to an Amiga xid  -> the Amiga only (lwIP drops a foreign xid anyway)
 *   - ARP whose target address is the Amiga's      -> both
 *   - everything else                              -> the board, exactly as before
 * An Amiga ACK whose yiaddr is the board's own address is DROPPED (a router that keys leases on
 * the MAC alone; §2.2 mitigation 2). The Amiga's address is never the board's: if they ever match,
 * the Amiga is treated as having none, so the board's own traffic stays the board's.
 *
 * Outbound (pnet_sort_tx): a frame from the Amiga goes out only with the board's MAC as its
 * source, as ARP or IPv4, and never from the board's address. Its ARP sender and IPv4 source
 * teach the Amiga's address; its BOOTREQUESTs teach its DHCP xids (the last PNET_SORT_XIDS).
 *
 * Addresses are host-order uint32_t (192.168.1.57 = 0xC0A80139); 0 is "unknown".
 */
#include <stdint.h>
#include <stddef.h>

#define PNET_SORT_MTU        1518u   /* the largest frame either way, VLAN tag included */
#define PNET_SORT_XIDS       4u
#define PNET_CLIENT_ID_BYTES 11u     /* option 61: code, length 9, type 0, 'w', 'f', MAC */

typedef enum { PNET_SORT_DROP = 0, PNET_SORT_BOARD = 1, PNET_SORT_AMIGA = 2, PNET_SORT_BOTH = 3 } pnet_sort_to_t;
typedef enum { PNET_TX_SEND = 0, PNET_TX_LEN, PNET_TX_MAC, PNET_TX_TYPE, PNET_TX_CLASH, PNET_TX_N } pnet_tx_t;

typedef struct {
    uint32_t amiga_ip;
    uint32_t xid[PNET_SORT_XIDS];
    uint8_t  nxid, xid_next;
    uint32_t clash;
    uint32_t to_amiga, to_both;
} pnet_sort_t;

void pnet_sort_init(pnet_sort_t *s);
/* `f` is the frame's first `len` bytes (the whole frame, or its first pbuf). */
pnet_sort_to_t pnet_sort_rx(pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip);
/* A frame from the Amiga: PNET_TX_SEND, or why not. Learns from what it lets through. */
pnet_tx_t pnet_sort_tx(pnet_sort_t *s, const uint8_t *f, size_t len, const uint8_t mac[6], uint32_t board_ip);
/* Appends the board's DHCP client-id (option 61, type 0, "wf" + MAC) at opts[used] if it fits in
 * cap; returns the new length, or `used` unchanged when it does not. */
size_t pnet_dhcp_client_id(uint8_t *opts, size_t used, size_t cap, const uint8_t mac[6]);
/* Dotted quad, NUL-terminated. */
void pnet_ip_text(uint32_t ip, char out[16]);
#endif
```

- [ ] **Step 2: Write the failing test** `wifi-floppy/firmware/test/test_pnet_sort.c`:

```c
#include "harness.h"
#include "../src/pnet_sort.h"
#include <stdint.h>
#include <string.h>

/* The layer-2 sharing sorter: whose frame is it? */

#define IP(a, b, c, d) ((uint32_t)(a) << 24 | (uint32_t)(b) << 16 | (uint32_t)(c) << 8 | (uint32_t)(d))
#define BOARD  IP(192, 168, 1, 40)
#define AMIGA  IP(192, 168, 1, 57)
#define ROUTER IP(192, 168, 1, 1)
static const uint8_t MAC[6]   = {0x28, 0xcd, 0xc1, 0x01, 0x02, 0x03};   /* the board's, shared */
static const uint8_t RMAC[6]  = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55};   /* the router's */
static const uint8_t BCAST[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
static uint8_t F[1600];

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }

static size_t eth(const uint8_t *dst, const uint8_t *src, uint16_t type) {
    memset(F, 0, sizeof F);
    memcpy(F, dst, 6); memcpy(F + 6, src, 6); put16(F + 12, type);
    return 14;
}
static size_t arp(const uint8_t *dst, const uint8_t *src, uint16_t op, uint32_t spa, uint32_t tpa) {
    uint8_t *a = F + eth(dst, src, 0x0806);
    put16(a, 1); put16(a + 2, 0x0800); a[4] = 6; a[5] = 4; put16(a + 6, op);
    memcpy(a + 8, src, 6); put32(a + 14, spa); put32(a + 24, tpa);
    return 60;
}
/* IPv4 + `l4` bytes of payload; returns the offset of the payload. */
static size_t ipv4(const uint8_t *dst, const uint8_t *src, uint8_t proto, uint32_t sip, uint32_t dip, size_t l4) {
    uint8_t *ip = F + eth(dst, src, 0x0800);
    ip[0] = 0x45; put16(ip + 2, (uint16_t)(20 + l4)); ip[8] = 64; ip[9] = proto;
    put32(ip + 12, sip); put32(ip + 16, dip);
    return 34;
}
static size_t udp(const uint8_t *dst, const uint8_t *src, uint32_t sip, uint32_t dip,
                  uint16_t sp, uint16_t dp, size_t plen) {
    const size_t o = ipv4(dst, src, 17, sip, dip, 8 + plen);
    put16(F + o, sp); put16(F + o + 2, dp); put16(F + o + 4, (uint16_t)(8 + plen));
    return o + 8 + plen;
}
/* A BOOTP message: op 1 from the Amiga (68 -> 67), op 2 to it (67 -> 68), DHCP type `t`. */
static size_t dhcp(const uint8_t *dst, const uint8_t *src, uint32_t sip, uint32_t dip,
                   uint8_t op, uint32_t xid, uint32_t yiaddr, uint8_t t) {
    const size_t end = udp(dst, src, sip, dip, op == 1 ? 68 : 67, op == 1 ? 67 : 68, 300);
    uint8_t *b = F + 42;
    b[0] = op; b[1] = 1; b[2] = 6;
    put32(b + 4, xid); put32(b + 16, yiaddr);
    memcpy(b + 28, MAC, 6);                            /* chaddr: the shared MAC, either stack */
    put32(b + 236, 0x63825363u);
    b[240] = 53; b[241] = 1; b[242] = t; b[243] = 255;
    return end;
}
static pnet_sort_t fresh(uint32_t amiga) { pnet_sort_t s; pnet_sort_init(&s); s.amiga_ip = amiga; return s; }

static void arp_for_the_amiga_goes_to_both(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = arp(BCAST, RMAC, 1, ROUTER, AMIGA);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOTH);
    n = arp(MAC, RMAC, 2, ROUTER, AMIGA);             /* the router's reply to the Amiga */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOTH);
    n = arp(BCAST, RMAC, 1, ROUTER, BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = arp(BCAST, RMAC, 1, ROUTER, IP(192, 168, 1, 99));
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    pnet_sort_t none = fresh(0);
    n = arp(BCAST, RMAC, 1, ROUTER, AMIGA);
    CHECK_EQ_INT(pnet_sort_rx(&none, F, n, BOARD), PNET_SORT_BOARD);   /* no Amiga known: the board's */
    CHECK_EQ_INT(s.to_both, 2);
}

static void ipv4_unicast_to_the_amiga_goes_to_the_amiga_only(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = udp(MAC, RMAC, ROUTER, AMIGA, 53, 4000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = udp(MAC, RMAC, ROUTER, BOARD, 443, 50000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 137, 137, 50);   /* NetBIOS chatter */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(BCAST, RMAC, ROUTER, IP(192, 168, 1, 255), 1900, 1900, 50);  /* subnet broadcast */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    static const uint8_t MCAST[6] = {0x01, 0x00, 0x5e, 0x00, 0x00, 0xfb};
    n = udp(MCAST, RMAC, ROUTER, IP(224, 0, 0, 251), 5353, 5353, 50);    /* mDNS */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(s.to_amiga, 1);
}

static void an_offer_to_an_unknown_address_goes_by_xid(void) {
    pnet_sort_t s = fresh(0);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 0xA1B2C3D4u, 0, 1);   /* DISCOVER */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, 0);                                    /* 0.0.0.0 teaches nothing */
    /* The OFFER, unicast to the offered address, to the shared MAC. */
    n = dhcp(MAC, RMAC, ROUTER, IP(192, 168, 1, 57), 2, 0xA1B2C3D4u, IP(192, 168, 1, 57), 2);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    CHECK_EQ_INT(s.amiga_ip, 0);                                    /* an offer is not a lease */
    n = dhcp(MAC, RMAC, ROUTER, IP(192, 168, 1, 57), 2, 0x11111111u, IP(192, 168, 1, 57), 2);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);   /* another xid: the board's */
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 0xA1B2C3D4u, AMIGA, 5);   /* ACK */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    CHECK_EQ_INT(s.amiga_ip, AMIGA);                                /* the lease is learned */
}

static void an_ack_naming_the_boards_address_is_refused(void) {
    pnet_sort_t s = fresh(0);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 7u, 0, 3);       /* REQUEST */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 7u, BOARD, 5);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_DROP);
    CHECK_EQ_INT(s.clash, 1);
    CHECK_EQ_INT(s.amiga_ip, 0);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 7u, BOARD, 2);            /* the same, as an OFFER */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);   /* only an ACK is a lease */
}

static void the_boards_own_dhcp_replies_stay_the_boards(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 5u, 0, 1);       /* an Amiga xid */
    pnet_sort_tx(&s, F, n, MAC, BOARD);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 0xB0A4Du, BOARD, 5);      /* the board's renewal ACK */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(s.clash, 0);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 0xB0A4Du, AMIGA, 5);      /* ...naming the Amiga's address */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(s.clash, 1);
}

static void a_clash_never_steals_the_boards_traffic(void) {
    pnet_sort_t s = fresh(BOARD);                                   /* the two ended up equal */
    size_t n = udp(MAC, RMAC, ROUTER, BOARD, 443, 50000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = arp(BCAST, RMAC, 1, ROUTER, BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
}

static void ipv6_short_and_odd_frames_stay_the_boards(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = eth(MAC, RMAC, 0x86DD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 60, BOARD), PNET_SORT_BOARD);
    (void)n;
    eth(MAC, RMAC, 0x8100);                                         /* VLAN-tagged */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 60, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 10, BOARD), PNET_SORT_BOARD);  /* shorter than a header */
    n = udp(MAC, RMAC, ROUTER, AMIGA, 53, 4000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 30, BOARD), PNET_SORT_BOARD);  /* IPv4 header cut short */
    F[14] = 0x4F;                                                   /* IHL 60 bytes, frame shorter */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 70, BOARD), PNET_SORT_BOARD);
    n = arp(BCAST, RMAC, 1, ROUTER, AMIGA);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 40, BOARD), PNET_SORT_BOARD);  /* ARP cut short */
    CHECK_EQ_INT(s.to_amiga + s.to_both, 0);
}

static void dhcp_options_are_read_within_bounds(void) {
    pnet_sort_t s = fresh(0);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 9u, 0, 1);
    pnet_sort_tx(&s, F, n, MAC, BOARD);
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 9u, AMIGA, 5);
    F[42 + 240] = 0; F[42 + 241] = 0;                               /* two pad bytes, then type 5 */
    F[42 + 242] = 53; F[42 + 243] = 1; F[42 + 244] = 5; F[42 + 245] = 255;
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    CHECK_EQ_INT(s.amiga_ip, AMIGA);                                /* found past the pads */
    s.amiga_ip = 0;
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 9u, AMIGA, 5);
    F[42 + 240] = 12; F[42 + 241] = 250;                            /* a hostname running off the end */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 42 + 260, BOARD), PNET_SORT_AMIGA);   /* still its xid */
    CHECK_EQ_INT(s.amiga_ip, 0);                                    /* but no type: not a lease */
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 9u, AMIGA, 5);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 42 + 200, BOARD), PNET_SORT_BOARD);   /* BOOTP cut short */
}

static void only_the_last_four_xids_are_kept(void) {
    pnet_sort_t s = fresh(0);
    for (uint32_t x = 1; x <= 5; x++) {
        size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, x, 0, 1);
        pnet_sort_tx(&s, F, n, MAC, BOARD);
        pnet_sort_tx(&s, F, n, MAC, BOARD);                         /* a resend: not a new entry */
    }
    size_t n = dhcp(MAC, RMAC, ROUTER, AMIGA, 2, 1u, AMIGA, 2);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);   /* xid 1 has aged out */
    for (uint32_t x = 2; x <= 5; x++) {
        n = dhcp(MAC, RMAC, ROUTER, AMIGA, 2, x, AMIGA, 2);
        CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    }
}

static void tx_learns_the_amigas_address_and_refuses_what_cannot_go(void) {
    pnet_sort_t s = fresh(0);
    size_t n = arp(BCAST, MAC, 1, AMIGA, ROUTER);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, AMIGA);
    n = arp(BCAST, RMAC, 1, AMIGA, ROUTER);                         /* someone else's MAC */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_MAC);
    n = arp(BCAST, MAC, 1, BOARD, ROUTER);                          /* the board's address */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_CLASH);
    n = udp(RMAC, MAC, BOARD, ROUTER, 4000, 53, 40);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_CLASH);
    eth(RMAC, MAC, 0x86DD);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, 60, MAC, BOARD), PNET_TX_TYPE);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, 13, MAC, BOARD), PNET_TX_LEN);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, 1519, MAC, BOARD), PNET_TX_LEN);
    n = udp(RMAC, MAC, IP(192, 168, 1, 58), ROUTER, 4000, 53, 40);  /* a new address: learned */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, IP(192, 168, 1, 58));
    n = arp(BCAST, MAC, 1, 0, ROUTER);                              /* an ARP probe: sent, teaches nothing */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, 0), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, IP(192, 168, 1, 58));
}

static void client_id_is_appended_only_when_it_fits(void) {
    uint8_t o[68];
    memset(o, 0xEE, sizeof o);
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 10, 67, MAC), 10 + PNET_CLIENT_ID_BYTES);
    static const uint8_t want[11] = {61, 9, 0x00, 'w', 'f', 0x28, 0xcd, 0xc1, 0x01, 0x02, 0x03};
    CHECK(memcmp(o + 10, want, 11) == 0, "61, 9, type 0, wf, MAC");
    CHECK_EQ_INT(o[9], 0xEE);
    CHECK_EQ_INT(o[21], 0xEE);
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 56, 67, MAC), 67);          /* exactly fits */
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 57, 67, MAC), 57);          /* one short: unchanged */
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 70, 67, MAC), 70);          /* already past cap */
}

static void ip_text_is_a_dotted_quad(void) {
    char t[16];
    pnet_ip_text(AMIGA, t);
    CHECK(strcmp(t, "192.168.1.57") == 0, "192.168.1.57");
    pnet_ip_text(0, t);
    CHECK(strcmp(t, "0.0.0.0") == 0, "0.0.0.0");
    pnet_ip_text(0xFFFFFFFFu, t);
    CHECK(strcmp(t, "255.255.255.255") == 0, "15 characters and the NUL fit");
}

int main(void) {
    RUN(arp_for_the_amiga_goes_to_both);
    RUN(ipv4_unicast_to_the_amiga_goes_to_the_amiga_only);
    RUN(an_offer_to_an_unknown_address_goes_by_xid);
    RUN(an_ack_naming_the_boards_address_is_refused);
    RUN(the_boards_own_dhcp_replies_stay_the_boards);
    RUN(a_clash_never_steals_the_boards_traffic);
    RUN(ipv6_short_and_odd_frames_stay_the_boards);
    RUN(dhcp_options_are_read_within_bounds);
    RUN(only_the_last_four_xids_are_kept);
    RUN(tx_learns_the_amigas_address_and_refuses_what_cannot_go);
    RUN(client_id_is_appended_only_when_it_fits);
    RUN(ip_text_is_a_dotted_quad);
    return REPORT();
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_sort|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_sort.c` (undefined `pnet_sort_init` and the others at link).

- [ ] **Step 4: Implement** `wifi-floppy/firmware/src/pnet_sort.c`:

```c
/* The layer-2 sharing sorter (pnet_sort.h). */
#include "pnet_sort.h"
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#define ETH_HDR 14u

static uint16_t be16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t be32(const uint8_t *p) {
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | (uint32_t)p[3];
}

typedef struct { uint32_t src, dst; uint8_t proto; size_t l4; bool first; } ip4_t;

/* The IPv4 facts the sorter reads; false when f does not hold a whole IPv4 header. */
static bool ip4(const uint8_t *f, size_t len, ip4_t *o) {
    if (len < ETH_HDR + 20u || be16(f + 12) != 0x0800u) return false;
    const uint8_t *ip = f + ETH_HDR;
    const size_t ihl = (size_t)(ip[0] & 0x0Fu) * 4u;
    if ((ip[0] >> 4) != 4u || ihl < 20u || len < ETH_HDR + ihl) return false;
    o->proto = ip[9];
    o->src = be32(ip + 12);
    o->dst = be32(ip + 16);
    o->l4 = ETH_HDR + ihl;
    o->first = (be16(ip + 6) & 0x1FFFu) == 0u;            /* fragment offset 0 */
    return true;
}

/* The BOOTP message's offset for UDP sport -> dport with the magic cookie, else 0. */
static size_t bootp_at(const uint8_t *f, size_t len, const ip4_t *ip, uint16_t sport, uint16_t dport) {
    if (ip->proto != 17u || !ip->first || len < ip->l4 + 8u) return 0;
    const uint8_t *u = f + ip->l4;
    if (be16(u) != sport || be16(u + 2) != dport) return 0;
    const size_t b = ip->l4 + 8u;
    if (len < b + 240u || be32(f + b + 236u) != 0x63825363u) return 0;
    return b;
}

/* Option 53 of the message at b, or 0 when it is absent or the options run past len. */
static uint8_t dhcp_type(const uint8_t *f, size_t len, size_t b) {
    size_t i = b + 240u;
    while (i < len) {
        const uint8_t code = f[i];
        if (code == 0u) { i++; continue; }
        if (code == 255u || len - i < 2u) return 0;
        const size_t olen = f[i + 1u];
        if (len - i - 2u < olen) return 0;
        if (code == 53u && olen == 1u) return f[i + 2u];
        i += 2u + olen;
    }
    return 0;
}

static bool is_amiga_xid(const pnet_sort_t *s, uint32_t xid) {
    for (unsigned i = 0; i < s->nxid; i++)
        if (s->xid[i] == xid) return true;
    return false;
}

void pnet_sort_init(pnet_sort_t *s) { memset(s, 0, sizeof *s); }

pnet_sort_to_t pnet_sort_rx(pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip) {
    if (len < ETH_HDR) return PNET_SORT_BOARD;
    const uint32_t amiga = s->amiga_ip != board_ip ? s->amiga_ip : 0u;   /* never the board's */
    if (be16(f + 12) == 0x0806u) {
        if (amiga == 0u || len < ETH_HDR + 28u) return PNET_SORT_BOARD;
        const uint8_t *a = f + ETH_HDR;
        if (be16(a) != 1u || be16(a + 2) != 0x0800u || a[4] != 6u || a[5] != 4u) return PNET_SORT_BOARD;
        if (be32(a + 24) != amiga) return PNET_SORT_BOARD;             /* target protocol address */
        s->to_both++;
        return PNET_SORT_BOTH;
    }
    ip4_t ip;
    if (!ip4(f, len, &ip)) return PNET_SORT_BOARD;
    const size_t b = bootp_at(f, len, &ip, 67u, 68u);
    if (b != 0u && f[b] == 2u) {                                       /* a BOOTREPLY */
        const uint32_t xid = be32(f + b + 4u), yi = be32(f + b + 16u);
        const uint8_t type = dhcp_type(f, len, b);
        if (is_amiga_xid(s, xid)) {
            if (type == 5u && board_ip != 0u && yi == board_ip) { s->clash++; return PNET_SORT_DROP; }
            if (type == 5u && yi != 0u) s->amiga_ip = yi;
            s->to_amiga++;
            return PNET_SORT_AMIGA;
        }
        if (type == 5u && amiga != 0u && yi == amiga) s->clash++;    /* the board's lease, logged */
        return PNET_SORT_BOARD;
    }
    if (amiga != 0u && ip.dst == amiga) { s->to_amiga++; return PNET_SORT_AMIGA; }
    return PNET_SORT_BOARD;
}

static void learn_xid(pnet_sort_t *s, uint32_t xid) {
    if (is_amiga_xid(s, xid)) return;
    s->xid[s->xid_next] = xid;
    s->xid_next = (uint8_t)((s->xid_next + 1u) % PNET_SORT_XIDS);
    if (s->nxid < PNET_SORT_XIDS) s->nxid++;
}

pnet_tx_t pnet_sort_tx(pnet_sort_t *s, const uint8_t *f, size_t len, const uint8_t mac[6], uint32_t board_ip) {
    if (len < ETH_HDR || len > PNET_SORT_MTU) return PNET_TX_LEN;
    if (memcmp(f + 6, mac, 6) != 0) return PNET_TX_MAC;
    const uint16_t type = be16(f + 12);
    if (type == 0x0806u) {
        if (len < ETH_HDR + 28u) return PNET_TX_LEN;
        const uint32_t spa = be32(f + ETH_HDR + 14u);
        if (spa != 0u && spa == board_ip) return PNET_TX_CLASH;
        if (spa != 0u) s->amiga_ip = spa;
        return PNET_TX_SEND;
    }
    if (type != 0x0800u) return PNET_TX_TYPE;
    ip4_t ip;
    if (!ip4(f, len, &ip)) return PNET_TX_LEN;
    if (ip.src != 0u && ip.src == board_ip) return PNET_TX_CLASH;
    const size_t b = bootp_at(f, len, &ip, 68u, 67u);
    if (b != 0u && f[b] == 1u) learn_xid(s, be32(f + b + 4u));
    else if (ip.src != 0u) s->amiga_ip = ip.src;
    return PNET_TX_SEND;
}

size_t pnet_dhcp_client_id(uint8_t *opts, size_t used, size_t cap, const uint8_t mac[6]) {
    static const uint8_t pre[5] = {61u, 9u, 0x00u, 'w', 'f'};
    if (used > cap || cap - used < PNET_CLIENT_ID_BYTES) return used;
    memcpy(opts + used, pre, sizeof pre);
    memcpy(opts + used + sizeof pre, mac, 6);
    return used + PNET_CLIENT_ID_BYTES;
}

void pnet_ip_text(uint32_t ip, char out[16]) {
    snprintf(out, 16, "%u.%u.%u.%u", (unsigned)(ip >> 24), (unsigned)(ip >> 16 & 255u),
             (unsigned)(ip >> 8 & 255u), (unsigned)(ip & 255u));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: the `test_pnet_sort.c: N checks, 0 failed` line, and `exit 0`.

- [ ] **Step 6: Mutation proofs.** Do each, see the named test fail, then revert:
  - In `pnet_sort_rx`, delete the `if (type == 5u && board_ip != 0u && yi == board_ip) …` line:
    `an_ack_naming_the_boards_address_is_refused` must fail.
  - Change `s->amiga_ip != board_ip ? s->amiga_ip : 0u` to `s->amiga_ip`: `a_clash_never_steals_the_boards_traffic`
    must fail.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_sort.h wifi-floppy/firmware/src/pnet_sort.c wifi-floppy/firmware/test/test_pnet_sort.c
git commit -m "feat(fw): pnet_sort, the layer-2 sharing frame sorter (PaulaNET Phase 1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The cross-core frame rings (`pnet_ring`)

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_ring.h`, `wifi-floppy/firmware/src/pnet_ring.c`
- Test: `wifi-floppy/firmware/test/test_pnet_ring.c`
- Modify: `wifi-floppy/firmware/test/run.sh`: add `-pthread` to the `cc` line that builds every `test_*.c`.

**Interfaces:**
- Consumes: nothing.
- Produces:

```c
#define PNET_RING_MTU  1518u
#define PNET_RING_SLOT 1536u
typedef struct {
    uint8_t *slots;           /* n * PNET_RING_SLOT bytes (PSRAM on the board) */
    uint32_t n;               /* a power of two */
    volatile uint32_t head;   /* the producer's: slots published (free-running) */
    volatile uint32_t tail;   /* the consumer's: slots released (free-running) */
    volatile uint32_t drops;  /* the producer's: frames refused (full, or a bad length) */
} pnet_ring_t;
bool pnet_ring_init(pnet_ring_t *r, uint8_t *mem, uint32_t n);
uint32_t pnet_ring_count(const pnet_ring_t *r);
uint32_t pnet_ring_space(const pnet_ring_t *r);
uint8_t *pnet_ring_claim(pnet_ring_t *r);                 /* producer */
void pnet_ring_commit(pnet_ring_t *r, uint16_t len);       /* producer */
bool pnet_ring_push(pnet_ring_t *r, const uint8_t *f, uint16_t len);   /* producer */
const uint8_t *pnet_ring_peek(const pnet_ring_t *r, uint32_t i, uint16_t *len);   /* consumer */
void pnet_ring_drop(pnet_ring_t *r, uint32_t k);           /* consumer */
```

- [ ] **Step 1: Write the header** `wifi-floppy/firmware/src/pnet_ring.h`:

```c
#ifndef PNET_RING_H
#define PNET_RING_H
/*
 * PaulaNET Phase 1's frame rings: fixed slots, one producer and one consumer on DIFFERENT cores.
 * RX: core1's netif input hook produces, core0 consumes (into the batch the Amiga reads).
 * TX: core0 produces (the Amiga's batch), core1's send worker consumes.
 *
 * THE HANDOFF. head and tail are free-running counters in SRAM; the slots are in PSRAM, which both
 * cores reach through the RP2350's one shared XIP cache (psram_image.c relies on the same).
 *   producer: write the slot's bytes and length -> barrier -> head++   (publish)
 *   consumer: load head -> barrier -> read the slot                    (acquire)
 *   consumer: finish reading -> barrier -> tail += k                   (release the slots)
 *   producer: load tail -> barrier -> overwrite a freed slot           (acquire)
 * The barrier is __dmb() on the board and a sequentially consistent fence on the host, whose test
 * runs a real producer thread against a consumer.
 *
 * A slot: the length (uint16_t, native order) at 0, the frame at 16. A frame is 1..PNET_RING_MTU.
 */
#include <stdint.h>
#include <stdbool.h>

#define PNET_RING_MTU  1518u
#define PNET_RING_SLOT 1536u

typedef struct {
    uint8_t *slots;
    uint32_t n;
    volatile uint32_t head;
    volatile uint32_t tail;
    volatile uint32_t drops;
} pnet_ring_t;

/* False (and an empty, refusing ring) unless n is a power of two. */
bool pnet_ring_init(pnet_ring_t *r, uint8_t *mem, uint32_t n);
uint32_t pnet_ring_count(const pnet_ring_t *r);
uint32_t pnet_ring_space(const pnet_ring_t *r);
/* Producer: the next slot's frame bytes to fill in place, or NULL (full; counted in drops). */
uint8_t *pnet_ring_claim(pnet_ring_t *r);
/* Producer: publishes the claimed slot with `len` bytes (1..PNET_RING_MTU). */
void pnet_ring_commit(pnet_ring_t *r, uint16_t len);
/* Producer: claim + copy + commit. False when full or len is 0 or over PNET_RING_MTU (counted). */
bool pnet_ring_push(pnet_ring_t *r, const uint8_t *f, uint16_t len);
/* Consumer: the i-th frame past the tail, or NULL when there are not i + 1. */
const uint8_t *pnet_ring_peek(const pnet_ring_t *r, uint32_t i, uint16_t *len);
/* Consumer: releases the first k frames (at most count). */
void pnet_ring_drop(pnet_ring_t *r, uint32_t k);
#endif
```

- [ ] **Step 2: Add `-pthread` to `run.sh`.** In the `cc -std=c11 -D_DEFAULT_SOURCE -g -O1 -Wall -Wextra -Werror …`
  line, insert `-pthread` after `-O1`. Add one comment line above the loop:
  `# -pthread: test_pnet_ring.c runs a real producer thread against its consumer (Linux needs the flag).`

- [ ] **Step 3: Write the failing test** `wifi-floppy/firmware/test/test_pnet_ring.c`:

```c
#include "harness.h"
#include "../src/pnet_ring.h"
#include <pthread.h>
#include <stdint.h>
#include <string.h>

static uint8_t mem[64 * PNET_RING_SLOT];

static void frames_come_out_in_order(void) {
    pnet_ring_t r;
    CHECK(pnet_ring_init(&r, mem, 4), "4 is a power of two");
    const uint8_t a[3] = {1, 2, 3}, b[1] = {9};
    CHECK(pnet_ring_push(&r, a, 3) && pnet_ring_push(&r, b, 1), "two pushes");
    CHECK_EQ_INT(pnet_ring_count(&r), 2);
    CHECK_EQ_INT(pnet_ring_space(&r), 2);
    uint16_t len = 0;
    const uint8_t *p = pnet_ring_peek(&r, 0, &len);
    CHECK(p && len == 3 && p[0] == 1 && p[2] == 3, "first");
    p = pnet_ring_peek(&r, 1, &len);
    CHECK(p && len == 1 && p[0] == 9, "second, by index");
    CHECK(pnet_ring_peek(&r, 2, &len) == NULL, "no third");
    pnet_ring_drop(&r, 1);
    p = pnet_ring_peek(&r, 0, &len);
    CHECK(p && len == 1 && p[0] == 9, "after the drop the second is first");
}

static void a_full_ring_drops_and_counts(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    uint8_t f[PNET_RING_MTU];
    for (unsigned i = 0; i < 4; i++) { memset(f, (int)i, sizeof f); CHECK(pnet_ring_push(&r, f, PNET_RING_MTU), "fits"); }
    CHECK(!pnet_ring_push(&r, f, 64), "a fifth does not");
    CHECK(pnet_ring_claim(&r) == NULL, "nor a claim");
    CHECK_EQ_INT(r.drops, 2);
    uint16_t len;
    const uint8_t *p = pnet_ring_peek(&r, 3, &len);
    CHECK(p && len == PNET_RING_MTU && p[0] == 3 && p[PNET_RING_MTU - 1] == 3, "the fourth intact");
    /* Nothing was written past the four slots. */
    CHECK_EQ_INT(mem[4 * PNET_RING_SLOT], 0);
    pnet_ring_drop(&r, 2);
    CHECK_EQ_INT(pnet_ring_space(&r), 2);
    CHECK(pnet_ring_push(&r, f, 64), "room again");
}

static void bad_lengths_are_refused(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    uint8_t f[PNET_RING_MTU + 1];
    memset(f, 0, sizeof f);
    CHECK(!pnet_ring_push(&r, f, 0), "empty");
    CHECK(!pnet_ring_push(&r, f, PNET_RING_MTU + 1), "too long");
    CHECK_EQ_INT(pnet_ring_count(&r), 0);
    CHECK_EQ_INT(r.drops, 2);
}

static void claim_and_commit_fill_in_place(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    uint8_t *d = pnet_ring_claim(&r);
    CHECK(d != NULL, "a slot");
    CHECK_EQ_INT(pnet_ring_count(&r), 0);                    /* not published yet */
    d[0] = 0xAB; d[99] = 0xCD;
    pnet_ring_commit(&r, 100);
    uint16_t len;
    const uint8_t *p = pnet_ring_peek(&r, 0, &len);
    CHECK(p == d && len == 100 && p[99] == 0xCD, "the claimed bytes, published");
}

static void indices_wrap(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    r.head = r.tail = 0xFFFFFFFEu;
    const uint8_t f[2] = {7, 8};
    for (unsigned i = 0; i < 4; i++) CHECK(pnet_ring_push(&r, f, 2), "across the wrap");
    CHECK_EQ_INT(pnet_ring_count(&r), 4);
    CHECK_EQ_INT(pnet_ring_space(&r), 0);
    pnet_ring_drop(&r, 9);                                   /* more than there are: all */
    CHECK_EQ_INT(pnet_ring_count(&r), 0);
    CHECK_EQ_INT(r.tail, 2);
}

static void init_refuses_what_is_not_a_power_of_two(void) {
    pnet_ring_t r;
    CHECK(!pnet_ring_init(&r, mem, 6), "6");
    CHECK(!pnet_ring_init(&r, mem, 0), "0");
    const uint8_t f[1] = {1};
    CHECK(!pnet_ring_push(&r, f, 1), "and the ring refuses");
}

/* A real second thread: the producer pushes T frames, each length and content a function of its
 * sequence number; the consumer checks every one, in order. A missing barrier shows as a frame
 * whose length or bytes are not yet (or no longer) the ones published. */
#define T_FRAMES 200000u
static pnet_ring_t tr;
static uint16_t len_of(uint32_t i) { return (uint16_t)(1u + (i * 7u) % PNET_RING_MTU); }
static void *producer(void *arg) {
    (void)arg;
    static uint8_t f[PNET_RING_MTU];
    for (uint32_t i = 0; i < T_FRAMES;) {
        const uint16_t n = len_of(i);
        memset(f, (int)(i & 0xFFu), n);
        if (pnet_ring_push(&tr, f, n)) i++;
    }
    return NULL;
}
static void the_ring_survives_two_threads(void) {
    pnet_ring_init(&tr, mem, 8);
    pthread_t t;
    CHECK(pthread_create(&t, NULL, producer, NULL) == 0, "thread");
    uint32_t bad = 0;
    for (uint32_t i = 0; i < T_FRAMES;) {
        uint16_t n;
        const uint8_t *p = pnet_ring_peek(&tr, 0, &n);
        if (!p) continue;
        const uint8_t v = (uint8_t)(i & 0xFFu);
        if (n != len_of(i) || p[0] != v || p[n - 1] != v || p[n / 2] != v) bad++;
        pnet_ring_drop(&tr, 1);
        i++;
    }
    pthread_join(t, NULL);
    CHECK_EQ_INT(bad, 0);
    CHECK_EQ_INT(pnet_ring_count(&tr), 0);
}

int main(void) {
    RUN(frames_come_out_in_order);
    RUN(a_full_ring_drops_and_counts);
    RUN(bad_lengths_are_refused);
    RUN(claim_and_commit_fill_in_place);
    RUN(indices_wrap);
    RUN(init_refuses_what_is_not_a_power_of_two);
    RUN(the_ring_survives_two_threads);
    return REPORT();
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_ring|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_ring.c`.

- [ ] **Step 5: Implement** `wifi-floppy/firmware/src/pnet_ring.c`:

```c
/* PaulaNET Phase 1's frame rings (pnet_ring.h). */
#include "pnet_ring.h"
#include <string.h>
#ifdef WFMF_HOST_TEST
#define RING_BARRIER() __atomic_thread_fence(__ATOMIC_SEQ_CST)
#else
#include "hardware/sync.h"
#define RING_BARRIER() __dmb()
#endif

#define LEN_AT  0u
#define DATA_AT 16u
_Static_assert(DATA_AT + PNET_RING_MTU <= PNET_RING_SLOT, "a frame fits its slot");

static uint8_t *slot(const pnet_ring_t *r, uint32_t i) {
    return r->slots + (size_t)(i & (r->n - 1u)) * PNET_RING_SLOT;
}

bool pnet_ring_init(pnet_ring_t *r, uint8_t *mem, uint32_t n) {
    const bool ok = n != 0u && (n & (n - 1u)) == 0u;
    r->slots = mem;
    r->n = ok ? n : 0u;
    r->head = r->tail = 0u;
    r->drops = 0u;
    return ok;
}

uint32_t pnet_ring_count(const pnet_ring_t *r) {
    const uint32_t h = r->head, t = r->tail;
    RING_BARRIER();                       /* acquire: slot reads (or overwrites) come after */
    return h - t;
}

uint32_t pnet_ring_space(const pnet_ring_t *r) { return r->n - pnet_ring_count(r); }

uint8_t *pnet_ring_claim(pnet_ring_t *r) {
    if (pnet_ring_space(r) == 0u) { r->drops = r->drops + 1u; return NULL; }
    return slot(r, r->head) + DATA_AT;
}

void pnet_ring_commit(pnet_ring_t *r, uint16_t len) {
    memcpy(slot(r, r->head) + LEN_AT, &len, sizeof len);
    RING_BARRIER();                       /* release: the bytes before the index that publishes them */
    r->head = r->head + 1u;
}

bool pnet_ring_push(pnet_ring_t *r, const uint8_t *f, uint16_t len) {
    if (len == 0u || len > PNET_RING_MTU) { r->drops = r->drops + 1u; return false; }
    uint8_t *d = pnet_ring_claim(r);
    if (!d) return false;
    memcpy(d, f, len);
    pnet_ring_commit(r, len);
    return true;
}

const uint8_t *pnet_ring_peek(const pnet_ring_t *r, uint32_t i, uint16_t *len) {
    if (i >= pnet_ring_count(r)) return NULL;
    const uint8_t *s = slot(r, r->tail + i);
    memcpy(len, s + LEN_AT, sizeof *len);
    return s + DATA_AT;
}

void pnet_ring_drop(pnet_ring_t *r, uint32_t k) {
    const uint32_t c = pnet_ring_count(r);
    if (k > c) k = c;
    RING_BARRIER();                       /* release: every read of these slots before freeing them */
    r->tail = r->tail + k;
}
```

  Two notes:
  - `pnet_ring_space` of an un-inited ring (`n == 0`) is 0. That is why `init_refuses_…` passes: the refusing ring
    claims nothing.
  - `pnet_ring_claim` is used by the input hook (pbuf to slot in place, Task 5). `pnet_ring_push` is used by core0's
    commit (Task 6).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `test_pnet_ring.c: N checks, 0 failed` and `exit 0`.

- [ ] **Step 7: Mutation proof.** In `pnet_ring_commit`, move `r->head = r->head + 1u;` ABOVE the `memcpy`, so the
  index is published before the length. Run the tests a few times: `the_ring_survives_two_threads` should report
  `bad` greater than 0 (on Apple silicon, which reorders, it does so within a run or two). Revert. If it never fails
  in five runs, say so in the report: the test still guards order on Linux CI, but the mutation was not seen.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_ring.h wifi-floppy/firmware/src/pnet_ring.c wifi-floppy/firmware/test/test_pnet_ring.c wifi-floppy/firmware/test/run.sh
git commit -m "feat(fw): pnet_ring, fixed-slot cross-core frame rings (PaulaNET Phase 1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: PaulaNET's counters for real frames (`pnet_link`), and a GCC run of Tasks 2-4

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_link.h`, `wifi-floppy/firmware/src/pnet_link.c`
- Test: `wifi-floppy/firmware/test/test_pnet_link.c`

**Interfaces:**
- Consumes: `pnet_hdr_t`, `PNET_MAX_FRAMES` and `pnet_to_amiga_bound` from `pnet_frame.h` (Phase 0).
- Produces:

```c
#define PNET_CANRECEIVE   1u        /* PacketsHeader flag: more frames wait than this batch holds */
#define PNET_OTA_QUIET_MS 10000u
typedef enum { PNET_TAKE_NEW, PNET_TAKE_DUP, PNET_TAKE_FULL } pnet_take_t;
typedef struct {
    uint8_t  last_amiga, pico;  /* 0xFF / 0x7F at start, as PaulaNET's */
    bool     backup;            /* a batch is out, not yet acknowledged */
    uint8_t  nframes;           /* its frames: the first nframes of the RX ring */
    uint32_t fresh, dup, txfull, acked;
} pnet_link_t;
void pnet_link_init(pnet_link_t *s);
unsigned pnet_link_ack(pnet_link_t *s, const pnet_hdr_t *h);
bool pnet_link_is_new(const pnet_link_t *s, const pnet_hdr_t *h);
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, unsigned n, uint32_t tx_space);
unsigned pnet_link_fit(const uint16_t *lens, unsigned avail, size_t cap);
void pnet_link_start(pnet_link_t *s, unsigned n);
bool pnet_ota_quiet(uint32_t now_ms, uint32_t last_ms, bool tx_pending);
```

- [ ] **Step 1: Write the header** `wifi-floppy/firmware/src/pnet_link.h`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef PNET_LINK_H
#define PNET_LINK_H
/*
 * PaulaNET Phase 1: the counter/acknowledge rule for real frames (Phase 0's pnet_loop.h has it for
 * the echo). Pure; core0 acts (main.c). Implemented from the protocol's description; no code of his.
 *
 * Each side bumps its own 8-bit counter per new batch and echoes the other's.
 *  - The Amiga's batch: new when its amiga counter differs from the last one taken. Taken only if
 *    the TX ring holds ALL its frames -- otherwise not taken at all, so its counter goes
 *    unacknowledged and the Amiga resends it (no frame goes out half or twice).
 *  - Our batch: the first `nframes` frames of the RX ring, built under counter `pico`. It stays out
 *    -- rebuilt unchanged whenever DF1's buffer is rebuilt -- until an Amiga header echoes `pico`;
 *    only then do its frames leave the ring (main.c drops them) and may a new batch start.
 *  - An empty batch (nothing waiting) does not move `pico`.
 */
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "pnet_frame.h"

#define PNET_CANRECEIVE   1u
#define PNET_OTA_QUIET_MS 10000u

typedef enum { PNET_TAKE_NEW, PNET_TAKE_DUP, PNET_TAKE_FULL } pnet_take_t;

typedef struct {
    uint8_t  last_amiga, pico;
    bool     backup;
    uint8_t  nframes;
    uint32_t fresh, dup, txfull, acked;
} pnet_link_t;

void pnet_link_init(pnet_link_t *s);
/* The acknowledgement in a valid Amiga header: the number of frames it frees (0 if none). */
unsigned pnet_link_ack(pnet_link_t *s, const pnet_hdr_t *h);
bool pnet_link_is_new(const pnet_link_t *s, const pnet_hdr_t *h);
/* A parsed Amiga batch of n frames: NEW (the caller queues the frames), DUP, or FULL (n > tx_space:
 * not taken). Counts each. */
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, unsigned n, uint32_t tx_space);
/* How many of the first `avail` waiting frames (lengths lens[]) one batch to the Amiga holds within
 * `cap` bytes on the wire (pnet_to_amiga_bound), at most PNET_MAX_FRAMES. */
unsigned pnet_link_fit(const uint16_t *lens, unsigned avail, size_t cap);
/* A new batch of n frames goes out: pico moves on. No-op for n == 0 or while one is out. */
void pnet_link_start(pnet_link_t *s, unsigned n);
/* The OTA rule for Network mode: cylinder 77 quiet for PNET_OTA_QUIET_MS (last_ms 0 = never
 * active) and nothing queued for the radio. */
bool pnet_ota_quiet(uint32_t now_ms, uint32_t last_ms, bool tx_pending);
#endif
```

- [ ] **Step 2: Write the failing test** `wifi-floppy/firmware/test/test_pnet_link.c`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_link.h"
#include <stdint.h>
#include <string.h>

static pnet_hdr_t hdr(uint8_t amiga, uint8_t pico) {
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    h.mode = PNET_MODE_ETHERNET;
    h.amiga_ctr = amiga;
    h.pico_ctr = pico;
    return h;
}

static void counters_start_as_paulanets(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    CHECK_EQ_INT(s.last_amiga, 0xFF);
    CHECK_EQ_INT(s.pico, 0x7F);
    CHECK(!s.backup, "nothing out");
}

static void a_new_batch_is_taken_once(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_hdr_t h = hdr(0x00, 0x7F);
    CHECK(pnet_link_is_new(&s, &h), "new");
    CHECK_EQ_INT(pnet_link_take(&s, &h, 2, 32), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x00);
    CHECK(!pnet_link_is_new(&s, &h), "now a resend");
    CHECK_EQ_INT(pnet_link_take(&s, &h, 2, 32), PNET_TAKE_DUP);
    CHECK_EQ_INT(s.fresh, 1);
    CHECK_EQ_INT(s.dup, 1);
    h = hdr(0x01, 0x7F);
    CHECK_EQ_INT(pnet_link_take(&s, &h, 0, 0), PNET_TAKE_NEW);   /* an empty batch fits anywhere */
}

static void a_batch_that_does_not_fit_the_tx_ring_is_not_taken(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_hdr_t h = hdr(0x05, 0x7F);
    CHECK_EQ_INT(pnet_link_take(&s, &h, 3, 2), PNET_TAKE_FULL);
    CHECK_EQ_INT(s.last_amiga, 0xFF);                       /* unacknowledged: the Amiga resends */
    CHECK_EQ_INT(s.txfull, 1);
    CHECK(pnet_link_is_new(&s, &h), "still new when it comes again");
    CHECK_EQ_INT(pnet_link_take(&s, &h, 3, 3), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x05);
}

static void an_ack_frees_the_batch_out(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 3);
    CHECK(s.backup && s.nframes == 3 && s.pico == 0x80, "out under 0x80");
    pnet_hdr_t h = hdr(0x00, 0x7F);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);                 /* echoes the old counter: no */
    h = hdr(0x00, 0x80);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 3);
    CHECK(!s.backup && s.nframes == 0, "freed");
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);                 /* the same ack again frees nothing */
    CHECK_EQ_INT(s.acked, 1);
}

static void an_unacknowledged_batch_is_rebuilt_unchanged(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 2);
    /* NetLoop restarted (or Ctrl-A-A): its first header echoes some other counter. */
    pnet_hdr_t h = hdr(0x42, 0x13);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);
    CHECK_EQ_INT(pnet_link_take(&s, &h, 0, 32), PNET_TAKE_NEW);
    pnet_link_start(&s, 5);                                 /* a caller trying to start over it */
    CHECK(s.backup && s.nframes == 2 && s.pico == 0x80, "the same two frames, the same counter");
}

static void empty_batches_do_not_move_the_counter(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 0);
    CHECK(!s.backup && s.pico == 0x7F, "nothing out, 0x7F");
}

static void counters_wrap(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    s.pico = 0xFF;
    pnet_link_start(&s, 1);
    CHECK_EQ_INT(s.pico, 0x00);
    pnet_hdr_t h = hdr(0x10, 0x00);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 1);
}

static void fit_respects_the_buffer_and_twenty_frames(void) {
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) lens[i] = 64;
    CHECK_EQ_INT(pnet_link_fit(lens, 25, 100000), PNET_MAX_FRAMES);
    CHECK_EQ_INT(pnet_link_fit(lens, 3, 100000), 3);
    CHECK_EQ_INT(pnet_link_fit(lens, 0, 100000), 0);
    for (unsigned i = 0; i < 25; i++) lens[i] = PNET_ETH_MTU;
    const size_t cap = 14336u - 80u;                        /* DF1's buffer less the extra lead-in */
    const unsigned n = pnet_link_fit(lens, 25, cap);
    CHECK(n >= 1, "one full frame always fits");
    CHECK(pnet_to_amiga_bound(lens, n) <= cap, "n fits");
    CHECK(pnet_to_amiga_bound(lens, n + 1) > cap, "n + 1 does not");
    /* And the builder agrees: n real frames build into exactly `cap` bytes or fewer. */
    static uint8_t frame[PNET_ETH_MTU], out[14336];
    for (unsigned i = 0; i < sizeof frame; i++) frame[i] = (uint8_t)(i * 37u);   /* RLE's worst case-ish */
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
    for (unsigned i = 0; i < n; i++) { f[i].data = frame; f[i].len = PNET_ETH_MTU; }
    CHECK(pnet_build_to_amiga(out, cap, 0, 0, 0, f, n) != 0, "built within cap");
}

static void ota_waits_for_quiet(void) {
    CHECK(pnet_ota_quiet(5000, 0, false), "never active");
    CHECK(!pnet_ota_quiet(5000, 0, true), "frames still queued");
    CHECK(!pnet_ota_quiet(19999, 10000, false), "9,999 ms");
    CHECK(pnet_ota_quiet(20000, 10000, false), "10,000 ms");
    CHECK(!pnet_ota_quiet(5, 0xFFFFFF00u, false), "across the wrap: 261 ms");
    CHECK(pnet_ota_quiet(10000u + 0x100u - 1u, 0xFFFFFF00u, false), "across the wrap: 10,255 ms");
}

int main(void) {
    RUN(counters_start_as_paulanets);
    RUN(a_new_batch_is_taken_once);
    RUN(a_batch_that_does_not_fit_the_tx_ring_is_not_taken);
    RUN(an_ack_frees_the_batch_out);
    RUN(an_unacknowledged_batch_is_rebuilt_unchanged);
    RUN(empty_batches_do_not_move_the_counter);
    RUN(counters_wrap);
    RUN(fit_respects_the_buffer_and_twenty_frames);
    RUN(ota_waits_for_quiet);
    return REPORT();
}
```

  The wrap arithmetic: with `last = 0xFFFFFF00` (256 ms before the counter wraps), `now = 5` is 261 ms later, and
  `now = 10,255` is 10,511 ms later. If a constant looks wrong to the implementer, compute it, fix the constant (never
  the rule), and say so.

- [ ] **Step 3: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_link|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_link.c`.

- [ ] **Step 4: Implement** `wifi-floppy/firmware/src/pnet_link.c`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* Implemented from the protocol's description; no code of his (see pnet_link.h). */
#include "pnet_link.h"
#include <string.h>

void pnet_link_init(pnet_link_t *s) {
    memset(s, 0, sizeof *s);
    s->last_amiga = 0xFFu;
    s->pico = 0x7Fu;
}

unsigned pnet_link_ack(pnet_link_t *s, const pnet_hdr_t *h) {
    if (!s->backup || h->pico_ctr != s->pico) return 0;
    const unsigned n = s->nframes;
    s->backup = false;
    s->nframes = 0;
    s->acked++;
    return n;
}

bool pnet_link_is_new(const pnet_link_t *s, const pnet_hdr_t *h) { return h->amiga_ctr != s->last_amiga; }

pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, unsigned n, uint32_t tx_space) {
    if (!pnet_link_is_new(s, h)) { s->dup++; return PNET_TAKE_DUP; }
    if (n > tx_space) { s->txfull++; return PNET_TAKE_FULL; }
    s->last_amiga = h->amiga_ctr;
    s->fresh++;
    return PNET_TAKE_NEW;
}

unsigned pnet_link_fit(const uint16_t *lens, unsigned avail, size_t cap) {
    if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
    unsigned n = 0;
    while (n < avail && pnet_to_amiga_bound(lens, n + 1u) <= cap) n++;
    return n;
}

void pnet_link_start(pnet_link_t *s, unsigned n) {
    if (n == 0u || s->backup) return;
    if (n > PNET_MAX_FRAMES) n = PNET_MAX_FRAMES;
    s->pico++;
    s->backup = true;
    s->nframes = (uint8_t)n;
}

bool pnet_ota_quiet(uint32_t now_ms, uint32_t last_ms, bool tx_pending) {
    if (tx_pending) return false;
    if (last_ms == 0u) return true;
    return (uint32_t)(now_ms - last_ms) >= PNET_OTA_QUIET_MS;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `wifi-floppy/firmware/test/run.sh; echo "exit $?"`
Expected: `test_pnet_link.c: N checks, 0 failed` and `exit 0`.

- [ ] **Step 6: Mutation proofs.** Do each, see the named test fail, then revert:
  - Drop `|| s->backup` from `pnet_link_start`: `an_unacknowledged_batch_is_rebuilt_unchanged` must fail.
  - Swap the `txfull` and `last_amiga` updates so the counter moves before the space check:
    `a_batch_that_does_not_fit_the_tx_ring_is_not_taken` must fail.

- [ ] **Step 7: The new tests under Linux GCC** (CI's compiler, which warns more than clang):

Run (repo root):
```bash
docker run --rm -v "$PWD/wifi-floppy/firmware":/fw -w /fw/test gcc:13 bash -c '
  for t in test_pnet_sort test_pnet_ring test_pnet_link; do
    gcc -std=c11 -D_DEFAULT_SOURCE -O1 -pthread -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 -o /tmp/$t $t.c \
      ../src/pnet_sort.c ../src/pnet_ring.c ../src/pnet_link.c ../src/pnet_frame.c ../src/pnet_mfm.c && /tmp/$t || exit 1
  done; echo GCC-OK'
```
Expected: three `… 0 failed` lines, then `GCC-OK`.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_link.h wifi-floppy/firmware/src/pnet_link.c wifi-floppy/firmware/test/test_pnet_link.c
git commit -m "feat(fw): pnet_link, PaulaNET's counter/ack for real frames, batch fit, OTA quiet rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The `WF_PNET_L2` build, the radio seam, the DHCP client-id hook, and the core1 bridge

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt`, directly after the `WF_PNET_LOOP` block's `endif ()` (the line after
  `message(STATUS "WF_PNET_LOOP is ON: …")`).
- Modify: `wifi-floppy/firmware/lwipopts.h`, before the final `#endif`.
- Create: `wifi-floppy/firmware/src/pnet_lwip_hooks.h`, `wifi-floppy/firmware/src/pnet_bridge.h`,
  `wifi-floppy/firmware/src/pnet_bridge.c`
- Modify: `wifi-floppy/firmware/src/net_radio.h` (before `#endif`), `wifi-floppy/firmware/src/net_radio_cyw43.c` (at
  the end)
- Modify: `wifi-floppy/firmware/test/run.sh`: exclude `pnet_bridge.c`, with a comment line in the excluded-files list.
- Modify: `wifi-floppy/firmware/tools/pnet_off_identical.sh`: the file list.
- Modify: `.gitignore`: `build-pnet1/`.

**Interfaces:**
- Consumes: Tasks 2-4 (`pnet_sort_*`, `pnet_ring_*`, `pnet_dhcp_client_id`).
- Produces (for Task 6):

```c
/* pnet_bridge.h */
extern pnet_ring_t g_pnet_rx;   /* core1's input hook produces, core0 consumes */
extern pnet_ring_t g_pnet_tx;   /* core0 produces, core1's send worker consumes */
typedef struct {
    uint32_t in_amiga, in_both, rx_drops, chained, hooks;
    uint32_t tx_sent, tx_err, tx_no[PNET_TX_N];
    uint32_t clash, amiga_ip, board_ip;
} pnet_bridge_stats_t;
void pnet_bridge_init(void);     /* core0, before core1 launches */
void pnet_bridge_start(void);    /* core1, after net_radio_sta_enable() */
void pnet_bridge_check(void);    /* core1, every loop pass */
void pnet_bridge_stats(pnet_bridge_stats_t *out);   /* any core: a copy for the log */
/* net_radio.h, WF_PNET_L2 only */
int  net_radio_send_ethernet(const void *frame, size_t len);
bool net_radio_every_ms(uint32_t ms, void (*fn)(void));
```

- [ ] **Step 1: The CMake option.** Insert after the `WF_PNET_LOOP` block:

```cmake
# PaulaNET Phase 1 (plan docs/superpowers/plans/2026-10-11-paulanet-phase1-l2-sharing.md): on the
# loopback's own transport, DF1 cylinder 77 carries real Ethernet frames, and the Amiga shares the
# board's Wi-Fi at layer 2 (research 2026-10-09 §2.2, option A). A bench TEST build only. It needs
# WF_PNET_LOOP, whose echo it replaces, so the image also carries that build's marker and the
# publish script refuses it without "TEST build" notes. OFF compiles none of it: every hook is under
# #if WF_PNET_L2 and these sources are not in the image.
option(WF_PNET_L2 "Bench TEST build: DF1 cylinder 77 carries Ethernet frames (PaulaNET Phase 1)" OFF)
list(APPEND WFMF_COMMON_DEFS WF_PNET_L2=$<IF:$<BOOL:${WF_PNET_L2}>,1,0>)
if (WF_PNET_L2)
  if (NOT WF_PNET_LOOP)
    message(FATAL_ERROR "WF_PNET_L2 needs WF_PNET_LOOP: Phase 1 replaces the loopback's echo on its transport")
  endif ()
  list(APPEND WFMF_FIRMWARE_SOURCES src/pnet_sort.c src/pnet_ring.c src/pnet_link.c src/pnet_bridge.c)
  message(STATUS "WF_PNET_L2 is ON: DF1 cylinder 77 carries Ethernet frames (TEST build only).")
endif ()
```

  It must sit before the `foreach(src IN LISTS WFMF_FIRMWARE_SOURCES)` frame-limit loop, so that the new sources get
  `-Werror=frame-larger-than=768`.

- [ ] **Step 2: The DHCP hook.** Create `wifi-floppy/firmware/src/pnet_lwip_hooks.h`:

```c
#ifndef PNET_LWIP_HOOKS_H
#define PNET_LWIP_HOOKS_H
// lwIP's hook file (LWIP_HOOK_FILENAME, lwipopts.h), WF_PNET_L2 builds only. Every lwIP source
// includes it; only dhcp.c uses the hook.
//
// The board and the Amiga share one MAC (PaulaNET Phase 1), so both stacks put it in chaddr. The
// Amiga's AmiTCP_NG sends client-id 01:<MAC>; lwIP sends none, and a router that matches a lease
// by client-id falling back to chaddr would then hand both the same address. So the board sends a
// client-id of its own, in every DHCP message lwIP builds (dhcp.c calls this hook for DISCOVER,
// REQUEST, REBIND, DECLINE, INFORM and RELEASE). The trailer needs one byte: hence the - 1.
#include "pnet_sort.h"
#define LWIP_HOOK_DHCP_APPEND_OPTIONS(netif, dhcp, state, msg, msg_type, options_len_ptr)      \
    do {                                                                                      \
        *(options_len_ptr) = (u16_t)pnet_dhcp_client_id((msg)->options, *(options_len_ptr),   \
                                                        DHCP_OPTIONS_LEN - 1u, (netif)->hwaddr); \
    } while (0)
#endif
```

  In `wifi-floppy/firmware/lwipopts.h`, before the final `#endif`, add:

```c
// PaulaNET Phase 1 (WF_PNET_L2 TEST builds): the board's own DHCP client-id. See the hook file.
#if WF_PNET_L2
#define LWIP_HOOK_FILENAME "pnet_lwip_hooks.h"
#endif
```

  If the build later warns that `dhcp`, `state` or `msg_type` is unused in `dhcp.c`, add `(void)(state);`-style casts
  for exactly the ones named. Do not cast `dhcp`, because one call site passes `&dhcp`. SDK sources are not built
  with `-Werror`, so a warning is not a failure.

- [ ] **Step 3: The radio seam.** In `wifi-floppy/firmware/src/net_radio.h`, before the final `#endif`:

```c
#if WF_PNET_L2
#include <stddef.h>
/** PaulaNET Phase 1: one Ethernet frame out of the station interface, as is (the Amiga's, with
 *  the board's own MAC as its source). 0 on success. From the network context (a worker added
 *  with net_radio_every_ms), or core1 under net_radio_lock(). */
int  net_radio_send_ethernet(const void *frame, size_t len);
/** Runs fn every `ms` in the network context on core1, with the lwIP lock held -- the context the
 *  driver's own receive and lwIP's timers run in. Core1 only; one such worker. False on failure. */
bool net_radio_every_ms(uint32_t ms, void (*fn)(void));
#endif
```

  At the end of `wifi-floppy/firmware/src/net_radio_cyw43.c`:

```c
#if WF_PNET_L2
// PaulaNET Phase 1 (plan 2026-10-11). The send copies the frame into the driver's own SPI buffer
// (cyw43_ll_send_ethernet's memmove), so a PSRAM source is fine. The worker re-adds itself, the
// pattern async_context documents for a periodic at-time worker.
#include "pico/async_context.h"
int net_radio_send_ethernet(const void *frame, size_t len) {
    return cyw43_send_ethernet(&cyw43_state, CYW43_ITF_STA, len, frame, false);
}
static void (*s_every_fn)(void);
static uint32_t s_every_ms;
static void every_work(async_context_t *ctx, async_at_time_worker_t *w) {
    s_every_fn();
    async_context_add_at_time_worker_in_ms(ctx, w, s_every_ms);
}
static async_at_time_worker_t s_every = { .do_work = every_work };
bool net_radio_every_ms(uint32_t ms, void (*fn)(void)) {
    s_every_fn = fn;
    s_every_ms = ms;
    return async_context_add_at_time_worker_in_ms(cyw43_arch_async_context(), &s_every, ms);
}
#endif
```

- [ ] **Step 4: The bridge header** `wifi-floppy/firmware/src/pnet_bridge.h`:

```c
#ifndef PNET_BRIDGE_H
#define PNET_BRIDGE_H
// PaulaNET Phase 1 (WF_PNET_L2 TEST builds): the radio side of layer-2 sharing, on core1.
// Plan docs/superpowers/plans/2026-10-11-paulanet-phase1-l2-sharing.md, rulings 3-9.
#include <stdint.h>
#include "pnet_ring.h"
#include "pnet_sort.h"

extern pnet_ring_t g_pnet_rx;   // core1's input hook produces; core0 consumes
extern pnet_ring_t g_pnet_tx;   // core0 produces; core1's send worker consumes

typedef struct {
    uint32_t in_amiga, in_both;   // frames queued for the Amiga: its only / shared with the board
    uint32_t rx_drops;            // ...refused: the RX ring full, or too long
    uint32_t chained;             // frames whose first pbuf was not the whole frame (sorted on it)
    uint32_t hooks;               // times the input hook was (re)installed
    uint32_t tx_sent, tx_err;     // the Amiga's frames handed to the radio / refused by it
    uint32_t tx_no[PNET_TX_N];    // ...not sent, by pnet_tx_t reason ([PNET_TX_SEND] unused)
    uint32_t clash;               // pnet_sort_t.clash
    uint32_t amiga_ip, board_ip;  // as last seen by core1 (host order; 0 = unknown)
} pnet_bridge_stats_t;

void pnet_bridge_init(void);      // core0, before core1 launches: the rings over PSRAM
void pnet_bridge_start(void);     // core1, after net_radio_sta_enable(): the hook and the send worker
void pnet_bridge_check(void);     // core1, every loop pass: re-install the hook if the netif was re-added
void pnet_bridge_stats(pnet_bridge_stats_t *out);
#endif
```

- [ ] **Step 5: The bridge** `wifi-floppy/firmware/src/pnet_bridge.c`. Device-only. Every comment line must avoid the
  chip's name (Global Constraints).

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
// PaulaNET Phase 1, core1 (pnet_bridge.h). Device-only: excluded from the host build by run.sh;
// every decision it acts on is pnet_sort.c / pnet_ring.c, which are tested.
//
// RECEIVE. The radio driver copies each received frame into one PBUF_POOL pbuf and calls the
// station netif's input (lib/cyw43-driver/src/cyw43_lwip.c, cyw43_cb_process_ethernet). We sit
// there: an Amiga-only frame is copied into the PSRAM RX ring and its pbuf freed at once, so the
// pool the TLS receive window depends on (lwipopts.h) is never held by the Amiga; a board frame
// goes on to lwIP's own input, unchanged. This runs in the network context, the lwIP lock held.
//
// SEND. A 2 ms worker in the same context (net_radio_every_ms) hands up to PNET_TX_PER_TICK frames
// from the TX ring to the radio. Not core1's loop: that blocks for seconds inside the long poll.
#include "pnet_bridge.h"
#include "pnet_frame.h"        // PNET_MAX_FRAMES
#include "net_radio.h"
#include "wf_log.h"
#include "lwip/netif.h"
#include "lwip/pbuf.h"
#include "lwip/def.h"          // lwip_ntohl
#include "hardware/psram.h"    // psram_check_address
#include "pico/stdlib.h"

#define PNET_RX_SLOTS    64u
#define PNET_TX_SLOTS    32u
#define PNET_TX_TICK_MS  2u
#define PNET_TX_PER_TICK 8u
_Static_assert(PNET_TX_SLOTS >= PNET_MAX_FRAMES, "one whole batch always fits an empty TX ring");

static __uninitialized_psram("pnetrx") uint8_t s_rx_mem[PNET_RX_SLOTS * PNET_RING_SLOT];
static __uninitialized_psram("pnettx") uint8_t s_tx_mem[PNET_TX_SLOTS * PNET_RING_SLOT];
pnet_ring_t g_pnet_rx, g_pnet_tx;

static pnet_sort_t s_sort;           // the network context only
static netif_input_fn s_next;        // lwIP's own input, taken over by the hook
static volatile uint32_t s_in_amiga, s_in_both, s_big, s_chained, s_hooks, s_tx_sent, s_tx_err;
static volatile uint32_t s_tx_no[PNET_TX_N], s_board_ip;

void pnet_bridge_init(void) {
    pnet_ring_init(&g_pnet_rx, s_rx_mem, PNET_RX_SLOTS);
    pnet_ring_init(&g_pnet_tx, s_tx_mem, PNET_TX_SLOTS);
    if (!psram_check_address(&s_rx_mem[sizeof s_rx_mem - 1]) ||
        !psram_check_address(&s_tx_mem[sizeof s_tx_mem - 1]))
        wf_logf(WF_ERR, "pnet: the frame rings are not backed by PSRAM -- L2 sharing will fail");
}

static uint32_t board_ip_of(struct netif *nif) { return lwip_ntohl(ip4_addr_get_u32(netif_ip4_addr(nif))); }

static err_t pnet_input(struct pbuf *p, struct netif *nif) {
    if (p->len != p->tot_len) s_chained++;            // sorted on the first pbuf's bytes
    const pnet_sort_to_t to = pnet_sort_rx(&s_sort, (const uint8_t *)p->payload, p->len, board_ip_of(nif));
    if (to & PNET_SORT_AMIGA) {
        if (p->tot_len > PNET_RING_MTU) {
            s_big++;
        } else {
            uint8_t *d = pnet_ring_claim(&g_pnet_rx);   // NULL when full: counted in drops
            if (d) {
                pbuf_copy_partial(p, d, p->tot_len, 0);
                pnet_ring_commit(&g_pnet_rx, p->tot_len);
                if (to == PNET_SORT_BOTH) s_in_both++; else s_in_amiga++;
            }
        }
    }
    if (to & PNET_SORT_BOARD) return s_next(p, nif);  // lwIP's input owns p from here
    pbuf_free(p);
    return ERR_OK;
}

static void pnet_tx_tick(void) {
    struct netif *nif = net_radio_sta_netif();
    const uint32_t board_ip = board_ip_of(nif);
    s_board_ip = board_ip;
    for (unsigned k = 0; k < PNET_TX_PER_TICK; k++) {
        uint16_t len;
        const uint8_t *f = pnet_ring_peek(&g_pnet_tx, 0, &len);
        if (!f) break;
        const pnet_tx_t v = pnet_sort_tx(&s_sort, f, len, nif->hwaddr, board_ip);
        if (v != PNET_TX_SEND) s_tx_no[v]++;
        else if (net_radio_send_ethernet(f, len) == 0) s_tx_sent++;
        else s_tx_err++;
        pnet_ring_drop(&g_pnet_tx, 1);
    }
}

void pnet_bridge_check(void) {
    net_radio_lock();
    struct netif *nif = net_radio_sta_netif();
    if (nif->input != NULL && nif->input != pnet_input) {
        s_next = nif->input;
        nif->input = pnet_input;
        s_hooks++;
    }
    net_radio_unlock();
}

void pnet_bridge_start(void) {
    pnet_sort_init(&s_sort);                           // before the hook can run
    pnet_bridge_check();
    if (!net_radio_every_ms(PNET_TX_TICK_MS, pnet_tx_tick))
        wf_logf(WF_ERR, "pnet: no send worker -- the Amiga's frames will not go out");
    uint8_t m[6];
    net_radio_mac(m);
    wf_logf(WF_WARN, "pnet: L2 sharing on (TEST build), MAC %02x:%02x:%02x:%02x:%02x:%02x",
            m[0], m[1], m[2], m[3], m[4], m[5]);
}

void pnet_bridge_stats(pnet_bridge_stats_t *o) {
    o->in_amiga = s_in_amiga;
    o->in_both = s_in_both;
    o->rx_drops = g_pnet_rx.drops + s_big;
    o->chained = s_chained;
    o->hooks = s_hooks;
    o->tx_sent = s_tx_sent;
    o->tx_err = s_tx_err;
    for (unsigned i = 0; i < PNET_TX_N; i++) o->tx_no[i] = s_tx_no[i];
    o->clash = *(volatile uint32_t *)&s_sort.clash;    // written in the network context; a log reading
    o->amiga_ip = *(volatile uint32_t *)&s_sort.amiga_ip;
    o->board_ip = s_board_ip;
}
```

  Check: `pbuf_copy_partial`'s length argument is `u16_t`, and `p->tot_len` is `u16_t`. Also, `pnet_input` runs
  before `pnet_bridge_start` can finish only if a frame arrives between `pnet_bridge_check` and the logging below
  it, and `s_sort` is already initialised by then.

- [ ] **Step 6: Exclude the bridge from the host build.** In `run.sh`:
  - in the excluded-files comment block, add the line
    `#   pnet_bridge.c     - PaulaNET Phase 1's lwIP/radio glue; its decisions are pnet_sort.c and pnet_ring.c`;
  - in the `grep -vE` pattern, add `|pnet_bridge\.c` after `bus_out\.c`.

- [ ] **Step 7: Extend the identity check.** In `wifi-floppy/firmware/tools/pnet_off_identical.sh`:
  - change `for f in main.c flux_capture.c; do` to `for f in main.c flux_capture.c net_radio_cyw43.c; do`;
  - change its echo texts from `WF_PNET_LOOP=0` to `WF_PNET_LOOP=0 WF_PNET_L2=0`;
  - add to the header comment: `<base> is Task 1's commit of plan 2026-10-11 until that plan merges (its pio2 fix
    changes flux_capture.c in every build).`

  In `.gitignore`, under the `build-pnet/` line, add `build-pnet1/`.

- [ ] **Step 8: Build L2, build OFF, and check identity.**

Run:
```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build-pnet1 -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON | grep 'WF_PNET_L2 is ON' && cmake --build build-pnet1 >/dev/null && echo "L2 ok"
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF && cmake --build build >/dev/null && echo "OFF ok"
cmake -B build-x -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_L2=ON 2>&1 | grep -c 'needs WF_PNET_LOOP'; rm -rf build-x
tools/pnet_off_identical.sh "$(git log -1 --format=%H --grep='flux_in stays enabled')"
cd test && ./run.sh; echo "exit $?"
```
Expected: `WF_PNET_L2 is ON…`, `L2 ok`, `OFF ok`, `1` (the FATAL_ERROR), three `identical with …` lines, and
`exit 0`.

  Note: nothing calls the bridge yet. If the linker's garbage collection drops `pnet_bridge.c`, that is expected
  here; Task 6 wires it in.

- [ ] **Step 9: Measure the SRAM cost.** Run
  `arm-none-eabi-size -A build/wifi_floppy.elf build-pnet1/wifi_floppy.elf | grep -E '^\.(bss|data) '`, and record
  both builds' `.bss` and `.data` in the commit message. The L2 build includes Phase 0's loopback state too.
  Anything over +1,024 B of `.bss` against a `WF_PNET_LOOP=ON` build: stop and report.

- [ ] **Step 10: Commit**

```bash
git add wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/lwipopts.h wifi-floppy/firmware/src/pnet_lwip_hooks.h \
  wifi-floppy/firmware/src/pnet_bridge.h wifi-floppy/firmware/src/pnet_bridge.c wifi-floppy/firmware/src/net_radio.h \
  wifi-floppy/firmware/src/net_radio_cyw43.c wifi-floppy/firmware/test/run.sh wifi-floppy/firmware/tools/pnet_off_identical.sh .gitignore
git commit -m "feat(fw): WF_PNET_L2 TEST build, radio send/worker seam, DHCP client-id hook, core1 bridge

.bss/.data: <OFF> -> <L2> (measured, Task 5 Step 9).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Core0 carries real frames: batches from the RX ring, commits to the TX ring, the OTA rule, the heap

**Files:**
- Modify: `wifi-floppy/firmware/src/main.c`. Every change is under `#if WF_PNET_L2`, except the `side-idx` clamp,
  which is under `#if WF_PNET_LOOP`. The anchors are quoted text; line numbers drift.

**Interfaces:**
- Consumes: Task 4 (`pnet_link_*`, `PNET_CANRECEIVE`, `pnet_ota_quiet`), Task 5 (`g_pnet_rx`, `g_pnet_tx`,
  `pnet_bridge_*`), Task 2 (`pnet_ip_text`), and Phase 0's `g_pnet_echo`, `track_words1`, `pnet_build_to_amiga`,
  `pnet_parse_frames`, `heap_free_bytes`.
- Produces: the L2 TEST image's behaviour and the log lines Task 9 reads:
  - `pnet: L2 sharing on (TEST build), MAC …`;
  - `pnet: l2 in a <n> b <n> drop <n> q <n> sent <n> err <n>`;
  - `pnet: l2 tx no len <n> mac <n> type <n> clash <n> full <n> ack <n>`;
  - `pnet: l2 amiga <ip> board <ip> distinct|SAME clash <n> heap <bytes>`;
  - `fw: update held: cylinder 77 busy …`.

- [ ] **Step 1: Includes and the shared word.** In the top include block, inside `#if WF_PNET_LOOP` after
  `#include "pnet_loop.h"`, add:

```c
#if WF_PNET_L2
#include "pnet_link.h"       // PaulaNET Phase 1: counters for real frames
#include "pnet_bridge.h"     //   the rings and core1's radio side
#endif
```

  After `static volatile uint32_t g_motor_on_ms;`, add:

```c
#if WF_PNET_L2
// PaulaNET Phase 1: when cylinder 77 last carried a batch (a capture taken, or a batch streamed),
// clock_ms; 0 = never. core0 writes it; core1's update gate reads it (pnet_ota_quiet).
static volatile uint32_t g_pnet_last_ms;
#endif
```

- [ ] **Step 2: The OTA rule.** In core1's update gate, directly after the statement that ends
  `!gate_preload;` (the `bool idle = !gate_mounted && …` declaration), add:

```c
#if WF_PNET_L2
                {
                    // Network mode's idle (plan 2026-10-11 ruling 12): cylinder 77 quiet for 10 s and
                    // nothing queued for the radio, on top of everything above.
                    const bool tx_pending = pnet_ring_count(&g_pnet_tx) != 0;
                    const bool quiet = pnet_ota_quiet(clock_ms(), g_pnet_last_ms, tx_pending);
                    static bool held_logged;
                    if (!quiet && idle && fwu.phase == FWU_STAGED && !held_logged) {
                        wf_logf(WF_INFO, "fw: update held: cylinder 77 busy (%lu ms ago, %s)",
                                (unsigned long)(clock_ms() - g_pnet_last_ms),
                                tx_pending ? "frames queued" : "none queued");
                        held_logged = true;
                    }
                    if (quiet) held_logged = false;
                    if (!quiet) idle = false;
                }
#endif
```

  `idle` is declared `bool idle` (not `const`) at this anchor today. If it is `const`, drop the `const`, and say so.

- [ ] **Step 3: Core1 starts and re-checks the bridge.** In `core1_main`, after the closing `}` of the block that
  logs `pio claims: radio on pio2`, add:

```c
#if WF_PNET_L2
    pnet_bridge_start();          // the input hook and the send worker (plan 2026-10-11)
#endif
```

  At the top of core1's `while (true) {` pass loop, before `const uint32_t pass_write_mark = g_write_last_ms;`, add:

```c
#if WF_PNET_L2
            pnet_bridge_check();      // re-hooks if the radio side re-added its netif
#endif
```

- [ ] **Step 4: Core0 initialises the rings before core1 launches.** After
  `wf_logf(WF_WARN, "%s: DF1 cylinder 77 is a PaulaNET loopback (bench only)", wf_pnet_loop_marker);`, add:

```c
#if WF_PNET_L2
    pnet_bridge_init();           // the PSRAM rings, before core1 (their other side) starts
#endif
```

- [ ] **Step 5: Core0's state.** After `static pnet_loop_t g_pnet;                       // core0 only`, add:

```c
#if WF_PNET_L2
// Phase 1: the counters for real frames (pnet_link.h). g_pnet keeps the capture counts (rx, bad[]).
static pnet_link_t g_link;
// The heap low-water, sampled every loop pass (the 5 s heap: line can miss a dip; ruling 13).
static uint32_t    g_pnet_heap_low = UINT32_MAX;
// A batch's bytes on the wire within DF1's buffer, with the lead-in this build sends (pnet_frame.c).
#define PNET_BATCH_CAP (sizeof track_words1 - (PNET_TX_LEAD_BYTES - PNET_LEAD_BYTES))
#define PNET_CTR g_link
#else
#define PNET_CTR g_pnet
#endif
```

  In `pnet_log_summary`'s first `wf_logf` (`"pnet: rx %lu new %lu dup %lu bad %lu ctr %02x/%02x echo %u fr busy %lu"`),
  replace `g_pnet.fresh`, `g_pnet.dup`, `g_pnet.last_amiga`, `g_pnet.pico` and `g_pnet.nframes` with
  `PNET_CTR.fresh`, `PNET_CTR.dup`, `PNET_CTR.last_amiga`, `PNET_CTR.pico` and `PNET_CTR.nframes`. Keep
  `g_pnet.rx`. `pnet_link_t` has all five fields.

  `g_pnet_half` is read only by the echo code, which becomes the `#else` branches below. So wrap its definition
  (`static uint8_t     g_pnet_half;`) in `#if !WF_PNET_L2` … `#endif`, or the L2 build warns that it is unused.
  The firmware does not build with `-Werror`, but the warning would be noise.

  In `pnet_loop_init(&g_pnet);` (the boot block), add after it:

```c
#if WF_PNET_L2
    pnet_link_init(&g_link);
#endif
```

- [ ] **Step 6: The commit takes real frames.** In `pnet_take_capture`, replace the block from
  `if (pnet_loop_is_new(&g_pnet, &h)) {` through its matching `} else { pnet_loop_commit(&g_pnet, &h, 0, NULL); … }`
  with:

```c
#if WF_PNET_L2
    // Phase 1: the acknowledgement first (it may free our batch out), then the Amiga's frames into
    // the TX ring -- all of them, or the batch is not taken and the Amiga resends it (ruling 10).
    g_pnet_last_ms = clock_ms();
    const unsigned acked = pnet_link_ack(&g_link, &h);
    if (acked) pnet_ring_drop(&g_pnet_rx, acked);
    if (pnet_link_is_new(&g_link, &h)) {
        uint16_t lens[PNET_MAX_FRAMES];
        unsigned n = 0;
        uint8_t *const scratch = &g_pnet_echo[0][0];          // both halves: 32 KB holds 20 x 1518
        e = pnet_parse_frames(cap.bytes + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD,
                              scratch, sizeof g_pnet_echo, lens, PNET_MAX_FRAMES, &n);
        if (e != PNET_OK) {
            pnet_reject(e, &cap);
            return true;                                      // the ack above may have changed our batch
        }
        if (pnet_link_take(&g_link, &h, n, pnet_ring_space(&g_pnet_tx)) == PNET_TAKE_NEW) {
            const uint8_t *p = scratch;
            for (unsigned i = 0; i < n; i++) {
                pnet_ring_push(&g_pnet_tx, p, lens[i]);       // room checked by the take
                p += lens[i];
            }
        }
    } else {
        pnet_link_take(&g_link, &h, 0, 0);                    // counts the resend
    }
#else
    … the existing Phase 0 block, unchanged …
#endif
```

  The `#else` branch is the exact text that was replaced: move it, do not retype it. The timing lines after the block
  (`const uint64_t now = …` to `return true;`) stay as they are and serve both builds.

- [ ] **Step 7: The batch the Amiga reads comes from the RX ring.** In `pnet_prepare_echo`, replace the lines from
  `pnet_frame_ref_t f[PNET_MAX_FRAMES];` through the `pnet_build_to_amiga(...)` call with:

```c
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
#if WF_PNET_L2
    // Phase 1: our batch out, or -- when none is out -- a new one from what is waiting. It stays out,
    // rebuilt unchanged here, until the Amiga acknowledges it (ruling 10; pnet_link.h).
    if (!g_link.backup) {
        uint16_t lens[PNET_MAX_FRAMES];
        unsigned avail = pnet_ring_count(&g_pnet_rx);
        if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
        for (unsigned i = 0; i < avail; i++) (void)pnet_ring_peek(&g_pnet_rx, i, &lens[i]);
        pnet_link_start(&g_link, pnet_link_fit(lens, avail, PNET_BATCH_CAP));
    }
    for (unsigned i = 0; i < g_link.nframes; i++) f[i].data = pnet_ring_peek(&g_pnet_rx, i, &f[i].len);
    const uint8_t flags = pnet_ring_count(&g_pnet_rx) > g_link.nframes ? PNET_CANRECEIVE : 0u;
    const unsigned nf = g_link.nframes;
    const uint8_t ack = g_link.last_amiga, pico = g_link.pico;
#else
    const uint8_t *p = g_pnet_echo[g_pnet_half];
    for (unsigned i = 0; i < g_pnet.nframes; i++) {
        f[i].data = p;
        f[i].len = g_pnet.len[i];
        p += g_pnet.len[i];
    }
    const uint8_t flags = 0;
    const unsigned nf = g_pnet.nframes;
    const uint8_t ack = g_pnet.last_amiga, pico = g_pnet.pico;
#endif
    // Built as bytes straight into the word buffer, then repacked IN PLACE. … (keep the existing comment)
    uint8_t *out = (uint8_t *)track_words1;
    const size_t bytes = pnet_build_to_amiga(out, sizeof track_words1, ack, pico, flags, f, nf);
```

  Keep the `if (bytes == 0)` error log, using `nf` in place of `g_pnet.nframes`, and everything after it.

- [ ] **Step 8: A batch for frames that arrive while the head waits on side 0, the stream timestamp, the heap.**
  In core0's loop, inside `#if WF_PNET_LOOP`, directly after the `if (pnet_take_capture()) { … }` block and before
  `if (df1_mounted) pnet_serve_df1(df1_seen_tok, &loaded1);`, add:

```c
#if WF_PNET_L2
        // Frames came while nothing is out and the head sits on side 0 (the Amiga between its write
        // and its read, or idle there): build the batch now, before the Amiga turns to side 1 -- a
        // build at the SIDE edge is late (Phase 0, 0c89f65). Never while side 1 streams: that would
        // tear the read in progress.
        if (df1_mounted && loaded1 == PNET_TRACK_IN && !g_link.backup && pnet_ring_count(&g_pnet_rx) != 0)
            pnet_prepare_echo();
        {
            const uint32_t hf = heap_free_bytes();
            if (hf < g_pnet_heap_low) g_pnet_heap_low = hf;
        }
        pnet_l2_log();
#endif
```

  In `pnet_serve_df1`, after `g_pnet_echo_live = true;`, add:

```c
#if WF_PNET_L2
    g_pnet_last_ms = clock_ms();                 // the Amiga is reading cylinder 77
#endif
```

- [ ] **Step 9: The L2 log.** Directly above `pnet_log_summary`'s definition, add:

```c
#if WF_PNET_L2
// Phase 1, every 5 s in which anything moved. Each line fits WF_LOG_MSG (88) at full widths.
static void pnet_l2_log(void) {
    static uint32_t last_ms, last_sum;
    const uint32_t now = clock_ms();
    if (now - last_ms < 5000u) return;
    last_ms = now;
    pnet_bridge_stats_t st;
    pnet_bridge_stats(&st);
    uint32_t no = 0;
    for (unsigned i = 1; i < PNET_TX_N; i++) no += st.tx_no[i];
    const uint32_t sum = st.in_amiga + st.in_both + st.rx_drops + st.tx_sent + st.tx_err + no +
                         g_link.txfull + g_link.acked + st.clash + st.hooks;
    if (sum == last_sum) return;
    last_sum = sum;
    char a[16], b[16];
    pnet_ip_text(st.amiga_ip, a);
    pnet_ip_text(st.board_ip, b);
    wf_logf(WF_INFO, "pnet: l2 in a %lu b %lu drop %lu q %lu sent %lu err %lu",
            (unsigned long)st.in_amiga, (unsigned long)st.in_both, (unsigned long)st.rx_drops,
            (unsigned long)pnet_ring_count(&g_pnet_rx), (unsigned long)st.tx_sent, (unsigned long)st.tx_err);
    wf_logf(no ? WF_WARN : WF_INFO, "pnet: l2 tx no len %lu mac %lu type %lu clash %lu full %lu ack %lu",
            (unsigned long)st.tx_no[PNET_TX_LEN], (unsigned long)st.tx_no[PNET_TX_MAC],
            (unsigned long)st.tx_no[PNET_TX_TYPE], (unsigned long)st.tx_no[PNET_TX_CLASH],
            (unsigned long)g_link.txfull, (unsigned long)g_link.acked);
    const bool same = st.amiga_ip != 0u && st.amiga_ip == st.board_ip;
    wf_logf(st.clash || same ? WF_WARN : WF_INFO, "pnet: l2 amiga %s board %s %s clash %lu heap %lu",
            a, b, same ? "SAME" : "distinct", (unsigned long)st.clash, (unsigned long)g_pnet_heap_low);
}
#endif
```

  Make sure `pnet_l2_log` is defined above its call site in the loop. It is: `pnet_log_summary` sits in the same
  pnet section above `main()`.

- [ ] **Step 10: The Phase 0 minor, owed (HANDOFF §3bg): clamp `side-idx max`.** In `pnet_serve_df1`, replace

```c
        const uint32_t lat = now32 - g_pnet_side_us;
        if (lat > g_pnet_side_idx_max) g_pnet_side_idx_max = lat;
```

  with

```c
        // The restart can precede the SIDE ISR's stamp (negative latency): that is 0, not 4,294 s.
        const int32_t lat = (int32_t)(now32 - g_pnet_side_us);
        if (lat > 0 && (uint32_t)lat > g_pnet_side_idx_max) g_pnet_side_idx_max = (uint32_t)lat;
```

- [ ] **Step 11: Build all three configurations, check identity, run the tests.**

Run:
```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake --build build-pnet1 >/dev/null && echo "L2 ok"
cmake --build build-pnet >/dev/null && echo "LOOP ok"
cmake --build build >/dev/null && echo "OFF ok"
strings build-pnet1/wifi_floppy.bin | grep -c 'L2 sharing on'
strings build-pnet1/wifi_floppy.bin | grep -c wf-pnet-loop-test
strings build/wifi_floppy.bin | grep -c 'L2 sharing on'
tools/pnet_off_identical.sh "$(git log -1 --format=%H --grep='flux_in stays enabled')"
cd test && ./run.sh; echo "exit $?"
```
Expected:
- `L2 ok`, `LOOP ok`, `OFF ok`;
- `1`, `1`, `0` for the three string counts;
- three `identical …` lines;
- `exit 0`.

  A frame-limit error names the function: shrink it, never raise the limit. Also check the L2 ELF really carries the
  hook: `arm-none-eabi-nm build-pnet1/wifi_floppy.elf | grep -c pnet_input` should print `1`.

- [ ] **Step 12: Commit**

```bash
git add wifi-floppy/firmware/src/main.c
git commit -m "feat(fw): PaulaNET Phase 1 core0 -- batches from the RX ring, commits to the TX ring, OTA rule, heap low

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: NetLoop `ARP` and `DHCP`

**Files:**
- Create: `tools/netloop/netloop_eth.h`, `tools/netloop/netloop_eth.c`, `tools/netloop/test_netloop_eth.c`
- Modify: `tools/netloop/netloop.c`: version 1.2, the template, the new modes. `tools/netloop/build.sh`: the host test
  and the m68k object list.

**Interfaces:**
- Consumes: `pnet_frame.h` (Phase 0) on the Amiga. The host test also uses the board's `pnet_sort.c` (Task 2), to
  prove the two ends agree.
- Produces:

```c
#define NL_ETH_MIN 60u
#define NL_DHCP_FRAME_BYTES 342u
typedef struct { uint8_t type; uint32_t yiaddr, server, router, dns, mask, lease; } nl_dhcp_t;
int    nl_parse_mac(const char *s, uint8_t mac[6]);
int    nl_parse_ip(const char *s, uint32_t *ip);
void   nl_ip_text(uint32_t ip, char out[16]);
size_t nl_arp_request(uint8_t *f, const uint8_t mac[6], uint32_t spa, uint32_t tpa);
int    nl_arp_reply_from(const uint8_t *f, size_t len, uint32_t asked, uint8_t mac_out[6]);
size_t nl_dhcp_discover(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid);
size_t nl_dhcp_request(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid, uint32_t yiaddr, uint32_t server);
int    nl_dhcp_parse(const uint8_t *f, size_t len, uint32_t xid, nl_dhcp_t *out);
const char *nl_eth_selftest(void);   /* NULL = pass, else the failing step */
```

  On the Amiga: `NetLoop DHCP MAC=<mac>` and `NetLoop ARP MAC=<mac> [IP=<ip>] [ROUTER=<ip>] [ROUNDS=<n>]`.

- [ ] **Step 1: Write the header** `tools/netloop/netloop_eth.h`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef NETLOOP_ETH_H
#define NETLOOP_ETH_H
/*
 * NetLoop's hand-made Ethernet (PaulaNET Phase 1): an ARP request, a DHCP DISCOVER and REQUEST,
 * and the parsers for their replies. Byte access only (the 68000 faults on an odd word access).
 * Addresses are host-order uint32_t, as the board's pnet_sort.h has them. Host-tested by
 * test_netloop_eth.c, against the board's own sorter.
 */
#include <stdint.h>
#include <stddef.h>

#define NL_ETH_MIN          60u
#define NL_BOOTP_BYTES      300u
#define NL_DHCP_FRAME_BYTES (14u + 20u + 8u + NL_BOOTP_BYTES)

typedef struct { uint8_t type; uint32_t yiaddr, server, router, dns, mask, lease; } nl_dhcp_t;

int    nl_parse_mac(const char *s, uint8_t mac[6]);      /* "aa:bb:cc:dd:ee:ff" (or '-'): 1 = ok */
int    nl_parse_ip(const char *s, uint32_t *ip);         /* "a.b.c.d": 1 = ok */
void   nl_ip_text(uint32_t ip, char out[16]);
/* Broadcast "who has tpa, tell spa" from mac: NL_ETH_MIN bytes. */
size_t nl_arp_request(uint8_t *f, const uint8_t mac[6], uint32_t spa, uint32_t tpa);
/* 1 when f is an ARP reply from `asked`; its MAC into mac_out. */
int    nl_arp_reply_from(const uint8_t *f, size_t len, uint32_t asked, uint8_t mac_out[6]);
/* BOOTREQUESTs from 0.0.0.0:68 to 255.255.255.255:67 with client-id 01:<mac> (as AmiTCP_NG sends
 * it): NL_DHCP_FRAME_BYTES, or 0 when cap is smaller. */
size_t nl_dhcp_discover(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid);
size_t nl_dhcp_request(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid, uint32_t yiaddr, uint32_t server);
/* 1 when f is a BOOTREPLY (UDP 67 -> 68) to xid with a DHCP message type; fills out. */
int    nl_dhcp_parse(const uint8_t *f, size_t len, uint32_t xid, nl_dhcp_t *out);
/* The above on this CPU: NULL = pass, else the step that failed. NetLoop SELFTEST runs it. */
const char *nl_eth_selftest(void);
#endif
```

- [ ] **Step 2: Write the failing host test** `tools/netloop/test_netloop_eth.c`. It runs the selftest, then proves
  NetLoop's frames are what the board's sorter expects:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "netloop_eth.h"
#include "pnet_sort.h"
#include <stdio.h>
#include <string.h>

static int failed;
#define CHECK(c, m) do { if (!(c)) { printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, m); failed++; } } while (0)

int main(void) {
    const char *st = nl_eth_selftest();
    CHECK(st == NULL, st ? st : "");
    static const uint8_t mac[6] = {0x28, 0xcd, 0xc1, 0x01, 0x02, 0x03};
    const uint32_t board = 0xC0A80128u, router = 0xC0A80101u, me = 0xC0A80139u;
    uint8_t f[NL_DHCP_FRAME_BYTES];
    pnet_sort_t s;
    pnet_sort_init(&s);
    /* The board lets NetLoop's DISCOVER out and learns its xid... */
    size_t n = nl_dhcp_discover(f, sizeof f, mac, 0xCAFEF00Du);
    CHECK(n == NL_DHCP_FRAME_BYTES, "discover size");
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_SEND, "the board sends the DISCOVER");
    CHECK(s.nxid == 1 && s.xid[0] == 0xCAFEF00Du, "and learns its xid");
    /* ...and its REQUEST, which carries the offered address and the server. */
    n = nl_dhcp_request(f, sizeof f, mac, 0xCAFEF00Du, me, router);
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_SEND, "the board sends the REQUEST");
    /* NetLoop's ARP teaches the board the Amiga's address. */
    n = nl_arp_request(f, mac, me, router);
    CHECK(n == NL_ETH_MIN, "arp size");
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_SEND && s.amiga_ip == me, "arp teaches");
    /* A wrong MAC= is refused by the board, visibly. */
    static const uint8_t typo[6] = {0x28, 0xcd, 0xc1, 0x01, 0x02, 0x04};
    n = nl_arp_request(f, typo, me, router);
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_MAC, "a typo is a MAC refusal");
    /* Undersized buffers build nothing. */
    CHECK(nl_dhcp_discover(f, NL_DHCP_FRAME_BYTES - 1u, mac, 1u) == 0, "cap");
    printf("%s: %s\n", __FILE__, failed ? "FAIL" : "ok");
    return failed ? 1 : 0;
}
```

- [ ] **Step 3: Wire it into `build.sh`, and run it to verify it fails.** In `tools/netloop/build.sh`, after the
  `"$out/test_netloop_stats"` line, add:

```bash
fw="$root/wifi-floppy/firmware/src"
cc -std=c11 -Wall -Wextra -Werror -O1 -I"$here" -I"$fw" -o "$out/test_netloop_eth" \
   "$here/test_netloop_eth.c" "$here/netloop_eth.c" "$fw/pnet_sort.c"
"$out/test_netloop_eth"
```

Run: `tools/netloop/build.sh test`
Expected: a compile error, because `netloop_eth.c` does not exist yet.

- [ ] **Step 4: Implement** `tools/netloop/netloop_eth.c`:

```c
/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* NetLoop's hand-made Ethernet (netloop_eth.h). */
#include "netloop_eth.h"
#include <stdio.h>
#include <string.h>

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }
static uint16_t get16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)get16(p) << 16 | get16(p + 2); }
static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static int hex(char c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10
         : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

int nl_parse_mac(const char *s, uint8_t mac[6]) {
    for (int i = 0; i < 6; i++) {
        const int h = hex(s[0]), l = hex(s[1]);
        if (h < 0 || l < 0) return 0;
        mac[i] = (uint8_t)(h * 16 + l);
        s += 2;
        if (i < 5) { if (*s != ':' && *s != '-') return 0; s++; }
    }
    return *s == '\0';
}

int nl_parse_ip(const char *s, uint32_t *ip) {
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        unsigned n = 0;
        int d = 0;
        while (*s >= '0' && *s <= '9' && d < 3) { n = n * 10u + (unsigned)(*s - '0'); s++; d++; }
        if (d == 0 || n > 255u) return 0;
        v = v << 8 | n;
        if (i < 3) { if (*s != '.') return 0; s++; }
    }
    if (*s != '\0') return 0;
    *ip = v;
    return 1;
}

void nl_ip_text(uint32_t ip, char out[16]) {
    sprintf(out, "%u.%u.%u.%u", (unsigned)(ip >> 24), (unsigned)(ip >> 16 & 255u),
            (unsigned)(ip >> 8 & 255u), (unsigned)(ip & 255u));
}

static size_t eth(uint8_t *f, const uint8_t *dst, const uint8_t *src, uint16_t type) {
    memcpy(f, dst, 6);
    memcpy(f + 6, src, 6);
    put16(f + 12, type);
    return 14;
}

size_t nl_arp_request(uint8_t *f, const uint8_t mac[6], uint32_t spa, uint32_t tpa) {
    memset(f, 0, NL_ETH_MIN);
    uint8_t *a = f + eth(f, BCAST, mac, 0x0806u);
    put16(a, 1); put16(a + 2, 0x0800u); a[4] = 6; a[5] = 4; put16(a + 6, 1);
    memcpy(a + 8, mac, 6); put32(a + 14, spa); put32(a + 24, tpa);
    return NL_ETH_MIN;
}

int nl_arp_reply_from(const uint8_t *f, size_t len, uint32_t asked, uint8_t mac_out[6]) {
    if (len < 42u || get16(f + 12) != 0x0806u) return 0;
    const uint8_t *a = f + 14;
    if (get16(a + 6) != 2u || get32(a + 14) != asked) return 0;
    memcpy(mac_out, a + 8, 6);
    return 1;
}

static uint16_t ip_csum(const uint8_t *h) {
    uint32_t s = 0;
    for (int i = 0; i < 20; i += 2) s += get16(h + i);
    while (s >> 16) s = (s & 0xFFFFu) + (s >> 16);
    return (uint16_t)~s;
}

static size_t dhcp_frame(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid, uint8_t type,
                         uint32_t want, uint32_t server) {
    if (cap < NL_DHCP_FRAME_BYTES) return 0;
    memset(f, 0, NL_DHCP_FRAME_BYTES);
    uint8_t *ip = f + eth(f, BCAST, mac, 0x0800u);
    ip[0] = 0x45; put16(ip + 2, (uint16_t)(NL_DHCP_FRAME_BYTES - 14u)); ip[8] = 64; ip[9] = 17;
    put32(ip + 16, 0xFFFFFFFFu);                               /* from 0.0.0.0 */
    put16(ip + 10, ip_csum(ip));
    uint8_t *u = ip + 20;
    put16(u, 68); put16(u + 2, 67); put16(u + 4, (uint16_t)(8u + NL_BOOTP_BYTES));   /* checksum 0: none */
    uint8_t *b = u + 8;
    b[0] = 1; b[1] = 1; b[2] = 6;
    put32(b + 4, xid);
    memcpy(b + 28, mac, 6);
    put32(b + 236, 0x63825363u);
    uint8_t *o = b + 240;
    *o++ = 53; *o++ = 1; *o++ = type;
    *o++ = 61; *o++ = 7; *o++ = 1; memcpy(o, mac, 6); o += 6;
    if (want) { *o++ = 50; *o++ = 4; put32(o, want); o += 4; }
    if (server) { *o++ = 54; *o++ = 4; put32(o, server); o += 4; }
    *o++ = 55; *o++ = 4; *o++ = 1; *o++ = 3; *o++ = 6; *o++ = 51;
    *o = 255;
    return NL_DHCP_FRAME_BYTES;
}

size_t nl_dhcp_discover(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid) {
    return dhcp_frame(f, cap, mac, xid, 1, 0, 0);
}

size_t nl_dhcp_request(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid, uint32_t yiaddr, uint32_t server) {
    return dhcp_frame(f, cap, mac, xid, 3, yiaddr, server);
}

int nl_dhcp_parse(const uint8_t *f, size_t len, uint32_t xid, nl_dhcp_t *out) {
    memset(out, 0, sizeof *out);
    if (len < 14u + 20u + 8u + 240u || get16(f + 12) != 0x0800u) return 0;
    const uint8_t *ip = f + 14;
    const size_t ihl = (size_t)(ip[0] & 15u) * 4u;
    if ((ip[0] >> 4) != 4u || ihl < 20u || ip[9] != 17u || len < 14u + ihl + 8u + 240u) return 0;
    const size_t u = 14u + ihl, b = u + 8u;
    if (get16(f + u) != 67u || get16(f + u + 2) != 68u) return 0;
    if (f[b] != 2u || get32(f + b + 4) != xid || get32(f + b + 236) != 0x63825363u) return 0;
    out->yiaddr = get32(f + b + 16);
    size_t i = b + 240u;
    while (i < len && f[i] != 255u) {
        if (f[i] == 0u) { i++; continue; }
        if (len - i < 2u || len - i - 2u < f[i + 1]) break;
        const uint8_t code = f[i], n = f[i + 1];
        const uint8_t *v = f + i + 2;
        if (code == 53u && n == 1u) out->type = v[0];
        else if (n >= 4u) {
            if (code == 54u) out->server = get32(v);
            else if (code == 3u) out->router = get32(v);
            else if (code == 6u) out->dns = get32(v);
            else if (code == 1u) out->mask = get32(v);
            else if (code == 51u) out->lease = get32(v);
        }
        i += 2u + n;
    }
    return out->type != 0u;
}

const char *nl_eth_selftest(void) {
    static uint8_t f[NL_DHCP_FRAME_BYTES];
    static const uint8_t mac[6] = {0x02, 0, 0, 0, 0, 0x01};
    uint8_t got[6];
    uint32_t ip;
    nl_dhcp_t d;
    char t[16];
    if (!nl_parse_mac("02:00:00:00:00:01", got) || memcmp(got, mac, 6) != 0) return "parse mac";
    if (nl_parse_mac("02:00:00:00:00", got) || nl_parse_mac("02:00:00:00:00:01x", got)) return "bad mac taken";
    if (!nl_parse_ip("192.168.1.57", &ip) || ip != 0xC0A80139u) return "parse ip";
    if (nl_parse_ip("192.168.1.256", &ip) || nl_parse_ip("192.168.1", &ip)) return "bad ip taken";
    nl_ip_text(0xC0A80139u, t);
    if (strcmp(t, "192.168.1.57") != 0) return "ip text";
    /* The request, turned into the router's reply. */
    if (nl_arp_request(f, mac, 0xC0A80139u, 0xC0A80101u) != NL_ETH_MIN) return "arp size";
    f[14 + 7] = 2;
    memcpy(f + 14 + 8, "\x00\x11\x22\x33\x44\x55", 6);
    put32(f + 14 + 14, 0xC0A80101u);
    if (!nl_arp_reply_from(f, NL_ETH_MIN, 0xC0A80101u, got) || got[5] != 0x55) return "arp reply";
    if (nl_arp_reply_from(f, NL_ETH_MIN, 0xC0A80102u, got)) return "arp reply from another";
    /* The DISCOVER, checked, then turned into an OFFER. */
    if (nl_dhcp_discover(f, sizeof f, mac, 0x12345678u) != NL_DHCP_FRAME_BYTES) return "discover size";
    if (ip_csum(f + 14) != 0) return "ip checksum";
    if (nl_dhcp_parse(f, sizeof f, 0x12345678u, &d)) return "a request parsed as a reply";
    const size_t u = 34, b = 42;
    put16(f + u, 67); put16(f + u + 2, 68);
    f[b] = 2;
    put32(f + b + 16, 0xC0A80139u);
    uint8_t *o = f + b + 240;
    *o++ = 53; *o++ = 1; *o++ = 2;
    *o++ = 54; *o++ = 4; put32(o, 0xC0A80101u); o += 4;
    *o++ = 3; *o++ = 4; put32(o, 0xC0A80101u); o += 4;
    *o++ = 51; *o++ = 4; put32(o, 86400u); o += 4;
    *o = 255;
    if (!nl_dhcp_parse(f, sizeof f, 0x12345678u, &d)) return "offer";
    if (d.type != 2 || d.yiaddr != 0xC0A80139u || d.server != 0xC0A80101u || d.router != 0xC0A80101u ||
        d.lease != 86400u) return "offer fields";
    if (nl_dhcp_parse(f, sizeof f, 0x12345679u, &d)) return "another xid";
    if (nl_dhcp_parse(f, 100, 0x12345678u, &d)) return "short frame";
    return NULL;
}
```

- [ ] **Step 5: Run the host test to verify it passes**

Run: `tools/netloop/build.sh test`
Expected: the existing stats test output, then `tools/netloop/test_netloop_eth.c: ok`. The script exits 0.

- [ ] **Step 6: NetLoop's modes.** In `tools/netloop/netloop.c`:

(a) After `#include "netloop_bench.h"`, add `#include "netloop_eth.h"` and `#include <dos/var.h>`. Change the version
  string to `"$VER: NetLoop 1.2 (11.10.2026) PaulaNET protocol by RobSmithDev, used with permission"`, and the banner
  `printf` to `NetLoop 1.2`.

  Extend the header comment's usage line with:

```
 *   NetLoop DHCP MAC=<board mac>                         (Phase 1: a lease from the router)
 *   NetLoop ARP MAC=<board mac> [IP=<a>] [ROUTER=<r>] [ROUNDS=<n>]   (Phase 1: the router's MAC)
 * ARP/DHCP need the PaulaNET Phase 1 TEST firmware (the board's boot log prints its MAC). DHCP saves
 * the lease as the global variables NetLoopIP and NetLoopRouter, which ARP uses when IP= and ROUTER=
 * are not given.
```

(b) After `resync()`, add the L2 exchange:

```c
/* ---- Phase 1: real frames (ARP, DHCP) ---------------------------------------------------- */
static uint8_t l2_mac[6];
static unsigned long c_l2_frames, c_l2_stale, c_l2_unacked;
typedef int (*l2_fn)(const uint8_t *f, size_t len, void *ctx);   /* nonzero: the frame wanted */

/* One exchange: our batch on side 0 (out, or none: a poll that also acknowledges), then side 1
 * until the board's header acknowledges it; a new batch's frames go to fn (NULL: counted only).
 * 0 = fn found its frame, 1 = acknowledged, nothing found, 2 = not acknowledged (send again). */
static int l2_exchange(UBYTE *ctr, UBYTE *last_pico, const pnet_frame_ref_t *out, unsigned nout,
                       l2_fn fn, void *ctx) {
    *ctr = (UBYTE)(*ctr + 1u);                       /* every write is a new batch (ruling 14) */
    const size_t wlen = pnet_build_to_board(wbuf, CHIP_BYTES, *ctr, *last_pico, out, nout);
    if (!wlen) return 2;
    if (td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN) &&
        td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN)) { c_ioerr++; return 2; }
    for (int r = 0; r < 3; r++) {
        pnet_hdr_t h, p;
        size_t valid;
        if (read_once(HDR_READ, &h, FALSE, &valid, FALSE)) continue;
        if (h.amiga_ctr != *ctr) { c_l2_stale++; continue; }
        if (h.pico_ctr == *last_pico || h.data_size == 0) return 1;
        td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));            /* as PaulaNET's driver does */
        ULONG len = (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h.data_size + 64u + 1u) & ~1ul;
        if (len > CHIP_BYTES) len = CHIP_BYTES;
        if (read_once(len, &p, TRUE, &valid, FALSE) || p.pico_ctr != h.pico_ctr) continue;
        uint16_t lens[PNET_MAX_FRAMES];
        unsigned n = 0;
        if (pnet_parse_frames(rbuf + PNET_HDR_MFM_BYTES, p.data_size, PNET_TO_AMIGA, echo, ECHO_BYTES,
                              lens, PNET_MAX_FRAMES, &n) != PNET_OK) { c_badhdr++; continue; }
        *last_pico = p.pico_ctr;                                       /* our next write acknowledges it */
        int found = 0;
        const uint8_t *q = echo;
        for (unsigned i = 0; i < n; i++) {
            c_l2_frames++;
            if (!found && fn && fn(q, lens[i], ctx)) found = 1;
            q += lens[i];
        }
        return found ? 0 : 1;
    }
    c_l2_unacked++;
    return 2;
}

/* Sends `frame` until the board takes it, then polls until fn finds its reply or wait_s pass.
 * Frames in the batch read with the send itself were queued before it went out: never the reply.
 * 0 = found (*took: E-clock ticks from the first write), 1 = not found. */
static int l2_ask(UBYTE *ctr, UBYTE *last_pico, const uint8_t *frame, size_t flen, l2_fn fn,
                  void *ctx, ULONG wait_s, uint32_t *took) {
    const pnet_frame_ref_t ref = { frame, (uint16_t)flen };
    const uint64_t t0 = ticks(), end = t0 + (uint64_t)wait_s * hz;
    BOOL sent = FALSE;
    while (ticks() < end) {
        if (SetSignal(0, 0) & SIGBREAKF_CTRL_C) return 1;
        const int r = l2_exchange(ctr, last_pico, sent ? NULL : &ref, sent ? 0u : 1u, sent ? fn : NULL, ctx);
        if (r == 0) { *took = (uint32_t)(ticks() - t0); return 0; }
        if (r != 2) sent = TRUE;
    }
    return 1;
}

typedef struct { uint32_t asked; uint8_t mac[6]; } arp_ctx_t;
static int arp_fn(const uint8_t *f, size_t len, void *ctx) {
    arp_ctx_t *a = ctx;
    return nl_arp_reply_from(f, len, a->asked, a->mac);
}

typedef struct { uint32_t xid; uint8_t want; nl_dhcp_t d; } dhcp_ctx_t;
static int dhcp_fn(const uint8_t *f, size_t len, void *ctx) {
    dhcp_ctx_t *c = ctx;
    nl_dhcp_t d;
    if (!nl_dhcp_parse(f, len, c->xid, &d)) return 0;
    if (d.type != c->want && !(c->want == 5u && d.type == 6u)) return 0;   /* an ACK, or its NAK */
    c->d = d;
    return 1;
}

static int run_dhcp(UBYTE *ctr, UBYTE *last_pico) {
    const uint32_t xid = (uint32_t)ticks() * 2654435761u;
    char a[16], b[16], c[16], d[16];
    uint32_t took;
    dhcp_ctx_t x = { xid, 2u, {0} };
    size_t n = nl_dhcp_discover(payload, MAX_N, l2_mac, xid);
    printf("DHCP: DISCOVER xid %08lx\n", (unsigned long)xid);
    if (l2_ask(ctr, last_pico, payload, n, dhcp_fn, &x, 6, &took)) {
        printf("no OFFER in 6 s (frames seen %lu)\nRESULT: FAIL\n", c_l2_frames);
        return RETURN_WARN;
    }
    nl_ip_text(x.d.server, a); nl_ip_text(x.d.yiaddr, b); nl_ip_text(x.d.router, c); nl_ip_text(x.d.dns, d);
    printf("OFFER from %s: address %s router %s dns %s lease %lu s\n", a, b, c, d, (unsigned long)x.d.lease);
    const nl_dhcp_t offer = x.d;
    x.want = 5u;
    n = nl_dhcp_request(payload, MAX_N, l2_mac, xid, offer.yiaddr, offer.server);
    if (l2_ask(ctr, last_pico, payload, n, dhcp_fn, &x, 6, &took)) {
        printf("no ACK in 6 s -- the board refuses an ACK that names its own address: check its log for\n"
               "'pnet: l2 ... clash'\nRESULT: FAIL\n");
        return RETURN_WARN;
    }
    if (x.d.type == 6u) { printf("NAK from the server\nRESULT: FAIL\n"); return RETURN_WARN; }
    nl_ip_text(x.d.yiaddr, b);
    nl_ip_text(offer.router, c);
    printf("ACK: this Amiga is %s (router %s); saved as NetLoopIP / NetLoopRouter\n", b, c);
    SetVar((STRPTR)"NetLoopIP", (STRPTR)b, -1, GVF_GLOBAL_ONLY);
    SetVar((STRPTR)"NetLoopRouter", (STRPTR)c, -1, GVF_GLOBAL_ONLY);
    printf("RESULT: PASS\n");
    return RETURN_OK;
}

static int run_arp(UBYTE *ctr, UBYTE *last_pico, uint32_t me, uint32_t router, ULONG rounds) {
    arp_ctx_t a = { router, {0} };
    const size_t n = nl_arp_request(payload, l2_mac, me, router);
    char ip[16];
    nl_ip_text(router, ip);
    unsigned long ok = 0;
    for (ULONG i = 0; i < rounds; i++) {
        if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { printf("*** Break\n"); break; }
        uint32_t took;
        if (l2_ask(ctr, last_pico, payload, n, arp_fn, &a, 5, &took) == 0) rtt[ok++] = took;
    }
    if (ok)
        printf("router %s is at %02x:%02x:%02x:%02x:%02x:%02x\n", ip, a.mac[0], a.mac[1], a.mac[2],
               a.mac[3], a.mac[4], a.mac[5]);
    printf("arp: %lu/%lu answered; frames seen %lu, stale headers %lu, unacknowledged %lu\n",
           ok, (unsigned long)rounds, c_l2_frames, c_l2_stale, c_l2_unacked);
    if (ok) {
        unsigned long w, t, w2, t2;
        ms(nl_percentile(rtt, (unsigned)ok, 50), &w, &t);
        ms(nl_percentile(rtt, (unsigned)ok, 95), &w2, &t2);
        printf("arp ms: median %lu.%lu p95 %lu.%lu\n", w, t, w2, t2);
    }
    const BOOL pass = ok == rounds;
    printf("RESULT: %s\n", pass ? "PASS" : "FAIL");
    return pass ? RETURN_OK : RETURN_WARN;
}
```

(c) In `main`, widen the arguments:
  - `LONG args[6] = {0, 0, 0, 0, 0, 0};` becomes `LONG args[12] = {0};`;
  - the template becomes `"N/K/N,ROUNDS/K/N,READS/K/N,SELFTEST/S,BENCH/S,DIAG/S,ARP/S,DHCP/S,MAC/K,IP/K,ROUTER/K,WAIT/K/N"`.

  Copy the string arguments before `FreeArgs(rd)`, because ReadArgs owns them:

```c
    const BOOL do_arp = args[6] != 0, do_dhcp = args[7] != 0;
    char mac_s[24] = "", ip_s[16] = "", router_s[16] = "";
    if (args[8]) strncpy(mac_s, (const char *)args[8], sizeof mac_s - 1);
    if (args[9]) strncpy(ip_s, (const char *)args[9], sizeof ip_s - 1);
    if (args[10]) strncpy(router_s, (const char *)args[10], sizeof router_s - 1);
```

  (`WAIT/K/N` is reserved for a later per-ask timeout. Read `args[11]` as `(void)args[11];`, so the template stays
  stable.)

  The existing range check rejects `ROUNDS` only above `MAX_ROUNDS`. For ARP/DHCP the default `rounds` is 1, so
  replace `const unsigned long rounds = args[1] ? … : MAX_ROUNDS;` with:

```c
    const unsigned long rounds = args[1] ? (unsigned long)*(LONG *)args[1] : (do_arp || do_dhcp) ? 1u : MAX_ROUNDS;
```

  After `if (bench_only) { rc = bench(); goto out; }`, add the MAC check (before opening DF1):

```c
    if ((do_arp || do_dhcp) && !nl_parse_mac(mac_s, l2_mac)) {
        printf("ARP and DHCP need MAC=<the board's MAC>, as its boot log prints it\n"); goto out;
    }
```

  After the `resync` call (and its "resync: no header" message), and before the warm-up `one_round`, add:

```c
    if (do_dhcp) { rc = run_dhcp(&ctr, &last_pico); goto out; }
    if (do_arp) {
        uint32_t me = 0, router = 0;
        char v[16];
        if (!ip_s[0] && GetVar((STRPTR)"NetLoopIP", (STRPTR)v, sizeof v, GVF_GLOBAL_ONLY) > 0) strcpy(ip_s, v);
        if (!router_s[0] && GetVar((STRPTR)"NetLoopRouter", (STRPTR)v, sizeof v, GVF_GLOBAL_ONLY) > 0) strcpy(router_s, v);
        if (!nl_parse_ip(ip_s, &me) || !nl_parse_ip(router_s, &router)) {
            printf("ARP needs IP= and ROUTER= (or a NetLoop DHCP lease first)\n"); goto out;
        }
        rc = run_arp(&ctr, &last_pico, me, router, rounds);
        goto out;
    }
```

(d) In `selftest()`, before its final PASS print, add:

```c
    {
        const char *e = nl_eth_selftest();
        if (e) return st_fail(e);
    }
```

- [ ] **Step 7: `build.sh` compiles it for the 68000.** In the Docker `sh -euc` block:
  - add `netloop_eth` to the `for f in pnet_asm_tables netloop_stats …` list;
  - add `$o/netloop_eth.o` to `L=`.

- [ ] **Step 8: Build NetLoop and the ADF; the 68000 runs the new selftest under vamos.**

Run: `tools/netloop/build.sh`
Expected:
- the host tests print `ok`;
- `m68k-amigaos-gcc` builds with no warning (`-Werror`);
- `xdftool` lists `NetLoop`;
- `test_netloop_asm` reports `RESULT: PASS` twice (once plain, once under the odd-address trace);
- `NetLoop SELFTEST` reports `RESULT: PASS`.

  `NetLoop SELFTEST` now also runs `nl_eth_selftest` big-endian. A vamos failure there, with the host test passing,
  is a byte-order or alignment bug: fix it before going on.

- [ ] **Step 9: Commit**

```bash
git add tools/netloop/netloop_eth.h tools/netloop/netloop_eth.c tools/netloop/test_netloop_eth.c tools/netloop/netloop.c tools/netloop/build.sh
git commit -m "feat(netloop): 1.2 -- ARP and DHCP over the PaulaNET Phase 1 board

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Publish the TEST build and get both halves onto the bench

**Files:** none changed. This task produces a registry entry, an install, an uploaded ADF and a serial log.

**Interfaces:**
- Consumes: Tasks 1-7. The image comes from `build/`, because `firmware-release.ts` reads only that directory.
- Produces: the board running `1.10.0+g<hash>` with `pnet: L2 sharing on`, and the Amiga with NetLoop 1.2 in `SYS:C`.

- [ ] **Step 1: Build the TEST image in `build/`** from a clean, committed tree:

Run:
```bash
git status --short     # nothing under wifi-floppy/firmware or tools/netloop
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
      -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=ON && cmake --build build
strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test     # 1
strings build/wifi_floppy.bin | grep -c 'L2 sharing on'        # 1
grep WF_FIRMWARE_VERSION build/generated/wifi_floppy_version.h
```
Expected: `1`, `1`, and a version `1.10.0+g<hash>` with no `+dirty` and no `+nogit`.

- [ ] **Step 2: Dry run, then publish**

Run (repo root):
```bash
pnpm firmware:publish --dry-run --notes "TEST build: PaulaNET Phase 1 layer-2 sharing on DF1 cylinder 77 (bench only; never a release)"
pnpm firmware:publish --notes "TEST build: PaulaNET Phase 1 layer-2 sharing on DF1 cylinder 77 (bench only; never a release)"
```
Expected: the dry run shows no refusal, and the publish prints a sequence number above 67. Record it. The publish
must not create a GitHub release. If the script offers one, decline.

- [ ] **Step 3: Put `build/` back to a release configuration at once:**

Run:
```bash
cd wifi-floppy/firmware && cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=OFF && cmake --build build >/dev/null \
  && strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test
```
Expected: `0`.

- [ ] **Step 4: Operator, one step: switch the A500 OFF.** End the turn asking for exactly that. The install ejects
  DF0.

- [ ] **Step 5: Start the serial log, then install.**
  - Recreate `serstream.py` in this session's scratchpad from the Phase 0 plan, Task 9 Step 5, if it is not there.
  - Run `python3 <scratchpad>/serstream.py /dev/cu.usbmodem1101 14400 <scratchpad>/pnet1-bench.log` in the
    background.
  - From `/Users/sfs/Devel/webadf` (the untracked `.fw-target.mts` lives there), run
    `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '<version from Step 1>'`, and say in the conversation that
    an install was triggered.
  - Expected in the log after the reboot:
    - `wf-pnet-loop-test: DF1 cylinder 77 is a PaulaNET loopback (bench only)`;
    - `pio claims: radio on pio2`;
    - `pnet: L2 sharing on (TEST build), MAC <mac>`: record the MAC;
    - `associated, default route w00 ip=<board ip>`: record it, because it may have changed (ruling 6);
    - no `not backed by PSRAM`, and no `no send worker`.
  - The Devices card shows the TEST version.

- [ ] **Step 6: Operator, one step:** switch the A500 on and let Workbench boot from the IDE drive. PASS: Workbench
  is up, and the card shows DF1 "Set on the board" (DF1 stayed Next from Phase 0).

- [ ] **Step 7: Operator, one step:** upload `tools/netloop/build/NetLoop.adf` on the Library page and press
  **Mount** for the board. Then, in a Shell, `copy df0:NetLoop SYS:C/` and `NetLoop SELFTEST`. PASS: the last line is
  `RESULT: PASS`.

---

### Task 9: Bench acceptance (spec §8 Phase 1), and the record

**Files:**
- Modify: `HANDOFF.md`: a new section `### 3bh. PaulaNET Phase 1 …` directly above `### 3bg.`, the backlog's
  "Amiga networking" entry, and the "pio2 CTRL" backlog entry.

**Interfaces:**
- Consumes: Task 8's bench and `pnet1-bench.log`.
- Produces: the four acceptance verdicts, the router's behaviour, the heap low-water, and the operator's next
  question.

Every operator step below is one turn. The operator types or photographs NetLoop's last lines.

- [ ] **Step 1: Read the baseline** (no operator step). From the log, record:
  - the first `heap: free low-water` line on this build. This answers spec §6 question 7 for 1.10.0+L2 at idle;
  - the board's IP.

- [ ] **Step 2: Operator, one step: give DF1 a disk.** Mount **Workbench** (disk 2 of the library's Workbench 3.1
  set) on DF0, wait about 10 s, then run `info`. PASS: DF1 is listed as **Locale**. Do not open files on DF1:
  cylinder 77 is the network.

- [ ] **Step 3: Operator, one step: acceptance 2.** Run `NetLoop DHCP MAC=<the MAC from Task 8 Step 5>`.
  - PASS:
    - `OFFER from …: address <A>`, then `ACK: this Amiga is <A>`, then `RESULT: PASS`;
    - and, in the next `pnet: l2 amiga <A> board <B> distinct` log line, `<A>` differs from `<B>`.
  - FAIL: `no ACK` together with a `clash` count above 0 in the log means the router keyed both leases on the MAC.
    Stop. Report to the operator, with ruling 7's option-B decision as the question.
  - Also record whether the OFFER came broadcast or unicast (the log's `in a` count rises either way). That answers
    spec §6 question 3 for this router.

- [ ] **Step 4: Operator, one step: acceptance 1.** Run `NetLoop ARP` (it uses the saved lease). PASS:
  `router <ip> is at <mac>`, `arp: 1/1 answered`, `RESULT: PASS`. If the router's admin page shows its MAC, the
  operator compares the two.

- [ ] **Step 5: Operator, one step: acceptance 3a, the board stays online under traffic.** Run
  `NetLoop ARP ROUNDS=1000`, and watch the board's Devices card for the whole run.
  - PASS: the card says online throughout; `arp: 1000/1000 answered`; `RESULT: PASS`.
  - Record `arp ms: median / p95`: the first real round trip through Wi-Fi from the A500.

- [ ] **Step 6: Operator, one step: acceptance 3b, DF0 write-back during traffic** (it also re-proves Task 1's
  capture change).
  - Open a second Shell, run `NetLoop ARP ROUNDS=1000` in it, and at once, in the first Shell, run
    `copy c:dir df0:pnettest`.
  - PASS:
    - the copy completes with no requester, and NetLoop prints `RESULT: PASS`;
    - every board `write: trk … ALL bad 0 …` line is followed by `applied`;
    - the disk's history on the web shows a new version.
  - Read the log for `pnet: lost … batches to DF0 writes`. A loss is allowed (the Amiga resends), but record it.

- [ ] **Step 7: Operator, one step: acceptance 3c, a DF0 mount during network use.** On the web, eject DF0, then mount
  Workbench disk 2 again.
  - Wait for `info` to list DF1 as Locale, then run `NetLoop ARP`.
  - PASS: `RESULT: PASS`, and the card shows the disk in DF0.

- [ ] **Step 8: Operator, one step: Review Focus 5 on hardware.** Press Ctrl-A-A. After Workbench is back, run
  `NetLoop ARP`. PASS: `RESULT: PASS`, so the resync worked against a board that kept its counters and any batch it
  had out.

- [ ] **Step 9: Read the serial log** (no operator step).
  - First run `grep -c 'records dropped' pnet1-bench.log`. A log that dropped records proves no absence.
  - Then record:
    - **acceptance 4:** the lowest `heap` in the `pnet: l2 amiga …` lines and the lowest `heap: free low-water`
      line. Both must be at least 20,480 B; below that, stop and report;
    - the `l2 in` counts, `drop`, and the `tx no` reasons. `mac` above 0 means a MAC typo in some run;
    - `err`, `full` and `clash`;
    - the `pnet: bad …` and `pnet: refused` lines, and the restart/prearm lines, against Phase 0's numbers;
    - whether `fw: update held` ever appeared (it should not: no update was offered).

- [ ] **Step 10: Record in `HANDOFF.md`.** Add `### 3bh. PaulaNET Phase 1 (layer-2 sharing) -- TEST build <version>, seq <n>`
  directly above `### 3bg.`, containing:
  - Steps 2-8 as PASS or FAIL;
  - the board and Amiga addresses ("distinct" or not), and the OFFER's delivery;
  - the ARP round-trip median and p95;
  - the heap figures (baseline and low-water);
  - the log counts from Step 9;
  - this plan's rulings 1-15, one line each;
  - "Corrections to the spec" 1-7, one line each;
  - the open questions below, with what the bench answered.

  Then:
  - In the backlog's "pio2 CTRL" entry, prefix "FIXED on branch feat/paulanet-phase1 (plan 2026-10-11 Task 1),
    proven on the bench <date>; ships with the next release".
  - In the "Amiga networking" entry, append "Phase 1 <PASSED/FAILED> <date> (3bh)".

- [ ] **Step 11: Commit the record**

```bash
git add HANDOFF.md
git commit -m "HANDOFF 3bh: PaulaNET Phase 1 layer-2 sharing on the A500 -- <verdict in five words>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 12: Off switch, rollback, and the next question.** Tell the operator all three, then ask the question as
  the turn's last thing.
  - **Off at runtime:** set DF1 to Off on the card. Every Phase 1 path needs DF1 on with a disk, so the board then
    behaves as the release does with DF1 off. The board still sends its own client-id in this build.
  - **Rollback:** as Phase 0's Task 10 Step 9. The registry refuses a lower sequence, so the way back is a release at
    a higher one. That release should carry Task 1 (the pio2 fix) and nothing of `WF_PNET_*`, which is the merged
    branch built with both options OFF.
  - The question: "Phase 1 <passed / failed at item N>. Merge `feat/paulanet-phase1` and cut a 1.10.1 release (the
    pio2 fix, leaves TEST), then Phase 2 with Rob's `PaulaNET.device` (its status cylinder 76, our MAC) or our own
    driver?"

---

## Open questions (not settled by the code or the spec)

1. **The operator's router (spec §6 question 3):** whether it gives the board and the Amiga separate leases with the
   board's new client-id, and whether its OFFER comes broadcast or unicast. Only Task 9 Step 3 answers it. If it
   clashes, option B (MAC rewrite) becomes Phase 1b. That is a decision, not a fix.
2. **Whether the RP2350's shared XIP cache is enough for core1's PSRAM writes to be seen by core0 with only
   `__dmb()`.** Ruling 8 relies on it, as `psram_image.c` already does for slots. No SDK document reviewed for this
   plan states it for PSRAM writes. If Task 9 shows corrupt frames that the host's two-thread test cannot reproduce,
   suspect this first.
3. **When the pio2 fix ships.** It is in every build from Task 1 on, but it reaches users only with a release. The
   bench board needs one anyway to leave TEST sequence 67 (HANDOFF §3bg). The operator decides the timing.
4. **Rob's written grant:** HANDOFF still asks for the message to be stored under `docs/` for provenance. Phase 1
   needs nothing new from it, but Phase 2 (redistributing his driver) will.
5. **AmiTCP_NG's own DHCP behaviour** (its broadcast flag, its retransmits, and whether it ARP-probes its new
   address) is untested here: NetLoop hand-makes its frames. Phase 2 meets it.
6. **The status cylinder 76:** Rob's driver reads the MAC and link state from it (`device.c:177-186`). Phase 1 avoids
   it with `MAC=`. Phase 2 must serve it read-only, in his layout.

## Self-review (done while writing this plan)

1. **Spec coverage (§8 Phase 1 and the request):**
   - the netif hook with option A: Tasks 2 and 5;
   - the board's client-id via `LWIP_HOOK_DHCP_APPEND_OPTIONS`: Tasks 2 and 5;
   - the filter list: Task 2 (ruling 3);
   - the ACK check: Task 2 (`an_ack_naming_the_boards_address_is_refused`);
   - the PSRAM rings and the cross-core handoff: Task 3 (ruling 8, the `pnet_ring.h` comment, the two-thread test);
   - cylinder-77 batches with the counter/ack: Tasks 4 and 6;
   - `cyw43_send_ethernet` from core1: Task 5 (`net_radio_send_ethernet` in the network context);
   - the OTA idle rule: Tasks 4 and 6;
   - the heap low-water logged: Task 6;
   - host tests for the sorter and the rings: Tasks 2-4;
   - NetLoop `ARP` and `DHCP`: Task 7;
   - the four acceptance items: Task 9 Steps 3-7 and 9;
   - the pio2 race, early: Task 1;
   - the measured Phase 0 facts kept: the commit build (Task 6 keeps `pnet_prepare_echo` at the commit and adds the
     side-0 build), the 200-byte lead (`PNET_BATCH_CAP`), the pre-armed capture and the 200 µs INDEX (untouched);
   - TEST-only, with reasoning: ruling 1.

   The only gap was a host test for the netif-re-add path. It has none, because it is pure lwIP plumbing.
   `pnet_bridge_check` covers it on every pass, and `hooks` in the L2 log shows it on the bench (a count above 1
   means a re-add happened).
2. **Placeholder scan:** none of "TBD", "TODO" or "similar to". Three places tell the implementer to move existing
   text rather than retype it (Task 6 Step 6's `#else` branch, and the comments in Step 7). They are named exactly.
   The commit-message fields `<OFF> -> <L2>`, `<verdict>` and `<version>` are values only a run produces.
3. **Type consistency:**
   - `pnet_sort_to_t`, `pnet_tx_t` and `PNET_TX_N` are used identically in Tasks 2, 5 and 6.
   - `pnet_ring_peek(…, uint16_t *len)` matches `pnet_frame_ref_t.len` (`uint16_t`) in Task 6 Step 7.
   - `pnet_link_take`'s `tx_space` is `uint32_t`, as `pnet_ring_space` returns.
   - `PNET_CANRECEIVE` is `uint8_t`-compatible for `pnet_build_to_amiga`'s `flags`.
   - `g_pnet_last_ms` is declared before its first use (the core1 gate, Step 1).
   - `pnet_l2_log` is defined before the loop calls it.
4. **Review Focus:** each of the five lines has its test in the owning task: Task 2 (1, 2), Task 3 (3), Task 4 (4, 5).
   Line 5 is also exercised on hardware in Task 9 Step 8.
