# Files, increment 2 (STASH:) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** STASH: as a second device of the Files manager: the org's loose files (what the Amiga sends up, what the browser drops or a URL fetches, what is copied out of a disk), with folders, protection and comments, archives (.lha/.zip) that open as read-only folders, Add to library, and copies and moves between STASH: and library disks.

**Architecture:** Increment 1's ops engine is split behind a `VolumeDriver` per device (spec §3.2): LIBRARY: moves into `library-driver.ts` unchanged, a new `stash-driver.ts` lists and writes `amiga_uploads` rows (migration 0051 adds `source` and `kind`), and `ops.ts` becomes a dispatcher that runs same-device operations in their driver and cross-device copies as `collect` on the source driver plus `write` on the destination. The browser uploads straight to the blob store (the same presigned PUT the library uses) and commits rows; archives are read on the server by the existing bounded readers, which learn the dates (and LHA comments) the archive records.

**Tech Stack:** Next.js 16 App Router (params/searchParams are Promises; read `node_modules/next/dist/docs/` before writing routes), React 19, drizzle (Postgres; `pnpm db:generate`), zod 4, vitest (unit `pnpm vitest run`, DB `pnpm test:db` with `TEST_DATABASE_URL` from `bash scripts/dev-db.sh start`), Playwright (`PORT=3100 bash scripts/e2e-local.sh <specs> --project=desktop|mobile`).

**Spec:** `docs/superpowers/specs/2026-10-29-files-manager-design.md` (increment 2 = §9 item 2; §3.2, §4.2, §8). Increment 1's plan (`docs/superpowers/plans/2026-10-29-files-increment-1.md`) and its code on `feat/files` are the base.

## Global Constraints

- Paths: `<DEVICE>:` + `/`-separated segments; titles, disks and boards by **id**; STASH: by **name** (`STASH:/Mods/enigma.mod`, `STASH:/SysInfo4.4.lha/SysInfo/SysInfo`) (spec §3.1).
- One operation = **one new history version per disk it touches** (spec §4.1). STASH: has no versions.
- Copies keep **date, protection and comment**, in both directions and out of archives (as far as the archive records them) (spec §4.1, §4.2).
- A foreign or unknown id or name in a path is **404**, never 403 (spec §8).
- **Free space is checked before writing**: a disk copy that does not fit is refused whole ("needs N KB, M KB free"); a STASH: copy over the org's limit is refused whole: "STASH: holds 500 files / 256 MB; delete some first" (spec §4.1, §4.2, §8).
- AmigaDOS names: at most **30 characters**, no `:` or `/`, Latin-1 only (`amigaNameProblem`); comments at most 79 Latin-1 characters.
- STASH: limits: **4 MB per file from the Amiga** (firmware, unchanged), **20 MB per file for browser drops and URLs**, **500 entries / 256 MB per org** (empty folders count as entries), files kept **30 days** (spec §4.2).
- Copy/move with `onClash: 'ask'` and a clash returns `409 { clashes }` and writes nothing (spec §3.3).
- Archive browsing is read-only, on the server, bounded by `MAX_ARCHIVE_BYTES`, `MAX_ZIP_MEMBER_BYTES`, `MAX_ZIP_TOTAL_BYTES` (spec §4.2, D8).
- Never run `pnpm db:migrate` against production; the controller applies migration 0051.
- Self-host parity: blobs only through `diskStore` (`src/lib/storage`), presigned uploads through `diskStore.uploadUrl` (local backend signs its own), archives read in process (spec §11).
- Never `git add -A`; never `git stash`. e2e: one run at a time, foreground, each run under 9 minutes, `PORT=3100`, via `scripts/e2e-local.sh` (isolated DB). Help text in `src/lib/help/topics.tsx` must change with behaviour it describes.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01UC3JRhVLZ5t9XkU2Ekdf6j`.

## Increment-2 rulings (decisions the spec leaves open)

- **R1 Devices (lifts increment 1's R1).** Device buttons show `STASH:` and `LIBRARY:` (NET: in increment 3). "Files…" and every `filesHrefForDisk` link open `left=STASH:`. The page's defaults become left `STASH:`, right `LIBRARY:`. The Files page gains its first top drop zone, **"Drop files into STASH:"** (increment 3 adds "Send files to the Amiga").
- **R2 Folders and kinds.** Migration 0051 adds `source` (`'amiga' | 'browser' | 'copy'`, default `'amiga'`) **and** `kind` (`'file' | 'dir'`, default `'file'`), and drops NOT NULL on `device_name` (spec: "null for browser/copy"). Folders are implicit from paths; a `kind='dir'` row exists only for an empty folder, a folder made with Makedir, or a folder given protection/comment. One migration, as the spec asks; `kind` is the spec's "empty folders count as entries" made storable.
- **R3 Names.** STASH: names follow AmigaDOS rules so anything in STASH: can go to a disk or the Amiga: browser and URL names pass through `cleanAmigaPath` (the Amiga upload's own cleaner: `:` → `_`, over 30 characters shortened keeping a short extension); a name that cleans to nothing is refused per file (`bad_name`). Names compare case-insensitively.
- **R4 One name, one entry.** When a file lands at a path STASH: already holds (an Amiga upload stored again, a URL fetch), it is stored under the keep-both name (`ReadMe_1`), never beside a same-named twin. The board still hears the name it sent. Rows from before 0051 that already share a path are shown with keep-both names by the tree (oldest keeps the name); the first rename or move stores the shown name.
- **R5 What STASH: lists.** Every non-deleted row not past its expiry: stored files, files still arriving (mark `arriving 45%`, not a copy source), and failed ones (mark `failed — <reason>`, so Delete can clear them). The Upload page's From the Amiga list (still live until increment 3) keeps listing only `source='amiga'`, `kind='file'` rows, and its Clear all touches only those.
- **R6 Browser uploads.** Files go browser → blob store by presigned PUT (`diskStore.uploadUrl`), then `POST /api/files/stash/commit` verifies size and sha-256 on the server and inserts rows. One commit carries at most **64 MB / 200 entries**; the client splits a drop by top-level item, so a single dropped folder over 64 MB is refused with "Drop folders of up to 64 MB at a time". The client asks about clashes from the listing it already has (it knows the folder's names) and sends the chosen `onClash`; the server still answers 409 `clashes` on a race.
- **R7 Paste URL.** `POST /api/files/stash/url` fetches with `fetchUrlSafely` (20 MB, SSRF guard, the per-user `takeUrlFetch` rate limit) and stores ONE file at the STASH: root under `nameFromResponse` cleaned by R3; a clash is keep-both (no dialog for a single fetched file).
- **R8 Add to library.** A button-column action **Add to library** (`files-addlib`) shown while the active pane is in STASH:; enabled only when every selected entry is a stored disk-image file (`libraryEligible`). It is an op (`{ op: 'add-to-library', sources }`) running the logic of `POST /api/uploads/[id]/library`, extracted unchanged into `src/lib/stash-library.ts`. Archive members are not offered (copy them out first).
- **R9 Downloads.** One STASH: file → `/api/files/download?path=` (always an attachment, `x-content-type-options: nosniff`, as `/api/uploads/[id]/file` does). Several entries, or a folder, from STASH: and/or LIBRARY: → one .zip through a device-neutral zipper (`zipIncoming`).
- **R10 Archive dates.** DOS date/time fields (LHA level 0/1 base header, zip) carry no time zone; they are read as wall-clock time and stored as that UTC instant (an Amiga date has no zone either). A Unix time (LHA extension `0x54`, LHA level 2 header, zip `UT` extra `0x5455`) is UTC and wins over the DOS field when present.
- **R11 Zip protection.** A zip member made on an Amiga (central-directory "version made by" host byte = 1) carries the AmigaDOS protection word in the high 16 bits of its external attributes (Info-ZIP's Amiga port): `protection = (externalAttrs >>> 16) & 0xff`. Any other host → `null`, as today.

## Review Focus

1. **The same name twice in STASH:.** The Amiga sends `ReadMe` again a day later, or a drop brings a name STASH: holds: both are kept, the newcomer as `ReadMe_1`, and the listing never shows two entries with one name → Task 2 test `a second upload of the same path keeps both`, and Task 2 test `the tree names legacy twins apart`.
2. **The org limit at the edge.** Copying a folder of 30 files into a STASH: holding 480 entries is refused whole with the limit words; not one row is inserted → Task 5 test `over the org limit refuses the whole copy`.
3. **An archive that cannot be opened.** Opening a corrupt or over-cap .lha answers "Can't open this archive", the entry stays and still downloads → Task 4 test `an unreadable archive refuses its listing but still reads whole`.
4. **A long Windows file name.** A dropped `A very long file name from Windows 11.txt` (41 characters) is stored under a 30-character name and can then be copied onto a disk → Task 6 test `commit cleans a long name to 30 characters`.
5. **A folder still arriving.** Copying a STASH: folder while the Amiga is still sending one of its files refuses that folder ("still arriving from the Amiga") instead of copying half of it; deleting the folder stops the arrival too → Task 5 tests `a folder with a file still arriving is not copied` and `delete takes an arriving file too`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/lib/files/driver.ts` (+ `.test.ts`) | `VolumeDriver` interface, shared op types, `Refused`/`refuse`, name/comment checks, `keepBothName`. Server only (no DB imports itself). |
| `src/lib/files/drivers.ts` | `driverFor(device)`: the one registry. |
| `src/lib/files/library-driver.ts` | LIBRARY:'s ops engine, moved out of `ops.ts` unchanged, plus `collect`/`write`/`remove(unchanged)` for cross-device copies. |
| `src/lib/files/ops.ts` | `runOp` dispatcher: same-device ops to their driver; cross-device copy/move; `add-to-library`. |
| `drizzle/0051_stash.sql`, `src/db/schema/amiga-uploads.ts` | `source`, `kind`, nullable `device_name`. |
| `src/lib/files/stash-paths.ts` (+ `.test.ts`) | Client-safe: Amiga date text ⇄ Date, the STASH: tree, `uniqueStashPath`, batch planning for browser commits. |
| `src/lib/stash.ts` (+ `stash.db.test.ts`) | STASH:'s store over `amiga_uploads`: list, insert under the org limit, delete, move paths, set meta. |
| `src/lib/amiga-uploads.ts` | The Upload page's queries keep to `source='amiga'`; `closeUpload` stores under a unique path (R4). |
| `src/lib/archive/zip.ts`, `lha.ts` (+ tests) | Members carry `date` (and LHA `comment`; Amiga zip protection). |
| `src/lib/files/stash-archive.ts` | Open an archive blob on the server as a tree of members. |
| `src/lib/files/stash-driver.ts` (+ `stash-driver.db.test.ts`) | STASH: driver: list, read, collect, write, remove, makedir, rename, setMeta, within. |
| `src/lib/stash-library.ts` | Add to library, extracted from `POST /api/uploads/[id]/library`. |
| `src/lib/disk-zip.ts` | `zipIncoming`: a zip of collected items from any device. |
| `src/app/api/files/{list,download,ops}/route.ts` | Through the drivers. |
| `src/app/api/files/stash/{presign,commit,url}/route.ts` | Browser upload and Paste URL into STASH:. |
| `src/components/files/*` | STASH: device button, archives, Add to library, the STASH: drop zone, drops from the computer into STASH:. |
| `e2e/amiga-board.ts`, `e2e/files-stash.spec.ts`, `e2e/files.mobile.spec.ts`, `e2e/contrast.spec.ts` | End to end. |

---

### Task 1: The driver seam (LIBRARY: moves in, nothing changes)

Increment 1's `ops.ts` refuses any non-LIBRARY path in `locate()`. This task puts a `VolumeDriver` per device between the routes/engine and the storage, moves the LIBRARY: engine behind it verbatim, and leaves every existing test green without edits (only imports of moved symbols may change).

**Files:**
- Create: `src/lib/files/driver.ts`, `src/lib/files/drivers.ts`, `src/lib/files/library-driver.ts`
- Modify: `src/lib/files/ops.ts` (becomes the dispatcher), `src/lib/files/library.ts` (`FsCtx` re-exported from `driver.ts`)
- Test: `src/lib/files/driver.test.ts`; add one case to `src/lib/files/ops.db.test.ts`

