# A6 Upload staging list Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Upload page's three lists (Dropzone rows, Send queue, From the Amiga card) with one Staging list
with filters, counts, Clear finished and Open title.

**Architecture:** A new `GET /api/staging` merges the org's sends and Amiga files for every board into one row shape
(`src/lib/staging-server.ts`); `POST /api/staging/clear` clears finished rows by key. The browser keeps this visit's
library uploads and send uploads in a `StagingProvider` context; `StagingList` merges them with the server rows
through two pure functions in `src/lib/staging.ts`. `/api/ingest/complete` (and the URL ingest) also return the
title each disk landed in.

**Tech Stack:** Next.js App Router (read `node_modules/next/dist/docs/` before touching routes or pages — this
Next has breaking changes), React client components, drizzle-orm on Postgres, zod, vitest (unit:
`npx vitest run <file>`; DB: `TEST_DATABASE_URL=$(pnpm -s db:dev start | grep -oE "postgresql://\S+") npx vitest run -c vitest.db.config.mts <file>`),
Playwright (`PORT=3100 npx playwright test <spec> --project=desktop`, and `--project=mobile` for `*mobile.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-10-23-upload-staging-design.md` (read it; it holds every status text, action
and test id verbatim).

## Global Constraints

- Status texts, where lines, empty texts, confirm texts and test ids are exactly the spec's (§2, §4 "Test ids").
- Clear finished never removes a stored Amiga file; clear is by row keys (`send:<id>`, `amiga:<id>`), 1..1000 keys.
- Library rows (`lib:<sha256 | bad:filename>`) and send uploads (`up:<n>`) live in the browser only — no new table,
  no migration.
- The list shows every board's rows; the Send drop area's picker only picks where new files go.
- Polling: 3 s while any row is queued, sending or receiving (or a browser row is hashing/uploading), else 10 s;
  paused while the tab is hidden; fetch at once on return, after a drop and after any action.
- Unchanged routes: per-row cancel/retry/delete/library/send/file, `POST /api/transfers`, device routes, the old list
  routes and the CLI.
- Never print `.env.local` secrets; never `git add -A`; never `git stash`; stop only your own PIDs; e2e on PORT=3100,
  one run at a time, each foreground call under 9 minutes; no commit after a red test run.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc
  ```

## Review Focus

1. Dropping a file that is already a library row (same sha-256) resets that row in place, never a second row with
   the same key — pinned by `upsertLibRows` tests (Task 4).
2. A poll answer that left before a Clear/Delete/Stop must not bring the removed row back — the list ignores an
   answer when a change of its own finished after that request began (`answerIsCurrent`, Task 5) and the e2e
   Clear finished test asserts the row stays gone after the next poll (Task 5).
3. A board renamed or unpaired: Amiga rows keep `deviceName`; a send's board name comes from the join — pinned in
   the DB test (Task 2) by renaming a device and reading the Amiga row's board name unchanged.
4. A failed or 401 poll keeps the last rows and the browser rows and shows `staging-refresh-failed` — pinned by an
   e2e step that routes `/api/staging` to 500 once (Task 5).
5. The biggest list (500 Amiga files + 200 sends) fits one clear call (≤ 1000 keys) — pinned by the zod test with
   1000 and 1001 keys (Task 3).

---

### Task 1: Titles from the library ingest

**Files:**
- Modify: `src/lib/ingest-complete.ts` (`registerUploads`, the answer at ~line 529)
- Modify: `src/lib/url-ingest.ts` (`UrlIngestRow`, `ingestFromUrl` ~line 230-300)
- Modify: `src/components/ingest/url-fetch.tsx` (`FetchedRow` gains `title`)
- Test: create `src/lib/ingest-complete.db.test.ts`; extend `src/lib/url-ingest.test.ts` if it covers row shapes

**Interfaces:**
- Produces: `/api/ingest/complete` answer field `titles: Record<string, { gameId: string; title: string }>` (keyed by
  sha256); `FetchedRow.title?: { gameId: string; title: string } | null`.

- [ ] **Step 1: Write the failing DB test.** In `src/lib/ingest-complete.db.test.ts`, follow the setup of an existing
  `src/lib/*.db.test.ts` (e.g. `last-disk.db.test.ts`) for the test DB and org. Insert `blobs` rows for the shas first
  (the `disks.sha256` FK), then call `registerUploads(orgId, files)` and read `await res.json()`. Cases:
  - a new disk `Turrican II (1991)(Factor 5)[cr].adf` → `titles[sha]` = `{ gameId: <the game row's id>, title: 'Turrican II' }`
    (assert against the `games` row you select, not a literal id);
  - the same file sent again → the same `titles[sha]`;
  - a game whose title was edited afterwards (`update games set title='Edited'`) then re-sent → `title: 'Edited'`
    (titles are read back from the DB, not from the parse);
  - a disk re-sent into a human-arranged set (`games.diskOrderSource = 'human'`, the "beside a set" branch) that already
    holds it → `titles[sha]` names the set's game;
  - a rejected file (zero-length blob or a non-ADF the verdict refuses) → no `titles` entry.
- [ ] **Step 2: Run it, expect FAIL** (`titles` undefined).
- [ ] **Step 3: Implement.** In `registerUploads`, collect every disk id this call placed or skipped as already there
  (`diskRows` keys plus the `existing` ids hit in the `alreadyThere` branch). After all writes, read them back in
  `INSERT_CHUNK` chunks:
  ```ts
  const titles: Record<string, { gameId: string; title: string }> = {};
  for (const part of chunk([...placedDiskIds], INSERT_CHUNK)) {
    const rows = await db.select({ sha256: disks.sha256, gameId: disks.gameId, title: games.title })
      .from(disks).innerJoin(games, eq(games.id, disks.gameId))
      .where(and(inArray(disks.id, part), eq(disks.orgId, orgId)));
    for (const r of rows) titles[r.sha256] = { gameId: r.gameId, title: r.title };
  }
  ```
  and add `titles` to the `Response.json({...})` answer. In `ingestFromUrl`, read `titles` from the
  `registerUploads` answer it already parses and set `title: titles[sha] ?? null` on each non-failed row; add
  `title?: { gameId: string; title: string } | null` to `UrlIngestRow` and to `FetchedRow`.
- [ ] **Step 4: Run the DB test, `npx vitest run src/lib/url-ingest.test.ts src/lib/ingest.test.ts`, and `npx tsc --noEmit`; expect PASS.**
- [ ] **Step 5: Commit** (`git add` the four files) — "Upload staging: /complete and URL ingest name each disk's title".

### Task 2: Server staging list and clear

**Files:**
- Create: `src/lib/staging-server.ts`
- Modify: `src/lib/amiga-uploads.ts` (`UploadView` gains `blobSha256: string | null`; `toUploadView` copies it)
- Modify: `src/lib/from-amiga-ui.ts` (export `uploadFailureText(errorCode: string | null): string` = the `FAILED`
  lookup with today's fallback; `uploadChip` uses it)
- Test: create `src/lib/staging-server.db.test.ts`

**Interfaces:**
- Consumes: `toView` (`src/lib/send-http.ts`), `failureText` (`send-ui.ts`), `listUploads`, `libraryEligible`.
- Produces (types live in `src/lib/staging.ts`, Task 4 — create that file now with just the type below so this task
  compiles; Task 4 adds the functions):
  ```ts
  export type ServerRow = {
    source: 'server';
    key: string;                                   // 'send:<id>' | 'amiga:<id>'
    kind: 'out' | 'in';
    id: string;
    name: string;                                  // send: path; amiga: path
    sizeBytes: number;
    board: { id: string | null; name: string };
    status: 'queued' | 'sending' | 'delivered' | 'failed' | 'cancelled' | 'expired' | 'receiving' | 'stored';
    doneBytes: number;                             // bytesSent / receivedBytes
    pct: number | null;                            // sending/receiving: min(99, floor(done*100/size)); else null
    savedAs: string | null;
    error: string | null;                          // failed: failureText / uploadFailureText; else null
    isDiskImage: boolean;                          // amiga: libraryEligible(path, size); send: false
    title: { gameId: string; title: string } | null;
    at: number;                                    // createdAt ms
  };
  ```
  `listStaging(db: Db, orgId: string, now?: Date): Promise<ServerRow[]>` (newest first) and
  `clearStaging(db: Db, orgId: string, keys: string[], now?: Date): Promise<number>`.

- [ ] **Step 1: Write the failing DB test** (`src/lib/staging-server.db.test.ts`, setup as in `transfers.db.test.ts`
  and `amiga-uploads.db.test.ts` — reuse their device/transfer/upload insert helpers or copy them). Cases:
  - two boards in org A, one in org B: sends on both A boards and an Amiga file on each appear for A with the right
    `board.name`; nothing of B appears;
  - a queued send past `expiresAt` reads `status: 'expired'`; a receiving upload past `expiresAt` reads `failed`
    with `error` = `uploadFailureText('expired')`;
  - a sending row with `bytesSent` 4096 of 8192 → `pct: 50`; delivered → `pct: null`, `savedAs` set;
  - a stored Amiga `.adf` whose `blobSha256` equals an org-A `disks.sha256` (no `libraryDiskId`) → `title` names that
    disk's game; the same sha in org B only → `title: null`; a `libraryDiskId` set → that disk's game;
  - Review Focus 3: rename the device after the upload opened → the Amiga row's `board.name` is still `deviceName`;
  - `clearStaging` with keys for: a delivered send, a failed Amiga file, a lapsed receiving file (all cleared), a
    queued send, a receiving file, a stored file, an org-B delivered send (all left) → returns 3; the delivered send
    row is gone, the failed/lapsed Amiga rows read `deleted` and their chunks are gone; malformed keys are ignored.
- [ ] **Step 2: Run it, expect FAIL** (module not found).
- [ ] **Step 3: Implement `src/lib/staging-server.ts`.**
  - Sends: `select({ t: transfers, boardName: devices.name }).from(transfers).innerJoin(devices, eq(devices.id, transfers.deviceId)).where(eq(transfers.orgId, orgId)).orderBy(desc(transfers.createdAt), desc(transfers.id)).limit(200)`;
    map each through `toView(r.t, now.getTime())` for the status (the lapsed rule) and build a `ServerRow`.
  - Amiga files: `listUploads(db, orgId, null, now)`; then one titles query for the stored rows:
    `select({ id: disks.id, sha256: disks.sha256, gameId: disks.gameId, title: games.title }).from(disks).innerJoin(games, eq(games.id, disks.gameId)).where(and(eq(disks.orgId, orgId), or(inArray(disks.id, diskIds), inArray(disks.sha256, shas)))).orderBy(asc(disks.id))`
    (skip the query when both lists are empty). `libraryDiskId` match wins; else the first disk (lowest id) with the
    sha. `board: { id: u.deviceId, name: u.deviceName }`.
  - Merge both, sort by `at` desc then `key` desc.
  - `clearStaging`: split keys by prefix into transfer ids and upload ids (ignore anything else); one
    `db.transaction`: delete transfers where org, id in ids, and (status in delivered/failed/cancelled/expired, or
    status in queued/sending and `expiresAt <= now`); update amiga_uploads set status 'deleted' where org, id in ids,
    and (status = 'failed' or (status = 'receiving' and `expiresAt <= now`)), returning ids, then delete their
    `amigaUploadChunks`. Return the sum.
- [ ] **Step 4: Run the DB test and `npx vitest run src/lib/from-amiga-ui.test.ts` (if present) and `npx tsc --noEmit`; expect PASS.**
- [ ] **Step 5: Commit** — "Upload staging: one server list of sends and Amiga files, clear by key".

### Task 3: The staging routes

**Files:**
- Create: `src/app/api/staging/route.ts` (GET), `src/app/api/staging/clear/route.ts` (POST)
- Test: create `src/app/api/staging/routes.test.ts` (mock `@/lib/session`, `@/db`, `@/lib/staging-server`,
  `@/lib/send-targets` the way `src/app/api/uploads/routes.test.ts` mocks its libs)

**Interfaces:**
- Consumes: `listStaging`, `clearStaging` (Task 2), `listSendTargets(db, orgId, now)`.
- Produces: `GET /api/staging` → `{ rows: ServerRow[], targets: SendTarget[], now: number }` with
  `cache-control: no-store`; `POST /api/staging/clear` body `{ keys: string[] }` → `{ cleared: number }`, 400
  `{ error: 'invalid_body' }` on a bad body.

- [ ] **Step 1: Write the failing route tests:** GET passes the session's orgId to both libs and returns their
  answers; POST with 1 key and with 1000 keys calls `clearStaging(db, 'org-1', keys)` and answers `{ cleared }`;
  POST with 0 keys, 1001 keys, a non-string key, a key longer than 200 chars, or non-JSON answers 400 and never calls
  `clearStaging` (Review Focus 5).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (`export const maxDuration = 60;` as the sibling routes do; zod
  `z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(1000) })`).
- [ ] **Step 4: Run `npx vitest run src/app/api/staging/routes.test.ts`; expect PASS.**
- [ ] **Step 5: Commit** — "Upload staging: GET /api/staging and POST /api/staging/clear".

### Task 4: The staging logic (pure, client-safe)

**Files:**
- Modify: `src/lib/staging.ts` (created with `ServerRow` in Task 2)
- Test: create `src/lib/staging.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LibState = 'hashing' | 'uploading' | 'deduped' | 'done' | 'failed';
  export type LibRow = { source: 'lib'; key: string; kind: 'lib'; name: string; sizeBytes: number; state: LibState;
    note?: string; title: { gameId: string; title: string } | null; at: number };
  export type UpRow = { source: 'up'; key: string; kind: 'out'; name: string; sizeBytes: number;
    state: 'uploading' | 'failed'; note?: string; boardName: string; at: number };
  export type StagingRowAny = ServerRow | LibRow | UpRow;
  export type StagingFilter = 'all' | 'in' | 'out' | 'lib';
  export type Tone = 'done' | 'busy' | 'wait' | 'fail';
  export type StagingAction = 'open' | 'add' | 'download' | 'send' | 'delete' | 'stop' | 'cancel' | 'retry' | 'clear';
  export type ViewRow = { key: string; kind: 'lib' | 'out' | 'in'; state: string; name: string; where: string;
    size: string; status: string; tone: Tone; note: string | null; actions: StagingAction[];
    gameId: string | null; row: StagingRowAny };
  export function mergeStaging(server: ServerRow[], browser: (LibRow | UpRow)[]): StagingRowAny[];
  export function stagingView(rows: StagingRowAny[], filter: StagingFilter, stalled: ReadonlySet<string>):
    { shown: ViewRow[]; counts: Record<StagingFilter, number>; clearServer: string[]; clearLocal: string[] };
  export function upsertLibRows(rows: LibRow[], next: LibRow[]): LibRow[];   // same key → replaced in place
  export function anyMoving(rows: StagingRowAny[], stalled: ReadonlySet<string>): boolean;
  export function trackStalls(prev: Record<string, { bytes: number; since: number }>, rows: ServerRow[], now: number):
    { seen: Record<string, { bytes: number; since: number }>; stalled: Set<string> };   // STALL_MS from from-amiga-ui
  ```

- [ ] **Step 1: Write the failing tests** in `src/lib/staging.test.ts`, one `it` per row of the spec §2 tables (all
  four tables), asserting `status`, `tone`, `where` and `actions` exactly. Examples to copy the shape from:
  ```ts
  const send = (o: Partial<ServerRow>): ServerRow => ({ source: 'server', key: 'send:t1', kind: 'out', id: 't1',
    name: 'transfer-test.bin', sizeBytes: 200_704, board: { id: 'd1', name: 'WifiFloppy1' }, status: 'queued',
    doneBytes: 0, pct: null, savedAs: null, error: null, isDiskImage: false, title: null, at: 1000, ...o });
  it('a delivered send says where it was saved and can be cleared', () => {
    const [v] = stagingView([send({ status: 'delivered', savedAs: 'transfer-test.bin' })], 'all', new Set()).shown;
    expect(v).toMatchObject({ status: 'Delivered', tone: 'done', where: 'to WifiFloppy1 · saved as transfer-test.bin', actions: ['clear'] });
  });
  it('a stored disk image already in the library opens its title instead of adding', () => {
    const [v] = stagingView([amiga({ status: 'stored', isDiskImage: true, title: { gameId: 'g1', title: 'Turrican II' } })], 'all', new Set()).shown;
    expect(v).toMatchObject({ status: 'Stored · a disk image', actions: ['open', 'download', 'send', 'delete'], gameId: 'g1' });
  });
  it('a stalled arriving file says where it stopped', () => {
    const [v] = stagingView([amiga({ status: 'receiving', pct: 47 })], 'all', new Set(['amiga:u1'])).shown;
    expect(v).toMatchObject({ status: 'Stopped at 47 %', tone: 'busy', actions: ['stop'] });
  });
  ```
  Also: `counts` over all rows whatever the filter (send uploads count as `out`); `shown` and the clear keys only
  within the filter; `clearServer` holds `send:`/`amiga:` keys with a `clear` action, `clearLocal` the `lib:`/`up:`
  ones; a stored file is never in either; `mergeStaging` sorts by `at` desc then key; `upsertLibRows` replaces a row
  with the same key in place and appends new ones (Review Focus 1); `anyMoving` true for queued/sending/receiving
  (not stalled) and hashing/uploading browser rows; `trackStalls` marks a receiving row stalled after `STALL_MS` at
  the same `doneBytes` and restarts the clock when bytes move. Library `where`: `into the library`, and
  `into the library · Turrican II` with a title; `size` uses `formatSize` from `send-ui.ts`.
- [ ] **Step 2: Run `npx vitest run src/lib/staging.test.ts`, expect FAIL.**
- [ ] **Step 3: Implement** in `src/lib/staging.ts`. Keep it client-safe: import only types from server modules, and
  `formatSize` (`send-ui.ts`) and `STALL_MS` (`from-amiga-ui.ts`) as values. Status texts per spec §2: send —
  `Waiting for the Amiga` (wait), `Sending · N %` (busy), `Delivered` (done), `Failed · <error>` (fail), `Expired`
  (fail), `Cancelled` (wait); Amiga — `Arriving · N %` / `Stopped at N %` (busy), `Failed · <error>` (fail),
  `Stored` + ` · a disk image` (done); library — `Checking…`, `Uploading…` (busy), `Already in the library`, `Added`
  (done), `Failed · <note>` (fail, plain `Failed` with no note); send upload — `Uploading…` (busy),
  `Failed · <note>` (fail). `note` on a ViewRow carries a library row's non-failure note (e.g. "from X.dms") for
  `ingest-note`; null otherwise.
- [ ] **Step 4: Run the test; expect PASS. Run `npx tsc --noEmit`.**
- [ ] **Step 5: Commit** — "Upload staging: merge, view, counts and actions as pure functions".

### Task 5: The Upload page switches to the staging list

**Files:**
- Create: `src/components/ingest/staging-provider.tsx`, `src/components/ingest/staging-list.tsx`,
  `src/components/ingest/staging-confirm.tsx`
- Modify: `src/components/ingest/dropzone.tsx` (rows go to the provider; list and five tiles removed),
  `src/components/send/send-panel.tsx` (becomes the Send drop area: board line + picker + drop area; queue and
  upload list removed; target rx state from the provider's latest `targets`), `src/app/(app)/ingest/page.tsx`
  (layout per spec §1; `?from=` → initial filter `in`)
- Delete: `src/components/uploads/from-amiga-card.tsx` (move any still-used helper first; `grep` for imports)
- Test: create `e2e/upload-staging.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-4; existing row actions' fetch calls and error texts — copy them from `send-panel.tsx`
  (`cancel`, `retry`) and `from-amiga-card.tsx` (library, send with its board picker, download, delete), keeping
  their toasts and `sendErrorText` / `uploadErrorText`.
- Produces: `StagingProvider` exposing `{ libRows, upRows, setLibRows(fn), addUp(row), patchUp(key, patch),
  removeLocal(keys), serverRows, targets, refreshNow() }`; `useStaging()`.

- [ ] **Step 1: Write the failing e2e spec** `e2e/upload-staging.spec.ts`. Seed with the helpers
  `send-to-amiga.spec.ts` and `from-amiga.spec.ts` already use (paired device rows, transfers, amiga_uploads in the
  test org; `cleanupSeeded` in `afterAll`). Tests:
  - all three kinds present (drop an `.adf` on `dropzone`, seed one delivered send and one stored Amiga `.adf`):
    `staging-filter-all` reads 3, `-lib` 1, `-out` 1, `-in` 1; picking `staging-filter-in` shows only the Amiga row;
  - after the drop finishes, the library row shows `staging-open-<key>` linking to `/games/<gameId>` (select the
    game from the DB by org);
  - Clear finished: seed a delivered send, a failed Amiga file and a stored Amiga file; `staging-clear-finished`
    reads `Clear finished (2)`; click → only the stored file remains, and after waiting 11 s (one idle poll) it is
    still the only row (Review Focus 2);
  - Stop: seed a receiving Amiga file; `staging-stop-<key>` → `staging-confirm` shows
    `Stop receiving <name>? The part that arrived is deleted.`; `staging-confirm-yes` → the row is gone and the DB
    row reads `deleted`;
  - a second board's send shows its board name in the row's where line while the picker points at the first board;
  - Review Focus 4: `page.route('**/api/staging', r => r.fulfill({ status: 500 }))` for one poll after a drop →
    `staging-refresh-failed` visible and the library row still there; unroute → it clears.
- [ ] **Step 2: Run `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop`; expect FAIL** (no
  `staging-*` ids).
- [ ] **Step 3: Build the provider and list.** `StagingProvider` holds `libRows: LibRow[]` (use `upsertLibRows`),
  `upRows: UpRow[]`, the last `/api/staging` answer, the stall tracker (`trackStalls`) and a `changes` counter;
  it polls per Global Constraints (`anyMoving` decides 3 s vs 10 s; `visibilitychange` restarts it) and discards an
  answer whose request started before the latest own change finished (`answerIsCurrent` from `from-amiga-ui.ts`).
  A failed poll (network, non-OK) keeps the last rows and sets `refreshFailed` (rendered as
  `staging-refresh-failed`: "Couldn't refresh"). `StagingList` renders `stagingView(...)`: filter segmented control
  (`staging-filter-*`, label + count), `staging-clear-finished` (`Clear finished (N)`, hidden at 0; calls
  `removeLocal(clearLocal)` and `POST /api/staging/clear { keys: clearServer }` when non-empty), rows
  (`staging-row` with `data-kind`, `data-state`, `data-key`; `staging-status-<key>`; pill, name, where, size, dot,
  `ingest-note` / `ingest-hd-tag` on library rows as the Dropzone draws them today), actions with
  `staging-<action>-<key>`, empty texts (`staging-empty`), and the footnote. Open title is a `Link` to
  `/games/<gameId>`. Stop and Delete open `StagingConfirm` (one modal; `staging-confirm`, `-yes`, `-cancel`; focus
  trap with `tabTarget` from `from-amiga-ui.ts`, Escape cancels) with the spec's texts. Send to Amiga… on an Amiga
  row offers the paired boards from `targets` as the From the Amiga card does today. Every action bumps `changes`
  and calls `refreshNow()` when it settles.
- [ ] **Step 4: Rewire the drop areas.** Dropzone: replace `setRows`/`patch` with the provider's `setLibRows`
  (keys `lib:<sha256>` / `lib:bad:<filename>`, `at: Date.now()` at row creation), keep `finalState`, hashing,
  batching, `SetSuggestion` and `UrlFetch` (fetched rows carry `title`), store `titles[sha]` from `/complete` on each
  row, and drop the tiles and the list. Send panel: `handleFiles` writes `UpRow`s (`up:<n>`, `boardName` of the
  picked board), removes the row on success and calls `refreshNow()`; the board line/picker/receiver chip stay,
  fed by the provider's `targets` (fall back to the server-rendered `targets` prop before the first answer) and the
  waiting/sending counts of that board's rows. Page: header subtitle per spec §1, the two drop areas in the existing
  two-column grid, then `StagingList`, all inside `StagingProvider`.
- [ ] **Step 5: Run the new spec; expect PASS. Run `npx tsc --noEmit` and `npx vitest run src/lib/staging.test.ts`.**
- [ ] **Step 6: Commit** — "Upload staging: one list on the Upload page".

### Task 6: Existing e2e specs and help move to the staging list

**Files:**
- Modify: `e2e/ingest-ui.spec.ts`, `e2e/send-to-amiga.spec.ts`, `e2e/from-amiga.spec.ts`, `e2e/mobile.spec.ts`,
  `e2e/hfe-disks.spec.ts`, `e2e/hd-disks.spec.ts`, `e2e/disk-sets.spec.ts`, `e2e/url-upload.spec.ts`,
  `e2e/archive-drop*.spec.ts`, `e2e/screenshots.shots.ts` (only where they use removed ids: `ingest-row`,
  `[data-state=…]` on Dropzone chips, `send-row-*`, `send-state-*`, `send-cancel-*`, `send-retry-*`, `send-upload`,
  `send-queue*`, `send-clear-finished`, `from-amiga*` row/list/clear ids)
- Modify: `src/lib/help/topics.tsx` (the Upload, Send and From-the-Amiga topics describe the one list, Clear
  finished keeping stored files, Stop)

- [ ] **Step 1: `grep -rn` each removed id under `e2e/`; list every hit in the report.**
- [ ] **Step 2: Move each assertion to the new ids, keeping what it checks** (a test of the old "Clear all" confirm
  becomes a test that Clear finished leaves stored files; a per-board queue test becomes the same check on the
  row's where line). Delete nothing that checks behaviour still in the spec; note any test whose behaviour the spec
  removed (the five tiles, Clear all, Dismiss) and remove only that assertion.
- [ ] **Step 3: Update the help topics.** Keep each topic's structure; describe the list in the spec's words.
- [ ] **Step 4: Run, one at a time, each changed spec with `--project=desktop`, and `e2e/mobile.spec.ts` with
  `--project=mobile`; expect PASS** except the known pre-existing mobile Devices two-column failure (name it in the
  report if it shows).
- [ ] **Step 5: Commit** — "Upload staging: e2e specs and help follow the one list".
