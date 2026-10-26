# WebFloppy library multi-select — design

Date: 2026-10-26. Roadmap backlog item "Library multi-select" (`2026-10-23-webfloppy-redesign-roadmap-design.md`,
operator 2026-10-25), placed by the operator right after Phase C, which finished 2026-10-26 (HANDOFF, C9).

The operator's requirement, which binds this spec:

- An icon at the top of the grid and table views turns on "multi operations".
- A checkbox then appears in each title's left corner, and the top bar expands to show the operations: **Move to
  collection** and **Delete**.
- Nothing changes until OK is pressed. Cancel leaves everything as it was.
- Bulk routes for move and delete are needed. Today both act on one title.
- The design is inferred from the current style and UX.
- The OK confirmation is an in-app dialog (the shared `Modal`, `.wf-modal`), never a browser `confirm()`.

Written under the operator's standing authorization for redesign-era design calls (2026-10-24). Every design call is
listed under **Rulings** at the end, each written as decision, then why, then the cost if wrong.

Measured against `e1cc582` (branch `feat/library-multi-select`) by reading the code. I made no screenshot capture: every
fact the design rests on is in the source cited.

## 0. What exists today (measured)

| Piece | Where | What it does |
|---|---|---|
| Library page | `src/app/(app)/library/page.tsx` | Server page. The view (`?collection=` / All titles / Uncategorized via `resolveLibraryView`), the grid/table choice (`?view=`), and paging (`?page=`, `prefs.library.pageSize`, default 48, `'all'` allowed). The header actions are `DemozooBadge`, `LibrarySortPicker` (not inside a collection), `CreateAdf` and `ViewToggle`. `CollectionsProvider` wraps the rail and the grid or table. |
| Grid | `src/components/library/game-grid.tsx` | `DraggableCard` (All titles and Uncategorized: drag a card onto the rail, or onto a card to make a disk set) and `SortableCard` (inside a collection: reorder). Each card is a `<Link>` to `/games/[id]`. `TitleControls` (the ⋯ menu, inline rename) sits inside the anchor and stops pointer events. |
| Table | `src/components/library/game-table.tsx` | `TitleRow` is a `<Link>` drawn as a grid, `COLS` 8 tracks from sm and 3 below sm (C7 Ruling 17). Rows are draggable onto the rail. `FolderRow` and `UpRow` are navigation rows. |
| Rail | `src/components/collections/collection-rail.tsx` | Uncategorized, the collections, then All titles. Collections are drop targets. Below md it is a chip row with no reordering (C7 Ruling 16). |
| ⋯ menu | `src/components/library/title-menu.tsx` | Mount/Eject, NFC, History, **Move to collection…**, Remove from collection (inside one), **Delete title**. The dialogs live outside the popup. |
| Single move | `move-to-collection.tsx` | The client calls `POST /api/collections/[id]/games {gameId}`, then (inside a collection) `DELETE /api/collections/[from]/games/[gameId]`. It adds first, so a failure between the two calls leaves the title in both collections, never in neither. From All titles or Uncategorized it only adds. Targets are every collection except the one you are in. |
| Single delete | `DELETE /api/games/[id]` → `deleteGame` in `src/lib/disk-delete.ts` | Org-scoped (a foreign id gets 404, never 403). It **ejects** every device whose `desiredDiskId` or `desiredSha256` names one of the title's disks (`clearDesired`, which bumps the version), plus DF1 picks (`ejectDf1Holders`). It deletes the disks explicitly, then the game. `collection_games`, `disk_versions` and `disk_write_sessions` cascade. It then releases the org's **entitlements** to shas that no surviving disk of the org and no `disk_versions` row still names. **It never deletes a blob**: the weekly GC (`blob-gc-run.ts`) reclaims bytes that nothing references. |
| Mounted rule | `src/lib/disk-holder.ts` (`findHolder`) | The operator's rule of 2026-09-18 is that the server never rewrites the *bytes* of a disk a board holds (mounted or desired), and the edit gets a 409 `mounted`. Delete is not covered: it ejects instead. |
| Drive holds | `src/lib/drive-holds.ts` (`holdsByGame`) | The rule the card ring uses. A converged board holds what it reports. A board with a request out (online or offline) holds what was asked for. An eject in flight holds nothing. |
| Membership | `src/db/schema/collections.ts` | `collection_games` is many-to-many with PK `(collection_id, game_id)` and no `org_id`. It is always scoped through `collections`. |
| Disk-files multi-select | `src/components/disks/selection-bar.tsx` + `POST /api/disks/[id]/files/bulk` | An ink bar `role="region"` with "n selected" and "(n not shown)". It has idle / move / delete modes, and Cancel puts focus back on the button that opened the step. The route body is a zod discriminated union on `op`, with ids `.min(1).max(1000)`, and it is all or nothing. It uses native `disabled`. The app's later rule (C5/C6) is `aria-disabled` plus a guard, which this spec follows. |

