# Device plane — disk change

**Addendum to `2026-08-23-webadf-design.md`.** That spec remains the binding authority;
this one completes its §7 device protocol and supersedes the parts of it that D14/D15
invalidated. It also expands D10's "one disk at a time" into an explicit model of what
happens when that disk changes.

**Scope:** webadf only. Mount, eject, the three device endpoints, write protection, and
the UI to drive them. The firmware is a separate plan — this design constrains it but
does not implement it.

---

## 1. The property this design exists to preserve

A Gotek with a USB stick has no network dependency: both serving a disk and swapping one
are always available. wifi-floppy trades some of that away for a library you can browse
from a phone. The trade has to be bounded, and the bound is this:

> **Losing the webservice degrades disk *swapping*, not disk *serving*.**

The whole disk lives in the device's PSRAM (D14/D15). Once it is loaded the network is out
of the picture entirely — there is no code path that fetches a track mid-operation. So a
webservice outage, a WiFi drop, or a dead router means *you cannot change disks until it
comes back*. It never means the Amiga sees a disk vanish mid-game, and it never means a
crash. When the service returns, the next successful poll swaps the disk.

Three rules follow, and every part of this design serves them:

1. **The mounted disk is sticky.** Only a *successful* poll carrying a definite desired
   state may change what the Amiga sees. A timeout, a 5xx, a dropped connection or an
   unreachable host changes nothing. There is no failure mode in which the absence of a
   signal causes an eject — an eject requires an explicit `desired: null`.
2. **Fetch before transition.** The currently mounted disk keeps serving until the
   replacement is fully in PSRAM and verified. A failed fetch leaves the current disk
   untouched and the device retries. **This forbids the obvious eject→fetch→insert
   ordering**, which would leave the Amiga diskless for the several seconds of a 2 MB
   transfer, and diskless indefinitely if the transfer failed.
3. **The server states intent, never timing.** The protocol says *what* should be mounted.
   It never says *when* to eject. That is the device's business, and it is what leaves the
   firmware free to double-buffer.

Rule 2 needs two image slots in PSRAM. Each slot is `160 * TRACK_SLOT_BYTES` = 2,129,920
bytes, and `psram_image.h` records that the 8 MB part holds three of them "with room
over" — so the budget for two exists today. Implementing it is firmware work.

---

## 2. Reconciliation, not a job queue

The device holds exactly one disk (D10). "What should this device have mounted?" therefore
has exactly one answer at any instant — a **state**, not a queue.

`devices` carries a desired state; the device polls it, compares it to what it holds, and
converges. Mount sets it. Eject nulls it.

**Why not a job queue.** Plan 2 created a `mount_jobs` table for this, and it is the wrong
shape. Consider a failed fetch under a queue: the device has already ejected, the job is
marked `failed`, the database still says disk 1 is mounted, and nothing reconciles the two.
Under a desired-state model the device simply keeps polling and converges — which is
exactly the recovery behaviour §1 demands. Reconciliation is also idempotent across missed
polls, reboots and duplicate deliveries, none of which a queue survives without extra
machinery.

`mount_jobs` is dropped. Its task in plan 2 (Task 5) was never started, so no reviewed
logic is lost — only an unused table and its migration.

**Ruling on observability.** A queue would have given a natural audit trail. Under
reconciliation, `devices.last_error` / `last_error_at` carry the one thing the UI needs for
a one-disk device: why the most recent attempt failed. If a full history is ever wanted,
the additive change is an append-only `device_events` log written when desired state
changes and closed by the status callback. Not built now.

---

## 3. Data model

| Table | Change | Note |
|---|---|---|
| `disks` | `write_protected boolean not null default true` | See §5 |
| `devices` | `desired_sha256`, `desired_game_id`, `desired_disk_no` — all nullable | Null = ejected |
| `devices` | `desired_version integer not null default 0` | Monotonic; bumped on every change. Drives the long-poll |
| `devices` | `desired_set_at timestamptz` | For "requested 4m ago, still not mounted" |
| `devices` | `mounted_sha256` nullable | What the device last **reported** |
| `devices` | `last_error text`, `last_error_at timestamptz` | Where a failed mount surfaces |
| `mount_jobs` | **dropped** | §2 |

`devices.mounted_game_id` and `mounted_disk_no` already exist and keep their meaning:
last reported actual. **Desired and actual are deliberately separate columns.** Collapsing
them would make "Disk 1 mounted, Disk 2 requested, device last seen 4 minutes ago"
unrepresentable, and that is precisely the state a human needs to see when the service has
been unreachable.

`write_protected` lives on `disks`, which is org-scoped — **never on `blobs`**, which is
global and content-addressed. 26 blobs are already shared across organizations, so a flag
there would silently apply one tenant's choice to every other tenant holding the same disk.

---

## 4. Protocol

### Device-facing — `Authorization: Bearer <device-token>`

