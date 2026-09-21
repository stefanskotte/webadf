# Write-back piece 3: the time machine — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A disk's history is visible, browsable and reversible: every version listed with what
changed as files, any version browsable read-only, and any version restorable — refused while a
board holds the disk.

**Architecture:** The storage exists already (`src/lib/disk-history/`: `materialise()`, the delta
chain, `recordVersion()`). This plan adds a pure tree diff, a server-side history loader that
pairs each version with its file-level changes, a read-only mode for the existing file browser, a
restore route, and the History panel.

**Tech Stack:** Next.js App Router (server components + small client components), drizzle over
Neon, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md` §4 (and D2:
rewind adds a version, it never deletes history).

## Global Constraints

- **A restore is a new version, never a deletion** (spec D2): `recordVersion({ source: 'rewind',
  rewindOf: <seq> })` on top of the current head, so a mistaken restore is itself undoable.
- **Refused while the disk is mounted or desired by any device in the org**, through the same
  `findHolder` (`src/lib/disk-holder.ts`) that guards every other byte-changing path, answering
  409 `{ error: 'mounted', reason }` and offering an eject — the operator's rule: a mounted volume
  changes only from the Amiga side.
- The entitlement, not `disks.orgId`, is the tenancy boundary, exactly as `applyDiskEdit` and the
  files page do it: a disk outside the caller's entitlements answers 404, never 403.
- e2e runs against the LIVE production database: `@example.test` accounts via `signUpFresh`,
  seeded disks via `seedDisk`/`cleanupSeeded`. Set `PORT`/`BASE_URL` (e.g. `PORT=4000`) so a run
  cannot collide with another worktree's dev server.
- vitest: `pnpm vitest run`. e2e: `PORT=4000 pnpm exec playwright test <file>` in the FOREGROUND.
- Never `git add -A`; stage explicit paths. No `git stash`.

---

### Task 1: What changed, as files

**Files:**
- Create: `src/lib/disk-history/diff.ts`
- Test: `src/lib/disk-history/diff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TreeChange { path: string; kind: 'added' | 'changed' | 'removed'; isDir: boolean }
  /** Newest-first callers pass (before, after). Paths are root-relative, '/' separated. */
  export function diffTrees(before: readonly AdfEntry[], after: readonly AdfEntry[]): TreeChange[];
  /** One line for a version whose disks have no readable filesystem. */
  export function sectorSummary(sectorCount: number): string;
  ```
- Consumes: `AdfEntry` from `@/lib/adffs`.

Rules, from the spec: added, changed or removed, compared by path. A file counts as **changed**
when its size, modification time or block differs. A directory appears only when it is added or
removed (its contents are reported as their own paths). Order: removed, then changed, then added,
each alphabetical by path, so two runs over the same pair always read the same.

- [ ] **Step 1: Write the failing test** — `src/lib/disk-history/diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffTrees, sectorSummary } from './diff';
import type { AdfEntry } from '@/lib/adffs';

const file = (name: string, sizeBytes = 10, block = 100): AdfEntry => ({
  name, kind: 'file', block, sizeBytes, modifiedAt: new Date(0), protection: '----rwed',
  comment: null, children: [],
});
const dir = (name: string, children: AdfEntry[], block = 200): AdfEntry => ({
  name, kind: 'dir', block, sizeBytes: 0, modifiedAt: new Date(0), protection: '----rwed',
  comment: null, children,
});

