# webadf — Design Spec

**Date:** 2026-08-23
**Status:** Draft for review

A web-based Amiga disk library that mounts ADFs to a Gotek floppy emulator over WiFi,
replacing the physical touchscreen of the existing Gotek Touchscreen Interface projects
with a browser UI and a cloud backend.

---

## 1. Purpose

Three existing projects solve overlapping parts of this problem:

| Project | What it contributes | Licence |
|---|---|---|
| [mesarim/Gotek-Touchscreen-interface](https://github.com/mesarim/Gotek-Touchscreen-interface) | The original. Defines the SD-card library contract. Current firmware is **binary-only**. | MIT |
| [dimitrihilverda/Gotek-Touchscreen-interface](https://github.com/dimitrihilverda/Gotek-Touchscreen-interface) | Fork with **full source** for a headless `Gotek_WiFi_Dongle` — the device we build on. | MIT |
| [DavidZinAZ/amiga-adf-library-builder](https://github.com/DavidZinAZ/amiga-adf-library-builder) | Source-verified documentation of the on-device format; a metadata/artwork pipeline design. | MIT |

webadf keeps the device, discards the screen, and moves the library to the web.

**In scope:** Next.js web app, multi-tenant catalog, blob storage, device API, a CLI bulk
importer, and a forked ESP32 firmware with a full cloud-pull client.

**Not in scope:** emulation, WHDLoad installs, IPF/DMS formats, non-Amiga platforms
(the `/DSK` and `/GENERIC` paths exist upstream but are deferred).

---

## 2. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | **Device pulls from the cloud.** The dongle joins home WiFi, long-polls our API, and fetches a presigned URL. | Works from anywhere, not just the LAN. Costs us real TLS on the ESP32. |
| D2 | **Multi-tenant from day one.** Every catalog row is owned by an organization. | Avoids a rewrite. Accepted cost: real auth and per-tenant storage accounting. |
| D3 | **Content-addressed storage.** Each unique disk stored once under its SHA-256; tenants hold *entitlements* to blobs, never direct paths. | Dedupes the ~30% of a typical collection that is shared Workbench/Extras/Locale disks, and keeps this personal storage rather than a distribution service. |
| D4 | **Browser dropzone + companion CLI** for ingest. | 18,000 files is not a browser-tab job. The CLI hashes locally and uploads only misses. |
| D5 | ~~**Full firmware fork** of `Gotek_WiFi_Dongle`.~~ **SUPERSEDED by D14.** | D1 makes it unavoidable; upstream has no cloud client, no pairing, and calls `setInsecure()`. |
| D6 | **Vercel Blob** for objects, behind one thin storage module. | Chosen for now; the seam keeps a later move to R2 or self-hosted S3 a one-file change. |
| D7 | **Cover grid by default, table as a view toggle.** | Grid for browsing by box art, table for finding one disk among thousands. Both are needed at 1,884 titles. |
| D8 | **Better Auth**, fully self-hosted, for human auth; **our own opaque tokens** for devices. | Auth must live entirely on our own domain. Better Auth runs in-process at `/api/auth/*`, stores everything in our Neon database, and makes no third-party requests. Its `organization` plugin *is* the tenancy model from D2, so it replaces a hand-rolled `accounts` table rather than sitting beside one. Devices never touch it. |
| D9 | **Enrichment is asynchronous and additive.** A disk is mountable the instant its bytes land; metadata and artwork arrive later, field by field. | Playing a game must never wait on IGDB. It is also the only workable design given external rate limits: 18,000 disks against ~4 req/s is hours of work. |
| D10 | **One disk resident at a time** (mechanism superseded by D14 — now a whole MFM image in the RP2350's PSRAM rather than a 1.44 MB FAT12 volume; the *one disk at a time* property still holds), exactly as upstream: a 1.44 MB FAT12 volume in PSRAM holding a single image. A swap is a fresh fetch plus a USB re-enumeration. | Parity with the linked projects. Sidesteps the FAT12 cluster ceiling entirely, and a ~2 s swap is nothing on a 30-year-old machine. |
| D11 | **Light UI on a fixed gradient canvas with frosted cards.** Structure derived from the operator's UserBoost design system; retuned, not rebranded. | The dark top of the gradient makes cover art read as sitting on a shelf, which suits a disk library better than it suits an analytics dashboard. Replaces the dark theme explored first. |
| D12 | **Assume TLS session reuse on the device; build the web app first.** The firmware bench is no longer a gate. | The hardware is slow and known to be slow. Session reuse is a firmware config knob, not an architectural commitment — if it misbehaves it is disabled in one place. Nothing in the web app's design changes on the answer. |
| D13 | **Sign-up is invite-only; the global existence check stays.** | `/api/ingest/check` is deliberately global so one stored copy serves every tenant — that is the whole storage saving of D3, and scoping it would make clients re-upload into an already-exists rejection. The cost is that knowing a digest is enough to reference it, so registration is closed instead. The property holds socially rather than technically; see the corrected §5 wording. |
| D14 | **The device is a self-designed RP2350 board that emulates the floppy bus directly** (`wifi-floppy/`), not an ESP32 dongle feeding a Gotek over USB mass storage. | The operator changed the hardware design and has boards on order from JLCPCB. The firmware drives the bus with PIO and MFM, so there is no Gotek in the path at all. **Supersedes D5.** |
| D15 | **The device consumes pre-encoded Amiga MFM, not raw ADF.** webadf gains an MFM encoder and serves a `WFMF` container. Designed in `2026-08-29-adfmfm-encoder-design.md`. | The Pico stores pre-encoded tracks and does no encoding work — a deliberate firmware decision so a WiFi stall can never halt the bus mid-track. Encoding on the server is therefore not optional. Roughly 2 MB per disk against an 880 KB ADF. |
| D16 | **The firmware gains TLS and a bearer token and talks to webadf directly.** | Chosen over a LAN bridge. It keeps one system with no extra moving parts, and preserves the device-token and pairing model already built. The cost is mbedTLS on RP2350 and a provisioned token, on firmware not yet compiled once. |
| D17 | **Device state is desired-vs-actual reconciliation, not a job queue.** `mount_jobs` is dropped; `devices` gains `desired_sha256`/`desired_game_id`/`desired_disk_no`/`desired_version`/`desired_set_at` alongside the existing `mounted_*` columns, and `disks` gains `write_protected`. Designed in `2026-08-29-device-plane-disk-change-design.md`. | A queue leaves the database and the device inconsistent after a failed fetch: the job is marked failed, the database still says the old disk is mounted, and nothing reconciles the two. Desired-state polling is idempotent across missed polls, reboots and duplicate deliveries — the recovery behaviour "the mounted disk is sticky" demands. `mount_jobs`'s own task in plan 2 was never started, so nothing reviewed was lost, only an unused table. |

---

## 3. Measurements

These drive §3.2 and the firmware risks in §13 and are from **65 real ADFs** (61 from the operator's own collection plus 4
public-domain disks), not estimates.

### 3.1 Compression

| Codec | min | p25 | median | p75 | max | aggregate | 16 GB becomes |
|---|---|---|---|---|---|---|---|
| gzip -9 | 1.05x | 1.23x | 2.08x | 3.21x | 65.4x | **1.90x** | 8.4 GB |
| zstd -19 | 1.07x | 1.29x | 2.32x | 3.80x | 76.4x | **2.06x** | 7.8 GB |
| lz4 -9 | 1.03x | 1.21x | 1.80x | 2.77x | 58.2x | 1.79x | 9.0 GB |

The distribution is **bimodal**. Trackloaded games and demos ship pre-packed data and
gain almost nothing (Project-X 1.09x, 9Fingers 1.10x, Wayfarer 1.05x); **34% of disks
gain under 1.5x from gzip**. Sparse AmigaDOS and utility disks gain 2–65x.

### 3.2 Conclusion: ship without compression

- **Storage:** 16 GB is a rounding error at Vercel Blob's $0.023/GB-month. Halving it saves
  about 18 cents a month.
- **Transfer:** an 880 KB ADF at a pessimistic 400 KB/s is ~2.2 s; median-compressed ~1.1 s.
  Both are acceptable for "click a game, it appears" — and under D10 this is also the
  disk-swap cost, which the operator has confirmed is fine.
- **Cost:** the firmware's load path is currently zero-copy straight into the RAM disk.
  Inflating breaks that.

Store raw ADF as canonical. Record `gzip_size` per blob at ingest so the decision can be
revisited with data. **Do not enable compression without an on-device benchmark** (§13).

---

## 4. Architecture

```
Browser ──── Next.js on Vercel ──── Neon Postgres (catalog, tenancy, devices, queue)
   │              │
   │              ├── presignUrl('put') ──┐
   │              └── presignUrl('get') ──┤
   ▼                                      ▼
webadf CLI ──── hash-first upload ──── Vercel Blob (private, content-addressed)
                                          ▲
                              HTTPS GET   │  (no SDK, no auth header, ~15 min TTL)
Gotek ◄── USB MSC ◄── PSRAM FAT ◄── XIAO ESP32-S3 ──── long-poll ──► /api/device/poll
```

Two independent trust domains meeting at the API:

- **Human plane** — Better Auth session cookie, full CRUD over the organization's library.
- **Device plane** — opaque bearer token, three endpoints only, read-only over blobs.

A device token can never enumerate the library, only fetch what it has been told to fetch.

---

## 5. Data model

Postgres via Drizzle, in one Neon database. Auth tables live in a separate `auth`
Postgres schema so the generated tables never mix with the catalog.

> **Verified correction.** `drizzleAdapter(db, { provider: 'pg', schemaName: 'auth' })`
> is a **CLI codegen hint only** — its JSDoc scopes it to schema generation. What actually
> namespaces queries at runtime is `pgSchema('auth')` in the generated table definitions.
> Set both; do not assume the adapter option alone isolates anything.

**Tenancy comes from Better Auth**, not from a table we write:

```
auth.user           id, email, name, …            -- Better Auth
auth.session        id, userId, activeOrganizationId, …
auth.organization   id, name, slug, metadata      -- THIS IS THE TENANT
auth.member         organizationId, userId, role  -- owner | admin | member
auth.invitation     organizationId, email, role, status, expiresAt
```

`session.activeOrganizationId` is the scope key for every request. Generated with
`npx auth generate` and committed as Drizzle schema.

Catalog tables, all carrying `org_id` referencing `auth.organization.id`:

```
blobs               sha256 (PK), size_bytes, gzip_size_bytes, storage_key,
                    content_type, created_at
                    -- GLOBAL, not per-tenant. One row per unique disk image
                    -- in the whole system. Never deleted while entitlements exist.

entitlements        org_id, sha256, first_seen_at, source_filename
                    -- PK (org_id, sha256). Records that this tenant CLAIMED
                    -- these exact bytes, and gates every presigned GET.
                    --
                    -- Corrected after implementation: this does NOT *prove*
                    -- possession. `/api/ingest/check` is global by design, so a
                    -- client that merely knows a digest is told "already stored"
                    -- and is granted an entitlement without uploading anything.
                    -- That is what makes cross-tenant dedupe work. Registration
                    -- is invite-only (D13) so the set of parties who can exploit
                    -- it is the set of people the operator invited.

games               id, org_id, title, sort_title, year, publisher,
                    developer, genre, chipset, notes, cover_asset_id,
                    metadata_source, external_ids jsonb, created_at
                    -- a release: one or more disks

disks               id, game_id, org_id, disk_no, sha256, label,
                    tosec_name, is_boot, write_protected boolean not null default true
                    -- ordered members of a set; disk_no drives the -N filename
                    -- write_protected (D17) lives here, not on `blobs` — `blobs` is
                    -- global and content-addressed, so a flag there would apply one
                    -- tenant's choice to every other tenant sharing the same bytes.

assets              id, org_id, kind ('cover'|'screenshot'), storage_key,
                    width, height, byte_size, source
                    -- covers are constrained at render time to <=500 KB, <=2000px

devices             id, org_id, name, token_hash, firmware_version,
                    last_seen_at, rssi, psram_free, mounted_game_id,
                    mounted_disk_no, mounted_sha256, status,
                    -- desired-state columns (D17), all nullable except the version:
                    desired_sha256, desired_game_id, desired_disk_no, desired_disk_id,
                    desired_version integer not null default 0, desired_set_at,
                    last_error, last_error_at
                    -- mount_jobs (below) is DROPPED — see D17. `devices` states
                    -- intent and reports the last-seen actual; there is no queue.
pairing_codes       code (6 chars), org_id, created_by_user_id,
                    expires_at, consumed_at
import_runs         id, org_id, created_by_user_id, source, totals jsonb,
                    state, created_at
```

All catalog reads go through a scoped query helper, `db.forOrg(orgId)`, so a missing
tenant filter is a type error rather than a data leak.

**Deliberately global:** `blobs`. **Deliberately per-tenant:** everything else. A blob is
reachable only via an `entitlements` row, so two tenants owning the same Workbench disk
share the bytes but neither can discover the other.

---

## 6. Storage layer

One module, `src/lib/storage.ts`, is the only file that imports `@vercel/blob`:

```ts
export interface DiskStore {
  uploadUrl(sha256: string, size: number): Promise<{ url: string; expiresAt: Date }>;
  downloadUrl(sha256: string, ttlSeconds: number): Promise<string>;
  head(sha256: string): Promise<{ exists: boolean; size?: number }>;
  delete(sha256: string): Promise<void>;
}
```

Vercel Blob implementation:

- Key: `adf/<sha256>` — deterministic, `addRandomSuffix: false`.
- `access: 'private'` throughout. ADFs are never publicly reachable.
- Upload: `issueSignedToken({ operations: ['put'], pathname, maximumSizeInBytes, validUntil })`
  then `presignUrl(token, { operation: 'put', access: 'private', addRandomSuffix: false,
  allowOverwrite: false })`. The size cap and path scope mean a leaked token cannot upload
  anything else. `presignUrl` takes the **whole** `issueSignedToken` result (it needs both
  `delegationToken` and `clientSigningToken`) and returns `{ presignedUrl }`, not a string.
- There is **no `ifNoneMatch` / create-if-absent**. Dedupe is `allowOverwrite: false` plus a
  prior `head()` — and `head()` **throws `BlobNotFoundError`** when absent rather than
  returning null, so existence checks must be try/catch.
- The presigned PUT targets the control plane (`vercel.com/api/blob`), not the blob host, so
  Vercel Functions' request-body limit never applies to uploads.
- Download: `presignUrl(token, { operation: 'get', access: 'private', validUntil: now + 15min })`.
  **Verified**: the resulting `https://<storeId>.private.blob.vercel-storage.com/...` URL carries
  its delegation and signature as query parameters and needs **no headers, no cookies, no SDK** —
  a bare HTTPS GET works, which is exactly the ESP32 path. Ceiling is 7 days (documented
  server-side; the SDK does not enforce it).

Migrating to R2 or self-hosted S3 means writing a second implementation of that interface.
Nothing else in the codebase changes.

---

## 7. Device protocol

Three endpoints. All take `Authorization: Bearer <device-token>`; the token is stored
only as a SHA-256 hash.

### `POST /api/device/register`
Body `{ pairingCode, firmwareVersion, macAddress }`. Consumes an unexpired
`pairing_codes` row, creates the `devices` row, returns the one and only plaintext token.

### `GET /api/device/poll`

**Superseded by D14/D15/D17 — implemented as desired-state reconciliation, not a job
queue.** Full design in `2026-08-29-device-plane-disk-change-design.md` §2–4; this section
keeps only the shape. `GET /api/device/poll?since=<version>` long-polls: it returns
immediately once `desired_version > since`, otherwise holds up to **25 s** and returns
`204`. The device reconnects either way, sending back the last `version` it saw.

```jsonc
// 200 — a disk is desired
{
  "version": 7,
  "desired": {
    "sha256": "a71f0c9e…",
    "gameId": "gam_01H…", "game": "Project-X",
    "diskNo": 2, "diskCount": 4,
    "label": "Project-X (Disk 2 of 4)",
    "writeProtected": true
  }
}

// 200 — ejected
{ "version": 8, "desired": null }
```

There is no per-swap job (the `"job": "mnt_01H..."` shape this section once showed is
gone): mounting disk 2 of a set is the same mount action setting `desired_disk_no = 2` and
bumping `desired_version`, and an eject is `desired: null`. The device does not track sets
and does not pre-fetch; it holds one image and reconciles toward whatever `desired`
currently says, which is what makes a missed poll, a reboot or a duplicate delivery safe to
ignore rather than something a queue would leave inconsistent (D17).

The poll no longer carries a presigned blob URL for a raw ADF, because the device cannot
use one — it needs pre-encoded MFM. The poll returns only the *identity* of the image to
mount, and the device fetches it from webadf itself:

```
GET /api/device/image/<sha256>   ->  200 application/octet-stream
```

That response is the `WFMF` container defined by `wifi-floppy/firmware/src/image_loader.c`:

    u32  magic        0x464D4657  ('WFMF', little-endian)
    u32  version      1
    u32  track_count  160
    u32  reserved     0
    per track (cyl*2+side, 0..159):
        u32  bit_count   MFM bits, ~101,600; must be <= 13312*8 = 106,496
        u8[] payload     ceil(bit_count/8) bytes, raw MFM, MSB first
        u8[] padding     zeroes to a 4-byte boundary

The firmware rejects a wrong magic or version, refuses an over-long track rather than
truncating it, and presents no disk at all if the body is short or interrupted — it
retries instead of mounting half a disk. Its idle timeout is 4 s between TCP chunks, not
a total deadline, so a slow link is fine and a stalled one is not.

### `POST /api/device/status`

**Superseded by D17 — no job to close, only actual state to report.**
`{ mountedSha256, version, error, psramFree, rssi }`. Updates `devices.mounted_*`,
`last_seen_at`, `rssi`, `psram_free`, and clears or sets `last_error`/`last_error_at`. The
device posts this after every transition and as a heartbeat; there is no `mount_jobs` row
to close, because there is no `mount_jobs` (D17). See the disk-change spec §4.

**Long-poll over WebSockets.** Vercel now supports WebSockets, but long-poll is far simpler
on the ESP32, survives NAT and captive portals better, and on Fluid Compute a held
connection costs provisioned memory rather than active CPU. Revisit only if 25 s latency
proves annoying.

---

## 8. Firmware

**Superseded by D14.** The firmware is `wifi-floppy/` — bespoke C on the Pico SDK for an
RP2350 (Pimoroni Pico Plus 2 W, PIM726) on a self-designed 2-layer board, boards ordered
from JLCPCB. It emulates the floppy bus directly with PIO rather than presenting a USB
mass-storage device to a Gotek, so the Gotek is out of the path entirely.

Written but never compiled — expect SDK API fixes on the first build. Read-only for now:
`WPROT` is asserted and `http_post_track()` is a stub, so write-back is unimplemented on
both sides and disks stay read-only until that is settled.

What the firmware still needs (plan 4): mbedTLS and a provisioned bearer token per D16;
today `http_fetch.c` issues a plaintext `GET %s HTTP/1.1` to a bare IP with no credentials.

What upstream already gives us: TinyUSB MSC, a hand-built FAT12 volume in PSRAM, a
zero-copy `streamToBuffer()` that writes an HTTPS GET straight into the RAM disk, and
`WIFI_AP_STA` so the device can be an AP and a station at once.

What we add:

1. **`wifi_provision.h`** — captive portal on first boot; SSID/password to NVS.
2. **`pairing.h`** — the 6-digit code from the portal, exchanged once for a device token.
3. **`cloud_client.h`** — long-poll, JSON parse, sequential fetch of each disk.
4. **Real TLS.** Upstream calls `setInsecure()`. Replace with a pinned CA bundle.
   **Verified against the live host:** `*.private.blob.vercel-storage.com` is served by a
   Let's Encrypt certificate (leaf ← LE intermediate ← ISRG Root X1), renewed roughly every
   90 days. Pin **ISRG Root X1** — pinning the leaf or the intermediate guarantees a field
   failure within the quarter.
5. **The RAM disk stays exactly as upstream built it** — 1.44 MB, FAT12, one image, and
   the existing `tud_disconnect()` → `build_empty_volume()` → stream → `build_fat_for_file()`
   → `mediaPresent(true)` → `tud_connect()` sequence untouched. That re-enumeration is what
   makes the Amiga register a disk change. This is deliberately *not* a change (D10); the
   only new code is what fills the buffer.
6. **`ota.h`** — signed firmware update, hash-verified before switching the boot pointer
   (upstream already does this pattern for SD updates).

---

## 9. Ingest

Both paths converge on the same three-step protocol:

1. **Hash locally.** SHA-256 over the raw file. Never upload to find out it is a duplicate.
2. **`POST /api/ingest/check`** with up to 500 hashes → `{ known: [...], missing: [...] }`.
   Known hashes get an `entitlements` row immediately and are done.
3. **`POST /api/ingest/presign`** for the misses → presigned PUTs. Client uploads direct
   to Blob; a completion call verifies size and creates the `blobs` + `entitlements` rows.

The **CLI** (`npx webadf push <dir>`) is a small Node tool doing this with parallelism,
resume, and a progress table. The **dropzone** does the same in a Web Worker for the
everyday few-disks case, and every finished row gets a **Mount** button directly in the
ingest table (§10) — the fast path is drop, click, play.

**Grouping and identification** runs server-side after upload:

- Parse the filename per the TOSEC convention → title, year, publisher, disk N of M, flags.
- Match SHA-256/CRC32 against TOSEC `.dat` files → exact identification where possible.
- Group into `games` by title, splitting on the **final** `-N` token (so
  `Example - Space Unknown-2.adf` groups correctly).
- Enrich via Hasheous → IGDB, with OpenRetro for Amiga-specific variant data.
- Anything unmatched is **stored and playable**, just parked in a review queue. Never
  guessed into a game folder.

---

## 10. Enrichment pipeline

**Governing principle (D9): a disk is playable the moment its bytes land.** Nothing in
this section may block a mount. Enrichment only ever *adds* to `games` and `assets`.

The common case is not browsing — it is *you already know which game you want and you
just uploaded it*. Metadata and box art are secondary to that. Three consequences, and
they are requirements rather than nice-to-haves:

1. **Mount is reachable from the ingest screen.** Every completed ingest row carries a
   mount action. Drop a file, click mount, play — without ever visiting the library.
2. **Search indexes the source filename**, not only the enriched title. `9Fingers_D1.adf`
   must be findable by typing `9fingers` one second after upload, before any queue has run.
3. **Sort defaults to recently added.** The disk you just uploaded is the one you want.

Cover art earns its place when you are browsing 1,884 titles looking for something to
play. It must never sit between you and a disk you deliberately chose.

### 10.1 Stages

Each stage commits independently and is idempotent, so partial results survive a failure
and a game is never left half-written.

| # | Stage | Network | When |
|---|---|---|---|
| 0 | TOSEC filename parse to title, year, publisher, disk N of M, flags | none | **synchronously at ingest** |
| 1 | SHA-256 / CRC32 match against TOSEC `.dat` | none (local dat) | queued |
| 2 | OpenRetro lookup by hash for Amiga variant data | yes | queued |
| 3 | Hasheous to IGDB for canonical metadata | yes, rate-limited | queued |
| 4 | Artwork fetch, downscale to <=500 KB / <=2000 px, store as `assets` | yes | queued |

Stage 0 running inline is what makes the library usable immediately: a freshly imported
disk already shows a real title and year, parsed from its filename, before any queue runs.

### 10.2 Mechanism

Vercel Queues for delivery; an `enrichment_jobs` table for truth.

```jsonc
// vercel.json
{ "functions": {
    "app/api/queues/enrich/route.ts": {
      "experimentalTriggers": [
        { "type": "queue/v2beta", "topic": "enrich", "retryAfterSeconds": 60 }
      ]
    }
}}
```

```
enrichment_jobs   id, org_id, game_id, stage,
                  state ('queued'|'running'|'done'|'failed'),
                  attempts, last_error, next_attempt_at, updated_at
                  -- unique (game_id, stage)
```

Two properties force this shape:

- Queues deliver **at-least-once**, so every handler must be idempotent. Writing through
  `enrichment_jobs` with a unique `(game_id, stage)` gives that for free.
- The trigger is `v2beta`. Keeping truth in Postgres lets a nightly cron re-drive anything
  stuck in `running` past its timeout, so we are never one API change away from a stalled
  library.

**Rate limits are the binding constraint, not our compute.** IGDB allows roughly 4 req/s.
The consumer runs deliberately low concurrency behind a shared token-bucket limiter with
exponential backoff. Adding functions makes this worse, not faster.

### 10.3 Progressive UI

Cards render from whatever is present. A game with only a stage-0 parse shows its title
and a generated placeholder cover — the same placeholder in the design canvas, which is
why that state was designed rather than treated as an error.

The library page subscribes to an SSE endpoint emitting `{ gameId, fields }` as rows
change, so covers and blurbs appear in place without a reload; it falls back to polling if
the stream drops. A persistent, dismissible progress row reports "enriching 2,481 of
18,412" — never a blocking modal, because this legitimately runs for hours after a large
import and the entire point is that you are playing meanwhile.

---

## 11. Web UI

Next.js App Router, shadcn/ui, Tailwind v4. Artboards in `design/`; the published canvas
carries the live design plus the explored alternatives.

- **Library** — cover grid, faceted sidebar, `/` search over title, publisher, SHA **and
  original filename**, sorted recently-added by default.
  Table view toggle for keyboard-driven search across thousands of disks.
- **Game detail** — multi-disk selector that doubles as the **swap control** (clicking
  disk 2 mid-game queues the swap; ~2 s later the Amiga sees the new disk), mount action,
  TOSEC identity and provenance,
  and a preview of the exact `/ADF/<Game>/` tree and `.nfo` the device will see.
- **Devices** — status, PSRAM budget, pairing flow, OTA, activity log.
- **Ingest** — dropzone, CLI instructions, live run progress, review queue.

### 11.1 Visual system

Derived from the operator's UserBoost `globals.css` — the same structural idea (fixed
gradient canvas, frosted surfaces, page title on the dark band), retuned for this product
rather than reusing that brand. Implement as CSS custom properties; no component
hardcodes a hex.

```css
/* canvas — background-attachment: fixed is load-bearing; the design
   depends on the gradient staying put while content scrolls */
--grad: linear-gradient(180deg, #1b2534 0%, #3a4d61 9%, #8d97a1 34%,
                                #c8cfd3 62%, #eef1f2 100%);

/* text on the dark band            /* text on glass */
--on-dark:        #eef3f6;          --ink:       #16232f;
--on-dark-muted:  rgb(233 240 244 / 0.62);
                                    --foreground:#223140;
                                    --muted:     #5b6c7c;
                                    --muted-2:   #8a99a6;
                                    --faint:     #a9b4bd;

/* frosted surfaces */
--glass:        rgb(255 255 255 / 0.62);   /* default card            */
--glass-panel:  rgb(255 255 255 / 0.68);   /* content panel           */
--glass-strong: rgb(255 255 255 / 0.80);   /* active / raised         */
--glass-subtle: rgb(255 255 255 / 0.45);   /* footer strips           */
--glass-border: rgb(255 255 255 / 0.65);
--input-bg:     rgb(255 255 255 / 0.75);
--hairline:     rgb(30 45 60 / 0.08);
--hairline-strong: rgb(30 45 60 / 0.14);
--shadow-card:  0 1px 2px rgb(30 45 60 / 0.06), 0 8px 24px rgb(30 45 60 / 0.09);

/* actions & accents */
--primary:      #16273a;  --primary-fg: #ffffff;   /* Mount, submit   */
--accent-blue:  #1a35d6;                           /* counts, dedupe  */
--accent-amber: #f5822e;                           /* fills only      */
--success-bg: #dff2e2; --success-fg: #1c7a3e;
--warning-bg: #fdf1cf; --warning-fg: #8a6207;
--danger-bg:  #fbe1e1; --danger-fg:  #c0342e;
--online-dot: #5fd18b;                             /* on dark only    */

--radius-card: 14px;  --radius-control: 9px;  --radius-pill: 999px;
--font-sans: "Space Grotesk";  --font-mono: "IBM Plex Mono";
```

**Contrast rule, inherited from UserBoost's convention and worth keeping.** `--accent-amber`
(`#f5822e`) is a *fill* colour and fails WCAG AA at text sizes. Amber text uses the darkened
`#a8560f`, and amber-on-warning-surface uses `#8a6207`. Never set text in `--accent-amber`.

**Cover aspect is 1.23:1** throughout, matching the firmware's 138×112 display box (§11), so
what you see in the browser is framed the same way the device would frame it.

Covers render through Next `<Image>` but must be **exported** within the firmware's
verified hard limits when written to an SD card: **≤500,000 bytes, ≤2000×2000 px**, JPEG
or PNG. Ideal aspect ≈1.23:1 to fill the device's 138×112 box without letterboxing.
`.nfo` files are truncated to **512 bytes** — the firmware reads no further.

---

## 12. Non-goals

- No compression at rest or in transit in v1 (§3.2).
- No LAN push path. D1 chose cloud-pull; adding push later is additive.
- No public sharing of libraries between tenants. Blobs are deduped, entitlements are not.
  Note the honest limit of this (D13): a tenant who knows a digest can obtain an
  entitlement to it without ever holding the bytes. Invite-only registration bounds
  who can do that; it does not make it impossible.
- No `/DSK` (ZX/CPC) or `/GENERIC` support, though the schema does not preclude it.
- No manual metadata editor beyond the review queue in v1; enrichment is automatic or
  hand-corrected one game at a time.
- No SD-card export in v1, though the format is documented and the tree is already rendered
  on the game detail screen.

---

## 13. Risks and open questions

| Risk | Assessment | Mitigation |
|---|---|---|
| **Disk swaps need the web UI.** With one disk resident (D10) there is no on-device affordance to advance to disk 2 — you reach for a phone or laptop mid-game. | Low, and it is parity: upstream needs the touchscreen or the phone for the same reason. | Accepted. If it grates, the XIAO's BOOT button is unused in the dongle firmware and could advance to the next disk in the set. Explicitly deferred, not designed in. |
| ESP32-S3 HTTPS throughput unknown | Low, by decision (D12) — deliberately not a gate. Published figures vary from 300 KB/s to several MB/s; TLS handshakes alone have been measured over 3 s. | Assume session reuse and build the web app first. Bench when the firmware milestone starts. If a handshake per fetch turns out to cost seconds, session reuse is already assumed; disabling it is a one-line change in the other direction. |
| Presigned URL TTL vs slow fetch | Low | 15 min is ample for a single 880 KB fetch. Device re-polls if a URL expires. |
| Vercel Blob private storage is public beta | Low–medium | The `DiskStore` seam (§6) is the hedge. |
| Copyright posture of a multi-tenant host of game images | Real, and the operator's call — mitigated by invite-only registration (D13) | Content addressing plus per-tenant entitlements means no cross-tenant distribution. Keep the deployment private/invite-only. |
| Self-hosting auth means we own password reset, email verification, session revocation and lockout | Medium — real work a hosted provider would have done for us | Better Auth ships all of it; the cost is configuring and testing it rather than writing it. Budget a milestone for the account-lifecycle flows and their emails. |
| Auth emails need a sender | Low | Resend, added via the Marketplace when the email milestone lands. |
| **Server-side MFM encoding (D15) may not pan out.** ~2 MB per disk over TLS on an RP2350, plus a server encoder that must be bit-exact, plus an encoded-image cache to maintain. | Medium — unproven until the boards arrive and the firmware compiles. | **Backlog: move ADF→MFM encoding onto the Pico** and go back to shipping the 880 KB raw ADF. The device already has the PSRAM headroom (8 MB holds 3 images) and a whole core sitting idle after the bulk transfer, and it would cut transfer volume 2.4x and delete the server cache entirely. The cost is an encoder in C on the device instead of TypeScript on the server, and `image_loader.c`'s `WFMF` container would carry ADF payloads or be dropped. **Not being pursued now** — server-side encoding per D15 is the method, and the `adfmfm` encoder is written to be transliterable to C if this is ever taken up. |

**Open question for implementation, not for this spec:** whether the review queue for
unmatched disks needs bulk editing in v1 or whether one-at-a-time is enough at 412 items.

---

## 14. Provisioning

To be created after this spec is approved:

- **GitHub** — private repo `webadf` under `stefanskotte`.
- **Vercel** — project in `stefan-skottes-projects`, linked to the repo.
- **Neon** — Postgres in the Vercel-linked org (`launch` plan), provisioned via
  `vercel integration add neon` so env vars are injected automatically.
- **Better Auth** — no provisioning; it is a dependency. Needs `BETTER_AUTH_SECRET` and
  `BETTER_AUTH_URL` in Vercel env, and `npx auth generate` committed as Drizzle schema.
- **Resend** — deferred to the account-lifecycle milestone, via `vercel integration add resend`.
- **Vercel Blob** — store created in the project.

`adf-archive/` is gitignored. Disk images must never enter the repository.
