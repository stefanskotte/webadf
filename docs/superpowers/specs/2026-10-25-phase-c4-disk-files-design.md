# WebFloppy redesign, Phase C area 4: Disk files — design

Date: 2026-10-25. Roadmap Phase C step 4 (`2026-10-23-webfloppy-redesign-roadmap-design.md`): "Disk files (history &
time machine as on the Disk files board)". Operator ruling 2026-10-22: the disk history and the time machine are the
redesign's existing **Disk files** board, not an inferred one.

A **layout pass**: the behaviour is A5's (`/disks/[id]/files`, shipped f0f4228, HANDOFF "A5 Disk files") on top of
the time machine (HANDOFF 4l) and the drop staging area (HANDOFF 3v) — the same tree, edits, staging review, guards,
routes, request bodies, toasts and Undo. Builds on Phase B (tokens, `.glass-card`, `.wf-modal`, `DiskIcon`), C1
(`titleDiskColor`, the ⋯ title menu and its `STOP_ALL`/`finalFocus` pattern, `menu-item-look.ts`, `StateCard`), C2
(the shared `Modal`, the heading focus target) and C3 (names wrap, focus to a heading with a visible ring, the
loading/empty-state pattern, contrast measured on real elements). Nothing here re-invents them.

Written under the operator's unattended authorization of 2026-10-24. Every design call is mine and is listed under
**Rulings** at the end, with what it costs if wrong.

Target board (session scratchpad `design-approved/`): **`ModernDiskFiles`** is the page to build. `ModernDisk` is the
disk icon (already `DiskIcon`), `ModernDisks` its specimen sheet (HD hole, write-protect tab, DF0 badge, cream =
unidentified), `ModernHeader` the shell (Phase B built it), `InfStates` the states (skeleton, not-found card) and
`InfPhone` the phone frame (it has no disk-files screen; Ruling 9 decides the phone rows).

Measured against `c25c9fb` (branch `feat/phase-c4-disk-files`).

## 0. Invariants

- Every `data-testid` in §10.1 keeps its name and its meaning. Ids that move onto a different element keep their names;
  the e2e sites that change because of a move are listed in §10.4.
- No schema change, no migration, no new route, no new package. The page keeps `export const dynamic =
  'force-dynamic'` and `maxDuration = 60`, its `?version=` gate (digits only, unknown → `notFound()`), its entitlement
  join, the HFE redirect, and every request the page's controls send:
  `POST /api/disks/:id/files` (multipart `parentBlock`, `name`, `file?`), `PATCH /api/disks/:id/files/:block`
  (`{name}` / `{toParent}` / `{protection}`), `DELETE /api/disks/:id/files/:block`, `POST /api/disks/:id/files/batch`
  (multipart `manifest` + files), `POST /api/disks/:id/files/bulk` (`{op:'move'|'delete', blocks, toParent?}`),
  `GET /api/disks/:id/files/zip?blocks=`, `GET /api/disks/:id/files/:block`, `POST /api/disks/:id/restore`
  (`{seq}`; Undo `{seq: seq-1, ifHead: seq}`), `GET /api/disks/:id/adf`, the mount/eject routes `MountAction` calls,
  and the send route `useSendAction` calls.
- **The write guard is not weakened.** `EditDisabled` (historical > mounted > no-filesystem > bitmap-untrusted) still
  comes from the page, still disables every edit control in one place (`FileEditProvider`), and the server still
  refuses (`findHolder`, D-W-4) whatever the page shows. A disk a board holds or desires cannot be edited or restored
  from this page; the reason is shown in words. Download and Send stay withdrawn while an older version is on screen.
- Self-host parity: no external URL, no font, no our-deployment-only path.
- Firmware, `wifi-floppy/`, the board and the Amiga are untouched.
- "Show both values of a state": every state renders a word in each of its values; an absent element never stands for
  one value. No `sr-only` element carries a width or layout utility.
- In-app dialogs only; never `window.confirm`.

## 1. Page (`src/app/(app)/disks/[id]/files/page.tsx`; board: `main`)

Inside the page gutter (`px-4 sm:px-7`, `pt-6 pb-10`), a column, gap 20 px:

1. **Breadcrumb** — `Breadcrumb` (`breadcrumb`) with today's crumbs (`libraryTrail(...)`, the title, `Disk N`), no
   `PageHeader` (Ruling 3). The h1 moves into the Disk card.
2. **Disk card** (§2).
3. **Version banner** (§3), only while `?version=` is on screen.
4. **Body grid**: `grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start` (Ruling 8): left column (flex
   column, gap 16) = the Files card (§4) then the drop bar (§6); right column = the History aside (§7). Below `xl`
   the History stacks under the drop bar.

Unchanged branches, re-placed: `volume === null` → the Files card's place holds `blob-unavailable` (same words, now a
`StateCard`-like surface card, §8.3); `historyUnavailable` → the History aside's place holds `history-unavailable`
(same words, under the `History` heading). The `FileEditProvider` and `NativeDropProvider` wrap the Files card and the
drop bar, as today.

The page query adds `disks.writeProtected` and `games.authored`; one more org-scoped query reads the title's kind the
way `getGameDetail` does (`kindFromSetName` per disk, `pickKind`), for the disk colour (Ruling 4). No other data.

## 2. Disk card (`src/components/disks/disk-card.tsx`, new; board: `section[aria-label="Disk"]`)

`section` `aria-label="Disk"` `data-testid="disk-card"`: `rounded-[20px] px-6 py-5` (`p-4` below `sm`),
`var(--surface)`, `box-shadow: 0 0 0 1px var(--line)`. From `lg`: one row, gap 24, `items-center`: disk | title block
(flex-1, `min-w-0`) | space (300 px) | 1 px `var(--line)` divider | drive cluster. Below `lg`: disk + title block on
one row, then space full width, then the drive cluster (wraps); no divider.

- **Disk**: `DiskIcon size={76}` (`56` below `sm`), `color = titleDiskColor({ id: disk.id, hasHd, kind, formats:
  [imageFormat], authored })` — the title page's disk-row colour for this disk (Ruling 4); `hd` from the volume
  geometry (root block 1760) else `isHdAdf(disk)`; `wp={writeProtected}`; `mounted` + `drive` by the disk row's rule
  (`driveBadge(choices)`, §5); `set` = the filesystem line (`HD · FFS`, `DD · OFS`, `No filesystem`); `title` = the
  h1 text. Decorative (its root is `aria-hidden`).
