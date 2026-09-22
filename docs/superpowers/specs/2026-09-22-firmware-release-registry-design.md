# Firmware release registry and honest versions — design

**Date:** 2026-09-22
**Status:** approved by the operator 2026-09-22, ahead of implementation
**Increment:** 1 of 2. Increment 2 is the OTA update path itself (A/B slots, signed image
download, step-up auth, per-device opt-in, the multi-select Update button).

---

## 1. What prompted this

The operator asked for two things in the Devices UI:

1. a callout that firmware upgrades are pending, and
2. multi-select devices plus an Update button, with verification afterwards.

Neither can be built yet, for a reason worth stating plainly: **the board has no way to
update itself.** There is no OTA path in the firmware — no second flash slot, no image
download, no verify-and-boot, no rollback. `config_store.c` and `token_store.c` each write
a single 4 KB sector at the top of flash, and that is the entire extent of flash-writing
code in the firmware.

So the work splits. This spec is the half that can be built and verified today with zero
risk of bricking a board, and that makes the other half safe to build: **a firmware version
you can trust, and a registry that knows what the current release is.**

### The two gaps this closes

**The version is captured once, at pairing.** `firmwareVersion` is sent in the registration
body (`src/app/api/device/register/route.ts`), stored in `devices.firmware_version`, and
rendered by `device-card.tsx` as `fw <version>`. The status heartbeat carries
`mountedSha256`, `mountedDiskId`, `version`, `error`, `psramFree` and `rssi` — not the
firmware version — and a device does not re-register after a reflash. The value in the
Devices tab is therefore whatever the board had when it was paired.

This is worse than showing nothing, because it looks authoritative. "Did the update take?"
is the first question anyone asks after an update, and this field would answer it
confidently and wrongly.

**The version identifies nothing.** `FIRMWARE_VERSION` is a hand-set CMake cache string.
It has read `4b.0` / `4b.0-dev` through every firmware change in the project's history —
the display work, the capture work, the decoder work, SEL0 gating, all three write-back
pieces. A version that does not change when the image does cannot support rollout,
rollback or anti-rollback, all of which increment 2 depends on.

The board currently on the bench reports `verify-a286680`, a value a previous session set
by hand for one verification run and which is still cached in `build/CMakeCache.txt`. That
is the failure mode in miniature: the version says whatever someone last typed.

---

## 2. Decisions taken

Recorded here because a decision made months before the code that depends on it is exactly
what drifts.

**D1. Semver by hand, git identity automatic.** `FIRMWARE_VERSION` stays a hand-set semver
in `CMakeLists.txt`, starting at `1.0.0`. The build appends the short git commit hash and,
when the tree is dirty, a `-dirty` marker: `1.0.0+gd16a1da`, `1.0.0+gd16a1da-dirty`. Two
different images can then never claim the same version even when someone forgets to bump,
which is precisely how `4b.0-dev` came to identify everything.

Operator's choice, 2026-09-22, over plain semver and over a fully date-derived build
string.

**D2. The registry decides what "behind" means, not a version comparison.** Each published
release gets a server-assigned monotonic `sequence`. A device's reported version string is
looked up in the registry; it is behind when its sequence is lower than the newest
release's. A string that is not in the registry is reported as an **unrecognised build**,
never as up-to-date and never as behind.

The alternative — parsing semver on both sides and comparing — reads simpler and lies in
the case that will be most common on the bench: `1.0.0+gd16a1da-dirty` compares equal to
released `1.0.0`. The registry lookup can say "I don't know this build", which is true.

The sequence number is also exactly what increment 2's anti-rollback rule needs, so it is
not scaffolding.

**D3. Releases are signed offline, with a key that is not on the server.** Operator's
choice, 2026-09-22, consistent with the ruling recorded in HANDOFF on 2026-09-13. An
ed25519 private key lives at `~/.webadf/firmware-signing-key` on the operator's Mac,
outside the repository and outside the deployment. The public key is committed to the
repo in this increment and compiled into the firmware in increment 2.

TLS is not a substitute. The device already verifies the server's chain against pinned
roots, and that protects the wire; it does nothing about a compromised Vercel account or a
poisoned deploy pipeline. With offline signing, whoever owns the pipeline can push a
*stale* image and nothing worse. Anti-rollback closes the stale case, in increment 2.

**D4. Sign and store the artifact now, even though nothing downloads it yet.** Increment 1
does not serve firmware to any device. The publish path still uploads the artifact to
private blob storage and records its signature, so that increment 2 adds a download route
rather than re-publishing and re-signing every release that exists by then.

