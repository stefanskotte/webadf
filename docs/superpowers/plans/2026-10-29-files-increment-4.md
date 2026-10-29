# Files, increment 4 (Files settings, help, polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user Files settings in Settings › Account (panes on opening, Show .info files, Comment column, Ask before deleting, name-clash answer) applied by the Files page; the file-name filter back in every pane; the "dropped" mark on STASH: rows; the Files and STASH:/NET: help topics with a "?" on each pane; the cheap user-visible minors the three ledgers deferred; and the whole-feature e2e sweep before the one merge.

**Architecture:** The settings are five new fields under `files` in the existing per-user prefs document (`src/lib/user-prefs-schema.ts`: tolerant read, strict patch), plus the existing `browse.hideInfo`, which Files now shares with the Browse page. One new client-safe module, `src/lib/files/view.ts`, holds every pure rule the settings and the filter need (which rows a pane draws, the foot words, whether Delete asks, whether the Comment column shows, the panes `/files` opens with); the Pane and the manager both draw rows through its `paneRows`, so a row index means the same entry in both. A new Settings card reuses the Preferences form's save logic, extracted into a hook. Help is two new entries in `src/lib/help/topics.tsx` and a `HelpTip` per pane header.

**Tech Stack:** Next.js 16 App Router (searchParams are Promises; read `node_modules/next/dist/docs/` before touching a page), React 19, zod 4, drizzle (Postgres), vitest (unit `pnpm vitest run`, DB `pnpm test:db` with `TEST_DATABASE_URL` from `bash scripts/dev-db.sh start`), Playwright (`PORT=3100 bash scripts/e2e-local.sh <specs> --project=desktop|mobile`).

**Spec:** `docs/superpowers/specs/2026-10-29-files-manager-design.md` (increment 4 = §9 item 4; §6 Files settings, §7 Help, §5.4 phone). Base: increments 1–3 on branch `feat/files` (plans `2026-10-29-files-increment-{1,2,3}.md`, ledgers `.superpowers/sdd/2026-10-29-files-increment-{1,2,3}/progress.md`). **Start only after increment 3's Tasks 7 and 8 are committed** (at the time of writing they are in progress, with uncommitted edits in `e2e/`).

## Global Constraints

- Settings are **per user**, stored in `user_prefs.prefs` through `parsePrefs` (tolerant: a missing or invalid field reads its own default, the rest are kept) and `parsePrefsPatch` (strict: unknown key or bad value refuses the whole patch). Old rows without the new keys read the defaults. No migration.
- Every new default is **today's behaviour**: left pane STASH:, right pane LIBRARY:, .info files shown, Comment column on STASH: only, Delete asks, a name clash asks (spec §6 lists the same defaults).
- Sort orders stay remembered per device automatically; no setting (spec §6).
- A row index is an index into `paneRows(entries, sort, view)` — in `pane.tsx` and in `files-manager.tsx` alike. No other row order may exist.
- An operation acts only on rows that are **drawn**: a picked row the filter or Show .info hides is dropped from the selection before any button can act on it.
- One operation = one new history version per disk it touches; copies keep date, protection and comment; a foreign or unknown id is 404 (spec §4.1, §8 — unchanged here, never weakened by a setting).
- Help text in `src/lib/help/topics.tsx` changes with the behaviour it describes; every body stays within the test's 60–280 words; no topic names the retired Upload page or Staging list.
- Existing colour tokens only (`--ink`, `--surface`, `--muted`, `--muted-2`, `--line`, `--line-strong`, `--track`, `--viewing-bg`, `--accent-blue`, `--warning-fg`, …); no new hex values.
- Self-host parity: nothing Vercel-only; no new dependency (spec §11).
- Never `git add -A`; never `git stash`; stage only the files a task names (other sessions change this tree — re-check `git status` before staging). e2e: one run at a time, foreground, each run under 9 minutes, `PORT=3100`, via `scripts/e2e-local.sh` (isolated DB).
- Commit messages carry **no attribution trailer** (session instruction of 2026-10-29, which replaces the earlier `Claude-Session:` trailer rule).

## Increment-4 rulings (decisions the spec and the brief leave open)

- **R1 Show .info files reuses `browse.hideInfo`, default shown.** The brief said "default off = hide, as Browse's toggle did", but Browse's stored default is `hideInfo: false` (shown; pinned by `user-prefs-schema.test.ts` "defaults to showing .info files"), and the prefs file's rule is "every default is TODAY'S behaviour" (Files shows them today). So Files reads and writes the same stored field the Browse page uses; a person who hid them on Browse sees them hidden in Files too; Settings shows it as "Show .info files" (= `!hideInfo`). Cost if wrong: one default to flip (`.catch(true)` and DEFAULT) and one test.
- **R2 Ask before deleting, when off, skips the confirm on disks only.** A delete inside a LIBRARY: disk saves a version and the toast offers Undo, so it can be taken back; STASH: keeps no versions (increment 2 ruling 8) and a NET: delete cancels a send, so **STASH: and NET: always ask**. The setting's hint says so. Cost if wrong: one predicate (`deleteAsks`) to widen.
- **R3 Show comments has three choices: In STASH: (default; increment 2 ruling 9) / Always / Never.** Stored `files.comments: 'auto' | 'always' | 'never'`. Below lg the column never shows (as today). Cost if wrong: a label.
- **R4 When a name already exists pre-fills `onClash`.** `ask` keeps today's dialog. `keep-both`, `replace`, `skip` are sent as the first request's `onClash` for Copy, Move, a drag between panes and a computer drop into STASH:, so no dialog opens; the engine's existing rules (move + skip leaves the source, replace of the source refused) are unchanged. The disk drop review (`drop-review.tsx`) keeps its own per-file choices — it is a review, not a clash prompt. NET: never clashes. Cost if wrong: a person who chose Replace overwrites without a prompt — the hint says "Replace overwrites without asking; a disk keeps the old version in History, STASH: does not".
- **R5 Panes on opening apply only where the address names no pane.** `/files` (top nav, start page, Back to a bare `/files`) opens `left` and `right` from the setting; every link that names a pane (`Files…` on a disk, `/ingest?board=`, a board's queue link) keeps its own. The manager's popstate fallback uses the same setting, not `DEFAULT_LEFT`/`DEFAULT_RIGHT`. Choices are the three device roots. Cost if wrong: none (links are explicit).
- **R6 The filter.** One box per pane, in the pane header under the path, on every listing (titles and disks too). Case-insensitive substring of the row's name, this folder only (Files lists one folder; Browse's tree walk does not apply). It is part of the pane's state: it clears when the pane goes to another place (navigation, Back, a device button) and survives a reload of the same place (after an operation, a NET: poll) and Swap (it travels with its pane). The foot says "N of M shown" whenever rows are hidden. Keys: `/` focuses the active pane's filter (a new `find` command; never while typing or with a dialog open, like every shortcut); Escape in the box clears it, and a second Escape returns focus to the manager. Cost if wrong: small UX.
- **R7 Show .info is one setting with a switch in each pane that holds files** (inside a disk, STASH:), next to the filter; flipping either flips both panes and saves at once (as Browse's switch did), through its own `latestSaver` (one saver per field: `latestSaver` replaces a pending save with the next, so a sort save and an .info save must not share one). Hidden .info rows are not picked or acted on; copying or deleting a folder still takes everything in it (the server never sees the filter) — the help says so. Cost if wrong: a second switch to remove.
- **R8 The "dropped" mark** is on STASH: **file** rows whose `source` is `'browser'` (drops and Paste a URL): `dropped`. `'copy'` rows (copied in from a disk or archive) and folders carry no source mark. Amiga rows keep `from <board>`. Cost if wrong: a word.
- **R9 Help.** Topic ids `files` (title "Files") and `stash-net` (title "STASH: and NET:"). `files` joins the "Library and disks" group after `library`; `stash-net` joins "Amiga networking" after `network`. 19 → 21 topics. Neither topic's title or short may contain "drive" (the help filter's `drive` set, pinned in `match.test.ts` and `e2e/c5-layout.spec.ts`, stays four). The pane "?" shows `stash-net` for STASH: and NET:, `files` for LIBRARY:; the Files page header gets `help="files"`; the STASH: drop zone gets `stash-net` (the Send zone already has `send`). Two `help-tip-files` on one page are expected; e2e scopes by pane.
- **R10 Settings place.** A separate card **Files** (`#files`, heading `files-heading`, testid `files-settings`) right after Preferences in Settings › Account, and "Files" in the side list between "Preferences" and "Sign-in & password". Its save logic is the Preferences form's, extracted into `usePrefsChange` (behaviour of the Preferences card unchanged).

## Review Focus

