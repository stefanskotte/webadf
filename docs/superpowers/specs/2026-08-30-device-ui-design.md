# Device UI — plan 3b

**Addendum to `2026-08-29-device-plane-disk-change-design.md`**, whose §7 sketched this in
four lines. That spec remains the binding authority for the protocol; this one designs the
human-facing half of it. Plan 3a built the endpoints; nothing yet drives them from a browser.

**Scope:** two pages, the components they need, and the queries behind them. No new
endpoints — 3a's are sufficient and this plan must not add to them.

---

## 1. Two pages that are already linked and already 404

Both of these are live defects, not new features:

- **`src/components/shell/top-nav.tsx:7`** links `/devices`. The page does not exist.
- **`src/components/library/game-grid.tsx:22`** links every game card to `/games/${g.id}`.
  That page does not exist either, so **every card in the library leads to a 404**.

Plan 3b closes both. Worth stating plainly so nobody reads the pages as speculative.

---

## 2. The state model

Spec §7 of the parent: *"The UI must never present desired state as fact."* That is the
whole design problem, because desired and actual genuinely differ for the seconds a mount
takes — and indefinitely when a device is unreachable.

A device is in exactly one of four states, derived from columns plan 3a added:

| State | Condition | Presented as |
|---|---|---|
| **empty** | no desired, no mounted | "No disk" |
| **converged** | `desired_sha256 === mounted_sha256` | "In the drive — *Project-X*, disk 1 of 4" |
| **pending** | they differ, and `last_seen_at` is within 60 s | The disk it still holds, plus "Mounting disk 2…" |
| **stale** | they differ, and `last_seen_at` is older than 60 s (or null) | "Requested disk 2 · device last seen 4m ago", plus `last_error` when set |

**Pending and stale carry identical data.** The only difference is whether the device is
still talking to us. Collapsing them would report a mount as in progress when the device has
been powered off since yesterday — which is exactly the misreading §7 forbids, and exactly
why the parent spec kept desired and actual in separate columns.

The 60 s threshold is chosen against the protocol, not by feel: the poll holds 25 s and
`touchLastSeen` fires once per poll request, so a healthy device refreshes `last_seen_at` at
least every 25 s. Sixty seconds is two missed polls plus slack — long enough that a single
slow reconnect does not flip a working device to "stale", short enough that a real outage
shows within a minute.

**This logic is pure and therefore unit-tested.** `deviceState(row, now)` in
`src/lib/device-state.ts` returns the discriminant and nothing else — no formatting, no JSX,
no database. It is the one part of this plan Vitest can own, and the four-way boundary
(especially the 60 s edge and a null `last_seen_at`) is worth a fixed-clock test.

---

## 3. Refresh

One client component, `<LiveRefresh active={…} />`, calling `router.refresh()` on a 5 s
interval **only while at least one device is non-converged**. When everything has converged,
or nothing is pending, it does not run.

Rejected: always-polling (a forgotten tab costs a request every 5 s overnight for nothing),
manual-only (you press a button to watch the one thing you actually want to see happen live),
and Server-Sent Events (a held connection and a new endpoint, for a page one person looks at
occasionally).

---

## 4. Mount targeting

The artboards assume one device, pinned top-right. With several paired, a mount needs a
target.

**A disk row's action is a plain "Mount" button when exactly one device is paired, and an
inline expansion listing the device names when there are several.**

*Revised during implementation.* This originally said "dropdown", and a dropdown was built. It
had a correctness bug, found by measurement rather than by eye: with two disk rows, the open
popup covered the next row's Mount button, and `elementFromPoint` at that button resolved to
the first row's menu item — so clicking what looked like disk 2's Mount silently mounted disk 1.
`modal={true}` does not help, because `MenuPositioner`'s `z-50` is unconditional and the
backdrop never enters the comparison. Nor does any placement: `side="bottom"` covers the row
below, `side="top"` the row above, and horizontal placement is fragile at narrow widths. Any
overlay anchored to a row in a tight list overlaps something. An inline expansion — the row
grows, the rows below are pushed down — structurally cannot, which is worth more here than
guarding a wrong-target mount with collision heuristics. No persistent "current device" selection —
that is state to keep in sync, invalidate, and explain, for no benefit over naming the target
at the moment you press the button.

When no device is paired, the action is disabled with a link to `/devices` rather than hidden.
A disabled control that says why is more useful than an absent one.

---

## 5. Page composition

### `/devices`

`PageHeader` — eyebrow "Hardware", title "Devices", subtitle counting paired devices and how
many are online (seen within 60 s). Action: "Pair a device", which mints a code through the
existing `POST /api/devices/pair` and shows it with its expiry.

Then one card per device: name, `firmware_version`, MAC, RSSI, `psram_free`, its state from §2
rendered per the table, an **Eject** button when it holds or wants a disk, and `last_error`
when set.

### `/games/[id]`

`PageHeader` with the game's title; a breadcrumb to `/library`. Cover art if the catalog has
it, otherwise the same placeholder the grid uses. Then the disk set: one row per disk in
`disk_no` order carrying the boot badge, size, a truncated sha256, the **write-protect
toggle**, the mount action from §4, and — when some device holds or wants that disk — which
one and in what state.

Out of scope, deliberately: the artboard's "Identity & provenance" panel and its artwork
Replace flow. Both belong to the enrichment work.

---

## 6. Reconciling the artboards

`design/Devices.dc.html` and `design/GameDetail.dc.html` are the visual authority and are
factually stale — they were drawn before D14/D15 replaced the hardware.

**Keep:** the gradient canvas, the frosted `glass-card` treatment, spacing, type scale, the
disk-set list layout, the cover panel proportions.

**Replace:** "XIAO ESP32-S3" → the device's reported firmware and MAC; "FAT12 · USB MSC" and
the "1.44 MB of 8 MB" RAM-disk meter → PSRAM state as reported; "880 KB → PSRAM · about 2 s"
→ the real 2,027,536-byte MFM transfer; "long-poll every 2 s" → 25 s.

**Drop:** the Activity log — the operator declined mount history, and the parent spec §2
records that as decided, not deferred. The OTA firmware row — not built and not planned.

**Add:** the write-protect toggle, which postdates both artboards.

The `.dc.html` files are left untouched as historical design records. They are not specs, and
this section is what reconciles them.

---

## 7. Testing

Pure logic → Vitest: `deviceState`. Everything else → Playwright, matching the repo's
standard and the fact that Vitest here never opens a database connection.

The e2e specs must cover, at minimum: each of the four states rendering its own distinct
text; a mount from the game detail page reaching the database; the write-protect toggle
round-tripping; eject; the multi-device dropdown appearing only with several devices paired;
and both previously-404 routes now resolving. Every spec calls `cleanupSeeded`.

**`LiveRefresh` needs a test that it stops.** A polling component that never stops is the
defect this design is most likely to ship, and it is invisible in a passing screenshot.

---

## 8. Out of scope

No new endpoints. No enrichment, artwork sourcing, or provenance panel. No mount history —
declined, not deferred. No firmware OTA. Write-back remains backlog.
