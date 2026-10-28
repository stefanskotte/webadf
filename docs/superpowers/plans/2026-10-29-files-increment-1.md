# Files, increment 1 (LIBRARY: and the Files page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/files` page with two panes over LIBRARY: (titles → disks → a disk's folders), a Directory Opus button column, server-side copy/move/delete/makedir/rename/protect/comment between and within disks, sortable headers, a disk strip that takes over the Browse page, and "Files…" buttons replacing "Browse".

**Architecture:** A pure path module (`src/lib/files/path.ts`) names everything (`LIBRARY:/<gameId>/<diskId>/C/Assign`). A LIBRARY: driver lists and reads; an ops engine plans each operation per destination disk and writes it with one `applyDiskEdit` (so one history version per disk touched). Three routes (`/api/files/list|ops|download`) front it. The page is a client `FilesManager` with two `Pane`s and a button column; state lives in the URL.

**Tech Stack:** Next.js 16 App Router (params/searchParams are Promises; read `node_modules/next/dist/docs/` before writing routes), React 19, drizzle (Postgres), zod 4, vitest (unit `pnpm vitest run`, DB `pnpm test:db` with `TEST_DATABASE_URL` from `bash scripts/dev-db.sh start`), Playwright (`PORT=3100 bash scripts/e2e-local.sh <specs> --project=desktop|mobile`).

**Spec:** `docs/superpowers/specs/2026-10-29-files-manager-design.md` (increment 1 = §9 item 1).

## Global Constraints

