# DF1: any disk, not only the next disk of a set -- design

**Date:** 2026-10-14. **Status:** design agreed in chat with the operator; written for review.
**Builds on:** `docs/superpowers/research/2026-10-08-df1-second-drive.md` (DF1, fw 1.9.0),
`docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md` (Network, SLOT_NET, fw 1.11.0),
HANDOFF 3bk (fw 1.11.1).

## 1. What the operator asked for

"Now we have DF1 support, maybe we should offer that out of sets too, so it's not implied that it will only be
available to the next disk in a set only -- meaning you can select mount in DF0 or DF1 (if the drive has been set to
second drive)."

Decisions made in chat (2026-10-14):

| # | Decision |
|---|---|
| D1 | When DF1 is on, every Mount offers **DF0 or DF1**. Off and Network: Mount goes to DF0, as today. |
| D2 | **Read-only** first. DF1 stays write-protected (as in fw 1.9.0+); DF1 writes are a later step. |
| D3 | Nothing picked for DF1 -> DF1 follows the set (today's "Next disk" behaviour). A pick overrides it; **Eject DF1** on the card drops the pick, and DF1 follows the set again. |
| D4 | The setting keeps three values (Off / On / Network). "Next disk of the set" is **renamed "On"** (stored value `df1` unchanged). |
| D5 | The NFC Next-disk card and the web "Next disk" always mean **DF0** goes to the next disk of its set. DF1 advances with it only while it follows the set. |
| D6 | **Approach A:** a picked disk lives in **DF1's own slot (SLOT_NET)**, so it works with DF0 empty, is never disturbed by DF0 loads, swaps or ejects, and DF0's next disk keeps preloading in the idle slot (Next taps stay instant). Cost: a firmware change and release, and DF1 picks are **standard DD ADFs only**. |

## 2. Facts this design leans on

- DF1 in "Next disk" mode serves the preload record (DF0's idle slot), and only while DF0 holds a disk
  (`dc_df1_want`, `device_client.c`, "Next disk's rule"). So with DF0 empty (the operator boots TDH0) DF1 is empty.
- SLOT_NET (`psram_image.h:53`) is a third PSRAM slot, DF1-only, that no DF0 fetch, swap or eject touches. It takes a
  **DD WFAD** only (11 sectors x 512 B per track; `image_loader.c`, plan 2026-10-12 ruling 24). The board fetches
  into it from `/api/device/image/net/<sha256>`, which today serves only the PaulaNET driver disk
  (`servedWithoutEntitlement`).
- The poll carries one `next` (`src/app/api/device/poll/route.ts`), sent only with a DF0 disk desired, except in
  Network mode. Every other cursor on that route (`driveAck`, `displayAck`, `nfcAck`) is acked by the board.
- The board already reports what DF1 serves (`df1Sha256`, `device_client.c:1671`).
- DF1 holds DD only on default builds (`_df1_hd_ok`; DF1 HD cannot work behind CN11, HANDOFF 3bk).

## 3. Behaviour

### 3.1 Who may pick what

A disk may be picked for DF1 when **all** hold:

1. the device's DF1 setting is On (`second_drive = 'df1'`) and the board reports it applied;
2. the board's reported firmware is at least the release that ships §5 (**1.12.0**);
3. the disk is the org's, `image_format = 'adf'`, exactly 901,120 bytes (a standard DD ADF: no HD, HFE, extended or
   long-track image);
4. it is not the disk DF0 holds or is about to hold (`desiredDiskId ?? mountedDiskId`).

Otherwise the DF1 choice is shown disabled with the reason in words: "DF1 is off", "Needs firmware 1.12.0",
"DF1 takes standard DD disks only", "Already in DF0".

### 3.2 Interactions

| Event | Result |
|---|---|
| Mount a disk into DF1 | Pick stored; the board loads it into SLOT_NET; DF1 inserts it when verified (a normal disk change to the Amiga). DF0 untouched. |
| Mount another disk into DF1 | Replaces the pick (DF1 ejects, loads, inserts). |
| Eject DF1 (card) | Pick cleared; DF1 follows the set again (empty if DF0 is empty or a single disk). |
| Mount into DF0 the disk picked for DF1 | Allowed; it is a move: the pick is cleared in the same write. |
| Mount / eject / Next on DF0 | DF1's pick is untouched; DF0's next disk preloads as today. |
| Setting changed to Off or Network | Pick cleared in the same write as the setting. |
| The picked disk is deleted | FK `ON DELETE SET NULL` clears the pick; the board is told and ejects DF1. |
| The board re-pairs or reboots | It gets the pick again from the poll (the cursor rule, §4.2). |

### 3.3 What the user sees

- **Mount** (library cards, game pages, disk rows -- every place that mounts today): with one DF1-capable device on,
  the button becomes a two-choice control **DF0 / DF1**; with several devices, the choice sits per device in the
  existing device picker. DF1 shows "read-only" next to it.
- **Device card:** a DF1 line with both states in words (`show-both-values-of-a-state`):
  "DF1: next disk of the set" / "DF1: *Title* disk N -- read-only" (+ "loading" until `df1Sha256` reports it), and an
  **Eject DF1** button while a pick is in.
- **Setting:** Off / **On** / Network (PaulaNET). The help line under it: "On: DF1 holds the next disk of the set,
  or a disk you mount into DF1."
- **Drive chip** (header): shows DF1's pick when there is one.
- **Help topics** (`src/lib/help/topics.tsx`) change with this behaviour.

## 4. Server

### 4.1 Data

`devices` gains:

- `df1_disk_id uuid NULL REFERENCES disks(id) ON DELETE SET NULL` -- the pick;
- `df1_version integer NOT NULL DEFAULT 0` -- bumped on every change of the pick (set, replace, clear, including the
  clears in §3.2), the cursor the board acks.

No new column names a blob digest, so the blob GC's reference list is unchanged (disk rows keep their blobs).

### 4.2 Poll

- New query parameter **`df1Ack`** (the highest `df1_version` the board has handled), parsed like `driveAck`:
  absent = a board that cannot take picks, never woken for them.
- Wake on `df1Ack !== null && df1_version !== df1Ack` (inequality, the displayAck rule, so a re-paired board with a
  higher ack resets).
- Body key **`df1`**, sent on every body to a board that speaks `df1Ack`: `{"v":<df1_version>,"sha256":"<hex>"}`
  with a pick, `{"v":<df1_version>,"sha256":null}` without. Byte budget checked in `device-limits.ts` (the plan
  adds the worst case to the existing tally).
- `next` is unchanged: DF0's next disk of the set (or the driver disk in Network mode).

### 4.3 Image route

`/api/device/image/net/<sha256>` also serves an **entitled** standard DD ADF: a disk of the device's org with that
digest, `image_format = 'adf'`, 901,120 bytes -- as a DD WFAD (`writeWfadDd`), exactly like the driver disk.
Anything else stays 404. (The firmware fetches SLOT_NET's content from this one route; the route's name stays.)

### 4.4 Actions

- `mountToDf1(orgId, deviceId, diskId)`: one conditional UPDATE with §3.1's rules in the WHERE (the saveDisplay /
  saveSecondDrive pattern), bumping `df1_version`; a refused write reads back why.
