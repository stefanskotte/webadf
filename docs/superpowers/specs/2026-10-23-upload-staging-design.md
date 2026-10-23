# A6 Upload: one staging list — design

Date: 2026-10-23. Roadmap item A6 (`2026-10-23-webfloppy-redesign-roadmap-design.md`). Built in today's look; Phase C
restyles it. The approved canvas board is "Upload · send & receive" (InfUploadTransfer).

## Goal

The Upload page (`/ingest`) shows three separate lists today: the Dropzone's (library uploads, in the browser only),
the Send panel's queue (the `transfers` table, one board at a time) and the From the Amiga card (the `amiga_uploads`
table). A6 replaces them with **one Staging list** of everything moving into the library, to the Amiga and from the
Amiga, with filters and counts, **Clear finished**, and **Open title** after an ingest.

## Decisions (operator, 2026-10-23)

1. Library rows stay **for this visit only** (browser state, no new table). Each knows the title it became.
2. **Clear finished never removes a stored file from the Amiga.** Such a file goes only by its own Delete. Today's
   "Clear all" goes away.
3. The list shows **every board's** rows. The board picker on the Send drop area only chooses where new files go.
4. Approach A: one server endpoint merges sends and Amiga files; the browser adds its library rows.

## 1. The page

- Header "Upload", subtitle "Disks into the library, files to and from the Amiga — all through one staging list."
- Two drop areas side by side (stacked below 640 px):
  - **Add disks to the library** — today's Dropzone without its list and its five count tiles. It keeps hashing,
    the upload concurrency and batching, the URL field (`url-fetch.tsx`) and the disk-set suggestion.
  - **Send files to the Amiga** — today's send drop area with its board line ("To WifiFloppy1 · Transfer running")
    and board picker (incl. "Show offline (N)"). `?board=` still preselects the board.
- **Staging**: the filter, Clear finished (N), the rows.
- Footnote: "Files from the Amiga are kept 30 days. Anything here can go on to another place: a file from the Amiga
  into the library, a library disk to the Amiga."

## 2. The rows

Newest first, all kinds mixed (sort by the row's time: library and send-upload rows by drop time, sends by
`createdAt`, Amiga files by `createdAt`). Each row: a direction pill (↓ To library, → To Amiga, ← From Amiga), the file
name, a "where" line, the size, a status with a dot (green done, amber moving, grey waiting, red failed), its actions.

### To the library (browser rows, one per file as today)

| State | Status text | Dot | Actions |
|---|---|---|---|
| hashing | Checking… | amber | — |
| uploading | Uploading… | amber | — |
| deduped | Already in the library | green | Open title |
| done | Added | green | Open title |
| failed | Failed · the note (e.g. "No disk images inside") | red | Clear |

Where: "into the library", and once the title is known "into the library · <title>". The HD tag and the note keep
`ingest-hd-tag` / `ingest-note`. If `/complete` did not name a title for a row's sha (it was rejected), the row has no
Open title.

### Send uploads (browser rows: a file still going up to the server)

| State | Status | Dot | Actions |
|---|---|---|---|
| uploading | Uploading… | amber | — |
| failed | Failed · reason | red | Clear |

Kind "To the Amiga". A successful upload's row is replaced by its transfer row on the next refresh (fetched at once).

### To the Amiga (`transfers`)

| Status | Text | Dot | Actions |
|---|---|---|---|
| queued | Waiting for the Amiga | grey | Cancel |
| sending | Sending · N % | amber | Cancel |
| delivered | Delivered | green | Clear |
| failed | Failed · reason | red | Retry, Clear |
| expired (or lapsed) | Expired | red | Retry, Clear |
| cancelled | Cancelled | grey | Clear |

Where: "to <board>", and "to <board> · saved as <savedAs>" once delivered. Texts and the percent come from the
existing `send-ui.ts` helpers (the percent stays capped at 99 until Delivered).

### From the Amiga (`amiga_uploads`)