describe('diffTrees', () => {
  it('finds nothing between identical trees', () => {
    const t = [file('A'), dir('D', [file('B')])];
    expect(diffTrees(t, t)).toEqual([]);
  });

  it('reports an added file by its full path', () => {
    expect(diffTrees([dir('D', [])], [dir('D', [file('NEW')])]))
      .toEqual([{ path: 'D/NEW', kind: 'added', isDir: false }]);
  });

  it('reports a removed file, and a removed directory as one entry', () => {
    const before = [dir('D', [file('B')]), file('A')];
    expect(diffTrees(before, [file('A')])).toEqual([
      { path: 'D', kind: 'removed', isDir: true },
      { path: 'D/B', kind: 'removed', isDir: false },
    ]);
  });

  it('calls a file changed when its size, its date or its block moved', () => {
    expect(diffTrees([file('A', 10)], [file('A', 20)])[0].kind).toBe('changed');
    const moved = { ...file('A'), block: 999 };
    expect(diffTrees([file('A')], [moved])[0].kind).toBe('changed');
    const touched = { ...file('A'), modifiedAt: new Date(5_000) };
    expect(diffTrees([file('A')], [touched])[0].kind).toBe('changed');
  });

  it('is stable: removed, then changed, then added, each alphabetical', () => {
    const before = [file('GONE'), file('SAME', 1), file('EDIT', 1)];
    const after = [file('SAME', 1), file('EDIT', 2), file('ADDED')];
    expect(diffTrees(before, after).map((c) => `${c.kind}:${c.path}`))
      .toEqual(['removed:GONE', 'changed:EDIT', 'added:ADDED']);
  });

  it('treats a name that changed kind as a removal and an addition', () => {
    const changes = diffTrees([file('X')], [dir('X', [])]);
    expect(changes.map((c) => c.kind).sort()).toEqual(['added', 'removed']);
  });

  it('summarises sectors for a disk with no readable filesystem', () => {
    expect(sectorSummary(1)).toBe('1 sector changed');
    expect(sectorSummary(12)).toBe('12 sectors changed');
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm vitest run src/lib/disk-history/diff.test.ts`;
expected: cannot resolve `./diff`.

- [ ] **Step 3: Implement `src/lib/disk-history/diff.ts`.** Walk both trees into
`Map<path, AdfEntry>` (a directory contributes its own path and its children's), then compare the
key sets. A path in both whose `kind` differs is a removal plus an addition. Sort as the test
requires. `sectorSummary` pluralises on 1.

- [ ] **Step 4: Run the tests** — that file passes, then `pnpm vitest run` all green and
`pnpm exec tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/disk-history/diff.ts src/lib/disk-history/diff.test.ts
git commit -m "disk history: what changed between two versions, as files

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The history a page can render

**Files:**
- Create: `src/lib/disk-history/history.ts`
- Test: `src/lib/disk-history/history.test.ts`

**Interfaces:**
- Consumes: `loadEntries` (`./store`), `materialise` + `VersionEntry` (`./chain`), `diffTrees`,
  `sectorSummary` (Task 1), `readVolume` (`@/lib/adffs`), `diskStore` (`@/lib/storage`).
- Produces:
  ```ts
  export interface HistoryVersion {
    seq: number;
    kind: 'snapshot' | 'delta';
    source: 'original' | 'browser' | 'amiga' | 'rewind';
    /** "Amiga: Bench board", "Edited in browser", "Restored to version 3", "As uploaded". */
    label: string;
    createdAt: Date;
    imageSha256: string;
    sectorCount: number;
    rewindOf: number | null;
    /** Empty when nothing changed as files, or when neither side has a filesystem. */
    changes: TreeChange[];
    /** Set instead of `changes` when a tree could not be read: "12 sectors changed". */
    sectorNote: string | null;
    isHead: boolean;
  }
  export async function loadHistory(diskId: string, deviceNames: ReadonlyMap<string, string>): Promise<HistoryVersion[]>;
  ```
  Newest first. `deviceNames` maps device id to name so the loader does no queries of its own
  beyond `loadEntries`.

Notes for the implementer:
- Materialising is not free: each version is up to 880 KB plus its delta chain. Materialise each
  version ONCE, walking oldest to newest, keep only the previous image in memory, and compare
  consecutive pairs. Version 0 has no predecessor: its `changes` are empty and its label is
  "As uploaded".
- A version whose image or whose predecessor has no readable filesystem (`readVolume().ok ===
  false`) gets `sectorNote = sectorSummary(sectorCount)` and no `changes` — the spec's fallback.
- `materialise` can throw `HistoryError` (a broken chain). Let it: the page decides what to show,
  and a silent empty history would hide a real fault.

- [ ] **Step 1: Write the failing test** — `src/lib/disk-history/history.test.ts`. Build real
images with `formatVolume` and `addFile` from `@/lib/adffs` (see `src/lib/disk-history/store.test.ts`
for how that file fakes `diskStore`), record three versions (original, a browser edit adding
HELLO, an amiga version adding SECOND), then assert: newest first; labels ("Amiga: Bench board"
for a version whose `deviceId` is in the map, "Edited in browser", "As uploaded"); version 0 has
no changes; the browser version reports `added: HELLO`; `isHead` is true only for the newest; and
a version built from an image with no filesystem reports `sectorNote` instead of `changes`.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `loadHistory`.**

- [ ] **Step 4: Run the tests** — the file passes, `pnpm vitest run` green, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/disk-history/history.ts src/lib/disk-history/history.test.ts
git commit -m "disk history: one list a page can render, with each version's file changes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Browsing a version, read-only

**Files:**
- Modify: `src/app/(app)/disks/[id]/files/page.tsx`
- Modify: `src/components/disks/file-actions.tsx` (only if needed to disable editing; read it first)
- Test: `e2e/time-machine.spec.ts` (created in Task 6; this task only needs the page to work)

**Interfaces:**
- Consumes: `materialise`, `loadEntries`.
- Produces: `/disks/<id>/files?version=<seq>` renders that version's tree **read-only**.

Rules:
- Without `?version=`, the page is exactly what it is today. With it, the page materialises that
  version instead of reading the head blob, and renders the same `VolumeHeader`/`FileTree`.
- Read-only means: no drop staging, no file toolbar, no rename/delete/new-folder actions. The
  existing page already computes an `EditDisabled` reason for a mounted disk — reuse that
  mechanism with a new reason rather than inventing a second way to disable editing.
- A banner says which version is being shown and links back to the current one. Give it
  `data-testid="version-banner"` and the seq in `data-version`.
- An unknown, non-numeric or out-of-range `version` is a 404 (`notFound()`), never a silent
  fallback to the head: a URL that says version 3 must never show version 7.
- Downloads of a file from an old version must serve THAT version's bytes. Check how the file
  download route is addressed (`src/app/(app)/disks/[id]/files/...` or an API route) and make it
  version-aware, or — if that is a larger change than it looks — disable per-file download while
  browsing a version and say so in the report rather than serving the wrong bytes.

- [ ] **Step 1:** Read the page and the file-actions component; write down (in the report) how
editing is currently disabled for a mounted disk, and which route serves a file's bytes.
- [ ] **Step 2:** Implement the version-aware page.
- [ ] **Step 3:** `pnpm exec tsc --noEmit` clean, `pnpm vitest run` green, `pnpm build` clean.
- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/disks/[id]/files/page.tsx"
git commit -m "disk files: browse any version read-only, with a banner that says which

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Restore

**Files:**
- Create: `src/app/api/disks/[id]/restore/route.ts`
- Create: `src/lib/disk-history/restore.ts`
- Test: `src/lib/disk-history/restore.test.ts`

**Interfaces:**
- Consumes: `materialise`, `loadEntries`, `recordVersion`, `findHolder`, `mountedReason`,
  `repointLateMounts`, `diskStore`, `requireOrg`.
- Produces:
  ```ts
  export type RestoreOutcome =
    | { ok: true; sha256: string; seq: number }
    | { ok: false; status: number; reason: string };
  export async function restoreVersion(orgId: string, diskId: string, seq: number, userId: string | null): Promise<RestoreOutcome>;
  ```
  `POST /api/disks/[id]/restore` with `{ "seq": <number> }` → 200 `{ sha256, seq }`,
  400 `{ error: 'invalid_body' }`, 404 (not entitled, unknown disk, unknown seq),
  409 `{ error: 'mounted', reason }`, 409 `{ error: 'conflict' }` (the head moved under us).

`restoreVersion` follows `applyDiskEdit`'s shape exactly, because the rules are the same ones:
1. Resolve the disk through the ENTITLEMENT join; 404 if it is not this org's.
2. `findHolder` first — before anything is read or written — and 409 `mounted` if a board holds
   or wants it. Spec §4: "Refused while the disk is mounted or desired by a device."
3. `materialise` the target seq. An unknown seq is a 404; a broken chain (`HistoryError`) is a
   500 with the reason logged, not a silent empty restore.
4. Restoring the head, or any version whose image already equals the head, changes nothing:
   return ok with the current sha and the current seq, record NO version. (`recordVersion`
   already returns null for a no-op; do not turn that into a fake new version.)
5. `recordVersion({ source: 'rewind', rewindOf: seq, ... })` on top of the CURRENT head, so
   history only grows (D2). A `StaleHeadError` is 409 `conflict`.
6. `repointLateMounts` afterwards, exactly as `applyDiskEdit` does, for a board that asked for
   the disk between step 2 and step 5.

- [ ] **Step 1: Write the failing test** — `src/lib/disk-history/restore.test.ts`, modelled on
`store.test.ts`'s fakes. Cover: restoring an older version records a `rewind` version whose image
equals the older one and whose `rewindOf` is that seq; the head moves; history grew rather than
shrank (the intermediate versions are still there); restoring the head records nothing and answers
ok; an unknown seq is 404; a held disk is 409 `mounted` and records nothing; a `StaleHeadError`
surfaces as 409 `conflict`.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `restore.ts`, then the route.** The route parses `{ seq }` with zod (see
a neighbouring route for the house style), calls `requireOrg()`, then `restoreVersion`, and maps
the outcome to the statuses above. `export const dynamic = 'force-dynamic'`.

- [ ] **Step 4: Run the tests** — the file passes, `pnpm vitest run` green, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/disk-history/restore.ts src/lib/disk-history/restore.test.ts "src/app/api/disks/[id]/restore/route.ts"
git commit -m "disk history: restore records a rewind version, and is refused while a board holds the disk

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The History panel

**Files:**
- Create: `src/components/disks/history-panel.tsx`
- Modify: `src/app/(app)/disks/[id]/files/page.tsx` (render the panel under the tree)

**Interfaces:**
- Consumes: `HistoryVersion` (Task 2), the restore route (Task 4).
- Produces: a panel listing versions newest first. Each row carries
  `data-testid="version-<seq>"`, shows the label and the time, lists its changes (a removed/
  changed/added marker per path, or the sector note), and offers **Browse** (a link to
  `?version=<seq>`) and **Restore** (absent on the head).

Rules:
- Restore asks first (the same confirm pattern the delete dialog uses — read
  `src/components/library/delete-disk-dialog.tsx` and follow it), then POSTs and
  `router.refresh()`es.
- A 409 `mounted` is shown as the refusal text the server sent, beside an **Eject** action that
  goes to the devices page — spec §4's "Eject to restore". Do not invent an eject here: the
  disk page already knows how to say this for a mounted disk (`ejectMessage`/`mountedReason`),
  so reuse that wording.
- Long histories: show the newest 20 with a "show all" toggle, so a disk written a hundred times
  does not render a hundred materialised diffs. (The loader still materialises everything —
  see Task 2's note; if that proves slow on a real disk, say so in the report rather than
  changing the shape here.)
- The panel is client-side only for the actions; the list itself is server-rendered.

- [ ] **Step 1:** Implement the panel and wire it into the page.
- [ ] **Step 2:** `tsc` clean, `pnpm vitest run` green, `pnpm build` clean.
- [ ] **Step 3: Commit**

```bash
git add src/components/disks/history-panel.tsx "src/app/(app)/disks/[id]/files/page.tsx"
git commit -m "disk page: a History panel -- what changed, browse it, restore it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: e2e, including the acceptance deferred from piece 2b

**Files:**
- Create: `e2e/time-machine.spec.ts`

**Interfaces:**
- Consumes: `signUpFresh`, `runTag` (`e2e/helpers.ts`); `pairDevice`, `seedDisk`, `authHeader`,
  `cleanupSeeded` (`e2e/device-helpers.ts`); the file-edit routes the existing
  `e2e/disk-files-edit.spec.ts` uses to change a disk through the UI.

Tests (each must fail if its feature is removed — say so in the report):
1. **History lists what changed.** Upload a file through the UI, then a second: the panel shows
   three versions newest first, the newest reporting `added` for the second file, and version 0
   labelled as uploaded.
2. **Browse shows the old tree, read-only.** Open `?version=<first>`: the second file is absent,
   the banner names the version, and no edit control is offered.
3. **Restore brings the old content back, as a NEW version.** Restore version 1: the file added
   in version 2 is gone from the disk, the history now has FOUR entries (nothing was deleted),
   and the newest says it restored version 1.
4. **Restore is refused while a board holds the disk** (spec §4, and 2b's acceptance 4): pair a
   device, mount the disk, and assert the restore route answers 409 `mounted` and the head is
   unchanged; then eject and assert the same restore succeeds.
5. **Another tenant gets 404** from the restore route and from `?version=` on someone else's disk.

- [ ] **Step 1:** Write the spec.
- [ ] **Step 2:** Run it: `PORT=4000 pnpm exec playwright test e2e/time-machine.spec.ts --reporter=line`
(FOREGROUND; `lsof -iTCP:4000 -sTCP:LISTEN` empty first; kill :4000 after; wait for the
`teardown:` line before any further run).
- [ ] **Step 3: Commit**

```bash
git add e2e/time-machine.spec.ts
git commit -m "e2e: the time machine -- history, browse, restore, and refused while mounted

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