**Measured, and it shapes the selection design:** in this Next.js (16.3.2), changing only the search params does not
reset client state. `layout-router.js` keys the React tree by `createRouterCacheKey(segment, true)`, which is "no
search params", with the comment "search params do not cause state to be lost". So client state in the library page
survives `?page=`, `?view=`, `?collection=` and sort changes. It also survives Back, because recent segments are kept in a
hidden `<Activity>` (same file; `node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`). The selection is
therefore cleared **explicitly** when it must go (Ruling 4), never left to an unmount.

## 1. Interaction

### 1.1 Turning it on (Rulings 1, 2)

- **The icon.** It is a `.seg`-style icon button **`library-select-toggle`** in the page header's actions, directly
  before `ViewToggle`. It uses lucide `ListChecks`, 16 px, with `aria-label="Select titles"`, `aria-pressed` true or
  false, and the tooltip `title="Select titles"`. Its size matches `ViewToggle`: 44×44 below sm (the C7 `.seg-item` 44 px floor), 36×32 from sm. It
  appears only when the grid or table shows at least one title, so not on the empty states and not on the
  `CategoryOverview` fall-through.
- **Pressed on**, it does three things. The **selection bar** (§1.3) appears at the top of the grid or table column. A
  checkbox appears on every title on the page. The titles stop being links, drags and menus (§1.4). Focus moves to the
  bar's "Select all on this page" checkbox.
- **Pressed again**, it means Cancel (§1.6). `Escape` means Cancel too, when no dialog is open and focus is in the bar,
  the grid or the table.

### 1.2 Checkboxes (Ruling 3)

- **Grid.** The checkbox sits in the card's top-left corner, over the cover art's 8 px margin. The visible box is 22 px,
  on a `var(--surface)` disc with a `var(--line-strong)` ring. Checked, it is filled `var(--primary-action)` with a white
  check, and the card gets a 2 px `var(--primary-action)` outline and `data-selected="true"`. Both states are drawn: an
  unchecked title shows an empty box, never nothing.
- **Table.** While selecting, a leading 28 px track is added: `COLS_SELECT` is `[28px_40px_minmax(0,1fr)_44px]` below
  sm and `[28px_36px_minmax(0,1fr)_104px_56px_150px_52px_96px_44px]` from sm. The checkbox sits in that track. The
  DiskIcon and its ring stay where they are. The header row (from sm) carries the select-all checkbox in the same track.
  `FolderRow` and `UpRow` get an empty cell there and no checkbox: collections are not selectable here. The ⋯ track
  stays in the grid but is empty, so nothing shifts sideways.
- **Markup.** The checkbox is a real `<input type="checkbox">` with `aria-label={`Select ${titleLabel(g)}`}` and
  `data-testid="select-title"` (the card or row also carries `data-game-id`). While selecting, the card or row root is a
  `<label>` wrapping it, **not** a `<Link>`. Clicking anywhere on the card or row toggles it natively, and nothing
  interactive is nested inside an anchor or a label.

### 1.3 The selection bar (Rulings 2, 5, 6)

`div role="region" aria-label="Selected titles" data-testid="library-selection-bar"`. It is the ink bar from the disk
files (`background: var(--ink); color: var(--surface)`, 13 px, `px-4 py-2`, rounded 12 px, with the grid's or table's
horizontal margin `mx-4 sm:mx-7`). It is **sticky** (`sticky top-0 z-20`), so the operations stay in reach down a
48-title page. It sits above the grid or table and below the phone's collection chips. Its contents, left to right:

1. **Select all on this page**, an `<input type="checkbox">` with a visible label "All on this page"
   (`library-select-page`). It is checked when every title on the page is selected, `indeterminate` when some are, and
   it toggles exactly the titles on this page. If selecting the page would take the selection over 1,000 (Ruling 6),
   the checkbox is `aria-disabled` with `title="Up to 1,000 titles at a time"` and its handler does nothing.
2. **The count**, `span role="status" aria-live="polite" data-testid="library-selection-count"`. It says "No titles
   selected", "1 title selected" or "12 titles selected". When some selected titles are not on this page it adds
   " · 4 on other pages" (`library-selection-offpage`), in the same words the disk files use for "not shown", so a
   Delete never surprises.
3. **Move to collection…**, `library-bulk-move`, plain style (`--on-ink-fill`). It is `aria-disabled` with a `title`
   explaining why when nothing is selected, or when there is no collection to move to (§2.1).
4. **Delete…**, `library-bulk-delete`, danger style. It is `aria-disabled` when nothing is selected.
5. **Cancel**, `library-selection-cancel`, plain style. It is always available.

The buttons are 30 px tall from sm and 44 px below sm. The bar wraps: below sm the select-all and count sit on the first
line, and the three buttons fill the second line, `flex-1` each.

### 1.4 What a title does while selecting (Ruling 7)

- **Click or tap** on a card or row toggles its checkbox. It never navigates.
- **Drag is off**: `useDraggable` / `useSortable` get `disabled: selecting`, so there is no drag to the rail, no
  card-on-card disk set and no reorder inside a collection.
- **The ⋯ menu, inline rename, mount ring buttons and fob button are not rendered** (`TitleControls` gets
  `selecting`). The DF0 pill, the ring and `HoldsLabel` stay, because they are information.
