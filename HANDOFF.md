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
| **Hardware** | boards ordered from JLCPCB |

**Current branch:** `master` — everything through plan 4b is merged and pushed; there is no
outstanding feature branch. **Suite:** 241
vitest (+1 from the mirror update in plan 4a, so 242 from `feat/device-firmware` onward),
87 Playwright, `pnpm build` clean. Firmware: `pnpm firmware:test` green (506 checks, 13
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

### 4. Backlog, not blocking anything

- **Write-back and layered disks** (disk-change spec §5). Deliberately not designed yet;
  the first increment should record which tracks changed, not just a flattened result, so
  it doesn't foreclose the layered approach.
- **A read-only ADF browser** (disk-change spec §5) — parses OFS/FFS out of a stored ADF
  with no mounting involved. Buildable today, blocked on nothing, and useful right now for
  the unmatched-disk review queue.
- **Moving ADF→MFM encoding onto the Pico** (spec §13) if server-side encoding
  (9.6 ms/disk, ~2 MB over TLS) ever turns out not to hold up. `adfmfm` is written
  dependency-free specifically so this would be a transliteration, not a rewrite.
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
- **Plan 4a — firmware protocol plane (done, on `feat/device-firmware`, not yet merged):**
  `docs/superpowers/plans/2026-08-30-device-firmware-protocol.md`
- **Provisioning portal spec — plan 4b (done):**
  `docs/superpowers/specs/2026-08-30-device-provisioning-portal-design.md` — see its "What
  plan 4b delivered" section for the shipped/not-shipped split
- **Plan 4b — provisioning portal (done, on `feat/device-portal`, not yet merged):**
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