| Status | Text | Dot | Actions |
|---|---|---|---|
| receiving | Arriving · N % (or "Stopped at N %" when stalled, as `from-amiga-ui.ts` judges) | amber | Stop |
| failed (incl. receiving past its resume window) | Failed · reason | red | Clear |
| stored | Stored (+ " · a disk image" when it is one) | green | Add to library *or* Open title, Download, Send to Amiga…, Delete |

Where: "from <board>". Add to library shows for a stored disk image with no library title; Open title replaces it
once there is one (§3.3). Send to Amiga… offers the paired boards, as today.

- **Stop** deletes the partial file (the existing `DELETE /api/uploads/:id`); the Amiga's Transfer sees its next chunk
  refused. It asks first: "Stop receiving <name>? The part that arrived is deleted."
- **Delete** on a stored file asks first: "Delete <name>? It is the only copy."
- Confirms use one modal with `staging-confirm`, `staging-confirm-yes`, `staging-confirm-cancel`.

### Filter and Clear finished

- Segmented control: **All / From the Amiga / To the Amiga / To the library**, each with its count of rows (send
  uploads count as To the Amiga). Browser state, default All; `?from=` opens on From the Amiga.
- **Clear finished (N)**: N = rows with a Clear action within the current filter; hidden when N is 0. It clears only
  what the filter shows: the browser drops its own finished/failed library and send-upload rows, and the server clears
  the rest (§3.2) with the cursor of the list the person saw. No confirm (nothing it removes is a file the server
  keeps for the person).
- A row's **Clear** removes that row only.
- Empty list: "Nothing here yet. Drop disks for the library, or files for the Amiga." Empty under a filter:
  "Nothing <to the library | to the Amiga | from the Amiga> right now."

## 3. Server

### 3.1 `GET /api/staging`

Org-scoped (`requireOrg`). Answers `{ rows: StagingRow[], cursor: string }`.

```ts
type StagingRow = {
  key: string;                       // 'send:<id>' | 'amiga:<id>'
  kind: 'out' | 'in';
  id: string;
  name: string;
  sizeBytes: number;
  board: { id: string; name: string };
  status: TransferStatus | 'receiving' | 'stored' | 'failed';   // today's names; lapsed send → 'expired'
  pct: number | null;                // sending / receiving
  savedAs: string | null;            // delivered send
  error: string | null;              // failed text, from the existing helpers
  isDiskImage: boolean;              // stored Amiga file
  title: { gameId: string; title: string } | null;   // stored Amiga file already in the library
  at: string;                        // ISO time to sort by
  settledAt: string | null;          // send: finishedAt; Amiga file: coalesce(storedAt, createdAt) as clearUploads uses; null while moving
};
```

- Sends: the org's newest 200 across all boards. Amiga files: the rows `/api/uploads` returns today (up to
  `UPLOAD_AREA_MAX_FILES`, not deleted). Retention unchanged (7 days, 30 days).
- `cursor` is the database's `now()` read in the same request, as an exact timestamp string.
- Mapping reuses the existing view code (`toView`'s lapsed rule for sends, `toUploadView` for Amiga files) rather
  than re-deriving states. Board names come from the devices join both lists already use.

### 3.2 `POST /api/staging/clear`

Body `{ cursor: string, kinds?: ('out'|'in')[], ids?: string[] }` (zod; `ids` are row keys, at most 500). One
transaction. Removes, among the org's rows (narrowed to `kinds` and/or `ids` when given):

- sends delivered, failed, cancelled or expired with `finishedAt <= cursor`, and queued/sending rows whose
  `expiresAt <= cursor` (the lapsed rows the page shows as Expired) — the same set `clearFinishedTransfers` deletes,
  now with the cursor and across boards;
- Amiga uploads with status failed whose `coalesce(storedAt, createdAt)` is at or before the cursor (the rule `clearUploads` uses today), and receiving rows whose resume window ended at
  or before the cursor (shown as failed) — marked `deleted` with their chunks removed, as `clearUploads` does.

It never touches a stored Amiga file or a row still moving. Answers `{ cleared: number }`; a bad cursor is 400.

### 3.3 Titles

- `/api/ingest/complete` adds `titles: { [sha256]: { gameId: string; title: string } }` for every disk it placed or
  found already placed (incl. deduped files, which the page already sends, and re-sends that land on an existing
  title, incl. the "beside a human set" case). The other answer fields are unchanged; the CLI ignores the new one.
- A stored Amiga file's `title` is set when its `libraryDiskId` points at a disk (today's join), **or** when a disk
  of the org's library has the file's `blobSha256` (newest such disk wins). A file whose bytes become a different
  disk after normalisation (e.g. a DMS) keeps offering Add to library, which lands on the existing title.

