# WebFloppy redesign, Phase C area 1: Library and Title — design

Date: 2026-10-24. Roadmap Phase C step 1 (`2026-10-23-webfloppy-redesign-roadmap-design.md`): "Library (grid; table
with folders, the '↑ Library' up row and paging) and Title detail". Builds on Phase B
(`2026-10-24-phase-b-foundation-design.md`): its tokens (`--ground`, `--surface`, `--surface-2`, `--track`, `--line`,
`--line-strong`, `--scrim`, `--shadow-modal`, `--font-display`), `.glass-card`, `.wf-modal`, `.seg`/`.seg-item`,
`StatusChip`, shadcn `Button` variants and `DiskIcon` (`src/components/ui/disk-icon.tsx`). Nothing here re-invents them.

Written under the operator's unattended authorization of 2026-10-24 ("you are free to implement as you see fit"). Every
design call is mine and is listed under **Rulings** at the end, with what it costs if wrong.

Target boards (local copies in the session scratchpad `design-approved/`): `ModernLibrary` (grid, rail, toolbar,
pager, card menu), `InfLibraryTable` (the approved table with folders and the up row), `ModernTitle` (title page),
`InfStates` (empty, loading, error). `ModernHeader` is context only; the header shipped in Phase B. Where
`ModernLibrary`'s table variant and `InfLibraryTable` disagree, `InfLibraryTable` wins (it is the board the operator
approved for the table, 2026-10-22).

Measured against `528cca6` (branch `feat/phase-c1-library`).

## 0. Invariants

- Every `data-testid` listed under "Kept" in §7 keeps its name and its meaning. Ids that move (into the ⋯ menu) keep
  their names; the e2e specs that must change because of a move are listed in §7.4.
- No schema change, no migration. One query gains a field (`getGameDetail` returns `kind`, §5.2) using the helper the
  list query already uses.
- Self-host parity: no new dependency, no new external call. Fonts, icons and colours are all local.
- Behaviour kept unless a ruling drops it: drag a card or row onto a rail collection, reorder inside a collection,
  card-on-card disk sets, covers, inline volume rename, sort, paging (default 48, `?page=` clamping), grid/table
  preference and `?view=`, mount/eject/cancel with Undo, DF1 choice, NFC fob, Move to collection, Remove from
  collection, Delete with confirm, version history, Demozoo badge, Create ADF, edit details, cover override, Demozoo /
  TOSEC identify, send to Amiga, extract HFE, write protection, disk-set reorder/add/move-out.

## 1. The library page (`src/app/(app)/library/page.tsx`)

### 1.1 Page header and toolbar (board: ModernLibrary top row; InfLibraryTable breadcrumb)

- `PageHeader` gains `size?: 'md' | 'lg'` (default `md`, today's 26/34 px). `lg` = 44 px Bricolage, `leading-none`,
  `tracking-[-0.02em]` from `sm`, 30 px below `sm`. Only the library and (§5) nothing else use `lg` in this area; other
  pages keep `md` until their own Phase C step.
- **Heading by view:** Uncategorized (the landing) → `Library`; a collection → its name; All titles → `All titles`.
  `auth.spec.ts:6` (`heading 'Library'` on landing) holds.
- **Eyebrow:** on the landing, the text `Amiga collection` (as today). In a collection or All titles, a
  `Breadcrumb` with one crumb `Library` → `/library` (ancestors only, the house rule `breadcrumb.spec.ts` pins), keeping
  `?view=` when it is not the default.
- **Subtitle:** unchanged words (`librarySubtitle`), mono 13 px, `var(--muted)`.
- **Actions**, right-aligned on the heading's baseline, gap 12 px, in this order: `DemozooBadge` (when the queue is
  non-empty), `LibrarySortPicker` (where it shows today), `CreateAdf`, `ViewToggle`.
  - `CreateAdf` trigger: the board's secondary button — `h-10 rounded-[10px] border px-3.5`, `var(--surface)` fill,
    `var(--line)` border, ink text 14/500, a 16 px plus icon before and a 14 px chevron (`var(--muted-2)`) after.
    Label **Create ADF** (was "New disk"). Panel / phone drawer unchanged apart from `var(--surface)` and
    `var(--line)` (no blur).
  - `LibrarySortPicker` select: `h-10 rounded-[10px]`, surface, line border.
  - `ViewToggle`: stays a `.seg` group of two `Link`s, sizes unchanged; the glyphs `▦`/`☰` become the board's two
    16 px SVGs (four rounded squares; three lines), `aria-hidden`. `view-toggle.test.ts` is updated for the SVG child
    and drops the `text-[11px]` class.

### 1.2 Collection rail (`src/components/collections/collection-rail.tsx`; board: ModernLibrary aside)

- No card box: the rail sits on the ground (`.glass-card` removed), `md:w-60` (240 px, was 224), gap 2 px between
  rows. Below `md` it stays the full-width band above the titles, as today, with the page gutter.
