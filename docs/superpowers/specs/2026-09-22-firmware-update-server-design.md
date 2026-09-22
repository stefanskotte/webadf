# Firmware update: the server half — design

**Date:** 2026-09-22
**Status:** approved by the operator 2026-09-22, ahead of implementation
**Increment:** 2a of the firmware-update work. 2b is the firmware itself (A/B
slots, download, verify, flash, rollback), which needs a board on the bench.

Builds on `2026-09-22-firmware-release-registry-design.md` (increment 1), which
made the reported version identify a build and refreshed it on every heartbeat.
That is what makes "did the update take?" answerable at all.

---

## 1. What this delivers

The operator's original request, minus the half that needs hardware: **select
devices in the Devices tab, press Update, and watch them converge**, with a
password confirmation and a verification afterwards.

An update here is **desired state, not a job**. The board already runs a
convergence loop — poll, see what it should be holding, fetch, verify, report
what it actually holds. Firmware is a second thing it should be running, so it
rides in the poll body the device already parses, is fetched through a route
that mirrors `/api/device/image/[sha256]`, and is confirmed by the heartbeat.

The alternative considered and rejected was an `update_jobs` table with its own
state machine: a second source of truth that must be kept consistent with the
first, whose payoff is fleet-scale observability that one board does not need.
The desired-state design is what such a table would sit on top of anyway.

### What it cannot prove

**No firmware implements this protocol yet.** Every test here drives a
*simulated* device — the e2e suite already holds a real bearer token via
`pairDevice`, so it can poll, download and report like a board. What that
proves is that the server never instructs a mounted board, never offers a
rollback, and reports honestly. It does not prove a board can flash itself.

This matters because the project has been here before: write-back's real device
protocol ended up differing from its spec text, and HANDOFF §4g had to become
the authority over it. **Expect this protocol to move when firmware lands.**
Build the server side to be revisable, and treat §4 below as a proposal rather
than a contract until a board has run it.

---

## 2. Decisions taken

**D1. The device declares its capability; the UI is gated on it.** The register
and heartbeat bodies gain `updateProtocol: number`. Absent or 0 means the board
cannot be updated, and **no Update control is rendered for it** — which is every
board today. Operator's choice, 2026-09-22, over an always-visible button that
refuses, and over keeping the work unmerged until firmware exists.

This is what lets the increment ship to production honestly before any firmware
exists: nothing false is ever on screen.

**D2. An update is queued, never refused, when a disk is mounted.** Setting
desired firmware always succeeds. The board applies it on its own next poll,
once nothing is mounted and the motor is off, and reports `queued` until then.
Operator's choice, 2026-09-22, over a 409 like Restore's.

This follows the 2026-09-13 ruling: a flash write parks core0 entirely
(`flash_safe_execute`), which is survivable for a 4 KB token write and not for
500 KB while the Amiga is reading a track. **The device enforces this itself**,
so it holds even when the server is wrong.

**D3. Anti-rollback is enforced on both sides.** The server refuses to target a
release whose `sequence` is below what the device currently reports, and the
sequence travels in the poll body so the firmware can refuse it independently.
A rule enforced only by the server is a rule a compromised server can skip.

**D4. Step-up auth is per batch, with no elevated window.** The confirm dialog
takes the operator's password; the request carries it and the server
re-verifies it before writing anything. There is no elevated session state to
time-box, leak or forget to expire.

The 2026-09-13 ruling asked for a time-boxed window "minutes, not the session"
and "per update rather than once per login". Verifying per request satisfies
both more simply than a window does. What it buys is precise and worth
restating: it defends against a stolen session cookie, and **nothing else** — a
compromised server can skip the prompt entirely. It is not a substitute for the
signature.

**D5. No auto-update opt-in flag in this increment.** The flag governs updates
nobody asked for, and every update here is a human pressing a button. Shipping
a switch with nothing behind it would be worse than shipping none. It arrives
with automatic updates, together with the device-side enforcement the ruling
calls for.

---

## 3. Data model

### 3.1 Columns on `devices`

