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

The operator's framing, recorded because it is the product decision and not merely a
technical one: *"Gotek owners have disks on their local USB, but it's something we moved to
a webservice. This solution isn't for everyone, but I like that I can have my whole ADF
library in one place and attach WiFi floppies to it. This is the selling point and a
divider too."* The dependency is deliberate and it is the feature. What is not acceptable
is for that dependency to reach the Amiga.

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

**Ruling on observability (operator, decided).** A queue would have given a natural audit
trail. **We do not want one.** `devices.last_error` / `last_error_at` carry the only thing
the UI needs for a one-disk device — why the most recent attempt failed — and mount history
is not a feature of this product. No `device_events` log, now or later.

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
disk is by definition a different sha256, so a naive implementation makes every save a
wholly new 880 KB blob and defeats D3's dedupe for exactly the disks that get written most.

**Backlog — layered disks (operator's idea).** Model a written disk the way a container
image is modelled: an immutable base blob plus a stack of diff layers, each recording only
the tracks a write changed. Three things fall out of it, and the third is the interesting
one:

* **Dedupe survives writing.** The base stays content-addressed and shared across tenants;
  only the delta is per-org. A Workbench disk written a hundred times costs one shared base
  plus a hundred small deltas, not a hundred 880 KB blobs.
* **History for free.** The layer stack *is* the history of that disk.
* **Rewind.** Materialise the disk at any layer and mount it. Undo a corrupted save, roll a
  Workbench back past a bad install, keep a save-disk's states as named points. The
  operator notes he has not seen this anywhere in floppy emulation, and that is right — a
  Gotek writes through to the USB stick and the previous state is simply gone.

Not this plan, and not the write plan's first increment either. But write-back should not be
designed in a way that forecloses it: the first version should record *which tracks changed*
rather than only storing a flattened result.

**Backlog — an ADF browser, and Time Machine for disks (operator's idea).** A file browser in
the web UI that reads the AmigaDOS filesystem out of a stored ADF and shows its directory
tree, with a scrubber to move between a layered disk's versions the way Time Machine moves
between backups: pick a point in history, see the disk as it was, restore or mount it.

This decomposes into two independently useful pieces, and **only the second depends on
layers**:

1. **Read-only ADF browser — buildable today, blocked on nothing.** Parse OFS/FFS from the
   880 KB image: boot block, root block, bitmap, directory and file-header blocks. Answers
   "what is actually on this disk?" without mounting it, which is immediately useful for the
   412 unmatched disks in the review queue — a disk whose TOSEC name is unknown often
   identifies itself instantly from its file list. Pure logic over bytes we already store, so
   it tests like `adfmfm` does. `mfm.c` already cites the reference:
   http://lclevy.free.fr/adflib/adf_info.html
2. **The version scrubber** — needs layered disks to have versions to scrub through, and the
   browser from (1) to render each one. With both, a diff between two layers is a set of
   changed files rather than a set of changed tracks, which is what makes the history legible
   to a person rather than to a debugger.

Worth building (1) before write-back rather than after: it is the tool you would want in
order to *verify* that a write-back actually wrote what you expected.

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

### Authorization — and an accepted risk this route makes live

The endpoint checks that **the device's organization holds an entitlement for the requested
sha256** — not merely that the sha256 exists. That is the correct boundary *for the device*:
it stops a compromised or malicious device from enumerating the store or fetching anything
its organization has not claimed.

**It does not close the ingest oracle, and this design does not pretend otherwise.**

`/api/ingest/check` is deliberately global (D13): it queries `blobs` with no org scoping,
because that is what lets one stored copy serve every tenant and it is the whole storage
saving of D3. The consequence is that a client never proves it holds the bytes — knowing a
sha256 is enough to claim a disk and receive an entitlement. Amiga disk hashes are not
secret; TOSEC publishes them for thousands of titles.

Until now that was harmless, exactly as the parent spec's §5 says: an entitlement *records
a claim, it does not prove possession*, and no route handed bytes back. **This is that
route** — and `adfmfm`'s `decodeDisk` turns the MFM it serves straight back into a pristine
ADF. So the path exists: look up a published hash, claim it, mount it to your own device,
download, decode.

An entitlement check cannot stop this, because the attacker holds an entitlement — obtained
fraudulently, but real.

**Ruling (operator, decided): ship it.** The only thing bounding the attack is D13,
invite-only registration, and the parent spec already records that this property "holds
socially rather than technically". Every account on this deployment is invited by the
operator. The residual exposure is that an invited user could extract disks belonging to
other tenants using published hashes.

**The known fix, if registration is ever opened:** proof of possession at ingest. When a
client claims a hash that already exists, the server names a random byte range of the
stored blob and the client must return its hash. A claimant holding only the digest cannot
answer. Dedupe is untouched — still no upload — at the cost of one round trip on the
already-exists path, and three clients to update (the route, the CLI, the browser
dropzone). That converts the property from social to technical. **Do not open registration
without it.**

A tighter device rule was considered — serve only the currently-desired sha256 — and
rejected: it 403s a legitimate retry when a human changes the mount mid-fetch, and it does
nothing about the oracle, which is the actual exposure.

## 7. UI

- **Devices page** — each device shows its actual mounted disk, its desired disk when they
  differ, `last_seen_at`, and `last_error`. An eject button.
- **Game detail** — a disk selector; mount any disk of the set to any paired device.
- **Write-protect toggle** — on the disk row, next to mount.

The UI must never present desired state as fact. A device that has not been seen for
minutes with a pending desired change reads as *requested*, not *mounted*.

---

## 8. Delivery: two plans

Split along the same seam plan 2 used, which worked: protocol first, provable without
hardware; UI second.

**Plan 3a — device protocol.** The schema migration (§3), the three device endpoints (§4),
the human-facing mount/eject actions, and a reference client that drives the whole flow end
to end. Done when a reference client can be told to mount a disk, fetch its `WFMF`, report
success, be ejected, and have every one of those states verified — with no hardware
involved.

**Plan 3b — UI.** Devices page, game-detail disk selector, write-protect toggle, and the
desired-versus-actual presentation of §7.

**Blocking item for 3a, carried from plan 2.** `requireDevice()` throws a `DeviceAuthError`,
but plan 2's prose said it throws a `Response(401)`. Nothing consumes it yet, so the
divergence has been harmless. **The endpoints in §4 are its first consumers**, and a
`catch (e) { return e }` against the wrong assumption yields a 500 where a 401 belongs.
Reconcile it in 3a's first task, before any endpoint is written.

---

## 9. Out of scope, and one thing worth naming

Not built here: write-back and layered disks (§5); the firmware poll loop and PSRAM
double-buffering (§1); proof of possession at ingest (§6). Mount history is not deferred —
it is declined (§2).

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
