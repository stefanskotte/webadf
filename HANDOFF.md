# webadf — session handoff

**Written 2026-08-29, updated 2026-08-30 after plan 3a.** Everything a fresh session
needs to pick this up cold. Read this first, then the spec, then the plan you are
resuming.

---

## What this project is

A web app that stores an Amiga floppy-disk library and mounts disks to real Amiga
hardware over WiFi. You upload ADFs; each unique disk is stored once, keyed by its
SHA-256; you browse them and press mount; a custom board emulates the floppy drive.

**Live:** https://webadf.vercel.app · **Repo:** `stefanskotte/webadf` (private)

---

## Where things stand

| | Status |
|---|---|
| **Plan 1 — foundation & library** | ✅ Complete, reviewed, **merged to `master`, deployed to production** |
| **Plan 2 — device plane** | Tasks 1–4 done and reviewed. Tasks 6, 7, 8 are **superseded by plan 3a** (D17), not pending — see below. Tasks 5, 9–11 were never started and their status under the new design has not been re-examined. |
| **MFM encoder (`adfmfm`)** | ✅ **Done.** Byte-identical to Greaseweazle across all 61 archive disks, 9,760 of 9,760 tracks. `pnpm adfmfm:diff` is the gate. Designed in `2026-08-29-adfmfm-encoder-design.md`, built in `docs/superpowers/plans/2026-08-29-adfmfm-encoder.md`. |
| **Plan 3a — device protocol, disk change** | ✅ **Done.** Schema (`desired_*` columns, `write_protected`, `mount_jobs` dropped), `GET /api/device/poll`, `GET /api/device/image/<sha256>`, `POST /api/device/status`, and the human-facing mount/eject/write-protect endpoints. Proven end to end, no hardware, by `e2e/device-protocol.spec.ts`. Designed in `2026-08-29-device-plane-disk-change-design.md`, built in `docs/superpowers/plans/2026-08-29-device-protocol-disk-change.md`. |
| **Plan 3b — UI** | 🔲 **Next.** Devices page, game-detail disk selector, write-protect toggle, desired-versus-actual display. Not started; design is spec §7. |
| **Firmware (`wifi-floppy/`)** | Written, **never compiled**. Needs TLS + token added (D16). Three defects recorded, not fixed — see "Known firmware defects" below. |
| **Hardware** | PCB routed, Gerbers exported, **boards ordered from JLCPCB** |

**Current branch:** `feat/disk-change`, branched off `feat/device-plane` (see plan 3a's
ledger, Ruling T2-1, for why — 8 early commits landed on `master` by mistake and were
moved). Suite green: **228 vitest, 58 Playwright**, `pnpm build` clean.

---

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

### 1. Plan 3b — the UI

The protocol is done and provable without hardware; nothing device-facing is blocking
this. Build against `2026-08-29-device-plane-disk-change-design.md` §7:

- **Devices page** — each device shows its actual mounted disk, its desired disk when
  they differ, `last_seen_at`, and `last_error`. An eject button.
- **Game detail** — a disk selector; mount any disk of the set to any paired device.
- **Write-protect toggle** — on the disk row, next to mount. `PATCH /api/disks/[id]`
  already exists for this.
- **Never present desired state as fact.** A device that has not been seen for minutes
  with a pending desired change reads as *requested*, not *mounted* — this is the whole
  point of keeping desired and actual as separate columns (D17).

The endpoints to build against already exist and are e2e-tested: `GET /api/device/poll`,
`GET /api/device/image/<sha256>`, `POST /api/device/status`,
`POST /api/devices/[id]/mount`, `POST /api/devices/[id]/eject`.

### 2. Firmware (plan 4)

Add mbedTLS and a provisioned bearer token per D16. Today `http_fetch.c:63` issues a
plaintext `GET %s HTTP/1.1` to a bare IP with no credentials. Also never compiled —
expect SDK API fixes on the first build. While there, reconcile `image_loader.c`'s
`TRACK_SLOT_BYTES` against `track_cache.c`'s smaller `TRACK_MFM_MAX`, and bound `bits`
before the `(bits + 7) / 8` arithmetic in `image_loader.c:51` — see "Known firmware
defects" below. Implementing the two-slot double-buffer that lets a fetch happen before
an eject (disk-change spec §1, rule 2) also belongs here.

### 3. Backlog, not blocking anything

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

---

## Known firmware defects (recorded, not fixed)

Found while building the encoder and its device-image endpoint; none block webadf's side,
all belong to the firmware plan. Full detail in `2026-08-29-adfmfm-encoder-design.md` §7.

1. **Latent buffer overflow.** `image_loader.c` accepts a track payload up to
   `TRACK_SLOT_BYTES` (13,312 bytes), but `track_cache.c` copies it into an SRAM buffer of
   `TRACK_MFM_MAX` (13,000 bytes) — a 312-byte overflow for any track over 13,000 bytes.
   Our tracks are 12,668 bytes, under both, so this is latent rather than live today. The
   two constants should be reconciled.
2. **Revolution timing.** `BITCELL_NS` is 2,000 ns against a true Amiga bitcell of
   1,973.6 ns, giving ~296 RPM against a nominal 300. Accepted — the Amiga's PLL locks to
   sync marks, not a stopwatch, and real drives vary by more than this. A one-line
   `clkdiv` trim in `flux_out_program_init` if it ever matters.
3. **`bit_count` overflow accepts a bogus image.** `image_loader.c:51` computes
   `payload_bytes = (bits + 7) / 8` on a `uint32_t`; a `bit_count` at or above `0xFFFFFFF9`
   wraps the addition to `payload_bytes = 0`, sailing past the `> TRACK_SLOT_BYTES` guard.
   Every track then parses as present with a nonsense bit count, and
   `psram_image_missing_count()` returns 0 — the firmware presents a disk of empty tracks
   instead of refusing the image. The fix is to bound `bits` *before* the arithmetic.
   **`src/lib/adfmfm/firmware-parser.ts` reproduces this deliberately and must not be
   "fixed"** — its job is to mirror what the device *actually* accepts, warts included;
   `readWfmf`, webadf's own reader, is hardened against this and the asymmetry between the
   two is intentional. This is the defect the mirror was built to find, and it did.

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
  plan 3a and were out of its scope (which was device helpers only); the live database
  continues to grow from those three files every full `pnpm e2e` run.

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
- **Plan 3b — UI:** not written yet; design is the disk-change spec's §7
- **Decision log:** `docs/decisions/` — rulings taken during implementation
- **`adfmfm` module:** `src/lib/adfmfm/README.md`
- **Firmware contract:** `INTEGRATION.md` and `wifi-floppy/firmware/src/image_loader.c`
- **UI design:** `design/*.dc.html` artboards; canvas at
  https://claude.ai/code/artifact/fc7949f0-bdf8-4c7b-aedf-9d6712093e8b

**Commands:** `pnpm dev` · `pnpm vitest run` · `pnpm e2e` · `pnpm build` ·
`pnpm adfmfm:diff` (Greaseweazle differential gate, needs `adf-archive/` + pipx) ·
`pnpm adfmfm:fixtures` (regenerate golden fixtures) ·
`pnpm db:generate && pnpm db:push` · `npx webadf push <dir>` (CLI bulk import)

**Infrastructure:** Vercel project `webadf` · Neon Postgres (`auth` + `public` schemas) ·
Vercel Blob store `webadf-disks` (**private** access) · Vercel CLI 59.10.0