**Interfaces:**
- Consumes: increment 1 `listLibrary`, `readLibraryFile`, `loadDisk`, `resolveInDisk`, `readOnlyReasonOf` (`library.ts`); all of `ops.ts`.
- Produces (`driver.ts`):
```ts
import type { Device, FsPath } from './path';
import type { Listing, Refusal, RefusalCode } from './types';
import type { OpVersion } from './edit-rules';

export type FsCtx = { orgId: string; userId: string | null };
/** The caller's context while an op runs, collecting every history version its edits save. */
export type OpCtx = FsCtx & { versions: OpVersion[] };
export type OnClash = 'ask' | 'replace' | 'skip' | 'keep-both';
export type OpItem = { source: string; ok: true } | { source: string; ok: false; refusal: Refusal };
export type Clash = { source: string; name: string; dest: string };
/** A disk image Add to library placed (Task 5). */
export type Added = { source: string; gameId: string; diskId: string };
export type Outcome = { kind: 'done'; items: OpItem[]; added?: Added[] } | { kind: 'clashes'; clashes: Clash[] };
export type FileBytes = { name: string; bytes: Uint8Array; date: Date | null; protection: string; comment: string | null };
/** One entry of a copy, a folder before what it holds; rel[0] is the copied entry's own name. `sha256` when the bytes are already in diskStore. */
export type IncomingItem = { rel: string[]; kind: 'file' | 'dir'; bytes?: Uint8Array; sha256?: string; date: Date | null; protection: number; comment: string | null };
export type IncomingTop = { source: string; items: IncomingItem[] };
export type CopyMove = { op: 'copy' | 'move'; sources: string[]; dest: string; onClash: OnClash };

export class Refused extends Error { constructor(readonly refusal: Refusal, readonly status: number) }
export function refuse(code: RefusalCode, status: number, detail?: string): never;
export function checkName(name: string): void;          // moved from ops.ts: bad_name 400 with the amigaNameProblem
export function checkComment(comment: string): void;    // moved from ops.ts
export function keepBothName(name: string, taken: (n: string) => boolean): string;   // moved from ops.ts
export const REMOVE_FAILED = 'copied, but the original could not be removed';
export function itemResult(source: string, fn: () => void): OpItem;                  // moved from ops.ts

export interface VolumeDriver {
  readonly device: Device;
  list(ctx: FsCtx, p: FsPath): Promise<Listing | null>;                // null = not found (404)
  read(ctx: FsCtx, p: FsPath): Promise<FileBytes | null>;              // a file's bytes + meta; null for a folder or not found
  collect(ctx: FsCtx, p: FsPath): Promise<IncomingItem[] | null>;      // one entry walked, for a copy to another device
  within?(ctx: OpCtx, req: CopyMove): Promise<Outcome>;                // copy/move with every source and the dest on this device
  write?(ctx: OpCtx, dir: FsPath, tops: IncomingTop[], onClash: OnClash): Promise<Outcome>;   // absent = read-only device
  /** With `unchanged`, a source is removed only while it is still exactly what was collected (a move's second half). */
  remove?(ctx: OpCtx, sources: string[], unchanged?: ReadonlyMap<string, IncomingItem[]>): Promise<Outcome>;
  makedir?(ctx: OpCtx, dir: FsPath, name: string): Promise<Outcome>;
  rename?(ctx: OpCtx, source: string, name: string): Promise<Outcome>;
  setMeta?(ctx: OpCtx, sources: string[], meta: { protection?: number; comment?: string }): Promise<Outcome>;
}
```
- Produces (`drivers.ts`): `export function driverFor(device: Device): VolumeDriver | null` — LIBRARY only in this task; Task 4 adds STASH; increment 3 adds NET.
- Produces (`library-driver.ts`): `export const libraryDriver: VolumeDriver` with `list = listLibrary`, `read = readLibraryFile`, `collect`, `within` (= increment 1's `copyOrMove`), `write`, `remove` (`deleteMany`, or with `unchanged` the `stillAsCopied` removal), `makedir` (`makeDir`), `rename` (`renameOne`), `setMeta` (`protectMany` when `protection` is set, `commentOne` when `comment` is set; both set → protect then comment, two versions is not allowed: refuse `unsupported` "one change at a time" — the UI never sends both).
- Produces (`ops.ts`): unchanged exports `runOp`, `OpRequest`, `OpItem`, `OpResult` (re-exported types from `driver.ts`), `keepBothName` (re-export).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/files/driver.test.ts
import { describe, it, expect } from 'vitest';
import { driverFor } from './drivers';
import { keepBothName, refuse, Refused, checkName } from './driver';

describe('driverFor', () => {
  it('has LIBRARY: with every operation, and nothing for a device not built yet', () => {
    const lib = driverFor('LIBRARY')!;
    expect(lib.device).toBe('LIBRARY');
    for (const m of ['list', 'read', 'collect', 'within', 'write', 'remove', 'makedir', 'rename', 'setMeta'] as const) {
      expect(typeof lib[m], m).toBe('function');
    }
    expect(driverFor('NET')).toBeNull();
  });
});

describe('shared helpers', () => {
  it('refuse throws a Refused carrying the code, status and detail', () => {
    try { refuse('disk_full', 400, 'needs 2 KB, 1 KB free'); } catch (e) {
      expect(e).toBeInstanceOf(Refused);
      expect((e as Refused).refusal).toEqual({ code: 'disk_full', detail: 'needs 2 KB, 1 KB free' });
      expect((e as Refused).status).toBe(400);
    }
  });
  it('checkName refuses with the problem as the detail', () => {
    expect(() => checkName('a:b')).toThrow(Refused);
    expect(() => checkName('ReadMe')).not.toThrow();
  });
  it('keepBothName is the one increment 1 shipped', () => {
    expect(keepBothName('a.txt', (n) => n === 'a_1.txt')).toBe('a_2.txt');
  });
});
```

Add to `src/lib/files/ops.db.test.ts` (inside a new `describe('devices')`):

```ts
it('a device with no driver is unsupported, and nothing is written', async () => {
  const s = await sha('d2');
  expect(await runOp(ctx, { op: 'delete', sources: ['NET:/board1/x'] }))
    .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
  expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'NET:/board1', onClash: 'ask' }))
    .toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'unsupported' } });
  expect(await sha('d2')).toBe(s);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/lib/files/driver.test.ts`
Expected: FAIL, "Cannot find module './drivers'".

- [ ] **Step 3: Implement**

1. Create `driver.ts` with the Interfaces above; move `Refused`, `refuse`, `checkName`, `checkComment`, `keepBothName`, `itemResult` there from `ops.ts` (bodies unchanged). `FsCtx` moves here; `library.ts` keeps `export type { FsCtx } from './driver'` so its importers do not change.
2. Create `library-driver.ts`: move every function of `ops.ts` from `// ---- paths, disks, edits` to the end into it (bodies unchanged). `locate()` keeps refusing a non-LIBRARY path (the dispatcher never sends it one). Then:
   - `collect(ctx, p)`: `locateEntry(formatPath(p))`, `diskOf`, `entryAt`, then `walk(d.bytes, hit.entry, [hit.entry.name], out)`; a `Refused` from `walk` propagates; `null` when not found (catch `Refused` with code `not_found` → null).
   - `write(ctx, dir, tops, onClash)`: extract from `copyOrMove` the part that, given the destination disk and folder, checks top-level clashes (ask → `clashes`), applies skip / keep-both / replace, checks capacity (`blocksForPlan` vs `readUsage().freeBlocks` + freed) and writes ONE `edit(ctx, dd, chain(...deletes, applyBatch(ops), ...dirBits))`. Name it `writeTops(ctx, dd, destLoc, dest, tops, onClash, extra: { deletes: Step[]; moves: Step[]; freed: number })` and call it from `copyOrMove` for its non-local adds, so increment 1's behaviour stays byte-for-byte the same; `write` calls it with empty extras. A top whose `items[0].rel[0]` fails `checkName` is refused per item (`bad_name`).
   - `remove(ctx, sources, unchanged)`: without `unchanged` → `deleteMany`; with it → the per-disk `stillAsCopied` loop now at the end of `copyOrMove`, extracted as `removeCopied(ctx, list)` and used by both (`unchanged.get(source)` is the `copied` list).
3. `drivers.ts`: `const DRIVERS: Partial<Record<Device, VolumeDriver>> = { LIBRARY: libraryDriver }; export function driverFor(d: Device) { return DRIVERS[d] ?? null; }`.
4. `ops.ts` becomes:
```ts
export async function runOp(ctx: FsCtx, req: OpRequest): Promise<OpResult> {
  const run: OpCtx = { ...ctx, versions: [] };
  try {
    const r = await dispatch(run, req);
    return r.kind === 'done' ? { ...r, versions: run.versions } : r;
  } catch (e) {
    if (e instanceof Refused) return { kind: 'refused', refusal: e.refusal, status: e.status };
    throw e;
  }
}

function pathOf(raw: string): FsPath {
  const p = parsePath(raw);
  if (!p) refuse('not_found', 404);
  return p;
}
function driverOf(p: FsPath): VolumeDriver {
  const d = driverFor(p.device);
  if (!d) refuse('unsupported', 400, `${p.device}: is not available yet`);
  return d;
}
function need<K extends keyof VolumeDriver>(d: VolumeDriver, k: K): NonNullable<VolumeDriver[K]> {
  const f = d[k];
  if (!f) refuse('read_only', 409, `${d.device}: cannot be changed that way`);
  return f as NonNullable<VolumeDriver[K]>;
}

async function dispatch(ctx: OpCtx, req: OpRequest): Promise<Outcome> {
  switch (req.op) {
    case 'copy': case 'move': {
      const dest = pathOf(req.dest); const dd = driverOf(dest);
      const srcs = req.sources.map(pathOf); srcs.forEach(driverOf);
      if (srcs.every((s) => s.device === dest.device)) return need(dd, 'within').call(dd, ctx, req);
      return crossDevice(ctx, req, srcs, dest);
    }
    case 'delete': return perDevice(ctx, req.sources, (d, s) => need(d, 'remove').call(d, ctx, s));
    case 'protect': return perDevice(ctx, req.sources, (d, s) => need(d, 'setMeta').call(d, ctx, s, { protection: req.protection }));
    case 'comment': { const p = pathOf(req.source); const d = driverOf(p); return need(d, 'setMeta').call(d, ctx, [req.source], { comment: req.comment }); }
    case 'rename': { const p = pathOf(req.source); const d = driverOf(p); return need(d, 'rename').call(d, ctx, req.source, req.name); }
    case 'makedir': { const p = pathOf(req.dest); const d = driverOf(p); return need(d, 'makedir').call(d, ctx, p, req.name); }
  }
}

/** Sources grouped by device, one driver call per device; one device: its refusal is the op's, several: per item. */
async function perDevice(ctx: OpCtx, sources: string[], run: (d: VolumeDriver, s: string[]) => Promise<Outcome>): Promise<Outcome> { /* group by pathOf(s).device; for several groups catch Refused per group and mark its items; merge items in the order of `sources` */ }

/** Increment 2 Task 5 fills this in; until then a copy between devices is unsupported. */
async function crossDevice(_ctx: OpCtx, _req: CopyMove, _srcs: FsPath[], dest: FsPath): Promise<Outcome> {
  refuse('unsupported', 400, `copying into ${dest.device}: from another device`);
}
```
   `protectMany` validated `protection` (0..0xff) inside the engine; that check moves with it into `libraryDriver.setMeta`. `commentOne`'s `checkComment` likewise.

- [ ] **Step 4: Run**

Run: `pnpm vitest run src/lib/files && export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1) && pnpm test:db src/lib/files src/app/api/files && pnpm tsc --noEmit -p .`
Expected: PASS — every increment-1 test unchanged, plus the new ones; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/driver.ts src/lib/files/driver.test.ts src/lib/files/drivers.ts src/lib/files/library-driver.ts \
  src/lib/files/ops.ts src/lib/files/library.ts src/lib/files/ops.db.test.ts
