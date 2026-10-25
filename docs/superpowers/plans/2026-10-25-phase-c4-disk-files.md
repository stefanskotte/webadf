# Phase C4 Disk files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The disk page (`/disks/[id]/files`) takes the approved ModernDiskFiles layout — the breadcrumb, the Disk card
(disk, h1, facts, space meter, drive cluster), the amber version banner, the Files card (header, selection strip,
column grid, ⋯ row menu, footer), the drop bar, and the History aside with collapsible versions and one restore
confirm — with every A5 / time-machine / staging behaviour, guard, route and request body kept.

**Architecture:** Presentation and wiring on Phase B's tokens and C1–C3's pieces. Pure look rules in a new
`src/lib/disk-files-look.ts`. New components: `disk-card.tsx`, `version-banner.tsx`, `files-card.tsx` (the Files
card shell), `file-row-menu.tsx` (Base UI menu, C1's title-menu pattern), `restore-dialog.tsx` (`RestoreProvider`, the
one confirm). `file-tree.tsx`, `file-actions.tsx`, `selection-bar.tsx`, `protection-editor.tsx`, `drop-staging.tsx`,
`history-panel.tsx` and the page are restyled and re-placed; `volume-header.tsx` is deleted once unused. No schema, no
migration, no new route, no new package; `FileEditProvider`'s gate and every request are untouched.

**Tech Stack:** Next.js 16.3.2 App Router (read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`
before Task 7's `loading.tsx`, and `.../03-file-conventions/page.md` for `PageProps` before Task 2's page edit),
React 19, Tailwind v4, Base UI 1.7 (`@base-ui/react/menu`), dnd-kit 6, vitest (`renderToStaticMarkup` render tests),
Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-10-25-phase-c4-disk-files-design.md`

## Global Constraints

- Texts, test ids and orders exactly as the spec writes them; every id in spec §10.1 must still resolve (once per page,
  once per row for `<block>` ids, once per version for `<seq>` ids); ids move only as spec §10.4 says.
- Same routes and request bodies (spec §0). `FileEditProvider.runEdit`, the identity confirm, `DropStaging`'s pipeline
  (`readDroppedItems`, `expandArchivesInDrop`, `stageDrop`, the batch manifest), `SelectionBar`'s bulk bodies, the
  restore body `{seq}` and Undo's `{seq: seq-1, ifHead: seq}` keep their logic.
- **The write guard is not weakened.** `disabled: EditDisabled | null` is still computed by the page in the same
  priority (historical > mounted > no-filesystem > bitmap-untrusted) and still disables every edit control through
  `useFileEdit()`; a menu item or button that edits is `disabled={!!editDisabled}`; Restore… and Restore this
  version are disabled while a board holds the disk; Download/Send stay withdrawn while historical. Never remove a
  server-side check.
- **No DB migration.** If a task believes one is needed, STOP and report: the controller migrates production; a
  subagent never runs `drizzle-kit` or writes under `drizzle/`.
- Colours only through tokens (Phase B §4, C1–C3's, this spec's six in Task 1) or `disk-files-look.ts`; no
  `#7A7262` / `#A39B8B` / `#C9C0AE` / `#8A8172` text (they are `--muted-2`). `DiskIcon` is the only literal-colour
  drawing.
- "Show both values of a state": every state renders a word in each value (drive light + holder words, Hide .info
  switch position, protection `-` vs letter, Current / Viewing, disabled reasons, free space known/unknown); no
  `sr-only` element carries a width or layout utility (`upload-input` gets `sr-only` and nothing else).
- WCAG AA 4.5:1 for every text pair in spec §11, pinned in `design-tokens.test.ts` and measured on the page in
  `contrast.spec.ts`. Keyboard: every control reachable by Tab; the row menu opens with Enter/Space and arrows move in
  it (Base UI); focus never falls to `<body>` (spec §9).
- Nothing overflows at 390 px (`document.documentElement.scrollWidth <= clientWidth`); the full phone pass is C7.
- In-app dialogs only (`restore-dialog`, `identity-confirm-dialog`, the inline confirms); never `window.confirm` /
  `alert`.
- Self-host parity: no new package, no external URL, no font, no our-deployment-only path.
- Firmware, `wifi-floppy/`, the board and the Amiga are not touched.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): real `pnpm install --offline`, `.env.local` (never
  print it), `npx next typegen`, the `adf-archive` symlink.
- House rules, every task: stage files by name (never `git add -A`, never anything under `wifi-floppy/`), no `git
  stash` in any form; stop only your own PIDs, never pattern-kill; e2e with `PORT=3100`, desktop project unless a
  step says mobile, ONE run at a time, each command under 9 minutes (split with `-g`), in the foreground; the e2e DB
  is the live production DB shared with other runs, so assert relative to rows you made (fresh sign-ups, run tags,
  blocks read back from the disk), never absolute counts; whole `pnpm test` green before each commit; no commit after
  a red run; commit trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`.
- **Known pre-existing e2e failures:** `mobile.spec.ts:455` and `time-machine.spec.ts:212` / `:268` are THIS area's
  (Tasks 5 and 6 fix them; until then record their result and move on); `display-layout.spec.ts:287` is not this area
  (not run here); `help.spec` "Enter opens the ?" is order-dependent (a flake: rerun that test alone once before
  reporting it).

## Review Focus

1. Every spec §10.1 id resolves; `fs-download/-send/-rename/-move/-delete-<block>` are items of `fs-row-menu`; `fs-protect-<block>`'s text is the eight-letter protection string; `fs-hide-info` is `role="switch"` with `aria-checked`; one h1 on the page.
2. Behaviour and the guard unchanged: the same requests (routes and bodies), every edit control disabled by `EditDisabled`, Restore… / Restore this version disabled while held, Download/Send withdrawn while historical, the identity confirm still intercepts the first edit of a matched disk.
3. Every state shown in words in both values (drive light, switch, protection `-`, Current/Viewing, disabled reasons, free space unknown); focus never to `<body>` after a delete, bulk action, commit or restore.
4. Layout: the row grid only from `md`, the two-line card below; two columns only from `xl`; names wrap (no ellipsis); nothing overflows at 390 px; the drop bar in flow under the Files card.
5. e2e assertions stay relative to rows the test made on the shared production DB; runs serialised, on PORT=3100, each under 9 minutes; the three area reds are fixed with root causes written in the commit message.

## Common commands

- Unit: `pnpm test <path>`; all: `pnpm test`; types: `npx tsc --noEmit`; lint: `pnpm lint`.
- e2e desktop: `PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<title part>"]`.
- e2e mobile: `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "<title part>"`.
- Screenshots: `PORT=3100 pnpm screenshots` (own config, own demo account; Task 7 only).
- The `-g` patterns and counts below are taken from the current titles and the tests this plan adds, but they are
  starting points: before running, check with `npx playwright test e2e/<name>.spec.ts --list [-g "<pattern>"]` that the
  pattern selects what the task needs, that the count is what the step says, and that a file split into several runs
  is covered whole. If a count differs, recount with `--list` before calling it a failure.

## File map

| File | Task | What |
|---|---|---|
| `src/lib/disk-files-look.ts` + `.test.ts` | 1 | new: `entryGlyph`, `protectionChips`, `infoCompanions`, `countInfo`, `countTree`, `changeCounts`, `driveLight`, `driveBadge`, `densityPill`, `openByDefault`, `formatKb`, `plural` |
| `src/app/globals.css`, `src/lib/design-tokens.test.ts` | 1 | six tokens; spec §11 pairs |
| `src/components/ui/menu-item-look.ts` + `.test.ts`, `src/components/library/title-menu.tsx` | 1 | `MENU_ITEM` moved to the shared look |
| `src/components/disks/disk-card.tsx` + `disk-card.test.ts` | 2 | new: the Disk card |
| `src/components/disks/version-banner.tsx` | 2, 5 | new: the banner (Restore this version in 5) |
| `src/app/(app)/disks/[id]/files/page.tsx` | 2, 3, 5, 6 | frame, query, grid, providers |
| `src/components/disks/volume-header.tsx` | 2 | deleted |
| `src/components/disks/files-card.tsx` | 3 | new: the Files card shell |
| `src/components/disks/file-actions.tsx` | 3 | `FileToolbar` restyle (Add file / New folder), identity dialog restyle |
| `src/components/disks/selection-bar.tsx` | 3 | ink strip |
| `src/components/disks/file-tree.tsx` | 3, 4 | header controls, list, footer; the row grid |
| `src/components/disks/file-row-menu.tsx` | 4 | new: the ⋯ menu |
| `src/components/disks/protection-editor.tsx` | 4 | restyle, focus |
| `src/components/disks/restore-dialog.tsx` | 5 | new: `RestoreProvider`, `useRestore`, the confirm |
| `src/components/disks/history-panel.tsx` | 5 | the aside, collapsible versions |
| `src/components/disks/drop-staging.tsx` | 6 | the bar, staging list restyle |
| `src/app/(app)/disks/[id]/files/loading.tsx` + `loading.test.ts` | 7 | new skeleton |
| `src/lib/help/topics.tsx` | 4, 5 | `send`, `write-back` |
| `e2e/helpers.ts` | 4, 5 | `openRowMenu`, `openVersion` |
| `e2e/disk-files-layout.spec.ts` | 2–6 | new tests |
| `e2e/adf-browser`, `disk-files-edit`, `hd-disks`, `disk-drag-drop`, `send-to-amiga`, `mobile`, `time-machine` `.spec.ts` | 4–6 | spec §10.4 |
| `e2e/contrast.spec.ts`, `e2e/screenshots.shots.ts` | 7 | Disk files pairs; the `disk-files` shot |

---

### Task 1: Look rules, tokens and the shared menu item look (no visible change)

**Files:**
- Create: `src/lib/disk-files-look.ts`, `src/lib/disk-files-look.test.ts`
- Modify: `src/app/globals.css` (webadf `:root`, after `--from-amiga-fg`), `src/lib/design-tokens.test.ts`
- Modify: `src/components/ui/menu-item-look.ts` (+ `MENU_ITEM`), `src/components/ui/menu-item-look.test.ts`,
  `src/components/library/title-menu.tsx` (import `MENU_ITEM`, delete its local `ITEM` — no rendered change)
- Modify: `src/components/disks/volume-header.tsx` (import `formatKb`, `countTree` from the look file; delete its
  local copies — no rendered change)

**Interfaces:**
- Consumes: `AdfEntry` (`@/lib/adffs`), `TreeChange` (`@/lib/disk-history/diff`), `HistoryVersion`
  (`@/lib/disk-history/history`), `MountChoice` (`@/lib/mount-choice`), `PROTECTION_FLAGS` (`@/lib/protection-bits`),
  `MENU_ITEM_HIGHLIGHT`.
- Produces: `entryGlyph(e: Pick<AdfEntry,'kind'|'name'>) → { label: string; bg: string; fg: string }`,
  `protectionChips(p: string) → { letter: string; on: boolean; label: string }[]`,
  `infoCompanions(entries: AdfEntry[]) → Set<number>`, `countTree(entries) → { files: number; dirs: number }`,
  `changeCounts(changes: TreeChange[]) → { added: number; changed: number; removed: number }`,
  `driveLight(choices: MountChoice[]) → 'in' | 'moving' | 'stale' | 'none'`,
  `driveBadge(choices: MountChoice[]) → 'DF0' | 'DF1' | null`, `densityPill(rootBlock: number, sizeBytes: number) →
  string`, `openByDefault(versions: HistoryVersion[], viewingSeq: number | null) → Set<number>`,
  `formatKb(bytes: number) → string`, `plural(n: number, one: string) → string`,
  `countInfo(entries: AdfEntry[]) → number` (every `*.info` in the tree); `MENU_ITEM: string`; tokens `--dir-bg`, `--exe-bg`, `--exe-fg`,
  `--viewing-bg`, `--warning-line`, `--on-ink-fill`.

- [ ] **Step 1: Write the failing tests**