1. **A filter (or Show .info off) hides a picked row.** Pick `ReadMe` and `Tools`, type `too` in the filter: `ReadMe` leaves the selection, and Delete/Copy act on `Tools` alone → Task 2 test `remapSelection drops rows the view hides` and Task 9 e2e `a filter that hides a picked file leaves it out of Delete`.
2. **A bare `/files` after Back, or from the nav, with non-default pane settings.** With left = NET: and right = STASH:, opening `/files` and pressing Back to it after navigating restores NET: | STASH:, not STASH: | LIBRARY: → Task 2 test `paneDefaults maps devices to roots` and Task 9 e2e `the panes setting opens /files, also after Back`.
3. **A stored prefs row from before this increment, or with one bad new field.** `{ files: { sort: {...} } }` and `{ files: { onClash: 'overwrite', confirmDelete: 'no' } }` read every new default and keep the sort; a patch `{ files: { onClash: 'overwrite' } }` is refused whole → Task 1 tests `old rows read the new defaults` and `a bad new field falls back alone`.
4. **"Ask before deleting" off in STASH: and NET:.** Delete there still asks; on a disk it deletes at once and the toast offers Undo → Task 2 test `deleteAsks: only a disk skips the confirm` and Task 9 e2e `with Ask before deleting off, a disk delete runs at once with Undo; STASH: still asks`.
5. **"Skip" set, Move onto a clash.** No dialog; the clashing file is skipped and stays in the source; nothing else changes → Task 9 e2e `with Skip set, a move onto a clash asks nothing and leaves the source`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/lib/user-prefs-schema.ts` (+ `.test.ts`), `src/lib/user-prefs.db.test.ts` | `files.panes`, `files.comments`, `files.confirmDelete`, `files.onClash`: types, defaults, tolerant read, strict patch, apply, diff. |
| `src/lib/files/view.ts` (+ `view.test.ts`) | Client-safe: `paneRows`, `viewCounts`, `remapSelection` (moved from the manager), `paneFoot`, `showsComment`, `deleteAsks`, `paneDefaults`, `paneHelpTopic`, `isInfoName`. |
| `src/lib/files/keys.ts` (+ test) | `/` → `find`. |
| `src/components/prefs/use-prefs-change.ts`, `pref-row.tsx`, `files-settings.tsx` (+ `files-settings.test.ts`), `preferences-form.tsx` | The save hook and row extracted; the Files card. |
| `src/components/ui/switch.tsx` (+ `switch.test.ts`) | One `role="switch"` control in the Browse switch's look. |
| `src/app/(app)/settings/page.tsx` | The Files card and its side-list entry. |
| `src/components/files/pane.tsx` (+ `pane.test.ts`) | Filter box, Show .info switch, "?" per device, foot words, empty-filter words. |
| `src/components/files/files-manager.tsx`, `src/app/(app)/files/page.tsx` | Apply the settings; filter state; `/`; .info saver; pane defaults. |
| `src/lib/files/stash-driver.ts` (+ `stash-driver.db.test.ts`) | `dropped` mark. |
| `src/lib/help/topics.tsx` (+ `topics.test.ts`), `src/components/files/stash-drop-zone.tsx` | Topics `files`, `stash-net`; Library and Preferences text; groups; zone "?". |
| Polish: `src/lib/files/pane-rules.ts`, `src/lib/files/words.ts`, `src/lib/files/net-rules.ts`, `src/lib/files/net-driver.ts`, `src/lib/archive/dos-date.ts`, `src/components/files/use-stash-upload.ts`, `src/components/library/title-controls.tsx` (+ their tests) | Deferred minors (Task 8). |
| `e2e/files-settings.spec.ts` (new), `e2e/files.mobile.spec.ts`, `e2e/contrast.spec.ts`, `e2e/c5-layout.spec.ts`, `e2e/c7-phone.mobile.spec.ts`, `e2e/help.spec.ts` | End to end. |

---

### Task 1: The Files settings in user prefs

**Files:**
- Modify: `src/lib/user-prefs-schema.ts`
- Test: `src/lib/user-prefs-schema.test.ts`, `src/lib/user-prefs.db.test.ts` (its "files default" expectation gains the new fields)

**Interfaces:**
- Consumes: existing `UserPrefs`, `parsePrefs`, `parsePrefsPatch`, `applyPrefsPatch`, `prefsDiff`, `DEFAULT_PREFS`.
- Produces:
  - `export const FILES_PANE_DEVICES = ['STASH', 'NET', 'LIBRARY'] as const; export type FilesPaneDevice = (typeof FILES_PANE_DEVICES)[number];`
  - `export const FILES_COMMENT_MODES = ['auto', 'always', 'never'] as const; export type FilesCommentMode = (typeof FILES_COMMENT_MODES)[number];`
  - `export const FILES_ON_CLASH = ['ask', 'keep-both', 'replace', 'skip'] as const; export type FilesOnClash = (typeof FILES_ON_CLASH)[number];` (same strings as the ops API's `onClash`)
  - `UserPrefs['files'] = { sort: {...as today}; panes: { left: FilesPaneDevice; right: FilesPaneDevice }; comments: FilesCommentMode; confirmDelete: boolean; onClash: FilesOnClash }`
  - Defaults: `panes: { left: 'STASH', right: 'LIBRARY' }`, `comments: 'auto'`, `confirmDelete: true`, `onClash: 'ask'`.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/user-prefs-schema.test.ts`)

```ts
describe('Files settings (increment 4)', () => {
  it('default to today: STASH: | LIBRARY:, comments in STASH:, Delete asks, a clash asks', () => {
    expect(DEFAULT_PREFS.files.panes).toEqual({ left: 'STASH', right: 'LIBRARY' });
    expect(DEFAULT_PREFS.files.comments).toBe('auto');
    expect(DEFAULT_PREFS.files.confirmDelete).toBe(true);
    expect(DEFAULT_PREFS.files.onClash).toBe('ask');
  });
  it('old rows read the new defaults and keep their sort', () => {
    const p = parsePrefs({ files: { sort: { library: { key: 'size', dir: 'desc' } } } });
    expect(p.files.sort.library).toEqual({ key: 'size', dir: 'desc' });
    expect(p.files.panes).toEqual({ left: 'STASH', right: 'LIBRARY' });
    expect(p.files.onClash).toBe('ask');
    expect(p.files.confirmDelete).toBe(true);
  });
  it('a bad new field falls back alone', () => {
    const p = parsePrefs({ files: { onClash: 'overwrite', confirmDelete: 'no', comments: 'always', panes: { left: 'NET', right: 'DH0' } } });
    expect(p.files.onClash).toBe('ask');
    expect(p.files.confirmDelete).toBe(true);     // only a real false turns the confirm off
    expect(p.files.comments).toBe('always');
    expect(p.files.panes).toEqual({ left: 'NET', right: 'LIBRARY' });
  });
  it('a patch is strict', () => {
    expect(parsePrefsPatch({ files: { onClash: 'replace' } }).ok).toBe(true);
    expect(parsePrefsPatch({ files: { panes: { left: 'NET' } } }).ok).toBe(true);
    expect(parsePrefsPatch({ files: { onClash: 'overwrite' } }).ok).toBe(false);
    expect(parsePrefsPatch({ files: { confirmDelete: 'no' } }).ok).toBe(false);
    expect(parsePrefsPatch({ files: { panes: { middle: 'NET' } } }).ok).toBe(false);
  });
  it('apply merges one field, keeping the sort and the other pane', () => {
    const p = applyPrefsPatch(parsePrefs({}), { files: { panes: { right: 'NET' }, confirmDelete: false } });
    expect(p.files.panes).toEqual({ left: 'STASH', right: 'NET' });
    expect(p.files.confirmDelete).toBe(false);
    expect(p.files.sort).toEqual(DEFAULT_PREFS.files.sort);
  });
  it('prefsDiff names only the Files fields that changed', () => {
    const from = parsePrefs({});
    const to = applyPrefsPatch(from, { files: { onClash: 'skip', panes: { left: 'LIBRARY' } } });
    expect(prefsDiff(from, to)).toEqual({ files: { onClash: 'skip', panes: { left: 'LIBRARY' } } });
    expect(prefsDiff(to, to)).toEqual({});
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/lib/user-prefs-schema.test.ts` → FAIL (`panes` undefined).

- [ ] **Step 3: Implement** in `src/lib/user-prefs-schema.ts`:

```ts
export const FILES_PANE_DEVICES = ['STASH', 'NET', 'LIBRARY'] as const;
export type FilesPaneDevice = (typeof FILES_PANE_DEVICES)[number];
export const FILES_COMMENT_MODES = ['auto', 'always', 'never'] as const;
export type FilesCommentMode = (typeof FILES_COMMENT_MODES)[number];
export const FILES_ON_CLASH = ['ask', 'keep-both', 'replace', 'skip'] as const;
export type FilesOnClash = (typeof FILES_ON_CLASH)[number];
```

`UserPrefs.files` gains `panes`, `comments`, `confirmDelete`, `onClash` (doc comment: spec §6, rulings R2–R5); `defaults()` gains the four defaults above. In `prefsSchema.files`:

```ts
    panes: z.object({
      left: z.enum(FILES_PANE_DEVICES).catch(() => defaults().files.panes.left),
      right: z.enum(FILES_PANE_DEVICES).catch(() => defaults().files.panes.right),
    }).catch(() => defaults().files.panes),
    comments: z.enum(FILES_COMMENT_MODES).catch(() => defaults().files.comments),
    // Fail safe: only a real `false` stops the confirm.
    confirmDelete: z.boolean().catch(true),
    onClash: z.enum(FILES_ON_CLASH).catch(() => defaults().files.onClash),
```

In `prefsPatchSchema.files` (strict): `panes: z.strictObject({ left: z.enum(FILES_PANE_DEVICES).optional(), right: z.enum(FILES_PANE_DEVICES).optional() }).optional()`, `comments: z.enum(FILES_COMMENT_MODES).optional()`, `confirmDelete: z.boolean().optional()`, `onClash: z.enum(FILES_ON_CLASH).optional()`.

`applyPrefsPatch`: `files: { sort: {...as today}, panes: { left: patch.files?.panes?.left ?? cur.files.panes.left, right: patch.files?.panes?.right ?? cur.files.panes.right }, comments: patch.files?.comments ?? cur.files.comments, confirmDelete: patch.files?.confirmDelete ?? cur.files.confirmDelete, onClash: patch.files?.onClash ?? cur.files.onClash }`.

`prefsDiff`: after the sort loop,

```ts
  for (const side of ['left', 'right'] as const) {
    if (from.files.panes[side] !== to.files.panes[side]) {
      patch.files = { ...patch.files, panes: { ...patch.files?.panes, [side]: to.files.panes[side] } };
    }
  }
  if (from.files.comments !== to.files.comments) patch.files = { ...patch.files, comments: to.files.comments };
  if (from.files.confirmDelete !== to.files.confirmDelete) patch.files = { ...patch.files, confirmDelete: to.files.confirmDelete };
  if (from.files.onClash !== to.files.onClash) patch.files = { ...patch.files, onClash: to.files.onClash };
```