**D5. The registry is global, not per-org.** Firmware is a product artifact; devices belong
to orgs. Publishing requires super-admin (`SUPERADMIN_EMAILS`). Reading the release list,
and seeing whether your own devices are behind, requires only org membership.

**D6. No Update button in this increment.** Showing a control that cannot work is worse
than showing none. The Devices tab gains information only.

---

## 3. What gets built

### 3.1 Build identity that cannot go stale

`CMakeLists.txt` keeps `set(FIRMWARE_VERSION "1.0.0" ...)` as the hand-maintained part. A
generated header `firmware_version.h` carries the full string, produced by an
`add_custom_command` that runs **on every build**, not at configure time.

Configure-time generation is the trap here: switching commits without re-running CMake
would silently keep the old hash, which is the same class of bug the whole increment
exists to remove. The custom command shells out to `git rev-parse --short HEAD` and
`git status --porcelain` on each build and rewrites the header only when the value
changes, so it does not force a full relink every time.

When git is unavailable or the directory is not a work tree, the suffix becomes
`+nogit` rather than failing the build — a firmware build must not depend on the presence
of a VCS.

### 3.2 The heartbeat carries the version

**Firmware.** `dc_report_status` gains one field in its JSON body.

The body buffer is already tight and this matters. `DC_STATUS_BODY_BYTES` is 512. A
worst-case body — 256-byte error string, 64-character disk id, 64-character sha, plus keys
— comes to roughly 496 bytes. Adding `"firmwareVersion":"1.0.0+gd16a1da"` overflows it,
and `dc_report_status` fails **quietly** on overflow (`return false`), so the heartbeat
would simply stop whenever an error string happened to be long. That is a silent,
state-dependent failure of the exact mechanism this increment adds.

`DC_STATUS_BODY_BYTES` goes to 640 and `DC_STATUS_REQ_BYTES` to 1152. Both buffers are
`static` (see the stack note in `device_client.c`), so the cost is .bss, not stack. A host
test asserts that a maximal body — longest error, longest ids, longest version — fits with
room to spare, so the next field added to this body fails a test instead of failing a
board.

**Server.** `statusBody` gains `firmwareVersion: z.string().min(1).max(64).optional()`.
`recordStatus` writes it when present, following the rule already established in that
schema's comments: an absent key parses to `undefined` and leaves the column alone, so a
partial report never wipes a known value.

No new column. `devices.firmware_version` already exists; it simply stops being
write-once.

The registration route already bounds the same value at 50 characters
(`register/route.ts`). Both bounds move to a single shared constant, so the two routes
cannot disagree about what a legal version string is — a board that could register with a
version it may not report would be a gap with no reason to exist.

**Validation posture.** The version is telemetry. Following the precedent set by `rssi` in
the same schema — where the range was widened deliberately so that a strange telemetry
value can never reject a whole report and with it the load-bearing `mountedSha256` — an
over-long or malformed version string must not fail the report. The field is bounded at 64
characters; anything longer is rejected by zod, so the firmware is responsible for never
sending one, and the host test above is what enforces that.

### 3.3 The release registry

New table `firmware_releases`:

| column | type | note |
|---|---|---|
| `id` | text pk | |
| `version` | text unique | the full string, e.g. `1.0.0+gd16a1da` |
| `sequence` | integer unique not null | server-assigned, max+1 at publish |
| `semver` | text not null | the hand-set part, `1.0.0` |
| `sha256` | text not null | of the uf2 artifact |
| `sizeBytes` | integer not null | |
| `blobPath` | text not null | private blob storage pathname |
| `signature` | text not null | ed25519 over the artifact's sha256, base64 |
| `signingKeyId` | text not null | which public key verifies it |
| `notes` | text | release notes, shown in the UI |
| `security` | boolean not null default false | a release that matters |
| `publishedAt` | timestamptz not null default now() | |
| `publishedByUserId` | text not null | |

Publish-time rules, all enforced server-side:

- `sequence` is assigned as `max(sequence) + 1` inside the insert's transaction.
- A semver lower than the current maximum is **refused**. Publishing 0.9.0 after 1.0.0 is
  always a mistake, and the registry is the ordering authority.
- A duplicate `version` is refused.
- A `-dirty` version is refused. A build whose source cannot be identified must not become
  something a fleet can be compared against.

### 3.4 Publishing, from the operator's Mac

