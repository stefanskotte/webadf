# webadf — session handoff

**Written 2026-08-29.** Everything a fresh session needs to pick this up cold.
Read this first, then the spec, then the plan you are resuming.

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
| **Plan 2 — device plane** | 🟡 Tasks 1–4 done and reviewed on branch `feat/device-plane`. Tasks 5, 9–11 valid but not started. Tasks 6–8 **obsolete** — see below |
| **MFM encoder** | ❌ Not started. **This is the critical path.** No plan written yet |
| **Firmware (`wifi-floppy/`)** | Written, **never compiled**. Needs TLS + token added (D16) |
| **Hardware** | PCB routed, Gerbers exported, **boards ordered from JLCPCB** |

**Current branch:** `feat/device-plane`, 6 commits ahead of `master`, all pushed.
Suite green: **78 vitest, 27 Playwright**, build clean.

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

### 1. The MFM encoder — the long pole, nothing device-facing works without it

Write a plan for it and execute. `INTEGRATION.md` § "Server-side encoding" is the
requirement. Suggested home: `adfmfm/`.

- 11 sectors per track, 512 data bytes each, 160 tracks (cyl×2+side).
- Per sector: sync `0x4489` twice, info long (format/track/sector/sectors-to-gap),
  16-byte sector label, header checksum, data checksum, then 512 data bytes.
- **Amiga MFM uses odd/even bit splitting** — odd bits of the block first, then even —
  with clock bits filled so MFM rules hold across boundaries.
- Track gap after the last sector to pad the revolution.
- `bit_count` must not exceed `13312 * 8 = 106,496`. A real track is ~101,600 bits.

**Validate by round-trip: encode → decode → compare byte-for-byte with the source ADF.**
Cross-check against a known-good tool's output for the same ADF. `INTEGRATION.md` warns
specifically that the checksum and bit-split details are where these go wrong, and a
subtly wrong encoder looks fine until the Amiga refuses to read a disk. Take that
seriously — it is the one place in this project where tests passing proves least.

There are 62 real ADFs in `adf-archive/` (gitignored) to test against.

**Backlog (not now):** if server-side encoding turns out not to work well — bit-exactness,
the 2 MB-per-disk transfer, or the cache — the fallback is to **move ADF→MFM onto the Pico**
and go back to shipping the raw 880 KB ADF. Recorded in spec §13. It is not the plan; write
`adfmfm` as straightforward, dependency-free logic that could be transliterated to C, and
don't contort the design for it.

### 2. Then `GET /api/device/image/<sha256>`

Serves the `WFMF` blob. Encoding is deterministic, so cache the ~2 MB result keyed by
the same SHA-256 — `INTEGRATION.md` § open question 3 notes that pre-encoding the whole
library would roughly triple its size for disks that may never be mounted.

### 3. Then finish plan 2

Tasks **5, 9, 10, 11** are still valid as written. Tasks **6, 7, 8** need rewriting
against the new contract. The plan file carries a banner explaining exactly this.

### 4. Firmware (plan 4)

Add mbedTLS and a provisioned bearer token per D16. Today `http_fetch.c:63` issues a
plaintext `GET %s HTTP/1.1` to a bare IP with no credentials. Also never compiled —
expect SDK API fixes on the first build.

---

## Open questions the operator still owns

From `INTEGRATION.md`, plus one from me:

1. **Which disk is mounted.** The firmware hardcodes `image_load(0)`. Plan 2's Task 5
   (mount jobs) is the mechanism for this — a mount action sets a current-disk pointer
   and the Pico asks for it at boot. Decide whether the endpoint returns the id or the
   image directly before writing it.
2. **Write-back.** Unimplemented both sides. `WPROT` is asserted, `http_post_track()`
   is a stub, `psram_image_next_dirty()` exists but nothing calls it. Decide whether
   webadf accepts modified tracks at all, or disks stay read-only.
3. **Disk identity.** `INTEGRATION.md` says do not invent a parallel numbering scheme.
   webadf already keys everything by SHA-256 — use that.
4. **(Mine)** `requireDevice` throws a `DeviceAuthError`, but plan 2's prose says it
   throws a `Response(401)`. Nothing consumes it yet. **Reconcile before the first
   consumer**, or a `catch (e) { return e }` yields a 500 instead of a 401.

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
  granted on digest knowledge alone (26 blobs are already shared across orgs). That global
  check is load-bearing — it *is* the cross-tenant dedupe. Registration is invite-only
  (D13) to bound who can exploit it. Nothing leaks today because no download route exists.
  **The device image endpoint is that download route** — re-examine this before shipping it.
- Spec §5's wording was corrected: an entitlement *records a claim*, it does not *prove*
  possession.

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

- **Spec (binding authority):** `docs/superpowers/specs/2026-08-23-webadf-design.md` — 16 decisions
- **Plan 1 (done):** `docs/superpowers/plans/2026-08-24-webadf-foundation-library.md`
- **Plan 2 (partial):** `docs/superpowers/plans/2026-08-29-webadf-device-plane.md`
- **Decision log:** `docs/decisions/` — rulings taken during implementation
- **Firmware contract:** `INTEGRATION.md` and `wifi-floppy/firmware/src/image_loader.c`
- **UI design:** `design/*.dc.html` artboards; canvas at
  https://claude.ai/code/artifact/fc7949f0-bdf8-4c7b-aedf-9d6712093e8b

**Commands:** `pnpm dev` · `pnpm vitest run` · `pnpm e2e` · `pnpm build` ·
`pnpm db:generate && pnpm db:push` · `npx webadf push <dir>` (CLI bulk import)

**Infrastructure:** Vercel project `webadf` · Neon Postgres (`auth` + `public` schemas) ·
Vercel Blob store `webadf-disks` (**private** access) · Vercel CLI 59.10.0
