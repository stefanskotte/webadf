# Files 2: Opus layout, LIBRARY: as the Library, Create ADF, one "Added"

Status: approved in conversation 2026-10-29 (operator), written for review. Builds on
`docs/superpowers/specs/2026-10-29-files-manager-design.md` (Files 1, shipped ef711fb); anything not changed here stays
as Files 1 says. Mock-up: `.superpowers/brainstorm/2848-1793305394/content/dopus-layout-v2.html`.

Remote browsing of the Amiga's own volumes (`NET:<board>/Work:…`) is **not** in this release; it is its own project
(firmware + Transfer + server), specced after this ships. Nothing here may make that harder: the device column lists
devices only, and NET: keeps its driver boundary.

## 1. Decisions (operator, 2026-10-29)

- D1 **Layout:** Directory Opus style. Two panes side by side separated by a plain line (no arrow, no button column).
  One grid of buttons under both panes, with a device column at its left listing **STASH: · LIBRARY: · NET:** only (no
  board volumes: those are dynamic and are reached by browsing inside a pane).
- D2 **Source and destination:** the active pane is the source, the other the destination. Every two-pane command
  (Copy, Move) goes source → destination, so buttons carry no arrows.
- D3 **LIBRARY: mirrors the Library page:** collections are folders; uncategorized titles sit at the top level.
- D4 **Filing by Move/Copy:** a title moved onto a collection folder leaves the collection it came from; copied, it is
  filed in that collection too. A title is never duplicated.
- D5 **Create ADF… in Files**, in the source pane, on LIBRARY: and STASH: only (never NET:).
- D6 **One "Added":** the Library tray shows a disk as Added whether or not the server already held its bytes.
- D7 Order: this web release first; remote volumes after.

## 2. Layout (desktop ≥ lg)

1. **Drop zones** stay on top, unchanged.
2. **Panes:** left and right, equal width, separated by a 1 px rule (the `--line` token). Each pane:
   - **Title bar:** the path (clickable parts, ↑ for Parent) and the meta (count, size, free space or retention). The
     **source** pane's title bar is dark (ink background, light text; the existing active tint is replaced); the
     destination's is the soft tint. The STASH:/NET:/LIBRARY: chips leave the pane header (the device column replaces
     them).
   - Disk strip, filter box, Show .info switch, columns, rows and foot: as Files 1.
   - Clicking anywhere in a pane (row, empty area, title bar) makes it the source. Tab still swaps source.
3. **Button bank** under both panes, full width:
   - **Device column** (left, ~120 px): STASH:, LIBRARY:, NET:. A click puts the **source** pane at that device's root.
     The device the source pane is on is shown pressed. Keyboard: in the tab order before the grid.
   - **Grid** (6 columns × 3 rows, equal cells), in this order:
     `All · Copy · Makedir · Create ADF… · Info · Download`
     `None · Move · Rename · Add to library · Protect · Filter…`
     `Parent · Root · Swap · Show .info · (empty) · Delete`
     Delete keeps the destructive colour. **Copy** and **Move** replace `Copy →`, `Move →` and `← Copy`.
     All/None pick every drawn row / none in the source. Parent = ↑; Root = the device root. Filter… focuses the source
     pane's filter box; Show .info toggles the source pane's switch.
   - A command that cannot apply is disabled with its reason as tooltip and `aria-disabled` reason text (as today's
     `reasons[cmd]`). Progress ("Copying 3 of 12…") shows on a one-line status row under the grid.
4. Keys are unchanged (F5 copy, F6 move, F7 makedir, F2 rename, Delete, Tab, Enter, Backspace, Space, `/`); F5/F6 go
   source → destination.

### 2.1 Tablet and phone (< lg)

- Below lg the panes stack as today (one pane shown, Left | Right switch; the pane shown is the source). The device column becomes three chips at the top
  of the shown pane. The grid becomes the existing bottom bar / sheet (Copy to… / Move to… pickers stay), with Create
  ADF… added to the sheet.
- 44 px targets below lg.

## 3. LIBRARY: as the Library (D3, D4)

### 3.1 Paths and listing

- `LIBRARY:` lists, in this order: the org's **collections as folders** (the Library's collection order, `sortKey`),
  then the **uncategorized titles** (titles in no collection), in the user's Library order.