In `user-prefs.db.test.ts`, the expectation that pins the stored `files` default gains the four fields (an expected change, not a weaker assertion).

- [ ] **Step 4: Run** `pnpm vitest run src/lib/user-prefs-schema.test.ts src/lib/user-prefs.test.ts src/lib/user-prefs-client.test.ts && pnpm test:db src/lib/user-prefs.db.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/user-prefs-schema.ts src/lib/user-prefs-schema.test.ts src/lib/user-prefs.db.test.ts
git commit -m "Files settings in user prefs: panes on opening, Comment column, Ask before deleting, name-clash answer (defaults = today)"
```

---

### Task 2: The pane view rules and the `/` key

**Files:**
- Create: `src/lib/files/view.ts`, `src/lib/files/view.test.ts`
- Modify: `src/lib/files/keys.ts`, `src/lib/files/keys.test.ts`, `src/components/files/files-manager.tsx` (only: import `remapSelection` from `view.ts` instead of the local copy, which is deleted)

**Interfaces:**
- Consumes: `sortFsEntries`, `FilesSort` (`./sort`); `Selection` (`./selection`); `FsEntry`, `Listing` (`./types`); `parsePath` (`./path`); `FilesCommentMode`, `UserPrefs` (`@/lib/user-prefs-schema`); `HelpTopicId` type (`@/lib/help/topics` — type-only import keeps it client-safe).
- Produces (all exported from `src/lib/files/view.ts`):
  - `type PaneView = { filter: string; hideInfo: boolean }`
  - `isInfoName(e: Pick<FsEntry, 'kind' | 'name'>): boolean`
  - `paneRows(entries: FsEntry[], sort: FilesSort, view: PaneView): FsEntry[]`
  - `viewCounts(entries: FsEntry[], view: PaneView): { total: number; shown: number; infoHidden: number }`
  - `remapSelection(before: FsEntry[], after: FsEntry[], sel: Selection): Selection`
  - `paneFoot(a: { base: string; shown: number; total: number; infoHidden: number; picked: number; pickedSize: string }): string`
  - `showsComment(mode: FilesCommentMode, path: string): boolean`
  - `deleteAsks(confirmDelete: boolean, l: Listing | null): boolean`
  - `paneDefaults(p: UserPrefs['files']['panes']): { left: string; right: string }`
  - `paneHelpTopic(path: string): 'files' | 'stash-net'` (`HelpTopicId` gains these ids in Task 7; until then the return type is the literal union and the function is unused by components)
  - `keys.ts`: `FilesCommand` gains `'find'`; `'/'` maps to it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/files/view.test.ts
import { describe, it, expect } from 'vitest';
import type { FsEntry, Listing } from './types';
import { EMPTY_SELECTION } from './selection';
import {
  isInfoName, paneRows, viewCounts, remapSelection, paneFoot, showsComment, deleteAsks, paneDefaults, paneHelpTopic,
} from './view';

const e = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({
  name, kind, path: `LIBRARY:/g/d/${name}`, size: 1, date: null, protection: null, comment: null, marks: [],
});
const rows = [e('ReadMe'), e('ReadMe.info'), e('Tools', 'dir'), e('Tools.info'), e('Disk.INFO'), e('c', 'dir')];
const byName = { key: 'name', dir: 'asc' } as const;
const listing = (path: string, disk: boolean): Listing => ({
  path, crumbs: [], entries: [], writable: true, readOnlyReason: null, meta: '',
  disk: disk ? ({ diskId: 'd' } as Listing['disk']) : null,
});

describe('isInfoName', () => {
  it('is a FILE whose name ends .info, any case', () => {
    expect(isInfoName(e('Disk.INFO'))).toBe(true);
    expect(isInfoName(e('x.info', 'dir'))).toBe(false);
    expect(isInfoName(e('info'))).toBe(false);
  });
});

describe('paneRows', () => {
  it('sorts as before when nothing is filtered (folders first)', () => {
    expect(paneRows(rows, byName, { filter: '', hideInfo: false }).map((x) => x.name))
      .toEqual(['c', 'Tools', 'Disk.INFO', 'ReadMe', 'ReadMe.info', 'Tools.info']);
  });
  it('hides .info files', () => {
    expect(paneRows(rows, byName, { filter: '', hideInfo: true }).map((x) => x.name)).toEqual(['c', 'Tools', 'ReadMe']);
  });
  it('keeps names containing the filter, case aside, trimmed', () => {
    expect(paneRows(rows, byName, { filter: ' TOOL ', hideInfo: false }).map((x) => x.name)).toEqual(['Tools', 'Tools.info']);
    expect(paneRows(rows, byName, { filter: 'tool', hideInfo: true }).map((x) => x.name)).toEqual(['Tools']);
  });
});

describe('viewCounts', () => {
  it('counts what is drawn and what Show .info hides', () => {
    expect(viewCounts(rows, { filter: '', hideInfo: true })).toEqual({ total: 6, shown: 3, infoHidden: 3 });
    expect(viewCounts(rows, { filter: 'read', hideInfo: false })).toEqual({ total: 6, shown: 2, infoHidden: 0 });
  });
});

describe('remapSelection drops rows the view hides', () => {
  it('picked rows follow their entries; a hidden one leaves the selection', () => {
    const before = paneRows(rows, byName, { filter: '', hideInfo: false });
    const after = paneRows(rows, byName, { filter: 'too', hideInfo: false });
    const sel = { anchor: 1, cursor: 3, picked: new Set([1, 3]) };   // Tools, ReadMe
    const out = remapSelection(before, after, sel);
    expect([...out.picked].map((i) => after[i].name)).toEqual(['Tools']);
    expect(out.cursor).toBe(0);
    expect(remapSelection(before, before, EMPTY_SELECTION).picked.size).toBe(0);
  });
});

describe('paneFoot', () => {
  const base = { base: '1 folder · 2 files', shown: 3, total: 3, infoHidden: 0, picked: 0, pickedSize: '' };
  it('is the base when everything is drawn', () => expect(paneFoot(base)).toBe('1 folder · 2 files'));
  it('says N of M shown, and how many .info files are hidden', () => {
    expect(paneFoot({ ...base, shown: 2, total: 6, infoHidden: 3 })).toBe('2 of 6 shown · 3 .info files hidden');
    expect(paneFoot({ ...base, shown: 1, total: 3 })).toBe('1 of 3 shown');
    expect(paneFoot({ ...base, shown: 2, total: 3, infoHidden: 1 })).toBe('2 of 3 shown · 1 .info file hidden');
  });
  it('a selection counts against the rows drawn', () => {
    expect(paneFoot({ ...base, shown: 2, total: 6, picked: 1, pickedSize: '5 KB' })).toBe('1 of 2 selected · 5 KB');
  });
});

describe('showsComment', () => {
  it('auto is STASH: only; always and never mean it', () => {
    expect(showsComment('auto', 'STASH:/Mods')).toBe(true);
    expect(showsComment('auto', 'LIBRARY:/g/d')).toBe(false);
    expect(showsComment('always', 'NET:/b')).toBe(true);
    expect(showsComment('never', 'STASH:')).toBe(false);
  });
});

describe('deleteAsks: only a disk skips the confirm', () => {
  it('asks everywhere when the setting is on', () => {
    expect(deleteAsks(true, listing('LIBRARY:/g/d', true))).toBe(true);
  });
  it('off: a disk does not ask; STASH: and NET: still do (R2)', () => {
    expect(deleteAsks(false, listing('LIBRARY:/g/d', true))).toBe(false);
    expect(deleteAsks(false, listing('STASH:/Mods', false))).toBe(true);
    expect(deleteAsks(false, listing('NET:/b1', false))).toBe(true);
    expect(deleteAsks(false, null)).toBe(true);
  });
});

describe('paneDefaults maps devices to roots', () => {
  it('maps each choice to its root', () => {
    expect(paneDefaults({ left: 'NET', right: 'STASH' })).toEqual({ left: 'NET:', right: 'STASH:' });
  });
});

describe('paneHelpTopic', () => {
  it('STASH: and NET: explain themselves; LIBRARY: is the Files topic', () => {
    expect(paneHelpTopic('STASH:/x')).toBe('stash-net');
    expect(paneHelpTopic('NET:')).toBe('stash-net');
    expect(paneHelpTopic('LIBRARY:/g/d')).toBe('files');
  });
});
```

Add to `src/lib/files/keys.test.ts`:

```ts
  it("'/' finds; never while typing in a field", () => {
    const base = { target: { tagName: 'DIV' }, dialogOpen: false, altKey: false, ctrlKey: false, metaKey: false };
    expect(commandFor({ ...base, key: '/' })).toBe('find');
    expect(commandFor({ ...base, key: '/', target: { tagName: 'INPUT' } })).toBeNull();
    expect(commandFor({ ...base, key: '/', dialogOpen: true })).toBeNull();
  });
```

- [ ] **Step 2: Run** `pnpm vitest run src/lib/files/view.test.ts src/lib/files/keys.test.ts` → FAIL ("Cannot find module './view'"; `find` missing).

- [ ] **Step 3: Implement**

```ts
// src/lib/files/view.ts
// What a pane draws and says (Files increment 4: settings and the filter). CLIENT-SAFE: types and pure functions only.
// The Pane and the manager both draw rows through paneRows, so a row index names the same entry in both.
import type { FilesCommentMode, UserPrefs } from '@/lib/user-prefs-schema';
import { sortFsEntries, type FilesSort } from './sort';
import type { Selection } from './selection';
import { parsePath } from './path';
import type { FsEntry, Listing } from './types';

/** The filter text (this pane's, R6) and Show .info (both panes, R7). */
export type PaneView = { filter: string; hideInfo: boolean };

/** A Workbench icon FILE: "Disk.info", "ReadMe.INFO". */
export const isInfoName = (e: Pick<FsEntry, 'kind' | 'name'>) => e.kind === 'file' && e.name.toLowerCase().endsWith('.info');