### 3.4 Unchanged

Per-row routes (cancel, retry, delete, add to library, send, download), `POST /api/transfers`, the device protocol
routes, the old list routes (`GET`/`DELETE /api/transfers?deviceId=`, `GET /api/uploads`, `POST /api/uploads/clear`)
and the CLI. The page stops using the old list routes. No migration.

## 4. Client

- `StagingProvider` (client context) holds the browser rows (library rows and send uploads). Both drop areas write
  to it; the list reads it.
- `StagingList` polls `/api/staging` every 3 s while any row is queued, sending or receiving, else every 10 s; it
  pauses while the tab is hidden and fetches at once on return, after a drop, and after any action.
- Two pure functions in `src/lib/staging.ts` carry the logic and are unit-tested:
  - `mergeStaging(serverRows, browserRows) → Row[]` (sorted, newest first);
  - `stagingView(rows, filter, now) → { shown, counts: {all,in,out,lib}, clearable, clearableKeys }`, with each
    row's status text, dot and actions.
- If a poll fails, the list keeps its last rows and shows "Couldn't refresh" until the next good one. Browser rows
  are never dropped by a failed poll. A failed action toasts its reason, as today.
- Removed: the Dropzone's list and tiles, `SendPanel`'s queue and upload list, `FromAmigaCard`. Kept and reused:
  `send-ui.ts`, `from-amiga-ui.ts`, the drop areas, `use-send-board.ts`.
- Help: the Upload, Send and From-the-Amiga topics in `src/lib/help/topics.tsx` describe the one list.

### Test ids

- Unchanged: `dropzone`, `file-input`, `url-fetch-form`, `url-input`, `url-fetch`, `url-status`, `set-suggestion*`,
  `send-dropzone`, `send-file-input`, `send-no-board`, `send-board`, `send-receiver`, `send-board-picker`,
  `send-board-<id>`, `send-show-offline`, `ingest-note`, `ingest-hd-tag`.
- New: `staging-list`; `staging-row` with `data-kind` (`lib` | `out` | `in`), `data-state` (the row's state name)
  and `data-key`; `staging-status-<key>`; `staging-filter-<all|in|out|lib>` (its text holds the count);
  `staging-clear-finished`; `staging-empty`; `staging-refresh-failed`; actions `staging-<open|add|download|send|
  delete|stop|cancel|retry|clear>-<key>`; `staging-confirm`, `staging-confirm-yes`, `staging-confirm-cancel`.
  Library and send-upload keys are `lib:<sha256 or bad:filename>` and `up:<n>`.

## 5. Testing

- Unit: `mergeStaging` order; `stagingView` actions for every kind × state, counts per filter, clearable keys within
  a filter, the lapsed and stalled cases; the `/complete` `titles` map (new disk, deduped, re-send, beside a set,
  rejected file absent).
- DB: `/api/staging` across two boards and two orgs (no leak); clear with a cursor — a send finished after the cursor
  and an Amiga file that failed after it survive; a stored file and moving rows are never cleared; `kinds` and `ids`
  narrowing; the sha-256 title match.
- e2e: new `e2e/upload-staging.spec.ts` — counts with all three kinds; Clear finished keeps a stored file; Open title
  after an ingest; Stop with its confirm; a second board's rows show. Existing specs move to the new row ids:
  `ingest-ui`, `send-to-amiga`, `from-amiga`, `mobile`, `hfe-disks`, `hd-disks`, `disk-sets`, `url-upload`,
  `archive-drop*`. Those run, desktop and mobile, before merge.

## Out of scope

Persisting library uploads; byte-level upload progress; a per-board filter in the list; Phase C styling.