- **Title block** `volume-header` (only when the volume reads; moved: Ruling 5), column, gap 6:
  - row (flex, gap 12, `items-baseline`, `flex-wrap`): `h1` (`tabIndex={-1}`, Bricolage 34/700, `leading-[1.05]`,
    `-0.02em`, ink, `overflow-wrap:anywhere`; 26 px below `sm`; `focus:outline-2 focus:outline-offset-2
    focus:outline-(--ring)`) = the volume name, else the filename (today's `title`); then the filename, mono 13
    `var(--muted)`, `overflow-wrap:anywhere` — shown only when it differs from the h1.
  - facts row (flex, gap 8, `flex-wrap`, 13 px `var(--muted)`): pills (`rounded-full px-[9px] py-0.5`, 500,
    `var(--track)` / `var(--muted)`): the filesystem (`FFS` / `OFS`, plus `INTL` / `DIRC` pills when set), the
    density (`HD · 1.76 MB` / `DD · 880 KB`); then `1 file · 24 folders` (`plural`; whole tree, A5's count; word
    `folders`), then `Modified YYYY-MM-DD` when the volume has a date. `listing-truncated` and
    `volume-warnings` (same words, 12 px `var(--amber-text)`) under the facts.
  - No filesystem (`!volume.ok`): no `volume-header` id; the h1 is the filename; the facts row is one pill `No
    filesystem` plus the size pill. The explanation `no-filesystem` sits in the Files card (§4.6).
- **Space** (`w-full lg:w-[300px]`, column, gap 8), `volume-usage` when `usage` is known:
  - `volume-usage-text` (flex, `justify-between`, gap 12, 13 px): left `` `${used} KB used of ${total} KB` `` (600
    ink), `<span className="sr-only"> · </span>`, right `` `${free} KB free` `` (`var(--muted-2)`). The text content
    stays A5's sentence (Ruling 5).
  - `volume-usage-meter`: `role="meter"`, `aria-label="Disk space used"`, `aria-valuemin=0`, `aria-valuemax=total
    KB`, `aria-valuenow=used KB`, `aria-valuetext` = the left words; 8 px `var(--track)` rounded bar, inner ink at
    `percentUsed %` (`var(--accent-amber)` from 90 %, as today).
  - Unknown bitmap: `volume-usage-unknown` `unknown — this disk's allocation bitmap is not usable` (13 px
    `var(--muted-2)`), no meter.
- **Drive cluster** `disk-mount-bar` (moved; flex, gap 10, `items-center`, `flex-wrap`):
  - `drive-light` (`data-state` `in` / `moving` / `stale` / `none`): an 8 px dot (`aria-hidden`; `--online-dot`,
    `--fetch-dot`, `--fetch-dot`, `--dash`) then `holder-<id>` with today's words (`holderText`: `In <board>`,
    `Mounting to <board>…`, `Requested on <board> — not confirmed`, …, else `Not in a drive`), 13 px,
    `var(--amber-text)` when stale else `var(--muted)`. The words carry the state; the dot repeats it.
  - `SendBoardPicker` (two or more boards; unchanged).
  - `MountAction` (unchanged component and ids: `mount-<id>`, `eject-<id>`, `mount-<id>-menu`, `mount-<id>-none`,
    …; Ruling 6).
  - **Download** `download-<id>` (Ruling 6): an `<a href="/api/disks/<id>/adf">` 38 × 38, `rounded-[10px]`,
    `var(--surface)`, `1px solid var(--line)`, ink download glyph (`aria-hidden`), `aria-label={`Download
    ${filename}`}`, `title` the same. Always the CURRENT bytes (the route serves the head), also while an old
    version is on screen — the banner says which is shown, as Mount already does.

## 3. Version banner (`version-banner`, `data-version`; board: the amber `role=status` strip)

Only while `?version=` is on screen. `div role="status"`, flex, gap 12, `items-center`, `flex-wrap`, `px-4 py-3`,
`rounded-[12px]`, `var(--warning-bg)`, `1px solid var(--fw-line)`, 14 px `var(--warning-fg)`:

- a 16 px history glyph (`aria-hidden`);
- text (flex-1, `min-w-[200px]`): `` You’re browsing <b>version {n}</b> ({time}). It’s read-only — restore it to make
  it current. `` — `time` = `fmtTimeUtc` of that version's `createdAt` from the loaded history; `({time})` is left
  out when the history could not be loaded (Ruling 7);
- **Restore this version** `version-banner-restore`: 32 px, `rounded-[8px] px-3`, ink fill, `var(--surface)` 13/600.
  Opens the same confirm as the History's Restore… (§7.4). Disabled with the mounted reason in `title` and
  `aria-describedby="history-mounted-reason"` while a board holds the disk (the same rule as Restore…).
- **Back to current** `version-banner-back`: a `Link` to `/disks/<id>/files` + `fromQuery(from, view)`, 32 px,
  `rounded-[8px] px-3`, transparent, `1px solid var(--warning-line)`, 13/500 `var(--warning-fg)`.

After a successful restore while an old version is on screen, the page goes to the current version
(`router.replace` to the plain URL) and focus moves to the h1 (Ruling 7).

## 4. Files card (`file-tree.tsx`; board: `section[aria-label="Files"]`)

`section` `aria-labelledby="files-heading"` `data-testid="files-card"`: `rounded-[20px]`, `var(--surface)`,
`box-shadow: 0 0 0 1px var(--line)`, `overflow-hidden`, column. When the volume is not readable as a filesystem the
card still renders (header + `no-filesystem` body, §4.6), so the toolbar keeps stating why nothing can be added.

### 4.1 Header (flex, gap 10, `items-center`, `flex-wrap`, `px-4 py-3.5`, `border-b 1px var(--line)`)

- `h2#files-heading` `Files` 15/600 ink, `tabIndex={-1}`, `rounded-[6px]`, `focus:outline-2 focus:outline-offset-2
  focus:outline-(--ring)` — the focus target after a removal (§9). Board: the folder crumbs (Ruling 2).
- **Filter** `fs-filter` (`flex-1 sm:flex-none sm:w-[220px]`): a 36 px field (`rounded-[9px] px-2.5`,
  `var(--surface-2)`, `1px solid var(--line)`, flex, gap 8) holding a 14 px search glyph (`aria-hidden`,
  `var(--muted-2)`) and the `input type="search"` (transparent, borderless, 13 px ink, `placeholder="Filter by name"`
  in `var(--muted-2)`, `aria-label="Filter files by name"`, Escape clears). `data-testid` stays on the input. Same
  logic (Ruling 17).
- **Hide .info files** `fs-hide-info` (Ruling 16): `button role="switch" aria-checked={hideInfo}`, 36 px, flex, gap 8,
  13/500 `var(--muted)`: a 28 × 16 track (`rounded-full p-0.5`; on: ink; off: `var(--line-strong)` with `1px solid
  var(--muted-2)`) holding a 12 px `var(--surface)` knob at the end for its value, then the label `Hide .info files`.
  Same remembered preference and saver.
- **Sort** `browse-sort` (`SortSelect`, unchanged logic), `toolbar` look.
- **Actions** `file-toolbar` (moved; flex, gap 8, `flex-wrap`): `new-folder-trigger` **New folder** (36 px
  `rounded-[9px] px-3`, `var(--surface)`, `1px solid var(--line)`, 13/500 ink, folder-plus glyph) and
  `upload-trigger` **Add file** (36 px, ink fill, 13/600 `var(--surface)`, upload glyph; Ruling 18). Their inline
  forms (`new-folder-name/-submit/-cancel`, `upload-input` (`sr-only`), `upload-name/-submit/-cancel`) replace the
  trigger in place, as today, with the same look as the triggers; `Uploading…` / `Creating…` while busy.