function visible(view: PaneView) {
  const q = view.filter.trim().toLowerCase();
  return (e: FsEntry) => !(view.hideInfo && isInfoName(e)) && (!q || e.name.toLowerCase().includes(q));
}

/** The rows a pane draws, in the order it draws them. */
export function paneRows(entries: FsEntry[], sort: FilesSort, view: PaneView): FsEntry[] {
  return sortFsEntries(entries, sort).filter(visible(view));
}

export function viewCounts(entries: FsEntry[], view: PaneView): { total: number; shown: number; infoHidden: number } {
  return {
    total: entries.length,
    shown: entries.filter(visible(view)).length,
    infoHidden: view.hideInfo ? entries.filter(isInfoName).length : 0,
  };
}

/** The same place drawn another way (a sort, a filter, a fresh listing): picks and the cursor follow their entries; a hidden one is let go. */
export function remapSelection(before: FsEntry[], after: FsEntry[], sel: Selection): Selection {
  const at = new Map(after.map((e, i) => [e.path, i]));
  const map = (i: number | null) => (i === null || !before[i] ? null : at.get(before[i].path) ?? null);
  const picked = new Set<number>();
  for (const i of sel.picked) { const j = map(i); if (j !== null) picked.add(j); }
  return { anchor: map(sel.anchor), cursor: map(sel.cursor) ?? 0, picked };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The foot: the selection, else "N of M shown" when rows are hidden, else the pane's own words (`base`). */
export function paneFoot(a: { base: string; shown: number; total: number; infoHidden: number; picked: number; pickedSize: string }): string {
  if (a.picked > 0) return `${a.picked} of ${a.shown} selected · ${a.pickedSize}`;
  if (a.shown < a.total) return `${a.shown} of ${a.total} shown${a.infoHidden ? ` · ${plural(a.infoHidden, '.info file')} hidden` : ''}`;
  return a.base;
}

/** R3: 'auto' shows the Comment column in STASH: only (increment 2 ruling 9). */
export function showsComment(mode: FilesCommentMode, path: string): boolean {
  return mode === 'always' || (mode === 'auto' && parsePath(path)?.device === 'STASH');
}

/** R2: with the setting off, only a delete inside a disk (versioned, Undo) skips the confirm. */
export function deleteAsks(confirmDelete: boolean, l: Listing | null): boolean {
  return confirmDelete || !l?.disk;
}

/** R5: the panes a bare /files opens with. */
export function paneDefaults(p: UserPrefs['files']['panes']): { left: string; right: string } {
  return { left: `${p.left}:`, right: `${p.right}:` };
}

/** R9: the "?" in a pane's header. */
export function paneHelpTopic(path: string): 'files' | 'stash-net' {
  const d = parsePath(path)?.device;
  return d === 'STASH' || d === 'NET' ? 'stash-net' : 'files';
}
```

`keys.ts`: add `'find'` to `FilesCommand` and `'/': 'find'` to `KEYS`. In `files-manager.tsx`, delete the local `remapSelection` and import it from `@/lib/files/view` (same body; the NET: poll keeps using it). Until Task 5 handles `find`, `command()`'s `default: act(cmd)` must not receive it: add `case 'find': return;` (Task 5 fills it).

- [ ] **Step 4: Run** `pnpm vitest run src/lib/files src/components/files && pnpm tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/view.ts src/lib/files/view.test.ts src/lib/files/keys.ts src/lib/files/keys.test.ts src/components/files/files-manager.tsx
git commit -m "Files: pane view rules (filter, .info, foot, comment column, delete confirm, pane defaults) and the / key"
```

---

### Task 3: Settings › Account › Files

**Files:**
- Create: `src/components/prefs/use-prefs-change.ts`, `src/components/prefs/pref-row.tsx`, `src/components/prefs/files-settings.tsx`, `src/components/prefs/files-settings.test.ts`, `src/components/ui/switch.tsx`, `src/components/ui/switch.test.ts`
- Modify: `src/components/prefs/preferences-form.tsx` (uses the hook and `PrefRow`; behaviour unchanged), `src/app/(app)/settings/page.tsx`, `src/lib/help/topics.tsx` + `topics.test.ts` (Preferences topic names the Files section)

**Interfaces:**
- Consumes: Task 1's types and constants; `savePrefs`, `prefsDiff`, `SegRadioGroup`, `SETTINGS_CARD`, `SETTINGS_H2`, `SETTINGS_ROW`, `CARD_STYLE`, `prefsStateLook`.
- Produces:
  - `usePrefsChange(prefs: UserPrefs): { draft: UserPrefs; state: 'saved' | 'saving' | 'failed'; change(next: UserPrefs): Promise<void> }` — the body of `PreferencesForm`'s `change` moved verbatim (saved/draft/state/pending ref, `router.refresh()`, the failure toast).
  - `PrefRow({ labelId, hintId, label, hint, children })` moved from `preferences-form.tsx`.
  - `Switch({ checked, onChange, testId, 'aria-labelledby'?: string, 'aria-describedby'?: string, 'aria-label'?: string, disabled?: boolean }): JSX.Element` — `<button type="button" role="switch" aria-checked>` with `data-testid={testId}`, the track/knob look of `file-tree.tsx`'s Hide .info switch (`--ink` on, `--line-strong` + inset `--muted-2` off), `min-h-11` below lg.
  - `FilesSettings({ prefs }: { prefs: UserPrefs })`.
- Markup contract (`files-settings.tsx`): `<section id="files" aria-labelledby="files-heading" data-testid="files-settings">`, `<h2 id="files-heading" tabIndex={-1}>Files</h2>`, state line `files-prefs-state` (as `prefs-state`), intro "How the Files page opens and behaves. Yours alone, like your other preferences." Rows, in order:
  1. "Left pane opens on" — `SegRadioGroup testId="pref-files-left"` options `STASH:`/`NET:`/`LIBRARY:` (values `STASH|NET|LIBRARY`); hint "When you open Files from the menu. Files… on a disk always opens that disk."
  2. "Right pane opens on" — `pref-files-right`, same options; hint "The other pane."
  3. "Show .info files" — `Switch testId="pref-files-show-info"` checked = `!draft.browse.hideInfo`; change saves `browse.hideInfo`; hint "Workbench icon files. The switch in each pane changes this too."
  4. "Comment column" — `pref-files-comments` options `auto` "In STASH:", `always` "Always", `never` "Never"; hint "Wide screens only."
  5. "Ask before deleting" — `Switch testId="pref-files-confirm-delete"`; hint "Turned off, a delete on a disk happens at once and can be undone. STASH: and NET: always ask."
  6. "When a name already exists" — `pref-files-on-clash` options `ask` "Ask", `keep-both` "Keep both", `replace` "Replace", `skip` "Skip"; hint "Replace overwrites without asking; a disk keeps the old version in History, STASH: does not."
- Page: `SECTIONS[0].items` gains `{ href: '#files', label: 'Files', focusId: 'files-heading' }` after Preferences; `<FilesSettings prefs={prefs} />` after `<PreferencesForm …/>`.
- Help (`preferences` topic): after the "Changing them." paragraph add `<p><strong>Files.</strong> Its own section sets the panes Files opens with, .info files, the Comment column, whether Delete asks and what happens when a name exists.</p>` (keep the body ≤ 280 words: it is 252 today; if the test fails, shorten "Changing them." to "Settings (the gear; More, then Settings, on a phone) lists every preference under Account, kept as soon as you change it.").

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/prefs/files-settings.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePrefs } from '@/lib/user-prefs-schema';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const { FilesSettings } = await import('./files-settings');

const html = (raw: unknown) => renderToStaticMarkup(createElement(FilesSettings, { prefs: parsePrefs(raw) }));

describe('FilesSettings', () => {
  it('is the #files card with its six rows in order', () => {
    const h = html({});
    expect(h).toContain('id="files"');
    expect(h).toContain('data-testid="files-settings"');
    const order = ['pref-files-left', 'pref-files-right', 'pref-files-show-info', 'pref-files-comments', 'pref-files-confirm-delete', 'pref-files-on-clash']
      .map((t) => h.indexOf(`data-testid="${t}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('shows the stored values: defaults, then a changed row', () => {
    const d = html({});
    expect(d).toMatch(/data-testid="pref-files-left"[^>]*data-value="STASH"/);
    expect(d).toMatch(/data-testid="pref-files-show-info"[^>]*aria-checked="true"/);
    expect(d).toMatch(/data-testid="pref-files-on-clash"[^>]*data-value="ask"/);
    const c = html({ browse: { hideInfo: true }, files: { confirmDelete: false, onClash: 'skip', panes: { right: 'NET' } } });
    expect(c).toMatch(/data-testid="pref-files-show-info"[^>]*aria-checked="false"/);
    expect(c).toMatch(/data-testid="pref-files-confirm-delete"[^>]*aria-checked="false"/);
    expect(c).toMatch(/data-testid="pref-files-on-clash"[^>]*data-value="skip"/);
    expect(c).toMatch(/data-testid="pref-files-right"[^>]*data-value="NET"/);
  });
  it('says STASH: and NET: always ask', () => {
    expect(html({})).toContain('STASH: and NET: always ask.');
  });
});
```

```ts
// src/components/ui/switch.test.ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from './switch';

describe('Switch', () => {
  it('is a button with role switch saying its state', () => {
    const on = renderToStaticMarkup(createElement(Switch, { checked: true, onChange() {}, testId: 's', 'aria-label': 'Show .info files' }));
    expect(on).toMatch(/^<button type="button" role="switch" aria-checked="true"/);
    expect(on).toContain('data-testid="s"');
    expect(renderToStaticMarkup(createElement(Switch, { checked: false, onChange() {}, testId: 's' }))).toContain('aria-checked="false"');
  });
});
```

Add to `src/lib/help/topics.test.ts`:

```ts
  it('preferences names the Files section (increment 4)', () => {
    expect(bodyText('preferences')).toMatch(/Files\.\s+Its own section sets the panes Files opens with/);
  });