`src/lib/disk-files-look.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  entryGlyph, protectionChips, infoCompanions, countInfo, countTree, changeCounts, driveLight, driveBadge, densityPill,
  openByDefault, formatKb, plural,
} from '@/lib/disk-files-look';
import type { AdfEntry } from '@/lib/adffs';
import type { MountChoice } from '@/lib/mount-choice';
import type { HistoryVersion } from '@/lib/disk-history/history';

const f = (name: string, block: number, o: Partial<AdfEntry> = {}): AdfEntry => ({ name, kind: 'file', block,
  sizeBytes: 1, modifiedAt: null, protection: '----rwed', comment: null, children: [], ...o });
const d = (name: string, block: number, children: AdfEntry[] = []): AdfEntry => f(name, block, { kind: 'dir', children });
const choice = (o: Partial<MountChoice>): MountChoice => ({ id: 'b1', name: 'Bench', state: 'empty', holding: null,
  isThisDisk: false, action: 'mount', actionLabel: 'Mount', revertDiskId: null, df1: null, df1Held: false,
  df1Stale: false, ...o }) as MountChoice;
const v = (seq: number, isHead = false): HistoryVersion => ({ seq, isHead, label: 'Edited in browser',
  createdAt: new Date(0), changes: [], sectorNote: null }) as unknown as HistoryVersion;

describe('entryGlyph (spec §5.5, Ruling 14)', () => {
  it.each([
    [d('C', 1), 'DIR', 'var(--dir-bg)', 'var(--accent-blue)'],
    [f('Disk.info', 2), 'ICN', 'var(--track)', 'var(--muted-2)'],
    [f('ReadMe.info', 3), 'ICN', 'var(--track)', 'var(--muted-2)'],
    [f('notes.TXT', 4), 'TXT', 'var(--track)', 'var(--muted)'],
    [f('ReadMe', 5), 'TXT', 'var(--track)', 'var(--muted)'],
    [f('wbconfig.prefs', 6), 'TXT', 'var(--track)', 'var(--muted)'],
    [f('SetPatch', 7), 'EXE', 'var(--exe-bg)', 'var(--exe-fg)'],
    [f('.hidden', 8), 'EXE', 'var(--exe-bg)', 'var(--exe-fg)'],
    [f('tune.mod', 9), 'MOD', 'var(--track)', 'var(--muted)'],
    [f('archive.lha', 10), 'LHA', 'var(--track)', 'var(--muted)'],
    [f('dos.library', 11), 'LIB', 'var(--track)', 'var(--muted)'],
  ] as const)('%o → %s', (e, label, bg, fg) => {
    expect(entryGlyph(e)).toEqual({ label, bg, fg });
  });
});

describe('protectionChips (Ruling 13)', () => {
  it('is eight chips in h s p a r w e d order, set by the string', () => {
    const c = protectionChips('-s--rwe-');
    expect(c.map((x) => x.letter).join('')).toBe('hsparwed');
    expect(c.map((x) => (x.on ? x.letter : '-')).join('')).toBe('-s--rwe-');
    expect(c[0].label).toBe('Hidden');
  });
});

describe('infoCompanions (Ruling 15)', () => {
  it('marks an entry whose .info sits beside it, at every level, case-insensitively', () => {
    const tree = [d('Prefs', 1, [f('Presets', 4), f('presets.INFO', 5)]), f('Prefs.info', 2), f('Disk.info', 3)];
    expect([...infoCompanions(tree)].sort()).toEqual([1, 4]);
  });
});

describe('countTree / changeCounts / formatKb', () => {
  it('counts .info files at every level', () => {
    expect(countInfo([d('A', 1, [f('x.info', 2)]), f('A.info', 3), f('y', 4)])).toBe(2);
  });
  it('counts the whole tree', () => {
    expect(countTree([d('A', 1, [f('x', 2), d('B', 3, [f('y', 4)])]), f('z', 5)])).toEqual({ files: 3, dirs: 2 });
  });
  it('counts changes by kind', () => {
    expect(changeCounts([{ path: 'a', kind: 'added', isDir: false }, { path: 'b', kind: 'added', isDir: true },
      { path: 'c', kind: 'removed', isDir: false }])).toEqual({ added: 2, changed: 0, removed: 1 });
  });
  it('rounds to KB', () => { expect(formatKb(2048)).toBe('2 KB'); expect(formatKb(899_072)).toBe('878 KB'); });
  it('plurals', () => { expect(plural(1, 'folder')).toBe('1 folder'); expect(plural(0, 'file')).toBe('0 files');
    expect(plural(2, '.info file')).toBe('2 .info files'); });
});

describe('driveLight / driveBadge (spec §2, the holderText ranking)', () => {
  it('none, stale, moving, in', () => {
    expect(driveLight([choice({})])).toBe('none');
    expect(driveLight([choice({ isThisDisk: true, state: 'stale' })])).toBe('stale');
    expect(driveLight([choice({ isThisDisk: true, state: 'pending' })])).toBe('moving');
    expect(driveLight([choice({ isThisDisk: true, state: 'converged' })])).toBe('in');
    expect(driveLight([choice({ df1: { isThisDisk: true } as MountChoice['df1'], df1Held: true })])).toBe('in');
    expect(driveLight([choice({ df1: { isThisDisk: true } as MountChoice['df1'] })])).toBe('moving');
    expect(driveLight([choice({ df1: { isThisDisk: true } as MountChoice['df1'], df1Stale: true })])).toBe('stale');
  });
  it('the badge names the drive that confirmed it', () => {
    expect(driveBadge([choice({ isThisDisk: true, state: 'converged' })])).toBe('DF0');
    expect(driveBadge([choice({ df1Held: true })])).toBe('DF1');
    expect(driveBadge([choice({ isThisDisk: true, state: 'pending' })])).toBeNull();
  });
});

describe('densityPill / openByDefault', () => {
  it('HD from the root block, else from the size', () => {
    expect(densityPill(1760, 0)).toBe('HD · 1.76 MB');
    expect(densityPill(880, 901_120)).toBe('DD · 880 KB');
    expect(densityPill(880, 1_802_240)).toBe('HD · 1.76 MB');
  });
  it('opens the head and the version on screen', () => {
    const vs = [v(3, true), v(2), v(1), v(0)];
    expect([...openByDefault(vs, null)]).toEqual([3]);
    expect([...openByDefault(vs, 1)].sort()).toEqual([1, 3]);
    expect([...openByDefault([], null)]).toEqual([]);
  });
});
```

`src/components/ui/menu-item-look.test.ts` — append:

```ts
import { MENU_ITEM } from './menu-item-look';
describe('MENU_ITEM (C4 Task 1: moved from title-menu.tsx, unchanged)', () => {
  it('is the 44 px / 36 px item with the shared highlight', () => {
    expect(MENU_ITEM.startsWith('h-11 gap-2.5 rounded-lg px-2.5 py-0 text-[13px] sm:h-9 ')).toBe(true);
    expect(MENU_ITEM).toContain('data-highlighted:bg-[var(--track)]');
    expect(MENU_ITEM.endsWith('[&_svg:not([class*=size-])]:size-4')).toBe(true);
  });
});
```

`src/lib/design-tokens.test.ts`: add to the value table
`['--dir-bg', '#E9EEF4'], ['--exe-bg', '#E2F0DF'], ['--exe-fg', '#2E5B2A'], ['--viewing-bg', '#FBF3E3'],
['--warning-line', '#E2C48F'], ['--on-ink-fill', '#3E3B36']`, and to `pairs`:

```ts
    // Disk files spec §11
    ['--accent-blue', '--dir-bg'], ['--exe-fg', '--exe-bg'], ['--warning-fg', '--warning-bg'],
    ['--success-fg', '--success-bg'], ['--danger-fg', '--danger-bg'], ['--muted-2', '--modal-foot'],
    ['--amber-text', '--surface-2'], ['--amber-text', '--viewing-bg'], ['--ink', '--viewing-bg'],
    ['--muted-2', '--viewing-bg'], ['--surface', '--on-ink-fill'], ['--fetch-dot', '--ink'], ['--danger-fg', '--surface'],
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/lib/disk-files-look.test.ts src/components/ui/menu-item-look.test.ts src/lib/design-tokens.test.ts`
Expected: FAIL — `Cannot find module '@/lib/disk-files-look'`; `MENU_ITEM` is `undefined`; `--dir-bg is not set as a
#rrggbb hex in globals.css`.

- [ ] **Step 3: Implement**

`src/lib/disk-files-look.ts`:

```ts
// The disk page's look rules (Phase C4 spec §5.5): pure and client-safe.
import type { AdfEntry } from '@/lib/adffs';
import type { TreeChange } from '@/lib/disk-history/diff';
import type { HistoryVersion } from '@/lib/disk-history/history';
import type { MountChoice } from '@/lib/mount-choice';
import { PROTECTION_FLAGS } from '@/lib/protection-bits';

export const formatKb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** `1 file`, `2 files`, `1 .info file` -- the counts on the Disk card and in the footer. */
export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const TEXT_EXT = new Set(['txt', 'doc', 'guide', 'readme', 'prefs', 'asc', 'me']);

/** Ruling 14: by name only -- no file bytes are read for the listing. */
export function entryGlyph(e: Pick<AdfEntry, 'kind' | 'name'>): { label: string; bg: string; fg: string } {
  if (e.kind === 'dir') return { label: 'DIR', bg: 'var(--dir-bg)', fg: 'var(--accent-blue)' };
  const lower = e.name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (ext === 'info') return { label: 'ICN', bg: 'var(--track)', fg: 'var(--muted-2)' };
  if (TEXT_EXT.has(ext) || /^read_?me/.test(lower)) return { label: 'TXT', bg: 'var(--track)', fg: 'var(--muted)' };
  if (!ext) return { label: 'EXE', bg: 'var(--exe-bg)', fg: 'var(--exe-fg)' };
  return { label: ext.slice(0, 3).toUpperCase(), bg: 'var(--track)', fg: 'var(--muted)' };
}

/** Ruling 13: all eight bits, in PROTECTION_FLAGS order; `on` = the letter shows in the string. */
export function protectionChips(p: string): { letter: string; on: boolean; label: string }[] {
  return PROTECTION_FLAGS.map((flag, i) => ({ letter: flag.letter, on: p[i] === flag.letter, label: flag.label }));
}

/** Ruling 15: blocks of entries whose `<name>.info` sits beside them, per directory, case-insensitive. */
export function infoCompanions(entries: AdfEntry[], into = new Set<number>()): Set<number> {
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (!lower.endsWith('.info') && names.has(`${lower}.info`)) into.add(e.block);
    if (e.kind === 'dir') infoCompanions(e.children, into);
  }
  return into;
}

export function countInfo(entries: AdfEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (e.kind === 'file' && e.name.toLowerCase().endsWith('.info')) n++;
    if (e.kind === 'dir') n += countInfo(e.children);
  }
  return n;
}

export function countTree(entries: AdfEntry[]): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  for (const e of entries) {
    if (e.kind === 'dir') {
      dirs++;
      const n = countTree(e.children);
      files += n.files;
      dirs += n.dirs;
    } else files++;
  }
  return { files, dirs };
}

export function changeCounts(changes: TreeChange[]): { added: number; changed: number; removed: number } {
  const out = { added: 0, changed: 0, removed: 0 };
  for (const c of changes) out[c.kind]++;
  return out;
}

/** The drive light (spec §2): holderText's ranking, as a state the dot and data-state carry. */
export function driveLight(choices: MountChoice[]): 'in' | 'moving' | 'stale' | 'none' {
  const held = choices.filter((c) => c.isThisDisk);
  const inDf1 = choices.filter((c) => c.df1?.isThisDisk === true);
  if (held.some((c) => c.state === 'converged') || inDf1.some((c) => c.df1Held)) return 'in';
  if (held.some((c) => c.state === 'pending') || inDf1.some((c) => !c.df1Held && !c.df1Stale)) return 'moving';
  if (held.length > 0 || inDf1.length > 0) return 'stale';
  return 'none';
}

/** The disk row's badge rule (disk-row.tsx): DF0 converged on this disk, else DF1 holding its digest. */
export function driveBadge(choices: MountChoice[]): 'DF0' | 'DF1' | null {
  if (choices.some((c) => c.state === 'converged' && c.isThisDisk)) return 'DF0';
  if (choices.some((c) => c.df1Held)) return 'DF1';
  return null;
}

export function densityPill(rootBlock: number, sizeBytes: number): string {
  return rootBlock === 1760 || sizeBytes >= 1_802_240 ? 'HD · 1.76 MB' : 'DD · 880 KB';
}

/** Ruling 24: the head, and the version on screen. */
export function openByDefault(versions: HistoryVersion[], viewingSeq: number | null): Set<number> {
  const open = new Set<number>();
  const head = versions.find((v) => v.isHead);
  if (head) open.add(head.seq);
  if (viewingSeq !== null) open.add(viewingSeq);
  return open;
}
```

(Before writing `driveBadge`, re-read `disk-row.tsx:59-60`: `inDf0 = choices.some((c) => c.state === 'converged' &&
c.isThisDisk)`, `mounted = inDf0 || choices.some((c) => c.df1Held)` — the rule is copied, not re-derived.)

`src/app/globals.css`, after the `--from-amiga-fg` line:

```css
  --dir-bg:        #E9EEF4;   /* a folder's DIR glyph; text --accent-blue 7.16:1 (Disk files spec §11) */
  --exe-bg:        #E2F0DF;   /* a program's EXE glyph ... */
  --exe-fg:        #2E5B2A;   /* ... and its text, 6.71:1 */
  --viewing-bg:    #FBF3E3;   /* the History version on screen */
  --warning-line:  #E2C48F;   /* the version banner's Back to current outline */
  --on-ink-fill:   #3E3B36;   /* a button on the ink selection strip (12 % surface over ink); surface text 10.97:1 */
```

`src/components/ui/menu-item-look.ts`, after `MENU_ITEM_HIGHLIGHT`:

```ts
/** A menu item's box: 44 px under `sm` (a finger), 36 px above, 13 px text, the shared highlight, 16 px glyphs. */
export const MENU_ITEM = `h-11 gap-2.5 rounded-lg px-2.5 py-0 text-[13px] sm:h-9 ${MENU_ITEM_HIGHLIGHT} `
  + '[&_svg:not([class*=size-])]:size-4';
```

`title-menu.tsx`: `import { MENU_ITEM } from '@/components/ui/menu-item-look';`, delete `const ITEM = …`, replace
`ITEM` with `MENU_ITEM` (four or five uses; `grep -n "ITEM}" src/components/library/title-menu.tsx`).

`volume-header.tsx`: replace its `formatKb` and `countEntries` with imports of `formatKb` and `countTree` (rename the
call). This file is deleted in Task 2.

- [ ] **Step 4: Run the tests to see them pass**

- `pnpm test src/lib/disk-files-look.test.ts src/components/ui/menu-item-look.test.ts src/lib/design-tokens.test.ts` → PASS.
- `npx tsc --noEmit`; `pnpm lint`; `pnpm test` (whole) → PASS.