- Under the header row, when editing is disabled: `file-edit-disabled` (full row, `px-4 pb-3 -mt-1`, 13/600
  `var(--amber-text)`) — the `EditDisabled` message, unchanged words.

### 4.2 Selection bar (`selection-bar.tsx`; board: the ink `role=toolbar` strip)

`fs-selection-bar` (`role="region" aria-label="Selected files"` kept; Ruling 21), flex, gap 8, `items-center`,
`flex-wrap`, `px-4 py-2`, ink fill, 13 px `var(--surface)`:
- `fs-selection-count` (flex-1, 600) `N item(s) selected` (A5's words); `fs-selection-hidden` `(N not shown)` after it
  (12/600 `var(--fetch-dot)`, 7.41:1 on ink; A5's `--amber-text` would be 2.84:1 on the ink bar).
- idle: `fs-bulk-download` **Download .zip** (a link; the disabled span while historical), `fs-bulk-move` **Move to…**,
  `fs-bulk-delete` **Delete** — 30 px `rounded-[7px] px-2.5`; Download and Move `var(--on-ink-fill)` / surface text;
  Delete `var(--danger-fg)` fill, white 600. `fs-selection-clear`: 30 × 30 `×` glyph, `aria-label="Clear selection"`.
- move mode: `fs-bulk-move-target` (native select, 30 px, `var(--surface)` fill, ink text), `fs-bulk-move-submit`
  **Move** (surface fill, ink 600), **Cancel** (`var(--on-ink-fill)`).
- delete mode: `fs-bulk-delete-summary` `Delete 3 files and 1 folder?` (surface text), `fs-bulk-delete-confirm`
  **Delete** (danger fill, white), **Cancel**.

### 4.3 Column heads (`fs-columns`, from `md` only, `aria-hidden`)

The row grid (§5.2) at 36 px, `px-4`, `var(--modal-foot)`, `border-b 1px var(--line)`, 12/500 `var(--muted-2)`:
`· · Name · Size (right) · Protection · Modified · ·`.

### 4.4 The list

`div role="list"` `data-testid="file-tree"` (kept: the root drop target and its `data-drop-target`), `md:max-h-[700px]
md:overflow-y-auto` (board). Rows per §5. A folder's `fs-drop-<block>` wrapper is the `role="listitem"`; a file's
`fs-entry` is. `fs-filter-empty` (words unchanged) and the root-empty state (§8.2) sit inside it.

### 4.5 Footer (`fs-footer`)

`px-4 py-3`, `border-t 1px var(--line)`, `var(--modal-foot)`, 12 px `var(--muted-2)`:
`1 folder · 12 files shown` (`plural`) over the rows on screen (open folders included), then, while Hide .info is
on and the disk has any, ` · 3 .info files hidden` (Ruling 22).

### 4.6 No filesystem

`!volume.ok`: the header renders (the toolbar disabled with `file-edit-disabled` `This disk has no filesystem, so
there is nothing to add files to.`), then `no-filesystem` (moved from the volume card; same words, 13 px
`var(--muted)`, `px-4 py-6`). No list, no `file-tree`, no footer.

## 5. Rows (`file-tree.tsx` `FileRow`; look rules in `src/lib/disk-files-look.ts`, new)

### 5.1 Parts, in DOM order

| Part | Id | Look |
|---|---|---|
| select | `fs-select-<block>` | native checkbox 16 px, `accent-color: var(--ink)`, `aria-label="Select <name>"`; absent while historical (A5) |
| grip | `fs-drag-<block>` | 28 × 32 (`h-11` below `md`) button, `GripVertical` 14 px `var(--muted-2)`, `aria-label="Move <name>"`, `touch-action:none`, the only drag activator (Ruling 10) |
| name | `fs-toggle-<block>` (folder) | folder: the toggle `button` (`aria-expanded`), file: a `span`; flex, gap 8, `min-w-0`, `padding-left: depth × 18 px`: a ▸ chevron (folders; rotates 90° when open; files get its 12 px space), the glyph `fs-glyph-<block>` (22 × 22 `rounded-[6px]`, mono 9/700, `entryGlyph(entry)` bg/fg, `aria-hidden`), the name (14 px ink; 600 for a folder; `overflow-wrap:anywhere`, no ellipsis: Ruling 23), `fs-info-<block>` `.info` (mono 10/600, `var(--track)` / `var(--muted-2)`, `rounded-[5px] px-1.5`) when Hide .info is on and `<name>.info` exists beside it (Ruling 15), `fs-new-<block>` `new in vN` (11/600, `var(--success-bg)` / `var(--success-fg)`, `title` kept) |
| size | — | mono 12, right-aligned: files `sizeBytes.toLocaleString() B` in `var(--muted)` (A5's figure), folders `—` in `var(--muted-2)` |
| protection | `fs-protect-<block>` | eight chips (Ruling 13), flex gap 2, mono 11/600: per `PROTECTION_FLAGS` letter, 14 × 18 `rounded-[4px]`; set = the letter, ink on `var(--track)`; clear = `-`, `var(--muted-2)` on transparent. The element's text content is the protection string (`----rwed`). Editable: a `button` (`aria-label` and `title` as today) that opens the editor; not editable: a `span` |
| modified | — | mono 12 `var(--muted)`, `YYYY-MM-DD` or `—` |
| more | `fs-more-<block>` | the ⋯ menu trigger (§5.3) |
| inline form | — | a full-width line under the row when open (§5.4) |

`fs-entry` (`data-name`) stays on the row element and carries `opacity: 0.5` while dragged and the dnd-kit transform,
as today. A folder row keeps its `fs-drop-<block>` wrapper (`data-drop-target`, native-drop handlers, the inset
`var(--accent-amber)` ring while a drop is over it).

### 5.2 Layout (Ruling 9)

- **From `md`**: one line, the board's grid — `md:grid-cols-[28px_28px_minmax(0,1fr)_96px_132px_104px_36px]`,
  gap 12, `items-center`, `min-h-[40px]`, `px-4`, `border-b 1px var(--hairline)`, 13 px. Hover `var(--surface-2)`;
  a selected row `var(--surface-2)`.
- **Below `md`**: a two-line card in the same element — `grid-cols-[28px_32px_minmax(0,1fr)_44px]`, gap 4 8,
  `py-2`: select, grip and ⋯ span both lines (`row-span-2 self-center`); the name on line 1; line 2 (`col-start-3`)
  holds size · protection · modified (flex, gap 10, `flex-wrap`). Every placement class is reset at `md`.
- The inline form line is `col-span-full`. Nothing scrolls sideways at any width.

### 5.3 The row menu (`src/components/disks/file-row-menu.tsx`, new; board: `role=menu`)

Base UI `DropdownMenu` (C1's title menu pattern: `STOP_ALL` on the wrapper, trigger `onPointerDown/onMouseDown/
onTouchStart` stopped so dnd-kit never starts a drag from it; `finalFocus` back to the trigger unless an item opened
an inline form). Trigger `fs-more-<block>`: 32 × 32 (`h-11 w-11` below `sm`), `rounded-[8px]`, ⋯ glyph
`var(--muted)`, `aria-label="Actions for <name>"`, always visible (Ruling 11). Panel `fs-row-menu`, `w-[200px]`,
`p-1.5`, `rounded-xl`, `var(--surface)`, `1px solid var(--line)`, the title menu's shadow; items `MENU_ITEM` look
(moved from `title-menu.tsx` into `menu-item-look.ts`), in this order:

| Item | Id | Shown | Disabled when | Does |
|---|---|---|---|---|
| Download | `fs-download-<block>` | files | historical (title = the message) | a link item (`render={<a href="/api/disks/<id>/files/<block>">}`) |
| Send to Amiga | `fs-send-<block>` | a board can take files | send busy, or historical | `sender.send({diskId, blocks:[block]}, label)` (unchanged) |
| Rename | `fs-rename-<block>` | always | `!!editDisabled` | opens the rename form |
| Move to… | `fs-move-<block>` | always | `!!editDisabled` | opens the move form |
| Protection bits… | `fs-protect-item-<block>` | always | `!!editDisabled` | opens the protection editor |
| — separator — | | | | |
| Delete | `fs-delete-<block>` | always | `!!editDisabled` | opens the delete confirm (`variant="destructive"`, `var(--danger-fg)` text) |

A disabled item stays in the menu with the `EditDisabled` message as its `title` — the reason is also in words under
the Files header (`file-edit-disabled`).

### 5.4 Inline forms (A5's, opened from the menu; Ruling 12)

Same state machine (one row at a time; rename / delete / move / protection mutually exclusive), same ids, words,
requests and toasts. Look: a line under the row, `pl` aligned with the name, flex, gap 8, `flex-wrap`, `py-2`:
fields 30 px `rounded-[8px]`, `var(--surface)`, `1px solid var(--line)`, 13 px ink; the primary button 30 px ink fill
(`Save` / `Move` / protection `Save`), the delete confirm `var(--danger-fg)` fill white (`Delete`), Cancel outline.
The protection editor's eight toggles (`fs-protect-bit-<letter>`, `aria-pressed`) are 30 × 30: set ink fill surface
letter, clear `var(--track)` with `var(--muted-2)` letter.

Focus: opening a form focuses its first control (the name field, the move select, the first protection toggle, the
delete confirm's Cancel); Cancel and Escape return focus to the row's `fs-more-<block>`.

### 5.5 Look rules (`src/lib/disk-files-look.ts`, pure, client-safe, unit-tested)

- `entryGlyph(entry): { label; bg; fg }` (Ruling 14): folder `DIR` `var(--dir-bg)` / `var(--accent-blue)`; `*.info`
  `ICN` `var(--track)` / `var(--muted-2)`; text names (`.txt .doc .guide .readme .prefs .asc .me`, or a name starting
  `ReadMe` / `Read_Me`, case-insensitive) `TXT` `var(--track)` / `var(--muted)`; no extension `EXE` `var(--exe-bg)` /
  `var(--exe-fg)`; else the extension's first three letters upper-cased on `var(--track)` / `var(--muted)`.
- `protectionChips(p: string): { letter: string; on: boolean; label: string }[]` — eight, from `PROTECTION_FLAGS`.
- `infoCompanions(entries: AdfEntry[]): Set<number>` — blocks of entries whose `<name>.info` sibling exists
  (case-insensitive), per directory level.
- `changeCounts(changes: TreeChange[]): { added; changed; removed }`.
- `driveLight(choices: MountChoice[]): 'in' | 'moving' | 'stale' | 'none'` — the `holderText` ranking: converged or
  DF1-held → `in`; pending or DF1 loading → `moving`; any other request → `stale`; else `none`.
- `driveBadge(choices): 'DF0' | 'DF1' | null` — the disk row's rule (DF0 converged on this disk, else DF1 holding it).
- `densityPill(rootBlock: number, sizeBytes: number): string` — `HD · 1.76 MB` / `DD · 880 KB`.
- `openByDefault(versions: HistoryVersion[], viewingSeq: number | null): Set<number>` — the head, plus the version
  on screen.
- `formatKb(bytes)` (moved from `volume-header.tsx`, unchanged); `plural(n, one)`; `countInfo(entries)` (every
  `*.info` in the tree, for the footer).

## 6. Drop bar (`drop-staging.tsx`; board: the floating `region "Add files to this disk"`)

`drop-staging` (`section aria-label="Add files to this disk"`): `rounded-[16px]`, `var(--surface)`, `1.5px dashed
var(--dash)` (solid `var(--line)` once rows are staged), column, gap 12, `p-3 pl-4`. In flow under the Files card, not
floating (Ruling 19).

- **The bar** `drop-strip` (the drop target, `aria-disabled`, handlers unchanged): flex, gap 14, `items-center`,
  `min-h-[44px]`. A 40 px `var(--track)` `rounded-[12px]` tile with the upload glyph (`aria-hidden`); a column
  (flex-1, `min-w-0`, gap 2):
  - nothing staged: 14/600 ink `Drop files, folders or an .lha / .lzh / .zip here or on a folder to add them to`
    + the volume name in mono; 12 px `var(--muted-2)`: `` `${free} KB free on this disk · every change is saved as
    a new version` `` (`Free space unknown · every change is saved as a new version` when the bitmap is not usable).
  - rows staged: 14/600 ink `` `${n} item(s) staged below — drop more to add to the same batch.` `` (A5's words).
  - editing disabled: `drop-disabled` (moved inside the bar) 13/600 `var(--amber-text)` with the `EditDisabled`
    message; the bar is `opacity` 0.6 and not a target (A5: `pointer-events: none`).
  - While a file drag is over it: border ink, fill `var(--surface-2)` (pointer feedback).
- **The staging list** `drop-staging-list` under the bar (A5's content, ids and words unchanged): the destination
  select and the block line (12 px `var(--muted-2)`), `drop-summary` (13 px ink), the warnings (`drop-destination-
  refused`, `drop-archive-skipped`, `drop-depth-warning`, `drop-capacity-warning`; danger/amber text as today), the
  `stage-row-<i>` rows (13 px, `border-t 1px var(--hairline)`, `py-2`; name fields 30 px like §5.4; Skip / Replace /
  Undo / include toggle 28 px outline buttons), then `drop-commit` **Add N items** (36 px ink fill) and `drop-clear`
  **Clear** (36 px outline).
- Done and Undo stay in the toast (A5); the board's "added · saved as version 8 · Undo / Add more…" bar state is the
  toast's job (Ruling 20).

## 7. History aside (`history-panel.tsx` + `restore-dialog.tsx`, new; board: `aside[aria-label="History"]`)

`aside` `id="disk-history"` `aria-labelledby="history-heading"` `data-testid="history-panel"` `scroll-mt-20`:
`rounded-[20px]`, `var(--surface)`, `box-shadow: 0 0 0 1px var(--line)`, `overflow-hidden`, column.

### 7.1 Head (`px-[18px] pt-4 pb-3`, `border-b 1px var(--line)`, column, gap 4)

`h2#history-heading` `History` 15/600 ink + the `write-back` help tip beside it; then 12 px `var(--muted-2)`,
`leading-[1.5]`: `Every write from the drive or this page saves a version. Restoring adds a new version — nothing is
lost.` Then `history-mounted-notice` (`id="history-mounted-reason"`, 13/600 `var(--amber-text)`, words and the
`Eject` link unchanged) when a board holds the disk.

### 7.2 Versions (`ol`, `p-2`, `md:max-h-[840px] md:overflow-y-auto`)

Each version `li` `version-<seq>` (`data-head` kept), `relative pl-[22px]`:
- the timeline (`aria-hidden`): a 2 px `var(--line)` line at `left 13` (none after the oldest shown); a 12 px dot at
  `left 8, top 16`: the head ink fill + ink edge; the version on screen `var(--fetch-dot)` fill + edge; others
  `var(--surface)` fill + `2px var(--dash)` edge (Ruling 29).
- the card (`ml-1.5 rounded-[12px] p-2.5`, column, gap 6; `var(--viewing-bg)` for the version on screen; hover
  `var(--surface-2)`):
  - `version-toggle-<seq>`: a `button` (`aria-expanded`, `aria-controls="version-body-<seq>"`), flex, gap 8,
    `items-start`, text-left, ink: a column (flex-1, gap 2) of the title `` `Version ${seq} · ${label}` `` (13/600;
    Ruling 25) and the time `fmtTimeUtc(createdAt)` (mono 11 `var(--muted-2)`); then the chips (`version-counts-<seq>`,
    flex, gap 4, `shrink-0`, mono 11/600 `rounded-[5px] px-1.5`): `+N` success-bg/fg, `~N` warning-bg/fg, `−N`
    danger-bg/fg, each with `<span className="sr-only"> added|changed|removed</span>` (Ruling 26); then
    `current-<seq>` **Current** (11/600, ink fill, `var(--surface)` text, `rounded-[5px] px-[7px]`) on the head —
    always visible, open or closed.
  - when open, `version-body-<seq>` (column, gap 6):
    - `changes-<seq>` (A5's `ChangeRow`s: a 16 px mark chip + the path, mono 12 `var(--muted)`, wraps), or the
      sector note / `No earlier version to compare.` / `No file changes.` (A5's words, 12 px italic `var(--muted-2)`).
    - actions (flex, gap 6, `pt-0.5`): `browse-<seq>` **Browse** (a `Link`, 30 px `rounded-[8px] px-2.5`,
      `var(--surface)`, `1px solid var(--line)`, 12/500 ink; the head's goes to the plain URL, as today) or
      `viewing-<seq>` **Viewing** (12/600 `var(--muted)`, no box) for the version on screen; on every version but
      the head, `restore-<seq>` **Restore…** (30 px, transparent, 12/600 `var(--amber-text)`, Ruling 27; disabled
      with the mounted reason in `title` + `aria-describedby="history-mounted-reason"`).
- Open by default: `openByDefault(versions, viewingSeq)` (Ruling 24). The toggle is per version, kept in the panel's
  state, not remembered.
- `history-show-all` `Show all N versions` / `Show fewer` (12/600 underline `var(--muted)`, `px-2.5 pb-2`) when there
  are more than 20 — unchanged rule.

### 7.3 Empty / unavailable

- `history-empty`: `As uploaded — nothing has changed this disk yet.` (A5's words), 13 px `var(--muted)`, `px-[18px]
  py-4`.
- `history-unavailable`: the aside head (h2 `History`, no intro) then `This disk's version history could not be
  loaded.` 13/600 `var(--amber-text)`, `px-[18px] py-4`.

### 7.4 The confirm (`restore-dialog.tsx`: `RestoreProvider` + `useRestore()`; Ruling 27)

One confirm for the History's Restore… and the banner's Restore this version: `RestoreProvider` (client) wraps the
banner and the aside and owns the open version, the request and its outcomes — moved verbatim from
`HistoryPanel.confirmRestore` (same body `{seq}`, the same 409 mounted / 409 changed / 404 / 503 / other toasts, the
`recorded: false` "Nothing to restore" toast, `router.refresh()`), plus the redirect of §3 when an old version is on
screen. `useRestore()` → `{ ask(version: HistoryVersion): void; busy: boolean; reactiveMounted: string | null }`
(the panel's mid-session 409 state moves here so the banner's button agrees with it).

`restore-dialog` (portalled, `role="dialog" aria-modal="true"`, `aria-labelledby` its h2): scrim `var(--scrim)`,
panel `glass-card wf-modal`, `w-full max-w-[440px]`, `p-6`; `h2` Bricolage 20/700 ink `Restore version N?`; body 13 px
`var(--muted)`: `The disk goes back to how it was on <time>. This is saved as a new version, so nothing after it is
lost.` and `<strong>label</strong>` (ink); footer gap 10 `justify-end`: `restore-cancel` **Cancel** (38 px outline)
and `restore-confirm` **Restore** / `Restoring…` (38 px ink fill, `var(--surface)` 13/600). Focus moves to Cancel on
open; Escape cancels (not while busy); Tab stays inside; on close focus returns to the opener when it still exists,
else to `#history-heading`.

## 8. States

### 8.1 Loading (`src/app/(app)/disks/[id]/files/loading.tsx`, new; Ruling 32)

`data-testid="disk-files-skeleton"` inside `PageSkeleton`: a 12 px crumb bone; a disk-card bone (`rounded-[20px]`,
surface, line ring, `p-5`: a 76 px square bone, a 34 px heading bone and two line bones, a 300 px meter bone); then
`grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]`: a files bone (36 px header bone, eight `data-skeleton-row` 40 px row
bones) and a history bone (five `data-skeleton-version` 52 px bones). Nested under `(app)/loading.tsx`.

### 8.2 Empty disk

The root holds nothing: inside `file-tree`, `py-10`, centred column, gap 10: `DiskIcon` `cream` 48 px, then 14 px
`var(--muted)` `This disk's root directory is empty.` (A5's words) and 12 px `var(--muted-2)` `Drop files on the bar
below, or press Add file.` (`Editing is off: <reason>` — the `EditDisabled` message — instead while disabled). The
root stays a drop target.

### 8.3 Unreadable / not found / error

- `blob-unavailable`: in the Files card's place, a surface card (`rounded-[20px]`, line ring, `p-5`), 13/600
  `var(--amber-text)`, words unchanged.
- Not found (`notFound()`: unknown disk, another org's, bad `?version=`): A1's `not-found-page` card, HTTP 200 behind
  the streamed loading (A1). Error: A1's `error.tsx`.

## 9. Focus (Ruling 31)

- A single delete (`fs-delete-confirm`), a bulk delete or a bulk move, and a drop commit that leaves the focused
  element gone: focus moves to `#files-heading` (visible ring) once the refreshed tree no longer holds the focused
  element. Same mechanism as C3's staging list: remember the focused element before the request; after the refresh,
  if `!document.contains(it)` or `document.activeElement === document.body`, focus the heading.
- A restore that redirects to the current version: focus the h1.
- The restore confirm closing on a vanished opener: `#history-heading`.

## 10. Test ids

### 10.1 Kept (name and meaning)

Page: `breadcrumb`, `holder-<id>`, `disk-mount-bar` (moved: the drive cluster), `mount-<id>*` (MountAction),
`send-board-select`, `version-banner` (+ `data-version`), `blob-unavailable`, `history-unavailable`.
Disk card: `volume-header` (moved: the title block), `volume-usage`, `volume-usage-text` (same text), `volume-usage-
unknown`, `listing-truncated`, `volume-warnings`, `no-filesystem` (moved: the Files card body).
Files card: `file-toolbar` (moved: header actions), `file-edit-disabled`, `upload-trigger`, `upload-input`,
`upload-name`, `upload-submit`, `upload-cancel`, `new-folder-trigger`, `new-folder-name`, `new-folder-submit`,
`new-folder-cancel`, `identity-confirm-dialog`, `identity-confirm-cancel`, `identity-confirm-proceed`, `fs-filter`,
`fs-hide-info` (now `role="switch"`; `.check()`/`toBeChecked()` still apply), `browse-sort`, `fs-filter-empty`,
`file-tree` (+ `data-drop-target`), `fs-entry` (+ `data-name`), `fs-drop-<block>` (+ `data-drop-target`),
`fs-toggle-<block>`, `fs-drag-<block>`, `fs-select-<block>`, `fs-new-<block>`, `fs-protect-<block>` (text = the
protection string), `fs-protect-editor-<block>`, `fs-protect-bit-<letter>`, `fs-protect-save-<block>`,
`fs-rename-name/-submit/-cancel-<block>`, `fs-delete-confirm/-cancel-<block>`, `fs-move-target/-submit/-cancel-
<block>`, `fs-download-<block>`, `fs-send-<block>`, `fs-rename-<block>`, `fs-move-<block>`, `fs-delete-<block>`
(these five moved into the ⋯ menu), the selection bar's `fs-selection-bar`, `-count`, `-hidden`, `-clear`,
`fs-bulk-download`, `fs-bulk-move`, `-move-target`, `-move-submit`, `fs-bulk-delete`, `-delete-summary`,
`-delete-confirm`.
Drop: `drop-staging`, `drop-strip`, `drop-disabled` (moved inside the bar), `drop-staging-list`,
`drop-destination-select`, `drop-total-blocks`, `drop-free-blocks`, `drop-summary`, `drop-destination-refused`,
`drop-archive-skipped`, `drop-depth-warning`, `drop-capacity-warning`, `stage-row-<i>` (+ `data-excluded`),
`stage-include/-name/-name-error/-conflict/-skip/-replace/-resolution/-undo-<i>`, `drop-commit`, `drop-clear`.
History: `history-panel` (the aside, `#disk-history`), `history-mounted-notice`, `history-empty`, `history-show-all`,
`version-<seq>` (+ `data-head`), `changes-<seq>`, `browse-<seq>`, `viewing-<seq>`, `current-<seq>`,
`restore-<seq>`, `restore-dialog`, `restore-confirm`, `restore-cancel`, `help-tip-write-back`.

### 10.2 New

`disk-card`, `download-<id>`, `volume-usage-meter`, `drive-light` (+ `data-state`), `version-banner-restore`,
`version-banner-back`, `files-card`, `fs-columns`, `fs-footer`, `fs-glyph-<block>`, `fs-info-<block>`,
`fs-more-<block>`, `fs-row-menu`, `fs-protect-item-<block>`, `version-toggle-<seq>`, `version-body-<seq>`,
`version-counts-<seq>`, `disk-files-skeleton`. Element ids: `files-heading`, `history-heading`.

### 10.3 Removed

None.

### 10.4 Specs that change, and why

| Spec | Change |
|---|---|
| `adf-browser.spec.ts:208`, `:246` | `[fs-entry DATA.BIN] a[fs-download-]` → open the row's ⋯ (`openRowMenu`) then `page.locator('a[data-testid^="fs-download-"]')` (Ruling 11) |
| `disk-files-edit.spec.ts:142`, `:179`; `hd-disks.spec.ts:318`; `disk-drag-drop.spec.ts:415`, `:473`; `send-to-amiga.spec.ts:145` | `openRowMenu(page, block)` before clicking `fs-delete-` / `fs-rename-` / `fs-move-` / `fs-send-` (Ruling 11) |
| `mobile.spec.ts:221` | "its name AND its download control" → its name AND its ⋯; the menu's Download is within 390 px after a tap (Ruling 11) |
| `mobile.spec.ts:367` | tap `fs-more-<block>` before `fs-rename-` and before `fs-delete-` |
| `mobile.spec.ts:455` | root cause found and fixed (plan Task 6); the test keeps its intent |
| `time-machine.spec.ts:167`, `hd-disks.spec.ts:328-331` | `openVersion(page, 1)` before `changes-1` / `restore-1` (Ruling 24) |
| `time-machine.spec.ts:246` | `openVersion(page, 0)` before `restore-0` toBeDisabled |
| `time-machine.spec.ts:293-294` (test at 268) | `pb.goto(...?version=0)` asserts the `not-found-page` card and no `file-tree`, not a 404 status (A1: loading.tsx streams 200) |
| `e2e/helpers.ts` | new `openRowMenu(page, blockOrName)`, `openVersion(page, seq)` |
| `e2e/disk-files-layout.spec.ts` (new) | the new tests of plan Tasks 2–6 |
| `contrast.spec.ts` | a new Disk files test (§11) |
| `screenshots.shots.ts` | the existing `disk-files` shot (tall) is regenerated (Ruling 35) |

Regression only (no edit expected): `archive-drop-folder`, `archive-drop`, `disk-files-a5` (its protection test
clicks the cell, which stays the button; `.check()` works on the switch), `breadcrumb` (three/four crumbs; one h1
with the volume name), `game-detail -g "disk page|Disk Page"` (the mount bar on this page), `states`, `hfe-disks -g
"redirect|Browse"`, `disk-sets -g "not-found|not in your library"`, `help`, `shell`, `nfc-fob-button -g history`,
`library-table -g history` (the ⋯ title menu's Version history lands here).

## 11. Contrast pairs (WCAG 2.x; in `design-tokens.test.ts` and measured on the page in `contrast.spec.ts`)

| Pair | Ratio | Where |
|---|---|---|
| `--warning-fg` `#7A4A08` on `--warning-bg` `#FBEBD3` | 6.38 | banner text, Back to current, `~N` chip |
| `--surface` `#FFFDF8` on ink `#24211B` | 15.79 | selection count, Restore this version, Add file, Current, Restore |
| `--surface` on `--on-ink-fill` `#3E3B36` | 10.97 | selection bar Download .zip / Move to… |
| `--fetch-dot` `#E9A23B` on ink | 7.41 | `(N not shown)` on the selection bar |
| white on `--danger-fg` `#B3341F` | 6.13 | bulk Delete, delete confirm |
| `--muted-2` `#6E6657` on `--modal-foot` `#FBF8F1` | 5.35 | column heads, footer |
| `--muted` `#5B5446` on `--surface` / `--surface-2` | 7.37 / 6.71 | size, modified, filename, facts, hovered/selected row |
| `--muted-2` on `--surface` / `--surface-2` | 5.58 / 5.08 | version time, history intro, folder `—`, bar sub line, clear bit `-` |
| ink on `--track` `#EFE9DD` | 13.28 | a set protection bit |
| `--muted` on `--track` | 6.20 | FFS / HD pills, TXT glyph, other-extension glyph |
| `--muted-2` on `--track` | 4.69 | `.info` badge, ICN glyph, clear protection toggle |
| `--accent-blue` `#1D4F86` on `--dir-bg` `#E9EEF4` | 7.16 | DIR glyph |
| `--exe-fg` `#2E5B2A` on `--exe-bg` `#E2F0DF` | 6.71 | EXE glyph |
| `--success-fg` `#1F6A2A` on `--success-bg` `#DDF0DC` | 5.57 | `new in vN`, `+N` |
| `--danger-fg` on `--danger-bg` `#F8E1DB` | 4.90 | `−N` |
| `--amber-text` `#A84C16` on `--surface` / `--surface-2` / `--viewing-bg` `#FBF3E3` | 5.57 / 5.07 / 5.13 | Restore…, stale holder, disabled reasons |
| ink / `--muted-2` on `--viewing-bg` | 14.55 / 5.14 | the version on screen: title / time |
| `--danger-fg` on `--surface` | 6.03 | menu Delete, capacity warning |

The page measurement covers, on real elements: the banner text, a hovered row's size, a selected row's modified date,
a column head, the footer, a `.info` badge, a DIR and an EXE glyph, a set protection bit, `new in v1`, `Current`, a
version's time, a `+N` chip, Restore… on a hovered version and on the version on screen, a selection-bar button, the
menu's Delete, the drop bar's sub line, the holder words. The timeline, dots, meter fill, switch track and drop
border are non-text decoration beside words that carry the state (the switch's knob/track pair is a UI component:
its off track carries a `--muted-2` 1 px border, 5.58 on the surface).

## 12. Phone (390 px) — only what the boards and today's specs pin

Area 7 owns the phone pass. Here: the breadcrumb wraps; the Disk card stacks (56 px disk + h1 26 px, space full width,
drive cluster wrapping); the Files header wraps (filter full width, then the switch, sort and actions); rows are the
two-line card (§5.2) with a 44 px ⋯ and a 44 px-tall grip; the row menu fits (`max-w-[calc(100vw-2rem)]`); inline
forms wrap; the drop bar and its staging list stack; History sits under the bar; the restore confirm fits (`w-full
max-w-[440px]` in a `p-4` scrim). `mobile.spec.ts:367` and `:455` hold the toolbar, the forms, the strip and the touch
drag inside 390; nothing scrolls the page sideways.

## 13. Help (`src/lib/help/topics.tsx`; the text changes with what it describes)

- `send`, "Three ways to send": `On a disk's page, open the ⋯ menu of a file or a folder and choose <em>Send to
  Amiga</em>.` replaces `On a disk's Browse page, press <em>Send</em> on a file or a folder.` (rest unchanged).
- `write-back`, after the paragraph on where a version came from: `Open a version in the History to see what changed.
  <em>Browse</em> shows that version's files, read-only; above them, <em>Restore this version</em> makes it current
  again and <em>Back to current</em> returns. <em>Restore…</em> in the History does the same and asks first.`
  The source comment adds `restore-dialog.tsx`, `disk-files-look.ts` (`openByDefault`) and this spec.
- `preferences` ("the one above a disk's file list") stays true: the sort sits in the Files header.
- No topic describes the row actions' places otherwise; the `library` topic's "version history" item still lands on
  `#disk-history`.

## 14. Out of scope

- The board's folder-at-a-time navigation and folder crumbs (Ruling 2), its whole-page drag overlay and floating bar
  (Ruling 19), a multi-file picker into the staging list (Ruling 18).
- The header, nav, bottom bar (Phase B; area 7). Toasts restyled (shell-wide, later).
- `MountAction`'s and `SendBoardPicker`'s own look (shared with the title page; C1 styled them).
- The identity-confirm dialog's mechanism (restyle only: tokens, 440 px, Bricolage h2).
- Moving `restore-dialog` onto the shared `Modal` (Ruling 27).

## Rulings (operator to review)

1. **A layout pass on A5 and the time machine, nothing more.** Tree, staging review, inline forms, toasts, Undo,
   guards, routes and bodies stay; where the board and today disagree on behaviour, today wins and a ruling says
   so. Cost: the page differs from the board in places listed below.
2. **The expandable tree stays; the board's folder-at-a-time view with folder crumbs is not built.** A5's filter opens
   the folders holding matches, drops land on folder rows, Move to… lists full paths, and eight e2e files expand
   folders in place (`fs-toggle-`). The Files card's header starts with an `h2 Files` where the board has the crumbs.
   Cost: a deep tree grows long instead of paging by folder; no folder crumbs.
3. **No `PageHeader` on this page: the breadcrumb, then the board's Disk card holding the one h1** (the volume name,
   `tabIndex={-1}` like PageHeader's). `breadcrumb.spec` reads the crumbs and one h1. Cost: this page's top differs
   from the other redesigned pages (no eyebrow/h1 pair).
4. **The disk is drawn in the title page's disk-row colour** (`titleDiskColor` by disk id, the title's kind and
   authored flag), with the HD hole, the write-protect tab and the drive badge by the disk row's rules, so one disk
   looks the same on both pages. Cost: one more small query (the title's kind); the board's grey is only right for
   an HD disk.
5. **The volume facts move into the Disk card and keep A5's words** — `volume-header` is the title block (h1 + facts);
   the usage keeps `2 KB used of 880 KB` / `878 KB free` (`adf-browser` reads both and their sum), laid out as the
   board's two ends over the meter; contents say `folders` (board) instead of `directories`. Cost: the left figure is
   longer than the board's `1434 KB used`.
6. **The drive cluster keeps `MountAction`, `holderText` and `SendBoardPicker`** (shared with the title page; the
   board's single Mount/Eject toggle cannot express DF1, pending, cancel or several boards), adds the board's drive
   light (words carry it) and the board's **Download** icon to the existing `/api/disks/<id>/adf` route
   (`download-<id>`, as the title page's disk row). Cost: one control more than A5 had here; the cluster is busier
   than drawn with two boards.
7. **The banner takes the board's words and its two buttons**: `Restore this version` (the same confirm) and `Back to
   current` (A5's link, renamed). After a restore while an old version is on screen, the page goes to the current
   version (today it stayed on `?version=`, which then showed a banner for a version that was no longer the newest
   copy of anything you were looking at). Cost: one navigation more than A5.
8. **Two columns from `xl` (1280 px) only**; below it History stacks under the files. At 1024 a 380 px aside leaves
   the file grid about 560 px — too narrow for seven columns. Cost: laptops narrower than 1280 scroll to the History.
9. **The board's row grid from `md` (768 px); below it a two-line card** (name; then size · protection · modified),
   with select, grip and ⋯ spanning both lines. The board has no phone layout for this page. Cost: tablets in
   portrait see the grid with a narrower name column.
10. **The drag grip stays, in its own column, always visible** (the board has none): dragging a row onto a folder is
    A5/3v behaviour and the grip is its only activator, so clicks on the name, the checkbox and ⋯ are never eaten by
    a drag. Cost: one column more than drawn.
11. **Row actions move into the board's ⋯ menu** — Download, Send to Amiga, Rename, Move to…, Protection bits…, Delete
    — and the ⋯ is always visible (the board shows it on hover; a phone has no hover and a keyboard user needs to
    see where focus is). Every item keeps its old button's id. Send to Amiga is added to the board's menu (it is an
    A5 row action). Cost: Download is one click further away; 11 e2e sites in 6 files open the menu first.
12. **Rename, Move to…, Protection bits… and the delete confirm stay A5's inline forms under the row**, opened from the
    menu (the board is silent on what an item does). Inline growth never covers a sibling row, and every form id is
    kept. Cost: a different pattern from the title page, whose menu opens dialogs.
13. **The protection column shows all eight bits** (h s p a r w e d), not the board's four: A5 edits all eight, `s`
    and `p` matter to AmigaDOS scripts and resident commands, and `disk-files-a5` reads the eight-letter string. A
    clear bit is a `-` in `--muted-2` (the board's faint `#C9C0AE` letter is 1.7:1 and reads as an absent value).
    Cost: a 132 px column instead of 120.
14. **The type glyph is chosen by name** (no file bytes are read): `DIR`, `ICN` for `.info`, `TXT` for text names,
    `EXE` for a name with no extension (how Amiga commands are named), else the extension's first three letters.
    The board labels every other file `EXE`, which is wrong for a `.mod` or an `.lha`. ICN uses `--muted-2` on
    `--track` (the board's `#8A8172` is 3.26:1). Cost: a data file with no extension reads `EXE`.
15. **The board's `.info` badge is shown** beside an entry whose `.info` companion is hidden by Hide .info, so hiding
    the icons does not hide that they exist. Cost: none.
16. **Hide .info files is the board's switch with A5's meaning and label**: `role="switch"`, checked = hidden, label
    `Hide .info files` — the board's `.info icons` (on = shown) would invert the remembered preference's meaning
    and `disk-files-a5`'s `check()`. The off track gets a `--muted-2` border (the board's `#D3C8B2` track is 1.5:1).
    Cost: the label reads differently from the board.
17. **The filter keeps A5's tree-wide meaning and words** (`Filter by name`, `Filter files by name`); the board's
    `Filter this folder` belongs to the folder view of Ruling 2. The sort picker stays in the header (the board has
    none; it is a remembered preference). Cost: one control more than drawn.
18. **The header's Add file is A5's single-file upload; the drop bar has no Browse files…** The board's Add files
    (its optional variant) maps onto `upload-trigger` (renamed `Add file`: it takes one file and asks its name). A
    multi-file picker into the staging list would be new behaviour in a layout pass. Cost: a phone, which cannot
    drop, still adds one file at a time — a follow-up (or area 7) can add the picker.
19. **The drop bar sits in flow under the Files card, not floating over the page, and there is no whole-page drag
    overlay.** A floating bar would cover the last rows and, on a phone, the bottom nav, and the staging list grows
    out of it; drops still land on the tree (root or a folder row) or the bar. Cost: the bar scrolls away with a
    long tree.
20. **Done and Undo stay in the toast**; the bar's error state is the staging list's capacity warning. A5's Undo lives
    in the toast (and `disk-files-a5` tests it there). Cost: the board's "added · Undo / Add more…" bar state is
    not drawn.
21. **The selection bar is the board's ink strip with A5's words** (`N items selected`, `Download .zip` — it is a zip
    — Move to…, Delete) and a `×` with `aria-label="Clear selection"`; it stays a `region` (a `toolbar` role promises
    arrow-key movement it would not have). Cost: `Download .zip` is longer than the board's `Download`.
22. **The footer counts what the list shows** (`1 folder · 12 files shown`, plus `3 .info files hidden` while hiding),
    over the open tree; the whole-disk count is on the Disk card. Cost: the number changes as folders open.
23. **Names wrap; nothing is cut with an ellipsis** (C3 Ruling 19). Cost: a 30-character name can take two lines on a
    phone.
24. **History versions collapse, as on the board; the head and the version on screen open by default.** Twenty
    versions with every change listed made the panel taller than the files. Three e2e sites in two files open a version before
    reading its changes or pressing its Restore…. Cost: an old version's Restore… is one click further away.
25. **History words stay A5's** (`As uploaded`, `Edited in browser`, `Amiga: <board>`, `Restored to version N`,
    `No earlier version to compare.`), with the board's `·` separator (`Version 3 · Restored to version 1`); the
    board's `The original upload.` is not used (version 0's label already says it). Cost: none.
26. **Change counts are the board's chips** (`+N` `~N` `−N`) with screen-reader words (`added`, `changed`, `removed`).
    Cost: none.
27. **Restore… is `--amber-text`, and its confirm stays a modal** (portalled, restyled to C3's confirm, focus on
    Cancel), shared by the History and the banner via `RestoreProvider` — not the board's inline alertdialog at the
    top of the aside, which on a phone would sit far from the banner's button. The board's `#B5541A` is 4.42:1 on
    a hovered version. The body takes the board's sentence without the new version number (a no-op restore records
    none). Not moved onto the shared `Modal` (C2's is 620/940 wide and full screen on a phone — too much for a
    yes/no). Cost: a fourth hand-rolled dialog lives on.
28. **A restore still reports in a toast**, not the board's green status box in the aside. Cost: none.
29. **The timeline line and dots are decoration**; `Current` and `Viewing` say the state in words. Cost: none.
30. **Five new tokens** (`--dir-bg`, `--exe-bg`, `--exe-fg`, `--viewing-bg`, `--warning-line`) plus `--on-ink-fill`
    (the board's 12 % surface over ink, as a solid so it is measurable). Every other board literal maps to an
    existing token (§11 and the plan's token table). Cost: six more tokens.
31. **Focus never falls to `<body>`**: after a delete, bulk delete, bulk move or a commit that removes the focused
    element it goes to the Files heading (visible ring); after a restore that leaves the old version, to the h1.
    Cost: none.
32. **`disks/[id]/files/loading.tsx` gives the page its own skeleton** (`disk-files-skeleton`), nested like the other
    areas', so the generic bones no longer show for the slowest page in the app. Cost: one more skeleton to keep in
    step.
33. **The pre-existing reds in this area are this area's to fix**: `mobile.spec.ts:455` (root cause found and fixed,
    plan Task 6), `time-machine.spec.ts:268` (asserts A1's not-found card, as A1 did for four others), and
    `time-machine.spec.ts:212` (investigated in isolation; fixed if the page is the cause, else its budget raised on
    the measured duration, as `286ecce` did for its sibling). Cost: a test-only change for 268.
34. **No migration, no new route, no new package.** Nothing in this area needs one. Cost: none.
35. **The existing `docs/screenshots/disk-files.png` is regenerated**; only that PNG is committed. Cost: none.
