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

**Written 2026-08-29, rewritten 2026-08-30 after plan 3b, rewritten again 2026-08-30
after plan 4a, rewritten again 2026-08-31 after plan 4b.**

| | Status |
|---|---|
| **Plan 1 — foundation & library** | ✅ merged to `master`, in production |
| **Plan 2 — device plane** | ✅ tasks 1–4 done; **6–8 superseded** by plan 3a, not pending |
| **MFM encoder (`adfmfm`)** | ✅ **done** — byte-identical to Greaseweazle across all 61 archive disks (9,760 tracks) |
| **Plan 3a — device protocol** | ✅ done, merged to `master`, pushed |
| **Plan 3b — device UI** | ✅ **done, all 7 tasks, merged to `master`** |
| **Plan 4a — firmware protocol plane** | ✅ **done, merged to `master`, pushed.** Firmware compiles and has a green host suite. |
| **Plan 4b — captive portal** | ✅ **done, all 8 tasks.** Compile-time WiFi/pairing-code defines are gone, replaced by an AP-mode portal. Merged to `master` and pushed. |
| **Plan 5 — hardware bring-up** | 🔵 **started 2026-09-10.** The captive portal runs on a real board: RM2 radio up, AP raised, DHCP/DNS/HTTP serving the form, iOS raising the sign-in sheet by itself. Everything past pressing Save, and the whole floppy side, is still unrun; see 3x |
| **Super-admin plane** | ✅ **done, all 6 tasks, merged to `master` and live in production.** `/admin`: overview, user list with cascade delete, invites |
| **TOSEC identity scan** | ✅ **done, 12 tasks, merged to `master`.** `/admin/scan`: DAT import, hashing, matching, backfill |
| **OpenRetro enrichment** | ✅ **done, all 9 tasks, merged to `master` and live in production.** Enriches 6.6% of the real archive against TOSEC's 45.9%; see 3d |
| **e2e cleanup** | ✅ **done, merged and live 2026-09-01.** A run no longer leaks; 4,600 accumulated rows and 73 live invite codes swept; see 3e |
| **User-defined collections** | ✅ **done, all 9 tasks, merged to `master` and live in production.** A rail on `/library`, drag to file and to reorder; migration 0011 applied; see 3g |
| **Library covers, type pills, contrast** | ✅ **done, merged and live 2026-09-01.** Grid shows real cover art; grid and table both show a TOSEC-derived type; the grey ramp now passes WCAG AA |
| **Shell polish** | ✅ **done 2026-09-02.** The "/" hint, both navs centred on the viewport, zebra-striped file tree, and a navigation bar + scrim; see 3i |
| **Mobile responsive** | ✅ **done 2026-09-02, all surfaces.** Usable at 390px; nav becomes a bottom bar, touch drag no longer eats scrolling; see 3j |
| **Delete a title or a disk** | ✅ **done 2026-09-04.** Confirmation dialog, deliberate eject, blob never destroyed; see 3o |
| **Disk space on the browse page** | ✅ **done 2026-09-04.** Read from the allocation bitmap, agreeing with xdftool on 46 of 46 real disks; see 3p |
| **Create a blank ADF** | ✅ **done 2026-09-03.** A real formatted disk from a button, named inline; migration 0013 applied; see 3n. File add/edit/delete is NOT part of it |
| **Create ADF is one menu** | ✅ **done 2026-09-04.** One dropdown with FFS and OFS items replaces the sticky select plus button; the filesystem is no longer remembered between disks; see 3t |
| **Files inside an ADF** | ✅ **done 2026-09-04.** Add, delete, rename, replace contents, make and remove directories, through the browse page; every operation checked against xdftool rather than against our own reader; see 3u |
| **Drop a folder in, drag to rearrange** | ✅ **done 2026-09-05.** Drop from the OS into a staging area that checks fit in BLOCKS before writing; one commit, one blob; drag or keyboard to move entries between folders; see 3v |
| **Deleting the last disk no longer 404s** | ✅ **done 2026-09-05.** Navigates on the server's own `gameDeleted`, replaces rather than pushes, and goes where the breadcrumb points; see 3w |
| **Drag and drop inside an ADF** | ✅ **done 2026-09-05, all 11 tasks, on `feat/adf-drag-drop`, not merged.** Drop a folder from the OS to stage and batch-commit it as one blob; drag or keyboard-move an entry between directories; a cycle refusal our own reader cannot see the need for; see 3v |
| **Edit a title by hand** | ✅ **done 2026-09-03.** Per-group authority, and a scan never silently undoes an edit; see 3m |
| **Unified breadcrumb** | ✅ **done 2026-09-03**, and 2026-09-04 it follows the collection you came from; see 3l and 3r |
| **Image layout shift** | ✅ **done 2026-09-03.** The game page's cover and screenshots reserve their space; the library grid never had the bug; see 3k |
| **Typeahead search** | ✅ **done, all 7 tasks, merged to `master` and live in production.** A Spotlight-style pill in both shells; migration 0012 applied; see 3h |
| **Read-only ADF filesystem reader** | ✅ **done, all 10 tasks, `feat/adf-filesystem-reader`.** Reads 80.3% of the archive (49/61) against TOSEC's 45.9% and OpenRetro's 6.6%; see 3f |
| **Hardware** | rev A scrap (mirrored), **rev A2 in hand and working**, **rev B is current and unfabricated** — keepout moved to the antenna end, a silkscreen that carries lettering, D1 polarity marked. Respin deliberately on hold until a board is known to work; see 3s and 3x |

