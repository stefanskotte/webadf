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
| D5 | **Full firmware fork** of `Gotek_WiFi_Dongle`. | D1 makes it unavoidable; upstream has no cloud client, no pairing, and calls `setInsecure()`. |
| D6 | **Vercel Blob** for objects, behind one thin storage module. | Chosen for now; the seam keeps a later move to R2 or self-hosted S3 a one-file change. |
| D7 | **Direction A UI, with Direction C as a view toggle.** | Grid for browsing, table for finding one disk among thousands. |
| D8 | **Better Auth**, fully self-hosted, for human auth; **our own opaque tokens** for devices. | Auth must live entirely on our own domain. Better Auth runs in-process at `/api/auth/*`, stores everything in our Neon database, and makes no third-party requests. Its `organization` plugin *is* the tenancy model from D2, so it replaces a hand-rolled `accounts` table rather than sitting beside one. Devices never touch it. |
| D9 | **Enrichment is asynchronous and additive.** A disk is mountable the instant its bytes land; metadata and artwork arrive later, field by field. | Playing a game must never wait on IGDB. It is also the only workable design given external rate limits: 18,000 disks against ~4 req/s is hours of work. |
| D10 | **One disk resident at a time**, exactly as upstream: a 1.44 MB FAT12 volume in PSRAM holding a single image. A swap is a fresh fetch plus a USB re-enumeration. | Parity with the linked projects. Sidesteps the FAT12 cluster ceiling entirely, and a ~2 s swap is nothing on a 30-year-old machine. |

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
Postgres schema (`drizzleAdapter(db, { provider: 'pg', schemaName: 'auth' })`) so the
generated tables never mix with the catalog.

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
                    -- PK (org_id, sha256). Proves this tenant uploaded
                    -- these exact bytes. Gates every presigned GET.

games               id, org_id, title, sort_title, year, publisher,
                    developer, genre, chipset, notes, cover_asset_id,
                    metadata_source, external_ids jsonb, created_at
                    -- a release: one or more disks

disks               id, game_id, org_id, disk_no, sha256, label,
                    tosec_name, is_boot
                    -- ordered members of a set; disk_no drives the -N filename

assets              id, org_id, kind ('cover'|'screenshot'), storage_key,
                    width, height, byte_size, source
                    -- covers are constrained at render time to <=500 KB, <=2000px

devices             id, org_id, name, token_hash, firmware_version,
                    last_seen_at, rssi, psram_free, mounted_game_id,
                    mounted_disk_no, status
pairing_codes       code (6 chars), org_id, created_by_user_id,
                    expires_at, consumed_at
mount_jobs          id, device_id, org_id, game_id, disk_no,
                    state ('queued'|'claimed'|'done'|'failed'),
                    created_at, claimed_at, completed_at, error
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
  then `presignUrl(token, { operation: 'put', allowOverwrite: false })`. The size cap and
  path scope mean a leaked token cannot be used to upload anything else.
- Download: `presignUrl(token, { operation: 'get', validUntil: now + 15min })`. Served via
  Vercel's CDN by default.

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
Long-poll. Holds up to **25 s**, then returns `204` and the device reconnects.

```jsonc
// 200 — work to do. Exactly one disk per job (D10).
{
  "job": "mnt_01H...",
  "game": "Project-X",
  "disk": {
    "n": 1, "of": 4,
    "name": "Project-X-1.adf", "size": 901120,
    "sha256": "a71f0c9e…",
    "url": "https://<store>.private.blob.vercel-storage.com/adf/a71f…?sig=…"
  },
  "expiresAt": "2026-08-23T21:19:00Z"
}
```

Swapping to disk 2 is simply another job carrying `disk.n = 2`. The device does not track
sets and does not pre-fetch; it holds one image and replaces it on command.

Presigned URLs are embedded in the poll response rather than served via a `302`, so the
firmware never has to follow a cross-host redirect.