- [ ] **Step 5: Regression e2e** (one at a time; the title menu's item class moved)

- `npx playwright test e2e/library-table.spec.ts --list -g "card controls|fob button"` → 2 tests; then
  `PORT=3100 npx playwright test e2e/library-table.spec.ts --project=desktop -g "card controls|fob button"` → `2 passed`.

- [ ] **Step 6: Commit** — the six files above by name, message `Disk files C4: look rules, tokens, shared menu item look`.

---

### Task 2: The page frame — breadcrumb, Disk card, banner, the body grid

**Files:**
- Create: `src/components/disks/disk-card.tsx`, `src/components/disks/disk-card.test.ts`,
  `src/components/disks/version-banner.tsx`
- Create: `e2e/disk-files-layout.spec.ts`
- Modify: `src/app/(app)/disks/[id]/files/page.tsx`
- Delete: `src/components/disks/volume-header.tsx` (once nothing imports it: `grep -rn volume-header src`)

**Interfaces:**
- Consumes: `DiskIcon`, `titleDiskColor` (`library-look.ts`), `kindFromSetName` / `pickKind` (`@/lib/game-kind`),
  `isHdAdf` (`@/lib/disk-format`), `holderText`, `mountChoices` (`mount-choice.ts`), `driveLight`, `driveBadge`,
  `densityPill`, `countTree`, `formatKb` (Task 1), `Breadcrumb`, `MountAction`, `SendBoardPicker`, `fmtTimeUtc`,
  `fromQuery`.
- Produces: `DiskCard(props: DiskCardProps)`, `DiskCardProps = { diskId; filename; title; color: DiskColor; hd:
  boolean; writeProtected: boolean; badge: 'DF0' | 'DF1' | null; volume: VolumeResult | null; usage: VolumeUsage |
  null; sizeBytes: number; rootBlock: number; holder: { text: string; stale: boolean } | null; light: 'in' | 'moving'
  | 'stale' | 'none'; actions: ReactNode }`; `VersionBanner({ seq, time, backHref }: { seq: number; time: string |
  null; backHref: string })`; ids `disk-card`, `download-<id>`, `volume-usage-meter`, `drive-light`,
  `version-banner-back`.

- [ ] **Step 1: Write the failing tests**

`src/components/disks/disk-card.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiskCard, type DiskCardProps } from './disk-card';
import type { VolumeResult, VolumeUsage } from '@/lib/adffs';

const okVolume = { ok: true, rootBlock: 880, truncated: false, warnings: [], root: [
  { name: 'C', kind: 'dir', block: 881, sizeBytes: 0, modifiedAt: null, protection: '----rwed', comment: null,
    children: [{ name: 'Dir', kind: 'file', block: 882, sizeBytes: 9, modifiedAt: null, protection: '----rwed',
      comment: null, children: [] }] },
], volume: { name: 'Workbench3.1', filesystem: 'FFS', intl: false, dirc: false,
  createdAt: new Date('1994-07-06T00:00:00Z'), modifiedAt: new Date('2026-09-27T10:00:00Z') } } as unknown as VolumeResult;
const usage: VolumeUsage = { totalBlocks: 1760, usedBlocks: 4, freeBlocks: 1756, totalBytes: 901_120,
  usedBytes: 2048, freeBytes: 899_072, percentUsed: 0 };
const base: DiskCardProps = { diskId: 'd1', filename: 'wb.adf', title: 'Workbench3.1', color: 'black', hd: false,
  writeProtected: true, badge: null, volume: okVolume, usage, sizeBytes: 901_120, rootBlock: 880, holder: null,
  light: 'none', actions: 'ACTIONS' };
const html = (o: Partial<DiskCardProps> = {}) => renderToStaticMarkup(createElement(DiskCard, { ...base, ...o }));

describe('DiskCard (spec §2)', () => {
  it('is the Disk section with one h1, a focus target, and the title block as volume-header', () => {
    const h = html();
    expect(h).toMatch(/<section[^>]*aria-label="Disk"[^>]*data-testid="disk-card"/);
    expect(h.match(/<h1/g)?.length).toBe(1);
    expect(h).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Workbench3.1<\/h1>/i);
    expect(h).toMatch(/data-testid="volume-header"[\s\S]*<h1/);
    expect(h).toContain('>wb.adf<');
  });
  it('shows the facts: FFS, density, whole-tree counts in folders, the modified date', () => {
    const h = html();
    expect(h).toContain('>FFS<');
    expect(h).toContain('>DD · 880 KB<');
    expect(h).toContain('1 file · 1 folder');
    expect(h).toContain('Modified 2026-09-27');
  });
  it('keeps A5 usage words in volume-usage-text and draws a meter', () => {
    const h = html();
    const text = h.match(/data-testid="volume-usage-text"[^>]*>([\s\S]*?)<\/div>/)![1].replace(/<[^>]+>/g, '');
    expect(text).toBe('2 KB used of 880 KB · 878 KB free');
    expect(h).toMatch(/role="meter"[^>]*aria-label="Disk space used"/);
    expect(h).toContain('data-testid="volume-usage-meter"');
  });
  it('says the bitmap is unknown instead of a meter', () => {
    const h = html({ usage: null });
    expect(h).toContain('data-testid="volume-usage-unknown"');
    expect(h).not.toContain('role="meter"');
  });
  it('the drive light says Not in a drive in words, with its state', () => {
    const h = html();
    expect(h).toMatch(/data-testid="drive-light"[^>]*data-state="none"/);
    expect(h).toMatch(/data-testid="holder-d1"[^>]*>Not in a drive</);
    expect(h).toContain('data-testid="disk-mount-bar"');
    expect(h).toContain('ACTIONS');
  });
  it('offers the whole-disk Download on the existing route', () => {
    expect(html()).toMatch(/<a[^>]*href="\/api\/disks\/d1\/adf"[^>]*aria-label="Download wb.adf"[^>]*data-testid="download-d1"/);
  });
  it('with no filesystem: no volume-header, the filename as h1, a No filesystem pill', () => {
    const h = html({ volume: { ok: false, reason: 'no-dos-signature' } as VolumeResult, title: 'wb.adf', usage: null });
    expect(h).not.toContain('data-testid="volume-header"');
    expect(h).toContain('>No filesystem<');
  });
});
```

(Attribute order in `renderToStaticMarkup` follows JSX order; write the JSX in the order the regexes read, or loosen a
regex to two `toMatch` calls — do not weaken what is asserted.)

`e2e/disk-files-layout.spec.ts` (new; grows in Tasks 3–6):

```ts
import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { signUpFresh, createAdf } from './helpers';
import { cleanupSeeded } from './device-helpers';

/**
 * Phase C4: the disk page in the ModernDiskFiles layout (spec 2026-10-25-phase-c4-disk-files-design.md). Every disk
 * is made through createAdf (FFS, root 880) and edited through the API, so each test owns its rows on the shared DB.
 */
test.describe.configure({ timeout: 90_000 });
test.afterAll(cleanupSeeded);
const AFTER_EDIT = { timeout: 15_000 };

async function freshDisk(page: Page, files: { name: string; dir?: boolean; content?: string }[] = []) {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games).where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  for (const f of files) {
    const res = await page.request.post(`/api/disks/${disk.id}/files`, { multipart: f.dir
      ? { parentBlock: '880', name: f.name }
      : { parentBlock: '880', name: f.name, file: { name: f.name, mimeType: 'application/octet-stream',
          buffer: Buffer.from(f.content ?? 'x') } } });
    expect(res.status()).toBe(200);
  }
  return { u, disk };
}

async function blocks(page: Page, diskId: string): Promise<Record<string, AdfEntry>> {
  const v = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${diskId}/adf`)).body()));
  if (!v.ok) throw new Error('fixture: the disk should read');
  return Object.fromEntries(v.root.map((e) => [e.name, e]));
}

test('the Disk card: the breadcrumb, one h1, facts, usage words with a meter, the drive light in words, Download', async ({ page }) => {
  const { disk } = await freshDisk(page);
  await page.goto(`/disks/${disk.id}/files`);
  const card = page.getByTestId('disk-card');
  await expect(card).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(card.locator('h1')).toBeVisible();
  await expect(page.getByTestId('breadcrumb').getByRole('listitem')).toHaveCount(3);
  await expect(page.getByTestId('volume-header')).toContainText('FFS');
  await expect(page.getByTestId('volume-header')).toContainText('DD · 880 KB');
  await expect(page.getByTestId('volume-usage-text')).toContainText('KB used of 880 KB');
  await expect(page.getByTestId('volume-usage-meter')).toHaveAttribute('role', 'meter');
  await expect(page.getByTestId('drive-light')).toHaveAttribute('data-state', 'none');
  await expect(page.getByTestId(`holder-${disk.id}`)).toHaveText('Not in a drive');
  await expect(page.getByTestId(`download-${disk.id}`)).toHaveAttribute('href', `/api/disks/${disk.id}/adf`);
  // The page is two columns from xl: History sits to the right of the files at 1440.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const files = (await page.getByTestId('file-tree').boundingBox())!;
  const history = (await page.getByTestId('history-panel').boundingBox())!;
  expect(history.x).toBeGreaterThan(files.x + files.width - 1);
  await page.setViewportSize({ width: 1100, height: 1000 });
  const below = (await page.getByTestId('history-panel').boundingBox())!;
  expect(below.y).toBeGreaterThan((await page.getByTestId('file-tree').boundingBox())!.y);
});

test('the version banner: the board words, Back to current returns to the head', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'FIRST.TXT', content: 'one' }]);
  await page.goto(`/disks/${disk.id}/files?version=0`);
  const banner = page.getByTestId('version-banner');
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner).toContainText('You’re browsing version 0');
  await expect(banner).toContainText('It’s read-only — restore it to make it current.');
  await page.getByTestId('version-banner-back').click();
  await expect(page).toHaveURL(new RegExp(`/disks/${disk.id}/files$`));
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
});
```

(The first API upload creates versions 0 and 1 — `store.ts` writes version 0 lazily at the first change — so
`?version=0` exists. `file-tree` must exist in Task 2 for the box check; it is today's tree, unchanged until Task 3.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/components/disks/disk-card.test.ts` → FAIL (no module).
Run: `npx playwright test e2e/disk-files-layout.spec.ts --list` → 2 tests; then
`PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop` → FAIL (`disk-card` not found).

- [ ] **Step 3: Implement**

`src/components/disks/disk-card.tsx` (no `'use client'`: it renders the client `actions` it is handed):

```tsx
import type { ReactNode } from 'react';
import { DiskIcon } from '@/components/ui/disk-icon';
import type { DiskColor } from '@/lib/disk-icon';
import { MAX_ENTRIES, type VolumeResult, type VolumeUsage } from '@/lib/adffs';
import { countTree, densityPill, formatKb, plural } from '@/lib/disk-files-look';

const LIGHT = { in: 'var(--online-dot)', moving: 'var(--fetch-dot)', stale: 'var(--fetch-dot)', none: 'var(--dash)' } as const;
const NO_FILESYSTEM_COPY = {
  'not-adf': 'This image is not a standard 880 KB or 1.76 MB ADF.',
  'no-dos-signature': 'No AmigaDOS filesystem — this disk has no DOS signature, which is normal for a game or demo with a custom bootblock.',
  'no-filesystem': 'No AmigaDOS filesystem — the disk has a DOS signature but no valid root block, which is normal for a cracked or copy-protected game.',
} as const;
/** The no-filesystem sentence (moved from volume-header.tsx, words unchanged); rendered in the Files card (§4.6). */
export function noFilesystemCopy(r: Extract<VolumeResult, { ok: false }>): string { return NO_FILESYSTEM_COPY[r.reason]; }

const Pill = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full px-[9px] py-0.5 font-medium" style={{ background: 'var(--track)', color: 'var(--muted)' }}>
    {children}
  </span>
);

export interface DiskCardProps {
  diskId: string; filename: string; title: string; color: DiskColor; hd: boolean; writeProtected: boolean;
  badge: 'DF0' | 'DF1' | null; volume: VolumeResult | null; usage: VolumeUsage | null; sizeBytes: number;
  rootBlock: number; holder: { text: string; stale: boolean } | null; light: 'in' | 'moving' | 'stale' | 'none';
  actions: ReactNode;
}

export function DiskCard(p: DiskCardProps) {
  const ok = p.volume?.ok === true ? p.volume : null;
  const counts = ok ? countTree(ok.root) : null;
  const fsLine = ok ? `${p.hd ? 'HD' : 'DD'} · ${ok.volume.filesystem}` : 'No filesystem';
  return (
    <section aria-label="Disk" data-testid="disk-card"
             className="flex flex-col gap-4 rounded-[20px] p-4 sm:px-6 sm:py-5 lg:flex-row lg:items-center lg:gap-6"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
      <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
        <DiskIcon className="shrink-0 max-sm:hidden" size={76} color={p.color} hd={p.hd} wp={p.writeProtected}
                  mounted={p.badge !== null} drive={p.badge ?? 'DF0'} set={fsLine} title={p.title} />
        <DiskIcon className="shrink-0 sm:hidden" size={56} color={p.color} hd={p.hd} wp={p.writeProtected}
                  mounted={p.badge !== null} drive={p.badge ?? 'DF0'} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5" data-testid={ok ? 'volume-header' : undefined}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 tabIndex={-1}
                className="rounded-[6px] text-[26px] font-bold leading-[1.05] tracking-[-0.02em] [overflow-wrap:anywhere] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring) sm:text-[34px]"
                style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
              {p.title}
            </h1>
            {p.filename !== p.title && (
              <span className="font-mono text-[13px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{p.filename}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]" style={{ color: 'var(--muted)' }}>
            {ok ? <Pill>{ok.volume.filesystem}</Pill> : <Pill>No filesystem</Pill>}
            {ok?.volume.intl && <Pill>INTL</Pill>}
            {ok?.volume.dirc && <Pill>DIRC</Pill>}
            <Pill>{densityPill(p.rootBlock, p.sizeBytes)}</Pill>
            {counts && <span>{plural(counts.files, 'file')} · {plural(counts.dirs, 'folder')}</span>}
            {ok?.volume.modifiedAt && <><span aria-hidden>·</span><span>Modified {ok.volume.modifiedAt.toISOString().slice(0, 10)}</span></>}
          </div>
          {ok?.truncated && (
            <p className="text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid="listing-truncated">
              listing truncated at {MAX_ENTRIES.toLocaleString()} entries
            </p>
          )}
          {ok && ok.warnings.length > 0 && (
            <p className="text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid="volume-warnings">{ok.warnings.join('; ')}</p>
          )}
        </div>
      </div>
      {/* Space: A5's words (Ruling 5), the board's two ends over a meter. */}
      <div className="flex w-full flex-col gap-2 lg:w-[300px]">
        {p.usage ? (
          <div className="flex flex-col gap-2" data-testid="volume-usage">
            <div className="flex justify-between gap-3 text-[13px]" data-testid="volume-usage-text">
              <span className="font-semibold" style={{ color: 'var(--ink)' }}>
                {formatKb(p.usage.usedBytes)} used of {formatKb(p.usage.totalBytes)}
              </span>
              <span className="sr-only"> · </span>
              <span style={{ color: 'var(--muted-2)' }}>{formatKb(p.usage.freeBytes)} free</span>
            </div>
            <div role="meter" aria-label="Disk space used" aria-valuemin={0}
                 aria-valuemax={Math.round(p.usage.totalBytes / 1024)} aria-valuenow={Math.round(p.usage.usedBytes / 1024)}
                 aria-valuetext={`${formatKb(p.usage.usedBytes)} used of ${formatKb(p.usage.totalBytes)}`}
                 data-testid="volume-usage-meter" className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
              <div className="h-2 rounded-full" style={{ width: `${p.usage.percentUsed}%`,
                   background: p.usage.percentUsed >= 90 ? 'var(--accent-amber)' : 'var(--ink)' }} />
            </div>
          </div>
        ) : (
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }} data-testid="volume-usage-unknown">
            unknown — this disk&apos;s allocation bitmap is not usable
          </span>
        )}
      </div>
      <div aria-hidden className="hidden w-px self-stretch lg:block" style={{ background: 'var(--line)' }} />
      <div className="flex flex-wrap items-center gap-2.5" data-testid="disk-mount-bar">
        <span className="flex items-center gap-2 text-[13px]" data-testid="drive-light" data-state={p.light}>
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: LIGHT[p.light] }} />
          <span data-testid={`holder-${p.diskId}`} className="font-semibold"
                style={{ color: p.holder?.stale ? 'var(--amber-text)' : 'var(--muted)' }}>
            {p.holder ? p.holder.text : 'Not in a drive'}
          </span>
        </span>
        {p.actions}
        <a href={`/api/disks/${p.diskId}/adf`} aria-label={`Download ${p.filename}`} title={`Download ${p.filename}`}
           data-testid={`download-${p.diskId}`}
           className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border hover:bg-[var(--track)]"
           style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></svg>
        </a>
      </div>
    </section>
  );
}
```

