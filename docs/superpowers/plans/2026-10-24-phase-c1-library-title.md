# Phase C1 Library + Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** The library (grid, table with folders and the up row, rail, toolbar, pager), the title page and their
empty/loading states take the approved layouts (ModernLibrary, InfLibraryTable, ModernTitle, InfStates), with every
existing behaviour kept.

**Architecture:** Presentation-only change on Phase B's tokens and components. Pure look rules in a new
`src/lib/library-look.ts`; one new client component (`src/components/library/title-menu.tsx`) on the existing
`ui/dropdown-menu.tsx`; four dialogs split into trigger + controlled dialog; a new hero for the title page
(`src/components/games/title-hero.tsx`). One query gains a field (`getGameDetail` → `kind`). No schema, no migration,
no new route.

**Tech Stack:** Next.js 16.3.2 App Router (read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`
and `not-found.md` before Task 7's `loading.tsx`), Tailwind v4, drizzle-orm/Postgres, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-phase-c1-library-title-design.md`

## Global Constraints

- Texts, test ids and orders exactly as the spec writes them; every id in spec §7.1 must still resolve.
- Colours only through tokens (Phase B §4 plus spec §4's five new ones) or `library-look.ts`; no `#7A7262`/`#A39B8B`
  text (Phase B ruling 4: `--muted-2`).
- No `translate` on a card's or row's own box at rest or on hover; drag geometry (`dragStyle`, `pendingHideStyle`,
  `draggable={false}`, discarded dnd-kit `role`) untouched.
- Self-host parity: no new package, no external URL, no our-deployment-only path.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): real `pnpm install --offline`, `.env.local`,
  `npx next typegen`, the `adf-archive` symlink.
- House rules, every task: stage files by name (never `git add -A`, under `wifi-floppy/` especially), no `git stash`;
  stop only your own PIDs; e2e with `PORT=3100`, ONE run at a time, each command under 9 minutes (split long specs
  with `-g`), run in the foreground; the e2e DB is the live production DB shared with other runs, so assert relative
  to rows you seeded (run tags, seeded titles), never absolute counts; no commit after a red run; commit trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`.

## Review Focus

1. The ⋯ menu is portalled: no click, pointer or touch on the popup or an item may reach the card's `Link` (navigation) or dnd-kit (a drag).
2. A dialog opened from the menu (mount picker, fob, move, delete) survives the popup closing, and focus returns to the ⋯ trigger.
3. Card and row bounding boxes do not change on hover, menu open or image decode (`collections`, `disk-sets`, `openretro` compare boxes).
4. Every spec §7.1 id still exists exactly once per card/row/page; renamed/moved selectors are only those in spec §7.4.
5. e2e assertions stay relative to seeded rows on the shared production DB; runs are serialised and under 9 minutes.

## Common commands

- Unit: `pnpm test <path>`; types: `npx tsc --noEmit`; lint: `pnpm lint`.
- e2e desktop: `PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<title part>"]`.
- e2e mobile: `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "<title part>"`.
- Screenshots: `PORT=3100 pnpm screenshots` (own config, own demo account; Task 7 only).
- The `-g` patterns below are starting points, not verified titles: before running, check with
  `npx playwright test e2e/<name>.spec.ts --list -g "<pattern>"` that the pattern selects what the task needs, and
  that a file split into several runs is covered whole.

---

### Task 1: Look rules, tokens and controlled dialogs (no visible change)

**Files:** new `src/lib/library-look.ts` (`kindTag`, `titleDiskColor`, `stageFor`, `collectionDot`, spec §4) and
`src/lib/library-look.test.ts`; `src/app/globals.css` (the five tokens of spec §4, in the webadf `:root` block, with a
comment line each); `src/components/library/card-mount-button.tsx` (export `CardMountDialog` — controlled: `open`,
`onClose`, plus today's props — and a `useCardMount` hook holding `act`/`undo` so a menu item can mount directly;
`CardMountButton` becomes trigger + `CardMountDialog`); `src/components/nfc/fob-button.tsx` (`FobDialog` controlled,
`FobButton` = trigger + dialog); `src/components/library/move-to-collection.tsx` (`MoveToCollectionDialog`);
`src/components/library/delete-disk-dialog.tsx` (`DeleteDialog` controlled; `DeleteDiskDialog` = trigger + dialog).
Every existing trigger keeps its markup and ids, so nothing on screen changes.
**Tests:** unit `library-look.test.ts`: `kindTag` covers Game/App/Demo/other and each pair is ≥ 4.5:1 (reuse the
contrast helper the Phase B token test uses); `titleDiskColor` (HD/HFE → grey, unknown non-authored → cream, else
stable for a fixed id); `collectionDot` stable and in the four stripes; `stageFor` total. Regression e2e (desktop):
`library-mount`, `nfc-fob-button`, `library-a3`, `delete-disk`, `collections -g "remove"`.
Run: `pnpm test src/lib/library-look.test.ts`; tsc; lint; the five e2e runs above, one at a time.

### Task 2: The ⋯ title menu and the grid card

**Files:** new `src/components/library/title-menu.tsx` (spec §2: trigger `title-menu-<id>`, popup
`title-menu-panel`, items in board order with the kept ids, `which` state rendering the Task 1 dialogs outside the
popup, propagation stopped on popup and items, 44 px items below `sm`); `title-controls.tsx` (`TitleControls`
renders `TitleMenu`; `HistoryButton`/`RemoveFromCollectionButton` become menu items; `EmptyLibrary` untouched here);
`game-grid.tsx` (`CardBody` per spec §1.3: text block, footer with `grid-kind`, `grid-disks`, ⋯), `cover.tsx` (4 / 5
art box, `cover-disk` no-cover state with `DiskIcon` on `stageFor`, `drive-badge`; delete `gradientFor`/`hueFor`
once unused); `card-mount-button.tsx` (`DriveRing` radius follows the card); `src/lib/help/topics.tsx` (topic
`library` "Controls" paragraph + source comment, spec §2); `e2e/helpers.ts` (`openTitleMenu(page, gameId)`, click or
tap by `page.context()`'s `hasTouch`); the spec §7.4 menu-row specs, `library-covers.spec.ts`,
`library-type-column.spec.ts`.
**Tests:** unit — a `title-menu` render test (`renderToStaticMarkup` of the closed trigger: id, `aria-haspopup`,
`aria-label`); e2e (desktop): `library-mount`, `library-a3`, `library-table -g "card controls|fob|remove"`,
`nfc-fob-button`, `delete-disk`, `time-machine -g "history"`, `hd-disks`, `library-covers`, `library-type-column`,
`collections` (split with `-g` into two runs), `disk-sets -g "card"` and `disk-sets -g "set"` (two runs), plus one new
test in `library-a3.spec.ts`: clicking the ⋯ trigger and an item does not navigate and does not start a drag (URL
stays `/library`, card opacity stays 1). Mobile: `mobile.spec.ts -g "library grid|hold|tap"`.
Run: unit; tsc; lint; the e2e list, one at a time.

### Task 3: Library chrome — header, toolbar, rail, pager

**Files:** `src/components/shell/page-header.tsx` (`size` prop, spec §1.1); `src/app/(app)/library/page.tsx`
(heading by view, breadcrumb eyebrow inside a collection/All titles, action order, `md:w-60` row); `create-adf.tsx`
(trigger per spec §1.1, label `Create ADF`, panel/drawer tokens); `library-sort-picker.tsx`; `view-toggle.tsx` (SVG
glyphs) + `view-toggle.test.ts`; `src/components/collections/collection-rail.tsx` (spec §1.2: no card, caption, 38 px
rows, dots, `aria-current`, New collection input + `+`, hints); `library-pager.tsx` (spec §1.4); `topics.tsx` "New
disk" → "Create ADF"; `e2e/helpers.ts` / `delete-disk.spec.ts` / `mobile.spec.ts` comments naming "New disk".
**Tests:** unit `view-toggle.test.ts` (SVG child, classes); e2e (desktop): `collections` (two `-g` runs), `auth`,
`breadcrumb`, `library-paging`, `view-toggle`, `create-adf`, `drive-chips -g "pill|centre|390"` (the header shares the
page's first row), `contrast`. Mobile: `mobile.spec.ts -g "New disk|library|nav"`. Add one desktop e2e in
`collections.spec.ts`: the current rail row has `aria-current="page"` and the heading reads the collection's name.
Run: unit; tsc; lint; the e2e list, one at a time.

### Task 4: Table view

**Files:** `src/components/library/game-table.tsx` (spec §3: columns, header, up row, folder rows with
`collectionDot` folder glyph and `›`, title rows with 26 px `DiskIcon`, `drive-badge`, `--mounted-bg`, ⋯ in the last
column; delete `CoverThumb` from `cover.tsx` once unused); `src/lib/library-table.ts` only if a helper is needed for
the folder glyph colour (no behaviour change).
**Tests:** e2e (desktop): `library-table` (whole file), `library-paging -g "table|folders"`, `library-type-column -g
"table|dash|multi-disk"`, `view-toggle`. Mobile: `mobile.spec.ts -g "table"` (sideways scroll inside the card, no page
scroll). New desktop e2e in `library-table.spec.ts`: a confirmed title's row shows `drive-badge` `DF0` and the
compact `drive-ring`; a folder row's glyph is present and the row still opens the collection.
Run: tsc; lint; the e2e list, one at a time.

### Task 5: Title hero — header, pills, art, edit, identify

**Files:** `src/lib/queries.ts` (`GameDetail.kind` via the list's `kindFromSetName`/`pickKind`; db unit test if one
exists for `getGameDetail`, else extend the nearest `vitest.db` test); new `src/components/games/title-hero.tsx`
(spec §5.2: `title-hero`, `title-art` with `game-cover` or `DiskIcon`, `title-pills` and its five pills, the
`edit-details` trigger, `title-identify`); `src/app/(app)/games/[id]/page.tsx` (layout spec §5.1, breadcrumb on its
own line, no `PageHeader`, the rewritten kind comment); `game-facts.tsx` (no cover column); `demozoo-panel.tsx`
(split: unlinked branches render inside the identify box without their own card; linked branch stays full width);
`identify-search.tsx`, `demozoo-actions.tsx` (input/button sizes only); `edit-details.tsx` (trigger look; panel
restyle, spec §5.3); `cover-control.tsx` (under the art, ghost buttons).
**Tests:** unit — `title-hero` render test: pills show `Year —`/`Publisher —` when unknown, the kind pill only when
known, `game-cover` present only with a cover. e2e (desktop): `game-detail -g "route|organization|order"`,
`game-edit`, `breadcrumb`, `cover-override`, `openretro -g "cover|shift|description"`, `identify-search`, `demozoo`
(split by `-g` if > 9 min), `send-to-amiga -g "title|game"`. Mobile: `mobile.spec.ts -g "title|game|cover"` and
`cover-override.spec.ts -g "390"` on desktop (it sets its own viewport). New desktop e2e in `game-detail.spec.ts`: a
TOSEC-typed title shows `title-pill-kind` with its type and `title-pill-year` reads `Year —` for an undated title.
Run: unit; `pnpm test:db` for the query test; tsc; lint; the e2e list, one at a time.

### Task 6: Title disks and sets list

**Files:** `src/components/games/disk-row.tsx` (spec §6: `DiskIcon`, Boot and format pills with `disk-format-<id>`
and `hfe-tag-<id>`, file/meta lines, `data-mounted` + `--mounted-line`, button styles, order); `write-protect-toggle.tsx`
(switch, `aria-pressed`, labels; HFE locked variant carrying `hfe-readonly-<id>`); `mount-action.tsx` (styles and
icons only, words unchanged); `extract-action.tsx`, `send/send-button.tsx` (button style); `disk-set-section.tsx`,
`disk-set-menu.tsx` (heading line with `Disks`/set name, `SendBoardPicker` on that line, ⋯ look, reorder rows);
`src/app/(app)/games/[id]/page.tsx` (`section[aria-label=Disks]` wrapper).
**Tests:** e2e (desktop): `game-detail` (whole file), `mount-to-device`, `mount-actions`, `second-drive -g "title|
game|disk page"`, `write-protect-live`, `hfe-disks`, `hd-disks`, `delete-disk`, `next-disk -g "title|set"`,
`disk-sets` (two or three `-g` runs), `adf-download`, `send-to-amiga`. Mobile: `mobile.spec.ts -g "disk set|390"`.
New desktop e2e in `game-detail.spec.ts`: after the board confirms a disk, its row has `data-mounted="true"` and the
hero shows `title-pill-drive`.
Run: tsc; lint; the e2e list, one at a time.

### Task 7: States, help, and the e2e + screenshot sweep

**Files:** `title-controls.tsx` `EmptyLibrary` (spec §8 empty library and empty collection, `data-empty`) and
`empty-library.test.ts`; `game-grid.tsx` (pass the view so a collection gets the collection variant);
`src/app/(app)/library/loading.tsx` + `loading.test.ts` (rail `md:w-60`, 4 / 5 cards); new
`src/app/(app)/games/[id]/loading.tsx` (`title-skeleton`) + a `loading.test.ts` beside it;
`src/components/shell/state-card.tsx` (code line, look, `StateLink variant="button"`), `error-view.tsx` (code line
`Server error`), `(app)/not-found.tsx` (code `404`, words unchanged); `contrast.spec.ts` (spec §9 pairs on a seeded
library with a typed, a held and an untyped title); README screenshots via `pnpm screenshots`.
**Tests:** unit `empty-library.test.ts` (both variants: disk icon first, texts and link in order, `data-empty`),
`library/loading.test.ts`, `games/[id]/loading.test.ts` (hero-shaped skeleton, `title-skeleton`); e2e (desktop):
`library`, `states`, `contrast`, `shell`, `button-affordance`, `about-page`, `help -g "library"`, `search -g "title"`.
Mobile: `mobile.spec.ts` in three `-g` runs covering library, title and disk-set tests. Final regression of every spec
touched in Tasks 2–6, one run at a time, each under 9 minutes. Then `PORT=3100 pnpm screenshots` and compare
`docs/screenshots/library*.png` and `game.png` with the boards by eye; commit the regenerated PNGs by name.
Run: unit; tsc; lint; the e2e list; screenshots.