**Current branch:** `master`, clean and pushed. Everything below is merged and live in
production. **Plan 5 (hardware bring-up) is under way as of 2026-09-10 — see 3x.** The first PCB came back
**mirrored** and a corrected revision was ordered on 2026-09-04, so bring-up cannot start before
the week of **2026-09-08** — and nothing in plan 4a or 4b has ever run on real silicon.

**Next, at the operator's direction (2026-09-03):** the breadcrumb (3l) and editing a title by
hand (3m) are both DONE. Remaining is **propagating a write-protect flip to a device that
already has the disk mounted**, specced as a backlog entry in §4. Take it with a board on the
desk — its flag is inert until write-back exists, so it is
only observable on hardware, and it needs a protocol answer for "same disk, changed flag" rather
than a version bump that would force an unrequested ~2 MB re-fetch and remount.
**Suite on `master`:** 464 vitest, `pnpm build` clean, **206 Playwright** — 201 desktop at
1280×720 and 5 mobile at 390×844; `playwright.config.ts` now has two projects.

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
(`teardown: removed N test users...`) before re-running anything. Firmware: `pnpm firmware:test` green (506 checks, 13
binaries), `pnpm firmware:build` produces a `.uf2` — **and now requires
`PORTAL_AP_PASSWORD` set in the environment, or the configure step fails by design**; see
"Plan 4b" below for the full command.

**The whole web side is built, the firmware compiles and passes its own host suite, and
provisioning is no longer compile-time.** The only thing left before hardware bring-up is
plan 5 itself — nothing in plan 4a or plan 4b has been exercised on a real board. See "What
to do next" below.

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

      ((o)) LOADED              [lemming]
      Sensible Soccer
      Disk 1/2 Boot        12/79

  A wifi glyph with signal strength; a status word; the disk name wrapped over two
  lines at a word break; the track counter as "0/79"; and a walking lemming in the
  top-right. The counter is drawn BEFORE the detail label beside it and the label is
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
- **Propagate a write-protect flip to a device that already has the disk mounted.** Requested by
  the operator 2026-08-31, and it is part of the design's intent rather than a new feature. It
  does not work today, and the reason is specific: `PATCH /api/disks/[id]` updates only
  `disks.write_protected` — it does **not** bump `devices.desired_version`. The long-poll is
  version-gated (`version > clampedFrom` in `src/app/api/device/poll/route.ts`), so a board
  holding that disk sits in its 25 s poll and never learns the flag changed.

  **The fix is not simply "bump the version", and that is the part worth knowing before planning
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
`pnpm firmware:build` (needs pico-sdk ≥ 2.3.0 on `PICO_SDK_PATH`, the official ARM GNU
Toolchain on `PATH` (not homebrew's `arm-none-eabi-gcc`), **and `PORTAL_AP_PASSWORD` set in
the environment to a WPA2 PSK — the configure step fails by design otherwise**; see "Plan
4b" above for the full command) ·
`pnpm firmware:test` (plain-C host suite, clang, no SDK/toolchain/env vars needed — 506
checks, 13 binaries)

**Infrastructure:** Vercel project `webadf` · Neon Postgres (`auth` + `public` schemas) ·
Vercel Blob store `webadf-disks` (**private** access) · Vercel CLI 59.10.0