git commit -m "Files: a VolumeDriver per device; LIBRARY: moves behind it unchanged; ops.ts dispatches"
```

---

### Task 2: Migration 0051 and the STASH: store

**Files:**
- Modify: `src/db/schema/amiga-uploads.ts`, `src/lib/amiga-uploads.ts` (`listUploads`, `clearUploads`, `uploadSummaries`, `closeUpload`, `toUploadView`), `src/lib/staging-server.ts` (nothing: it reads `listUploads`)
- Create: `drizzle/0051_stash.sql` (generated) + `drizzle/meta/*` (generated), `src/lib/files/stash-paths.ts`, `src/lib/stash.ts`
- Test: `src/lib/files/stash-paths.test.ts`, `src/lib/stash.db.test.ts`

**Interfaces:**
- Consumes: `amigaUploads` schema; `UPLOAD_AREA_MAX_FILES`, `UPLOAD_AREA_MAX_BYTES`, `UPLOAD_KEEP_MS` (`src/lib/amiga-upload-limits.ts`); `keepBothName` (Task 1, `driver.ts`): it moves into the client-safe `stash-paths.ts` and `driver.ts` re-exports it.
- Produces (`stash-paths.ts`, client-safe, no value imports except `./path`):
```ts
export const STASH_FILE_MAX = 20 * 1024 * 1024;        // browser drops and URLs (spec §4.2)
export const STASH_COMMIT_MAX_BYTES = 64 * 1024 * 1024; // one browser commit (R6)
export const STASH_COMMIT_MAX_ENTRIES = 200;
export function amigaDateText(d: Date): string;          // "days.mins.ticks" since 1978-01-01 UTC, as the board sends
export function dateOfAmigaText(s: string): Date | null;
export const sameStashName: (a: string, b: string) => boolean;   // case-insensitive (toLowerCase on both)
export function keepBothName(name: string, taken: (n: string) => boolean): string;
export type StashNode = { name: string; kind: 'dir' | 'file'; row: number | null; children: StashNode[] };
/** Rows (oldest first) as a tree; implicit folders have row null; a later twin of a name gets the keep-both name (R4). */
export function stashTree(rows: readonly { path: string; kind: 'file' | 'dir' }[]): StashNode;
export function stashFind(root: StashNode, names: readonly string[]): StashNode | null;
/** Row indexes of a node and everything under it. */
export function rowsUnder(n: StashNode): number[];
/** `path` placed among `rows` without a clash: an existing folder is joined (its spelling kept), a clash renamed keep-both. */
export function uniqueStashPath(rows: readonly { path: string; kind: 'file' | 'dir' }[], path: string): string;
```
- Produces (`stash.ts`, server only):
```ts
export type StashSource = 'amiga' | 'browser' | 'copy';
export type StashRow = {
  id: string; path: string; kind: 'file' | 'dir'; status: 'stored' | 'receiving' | 'failed';
  sizeBytes: number; receivedBytes: number; blobSha256: string | null; protection: number; comment: string;
  date: Date | null; source: StashSource; deviceName: string | null; errorCode: string | null;
  libraryDiskId: string | null; createdAt: Date;
};
export type NewStashEntry = { path: string; kind: 'file' | 'dir'; sha256: string | null; sizeBytes: number; date: Date | null; protection: number; comment: string };
export const STASH_FULL = 'STASH: holds 500 files / 256 MB; delete some first';
/** Live rows, oldest first (R5): stored and not past 30 days, receiving within 24 h, failed. */
export async function listStash(db: Db, orgId: string, now?: Date): Promise<StashRow[]>;
/** All or nothing under the org lock: `replaceIds` are deleted in the same transaction and not counted. */
export async function insertStash(db: Db, orgId: string, source: 'browser' | 'copy', entries: NewStashEntry[],
  opts?: { replaceIds?: string[]; now?: Date }): Promise<{ ok: true; ids: string[] } | { ok: false; code: 'stash_full' }>;
export async function deleteStash(db: Db, orgId: string, ids: string[]): Promise<number>;   // status deleted, chunks gone; receiving rows too
export async function moveStash(db: Db, orgId: string, moves: { id: string; path: string }[]): Promise<void>;
export async function setStashMeta(db: Db, orgId: string, ids: string[], meta: { protection?: number; comment?: string }): Promise<void>;
```

- [ ] **Step 1: Change the schema and generate the migration**

In `src/db/schema/amiga-uploads.ts`: `deviceName: text('device_name')` (no `.notNull()`; comment: "null for browser and copy rows, spec 2026-10-29 §4.2"); add after `status`:
```ts
  /** Where the row came from (Files spec 2026-10-29 §4.2): amiga (Transfer), browser (a drop or URL), copy (Files). */
  source: text('source').notNull().default('amiga'),
  /** file, or dir: an empty folder, a Makedir, or a folder with protection or a comment (increment 2 R2). */
  kind: text('kind').notNull().default('file'),
```
Run: `pnpm db:generate --name stash`
Expected: `drizzle/0051_stash.sql` containing exactly (order may differ):
```sql
ALTER TABLE "amiga_uploads" ALTER COLUMN "device_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "amiga_uploads" ADD COLUMN "source" text DEFAULT 'amiga' NOT NULL;--> statement-breakpoint
ALTER TABLE "amiga_uploads" ADD COLUMN "kind" text DEFAULT 'file' NOT NULL;
```
If it contains anything else, stop: the snapshot is out of date with the schema; do not hand-edit beyond these three statements. Do NOT run `db:migrate` against production.

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/files/stash-paths.test.ts
import { describe, it, expect } from 'vitest';
import { amigaDateText, dateOfAmigaText, stashTree, stashFind, rowsUnder, uniqueStashPath, keepBothName } from './stash-paths';

describe('Amiga date text', () => {
  it('round-trips to the tick and matches what the board sends', () => {
    const d = new Date(Date.UTC(2026, 9, 29, 12, 34, 56, 780));
    expect(dateOfAmigaText(amigaDateText(d))!.toISOString()).toBe('2026-10-29T12:34:56.780Z');
    expect(dateOfAmigaText('17000.600.0')!.toISOString()).toBe('2024-07-18T10:00:00.000Z');
  });
  it('refuses junk and out-of-range values', () => {
    for (const s of ['', '1.2', 'a.b.c', '1.1440.0', '1.0.3000']) expect(dateOfAmigaText(s), s).toBeNull();
  });
});

const r = (path: string, kind: 'file' | 'dir' = 'file') => ({ path, kind });

describe('stashTree', () => {
  it('builds implicit folders and finds case-insensitively', () => {
    const t = stashTree([r('Mods/a.mod'), r('Mods/Old/b.mod'), r('ReadMe'), r('Empty', 'dir')]);
    expect(t.children.map((c) => [c.name, c.kind, c.row])).toEqual([['Mods', 'dir', null], ['ReadMe', 'file', 2], ['Empty', 'dir', 3]]);
    expect(stashFind(t, ['mods', 'old', 'B.MOD'])!.row).toBe(1);
    expect(rowsUnder(stashFind(t, ['Mods'])!).sort()).toEqual([0, 1]);
    expect(stashFind(t, ['ReadMe', 'x'])).toBeNull();
  });
  it('the tree names legacy twins apart: the oldest keeps the name', () => {
    const t = stashTree([r('ReadMe'), r('readme'), r('Mods'), r('Mods/a.mod')]);
    expect(t.children.map((c) => [c.name, c.row])).toEqual([['ReadMe', 0], ['readme_1', 1], ['Mods', 2], ['Mods_1', null]]);
    expect(stashFind(t, ['Mods_1', 'a.mod'])!.row).toBe(3);
  });
  it('a dir row for a folder that also has files is that folder', () => {
    const t = stashTree([r('S', 'dir'), r('S/Startup')]);
    expect(t.children).toHaveLength(1);
    expect(t.children[0]).toMatchObject({ name: 'S', kind: 'dir', row: 0 });
  });
});

describe('uniqueStashPath', () => {
  const rows = [r('ReadMe'), r('Mods/a.mod'), r('Tools', 'dir')];
  it('keeps a free path and joins an existing folder in its own spelling', () => {
    expect(uniqueStashPath(rows, 'New.txt')).toBe('New.txt');
    expect(uniqueStashPath(rows, 'mods/b.mod')).toBe('Mods/b.mod');
  });
  it('renames a clashing leaf, and a folder segment that clashes with a file', () => {
    expect(uniqueStashPath(rows, 'readme')).toBe('readme_1');
    expect(uniqueStashPath(rows, 'ReadMe/x.txt')).toBe('ReadMe_1/x.txt');
    expect(uniqueStashPath(rows, 'Mods')).toBe('Mods_1');
  });
  it('keepBothName numbers before the extension', () => {
    expect(keepBothName('a.txt', () => false)).toBe('a_1.txt');
  });
});
```

```ts
// src/lib/stash.db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_stash_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-stash-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, and } = await import('drizzle-orm');
const { crc32 } = await import('node:zlib');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { amigaUploads } = await import('@/db/schema/amiga-uploads');
const { insertStash, listStash, deleteStash, moveStash, setStashMeta, STASH_FULL } = await import('./stash');
const { openUpload, storeChunk, closeUpload, listUploads, clearUploads } = await import('./amiga-uploads');

const db = () => getDb();
const file = (path: string, size = 5) => ({ path, kind: 'file' as const, sha256: 'a'.repeat(64), sizeBytes: size, date: new Date(Date.UTC(2020, 0, 2)), protection: 0, comment: '' });
async function upload(path: string, data: Buffer, date: string) {
  const o = await openUpload(db(), { deviceId: 'dev1', orgId: 'o1' }, { size: data.length, date, protection: 0, path, comment: '' });
  if (!o.ok) throw new Error(o.code);
  if (data.length) await storeChunk(db(), 'dev1', o.id, 0, new Uint8Array(data));
  return { id: o.id, close: await closeUpload(db(), 'dev1', o.id, crc32(data) >>> 0) };
}

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(db(), { migrationsFolder: 'drizzle' });
  await db().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  await db().insert(devices).values({ id: 'dev1', orgId: 'o1', name: 'A500 bench', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1' });
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('STASH: store', () => {
  it('inserts browser files and an empty folder, listed with source, kind and date; another org sees nothing', async () => {
    const r = await insertStash(db(), 'o1', 'browser', [file('Docs/a.txt'), { ...file('Empty'), kind: 'dir', sha256: null, sizeBytes: 0 }]);
    expect(r.ok).toBe(true);
    const rows = await listStash(db(), 'o1');
    expect(rows.map((x) => [x.path, x.kind, x.source, x.status, x.deviceName])).toEqual([
      ['Docs/a.txt', 'file', 'browser', 'stored', null], ['Empty', 'dir', 'browser', 'stored', null]]);
    expect(rows[0].date?.toISOString()).toBe('2020-01-02T00:00:00.000Z');
    expect(await listStash(db(), 'o2')).toEqual([]);
  });
  it('the Upload page lists only files from the Amiga, and its Clear all leaves STASH: rows', async () => {
    await upload('From/amiga.txt', Buffer.from('hi'), '17000.600.0');
    expect((await listUploads(db(), 'o1', null)).map((u) => u.path)).toEqual(['From/amiga.txt']);
    const views = await listUploads(db(), 'o1', null);
    await clearUploads(db(), 'o1', views[0].cursor);
    expect((await listStash(db(), 'o1')).map((x) => x.path)).toEqual(['Docs/a.txt', 'Empty']);
  });
  it('a second upload of the same path keeps both: the newcomer is stored as name_1, and the board hears its own name', async () => {
    const one = await upload('Mods/ReadMe', Buffer.from('one'), '17000.600.0');
    const two = await upload('mods/readme', Buffer.from('two'), '17001.600.0');
    expect(two.close).toEqual({ ok: true, name: 'mods/readme' });
    const paths = (await listStash(db(), 'o1')).filter((x) => x.source === 'amiga').map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(['Mods/ReadMe', 'Mods/readme_1']));
    await deleteStash(db(), 'o1', [one.id, two.id]);
  });
  it('refuses a batch that would pass 500 entries, inserting nothing', async () => {
    const live = (await listStash(db(), 'o1')).length;
    const fill = Array.from({ length: 500 - live - 1 }, (_, i) => file(`Fill/f${i}`, 1));
    expect((await insertStash(db(), 'o1', 'copy', fill)).ok).toBe(true);
    expect(await insertStash(db(), 'o1', 'copy', [file('x1', 1), file('x2', 1)])).toEqual({ ok: false, code: 'stash_full' });
    expect((await listStash(db(), 'o1')).length).toBe(499);
    const fillIds = (await listStash(db(), 'o1')).filter((x) => x.path.startsWith('Fill/')).map((x) => x.id);
    expect(await deleteStash(db(), 'o1', fillIds)).toBe(fillIds.length);
  });
  it('refuses a batch that would pass 256 MB; replaced rows do not count', async () => {
    const big = await insertStash(db(), 'o1', 'copy', [file('big.bin', 256 * 1024 * 1024 - 10)]);
    expect(big.ok).toBe(true);
    expect(await insertStash(db(), 'o1', 'copy', [file('y', 11)])).toEqual({ ok: false, code: 'stash_full' });
    const ids = (big as { ids: string[] }).ids;
    expect((await insertStash(db(), 'o1', 'copy', [file('big.bin', 20)], { replaceIds: ids })).ok).toBe(true);
    expect(STASH_FULL).toMatch(/500 files \/ 256 MB/);
  });
  it('moves paths and sets protection and comment on the org\'s rows only', async () => {
    const [a] = (await listStash(db(), 'o1')).filter((x) => x.path === 'Docs/a.txt');
    await moveStash(db(), 'o1', [{ id: a.id, path: 'Papers/a.txt' }]);
    await setStashMeta(db(), 'o1', [a.id], { protection: 0x05, comment: 'kept' });
    await setStashMeta(db(), 'o2', [a.id], { comment: 'not yours' });
    const [b] = (await listStash(db(), 'o1')).filter((x) => x.id === a.id);
    expect([b.path, b.protection, b.comment]).toEqual(['Papers/a.txt', 5, 'kept']);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run src/lib/files/stash-paths.test.ts; pnpm test:db src/lib/stash.db.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

1. `stash-paths.ts`:
   - `amigaDateText(d)`: days = floor((t − Date.UTC(1978,0,1)) / 86 400 000), mins and ticks (1/50 s) of the rest, `${days}.${mins}.${ticks}`, each clamped ≥ 0. `dateOfAmigaText(s)`: `/^(\d{1,6})\.(\d{1,5})\.(\d{1,5})$/`, mins < 1440, ticks < 3000, else null.
   - `keepBothName`: move the body from `driver.ts`; `driver.ts` now `export { keepBothName } from './stash-paths'`.
   - `stashTree(rows)`: for each row in order, split `path` by `/`; walk from the root, at each non-last segment find a child with `sameStashName`: a `dir` → descend; a `file` → this row's segment is shown as `keepBothName(seg, taken among siblings)` and a new implicit dir is created under that shown name; none → create an implicit dir. At the last segment: a `kind:'dir'` row matching an existing implicit dir with row null → set its `row`; otherwise any existing child of that name → add under `keepBothName`; else add. Return the root `{ name: '', kind: 'dir', row: null, children }`.
   - `stashFind`: descend by `sameStashName`; a file before the last name → null.
   - `uniqueStashPath(rows, path)`: `stashTree(rows)`, then walk `path`'s segments: a non-last segment that finds a dir → use the found child's `name`; that finds a file → replace with `keepBothName(seg, siblings)` and copy the rest unchanged; at the last segment any existing child → `keepBothName`. Join with `/`.
2. `stash.ts`: `listStash` selects `amigaUploads` where `orgId`, `status <> 'deleted'`, and `(status='stored' and expiresAt > now) or (status='receiving' and expiresAt > now) or status='failed'`, ordered `createdAt asc, id asc`; map `amigaDate` through `dateOfAmigaText`, `kind`/`source`/`status` narrowed. `insertStash` runs in `db.transaction`: `pg_advisory_xact_lock(hashtext('amiga_uploads:' || orgId))` (the same key `openUpload` takes), counts live rows (`status in ('receiving','stored') and expiresAt > now`, excluding `replaceIds`) and their bytes, refuses `stash_full` when count + entries > `UPLOAD_AREA_MAX_FILES` or bytes + sizes > `UPLOAD_AREA_MAX_BYTES`, marks `replaceIds` deleted (deleting their chunks), then inserts each entry: `id = crypto.randomUUID()`, `deviceId: null`, `deviceName: null`, `source`, `kind`, `path`, `sizeBytes`, `receivedBytes: sizeBytes`, `protection`, `comment`, `amigaDate: amigaDateText(date ?? now)`, `status: 'stored'`, `blobSha256: sha256`, `storedAt: now`, `expiresAt: now + UPLOAD_KEEP_MS`. `deleteStash`: as `deleteUpload` for many ids (receiving rows included: the board's next chunk or close hears gone). `moveStash`: one transaction of `update … set path where id and orgId`. `setStashMeta`: one update where `id in ids and orgId`.
3. `amiga-uploads.ts`:
   - `listUploads`, `clearUploads`, `uploadSummaries`: add `eq(amigaUploads.source, 'amiga'), eq(amigaUploads.kind, 'file')` to their WHERE (R5).
   - `toUploadView`: `deviceName: r.deviceName ?? 'Board'` (`UploadView.deviceName` stays `string`).
   - `closeUpload`'s storing transaction: before the guarded update, take the org lock (`select pg_advisory_xact_lock(hashtext('amiga_uploads:' || r.orgId))`), read the org's live paths (`listStash`-shaped select inside `tx`, excluding this row), and set `path: uniqueStashPath(rows, r.path)` in the same update. The answer stays `{ ok: true, name: r.path }` (the name the board sent).
   - `openUpload`'s resume match is unchanged (it matches `receiving` rows only).

- [ ] **Step 5: Run**

Run: `pnpm vitest run src/lib/files/stash-paths.test.ts && pnpm test:db src/lib/stash.db.test.ts src/lib/amiga-uploads src/app/api/uploads src/app/api/staging src/app/api/device/upload`
Expected: PASS (the existing upload and staging tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/amiga-uploads.ts drizzle/0051_stash.sql drizzle/meta src/lib/files/stash-paths.ts \
  src/lib/files/stash-paths.test.ts src/lib/stash.ts src/lib/stash.db.test.ts src/lib/amiga-uploads.ts src/lib/files/driver.ts
git commit -m "STASH: migration 0051 (source, kind, nullable device_name); the store over amiga_uploads; one name, one entry"
```

