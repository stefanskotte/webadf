# Files, increment 3 (NET: and the Library) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NET: as the third device (the org's boards and each board's send queue; copying into `NET:/<board>` sends to the Amiga), a "Send files to the Amiga" drop zone on the Files page, adding disks moved onto the Library page (drop anywhere, Add disks ▾, a results tray), and the Upload page retired: `/ingest` redirects to Files, the nav says Files.

**Architecture:** A `netDriver` joins increment 2's `VolumeDriver` registry: `list` reads `listSendTargets`/`listTransfers`, `write` queues files all-or-nothing through a new `queueTransfers`, `remove` cancels or clears. The library-ingest code that lives in closures inside `dropzone.tsx` is extracted, unchanged in behaviour, into a dependency-injected runner plus a hook, which the Library page's overlay, Add disks ▾ menu and tray use. The Upload page's Staging list, its provider and `/api/staging` go; their jobs now live in STASH: (from the Amiga), NET: (to the Amiga) and the Library tray (into the library).

**Tech Stack:** Next.js 16 App Router (params/searchParams are Promises; `redirect` from `next/navigation`; read `node_modules/next/dist/docs/` before writing routes), React 19, drizzle (Postgres), zod 4, vitest (unit `pnpm vitest run`, DB `pnpm test:db` with `TEST_DATABASE_URL` from `bash scripts/dev-db.sh start`), Playwright (`PORT=3100 bash scripts/e2e-local.sh <specs> --project=desktop|mobile`).

**Spec:** `docs/superpowers/specs/2026-10-29-files-manager-design.md` (increment 3 = §9 item 3; §4.3, §5.1 item 1, §5.3, §5.5, §8). Base: increment 2's plan (`docs/superpowers/plans/2026-10-29-files-increment-2.md`) and its code (the driver seam, STASH:).

## Global Constraints

- Paths: `<DEVICE>:` + `/`-separated segments; titles, disks and **boards by id** (`NET:/<deviceId>`); names only for display (spec §3.1).
- One operation = **one new history version per disk it touches** (spec §4.1).
- Copies keep **date, protection and comment** wherever the destination can hold them (spec §4.1); NET: carries protection and comment (the Receive protocol has no date — ruling R2).
- A foreign or unknown id in a path is **404**, never 403 (spec §8).
- **Free space / limits are checked before writing**: NET: limits are **4 MB per file; 32 files / 16 MB per board's queue** (`src/lib/send-limits.ts`), refused whole (spec §4.3).
- Boards below firmware **1.15.0** (`XFER_FW`) are not listed under NET: (spec §4.3, §8).
- A board that is offline still takes a copy into NET: (it queues, as today) (spec §8).
- AmigaDOS names: at most **30 characters**, no `:` or `/`, Latin-1 (`cleanAmigaPath` for NET: paths, ≤ 255 bytes).
- Copy/move with `onClash: 'ask'` and a clash returns `409 { clashes }` and writes nothing (spec §3.3); NET: never clashes (Transfer saves `Foo_2.lha` rather than overwrite).
- The stored prefs value `startPage: 'upload'` stays valid and now means `/files` (stored rows are never rewritten).
- Self-host parity: nothing Vercel-only; uploads through `diskStore` (spec §11).
- No help text may describe a page that no longer exists: every sentence naming the Upload page or its Staging list changes in this increment (the Files help topics themselves are increment 4).
- Never `git add -A`; never `git stash`. e2e: one run at a time, foreground, each run under 9 minutes, `PORT=3100`, via `scripts/e2e-local.sh`.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01UC3JRhVLZ5t9XkU2Ekdf6j`.

## Increment-3 rulings (decisions the spec leaves open)

- **R1 NET: paths.** `NET:` lists boards (`kind: 'board'`, name = board name, path `NET:/<deviceId>`). `NET:/<deviceId>` lists that board's queue rows (newest first, as `listTransfers`), each `kind: 'file'`, **named by its Amiga path** (`mods/a.txt`), addressed by its transfer id: `NET:/<deviceId>/<transferId>`. NET: has no folders: a copy's destination must be `NET:/<deviceId>` itself; folders copied in become relative paths.
- **R2 What a send keeps.** Path, protection and comment travel (`queueTransfers`); the date does not (the Receive protocol has no field for it — the Amiga stamps the file when Transfer saves it). A queue row's Date column shows when it was queued.
- **R3 All or nothing.** A copy into NET: is refused whole when any file is over 4 MB (`too_large`, naming it), any path cannot be cleaned (`bad_name`), or the queue would pass 32 files / 16 MB (`queue_full`: "The board's queue holds 32 files / 16 MB; wait for it to empty or cancel some"). Same rule as `POST /api/transfers/from-disk` today.
- **R4 Delete in NET:.** On a waiting or sending row it cancels (`cancelTransfer`); on a finished one (delivered, failed, cancelled, expired, or lapsed) it clears it (new `clearTransfer`); a row that finished between the listing and the click is cleared. Retry is not carried over from the Staging list: a failed row's mark says why, and the person copies the file into NET: again.
- **R5 Copy out of NET: is not offered** (spec §4.3, §12): Copy/Move/Download with a NET: source are disabled with "Files waiting for the Amiga cannot be copied out"; the engine refuses `unsupported` too.
- **R6 Board rows.** A board's marks: `online` / `offline 3 h` (`targetState`), `Transfer running` when `receiverRunning`, `<n> waiting` when any, and `key AB12` (the four digits Transfer shows, from `uploadBoards`) — the Staging list's footer used to show them, and the `from-amiga` help points at them.
- **R7 The Send drop zone.** "Send files to the Amiga" (spec §5.1) with the board picker of today's Send card (`useSendBoard`, same remembered choice, Show offline). Files and dropped folders upload one file per `POST /api/transfers?deviceId=&name=<relative path>` (the route already cleans the path); before the first upload the zone checks the whole drop against the board's queue (its NET: listing's `queue`) and the 4 MB cap, and refuses the drop whole if it does not fit, so a drop never half-queues except on a race (then the toast lists what was queued).
- **R8 Library drops.** As the Upload card: ADF, DSK, ADZ, DMS, DMZ, HFE. The page-wide drop also walks dropped **folders** (`readDroppedItems`) and expands dropped **.zip/.lha** in the browser (`expandArchive`), keeping only the disk images inside (each becomes a file named by its member's base name) — the spec's "folders, .zip/.lha of disks"; the URL path already handles archives on the server. Everything after that is the extracted pipeline, byte for byte (hashing, toAdf, HFE inspection, check/presign/PUT/complete, set suggestions).
- **R9 The tray.** Per visit (not stored), fixed to the bottom of the Library page's content, newest drop's rows first: name, state (Hashing / Uploading / Added / Already in the library / Refused + why), **Open title** when the disk has one; a summary line ("3 added · 1 already in the library · 1 refused"); the set suggestion panel; a Close button that empties it (only when nothing is running). It replaces the Staging list's library rows.
- **R10 Redirects.** `/ingest` → 307 `/files`; `/ingest?board=X` → `/files?left=STASH:&right=NET:%2FX&active=right`; `/ingest?from=X` → `/files?left=STASH:&right=NET:%2FX&active=left` (STASH: is where the Amiga's files land; NET:/X beside it names the board). An `X` that is not a target still redirects (the pane then says the place no longer exists).
- **R11 Links that named Upload.** The device card's "N files from the Amiga" and send line, "See queue" toasts (`send-button.tsx`, `remote-disk-actions.tsx`), the empty-library button and any `/ingest` href go straight to their R10 target (no redirect hop). The empty library's button becomes "Add disks" → `/library#add-disks` (the menu opens on that hash).
- **R12 Retired.** `src/components/ingest/{staging-list,staging-row,staging-confirm,staging-provider}.tsx`, `src/components/send/send-panel.tsx`, `src/components/ingest/dropzone.tsx` (its pipeline lives on in the runner), `src/app/api/staging/**`, `src/lib/staging-server.ts`, and whatever in `src/lib/upload-staging.ts` / `src/lib/upload-look.ts` loses its last importer — each deleted only after `rg` shows no importer, with its unit tests. `/api/uploads/**`, `/api/transfers/**` and `/api/ingest/**` stay (Files, the CLI and the Library use them).