| column | type | written by | note |
|---|---|---|---|
| `updateProtocol` | integer | device (register + status) | capability. Null/0 = cannot update |
| `desiredFirmwareVersion` | text | server (the Update action) | null = no update wanted |
| `desiredFirmwareSetAt` | timestamptz | server | |
| `desiredFirmwareSetByUserId` | text | server | who asked. The super-admin plane has no audit log and that gap is recorded as a known one; this increment does not repeat it |
| `firmwareUpdateState` | text | device (status) | `queued` \| `downloading` \| `applying` \| `failed`. Null = nothing in flight |
| `firmwareUpdateError` | text | device (status) | last failure reason, bounded |

No new table. An update is a property of a device, and the registry
(`firmware_releases`) already holds everything about the release itself.

### 3.2 Completion is derived, not reported

The device never says "I succeeded". **The update is complete when the device's
reported `firmware_version` equals `desiredFirmwareVersion`** — which the
heartbeat already carries, from increment 1. On that match the server clears
`desiredFirmwareVersion`, `firmwareUpdateState` and `firmwareUpdateError` in the
same write that records the version.

This is deliberate: a device that reports success is a device that can be wrong
about it. The version it is actually running is the only evidence that matters,
and it is evidence the board produces by running, not by claiming.

---

## 4. The device protocol

**Proposal, not contract** — see §1. A board has never run any of this.

### 4.1 Poll body gains an `update` object

Alongside the existing `version` and `desired`, `readDesired` emits:

```jsonc
"update": {
  "version":  "1.2.0+gabc1234",   // the exact string the board must end up reporting
  "sequence": 7,                   // for the board's own anti-rollback check
  "sha256":   "…64 hex…",          // of the .uf2
  "sizeBytes": 1068032,
  "signature": "…base64…",         // ed25519 over the sha256
  "keyId":     "wf-1138f25902223da4"
}
```

Absent when nothing is wanted. Emitted last in the body, after
`writeProtected`, so a truncated body loses it rather than losing the
load-bearing disk fields — the same ordering argument `DC_POLL_BODY_BYTES`
already makes. **A board that loses this field simply does not update**, which
is the safe direction.

### 4.2 Waking the device, without disturbing the mount

**Found while planning, and it decides the shape.** The poll long-holds for 25 s
and returns a body only when `desiredVersion` moves; otherwise it 204s, and a
204 carries no `update` object. So merely setting `desiredFirmwareVersion`
would never reach the board.

**Bumping `desiredVersion` is not the answer.** The device echoes it back as
`mountedVersion`, and the server decides an upload's `not_mounted`/`behind`
verdict from the last `mountedVersion` it heard (HANDOFF §4g). Bumping it to
announce a firmware change could strand an Amiga write that was mid-session —
a disk-integrity failure caused by an unrelated feature.

