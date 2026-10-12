# PaulaNET Phase 3: Network (PaulaNET) as a DF1 Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A regular user chooses **Network (PaulaNET)** for the board's second drive, restarts the Amiga, runs **Install**
from the driver disk in DF1, types `AddNetInterface eth0`, and the card shows each step's state; this ships as release
**1.11.0**, which also takes the bench board off TEST.

**Architecture:**
- **Firmware.** `df1_mode_t` gains `DF1_MODE_NET`. The PaulaNET code (Phases 0-2) moves into release builds: both
  CMake options default ON, and every hook is gated at runtime by one cached predicate, `g_pnet_on =
  pnet_mode_on(g_df1_mode, PNET_ECHO_BUILD)`. In Off and Next modes the hooks return at once and DF1 is a plain disk
  drive. The loopback echo stays a TEST build (`WF_PNET_L2=OFF`) and alone carries the `wf-pnet-loop-test` marker.
  The status report gains a `net` tail.
- **The driver disk.** A deterministic script builds it from Rob Smith's own disk (pinned in `third-party/paulanet/`)
  plus our `Install` script, `ReadMe` and two icons. It is stored in Blob by its sha256 and sent as DF1's `next` in
  Network mode, whatever DF0 holds.
  - The board keeps it in a **third PSRAM slot of its own** (`SLOT_NET`): 160 tracks of DD sector data, 901,120 B,
    encoded to MFM a track at a time on read, as HD slots already are.
  - The server sends it as a DD WFAD container.
  - DF0's two slots (A/B) and every DF0 fetch, swap and preload are untouched. So an empty DF0 (a hard-drive boot)
    works, and a DF0 disk change never empties DF1.
- **Server and web.** `second_drive` accepts `'net'` (firmware 1.11.0+). Four new columns hold the `net` report. The
  card gets a third choice and a three-line checklist, and Help gets a `network` topic.

**Tech Stack:** C11, pico-sdk 2.3.0 (RP2350), lwIP behind `net_radio.h`; host tests via `wifi-floppy/firmware/test/run.sh`.
Next.js 16.3.2 (App Router route handlers), drizzle-orm 0.45 + hand-trimmed SQL migrations applied with `psql`, zod 4,
vitest 4, Playwright 1.62. amitools 0.4.0 (`xdftool`) for the disk. Amiga side: Kickstart/Workbench 3.1, AmiTCP_NG
v4.1.8, Rob's `PaulaNET.device` from `0afd5fa`.

**Spec (binding):** `docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md`. Also binding:
HANDOFF.md §3bi (Phase 2: the timing, acceptance 1-7, the not-measured busy-poll figure) and §3bh (Phase 1: layer-2
sharing, the DHCP client-id). The Phase 2 plan `docs/superpowers/plans/2026-10-11-paulanet-phase2-rob-driver.md` is the
code this plan gates; its bench recipes (FTP server, serial logger) are reused here.

## Rulings (made for the operator while planning; each is open to revision)

1. **The compile options keep their names; their defaults flip to ON.**
   - `WF_PNET_LOOP` now means "the PaulaNET transport on DF1 (cylinders 76/77)". `WF_PNET_L2` means "Ethernet frames
     on it". Both default ON, so the release and CI build them.
   - `-DWF_PNET_L2=OFF` (LOOP still ON) is the loopback echo TEST build. Only that build defines and logs
     `wf_pnet_loop_marker` ("wf-pnet-loop-test"), so `firmware-manifest.ts` keeps refusing it outside "TEST build" notes.
     The L2 code has no marker (spec §4).
   - Why not rename them: ~45 `#if` sites in `main.c` and `flux_capture.c` would change for no behavioural gain.
     The cost is a stale CMake cache: the main tree's `build/` holds `WF_PNET_LOOP=OFF` from Phase 2's release
     configuration. Ruling 21 deals with that.
2. **The runtime gate is one pure predicate, cached by core0.**
   - `pnet_mode_on(mode, echo_build)` (`pnet_loop.c`) is true for Network in every build. In the echo TEST build it
     is also true for Next disk, which is how that bench build has always run (`WF_DF1_DEFAULT=ON` stores Next).
   - core0 caches the result in `g_pnet_on` at boot and at every live DF1 change (`pnet_set_mode`). The STEP and WGATE
     ISRs and the loop read only `g_pnet_on`.
3. **The bridge stays installed in every mode, and passes through unless the mode is Network.**
   - `pnet_input` hands every frame straight to lwIP while `s_on` is false.
   - The 2 ms send worker discards anything queued (it is the TX ring's consumer) and returns.
   - Leaving Network mode drops the frames waiting for the Amiga (core0 is the RX ring's consumer), resets the link
     counters, and forgets the driver's last read. A later Network mode starts as at boot.
4. **The board's own DHCP client-id (Phase 1's lwIP hook) is sent in every mode from 1.11.0.** The spec does not
   mention it.
   - The hook is compile-time (`LWIP_HOOK_FILENAME`). Gating it by mode would make the router see a new client
     whenever the mode changes, and a renewal under a changed id can be NAKed.
   - Leaving it out of Off mode would bring back Phase 1's lease clash the first time the Amiga's AmiTCP_NG asks for
     `01:<MAC>` after a live switch to Network.
   - Cost: once, after the 1.11.0 install, a router may give the board a new address. Task 13 Step 9 records it.
   - **Operator, 2026-10-12: kept.** Users are told in two places:
     - the 1.11.0 release notes (Task 15 Step 3);
     - the `boards` help topic (Task 11), not the `network` topic, because it affects every board on 1.11.0
       whatever its DF1 setting.
5. **An unknown `secondDrive.mode` is acknowledged and otherwise ignored by 1.11.0.**
   - The board keeps the mode it runs, hands nothing to core0, stores nothing, and acks the seq so the server's wake
     (`seq !== driveAck`) stops. The card then reads "Waiting for the board".
   - See correction 1 for what older boards do.
6. **In Network mode DF1 holds the driver disk whatever DF0 holds** (operator, 2026-10-12; this replaces "Network
   needs a disk in DF0"). Next-disk mode keeps today's rule (DF1 only beside a disk in DF0, in DF0's idle slot).
   - **Where the old rule lived, and what changes** (Task 4b):
     - `psram_publish_df1` refuses any slot while DF0 is empty (`psram_image.c:348`). It now always accepts
       `SLOT_NET`.
     - `dc_df1_want` requires DF0 mounted and the idle slot (`device_client.c:722-723`). In Network mode it requires
       `SLOT_NET` instead.
     - `dc_preload_step` fetches into `psram_inactive_slot()` and skips a `next` equal to DF0's disk
       (`device_client.c:2079-2094`). In Network mode it targets `SLOT_NET` and has no such skip.
     - `dc_handle_poll_body` clears `next` on `desired: null` (`device_client.c:~1123`). Not in Network mode.
     - The poll sends `next` only with a disk desired (`poll/route.ts:164`). In Network mode it always sends it
       (Task 8).
     - `df1_live_apply` needs no change: it never looked at DF0.
   - **No collision with DF0's slots.** `SLOT_NET` is a separate PSRAM array (index 2):
     - `psram_inactive_slot()` still returns only 0 or 1, so every DF0 fetch, swap and preload keeps using A/B;
     - `psram_publish_slot` (DF0) refuses `SLOT_NET`;
     - the "swap to the preloaded disk" check (`device_client.c:1228`) compares with the inactive slot, so a DF0
       mount of any disk is a normal fetch into A/B;
     - `dc_df1_release` (eject DF1 before overwriting a slot) is never triggered by DF0, because DF1 never holds A/B
       in Network mode.
   - The token word carries two slot bits instead of one (`pack_word`/`slot_of_word`), so cached tracks of the three
     slots can never be confused.
   - Cost:
     - DF0's "Next disk" preload is not available in Network mode (the server's `next` is the driver disk), so a Next
       on DF0 is a normal fetch;
     - +901,120 B of PSRAM (fits: about 1.45 MB was free, measured from the 1.10.2 map plus Phase 2's 176 KB);
     - +~800 B SRAM for the third slot's per-track metadata.
7. **The disk starts from Rob's whole ADF, pinned, not a rebuild from his `DiskImage.cpp`.**
   - `third-party/paulanet/PaulaNET-0afd5fa.adf` (sha256 `d55d605c…537d0`) is the image Phase 2 used on the bench.
     It was decoded from `Pico/PaulaNET/DiskImage.cpp` at `0afd5fa`, the disk his own Pico serves.
   - It keeps his layout, his bitmap (cylinders 75-79 already allocated), `PaulaNET Config` and his icons, byte for
     byte.
   - A rebuild would need his RLE decoder ported into our repository, and it would give the same bytes.
   - The driver binary is also pinned on its own (`PaulaNET.device`, sha256 `205a4f68…e668cc`). The build checks the
     disk's copy against it, and spec §3 names it.
8. **The build is deterministic through a pinned clock.**
   - amitools 0.4.0 stamps files and the root block with `time.localtime()`, and its `time` command crashes
     (`get_path_name's path must be a FSString`, tried 2026-10-12).
   - So `xdf_fixed.py` runs xdftool with `localtime()` and `time()` pinned to 2026-10-11 12:00:00 UTC, under `TZ=UTC`.
   - Two builds made while writing this plan gave the same disk, sha256
     **`ca487c73a218e441ee429fe35cd636926a5c720afe5c5f8297a916e061beefc7`** (Task 3 pins it).
9. **The two icons reuse the picture from Rob's `PaulaNET Config.info`.**
   - Each becomes a project icon (do_Type 4) at NO_ICON_POSITION, with default tool `C:IconX` (Install) or
     `SYS:Utilities/MultiView` (ReadMe).
   - It is his artwork, on his disk, under his terms (spec §3). Drawing new icons would add no value.
10. **`Install` addresses the volume `PaulaNET:`, changes nothing more after a failed copy, and ends with `Ask`.**
    - The volume name works from Workbench (IconX) and from a Shell (`Execute PaulaNET:Install`) alike.
    - `Ask` keeps IconX's window open until Return.
11. **The driver disk is the one blob a board may fetch without an entitlement.**
    - `servedWithoutEntitlement(sha)` in `/api/device/image/[sha256]`. Blob GC always keeps it (a new reference
      source; memory rule "a new column naming a blob sha MUST join runBlobGc's reference list").
    - It is uploaded once by `scripts/paulanet-disk-upload.ts`.
    - Signed-in users download it from `GET /api/paulanet-disk` (spec §2 "Also downloadable").
12. **Network mode's `next` is `{diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1}`.**
    - It follows the user's chosen mode (`tick.secondDrive`), on every body, with or without a disk desired (ruling 6).
    - The image route sends this one digest as a **DD WFAD** container (`writeWfadDd`: magic 'WFAD', version 1, 160
      tracks, **11** sectors, then the 901,120-byte ADF). The board's loader accepts 11 sectors only into `SLOT_NET`,
      and 22 only into A/B as today (ruling 24).
    - The board only stores `diskId`/`diskNo` (`dc_take_next`), so the fixed id is harmless.
13. **The `net` report, from Network mode only:**
    - Shape: `"net":{"driver":<s>,"amigaIp":"a.b.c.d","framesIn":<n>,"framesOut":<n>}`. `driver` and `amigaIp` are
      absent while unknown.
    - `framesIn` counts the Amiga's frames taken into the TX ring. `framesOut` counts frames the Amiga acknowledged.
    - Saturation: 999,999 s and 999,999,999 frames. Both fit `int4`, and the tail stays at 95 bytes.
    - A report is owed when Network mode starts or ends, the driver is first heard, or the Amiga's address changes.
    - `DC_STATUS_BODY_BYTES` goes 1408→1536 and `DC_STATUS_REQ_BYTES` 1920→2048 (worst-case body 1,471).
14. **The server stores `net_driver_seen_at = now − driver s`.** A report that names its firmware but carries no `net`
    clears all four columns (the build-bound rule `recordStatus` already applies to `secondDrive`).
15. **The checklist's "Driver" line has three wordings; the spec gives two.**
    - Never heard: the spec's text.
    - Heard within 120 s (two heartbeats): "Driver: talking (last seen N s ago)".
    - Older: "Driver: not heard from for N min — run AddNetInterface eth0".
    - "Driver disk" keeps the spec's two states, "in DF1" and "loading". It does not depend on DF0 (ruling 6).
16. **Below 1.11.0 the Network option is rendered disabled as "Network (PaulaNET) — needs firmware 1.11.0".** The route
    also refuses it with 409 `firmware_too_old` (spec §5, §8).
17. **The df1_seen override saves the mode that was refused** (`net` or `df1`). The button texts stay as Help quotes
    them.
18. **The live fingerprint gains the second-drive and network fields.**
    - Today the DF1 status line changes only on a reload, because `secondDrive*` are not in `liveFingerprint`.
    - The driver line is fingerprinted by its bucket (talking / quiet / never), not by the timestamp, so a heartbeat
      does not refresh every open tab each minute.
19. **The card's preload line is hidden while the board reports Network mode.** The spare slot then holds the driver
    disk, so "Disk N: not preloaded yet" would be permanent and false.
20. **Order of rollout (operator, 2026-10-12):**
    1. The server is merged and deployed first. A pre-Phase-3 server parses `secondDrive: "net"` to `undefined`
       (`.catch`), and `recordStatus` then clears `second_drive_capable`.
    2. Then a **TEST build of the merge commit** is published (registry only, `--no-github`, notes starting
       "TEST build"), installed with the Amiga off, and the whole bench acceptance (Task 14) runs on it.
    3. Only after it passes, **1.11.0** is built, published to the registry and GitHub (the same signed files),
       installed, and smoke-checked (Task 15).
    - **Why the TEST build is also semver 1.11.0, from a different commit than the release:**
      - The registry refuses a duplicate full version string (`firmware-publish-rules.ts:90`) and a lower semver
        (`:94-102`).
      - The server's Network gate is `firmwareAtLeast(version, '1.11.0')`, so a TEST build below 1.11.0 could not
        even be set to Network.
      - So the TEST build is `1.11.0+g<merge sha>`. The release is `1.11.0+g<R>`, where R is the bench-record
        commit on master (Task 15 Step 1).
      - Its `wifi-floppy/` tree is checked identical to the merge commit's (`git diff <M> <R> -- wifi-floppy/` is
        empty), so the release image differs from the benched one only in its version string.
    - TEST notes on an image with no marker are accepted by `refuseReleaseImage`: it refuses markers without TEST
      notes, never TEST notes without a marker. `isTestBuild` keeps it off GitHub. Task 13 Step 2 pins this with a
      unit test.
21. **Every build that goes to the registry is made in the main tree's `build/` with every option given
    explicitly:** `-DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=OFF -DWF_FW_DEBUG=OFF`.
    - It is then checked by strings: no marker, one `pnet: L2 sharing ready`.
    - The cache there still says OFF (measured 2026-10-12: `WF_PNET_LOOP:BOOL=OFF` in
      `wifi-floppy/firmware/build/CMakeCache.txt`).
22. **`tools/pnet_off_identical.sh` is deleted.** "Off and Next are unchanged" is now proven three ways:
    - the host tests of the gate;
    - the boot log's `pnet: network path built in; off`;
    - bench §7.1. In Next mode, DF1 holds a disk whose one file fills cylinders 76/77, and `copy DF1:upper.bin TO NIL:`
      finishes without a read error. trackdisk checks every sector's header and checksum, so a PaulaNET track there
      would fail it.
23. **The busy-poll figure is captured to files this time.** The command is
    `NetLoop SELFTEST >RAM:st-off.txt` before `AddNetInterface`, and `>RAM:st-on.txt` after. Phase 2 lost both figures
    because the lines scrolled away.
24. **`SLOT_NET`'s storage and format (Task 4b).**
    - It is its own `__uninitialized_psram("netdisk")` array, `[160][5,632]`, of kind `SLOT_KIND_ADF_DD`.
    - It is filled from the DD WFAD container through `psram_image_store_adf`, which now sizes by kind. track_cache
      encodes it on read with `adf_mfm_encode_track(…, 11, …)`, 101,344 bits.
    - It is not a third MFM slot: 160 × 14,336 B (2.29 MB) does not fit in the ~1.45 MB of PSRAM left, and 901,120 B
      does.
    - On the host, a static array stands in for it, so the existing A/B backing that tests pass stays as it is.
    - Only DF1 ever publishes it, and only the driver disk ever goes into it.
25. **Flash writes are not held for DF1's driver disk.**
    - `token_store`, `config_store`, `display_store` and `fw_state` refuse to write only while DF0 holds a disk.
      With DF0 empty in Network mode they now write while DF1 streams.
    - Holding them for DF1 would refuse a Wi-Fi or display save for as long as Network mode lasts.
    - A write parks core0 for about 45 ms, so `dma_irq` misses at most one re-arm on DF1. The driver rejects that
      read by its checksum and retries it, as it already does for 4-5% of reads.
    - `drive_store` already counts DF1 (`!df1_mounted`, main.c:4615) and falls back to its idle rule.
26. **Release notes and Help say the address may change.**
    - The 1.11.0 notes end with "After updating, your router may give the board a new network address once; nothing
      needs changing."
    - The `boards` topic gains the same Good-to-know line.

## Corrections to the spec, from the code

1. **§4 "An older board ignores an unknown mode and keeps its own" is false for 1.9.0-1.10.2.**
   - `dc_take_second_drive` maps any unknown mode to Off and acks it (`device_client.c:1050`, test
     `a_bad_mode_is_handled_as_off_and_still_acked`).
   - The server's version gate keeps `'net'` from reaching such a board, except a board rolled back from 1.11.0. That
     board runs DF1 Off and its card says "Waiting for the board".
   - From 1.11.0 an unknown mode is ignored as the spec says (ruling 5).
2. **§7 "the `Install` script's logic is checked on the ADF with `xdftool`" can only check presence and allocation.**
   - xdftool has no AmigaDOS shell. vamos has no ROM-resident `If`/`Skip`/`Echo`.
   - The host check is therefore that the files are present with the right bytes, cylinders 75-79 are allocated, and
     the disk matches its pinned digest.
   - The script's behaviour (idempotent, never overwriting `eth0`) is checked on the bench (Task 14 Steps 6-7).
3. **§2 "served … through the same path as the next disk" holds for the poll (`next`), but not for the bytes.**
   - The board keeps the driver disk in its own slot, as sector data, and the server sends it as a DD WFAD
     container, not WFMF (rulings 6, 24).
   - The same path would put it in DF0's idle slot, where a DF0 disk change would overwrite it.
   - The spec's "the board needs no built-in disk and no flash space" still holds: it costs PSRAM, not flash.

## Global Constraints

- **Values from the spec:**
  - Release `1.11.0`; `SECOND_DRIVE_NET_FW = '1.11.0'`.
  - Mode string `"net"`; zod enum `['off','df1','net']`.
  - Columns `net_driver_seen_at` (timestamp), `net_amiga_ip` (text), `net_frames_in` and `net_frames_out` (int).
  - Status line "Set on the board — takes effect when the Amiga restarts".
  - Checklist texts "Driver disk: in DF1" / "Driver disk: loading", "Driver: talking (last seen 4 s ago)" /
    "Driver: not heard from yet — run Install, then AddNetInterface eth0", "Amiga address: 172.16.10.231" /
    "Amiga address: none yet".
  - Help topic id `network`, title "Amiga networking (PaulaNET)".
  - Rob's line "Copyright © 2026 RobSmithDev. All rights reserved."
  - The timing is Phase 2's (120-byte lead-in, side-1 start 2,360 µs after SIDE), unchanged.
  - Final-review m5 stays parked: do not change the delayed-start re-arm.
- **Worktree and branch:** `.claude/worktrees/pnet3` on `feat/paulanet-phase3`, from master (`661fbd1` or later; master
  was `966a6a8` when this plan was written). All work, builds and e2e happen there, except the release build
  (Task 13, ruling 21).
  - Never build into `/Users/sfs/Devel/webadf/wifi-floppy/firmware/build` before Task 13.
  - This plan sits untracked in the main tree until Task 1 moves it.
- **Git:**
  - No `git stash`, `git checkout` or `git reset`, in any form, for any reason. To see an old version use
    `git show <sha>:<path>`.
  - Re-check `git status` before staging, and stage files by name. Never `git add -A` or `git add .`.
  - Leave the main tree's untracked `.fw-target.mts`, `.hd-mount.mts` and `docs/schematic/` alone (they are not
    ignored).
  - Every commit ends with:
    ```
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU
    ```
  - Kickstart ROMs under `docs/` are never committed.
- **Rob's files:** only under `third-party/paulanet/`, under his terms, never described as MIT.
  - Every new file of ours that implements his protocol starts with "PaulaNET protocol: Copyright (C) 2026
    RobSmithDev, https://github.com/RobSmithDev/PaulaNET. Used with the author's permission (2026-10-09)". Files
    that already carry it keep it.
- **Toolchain:** run `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"` before any firmware
  build. With `F="-G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350"`, from
  `wifi-floppy/firmware/` in the worktree:
  - release: `cmake -B build $F -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=OFF && cmake --build build`
  - echo TEST: `cmake -B build-pnet $F -DWF_PNET_LOOP=ON -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=ON && cmake --build build-pnet`
  - Zero warnings: `cmake --build <dir> 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'` prints nothing.
  - `-Werror=frame-larger-than=768` holds for every source of ours.