## Review Focus

1. **A folder that would overfill the queue.** Copying a folder of 33 files (or 17 MB) into `NET:/<board>` is refused whole with the limit words; not one transfer row is created and the board's queue text is unchanged → Task 1 test `a folder over the queue limit queues nothing`.
2. **A board that stops qualifying.** A pane open on `NET:/<board>` after the board is unpaired or downgraded below 1.15.0 lists as not found ("This place no longer exists"), and a copy into it is 404 → Task 1 test `a board below 1.15.0 is not listed and not found`.
3. **Delete racing delivery.** Delete on a row the board delivered after the pane was drawn clears the finished row instead of failing; a delivered file is never shown as cancelled → Task 1 test `delete on a row that finished meanwhile clears it`.
4. **Dragging a title card on the Library page.** Dragging a game card toward a collection (a non-file drag) never shows the "Drop to add" overlay and never swallows the drop → Task 7 e2e test `dragging a title to a collection shows no overlay`.
5. **Old bookmarks and start pages.** `/ingest?board=<id>` lands on Files with `NET:/<id>` on the right, and a person whose stored start page is `upload` lands on `/files` after sign-in → Task 6 tests `ingest redirects keep the board` and `startPage upload means /files`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/lib/transfers.ts` (+ test) | Gains `queueTransfers` (many files, one transaction, all or nothing) and `clearTransfer` (one finished row). |
| `src/lib/files/net-driver.ts` (+ `net-driver.db.test.ts`) | NET: driver: boards, a board's queue, queue into it, cancel/clear. |
| `src/lib/files/net-rules.ts` (+ `.test.ts`) | Client-safe: a queue row's mark words, the poll interval, `planNetSend` (does a drop fit the queue). |
| `src/lib/files/types.ts`, `words.ts`, `drivers.ts`, `path.ts`, `pane-rules.ts` | `board` kind, `queue_full`, `Listing.queue`, NET in `PANE_DEVICES`, NET in `holdsFiles`. |
| `src/components/files/{pane,files-manager,dialogs,copy-to-picker}.tsx` | NET: in the panes. |
| `src/components/files/send-drop-zone.tsx` | "Send files to the Amiga" with the board picker. |
| `src/lib/library-ingest/run.ts` (+ `.test.ts`), `rows.ts` | The library ingest pipeline, extracted from `dropzone.tsx`, with injected fetch and hashing. |
| `src/components/library-ingest/{use-library-ingest.ts,library-ingest-provider.tsx,drop-overlay.tsx,add-disks-menu.tsx,library-tray.tsx}` | Library page: provider, overlay, Add disks ▾, tray. |
| `src/lib/library-ingest/drop-files.ts` (+ `.test.ts`) | Disk images out of a drop: files, folders, archives. |
| `src/app/(app)/library/page.tsx`, `src/app/(app)/ingest/page.tsx`, `src/components/shell/top-nav.tsx`, `src/lib/user-prefs-schema.ts`, `src/components/prefs/preferences-form.tsx`, `src/proxy.ts` | Library drop; `/ingest` redirect; nav; start page. |
| `src/components/devices/transfer-box.tsx`, `src/components/send/send-button.tsx`, `src/components/remote/remote-disk-actions.tsx`, `src/components/library/title-controls.tsx` | Links to Files. |
| `src/lib/help/topics.tsx` (+ test) | `send`, `from-amiga`, `preferences` stop naming the Upload page. |
| `e2e/files-net.spec.ts`, `e2e/library-add.spec.ts`, rewritten `e2e/send-to-amiga.spec.ts`, `e2e/from-amiga.spec.ts`; `e2e/helpers.ts` and every spec that uploaded through `/ingest` | End to end. |

---

### Task 1: The NET: driver and the batch queue

**Files:**
- Modify: `src/lib/transfers.ts`, `src/lib/files/types.ts` (`EntryKind` gains `'board'`; `RefusalCode` gains `'queue_full'`; `Listing` gains `queue?: { deviceId: string; files: number; bytes: number }`), `src/lib/files/words.ts` (+ `words.test.ts`), `src/lib/files/drivers.ts` (+ `driver.test.ts`)
- Create: `src/lib/files/net-driver.ts`, `src/lib/files/net-rules.ts`
- Test: `src/lib/files/net-driver.db.test.ts`, `src/lib/files/net-rules.test.ts`

**Interfaces:**
- Consumes: increment 2 `VolumeDriver`, `OpCtx`, `IncomingTop`, `refuse`, `driverFor`, `stashDriver`/`libraryDriver` `collect`; `listSendTargets`, `findSendTarget` (`src/lib/send-targets.ts`); `listTransfers`, `cancelTransfer`, `queueLoad`, `cleanAmigaPath`, `SEND_FILE_MAX`, `SEND_QUEUE_MAX_FILES`, `SEND_QUEUE_MAX_BYTES` (`src/lib/transfers.ts`); `toView`, `storeSendBytes` (`src/lib/send-http.ts`); `transferState`, `targetState`, `receiverRunning` (`src/lib/send-ui.ts`); `uploadBoards` (`src/lib/amiga-uploads.ts`); `protectionString` (adffs).
- Produces (`transfers.ts`):
```ts
export type QueueFile = { path: string; sha256: string; sizeBytes: number; protection: number; comment: string };
/** Every file or none (R3): cleaned paths, 4 MB each, the board's 32 files / 16 MB, in one transaction; one cursor bump. */
export async function queueTransfers(db: Db, a: { orgId: string; deviceId: string; userId: string; files: QueueFile[]; now?: Date }):
  Promise<{ ok: true; ids: string[] } | { ok: false; reason: 'bad_name' | 'too_large' | 'queue_full' | 'no_device'; path?: string }>;
/** Delete one finished (or lapsed) row of the org; false when it is waiting/sending, missing, or another org's. */
export async function clearTransfer(db: Db, orgId: string, id: string, now?: Date): Promise<boolean>;
```
- Produces (`net-rules.ts`, client-safe):
```ts
export const NET_REFRESH_ACTIVE_MS = 3_000;
export const NET_REFRESH_IDLE_MS = 10_000;
/** How often a pane showing `l` re-reads it: NET:/<board> only; faster while anything waits or sends. */
export function netPollMs(l: Listing | null): number | null;
/** Whether files of these sizes fit the board's queue as `queue` reports it (R3, R7). */
export function planNetSend(sizes: number[], queue: { files: number; bytes: number }):
  { ok: true } | { ok: false; why: 'too_large' | 'queue_full' | 'empty'; index?: number };