- Paths: `<DEVICE>:` + `/`-separated segments; titles, disks (and later boards) by **id**; names only for display (spec §3.1).
- One operation = **one new history version per disk it touches** (spec §4.1).
- Copies keep **date, protection and comment** (spec §4.1).
- A disk a board holds (`findHolder`) is read-only; copying **out** of it works (spec §4.1).
- Free space is checked **before** writing; a copy that does not fit is refused whole for that disk with "needs N KB, M KB free" (spec §4.1, §8).
- AmigaDOS names: at most 30 characters, no `:` or `/` (spec §4.1). Comments at most 79 characters (the header's field).
- A foreign or unknown id is 404, never 403 (spec §8).
- Copy/move with `onClash: 'ask'` and a clash returns `409 { clashes }` and writes nothing (spec §3.3).
- Column headers sort asc/desc, folders first; sort remembered per user and per device (spec §5.1).
- Keys: ↑/↓, Space, Enter, Backspace, Tab, F5 copy, F6 move, F7 makedir, F2 rename, Delete; never while typing or with a dialog open (spec §5.2).
- URL state: `/files?left=<path>&right=<path>&active=left|right` (spec §5.2).
- Self-host parity: nothing Vercel-only (spec §11).
- Never `git add -A`; never `git stash`. e2e: one run at a time, foreground, under 9 minutes, `PORT=3100`, via `scripts/e2e-local.sh` (isolated DB). Help text in `src/lib/help/topics.tsx` must change with behaviour it describes.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01UC3JRhVLZ5t9XkU2Ekdf6j`.

## Increment-1 rulings (scope cuts the spec leaves to the build order)

- **R1 Devices.** Only LIBRARY: exists in increment 1. Device buttons render only LIBRARY:; STASH: and NET: arrive in increments 2 and 3. "Files…" therefore opens `left=LIBRARY:` (root) and `right=` the disk, `active=right`. Increment 2 changes the left default to STASH:.
- **R2 Nav.** The top nav keeps Upload until increment 3; `/files` is reached by "Files…". The page title is "Files".
- **R3 Historical versions.** `/disks/<id>/files?version=N` (the History panel's per-version view) stays as today's page. Only the versionless `/disks/<id>/files` redirects to Files.
- **R4 Download.** One file → `/api/files/download?path=`. Several files on ONE disk → the existing `/api/disks/<id>/files/zip?blocks=`. Several across disks → the Download button is disabled with "Select files on one disk to download them together".
- **R5 Computer drops.** Dropping files from the computer onto a pane that is inside a writable disk reuses the existing drop pipeline (`src/lib/staging.ts` `stageDrop` + `POST /api/disks/<id>/files/batch`); anywhere else the pane shows "Open a disk to drop files into it".

## Review Focus

1. **Case-insensitive clash.** Copying `readme` into a folder holding `ReadMe` is a clash (AmigaDOS compares names case-insensitively, `sameName` with the volume's intl flag) → Task 4 test `clash is case-insensitive`.
2. **Folder into itself.** Moving or copying a folder into itself or one of its own subfolders on the same disk is refused with "A folder cannot go inside itself" and nothing is written → Task 4 test `refuses a folder into its own subtree`.
3. **Partial fit.** A selection where some files would fit but not all is refused whole for that disk; the disk's sha256 is unchanged → Task 4 test `disk full refuses the whole copy`.
4. **Disk changed underneath.** The disk was edited elsewhere between listing and the op (`applyDiskEdit` → 409 `conflict`) → the route answers 409 `{ error: 'conflict' }` and the UI says "The disk changed — the pane has been refreshed" and reloads → Task 5 test `conflict maps to 409 conflict` and Task 8 handles `conflict`.
5. **International names.** A file named `Grüße` on an intl FFS volume copies to another disk under the same name and is found again by path → Task 4 test `copies an international name`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/lib/files/path.ts` (+ `.test.ts`) | Parse/format/navigate paths; AmigaDOS name rules. Client-safe, no imports beyond types. |
| `src/lib/files/types.ts` | `FsEntry`, `Listing`, `DiskInfo`, `OpRequest`, `OpOutcome`, refusal codes. Client-safe. |
| `src/lib/files/library.ts` (+ `.db.test.ts`) | LIBRARY: driver: list titles/disks/dirs, resolve a path to a disk + entry, read a file with meta. Server only. |
| `src/lib/files/ops.ts` (+ `.db.test.ts`) | The ops engine for LIBRARY:: copy, move, delete, makedir, rename, protect, comment. Server only. |
| `src/lib/files/sort.ts` (+ `.test.ts`) | Entry comparator (key, dir, folders first). Client-safe. |
| `src/lib/files/selection.ts` (+ `.test.ts`) | Pure selection reducer (click, shift, ctrl, keyboard cursor). Client-safe. |
| `src/lib/files/keys.ts` (+ `.test.ts`) | Key → command mapping with the "not while typing" guard. Client-safe. |
| `src/lib/files/words.ts` (+ `.test.ts`) | Refusal code → user words. Client-safe. |
| `src/lib/adffs/write.ts` (+ tests) | Gains date/comment on add/mkdir/batch, `setComment`. |
| `src/lib/user-prefs-schema.ts` (+ test) | Gains `files.sort.{library,stash,net}`. |
| `src/app/api/files/list/route.ts`, `ops/route.ts`, `download/route.ts` (+ `files-api.db.test.ts`) | Thin routes over the driver/engine. |
| `src/app/(app)/files/page.tsx`, `loading.tsx` | Server page: auth, prefs, initial listings. |
| `src/components/files/files-manager.tsx` | Two panes, active pane, URL sync, button column, dialogs, keys, drag. |
| `src/components/files/pane.tsx` | One pane: device buttons, crumbs, header row, entries table, foot. |
| `src/components/files/disk-strip.tsx` | Disk strip: drive state, Mount/Eject, usage, History panel, ⬇ ADF, volume name. |
| `src/components/files/dialogs.tsx` | Clash, delete confirm, name prompt (makedir/rename), protect, info. |
| `src/components/files/copy-to-picker.tsx` | Phone destination picker. |
| `src/app/(app)/disks/[id]/files/page.tsx` | Redirect when no `?version`. |
| `src/components/games/disk-row.tsx` | "Browse" → "Files…" link. |
| `e2e/files.spec.ts`, `e2e/files.mobile.spec.ts`, `e2e/contrast.spec.ts` | End to end. |

---

### Task 1: Paths and AmigaDOS names

**Files:**
- Create: `src/lib/files/path.ts`
- Test: `src/lib/files/path.test.ts`

**Interfaces:**
- Produces:
  - `type Device = 'STASH' | 'NET' | 'LIBRARY'`
  - `type FsPath = { device: Device; segments: string[] }`
  - `parsePath(raw: string): FsPath | null`
  - `formatPath(p: FsPath): string`
  - `parentOf(p: FsPath): FsPath | null`
  - `childOf(p: FsPath, name: string): FsPath`
  - `isWithin(inner: FsPath, outer: FsPath, sameName: (a: string, b: string) => boolean): boolean`
  - `amigaNameProblem(name: string): 'empty' | 'too-long' | 'bad-char' | null`
  - `AMIGA_NAME_MAX = 30`, `AMIGA_COMMENT_MAX = 79`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/files/path.test.ts
import { describe, it, expect } from 'vitest';
import { parsePath, formatPath, parentOf, childOf, isWithin, amigaNameProblem } from './path';

const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe('parsePath / formatPath', () => {
  it('parses a device root and nested segments', () => {
    expect(parsePath('LIBRARY:')).toEqual({ device: 'LIBRARY', segments: [] });
    expect(parsePath('LIBRARY:/g1/d1/C/Assign')).toEqual({ device: 'LIBRARY', segments: ['g1', 'd1', 'C', 'Assign'] });
    expect(parsePath('STASH:/Mods/enigma.mod')).toEqual({ device: 'STASH', segments: ['Mods', 'enigma.mod'] });
  });
  it('accepts a trailing slash and round-trips without it', () => {
    expect(formatPath(parsePath('LIBRARY:/g1/')!)).toBe('LIBRARY:/g1');
    expect(formatPath({ device: 'NET', segments: [] })).toBe('NET:');
  });
  it('refuses what is not a path', () => {
    for (const bad of ['', 'library:', 'DH0:/x', 'LIBRARY:x', 'LIBRARY://g1', 'LIBRARY:/g1//d1', 'LIBRARY:/./x',
      'LIBRARY:/../x', 'LIBRARY:/a\u0001b', `LIBRARY:/${'x'.repeat(256)}`, `LIBRARY:${'/x'.repeat(41)}`]) {
      expect(parsePath(bad), bad).toBeNull();
    }
  });
});

describe('navigation', () => {
  it('parentOf walks up and stops at the device', () => {
    expect(formatPath(parentOf(parsePath('LIBRARY:/g1/d1/C')!)!)).toBe('LIBRARY:/g1/d1');
    expect(formatPath(parentOf(parsePath('LIBRARY:/g1')!)!)).toBe('LIBRARY:');
    expect(parentOf(parsePath('LIBRARY:')!)).toBeNull();
  });
  it('childOf appends one segment', () => {
    expect(formatPath(childOf(parsePath('LIBRARY:/g1/d1')!, 'S'))).toBe('LIBRARY:/g1/d1/S');
  });
  it('isWithin is true for the path itself and below, case-insensitively by the given rule', () => {
    const outer = parsePath('LIBRARY:/g1/d1/C')!;
    expect(isWithin(parsePath('LIBRARY:/g1/d1/C')!, outer, ci)).toBe(true);
    expect(isWithin(parsePath('LIBRARY:/g1/d1/c/Tools')!, outer, ci)).toBe(true);
    expect(isWithin(parsePath('LIBRARY:/g1/d1/Libs')!, outer, ci)).toBe(false);
    expect(isWithin(parsePath('LIBRARY:/g1/d2/C')!, outer, ci)).toBe(false);
  });
});

describe('amigaNameProblem', () => {
  it('allows ordinary and international names up to 30 characters', () => {
    expect(amigaNameProblem('ReadMe')).toBeNull();
    expect(amigaNameProblem('Grüße.txt')).toBeNull();
    expect(amigaNameProblem('x'.repeat(30))).toBeNull();
  });
  it('names the problem', () => {
    expect(amigaNameProblem('')).toBe('empty');
    expect(amigaNameProblem('   ')).toBe('empty');
    expect(amigaNameProblem('x'.repeat(31))).toBe('too-long');
    expect(amigaNameProblem('a:b')).toBe('bad-char');
    expect(amigaNameProblem('a/b')).toBe('bad-char');
    expect(amigaNameProblem('a\u0007')).toBe('bad-char');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/files/path.test.ts`
Expected: FAIL, "Cannot find module './path'".

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/files/path.ts
// Files (spec 2026-10-29 §3.1): every place a pane can point at. CLIENT-SAFE: no imports.
// LIBRARY:/<gameId>/<diskId>/<dir>/<file>: titles and disks by id, so two titles with one name never collide; inside a
// disk, AmigaDOS names. STASH: and NET: arrive in increments 2 and 3.

export type Device = 'STASH' | 'NET' | 'LIBRARY';
export type FsPath = { device: Device; segments: string[] };

export const AMIGA_NAME_MAX = 30;
export const AMIGA_COMMENT_MAX = 79;
const SEGMENT_MAX = 255;
const DEPTH_MAX = 40;
const DEVICES: readonly Device[] = ['STASH', 'NET', 'LIBRARY'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parsePath(raw: string): FsPath | null {
  const m = /^([A-Z]+):(\/.*)?$/.exec(raw);
  if (!m || !DEVICES.includes(m[1] as Device)) return null;
  const device = m[1] as Device;
  if (!m[2] || m[2] === '/') return { device, segments: [] };
  const body = m[2].endsWith('/') ? m[2].slice(1, -1) : m[2].slice(1);
  const segments = body.split('/');
  if (segments.length > DEPTH_MAX) return null;
  for (const s of segments) {
    if (!s || s === '.' || s === '..' || s.length > SEGMENT_MAX || CONTROL.test(s)) return null;
  }
  return { device, segments };
}

export function formatPath(p: FsPath): string {
  return p.segments.length ? `${p.device}:/${p.segments.join('/')}` : `${p.device}:`;
}

export function parentOf(p: FsPath): FsPath | null {
  return p.segments.length ? { device: p.device, segments: p.segments.slice(0, -1) } : null;
}

export function childOf(p: FsPath, name: string): FsPath {
  return { device: p.device, segments: [...p.segments, name] };
}

/** `inner` is `outer` or below it. `sameName` decides one segment (AmigaDOS: case-insensitive, intl-aware). */
export function isWithin(inner: FsPath, outer: FsPath, sameName: (a: string, b: string) => boolean): boolean {
  if (inner.device !== outer.device || inner.segments.length < outer.segments.length) return false;
  return outer.segments.every((s, i) => sameName(inner.segments[i], s));
}

export function amigaNameProblem(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (!name.trim()) return 'empty';
  if ([...name].length > AMIGA_NAME_MAX) return 'too-long';
  if (name.includes(':') || name.includes('/') || CONTROL.test(name)) return 'bad-char';
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/files/path.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/path.ts src/lib/files/path.test.ts
git commit -m "Files: paths (LIBRARY:/<game>/<disk>/...) and AmigaDOS name rules"
```

---

### Task 2: adffs carries date and comment

`addFile` today writes **no date at all** (offset 420 of a header keeps whatever a recycled block held) and nothing writes a comment. Copies must keep both.

**Files:**
- Modify: `src/lib/adffs/write.ts` (`writeFileHeader` ~128, `addFile` 234, `makeDirectory` 312, `BatchOp` 43-49, `applyBatch` 861, new `setComment`)
- Modify: `src/lib/adffs/index.ts` (re-export `setComment`, `EntryMeta`)
- Test: `src/lib/adffs/write-meta.test.ts`

**Interfaces:**
- Produces:
  - `type EntryMeta = { date?: Date; comment?: string }`
  - `addFile(adf, parentBlock, name, bytes, protection?: number, meta?: EntryMeta): WriteResult`
  - `makeDirectory(adf, parentBlock, name, meta?: EntryMeta): WriteResult`
  - `BatchOp`: `mkdir`, `add`, `replace` each gain optional `date?: Date; comment?: string`
  - `setComment(adf, parentBlock, entryBlock, comment: string): WriteResult`
  - `WriteError` gains `'comment-too-long'`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/adffs/write-meta.test.ts
import { describe, it, expect } from 'vitest';
import { formatVolume } from './format';
import { ROOT_BLOCK } from './constants';
import { addFile, makeDirectory, applyBatch, setComment } from './write';
import { readVolume } from './index';

const when = new Date(Date.UTC(1993, 4, 17, 12, 34, 56, 0));
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => {
  if (!r.ok) throw new Error(r.reason);
  return r.adf;
};
const root = (adf: Uint8Array) => { const v = readVolume(adf); if (!v.ok) throw new Error(v.reason); return v.root; };

describe('date and comment on write', () => {
  it('addFile keeps the given date and comment', () => {
    const adf = must(addFile(formatVolume({ filesystem: 'FFS', volumeName: 'T' }), ROOT_BLOCK, 'ReadMe',
      new TextEncoder().encode('hi'), 0, { date: when, comment: 'From the bench' }));
    const e = root(adf).find((x) => x.name === 'ReadMe')!;
    expect(e.modifiedAt?.toISOString()).toBe(when.toISOString());
    expect(e.comment).toBe('From the bench');
  });
  it('addFile without meta stamps now, not a recycled date, and no comment', () => {
    const before = Date.now() - 1000;
    const adf = must(addFile(formatVolume({ filesystem: 'OFS', volumeName: 'T' }), ROOT_BLOCK, 'X', new Uint8Array(1)));
    const e = root(adf).find((x) => x.name === 'X')!;
    expect(e.modifiedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(e.comment).toBeNull();
  });
  it('makeDirectory keeps the given date and comment', () => {
    const adf = must(makeDirectory(formatVolume({ filesystem: 'FFS', volumeName: 'T' }), ROOT_BLOCK, 'S',
      { date: when, comment: 'scripts' }));
    const e = root(adf).find((x) => x.name === 'S')!;
    expect(e.kind).toBe('dir');
    expect(e.modifiedAt?.toISOString()).toBe(when.toISOString());
    expect(e.comment).toBe('scripts');
  });
  it('applyBatch carries date and comment for mkdir and add', () => {
    const adf = must(applyBatch([
      { op: 'mkdir', parentPath: '', name: 'C', date: when, comment: 'cmds' },
      { op: 'add', parentPath: 'C', name: 'Assign', bytes: new Uint8Array(10), protection: 0, date: when, comment: 'x' },
    ])(formatVolume({ filesystem: 'FFS', volumeName: 'T' })));
    const c = root(adf).find((x) => x.name === 'C')!;
    expect(c.comment).toBe('cmds');
    const a = c.children.find((x) => x.name === 'Assign')!;
    expect(a.modifiedAt?.toISOString()).toBe(when.toISOString());
    expect(a.comment).toBe('x');
  });
  it('setComment replaces and clears a comment, and refuses one over 79 characters', () => {
    let adf = must(addFile(formatVolume({ filesystem: 'FFS', volumeName: 'T' }), ROOT_BLOCK, 'F', new Uint8Array(1),
      0, { comment: 'old' }));
    const block = root(adf).find((x) => x.name === 'F')!.block;
    adf = must(setComment(adf, ROOT_BLOCK, block, 'new one'));
    expect(root(adf).find((x) => x.name === 'F')!.comment).toBe('new one');
    adf = must(setComment(adf, ROOT_BLOCK, block, ''));
    expect(root(adf).find((x) => x.name === 'F')!.comment).toBeNull();
    expect(setComment(adf, ROOT_BLOCK, block, 'x'.repeat(80))).toEqual({ ok: false, reason: 'comment-too-long' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/adffs/write-meta.test.ts`
Expected: FAIL (`setComment` is not exported; the date assertions fail).

- [ ] **Step 3: Implement**

In `src/lib/adffs/write.ts`:

1. Add near the other types:
```ts
/** What a copy carries besides the bytes (spec 2026-10-29 §4.1). Absent date = now; absent comment = none. */
export type EntryMeta = { date?: Date; comment?: string };
const COMMENT_OFFSET = 328;   // BCPL string: length byte + up to 79 characters (dir.ts reads it with bcplString(b, 328, 79))
const DATE_OFFSET = 420;      // days, mins, ticks (putAmigaDate)
const COMMENT_MAX = 79;
```
2. Add `'comment-too-long'` to `WriteError`.
3. Add a writer next to `putName`, encoding the comment exactly the way `putName` encodes names (same byte mapping, so `bcplString` reads it back):
```ts
function putComment(adf: Uint8Array, blockStart: number, comment: string | undefined): void {
  adf.fill(0, blockStart + COMMENT_OFFSET, blockStart + COMMENT_OFFSET + 1 + COMMENT_MAX);
  if (!comment) return;
  const bytes = encodeName(comment);              // the encoder putName uses; reuse it, do not add a second one
  adf[blockStart + COMMENT_OFFSET] = bytes.length;
  adf.set(bytes, blockStart + COMMENT_OFFSET + 1);
}
```
(If `putName` inlines its encoding, extract it into `encodeName(s: string): Uint8Array` first and use it in both.)
4. `writeFileHeader` gains a trailing `meta?: EntryMeta` parameter; before the checksum line write `putAmigaDate(adf, hs + DATE_OFFSET, meta?.date ?? new Date()); putComment(adf, hs, meta?.comment);`. Written unconditionally for the same recycled-block reason as protection.
5. `addFile(adf, parentBlock, name, bytes, protection?, meta?)`: refuse `meta?.comment` longer than 79 characters with `'comment-too-long'` before allocating; pass `meta` to `writeFileHeader`.
6. `makeDirectory(adf, parentBlock, name, meta?)`: same refusal; where it stamps `new Date()` (~322) use `meta?.date ?? new Date()`; call `putComment(out, bs, meta?.comment)` before its checksum.
7. `BatchOp`: add `date?: Date; comment?: string` to `mkdir`, `add` and `replace`. In `applyBatch`, pass `{ date: op.date, comment: op.comment }` to `makeDirectory`/`addFile`; for `replace`, after `replaceFile` succeeds call `setMetaOnBlock` (below) when `op.date` or `op.comment` is set.
8. New export:
```ts
/** Set (or clear, with '') a file's or directory's comment (spec 2026-10-29 §5.1 Info). */
export function setComment(adf: Uint8Array, parentBlock: number, entryBlock: number, comment: string): WriteResult {
  if ([...comment].length > COMMENT_MAX) return { ok: false, reason: 'comment-too-long' };
  return rewriteHeader(adf, parentBlock, entryBlock, (out, bs) => putComment(out, bs, comment || undefined));
}
```
where `rewriteHeader` is the copy-validate-checksum helper `setProtection` already uses (extract it from `setProtection` if it is inline: copy the image, check the entry is a child of `parentBlock`, run the mutation, recompute `CHECKSUM_WORD`). Use the same helper for a private `setMetaOnBlock(adf, entryBlock, meta)` used by `replace`.
9. Re-export `setComment` and `type EntryMeta` from `src/lib/adffs/index.ts` next to the other write functions.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/lib/adffs`
Expected: PASS, including every existing adffs test (the date now written on add must not break `pnpm adffs:verify` either: run `pnpm adffs:verify` and expect its usual pass count).

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/index.ts src/lib/adffs/write-meta.test.ts
git commit -m "adffs: add/mkdir/batch keep a date and comment; setComment; addFile no longer leaves a recycled date"
```

---

### Task 3: Shared types and the LIBRARY: driver (list, resolve, read)

**Files:**
- Create: `src/lib/files/types.ts`, `src/lib/files/library.ts`
- Test: `src/lib/files/library.db.test.ts`

**Interfaces:**
- Consumes: Task 1 `parsePath`, `formatPath`, `FsPath`; `readVolume`, `readUsage`, `readFileBytes`/`readFile`, `sameName`, `AdfEntry` (adffs); `findHolder` (`src/lib/disk-holder.ts`); `isLocal` (`src/lib/remote-hidden.ts`); `diskStore` (`@/lib/storage`); schema `games`, `disks`, `entitlements`.
- Produces (`types.ts`, client-safe):
```ts
export type EntryKind = 'title' | 'disk' | 'dir' | 'file';
export type FsEntry = {
  name: string; kind: EntryKind; path: string;
  size: number | null; date: string | null; protection: string | null; comment: string | null;
  marks: string[];
};
export type DiskInfo = {
  diskId: string; gameId: string; title: string; label: string; filesystem: 'OFS' | 'FFS' | null; hd: boolean;
  usedBytes: number | null; freeBytes: number | null; totalBytes: number | null;
  holder: string | null; imageFormat: 'adf' | 'hfe'; volumeName: string | null; sha256: string;
};
export type Crumb = { label: string; path: string };
export type Listing = {
  path: string; crumbs: Crumb[]; entries: FsEntry[];
  writable: boolean; readOnlyReason: string | null; disk: DiskInfo | null; meta: string;
};
export type RefusalCode =
  | 'not_found' | 'read_only' | 'mounted' | 'disk_full' | 'name_exists' | 'bad_name' | 'comment_too_long'
  | 'cycle' | 'no_filesystem' | 'hfe_read_only' | 'conflict' | 'unsupported' | 'blob_unavailable' | 'failed';
export type Refusal = { code: RefusalCode; detail?: string };
```
- Produces (`library.ts`, server only):
  - `type FsCtx = { orgId: string; userId: string | null }`
  - `listLibrary(ctx: FsCtx, p: FsPath): Promise<Listing | null>` (null = not found)
  - `type ResolvedDisk = { info: DiskInfo; bytes: Uint8Array; root: AdfEntry[]; rootBlock: number; intl: boolean }`
  - `loadDisk(ctx: FsCtx, gameId: string, diskId: string): Promise<ResolvedDisk | null>`
  - `resolveInDisk(d: ResolvedDisk, names: string[]): { entry: AdfEntry | null; parentBlock: number; dirBlock: number } | null` (empty `names` = the root: `entry: null`, `dirBlock: rootBlock`)
  - `readLibraryFile(ctx, p): Promise<{ name: string; bytes: Uint8Array; date: Date | null; protection: string; comment: string | null } | null>`

Listing rules:
- `LIBRARY:` → the org's local titles (`games` where `orgId` and `isLocal(games)`), `kind: 'title'`, name = title, sorted by `sortTitle`, meta `"<n> titles"`. `writable: false`, `readOnlyReason: null` (nothing can be written at this level; the UI disables write buttons by `writable`).
- `LIBRARY:/<gameId>` → its local disks (`disks` where `gameId`, `orgId`, `isLocal(disks)`, joined to `entitlements` on `orgId`+`sha256` like the Browse page), `kind: 'disk'`, name = `label ?? 'Disk ' + diskNo`, ordered by `diskNo`, `size` = `sizeBytes`, mark `in DF0: of <board>` when held. 404 (null) when the game is not the org's.
- `LIBRARY:/<gameId>/<diskId>[/names…]` → `loadDisk` then the directory's children: `kind` dir/file, `size` (null for dirs), `date` ISO, `protection` (the hsparwed string), `comment`. `disk` = `info`. `writable` = filesystem present AND `imageFormat === 'adf'` AND no holder; else `readOnlyReason` = `'mounted on "<board>"'` (use `mountedReason`), `'hfe_read_only'` or `'no_filesystem'`. Meta: `"<dirs> folders · <files> files"`. A file path (not a dir) → null.
- Crumbs: `LIBRARY:` → `{label:'LIBRARY:', path:'LIBRARY:'}`, then title name, disk name, then each folder name, each with its path.

- [ ] **Step 1: Write the failing DB test**

```ts
// src/lib/files/library.db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_library_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-lib-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { createHash } = await import('node:crypto');
const { games, disks, entitlements, blobs } = await import('@/db/schema/catalog');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { diskStore } = await import('@/lib/storage');
const { formatVolume } = await import('@/lib/adffs/format');
const { addFile, makeDirectory } = await import('@/lib/adffs/write');
const { ROOT_BLOCK } = await import('@/lib/adffs/constants');
const { readVolume } = await import('@/lib/adffs');
const { parsePath } = await import('./path');
const { listLibrary, readLibraryFile } = await import('./library');

const ctx = { orgId: 'o1', userId: null };
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => { if (!r.ok) throw new Error(r.reason); return r.adf; };
const P = (s: string) => parsePath(s)!;

async function seedDisk(gameId: string, title: string, diskId: string, diskNo: number, adf: Uint8Array) {
  const sha = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(sha, adf);
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha, sizeBytes: adf.length }).onConflictDoNothing();
  await db.insert(entitlements).values({ orgId: 'o1', sha256: sha, sourceFilename: `${title}.adf` }).onConflictDoNothing();
  await db.insert(games).values({ id: gameId, orgId: 'o1', title, sortTitle: title.toLowerCase() }).onConflictDoNothing();
  await db.insert(disks).values({ id: diskId, gameId, orgId: 'o1', diskNo, sha256: sha, sizeBytes: adf.length });
  return sha;
}

let sysSha = '';
beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: new Date() }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: new Date() }]);
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SysInfo' });
  adf = must(makeDirectory(adf, ROOT_BLOCK, 'C'));
  const cBlock = (readVolume(adf) as { ok: true; root: { name: string; block: number }[] }).root.find((e) => e.name === 'C')!.block;
  adf = must(addFile(adf, cBlock, 'Assign', new TextEncoder().encode('assign!'), 0, { comment: 'cmd' }));
  adf = must(addFile(adf, ROOT_BLOCK, 'ReadMe', new TextEncoder().encode('hello')));
  sysSha = await seedDisk('g1', 'SysInfo', 'd1', 1, adf);
  await seedDisk('g2', 'Turrican', 'd2', 1, formatVolume({ filesystem: 'OFS', volumeName: 'T1' }));
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('LIBRARY: listing', () => {
  it('lists titles at the root', async () => {
    const l = (await listLibrary(ctx, P('LIBRARY:')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual([
      ['title', 'SysInfo', 'LIBRARY:/g1'], ['title', 'Turrican', 'LIBRARY:/g2']]);
    expect(l.writable).toBe(false);
  });
  it("lists a title's disks with a Disk N name", async () => {
    const l = (await listLibrary(ctx, P('LIBRARY:/g1')))!;
    expect(l.entries.map((e) => [e.kind, e.name, e.path])).toEqual([['disk', 'Disk 1', 'LIBRARY:/g1/d1']]);
    expect(l.crumbs.map((c) => c.label)).toEqual(['LIBRARY:', 'SysInfo']);
  });
  it("lists a disk's root and a folder, with protection, comment and the disk info", async () => {
    const root = (await listLibrary(ctx, P('LIBRARY:/g1/d1')))!;
    expect(root.entries.map((e) => [e.kind, e.name])).toEqual(expect.arrayContaining([['dir', 'C'], ['file', 'ReadMe']]));
    expect(root.disk).toMatchObject({ diskId: 'd1', gameId: 'g1', filesystem: 'FFS', holder: null, sha256: sysSha });
    expect(root.writable).toBe(true);
    const c = (await listLibrary(ctx, P('LIBRARY:/g1/d1/c')))!;   // case-insensitive, as AmigaDOS
    expect(c.entries).toEqual([expect.objectContaining({ name: 'Assign', kind: 'file', size: 7, comment: 'cmd', protection: expect.any(String) })]);
    expect(c.crumbs.map((x) => x.label)).toEqual(['LIBRARY:', 'SysInfo', 'Disk 1', 'C']);
  });
  it('is read-only with the board named while a board holds the disk', async () => {
    await getDb().insert(devices).values({ id: 'dev1', orgId: 'o1', name: 'A500 bench', macAddress: 'AA:BB:CC:DD:EE:01', tokenHash: 'h1', desiredSha256: sysSha });
    const l = (await listLibrary(ctx, P('LIBRARY:/g1/d1')))!;
    expect(l.writable).toBe(false);
    expect(l.readOnlyReason).toMatch(/A500 bench/);
    expect(l.disk!.holder).toBe('A500 bench');
    await getDb().delete(devices);
  });
  it('is not found for another org, an unknown id, or a file path', async () => {
    expect(await listLibrary({ orgId: 'o2', userId: null }, P('LIBRARY:/g1'))).toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/nope'))).toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/g1/d2'))).toBeNull();          // d2 is not g1's
    expect(await listLibrary(ctx, P('LIBRARY:/g1/d1/ReadMe'))).toBeNull();
  });
});

describe('readLibraryFile', () => {
  it('returns bytes and meta, and null for a folder or another org', async () => {
    const f = (await readLibraryFile(ctx, P('LIBRARY:/g1/d1/C/Assign')))!;
    expect(new TextDecoder().decode(f.bytes)).toBe('assign!');
    expect(f.comment).toBe('cmd');
    expect(await readLibraryFile(ctx, P('LIBRARY:/g1/d1/C'))).toBeNull();
    expect(await readLibraryFile({ orgId: 'o2', userId: null }, P('LIBRARY:/g1/d1/ReadMe'))).toBeNull();
  });
});
```

(Before writing it, check `devices`' required columns and the `desiredSha256` column name in `src/db/schema/devices.ts`, and `findHolder`'s query, so the "held" seed matches what `findHolder` looks at; adjust the insert, not the assertion.)

- [ ] **Step 2: Run to verify it fails**

Run: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db src/lib/files/library.db.test.ts`
Expected: FAIL, "Cannot find module './library'".

- [ ] **Step 3: Implement `types.ts` (as in Interfaces) and `library.ts`**

```ts
// src/lib/files/library.ts
// LIBRARY: (spec 2026-10-29 §4.1): titles → disks → a disk's AmigaDOS folders. SERVER ONLY.
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, games } from '@/db/schema/catalog';
import { diskStore } from '@/lib/storage';
import { readVolume, readUsage, readFile, sameName, type AdfEntry } from '@/lib/adffs';
import { findHolder, mountedReason } from '@/lib/disk-holder';
import { isLocal } from '@/lib/remote-hidden';
import { formatPath, type FsPath } from './path';
import type { Crumb, DiskInfo, FsEntry, Listing } from './types';

export type FsCtx = { orgId: string; userId: string | null };
export type ResolvedDisk = { info: DiskInfo; bytes: Uint8Array; root: AdfEntry[]; rootBlock: number; intl: boolean };

const ROOT: Crumb = { label: 'LIBRARY:', path: 'LIBRARY:' };
const lib = (...segs: string[]) => formatPath({ device: 'LIBRARY', segments: segs });
const diskName = (d: { label: string | null; diskNo: number }) => d.label ?? `Disk ${d.diskNo}`;

export async function loadDisk(ctx: FsCtx, gameId: string, diskId: string): Promise<ResolvedDisk | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo, label: disks.label, sha256: disks.sha256,
      imageFormat: disks.imageFormat, title: games.title })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.orgId, disks.orgId), eq(entitlements.sha256, disks.sha256)))
    .innerJoin(games, eq(games.id, disks.gameId))
    .where(and(eq(disks.id, diskId), eq(disks.gameId, gameId), eq(disks.orgId, ctx.orgId), isLocal(disks)))
    .limit(1);
  if (!row) return null;
  const bytes = await diskStore.read(row.sha256);
  const vol = readVolume(bytes);
  const usage = vol.ok ? readUsage(bytes) : null;
  const holder = await findHolder(db, ctx.orgId, row.sha256);
  const info: DiskInfo = {
    diskId: row.id, gameId: row.gameId, title: row.title, label: diskName(row),
    filesystem: vol.ok ? vol.volume.filesystem : null, hd: bytes.length > 901_120,
    usedBytes: usage?.usedBytes ?? null, freeBytes: usage?.freeBytes ?? null, totalBytes: usage?.totalBytes ?? null,
    holder: holder?.name ?? null, imageFormat: row.imageFormat, volumeName: vol.ok ? vol.volume.name : null, sha256: row.sha256,
  };
  return { info, bytes, root: vol.ok ? vol.root : [], rootBlock: vol.ok ? vol.rootBlock : 0, intl: vol.ok ? vol.volume.intl : false };
}

export function resolveInDisk(d: ResolvedDisk, names: string[]) {
  let children = d.root; let dirBlock = d.rootBlock; let parentBlock = d.rootBlock; let entry: AdfEntry | null = null;
  for (const [i, n] of names.entries()) {
    const hit = children.find((c) => sameName(c.name, n, d.intl));
    if (!hit) return null;
    entry = hit; parentBlock = dirBlock;
    if (hit.kind === 'dir') { children = hit.children; dirBlock = hit.block; }
    else if (i !== names.length - 1) return null;
  }
  return { entry, parentBlock, dirBlock };
}

function toEntry(base: string[], e: AdfEntry): FsEntry {
  return { name: e.name, kind: e.kind, path: lib(...base, e.name), size: e.kind === 'file' ? e.sizeBytes : null,
    date: e.modifiedAt?.toISOString() ?? null, protection: e.protection, comment: e.comment, marks: [] };
}

export async function listLibrary(ctx: FsCtx, p: FsPath): Promise<Listing | null> {
  const db = getDb();
  const [gameId, diskId, ...names] = p.segments;
  if (!gameId) {
    const rows = await db.select({ id: games.id, title: games.title }).from(games)
      .where(and(eq(games.orgId, ctx.orgId), isLocal(games))).orderBy(asc(games.sortTitle), asc(games.id));
    return { path: 'LIBRARY:', crumbs: [ROOT], writable: false, readOnlyReason: null, disk: null,
      meta: `${rows.length} titles`,
      entries: rows.map((g) => ({ name: g.title, kind: 'title', path: lib(g.id), size: null, date: null, protection: null, comment: null, marks: [] })) };
  }
  const [game] = await db.select({ title: games.title }).from(games)
    .where(and(eq(games.id, gameId), eq(games.orgId, ctx.orgId), isLocal(games))).limit(1);
  if (!game) return null;
  const titleCrumb = { label: game.title, path: lib(gameId) };
  if (!diskId) {
    const rows = await db.select({ id: disks.id, diskNo: disks.diskNo, label: disks.label, sizeBytes: disks.sizeBytes, sha256: disks.sha256 })
      .from(disks).where(and(eq(disks.gameId, gameId), eq(disks.orgId, ctx.orgId), isLocal(disks))).orderBy(asc(disks.diskNo));
    const entries: FsEntry[] = [];
    for (const d of rows) {
      const holder = await findHolder(db, ctx.orgId, d.sha256);
      entries.push({ name: diskName(d), kind: 'disk', path: lib(gameId, d.id), size: d.sizeBytes, date: null, protection: null,
        comment: null, marks: holder ? [`in a drive of ${holder.name}`] : [] });
    }
    return { path: lib(gameId), crumbs: [ROOT, titleCrumb], entries, writable: false, readOnlyReason: null, disk: null,
      meta: `${rows.length} ${rows.length === 1 ? 'disk' : 'disks'}` };
  }
  const d = await loadDisk(ctx, gameId, diskId);
  if (!d) return null;
  const at = resolveInDisk(d, names);
  if (!at || (at.entry && at.entry.kind !== 'dir')) return null;
  const children = at.entry ? at.entry.children : d.root;
  const base = [gameId, diskId, ...(names.length ? names : [])];
  const readOnlyReason = d.info.holder ? mountedReason(d.info.holder)
    : d.info.imageFormat === 'hfe' ? 'hfe_read_only' : !d.info.filesystem ? 'no_filesystem' : null;
  const dirs = children.filter((c) => c.kind === 'dir').length;
  const crumbs: Crumb[] = [ROOT, titleCrumb, { label: d.info.label, path: lib(gameId, diskId) }];
  names.forEach((_, i) => crumbs.push({ label: resolveInDisk(d, names.slice(0, i + 1))!.entry!.name, path: lib(gameId, diskId, ...names.slice(0, i + 1)) }));
  return { path: formatPath(p), crumbs, entries: children.map((c) => toEntry(base, c)), writable: readOnlyReason === null,
    readOnlyReason, disk: d.info, meta: `${dirs} folders · ${children.length - dirs} files` };
}

export async function readLibraryFile(ctx: FsCtx, p: FsPath) {
  const [gameId, diskId, ...names] = p.segments;
  if (!gameId || !diskId || !names.length) return null;
  const d = await loadDisk(ctx, gameId, diskId);
  const at = d && resolveInDisk(d, names);
  if (!d || !at?.entry || at.entry.kind !== 'file') return null;
  const f = readFile(d.bytes, at.entry.block);
  if (!f) return null;
  return { name: at.entry.name, bytes: f.bytes, date: at.entry.modifiedAt, protection: at.entry.protection, comment: at.entry.comment };
}
```

Notes for the implementer: confirm `games` has a `remoteLibraryId` column (it does since migration 0050) so `isLocal(games)` type-checks; confirm `findHolder`'s signature `(db, orgId, sha256)`; the `hd` test (`> 901_120`) matches `geometryOf`'s HD size; prefer `geometryOf(bytes)?.blockCount === 3520` if exported.

- [ ] **Step 4: Run**

Run: `pnpm test:db src/lib/files/library.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/types.ts src/lib/files/library.ts src/lib/files/library.db.test.ts
git commit -m "Files: LIBRARY: driver lists titles, disks and a disk's folders, reads a file with its meta"
```

---

### Task 4: The ops engine (LIBRARY:)

**Files:**
- Create: `src/lib/files/ops.ts`
- Test: `src/lib/files/ops.db.test.ts` (same setup block as Task 3's test, its own database name `webadf_files_ops_test`)

**Interfaces:**
- Consumes: Task 1, Task 2 (`EntryMeta`, `BatchOp` with date/comment, `setComment`), Task 3 (`loadDisk`, `resolveInDisk`, `FsCtx`, types); `applyDiskEdit` (`src/lib/disk-write.ts`), `deleteEntry`, `renameEntry`, `setProtection`, `moveEntry`, `makeDirectory`, `applyBatch`, `blocksForPlan`, `readUsage`, `sameName`, `readFile` (adffs).
- Produces:
```ts
export type OpRequest =
  | { op: 'copy' | 'move'; sources: string[]; dest: string; onClash: 'ask' | 'replace' | 'skip' | 'keep-both' }
  | { op: 'delete'; sources: string[] }
  | { op: 'makedir'; dest: string; name: string }
  | { op: 'rename'; source: string; name: string }
  | { op: 'protect'; sources: string[]; protection: number }      // AmigaDOS bits, 0..0xff, as files/[block] PATCH takes
  | { op: 'comment'; source: string; comment: string };
export type OpItem = { source: string; ok: true } | { source: string; ok: false; refusal: Refusal };
export type OpResult =
  | { kind: 'done'; items: OpItem[] }
  | { kind: 'clashes'; clashes: { source: string; name: string; dest: string }[] }
  | { kind: 'refused'; refusal: Refusal; status: number };
export async function runOp(ctx: FsCtx, req: OpRequest): Promise<OpResult>
export function keepBothName(name: string, taken: (n: string) => boolean): string   // 'ReadMe' → 'ReadMe_1', 'a.txt' → 'a_1.txt', within 30 chars
```

Engine rules:
- Every path is parsed; a non-LIBRARY path in increment 1 → `refused { code: 'unsupported' }` 400.
- **Copy:** group sources by source disk; read each source (file → bytes+meta; dir → walk recursively into a list of `{ relPath, kind, bytes?, date, protection, comment }`). Destination must be a writable disk dir (`listLibrary`'s rules: holder/hfe/no fs → `refused read_only` 409 with the reason as detail). Check top-level clashes against the destination dir with `sameName(.., intl)`; `ask` + any clash → `clashes`; `skip` drops those sources; `keep-both` renames the top item with `keepBothName`; `replace` deletes the existing top-level entry in the same edit before adding. Same-disk copy of a dir into itself or below → `refused cycle` 400 (use `isWithin` with the volume's `sameName`). Names failing `amigaNameProblem` → that item refused `bad_name`, the others proceed. Capacity: `blocksForPlan(items, fs)` vs `readUsage(bytes).freeBlocks` (plus blocks freed by `replace`) → over → `refused disk_full` 400, detail `needs <N> KB, <M> KB free`, nothing written. Write: ONE `applyDiskEdit(orgId, destDiskId, edit, userId)` where `edit` = optional deletes (replace) then `applyBatch(ops)` with `parentPath` relative to the destination dir's path from the disk root (join the folder names). Map `applyDiskEdit` failures: 409 `mounted on …` → `mounted`; `conflict` → `conflict`; `hfe_read_only`; `disk-full` → `disk_full`; `name-exists` → `name_exists`; `name-too-long` → `bad_name`; `cycle` → `cycle`; `comment-too-long` → `comment_too_long`; `no-filesystem` → `no_filesystem`; 503 → `blob_unavailable`; anything else `failed`.
- **Move:** same disk → one `applyDiskEdit` composing `moveEntry` per top item (clash check as copy; `cycle` refused); different disks → copy (as above), then on success one `applyDiskEdit` on each source disk deleting the moved items. Source disk read-only → `refused read_only` before anything is written.
- **Delete / rename / protect / comment / makedir:** one `applyDiskEdit` on the one disk involved, composing `deleteEntry` (per source, deepest paths first), `renameEntry`, `setProtection(…, bits, 0xff)`, `setComment`, `makeDirectory`. Sources on different disks for delete/protect → one edit per disk, results per item.
- Compose several write functions into one edit with a local helper:
```ts
const chain = (...steps: ((adf: Uint8Array) => WriteResult)[]) => (adf: Uint8Array): WriteResult => {
  let cur = adf;
  for (const s of steps) { const r = s(cur); if (!r.ok) return r; cur = r.adf; }
  return { ok: true, adf: cur };
};
```
  Blocks change after each step only for new allocations; deletes/renames/moves keep the entry's own header block, so resolving blocks once from the loaded disk is safe for those. For copy-with-replace, resolve the parent directory again inside the edit by path (use `applyBatch`'s `parentPath`, which resolves by name).

- [ ] **Step 1: Write the failing DB test** — seed as Task 3 (disk `d1` "SysInfo" FFS with `C/Assign` (comment `cmd`, a fixed date), `ReadMe`, `S/`; disk `d2` "Turrican" OFS empty; disk `d3` "Full" nearly full: format OFS and add one file of `freeBytes - 1024` bytes; disk `d4` intl FFS (`formatVolume({ filesystem: 'FFS', volumeName: 'Intl', intl: true })`) holding `Grüße`). Helper `versions(diskId)` counts rows in the disk-history table for that disk (find its table in `src/db/schema/disk-history.ts`) and `sha(diskId)` reads `disks.sha256`.

```ts
describe('copy', () => {
  it('copies a file and a folder between disks in one version, keeping date, protection and comment', async () => {
    const before = await versions('d2');
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C', 'LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect(r).toEqual({ kind: 'done', items: [{ source: 'LIBRARY:/g1/d1/C', ok: true }, { source: 'LIBRARY:/g1/d1/ReadMe', ok: true }] });
    expect(await versions('d2')).toBe(before + 1);
    const a = (await readLibraryFile(ctx, P('LIBRARY:/g2/d2/C/Assign')))!;
    const src = (await readLibraryFile(ctx, P('LIBRARY:/g1/d1/C/Assign')))!;
    expect(a.bytes).toEqual(src.bytes);
    expect([a.comment, a.protection, a.date?.toISOString()]).toEqual([src.comment, src.protection, src.date?.toISOString()]);
  });
  it('asks on a clash and writes nothing', async () => {
    const s = await sha('d2');
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect(r).toEqual({ kind: 'clashes', clashes: [{ source: 'LIBRARY:/g1/d1/ReadMe', name: 'ReadMe', dest: 'LIBRARY:/g2/d2' }] });
    expect(await sha('d2')).toBe(s);
  });
  it('clash is case-insensitive', async () => {
    await runOp(ctx, { op: 'rename', source: 'LIBRARY:/g2/d2/ReadMe', name: 'readme' });
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect(r.kind).toBe('clashes');
  });
  it('keep-both adds ReadMe_1; skip writes nothing; replace overwrites', async () => {
    expect((await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'keep-both' })).kind).toBe('done');
    expect(await readLibraryFile(ctx, P('LIBRARY:/g2/d2/ReadMe_1'))).not.toBeNull();
    const s = await sha('d2');
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'skip' });
    expect(await sha('d2')).toBe(s);
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'replace' });
    expect(new TextDecoder().decode((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/ReadMe')))!.bytes)).toBe('hello');
  });
  it('disk full refuses the whole copy', async () => {
    const s = await sha('d3');
    const r = await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C', 'LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g3/d3', onClash: 'ask' });
    expect(r).toMatchObject({ kind: 'refused', status: 400, refusal: { code: 'disk_full', detail: expect.stringMatching(/needs \d+ KB, \d+ KB free/) } });
    expect(await sha('d3')).toBe(s);
  });
  it('refuses a folder into its own subtree', async () => {
    const s = await sha('d1');
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/C'], dest: 'LIBRARY:/g1/d1/C', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
    expect(await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g1/d1/C'], dest: 'LIBRARY:/g1/d1/c', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', refusal: { code: 'cycle' } });
    expect(await sha('d1')).toBe(s);
  });
  it('copies an international name', async () => {
    await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g4/d4/Grüße'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/Grüße')))?.name).toBe('Grüße');
  });
  it('copies out of a held disk but refuses copying into it', async () => {
    await holdDisk('d1', 'A500 bench');
    expect((await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g1/d1/S'], dest: 'LIBRARY:/g2/d2', onClash: 'replace' })).kind).toBe('done');
    expect(await runOp(ctx, { op: 'copy', sources: ['LIBRARY:/g2/d2/ReadMe'], dest: 'LIBRARY:/g1/d1', onClash: 'replace' }))
      .toMatchObject({ kind: 'refused', status: 409, refusal: { code: 'read_only', detail: expect.stringMatching(/A500 bench/) } });
    await releaseDisk();
  });
  it("another org's paths are not found", async () => {
    expect(await runOp({ orgId: 'o2', userId: null }, { op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g2/d2', onClash: 'ask' }))
      .toMatchObject({ kind: 'refused', status: 404, refusal: { code: 'not_found' } });
  });
});

describe('move, delete, makedir, rename, protect, comment', () => {
  it('moves between disks: one new version on each', async () => {
    const [a, b] = [await versions('d1'), await versions('d2')];
    await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/g2/d2', name: 'Box' });
    const [a1, b1] = [await versions('d1'), await versions('d2')];
    expect([a1, b1]).toEqual([a, b + 1]);
    expect((await runOp(ctx, { op: 'move', sources: ['LIBRARY:/g2/d2/Box'], dest: 'LIBRARY:/g1/d1', onClash: 'ask' })).kind).toBe('done');
    expect([await versions('d1'), await versions('d2')]).toEqual([a1 + 1, b1 + 1]);
    expect(await listLibrary(ctx, P('LIBRARY:/g1/d1/Box'))).not.toBeNull();
    expect(await listLibrary(ctx, P('LIBRARY:/g2/d2/Box'))).toBeNull();
  });
  it('deletes several items in one version', async () => {
    const v = await versions('d2');
    await runOp(ctx, { op: 'delete', sources: ['LIBRARY:/g2/d2/ReadMe', 'LIBRARY:/g2/d2/ReadMe_1'] });
    expect(await versions('d2')).toBe(v + 1);
    expect(await readLibraryFile(ctx, P('LIBRARY:/g2/d2/ReadMe'))).toBeNull();
  });
  it('refuses a bad name and a long comment', async () => {
    expect(await runOp(ctx, { op: 'makedir', dest: 'LIBRARY:/g2/d2', name: 'a:b' })).toMatchObject({ kind: 'refused', refusal: { code: 'bad_name' } });
    expect(await runOp(ctx, { op: 'comment', source: 'LIBRARY:/g2/d2/C', comment: 'x'.repeat(80) })).toMatchObject({ kind: 'refused', refusal: { code: 'comment_too_long' } });
  });
  it('sets protection on two files and a comment on one', async () => {
    await runOp(ctx, { op: 'protect', sources: ['LIBRARY:/g2/d2/C/Assign', 'LIBRARY:/g2/d2/Grüße'], protection: 0b0101 });
    const l = (await listLibrary(ctx, P('LIBRARY:/g2/d2/C')))!;
    expect(l.entries[0].protection).toBe((await listLibrary(ctx, P('LIBRARY:/g2/d2')))!.entries.find((e) => e.name === 'Grüße')!.protection);
    await runOp(ctx, { op: 'comment', source: 'LIBRARY:/g2/d2/C/Assign', comment: 'hello' });
    expect((await readLibraryFile(ctx, P('LIBRARY:/g2/d2/C/Assign')))!.comment).toBe('hello');
  });
});

describe('keepBothName', () => {
  it('numbers before the extension and stays within 30 characters', () => {
    const taken = new Set(['readme', 'readme_1', 'a.txt']);
    const t = (n: string) => taken.has(n.toLowerCase());
    expect(keepBothName('ReadMe', t)).toBe('ReadMe_2');
    expect(keepBothName('a.txt', t)).toBe('a_1.txt');
    expect(keepBothName('x'.repeat(30), () => false).length).toBeLessThanOrEqual(30);
  });
});
```

(`holdDisk`/`releaseDisk` insert/delete a `devices` row whose desired sha is the disk's current sha — read it first, since earlier tests changed it.)

- [ ] **Step 2: Run to verify it fails** — `pnpm test:db src/lib/files/ops.db.test.ts` → FAIL, module not found.
- [ ] **Step 3: Implement `src/lib/files/ops.ts`** following the Engine rules above. Keep each op in its own function (`copyOrMove`, `deleteMany`, `renameOne`, `protectMany`, `commentOne`, `makeDir`) and the failure mapping in one `fromEdit(outcome)` function. `keepBothName` splits at the last `.` when it is not the first character, appends `_<n>` to the stem from 1 upward until `taken` is false, and trims the stem so the result is ≤ 30 characters.
- [ ] **Step 4: Run** — `pnpm test:db src/lib/files/ops.db.test.ts` → PASS; also `pnpm test:db src/lib/files` and `pnpm vitest run src/lib/adffs`.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/ops.ts src/lib/files/ops.db.test.ts
git commit -m "Files: ops engine for LIBRARY: -- copy/move/delete/makedir/rename/protect/comment, one version per disk"
```

---

### Task 5: The API routes

**Files:**
- Create: `src/app/api/files/list/route.ts`, `src/app/api/files/ops/route.ts`, `src/app/api/files/download/route.ts`
- Test: `src/app/api/files/files-api.db.test.ts` (mock `requireOrg` the way `src/app/api/remote/remote-api.db.test.ts` does)

**Interfaces:**
- Consumes: Task 1 `parsePath`; Task 3 `listLibrary`, `readLibraryFile`; Task 4 `runOp`, `OpRequest`.
- Produces:
  - `GET /api/files/list?path=` → 200 `Listing` | 400 `{ error: 'bad_path' }` | 404 `{ error: 'not_found' }`
  - `POST /api/files/ops` body = `OpRequest` (zod) → 200 `{ items }` | 409 `{ error: 'clashes', clashes }` | `<status>` `{ error: <refusal.code>, detail? }` | 400 `{ error: 'invalid_body' }`
  - `GET /api/files/download?path=` → the file bytes, `Content-Disposition: attachment; filename*=UTF-8''<name>`, `Content-Type: application/octet-stream` | 404

- [ ] **Step 1: Write the failing test** — seed like Task 3; then:

```ts
it('lists, refuses a bad path, and 404s a foreign one', async () => {
  expect((await GET_LIST(req('/api/files/list?path=LIBRARY:/g1'))).status).toBe(200);
  expect((await GET_LIST(req('/api/files/list?path=nope'))).status).toBe(400);
  asOrg('o2');
  expect((await GET_LIST(req('/api/files/list?path=LIBRARY:/g1'))).status).toBe(404);
});
it('ops: clashes are 409 with the list; a refusal carries its code; a body that is not an op is 400', async () => {
  const clash = await POST_OPS(json({ op: 'copy', sources: ['LIBRARY:/g1/d1/ReadMe'], dest: 'LIBRARY:/g1/d1', onClash: 'ask' }));
  expect(clash.status).toBe(409);
  expect((await clash.json()).error).toBe('clashes');
  expect((await POST_OPS(json({ op: 'makedir', dest: 'LIBRARY:/g1/d1', name: 'a/b' }))).status).toBe(400);
  expect((await POST_OPS(json({ op: 'explode' }))).status).toBe(400);
});
it('conflict maps to 409 conflict', async () => {
  vi.spyOn(diskWrite, 'applyDiskEdit').mockResolvedValueOnce({ ok: false, status: 409, reason: 'conflict' });
  const r = await POST_OPS(json({ op: 'makedir', dest: 'LIBRARY:/g1/d1', name: 'New' }));
  expect([r.status, (await r.json()).error]).toEqual([409, 'conflict']);
});
it('downloads one file with its name', async () => {
  const r = await GET_DL(req('/api/files/download?path=' + encodeURIComponent('LIBRARY:/g1/d1/ReadMe')));
  expect(r.status).toBe(200);
  expect(r.headers.get('content-disposition')).toContain("filename*=UTF-8''ReadMe");
  expect(new TextDecoder().decode(await r.arrayBuffer())).toBe('hello');
});
```

(`diskWrite` is `import * as diskWrite from '@/lib/disk-write'`; for the spy to take effect `ops.ts` must call it through the module namespace or the test mocks the module with `vi.mock` — choose `vi.mock('@/lib/disk-write', async (orig) => ({ ...(await orig()), applyDiskEdit: vi.fn((...a) => (orig as any).applyDiskEdit(...a)) }))` and override once.)

- [ ] **Step 2: Run to verify it fails** — `pnpm test:db src/app/api/files/files-api.db.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three routes. Each starts `const { orgId, userId } = await requireOrg();`. `ops` validates with a zod discriminated union mirroring `OpRequest` (`sources` 1..1000 strings, `name` 1..64, `comment` max 200 (the engine applies the 79 rule), `protection` int 0..255), calls `runOp`, then: `done` → 200 `{ items }`; `clashes` → 409 `{ error: 'clashes', clashes }`; `refused` → `Response.json({ error: refusal.code, detail: refusal.detail }, { status })`. `download` uses `readLibraryFile`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/app/api/files
git commit -m "Files: /api/files/list, /ops and /download"
```

---

### Task 6: Sort, selection, keys, words (pure client logic) and the sort pref

**Files:**
- Create: `src/lib/files/sort.ts`, `selection.ts`, `keys.ts`, `words.ts` (+ a `.test.ts` each)
- Modify: `src/lib/user-prefs-schema.ts` (+ its test file): `files: { sort: { library: FilesSort; stash: FilesSort; net: FilesSort } }`

**Interfaces:**
- Produces:
  - `type FilesSortKey = 'name' | 'size' | 'protection' | 'date'`; `type FilesSort = { key: FilesSortKey; dir: 'asc' | 'desc' }`
  - `sortFsEntries(entries: FsEntry[], sort: FilesSort): FsEntry[]` — folders (`dir`, `title`, `disk`) first always; names compare case-insensitively with `localeCompare(…, { sensitivity: 'base', numeric: true })`; ties break by name asc.
  - `nextSort(cur: FilesSort, key: FilesSortKey): FilesSort` — same key flips dir; new key starts `asc` (`date` and `size` start `desc`).
  - `type Selection = { anchor: number | null; cursor: number; picked: ReadonlySet<number> }`; `selectClick(s, index, mods: { shift: boolean; toggle: boolean }): Selection`; `moveCursor(s, delta, count, extend: boolean): Selection`; `togglePick(s, index): Selection`; `EMPTY_SELECTION`.
  - `type FilesCommand = 'up' | 'down' | 'pick' | 'open' | 'parent' | 'switch' | 'copy' | 'move' | 'makedir' | 'rename' | 'delete'`; `commandFor(e: { key: string; target: { tagName?: string; isContentEditable?: boolean } | null; dialogOpen: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): FilesCommand | null` (ArrowUp/Down, Space, Enter, Backspace, Tab, F5, F6, F7, F2, Delete; null for INPUT/TEXTAREA/SELECT/contentEditable targets, an open dialog, or any of Alt/Ctrl/Meta).
  - `refusalWords(code: RefusalCode, detail?: string): string`, e.g. `disk_full` → `"Not enough room on the disk — " + detail`, `read_only` → `"This disk is in a drive (" + detail + "). Eject it to change it."`, `conflict` → `"The disk changed — the pane has been refreshed."`, `cycle` → `"A folder cannot go inside itself."`, `bad_name` → `"AmigaDOS names are at most 30 characters, without : or /."`, `name_exists`, `comment_too_long` ("Comments are at most 79 characters."), `not_found`, `hfe_read_only` ("HFE disks are read-only."), `no_filesystem` ("This disk has no AmigaDOS filesystem."), `unsupported`, `blob_unavailable`, `failed`.
  - Prefs: `DEFAULT_PREFS.files = { sort: { library: { key: 'name', dir: 'asc' }, stash: { key: 'date', dir: 'desc' }, net: { key: 'date', dir: 'desc' } } }`; `prefsPatchSchema` accepts `files: { sort: { library?, stash?, net? } }` strictly; `parsePrefs` fills missing `files` from defaults (stored prefs from before this change have none).

- [ ] **Step 1: Write the failing tests** — one file each, covering: folders-first under every key and direction; numeric-aware names (`Disk 2` < `Disk 10`); `nextSort` flip and start directions; shift-range from anchor, toggle keeps others, plain click resets; cursor clamps at 0 and count-1 and extends with shift; `commandFor` for every key, null inside an `INPUT`, null with `dialogOpen`, null with `ctrlKey`; every `RefusalCode` has non-empty words; prefs: defaults present, a patch setting `files.sort.library` round-trips, an unknown key under `files` is refused, an old stored prefs object without `files` parses with the defaults.
- [ ] **Step 2: Run** `pnpm vitest run src/lib/files src/lib/user-prefs-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the four modules and the prefs extension (client-safe: these files import only types from `./types` and `./path`; check `src/lib/client-bundle-boundary.test.ts` still passes).
- [ ] **Step 4: Run** → PASS, plus `pnpm vitest run src/lib/client-bundle-boundary.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/sort.ts src/lib/files/sort.test.ts src/lib/files/selection.ts src/lib/files/selection.test.ts \
  src/lib/files/keys.ts src/lib/files/keys.test.ts src/lib/files/words.ts src/lib/files/words.test.ts \
  src/lib/user-prefs-schema.ts src/lib/user-prefs-schema.test.ts
git commit -m "Files: sort (folders first, asc/desc), selection, keys, refusal words; per-device sort prefs"
```

---

### Task 7: The pane

**Files:**
- Create: `src/components/files/pane.tsx`
- Test: `src/components/files/pane.test.ts` (render with `renderToStaticMarkup`, as `src/components/admin/admin-nav.test.ts` does)

**Interfaces:**
- Consumes: Task 3 types; Task 6 `sortFsEntries`, `FilesSort`, `Selection`.
- Produces:
```ts
export type PaneProps = {
  side: 'left' | 'right'; active: boolean; listing: Listing | null; loading: boolean; error: string | null;
  sort: FilesSort; selection: Selection; showComment: boolean;
  onActivate(): void; onNavigate(path: string): void; onSort(key: FilesSortKey): void;
  onRowClick(index: number, mods: { shift: boolean; toggle: boolean }): void; onRowOpen(index: number): void;
  onDragStartRows(indexes: number[], e: React.DragEvent): void; onDropRows(e: React.DragEvent): void;
  strip?: React.ReactNode;   // the disk strip (Task 9) when listing.disk
};
export function Pane(p: PaneProps): JSX.Element
```

Markup contract (tests and e2e rely on these):
- Root `<section data-testid="pane-<side>" data-active="true|false" aria-label="<Left|Right> pane">`.
- Device buttons: `data-testid="pane-<side>-dev-LIBRARY"` (only LIBRARY: in increment 1, R1), `aria-pressed`.
- Crumbs: `<nav aria-label="Path">` with a button per crumb, `data-testid="pane-<side>-crumb-<i>"`; an ↑ button `data-testid="pane-<side>-up"` disabled at the root.
- Meta line `data-testid="pane-<side>-meta"`; read-only line `data-testid="pane-<side>-readonly"` when `!listing.writable && listing.readOnlyReason`.
- A real `<table>` with `<th>` buttons Name/Size/Protection/Date(/Comment) carrying `aria-sort="ascending|descending|none"` and `data-testid="pane-<side>-sort-<key>"`; ▲/▼ glyph after the active key, `aria-hidden`.
- Rows `<tr data-testid="pane-row" data-name="<name>" data-kind="<kind>" aria-selected>`; protection rendered as the eight `h s p a r w e d` cells the Browse table uses (reuse its cell component from `file-tree.tsx` if it is exported; otherwise extract it to `src/components/disks/protection-cells.tsx` and use it in both).
- Foot `data-testid="pane-<side>-foot"`: `"<n> of <m> selected · <size>"` or `listing.meta`.
- Look: follow the mock-up (`.superpowers/brainstorm/16846-1793227722/content/files-page-layout.html` variant A): `--surface` card, tinted header `#FFF7EA` when active, `var(--sel)` = `--warning-bg` for selected rows, Geist Mono sizes/dates, tags DIR/TXT/EXE as small chips. Use existing tokens; no new colours.

- [ ] **Step 1: Write the failing test** — render a `Pane` with a listing of one dir and two files and assert: the root testid and `data-active`; dir row first; `aria-sort="ascending"` on Name; the ▲ glyph; `aria-selected="true"` on picked rows; the read-only line when `writable:false`; the ↑ button disabled at `LIBRARY:`; only the LIBRARY: device button.
- [ ] **Step 2: Run** `pnpm vitest run src/components/files/pane.test.ts` → FAIL.
- [ ] **Step 3: Implement** the component (client component, `'use client'`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/components/files/pane.tsx src/components/files/pane.test.ts [protection-cells if extracted]` → `"Files: the pane (crumbs, sortable headers, protection cells, selection)"`.

---

### Task 8: The Files page and the manager (button column, dialogs, keys, drag)

**Files:**
- Create: `src/app/(app)/files/page.tsx`, `src/app/(app)/files/loading.tsx`, `src/components/files/files-manager.tsx`, `src/components/files/dialogs.tsx`
- Test: `src/app/(app)/files/loading.test.ts`; behaviour is covered by e2e in Task 11.

**Interfaces:**
- Consumes: Tasks 3–7.
- Produces: `FilesManager({ initial: { left: Listing | null; right: Listing | null; leftPath: string; rightPath: string; active: 'left' | 'right' }, prefs: { sort: UserPrefs['files']['sort'] } })`.

Behaviour:
- `page.tsx`: `requireOrg`, `getUserPrefs`, read `searchParams` `left`/`right`/`active` (defaults `LIBRARY:` / `LIBRARY:` / `left`; an unparsable path → the default), call `listLibrary` for both server-side (null → the pane shows "This place no longer exists" with a button to `LIBRARY:`), render `PageHeader` (eyebrow "Move files", title "Files", size lg) and `<FilesManager>`. `metadata = { title: 'Files' }`.
- Navigation fetches `/api/files/list?path=` and `router.replace`s the URL (`?left&right&active`), so Back/reload restore both panes (use `history.replaceState` for selection-only changes; `router.push` when a pane navigates).
- Button column (`data-testid="files-actions"`, a vertical `.seg`-free stack of `Button` `variant="outline" size="sm"`; Copy → `variant="default"` when the active pane has a selection): Copy → / Move → act from the active pane to the other (labels flip to ← Copy / ← Move when the right pane is active — keep one Copy and one Move button whose arrow follows the active pane, plus "← Copy" from the mock-up becomes that flip), Delete, Rename (one item), Makedir, Protect, Info (one item), Download (R4), Swap ⇄ (swaps the two paths). Each disabled with a `title` reason: "Select something first", "Open a disk on the other side", "This disk is in a drive…", etc.
- Running an op: `POST /api/files/ops`; 409 `clashes` → the Clash dialog (Replace / Skip / Keep both, checkbox "Do this for all", Cancel) → resend with the choice; any refusal → toast with `refusalWords`; on `conflict` also re-fetch both panes; on done → toast ("Copied 3 items to Disk 1 — saved as version 4" when the target pane shows a disk; get the version by re-fetching) and re-fetch both panes, clearing the source selection.
- Dialogs (`dialogs.tsx`, all on `Modal`): `ClashDialog`, `ConfirmDeleteDialog` ("Delete 3 items from SysInfo · Disk 1? A new version keeps the old ones."), `NameDialog` (Makedir/Rename, validates with `amigaNameProblem` live), `ProtectDialog` (the eight bit toggles, prefilled from the first selected entry; for a mixed selection a tri-state), `InfoDialog` (name, size, date, protection, editable comment with a 79-character counter, Save → `comment` op). Test ids: `files-clash-dialog`, `files-delete-dialog`, `files-name-dialog`, `files-protect-dialog`, `files-info-dialog`.
- Keys: a `keydown` listener on the manager root uses `commandFor`; Tab switches active pane and is `preventDefault`ed only when the event target is inside the manager.
- Drag: rows are `draggable`; drop on the other pane = Copy, with Shift = Move; drop on a dir row = into that dir. Drop from the computer: R5.
- Sort: header click → `nextSort` → local state + `savePrefs({ files: { sort: { library: next } } })` via `latestSaver()`.
- `loading.tsx`: the page grid with two pane bones and the action column (status wrapper as `settings/loading.tsx`); test asserts `role="status"` and two `data-skeleton-pane`.

- [ ] **Step 1: Write the failing loading test**; **Step 2:** run → FAIL; **Step 3:** implement page, loading, manager, dialogs; **Step 4:** `pnpm vitest run "src/app/(app)/files" src/components/files && pnpm tsc --noEmit -p .` → PASS / no errors; **Step 5:** commit `"Files: the page -- two panes, button column, dialogs, keys, drag, URL state"`.

---

### Task 9: Disk strip, "Files…", the Browse redirect, computer drops

**Files:**
- Create: `src/components/files/disk-strip.tsx`
- Modify: `src/components/games/disk-row.tsx` (~176-180), `src/app/(app)/disks/[id]/files/page.tsx`, `src/components/files/files-manager.tsx`, `src/lib/help/topics.tsx` (any sentence that says "Browse" for the disk file view now says "Files…"; the full Files help topic is increment 4)
- Test: `src/components/files/disk-strip.test.ts`, `src/app/(app)/disks/[id]/files/redirect.test.ts`

**Interfaces:**
- Consumes: Task 3 `DiskInfo`; existing `MountAction` (`src/components/games/mount-action.tsx`, needs `MountChoice[]` from `mountChoices`), `HistoryPanel`, `loadHistory`; `/api/disks/<id>/adf`; `/api/disks/<id>/volume-name`.
- Produces: `DiskStrip({ disk, choices, history, onChanged })` and a server helper `diskStripData(orgId, diskId): Promise<{ choices: MountChoice[]; history: HistoryVersion[] }>` in `src/lib/files/disk-strip-data.ts` called by the Files page for each pane that is inside a disk (and by a small `GET /api/files/disk-strip?diskId=` used after client-side navigation).

Behaviour:
- Strip (`data-testid="disk-strip-<side>"`): disk icon in the title's colour, name, a drive chip ("Not in a drive" / "In DF0: of A500 bench", `data-testid="disk-strip-drive"`), used/free bar ("857 of 880 KB · 23 KB free"), `MountAction` or, when held, **Eject to edit** (the same eject call MountAction's menu uses), **History · v<N>** toggling a side panel that renders `HistoryPanel` over the pane (`data-testid="disk-strip-history"`), **⬇ ADF** (`/api/disks/<id>/adf`), and the volume name with an edit pencil (PATCH `/api/disks/<id>/volume-name`; refused while held).
- `disk-row.tsx`: the `Browse` link becomes `Files…` → `/files?left=LIBRARY:&right=${encodeURIComponent(`LIBRARY:/${gameId}/${diskId}`)}&active=right`, `data-testid={`files-${disk.id}`}`. Keep `browse-${id}` off the DOM (old selector must not match a new element).
- `/disks/[id]/files/page.tsx`: at the top, if `searchParams.version` is absent → `redirect('/files?left=LIBRARY:&right=' + encodeURIComponent(path) + '&active=right')` after resolving the disk's `gameId` (unknown disk → `notFound()` as today). With `?version=` the page renders as today (R3).
- Computer drops (R5): in `files-manager.tsx`, a drop of OS files on a pane whose listing is a writable disk directory runs the existing `stageDrop` flow and posts to `/api/disks/<id>/files/batch` with `parentPath` = the pane's folder names joined by `/`; otherwise a toast "Open a disk to drop files into it".

- [ ] **Step 1: Write failing tests** — strip renders the drive chip for held and free disks, Eject only when held, ⬇ ADF href; redirect test calls the page module with no `version` and expects `redirect` to have been called with the `/files?...` URL (mock `next/navigation`), and with `version=2` expects no redirect.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `pnpm vitest run src/components/files "src/app/(app)/disks" && pnpm tsc --noEmit -p .` → PASS. Then grep the e2e specs for `browse-` test ids and `/disks/.*/files` URLs and update each to the new link/redirect (they are part of this task: `rg -n "browse-|/files\b" e2e`).
- [ ] **Step 5: Commit** `"Files: disk strip (drive, mount/eject, history, ADF, volume name); Files… replaces Browse; Browse redirects"`.

---

### Task 10: Phone

**Files:**
- Create: `src/components/files/copy-to-picker.tsx`
- Modify: `src/components/files/files-manager.tsx`, `src/components/files/pane.tsx`

Behaviour (below `lg`, the C7 breakpoint convention):
- One pane visible; a `Left | Right` `.seg` switcher (`data-testid="files-side-switch"`) at the top; the button column becomes a bottom bar (`data-testid="files-actions"` still) with Copy to… · Move to… · Delete · More ▾ (Rename, Makedir, Protect, Info, Download).
- **Copy to… / Move to…** open `CopyToPicker` (`data-testid="files-copy-to"`), a `Modal` listing the other pane's current location with crumbs and folders to drill into, "Copy here" / "Move here". It uses `/api/files/list`.
- Rows are ≥ 44 px tall; no horizontal page scroll at 390 px (Size/Date columns collapse into a second line under the name).

- [ ] **Step 1:** add to `e2e/files.mobile.spec.ts` (Task 11 owns the file; write this test now): at 390×844, Files… from a disk shows one pane, the switcher, the bottom bar; Copy to… picker copies a file into the other pane's disk; `noSideways(page)` (copy the helper from `e2e/c7-phone.mobile.spec.ts`). **Step 2:** run it → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit `"Files: phone -- one pane, side switch, bottom bar, Copy to… picker"`.

---

### Task 11: End-to-end and contrast

**Files:**
- Create: `e2e/files.spec.ts` (desktop), complete `e2e/files.mobile.spec.ts`
- Modify: `e2e/contrast.spec.ts`

Seed helper (top of `e2e/files.spec.ts`): reuse the pattern of `seedAdf`/`adfWithFiles` from `e2e/sharing.spec.ts` (format FFS, add `ReadMe`, dir `S`, `C/Assign`), `diskStore.put`, `seedDisk` from `e2e/device-helpers.ts`; `test.afterAll(cleanupSeeded)`.

Tests (desktop):
1. `Files… on a disk opens LIBRARY: | the disk root` — from the title page, click `files-<diskId>`; URL `/files?left=LIBRARY:&right=…&active=right`; right pane rows include `ReadMe`, `S`; disk strip shows "Not in a drive".
2. `copy a file between disks makes one version` — two seeded titles; left pane navigates into disk B; select `ReadMe` on the right (disk A); Copy →; toast; left pane shows `ReadMe`; disk B's History shows `v1`.
3. `clash asks; Keep both adds ReadMe_1`.
4. `move a folder between disks` (Shift-drag between panes) → gone from the source, present at the destination.
5. `delete asks first` — Delete key → dialog → Delete → row gone.
6. `sort headers flip asc/desc and are remembered` — click Size twice → `aria-sort="descending"`; reload → still descending.
7. `Protect two files` — select two, Protect, clear `d`, Save → both rows' `d` cell off.
8. `keyboard: arrows, Space, F5, Tab, Enter, Backspace`.
9. `a disk in a drive is read-only` — seed a board holding disk A (`pairDevice` + set desired sha like `e2e/sharing.spec.ts` `boardHolds`): read-only line names the board; Copy → into it disabled with the reason; copying out still works.
10. `/disks/<id>/files redirects to Files; ?version=1 still shows the old page`.
11. `Info edits a comment` → reopen Info shows it.

Contrast (`e2e/contrast.spec.ts`): add a `Files` block at 1280×900: active/inactive pane header text, a selected row's text, the action buttons (enabled/disabled), sort header (current), the disk strip drive chip, the read-only line.

- [ ] **Step 1:** write the specs. **Step 2:** run `PORT=3100 bash scripts/e2e-local.sh e2e/files.spec.ts --project=desktop` → expect the new tests to pass (the features exist from Tasks 7–10; any failure is a defect to fix in the owning task's code, not by weakening the test). **Step 3:** run `PORT=3100 bash scripts/e2e-local.sh e2e/files.mobile.spec.ts --project=mobile` and `… e2e/contrast.spec.ts --project=desktop -g "Files"`. **Step 4:** run the specs touched by the Browse change (`rg -l "browse-|/disks/.*/files" e2e` from Task 9) in batches under 9 minutes. **Step 5:** commit `"Files: e2e (desktop, phone) and contrast"`.

---

## After the last task

- Full unit (`pnpm vitest run`), DB (`pnpm test:db`), `pnpm build`, lint on changed files.
- HANDOFF §4: mark increment 1 shipped with the merge hash; increments 2–4 remain.
- Help: increment 4 writes the Files topics; increment 1 only updated wording that named Browse.
