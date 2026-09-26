# webadf — session handoff

**Written 2026-08-29, updated 2026-08-30 after plan 3b, updated again 2026-08-30 after
plan 4a, updated again 2026-08-31 after plan 4b.** Everything a fresh session needs to pick
this up cold. Read this first, then the spec, then the plan you are resuming.

---

## What this project is

A web app that stores an Amiga floppy-disk library and mounts disks to real Amiga
hardware over WiFi. You upload ADFs; each unique disk is stored once, keyed by its
SHA-256; you browse them and press mount; a custom board emulates the floppy drive.

**Live:** https://webadf.vercel.app · **Repo:** `stefanskotte/webadf` (private)

---

## Where things stand

**Written 2026-08-29; table re-checked row by row against git and the board on 2026-09-25.**

| | Status |
|---|---|
| **Plan 1 — foundation & library** | ✅ merged to `master`, in production |
| **Plan 2 — device plane** | ✅ tasks 1–4 done; **6–8 superseded** by plan 3a, not pending |
| **MFM encoder (`adfmfm`)** | ✅ **done** — byte-identical to Greaseweazle across all 61 archive disks (9,760 tracks) |
| **Plan 3a — device protocol** | ✅ done, merged to `master`, pushed |
| **Plan 3b — device UI** | ✅ **done, all 7 tasks, merged to `master`** |
| **Plan 4a — firmware protocol plane** | ✅ **done, merged to `master`, pushed.** Firmware compiles and has a green host suite. |
| **Plan 4b — captive portal** | ✅ **done, all 8 tasks.** Compile-time WiFi/pairing-code defines are gone, replaced by an AP-mode portal. Merged to `master` and pushed. |
| **Plan 5 — hardware bring-up** | ✅ **done on rev A2.** Portal, TLS, pairing, mount/eject, OLED, LED; the Amiga reads (WB3.1 boots), writes, and a second drive (DF1) works via SEL0 gating; see 3x, 3y, 4b–4e |
| **Super-admin plane** | ✅ **done, all 6 tasks, merged to `master` and live in production.** `/admin`: overview, user list with cascade delete, invites |
| **TOSEC identity scan** | ✅ **done, 12 tasks, merged to `master`.** `/admin/scan`: DAT import, hashing, matching, backfill |
| **OpenRetro enrichment** | ✅ **done, all 9 tasks, merged to `master` and live in production.** Enriches 6.6% of the real archive against TOSEC's 45.9%; see 3d |
| **e2e cleanup** | ✅ **done, merged and live 2026-09-01.** A run no longer leaks; 4,600 accumulated rows and 73 live invite codes swept; see 3e |
| **User-defined collections** | ✅ **done, all 9 tasks, merged to `master` and live in production.** A rail on `/library`, drag to file and to reorder; migration 0011 applied; see 3g |
| **Library covers, type pills, contrast** | ✅ **done, merged and live 2026-09-01.** Grid shows real cover art; grid and table both show a TOSEC-derived type; the grey ramp now passes WCAG AA |
| **Firmware updates (OTA) — CLOSED** | ✅ **done and closed 2026-09-25.** Registry (3ai), server half 2a (3aj, merged 2026-09-22) and board half 2b (3ak, merged 2026-09-23): select boards, press Update, confirm with the password, the board downloads a signed image into its other slot and confirms on boot. Used for real to ship 1.1.4 (seq 8) and 1.2.0 (seq 9). **Operator ruling 2026-09-25: the password-to-update flow is the finished feature** — no auto-update opt-in, no further increment |
| **Firmware release registry** | ✅ **done 2026-09-22.** The version identifies a build and is refreshed on every heartbeat; `firmware_releases` + `/admin/firmware`; Devices says which boards are behind; see 3ai |
| **Shell polish** | ✅ **done 2026-09-02.** The "/" hint, both navs centred on the viewport, zebra-striped file tree, and a navigation bar + scrim; see 3i |
| **Mobile responsive** | ✅ **done 2026-09-02, all surfaces.** Usable at 390px; nav becomes a bottom bar, touch drag no longer eats scrolling; see 3j |
| **Delete a title or a disk** | ✅ **done 2026-09-04.** Confirmation dialog, deliberate eject, blob never destroyed; see 3o |
| **Disk space on the browse page** | ✅ **done 2026-09-04.** Read from the allocation bitmap, agreeing with xdftool on 46 of 46 real disks; see 3p |
| **Create a blank ADF** | ✅ **done 2026-09-03.** A real formatted disk from a button, named inline; migration 0013 applied; see 3n. File add/edit/delete is NOT part of it |
| **Create ADF is one menu** | ✅ **done 2026-09-04.** One dropdown with FFS and OFS items replaces the sticky select plus button; the filesystem is no longer remembered between disks; see 3t |
| **Files inside an ADF** | ✅ **done 2026-09-04.** Add, delete, rename, replace contents, make and remove directories, through the browse page; every operation checked against xdftool rather than against our own reader; see 3u |
| **Drop a folder in, drag to rearrange** | ✅ **done 2026-09-05.** Drop from the OS into a staging area that checks fit in BLOCKS before writing; one commit, one blob; drag or keyboard to move entries between folders; see 3v |
| **Deleting the last disk no longer 404s** | ✅ **done 2026-09-05.** Navigates on the server's own `gameDeleted`, replaces rather than pushes, and goes where the breadcrumb points; see 3w |
| **Drag and drop inside an ADF** | ✅ **done 2026-09-05, all 11 tasks, merged to `master` and live.** Drop a folder from the OS to stage and batch-commit it as one blob; drag or keyboard-move an entry between directories; a cycle refusal our own reader cannot see the need for; see 3v |
| **Edit a title by hand** | ✅ **done 2026-09-03.** Per-group authority, and a scan never silently undoes an edit; see 3m |
| **Unified breadcrumb** | ✅ **done 2026-09-03**, and 2026-09-04 it follows the collection you came from; see 3l and 3r |
| **Image layout shift** | ✅ **done 2026-09-03.** The game page's cover and screenshots reserve their space; the library grid never had the bug; see 3k |
| **Typeahead search** | ✅ **done, all 7 tasks, merged to `master` and live in production.** A Spotlight-style pill in both shells; migration 0012 applied; see 3h |
| **Read-only ADF filesystem reader** | ✅ **done, all 10 tasks, merged to `master` (`src/lib/adffs`).** Reads 80.3% of the archive (49/61) against TOSEC's 45.9% and OpenRetro's 6.6%; see 3f |
| **Demozoo identification** | ✅ **done 2026-09-14, all 16 tasks, merged to `master`.** Complements TOSEC for non-games: weekly import, nightly matching, automatic links, suggestions, review queue, screenshots; see 3af |
| **Write-back piece 3 — the time machine** | ✅ **done 2026-09-21, merged to `master`.** History panel on every disk page: what changed per version, Browse read-only, Restore as a new version. **Restore passed on hardware 2026-09-22** (DB-confirmed rewind of v10 as v12); see 4l |
| **Write-back piece 2b (board)** | ✅ **done 2026-09-19, verified on hardware.** Amiga saves upload, close and land on the server as history versions, including offline and eject-right-after; keep-alive connection (4k). Two paths never yet run on the board: a multi-file save burst over keep-alive, and `up_forces_wprot`; see 4i–4k |
| **Write-back piece 2a (server)** | ✅ **done 2026-09-18, 5 tasks + final fix wave, merged to `master`.** Disk history tables, browser edits and renames recorded as versions, `POST /api/device/write` + `/close`, live write-protect; see 4g |
| **HFE v1 disks** | ✅ **done 2026-09-24, merged and live; bench-proven 2026-09-25.** Upload keeps the `.hfe`, the board plays it read-only, "Extract as ADF" when every sector decodes. Long-track HFEs (fw 1.2.0, 14 KB tracks, per-board `trackMaxBytes`): **Turrican boots on the Amiga**; extract round trip passed byte-exact. Only the weak-bit bench item is owed (needs a weak-bit HFE). A cylinder-17 hang after a disk swap is parked; see 3al, 3al-a |
| **NFC tap-to-mount** | ✅ **merged and live 2026-09-26 (master 0f6fbd1); firmware 1.3.0 (seq 10) confirmed on the board.** Tap a tag → the board mounts that disk from its own org's library (swap; same tag = no-op; 1 s rate limit). Claude writes tags: `pnpm nfc:write "<disk>"` arms the board through the poll, you tap a blank tag, the read-back is reported. HW-147C/Si512 reader on I2C1 (0x28). **Firmware 1.3.1 (seq 11, 2026-09-26): a tap needs 3 s of absence; a write never lands on a tag already on the reader.** Bench: write + tap-mount + same-tag proven; see §3am. **Fob button (2026-09-26, b6c4e7c):** an NFC icon on every library card and disk row writes that disk to a tag from the web (dialog picks disk and board, 2:00 countdown, read-back shown; withdraws on close/cancel/leave); shown only when a board reports a reader |
| **Drive chips in the header** | ✅ **done 2026-09-25, merged and live.** Every paired board as a chip beside the wordmark: status dot, name, mounted disk; caret menu with Go to disk (the game page), Disk is Protected/Writable, and Eject (no confirm, below a divider). Pending states while a mount or eject converges. 1 chip + "+k" at 1280, 2 at 1536, 3 at 1920; below 1280 a single "Drives" list. Fed by `liveStateRows` (now carries the mounted game/title/disk no/format, all in `liveFingerprint`); `src/lib/drive-chips.ts`, `src/components/shell/drive-chips.tsx`. Unverified: 640–700 px the Drives button overlaps the pill (the search box already does, 640–767 px, on master). **2026-09-26 (`b40699c`): the chips are centred in the gap between the wordmark and the pill** (`src/components/shell/header-start.tsx` measures the pill's width; equal gaps at 1280/1536/1920, with and without Admin), and the "+k" chip shows one number at ≥1920 (a Tailwind breakpoint-order bug had shown "+2 +1") |
| **Five minors, 2026-09-25** | ✅ **merged and live.** Update confirm is a real modal (role=dialog, Escape, focus, Enter submits); the 50-board cap (`MAX_UPDATE_BATCH`) shows in the update bar; re-extracting an EDITED extract is a 409 `already_extracted` with a link; the not-extractable reason is visible text; a refused HFE's bytes are deleted when nothing references them (a two-round-trip race is documented in `releaseRefused`) |
| **Hardware** | rev A scrap (mirrored), **rev A2 in hand and working**. **Rev B is Shanshe's KiCad project, merged 2026-09-26 (PR #1, `22d3556`) and now the primary PCB** -- the generated-board toolchain (`generate_pcb.py`, `verify_board.py`, `export_gerbers.py`, renders) is gone. `pnpm hw:verify` (`wifi-floppy/hardware/hw_verify.py`) runs KiCad ERC/DRC + parity and checks the netlist against the firmware and §4c. **PR #2 (2026-09-26, `d871430`): `hw:verify` PASSES** -- 1k pull-ups to +5V on all eight host-driven lines (WGATE, WDATA, MTR, DIR, STEP, SIDE, SEL0, SEL1), power flags fixed, J2 moved 0.1 mm to clear U1's RF keepout (keepout zones verified unchanged; J2 now sits right at its edge); the assembly BOM (DNP flags, LCSC numbers) is for the operator to complete when sourcing; GP20 (NFC reset) is not wired. See the rev B entry in §4 |

**Current branch (2026-09-25):** `master`, clean and pushed; everything in the table is merged
and live. The board runs firmware `1.2.0+ge8ac726` (seq 9). **No increment is in flight.**

**Owed at the bench:** NFC tap-to-mount acceptance (§3am). **Still open, none started:** the HFE weak-bit bench item; the two hardware-untested write-back
paths (2b row); the super-admin audit log; the rev B respin (with Shanshe); NFC (designed later,
tag writing is a Claude-driven USB tool). **Suite on master 2026-09-25: 1,101 vitest, build clean,
362/362 Playwright (1.1 h), run alone on the database.**

*Historical (2026-09-03 onward), kept for the record:* the write-protect flip on a mounted disk
was built in 4j. The suite counts below are from 2026-09-14; the full suite is now **349
Playwright tests, ~1.1 h** (2026-09-24) — run it on port 3100 with a dev server you start
yourself, logged to a file.
**Suite on `master`:** 821 vitest (1 skipped), `pnpm build` clean, **256 Playwright** — 247 desktop at
1280×720 and 9 mobile at 390×844 (measured 2026-09-14 before the Demozoo merge: a full run
passed 250; the 6 failures were a missing `adf-archive/` in the worktree and two TOSEC tests
whose real-demo fixture Demozoo now links, fixed with Games set names, and those three spec
files then passed 16/16). `playwright.config.ts` has two projects. **A git worktree has no
`adf-archive/`** (it is gitignored): symlink the main checkout's before running e2e there.

**Known flake shape, so nobody debugs it twice:** the first two or three tests of a cold run can
time out at the 30s per-test limit while Turbopack compiles a route for the first time —
observed as `apiRequestContext.post: Test timeout` on `/api/ingest/complete`, and as
`signUpFresh` never reaching `/library`. Both pass in isolation and on a warm re-run. Before
concluding a regression, **re-run the failing spec alone**; if it passes, that was this.

**A third, and it cost two hours on 2026-09-03: a killed run ORPHANS its dev server.**
`playwright.config.ts` sets `reuseExistingServer: true`, so the next run adopts whatever is
holding port 3000 -- including a wedged process that never answers HTTP. The run then waits
forever with **no output at all**, which reads exactly like a slow cold compile. The tell is
`ps -o etime,time`: hours of elapsed against under a second of CPU, and no
`chrome-headless-shell` process ever started. **After killing a run, kill `next dev` and
`next-server` too**, and check `lsof -iTCP:3000` is free before restarting.

**Its sibling: do not start a spec while the previous run's teardown is still going.**
`globalTeardown` sweeps every test user by email domain, and it keeps running after the last
test reports. A spec launched into that window has its freshly signed-up user deleted
underneath it, which shows up as several tests in one file failing in ~500ms each — a cascade
that looks alarming and is nothing. Observed 2026-09-03. Wait for the teardown line
(`teardown: removed N test users...`) before re-running anything. Firmware: `pnpm firmware:test` green (2,467 checks, 13
binaries), `pnpm firmware:build` produces a `.uf2` — **and now requires
`PORTAL_AP_PASSWORD` set in the environment, or the configure step fails by design**; see
"Plan 4b" below for the full command.

*(2026-08-31 text, superseded: plans 4a and 4b have since run end to end on a real board —
see the table above.)*

### Before you touch the device UI

The rulings taken during 3b are in `docs/decisions/2026-08-30-device-ui-rulings.md`. Read it
before touching the mount action or the queries — it records why the multi-device picker is an
inline expansion rather than the dropdown the spec originally specified, and that is the
decision most likely to look arbitrary later. Both points are also summarised under "What to
do next" below, because both have been rediscovered the hard way once already.

### What 3a and 3b built

Desired-state reconciliation, not a job queue. `devices` carries what a human asked for and
what the device reported, separately and on purpose. Three device endpoints —
`GET /api/device/poll` (25 s long-poll), `GET /api/device/image/<sha256>` (WFMF, encoded on
demand), `POST /api/device/status` — plus human-facing mount, eject and write-protect. Two
pages that previously 404'd, `/devices` and `/games/[id]`, now exist.

## The thing that changed mid-flight — read this before anything else

The target hardware was redesigned during plan 2. It is no longer an ESP32 dongle
presenting USB mass storage to a Gotek. It is now a **self-designed RP2350 board**
(Pimoroni Pico Plus 2 W core) in `wifi-floppy/` that **emulates the floppy bus
directly** with PIO. There is no Gotek in the path at all.

Recorded as spec decisions **D14, D15, D16** (commit `2d81dd8`). **D5 is superseded**;
D10's *mechanism* is superseded but its "one disk at a time" property still holds.

What that invalidated:

| Old assumption | Reality |
|---|---|
| Serves raw ADF (901,120 B) | Serves **pre-encoded Amiga MFM**, ~2 MB, `WFMF` container |
| Device fetches a presigned Vercel Blob URL | Device fetches `GET /api/device/image/<sha256>` **from webadf** |
| Server does no encoding | Server **must implement an Amiga MFM encoder** |
| Long-poll returns a blob URL | Poll returns the image *identity*; the image is a separate fetch |

The format is defined by `wifi-floppy/firmware/src/image_loader.c` and documented in
`INTEGRATION.md`. The firmware and hardware trees were moved into this repo precisely
so the format and its encoder cannot drift apart.

---

## What to do next, in order

### 0. Two invariants in the 3b code that look like cruft and are not

Not a task — a warning, first because both are one refactor away from being undone:

- The multi-device picker is an **inline expansion, not a dropdown**, though spec §4
  originally said dropdown. A dropdown was built and measured to have a wrong-target bug —
  the open popup covered the next row's Mount button, so clicking what looked like disk 2's
  Mount silently mounted disk 1. `modal={true}` does not fix it (`MenuPositioner`'s `z-50`
  is unconditional) and neither does any placement. Do not "restore" the dropdown.
- `listDevices`'s org-scoped join on `games` is **preventing a live cross-tenant leak**.
  The production database holds three devices whose `desired_game_id` belongs to another
  organization — leftover e2e data, and that column has no foreign key. Removing the
  predicate puts a foreign title on the page. There is a test for it; do not weaken it.

### 1. Plan 4a — done. Read this before touching firmware.

Plan 4a shipped (merged to `master`):
mbedTLS with a provisioned bearer token per D16, the full §10 device-contract state
machine, two-slot PSRAM with fetch-before-transition, and both recorded firmware defects
fixed (`TRACK_SLOT_BYTES`/`TRACK_MFM_MAX` collapsed into one `TRACK_MAX_BYTES`; `bits` now
bounded before the `(bits + 7) / 8` arithmetic in `image_loader.c`). `http_fetch.c`/`.h`
— the old plaintext, path-addressed, credential-less fetcher — are deleted.

Full detail, including what got deferred and the rulings taken along the way, is in
`docs/superpowers/specs/2026-08-30-device-firmware-protocol-design.md`'s "What plan 4a
delivered" section and in "Before you touch the firmware again" below.

**Build and test commands (see also "Commands" at the bottom):**

```bash
# Both of these, copy-pasteable, from the repo root. The two exports are
# required for the BUILD, not the tests: plan 4b made PORTAL_AP_PASSWORD a
# hard CMake FATAL_ERROR (an empty WPA2 PSK cannot be reported back to a
# console-less board at runtime, so it is refused at configure time), and
# homebrew's arm-none-eabi-gcc ships no newlib and will not link.
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
export PORTAL_AP_PASSWORD=<any WPA2 PSK, 8-63 chars>
pnpm firmware:build   # also needs pico-sdk >= 2.3.0 checked out (PICO_SDK_PATH).
                      # If configure behaves oddly, rm -rf wifi-floppy/firmware/build.
pnpm firmware:test    # plain C under clang, no toolchain/SDK/env vars needed --
                      # 506 checks across 13 binaries (measured, plan 4b final)
```

**`src/lib/adfmfm/firmware-parser.ts` no longer mirrors the bit-count-overflow defect** —
it was fixed in the same change as the firmware fix, and the mirror was updated with it.
Older guidance (in this file and in the design spec) said never to "fix" that mirror; that
instruction was correct only while the firmware was actually broken, and is now inverted.
Do not reintroduce the wrapped-`bits` behaviour into the mirror.

### 2. Plan 4b — done. Read this before touching provisioning.

Plan 4b replaced the compile-time `WIFI_SSID`/`WIFI_PASS`/`WEBADF_PAIRING_CODE` defines
with an AP-mode captive portal. **`WEBADF_HOST` stays compile-time, deliberately** — it
changes only if the deployment itself moves, and making it portal-editable would let anyone
who reaches the AP point a board at a server of their own choosing, which is a real attack
surface nobody needs.

**How it works:** a board with no stored credentials, or one that fails to associate three
times in a row, raises a WPA2 access point named `wifi-floppy-XXXX` (the board's last two
MAC octets). Joining it and opening any page serves a config form asking for SSID, password
and a webadf pairing code. Credentials are verified before anything is written to flash: the
AP drops, the board attempts association with what was typed, and only success triggers a
flash write — on failure the AP comes back with the reason, distinguishing a wrong password
from a network that was not found. Storage is `config_store`, a dedicated CRC-protected
flash sector below `token_store`'s; erasing it also erases the device token, since re-pairing
always issues a new one. A rejected pairing code, a revoked token, or a device deleted in the
web UI all now return the board to the portal rather than requiring a reflash — see
`docs/decisions/2026-08-31-device-portal-rulings.md`'s "Ruling 8" section for how that last
behaviour was added, and for a real fleet-wide regression it introduced and was then
corrected to avoid.

**The portal is not a one-way door.** If the board still has a usable configuration in flash
(it got there by failing to associate three times, not by a rejected pairing code), the AP
comes down after **five minutes with no client traffic at all** and the stored credentials
are re-tried; if those fail their three attempts again, the AP comes back, and so on. That
is what stops a power cut which drops the router and the board together — board boots first,
burns 45 s of attempts while the router is still starting — from parking a board in AP mode
until someone turns up with a phone. The window is inactivity, not a wall clock: any DHCP,
DNS or HTTP packet restarts it, and it is never even evaluated while an HTTP connection is
open, so nobody filling in the form is cut off. With nothing stored to re-try, the wait is
indefinite by design. Constant is `PORTAL_IDLE_TIMEOUT_MS` in `src/portal_net.h`.

**Two spec sections were corrected in place** (not just amended in the delivered-section
addendum) by the final pre-merge review: **§2**, because `main.c`'s `DC_HALTED` recovery
ejects a mounted disk before dropping to the portal, so the old absolute "a board that is
already serving a disk never drops into the portal" was false — §2 now states the rule as
"never *spontaneously*, with one deliberate ejecting exception" and names it; and **D-4b-1**,
for the bounded wait above. §2 is the invariant plan 5 will be read against, so read it
there, not here.

**New build prerequisite:** `PORTAL_AP_PASSWORD` (the provisioning AP's WPA2 PSK) must be
set in the environment, or CMake's configure step fails by design — an empty PSK cannot be
reported back to a console-less board at runtime, so it is refused at build time instead.
The full build incantation is now:

```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
export PORTAL_AP_PASSWORD=<your AP password>
pnpm firmware:build
```

Full detail — what shipped, what changed shape mid-plan, and what plan 5 still owes — is in
`docs/superpowers/specs/2026-08-30-device-provisioning-portal-design.md`'s "What plan 4b
delivered" section and in `docs/decisions/2026-08-31-device-portal-rulings.md`.

### 3. Plan 5 — hardware bring-up, the only piece left

Once boards arrive. **Nothing in plan 4a or plan 4b has run on real hardware** — no TLS
handshake, no SNTP sync, no floppy-bus timing, and none of the AP-mode portal's lwIP/cyw43
glue has ever been exercised outside the host suite and the cross-build. Treat every claim
about TLS, timing, the floppy bus, or the portal's radio behaviour as desk-checked and
host-tested only, not hardware-verified, until plan 5 says otherwise.

**SUPERSEDED 2026-09-10 -- READ 3y FIRST.** A rev A2 board has now provisioned itself,
registered with production and run the poll loop. Every bullet below except the floppy-bus
and Android ones is ANSWERED there, and answering them took three fixes (an lwIP timeout-
pool panic, an unparseable root CA bundle, and the logger's own two in 3x). The list is
kept as written because it is what the bullets were before the board ran, and because 3y's
answers only mean something against it. Specifically open, carried forward verbatim from
plan 4b's ledger:

- Whether `netif_default` is really restored to STA (not left NULL) after the provisioning
  AP tears down, and TLS to webadf actually succeeds afterward — the entire point of a
  Critical fix in plan 4b that has never been run.
- Whether the confirmation page physically leaves the radio before AP teardown.
- STA DHCP lease acquisition/renewal after the AP netif has been removed.
- Real phone captive-portal behaviour against the portal's 2-lease DHCP pool
  (`DHCP_POOL_SIZE`) and its 3 concurrent HTTP slots (`MAX_HTTP_CONNS`), including
  MAC-randomization retry storms and the ~30 s idle reclaim.
- Whether the iOS and Android captive-portal probe URLs actually trigger the sign-in sheet
  on real devices.

### 3b. Super-admin plane — DONE, all 6 tasks

**Branch `feat/super-admin`, complete and green: 256 vitest, 107 Playwright, `pnpm build`
clean.** Not merged to `master` yet. Rulings, deviations and mutation results are in
`docs/decisions/2026-08-31-super-admin-rulings.md`; the spec carries a "What this plan
delivered" section.

An operator-only plane at **`/admin`** — an overview of unscoped counts, a paginated user list
with a real cascade delete, and invite issue/revoke. Identity is an env-var email allowlist
(`SUPERADMIN_EMAILS`), deliberately outside the database so a database compromise cannot grant
it. There is an **Admin** entry in the app's top nav, rendered only for an allowlisted user.

**The bootstrap sequence, and it is security-relevant in this order:**

1. ~~The operator signs up and claims `sfs@enhance-it.dk`.~~ **DONE 2026-08-31** — the account
   exists (role `owner`), so the unique constraint on `user.email` protects that address
   permanently. This had to come first: `emailVerified` defaults to false and nothing enforces
   it, so an *unclaimed* allowlisted address is a prize.
2. ~~Revoke the invite codes that leaked into a session transcript.~~ **DONE 2026-08-31** —
   `M3W4V3BA` was consumed by step 1; `56DTUDMA`, `HXGMH4ZK` and `K69GXH72` were deleted.
3. ~~`vercel env add SUPERADMIN_EMAILS production` → `sfs@enhance-it.dk`, then redeploy.~~
   **DONE 2026-08-31.** The variable is set (Secret, Production only), the branch was merged
   fast-forward to `master`, and the push deployed to production —
   `webadf.vercel.app` → `webadf-eo0n3qmtc`, `target: production`. **The operator has confirmed
   `/admin` works for `sfs@enhance-it.dk` in production.** An unset variable would have denied
   everyone rather than allowing them, so this always failed closed.

`.env.local` needs `SUPERADMIN_EMAILS=admin@example.test` for local dev and e2e — a *different*
value from production, deliberately (Ruling 1). A single shared value would either put a test
account in production's allowlist or leave the e2e unable to sign in as an admin.

**Two things worth knowing before you touch it:**

- **`src/lib/superadmin.ts` is the only file that may read `SUPERADMIN_EMAILS`**, and
  `src/lib/admin-queries.ts` is the only place unscoped queries live. Every other query in this
  codebase goes through `orgFilter()`; these deliberately do not, and the quarantine is what
  makes that visible in review rather than invisible in a diff.
- **A non-admin is redirected to `/library`, never 404'd.** The response must not confirm
  `/admin` exists. That is also why the nav link is gated server-side rather than rendered for
  everyone and hidden with CSS.

### 3c. TOSEC identity scan — DONE, on `feat/tosec-scan`, not merged

Identifies stored disk images by content hash against imported TOSEC data and corrects the
catalog's filename-derived titles. Spec: `docs/superpowers/specs/2026-08-31-tosec-identity-scan-design.md`.
Plan: `docs/superpowers/plans/2026-08-31-tosec-identity-scan.md` (11 tasks + a 12th added mid-flight).

**The measured result, which is the point of the whole increment: TOSEC recognises 28 of the
operator's 62 archive disks — 45.2%.** 55,932 entries are loaded from all seven Amiga `[ADF]` sets.

**Do not quote the database's own miss rate.** The blob corpus is dominated by e2e-generated
content with convincing TOSEC-style filenames, plus 129 blobs whose bytes were never in the object
store. Over that corpus the figure is 9.7% and it means nothing. Measure against a real archive
and exclude `unreadable`.

**The misses invert the spec's own argument about what to build next** — they are Workbench,
system and utility disks (`Install3_1_4.adf`, `Locale.adf`, `WHDLoad185.adf`, `Real_Amiga_Install.ADF`),
not games. Those are OFS/FFS disks a filesystem reader *can* read. See the spec's "What this
increment delivered" before planning the disk-content reader.

**Operator runbook:**

1. Download the Amiga TOSEC DATs. The complete pack holds 4,743 files for every system; only the
   seven `[ADF]` sets can ever match an ADF. The pack ships **Logiqx XML** despite every filename
   ending `_CM`.
2. `/admin/scan` → choose files. The input takes **several DATs at once**; they import
   sequentially and one bad file is skipped rather than aborting the run.
3. **Import everything first, then press Run now ONCE.** Each import clears every blob's match
   verdict, so sweeping between imports repeats a full re-match for nothing.
4. Press **Run now** until `unchecked` reaches 0. Each pass is bounded (~240 s) and resumable;
   the nightly cron at 03:00 continues on its own.

**`CRON_SECRET` is set in Vercel production** (2026-08-31). The cron route fails closed without it.

**Two known gaps, both found by the final review's own re-review and deliberately not fixed:**

- **A permanently-failing blob makes the sweeper hot-loop forever.** Phase 2 catches a per-blob
  error, logs it and moves on — deliberately *without* stamping `match_checked_at`, because a
  match failure is usually transient and stamping would misclassify it as decided. But once every
  other blob has drained, `todo` degenerates to just that blob, and every `sweep()` — cron and Run
  now alike — retries it for the whole 240 s budget and never reaches `done: true`. Nothing is
  corrupted; it simply never finishes and hammers the database nightly. The fix, if it ever fires,
  is a bounded retry or a distinguishable `match_state = 'error'` after N attempts. Watch for a
  `tosec-sweep: match failed for blob <sha>` line repeating in the logs.
- **`recordStatus()` in `src/lib/mount.ts` resolves a disk to its game using `disks.orgId` alone**,
  not double-scoped against `games.orgId` the way `src/lib/queries.ts` is. Since the merge now
  *preserves* org-drifted disks rather than letting the cascade delete them, the population of
  such rows grows rather than shrinks. `listDevices`' defensive join still stops a foreign title
  rendering, so this is the same already-tolerated class as the recorded "3 leftover devices",
  not a new leak — but it is worth a hardening pass.

**Things that will bite you here:**

- **NEVER re-derive `games.id` or `disks.id`.** `disks.id` descends from `games.id`, and
  `devices.desiredDiskId` is plain text with no foreign key that `readDesired` joins on. Re-keying
  makes that join return nothing, and in this protocol "no disk desired" **is eject** — a metadata
  scan would silently eject disks from real hardware, which disk-change spec §1 rule 1 forbids.
  Duplicates are merged on `(sortTitle, year)` instead, and `e2e/tosec-scan.spec.ts` has a test
  whose whole job is to catch a regression here.
- **Never clear a blob's hashes.** Both match resets touch only `match_checked_at`/`match_state`/
  `tosec_entry_id`. Hashing means re-reading every blob out of the object store; a content hash
  never changes.
- **`applyMatch` must run before the blob is stamped**, not after. Stamping first and failing
  leaves a blob permanently marked matched with the catalog never rewritten, and the sweeper's
  cursor never revisits it.
- **A human-edited game is never retitled *or merged away*.** `MACHINE_SOURCES` is `['filename',
  'tosec']`; anything else — including `NULL` — is protected, and two protected duplicates abort
  the merge rather than choosing between two human decisions.
- **`seedDisk()` must set `metadataSource: 'filename'`** to mirror real ingest. It once did not,
  and the resulting NULL is a row shape the app never produces, which silently made every
  TOSEC correction impossible in tests.
- **`stableId('tosec', setName, romName)` collides across tests reusing a set name.** That
  silently dropped one test's fixture via `onConflictDoNothing`. Give each test a distinct set name.
- **4 of 221 Amiga DATs contain duplicate rom names** (`Games - SPS` has 672 in 6,016), so the
  importer dedupes by id before upserting. Without it Postgres aborts the whole import.
- **Running the e2e suite globally invalidates the scan state.** `admin-scan.spec.ts` drives a
  real DAT through `/api/admin/tosec`, and `importDat()`'s reset is unscoped BY DESIGN (see the
  comment on that reset) -- it clears `match_checked_at`/`match_state`/`tosec_entry_id` on every
  blob with a verdict, not just the ones that DAT actually touches. So every suite run hands the
  whole blob corpus back to the sweeper: `unchecked` jumps from 0 to the full count, and the
  operator will see the scan "un-finishing" itself with no scan of their own having run.
  `cleanupTosec()` removes the e2e-seeded `tosec_entries` rows afterward, but it cannot restore
  the verdicts that reset threw away -- those are only recovered by pressing Run now again.

### 3d. OpenRetro enrichment — DONE, on `feat/openretro`, not merged

Enriches games with OpenRetro's publisher, developer, players, tags, chipset, prose and images,
matched by the SHA-1 the TOSEC scan already stores on every blob. Enrichment is **phase 3 of the
existing sweeper**, so it inherits the budget, cursor, cron and admin page.
Spec: `docs/superpowers/specs/2026-08-31-openretro-enrichment-design.md`.
Plan: `docs/superpowers/plans/2026-08-31-openretro-enrichment.md` (9 tasks).

**The measurement this increment exists to produce, and it is a disappointing one:**

| | disks recognised | rate |
|---|---|---|
| **TOSEC** | 28 / 61 | **45.9%** |
| **OpenRetro** | 4 / 61 | **6.6%** |

Measured exactly as TOSEC's 45% was — hash every local ADF in `adf-archive/`, look the SHA-1 up
directly. **OpenRetro knows nothing TOSEC does not**; it is a strict subset on this archive. The
4 disks are all Project-X (1992)(Team 17) and resolve to a single game. 33 disks neither knows.

**Why, and it is structural rather than bad luck.** A variant's `file_list` holds 418,539 files
across the real sync but only 19,483 are named `*.adf`; 190,425 have no extension at all, because
they are the individual files inside a WHDLoad install. OpenRetro's strength is file-level WHDLoad
content, not whole-disk ADF dumps. Only **14,850 of 175,282 distinct sha1s are ADFs**, so 92% of
the index could never match anything this app is able to store — the importer now filters to
`*.adf` for exactly that reason, which cut the table from 194,913 rows to 14,866 and the import
from 120 s to 13 s while losing no coverage.

**The lever nobody has pulled: match on TOSEC identity, not content hash.** 28 archive disks carry
a canonical TOSEC title and year, and OpenRetro holds 3,697 named games. Matching on identity
rather than digest would plausibly reach most of them instead of four. It trades exactness for a
title match, so it needs its own design and its own ambiguity rules — but it is the single change
that would make this increment pay for itself. The operator was shown the 6.6% and chose to ship
as built and record it, rather than expand scope here.

**Measured storage cost:** the one reachable game stored **7 images totalling 1,498,148 bytes
(1.43 MB)** — a 393 KB cover plus a title screen and five screenshots, averaging 214 KB each.
That is the `?size=400` resize doing its job; at full resolution the cover alone was ~1 MB.
Extrapolating, a library where OpenRetro recognised everything would cost roughly 1.5 MB per
title. The admin page shows the running total in MB so it never becomes a surprise.

**Two caveats that will mislead someone later:**

- **`openretro_images.sha1` does NOT verify the stored bytes.** It is OpenRetro's digest of the
  FULL-SIZE original, while what is stored is the `?size=400` resize — different bytes entirely.
  That inverts this codebase's usual rule, where `blobs.sha256` is re-read and re-hashed to prove
  the store holds what it claims. Here the digest is an identifier only, and anything that tries
  to "verify" an image against it will fail every row.
- **The e2e suite really does fetch from openretro.org**, despite no test asking it to. The specs
  seed their own data and never reach a third party — but `/api/admin/scan` sweeps the WHOLE live
  database, which now holds the real 3,697-entry import, so any spec that presses Run now enriches
  the real blobs and fetches their images. It is self-limiting (they are stamped afterward and
  images are never re-fetched) and it cost 7 images once. Re-importing `Amiga.sqlite` resets every
  enrichment verdict and will make it happen again.
- **The same `/api/admin/scan` sweep also runs the Demozoo match and screenshot phases, and
  the screenshot phase really does fetch from media.demozoo.org** (see 3af) — same shape as the
  OpenRetro caveat above: any e2e spec that presses Run now over the live database walks the
  Demozoo phases too, within the existing 60/hour politeness cap. 28 images were stored this
  way on 2026-09-14.

**Operator runbook:**

1. Run FS-UAE Launcher once and let it sync, producing `Amiga.sqlite`.
2. `/admin/scan` → **Import OpenRetro metadata**. One file; a full import takes ~13 s.
3. Press **Run now** until `enrich-unchecked` reaches 0. Image fetching is capped at 40 per run
   by design, so a first pass over a large library takes several runs or several nights.

**Things that will bite you here:**

- **`_type` is the STRING `"1"`/`"2"`, never the number.** A `=== 1` comparison matches 0 of
  21,440 rows. The plan's own fixture wrote numbers, so its test passed while the real file
  yielded nothing at all — the reader was only correct once it was run against `Amiga.sqlite`.
- **`game.data` is zlib-DEFLATE (`789c`), not gzip.** A gunzip-based reader throws.
- **`game.uuid` is a 16-byte BLOB; `parent_uuid` inside the JSON is a hyphenated string.**
  Without converting between them every variant silently orphans and nothing ever matches.
- **Screenshots 6-8 are `__screen6_sha1`**, with a leading double underscore. 415 games have them.
- **`?size=400` resizes server-side** (381,535 bytes versus 1,029,484). **`?width=` is silently
  ignored** and serves full size; `?w=` returns 500. Getting the name wrong costs 3x the storage.
- **The Blob store is PRIVATE.** `access: 'public'` is refused outright — "Cannot use public
  access on a private store" — and making it public to suit cover art would make every ADF in it
  publicly addressable, which is the boundary `/api/device/image` exists to enforce. Images are
  stored private and streamed by `/api/images/<sha1>`; no presigned URL ever reaches the DOM.
- **A broken `<img>` is still a visible element.** The first version of the image e2e passed
  while every single image fetch was failing. A test that asserts on an image must also assert
  the route serves the bytes.
- **`hol_url` is on the parent record** (3,634 of 3,697 entries), so a later Hall of Light
  increment gets an exact id and needs no title matching at all.
- **`metadataSource` is never written by enrichment.** It owns row IDENTITY, which is still
  TOSEC's; stamping it `openretro` would lock TOSEC out of correcting the title forever.
  `factsSource`/`proseSource` record what enrichment wrote without claiming the row.

### 3e. The e2e suite now cleans up after itself — DONE 2026-09-01, merged and live

**`e2e/global-teardown.ts`, wired into `playwright.config.ts`.** Before it, one suite run left
~70 users, orgs, games and disks in the live database permanently, and **4,600 rows had
accumulated since 2026-08-23**. A full run now leaves the database exactly as it found it.

**Backfilled once:** 4,601 test users, 66 games, 4,201 invites, 72 blobs and 72 stored objects
removed; 485 stale admin sessions cleared. The operator's account and its 5 games were verified
intact before and after. Baseline is now 2 users, 5 games, 10 disks, 10 blobs, 0 live codes.

**The security-relevant half was the invite codes, not the row count.** Registration is
invite-only — that is what bounds the ingest existence oracle (D13) — and **73 unconsumed,
unexpired codes were live**. Neither population was reachable by any cascade: 4,144 were minted
under placeholder org ids that no `auth.organization` row matches (`mintInviteCode` uses
`e2e-seed-org`, because its callers have no org yet), and 14 belonged to the kept
`admin@example.test` account, which survives on purpose so its invites survived with it. The
teardown matches on **"the org does not exist"** rather than a list of known placeholder names,
so a future helper inventing its own id is caught automatically.

**Things worth knowing:**

- **The safety boundary is the email domain and nothing else.** Every account the suite creates
  is `@example.test`; the operator's is not. **Never widen that predicate.**
- It reuses **`deleteUserCascade`** from `src/lib/admin-delete.ts` — the app's own cascade,
  already covered by `admin-delete.spec.ts` — so the teardown cannot drift from real behaviour.
- **Blobs are handled separately and deliberately**, because that cascade refuses to touch a
  global content-addressed table (26 blobs are shared across orgs, and there is a test for it).
  Only blobs *nothing* references anywhere are reclaimed; the rule is a pure tested function in
  `src/lib/blob-gc.ts`, not a SQL predicate no test can exercise. **That function is also what a
  future "blob garbage collection" increment should build on.**
- **Stored objects are removed before their rows.** A removed object with a surviving row shows
  up as `unreadable` and a human can see it; a deleted row whose object survives is invisible
  forever, because the sha is the only handle on it.
- **A test was passing only because of the leak.** `admin-guard.spec.ts`'s "paging forward"
  clicks Next and needs a second page of users; 4,600 leftover accounts guaranteed one, so the
  spec never created what it asserted on. Fixing the leak broke it. It now seeds `PER_PAGE + 5`
  rows itself. **If another spec starts failing after a clean run, suspect this shape first.**
- The one-time backfill took **32 minutes** (4,601 sequential cascades over neon-http). A normal
  teardown handles ~120 users and adds a few seconds.

### 3f. Read-only ADF filesystem reader — DONE 2026-09-01, `feat/adf-filesystem-reader`

**`src/lib/adffs/`** — a pure, read-only AmigaDOS OFS/FFS reader for 901,120-byte ADF images (62
vitest tests across 8 files), plus `/disks/[id]/files` (a Browse link on each disk row) and
`GET /api/disks/[id]/files/[block]` to serve one file out of a disk. `archive.test.ts` runs the
reader over the operator's real 61-disk `adf-archive/` and asserts the measured result exactly.

**The measured result, which is the point of the increment: 49 of 61 disks readable (80.3%),
against TOSEC's 45.9% and OpenRetro's 6.6%.** 25 OFS, 24 FFS, 6 INTL, 0 DIRC; 2,430 files in 427
directories, max depth 4, zero cycles. The reader and the catalog are complementary rather than
redundant — `Install3_1_4.adf`, `Workbench31 - wbench31.adf` and the `BestWB` disks are all TOSEC
misses with a perfectly readable filesystem and a self-describing volume name, while the 12
failures are games and demos with custom bootblocks, which is the expected shape.

**Two traps, so nobody re-litigates them:**

- **The root-block checksum is what rejects Project-X.** All four Project-X disks have
  `T_HEADER` at offset 0 and `ST_ROOT` at offset 508 on a disk with no filesystem at all — block
  880 is the middle of the game's data — and store `0x31313131` (ASCII `"1111"`) where the
  checksum belongs. Structural checks alone would report a filesystem with a blank volume name on
  a cracked game. Validity is DOS signature AND root type AND secondary type AND root checksum
  correct — drop the last clause and Project-X passes.
- **The boot-block checksum must NEVER gate validity.** Only 19 of the 49 disks with a sound
  filesystem have a valid one; enforcing it would discard 61% of exactly what this reader exists
  to read. Non-bootable data disks and disks with custom boot code routinely fail it, so the
  reader classifies OFS/FFS/INTL/DIRC from the boot block without ever checking its checksum.

**Worth a cross-reference:** `disks.tosecName` holds the UPLOADED filename until the identity
scan runs and overwrites it with the canonical one (see 3d and the "Show each disk's real
filename" backlog entry below) — the `/disks/[id]/files` page shows it as the disk's title, so a
reader of that page may reasonably wonder why a Workbench disk is labelled with someone's upload.

**Read-only by decision, not by omission.** Writing needs bitmap and hash-chain maintenance this
reader deliberately skips; the write increment is already in the backlog with its constraints
recorded, including that an edited disk deliberately has no TOSEC identity.

### 3g. User-defined collections — DONE 2026-09-01, merged to `master` and live

Two per-tenant tables (`collections`, `collection_games`), six API routes, and a rail on
`/library` beside the existing grid — cards drag into a collection, collections drag into
order, and games drag into order inside one. **Migration 0011 is applied to the live
database.** Spec: `docs/superpowers/specs/2026-09-01-collections-design.md`. Plan:
`docs/superpowers/plans/2026-09-01-collections.md`.

**`mergeDuplicates` now repoints `collection_games`, delete-then-update, and that is the
point of the increment.** `src/lib/tosec-apply.ts` DELETES `games` rows when a TOSEC scan
collapses two titles into one; `collection_games.game_id` cascades, so an unrepointed
membership row is destroyed silently, and a collection is the one thing in this app nobody
can regenerate. **`collection_games` is now the SECOND table whose game id has to join that
batch** — `devices.desiredGameId`/`mountedGameId` were the first — so the pattern, not the
table, is what to carry forward: **anything new holding a `games.id` belongs in that
statement list, and it is the first place to look, not an afterthought.** The DELETE must
precede the UPDATE: a collection holding both the survivor and the absorbed game makes a bare
repoint violate the composite primary key, and because `db.batch()` is atomic that aborts the
whole merge and the sweeper retries it on every pass forever.

**`collection_games.gameId` cascades DELIBERATELY, and that is the opposite of the
`disks.gameId` ruling.** Losing a collection entry when its game is genuinely gone is correct.
Losing a *disk* is not: `readDesired` joins on `devices.desiredDiskId`, and a disk that
vanishes is indistinguishable from an eject. The cascade here is a safety net under the
repointing above, not a substitute for it — within one batch the UPDATE runs first and the
cascade finds nothing left.

**A reorder rejects unknown ids, duplicates AND omissions** (`src/lib/collection-order.ts`,
proven in vitest). That is what makes it safe for the endpoint to accept a whole
client-supplied list: a reorder can never change membership, only its order.

**`dnd-kit` is this repo's first drag-and-drop dependency** (`@dnd-kit/core`, `/sortable`,
`/utilities`). One `DndContext` in `src/components/collections/collection-provider.tsx` wraps
both the rail and the grid, because a card is dragged from one to the other and two contexts
cannot see each other's draggables.

**Three things about that dependency were found only by driving a real browser, and all three
are invisible to vitest and to `pnpm build`:**

- **An `<a href>` is natively draggable, and dropping a link on the page makes Chrome navigate
  to it.** Pressing a card and moving started the browser's own link drag *alongside*
  dnd-kit's, and filing a game took the person out of the library and onto that game's page.
  Every card carries `draggable={false}`. Note this contradicts D-4-6's aside that native
  HTML5 drag would have sufficed for adding alone: native drag is not neutral here, it is an
  active adversary.
- **dnd-kit `stopPropagation`s the click that ends a drag, but never `preventDefault`s it.**
  Its `PointerSensor` installs a document-level capture listener on activation, so React's
  delegated `onClick` — and therefore `next/link`'s own handler — never runs at all, while the
  browser still follows the href. **An `onClick` on the card cannot fix this and neither can
  `next/link`;** the fix has to be another document-level capture listener, which is what
  `collection-provider.tsx` installs (armed on drag start, disarmed a task after drag end or
  cancel, so it never eats an unrelated click).
- **`DndContext` needs an explicit `id`.** Without one, dnd-kit derives its hidden
  description element's id from a MODULE-LEVEL counter that lives as long as the server
  process, so the server rendered `aria-describedby="DndDescribedBy-10"` while a fresh client
  started at 0 — a React hydration mismatch on every `/library` load.

**Smaller rulings, so nobody re-litigates them:**

- **The two membership statements in `mergeDuplicates` are deliberately NOT org-scoped.**
  `collection_games` has no `org_id` (D-4-5), so they match on `game_id` alone. Safe because
  `mergeDuplicates` picks its duplicates within one org and `addGameToCollection` refuses to
  file another org's game. Mirrors the `disks` repoint in the same loop, for the same reason.
- **`?collection=` is resolved against `listCollections(orgId)` before it reaches
  `listGames`,** which trusts its caller entirely — `collection_games` has no `org_id` to
  scope on. An unknown or another tenant's id falls back to the unfiltered library and never
  404s: a stale link should not break the page.
- **The collections delete in `deleteUserCascade` sits in the `orgIds` loop, not
  `soleOrgIds`,** so deleting one member destroys a co-member's collections. That matches the
  existing treatment of games, disks and devices; it is flagged only because collections
  cannot be regenerated.
- **Narrow concurrency window in the merge:** a user adding the survivor to a collection
  between the DELETE's snapshot and the UPDATE would trip the primary key and abort one sweep
  pass. It **self-heals** on the next pass, so it is not the forever-loop D-4-1 warns about.
- The `inArray(col, db.select())` subquery form was hand-verified against the live neon-http
  driver, standalone and inside a `db.batch()`.
- `PATCH /api/collections/order` was live-verified to reach the static `order/route.ts` rather
  than being read by `[id]/route.ts` as a rename of a collection named "order".

**Suite at merge:** 408 vitest, `pnpm build` clean, lint at the pre-existing 3-error baseline,
**154 Playwright passed (19.6 min)** — the whole suite, not just the new file. **Merged to
`master` and pushed to production 2026-09-01.**

**e2e:** `e2e/collections.spec.ts`, 10 tests, including both halves of the merge hazard (both
games in one collection; only the absorbed one), the three reorder rejections with membership
asserted unchanged after each, and a real pointer-driven drag. **Every fixture creates its
collections under a real signed-up org** — a collection filed under a placeholder org id would
be unreachable by both the spec's cleanup and `global-teardown`, which is the shape that let
4,144 invite codes accumulate.

### 3h. Typeahead search — DONE 2026-09-02, merged to `master` and live

A Spotlight-style pill in both shells' headers. Typing finds a title by any fragment of its
name, publisher, genre or description, or a collection by name, and the keyboard takes you
there. One org-scoped `GET /api/search` returning two groups; **search navigates, it never
filters the library grid.** Spec:
`docs/superpowers/specs/2026-09-02-typeahead-search-design.md`. Plan:
`docs/superpowers/plans/2026-09-02-typeahead-search.md`.

**`disks.orgId` can diverge from its game's org, so a join on `gameId` alone is not scoped**
(D-5-5). Nothing in the schema prevents the drift; only the write path keeps it true. Search
is now the **third** place that rule is load-bearing — `listGames` and `withDerived` were the
first two — so **the rule is the point, not the site: any new join to `disks` carries
`eq(disks.orgId, orgId)` alongside the `gameId` predicate.** Get it wrong here and the query
still returns the right org's games, with another tenant's disk counted into them. That is
the one mistake in this increment that fails silently, and it is why `e2e/search.spec.ts`
ends on a drifted-disk test that asserts `diskCount: 0` rather than a count of a disk that
now claims to belong elsewhere.

**Ranking is done in SQL, not in TypeScript, and that is a deliberate deviation from spec
§9.** `ORDER BY (CASE WHEN title ILIKE … THEN 0 ELSE 1 END), sort_title, id`. Ranking in JS
would mean fetching N candidates ordered by `sortTitle` and re-sorting them in the client —
which lets the `LIMIT` truncate away the very name-match that should have ranked first. The
SQL form is correct at any size. The trailing `id` is not decoration: a non-unique `ORDER BY`
paired with a `LIMIT` has already produced two bugs in this codebase.

**The endpoint is not an existence oracle.** There is no 404 and no status that distinguishes
"you have no such title" from "that title belongs to someone else" — both are an empty array
with a `200` (D-5-6). `/api/ingest/check` is a deliberate GLOBAL oracle, but D13 covers
**digests**; titles are not digests and no equivalent decision covers them.

**`q` is not lowercased** — the second deliberate deviation, from §4. `ILIKE` is already
case-insensitive, so lowercasing changes no result and only invites the next reader to think
matching is case-sensitive somewhere. Trim, collapse whitespace, cap, escape the LIKE
metacharacters (`\`, `%`, `_`) — no case change. A lone `%` therefore matches nothing rather
than the caller's whole library, which is its own e2e test.

**`pg_trgm` is installed by migration 0012, and honestly: it buys nothing at current scale.**
At 9 games Postgres will choose a sequential scan regardless and it will be instant. It ships
now so that adding it later is not a migration run *during* a performance problem. **The
migration is committed but NOT YET APPLIED to the live database** — see the checkpoint note
below before merging.

**Debounce alone is not enough; the abort is what stops a stale result winning.** 150 ms of
debounce still leaves a fast typist with several requests in flight, and they resolve in
arrival order, not in the order they were sent. `search-box.tsx` aborts the previous request
on every keystroke **and** compares each landing response against `currentQueryRef` before
painting it, because aborting is not instantaneous and an older query's answer can still
arrive after a newer one starts. Both guards, not either.

**Smaller rulings, so nobody re-litigates them:**

- **`search-box.tsx` deliberately does NOT import from `@/lib/search`.** That module reaches
  `@/db`; this is a client component, and the import would drag the database into the browser
  bundle. The two result shapes are redeclared and kept in sync by hand.
- **`EMPTY_RESULTS` is frozen two levels deep**, not allocated fresh. It is shared across
  every empty-query call for the life of a warm lambda, so an unfrozen shared object would
  let one future `results.titles.push(...)` corrupt every org's "no results" response.
- **The empty-state line is gated on a completed response for the current query**, not on
  "results are empty". Without that gate `search-empty` renders on the very next React commit
  — before the debounce has even elapsed, let alone before a request is made — so it flashes
  on every search and, worse, **a completely broken `/api/search` would still render it**, and
  a test asserting only that the line appears would pass having proven nothing.
- **`/` focuses the box UNLESS focus is already inside an input, textarea or contenteditable.**
  Otherwise it steals the key from the collection rename and create-collection fields on
  `/library`. There is a test for it.
- **Every path that dismisses the panel funnels through one `reset()`.** Missing the abort on
  even one of them leaves a stale request free to land later and repopulate a panel the user
  believes is closed — `router.push` does not unmount `SearchBox`, which lives in the layout.
- **`games.description` is matched but never advertised.** It is written only for blobs
  OpenRetro recognises. It costs nothing in the `or(...)` and improves on its own as
  enrichment lands.
- **`collection_games` has no `org_id` by design (D-4-5).** The `gameCount` subquery is
  correlated on a `collections.id` that has already passed through `orgFilter()`, so it can
  never be keyed on a collection this caller does not own. `listCollections` scopes the same
  subquery the same way.

**The e2e tests were hardened after a review, and one of them was asserting something
impossible.** Four passed while proving nothing: the ranking test's attribute-match fixture
sorted second alphabetically anyway, so deleting the ranking clause entirely would not have
failed it (it is now `Apidya`, which sorts first); the empty-state test asserted a line that
rendered before any request was made, so a completely broken `/api/search` would have
satisfied it; and `contrast.spec.ts`'s `probe()` skipped translucent layers, measuring the
PLAIN panel instead of the highlighted row — a higher, wrong ratio for exactly the row a bug
is most likely to ship on, since highlight defaults to index 0.

**The fourth is the one worth reading before you touch that test.** The out-of-order test
raced nothing (two `fill()`s inside the 150 ms debounce cleared the first timer before it
fired), and when that was corrected it still could not pass — because **the abort makes a
stale response undeliverable, so `waitForResponse` on the superseded URL can never fire.**
Once the page aborts, Chromium emits `requestfailed` with `net::ERR_ABORTED` and **never a
`response` event**; `route.fulfill()` still resolves, but it resolves into a dead request.
That is the guard working, not a flake. **So `currentQueryRef` — the belt-and-braces guard
behind the abort — is not reachable from an e2e test at all**, and pretending otherwise is
what cost a 30-second timeout. The test now asserts the abort *directly*, on its failure
reason, raced against the response so that removing the `AbortController` fails in 8 s with
`responded:200` rather than hanging. **Verified by mutation: with the abort deleted, the test
fails.**

**The pattern, so it need not be rediscovered:** a typeahead test that does not force the race
window open with `waitForRequest` is not testing the race; a fixture that would satisfy the
assertion for the wrong reason is not a fixture; and an assertion nobody has watched fail is
not yet a test.

**Suite at merge:** 418 vitest, `pnpm build` clean, lint at the pre-existing 3-error baseline,
**170 Playwright passed (23.7 min)** — the whole suite, not just the new file. **Migration 0012
is applied to the live database.** **Merged to `master` and pushed to production 2026-09-02.**

**e2e:** `e2e/search.spec.ts`, 11 tests — the middle-of-string fragment that is the whole point
of D-5-2, ranking, both keyboard paths, the abort, the empty state, cross-tenant, the lone `%`,
and the drifted disk. `e2e/contrast.spec.ts` gained a twelfth for the highlighted row.

### 3i. Shell polish — DONE 2026-09-02, merged to `master` and live

Four operator requests. **The "/" search shortcut already worked** — it focuses without typing
a slash into the box it opens. What was missing was any sign of it on screen and any test that
it focused at all: only the negative case (not hijacking another input) was covered, so it
could have been broken outright with a green suite. There is now a `/` badge in the pill
(`sm:`-only — it advertises a key, and a phone has none) and two tests.

**Both navs are centred on the VIEWPORT, and getting there took three attempts, all measured.**
`mx-auto` centres only within the space its siblings leave over, so the wider right-hand group
pushed the pill left by a different amount in each shell. A `1fr/auto/1fr` grid centred it
exactly but forced equal side columns, wrapping "Back to library". Absolute centring collided
with the search box by 15px in the admin shell. What shipped is absolute centring **plus a
32px narrower search pill**, measuring 0.0px off centre in both shells with equal vertical
centres. The admin email is capped and truncated — a long real address would have broken that
header at any width.

**The file tree's zebra wash is WHITE, not grey, and that is not a style choice.** Its metadata
columns use `--muted-2`; darkening alternate rows by even 0.03 alpha drops `--faint` to 4.49:1,
under WCAG AA. Washing lighter reads as the same alternation while raising `--muted-2` to
5.37:1. **Striping also required flattening the tree into its visible rows first** — striping
per level puts two same-shaded rows side by side at every expanded directory boundary.

**Navigation now shows a bar and dims the page**, because Next's docs name the symptom exactly:
a dynamic route without `loading.tsx` blocks on the server response before rendering, so the app
"appears unresponsive" — which was every route here. **Each `<Link>` reports through
`useLinkStatus()` rather than a global click listener**, because `/library` already runs one for
dnd-kit and a second on the same drag handles is a production-only bug in waiting; the reporter
renders `null`, so it adds no DOM and cannot shift a layout. The 150ms delay before anything
appears is a CSS `transition-delay`, not a timer — a timer meant setting state from an effect,
which this repo's React 19 lint rules reject.

### 3j. Mobile responsive — DONE 2026-09-02, merged to `master` and live

The app rendered on a phone and could not be used on one: **four responsive utilities existed in
our own code**, and everything else was written at one width. Spec:
`docs/superpowers/specs/2026-09-02-mobile-responsive-design.md`, whose §8 records the six places
that spec was wrong and was corrected during implementation.

**`playwright.config.ts` now has two projects, and that is the load-bearing part.** Until now
every spec ran at Playwright's default 1280×720 because no viewport was ever configured, so the
responsive rules had no test that could fail. `desktop` deliberately sets NO viewport so it keeps
inheriting that default; `mobile` is pinned to 390×844 with `hasTouch` and matches only
`e2e/mobile.spec.ts`.

**Every rule is written as the mobile value unprefixed with `sm:`/`md:` restoring the desktop
value, never the reverse.** A regression at 1280 is the signal that a rule was written backwards.
**No existing spec was edited** — that was the agreed tripwire and it never fired. The
mobile-only groupings use **`sm:contents`**, so above the breakpoint the wrapper generates no box
and the desktop row lays out exactly as before rather than being re-derived.

**Touch drag is where the real hazard was.** `PointerSensor` keys on `pointerdown` with **no
`pointerType` check**, so adding a `TouchSensor` beside it double-activates on a phone. It is
**replaced** by `MouseSensor` at the same 8px distance, with touch getting
`delay: 250, tolerance: 8` (`tolerance` is required on dnd-kit's delay form). **The delay is on
the touch path ONLY** — `collections.spec.ts` moves immediately without holding, so a delay on
the mouse path breaks every drag test.

**`touch-action: none` stays on the rail grip and is deliberately absent from the grid cards.**
`AbstractPointerSensor.handleMove` suppresses scrolling only via
`if (event.cancelable) event.preventDefault()`; once a browser commits a gesture to a scroll its
`touchmove` stops being cancelable, so the grip needs it to guarantee the first post-hold move is
still cancelable. On the cards, whose listeners cover the whole card, `none` would kill scrolling
of the entire library — the 250ms/8px hold separates the gestures instead.

**The nav bar's backdrop is NOT a glass token.** Those are white surfaces for dark text; the
pill's labels are the light `--on-dark` ramp, and the bar sits at the bottom of the viewport
where the fixed gradient has run to `#eef1f2` — white glass there leaves the labels near 1.5:1.
`--nav-scrim` and `--nav-scrim-hairline` carry the dark band down with the bar.

**The file tree was the worst break in the app:** fixed columns totalling more than the card was
wide, so the name column computed **negative** at depth 0 and Download was clipped away entirely.
Two lines below `sm`, and deliberately no horizontal scroll — Download is the row's only action.
**The directory toggle must stay the only `<button>` in a row** (`adf-browser.spec.ts` scopes
`getByRole('button')` to it).

**Verified, and its limit:** the touch test is **mutation-proven** — reverting the touch path to
a distance-only constraint makes the card pick up instead of the page scrolling, and the test
fails on it. **Nothing has run on a real phone.** Emulated touch is not a finger and `hover:` has
no analogue on one.

### 3k. The game page's images now reserve their space — DONE 2026-09-03

Reported by the operator as "clicking a title shifts the layout". Measured on production with
a `layout-shift` PerformanceObserver rather than guessed: **CLS 0.0063 over two entries**, the
sources all being the screenshot strip sliding sideways (x 250→410, 410→565, 581→737) as each
thumbnail decoded.

**Two defects, one cause: `<img>` elements with no declared dimensions.** The cover was
`h-auto`, so it reserved ZERO height until the bytes arrived and then shoved the whole facts
card down ~275px — the big jump. The screenshots were `w-auto`, so each occupied nothing until
it decoded and then pushed its neighbours right.

**Nothing in the schema records image dimensions.** `openretro_images` has sha1, kind, size and
source, no width/height, so the browser cannot be told the true aspect ratio and has to be
given a reserved one: the cover is `aspect-[4/5]` (a measured cover is 400×509 = 0.786 against
the box's 0.8), the screenshots are `w-[168px]` (naturals 472–500 × 400, ratios 1.18–1.25, so
1.27 contains the widest without cropping). `object-contain` on both, so a disagreeing image
letterboxes by a few pixels instead of cropping or moving the layout.

**The library grid never had this bug**, because `cover.tsx` has always painted into a fixed
`aspectRatio: '1.23 / 1'` box. The detail page was the one surface that did not follow that
pattern — which is the rule to carry forward: **an image in this app goes in a box whose size
is known before the bytes are.**

**If exactness ever matters more than a reserved ratio**, the fix is width/height columns on
`openretro_images` plus a backfill, not a bigger guess. Deliberately not done as part of a
layout fix.

Proven by mutation: reverting to the old markup makes the reserved cover box report a height of
**0** before load, and `e2e/openretro.spec.ts`'s "the images reserve their space" test fails on
it. That test holds every `/api/images/**` response and asserts the boxes are already full-size
— note it must `goto` with `waitUntil: 'domcontentloaded'`, since the default waits for the very
images it is holding.

### 3l. Unified breadcrumb — DONE 2026-09-03

One clickable trail above the title, replacing two conventions that were never navigation:
`eyebrow` as a plain string, which nine pages filled in six mutually inconsistent ways, and a
hand-written back link in the `actions` slot, already spelled two different ways and about to
invent a third.

**`PageHeader`'s `eyebrow` is now `string | Crumb[]`** — the seam the backlog identified. A
plain label still renders exactly as before, so the seven top-level pages are untouched; the two
drill-down pages pass a trail. `src/components/shell/breadcrumb.tsx`.

**The trail carries ancestors only; the `<h1>` is the current page.** Repeating a title at
12.5px directly above the same words at 34px reads as a rendering bug. The one exception is a
crumb that says WHICH of something you are looking at — "Disk 2" — where the heading is showing
a different fact entirely (the volume's name).

- `/games/[id]`: `Library`
- `/disks/[id]/files`: `Library / <the entry's title> / Disk N`

**The root is hardcoded "Library", by the operator's ruling, and that is the collection
decision.** `?collection=<id>` is a real second axis on `/library`, but a game can be in many
collections and `collection_games` is many-to-many by design, so the trail **cannot be derived**
from a game id — carrying it would mean threading a `?from=` param through every link. So a
person who opened a title from inside a collection returns to the whole library, and the trail
says so honestly instead of guessing at one of the collections that title belongs to. There is a
test that opens a title from inside a collection and asserts the trail neither names it nor
navigates to it.

**The `kind` segment was considered and deliberately left out.** `game-kind.ts` derives it, but
it is `null` for the ~54% of the archive TOSEC does not recognise, it is not somewhere you can
navigate, and `getGameDetail` does not carry it — it would cost an extra query per render to
show a word that is usually absent.

**The middle crumb is named for the entry, never typed as "Game".** That rule came from the back
link this replaced, and it is kept rather than rediscovered: `games` is the table's vocabulary,
and it is simply wrong on a Workbench or utility disk, which is most of what the file browser is
for.

**One existing spec was edited, deliberately.** `adf-browser.spec.ts` located the back link by
regex — `getByRole('link', { name: /^←/ })` — so a grep for the literal text missed it and the
suite caught what the grep did not. The affordance moved, so its four guarantees moved with it
onto the trail rather than being deleted: there is a way back, it is named for the destination,
it navigates there, and that page's heading is the title.

**Suite:** 418 vitest, **181 Playwright passed (24.9 min)**, build clean, lint at the 3-error
baseline.

### 3m. Editing a title by hand — DONE 2026-09-03

`PATCH /api/games/[id]` and `POST /api/games/[id]/reset`, with an editor on the game page. Spec:
`docs/superpowers/specs/2026-09-03-edit-title-details.md`. Two operator rulings shaped it:
**authority is per GROUP, not per row**, and **an edit is reversible**.

**The mechanism already existed; this is the UI that uses it.** `MACHINE_SOURCES` gates every
sweep write, so stamping a source column `'human'` makes that group immune. Three groups:
**identity** (`title` + derived `sortTitle`, `year`, `publisher` → `metadataSource`), **facts**
(`developer`, `players`, `genre`, `chipset` → `factsSource`), **prose** (`description`,
`history` → `proseSource`). **An edit stamps only the groups it actually changed** — saving an
untouched form stamps nothing, and there is a test for that, because otherwise merely opening
the editor would freeze a row forever.

**THE TRAP, and it was measured against live data before a line was written.** `metadata_source`
is never NULL (`'filename'` at ingest), so NULL there really does mean a human. But
**`facts_source` and `prose_source` were NULL on 7 of the 9 live games**, where NULL means
*never written*. The obvious guard — `inArray(factsSource, MACHINE_SOURCES)` — would have
**excluded every never-enriched row and silently stopped OpenRetro enriching ~78% of the
archive**. Their guard is `IS NULL OR IN MACHINE_SOURCES`; see `machineOwned()` in
`openretro-apply.ts`. **The "including NULL" rule in `tosec-apply`'s comment is correct for
`metadataSource` and inverted for the other two.**

**`applyEnrichment` is now three statements, not one.** It guarded everything on
`metadataSource`, which made the per-group columns decorative — a typo fix in a TITLE froze that
game's facts and prose too. `publisher` stays guarded on `metadataSource` even though OpenRetro
writes it: it is TOSEC's column first, and a person correcting it means it.

**Two bugs this increment introduced and then fixed, both found by looking at the page:**
- A hand-written description was saved, stamped, protected — **and never rendered**, because
  `GameFacts` gated on `=== 'openretro'` and recognised no other author.
- Fixing that made the page print "Metadata and images from OpenRetro" under a sentence a person
  typed. **The attribution is now conditional on something actually coming from them**, which is
  the whole point of having it.

**Reset restores, it does not merely release.** It reads this game's own matched entry
(`blobs.tosecEntryId` / `openretroEntryId`) and writes the values back, because a control saying
"use scanned data" must not mean "your mistake stays until some future sweep". **`applyMatch` is
deliberately not reused** — it applies across every tenant holding those bytes and can MERGE
games, far more than undoing one edit asked for. Identity resets to `'tosec'`/`'filename'`, never
NULL, which in that column would leave the row frozen.

**Editing a title writes `sortTitle` too** (via `makeSortTitle`, so human rows sort like machine
ones). It also makes that row permanently the merge survivor, and two human-edited rows in one
duplicate set never merge. That is correct, and the UI does not imply otherwise.

**Suite:** 432 vitest, **189 Playwright passed (25.9 min)**, build clean, lint at the 3-error
baseline.

### 3n. Creating a blank ADF — DONE 2026-09-03

`POST /api/disks/create` and `PATCH /api/disks/[id]/volume-name`, with a **Create ADF** button
and an FFS/OFS selector on `/library`. Operator's rulings: **the disk is real the moment you
press the button** (no draft card), and **FFS by default, OFS selectable**.

**This is the FIRST WRITE PATH in `src/lib/adffs`.** `formatVolume()` writes boot, root and --
the part that never existed -- the **bitmap**. `index.ts` used to say the module does not
maintain bitmaps; that is now true of the READER only.

**THE VERIFICATION IS THE INTERESTING PART, because unit tests structurally cannot do it.**
The reader ignores the bitmap, so a disk with an exactly INVERTED bitmap round-trips through
`readVolume` perfectly and corrupts only when a real Amiga writes to it and believes an
occupied block is free. The code that would catch that bug is the code under test.
`pnpm adffs:verify` (`scripts/adffs-verify.ts`) is the second opinion, mirroring what
`adfmfm:diff` does with Greaseweazle: it hands a disk to amitools' **xdftool**. The decisive
check is not that xdftool READS our disk — **it is that xdftool WRITES a file into one**, which
means it allocated a block out of our bitmap and believed it, and that our reader still reads
the result. Ten checks across OFS and FFS. **Not in `pnpm test`: xdftool is not a dependency
and is not in CI.** Run it by hand after touching `format.ts`.

**A by-product worth knowing: our reader had never been tested against anything but its own
fixtures**, and it reads amitools' disks correctly — names, filesystems, files and directories,
zero warnings.

**Two things xdftool does that were deliberately NOT copied:** it writes `"DOS"` into the root
block's `next_hash` field, which is meaningless on a root block, and it stamps dates in local
time. Ours leaves the field zero and stores UTC.

**A rename rewrites the disk, and every consequence follows from content addressing:** new
bytes, new sha-256, a NEW blob, and `disks.sha256` repointed. **`disks.id` never changes** —
`readDesired` joins on `devices.desiredDiskId`, and a re-keyed disk makes that join return
nothing, which in this protocol IS an eject. The old blob is never deleted; other tenants may
still be entitled to those exact bytes. `setVolumeName` patches the root block rather than
re-formatting, because re-formatting to change a name would erase every file on the disk.

**A bug found and fixed during implementation:** the first version repointed any device whose
desired OR mounted sha matched. That is wrong — a device whose MOUNTED sha is the old one but
whose desired sha is something else has already been told to change to a different disk, and
repointing would silently redirect it. It is `desired` only, and it bumps `desiredVersion`,
which is what the long poll is gated on.

**`games.authored` is a real column (migration 0013, applied), not an inference.**
`metadataSource: 'human'` is true of ANY hand-edited title including a real uploaded game, and
renaming one of those from a card would rewrite a game's volume — with no answer to "which
disk?" on a multi-disk title. The flag also serves the backlog's requirement that the TOSEC
coverage rate exclude user-made disks, or the rate falls every time the operator makes one and
reports their own work as a gap. **That exclusion shipped 2026-09-04** — see 3q.

**The inline rename field sits INSIDE the card's `<a href>`**, which is also a dnd-kit
draggable, and is safe for the same reason the collection remove button is: every pointer event
is stopped before it reaches the anchor or the drag listeners.

**NOT in this increment: adding, editing or deleting FILES.** That needs allocation from the
bitmap, hash-chain insert and relink on delete, OFS data-block headers and extension blocks. It
was split off deliberately — creating a blank disk is where the bitmap work lands and is the
smallest thing that has to be exactly right.

**Suite:** 444 vitest, **195 Playwright passed (25.8 min)**, build clean, lint at the 3-error
baseline.

### 3o. Deleting a title or a disk — DONE 2026-09-04

`DELETE /api/games/[id]` and `DELETE /api/disks/[id]`, behind a confirmation dialog. Operator's
rulings: **the whole title from a library card, plus per-disk on the game page**, and **eject
first, then delete** rather than refusing while mounted.

**THE BLOB IS NEVER DELETED.** It is global and content-addressed, and other tenants may hold
the same bytes — destroying the object would break their library. What goes is this org's
**entitlement**, which is what makes the blob reclaimable by `blob-gc.ts` later.

**And the entitlement only goes when nothing else needs it.** The same image can back two disks
in one library — a duplicate upload is ordinary — and dropping the claim on the first delete
would break the survivor's download AND its device fetch, because the entitlement IS the
boundary those paths check. There is a test for exactly that.

**The eject is deliberate, not incidental, and this is the subtle part.** `disks.gameId`
cascades, so the row would vanish either way and `readDesired`'s LEFT JOIN would quietly return
nothing — which in this protocol IS an eject. But **the long poll is gated on
`desiredVersion`**, so without a bump the board sits for 25 s and never learns. `clearDesired`
is used precisely because it bumps. Compare the write-protect backlog entry: same protocol
question, opposite answer, because there the flag changes and the bytes do not.

**No typed-name gate, unlike `delete-user-dialog`.** That gate exists because deleting a user
destroys someone else's library irrecoverably. This is the person's own disk and an ADF can be
uploaded again, so the protection that fits is naming what will happen — the title, the
ejection, and that the image survives for anyone else who has it.

**The dialog is portalled to `document.body`, and it has to be.** `.glass-card` sets
`backdrop-filter`, and **a filtered ancestor becomes the containing block for fixed-position
descendants** — so `fixed inset-0` resolved against the card and the overlay rendered ~145px
wide with its text one word per line. A dnd-kit drag transform on the same ancestor does the
same thing. Any future modal rendered from inside a card needs the same treatment.

### 3p. Disk space on the browse page — DONE 2026-09-04

`readUsage()` in `src/lib/adffs/usage.ts`, shown on `/disks/[id]/files` as
`2 KB used of 880 KB · 878 KB free` with a bar that turns amber past 90%.

**THE ONE PLACE THIS READER TRUSTS THE BITMAP.** Everything else in `adffs` ignores it by
design — a disk with a wrong bitmap reads perfectly — so this is the only path where a bad
bitmap produces a wrong ANSWER rather than no answer. Hence it returns **null rather than a
guess** when the volume marks its own bitmap invalid (`bm_flag != -1`, meaning AmigaDOS would
rebuild it on mount), when the bitmap pointer cannot be a block, or when the bitmap claims every
block free **including its own** — an uninitialised block that would report an almost-full disk
as empty. This is the figure a person acts on when deciding whether a file fits.

**Measured before it was written and verified after.** All 46 readable volumes in the operator's
archive have a valid flag, a pointer of 881 and a self-marking bitmap, so "unknown" is not the
common case. The counts agree with amitools' xdftool on used AND free for **46 of 46** real
disks. The +2 against a naive bit count is the two boot blocks, outside the bitmap but certainly
not free space.

**`syntheticVolume` writes NO bitmap**, so a test fixture reports "unknown" and cannot exercise
this — use `formatVolume` for a disk that has one. There is a test pinning the refusal path on a
synthetic disk, which is the property that actually matters.

### 3q. Self-made disks no longer count as TOSEC misses — DONE 2026-09-04

The loose end 3n left open. A disk somebody made hashes to something no DAT contains, so the
sweeper stamps `match_state = 'none'` — correct — but counting it as a MISS made the coverage
rate on `/admin/scan` fall every time the operator created a disk, reporting their own work as
a gap in the archive.

`scanStatus()` gains `authoredNone`, and the page subtracts it exactly as it already subtracted
`unreadable`, capped so the two corrections cannot overlap into a negative count.

**EVERY disk on the blob must be authored, not just one.** Blobs are global and
content-addressed: if the same bytes also back a real uploaded disk in ANY organization, then it
genuinely is an archive disk TOSEC failed to recognise, which is precisely what this rate
measures. The SQL is `not exists (… g.authored = false)`, not `exists (… authored = true)`, and
the difference is the whole correctness of it.

**The page names what it left out** (`· 1 self-made disk excluded`) rather than quietly
reporting a nicer number. A rate that silently deducts things is one nobody can check.

**A flake worth knowing about, found in the test for this:** it failed once and then passed
unchanged, because it assumed a single `POST /api/admin/scan` would reach the new blob. **The
sweeper works to a budget against a shared live database**, so how far it gets depends on what
else is unchecked at that moment. The test now sweeps until the blob is actually decided and
asserts that verdict before looking at the page. Any test that depends on a sweep reaching a
specific row needs the same treatment.

### 3r. The breadcrumb follows the collection you came from — DONE 2026-09-04

3l hardcoded the root to "Library"; that answered the question as it was asked, before anyone
had seen a trail in use. Opening a title from inside a collection now reads
`Library / Sports Games / Sensible World of Soccer / Disk 1`, and the collection survives both
steps down AND the step back up.

**It is CARRIED, not derived, and it cannot be otherwise.** A game is in many collections and
`collection_games` is many-to-many, so nothing downstream can work out which one you came from.
`?from=<collectionId>` rides the link; `src/lib/trail.ts` holds the whole rule.

**AND NOT THE BROWSER'S HISTORY, which was measured rather than assumed.** On production,
`document.referrer` is **EMPTY** after a Next client-side navigation from `/library` to
`/games/[id]`. `history.length` does increment, but browsers do not expose history entries to
read — so nothing can NAME the place it would go back to, only go there blindly. A `?from=` is
the only mechanism that survives a reload, a shared link and a new tab, and the only one that
can render the destination's name. **Do not "simplify" this to a Back button or a referrer
check.**

**An untrusted `?from=` is resolved against this org's own collections before its name is
rendered** — exactly the proof `/library` already performs on `?collection=`. `collection_games`
carries no `org_id` (D-4-5), so an unchecked id would print **another tenant's collection name**
on the page: a cross-tenant leak through a breadcrumb. A test forges one. An unknown or foreign
id degrades to plain "Library", never a 404.

**Library stays first and stays clickable inside a collection.** A collection is a view of the
library, not a replacement, and someone who filtered their way in still wants the way out.

**Two existing tests changed deliberately.** *"the trail does not invent a collection it cannot
know"* pinned the hardcoded root and is replaced by the guard for the fallback that still must
hold. And `collections.spec.ts`'s `cardGameIds` derived ids with a string replace on the raw
href, which glued `?from=` onto every id — it now takes the **pathname's last segment**, so the
next link to gain a param will not break it.

**Suite:** 464 vitest, **206 Playwright passed**, build clean, lint at the 3-error baseline.

### 3s. Hardware: the board check, and silkscreen for U2 — DONE 2026-09-04

The first PCB came back **mirrored** and was scrapped; a corrected revision was ordered
2026-09-04, so plan 5 cannot start before the week of 2026-09-08. Everything below is about not
paying for that mistake twice.

**`pnpm hw:verify` (`wifi-floppy/hardware/verify_board.py`) runs before any fab order.** It
checks two things: that no footprint is a *reflection* of its canonical KiCad land pattern, and
that the exported Gerber is correctly Y-flipped (Gerber is Y-up, KiCad Y-down). **Mutation-proven
2026-09-04:** reflecting the SOT-23 reference makes all six FETs fail with `REFLECTION + 180 deg`
and the run refuses with *DO NOT FAB*.

**A bug in that checker that made it worse than useless for new references.** `pads_from_mod`
matched only `(pad 1 smd rect (at x y)` — unquoted, one line, smd only. Everything KiCad emits
today quotes the pad name, puts `(at …)` on its own line, and says `thru_hole` for a header, so
against a modern file it matched **nothing** and would have compared an empty pad set and
reported a cheerful pass. It parses either format and any pad type now.

**TWO LIMITS THE CHECK STATES ABOUT ITSELF**, because a check whose limits are undocumented gets
trusted past them:
- **A mirror-symmetric land pattern cannot fail a chirality test** — a reflection of it is
  indistinguishable from a rotation. C_0603, C_0805, D_SMA and the 1x04 header are all in that
  class and say so per part. **The 2x17 floppy header is NOT symmetric**, so it is genuinely
  chirality-checked, which makes it the most valuable reference of the five.
- **U1 has no upstream reference** and must be checked by hand against the module drawing.

**U1 is a Pimoroni PIM726, and the part number is a REQUIREMENT, not a preference.** The
firmware targets `pimoroni_pico_plus2_w_rp2350` and `psram_image.c` is a 2.03 MB store in that
board's PSRAM — a pin-compatible module without PSRAM fits the footprint perfectly and then
fails to run. Confirmed by the operator 2026-09-04. No check in that folder can catch it.

**Only U2 carries silkscreen** (operator's call): the buffer IC is the one part that can be
fitted the wrong way round without it being obvious. Caps and SOT-23s are deliberately bare.
**Only the short edges are drawn** — the pads reach the 7.5 mm body's long edges exactly, so a
full rectangle would put ink on twenty pads. The short edges clear by 0.385 mm; the pin-1 dot
sits 0.735 mm outside the pad field.

**THE BOARD IS GENERATED.** Edit `generate_pcb.py`, never `wifi_floppy.kicad_pcb` — a
regeneration discards hand edits. Three scripts held absolute `/home/claude/…` paths and could
not run on the operator's machine at all until 2026-09-04; they resolve against their own
directory now. The Gerber exporter needs `shapely`, which will not install into a PEP 668 system
Python: there is a gitignored `hardware/.venv`, so run
`./.venv/bin/python export_gerbers.py`.

### 3u. Adding, editing and deleting files inside an ADF — DONE 2026-09-04

`src/lib/adffs` is no longer read-only. `addFile`, `deleteEntry` (files AND directories,
recursive), `renameEntry` (files AND directories), `replaceFile` and `makeDirectory`, all pure
functions over a `Uint8Array` returning new bytes or a typed error, never mutating and never
throwing. Behind them a real bitmap allocator. Above them three routes under
`/api/disks/[id]/files` and upload / new folder / rename / delete on the browse page.
Spec `docs/superpowers/specs/2026-09-04-adf-file-operations-design.md`, plan
`docs/superpowers/plans/2026-09-04-adf-file-operations.md`, twelve tasks.

**THE FIXTURE BUILDER HAD NO BITMAP, AND THAT IS WHY IT WAS TASK 1.** `syntheticVolume()` wrote
none at all, so amitools' `xdftool` rejected every fixture in this module with
`Bitmap Block Count Mismatch` on all four shapes tried, at the first command. Our own reader
accepted them because it ignores bitmaps. **Every fixture-based test in `src/lib/adffs` had
therefore been validated against a disk shape no Amiga tool would mount** — which is exactly the
foundation a writer would have been built on. The production path was never affected:
`formatVolume()` always wrote a correct bitmap, and the reader's 80.3% on the real archive comes
from `archive.test.ts`, which uses real disks.

**Two mutation proofs, both reproduced independently by a second reviewer.** Making `free()` a
no-op fails exactly the two delete-then-refill checks; dropping `rechecksum` from `allocate`
fails exactly 38. `pnpm adffs:verify` is now 89 checks covering every operation on OFS and FFS.

**The plan's own sharpest check was vacuous and had to be resized.** A ~700-block file needs 710
blocks with extensions, leaving 1046 free of 1756 — so with `free()` broken, xdftool simply
refilled from elsewhere and the check passed. It is a 950-block payload (964 blocks) now,
leaving 792 free: a 172-block shortfall that a broken free cannot satisfy.

**The verify script could not see failures at all.** `execFileSync` puts the real `FSError:`
text on the exception's `.stdout`, not in its message, so `String(e)` never matched. **Sixteen
checks were incapable of failing** — the 12 `lists it` checks and the 4 fixture `opens` checks
from task 1. Fixed; this is also why task 1's mutation produced a different error than predicted.

**A LATENT BUG IN THE SHARED WRITERS, found by task 7 and predating it.** `writeFileHeader` and
`writeExtensionBlocks` never cleared their 72-slot pointer tables, so a REUSED block kept the
previous file's pointers. Unreachable while fixtures started from an all-zero buffer, but
reachable through `addFile` alone once blocks recycle: add a 100-block file, delete it, add a
small one. `allocate` hands out any freed block and `free` never zeroes content. Fixed
unconditionally in both writers and pinned by two isolated regression tests.

**THE DEFECT ONLY e2e COULD FIND: the TOSEC identity warning fired on EVERY disk.** The dialog
gated on `disks.tosecName`, whose comment claimed it meant "this disk matches TOSEC". It does
not — it holds the uploaded filename until a scan overwrites it (see the cross-reference in 3f),
and `/api/disks/create` stamps `${volumeName}.adf` into every blank disk. A disk created seconds
earlier displayed "This disk currently matches Empty.adf in TOSEC". Beyond breaking four tests it
inverted D-W-3: the operator would be warned on every edit of their own disk that an identity
they never had was about to be lost. **Now gated on `blobs.matchState === 'matched'`**, joined by
sha256 — `'none'` and `null` are not matches. The e2e test for it passed even WITH the bug, and
now stamps `matchState` itself, proven by a negative control.

**Two operator rulings, both recorded in the spec:**
- **D-W-3.** Any disk is editable; one with a real TOSEC identity warns first. Losing the
  identity is the intended outcome, not a failure.
- **D-W-4.** Editing a disk a device has MOUNTED is refused with 409, naming the device — not
  propagated. That is what keeps this increment free of any protocol question on hardware that
  has never run. Both `mountedSha256` and `desiredSha256` are checked.

**Two rulings I made against the plan, because the spec outranks it:** the plan's allocator
skeleton let `isFree` and `free` read the bitmap pointer raw, which gave a path where a corrupted
`bm_pages[0]` of 880 made `rechecksum` overwrite the ROOT block — D-W-5 binds all three functions,
not just `allocate`. And the plan never implemented directory rename at all, though the spec's
scope says "rename a file or directory" and its own self-review claimed full coverage; task 8 was
extended to close it.

**A TRAP THAT COST HOURS, and it is the one already in this file.** An orphaned `next dev` on
port 3000 produces cascading `ERR_CONNECTION_REFUSED` that reads exactly like a code regression.
Running suites back to back also exhausts connections and makes `/api/ingest/presign` hang for
30s, failing whole spec files. **Both were misdiagnosed as real regressions before being run
alone on a clean port.** Check `lsof -iTCP:3000` before every run, never start a run while
another is going, and never background a dev server from a tool call — it dies with the call.

**Suite:** 517 vitest, `pnpm build` clean, lint at the 3-error baseline, `pnpm adffs:verify` 89
checks, `disk-files-edit.spec.ts` 7/7 and the mobile project 7/7 on a clean environment. The
last full-suite run predates the final fixes and is not the number to quote.

### 3t. Create ADF is one menu, not a select plus a button — DONE 2026-09-04

The library header's control was a native `<select>` (FFS/OFS) sitting beside a **Create ADF**
button. It is now a single dropdown menu with two items, **Create ADF (FFS)** and
**Create ADF (OFS)**, built on the same Base UI `dropdown-menu.tsx` the collection rail already
uses. Operator's call 2026-09-04, following the note in 3n that the two-control shape needed
revising.

**The change that matters is not cosmetic: a `<select>` keeps its value.** Picking OFS once made
every later disk OFS until somebody changed it back, and nothing on screen restated that choice
at the moment you pressed Create. The filesystem is now part of the click instead of ambient
state. The guard is `create-adf.spec.ts`'s "the filesystem is chosen per disk" test, which makes
an OFS disk and then an FFS disk and reads the filesystem off the BYTES of each.

**Seven call sites clicked `create-adf` and expected a disk to exist afterwards.** On a menu
trigger that click only opens the menu, so all of them — six in `create-adf.spec.ts`, one in
`admin-scan.spec.ts` — now go through a new **`createAdf(page, filesystem)`** helper in
`e2e/helpers.ts`. Anything that makes a disk through the UI should use it rather than clicking
the trigger, because forgetting the second click leaves a menu open and no disk made, which
fails later and somewhere else.

**What was given up, and the test that covers it.** A native `<select>` gets the OS picker on a
phone for free: correctly sized, always on screen, impossible to get wrong. A Base UI menu
inherits none of that. `mobile.spec.ts` now opens the menu at 390×844, asserts the popup sits
inside the viewport horizontally, asserts the item is at least 32px tall, taps it, and checks
the document did not widen. **Base UI does NOT clamp an over-wide popup back on screen** —
proven by mutation, forcing the content to 600px fails the horizontal bound rather than being
collision-corrected. Do not assume the primitive protects you at narrow widths. `align="start"`
is load-bearing for the same reason: the trigger is the leftmost thing in the header's actions.

**Suite:** 464 vitest, `pnpm build` clean, lint at the 3-error baseline, **208 Playwright** — 202 desktop and
6 mobile.

**One failure in that run, and it was not this change:** `game-edit.spec.ts`'s "handing identity
back restores what the scan found" hit its 280s timeout waiting for `edit-details` to appear,
then passed **alone in 18.3s**. It is a sweep test, it never references the Create ADF control,
and this is the flake shape already recorded above. Re-run it alone before treating it as a
regression.

### 3w. Deleting the last disk no longer 404s — DONE 2026-09-05

Reported by the operator: create an ADF, click into it, delete it, and the page 404s.

**The server was already reporting the cause in the response the client was reading.** Creating
an ADF makes a title with exactly one disk, so deleting that disk empties the title and
`deleteDisk` removes the title too, returning `gameDeleted: true`. `DeleteDiskDialog` parsed
that same body for `ejected` and ignored `gameDeleted`, then called `router.refresh()`
regardless — re-running `/games/[id]` for a game that no longer existed, which is `notFound()`.

So the fix keys on what the server SAYS rather than on `kind`: navigate only when the response
reports the title itself is gone. Deleting one disk of a multi-disk set still refreshes and
leaves you on the title page, and a second test pins that so the fix cannot over-correct.

**REPLACE, NOT PUSH.** The deleted title's URL must not stay in history or Back returns to the
404 this exists to avoid. There is a test for that too.

**Where it goes is the breadcrumb's own answer**, not a guess: `libraryHref()` now lives in
`src/lib/trail.ts` beside `libraryTrail` and both use it, so the redirect destination IS the
Library crumb the person can see, carrying the `?from=` collection they arrived through.
Spelling that URL out twice is how the two would quietly stop agreeing.

**The library grid deliberately passes nothing and keeps refreshing:** there the page is the
library, which outlives any card on it.

### 3v. Dropping files onto a disk, and dragging them around inside it — DONE 2026-09-05, on `feat/adf-drag-drop`, not merged

Builds directly on 3u's write layer. Two gestures, shipped together in one increment (operator's
ruling, 2026-09-05, recorded below): dropping files and folders from the operating system onto a
disk, and dragging an entry already inside a disk onto a folder to move it — plus a
keyboard-reachable "Move to…" for the second, since a drag-only feature excludes keyboard users.
Spec `docs/superpowers/specs/2026-09-05-adf-drag-and-drop-design.md`, plan
`docs/superpowers/plans/2026-09-05-adf-drag-and-drop.md`, 11 tasks.

Dropping never writes directly. It fills an always-visible staging list (`DropStaging`,
`src/components/disks/drop-staging.tsx`) showing every dropped file and folder, what it will be
named (AmigaDOS names are 30 characters and fold case, so an over-long or colliding dropped name
is the ordinary case, not an edge case), whether it fits, and any collision — before a single
byte reaches the disk. One **Add** commits the whole batch as ONE new blob (`applyBatch`,
`POST /api/disks/[id]/files/batch`), reusing `applyDiskEdit` so it inherits the 409-when-mounted
refusal and the 404-never-403 tenancy boundary for free. Inside a disk, an entry drags onto a
folder row (`file-tree.tsx`, dnd-kit, the same `MouseSensor`/`TouchSensor` pair
`collection-provider.tsx` already paid for) or moves through "Move to…" — both paths call the
identical `moveEntry`/route, so a cycle refusal or a mounted-device 409 reads the same whichever
way the move was started.

**A deviation from the spec, recorded rather than hidden: folder ROWS are not native OS-drop
targets.** The spec describes every folder row as a drop target, with the destination pre-set
from whichever row a drop landed on. That mechanism does not exist and was not built — a native
`drop` event and dnd-kit's own drag context are two unrelated systems with no shared event, and
nothing inside a native drop handler says which rendered row the pointer was over when it fired.
What ships instead is the same CAPABILITY by a different mechanism: `DropStaging` renders a
destination `<select>` (`data-testid="drop-destination-select"`, drop-staging.tsx) listing the
disk root and every directory on the disk — built from `collectDirectories`, the identical walk
`FileTree`'s own "Move to…" menu already uses, not a second one that could disagree with it —
defaulting to the root. Every manifest path is prefixed with whichever destination is chosen
before the batch is posted. A drop itself still only ever lands on the page's one drop strip;
choosing where it goes is a separate, explicit step rather than an implicit one inferred from
pointer position.

**Fit is computed in BLOCKS, never bytes, because a byte total lies (design §3.1).** Every file
costs one header block plus `ceil(size / perBlock)` data blocks plus one extension block per 72
data blocks beyond the first — so 900 zero-byte files cost 1,800 blocks (900 header + 900 data)
to hold zero bytes of content, and a byte-only comparison against free *bytes* would wave every
one of them through. `blocksForPlan` (Task 2) is the one function both the client staging area
and the batch route call, so the two can never disagree about whether something fits — proven in
`disk-drag-drop.spec.ts` by staging exactly that 900-file drop against a blank FFS disk (1,756
free blocks) and reading `drop-total-blocks`/`drop-free-blocks`/`drop-capacity-warning` back with
the real numbers, then hitting the batch route directly with an equally-oversized manifest and
getting the identical refusal, with numbers, in the JSON body — **before `applyDiskEdit` is ever
reached, so `disks.sha256` never changes.**

**A move refuses a destination inside its own subtree (D-DD-6), and our own reader cannot see why
this matters.** `moveEntry`'s `ancestryOf` check is not redundant with `dir.ts`'s existing
hash-chain cycle guard — it is strictly worse to rely on that guard here. Measured by hand
(`write.ts`'s own comment on `moveEntry`): with the ancestry check disabled, moving a directory
into one of its own descendants unlinks the whole subtree from the real root's chain onto its own
now-orphaned descendant, and `readVolume` from `ROOT_BLOCK` afterward reports `{ warnings: [],
root: [] }` — **no warning, no error, the corrupted directory just isn't there.** The disk reads
as empty and healthy; the only way to see the cycle at all is to start a walk AT the orphaned
block directly, which no normal read path ever does. `disk-drag-drop.spec.ts` proves the refusal
fires on the real bytes (`PATCH .../files/[block]` with a descendant as `toParent` → 400,
`disks.sha256` unchanged) and that the UI never offers the destination in the first place
(`subtreeBlocks` drops it from both the drag targets and the "Move to…" `<select>`).

**`FileSystemDirectoryReader.readEntries()` hands back at most 100 entries per call (design
§3.4) — a naive single call truncates a large dropped folder at exactly 100 items, silently.**
`readDroppedItems` (`src/lib/drop-reader.ts`, Task 7) loops until an empty page comes back.
`disk-drag-drop.spec.ts`'s does-not-fit test doubles as this trap's own regression guard: its
900-file synthetic drop only produces a capacity refusal (901 staged rows, 1,801 blocks) if all
nine pages of 100 are actually read; break the loop back down to one call and the test would see
100 items, ~200 blocks, no overcapacity warning, and a disabled-commit assertion that fails.

**Playwright cannot perform a real HTML5 file drop from the operating system — no browser exposes
that to test automation, for the same reason a script cannot construct a `DragEvent` carrying a
real `DataTransfer` full of files.** `e2e/drag-drop-helpers.ts`'s `synthDrop` instead builds fake
`FileSystemEntry`-like objects (their `readEntries` deliberately paged at 100, matching the real
contract) and dispatches a plain, cancelable `Event` named "drop" with a hand-attached
`dataTransfer` — sufficient because React's synthetic event system copies `dataTransfer` straight
off whatever native event it is given, with no check that it is a genuine `DragEvent`. **What
this does NOT prove:** `webkitGetAsEntry()` itself is never exercised — there is no real OS file
system underneath any of it — so a browser- or OS-specific bug in how a genuine external drag
populates `DataTransferItemList`, or in the real File System Access implementation behind it,
would not be caught by any test built on this helper. The internal move tests (drag onto a
folder, and the mobile press-and-hold) use real pointer/touch input the whole way, since that
gesture is dnd-kit reacting to ordinary mouse/touch events, not an OS drop.

**`xdftool` does not check parent pointers, and this was already known from Task 5 — anyone
adding a future operation that touches them must not assume `pnpm adffs:verify` alone covers it.**
`xdftool`'s `list`/`write`/`delete`/`type` commands build their tree purely by walking hash
chains; amitools assigns each node's in-memory parent from that walk and never reads the on-disk
parent field back to confirm it agrees — which is exactly why `moveEntry`'s cycle guard above
cannot be "verified" by xdftool listing the result correctly, the same blind spot this project's
own reader has. `checkParentConsistency` (`scripts/adffs-verify.ts`) shells out to amitools'
`Validator`/`DirScan` library directly (not the `xdfscan` CLI, which crashes on this machine
under Python 3.8+ — a removed `time.clock()` call) as a second, structurally independent opinion
that actually reads that field. Both OFS and FFS move checks in `pnpm adffs:verify` end with
"amitools agrees every parent pointer is consistent"; a validator that cannot be reached fails
loudly rather than being silently skipped. This check exists ONLY for `moveEntry`'s move ops —
the batch route's `mkdir`/`add`/`replace` never touch a parent pointer, so they are not covered by
it and did not need to be.

**Four operator rulings, recorded in the spec:**
- **D-DD-1.** The drop zone is the source and the disk is the destination, stacked vertically —
  a side-by-side pane would need its own phone layout; stacked, one layout serves both.
- **D-DD-2.** Dropping stages; it never writes. An 880KB disk means a dropped folder often will
  not fit, and staging turns a failure after the fact into a refusal with real numbers before it
  — and lets several drops commit together as one blob.
- **D-DD-4.** Over-long names are shortened visibly; collisions are never resolved automatically.
  A collision offers skip, replace or rename per row and blocks the commit until resolved — the
  operator's own disks must never be silently overwritten. `disk-drag-drop.spec.ts` proves both
  halves: the commit stays disabled with an outstanding collision, and **replace** genuinely
  replaces (same header block, per D-W-6, new content).
- **The together-in-one-increment scope call.** Dropping-in and dragging-around were built as one
  increment rather than two, because they are the same gesture pointed in two directions sharing
  one drag context and one set of drop targets — a page that accepted drags from outside but not
  within would read as broken, and building them separately risked exactly that half-finished
  state shipping first.

**Suite:** 566 vitest (549 at the original 11-task ship, plus the whole-branch review's own fixes
and their tests above), `pnpm build` clean, lint at the 3-error baseline (unchanged; nothing in
this increment's files), `pnpm adffs:verify` 119 checks including both OFS and FFS's amitools
parent-consistency validation. Per this task's own instructions only its own Playwright specs
were run, not the full suite: `disk-drag-drop.spec.ts` 6/6 on `--project=desktop`, and the
`mobile` project 8/8 (7 pre-existing plus this task's own drop-strip/press-and-hold-drag test) —
both clean on a freshly-confirmed port 3000, no re-runs needed. The operator runs the full suite
separately.

### 4. Backlog, not blocking anything

- ~~**Make uploads faster by reusing the TLS connection**~~ **DONE 2026-09-21 — see 4k.** Keep-alive
  shipped; session tickets were tried, measured wrong, and cannot work in this mbedTLS build.
  The original entry, for the reasoning it records: Every request
  the board makes is its own connection: `dc_exchange()` connects, writes, reads and closes.
  Measured on hardware (§4i): ~1.1 s of TLS handshake per request, so ~1.6 s per uploaded track
  and ~2.7 s for a close. A whole-disk write would be 160 handshakes. Worth trying, cheapest
  first: mbedTLS **session resumption** (keep the session ticket between connections, which
  skips the expensive half of the handshake), then **keep-alive** — the requests already say
  `Connection: keep-alive`, but nothing reuses the socket, and the server is Vercel, so a pooled
  connection may be closed under the board at any time; whatever is built has to treat a
  half-closed socket as an ordinary retry, not an error. The write path's correctness does not
  depend on this: seq numbering and the close already converge through retries (§4g).

- ~~**The upload page should lose its Mount column**~~ **DONE 2026-09-20.** On the ingest
  screen it serves no purpose: people organise what they have just uploaded, and only mount
  afterwards, from the library or the game page. Removing the column also removes the mount
  controls from a screen where the disks are still being sorted out.

- ~~**The library's category cards should be square, with a mosaic of cover art**~~ **DONE
  2026-09-21 — see 3ah.** The original request: "The main library page, when everything is
  organized, looks bare with the categories as cards -- it would be nice if they were square and displayed a mosaic of main
  title images of the floppies below it." Nothing is built. The covers are already on the cards'
  own children (the grid shows real cover art, see 3h), so this is a layout and query question,
  not a new data source: the card needs the first few covers under that category, and a square
  aspect the grid can hold at every breakpoint. Note what "below it" means -- a category can
  contain collections as well as games, so decide whether the mosaic reaches through them.

- ~~**Drop .lha and .zip onto a disk and pick files out of them.**~~ **DONE 2026-09-11 — see 3ae.** Requested:
  "most are distributed like this (from aminet typically), so many times you want to pick a
  few files out of archives". Cap the archive at ~25 MB.

  **Where it goes: nowhere new.** The operator flagged that the create/edit ADF UX is not
  settled and asked for an assessment -- and the assessment is that this needs no new surface.
  `readDroppedItems()` (drop-reader.ts) already turns a dropped FOLDER into a flat list of
  `{path, File}` by walking it client-side, and `stageDrop()` turns that into staged rows with
  collision verdicts. **An archive is the same thing: a container of paths and bytes.** Expand
  it into `DroppedItem[]` at the same point and the entire existing pipeline applies unchanged
  -- the staging area, the destination selector, per-row rename/skip/replace, the Latin-1 and
  AmigaDOS-character masking from 3v's F3 finding, and the block-based free-space estimate.
  That also keeps it in the surface the operator already said was the part worth keeping
  ("the staging area is a good idea I think", 3v).

  **The one genuine UI addition is per-row INCLUDE.** A folder drop stages everything, which
  is right for a folder; an archive is explicitly "pick a few files out of", which the staging
  area cannot express today -- skip/replace resolve a collision, they do not decline an entry.
  Expect select-all / select-none and probably a filter, because a 25 MB archive can be
  hundreds of rows where a folder drop is usually a handful.

  **.zip is easy; .lha is the whole job.** Zip is a solved problem in the browser (fflate).
  LHA/LZH is niche, and Aminet is overwhelmingly .lha -- so this item lives or dies on an LZH
  decoder. Aminet archives are almost all `-lh5-`, with some `-lh0-` (stored); implementing
  those two probably covers the archive, and it is worth MEASURING that across a sample of
  real Aminet files before committing to a library or writing one. Do it client-side like
  drop-reader already does: it keeps 25 MB off the server entirely and sidesteps the function
  body limit.

  **Two different limits, do not conflate them.** The ~25 MB cap protects the BROWSER (decode
  time and memory). It says nothing about whether the files fit: an ADF is 880 KB, so even a
  large archive can only ever contribute a fraction of itself, and what decides that is the
  existing block-based estimate -- built in 3v precisely because bytes lie about whether a
  folder fits, since a hundred 1 KB files cost 300 blocks to hold 100 KB.

  Out of scope unless asked: .lha file comments and Amiga protection bits, and nested archives.

- ~~**DEMOZOO: assessed 2026-09-13, NOT a quick add -- and the design decision is already
  made for you if you want it to be.**~~ **DONE 2026-09-14 — see 3af.** Complements TOSEC for
  everything that is not a game (demos, intros, diskmags, musicdisks, tools): a weekly bulk
  import, a nightly matching phase, automatic links, a suggestion review queue, screenshots.
  The two 2026-09-13/14 spikes that justified building it (daily bulk dump needs no Postgres
  restore; title matching is dangerous on games but works at ~89% precision on demos) are
  superseded by 3af's acceptance numbers against the real matcher and the live library —
  see there for the full account, the timing gate, and what stayed out of scope.

- **Enrich demos and applications from a source that actually has them.** Measured 2026-09-11
  (see 3ad): of the TOSEC-identified blobs OpenRetro cannot enrich, essentially all are
  demoscene productions -- 9 Fingers, State of the Art, Global Trash, Wayfarer, Ray of Hope 2
  -- or applications, World Construction Set. OpenRetro is a games database and no amount of
  matcher cleverness changes that. **Demozoo has a public API and covers exactly this
  material**; Pouet is the other candidate. This, not more OpenRetro work, is what would put
  titles and screenshots on the majority of THIS archive. Whoever picks it up should measure
  coverage first the way 3ad did, before building anything.

- ~~**Devices cannot be named, and the mount picker makes that hurt.**~~ **DONE 2026-09-11 — see 3ac.** Found while
  building the per-device mount UI (3ab), by an e2e assertion that expected the name it had
  just passed to `pairDevice` and got `Device 12:E0:DD:C6:5D:65` instead.

  `/api/devices/pair` ACCEPTS a `name` (zod-validated, 1-100 chars) and then throws it away:
  `pairing_codes` has no column to hold it, so `register/route.ts` falls back to labelling
  the device by its MAC. Its own comment says so. Nothing caught it because no test had ever
  asserted a device's displayed name -- `game-detail.spec.ts` passes 'Device A'/'Device B'
  and only ever checks testids, which are keyed on ids.

  It did not matter while the only device list was `/devices`, where a MAC is a reasonable
  identifier. It matters now: 3ab's whole point is choosing a drive from the library, and a
  column of same-shaped MACs is the worst possible thing to choose between. With one device
  it is invisible; the operator's fleet is about to be larger than one.

  **THE "NEEDS A MIGRATION" CLAIM WAS WRONG, and it is the reason this sat in the backlog
  overnight.** It is true only of naming at PAIRING time, which is where I was looking --
  `pairing_codes` has no column. An alias edited AFTER the fact needs no schema change at
  all: `devices.name` is already a NOT NULL text column, already what every surface renders,
  and `devices.macAddress` is separate so the identity survives a rename. The operator saw
  that immediately ("just having an alias field under each device... would solve this easy"),
  and was right. The lesson is narrow and worth keeping: **I priced the fix from the design I
  had happened to examine, not from the one that was cheapest**, and a wrong cost estimate
  parked a small job for a night.

- **Drive an I2C OLED from the PIM726 board.** The operator has one to hand (2026-09-11).
  Same underlying need as the activity-LED item below -- see what the drive is doing without
  a terminal -- so design the two together rather than separately: an LED is instant and
  costs nothing at the moment of a track read, while an OLED can carry state the LED cannot
  (SSID and IP, mounted title, fetch progress, "retrying"). They complement each other; the
  LED is not made redundant by the display.

  **Time it against rev B while that is still unfabricated**, same as the LED item: two free
  GPIOs plus a 4-pin header (3V3/GND/SDA/SCL) is a layout change now and a respin later.
  RP2350 has two I2C blocks, and most of these panels are SSD1306 or SH1106.

  **The one real hazard, and it is the lesson of 3x and 3z combined: do NOT drive it from
  core0's service loop.** That loop sleeps 1 ms and services track changes in real time; a
  full-frame I2C write to an SSD1306 at 400 kHz is ~1 KB of payload and takes on the order of
  20 ms. Rendering there would stall the floppy exactly as a flood of USB writes would.
  Core1 already blocks for tens of seconds in a long-poll, so it cannot own a responsive
  display either -- this probably wants its own bounded, incremental update driven from
  core0's loop a few bytes at a time, or a deliberate decision that the display only refreshes
  when the floppy is idle.

  **A design point that is easy to miss:** `wf_log_drain()` CONSUMES records and hands them
  to a single sink. A display that drains the ring competes with the USB console -- attach a
  terminal and the screen goes blank, or vice versa. Either give the display its own tap
  (peek rather than consume) or feed it from the state it wants to show directly, not from
  the log.

- **DONE, AND VERIFIED ON HARDWARE (2026-09-11): the OLED shows status, the disk's
  name, and the track.** Operator-confirmed against a real mount and a real eject:
  DOWNLOAD with a live percentage, VERIFY, LOADED naming the disk, and back to READY
  on eject. `src/display.c` (pure, host-tested), `src/ssd1306.c` (transport),
  `dc_set_observer` (the seam), and core0's loop.

  **The layout, on 128x32:**

      ((o)) LOADED         [lock] [lemming]
      Sensible Soccer
      Disk 1/2 Boot        12/79

  A wifi glyph with signal strength; a status word; the disk name wrapped over two
  lines at a word break; the track counter as "0/79"; the WRITE STATE; and a walking
  lemming in the top-right.

  **The write state is a padlock or a pencil, never an absent icon.** Operator-verified
  2026-09-13. It is read-only on every disk today (WPROT is asserted while
  `WRITE_BACK_IMPLEMENTED` is 0), so the padlock is what you see, and the pencil
  appearing is precisely the signal that the write switch has been thrown. It is driven
  by the same expression that drives the WPROT pin, never a second opinion about it: a
  pencil that disagreed with the pin would be worse than none, because it would be
  believed.

  **The first version drew the pencil only when writable and nothing otherwise, and that
  was wrong** -- the panel showed a blank, which cannot be told apart from a firmware
  with no such indicator. `draw_wifi()` one function away already handles this correctly
  (no radio is a STRUCK glyph, not a blank), and the rule was simply not carried across.
  A state worth showing is worth showing in both of its values; the test now asserts both
  light pixels and that the two differ, which the broken version would have passed. The counter is drawn BEFORE the detail label beside it and the label is
  clipped against it, never the reverse -- a half-drawn "12/79" is a lie about which
  track is being read, where a clipped label is only shorter.

  **The lemming is not only decoration.** Every other field is static between events,
  so a hung board and an idle one look identical on this panel; a lemming that has
  stopped walking is a service loop that has stopped turning. It is the only liveness
  signal there is. Two frames, because what reads as walking at 8 px is the body BOB
  against the leg phase, not extra leg positions -- the four-frame first attempt had
  two identical frames and read as a bounce. A frame change dirties only the sprite's
  own 8 columns of one page (tested), so a step is a single pump call even at the
  mounted budget; without that property every step would redraw the title and the
  counter on the core servicing the floppy bus.

  **Where it runs is the whole design, and the obvious answer is wrong.** Core1 owns
  the network and therefore knows DOWNLOAD, LOADED and the disk's name -- but it blocks
  for tens of seconds inside dc_step's long poll, so a counter fed from there would
  freeze mid-seek for exactly that long. The counter is core0 state, so core0 drives
  the panel; and core0 cannot afford a frame (512 bytes is ~11 ms at 400 kHz against a
  1 ms loop -- the same stall the USB flood caused in 3x). Hence: framebuffer in RAM,
  only CHANGED bytes sent, bounded slice per iteration (12 bytes ~450 us while mounted,
  96 when idle, because the real-time duty exists only while the Amiga can be reading).
  A track step moves under 40 bytes. Core1 publishes through a seqlock and never
  touches I2C. **Nothing here drains wf_log** -- the hazard this entry used to warn
  about; it reads state directly, so attaching a terminal cannot blank the screen.

  **The disk name needed no server change and no protocol change.** The poll body has
  carried `game`, `label`, `diskNo` and `diskCount` since src/lib/mount.ts was written;
  the device parsed the digest and discarded the rest. Worth remembering as a pattern:
  the missing feature was a field already on the wire.

  **STILL UNVERIFIED: the track counter.** Nothing generates STEP pulses until the
  Amiga is on the cable. The rendering and the wiring are host-tested; that the
  counter follows a real seek is not, and must not be recorded as working until it is.

  **Where to pick this up.** `src/display.c` is pure and host-tested -- layout, font,
  truncation, the counter's format, the pump's budget and its retry-on-failure -- so
  anything about WHAT is shown is changed there and judged by `./test/run.sh`, not by
  looking at the panel. `test/test_display.c --dump` prints the frames as ASCII art
  for the one thing no assertion can judge, which is whether a glyph is legible; run
  it whenever the font or a sprite changes. `src/ssd1306.c` is only how bytes reach
  the glass. If a new field is wanted, the question to answer first is which core
  knows it: core1 publishes through `ui_publish` (seqlock, main.c), core0 owns
  anything the floppy side knows and is the only core that may touch I2C.

- **THE PANEL IS DRAWING, AND IT IS 128x32 (2026-09-11).** Verified on hardware at 0x3c on
  i2c1: a frame on all four edges plus corner-to-corner diagonals, closed and unbroken.
  That covers the whole path -- bus, address, charge pump, geometry, row mapping -- which a
  probe's ACK does not: an ACK survives a panel whose data line works one way, a controller
  that decodes its address and nothing else, and a display with no charge pump.
  `src/ssd1306.c` holds the self-test; it is NOT the driver, and the hazards below still
  govern what a driver may do.

  **The panel is 128x32, not the 128x64 that every SSD1306 example initialises**, and getting
  that wrong does not fail. The controller scans 64 COM lines onto glass that has 32, so half
  the pages land nowhere and `0xDA 0x12` interleaves the rest; the panel shows SOME of what
  you drew. It reads as a damaged display. It cost a swapped panel, a reversed-polarity short
  that had the board suspected dead, and an ENTIRE-DISPLAY-ON probe -- and none of those could
  have produced the answer, because the fault was geometry and geometry is printed on the part.
  `HEIGHT` is now the one constant that `0xA8`, `0xDA`, the page window and the test pattern
  all derive from. **Ask for a partially-drawing panel's dimensions before probing it.**

  **The second lesson is about the test, not the panel.** Four patterns in a row asked the
  operator to COUNT features, and every answer was ambiguous -- "bottom bar missing",
  "shifted down one row", "8 blocks", "only one line", "3 lines" where 5 were drawn. The last
  one was a correct panel: lines one row apart are ~0.4 mm on a 0.91" display and the eye
  merges them, so pass and fail looked alike. A hardware self-test whose result a human must
  resolve at sub-millimetre scale is not a test. Frame-and-X replaced it because it is
  answerable at a glance, and the diagonals are what a frame cannot do: wrong COM mapping
  reorders rows, breaking a straight stroke into a staircase while the frame still looks fine.

- **PINS ARE CHOSEN AND THE FIRMWARE SIDE IS BUILT (2026-09-11).** `GP22` (header pin 29) for
  the activity LED, `GP18`/`GP19` (pins 24/25) for I2C1 SDA/SCL. All three are bare, unrouted
  through-holes in U1's footprint on rev A2, so this needs NO board change -- Dupont leads onto
  the header pins that pass through the top. GND is pin 23 (adjacent to SDA) and 3V3 is pin 36.
  `src/floppy_io.h` carries the full reasoning; `src/activity_led.c` and `src/i2c_probe.c` carry
  the code. What remains below is the hardware itself.

  **BOTH HALVES ARE NOW VERIFIED ON HARDWARE.** The I2C panel draws (2026-09-11) and the
  activity LED on GP22 lights (operator, 2026-09-12). That closes every bring-up item on this
  board except the floppy side itself.

  **One electrical caveat, and rev B is the moment to act on it.** The bench LED is wired with
  NO series resistor, which this pinout assumes. It lights; that is not the same as being in
  spec. Nothing then limits the current except the pad's own output impedance against the LED's
  forward voltage -- the 4 mA default is a guaranteed drive at a specified VOH, not a current
  limit. `led_init()` now asks for GPIO_DRIVE_STRENGTH_2MA, which roughly halves it: a
  mitigation, not a fix. What has kept it benign is duty cycle rather than margin (a blip is
  40 ms and events are sparse), and that stops being true during a seek, where a STEP every
  ~3 ms makes overlapping blips a continuously lit LED -- so the worst electrical case is also
  the common one. **Rev B is unfabricated: the resistor footprint is free now and a respin
  later.**

  **The trap worth knowing before moving these:** GP14-GP17 (pins 19-22) are the only other
  free GPIOs and ALL FOUR are unusable. The existing comment warns only about pins 19/20, but
  the antenna keepout spans both header rows and the east row mirrors the west, so pins 21/22
  (GP16/GP17) land at the same y. The keepout allows pads and forbids tracks and vias, so
  nothing can be routed to them -- and being the antenna end, they are equally wrong for
  flying leads.

  **Two hazards, both able to damage something:** the PIM726's Qw/ST connector is hardwired to
  GP4/GP5, which on this board are MTR and DIR -- plugging a Qwiic device in contends with the
  floppy bus, so the panel goes on the header, never the connector. And the OLED must be
  powered from 3V3 (pin 36), never VSYS/VBUS: SSD1306 modules pull SDA/SCL up to their own VCC
  and **RP2350 GPIOs are not 5V tolerant**.

- **LEDs on the wifi-floppy board, at minimum a track-activity LED.** Requested by the
  operator 2026-09-11. The point is to see the drive doing something without a console
  attached -- which is the ordinary case, since `wf_log` only reaches a terminal over USB
  CDC and holds its records until one attaches (3x).

  **Time this against rev B, which is CURRENT AND UNFABRICATED** -- adding LEDs now costs a
  layout change and nothing else, whereas after a fab run it costs a spin. Note 3s's standing
  caveat that the operator was holding the antenna keepout extension "until a board is known
  to work"; as of 3y and 3z a board IS known to work, so that hold can be revisited in the
  same pass.

  The firmware side is nearly free: `wf_trace()` already fires `WF_EV_TRACK_SERVED` on every
  track change and is interrupt-safe by construction (integer event codes, no formatting, in
  SRAM), so an activity blink is a GPIO toggle at an existing call site. What needs deciding
  is the hardware: which free GPIOs, and how many LEDs -- activity alone, or activity plus
  link/mounted, which would make the whole state machine in 3y visible without a terminal.
  A mounted/idle indicator would also cover the case 3z made obvious, where a fetch is
  silently retrying every ~35 s and nothing outward says so.

- **The disk "mount" button should target a device explicitly.** Requested by the operator
  2026-09-11, right after the first successful hardware mount. Today mounting is
  device-implicit; it should present the org's **list of devices** and show **mounted status
  per device**, so you pick which drive receives the disk and can see at a glance what each
  one is currently holding.

  Worth knowing before designing it: the data is already there and already correctly scoped.
  `devices` carries `orgId`, `mountedSha256`, `mountedDiskId`, `mountedVersion` and
  `lastSeenAt` (`src/db/schema/devices.ts`), `listDevices(orgId)` is what `/devices` already
  renders, and every device endpoint is org-scoped -- so this is a UI and mount-target
  change, not a tenancy change. `src/lib/mount.ts`'s `setDesired` is the write path.

  Two things the hardware now says about the UX: a mount takes **~4-6 s end to end** (TLS
  handshake plus a ~2 MB transfer), so the button wants a pending state rather than
  optimistic success; and a device only converges on its next poll, which is a long-poll of
  up to `DC_POLL_TIMEOUT_MS`. "Mounted" should mean the device reported it (`mountedSha256`
  came back), not that we asked -- 3y's status heartbeat is what makes that observable.

- ~~**Every wifi-floppy as a small floppy chip beside the top menu, each with a caret menu.**~~
  **DONE 2026-09-25 as "drive chips"** (status table). No floppy pictogram (operator dropped the
  drawings in the device-card round). The original entry follows.
  Requested by the operator 2026-09-22. One small floppy symbol per paired device, next to the
  `TopNav` pill, and a caret on each opening a menu with three actions: **go to the mounted
  floppy**, **eject**, and **writable / protected**. It is quick access only: **`/devices`
  stays where devices are managed** (pairing, alias, firmware, unpairing), and the operator was
  explicit that this does not change.

  **Nothing new on the server.** All three actions already exist as endpoints the app uses:
  `POST /api/devices/[id]/eject` (`EjectButton`), `PATCH /api/disks/[id]` with
  `{ writeProtected }` (`WriteProtectToggle`), and the disk page for "go to". The flip reaches a
  board that holds the disk since 4j. The work is a layout query, a client component, and
  keeping the chips fresh.

  **Things to settle before building it:**
  - **Write protection belongs to the DISK, not the device.** The toggle in a device's menu
    flips `disks.write_protected` on the disk that device has mounted, so it also changes on the
    disk's own page, and on any other board holding the same disk. Word the menu item so it
    reads as the disk's state, and turn it off when nothing is mounted. "Go to" and "eject"
    are turned off when the drive is empty too.
  - **Show both values of every state on the chip itself**
    ([[show-both-values-of-a-state]] in memory): online or offline, empty or loaded, protected
    or writable. An icon that just isn't there is not a reading. Show the device alias in a
    tooltip and at the top of the menu, because several identical floppies say nothing on their
    own.
  - **"Mounted" means the board reported it** (`mountedSha256` came back), not that we asked,
    the same rule as the mount-target entry above. Eject converges on the board's next poll
    (up to ~25 s) and a mount takes ~4-6 s, so the chip needs a pending state rather than
    showing success optimistically.
  - **Freshness.** The `(app)` layout renders on the server and `TopNav` is a client component
    that is handed its props. Today nothing refreshes a layout on its own, so a chip would be
    stale until the next navigation. Decide how it updates, whether by polling a small
    org-scoped read or by refreshing after the chip's own actions, and keep in mind that it
    runs on every page.
  - **Phones.** Below `sm` the nav is a fixed bottom bar, and the pill already scrolls with four
    items at 390 px. The chips need somewhere else to go on a phone, or a single "drives"
    chip, rather than a fifth-plus item in that bar. Also decide what happens with many boards:
    show N chips, then a "+k" overflow.
  - **Eject is outward-facing.** It pulls a disk out from under a running Amiga. The per-device
    `EjectButton` on `/devices` has no confirmation, so match that, but the caret menu puts it
    one mis-click from the other two actions. Worth a second look when it's built.
  - The chip must stay out of the admin plane's layout. Devices are org-scoped, and `(admin)`
    has its own nav.

- ~~**BUG: the Devices header's "N online" never shows the real count.**~~ **NOT A BUG, CLOSED 2026-09-23.** The count was correct: the report came in at 20:25 on 2026-09-22, while the board was being restored from its flash backup and really was offline. Measured: the page's own `listDevices` + `isOnline` against the live DB said online; two new e2e tests in `devices-page.spec.ts` prove the header follows a device coming online (offline to online) AND going quiet with no data change (online to stale after 60 s) while the page is open; and the operator confirmed production shows the right count. The original entry follows for the record. Reported by the operator
  2026-09-22: it reads "0 online" while a board is up. **It is meant to be live, and the data
  is right**, so the bug is in between. What was checked the same day:
  - The board heartbeats every ~25 s. Sampled `last_seen_at` ages were 1-22 s, on production
    firmware `1.0.0+gf53ad10`. So `isOnline()` (`src/lib/device-state.ts`, 60 s window) would
    say 1.
  - `DevicesPage` computes the count on the server from that predicate at render time
    (`src/app/(app)/devices/page.tsx`), and `next.config.ts` enables no caching.
  - The live fingerprint (`src/lib/live-state.ts`) already includes the online/offline
    boundary, and `live-state.test.ts` tests that it flips. So the test covers the design, not
    whatever is actually going wrong.

  **Start by reproducing it on production with the board online, and measure before
  fixing.** Things to rule out:
  - whether `/api/live-state` is actually polled on `/devices`
  - whether the fingerprint the page is born with is computed the same way the route computes
    it
  - whether the page reads `lastSeenAt` through the same `listDevices` the fingerprint sees
  - whether the render's `now` and the database clock disagree

  The cards' own "online" wording and the header must stay one predicate. Fix the path, not
  the count.

- ~~**Devices page: square, floppy-disk-looking cards instead of full-width rows.**~~ **DONE 2026-09-24** (master 5343934). The operator dropped the floppy DRAWINGS after seeing mockups ("not fond of the icons"): plain minimal square cards, 3 per row on desktop and 2 per row on a phone. Layout A puts the disk in the middle: name + Online/Offline badge on top, the mounted disk as big text, then Protected/Writable ("—" when empty or mid-mount), firmware, select, Eject. `listDevices` gained `mountedWriteProtected` (org-scoped join), and the live fingerprint now carries it plus "last seen" for every offline card. A browser-measured review caught the name vanishing and page overflow at 390 px before merge. Full e2e 332/332. **The menu floppy chips (entry above) were deliberately left out of this round.** Original entry follows. Requested by
  the operator 2026-09-22. Today each board is a full-width card with Eject at the far right,
  which spends the width on nothing. Lay them out as a grid of squares that look like floppy
  disks, the same visual idea as the library's square category cards (3ah) and the floppy
  chips beside the top menu (entry above), so a board reads as a drive everywhere in the app.

  **What a square has to carry, all of which the current card already shows:** alias, online
  or offline, the mounted disk (or empty), write protection, the firmware line with its five
  states, the update state and its Cancel, the checkbox from §3aj's multi-select, and Eject.
  Of these, the firmware and update wording is the longest text and will set the minimum
  square size. Measure it at 390 px before choosing the grid. Show both values of every
  state: an empty drive and a read-only disk must be visible states,
  not missing icons. Eject stays, just not stretched across the page. `/devices` remains where
  pairing, alias and firmware are managed.

- ~~**Make the app usable on a phone.**~~ **DONE 2026-09-02**, merged and live — see 3j.
  Requested by the operator 2026-09-01. The two notes below are kept because they were the
  hard parts and both are now settled:

  **The dnd-kit touch hazard was real, and worse than the note predicted.** It was not enough
  to add a `TouchSensor`: `PointerSensor` keys on `pointerdown` with no `pointerType` check,
  so the two double-activate. `PointerSensor` is **replaced** by `MouseSensor`, and the delay
  lives on the touch path only — the existing drag specs move without holding, so a delay on
  the mouse path breaks all of them.

  **The suite now has two projects.** `desktop` sets no viewport, so it keeps inheriting the
  1280×720 default every existing spec was written against; `mobile` is 390×844 with
  `hasTouch` and matches only `e2e/mobile.spec.ts`. Five tests, not a duplicated suite.

- ~~**A unified breadcrumb, replacing the per-page eyebrow and the hand-written back links.**~~
  **DONE 2026-09-03**, see 3l. The entry's central question — whether the trail carries the
  collection you came from — was answered by the operator: the root is hardcoded "Library", so
  it does not.

- ~~**The breadcrumb should lead back to the collection you came from.**~~ **DONE 2026-09-04**,
  see 3r. The entry listed three mechanisms; `document.referrer` was measured and found empty
  after a client-side navigation, so `?from=` was the only one that could name the destination.

- **Write-back and layered disks** (disk-change spec §5). Deliberately not designed yet;
  the first increment should record which tracks changed, not just a flattened result, so
  it doesn't foreclose the layered approach.

  **PRIORITISED BY THE OPERATOR 2026-09-13: write support goes first, ahead of the
  networking entry below.** It is now load-bearing for two features rather than one -- see
  "Amiga networking over the floppy port", which cannot begin without it.

  **STARTED 2026-09-13. The capture path is built and the decode is verified on the host;
  nothing is applied to a disk yet.** What exists:

  * `src/mfm.c` -- sector decode from captured MFM: sync scan, both checksums, recovery into
    an ADF track. Tested against the golden tracks in `src/lib/adfmfm/fixtures` (the
    TypeScript encoder's output, asserted byte-identical to Greaseweazle) with the expected
    data regenerated independently in C from synthetic.ts's xorshift32.
  * `src/flux_bits.c` -- intervals to an MFM bitstream. Tested end to end: a golden track is
    turned into the intervals a drive would produce, fed back, decoded, and must give back
    the bytes that were encoded, including under +-8% speed error.
  * `src/flux_capture.c` -- the PIO/DMA half. Device-only and excluded from the host build,
    because only a floppy bus can exercise a state machine; every DECISION was deliberately
    kept out of it so that "untestable" covers register writes and nothing else.
  * `main.c` -- WGATE arms and disarms the capture, the service loop drains it bounded, and
    a finished capture is LOGGED. `WF_EV_WGATE` now fires.

  **THE SWITCH IS NOT THROWN.** WPROT is asserted for every mounted disk
  (`WRITE_BACK_IMPLEMENTED`), so the Amiga refuses to write and WGATE never goes active.
  Nothing captures in the field until that changes, which is one line and deliberately not
  done: the disk the Amiga is reading must not start changing underneath it before a real
  capture has been seen to be correct, and the history model below is not designed.

  **What remains, in order:** (1) connect the Amiga and watch a real write produce
  `write: trk N ... sectors 0x7ff (all 11)` in the log -- the capture is unproven until a
  real drive's flux has been through it; (2) design the history model, since the operator
  wants a TIME MACHINE (below) and that decides what a write even stores; (3) only then
  release WPROT and apply anything.

  **THE OPERATOR WANTS A TIME MACHINE (2026-09-13): rewind through an ADF's history.** That
  is a requirement on the storage model, not a feature to add afterwards, and it is why this
  entry has always said to record WHICH TRACKS CHANGED rather than a flattened result. The
  shape it argues for: an append-only log of per-write deltas against the original digest,
  where a version is the base plus an ordered run of deltas and rewinding is materialising a
  prefix of them. Sector-level granularity (512 bytes, the Amiga's own unit) rather than
  whole tracks, because a track write rewrites 5,632 bytes to change one sector's worth.
  Nothing here is built; it needs designing before any write is applied, because the first
  increment that flattens a write forecloses it.

- ~~**Automatic firmware updates for devices, behind a password confirmation.**~~ **DONE AND
  CLOSED 2026-09-25** (3ai, 3aj, 3ak). The operator ruled the password-confirmed Update button
  is the finished feature: the per-device auto-update opt-in below is NOT to be built. The
  original entry follows for the threat model. Requested by the operator 2026-09-13.

  **TREAT THIS AS THE MOST DANGEROUS FEATURE IN THE PRODUCT, because it is remote code
  execution on hardware in someone's home, by design.** Everything else here can at worst
  corrupt a disk image. This can turn the fleet into a botnet or brick every board at once,
  and a bricked board recovers only by physically unplugging it and holding BOOTSEL --
  which, for a device under a desk beside an Amiga, means the owner has to crawl under it.
  Design the threat model FIRST and the convenience second.

  **SIGN THE IMAGE WITH A KEY THAT IS NOT ON THE SERVER.** This is the one control that
  matters and the one it would be easiest to skip, because TLS already feels like enough.
  It is not: TLS protects the wire, and the device already verifies the server's chain
  against pinned roots, but neither does anything about a compromised Vercel account or a
  poisoned deploy pipeline. With releases signed offline and the public key compiled into
  the firmware, whoever owns the pipeline can push a STALE image; without it they own every
  board in the field, permanently and silently. Anti-rollback (refuse an image older than
  the running one) closes the stale-image case.

  **A/B slots, not in-place.** Flash is 16 MB on the PIM726 and the image is ~505 KB, so a
  second slot costs nothing worth counting, while an in-place write means a power cut
  mid-flash is a brick. The new slot is marked good only after it has booted AND associated
  AND completed one poll -- a watchdog-confirmed boot, with the bootloader falling back
  otherwise. An update that cannot verify itself is worse than no update.

  **NEVER FLASH WHILE A DISK IS MOUNTED.** A flash write disables XIP, and the argument in
  main.c above `dma_irq` spells out what that costs: `flash_safe_execute` parks core0
  entirely -- interrupts off, nothing executing -- for the duration of the write. That is
  survivable for a 4 KB token write and not survivable for 500 KB while the Amiga is reading
  a track. Gate updates on nothing being mounted and, ideally, the motor being off.

  **What already exists, so nobody rebuilds it:** TLS with pinned roots and the
  fetch-then-verify-then-publish discipline from `dc_fetch_image` (which is exactly the
  shape an update wants); `flash_safe_execute_core_init()` already called in main() and
  already relied on by `config_store` and `token_store`; `pico_flash`/`hardware_flash`
  already linked; ~3.7 MB of free PSRAM to stage a download into, which makes a power cut
  mid-DOWNLOAD harmless because nothing has touched flash yet; and the poll loop as the
  natural place to learn an update exists.

  **The password confirmation the operator asked for is step-up auth, and it is worth being
  precise about what it buys.** better-auth is configured with `emailAndPassword` enabled
  (src/lib/auth.ts), so re-prompting for the password is available today. It defends against
  a stolen session cookie -- someone with your laptop cannot silently reflash your hardware
  -- and it defends against nothing else. It is NOT a substitute for the signature: a
  compromised server can skip the prompt entirely. Time-box the elevated window (minutes,
  not the session), and require it per update rather than once per login.

  **Also worth having:** pinning a device to a version (so one board can stay behind while
  the rest move) and staged rollout.

  **CORRECTION, and it changes what the work is.** An earlier draft of this entry said
  "nothing on the web side knows what firmware a device is running". That was wrong, and
  checking took one grep: the device sends `firmwareVersion` in its REGISTRATION body
  (`dc_register`, from the compile-time `FIRMWARE_VERSION` in CMakeLists.txt), the server
  stores it in `devices.firmware_version`, and `device-card.tsx` already renders it as
  "fw <version>". The plumbing exists end to end.

  **The actual gap was that it was captured ONCE, at pairing.** The status heartbeat
  carried mountedDiskId, desired version, error, psramFree and rssi -- not the firmware
  version -- and a device does not re-register after an update. So the value shown in the
  Devices tab was whatever the board had when it was paired, and went stale the first time
  anyone reflashed. That is worse than showing nothing, because it looks authoritative.

  **BOTH of the two small pieces below are DONE as of 2026-09-22 (§3ai).** The heartbeat
  carries the version, and the version identifies a build. Read §3ai, not this paragraph,
  for what actually exists; the two items are kept here because they explain why:

  1. Add `firmwareVersion` to the status report -- firmware side in `dc_report_status`,
     server side one more optional field in the status schema and `recordStatus`. The
     heartbeat's own spec note already says "send everything the firmware knows, every
     time", so this is closing a gap rather than adding a concept.
  2. **Make the version identify a build.** It has read `4b.0` throughout every firmware
     change in this file's history, including the whole display, capture and decoder work,
     so today it distinguishes nothing. A version that does not change when the image does
     cannot support rollout, rollback or anti-rollback, all three of which the update design
     above depends on.

  **RP2350 hardware secure boot is a ONE-WAY DOOR** (it burns OTP fuses) and should not be
  part of a first increment. Note it, do not reach for it until the software path has been
  proven on boards that can still be recovered.

  **AUTOMATIC UPDATES SHIP OFF. OPT-IN, per device** (operator's decision, 2026-09-13 --
  reversing an earlier default-on reading of the same conversation, so do not "restore" it).
  A board never reflashes itself until someone has said it may.

  * **"Off" means the device never updates ITSELF.** A manual update stays available, behind
    the same password confirmation. That is the distinction worth drawing: the objection
    people have is to hardware changing under them unannounced, not to updating at all.
  * **A setting that gets overridden is not a setting.** There will be a temptation to force
    "critical security updates" through regardless. Do not. If someone has said no, the
    answer is to tell them loudly -- in the Devices tab, and on the panel -- that an update
    is waiting and why it matters. Silently updating a device whose owner declined is the
    thing that makes people distrust every other switch in the product.
  * **Per device. Operator-confirmed 2026-09-13 as the right granularity**, so each board is
    enabled or disabled for updates on its own. Keeping one pinned while the rest move is
    the ordinary case: it is how you keep a known-good device beside an Amiga that matters
    while trying a new build on another. An org-wide default may sit underneath it, but the
    per-device setting is the one that decides. The Devices tab should show, at a glance,
    which boards are opted out and which are behind -- an invisible opt-out becomes a fleet
    nobody realises is stale.

    **The default is OFF.** Recorded explicitly because a default is exactly what drifts
    when a setting is built months after it is specified.

    **What opt-in costs, and therefore what it obliges:** most boards will never be
    enrolled, because most people never visit a settings page -- so the fleet's normal state
    is stale, and "there is an update" has to reach someone who is not looking for it. That
    makes the visibility work below load-bearing rather than nice-to-have, and it is the
    part most likely to be dropped for time. If only one thing gets built beyond the flag
    itself, make it **the prompt at pairing**: that is the single moment the operator of a
    board is already paying attention to it.
  * **Enforce it ON THE DEVICE, not only in the server's logic.** A flag the device holds in
    its config store and refuses to act against is meaningfully stronger than one the server
    merely honours, because it survives a compromised server. Be honest in the UI about
    which kind it is: as a purely server-side flag it is a convenience control and NOT a
    security boundary, since a server that can ignore the flag can push firmware anyway.
    The device-side version is the one worth building.
  * Changing the setting needs the same step-up auth as an update, or the choice is
    trivially undone by whoever it was protecting against. That now cuts both ways: turning
    updates ON is the privileged operation, because it is the one that grants a remote party
    the right to run code on that board.

  **Making "off by default" honest rather than negligent.** Three things, in the order they
  matter:

  1. **Ask at pairing.** The one moment someone is demonstrably looking at that device.
     Offer it plainly -- neither pre-ticked nor buried -- and record the answer.
  2. **Show the state, not just the setting.** The Devices tab should say which boards are
     enrolled, which are behind, and by how much. An opt-in scheme whose UI shows only a
     toggle tells you what you chose, not what you are running.
  3. **Say when it matters.** A security-relevant release should surface against every
     un-enrolled device that is behind -- loudly, and without updating it. Per the rule
     above, a declined or unelected update is still declined; the answer is to tell someone,
     never to decide for them.

- **ARCHITECTURE DECISION 2026-09-13: the device keeps streaming FLUX, not ADF.**
  Raised while starting write support -- storing ADF on the Pico and encoding MFM there
  would cut the per-mount download by 2.25x (2,027,536 -> 901,120 bytes, ~3.2 s -> ~1.4 s
  at the measured 630 KB/s) and free ~2.4 MB of the 4.26 MB two slots currently take. Real
  wins, and the write path would have been simpler: a decoded track IS ADF.

  **Rejected because WFMF is FORMAT-AGNOSTIC and ADF is not.** The device streams whatever
  flux the server hands it, so a copy-protected disk, an HFE or an IPF can ride the
  existing path with NO FIRMWARE CHANGE. ADF cannot represent any of them. The operator's
  call, and the backlog entry below is what it buys.

- **HD floppies -- 2026-09-24 RESEARCH ADDED, STILL DEFERRED until the operator has the board to test on** (operator: "HD implementation will come later when I have the board you can test on"). Findings, sources in `docs/superpowers/research/2026-09-24-hfe-and-hd-floppies.md` Part C: (1) the ADF-on-device ruling below holds, and the unknown is CPU: an HD track (22 sectors, ~25 KB MFM) encoded on demand is ESTIMATED at ~1-10 ms on the RP2350 against ~15 ms of head settle -- measure it on the board before designing around it. (2) **The board answers NO drive ID today** (`dskchg.c`: removed because a GPIO ISR could not catch the 1-4 us select pulses). Amiga IDs: `0xFFFFFFFF` DD, `0xAAAAAAAA` HD, `0x00000000` none. HD needs a dedicated PIO state machine to shift the HD ID on RDY. (3) Kickstart 3.0+ for HD is still UNCONFIRMED by source (operator ruling stands). The planned first step when the board is back: a spike that ports the ADF->MFM track encoder to C (byte-identical to `src/lib/adfmfm`), times it on the board, and proves a PIO can answer the ID.
- **HD floppies: 1.76 MB images, on a par with the 880 KB ones today. DEFERRED by the
  operator 2026-09-13**, same day it was raised -- kept here with its findings intact so
  picking it up again costs nothing. Requested as: create them, add files to them, mount them. The operator's own
  estimate that the MFM would be ~4 MB is right: an Amiga HD disk is 22 sectors per track
  against DD's 11, and the drive spins at 150 rpm rather than 300, so the SAME 2 us bitcells
  and the same 500 kbit/s cover a revolution twice as long. (An earlier version of this entry
  said "1 us bitcells" in the same sentence as "the same 500 kbit/s"; those contradict each
  other -- 1 us would be 1 Mbit/s, which Paula cannot take and is the reason HD drives spin
  at half speed. Verify against Greaseweazle's HD definition before relying on either.)
  160 tracks x ~25,000 bytes is ~4.0 MB per image.

  **OPERATOR RULING 2026-09-14: HD images are held on the device as ADF, not as flux.** The
  reasoning, as given: no NDOS games or demos were ever released on 1.76 MB disks, so there
  is no copy protection to preserve and the flux-not-ADF decision (README, "the device
  streams flux rather than holding ADFs") buys nothing for HD. HD drives were rare -- only
  the big-box Amigas had one natively. The use case is not software preservation but
  **getting files larger than 880 KB onto an Amiga simply**: build an HD disk in the browser
  (3u/3v already edit AmigaDOS volumes), mount it, copy off. That use case needs READ only,
  so it does not wait on write support.

  What the ruling changes:
  * **The PSRAM blocker below mostly dissolves.** An HD ADF is 1.76 MB, so two slots are
    ~3.5 MB against today's 4.26 MB for two DD flux slots -- the two-slot publish property
    survives. The cost moves to CPU: the device must build each track's MFM itself.
  * **A C port of the ADF->MFM encoder on the device**, producing one track on demand into
    the track buffer (an HD track is ~25 KB of MFM; `TRACK_MAX_BYTES` is 13,312 today).
    Verify it byte-for-byte against `src/lib/adfmfm` and Greaseweazle, the same way the DD
    encoder was verified -- never against its own fixtures.
  * **Measure the encode time before committing to it.** Core0 answers a seek in 1 ms median
    against ~15 ms of head settle (4a); encoding 22 sectors (checksums plus odd/even split)
    has to fit inside that margin, or be done ahead of the seek.
  * **Two image kinds on the wire:** the poll/image protocol needs to say "flux container" or
    "raw ADF", and `image_loader` needs a second parser. DD stays flux.

  **THE BLOCKER WAS PSRAM -- for HD-as-flux, which the ruling above no longer requires.** The part is 8 MB
  and today two slots of DD cost 4.26 MB (`SLOT_COUNT 2`, `TRACK_MAX_BYTES 13312`). Doubling
  the track size for HD makes one slot ~4.26 MB and two of them ~8.5 MB -- **over the part**.
  So HD forces a choice: a single slot (losing the fetch-the-next-disk-while-the-current-one-
  plays property that `psram_publish_slot()` exists to provide, and with it the guarantee
  that a failed fetch leaves the Amiga holding the disk it had), or a bigger PSRAM part on a
  future board. Decide that first; everything else is ordinary work.

  **What else it touches:**
  * `src/lib/adfmfm/constants.ts` -- SECTORS, TRACK_BITS, the gaps, ADF_BYTES and WFMF_BYTES
    all assume DD. They are measured values verified against Greaseweazle, so the HD set
    needs verifying the same way rather than derived by doubling.
  * NOT the PIO clock divider: HD keeps 2 us bitcells (see the correction above). What changes
    is the revolution: twice the bits per track, so the DMA wrap and INDEX come every
    ~400 ms instead of ~200 ms.
  * `src/lib/adffs/` -- AmigaDOS scales to HD but the root block moves (block 1760 on an HD
    volume, not 880), so anything that hardcodes ROOT_BLOCK needs to take it from the
    volume's size.
  * The 901,120-byte checks: `setDesired` refuses anything that is not exactly a DD image,
    and the ingest path and `toAdf()` assume the same. Those become "one of two valid sizes".

  **Which Amigas can read HD -- CORRECTED by the operator 2026-09-14.** An earlier version
  said an A500 cannot. Wrong: Paula is the same in every Amiga, and the 150 rpm spindle is
  exactly what keeps an HD disk inside Paula's data rate, so the chipset is not the limit.
  Aftermarket HD drives were sold for older models for this very use case. What remains to
  settle is not Paula but the two things the Amiga uses to decide a drive IS HD:
  * **The drive ID.** With the drive selected and the motor off, the Amiga clocks a 32-bit
    ID off RDY; DD and HD drives answer with different patterns. The board must answer with
    the HD one while an HD image is mounted -- and the DD one otherwise.
  * **trackdisk.device support -- OPERATOR RULING 2026-09-14: HD requires Kickstart 3.0 or
    later.** The operator's understanding is that 3.0 is where HD support arrived, and that
    a ROM upgrade on an older Amiga is common and reasonable to require; the current
    Kickstart for all models is 3.2.3 (as of 2026-09-14). So this is a documented
    requirement of the feature, not a blocker. The UI should say so where an HD disk is
    created or mounted, since a 1.3 machine would simply fail to read it.

- **Multi-disk games while playing: a smart way to advance to the next disk.** Requested by the operator
  2026-09-26. Nothing designed yet. What the board already has to build on:
  - it knows the set: every mount carries diskNo/diskCount ("disk 1 of 2" on the OLED);
  - two PSRAM image slots (SLOT_COUNT 2), one idle while playing;
  - a working disk-change (CHNG) path, so a swap looks like a real eject + insert to the Amiga;
  - rev B wires SEL1 (pulled up), the second drive's select.
  Ideas, simplest first:
  1. **One action "Next disk"**: in the drive chip's menu, and as a long-press / double-tap of the game's
     NFC tag (must not clash with "same tag = no-op"). Server side it is setDesired(next disk of the game).
  2. **Prefetch the next disk into the idle slot** as soon as disk N mounts, so any swap is instant instead
     of a ~5 s fetch (needs the loader to fill the non-active slot without disturbing the served one).
  3. **Answer as DF0 AND DF1 at once** (disk N on SEL0, disk N+1 on SEL1, one per slot): many multi-disk
     games read disk 2 from DF1 and never ask for a swap. Needs two-drive emulation in firmware; hardware
     is on rev B.
  4. **Detect "insert disk 2"**: a game waiting for a disk usually re-reads the same track in a loop; spot that
     on an unchanged disk, show "Disk 2?" on the OLED and swap on a tap or after a delay. Risk of false
     positives -- measure real games first (log seek/read patterns while a swap prompt is on screen).
  Suggested order: 1 + 2 (cheap, predictable), then 3, with 4 as an experiment.

- **NFC "tap a card to mount" on the board (PN532, I2C, read AND write).** Requested by the operator
  2026-09-24: a PN532 module reads a disk's hash off an NFC card, the board calls the web app, and the
  web app mounts the matching ADF. The module connects over I2C. **REVISED 2026-09-25: the board
  must also WRITE tags** — the operator has no other NFC writer, so for testing (at least) the same
  board has to put a disk's identity onto a blank card, e.g. "write the mounted disk to the next
  card tapped". The PN532 writes NTAG21x natively, so this is firmware work, not a hardware change.
  **Clarified the same day: writing is a DEV TOOL that Claude drives, not a web-app feature.** The
  operator says "write the hash of diskxyz.adf to the NFC tag" and Claude does it: resolve the
  disk's sha256 (from the file, or the DB by name), send it to the board over the USB CDC console
  (e.g. an `nfc write <sha256>` command the firmware accepts), and report the read-back. No UI, no
  server endpoint for writing. This answers the "how cards get written" question below.
  **THE MODULE IS ON THE BENCH AND READS TAGS (2026-09-25), branch `nfc-identify`.** It is NOT a
  PN532, whatever the listing said: it is an **HW-147C with a Si512** (sanded chip; the operator's
  vendor pack `~/Downloads/HW-147C-V0.0.1-20240904-1` names it, with datasheet and example code).
  Measured: I2C address **0x28** (vendor `SLA_ADDR 0x50`, 8-bit), no answer to the PN532 protocol
  at 0x24 or 0x28, VersionReg 0x82, 7 of 8 MFRC522 reset values match (ModeReg 0x3b, not 0x3f).
  It is a **PN512-style part**: it answers RC522 register access, but **reads no tag until
  ControlReg's Initiator bit (0x10) is set** -- two tag watches saw nothing without it. With the
  vendor's `PCD_SI512_TypeA_Init` copied line for line (Initiator, TxMode/RxMode 0, ModWidth 0x26,
  RFCfg 0x68, 25 ms timer, 100 % ASK, ModeReg 0x3D), both kit tags read at once: white card UID
  73 4a 0f 29, blue fob 24 19 b6 01, both ATQA 04 00 = **MIFARE Classic 1K** (writing the 32-byte
  digest needs Crypto1 auth, default key FF..FF; NTAG stickers would be simpler), 173/173 WUPA
  clean. Wiring: VCC pin 36 (3V3), GND, SDA pin 24, SCL pin 25 shared with the OLED; DIP switch 1
  ON, 2 OFF. **A loose SDA/SCL lead makes it vanish from the bus while the OLED carries on** --
  seen once, the boot scan's missing 0x28 line is the tell. `src/nfc_probe.c` is a BENCH probe:
  it blocks boot 20 s for a tag watch (skipped on trial boots, whose ROM deadline it would miss),
  so it must not ship. *(Superseded 2026-09-26: the board now runs release 1.3.0, seq 10 -- §3am.)*
  Flash backup from before: `~/.webadf/board-backups/2026-09-25-192817-before-nfc-identify.bin`.
  **`picotool reboot -f` does NOT reboot this firmware** (it reports success; USB never drops), so
  every bench install needs the operator's BOOTSEL. And `cat` of the CDC port does not raise DTR
  on this Mac; a reader that sets DTR with TIOCMBIS works.
  Nothing designed yet. Facts to start from:
  - **The I2C bus already exists.** The OLED is on I2C1, GP18 (SDA) / GP19 (SCL), header pins
    24/25 (`floppy_io.h:57-58`). The PN532's I2C address is 0x24 and the SSD1306's is 0x3C, so
    they can share the bus. Check the pull-ups and the PN532 board's own level/DIP settings (I2C
    mode, 3.3 V) before assuming.
  - **Keep it off core0.** An I2C transfer is milliseconds (`activity_led.h:17`: ~20 ms per OLED
    write) and core0 is the real-time floppy side. Card polling belongs on core1, next to the
    display and the network, and it must share the bus with the OLED code (one owner, or a lock).
  - **What the card holds.** A SHA-256 is 32 bytes (64 hex characters), which fits an NTAG213
    (144 bytes of user memory) as an NDEF text record. Decide raw digest vs a disk id. A digest is
    content, and one org can have several disk rows with the same bytes (the disk id is what
    `readDesired` resolves). A disk id names exactly one row but only means something inside one
    org.
  - **The boundary is the device's org, not the card.** The card is untrusted input: the server
    must mount only what the device's own org is entitled to (the same entitlement check
    `/api/device/image` makes), answer "not found" identically for an unknown and a foreign
    digest, and go through the same holder/`setDesired` path the web UI uses, so write-back and
    mounted-disk rules still hold. It needs a new device-authenticated endpoint (for example
    `POST /api/device/mount` with the digest), bumping `desiredVersion` like a web mount.
  - **Open questions for the operator:** what the card stores (digest vs disk id), how cards get
    written (a "write NFC card" helper in the web app for a phone, or an external tool), what a
    tap does when a disk is already mounted (replace, or ignore until eject), and whether a tap
    of the mounted disk's own card should eject it.
  - Bench-only: needs the module wired to a board, so it waits for the board like HD.

- **Support HFE and IPF, for copy-protected games.** **HFE v1 IMPLEMENTED 2026-09-24, see §3al (bench acceptance owed; v3 later).** **2026-09-24: IPF IS RULED OUT** by the operator ("riddled with licensing": the CAPS/SPS decoder library's terms), so do not propose it again. HFE, including v3, is being planned. Requested by the operator 2026-09-13,
  and the direct payoff of the decision above: both are flux/bitstream formats, which is
  exactly what WFMF already carries, so the work is server-side conversion into the
  container the device already streams. **No firmware change, and no board change.**

  **The two are NOT equal in difficulty, and the difference is licensing, not code.**

  * **HFE** (HxC Floppy Emulator) is an open, documented format: a header plus per-track
    bitstream at a stated bitrate. Converting it to WFMF is mechanical -- both sides are
    bitstreams -- and it is the one to do first. It also gives the whole path a test that
    does not depend on owning a protected disk.
  * **IPF** (SPS/CAPS) has no published specification. Reading it in practice means the
    SPS `capsimg` library, which is closed source, and its redistribution terms must be
    read BEFORE any work starts -- not after. Treat "can we even ship this" as the first
    question, the same way PaulaNET's missing licence turned out to be the first question
    there. Do not assume; check.

  **What still cannot be emulated regardless of format:** protections that depend on
  physical media properties rather than on flux we can replay -- weak/fuzzy bits that read
  differently each revolution, and long-track timing. Some of those the WFMF container
  could carry with work (multiple revolutions per track); some cannot be done by any
  emulator on a 500 kbit/s interface. Worth establishing which before promising a title
  list.

- **Amiga networking over the floppy port (PaulaNET-style).** Raised by the operator
  2026-09-13 after finding RobSmithDev's PaulaNET. Genuinely attractive, and explicitly a
  SECOND PRODUCT on the same board rather than an increment to disk serving: it makes the
  Amiga itself reach the internet, and does nothing to make disks load better.

  **Our hardware already is his hardware.** PaulaNET is a Pico W / Pico 2 W on the external
  floppy port with 2N7002 level shifters and the CYW43439 radio; this board is an RP2350B
  (PIM726) on the floppy port with BSS138 level shifters and the same radio. Every signal it
  needs is already broken out, WDATA (GP7) and WGATE (GP8) included. **No board change, and
  rev B does not need to account for this.**

  **How it works, so nobody has to re-derive it:** the Amiga sees a floppy drive (DF1:) and
  moves data with plain `trackdisk.device` raw commands, `ETD_RAWREAD` / `ETD_RAWWRITE`.
  Tracks 0-74 hold a small AmigaDOS disk carrying the driver; **75 is AP scan results, 76 is
  device configuration, 77 is ethernet data**. An RLE scheme chosen so its output can always
  be locked onto by Paula avoids MFM's 2x cost; without it the rate halves. Measured at
  ~43 KB/s with 80-120 ms ping on an unaccelerated A1200 -- about 70% of the 500 kbit/s the
  port can carry, which independently confirms the "floppy speed" finding recorded below.

  **THE TRACK MAP IS A REAL CONFLICT, not a detail.** A standard ADF uses all 80 cylinders, so
  a drive cannot serve a real disk and carry a network on tracks 75-77 at the same time.
  Either the device switches modes (network only while nothing is mounted) or networking gets
  its own drive, which is what PaulaNET assumes by sitting on DF1.

  **Licensing, which decides the shape of the work.** PaulaNET carries NO licence --
  "Copyright (c) 2026 RobSmithDev. All rights reserved." -- so neither its firmware nor its
  `PaulaNET.device` may be copied or vendored. **The operator is asking Rob directly
  (2026-09-13), noting this project is open anyway.** Until that answer comes back, assume
  nothing of his can be used, and do not start a clean-room reimplementation on the
  assumption that it must be: an email is cheaper than a SANA-II driver.

  **What we would actually have to write is the Amiga side, and that is most of the job.**
  A SANA-II network device driver (VBCC), which is Amiga systems programming this project has
  never touched. The Pico half is comparatively small once write support exists.

  **Stack: AmiTCP_NG** (https://github.com/MW0MWZ/AmiTCP_NG), named by the operator.
  GPL-2.0, actively maintained, a fork of AmiTCP/IP 3.0b2 offering a Roadshow-compatible
  `bsdsocket.library` ABI. It consumes **any SANA-II device** through its `device=` setting
  and is already hardware-validated against `wifipi.device` on PiStorm -- so there is a
  working precedent for exactly this shape of driver.

  **The layering also settles the licence question for our own code:** a SANA-II driver talks
  to the stack over Exec device I/O, not by linking against it, so such a driver is not a
  derivative work of AmiTCP_NG and its GPL does not propagate into it. That also means the
  stack stays the user's choice -- Roadshow or AmiTCP_NG -- rather than something we bake in.
- **Self-host on the local network: Docker containers, a local URL, local hardware.** Requested by
  the operator 2026-08-31 as a nice-to-have. Substantial but not exotic — the shape of the work is
  known, and most of it is swapping two managed services for local ones. What it actually touches:

  - **Blob storage.** `src/lib/storage.ts` is built on `@vercel/blob`, including presigned upload
    tokens. Needs an S3-compatible backend (MinIO) or a filesystem store behind the same
    `diskStore` interface — that interface is already the seam, so this is a re-implementation
    rather than a rewrite of callers.
  - **Postgres.** The app uses `@neondatabase/serverless`'s HTTP driver, and that single choice is
    why this codebase has **no transactions** and leans on `db.batch()` everywhere (see
    `src/lib/admin-delete.ts` and `src/lib/tosec-apply.ts`). On a plain local Postgres with
    `node-postgres`, `db.transaction()` genuinely works — so self-hosting would *simplify* those
    modules, not complicate them. Worth knowing before anyone assumes the batch style is
    load-bearing everywhere.
  - **Scheduling.** `vercel.ts`'s `crons` has no meaning off-platform; the nightly scan needs a
    real scheduler (a container running cron, or a loop calling the route with `CRON_SECRET`).
  - **Function limits.** The `maxDuration` exports and the sweeper's ~240 s wall-clock budget are
    shaped around a 300 s serverless ceiling that does not exist in a container. The budget can
    stay (it is harmless and keeps runs bounded) but is no longer a constraint.
  - **Build.** `next.config.ts` sets no `output` mode; a lean image wants `output: 'standalone'`.
  - **`BETTER_AUTH_URL`** and the session cookie settings need the local origin — and note the
    recorded warning that touching `crossSubDomainCookies` or `sameSite` removes the only CSRF
    defence the mount and eject routes have.

  **The part that is genuinely awkward, and the reason this is more than a packaging exercise:**
  the firmware's `WEBADF_HOST` is **compile-time** (`wifi-floppy/firmware/CMakeLists.txt`, currently
  `webadf.vercel.app`), and that was a deliberate security decision in plan 4b — making it
  portal-editable would let anyone who reaches the provisioning AP point a board at a server of
  their choosing. So pointing boards at a local instance means **reflashing them**, and the
  device connects over TLS with mbedTLS: a local instance needs either a publicly-trusted
  certificate for its LAN name or its CA baked into the firmware image. Neither is hard; both
  need deciding before this is usable with real hardware rather than just in a browser.
- ~~**Rename the "Ingest" nav item to "Upload".**~~ **Label DONE 2026-08-31** — the nav now reads
  "Upload"; nothing asserted on the old text, so no test changed. **The route rename is still
  open and is deliberately not done:** `/ingest` is referenced in `src/proxy.ts`'s matcher, the
  page, `game-grid.tsx`, several `src/lib` modules and their tests, and e2e URL assertions, and
  the `/api/ingest/*` namespace is baked into the CLI and the design docs. That is a much wider
  change and should be its own decision.
- **Refuse web-UI writes to a disk that is currently MOUNTED on a device.** Requested by the
  operator 2026-09-13, while an Amiga was reading a disk he could also have edited in the
  browser. Browsing a mounted disk is fine and should stay; editing it is not.

  **Why it is worse than it sounds.** Editing an ADF in the browser writes a NEW blob with a
  new digest and repoints the disk row. A device holding the old image keeps serving the old
  bytes -- it has no idea -- so the two diverge silently, and the Amiga is reading a disk
  that no longer exists anywhere else. Worse, the version bump makes the device re-fetch and
  remount at whatever moment its long-poll returns: the disk changes UNDER a running Amiga,
  which is exactly the eject-mid-use that produced today's read errors. AmigaDOS has no
  concept of the media changing without the change line, so it is entitled to corrupt
  whatever it was doing.

  **Where the check goes:** every mutating path in `src/lib/adffs/write.ts`'s callers -- the
  file add/rename/delete routes and the drop-staging commit -- not just the UI, since the UI
  is not the only caller and a disabled button is not a guarantee. The query is already
  available: `devices.desiredSha256` matching the disk's current digest, org-scoped.

  **Offer the way out rather than only refusing:** "this disk is mounted on <device>; eject
  it to edit" with an eject button, since the operator will usually be standing next to the
  Amiga. A refusal that does not say what to do is a dead end.

- **Propagate a write-protect flip to a device that already has the disk mounted.** Requested by
  the operator 2026-08-31, and it is part of the design's intent rather than a new feature. It
  does not work today, and the reason is specific: `PATCH /api/disks/[id]` updates only
  `disks.write_protected` — it does **not** bump `devices.desired_version`. The long-poll is
  version-gated (`version > clampedFrom` in `src/app/api/device/poll/route.ts`), so a board
  holding that disk sits in its 25 s poll and never learns the flag changed.

  **CORRECTED 2026-09-18: bumping the version IS enough.** `dc_handle_poll_body` in
  `device_client.c` already skips the fetch when the polled digest equals the mounted one and
  applies `writeProtected` in place. So a flag-only bump costs one poll, not a re-download. The
  paragraph below predates that check, and write-back's spec
  (`docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md` §3.5) builds on
  the correction.

  **(Superseded) The fix is not simply "bump the version", and that is the part worth knowing before planning
  it.** A version bump is what tells the device its *desired disk* changed, and the device
  reconciles by fetching the image — roughly 2 MB of WFMF over TLS — and remounting. For a
  flag-only change that is an unrequested eject-and-remount of a disk nobody asked to touch,
  which is what disk-change spec §1 rule 1 forbids. So this needs a protocol answer for "same
  disk, changed flag": either a separate counter the device can act on without re-fetching, or a
  poll payload the firmware can apply to `WPROT` alone. Firmware already asserts `WPROT`; what is
  missing is a way to change it in place.

  Note the standing caveat that `disks.write_protected` is inert until write-back is designed —
  so this is only observable on hardware once the board actually honours the flag.
- ~~**Let a person edit their own titles' details — and never have a scan overwrite them.**~~
  **DONE 2026-09-03**, see 3m. The entry's own warning about the three source columns was right,
  and understated: the columns were not merely separate, they were unread — every sweep guarded
  on `metadataSource` alone.

- ~~**Show each disk's real filename, and let a human download the ADF.**~~ **DONE**, merged
  and live. `disk-row.tsx` shows both names — `disks.tosecName` and, when it differs,
  "uploaded as `entitlements.sourceFilename`" — because "the actual filename" really is two
  different columns. `GET /api/disks/[id]/adf` serves the raw 901,120-byte ADF under the
  canonical TOSEC name, scoped by the caller's org **entitlement** rather than by
  `disks.orgId`, which can drift. `e2e/adf-download.spec.ts` covers the bytes, the naming
  precedence, and that another tenant gets a 404 rather than a 403.

- ~~**A type pill in the library grid, and a type column in the list view.**~~ **DONE
  2026-09-01**, merged and live. Both surfaces show `Game` / `Demo` / `App` / `Educational` /
  `Coverdisk`, derived in `src/lib/game-kind.ts` from the TOSEC set name. The notes below are
  kept because they are what the implementation actually did, and the last one still bites:

  **The type already exists and is already imported — it is the TOSEC set name.** The seven
  Amiga `[ADF]` sets are exactly this taxonomy: `Games`, `Games - Public Domain`,
  `Demos - Various`, `Applications`, `Applications - Public Domain`, `Educational`,
  `Coverdisks`. The path is `disks.sha256` → `blobs.tosecEntryId` → `tosec_entries.setName`.
  Nothing needs to be invented or inferred, and OpenRetro's `tags` is NOT the right source —
  that is genre (`pinball, scrolling`), which is a different question and already renders.

  **Derive it once at apply time, not per render.** `listGames` is already a grouped aggregate
  over a `leftJoin`; adding a second join through `blobs` to `tosec_entries` puts a third table
  in a query that runs on every library page load. Writing a `games.kind` column inside
  `applyMatch` (`src/lib/tosec-apply.ts`) is cheaper and fits the existing authority rule —
  it is machine-authored metadata like `publisher`, so it belongs under `MACHINE_SOURCES` and
  must never overwrite a human edit.

  **Two things that will look like bugs and are not.** A game's disks can come from different
  TOSEC sets, so a game needs a stated rule for disagreement — `pickKind` uses most-common,
  unmatched disks abstain, ties break alphabetically so the value cannot change between two
  renders. And **about half of a real library has no type at all** — TOSEC recognises 45.9% of
  the operator's archive — so "unknown" is the common case: the table prints an em dash to hold
  the column's place, and the grid prints nothing at all.

  **What was NOT done as planned:** the notes above said to write a `games.kind` column at apply
  time. It is derived per request instead, in a second query beside the covers one. That needs
  no migration and no re-sweep, and works immediately for every already-matched game — the
  performance objection was about joining onto `listGames`' aggregate, which a separate query
  avoids entirely.

- **~~Typeahead search with debounce, over titles and descriptions.~~ DONE 2026-09-02 — see 3h.**
  Requested by the operator 2026-08-31. The planning notes below are kept because three of
  them shaped what shipped and one of them was wrong:

  **`games.description` exists as of the OpenRetro increment but is nearly empty**, and that is
  the first thing to check before promising description search. It is written only for blobs
  OpenRetro recognises, which on the operator's archive is 4 disks resolving to ONE game. A
  search that advertises "matches descriptions" would today be searching a single row. Either
  the TOSEC-identity matching described in §3d lands first, or the feature ships as title
  search with description as a quiet bonus.

  **What the notes got wrong:** they framed description search as the risk. It is a non-issue —
  description is matched but never advertised, costing nothing in the `or(...)`. The real risk
  was the disks join (D-5-5), which these notes never mention.

  **`sortTitle` is already normalized lowercase** and `games_org_sort_idx` is on
  `(orgId, sortTitle)`, so a prefix search is fast today with no migration. Anything better —
  infix matching, or ranking titles above descriptions — wants a trigram or tsvector index,
  which IS a migration and should be decided up front rather than bolted on when ILIKE
  `%foo%` turns out not to use the index.

  **The route must be org-scoped through `orgFilter()` like every other query here**, and it
  must not become a cross-tenant existence oracle: `/api/ingest/check` is a deliberate global
  oracle on digests (D13), but titles are not digests and there is no equivalent decision
  covering them. Scope it, and return nothing rather than a 404 that distinguishes cases.

  **Debounce belongs in the client, and the request needs cancellation, not just delay.** Without
  aborting the in-flight fetch, a fast typist gets responses out of order and the grid flickers
  back to a stale result — the classic typeahead bug, and the one most worth a test.

- **Add / edit / delete files through the browser.** ~~Create blank ADFs~~ **DONE 2026-09-03,
  see 3n** -- the button, the format writer and the bitmap all shipped; what remains is the
  file operations.

  **SPECCED AND PLANNED 2026-09-04, not yet built.**
  `docs/superpowers/specs/2026-09-04-adf-file-operations-design.md` is binding and
  `docs/superpowers/plans/2026-09-04-adf-file-operations.md` has the twelve tasks. Two operator
  rulings are recorded there: any disk is editable but an identified one warns that the edit
  drops its TOSEC identity (D-W-3), and editing a disk a device has mounted is **refused**
  rather than propagated (D-W-4), which is what keeps this increment free of any protocol
  question on hardware that has never run.

  **Read §1 of that spec before starting.** Four of the five "hard parts" listed below are
  already written, in `synthetic.ts` -- the name hash including INTL, OFS data-block headers,
  file headers, hash-chain insert and `T_LIST` extension blocks. Only the bitmap allocator is
  absent. **But xdftool rejects all four synthetic volume shapes** with
  `Bitmap Block Count Mismatch`, because `syntheticVolume()` writes no bitmap at all and our
  reader ignores bitmaps. Every fixture-based test in `src/lib/adffs` has therefore been
  validated against a disk no Amiga tool would mount, which is why repairing it is task 1.
  The PRODUCTION path is unaffected: `pnpm adffs:verify` still passes all ten checks, and the
  reader's 80.3% on the real archive comes from `archive.test.ts`, which uses real disks. Requested by the operator 2026-09-01. The reader was a hard prerequisite and
  so, now, is the bitmap: allocation has somewhere to come from.

  **What 3n already settled, so it need not be re-litigated:** blobs are immutable and an edit
  is a new blob (proven by the rename path), `disks.id` never changes, devices are repointed on
  `desired` only, authored disks are flagged and stamped outside MACHINE_SOURCES, and
  `pnpm adffs:verify` exists to check a writer against amitools rather than against ourselves.

  **What is still ahead, and none of it is in the blank-disk path:** allocation FROM the bitmap
  (3n only marks two blocks used and never frees one), hash-chain insert and -- the fiddly one
  -- relink on delete, whose hash function differs under INTL, OFS's 24-byte data-block header,
  and file extension blocks.

  **The constraint that shapes everything: `blobs` is content-addressed and immutable.** Editing
  a disk produces different bytes, therefore a different sha-256, therefore a NEW blob. There is
  no in-place edit. So an edit is really "write a new blob and repoint `disks.sha256`" — and
  that has consequences the UI must not hide:

  - **`disks.id` must still never change** (the standing rule), but `disks.sha256` now does, and
    **`devices.desiredSha256` is what a board polls on**. Repointing a mounted disk is a real
    disk change to the hardware and has to bump `desiredVersion` deliberately, not incidentally.
    Compare the write-protect-propagation entry above: same protocol question, opposite answer —
    there the flag changed and the bytes did not.
  - **The old blob may still be entitled to other tenants**, so it is never deleted on edit. The
    blob-GC rule in `src/lib/blob-gc.ts` is what decides when it becomes reclaimable.
  - **An edited or hand-built disk has NO TOSEC identity, and that is the intended outcome, not
    a failure** (operator ruling, 2026-09-01: "I create floppy disks myself and decide the
    content"). It will hash to something no DAT contains, so the sweeper will stamp
    `match_state = 'none'` — correct, and it must not be reported as a miss in any rate that is
    meant to measure preservation coverage. **The rate published on `/admin/scan` should exclude
    user-authored disks**, or it degrades every time the operator makes a disk.
  - **Therefore the write path must set `games.metadataSource` OUTSIDE `MACHINE_SOURCES`.** That
    is the existing Authority rule doing exactly the job it was built for: a value the machine
    does not recognise is treated as a human decision, so `applyMatch` will never retitle a
    hand-built disk and `mergeDuplicates` will never absorb it. Getting this wrong is not
    cosmetic — a merge DELETES the losing `games` row.
  - **`disks.writeProtected` stops being inert.** It currently has no enforcement anywhere; the
    moment editing exists it needs one, and it is per-org by design.

  **What the reader can skip and a writer cannot:**

  - **Bitmap blocks.** The reader ignores them entirely. A writer must allocate and free blocks
    and keep the bitmap and its checksum correct, or the disk corrupts on a real Amiga.
  - **Checksums on every modified block**, not just the ones whose contents changed.
  - **Hash chains on insert and delete.** This is the fiddly part: removing an entry mid-chain
    means relinking, and the hash function differs under INTL (6 of the operator's 49 readable
    disks are INTL).
  - **Both OFS and FFS write paths.** The archive is 29 OFS / 24 FFS, so neither can be skipped,
    and OFS additionally maintains a 24-byte header on every data block.

  **Start with the blank ADF.** Bootblock + root block + empty bitmap is small, self-contained,
  and immediately verifiable — a blank disk this code writes should mount on a real Amiga and
  read back through the reader from increment 3. That is the honest first milestone.

  **Plan it together with "write-back and layered disks"** (disk-change spec §5). A disk edited
  in the browser is a write-back from a different source, and that entry already argues the first
  increment should record WHICH BLOCKS changed rather than a flattened result. Designing these
  separately would produce two incompatible answers to the same question.

- ~~**A read-only ADF browser**~~ (disk-change spec §5) — **DONE 2026-09-01, see 3f.** Parses
  OFS/FFS out of a stored ADF with no mounting involved; reads 49 of the operator's 61 disks
  (80.3%). Left listed because the reason it was wanted — a review queue for disks TOSEC does
  not recognise — was NOT built, and is still worth having: the reader is what makes it
  possible, since a Workbench disk TOSEC misses has a perfectly readable volume name.
- **Moving ADF→MFM encoding onto the Pico** (spec §13) if server-side encoding
  (9.6 ms/disk, ~2 MB over TLS) ever turns out not to hold up. `adfmfm` is written
  dependency-free specifically so this would be a transliteration, not a rewrite.
- **REV B RECEIVED AND MERGED 2026-09-26 (Shanshe, PR #1, `22d3556`); it is the primary PCB.**
  Checked with the new `pnpm hw:verify` and by reading the netlist:
  - **Matches the firmware:** every Pico pin (GP0-13 floppy in `floppy_io.h` order, GP18/19 I2C
    to J3 OLED and J4 NFC, GP21 buzzer, GP22 LED), every J1 floppy pin, GP14-17 unconnected.
    Inputs through U2 74LVC541A at 3.3 V; outputs through BSS138 open-drain FETs.
  - **Buzzer:** GP21 → R5 1k → Q7 gate, R6 10k pull-down, BZ1 fed from +5V, Q8 (gate tied to
    source) as the flyback diode. LED: GP22 → R4 1k → D2.
  - *(Fixed in PR #2)* J2 was inside U1's 'RF Copper Keep Out'; it now clears it by a hair.
  - *(Fixed in PR #2)* Pull-ups now on all eight host-driven lines; resistors renumbered (1k:
    R1-R9, R11; 10k: R10).
  - **Assembly BOM (the operator's side -- Shanshe only does layout and placement files; the
    operator orders and sources parts on LCSC):** U1, U2, J1, J2, J4, BZ1 are DNP (U2 is the SMD
    74LVC541A); C1, C3, D1 and the BSS138s have no LCSC number.
  - **Buzzer change requested from Shanshe (2026-09-26):** BZ1 → magnetic passive 5 V S&S SEA-1295Y-0520-42Ω-38P6.5
    (LCSC C2687681; Ø12×9.6 mm, pins Ø0.6 mm at 6.5 mm) with a 22 Ω in series from +5 V (Gotek style). The TDK piezo
    would only click once: nothing discharges a piezo behind a low-side switch. See wifi-floppy/hardware/SOURCING.md.
    Also found: Nano-Tek's speaker diode D1 is in SERIES and reversed (K on SPK-, A on Q1 collector) -- its speaker
    should be silent as drawn; it was meant as a flyback across the speaker.
  - GP20 (optional NFC reset) is not wired; ERC has 54 symbol-library warnings and the known
    VSYS/GND Pico-symbol quirks; parity reports DNP flags that differ between schematic and board.
- *(History)* **Rev B respin is OUTSOURCED (operator, 2026-09-25).** A contractor, Shanshe, is making it and
  will return a COMPLETE KiCad project. When it arrives, fold it into `wifi-floppy/hardware/`
  (replacing, not merging by hand), then run `pnpm hw:verify` and check it carries what rev B owes:
  the LED series resistor, 1k pull-ups on the floppy lines (4c), PIM726 for U1 (the PSRAM part),
  ideally the Amiga-reset wire (3al-a), and **I2C connectors for the OLED AND the NFC reader**
  (operator, 2026-09-25): two 4-pin headers (3V3/GND/SDA/SCL) on GP18/GP19, or Qwiic/STEMMA-QT
  style JST-SH sockets, so both plug in instead of sharing flying leads -- a loose lead cost most
  of the NFC bench session. 3V3 only (the modules pull SDA/SCL up to their own VCC; RP2350 pins
  are not 5 V tolerant). **Pin plan, final (operator 2026-09-26, Shanshe building to it):**
  **GP20 (pin 26) = NFC reader reset (RSTPDN), optional; NFC IRQ is NOT wired** (the reader runs fully
  polled over I2C, proven on the bench). **GP21 (pin 27) = Gotek-style buzzer**: a PASSIVE buzzer (firmware
  drives the frequency: step clicks and tones; PWM slice 2B) switched low-side by an N-MOSFET (AO3400/2N7002),
  ~100 R–1 k gate resistor, **10 k gate pull-down** (silent through boot), buzzer fed from 5 V (VSYS/VBUS) not
  3V3, flyback diode if magnetic, a solder jumper/2-pin header to silence it. GP26/27/28 stay free (the only
  ADC pins, for rail sensing); GP14-17 unusable (antenna keepout). Firmware support for the buzzer comes later.
  Diff the netlist against rev A2's, don't eyeball it.

- **Blob garbage collection** — reclaiming blobs whose last referencing disk is gone. Needs
  cross-org reference counting and deletion from Vercel Blob as well as Postgres. Deferred at
  the operator's direction during the super-admin design; the admin cascade delete deliberately
  never touches `blobs`, because they are shared across organizations.
- **Proof of possession at ingest** (encoder spec / disk-change spec §6) — required
  *before* opening registration beyond invite-only, not before shipping the device image
  endpoint as it stands today.

---

## Open questions the operator still owns

From `INTEGRATION.md`, plus one from me. Three of the four are now answered by plan 3a;
`INTEGRATION.md` itself carries the same resolutions inline.

1. **Which disk is mounted. ANSWERED.** `devices` carries a desired state
   (`desired_sha256`, `desired_game_id`, `desired_disk_no`, `desired_version`), not a job.
   The device long-polls `GET /api/device/poll?since=<version>` and fetches the bytes
   itself from `GET /api/device/image/<sha256>` once the version has moved. See
   `2026-08-29-device-plane-disk-change-design.md` §2–4.
2. **Write-back.** Still open. Unimplemented both sides. `WPROT` is asserted,
   `http_post_track()` is a stub, `psram_image_next_dirty()` exists but nothing calls it.
   `disks.write_protected` exists now and rides the poll payload, but it is inert until
   write-back itself is designed. The disk-change spec §5 records a layered-disk approach
   (base blob + diff layers, so dedupe and history survive writing) as the leading idea,
   not yet committed to.
3. **Disk identity.** Unchanged — webadf keys everything by SHA-256, as already decided,
   and plan 3a's protocol confirms it: `desired_sha256` and `GET /api/device/image/<sha256>`
   both key on it directly.
4. **(Mine) SETTLED.** `requireDevice` throws a `DeviceAuthError`; `deviceAuthResponse` in
   `src/lib/device-auth.ts` converts that into the `401` a device-facing route returns, via
   `const r = deviceAuthResponse(e); if (r) return r; throw e;`. Reconciled in plan 3a's
   first task (commit `02e2b4a`), before any of the three device endpoints was written, so
   the `catch (e) { return e }` → 500 failure mode never shipped.

---

## Things that will bite you if you don't know them

Learned the hard way; several cost real debugging time.

- **The two-hook organization bootstrap in `src/lib/auth.ts` is load-bearing and was got
  wrong twice.** `signUpEmail` wraps its whole handler in `runWithTransaction`, which sets
  an AsyncLocalStorage flag **regardless** of the drizzle adapter's `transaction: false`.
  So `user.create.after` is *queued* and flushed after the handler — meaning
  `session.create.before` runs **first**, and its self-heal is what actually creates the
  organization on essentially every sign-up. Do not reorder or "simplify" those hooks.
- **`drizzle.config.ts` must keep `schemaFilter: ['public','auth']`.** Without it,
  `db:push` silently skips a schema while printing *"Changes applied."*
- **`getDb()` must stay a plain lazy `let`, never a JS `Proxy`.** A Proxy breaks
  better-auth's adapter introspection and hangs with no error.
- **Vitest cannot render async Server Components.** Pure logic → Vitest; pages and flows
  → Playwright.
- **`isBoot` is not guaranteed.** `groupDisks` marks disk 1 as boot; a set with disks 2
  and 3 and no disk 1 gets none. **7 games in the live database currently have zero boot
  disks.** Never assume one exists — fall back to the lowest `diskNo`.
- **No toast in this app was visible until 2026-08-31.** `src/components/ui/sonner.tsx` existed
  but no layout rendered `<Toaster/>`, so every `toast()` call in nine components — mount, eject,
  pair, write-protect, invite issue/revoke, user delete, scan and DAT upload — displayed nothing.
  Every failure path reported silence, including in the super-admin plane that shipped to
  production that morning. Fixed by rendering `<Toaster/>` in the root layout.

  **There is still no `next-themes` ThemeProvider anywhere, and that was NOT harmless — this
  note used to say it was.** `sonner.tsx`'s `useTheme()` fell back to `"system"`, sonner
  resolved that against `prefers-color-scheme`, and on a dark-mode machine it applied its own
  rule `[data-sonner-theme='dark'] [data-description] { color: hsl(0,0%,91%) }`. That colour is
  **hard-coded, not read from a custom property**, so none of the `--normal-*` overrides could
  reach it — while the background *is* tokenised and stayed white, because `.dark` is never
  applied to `<html>`. Result: #e8e8e8 description text on a white toast, **1.23:1**, with the
  title unaffected at 15:1. So every admin toast showed a readable headline over an invisible
  explanation, and all of them pass a `description`. **Fixed 2026-09-01** by pinning
  `theme="light"` (this app has exactly one theme; following the OS was the defect) and stating
  the description colour from `--muted`. `next-themes` remains a dependency with no provider and
  now no meaningful consumer.
- **A presigned URL is a live credential.** Never log it, never put it in the DOM.
- **dnd-kit's default collision detection resolves a drop from the DRAGGED ELEMENT's rectangle,
  not the pointer** — and in this app that is wrong. A library card is ~178x200 and a rail row is
  ~198x31, so one card overlaps three or four rows at once and `rectIntersection` picks the one
  with the greatest overlap, which is routinely NOT the row under the cursor. A title landed in
  the collection above or below the one being aimed at, with nothing on screen explaining why.
  `collectionCollisionDetection` in `collection-provider.tsx` uses `pointerWithin` instead (with
  a `rectIntersection` fallback for the no-pointer case, e.g. a keyboard sensor). **The rail's
  drop highlight reads dnd-kit's own `isOver`, deliberately** — computing it independently from
  pointer position or bounding boxes could disagree with the collision detection and would be
  worse than no highlight, because it would point confidently at the wrong row.
  `e2e/collections.spec.ts` asserts the highlighted row IS the row that receives the title;
  that pairing is the test, not the highlight's existence. Reported by the operator as "hard to
  spot which collection you are actually hitting" — the aiming was the bug, the missing
  highlight only hid it.
- **The logo is three shapes and one drawing, kept in two places by hand.**
  `src/components/shell/logo.tsx` is the mark; `src/app/icon.svg` is the same drawing with the
  slot and the label's ruled lines removed and the keyline at 7 instead of 6, because a
  sub-pixel outline is the first thing a browser tab throws away. There is no build step
  generating one from the other and there does not need to be — but **change one and change the
  other**. `favicon.ico` carries six frames (16-256) each rendered at its NATIVE size rather than
  downscaled from one raster, because a LANCZOS downscale turns that keyline to mush.
  **The keyline is painted OUTSIDE the silhouette** (`paintOrder="stroke"`), which is what lets
  one artwork sit on the dark header and a white card with no reversed variant; a plain stroke
  would straddle the path and eat 3 units into the body. Its colour is `--grad-4` (#c8cfd3), NOT
  `--on-dark` — at #eef3f6 it read as white and glared — and the same value drives the label
  plate, so the mark has one light value, not two. Colours are literal, never `var(--…)`: the
  same drawing renders inside `icon.svg`, where the app's custom properties do not exist.
- **A page with no `glass-card` puts shadcn's defaults straight onto the gradient, and they are
  invisible there.** `--foreground` is `#252525` because shadcn assumes a white page;
  `bg-page-gradient`'s top stop is `--grad-top` `#1b2534`. That pairing measures **1.01:1**. It
  shipped on `/sign-in` and `/sign-up`, the only two pages in the app with no shell, and looked
  like a *partial* problem only because the gradient lightens downward — the lower fields
  drifted into legible territory, so it also changed with window height. Fixed 2026-09-01 with
  an `(auth)` layout that centres a `--glass-strong` panel. **`e2e/contrast.spec.ts` now
  measures the composited pixels** on both pages and on a toast; extend it rather than trusting
  a review, because in both defects the offending colour came from a stylesheet no file in this
  repo names.
- **`--accent-amber` (`#f5822e`) is fill-only** and fails WCAG AA as text. Amber text is
  `--amber-text` (`#a8560f`).
- **Next 16:** `params`/`searchParams`/`cookies()`/`headers()` are Promises.
  `PageProps`/`RouteContext` are ambient — never import them. The guard is `src/proxy.ts`
  exporting `proxy`, nodejs-only. `cacheComponents` stays off.
- **shadcn v4 is Base UI, not Radix.** Any Radix-era snippet is wrong here.
- **Pushing `master` DOES deploy to production. Assume every push ships.** Confirmed
  repeatedly on 2026-09-02 and 2026-09-03: each push to `master` produced a `Production`
  deployment that was Ready in 30-40 s. Ask before pushing anything you are not ready to
  publish.

  **The history below is kept because the headline used to say the opposite**, and a reader
  who skims headlines would have got exactly the wrong answer. Until 2026-08-30 the Vercel
  project's Production Branch was **`feat/foundation-library`**, taken from the GitHub repo's
  default branch when the project was created. This file said "merged to `master`, in
  production" for three plans running, which read as though merging shipped. It did not.
  Discovered immediately after merging plan 3b: both pushes produced `target: null` builds
  while `webadf.vercel.app` still served the previous day's.
  - **To ship after a merge today:** promote the master build explicitly —
    `npx vercel promote <the master deployment url>`, or `npx vercel --prod`. Plan 3b was
    shipped this way (`dpl_B6PcDSRqyWhs2VybYK35CRcf3vWk`).
  - **FIXED 2026-08-30 by the operator.** Production Branch is now `master`, so a push to
    `master` deploys to production normally and no promote step is needed. Verified by two
    builds of the same commit `bb9533a`: Preview at 15:17 before the change, Production at
    15:42 after it. The paragraph above is kept because it explains three plans' worth of
    "merged to `master`, in production" that never actually reached production.
  - If it ever needs setting again it is a **dashboard** change — project `webadf` →
    Settings → Git → Production Branch. **Not settable through the API:**
    `PATCH /v9/projects` rejects `productionBranch`, `gitRepository` and `link` alike as
    unknown properties, and the only other route is re-linking the repo, which risks the
    GitHub connection.
  - **Verify with `npx vercel inspect webadf.vercel.app`** and read `target` and `created`.
    `vercel ls`'s Environment column makes a preview-only push easy to skim past.

---

## Two sessions running e2e will kill each other's dev server

**Operator's reading, 2026-09-25:** the "intermittent cross-spec interference" logged in 3aj/3ak
was most likely this environment rather than the code: a VS Code `rg` process eating memory, and
processes from other chats being killed by pattern (`pkill -f`, since forbidden). Do not open a
bisect for it. If a full run on port 3100, with a dev server you started and logged yourself,
still fails a spec that passes alone, THEN it is real.

**AND A MECHANISM, measured the same day: separate ports do NOT isolate two runs.** There is one
database. Every run's `globalTeardown` (and per-spec cleanup) deletes ALL `@example.test` users,
so it deletes the other run's users mid-test: 307s to /sign-in, HTML from JSON routes, sign-ups
that never reach /library. Two of my subagents on 3100 and 3200 hit exactly this; a lone run
straight after was 362/362. **Run e2e one at a time across every session and chat.** The real
fix is a Neon branch for the suite (3aj's note).

`playwright.config.ts` takes `PORT` (and hands `BASE_URL`/`BETTER_AUTH_URL` to the server it
spawns), so two chats can run the suite at once -- **but only if they pick different ports.**
Twice on 2026-09-21 a full run died mid-suite with `ECONNREFUSED`: the dev server was gone, with
no crash trace, no stack, and no memory pressure (RSS was sampled through a whole run and sat at
1.3-1.9 GB). That is what a killed process looks like, not a crashed one -- the other session had
been told to use the same port and its own teardown swept the listener away. The tell is that the
failures are `ECONNREFUSED`/`ERR_CONNECTION_REFUSED` rather than assertion failures, and that
everything before the death passed.

**Agree the port before starting**, and if in doubt take an unusual one (4100 rather than 4000).
Re-running the affected spec alone on a free port is enough to tell a killed server from a real
regression: the same file that failed 3 tests went 9/9.

## The e2e suite leaves live invite codes behind

`e2e/admin-invites.spec.ts` issues real invite codes, and `cleanupSeeded` does **not** remove
them — it tracks shas, games, disks and devices, not invites. Six live codes were left after
the 2026-08-31 runs and were deleted by hand (unconsumed rows only; a consumed row is the
record that an account exists). **Check `select count(*) from invites where consumed_at is null
and expires_at > now()` after any run of that spec** — a live code is a working registration
credential for seven days, and registration being invite-only (D13) is what bounds the ingest
oracle recorded under "Known accepted risks".

Worth fixing properly by having `cleanupSeeded` track issued invite codes the way it tracks
everything else.

## The live database's catalog was emptied on 2026-08-31

`games` and `disks` are **0 rows**. This was not a bug in shipped code: plan 5 of the
super-admin plan prescribes a mutation proof that removes the `org_id` predicate from the
cascade's `games` delete, to confirm a test catches an unscoped delete. Run against the live
database — which is what every e2e in this repo uses — that mutation is a literal
`DELETE FROM games`, and it cascaded to `disks` via `disks.game_id`. The test caught it, which
was the point; the rows are gone, which was not.

**What survived:** all 826 `blobs`, all 902 `entitlements`, every `devices` row, and every
account including the operator's. So the uploaded ADF bytes are still in Vercel Blob and every
organization's claim on them is intact — what was lost is the catalog *metadata* (titles, disk
numbering, boot flags), which would have to be re-ingested. The operator had confirmed
beforehand that they had no data they needed in the system.

**The lesson, for the next destructive mutation proof:** a mutation that drops a tenant
predicate is not scoped by the test that runs it. Point the run at a scratch database, or accept
in advance that it empties the table for everyone. This repo has no such database today — every
e2e runs against live Neon — so "accept in advance" is currently the only option, and it should
be an explicit decision each time rather than a side effect of following a plan step.

### 4l. THE TIME MACHINE: BROWSE ANY VERSION, PUT ONE BACK — 2026-09-21 (write-back piece 3)

**What the operator can now do.** Every disk page has a **History panel**: each version, what
changed in it as files (added / changed / removed, with a sector count), who or what made it (an
edit, a board's write-back with the device's name, a rewind), newest first, the newest 20 with a
"show all". Two controls per row: **Browse** opens `/disks/[id]/files?version=<seq>` — the whole
file tree of that version, read-only, with a banner saying which version is on screen and every
edit control disabled — and **Restore**, which puts that version's image back.

**Restore ADDS a version; it never rewinds in place** (spec D2, "history only grows"). The target
version's image is materialised and recorded on top of the CURRENT head as a new version with
`source: 'rewind'` and `rewindOf: <seq>`, so everything between the target and the head is still
there afterwards and can itself be restored. Restoring the head, or a version whose bytes already
equal the head, records nothing and answers "nothing moved" rather than inventing a version that
never happened -- `recordVersion` already returns null for identical bytes, and `restore.ts`
honours that instead of treating it as an error.

`restore.ts` deliberately copies `applyDiskEdit`'s shape (`src/lib/disk-write.ts`), because the
rules are the same ones and only the source of the new bytes differs: entitlement-scoped lookup
(a disk outside the org's entitlements answers 404, never 403), `findHolder` **before any read or
write** so a mounted disk is refused 409 with the same wording the eject flow uses,
`recordVersion` as the sole writer, `StaleHeadError` -> 409 conflict, and `repointLateMounts` for
a board that asked for the disk between the holder check and the commit.

**The defect the review caught was a cost, not a bug.** The first history loader called
`materialise()` once per version, so a disk with N versions did O(N²) blob reads -- 45 reads for a
9-version disk, and it grows with every write the Amiga makes. It now walks the chain once,
carrying the previous raw image forward: a snapshot costs one read, a delta costs one read and an
`applyDelta`. Same 9-version disk: **9 reads**. There is a regression test that asserts the read
count, not just the output, because the output was never wrong -- only the bill was.

**THE WHOLE-BRANCH REVIEW EARNED ITS KEEP AGAIN** (it is the only pass that has ever caught a
Critical on this project, and this is the fourth time). Three findings, all real, all fixed in
`c496fc5`:

- **Critical: the files page caught one of three throw classes.** `loadHistory` throws
  `HistoryError` for a broken chain, `DeltaError` for a payload that will not decode, and a plain
  `Error` from `diskStore.read` for a blob that is missing or unreachable. The page caught the
  first and rethrew the rest -- and there is no `error.tsx` anywhere under `src/app`, so ONE
  transient blob read failure on ONE old version replaced the entire page (tree, toolbar, volume
  header, chrome) with Next's default error page, for a disk whose current bytes are perfectly
  fine. Those reads are `useCache: false`, one per version, so the odds rose with history length.
  The SDD ledger had "no test triggers DeltaError" logged as a cosmetic minor; it was pointing
  straight at this. Note the shape of the mistake: Task 2 defined the throw contract, Task 5 wrote
  the catch, and each per-task review saw only its own half.
- **Important: the history walk was unbounded.** It read and parsed EVERY version to render a
  panel that shows 20 rows. History grows by one version per Amiga save, so the cost rose forever
  with the operator's own use of the board, on the disk page's primary route. Now the newest 25
  get real file-level changes and everything older renders the sector count already in its
  metadata row, at no I/O at all; the walk starts at the nearest snapshot, which `nextKind` keeps
  within MAX_CHAIN_DEPTH. **110 versions: 90 reads instead of 111, and the bound does not move
  again.** The page also sets `maxDuration = 60`, which every other byte-touching handler already
  did.
- **Important: restore's holder check ran up to 65 sequential reads before its record.** A board
  that mounted inside that window opens a write session, and `closeSession` deliberately lets an
  already-open session outlive a version bump (§4g), so `repointLateMounts` would not have stopped
  the Amiga's save landing on top of the rewind -- while the person who clicked Restore was told
  it worked. Checked again immediately before recording. NOT fixed by moving `materialise` after
  the check: that would read a disk's bytes before refusing it, against D-W-4.

**And the full suite caught something no reviewer did.** `mobile.spec.ts`'s press-and-hold drag
started failing on this branch: the History panel made the files page taller than a phone
viewport (1332px against 844), so the page now SCROLLS -- and dnd-kit auto-scrolls a container
whenever a drag's pointer sits in its top or bottom quarter. Mid-drag the page scrolled 488 -> 314
and the drop zone slid 174px out from under a finger that, being scripted from coordinates
measured beforehand, could not chase it. Proved rather than assumed: master's `src` passes the
same test, the branch's fails at both 30 s and 180 s, with no page error and no failed request.
**A person gets that auto-scroll on purpose** -- it is how you drag a file to a folder that is
off-screen -- so the product is right and the test's assumption ("this page does not scroll") is
what stopped being true. The test now puts both rows mid-viewport first. **If you make this page
taller again, that test is the thing that will tell you.**

**Gates:** 903 unit tests green, production build clean, full Playwright suite green on port 4000
(the port is configurable now, so two sessions can run e2e at once). `e2e/time-machine.spec.ts`
covers the list, read-only browsing, restore, the mounted refusal and a foreign tenant's 404 --
and **each was proved non-vacuous by breaking the code it covers**: with restore's `recordVersion`
short-circuited the restore test fails on the content that should have come back, and with the
`findHolder` refusal removed the mounted test gets 200 where it demands 409. The restore test
carries an explicit 120 s budget (a describe block, not a global change): it signs up, creates a
disk, uploads twice, restores, then downloads the ~880 KB ADF from the live database, measured at
~70 s, which is past Playwright's 30 s default for reasons that are not the code's fault.

**Known and accepted, from the SDD ledger** (the review re-examined each and agreed, except where
noted above): `diff.ts` sorts with `localeCompare` and no pinned
locale; no test triggers `DeltaError` or a bare blob-read failure inside `materialise` (both
answer 503/500 by argument, not by coverage); and the panel's proactive mounted banner is only
computed when the head bytes read OK, so a mounted disk whose head blob is unreadable shows
Restore enabled -- the server still refuses it and the panel then says so, making the cost one
wasted click. `?version=0` on a never-edited disk 404s, and no link in the product produces that
URL. **Also still true and not this branch's doing:** `pnpm lint` reports 5 errors, all in files
this branch never touches (`devices/page.tsx`, `games/[id]/page.tsx`, `(app)/layout.tsx`,
`pair-button.tsx`, `live-refresh.tsx`) -- they arrived with the live-state work in §3ag and are
identical on master.

### 4k. THE BOARD KEEPS ITS CONNECTION OPEN — 2026-09-21

**Measured first, twice.** Every request the board made was its own TLS connection: ~1.25 s each,
of which DNS was ~0 ms (cached) and the handshake was everything. Session tickets were tried
first and looked like they barely helped (1302 ms "full" vs 1215-1253 ms "ticket offered") --
**that measurement was wrong, and the review caught it**: only
`MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_EPHEMERAL_ENABLED` is defined in this build, so the
client's pre-shared-key writer is compiled out, mbedTLS 3.6 defaults client NewSessionTicket
handling to off, and the SDK's altcp_tls swallows `MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET`
anyway. `mbedtls_ssl_set_session()` returns 0 regardless, so the log said "ticket offered" while
running a full handshake: the comparison was full vs full. The ticket code is gone.

**What shipped instead: keep-alive.** `tls_close()` hands a connection back rather than closing
it, and the next `tls_connect()` to the same host and port reuses it. **After: one handshake in
three minutes of polling, with the 2 MB image fetch and the status report riding the connection
the poll opened** (before: one per request).

**The whole difficulty is knowing when a connection is safe to keep**, and two review rounds went
into it:
- `transport.h` gained **`abandon()`** — the thing `close()` could not say. Every non-clean exit
  from `dc_attempt` (connect failure, a write that stalled after a partial request, a read error
  or timeout, a malformed response) abandons. Without it, `tls_close()` could not tell "the
  response finished" from "we gave up while it was still coming", and a kept socket would have
  made **every later response belong to the previous request, permanently** -- it never
  self-heals, because each exchange then finds a complete stale response already waiting.
- A response being **complete is not the same as being framed**. `http.c` declares
  `body_complete` at end-of-headers for a close-delimited response, so the keep now also requires
  explicit framing (Content-Length, chunked, or a bodyless status) and no `Connection: close` and
  no bytes seen after completion. `Transfer-Encoding: gzip, chunked` is matched by token, not by
  prefix. A 1xx resets the parser instead of being taken for the response.
- **The retry is deliberately narrow.** A kept connection can die while idle with nothing to say
  so, so `dc_exchange` retries once -- but only when the connection was reused AND not one byte
  arrived, and never for `/api/device/register`, whose pairing code is single-use (a resend would
  turn a lost response into a terminal `invalid_or_used_code`). A request the server has begun
  answering is never resent.
- **Idle connections are released, not just refused.** `tls_idle_expired()` is the single
  comparison behind both `tls_can_reuse()`'s refusal and `tls_release_if_unreusable()`, which
  core1 calls once per pass of each waiting loop. An earlier version guarded "before a sleep of
  10 s or more" and missed every busy-wait -- notably the uploader's, which backs off to 60 s in
  50 ms naps. The connection is also released on every way out of the loop (DC_HALTED, a rejected
  pairing code, and the portal catch-all), where it used to be held across an AP episode with
  ~32 KB of mbedTLS buffers.

**Gates:** host suite 22 binaries green (device_client 220 checks, http 185, uploader 144),
device build clean, measured on hardware as above. `transport_tls.c` and `main.c` are excluded
from the host build by name, so the idle release and the loop wiring rest on the argument and the
measurement, not on a test.

**Next, if uploads still feel slow:** the remaining per-request cost is one round trip, not a
handshake. What has NOT been measured is a burst of track uploads over a reused connection --
that needs an Amiga write.

### 4j. A WRITE-PROTECT FLIP ON THE MOUNTED DISK IS ANNOUNCED AS A DISK CHANGE — 2026-09-20

**Branch `feat/wp-reinsert`.** AmigaDOS reads a disk's write-protect state only when it believes
a disk was inserted — a real floppy's tab sliding while it sits in the drive changes nothing
until it is re-inserted. The board can flip WPROT live (the server bumps it for a flag-only
change, or the uploader forces it, §4i), so a flip on the SAME mounted disk now has to be told
to the Amiga the way an insert is: `/CHNG` asserted until the next STEP, same as
`dskchg_image_inserted()`'s normal path (`src/reinsert.c/.h`, `src/dskchg.c`, `src/main.c`).

**Verified on hardware TWICE — the second time on this exact build, with the board's log
running** (2026-09-20, Install disk, one boot, no reset between steps):

    218.1-219.4  write: trk 80/19/80 applied      -- t1.txt, disk writable
    243.6        close: 6610d5958801
    254.4        wprot: changed on the mounted disk -- announcing a disk change
    254.4        reinsert: /CHNG asserted until the next step (write-protect changed)
    254-295      (t2.txt attempted here -- NOTHING captured: the Amiga refused it itself)
    295.1        wprot: changed ... announcing a disk change   -- writable again
    314.0-316.3  write: trk 80/20/19/80 applied   -- t3.txt
    330.2        close: 3d16e0ac320d

The server's history gained exactly those two versions (9: `6610d5958801`, 10: `3d16e0ac320d`),
and xdftool reads `t1.txt` and `t3.txt` in the head image with no `t2.txt`: the refused write
created nothing, anywhere. Both announcements fired in the same millisecond as the flag change
(the Amiga was idle), so the 15 s forced path below was never needed and logged nothing.

**Review found the first cut's idle window could be defeated, and its "may we announce" gate
could starve; both are fixed here:**
- The idle window before announcing (`REINSERT_IDLE_MS`, 3 s) used to key off
  `g_write_last_ms`, stamped only when a capture was *applied*. A rejected capture — torn, a bad
  checksum, the wrong track, an overflow — left it stale, so the gate could pass immediately
  after the Amiga had just finished writing: exactly the case the window exists to avoid. A new
  `g_wgate_last_ms` is now stamped in the WGATE ISR on both edges (a volatile store only, no
  logging — it is an ISR), and the window is measured against the later of the two timestamps.
- The gate itself could starve: `dskchg_motor_on()` only changes when the Amiga next selects
  DF0, and a powered-off Amiga leaves WGATE reading asserted forever. A pending request now
  carries a deadline (`g_reinsert_raised_ms`, `REINSERT_FORCE_MS` = 15 s): past it, the board
  announces anyway — a step clearing `/CHNG` early is recoverable, since the next flip re-raises
  it — and logs one `WF_WARN` saying it was forced, so a request that never fires is never
  silent.
- The gate is now a pure function, `reinsert_may_announce()` (`src/reinsert.h/.c`), taking every
  input — `now`, when the request was raised, motor state, WGATE state, the last-activity
  timestamp — as a parameter and returning the decision plus whether it was the forced case.
  `main.c`'s core0 loop keeps only the volatile reads and the `dskchg_image_inserted()` call.
  Host-tested (`test/test_reinsert.c`): idle-and-quiet announces; motor on waits; WGATE asserted
  waits; inside the idle window of a write (applied OR merely attempted) waits; past the 15 s
  deadline announces forced; and unsigned time wraparound is handled with the same
  `(int32_t)(now - x) >= 0` idiom `uploader.c` uses, not treated as a special case.
- `reinsert_on_wprot()` (`reinsert.c`) no longer lets an empty disk id (the poll omitting
  `diskId`) overwrite the remembered one — it kept the "never claim an empty id is the same
  disk" rule for the CURRENT pass, but used to still stomp the stored id with `""`, so the next
  poll that DID carry the real id looked like a different disk and swallowed the flip it should
  have announced. Three-pass test added: id, empty, id + flip → announces.
- Two minor items from the same review: the read-then-clear of `g_reinsert_req` in `main.c` is
  not atomic against a concurrent set from core1, and a comment at the clear site now says why
  that is harmless (core1 always stores the new WPROT pad state before setting the flag, so
  whichever announcement fires still conveys the newest state); and `dskchg.c`'s `st` is now
  `volatile` (written by the STEP ISR, polled from the main loop — safe today only because there
  is no LTO).

**Known, not yet exercised on hardware:** `up_forces_wprot()` (`src/uploader.h`) — a `409
write_protected` answer, or a parked uploader — also forces WPROT true, and clearing it forces
WPROT back, so both edges now go through this same announce path. Defensible (the Amiga has to
be told either way), but it has only been exercised host-side so far, and an application holding
an open file on the volume when it fires can see "You MUST replace volume ...".

### 4i. THE AMIGA'S WRITES REACH THE SERVER — 2026-09-19 (write-back piece 2b)

**Verified on hardware** (board WifiFloppy1, rev A2, the Workbench 3.1 disk the operator marked
writable). Plan `docs/superpowers/plans/2026-09-19-write-back-piece-2b-firmware-upload.md`.
`WF_WRITE_BACK`, `WF_WRITE_CAPTURE` and `WRITE_BACK_IMPLEMENTED` are gone: write-back is on in the
normal build. Gate: host suite green, vitest 853, device build clean with the new code confirmed
linked (`nm`), full Playwright suite on the branch before merge.

**What the board does now** (src/uploader.c, pure and host-tested; main.c wires it):
- Each dirty track goes up as `POST /api/device/write?...&session=<per-boot token>&seq=<n>`, one
  request at a time on core1. **Every attempt spends a seq** (a lost response must never make the
  next track reuse a seq the server already staged: it would be answered `duplicate` and
  dropped). The close sends the last seq attempted; a lost last upload converges through `409
  incomplete`.
- 3 s after the last applied write the board hashes all 160 decoded tracks (src/sha256.c) and
  closes; on 200 it adopts the digest (no re-fetch). A write landing mid-hash postpones the close.
- While writes are pending the uploader runs **instead of** the 25 s long poll, and
  `dc_set_hold` stops a swap or eject from releasing the disk (D7).
- A status report owed after a mount-version change goes out before any upload, and counts only
  on a 2xx: the server decides `not_mounted`/`behind` from the mountedVersion it last heard.
- `409 mismatch` / `write_protected`: the server's image wins (dirty tracks discarded, forced
  re-fetch even of the same digest). `not_mounted` / `behind` / 404 / 400 / 422: **parked** —
  hold released, WPROT forced until the mount changes. Offline and 5xx: back off (1 s doubling,
  60 s cap) and keep holding.
- The OLED pencil became a cloud on writable disks: plain = synced, up-arrow = unsent writes,
  struck = unsent and the server unreachable. Read-only keeps the padlock.
- `mfm_decode_track` is now called from both cores; `mfm_decode_track_r` takes caller-owned
  scratch (the final review found the shared static buffer could splice sectors with valid
  checksums across cores).

**Hardware results (operator-confirmed, server checked with xdftool, not the app's reader):**
| test | result |
|---|---|
| `echo >DF0:wb2b.txt` | uploads trk 69, 80 (~1.6 s each), close; `disk_versions` 0 original + 1 amiga (4 sectors); xdftool reads the file |
| board restart | re-fetched the post-write image; after Ctrl-A-A `type` printed the file |
| write then eject within 3 s (D7) | 3 uploads + close at 436.1 s, EJECT at 439.0 s; server image has both files |
| board blocked on the UniFi, then write | 4 failed attempts (DNS), backoff 1.1→9 s; unblocked → seq 5, 6, close; server image has the file |

**Measured:** TLS handshake ~1.1 s per request (every request was a new connection then; see 4k),
so ~1.6 s per track and ~2.7 s for the close including the 160-track hash. Write-to-synced split
by what core1 was doing: **5.7 s** when it was free, **12.3 s** when the write landed inside a 25 s
long poll. Offline recovery: attempts every ~7 s (DNS), backoff 1.1 → 2.2 → 4.5 → 9.0 s, and ~11 s
from the block lifting to the save being on the server. After four saves the server held 0
`original` + 3 `amiga` deltas (4, 5 and 4 sectors), with xdftool reading `wb2b.txt`, `wb2b-2.txt`
and `wb2b-3.txt` in the head image.

**Found on the bench and fixed (6bb5454):** a write landing during the long poll waited for it
(6 s) **and the cloud read plain meanwhile** — up_sync was only recomputed on core1. core0 now
shows the up-arrow whenever the active slot has dirty tracks.

**Still open:**
- **Upload latency behind a long poll**: a write that lands mid-poll waits up to ~25 s before the
  first upload (the cloud is honest about it now). A shorter server hold, or an early return,
  would fix it.
- ~~**One connection per request**~~ **FIXED 2026-09-21 — see 4k.** Keep-alive: one handshake per
  three minutes of polling instead of one per request. What has still never been measured is a
  burst of track uploads over a reused connection; that needs an Amiga write.
- The **struck cloud** was not seen by the operator during the offline test (they looked before
  the first failed attempt); the dc hold path was not exercised on hardware either (polls are
  suppressed while pending, so the eject was only seen after the close). Both are host-tested.
- ~~**Acceptance 4 (restore): built and merged 2026-09-21 (4l), never driven on hardware.**~~
  **PASSED ON HARDWARE 2026-09-22.** The operator ran all six steps and every one behaved as
  written: Restore was refused while the board held the disk, it succeeded after an eject, and
  after a re-insert the Amiga showed the earlier content. The live database agrees. On disk
  `cf490572…`, v11 is the Amiga write (18:54 UTC) and v12 is `source='rewind', rewind_of=10`
  (18:55), whose `image_sha256` is byte-identical to v10's (`3d16e0ac…`). v11 was kept (D2). The
  board then reported `mounted_sha256 = 3d16e0ac…` with desired = mounted = 81. The refusal in
  step 3 is the operator's report only, because a 409 leaves no row. The
  panel has no distinct "parked" state.
- Two vitest failures appeared once in the worktree before a crash and did not recur (853/853).
- Deferred minors from the reviews (none blocking): the ~50 ms `wifi_rssi()` radio query during
  waits; a failed owed status report sent twice in one pass; the dead-token log undercounts
  sent-but-unclosed tracks; torn-read retries without delay; a parked slot's dirty flags are not
  cleared after replacement; stale comments in uploader.h/.c and main.c; `PENCIL_W`/test wording;
  `http_build_head` duplicates `http_build_request`'s header pattern.

~~**Next: piece 3, the time-machine UI**~~ **DONE 2026-09-21 — see 4l.** History panel, Browse
and Restore are merged and live. ~~**What is left is hardware acceptance 4**~~ **PASSED ON
HARDWARE 2026-09-22** (see the acceptance-4 bullet above for the rows that confirm it). The
Amiga reads the restored content after a re-insert, so the board side of restore
(`findHolder` refusing, then the board picking up the rewound image) has now run on real
hardware, not only in e2e and unit tests.

### 4h. A MOUNTED DISK IS CHANGED ONLY FROM THE AMIGA; THE FILES-EDIT FLAKE WAS A TIMEOUT — 2026-09-19

**Merged (`682f127`) and live.** Gate on the merged tree: 853 vitest, tsc and build clean,
**276/276 Playwright** (48.5 min, no flakes).

**The rename lock settles 4g's open decision.** The operator's rule, verbatim: "if a volume is
mounted, it cannot be modified by the server. If modifications should happen, these must come
from the (mounted) Amiga side of things." Renames (`PATCH /api/disks/[id]/volume-name`) are now
refused like file edits: 409 `{error:'mounted', reason}` for a disk any device in the org has
mounted or desires, from the one `findHolder` (`src/lib/disk-holder.ts`); the library card shows
the field disabled with the reason (wording from `src/lib/mount-wording.ts`, client-safe). The
write-protect flag is a setting and still applies live; title/metadata edits do not touch the
disk. Spec §3.5 records it.
- **The race it had to close:** a board can start wanting the disk after the refusal check and
  before the edit is recorded. `repointLateMounts` moves exactly those boards onto the new head;
  it never runs when the edit changed nothing, was refused, or hit a conflict.

**`e2e/disk-files-edit.spec.ts` flaked about one run in three, and it was the test, not the
product.** Its post-edit tree assertions used Playwright's default 5 s. Each UI edit is two
sequential round trips to the live DB from a dev machine: the edit route (median ~2.2 s, max
4.4 s) and then the `router.refresh()` re-render (median ~1.1 s, max 1.9 s). Click-to-refresh-
complete had a median of ~3.4 s and a tail of 4.95 s over 77 traced edits. **75 of 75 completed
refreshes carried the edited tree; 0 stale.** The failures were refreshes still streaming when
the 5 s expired. The earlier note's "20 ms refresh with the old tree" was time-to-headers, with
the body never delivered. Delaying every edit by 2 s (a `page.route` hold) failed 5/5 UI-edit
tests unfixed and 0/7 fixed. It failed 3 of 5 runs on the commit before piece 2a, so 2a did not
cause it. Fix: `AFTER_EDIT = { timeout: 15_000 }` on those assertions (the same 15 s that
`mobile.spec.ts` and `disk-drag-drop.spec.ts` already use); 5/5 solo runs green since.
**If this spec fails again, read the trace's RSC refresh first:** `receive -1` means a cut
stream (latency), a completed body without the edit would be a real staleness bug.

### 4g. THE SERVER SIDE OF WRITE-BACK — 2026-09-18 (write-back piece 2a)

**Merged and live; not yet exercised by a board.** Plan
`docs/superpowers/plans/2026-09-18-write-back-piece-2a-server.md`, spec §3 of
`docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md`. Migrations 0015 and
0016 are applied (`db:push`, 2026-09-18). Gate: 850 vitest, build clean, **275/275 Playwright**
(47.8 min, no flakes).

**What exists:**
- `disk_versions`, `disk_write_sessions`, `disk_write_tracks` (`src/db/schema/disk-history.ts`).
- `src/lib/disk-history/version.ts` (pure: `overlayTracks`, `planNextVersion`) and
  `store.ts`: **`recordVersion` is the only writer of a new disk image.** Browser edits
  (`applyDiskEdit`) and renames (`volume-name`) now go through it, so every browser edit
  already makes history in production.
- `recordVersion` refuses a **stale head** (`StaleHeadError`: the history's last image is not
  `disks.sha256`, or a concurrent writer took the same seq). Edit routes answer 409
  `{error:'edit_failed', reason:'conflict'}`, volume-name 409 `{error:'conflict'}`.
- `src/lib/device-write.ts` behind `POST /api/device/write` and `/api/device/write/close`.
- Live write-protect: `PATCH /api/disks/[id]` bumps `desiredVersion` for every device that
  desires the disk.
- TOSEC `authored_none` treats any `disk_versions` image with `seq > 0` as decided.
- e2e: `reclaimDeltaBlobs` (e2e/device-helpers.ts) runs before every disk delete; both blob GCs
  and `releaseEntitlements` treat anything `disk_versions` names as referenced.

**The device protocol plan 2b must implement — it differs from the spec text in four places:**
1. **`session=<token>` on upload and close** (1-64 chars `[A-Za-z0-9_-]`), random per session,
   kept until close resolves. A new token at the same mount discards the old session's tracks.
   *Why:* a reboot does not bump `desiredVersion`, so without it the rebooted board's seq 1..N
   were swallowed as duplicates.
2. **A session's `mount` is fixed from open to close.** Keep sending the mount the session
   opened under even after the poll reports a bumped version for the same disk (live WP,
   another board's close). Only opening a session needs the current version.
3. **Write-protect is decided at open.** An open session keeps accepting tracks; only a new
   session is refused `write_protected`.
4. **Close answers:** 200 `{sha256}` (adopt it, no re-fetch); 200 `{sha256, unchanged:true}`;
   409 `mismatch` (the server's image won; take the bumped poll and re-download — do not
   re-close); 409 `conflict` (the session is KEPT; retry with backoff, cap it); 409
   `incomplete` (`seq` ≠ the session's last seq — the session is kept; re-upload its tracks);
   409 `not_mounted`. Opening a session (the first upload of a token) can also answer 409
   `{error:'not_mounted', reason:'behind'}` (see below). A nothing-staged close with a digest
   that differs from the head now
   answers `mismatch`, so a lost 409 cannot turn into a silent 200.
   Close overlays the staged tracks onto the session's **base** image (the head when it
   opened), so the digest matches the board's; it is then recorded on top of whatever the
   head is now — **last writer wins, the other write stays in history.**

**Operator decision, SETTLED 2026-09-19 (see 4h):** renames of a mounted disk are refused, so a
browser rename can no longer be superseded by an Amiga save. Last writer wins still governs two
boards.

**The four items parked at the final review — settled 2026-09-19:**
- **FIXED (e8f817f):** a session opened while the board had not yet acknowledged a same-disk
  bump took the new head as its base, not the image the board holds. Opening is now refused
  with **409 `{error:'not_mounted', reason:'behind'}`** while `desiredDiskId = disk and
  desiredVersion > mountedVersion`; an already open session still continues and closes.
  Write-protect is checked first (turning it on bumps the board as well, and the flag is the
  real reason). **Plan 2b: on `behind`, take the bumped poll and re-download, like
  `not_mounted`.**
- **FIXED (e8f817f):** a close retried after a crash between `recordVersion` and its device
  batch recorded nothing the second time and so never bumped the other boards. The other-board
  bump is now keyed on `desiredSha256 <> head`, run on every close: a retry repairs them, and a
  close that changed nothing bumps nobody.
- **Firmware requirement for 2b, not fixable server-side:** an old boot's upload still being
  processed when the new boot's first upload lands discards the new token's session (random
  tokens have no order). It surfaces as a close `mismatch` (the server image wins, the board
  re-downloads), never silently. Accepted as force majeure; a boot counter in the token would
  let the server order them if it ever matters.
- **Firmware requirement for 2b:** a status report in flight can overwrite the `mountedSha256`
  a close just set. The rename lock is not weakened (`findHolder` also matches
  `desiredSha256`, which the close sets); the board only reads as unconverged until its next
  report. **Keep one request in flight across the uploader and the status reporter.**

**`db:push` re-emits constraints every time, harmlessly.** It drops and re-adds the composite
PKs on `entitlements`, `collection_games`, `demozoo_dismissals`, `demozoo_suggestions`, and the
`disk_write_tracks` → `disk_write_sessions` FK (its generated name exceeds Postgres's 63 chars
and is stored truncated). Verified intact after both pushes, rows unchanged. Giving that FK an
explicit short name would stop one of them.

**`e2e/disk-files-edit.spec.ts` flaked during the build.** Root-caused and fixed 2026-09-19: a
5 s timeout against two live round trips, not a race and not stale data. See 4h.

### 4f. THE BOARD APPLIES WRITES — 2026-09-18 (write-back piece 1)

**Verified on hardware**, rev A2 board, `-DWF_WRITE_BACK=ON`, Workbench 3.1 marked writable
on the server and then remounted (the flag is read at mount until piece 2).
- `echo "written by the amiga" >SYS:wb-test`, then `type`: correct.
- **After a Ctrl-Amiga-Amiga reset**, which discards AmigaDOS's own buffers: still correct,
  so the file came back from the board's copy.
- A `Copy SYS:Utilities RAM:u ALL` / `Delete` / `Copy back` round trip, then a reset:
  `dir SYS:Utilities` complete.

Operator-confirmed. **32 track writes over 14 distinct tracks, every one applied, 0 rejected,
0 partial, 0 overflowed, 0 apply failures.** Apply time (verdict + encode + PSRAM store) was
2.4–5.7 ms. Two `record(s) dropped` lines, both outside the write window (reboot read bursts).

**What exists** (spec `docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md`
§2; plan `docs/superpowers/plans/2026-09-18-write-back-piece-1-board-applies-writes.md`):
- `mfm_encode_track()`: a C port of `src/lib/adfmfm`, byte-identical to the golden tracks.
- `write_back.c`: the verdict applies only a whole, clean track on the disk that was mounted
  when WGATE asserted (spec D5). The apply re-encodes it and stores it DIRTY in the active slot.
- `track_cache_invalidate()`: SRAM copies are keyed on (track, token), and a write changes
  neither, so without this the old bytes would keep being served. A test asserts that failure.
- `main.c`: wired behind `WF_WRITE_BACK`, with a boot banner and `write: trk N applied in U us`.
  **`write_track`/`write_token` are snapshotted once per capture.** The whole-branch review
  found the ISR could rewrite them mid-block when the next track's write began, which would
  have stored track N's data under track N+1's number. All three per-task reviews had passed it.
- `write_back.c` was missing from CMake's source list in the plan; Task 3 added it.

**Still NOT done:** writes are lost at eject and power-off, because nothing goes upstream.
That is spec piece 2 (upload, sessions, server history, live write-protect, the cloud icon),
followed by piece 3 (the time-machine UI). The normal build is unchanged, and WPROT is always
asserted there.

**Log capture misses the first ~12 s of boot** on `picotool load -x` + `cat`, twice today, so
the banner and `pio claims:` lines have never been read. Worth a look before piece 2's bench
work.

### 4e. A SECOND DRIVE WORKS: THE BUS IS GATED ON SEL0 — 2026-09-18

**Verified on hardware** (`0ece072`), rev A2 board, real external DF1 on an A500-class machine:
Workbench 3.1 boots from DF0, a DOS floppy in DF1 shows its real name (Sysinfo), and `dir df0:`
and `dir df1:` both list. Over 10,684 log lines: **2,063 DF0 steps followed, 250 DF1 steps
ignored, 0 TRACK-MISS, 0 records dropped, 0 errors.** Operator-confirmed.

**Why it was needed, measured first on the ungated firmware (same day, same drive):** every DF1
disk-change click moved DF0's head one cylinder (30 -> 79 in two minutes); DF1's 80-step
recalibrate on insert walked it back to 0; and the floppy came up as `DF1:????`, because the
board's flux was on the shared RDATA line while DF1 was selected.

**What changed.** The design is the one §4d's research sketched:
* **Outputs.** `status_gate` (pio1) owns INDEX, CHNG, WPROT, RDY and TRK0 and drives them only
  while SEL0 is asserted, with a ~33 ns loop. `bus_out_set()` is the only writer: one shadow word
  under a hardware spinlock, because it is written from the DMA IRQ, the STEP ISR, dskchg and
  core1's poll loop. **`gpio_put()` on those pads now does NOTHING, silently**, so `test/run.sh`
  fails on one (mutation-checked). `flux_out` pulses RDATA only while SEL0 is asserted, with
  every path still exactly 8 cycles; the stream keeps turning while deselected.
* **Inputs.** `step_dir` samples SEL0 with DIR at STEP's fall (`bus_step_decode`); another
  drive's steps are counted (`sel0: ignored N step(s)`), not acted on. `sel_mtr` (pio1) latches
  MTR on SEL0's falling edge like a real drive, replacing the MTR edge interrupt. WGATE is
  captured only with SEL0 asserted, read at interrupt time, which is enough because the Amiga
  holds the select for the whole ~200 ms write. **That last one is a write-back prerequisite:**
  without it a DF1 write would be applied to DF0's image.
* **Pure half:** `bus_gate.c`, 45 host checks.

**The radio is on pio2, not a free block.** `pio_claim_free_sm_and_add_program_for_gpio_range`
searches pio2 FIRST (it counts down), so CYW43 has always sat beside `step_dir`. The old
comment claiming otherwise was wrong. pio1 is now the gate's: `status_gate` 6 + `sel_mtr` 12 +
sniffer 13 = **31 of 32 instructions** in a sniffer build. There is no room for another program
there. A boot line, `pio claims: pio0=.. pio1=.. pio2=..`, records the real assignment, **but it
has not been read yet:** the capture attached 12 s late and missed it. Read it on the next boot.

**The sniffer changed** (`-DWF_BUS_SNIFF=ON`, not yet run): it is on pio1, samples GP0..13
without WDATA/RDATA, and logs `a` as a plain GPIO mask. It also counts any status output
asserted while SEL0 is released (`sniff: N sample(s) ...`, as an ERR). That is the direct
electrical check of the gate; the DF1 test above is the functional one.

**`f55d415` is now verified too:** a clean WB boot, and at Amiga power-ON (not off, as §4d
predicted) one `write: WGATE pulse, 33 intervals, not a write` line in place of an empty decode.

**Known limits:**
* A read pulse already under way when SEL0 releases runs out its 750 ns.
* SIDE is deliberately not gated: the Amiga sets it before selecting, so a latch would miss it.
* The board is DF0 only. Every program takes the select pin as a parameter, so becoming DF1
  on a big-box machine is small. Nobody has asked for it.
* Every other DF1 click reads outward when checked late but was latched inward at the edge. The
  Amiga may change DIR in the same CIA write as STEP for DF1. Those steps are ignored now, so it
  no longer matters to us.

### 4d. AN AMIGA WRITE IS CAPTURED WHOLE — 2026-09-15

**The capture path works on real hardware.** Rev A2 board, 1 kΩ to +5 V on WGATE, WDATA and
MTR, `-DWF_WRITE_CAPTURE=ON`, Workbench 3.1 marked writable on the server, `echo hello
>SYS:t5` in a Shell. Three tracks written (80, 69, 80), every one: **`sec 0x7ff ALL bad 0`**,
track number matching the head at WGATE assert. Ring backlog peaked at 711 of 4,096 words,
service-loop gap 3 ms or less. Writes are still decoded, logged and DISCARDED --
`WRITE_BACK_IMPLEMENTED` is 0 and nothing reaches PSRAM or the server. `6c1395f`.

Four defects stood between the first WGATE and that line, and none of them could be seen
before a real Amiga wrote:

1. **WDATA's pad was never initialised** (`95ce393`). An RP2350 pad is isolated from reset
   until `gpio_set_function()` clears ISO, and PIO reads it as 0. It looked exactly like the
   floating WGATE line, and a pull-up did not change it -- 0 V across the resistor, both
   legs high, was the reading that separated them. See §4c's follow-up.
2. **The drive-ID shifter made the Amiga ignore DF0.** With MTR finally pulled up, motor-on
   edges arrive, the ID phase runs, and Kickstart **does** read DF0's ID at power-on (the
   file's comment said DF0 ignores it): 33 selects in ~141 µs, each held 1-4 µs, then 34 for
   DF1. The GPIO ISR caught **0 of 33** and missed the 3 µs motor-on pulse too. The Amiga
   then never selected DF0 again and asked for "DF0: in any drive", while polling DF1 -- the
   board drives RDY without looking at SEL, so it answers DF1's ID too. A/B on the same
   board and Amiga: shifter skipped, SEL0 2,128 edges, Workbench boots. **`WF_DRIVE_ID` now
   defaults OFF.** Doing it properly needs something as fast as the select (PIO, or a level
   held through the whole read), and the board should stop driving its outputs for
   selects that are not its own.
3. **`mfm_decode_track` searched for sync on byte boundaries.** A capture begins at whatever
   edge came first, so the Amiga's bit grid lands at any of eight offsets. Two captures of
   the same track, histograms ten intervals apart in 48,850, decoded 10 sectors and 0. The
   existing "mid-track" test rotated by whole bytes, which is exactly the case that passes.
   Sync is now found at every bit and each sector realigned from its own.
4. **It demanded 1,084 bytes after a sync; a sector has 1,080** (the extra 4 are the NEXT
   sector's preamble). A write is gap first (~13,264 bits) then eleven sectors, ending at bit
   108,980 of a 108,992-bit capture -- so the last sector was never tried, every time.
   Carried over from the byte-aligned version. Found by logging where decoded sectors sit.

Each of 2-4 has a host test that failed first with the board's own signature (0x000,
0x01f/0x3ff). 1,989 host checks. A false "track says 69, head is on 70" also went: the
track is now sampled when WGATE asserts, not when the decode is logged.

**Instruments that paid for themselves tonight, all still in:** per-write lines for sector
positions, ring backlog, loop gap and the interval histogram (`write: first id..`,
`write: backlog..`); an `id:` line per motor-on counting SEL0 edges the ISR saw. The first
write line was being truncated at `WF_LOG_MSG` (88) and hid `OVERFLOWED` -- now shortened.

**Capture tip:** start the log reader in the same command as `picotool load`. Attaching
~25 s late let the Amiga's polling fill the 64-slot ring and drop the `wprot`/`MOUNT` lines.

**Sustained write, same night (23:45):** `AddBuffers DF0: 200`, then `Copy SYS:Utilities RAM:u
ALL`, `Delete SYS:Utilities ALL`, `Copy RAM:u SYS:Utilities ALL` -- a round trip that needs no
free space on a full disk, and writes nothing the server keeps. **31 WGATE assertions over
55 s, 31 captures, every one `0x7ff ALL bad 0`**, no wrong-track warnings, no overflows, 15
distinct tracks (0-5, 69, 80 six times, 154-159). Backlog peaked at 668/4,096, loop gap 3 ms.
0 log records dropped in the write window (the two drops were at Amiga power-off and during
the boot reads, both minutes earlier). No error on the Amiga either -- AddBuffers kept
AmigaDOS from re-reading blocks the board had discarded.

**Harmless noise to know about:** at Amiga power-off WGATE (pulled up to the Amiga's own
+5 V) falls, the capture arms, and the log shows the 400 ms timeout plus an empty
`write: trk N 0 iv` decode. Skipping zero-interval captures would silence it.

**Follow-ups taken 2026-09-16 (flashed and verified 2026-09-18, see §4e):** the drive-ID shifter is
deleted outright (operator agreed: nothing measured needs an ID answer, and a broken one
behind a flag invites being switched back on), and a capture of fewer than 2,176 intervals
-- less than one sector can hold -- logs `write: WGATE pulse, N intervals, not a write`
instead of an empty decode. Host suite green, normal and capture builds clean. **To verify:**
flash normal firmware, power-cycle the Amiga, expect a clean Workbench boot with 0
TRACK-MISS and, at power-off, the one-line pulse message.

**Still not done:** a write reaching the image (history model undesigned); a full-disk
write (a format); **SEL-gated outputs -- DONE 2026-09-18, §4e. Originally REQUIRED, operator 2026-09-16:** a second drive
(external DF1 on A500/600/1200, or a second internal drive on big-box machines) is optional
but must work, and today the board drives all six shared open-collector outputs regardless
of which drive is selected. An interrupt cannot gate them (selects last microseconds), so
this is PIO work that changes pin ownership; design before building.

  **Research for that design, 2026-09-16 (nothing built, nothing approved):**
  * **Measured, from the 2026-09-15 no-ID sniffer boot:** 2,672 SEL0 selects after the ID
    read -- median **56 us**, 95% under 100 us, minimum 5 us. The Amiga reads CHNG/WPROT/
    TRK0/RDY inside those windows, so outputs must follow SEL0 in PIO time, not ISR time.
  * **Inputs need gating as much as outputs.** The board counts STEP, follows MTR/SIDE and
    captures WGATE whoever is selected. With a real DF1, the Amiga's DF1 disk-change stepping
    would move DF0's cylinder, and a DF1 write would be captured -- and once write-back
    exists, APPLIED -- as a DF0 write. So this is a prerequisite for write-back, not polish.
    All 1,838 STEP falls in that boot came with SEL0 asserted, so qualifying STEP on SEL0 at
    the falling edge loses nothing real.
  * **Pin facts:** outputs are GP0 INDEX, GP1 CHNG, GP10 WPROT, GP11 RDATA (pio0 `flux_out`
    side-set), GP12 RDY, GP13 TRK0; GPIO high = bus asserted. Releasing by output-disable is
    too slow (pad pull-down into a BSS138 gate is ~ms), so gating must drive the pin low.
    INDEX and TRK0 are written by the CPU from the DMA IRQ and the STEP ISR today.
  * **Direction under consideration:** a PIO status-gate machine owning INDEX/CHNG/WPROT/
    RDY/TRK0, fed a shadow value by the CPU and forcing them released while SEL0 is high;
    `flux_out` checking SEL0 per bit cell with both paths still 8 cycles; `step_dir`
    sampling SEL0 with DIR; MTR latched on SEL0's falling edge like a real drive; WGATE
    captures only while selected. Verify by extending the sniffer to the output pins
    ("nothing asserted while SEL0 is released") and, if a second drive is available, by
    real DF1 traffic with DF0 mounted.

### 4c. THE READ ERROR WAS A MISREAD STEP DIRECTION — FIXED 2026-09-14

**Cause, measured.** The Amiga drives DIR only for a window around each STEP pulse:
low ~150 µs before STEP falls, released ~25-40 µs after it. The GPIO ISR read DIR with
`gpio_get()` when the ISR *ran*, not when the edge happened, so any interrupt latency past
~30 µs read an inward step as outward. Each misread left `cur_cyl` two cylinders behind the
Amiga, which was then served valid MFM for the wrong cylinder. On 2026-09-14 the Amiga
asked for cylinder 72 (track 145, block 1598) three times and got cylinder 70 each time,
with a misread in each of the three seeks.

| evidence | |
|---|---|
| one-step reversals mid-seek | present in all 9 earlier captures, both builds |
| inward seek WITH a reversal -> Amiga re-homes | 44 of 59 (75%) |
| clean inward seek -> Amiga re-homes | 10 of 102 (10%) |
| read-only build (write capture compiled out) | same error, same block |

**Fix: `step_dir` in `floppy.pio`**, on pio2, latches DIR within two PIO cycles (~13 ns)
of STEP falling and pushes one word per pulse; `step_pio_isr` drains it. STEP and DIR are no
longer GPIO interrupts. Measured on the same disk and workload afterwards: Workbench 3.1
boots, `dir df0: all` completes with **no read error**, **0 reversals in 2,283 steps**,
**0 of 46** inward seeks followed by a re-home. `DIR-LATE` traces and the periodic
`step: N pulses; an interrupt-time DIR read would have been wrong on M` line count the
misreads the old read would have made in the same run: **20 of 2,291**, every one on an
inward step.

**Two instrumentation facts that cost time and will again:**
* The console prints **milliseconds**; records hold microseconds. "SIDE edges <1 ms apart"
  meant "same millisecond", which hid the structure until a µs field was added.
* The SDK's GPIO IRQ handler dispatches pending edges in **ascending pin order**
  (SEL0=2, DIR=5, STEP=6, SIDE=9), and each callback reads the pin's *current* level. Log
  order inside one millisecond is pin order, not time order.

**Why 4b called step tracking exact:** it was measured on a 70-step seek *outward*, and
outward steps never misread (DIR idles high, which is outwards). Check which case a
measurement covered before calling a mechanism ruled out.

**SIDE: MEASURED, UNDERSTOOD, AND DELIBERATELY LEFT ALONE (2026-09-14).** Captured with
`-DWF_BUS_SNIFF=1`, a PIO logic analyser on all eight inputs (`bus_sniff` in `floppy.pio`)
that logs every change in exact order -- the GPIO ISR cannot, see the pin-order note above.
Boot plus `dir df0: all`: 17,213 bus changes, 0 dropped, 0 FIFO overflows.

What the Amiga does on every selection: one write asserts SEL0 with the SIDE (and DIR) it
wants; it holds them for the whole selection; then it releases SIDE, then DIR, then SEL0, in
separate writes microseconds apart. A track read is one long selection (~224 ms, one
revolution). Idle polls and each step are selections under 0.1 ms.

| | |
|---|---|
| long selections (reads) with SIDE constant from select to release | **183 of 183** |
| stream restarts landing inside a read | **0** |
| reads starting with the wrong side streaming (3 ms grace) | **0 of 196** |
| short selections where SIDE moves inside the hold | 144, all step sequences <0.1 ms |

The firmware reacts to every SIDE edge, including the release writes and edges while
deselected, so it restarts the stream after most selections -- but never during a read, and
both runs read clean. **That is churn, not a fault, so it was not changed:** last night's
SIDE change broke mounting for reasons never pinned down, and there is no failure here for a
new one to fix. If an index-sensitive loader or write support ever needs the stream left
alone, the model is: honour SIDE only while SEL0 is asserted, and ignore the release writes
before the deselect. The sniffer data is enough to test that rule offline first.

**FOUND ON THE WAY, AND IT BLOCKS WRITE SUPPORT: WGATE and WDATA read LOW (asserted) in
every sample with the Amiga on**, write-protect asserted and nothing writing. A line that
never moves produces no edges, which is consistent with 4b never capturing a real write.
Unconfirmed hypothesis: the Amiga's WGATE/WDATA outputs are open-drain and rely on the
drive's pull-ups, and this board has no resistors at all (see `bom.csv`) -- the '541's CMOS
inputs are high-impedance, so a released line sits low. Measure first: J1 pin 22 (WDATA)
and pin 24 (WGATE) to ground with the Amiga on; ~0 V supports it, ~5 V does not. The fix, if
it holds, is hardware -- a pull-up on the J1 side of U2 (the '541 inputs are 5 V tolerant);
the RP2350's internal pulls are on the wrong side of the buffer.

**NEXT BOARD REVISION: floppy-line pull-ups -- THE RESISTOR TEST CONFIRMED THE CAUSE
(2026-09-15), operator decision 2026-09-14.** Rev B as routed has no resistors at all; the
table below goes on the next PCB.

*Result, rev A2 board, `WF_BUS_SNIFF` capture, Amiga powered on with no disk and left idle:*
with 1 kΩ from J1 pin 24 to +5 V fitted, **WGATE read high in 339 of 339 samples over 61 s,
with 0 edges** once the power-on storm (the first ~20 µs, one dropped-sample flag) had passed.
Before the resistor it read low in every sample. So WGATE was floating, not driven low.
In the same window, **WDATA read low in 339 of 339 with 0 edges, and so did MTR (J1 pin 16)**.
A released MTR is high (motor off), and an idle Amiga with no disk never held the motor on
for a full minute from power-on, so both look like the same floating-line signature WGATE had.
SEL0, SEL1, DIR and STEP toggled normally (183, 68, 76 and 46 edges) and SIDE sat high:
those are driven. MTR reading "always on" is also why reads never noticed it.
Capture: 360 records from power-on at 748.7 s to 811.8 s.

*Follow-up, same board, 2026-09-15 evening, 1 kΩ to +5 V on pins 24, 22 and 16:*
**MTR is confirmed floating** -- high in 858 of 861 samples over 100 s from power-on, low
only for a ~ms pulse 4.2 s in (the Amiga's boot probe). **WDATA was NOT a floating line: it
was a firmware bug** (`95ce393`). It still read low in every sample with its resistor fitted,
and the meter read 0 V across the resistor -- both legs at +5 V. `PIN_WDATA` was missing from
main.c's input init loop because only PIO reads it, and an RP2350 pad stays isolated from
reset until `gpio_set_function()` clears ISO; PIO reads an isolated pad as 0 whatever the
pin carries. With the pad initialised, from an Amiga power-on: **WDATA, WGATE and SIDE high
in 1051 of 1051 samples over 86 s, 0 edges; MTR high in 1048, 2 edges**; 0 records dropped,
0 dropped-sample flags. So `flux_in` could never have seen a write edge -- a second reason 4b
never captured a real write, alongside the floating WGATE. **Whether WDATA needs a pull-up is
now UNMEASURED:** the bug hid its idle state, and the resistor was already fitted when the
bug was fixed. Removing that one resistor and re-running the capture would settle it.

*The test:* Amiga off, 1 kΩ from J1 pin 24 (WGATE) to +5 V (J2 pin 1); Amiga on, read WGATE
from a `WF_BUS_SNIFF` capture. Reads high when idle -> the line was floating and the table
below goes on the board. Still low -> something drives it low; rethink before routing
anything.

*The reference designs, read from their own schematics 2026-09-20:*

- **OpenFlops** (github.com/SukkoPera/OpenFlops, V1 and V2rc3, identical floppy nets): 15
  resistors `PU1`-`PU15`, **1 kΩ to +5 V, one per Shugart line, both directions**, always
  fitted, no jumper. FlashFloppy configures every bus input as floating (`src/floppy.c:
  GPI_bus GPI_floating`), so those resistors are the only termination.
- **Nano-Tek** (github.com/stefanskotte/Nano-Tek, the operator's own Gotek-class board:
  STM32F105 + 74LCX07, FlashFloppy, OpenFlops-derived) fits **six 1 kΩ pull-ups and no more**,
  and its sheet says why: *"1K pull-ups on host-driven inputs"* — R6 SEL0 (10), R11 DIR (18),
  R7 STEP (20), R8 WDATA (22), R9 WGATE (24), R10 SIDE (32). Nothing on the drive-side outputs
  (INDEX, TRK0, WPROT, RDATA, RDY, CHNG): its 74LCX07 is open-drain and the Amiga pulls those
  up itself. **Pins 15/16 are unconnected** — a Gotek-class board drives RDY from the select
  line and never reads MTR, which is why it needs no resistor there and we do.
- **FlashFloppy's wiki** documents **1 kΩ from pin 16 (MTR) to +5 V** as a hardware mod: the
  same pin and value as our fix, arrived at independently.
- **Why the split exists:** the Amiga's outputs TO the drive (MTR, WGATE, DIR, STEP, SIDE,
  SEL, WDATA) leave an open-collector stage with no pull-up on the motherboard, while the
  lines the Amiga READS (RDY, TRK0, WPROT, CHNG, INDEX) are pulled up on the motherboard.
  That is exactly the split measured here — the host-driven lines floated, the drive-side ones
  never needed anything. Blog-grade (two Amiga-facing emulator builds), not schematic-verified,
  but it matches the measurement.
- **The value:** 5.25"/8" drives used 150-330 Ω; modern practice for short cables into CMOS
  receivers is 1 kΩ, where both boards above sit. At 1 kΩ/5 V that is 5 mA per line, ~40 mA
  worst case for the Amiga's drivers to sink. Nothing suggests 1 kΩ is too strong or too weak.
- Their inputs go straight to the MCU (OpenFlops) or through an open-drain 74LCX07 (Nano-Tek);
  ours pass through the 74LVC541A, whose inputs are 5 V tolerant, so 5 V pull-ups on the J1
  side are safe. **The '541 is push-pull, not open-drain**, so every line it buffers must stay
  an input on our side — a pull-up and a driven output would fight.

Full research, with sources and what is schematic-verified versus forum/blog-grade:
`docs/decisions/2026-09-20-floppy-bus-pullups.md`.

**DECIDED 2026-09-20 (operator): copy Nano-Tek verbatim — its six 1 kΩ pull-ups to +5 V on the
host-driven inputs — plus MTR, which only we read.** The operator confirmed all six of Nano-Tek's
are needed on that board. Nano-Tek's rail is **+5 V** (its pull-up column sits under the +5 V
symbol; the +3V3 nearby is the 74LCX07's supply, labelled "Open Drain Buffers to 5V TTL"), so
"verbatim" and OpenFlops agree on both value and rail. The one thing NOT copied is the buffer:
theirs is open-drain (74LCX07), ours is push-pull (74LVC541A), so every pulled-up line must stay
an input on our side — a pull-up and a driven output would fight.

**All 1 kΩ to +5 V. Fit the host-driven seven; leave the drive-side six off (footprints optional).**

| lines | J1 pins | fit? | why |
|---|---|---|---|
| WGATE | 24 | **required** | confirmed floating 2026-09-15; write support depends on it. Nano-Tek and OpenFlops both fit it |
| MTR | 16 | **required** | confirmed floating 2026-09-15; reads low (motor on) permanently without one. FlashFloppy documents this exact mod; Nano-Tek does not use the pin at all |
| WDATA | 22 | **fit** | both references fit it and write support depends on the line -- but OUR need is still unmeasured: what looked like floating was the pad bug fixed in `95ce393`, and the resistor was already on when it was fixed. Removing that one resistor and re-running the capture would settle it |
| DIR, STEP, SIDE | 18, 20, 32 | **fit** | host-driven, same as Nano-Tek's six; they toggle and read fine today without, so this is insurance, not a fix |
| SEL0 (SEL1 optional) | 10 (12) | **fit SEL0** | host-driven; OpenFlops and Nano-Tek pull up only the select line in use |
| INDEX, TRK0, WPROT, RDATA, RDY, CHNG | 8, 26, 28, 30, 34, 2 | **pads, unpopulated** | the Amiga pulls these up on its own motherboard, our side drives them through FETs, and Nano-Tek ships without them. OpenFlops fits them (it pulls up everything); keep the footprints in case a long cable ever argues for termination or a faster RDATA edge |

The activity LED's missing series resistor (backlog, "activity LED on GP22") belongs in
the same respin.

### 4b. The write path on real hardware, and a read error still unexplained — 2026-09-13

> **Superseded by 4c:** the read error is solved. "STEP tracking is exact" and ruled-out
> diagnosis 2 below were measured on an outward seek only, and are wrong for inward ones.

**WRITE CAPTURE EXISTS AND IS UNPROVEN.** `-DWF_WRITE_CAPTURE=1` builds an image that
releases WPROT so the Amiga will write; the flux is captured, decoded and logged, then
DISCARDED. Deliberately not done by flipping `WRITE_BACK_IMPLEMENTED`, which still means
"a write reaches the image" and is still 0. **No write has ever been captured**: every
WGATE assertion seen so far has been a bus-wide edge storm at a single timestamp -- the
Amiga powering on or off -- and never a real one.

**WPROT has three gates and now says which is closed.** No disk, the server's
`writeProtected` flag, or the firmware's own willingness. A write test produced nothing at
all and diagnosing it meant inferring a pin's state from the absence of an event, so the
state is now logged on every change with the reason. The first line it printed answered the
question immediately.

**A flip of `writeProtected` does NOT reach a device that already holds the disk** -- the
backlog entry on that is real and was hit in practice. Eject, flip, re-mount.

**AN UNEXPLAINED READ ERROR, and four wrong diagnoses worth recording so they are not
repeated.** An Amiga reading Workbench 3.1 intermittently reports "read error on block N"
(1598, 1617) and recovers on retry. What the board's own record says, across every session:

  * `TRACK-MISS` after a mount: **zero**, always. Every track asked for was present.
  * Every serve is **101,344 bits** -- the full `TRACK_BITS`, never short.
  * `STEP` tracking is exact: a 70-step seek moved `cur_cyl` 69 -> 0 with no dropped pulses.

Ruled out, each after being proposed with confidence and then killed by the data:
  1. *SIDE bounce restarting the flux stream.* Real (3,725 edges <1 ms apart) and fixed --
     the loop now SAMPLES the SIDE level rather than chasing its edges, which is correct
     regardless -- but the log it was measured on had **2,091 dropped records**, and the
     error persisted afterwards.
  2. *Dropped STEP pulses causing cylinder drift.* Measured: zero drops.
  3. *STEP bursts random-walking `cur_cyl`.* Real and worth fixing (16 edges in one
     millisecond with 7 direction reversals) but occurred **once**, in a session without
     the error.
  4. *A corrupt disk image.* The image is byte-intact, but see below.

**The one real finding, and it came from an independent tool.** `xdftool` refuses the
operator's Workbench 3.1 image outright: `L/PPaint/Animations/PPaint.anim` lists 64 data
blocks for a declared 24,576 bytes (48). Our own reader walked 163 files and called the
volume healthy, because it only warned when a file had FEWER bytes than claimed and
silently truncated the opposite case. Fixed and tested. **Whether that damage is what the
Amiga trips on is NOT established** -- the failing block is a directory block and the file
is elsewhere.

**IT FOLLOWED TO A SECOND, DIFFERENT DISK** (`amiga-wb31_workbench.adf`, a different digest
and 141 of 1,760 blocks different from the first, including block 1598 itself). So it is not
that image. The two are 92% identical Workbench 3.1 disks, which is why `dir df0: all` walks
a near-identical tree and lands on the same block -- the repeated block number is a
coincidence of similar disks, not a positional fault.

**THE WHOLE SOFTWARE CHAIN IS NOW PROVEN, END TO END. The fault is after it.**

| stage | how it was verified |
|---|---|
| operator's file -> stored blob | sha256 of the local file matches the served digest exactly |
| ADF -> MFM | `pnpm adfmfm:diff`: **160/160 tracks byte-identical to Greaseweazle** |
| MFM -> PSRAM | `image_parse_end()` on arrival |
| **PSRAM at serve time** | **`-DWF_VERIFY_TRACKS=1`: 160 tracks re-read and decoded, 0 bad, 526 ms** |
| track served to the Amiga | correct track, full 101,344 bits, zero misses |
| the Amiga | fails to read it |

`WF_VERIFY_TRACKS` is the new diagnostic and is worth keeping: it re-reads every track out
of PSRAM after a mount and decodes it the way the Amiga will, requiring eleven sectors with
valid checksums. It found nothing, which is exactly its value -- it eliminated the one link
nothing else covered, since `image_loader` checks PSRAM once on arrival and nothing ever
looks again.

**Also measured: the Amiga does NOT retry.** Track 145 was served once, held for 224 ms
(one revolution), and the Amiga stepped away. So this is not a drive-level retry storm.

**What is left, and what would measure it.** Only the PIO's flux generation and the
electrical path to Paula remain unverified -- everything from the operator's file to the
words queued into the PIO TX FIFO is proven correct. The one mechanism that could corrupt a
read without corrupting our data is a **PIO TX FIFO underrun**, which would stall the flux
mid-track; counting those is the next instrument to build. Beyond that it wants a scope on
RDATA during a read of cylinder 72.

**THE PROCESS NOTE IS WORTH MORE THAN ANY OF THE ABOVE.** FIVE diagnoses were offered with
confidence and all five died: SIDE bounce, dropped STEP pulses, STEP bursts, a corrupt
image, and a USB adapter that turned out to be on the console side of the machine entirely.

Two rules came out of it, both learned the expensive way:

1. **Check for `record(s) dropped` before drawing any conclusion from a capture.** Two of
   the five rested on logs missing 2,091 records. It is one grep.
2. **Do not flash a speculative fix.** The SIDE change was reasoned, not measured -- and it
   turned an intermittent read error into a disk that would not mount at all, costing the
   operator a power cycle and a chunk of an evening. When the symptom it was meant to cure
   survived it, that alone should have triggered an immediate revert rather than leaving it
   in the real-time path while hunting something else.

### 4a. THE AMIGA READS DISKS — 2026-09-13

**Operator-reported, and it is the milestone this whole project was pointed at:** a real
Amiga, on the floppy cable, read disks served by the board, and it "works fine". Every
earlier entry that says the floppy side is unrun is superseded by this one.

What that single sentence actually establishes, because it is a lot: the MFM the server
encodes is correct enough for Paula; the PIO's 2 us bitcell timing and the DMA's
per-revolution restart hold up against real hardware rather than a calculation; INDEX,
TRK0, SEL, MOTOR, SIDE and STEP are wired the right way round through the '541 and the
BSS138s; `track_cache_get()` answers a seek inside the head-settle window; and the whole
chain from a click in a browser to bytes in an Amiga's RAM closes.

**MEASURED on a live session the same day**, after a first attempt found only a rotated
log ring (903 records dropped -- the ring keeping its OLDEST records exactly as designed).
A Workbench 3.1 boot, captured over the console:

| | |
|---|---|
| `TRACK-MISS` after the mount | **0** -- all 41 were before it, on an empty drive |
| Tracks served | 2,468 over 145 s, 108 distinct, reaching track 159 |
| Bit count on every serve | **101,344** -- exactly `TRACK_BITS`, never short |
| `STEP` -> `TRACK-SERVED` | median **1 ms**, p99 **3 ms**, against ~15 ms of head settle |

Zero misses after the mount is the strong result: every track the Amiga asked for was
present in PSRAM and served whole. The seek latency says core0's service loop has an order
of magnitude of headroom against the deadline that actually constrains it -- which is worth
knowing before anything else is added to that loop.

**WHAT COULD NOT BE MEASURED, and it is the commercially interesting one.** How many
REVOLUTIONS a track read costs. Two obstacles, both in the instrumentation rather than the
result: 95.5% of track loads are replaced before completing one revolution (the Amiga seeks
far more than it dwells, so `WF_EV_INDEX`'s revolution field mostly reads 0), and a RETRY
re-reads the same track without changing `want_track`, so it never fires `TRACK-SERVED` and
is invisible to every trace there is. A clean Workbench boot is practical evidence that
reads are not failing; it is not a measurement of how many revolutions they take. Answering
it properly needs a trace on the DMA wrap counter rather than on track changes.

**Still unverified, and now cheaply verifiable -- do these next time a disk is read:**
* **The track counter on the OLED.** It renders and is wired, both host-tested, but has
  never followed a real seek. A disk load walks the head across the disk; watch the panel.
* **The activity LED under real traffic.** It blinks on `WF_EV_TRACK_SERVED` and has only
  ever been seen doing its three-blink self-test.
* **How many revolutions a track read actually costs.** `WF_EV_INDEX` carries the previous
  track's revolution count in `b`. One revolution per track is the floor; two means
  something is costing a retry, which would double every load time in the product and is
  invisible without reading that field.

### 3x. Hardware bring-up begins, and a console log — 2026-09-10

**A rev A2 board, populated with J1, J2 and U1 only, ran the firmware.** What that
proved on real silicon, in order of how much it was worth knowing:

- `cyw43_arch_init()` succeeds — the **RM2 radio works over SPI**, the largest piece
  that had only ever been compiled
- the AP comes up: `wifi-floppy-6A38`, WPA2-AES, SSID built from the chip's own MAC
- **DHCP, the DNS responder and the HTTP server all work** — the form serves at
  `192.168.4.1`
- **iOS raises the captive-portal sign-in sheet by itself**, which was named
  explicitly on the unverified list
- the form's `28:cd:c1:19:6a:38` and the SSID's `6A38` agree, so `main.c`'s
  `mac_address_string()` and `portal_net.c`'s SSID construction cross-check
- no USB CDC re-enumeration over minutes: not crash-looping

**Still unrun, as of the moment this section was written:** everything past pressing
Save — AP teardown, station mode, association, the confirmation page beating the AP drop,
lease renewal, Android, TLS, SNTP, registration — and the entire floppy side.
**All of that except lease renewal, Android and the floppy side ran later the same night —
see 3y.**

**`src/wf_log.c` now exists because none of that would have been visible.** The
firmware previously wrote nothing at all: `stdio_init_all()` created the CDC device,
so a port appeared and a terminal attached, but there was not one `printf` in `src/`.
`wf_logf()` formats; `wf_trace()` takes an integer event code so it is legal inside
the flux DMA handler, and sits in SRAM (0x200001bc) beside `dma_irq`. **core0 drains,
core1 only produces** — core0's loop already sleeps 1 ms, core1's blocks for tens of
seconds in a long-poll — which is also why a wedged core1 still gets its last line
out. Drops newest when full and says so.

**It is now verified on a rev A2 board (2026-09-10), and it took two fixes to get
there.** Both were invisible to its 74 green host checks, and both are the same
shape: the host harness drives the ring directly through a sink that always accepts,
so it could not see the loop that feeds the ring or the sink that refuses.

- **`TRACK-MISS` was level-triggered and flooded the log.** `main.c`'s service loop
  gates on `want != loaded`, and the miss path did not advance `loaded` -- so a miss
  re-traced the same track every 1 ms, forever. On a freshly booted board with no
  disk mounted (`want_track == 0`, nothing in PSRAM, which is the DEFAULT state of
  every board at power-on) that measured **44,929 `TRACK-MISS` records in 48 seconds,
  40 KB/s**, burying every other event at several thousand to one. The fix is to
  latch `loaded = want` on the miss path too. Nothing is lost by not retrying:
  `track_cache_check_swap()` resets `loaded` to -1 on every mount and every eject.
- **`wf_log_drain()` was feeding a sink that discards.** A detached USB CDC port does
  not buffer -- pico-sdk's `stdio_usb_out_chars()` returns without writing when DTR is
  deasserted, and `PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS` defaults to 0 so boot never
  waits. Draining therefore DESTROYED records, and silently: the ring never overflowed
  so the dropped-record line never fired. The boot banner and `radio up (RM2)` were
  both gone ~560 ms into boot, before any terminal could attach. A board cannot be
  attached to before it enumerates, so **every boot-time record was structurally
  unobservable** -- precisely the window the log was added to make visible. The drain
  now holds while `stdio_usb_connected()` is false.

**The measurement, before and after, same board, same idle state:** 44,930 records /
845 KB in 48 s, no boot banner -> 4 records / 166 B, boot banner present. Attaching 65
seconds after boot now replays the whole boot history, timestamps intact:

```
[    0.004] c0 wifi-floppy boot: pimoroni_pico_plus2_w_rp2350
[    0.004] c0 TRACK-MISS   a=0 b=0
[    0.004] c1 radio up (RM2)
[    0.760] c1 portal: raising AP
```

`radio up (RM2)` had never been seen on hardware before. Four tests were added
(`test_wf_log.c`, 74 -> 87 checks) and **mutation-checked**: reverting the guard fails
all four, each in the shape of the original defect.

**What is still NOT verified about the logger**, since the board is silent without a
disk or an Amiga: the latch's retry-after-mount path (`main.c` is excluded from the
host build, and exercising it needs the fetch path that has never run); detach/reattach
cycling; and ring overflow while held. All three are host-tested only. Live streaming
was proven by the pre-fix run and that path is unchanged.

**The post-Save path is now instrumented, because it was completely silent.**
Every module downstream of the portal -- `portal_net.c`, `device_client.c`,
`transport_tls.c`, `sntp_time.c`, `config_store.c`, `token_store.c` -- had **zero** log
calls, and `main.c`'s stopped at "credentials verified and saved". Running plan 5's next
item against that would have been blind on paths that have never executed. Worse, three
of its failure modes are silent forever-loops:

- `sntp_sync_blocking()`'s result was **discarded**, and `tls_connect()` refuses to start
  a handshake while `sntp_time_valid()` is false -- so a board that cannot reach NTP sits
  in `dc_register()`'s backoff loop forever and looks exactly like broken TLS or a broken
  server. It now says `sntp: NO clock -- TLS will refuse every handshake until it syncs`.
- `dc_register()`'s retry loop logged nothing on any non-terminal failure. One line per
  attempt now, with the backoff.
- **Association SUCCESS was never logged** -- only failure -- so "did it associate?" was
  unanswerable from the console.

Added: AP-down + default route after `portal_stop()`, association success + default route
on both paths, the SNTP result, stored-token-vs-registering, pairing-code rejection,
per-attempt registration failure, and poll-loop entry. `default_route_str()` exists
specifically to settle plan 4b's oldest open question -- whether `portal_stop()` really
restores the STA netif as `netif_default` or leaves it NULL -- since a NULL there presents
as "TLS is broken" with no message anywhere.

**None of those lines has fired yet.** They are all downstream of pressing Save, and the
board is unprovisioned, so it sits at the portal. Verified only that the instrumented
build boots unchanged (same four lines, byte-identical). **This is where plan 5 is
blocked, and it is blocked on a physical act, not on code:** someone must join
`wifi-floppy-XXXX` from a phone, submit a real SSID and password plus a fresh pairing code
from `/devices`, and capture the console through the sequence. That single run answers the
whole of §3's open list at once.

**A trap for whoever adds the next trace.** `wf_trace()` from a level-triggered
condition in the 1 ms loop is a 1 kHz firehose, and the flood is worst exactly when
the board is in its default state, so it will look like the logger is broken rather
than the caller. Trace edges, not levels -- and if the condition really is a level,
latch it. `WF_EV_TRACK_WANT` and `WF_EV_WGATE` are declared but never emitted; they
are the next two candidates and both are level-shaped.

**Hardware, three revisions now.** Rev A scrap. Rev A2 in hand, working, with ground
plane under the antenna and outlines but no lettering. Rev B is current and
unfabricated: keepout at the antenna end, silkscreen at 0.2 mm with real designators
and a `WIFI FLOPPY REV B` marking, D1's cathode bar. Two things deliberately open —
the RM2's position on the module underside is still unconfirmed, and the operator is
**holding the keepout extension until a board is known to work**, since bring-up may
move other things.

**A diagnosis I got wrong, recorded because the reasoning was the problem.** I said
JLCPCB stripped the sub-minimum silkscreen and both batches arrived blank. A photo of
an assembled A2 board shows J2's and U1's outlines plainly legible at 0.12 mm. The
0.12 mm is a real spec violation, but it printed; what was actually missing was all
lettering, and that was the exporter dropping everything that was not an `fp_line`.
I inferred a fab behaviour from a spec table instead of from a board.

### 3y. Plan 5: the network stack is verified end to end — 2026-09-10

**A rev A2 board provisioned itself and registered with production.** The device appears
in the Devices tab as paired, and the poll loop has been running clean. This is the first
time anything past `cyw43_arch_wifi_connect_timeout_ms()` has executed on hardware.

```
[  138.800] c1 portal: AP down, default route now w00 ip=172.16.10.216
[  138.871] c1 portal: associated, default route w00 ip=172.16.10.216
[  138.958] c1 portal: credentials verified and saved
[  138.981] c1 associated, default route w00 ip=172.16.10.216
[  138.981] c1 sntp: clock set
[  138.981] c1 device: no stored token, registering with pairing code
[  140.147] c1 tls: handshake OK with webadf.vercel.app:443
[  140.611] c1 register: OK, token stored
[  140.611] c1 entering poll loop against webadf.vercel.app
[  141.863] c1 tls: handshake OK with webadf.vercel.app:443   <- polls, ~26.6 s apart
```

**§3's open list, answered.** Do not carry these forward as open again:

- **`netif_default` IS restored to STA after the AP tears down.** `portal_stop()` works;
  plan 4b's Critical fix is real. The board reports `w00` immediately after teardown,
  never NULL. This had been unanswered since plan 4b was written.
- **STA DHCP works after the AP netif is removed** — lease `172.16.10.216`, and the same
  address again across cold boots from stored config.
- **TLS to webadf succeeds** — full chain verification against the pinned bundle, with SNI
  and hostname checking, in ~1.2 s.
- **The confirmation page does leave the radio before AP teardown** — the phone rendered it
  and `portal: AP down` follows.
- **iOS captive-portal behaviour works end to end**, sign-in sheet through to Save.
- **The pairing-code-rejected path is correct on hardware** (spec D-4b-4): a 400
  `invalid_or_used_code` was treated as terminal, the config erased, the portal reopened
  with the reason on the form. Verified by accident, with an expired code, then again
  deliberately with a wrong one.

**Three defects had to be fixed to get here, none of which any host test could see.** The
logger's own two are in §3x. The third:

- **The board hard-panicked at `sntp_init()`**: `pool MEMP_SYS_TIMEOUT is empty`.
  `lwipopts.h` never set `MEMP_NUM_SYS_TIMEOUT`, and lwIP's default formula counts only
  its own core modules with **no term for anything under `lwip/apps/`** -- which is where
  SNTP lives. lwIP asserts rather than degrading. Not specific to the portal path: any
  board, provisioned or not, took the same route to the same panic, so nothing downstream
  of association could ever have run. Now `MEMP_NUM_SYS_TIMEOUT 12`, budget written out.
- **`altcp_tls_create_config_client()` returned NULL**, so no handshake was ever
  attempted. Cause: `mbedtls_config.h` enabled only `MBEDTLS_SHA256_C`, and **two of the
  five pinned roots could not be parsed** -- GTS Root R1 is self-signed
  `sha384WithRSAEncryption`, GlobalSign Root CA is `sha1WithRSAEncryption`. lwIP's
  `altcp_tls_create_config()` fails the ENTIRE bundle on any non-zero return from
  `mbedtls_x509_crt_parse()`, and that function is permissive -- it returns the COUNT of
  rejects, not an error. Two bad certs produced a flat NULL and every request failing
  before a packet moved.

  **How it was missed is worth more than the fix.** `mbedtls_config.h`'s own header says
  "The chain (leaf/WR1/GTS Root R1) is ... sha256WithRSAEncryption" -- correct about the
  SERVED chain, all three certs of which really are SHA-256. But a trust anchor must still
  be PARSED, and `mbedtls_x509_crt_parse()` rejects a cert whose signature algorithm it
  cannot name whether or not that signature is ever verified. The reasoning was one step
  short, and the root it stranded was the only one Vercel actually chains to.

  Fixed by enabling `MBEDTLS_SHA512_C`/`MBEDTLS_SHA384_C` (needed to PARSE, not to verify
  -- nothing on this chain is SHA-384) and **removing the GlobalSign root** from
  `tools/gen_roots.sh` rather than enabling `MBEDTLS_SHA1_C`. The operator's ruling,
  2026-09-10: "dont support SHA-1 its compromised." Verified: `MBEDTLS_SHA1_C` undefined
  and **0 SHA-1 symbols linked** into the image (the SDK compiles `sha1.c`, but its body is
  entirely `#if defined(MBEDTLS_SHA1_C)`). Bundle is four roots, all SHA-256, and still
  validates the live host (`Verify return code: 0 (ok)`).

**Still unrun after tonight:** the entire floppy side (no `SEL`/`MOTOR`/`STEP`/`INDEX`
trace has ever fired, `WF_EV_TRACK_WANT` and `WF_EV_WGATE` are still never emitted), image
fetch and PSRAM publish, Android captive-portal behaviour, DHCP lease RENEWAL over hours,
and the portal's 2-lease pool / 3 HTTP slots under MAC-randomization retry storms.

**A note on method, since it decided the outcome.** Every one of tonight's defects was
found by instrumenting first and running second, and each was invisible to the layer above
it: `register failed (rr=1)` flattened transport failure, non-200 and malformed body into
one code; `altcp_tls_create_config_client()` reports failure only as NULL; and
`mbedtls_x509_crt_parse()`'s permissive positive return had to be read directly to learn
that the number was 2. Three diagnostics deep before a cause appeared. Budget for that.

### 3z. The image fetch stalls at ~43-57 KB — FIXED, 2026-09-10/11

**A disk can be mounted from the UI, the device fetches it, and the transfer dies partway.
This is the first thing on the list that is not fixed.** Everything up to it works: the poll
returns the desired disk, the entitlement check passes, and the server serves a real body.

```
[   15.467] c1 fetch: 6f471d757147 -> slot 0 (psram ok)
[   17.027] c1 fetch: 16 KB
[   18.029] c1 fetch: 32 KB
[   48.033] c1 WARN fetch: incomplete -- exchange=FAILED status=200 complete=no
                              got=43442 of 2027536
```

**The shape, which is the useful part.** Transfer runs at roughly 16 KB/s, reaches ~43 KB,
then **stops dead** -- thirty seconds of total silence, then `DC_POLL_TIMEOUT_MS` (30 s)
fires in `tls_read()`. Not a slowdown, a full stop with the server still holding 1.9 MB it
is willing to send. Stall points observed: 43,442 and 57,344 bytes, alternating between
attempts, so it is NOT a fixed buffer boundary. The failure lands in dc_fetch_image's
`if (!ok || !r.body_complete)` branch, which deliberately never blocks the digest -- so the
board retries the same fetch forever, roughly every 35 s.

**Answered along the way, and worth keeping:** `psram ok` on every fetch line. The PIM726
carries the PSRAM the design needs. That is the U1 substitution risk 3s says no check in
the hardware folder can catch, and it is now retired on this board.

**A WRONG DIAGNOSIS, recorded because the reasoning is the lesson.** I read `on_recv()`
crediting `altcp_recved(pcb, p->tot_len)` on ARRIVAL while `tls_read()` never called it at
all, concluded the receive window was never throttling the peer, and moved the credit to
consumption. **It did not fix the stall** -- same failure, same byte counts. I had also
claimed the stall was "exactly 57,344 bytes every time" on the strength of two samples, and
the third was 43,442. Two errors: fixing the first plausible defect I found rather than the
one the evidence pointed at, and generalising a constant from two data points.

The change is KEPT, because crediting a window for bytes no one has read is incorrect flow
control on its own terms and would bite under memory pressure -- but `transport_tls.c`'s
comment now says explicitly that it is not the fix for this stall. Do not read it as one.

**Where to look next.** A dead stop with data available at the peer is either a receive
window that closes and never reopens, or lwIP exhausting pbufs and dropping silently; from
the console those are identical. `LWIP_STATS` with `MEMP_PBUF_POOL` and heap counters dumped
at the moment `tls_read()` times out separates them in a single run -- that is the next step,
and it is instrumentation, not another guess.

**THE CAUSE: `TCP_WND` was smaller than one maximum TLS record.** 8*TCP_MSS is 11,680
bytes; `MBEDTLS_SSL_IN_CONTENT_LEN` defaults to 16384, so a record on the wire is up to
~16,406. mbedtls cannot decrypt a partial record -- it yields no application byte until the
whole record has arrived -- and lwIP credits the receive window in two parts: the
application's share when we call `altcp_recved()`, and the record overhead in
`altcp_mbedtls_lower_recv`, but ONLY once a record completes
(`mbedtls_ssl_get_bytes_avail(...) == 0`). A window smaller than one record is therefore a
deadlock: the peer fills the window with an incomplete record, mbedtls yields nothing,
neither credit fires, we advertise zero, and both sides wait forever on a healthy
ESTABLISHED socket. Every earlier response was a few hundred bytes of poll JSON in one small
record, which is why nothing had ever hit it. `TCP_WND` is now 32*TCP_MSS.

**What made it findable was measuring the window itself.** The lwIP stats said pbuf
used=0 max=11 err=0 and heap err=0 -- no memory pressure at all, which killed the pbuf
theory outright -- and then `rcv_wnd=0 ann=0 (TCP_WND=11680) state=4` said the rest in one
line. Two wrong guesses preceded it; the counter did not.

**Verified end to end 2026-09-11:**

```
[   20.400] c1 fetch: verified, publishing slot 0
[   20.401] c0 MOUNT        a=6 b=0
[   20.402] c0 TRACK-SERVED a=0 b=101344
[   20.604] c0 INDEX        a=3167 b=0
```

`b=101344` is not merely plausible, it is exact: `src/lib/adfmfm/constants.ts` has
`TRACK_BYTES = 12668`, so `TRACK_BITS = 101344`, and `WFMF_BYTES = 16 + 160 * (4 + 12668) =
2027536` -- the Content-Length the device reported. The server's encoder, the container, the
2 MB transfer, the PSRAM write, the publish and core0's read-back agree to the bit. INDEX
firing means core0 is streaming flux through PIO/DMA with no Amiga attached. **PSRAM is
confirmed working on this board**, retiring 3s's U1-substitution risk.

**Throughput, measured rather than assumed.** Steady-state: 471 KB/s at 16*TCP_MSS, 599 KB/s
at 32*TCP_MSS (+27%), 621 KB/s after `DC_READ_CHUNK_BYTES` 512 -> 4096 (~4% -- so the small
reads were never the problem). A read/feed split then settled it: `read=3609 ms feed=411 ms`,
i.e. **90% waiting on network plus TLS, 10% our own processing** (2 MB into PSRAM at ~4.8
MB/s). ~575 KB/s is ~4.6 Mbit/s, consistent with commonly reported CYW43439-over-SPI figures
plus software AES-GCM (RP2350 accelerates SHA-256, not AES) -- NOT independently measured,
so treat it as an indication. The real lever is fewer bytes, not more tuning: the source ADF
is 901,120 bytes against 2,027,536 of MFM, so encoding on-device would cut a mount to ~1.6 s
-- at the cost of moving an encoder that was deliberately verified against greaseweazle
server-side. Weigh that before doing it.

**TWO MORE DEFECTS, FOUND AFTER THIS SECTION WAS WRITTEN, ONE OF THEM MINE.**

**INDEX was traced every revolution, which permanently saturated the log ring.** At 300 RPM
that is a ~5 Hz producer, and wf_log keeps OLDEST and drops NEWEST -- a policy written for
bursts. A board left mounted and unattended for 8.6 h reported `-- 151362 record(s)
dropped --`, which is INDEX alone (151362 / 4.93 Hz = 8.5 h). The ring saturates about
thirteen seconds after a disk mounts and stays that way, so any LATER event -- a TRACK-MISS,
an error, an eject -- is dropped before a terminal can be attached. The boot history
survives, which is the policy working as designed; everything after it did not. Same shape as
the TRACK-MISS defect in 3x: a per-revolution trace is a level, not an edge.

INDEX is now traced ONCE per stream, on the first wrap after start_streaming(), pairing with
TRACK-SERVED to prove the DMA actually wrapped. `b` carries how many revolutions the PREVIOUS
track completed, which is the fact the flood stood in for. A live "still spinning" indicator
is what the activity LED in the backlog is for; it is not the log's job. Measured after:
**1 INDEX line across 20 s of continuous streaming**, and 25 console lines for an entire
boot + mount + 20 s, against thousands before.

**PBUF_POOL_SIZE was left behind when TCP_WND was raised, and that one was self-inflicted.**
Raising TCP_WND from 16 to 32*TCP_MSS for throughput made the window exactly 46720/1460 = 32
segments while the pool stayed at 32 -- no slack for ARP, DNS, retransmits, or the next
segment arriving while one is consumed. The pool ran dry, lwIP silently DROPPED packets, and
the fetch stalled and timed out, presenting identically to the deadlock above:
`pbuf used=32 max=32 err=49`, three attempts and 94 s to mount what had been mounting first
time in under 5 s.

**It was LATENT while I measured throughput** -- those runs happened to succeed, which is why
it reached a commit, and it is the second time in one session that generalising from one or
two good samples was wrong. The rule it leaves: **the pbuf pool must exceed TCP_WND/TCP_MSS
with real headroom, and the two must be changed together.** Pool is now 64 against a
32-segment window.

Fixing it also RAISED throughput, because the window could not previously be used: four
consecutive cold-boot mount cycles at **695, 688, 616, 630 KB/s, zero timeouts and zero
incomplete fetches**, a whole image in ~2.9-3.2 s -- better than the 599 KB/s the paragraph
above claims for the tuning alone. Treat those earlier figures as measured on a configuration
that was quietly dropping packets.

**Still true, and now explained:** `DC_READ_CHUNK_BYTES` was
**512**, so a 2,027,536-byte image is ~4,000 read calls, each a locked drain of the pbuf
chain. Before tonight nothing on this path had moved more than a few hundred bytes in one
response, so 512 had never been under load. ~16 KB/s is slow enough to be worth explaining
even once the stall is fixed.

### 3ab. Mount and eject a disk from the library — DONE 2026-09-11, merged to `master` and live

Requested by the operator the same night the hardware first mounted a disk: "going to the
library, click on a disk, then choose to mount & eject through the list of devices". Ejecting
already worked from `/devices`; what did not exist was doing either from the disk itself.

**Nothing on the server changed.** `setDesired`/`clearDesired` and
`POST /api/devices/[id]/mount|eject` already existed and are already org-scoped, and the
whole tenancy chain was re-verified the same night (pair mints with `requireOrg`, register
binds the code's `orgId`, every device endpoint scopes by it, `/api/device/image` requires
the device's own org to hold the entitlement and 404s rather than 403s). This increment is
UI plus two columns.

**What was there before:** a Mount button that listed device NAMES and nothing else. To find
out which drive was free, or to get a disk back, you left for the Devices tab -- exactly the
trip this removes.

**What it does now.** Per device, in the picker: what that drive is holding right now, and a
button that reads the situation -- `Mount here`, `Eject` when that drive has confirmed this
disk, or `Cancel` when a fetch for it is still in flight. With one device paired the button
flips between Mount and Eject directly. The trigger itself says `In {device} ▾` when some
drive already has the disk, so the common question is answered before it is opened.

**`Cancel` is not cosmetic.** Both verbs POST to `/eject`, which means "hold nothing" -- so
calling off a pending fetch also drops whatever is still in the drive. Wording them apart is
the honest way to say that; a person who picked the wrong drive is looking for Cancel, and
`§7`'s rule that desired state must never be presented as fact is what makes Eject wrong
before anything has landed.

**Two columns added to `listDevices`:** `desiredDiskId` and `mountedDiskId`. The digests
cannot stand in for them -- two disk rows can share one sha256 (identical bytes re-uploaded
under a second title), and only the id tells them apart. `mount-choice.ts` still falls back
to the digest when `mountedDiskId` is null, because `recordStatus` leaves it null when it
could not resolve the reported digest, and reporting an empty drive that visibly holds
something would be worse than an imprecise match.

**A composition defect I introduced and then caught, worth recording as the pattern.** Each
half was right alone: the trigger said `In {name}` matched by disk ID, while the line under
the disk name came from the page's own sha256-keyed `holders` map, which by its own comment
kept only the FIRST device found. Two rows sharing a digest, device A holding one and B the
other, and the same row would say "In A" on one line and "In B" on the button. Fixed by
making `choices` the single source of truth for both -- which also retired that documented
first-match limitation for free, since per-device data can name every holder ("In A and B")
instead of silently dropping the second. **Nothing in the per-piece work would have found
this; it took reading the whole diff as one change**, which is the same lesson as 3v.

**Verified:** 581 -> 588 vitest (22 in `mount-choice.test.ts` alone), `pnpm build` clean,
lint at the standing 3-error baseline (all three pre-existing: two `Date.now()`-in-render,
one in `pair-button.tsx`), and the full Playwright suite green at 229 before the composition
fix, re-run after it.

**Merged fast-forward to `master` and deployed to production**, on the operator's say-so
at the end of the same session. The merge changed nothing: `master` was a direct ancestor,
so the tree that shipped is byte-for-byte the tree the 229-test suite ran against.

**It shipped with the device-naming gap open, knowingly.** The picker labels every drive
`Device <MAC>`, which is the weakest part of the feature and is in the backlog above. It was
raised before the merge and the operator chose to ship; with one device paired it is
invisible, and the fix wants a migration rather than a rushed one.

### 3ac. Devices can be named — DONE 2026-09-11, merged and live

`devices.name` had always held `Device <MAC>`, written by `/api/device/register` from the one
detail the device supplies about itself, with a comment saying it stood in "until a rename
flow exists". 3ab made that hurt: choosing a drive from the library means choosing between
names, and a column of same-shaped MACs is the worst thing to choose between.

**No migration.** The column existed; only the way to edit it did not.

- `src/lib/device-name.ts` -- `defaultDeviceName()` is now the SINGLE definition of the MAC
  label, and `register/route.ts` calls it rather than inlining the template. Load-bearing:
  clearing an alias RESETS to that exact string, so a drift between the two would "reset" a
  device to a label it never had. A unit test pins them together.
- `PATCH /api/devices/[id]` -- org-scoped, alias trimmed, 80 chars, and **404 not 403** for
  another tenant's device, the same boundary `/api/device/image` sets.
- An inline editor on each device card. "Name" while it still wears a MAC, "Rename"
  afterwards; Enter saves, Escape abandons; an EMPTY alias restores the MAC rather than
  leaving a nameless drive, because `devices.name` is NOT NULL and because a blank card is
  harder to pick out of a list than one wearing its MAC.

**Six e2e tests**, the load-bearing one being that two renamed devices show their aliases in
the library mount picker AND that no `Device ` MAC label remains on that surface -- the
complaint, asserted directly rather than via the rename alone. Plus cross-tenant refusal and
the over-long-alias rejection.

**A lint error I added and removed, worth a line.** Seeding the input inside a `useEffect`
trips `react-hooks/set-state-in-effect` -- the same error `pair-button.tsx` carries in the
standing baseline, which is presumably how the pattern got copied in the first place. It was
avoidable: the value is known at the moment the editor is asked for, so seeding belongs in
the click handler, not an effect. Back to exactly the 3 pre-existing errors.

**Verified:** 594 vitest, **235 Playwright**, build clean, lint at the 3-error baseline.

### 3ad. The scanner runs on upload, and the image budget became a rate — 2026-09-11

Asked for: "the scanner should run more often to update titles, but we don't want to pound
the openretro site, so it should be a differential run". Two thirds of that turned out to be
ALREADY TRUE, and finding that out changed what was worth building.

**Matching never touches openretro.org.** TOSEC and OpenRetro matching both run against
locally imported tables. The only network calls are IMAGE fetches, and `openretro-images.ts`
already states the policy in its own header: one at a time, 500 ms apart, identifying
User-Agent, never re-fetched. Politeness was never the constraint on matching titles.

**The sweep was already differential.** Every phase stamps its blob (`hashedAt`,
`matchCheckedAt`, `enrichCheckedAt`); a run with nothing new does three indexed queries and
exits.

**And it was already global rather than per-org**, which is the part that matters for handing
other people a library: blobs are content-addressed and shared, and `applyMatch` fans out to
every org holding those bytes. One user's copy of Lemmings being identified titles it for
everyone who holds the same bytes, at no extra cost. Multi-user enrichment did not need
building.

**What was actually broken was latency.** Nightly at 03:00 UTC, so somebody uploading sixty
disks at lunchtime saw sixty untitled files until the next morning.

- `/api/ingest/complete` now sweeps via **`after()`** with a 45 s budget. `after()` and not a
  bare un-awaited promise: serverless freezes the function when the response returns, which
  is exactly when fire-and-forget dies. The cron stays as the safety net that finishes long
  jobs.
- **`IMAGE_CAP_PER_RUN` (40) became `IMAGES_PER_ROLLING_HOUR` (60).** This is the change that
  makes the rest safe, and the coupling is the whole point: 40 *per run* at four runs an hour
  is 3,840 images a day arriving at a volunteer-run site that previously saw 40 a night. A
  per-run cap cannot bound a rate when the number of runs is not fixed. Counted from
  `openretro_images.fetched_at`, so every run shares one budget with no coordination and no
  new table, and it is re-read before each entry so concurrent runs converge.
- **A blob that throws is skipped for the rest of that run.** It is deliberately never
  stamped, so the todo query used to hand it straight back and one permanently-failing blob
  burned the whole 240 s budget while nothing else moved. The next run still retries it,
  which is what a transient fault needs.

**NO LOCK, and that is a decision rather than an omission.** I said I would add one. Once the
image budget became a shared rolling rate, the only thing concurrency could genuinely harm --
requests leaving the building -- was bounded anyway, and every database write here is
idempotent and stamped. A lease table would have cost a migration to prevent duplicated local
work. If sweeps ever start overlapping enough for that duplication to matter, this is the
note to revisit.

**IDENTITY MATCHING: BUILT, AND WORTH ALMOST NOTHING HERE. Measure before believing the
handoff.** 3d called title+year matching "the single change that would make this increment pay
for itself". Measured against the live catalogue before writing it:

```
TOSEC-identified blobs        29
  already enriched by hash    13
  NEW via title+year           1     <- Lemmings, and nothing else
  ambiguous                    0
  no OpenRetro entry at all   15
```

**The 15 are the finding, and they are not normalisation failures** -- checked again against a
punctuation-stripped index. They are World Construction Set (an application), and 9 Fingers,
State of the Art, Global Trash, Wayfarer, Giana Sisters Special Edition, Ray of Hope 2:
**demoscene productions**. OpenRetro is a GAMES database. No matcher can make it enrich a
demo. **The honest conclusion is that this archive is largely demos and applications, and the
source that would cover it is Demozoo or Pouet, not a better OpenRetro matcher.** That is now
the backlog item worth having.

It is kept regardless, and strictly: exact normalised title AND exact year, unique hit or
nothing -- no fuzzy distance, no year tolerance. A wrong title in somebody's library is worse
than a missing one, and unlike a hash match there is no second signal to catch it. The reason
to keep it is that the next libraries are other people's, and a collection of GAMES is exactly
the case where it pays: the one hit here was the one game in the sample. `SweepResult` reports
`enrichedByIdentity` separately so it can be judged on evidence later rather than assumed.

**A test that had to change, and why it is not a weakened assertion.** `tosec-scan.spec.ts`'s
"a disk landed after its blob was already matched" seeded a TOSEC entry with a direct DB write
and relied on the blob being undecided -- true only because nothing swept between upload and
scan. Now `/complete` sweeps, so the blob is correctly decided `none` first. Production does
not have this problem: `tosec-import.ts` clears `matchCheckedAt`/`matchState` on every decided
blob precisely so new reference data puts old verdicts back in play. The test now does the
same thing explicitly, standing in for the import route it bypasses.

### 3ae. Dropping .lha and .zip onto a disk — DONE 2026-09-11

Aminet distributes as .lha and picking two files out of a download is the ordinary case, so
an archive dropped on a disk now expands into the staging area exactly as a dropped FOLDER
does. That was the whole placement answer: `readDroppedItems()` already flattens a folder
into `{path, File}`, and an archive is the same shape, so expanding it at that point inherits
the destination selector, collision handling, Latin-1/AmigaDOS name masking and the
block-based free-space estimate without any of them knowing what an archive is.

**Zip needed no dependency.** The container is a few fixed records and
`DecompressionStream('deflate-raw')` is native. Read from the CENTRAL DIRECTORY, never by
scanning local headers -- a local header may carry zeroed sizes with the truth in a trailing
data descriptor.

**LHA is the whole job, and it is verified against the reference tool, not against us.**
`pnpm lha:verify <dir>` extracts every archive with the real `lha` and compares every byte of
every member -- the same arrangement adffs has with xdftool and adfmfm with greaseweazle.
Against five real Aminet downloads: **60/60 members byte-identical**. Methods seen: `-lh5-`
everywhere, `-lh0-` for already-compressed members. Header levels seen: **level 1 on four of
five**, level 2 on one -- so macOS `lha`'s level-2 default is NOT representative and local
fixtures alone would have tested the wrong thing.

**Two bugs only real archives could find:**

- **Level 1's extended-header chain stores each header's size at the END of the previous
  one.** Getting that wrong decodes levels 0 and 2 correctly BY LUCK -- neither derives its
  data offset from that walk -- and lands level 1's payload 26 bytes early, producing files of
  exactly the right LENGTH full of the wrong bytes. Sizes matching is what made it look fine.
- **Level 0/1 headers pack the file comment into the filename field as `name\0comment`.**
  Aminet's `l2boot.lha` decoded perfectly into paths like
  `l2remote.boot\0created 02.08.2026 00:38:42, last accessed...`. "Comments not needed"
  turned out to be load-bearing rather than a preference.

**And one the verifier found about ITSELF.** Mutation-testing it -- corrupt an archive, expect
DIFFER -- instead made `lha` reject the file, so the script skipped it and reported `0/0` with
exit 0. **A run that verifies nothing now fails**, the same rule its missing-binary check
already followed. Mutating the READER (level-1 chain off by two) then correctly reported 6/60
and exit 1.

**Protection bits, and the honest state of them.** `addFile`/`writeFileHeader` now take
optional AmigaDOS bits and write them at offset 320, which `dir.ts` already read back --
`addFile`'s signature simply could not express protection before, the same
"does-the-type-carry-enough" shape that bit 3v twice. Written UNCONDITIONALLY including zero,
because `allocate` can return a block a delete freed and `free` never clears content, so a
recycled header would otherwise wear the dead file's bits.

**But surveyed across those five Aminet archives, NOT ONE carries the 0x40 Amiga attribute
header.** They carry Unix `0x50/0x51/0x53` instead, because modern uploads are built on Linux
and Mac. So protection is usually absent, and absent means the AmigaDOS default. **No
Unix-to-Amiga mapping, by the operator's decision** -- "it wouldn't translate right", and they
are right: a Unix mode has no honest image in HSPARWED. Genuinely old Amiga-made archives
should carry 0x40 and will be honoured; today's mostly do not.

**Per-row include is the one real UI addition**, and it is deliberately NOT the existing
`skip`. A 'skip' resolution means "this collides and I choose not to overwrite", which the
resolution line and folder-merge wording both read that way; an archive member usually
collides with nothing, and overloading 'skip' would make a plain exclusion claim a collision
was resolved. Separate `excluded` set, offered on every row.

**The 25 MB cap protects the BROWSER**, where decoding happens. It says nothing about fit: an
ADF holds 880 KB and what decides fit is staging's block-based estimate, which exists because
bytes lie about it.

Nested archives and file comments are out of scope by decision, not oversight.

**Verified:** 649 vitest (39 in the archive module alone), the e2e drops a real `lha`-produced
fixture and asserts ON THE BYTES read back out of the stored image -- including that an
excluded member is absent from the DISK rather than merely greyed out in a list.

### 3af. Demozoo identification — DONE 2026-09-14, all 16 tasks, merged to `master`

Design: `docs/superpowers/specs/2026-09-14-demozoo-design.md`. Plan: `docs/superpowers/plans/
2026-09-14-demozoo.md`. Execution ledger with every ruling and its cost-if-wrong:
`.superpowers/sdd/2026-09-14-demozoo/progress.md`.

**What shipped.** Demozoo complements TOSEC for everything that is not a game -- demos, intros,
diskmags, musicdisks, tools -- the majority of a demoscene-heavy Amiga archive TOSEC and
OpenRetro cannot enrich (3ad). A weekly cron (`/api/cron/demozoo`, daily schedule, gated to one
fetch per 7 days) downloads Demozoo's ~200 MB bulk export into our Blob store and extracts only
Amiga productions into `demozoo_*` tables. A new nightly sweep phase matches every TOSEC-
identified or unidentified blob against those productions by exact title key (spec §5): TOSEC
games are always skipped; a single title match whose year or publisher/group agrees becomes an
**automatic** link (global, on the blob); anything else with a title, volume-name, or filename
hit becomes a **suggestion** a person resolves through a review queue (single-candidate rows
pre-ticked, bulk accept chunked at 50). Screenshots are copied into our image store one at a
time, capped at 60/hour, following `openretro-images.ts`'s politeness rules exactly. Unlink
restores the game's TOSEC/filename-derived title. A hand-edited title always survives a link.

**Timing gate (Task 7, measured against the live production DB):** EXTRACT 5,402 ms, RSS
857 MB (gate: fails above 200,000 ms or 1,500 MB) for 78,447 productions and 79,180
screenshots -- both inside the 70,000-90,000 expected range. WRITE (first import) 137,656 ms,
one run, result `done` (the daily cron budgets 240,000 ms and can resume across days if it
doesn't finish in one). The live cursor after that run: `step=applied`,
`last_attempt_at` 2026-09-14 18:31 UTC, `etag` null -- **the deployed cron idles until
~2026-09-21 18:31 UTC, then makes one unconditional fetch** (no `ETag` was returned to make a
conditional request possible).

**Task 16's sweep (2026-09-14, live library):** calling `sweep()` in a loop against the live
DB converged in 1 iteration, `done: true`, with every demozoo counter at 0 -- the library was
already fully matched (an admin-triggered sweep had run earlier the same day, after the
import's `applied_at` of 18:34:05 UTC; `demozoo_checked_at` was already set on all 59 live
blobs). The live totals that sweep converged to, read directly from the database: **1 applied,
6 suggested, 19 skipped_game, 33 none** (out of 59 blobs); TOSEC matched 32/59, OpenRetro
enriched 16/59; **28 Demozoo screenshots stored**, 0 failed, 7 suggestion rows across 6 blobs
(one blob has 2 candidates), against 78,447 imported productions.

**Live library per-blob outcome, by title, for this org (sfs@enhance-it.dk's library):**

| Title | Demozoo outcome |
|---|---|
| 9 Fingers (2 disks) | suggested |
| Global Trash | suggested |
| State of the Art | suggested |
| Wayfarer | suggested |
| Ray of Hope 2 | **applied** → Demozoo production 737, "Ray of Hope 2" |
| Alien Breed II - The Horror Continues (4 disks), Apidya (2), Assassin v1 (2), Giana Sisters - Special Edition (2), Project-X (4 disks) | skipped_game (TOSEC identified these as games; Demozoo never answers for a game) |
| World Construction Set v2.04 (7 disks), the five amiga-wb31_\* Workbench disks | none (no candidate; these are an application and OS install disks, outside Demozoo's demo/intro/diskmag coverage) |

The one **applied** (automatic) link was eyeballed against its local `demozoo_productions` row:
title "Ray of Hope 2" against a game already titled "Ray of Hope 2", production 737 (group
Majic 12, 1991) -- correct. This is one of the five cases the 2026-09-14 spike itself verified
against demozoo.org (spec §0.4, "Ray of Hope 2 → Majic 12"); this session deliberately made no
further requests to demozoo.org. **No wrong automatic link on the live library; the plan's STOP
condition was not triggered.**

**All blobs held only by other orgs (27 of 59, everything not in the operator's own 32-blob
library above):** 0 applied, 1 suggested, 5 skipped_game, 21 none -- computed by subtracting
the operator's org breakdown from the live totals recorded above (1 applied, 6 suggested, 19
skipped_game, 33 none), not by naming any other org or title, per instruction. This live
database is a moving target for that figure: e2e fixture organizations are created and torn
down by the Playwright suite and exist only transiently, so the count of non-operator orgs
(and their blob totals) shifts between runs -- 13 orgs held entitlements at one later review
point, most of them transient e2e fixtures present only while a suite was running. The
operator's own applied/suggested/skipped_game/none figures above are the only ones this task
treats as stable.

**Acceptance numbers (Task 16 Step 2) against the spike, final matching rule, over 7,412
distinct non-game TOSEC `(set_name, title, year, publisher)` rows:**

| | applied | suggested (single) | suggested (multiple) | none |
|---|---|---|---|---|
| **All non-game sets** (7,412) | 386 (5.2%) | 1,451 (19.6%) | 395 (5.3%) | 5,180 (69.9%) |
| **Demos set only** (2,881) | 291 (10.1%) | 1,299 (45.1%) | 375 (13.0%) | 916 (31.8%) |

Combining `applied` + `suggested (single)` as the spike's "unique" bucket (the spike predates
the automatic/suggested split): **1,590 / 2,881 = 55.2%** unique-like, **13.0%** ambiguous
(multi-candidate), **31.8%** none, against the spike's 53% / 11% / 36% -- **all three within
±2.2, +2.0, and −4.2 percentage points of the spike, well inside the ±10pp bar**; no explanation
requirement triggered, but the expected cause was checked anyway: **the broader §5.2 candidate
filter (any non-game `production`, not the spike's Demo/Intro/Musicdisk/Diskmag/Slideshow type
allowlist) admits 6,836 extra candidate rows** across all sets that the spike's allowlist would
have excluded (graphics/music-adjacent production types, coverdisk-shaped entries, etc.) --
consistent with the small increase in matched/suggested share over the spike's numbers.

**By set** (non-Demos sets, for completeness): Applications PD 839 titles (22 applied / 78
suggested-single / 9 suggested-multi / 730 none); Applications 2,252 (54/54/7/2,137);
Coverdisks 987 (0/0/0/987 -- expected, coverdisk titles like "Amiga Format Coverdisk 55" don't
title-match Demozoo productions); Educational 453 (19/20/4/410).

**The six corrections made during implementation, and every ruling that changed behaviour or
tests (R5–R18), are recorded in the spec's "Corrections made during implementation" section**
(`docs/superpowers/specs/2026-09-14-demozoo-design.md`): the daily-cron/weekly-fetch split, the
two-step resumable import, `text[]` columns, `(game_id, production_id)` dismissals,
`sha1(standard_url)` image keys, plus R5 (Demozoo ranks above TOSEC once linked), R6 (a merge
carries confirmations/dismissals to the survivor), R7 (the trigram search indexes), R8 (fixture
multi-type/multi-author coverage), R9 (`groups` is every author nick, not only releaser
groups), R10 (`writeExtract`/`runDemozooCron` test coverage), R11 (unlink always re-derives),
R12 (re-derive from the first TOSEC-identified disk), R13 (`linkInputs` is org-scoped on
disks), R14 (a failed screenshot fetch still counts against the hourly cap), R15 (the review
queue and Accept both exclude `skipped_game` games; ranked search; count-only badge query),
R16 (Unlink reachable even with no effective link), R17 (bulk accept chunked and capped), and
R18 (the queue re-derives picks from the current list and shows the source disk).

**Out of scope, per spec §11 and unchanged:** Pouet (the other scene database, a candidate if
Demozoo coverage proves short); fuzzy title matching (exact keys only -- a wrong title is worse
than a missing one); identification from disk contents beyond the volume name; the live
Demozoo API (the bulk export makes per-lookup load on a non-profit unnecessary).

**Things that will bite you here:**

- **Demozoo ranks above TOSEC for title/year/publisher once linked (R5, revised).** A later
  TOSEC DAT re-import does NOT retitle a Demozoo-linked game back to TOSEC's spelling --
  `tosec-apply.ts`'s retitle guard now excludes `metadata_source = 'demozoo'` specifically.
  If you need TOSEC's value back, that's what Unlink is for.
- **Unlink is the repair path and always re-derives (R11/R16).** It doesn't just clear a
  confirmation: whenever a game's `metadata_source` is `'demozoo'`, Unlink recomputes the
  effective link, dismisses it if one remains, and unconditionally re-derives title/year/
  publisher from the next machine source. It's also how you fix a game stuck showing a
  Demozoo title with no effective link (reachable if a later import moves a blob off `applied`
  or deletes a production) -- the suggestion card offers Unlink in that state too, not just
  when linked.
- **Bulk accept is chunked at 50, capped at 100 per request (R17).** The review queue's
  "Accept selected" posts sequential chunks of 50 and sums the result; the API route itself
  refuses more than 100 items in one call (`maxDuration = 300`). A very large accept takes
  several round trips; nothing is lost if one is cut off -- each confirm is idempotent and the
  remainder just stays visibly in the queue.
- **The deployed cron idles until ~2026-09-21 18:31 UTC, then makes one unconditional fetch.**
  No `ETag` came back from the first fetch, so the conditional-request path (§3.1) has not
  actually been exercised yet; watch the next scheduled run's log for a `304` or a `200`.
- **`db:push` drops undeclared indexes.** The `games.title`/`games.publisher` trigram indexes
  from migration 0012 were never declared in `catalog.ts` and were found missing from the live
  DB during this plan's Task 1 (R7) -- `drizzle-kit push` diffs against the schema files, not
  migration history, so anything created outside Drizzle's own tracking is drift it will
  silently drop on the next push. They're declared now; the lesson generalizes to any future
  hand-written migration SQL.
- **The ~200 MB export is copied into the Blob store weekly**, not queried live -- `demozoo/
  export.sql.gz`, overwritten each fetch, with stage 2 extracting from OUR copy so a stage-2
  failure or timeout never triggers a second request to `data.demozoo.org`.
- **The final whole-branch review's fixes (I1-I6, M2, M3) changed behaviour; each is in the
  spec's corrections.** In short: re-match after a TOSEC change; the weekly fetch is one atomic
  claim; an extract under 50,000 productions or 80% of what we hold is refused (`refused: ...`
  in the cron report, step left `fetched`, re-fetched after a week); a failure while matching
  (DB error, or anything thrown before the blob's writes) leaves the blob's prior state and
  suggestions untouched and retries next run; a failure to READ the disk bytes for the volume
  name is treated as "no volume name", so the blob can be re-stamped from TOSEC title and
  filenames alone and lose a volume_name-only suggestion until the next re-match (an 'applied'
  link cannot be demoted this way; applied only comes from the TOSEC branch, which needs no disk
  read); fetch and extract never share an invocation; screenshots only from `https://media.demozoo.org/`,
  raster types only, `nosniff` on `/api/images`.
- **Watch: the first production fetch is expected at the 2026-09-22 01:30 UTC cron run.**
  Check that the `demozoo_import` row shows a new `fetched_at` and `step` moving
  `fetched` -> `extracted` -> `applied` over the following daily runs, not only a new
  `last_attempt_at` (which alone means the claim ran but the fetch threw, or answered `304`).

**Known gaps, deferred from the final review (minor):**

- **M1:** two sweeps running at once can each read the same remaining hourly screenshot budget,
  so the 60/hour cap can be exceeded briefly.
- **M4:** a Demozoo confirmation carried onto the survivor by a merge (R6) does not retitle the
  survivor.
- **M5:** a game identified only by OpenRetro (no TOSEC identity) still gets Demozoo
  suggestions. Operator note: accept or dismiss them like any other; nothing is linked unasked.
- **M6:** every re-match of a blob that TOSEC does not decide re-reads its volume name from the
  object store (no cached volume name).
- **M7:** the e2e suite's seeded productions (ids from 2,000,000,000) are briefly visible in the
  live Demozoo search while a run is in progress; the teardown removes them.
- **3c (phase-2 sibling):** a Demozoo blob that fails matching on every run keeps `sweep()`'s
  `done` false permanently (it is skipped within a run, so there is no hot loop). The e2e helper
  `runSweepUntilDone` in `e2e/demozoo.spec.ts` gives up after 5 calls without `done`, so such a
  blob in the live DB would fail the Demozoo re-sweep e2e tests.
- **Demozoo fallback:** if `demozoo/amiga.json` is missing and the last attempt is over a week
  old, the write step's fallback re-fetches from Demozoo (still within the weekly claim) rather
  than re-extracting our stored export.
- **Screenshot redirects:** screenshot fetches follow redirects, so the `media.demozoo.org` host
  allowlist checks only the first URL (the raster content-type allowlist and `nosniff` still apply).
- **Cron drift:** the daily 01:30 cron against a 7-day gate can drift a refetch to 8 days.

### 3am. NFC tap-to-mount -- 2026-09-26 (spec/plan 2026-09-25-nfc-tap-to-mount)

**Built and shipped, not yet bench-accepted.** Spec `docs/superpowers/specs/2026-09-25-nfc-tap-to-mount-design.md`
(incl. the poll-interrupt/nfcAck amendment and the 21-char OLED amendment), plan
`docs/superpowers/plans/2026-09-25-nfc-tap-to-mount.md`. 12 tasks, subagent-driven, each reviewed; the
whole-branch review found an Important no task review could see (below); two fix passes.

**How it works.** The tag (MIFARE Classic 1K, sector 1, blocks 4-6, factory key A) holds `WFDK` v1 + the 36-char
`disks.id` + CRC-16 -- the disk id, not the sha, because the sha moves on every Amiga save. The reader is a
step-wise state machine on core0 in the display pump's slot (<= 4 register ops/pass; 1 op/pass while mounted on a
no-panel 100 kHz bus), handing events to core1 through seqlock mailboxes (WRITE_DONE has its own box, and its
report is retried 2 s doubling to 60 s until the server hears it). A tap POSTs `/api/device/tap`; a pending tap
INTERRUPTS the 25 s held poll (transport `interrupted` hook, `TRANSPORT_INTERRUPTED` -200) at the cost of a fresh
TLS handshake. Writing: `pnpm nfc:write` sets a write request on the device row; the poll carries it on the
board's `nfcAck` cursor; the board writes the next tag that ARRIVES (a tag already lying there is not written),
reads all 48 bytes back and POSTs `/api/device/tap-write`. The org always comes from the device token.

**The whole-branch review's catch:** a board on pre-1.3.0 firmware sends no `nfcAck`; treated as 0 it would have
made every poll return at once, forever, for any row that ever had a write request -- a tight loop per board.
Fixed: a missing `nfcAck` means the board does not speak NFC. Second fix pass: the write-report retry could run
every 50 ms while the uploader waited; it now has its own backoff.

**Rollout, 2026-09-26 02:13-02:15 CEST:** migration 0025 (nine additive `devices` columns) applied with guarded
SQL before e2e; merged `0f6fbd1`, deployed; firmware `1.3.0+g1457e53` published as seq 10 and targeted with
`requestFirmwareUpdate` directly (operator authorised the install overnight, in lieu of pressing Update with the
password). The board was on the unregistered bench build `1.2.0+g6b9db28`, which `refuseTarget` treats as the
recovery path. queued -> staged (waited for idle) -> applying -> trial proven -> bought -> "update to
1.3.0+g1457e53 confirmed (sequence 10)"; the DB shows `nfc_reader = present`; the blue fob lying on the reader read
as "Tag: not a disk tag" (correct -- it is blank); boot no longer pauses. `pnpm nfc:write` checked live up to its
pre-arming exit only.

**Gates:** vitest 1164; build clean; firmware host 3148/0; full e2e 367 passed + 2 latency failures, both test
fragility, fixed (`286ecce`: the burst test seeds `last_tap_at`; time-machine:198 gets its sibling's 120 s budget)
and those two specs re-run green.

**Bench acceptance still owed (operator present, one turn per physical step):**
1. `pnpm nfc:write "<a disk>"`, then tap the blue fob -> "written to tag 24:19:b6:01, read back OK".
2. Tap it -> the disk mounts. Tap again -> no-op ("Tag: already in drive").
3. Write the white card with another disk, tap it -> swap.
4. A blank tag -> "Tag: not a disk tag".
5. Pull the reader's SDA lead -> the drive carries on, status goes `absent`; reseat -> `present`. Watch TRACK-MISS.
6. Tap during an Amiga disk read -> 0 TRACK-MISS.
7. Write, then tap a different tag at once -> the write result still reaches the CLI.
8. Unverified on hardware: the soft reset before the vendor init (the prototype had none).

**Bench results 2026-09-26 (morning):**
- **Write proven:** `pnpm nfc:write` Turrican II disk 1 → blue fob `24 19 B6 01`, "read back OK", result recorded.
- **Tap-to-mount proven:** tap → server "mounting" → fetch 1.8 MB in 3.2 s (615 KB/s) → MOUNT; about 5.5 s end to end
  (≈1.1 s TLS handshake after the poll interrupt, 0.25 s tap, 3.2 s fetch). A second tap → "Tag: already in drive".
- **A defect the bench found, fixed in 1.3.1 (`1a65cc6`, seq 11):** a fob lying UNTOUCHED on the reader was re-detected
  as a new arrival three times in ~4.5 min, once receiving a write it was never presented for. Cause: detection dropouts
  longer than the 1 s debounce. 1.3.1 requires 3 s of absence, never writes a tag that was held when the write was armed,
  treats the reader chip's return like a sighting (review found a chip outage bypassed the guard), and logs every dropout
  (`nfc: held tag … unseen N ms`). First measured dropout on 1.3.1: 817 ms, correctly absorbed.
- Still owed from the list above: blank tag, pull-SDA, tap during an Amiga disk read (TRACK-MISS), write-then-other-tag.
- **1.3.1 was installed via `requestFirmwareUpdate` directly (operator-authorised)**; it queued until the disk was ejected.

**Fob button (web writing), merged `b6c4e7c`:** `/api/nfc/write` (POST arm, GET status, DELETE withdraw; session
auth, org-scoped, foreign ≡ unknown) over the same store functions as `pnpm nfc:write`; `src/components/nfc/fob-button.tsx`
on library cards (grid view) and game-page disk rows, rendered only when a board reports `nfc_reader = present`. A stale
POST withdraws only its own seq; unmount/pagehide withdraw; touch holds in card dialogs no longer start a dnd-kit drag
(fixed for the delete dialog and card controls too). Full e2e 378/378. Deferred minors: after a long bfcache stay the
deadline branch can overwrite "cancelled when you left" with "Timed out"; if a poll hangs in the last seconds the
wording can say "no tag was written" when it is unknown.

**Known and deferred (reviewed, none blocking):** nfcAck ahead of the server after a DB restore misses requests
until a reboot; a tag pulled during AUTH reads "locked"; a write NAK reads "moved" (should be "locked"); a
bad-id arm replaces a pending good one; 7-byte UIDs are shown as 4 bytes; test gaps (chip loss while writing, the
fake's ErrorReg is always 0). The e2e suite shares the live DB: never run two e2e runs at once (§ "Two sessions
running e2e").

### 3al. HFE v1 disks — upload, play, extract as ADF (2026-09-24)

**STATUS: merged and deployed 2026-09-24 (`e8126e8`); bench-proven 2026-09-25 (see 3al-a).**
The status text that follows is as written before the merge. Spec `docs/superpowers/specs/2026-09-24-hfe-disks-design.md`, plan
`docs/superpowers/plans/2026-09-24-hfe-disks.md`. Migration 0023 (three additive columns on
`disks`) is **already applied to production**. It was applied as a guarded `ADD COLUMN IF NOT
EXISTS`; this database has no `__drizzle_migrations` table, so nothing records it.

What it does:
- `.hfe` uploads are accepted by the dropzone and the CLI, and the original bytes are stored
  (never converted).
- The board is sent WFMF built from the HFE on every fetch: `hfeToWfmf`, per-track bit counts,
  and a `content-length` computed from the body.
- HFE disks are read-only on every path: edit, rename, restore, write-back, and write-protect
  off.
- The game page shows an HFE tag, the weak-bit notice and "Read-only (HFE)". It offers
  **Extract as ADF** when every AmigaDOS sector decodes, and otherwise says why not.
- Extract creates a new ordinary ADF disk in the same game.

Things a successor needs:
- **The column is `disks.image_format`, not `kind`.** `game-kind.ts` already uses "kind" for
  Game/Demo on the same pages.
- **HFE v3 files keep `formatrevision` 0 (measured).** Only the `HXCHFEV3` signature tells v3
  apart from v1.
- **What Greaseweazle writes (measured):** encoding 0xFF, 253 kbit/s, 12,668-byte sides. A PC
  720 KB image is 250 kbit/s with 12,500-byte sides.
- **Fixtures are made by Greaseweazle from synthetic ADFs** (`pnpm hfe:fixtures`), gzipped and
  reproducible, never from a real disk.
- **Amiga-ness is decided by content:** track 0 must decode AmigaDOS sectors 0 and 1.
- **The sector decoder scans bit by bit** and handles a sync word split across the index. A
  test was added for this after mutation testing showed the plan's own tests missed it.
- **Upload limits:** `MAX_DISK_BYTES` is now **2.25 MiB** for every file, because an HFE with
  82–84 cylinders or long tracks exceeds 2 MiB. At most **50 HFE files go in one `/complete`
  call** (`MAX_HFE_PER_BATCH`, and `splitBatches` in both clients).
- **Rulings made during the work** (reversible):
  - The HFE tag is on the disk rows, not the library grid.
  - The file browser redirects an HFE disk to its game page.
  - Clients validate HFE in the browser, and the server validates again on every
    registration, including dedupe hits.
- **Deferred minors, in the SDD ledger:**
  - Re-extracting after the extracted ADF was edited is a silent no-op that returns 200.
  - The not-extractable reason is only in a tooltip, which touch devices can't show.
  - Refused HFE bytes stay in storage with no database row.
  - HFE disks count as unidentified in TOSEC coverage.
- **BENCH ACCEPTANCE IS STILL OWED** (spec §7), for when the board is available:
  1. A clean AmigaDOS HFE boots.
  2. A long-track protected title loads.
  3. A weak-bit title fails the way the notice says.
  4. Extract, then mount the ADF; it behaves the same.

  No HFE has ever been played on real hardware.

#### 3al-a. Long-track HFEs: 14 KB tracks, and each board says what it holds (2026-09-24)

`Turrican_ECS.hfe` (the operator's) was refused at upload. Cylinders 9–78 use Turrican's
own track format: no 0x4489 sync, 13,500 bytes a side (108,000 cells), and **every byte is
data** (the non-filler span is 13,277–13,500). Trimming can't work. Cylinders 0–8 are
AmigaDOS.

The fix (operator approved "its good, proceed"):
- **Firmware:** `TRACK_MAX_BYTES` 13312 → **14336**.
  - PSRAM: 2×160×14,336 + the 2 MiB update stage = 6.68 MB of 8 MB.
  - SRAM: +17 KB, because track_cache holds several track-sized buffers.
  - Every status report now carries `"trackMaxBytes":14336`.
- **Server:**
  - `devices.track_max_bytes` stores the board's report.
  - `disks.max_track_bits` stores each HFE's longest served track, recorded at ingest.
  - `setDesired` refuses, inside its UPDATE, a disk longer than the board holds. The
    answer is `409 track_too_long`, with a sentence the mount toast shows.
  - A board that never reported the field counts as legacy (13,312).
  - Upload cap is **2.5 MiB**.
  - Migration 0024 is applied to production.
- **The reset rule:** a status report that names a firmware version but has no
  `trackMaxBytes` resets the column to null (legacy). Such a report comes from a board that
  rolled back to an older build.
- **ACCEPTED GAP:** if a board already HOLDS or WANTS a long-track disk when it rolls back,
  the desired disk stays set. The old loader refuses tracks over 13,312 (`image_loader.c`),
  so nothing is corrupted, but the Devices card shows the disk as pending with no reason.
  Fix only if it ever happens: clear the desired disk when the reset lowers the limit below
  its `max_track_bits`.
- **SHIPPED 2026-09-25 00:25 CEST.** Merged as `cca8299` after full e2e 349/349; deployed.
  Firmware `1.2.0+ge8ac726` (commit e8ac726 bumped the semver; the build dir had a stale cached
  `FIRMWARE_SEMVER=1.0.0`, cleared with `cmake -U`) was published as sequence 9. The operator pressed
  Update. Measured from the row: queued 00:23:36, applying 00:24:31 (disk ejected first), trial
  heartbeat 00:24:52 with `track_max_bytes=14336`, confirmed 00:25:10. Before the update, the
  1.1.4 board had `track_max_bytes` null after the deploy (legacy path confirmed).
  **BENCH-PROVEN 2026-09-25 morning:** the operator uploaded Turrican_ECS.hfe, mounted it and booted it
  on the Amiga: "it works perfectly". The DB agrees: mounted disk image_format=hfe,
  max_track_bits=108000, board 1.2.0 with track_max_bytes=14336, no last_error. The 216 ms
  revolution (108,000 cells at 2 us) is accepted by a real Amiga. The rest of spec §7's HFE bench items
  are still to run.
  **Observed, not investigated (operator's call, 2026-09-25):** booting AmigaTestKit.hfe right after
  Turrican once hung at cylinder 17 (OLED) and needed a second Amiga power cycle. The board is on USB-C,
  so an Amiga power cycle never resets it. Hypothesis (unproven): the Amiga was booting Turrican,
  which was still mounted while the new image downloaded; the swap (published only once the image is
  complete) landed mid-boot, and Turrican's trackloader (cyl 9+) then read AmigaTestKit's tracks. The
  operator declined to act unless reboots can be detected with certainty. The board has no RESET
  wire; only the bus pattern (select idle, re-home to TRK0, read cyl 0) is visible, and a trackloader
  can mimic it. A certain signal needs the Amiga's reset wired to a spare pin on a future board rev.
  **Extract round trip PASSED on the board, 2026-09-25.** AmigaTestKit.hfe (made by `gw convert` from
  adf-archive/AmigaTestKit.adf) was uploaded and booted as an HFE. Extract as ADF then produced sha
  4111eb94..., byte-identical to the original and to the local prediction. TOSEC independently
  matched it as "Amiga Test Kit v1.4 (2019-06-03)(Keirf)" and moved the HFE and the ADF into that
  game. The extracted ADF (disk d65dbe62) was mounted with the Amiga off, then booted to the Test Kit
  diagnostics. Spec §7 HFE bench status: clean HFE boots ✓, long-track HFE boots ✓ (Turrican),
  extract then mount the ADF ✓, weak-bit title ✗ (still owed; the operator needs a weak-bit HFE).
- **(Proven 2026-09-25, above.) Was unproven until the bench:** a 108,000-cell track plays as a 216 ms revolution at the
  fixed 2 µs cell, and INDEX follows the DMA wrap. A Gotek plays this HFE the same way, but
  only booting Turrican on the board proves the loader accepts it.

### 3ak. The board updates itself — 2b

**STATUS: MERGED AND DEPLOYED 2026-09-23 (see below); feature CLOSED 2026-09-25.** The lines
that follow up to "MERGED AND DEPLOYED" describe the branch before merge.
**Gates (branch head 137a4db, 2026-09-23):** firmware host suite 2,706 checks / 0 failed; vitest
996 passed / 1 skipped; `pnpm build` clean; the firmware builds under CI's condition (SDK-fetched
picotool, `-DPICOTOOL_FORCE_FETCH_FROM_GIT=ON`); full Playwright 322/4, where all four failures were
`ENOENT scandir 'adf-archive'` because the worktree lacked the untracked `adf-archive/` folder
(`.git/info/exclude`) — with it symlinked, those two specs ran 10/10, so effectively 326/326.
**A worktree needs `adf-archive/` linked in or four device specs fail for a reason that is not code.**

**MERGED AND DEPLOYED 2026-09-23 (master b4c44f3).** CI's first run failed on Linux gcc
`-Wformat-truncation` (a 24-byte register-body tail that macOS clang never flags); b4c44f3 sized it
32 and CI went green.
**The server half of the final-review I2 fix is PROVEN on hardware after deploy** (operator pressed
Update to `1.1.4+gb4c44f3`, seq 8, 21:16 CEST; device row sampled every second):
queued 21:16:36 -> applying 21:16:53 -> **21:17:16 `firmware_version=1.1.4+gb4c44f3`, desired still
set, `state=applying`** (the trial's heartbeat; before I2 this completed) -> 21:17:31 completed
(desired and state null) only after the confirmed boot.

Increment 2b. Spec: `docs/superpowers/specs/2026-09-22-firmware-update-device-design.md`
(read its new §9 addendum first — the bench moved the design past D8's text). Plan:
`docs/superpowers/plans/2026-09-22-firmware-update-device.md`, 12 tasks. Ledger (every ruling
and bench measurement, in order): `.superpowers/sdd/2026-09-22-firmware-update-device/progress.md`.
Commits `ecbe76f..71424e7` (`git log --oneline ecbe76f..HEAD`).

**What shipped**

- **A/B partitions + try-before-you-buy via the RP2350 boot ROM** (`partitions.json`: A at
  32K+4MB, B at the next 4MB). No bootloader of our own — the ROM already does slot choice,
  trial boot and revert.
- **Prove, THEN proven-reboot, THEN early-buy** (`fw_rom.c`, replaces spec D8's in-place buy —
  see THE FINDING below). The trial proves itself with a heartbeat naming its own version,
  writes a "proven" mark (magic + hash of `WF_FIRMWARE_VERSION`) to watchdog `scratch[0..1]`,
  and requests a `FLASH_UPDATE` reboot into its OWN slot. The next boot, single-core, before
  core1 launches and before PSRAM is touched, `fw_rom_boot_init` sees trial + matching mark,
  clears it, and calls `rom_explicit_buy` directly. Post-buy bookkeeping (`installed_sequence`,
  clearing `pending`) is the existing `fw_boot_reconcile` CONFIRMED_LATE path on core1.
- **Signed manifest, not just a hash** (`fw_verify.c`, vendored Monocypher 4.0.2
  `crypto_eddsa_check`): `webadf-fw-v1\n<version>\n<sequence>\n<sha256 hex>\n<sizeBytes>`,
  ed25519 against the compiled-in public key, keyId checked. `signature_format=2` rows only
  are offered to a board with `updateProtocol` ≥ 1.
- **Anti-rollback record**: a 4 KB firmware-state sector at 16 MB − 12 KB holds
  `installed_sequence` + `pending`; refuses any signed `sequence` ≤ installed.
- **PSRAM staging**: the release streams into PSRAM over the existing TLS client, hashing as
  it goes; nothing touches flash until SHA-256 and signature both pass.
- **Header-last slot writer** (`fw_apply.c`): writes the other slot with the first sector
  (IMAGE_DEF) LAST, reads the whole slot back through the no-translate window and compares
  SHA-256, then writes `pending`, then `rom_reboot` — a power cut before the header lands
  leaves the old slot as the only bootable one (bench item 8 below).
- **Idle gate** (D6): flashing starts only with no disk mounted, motor off, no write-back
  session open — same predicate as `fw_state_save`'s.
- **The instruction-cursor sync rule** (fix round 1, carried from §3aj): the first
  `instructionVersion` seen after `dc_init` with no update is a CURSOR SYNC — ack only, never
  `fwu_on_instruction` — so a boot-time REVERTED failure still reaches the server (spec D8/D9);
  a real cancel moves the cursor past the sync and still clears normally.
- **`WF_FW_DEBUG` bench build** (`cmake -DWF_FW_DEBUG=ON`): serial commands `fwdbg {json}`
  (injects a crafted offer through the SAME parse → check → fwu path a real poll takes) and
  `fwdbg-wdtest` (deliberately wedges core1 inside `flash_safe_execute` to prove the watchdog
  resets it). **Never publishable**: `firmware-manifest.ts`'s `refuseReleaseImage` byte-scans
  the built `.bin` for the literal string `fwdbg` and refuses to publish if found, on top of
  requiring `tbyb: not bought` and `hash: verified` in `picotool info` output.

**THE FINDING, load-bearing for the whole design**: the RP2350 boot ROM's `rom_explicit_buy`
**HANGS whenever PSRAM (QMI CS1) is configured, and the watchdog does NOT rescue it.** Three
separate wedges on the operator's board before this was isolated (BENCH T4.8, and two more
during the fix-round-4/5 bench isolation) — the trial image sent one heartbeat then went
silent: USB enumerated, serial dead, `picotool reset` ignored, the 8 s watchdog never fired.
Isolated with a throwaway probe against the same board+partition-table:
- no PSRAM configured → `rom_explicit_buy` returns rc=0 fine (V2H).
- PSRAM configured (`hardware_psram`, SDK runtime PSRAM init pre-main) → buy WEDGES, and an
  armed 4 s watchdog does NOT reset it (V2P).
- `PICO_RUNTIME_SKIP_INIT_PSRAM=1`, buy FIRST (PSRAM size reads 0 at that point), THEN
  `runtime_init_setup_psram()` explicitly afterward → buy rc=0, PSRAM comes up
  (size=8388608) right after, normal reboot keeps the bought slot (V2L). **Root cause
  confirmed.**

Hence the design: the firmware never calls the ROM buy with PSRAM live. `main()` calls
`fw_rom_boot_early` (the early buy) FIRST on every boot, before anything touches PSRAM, then
calls `runtime_init_setup_psram()` explicitly. The build sets
`PICO_RUNTIME_SKIP_INIT_PSRAM=1` so crt0 never brings PSRAM up on its own, and there is an
assertion that no *initialized* `__psram` data exists (only `__uninitialized_psram`), since
crt0 would otherwise copy it before PSRAM is up. Round 4's QMI M1 save/restore around the buy
and `psram_reinitialize` are gone — not needed once the buy never sees PSRAM at all.

**Other measured facts, each load-bearing somewhere in the code:**

- **`picotool load -p 0 -x <uf2>` STARTS a TBYB image; a plain `picotool reboot` after
  `load -p 0` leaves the board in BOOTSEL instead.** (BENCH T4.8.) This is why
  `scripts/firmware-install-partitioned.sh` needed fixing — see below.
- **The watchdog DOES rescue a core1 `flash_safe_execute` lockout wedge** (`fwdbg-wdtest`:
  reset ~21 s after the command, came back on the same bought image, heartbeat 3 s) **but does
  NOT rescue a hang inside the ROM buy itself** (the PSRAM finding above). The design keeps
  the buy away from PSRAM rather than relying on the watchdog to catch it.
- **The SDK's `rom_explicit_buy` already wraps itself in `flash_safe_execute`** (`bootrom.h`
  974-987). The plan's original `fw_rom_buy` wrapped it a second time → nested multicore
  lockout → deadlock. Fixed in fix round 3: call `rom_explicit_buy` DIRECTLY, never nest
  `flash_safe_execute` around it.
- **`XIP_BASE` reads outside the booted slot hard-fault** on a partitioned boot; `config_store.c`
  and `token_store.c` read through `XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE` instead (D2), shipped
  first as its own safe-on-unpartitioned-boards step (Task 1).

**Every bench acceptance item (spec §8), with evidence:**

1. **USB install** — BENCH T4.8 PASS (2026-09-23 10:08): debug build `1.0.0+g5e826aa` via
   `picotool load -p 0 -x`; trial boot → TLS up → "trial: proven — rebooting into slot 0
   (0x8000) to buy" at 16.5 s → reboot → second boot not a trial (bought), PSRAM ok: fetched
   mounted disk `3d16e0ac` into PSRAM; DB heartbeats 4-9 s, pairing intact.
2. **N → N+1 from the Devices tab** — PASS (13:13-13:14:54): `1.0.0+g2ac2617` (seq 2) →
   `1.1.0+ga2dd854` (seq 3). Update pressed with disk mounted → held in `queued`; operator
   ejected → applying → flashed slot A → reboot → trial partition 0 → proven reboot → early
   buy → "update to 1.1.0+ga2dd854 confirmed (sequence 3)" → cursor sync. **Measured
   deviation, since fixed**: the server derived completion at 13:14:54 from the TRIAL
   heartbeat, ~5 s *before* the image was actually confirmed (bought) — fixed in the final
   fix wave (I2), see below; not re-run on the bench.
3. **N+1 → N+2, the B → A direction** — PASS (13:16): `1.1.0` in slot A → `1.1.1+g9323c86`
   (seq 4) into slot B: offered → downloading → queued(staged) → applying 13:16:35 → trial
   partition 1 → proven reboot → confirmed (sequence 4) → cursor sync.
4. **A deliberately broken release that never buys** — PASS (13:33-13:38): `1.1.2+g959e9a6`
   (seq 5, throwaway branch, no heartbeat) applied into slot A → trial partition 0 → at
   287.85 s "trial: giving up (no heartbeat within 5 minutes) — rebooting to revert" → slot B
   `1.1.1` re-booted → "fw: reverted: no heartbeat within 5 minutes" → the next cursor sync did
   NOT wipe the failure. This release is deliberately superseded (`1.1.3+g71424e7`, seq 6,
   fixes it) — it exists only to prove the revert path and was never meant to be the board's
   final state.
5. **A tampered signature refused before any flash write** — PASS, item 5+6 together (13:42,
   debug build `1.1.3+g71424e7` via USB `-x`): `fwdbg`-injected a genuinely-signed seq-6 offer
   with one base64 character flipped → "signature does not verify", no download, slot
   untouched.
6. **A rollback target refused by the board even when the server is bypassed** — same run:
   `fwdbg`-injected a genuinely signed seq-3 offer (`1.1.0`, older than the installed `1.1.1`)
   → "not newer than the installed release (anti-rollback)", no download.
7. **Update requested while a disk is mounted waits, then proceeds** — covered by item 2
   above (held in `queued` until the operator ejected).
8. **A power cut during `applying`** — PASS (13:42): Update to `1.1.3` → applying at 13:42:28
   → operator pulled USB power → power-up booted the intact slot B (`1.1.1`, partition 1),
   cursor sync; DB read `1.1.1`, desired `1.1.3`, state null (the cut landed before `pending`
   was written, so the card read "update requested" — no auto-retry, by design).

**All 8 acceptance items PASS.**

**Accepted deviations and known gaps:**

- **Completion from the trial heartbeat — FIXED (final review I2), host-tested, not yet
  re-run on the bench.** Measured in item 2: the trial reported its new version before the
  buy, and the server cleared the target on it; a trial that then reverted left the card
  reading "up to date" with the failure nowhere. Now the trial's heartbeats carry
  `firmwareUpdateState: "applying"`, and `recordStatus` completes (clears desired/state/error)
  only when the reported version matches AND the state is not `applying` — still the single
  compare-and-clear UPDATE. The confirmed (bought) boot reports `null` and completes; a board
  that omits the field entirely still completes. `updateLabel` now shows `update failed —
  <reason>` even with no target left, and a trial whose heartbeat landed only past the buy
  cutoff gives up with "heartbeat came too late to confirm", not "no heartbeat".
- **`updateProtocol` reaches the server with the first status report, not at registration**
  (`dc_set_fw_report` is attached after `dc_register`) — matches the same accepted deviation
  §3aj already notes on the server side; the server accepts it on status.
- **A USB-install trial has no deadline (final review I3).** A trial with no pending update
  record (a USB install — on a new board the other slot is empty, nothing to revert to) no
  longer reboots at 5 minutes: it waits through the portal and pairing as long as they take
  and confirms on its first heartbeat. `main()` loads the update record before core1 starts
  and tells `fw_rom` (`fw_rom_set_trial_revertible`); only an OTA trial (pending record) arms
  the core0 deadline and `fw_trial_decide`'s deadline give-up. Before this, a new board's
  first install hit the deadline in the portal and landed in BOOTSEL. Host-tested; not yet
  re-run on the bench.
- **A first USB install whose core0 HANGS still ends in BOOTSEL** (the watchdog, fed only by
  core0, resets the unbought trial; A unbought, B empty, old IMAGE_DEF overwritten). **A core1
  (network-side) hang in a USB-install trial is not caught at all** — with no deadline since I3,
  the board waits until someone power-cycles it, and then lands in BOOTSEL. Recovery either way is
  the flash backup the install script takes — there is no other recovery path.
- **PSRAM-stage failure corner:** a board whose PSRAM stage check fails reports `updateProtocol 0`,
  which omits every firmware field — so a trial on such a board would let the server complete
  during the trial (the pre-I2 behaviour), and a confirmed boot that omits the state could leave a
  changed target stuck at `applying` (`update_in_flight`). Needs a PSRAM failure on the new image;
  recorded, not fixed.
- **Builds are TBYB-only now, and refuse an unpartitioned board.** On an UNPARTITIONED board
  even `picotool load -x` ends in BOOTSEL: the image starts as a trial, finds no partition to
  reboot into to confirm itself, and is never bought. The firmware does not stay on an
  unpartitioned board by design. **`pnpm firmware:install-partitioned` (partition table +
  image) is the only way on**; `load -p 0 -x` is how that script, and a bench reload of an
  already-partitioned board, start the image.
- **The ROM's own buy (flag-sector erase, then rewrite) is still a reset-sensitive window** —
  inherent to the boot ROM, not something this design can close further; covered in spirit by
  the power-cut acceptance item (8), which tests the slot write, not the buy itself.

**How to operate:**

- **One-time per board**: `pnpm firmware:install-partitioned`. **This task fixed the script**
  — see below.
- **Publish a release**: `pnpm firmware:publish` (signs the manifest, refuses TBYB/hash/debug
  violations, refuses a non-newer sequence).
- **Push an update**: Devices tab → select boards → Update → confirm with password (§3aj's
  UI). The board enforces the idle gate itself regardless of what the server thinks.
- **Bench-only debug builds**: `cmake -B build -G Ninja -DWF_FW_DEBUG=ON ...`, then
  `fwdbg {"version":"...", ...}` to inject a crafted offer, `fwdbg-wdtest` to prove the
  watchdog rescues a lockout wedge. Never build a debug image for `firmware:publish` — it
  will refuse it, but don't rely on that; it's a backstop, not the plan.

**The install script needed fixing, and this task fixed it**: `scripts/firmware-install-partitioned.sh`
ended its sequence with `picotool load -p 0 "$FW/wifi_floppy.uf2"` followed by a separate
plain `picotool reboot` — exactly the sequence BENCH T4.8 measured as landing in BOOTSEL, not
booting. It now loads with `-x` in one step (`picotool load -p 0 -x "$FW/wifi_floppy.uf2"`),
which BENCH T4.8 confirmed starts the image directly, and the trailing `picotool reboot` is
gone.

**Do not copy secrets out of a flash backup.** `scripts/firmware-install-partitioned.sh` saves
a full flash image to `~/.webadf/board-backups/` (0600, owner-only) before every install —
it contains the Wi-Fi password and device token. Location only; contents stay off the record.

### 3aj. Select boards, press Update — the server half — MERGED 2026-09-22

**STATUS: merged to `master` (`7c22892`) and live since 2026-09-22; the board half is 3ak; the
feature is CLOSED (2026-09-25).** The status text below is as written before the merge.


Increment 2a. Spec: `docs/superpowers/specs/2026-09-22-firmware-update-server-design.md`.
Plan: `docs/superpowers/plans/2026-09-22-firmware-update-server.md`. Builds directly on
§3ai, which is what makes "did the update take?" answerable at all.

**NO FIRMWARE IMPLEMENTS THIS.** Every test drives a *simulated* device — the e2e suite
holds a real bearer token via `pairDevice`, so it polls, downloads and reports like a board.
That proves the server instructs, serves, tracks and verifies correctly. It proves nothing
about a board flashing itself. **Expect this protocol to move when firmware lands**: it
happened to write-back, where HANDOFF §4g had to become the authority over the spec text.
**It has now landed — see §3ak, on its own unmerged branch — and it did move: D8's in-place
buy could not survive contact with PSRAM.**

**An update is desired state, not a job.** It rides the poll body the device already parses,
is fetched through a route mirroring `/api/device/image/[sha256]`, and is confirmed by the
heartbeat. There is no `update_jobs` table: a second state machine that must be kept
consistent with the first, for fleet-scale observability one board does not need.

**What shipped**

- **A capability gate.** `updateProtocol` in the register and status bodies. Absent means
  the board cannot be updated — which is every board today — and **no control is rendered
  for it at all**, not a disabled one. This is what let the increment ship to production
  honestly before any firmware exists.
- **Six columns on `devices`** (migration 0018, applied as the generated `ADD COLUMN`
  statements with a guard, **not** via `db:push`): `update_protocol`,
  `desired_firmware_version`, `desired_firmware_set_at`, `desired_firmware_set_by_user_id`,
  `firmware_update_state`, `firmware_update_error`.
- **`POST /api/devices/firmware-update`** — all-or-nothing across the batch, behind a
  password re-verified per request. `DELETE` cancels, with no password.
- **`GET /api/device/firmware/[version]`** — bearer-authed, 404 for anything unpublished,
  **503 rather than 404** when the row exists but the object does not, so a board retries
  instead of concluding the version is gone.
- **Multi-select in the Devices tab**, a selection bar naming the full version, and a confirm
  dialog listing every board, the release notes, the security flag, and the sentence that a
  board holding a disk will wait.

**Gates as at the end of 2026-09-22:** 978 vitest, `pnpm build` clean, 2,467 firmware host
checks (untouched), Playwright **324 passed / 2 failed** — `adf-browser.spec.ts:180` and
`disk-files-edit.spec.ts:259`, both of which **pass in isolation (14/14)**. Neither touches
firmware. Two earlier full runs on this branch failed on *different* unrelated specs that
also passed alone (`create-adf` x4, `demozoo`), and one run was 326/0, so the suite has
intermittent cross-spec interference that predates this work. **Do not treat that as
settled** — it deserves a bisect of its own, and until then a full run's result has to be
read with the isolation re-run beside it.

**THE TWO THINGS TO READ BEFORE TOUCHING THIS**

1. **How an update wakes a long-holding device (spec §4.2).** The poll returns a body only
   when `desiredVersion` moves, and a 204 carries no `update` object. **Do not bump
   `desiredVersion` to announce an update:** the device echoes it back as `mountedVersion`
   and the server reads that for an upload's `not_mounted`/`behind` verdict (§4g) — an
   unrelated feature could strand an Amiga write mid-session.

   Instead there is a SECOND counter: `firmware_instruction_version`, bumped whenever the
   desired firmware changes (set, changed **or cancelled**), against
   `firmware_instruction_ack`, which the device echoes. The hold releases while
   `version > ack`. **The poll body always carries `instructionVersion`, and carries
   `update` only when there is one** — that asymmetry is load-bearing: a cancellation
   delivers no instruction, and without a cursor to echo the board could never acknowledge
   it, so the hold would collapse into an immediate-return loop forever.

   It was first written as a level-triggered boolean (`firmwareUpdateState === null`) and
   that was wrong in a way worth remembering: it could not express a re-request while one
   was in flight, a retry of a version the board had already failed, or a cancellation an
   acknowledged board needed to hear about — which meant a board waiting for an eject would
   have flashed a release the operator had already withdrawn. Every other wake on that
   route is an edge-triggered cursor comparison; this one now matches.
2. **Completion is derived, never reported.** There is deliberately no `succeeded` state.
   `recordStatus` clears the desired firmware when the board reports running that exact
   version, as a **compare-and-clear `CASE` inside the single UPDATE** — not a SELECT, a
   decision in JS, and then a write. On the neon-http driver those are two round trips with
   no transaction available, and an operator requesting a new version inside that window
   had their request silently erased: 200 returned, success toasted, nothing pending.

   The `else` branches of that CASE carry **whatever the same report asked for**, not the
   column's old value. Written the other way, a heartbeat carrying both a version and a
   state — the normal shape, since a board sends its version every time — had its state
   overwritten, so progress never landed and the `update_in_flight` guard could never fire.

**Two test traps this increment walked into, both mine, both worth knowing**

- **A poll with no update pending HOLDS for 25 s.** Asserting "nothing was written" by
  polling times the test out instead of answering the question. Use `desiredFirmwareOf()`
  and read the row.
- **`since=1` against a device whose `desiredVersion` is 0** trips the pre-existing
  "since ahead of version" clamp, which delivers immediately by design — so a hold test
  written that way passes whether or not the rule under test is correct.

**Fixtures:** `publishTestRelease` records a `blobPath` with **no object behind it** — fine
for UI specs, useless for the download path. `publishTestReleaseWithBlob` puts real bytes
and registers them for teardown.

**WHERE IT STANDS, AND WHAT TO DO NEXT (written 2026-09-22, end of session).**

The branch is complete against its plan and has been through **two whole-branch review
rounds**. Round one found fourteen findings; round two found seven more, **two of which were
regressions round one's own fixes introduced** — so a third pass over the round-two fixes is
the next thing, before any merge. That is not pessimism: each round so far has found real
defects in the previous round's fixes, and there is no evidence yet that it has stopped.

Round two's fixes, in case a fresh session needs the shape of them: the completion `CASE`
was clobbering the state carried by the same heartbeat; a cancellation moved the cursor but
sent nothing to acknowledge, so the hold collapsed into an immediate-return loop; the lockout
counter never decayed; `content-length` came from a row rather than the bytes; the tick read
had become two queries; and the Update button could post an empty batch.

**Known and NOT fixed**, deliberately, each with a reason:
- **The e2e suite writes to the live global `firmware_releases`.** During a run its rows are
  the newest release the product compares every board against. The real fix is a separate
  database for the suite (Neon branching) and it is its own increment. It is bounded today
  because no real board reports `updateProtocol`, so `refuseTarget` refuses every one of
  them — a `channel` column was written to close this and then reverted, because any guard
  strong enough to protect a real board also blocks the simulated one that tests the feature.
- **The 50-device batch cap has no UI counterpart** — it surfaces as a generic toast.
- **The confirm dialog is a third hand-rolled modal**, missing `role="dialog"`,
  `aria-modal`, Escape-to-close and the portal that `delete-user-dialog.tsx` has.

**What increment 2b owes:** the firmware. A/B flash slots, the download, signature
verification against the compiled-in public key, anti-rollback on the `sequence` this
protocol already sends, refusing to flash while a disk is mounted (the device must enforce
this itself), and reporting the four states. Then a real board on the bench, which is the
only acceptance that counts. The per-device auto-update opt-in (**default OFF**, ruling
2026-09-13) is still not built and still not needed: every update here is a human pressing
a button.

### 3ai. The firmware version identifies a build, and the registry knows what is current — DONE 2026-09-22

Increment 1 of 2 toward the operator's request for in-app firmware updates. Spec:
`docs/superpowers/specs/2026-09-22-firmware-release-registry-design.md`. Plan:
`docs/superpowers/plans/2026-09-22-firmware-release-registry.md`.

**Why it is only half.** The operator asked for a pending-upgrade callout in Devices and a
multi-select Update button. **The board has no way to update itself** — there is no OTA path
in the firmware at all: no second flash slot, no image download, no verify-and-boot, no
rollback. `config_store.c` and `token_store.c` each write a single 4 KB sector and that is
the entire extent of flash-writing code. So this increment is the half that can be built and
verified with zero risk of bricking a board, and that makes the other half safe to build.
**There is deliberately no Update button.** A control that cannot work is worse than none.

**What shipped**

- **`FIRMWARE_VERSION` is gone.** It was a hand-set CMake cache string and had read
  `4b.0`/`4b.0-dev` through the display work, the capture work, the decoder, SEL0 gating and
  all three write-back pieces. `FIRMWARE_SEMVER` (`1.0.0`, hand-set, **not** a CACHE
  variable) plus `cmake/gen_version_header.cmake` now produce `1.0.0+g<hash>`, regenerated
  on **every build** rather than at configure time.
- **Every heartbeat carries it.** `dc_report_status` gained a `firmwareVersion` field;
  `devices.firmware_version` stops being write-once. Status body budgets moved to
  `device_client.h` and widened 512/1024 → 640/1152 (the old 512 would have overflowed at a
  maximal body, and `dc_report_status` fails **silently** on overflow — the heartbeat would
  just have stopped whenever an error string was long).
- **`firmware_releases`** (migration 0017), **global rather than org-scoped**, with a
  server-assigned monotonic `sequence`. "Is this board behind?" is a registry lookup, never
  a version comparison — a dirty bench build of `1.0.0` compares EQUAL to released `1.0.0`
  and differs only in the git suffix.
- **`pnpm firmware:keygen` / `pnpm firmware:publish`.** ed25519, private key at
  `~/.webadf/firmware-signing-key` (0600), public key committed under
  `wifi-floppy/firmware/keys/`. The key id is a **fingerprint of the key**, not a date.
- **Devices tab**: a notice band when any board is behind, and a per-card firmware line with
  five states — `unknown`, `no releases published`, `unrecognised build`, `up to date`,
  `N releases behind`. **`/admin/firmware`** lists releases read-only.

**Gates:** 956 vitest, 2,467 firmware host checks + 8 version-header checks, `pnpm build`
clean, **300/300 Playwright**.

**THE SIGNATURE IS RECORDED AND VERIFIED BY NOTHING.** No code checks it until increment 2
compiles the public key into the firmware. It is stored from the first release so increment
2 adds a check rather than re-signing a registry's worth of history. `/admin/firmware` says
`signed <keyid> (unverified)` out loud rather than implying a check with a padlock.

**What the whole-branch review caught — the fifth branch in this repo where it was the only
pass to find a Critical.** Per-task reviews passed clean; these were all composition:

- **CI was publishing mislabelled artifacts.** `.github/workflows/firmware.yml` still passed
  `-DFIRMWARE_VERSION`, which this branch deleted. **CMake answers an unused `-D` with a
  warning and exit 0**, so every CI build compiled `1.0.0+g<hash>` while the manifest — the
  thing that workflow's own header calls "THE POINT" — recorded a `git describe` string. It
  now reads the version out of the built header.
- **The dirty/identity test was repo-wide.** `git status --porcelain` and `rev-parse` ignore
  `WORKING_DIRECTORY`; they need a pathspec. So any uncommitted web-app file stamped the
  firmware `-dirty` and unpublishable, and an app-only commit produced a new firmware
  version for a byte-identical image. Both are `-- .` scoped now. **Gitignoring `.vscode/`
  had been treating one instance of an unbounded class** — `next dev` rewrites a block into
  the *tracked* AGENTS.md, which no ignore can cover.
- **`stat -f %m` is BSD-only** and CI is ubuntu. The check it guards would have failed the
  job or passed vacuously.
- **e2e seeded the GLOBAL registry at max+1**, making a fake release the newest one
  production compared every real board against **for the whole run** — including a
  `security: true` row, i.e. a fabricated security banner on the operator's real Devices
  page. The only cleanup was the *last* statement of a teardown whose catch merely warns.
  Now: swept first in its own try, again per spec file, and the insert is idempotent.
- **`+nogit` passed the "unidentifiable build" rule**, which matched only `-dirty`. It is the
  worse of the two: a dirty build at least names its base commit.
- **The blob uploaded before any rule ran**, with `allowOverwrite: false` — so a fixable
  refusal permanently wedged a version derived from the commit hash. Decide first now.
- **`--dry-run` exited before the rules**, so it could not report the refusal the real
  publish would hit; and **a typo'd `--dry-run` did a real, irreversible publish**. Both
  closed by `util.parseArgs`.
- **The signing key id came from `new Date().getFullYear()`**, computed independently at
  keygen and at publish — agreeing only within one calendar year.
- **The notice named a semver**, which two releases may share, so it could tell you that you
  were behind the version your own card said you were running.
- **The security flag read only the newest release**, going quiet for exactly the boards
  still missing a fix when an ordinary release followed a security one.
- **An empty registry called every board an unrecognised build** — the state this ships in.
  `unavailable` is now its own state.
- **`dc_register` truncated the version at 31 characters** against the new 64-character
  contract, so a long version registered short and changed on the first heartbeat.
- **Publishing never refreshed an open Devices tab**: the registry was not in the live
  fingerprint, though the plan asserted the opposite.

**Traps worth knowing**

- **`pnpm db:push` offered to TRUNCATE `disk_versions`** to add `disk_versions_disk_seq` — a
  constraint that **already exists**, on a table holding real Amiga write history. Measured:
  zero duplicate `(disk_id, seq)` pairs, constraint present. Migration 0017 was applied as
  the generated `CREATE TABLE` alone. **Read what push proposes before answering.**
- **The empty-registry case is covered in vitest, not e2e, deliberately.**
  `firmware_releases` is global and shared with real data: no spec can create an empty
  registry, and once a genuine release exists it never is one again.
- **There is no `/api/admin/firmware/releases` route.** The spec's §3.4 said POST; an admin
  route is guarded by a session cookie and there is no honest way to hand a CLI one, while
  the script already holds `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` — strictly more
  authority. It would have added a hop and an auth problem without adding a control.

**What increment 2 owes:** A/B flash slots, signed image download with the public key
compiled in, anti-rollback on `sequence`, never flashing while a disk is mounted, step-up
password auth per update, the per-device opt-in (**default OFF**, per the operator's ruling
of 2026-09-13), the prompt at pairing, and the multi-select Update button the operator
actually asked for. Read the backlog entry above — it carries the threat model.

### 3ah. The library reaches the history, and the category cards show what is in them — DONE 2026-09-21, merged and live

Three operator requests from the same morning, after piece 3 (§4l) shipped. No spec and no plan:
each is a single component plus, in one case, a query.

**The history is one click from the gallery.** A disk's version history was four steps away --
open the title, find the disk, Browse, scroll. Every **single-disk** library card now carries a
clock-and-arrow button that lands on `/disks/<id>/files#disk-history`; the panel anchors that id
and carries `scroll-mt-20` so its heading clears the header instead of tucking under it. Offered
only on single-disk titles for the reason the inline rename already gives: `diskId` is a `min()`
aggregate and "which disk's history?" has no answer on a multi-disk set. The operator confirmed
that scope ("do it for single disk titles for now").

**Remove-from-collection became a minus** in the card's footer row, immediately left of the
delete icon and sharing its subdued `--faint` resting colour, instead of a red circled X floating
over the cover art. The destructive pair still goes red on hover; the history control does not.

**All three controls are BUTTONS, including the history one that is really a navigation.** The
card is an `<a href>`, and an anchor inside an anchor is invalid HTML that browsers repair by
closing the outer one early -- which would break the card around it. The cost is no
middle-click-to-new-tab on that icon, which the operator accepted explicitly. Each control stops
its pointer events before they reach the card's link or dnd-kit's drag listeners, exactly as the
inline rename field does.

**The wordmark links to `/library`.** Every other shell had an explicit way back; the app shell
had only the nav pill, and the mark is where people click first. The admin shell's wordmark is
deliberately left alone -- it already has "Back to library".

**The category cards are square, with a mosaic of what is filed in them.** The overview (what an
empty inbox falls through to -- exactly the tidy-library state the operator was describing) now
shows each collection as a square whose face is up to four covers of its titles, name and count
over a scrim so the shape survives a long name. The cases that are not a neat four were each
decided by rendering them and looking:

- **1 cover fills the square.** One picture is a picture, not a broken grid.
- **2 or 3 tile a 2x2, and the empty cells show ONE continuous gradient** behind the whole
  mosaic rather than a gradient each. Per-cell hues beside two real covers read as noise.
- **0 is the plain gradient**, the app's own "no image" look (`Cover`), so a collection of
  unidentified titles looks intentional rather than half-loaded. **That is the common case**:
  OpenRetro recognises 6.6% of the archive (3d).

It looks THROUGH unidentified titles rather than stopping at them -- up to 12 members are
considered to find 4 covers -- because a collection whose first few happen to be unrecognised
would otherwise show an empty mosaic while the fifth has perfectly good box art.

**One ranking, not two.** `coverUrlsForGames` was extracted from `withDerived` (src/lib/queries.ts)
so the mosaic and the game cards choose a cover the same way; two rankings would tile a collection
with art its own title cards do not show. Cost: **two queries per page whatever the number of
collections**, bounded by the candidate cap, and only on the overview -- every other view renders
the game cards, which carry their own covers.

The choosing is pure, in `src/lib/collection-mosaic.ts` with its own tests, following
`collection-order.ts`'s split: rules deserve tests that do not need a database.

**Gates:** 911 unit tests, build clean, 290/290 Playwright. The two new e2e tests were each proved
non-vacuous by breaking what they cover (the history control rendered null: the card test fails on
the missing element; the mosaic query short-circuited: 3 tiles vs 0). The mosaic test also asserts
the browser decoded real pixels -- an `<img>` element is not a picture -- and measures the card
square rather than reading its class list.

**Watch this if you make the disk files page taller:** `mobile.spec.ts`'s press-and-hold drag
broke when the History panel made that page scrollable, because dnd-kit auto-scrolls near a
container edge and a scripted drag cannot chase a target that moves 174px mid-gesture (§4l). It
is the canary for that whole class of change.

### 3ag. Live device state in every open browser — DONE 2026-09-20, merged to `master`

Spec: `docs/superpowers/specs/2026-09-19-live-device-state-design.md`. Plan:
`docs/superpowers/plans/2026-09-19-live-device-state.md`. Asked for after the operator saw two
computers disagree about what was mounted until one of them was reloaded.

**What shipped.** `src/lib/live-state.ts` builds a **fingerprint** of the org's device state --
16 hex of a sha-256 over one canonical line per device -- served by `GET /api/live-state`
(session-scoped; a missing session answers 401, never a redirect, because `fetch` would follow
the redirect and hand LiveRefresh the sign-in page's HTML). `src/components/shell/live-refresh.tsx`
sits in the `(app)` layout, polls it, and calls `router.refresh()` when it changes, so every page
re-renders through its own existing server code. No page grew a second, client-side copy of the
state.

**The fingerprint covers exactly what the pages render**, which took two review rounds to get
right: desired/mounted disk ids, digests and versions, `deviceState()`, the disk's own `sha256`
and `writeProtected` (a board's write moves the disk digest before the device row follows),
`lastError`/`lastErrorAt`, the device name, `firmwareVersion`, an `online` bit, and -- for a
stale device -- the exact "last seen 5m ago" text the card draws. `lastSeenAt` itself is NOT in
it (it moves every 25 s); only what the pages derive from it, so the fingerprint changes when,
and only when, a page would look different.

**Two bugs the reviews caught, both of which would have been invisible in use:**
- The old per-page 5 s timer on `/devices` and `/games/[id]` was the only thing refreshing
  `lastError` and the header's online count. Deleting it (one mechanism, not two) would have
  left a board error sitting unseen until a manual reload; the fingerprint gained those fields
  in the same change.
- The poller used its own first fetch as the baseline, so a change landing between the server
  render and that fetch was folded into the baseline and never shown. The baseline now comes
  from the server render itself (`initial` prop), and an e2e holds the first poll response for
  3 s while making a change to prove it.

**Rate (operator, 2026-09-20):** 3 s while the tab is in use, 30 s after ten minutes without
input; any input -- including mouse movement -- or returning to the tab polls at once and
restores 3 s. A visible tab polled around the clock otherwise: ~1,200 requests an hour, each a
session lookup plus a query, keeping Neon awake for a tab nobody was looking at. The rule is the
pure `src/lib/live-poll.ts`; the e2e drives active → idle → input → fast with Playwright's fake
clock rather than waiting ten minutes.

**Known and accepted:** a game renamed while a device is pending on it is not watched (§6 of the
spec); `AbortSignal.timeout` needs Safari 15.4+ (older browsers simply never poll -- the page
still works); the layout runs one extra query per full render to compute `initial`.

**Gates:** vitest 875, build clean, full Playwright 283/283.

## Known accepted risks

- **`/api/ingest/check` is a global cross-tenant existence oracle**, and an entitlement is
  granted on digest knowledge alone (26+ blobs are already shared across orgs). That global
  check is load-bearing — it *is* the cross-tenant dedupe. Registration is invite-only
  (D13) to bound who can exploit it.
- **The device image endpoint (`GET /api/device/image/<sha256>`) is now live, and it is
  the download route the line above used to warn about re-examining.** It checks that the
  device's organization holds an entitlement for the requested sha256, which is the
  correct boundary against a compromised device — but it does not close the ingest oracle:
  a client who merely knows a published TOSEC hash can claim it, mount it to their own
  device, fetch the `WFMF`, and `decodeDisk` it straight back into a pristine ADF. **Ruled
  (operator, decided): ship it anyway.** The only thing bounding this is D13 — invite-only
  registration — and every account on this deployment is invited by the operator. The known
  fix if registration is ever opened is proof-of-possession at ingest (a random byte-range
  challenge on the already-exists path); **do not open registration without it.** Full
  reasoning in `2026-08-29-device-plane-disk-change-design.md` §6.
- Spec §5's wording was corrected: an entitlement *records a claim*, it does not *prove*
  possession.
- **CSRF on mount and eject rests entirely on Better Auth's default `SameSite=Lax` session
  cookie. There is no origin check on either route.** Lax is sufficient today: both routes
  are `POST` with a JSON body, so a cross-site form post cannot reach them and a cross-site
  `fetch` sends no cookie. What makes this worth writing down is how narrow the margin is —
  **configuring `crossSubDomainCookies`, or `sameSite: 'none'`, silently removes the only
  thing defending these two routes**, and an unasked eject is precisely what disk-change
  spec §1 rule 1 forbids. Either change means adding an explicit origin check first. Both
  `src/app/api/devices/[id]/mount/route.ts` and `.../eject/route.ts` carry this as a header
  comment so it is found by whoever touches the route rather than only by whoever reads this
  file. Plan 3b did not close it.

---

## Known firmware defects — both fixed in plan 4a

Found while building the encoder and its device-image endpoint. Both are now fixed on
`feat/device-firmware`; kept here as history since the design docs (encoder spec §7, plan
4a spec §8) refer back to them.

1. **Latent buffer overflow — FIXED.** `image_loader.c` used to accept a track payload up
   to `TRACK_SLOT_BYTES` (13,312 bytes), while `track_cache.c` copied it into an SRAM
   buffer of `TRACK_MFM_MAX` (13,000 bytes) — a 312-byte overflow for any track over
   13,000 bytes. Our tracks are 12,668 bytes, under both, so this was latent rather than
   live in production. The two constants are now one: `TRACK_MAX_BYTES` (13,312), with the
   SRAM staging buffer grown to match rather than the accepted maximum lowered.
2. **Revolution timing — still accepted, not a defect.** `BITCELL_NS` is 2,000 ns against
   a true Amiga bitcell of 1,973.6 ns, giving ~296 RPM against a nominal 300. Accepted —
   the Amiga's PLL locks to sync marks, not a stopwatch, and real drives vary by more than
   this. A one-line `clkdiv` trim in `flux_out_program_init` if plan 5 hardware bring-up
   ever says otherwise.
3. **`bit_count` overflow accepted a bogus image — FIXED.** `image_loader.c:51` used to
   compute `payload_bytes = (bits + 7) / 8` on a `uint32_t`; a `bit_count` at or above
   `0xFFFFFFF9` wrapped the addition to `payload_bytes = 0`, sailing past the
   `> TRACK_SLOT_BYTES` guard. Every track then parsed as present with a nonsense bit
   count, and `psram_image_missing_count()` returned 0 — the firmware would have presented
   a disk of empty tracks instead of refusing the image. `bits` is now bounded *before*
   the arithmetic.
   **`src/lib/adfmfm/firmware-parser.ts` no longer reproduces this** — it was updated in
   the same change as the firmware fix, since the mirror's job is to model what the device
   *actually* accepts, and the device no longer accepts this. The old instruction to never
   "fix" the mirror was correct only while the firmware itself was broken; it is inverted
   now. `readWfmf`, webadf's own reader, was already hardened against this and remains so.

---

## Known gaps in e2e test cleanup

`e2e/device-helpers.ts`'s `cleanupSeeded` (added in plan 3a Task 3b) keeps every device,
disk, game, entitlement, blob and pairing-code row this plan's specs create from
accumulating on the live database — verified by running the growth on and off and watching
the row counts. Two gaps remain, both known and accepted rather than accidental:

- **The `auth` schema's `user` and `organization` rows are not cleaned up.** Better Auth
  owns those tables, and tearing them down from an e2e helper is a larger change than this
  plan took on.
- ~~**`ingest-api`, `ingest-ui` and `library` specs still seed without cleanup.**~~ **CLOSED
  2026-09-01.** They create their rows through the REAL ingest flow, so no helper ever learned
  the ids — `cleanupSeeded` now reaches them from the other end, purging the whole catalog of
  every org `signUpFresh` made in that file. `signUpFresh` registers its own org (a plain array
  in `helpers.ts`, which must never import anything reaching `@/db` — `loadEnvLocal()` runs
  after imports are hoisted), so a spec cannot forget to opt in.

  **The safety boundary is still the email domain, and it is now enforced in SQL rather than
  assumed:** an org is purged only if it has at least one member and *every* member is
  `@example.test`, decided from `auth."member"` joined to `auth."user"` with bound parameters.
  An org id that reached the list without being a test org is skipped, not trusted.

  Blobs are reclaimed the same way `global-teardown` does it — only shas nothing anywhere still
  references, bytes removed before the row — because a blob is global and content-addressed and
  may be shared with the operator's real library.

  **Verified by running those three files with `globalTeardown` removed**, so only the per-file
  cleanup could act: 15 tests passed and `games`/`disks`/`entitlements`/`blobs` all finished at
  exactly their starting counts (6/11/11/11). The same run took `auth."user"` from 2 to 18,
  which is the gap above and is still `global-teardown`'s job.

---

## How this work has been running

Every plan since plan 1 has followed the same loop, and it is worth continuing: brainstorm to
a spec, `superpowers:writing-plans` to a task-by-task plan, then
`superpowers:subagent-driven-development` — a fresh subagent per task, a reviewer after each,
a fix round with a mutation proof, and one whole-branch review at the end.

Three things about it have earned their place:

- **Watch every test fail before making it pass.** On plan 3b this caught two tests that
  passed against a page that did not exist yet — both asserted only an absence.
- **Prove each fix with a mutation.** Break the code, watch a *named* test fail, revert. A
  fix without one is a claim.
- **Tell an implementer to stop and escalate rather than weaken a test.** It did exactly that
  once, and was right when I was wrong — see T6-5 in the 3b rulings.

Across plans 1, 2, 3a and 3b, essentially every defect found was in **plan text**, not in
implementer work on correct instructions. Several of the fix instructions were themselves
wrong and were caught by implementers who said so. Budget review time accordingly: the plan is
the risky artifact, not the code.

---

## Verification standard that has been paying off

Twelve defects were found across both plans. **All twelve were in the plan text I wrote;
none were implementer error on correct instructions.** Five were tests that passed while
testing nothing. Two were silent-fallback bugs where nothing errored and the screen looked
fine (a font rendering as Times; an API 400 rendering as success).

What reliably caught them: **breaking the code and watching the test fail to notice**,
rather than reading the test and judging it. And **verifying against the installed package**
(`node_modules`, real `.d.ts`, live probes) rather than the published docs — that changed
the design three separate times. Keep doing both.

---

## Before you touch the firmware again

The rulings taken during plan 4a — including three corrections to my own plan text on the
`Content-Length` fixtures, the pico-sdk version pin, the toolchain PATH requirement, and a
dozen deliberately deferred minor findings by file/task — are in
`docs/decisions/2026-08-30-device-firmware-rulings.md`. It also records two "green
suite/build proved nothing" incidents (Task 7's unexercised jitter, Task 9's TLS stack
that built green without linking any of its own code) worth knowing before trusting a
firmware gate at face value.
- (Task 3, at the time still open) `main.c` called `dskchg_image_inserted()`
  unconditionally while no image was ever loaded. **This was fixed within plan 4a**
  (Task 10) via `track_cache_check_swap()`; listed here only because it was flagged as a
  must-not-ship-this-way item and the record should show it was closed, not dropped.

The rulings taken on the operator's behalf while executing plan 4a — including the
pico-sdk version pin, the toolchain PATH requirement, and several corrections to the plan
text itself — are recorded in `docs/decisions/2026-08-30-device-firmware-rulings.md`,
following the same pattern as the existing rulings files below.

## Before you touch provisioning again

The rulings taken during plan 4b — all 8, plus 6 deferred minor findings by file/task and
the hardware-only list carried to plan 5 — are in
`docs/decisions/2026-08-31-device-portal-rulings.md`. **Read its "Ruling 8 and its
correction" section before touching `DC_HALTED` or the poll 404 handling in `main.c` again**:
a fix for a real, well-reasoned bug (a revoked-token board could never recover without a
reflash) shipped wider than its own justification and, for one review round, would have
erased every deployed board's token on the first infrastructure 404 rather than only on a
confirmed deleted-device response. Both the original ruling and the correction are recorded
in full, because the pattern — a sound fix landing wider than its reasoning — is worth
recognizing the next time a "this trigger is not transient" argument gets made.

---

## Reference

- **Parent spec (binding authority):** `docs/superpowers/specs/2026-08-23-webadf-design.md`
  — 17 decisions
- **Encoder spec:** `docs/superpowers/specs/2026-08-29-adfmfm-encoder-design.md` (D15)
- **Disk-change spec:** `docs/superpowers/specs/2026-08-29-device-plane-disk-change-design.md`
  (D17) — supersedes the parent spec's §7 device protocol; UI design lives in its §7
- **Plan 1 (done):** `docs/superpowers/plans/2026-08-24-webadf-foundation-library.md`
- **Plan 2 (partial — see "Where things stand"):**
  `docs/superpowers/plans/2026-08-29-webadf-device-plane.md`
- **Encoder plan (done):** `docs/superpowers/plans/2026-08-29-adfmfm-encoder.md`
- **Plan 3a — device protocol (done):**
  `docs/superpowers/plans/2026-08-29-device-protocol-disk-change.md`
- **UI spec:** `docs/superpowers/specs/2026-08-30-device-ui-design.md` — expands the
  disk-change spec's §7. **§4 was revised during implementation**; the reasoning is in it
- **Plan 3b — UI (done):**
  `docs/superpowers/plans/2026-08-30-device-ui.md`
- **Firmware protocol spec — plan 4a (done):**
  `docs/superpowers/specs/2026-08-30-device-firmware-protocol-design.md` — see its "What
  plan 4a delivered" section for the shipped/not-shipped split
- **Plan 4a — firmware protocol plane (done, merged to `master`):**
  `docs/superpowers/plans/2026-08-30-device-firmware-protocol.md`
- **Provisioning portal spec — plan 4b (done):**
  `docs/superpowers/specs/2026-08-30-device-provisioning-portal-design.md` — see its "What
  plan 4b delivered" section for the shipped/not-shipped split
- **Plan 4b — provisioning portal (done, merged to `master`):**
  `docs/superpowers/plans/2026-08-30-device-provisioning-portal.md`
- **Decision log:** `docs/decisions/` — rulings taken during implementation. The SDD ledgers
  under `.superpowers/` are **gitignored and do not survive a session**, so anything worth
  keeping was copied here: `2026-08-24-foundation-rulings.md`,
  `2026-08-29-device-plane-rulings.md`, `2026-08-30-device-ui-rulings.md`,
  `2026-08-30-device-firmware-rulings.md`, `2026-08-31-device-portal-rulings.md`
- **`adfmfm` module:** `src/lib/adfmfm/README.md`
- **Firmware contract:** `INTEGRATION.md` and `wifi-floppy/firmware/src/image_loader.c`
- **Firmware itself:** `wifi-floppy/firmware/` — see `wifi-floppy/README.md` for build
  requirements (pico-sdk ≥ 2.3.0, the official ARM GNU Toolchain) and its "Honest caveats"
  for what has and has not been verified
- **UI design:** `design/*.dc.html` artboards; canvas at
  https://claude.ai/code/artifact/fc7949f0-bdf8-4c7b-aedf-9d6712093e8b

**Commands:** `pnpm dev` · `pnpm vitest run` · `pnpm e2e` · `pnpm build` ·
`pnpm adfmfm:diff` (Greaseweazle differential gate, needs `adf-archive/` + pipx) ·
`pnpm adfmfm:fixtures` (regenerate golden fixtures) ·
`pnpm db:generate && pnpm db:push` · `npx webadf push <dir>` (CLI bulk import) ·
`pnpm firmware:build` (needs pico-sdk ≥ 2.3.0 on `PICO_SDK_PATH` and the official ARM GNU
Toolchain on `PATH`, not homebrew's `arm-none-eabi-gcc`. `PORTAL_AP_PASSWORD` is **no longer
required** — it has a documented default, `wififloppy`; it is fatal only if set-but-empty) ·
`pnpm firmware:test` (plain-C host suite, clang, no SDK/toolchain/env vars needed — 2,467
checks across 13 binaries, plus 8 shell checks for the version header) ·
`pnpm firmware:keygen` (once, ever — writes `~/.webadf/firmware-signing-key` 0600 and the
public half into `wifi-floppy/firmware/keys/`; refuses to overwrite) ·
`pnpm firmware:publish [--notes "..."] [--security] [--dry-run]` (signs and records a
release; reads the version out of the built header, never an argument)

**Infrastructure:** Vercel project `webadf` · Neon Postgres (`auth` + `public` schemas) ·
Vercel Blob store `webadf-disks` (**private** access) · Vercel CLI 59.10.0
