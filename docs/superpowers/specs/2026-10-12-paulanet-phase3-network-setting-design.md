# PaulaNET Phase 3: networking as a setting a regular user can turn on (design, 2026-10-12)

**Status:** the operator approved this design in conversation on 2026-10-12. This document is for review before the
plan is written.

**Goal:**
- A regular user chooses **Network (PaulaNET)** for the board's second drive and restarts the Amiga.
- The disk in DF1 is then the PaulaNET driver disk. Its **Install** puts the driver in place.
- One command, or one line in `S:User-Startup`, brings the Amiga online through the board's Wi-Fi.
- The board's card shows each step's state, good or bad.
- This ships in a release (**1.11.0**), which also takes the bench board off TEST.

**Background:**
- HANDOFF §3bh (Phase 1) and §3bi (Phase 2: all seven acceptance items passed on the A500, 47.5 KB/s).
- The Phase 2 spec: `docs/superpowers/specs/2026-10-11-paulanet-phase2-rob-driver-design.md`, including its
  amendments.

## 1. Decisions

- **One setting, three values.** "Second drive (DF1)" becomes **Off / Next disk of the set / Network (PaulaNET)**.
  - Network uses DF1 for itself, so it cannot also hold the next disk. Putting both in one choice says so without
    words.
  - It keeps DF1's rules:
    - the change takes effect when the Amiga restarts;
    - the board refuses when it has seen a real DF1 drive, with the same *Switch on anyway…* override.
  - **No live switching.** It follows the same restart rule as Next disk. *(Phase 2's spec listed live switching for
    Phase 3. It is dropped: the restart rule is what users already know for DF1, and a mode change under a running
    driver gains nothing.)*
- **DF1 holds the driver disk in Network mode,** served by the server like any other DF1 image.
  - Rob's driver needs a disk in DF1 at open (`TD_CHANGESTATE`).
  - The user finds the driver on that disk, with nothing to download.
- **Rob's code is used on his terms, by permission** (operator, 2026-10-12).
  - Rob is fine with us using all of PaulaNET as long as his licence is kept: "Copyright © 2026 RobSmithDev. All
    rights reserved", used with permission.
  - His files stay under his terms in a third-party folder. They are not MIT, and webadf's MIT licence does not cover
    them.
- **PaulaNET moves into release builds,** gated at runtime by the DF1 mode.
  - The loopback echo (NetLoop's bench mode) stays a TEST-only build option.
- **Out of scope:**
  - Rob's config tool (cylinder 75 scan, writes to 76). Wi-Fi stays a web setting.
  - Bundling a TCP/IP stack. The help topic links to AmiTCP_NG.
  - Final-review item m5 (re-arming the delayed start from a newer SIDE edge). It changes measured timing and needs its
    own bench run, so it stays parked.

## 2. The driver disk

- **Contents:**
  - Rob's `PaulaNET.device` from `0afd5fa`, unmodified (13,872 bytes);
  - his `PaulaNET Config`, left on the disk as he ships it;
  - an **`Install`** script (ours) with a Workbench icon (IconX);
  - a **`ReadMe`** (ours): what it is, credit and licence, and the one command to go online.
- **Layout:** built from Rob's image. His bitmap already marks cylinders 75-79 used (checked 2026-10-12: all 22
  blocks of 75, 76 and 77 are allocated), so no file ever lands on the network cylinders. Our files are added with
  `xdftool` and fit easily (372 of 1,760 blocks used).
- **`Install` does exactly what the bench did by hand,** and is safe to run twice:
  1. Make `DEVS:Networks` if missing.
  2. Copy the driver there.
  3. Write `DEVS:NetInterfaces/eth0` with `device=PaulaNET.device`, `unit=0` and `configure=dhcp`, unless an `eth0`
     already exists. If one does, it says so and leaves it alone.
  4. Print the next step: `AddNetInterface eth0`, and how to add it to `S:User-Startup`.

  The same `eth0` format serves AmiTCP_NG and Roadshow, which read `DEVS:NetInterfaces/`.