- A caption `Collections` (12/500, `var(--muted-2)`, padding 8×12) above the rows.
- **Row** (Uncategorized, each collection, All titles): `h-[38px] rounded-[10px] px-3`, a 8×8 rounded-[3px] dot, the
  name 14 px (500; 600 when current), the count mono 12 px `var(--muted-2)`. Hover `var(--track)`. Current row:
  `var(--surface)` fill, `box-shadow: 0 1px 2px rgb(36 33 27 / .1), 0 0 0 1px var(--line)`, `aria-current="page"`.
  Today's ink-filled current row goes.
- **Dots** (no stored colour exists): Uncategorized `#C4B9A2`, All titles `var(--ink)`, a collection
  `collectionDot(id)` = one of the logo's four stripe colours (`#D9453A #EE8A2A #4F9D4A #2F6FB5`) by a stable hash of
  the id (`src/lib/library-look.ts`). The same dot colours the collection's folder icon in the table (§3.2).
- **Order stays today's:** Uncategorized, a 1 px `var(--line)` divider, the collections (drag to reorder, grip kept,
  muted until hover), divider, the New collection form, divider, All titles. (Board puts All titles first: Ruling 6.)
- **Collection row controls** (rename / delete menu `collection-menu-<id>`, inline rename input): kept, restyled to
  the board's ghost icon button (28 px, `var(--muted)`, hover track). Drop-target highlight: `var(--surface-2)` fill
  with a 1 px `var(--ink)` ring (was navy).
- **New collection:** the board's pair — an input `h-9 rounded-[9px]`, `var(--surface)`, `1px dashed var(--line-strong)`,
  placeholder `New collection`, and a 36×36 `+` button (`aria-label="Add collection"`, surface, line border) that
  submits the same form. Enter still submits. `collection-create` stays on the input.
- **Hint** under the rail (12 px, `var(--muted-2)`, margin 12 px): grid — "Drag titles onto a collection to file them.
  Drag collections to reorder."; table — "Drag a row onto a collection to file it." Hidden below `md`.

### 1.3 Grid card (`game-grid.tsx`, `cover.tsx`, `title-controls.tsx`; board: ModernLibrary `.m-card`)

Grid columns unchanged (2 / 3 from `sm` / 5 from `md`), gap `gap-4` below `md`, `gap-5` (20 px) from `md`.

- **Card**: still the `Link` with `data-testid="game-card"`, `glass-card` (surface, 16 px radius, 1 px line border),
  padding 0. Hover: `box-shadow: 0 18px 36px -16px rgb(36 33 27 / .35)` and border `var(--line-strong)` — **no
  translate** (Ruling 8). The inner art may scale (cover `scale(1.035)`; disk icon `translateY(-6px) rotate(-3deg)`),
  both inside an `overflow-hidden` box, so the card's box never changes. `prefers-reduced-motion` turns both off.
- **Art box**: `m-2 mb-0 rounded-[10px] overflow-hidden`, **aspect 4 / 5** (was 1.23 / 1), an inset 1 px
  `rgb(0 0 0 / .08)` hairline drawn by an `aria-hidden` overlay.
  - With a cover: today's two-image treatment stays (blurred backdrop + `object-contain`), so a logo or a landscape
    screenshot is never cropped (Ruling 9). `cover-image` stays on the real `<img>`.
  - Without a cover: a stage colour (`stageFor(color)`) with a centred `DiskIcon` (124 px at `md+`, 96 px below,
    `color = titleDiskColor(game)`, `set` = the byline or `HD · 1.76 MB` for an HD title, `title`, `hd`, `stack =
    diskCount`, `mounted` when a hold is confirmed) wrapped in `data-testid="cover-disk"`, and under it "No cover art
    yet" (11/500, `var(--muted-2)`). The old gradient, scanlines and white title overlay go (`gradientFor`, `hueFor`
    are deleted with their only users).
  - **Drive badge** (`data-testid="drive-badge"`, top-right of the art box, 8 px in): the board's pill —
    `#14201A` fill, mono 11/600 `#9BEA9F` text, a 6 px dot — `DF0`. Dot green `var(--online-dot)` when confirmed;
    amber `#E9A23B` and text `DF0…` while fetching or requested. `title` = the hold labels. Shown with or without a
    cover. The ring (`drive-ring`, solid / dashed) stays as well (Ruling 7).
