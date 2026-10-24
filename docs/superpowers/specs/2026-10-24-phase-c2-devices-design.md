# WebFloppy redesign, Phase C area 2: Devices — design

Date: 2026-10-24. Roadmap Phase C step 2 (`2026-10-23-webfloppy-redesign-roadmap-design.md`): "Devices (DF1 modes,
network checklist, Transfer box, Board settings modal, Board display modal)". Builds on Phase B
(`2026-10-24-phase-b-foundation-design.md`: tokens `--ground`, `--surface`, `--surface-2`, `--track`, `--line`,
`--line-strong`, `--scrim`, `--shadow-modal`, `--font-display`, `.glass-card`, `.wf-modal`, `.seg`/`.seg-item`,
`StatusChip`, shadcn `Button`, `DiskIcon`) and on C1 (`2026-10-24-phase-c1-library-title-design.md`: `PageHeader
size="lg"`, `src/lib/library-look.ts`, the protect switch look, `StateCard`). Nothing here re-invents them.

Written under the operator's unattended authorization of 2026-10-24. Every design call is mine and is listed under
**Rulings** at the end, with what it costs if wrong.

Target boards (session scratchpad `c2design/`): **`ModernDevicesV2`** is the page to build; its `settings-open` state
(`ModernDevicesV2Settings`) is the Board settings modal; **`ModernOled`** is the OLED drawing inside the Board display
modal that `ModernDevicesV2`'s `display-open` state frames. `ModernDevices` / `ModernDevicesModal` are the originals
v2 grew from, for reference only. `InfStates` (offline card) and `InfPhone` (Devices on a phone) are context.

Operator rulings on these boards (2026-10-22/23): Devices keeps the original Modern layout and its modal pattern; v2
is that layout with DF1 Network / Any disk, the network checklist, Disk at startup, Transfer status and the NFC
reader line fitted in. NFC **Scan again** is dropped.

Measured against `d693866` (branch `feat/phase-c2-devices`).

## 0. Invariants

- Every `data-testid` in §11.1 keeps its name and its meaning. Ids that move (into a modal, onto a different element)
  keep their names; the e2e specs that change because of a move or a control-type change are listed in §11.4.
- No schema change, no migration, no new route. One query gains one field: `listDevices` returns `mountedGameId`
  from the **org-scoped** `mountedGame` join (`mountedGame.id`, never `devices.mountedGameId`, so another org's id
  never leaks; §4.3). The page computes one more per-board fact from data it already loads (`transferRunning`, §7).