(Check `DiskIcon` accepts `className` and draws `set`/`title` only at ≥ 72 px — `diskIconMetrics`; if the two-icon
trick reads badly, use one icon with `size` from a `useMediaQuery`-free CSS scale instead: `className="max-sm:scale-[0.74] origin-left"`.
The h1 font: use the display family token the other redesigned headings use — `grep -rn "font-display" src/components | head -3`.)

`src/components/disks/version-banner.tsx` (Task 5 adds the Restore button and `'use client'`):

```tsx
import { Link } from '@/components/shell/link';

export function VersionBanner({ seq, time, backHref, restore = null }: {
  seq: number; time: string | null; backHref: string; restore?: React.ReactNode;
}) {
  return (
    <div role="status" data-testid="version-banner" data-version={seq}
         className="flex flex-wrap items-center gap-3 rounded-[12px] border px-4 py-3 text-[14px]"
         style={{ background: 'var(--warning-bg)', borderColor: 'var(--fw-line)', color: 'var(--warning-fg)' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
      </svg>
      <span className="min-w-[200px] flex-1">
        You’re browsing <b>version {seq}</b>{time ? ` (${time})` : ''}. It’s read-only — restore it to make it current.
      </span>
      {restore}
      <Link href={backHref} data-testid="version-banner-back"
            className="inline-flex h-8 items-center rounded-[8px] border px-3 text-[13px] font-medium"
            style={{ borderColor: 'var(--warning-line)', color: 'var(--warning-fg)' }}>
        Back to current
      </Link>
    </div>
  );
}
```

`page.tsx`:
- add `writeProtected: disks.writeProtected` and `authored: games.authored` to the select; after the row, read the
  title's kind exactly as `getGameDetail` does (`src/lib/queries.ts:796-803`):

  ```ts
  const kindRows = await getDb().select({ setName: tosecEntries.setName })
    .from(disks)
    .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
    .innerJoin(tosecEntries, eq(tosecEntries.id, blobs.tosecEntryId))
    .where(and(eq(disks.gameId, disk.gameId), eq(disks.orgId, orgId)));
  const kind = pickKind(kindRows.map((r) => kindFromSetName(r.setName)));
  ```
  (`tosecEntries` from the schema file `getGameDetail` imports it from; `kindFromSetName` / `pickKind` from
  `@/lib/game-kind`.)
- replace `<PageHeader …/>` and the old wrapper with:

  ```tsx
  <div className="flex flex-col gap-5 px-4 pb-10 pt-6 sm:px-7">
    <Breadcrumb crumbs={[...libraryTrail(resolveFrom(from, collections), view),
      { label: disk.gameTitle ?? 'Untitled', href: `/games/${disk.gameId}${fromQuery(from, view)}` },
      { label: `Disk ${disk.diskNo}` }]} />
    <DiskCard diskId={id} filename={filename} title={title}
              color={titleDiskColor({ id, hasHd: hd, kind, formats: [disk.imageFormat], authored: disk.authored })}
              hd={hd} writeProtected={disk.writeProtected} badge={driveBadge(choices)} volume={volume} usage={usage}
              sizeBytes={disk.sizeBytes} rootBlock={rootBlock} holder={held} light={driveLight(choices)}
              actions={<><SendBoardPicker ctx={send} /><MountAction diskId={id} choices={choices} /></>} />
    {historicalSeq !== null && (
      <VersionBanner seq={historicalSeq} backHref={`/disks/${id}/files${fromQuery(from, view)}`}
                     time={(() => { const v = historyVersions.find((x) => x.seq === historicalSeq); return v ? fmtTimeUtc(v.createdAt) : null; })()} />
    )}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
      <div className="flex min-w-0 flex-col gap-4">{/* today's FileEditProvider block, minus <VolumeHeader> */}</div>
      {/* today's historyUnavailable / HistoryPanel branch */}
    </div>
  </div>
  ```
  with `const hd = rootBlock === 1760 || isHdAdf(disk);`. The `mountChoices` / `holderText` / history loads move
  above the JSX (they already are). `no-filesystem`: until Task 3, render `<div className="glass-card p-5 text-[13px]"
  data-testid="no-filesystem" style={{ color: 'var(--muted)' }}>{noFilesystemCopy(volume)}</div>` where `VolumeHeader`
  rendered it (inside the provider, when `!volume.ok`).
- delete the old `disk-mount-bar` card and the old banner; delete `volume-header.tsx`.

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test src/components/disks/disk-card.test.ts` → PASS; `npx tsc --noEmit`; `pnpm lint`; `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop` → `2 passed`.
- `PORT=3100 npx playwright test e2e/adf-browser.spec.ts --project=desktop` → `7 passed` (volume-header, usage,
  unknown bitmap, no filesystem, tenants).
- `PORT=3100 npx playwright test e2e/breadcrumb.spec.ts --project=desktop` → `5 passed`.
- `PORT=3100 npx playwright test e2e/game-detail.spec.ts --project=desktop -g "disk page|Disk Page|disk's own page"`
  (`--list` first: the test around line 300 that reads `disk-mount-bar`) → all selected pass.
- `PORT=3100 npx playwright test e2e/time-machine.spec.ts --project=desktop -g "browsing an old version"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/hd-disks.spec.ts --project=desktop` → `6 passed`.
- `PORT=3100 npx playwright test e2e/states.spec.ts --project=desktop` → all pass (`--list`: 7).

- [ ] **Step 5: Commit** — the created/modified/deleted files above by name, message
  `Disk files C4: breadcrumb, the Disk card, the version banner, the two-column body`.

---

### Task 3: The Files card shell — header, toolbar, selection strip, column heads, footer, empty states

**Files:**
- Create: `src/components/disks/files-card.tsx`
- Modify: `src/components/disks/file-tree.tsx` (render inside `FilesCard`; header controls; `role="list"`; footer;
  root-empty state), `src/components/disks/file-actions.tsx` (`FileToolbar` restyle, no own card, no disabled line;
  identity dialog restyle), `src/components/disks/selection-bar.tsx` (ink strip)
- Modify: `src/app/(app)/disks/[id]/files/page.tsx` (`FileTree toolbar={<FileToolbar/>}`; the no-filesystem
  `FilesCard`)
- Modify: `e2e/disk-files-layout.spec.ts` (two tests)

**Interfaces:**
- Consumes: `useFileEdit()` (`disabled`), `infoCompanions`, `DiskIcon`, `SortSelect`.
- Produces: `FilesCard({ controls, toolbar, children }: { controls?: ReactNode; toolbar: ReactNode; children:
  ReactNode })` (a client component: it reads `useFileEdit().disabled` for `file-edit-disabled`); `FileTree` gains
  `toolbar: ReactNode`; ids `files-card`, `files-heading`, `fs-columns`, `fs-footer`; `fs-hide-info` becomes
  `role="switch"`.

- [ ] **Step 1: Write the failing tests** (append to `e2e/disk-files-layout.spec.ts`)

```ts
test('the Files header: heading, filter, the Hide .info switch, Add file and New folder, and a footer that counts', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'Tool' , content: 'exe' }, { name: 'Tool.info', content: 'icn' },
    { name: 'Docs', dir: true }]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/disks/${disk.id}/files`);
  const card = page.getByTestId('files-card');
  await expect(card.getByRole('heading', { level: 2, name: 'Files' })).toBeVisible();
  await expect(page.getByTestId('fs-filter')).toHaveAttribute('placeholder', 'Filter by name');
  const sw = page.getByTestId('fs-hide-info');
  await expect(sw).toHaveAttribute('role', 'switch');
  await expect(sw).toHaveText('Hide .info files');
  await expect(page.getByTestId('upload-trigger')).toHaveText(/Add file/);
  await expect(page.getByTestId('new-folder-trigger')).toHaveText(/New folder/);
  await expect(page.getByTestId('file-toolbar')).toBeVisible();
  await expect(page.getByTestId('fs-columns')).toContainText('Protection');
  const wasHiding = (await sw.getAttribute('aria-checked')) === 'true';
  if (wasHiding) await sw.click();                          // a fresh account starts from the default
  await expect(page.getByTestId('fs-footer')).toHaveText('1 folder · 2 files shown');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('fs-footer')).toHaveText('1 folder · 1 file shown · 1 .info file hidden');
  await sw.click();                                         // leave the preference as found
});

test('read-only states say why in the header, and the selection strip keeps A5 words', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'A.TXT' }, { name: 'B.TXT' }]);
  const b = await blocks(page, disk.id);
  await page.goto(`/disks/${disk.id}/files`);
  await page.getByTestId(`fs-select-${b['A.TXT'].block}`).check();
  await page.getByTestId(`fs-select-${b['B.TXT'].block}`).check();
  await expect(page.getByTestId('fs-selection-count')).toHaveText('2 items selected');
  await expect(page.getByTestId('fs-selection-clear')).toHaveAttribute('aria-label', 'Clear selection');
  await page.getByTestId('fs-selection-clear').click();
  await expect(page.getByTestId('fs-selection-bar')).toHaveCount(0);
  await page.goto(`/disks/${disk.id}/files?version=0`);
  await expect(page.getByTestId('file-edit-disabled')).toContainText('read-only');
  await expect(page.getByTestId('files-card').getByTestId('file-edit-disabled')).toHaveCount(1);
  await expect(page.getByTestId('upload-trigger')).toBeDisabled();
});
```

(Version 0 of a disk with two API uploads is the empty volume, so `?version=0` shows the root-empty state: also
assert `page.getByTestId('file-tree')` `toContainText("This disk's root directory is empty.")`.)

- [ ] **Step 2: Run them to see them fail**

`npx playwright test e2e/disk-files-layout.spec.ts --list` → 4 tests;
`PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop -g "Files header|read-only states"` →
FAIL (`files-card` not found).

- [ ] **Step 3: Implement**

`src/components/disks/files-card.tsx`:

```tsx
'use client';
import type { ReactNode } from 'react';
import { useFileEdit } from './file-actions';

/** The Files card (C4 spec §4): heading, the tree's controls, the toolbar, the disabled reason, then the body. */
export function FilesCard({ controls = null, toolbar, children }: { controls?: ReactNode; toolbar: ReactNode; children: ReactNode }) {
  const { disabled } = useFileEdit();
  return (
    <section aria-labelledby="files-heading" data-testid="files-card" className="flex flex-col overflow-hidden rounded-[20px]"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
      <div className="flex flex-col border-b" style={{ borderColor: 'var(--line)' }}>
        <div className="flex flex-wrap items-center gap-2.5 px-4 py-3.5">
          <h2 id="files-heading" tabIndex={-1}
              className="mr-auto rounded-[6px] text-[15px] font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)"
              style={{ color: 'var(--ink)' }}>Files</h2>
          {controls}
          {toolbar}
        </div>
        {disabled && (
          <p className="-mt-1 px-4 pb-3 text-[13px] font-semibold" style={{ color: 'var(--amber-text)' }}
             data-testid="file-edit-disabled">{disabled.message}</p>
        )}
      </div>
      {children}
    </section>
  );
}
```

`file-tree.tsx` (rows unchanged until Task 4):
- `FileTree` takes `toolbar: ReactNode` and returns `<DndContext …><FilesCard controls={controls} toolbar={toolbar}>
  …</FilesCard></DndContext>` in both branches (empty and not).
- `controls` = the filter field (spec §4.1: wrapper `label` with the search glyph; the `input` keeps
  `data-testid="fs-filter"`, `aria-label`, `placeholder`, Escape), the switch, `SortSelect` (`toolbar` prop true):

  ```tsx
  <button type="button" role="switch" aria-checked={hideInfo} onClick={() => changeHideInfo(!hideInfo)}
          data-testid="fs-hide-info"
          className="flex h-9 items-center gap-2 rounded-[9px] px-2.5 text-[13px] font-medium hover:bg-[var(--track)] focus-visible:outline-2 focus-visible:outline-(--ring)"
          style={{ color: 'var(--muted)' }}>
    <span aria-hidden className={`flex h-4 w-7 shrink-0 rounded-full p-0.5 ${hideInfo ? 'justify-end' : 'justify-start'}`}
          style={hideInfo ? { background: 'var(--ink)' } : { background: 'var(--line-strong)', boxShadow: 'inset 0 0 0 1px var(--muted-2)' }}>
      <span className="h-3 w-3 rounded-full" style={{ background: 'var(--surface)', boxShadow: '0 1px 2px rgb(0 0 0 / 0.25)' }} />
    </span>
    Hide .info files
  </button>
  ```
- the list: `<div role="list" ref={setRootDropRef} data-testid="file-tree" data-drop-target=… {...nativeDropProps(rootBlock)}
  className="md:max-h-[700px] md:overflow-y-auto" style={{ boxShadow: nativeOver === rootBlock ? 'inset 0 0 0 2px var(--accent-amber)' : undefined }}>`
  — the `SelectionBar` renders ABOVE it (between the header and `fs-columns`), then `fs-columns` (spec §4.3, `hidden
  md:grid`, `aria-hidden`, the Task 4 grid template), then the list.
- the footer (spec §4.5):

  ```tsx
  const shownDirs = rows.filter((r) => r.entry.kind === 'dir').length;
  const hiddenInfo = hideInfo ? countInfo(entries) : 0;   // every *.info in the whole tree (disk-files-look.ts)
  <div className="border-t px-4 py-3 text-[12px]" data-testid="fs-footer"
       style={{ borderColor: 'var(--line)', background: 'var(--modal-foot)', color: 'var(--muted-2)' }}>
    {plural(shownDirs, 'folder')} · {plural(rows.length - shownDirs, 'file')} shown{hiddenInfo > 0 ? ` · ${plural(hiddenInfo, '.info file')} hidden` : ''}
  </div>
  ```
  (`countInfo` is written in Task 1.)
- the root-empty state (spec §8.2) replaces the `entries.length === 0` card body:

  ```tsx
  <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
    <DiskIcon color="cream" size={48} />
    <span className="text-[14px]" style={{ color: 'var(--muted)' }}>This disk&apos;s root directory is empty.</span>
    <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
      {disabled ? `Editing is off: ${disabled.message}` : 'Drop files on the bar below, or press Add file.'}
    </span>
  </div>
  ```
  inside the same `file-tree` list element (so the root stays a drop target).

`file-actions.tsx` `FileToolbar`: a fragment-like `div` `data-testid="file-toolbar"` `className="flex flex-wrap
items-center gap-2"` with no card and no `file-edit-disabled` (moved to `FilesCard`); `upload-input` gets
`className="sr-only"` (nothing else); `upload-trigger` text `Add file` with the upload glyph, ink 36 px (spec §4.1);
`new-folder-trigger` outline 36 px with a folder-plus glyph; the inline forms' fields 36 px `rounded-[9px]`
`var(--surface)` + line border; Submit ink, Cancel outline. Words of the submit buttons unchanged (`Upload` /
`Uploading…`, `Create` / `Creating…`). The identity dialog: `h2` Bricolage 20/700, Cancel 38 px outline, `Edit
anyway` 38 px ink; ids and words unchanged.