- **Where it lives:**
  - Built once by a script in the repository (`tools/paulanet-disk/`), from a pinned copy of Rob's driver binary and
    our two files.
  - Stored in Blob by its sha256, like any image.
  - The server sends it as DF1's image in Network mode, through the same path as the next disk (`next: {sha256, …}` in
    the poll body, preload from `/api/device/image/<sha>`).
  - The board needs no built-in disk and no flash space for it.
- **Also downloadable** from the help topic, for users who want it on a real floppy or in an emulator.

## 3. Licence and notices

- **Third-party folder:** `third-party/paulanet/` holds:
  - the pinned driver binary;
  - Rob's licence line;
  - a `PERMISSION.md` recording both grants:
    - 2026-10-09: the protocol, credit and licences respected;
    - 2026-10-12, relayed by the operator: all of his code may be used and redistributed on his terms.
  - The operator adds Rob's own message there when convenient.
- **Root notice:** `THIRD-PARTY-NOTICES.md`'s PaulaNET entry gains one line: the driver binary is redistributed on the
  PaulaNET disk under Rob's terms, by permission. It is not MIT.
- **The disk's `ReadMe`** carries the same credit and licence line.

## 4. Firmware

- **New DF1 mode:** `df1_mode_t` gains `DF1_MODE_NET`.
  - The store, the boot mode and the poll's `secondDrive.mode` accept `"net"`.
  - An older board ignores an unknown mode and keeps its own. The server gates by firmware version (§5).
- **Release builds include the L2 path:** `pnet_mfm/frame/rx/sort/ring/link/bridge/status` and the radio's L2 send.
  - Every hook that today checks `WF_PNET_L2` at compile time also requires `g_df1_mode == DF1_MODE_NET` at runtime.
  - In Off and Next modes the board behaves exactly as 1.10.2:
    - DF1 cylinders 76/77 are plain disk cylinders;
    - no WPROT trick;
    - no status track;
    - the radio's L2 hook returns at once.
- **Network mode:**
  - DF1 is the driver disk.
  - Cylinder 76 is the status track; cylinder 77 is Phase 2's path; every other cylinder is the disk, read-only.
  - The timing is Phase 2's: 120-byte lead-in, side-1 start 2,360 µs after SIDE.