- Self-host parity: no new dependency (Base UI's Dialog and the radio markup are already installed), no external
  call, no font (the OLED is `display.wasm`, not the board's VT323 mock).
- Firmware, the board and the Amiga are untouched; every request the page sends today is sent the same way.
- Behaviour kept unless a ruling changes it: pairing with a name, rename in place (Enter / Escape, empty restores
  the MAC), Online/Offline by `lastSeenAt`, the live refresh, firmware batch update with password (or the Settings
  skip), Cancel update, eject, Re-insert last disk with Undo, Next disk, preload line, write protection, the DF1
  modes with the DF1-seen override, Eject DF1, the Network checklist with a live driver age, Send/From-the-Amiga
  links, Disk at startup, the I2C/NFC reader line, the stuck-start line, the last error, delete device, Write a
  Next-disk card, and the whole OLED editor (wasm preview, drag, panel, rotation, preview situations, scale,
  width/bar/lines, status word/icon, NFC element gating, validate, Save, Reset, Cancel).
- "Show both values of a state": every state renders a word in each of its values; an absent element never stands
  for one value. `w-full` (or any width utility) is never put on an `sr-only` element.

## 1. Page layout (`src/app/(app)/devices/page.tsx`; board: ModernDevicesV2 `main`)

- `PageHeader size="lg"`: eyebrow `Hardware`, h1 `Devices`, help `boards`, subtitle (mono 13 px `var(--muted)`)
  unchanged: `` `${n} paired · ${online} online · long-poll every 25 s` ``.
- **Actions** (right, on the heading's baseline, gap 8): when the org has Next-card writers, the `write-next-card`
  trigger (its words `Write a Next-disk card`, restyled to the secondary button: `h-10 rounded-[10px] border px-3.5`,
  surface fill, line border, ink 14/500) and its `nfc` help tip; then `PairButton` (§1.2).
- Below the header, inside the page gutter (`px-4 sm:px-7`, `pb-10`), a column with gap 24 px: the firmware banner
  (§1.3, only when a board is behind), the update bar (`update-bar`, only while boards are ticked), then the cards.
- **Cards grid** (`device-list.tsx`):
  - 0 devices: the empty state (§9.1).
  - exactly 1 device: `lg:grid-cols-[minmax(0,1fr)_360px]`, gap 24, `items-stretch`: the device card, then the
    **Add another drive** aside (§1.4). Below `lg`: one column, the aside after the card.
  - 2 or more: one column (`grid-cols-1`, gap 24), each card the full width; no aside (Ruling 1).
  The 3-per-row grid and its `items-start` comment go.

### 1.2 Pair a device (`pair-button.tsx`)

- Trigger `pair-device`: ink fill, `h-10 rounded-[10px] px-4`, 14/600 `var(--surface)` text, a 16 px plus icon
  (`aria-hidden`) before the words `Pair a device`. The naming form (`pair-name`, `pair-cancel`, `pair-submit`
  `Get a code` / `Minting…`), the code (`pairing-code`, `pairing-for`, `pairing-expiry`), `Code expired` and
  `Mint a new code` keep their words, ids and order; inputs `h-10 rounded-[10px]` surface with line border; text
  colours `var(--ink)` / `var(--muted)` (they read `--on-dark*` today, which Phase B already remapped).
- Its state moves into a small client context, `PairingProvider` (`src/components/devices/pairing.tsx`), which the
  page wraps around the header and the list, so the aside's button opens the **same** form (one code at a time,
  Ruling 32). `PairButton` reads it; `PairAnotherButton` calls `startNaming()` and scrolls the header into view.

### 1.3 Firmware banner (`firmware-notice.tsx`; board: `section[aria-label="Firmware update"]`)

Rendered by `DeviceList` (it moves there from the page) so its action can open the update dialog. Shown only when
`behind > 0`, as today.

- `section[aria-label="Firmware update"]`, `data-testid="firmware-notice"`: surface, 16 px radius,
  `box-shadow: 0 0 0 1px var(--fw-line)` (new token `#F1D3A4`), `px-[18px] py-4`, flex, gap 16, `items-center`.
- A 40×40 rounded-xl `var(--warning-bg)` tile with the board's upload glyph in `var(--warning-fg)` (`aria-hidden`).
- Text column: line 1, 14/600 ink: `` `Firmware ${latest.version} is available` `` (security: `` `Security update
  ${latest.version} is available` ``), then 400 `var(--muted)`: `` ` · ${behind} of ${total} ${total === 1 ? 'device
  is' : 'devices are'} behind` ``. The version is the FULL version string (today's rule), `break-all`. Line 2, 13 px
  muted: `latest.notes` when present.
- **Action** `firmware-notice-update`, only when exactly one board is selectable (`selectableIds.length === 1`):
  ink 38 px button `` `Update ${name}` `` that ticks that board and opens `update-dialog` (Ruling 13). Otherwise no
  action: per-card ticks (§2.2) and the update bar do it, as today.
- `update-bar` and `update-dialog` keep their content, ids and logic; restyle only: bar = surface card 16 px; its
  `update-start` and the dialog's `update-confirm` become ink 38 px buttons with `var(--surface)` text (were amber
  pills), Cancel/Clear ghost `var(--muted)`; the dialog panel keeps `wf-modal`, title Bricolage 22/700.

### 1.4 Add another drive (board: the dashed `aside`)

`aside[aria-label="Pair another drive"]`, `data-testid="pair-another-card"`: `p-7`, `1.5px dashed var(--line-strong)`,
20 px radius, centred column, gap 14. A 120×52 dashed drive outline (`aria-hidden`, `#C4B9A2` stroke,
`var(--line-strong)` slot), `h2` `Add another drive` (Bricolage 22/700), a `<p>` (14 px muted, max 260 px) `Pair
another WifiFloppy to switch between drives from the header.`, and `pair-another` — a secondary 38 px button `Pair a
device` that opens the header's form (§1.2).

## 2. Device card (`device-card.tsx`; board: ModernDevicesV2 `article`)

`article[aria-label=<name>]`, keeps `id="device-<id>"`, `data-testid="device-<id>"`, `data-state`, `scroll-mt-24`
(the drive chips link to `/devices#device-<id>`). `glass-card` at 20 px radius with
`box-shadow: 0 24px 48px -28px rgb(36 33 27 / .35)`, `overflow-hidden`, flex column. Top to bottom:

1. **Top row** (`px-7 pt-7 pb-6`, flex, gap 32, `items-center`; a column below `md`, gap 20): the drive tile (§3)
   and the info column (§2.1).
2. The offline strip (§9.3), only while offline.
3. The drive box (§4), `mx-3 mb-3`.
4. The last error (`device-error-<id>`, §4.5) and the stuck-start line (`device-last-boot-<id>`, §4.5), `mx-3 mb-3`.
5. A standalone Transfer box (§7) when the board does not report Network and has a send or upload line.
6. The DF1 box (§5), `mx-3 mb-3`, containing the Network panel (§6) and its Transfer box (§7).

### 2.1 Info column (flex-1, `min-w-0`, gap 14)

- **Heading row** (flex, gap 10, `items-center`, wraps):
  - `DeviceAlias`: the name `h2` (`device-name-<id>`), Bricolage 28/700, `-0.01em`, `truncate`, ink. The rename
    trigger `alias-edit-<id>`: a 32×32 ghost button (8 px radius, `var(--muted)`, hover track) with the board's
    16 px pencil (`aria-hidden`); `aria-label` stays `Name` (default name) / `Rename`, and the same word sits inside
    as `<span className="sr-only">` (`device-alias.spec` reads the button's text; the old `::before` pencil trick and
    its comment go). Editing: `alias-input-<id>` (`h-[38px] rounded-[9px]`, 1 px ink border, 16/600, `sm:w-60`),
    `alias-save-<id>` ink 38 px `Save` / `Saving…`, `alias-cancel-<id>` ghost `Cancel`. Enter / Escape unchanged.
  - a spacer;
  - **Board settings** `board-settings-<id>`: `h-8 rounded-[9px] border px-2.5`, line border, transparent, 13/500
    ink, the board's 14 px gear icon, words `Board settings`, `aria-haspopup="dialog"`. When the NFC line is not OK
    (§8.3) a 7 px `var(--fetch-dot)` dot sits at its top-right, `data-testid="board-settings-attention-<id>"`, with
    `<span className="sr-only">: needs attention</span>` inside the button (Ruling 21).
  - **Status pill** `device-status-<id>`: `rounded-full px-2.5 py-1`, 13/600, an 8 px dot with a 3 px halo. Online:
    `var(--success-bg)` / `var(--success-fg)`, dot `var(--online-dot)`, halo `rgb(63 191 85 / .2)`, text `Online`.
    Offline: `var(--danger-bg)` / `var(--danger-fg)`, dot `var(--danger-fg)`, halo `rgb(179 52 31 / .2)`, text
    `Offline`. Both values always rendered (Ruling 10: no "Reading").
- **Facts** `dl`, `grid-cols-2` below `sm`, `sm:grid-cols-4`, gap 16; each `dt` 12 px `var(--muted-2)`, each `dd`
  mono 13 px ink:
  - `Network` — the MAC, or `—`.
  - `Signal` — `data-testid="device-signal-<id>"`: three bars (3 px wide, heights 5 / 8 / 11 px, 1 px radius,
    `aria-hidden`), lit `var(--ink)`, unlit `var(--line-strong)`, lit count = `rssiBars(rssi)` (live-display.ts;
    `-1` lights none), then `` `${rssi} dBm` `` or `—` while offline or unreported (Ruling 11).
  - `Firmware` — `device-firmware-<id>`: `firmwareCellText(update ?? firmwareLabel(firmware))` (§2.2), mono 13,
    `var(--amber-text)` when an update is in flight or the board is behind, else ink; `overflow-wrap: anywhere`.
  - `Last seen` — `device-seen-<id>`: `relative(lastSeenAt, now)` (`12s ago`, `14m ago`, `never`), 13 px sans.
- `PairButton` is not in the card.

### 2.2 Firmware cell extras

Under `device-firmware-<id>`, in the same `dd`, 12 px sans:
- `device-select-<id>` — a checkbox labelled `Select for update`, only when the board is selectable (today's rule).
- `device-cancel-update-<id>` — a ghost link-button `Cancel update`, only while an update is in flight.
- `firmwareCellText(s)` (new, `src/lib/devices-look.ts`): drops a leading `fw ` (`fw 1.21.0 · up to date` →
  `1.21.0 · up to date`; `fw unknown` → `unknown`); update labels pass through unchanged (Ruling 12).

## 3. Drive tile (`drive-art.tsx` new, `drive-glass.tsx` new from `drive-bezel.tsx`; board: the 340 px tile)

- Wrapper `data-testid="device-bezel-<id>"` (the old bezel's id): `w-full md:w-[340px]`, `shrink-0`,
  `px-[18px] pt-[22px] pb-[18px]`, `var(--ground)`, 16 px radius, column, gap 14, `items-center`.
- **`DriveArt`** — the board's SVG drive (viewBox `0 0 304 132`, `width="100%"`, max 304 px, height auto):
  case gradient, bezel, the four stripes, the slot, the disk sliver (opacity 1 when DF0 holds or is getting a disk,
  0 when empty), the LED with its glow, the eject-button drawing and the `DF0` engraving, the feet. Literal colours
  (it is a picture of hardware, like the logo); gradient ids from `useId` (two cards on a page must not share
  `mdCase`). The LED colour is `var(--online-dot)` online and `var(--danger-fg)` offline. `role="img"`,
  `aria-label` = `` `${name}, ${online ? 'online' : 'offline'}, ${hasDisk ? 'disk in drive' : 'drive empty'}` ``.
  **128×64 panel:** the case is drawn 21 units taller (viewBox height 153) and everything below the top band moves
  down 21, so the taller glass fits (Ruling 4). Nothing on the art is interactive: the ON/DISK LEDs and the EJECT
  button of today's bezel go (Ruling 3; Eject moves to the drive box).
- **`DriveGlass`** — the board's own screen, kept from `drive-bezel.tsx`: `display.wasm`, the stored layout with
  `stripRotation`, `liveDisplayState`, the lemming tick while online, `paintFramebuffer` in white. It is the button
  `device-oled-<id>` absolutely placed over the art at the board's spot, in percentages so it scales with the SVG:
  `left: 5.9%; top: 8.3%; width: 29.6%` (= 18 / 11 / 90 of 304×132; for 128×64 `top` is computed on 153), `padding:
  1px 4px`, `#1C1B18` fill, 4 px radius, `inset 0 0 0 1px rgb(255 255 255 / .06)`; the canvas keeps 256 × rows×2
  internal pixels, `width: 100%`, `image-rendering: pixelated`. `aria-label` `` `Change display — showing:
  ${words}` ``, `data-oled` = the words (as today), `aria-haspopup="dialog"`; a click opens the Board display modal.
  The board's hover lift (`translateY(-1px)` + 2 px `#EE8A2A` ring) is kept, off under `prefers-reduced-motion`.
- **Caption row** (full width, 12 px `var(--muted-2)`, space-between): `` `Board display · ${panel}` `` (`128×32` /
  `128×64`), then a ghost 28 px button `display-toggle-<id>` with the board's 14 px monitor icon and the words
  `Change display` (12/600 ink, `aria-haspopup="dialog"`), and beside it (never inside it) the `display` help tip.

## 4. Drive box — DF0 (`drive-box.tsx` new; board: the `#F6F2E9` "In the drive" strip)

`data-testid="device-disk-<id>"` (the old words block's id, now always visible: Ruling 5): `p-4`, 14 px radius,
`var(--surface-2)`, flex, gap 16, `items-center`, wraps below `md` (buttons go to a second line, left-aligned).

### 4.1 Left: the disk

- Holding or getting a disk: `DiskIcon` 64 px, `color = driveDiskColor(mountedGameId ?? desiredGameId)`
  (§4.3), `wp` = `mountedWriteProtected === true`, `aria-hidden`.
- Empty: a 64×65 `1.5px dashed #C4B9A2` 6 px-radius placeholder, `aria-hidden`.

### 4.2 Middle: three lines (flex-1, `min-w-0`, gap 3)

Computed by a new pure `driveBoxText(device, state)` (`src/lib/devices-look.ts`), moved out of the card's inline
`heading` / `bigText` / `subText` with the same words:

| state | label (12 px) | title (17/600, `overflow-wrap: anywhere`) | meta (mono 12, `var(--muted)`) |
|---|---|---|---|
| `converged` | `In the drive` (`var(--muted-2)`) | `mountedGame ?? 'Unknown'` | `` `disk ${no}` `` + `` ` of ${count}` `` when count > 0 |
| `pending`, mounting | `Mounting…` (`var(--muted)`) | `desiredGame ?? 'Unknown'` | `` `disk ${no}` `` + `` ` · currently holding ${mountedGame} disk ${m}` `` while one is held |
| `pending`, ejecting | `Ejecting…` | `mountedGame ?? 'a disk'` | `` `Removing disk ${m}` `` |
| `stale` | `Requested` (`var(--amber-text)`) | `desiredGame ?? 'Unknown'` | `` `disk ${no}` `` |
| `empty` | `In the drive` | `No disk` (Ruling 6) | `Mount a disk from any title in the library.` (sans 13 px) |

- When converged and `mountedGameId` is known, the title is a `Link` to `/games/<mountedGameId>`
  (`device-disk-title-<id>`, ink, underline on hover). No disk size (Ruling 7).
- The preload line (`device-preload-<id>`, `data-preload`, `preloadText(...)`, today's gate: a preload exists, the
  board is converged, and not Network before `NET_PICK_FW`) is a fourth line, 12 px `var(--muted)`, with the
  `next-disk` help tip after it.

### 4.3 `driveDiskColor` (`src/lib/library-look.ts`)

`driveDiskColor(gameId: string | null): DiskColor` = `cream` for null, else
`['black','red','blue','green'][hash(gameId) % 4]` — the same hash and palette as `titleDiskColor`'s typed branch,
so a typed title's disk matches its library card (Ruling 9). `listDevices` adds `mountedGameId: mountedGame.id` (the
org-scoped alias, null when the row names another org's game) and the card uses `desiredGameId`'s already-joined
`desiredGame.id` the same way (added as `desiredGameId` on `DeviceListItem` from `desiredGame.id`).

### 4.4 Right: actions (gap 8; 38 px buttons, 10 px radius, 13 px)

In this order, each only where it applies:
- **Write protection** `device-protection-<id>` (Ruling 8): a `button` with `aria-pressed`, the C1 switch (32×18
  track: ink when protected, `var(--line-strong)` when writable; 14 px `var(--surface)` knob), then the word, inside
  a secondary 38 px frame (surface, line border). Converged with a disk: label `Protected` / `Writable`
  (`mountedWriteProtected`), click → `requestWriteProtect(mountedDiskId, !current)` then `router.refresh()`;
  busy disables it. Any other state (empty, pending, stale, or converged with `mountedWriteProtected === null`):
  the same frame, disabled, track `var(--track)`, knob centred, label `—`, `title="Shown once the board holds a
  disk"`.
- **Next** `next-disk-<id>`: secondary, `` `Next: disk ${n}` `` / `Switching…`; converged and a next exists (today).
- **Change disk** `device-change-disk-<id>`: secondary `Link` to `/library`; converged or pending.
- **Eject** `eject-<id>`: ink, the board's 14 px eject glyph, words `Eject`; while the request runs `Ejecting…`
  and `aria-label="Ejecting…"` (today's label rule); shown while ejectable (`desiredSha256 ?? mountedSha256`).
- Empty only: **Re-insert last disk** `reinsert-<id>` (today's two lines: `Re-insert last disk` 13/600 and
  `` `${title}, disk ${n}` `` 11 px muted, secondary frame, min-height 38, `overflow-wrap: anywhere`), when the last
  disk is known; then **Open library** `device-open-library-<id>`: ink `Link` to `/library`.

### 4.5 Under the drive box

- `device-error-<id>` (when `lastError`): `rounded-[12px] px-3.5 py-2.5`, `var(--danger-bg)`, 13 px
  `var(--danger-fg)`, `overflow-wrap: anywhere`; text unchanged.
- `device-last-boot-<id>` (when `describeLastBoot` gives a line): `var(--warning-bg)` / `var(--warning-fg)` strip,
  same shape; words unchanged (Ruling 19b: it stays on the card).

## 5. DF1 box (`second-drive-setting.tsx`; board: the bordered DF1 block)

`data-testid="device-df1-<id>"`: 1 px `var(--line)` border, 14 px radius, column.

### 5.1 Header row (`px-4 py-3.5`, flex, gap 16, `items-center`; wraps below `lg`, the radios on their own line)

- A 40×40 `var(--track)` 10 px tile, mono 12/600 `var(--muted)` `DF1` (`aria-hidden`).
- Text column (flex-1, `min-w-0`, gap 3):
  - `Second drive (DF1)` 14/600, then the `second-drive` help tip.
  - `second-drive-help-<id>` 12 px `var(--muted-2)` — today's four sentences, unchanged (only when capable):
    off `No second drive: the Amiga sees DF0 only.`; df1 `DF1 holds the next disk of the set, read-only, so a game
    asking for its next disk finds it.`; any `DF1 holds a disk you mount into DF1 from the library, read-only.` +
    ` Mount one with a title’s Mount → DF1; until then DF1 holds the next disk of the set.` when no pick; net `The
    Amiga’s network: the driver disk sits in DF1 and PaulaNET carries Ethernet over the floppy cable.`
    (moved to `secondDriveHelp(shown, hasPick)` in `src/lib/second-drive.ts`).
  - Readings line, 12 px `var(--muted-2)`, the parts joined by ` · `: `device-sel1-<id>` (`DF1 line: connected` /
    `DF1 line: no signal yet`, `data-value`) and `device-df1seen-<id>` (`Other DF1 drive: detected` / `none seen`,
    `data-value`) when the board reports them, then `second-drive-status-<id>` (`secondDriveStatus`: `Set on the
    board — takes effect when the Amiga restarts` / `Waiting for the board` / `Needs firmware 1.9.0 or newer` / the
    old-firmware DF1 text). Spans, so each keeps its id.
- **Mode radiogroup** `second-drive-<id>` (Ruling 14): `role="radiogroup"`, `aria-label="Second drive mode"`,
  `data-value` = the shown mode (`off` / `df1` / `any` / `net`), class `seg seg--sm`. Four `button role="radio"`
  `seg-item` with `aria-checked`, in the board's order:
  `second-drive-<id>-off` `Off` · `second-drive-<id>-df1` `Next disk of the set` · `second-drive-<id>-net`
  `Network (PaulaNET)` · `second-drive-<id>-any` `Any disk` (Ruling 15). Roving focus: arrow keys move and select,
  Tab enters on the checked one. All four `disabled` while `!secondDriveCapable`, busy or refreshing; `-net` also
  disabled while `!secondDriveNetCapable`, and then `second-drive-net-note-<id>` (12 px `var(--muted-2)`, under
  the group) reads `Network needs firmware 1.11.0 or newer` (Ruling 16). `choose()` / `save()` and their rules are
  unchanged (Any with no pick turns DF1 on; Next with a pick ejects it).
- `.seg--sm` (new, `globals.css`): padding 3 px, radius 10 px; its items 32 px high, `px-3`, 13/500, ink; and the
  active rule gains `[aria-checked="true"]` beside `aria-current` / `aria-pressed`.

### 5.2 Body rows (each `px-4 pb-3.5`, 12 px)

- The DF1 contents line, while the board reports DF1 and is capable: `device-df1-disk-<id>` (`df1LineText`, words
  unchanged) and, with a pick, `eject-df1-<id>`: secondary 30 px `Eject DF1`.
- `second-drive-error-<id>` (`role="alert"`, `var(--amber-text)`) and `second-drive-refused-<id>`
  (`var(--warning-bg)` strip): words, `second-drive-override-<id>` `Switch on anyway…` and
  `second-drive-override-confirm-<id>` `Yes, I have removed the other DF1 drive — switch DF1 on` unchanged.

## 6. Network checklist (`network-checklist.tsx`, `driver-line.tsx`; board: `ul[aria-label="Amiga network"]`)

While the board **reports** Network and is capable (today's gate, Ruling 17), the DF1 box gets a panel:
`border-t 1px var(--hairline)`, `pl-4 md:pl-[72px] pr-4 pt-3 pb-3.5`, a grid `md:grid-cols-[minmax(0,1fr)_300px]`,
gap 20 (one column below `md`).

- Left: `ul[aria-label="Amiga network"]` `data-testid="net-checklist-<id>"`, gap 8. Each row `li` keeps its id
  (`net-disk-<id>`, `net-driver-<id>`, `net-ip-<id>`) and `data-ok`; flex, gap 10, 13 px:
  - a 20×20 round mark, `aria-hidden`: OK `✓` on `var(--success-bg)` / `var(--success-fg)`; not OK `•` on
    `var(--warning-bg)` / `var(--warning-fg)`; 12/700;
  - the line split by `splitCheckLine(text)` (new, `src/lib/network-checklist.ts`) at its first `": "` into
    `<span className="font-medium">{label}:</span>{' '}<span style={{ color: OK ? 'var(--muted)' : 'var(--warning-fg)' }}>{detail}</span>`,
    so the element's text stays `Driver disk: in DF1`, `Driver: talking (last seen 12 s ago)`, `Amiga address:
    172.16.10.231` (every word unchanged; a line without `": "` renders whole).
  - `net-traffic-<id>` (when frames moved) as a fourth row without a mark, 12 px `var(--muted-2)`, words unchanged.
  - The `network` help tip after the list.
- Right: the Transfer box (§7).

## 7. Transfer box (`transfer-box.tsx` new; board: the `#F6F2E9` link card)

`data-testid="device-transfer-<id>"`: `p-[10px_12px]`, 12 px radius, `var(--surface-2)`, column, gap 3 (Ruling 18).

- Title row `device-transfer-state-<id>`, 13/600, `data-running`, an 8 px dot: only for a board that can take files
  (it is in `listSendTargets`): `Transfer is running on the Amiga` (dot `var(--online-dot)`) or `Transfer is not
  running on the Amiga` (dot: 1.5 px `var(--muted-2)` ring, no fill). `running` = `receiverRunning(target,
  (summary?.sending ?? 0) > 0, now)`, computed in `page.tsx` beside `cardSendLine` and passed as
  `transferById[id] = { running }`.
- Then today's two lines, words and targets unchanged, 12 px: `device-send-<id>` (`Link` to
  `/ingest?board=<id>`, ink, underline) and `device-upload-<id>` (`Link` to `/ingest?from=<id>#from-amiga` when
  `href`, else muted text).
- With a title but neither line: `device-transfer-idle-<id>` 12 px muted `Nothing waiting, and nothing from the
  Amiga in the last 24 hours.`
- Where it sits: inside the Network panel (§6) when the board reports Network; otherwise, when a send or upload line
  exists, as a standalone `mx-3 mb-3` row under the drive box; otherwise nowhere.

## 8. Board settings modal (`board-settings.tsx` new; board: ModernDevicesV2Settings)

Opened by `board-settings-<id>`. Built on the shared `Modal` (§10.1). `data-testid="board-settings-dialog"`,
`data-device-id=<id>`, width 620 (full screen below `sm`).

### 8.1 What moves in, and what stays (Ruling 19)

In: **Disk at startup** (from the card), **NFC reader** (from the card), **Delete device** (from the card's trash
icon). Stays on the card: rename (board: inline pencil), DF1 and Network (board: on the card), firmware (cell +
banner), the stuck-start line and the last error (alerts belong where they are seen).

### 8.2 Layout

- Header (`px-6 pt-5 pb-4`, bottom border `var(--line)`): `h2` `Board settings` (Bricolage 24/700), subtitle 13 px
  muted `` `${name} · nothing changes until you save.` ``; close `board-settings-close` (36×36 ghost, X icon,
  `aria-label="Close"`).
- Body (`px-6 py-5`, gap 22):
  - **Disk at startup** (14/600 heading, then the `boards` help tip):
    - capable or already `empty`: radiogroup `boot-disk-<id>` (`.seg .seg--sm`, `data-value` = the draft),
      radios `boot-disk-<id>-last` `Last disk` and `boot-disk-<id>-empty` `No disk` (disabled when
      `!bootDiskCapable`, with `boot-disk-note-<id>` beside it: `Needs firmware 1.18.1 or newer`).
      Hint `boot-disk-hint-<id>`, 12 px `var(--muted-2)`: last `The board puts the last disk back in DF0 when it
      starts.`; empty `The board starts with DF0 empty.`
    - older firmware still on the default: today's one line, unchanged — `boot-disk-fixed-<id>` `Disk at startup:
      Last disk` and `boot-disk-note-<id>` `— needs firmware 1.18.1 or newer`.
    - no firmware reported yet: `boot-disk-unknown-<id>` `Shown once the board reports its firmware.`
    - `boot-disk-error-<id>` (`role="alert"`) for a refused save, words as today.
  - **NFC reader** (14/600): a `var(--surface-2)` 12 px-radius row (`px-3.5 py-3`, gap 12): an 8 px dot
    (`var(--online-dot)` OK, `var(--danger-fg)` not), then `device-nfc-<id>` (`data-ok`) with `i2c.line` 13/600 and,
    when present, `device-i2c-<id>` (`i2c.seen`, mono 12 muted). Board firmware that sends no scan:
    `device-nfc-unknown-<id>` `This firmware does not report its reader (needs 1.17.0 or newer).` (Ruling 22). Under
    it, 12 px `var(--muted-2)`: `Tap a card written from a title to mount it; a Next-disk card moves to the next
    disk of the set.` and the `nfc` help tip. No Scan again.
- Footer (`px-6 py-3.5`, top border, `var(--modal-foot)` new token `#FBF8F1`, flex, gap 10): left
  `device-delete-<id>` — ghost 38 px, 14 px trash icon, `Delete device…`, `var(--danger-fg)`, `aria-label` and
  `title` `` `Delete ${name}` `` (today's); spacer; `board-settings-cancel` secondary `Cancel`;
  `board-settings-save` ink `Save to board` / `Saving…`.

### 8.3 Behaviour

- The draft starts from `device.bootDisk` at each open. Save is disabled until the draft differs (and while busy).
  Save sends today's `PATCH /api/devices/<id>/boot-disk {mode}`; on 200 the modal closes,
  `toast.success('Disk at startup saved. The board uses it at its next start.')` and `router.refresh()`; on a
  refusal the modal stays open with `boot-disk-error-<id>` (Ruling 20).
- Cancel, the X, Escape and a backdrop press close without a request (not while saving).
- `device-delete-<id>` closes this modal and opens today's delete confirm (`device-delete-dialog`, its words,
  `device-delete-cancel`, `device-delete-confirm`), which is split into `DeleteDeviceConfirm` (controlled) so it
  can be opened from here (Ruling 23). Focus returns to `board-settings-<id>` when either closes.
- "NFC line not OK" (for the attention dot, §2.1) = `describeI2cScan(...)` is non-null and `ok === false`.

## 9. States

### 9.1 Empty (no devices)

`data-testid="devices-empty"`, `data-empty="devices"`: `var(--surface)`, `1px dashed var(--line-strong)`, 20 px
radius, `px-8 py-16`, centred column, gap 14: the 120×52 drive outline (§1.4), `<p>` `No devices paired yet`
(Bricolage 22/700), `<p>` 14 px muted `Press Pair a device and enter the code on the board.`, and `pair-another`
(the same button as the aside, `Pair a device`). `devices-page.spec`'s `getByText('No devices paired yet')` holds.

### 9.2 Loading (`src/app/(app)/devices/loading.tsx`, new)

`data-testid="devices-skeleton"` inside `PageSkeleton`: a 44 px heading bone and a subtitle bone, then one card-shaped
bone (20 px radius) holding a 340×176 tile bone, a 28 px name bone, a four-cell row of bones, and a 96 px drive-box
bone; at `lg` a 360 px dashed aside bone beside it. Nested under `(app)/loading.tsx` like the library's, so status
codes do not change.

### 9.3 Offline (board: InfStates "A board that stopped reporting")

The card keeps every control (requests are queued, as today). Between the top row and the drive box:
`data-testid="device-offline-<id>"`, `mx-3 mb-3 rounded-[14px] px-4 py-3`, `var(--danger-bg)`:
- 14/600 ink `` `${name} is offline` ``;
- 13 px muted: `device-last-seen-<id>` `` `It was last seen ${relative(lastSeenAt, now)}.` `` then ` Mounts, ejects
  and settings you change now reach it when it reconnects. Check its power and Wi-Fi.` (Ruling 30). Only offline
  cards render `device-last-seen-<id>` (`devices-page.spec` asserts its absence on an online card).

### 9.4 Not found / error

Unchanged (A1/C1's `StateCard`, `ErrorView`).

## 10. Board display modal (`display-editor.tsx`; board: ModernDevicesV2 `display-open`, ModernOled)

### 10.1 Shared `Modal` (`src/components/ui/modal.tsx`, new)

On Base UI Dialog (`@base-ui/react/dialog`; read `node_modules/@base-ui/react/docs/react/components/dialog.md`
first): portalled; backdrop `var(--scrim)`; popup `.glass-card .wf-modal`, `max-h-[calc(100dvh-32px)]`, flex column,
`overflow-hidden`; full screen below `sm` (`max-sm:inset-0 max-sm:rounded-none max-sm:max-h-none`). Props: `open`,
`onOpenChange`, `title`, `subtitle?`, `badge?` (header extra), `footer`, `width` (`620` | `940`), `testId`,
`dismissible` (false while a request runs: `onOpenChange(false)` from Escape or the backdrop is ignored, and
`disablePointerDismissal` is set), `closeTestId`, `finalFocus?` (a ref; passed to `Dialog.Popup`). Header and
footer as §8.2. Focus moves into the popup on open (Base UI's default: the first tabbable element) and returns on
close to `finalFocus`, else to the element focused before opening — the button that was pressed.

### 10.2 Opening and closing

- `display-toggle-<id>` and `device-oled-<id>` open it. `DriveFront` keeps the open state (as today) and mounts the
  editor only while open, so closing discards unsaved edits (today's rule).
- `data-testid="display-drawer-<id>"` moves to the modal popup (the drawer is gone); `display-editor-<id>` stays on
  the editor's body.
- Header: `h2` `Board display`; subtitle `` `Choose what ${name}’s screen shows. Changes are sent to the board when
  you save.` ``; `display-unsaved-<id>` pill (`var(--warning-bg)` / `var(--warning-fg)`, 12/600) `Unsaved changes`
  while dirty; close `display-close-<id>`. Under the subtitle, `display-status-<id>` (`statusLine`, words
  unchanged), 12 px, `var(--amber-text)` when `warn` else `var(--muted)`.
- Cancel (`display-cancel-<id>`, secondary `Cancel`, was a red button), the X, Escape and the backdrop: close, no
  request (not while saving).
- **Save** (`display-save-<id>`, ink `Save to board` / `Saving…`): today's request; the modal **stays open** and the
  status line turns to `Waiting for the board` (Ruling 26). Disabled on a validation problem, busy or refreshing.
- **Reset** (`display-reset-<id>`, ghost `Reset to default`, footer left): today's immediate server reset, keeping
  the turn; `title="Puts the built-in layout on the board now"` (Ruling 27).
- No display support: the body is `display-needs-fw-<id>` `Needs firmware 1.7.1 or newer` (amber) and the footer only
  `display-cancel-<id>` `Close`.

### 10.3 Body (`md:grid-cols-[440px_minmax(0,1fr)]`; one column below `md`, preview first)

**Left** (`p-6`, gap 18, `var(--surface-2)`, right border `var(--line)`):
- The preview: a `#1C1B18` 14 px-radius frame (`p-5`, `inset 0 0 0 1px rgb(255 255 255 / .06)`) holding
  `display-canvas-<id>` (internal 512 × rows×4 as today; CSS `width: 100%`, max 384 px, `image-rendering:
  pixelated`, the pointer drag and touch rules unchanged). `display-reason-<id>` under it (amber, words unchanged).
- **Preview as** (12/500 `var(--muted-2)` label): a wrapping radiogroup `display-preview-<id>`
  (`aria-label="Preview as"`, `data-value`), one chip per situation, `display-preview-<id>-<key>`
  (`ready`, `download`, `writable`, `readonly`, `long`, `armed` (only with the NFC element), `connecting`, `error`),
  words from today's `PREVIEWS` (`Ready`, `Downloading 64 %`, `Mounted, writable`, `Mounted, read-only`, `Long title`,
  `Tag write armed`, `Connecting`, `Error`; Ruling 29). Chip: 30 px, `rounded-full px-2.5`, 12/500; checked: ink fill
  `var(--surface)` text; else surface fill, line border, ink.
- **Panel**: radiogroup `display-panel-<id>` (`.seg .seg--sm`, `aria-label="Panel size"`, `data-value`), radios
  `display-panel-<id>-128x32` `128×32` and `display-panel-<id>-128x64` `128×64` (mono 12/600); choosing one does
  what the select did (the default layout for that panel, keeping the turn). Hint 12 px `Match the screen fitted to
  your board.`
- **Rotation** (kept as a select, not on the board): `display-rotation-<id>` with `0°` / `180° (mounted upside
  down)`, `display-rotation-note-<id>` `Shown upright here — the board turns it 180°` at 180; or
  `display-rotation-needs-fw-<id>` `Rotation needs firmware 1.17.0 or newer`. Select `h-[30px] rounded-[8px]`
  surface, line border, mono 12.
- **Snap**: `display-snap-<id>` becomes a switch button (`aria-pressed`, the 32×18 switch) with `Snap to 8 px grid`
  13/500.

**Right** (column, `min-h-0`):
- Heading row (`px-6 pt-4 pb-2`, baseline): `h3` `Elements` 14/600; `display-shown-count-<id>` 12 px muted-2
  `` `${visible} of ${total} shown` `` (`total` = the elements in the layout: 8, or 9 with NFC).
- The list (`px-4 pb-4`, `overflow-y-auto`, gap 2), in the layout's order. Each row `min-h-12 px-2 py-1.5
  rounded-[10px]`, flex, gap 12; hidden rows on `var(--modal-foot)` with muted text and their controls at 45 %
  opacity and disabled:
  - `label` (flex-1): the checkbox `display-visible-<el>` (16 px, `accent-color: var(--ink)`), then the element's
    name 14/500 and hint 12 px `var(--muted-2)` from `ELEMENT_LOOK` (new, `src/lib/display-elements.ts`; Ruling 28):
    `status` `Status` · `READY, LOADING, LOADED — or an icon`; `wifi` `Wi-Fi` · `Signal bars, top left`; `write`
    `Write-protect` · `Lock when the disk is read-only`; `title` `Title` · `Name of the disk in the drive`; `detail`
    `Detail` · `Disk n of n`; `track` `Track` · `Head position, e.g. 42↑79`; `download` `Download` · `Progress bar
    while loading`; `lemming` `Lemming` · `Activity sprite, top right`; `nfc` `NFC` · `Reader icon, struck when none
    is found`.
  - title / detail: `Width` + `display-width-<el>` (58 px number input); download: `Bar` + `display-width-download`.
  - title: `Lines` + `display-lines-title` (select 1 / 2). status: `as` + `display-style-status` (select `word` /
    `icon`), or `display-status-icon-needs-fw-<id>` `icon needs firmware 1.15.0 or newer`.
  - scale: radiogroup `display-scale-<el>` (`aria-label` `` `${name} size` ``, `data-value`), radios
    `display-scale-<el>-1` `1×` and `display-scale-<el>-2` `2×` (34×26, mono 12/600).
  - Without NFC support, the last row is `display-nfc-needs-fw-<id>`: a disabled checkbox and `NFC — needs firmware
    1.10.0 or newer`.
- `display-save-error-<id>` in the footer, left of Cancel (amber, words unchanged).

## 11. Test ids

### 11.1 Kept (name and meaning)

Page: `firmware-notice`, `update-bar`, `update-cap`, `update-start`, `update-dialog`, `update-password`,
`update-no-password`, `update-confirm`, `write-next-card`, `pair-device`, `pair-name`, `pair-cancel`, `pair-submit`,
`pairing-code`, `pairing-for`, `pairing-expiry`, `help-tip-*` (`boards`, `nfc`, `display`, `next-disk`,
`second-drive`, `network`), `page-skeleton`.
Card: `device-<id>` (+ `id`, `data-state`), `device-name-<id>`, `alias-edit-<id>`, `alias-input-<id>`,
`alias-save-<id>`, `alias-cancel-<id>`, `device-status-<id>`, `device-last-seen-<id>` (offline only),
`device-firmware-<id>`, `device-select-<id>`, `device-cancel-update-<id>`, `device-bezel-<id>` (now the drive tile),
`device-oled-<id>` (+ `data-oled`, canvas inside), `display-toggle-<id>`, `device-disk-<id>` (now the drive box,
always visible), `device-protection-<id>` (now a switch button; texts `Protected` / `Writable` / `—`),
`eject-<id>`, `next-disk-<id>`, `reinsert-<id>`, `device-preload-<id>` (+ `data-preload`), `device-error-<id>`,
`device-last-boot-<id>`, `device-send-<id>`, `device-upload-<id>`, `device-sel1-<id>`, `device-df1seen-<id>`
(+ `data-value`), `second-drive-<id>` (now the radiogroup, + `data-value`), `second-drive-status-<id>`,
`second-drive-help-<id>`, `second-drive-error-<id>`, `second-drive-refused-<id>`, `second-drive-override-<id>`,
`second-drive-override-confirm-<id>`, `device-df1-disk-<id>`, `eject-df1-<id>`, `net-checklist-<id>`,
`net-disk-<id>`, `net-driver-<id>`, `net-ip-<id>` (+ `data-ok`), `net-traffic-<id>`.
Moved into Board settings: `boot-disk-<id>` (now the radiogroup, + `data-value`), `boot-disk-fixed-<id>`,
`boot-disk-note-<id>`, `boot-disk-error-<id>`, `device-nfc-<id>` (+ `data-ok`), `device-i2c-<id>`,
`device-delete-<id>`, `device-delete-dialog`, `device-delete-cancel`, `device-delete-confirm`.
Display (now in the modal): `display-drawer-<id>` (now the modal popup), `display-editor-<id>`,
`display-status-<id>`, `display-needs-fw-<id>`, `display-panel-<id>` (now a radiogroup, + `data-value`),
`display-rotation-<id>`, `display-rotation-note-<id>`, `display-rotation-needs-fw-<id>`, `display-preview-<id>` (now
a radiogroup, + `data-value`), `display-snap-<id>` (now a switch, `aria-pressed`), `display-canvas-<id>`,
`display-reason-<id>`, `display-visible-<el>`, `display-scale-<el>` (now a radiogroup, + `data-value`),
`display-width-<el>`, `display-style-status`, `display-status-icon-needs-fw-<id>`, `display-lines-title`,
`display-nfc-needs-fw-<id>`, `display-save-<id>`, `display-reset-<id>`, `display-cancel-<id>`,
`display-save-error-<id>`.

### 11.2 New

`firmware-notice-update`, `pair-another`, `pair-another-card`, `devices-empty` (+ `data-empty="devices"`),
`devices-skeleton`, `device-seen-<id>`, `device-signal-<id>`, `device-offline-<id>`, `board-settings-<id>`,
`board-settings-attention-<id>`, `board-settings-dialog` (+ `data-device-id`), `board-settings-close`,
`board-settings-cancel`, `board-settings-save`, `boot-disk-<id>-last`, `boot-disk-<id>-empty`,
`boot-disk-hint-<id>`, `boot-disk-unknown-<id>`, `device-nfc-unknown-<id>`, `device-disk-title-<id>`,
`device-change-disk-<id>`, `device-open-library-<id>`, `device-df1-<id>`, `second-drive-<id>-off|df1|net|any`,
`second-drive-net-note-<id>`, `device-transfer-<id>`, `device-transfer-state-<id>` (+ `data-running`),
`device-transfer-idle-<id>`, `display-close-<id>`, `display-unsaved-<id>`, `display-shown-count-<id>`,
`display-preview-<id>-<key>`, `display-panel-<id>-128x32|128x64`, `display-scale-<el>-1|2`.

### 11.3 Removed

None. (`device-bezel-<id>` and `display-drawer-<id>` keep their names on new elements.)

### 11.4 Specs that change, and why

| Spec | Change |
|---|---|
| `devices-page.spec.ts:285` "three paired devices share one row…" | rewritten: with 3 boards each card is the full content width (± 2 px of each other, `x` equal), stacked; opening one board's display modal leaves every card's height unchanged |
| `devices-page.spec.ts:464` "the bezel display names the mounted disk…" | converged: `device-disk-<id>` visible, contains `In the drive` and the title (no `sr-only` assert); pending: contains `Mounting…` and the new title; `data-oled` asserts unchanged |
| `devices-page.spec.ts:498` "pressing the bezel display opens the drawer…" | pressing `device-oled-<id>` opens `display-drawer-<id>` with `role="dialog"`; Escape closes it and focus returns to `device-oled-<id>` (the `inert` assert goes) |
| `devices-page.spec.ts:561`, `:584` (I2C, PN532) | open Board settings first (`openBoardSettings(page, id)`); asserts unchanged; plus `board-settings-attention-<id>` present for the board without a reader and absent for the one with |
| `devices-page.spec.ts:603`, `:651` (Disk at startup) | open Board settings; `:603` clicks `boot-disk-<id>-empty`, then `board-settings-save` inside the `waitForResponse`; `toHaveValue('last'|'empty')` → `toHaveAttribute('data-value', …)`; `:651` asserts unchanged after opening |
| `devices-page.spec.ts:72`, `:348`, `:163` | unchanged (texts `In the drive` / `Mounting…` / `Requested` / `No disk`; `Protected` / `Writable` / `—`; `eject-<id>` click) |
| `device-delete.spec.ts:14` | `openBoardSettings` before each `device-delete-<id>` click |
| `second-drive.spec.ts` (~15 sites) | `selectOption(m)` → `pickSecondDrive(page, id, m)` (clicks `second-drive-<id>-<m>`); `toHaveValue(m)` → `toHaveAttribute('data-value', m)`; `:28` `toBeDisabled()` on each of the four radios; `:93` the `option[value=net]` asserts → `second-drive-<id>-net` disabled and `second-drive-net-note-<id>` text; `:201` the option-text asserts → the four radios' texts in order `Off`, `Next disk of the set`, `Network (PaulaNET)`, `Any disk` |
| `display-layout.spec.ts:50` | `selectOption('128x64')` → click `display-panel-<id>-128x64` |
| `display-layout.spec.ts:165` | `'▸ Change Display'` → `'Change display'` |
| `display-layout.spec.ts:189` | `selectOption('2')` → click `display-scale-nfc-2` |
| `mobile.spec.ts:133` | rewritten (Ruling 2): "Devices cards are one per row at 390 px, and nothing overflows" — the same four long-text boards; each card ≥ 330 px wide, cards stacked (`y` strictly increasing), no page overflow |
| `screenshots.shots.ts` (Devices) | `display-editor` shot without `{ tall: true }` (a modal is viewport-fixed); waits for `display-drawer-<id>` |
| `contrast.spec.ts` | new Devices test (§12) |
| `e2e/device-helpers.ts` | `openBoardSettings(page, id)` (click `board-settings-<id>`, wait `board-settings-dialog`) and `pickSecondDrive(page, id, mode)` |

Regression only (no edit expected): `reinsert`, `next-disk`, `devices-firmware`, `firmware-update-loop`,
`device-alias`, `pairing`, `send-to-amiga`, `from-amiga`, `live-state`, `nfc-tap`, `drive-chips`, `help`,
`help.mobile`, `mount-to-device`, `write-protect-live`, `states`, `shell`.

## 12. Contrast pairs (WCAG 2.x; added to `contrast.spec.ts` on `/devices` and to `devices-look.test.ts`)

| Pair | Ratio | Where |
|---|---|---|
| `--muted-2` `#6E6657` on `--surface-2` | 5.08 | drive-box label, DF1 hints |
| `--muted-2` on `--ground` | 4.94 | drive-tile caption |
| `--muted` `#5B5446` on `--danger-bg` `#F8E1DB` | 5.99 | offline strip body |
| ink on `--danger-bg` | 12.8 | offline strip heading |
| `--success-fg` on `--success-bg` | 5.57 | Online pill, OK marks |
| `--danger-fg` on `--danger-bg` | 4.90 | Offline pill, last error |
| `--warning-fg` on `--warning-bg` | 6.38 | not-OK marks, stuck-start line, Unsaved pill |
| `--muted` on `--track` | 6.20 | DF1 tile |
| `--muted-2` on `--modal-foot` `#FBF8F1` | 5.35 | hidden element rows, modal footers |
| `--surface` on ink | 15.79 | ink buttons, checked chips |

The board's `#7A7262` captions are `--muted-2` (Phase B ruling 4). The drive art and the OLED frame are pictures
(literal colours, no text but the decorative `DF0` engraving, `aria-hidden` inside a labelled `role="img"`).

## 13. Phone (390 px) — only what the boards and today's specs pin

Area 7 owns the full phone pass. Here: one card per row at full width (`devices-page.spec` "uses the whole width",
`mobile.spec.ts:133` rewritten); the top row stacks (drive tile full width, the SVG and its glass scale together);
the `dl` is two columns; the drive box and DF1 header wrap their buttons onto a second line; the radiogroups wrap;
both modals are full screen with their bodies scrolling; `write-next-card` fits (`mobile.spec.ts:572`); nothing
scrolls the page sideways. InfPhone's "Change second drive" button is area 7.

## 14. Out of scope

- The header, drive chips and nav (Phase B; area 7 for the phone).
- Toasts restyled to the board's ink toast (shell-wide, later).
- A "current drive" / "Controlling" chip; the board's single-disk `Reading` status (no head-activity report).
- A disk size in the drive box; a board IP on the offline card; "Last disk" on the offline card.
- DF1 write-back ("Any disk" writable — roadmap backlog), NFC Scan again (operator).
- Restyling `update-dialog`'s and `device-delete-dialog`'s structure beyond tokens and button shapes; moving them
  onto the shared `Modal`.
- `Upload` / Transfer page itself (area 3).

## Rulings (operator to review)

1. **One wide card per row** (board), the 3-per-row grid retired; the "Add another drive" aside shows only beside a
   single board (with 2+ boards an aside beside the first card leaves an empty column under it). Cost: a long page
   for many boards; `devices-page:285` is rewritten.
2. **`mobile.spec.ts:133` is owned here and rewritten** to one card per row. It asserted two columns at 390 px while
   `devices-page` "on a phone a device card uses the whole width" asserts one; the second is the newer operator-asked
   behaviour (Pillock, 2026-10-19). Cost: none; it was failing.
3. **The dark bezel becomes the board's cream drive picture**; its ON/DISK LEDs and EJECT button go, Eject moves to
   the drive box with the same id and label rule. Cost: no hardware-like eject on the picture.
4. **The OLED glass is small (the board's 90×24 slot), still the board's own wasm render**, and still opens the
   editor; a 128×64 panel makes the drive drawing 21 units taller so its glass fits. Cost: the card's screen is not
   readable; the drive box says the disk in words.
5. **The drive box always names the disk** (board). The 3ay rule "words only while the OLED is wrong" and its
   `sr-only` toggling retire, and with them the `w-full`/`sr-only` trap. Cost: the disk is named twice (glass and box).
6. **An empty drive's title stays `No disk`** (board: `Drive empty`): the OLED says No disk and two specs read it.
7. **No disk size in the meta line** (board `· 880 KB`): `DeviceListItem` has none; a join for a cosmetic is not
   worth it. Cost: one fact fewer than drawn.
8. **Write protection becomes a switch in the drive box** (board), wired to the existing `requestWriteProtect` the
   drive chips use; labels `Protected` / `Writable` (board `Write-protected`, C1's switch says `Protected`); in every
   state without a confirmed disk the switch is shown disabled with `—` (board shows none when empty). Cost: a dead
   control in three states; `devices-page:348` keeps passing.
9. **The drive's disk colour hashes the game id** with the library's typed palette (`driveDiskColor`); an untyped
   title is cream in the library but coloured here (the card does not know a title's kind). Needs `mountedGameId` /
   `desiredGameId` from the org-scoped joins. Cost: colour mismatch for untyped titles.
10. **Status is Online / Offline only**; the board's `Reading` state has no data behind it. Cost: none.
11. **Three signal bars** (the firmware's `rssiBars` thresholds), not the board's four. Cost: one bar fewer.
12. **The Firmware cell keeps today's words** without the `fw ` prefix (`1.21.0 · up to date`, `1 release behind`,
    `update queued — waiting for eject`); the board's `· update available` is not adopted (specs and Help use
    today's words). Cost: words differ from the board.
13. **The banner's `Update <name>` appears only when exactly one board can be updated** and opens today's password
    dialog with it ticked; with several, the per-card `Select for update` ticks and the update bar stay. The board's
    queued pill + Cancel stay per card. Cost: a multi-board org sees no banner button.
14. **DF1 is a segmented radiogroup in the board's order** (Off · Next disk of the set · Network · Any disk; today's
    select put Any before Network). ~15 `second-drive.spec` sites move to a helper. Cost: spec churn; arrow keys now
    select (a radiogroup's rule).
15. **`Any disk` without `(read-only)`**; the always-visible help line says read-only. The board's "writable like
    DF0" is not true until DF1 write-back ships (backlog). Cost: the label alone does not say read-only.
16. **Network on old firmware: a disabled radio plus a visible note** `Network needs firmware 1.11.0 or newer` (a
    segment cannot carry the long text the option did). Cost: one more line.
17. **The checklist shows when the board reports Network** (today's gate), not when the user chose it (board): it
    describes what the board runs. The lines are split at the first `": "` for the board's bold label, words
    unchanged. Cost: a few seconds between choosing Network and seeing the checklist.
18. **The Transfer box is one box with a state title and today's two links** (send, from the Amiga), not one link
    to the Upload page; outside Network mode it appears only when a line exists. Cost: two targets instead of one.
19. **Board settings holds Disk at startup, NFC reader and Delete device.** Rename stays inline (board), DF1 stays on
    the card (board), firmware stays on the card. 19b: **the stuck-start line and the last error stay on the card**
    — alerts are not hidden behind a button. Cost: the modal is short.
20. **Disk at startup saves on `Save to board`**, no longer on change; Save is disabled until the choice changes.
    Cost: one more click; `devices-page:603` changes.
21. **An attention dot on Board settings when the NFC line is not OK** (not on the board), so moving the reader line
    into the modal does not hide a missing reader. Cost: one dot.
22. **No Scan again** (operator); a board whose firmware sends no I2C scan gets a sentence saying so, rather than an
    empty section.
23. **Delete device moves into the Board settings footer** and opens today's confirm (same words and ids). Cost: one
    more click; `device-delete.spec` opens settings first.
24. **Rename is the board's pencil icon**; the button keeps `Name` / `Rename` as its accessible name and as
    `sr-only` text (`device-alias.spec` reads it). Cost: the word is no longer visible on a wide screen.
25. **The display drawer becomes the Board display modal** (board). `display-toggle-<id>` is the `Change display`
    button and `display-drawer-<id>` the popup. Cost: toggle text changes in one spec.
26. **Save keeps the display modal open** (board closes it with a toast) so the status line can show `Waiting for the
    board` and then `Applied on the board`; `display-layout.spec` reads it after Save. Cost: one more click to close.
27. **Reset to default keeps today's immediate server reset** (board: resets the draft). Its title says so. Cost: a
    Reset is not undone by Cancel.
28. **Panel, Preview as and scale become radio groups and Snap a switch** (board); Rotation, status style and title
    lines stay selects. Elements get names and hints (board), ids unchanged. Cost: three `display-layout` sites.
29. **Preview as keeps all eight of today's situations** (board shows five). Cost: a longer chip row.
30. **Offline: the card keeps its controls with an offline strip** that tells the truth ("reach it when it
    reconnects"); the board's "come back when it reconnects" would be false — requests queue today. No board IP or
    "Last disk" line (no data / duplicate of the drive box). Cost: words differ from InfStates.
31. **A shared `Modal` on Base UI Dialog** for the two new modals; the update and delete dialogs keep their own
    markup. Cost: two modal mechanisms coexist until a later area moves the rest.
32. **One pairing state for two buttons** (header and aside) through `PairingProvider`, so two codes can never be
    live from one page. Cost: a small context.
33. **`Write a Next-disk card` stays in the page header** beside Pair (the board's header has Pair only). Cost: one
    button more than drawn.
34. **The page takes `PageHeader size="lg"`** (44 px), as the library did.
35. **Display element rows follow the layout's order** (the board lists a fixed order); the order is data the board
    renders by. Cost: the list order differs from the board.