- **The rail stays live.** Picking another collection, Uncategorized, All titles, a folder row or the up row is
  navigation, and it ends selecting (Ruling 4). Creating, renaming and reordering collections in the rail still work,
  and the Move dialog reads its target list from the same `CollectionsProvider` context, so it is current.
- **Header search, the drive menu and the tab bar** work as usual. Following any of them leaves the view (Ruling 4).

### 1.5 Scope of the selection (Rulings 4, 6)

- The selection belongs to **one view**: one collection, All titles, or Uncategorized. It lives in a new client
  provider, **`LibrarySelectionProvider`** (`src/components/library/selection-provider.tsx`). `page.tsx` mounts it
  around both the `PageHeader` and the `CollectionsProvider`, so the header toggle and the bar share it. It keeps
  `selecting: boolean` and `selected: Map<gameId, { title, year, diskCount }>` in insertion order, so the dialogs can
  name titles that are not on the current page.
- **Kept across:** paging (`?page=`), grid ↔ table, sort changes, and `router.refresh()` (LiveRefresh, or another
  tab's change).
- **Cleared, and selecting ends,** when the **view key** changes (`resolveLibraryView` → `uncategorized` | `all` |
  `collection:<id>`), when the pathname leaves `/library`, or when the page is hidden by Activity. The last case uses the
  `useLayoutEffect` cleanup pattern from Next's `preserving-ui-state.md`, so Back never revives an old selection. Nothing
  was changed, so dropping the selection is the same as Cancel. No prompt.
- **No "select all N in this view"** across pages (Not in this phase). Select-all covers the page. With page size
  `all`, the page is the view.
- A selected title that disappears (deleted in another tab, or moved out by LiveRefresh) stays in the selection until
  OK. The server reports it as `missing` (§3), and the toast says so.

### 1.6 Cancel and OK (Rulings 5, 8)

- **Nothing is sent while selecting.** Checking, unchecking, paging and opening a dialog make no request, except the
  read-only delete preview (§2.2), which changes nothing.
- **Cancel** (bar, toggle or Escape) sets `selecting = false` and clears the selection. No request is made, and the
  library is exactly as it was. Focus goes to `library-select-toggle`.
- **The OK** is the confirm button of the operation's `Modal`. It is labelled by the action ("Move 12 titles", "Delete
  12 titles"), as the app's other confirms are (Ruling 8). The dialog's own Cancel / close / Escape closes only the
  dialog, keeps the selection, and puts focus back on the bar button that opened it (the `Modal`'s default
  `finalFocus`).
- **After a successful OK:** selecting ends, the selection clears, a toast reports the result (§2.3), `router.refresh()`
  runs, and focus goes to `library-select-toggle`. If the toggle is gone (the view is now empty), focus goes to the
  page `h1` (`tabIndex={-1}`, the ring from C6 Ruling 5). Never `<body>`.

## 2. The operations

### 2.1 Move to collection (Rulings 9, 10, 11)

`Modal` `width={440}` `testId="bulk-move-dialog"` `closeTestId="bulk-move-close"`, titled **"Move to collection"**.

- **Subtitle.** Inside a collection: "12 titles leave *Shooters* and go into the collection you pick." In All titles or
  Uncategorized: "12 titles go into the collection you pick. Titles already in other collections stay there too." These
  are the single dialog's words, made plural.
- **Body.** A `role="radiogroup" aria-label="Collection"` list of the org's collections **except the one you are in**,
  each with its title count (as in `MoveToCollectionDialog`). One `role="radio"` row per collection, 44 px below sm.
  Nothing is preselected. **Uncategorized is not a target** (Ruling 10). With no other collection, the bar's Move… is
  already `aria-disabled` and titled "Make a collection first", so the dialog never opens empty.
- **Footer.** Cancel (`bulk-move-cancel`), then **"Move 12 titles"** (`bulk-move-confirm`, primary). It stays
  `aria-disabled` until a target is picked.
- **What OK does.** One `POST /api/games/bulk` `{ op: 'move', gameIds, to, from? }`. `from` is the collection you are in,
  and only inside one (§3.2). A title already in the target is fine: it simply ends up there (`alreadyThere`).
  Selections from a mixed source are fine too. In All titles a title may sit in any number of other collections, and as
  with the single move from All titles, it is added to the target and taken out of none.

### 2.2 Delete (Rulings 12, 13, 14)

`Modal` `width={440}` `testId="bulk-delete-dialog"` `closeTestId="bulk-delete-close"`, titled **"Delete titles?"**.

- **On open it previews.** `POST /api/games/bulk { op: 'delete', gameIds, dryRun: true }` changes nothing and returns
  what would go (§3.3). While it loads, the body shows "Checking the drives…" (`role="status"`) and the confirm is
  `aria-disabled`. If the preview fails, the body says "Could not check the drives." and offers a **Try again** button.
  The confirm stays `aria-disabled`. Nothing is deleted on a failed preview.
- **Body**, the single delete's words made plural:
  - "**12 titles** and their **19 disks** will be removed from your library." (the preview's counts, covering titles on
    other pages too)
  - A scrolling list (`max-h-[40vh]`, `data-testid="bulk-delete-list"`) of the titles, each with its year.
  - **Kept**, if any (`bulk-delete-kept`): "2 titles are in a drive and will be kept: *Turrican* — In A500 (DF0) ·
    *Lotus II* — In A500 (DF1)". Each line says where, with `holdLabel` wording, so the person knows what to eject.
  - The kept bullets: "The disk image itself is kept if anyone else has the same one." and "You can upload it again."
    The single dialog's "Any device holding it will be ejected" is **not** said, because held titles are kept (Ruling
    12).