`selection-bar.tsx`: the ink strip of spec §4.2 (classes and tokens there); `fs-selection-clear` becomes `×` with
`aria-label="Clear selection"`; the move/delete modes keep their ids and words; after a successful bulk move or delete,
`done()` also focuses `#files-heading` (the strip vanishes with the selection; spec §9):

```ts
function done() { setMode('idle'); setTarget(''); onClear(); document.getElementById('files-heading')?.focus(); }
```

`page.tsx`: `<FileTree … toolbar={<FileToolbar />} />`; remove the standalone `<FileToolbar />`; for `!volume.ok`:

```tsx
<FilesCard toolbar={<FileToolbar />}>
  <p className="px-4 py-6 text-[13px]" style={{ color: 'var(--muted)' }} data-testid="no-filesystem">{noFilesystemCopy(volume)}</p>
</FilesCard>
```

- [ ] **Step 4: Run the tests to see them pass** (one at a time)

- `npx tsc --noEmit`; `pnpm lint`; `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop` → `4 passed`.
- `PORT=3100 npx playwright test e2e/disk-files-a5.spec.ts --project=desktop` → `8 passed` (filter, Hide .info via
  `.check()` on the switch, selection, bulk, protection, new in vN, Undo).
- `PORT=3100 npx playwright test e2e/disk-files-edit.spec.ts --project=desktop` → `7 passed` (identity confirm,
  mounted refusal words, new folder). Its `fs-delete-` / `fs-rename-` sites still work: rows are unchanged until
  Task 4.
- `PORT=3100 npx playwright test e2e/adf-browser.spec.ts --project=desktop -g "no filesystem|bitmap"` → `2 passed`.
- `PORT=3100 npx playwright test e2e/hd-disks.spec.ts --project=desktop -g "no filesystem|HD root|toolbar"` (`--list`
  first) → all selected pass.
- `PORT=3100 npx playwright test e2e/time-machine.spec.ts --project=desktop -g "browsing an old version"` → `1 passed`.
- Mobile: `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "file toolbar"` → `1 passed` (the
  toolbar and its upload form inside 390).

- [ ] **Step 5: Commit** — `files-card.tsx`, `file-tree.tsx`, `file-actions.tsx`, `selection-bar.tsx`, `page.tsx`,
  `e2e/disk-files-layout.spec.ts`, message
  `Disk files C4: the Files card header, toolbar, selection strip, column heads, footer, empty states`.

---

### Task 4: The row — grid, glyph, protection chips, the ⋯ menu, inline forms, focus

**Files:**
- Create: `src/components/disks/file-row-menu.tsx`
- Modify: `src/components/disks/file-tree.tsx` (`FileRow`), `src/components/disks/protection-editor.tsx`
- Modify: `e2e/helpers.ts` (`openRowMenu`), `e2e/disk-files-layout.spec.ts` (three tests)
- Modify (spec §10.4): `e2e/adf-browser.spec.ts:208,246`, `e2e/disk-files-edit.spec.ts:142,179`,
  `e2e/hd-disks.spec.ts:318`, `e2e/disk-drag-drop.spec.ts:415,473`, `e2e/send-to-amiga.spec.ts:145`,
  `e2e/mobile.spec.ts:221` (test body), `:367` (two taps)
- Modify: `src/lib/help/topics.tsx` (`send`, spec §13)

**Interfaces:**
- Consumes: `DropdownMenu*` (`@/components/ui/dropdown-menu`), `MENU_ITEM`, `entryGlyph`, `protectionChips`,
  `infoCompanions` (Task 1), `useFileEdit`, `useSendAction` (already in `FileTree`).
- Produces: `FileRowMenu(props: { entry: AdfEntry; diskId: string; editDisabled: EditDisabled | null; canSend: boolean;
  sendBusy: boolean; onSend(): void; onRename(): void; onMove(): void; onProtect(): void; onDelete(): void })`;
  ids `fs-more-<block>`, `fs-row-menu`, `fs-protect-item-<block>`, `fs-glyph-<block>`, `fs-info-<block>`;
  `openRowMenu(page: Page, row: number | string): Promise<Locator>` in `e2e/helpers.ts`; `FileRow` gains
  `hasInfo: boolean`.

- [ ] **Step 1: Write the failing tests**

`e2e/helpers.ts` (beside `openTitleMenu`; the file already imports `expect`, `Page`):

```ts
/**
 * Opens a disk file row's ⋯ menu (C4 spec §5.3) -- by block number, or by the row's name -- and returns the panel.
 * The row actions (Download, Send to Amiga, Rename, Move to…, Protection bits…, Delete) are items in it and keep
 * their old test ids. A tap where the page has touch, a click otherwise (same rule as openTitleMenu).
 */
export async function openRowMenu(page: Page, row: number | string) {
  const trigger = typeof row === 'number'
    ? page.getByTestId(`fs-more-${row}`)
    : page.locator(`[data-testid="fs-entry"][data-name="${row}"] [data-testid^="fs-more-"]`);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) await trigger.tap();
  else await trigger.click();
  const panel = page.getByTestId('fs-row-menu');
  await expect(panel).toBeVisible();
  return panel;
}
```

`e2e/disk-files-layout.spec.ts` (append; add `openRowMenu` to the helpers import):

```ts
test('a row menu holds the row actions in the board order; Rename focuses its field, Escape returns to ⋯', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'NOTES.TXT', content: 'hello' }]);
  const b = (await blocks(page, disk.id))['NOTES.TXT'].block;
  await page.goto(`/disks/${disk.id}/files`);
  const panel = await openRowMenu(page, b);
  await expect(panel.getByRole('menuitem')).toHaveText(['Download', 'Rename', 'Move to…', 'Protection bits…', 'Delete']);
  await expect(page.getByTestId(`fs-download-${b}`)).toHaveAttribute('href', `/api/disks/${disk.id}/files/${b}`);
  await page.getByTestId(`fs-rename-${b}`).click();
  await expect(page.getByTestId(`fs-rename-name-${b}`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`fs-more-${b}`)).toBeFocused();
});

test('a deleted row hands focus to the Files heading, never to the body', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'GONE.TXT' }, { name: 'KEPT.TXT' }]);
  const b = (await blocks(page, disk.id))['GONE.TXT'].block;
  await page.goto(`/disks/${disk.id}/files`);
  await openRowMenu(page, b);
  await page.getByTestId(`fs-delete-${b}`).click();
  await expect(page.getByTestId(`fs-delete-cancel-${b}`)).toBeFocused();
  await page.getByTestId(`fs-delete-confirm-${b}`).click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="GONE.TXT"]')).toHaveCount(0, AFTER_EDIT);
  await expect(page.locator('#files-heading')).toBeFocused();
});

test('rows: the grid from md, a two-line card below; glyphs, eight protection chips, the .info badge, names wrap', async ({ page }) => {
  const long = 'A_Thirty_Character_Name_Here01';            // 30 = MAX_NAME_LENGTH
  const { disk } = await freshDisk(page, [{ name: 'Prog' }, { name: 'Prog.info' }, { name: long }, { name: 'Sub', dir: true }]);
  const b = await blocks(page, disk.id);
  // Hide .info on, so Prog carries the .info badge (restore the preference at the end).
  await page.goto(`/disks/${disk.id}/files`);
  const sw = page.getByTestId('fs-hide-info');
  const was = await sw.getAttribute('aria-checked');
  if (was !== 'true') await sw.click();
  await expect(page.getByTestId(`fs-info-${b.Prog.block}`)).toHaveText('.info');
  await expect(page.getByTestId(`fs-glyph-${b.Prog.block}`)).toHaveText('EXE');
  await expect(page.getByTestId(`fs-glyph-${b.Sub.block}`)).toHaveText('DIR');
  await expect(page.getByTestId(`fs-protect-${b.Prog.block}`)).toHaveText('----rwed');
  await expect(page.getByTestId(`fs-protect-${b.Prog.block}`).locator('span')).toHaveCount(8);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const row = page.locator(`[data-testid="fs-entry"][data-name="Prog"]`);
    const h = (await row.boundingBox())!.height;
    expect(h, `one line at ${width}`).toBeLessThan(48);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const name = page.locator(`[data-testid="fs-entry"][data-name="${long}"]`);
  const nameBox = (await name.boundingBox())!;
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(390);
  const more = (await page.getByTestId(`fs-more-${b[long].block}`).boundingBox())!;
  expect(more.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (was !== 'true') await sw.click();
});
```

Spec §10.4 edits (each one line or two):

```ts
// adf-browser.spec.ts:207-209 (and the same at :245-247 with SECRET.TXT / pageA)
await openRowMenu(page, 'DATA.BIN');
const link = page.locator('a[data-testid^="fs-download-"]');
// disk-files-edit.spec.ts:142 and :179, hd-disks.spec.ts:318, disk-drag-drop.spec.ts:415 and :473, send-to-amiga.spec.ts:145
await openRowMenu(page, entry.block);        // the block the next line already uses
// mobile.spec.ts:367 test: before `fs-rename-${block}` .tap() and before `fs-delete-${block}` .tap()
await openRowMenu(page, block);
```

`mobile.spec.ts:221` ("a file tree row shows its name AND its download control") becomes "…its name AND its actions":

```ts
  await expect(readme.getByText('README')).toBeVisible();
  const more = readme.locator('[data-testid^="fs-more-"]');
  await expect(more).toBeVisible();
  let box = (await more.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await openRowMenu(page, 'README');
  const download = page.locator('a[data-testid^="fs-download-"]');
  await expect(download).toBeVisible();
  box = (await download.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
```

(keep its last assertion on `fs-toggle-` unchanged; update the comment above it: the row's actions are in the menu.)

- [ ] **Step 2: Run them to see them fail**

`npx playwright test e2e/disk-files-layout.spec.ts --list` → 7; `PORT=3100 npx playwright test
e2e/disk-files-layout.spec.ts --project=desktop -g "row menu|deleted row|rows:"` → FAIL (`fs-more-…` not found).

- [ ] **Step 3: Implement**

`src/components/disks/file-row-menu.tsx`:

```tsx
'use client';
// A disk file row's ⋯ menu (C4 spec §5.3; board ModernDiskFiles `role=menu`). C1's title-menu pattern: the press
// never reaches dnd-kit, focus returns to the trigger unless an item opened an inline form (which takes focus itself).
import { useRef } from 'react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_ITEM } from '@/components/ui/menu-item-look';
import type { AdfEntry } from '@/lib/adffs';
import type { EditDisabled } from './file-actions';

const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };
const STOP_ALL = { onPointerDown: stop, onMouseDown: stop, onTouchStart: stop, onClick: stop } as const;

export function FileRowMenu({ entry, diskId, editDisabled, canSend, sendBusy, onSend, onRename, onMove, onProtect, onDelete }: {
  entry: AdfEntry; diskId: string; editDisabled: EditDisabled | null; canSend: boolean; sendBusy: boolean;
  onSend(): void; onRename(): void; onMove(): void; onProtect(): void; onDelete(): void;
}) {
  const opening = useRef(false);
  const historical = editDisabled?.reason === 'historical';
  const edit = (fn: () => void) => () => { opening.current = true; fn(); };
  const why = editDisabled?.message;
  return (
    <span className="contents" {...STOP_ALL}>
      <DropdownMenu onOpenChange={(open) => { if (open) opening.current = false; }}>
        <DropdownMenuTrigger
          data-testid={`fs-more-${entry.block}`}
          aria-label={`Actions for ${entry.name}`}
          onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}
          className="grid h-11 w-11 place-items-center rounded-[8px] hover:bg-[var(--track)] data-popup-open:bg-[var(--track)] sm:h-8 sm:w-8"
          style={{ color: 'var(--muted)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="fs-row-menu" finalFocus={() => !opening.current}
                             className="w-[200px] max-w-[calc(100vw-2rem)] rounded-xl p-1.5 ring-0"
                             style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)',
                                      boxShadow: '0 20px 40px -12px rgb(36 33 27 / 0.3)' }} {...STOP_ALL}>
          {entry.kind === 'file' && (historical ? (
            <DropdownMenuItem disabled title={why} data-testid={`fs-download-${entry.block}`} className={MENU_ITEM}>Download</DropdownMenuItem>
          ) : (
            <DropdownMenuItem data-testid={`fs-download-${entry.block}`} className={MENU_ITEM}
                              render={<a href={`/api/disks/${diskId}/files/${entry.block}`} />}>Download</DropdownMenuItem>
          ))}
          {canSend && (
            <DropdownMenuItem data-testid={`fs-send-${entry.block}`} disabled={sendBusy || historical} title={historical ? why : undefined}
                              aria-label={`Send ${entry.name} to the Amiga`} onClick={onSend} className={MENU_ITEM}>Send to Amiga</DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid={`fs-rename-${entry.block}`} disabled={!!editDisabled} title={why} onClick={edit(onRename)} className={MENU_ITEM}>Rename</DropdownMenuItem>
          <DropdownMenuItem data-testid={`fs-move-${entry.block}`} disabled={!!editDisabled} title={why} onClick={edit(onMove)} className={MENU_ITEM}>Move to…</DropdownMenuItem>
          <DropdownMenuItem data-testid={`fs-protect-item-${entry.block}`} disabled={!!editDisabled} title={why} onClick={edit(onProtect)} className={MENU_ITEM}>Protection bits…</DropdownMenuItem>
          <DropdownMenuSeparator className="mx-1.5 my-1" style={{ background: 'var(--line)' }} />
          <DropdownMenuItem data-testid={`fs-delete-${entry.block}`} variant="destructive" disabled={!!editDisabled} title={why}
                            onClick={edit(onDelete)} className={MENU_ITEM} style={{ color: 'var(--danger-fg)' }}>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
```

(Check `DropdownMenuItem` forwards `render`, `variant` and `disabled` to Base UI's `Menu.Item` —
`src/components/ui/dropdown-menu.tsx`; `drive-chips.tsx:288` already passes `render={<Link …/>}`. The e2e item-order
assertion expects no Send item: `freshDisk` pairs no board.)

`FileRow` (spec §5.1–5.2) — the row element, replacing today's flex row and its action line:

```tsx
const glyph = entryGlyph(entry);
const chips = protectionChips(entry.protection).map((c) => (
  <span key={c.letter} title={c.label} className="grid h-[18px] w-[14px] place-items-center rounded-[4px]"
        style={c.on ? { background: 'var(--track)', color: 'var(--ink)' } : { color: 'var(--muted-2)' }}>
    {c.on ? c.letter : '-'}
  </span>
));
const row = (
  <div ref={setDragRef} role={isDir ? undefined : 'listitem'} data-testid="fs-entry" data-name={entry.name}
       data-selected={selected || undefined}
       className="grid grid-cols-[28px_32px_minmax(0,1fr)_44px] items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-[13px] hover:bg-[var(--surface-2)] data-[selected=true]:bg-[var(--surface-2)] md:min-h-[40px] md:grid-cols-[28px_28px_minmax(0,1fr)_96px_132px_104px_36px] md:gap-x-3 md:py-1"
       style={{ borderColor: 'var(--hairline)', transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.5 : 1 }}
       {...(isDir ? {} : nativeDrop)}>
    <span className="row-span-2 grid place-items-center md:row-span-1">
      {selectable && <input type="checkbox" checked={selected} onChange={() => onSelect(entry.block)}
                            aria-label={`Select ${entry.name}`} data-testid={`fs-select-${entry.block}`}
                            className="h-4 w-4" style={{ accentColor: 'var(--ink)' }} />}
    </span>
    <button type="button" aria-label={`Move ${entry.name}`} disabled={!!editDisabled || busy} title={editDisabled?.message}
            data-testid={`fs-drag-${entry.block}`} {...attributes} {...listeners} style={{ touchAction: 'none', color: 'var(--muted-2)' }}
            className="row-span-2 grid h-11 w-8 cursor-grab place-items-center rounded-[6px] active:cursor-grabbing disabled:cursor-default disabled:opacity-40 md:row-span-1 md:h-8 md:w-7">
      <GripVertical size={14} aria-hidden />
    </button>
    {/* name cell: today's toggle button (folders) / span (files), restyled; see spec §5.1 */}
    <div className="col-start-3 flex min-w-0 items-center gap-2" style={{ paddingLeft: `${depth * 18}px` }}>
      {/* folder: <button fs-toggle aria-expanded> chevron + glyph + name + badges; file: 12 px spacer + glyph + name + badges */}
    </div>
    <div className="col-start-3 row-start-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] md:contents">
      <span className="md:text-right" style={{ color: isDir ? 'var(--muted-2)' : 'var(--muted)' }}>
        {isDir ? '—' : `${entry.sizeBytes.toLocaleString()} B`}
      </span>
      {editDisabled ? (
        <span className="flex gap-0.5 text-[11px] font-semibold" data-testid={`fs-protect-${entry.block}`}>{chips}</span>
      ) : (
        <button type="button" onClick={() => startProtect(entry)} title="Change protection bits"
                aria-label={`Protection of ${entry.name}: ${entry.protection}. Change`} data-testid={`fs-protect-${entry.block}`}
                className="flex gap-0.5 rounded-[4px] text-[11px] font-semibold hover:outline hover:outline-1 hover:outline-(--line-strong)">{chips}</button>
      )}
      <span style={{ color: 'var(--muted)' }}>{entry.modifiedAt ? entry.modifiedAt.toISOString().slice(0, 10) : '—'}</span>
    </div>
    <span className="col-start-4 row-span-2 row-start-1 grid place-items-center md:col-start-auto md:row-span-1 md:row-start-auto">
      <FileRowMenu entry={entry} diskId={diskId} editDisabled={editDisabled} canSend={canSend} sendBusy={sendBusy}
                   onSend={() => onSend(entry)} onRename={() => startRename(entry)} onMove={() => startMove(entry)}
                   onProtect={() => startProtect(entry)} onDelete={() => startDelete(entry)} />
    </span>
    {/* the open inline form (today's protectOpen / rename / delete / move branches), wrapped: */}
    {formOpen && <div className="col-span-full flex flex-wrap items-center gap-2 py-2" style={{ paddingLeft: `${depth * 18 + 68}px` }}>…</div>}
  </div>
);
```

The name cell's badges: `fs-info-<block>` when `hideInfo && hasInfo` (FileTree passes `hasInfo={companions.has(entry.block)}`
with `const companions = useMemo(() => infoCompanions(entries), [entries])`), then `newMark` restyled per spec §5.1.
The glyph: `<span aria-hidden data-testid={`fs-glyph-${entry.block}`} className="grid h-[22px] w-[22px] shrink-0
place-items-center rounded-[6px] font-mono text-[9px] font-bold" style={{ background: glyph.bg, color: glyph.fg }}>{glyph.label}</span>`.
The name `span`: `className="text-[14px] [overflow-wrap:anywhere]"`, 600 for folders.

