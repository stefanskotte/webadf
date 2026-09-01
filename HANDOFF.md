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
| **Plan 5 — hardware bring-up** | ❌ not started, the only piece left. **Nothing has run on real hardware** — boards are still in transit and nothing in 4a or 4b has been exercised on one |
| **Super-admin plane** | ✅ **done, all 6 tasks, merged to `master` and live in production.** `/admin`: overview, user list with cascade delete, invites |
| **TOSEC identity scan** | ✅ **done, 12 tasks, merged to `master`.** `/admin/scan`: DAT import, hashing, matching, backfill |
| **OpenRetro enrichment** | ✅ **done, all 9 tasks, merged to `master` and live in production.** Enriches 6.6% of the real archive against TOSEC's 45.9%; see 3d |
| **e2e cleanup** | ✅ **done, merged and live 2026-09-01.** A run no longer leaks; 4,600 accumulated rows and 73 live invite codes swept; see 3e |
| **User-defined collections** | ✅ **done, all 9 tasks, merged to `master` and live in production.** A rail on `/library`, drag to file and to reorder; migration 0011 applied; see 3g |
| **Library covers, type pills, contrast** | ✅ **done, merged and live 2026-09-01.** Grid shows real cover art; grid and table both show a TOSEC-derived type; the grey ramp now passes WCAG AA |
| **Read-only ADF filesystem reader** | ✅ **done, all 10 tasks, `feat/adf-filesystem-reader`.** Reads 80.3% of the archive (49/61) against TOSEC's 45.9% and OpenRetro's 6.6%; see 3f |
| **Hardware** | boards ordered from JLCPCB |

