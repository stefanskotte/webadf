# WebFloppy redesign, Phase C area 8: Header drive menu, simple version — design

Date: 2026-10-26. Roadmap Phase C step 8 (`2026-10-23-webfloppy-redesign-roadmap-design.md`), binding, operator
2026-10-25:

> each board's existing header chip and menu take the board's look -- the chip shows the board name, its disk and the
> `WP` tag (no "n/N" count -- it makes no sense, leave it out); the menu opens as a panel with "Controlling" and "Manage
> devices" (to /devices), one card with the disk icon, "<board> · DF0", the disk name and "disk n of N", an
> Online/Offline pill, a Write-protect switch, Eject and a board-settings gear. No "current drive" concept: each chip's
> menu is that board's card. Existing functions only (go to disk, write protection, next, eject, board settings); every
> drive-chip test id kept.

A **look pass** over the header drive chips and their menus (`src/components/shell/drive-chips.tsx`,
`src/lib/drive-chips.ts`), which shipped 2026-09-25 and were re-measured for Phase B (2026-10-24) and C7 (2026-10-26).
The same requests (`device-actions.ts`), the same data path (the `(app)` layout's `liveStateRows` → `driveChips` →
`LiveRefresh`), one additive field pair on `DriveChip` (Ruling 4) and one additive entry point into an existing modal
(Ruling 12). Builds on C2 (DiskIcon, `WpSwitch`, `statusPill`, Board settings `Modal` and its `finalFocus`), C5 (busy =
`aria-disabled` + guard, try/catch/finally), C6 (the four-colour stripe is gone from every `DiskIcon`) and C7 (the phone
header is one 60 px row plus a fixed bottom bar; 44 px targets below lg).

Written under the operator's unattended authorization of 2026-10-24. Every design call is mine and is listed under
**Rulings** at the end, with what it costs if wrong.

Sources, in order of authority:
1. the roadmap item above;
2. the operator's screenshot (session scratchpad `design-approved/drive-menu-simple-operator-2026-10-25.png`): chip
   "● WifiFloppy1 `amiga-wb31_locale` `WP` ⌄"; panel "Controlling" / "Manage devices"; one card: disk icon,
   "WifiFloppy1 · DF0", "amiga-wb31_locale · disk 1 of 1", "● Online" pill, a wide "Write-protect" switch button, an ink
   "⏏ Eject" button, a square gear. Its "1/3" badge and the coloured stripe on its disk icon are **ignored** (removed by
   the operator; the stripe went in C6);
3. the boards `ModernHeader.dc.html` / `ModernHeaderMenu.dc.html` for spacing, type and colour only. Where they differ
   from the operator's simple version (the "Switch drive" radiogroup, "n/N" badge, "Pair another drive", "Mount a disk",
   the "Reading" status, offline controls at 45 % opacity), the operator's version wins (Rulings 14, 15).

Measured against `35361e1` (branch `feat/phase-c8-drive-menu`), Chromium, a fresh org with a paired fake board
(`pairDevice`, `seedDisk`, a two-disk title mounted and converged through `/api/device/status`), PORT 3100. Captures in
the session scratchpad `c8-audit/` (`1280-closed.png`, `1280-open.png`, `1280-open-offline.png`, `1024-*.png`,
`390-*.png`).

## 0. Invariants

- Every `data-testid` in §9.1 keeps its name and its meaning. Ids that move to a different element keep their names; the
  specs that change are listed in §9.4.
- No schema change, no migration, no new API route, no new package (Base UI `Popover` is already used by `HelpTip` and
  `create-adf.tsx`). Kept as shipped: `POST /api/devices/[id]/eject`, `POST /api/devices/[id]/next`,
  `PATCH /api/disks/[id] {writeProtected}`, `PATCH /api/devices/[id]/boot-disk`, and every toast those helpers raise
  (`requestEject`, `requestNextDisk`, `requestWriteProtect` in `src/components/devices/device-actions.ts`).
- **No optimistic state.** As today, the chip and the card render only what the layout's rows say; after Eject the card
  reads "Ejecting …" because desired ≠ mounted, and "Drive empty" only once the board has reported it.
- **Show both values of a state.** Online/Offline is a word in a pill and, on the chip, a filled dot vs a hollow ring;
  the switch shows on and off; an empty drive says so in words; WP and RW are both tags.
- Busy controls are `aria-disabled` + a guard in the handler, never native `disabled`; every request sits in
  try/catch/finally so a dropped connection never leaves a control busy. Focus never lands on `<body>`.
