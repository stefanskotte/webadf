# Files: a two-pane file manager (design)

Date: 2026-10-29. Status: approved in brainstorming with the operator (mock-ups in
`.superpowers/brainstorm/16846-1793227722/content/`: `files-page-layout.html` variant A, `files-from-disk.html`).

## 1. Goal

One place for every file that is not a whole disk: loose files from the PC, files to and from the Amiga over PaulaNET,
and the files on library disks. Directory Opus's method (two panes, a button column between them, copy from the active
pane to the other), in WebFloppy's current look.

It serves two kinds of user at once:

- **Novice:** adds disks on the Library page (drop or URL) and sends a file to the Amiga from one drop zone. Never needs
  the panes.
- **Advanced:** edits disks, moves files between disks, the Amiga and STASH:, with keyboard shortcuts.

It replaces the Upload page (`/ingest`, its Staging list) and the disk Browse page (`/disks/<id>/files`).

## 2. Decisions (operator, 2026-10-28/29)

| # | Decision |
|---|----------|
| D1 | Three pseudo devices: **STASH:**, **NET:**, **LIBRARY:**. |
| D2 | NET:/<board> shows the board's send queue now; designed so a live listing of the Amiga's own volumes can be added later as another driver ("queue now, live later"). |
| D3 | Files the Amiga sends up land in **STASH:** (marked with the board). STASH: = in, NET: = out. |
| D4 | Library disks are reached through **LIBRARY:** → title → disk → the disk's folders. |
| D5 | One **Files** page replaces Upload; a disk's "Browse…" becomes **"Files…"**, opening STASH: left and that disk's root right. |
| D6 | Layout **A**: two panes with a button column between them. |
| D7 | Adding disks moves to the **Library page** (drop anywhere, Add disks ▾ → Browse… / Paste URL, a results tray). The Files page's drops go to STASH: (left drop zone) or straight to the Amiga (right drop zone). |
| D8 | An archive (.lha/.zip) in STASH: stays one file; **Open** browses it as a read-only folder. |
| D9 | Server-side volume layer (one list API, one operations API); copies run on the server. |
| D10 | Protection bits shown and editable (as Browse today); sortable column headers, ascending/descending. |
| D11 | Per-user Files settings and help topics, as with other features. |

## 3. Paths and the volume layer

### 3.1 Paths

A path is `<DEVICE>:` followed by `/`-separated segments.