- `ejectDf1(orgId, deviceId)`: clears the pick, bumps `df1_version`.
- `setDesired` (DF0 mount) clears the pick in the same UPDATE when the new DF0 disk is the picked one.
- `saveSecondDrive` clears the pick (and bumps `df1_version`) when the mode leaves `df1`.

## 5. Firmware (1.12.0)

- **Poll:** send `&df1Ack=<n>`; parse `df1` into a DF1 pick record `{version, sha256}`; ack the version once
  handled (applied, or refused and reported).
- **Loading:** a pick step beside `dc_preload_step`: in mode `df1`, with a pick whose digest SLOT_NET does not hold
  verified, eject DF1 if it serves SLOT_NET (`dc_df1_release`), fetch into SLOT_NET from the `net` route, verify.
  Its own block on failure (as `dc_net_block`), never DF0's ring. The DF0 preload keeps the idle slot.
- **Serving (`dc_df1_want`):** mode `df1` with a verified pick -> SLOT_NET, whatever DF0 holds; mode `df1` without
  a pick -> today's rule; Network unchanged; Off -> none.
- **Pick cleared (`sha256:null`)** -> DF1 ejects SLOT_NET and falls back to today's rule.
- **Report:** `df1Sha256` already says what DF1 serves; nothing new is needed for the card.
- **Mode changes:** leaving `df1` drops the pick record (the server clears it too, §4.4); Network keeps owning
  SLOT_NET for the driver disk.
- **Unchanged:** WPROT on DF1 asserted, SEL1 writes ignored (D2); DF1's ID answer (1.11.1).

## 6. Out of scope

DF1 writes and write-back of a second disk; HD, HFE, extended or long-track images in DF1; a pick on boards before
1.12.0; picking DF1 by NFC tag (a disk tag mounts DF0, as today); any change to Network mode.

## 7. Testing

- **Firmware host tests:** `dc_df1_want` for every (mode, pick, DF0 state) combination, including DF0 empty; the pick
  step's eject-before-write; a DF0 fetch and a Next swap never touching SLOT_NET; pick cleared -> fallback; a
  failed pick fetch blocks only the pick route; `df1Ack` and the poll URL budget.
- **Server (vitest):** §3.1's rules in the UPDATE (each refusal and its reason); the move and mode-change clears;
  the poll's wake on `df1Ack` inequality and the `df1` key; the `net` route's entitlement (another org's digest,
  an HFE, an HD ADF all 404).
- **e2e** (touched specs only, PORT=3100, serialized): the DF0/DF1 choice and its disabled reasons; the card's DF1
  line and Eject DF1; the renamed setting.
- **A500 bench** (via the PiKVM where it can be): (1) boot TDH0 with DF0 empty, mount a data disk into DF1 -> it
  appears in DF1, read-only; (2) mount a set disk into DF0 -> DF1 does not blink, DF0's next preloads; (3) a Next
  tap is instant and DF1 keeps its disk; (4) Eject DF1 -> DF1 follows the set; (5) an HFE disk's DF1 choice is
  disabled with its reason; (6) a write to DF1 fails as write-protected.

## 8. Review focus

1. A pick and a DF0 mount racing in one poll: DF0's fetch must never land in SLOT_NET, and the pick must never
   evict DF0's active slot.
2. A pick naming a digest DF0 holds (the same image under two disk rows): §3.1 rule 4 compares disk ids; two
   identical volumes on one Amiga is allowed but must not confuse the board's records (separate slots).
3. Switching to Network while a pick is loading into SLOT_NET: the driver disk must win, and the pick record must
   not re-insert after the switch.
4. A board on 1.11.x paired to a server that sends picks: it sends no `df1Ack`, so it is never sent `df1`; the
   DF1 choice is disabled with "Needs firmware 1.12.0".
5. A deleted or no-longer-entitled picked disk: the board's fetch gets 404 and blocks that digest on the pick route
   only; the card says why DF1 is empty.