- The admin plane renders no chip and no panel (`c6-admin-layout.spec`, `drive-chips.spec` "the admin plane never renders
  the chips").
- Self-host parity: no new external URL, font or service.
- Firmware, `wifi-floppy/`, the board and the Amiga are untouched.

## 1. What exists today (measured)

| Fact | Value at `35361e1` |
|---|---|
| Chip (xl+), 1280 | 180 × 36 px at x 227, `rounded-[10px]`, `--surface-2` on `--line`, 12 px Geist; name capped at 3.5rem (56 px) and disk at 3.25rem (52 px), so "WifiFloppy1" reads "WifiFlop…" and the title "Audit …" (`1280-closed.png`). WP/RW tag 9.5 px mono on `--track`. Status: filled green dot + halo online, hollow `--muted` ring offline, plus an sr-only word. |
| Chips per width | `chipSlots`: member 1 / 2 / 3, admin 1 / 1 / 2 at 1280 / 1536 / 1920; "+k" chip 45 px ("+1" with two boards at 1280). Below xl one `drives-compact` control: "● Drives 2" (90 × 36 at 1024; 250 × 44 at 390, x 70, filling the C7 header row). |
| Menu | Base UI **Menu**: trigger `aria-haspopup="menu"`, popup `role="menu"`, `w-64` (256 px), radius 18 px, `--surface`, `--shadow-card`. Items `role="menuitem"`, 32 px tall, 13 px. Content: name link (↗, to `/devices#device-<id>`) + ONLINE pill; disk line "Title · disk 1"; Go to disk; "Disk is Protected · make writable"; "Next disk: Disk 2 of 2"; separator; Eject. Phone/+k: the same entry per board, stacked with separators (`390-open.png`). |
| Disabled items | `aria-disabled="true"`, `data-disabled=""`, `tabindex="-1"`; no native `disabled` (the items are `div`/`a`). |
| Live update | With the menu open, writing the board offline reached the open menu in **3.8 s** (LiveRefresh's 3 s tick + refresh). The menu stayed open; focus stayed in the popup. |
| Focus | Pointer open → the popup itself; Enter open → the first item (the board-name link). Escape → the chip; outside click → the chip (both after the ~200 ms exit animation; read at once, focus is still on the closing popup or `<body>`). Eject → the menu closes and focus returns to the chip; the chip reads "ejecting…". |
| Busy | None: the items have no busy state; a second click during a request sends a second request. |
| Offline | Every action stays enabled; the entry adds "The board is offline — it will act when it is back." (`--amber-text`). |
| Popup clamp | Base UI Menu does not pull an over-wide popup on screen; `align="end"` + `max-w-[calc(100vw-2rem)]` keep it in (HANDOFF §3t). |

## 2. The chip (Rulings 2, 3)

One chip per board from xl, as today; same trigger element, same ids, same `title` ("<name> — online/offline"), same
`data-phase` / `data-online`.

- Box: height **40 px** (44 px below lg, the C7 row), `rounded-[10px]`, padding `0 10px 0 12px`, gap 8 px,
  `--surface-2` on `--line`; **open** (`data-popup-open`): `--surface` on an `--ink` border (board `chipBg`/`chipEdge`).
  Focus ring as today.
- Content, in order: status dot (8 px; online filled `--online-dot` + 3 px halo; offline the hollow ring — Ruling 3);
  the board's `shortName`, 14 px / 600, `max-w-[6rem]` truncate (`drive-chip-name-<id>`); the disk text, Geist Mono
  13 px `--muted`, `min-w-0 flex-1` truncate (`drive-chip-disk-<id>`, `diskText()` unchanged: title / "empty" /
  "loading…" / "ejecting…"); the WP/RW tag, Geist Mono 11 px / 600, `px-1.5 rounded-[5px]`, `--track` / `--muted`
  (`drive-chip-wp-<id>`, `protectTag()` unchanged, with an sr-only "write-protected" / "writable"); chevron 14 px.
- **No count badge.** Nothing says "n/N" anywhere.
- Width: `max-w-[240px]`. The slots are re-derived for that width (§2.1).

### 2.1 Slots (`chipSlots`, `CHIP_VISIBILITY*`, `moreVisibility`)

Same method as `drive-chips.ts` documents: chips start at x 168, stop 16 px short of the viewport-centred pill (left edge
481 / 609 / 801 member, 443 / 571 / 763 with Admin, at 1280 / 1536 / 1920), chips 6 px apart, "+k" ≈ 48 px. With the
widest chip at 240 px the arithmetic gives:

| | 1280 | 1536 | 1920 |
|---|---|---|---|
| member, one board | 1 | 1 | 1 |
| member, 2+ boards | 1 + "+k" | 1 + "+k" | 2 + "+k" (none when exactly 2) |
| Admin, one board | 1 | 1 | 1 |
| Admin, 2+ boards | **0: the compact control** | 1 + "+k" | 2 + "+k" |

So `chipSlots(w, showAdmin, n)` gains the board count, returns 0 for Admin with n ≥ 2 below 2xl, and the compact wrapper's
`xl:hidden` becomes `2xl:hidden` in exactly that case (both classes are literal strings chosen from props on the server,
so the first paint is right). The implementer **re-measures** the widest chip (long name, long title, WP) at all three
widths, for member and Admin, and writes the measured numbers into the `chipSlots` comment, as in 2026-09-25 and
2026-10-24. If a measured chip is wider than 240 px the cap wins; if the numbers come out different from the table, the
measurement wins and the table here is corrected in the plan.

## 3. The panel (Rulings 1, 5–13)

### 3.1 Primitive and frame

Base UI **Popover** (`@base-ui/react/popover`; `Popover.Root` / `Trigger` / `Portal` / `Positioner` / `Popup`), not Menu.
Trigger: the chip (`aria-haspopup="dialog"`, `aria-expanded`). Popup: `role="dialog"`, `aria-label` "<name> drive" for a
board's chip, "Drives" for "+k" and the compact control; `modal={false}`.

- Positioner: `side="bottom"`, `sideOffset={6}`, `align="start"` for a chip and "+k", `align="end"` for the compact
  control (as today), `collisionPadding={16}`, `z-50`.
- Popup: `w-[440px] max-w-[calc(100vw-2rem)]`, `p-2`, `rounded-2xl` (16 px), `--surface`, `1px solid var(--line)`,
  `--shadow-card`, `flex flex-col gap-1.5`, `outline-none`, `max-h-[var(--available-height)] overflow-y-auto` (below lg
  also less the bottom bar, §7).
- Data-testid on the popup as today: `drive-chip-menu-<id>`, `drive-chip-more-menu`, `drives-compact-menu`.

### 3.2 Head row

`flex justify-between items-center px-2.5 pt-2 pb-0.5`:
- "Controlling" — 12 px / 500, `--muted-2`. Plain text (not a heading: one per panel, no section structure).
- **"Manage devices"** — a `Link` to `/devices`, 13 px / 600, `--accent-amber` (#B5541A, about 4.9:1 on `--surface` by calculation,
  measured in `contrast.spec`), hover underline, `min-h-11` hit area below lg. Clicking it closes the panel.
  `data-testid="drive-panel-manage"` (new).

One head row per panel: the "+k" and compact panels hold one head row and then one card per board (Ruling 7).

### 3.3 The card (`section`, `data-testid="drive-entry-<id>"`, `aria-label="<name> controls"`)

`--surface-2`, `rounded-xl` (12 px), `p-3.5`, `flex flex-col gap-3`.

**Top row** (`flex items-center gap-3`):
1. **Disk icon**, 44 px: `DiskIcon size={44} color={driveDiskColor(disk.gameId)} wp={disk.readOnly !== null ||
   disk.writeProtected === true}` (today's stripeless icon; no `set`/`title` text at this size) when the chip has a
   `disk` (loaded or ejecting); otherwise the dashed placeholder 44 × 45, `1.5px dashed #C4B9A2`, radius 5 (DriveBox's,
   scaled). Decorative (`aria-hidden`).
2. **Text column** (`min-w-0 flex-1 flex flex-col gap-0.5`):
   - line 1: the board name, 15 px / 600, as a `Link` to `/devices#device-<id>` (`drive-entry-link-<id>`, kept; hover
     underline, no ↗), then " · DF0" in Geist Mono 12 px / 500 `--muted-2` (`aria-hidden`; the link's name is the board
     name). Truncates on one line.
   - line 2 (`drive-entry-disk-<id>`), Geist Mono 12 px `--muted`, one line, truncate:
     - loaded: **the title as a link** (`drive-goto-<id>`, to `/games/<gameId>`, hover underline) then
       " · disk n of N" (Ruling 4) — when `canGoTo` is false (no game row) the title is plain text carrying the same
       test id with `data-disabled=""`;
     - empty: "Drive empty";
     - loading: "Loading <loadingTitle ?? 'a disk'>…";
     - ejecting: "Ejecting <title ?? 'a disk'>…".
   - line 3, only with a preload (`drive-preload-<id>`, `data-preload`, kept): `preloadText()` 12 px `--muted`.
   - line 4, only with DF1 On (`drive-entry-df1-<id>`, kept): `chip.df1`, 12 px `--muted`.
3. **Status pill** (`drive-entry-status-<id>`, kept): `statusPill(online)` from `devices-look.ts` — the Devices card's
   words and tokens — 12 px / 600, `px-2.5 py-0.5`, a 6 px dot, `shrink-0`. Text "Online" / "Offline" (sentence case; the
   uppercase tracking goes).

**Offline line** (only offline, `drive-entry-offline-<id>`, new): 12 px `--amber-text`: "Offline, last seen <relative>.
Changes reach it when it reconnects." `relative()` text is already in the live fingerprint for offline boards
(`live-state.ts`), so it never freezes (Ruling 10).

**Actions row** (`flex flex-wrap gap-2`), each 36 px tall from lg, **44 px below lg**:
1. **Write-protect** (`drive-protect-<id>`, kept), `flex-1 min-w-[9rem]`, `--surface` on `--line`, `rounded-[9px]`,
   13 px / 500: `WpSwitch` (28 × 16 at this size; the board's) + the word "Write-protect". `role="switch"`,
   `aria-checked`, `data-protected` kept. §4.1.
2. **Next** (`drive-next-<id>`, kept), only when `chip.next`: same look as Write-protect but not flex-1: "Next: disk n"
   (the card's words), `title`/`aria-label` "Next disk: disk n of N" + " (wraps)" when it wraps. §4.3.
3. **Eject** (`drive-eject-<id>`, kept): `--ink` on `--surface`, 13 px / 600, `px-3.5`, the eject glyph (DriveBox's
   path) + "Eject" / "Ejecting…". Always rendered (Ruling 9). §4.2.
4. **Board settings** (`drive-settings-<id>`, new): a 36 × 36 (44 × 44 below lg) square `Link`, `--surface` on `--line`,
   the gear glyph (BoardSettings' path, 16 px), `aria-label="<name> board settings"`. §4.4.

## 4. The four actions

Every handler follows one shape (a small hook local to `drive-chips.tsx`, `usePanelAction`; Ruling 16):

```ts
const [busy, setBusy] = useState(false);
const [pending, start] = useTransition();
const off = !allowed || busy || pending;
async function run() {
  if (off) return;                                   // the guard: aria-disabled does not stop a click
  setBusy(true);
  try {
    if (await request()) start(() => router.refresh());
  } catch {
    toast.error('Something went wrong', { description: 'Try again.' });   // request*() already toasts network errors
  } finally {
    setBusy(false);
  }
}
// <button aria-disabled={off || undefined} data-disabled={off ? '' : undefined} aria-busy={busy || pending || undefined}>
```

`data-disabled` mirrors `aria-disabled` so the `toHaveAttribute('data-disabled', '')` assertions keep their meaning
(Ruling 17). An `aria-disabled` control stays focusable (it is a `button` without `disabled`), so focus never falls out of
the panel when a control turns busy.

### 4.1 Write-protect

- **Code path:** `requestWriteProtect(chip.disk.id, !chip.disk.writeProtected)` — the same helper DriveBox's switch and
  today's menu item call; the flag belongs to the disk (every board holding it learns it on its next poll).
- **Allowed** = `chip.canToggleProtect` (loaded, a disk row, a known flag, not HFE) — unchanged from `toDriveChip`.
- **States:** `aria-checked` = `disk.readOnly !== null || disk.writeProtected === true` when loaded with a known flag.
  HFE: switch on, `aria-disabled`, `title="HFE disks are always read-only"`, sr-only "(HFE, always read-only)". Not
  loaded (empty, loading, ejecting, unknown flag): the neutral switch DriveBox draws for `wp === null` (knob left on
  `--track`), `aria-checked="false"`, `aria-disabled`, sr-only "(shown once the board holds a disk)". The visible word
  stays "Write-protect" in every state; the switch's position is the reading, and the chip's WP/RW tag repeats it.
- **Busy:** from click until `router.refresh()` lands: `aria-disabled`, `aria-busy`; no optimistic flip (the switch
  moves when the rows say so, ~1 refresh later).
- **Offline:** allowed. The PATCH is a disk write; the board picks it up on reconnect. The offline line says so.
- The panel stays open; focus stays on the switch.

### 4.2 Eject

- **Code path:** `requestEject(chip.id)` (DriveBox's and today's menu's).
- **Allowed** = `chip.canEject` (something desired or mounted) — unchanged.
- **Always rendered**: an empty drive shows Eject `aria-disabled` (`title="The drive is empty"`), not a "Mount a disk"
  link and not nothing (Rulings 9, 14).
- **Busy:** label "Ejecting…", `aria-disabled`, `aria-busy` until the refresh lands. After that the card itself reads
  "Ejecting <title>…" and Eject stays allowed (as today: `canEject` holds while mounted ≠ empty; a second press re-sends
  the same desired-state write, harmless).
- **Offline:** allowed; it is a desired-state write the board acts on when it is back.
- **After Eject the panel stays open** and focus stays on the Eject button, which stays in the DOM (Ruling 9). When the
  board reports empty the button turns `aria-disabled` under the focus — focus is not moved.

### 4.3 Next disk

- **Code path:** `requestNextDisk(chip.id)` (NextDiskButton's and today's menu's). Toasts unchanged ("Switching to disk
  n of N", "This title has only one disk", "No disk in the drive").
- **Shown** only when `chip.next` (loaded, multi-disk title) — as today. Not rendered otherwise (it is not a state of
  the drive but an option that exists or not; "disk n of N" on line 2 already says why).
- **Busy:** label "Switching…", `aria-disabled`, `aria-busy`.
- **Offline:** allowed (desired-state write), as today.
- After success the card moves to "Loading <title>…" on the next refresh and the button disappears (`next` is null while
  loading). Focus then goes to the Eject button of the same card (Ruling 18) — never to `<body>`.

### 4.4 Board settings (Ruling 12)

- **Code path:** the existing `BoardSettings` modal on `/devices` (`board-settings.tsx`), unchanged. The gear is a
  `Link` to **`/devices?settings=<id>`**. On `/devices`, `DeviceList` reads `settings` (the page passes
  `searchParams.settings` down; Next 16: `searchParams` is a Promise — read
  `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` and the `use-search-params` page
  before writing it) and the matching card's `BoardSettings` opens itself once (`openOnArrival` prop → `show()` in an
  effect), scrolls its card into view (`block: 'center'`), and strips the parameter with
  `window.history.replaceState(null, '', '/devices#device-<id>')` (Next keeps `useSearchParams` in sync with native
  `replaceState`; same doc). Unknown or foreign id: nothing opens; the parameter is stripped.
- No busy state (a link). **Offline:** allowed — Board settings works for an offline board today ("nothing changes until
  you save"; the save reaches it on reconnect).
- Clicking closes the panel (navigation). Focus: the modal's own initial focus (as on `/devices`); when it closes, its
  `finalFocus` returns to the card's `board-settings-<id>` button — never `<body>`. Already on `/devices`: the same link
  is a client navigation that changes only the search param; the effect keys on the param value.

### 4.5 Go to disk

The title on line 2 (`drive-goto-<id>`), a `Link` to `/games/<gameId>`; closes the panel. No busy state, works offline
(it reads the library).

## 5. States

| State | Chip | Card |
|---|---|---|
| **No boards** | nothing at all, no compact control (unchanged) | — |
| **One board, loaded** | dot, name, title, WP/RW | icon, "<name> · DF0", "<title> · disk n of N", pill; switch live; Next if multi-disk; Eject; gear |
| **Empty drive** | name, "empty", no tag | dashed placeholder, "Drive empty", switch neutral + aria-disabled, no Next, Eject aria-disabled, gear |
| **Loading** | "loading…", no tag | placeholder, "Loading <title>…", switch neutral, no Next, Eject allowed (cancels), gear |
| **Ejecting** | "ejecting…", no tag | icon of the outgoing disk, "Ejecting <title>…", switch neutral, no Next, Eject allowed, gear |
| **Offline** | hollow ring, chip at 80 % opacity (as today), same texts | "Offline" pill, the offline line, every action allowed as in its drive state |
| **Unknown disk row** (old firmware: digest, no id) | "a disk", no tag | placeholder; line 2 reads "A disk" (no "disk n of N"), not a link; switch neutral; no Next; Eject allowed |
| **HFE** | WP | switch on + aria-disabled, sr-only reason |
| **Several boards** | one chip each (as slots allow) + "+k"; below xl one compact control | each chip's panel is that board's card; "+k" and compact: one head row + one card per board, in `driveChips` order (by name) |

Loading wording uses U+2026 as today.

## 6. Focus and keyboard (Rulings 18–21)

- **Open** (click, Enter, Space on the chip): focus moves to **the popup** (`initialFocus` = the popup, `tabIndex={-1}`,
  labelled), for pointer and keyboard alike; the screen reader hears "<name> drive, dialog". Tab order inside: Manage
  devices → board-name link → title link (if any) → Write-protect → Next (if any) → Eject → gear, then the next card in a
  multi-board panel. No arrow-key roving (a dialog, not a menu).
- **Escape:** closes; focus to the chip (Base UI default `finalFocus`). Pinned in e2e *after* the exit animation
  (`toBeFocused` polls).
- **Outside press:** closes. If the press landed on a focusable element (the search field, a link), focus goes there;
  otherwise to the chip. Measured today: the chip, after the animation. Implemented with Base UI's `finalFocus` as a
  function of the close reason, or — if the installed version lacks that — `onOpenChange(open, details)` with
  `details.reason === 'outside-press'` and a rAF check that `document.activeElement` is `<body>` before focusing the
  chip.
- **Tab past the last control:** focus continues to the element after the chip in document order and the panel closes
  (Base UI non-modal popover focus guards). The implementer verifies this against the installed `@base-ui/react` and
  pins it; if the panel stays open with focus outside it, close it on `focusout` leaving popup and trigger.
- **After Eject:** panel open, focus on Eject (§4.2).
- **After Next:** the Next button unmounts on the loading refresh; focus moves to the same card's Eject (§4.3, checked in
  an effect: if `document.activeElement` is `<body>` and the panel is open, focus Eject).
- **After Write-protect:** focus stays on the switch.
- **After Manage devices / Go to disk / board name link:** navigation; the destination's own focus rule (`PageHeader` h1
  `tabIndex={-1}` app-wide since C2; the `#device-<id>` anchor).
- **After the board settings gear:** §4.4.
- **The board vanishes while its panel is open** (deleted in another tab; the refresh drops its chip): focus to
  `wordmark-home` (Ruling 21). With a "+k"/compact panel that still has other cards, the panel stays open and focus goes
  to the popup.
- **Live updates** never move focus (measured today: focus stays in the popup across a refresh).

## 7. Live updates

Unchanged mechanism: the `(app)` layout builds `chips = driveChips(liveRows, now)` from the same rows `liveFingerprint`
hashes; `LiveRefresh` polls `/api/live-state` every 3 s and calls `router.refresh()` on a change; the chip and an open
panel re-render with the new props. Measured: an offline flip reached an open menu in 3.8 s, menu open, focus kept.

What C8 must keep for that to stay true:
- the Popover's open state lives in `Popover.Root` inside `Chip` / `MoreChip` / the compact control, each keyed by
  stable ids (`chip.id`; the compact control by nothing that changes with data), so a refresh re-renders, never remounts;
- the panel holds **no copy** of server state — only `busy` flags;
- every new field the panel reads is in the fingerprint: `mountedDiskCount` (already), the offline `relative()` text
  (already). The new `DriveChip` fields (Ruling 4) are derived from those.

## 8. Phone and tablet (below xl; C7 shell)

- Below lg the header is C7's one 60 px row: home (44 px) · the chip slot (fills the middle) · search (44 px); the nav is
  the fixed bottom bar. The chip slot keeps `drives-compact` (`min-w-0 flex-1`, `h-11`, `w-full`), lg→xl it follows the
  wordmark (unchanged).
- **One board** (Ruling 6): `drives-compact` takes that board's chip look and content — dot, `shortName`, disk text,
  WP/RW tag, chevron — left-aligned, the disk text taking the slack. Its panel is the board's card under the head row.
  The inner spans carry no `drive-chip-*` ids (those belong to the xl chip, which is in the DOM, `display:none`, at the
  same time; duplicate ids would break `getByTestId` strict mode). New ids: `drives-compact-name`, `drives-compact-disk`,
  `drives-compact-wp`.
- **Two or more boards** (Ruling 5): `drives-compact` keeps "● Drives n" (the summary dot: filled when every board is
  online; n = how many boards — a count of boards, not the removed "n of N" position). Its panel: one head row, then one
  card per board.
- Panel: `align="end"`, `w-[440px] max-w-[calc(100vw-2rem)]` (358 px at 390), `collisionPadding={16}`; below lg its
  `max-height` is `min(var(--available-height), calc(100dvh - 60px - 4.5rem - env(safe-area-inset-bottom) - 16px))`
  with `overflow-y-auto` and `overscroll-contain`, so it never runs under the bottom bar (Ruling 22). It sits above the
  bar's z-40 (`z-50`), but by height never covers it.
- Card at 358: top row as §3.3 (title truncates); actions wrap: Write-protect takes the first row when Next is present
  (`min-w-[9rem] flex-1`), then Next · Eject · gear. Every target 44 px tall; the gear 44 × 44; Manage devices 44 px hit
  area.
- No horizontal page scroll at 390 (asserted).

## 9. Test ids

### 9.1 Kept (name and meaning)

`drive-chips`, `drive-chip-<id>` (+ `data-phase`, `data-online`, `title`), `drive-chip-name-<id>`,
`drive-chip-disk-<id>`, `drive-chip-wp-<id>`, `drive-chip-more`, `drive-chip-more-menu`, `drive-chip-menu-<id>`,
`drives-compact`, `drives-compact-menu`, `drive-entry-<id>` (now the card `section`), `drive-entry-link-<id>`,
`drive-entry-status-<id>`, `drive-entry-disk-<id>`, `drive-entry-df1-<id>`, `drive-goto-<id>`, `drive-protect-<id>`
(+ `data-protected`), `drive-next-<id>`, `drive-preload-<id>` (+ `data-preload`), `drive-eject-<id>`.

### 9.2 New

`drive-panel-manage`, `drive-entry-offline-<id>`, `drive-settings-<id>`, `drives-compact-name`, `drives-compact-disk`,
`drives-compact-wp`.

### 9.3 Removed

None.

### 9.4 Specs that change, and why

- `drive-chips.spec.ts`:
  - "an empty board…": `aria-haspopup` `menu` → `dialog`; `drive-entry-disk` "Empty" → "Drive empty"; the three
    actions still `data-disabled=""` (`goto` is plain text, `protect`/`eject` aria-disabled buttons); Escape/outside
    click assertions use `toBeFocused()` on the chip.
  - "the board's name… links to its own card": unchanged href; the ↗ glyph is gone (no assertion on it).
  - "a mount shows as loading…": the loading line reads "Loading <title>…" in `drive-entry-disk`; Go to disk is the
    title link.
  - "write-protect item flips…": the item is a `role="switch"`; assert `aria-checked` alongside `data-protected`; the
    panel stays open after the click (it closed before).
  - "eject reads 'ejecting…'": the panel stays open after Eject; the chip still reads "ejecting…" then "empty".
  - "an offline board…": the offline line text changes; Eject still allowed.
  - the 1280 / 1536 / 1920 layout tests: new chip height (40) and the re-derived `chipSlots` (§2.1), including the Admin
    2+-boards band at 1280 showing `drives-compact` instead of a chip.
  - "at 390px one Drives control…": the 32 px item check becomes 44 px on Eject; the popup's right edge ≤ 390 − 16.
- `next-disk.spec.ts` "the drive menu offers Next disk…": the item text is "Next: disk n"; the panel stays open; the
  wrap is in `aria-label`.
- `header-overlap.spec.ts`, `c7-phone.mobile.spec.ts` C7-01: the chip slot keeps 44 px and its position; re-run, no
  change expected.
- `c6-admin-layout.spec.ts`: unchanged (no chips on the admin plane).

### 9.5 New e2e (`e2e/c8-drive-menu.spec.ts`, `e2e/c8-drive-menu.mobile.spec.ts`)

Seeded with `pairDevice` / `seedDisk` / `addDisk` and the `mountAndConverge` pattern of `drive-chips.spec`;
`cleanupSeeded` in `afterAll`. One run at a time, PORT 3100, each file well under 9 minutes.

1. C8-01 Look at 1280: chip 40 px tall, 14 px name, mono disk, WP tag, no count text (`/\d+\s*\/\s*\d+/` absent from the
   chip); open: popup 440 px, head row "Controlling" + "Manage devices" → `/devices`, card with icon, "<name> · DF0",
   "<title> · disk 1 of 2", "Online" pill, switch, Next, Eject, gear.
2. C8-02 A single-disk title reads "disk 1 of 1" (the operator's screenshot).
3. C8-03 Write-protect: `aria-checked` flips via the refresh; during the request the switch is `aria-disabled` +
   `aria-busy` and a second click sends no second PATCH (count requests with `page.on('request')`); the panel stays open;
   focus stays on the switch.
4. C8-04 Eject: busy label, one request on a double click, panel open, focus on Eject; the board reports empty →
   Eject `aria-disabled` under focus, focus still on it (not `<body>`).
5. C8-05 Next: one request on a double click; after the loading refresh focus is on Eject.
6. C8-06 Network failure: `page.route` aborts the eject request → "Could not reach the server" toast, Eject not busy
   afterwards (the finally).
7. C8-07 Board settings: the gear goes to `/devices`, the board's Board settings modal is open, the URL has no
   `settings=`; Cancel → focus on `board-settings-<id>`. Already on `/devices`: same. A foreign id opens nothing.
8. C8-08 Focus: pointer open → popup focused; Escape → chip; outside click on empty page → chip; click on the search
   field while open → the field keeps focus; Tab past the gear closes the panel.
9. C8-09 Live: with the panel open, the board goes offline → pill "Offline" and the offline line within 8 s, panel
   open, focus unchanged.
10. C8-10 Two boards at 1280 (member): one chip + "+1"; the chip's panel holds exactly one card (its board's); the "+1"
    panel holds the other board's card under one head row.
11. C8-11 Admin with two boards at 1280: `drives-compact` visible, no `drive-chip-<id>` visible; at 1536 one chip.
12. C8-12 (mobile) One board at 390: `drives-compact` shows the board's name, disk and tag, 44 px; the panel ≤ 358 px
    wide and inside the viewport; its bottom above the tab bar's top; every action 44 px; no horizontal scroll.
13. C8-13 (mobile) Two boards at 390: "Drives 2", two cards, the panel scrolls inside itself when taller than the room.
14. C8-14 Offline board: every action allowed; Eject sends its request.
15. C8-15 Contrast pairs (`contrast.spec`): "Manage devices" on `--surface`; disk line `--muted` on `--surface-2`;
    offline line `--amber-text` on `--surface-2`; pill words on their pill.

Unit (`src/lib/drive-chips.test.ts`): `diskLine()` for every phase incl. "disk 1 of 1" and the unknown-row case;
`chipSlots(w, showAdmin, n)` table of §2.1; `toDriveChip` carries `diskCount` and `seen`.

## 10. Help

`src/lib/help/topics.tsx` (`next-disk`: "Use the *Next: disk N* button on the board's card, the drive menu, or a
Next-disk card") stays true — the panel's button now has the same words as the card's. No other topic describes the drive
menu. Nothing changes.

## 11. Not in this phase

- The board's **"Switch drive"** radiogroup and any "current drive" concept; the chip's "n/N" badge (operator).
- The board's **"Pair another drive"** row and **"Mount a disk"** / "Change disk" / "Re-insert last disk" / "Open library"
  in the panel (not among the operator's functions).
- The board's amber **"Reading"** status (no such state is reported today).
- DF1 controls in the panel (Eject DF1, the DF1 radios); the DF1 line stays text only.
- Converting `DriveBox` / `NextDiskButton` / `BoardSettings`' native `disabled` to `aria-disabled` (Devices page; backlog,
  noted in HANDOFF).
- An optimistic Write-protect switch.
- A header-mounted Board settings modal (Ruling 12).

## 12. Suggested task split

1. `drive-chips.ts`: `diskCount` / `seen` on `DriveChip`, `diskLine()`, `chipSlots(w, showAdmin, n)` + unit tests.
2. The chip look (§2) and the slot CSS (§2.1), with the 1280/1536/1920 layout tests re-measured.
3. The panel (§3) on Popover: head row, card, the four actions with `usePanelAction` (§4.1–4.3), focus rules (§6).
4. `/devices?settings=<id>` (§4.4) + the gear.
5. The compact control below xl (§8), mobile spec.
6. Spec updates (§9.4), new specs (§9.5), contrast pairs, HANDOFF entry.

## Rulings (operator to review)

1. **The panel is a Base UI Popover (`role="dialog"`), not a Menu.** — the card holds a switch, buttons and links side
   by side, which is a dialog's content, not a list of commands; the board itself marks it `aria-haspopup="dialog"` /
   `role="dialog"`; Base UI's Popover clamps on screen (`collisionPadding`) where the Menu did not (HANDOFF §3t). — cost
   if wrong: arrow-key navigation is gone (Tab instead); two asserts in `drive-chips.spec` change from menu to dialog.
2. **The chip takes the board's look at 40 px / 14 px with a 240 px cap, and the slots are re-derived from it.** — the
   operator asked for the board's chip; today's 180 px chip truncates "WifiFloppy1" to "WifiFlop…" at 1280 (measured);
   a 240 px chip still fits one chip plus "+k" at 1280 for a member. — cost if wrong: fewer chips than today at 1536
   (2 → 1) and 1920 (3 → 2), and the super-admin with two or more boards gets the compact control at 1280–1535.
3. **The chip's offline dot stays the hollow ring, not the board's red dot.** — shape carries the state without colour
   ("show both values"), and the pill in the panel says "Offline" in words. — cost if wrong: one style swap.
4. **"disk n of N" is always shown, including "disk 1 of 1"; `DriveChipDisk` gains `diskCount` (from
   `mountedDiskCount`, already in the fingerprint) and `DriveChip` gains `seen` (the offline `relative()` text).** —
   the operator's screenshot reads "disk 1 of 1"; today `diskNo` is null on one-disk titles. — cost if wrong: one
   conditional to hide "of 1".
5. **Below xl with two or more boards the compact control keeps "Drives n".** — a count of boards is not the removed
   "n of N" position; with no current drive the control must name the set, not one board. — cost if wrong: the operator
   reads it as the count he removed; the number would go and the control read "Drives" alone.
6. **Below xl with one board the compact control becomes that board's chip.** — the roadmap says each board's chip takes
   the board's look; "Drives 1" is a menu around one card. — cost if wrong: the label goes back to "Drives 1".
7. **"+k" and the compact control: one head row, then one card per board.** — "each chip's menu is that board's card";
   a menu covering several boards is several cards, not a chooser. — cost if wrong: a long panel with many boards
   (it scrolls inside itself).
8. **Next disk is a button in the actions row, shown only for a multi-disk title, worded "Next: disk n".** — Next is one
   of the operator's functions but the screenshot (a one-disk title) does not place it; the card's words keep the help
   topic true. — cost if wrong: one more control in a 314 px row on a phone (it wraps).
9. **Eject is always rendered (aria-disabled when the drive is empty), and the panel stays open after it.** — focus has
   a stable home after the action, and a control that is absent is not a reading; the board swaps it for "Mount a disk",
   which is not one of the operator's functions. — cost if wrong: today's tests expected the menu to close; a user who
   wants it closed presses Escape.
10. **Offline boards keep every control live, with "Offline, last seen … Changes reach it when it reconnects."** —
    every action is a desired-state or disk write the board picks up on reconnect, today's menu and Devices card both
    allow them, and `drive-chips.spec` pins "can still be ejected"; the board's 45 % disabled look would contradict the
    app. — cost if wrong: the operator wanted the board's "controls come back when it reconnects"; one `allowed` flag.
11. **Go to disk is the title link on the disk line, not its own row.** — the screenshot has no Go to disk row; DriveBox
    already makes the title the link. — cost if wrong: a less discoverable link; an explicit row would return.
12. **The gear goes to `/devices?settings=<id>`, which opens that board's existing Board settings modal and strips the
    parameter.** — `BoardSettings` needs `DeviceListItem` fields the header does not load (boot disk, NFC scan) and its
    delete flow focuses the next card on `/devices`; mounting it in the header would mean a second query on every page.
    The board's gear is a link to Devices too. — cost if wrong: a page change for a settings tweak; a header modal would
    need that query.
13. **The board name stays the link to its card (`/devices#device-<id>`), without the ↗.** — an existing function and
    test id; "Manage devices" covers the list. — cost if wrong: two links to Devices in one card.
14. **No "Mount a disk", "Pair another drive" or "Switch drive" from the board.** — "existing functions only", and the
    operator's simple version has none of them. — cost if wrong: an empty drive's panel offers no way to the library
    (the nav's Library tab is one tap away).
15. **No "Reading" status.** — the app reports no such state; the pill is Online/Offline as on the Devices card. — cost
    if wrong: none today.
16. **One local `usePanelAction` hook gives every action busy = `aria-disabled` + guard + `aria-busy`, try/catch/finally,
    and refresh in a transition; the `request*` helpers are reused unchanged.** — today's menu has no busy state at all
    and double-sends. — cost if wrong: none beyond the hook.
17. **`data-disabled=""` mirrors `aria-disabled` on the panel's controls.** — keeps the existing assertions' meaning
    without Base UI Menu setting it. — cost if wrong: a redundant attribute.
18. **After Next, focus goes to the same card's Eject.** — the Next button unmounts on the loading refresh; Eject is
    always there. — cost if wrong: a focus jump a keyboard user may not expect; the alternative is the popup.
19. **Opening focuses the popup itself, for pointer and keyboard.** — one rule, the dialog's name is announced, and no
    focus ring flashes on "Manage devices" for a click. — cost if wrong: a keyboard user presses Tab once more.
20. **Outside press: focus goes to what was pressed if focusable, else to the chip.** — today a click outside lands on
    the chip after the animation (measured); a press on the search field must not have its focus stolen. — cost if
    wrong: one rAF check.
21. **If the open chip's board disappears, focus goes to `wordmark-home`.** — the trigger is gone; the wordmark is the
    nearest stable control in the header. — cost if wrong: a rare edge (delete in another tab).
22. **Below lg the panel's height stops above the bottom bar and scrolls inside itself.** — the bar is fixed (C7); a
    panel that runs under it hides Eject on a short phone. — cost if wrong: a few px of panel lost on very tall phones.
23. **"Manage devices" is `--accent-amber` (#B5541A), about 4.9:1 on `--surface` by calculation.** — the board's colour, an existing token,
    passes AA for 13 px / 600; added to the contrast pairs. — cost if wrong: one token.
24. **Empty drive reads "Drive empty"** (board) instead of "Empty". — the board's words; one test string changes. — cost
    if wrong: a string.
25. **The open chip is `--surface` on an `--ink` border.** — the board's open state; it ties the chip to its panel. —
    cost if wrong: a style.