The folder wrapper keeps `fs-drop-<block>`, gains `role="listitem"`. The old inline `Download` link, `Send` button and
the Rename / Delete / Move to… line are removed (they are menu items now). Delete `GRIP_GUTTER` / `SELECT_GUTTER`.

Inline forms (spec §5.4): today's four branches, restyled (30 px fields and buttons, tokens), plus:
- `autoFocus` on `fs-delete-cancel-<block>` (the confirm) and on the protection editor's first bit (pass
  `autoFocusFirst` to `ProtectionEditor`, set `autoFocus` on index 0); rename and move already `autoFocus`.
- Escape on any form field or button cancels (`onKeyDown` on the form wrapper: `if (e.key === 'Escape') cancel()`).
- every Cancel (and Escape) returns focus to the row's trigger:

  ```ts
  const focusMore = (block: number) => requestAnimationFrame(() =>
    document.querySelector<HTMLElement>(`[data-testid="fs-more-${block}"]`)?.focus());
  ```
  called from `cancelRename` / `cancelDelete` / `cancelMove` / `closeProtect` with the open block.
- `submitDelete`: move focus to `fs-more-<block>` before the request (the confirm is unmounted at once), and pass an
  `onSuccess` that focuses `#files-heading` (spec §9):

  ```ts
  function submitDelete(block: number) {
    document.querySelector<HTMLElement>(`[data-testid="fs-more-${block}"]`)?.focus();
    runEdit(() => fetch(`/api/disks/${diskId}/files/${block}`, { method: 'DELETE' }), 'Deleted',
      () => document.getElementById('files-heading')?.focus());
    setDeleteBlock(null);
  }
  ```

`fs-columns` (Task 3) takes the same `md:` grid template now.

`src/lib/help/topics.tsx` `send` (spec §13): replace `On a disk&apos;s Browse page, press <em>Send</em> on a file or
a folder.` with `On a disk&apos;s page, open the ⋯ menu of a file or a folder and choose <em>Send to Amiga</em>.`;
add `file-row-menu.tsx` to the topic's source comment.

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `npx tsc --noEmit`; `pnpm lint`; `pnpm test` (includes `src/lib/help/topics.test.ts`) → PASS.
- `PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop` → `7 passed`.
- `PORT=3100 npx playwright test e2e/adf-browser.spec.ts --project=desktop` → `7 passed`.
- `PORT=3100 npx playwright test e2e/disk-files-edit.spec.ts --project=desktop` → `7 passed`.
- `PORT=3100 npx playwright test e2e/disk-files-a5.spec.ts --project=desktop` → `8 passed`.
- `PORT=3100 npx playwright test e2e/disk-drag-drop.spec.ts --project=desktop` → `6 passed` (grip drag, Move to…).
- `PORT=3100 npx playwright test e2e/archive-drop-folder.spec.ts --project=desktop` → all pass (`--list`: count the
  looped titles).
- `PORT=3100 npx playwright test e2e/hd-disks.spec.ts --project=desktop` → `6 passed`.
- `PORT=3100 npx playwright test e2e/send-to-amiga.spec.ts --project=desktop -g "Browse"` → `1 passed`.
- Mobile: `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "file tree row|file toolbar"` →
  `2 passed`. (`:455` is Task 6's; record its result if run.)

- [ ] **Step 5: Commit** — `file-row-menu.tsx`, `file-tree.tsx`, `protection-editor.tsx`, `topics.tsx`,
  `e2e/helpers.ts`, `e2e/disk-files-layout.spec.ts`, and the seven edited spec files by name, message
  `Disk files C4: the row grid, glyphs, protection chips, the ⋯ row menu, inline forms, focus after a delete`.

---

### Task 5: The History aside — collapsible versions, one restore confirm, the banner's Restore, the time-machine reds

**Files:**
- Create: `src/components/disks/restore-dialog.tsx`
- Modify: `src/components/disks/history-panel.tsx`, `src/components/disks/version-banner.tsx` (`'use client'`, the
  Restore button), `src/app/(app)/disks/[id]/files/page.tsx` (`RestoreProvider` around the banner and the body grid)
- Modify: `e2e/helpers.ts` (`openVersion`), `e2e/disk-files-layout.spec.ts` (three tests),
  `e2e/time-machine.spec.ts` (`:167`, `:246`, `:293-294`; `:212` per Step 5), `e2e/hd-disks.spec.ts` (`:328-331`)
- Modify: `src/lib/help/topics.tsx` (`write-back`, spec §13)

**Interfaces:**
- Consumes: `HistoryVersion`, `ejectMessage`, `fmtTimeUtc`, `openByDefault`, `changeCounts` (Task 1), `fromQuery`.
- Produces: `RestoreProvider({ diskId, viewingSeq, currentHref, children })`, `useRestore() → { ask(v: HistoryVersion):
  void; busy: boolean; reactiveMounted: string | null }`; `HistoryPanel` props unchanged (`diskId, from, view,
  versions, viewingSeq, mountedMessage`); `VersionBanner` gains `version: HistoryVersion | null` and `mountedMessage:
  string | null` (it renders `version-banner-restore` itself); ids `version-toggle-<seq>`, `version-body-<seq>`,
  `version-counts-<seq>`, `history-heading`, `version-banner-restore`; `openVersion(page, seq)` in `e2e/helpers.ts`.

- [ ] **Step 1: Write the failing tests**

`e2e/helpers.ts`:

```ts
/** Opens one version in a disk's History (C4 spec §7.2) unless it is open already; versions collapse by default. */
export async function openVersion(page: Page, seq: number) {
  const toggle = page.getByTestId(`version-toggle-${seq}`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId(`version-body-${seq}`)).toBeVisible();
}
```

`e2e/disk-files-layout.spec.ts` (append; import `openVersion`):

```ts
test('History: the head open, older versions closed, counts as chips, Current in words', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('history-panel').getByRole('heading', { level: 2, name: 'History' })).toBeVisible();
  await expect(page.getByTestId('version-2')).toHaveAttribute('data-head', 'true');
  await expect(page.getByTestId('version-toggle-2')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('version-toggle-1')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('changes-1')).toHaveCount(0);
  await expect(page.getByTestId('current-2')).toHaveText('Current');
  await expect(page.getByTestId('version-counts-2')).toContainText('+1');
  await expect(page.getByTestId('version-2')).toContainText('Version 2 · Edited in browser');
  await openVersion(page, 1);
  await expect(page.getByTestId('changes-1')).toContainText('ONE.TXT');
  await expect(page.getByTestId('restore-1')).toHaveText('Restore…');
});

test('Restore… asks in a dialog that focuses Cancel; Escape cancels and focus returns', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await page.goto(`/disks/${disk.id}/files`);
  await openVersion(page, 1);
  await page.getByTestId('restore-1').click();
  const dialog = page.getByTestId('restore-dialog');
  await expect(dialog).toContainText('Restore version 1?');
  await expect(dialog).toContainText('This is saved as a new version, so nothing after it is lost.');
  await expect(page.getByTestId('restore-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('restore-1')).toBeFocused();
});

test('Restore this version from the banner lands on the current version, focus on the h1', async ({ page }) => {
  test.setTimeout(120_000);
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await page.goto(`/disks/${disk.id}/files?version=1`);
  await page.getByTestId('version-banner-restore').click();
  await expect(page.getByTestId('restore-dialog')).toContainText('Restore version 1?');
  await page.getByTestId('restore-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/disks/${disk.id}/files$`), AFTER_EDIT);
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
  await expect(page.getByTestId('version-3')).toContainText('Restored to version 1', AFTER_EDIT);
  await expect(page.locator('[data-testid="fs-entry"][data-name="TWO.TXT"]')).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});
```

Spec §10.4 edits:

```ts
// time-machine.spec.ts:167 (before the restore-1 click) and hd-disks.spec.ts:328 (before changes-1)
await openVersion(page, 1);
// time-machine.spec.ts:246 (before restore-0 toBeDisabled)
await openVersion(page, 0);
// time-machine.spec.ts:293-294 (test at :268) -- A1: the app streams behind loading.tsx, so a notFound() page is
// HTTP 200 with the not-found card; the API route above still 404s.
await pb.goto(`/disks/${disk.id}/files?version=0`);
await expect(pb.getByTestId('not-found-page')).toBeVisible();
await expect(pb.getByTestId('file-tree')).toHaveCount(0);
```

- [ ] **Step 2: Run them to see them fail**

`npx playwright test e2e/disk-files-layout.spec.ts --list` → 10; `PORT=3100 npx playwright test
e2e/disk-files-layout.spec.ts --project=desktop -g "History:|Restore… asks|from the banner"` → FAIL
(`version-toggle-2` not found).

- [ ] **Step 3: Implement**

`src/components/disks/restore-dialog.tsx`:

```tsx
'use client';
// One restore confirm for the History's Restore… and the banner's Restore this version (C4 spec §7.4, Ruling 27).
// The request and its outcomes are HistoryPanel's confirmRestore, moved here verbatim.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ejectMessage } from '@/lib/mount-wording';
import { fmtTimeUtc } from '@/lib/format';
import type { HistoryVersion } from '@/lib/disk-history/history';

interface RestoreValue { ask(v: HistoryVersion): void; busy: boolean; reactiveMounted: string | null }
const RestoreContext = createContext<RestoreValue | null>(null);
export function useRestore(): RestoreValue {
  const v = useContext(RestoreContext);
  if (!v) throw new Error('useRestore must be used within a RestoreProvider');
  return v;
}