### `POST /api/device/status`
Heartbeat and completion: `{ job, state, mountedDisk, psramFree, rssi, error? }`.
Updates `devices` and closes the `mount_jobs` row.

**Long-poll over WebSockets.** Vercel now supports WebSockets, but long-poll is far simpler
on the ESP32, survives NAT and captive portals better, and on Fluid Compute a held
connection costs provisioned memory rather than active CPU. Revisit only if 25 s latency
proves annoying.

---

## 8. Firmware

Fork of `dimitrihilverda/Gotek-Touchscreen-interface` → `Gotek_WiFi_Dongle` (MIT).
Target: Seeed XIAO ESP32-S3, 8 MB PSRAM, 8 MB flash, ~$7.

What upstream already gives us: TinyUSB MSC, a hand-built FAT12 volume in PSRAM, a
zero-copy `streamToBuffer()` that writes an HTTPS GET straight into the RAM disk, and
`WIFI_AP_STA` so the device can be an AP and a station at once.

What we add:

1. **`wifi_provision.h`** — captive portal on first boot; SSID/password to NVS.
2. **`pairing.h`** — the 6-digit code from the portal, exchanged once for a device token.
3. **`cloud_client.h`** — long-poll, JSON parse, sequential fetch of each disk.
4. **Real TLS.** Upstream calls `setInsecure()`. Replace with a pinned CA bundle for the
   blob host and the API host.
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

Next.js App Router, shadcn/ui, Tailwind. Design published at
`design/` (artboards) — Direction A as default with Direction C as a toggle.

- **Library** — cover grid, faceted sidebar, `/` search over title, publisher, SHA **and
  original filename**, sorted recently-added by default.
  Table view toggle for keyboard-driven search across thousands of disks.
- **Game detail** — multi-disk selector that doubles as the **swap control** (clicking
  disk 2 mid-game queues the swap; ~2 s later the Amiga sees the new disk), mount action,
  TOSEC identity and provenance,
  and a preview of the exact `/ADF/<Game>/` tree and `.nfo` the device will see.
- **Devices** — status, PSRAM budget, pairing flow, OTA, activity log.
- **Ingest** — dropzone, CLI instructions, live run progress, review queue.

Covers render through Next `<Image>` but must be **exported** within the firmware's
verified hard limits when written to an SD card: **≤500,000 bytes, ≤2000×2000 px**, JPEG
or PNG. Ideal aspect ≈1.23:1 to fill the device's 138×112 box without letterboxing.
`.nfo` files are truncated to **512 bytes** — the firmware reads no further.

---

## 12. Non-goals

- No compression at rest or in transit in v1 (§3.2).
- No LAN push path. D1 chose cloud-pull; adding push later is additive.
- No public sharing of libraries between tenants. Blobs are deduped, entitlements are not.
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
| ESP32-S3 HTTPS throughput unknown | Medium. Published figures vary from 300 KB/s to several MB/s; TLS handshakes alone have been measured over 3 s. | Bench on real hardware as the first firmware milestone. Reuse the TLS session across disk fetches — with one disk resident, swap latency is now on the critical path. |
| Presigned URL TTL vs slow fetch | Low | 15 min is ample for a single 880 KB fetch. Device re-polls if a URL expires. |
| Vercel Blob private storage is public beta | Low–medium | The `DiskStore` seam (§6) is the hedge. |
| Copyright posture of a multi-tenant host of game images | Real, and the operator's call | Content addressing plus per-tenant entitlements means no cross-tenant distribution. Keep the deployment private/invite-only. |
| Self-hosting auth means we own password reset, email verification, session revocation and lockout | Medium — real work a hosted provider would have done for us | Better Auth ships all of it; the cost is configuring and testing it rather than writing it. Budget a milestone for the account-lifecycle flows and their emails. |
| Auth emails need a sender | Low | Resend, added via the Marketplace when the email milestone lands. |

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