**`GET /api/device/poll?since=<version>`**

Returns immediately when `desired_version > since`, otherwise holds up to **25 s** and
returns `204`. The device reconnects either way.

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

`version` is opaque to the device beyond being the value to send back as `since`. A device
that has never polled sends `since=0` and gets current state immediately.

**`GET /api/device/image/<sha256>` → `200 application/octet-stream`**

The `WFMF` container, encoded on demand (§6). Defined by
`wifi-floppy/firmware/src/image_loader.c`; the format is specified in
`2026-08-29-adfmfm-encoder-design.md` §4.

**`POST /api/device/status`**

```jsonc
{ "mountedSha256": "a71f0c9e…" | null, "version": 7,
  "error": null, "psramFree": 6127616, "rssi": -58 }
```

Updates `mounted_*`, `last_seen_at`, `rssi`, `psram_free`, and clears or sets
`last_error`. The device posts this after every transition and as a heartbeat.

### Human-facing — Better Auth session

- `POST /api/devices/[id]/mount` — body `{ diskId }`. Sets desired, bumps `desired_version`.
- `POST /api/devices/[id]/eject` — nulls desired, bumps `desired_version`.
- `PATCH /api/disks/[id]` — body `{ writeProtected }`.

All three are org-scoped: the device and the disk must both belong to the caller's
organization, checked in the same statement, not merely in a `WHERE`.

---

## 5. Write protection

`disks.write_protected` defaults to **true**. The rationale is the operator's: multi-disk
games shipped read-only and should stay that way; save disks, Workbench and utility disks
have an implied need to be writable. Defaulting to protected means the destructive
direction requires a deliberate act.

The flag is carried in the poll payload from day one, so the firmware has something to
drive `WPROT` from the moment writing lands and the protocol does not need revising then.
**It is inert today** — `main.c` asserts `WPROT` unconditionally and `http_post_track()`
is a stub.

Write-back itself is **backlog**, deliberately. Accepting modified tracks means deciding
what a write does to a content-addressed, cross-tenant-deduplicated store: the modified
disk is by definition a different sha256, so it is a new blob and a new `disks` row, not an
update. That is a real design problem and it is not this plan's.

---

## 6. The image endpoint

### No cache

`INTEGRATION.md`'s open question 3 assumed encoding was expensive enough to justify caching
the ~2 MB result beside the ADF, roughly tripling library storage. **Measured, `encodeDisk`
takes 9.6 ms** (mean of 20 runs on a real 901,120-byte ADF, ~10 MB heap). A mount is: fetch
880 KB from Blob, encode for ~10 ms, stream 2,027,536 bytes out — well under a second of
function time, for something that happens a few times an hour.

So the endpoint encodes on the fly and there is no cache to build, invalidate or pay for.
`ENCODER_VERSION` is exported from `adfmfm` and belongs in an `ETag` if CDN caching is ever
wanted; nothing needs it now.

### Authorization — this is the route that makes the ingest oracle real

`/api/ingest/check` is deliberately a global cross-tenant existence oracle (D13): that is
what makes one stored copy serve every tenant, and it is the whole storage saving of D3.
The accepted risk was bounded by there being **no download route**. This is that route.

The endpoint therefore checks that **the device's organization holds an entitlement for the
requested sha256** — not merely that the sha256 exists. Knowing a digest must not confer
access to its bytes.

A tighter rule was considered — serve only the currently-desired sha256 — and rejected: it
returns 403 on a legitimate retry when a human changes the mount mid-fetch. Entitlement is
the right boundary, and it already prevents enumeration.

---

## 7. UI

- **Devices page** — each device shows its actual mounted disk, its desired disk when they
  differ, `last_seen_at`, and `last_error`. An eject button.
- **Game detail** — a disk selector; mount any disk of the set to any paired device.
- **Write-protect toggle** — on the disk row, next to mount.

The UI must never present desired state as fact. A device that has not been seen for
minutes with a pending desired change reads as *requested*, not *mounted*.

---

## 8. Out of scope, and one thing worth naming

Not built here: write-back; the firmware poll loop and PSRAM double-buffering; a
`device_events` audit log.

**Resident sets — the honest answer to "a Gotek is safer".** PSRAM holds three 2,129,920-byte
image slots. A two- or three-disk game could be entirely resident, at which point swapping
*within that set* needs no network at all and the Gotek gap closes for the case that
matters most. This design keeps `desired` scalar because D10 still holds — one disk is
*mounted* at a time — but the extension is purely additive: a `preload: [sha256, …]` array
alongside the scalar `desired` in the poll payload, and a device-side button or an Amiga-
side signal to advance within the resident set. Nothing in this protocol precludes it.

The parent spec's §13 already floated a hardware button advancing through a disk set and
deferred it. Under D14 the same escape hatch exists on the RP2350 board, and resident sets
are what would make it instant rather than a 2-second fetch.