- **Footer.** Cancel (`bulk-delete-cancel`), then **"Delete 10 titles"** (`bulk-delete-confirm`, danger), counting only
  the deletable ones. If every selected title is held, the confirm is `aria-disabled` and the body says "Nothing to
  delete: every selected title is in a drive. Eject it there first."
- **What OK does.** `POST /api/games/bulk { op: 'delete', gameIds }`, sending the titles the preview listed as
  deletable, not the whole selection. The server decides again at OK time (§3.3): a disk mounted since is still kept, and
  a title already gone is reported as such.
  *Controller amendment (Task 5 review): OK never deletes more than the dialog showed — a title shown as kept stays kept even if its drive empties before OK.*

### 2.3 Results and errors

| Outcome | Toast | Selection |
|---|---|---|
| Move 200 | "Moved 12 titles to *X*". It adds ", 3 were already there" when `alreadyThere > 0`, and ", 1 was already gone" for `missing`. | Ends (§1.6) |
| Delete 200 | "Deleted 10 titles". The description adds "Kept 2 that are in a drive: A, B." and/or "1 was already gone." and/or "Ejected from Y." for a late holder (§3.3). | Ends |
| 400 / 404 / 5xx | `toast.error("Could not move the titles" \| "Could not delete the titles", { description: "The server answered 404." })`. The dialog stays open so OK can be pressed again. | Kept |
| Network failure | `toast.error("Could not reach the server", { description: "Trying again is safe." })`. The dialog stays open. | Kept |

"Trying again is safe" is true because both operations are idempotent (Ruling 15).

### 2.4 Busy (Ruling 16)

Each dialog keeps `busy` in state plus a `useRef` guard. Confirm and Cancel are `aria-disabled={busy || undefined}`,
and their handlers return early while busy. Native `disabled` is never used. `Modal` gets `dismissible={!busy}`. Every
request sits in `try { … } catch { … } finally { setBusy(false); guard.current = false; }`. While a request runs, the
bar's buttons are `aria-disabled` as well. The confirm's label switches to "Moving…" / "Deleting…".

## 3. API: `POST /api/games/bulk` (Rulings 15, 17, 18, 19)

A new route, `src/app/api/games/bulk/route.ts`, with `export const maxDuration = 60`. It sits beside `games/[id]`: the
static segment wins, and `bulk` only defines POST. It has the same shape as `disks/[id]/files/bulk`.

### 3.1 Request

```ts
const gameIds = z.array(z.string().min(1).max(64)).min(1).max(1000);
const body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move'), gameIds, to: z.string().min(1), from: z.string().min(1).optional() }),
  z.object({ op: z.literal('delete'), gameIds, dryRun: z.boolean().optional() }),
]);
```

- **Auth.** `requireOrg()` at the top, as every org route does. The org comes from the session, never from the body.
- **Validation.** A body that is not JSON gets 400 `invalid_json`. A body that fails the schema, including more than
  1,000 ids, gets 400 `invalid_body` with `z.flattenError`. Duplicate ids are deduplicated server-side, keeping first
  order.
- **Org scoping on every id.** The games are read with a **single** `inArray(games.id, ids) AND games.org_id = orgId`.
  An id not returned is **missing**, whether it is absent or another tenant's, and is reported the same way in both
  cases. Missing ids are never written to. `to` and `from` are each proven with `orgFilter(collections, orgId, eq(id))`.
  Either failing means **404 `not_found`** for the whole request, with nothing written. `to === from` gets 400
  `same_collection`.

### 3.2 Move: `moveGamesToCollection(orgId, ids, to, from?)` in `src/lib/collections.ts`

All or nothing, in **one transaction** (`atomic`):

1. `INSERT INTO collection_games (collection_id, game_id, sort_key)` for the owned ids, in request order, with
   `sort_key = max(sort_key in to) + 1 + i`, `ON CONFLICT DO NOTHING` (the composite PK), `RETURNING game_id`. What comes
   back was added. The other owned ids were `alreadyThere`.
2. If `from` is given: `DELETE FROM collection_games WHERE collection_id = from AND game_id IN (owned ids)`.

The response is `200 { added: n, alreadyThere: n, removedFrom: n, missing: string[] }`. Running it twice gives the
same end state (Ruling 15). It makes 4 statements whatever the count.

### 3.3 Delete: `deleteGames(orgId, ids, { dryRun, now })` in `src/lib/disk-delete.ts`

1. **Read** the owned games (§3.1), their disks (`disks.game_id IN owned AND disks.org_id = orgId`), the org's devices
   (the `HoldDeviceRow` fields plus `df1DiskId`, `df1Sha256`), and the open write sessions on those disks
   (`disk_write_sessions.disk_id IN diskIds`).