```

- [ ] **Step 2: Run** `pnpm vitest run src/components/prefs src/components/ui/switch.test.ts src/lib/help/topics.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the contract. `FilesSettings` uses `usePrefsChange(prefs)`; each control calls `change({ ...draft, files: { ...draft.files, … } })` (Show .info: `change({ ...draft, browse: { ...draft.browse, hideInfo: !checked } })`). `prefsDiff` (Task 1) sends only the changed field, so the two cards never put back each other's fields.
- [ ] **Step 4: Run** `pnpm vitest run src/components/prefs src/components/ui src/lib/help src/lib/user-prefs-schema.test.ts && pnpm tsc --noEmit -p .` → PASS. Then `PORT=3100 bash scripts/e2e-local.sh e2e/user-settings.spec.ts --project=desktop` (the Preferences card, unchanged) → PASS, and update `e2e/c5-layout.spec.ts:75`'s list to `['Preferences', 'Files', 'Sign-in & password', 'Firmware updates', 'Delete account']` and run `… e2e/c5-layout.spec.ts --project=desktop -g "Settings"` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/components/prefs/use-prefs-change.ts src/components/prefs/pref-row.tsx src/components/prefs/files-settings.tsx \
  src/components/prefs/files-settings.test.ts src/components/prefs/preferences-form.tsx src/components/ui/switch.tsx \
  src/components/ui/switch.test.ts "src/app/(app)/settings/page.tsx" src/lib/help/topics.tsx src/lib/help/topics.test.ts e2e/c5-layout.spec.ts