export function RestoreProvider({ diskId, viewingSeq, currentHref, children }: {
  diskId: string; viewingSeq: number | null; currentHref: string; children: ReactNode;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<HistoryVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [reactiveMounted, setReactiveMounted] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function ask(v: HistoryVersion) { opener.current = document.activeElement as HTMLElement | null; setTarget(v); }
  function close() {
    setTarget(null);
    requestAnimationFrame(() => {
      const back = opener.current && document.contains(opener.current) ? opener.current : document.getElementById('history-heading');
      back?.focus();
    });
  }
  useEffect(() => { if (target) cancelRef.current?.focus(); }, [target]);

  async function confirm(version: HistoryVersion) {
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${diskId}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seq: version.seq }),
      });
      const data: { error?: string; reason?: string; recorded?: boolean } | null = await res.json().catch(() => null);
      if (!res.ok) {
        // …the four branches of history-panel.tsx confirmRestore, unchanged (409 mounted -> setReactiveMounted +
        // toast; 409 other -> toast + refresh; 404 -> toast + refresh; 503 -> toast; else -> toast) …
        return;
      }
      if (data?.recorded === false) {
        toast.success('Nothing to restore', { description: `Version ${version.seq} is already this disk's current content.` });
      } else {
        toast.success(`Restored to version ${version.seq}`, { description: version.label });
      }
      setTarget(null);
      if (viewingSeq !== null) {
        router.replace(currentHref);                      // spec §3, Ruling 7
        requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus());
      } else {
        router.refresh();
        close();
      }
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <RestoreContext.Provider value={{ ask, busy, reactiveMounted }}>
      {children}
      {target && createPortal((
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'var(--scrim)' }}
             onKeyDown={(e) => {
               if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(); }
               if (e.key === 'Tab') {                    // keep Tab inside the two buttons
                 const els = panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
                 if (!els || els.length === 0) return;
                 const first = els[0], last = els[els.length - 1];
                 if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                 else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
               }
             }}>
          <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="restore-dialog-title" data-testid="restore-dialog"
               className="glass-card wf-modal w-full max-w-[440px] p-6 text-left">
            <h2 id="restore-dialog-title" className="text-[20px] font-bold [overflow-wrap:anywhere]"
                style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>Restore version {target.seq}?</h2>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--ink)' }}>{target.label}</strong>
            </p>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
              The disk goes back to how it was on {fmtTimeUtc(target.createdAt)}. This is saved as a new version, so
              nothing after it is lost.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2.5">
              <button ref={cancelRef} type="button" data-testid="restore-cancel" disabled={busy} onClick={close}
                      className="h-[38px] rounded-[10px] border px-4 text-[13px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>Cancel</button>
              <button type="button" data-testid="restore-confirm" disabled={busy} onClick={() => void confirm(target)}
                      className="h-[38px] rounded-[10px] px-4 text-[13px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--ink)', color: 'var(--surface)' }}>{busy ? 'Restoring…' : 'Restore'}</button>
            </div>
          </div>
        </div>
      ), document.body)}
    </RestoreContext.Provider>
  );
}
```

(Copy the four error branches from `history-panel.tsx:128-146` exactly; delete them, `confirmRestore`, the
`restoreTarget`/`busy`/`reactiveMounted` state and the old portal from `history-panel.tsx`.)

`history-panel.tsx` (spec §7):
- the `aside` shell, `h2#history-heading` (`tabIndex={-1}`, focus ring) + `HelpTip topic="write-back"`, the intro
  sentence, `history-mounted-notice` with `mountedBanner = mountedMessage ?? useRestore().reactiveMounted`.
- `const [open, setOpen] = useState(() => openByDefault(versions, viewingSeq));` and a toggle per version.
- each version `li` per spec §7.2 (timeline line and dot `aria-hidden`; card; `version-toggle-<seq>` with
  `aria-controls={`version-body-${seq}`}`; title `` `Version ${seq} · ${label}` ``; time; `version-counts-<seq>`
  from `changeCounts(version.changes)` with sr-only words, omitted when all zero; `current-<seq>` on the head);
  when open, `version-body-<seq>` with `ChangesBody` (restyled: mark chips 16 px, mono 12 `var(--muted)`), then the
  actions row: `browse-<seq>` / `viewing-<seq>`, and on non-head versions `restore-<seq>` **Restore…** (`onClick={()
  => ask(version)}`, `disabled={!!mountedBanner}`, `title`, `aria-describedby`).
- `history-show-all` and `history-empty` per spec §7.2–7.3.

`version-banner.tsx`: `'use client'`; new props `version: HistoryVersion | null`, `mountedMessage: string | null`;
when `version` is known renders, before Back to current:

```tsx
<button type="button" data-testid="version-banner-restore" onClick={() => version && ask(version)}
        disabled={!version || !!(mountedMessage ?? reactiveMounted) || busy}
        title={mountedMessage ?? reactiveMounted ?? undefined}
        aria-describedby={mountedMessage ?? reactiveMounted ? 'history-mounted-reason' : undefined}
        className="h-8 rounded-[8px] px-3 text-[13px] font-semibold disabled:opacity-50"
        style={{ background: 'var(--ink)', color: 'var(--surface)' }}>Restore this version</button>
```

`page.tsx`: wrap the banner and the body grid in `<RestoreProvider diskId={id} viewingSeq={historicalSeq}
currentHref={`/disks/${id}/files${fromQuery(from, view)}`}>`; pass `version` and `mountedMessage` to the banner.

`src/lib/help/topics.tsx` `write-back` (spec §13): add the paragraph after the one that lists where a version came
from; add `restore-dialog.tsx`, `disk-files-look.ts (openByDefault)` and this spec to the source comment. Keep the
topic within `topics.test.ts`'s limits (run it).

- [ ] **Step 4: Run the tests to see them pass** (one at a time)

- `npx tsc --noEmit`; `pnpm lint`; `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop` → `10 passed`.
- `PORT=3100 npx playwright test e2e/time-machine.spec.ts --project=desktop` → `6 passed` (the `:268` tenant test now
  asserts the not-found card; for `:212` see Step 5).
- `PORT=3100 npx playwright test e2e/hd-disks.spec.ts --project=desktop -g "history|restore|HD"` (`--list` first) →
  all selected pass.
- `PORT=3100 npx playwright test e2e/library-table.spec.ts --project=desktop -g "card controls"` and
  `e2e/nfc-fob-button.spec.ts -g "history"` (`--list` first) → pass (the ⋯ title menu's Version history lands on
  `#disk-history`).
- `PORT=3100 npx playwright test e2e/help.spec.ts --project=desktop` → all pass (`--list`: count; the "Enter opens
  the ?" flake rule applies).

- [ ] **Step 5: `time-machine.spec.ts:212` ("restore is refused while a board holds the disk, and succeeds once
  ejected") — root cause before any change**

1. Run it alone three times, recording each result and duration:
   `PORT=3100 npx playwright test e2e/time-machine.spec.ts --project=desktop -g "refused while a board holds" --repeat-each=3 --trace=retain-on-failure`.
2. On a failure, read which line failed (`npx playwright show-trace` is not available headless — read the error and
   `test-results/**/error-context.md`). Classify:
   - **the page** (`history-mounted-notice` text, `restore-0` disabled, a selector this area changed) → a product or
     selector bug of this area: fix it here, with a unit or e2e assertion that pins it;
   - **the API sequence** (mount `ok()`, the 409 body, eject `ok()`, the second restore's 200, the sha compare) →
     check the route logic against the assertion (`/api/devices/[id]/mount`, `/eject`, `/api/disks/[id]/restore`,
     `findHolder`); a real defect is reported to the controller before any route change (routes are out of this
     area's scope); a test that asserts a timing it cannot rely on is fixed in the test;
   - **the budget** (a timeout with every step green, the run near 120 s) → raise this test's budget to the measured
     worst case plus 50 %, as `286ecce` did for its sibling, with the measurement in the comment.
3. Three green isolated runs, then the whole file once (`6 passed`). The commit message names the root cause in one
   sentence.

- [ ] **Step 6: Commit** — `restore-dialog.tsx`, `history-panel.tsx`, `version-banner.tsx`, `page.tsx`, `topics.tsx`,
  `e2e/helpers.ts`, `e2e/disk-files-layout.spec.ts`, `e2e/time-machine.spec.ts`, `e2e/hd-disks.spec.ts` by name, message
  `Disk files C4: History aside with collapsible versions, one restore confirm, Restore this version; time-machine reds`
  (+ the root-cause sentence).

---

### Task 6: The drop bar and the staging list; the phone touch drag (`mobile.spec.ts:455`)

**Files:**
- Modify: `src/components/disks/drop-staging.tsx` (the bar, the list restyle, focus after a commit; new prop
  `freeBytes: number | null`, `volumeName: string`)
- Modify: `src/app/(app)/disks/[id]/files/page.tsx` (`freeBytes={usage?.freeBytes ?? null}`, `volumeName={title}`)
- Modify: `e2e/disk-files-layout.spec.ts` (one test), `e2e/mobile.spec.ts` (`:455`, per Step 5 — only if the root
  cause is in the test)
- Possibly modify: `src/components/disks/file-tree.tsx` (if the root cause of `:455` is in the row)

**Interfaces:**
- Consumes: `formatKb` (Task 1), `useFileEdit`, `synthDrop` (`e2e/drag-drop-helpers.ts`).
- Produces: `DropStaging` props `+ freeBytes: number | null; volumeName: string`; the bar per spec §6.

- [ ] **Step 1: Write the failing test** (append to `e2e/disk-files-layout.spec.ts`; import `synthDrop` from
  `./drag-drop-helpers`)

```ts
test('the drop bar: the board words with free space, staged rows under it, and the reason when editing is off', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }]);
  await page.goto(`/disks/${disk.id}/files`);
  const strip = page.getByTestId('drop-strip');
  await expect(strip).toContainText('Drop files, folders or an .lha / .lzh / .zip here or on a folder to add them to');
  await expect(strip).toContainText(/\d+ KB free on this disk · every change is saved as a new version/);
  await expect(page.getByTestId('drop-staging')).toHaveAttribute('aria-label', 'Add files to this disk');
  // In flow under the Files card (Ruling 19).
  const files = (await page.getByTestId('files-card').boundingBox())!;
  expect((await strip.boundingBox())!.y).toBeGreaterThan(files.y + files.height - 1);
  await synthDrop(page, [{ name: 'NEW.TXT', kind: 'file', content: 'new' }]);
  await expect(strip).toContainText('1 item staged below — drop more to add to the same batch.');
  await expect(page.getByTestId('drop-staging-list')).toBeVisible();
  await page.getByTestId('drop-commit').click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="NEW.TXT"]')).toBeVisible(AFTER_EDIT);
  await expect(page.locator('#files-heading')).toBeFocused();
  await page.goto(`/disks/${disk.id}/files?version=0`);
  await expect(page.getByTestId('drop-strip').getByTestId('drop-disabled')).toContainText('read-only');
});
```

- [ ] **Step 2: Run it to see it fail**

`npx playwright test e2e/disk-files-layout.spec.ts --list` → 11; `PORT=3100 npx playwright test
e2e/disk-files-layout.spec.ts --project=desktop -g "drop bar"` → FAIL (the words differ).

- [ ] **Step 3: Implement** (`drop-staging.tsx`, spec §6; logic untouched)

```tsx
<section ref={cardRef} aria-label="Add files to this disk" data-testid="drop-staging"
         className="flex flex-col gap-3 rounded-[16px] p-3 pl-4"
         style={{ background: 'var(--surface)', border: rows.length === 0 ? '1.5px dashed var(--dash)' : '1px solid var(--line)' }}>
  <div onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragOver(true); } }}
       onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
       data-testid="drop-strip" aria-disabled={!!disabled}
       className="flex min-h-[44px] items-center gap-3.5 rounded-[12px]"
       style={{ background: dragOver ? 'var(--surface-2)' : undefined, outline: dragOver ? '1.5px solid var(--ink)' : undefined,
                opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
    <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]" style={{ background: 'var(--track)', color: 'var(--ink)' }}>
      {/* the board's upload glyph, 20 px */}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      {disabled ? (
        <p className="text-[13px] font-semibold" style={{ color: 'var(--amber-text)' }} data-testid="drop-disabled">{disabled.message}</p>
      ) : rows.length === 0 ? (
        <>
          <span className="text-[14px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
            Drop files, folders or an .lha / .lzh / .zip here or on a folder to add them to{' '}
            <span className="font-mono">{volumeName}</span>
          </span>
          <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
            {freeBytes === null ? 'Free space unknown' : `${formatKb(freeBytes)} free on this disk`} · every change is saved as a new version
          </span>
        </>
      ) : (
        <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
          {rows.length} item{rows.length === 1 ? '' : 's'} staged below — drop more to add to the same batch.
        </span>
      )}
    </div>
  </div>
  {/* drop-staging-list: A5's content, restyled per spec §6 (tokens, 30 px fields, 28 px row buttons, 36 px Add / Clear) */}
</section>
```

The commit: `runEdit(…, clearStaged, …)` becomes `runEdit(…, () => { clearStaged(); document.getElementById('files-heading')?.focus(); }, …)`
(spec §9: the list and its commit button vanish).

- [ ] **Step 4: Run the tests to see them pass** (one at a time)

- `npx tsc --noEmit`; `pnpm lint`; `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop -g "drop bar"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/disk-drag-drop.spec.ts --project=desktop` → `6 passed`.
- `PORT=3100 npx playwright test e2e/archive-drop-folder.spec.ts --project=desktop` → all pass (`--list` count).
- `PORT=3100 npx playwright test e2e/archive-drop.spec.ts --project=desktop` → `2 passed`.
- `PORT=3100 npx playwright test e2e/disk-files-a5.spec.ts --project=desktop -g "Undo"` → all selected pass.

- [ ] **Step 5: `mobile.spec.ts:455` — root cause, then the fix**

It fails on master with a timeout in the touch drag (HANDOFF, C3 entry). Find which wait times out before changing
anything:

1. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "drop strip fits a phone" --trace=retain-on-failure`
   and read the error: the `expect.poll(... opacity ...).toBe('0.5')` (the drag never starts) or the final
   `expect.poll(... DRAGME.TXT under DEST ...)` (it starts but does not land), or an earlier step (strip / staging
   list boxes after this task's restyle).
2. Instrument once, temporarily (do not commit): just before `touchDrag`, log
   `await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el?.closest('[data-testid]')?.getAttribute('data-testid'); }, [from.x, from.y])`
   (must be `fs-drag-<block>`), the same for the drop point (`fs-drop-<dest>` or inside it), and `window.scrollY` before
   and after the drag.
3. Decide by the evidence:
   - the point is not the grip (another element covers it — e.g. the A5 checkbox positioned over the gutter, the
     fixed bottom bar, a header) → the row's own layout is the cause: this task's grid (the grip in its own 32 × 44
     cell, Task 4) must already fix it; if not, fix the row so the grip's centre is the grip;
   - the grip is hit but no drag starts (opacity stays 1) → the TouchSensor never activates: check the grip's
     `touch-action: none`, that `listeners` are on the grip, and that nothing on the path calls `stopPropagation` on
     `touchstart` (the Task 4 menu wrapper stops only its own subtree);
   - it starts but lands elsewhere (scrollY changed, the drop point moved) → dnd-kit auto-scroll: the test's
     coordinates were measured before the scroll; scroll so both rows sit mid-viewport and re-measure the drop box
     after the hold (keep `touchDrag`'s real-finger CDP input — the point of the test).
4. Fix the cause (product code if the page is wrong, the test if its assumption is), remove the instrumentation, then
   run it alone three times (`--repeat-each=3`) → all pass, and the file's other disk tests once:
   `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "drop strip|file toolbar|file tree row"` →
   `3 passed`. The commit message names the root cause in one sentence.

- [ ] **Step 6: Commit** — `drop-staging.tsx`, `page.tsx`, `e2e/disk-files-layout.spec.ts`, and whatever Step 5 changed
  (`file-tree.tsx` and/or `e2e/mobile.spec.ts`) by name, message
  `Disk files C4: the drop bar in the board's words, staging restyle; fix the phone touch drag (<root cause>)`.

---

### Task 7: States, contrast, phone, the regression and the screenshot

**Files:**
- Create: `src/app/(app)/disks/[id]/files/loading.tsx`, `src/app/(app)/disks/[id]/files/loading.test.ts`
- Modify: `e2e/contrast.spec.ts` (a Disk files test, spec §11), `e2e/screenshots.shots.ts` (only if the `disk-files`
  shot needs a wait for the new layout)
- Test: `e2e/mobile.spec.ts` (no edit expected)

**Interfaces:**
- Consumes: `PageSkeleton`, `Bone` (`src/components/shell/skeleton.tsx`), the `probe`/`ratio` helpers in
  `contrast.spec.ts`, `createAdf`, `openRowMenu`, `openVersion`, `shoot` in `screenshots.shots.ts`.
- Produces: `disk-files-skeleton`; `docs/screenshots/disk-files.png`.

- [ ] **Step 1: Write the failing tests**

`src/app/(app)/disks/[id]/files/loading.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DiskFilesLoading from './loading';

describe('DiskFilesLoading (spec 8.1)', () => {
  const html = renderToStaticMarkup(createElement(DiskFilesLoading));
  it('is the disk-files-skeleton page skeleton', () => {
    expect(html).toContain('data-testid="disk-files-skeleton"');
    expect(html).toContain('role="status"');
  });
  it('holds a disk-card bone, then files and history bones in two columns from xl', () => {
    expect(html).toContain('data-skeleton-disk');
    expect(html).toContain('xl:grid-cols-[minmax(0,1fr)_380px]');
    expect(html.match(/data-skeleton-row/g)?.length).toBe(8);
    expect(html.match(/data-skeleton-version/g)?.length).toBe(5);
    expect(html.indexOf('data-skeleton-disk')).toBeLessThan(html.indexOf('data-skeleton-row'));
    expect(html.indexOf('data-skeleton-row')).toBeLessThan(html.indexOf('data-skeleton-version'));
  });
});
```

`e2e/contrast.spec.ts` (new test; imports: `createAdf`, `openRowMenu`, `openVersion` from `./helpers`, `games`,
`disks` from the catalog schema, `and` from drizzle):

```ts
test('the Disk files pairs are legible: banner, rows, glyphs, chips, column heads, footer, History, menu, bar', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games).where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  for (const name of ['Prog', 'Prog.info', 'Notes.txt']) {
    expect((await page.request.post(`/api/disks/${disk.id}/files`, { multipart: { parentBlock: '880', name,
      file: { name, mimeType: 'application/octet-stream', buffer: Buffer.from(name) } } })).status()).toBe(200);
  }
  expect((await page.request.post(`/api/disks/${disk.id}/files`, { multipart: { parentBlock: '880', name: 'Docs' } })).status()).toBe(200);
  const v = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body()));
  if (!v.ok) throw new Error('fixture');
  const blk = Object.fromEntries(v.root.map((e) => [e.name, e.block]));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/disks/${disk.id}/files`);
  const sw = page.getByTestId('fs-hide-info');
  const was = await sw.getAttribute('aria-checked');
  if (was !== 'true') await sw.click();                       // .info badge on Prog
  await page.getByTestId(`fs-select-${blk['Notes.txt']}`).check();   // a selected row and the ink strip
  const pairs: [string, string][] = [
    ['size', `[data-testid="fs-entry"][data-name="Prog"] .font-mono > span:first-child`],
    ['selected row date', `[data-testid="fs-entry"][data-name="Notes.txt"] .font-mono > span:last-child`],
    ['column head', '[data-testid="fs-columns"] > span:nth-child(3)'],
    ['footer', '[data-testid="fs-footer"]'],
    ['.info badge', `[data-testid="fs-info-${blk.Prog}"]`],
    ['DIR glyph', `[data-testid="fs-glyph-${blk.Docs}"]`],
    ['EXE glyph', `[data-testid="fs-glyph-${blk.Prog}"]`],
    ['set protection bit', `[data-testid="fs-protect-${blk.Prog}"] > span:nth-child(5)`],
    ['clear protection bit', `[data-testid="fs-protect-${blk.Prog}"] > span:nth-child(1)`],
    ['new in vN', `[data-testid="fs-new-${blk.Prog}"]`],
    ['selection button', '[data-testid="fs-bulk-move"]'],
    ['Current', '[data-testid^="current-"]'],
    ['version time', '[data-testid^="version-toggle-"] .font-mono'],
    ['+N chip', '[data-testid^="version-counts-"] > span:first-child'],
    ['drop bar sub line', '[data-testid="drop-strip"] .text-\\[12px\\]'],
    ['holder words', `[data-testid="holder-${disk.id}"]`],
  ];
  for (const [what, sel] of pairs) {
    const p = await probe(page, sel);
    expect(p, `${what}: ${sel} not found`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`disk-files ${what.padEnd(24)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 24)}"`);
    expect(r, what).toBeGreaterThan(4.5);
  }
  // A hovered row (surface-2) and a hovered older version: Restore… in --amber-text.
  await page.locator(`[data-testid="fs-entry"][data-name="Prog"]`).hover();
  const hovered = await probe(page, `[data-testid="fs-entry"][data-name="Prog"] .font-mono > span:first-child`);
  expect(ratio(hovered!.fg, hovered!.bg), 'size on a hovered row').toBeGreaterThan(4.5);
  await openVersion(page, 1);
  await page.getByTestId('version-1').hover();
  const restore = await probe(page, '[data-testid="restore-1"]');
  expect(ratio(restore!.fg, restore!.bg), 'Restore… on a hovered version').toBeGreaterThan(4.5);
  // The menu's Delete.
  await openRowMenu(page, blk.Prog);
  const del = await probe(page, `[data-testid="fs-delete-${blk.Prog}"]`);
  expect(ratio(del!.fg, del!.bg), 'menu Delete').toBeGreaterThan(4.5);
  await page.keyboard.press('Escape');
  // The banner and the version on screen (--viewing-bg).
  await page.goto(`/disks/${disk.id}/files?version=1`);
  for (const [what, sel] of [['banner text', '[data-testid="version-banner"] > span'],
    ['viewed version time', '[data-testid="version-toggle-1"] .font-mono']] as const) {
    const p = await probe(page, sel);
    expect(ratio(p!.fg, p!.bg), what).toBeGreaterThan(4.5);
  }
  await page.goto(`/disks/${disk.id}/files`);
  if (was !== 'true') await page.getByTestId('fs-hide-info').click();
  await page.screenshot({ path: 'test-results/zz-disk-files.png', fullPage: true });
});
```

(The selectors follow the Task 4 row markup; adjust a `:nth-child` to the DOM actually built — never loosen the
4.5 threshold. `readVolume` is imported from `@/lib/adffs`.)

- [ ] **Step 2: Run them to see them fail**

`pnpm test "src/app/(app)/disks/[id]/files/loading.test.ts"` → FAIL (no module).
`PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Disk files pairs"` → PASS or FAIL; it must be
green after Step 3 (if it already passes, the tokens of Tasks 1–6 are right — record the logged ratios).