2. **Plan** with a pure function, `planBulkDelete(games, disks, devices, sessions, now)` in
   `src/lib/bulk-delete-plan.ts`, which is unit-tested. A title is **held**, and therefore **kept**, when any of its disks
   is one of these:
   - in DF0 by the card's own rule (`holdsByGame`: mounted, fetching or requested);
   - DF1's pick (`df1DiskId`), or DF1's reported content (`df1Sha256` equal to one of its disks' sha);
   - the disk of an open `disk_write_sessions` row (a board writing).

   Each kept title carries `{ id, title, holds: [{ deviceName, drive: 'DF0' | 'DF1', label }] }`. The label is
   `holdLabel` wording, "Writing on A500" for a session.
3. **`dryRun: true`** returns the plan and writes nothing:
   `200 { deletable: { titles, disks }, titles: [{ id, title, year }], kept: [...], missing: [...] }`.
4. **Otherwise**, the late-holder safety net runs first. It is the same `ejectHolders(orgId, deletableDiskIds,
   deletableShas)` that single delete runs, and it normally does nothing because the held titles were already taken
   out. It covers only a mount that lands between step 1 and step 5. Then, in **one transaction**:
   `DELETE FROM disks WHERE game_id IN deletable AND org_id = orgId`, then
   `DELETE FROM games WHERE id IN deletable AND org_id = orgId AND NOT EXISTS (select 1 from disks d where d.game_id =
   games.id)`. That is deleteGame's own drift guard on `disks.org_id` (D-5-5), set-wise.
   `collection_games`, `disk_versions` and `disk_write_sessions` cascade, as they do for a single delete.
5. **After the commit**, `releaseEntitlements(orgId, allDeletedShas)` runs **once over the union**. A sha shared by two
   deleted titles is released once. A sha still used by a surviving disk, or named by a surviving `disk_versions` row,
   is kept. This is the existing function, unchanged.
6. The response is `200 { deleted: string[], diskIds: string[], kept: [...], missing: string[], ejected: string[],
   releasedSha256: string[] }`.

**Atomicity.** The deletable set is deleted all or nothing. The late-holder ejects (step 4) run BEFORE the transaction and are not rolled back if it fails; single delete behaves the same. A title the drift guard keeps is reported under `kept` with empty `holds`. Kept and missing titles are reported and never fail the
request (Ruling 13). A crash after the commit but before step 5 leaves entitlements for bytes the org no longer has a
disk for. They are harmless: the org has nothing to reach them through. The next single or bulk delete of the same sha
does not see them, and the blob GC keeps those bytes for as long as the entitlement exists. This is the same exposure
single delete has today. It is recorded, not fixed here.

**Blob GC.** No new column names a sha, so `readReferences` in `blob-gc-run.ts` needs no change. The rule "a new column
naming a blob sha must join runBlobGc's reference list" is not triggered. Blobs are never deleted by this route (the
standing rule in `disk-delete.ts`).

**Cost.** About 9 statements whatever the count, plus one `clearDesired` per late holder (normally zero). That is well
inside `maxDuration` at 1,000 ids.

### 3.4 Codes

| Status | When |
|---|---|
| 200 | Move or delete done, or the delete preview. `missing` / `kept` may be non-empty. |
| 400 | `invalid_json`, `invalid_body` (including more than 1,000 ids, an empty list, an unknown `op`), `same_collection` |
| 404 | `to` or `from` is not this org's collection (move only). Deleting never 404s: an unknown id is `missing`. |
| 401 / redirect | `requireOrg`, as every org route |

## 4. States

| State | What shows |
|---|---|
| Not selecting | Today's library, plus the toggle, `aria-pressed="false"`. |
| Selecting, 0 selected | The bar: "No titles selected". Move… and Delete… are `aria-disabled` with `title="Select titles first"`. Empty checkboxes on every title. |
| Selecting, n selected | The count. Checked cards and rows have an outline. " · k on other pages" when some are off the page. |
| Selection cap reached | Unchecked boxes are `aria-disabled`, `title="Up to 1,000 titles at a time"`. The page select-all is likewise. |
| Move dialog, no target picked | Confirm `aria-disabled`. |
| Delete preview loading / failed / all held | See §2.2. |
| Busy | §2.4. |
| Empty view | No toggle. The view's empty state as today. |
| Overview fall-through (empty inbox, grid) | No toggle. The collections overview has no titles to select. |

## 5. Accessibility

- The checkboxes are real inputs with names ("Select Turrican (1990)"). While selecting, the card or row is a `<label>`,
  so the whole target toggles and the name is announced once.
- **Keyboard.** Tab reaches the bar's controls, then each title's checkbox in page order. Space toggles. Escape cancels
  (§1.1). The toggle is `aria-pressed`. The roving or arrow-key grid is not built (Not in this phase).
- **Live region.** The count `span` is `role="status"` (polite). It updates on every toggle, select-all and clear. The
  delete preview's loading line is its own `role="status"`.
- **Focus.** Toggle on puts focus on the page select-all. Bar Cancel puts focus on the toggle. Dialog Cancel or close
  puts focus back on the opener. A successful OK puts focus on the toggle, or the `h1` if the toggle is gone. Never
  `<body>` (§1.6).