One script, `scripts/firmware-release.ts`:

1. refuse if the git tree is dirty;
2. build the firmware (or accept a path to an already-built `.uf2`);
3. read the version out of the generated header — never from an argument, so the published
   version is by construction the one in the image;
4. sha256 the artifact;
5. sign the sha256 with the ed25519 key at `~/.webadf/firmware-signing-key`, refusing to
   continue if the key is absent rather than publishing unsigned;
6. upload the artifact to private blob storage;
7. `POST /api/admin/firmware/releases` with the metadata.

A companion `scripts/firmware-keygen.ts` generates the keypair once, writes the private key
with mode 0600, and prints the public key for committing to `wifi-floppy/firmware/keys/`.

### 3.5 The Devices tab

**A notice band above the cards** when any device in the org is behind: *"2 of 3 devices
have a firmware update available — 1.2.0"*, with the release notes reachable. When the
newest release is flagged `security`, the band says so and is styled with the amber
treatment already used for the stale-device state, not with a colour invented for it.

**Per-card firmware state**, on the existing identity line that already renders
`fw <version>`:

| state | shown when | wording |
|---|---|---|
| up to date | reported version is the newest release | `fw 1.2.0+gd16a1da · up to date` |
| behind | reported version has a lower sequence | `fw 1.0.0+g47ab030 · 2 releases behind` |
| unrecognised | reported version is not in the registry | `fw verify-a286680 · unrecognised build` |
| unknown | no version reported at all | `fw unknown` |

`firmwareVersion` is already part of the live-state fingerprint (`src/lib/live-state.ts`),
so a board that reflashes updates every open browser without a reload. That is worth
naming as a thing already paid for, not a thing to build.

**A read-only `/admin/firmware`** listing published releases, newest first, with version,
sequence, size, notes, the security flag and who published each.

---

## 4. What this increment does not protect against

Stated explicitly so nobody reads more safety into it than is there.

- **Nothing here updates any device.** No firmware is served, downloaded or flashed.
- **The signature is recorded but never verified.** No code checks it until increment 2
  compiles the public key into the firmware. It is stored so the chain of custody starts
  now, not because it is being enforced now.
- **A super-admin can publish anything.** The registry trusts whoever holds
  `SUPERADMIN_EMAILS` and a signing key. Step-up auth arrives with the update mechanism it
  is meant to gate, in increment 2.
- **"Behind" is a claim by the device about itself.** A board reports its own version
  string; nothing cryptographically attests it.

---

## 5. Testing and acceptance

**Vitest** — sequence assignment and the publish-time refusals (lower semver, duplicate
version, dirty version); the four-way firmware-state classification, including the
unrecognised case; the status schema accepting an absent version and leaving the column
alone.

**Firmware host tests** (`pnpm firmware:test`) — the status body with a maximal error
string, maximal ids and a maximal version fits the enlarged buffer; the body contains the
version field; a body that would overflow is detected by a test rather than by a silent
`return false` on hardware.

**Playwright** — the notice band appears when a device is behind and not when it is not;
the unrecognised-build wording; `/admin/firmware` is refused to a non-admin.

**Hardware acceptance, on the attached board.** This is the step that proves the chain,
and the board being on the bench is why this increment is being done now:

1. Build with the new version scheme; confirm the generated header carries the git hash.
2. Flash over USB (`picotool load -f` — the board reboots itself into BOOTSEL, so this
   needs no physical access).
3. Watch the Devices tab show the new version, arriving from a **heartbeat** rather than
   from pairing — verified by confirming the board did not re-register.
4. Publish a release with a higher semver than the board is running.
5. Watch the notice band and the per-card "1 release behind" appear, without a reload.
6. Confirm the board's own serial log shows the status POSTs succeeding, so the enlarged
   body is not being rejected.

Step 3 is the one that could not be done before: it distinguishes "the version is fresh"
from "the version is left over from pairing", which is the entire point of the increment.

---

## 6. Open for the operator

- **The starting semver.** This spec assumes `1.0.0`. The firmware has been through plans
  4a, 4b, 5 and three write-back pieces, so an argument exists for `1.0.0` meaning "the
  first release that can be tracked" rather than "the first firmware". Nothing depends on
  the choice except what the Devices tab reads.
- **Whether `/admin/firmware` should allow publishing from the browser.** This spec keeps
  publishing to the script, because the signing key is on the Mac and a browser publish
  would either skip the signature or need the key uploaded. Raised because it is the
  obvious next request.