```
- Produces (`net-driver.ts`): `export const netDriver: VolumeDriver` with `list`, `read` (always null), `collect` (refuses `unsupported` 400 "Files waiting for the Amiga cannot be copied out"), `within` (the same refusal), `write`, `remove`.
- Words: `queue_full` → "The board's queue holds 32 files / 16 MB; wait for it to empty or cancel some."; `unsupported` with that detail reads it as is.

Listing rules:
- `NET:` → `listSendTargets` (≥ 1.15.0 only), entries `kind: 'board'`, marks per R6 (`uploadBoards(db, orgId)` for the key), `writable: false`, meta `"<n> boards"` (or `"No board can receive files yet — firmware 1.15.0 or newer"` when none).
- `NET:/<id>`: `findSendTarget` null → null. Rows `listTransfers(db, orgId, id)` through `toView(row, now)`: `name` = view path, `kind: 'file'`, `size`, `date` = createdAt ISO, `protection` = `protectionString(row.protection)`, `comment` = row comment or null, `marks` = `[transferState(view).text]`. `writable: true`, `readOnlyReason: null`, `queue` = `{ deviceId: id, ...await queueLoad(db, id) }`, meta `"<files> waiting · <MB> of 16 MB"`; crumbs `NET:`, board name.
- Deeper paths → null.

`write(ctx, dir, tops)`: `dir.segments.length !== 1` → `refuse('unsupported', 400, 'send to a board, not into a folder')`; `findSendTarget` null → `refuse('not_found', 404)`; `ctx.userId` null → `refuse('unsupported', 400, 'signed-in person required')`. Files = every `file` item of every top, `path = rel.join('/')`; bytes without `sha256` are stored with `storeSendBytes`; then `queueTransfers`; refusals map `bad_name` → 400, `too_large` → 413 (detail `${path} is over 4 MB`), `queue_full` → 409, `no_device` → 404. Done → every top `ok`. `onClash` is ignored (R1: NET: never clashes).

`remove(ctx, sources)`: each `NET:/<board>/<id>` (`findSendTarget` for the board; a missing board → `not_found`): `cancelTransfer` → ok; else `clearTransfer` → ok; else `not_found` per item.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/files/net-rules.test.ts
import { describe, it, expect } from 'vitest';
import { netPollMs, planNetSend } from './net-rules';
import type { Listing } from './types';

const L = (path: string, marks: string[][] = []): Listing => ({ path, crumbs: [], writable: true, readOnlyReason: null, disk: null, meta: '',
  entries: marks.map((m, i) => ({ name: `f${i}`, kind: 'file', path: `${path}/t${i}`, size: 1, date: null, protection: null, comment: null, marks: m })) });

describe('netPollMs', () => {
  it('polls a board queue fast while something waits or sends, slowly otherwise, and nothing elsewhere', () => {
    expect(netPollMs(L('NET:/b1', [['Waiting']]))).toBe(3_000);
    expect(netPollMs(L('NET:/b1', [['Delivered as a.txt']]))).toBe(10_000);
    expect(netPollMs(L('NET:'))).toBeNull();
    expect(netPollMs(L('STASH:'))).toBeNull();
    expect(netPollMs(null)).toBeNull();
  });
});
describe('planNetSend', () => {
  const MB = 1024 * 1024;
  it('fits, or names why not', () => {
    expect(planNetSend([MB, MB], { files: 30, bytes: 0 })).toEqual({ ok: true });
    expect(planNetSend([MB, MB, MB], { files: 30, bytes: 0 })).toEqual({ ok: false, why: 'queue_full' });
    expect(planNetSend([10 * MB], { files: 0, bytes: 7 * MB })).toEqual({ ok: false, why: 'queue_full' });
    expect(planNetSend([MB, 5 * MB], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'too_large', index: 1 });
    expect(planNetSend([0], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'empty', index: 0 });
  });
});
```
(`netPollMs` decides "active" from the first mark: the `transferState` texts for queued and sending — read them from `src/lib/send-ui.ts` and export them as `NET_ACTIVE_WORDS` rather than matching prose loosely.)

```ts
// src/lib/files/net-driver.db.test.ts
// Setup block as src/lib/files/stash-ops.db.test.ts (DB 'webadf_files_net_test'): org o1 and o2; disk d1 "SysInfo" (FFS: C/Assign
// 7 bytes comment 'cmd' protection 0x05, S/); STASH: 'Big.bin' (4 MB + 1 byte) and folder 'Many/' with 33 one-byte files;
// devices: 'b1' (o1, 'A500 bench', firmwareVersion '1.15.0+gabc', lastSeenAt now), 'b0' (o1, 'Old', '1.14.0'), 'bx' (o2, '1.15.0').
const { transfers } = await import('@/db/schema/transfers');
const { runOp } = await import('./ops');
const { netDriver } = await import('./net-driver');
const ctx = { orgId: 'o1', userId: 'u1' };
const queued = async () => getDb().select().from(transfers).where(eq(transfers.deviceId, 'b1'));

describe('NET: listing', () => {
  it('lists the boards that can receive, with their marks', async () => {
    const l = (await netDriver.list(ctx, P('NET:')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual([['board', 'A500 bench', 'NET:/b1']]);
    expect(l.entries[0].marks[0]).toMatch(/online/i);
    expect(l.writable).toBe(false);
  });
  it('a board below 1.15.0 is not listed and not found; another org\'s board is not found', async () => {
    expect(await netDriver.list(ctx, P('NET:/b0'))).toBeNull();
    expect(await netDriver.list(ctx, P('NET:/bx'))).toBeNull();
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b0', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 404 });
  });
});

describe('copy into NET:', () => {
  it('queues a disk folder with paths, protection and comment, and lists it with its state', async () => {
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b1', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/C', ok: true }] });
    const rows = await queued();
    expect(rows.map((x) => [x.path, x.protection, x.comment, x.status])).toEqual([['C/Assign', 5, 'cmd', 'queued']]);
    const l = (await netDriver.list(ctx, P('NET:/b1')))!;
    expect(l.entries[0]).toMatchObject({ name: 'C/Assign', path: `NET:/b1/${rows[0].id}`, comment: 'cmd' });
    expect(l.queue).toEqual({ deviceId: 'b1', files: 1, bytes: 7 });
  });
  it('a folder over the queue limit queues nothing', async () => {
    const before = (await queued()).length;
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Many'], dest: 'NET:/b1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'queue_full' } });
    expect((await queued()).length).toBe(before);
  });
  it('a file over 4 MB refuses the whole copy, naming it', async () => {
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/S', 'STASH:/Big.bin'], dest: 'NET:/b1', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 413, refusal: { code: 'too_large', detail: 'Big.bin is over 4 MB' } });
  });
  it('refuses a folder inside a board and copying out of NET:', async () => {
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'NET:/b1/x', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported' } });
    const [row] = await queued();
    expect(await runOp(ctx, { op: 'copy', sources: [`NET:/b1/${row.id}`], dest: 'STASH:', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported' } });
  });
});

describe('delete in NET:', () => {
  it('cancels a waiting row', async () => {
    const [row] = await queued();
    expect((await runOp(ctx, { op: 'delete', sources: [`NET:/b1/${row.id}`] })).kind).toBe('done');
    expect((await queued()).find((x) => x.id === row.id)!.status).toBe('cancelled');
  });
  it('clears a finished row', async () => {
    const [row] = await queued();
    await runOp(ctx, { op: 'delete', sources: [`NET:/b1/${row.id}`] });
    expect((await queued()).find((x) => x.id === row.id)).toBeUndefined();
  });
  it('delete on a row that finished meanwhile clears it', async () => {
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C/Assign'], dest: 'NET:/b1', onClash: 'ask' });
    const [row] = (await queued()).filter((x) => x.status === 'queued');
    await getDb().update(transfers).set({ status: 'delivered', savedAs: 'Assign', finishedAt: new Date() }).where(eq(transfers.id, row.id));
    expect(await runOp(ctx, { op: 'delete', sources: [`NET:/b1/${row.id}`] })).toMatchObject({ kind: 'done', items: [{ ok: true }] });
    expect((await queued()).find((x) => x.id === row.id)).toBeUndefined();
  });
  it("another org's row is not found", async () => {
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C/Assign'], dest: 'NET:/b1', onClash: 'ask' });
    const [row] = (await queued()).filter((x) => x.status === 'queued');
    expect(await runOp({ orgId: 'o2', userId: 'u2' }, { op: 'delete', sources: [`NET:/b1/${row.id}`] })).toMatchObject({ kind: 'refused', status: 404 });
  });
});
```

Add to `src/lib/transfers.test.ts` (or its DB test file, wherever `queueTransferFromBlob` is tested): `queueTransfers` with 2 files bumps `devices.sendVersion` once and inserts 2 rows; with a path that cleans to nothing returns `{ ok: false, reason: 'bad_name', path }` and inserts none; `clearTransfer` returns false for a queued row and true for a delivered one.