- **Host tests:** `wifi-floppy/firmware/test/run.sh; echo "exit $?"` must print `exit 0` (2-3 min; it reports a
  failure and carries on).
  - New and changed C tests also run once under `gcc:13` (CI's compiler), with the `docker run` form of Task 6 Step 9.
- **The radio's name** may appear only in `net_radio_cyw43.c`. `run.sh` greps the other sources for it, comments
  included. Write "the radio".
- **SRAM:** the heap floor is 20,480 B. Phase 2's heap low-water was 32,768 B. Measure `.bss`/`.data`/`.bin` in
  Task 5 Step 12 against 1.10.2's release image, measured 2026-10-12 from `build/wifi_floppy.elf` (1.10.2+g74c2b2e):
  `.text` 328,056, `.data` 10,328, `.bss` 419,444, `.psram_noload` 6,684,672, `.bin` 610,624 B.
- **PSRAM:** 8 MB (`0x11000000`-`0x11800000`).
  - Today it holds `g_fw_stage` (2 MB) and `device_image` (0x460000 = 4,587,520 B).
  - Phase 2's rings and echo store (~176 KB) and `SLOT_NET` (901,120 B) must still fit: `.psram_noload` ≤ 8,388,608
    with the 2 MB stage included.
  - Task 4b Step 9 measures it.
- **DF0 in Network mode is untouched:** no DF0 fetch, swap, preload or eject may read or write `SLOT_NET`, and DF1 in
  Network mode publishes nothing but `SLOT_NET` (ruling 6).
- **Registry builds:** the TEST build and the release are both built in the main tree's `build/` (ruling 21). The
  TEST build goes to the registry only (`--no-github`, notes "TEST build: …"). The release goes to the registry and
  GitHub together, only after Task 14 passes on the TEST build (ruling 20).
- **Web:**
  - Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` and
    `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` before writing a route handler.
  - Follow the repo's pattern: `export async function GET(request: Request, ctx: { params: Promise<…> })`, `await
    ctx.params`, `Response.json`.
- **Migrations:** hand-trimmed SQL in `drizzle/`, `ADD COLUMN IF NOT EXISTS`, additive.
  - Generate with `pnpm db:generate --name <name>` to keep the snapshot and journal, then trim the SQL.
  - Apply to the live DB with `psql` **before** e2e and before the merge (master deploys to production).
- **e2e:** only the specs this plan touches. `PORT=3100`, serialized (never two runs at once, from any worktree:
  they share the live database), each command under 9 minutes, in the foreground.
  - Never `pkill`/`killall`; stop only your own PIDs.
  - Prove the environment clean before blaming code: `lsof -nP -iTCP:3100 -sTCP:LISTEN` shows nothing before a run.
- **Help text:** `src/lib/help/topics.tsx` changes with the behaviour.
  - Each topic: short of 1-2 sentences, body of 60-260 words, none of PSRAM, TBYB, poll, sha256, cursor, WPROT.
  - The second-drive caveats stay (write-protected, restart/warm, other DF1, DF2, five seconds, next disk of the set,
    refuse/anyway, 1.9.0, older firmware, HD).
- **Show both values of a state:** every checklist line names its good and its bad state in words.
- **Bench steps:**
  - Each operator step is one turn and ends the turn, with the request as the last thing in it. The operator is the
    only sensor: every step has a visible PASS or FAIL.
  - Serial log: run `pgrep -fl serstream.py` first. If one runs on `/dev/cu.usbmodem1101`, use its log (its last
    argument) and never start a second. Otherwise start `python3 <scratchpad>/serstream.py /dev/cu.usbmodem1101 86400
    <scratchpad>/pnet3-bench.log` in the background. Copy `serstream.py` from
    `/private/tmp/claude-501/-Users-sfs-Devel-webadf/fa1f7997-11c2-4c01-a121-0f34f0567b3c/scratchpad/serstream.py`,
    or recreate it from `docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md` Task 9 Step 5.
  - Before believing any absence in the log: `grep -c 'records dropped' <log>` must be 0.
- **Installs eject DF0.** The Amiga must be OFF first: ask the operator as the last thing in a turn. Then, from
  `/Users/sfs/Devel/webadf`, run `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '<version>'`, and say in the
  conversation that an install was triggered.
- **DF1 has one user at a time:** never run a NetLoop mode that opens DF1 while `eth0` is up. `SELFTEST` does not open
  DF1.
- **Relay everything:** every subagent finding, ruling, deviation or rule break goes to the operator in the main
  conversation, and every ruling goes into HANDOFF §3bj (Task 15).

## Review Focus

1. **A 1.11.0 board reports `secondDrive: "net"` (and a `net` tail) to the server.**
   - Expected: stored as `secondDriveReported='net'`, `secondDriveCapable=true`. It is never dropped to `undefined`,
     which would clear the capability.
   - Tests: `status/route.test.ts` "passes secondDrive net and the net tail through" (Task 7) and
     `mount-record-status.test.ts` "stores the net report" (Task 7). Ordering: ruling 20, Task 13 Step 5.
2. **Network mode with DF0 empty (a hard-drive boot), then a disk mounted in DF0, then a different one.**
   - Expected:
     - the server sends the driver disk as `next` with `desired: null`;
     - the board fetches it into `SLOT_NET` and DF1 holds it;
     - each DF0 fetch goes into A/B and DF1 never leaves `SLOT_NET`: no DF1 eject, no network pause.
   - Tests: poll `route.test.ts` "Network mode with nothing desired: next is still the driver disk" (Task 8), and
     `network_mode_holds_the_driver_disk_whatever_df0_does` (Task 4b). Bench: Task 14 Steps 5 and 14b.
3. **The server sends a mode string this firmware does not know** (a future mode, or a corrupted body).
   - Expected: acked and ignored. The board keeps its mode, nothing reaches core0, and the poll does not spin.
   - Test: `a_bad_mode_is_acked_and_ignored` (Task 4).
4. **Network mode ends while frames are queued or a pre-arm stands.**
   - Expected: the pre-arm is cancelled, no stale frame is sent at the next Network mode, and DF1 serves plain disk
     tracks again.
   - Tests: `leaving_network_mode_cancels_a_standing_prearm` and `the_network_path_runs_only_in_network_mode` (Task
     5). The ring drain is read in the bench log (Task 14 Step 16).
5. **A real DF1 was seen; the user picks Network and overrides.**
   - Expected: the override saves `'net'`, not `'df1'`.
   - Test: e2e "a seen DF1 refuses Network; the override saves Network" (Task 12).

## File structure

| File | Responsibility |
|---|---|
| `third-party/paulanet/` (new): `PaulaNET.device`, `PaulaNET-0afd5fa.adf`, `LICENSE`, `PERMISSION.md`, `README.md` | Task 2: Rob's files under his terms |
| `.gitignore`, `THIRD-PARTY-NOTICES.md` | Task 2: un-ignore the pinned ADF; the notice line |
| `tools/paulanet-disk/` (new): `build.sh`, `xdf_fixed.py`, `make_icon.py`, `check.py`, `Install`, `ReadMe`, `paulanet-disk.sha256` | Task 3: the driver disk |
| `wifi-floppy/firmware/src/drive_store.{h,c}`, `df1_live.c`, `test/test_drive_store.c`, `test/test_df1_live.c` | Task 4: `DF1_MODE_NET`, wire names |
| `wifi-floppy/firmware/src/device_client.{h,c}`, `test/test_device_client.c` | Task 4: parse/ack/DF1 policy. Task 6: the `net` tail, budgets |
| `wifi-floppy/firmware/src/psram_image.{h,c}`, `image_loader.{h,c}`, `track_cache.c`, `test/test_psram_image.c`, `test/test_image_loader_wfad.c`, `test/test_track_cache.c` | Task 4b: `SLOT_NET`, DD WFAD, the two-bit token |
| `wifi-floppy/firmware/src/device_client.c` (Network-mode DF1 policy), `test/test_device_client.c` | Task 4b |
| `wifi-floppy/firmware/src/pnet_loop.{h,c}`, `test/test_pnet_loop.c` | Task 5: `pnet_mode_on` |
| `src/lib/adfmfm/wfad.ts` (+test) | Task 8: `writeWfadDd` |
| `src/lib/firmware-manifest.test.ts`, `src/lib/firmware-github-release.test.ts` | Task 13: TEST notes on a marker-less image are accepted and kept off GitHub |
| `wifi-floppy/firmware/CMakeLists.txt`, `lwipopts.h`, `src/pnet_lwip_hooks.h` | Task 5: defaults, comments |
| `wifi-floppy/firmware/src/main.c` | Task 5: the gate. Task 6: the counters and `dc_set_net`. Task 13: nothing |
| `wifi-floppy/firmware/src/pnet_bridge.{h,c}` | Task 5: `pnet_bridge_set_on` |
| `wifi-floppy/firmware/tools/pnet_off_identical.sh` | Task 5: deleted |
| `drizzle/0034_paulanet_net.sql` (+ meta), `src/db/schema/devices.ts` | Task 7 |
| `src/app/api/device/status/route.ts` (+test), `src/lib/mount.ts`, `src/lib/mount-record-status.test.ts`, `src/lib/second-drive.ts` (+test), `src/lib/queries.ts` | Task 7 |
| `src/lib/paulanet-disk.ts` (+test), `scripts/paulanet-disk-upload.ts`, `src/app/api/device/poll/route.ts` (+test), `src/app/api/device/image/[sha256]/route.ts`, `src/lib/blob-gc-run.ts`, `src/app/api/paulanet-disk/route.ts` | Task 8 |
| `src/app/api/devices/[id]/second-drive/route.ts` (+test) | Task 9 |
| `src/lib/network-checklist.ts` (+test), `src/components/devices/network-checklist.tsx`, `second-drive-setting.tsx`, `device-card.tsx`, `src/lib/live-state.ts` (+test) | Task 10 |
| `src/lib/help/topics.tsx`, `topics.test.ts` | Task 11 |
| `e2e/second-drive.spec.ts`, `e2e/help.spec.ts`, `e2e/device-image.spec.ts` | Task 12 |
| `wifi-floppy/firmware/CMakeLists.txt` (`FIRMWARE_SEMVER`) | Task 13 |
| `HANDOFF.md` | Task 15 (the bench record, which is also the release commit R), Task 16 |

---

### Task 1: The worktree and its environment

**Files:** none changed except this plan, which moves into the worktree and is committed there.

**Interfaces:**
- Consumes: master.
- Produces: `.claude/worktrees/pnet3` on `feat/paulanet-phase3`, ready for `pnpm tsc`, vitest, e2e and firmware builds.

- [ ] **Step 1: Check the main tree, then create the worktree.** From `/Users/sfs/Devel/webadf`:

```bash
git status --short          # expect only: ?? .fw-target.mts ?? .hd-mount.mts ?? docs/schematic/ ?? docs/superpowers/plans/2026-10-12-paulanet-phase3-network-setting.md
git branch --list feat/paulanet-phase3   # expect nothing
ls .claude/worktrees/pnet3 2>/dev/null   # expect nothing
git worktree add .claude/worktrees/pnet3 -b feat/paulanet-phase3 master
mv docs/superpowers/plans/2026-10-12-paulanet-phase3-network-setting.md .claude/worktrees/pnet3/docs/superpowers/plans/
```

  - If the branch or the directory already exists, do not recreate it: `cd` into it, check
    `git -C .claude/worktrees/pnet3 log --oneline -1`, and go on from Step 2.
  - If `git status` shows other changes, leave them alone: they belong to another session.

- [ ] **Step 2: The environment** (memory note "worktree e2e setup"). From `/Users/sfs/Devel/webadf/.claude/worktrees/pnet3`:

```bash
cp /Users/sfs/Devel/webadf/.env.local .env.local
pnpm install --offline            # real node_modules; a symlink crashes Turbopack
npx next typegen                  # or tsc reports missing PageProps/LayoutProps
ln -s /Users/sfs/Devel/webadf/adf-archive adf-archive
pnpm tsc --noEmit && pnpm vitest run src/lib/second-drive.test.ts
```

  Expected: install finishes in seconds from the store, `tsc` prints nothing, and vitest passes.

- [ ] **Step 3: Commit the plan**

```bash
git add docs/superpowers/plans/2026-10-12-paulanet-phase3-network-setting.md
git commit -m "docs(plan): PaulaNET Phase 3 -- Network (PaulaNET) as a DF1 setting, the driver disk, release 1.11.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 2: Rob's files, pinned under his terms

`/private/tmp` does not survive a reboot, so this task comes before anything that needs his bytes.

**Files:**
- Create: `third-party/paulanet/PaulaNET.device`, `third-party/paulanet/PaulaNET-0afd5fa.adf`,
  `third-party/paulanet/LICENSE`, `third-party/paulanet/PERMISSION.md`, `third-party/paulanet/README.md`.
- Modify: `.gitignore` (after `*.adf`, line 3), `THIRD-PARTY-NOTICES.md` (the PaulaNET entry, lines 35-41).

**Interfaces:**
- Consumes: the scratchpad image
  `/private/tmp/claude-501/-Users-sfs-Devel-webadf/fa1f7997-11c2-4c01-a121-0f34f0567b3c/scratchpad/rob/adf/paulanet.adf`.
- Produces:
  - `third-party/paulanet/PaulaNET-0afd5fa.adf`, sha256 `d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0`;
  - `third-party/paulanet/PaulaNET.device`, 13,872 B, sha256 `205a4f68dbbb7c58526cfb6c2ead65bf7ba05ad0c59484660574025b31e668cc`.

- [ ] **Step 1: Copy and check the image**

```bash
S=/private/tmp/claude-501/-Users-sfs-Devel-webadf/fa1f7997-11c2-4c01-a121-0f34f0567b3c/scratchpad
mkdir -p third-party/paulanet
cp "$S/rob/adf/paulanet.adf" third-party/paulanet/PaulaNET-0afd5fa.adf
shasum -a 256 third-party/paulanet/PaulaNET-0afd5fa.adf
xdftool third-party/paulanet/PaulaNET-0afd5fa.adf read PaulaNET.device third-party/paulanet/PaulaNET.device
shasum -a 256 third-party/paulanet/PaulaNET.device; wc -c < third-party/paulanet/PaulaNET.device
```

  Expected: `d55d605c…37d0`, then `205a4f68…e668cc`, then `13872`.
  - **If the scratchpad file is gone** (a reboot), the bench copy is `~/Downloads/paulanet-0afd5fa.adf` (Phase 2 Task 6
    Step 1). Use it if its sha256 is `d55d605c…37d0`.
  - **If neither exists or a digest differs:** stop and ask the operator. Never rebuild the image from a source that
    has not been read.

- [ ] **Step 2: Un-ignore the pinned image.** `.gitignore` line 3 is `*.adf`. Add directly below it:

```
# Rob Smith's own PaulaNET disk, pinned as the base of our driver disk (plan 2026-10-12, ruling 7).
!third-party/paulanet/PaulaNET-0afd5fa.adf
```

  Then check: `git check-ignore -v third-party/paulanet/PaulaNET-0afd5fa.adf` prints nothing (exit 1), and
  `git check-ignore -v tools/paulanet-disk/x.adf` still matches `*.adf`.

- [ ] **Step 3: `third-party/paulanet/LICENSE`** (his line, exactly as his `readme.md` "Licence" section has it at `0afd5fa`):

```
PaulaNET (https://github.com/RobSmithDev/PaulaNET), including PaulaNET.device and PaulaNET Config:

Copyright © 2026 RobSmithDev. All rights reserved.

The files in this directory are redistributed with the author's permission, under his terms
(see PERMISSION.md). They are NOT covered by webadf's MIT licence.
```

- [ ] **Step 4: `third-party/paulanet/PERMISSION.md`**

```markdown
# PaulaNET: permission to use and redistribute

Author: Rob Smith (RobSmithDev), https://github.com/RobSmithDev/PaulaNET
Licence: "Copyright © 2026 RobSmithDev. All rights reserved." (LICENSE in this directory)

Two grants, both relayed to webadf by its operator, Stefan Skotte:

1. **2026-10-09:** the PaulaNET protocol may be implemented in webadf's firmware and tools, provided his
   licences are respected and he is credited. (THIRD-PARTY-NOTICES.md, "Protocols used with permission".)
2. **2026-10-12:** all of his PaulaNET code may be used and redistributed, on his terms. webadf uses this to
   put his unmodified `PaulaNET.device` and `PaulaNET Config` on the PaulaNET driver disk that the board serves
   as DF1 in Network mode (spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md).

Rob's own message is to be added here by the operator when convenient.
```

- [ ] **Step 5: `third-party/paulanet/README.md`**

```markdown
# third-party/paulanet

Pinned from https://github.com/RobSmithDev/PaulaNET at commit 0afd5fa (2026-06-13). Not MIT: see LICENSE.

| File | sha256 | What |
|---|---|---|
| `PaulaNET-0afd5fa.adf` | d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0 | His disk image, decoded from `Pico/PaulaNET/DiskImage.cpp` (FFS, volume "PaulaNET", 12.06.2026; cylinders 75-79 allocated) |
| `PaulaNET.device` | 205a4f68dbbb7c58526cfb6c2ead65bf7ba05ad0c59484660574025b31e668cc | His driver, 13,872 bytes, read out of that image |

`tools/paulanet-disk/build.sh` builds the PaulaNET driver disk from the image and checks the driver against the
pinned binary. Neither file is ever modified.
```

- [ ] **Step 6: The root notice.** In `THIRD-PARTY-NOTICES.md`, the PaulaNET entry ends "...are the output of his
  reference encoders." Append to that entry, as its last sentence:

```
  The PaulaNET driver disk that the board serves in Network mode carries his unmodified `PaulaNET.device` and
  `PaulaNET Config`, redistributed by permission (2026-10-12) under his terms ("Copyright © 2026 RobSmithDev. All
  rights reserved."); they are not MIT. See `third-party/paulanet/`.
```

- [ ] **Step 7: Commit**

```bash
git status --short     # third-party/paulanet/* (5 files), .gitignore, THIRD-PARTY-NOTICES.md
git add third-party/paulanet/PaulaNET.device third-party/paulanet/PaulaNET-0afd5fa.adf third-party/paulanet/LICENSE \
        third-party/paulanet/PERMISSION.md third-party/paulanet/README.md .gitignore THIRD-PARTY-NOTICES.md
git commit -m "third-party: pin Rob Smith's PaulaNET disk and driver (0afd5fa) under his terms, with the permission record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 3: The PaulaNET driver disk (`tools/paulanet-disk/`)

**Files:** Create `tools/paulanet-disk/{build.sh,xdf_fixed.py,make_icon.py,check.py,Install,ReadMe,paulanet-disk.sha256}`.

**Interfaces:**
- Consumes: Task 2's pinned files.
- Produces:
  - `tools/paulanet-disk/build.sh <out.adf>`, which prints `PASS` lines and the disk's sha256, and exits 1 on any
    failure;
  - `tools/paulanet-disk/paulanet-disk.sha256`, one line holding
    `ca487c73a218e441ee429fe35cd636926a5c720afe5c5f8297a916e061beefc7`. Task 8 pins the same value in TypeScript.

- [ ] **Step 1: The check first (the "test").** Create `tools/paulanet-disk/check.py`:

```python
"""Checks a built PaulaNET disk without an Amiga: the files are there with the
right bytes, and cylinders 75-79 are still allocated in the bitmap, so no file can
ever land on the network cylinders. Usage: check.py <disk.adf> <listing.txt>
(listing = `xdftool <disk> list` output). Prints PASS lines; exits 1 on a failure."""
import struct, sys

WANT = {'PaulaNET.device': 13872, 'PaulaNET Config': 55536, 'Install': None, 'Install.info': None,
        'ReadMe': None, 'ReadMe.info': None, 'disk.info': 364}

disk = open(sys.argv[1], 'rb').read()
listing = open(sys.argv[2]).read().splitlines()
fail = 0
def check(ok, what):
    global fail
    print(('PASS ' if ok else 'FAIL ') + what)
    if not ok: fail = 1

check(len(disk) == 901120, 'a DD disk image, 901,120 bytes')
sizes = {}
for line in listing[1:]:
    parts = line.split()
    # "  <name...>  <size>  <flags>  <date> <time>": the size is the 4th field from the end
    if len(parts) >= 4 and parts[-4].isdigit():
        sizes[' '.join(parts[:-4])] = int(parts[-4])
for name, size in WANT.items():
    check(name in sizes and (size is None or sizes[name] == size), f'{name} present' + (f', {size} bytes' if size else ''))
root = disk[880 * 512:881 * 512]
bm_block = struct.unpack('>I', root[316:320])[0]
bm = disk[bm_block * 512:(bm_block + 1) * 512]
def free(b):
    i = b - 2
    return (struct.unpack('>I', bm[4 + 4 * (i // 32):8 + 4 * (i // 32)])[0] >> (i % 32)) & 1 == 1
check(not any(free(b) for b in range(75 * 22, 80 * 22)), 'cylinders 75-79 (blocks 1650-1759) all allocated')
sys.exit(fail)
```

- [ ] **Step 2: Run it on Rob's image, expecting the files of ours to FAIL**

```bash
xdftool third-party/paulanet/PaulaNET-0afd5fa.adf list > /tmp/pnet3-base-list.txt
python3 -I tools/paulanet-disk/check.py third-party/paulanet/PaulaNET-0afd5fa.adf /tmp/pnet3-base-list.txt; echo "exit $?"
```

  Expected:
  - PASS for the size, `PaulaNET.device`, `PaulaNET Config`, `disk.info` and the cylinders;
  - FAIL for `Install`, `Install.info`, `ReadMe` and `ReadMe.info`;
  - `exit 1`.

  (Measured while planning: Rob's bitmap has 0 free blocks in 1650-1759, and 1,388 free in all, which agrees with
  `xdftool info`.)

- [ ] **Step 3: `tools/paulanet-disk/Install`** (AmigaDOS script; LF line endings, exactly this text):

```
; Install -- puts Rob Smith's PaulaNET.device in place for a TCP/IP stack.
; From webadf (https://github.com/stefanskotte/webadf). Safe to run more
; than once: the driver is copied again, and an existing eth0 is never
; changed.
FailAt 21
If NOT EXISTS DEVS:Networks
  MakeDir DEVS:Networks
EndIf
Copy PaulaNET:PaulaNET.device DEVS:Networks/ CLONE QUIET
If WARN
  Echo "Could not copy PaulaNET.device to DEVS:Networks."
  Echo "Nothing else was changed."
  Skip DONE
EndIf
Echo "Copied PaulaNET.device to DEVS:Networks."
If EXISTS DEVS:NetInterfaces/eth0
  Echo "DEVS:NetInterfaces/eth0 already exists: left as it is."
  Echo "For PaulaNET it needs these three lines:"
  Echo "  device=PaulaNET.device"
  Echo "  unit=0"
  Echo "  configure=dhcp"
Else
  If NOT EXISTS DEVS:NetInterfaces
    MakeDir DEVS:NetInterfaces
  EndIf
  Echo >DEVS:NetInterfaces/eth0 "device=PaulaNET.device"
  Echo >>DEVS:NetInterfaces/eth0 "unit=0"
  Echo >>DEVS:NetInterfaces/eth0 "configure=dhcp"
  Echo "Wrote DEVS:NetInterfaces/eth0."
EndIf
Echo ""
Echo "Next, in a Shell:  AddNetInterface eth0"
Echo "To go online at every start, add that line to S:User-Startup."
Lab DONE
Echo ""
Ask "Press Return to close this window."
```

  Why each line (for the reviewer):
  - `FailAt 21` lets the script see a failed `Copy` instead of stopping silently.
  - `PaulaNET:` is the disk's volume name, so it works from IconX and from `Execute PaulaNET:Install`.
  - The three `eth0` lines are exactly the file the Phase 2 bench used (HANDOFF §3bi). AmiTCP_NG and Roadshow both
    read `DEVS:NetInterfaces/` (spec §2).
  - Steps can be added before `Lab DONE` (spec §9: room for Phase 4).

- [ ] **Step 4: `tools/paulanet-disk/ReadMe`** (LF line endings, exactly this text):

```
PaulaNET driver disk
====================

This disk puts your Amiga on the network through the WiFi floppy
board's Wi-Fi, using the board as drive DF1.

PaulaNET and its driver, PaulaNET.device, are by Rob Smith
(RobSmithDev): https://github.com/RobSmithDev/PaulaNET
Copyright (c) 2026 RobSmithDev. All rights reserved.
PaulaNET.device and PaulaNET Config are on this disk with his
permission, under his terms. They are not covered by webadf's
MIT licence.

The Install script and this ReadMe are from webadf.

You need a TCP/IP stack, such as AmiTCP_NG or Roadshow, and no
other drive answering as DF1.

1. Double-click Install (or type: Execute PaulaNET:Install).
   It copies PaulaNET.device to DEVS:Networks and, unless one is
   already there, writes DEVS:NetInterfaces/eth0.
2. In a Shell, type:  AddNetInterface eth0
3. To go online at every start, add that line to S:User-Startup.

Keep this disk in DF1 while you are online: the driver checks for
it when it starts. PaulaNET Config is not needed with the WiFi
floppy board; its Wi-Fi is set on the board's web page.
```

  (ASCII "(c)", not "©": Workbench 3.1's topaz font and MultiView show plain ASCII reliably.)

- [ ] **Step 5: `tools/paulanet-disk/make_icon.py`**

```python
"""A Workbench project icon from a tool icon: the same picture, do_Type WBPROJECT,
and a default tool. Usage: make_icon.py <tool.info> <default tool> <out.info>

The input must be a plain OS 2+ tool icon with no default tool, no tool types and
no drawer data (Rob's "PaulaNET Config.info" is one); anything else is refused.
After the images, an icon carries its default tool as a ULONG length (with the NUL)
and the string -- so that is appended, and do_DefaultTool is made non-zero."""
import struct, sys

src, tool, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = bytearray(open(src, 'rb').read())
magic, ver = struct.unpack('>HH', d[0:4])
do_type = d[48]
deftool, tooltypes = struct.unpack('>II', d[50:58])
drawer = struct.unpack('>I', d[66:70])[0]
if (magic, ver, do_type, deftool, tooltypes, drawer) != (0xE310, 1, 3, 0, 0, 0) or b'FORM' in d:
    sys.exit('make_icon: %s is not a plain tool icon' % src)
d[48] = 4                                  # WBPROJECT
struct.pack_into('>I', d, 50, 0x00000001)  # do_DefaultTool: non-zero = present
struct.pack_into('>II', d, 58, 0x80000000, 0x80000000)  # NO_ICON_POSITION: Workbench places it
s = tool.encode('ascii') + b'\x00'
d += struct.pack('>I', len(s)) + s
open(out, 'wb').write(bytes(d))
```

  (Read from his icons while planning: `PaulaNET Config.info` is 514 B, magic E310 v1, 60×26, do_Type 3, no default
  tool, no tool types, no drawer, no `FORM` chunk.)

- [ ] **Step 6: `tools/paulanet-disk/xdf_fixed.py`**

```python
"""xdftool with a fixed clock, so the disk is the same bytes on every build.
amitools stamps files and the root block with time.localtime(); this pins it to
2026-10-11 12:00:00 UTC (run under TZ=UTC). Usage: as xdftool."""
import sys, time
FIXED = 1791720000
_localtime = time.localtime
time.localtime = lambda secs=None: _localtime(FIXED if secs is None else secs)
time.time = lambda: float(FIXED)
from amitools.tools.xdftool import main
sys.argv = ['xdftool'] + sys.argv[1:]
sys.exit(main())
```

- [ ] **Step 7: `tools/paulanet-disk/build.sh`** (then `chmod +x tools/paulanet-disk/build.sh`)

```bash
#!/usr/bin/env bash
# Builds the PaulaNET driver disk (spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md §2)
# from Rob Smith's own disk (third-party/paulanet/, pinned) plus our Install script, ReadMe and their icons.
# Deterministic: the same inputs give the same bytes, whose sha256 is pinned in paulanet-disk.sha256.
# Usage: tools/paulanet-disk/build.sh <out.adf>     Needs xdftool (amitools 0.4.0).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$1"
base="$repo/third-party/paulanet/PaulaNET-0afd5fa.adf"
base_sha=d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0
[ "$(shasum -a 256 "$base" | cut -d' ' -f1)" = "$base_sha" ] || { echo "FAIL: $base is not the pinned image"; exit 1; }
# amitools' own interpreter (xdftool's shebang), so xdf_fixed.py imports the same amitools.
py="$(head -1 "$(command -v xdftool)" | sed 's/^#!//')"
xdf() { TZ=UTC "$py" -I "$here/xdf_fixed.py" "$@" </dev/null; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$base" "$tmp/disk.adf"
xdftool "$tmp/disk.adf" read "PaulaNET Config.info" "$tmp/tool.info"
python3 -I "$here/make_icon.py" "$tmp/tool.info" "C:IconX" "$tmp/Install.info"
python3 -I "$here/make_icon.py" "$tmp/tool.info" "SYS:Utilities/MultiView" "$tmp/ReadMe.info"
cp "$here/Install" "$here/ReadMe" "$tmp/"
( cd "$tmp" && xdf disk.adf write Install + write Install.info + write ReadMe + write ReadMe.info \
                + protect Install srwed )
xdftool "$tmp/disk.adf" list > "$tmp/list.txt"
python3 -I "$here/check.py" "$tmp/disk.adf" "$tmp/list.txt"
xdftool "$tmp/disk.adf" read PaulaNET.device "$tmp/driver"
cmp -s "$tmp/driver" "$repo/third-party/paulanet/PaulaNET.device" \
  && echo "PASS PaulaNET.device is the pinned binary" || { echo "FAIL: PaulaNET.device differs from third-party/paulanet/"; exit 1; }
cp "$tmp/disk.adf" "$out"
got="$(shasum -a 256 "$out" | cut -d' ' -f1)"
echo "$got  $out"
if [ -f "$here/paulanet-disk.sha256" ] && [ "$(cat "$here/paulanet-disk.sha256")" != "$got" ]; then
  echo "FAIL: not the pinned disk ($(cat "$here/paulanet-disk.sha256")) -- an input changed; the server's PAULANET_DISK_SHA256 must change with it"
  exit 1
fi
```

  The `s` (script) bit lets `PaulaNET:Install` run as a command as well.

- [ ] **Step 8: Build twice, a second apart, and compare**

```bash
xdftool --help >/dev/null; head -1 "$(command -v xdftool)"     # .../amitools/0.4.0/libexec/bin/python3.9
tools/paulanet-disk/build.sh /tmp/pnet3-a.adf && sleep 1 && tools/paulanet-disk/build.sh /tmp/pnet3-b.adf
xdftool /tmp/pnet3-a.adf list
```

  Expected:
  - every check prints PASS (9 lines, plus `PASS PaulaNET.device is the pinned binary`), twice;
  - both digests are `ca487c73a218e441ee429fe35cd636926a5c720afe5c5f8297a916e061beefc7`;
  - the listing shows `Install` 1204 B `-s--rwed`, `Install.info` 526, `ReadMe` 1076, `ReadMe.info` 542, our files
    dated 11.10.2026, and Rob's untouched at 12.06.2026.

  Outcomes:
  - **The digests differ from each other:** the clock pin did not take. Check that the interpreter is amitools' own
    (shebang above) and that `TZ=UTC` is set. Do not go on.
  - **They match each other but not `ca487c73…`:** an input differs from this plan (most likely a trailing newline or
    CRLF in `Install`/`ReadMe`: `file tools/paulanet-disk/Install` must say "ASCII text", not "with CRLF"), or
    amitools is not 0.4.0. Diff the text against Steps 3-4 first. Only if they are byte-identical and amitools differs,
    stop and report the new digest to the operator. That digest then replaces `ca487c73…` here and in Task 8.

- [ ] **Step 9: Pin the digest, and prove the pin refuses a change**

```bash
echo ca487c73a218e441ee429fe35cd636926a5c720afe5c5f8297a916e061beefc7 > tools/paulanet-disk/paulanet-disk.sha256
tools/paulanet-disk/build.sh /tmp/pnet3-c.adf; echo "exit $?"          # PASS ..., exit 0
printf 'x' >> tools/paulanet-disk/ReadMe && { tools/paulanet-disk/build.sh /tmp/pnet3-d.adf; echo "exit $?"; }   # FAIL: not the pinned disk, exit 1
python3 - <<'EOF'
p = 'tools/paulanet-disk/ReadMe'; b = open(p, 'rb').read(); assert b.endswith(b'x'); open(p, 'wb').write(b[:-1])
EOF
tools/paulanet-disk/build.sh /tmp/pnet3-e.adf | tail -1        # ca487c73... again
```

- [ ] **Step 10: Commit**

```bash
git add tools/paulanet-disk/build.sh tools/paulanet-disk/xdf_fixed.py tools/paulanet-disk/make_icon.py \
        tools/paulanet-disk/check.py tools/paulanet-disk/Install tools/paulanet-disk/ReadMe tools/paulanet-disk/paulanet-disk.sha256
git commit -m "tools: the PaulaNET driver disk -- Rob's disk plus Install, ReadMe and icons, deterministic (sha256 ca487c73)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 4: `DF1_MODE_NET` in the store, the live switch and the poll parser

**Files:**
- Modify: `wifi-floppy/firmware/src/drive_store.h:18`, `src/drive_store.c:64-72`, `src/df1_live.c:5`, `src/df1_live.h`
  (comment), `src/device_client.c:1041-1061` (`dc_take_second_drive`), `:1573-1580` (drive tail),
  `src/device_client.h:671-673` (comment). Network mode's DF1 policy (`dc_df1_want`, the preload target) is Task 4b's.
- Test: `test/test_drive_store.c`, `test/test_df1_live.c`, `test/test_device_client.c`.

**Interfaces:**
- Produces:

```c
/* drive_store.h */
typedef enum { DF1_MODE_OFF = 0, DF1_MODE_NEXT = 1, DF1_MODE_NET = 2 } df1_mode_t;
const char *df1_mode_wire(df1_mode_t m);                 /* "off" | "df1" | "net" (the poll and status word) */
const char *df1_mode_name(df1_mode_t m);                 /* "off" | "next disk of the set" | "network (PaulaNET)" (the log) */
bool        df1_mode_from_wire(const char *s, df1_mode_t *out);   /* false: not a mode this build knows */
```

- [ ] **Step 1: Write the failing tests.** In `test/test_drive_store.c`, add above `main` and register with `RUN(...)`:

```c
static void network_mode_round_trips_and_boots(void) {
    drive_store_erase();
    drive_record_t a = { 11, DF1_MODE_NET }, b;
    CHECK(drive_store_save(&a), "saved");
    CHECK(drive_store_load(&b), "loaded");
    CHECK_EQ_INT(drive_boot_mode(true, &b), DF1_MODE_NET);
}

static void the_wire_names_and_the_parser_agree(void) {
    CHECK(strcmp(df1_mode_wire(DF1_MODE_OFF), "off") == 0, "off");
    CHECK(strcmp(df1_mode_wire(DF1_MODE_NEXT), "df1") == 0, "next is df1 on the wire (1.9.0's word)");
    CHECK(strcmp(df1_mode_wire(DF1_MODE_NET), "net") == 0, "net");
    const df1_mode_t all[] = { DF1_MODE_OFF, DF1_MODE_NEXT, DF1_MODE_NET };
    for (unsigned i = 0; i < 3; i++) {
        df1_mode_t m = (df1_mode_t)99;
        CHECK(df1_mode_from_wire(df1_mode_wire(all[i]), &m) && m == all[i], "round trip");
    }
    df1_mode_t m = DF1_MODE_NEXT;
    CHECK(!df1_mode_from_wire("df9", &m), "unknown: refused");
    CHECK(!df1_mode_from_wire("", &m), "empty: refused");
    CHECK(!df1_mode_from_wire("NET", &m), "case matters");
    CHECK_EQ_INT(m, DF1_MODE_NEXT);   // untouched on a refusal
    CHECK(strcmp(df1_mode_name(DF1_MODE_NET), "network (PaulaNET)") == 0, "log name");
}
```

  In `test/test_df1_live.c`:

```c
// Phase 3: Network is DF1 switched on, exactly as Next disk is -- the network path is core0's runtime gate.
static void switching_to_network_answers_dd_like_next(void) {
    const df1_live_t n = df1_live_apply(DF1_MODE_NET, false), x = df1_live_apply(DF1_MODE_NEXT, false);
    CHECK(memcmp(&n, &x, sizeof n) == 0, "the same plan as Next disk");
    const df1_live_t p = df1_live_apply(DF1_MODE_NET, true);
    CHECK(p.enable && p.rescan && !p.parked && p.id == DRIVE_ID_KIND_DD, "from on or parked: back to an empty DD drive");
}
```

  (`df1_live_t` is all `bool` plus an enum: memcmp is sound after the `= {…}` initializer. Add `#include <string.h>`.)

  In `test/test_device_client.c`, **replace** `a_bad_mode_is_handled_as_off_and_still_acked` (both its definition and
  its `RUN`) with the following, and add the other two:

```c
// Phase 3 (plan 2026-10-12 ruling 5): a mode this build does not know is acked and ignored.
static void a_bad_mode_is_acked_and_ignored(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false); c.drive_ack = 3;
    push_ok_json("{\"secondDrive\":{\"seq\":4,\"mode\":\"df9\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(!dc_drive_take(&c, &seq, &mode), "nothing for core0: the running mode stays");
    CHECK_EQ_INT(c.drive_ack, 4);
    CHECK_EQ_INT(c._df1_mode, DF1_MODE_NEXT);
    CHECK(dc_drive_report_owed(&c), "the new ack is reported, so the server stops re-sending");
    // The same unknown seq again: nothing new.
    push_ok_json("{\"secondDrive\":{\"seq\":4,\"mode\":\"df9\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    CHECK(!dc_drive_take(&c, &seq, &mode), "still nothing");
}

static void a_net_mode_is_taken(void) {
    boot(); dc_set_df1(&c, DF1_MODE_OFF, false); c.drive_ack = 0;
    push_ok_json("{\"secondDrive\":{\"seq\":2,\"mode\":\"net\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(dc_drive_take(&c, &seq, &mode), "owed");
    CHECK_EQ_INT(seq, 2); CHECK_EQ_INT(mode, DF1_MODE_NET);
}
```

  Register `a_net_mode_is_taken` beside the other second-drive `RUN`s. Then extend
  `test_status_reports_second_drive_and_its_ack` with:

```c
    boot(); dc_set_df1(&c, DF1_MODE_NET, false); dc_drive_handled(&c, 8);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    CHECK(strstr(fake_last_request(), "\"secondDrive\":\"net\",\"driveVersion\":8") != NULL, "net on the wire");
```

- [ ] **Step 2: Run, expect FAIL.** `wifi-floppy/firmware/test/run.sh; echo "exit $?"`. Expected: COMPILE FAIL for
  `test_drive_store.c` (no `DF1_MODE_NET`, no `df1_mode_wire`) and the others, then `exit 1`.

- [ ] **Step 3: Implement.** `drive_store.h`: replace line 18 and add the three declarations below
  `drive_boot_mode`:

```c
// Phase 3 (spec 2026-10-12 §4): NET -- DF1 holds the PaulaNET driver disk and cylinders 76/77 carry the
// network. Stored as 2; a 1.9.0-1.10.2 board reading it boots Off (drive_boot_mode there knows only 1).
typedef enum { DF1_MODE_OFF = 0, DF1_MODE_NEXT = 1, DF1_MODE_NET = 2 } df1_mode_t;
```

```c
// The mode as the poll and the status report spell it: "off", "df1" (Next disk, 1.9.0's word), "net".
const char *df1_mode_wire(df1_mode_t m);
// The mode as the log says it.
const char *df1_mode_name(df1_mode_t m);
// The wire word back to a mode. False, *out untouched: not a mode this build knows (ruling 5: ignored).
bool df1_mode_from_wire(const char *s, df1_mode_t *out);
```

  `drive_store.c`: replace the last line of `drive_boot_mode` and add the three definitions after it:

```c
    if (r->mode == DF1_MODE_NEXT || r->mode == DF1_MODE_NET) return (df1_mode_t)r->mode;
    return DF1_MODE_OFF;
}

const char *df1_mode_wire(df1_mode_t m) {
    return m == DF1_MODE_NEXT ? "df1" : m == DF1_MODE_NET ? "net" : "off";
}

const char *df1_mode_name(df1_mode_t m) {
    return m == DF1_MODE_NEXT ? "next disk of the set" : m == DF1_MODE_NET ? "network (PaulaNET)" : "off";
}

bool df1_mode_from_wire(const char *s, df1_mode_t *out) {
    static const df1_mode_t all[] = { DF1_MODE_OFF, DF1_MODE_NEXT, DF1_MODE_NET };
    for (unsigned i = 0; i < sizeof all / sizeof all[0]; i++)
        if (strcmp(s, df1_mode_wire(all[i])) == 0) { *out = all[i]; return true; }
    return false;
}
```

  `df1_live.c` line 5: `if (to == DF1_MODE_NEXT) {` becomes `if (to != DF1_MODE_OFF) {   // Next disk or Network: DF1 on`.
  In `df1_live.h`, change the transition comment line `-> NEXT, any state` to `-> NEXT or NET, any state`.

  `device_client.c` `dc_df1_want` stays as it is in this task: it serves DF1 only in Next mode, so Network mode
  leaves DF1 empty until Task 4b gives it `SLOT_NET`.

  `dc_take_second_drive`: replace the line `const uint8_t want = strcmp(mode, "df1") == 0 ? DF1_MODE_NEXT : DF1_MODE_OFF;`
  with:

```c
    df1_mode_t parsed;
    if (!df1_mode_from_wire(mode, &parsed)) {
        // Phase 3 (plan 2026-10-12 ruling 5): a mode this build does not know is acknowledged and otherwise
        // ignored -- core0 keeps the mode it runs and nothing is stored. Acked so the server's wake
        // (seq != driveAck) stops; the card then reads "Waiting for the board", since the reported mode differs.
        if (seq != c->drive_ack)
            wf_logf(WF_WARN, "df1: setting %lu names an unknown mode \"%s\" -- ignored", (unsigned long)seq, mode);
        c->drive_ack = seq;
        c->drive_owed = false;
        return;
    }
    const uint8_t want = (uint8_t)parsed;
```

  Update the function's header comment: "Unknown mode -> off, never on." becomes "Unknown mode: acked and ignored
  (Phase 3)." In `device_client.h` the `dc_drive_take` comment "(the poll's seq and mode; unknown mode -> OFF)" becomes
  "(the poll's seq and mode; an unknown mode is acked and never taken)".

  Drive tail: `c->_df1_mode == DF1_MODE_NEXT ? "df1" : "off"` becomes `df1_mode_wire((df1_mode_t)c->_df1_mode)`. The
  comment "46 at most" stays true ("net" is as long as "df1").

- [ ] **Step 4: Run, expect PASS.** `wifi-floppy/firmware/test/run.sh; echo "exit $?"`. Expected: `exit 0`; the three
  files report `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/drive_store.h wifi-floppy/firmware/src/drive_store.c wifi-floppy/firmware/src/df1_live.c \
        wifi-floppy/firmware/src/df1_live.h wifi-floppy/firmware/src/device_client.c wifi-floppy/firmware/src/device_client.h \
        wifi-floppy/firmware/test/test_drive_store.c wifi-floppy/firmware/test/test_df1_live.c wifi-floppy/firmware/test/test_device_client.c
git commit -m "fw: DF1_MODE_NET -- stored, switched live like Next disk, parsed as \"net\"; an unknown mode is acked and ignored

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 4b: The driver disk's own slot (`SLOT_NET`): DF1 in Network mode, whatever DF0 holds

**Files:**
- Modify:
  - `wifi-floppy/firmware/src/psram_image.h` (`SLOT_COUNT` at 47, `slot_kind_t` at 56, new declarations);
  - `src/psram_image.c` (`pack_word`/`slot_of_word` at 77-86, `slot_ok` at 88, `track_ptr` at 92, the metadata
    arrays at 35-37, `psram_image_init` at 96, `psram_image_read` at ~150, the MFM writers at 160-180,
    `psram_image_store_adf` at 189-198, `psram_publish_df1` at 346);
  - `src/image_loader.c` (the WFAD header case at 40-56);
  - `src/track_cache.c` (tier 1 at 88-104);
  - `src/device_client.c` (`dc_df1_want` 720-727, `dc_preload_step_inner` 2070-2099, the `desired: null` clear at
    ~1123).
- Test: `test/test_psram_image.c`, `test/test_image_loader_wfad.c`, `test/test_track_cache.c`,
  `test/test_device_client.c`.

**Interfaces:**
- Consumes: Task 4's `DF1_MODE_NET`.
- Produces:

```c
/* psram_image.h */
#define SLOT_COUNT 2                  /* DF0's rotation, A and B -- unchanged */
#define SLOT_NET   2                  /* Phase 3: the PaulaNET driver disk, DF1 only (plan 2026-10-12 ruling 6) */
#define SLOT_ALL   3                  /* every slot index, for the per-slot metadata */
#define NET_TRACK_BYTES (ADF_MFM_DD_SECTORS * ADF_MFM_SECTOR_BYTES)   /* 5,632: one DD track of sectors */
typedef enum { SLOT_KIND_MFM = 0, SLOT_KIND_ADF_HD, SLOT_KIND_ADF_DD } slot_kind_t;
/* image_loader.h */
#define WFAD_SECTORS_DD 11u           /* a DD WFAD: accepted only into SLOT_NET */
/* device_client.c (static) */
static int dc_preload_target(const device_client_t *c);   /* SLOT_NET in Network mode, else psram_inactive_slot() */
```

- [ ] **Step 1: Write the failing tests.** `test/test_psram_image.c`, registered in `main`:

```c
// Phase 3 (plan 2026-10-12 ruling 6): Network mode's DF1 slot needs no DF0 disk and no DF0 slot.
static void the_net_slot_is_df1s_whatever_df0_holds(void) {
    psram_publish_slot(SLOT_NONE);
    CHECK(psram_publish_df1(SLOT_NET), "DF0 empty: DF1 may hold the driver disk");
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);
    psram_publish_slot(0);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);   // a DF0 mount leaves it
    psram_publish_slot(1);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);   // and a DF0 swap
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);   // and a DF0 eject
    CHECK(psram_inactive_slot() == 0 || psram_inactive_slot() == 1, "DF0's fetch target is never SLOT_NET");
    psram_publish_slot(SLOT_NET);
    CHECK(psram_active_slot() != SLOT_NET, "DF0 can never publish SLOT_NET");
    psram_publish_df1(SLOT_NONE);
}

static void tokens_name_all_three_slots_apart(void) {
    psram_publish_slot(0);  const int32_t a = psram_active_token();
    psram_publish_slot(1);  const int32_t b = psram_active_token();
    psram_publish_df1(SLOT_NET); const int32_t n = psram_df1_token();
    CHECK_EQ_INT(psram_token_slot(a), 0);
    CHECK_EQ_INT(psram_token_slot(b), 1);
    CHECK_EQ_INT(psram_token_slot(n), SLOT_NET);
    CHECK(a != b && b != n && a != n, "distinct");
    psram_publish_df1(SLOT_NONE);
    CHECK_EQ_INT(psram_token_slot(psram_df1_token()), SLOT_NONE);
}

static void the_net_slot_holds_dd_sectors_only(void) {
    psram_image_reset_slot(SLOT_NET);
    psram_image_set_slot_kind(SLOT_NET, SLOT_KIND_ADF_DD);
    static uint8_t sec[NET_TRACK_BYTES];
    for (unsigned i = 0; i < sizeof sec; i++) sec[i] = (uint8_t)(i * 13u);
    CHECK(psram_image_store_adf(SLOT_NET, 155, sec), "a DD track of sectors is stored");
    CHECK(memcmp(psram_image_track_data(SLOT_NET, 155), sec, sizeof sec) == 0, "read back");
    CHECK_EQ_INT(psram_image_bits(SLOT_NET, 155), NET_TRACK_BYTES * 8u);
    static uint8_t mfm[16] = {0};
    psram_image_write(SLOT_NET, 3, mfm, 128, TRK_PRESENT);
    CHECK(!psram_image_have(SLOT_NET, 3), "MFM never goes into a sector slot");
}
```

  Also **replace** `df1_holds_a_disk_only_while_df0_does`'s last line comment to keep its meaning for A/B:
  `CHECK(!psram_publish_df1(1), "DF0 empty: DF1 may not hold an A/B slot (Next disk's rule)");`.

  Check the name of the MFM writer with `grep -n "^void psram_image_write\b\|^void psram_image_write(" src/psram_image.c`
  (it is the function at line ~160, `(slot, track, src, bit_count, state)`), and use its real parameter order.

  `test/test_image_loader_wfad.c`, registered in `main`:

```c
// Phase 3: the PaulaNET driver disk arrives as a DD WFAD (11 sectors), into SLOT_NET only.
static void a_dd_wfad_loads_into_the_net_slot_only(void) {
    const uint32_t tb = WFAD_SECTORS_DD * 512u, total = 16u + WFAD_TRACKS * tb;
    uint8_t *dd = malloc(total);
    put_u32(dd, WFAD_MAGIC); put_u32(dd + 4, WFAD_VERSION); put_u32(dd + 8, WFAD_TRACKS); put_u32(dd + 12, WFAD_SECTORS_DD);
    for (uint32_t t = 0; t < WFAD_TRACKS; t++)
        for (uint32_t i = 0; i < tb; i++) dd[16 + t * tb + i] = (uint8_t)(t + i);
    CHECK(image_parse_buffer(SLOT_NET, dd, total), "a DD WFAD loads into SLOT_NET");
    CHECK_EQ_INT(psram_image_slot_kind(SLOT_NET), SLOT_KIND_ADF_DD);
    CHECK(memcmp(psram_image_track_data(SLOT_NET, 77 * 2 + 1), dd + 16 + 155u * tb, tb) == 0, "track 155 in place");
    CHECK(!image_parse_buffer(0, dd, total), "a DD WFAD never goes into DF0's slots");
    build();
    CHECK(!image_parse_buffer(SLOT_NET, img, WFAD_TOTAL), "an HD WFAD never goes into SLOT_NET");
    free(dd);
}
```

  `test/test_track_cache.c` (use the file's existing backing set-up; read its `main` first):

```c
// Phase 3: DF1's token on SLOT_NET serves a DD track encoded from its sectors.
static void the_net_slot_is_encoded_on_read(void) {
    static uint8_t sec[NET_TRACK_BYTES];
    memset(sec, 0x5A, sizeof sec);
    psram_image_reset_slot(SLOT_NET);
    psram_image_set_slot_kind(SLOT_NET, SLOT_KIND_ADF_DD);
    for (int t = 0; t < NUM_TRACKS; t++) psram_image_store_adf(SLOT_NET, t, sec);
    psram_publish_df1(SLOT_NET);
    uint32_t bits = 0;
    const uint8_t *m = track_cache_get_token(psram_df1_token(), 10, &bits);
    CHECK(m != NULL, "served");
    CHECK_EQ_INT(bits, ADF_MFM_DD_TRACK_BYTES * 8u);
    static uint8_t want[ADF_MFM_DD_TRACK_BYTES];
    CHECK(adf_mfm_encode_track(sec, ADF_MFM_DD_SECTORS, 10u, want) != 0, "reference encode");
    CHECK(memcmp(m, want, ADF_MFM_DD_TRACK_BYTES) == 0, "the same bytes as adf_mfm's own encode");
    psram_publish_df1(SLOT_NONE);
}
```

  `test/test_device_client.c`, beside the DF1 tests (Review Focus 2):

```c
// Phase 3 (ruling 6): in Network mode the server's next (the driver disk) is preloaded into SLOT_NET with DF0
// empty, DF1 holds it, and DF0's own fetches never touch it.
static void network_mode_holds_the_driver_disk_whatever_df0_does(void) {
    boot();
    dc_set_df1(&c, DF1_MODE_NET, true);
    dc_set_df1_quiesce(&c, quiesce_true, NULL);
    CHECK_EQ_INT(psram_active_slot(), SLOT_NONE);              // DF0 empty: a hard-drive boot
    set_next_sha(&c, SHA_B);                                    // the poll's next: the driver disk
    push_dd_wfad_image_response();                              // the server's DD WFAD
    CHECK(dc_preload_step(&c), "fetched with DF0 empty");
    CHECK_EQ_INT(c.preload.slot, SLOT_NET);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);
    // A DF0 mount and then a different disk: both fetched into A/B, DF1 untouched throughout.
    deliver_poll_desiring(SHA_A, SHA_B);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);
    CHECK(psram_active_slot() == 0 || psram_active_slot() == 1, "DF0 on A/B");
    deliver_poll_desiring(SHA_C, SHA_B);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);
    // An eject of DF0 keeps next (the server sends it with desired:null in Network mode) and DF1.
    push_ok_json("{\"version\":999,\"desired\":null,\"next\":{\"diskId\":\"paulanet\",\"sha256\":\"" SHA_B "\",\"diskNo\":1}}");
    dc_step(&c);
    CHECK(strcmp(c.preload.next_sha256, SHA_B) == 0, "next kept in Network mode");
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NET);
    // Back to Next disk: DF1 leaves SLOT_NET (Next disk's rule needs the idle slot).
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_df1_reconcile(&c);
    CHECK(psram_df1_slot() != SLOT_NET, "Next disk never serves SLOT_NET");
}
```

  The file's digest constants and image helpers:
  - Use the names the file already has for three distinct 64-hex digests (`grep -n '#define SHA_\|static const char \*SHA' test/test_device_client.c`).
  - `deliver_poll_desiring` (line ~2696) also needs a WFMF image response queued for each DF0 fetch. Queue it the
    way `next_disk_ejects_df1_and_refills_it_with_the_following_disk` (~2751) does.
  - Add `push_dd_wfad_image_response()` next to `push_image_response()`: an `HTTP/1.1 200` with
    `Content-Length: 901136` and the 16-byte DD WFAD header (as in the loader test above) followed by 901,120 bytes,
    built in a static buffer the same way `push_image_response` builds its WFMF.

- [ ] **Step 2: Run, expect FAIL.** `wifi-floppy/firmware/test/run.sh; echo "exit $?"`: COMPILE FAIL (`SLOT_NET`,
  `SLOT_KIND_ADF_DD`, `WFAD_SECTORS_DD` undeclared).

- [ ] **Step 3: `psram_image.h`.** Below `#define SLOT_COUNT 2` add `SLOT_NET`, `SLOT_ALL` and `NET_TRACK_BYTES`
  (Interfaces), with this comment:

```c
// Phase 3 (plan 2026-10-12, rulings 6 and 24): a third slot, NOT in DF0's A/B rotation. It holds only the PaulaNET
// driver disk, as DD sector data (encoded on read like an HD slot), and only DF1 publishes it -- so DF1 holds it
// whatever DF0 holds, and no DF0 fetch, swap, preload or eject can touch it. psram_inactive_slot() never returns
// it; psram_publish_slot() refuses it.
```

  Change `slot_kind_t` to `{ SLOT_KIND_MFM = 0, SLOT_KIND_ADF_HD, SLOT_KIND_ADF_DD }`. Change the comment on
  `psram_publish_df1` to "core1; false, nothing changed, if refused. SLOT_NET is always accepted; A/B only while DF0
  holds the other one (Next disk's rule)".

- [ ] **Step 4: `psram_image.c`.**
  - The three metadata arrays become `bits[SLOT_ALL][NUM_TRACKS]`, `state[SLOT_ALL][NUM_TRACKS]`, `kind[SLOT_ALL]`.
  - Storage:

```c
#ifndef WFMF_HOST_TEST
static __uninitialized_psram("netdisk") uint8_t net_image[NUM_TRACKS][NET_TRACK_BYTES];
#else
static uint8_t net_image[NUM_TRACKS][NET_TRACK_BYTES];   // host: always there, beside whatever A/B backing a test sets
#endif
static bool have_net;                                     // SLOT_NET's storage is real PSRAM
```

  - The token word gets two slot bits:

```c
static inline int32_t pack_word(uint32_t gen, int slot) {
    if (slot == SLOT_NONE) return (int32_t)(gen << 3);
    return (int32_t)(gen << 3) | (1 << 2) | (int32_t)(slot & 3);
}
static inline int slot_of_word(int32_t w) {
    return (w & 4) ? (int)(w & 3) : SLOT_NONE;
}
```

    `g_gen` is now 28 bits wide before it reaches the sign bit: at one publish a second that is 8.5 years. Note it in
    the comment above `g_gen`.
  - Slot checks: `slot_ok(slot)` becomes `slot >= 0 && slot < SLOT_ALL && (slot != SLOT_NET || have_net)`. Add
    `static inline bool slot_ab(int slot) { return slot >= 0 && slot < SLOT_COUNT; }`.
  - Use `slot_ab` in `psram_publish_slot`: a `SLOT_NET` argument is refused, nothing published, and logged once in
    a comment.
  - `track_ptr`:

```c
static inline uint8_t *track_ptr(int slot, int track) {
    if (slot == SLOT_NET) return &net_image[track][0];
    return g_base + ((size_t)slot * NUM_TRACKS + (size_t)track) * TRACK_MAX_BYTES;
}
```

  - `psram_image_init`: `memset` the three arrays as before; on device set
    `have_net = psram_check_address(&net_image[NUM_TRACKS - 1][NET_TRACK_BYTES - 1])`, on host `have_net = true`.
  - `psram_image_read`, `psram_image_write`, `psram_image_write_at`, `psram_image_commit`: their
    `kind[slot] == SLOT_KIND_ADF_HD` refusal becomes `kind[slot] != SLOT_KIND_MFM`. Add the same refusal where a
    writer lacks it. MFM never goes into a sector slot.
  - `psram_image_store_adf`:

```c
bool psram_image_store_adf(int slot, int track, const uint8_t *adf) {
    if (!have_psram || !slot_ok(slot) || track < 0 || track >= NUM_TRACKS) return false;
    const uint32_t n = kind[slot] == SLOT_KIND_ADF_HD ? MFM_HD_TRACK_DATA_BYTES
                     : kind[slot] == SLOT_KIND_ADF_DD ? NET_TRACK_BYTES : 0u;
    if (n == 0) return false;
    memcpy(track_ptr(slot, track), adf, n);
    bits[slot][track] = n * 8u;
    wfmf_barrier();     // payload must be visible to core1 before the flag that tells it to read it
    state[slot][track] = TRK_DIRTY;
    return true;
}
```

    Keep the existing state value it used; read it before editing, since this line copies it.
  - `psram_publish_df1`:

```c
bool psram_publish_df1(int slot) {
    const int a = slot_of_word(active_word);
    if (slot == SLOT_NET) {
        if (!slot_ok(SLOT_NET)) return false;            // no storage: never publish it
    } else if (slot != SLOT_NONE && (a == SLOT_NONE || slot == a || !slot_ab(slot))) {
        return false;                                    // Next disk's rule, unchanged
    }
    wfmf_barrier();
    g_gen++;
    df1_word = pack_word(g_gen, slot);
    return true;
}
```

  - `psram_inactive_slot` is unchanged (0 or 1). Check the eject-on-publish logic in `psram_publish_slot` (DF1
    ejected when DF0 takes DF1's slot): it compares slot numbers, so `SLOT_NET` is never ejected by it. Confirm by
    reading it and say so in a comment there.

- [ ] **Step 5: `image_loader`.** In `image_loader.h` add, after `WFAD_SECTORS`:

```c
#define WFAD_SECTORS_DD 11u   // Phase 3: the PaulaNET driver disk, a DD ADF -- accepted only into SLOT_NET
```

  In `image_loader.c`'s WFAD header case, replace the geometry check and the kind/payload lines with:

```c
                const uint32_t sec = le32(l->hdr + 12);
                const bool net = l->slot == SLOT_NET;
                // HD (spec §5.1) into A/B, DD only into SLOT_NET (plan 2026-10-12 ruling 24): the header names
                // exactly one of the two geometries, for the slot it is going into, before a byte is stored.
                if (le32(l->hdr + 4) != WFAD_VERSION || le32(l->hdr + 8) != WFAD_TRACKS ||
                    sec != (net ? WFAD_SECTORS_DD : WFAD_SECTORS)) {
                    l->st = S_ERR; return;
                }
                psram_image_set_slot_kind(l->slot, net ? SLOT_KIND_ADF_DD : SLOT_KIND_ADF_HD);
                l->adf = true;
                l->track_count = (int)WFAD_TRACKS;
                l->track = 0;
                l->bits = sec * 512u * 8u;
                l->payload_bytes = sec * 512u;
```

  Then a WFMF (MFM) container aimed at `SLOT_NET` is refused too: right after the WFMF magic check add
  `if (l->slot == SLOT_NET) { l->st = S_ERR; return; }   // SLOT_NET holds sectors only`.
  - Read the payload state that follows: wherever it uses `WFAD_TRACK_BYTES` as the per-track size, use
    `l->payload_bytes`.
  - Wherever it calls `psram_image_store_adf`, the call is unchanged (it now sizes by kind).
  - On any `S_ERR`, the existing "a rejected image leaves the slot empty and back to MFM" must hold for `SLOT_NET`
    too. Its kind returns to MFM until the next good load, and the loader test above pins it.

- [ ] **Step 6: `track_cache.c` tier 1.** Replace the `if (psram_image_slot_kind(slot) == SLOT_KIND_ADF_HD) { … }`
  block's head and its encode with:

```c
    const slot_kind_t k = psram_image_slot_kind(slot);
    if (k == SLOT_KIND_ADF_HD || k == SLOT_KIND_ADF_DD) {
        // Sector data (an HD disk, or Phase 3's PaulaNET driver disk in SLOT_NET): encode on read.
        const unsigned nsec = k == SLOT_KIND_ADF_HD ? ADF_MFM_HD_SECTORS : ADF_MFM_DD_SECTORS;
        const uint8_t *adf = psram_image_track_data(slot, track);
        if (!adf || adf_mfm_encode_track(adf, nsec, (unsigned)track, dst->data) == 0)
            return 0;
        dst->bit_count = k == SLOT_KIND_ADF_HD ? ADF_MFM_HD_TRACK_BITS : ADF_MFM_DD_TRACK_BYTES * 8u;
```

  Keep the rest of the block unchanged. `dst->data` is `TRACK_BUF_BYTES`, enough for HD and so for DD.

- [ ] **Step 7: `device_client.c`, Network mode's DF1 policy.**

```c
// Phase 3 (plan 2026-10-12, ruling 6): where the server's `next` is preloaded. Network mode: SLOT_NET, the driver
// disk's own slot, which no DF0 fetch, swap or eject touches. Otherwise DF0's idle slot, as before.
static int dc_preload_target(const device_client_t *c) {
    return c->_df1_mode == DF1_MODE_NET ? SLOT_NET : psram_inactive_slot();
}
```

  `dc_df1_want` becomes:

```c
static int dc_df1_want(const device_client_t *c) {
    const dc_preload_t *p = &c->preload;
    if (c->_df1_mode == DF1_MODE_OFF || p->slot == SLOT_NONE || p->loading) return SLOT_NONE;
    if (p->sha256[0] == '\0' || strcmp(p->sha256, p->next_sha256) != 0) return SLOT_NONE;
    if (c->_df1_mode == DF1_MODE_NET)                       // whatever DF0 holds (ruling 6)
        return p->slot == SLOT_NET && psram_image_slot_kind(SLOT_NET) == SLOT_KIND_ADF_DD ? SLOT_NET : SLOT_NONE;
    if (psram_active_slot() == SLOT_NONE || p->slot != psram_inactive_slot()) return SLOT_NONE;   // Next disk's rule
    if (!c->_df1_hd_ok && psram_image_slot_kind(p->slot) == SLOT_KIND_ADF_HD) return SLOT_NONE;
    return p->slot;
}
```

  In `dc_preload_step_inner`:
  - `if (strcmp(p->next_sha256, c->mounted_sha256) == 0) return false;` becomes
    `if (c->_df1_mode != DF1_MODE_NET && strcmp(p->next_sha256, c->mounted_sha256) == 0) return false;`.
  - Every `psram_inactive_slot()` in that function (the "already there" test, the `dc_df1_release` argument and
    `target`) becomes `dc_preload_target(c)`.
  - `dc_df1_release(c, SLOT_NET)` ejects DF1 only when it holds `SLOT_NET`, which is right when the driver disk
    itself is replaced (a new digest).

  In `dc_handle_poll_body`'s `desired: null` branch (~1123), wrap the three `next` clears in
  `if (c->_df1_mode != DF1_MODE_NET) { … }`, with the comment: "Network mode: next is the driver disk, which DF1
  holds whatever DF0 does -- the server sends it with desired: null too (ruling 6)."

  The swap-to-preload check (~1219-1228) compares `c->preload.slot == psram_inactive_slot()`, so a preload in
  `SLOT_NET` is never swapped into DF0. Leave it, and add one comment line saying so.

- [ ] **Step 8: Run, expect PASS.** `wifi-floppy/firmware/test/run.sh; echo "exit $?"` → `exit 0`. Every existing DF1,
  preload, WFAD and track-cache test still passes unchanged; they pin Next disk's rule.

- [ ] **Step 9: Build and measure PSRAM.** Task 5 Step 10's release `cmake` line (warning-free), then:

```bash
arm-none-eabi-size -A build/wifi_floppy.elf | grep -E '^\.(bss|psram_noload) '
arm-none-eabi-nm -S --size-sort build/wifi_floppy.elf | grep -E ' net_image| device_image| g_fw_stage'
```

  Expected:
  - `net_image` is 0xdc000 (901,120);
  - `.psram_noload` ≤ 8,388,608, with about 600 KB left once Task 5's rings are in;
  - `.bss` +~800 B.
  - If the link fails with a PSRAM region overflow: stop and report. Do not shrink anything else to make room.

- [ ] **Step 10: Commit**

```bash
git add wifi-floppy/firmware/src/psram_image.h wifi-floppy/firmware/src/psram_image.c wifi-floppy/firmware/src/image_loader.h \
        wifi-floppy/firmware/src/image_loader.c wifi-floppy/firmware/src/track_cache.c wifi-floppy/firmware/src/device_client.c \
        wifi-floppy/firmware/test/test_psram_image.c wifi-floppy/firmware/test/test_image_loader_wfad.c \
        wifi-floppy/firmware/test/test_track_cache.c wifi-floppy/firmware/test/test_device_client.c
git commit -m "fw: SLOT_NET -- the driver disk's own PSRAM slot (DD sectors, DD WFAD); Network mode's DF1 holds it whatever DF0 holds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 5: The network path in release builds, gated at runtime by the DF1 mode

**Files:**
- Modify: `wifi-floppy/firmware/src/pnet_loop.h`, `src/pnet_loop.c`, `test/test_pnet_loop.c`,
  `wifi-floppy/firmware/CMakeLists.txt:86-126`, `src/main.c` (sites listed in Step 5), `src/pnet_bridge.h`,
  `src/pnet_bridge.c:53-111`, `lwipopts.h:156`, `src/pnet_lwip_hooks.h:3`.
- Delete: `wifi-floppy/firmware/tools/pnet_off_identical.sh`.

**Interfaces:**
- Consumes: Task 4's `DF1_MODE_NET`, `df1_mode_name`.
- Produces:

```c
/* pnet_loop.h */
bool pnet_mode_on(uint8_t mode, bool echo_build);   /* the runtime gate (ruling 2) */
/* pnet_bridge.h */
void pnet_bridge_set_on(bool on);                    /* core0: Network mode now on/off */
/* main.c (WF_PNET_LOOP builds) */
#define PNET_ECHO_BUILD (!WF_PNET_L2)
static volatile bool g_pnet_on;                      /* pnet_mode_on(g_df1_mode, PNET_ECHO_BUILD), core0 writes */
static void pnet_set_mode(df1_mode_t m);             /* core0, at boot and on every live change */
```

- [ ] **Step 1: Write the failing tests** in `test/test_pnet_loop.c` (add `#include "../src/drive_store.h"`), registered with
  `RUN(...)`:

```c
// Phase 3 (plan 2026-10-12 ruling 2): one predicate decides whether the PaulaNET path runs.
static void the_network_path_runs_only_in_network_mode(void) {
    CHECK(!pnet_mode_on(DF1_MODE_OFF, false), "release, off: never");
    CHECK(!pnet_mode_on(DF1_MODE_NEXT, false), "release, next disk: never -- cylinders 76/77 are disk data");
    CHECK(pnet_mode_on(DF1_MODE_NET, false), "release, network: yes");
    CHECK(!pnet_mode_on(DF1_MODE_OFF, true), "echo build, off: never");
    CHECK(pnet_mode_on(DF1_MODE_NEXT, true), "echo build, next disk: yes, as its bench always ran it");
    CHECK(pnet_mode_on(DF1_MODE_NET, true), "echo build, network: yes");
    CHECK(!pnet_mode_on(7u, false) && !pnet_mode_on(7u, true), "an unknown mode: never");
}

// Review Focus 4: when Network mode ends, the loop's pre-arm step sees DF1 not serving and lets a
// standing pre-arm go -- wherever the head is, cylinder 77 side 0 included.
static void leaving_network_mode_cancels_a_standing_prearm(void) {
    pnet_prearm_in_t in = { .df1_serving = false, .sel0 = false, .wgate = false, .unpowered = false,
                            .cyl1 = 77, .side = 0, .idle = false, .prearmed = true, .edges = false };
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_CANCEL);
    in.prearmed = false; in.idle = true;
    CHECK_EQ_INT(pnet_prearm_decide(&in), PNET_PREARM_NONE);   // and never arms again
}
```

- [ ] **Step 2: Run, expect FAIL.** `wifi-floppy/firmware/test/run.sh; echo "exit $?"`: COMPILE FAIL for
  `test_pnet_loop.c` (`pnet_mode_on` undeclared).

- [ ] **Step 3: Implement the predicate.** `pnet_loop.h`: add `#include "drive_store.h"` beside the other includes, and
  after `pnet_df1_wprot`:

```c
/* Phase 3 (plan 2026-10-12, ruling 2): whether DF1's PaulaNET path runs in DF1 mode `mode`. Network in
 * every build; in the loopback echo TEST build (WF_PNET_L2 off) Next disk as well, which is how that bench
 * build has always run. Off, and any mode this build does not know: never. */
bool pnet_mode_on(uint8_t mode, bool echo_build);
```

  `pnet_loop.c`, after `pnet_df1_wprot`:

```c
bool pnet_mode_on(uint8_t mode, bool echo_build) {
    return mode == DF1_MODE_NET || (echo_build && mode == DF1_MODE_NEXT);
}
```

- [ ] **Step 4: Run, expect PASS** (`run.sh`, `exit 0`).

- [ ] **Step 5: CMake.** In `CMakeLists.txt`:
  - Replace the comment block above `option(WF_PNET_LOOP` (lines 86-91) and the option line with:

```cmake
# PaulaNET (plans 2026-10-09 .. 2026-10-12): DF1's cylinders 76/77 carry Rob Smith's PaulaNET protocol. Since
# Phase 3 (1.11.0) release builds include it, and the firmware runs it only while the DF1 setting is Network
# (pnet_mode_on, main.c's g_pnet_on): in Off and Next disk modes every hook returns at once and DF1 is a plain
# disk drive. WF_PNET_L2=OFF with this ON is the loopback echo TEST build (NetLoop's bench mode): only that
# build carries the marker main.c defines, which the publish script refuses without "TEST build" notes. Needs
# DF1, i.e. WF_DRIVE_ID (checked below, beside WF_DF1_DEFAULT): a -DWF_DRIVE_ID=OFF build passes
# -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF as well.
option(WF_PNET_LOOP "PaulaNET transport on DF1 cylinders 76/77 (release builds; runs in Network mode only)" ON)
```

  - Change the `message(STATUS "WF_PNET_LOOP is ON: …")` text to
    `"WF_PNET_LOOP is ON: the PaulaNET transport is built in (runs in DF1 Network mode only)."`.
  - Replace the comment block above `option(WF_PNET_L2` (lines 111-117) and the option with:

```cmake
# PaulaNET Phase 1-2: on that transport, DF1 cylinder 77 carries real Ethernet frames and cylinder 76 the
# driver's status track; the Amiga shares the board's Wi-Fi at layer 2. ON in release builds since 1.11.0
# (Phase 3), gated at runtime like the transport. OFF (with WF_PNET_LOOP ON) builds the loopback echo instead.
option(WF_PNET_L2 "PaulaNET Network mode: Ethernet frames on the transport (OFF: the loopback echo TEST build)" ON)
```

  - Change its `message(STATUS …)` to `"WF_PNET_L2 is ON: DF1 Network mode (layer-2 sharing) is built in."`, and the
    `if (NOT WF_PNET_LOOP)` `FATAL_ERROR` text to
    `"WF_PNET_L2 needs WF_PNET_LOOP: Network mode runs on the PaulaNET transport"`.
  - Change the `WF_PNET_LOOP AND NOT WF_DRIVE_ID` `FATAL_ERROR` text (line ~223) to
    `"WF_PNET_LOOP needs WF_DRIVE_ID (DF1 needs the responder): pass -DWF_PNET_LOOP=OFF -DWF_PNET_L2=OFF with -DWF_DRIVE_ID=OFF"`.

- [ ] **Step 6: The bridge gate.** `pnet_bridge.h`: change line 3's "(WF_PNET_L2 TEST builds)" to "(WF_PNET_L2 builds;
  idle unless DF1 is Network)", and add after `pnet_bridge_start`:

```c
void pnet_bridge_set_on(bool on); // core0: DF1 is in Network mode (main.c pnet_set_mode); off = pass-through
```

  `pnet_bridge.c`: add after `static volatile uint32_t s_tx_no…`:

```c
// Phase 3 (plan 2026-10-12, ruling 3): Network mode on. Written by core0, read here in the network context.
// Off: the hook hands every frame to lwIP untouched and the worker sends nothing.
static volatile bool s_on;
void pnet_bridge_set_on(bool on) { s_on = on; }
```

  First line inside `pnet_input`: `if (!s_on) return s_next(p, nif);   // not Network: lwIP's own input, as before`.

  At the top of `pnet_tx_tick`, before `struct netif *nif = …`:

```c
    if (!s_on) {
        // Not Network: nothing may go out. Frames queued before the mode changed are dropped here (this worker
        // is the TX ring's consumer), so a later Network mode never sends a stale one.
        const uint32_t n = pnet_ring_count(&g_pnet_tx);
        if (n) pnet_ring_drop(&g_pnet_tx, n);
        return;
    }
```

  In `pnet_bridge_start`, the log becomes:
  `wf_logf(WF_INFO, "pnet: L2 sharing ready (runs in DF1 Network mode), MAC %02x:%02x:%02x:%02x:%02x:%02x", …)`.

  `lwipopts.h:156` comment becomes: `// PaulaNET (WF_PNET_L2 builds, every DF1 mode -- plan 2026-10-12 ruling 4): the
  board's own DHCP client-id. See the hook file.` `pnet_lwip_hooks.h:3` "WF_PNET_L2 builds only" becomes "WF_PNET_L2
  builds (every release since 1.11.0, every DF1 mode: plan 2026-10-12 ruling 4)".

- [ ] **Step 7: `main.c`, the declarations.** In the `#if WF_PNET_LOOP` block above `stream_stop` (the one that
  defines `PNET_SIDE_DELAY_US` and `g_pnet_go_alarm`, ~line 520), add first:

```c
// Phase 3 (plan 2026-10-12, ruling 2): the PaulaNET path runs only while this is true -- DF1 in Network mode
// (in the echo TEST build, Next disk too). core0 writes it (pnet_set_mode) at boot and on every live DF1
// change; the STEP and WGATE ISRs and the loop read it. False: DF1 is a plain disk drive.
#define PNET_ECHO_BUILD (!WF_PNET_L2)
static volatile bool g_pnet_on;
```

  In the `#if WF_PNET_L2` block that declares `g_pnet_last_ms` (~line 1636), add:

```c
// Phase 3 (the status report's `net`, plan 2026-10-12 ruling 13). core0 writes, core1 reads:
// when cylinder 76 was last served (clock_ms | 1; 0 = not since Network mode began), and the frames the Amiga
// sent that were taken / the frames it acknowledged (saturated where they are reported).
static volatile uint32_t g_pnet_status_last_ms, g_pnet_frames_from, g_pnet_frames_to;
```

- [ ] **Step 8: `main.c`, the gate sites.** Exact old → new:
  1. STEP ISR (~773): `if (d == 1 && g_df1_mode == DF1_MODE_NEXT) bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot(cur_cyl[1]));`
     → `if (d == 1 && g_pnet_on) bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot(cur_cyl[1]));`. Also update its comment's
     first line to "PaulaNET (Network mode): DF1 is writable on cylinder 77 only, …".
  2. MTR ISR (~855): `if (d == 0 || g_df1_mode == DF1_MODE_NEXT)` → `if (d == 0 || g_df1_mode != DF1_MODE_OFF)`.
  3. The marker (~3021): wrap `const char wf_pnet_loop_marker[] = "wf-pnet-loop-test";` in `#if PNET_ECHO_BUILD …
     #endif`. Change the section's header comment ("DF1's cylinder 77 is not disk data in this build.") to:
     "DF1's cylinder 77 is not disk data while g_pnet_on (Network mode; in the echo TEST build Next disk too). The
     marker exists only in the echo TEST build."
  4. `pnet_take_capture` (L2 branch): replace

     ```c
     const unsigned acked = pnet_link_ack(&g_link, &h);
     if (acked) pnet_ring_drop(&g_pnet_rx, acked);
     pnet_link_take(&g_link, &h, cap.bytes + PNET_HDR_BYTES, &g_pnet_tx);
     ```

     with

     ```c
     const unsigned acked = pnet_link_ack(&g_link, &h);
     if (acked) { pnet_ring_drop(&g_pnet_rx, acked); g_pnet_frames_to += acked; }
     const uint32_t queued0 = g_link.queued;
     pnet_link_take(&g_link, &h, cap.bytes + PNET_HDR_BYTES, &g_pnet_tx);
     g_pnet_frames_from += g_link.queued - queued0;
     ```

  5. `pnet_serve_status`: after `g_pnet_status_serves++;` add `g_pnet_status_last_ms = clock_ms() | 1u;   // the
     driver read cylinder 76 (the report's "driver")`.
  6. After `pnet_log_summary`'s definition (the end of the `#if WF_PNET_LOOP` section, before its `#endif`), add:

```c
// Phase 3 (plan 2026-10-12, rulings 2-3): the runtime gate. core0, at boot and on every live DF1 change,
// before anything below reads g_pnet_on. Leaving the mode forgets the link: a pending start is cancelled, the
// prepared batch dropped, the frames waiting for the Amiga dropped (core0 is the RX ring's consumer; the
// bridge drops the TX side), the counters reset, and the driver counts as not heard from -- so a later
// Network mode starts as at boot. DF1's stream itself is stopped by the caller's unmount (df1_live_apply).
static void pnet_set_mode(df1_mode_t m) {
    const bool was = g_pnet_on;
    g_pnet_on = pnet_mode_on((uint8_t)m, PNET_ECHO_BUILD);
#if WF_PNET_L2
    pnet_bridge_set_on(g_pnet_on);
#endif
    if (!was || g_pnet_on) return;
    pnet_go_cancel();
    g_pnet_echo_live = false;
    g_pnet_prepared = false;
    g_pnet_df1_mounted = false;
#if WF_PNET_L2
    pnet_ring_drop(&g_pnet_rx, pnet_ring_count(&g_pnet_rx));
    pnet_link_init(&g_link);
    g_pnet_status_last_ms = 0;
#else
    pnet_loop_init(&g_pnet);
#endif
    wf_logf(WF_INFO, "pnet: off -- DF1 is %s; the network link is forgotten", df1_mode_name(m));
}
```

  7. Boot (~3653-3678). Replace the `wf_logf(WF_INFO, "df1: %s at boot (%s)", g_df1_mode == DF1_MODE_NEXT ? "next disk
     of the set" : "off", …)` argument with `df1_mode_name(g_df1_mode)`. In the `#if WF_PNET_LOOP` boot block, replace

     ```c
     wf_logf(WF_WARN, "%s: DF1 cylinder 77 is a PaulaNET loopback (bench only)", wf_pnet_loop_marker);
     ```

     with

     ```c
     #if PNET_ECHO_BUILD
         wf_logf(WF_WARN, "%s: DF1 cylinder 77 is a PaulaNET loopback (bench only)", wf_pnet_loop_marker);
     #endif
     ```

     After the `psram_check_address(&g_pnet_echo…)` check (still inside the block), add:

     ```c
         pnet_set_mode(g_df1_mode);    // Phase 3: the gate, before the bus IRQs are enabled
         wf_logf(WF_INFO, "pnet: network path built in; %s", g_pnet_on ? "on (DF1 is Network)" : "off");
     ```

  8. Drive-ID boot lines (~3869-3872): the three `g_df1_mode == DF1_MODE_NEXT` become `g_df1_mode != DF1_MODE_OFF`.
  9. Live apply (~4205): directly after `g_df1_mode = m;` add:

     ```c
     #if WF_PNET_LOOP
                 pnet_set_mode(m);        // Phase 3: the gate, before the lines and the mount below read it
     #endif
     ```

     Then `if (m == DF1_MODE_NEXT) bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot(cur_cyl[1]));` becomes
     `if (g_pnet_on) bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot(cur_cyl[1]));`. The applied log's
     `m == DF1_MODE_NEXT ? "on, an empty DD drive until the next disk is in"` becomes
     `m != DF1_MODE_OFF ? (m == DF1_MODE_NET ? "on (Network), an empty DD drive until the driver disk is in" :
     "on, an empty DD drive until the next disk is in")`.
  10. DF1 mount (~4254, 4260): `… && g_df1_mode == DF1_MODE_NEXT;` → `… && g_df1_mode != DF1_MODE_OFF;` and
      `} else if (g_df1_mode == DF1_MODE_NEXT) {` → `} else if (g_df1_mode != DF1_MODE_OFF) {`.
  11. The serve block (~4295-4346). Replace from `g_pnet_df1_mounted = df1_mounted;` down to the
      `#else / if (df1_mounted) serve_drive(1, …) / #endif` with:

```c
#if WF_PNET_LOOP
        g_pnet_df1_mounted = df1_mounted && g_pnet_on;
        if (g_pnet_on) {
            /* ...the existing body, unchanged, from "#if PNET_SIDE_DELAY_US / if (g_pnet_go_rearm) …" through
             * "pnet_l2_log();\n#endif" (the take, the prepare, the side-0 build, the heap low-water, the L2 log)... */
        }
        if (df1_mounted) {
            if (g_pnet_on) pnet_serve_df1(df1_seen_tok, &loaded1);
            else serve_drive(1, df1_seen_tok, &loaded1);
        }
        // Off or Next: a pre-arm left from Network mode is still let go; nothing new is armed (Review Focus 4).
        if (g_pnet_on || flux_capture_prearmed()) pnet_prearm_step();
        if (g_pnet_on) pnet_log_summary();
#else
        if (df1_mounted) serve_drive(1, df1_seen_tok, &loaded1);
#endif
```

      The moved body keeps its own inner `#if WF_PNET_L2` / `#if PNET_SIDE_DELAY_US` blocks unchanged.
  12. Core1's handoff (~2422-2428): `if (mode == DF1_MODE_NEXT) {` → `if (mode != DF1_MODE_OFF) {`. The log's
      `mode == DF1_MODE_NEXT ? "next disk" : "off, parked"` becomes
      `mode == DF1_MODE_OFF ? "off, parked" : df1_mode_name(mode)`.

  Sites deliberately **not** gated (each is inert without a DF1 raw arm or a Network-mode stamp; the reviewer should
  confirm):
  - the WGATE ISR's PaulaNET branch (`pnet_capture_ours` needs `g_pnet_df1_mounted`, now false outside Network);
  - the SIDE ISR's `g_pnet_side_us` store;
  - `dma_irq`'s echo pulse and status buffer (both need `g_pnet_echo_live` / `g_pnet_status_live`, set only by the
    serve);
  - `flux_capture.c` (raw arms happen only from the gated paths; `held` is released by `flux_capture_done()` after
    every DF0 decode);
  - the capture-timeout clean-up;
  - core1's `pnet_bridge_check()` (installs the pass-through hook);
  - the OTA gate's `pnet_ota_quiet` (true when `g_pnet_last_ms` is 0 or more than 10 s old);
  - the heartbeat's single RSSI sample.