- `STASH:` and `STASH:/Mods/enigma.mod`
- `STASH:/SysInfo4.4.lha/SysInfo/SysInfo` (inside an archive, read-only)
- `NET:` (the boards) and `NET:/<deviceId>` (one board's queue)
- `LIBRARY:` (titles), `LIBRARY:/<titleId>` (its disks), `LIBRARY:/<titleId>/<diskId>/C/Assign`

Titles, disks and boards are addressed by **id**, so two titles with the same name never collide. Names are what the
pane shows (`LIBRARY:/SysInfo/Disk 1/C`). A path string is parsed and validated by one pure module
(`src/lib/files/path.ts`) used by client and server alike.

### 3.2 Drivers

One driver per device, each implementing:

```ts
interface VolumeDriver {
  list(ctx, path): Promise<Listing>;              // entries + where-am-I info (free space, read-only reason, …)
  read(ctx, path): Promise<FileBytes>;            // a file's bytes + meta (date, protection, comment)
  write?(ctx, dir, files: IncomingFile[], onClash): Promise<WriteOutcome[]>;   // absent = read-only device
  remove?(ctx, paths): Promise<Outcome[]>;
  makedir?(ctx, dir, name): Promise<Outcome>;
  rename?(ctx, path, newName): Promise<Outcome>;
  setMeta?(ctx, paths, { protection?, comment? }): Promise<Outcome[]>;
}
```

`ctx` carries the org and user. Every driver checks that the org owns what the path names (a foreign id is "not found").

An entry: `{ name, kind: 'dir'|'file'|'archive'|'disk'|'title'|'board', size?, date?, protection?, comment?, marks? }`.
`marks` carry extras: "from A500 bench", "dropped", transfer status, "in DF0: of …".

### 3.3 API

- `GET /api/files/list?path=…` → the listing.
- `POST /api/files/ops` with `{ op: 'copy'|'move'|'delete'|'makedir'|'rename'|'protect'|'comment', sources: string[], dest?: string, name?: string, protection?: number, comment?: string, onClash?: 'ask'|'replace'|'skip'|'keep-both' }`.
  - Copy/move with `onClash: 'ask'` and a clash returns `409 { clashes: [...] }` without writing anything; the client
    asks (Replace / Skip / Keep both, "for all") and resends with a choice.
  - The answer lists one outcome per source: done, or refused with a reason code and words.
- `GET /api/files/download?path=…` (one file) and `?paths=…` (several, as .zip).

All three go through `requireOrg()`. No new auth.

## 4. The devices

### 4.1 LIBRARY:

- `LIBRARY:` lists the org's titles (local titles only; remote/shared libraries are out of scope). `LIBRARY:/<title>`
  lists its disks, always as "Disk N" (or the disk's label), even for one-disk titles.
- Inside a disk: the existing ADF filesystem code (`src/lib/adffs/*`).
- **Writes go through `applyDiskEdit` / `applyBatch`** (`src/lib/disk-write.ts`): one operation = **one new history
  version per disk it touches**, however many files it carries.
- **Copies keep date, protection and comment.** `src/lib/adffs/write.ts` gains date and comment on `addFile`,
  `makeDirectory` and `BatchOp` (today only protection travels), plus a `setComment`.
- **A disk a board has mounted or wants** (`findHolder`) is read-only: listing and copying out work; any write is refused
  with the holder named and the pane offers **Eject**.
- A disk with no filesystem lists as empty and read-only ("No AmigaDOS filesystem"). HFE disks are read-only (as all HFE
  is write-protected) and keep **Extract to ADF**.
- Free space is checked before writing; a copy that does not fit is refused whole for that disk ("needs 54 KB, 23 KB
  free").
- AmigaDOS names: at most 30 characters, no `:` or `/`; a refused name is reported per file.

### 4.2 STASH:

- **Storage:** the existing `amiga_uploads` table becomes STASH:'s store (one migration):
  - add `source` (`'amiga' | 'browser' | 'copy'`); existing rows are `'amiga'`;
  - `deviceId`/`deviceName` stay (null for browser/copy);
  - `path` already holds folders; `protection`, `comment`, `amigaDate` already exist.
  - Code may rename the module (`src/lib/stash.ts`) while keeping the table name.
- **Belongs to the org**, like Amiga uploads today.
- **Limits:** 4 MB per file from the Amiga (firmware, unchanged); 20 MB per file for browser drops and URLs (same as
  today's URL fetch); 500 files / 256 MB per org in total; files kept 30 days (unchanged). Empty folders count as entries.
- **Archives:** an .lha / .zip entry has kind `archive`. Opening it lists its contents read-only on the server with the
  existing bounded readers (`src/lib/archive/*`, bomb caps). Copying out of an archive copies the extracted files with
  the dates/protection the archive records.
- **Disk images in STASH:** keep **Add to library** (as Amiga uploads have today).
- **Writable:** copy in, makedir, rename, delete, protection, comment.

### 4.3 NET:

- `NET:` lists the org's boards that can receive (firmware ≥ 1.15.0, `listSendTargets`). Boards below that are not
  listed.
- `NET:/<board>` lists that board's queue (`transfers`): each entry with status (queued, sending, delivered, failed,
  cancelled, expired) as a mark.
- **Copy into NET:/<board> = Send to Amiga:** files and folders queue with their relative paths, protection and comment.
  Existing limits apply (4 MB per file; 32 files / 16 MB per queue).
- **Delete** on a queued entry cancels it; on a finished entry clears it.
- **Copy out of NET:** not offered.
- **Later:** a live Amiga listing becomes `NET:/<board>/<volume>:` entries from a new driver; nothing in the panes changes.

## 5. The Files page

### 5.1 Layout (desktop, mock-up A)

Top nav: Upload becomes **Files** (route `/files`). Page header "Files" (eyebrow "Move files").

1. **Two drop zones:**
   - **Drop files into STASH:**: any file, folder, .lha or .zip; Browse files / Paste URL.
   - **Send files to the Amiga**: board picker; a drop queues straight into `NET:/<board>`.
2. **The manager:** left pane · button column · right pane.
   - **Pane header:** device buttons (STASH: / NET: / LIBRARY:), ↑, a clickable path, a meta line (count, size, free
     space or retention).
   - **Disk strip** (when a pane is inside a disk): disk icon and name, drive state (Not in a drive / In DF0: of …),
     used/free bar, **Mount ▾** (or **Eject to edit**), **History · vN** (opens the history as a side panel over that
     pane: versions, restore, as on Browse today), **⬇ ADF**, and the volume-name edit.
   - **Columns:** Name · Size · Protection · Date; Comment optional. Click a header to sort, again to reverse (▲/▼).
     Folders first. The sort is remembered per user and per device.
   - **Button column:** Copy → · Move → · ← Copy · Delete · Rename · Makedir · Protect · Info · Download · Swap ⇄.
     Buttons that cannot apply are disabled with a reason in their tooltip.
   - **Active pane:** the last one clicked; tinted header.
   - **Foot:** selection count and size; "Every change saves one new version" inside a disk; "Drop files here" in STASH:.
3. **Protect:** the existing protection editor, for one or many files. **Info:** name, size, date, protection, comment
   (editable on LIBRARY: and STASH:).

### 5.2 Interaction

- Click selects; Shift-click ranges; Ctrl/⌘-click toggles. Double-click opens a folder, archive, title, disk or board.
- Drag between panes copies; Shift-drop moves. Dropping files from the computer onto a pane writes them where it points
  (refused with a reason where read-only).
- Keys: ↑/↓ move, Space selects, Enter opens, Backspace goes up, Tab switches pane, F5 copy, F6 move, F7 makedir,
  F2 rename, Delete delete. Shortcuts never fire while typing in a field or a dialog is open.
- State lives in the URL: `/files?left=<path>&right=<path>&active=left|right`. Back and reload restore both panes.
- Long operations show progress in the button column ("Copying 3 of 12…"); the result is a toast plus, on any
  failure, a list of what failed and why.

### 5.3 Entry points and redirects

- **"Files…"** replaces "Browse…" on disk rows, the title page and the disk menu: `/files?left=STASH:&right=LIBRARY:/<title>/<disk>&active=right`.
- `/disks/<id>/files` → 307 to that URL. `/ingest` (and `?board=`, `?from=`) → 307 to `/files` (with the board's NET:
  path on the right when `board` is given).
- Help, the phone More menu and any in-app links that named Upload or Browse are updated.

### 5.4 Phone

- One pane at a time; a Left | Right switcher at the top.
- Actions become a bottom bar; **Copy to…** / **Move to…** open a destination picker that starts at the other pane's
  location.
- Drop zones stack; the disk strip wraps.

### 5.5 Library page

- Drop disk images anywhere on the Library page: the page shows a full overlay ("Drop to add 3 disks to the library").
  Accepted as today: ADF, ADZ, DMS, DMZ, HFE, folders, .zip/.lha of disks (same pipeline: `dropzone.tsx`'s logic,
  hashing in the browser, `/api/ingest/check|presign|complete|url`).
- **Add disks ▾** button: Browse files… · Paste a URL… · "or drop disks anywhere on this page".
- A **tray** at the bottom of the Library shows progress and results ("3 added · 1 already in the library"), with Open
  title per row; it replaces the Staging list's library rows.

## 6. Files settings (per user)

A **Files** section in Settings › Account (stored in user prefs, as the existing preferences):

- **Panes on opening:** left (default STASH:) and right (default LIBRARY:).
- **Show .info files:** on/off (off hides them, as the Browse toggle does).
- **Ask before deleting:** on/off (default on).
- **When a name already exists:** Ask (default) / Keep both / Replace / Skip.
- Sort orders are remembered automatically per device; no setting.

## 7. Help

- New topic **Files**: the three devices, copying and moving, the disk strip, history, protection, shortcuts.
- New topic **STASH: and NET:**: files to and from the Amiga, retention, limits, archives.
- **Library** gains adding disks by drop and URL; **send**, **from-amiga** and **network** are updated to point at
  Files; the help count tests move with them.
- Each pane header gets a "?" for the device it shows.

## 8. Errors (each refuses cleanly and changes nothing it did not finish)

| Case | Behaviour |
|------|-----------|
| Disk full | Refused before writing that disk, with the space needed. |
| Disk in a drive | Pane read-only; writes refused naming the holder; **Eject** offered. |
| STASH: full | Refused: "STASH: holds 500 files / 256 MB; delete some first". |
| Name not allowed on AmigaDOS | Refused per file with the reason. |
| No filesystem / HFE | Read-only listing; HFE keeps Extract to ADF. |
| Archive unreadable or over the caps | "Can't open this archive"; the file can still be downloaded. |
| Board offline | Copy into NET: still queues (as today). |
| Board firmware < 1.15.0 | Not listed under NET:. |
| Name clash | Ask (Replace / Skip / Keep both, "for all") unless the user's setting decides. |
| Partial result | Every finished item stays; a list names each failure. |
| Foreign or unknown id in a path | 404, same as unknown. |

## 9. Build order (four increments, each shipped alone)

1. **LIBRARY: and the Files page.** `src/lib/files/*` (paths, drivers interface, LIBRARY: driver), `/api/files/*`, the
   page with both panes, button column, sortable headers, Protect/Info, disk strip with History panel, "Files…"
   buttons, `/disks/<id>/files` redirect, keyboard, phone single pane. adffs gains date/comment. Upload untouched.
2. **STASH:.** Migration adding `source`; STASH: driver; the STASH: drop zone (browser drops, URL); archives browse;
   Add to library; copies between STASH: and disks.
3. **NET: and the Library.** NET: driver; Send drop zone; the Upload page's Staging list retired and `/ingest`
   redirected; Library drop overlay, Add disks ▾, tray; Upload → Files in the nav.
4. **Files settings and help.** Settings › Account › Files; the help topics and pane "?"; phone polish pass.

## 10. Testing

- **Unit:** path parsing/formatting (ids, names, archives, invalid paths); each driver's listing shape; sort
  comparator (asc/desc, folders first); AmigaDOS name rules; adffs date/comment round trip.
- **DB:** ops on a real database: one history version per disk per operation; free-space refusal writes nothing;
  mounted disk refused; STASH: limits; NET: queue entries with paths/protection; org isolation (a foreign id is 404).
- **e2e (isolated DB, desktop and mobile):** Files… from a disk opens STASH: | disk root; copy STASH: → disk and back;
  move between disks; delete with confirm; sort headers; Protect on two files; keyboard F5/Tab/Enter; archive open and
  copy out; send by drop zone and by copy into NET:; Library drop and URL with the tray; redirects from `/ingest` and
  `/disks/<id>/files`; phone Copy to… picker; contrast of the new controls.

## 11. Self-host parity

Nothing here depends on Vercel: blobs go through the same storage layer (`src/lib/storage`), archives are read in
process, and every route runs on the self-host image unchanged.

## 12. Out of scope

- Live browsing of the Amiga's own volumes under NET: (designed for, D2).
- Remote (shared) libraries under LIBRARY:.
- Copying out of the NET: queue.
- Renaming the `amiga_uploads` table.