- [ ] **Step 2: Run** `pnpm vitest run src/lib/files/net-rules.test.ts; pnpm test:db src/lib/files/net-driver.db.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** `queueTransfers` (validate every file first — `cleanAmigaPath`, size ≤ `SEND_FILE_MAX`, `diskStore.stat(sha)` present — then one `db.transaction`: the board's active load as `queueTransferFromBlob` counts it, refuse `queue_full` when load + files > 32 or bytes > 16 MB, insert each row with `crc32(await diskStore.read(sha))` computed before the transaction, bump `sendVersion` once), `clearTransfer` (the WHERE of `clearFinishedTransfers` plus `eq(transfers.id, id)`), `net-rules.ts`, `net-driver.ts`, the types/words, `DRIVERS.NET = netDriver`; `driver.test.ts`: `driverFor('NET')!.device === 'NET'`.
- [ ] **Step 4: Run** `pnpm vitest run src/lib/files && pnpm test:db src/lib/files src/lib/transfers src/app/api/transfers` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/transfers.ts src/lib/transfers*.test.ts src/lib/files/net-driver.ts src/lib/files/net-driver.db.test.ts \
  src/lib/files/net-rules.ts src/lib/files/net-rules.test.ts src/lib/files/types.ts src/lib/files/words.ts \
  src/lib/files/words.test.ts src/lib/files/drivers.ts src/lib/files/driver.test.ts
git commit -m "Files: NET: driver -- boards and their queues; copying into NET:/<board> sends, all or nothing; Delete cancels or clears"
```

---

### Task 2: NET: in the panes

**Files:**
- Modify: `src/lib/files/path.ts` (`PANE_DEVICES = ['STASH', 'NET', 'LIBRARY']`), `src/lib/files/pane-rules.ts` (+ test), `src/components/files/pane.tsx` (+ `pane.test.ts`), `src/components/files/files-manager.tsx`, `src/components/files/dialogs.tsx`, `src/components/files/copy-to-picker.tsx`

**Interfaces:**
- Consumes: Task 1 `netPollMs`, `Listing.queue`, `queue_full`.
- Produces (`pane-rules.ts`): `holdsFiles(l)` is also true for `NET:/<board>` (not `NET:`); `export function copyOutReason(l: Listing | null): string | null` → "Files waiting for the Amiga cannot be copied out" for any NET: listing, else null; `export function deleteWords(entries: FsEntry[], l: Listing): string` → in NET: "Cancel 2 waiting files and clear 1 finished?" (waiting/sending by `NET_ACTIVE_WORDS`), elsewhere increment 1's words.
- Behaviour:
  - Device button `pane-<side>-dev-NET` between STASH: and LIBRARY:. Board rows show a `BRD` chip (`--dir-bg` / `--accent-blue`, as titles); double-click or Enter opens `NET:/<id>`.
  - Reasons: Copy/Move/Download/Copy to…/Move to… with a NET: source → `copyOutReason`; Rename, Makedir, Protect in NET: → "Not in NET:"; Info in NET: read-only (comment not editable); Add to library hidden.
  - Copy → into `NET:/<board>`: toast `Queued 3 files for A500 bench` (board name = the destination pane's last crumb); 413/409 refusals through `refusalWords`.
  - Delete in NET: uses `deleteWords`; the confirm button reads "Cancel / clear".
  - Polling: an effect per side re-fetches the listing every `netPollMs(listing)` ms while the tab is visible (`document.visibilityState`), dropped answers that a newer navigation overtook (the existing `seq` guard).
  - The phone picker's device chips include NET:; inside `NET:/<board>` its button reads "Send here".

- [ ] **Step 1: Write the failing tests** — `pane-rules.test.ts`: `holdsFiles` true for `NET:/b1`, false for `NET:`; `copyOutReason` for `NET:/b1` and null for `STASH:`; `deleteWords` counts waiting vs finished from marks. `pane.test.ts`: three device buttons in the order STASH:, NET:, LIBRARY:; a `board` row has `data-kind="board"`.
- [ ] **Step 2: Run** `pnpm vitest run src/lib/files src/components/files` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run src/lib/files src/components/files && pnpm tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/path.ts src/lib/files/path.test.ts src/lib/files/pane-rules.ts src/lib/files/pane-rules.test.ts src/components/files
git commit -m "Files: NET: in the panes -- boards, queue states, Send by copy, Delete cancels or clears, live refresh"
```

---

### Task 3: "Send files to the Amiga" drop zone

**Files:**
- Create: `src/components/files/send-drop-zone.tsx`
- Modify: `src/app/(app)/files/page.tsx` (targets, initial board), `src/components/files/files-manager.tsx` (reload hook already exposed in increment 2)
- Test: `src/components/files/send-drop-zone.test.ts` (static markup, as `pane.test.ts` renders)

**Interfaces:**
- Consumes: `useSendBoard`, `orderTargets`, `longOffline`, `targetState`, `receiverLine`, `sendErrorText`, `SEND_FILE_MAX`, `XFER_FW` (`src/lib/send-ui.ts`, `src/lib/send-limits.ts`); `DropCard`, `INK_LABEL`, `INK_STYLE`; `readDroppedItems`; Task 1 `planNetSend`, `Listing.queue`; `isSignedOutAnswer`, `SIGNED_OUT_TEXT` (move these two from `src/lib/upload-staging.ts` into `src/lib/signed-out.ts` now, re-exported from `upload-staging.ts` until Task 6).
- Produces: `SendDropZone({ targets: SendTarget[]; initialBoard: string | null; serverNow: number; onSent(deviceId: string): void })`.
- Markup contract: `<section data-testid="files-drop-send">` titled "Send files to the Amiga", hint "Any file up to 4 MB, or a folder. It waits in NET: until Transfer on the Amiga takes it."; label `files-send-browse` with `<input type="file" multiple data-testid="files-send-input">`; one board → `files-send-board` line ("To **A500 bench** · online"); several → a radio fieldset `files-send-board-picker` with `files-send-board-<id>` and `files-send-show-offline`; the receiver line `files-send-receiver` (`receiverLine`); no targets → `files-send-no-board` ("No board can receive files yet. Sending needs a board on firmware 1.15.0 or newer." + Devices link), not a drop target but cancelling OS drops.
- Behaviour: on drop/pick, read items (`readDroppedItems` for drops; `File`s with their names for the picker), fetch `/api/files/list?path=NET:/<board>` for `queue`, `planNetSend(sizes, queue)`: refused → toast (`too_large` → "<name> is over 4 MB — nothing was sent", `queue_full` → `refusalWords('queue_full')`, `empty` → "<name> is empty — nothing was sent"); else POST each file to `/api/transfers?deviceId=<id>&name=<relative path>` in order; a signed-out answer stops with `SIGNED_OUT_TEXT`; a refusal mid-way stops and the toast says "Queued 3 of 5 for A500 bench — <why>"; done → toast "Queued 5 files for A500 bench" with action **Show queue** (navigates the right pane to `NET:/<id>`), then `onSent(id)` reloads any pane showing that board.
- Page: `listSendTargets(getDb(), orgId, now)` server-side; the two drop zones sit side by side from `lg` (`grid gap-5 lg:grid-cols-2`), stacked below; `initialBoard` = the board id when either pane's path is `NET:/<id>`.

- [ ] **Step 1: Write the failing test** — render `SendDropZone` with no targets → contains `files-send-no-board` and `href="/devices"`; one target → `files-send-board` names it; two → `files-send-board-picker` with both radios.
- [ ] **Step 2: Run** `pnpm vitest run src/components/files/send-drop-zone.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run src/components/files && pnpm tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/components/files/send-drop-zone.tsx src/components/files/send-drop-zone.test.ts src/components/files/files-manager.tsx \
  "src/app/(app)/files/page.tsx" src/lib/signed-out.ts src/lib/upload-staging.ts
git commit -m "Files: Send files to the Amiga drop zone with the board picker; a drop that does not fit sends nothing"
```

---

### Task 4: Extract the library ingest pipeline (behaviour unchanged)

`src/components/ingest/dropzone.tsx` holds the whole pipeline in closures (`post`, `postComplete`, `putOnce`, `represign`, `processGroup`, `handleFiles`, `suggestFor`, `addFetchedRows`). This task moves it into a runner with injected I/O and a hook, and makes `Dropzone` a thin user of the hook — the Upload page still works exactly as before (its e2e must pass unchanged) until Task 6 retires it.

**Files:**
- Create: `src/lib/library-ingest/rows.ts` (moves `LibRow`, `LibState`, `upsertLibRows` out of `src/lib/upload-staging.ts`, which re-exports them), `src/lib/library-ingest/run.ts`, `src/components/library-ingest/use-library-ingest.ts`
- Modify: `src/components/ingest/dropzone.tsx`
- Test: `src/lib/library-ingest/run.test.ts`

**Interfaces:**
- Produces (`run.ts`):
```ts
export type IngestIo = {
  fetch: typeof fetch;
  hash(file: Blob): Promise<string>;                                    // hashBlob
  toAdf: typeof import('@/lib/archive/disk-image').toAdf;
  inspectHfe: typeof import('@/lib/hfe/inspect').inspectHfe;
};
export type IngestOutcome = { shas: string[]; paths: Map<string, string>; final: Map<string, LibState>; since: string };
/** handleFiles + processGroup of dropzone.tsx, verbatim in behaviour: rows go out through `emit` (a functional update). */
export async function runLibraryIngest(files: File[], io: IngestIo, emit: (fn: (rows: LibRow[]) => LibRow[]) => void): Promise<IngestOutcome>;
/** suggestFor: the /api/disk-sets/suggest call for what landed (≥ 2 settled, ≤ 32 hashes); null for none. */
export async function suggestSet(o: IngestOutcome, io: Pick<IngestIo, 'fetch'>): Promise<Suggestion>;
export const MAX_BATCH = 500; export const UPLOAD_CONCURRENCY = 6; export const MAX_SUGGEST_HASHES = 32;
```
- Produces (`use-library-ingest.ts`): `useLibraryIngest(): { rows: LibRow[]; busy: boolean; suggestion: Suggestion; clearSuggestion(): void; addFiles(files: File[]): Promise<void>; addFetched(rows: FetchedRow[], since: string): Promise<void>; setRows(fn): void }` — `addFiles` runs `runLibraryIngest` with the real `fetch`, `hashBlob`, `toAdf`, `inspectHfe`, then `router.refresh()` and `suggestSet`; `addFetched` is `addFetchedRows`.
- `Dropzone` keeps its markup and test ids, takes its rows through `useStaging().setLibRows` as before (the hook is given `setRows` = the staging setter by a prop-less adapter: `useLibraryIngest({ setRows, onSettled: refreshNow })`, so the signature is `useLibraryIngest(opts?: { setRows?: (fn) => void; onSettled?: () => void | Promise<void> })`, with its own state when `setRows` is absent).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/library-ingest/run.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runLibraryIngest, type IngestIo } from './run';
import type { LibRow } from './rows';

const file = (name: string, size = 901_120) => new File([new Uint8Array(size)], name);
/** A fake server: `missing` says which hashes /check reports missing; `complete` answers /complete; PUTs per url. */
function server(opts: { missing: string[]; complete?: (body: any) => Response; put?: (url: string) => Response | Promise<Response> }) {
  const calls: string[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url); calls.push(`${init?.method ?? 'GET'} ${u.startsWith('/api') ? u : 'blob'}`);
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (u === '/api/ingest/check') return Response.json({ missing: opts.missing });
    if (u === '/api/ingest/presign') return Response.json({ uploads: body.files.map((f: any) => ({ sha256: f.sha256, url: `https://blob/${f.sha256}` })) });
    if (u === '/api/ingest/complete') return opts.complete ? opts.complete(body) : Response.json({ titles: {} });
    return opts.put ? opts.put(u) : new Response(null, { status: 200 });
  });
  return { calls, fetch: f as unknown as typeof fetch };
}
const io = (fetch: typeof fetch): IngestIo => ({
  fetch, hash: async (b) => `h${(b as File).name}`,
  toAdf: (async (name: string, bytes: Uint8Array) => ({ ok: true, from: 'adf', name, bytes, note: undefined })) as never,
  inspectHfe: (() => ({ ok: true })) as never,
});
function collect() {
  let rows: LibRow[] = [];
  return { emit: (fn: (r: LibRow[]) => LibRow[]) => { rows = fn(rows); }, rows: () => rows };
}