- `LIBRARY:/<collectionId>` lists the titles filed there, in the collection's own order.
- `LIBRARY:/<collectionId>/<gameId>/<diskId>/…` and `LIBRARY:/<gameId>/<diskId>/…` both resolve; the first segment is a
  collection if it names one of the org's collections, otherwise a title. A title in two collections is listed in both.
- A path through a collection the title is not filed in is `not_found` (so a stale link never shows a title in the
  wrong place).
- **Entry points:** "Files…" on a disk opens `LIBRARY:/<collectionId>/<gameId>/<diskId>` with the title's first
  collection (in collection order), or `LIBRARY:/<gameId>/<diskId>` when it is uncategorized. Old links of the
  `LIBRARY:/<gameId>/<diskId>` form keep working even for a filed title (Parent from the title then goes to LIBRARY:).
- Collection folders show a folder row with the title count as size text ("12 titles"); protection/date columns blank.
- Shared/remote libraries stay out of scope.

### 3.2 Commands above disk level

| Command | Where | Effect |
|---|---|---|
| Makedir | `LIBRARY:` root | new collection (name rules as the Library's New collection) |
| Rename | a collection row | renames the collection |
| Delete | a collection row | deletes the collection; its titles stay in the library (uncategorized if in no other collection). Always asks. |
| Move | title(s) → a collection folder (or a pane inside one) | files them there and removes them from the collection they were listed under in the source (from none if the source was the root) |
| Copy | title(s) → a collection folder | files them there too; nothing is duplicated |
| Move | title(s) listed in a collection → `LIBRARY:` root | removes them from that collection |
| Copy | title(s) → `LIBRARY:` root | refused: "It is in the library already" (nothing to do) |
| Copy/Move | disk image(s) from STASH: → `LIBRARY:` root or a collection | Add to library, filed in that collection |
| Delete / Rename | a title or a disk row | not offered in Files (reason: "Rename or delete titles on the Library page"); as today |

- A title already in the target collection is skipped and reported "Skipped N (already there)."
- Filing never touches disks or history; it is the same membership change as the Library page's drag-to-collection
  (`collection_games`), through the same server functions, scoped by org.
- Drag and drop between panes follows the same table (drag copies, Shift-drop moves).

## 4. Create ADF… (D5)

- Button in the grid (and the phone sheet). Opens the existing small form (Size: 880 KB / 1.76 MB; Filesystem: FFS /
  OFS; reset each time it opens, as on the Library) plus a **Name** field (default "Untitled").
- Creates in the **source** pane:
  - **STASH:** `<Name>.adf` (a blank formatted image with that volume name) in the current folder; name clashes follow
    the Files clash setting.
  - **LIBRARY:** root → a new uncategorized title with one blank disk; inside a collection → the same, filed there.
    The pane reloads with the new title selected.
- Disabled (with reason) on NET: ("Disks are made in STASH: or LIBRARY:"), inside a title's disk list and inside a
  disk ("Go up to the library or a collection"), and inside an archive.
- Uses the existing blank-disk builder and Library create route; STASH: gets a server path that writes the blank image
  through the STASH: store (counts toward the 500 files / 256 MB).

## 5. One "Added" (D6)

- The Library tray's `deduped` rows read **Added** (same tone, same Open title). The tray summary counts them as added
  ("8 added"); "already in the library" disappears from the tray, its tests and help.
- No server change: dedupe still skips the upload; it is only faster.

## 6. Help and README

- `files` topic: the source/destination model, the device column, the grid, LIBRARY: collections as folders and
  filing by Move/Copy, Create ADF….
- Library help: the tray wording.
- README screenshots of Files and Adding disks regenerated after the release.

## 7. Errors

- Filing into a collection that was deleted meanwhile: `not_found`, nothing changed.
- Create ADF over the STASH: limits: refused with the limit named.
- A collection name clash on Makedir/Rename: `name_exists` with the Library's words.

## 8. Testing

- Unit: path resolution (collection vs title first segment; stale collection), listing order, the filing table,
  Create ADF placement and reasons, tray wording.
- DB: filing moves/copies membership only, org-scoped (a foreign collection id is `not_found`).
- e2e (desktop + mobile): source/destination switching by click and Tab; device column; grid commands; Move a title
  between collections and back to the root; Create ADF in STASH:, LIBRARY: root and a collection, refused on NET:;
  tray shows Added for a re-added disk; existing Files specs updated for the new selectors.

## 9. Out of scope

- Browsing the Amiga's volumes (next project, D7).
- Title/disk delete or rename in Files; nested collections.