---

### Task 3: Archive readers keep the dates (and LHA comments, Amiga zip bits)

Spec §4.2: copying out of an archive keeps "the dates/protection the archive records". Today `readZip`/`readLha` return neither dates nor comments, and zip protection is always null.

**Files:**
- Modify: `src/lib/archive/zip.ts`, `src/lib/archive/lha.ts`, `src/lib/archive/index.ts` (`ArchiveMember` gains `date`, `comment`)
- Test: `src/lib/archive/archive-dates.test.ts`

**Interfaces:**
- Produces:
  - `ZipEntry` gains `date: Date | null` and `protection: number | null` (was `null`); `LhaEntry` gains `date: Date | null; comment: string | null`.
  - `ArchiveMember` gains `date: Date | null; comment: string | null` (`expandArchive` passes them through; zip members `comment: null`).
  - `export function dosDateTime(v: number): Date | null` in `src/lib/archive/dos-date.ts` (date in the high 16 bits, time in the low 16, read as UTC wall clock, R10; null for month 0, day 0, or an invalid time).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/archive/archive-dates.test.ts
// Expected instants come from the fixtures' own headers (made by /opt/homebrew/bin/lha and the system zip at
// 16:47:48 local time, UTC+2): a DOS stamp says 16:47:48 with no zone (R10: read as that wall clock), a Unix stamp
// (LHA ext 0x54, LHA level 2, zip "UT") says 14:47:48Z and wins.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLha } from './lha';
import { readZip } from './zip';
import { dosDateTime } from './dos-date';
import { expandArchive } from './index';

const read = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', n)));
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

describe('dosDateTime', () => {
  it('reads date and time as a wall clock, and refuses a zero date', () => {
    expect(iso(dosDateTime((((2026 - 1980) << 9 | 9 << 5 | 11) << 16) | (16 << 11 | 47 << 5 | 24)))).toBe('2026-09-11T16:47:48.000Z');
    expect(dosDateTime(0)).toBeNull();
  });
});

