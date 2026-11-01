# Progress panel for long transfers — design

Date: 2026-11-01. Status: written for review (operator). Requested by the operator after Pillock's Monkey Island copy
(four 821 KB disks onto an A600 took minutes, with only a text line to watch).

## 1. What the operator asked for, and the rulings so far

- Large transfers show progress. Directory Opus overlays both panes while it copies; WebFloppy's work is asynchronous
  (the board and Transfer do it while the person goes on), so a **collapsible progress panel** instead of an overlay.
- **Ruling 1 (operator): on every page**, not only Files.
- **Ruling 2 (operator): Cancel** may come later "unless it is simple". Assessed in §6: it is mostly simple, so it is in,
  as "Cancel the rest", with one stated limit.

## 2. What exists today

- A Files operation that the board carries out gets a **job id**: `transfers.job_id` for files going to the Amiga
  (sends, copies and moves onto its volumes) and `remote_requests.fetch_id` for requests to Transfer (copies off its
  volumes, Makedir, Rename, Delete, Protect, comments, a move's removal).
- `GET /api/files/net/fetch/<id>` (`fetchProgress`, src/lib/files/net-fetch.ts) answers a job's progress: total, done,
  failed, skipped, waiting, the writes and their states, the board it waits on and whether that board is offline.
- Files polls that per job and turns it into **one text line** in the bottom bar (`jobStatus`, manager-rules.ts), e.g.
  "Copying 3 of 12 to Webfloppy1…". No bar, no bytes, no time; leaving the page loses it (the job goes on).
- Plain **Queue sends** (the Send-files drop zone) have no job id; NET: shows them row by row.

## 3. The panel

- **Place:** bottom right on desktop, above the bottom bar on Files; on a phone, a full-width strip above the tab bar.
  It never covers a dialog.
- **One card per job**, newest first:
  - title: what and where — "Copying to Webfloppy1 · Workbench:Monkey", "Copying from Webfloppy1 to STASH:",
    "Deleting Workbench:Old on Webfloppy1", "Sending 3 files to Webfloppy1";
  - a **bar by bytes** where bytes are known (sends, copies both ways), by items otherwise (deletes, renames);
  - one line: "3 of 12 files · 2.4 of 9.8 MB · about 1 min left", and the file moving now;
  - the time left appears only after 10 s of progress and is a rolling estimate (last 30 s of bytes);
  - "Waiting for Webfloppy1 (offline)" when the board it waits on is offline (today's rule), and no estimate then;
  - **Cancel the rest** (§6) while it runs.
- **Collapsed:** a pill — "1 job · 41 %" or "2 jobs · 41 %" (bytes over all running jobs). The pill and the
  open/closed choice are remembered per browser (localStorage, a convenience only).
- **Finished:** the card shows today's result words (`jobStatus`'s finished line: "Copied 12 to Webfloppy1, skipped 1
  (already there)"). A clean finish fades after 6 s; a job with any failure stays until closed and lists the failed
  files (first five, then "and N more").
- **Files' bottom-bar status line** for a NET: job goes away (the panel says it); Files' own short operations (inside
  LIBRARY: and STASH:) keep their line.
- **Every page:** the panel lives in the app layout. It asks the server for the org's running jobs on load, then polls
  only while a job runs: every 2 s while the page is visible, 15 s while a board is offline (today's rule), none while the
  tab is hidden. Nothing runs → no polling.
- A job started on another device or tab shows up too (the server is the record).

## 4. Server

- **`GET /api/files/jobs`** — the org's jobs that are running, or finished in the last 2 minutes (so a reload still
  shows a result): id, kind, board, title parts, `fetchProgress`'s fields, and bytes: `total` and `done` from
  `transfers.size_bytes`/`bytes_sent` (to the Amiga) and `amiga_uploads.size_bytes`/`received_bytes` via
  `remote_requests.upload_id` (from the Amiga).
- Queue sends without a job id are one synthetic job per board ("Sending N files to <board>") built from that board's
  queued and sending rows.
- **`POST /api/files/jobs/<id>/cancel`** (§6).
- Self-host: plain Postgres queries; nothing hosted-only.

## 5. Accessibility

The panel is a `region` named "Transfers"; each card's bar is a `progressbar` with `aria-valuenow`; a finished job is
announced once through a polite live region; the pill is a button that says what it opens; Cancel asks first
("Cancel the rest of this copy? What has arrived stays.").

## 6. Cancel the rest

What it stops, by kind — all of it already exists as a single-row action today:
- **To the Amiga** (sends, copies and moves onto a volume): waiting rows → cancelled; the row being sent → cancelled
  (`cancelTransfer`, as Delete in the Queue does; the board stops it and Transfer keeps nothing of it).
- **From the Amiga** (copies and moves off a volume): waiting requests → withdrawn (failed `cancelled`, never sent); a
  file arriving → stopped as Delete stops an arriving STASH: row today.
- **Writes** (Makedir, Rename, Protect, comments, Delete): waiting ones → withdrawn. **Limit:** a drawer delete that
  Transfer is already running finishes its current drawer (Transfer has no stop for it; that is the later Transfer
  work).
- **A move** that is cancelled keeps every source not yet removed: its removals are withdrawn with the rest (the safe
  side). The card then says "Cancelled: 5 of 12 moved; the rest is still in <source>".

## 7. Testing

- Unit: the card words and the bar (bytes vs items, the estimate's warm-up and offline rule), the pill sum, the
  finished/fade/keep rules, the synthetic Queue job.
- DB: `/api/files/jobs` across both tables and both directions, the 2-minute window, other orgs never shown; cancel per
  kind, including a move keeping its sources.
- e2e with a fake board: a copy shows a card that fills and finishes; collapse and reload keep it; it shows on the
  Library page too; Cancel stops the rest.
- A500 bench: the Monkey Island case (4 disks' files to Work:) watched in the panel; Cancel halfway.

## 8. Not in this

- Stopping a drawer delete Transfer is already running.
- Progress for STASH: uploads from the computer (they have their own tray) and for library imports.
- Pause/resume.