- [ ] **Step 9: Retire the identity script.** `git rm wifi-floppy/firmware/tools/pnet_off_identical.sh`. Then
  `grep -rn pnet_off_identical --include=*.sh --include=*.yml --include=*.ts --include=*.json . | grep -v node_modules`
  must print nothing. Mentions in HANDOFF.md and old plans are history and stay.

- [ ] **Step 10: Build both configurations, warning-free**

```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
F="-G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350"
cmake -B build $F -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=OFF && cmake --build build 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'
cmake -B build-pnet $F -DWF_PNET_LOOP=ON -DWF_PNET_L2=OFF -DWF_DF1_DEFAULT=ON && cmake --build build-pnet 2>&1 | grep -E 'src/[a-z_0-9]+\.c.*warning'
cmake -B build-default $F && grep -E '^WF_PNET_(LOOP|L2):' build-default/CMakeCache.txt
strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test            # 0
strings build/wifi_floppy.bin | grep -c 'pnet: L2 sharing ready'     # 1
strings build/wifi_floppy.bin | grep -c 'pnet: network path built in' # 1
strings build-pnet/wifi_floppy.bin | grep -c wf-pnet-loop-test       # 1
```

  Expected:
  - both builds succeed, and neither `grep` for warnings prints anything;
  - `build-default` (a fresh cache, as CI's) shows `WF_PNET_LOOP:BOOL=ON` and `WF_PNET_L2:BOOL=ON`;
  - the four counts are 0, 1, 1, 1.

  Then `rm -rf build-default`. Add `build-default/` to `.gitignore` only if `git status` shows it; it should not, as
  it is deleted.

- [ ] **Step 11: Host tests, and CI's compiler**

```bash
cd ../.. && wifi-floppy/firmware/test/run.sh; echo "exit $?"
docker run --rm -v "$PWD/wifi-floppy/firmware":/fw -w /fw/test gcc:13 bash -c '
  for t in test_pnet_loop test_drive_store test_df1_live; do
    gcc -std=c11 -D_DEFAULT_SOURCE -O1 -pthread -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 -DWF_DF1_DEFAULT=0 -o /tmp/$t $t.c \
      ../src/pnet_loop.c ../src/pnet_frame.c ../src/pnet_mfm.c ../src/drive_store.c ../src/df1_live.c \
      ../src/psram_image.c ../src/swap_gate.c && /tmp/$t || exit 1
  done; echo GCC-OK'
```

  Expected: `exit 0`, then three `… 0 failed` lines and `GCC-OK`.
  - If the gcc link reports an undefined symbol, add the `../src/*.c` that defines it (find it with
    `grep -l '^<type> <name>(' wifi-floppy/firmware/src/*.c`) and run again.
  - Do not use `--no-…` flags to silence it.

- [ ] **Step 12: Measure memory** against the 1.10.2 baseline (Global Constraints):

```bash
cd wifi-floppy/firmware
arm-none-eabi-size -A build/wifi_floppy.elf | grep -E '^\.(text|data|bss|psram_noload) '
ls -l build/wifi_floppy.bin | awk '{print $5}'
arm-none-eabi-nm -S --size-sort build/wifi_floppy.elf | grep -iE 'pnet|s_rx_mem|s_tx_mem' | tail -12
```

  Record all five numbers and the deltas in the commit message body.
  - Expected: `.bss` about +1.5-2.5 KB over 419,444 (the 992-byte status loop, the link state, counters);
    `.psram_noload` about +176 KB (rings 64+32 slots and the 32 KB echo store); `.text` +20-35 KB.
  - **If `.bss` grows by more than 4,096 B:** stop and report. The heap floor (20,480 B) then needs the bench reading
    before release.

- [ ] **Step 13: Commit**

```bash
cd ../..
git status --short wifi-floppy/     # CMakeLists.txt, lwipopts.h, src/{main.c,pnet_loop.{h,c},pnet_bridge.{h,c},pnet_lwip_hooks.h}, test/test_pnet_loop.c, D tools/pnet_off_identical.sh
git add wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/lwipopts.h wifi-floppy/firmware/src/main.c \
        wifi-floppy/firmware/src/pnet_loop.h wifi-floppy/firmware/src/pnet_loop.c wifi-floppy/firmware/src/pnet_bridge.h \
        wifi-floppy/firmware/src/pnet_bridge.c wifi-floppy/firmware/src/pnet_lwip_hooks.h wifi-floppy/firmware/test/test_pnet_loop.c
git commit -m "fw: PaulaNET in release builds, gated at runtime by DF1 Network mode; loopback echo stays a TEST build

<the Step 12 numbers and deltas>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

  (The `git rm` in Step 9 already staged the deletion.)

---

### Task 6: The status report's `net` tail

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h` (types, fields at ~397, budgets at 158-159, declarations near
  `dc_set_sel1`), `src/device_client.c` (`dc_report_status` ~1556-1620, setters near `dc_set_sel1` ~1948),
  `src/main.c` (core1 loop ~2271 and the owed condition ~2736).
- Test: `test/test_device_client.c`.

**Interfaces:**
- Consumes: Task 5's `g_pnet_status_last_ms`, `g_pnet_frames_from`, `g_pnet_frames_to`, `pnet_bridge_stats`.
- Produces:

```c
/* device_client.h */
typedef struct {
    bool     on;            /* Network mode: the report carries "net" */
    bool     driver_seen;   /* the driver read cylinder 76 since Network mode began */
    uint32_t driver_s;      /* seconds since that read */
    uint32_t amiga_ip;      /* the Amiga's address as the sorter learned it, host order; 0 = not learned */
    uint32_t frames_in;     /* the Amiga's frames taken */
    uint32_t frames_out;    /* frames the Amiga acknowledged */
} dc_net_t;
void dc_set_net(device_client_t *c, const dc_net_t *n);   /* NULL = not Network */
bool dc_net_owed(const device_client_t *c);
/* wire: ,"net":{"driver":N,"amigaIp":"a.b.c.d","framesIn":N,"framesOut":N} -- driver/amigaIp only when known */
```

- [ ] **Step 1: Write the failing tests** (registered beside `test_status_reports_both_sel1_readings_once_known`):

```c
static void test_status_carries_net_only_in_network_mode(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    CHECK(strstr(fake_last_request(), "\"net\"") == NULL, "never set: no key");
    dc_net_t n = { .on = true, .driver_seen = true, .driver_s = 4, .amiga_ip = 0xAC100AE7u,
                   .frames_in = 12, .frames_out = 30 };
    dc_set_net(&c, &n);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    CHECK(strstr(fake_last_request(),
          ",\"net\":{\"driver\":4,\"amigaIp\":\"172.16.10.231\",\"framesIn\":12,\"framesOut\":30}") != NULL, "all four");
    dc_set_net(&c, NULL);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    CHECK(strstr(fake_last_request(), "\"net\"") == NULL, "left Network mode: no key");
}

static void test_net_leaves_out_what_is_not_known_and_saturates(void) {
    boot();
    dc_net_t n = { .on = true, .frames_in = 4000000000u, .frames_out = 0 };
    dc_set_net(&c, &n);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    CHECK(strstr(fake_last_request(), ",\"net\":{\"framesIn\":999999999,\"framesOut\":0}") != NULL,
          "no driver, no address: absent keys; frames saturate at 999,999,999");
    n.driver_seen = true; n.driver_s = 5000000u;
    dc_set_net(&c, &n);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    CHECK(strstr(fake_last_request(), "\"driver\":999999,") != NULL, "driver saturates at 999,999 s");
}

static void test_a_net_change_owes_a_report(void) {
    boot();
    CHECK(!dc_net_owed(&c), "never in Network mode: nothing owed");
    dc_net_t n = { .on = true };
    dc_set_net(&c, &n);
    CHECK(dc_net_owed(&c), "Network mode began");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.11.0"), "sent");
    CHECK(!dc_net_owed(&c), "accepted: nothing owed");
    n.frames_in = 9; n.driver_s = 3;            // counters and ages alone owe nothing (the heartbeat carries them)
    dc_set_net(&c, &n);
    CHECK(!dc_net_owed(&c), "counters: not owed");
    n.driver_seen = true;
    dc_set_net(&c, &n);
    CHECK(dc_net_owed(&c), "the driver was first heard");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    n.amiga_ip = 0x0A000002u;
    dc_set_net(&c, &n);
    CHECK(dc_net_owed(&c), "the Amiga's address changed");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.11.0");
    dc_set_net(&c, NULL);
    CHECK(dc_net_owed(&c), "Network mode ended");
}
```

  In `test_status_body_fits_at_maximum`, before `fake_push_response`, add:

```c
    // Phase 3: the longest `net` tail -- every key, each number at its saturation, the longest address.
    dc_net_t worst_net = { .on = true, .driver_seen = true, .driver_s = 999999u, .amiga_ip = 0xFFFFFFFFu,
                           .frames_in = 999999999u, .frames_out = 999999999u };
    dc_set_net(&c, &worst_net);
```

  After its existing `CHECK`s, add:

```c
    CHECK(strstr(r, "\"framesOut\":999999999}") != NULL, "the net tail survives a maximal body");
```

- [ ] **Step 2: Run, expect FAIL** (`run.sh`: COMPILE FAIL, no `dc_net_t`).

- [ ] **Step 3: Implement.** In `device_client.h`:
  - Change `#define DC_STATUS_BODY_BYTES  1408` to `1536` and `DC_STATUS_REQ_BYTES   1920` to `2048`.
  - Append to the budget note above them: "Phase 3 (2026-10-12) adds the `net` tail,
    `,"net":{"driver":999999,"amigaIp":"255.255.255.255","framesIn":999999999,"framesOut":999999999}`: 95 bytes. The
    worst body then is 1376 + 95 = 1471, so the body goes to 1536 (65 spare) and the request to 2048."
  - Add the `dc_net_t` typedef above `device_client_t`.
  - In the DF1 field group (~397), add:

```c
    // Phase 3: the `net` tail (dc_set_net) and what the server last accepted of it (dc_net_owed).
    dc_net_t _net;
    bool     _net_sent_valid, _net_sent_on, _net_sent_seen;
    uint32_t _net_sent_ip;
```

  - Below `dc_sel1_owed`'s declaration, add:

```c
// Phase 3 (plan 2026-10-12 ruling 13): Network mode's readings for the status report; NULL = not Network (no
// key). dc_net_owed: Network mode began or ended, the driver was first heard, or the Amiga's address changed
// since the last report the server accepted -- counters and ages ride the 60 s heartbeat.
void dc_set_net(device_client_t *c, const dc_net_t *n);
bool dc_net_owed(const device_client_t *c);
```

  In `device_client.c`, after `dc_sel1_owed`:

```c
void dc_set_net(device_client_t *c, const dc_net_t *n) {
    if (n) c->_net = *n;
    else memset(&c->_net, 0, sizeof c->_net);
}

bool dc_net_owed(const device_client_t *c) {
    if (!c->_net_sent_valid) return c->_net.on;
    return c->_net_sent_on != c->_net.on ||
           (c->_net.on && (c->_net_sent_seen != c->_net.driver_seen || c->_net_sent_ip != c->_net.amiga_ip));
}
```

  In `dc_report_status`, after the drive tail:

```c
    // Phase 3 (plan 2026-10-12 ruling 13): Network mode's readings, only in Network mode. "driver" and "amigaIp"
    // only when known -- an absent key is "not yet", never a zero. 95 bytes at most (header note).
    static char net_tail[128];
    const dc_net_t net_sent = c->_net;
    if (c->_net.on) {
        char drv[32] = "", ip[40] = "";
        if (c->_net.driver_seen)
            snprintf(drv, sizeof drv, "\"driver\":%lu,",
                     (unsigned long)(c->_net.driver_s > 999999u ? 999999u : c->_net.driver_s));
        if (c->_net.amiga_ip) {
            const uint32_t a = c->_net.amiga_ip;
            snprintf(ip, sizeof ip, "\"amigaIp\":\"%u.%u.%u.%u\",", (unsigned)(a >> 24), (unsigned)(a >> 16 & 255u),
                     (unsigned)(a >> 8 & 255u), (unsigned)(a & 255u));
        }
        snprintf(net_tail, sizeof net_tail, ",\"net\":{%s%s\"framesIn\":%lu,\"framesOut\":%lu}", drv, ip,
                 (unsigned long)(c->_net.frames_in > 999999999u ? 999999999u : c->_net.frames_in),
                 (unsigned long)(c->_net.frames_out > 999999999u ? 999999999u : c->_net.frames_out));
    } else net_tail[0] = '\0';
```

  The body format string gains one `%s` (now `"\"trackMaxBytes\":%u%s%s%s%s%s%s%s%s%s}"`) and `net_tail` follows
  `drive_tail` in the arguments. After the `_drive_sent_*` block at the end, add:

```c
    if (accepted) {
        c->_net_sent_valid = true;
        c->_net_sent_on = net_sent.on;
        c->_net_sent_seen = net_sent.driver_seen;
        c->_net_sent_ip = net_sent.amiga_ip;
    }
```

  In `main.c`'s core1 loop, after `dc_set_sel1(&c, g_sel1_wired, bus_df1_seen(g_df1_steps));`:

```c
#if WF_PNET_L2
            // Phase 3: Network mode's readings ride the status report (plan 2026-10-12 ruling 13).
            if (g_df1_mode == DF1_MODE_NET) {
                static dc_net_t net;
                static pnet_bridge_stats_t st;      // static: core1's stack is measured tight
                const uint32_t seen = g_pnet_status_last_ms;
                pnet_bridge_stats(&st);
                net.on = true;
                net.driver_seen = seen != 0;
                net.driver_s = seen ? (clock_ms() - seen) / 1000u : 0;
                net.amiga_ip = st.amiga_ip;
                net.frames_in = g_pnet_frames_from;
                net.frames_out = g_pnet_frames_to;
                dc_set_net(&c, &net);
            } else {
                dc_set_net(&c, NULL);
            }
#endif
```

  In the status-owed condition (~2736), add `dc_net_owed(&c) ||` after `dc_drive_report_owed(&c) ||`.

- [ ] **Step 4: Run, expect PASS** (`run.sh`, `exit 0`). Note the printed maximal body and request sizes. Expected:
  body ≤ 1,471 and the request ≤ ~1,620 with the test's token.

- [ ] **Step 5: Build the release configuration warning-free** (Task 5 Step 10's first `cmake` line, and its warnings
  grep prints nothing), and re-measure `.bss` as in Task 5 Step 12 (expect +256 B for the two larger buffers).

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c wifi-floppy/firmware/src/main.c \
        wifi-floppy/firmware/test/test_device_client.c
git commit -m "fw: the status report's net tail in Network mode (driver age, Amiga address, frames); status buffers 1536/2048

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 7: Server data: `'net'`, four columns, the status route

**Files:**
- Create: `drizzle/0034_paulanet_net.sql` (+ `drizzle/meta/0034_snapshot.json`, `drizzle/meta/_journal.json` via
  generate).
- Modify: `src/db/schema/devices.ts:163-174`, `src/lib/second-drive.ts`, `src/lib/mount.ts` (`PollTick` mapping ~173,
  `recordStatus` types ~297 and patch ~365-370), `src/app/api/device/status/route.ts:67-74,149-151`,
  `src/lib/queries.ts` (`DeviceListItem` ~378-385, select ~448-454, map ~474-478).
- Test: `src/lib/second-drive.test.ts`, `src/lib/mount-record-status.test.ts`, `src/app/api/device/status/route.test.ts`.

**Interfaces:**
- Produces:

```ts
// src/lib/second-drive.ts
export type SecondDriveMode = 'off' | 'df1' | 'net';
export const SECOND_DRIVE_NET_FW = '1.11.0';
export function asSecondDriveMode(v: string | null): SecondDriveMode | null;   // null for anything else
// src/lib/mount.ts recordStatus input gains:
net?: { driver?: number; amigaIp?: string; framesIn?: number; framesOut?: number };
// devices columns: netDriverSeenAt (timestamp tz), netAmigaIp (text), netFramesIn, netFramesOut (integer)
// DeviceListItem gains: netDriverSeenAt: Date | null; netAmigaIp: string | null; netFramesIn: number | null;
//   netFramesOut: number | null; secondDriveNetCapable: boolean
```

- [ ] **Step 1: Write the failing tests.** `src/lib/second-drive.test.ts`, add:

```ts
import { asSecondDriveMode, SECOND_DRIVE_NET_FW } from './second-drive';

describe('the third mode', () => {
  it('reads every stored spelling and nothing else', () => {
    expect(asSecondDriveMode('off')).toBe('off');
    expect(asSecondDriveMode('df1')).toBe('df1');
    expect(asSecondDriveMode('net')).toBe('net');
    expect(asSecondDriveMode('NET')).toBeNull();
    expect(asSecondDriveMode(null)).toBeNull();
  });
  it('names its firmware', () => expect(SECOND_DRIVE_NET_FW).toBe('1.11.0'));
  it('says Set on the board for net as for df1', () => {
    expect(secondDriveStatus({
      secondDriveCapable: true, secondDriveVersion: 3, secondDriveAppliedVersion: 3,
      secondDrive: 'net', secondDriveReported: 'net', df1Sha256: null,
    })).toBe('Set on the board — takes effect when the Amiga restarts');
  });
});
```

  `src/lib/mount-record-status.test.ts`, add:

```ts
describe('recordStatus net (Phase 3)', () => {
  it('stores the net report: seen-at from the driver age, the address, both counters', async () => {
    const before = Date.now();
    await recordStatus('dev-1', { ...base, firmwareVersion: '1.11.0+gabc', secondDrive: 'net',
      net: { driver: 4, amigaIp: '172.16.10.231', framesIn: 12, framesOut: 30 } });
    const p = patches[0];
    expect(p.secondDriveReported).toBe('net');
    expect(p.secondDriveCapable).toBe(true);
    const seen = (p.netDriverSeenAt as Date).getTime();
    expect(seen).toBeGreaterThanOrEqual(before - 4000 - 50);
    expect(seen).toBeLessThanOrEqual(Date.now() - 4000 + 50);
    expect(p.netAmigaIp).toBe('172.16.10.231');
    expect(p.netFramesIn).toBe(12);
    expect(p.netFramesOut).toBe(30);
  });
  it('a net report without driver or address clears those two', async () => {
    await recordStatus('dev-1', { ...base, firmwareVersion: '1.11.0+gabc', secondDrive: 'net', net: { framesIn: 0, framesOut: 0 } });
    expect(patches[0].netDriverSeenAt).toBeNull();
    expect(patches[0].netAmigaIp).toBeNull();
  });
  it('a report naming its firmware without net clears all four (left Network mode)', async () => {
    await recordStatus('dev-1', { ...base, firmwareVersion: '1.11.0+gabc', secondDrive: 'off' });
    expect(patches[0].netDriverSeenAt).toBeNull();
    expect(patches[0].netAmigaIp).toBeNull();
    expect(patches[0].netFramesIn).toBeNull();
    expect(patches[0].netFramesOut).toBeNull();
  });
  it('a partial report (no firmwareVersion, no net) leaves them alone', async () => {
    await recordStatus('dev-1', { mountedSha256: null });
    expect(patches[0]).not.toHaveProperty('netAmigaIp');
  });
});
```

  `src/app/api/device/status/route.test.ts`, add:

```ts
describe('POST /api/device/status -- Network mode (Phase 3)', () => {
  it('passes secondDrive net and the net tail through', async () => {
    const { POST } = await import('./route');
    const net = { driver: 4, amigaIp: '172.16.10.231', framesIn: 12, framesOut: 30 };
    const res = await POST(post({ mountedSha256: null, secondDrive: 'net', driveVersion: 2, net }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ secondDrive: 'net', net }));
  });
  it('drops a malformed net field by field, never the report', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ mountedSha256: null, secondDrive: 'net',
      net: { driver: -1, amigaIp: '999.1.1.1x', framesIn: 1.5, framesOut: 7 } }));
    expect(res.status).toBe(204);
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({
      net: { driver: undefined, amigaIp: undefined, framesIn: undefined, framesOut: 7 } }));
    await POST(post({ mountedSha256: null, net: 'garbage' }));
    expect(recordStatus).toHaveBeenLastCalledWith('dev-1', expect.objectContaining({ net: undefined }));
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
  `pnpm vitest run src/lib/second-drive.test.ts src/lib/mount-record-status.test.ts src/app/api/device/status/route.test.ts`.
  Expected: failures (no export `asSecondDriveMode`; `net` not passed; columns absent).

- [ ] **Step 3: Schema.** In `src/db/schema/devices.ts`, change the `secondDrive` doc comment to
  `'off' | 'df1' | 'net'`, the same for `secondDriveReported`, and after `df1Sha256` add:

```ts
  // --- PaulaNET Network mode (spec 2026-10-12 §5): the board's `net` report, Network mode only ---
  /** When the driver last read cylinder 76 (report time minus its age); null = not heard, or not Network. */
  netDriverSeenAt: timestamp('net_driver_seen_at', { withTimezone: true }),
  /** The Amiga's address as the board's sorter learned it; null = none yet, or not Network. */
  netAmigaIp: text('net_amiga_ip'),
  /** Frames from the Amiga taken / frames the Amiga acknowledged, since Network mode began (saturated). */
  netFramesIn: integer('net_frames_in'),
  netFramesOut: integer('net_frames_out'),
```

- [ ] **Step 4: The migration.**

```bash
pnpm db:generate --name paulanet_net
ls drizzle | tail -3          # 0034_paulanet_net.sql
```

  Trim `drizzle/0034_paulanet_net.sql` to exactly:

```sql
-- drizzle/0034_paulanet_net.sql  (spec 2026-10-12 paulanet-phase3 §5; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_driver_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_amiga_ip" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_frames_in" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_frames_out" integer;
```

  - If `db:generate` emitted anything beyond these four columns (drift elsewhere), remove it from the SQL. Do not
    apply it, and report it to the operator.
  - If the number is not 0034 (another branch merged a migration since), use the number it gave, everywhere this
    plan says 0034.

- [ ] **Step 5: `second-drive.ts`.** Replace `export type SecondDriveMode = 'off' | 'df1';` with:

```ts
export type SecondDriveMode = 'off' | 'df1' | 'net';
/** Network (PaulaNET), spec 2026-10-12 §5: the firmware that has it. */
export const SECOND_DRIVE_NET_FW = '1.11.0';

/** A stored or reported mode, or null for anything this server does not know. */
export function asSecondDriveMode(v: string | null): SecondDriveMode | null {
  return v === 'off' || v === 'df1' || v === 'net' ? v : null;
}
```

- [ ] **Step 6: `mount.ts`.** `readPollTick`'s return becomes
  `return row ? { ...row, secondDrive: asSecondDriveMode(row.secondDrive) ?? 'off' } : null;` (import
  `asSecondDriveMode`). In `recordStatus`'s parameter type, after `df1Sha256?`:

```ts
    /** Network mode's readings (fw 1.11.0+), Network mode only (spec 2026-10-12 §4). */
    net?: { driver?: number; amigaIp?: string; framesIn?: number; framesOut?: number };
```

  After the `df1Sha256` patch lines:

```ts
  // Build-bound (the playsHd rule): a report naming its firmware without `net` is a board not in Network
  // mode (or older), and the checklist must not keep a Network reading (plan 2026-10-12 ruling 14).
  if (s.net !== undefined) {
    patch.netDriverSeenAt = s.net.driver !== undefined ? new Date(Date.now() - s.net.driver * 1000) : null;
    patch.netAmigaIp = s.net.amigaIp ?? null;
    patch.netFramesIn = s.net.framesIn ?? null;
    patch.netFramesOut = s.net.framesOut ?? null;
  } else if (s.firmwareVersion !== undefined) {
    patch.netDriverSeenAt = null;
    patch.netAmigaIp = null;
    patch.netFramesIn = null;
    patch.netFramesOut = null;
  }
```

- [ ] **Step 7: The status route.** In `statusBody`, change `secondDrive: z.enum(['off', 'df1'])` to
  `z.enum(['off', 'df1', 'net'])`, and after `df1Sha256`:

```ts
  // PaulaNET Network mode (fw 1.11.0, spec 2026-10-12 §4): only in Network mode. Each field dropped on its
  // own when malformed, the object dropped when it is not one -- the telemetry rule above.
  net: z.object({
    driver: z.number().int().min(0).max(999_999).optional().catch(undefined),
    amigaIp: z.string().regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/).optional().catch(undefined),
    framesIn: z.number().int().min(0).max(999_999_999).optional().catch(undefined),
    framesOut: z.number().int().min(0).max(999_999_999).optional().catch(undefined),
  }).optional().catch(undefined),
```

  and pass `net: parsed.data.net,` to `recordStatus` after `df1Sha256`.

- [ ] **Step 8: `queries.ts`.** In `DeviceListItem`, after `df1Sha256`:

```ts
  /** Network mode (spec 2026-10-12 §5): the board can take it (firmware 1.11.0+), and its last net report. */
  secondDriveNetCapable: boolean;
  netDriverSeenAt: Date | null;
  netAmigaIp: string | null;
  netFramesIn: number | null;
  netFramesOut: number | null;
```

  Select `netDriverSeenAt: devices.netDriverSeenAt, netAmigaIp: devices.netAmigaIp, netFramesIn: devices.netFramesIn,
  netFramesOut: devices.netFramesOut,` after `df1Sha256`. In the map, replace the two mode lines with:

```ts
    secondDrive: asSecondDriveMode(r.secondDrive) ?? 'off',
    secondDriveReported: asSecondDriveMode(r.secondDriveReported),
    secondDriveNetCapable: r.secondDriveCapable === true && firmwareAtLeast(r.firmwareVersion, SECOND_DRIVE_NET_FW),
```

  (import `asSecondDriveMode`, `SECOND_DRIVE_NET_FW` from `@/lib/second-drive`; `firmwareAtLeast` is already imported.)

- [ ] **Step 9: Run, expect PASS.** The three test files from Step 2, then `pnpm tsc --noEmit` and
  `pnpm vitest run src/lib src/app/api/device`. All pass.
  - If `device-limits.test.ts` fails, it measures the poll body: `"mode":"net"` is as long as `"mode":"df1"`, so it
    should not. Read its message before changing anything.

- [ ] **Step 10: Apply the migration to the live DB** (additive; before any e2e, and before the merge):

```bash
DB=$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"'); psql "$DB" -v ON_ERROR_STOP=1 -f drizzle/0034_paulanet_net.sql
psql "$DB" -c "select column_name from information_schema.columns where table_name='devices' and column_name like 'net_%' order by 1"
```

  Expected: four `ALTER TABLE`, then the four column names.

- [ ] **Step 11: Commit** (body: "Migration 0034 applied to the live DB before e2e.")

```bash
git add drizzle/0034_paulanet_net.sql drizzle/meta/0034_snapshot.json drizzle/meta/_journal.json src/db/schema/devices.ts \
        src/lib/second-drive.ts src/lib/second-drive.test.ts src/lib/mount.ts src/lib/mount-record-status.test.ts \
        src/app/api/device/status/route.ts src/app/api/device/status/route.test.ts src/lib/queries.ts
git commit -m "feat(devices): second_drive 'net' and the net report columns (migration 0034); the status route takes both

Migration 0034 applied to the live DB before e2e.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 8: The server knows the driver disk: constant, Blob, poll, image route, GC, download

**Files:**
- Create: `src/lib/paulanet-disk.ts`, `src/lib/paulanet-disk.test.ts`, `scripts/paulanet-disk-upload.ts`,
  `src/app/api/paulanet-disk/route.ts`.
- Modify: `src/app/api/device/poll/route.ts:164`, `src/app/api/device/poll/route.test.ts`,
  `src/app/api/device/image/[sha256]/route.ts:42-52,91-98`, `src/lib/blob-gc-run.ts:52-54`, `src/lib/adfmfm/wfad.ts`
  (+ `wfad.test.ts`), `src/lib/adfmfm/index.ts:17`.

**Interfaces:**
- Consumes: Task 3's `tools/paulanet-disk/paulanet-disk.sha256`. `PollTick.secondDrive` now includes `'net'` (Task 7).
- Produces:

```ts
// src/lib/paulanet-disk.ts
export const PAULANET_DISK_SHA256: string;     // 'ca487c73a218e441ee429fe35cd636926a5c720afe5c5f8297a916e061beefc7'
export const PAULANET_DISK_BYTES = 901_120;
export const PAULANET_NEXT: { diskId: 'paulanet'; sha256: string; diskNo: 1 };
export const ALWAYS_REFERENCED_BLOBS: readonly string[];
export function servedWithoutEntitlement(sha256: string): boolean;
```

- [ ] **Step 1: Write the failing tests.** `src/lib/paulanet-disk.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PAULANET_DISK_SHA256, PAULANET_NEXT, ALWAYS_REFERENCED_BLOBS, servedWithoutEntitlement } from './paulanet-disk';

describe('the PaulaNET driver disk', () => {
  it('is the disk tools/paulanet-disk builds (one pinned digest, two places)', () => {
    expect(PAULANET_DISK_SHA256).toBe(readFileSync('tools/paulanet-disk/paulanet-disk.sha256', 'utf8').trim());
    expect(PAULANET_DISK_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rides the poll as next, with a fixed id and disk number', () => {
    expect(PAULANET_NEXT).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
  });
  it('is the only digest a board may fetch without owning it', () => {
    expect(servedWithoutEntitlement(PAULANET_DISK_SHA256)).toBe(true);
    expect(servedWithoutEntitlement('0'.repeat(64))).toBe(false);
  });
  it('is kept by the blob GC', () => expect(ALWAYS_REFERENCED_BLOBS).toContain(PAULANET_DISK_SHA256));
});
```

  In `src/app/api/device/poll/route.test.ts`, inside `describe('GET /api/device/poll -- next (multi-disk plan R1)'`,
  add (and `import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';` at the top):

```ts
  it('Network mode: next is the PaulaNET driver disk, not the next disk of the set', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, secondDrive: 'net' }));
    readDesired.mockResolvedValue({ version: 1, desired: desiredDisk });
    readNextForPoll.mockResolvedValue({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
    const { GET } = await import('./route');
    const body = await (await GET(get('?since=1'))).json();
    expect(body.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
    expect(readNextForPoll).not.toHaveBeenCalled();
  });

  it('Network mode with nothing desired: next is still the driver disk (ruling 6, Review Focus 2)', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, secondDrive: 'net' }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    const body = await (await GET(get('?since=1'))).json();
    expect(body.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
    expect(readNextForPoll).not.toHaveBeenCalled();
  });

  it('Next disk mode with nothing desired: still no next (unchanged)', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, secondDrive: 'df1' }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    expect(await (await GET(get('?since=1'))).json()).not.toHaveProperty('next');
  });
```

- [ ] **Step 2: Run, expect FAIL.**
  `pnpm vitest run src/lib/paulanet-disk.test.ts src/app/api/device/poll/route.test.ts`: module not found, and next
  is `d2`.

- [ ] **Step 3: `src/lib/paulanet-disk.ts`**

```ts
/**
 * The PaulaNET driver disk (spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md §2):
 * Rob Smith's disk plus our Install and ReadMe, built by tools/paulanet-disk/build.sh. A fixed image the server
 * knows by digest -- not a library disk, owned by no organization. Uploaded once to the disk store
 * (scripts/paulanet-disk-upload.ts). Its PaulaNET.device and PaulaNET Config are Rob's, used by permission
 * under his terms (third-party/paulanet/); they are not MIT.
 */
export const PAULANET_DISK_SHA256 = 'ca487c73a218e441ee429fe35cd636926a5c720afe5c5f8297a916e061beefc7';
export const PAULANET_DISK_BYTES = 901_120;

/** What the poll carries as DF1's `next` in Network mode (plan 2026-10-12 ruling 12). */
export const PAULANET_NEXT = { diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 } as const;

/** Digests the blob GC keeps although no row names them (blob-gc-run.ts). */
export const ALWAYS_REFERENCED_BLOBS: readonly string[] = [PAULANET_DISK_SHA256];

/** The one image a board may fetch without its organization owning it (/api/device/image, ruling 11). */
export function servedWithoutEntitlement(sha256: string): boolean {
  return sha256 === PAULANET_DISK_SHA256;
}
```

- [ ] **Step 4: The poll.** In `src/app/api/device/poll/route.ts`, import
  `import { PAULANET_NEXT } from '@/lib/paulanet-disk';` and replace line 164's
  `const next = state.desired ? await readNextForPoll(device.deviceId, device.orgId) : undefined;` with:

```ts
      // Network mode (spec 2026-10-12 §2): DF1 holds the PaulaNET driver disk instead of the next disk of the
      // set -- on every body, with or without a disk desired: the board keeps it in a slot of its own, whatever
      // DF0 holds (plan 2026-10-12 ruling 6). Next disk mode: only with a disk desired, as before.
      const next = tick.secondDrive === 'net' ? { ...PAULANET_NEXT }
        : state.desired ? await readNextForPoll(device.deviceId, device.orgId)
        : undefined;
```

  Update the comment on `next` in the response object ("Absent … desired: null") to add "except in Network mode".
  Also check `device-limits.test.ts`: the worst-case body already counts a `next` alongside `desired`. A
  `desired: null` body is shorter, so the budget holds. Run it.

- [ ] **Step 5: The image route.** In `src/app/api/device/image/[sha256]/route.ts`, import `servedWithoutEntitlement`
  and change the entitlement block to:

```ts
  // THE boundary. ... (existing comment kept) ... The one exception is the PaulaNET driver disk (spec 2026-10-12
  // §2): a fixed image every board in Network mode is sent as DF1's disk, owned by no organization.
  if (!servedWithoutEntitlement(sha256)) {
    const owned = await getDb()
      .select({ sha256: entitlements.sha256 })
      .from(entitlements)
      .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, sha256)))
      .limit(1);
    // 404, not 403: a caller learns nothing about whether the blob exists.
    if (owned.length === 0) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
  }
```

  Then, in the body-building `try`, put the driver disk first, as a DD WFAD for the board's `SLOT_NET` (ruling 24).
  Import `writeWfadDd` from `@/lib/adfmfm`.

```ts
    if (servedWithoutEntitlement(sha256)) {
      body = writeWfadDd(stored);          // the PaulaNET driver disk: DD sectors for SLOT_NET (plan 2026-10-12)
    } else if (isHfe) {
```

  (the existing `if (isHfe)` becomes this `else if`). No `disks` row exists for it, so `isHfe`/`isHd` are false and
  only this branch applies.

- [ ] **Step 5b: `writeWfadDd`.** Test first, in `src/lib/adfmfm/wfad.test.ts`:

```ts
import { writeWfadDd } from './wfad';

describe('writeWfadDd (PaulaNET driver disk, plan 2026-10-12 ruling 24)', () => {
  it('the 16-byte header names 11 sectors, then the ADF unchanged', () => {
    const adf = new Uint8Array(ADF_BYTES).map((_, i) => i & 0xff);
    const out = writeWfadDd(adf);
    expect(out.length).toBe(16 + 901120);
    expect([...out.slice(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x0b, 0, 0, 0]);
    expect(out.slice(16)).toEqual(adf);
  });
  it('throws on anything that is not exactly one DD ADF', () => {
    expect(() => writeWfadDd(new Uint8Array(ADF_HD_BYTES))).toThrow(WfadFormatError);
    expect(() => writeWfadDd(new Uint8Array(ADF_BYTES - 1))).toThrow(WfadFormatError);
  });
});
```

  (`ADF_BYTES` and `ADF_HD_BYTES` are what the file's existing tests already import.) Then, in `wfad.ts`, import
  `ADF_BYTES` and `SECTORS` from `./constants` and add:

```ts
/**
 * The same container for a DD ADF (11 sectors per track). Sent only for the PaulaNET driver disk, which the
 * board keeps as sector data in a slot of its own (plan 2026-10-12 ruling 24); the board accepts 11 sectors
 * into that slot alone, and every other DD disk still goes out as WFMF (encodeDisk).
 */
export function writeWfadDd(adf: Uint8Array): Uint8Array {
  if (adf.length !== ADF_BYTES) throw new WfadFormatError(`a DD ADF is ${ADF_BYTES} bytes, got ${adf.length}`);
  const out = new Uint8Array(WFAD_HEADER_BYTES + ADF_BYTES);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, WFAD_MAGIC, true);
  dv.setUint32(4, WFAD_VERSION, true);
  dv.setUint32(8, TRACKS, true);
  dv.setUint32(12, SECTORS, true);
  out.set(adf, WFAD_HEADER_BYTES);
  return out;
}
```

  Export it from `src/lib/adfmfm/index.ts` beside `writeWfad`. Run `pnpm vitest run src/lib/adfmfm/wfad.test.ts`:
  it fails before the function exists and passes after.

- [ ] **Step 6: The GC.** In `src/lib/blob-gc-run.ts`, import `ALWAYS_REFERENCED_BLOBS` from `@/lib/paulanet-disk`, and
  after `for (const d of devRefs) …` add:
  `for (const s of ALWAYS_REFERENCED_BLOBS) referenced.add(s);   // fixed images no row names (PaulaNET disk)`.

- [ ] **Step 7: The download.** `src/app/api/paulanet-disk/route.ts` (read the two Next.js docs named in Global
  Constraints first):

```ts
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { contentDisposition } from '@/lib/download-name';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

export const maxDuration = 60;

/**
 * The PaulaNET driver disk for a person (spec 2026-10-12 §2 "Also downloadable"), for a real floppy or an
 * emulator. Signed-in users only, like every download here. Streamed, never a presigned redirect (the rule in
 * ../disks/[id]/adf/route.ts). Rob's files on it are his, by permission (third-party/paulanet/).
 */
export async function GET() {
  await requireOrg();
  let bytes: Uint8Array;
  try {
    bytes = await diskStore.read(PAULANET_DISK_SHA256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/x-amiga-disk-file',
      'content-length': String(bytes.byteLength),
      'content-disposition': contentDisposition('PaulaNET.adf'),
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}
```

  Check `contentDisposition`'s signature with `grep -n "export function contentDisposition" src/lib/download-name.ts`.
  If it takes something other than one string, adapt the call to it and say so in the commit body.

- [ ] **Step 8: The upload script.** `scripts/paulanet-disk-upload.ts`:

```ts
/**
 * Puts the PaulaNET driver disk into the disk store, once. Usage:
 *   tools/paulanet-disk/build.sh /tmp/PaulaNET.adf
 *   pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts /tmp/PaulaNET.adf
 * Refuses bytes that are not the pinned disk; does nothing when the store already holds them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { diskStore } from '@/lib/storage';
import { PAULANET_DISK_SHA256, PAULANET_DISK_BYTES } from '@/lib/paulanet-disk';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: paulanet-disk-upload.ts <PaulaNET.adf>');
  const bytes = readFileSync(path);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== PAULANET_DISK_SHA256 || bytes.length !== PAULANET_DISK_BYTES) {
    throw new Error(`${path} is ${sha} (${bytes.length} B), not the pinned disk ${PAULANET_DISK_SHA256}`);
  }
  const have = await diskStore.stat(sha);
  if (have) { console.log(`already stored: ${diskStore.storageKey(sha)} (${have.sizeBytes} B)`); return; }
  const { key } = await diskStore.put(sha, new Uint8Array(bytes));
  const check = await diskStore.read(sha);
  const back = createHash('sha256').update(check).digest('hex');
  if (back !== sha) throw new Error(`read back ${back}, not ${sha}`);
  console.log(`stored ${key}, read back and verified`);
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
```

- [ ] **Step 9: Run, expect PASS**, then upload. `pnpm vitest run src/lib/paulanet-disk.test.ts
  src/app/api/device/poll/route.test.ts src/lib/blob-gc.test.ts` and `pnpm tsc --noEmit`. Then:

```bash
tools/paulanet-disk/build.sh /tmp/PaulaNET.adf | tail -1          # ca487c73...
pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts /tmp/PaulaNET.adf
pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts /tmp/PaulaNET.adf   # again: idempotent
```

  Expected: `stored adf/ca487c73…, read back and verified`, then `already stored: adf/ca487c73… (901120 B)`.
  - The store is the production one (`.env.local`); the bytes are content-addressed and the GC now keeps them.
  - If `put` refuses (a store error), stop and report. Never fall back to another storage path.

- [ ] **Step 10: Commit**

```bash
git add src/lib/paulanet-disk.ts src/lib/paulanet-disk.test.ts scripts/paulanet-disk-upload.ts src/app/api/paulanet-disk/route.ts \
        src/app/api/device/poll/route.ts src/app/api/device/poll/route.test.ts 'src/app/api/device/image/[sha256]/route.ts' \
        src/lib/blob-gc-run.ts src/lib/adfmfm/wfad.ts src/lib/adfmfm/wfad.test.ts src/lib/adfmfm/index.ts
git commit -m "feat(paulanet): the driver disk as DF1's next in Network mode (with or without a disk in DF0, as a DD WFAD) -- served without an entitlement, kept by GC, downloadable

Uploaded to the disk store (adf/ca487c73...) and read back.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 9: `PATCH /api/devices/[id]/second-drive` takes `'net'`

**Files:**
- Modify: `src/lib/second-drive.ts` (`saveSecondDrive`), `src/app/api/devices/[id]/second-drive/route.ts`.
- Test: `src/lib/second-drive.test.ts`, `src/app/api/devices/[id]/second-drive/route.test.ts`.

**Interfaces:**
- Consumes: `SECOND_DRIVE_NET_FW`, `firmwareAtLeast` (`@/lib/firmware-version`), `firmwareAtLeastSql`
  (`@/lib/display-store`).
- Produces: `export function secondDriveRefusal(mode: SecondDriveMode, r: { capable: boolean | null; seen: boolean |
  null; firmwareVersion: string | null }): 'firmware_too_old' | 'df1_seen'` and
  `export function firmwareFor(mode: SecondDriveMode): string`.

- [ ] **Step 1: Write the failing tests.** `src/lib/second-drive.test.ts`:

```ts
import { secondDriveRefusal, firmwareFor } from './second-drive';

describe('why a save was refused', () => {
  it('names the firmware first, then a seen DF1', () => {
    expect(secondDriveRefusal('df1', { capable: false, seen: true, firmwareVersion: '1.8.1+g1' })).toBe('firmware_too_old');
    expect(secondDriveRefusal('net', { capable: true, seen: false, firmwareVersion: '1.10.2+g1' })).toBe('firmware_too_old');
    expect(secondDriveRefusal('net', { capable: true, seen: true, firmwareVersion: '1.11.0+g1' })).toBe('df1_seen');
    expect(secondDriveRefusal('df1', { capable: true, seen: true, firmwareVersion: '1.10.2+g1' })).toBe('df1_seen');
  });
  it('names the right version for each mode', () => {
    expect(firmwareFor('df1')).toBe('1.9.0');
    expect(firmwareFor('net')).toBe('1.11.0');
  });
});
```

  `route.test.ts`: widen the mock type to `'not_found' | 'firmware_too_old' | 'df1_seen'` (unchanged) and add:

```ts
  it('takes net, and names 1.11.0 when the board is too old for it', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue('firmware_too_old');
    const res = await PATCH(req({ mode: 'net' }), ctx('dev-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.11.0 or newer' });
    expect(saveSecondDrive).toHaveBeenCalledWith('org-1', 'dev-1', 'net', false);
  });
  it('still names 1.9.0 for df1', async () => {
    const { PATCH } = await import('./route');
    saveSecondDrive.mockResolvedValue('firmware_too_old');
    expect(await (await PATCH(req({ mode: 'df1' }), ctx('dev-1'))).json())
      .toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.9.0 or newer' });
  });
  it('refuses a mode it does not know', async () => {
    const { PATCH } = await import('./route');
    expect((await PATCH(req({ mode: 'wifi' }), ctx('dev-1'))).status).toBe(400);
  });
```

- [ ] **Step 2: Run, expect FAIL** (`pnpm vitest run src/lib/second-drive.test.ts 'src/app/api/devices/[id]/second-drive'`).

- [ ] **Step 3: Implement.** `second-drive.ts`: import `firmwareAtLeast` from `@/lib/firmware-version` and
  `firmwareAtLeastSql` from `@/lib/display-store`. Add:

```ts
/** The firmware a mode needs: 1.9.0 for the DF1 setting itself, 1.11.0 for Network (spec 2026-10-12 §5). */
export function firmwareFor(mode: SecondDriveMode): string {
  return mode === 'net' ? SECOND_DRIVE_NET_FW : SECOND_DRIVE_FW;
}

/** After a refused save: which refusal it was. The firmware first -- a seen DF1 is moot on a board that cannot. */
export function secondDriveRefusal(
  mode: SecondDriveMode, r: { capable: boolean | null; seen: boolean | null; firmwareVersion: string | null },
): 'firmware_too_old' | 'df1_seen' {
  if (r.capable !== true) return 'firmware_too_old';
  if (mode === 'net' && !firmwareAtLeast(r.firmwareVersion, SECOND_DRIVE_NET_FW)) return 'firmware_too_old';
  return 'df1_seen';
}
```

  In `saveSecondDrive`, the update's `.where(and(scope, eq(devices.secondDriveCapable, true), guard))` becomes:

```ts
    .where(and(scope, eq(devices.secondDriveCapable, true),
      // Network needs 1.11.0 by the REPORTED version, in the same WHERE (the saveDisplay rule): a board
      // that reports an older build between a read and this write cannot take a mode it does not know.
      mode === 'net' ? firmwareAtLeastSql(SECOND_DRIVE_NET_FW) : sql`true`, guard))
```

  and the tail after the failed update becomes:

```ts
  const [r] = await db.select({ capable: devices.secondDriveCapable, seen: devices.df1Seen, firmwareVersion: devices.firmwareVersion })
    .from(devices).where(scope).limit(1);
  if (!r) return 'not_found';
  return secondDriveRefusal(mode, r);
```

  The guard comment above `saveSecondDrive` gains: "The df1Seen guard and the override apply to Network exactly as to
  Next disk: both make the board answer as DF1 (spec 2026-10-12 §1)."

  Route: `z.enum(['off', 'df1'])` → `z.enum(['off', 'df1', 'net'])`; import `firmwareFor` (instead of
  `SECOND_DRIVE_FW`); the 409 reason becomes `` `Needs firmware ${firmwareFor(parsed.data.mode)} or newer` ``.

- [ ] **Step 4: Run, expect PASS**, plus `pnpm tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/second-drive.ts src/lib/second-drive.test.ts 'src/app/api/devices/[id]/second-drive/route.ts' \
        'src/app/api/devices/[id]/second-drive/route.test.ts'
git commit -m "feat(devices): the DF1 setting takes 'net' -- 1.11.0 by reported version, the df1-seen guard and override as for df1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 10: The card: the third choice, the checklist, the live fingerprint

**Files:**
- Create: `src/lib/network-checklist.ts`, `src/lib/network-checklist.test.ts`, `src/components/devices/network-checklist.tsx`.
- Modify: `src/components/devices/second-drive-setting.tsx`, `src/components/devices/device-card.tsx:194,206-207`,
  `src/lib/live-state.ts` (row type, select, fingerprint line), `src/lib/live-state.test.ts` (base fixture, one test).

**Interfaces:**
- Consumes: `PAULANET_DISK_SHA256` (Task 8); `DeviceListItem`'s Task 7 fields; `SECOND_DRIVE_NET_FW`.
- Produces:

```ts
// src/lib/network-checklist.ts
export const DRIVER_TALKING_MS = 120_000;
export type Line = { ok: boolean; text: string };
export function driverDiskLine(d: { df1Sha256: string | null }): Line;
export function driverLine(seenAt: Date | null, now: number): Line;
export function amigaAddressLine(ip: string | null): Line;
export function trafficText(framesIn: number | null, framesOut: number | null): string | null;
export function driverBucket(seenAt: Date | null, now: number): 'talking' | 'quiet' | 'never';
```

- [ ] **Step 1: Write the failing tests.** `src/lib/network-checklist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { driverDiskLine, driverLine, amigaAddressLine, trafficText, driverBucket } from './network-checklist';
import { PAULANET_DISK_SHA256 } from './paulanet-disk';

const NOW = 1_800_000_000_000;

describe('the Network checklist names both values of every state', () => {
  it('driver disk: in DF1 or loading, whatever DF0 holds (ruling 6)', () => {
    expect(driverDiskLine({ df1Sha256: PAULANET_DISK_SHA256 })).toEqual({ ok: true, text: 'Driver disk: in DF1' });
    expect(driverDiskLine({ df1Sha256: null })).toEqual({ ok: false, text: 'Driver disk: loading' });
    expect(driverDiskLine({ df1Sha256: 'b'.repeat(64) })).toEqual({ ok: false, text: 'Driver disk: loading' });
  });
  it('driver: talking, never heard, and quiet', () => {
    expect(driverLine(new Date(NOW - 4_000), NOW)).toEqual({ ok: true, text: 'Driver: talking (last seen 4 s ago)' });
    expect(driverLine(null, NOW))
      .toEqual({ ok: false, text: 'Driver: not heard from yet — run Install, then AddNetInterface eth0' });
    expect(driverLine(new Date(NOW - 120_000), NOW).ok).toBe(true);
    expect(driverLine(new Date(NOW - 121_000), NOW))
      .toEqual({ ok: false, text: 'Driver: not heard from for 2 min — run AddNetInterface eth0' });
    expect(driverLine(new Date(NOW + 3_000), NOW).text).toBe('Driver: talking (last seen 0 s ago)');   // clock skew
  });
  it('Amiga address: the address, or none yet', () => {
    expect(amigaAddressLine('172.16.10.231')).toEqual({ ok: true, text: 'Amiga address: 172.16.10.231' });
    expect(amigaAddressLine(null)).toEqual({ ok: false, text: 'Amiga address: none yet' });
  });
  it('traffic only when frames move', () => {
    expect(trafficText(null, null)).toBeNull();
    expect(trafficText(0, 0)).toBeNull();
    expect(trafficText(1234, 56)).toBe('Traffic: 1,234 frames from the Amiga, 56 to it');
  });
  it('the fingerprint bucket', () => {
    expect(driverBucket(null, NOW)).toBe('never');
    expect(driverBucket(new Date(NOW - 5_000), NOW)).toBe('talking');
    expect(driverBucket(new Date(NOW - 600_000), NOW)).toBe('quiet');
  });
});
```

  In `src/lib/live-state.test.ts`, add to `base`:
  `secondDrive: 'off', secondDriveVersion: 0, secondDriveAppliedVersion: null, secondDriveReported: null,
  df1Sha256: null, netDriverSeenAt: null, netAmigaIp: null, netFramesIn: null, netFramesOut: null,` and the test:

```ts
  it('moves with the DF1 setting and the Network readings (plan 2026-10-12 ruling 18)', () => {
    const a = fp([base]);
    expect(fp([{ ...base, secondDriveAppliedVersion: 1 }])).not.toBe(a);
    expect(fp([{ ...base, secondDriveReported: 'net' }])).not.toBe(a);
    expect(fp([{ ...base, netAmigaIp: '172.16.10.231' }])).not.toBe(a);
    expect(fp([{ ...base, netDriverSeenAt: new Date(NOW - 5_000) }])).not.toBe(a);
    // ...but a heartbeat that only moves the seen-at within "talking" does not refresh the page.
    expect(fp([{ ...base, netDriverSeenAt: new Date(NOW - 5_000) }]))
      .toBe(fp([{ ...base, netDriverSeenAt: new Date(NOW - 65_000) }]));
  });
```

- [ ] **Step 2: Run, expect FAIL.**
  `pnpm vitest run src/lib/network-checklist.test.ts src/lib/live-state.test.ts`.

- [ ] **Step 3: `src/lib/network-checklist.ts`**

```ts
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

// The card's Network checklist (spec 2026-10-12 §5): every line names its good and its bad state in words.

/** Two heartbeats (60 s each, device_client.h DC_STATUS_PERIOD_MS): within this the driver is "talking". */
export const DRIVER_TALKING_MS = 120_000;

export type Line = { ok: boolean; text: string };

/** DF1 holds the driver disk in a slot of its own, whatever DF0 holds (plan 2026-10-12 ruling 6). */
export function driverDiskLine(d: { df1Sha256: string | null }): Line {
  return d.df1Sha256 === PAULANET_DISK_SHA256
    ? { ok: true, text: 'Driver disk: in DF1' }
    : { ok: false, text: 'Driver disk: loading' };
}

export function driverLine(seenAt: Date | null, now: number): Line {
  if (!seenAt) return { ok: false, text: 'Driver: not heard from yet — run Install, then AddNetInterface eth0' };
  const age = Math.max(0, now - seenAt.getTime());
  if (age <= DRIVER_TALKING_MS) return { ok: true, text: `Driver: talking (last seen ${Math.round(age / 1000)} s ago)` };
  return { ok: false, text: `Driver: not heard from for ${Math.round(age / 60_000)} min — run AddNetInterface eth0` };
}

export function amigaAddressLine(ip: string | null): Line {
  return ip ? { ok: true, text: `Amiga address: ${ip}` } : { ok: false, text: 'Amiga address: none yet' };
}

/** framesIn = from the Amiga, framesOut = to it (plan 2026-10-12 ruling 13); null while nothing has moved. */
export function trafficText(framesIn: number | null, framesOut: number | null): string | null {
  const a = framesIn ?? 0, b = framesOut ?? 0;
  if (a === 0 && b === 0) return null;
  return `Traffic: ${a.toLocaleString('en-US')} frames from the Amiga, ${b.toLocaleString('en-US')} to it`;
}

/** What the live fingerprint tracks of the driver: its state, not every heartbeat's timestamp. */
export function driverBucket(seenAt: Date | null, now: number): 'talking' | 'quiet' | 'never' {
  if (!seenAt) return 'never';
  return now - seenAt.getTime() <= DRIVER_TALKING_MS ? 'talking' : 'quiet';
}
```

- [ ] **Step 4: `src/components/devices/network-checklist.tsx`**

```tsx
import type { DeviceListItem } from '@/lib/queries';
import { driverDiskLine, driverLine, amigaAddressLine, trafficText, type Line } from '@/lib/network-checklist';

/** Network mode's checklist (spec 2026-10-12 §5), shown while the board runs Network mode. */
export function NetworkChecklist({ device, now }: { device: DeviceListItem; now: number }) {
  const id = device.id;
  const lines: [string, Line][] = [
    ['net-disk', driverDiskLine(device)],
    ['net-driver', driverLine(device.netDriverSeenAt, now)],
    ['net-ip', amigaAddressLine(device.netAmigaIp)],
  ];
  const traffic = trafficText(device.netFramesIn, device.netFramesOut);
  return (
    <span className="flex flex-col text-[11px]" style={{ color: 'var(--muted)' }} data-testid={`net-checklist-${id}`}>
      {lines.map(([key, l]) => (
        <span key={key} data-testid={`${key}-${id}`} data-ok={String(l.ok)}
              style={{ color: l.ok ? 'var(--ink)' : 'var(--amber-text)' }}>
          {l.ok ? '✓ ' : '• '}{l.text}
        </span>
      ))}
      {traffic && <span data-testid={`net-traffic-${id}`}>{traffic}</span>}
    </span>
  );
}
```

  (`--amber-text` is the repo's readable amber, `second-drive-setting.tsx:66`. Never `--accent-amber` for text:
  `device-card.tsx` explains why.)

- [ ] **Step 5: `second-drive-setting.tsx`.**
  - Props become `{ device, next, now }: { device: DeviceListItem; next?: NextInfo | null; now: number }`.
  - Import `SECOND_DRIVE_NET_FW` and `type SecondDriveMode` from `@/lib/second-drive`, and `NetworkChecklist`.
  - Add `const [pending, setPending] = useState<SecondDriveMode>('df1');` (the mode the override confirms, ruling 17).
  - `save` takes `mode: SecondDriveMode`. In the 409 branch: `if (j.error === 'df1_seen') { setPending(mode);
    setRefused(DF1_SEEN_REASON); } else setFailed(j.reason);`.
  - The confirm button's `onClick={() => save('df1', true)}` becomes `onClick={() => save(pending, true)}`.
  - `onChange={(e) => save(e.target.value as SecondDriveMode)}`.
  - The options:

```tsx
          <option value="off">Off</option>
          <option value="df1">Next disk of the set</option>
          <option value="net" disabled={!device.secondDriveNetCapable}>
            {device.secondDriveNetCapable ? 'Network (PaulaNET)' : `Network (PaulaNET) — needs firmware ${SECOND_DRIVE_NET_FW}`}
          </option>
```

  - After the existing `device.secondDriveReported === 'df1'` block, add:

```tsx
      {device.secondDriveReported === 'net' && device.secondDriveCapable && (
        <span className="flex items-center gap-1">
          <NetworkChecklist device={device} now={now} />
          <HelpTip topic="network" />
        </span>
      )}
```

  The refused text "Switching DF1 on would make both drives unreadable." is unchanged. It is true for Network too.

  `HelpTip topic="network"` will not type-check until Task 11 adds the topic. Do Task 11 Step 3's `HELP_TOPICS`
  entry first if running this task alone, or accept the `tsc` error until Task 11 and say so.

- [ ] **Step 6: `device-card.tsx`.**
  - Line 207: `<SecondDriveSetting device={device} next={next} />` → `<SecondDriveSetting device={device} next={next} now={now} />`.
  - Line 194: `{next?.preload && state === 'converged' && (` →
    `{next?.preload && state === 'converged' && device.secondDriveReported !== 'net' && (`, with the comment
    "Not in Network mode: the spare slot holds the driver disk then (plan 2026-10-12 ruling 19)."

- [ ] **Step 7: `live-state.ts`.**
  - `LiveStateRow` gains:

```ts
  /** The DF1 setting and Network readings (plan 2026-10-12 ruling 18): all card inputs. */
  secondDrive: string; secondDriveVersion: number; secondDriveAppliedVersion: number | null;
  secondDriveReported: string | null; df1Sha256: string | null;
  netDriverSeenAt: Date | null; netAmigaIp: string | null; netFramesIn: number | null; netFramesOut: number | null;
```

  - The select adds the nine columns: `secondDrive: devices.secondDrive`, …, `netFramesOut: devices.netFramesOut`.
  - The fingerprint array, before the `isOnline` entries, adds (import `driverBucket`):

```ts
        r.secondDrive, r.secondDriveVersion, r.secondDriveAppliedVersion ?? '', r.secondDriveReported ?? '',
        r.df1Sha256 ?? '', driverBucket(r.netDriverSeenAt, now), r.netAmigaIp ?? '',
        trafficText(r.netFramesIn, r.netFramesOut) ?? '',
```

  The traffic text is in the fingerprint because the card shows it. It changes only while frames move, and then the
  page's live refresh is wanted.

- [ ] **Step 8: Run, expect PASS.** `pnpm vitest run src/lib/network-checklist.test.ts src/lib/live-state.test.ts
  src/lib/second-drive.test.ts`, then `pnpm tsc --noEmit` (clean once Task 11's topic exists) and `pnpm lint`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/network-checklist.ts src/lib/network-checklist.test.ts src/components/devices/network-checklist.tsx \
        src/components/devices/second-drive-setting.tsx src/components/devices/device-card.tsx src/lib/live-state.ts src/lib/live-state.test.ts
git commit -m "feat(devices): Network (PaulaNET) on the card -- the third choice, the three-line checklist, live refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 11: Help: the `network` topic, and `second-drive` names the third option

**Files:** Modify `src/lib/help/topics.tsx` (a new entry after `'second-drive'`, ~line 320; `HELP_ORDER` ~352;
`second-drive`'s body ~295-316), `src/lib/help/topics.test.ts`.

**Interfaces:**
- Consumes: `SECOND_DRIVE_NET_FW`, the route `/api/paulanet-disk` (Task 8), the Install/ReadMe texts (Task 3).
- Produces: `HelpTopicId` gains `'network'`, and `<HelpTip topic="network" />` type-checks.

- [ ] **Step 1: Write the failing tests.** In `topics.test.ts`:
  - `IDS` gains `'network'`.
  - Add:

```ts
describe('network says what a regular user needs (spec 2026-10-12 §5)', () => {
  const all = () => HELP_TOPICS.network.short + ' ' + bodyText('network');
  it('names the setting and the restart', () => {
    expect(all()).toMatch(/Network \(PaulaNET\)/);
    expect(all()).toMatch(/restart/i);
  });
  it('what you need: a TCP/IP stack and no other DF1 -- and DF0 may be empty (ruling 6)', () => {
    expect(all()).toMatch(/AmiTCP_NG/); expect(all()).toMatch(/Roadshow/);
    expect(all()).toMatch(/no other drive/i);
    expect(all()).toMatch(/DF0 can be empty/i);
    expect(all()).not.toMatch(/keep a disk|waiting for a disk/i);
  });
  it('the three steps', () => {
    expect(all()).toMatch(/Install/); expect(all()).toMatch(/AddNetInterface eth0/); expect(all()).toMatch(/User-Startup/);
  });
  it('honest numbers and the mouse', () => {
    expect(all()).toMatch(/45 KB\/s/); expect(all()).toMatch(/half/i); expect(all()).toMatch(/250 ms/);
    expect(all()).toMatch(/mouse/i);
  });
  it('the download and the credit', () => {
    expect(renderToStaticMarkup(HELP_TOPICS.network.body as React.ReactElement)).toContain('href="/api/paulanet-disk"');
    expect(all()).toMatch(/Rob Smith/);
  });
  it('names the firmware it needs', () => expect(all()).toMatch(/1\.11\.0/));
});

describe('second-drive names the third option (spec 2026-10-12 §5)', () => {
  it('Network (PaulaNET), linked to its topic', () => {
    expect(HELP_TOPICS['second-drive'].short + bodyText('second-drive')).toMatch(/Network \(PaulaNET\)/);
    expect(renderToStaticMarkup(HELP_TOPICS['second-drive'].body as React.ReactElement)).toContain('href="/help#network"');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`pnpm vitest run src/lib/help/topics.test.ts`: "has exactly the spec topics" and
  the new describes fail).

- [ ] **Step 3: The topic.** After the `'second-drive'` entry, add (its source comment first):

```tsx
  // Sources: spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md §1-§5, §8; the
  // setting and checklist texts in second-drive-setting.tsx / network-checklist.ts; DF0 empty or changing: plan
  // 2026-10-12 ruling 6 (SLOT_NET, psram_image.h; the poll sends `next` in Network mode with or without a disk),
  // bench Task 14 Steps 5 and 14b;
  // numbers: HANDOFF 3bi (47.5 KB/s alone, 24.4 KB/s during a DF0 copy, router pings 204-545 ms, avg ~250);
  // the steps: tools/paulanet-disk/Install and ReadMe; download: api/paulanet-disk/route.ts; Rob's permission:
  // third-party/paulanet/PERMISSION.md. Mouse: the driver busy-polls at priority 1 (HANDOFF 3bi, not yet measured).
  network: {
    title: 'Amiga networking (PaulaNET)',
    short:
      'Put your Amiga on your network through the board’s Wi-Fi, with the board as drive DF1. It uses Rob Smith’s PaulaNET driver and a TCP/IP stack on the Amiga.',
    body: (
      <>
        <p>
          Choose <em>Network (PaulaNET)</em> under <em>Second drive (DF1)</em> on the board&apos;s card, then restart
          the Amiga. DF1 then holds the PaulaNET driver disk, whatever is in DF0. You need a TCP/IP stack such as
          AmiTCP_NG or Roadshow, and no other drive answering as DF1.
        </p>
        <p>
          <strong>Three steps.</strong> Open DF1 and double-click <em>Install</em>. Then, in a Shell, type{' '}
          <code>AddNetInterface eth0</code>. To go online at every start, add that line to S:User-Startup. The
          card&apos;s checklist shows each part: the driver disk, the driver, and the Amiga&apos;s own address.
        </p>
        <GoodToKnow items={[
          'Expect about 45 KB/s, about half that while DF0 is busy, and pings of about 250 ms.',
          'The mouse may feel slower while the driver runs.',
          'DF0 can be empty, for an Amiga that starts from a hard drive, and changing the disk in DF0 does not interrupt the network.',
          'Needs board firmware 1.11.0 or newer.',
          <>For a real floppy or an emulator, <a className="underline" href="/api/paulanet-disk">download the PaulaNET driver disk</a>.</>,
          'PaulaNET is by Rob Smith (RobSmithDev), used with his permission.',
        ]} />
      </>
    ),
  },
```

  Add `'network'` to `HELP_ORDER` directly after `'second-drive'`.

- [ ] **Step 3b: The address note in `boards`** (ruling 26). It affects every board on 1.11.0, whatever its DF1
  setting, so it goes in `boards`, not `network`.
  - In the `boards` entry's `GoodToKnow` (`topics.tsx:52-55`), add a third item:
    `'After updating to firmware 1.11.0, your router may give the board a new network address once; nothing needs changing.'`
  - Add to the comment above `boards`: "Address note: plan 2026-10-12 ruling 4 -- 1.11.0 sends the board's own DHCP
    client-id."
  - In `topics.test.ts`'s "help topics say what the app really does" describe, add:

```ts
  it('boards says the address may change once after 1.11.0 (plan 2026-10-12 ruling 26)', () => {
    expect(bodyText('boards')).toMatch(/1\.11\.0[^.]*new network address once/);
  });
```

- [ ] **Step 4: `second-drive`'s body.** In `GoodToKnow`, replace the item
  `'DF1 only ever holds the next disk of the set. You cannot pick another disk for it.'` with:

```tsx
          <>The third choice, <em>Network (PaulaNET)</em>, uses DF1 for networking instead: see{' '}
            <a className="underline" href="/help#network">Amiga networking</a>.</>,
```

  The "next disk of the set" regex is still met by the first paragraph. Add the source line to the comment above the
  entry: "Network (PaulaNET): spec 2026-10-12 §1 (one setting, three values)."

- [ ] **Step 5: Run, expect PASS.** `pnpm vitest run src/lib/help/topics.test.ts`.
  - If a word-count test fails, shorten the topic's prose, not the facts the tests name.
  - The planned body is about 175 words for `network`, and the old `second-drive` count minus 2.
  - Then `pnpm tsc --noEmit` (now clean with Task 10's `HelpTip`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/help/topics.tsx src/lib/help/topics.test.ts
git commit -m "docs(help): Amiga networking (PaulaNET) -- the setting, the three steps, honest numbers, the download; second-drive names it; boards: the address may change once after 1.11.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 12: e2e for the touched specs

**Files:** Modify `e2e/second-drive.spec.ts`, `e2e/help.spec.ts:28`, `e2e/device-image.spec.ts`.

**Interfaces:**
- Consumes: Tasks 7-11. The migration is applied (Task 7 Step 10). The disk is in the store (Task 8 Step 9).

- [ ] **Step 1: `e2e/second-drive.spec.ts`.** Add `import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';`, and
  these tests (they use the file's `report` and `row` helpers):

```ts
test('Network needs 1.11.0: the option says so, and the route refuses', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.10.2+gabc1234', secondDrive: 'off', driveVersion: 0 });
  await page.goto('/devices');
  const opt = page.getByTestId(`second-drive-${deviceId}`).locator('option[value="net"]');
  await expect(opt).toBeDisabled();
  await expect(opt).toHaveText('Network (PaulaNET) — needs firmware 1.11.0');
  const res = await page.request.patch(`/api/devices/${deviceId}/second-drive`, { data: { mode: 'net' } });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.11.0 or newer' });
  expect((await row(deviceId)).secondDriveVersion).toBe(0);
});

test('choosing Network reaches the board and reads applied once acked', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('net');
  await expect(page.getByTestId(`second-drive-status-${deviceId}`)).toHaveText('Waiting for the board');
  const poll = await request.get('/api/device/poll?since=0&driveAck=0', { headers: authHeader(token) });
  expect((await poll.json()).secondDrive).toEqual({ seq: 1, mode: 'net' });
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'net', driveVersion: 1,
    net: { framesIn: 0, framesOut: 0 } });
  await page.reload();
  await expect(page.getByTestId(`second-drive-status-${deviceId}`))
    .toHaveText('Set on the board — takes effect when the Amiga restarts');
  // Nothing in DF0 (a hard-drive boot): the poll still names the driver disk (Review Focus 2).
  // driveAck=0 against seq 1 wakes the poll at once (the hold would otherwise run 25 s).
  const poll2 = await request.get('/api/device/poll?since=0&driveAck=0', { headers: authHeader(token) });
  expect(poll2.status()).toBe(200);
  const b2 = await poll2.json();
  expect(b2.desired).toBeNull();
  expect(b2.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
  // Nothing loaded, nothing heard yet: both values named.
  await expect(page.getByTestId(`net-disk-${deviceId}`)).toContainText('Driver disk: loading');
  await expect(page.getByTestId(`net-driver-${deviceId}`))
    .toContainText('Driver: not heard from yet — run Install, then AddNetInterface eth0');
  await expect(page.getByTestId(`net-ip-${deviceId}`)).toContainText('Amiga address: none yet');
  await expect(page.getByTestId(`net-traffic-${deviceId}`)).toHaveCount(0);
});

test('the checklist reads the board\'s net report: all three good, and traffic', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 0 });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('net');
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('net');
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', mountedSha256: 'a'.repeat(64),
    secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_SHA256,
    net: { driver: 4, amigaIp: '172.16.10.231', framesIn: 1234, framesOut: 56 } });
  await page.reload();
  await expect(page.getByTestId(`net-disk-${deviceId}`)).toContainText('Driver disk: in DF1');
  await expect(page.getByTestId(`net-driver-${deviceId}`)).toContainText(/Driver: talking \(last seen \d+ s ago\)/);
  await expect(page.getByTestId(`net-ip-${deviceId}`)).toContainText('Amiga address: 172.16.10.231');
  await expect(page.getByTestId(`net-traffic-${deviceId}`)).toHaveText('Traffic: 1,234 frames from the Amiga, 56 to it');
  for (const k of ['net-disk', 'net-driver', 'net-ip']) await expect(page.getByTestId(`${k}-${deviceId}`)).toHaveAttribute('data-ok', 'true');
  // Back to Off: the checklist goes.
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 1 });
  await page.reload();
  await expect(page.getByTestId(`net-checklist-${deviceId}`)).toHaveCount(0);
});

test('a seen DF1 refuses Network; the override saves Network (Review Focus 5)', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await report(request, token, { firmwareVersion: '1.11.0+gabc1234', secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: true });
  await page.goto('/devices');
  await page.getByTestId(`second-drive-${deviceId}`).selectOption('net');
  await expect(page.getByTestId(`second-drive-refused-${deviceId}`)).toContainText('A drive already answers as DF1 on this Amiga');
  expect((await row(deviceId)).secondDriveVersion).toBe(0);
  await page.getByTestId(`second-drive-override-${deviceId}`).click();
  await page.getByTestId(`second-drive-override-confirm-${deviceId}`).click();
  await expect.poll(async () => (await row(deviceId)).secondDrive).toBe('net');
});
```

  Two caveats:
  - `report` sends `mountedSha256: null` by default and `extra` overrides it. Check that the file's `report` spreads
    `extra` after the defaults (it does: `{ mountedSha256: null, firmwareVersion: '1.9.0', ...extra }`).
  - A non-null `mountedSha256` the server does not know is fine: `recordStatus` stores it as reported.

- [ ] **Step 2: `e2e/help.spec.ts`.** Add `'network'` to the id list at line 28, and the test:

```ts
test('the network topic links a working driver disk download', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/help#network');
  await expect(page.getByTestId('help-section-network')).toContainText('AddNetInterface eth0');
  const res = await page.request.get('/api/paulanet-disk');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/x-amiga-disk-file');
  expect((await res.body()).length).toBe(901120);
});
```

- [ ] **Step 3: `e2e/device-image.spec.ts`.** Add (`import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';`):

```ts
test('a board fetches the PaulaNET driver disk without owning it; any other unowned digest is still 404', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const res = await request.get(`/api/device/image/${PAULANET_DISK_SHA256}`, { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/octet-stream');
  const body = await res.body();
  expect(body.length).toBe(16 + 901120);                                      // a DD WFAD for SLOT_NET (ruling 24)
  expect([...body.subarray(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x0b, 0, 0, 0]);
  const other = await request.get(`/api/device/image/${'0'.repeat(64)}`, { headers: authHeader(token) });
  expect(other.status()).toBe(404);
});
```

- [ ] **Step 4: Run the touched specs** (serialized, PORT=3100, each command under 9 minutes). First
  `lsof -nP -iTCP:3100 -sTCP:LISTEN` prints nothing. Then:

```bash
PORT=3100 pnpm e2e e2e/second-drive.spec.ts
PORT=3100 pnpm e2e e2e/help.spec.ts e2e/device-image.spec.ts
PORT=3100 pnpm e2e e2e/devices-page.spec.ts
```

  Expected: all pass, in both projects (desktop and phone). `devices-page` runs because the card changed.
  - On a failure, prove the environment first: no stray server on 3100, migration 0034 applied, the blob stored
    (`tsx scripts/paulanet-disk-upload.ts` says "already stored"). Only then suspect the code.
  - If a command nears 9 minutes, split it by file.

- [ ] **Step 5: The unit suite and the build**: `pnpm vitest run` (all), `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build`.
  All clean.

- [ ] **Step 6: Commit**

```bash
git add e2e/second-drive.spec.ts e2e/help.spec.ts e2e/device-image.spec.ts
git commit -m "test(e2e): Network (PaulaNET) -- version refusal, ack, checklist both ways, df1-seen override, help download, driver disk fetch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

---

### Task 13: Merge, deploy, and a TEST build of the merge commit on the bench board

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (`set(FIRMWARE_SEMVER "1.10.2")` → `"1.11.0"`).
- Test: `src/lib/firmware-manifest.test.ts`.

**Interfaces:**
- Consumes: everything above, green.
- Produces:
  - master with the branch merged and deployed (merge commit **M**);
  - a registry-only TEST release `1.11.0+g<M>` (no GitHub);
  - the bench board running it, off TEST sequence 77.
- The real 1.11.0 comes only after Task 14 passes (Task 15, ruling 20).

- [ ] **Step 1: Bump the version** (in the worktree):

```bash
sed -i '' 's/set(FIRMWARE_SEMVER "1.10.2")/set(FIRMWARE_SEMVER "1.11.0")/' wifi-floppy/firmware/CMakeLists.txt
grep -n 'FIRMWARE_SEMVER "' wifi-floppy/firmware/CMakeLists.txt     # "1.11.0"
```

- [ ] **Step 2: Pin the TEST-notes rule** (ruling 20).
  - From Task 5 on, an L2 image carries no marker, so a TEST build of it is told apart only by its notes.
  - `refuseReleaseImage` must accept TEST notes on a marker-less image, and `isTestBuild` must keep it off GitHub.
  - In `src/lib/firmware-manifest.test.ts`, beside the PaulaNET loopback test, add:

```ts
  it('accepts TEST notes on an image with no marker (a TEST build of a release configuration, plan 2026-10-12)', () => {
    const plain = Buffer.from('xx an ordinary 1.11.0 image xx');
    expect(refuseReleaseImage(realInfo, 533624, plain, 'TEST build: PaulaNET Phase 3 bench')).toBeNull();
    expect(refuseReleaseImage(realInfo, 533624, plain, 'Network (PaulaNET) ...')).toBeNull();
  });
```

  - In `src/lib/firmware-github-release.test.ts` (find the `isTestBuild` cases with `grep -n isTestBuild
    src/lib/firmware-github-release.test.ts`), make sure one case asserts
    `isTestBuild('TEST build: PaulaNET Phase 3 bench') === true`; add it if missing.
  - Run `pnpm vitest run src/lib/firmware-manifest.test.ts src/lib/firmware-github-release.test.ts`. Expect PASS:
    the code already behaves so (`firmware-manifest.ts:29-38`, `firmware-github-release.ts:37-43`). This step only
    pins it.

```bash
git add wifi-floppy/firmware/CMakeLists.txt src/lib/firmware-manifest.test.ts src/lib/firmware-github-release.test.ts
git commit -m "fw: 1.11.0 -- PaulaNET Network mode in release builds; pin: TEST notes on a marker-less image are accepted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
```

  (Stage only the files that changed.)

- [ ] **Step 3: Final whole-branch check** in the worktree:
  - `wifi-floppy/firmware/test/run.sh; echo "exit $?"` → `exit 0`;
  - both firmware configurations warning-free (Task 5 Step 10);
  - `pnpm vitest run`, `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build`, all clean;
  - Task 12 Step 4's three e2e commands green on this exact commit.

  Under subagent-driven execution this is also where the whole-branch review runs. Every finding goes to the
  operator, and every fix is reviewed again.

- [ ] **Step 4: Merge to master** (from the main tree, `/Users/sfs/Devel/webadf`):

```bash
git status --short     # only the three untracked items; anything else belongs to another session -- stop and ask
git merge --no-ff feat/paulanet-phase3 -m "Merge: PaulaNET Phase 3 -- Network (PaulaNET) as a DF1 setting, the driver disk, release 1.11.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
git push origin master
git rev-parse --short HEAD     # M -- record it
```

  If the merge conflicts, resolve it in the worktree, not here: `git -C .claude/worktrees/pnet3 merge master`, re-run
  Step 3, then come back.

- [ ] **Step 5: The server is live before any board runs 1.11.0** (ruling 20).
  - Wait for the Vercel production deployment of M: `vercel ls` or the Vercel MCP `list_deployments`, state READY,
    for the pushed sha.
  - Then, from the main tree:
    `curl -s -o /dev/null -w '%{http_code}\n' https://<production host>/api/paulanet-disk` prints `307` or `401`.
    The route exists and wants a session; `404` means not deployed yet.
  - Find the production host with `grep -E '^(BETTER_AUTH_URL|NEXT_PUBLIC_APP_URL)=' .env.local`.
  - Do not go on until it is live.

- [ ] **Step 6: Build M in the main tree's `build/`, with every option explicit** (ruling 21):

```bash
git status --short wifi-floppy/      # nothing
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
      -DWF_PNET_LOOP=ON -DWF_PNET_L2=ON -DWF_DF1_DEFAULT=OFF -DWF_FW_DEBUG=OFF && cmake --build build
grep -E '^WF_(PNET_LOOP|PNET_L2|DF1_DEFAULT|FW_DEBUG):' build/CMakeCache.txt
grep WF_FIRMWARE_VERSION build/generated/wifi_floppy_version.h
strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test           # 0
strings build/wifi_floppy.bin | grep -c wf-df1-default-on           # 0
strings build/wifi_floppy.bin | grep -c 'pnet: L2 sharing ready'    # 1
arm-none-eabi-size -A build/wifi_floppy.elf | grep -E '^\.(text|data|bss|psram_noload) '; ls -l build/wifi_floppy.bin
cd ../..
```

  Expected:
  - the cache shows LOOP and L2 `ON`, DF1_DEFAULT and FW_DEBUG `OFF`;
  - the version is `1.11.0+g<M>`, with no `-dirty` and no `+nogit`;
  - the counts are 0, 0, 1;
  - the sizes are within a few hundred bytes of Task 4b Step 9's and Task 6 Step 5's.
  - If the cache still shows `FIRMWARE_SEMVER` (a `-D` from an older session), check that the header says 1.11.0.
    If it does not, re-run the `cmake` line with `-UFIRMWARE_SEMVER`.

- [ ] **Step 7: Publish it as a TEST build: registry only, never GitHub** (from the main tree):

```bash
pnpm firmware:publish --dry-run --no-github --notes "TEST build: PaulaNET Phase 3 -- the 1.11.0 release configuration at <M>, for the A500 bench before the release (never a GitHub release)"
pnpm firmware:publish --no-github --notes "TEST build: PaulaNET Phase 3 -- the 1.11.0 release configuration at <M>, for the A500 bench before the release (never a GitHub release)"
```

  Expected: the dry run refuses nothing (the Step 2 rule), and the publish prints a sequence above 77 and
  `GitHub release skipped (--no-github)`. Record the sequence.

- [ ] **Step 8: Operator, one step: switch the A500 OFF.** End the turn asking for exactly that, and nothing else.

- [ ] **Step 9: Install the TEST build.**
  - Make sure the serial logger runs (Global Constraints).
  - From `/Users/sfs/Devel/webadf`, run `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '1.11.0+g<M>'`, and
    say in the conversation that an install was triggered.
  - Expected in the log after the trial boot:
    - `df1: <mode> at boot (stored)`. The bench board stored Next disk under TEST 77, so expect `next disk of the
      set`;
    - `pnet: network path built in; off`;
    - no `wf-pnet-loop-test` line;
    - `pnet: L2 sharing ready (runs in DF1 Network mode), MAC 28:cd:c1:19:6a:38`;
    - `associated, default route w00 ip=<board ip>`. Record it: ruling 4's client-id may give a new address where
      1.10.2 had none;
    - the first `heap: free low-water` line, which must be ≥ 20,480 B (record it);
    - the confirmed boot (the update state clears).
  - The Devices card shows `1.11.0` and the Network option enabled.

---

### Task 14: Bench acceptance (spec §7) on the TEST build of M

**Files:** none in the repository. On the Amiga (A500 PAL, KS 3.1, Workbench 3.1 + AmiTCP_NG v4.1.8 on IDE), Phase 2's
hand-installed files go and `Install` puts them back.

This is the whole of spec §7's bench, run on the TEST build `1.11.0+g<M>` (ruling 20). Only if every step passes
does Task 15 build and publish the release. A failure stops here: fix it on a branch, merge it, and repeat Task 13
from Step 3 with a new M.

**Interfaces:**
- Consumes: Task 13's board.
- Produces: the verdicts and numbers for §3bj.

Each operator step below is one turn and ends the turn with its request.

- [ ] **Step 1: The Next-mode check disks** (no operator step). In the scratchpad `S`:

```bash
cd "$S" && mkdir -p p3check && cd p3check
head -c 440000 /dev/urandom > upper.bin
printf 'P3 check disk 1 of 2\n' > one.txt
xdftool -f "P3 Check (Disk 1 of 2).adf" create + format P3Check1 ffs + write one.txt
xdftool -f "P3 Check (Disk 2 of 2).adf" create + format P3Check2 ffs + write upper.bin
python3 -I - "P3 Check (Disk 2 of 2).adf" <<'EOF'
import struct, sys
d = open(sys.argv[1], 'rb').read()
bmb = struct.unpack('>I', d[880*512+316:880*512+320])[0]; bm = d[bmb*512:(bmb+1)*512]
free = lambda b: (struct.unpack('>I', bm[4+4*((b-2)//32):8+4*((b-2)//32)])[0] >> ((b-2) % 32)) & 1 == 1
print('cylinders 76-77 hold upper.bin:', all(not free(b) for b in range(76*22, 78*22)))
EOF
cp "P3 Check (Disk 1 of 2).adf" "P3 Check (Disk 2 of 2).adf" ~/Downloads/
```

  Expected: `cylinders 76-77 hold upper.bin: True` (measured the same way while planning).

- [ ] **Step 2: Operator, one step: §7.1 Off.**
  - On the card, set *Second drive (DF1)* to **Off**. Wait for "Set on the board — takes effect when the Amiga
    restarts".
  - Mount the Workbench 3.1 set's disk 1 on DF0. Switch the Amiga on (or press Ctrl-Amiga-Amiga) and let it boot as
    it always does.
  - In a Shell:
    ```
    info
    copy c:dir df0:p3test
    delete df0:p3test
    ```
  - PASS:
    - it boots as under 1.10.2;
    - `info` lists DF0 and no DF1;
    - copy and delete give no requester;
    - the board log shows `write: trk … ALL bad 0` lines each followed by `applied`, and no `pnet:` line besides the
      boot banner.
  - Also ask: did the board's address change after the install (Task 13 Step 9)?

- [ ] **Step 3: Operator, one step: §7.1 Next disk, cylinders 76/77 are disk data.**
  - Upload both `~/Downloads/P3 Check (Disk N of 2).adf` on the Library page and accept *These 2 disks look like one
    set*. Mount disk 1 on DF0.
  - On the card choose **Next disk of the set**, wait for "Set on the board", then press Ctrl-Amiga-Amiga.
  - In a Shell:
    ```
    info
    copy DF1:upper.bin TO NIL:
    ```
  - PASS:
    - `info` lists DF1 as P3Check2;
    - the copy ends with no requester and no "Error" line (ruling 22);
    - the board log has no `pnet:` line in this window.
  - FAIL: a read/write error requester on DF1. That is a Network-only path running in Next mode: stop and report.

- [ ] **Step 4: Operator, one step: a clean Workbench, and the offline timing** (ruling 23). In a Shell:

```
list DEVS:NetInterfaces
delete DEVS:NetInterfaces/eth0
delete DEVS:Networks/PaulaNET.device
search S:User-Startup AddNetInterface
NetLoop SELFTEST >RAM:st-off.txt
search RAM:st-off.txt ms
```

  - PASS:
    - both `delete`s report the file deleted. If either says "not found", that is fine: report which;
    - `search S:User-Startup` finds nothing;
    - the last `search` prints the `selftest: … align … ms, parse … ms` and `equivalence ok (… ms)` lines.
  - Photograph or read them out: these are the offline timings.
  - If `list DEVS:NetInterfaces` shows another interface file, report it before deleting anything else: it would
    confuse every step below.

- [ ] **Step 5: Operator, one step: choose Network, and boot from the hard drive with DF0 empty** (ruling 6,
  Review Focus 2).
  - On the web, **eject** DF0, so that the board holds no DF0 disk.
  - On the card choose **Network (PaulaNET)** and wait for "Set on the board — takes effect when the Amiga restarts".
  - Switch the Amiga off and on, so that it boots Workbench from the IDE drive with DF0 empty.
  - After about 20 s, reload the Devices page.
  - PASS:
    - the Amiga boots from the hard drive, and `info` lists DF0 with no disk and DF1 as **PaulaNET**;
    - the card shows "✓ Driver disk: in DF1", "• Driver: not heard from yet — run Install, then AddNetInterface
      eth0" and "• Amiga address: none yet";
    - the board log shows `df1: setting … applied -- on (Network)`, `preload: ca487c73a218 -> slot 2`,
      `preload: … verified in slot 2` and `df1: inserted the next disk`, with no DF0 `fetch:` line.
  - FAIL "Driver disk: loading" for over a minute: read the log for the preload's `fetch:` line and its status. A
    404 means the image route's exemption or the blob upload is missing (Task 8).

- [ ] **Step 6: Operator, one step: Install from Workbench.**
  - Open the PaulaNET disk's window and double-click **Install**.
  - PASS:
    - the window prints "Copied PaulaNET.device to DEVS:Networks.", "Wrote DEVS:NetInterfaces/eth0.", then the
      `AddNetInterface eth0` hint, and closes on Return;
    - in a Shell, `type DEVS:NetInterfaces/eth0` prints exactly `device=PaulaNET.device`, `unit=0`,
      `configure=dhcp`;
    - `list DEVS:Networks/PaulaNET.device` shows 13872 bytes.
  - Also ask: did both icons (Install, ReadMe) appear without covering PaulaNET Config's? Does **ReadMe** open in
    MultiView?

- [ ] **Step 7: Operator, one step: Install is safe twice.**
  - In a Shell: `Execute PaulaNET:Install`, then `type DEVS:NetInterfaces/eth0`.
  - PASS:
    - it prints "Copied PaulaNET.device…", "DEVS:NetInterfaces/eth0 already exists: left as it is." and the three
      lines it needs;
    - `eth0` is unchanged.

- [ ] **Step 8: Operator, one step: online, and the checklist.**
  - In a Shell:
    ```
    AddNetInterface eth0
    ShowNetStatus
    ```
  - Then reload the Devices page.
  - PASS:
    - `eth0` is up with an address from the router, different from the board's;
    - the card shows "✓ Driver: talking (last seen N s ago)" and "✓ Amiga address: <that address>" beside
      "✓ Driver disk: in DF1", and a "Traffic: …" line (spec §7.2).
  - Record the lease, router and DNS.

- [ ] **Step 9: Operator, one step: the online timing and the mouse** (ruling 23).
  - `NetLoop SELFTEST >RAM:st-on.txt` then `search RAM:st-on.txt ms`. Read out the same lines as Step 4.
  - Also ask: does the mouse pointer and Workbench feel usable?
  - The ratio of the online to the offline timings is the CPU share the driver's priority-1 poll leaves (spec §8).
    Compute it per line, and record it.

- [ ] **Step 10: Operator, one step: acceptance 2-3 (Phase 2's), ping and DNS.**
  - `ping -c 10 <router>`, `ping -c 10 8.8.8.8`, `nslookup amiga.org`.
  - PASS: at most 1 of 10 lost each, and an address printed. Record both `min/avg/max`.

- [ ] **Step 11: The FTP server** (no operator step): exactly Phase 2's Task 7 Step 1 (venv, `pyftpdlib==1.5.10`,
  `t200k.bin` of 204,800 random bytes, the server on port 2121 in the background). Record its PID; it is the only
  process this task may stop. Check it from the Mac with curl.

- [ ] **Step 12: Operator, one step: acceptance 4, 200 KB.**
  - If macOS asks about Python accepting connections, click Allow first.
  - `ftp GET <MAC_IP> t200k.bin RAM:t200k PORT 2121`, then `list RAM:t200k`.
  - PASS: 204800 bytes. From `grep RETR "$S/ftpd.log" | tail -1`, KB/s = 200 / seconds. Phase 2 measured 47.5 KB/s.

- [ ] **Step 13: Operator, one step: acceptance 5, during a DF0 copy.**
  - DF0 is empty since Step 5. First mount the Workbench 3.1 set's disk 1 on DF0 (as in Step 2) and wait for its icon.
  - Two Shells: `ftp GET <MAC_IP> t200k.bin RAM:t200k2 PORT 2121` in one, `copy c:dir df0:pnettest` in the other,
    and press Return in both about at once.
  - PASS:
    - 204800 bytes;
    - no requester;
    - every DF0 `write: … ALL bad 0` line in the window is followed by `applied`.
  - Record KB/s (Phase 2: 24.4) and any `pnet: lost N batches to DF0 writes` line.

- [ ] **Step 14: Operator, one step: acceptance 6, Ctrl-A-A.**
  - Press Ctrl-Amiga-Amiga, then `AddNetInterface eth0`, `ping -c 3 <router>`.
  - PASS: back online, and the pings reply.

- [ ] **Step 14b: Operator, one step: DF0 disks come and go while online** (ruling 6, Review Focus 2).
  - In a Shell, start `ping -c 60 <router>` (one a second).
  - While it runs:
    - on the web, **mount** the Workbench 3.1 set's disk 1 on DF0 (DF0 was empty);
    - about 20 s later, mount its disk 2 instead;
    - about 20 s later, **eject** DF0.
  - When the ping ends, run `info`.
  - PASS:
    - the ping summary shows at most 3 lost of 60 (Phase 2's ordinary loss), with no run of losses lined up with a
      DF0 change;
    - `info` lists DF1 as PaulaNET throughout;
    - the board log shows the DF0 `fetch:` lines into slot 0/1 and **no** `df1: ejected` line in this window;
    - DF0 itself shows each disk on the Amiga (Workbench's DF0 icon changes).
  - FAIL: a `df1: ejected` line, or a run of lost pings at a DF0 change. Either means a DF0 path touched `SLOT_NET`:
    stop and report.

- [ ] **Step 15: Read the serial log** (no operator step).
  - `grep -c 'records dropped' <log>` must be 0.
  - Then record, as in Phase 2's Task 7 Step 8:
    - the lowest `heap: free low-water` and the lowest `heap` in `pnet: l2 amiga` lines, both ≥ 20,480 B (spec §7.3
      item "heap low-water at least 20,480 B");
    - no gap over 10 s while `eth0` was up;
    - every drop counted (`l2 in … drop`, `l2 from amiga … over … bad`, `tx no …`);
    - `pnet: go … delayed … late`;
    - `l2 status N early E`;
    - `fw: update held` (expect 0).
  - Stop the FTP server by its PID, and only that PID.

- [ ] **Step 16: Operator, one step: §7.4, back to Off.**
  - On the card choose **Off**, wait for "Set on the board", then press Ctrl-Amiga-Amiga. In a Shell: `info`. Reload
    the Devices page.
  - PASS:
    - `info` lists no DF1;
    - the card shows no checklist;
    - the board log shows `pnet: off -- DF1 is off; the network link is forgotten` once.

---

### Task 15: The bench record (commit R), then release 1.11.0 and a smoke check

Only after Task 14 passed in full (ruling 20).

**Files:** Modify `HANDOFF.md`: a new section directly above `### 3bi.` (line 4813).

**Interfaces:**
- Consumes: Task 14's verdicts.
- Produces:
  - commit **R** on master (the bench record; its `wifi-floppy/` tree is M's);
  - the registry release and the GitHub release `fw-1.11.0` of `1.11.0+g<R>` (the same signed files);
  - the bench board on it.

- [ ] **Step 1: Write §3bj from the bench.** Heading:
  `### 3bj. PaulaNET Phase 3 (Network as a DF1 setting) -- TEST 1.11.0+g<M> seq <n> PASSED on the A500 (<date>); release 1.11.0 follows`.
  Contents:
  - the verdict in two sentences;
  - the bench setup (the same A500, the disks used);
  - a table of Task 14 Steps 2-16 as PASS/FAIL with their numbers:
    - the lease, both pings, nslookup;
    - KB/s alone and during the DF0 copy;
    - Ctrl-A-A;
    - **the hard-drive boot with DF0 empty (Step 5) and the DF0 changes while online (Step 14b)**;
    - heap baseline and low-water;
  - **the busy-poll figure**: the offline and online SELFTEST lines and their ratio (the first measurement; Phase 2's
    was lost), and the operator's answer about the mouse;
  - the board's address before and after the install (ruling 4);
  - the sizes: `.text/.data/.bss/.psram_noload/.bin` against 1.10.2's (Task 4b Step 9, Task 5 Step 12, Task 13
    Step 6), and the PSRAM left;
  - the driver disk sha256 `ca487c73…` and where it lives (Blob `adf/<sha>`, `tools/paulanet-disk/`,
    `third-party/paulanet/`);
  - this plan's rulings 1-26 and corrections 1-3, one line each, plus every ruling and deviation made during execution
    (the SDD ledger);
  - the open questions below, with what the bench answered;
  - the off switch: choose Off on the card and restart the Amiga. Rollback: a 1.11.1 from master with a fix, because
    the registry refuses a lower sequence. A board put back on 1.10.2 boots a stored Network setting as Off (its
    `drive_boot_mode` knows only 1).

  Commit it in the main tree on master, and push:

```bash
git status --short          # HANDOFF.md, plus the three untracked items
git add HANDOFF.md
git commit -m "HANDOFF 3bj: PaulaNET Phase 3 bench passed on TEST 1.11.0+g<M> -- releasing 1.11.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
git push origin master
git rev-parse --short HEAD          # R
git diff --stat <M> HEAD -- wifi-floppy/    # prints nothing: the firmware tree is the one benched
```

  If `git diff` prints anything (another session changed the firmware on master since M), stop and ask the operator.
  Releasing now would ship code the bench did not run.

- [ ] **Step 2: Build R in the main tree's `build/`**, exactly as Task 13 Step 6 (every option explicit, the same
  checks). Expected:
  - the version `1.11.0+g<R>`;
  - the counts 0, 0, 1;
  - every size equal to Task 13 Step 6's, or within a few bytes. The version string is the only source difference.

- [ ] **Step 3: Publish to the registry and GitHub, the same signed files** (from the main tree). The notes end with
  ruling 26's sentence:

```bash
NOTES="Network (PaulaNET): DF1 can be your Amiga's network adapter through the board's Wi-Fi, with Rob Smith's PaulaNET driver (by permission). Choose Network (PaulaNET) for the second drive; see Help > Amiga networking. After updating, your router may give the board a new network address once; nothing needs changing."
pnpm firmware:publish --dry-run --notes "$NOTES"
pnpm firmware:publish --notes "$NOTES"
gh release view fw-1.11.0 --json assets,body --jq '.assets[].name, .body'
```

  Expected:
  - the dry run refuses nothing;
  - the publish prints the next sequence and creates the GitHub release `fw-1.11.0` with `wifi_floppy.bin`, its
    `.uf2`, the partition table, `manifest.json` and `wifi-floppy-install-1.11.0.uf2`;
  - the body carries the address sentence.

  Record the sequence. **If the GitHub step fails after the registry step succeeded**, run
  `pnpm firmware:publish --github-only` (it checks the files byte for byte against the registry). Never publish a
  second build.

- [ ] **Step 4: Operator, one step: switch the A500 OFF.** End the turn asking for exactly that, and nothing else.

- [ ] **Step 5: Install 1.11.0.**
  - From `/Users/sfs/Devel/webadf`, run `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '1.11.0+g<R>'`, and
    say in the conversation that an install was triggered.
  - Expected in the log after the trial boot:
    - `df1: network (PaulaNET) at boot (stored)` (Task 14 Step 16 set Off: then `off`, which is fine);
    - `pnet: network path built in; …`;
    - no `wf-pnet-loop-test` line;
    - the confirmed boot.
  - The card shows `1.11.0` with no TEST.

- [ ] **Step 6: Operator, one step: the smoke check.**
  - If Task 14 ended in Off, choose **Network (PaulaNET)** on the card first and wait for "Set on the board".
  - Switch the Amiga on (booting from the hard drive; DF0 may be empty). In a Shell: `AddNetInterface eth0`, then
    `ping -c 1 <router>`. Reload the Devices page.
  - PASS:
    - the boot log of Step 5 as expected;
    - the card shows all three checklist lines with ✓ (driver disk in DF1, driver talking, the Amiga's address);
    - the one ping replies.
  - Then the operator may switch DF1 to whatever they want to keep.

---

### Task 16: The release record and the backlog

**Files:** Modify `HANDOFF.md` (§3bj, and the backlog entry "Amiga networking over the floppy port", ~line 2575).

- [ ] **Step 1: Complete §3bj.**
  - Change its heading's tail to `; release 1.11.0+g<R> seq <n2> installed and smoke-checked (<date>)`.
  - Add the release's version, sequence, the GitHub release name, the smoke check's three results, and the board's
    address after the install.
- [ ] **Step 2: The backlog.** In "Amiga networking over the floppy port", append
  `**Phase 3 PASSED <date> (3bj): Network (PaulaNET) is a DF1 setting in release 1.11.0, with the driver disk
  served as DF1 (DF0 empty or changing included) and Install on it. Phase 4 (drop files onto the Amiga) is next,
  spec 2026-10-12 §9; its first step is the spike on board-Amiga local reachability.**` Do not plan Phase 4 here.
- [ ] **Step 3: Commit** (in the main tree, on master; then push):

```bash
git status --short          # HANDOFF.md, plus the three untracked items
git add HANDOFF.md
git commit -m "HANDOFF 3bj: release 1.11.0 (PaulaNET Network mode) published, installed, smoke-checked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y9miKU6cbLA5PVYzAvvujU"
git push origin master
```

- [ ] **Step 4: Tell the operator** the verdict, the busy-poll ratio, and the open questions. Ask, as the turn's last
  thing: "Phase 3 is released as 1.11.0. Remove the worktree `.claude/worktrees/pnet3` and start the Phase 4 spec
  (board-Amiga local reachability spike first)?"

---

## Open questions (not settled by the code or the spec)

1. **Rob's own message** for `third-party/paulanet/PERMISSION.md`: the operator adds it when convenient (spec §3).
2. **DF0's "Next disk" preload in Network mode** is lost (ruling 6: the server's `next` is the driver disk), so a
   Next on DF0 is a full fetch of a few seconds instead of an instant swap.
   - A second `next` field (one for DF0, one for DF1) would restore it, at the cost of a poll-body change and a
     device-limits budget check.
   - The operator decides whether it is worth a follow-up.
3. **The TEST build goes into the registry,** so between Task 13 Step 7 and Task 15 Step 3 any user's board could be
   offered `1.11.0+g<M>` with its "TEST build" notes. Phase 2's TEST builds (seq 72-77) were offered the same way.
   - If that should no longer happen, the registry needs a "bench only" flag. That is out of this plan's scope.

(Decided by the operator on 2026-10-12, no longer open:
- the DF0 rule is dropped for Network mode (ruling 6);
- the DHCP client-id stays and is announced (rulings 4, 26);
- the release order is a TEST build first, then 1.11.0 (ruling 20).)

## Self-review (done while writing this plan, and again after the operator's three decisions)

1. **Spec coverage:**
   - §1 decisions: one setting with three values (Tasks 4, 7, 9, 10). The restart rule and df1_seen with the
     override (Task 9, e2e Task 12). No live switching (the existing restart rule; `df1_live_apply`'s shape is
     kept). Rob's terms (Task 2). Release builds gated at runtime with the loopback TEST-only (Task 5). The
     out-of-scope items are untouched, m5 included.
   - §2 the disk: contents, layout and Install's four steps (Task 3); Blob by sha and served as `next` (Task 8),
     held in its own slot (Task 4b, correction 3); the download (Tasks 8, 11).
   - §3 licence and notices: Task 2. The ReadMe's line: Task 3 Step 4.
   - §4 firmware: `DF1_MODE_NET` (Task 4); `SLOT_NET` (Task 4b); the gate, marker and identity-script retirement
     (Task 5); the `net` tail (Task 6); memory measured (Task 4b Step 9, Task 5 Step 12, Task 13 Step 6).
   - §5 server and web: columns and the status route (Task 7), the API (Task 9), the poll and DD WFAD (Task 8), the
     card (Task 10), Help with the address note (Task 11).
   - §6 release, with the operator's order: a TEST build of M (Task 13), the bench (Task 14), then 1.11.0 to the
     registry and GitHub and a smoke check (Task 15).
   - §7 testing: host (Tasks 3-6, 4b), e2e (Task 12), bench 1-4 plus the hard-drive boot and DF0 changes (Task 14).
   - §8 limits: Help and Task 14 Step 9. §9: Phase 4 is left out except the backlog line and Install's `Lab DONE`
     room.
2. **Placeholder scan:**
   - Values only a run produces are named as such: `<M>`, `<R>`, `<n>`, `<MAC_IP>`, `<router>`, the KB/s.
   - The disk sha256 is a real value, measured twice while planning, with Task 3 Step 8 saying what to do if it
     differs.
   - Task 5 Step 8 item 11 moves an existing ~45-line body by naming its first and last lines instead of retyping it.
   - Task 4b names three existing test helpers to reuse, with the `grep` that finds each (the digest constants, the
     WFMF image response, the per-mount response pattern), instead of guessing their names.
3. **Type consistency:**
   - `df1_mode_t` values 0/1/2 match `drive_record_t.mode` (`uint8_t`) and `pnet_mode_on(uint8_t, bool)`.
   - `SLOT_NET` (2) fits the two-bit token. It is outside `SLOT_COUNT` (2), which `psram_inactive_slot` and
     `psram_publish_slot` keep to.
   - `NET_TRACK_BYTES` (5,632) equals `WFAD_SECTORS_DD × 512` and the TS `TRACK_DATA_BYTES`.
   - `writeWfadDd`'s 16-byte header is the one the firmware test and the e2e test spell out.
   - `dc_net_t` fields match `main.c`'s fill and the tail's keys.
   - The zod `net` object matches `recordStatus`'s `net` type and the e2e bodies.
   - `SecondDriveMode` (`'off'|'df1'|'net'`) is used by `asSecondDriveMode`, `firmwareFor`, `secondDriveRefusal`,
     `PollTick` and the setting's `pending` state.
   - `PAULANET_NEXT` matches the poll's `next` shape. `driverDiskLine` takes `{ df1Sha256 }` only, everywhere.
4. **Review Focus:** each of the five lines has its test in its owning task.
   - Line 1: Task 7.
   - Line 2: Task 8 (poll) and Task 4b (firmware), plus bench Steps 5 and 14b.
   - Line 3: Task 4.
   - Line 4: Task 5, plus the bench log.
   - Line 5: the Task 12 e2e.