**Current branch:** `master`, clean and pushed. Everything below, collections included, is
merged and live in production. **Plan 5 (hardware bring-up) is the only unbuilt plan.**
**Suite on `master`:** 310 vitest, `pnpm build` clean, **134 Playwright passed (16.1 min)**. Firmware: `pnpm firmware:test` green (506 checks, 13
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
host-tested only, not hardware-verified, until plan 5 says otherwise. Specifically open,
carried forward verbatim from plan 4b's ledger:

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

### 4. Backlog, not blocking anything

- **A unified breadcrumb, replacing the per-page eyebrow and the hand-written back links.**
  Requested by the operator 2026-09-01: as you drill Library → a game/demo/app → a disk's
  files, the trail should be one consistent, clickable thing. Notes for whoever plans it:

  **What exists today is two conventions and neither is navigation.** `PageHeader`
  (`src/components/shell/page-header.tsx`) takes `eyebrow` as a **plain string** — it renders
  text, never links — and the nine call sites do not agree on what goes in it: `Library /
  Games`, `Library / Disk 2`, `Amiga collection`, `Add disks`, `Hardware`, `Admin`. Only two of
  them are even shaped like a path. Going *back* is a separate, hand-written `<Link>` in the
  `actions` slot, and there are already two different spellings of it — `/games/[id]` says
  "← Library", `/disks/[id]/files` names the entry it returns to. A third drill-down would
  invent a third. **`PageHeader`'s `eyebrow` prop is the seam**: change that one contract and
  every page follows.

  **The one non-obvious constraint: the trail cannot be derived from the data, because a game
  can be in many collections.** `?collection=<id>` on `/library` is a real second axis of
  drill-down now, and a person who opened a game from inside a collection expects to come back
  to *that collection*, not to the unfiltered library. But `/games/[id]` and
  `/disks/[id]/files` carry no collection in their URLs, and reconstructing it from
  `collection_games` is not possible — the join is many-to-many by design. So the breadcrumb
  has to be **carried** (a `?from=` param threaded through the links, resolved against
  `listCollections(orgId)` the same way `?collection=` already is in
  `src/app/(app)/library/page.tsx`), or it has to honestly say "Library" and drop the
  collection. Decide that first; everything else follows from it.

  **The `kind` segment can be real rather than invented.** `src/lib/game-kind.ts` already
  derives Game / Demo / Educational / Coverdisk / App from the TOSEC set that recognised a
  title's disks, and the grid and table both show it. **But it is `null` for everything TOSEC
  did not recognise, which is more than half the archive** (45.9% recognised). A breadcrumb
  that defaults an unknown title to "Game" would repeat the bug fixed on 2026-09-01 in the file
  browser's back link, where the `games` table's vocabulary leaked into the UI and labelled a
  Workbench disk "← Game". An unrecognised title has no kind, and the trail must be able to say
  nothing rather than guess.

  **Two smaller things it must not break:** `TopNav` already marks the active section with
  `pathname.startsWith(item.href)`, so a breadcrumb must not contradict or duplicate it; and
  `/disks/[id]/files` reaches its game only through `disks.gameId`, joined LEFT and scoped on
  `orgId`, because nothing in the schema guarantees `disks.orgId` matches its game's org.

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
- **A rich game detail page** — description, history, screenshots, publisher, "everything".
  Requested by the operator 2026-08-31. **This is Increment C of the TOSEC work, not a UI task**,
  and the distinction matters:

  **TOSEC cannot supply any of it.** A DAT carries a canonical name, year, publisher, disk
  numbering and dump flags — and nothing else. No description, no history, no images. The scan's
  contribution is *identity*, which is precisely what makes enrichment possible: a disk matched to
  a canonical TOSEC entry gives a trustworthy title/year/publisher to look the game up by, instead
  of whatever the uploader called the file. Doing this before the scan existed would have meant
  querying an external database with a filename.

  **The columns are already there and already rendered.** `games` carries `genre`, `chipset` and
  `coverAssetId`, `src/lib/queries.ts` selects all three, and `/games/[id]` already puts `year`,
  `publisher`, `genre` and `chipset` in its subtitle. **Nothing has ever written them** — so the
  page will start showing more the moment something populates them. Description, history and
  screenshots need new columns; screenshots additionally need Blob storage and finally give
  `coverAssetId` a purpose.

  **The source is the open question.** OpenRetro and Hall of Light (abime.net) are the Amiga
  databases worth evaluating. Both bring a network dependency, rate limits, and — for screenshots
  — an attribution and licensing question that should be answered before images are copied into
  this project's storage rather than after.
- ~~**User-defined collections, with drag-and-drop.**~~ **DONE 2026-09-01 — see 3g.** Requested
  by the operator 2026-08-31: make your own categories ("My favorite games - AGA") and move games
  into them. The planning notes below are kept because the constraint they name outlived the
  increment: the "any new table holding a game id" rule now has two tables obeying it, not one.
  The drag-and-drop paragraph's aside about native HTML5 drag turned out to be worse than
  neutral — see 3g.

  **The one non-obvious constraint: the TOSEC scan DELETES `games` rows.** `mergeDuplicates` in
  `src/lib/tosec-apply.ts` collapses two games that resolve to the same `(sortTitle, year)` — it
  moves the disks to a survivor and deletes the absorbed row. It already repoints
  `devices.desiredGameId` and `mountedGameId` for exactly this reason. **Any new table holding a
  game id must be repointed in that same batch**, or a collection silently loses its entry (or
  worse, cascade-deletes it, which is the shape of the Critical bug this branch shipped a fix
  for). That statement list is the first place to look, not an afterthought.

  **Shape:** a `collections` table (per-tenant, with `orgId` — unlike `blobs` and `tosec_entries`,
  which are global because they are content-addressed) and a `collection_games` join carrying a
  sort key, since "drag to reorder" needs an explicit order rather than a derived one.

  **Drag-and-drop is a real dependency decision.** shadcn v4 here is Base UI, not Radix, and
  neither ships a DnD primitive — this would mean `dnd-kit` or similar, the first UI dependency of
  its kind in this repo. A plain "add to collection" menu needs none of that and delivers most of
  the value; the reordering is the part that actually requires the library.
- **Show each disk's real filename, and let a human download the ADF.** Requested by the
  operator 2026-08-31. Two useful facts before anyone plans it: the original uploaded
  filename already exists as `entitlements.sourceFilename` and is **per-organization** on
  purpose (the same bytes can be uploaded under different names by different tenants, and
  `blobs` has no filename at all), while `disks.tosecName` holds the canonical TOSEC name
  once the identity scan has run — so "the actual filename" is two different columns and
  the UI should probably show both. For download: `GET /api/device/image/<sha256>` already
  exists but serves **WFMF (MFM-encoded, ~2 MB)**, not a raw ADF, so a human download is a
  new route rather than a reuse. It must check the caller's org holds an entitlement for
  that sha256 — the same boundary the device route enforces — and note the standing rule
  that **a presigned URL is a live credential**: never log it, never put it in the DOM.
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

- **Typeahead search with debounce, over titles and descriptions.** Requested by the operator
  2026-08-31, optionally searchable by attribute too. Notes for whoever plans it:

  **`games.description` exists as of the OpenRetro increment but is nearly empty**, and that is
  the first thing to check before promising description search. It is written only for blobs
  OpenRetro recognises, which on the operator's archive is 4 disks resolving to ONE game. A
  search that advertises "matches descriptions" would today be searching a single row. Either
  the TOSEC-identity matching described in §3d lands first, or the feature ships as title
  search with description as a quiet bonus.

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

- **Create blank ADFs, and add / edit / delete files through the browser.** Requested by the
  operator 2026-09-01. This is the WRITE counterpart to the read-only browser, and the reader
  is a hard prerequisite: you cannot safely write a filesystem you cannot yet read.

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

- **A read-only ADF browser** (disk-change spec §5) — parses OFS/FFS out of a stored ADF
  with no mounting involved. Buildable today, blocked on nothing, and useful right now for
  the unmatched-disk review queue.
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
  production that morning. Fixed by rendering `<Toaster/>` in the root layout. Note there is still
  **no `next-themes` ThemeProvider anywhere**, so `sonner.tsx`'s `useTheme()` silently falls back
  to `"system"`; that is pre-existing and unrelated, but it means the toaster's theme is not
  actually following the app.
- **A presigned URL is a live credential.** Never log it, never put it in the DOM.
- **`--accent-amber` (`#f5822e`) is fill-only** and fails WCAG AA as text. Amber text is
  `--amber-text` (`#a8560f`).
- **Next 16:** `params`/`searchParams`/`cookies()`/`headers()` are Promises.
  `PageProps`/`RouteContext` are ambient — never import them. The guard is `src/proxy.ts`
  exporting `proxy`, nodejs-only. `cacheComponents` stays off.
- **shadcn v4 is Base UI, not Radix.** Any Radix-era snippet is wrong here.
- **Pushing `master` does not deploy to production — it only builds a Preview.** The Vercel
  project's Production Branch is **`feat/foundation-library`**, set when the project was
  created (Vercel took the GitHub repo's default branch, and `origin/HEAD` still points
  there) and never changed since. This file said "merged to `master`, in production" for
  three plans running, which reads as though merging ships. It does not. Discovered on
  2026-08-30 immediately after merging plan 3b: both pushes produced `target: null` builds
  while `webadf.vercel.app` still served a build from the day before.
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
- **`ingest-api`, `ingest-ui` and `library` specs still seed without cleanup.** They predate
  plan 3a and were out of its scope (which was device helpers only), and **plan 3b did not
  close them either** — 3b's own two specs both call `cleanupSeeded`, but these three were
  no more in its scope than in 3a's. The live database continues to grow from those three
  files every full `pnpm e2e` run. This is the cleanup gap to close first if anyone is
  tidying: it is the only one still actively adding rows.

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