- **The loopback echo** (`WF_PNET_LOOP` without L2, NetLoop's bench mode) stays a compile option for TEST builds.
  - Its marker `wf-pnet-loop-test` stays.
  - `firmware-manifest.ts` keeps refusing that marker in a non-TEST release.
  - The L2 code gets no marker.
- **Memory:**
  - The rings and buffers stay in PSRAM (about 176 KB, allocated statically as today).
  - SRAM grows by about 1 KB (Phase 2 measured .bss +1,012 B).
  - The plan measures both, and the image size, in the release build.
- **Report:** the status POST gains a `net` tail, sent only in Network mode:
  - `driver`: seconds since the last cylinder-76 read, or absent if never;
  - `amigaIp`: the Amiga's address as the sorter learned it, or absent;
  - `frames`: to and from the Amiga, saturated counters.
- **`tools/pnet_off_identical.sh` retires.** "Off mode is unchanged" becomes a bench check (§7). The release image now
  differs by design.

## 5. Server and web

- **Data:**
  - `devices.second_drive` (text) accepts `'net'`.
  - New columns: `net_driver_seen_at` (timestamp), `net_amiga_ip` (text), `net_frames_in` and `net_frames_out`
    (int).
  - All are written by the status route in the existing "unknown fields dropped, never rejected" style.
- **API:** `PATCH /api/devices/[id]/second-drive`.
  - Its zod enum becomes `['off','df1','net']`.
  - `'net'` is refused with 409 `firmware_too_old` below **1.11.0**.
  - The `df1_seen` rule and the override apply to `'net'` as to `'df1'`.
- **Poll:** in Network mode, `next` carries the PaulaNET disk's sha256 for DF1 instead of the next disk of the set.
  The disk is a fixed image the server knows by sha, not a library disk.
- **Card (`second-drive-setting.tsx`, `second-drive-readings.tsx`):**
  - **Choice:** the select gains *Network (PaulaNET)*.
  - **Status line:** "Set on the board — takes effect when the Amiga restarts".
  - **Checklist,** shown while Network is the applied mode, every state named both ways:

    | Item | Shows | Otherwise |
    |---|---|---|
    | Driver disk | "Driver disk: in DF1" | "Driver disk: loading" |
    | Driver | "Driver: talking (last seen 4 s ago)" | "Driver: not heard from yet — run Install, then AddNetInterface eth0" |
    | Amiga address | "Amiga address: 172.16.10.231" | "Amiga address: none yet" |

  - A short "Traffic" line when frames move.
- **Help:**
  - A new topic `network`, "Amiga networking (PaulaNET)", written for a regular user. It covers:
    - what it does;
    - what you need: a TCP/IP stack such as AmiTCP_NG or Roadshow, and no other DF1 drive;
    - the three steps;
    - honest numbers: about 45 KB/s, about half that while using DF0, pings about 250 ms;
    - what to expect: the mouse may feel slower while the driver runs;
    - the driver disk download;
    - credit to Rob Smith.
  - The `second-drive` topic names the third option and links to `network`.
  - Both obey `topics.test.ts`: 60-260 words, and none of the banned words (PSRAM, poll, sha256, cursor, WPROT, TBYB).

## 6. Release

- **1.11.0** is built from master with the L2 path in and the loopback out.
  - It is published to the registry and to GitHub as the same signed files (operator rule).
  - It takes the bench board off TEST sequence 77.
- `SECOND_DRIVE_NET_FW = '1.11.0'`.

## 7. Testing

- **Host:**
  - the DF1 mode store and the poll parser accept `net`, and an unknown mode is ignored;
  - the runtime gate: with the mode Off or Next, the L2 hooks return at once (unit tests on the gate predicates);
  - the `Install` script's logic is checked on the ADF with `xdftool` (files present, cylinders 75-79 still
    allocated);
  - the existing pnet tests stay green.
- **e2e (PORT=3100, serialized, touched specs only):**
  - the second-drive setting with `net`: the version refusal, the `df1_seen` refusal and override, and the status
    line;
  - the checklist's states from seeded columns;
  - the help topic renders.
- **Bench (A500, KS 3.1):**
  1. **Off unchanged:**
     - with DF1 Off, DF0 boots and writes as before;
     - with Next disk, DF1 holds the next disk and cylinders 76/77 read as disk data.
  2. **Network from a clean Workbench:**
     - choose Network, restart, open DF1 and run Install;
     - `AddNetInterface eth0`, then the card shows all three checklist items good.
  3. Phase 2's acceptance 2-7 again on the release build (ping, nslookup, 200 KB transfer, during a DF0 copy,
     Ctrl-A-A, heap low-water at least 20,480 B).
  4. **Switching back to Off:** after a restart, DF1 is gone and the card's checklist disappears.

## 8. Known limits

- About 4-5 % of reads miss the driver's sync window and are retried (Phase 2 §3.4 amendment).
- The busy-poll cost on a 68000 is still unmeasured. The bench (§7.3) records the selftest ratio this time.
- A board on firmware older than 1.11.0 cannot be set to Network. The card says why.

## 9. Next: Phase 4, files dropped onto the Amiga (operator, 2026-10-12)

The backlog's "Drop files onto the Amiga's RAM:" (2026-10-09) follows as Phase 4, with its own spec. It has three
parts:
- a small Amiga receiver on the PaulaNET disk, which `Install` sets up, with its target directory in ENVARC:;
- a drop zone on the board's card;
- files carried through the board's existing server session.

Phase 3 leaves room for it in three ways:
- the disk is a server-side image, so adding the receiver is a new sha;
- `Install` is written so steps can be added;
- the `net` report already carries the Amiga's address.

Phase 4's first step is a spike: can the board and the Amiga reach each other locally through the L2 sharing bridge?
**Phase 3 must not depend on it.**