describe('runLibraryIngest', () => {
  it('checks, presigns and uploads only the missing disk, completes both, and settles each row', async () => {
    const s = server({ missing: ['hA.adf'] });
    const c = collect();
    const out = await runLibraryIngest([file('A.adf'), file('B.adf'), file('notes.txt')], io(s.fetch), c.emit);
    expect(s.calls).toEqual(['POST /api/ingest/check', 'POST /api/ingest/presign', 'PUT blob', 'POST /api/ingest/complete']);
    expect(c.rows().map((r) => [r.name, r.state])).toEqual([['A.adf', 'done'], ['B.adf', 'deduped']]);
    expect(out.shas).toEqual(['hA.adf', 'hB.adf']);
  });
  it('a 409 /complete with rejectedReasons fails that row with its note and keeps the others', async () => {
    const s = server({ missing: [], complete: () => Response.json({ created: 0, rejectedReasons: { 'hA.adf': 'not a disk' } }, { status: 409 }) });
    const c = collect();
    await runLibraryIngest([file('A.adf'), file('B.adf')], io(s.fetch), c.emit);
    expect(c.rows().map((r) => [r.name, r.state, r.note ?? null])).toEqual([['A.adf', 'failed', 'not a disk'], ['B.adf', 'deduped', null]]);
  });
  it('a PUT that throws fails only that file; a 403 PUT asks for a fresh URL once', async () => {
    let n = 0;
    const s = server({ missing: ['hA.adf', 'hB.adf'], put: (u) => {
      if (u.endsWith('hA.adf')) throw new Error('network');
      return new Response(null, { status: n++ === 0 ? 403 : 200 });
    } });
    const c = collect();
    await runLibraryIngest([file('A.adf'), file('B.adf')], io(s.fetch), c.emit);
    expect(c.rows().map((r) => [r.name, r.state])).toEqual([['A.adf', 'failed'], ['B.adf', 'done']]);
    expect(s.calls.filter((x) => x === 'POST /api/ingest/presign')).toHaveLength(2);
  });
  it('a file of an unuploadable size fails before batching, with the words, and a /check failure fails the group', async () => {
    const c = collect();
    await runLibraryIngest([file('Empty.adf', 0)], io(server({ missing: [] }).fetch), c.emit);
    expect(c.rows()[0]).toMatchObject({ state: 'failed', note: expect.any(String) });
    const broken = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const d = collect();
    await runLibraryIngest([file('A.adf')], io(broken), d.emit);
    expect(d.rows()[0].state).toBe('failed');
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/lib/library-ingest` → FAIL.
- [ ] **Step 3: Implement**: move the code out of `dropzone.tsx` into `run.ts` keeping every comment that explains a rule (they are the reasons for the behaviour); replace `fetch` with `io.fetch`, `hashBlob` with `io.hash`, `toAdf`/`inspectHfe` with `io.*`, `patch`/`setLibRows` with `emit`, `finalState` with the returned `final` map. The hook wraps it as described. `Dropzone` uses the hook.
- [ ] **Step 4: Run** `pnpm vitest run src/lib/library-ingest src/components/ingest && pnpm tsc --noEmit -p .`, then `PORT=3100 bash scripts/e2e-local.sh e2e/ingest-ui.spec.ts e2e/upload-staging.spec.ts --project=desktop` → PASS unchanged.
- [ ] **Step 5: Commit**

```bash
git add src/lib/library-ingest src/components/library-ingest/use-library-ingest.ts src/components/ingest/dropzone.tsx src/lib/upload-staging.ts
git commit -m "Library ingest: the drop pipeline as a runner with injected I/O and a hook; the Upload card uses it unchanged"
```

---

### Task 5: The Library page adds disks (drop anywhere, Add disks ▾, tray)

**Files:**
- Create: `src/lib/library-ingest/drop-files.ts` (+ `.test.ts`), `src/lib/library-ingest/tray.ts` (+ `.test.ts`), `src/components/library-ingest/library-ingest-provider.tsx`, `src/components/library-ingest/drop-overlay.tsx`, `src/components/library-ingest/add-disks-menu.tsx`, `src/components/library-ingest/library-tray.tsx`
- Modify: `src/app/(app)/library/page.tsx`
- Test: `src/lib/library-ingest/drop-files.test.ts`, `src/lib/library-ingest/tray.test.ts`

**Interfaces:**
- Consumes: Task 4 `useLibraryIngest`; `readDroppedItems`, `DroppedItem`; `expandArchive`, `isArchiveName`, `DISK_IMAGE_PATTERN`; `UrlFetch` (`src/components/ingest/url-fetch.tsx`, unchanged, test ids `url-input`/`url-fetch`/`url-status`); `SetSuggestion`; `DropdownMenu*`; `Modal`.
- Produces:
```ts
// drop-files.ts (client-safe)
/** The disk images a drop carries (R8): image files as they are, folders walked, .zip/.lha opened for the images inside. */
export async function diskFilesFromDrop(items: { name: string; file?: File; kind: 'file' | 'dir' }[]):
  Promise<{ files: File[]; refused: { name: string; reason: string }[] }>;
// tray.ts (client-safe)
export function traySummary(rows: LibRow[]): string;   // "3 added · 1 already in the library · 1 refused" (+ "· 2 working" while busy)
export function trayState(r: LibRow): { word: string; tone: 'busy' | 'done' | 'wait' | 'fail' };   // Hashing… / Uploading… / Added / Already in the library / Refused
```
- Components (markup contract):
  - `LibraryIngestProvider` — context over `useLibraryIngest()` (own row state), wraps the page content INSIDE `CollectionsProvider` (spec §5.5: "tray after CollectionsProvider"), so collection drags and file drops share one tree.
  - `LibraryDropOverlay` — listens on `window` for `dragenter`/`dragover`/`dragleave`/`drop` only when `e.dataTransfer.types` includes `'Files'` (a title card's drag never does); shows a fixed full overlay `data-testid="library-drop-overlay"` reading "Drop to add <n> disks to the library" (`n` = `dataTransfer.items.length` when every item is a file, else "Drop to add disks to the library"); on drop: `readDroppedItems` synchronously, `diskFilesFromDrop`, refused names go into the tray as failed rows (`bad:<name>` keys, as the dropzone does), the rest to `addFiles`. While busy the overlay says "Wait for the disks being added, then drop again" and takes no drop.
  - `AddDisksMenu` — button `library-add-disks` "Add disks ▾" in the header actions (before `CreateAdf`); items `library-add-browse` "Browse files…" (clicks a hidden `<input type="file" multiple accept=".adf,.dsk,.adz,.dms,.dmz,.hfe,.zip,.lha,.lzh" data-testid="file-input">`), `library-add-url` "Paste a URL…" (opens a `Modal` `library-add-url-dialog` holding `UrlFetch`, whose rows go to `addFetched`), and a disabled hint item "or drop disks anywhere on this page". Opens itself when the URL hash is `#add-disks`.
  - `LibraryTray` — `data-testid="library-tray"`, `role="region"` `aria-label="Adding disks"`, sticky to the bottom of the content column, shown when rows exist; summary `library-tray-summary`; rows `library-tray-row` with `data-key="lib:<sha>"` and `data-state`; **Open title** link `library-tray-open-<sha>` → `/games/<gameId>`; the set suggestion inside it; Close `library-tray-close` (disabled while busy).
- Page: `actions` gains `<AddDisksMenu />`; the page body is wrapped as `<LibraryIngestProvider><LibraryDropOverlay /> … <LibraryTray /></LibraryIngestProvider>` inside `CollectionsProvider`; `router.refresh()` after each settle shows the new titles.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/library-ingest/drop-files.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { diskFilesFromDrop } from './drop-files';

const fx = (n: string) => new File([readFileSync(`src/lib/archive/fixtures/${n}`)], n);
describe('diskFilesFromDrop', () => {
  it('keeps images, opens an .lha for the images inside, and names what it refused', async () => {
    const r = await diskFilesFromDrop([
      { name: 'Game.adf', kind: 'file', file: new File([new Uint8Array(901_120)], 'Game.adf') },
      { name: 'disks.lha', kind: 'file', file: fx('disks.lha') },
      { name: 'notes.txt', kind: 'file', file: new File(['x'], 'notes.txt') },
      { name: 't.zip', kind: 'file', file: fx('t.zip') },
      { name: 'Folder', kind: 'dir' },
    ]);
    expect(r.files.map((f) => [f.name, f.size])).toEqual([['Game.adf', 901_120], ['Disk1.adf', 901_120], ['Disk2.adf', 901_120]]);
    expect(r.refused).toEqual([{ name: 'notes.txt', reason: 'not a disk image' }, { name: 't.zip', reason: 'no disk images inside' }]);
  });
});
```

```ts
// src/lib/library-ingest/tray.test.ts
import { describe, it, expect } from 'vitest';
import { traySummary, trayState } from './tray';
const row = (state: any, note?: string) => ({ source: 'lib', key: `lib:${Math.random()}`, kind: 'lib', name: 'x.adf', sizeBytes: 1, state, note, title: null, at: 0 }) as any;
describe('tray', () => {
  it('sums what happened', () => {
    expect(traySummary([row('done'), row('done'), row('deduped'), row('failed', 'bad')])).toBe('2 added · 1 already in the library · 1 refused');
    expect(traySummary([row('hashing'), row('done')])).toBe('1 added · 1 working');
  });
  it('words each state', () => {
    expect(trayState(row('uploading'))).toEqual({ word: 'Uploading…', tone: 'busy' });
    expect(trayState(row('deduped'))).toEqual({ word: 'Already in the library', tone: 'done' });
    expect(trayState(row('failed', 'not a disk'))).toEqual({ word: 'Refused — not a disk', tone: 'fail' });
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/lib/library-ingest` → FAIL.
- [ ] **Step 3: Implement** (folders: `readDroppedItems` already walks them into `{ path, kind, file }`; pass the files on with their base names; an archive over `MAX_ARCHIVE_BYTES` or unreadable → refused "can't open this archive").
- [ ] **Step 4: Run** `pnpm vitest run src/lib/library-ingest src/components && pnpm tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/library-ingest src/components/library-ingest "src/app/(app)/library/page.tsx"
git commit -m "Library: drop disks anywhere (folders and archives too), Add disks ▾ (Browse files…, Paste a URL…), the results tray"
```

---

### Task 6: The Upload page retires; Files in the nav; links, start page, help

**Files:**
- Modify: `src/app/(app)/ingest/page.tsx` (becomes the redirect), `src/components/shell/top-nav.tsx` (+ `top-nav.test.ts`), `src/lib/nav-tabs.ts` (+ test, if it lists `/ingest`), `src/lib/user-prefs-schema.ts` (+ test), `src/components/prefs/preferences-form.tsx`, `src/proxy.ts` (matcher gains `'/files/:path*'`), `src/components/devices/transfer-box.tsx`, `src/components/send/send-button.tsx`, `src/components/remote/remote-disk-actions.tsx`, `src/components/library/title-controls.tsx` (+ `empty-library.test.ts`), `src/lib/help/topics.tsx` (+ `topics.test.ts`)
- Delete (R12, each after `rg -n "<module name>" src e2e cli` shows no importer): `src/components/ingest/staging-list.tsx`, `staging-row.tsx`, `staging-confirm.tsx`, `staging-provider.tsx`, `dropzone.tsx`, `drop-card.tsx` (only if `send-drop-zone`/`stash-drop-zone` no longer import it — they do, so it stays), `src/components/send/send-panel.tsx`, `src/app/api/staging/**`, `src/lib/staging-server.ts`, and their tests; trim `src/lib/upload-staging.ts`/`src/lib/upload-look.ts` to what still has importers (delete them if none).
- Create: `src/lib/files/ingest-redirect.ts` (+ `.test.ts`)

**Interfaces:**
- Produces: `export function ingestRedirect(sp: Record<string, string | string[] | undefined>): string` (R10) and `export function filesHrefForBoard(deviceId: string, active: 'left' | 'right'): string` → `/files?left=STASH:&right=NET%3A%2F<id>&active=<active>` (in `path.ts`, used by the links of R11).
- `ingest/page.tsx`: `export default async function IngestPage(props: PageProps<'/ingest'>) { await requireOrg(); redirect(ingestRedirect(await props.searchParams)); }` (Next's `redirect` from a page answers 307).
- `START_PAGE_PATHS.upload = '/files'`; `START_PAGE_LABELS.upload = 'Files'` (the stored value stays `'upload'`).
- Nav: `{ href: "/files", label: "Files", phone: true }` replaces the Upload item (the comment about `/ingest` goes); current on `/files`.
- Help (exact sentences):
  - `send` body paragraph 2: "**Three ways to send.** On the Files page, drop files or a folder on *Send files to the Amiga*, or press *Choose files*; with more than one board, pick the board under it. In the panes, copy files or folders into *NET:* and the board — from a disk or from *STASH:*. On a title's page, press *Send .adf to Amiga* to send a whole disk as one file. Each waits under *NET:* and the board: waiting, sending, delivered with its saved name, or failed, and why." GoodToKnow: replace "Cancel stops a waiting or sending file; Retry sends a failed one again from the start." and "Clear finished drops …" with "Delete on a waiting or sending file cancels it; on a finished one it clears it. To send a failed file again, copy it into NET: again."; the `short` keeps its text. Update the Sources comment (spec 2026-10-29 §4.3).
  - `from-amiga` `short`: "Send files from your Amiga to the web app with Transfer. They land in STASH: on the Files page, marked with the board, where you can download them, add disk images to your library, copy them onto a disk or send them on." Paragraph 2's "The same four digits appear under the Staging list on the Upload page, so check they match your board." → "The same four digits appear on the board's row under NET: on the Files page, so check they match your board." Paragraph 3 → "**In STASH:.** *Add to library* puts a stored disk image in your library; the toast's *Open title* goes to it. *Delete* removes a file, or stops one still arriving and deletes what arrived." GoodToKnow: drop "Clear finished never removes a stored file; only Delete does."; keep the others.
  - `preferences`: "Library, Devices or Files."
- `topics.test.ts`: the preferences test expects `Files` instead of `Upload`; a new test: no topic body or short contains `Upload page` or `Staging`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/files/ingest-redirect.test.ts
import { describe, it, expect } from 'vitest';
import { ingestRedirect } from './ingest-redirect';
describe('ingest redirects keep the board', () => {
  it('maps /ingest, ?board= and ?from=', () => {
    expect(ingestRedirect({})).toBe('/files');
    expect(ingestRedirect({ board: 'dev 1' })).toBe('/files?left=STASH%3A&right=NET%3A%2Fdev+1&active=right');
    expect(ingestRedirect({ from: 'b2' })).toBe('/files?left=STASH%3A&right=NET%3A%2Fb2&active=left');
    expect(ingestRedirect({ board: ['a', 'b'] })).toBe('/files');
  });
});
```
(`URLSearchParams` encodes `:` and `/`; the Files page parses either form.) In `src/lib/user-prefs-schema.test.ts`: `it('startPage upload means /files', () => expect(startPagePath('upload')).toBe('/files'))` replacing the `/ingest` expectation; in `top-nav.test.ts`: the rendered nav has a `Files` link to `/files` and no `/ingest`; in `empty-library.test.ts`: `href="/library#add-disks"`.

- [ ] **Step 2: Run** `pnpm vitest run src/lib/files/ingest-redirect.test.ts src/lib/user-prefs-schema.test.ts src/components/shell src/components/library src/lib/help` → FAIL.
- [ ] **Step 3: Implement**, then `rg -n "/ingest\b|Upload page|Staging" src --glob '!src/app/api/ingest/**'` → only the redirect page and API paths remain.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm tsc --noEmit -p . && pnpm lint` (changed files) → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/ingest-redirect.ts src/lib/files/ingest-redirect.test.ts src/lib/files/path.ts "src/app/(app)/ingest/page.tsx" \
  src/components/shell/top-nav.tsx src/components/shell/top-nav.test.ts src/lib/nav-tabs.ts src/lib/user-prefs-schema.ts \
  src/lib/user-prefs-schema.test.ts src/components/prefs/preferences-form.tsx src/proxy.ts src/components/devices/transfer-box.tsx \
  src/components/send/send-button.tsx src/components/remote/remote-disk-actions.tsx src/components/library/title-controls.tsx \
  src/components/library/empty-library.test.ts src/lib/help/topics.tsx src/lib/help/topics.test.ts
git rm src/components/ingest/staging-list.tsx src/components/ingest/staging-row.tsx src/components/ingest/staging-confirm.tsx \
  src/components/ingest/staging-provider.tsx src/components/ingest/dropzone.tsx src/components/send/send-panel.tsx \
  src/app/api/staging/route.ts src/app/api/staging/clear/route.ts src/app/api/staging/routes.test.ts src/lib/staging-server.ts
# plus each test file of a deleted module, and upload-staging/upload-look if they lost every importer (git rm by name)
git commit -m "Files replaces Upload: /ingest redirects (board kept), nav and start page say Files, links go to Files, help updated"
```

---

### Task 7: End to end — NET:, the Send drop zone, the Library page

**Files:**
- Create: `e2e/files-net.spec.ts`, `e2e/library-add.spec.ts`
- Modify: `e2e/files.mobile.spec.ts`, `e2e/contrast.spec.ts`, `e2e/helpers.ts` (`stagingReady`/`libRows` replaced by `libraryAddReady(page)` — waits for hydration of `library-add-disks` — and `trayRows(page)` = `[data-testid="library-tray-row"]`)

Use `e2e/amiga-board.ts` (increment 2) plus a send-side `boardTakesNext(request, token, outcome)` moved there from `e2e/send-to-amiga.spec.ts`.

Tests (`e2e/files-net.spec.ts`, desktop):
1. `NET: lists a board on 1.15.0 and not one below` — pair two boards, report `1.15.0+g…` and `1.14.0+g…`; `pane-left-dev-NET` → one `board` row.
2. `copy a folder from a disk into NET:/<board> queues its files with paths and protection` — the deferred increment-1 test (`Send on a folder`): seed the `mods/a.txt` disk of `send-to-amiga.spec.ts` (`seedSendDisk`), left pane `NET:/<board>`, right the disk; select `mods`, Copy ← ; toast "Queued 1 file for Bench"; the board's queue text matches `/^NEXT \S+ 5 [0-9a-f]+ 40 10:mods\/a\.txt 0:\n/`.
3. `the Send drop zone queues a dropped file; Show queue opens NET:/<board>` — `files-send-input` with `hello.txt`; toast action → right pane `NET:/<id>` row `hello.txt` reading Waiting; `boardTakesNext` → within 15 s it reads "Delivered as hello.txt".
4. `a drop that would overfill the queue sends nothing` — 33 small files picked → toast `queue_full` words; the queue text is `NEXT -`.
5. `Delete cancels a waiting file and clears a delivered one`.
6. `copying out of NET: is not offered` — select a NET: row: `files-copy` disabled with title "Files waiting for the Amiga cannot be copied out".
7. `the device card's lines open Files` — `device-send-<id>` → URL `/files?left=STASH:&right=NET%3A%2F<id>&active=right`.
8. `ingest redirects keep the board` — `page.goto('/ingest?board=<id>')` → that URL; `page.goto('/ingest')` → `/files`.

Tests (`e2e/library-add.spec.ts`, desktop):
1. `Add disks ▾ → Browse files… adds a disk; the tray says Added and Open title goes to it` — `file-input` with a formatted ADF (`createAdf`-style bytes from `formatVolume`).
2. `dropping a folder and an .lha anywhere on the page adds the disks inside` — synthetic drop on `body` (`e2e/drag-drop-helpers.ts`) of `src/lib/archive/fixtures/disks.lha` → tray shows `Disk1.adf` and `Disk2.adf` added or already in the library; the overlay appeared during dragenter.
3. `Paste a URL… refuses a private address with words` — `library-add-url` → dialog → `url-input` `http://10.0.0.1/x.adf` → `url-status` shows the address refusal.
4. `dragging a title to a collection shows no overlay` — `e2e/collections.spec.ts`'s card drag helper onto a collection; `library-drop-overlay` never visible; the title joins the collection.
5. `a second drop of the same disk says Already in the library`.

Phone (`e2e/files.mobile.spec.ts`): at 390×844 both drop zones stack; the bottom nav has Files current on `/files`; `noSideways`. Library at 390: Add disks ▾ reachable, tray fits (`noSideways`).

Contrast (`e2e/contrast.spec.ts`): Files block adds the Send drop zone (title, hint, board line, receiver line), NET: queue marks; a Library block adds `library-add-disks`, the overlay text, tray summary and row states.

- [ ] **Step 1:** write the specs and helpers. **Step 2:** `PORT=3100 bash scripts/e2e-local.sh e2e/files-net.spec.ts --project=desktop` → pass (a failure is a defect in the owning task's code). **Step 3:** `… e2e/library-add.spec.ts --project=desktop`, `… e2e/files.mobile.spec.ts --project=mobile`, `… e2e/contrast.spec.ts --project=desktop -g "Files|Library"`. **Step 4:** re-run `e2e/files.spec.ts e2e/files-stash.spec.ts --project=desktop` (the panes gained NET:). **Step 5:** commit:

```bash
git add e2e/files-net.spec.ts e2e/library-add.spec.ts e2e/files.mobile.spec.ts e2e/contrast.spec.ts e2e/helpers.ts e2e/amiga-board.ts
git commit -m "Files: e2e for NET:, the Send drop zone and the Library's drop, menu and tray; contrast"
```

---

### Task 8: Move the remaining e2e off the Upload page

Every spec that drove `/ingest` now fails at its first step. This task moves them, behaviour by behaviour, to where the behaviour lives now; it deletes only tests whose behaviour was retired (R12) and says which in the commit message.

**Files:**
- Modify: `e2e/from-amiga.spec.ts`, `e2e/send-to-amiga.spec.ts`, `e2e/ingest-ui.spec.ts`, `e2e/archive-drop.spec.ts`, `e2e/archive-drop-folder.spec.ts`, `e2e/url-upload.spec.ts`, `e2e/tosec-scan.spec.ts`, `e2e/device-protocol.spec.ts`, `e2e/device-image.spec.ts`, `e2e/hd-disks.spec.ts`, `e2e/hfe-disks.spec.ts`, `e2e/library.spec.ts`, `e2e/nfc-tap.spec.ts`, `e2e/c7-phone.mobile.spec.ts`, `e2e/disk-sets.spec.ts`, `e2e/user-settings.spec.ts`, `e2e/screenshots.shots.ts`, and any other hit of `rg -ln "/ingest|staging-|stagingReady|libRows|send-dropzone|dropzone" e2e`
- Delete: `e2e/upload-staging.spec.ts` (the Staging list, its filter radiogroup, row layout and focus handling are retired; the drop-card behaviours it covered are now Task 7's and increment 2's tests)

Mapping (apply in every file):
- Adding a disk: `page.goto('/ingest')` + `stagingReady` + `file-input`/`url-input` → `page.goto('/library')` + `libraryAddReady(page)` + `library-add-disks` → `library-add-browse` (the same `file-input`), or `library-add-url` → the dialog's `url-input`; rows `libRows(page)` → `trayRows(page)` (`data-state` values unchanged: `hashing|uploading|deduped|done|failed`); "Open title" → `library-tray-open-<sha>`.
- From the Amiga (`from-amiga.spec.ts`): rows → the STASH: pane on `/files?left=STASH:`; Download → select + `files-download`; Delete → `files-delete` + confirm; Add to library → `files-addlib`, then the toast's **Open title**; a failed CRC row → its `failed — …` mark and Copy disabled; Stop → Delete on an `arriving` row; "listed once" and "0 B" via the pane rows; the device card line → Files (Task 6 link). Tests for Clear finished (retired) are removed; the board-side assertions (the board hears `crc`, resume offsets) stay as they are.
- To the Amiga (`send-to-amiga.spec.ts`): `dropFile` → the Files page's `files-send-input`; send rows → the `NET:/<board>` pane rows and their marks; Cancel → Delete; Retry → removed (R4), replaced by "a failed row says why"; the >4 MB refusal and the 1.14.0 board → the Send drop zone and NET: listing; the folder test is Task 7's; Send .adf → toast's "See queue" lands on `NET:/<board>`; the long-queue test → the NET: pane ordering (the waiting file first) and Delete of finished rows.

- [ ] **Step 1:** `rg -ln "/ingest|staging-|stagingReady|libRows|send-dropzone|data-testid=\"dropzone\"" e2e` and convert each file per the mapping. **Step 2:** run them in batches, each under 9 minutes, foreground, one at a time: (a) `e2e/from-amiga.spec.ts`; (b) `e2e/send-to-amiga.spec.ts e2e/device-protocol.spec.ts`; (c) `e2e/ingest-ui.spec.ts e2e/archive-drop.spec.ts e2e/archive-drop-folder.spec.ts e2e/url-upload.spec.ts`; (d) `e2e/hd-disks.spec.ts e2e/hfe-disks.spec.ts e2e/device-image.spec.ts`; (e) `e2e/library.spec.ts e2e/disk-sets.spec.ts e2e/nfc-tap.spec.ts e2e/user-settings.spec.ts`; (f) `e2e/tosec-scan.spec.ts` split by `-g` if it passes 9 minutes; (g) `e2e/c7-phone.mobile.spec.ts --project=mobile`. **Step 3:** any failure that is not a selector the mapping missed is a defect in Tasks 1–6's code: fix it there. **Step 4:** `rg -n "/ingest" e2e` → only the redirect test of Task 7. **Step 5:** commit:

```bash
git add e2e/from-amiga.spec.ts e2e/send-to-amiga.spec.ts e2e/ingest-ui.spec.ts e2e/archive-drop.spec.ts e2e/archive-drop-folder.spec.ts \
  e2e/url-upload.spec.ts e2e/tosec-scan.spec.ts e2e/device-protocol.spec.ts e2e/device-image.spec.ts e2e/hd-disks.spec.ts \
  e2e/hfe-disks.spec.ts e2e/library.spec.ts e2e/nfc-tap.spec.ts e2e/c7-phone.mobile.spec.ts e2e/disk-sets.spec.ts \
  e2e/user-settings.spec.ts e2e/screenshots.shots.ts
git rm e2e/upload-staging.spec.ts
git commit -m "e2e: disks are added on the Library page, Amiga files are in STASH:, sends are in NET:; the Staging list's tests retire with it"
```

---

## After the last task

- Full unit (`pnpm vitest run`), DB (`pnpm test:db`), `pnpm build`, lint on changed files.
- This increment touches the whole app's entry points: run the full e2e suite in < 9-minute foreground batches before merging (the memory rule's "big cross-cutting branch" case).
- HANDOFF §4: increment 3 shipped with the merge hash; record rulings R1–R12; increment 4 (Files settings, the Files and STASH:/NET: help topics, pane "?", phone polish) next.
- Bench (operator, optional): a real Transfer RECEIVE taking a folder copied into NET:, and a real Transfer SEND landing in STASH: with the board mark.