- **Text block** (inside the link, `px-3.5 pt-3 pb-1`): the title (`TitleName`: inline rename on an authored
  single-disk title, as today) 14/600 truncated; the byline 13 px `var(--muted-2)` truncated = `year · publisher`,
  or `made here` for an authored title, else nothing (the operator's 2026-10-22 "no unidentified" rule beats the
  board's "Unidentified", Ruling 10).
- **Footer** (`pl-3.5 pr-2 pt-1.5 pb-2.5`, gap 6): the type pill `data-testid="grid-kind"` when `kind` is known
  (`kindTag(kind)` colours, §4), the disk count `data-testid="grid-disks"` mono 12 px `var(--muted-2)` — `1 disk` /
  `N disks`, a spacer, then the ⋯ trigger (§2). The type pill and the disk-count badge leave the art.
- `HoldsLabel` (sr-only) and the drag behaviour (`DraggableCard`, `SortableCard`, `SetDropHint`, `dragStyle`,
  `pendingHideStyle`, `draggable={false}`, discarded `role`) are untouched. `SetDropHint` keeps its words; its fill
  becomes `rgb(36 33 27 / .35)` (already) and its radius follows the card.

### 1.4 Pager (`library-pager.tsx`; board: ModernLibrary / InfLibraryTable `nav[aria-label=Pages]`)

Same element, ids and behaviour. Restyle: `mt-6`; steps `h-[34px] min-w-[34px] rounded-[9px] px-2`, numbers mono
13/600, Prev/Next 13/600 sans; current `var(--ink)` fill with `var(--surface)` text; disabled Prev/Next
`var(--muted-2)`; hover `var(--track)`. "Per page" label 13/500 `var(--muted)`; the select `h-[34px] rounded-[9px]`,
surface, line border, 13 px. Options unchanged (24 / 48 / 96 / 192 / All).

## 2. The title menu (both views; board: ModernLibrary `role=menu`, InfLibraryTable row menu)

Today a card and a row carry up to six inline 14 px icon buttons (`TitleControls`). The boards put them in a ⋯ menu.

- **Trigger**: `button` `data-testid="title-menu-<gameId>"`, `aria-label="More actions for <title>"`,
  `aria-haspopup="menu"`, `aria-expanded`; 32×32 (44×44 below `sm`), `rounded-lg`, `var(--muted)`, hover track, a
  16 px three-dot glyph. Inside the card's/row's `<a>` like today's controls, with the same `stopDrag` handlers on
  pointer/mouse/touch down and `preventDefault` + `stopPropagation` on click.
- **Menu**: `src/components/library/title-menu.tsx`, built on `ui/dropdown-menu.tsx` (Base UI Menu, already used by
  the disk-set ⋯ menu), portalled, `data-testid="title-menu-panel"`, 216 px wide (230 in the table), `p-1.5`,
  `var(--surface)`, 1 px `var(--line)`, 12 px radius, `box-shadow: 0 20px 40px -12px rgb(36 33 27 / .3)`. Items
  36 px (44 px below `sm`), 13 px, a 16 px icon, hover `var(--surface-2)`. The popup and every item stop pointer, mouse,
  touch and click propagation: React bubbles portal events to the card's `Link` and dnd-kit's listeners.
- **Items, in this order** (board order), each keeping the old trigger's id, `aria-label` and behaviour:
  1. Mount / Eject — `card-mount-<id>` or `card-eject-<id>`, 600 weight. Label `Mount in DF0` when a click mounts
     straight away (one disk, one board, DF1 off), else `Mount…` (opens today's picker with its disk, board and
     DF0/DF1 choices). Ejecting: `Eject from DF0` (one confirmed hold), `Cancel mount` (one request), `Eject or
     cancel…` (several). Shown only when the org has a board (as today).
  2. `Write to NFC tag` — `fob-<id>`; only with a reader, as today.
  3. `Version history` — `history-<id>`; single-disk titles only, as today.
  4. `Move to collection…` — `move-to-collection-<id>`.
  5. `Remove from collection` — `remove-from-collection-<id>`; inside a collection only.
  6. a 1 px divider, then `Delete title` — `delete-game-<id>`, `var(--danger-fg)`.
- **Dialogs survive the menu**: Base UI unmounts the popup on close, and today each control owns its dialog's state.
  So `CardMountButton`, `FobButton`, `MoveToCollectionButton` and `DeleteDiskDialog` are each split into a trigger and
  a controlled dialog (`open`, `onClose`, plus the props they take today); `TitleMenu` owns `which: null | 'mount' |
  'fob' | 'move' | 'delete'` and renders the chosen dialog outside the popup. Focus returns to the ⋯ trigger on
  close. The standalone triggers stay for their other users (the title page's `fob-<diskId>` and
  `delete-disk-<diskId>`), so those keep working unchanged. Dialog ids (`card-mount-dialog`, `fob-dialog`,
  `move-dialog`, `delete-dialog`, …) are unchanged.
- Mount Undo toast, `router.refresh()`, error toasts: unchanged (same code paths).
- Help (`src/lib/help/topics.tsx`, topic `library`): the "Controls" paragraph and its source comment are rewritten
  for the ⋯ menu and its order; "New disk" mentions become "Create ADF" (Ruling 20).

## 3. The table (`game-table.tsx`; board: InfLibraryTable)

### 3.1 Frame and header

- `glass-card` (16 px radius), `overflow-hidden` kept for the corners, the inner `overflow-x-auto` and its min width
  (now `min-w-[760px]`) kept so a phone can reach every column.
- **Columns** (`grid-template-columns`): `36px minmax(0,1fr) 104px 56px 150px 52px 96px 44px`, gap 14 px, `px-[18px]`.
  Type stays 104 px (not the board's 96) because "Educational" needs it (the comment's measurement); Ruling 12.
- Header row `h-11`, 12/500 sans `var(--muted-2)`, bottom border `var(--line)`: (blank) · `Name` · `Type` · `Year` ·
  `Publisher` · `Disks` (right) · `Size` (right) · (blank). Sentence case, not today's mono capitals.

### 3.2 Rows

- **Up row** (`up-row`, in a collection or All titles): `h-11`, `↑ Library` 14/500 `var(--muted)` in the Name column.
  No icon (the final-review M8 ruling and `library-table.spec.ts:323` assert one arrow; the board draws an SVG too,
  Ruling 13). Hover surface-2. Bottom border `var(--hairline)`.
- **Folder rows** (`folder-row`, root only, first page only, as today): `h-[46px]`; a 24×20 folder glyph filled with
  `collectionDot(id)` (the board's path, with its 25% light overlay); the name 14/600; `Collection` in the Type column
  (12 px `var(--muted-2)`); `folder-titles` (`N titles`, 12 px `var(--muted-2)`) after the name in the Name column,
  as today; the Disks column the disk count (`folder-disks`, mono 13 `var(--muted)`); Size blank (Ruling 14); a `›`
  (`aria-hidden`, `var(--muted-2)`) in the last column. Not a drop target, as today. The `aria-label` keeps its
  words.
- **Title rows** (`game-row`): `h-[46px]`, 13 px; bottom border `var(--hairline)`; hover `var(--surface-2)`; a row
  whose title is confirmed in a drive takes `var(--mounted-bg)` (§4).
  - Col 1: `DiskIcon` 26 px (`titleDiskColor`, `hd`, `stack`), replacing `CoverThumb` (Ruling 15). The compact
    `drive-ring` is drawn round it, and `HoldsLabel` sits in the same cell, as today.
  - Name: `TitleName` 13/500, then the `drive-badge` pill (§1.3) when held.
  - Type: `kindTag` pill (`game-kind` cell id kept), else `—` in `var(--muted-2)`.
  - Year `var(--ink)` or `—` muted-2; Publisher `var(--muted)` or `—`; Disks mono, right; Size mono, right, with
    `HdTag` (`game-hd-tag`).
  - Last column: the ⋯ trigger (§2), `justify-self-end`.
- `RowDragOverlay` (portalled chip) unchanged; `table-empty-note` unchanged.

## 4. Shared look (`src/lib/library-look.ts`, `src/app/globals.css`)

- New tokens in the webadf `:root` block: `--mounted-bg: #EEF6EC` (a held row), `--mounted-line: #9CCB98` (a held
  disk's ring on the title page), `--drive-pill-bg: #14201A`, `--drive-pill-fg: #9BEA9F`, `--fetch-dot: #E9A23B`.
- `kindTag(kind)` → `{ bg, fg }`: Game `#E1ECF8`/`#1D4A7A`, App `#EEE5F5`/`#5A3380`, Demo `#E2F0DF`/`#2E5B2A`, any
  other kind (Educational, Coverdisk) `var(--track)`/`var(--muted)`. One map for grid, table and title page (the
  boards disagree; ModernLibrary's wins, Ruling 11). Unit-tested for ≥ 4.5:1 on each pair.
- `titleDiskColor({ id, hasHd, kind, formats? })` → `DiskColor`: an HD or HFE title `grey`; no kind and not authored
  `cream`; else `['black','red','blue','green'][hash(id) % 4]`. `stageFor(color)` → the board's stage map
  (`black #F1ECE2`, `blue #E9EEF4`, `grey #EEEDEA`, `red #F6E9E4`, `green #E8F0EA`, `cream #F4EFE5`).
- `collectionDot(id)` as §1.2. All three pure, unit-tested (stable for a fixed id, total over inputs).

## 5. Title page (`src/app/(app)/games/[id]/page.tsx`; board: ModernTitle)

### 5.1 Layout

Top to bottom, inside the page gutter (`px-4 sm:px-7`), gap 24 px:

1. The breadcrumb (`breadcrumb`, `libraryTrail(...)` as today) on its own line, 13 px.
2. **Hero** `section[data-testid=title-hero]`: `glass-card` at 20 px radius, `p-7`, a row from `lg` (art 260 px ·
   info flex-1 · identify box 360 px, gap 36 px, `items-center`), a column below `lg` (art, info, identify box; art
   centred, max 260 px).
3. Below the hero, full width, in this order: the edit panel when open (§5.3), the linked Demozoo panel when linked
   (§5.4), `GameFacts` (without its cover, §5.2), the Disks section (§6).

`PageHeader` is no longer used on this page; the `h1` lives in the hero.

### 5.2 Hero content

- **Art** `data-testid="title-art"`, `rounded-2xl`, fixed size so nothing shifts when an image decodes:
  - with a cover (override → front → title image, today's precedence in `GameFacts`): 260 × 325 (4 / 5), the image
    `object-contain` on `var(--surface-2)`; the `<img>` carries `game-cover` (moved here from `GameFacts`, same alt).
    `openretro.spec.ts:276-296` measures `game-cover`'s parent (> 200 wide, > 260 tall, unchanged after decode):
    260 × 325 satisfies it.
  - without: 260 × 240 on `stageFor(color)` with `DiskIcon` 180 px (`stack = disks.length`, `mounted` when any disk
    is confirmed in a drive, `set` = the collection carried by `?from=` or the kind or `Unidentified`, `title`).
  - `CoverControl` (`cover-file`, `cover-change`, `cover-revert`, `help-tip-cover-image`) sits under the art as small
    ghost buttons (12 px), so the cover is changed where it is shown.
- **Info** (flex column, gap 14):
  - `h1`: the title, Bricolage 48 px / 700 / `leading-none` / `-0.02em` (34 px below `sm`, `break-words`).
    `game-detail.spec.ts:38` (`heading` by name) holds.
  - **Pills** `data-testid="title-pills"`, `StatusChip`-sized (13/500, `px-2.5 py-[3px]`, full radius): kind
    (`title-pill-kind`, `kindTag` colours, only when known); `N disks` (`title-pill-disks`); `Year 1991` or `Year —`
    (`title-pill-year`); `Publisher Team 17` or `Publisher —` (`title-pill-publisher`) — both shown with a dash when
    unknown (show both values of a state); when a disk is confirmed in a drive, the drive pill
    (`title-pill-drive`, `--drive-pill-*`, `DF0 · ADF` / `DF0 · HFE`). Genre and chipset stay in `GameFacts`.
  - Actions row: `EditDetails`'s trigger (`edit-details`), restyled to the board's secondary button with a pencil
    icon, label `Edit details`; Save/Cancel stay in the panel (§5.3).
- **Identify box** `data-testid="title-identify"`: `var(--surface-2)`, 14 px radius, `p-[18px]`, gap 10. It renders
  whichever unlinked branch of `DemozooPanel` applies, with all their ids: `identify-search-panel` (a game: TOSEC
  search), `demozoo-restore`, or `demozoo-suggestions` (with its search). Heading 13/600 = `Identify with Demozoo`
  for a non-game, `Identify with TOSEC` for a game; the box's own card chrome (`glass-card p-5`) goes, since the box
  is the card. Inputs and buttons take the board's 38 px surface style. The credit line ("Suggestions from
  Demozoo…" / "Releases from TOSEC…") under it, 12 px `var(--muted-2)`, link `var(--amber-text)`. When the title is
  linked, the box shows the production's name, a "Linked to Demozoo" line and `demozoo-unlink`; the facts,
  screenshots and credit stay in the full-width `demozoo-panel` below.
- `getGameDetail` gains `kind: string | null` from the same `kindFromSetName`/`pickKind` path the list uses (one more
  query per title render; the `games/[id]/page.tsx` comment that declined it for the breadcrumb is rewritten).

### 5.3 Edit details

`edit-details` opens today's `edit-panel` (groups, `edit-owner-*`, `edit-reset-*`, `edit-field-*`, `edit-save`,
`edit-cancel`) full width directly under the hero, restyled: `glass-card` 16 px, inputs `h-10 rounded-[10px]` surface
with line border, Save = ink button, Cancel = ghost. Not the board's in-hero three-field form (Ruling 16).

### 5.4 Facts and Demozoo panels

`GameFacts` loses its cover column (now in the hero) and otherwise keeps every fact, link, description, screenshot and
credit id; its card takes 16 px radius and the board's 13/15 px type. `game-facts` stays the element
`openretro.spec.ts` measures. The linked `demozoo-panel` likewise.

## 6. Disks list (`disk-row.tsx`, `disk-set-section.tsx`, `mount-action.tsx`, `write-protect-toggle.tsx`; board: ModernTitle `section[aria-label=Disks]`)

- **Section**: `section[aria-label=Disks]` with `h2` `Disks` 15/600, gap 12. For a set, `disk-set-section`'s header
  (set name `set-name`, `set-rename`, `disk-set-add`, `disk-set-reorder`, `disk-set-done`, the help tip) takes the
  `h2`'s place on the same line. `SendBoardPicker` (`send-board-select`) moves to the right of that heading line.
- **Disk row** (`disk-<id>`, `data-disk-row`): `glass-card` 16 px, `px-[18px] py-4`, gap 18. A row whose disk a
  board has confirmed gets `border-color: var(--mounted-line)` and `data-mounted="true"`.
  - Left: `DiskIcon` 56 px (`titleDiskColor` per disk, `wp` = protected or HFE, `mounted`), `aria-hidden`.
  - Middle: line 1 `Disk N` 15/600, the Boot pill (`#FCE6D6`/`#8A3A0E`, 12/600) when boot, the format pill
    (`disk-format-<id>`, track fill, mono 11/600: `ADF`, `ADF · HD`, `HFE`; the HFE pill also carries
    `hfe-tag-<id>`). Line 2 the file name mono 13 (TOSEC name, else source name; `tosec-name-<id>` /
    `source-name-<id>` kept on whichever shows; the second name, when both differ, goes into line 3 as `uploaded as …`
    with its id). Line 3 meta 12 px `var(--muted-2)`: `uploaded as X · 880 KB · <sha12>` (`hd-tag-<id>` stays on the
    HD marker). The HFE weak-bit notice (`hfe-notice-<id>`) 12 px with the warning triangle, `var(--warning-fg)`.
    `holder-<id>` unchanged in words and colour rule.
  - Right (wraps below the text under `sm`, as today): write protection, Download, Browse or Extract, Mount, Send,
    NFC, Delete, the set ⋯ menu — today's order with Send after Mount.
    - **Write protection** (`wp-<id>`, `data-protected`, `aria-pressed`): the board's switch — a 32×18 track (ink
      when protected, `var(--line-strong)` when writable) with a 14 px knob, then the label `Protected` / `Writable`
      13/500. An HFE shows the same switch disabled and locked on with `Read-only`, carrying `hfe-readonly-<id>` and
      the existing title text.
    - Download (`download-<id>`), Browse (`browse-<id>`), Extract (`extract-<id>` and its reason/edited ids): 38 px
      secondary buttons (surface, line border, 10 px radius, 13/500).
    - **Mount** (`mount-<id>`, `eject-<id>`, `mount-<id>-menu`, `mount-<id>-none`, …): `MountAction` keeps its
      words, its inline picker and its DF0/DF1 split (Ruling 17); restyled to the board: Mount = ink fill 38 px
      13/600 with the down-triangle icon; Eject = surface fill with a 1 px ink border and the up-triangle icon.
    - Send (`send-adf-<id>`): secondary button.
    - NFC (`fob-<diskId>`) and Delete (`delete-disk-<diskId>`): 38×38 ghost icon buttons, NFC `var(--muted)`,
      Delete `var(--danger-fg)`; `aria-label`s unchanged. Delete keeps its dialog (Ruling 18).
    - The set ⋯ menu (`disk-menu-<id>`, `disk-up/down/move-out-<id>`, `disk-add-to-set-<id>`): the ⋯ trigger takes
      the same 38 px ghost look; the menu panel matches §2.
  - Help tips (`write-protect`, `nfc`, `hd-hfe`) stay where they are today in the row.
- **Reorder mode** (`disk-reorder-row-*`, grips, ▲▼): restyle only (surface rows, line border, 44 px buttons below
  `sm` as `mobile.spec.ts` requires).

## 7. Test ids

### 7.1 Kept (name and meaning)

Library: `active-org`, `game-grid`, `game-table`, `game-card`, `game-row`, `folder-row`, `folder-titles`,
`folder-disks`, `up-row`, `table-empty-note`, `row-drag-overlay`, `set-drop-target`, `cover-image`, `grid-kind`,
`game-kind`, `game-hd-tag`, `drive-ring`, `volume-name-<id>`, `volume-name-locked-<id>`, `library-pager`, `pager-prev`,
`pager-next`, `pager-page-<n>`, `pager-size`, `library-sort`, `create-adf`, `create-adf-panel`, `create-adf-submit`,
`demozoo-badge`, `category-overview`, `collection-rail`, `collection-uncategorized`, `collection-all`,
`collection-row`, `collection-name`, `collection-count`, `collection-menu-<id>`, `collection-rename-<id>`,
`collection-delete-<id>`, `collection-create`, `library-skeleton`, `library-skeleton-rail`.
Card/row actions (now menu items, §2): `card-mount-<id>`, `card-eject-<id>`, `fob-<id>`, `history-<id>`,
`move-to-collection-<id>`, `remove-from-collection-<id>`, `delete-game-<id>`; dialogs `card-mount-dialog`,
`card-mount-disk-*`, `card-mount-device-*`, `card-mount-drive-df0/df1`, `card-mount-df1-note`, `card-mount-confirm`,
`fob-dialog` and its children, `move-dialog`, `delete-dialog`, `delete-cancel`, `delete-confirm`, `set-drop-*`.
Title: `breadcrumb`, `game-facts`, `game-cover`, `fact-*`, `game-description`, `game-screenshots`, `openretro-credit`,
`edit-details`, `edit-panel`, `edit-group-*`, `edit-owner-*`, `edit-reset-*`, `edit-field-*`, `edit-save`,
`edit-cancel`, `cover-file`, `cover-change`, `cover-revert`, `identify-search-panel`, `identify-search*`,
`demozoo-*`, `tosec-*`, `send-board-select`, `send-adf-<id>`, `disk-<id>` + `data-disk-row`, `hfe-tag-<id>`,
`tosec-name-<id>`, `source-name-<id>`, `hd-tag-<id>`, `hfe-notice-<id>`, `holder-<id>`, `download-<id>`,
`browse-<id>`, `hfe-readonly-<id>`, `wp-<id>`, `mount-*`, `eject-*`, `extract-*`, `fob-<diskId>`,
`delete-disk-<diskId>`, `disk-menu-<id>`, `disk-up/down/move-out/add-to-set-<id>`, `disk-set-*`, `set-name`,
`set-rename`, `set-rename-input`, `disk-reorder-*`, `disk-grip-*`, `add-disks-*`, `not-found-page`, `page-skeleton`.

### 7.2 New

`title-menu-<gameId>` (⋯ trigger), `title-menu-panel` (menu popup), `drive-badge` (card art and table row),
`grid-disks` (card footer count), `cover-disk` (no-cover disk icon), `title-hero`, `title-art`, `title-pills`,
`title-pill-kind`, `title-pill-disks`, `title-pill-year`, `title-pill-publisher`, `title-pill-drive`,
`title-identify`, `disk-format-<diskId>`, `title-skeleton` (§8); attributes `data-mounted` on a disk row,
`data-empty="library" | "collection"` on the empty state.

### 7.3 Removed

`cover-thumb` (the table's thumbnail; no e2e reader). No id is renamed.

### 7.4 Specs that change, and why

| Spec | Change |
|---|---|
| `library-mount`, `library-a3`, `library-table`, `nfc-fob-button`, `delete-disk`, `collections` (remove), `time-machine` (history), `hd-disks`, `screenshots.shots.ts`, `mobile` (fob/delete taps) | open the menu first with a new helper `openTitleMenu(page, gameId)` (`e2e/helpers.ts`: click/tap `title-menu-<id>`, wait for `title-menu-panel`), then select the item at page level (the popup is portalled, so `card(...).getByTestId(item)` scoping becomes `page.getByTestId(item)`; the ids carry the game id, so they stay unique) |
| `library-table.spec.ts:161`, `:288` | the order assert reads the menu items: `card-mount, (fob), history, move-to-collection, (remove-from-collection), delete-game` |
| `library-covers.spec.ts` "no images … title overlay" | asserts `cover-disk` visible and the title visible in the card (overlay gone) |
| `library-covers.spec.ts` "disk-count badge survives", `library-type-column.spec.ts` "typed multi-disk card" | `grid-disks` has text `2 disks` (was a bare `2`) |
| `library-type-column.spec.ts` "pill on the cover" | test name only ("pill on the card"); `grid-kind` assert unchanged |
| `empty-library.test.ts`, `view-toggle.test.ts`, `loading.test.ts` | new texts / SVG children / `md:w-60` |
| `contrast.spec.ts` (empty library) | selector unchanged (`[data-testid=game-grid] p:nth-of-type(2)` is still the muted line); new pairs (§9) |

## 8. States (board: InfStates; A1 shipped the mechanism)

- **Empty library** (`EmptyLibrary`, any view, nothing at all): the view's test id kept, `data-empty="library"`;
  `var(--surface)` with `1px dashed var(--line-strong)`, 20 px radius, `px-8 py-16`, gap 14, centred. `DiskIcon`
  cream 96, `set="Your library"`, `title="Empty"`; `<p>` `No disks yet` (Bricolage 22/700); `<p>` "Drop ADFs on the
  Upload page, or fetch one from a URL." (14 px `var(--muted)`); `Add disks` → `/ingest`, ink 40 px button.
- **Empty collection** (a collection with no titles, grid; the table keeps `table-empty-note`): same card,
  `data-empty="collection"`, cream disk `set="Empty"`, `title="New box"`, "Nothing in this collection yet", "Drag
  titles here, or move them from a title's ⋯ menu.", `Upload disks` → `/ingest`.
- **Library loading** (`library/loading.tsx`): rail as §1.2 (no card, caption + six 38 px row bones, `md:w-60`), cards
  as §1.3 (4 / 5 art bone, two text bones, a footer bone). Pulse as Phase B's `Bone`.
- **Title loading** (new `games/[id]/loading.tsx`, `title-skeleton`): a breadcrumb bone, a hero-shaped card (260×240
  art bone, a 48 px heading bone, a pill row, a 360 px box bone), two disk-row bones. Nested under `(app)/loading.tsx`,
  which already streams this route, so status codes do not change (not-found stays HTTP 200 with the card).
- **Not found / error**: `StateCard` and `ErrorView` stay shared and keep their words (`states.spec.ts`). The card
  takes the board's look: surface, 20 px radius, `p-7`, a mono 13 px code line above the heading (`404`; `Server
  error` in `var(--danger-fg)` for `ErrorView`), Bricolage 22/700 heading, the action as an ink 40 px button
  (`StateLink` gains `variant="button"`, used for "Back to the library").

## 9. Phone (390 px) — only what the boards and today's specs pin

Area 7 owns the full phone pass. Here: the grid stays two columns; the rail stays a band above the titles; the hero
and disk rows stack (§5.1, §6); the ⋯ trigger and its items are 44 px; the table scrolls sideways inside its card;
nothing scrolls the page sideways (`mobile.spec.ts` "library grid is two columns", the disk-set 390 px test, the
New disk/Create ADF sheet test, `cover-override.spec.ts` "controls fit a 390 px phone").

Contrast pairs added to `contrast.spec.ts` and the `library-look` unit test: each `kindTag` pair; `--drive-pill-fg` on
`--drive-pill-bg`; `--muted-2` on `--mounted-bg`; ink on each stage colour; white on the Boot pill is not used (its
text is `#8A3A0E` on `#FCE6D6`).

## 10. Out of scope

- The header, drive chips and nav (Phase B; the nav's 640–1000 px clamp is area 7).
- Toasts (sonner) restyle to the board's ink toast: shell-wide, later area.
- Devices' offline card from InfStates (area 2), the Upload page (area 3), Disk files (area 4), Help/Settings (5).
- The `/library/demozoo` review page beyond the shared tokens.
- A folder Size aggregate, stored collection colours, a SHA-256 table column.
- The board's in-hero three-field edit form and the inline delete confirm (Rulings 16, 18).

## Rulings (operator to review)

1. **Card and row actions move into a ⋯ menu** (board), in the board's order: Mount, NFC, History, Move, Remove,
   Delete. Ids are kept on the items; ~40 e2e call sites open the menu first via one helper. Cost if wrong: one more
   click per action; reverting means rendering `TitleControls` inline again (the items are the same components).
2. **One Mount item, not the table board's separate "Mount in DF0" / "Mount in DF1".** It mounts directly when
   there is one choice and otherwise opens today's picker, which already offers DF0/DF1. Cost: DF1 is one step deeper.
3. **The four dialogs become controlled** and are rendered by the menu's owner, so they outlive the popup. Cost: a
   refactor of four components; their standalone triggers stay for the title page.
4. **Library heading names the view** (`Library` / collection name / `All titles`); the eyebrow becomes a one-crumb
   breadcrumb inside a collection. Cost: two strings; `auth.spec` still sees `Library` on landing.
5. **`PageHeader` gets a `lg` size** for the library rather than every page jumping to 44 px now. Cost: two heading
   sizes coexist until the other areas move.
6. **Rail order stays Uncategorized … All titles last** (board: All titles first). The landing is the inbox, and
   `collections.spec.ts:795` pins the order. Cost: one row's position.
7. **Drive marker: the board's DF0 pill is added; the ring stays.** The pill also shows fetching (amber, `DF0…`),
   which the board does not draw. Cost: two markers on a held card.
8. **No hover lift** on cards (board: −2 px). The drag specs compare bounding boxes with the pointer over cards.
   Cost: a flatter hover; the inner art still moves.
9. **Grid art is 4 / 5 (board), but covers stay contained over a blurred backdrop, not cropped** (board:
   `object-fit: cover`). Screenshots used as covers are landscape. Cost: letterboxing on some covers.
10. **No "Unidentified" byline** (board) — the operator's 2026-10-22 rule and `library-paging.spec.ts:189` win.
11. **One type-pill palette** (ModernLibrary's; the table and title boards use others). Cost: table pill colours
    differ from InfLibraryTable.
12. **Table Type column stays 104 px** (board 96) for "Educational". Cost: 8 px.
13. **Up row keeps one arrow, no icon** (board draws an icon plus `↑`): the final-review M8 ruling. Cost: none.
14. **Folder rows show disks, not size** (board: titles and MB). No size aggregate exists; adding one is a query, not
    worth it here. Cost: an empty Size cell.
15. **Table rows show a 26 px disk icon instead of the cover thumbnail** (board). Cost: covers are not visible in
    the table.
16. **Edit details keeps today's full panel** under the hero (groups, owners, reset), not the board's three inline
    fields. Cost: editing does not happen in place.
17. **Title-page mount keeps its words** (`Mount`, `Mount to ▾`, `Eject`, `DF0`/`DF1` split; board: "Mount in DF0"),
    pinned by `game-detail.spec.ts` and `mount-to-device.spec.ts`. Restyle only. Cost: words differ from the board.
18. **Delete keeps its confirm dialog** (board: inline "Delete this disk?"). One dialog serves the library and the
    title page; `delete-disk.spec.ts` drives it. Cost: a modal where the board has an inline prompt.
19. **Collection dots are derived from the id** (no colour is stored). Cost: a person cannot pick a colour; a later
    stored colour replaces `collectionDot` without touching callers.
20. **Create ADF replaces "New disk"** as the trigger's label (board). Cost: one string; Help's "New disk" mentions
    are updated with it.
21. **The empty-library text drops the `webadf push` hint** for the board's "…or fetch one from a URL." Cost: the CLI
    is mentioned only in Help.
22. **`getGameDetail` gains `kind`** (one query per title render) for the hero's type pill. Cost: a query.
23. **InfLibraryTable's caption ("The library opens in Table or Grid…") is a board note, not UI**, and is not built.