- **Contrast.** The bar reuses the files bar's measured pairs (`--surface` on `--ink`, `--on-ink-fill`, `--danger-fg`).
  The checkbox ring and the selected outline are added to `contrast.spec.ts` (3:1 non-text against `--surface` and the
  cover art's margin).
- No `sr-only` element carries a layout utility (the C4 `w-full` lesson).

## 6. Phone (390) and tablet (Ruling 20)

- **Below sm (390).** The toggle is 44×44 in the header's wrapping actions. The bar is sticky at top, two lines (§1.3),
  with 44 px buttons. Grid cards keep two columns, and the checkbox sits in the cover corner with the whole card as the
  hit area. Table rows are `[28px 40px 1fr 44px]`, and the fact line stays. The `Modal` is full screen below sm (as
  shipped). The toast sits above the tab bar (C7).
- **sm to md.** The collection chips row sits above the bar (the page's stacked column). One-line bar.
- **md to lg.** The rail is beside the content column, and the bar spans only the content column. The bottom tab bar
  still shows (below lg), and nothing in the bar is fixed at the bottom, so the two never collide.
- **Touch.** A tap toggles. Drag is off while selecting, so the 250 ms TouchSensor never fires, and a long press does
  nothing.

## 7. Self-host parity

There is no new dependency, external URL, env var or cron. The route uses `requireOrg`, `atomic` and drizzle exactly as
the existing routes do, on both the Vercel/Neon and Docker/Postgres drivers. The delete keeps the self-host-safe "never
delete a blob" rule. The help text (`src/lib/help/topics.tsx`, topic `library`) gains one paragraph on selecting titles,
so it changes with the behaviour (the context-help rule).

## 8. Testing

**Unit (vitest, pure).**
- `selection-provider` reducer: toggle, page select-all (and its indeterminate state), the 1,000 cap, clear on a
  view-key change, kept on page / view-mode / sort changes, off-page count.
- `planBulkDelete`: held via DF0 mounted, fetching and requested; not held for an eject in flight; held via DF1 pick and
  via `df1Sha256`; held via an open write session; a multi-disk title held by one disk is kept whole; missing ids.
- Dialog wording helpers (plural forms, `holdLabel` reuse).

**DB (`*.db.test.ts`, `TEST_DATABASE_URL`).**
- `moveGamesToCollection`: add from All titles, the move out of `from`, `alreadyThere`, sort keys appended in request
  order, **another org's game id is reported missing and never inserted**, another org's `to` / `from` gives null (404)
  with nothing written, running it twice gives the same state, rollback on a failure mid-transaction.
- `deleteGames`: titles, disks, history, write sessions and memberships gone. **Another org's id is untouched and
  reported missing.** A sha shared by two deleted titles has its entitlement released once. A sha shared with a
  surviving disk keeps its entitlement. A sha named only by a surviving disk's `disk_versions` keeps its entitlement.
  Held titles kept, with their holds. `dryRun` writes nothing. A late holder is ejected and named. No `blobs` row is
  ever deleted.

**Route (`route.test.ts`, mocked lib as the files bulk route does).** 400s for JSON, schema, more than 1,000 ids and
`same_collection`. 404 for a foreign collection. The org comes from `requireOrg`, never from the body.

**e2e (Playwright, PORT=3100, one run at a time, in the foreground, under 9 minutes, `helpers.ts` teardown, live DB).**
A new `e2e/library-multi-select.spec.ts`, plus `.mobile.spec.ts` for 390.
1. Toggle on, check two cards, then Cancel: no request to `/api/games/bulk` is observed (`page.on('request')`), both
   titles are unchanged, and focus is on the toggle.
2. Grid, Move: two titles from Uncategorized into a collection. They leave Uncategorized and appear in the collection,
   with the rail counts updated.
3. Inside a collection, Move to another: they leave the source.
4. Table, Delete: two titles. The preview counts, OK, and the rows are gone. Focus is on the toggle.
5. Selection survives `?page=2` and the grid ↔ table switch. It clears on a rail collection change and on Back after
   visiting a title.
6. While selecting, a card click does not navigate, and dragging a card to the rail does not file it.
7. Keyboard only: Tab to a checkbox, Space, then the bar's Delete…, then Escape (the dialog closes and focus returns to
   Delete…).
8. Mobile 390: the bar on two lines, no horizontal scroll, 44 px targets, a full-screen dialog.

Held-title kept and DF1/write-session cases are covered at the DB/unit level. A board-holding e2e may reuse
`device-helpers.ts` (simulated device status) if it is cheap. Bench work is not needed: nothing here touches firmware
or the board protocol.

**Lint and types.** `pnpm lint` and `tsc` are clean. No `react-hooks/set-state-in-effect`: the view-key clear is done in
render via a "previous key" state compare, or in the event that navigates. It is never a `useEffect` that sets state.

## 9. Test ids

**New:** `library-select-toggle`, `library-selection-bar`, `library-select-page`, `library-selection-count`,
`library-selection-offpage`, `library-bulk-move`, `library-bulk-delete`, `library-selection-cancel`, `select-title`,
`bulk-move-dialog`, `bulk-move-close`, `bulk-move-cancel`, `bulk-move-confirm`, `bulk-delete-dialog`,
`bulk-delete-close`, `bulk-delete-cancel`, `bulk-delete-confirm`, `bulk-delete-list`, `bulk-delete-kept`.

**Kept:** `game-card`, `game-row`, `game-grid` and `game-table` keep their names and elements while **not** selecting.
While selecting, `game-card` / `game-row` sit on the `<label>` root, and `data-selected` is added. Specs that click a
card to navigate never turn selecting on, so no existing spec changes.

## 10. Migration

**None.** No table, column or index is added. The bulk paths use `collection_games`' PK, the existing indexes
(`collection_games_game_idx`, `disks.game_id`) and the existing cascades.

## 11. Not in this phase

- "Select all N in this view" across pages, or a server-side selection by filter.
- Shift-click range selection, and arrow-key navigation of the grid.
- **Remove from this collection** as a bulk operation, or Uncategorized as a move target (Ruling 10).
- Other bulk operations: download a .zip of titles, set kind, Demozoo identify, make a disk set from the selection, NFC.
- **Eject and delete** for held titles (Ruling 12, and the operator question below).
- Selecting collections (folder rows, rail rows).
- Undo after a bulk delete. The bytes are re-uploadable, as the single dialog says. Disk history goes with the disk, as
  it does today.
- Changing single delete's eject behaviour.

## 12. Suggested task split

1. `planBulkDelete` + `deleteGames` + `moveGamesToCollection`, with unit and DB tests.
2. `POST /api/games/bulk` + route tests.
3. `LibrarySelectionProvider`, the toggle and the bar (grid and table), with drag, ⋯ and link off while selecting.
4. The Move and Delete dialogs on `Modal`, with toasts, busy and focus.
5. The help topic paragraph, contrast pairs, and the e2e desktop + mobile specs.
6. A whole-branch review (the drag-and-drop lesson: per-task reviews missed Criticals only the whole-branch pass saw).

## Rulings (operator to review)

1. **The icon lives in the page header's actions, directly before the Grid/Table toggle.** — That is the top of both
   views today, and the toggle the operator's "icon at the top of the grid and table" sits beside. A separate toolbar
   row for one icon would cost a row on every library visit. — Cost if wrong: the button moves into a new row above the
   list, which is markup only.
2. **"The top bar expands" is a sticky ink selection bar at the top of the grid/table column, not a change to the page
   header.** — The header is not sticky, so its operations would scroll away down a 48-title page. The ink bar is the
   app's existing multi-select look (disk files, A5), so the two read as one feature. — Cost if wrong: the bar's
   contents move into the header actions, and the stickiness is lost.
3. **The checkbox is in the cover's top-left corner on cards, and in a new leading 28 px track in the table. While
   selecting, the card or row becomes a `<label>`.** — It matches "left corner". The table track keeps the drive icon
   and ring visible. A `<label>` makes the whole target toggle without nesting an input in an anchor. — Cost if wrong:
   the table's columns shift by 28 px while selecting. A checkbox over the icon instead would hide the drive ring.
4. **A selection belongs to one view. It survives paging, grid/table and sort, and it is cleared explicitly on a view
   change, on leaving `/library`, and when Activity hides the page.** — Measured: search-param navigation and Back keep
   client state in this Next.js, so nothing would clear it otherwise. A "move" means leaving the collection you stand
   in, which is only defined within one view. Paging must not lose a 30-title selection. — Cost if wrong: someone who
   expected to gather titles across collections must do it one collection at a time.
5. **Nothing is sent until the dialog's confirm. Cancel (bar, toggle, Escape) only clears client state.** — This is the
   operator's rule taken literally. The only request before OK is the read-only delete preview. — Cost if wrong: none.
6. **Select-all covers the current page only, with a cap of 1,000 titles per selection, the same as the disk files'
   bulk route.** — It is predictable and visible: you see what you select. 1,000 keeps one request well inside 60 s.
   With page size "All" the page is the view. — Cost if wrong: emptying a 3,000-title inbox takes three passes, or
   "select all in view" is added later (§11).
7. **While selecting, a click toggles, drag is disabled, and the ⋯ menu, rename, mount and fob controls are hidden.
   The rail stays usable, and navigating ends the selection.** — One meaning per click. No accidental filing or disk
   set halfway through a selection. Hidden rather than inert, so nothing interactive sits inside the `<label>`. — Cost
   if wrong: someone who wants to mount a title mid-selection must Cancel first.
8. *(Operator-confirmed 2026-10-26.)* **The OK is the dialog's confirm button, labelled by the action ("Move 12 titles", "Delete 12 titles"), not the
   literal word "OK".** — Every confirm in the app names its action (the single Delete dialog, Promote, user delete),
   and a count on the button is the last check before a bulk change. — Cost if wrong: two strings change to "OK".
9. **One dialog both picks the target collection and confirms the move.** — It is the single move's dialog made plural,
   so picking and OK are on one screen and Cancel there changes nothing. — Cost if wrong: a two-step bar flow (a
   select in the bar, then a confirm) like the disk files' Move to….
10. **Uncategorized is not a move target, and bulk "Remove from collection" is not built.** — The operator named two
    operations. "Move to Uncategorized" from a collection would only remove the title from that one collection, and it
    would stay in its others, so the name would lie. — Cost if wrong: emptying a collection back into the inbox is still
    one title at a time (the ⋯ Remove from collection). Adding it later means one more `op` and one more bar button.
11. **Move semantics match the single move exactly. Inside a collection it adds to the target and removes from this one.
    From All titles or Uncategorized it only adds. A title already in the target is a quiet no-op, counted. A
    mixed-source selection is fine.** — `collection_games` is many-to-many, and the single dialog already defines
    "move". The bulk version must not invent a stronger "leave every other collection". — Cost if wrong: someone
    expecting "only in X afterwards" finds the title still in its other collections.
12. *(Operator-confirmed 2026-10-26.)* **A bulk delete KEEPS titles a board holds (DF0 mounted, fetching or requested, DF1 pick or content, or an open
    write session) and reports them. It does not eject them, unlike the single delete.** — A sweep over dozens of
    titles at a glance must not eject a running Amiga's disk as a side effect. The task's "never delete a disk a board
    has mounted or is writing" is applied here. The preview names each kept title's drive, so the person knows what to
    eject. Single delete is unchanged (it names the eject on its own dialog). — Cost if wrong: the two deletes behave
    differently. If the operator prefers eject-and-delete for bulk too, `planBulkDelete`'s kept list becomes an eject
    list and the dialog gains the "will be ejected" line. **Flagged as an operator question.**
    *Controller amendment (Task 1 review): the disk a board reports mounted in DF0 holds in every state, alongside a requested or fetching one — a stale or offline board still has it in the drive.* DF1's pick and its reported content hold separately.
13. **The deletable set is deleted all or nothing in one transaction. Held and missing titles never fail the request:
    they are reported.** — "Nothing changes until OK" means OK must do what the preview showed, and a single
    held-in-the-meantime title should not void the other 40. — Cost if wrong: if "all or nothing including held" is
    wanted, a held title at OK time becomes a 409 for the whole request.
14. **The delete dialog previews through the same route (`dryRun: true`), and the server re-decides at OK.** — Off-page
    titles have no disk counts or drive holds on the client. The preview gives exact numbers for the whole selection,
    and re-deciding at OK keeps a stale preview from deleting a newly mounted disk. — Cost if wrong: one extra request
    per dialog open.
15. **Both operations are idempotent by construction. There is no idempotency key.** — Move's `ON CONFLICT DO NOTHING`
    and set-delete, and delete's "unknown id is missing, 200". A retry after a dropped connection lands in the same end
    state, which is what lets the error toast say "Trying again is safe". — Cost if wrong: none found. A key would only
    matter for a non-idempotent op added later.
16. **Busy uses `aria-disabled` plus a ref guard, `Modal dismissible={!busy}`, and try/catch/finally on every
    request.** — The C5/C6 convention. The disk files bar's native `disabled` is older and is not copied. — Cost if
    wrong: none.
17. **One route, `POST /api/games/bulk`, with a zod union on `op`, rather than one route per operation.** — It mirrors
    the shipped `disks/[id]/files/bulk`. Move and delete share the id list, its cap and its org check. — Cost if wrong:
    a later split into `/api/collections/[id]/games/bulk` is a rename.
18. **Every id is org-checked in one `inArray … AND org_id = orgId` read. Foreign and absent ids are both "missing",
    with 200 for delete. A foreign `to`/`from` collection is 404 for the whole move.** — The 404-never-403
    non-disclosure rule. Reporting `missing` reveals nothing, because absent and foreign look identical. A wrong target
    must not half-apply. — Cost if wrong: none for disclosure. A client bug sending stale ids is reported, not hidden.
19. **The bulk delete reuses `ejectHolders` (as a late-holder safety net only) and `releaseEntitlements` once over the
    union of shas, and never deletes a blob. No sha column is added, so the blob GC's reference list is unchanged.** —
    It reuses the tested single-delete pieces. The union release is what makes two deleted titles sharing bytes
    correct. — Cost if wrong: a crash between commit and release leaves orphan entitlements, the same exposure single
    delete has today (§3.3).
20. **Phone and tablet keep the bar at the top (sticky), never as a bottom sheet. Two lines below sm, 44 px targets,
    full-screen dialogs.** — The operator said "top bar". Below lg the bottom is the tab bar's (C7), and toasts already
    sit above it. — Cost if wrong: a thumb reach to the top on a tall phone. A bottom placement would need to stack
    above the tab bar.

## Operator questions (decided provisionally above)

- **Ruling 12: should a bulk delete keep held titles (as specified) or eject and delete them, as the single delete
  does?** I chose to keep them because the task says never to delete a mounted or written disk, and because a sweep
  should not eject a running Amiga. The single delete still ejects. Say if the two should match, and which way.
- **Ruling 8: the confirm reads "Move 12 titles" / "Delete 12 titles" rather than the literal "OK".** Say if you want
  the word OK.