- [ ] **Step 3: Implement**

`src/app/(app)/disks/[id]/files/loading.tsx`:

```tsx
import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The disk page while it loads (C4 spec 8.1): the crumb, the Disk card, then the files and the History side by side
// from xl. Nested under (app)/loading.tsx like the library's, the devices' and the upload page's, so status codes do
// not change.
export default function DiskFilesLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <PageSkeleton testId="disk-files-skeleton">
      <div className="flex flex-col gap-5 px-4 pb-10 pt-6 sm:px-7">
        <Bone className="h-3 w-56" />
        <div data-skeleton-disk className="flex flex-col gap-4 rounded-[20px] p-5 lg:flex-row lg:items-center" style={card}>
          <Bone className="h-[76px] w-[76px] shrink-0" />
          <div className="flex flex-1 flex-col gap-2"><Bone className="h-[34px] w-1/2" /><Bone className="h-3 w-2/3" /></div>
          <Bone className="h-2 w-full lg:w-[300px]" />
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex flex-col gap-2 rounded-[20px] p-4" style={card}>
            <Bone className="h-9 w-full" />
            {Array.from({ length: 8 }, (_, i) => <div key={i} data-skeleton-row><Bone className="h-10 w-full" /></div>)}
          </div>
          <div className="flex flex-col gap-2 rounded-[20px] p-4" style={card}>
            <Bone className="h-5 w-24" />
            {Array.from({ length: 5 }, (_, i) => <div key={i} data-skeleton-version><Bone className="h-[52px] w-full" /></div>)}
          </div>
        </div>
      </div>
    </PageSkeleton>
  );
}
```

`e2e/screenshots.shots.ts`: the `disk-files` shot (line ~240) already waits for `history-panel`; add
`await expect(page.getByTestId('disk-card')).toBeVisible();` before `shoot` if the shot lands mid-stream.

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test "src/app/(app)/disks/[id]/files/loading.test.ts" src/components/disks src/lib/disk-files-look.test.ts src/lib/design-tokens.test.ts` → PASS.
- `npx tsc --noEmit`; `pnpm lint`; `pnpm test` (whole) → PASS.
- `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop` → all pass, one test more than before (count
  with `--list`; the sign-in/sign-up loop makes two tests from one `test(` call).
- `PORT=3100 npx playwright test e2e/states.spec.ts --project=desktop` → all pass (`--list`: 7).
- `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → all pass (`--list`).
- Phone by hand (390×844, the dev server on 3100, a disk with a folder, a 30-character name, three versions): the
  breadcrumb wraps; the Disk card stacks; the Files header wraps; rows are two-line cards with a 44 px ⋯ and grip;
  the row menu, the rename and delete forms, the protection editor and the restore confirm fit; History is under
  the bar; `document.documentElement.scrollWidth === clientWidth` on `/disks/<id>/files` and on `?version=1`.
  Record what you saw in the report.

**Final regression** — every spec this area touches, one run at a time, each under 9 minutes, split with `-g` and
checked with `--list` so each file is covered whole:

1. `e2e/disk-files-layout.spec.ts` (whole) → `11 passed`.
2. `e2e/adf-browser.spec.ts` → `7 passed`; `e2e/breadcrumb.spec.ts` → `5 passed`.
3. `e2e/disk-files-edit.spec.ts` → `7 passed`; `e2e/disk-files-a5.spec.ts` → `8 passed`.
4. `e2e/disk-drag-drop.spec.ts` → `6 passed`; `e2e/archive-drop-folder.spec.ts` → all (`--list`);
   `e2e/archive-drop.spec.ts` → `2 passed`.
5. `e2e/time-machine.spec.ts` → `6 passed`; `e2e/disk-history.spec.ts` → `2 passed`.
6. `e2e/hd-disks.spec.ts` → `6 passed`; `e2e/hfe-disks.spec.ts -g "redirect|Browse|browsable"` (`--list`) → all
   selected pass.
7. `e2e/send-to-amiga.spec.ts -g "Browse"` → `1 passed`; `e2e/game-detail.spec.ts -g "disk page|Disk Page|disk's own page"`
   (`--list`) → all selected pass.
8. `e2e/library-table.spec.ts -g "card controls|fob button"` → `2 passed`; `e2e/nfc-fob-button.spec.ts -g "history"`
   (`--list`) → pass.
9. `e2e/help.spec.ts` → all pass; `e2e/help.mobile.spec.ts --project=mobile` → all pass.
10. `e2e/mobile.spec.ts --project=mobile -g "file tree row|file toolbar|drop strip"` → `3 passed`; then the rest of
    `mobile.spec.ts` once in `-g` slices under 9 minutes (`--list` the titles) → all pass except anything the C3 /
    C2 ledgers already list as pre-existing elsewhere (record, do not chase).
11. `e2e/contrast.spec.ts`, `e2e/states.spec.ts`, `e2e/shell.spec.ts` (from above).

Then `PORT=3100 pnpm screenshots` and compare `docs/screenshots/disk-files.png` with ModernDiskFiles by eye (the Disk
card, the banner absent, the Files grid with the ⋯ column, the History aside at the right with the head open).
Commit ONLY `docs/screenshots/disk-files.png` by name; the run regenerates the other PNGs too — restore each with
`git checkout -- docs/screenshots/<name>.png` (never with stash) and confirm `git status --short docs/screenshots`
lists only `disk-files.png`.

- [ ] **Step 5: Commit** — `src/app/(app)/disks/[id]/files/loading.tsx`, `loading.test.ts`, `e2e/contrast.spec.ts`,
  `e2e/screenshots.shots.ts` (if changed), `docs/screenshots/disk-files.png`, message
  `Disk files C4: loading skeleton, contrast pairs, phone check, screenshot`.

---

## Self-review (against the spec)

- §1 page frame, §2 Disk card, §3 banner words + Back → Task 2; §3 Restore this version + the redirect → Task 5.
- §4.1 header, §4.2 selection strip, §4.3 column heads, §4.5 footer, §4.6 no filesystem, §8.2 empty disk → Task 3.
- §5.1–5.4 rows, menu, inline forms, §5.5 look rules (used) → Task 4; §5.5 (written) → Task 1.
- §6 drop bar → Task 6. §7 History, §7.4 confirm → Task 5. §8.1 loading, §11 contrast (page), §12 phone, screenshot
  → Task 7. §11 contrast (tokens) and the six tokens → Task 1. §9 focus → Tasks 3 (bulk), 4 (delete, forms), 5
  (restore), 6 (commit).
- §10.4 spec edits → Task 4 (menu sites, mobile :221/:367), Task 5 (versions, time-machine :167/:246/:268, :212),
  Task 6 (mobile :455). §13 help → Tasks 4 (`send`) and 5 (`write-back`).
- Expected pass counts assume the spec files as of `c25c9fb` plus this plan's additions (disk-files-layout: 2 after
  Task 2 → 4 after Task 3 → 7 after Task 4 → 10 after Task 5 → 11 after Task 6). If a count differs, recount with
  `--list` before calling it a failure.