**The rule instead:** the hold releases early when `desiredFirmwareVersion` is
set **and** `firmwareUpdateState` is still null — that is, an update is wanted
and the device has not yet acknowledged it. The body returned carries the
unchanged `version` (so the device's disk logic is a no-op) plus the `update`
object. Once the device POSTs any state, the hold returns to normal.

Three properties this has, all of them load-bearing:

- **No busy loop.** Without the state check the poll would return immediately
  on every request for as long as the update stayed pending.
- **No auto-retry.** A device reporting `failed` has a non-null state, so it is
  not re-instructed. A human decides (§8).
- **Old firmware is unreachable by construction.** A board that never reports
  state could busy-loop the poll — but a board that cannot report state has no
  `updateProtocol`, so §5.1 step 5 refuses to target it in the first place. The
  capability gate protects the poll, not just the UI.

### 4.3 Download

`GET /api/device/firmware/[version]`, bearer-authed by `requireDevice`,
mirroring `/api/device/image/[sha256]`:

- 400 on a version that is not in the registry's format
- **404 when the version is not a published release** — not 403, so a caller
  learns nothing about what exists
- 503 when the blob is unavailable
- 200 streams the `.uf2` bytes

Unlike the image route there is **no per-org entitlement check**: firmware is a
product artifact, global by design (increment 1, D5), and every paired device
is entitled to the firmware it has been told to run. The authentication is the
boundary.

### 4.4 Status body gains two fields

`firmwareUpdateState` and `firmwareUpdateError`, both optional, following the
rule this schema already states: **absent means "not reported" and leaves the
column alone**; an explicit null clears it. Bounded at 32 and 200 characters.

---

## 5. The server actions

### 5.1 `POST /api/devices/firmware-update`

Body: `{ deviceIds: string[], version: string, password: string }`.

In order:

1. `requireOrg()` — the caller's session and org.
2. **Re-verify the password** through better-auth's email+password path. On
   failure: 401, and nothing is written.
   *Implementation caveat:* the obvious API mints a session as a side effect
   that must be discarded. If that proves awkward, verify the stored credential
   directly rather than bending the auth layer. **Confirm which, by running it
   — do not assume from the types.**
3. Every `deviceId` must belong to the caller's org. A device outside it is a
   404, never a 403.
4. The target `version` must be a published release. 404 otherwise.
5. Every target device must report `updateProtocol >= 1`. A device that cannot
   update is a 409 naming it — the UI does not offer the control for such a
   device, so reaching this means the page was stale.
6. **Anti-rollback:** refuse (409) any device whose currently reported version
   has a sequence *above* the target's. A device reporting an unrecognised
   build has no sequence, so it is allowed — that is the recovery path for a
   board running something hand-flashed.
7. Write `desiredFirmwareVersion` and the audit columns for every device that
   passed, in one statement.

**All-or-nothing.** If any device fails a check, nothing is written and the
response names which and why. A partial batch that silently updated three of
five would be the worst outcome of a multi-select.

### 5.2 Cancelling

`DELETE /api/devices/firmware-update` with `{ deviceIds }` clears the desired
firmware. No password: standing down is not the privileged direction.

It cannot recall an update a board has already applied — it clears intent, not
flash. The UI says so rather than implying otherwise.

---

## 6. The UI

**Selection.** A checkbox on each card whose device reports `updateProtocol >= 1`
and is **not already running the newest release** — which means `behind` *and*
`unrecognised`. The unrecognised case is deliberate and matches §5.1 step 6: a
board running something hand-flashed has no sequence, so nothing rules it out,
and offering it the update is the recovery path. A device reporting `current`
gets no checkbox; there is nothing to do to it.

Cards for devices that cannot update are unchanged — no checkbox, no dimmed
control, nothing to explain.

**The selection bar** appears when anything is selected: *"2 selected · Update
to 1.2.0"*, with Update and Clear. It names the version, not "latest", for the
reason the notice band already names the full version: two releases can share a
semver.

**The confirm dialog** lists every board by name with its current version, the
target version and its release notes, the security flag if set, and takes the
password. It says plainly that a board holding a disk will wait until it is
ejected.

**Per-card state**, extending the firmware line from increment 1:

| state | wording |
|---|---|
| `queued`, disk mounted | `update queued — waiting for eject` |
| `queued`, nothing mounted | `update queued` |
| `downloading` | `downloading 1.2.0` |
| `applying` | `applying 1.2.0 — do not power off` |
| `failed` | `update failed — <reason>` |
| desired set, nothing reported yet | `update requested` |

**Liveness.** `desiredFirmwareVersion` and `firmwareUpdateState` join the
live-state fingerprint, so an open Devices tab follows an update without a
reload. Increment 1 shipped with this gap for the registry and it had to be
fixed in review; it is designed in here.

---

## 7. Testing

**Vitest** — the pure rules: which devices a batch may target, anti-rollback
against a reported sequence, the state-to-wording mapping, and completion
detection (reported version equals desired ⇒ clear).

**E2E, with a simulated device.** The suite already holds a real device bearer
token, so one test drives the whole loop: pair → report `updateProtocol: 1` →
operator selects and confirms with a password → device polls and receives the
`update` object → device downloads through the real route → device reports
`downloading`, then `applying` → device reports the new version → server clears
the desired state and the card reads up to date.

Specifically asserted:
- a wrong password writes nothing and returns 401;
- a device in another org is a 404;
- a rollback target is a 409 and writes nothing;
- one failing device in a batch leaves **all** of them unwritten;
- the download route 404s for an unpublished version;
- a device with no `updateProtocol` gets no checkbox.

**Not proven:** anything the firmware does. Stated in the HANDOFF entry too.

---

## 8. Open for the operator

- **Whether a failed update should retry automatically.** This spec does not:
  a board reports `failed`, the state persists, and a human decides. Automatic
  retry against a board that just failed to flash is how one bad release
  becomes a bricked fleet.
- **Whether to keep a history of updates** beyond the current desired state.
  The registry records releases and the device records what it runs; nothing
  records "this board was updated on this date by this person" after the fact.
  The audit columns are overwritten by the next update. This is the same gap
  the super-admin plane has, and it is acceptable at one operator for the same
  reason.