describe('LHA dates', () => {
  it('level 0 has only the DOS stamp', () => {
    expect(readLha(read('h0.lha')).entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T16:47:48.000Z'));
  });
  it('level 1 prefers its Unix-time extension (0x54); level 2 its Unix header time', () => {
    expect(readLha(read('h1.lha')).entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T14:47:48.000Z'));
    expect(readLha(read('h2.lha')).entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T14:47:48.000Z'));
    expect(iso(readLha(read('lh1.lzh')).entries[0].date)).toBe('2026-10-18T20:46:53.000Z');
  });
  it('keeps the comment a level 0/1 name carries after its NUL, and none when there is none', () => {
    expect(readLha(read('h0.lha')).entries.every((e) => e.comment === null)).toBe(true);
    const nm = Buffer.from('a.txt\0From the bench', 'latin1');
    const data = Buffer.from('hello');
    const h = Buffer.alloc(24 + nm.length);
    h[0] = 22 + nm.length; h.write('-lh0-', 2, 'latin1'); h.writeUInt32LE(data.length, 7); h.writeUInt32LE(data.length, 11);
    h.writeUInt32LE(((((2020 - 1980) << 9) | (1 << 5) | 2) << 16) >>> 0, 15);
    h[21] = nm.length; nm.copy(h, 22);
    const { entries } = readLha(new Uint8Array(Buffer.concat([h, data, Buffer.alloc(1)])));
    expect(entries[0]).toMatchObject({ path: 'a.txt', comment: 'From the bench' });
    expect(iso(entries[0].date)).toBe('2020-01-02T00:00:00.000Z');
  });
});

describe('zip dates and Amiga bits', () => {
  it('prefers the UT extra field', async () => {
    const { entries } = await readZip(read('t.zip'));
    expect(entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T14:47:48.000Z'));
    expect(entries.every((e) => e.protection === null)).toBe(true);   // made on Unix
  });
  it('falls back to the DOS stamp without UT, and reads protection from an Amiga-made member', async () => {
    const buf = read('t.zip').slice();
    // Every central-directory record: hide the UT extra (0x5455 → 0xffff) and say "made by Amiga" with bits 0x05.
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 1 && buf[i + 3] === 2) {
        const nameLen = buf[i + 28] | (buf[i + 29] << 8);
        const extra = i + 46 + nameLen;
        if (buf[extra] === 0x55 && buf[extra + 1] === 0x54) { buf[extra] = 0xff; buf[extra + 1] = 0xff; }
        buf[i + 5] = 1;                                   // version made by: host 1 = Amiga
        buf[i + 38] = 0; buf[i + 39] = 0; buf[i + 40] = 0x05; buf[i + 41] = 0;   // external attrs = 0x00050000
      }
    }
    const { entries } = await readZip(buf);
    expect(entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T16:47:48.000Z'));
    expect(entries.map((e) => e.protection)).toEqual([5, 5, 5, 5]);
  });
  it('expandArchive passes date and comment through', async () => {
    const r = await expandArchive('t.zip', read('t.zip'));
    expect(r && 'members' in r && r.members[0]).toMatchObject({ date: expect.any(Date), comment: null });
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/lib/archive/archive-dates.test.ts` → FAIL (`./dos-date` missing; `date` undefined).

- [ ] **Step 3: Implement**

1. `dos-date.ts`:
```ts
/** A DOS date/time (date high, time low): a wall clock with no zone, kept as that UTC instant (increment 2 R10). */
export function dosDateTime(v: number): Date | null {
  const d = v >>> 16, t = v & 0xffff;
  const year = 1980 + (d >> 9), month = (d >> 5) & 15, day = d & 31;
  const h = t >> 11, m = (t >> 5) & 63, s = (t & 31) * 2;
  if (!month || month > 12 || !day || h > 23 || m > 59 || s > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, h, m, s));
}
```
2. `zip.ts`: in the central-directory loop read `madeBy = buf[cen + 5]`, `time = u16(cen + 12)`, `date = u16(cen + 14)`, `ext = u32(cen + 38)` and walk the extra field (`id u16, size u16, data`) for `0x5455`: flags byte, then a u32 mtime when `flags & 1` → `new Date(mtime * 1000)`. `date = ut ?? dosDateTime((date << 16 | time) >>> 0)`; `protection = madeBy === 1 ? (ext >>> 16) & 0xff : null`. Read these BEFORE `cen` advances. Update the header comment ("Zip carries no AmigaDOS protection bits…") to say: except a member made on an Amiga (R11). Keep `ZipEntry.protection: number | null`.
3. `lha.ts`: `toPath` returns `{ path, comment }` (the tail after the NUL, Latin-1, trimmed, null when empty). Level 0/1: `dos = dosDateTime(u32(buf, off + 15))`; level 1's `readExtended` also returns `unixTime` from type `0x54` (u32 → Date) and `comment` from type `0x3f` (Latin-1). Level 2: `new Date(u32(buf, off + 15) * 1000)`. `date = unixTime ?? dos` (level 2: the header time). Comment: ext `0x3f` wins over the name tail. The NUL-truncation test above must keep passing.
4. `index.ts`: `ArchiveMember` gains `date` and `comment` and both readers' entries already carry them; update the doc comments ("comments are out of scope" → LHA comments are kept, spec 2026-10-29 §4.2).

- [ ] **Step 4: Run** `pnpm vitest run src/lib/archive src/lib/staging` → PASS (existing archive and staging tests unchanged; a dropped Amiga zip into a disk now keeps its bits, which is what "said nothing vs said rwed" allows).
- [ ] **Step 5: Commit**

```bash
git add src/lib/archive/dos-date.ts src/lib/archive/zip.ts src/lib/archive/lha.ts src/lib/archive/index.ts src/lib/archive/archive-dates.test.ts
git commit -m "Archives: members carry the date the archive records (DOS, Unix, UT), LHA comments, Amiga zip protection"
```

---

### Task 4: The STASH: driver — list, read, collect, archives

**Files:**
- Create: `src/lib/files/stash-archive.ts`, `src/lib/files/stash-driver.ts`
- Modify: `src/lib/files/types.ts` (`EntryKind` gains `'archive'`; `RefusalCode` gains `'stash_full' | 'too_large' | 'archive_unreadable' | 'not_a_disk_image'`), `src/lib/files/words.ts` (+ `words.test.ts`), `src/lib/files/drivers.ts` (adds STASH), `src/lib/files/driver.test.ts` (STASH now present)
- Test: `src/lib/files/stash-driver.db.test.ts`

**Interfaces:**
- Consumes: Task 2 `listStash`, `StashRow`, `stashTree`, `stashFind`, `rowsUnder`, `dateOfAmigaText`; Task 3 `readZip`, `readLha` with dates; `isArchiveName`, `MAX_ARCHIVE_BYTES`, `MAX_ZIP_MEMBER_BYTES`, `MAX_ZIP_TOTAL_BYTES` (`src/lib/archive/index.ts`); `protectionString` (`src/lib/adffs/dir.ts`); `libraryEligible`, `uploadFailureText` (`src/lib/from-amiga-ui.ts`); `diskStore`.
- Produces (`stash-archive.ts`):
```ts
export type ArchiveFile = { path: string[]; bytes: Uint8Array; date: Date | null; protection: number | null; comment: string | null };
/** The archive's members as files (folders implicit), or null when it is over MAX_ARCHIVE_BYTES or unreadable. */
export async function openArchive(name: string, bytes: Uint8Array): Promise<ArchiveFile[] | null>;
```
- Produces (`stash-driver.ts`): `export const stashDriver: VolumeDriver` (this task: `list`, `read`, `collect`; Task 5 adds the rest), and the helper `export async function loadStash(ctx: FsCtx): Promise<{ rows: StashRow[]; tree: StashNode }>`.
- Words (`words.ts`): `stash_full` → "STASH: holds 500 files / 256 MB; delete some first."; `too_large` → detail ? `Too large — ${detail}.` : "That file is too large."; `archive_unreadable` → "Can't open this archive. You can still download it."; `not_a_disk_image` → detail ? `Not a disk image the library takes — ${detail}.` : "Only disk images (ADF, ADZ, DMS, DMZ, HFE) go into the library."; `read_only` with detail `archive` → "Archives are read-only — copy files out of them."; `unsupported` with detail `still arriving from the Amiga` reads "That is still arriving from the Amiga."

Listing rules:
- `STASH:` and `STASH:/<names>` (a folder): entries are the node's children. A file child → `kind: 'archive'` when `isArchiveName(name)` and its row is `stored`, else `'file'`; `size` = `sizeBytes`; `date` = row date ISO (implicit folder: null; dir row: its date); `protection` = `protectionString(row.protection)` (folders without a row: `'----rwed'`); `comment` = row comment or null; `marks`: `from <deviceName>` for `source='amiga'`, `arriving <pct>%` for receiving, `failed — <uploadFailureText(errorCode)>`, `in the library` when `libraryDiskId`. Crumbs `STASH:` then each shown name. `writable: true`, `readOnlyReason: null`, `disk: null`. Meta at the root: `"<files> files · <size> of 256 MB · kept 30 days"` (files = live rows, size via the pane's units: compute bytes and format `MB` to one place); in a folder: `"<dirs> folders · <files> files"`.
- `STASH:/…/<x.lha>/<names>`: the archive row's blob through `openArchive`; null result → throw `refuse('archive_unreadable', 422)`; entries from the member tree (folders implicit, `kind` dir/file), each member's `date`, `protection` (null → `'----rwed'`), `comment`. `writable: false`, `readOnlyReason: 'archive'`. Meta `"<n> files in the archive"`.
- A path through a file that is not an archive, or a missing name → null. Another org's rows are never loaded (`listStash` is per org) → null.
- `read`: a stored file row → `diskStore.read(blob)` (a missing blob → `refuse('blob_unavailable', 503)`), meta from the row; an archive member → its bytes and meta; anything else → null.
- `collect`: a stored file → one item `{ rel: [name], kind: 'file', bytes, sha256: row.blobSha256, date, protection, comment }`; a folder → its own item then every row under it in tree order (dir rows and implicit folders as `dir` items, stored files with bytes and sha256); a receiving file anywhere in it → `refuse('unsupported', 409, 'still arriving from the Amiga')`; failed files are left out (they hold no bytes). Archive folders/members likewise from the member tree (no sha256).

- [ ] **Step 1: Write the failing DB test**

```ts
// src/lib/files/stash-driver.db.test.ts  (setup block exactly as src/lib/stash.db.test.ts, DB = 'webadf_stash_driver_test',
// STORAGE_DIR prefix '/tmp/webadf-stash-driver-', plus the device row 'dev1' named 'A500 bench')
const { diskStore } = await import('@/lib/storage');
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { insertStash } = await import('@/lib/stash');
const { parsePath } = await import('./path');
const { stashDriver } = await import('./stash-driver');
const ctx = { orgId: 'o1', userId: null };
const P = (s: string) => parsePath(s)!;
async function put(bytes: Uint8Array) { const sha = createHash('sha256').update(bytes).digest('hex'); await diskStore.put(sha, bytes); return sha; }
async function stash(path: string, bytes: Uint8Array, meta: { protection?: number; comment?: string; date?: Date } = {}) {
  const r = await insertStash(getDb(), 'o1', 'browser', [{ path, kind: 'file', sha256: await put(bytes), sizeBytes: bytes.length,
    date: meta.date ?? new Date(Date.UTC(2020, 0, 2)), protection: meta.protection ?? 0, comment: meta.comment ?? '' }]);
  if (!r.ok) throw new Error(r.code);
  return r.ids[0];
}
const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  // ...setup as above, then:
  await stash('ReadMe', enc('hello'), { protection: 0x05, comment: 'top' });
  await stash('Mods/enigma.mod', enc('mod!'));
  await stash('t.zip', new Uint8Array(readFileSync('src/lib/archive/fixtures/t.zip')));
  await stash('bad.lha', enc('not an lha at all'));
  await getDb().insert(amigaUploads).values({ id: 'arr1', orgId: 'o1', deviceId: 'dev1', deviceName: 'A500 bench', path: 'Mods/arriving.mod',
    sizeBytes: 100, receivedBytes: 45, amigaDate: '17000.0.0', status: 'receiving', expiresAt: new Date(Date.now() + 3600_000) });
});

describe('STASH: listing', () => {
  it('lists the root: folders, files and an archive, with protection, comment and the limit line', async () => {
    const l = (await stashDriver.list(ctx, P('STASH:')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual(expect.arrayContaining([
      ['dir', 'Mods', 'STASH:/Mods'], ['file', 'ReadMe', 'STASH:/ReadMe'], ['archive', 't.zip', 'STASH:/t.zip']]));
    expect(l.entries.find((e) => e.name === 'ReadMe')).toMatchObject({ size: 5, comment: 'top', date: '2020-01-02T00:00:00.000Z' });
    expect([l.writable, l.disk, l.crumbs]).toEqual([true, null, [{ label: 'STASH:', path: 'STASH:' }]]);
    expect(l.meta).toMatch(/of 256 MB · kept 30 days/);
  });
  it('marks a file still arriving with the board and its progress', async () => {
    const l = (await stashDriver.list(ctx, P('STASH:/mods')))!;
    expect(l.entries.find((e) => e.name === 'arriving.mod')!.marks).toEqual(['from A500 bench', 'arriving 45%']);
  });
  it('opens an archive as a read-only folder with the dates it records', async () => {
    const l = (await stashDriver.list(ctx, P('STASH:/t.zip/src')))!;
    expect([l.writable, l.readOnlyReason]).toEqual([false, 'archive']);
    expect(l.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['sub', 'readme.txt', 'tiny.txt', 'noise.bin']));
    expect(l.entries.find((e) => e.name === 'readme.txt')!.date).toBe('2026-09-11T14:47:48.000Z');
    expect(l.crumbs.map((c) => c.label)).toEqual(['STASH:', 't.zip', 'src']);
  });
  it('an unreadable archive refuses its listing but still reads whole', async () => {
    await expect(stashDriver.list(ctx, P('STASH:/bad.lha'))).rejects.toMatchObject({ refusal: { code: 'archive_unreadable' }, status: 422 });
    expect(new TextDecoder().decode((await stashDriver.read(ctx, P('STASH:/bad.lha')))!.bytes)).toBe('not an lha at all');
  });
  it('is not found for another org, a missing name, or a path through a plain file', async () => {
    expect(await stashDriver.list({ orgId: 'o2', userId: null }, P('STASH:/Mods'))).toBeNull();
    expect(await stashDriver.list(ctx, P('STASH:/Nope'))).toBeNull();
    expect(await stashDriver.list(ctx, P('STASH:/ReadMe/x'))).toBeNull();
  });
});

describe('STASH: read and collect', () => {
  it('reads a file and an archive member with their meta', async () => {
    expect((await stashDriver.read(ctx, P('STASH:/ReadMe')))).toMatchObject({ name: 'ReadMe', comment: 'top' });
    const m = (await stashDriver.read(ctx, P('STASH:/t.zip/src/readme.txt')))!;
    expect(new TextDecoder().decode(m.bytes)).toMatch(/^The quick brown fox/);
    expect(m.date?.toISOString()).toBe('2026-09-11T14:47:48.000Z');
  });
  it('collects a stored file with its blob, and refuses a folder with a file still arriving', async () => {
    const items = (await stashDriver.collect(ctx, P('STASH:/ReadMe')))!;
    expect(items).toEqual([expect.objectContaining({ rel: ['ReadMe'], kind: 'file', protection: 5, comment: 'top', sha256: expect.any(String) })]);
    await expect(stashDriver.collect(ctx, P('STASH:/Mods'))).rejects.toMatchObject({ refusal: { code: 'unsupported', detail: 'still arriving from the Amiga' } });
  });
  it('collects an archive folder from its members', async () => {
    const items = (await stashDriver.collect(ctx, P('STASH:/t.zip/src/sub')))!;
    expect(items.map((i) => [i.rel.join('/'), i.kind])).toEqual([['sub', 'dir'], ['sub/deep.txt', 'file']]);
  });
});
```

- [ ] **Step 2: Run** `pnpm test:db src/lib/files/stash-driver.db.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `stash-archive.ts` (`isArchiveName` decides; over `MAX_ARCHIVE_BYTES` → null; `.zip` → `readZip(bytes, { maxEntryBytes: MAX_ZIP_MEMBER_BYTES, maxTotalBytes: MAX_ZIP_TOTAL_BYTES })`, `.lha/.lzh` → `readLha` with the same caps; no entries → null; any throw → null; paths split on `/`, empty segments dropped), `stash-driver.ts` (rules above), the types/words additions, and `DRIVERS.STASH = stashDriver`. Update `driver.test.ts`: `driverFor('STASH')!.device === 'STASH'` and `list/read/collect` are functions.
- [ ] **Step 4: Run** `pnpm test:db src/lib/files && pnpm vitest run src/lib/files` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/stash-archive.ts src/lib/files/stash-driver.ts src/lib/files/stash-driver.db.test.ts src/lib/files/types.ts \
  src/lib/files/words.ts src/lib/files/words.test.ts src/lib/files/drivers.ts src/lib/files/driver.test.ts
git commit -m "Files: STASH: driver lists, reads and collects; archives open read-only with their dates"
```

---

### Task 5: STASH: writes, copies between devices, Add to library

**Files:**
- Modify: `src/lib/files/stash-driver.ts` (`write`, `remove`, `makedir`, `rename`, `setMeta`, `within`), `src/lib/files/ops.ts` (`crossDevice`, `add-to-library`), `src/app/api/uploads/[id]/library/route.ts`
- Create: `src/lib/stash-library.ts`
- Test: `src/lib/files/stash-ops.db.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `storeSendBytes` (`src/lib/send-http.ts`); `libraryEligible`.
- Produces:
  - `OpRequest` gains `| { op: 'add-to-library'; sources: string[] }`; `OpResult`'s `done` gains `added?: Added[]`.
  - `src/lib/stash-library.ts`: `export async function addUploadToLibrary(orgId: string, id: string): Promise<{ ok: true; diskId: string; gameId: string } | { ok: false; status: 404 | 422 | 502; error: 'not_found' | 'not_a_disk_image' | 'refused' | 'ingest_failed'; reason?: string }>` — the body of today's `add()` in the route, moved verbatim; the route becomes `requireOrg`, `try { const r = await addUploadToLibrary(orgId, id); return r.ok ? Response.json({ diskId: r.diskId, gameId: r.gameId }) : Response.json({ error: r.error, ...(r.reason ? { reason: r.reason } : {}) }, { status: r.status }); } catch …` (500 `server` as now).
  - `export async function writeStash(ctx: OpCtx, dir: FsPath, tops: IncomingTop[], onClash: OnClash, source: 'browser' | 'copy'): Promise<Outcome>` in `stash-driver.ts`; `stashDriver.write(ctx, dir, tops, onClash)` = `writeStash(…, 'copy')`. Rules: `dir` must be a STASH: folder (not inside an archive: `refuse('read_only', 409, 'archive')`; missing → 404). Clash per top name against the folder's children (`sameStashName`) and earlier tops: `ask` + any → `clashes`; `skip` drops; `keep-both` renames the top (`keepBothName`); `replace` deletes the existing node's rows in the same transaction (`insertStash(..., { replaceIds })`). Per item: every `rel` segment through `checkName` (`bad_name`); a file over `STASH_FILE_MAX` → `too_large` (detail `20 MB per file`). Bytes without `sha256` are stored with `storeSendBytes`. All remaining entries go into ONE `insertStash(db, orgId, source, entries, { replaceIds })`; `stash_full` → `refuse('stash_full', 409, STASH_FULL)`. Paths: the folder's shown names joined with `rel`.
  - `stashDriver.remove(ctx, sources, unchanged?)`: each source's node (`rowsUnder`) → `deleteStash` in one call; inside an archive → `read_only` `archive`. With `unchanged`: a row is deleted only if it still exists with the same `blobSha256`/`path` as collected (rows never change bytes, so `id` still live = unchanged); otherwise that source is refused `conflict` with detail `REMOVE_FAILED`.
  - `makedir`: `checkName`; a clash → `name_exists` 409; insert one `kind:'dir'` row (counts toward the limit).
  - `rename(source, name)`: `checkName`; sibling clash → `name_exists`; every row under the node gets `newPath = [...parentShownNames, name, ...storedSegments.slice(depth + 1)]` via `moveStash`; an implicit folder renames its children only.
  - `setMeta(sources, { protection?, comment? })`: protection 0..0xff (else `unsupported` 400), `checkComment`; a node with a row → `setStashMeta`; an implicit folder → insert a `dir` row carrying the meta.
  - `within(ctx, req)`: copy = `collect` each source + `write` into the dest (blobs reused through `sha256`, no new bytes stored); move = path rewrite via `moveStash` (dest inside the source → `cycle` 400; clash handling as `write`; moved onto its own folder → no-op).
  - `ops.ts` `crossDevice(ctx, req, srcs, dest)`:
```ts
async function crossDevice(ctx: OpCtx, req: CopyMove, srcs: FsPath[], dest: FsPath): Promise<Outcome> {
  const dd = driverOf(dest);
  const write = need(dd, 'write');
  const tops: IncomingTop[] = [];
  for (const [i, p] of srcs.entries()) {
    const items = await driverOf(p).collect(ctx, p);
    if (!items) refuse('not_found', 404);
    tops.push({ source: req.sources[i], items });
  }
  if (req.op === 'move') for (const p of srcs) need(driverOf(p), 'remove');
  const out = await write.call(dd, ctx, dest, tops, req.onClash);
  if (out.kind !== 'done' || req.op !== 'move') return out;
  const moved = out.items.filter((x) => x.ok).map((x) => x.source);
  const results = new Map(out.items.map((x) => [x.source, x] as const));
  for (const [device, list] of groupBy(moved, (s) => pathOf(s).device)) {
    const d = driverFor(device)!;
    const unchanged = new Map(tops.filter((t) => list.includes(t.source)).map((t) => [t.source, t.items] as const));
    try {
      const r = await d.remove!(ctx, list, unchanged);
      if (r.kind === 'done') for (const x of r.items) if (!x.ok) results.set(x.source, { source: x.source, ok: false, refusal: { code: x.refusal.code, detail: REMOVE_FAILED } });
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      for (const s of list) results.set(s, { source: s, ok: false, refusal: { code: e.refusal.code, detail: REMOVE_FAILED } });
    }
  }
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!) };
}
```
  - `ops.ts` `add-to-library`: every source must be a STASH: path of a stored file row (archive member → item `unsupported` "copy it out of the archive first"; not eligible by `libraryEligible(path, size)` → item `not_a_disk_image`); each runs `addUploadToLibrary(orgId, rowId)`; ok → `added.push({ source, gameId, diskId })`; refusals map `not_found` → `not_found`, `not_a_disk_image`/`refused` → `not_a_disk_image` (detail = reason), `ingest_failed` → `failed`.

- [ ] **Step 1: Write the failing DB test**

```ts
// src/lib/files/stash-ops.db.test.ts
// Setup: the block of src/lib/files/ops.db.test.ts (its own DB 'webadf_files_stash_ops_test', the same seedDisk helper and
// versions()/sha() helpers), plus `stash()` and `put()` from stash-driver.db.test.ts, plus:
vi.mock('@/lib/stash-library', () => ({ addUploadToLibrary: vi.fn() }));
const { addUploadToLibrary } = await import('@/lib/stash-library');
const { runOp } = await import('./ops');
const { listStash } = await import('@/lib/stash');
const live = async () => (await listStash(getDb(), 'o1')).map((r) => r.path).sort();
// Seeds: disk d1 "SysInfo" (FFS: C/Assign comment 'cmd' dated 1993-05-17T12:34:56Z protection 0x05, ReadMe 'hello', S/),
// disk d2 "Turrican" (OFS, empty); STASH: 'Notes.txt' ('notes', protection 0x02, comment 'mine', 2020-01-02),
// 'Disk.adf' (a formatted 901,120-byte OFS image), 't.zip' (the fixture).

describe('copies between STASH: and disks', () => {
  it('copies a disk folder into STASH:, keeping date, protection and comment', async () => {
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'STASH:', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/C', ok: true }], versions: [] });
    const [a] = (await listStash(getDb(), 'o1')).filter((x) => x.path === 'C/Assign');
    expect([a.source, a.protection, a.comment, a.date?.toISOString()]).toEqual(['copy', 5, 'cmd', '1993-05-17T12:34:56.000Z']);
  });
  it('copies a STASH: file onto a disk in one version, keeping its meta', async () => {
    const v = await versions('d2');
    expect((await runOp(ctx, { op: 'copy', sources: ['STASH:/Notes.txt'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' })).kind).toBe('done');
    expect(await versions('d2')).toBe(v + 1);
    const f = (await readLibraryFile(ctx, P('LIBRARY:/g2/d2/Notes.txt')))!;
    expect([new TextDecoder().decode(f.bytes), f.comment, f.date?.toISOString()]).toEqual(['notes', 'mine', '2020-01-02T00:00:00.000Z']);
  });
  it('copies out of an archive with the date it records', async () => {
    await runOp(ctx, { op: 'copy', sources: ['STASH:/t.zip/src/readme.txt'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/readme.txt')))!.date?.toISOString()).toBe('2026-09-11T14:47:48.000Z');
  });
  it('moves STASH: → disk (gone from STASH:) and disk → STASH: (one version on the source disk)', async () => {
    await runOp(ctx, { op: 'move', sources: ['STASH:/Notes.txt'], dest: 'LIBRARY:/g2/d2', onClash: 'replace' });   // d2 holds Notes.txt from the copy above
    expect(await live()).not.toContain('Notes.txt');
    const v = await versions('d1');
    await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'STASH:', onClash: 'ask' });
    expect([await versions('d1'), await readLibraryFile(ctx, P('LIBRARY:/g1/d1/ReadMe'))]).toEqual([v + 1, null]);
    expect(await live()).toContain('ReadMe');
  });
  it('a disk that does not fit refuses the whole copy from STASH:', async () => {
    const s = await sha('d3');   // d3 "Full", as increment 1's ops test seeds it
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Disk.adf'], dest: 'LIBRARY:/g3/d3', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'disk_full' } });
    expect(await sha('d3')).toBe(s);
  });
});

describe('inside STASH:', () => {
  it('asks on a clash and writes nothing; keep-both adds ReadMe_1; replace swaps it', async () => {
    const before = await live();
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:', onClash: 'ask' })).toMatchObject({ kind: 'done' });
    expect((await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:', onClash: 'ask' })).kind).toBe('clashes');
    expect((await live()).length).toBe(before.length + 1);
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/readme.txt'], dest: 'STASH:', onClash: 'keep-both' });
    expect(await live()).toContain('readme_1.txt');
  });
  it('makedir, rename a folder (its files follow), protect, comment, delete', async () => {
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Box' });
    await runOp(ctx, { op: 'move', sources: ['STASH:/readme_1.txt'], dest: 'STASH:/Box', onClash: 'ask' });
    await runOp(ctx, { op: 'rename', source: 'STASH:/Box', name: 'Crate' });
    expect(await live()).toEqual(expect.arrayContaining(['Crate', 'Crate/readme_1.txt']));
    await runOp(ctx, { op: 'protect', sources: ['STASH:/Crate/readme_1.txt'], protection: 0x0f });
    await runOp(ctx, { op: 'comment', source: 'STASH:/Crate/readme_1.txt', comment: 'boxed' });
    const [x] = (await listStash(getDb(), 'o1')).filter((r) => r.path === 'Crate/readme_1.txt');
    expect([x.protection, x.comment]).toEqual([0x0f, 'boxed']);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Crate'] });
    expect((await live()).filter((p) => p.startsWith('Crate'))).toEqual([]);
  });
  it('refuses a folder into itself, writes into an archive, and a bad name', async () => {
    await runOp(ctx, { op: 'makedir', dest: 'STASH:', name: 'Loop' });
    expect(await runOp(ctx, { op: 'move', sources: ['STASH:/Loop'], dest: 'STASH:/loop', onClash: 'ask' })).toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
    expect(await runOp(ctx, { op: 'makedir', dest: 'STASH:/t.zip', name: 'x' })).toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: 'archive' } });
    expect(await runOp(ctx, { op: 'rename', source: 'STASH:/Loop', name: 'a:b' })).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name' } });
  });
  it('a folder with a file still arriving is not copied', async () => {
    await getDb().insert(amigaUploads).values({ id: 'arr2', orgId: 'o1', deviceId: 'dev1', deviceName: 'A500 bench', path: 'Loop/late.mod',
      sizeBytes: 100, receivedBytes: 10, amigaDate: '17000.0.0', status: 'receiving', expiresAt: new Date(Date.now() + 3600_000) });
    expect(await runOp(ctx, { op: 'copy', sources: ['STASH:/Loop'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'unsupported', detail: 'still arriving from the Amiga' } });
  });
  it('delete takes an arriving file too', async () => {
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Loop'] });
    const [row] = await getDb().select().from(amigaUploads).where(eq(amigaUploads.id, 'arr2'));
    expect(row.status).toBe('deleted');
  });
  it('over the org limit refuses the whole copy', async () => {
    const room = 500 - (await listStash(getDb(), 'o1')).length;
    await insertStash(getDb(), 'o1', 'copy', Array.from({ length: room - 2 }, (_, i) => ({ path: `Pad/p${i}`, kind: 'file' as const,
      sha256: 'b'.repeat(64), sizeBytes: 1, date: null, protection: 0, comment: '' })));
    const before = await live();
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C', 'LIBRARY:/g1/d1/S'], dest: 'STASH:/Pad', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'stash_full' } });
    expect(await live()).toEqual(before);
    await runOp(ctx, { op: 'delete', sources: ['STASH:/Pad'] });
  });
  it("another org's STASH: paths are not found", async () => {
    expect(await runOp({ orgId: 'o2', userId: null }, { op: 'delete', sources: ['STASH:/C'] })).toMatchObject({ kind: 'refused', status: 404 });
  });
});

describe('Add to library', () => {
  it('adds a disk image and refuses a text file and an archive member, per item', async () => {
    vi.mocked(addUploadToLibrary).mockResolvedValueOnce({ ok: true, diskId: 'dX', gameId: 'gX' });
    const r = await runOp(ctx, { op: 'add-to-library', sources: ['STASH:/Disk.adf', 'STASH:/C/Assign', 'STASH:/t.zip/src/tiny.txt'] });
    expect(r).toMatchObject({ kind: 'done', added: [{ source: 'STASH:/Disk.adf', gameId: 'gX', diskId: 'dX' }], items: [
      { source: 'STASH:/Disk.adf', ok: true },
      { source: 'STASH:/C/Assign', ok: false, refusal: { code: 'not_a_disk_image' } },
      { source: 'STASH:/t.zip/src/tiny.txt', ok: false, refusal: { code: 'unsupported' } }] });
  });
});
```

- [ ] **Step 2: Run** `pnpm test:db src/lib/files/stash-ops.db.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces above; extract `addUploadToLibrary` and switch the route to it.
- [ ] **Step 4: Run** `pnpm test:db src/lib/files src/app/api/uploads src/app/api/files && pnpm tsc --noEmit -p .` → PASS (the uploads route tests unchanged).
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/stash-driver.ts src/lib/files/ops.ts src/lib/files/stash-ops.db.test.ts src/lib/stash-library.ts \
  "src/app/api/uploads/[id]/library/route.ts"
git commit -m "Files: STASH: writes; copies and moves between STASH: and disks keep their meta; Add to library as an op"
```

---

### Task 6: Routes — through the drivers; browser upload and Paste URL into STASH:

**Files:**
- Modify: `src/app/api/files/list/route.ts`, `src/app/api/files/download/route.ts`, `src/app/api/files/ops/route.ts`, `src/lib/disk-zip.ts`
- Create: `src/app/api/files/stash/presign/route.ts`, `src/app/api/files/stash/commit/route.ts`, `src/app/api/files/stash/url/route.ts`, `src/lib/files/stash-commit.ts`
- Test: `src/app/api/files/files-api.db.test.ts` (new cases), `src/app/api/files/stash/stash-api.db.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `diskStore.stat/read/uploadUrl`; `contentHashes` (`src/lib/content-hashes.ts`); `cleanAmigaPath` (`src/lib/transfers.ts`); `fetchUrlSafely`, `URL_FETCH_LIMITS` (`src/lib/url-fetch.ts`); `nameFromResponse` (`src/lib/url-ingest.ts`); `takeUrlFetch` (`src/lib/url-fetch-limit.ts`); `describeUrlRefusal` codes; `storeSendBytes`.
- Produces:
  - `GET /api/files/list?path=` → as before for every device with a driver; a `Refused` thrown by `list` → `{ error: code, detail }` with its status (archive → 422).
  - `GET /api/files/download?path=` → `driver.read`; headers add `x-content-type-options: nosniff` and `cache-control: private, no-store` for every device. `?paths=` → all LIBRARY: → `zipLibraryPaths` unchanged; otherwise each path through its driver's `collect` and `zipIncoming(tops, ZIP_LIMITS)`.
  - `src/lib/disk-zip.ts`: `export function zipIncoming(tops: readonly { items: readonly { rel: string[]; kind: 'file' | 'dir'; bytes?: Uint8Array }[] }[], limits: ZipLimits): ZipOutcome | { ok: false; reason: 'too_large' }` — names through `safe`, top names numbered as `zipTops` does, `writeZip` reused.
  - `POST /api/files/ops` zod adds `z.object({ op: z.literal('add-to-library'), sources })`; the answer adds `added` when present.
  - `POST /api/files/stash/presign` body `{ files: { sha256: string /^[0-9a-f]{64}$/, sizeBytes: 1..STASH_FILE_MAX }[] (1..200) }` → 200 `{ uploads: { sha256, url }[] }` for the blobs `diskStore.stat` does not have (a stored one needs no PUT).
  - `src/lib/files/stash-commit.ts`: `export type CommitEntry = { path: string; kind: 'file' | 'dir'; sha256?: string; sizeBytes: number; lastModified?: number }` and `export async function commitToStash(ctx: OpCtx, dir: string, entries: CommitEntry[], onClash: OnClash): Promise<OpResult & { renamed?: { from: string; to: string }[] }>` — sums claimed sizes > `STASH_COMMIT_MAX_BYTES` or entries > `STASH_COMMIT_MAX_ENTRIES` → refused `too_large` 413 (detail `64 MB at a time`); each file: `cleanAmigaPath(path)` (null → item `bad_name`; changed → `renamed`), size 0 → `storeSendBytes(new Uint8Array(0))`, else `stat` must equal `sizeBytes` and `contentHashes(await diskStore.read(sha)).sha256 === sha` (else item `failed`, detail `upload did not arrive whole`); then groups entries into `IncomingTop`s by first path segment and calls `stashDriver.write(ctx, parsePath(dir), tops, onClash)` with items carrying `sha256` (no bytes), `date: lastModified ? new Date(lastModified) : null`, `protection: 0`, `comment: null`. Source of the rows: `'browser'` (write takes a `source` option: `write(ctx, dir, tops, onClash)` uses `'copy'`; `commitToStash` calls the driver's exported `writeStash(ctx, dir, tops, onClash, 'browser')`, which `write` wraps).
  - `POST /api/files/stash/commit` body `{ dir: string (a STASH: path), entries: CommitEntry[], onClash }` → 200 `{ items, renamed }` | 409 `{ error: 'clashes', clashes }` | refusal status `{ error, detail }` | 400 `invalid_body`.
  - `POST /api/files/stash/url` body `{ url }` → `takeUrlFetch(userId, orgId)` (429 as `/api/ingest/url`), `fetchUrlSafely(url)` (refusal codes and statuses as `/api/ingest/url`'s `STATUS` table for the fetch codes), name = `cleanAmigaPath(nameFromResponse(finalUrl, contentDisposition))` (null → `download`), `storeSendBytes`, then `writeStash(ctx, STASH:, [{ source: url, items: [file] }], 'keep-both', 'browser')` → 201 `{ path }`.

- [ ] **Step 1: Write the failing tests**

```ts
// additions to src/app/api/files/files-api.db.test.ts (seed one STASH: file 'Notes.txt' = 'notes' and t.zip with insertStash)
it('lists STASH: and 422s an unreadable archive', async () => {
  expect((await GET_LIST(req('/api/files/list?path=STASH:'))).status).toBe(200);
  const bad = await GET_LIST(req('/api/files/list?path=' + encodeURIComponent('STASH:/bad.lha')));
  expect([bad.status, (await bad.json()).error]).toEqual([422, 'archive_unreadable']);
});
it('downloads a STASH: file as a nosniff attachment, and zips STASH: and LIBRARY: together', async () => {
  const one = await GET_DL(req('/api/files/download?path=' + encodeURIComponent('STASH:/Notes.txt')));
  expect([one.status, one.headers.get('x-content-type-options'), await one.text()]).toEqual([200, 'nosniff', 'notes']);
  const q = new URLSearchParams(); q.append('paths', 'STASH:/Notes.txt'); q.append('paths', 'LIBRARY:/g1/d1/ReadMe');
  const z = await GET_DL(req('/api/files/download?' + q));
  expect([z.status, z.headers.get('content-type')]).toEqual([200, 'application/zip']);
});
```

```ts
// src/app/api/files/stash/stash-api.db.test.ts  (setup as files-api.db.test.ts with DB 'webadf_stash_api_test'; also
// vi.mock('@/lib/url-fetch', async (o) => ({ ...(await o()), fetchUrlSafely: vi.fn() })) and
// vi.mock('@/lib/url-fetch-limit', () => ({ takeUrlFetch: () => ({ ok: true }) })))
const json = (path: string, body: unknown) => new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bytes = new TextEncoder().encode('hello stash');
const sha = createHash('sha256').update(bytes).digest('hex');

it('presign answers a URL only for blobs not yet stored', async () => {
  const r = await PRESIGN(json('/api/files/stash/presign', { files: [{ sha256: sha, sizeBytes: bytes.length }] }));
  expect((await r.json()).uploads).toEqual([{ sha256: sha, url: expect.any(String) }]);
  await diskStore.put(sha, bytes);   // what the browser's PUT does
  expect((await (await PRESIGN(json('/api/files/stash/presign', { files: [{ sha256: sha, sizeBytes: bytes.length }] }))).json()).uploads).toEqual([]);
});
it('commit stores a dropped folder with its file date', async () => {
  const r = await COMMIT(json('/api/files/stash/commit', { dir: 'STASH:', onClash: 'ask', entries: [
    { path: 'Drop', kind: 'dir', sizeBytes: 0 },
    { path: 'Drop/hello.txt', kind: 'file', sha256: sha, sizeBytes: bytes.length, lastModified: Date.UTC(2024, 1, 3) }] }));
  expect(r.status).toBe(200);
  const [row] = (await listStash(getDb(), 'o1')).filter((x) => x.path === 'Drop/hello.txt');
  expect([row.source, row.date?.toISOString()]).toEqual(['browser', '2024-02-03T00:00:00.000Z']);
});
it('commit cleans a long name to 30 characters', async () => {
  const long = 'A very long file name from Windows 11.txt';
  const r = await COMMIT(json('/api/files/stash/commit', { dir: 'STASH:', onClash: 'ask', entries: [{ path: long, kind: 'file', sha256: sha, sizeBytes: bytes.length }] }));
  const body = await r.json();
  expect(body.renamed[0].to.length).toBeLessThanOrEqual(30);
  expect(body.renamed[0].to.endsWith('.txt')).toBe(true);
});
it('commit refuses a size that does not match, bytes that do not hash, and a batch over 64 MB', async () => {
  const wrong = await COMMIT(json('/api/files/stash/commit', { dir: 'STASH:', onClash: 'ask', entries: [{ path: 'w.txt', kind: 'file', sha256: sha, sizeBytes: 3 }] }));
  expect((await wrong.json()).items[0]).toMatchObject({ ok: false, refusal: { code: 'failed' } });
  const fake = 'c'.repeat(64); await diskStore.put(fake, bytes);
  const forged = await COMMIT(json('/api/files/stash/commit', { dir: 'STASH:', onClash: 'ask', entries: [{ path: 'f.txt', kind: 'file', sha256: fake, sizeBytes: bytes.length }] }));
  expect((await forged.json()).items[0]).toMatchObject({ ok: false, refusal: { code: 'failed' } });
  const big = await COMMIT(json('/api/files/stash/commit', { dir: 'STASH:', onClash: 'ask',
    entries: Array.from({ length: 4 }, (_, i) => ({ path: `b${i}`, kind: 'file', sha256: sha, sizeBytes: 20 * 1024 * 1024 })) }));
  expect(big.status).toBe(413);
});
it('commit asks on a clash and writes nothing', async () => {
  const r = await COMMIT(json('/api/files/stash/commit', { dir: 'STASH:', onClash: 'ask', entries: [{ path: 'Drop', kind: 'dir', sizeBytes: 0 }] }));
  expect(r.status).toBe(409);
});
it('a URL is fetched into STASH: under the name the server gave, keep-both on a clash', async () => {
  vi.mocked(fetchUrlSafely).mockResolvedValue({ ok: true, bytes, finalUrl: new URL('https://example.org/x/dl.php'), contentDisposition: 'attachment; filename="Tune.mod"' });
  expect(await (await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/x/dl.php' }))).json()).toEqual({ path: 'STASH:/Tune.mod' });
  expect(await (await URL_POST(json('/api/files/stash/url', { url: 'https://example.org/x/dl.php' }))).json()).toEqual({ path: 'STASH:/Tune_1.mod' });
  vi.mocked(fetchUrlSafely).mockResolvedValueOnce({ ok: false, code: 'address_not_allowed' });
  expect((await URL_POST(json('/api/files/stash/url', { url: 'http://10.0.0.1/' }))).status).toBe(400);
});
```

- [ ] **Step 2: Run** `pnpm test:db src/app/api/files` → FAIL.
- [ ] **Step 3: Implement** the routes (each starts `const { orgId, userId } = await requireOrg();`; `maxDuration = 60` on download, commit and url) and `zipIncoming`.
- [ ] **Step 4: Run** `pnpm test:db src/app/api/files && pnpm vitest run src/lib/disk-zip.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/app/api/files src/lib/files/stash-commit.ts src/lib/files/stash-driver.ts src/lib/disk-zip.ts
git commit -m "Files: routes through the drivers; STASH: browser upload (presign, commit) and Paste URL; zips across devices"
```

---

### Task 7: The manager shows STASH: (device buttons, Files…, archives, Add to library)

**Files:**
- Modify: `src/lib/files/path.ts` (+ test), `src/components/files/pane.tsx` (+ `pane.test.ts`), `src/components/files/files-manager.tsx`, `src/components/files/dialogs.tsx` (Info), `src/app/(app)/files/page.tsx`, `src/components/files/copy-to-picker.tsx`
- Test: `src/lib/files/path.test.ts`, `src/components/files/pane.test.ts`, `src/lib/files/pane-rules.test.ts`

**Interfaces:**
- Produces:
  - `path.ts`: `export const PANE_DEVICES: readonly Device[] = ['STASH', 'LIBRARY']` (increment 3 inserts NET); `filesHrefForDisk(gameId, diskId, history?)` → `/files?left=STASH:&right=…&active=right[#disk-history]`; `export const DEFAULT_LEFT = 'STASH:'`, `DEFAULT_RIGHT = 'LIBRARY:'`.
  - `src/lib/files/pane-rules.ts` (client-safe): `export function holdsFiles(l: Listing | null): boolean` (inside a disk, or any STASH: path), `export function addToLibraryReason(l: Listing | null, picked: FsEntry[]): string | null`.
- Behaviour:
  - Pane device buttons render `PANE_DEVICES` (`pane-<side>-dev-STASH`, `pane-<side>-dev-LIBRARY`), `aria-pressed` on the one shown.
  - `page.tsx` and the manager's `pathParam` accept any `PANE_DEVICES` path; defaults `DEFAULT_LEFT`/`DEFAULT_RIGHT`; first listings via `driverFor(p.device)!.list`, a `Refused` (archive) → the pane's error words.
  - Reasons: `sourceReason`/`transferReason`/`makedir` use `holdsFiles(l)` instead of `l.disk`; the destination's words when it cannot hold files: "Open a disk or STASH: on the other side".
  - `openRow`: `archive` opens like a folder; an archive that answers 422 shows `refusalWords('archive_unreadable')` in a toast and the pane stays.
  - A new button **Add to library** (`files-addlib`, phone: in More ▾) in the column after Info, rendered only while the active pane's listing is in STASH:; `addToLibraryReason`: none picked → "Select something first"; inside an archive → "Copy it out of the archive first"; any picked entry not a `file`/`archive` whose name matches `/\.(adf|dsk|adz|dms|dmz|hfe)$/i` → "Select disk images (ADF, ADZ, DMS, DMZ, HFE) to add them". It posts `{ op: 'add-to-library', sources }`; done → toast `Added 1 disk to the library` with action **Open title** (`/games/<gameId>`, the first `added`), failures listed as for other ops; both panes reload (the row gains `in the library`).
  - Info dialog: comment editable when the listing is writable (STASH: or a disk).
  - Foot: in a writable STASH: folder with nothing selected → `${meta} · Drop files here`.
  - `KNOWN_CODES` gains `stash_full`, `too_large`, `archive_unreadable`, `not_a_disk_image`.
  - Phone picker (`copy-to-picker.tsx`): device chips STASH: / LIBRARY: at the top of the picker; "Copy here" enabled where `holdsFiles(l) && l.writable`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/files/pane-rules.test.ts
import { describe, it, expect } from 'vitest';
import { holdsFiles, addToLibraryReason } from './pane-rules';
import type { FsEntry, Listing } from './types';

const L = (path: string, extra: Partial<Listing> = {}): Listing => ({ path, crumbs: [], entries: [], writable: true, readOnlyReason: null, disk: null, meta: '', ...extra });
const E = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({ name, kind, path: `STASH:/${name}`, size: 1, date: null, protection: null, comment: null, marks: [] });

describe('holdsFiles', () => {
  it('is true in STASH: and inside a disk, false above the disks', () => {
    expect(holdsFiles(L('STASH:'))).toBe(true);
    expect(holdsFiles(L('STASH:/a.lha/x', { writable: false, readOnlyReason: 'archive' }))).toBe(true);
    expect(holdsFiles(L('LIBRARY:/g1'))).toBe(false);
    expect(holdsFiles(null)).toBe(false);
  });
});
describe('addToLibraryReason', () => {
  it('asks for disk images only, outside archives', () => {
    expect(addToLibraryReason(L('STASH:'), [])).toBe('Select something first');
    expect(addToLibraryReason(L('STASH:'), [E('Game.adf'), E('Two.DMS')])).toBeNull();
    expect(addToLibraryReason(L('STASH:'), [E('Game.adf'), E('ReadMe')])).toMatch(/Select disk images/);
    expect(addToLibraryReason(L('STASH:'), [E('Mods', 'dir')])).toMatch(/Select disk images/);
    expect(addToLibraryReason(L('STASH:/x.zip', { writable: false, readOnlyReason: 'archive' }), [E('Game.adf')])).toBe('Copy it out of the archive first');
  });
});
```
In `path.test.ts`: `filesHrefForDisk('g1','d1')` → `'/files?left=STASH:&right=LIBRARY%3A%2Fg1%2Fd1&active=right'`. In `pane.test.ts`: replace "only the LIBRARY: device button" with: both `pane-left-dev-STASH` and `pane-left-dev-LIBRARY` render, `aria-pressed="true"` on STASH: for a STASH: listing; an `archive` row renders with `data-kind="archive"` and a `ZIP`/`LHA` chip.

- [ ] **Step 2: Run** `pnpm vitest run src/lib/files src/components/files` → FAIL.
- [ ] **Step 3: Implement.** Then `rg -n "left=LIBRARY:" src e2e` and update every hard-coded Files link and e2e URL that meant "Files… on a disk" to the new left side (the e2e expectations for `left=LIBRARY:` in `e2e/files*.spec.ts` change to `left=STASH:`).
- [ ] **Step 4: Run** `pnpm vitest run src/lib/files src/components/files "src/app/(app)/files" && pnpm tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/path.ts src/lib/files/path.test.ts src/lib/files/pane-rules.ts src/lib/files/pane-rules.test.ts \
  src/components/files "src/app/(app)/files/page.tsx" e2e/files.spec.ts e2e/files.mobile.spec.ts e2e/files-parity.spec.ts e2e/files-strip.spec.ts
git commit -m "Files: STASH: in the panes -- device buttons, Files… opens STASH: | disk, archives open, Add to library"
```

---

### Task 8: The STASH: drop zone and drops from the computer into STASH:

**Files:**
- Create: `src/components/files/stash-drop-zone.tsx`, `src/components/files/use-stash-upload.ts`
- Modify: `src/lib/files/stash-paths.ts` (+ test: `planStashBatches`), `src/components/files/files-manager.tsx`, `src/app/(app)/files/page.tsx`
- Test: `src/lib/files/stash-paths.test.ts` (new describe)

**Interfaces:**
- Consumes: Task 6 routes; `readDroppedItems` (`src/lib/drop-reader.ts`), `hashBlob` (`src/lib/browser-hash.ts`), `mapLimit` (`src/lib/pool.ts`), `DropCard`, `INK_LABEL`, `INK_STYLE` (`src/components/ingest/drop-card.tsx`), `describeUrlRefusal` (`src/lib/url-ingest-messages.ts`).
- Produces:
  - `stash-paths.ts`: `export type DropFile = { path: string; kind: 'file' | 'dir'; sizeBytes: number }` and `export function planStashBatches(items: DropFile[]): { batches: DropFile[][]; refused: { path: string; why: 'too_large' | 'folder_too_large' }[] }` — a file over `STASH_FILE_MAX` refused (`too_large`); items grouped by first segment (a top folder stays in one batch); a top over `STASH_COMMIT_MAX_BYTES` refused whole (`folder_too_large`); tops packed in order into batches ≤ 64 MB and ≤ 200 entries.
  - `useStashUpload(): { busy: string | null; upload(dir: string, items: DroppedItem[], onClash: OnClash): Promise<{ items: OpItem[]; renamed: { from: string; to: string }[]; refused: { path: string; why: string }[] } | { clashes: Clash[] }> }` — hashes each file (`hashBlob`), `POST presign` per batch, PUTs missing blobs (6 at a time, one retry on a 403 as `dropzone.tsx` does), then `POST commit` per batch; `busy` reads "Uploading 3 of 12…".
  - `StashDropZone({ onDone(): void })` (`data-testid="files-drop-stash"`): title "Drop files into STASH:", hint "Any file or folder, up to 20 MB a file. .lha and .zip stay whole — open them in the pane.", a "Browse files" label with `<input type="file" multiple data-testid="files-stash-input">`, and a URL form (`data-testid="files-stash-url"`, input `files-stash-url-input`, button `files-stash-url-fetch`, status `files-stash-url-status` using `describeUrlRefusal`). Drops (whole card, `isFileDrag`) and picks go to `STASH:` root (ruling R1: the zone is the root; a pane drop writes into the pane's folder).
- Behaviour in the manager:
  - The page renders `<StashDropZone>` above the manager (`grid gap-5 lg:grid-cols-2`, the right cell empty until increment 3) and the manager exposes a `reload()` the zone calls (`onDone`).
  - `dropFromComputer` on a pane whose listing is a writable STASH: folder: read with `readDroppedItems` synchronously, compare the top names with the listing's entries (case-insensitive); any clash → the Clash dialog (Replace / Skip / Keep both, for all) and `upload` with that choice; none → `upload(..., 'ask')`. The result toast: `Added 3 items to STASH:` (+ "2 names shortened for the Amiga" when `renamed`), refusals listed as for ops; reload both panes. Inside a disk the increment-1 review flow is unchanged; inside an archive or above the disks: the toast the pane already gives.
  - Pane `onDragOver` accepts files where `holdsFiles(l) && l.writable`.

- [ ] **Step 1: Write the failing test**

```ts
describe('planStashBatches', () => {
  const MB = 1024 * 1024;
  const f = (path: string, mb: number) => ({ path, kind: 'file' as const, sizeBytes: Math.round(mb * MB) });
  it('keeps a folder in one batch and packs tops up to 64 MB', () => {
    const { batches, refused } = planStashBatches([f('A/1', 30), f('A/2', 30), f('b', 10), f('c', 10)]);
    expect(batches.map((b) => b.map((x) => x.path))).toEqual([['A/1', 'A/2'], ['b', 'c']]);
    expect(refused).toEqual([]);
  });
  it('refuses a file over 20 MB and a folder over 64 MB, and packs at most 200 entries', () => {
    const { batches, refused } = planStashBatches([f('big.iso', 21), f('F/a', 19), f('F/b', 19), f('F/c', 19), f('F/d', 19),
      ...Array.from({ length: 250 }, (_, i) => f(`t${i}`, 0.001))]);
    expect(refused).toEqual([{ path: 'big.iso', why: 'too_large' }, { path: 'F', why: 'folder_too_large' }]);
    expect(batches.map((b) => b.length)).toEqual([200, 50]);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/lib/files/stash-paths.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helper, hook, zone and manager changes.
- [ ] **Step 4: Run** `pnpm vitest run src/lib/files src/components/files && pnpm tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/stash-paths.ts src/lib/files/stash-paths.test.ts src/components/files/stash-drop-zone.tsx \
  src/components/files/use-stash-upload.ts src/components/files/files-manager.tsx "src/app/(app)/files/page.tsx"
git commit -m "Files: the STASH: drop zone (Browse files, Paste URL) and drops from the computer into STASH:"
```

---

### Task 9: End to end and contrast

**Files:**
- Create: `e2e/amiga-board.ts` (move `boardSays`, `amigaJson`, `boardOpens`, `boardSendsChunks`, `boardCloses`, `boardUploads` out of `e2e/from-amiga.spec.ts`, which then imports them), `e2e/files-stash.spec.ts`
- Modify: `e2e/files.mobile.spec.ts`, `e2e/contrast.spec.ts`

Seed helpers at the top of `e2e/files-stash.spec.ts`: `seedTitle` from `e2e/files.spec.ts` (copy it: format FFS, `ReadMe`, `S/`, `C/Assign` with a comment), `openFiles(page, left, right, active)`, `row`, `rowNames`, `toast`; `test.afterAll(cleanupSeeded)`.

Tests (desktop):
1. `Files… on a disk opens STASH: | the disk` — from the title page, `files-<diskId>`; URL has `left=STASH:`; the left pane's `pane-left-dev-STASH` is pressed.
2. `the drop zone's Browse files puts files into STASH:` — `setInputFiles` on `files-stash-input` with `a.txt` and `b.txt` → both rows in the STASH: pane; foot says "Drop files here".
3. `a drop on the STASH: pane asks on a clash; Keep both adds a_1.txt` — dispatch a synthetic drop (use `e2e/drag-drop-helpers.ts`'s file-drop helper) of `a.txt` onto `pane-left`.
4. `copy STASH: → disk and back keeps the comment` — Info on `a.txt` sets comment `bench`; Copy → into the disk; Info on the disk's `a.txt` shows `bench`; copy `C` from the disk into STASH:; `Assign` shows its comment in the Comment column.
5. `an archive opens read-only and a file copies out of it` — upload `src/lib/archive/fixtures/t.zip`; double-click `t.zip`; read-only line shows "Archives are read-only — copy files out of them."; select `src/readme.txt`, Copy → onto the disk; the disk row's date reads `2026-09-11`.
6. `a file from the Amiga lands in STASH: with its board` — `pairDevice` + `boardSays` + `boardUploads(request, token, 'Up/hi.txt', Buffer.from('hi'))`; reload; `Up/hi.txt` row's marks include `from <board name>`.
7. `Add to library from STASH:` — upload a formatted ADF (`formatVolume` bytes) as `Game.adf`; select; `files-addlib`; toast "Added 1 disk to the library"; **Open title** navigates to `/games/`.
8. `makedir, rename and delete in STASH:` — F7 `Box`; F2 → `Crate`; Delete → confirm → gone.
9. `Paste URL refuses a private address with words` — `files-stash-url-input` = `http://10.0.0.1/x`, fetch → `files-stash-url-status` shows `describeUrlRefusal('address_not_allowed')`'s text (the suite never fetches the public internet).

Phone (`e2e/files.mobile.spec.ts`): at 390×844, the STASH: drop zone stacks above the switcher; Copy to… from STASH: into a disk; `noSideways(page)`.

Contrast (`e2e/contrast.spec.ts`, `Files` block): the STASH: drop zone's title/hint/Browse files/URL field, the `arriving`/`from` marks, the archive read-only line, the Add to library button enabled and disabled.

- [ ] **Step 1:** write the specs and move the board helpers. **Step 2:** `PORT=3100 bash scripts/e2e-local.sh e2e/files-stash.spec.ts --project=desktop` → the new tests pass (a failure is a defect to fix in the owning task's code, not a test to weaken). **Step 3:** `PORT=3100 bash scripts/e2e-local.sh e2e/files.mobile.spec.ts --project=mobile`, then `… e2e/contrast.spec.ts --project=desktop -g "Files"`. **Step 4:** the specs this increment touched, each run under 9 minutes: `e2e/files.spec.ts e2e/files-parity.spec.ts e2e/files-strip.spec.ts`, then `e2e/from-amiga.spec.ts e2e/upload-staging.spec.ts` (the Upload page must still list only Amiga files, R5), then `e2e/archive-drop.spec.ts e2e/archive-drop-folder.spec.ts` (archive member dates/bits now travel into disks). **Step 5:** commit:

```bash
git add e2e/amiga-board.ts e2e/from-amiga.spec.ts e2e/files-stash.spec.ts e2e/files.mobile.spec.ts e2e/contrast.spec.ts
git commit -m "Files: e2e for STASH: (drops, URL, archives, Amiga uploads, Add to library) and contrast"
```

---

## After the last task

- Full unit (`pnpm vitest run`), DB (`pnpm test:db`), `pnpm build`, lint on changed files; `pnpm adffs:verify`.
- The controller applies `drizzle/0051_stash.sql` to production before the merge deploys (never from this branch's scripts).
- HANDOFF §4: increment 2 shipped with the merge hash; record rulings R1–R11; increment 3 (NET: and the Library) next.
- Help: STASH: and NET: get their help topic in increment 4; no help text names STASH: yet, and nothing this increment changed is described by an existing topic (the Upload page still exists).