git commit -m "Settings › Account › Files: panes on opening, Show .info files, Comment column, Ask before deleting, name clash"
```

---

### Task 4: The filter box, Show .info and the foot in the Pane

**Files:**
- Modify: `src/components/files/pane.tsx`, `src/components/files/pane.test.ts`

**Interfaces:**
- Consumes: Task 2 `paneRows`, `viewCounts`, `paneFoot`, `PaneView`; Task 3 `Switch`; `HelpTip`.
- Produces (`PaneProps` gains):
  - `view: PaneView` — the rows are `paneRows(listing.entries, sort, view)` (replaces the bare `sortFsEntries`).
  - `onFilter(text: string): void`, `onShowInfo(show: boolean): void`
  - `help: 'files' | 'stash-net'` — the topic of the "?" (Task 7 adds the topics; until then the manager passes the value and the Pane renders the "?" only when `help in HELP_TOPICS`, a guard Task 7 removes).
  - `filterRef?: React.Ref<HTMLInputElement>` — the manager focuses it on `/`.
- Markup contract:
  - In the header, a row under the path: `<input type="search" data-testid="pane-<side>-filter" aria-label="Filter the left pane by name" placeholder="Filter names" value={view.filter}>` (`max-lg:min-h-11`, border `--line`, text `--ink`, placeholder `--muted-2`); onKeyDown Escape: when the value is not empty, `onFilter('')` and `preventDefault`; when empty, let it bubble (the manager returns focus, Task 5).
  - Beside it, only when `holdsFiles(listing)`: a `Switch testId="pane-<side>-show-info" aria-label="Show .info files" checked={!view.hideInfo}` with the visible label "Show .info".
  - The device row ends with the "?" (`ml-auto`), `HelpTip topic={help}`.
  - Foot: `paneFoot({ base, shown, total, infoHidden, picked, pickedSize: paneSize(pickedBytes) })`, where `base` is today's foot without a selection (meta, "· Drop files here", "· Drop files to send them").
  - Empty: when `rows.length === 0 && listing.entries.length > 0` the body says `No names match “<filter>”.` (testid `pane-<side>-no-match`) — or, when only .info files are hidden, `Only .info files here — turn on Show .info to see them.`; otherwise "Nothing here." as today.

- [ ] **Step 1: Write the failing tests** (add to `pane.test.ts`; its `render()` default props gain `view: { filter: '', hideInfo: false }, onFilter: noop, onShowInfo: noop, help: 'files'`)

```ts
describe('the filter and Show .info (increment 4)', () => {
  it('draws only the rows the filter keeps and says N of M in the foot', () => {
    const h = render({ view: { filter: 'ass', hideInfo: false } });
    expect(h).toContain('data-name="Assign"');
    expect(h).not.toContain('data-name="List"');
    expect(h).toMatch(/data-testid="pane-left-foot"[^>]*>1 of 3 shown</);
    expect(h).toMatch(/data-testid="pane-left-filter"[^>]*value="ass"/);
  });
  it('says when nothing matches', () => {
    expect(render({ view: { filter: 'zzz', hideInfo: false } })).toContain('No names match “zzz”.');
  });
  it('has the Show .info switch only where files live', () => {
    expect(render()).toContain('data-testid="pane-left-show-info"');
    expect(render({ listing: rootListing })).not.toContain('data-testid="pane-left-show-info"');
    expect(render({ listing: rootListing })).toContain('data-testid="pane-left-filter"');
  });
  it('hides .info rows and counts them', () => {
    const withInfo = { ...diskListing, entries: [...diskListing.entries, entry('Assign.info', 'file')] };
    const h = render({ listing: withInfo, view: { filter: '', hideInfo: true } });
    expect(h).not.toContain('data-name="Assign.info"');
    expect(h).toMatch(/3 of 4 shown · 1 \.info file hidden/);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/components/files/pane.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the contract (`rows` via `paneRows`; everything that used `rows` keeps using it, so indexes stay the drawn order).
- [ ] **Step 4: Run** `pnpm vitest run src/components/files && pnpm tsc --noEmit -p .` → PASS (`files-manager.tsx` passes `view={{ filter: '', hideInfo: false }}`, no-op callbacks and `help="files"` until Task 5 — compile only).
- [ ] **Step 5: Commit**

```bash
git add src/components/files/pane.tsx src/components/files/pane.test.ts src/components/files/files-manager.tsx
git commit -m "Files pane: name filter, Show .info switch, N of M shown, a ? per device"
```

---

### Task 5: The Files page and manager apply the settings

**Files:**
- Modify: `src/app/(app)/files/page.tsx`, `src/components/files/files-manager.tsx`

**Interfaces:**
- Consumes: Task 1 prefs; Task 2 `paneRows`, `remapSelection`, `showsComment`, `deleteAsks`, `paneDefaults`, `paneHelpTopic`, `find`; Task 4 Pane props; `latestSaver`.
- Produces:
  - `FilesManagerProps.prefs: { files: UserPrefs['files']; hideInfo: boolean }` (replaces `{ sort }`); the page passes `{ files: prefs.files, hideInfo: prefs.browse.hideInfo }`.
  - `PaneState` gains `filter: string`.
- Behaviour:
  - **Page (R5):** `getUserPrefs(userId)` is awaited first; `const d = paneDefaults(prefs.files.panes)`; `paneParam(sp.left, d.left)`, `paneParam(sp.right, d.right)`; then the listings, the send targets and the strips as today. `<PageHeader … help="files" />` (Task 7 adds the topic; the "?" appears then — until Task 7 leave `help` off and add it there).
  - **Popstate (R5):** `pathParam(q.get('left'), defaults.left)` with `defaults = paneDefaults(prefs.files.panes)`, never `DEFAULT_LEFT`/`DEFAULT_RIGHT` (those stay for links that name STASH:).
  - **Rows:** `rowsLeft`/`rowsRight` = `paneRows(shown.entries, sort, { filter: panes[side].filter, hideInfo })`; Pane gets the same `view`.
  - **Filter (R6):** `setFilter(side, text)` sets `filter` and remaps that side's selection (`remapSelection(oldRows, newRows, sel)`); `load()` keeps `filter` when the new path equals the pane's current path, else `''`; Swap moves it with its pane (it is pane state). `find`: focus `filterRef` of the active side (refs per side). Escape that bubbles from an empty filter box focuses `rootRef`.
  - **Show .info (R7):** `const [hideInfo, setHideInfo] = useState(prefs.hideInfo)`; `const [infoSaver] = useState(latestSaver)`; `showInfo(show)` remaps BOTH panes' selections, sets state, saves `{ browse: { hideInfo: !show } }` (failure toast "Couldn't remember Show .info for next time.").
  - **Comment column (R3):** `showComment={showsComment(prefs.files.comments, p.listing?.path ?? p.path)}`.
  - **Delete (R2):** `act('delete')`: when `!deleteAsks(prefs.files.confirmDelete, src)`, run the delete as the dialog's confirm does (`runFromDialog({ op: 'delete', sources }, 'Deleting N items…', deletedFrom-style words)`) after `guarded([src?.disk], …)`; the toast's Undo comes from `report` as for any one-version op. Otherwise open the dialog as today. The Delete key goes through `act`, so it follows the same rule.
  - **Clash (R4):** `transfer(op, …)` sends `[{ onClash: prefs.files.onClash, sources }]` as its first group (today `'ask'`); a 409 can then only come from `ask`. `storeDrop`: when `prefs.files.onClash !== 'ask'`, no `stash-clash` dialog: `runStash(dir, [{ onClash: prefs.files.onClash, items: dropped }], noneDone(), prefs.files.onClash === 'skip' ? new Set(clashes.map((c) => c.source.toLowerCase())) : new Set())`.
  - **Help:** `help={paneHelpTopic(p.listing?.path ?? p.path)}`.
  - The `stash` and `onDrop` paths, the strip, polling and the phone layout are otherwise untouched.

- [ ] **Step 1: Write the failing test** — no unit harness exists for the manager (ledger: e2e covers it); the failing tests are Task 9's e2e cases named in Review Focus 1, 2, 4 and 5 plus `the filter clears on another folder and keeps after a copy`. Write them now in `e2e/files-settings.spec.ts` (Task 9 lists their bodies) so this task runs them red first.
- [ ] **Step 2: Run** `PORT=3100 bash scripts/e2e-local.sh e2e/files-settings.spec.ts --project=desktop` → FAIL.
- [ ] **Step 3: Implement** per the behaviour list.
- [ ] **Step 4: Run** `pnpm vitest run src/lib/files src/components/files && pnpm tsc --noEmit -p .`; then `PORT=3100 bash scripts/e2e-local.sh e2e/files-settings.spec.ts --project=desktop` → PASS; then `… e2e/files.spec.ts e2e/files-stash.spec.ts --project=desktop` → PASS (defaults are today's behaviour, so nothing there changes).
- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/files/page.tsx" src/components/files/files-manager.tsx e2e/files-settings.spec.ts
git commit -m "Files applies its settings: panes on opening, filter per pane, Show .info, Comment column, Delete without confirm on disks, clash answer"
```

---

### Task 6: The "dropped" mark on STASH: rows

**Files:**
- Modify: `src/lib/files/stash-driver.ts` (`marksOf`)
- Test: `src/lib/files/stash-driver.db.test.ts`

**Interfaces:**
- Consumes: `StashRow.source` (`'amiga' | 'browser' | 'copy'`, migration 0051).
- Produces: a file row with `source === 'browser'` carries the mark `dropped` first in `marks` (R8). Nothing else changes.

- [ ] **Step 1: Write the failing test** (in `describe('STASH: listing')`; the file's `stash()` helper inserts with source `'browser'`)

```ts
  it("marks files dropped from the computer 'dropped', copies and folders nothing, Amiga files their board (R8)", async () => {
    await insertStash(getDb(), 'o1', 'copy', [{ path: 'Copied.txt', kind: 'file', sha256: await put(enc('c')), sizeBytes: 1,
      date: new Date(Date.UTC(2020, 0, 2)), protection: 0, comment: '' }]);
    const l = (await stashDriver.list(ctx, P('STASH:')))!;
    const marks = (n: string) => l.entries.find((e) => e.name === n)!.marks;
    expect(marks('ReadMe')).toEqual(['dropped']);
    expect(marks('Copied.txt')).toEqual([]);
    expect(marks('Mods')).toEqual([]);
    expect(marks('Broken.txt')[0]).toBe('from A500 bench');
  });
```

Existing assertions in this file that pin `marks: []` for a seeded browser file change to `['dropped']` (an expected change). `grep -rn "marks" e2e/files-stash.spec.ts e2e/from-amiga.spec.ts` and adjust any exact-marks assertion the same way.

- [ ] **Step 2: Run** `pnpm test:db src/lib/files/stash-driver.db.test.ts` → FAIL.
- [ ] **Step 3: Implement**

```ts
function marksOf(row: StashRow): string[] {
  const marks: string[] = [];
  if (row.source === 'amiga' && row.deviceName) marks.push(`from ${row.deviceName}`);
  // R8 (increment 4): a file from a drop on this page or a pasted URL; a copy from a disk or an archive says nothing.
  if (row.source === 'browser') marks.push('dropped');
  // …the arriving / failed / in the library marks as before
```

- [ ] **Step 4: Run** `pnpm test:db src/lib/files && pnpm vitest run src/lib/files` → PASS; `PORT=3100 bash scripts/e2e-local.sh e2e/files-stash.spec.ts --project=desktop` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/stash-driver.ts src/lib/files/stash-driver.db.test.ts
git commit -m "STASH: files dropped from the computer are marked dropped"
```

(Add `e2e/files-stash.spec.ts` / `e2e/from-amiga.spec.ts` to `git add` only if Step 1's grep changed them.)

---

### Task 7: Help — Files, STASH: and NET:, Library, the "?" per pane

**Files:**
- Modify: `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`, `src/components/files/pane.tsx` (drop Task 4's `help in HELP_TOPICS` guard), `src/app/(app)/files/page.tsx` (`help="files"`), `src/components/files/stash-drop-zone.tsx` (`help={<HelpTip topic="stash-net" />}` on its `DropCard`, styled as the Send zone's), `src/components/help/help-browser.tsx` (comment only), `e2e/c5-layout.spec.ts`, `e2e/c7-phone.mobile.spec.ts`, `e2e/help.spec.ts`

**Interfaces:**
- Consumes: `paneHelpTopic` (Task 2).
- Produces: `HelpTopicId` gains `'files'` and `'stash-net'`; `HELP_GROUPS` = drives (unchanged), disks `['library', 'files', 'write-back', 'disk-sets', 'hd-hfe', 'cover-image']`, network `['network', 'stash-net', 'send', 'from-amiga']`, server (unchanged). 21 topics.

Topic text (source comment above each names: spec §4–§7; increments 1–4 rulings; `pane.tsx`, `files-manager.tsx`, `keys.ts`, `view.ts`, `stash-driver.ts` marks, `net-driver.ts`, `amiga-upload-limits.ts`, `send-limits.ts`; the Chromium Shift-after-drag note of the increment-1 ledger, Task 11):

```tsx
  files: {
    title: 'Files',
    short: 'Two panes for every file that is not a whole disk: STASH:, NET: and the disks in LIBRARY:. Pick files on one side and copy or move them to the other.',
    body: (
      <>
        <p>
          <strong>Three places.</strong> <em>STASH:</em> holds loose files: what you drop on the page and what your
          Amiga sends. <em>NET:</em> lists your boards; copying into one sends the files to its Amiga.{' '}
          <em>LIBRARY:</em> opens a title, then a disk, then its folders.
        </p>
        <p>
          <strong>Copy and move.</strong> Click a pane to make it active and pick files (Shift-click for a range,
          Ctrl- or ⌘-click for one more), then press <em>Copy</em> or <em>Move</em> in the middle column. Dragging rows
          onto the other pane copies them; press Shift after the drag has started to move them instead. When a name is
          already there, choose Replace, Skip or Keep both.
        </p>
        <p>
          <strong>Inside a disk.</strong> The strip above the files shows which drive holds the disk, the free space,{' '}
          <em>Mount</em>, <em>History</em> and <em>⬇ ADF</em>. Every change saves one new version, and the message
          offers Undo. A disk in a drive cannot be changed until you eject it. <em>Protect</em> sets protection bits;{' '}
          <em>Info</em> shows a file&apos;s details and comment.
        </p>
        <p>
          <strong>Finding files.</strong> Type in a pane&apos;s filter box to see only names that contain it;{' '}
          <em>Show .info</em> hides or shows icon files. Copying or deleting a folder still takes everything in it.
        </p>
        <p>
          <strong>Keys.</strong> ↑ and ↓ move, Space picks, Enter opens, Backspace goes up, Tab switches pane, / filters,
          F5 copies, F6 moves, F7 makes a folder, F2 renames, Delete deletes.
        </p>
        <p>
          <strong>On a phone.</strong> One pane at a time: <em>Left</em> and <em>Right</em> at the top switch.{' '}
          <em>Copy to…</em> and <em>Move to…</em> ask where.
        </p>
        <GoodToKnow items={[
          'Settings › Account › Files sets the panes Files opens with, .info files, the Comment column, whether Delete asks first, and the answer when a name is already there.',
        ]} />
      </>
    ),
  },
  'stash-net': {
    title: 'STASH: and NET:',
    short: 'STASH: keeps loose files for 30 days: what you drop on the Files page and what your Amiga sends. NET: holds what waits to go to each board’s Amiga.',
    body: (
      <>
        <p>
          <strong>STASH:</strong> Drop files, folders, .lha or .zip on <em>Drop files into STASH:</em>, or paste a URL.
          Files your Amiga sends with Transfer land here too, marked with the board; files you dropped are marked{' '}
          <em>dropped</em>. Make folders, rename, protect and comment as on a disk.
        </p>
        <p>
          <strong>Archives.</strong> An .lha or .zip stays one file. <em>Open</em> shows what is inside, read-only; copy
          files out to use them.
        </p>
        <p>
          <strong>Disk images.</strong> <em>Add to library</em> makes an ADF, DSK, ADZ, DMS, DMZ or HFE file a library disk.
        </p>
        <p>
          <strong>NET:</strong> lists your boards on firmware 1.15.0 or newer. Copy files or folders into a board to send
          them to its Amiga: each waits there until Transfer takes it, marked waiting, sending, delivered or failed.
          Delete cancels a waiting file or clears a finished one. A board&apos;s row shows four digits of its key
          (<em>key AB12</em>), the digits Transfer shows.
        </p>
        <GoodToKnow items={[
          'STASH: holds up to 500 files or 256 MB for your organization, and keeps each file 30 days. A file can be 20 MB from your computer, 4 MB from the Amiga.',
          'Up to 4 MB a file, and 32 files or 16 MB waiting for one board.',
          'Nothing is copied out of NET:, and a copy into it leaves the original where it was.',
          'STASH: keeps no versions: a delete there cannot be undone.',
        ]} />
      </>
    ),
  },
```

Library topic (277 words today, cap 280): in "Adding disks." replace `or use <em>Add disks</em>.` with `or use <em>Add disks</em>, which also takes a URL.`; in "Pages." remove ` (under the list)` and `; switching views keeps it` (ending the sentence at "page 1."). Net −2 words.

- [ ] **Step 1: Write the failing tests** — in `topics.test.ts`: `IDS` gains `'files', 'stash-net'`; the groups test expects the lists above and `new Set(all).size` 21; add

```ts
describe('Files help (increment 4)', () => {
  it('files names the three places, copy and move, Shift after the drag starts, the strip, the filter, the keys and the phone', () => {
    const b = bodyText('files').replace(/\s+/g, ' ');
    for (const w of ['STASH:', 'NET:', 'LIBRARY:', 'Copy', 'Move', 'press Shift after the drag has started', 'Replace, Skip or Keep both',
      'one new version', 'Undo', 'eject', 'Protect', 'Info', 'filter box', 'Show .info', 'F5', 'F6', 'F7', 'F2', '/ filters',
      'Left', 'Right', 'Copy to…', 'Settings › Account › Files']) expect(b).toContain(w);
  });
  it('stash-net names the limits, archives, Add to library, the marks, sending by copy and the key digits', () => {
    const b = HELP_TOPICS['stash-net'].short + bodyText('stash-net').replace(/\s+/g, ' ');
    for (const w of ['30 days', '500 files', '256 MB', '20 MB', '4 MB', '32 files', '16 MB', 'read-only', 'Add to library',
      'dropped', 'marked with the board', '1.15.0', 'Delete cancels', 'key AB12', 'cannot be undone']) expect(b).toContain(w);
  });
  it('library says Add disks takes a URL', () => {
    expect(bodyText('library').replace(/\s+/g, ' ')).toContain('Add disks , which also takes a URL');
  });
  it('the new topics never say drive in their title or short (the help filter test pins drive to four topics)', () => {
    for (const id of ['files', 'stash-net'] as const) expect(HELP_TOPICS[id].title + HELP_TOPICS[id].short).not.toMatch(/drive/i);
  });
});
```

(`bodyText` turns `</em>,` into ` ,` — hence the space in the Library expectation.) In `pane.test.ts` add: `it('the ? names the device: stash-net in STASH:, files in a disk', …)` rendering `help: 'stash-net'` with `stashListing` → contains `data-testid="help-tip-stash-net"`.

- [ ] **Step 2: Run** `pnpm vitest run src/lib/help src/components/files/pane.test.ts` → FAIL.
- [ ] **Step 3: Implement** the text above, the groups, the guard removal, the page header, the zone's "?". e2e counts: in `e2e/c5-layout.spec.ts` every `19` that counts topics becomes `21` (lines ~317, 330, 333 `'4 of 21 topics'`, 341 `'0 of 21 topics'` and `'… to see all 21.'`, 346, 356 `'Topics · 21'`, 361 `'Topics · 4 of 21'`, 695); `e2e/c7-phone.mobile.spec.ts` (`'Topics · 21'`, both places); `e2e/help.spec.ts` "/help lists every topic" gains `'files', 'stash-net'`; the `help-browser.tsx` comment's "17" becomes "21".
- [ ] **Step 4: Run** `pnpm vitest run src/lib/help src/components && pnpm tsc --noEmit -p .` → PASS (also `match.test.ts`, unchanged: `drive` still four). Then `PORT=3100 bash scripts/e2e-local.sh e2e/help.spec.ts e2e/c5-layout.spec.ts --project=desktop -g "Help|help"` and `… e2e/c7-phone.mobile.spec.ts e2e/help.mobile.spec.ts --project=mobile` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/help/topics.tsx src/lib/help/topics.test.ts src/components/files/pane.tsx src/components/files/pane.test.ts \
  "src/app/(app)/files/page.tsx" src/components/files/stash-drop-zone.tsx src/components/help/help-browser.tsx \
  e2e/c5-layout.spec.ts e2e/c7-phone.mobile.spec.ts e2e/help.spec.ts
git commit -m "Help: Files and STASH: and NET: topics, Library takes a URL, a ? on each pane, the page and the STASH: zone"
```

---

### Task 8: Polish — deferred minors a person would notice

Each item: the ledger line, the one-line fix, the test. All in one task (each is a few lines; a reviewer judges them together).

**Files:**
- Modify: `src/lib/files/pane-rules.ts` (+ `pane-rules.test.ts`), `src/lib/files/net-rules.ts`, `src/lib/files/net-driver.ts`, `src/lib/files/words.ts` (+ `words.test.ts`), `src/lib/archive/dos-date.ts` (+ `archive-dates.test.ts`), `src/components/files/use-stash-upload.ts` (+ `use-stash-upload.test.ts`), `src/components/library/title-controls.tsx` (+ `src/components/library/empty-library.test.ts`), `src/components/files/files-manager.tsx`

**Interfaces:**
- Produces: `export const netEmpty = (path: string) => \`${path} is empty\`` in `net-rules.ts` (net-driver's two `` `${…} is empty` `` details use it); `addToLibraryReason` returns `'Already in the library'` when a picked row carries the `in the library` mark.

| # | Ledger line | Fix | Test |
|---|-------------|-----|------|
| P1 | inc 2 T7: "column Add to library not hidden for rows already in the library" | `addToLibraryReason`: after the archive check, `if (picked.some((e) => e.marks.includes('in the library'))) return 'Already in the library';` | `pane-rules.test.ts`: `addToLibraryReason(stash, [entry('Old.adf', { marks: ['in the library'] })])` → `'Already in the library'`; an un-added `.adf` → `null`. |
| P2 | inc 3 T1: "empty-file words" ("Not supported: x is empty.") | `words.ts` `unsupported`: `const empty = detail?.match(/^(.+) is empty$/); if (empty) return \`${detail} — nothing was sent.\`` (before the generic line); net-driver uses `netEmpty` | `words.test.ts`: `refusalWords('unsupported', netEmpty('mods/a.txt'))` → `'mods/a.txt is empty — nothing was sent.'` |
| P3 | inc 2 T3: "impossible DOS day (Feb 30) rolls over via Date.UTC instead of null" | `dos-date.ts`: `const at = new Date(Date.UTC(year, month - 1, day, h, m, s)); return at.getUTCDate() === day ? at : null;` | `archive-dates.test.ts`: `expect(dosDateTime(((1994 - 1980) << 9 \| 2 << 5 \| 30) << 16)).toBeNull();` and Feb 29 1996 (`(16 << 9 \| 2 << 5 \| 29) << 16`) → `'1996-02-29T00:00:00.000Z'`. |
| P4 | inc 2 T8: "'Uploading 0 of N' during hashing" | `uploadToStash`: the first progress is `Reading 0 of ${total}…`; in `send()`, after each new hash when `counted`, `progress(\`Reading ${++read} of ${total}…\`)`; "Uploading k of N…" only as PUTs settle | `use-stash-upload.test.ts`: `const seen: string[] = []; server(); await uploadToStash('STASH:', [file('a', 'x'), file('b', 'y')], 'ask', (w) => seen.push(w)); expect(seen[0]).toBe('Reading 0 of 2…'); expect(seen).toContain('Reading 2 of 2…'); expect(seen).toContain('Uploading 2 of 2…'); expect(seen).not.toContain('Uploading 0 of 2…');` |
| P5 | inc 3 T6: "collection-variant label 'Upload disks' vs 'Add disks'" | `title-controls.tsx` collection `action: 'Add disks'` | `empty-library.test.ts`: the collection test's `'Upload disks'` expectations become `'Add disks'` (its title renamed "…and an Add disks link"); add `expect(card).not.toContain('Upload disks')`. |
| P6 | inc 2 T9: "files-busy line ~24 px below the fold at 1280×800" | `files-manager.tsx`: the `files-busy` `<p>` gets `lg:order-first` and loses `lg:mt-auto` (the busy words sit above Copy, at the top of the column) | Task 9 e2e `at 1280×800 the busy line is on screen` (its box's bottom ≤ 800 with the page at the top). |
| P7 | inc 1 T10: "double-tap on a file row opens Info after pick/unpick" | `openRow(side, index, how: 'dblclick' \| 'key' = 'key')`: when `how === 'dblclick' && isPhone() && (e.kind === 'file')` return (a phone tap already picks; Info is under More); Pane's `onRowOpen` from `onDoubleClick` passes `'dblclick'` (add the parameter to `PaneProps.onRowOpen(index, how?)`) | Task 9 mobile e2e `at 390 a double tap on a file picks it and opens no Info`. |

- [ ] **Step 1: Write the failing tests** in the table (P6/P7 are written in Task 9's spec files now and run there).
- [ ] **Step 2: Run** `pnpm vitest run src/lib/files src/lib/archive src/components/files src/components/library` → FAIL on P1–P5.
- [ ] **Step 3: Implement** the fixes in the table.
- [ ] **Step 4: Run** the same command and `pnpm tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/files/pane-rules.ts src/lib/files/pane-rules.test.ts src/lib/files/net-rules.ts src/lib/files/net-driver.ts \
  src/lib/files/words.ts src/lib/files/words.test.ts src/lib/archive/dos-date.ts src/lib/archive/archive-dates.test.ts \
  src/components/files/use-stash-upload.ts src/components/files/use-stash-upload.test.ts src/components/library/title-controls.tsx \
  src/components/library/empty-library.test.ts src/components/files/files-manager.tsx src/components/files/pane.tsx
git commit -m "Files polish: Add to library refuses added disks, empty-file words, no Feb 30, Reading before Uploading, Add disks label, busy line on screen, no Info on a phone double tap"
```

---

### Task 9: End to end for increment 4

**Files:**
- Create/complete: `e2e/files-settings.spec.ts` (started in Task 5)
- Modify: `e2e/files.mobile.spec.ts`, `e2e/contrast.spec.ts`

Copy the module-local helpers of `e2e/files.spec.ts` (`seedTitle`, `openFiles`, `row`, `rowNames`, `toast`) as earlier increments did; set prefs through `PATCH /api/me/prefs` with the page's cookies (`page.request.patch('/api/me/prefs', { data: {...} })`), as `e2e/user-settings.spec.ts` does.

Tests (`e2e/files-settings.spec.ts`, desktop, 1280×800):
1. `the Files card saves each row and survives a reload` — `/settings`: `pref-files-left-NET`, `pref-files-on-clash-skip`, `pref-files-confirm-delete` click; `files-prefs-state` reads saved; reload: the three values stand; the side list has "Files" and `#files` focuses `files-heading`.
2. `the panes setting opens /files, also after Back` (Review Focus 2) — prefs `panes: { left: 'NET', right: 'STASH' }`; `/files` → `pane-left-dev-NET` and `pane-right-dev-STASH` pressed; navigate the right pane into a folder, `page.goBack()` → right pane back at `STASH:`, left still `NET:`; `/files?left=LIBRARY:` → left LIBRARY:, right STASH:.
3. `a filter that hides a picked file leaves it out of Delete` (Review Focus 1) — disk with `ReadMe` and folder `Tools`: pick both (ctrl-click), type `too` in `pane-right-filter` → `ReadMe` is not drawn and the foot starts `1 of 1 selected`; Delete → the confirm names only `Tools`; confirm → `ReadMe` still on the disk (DB read of the disk as `files.spec.ts`'s `stored()` does).
4. `the filter clears on another folder and keeps after a copy` — type a filter; copy a file in → the filter stays and the foot says `N of M shown`; open a folder → `pane-right-filter` is empty.
5. `/ focuses the filter; Escape clears it, then gives the keys back` — focus the manager, press `/` → `pane-<active>-filter` focused; type `x`, Escape → empty and still focused; Escape → `files-manager` focused; `ArrowDown` moves the row mark.
6. `Show .info hides icon files in both panes and is remembered` — two disks with `.info` files; `pane-left-show-info` off → both panes lose `.info` rows, foot `· N .info files hidden`; reload → still hidden; `/settings` → `pref-files-show-info` reads off.
7. `with Ask before deleting off, a disk delete runs at once with Undo; STASH: still asks` (Review Focus 4).
8. `with Skip set, a move onto a clash asks nothing and leaves the source` (Review Focus 5) — prefs `onClash: 'skip'`; `ReadMe` on both disks; Move → no `clash` dialog; the source disk still has `ReadMe`; the destination's `ReadMe` bytes unchanged.
9. `with Replace set, a STASH: drop onto a clash replaces without asking` — prefs `onClash: 'replace'`; `files-drop-stash` input with `ReadMe` twice (two drops, other bytes) → no clash dialog; the row's size is the second file's.
10. `Comment column: Always shows it on a disk, Never hides it in STASH:`.
11. `the ? on each pane names its device` — left STASH: → `pane-left` contains `help-tip-stash-net`; right a disk → `help-tip-files`; click it → `help-pop-files` with "Read the full topic" → `/help#files`.
12. `STASH: rows dropped from the computer say dropped` — drop a file into STASH: → its row shows the `dropped` mark.
13. `at 1280×800 the busy line is on screen` (P6) — `page.getByTestId('files-busy').boundingBox()` bottom ≤ 800 with `window.scrollY === 0`.

Phone (`e2e/files.mobile.spec.ts`, 390×844): `the filter fits a phone and filters the one pane` (`noSideways`, the filter box ≥ 44 px tall, `pane-<side>-show-info` ≥ 44 px); `at 390 a double tap on a file picks it and opens no Info` (P7).

Contrast (`e2e/contrast.spec.ts`, the Files block at line ~539): add pairs for the filter box text and placeholder, the Show .info label, the foot's "N of M shown", the `dropped` mark, and the Files settings card (labels, hints, the two switches on and off).

- [ ] **Step 1:** write the specs. **Step 2:** `PORT=3100 bash scripts/e2e-local.sh e2e/files-settings.spec.ts --project=desktop` → PASS (a failure is a defect in the owning task: fix it there). **Step 3:** `… e2e/files.mobile.spec.ts --project=mobile`; `… e2e/contrast.spec.ts --project=desktop -g "Files|Settings|settings"` → PASS. **Step 4:** commit:

```bash
git add e2e/files-settings.spec.ts e2e/files.mobile.spec.ts e2e/contrast.spec.ts
git commit -m "e2e: Files settings, the filter, Show .info, the pane ?, the dropped mark; phone and contrast"
```

---

### Task 10: The whole-feature e2e sweep

Increments 1–4 merge to master as one (increment-1 ruling). This is the "big cross-cutting branch" case: run every spec the feature touches, each run foreground and under 9 minutes, one at a time, `PORT=3100`. Fix only real regressions; a spec that also fails on master is recorded, not fixed here.

- [ ] **Step 1: Unit, DB, types, build.** `pnpm vitest run`; `pnpm test:db`; `pnpm tsc --noEmit -p .`; `pnpm build`; lint on changed files.
- [ ] **Step 2: Files.** (a) `e2e/files.spec.ts e2e/files-strip.spec.ts --project=desktop`; (b) `e2e/files-stash.spec.ts e2e/files-parity.spec.ts e2e/files-settings.spec.ts --project=desktop`; (c) `e2e/files-net.spec.ts e2e/disk-files-a5.spec.ts e2e/disk-files-edit.spec.ts e2e/disk-files-layout.spec.ts --project=desktop`; (d) `e2e/files.mobile.spec.ts e2e/files-net.mobile.spec.ts --project=mobile`.
- [ ] **Step 3: Library and sharing.** (e) `e2e/library-add.spec.ts e2e/library.spec.ts e2e/library-mount.spec.ts --project=desktop`; (f) `e2e/library-a3.spec.ts e2e/library-table.spec.ts e2e/library-paging.spec.ts e2e/library-multi-select.spec.ts --project=desktop`; (g) `e2e/library-covers.spec.ts e2e/library-type-column.spec.ts e2e/sharing.spec.ts e2e/sharing-owner.spec.ts --project=desktop`; (h) `e2e/library-add.mobile.spec.ts e2e/library-multi-select.mobile.spec.ts e2e/library-card-footer.mobile.spec.ts --project=mobile`.
- [ ] **Step 4: Send and the Amiga.** (i) `e2e/send-to-amiga.spec.ts e2e/device-send.spec.ts --project=desktop`; (j) `e2e/from-amiga.spec.ts --project=desktop`; plus every other spec increment 3 Task 8 converted (`rg -l "/files|STASH:|NET:|library-add" e2e`), batched under 9 minutes (split `tosec-scan` / `admin-scan` by `-g` as before).
- [ ] **Step 5: Help, contrast, phone, settings.** (k) `e2e/help.spec.ts e2e/c5-layout.spec.ts e2e/settings-tabs.spec.ts e2e/user-settings.spec.ts --project=desktop`; (l) `e2e/contrast.spec.ts --project=desktop`; (m) `e2e/c7-phone.mobile.spec.ts e2e/help.mobile.spec.ts e2e/mobile.spec.ts e2e/c8-drive-menu.mobile.spec.ts --project=mobile`.
- [ ] **Step 6: Known pre-existing failures.** `mobile.spec` "card held and dropped" fails on master 85d3fdb (increment-1 ledger); `disk-sets.spec.ts:1263`, `library-a3` "⋯ menu … neither navigate" and `library-table` "dragging a row onto a rail collection" were to be checked on master (increment-3 ledger): run each on a master worktree once; record the result; fix on this branch only those that pass on master.
- [ ] **Step 7: Commit** each fix with the task it belongs to named in the message; nothing else is committed in this task. The merge, migration 0051 on production (controller), HANDOFF §4 (increments 1–4 shipped, rulings, bench items) and the README screenshot regeneration (increment-1 ledger: `disk-files.png` alt text stale) follow the sweep.

---

## Not in this increment

Deferred minors from the three ledgers, left for later (each is invisible in normal use, a test-only gap, or larger than a polish line):

- Increment 1: length units in `amigaNameProblem` (moot); `putComment` hard-codes 328/80/79; replace rewrites the header twice; `replaceFile` resets protection (pre-existing); skipped item in a move reports ok (toast count); `'conflict'` type cast; nested selection in a move; per-disk all-or-nothing original delete; route casts and untested 413 limits; cleaned zip names not de-duplicated; `findHolder` N+1; root lists titles with no entitled disks; TOSEC confirm on comment save drops the typed comment on Cancel; dead `#files-heading` focus in drop-staging; no e2e for refused Undo; phone bar's DOM order; 4.5rem tab-bar height duplicated; `applySort` reads the render closure; `ranOp` focus leak; `IdentityConfirmDialog` lacks `finalFocus`.
- Increment 2: `remove(unchanged)` block self-compare; `lower(path)` under C-locale DBs; `moveStash` clears `sentName`; meta of deleted rows; failed stubs in `stashTree`; LHA level-2 Unix time 0 → 1970; archive member depth 32 vs 40 and colliding member names; archive listing cost (header-only metadata or a cache); sequential `addToLibrary`; `mustRemove` optional on drivers; oversized-blob release by size alone; `NOT_WHOLE` duplicated string; retry commit's 409 ignored; contrast selectors positional; dvh clamp hard-codes the zone height.
- Increment 3: bytes stored before a `queue_full` refusal (GC cleans); queue overfill race (`FOR UPDATE` on the device row); "N waiting" counts sending rows; `net-send` treats only `res.redirected` as signed out; a drop that queued nothing still reloads; `receiverLine` sending always false; the waiting count goes stale after the Amiga takes files; no component test of "Queued 3 of 5 — why"; `promote-release-button` repeats the signed-out literal; hook imports `FetchedRow` from `components/ingest`; overlapping Library drops' numbering; pipeline-refused images keyed by name; the dead `/api/uploads/**` and `/api/transfers/[id]` routes (operator decision pending).
- "NET: root words" (increment 3 Task 1): `refusalWords('read_only', NET_PICK_BOARD)` now reads "Open a board to send files to it." (increment 3 Task 2); Task 10 re-checks the NET: root pane's lines by eye and adds a fix only if something still reads wrong.
- The dual-pane file manager's live Amiga volumes under NET: and remote libraries under LIBRARY: (spec §12).

## After the last task

- HANDOFF §4: Files increments 1–4 shipped (merge hash), rulings R1–R10 of this plan with the earlier increments', the bench items (a Transfer RECEIVE taking a folder copied into NET:; a Transfer SEND landing in STASH: with the board mark).
- Tell the operator: R1 departs from the brief's "default off = hide" because the stored Browse default is "shown"; R2 keeps the confirm in STASH: and NET: with the setting off.
