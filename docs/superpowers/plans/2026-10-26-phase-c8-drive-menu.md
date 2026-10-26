# Phase C8 Header drive menu, simple version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each board's header chip takes the board's look (40 px, the name at 14 px, the disk in mono, the WP/RW tag,
no "n/N"), and its menu becomes a panel: a "Controlling" / "Manage devices" head row and one card per board with the
disk icon, "<board> · DF0", "<title> · disk n of N", an Online/Offline pill, a Write-protect switch, Next, Eject and a
board-settings gear that opens that board's existing Board settings modal on `/devices`. Same requests, same data path,
no optimistic state, every drive-chip test id kept.

**Architecture:** `src/lib/drive-chips.ts` gains two fields (`DriveChipDisk.diskCount`, `DriveChip.seen`), the disk
line's words (`diskLine`), the Next button's words (`nextLabel`) and a board-count-aware `chipSlots`. In
`src/components/shell/drive-chips.tsx` the Base UI **Menu** becomes a Base UI **Popover** (`role="dialog"`), shared by
the chip, the "+k" chip and the compact control through one `usePanel()` hook (open state, close reason, focus rules)
and one `PanelPopup`; every action goes through one `usePanelAction()` hook (busy = `aria-disabled` + guard +
`aria-busy`, try/catch/finally, refresh in a transition). The gear is a link to `/devices?settings=<id>`;
`DeviceList` reads the parameter with `useSearchParams()`, the matching card's `BoardSettings` opens itself once, and
the parameter is stripped with `history.replaceState`. No schema, no migration, no new route, no new package.

**Tech Stack:** Next.js 16.3.2 App Router, React 19.2.8, Tailwind v4, Base UI 1.7.0 (`@base-ui/react/popover`), sonner,
vitest 4 (`renderToStaticMarkup` render tests in node, no DOM), Playwright 1.62. Read before Task 4 (read for this
plan): `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` § "Native History API"
(`window.history.replaceState` integrates with the Next router and keeps `useSearchParams` / `usePathname` in sync),
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` (a Client Component hook; on a
*prerendered* route it client-renders up to the nearest `Suspense`; `/devices` calls `requireOrg()`, which reads
cookies, so it is rendered per request and needs no boundary, as `game-table.tsx` and `library-pager.tsx` already rely
on), and `.../03-file-conventions/page.md` § `searchParams` (a Promise in Next 16; read with `await` or `use`). Read
before Task 3: `node_modules/@base-ui/react/popover/root/PopoverRoot.d.ts` and `popup/PopoverPopup.d.ts` (read for
this plan: `onOpenChange(open, details)` carries `details.reason` — `'trigger-press'`, `'outside-press'`,
`'escape-key'`, `'focus-out'`, `'imperative-action'`; `finalFocus` as a function receives only the **interaction
type** (`mouse` / `touch` / `pen` / `keyboard`), never the close reason; the Trigger writes `aria-haspopup="dialog"`
and the Popup `role="dialog"` itself).

**Spec:** `docs/superpowers/specs/2026-10-26-phase-c8-drive-menu-design.md`. It is binding: read all of it, including
§9's test lists and the 25 Rulings. Where this plan resolves a spec gap or a conflict it says so in a line starting
**Plan ruling**, and the controller relays those to the operator.

## Global Constraints

- Every `data-testid` in spec §9.1 keeps its name and its meaning: `drive-chips`, `drive-chip-<id>` (+ `data-phase`,
  `data-online`, `title`), `drive-chip-name-<id>`, `drive-chip-disk-<id>`, `drive-chip-wp-<id>`, `drive-chip-more`,
  `drive-chip-more-menu`, `drive-chip-menu-<id>`, `drives-compact`, `drives-compact-menu`, `drive-entry-<id>`,
  `drive-entry-link-<id>`, `drive-entry-status-<id>`, `drive-entry-disk-<id>`, `drive-entry-df1-<id>`,
  `drive-goto-<id>`, `drive-protect-<id>` (+ `data-protected`), `drive-next-<id>`, `drive-preload-<id>`
  (+ `data-preload`), `drive-eject-<id>`. New (§9.2): `drive-panel-manage`, `drive-entry-offline-<id>`,
  `drive-settings-<id>`, `drives-compact-name`, `drives-compact-disk`, `drives-compact-wp`. None is removed. The
  attribute `data-drive-panel` (on every panel popup) is not a test id.
- No schema change, no DB migration, no new API route, no new package. If a task believes one is needed, STOP and
  report. A subagent never runs `drizzle-kit`, `pnpm db:migrate` or writes under `drizzle/`.
- Kept as shipped: `POST /api/devices/[id]/eject`, `POST /api/devices/[id]/next`, `PATCH /api/disks/[id]
  {writeProtected}`, `PATCH /api/devices/[id]/boot-disk`, and every toast `requestEject`, `requestNextDisk` and
  `requestWriteProtect` raise (`src/components/devices/device-actions.ts` is not edited).
- **No optimistic state.** The chip and the card render only what the layout's rows say. The panel holds no copy of
  server state, only busy flags.
- **Show both values of a state**: Online/Offline is a word in a pill and, on the chip, a filled dot vs a hollow ring;
  the switch shows on and off; an empty drive says "Drive empty"; WP and RW are both tags. No `sr-only` element
  carries a width or layout utility.
- **Busy controls use `aria-disabled` plus a guard in the handler, never native `disabled`**: Chromium blurs a focused
  button the moment it becomes disabled, and focus falls to `<body>`. `data-disabled=""` mirrors `aria-disabled` on
  every panel control (Ruling 17).
- **Use try/catch/finally on every request**, so a dropped connection never leaves a control busy.
- **Focus never lands on `<body>`.** Spec §6 names every fallback; this plan implements each one (Task 3).
- **Live regions are present from first paint.** This phase adds none; the toasts are sonner's, whose region is
  mounted by the layout from the first paint. A task that adds a `role="status"` renders it empty first.
- **Call `hydrated(page, testId, handler)` from `e2e/device-helpers.ts` before synthetic events**, and before the first
  click or tap on a client control that has a test id (the chip, "+k", the compact control).
- **Self-hosted deployments keep full parity**: no new external URL, font, service or our-deployment-only word.
- The admin plane renders no chip and no panel.
- Firmware, `wifi-floppy/`, the board and the Amiga are not touched.
- Colours only through tokens. **Any colour that changes between states or widths lives in a class
  (`bg-(--surface)`, `data-[popup-open]:border-(--ink)`), never in an inline `style`**, because an inline colour beats
  a class.
- Next.js 16.3: read the guides named in Tech Stack in `node_modules/next/dist/docs/` before writing the
  `/devices?settings=` entry point, and heed their deprecation notices.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): a real `pnpm install --offline`, `.env.local` present
  (never print it, never `cat` it, never echo a value from it), `npx next typegen`, and the `adf-archive` symlink.
- **Unit tests: `pnpm test --testTimeout=30000 <files>`**, with no `--` before the flag. Types: `npx tsc --noEmit`. The
  whole unit suite (`pnpm test --testTimeout=30000`) is green before each commit; no commit follows a red run.
- **Lint today: `✖ 12 problems (0 errors, 12 warnings)`** (measured on `cf561fe`, this branch's base). It must read
  exactly that after every task and exit 0: no new error and no new warning.
- **e2e: `PORT=3100`, one run at a time, in the foreground (never `run_in_background`), each run under 9 minutes, and
  every run timed** (prefix the command with `time` and record the wall time in the task report). The suite hits the
  **LIVE production DB**: use the helpers' teardown (`test.afterAll(cleanupSeeded)` in every new spec file, and a
  `finally` that deletes any board made in the super-admin's org), and assert only about rows a test made (fresh
  sign-ups, `runTag()`), never absolute counts.
- **The `mobile` Playwright project only runs files ending in `mobile.spec.ts`** (390 × 844, `hasTouch`, `isMobile`).
  It emulates touch, so `hover:` styles never apply there: **hover assertions go in desktop specs only.** Every other
  spec runs in `desktop` (1280 × 720) and sets other widths with `setViewportSize`.
- **After any header change, run every spec that reads the Main nav, the drive chips or `aria-current`** (grep, run on
  `cf561fe`: `collections`, `shell`, `c6-admin-layout`, `header-overlap`, `contrast`, `breadcrumb`, `drive-chips`,
  `c5-layout`, `library-paging`, `c7-phone.mobile`, `next-disk`). A hidden but mounted element can break an unscoped
  locator (the xl chip and the compact control are both mounted at every width): scope with `:visible` or
  `.filter({ visible: true })`.
- House rules, every task: re-check `git status --short` before staging (other sessions change this tree), then
  **`git add <paths>`, never `-A` or `.`**, and never anything under `wifi-floppy/` or `.superpowers/`. No `git stash`
  in any form. Stop only your own PIDs; never pattern-kill. Every commit message ends with exactly these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`
- **Screenshots never show an email address or board name.** The e2e helpers' fake board names (`Bench`, `C8 …`) are
  fine; the live operator's boards never appear (every shot signs up fresh). Mask `account-email` and `admin-email`.
  No screenshot is committed.

## Review Focus

1. **A second press on the same board's gear after the URL was stripped** (open Board settings from the header, Cancel,
   open the same chip's panel on `/devices`, press the gear again): the modal must open again. A server `searchParams`
   prop would not change after `replaceState`, so the second press would do nothing (Plan ruling, Task 4). Pinned in
   Task 4's `C8-07`.
2. **Pressing the search field while a panel is open**: the panel closes and the field keeps focus; Base UI's default
   would hand focus back to the chip and steal it. Pinned in Task 3's `C8-08`.
3. **The board is deleted (another tab) while its own chip's panel is open**: the chip and its popup unmount and focus
   would fall to `<body>`; it must land on `wordmark-home` (Ruling 21). Pinned in Task 3's `C8-16`.
4. **One board with a long name and a long title at 1024–1279 px**: the compact control now shows the board's chip
   look instead of "● Drives 1" (90 px), and must not push the in-flow nav pill under the search box or clip a tab.
   Pinned in Task 5's `C8-17`.
5. **Write-protect with a dropped connection**: the switch must come back from busy with its reading unchanged (the
   spec's network test, C8-06, covers only Eject). Pinned in Task 3's `C8-06`.

## Common commands

- Unit: `pnpm test --testTimeout=30000 <path> [<path> …]`; all of them: `pnpm test --testTimeout=30000`; types:
  `npx tsc --noEmit`; lint: `pnpm lint; echo "exit $?"` → `✖ 12 problems (0 errors, 12 warnings)` and `exit 0`.
- e2e, desktop: `time PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<pattern>"]`.
- e2e, mobile: `time PORT=3100 npx playwright test e2e/<name>.mobile.spec.ts --project=mobile [-g "<pattern>"]`.
- Before each `-g` run, check that the pattern selects what the step says with
  `npx playwright test <file> --project=<p> --list [-g "<pattern>"]`. `-g` is a case-sensitive RegExp, so a pattern
  holds no unescaped `(`, `)`, `?` or `+`. If a count differs from the step, recount with `--list` before calling it a
  failure.
- The new specs are **`e2e/c8-drive-menu.spec.ts`** (desktop) and **`e2e/c8-drive-menu.mobile.spec.ts`** (mobile).
  Their tests are named `C8-NN` (with `a`/`b` halves) so batches can select them.
- Per-test times for sizing batches, from earlier runs: a sign-up is about 5 s, a pairing 1 s, a seeded mount 1–2 s, a
  live wait up to 8 s, a layout test 15–40 s, the worst-case chip test 60–90 s. A file of more than about 15 tests is
  split into `-g` halves.

## File map

| File | Task | What changes |
|---|---|---|
| `src/lib/drive-chips.ts` + `drive-chips.test.ts` | 1 | `diskNo` always, `diskCount`, `seen`, `diskLine`, `nextLabel`, `chipSlots(w, showAdmin, boards)`, `MAX_CHIPS = 2` |
| `src/components/shell/drive-chips.tsx` | 2, 3, 5 | chip look + slot CSS on the old Menu (2); whole file on Popover (3); compact one-board face (5) |
| `src/components/shell/drive-chips.test.ts` (new) | 2, 3, 5 | render tests: closed chips and slot classes (2); `DriveCard` per state (3); the compact face (5) |
| `src/components/games/write-protect-toggle.tsx:38-46` | 3 | `WpSwitch` gains `small` (28 × 16) |
| `src/app/globals.css` (a new `@layer components` block after line 388) | 3 | `.drive-panel` max-height, and below lg above the bottom bar |
| `src/components/devices/device-list.tsx`, `device-card.tsx`, `board-settings.tsx` | 4 | `?settings=<id>` read, strip, open on arrival |
| `e2e/c8-drive-menu.spec.ts` (new) | 2, 3, 4, 5 | C8-01a, C8-11 (2); C8-01b–06, 08–10, 14, 16 (3); C8-07 (4); C8-17 (5) |
| `e2e/c8-drive-menu.mobile.spec.ts` (new) | 5 | C8-12, C8-13 |
| `e2e/drive-chips.spec.ts` | 2, 3, 5 | slots (2); dialog, words, panel stays open, focus (3); 390 at 44 px (5) |
| `e2e/next-disk.spec.ts` | 3 | "Next: disk n", panel stays open |
| `e2e/contrast.spec.ts` | 6 | one appended test (C8-15) |

---

### Task 1: The data: `diskCount`, `seen`, `diskLine`, `nextLabel`, and slots that know the board count

**Files:**
- Modify: `src/lib/drive-chips.ts` (whole areas named below), `src/lib/drive-chips.test.ts`

**Interfaces:**
- Consumes: `relative(from: Date | null, now: number): string` (`@/lib/device-state`, already imported module),
  `NextInfo` (type, `@/lib/next-disk`).
- Produces (all from `@/lib/drive-chips`):
  - `DriveChipDisk` gains `diskCount: number | null`; `diskNo: number | null` is now the reported number on every
    title (it was null on one-disk titles).
  - `DriveChip` gains `seen: string | null` — `relative(lastSeenAt, now)` while offline (e.g. `"5m ago"`), null online.
  - `type DiskLine = { kind: 'title'; title: string; count: string | null } | { kind: 'text'; text: string }`
  - `diskLine(c: DriveChip): DiskLine`
  - `nextLabel(next: NextInfo): { text: string; name: string }`
  - `chipSlots(viewportWidth: number, showAdmin = false, boards = 1): number`
  - `MAX_CHIPS = 2`

**Plan ruling** (spec Ruling 4, "`DriveChipDisk` gains `diskCount`"): `diskNo` stops being nulled on a one-disk title,
so `diskLine` can say "disk 1 of 1" from the two reported numbers. The unit test "leaves the disk number off a one-disk
game" is replaced by one that pins both numbers. Until Task 3 the old menu's heading reads "<title> · disk 1" on a
one-disk title; Task 3 replaces that heading.

**Plan ruling** (spec §4.3, "`title`/`aria-label` 'Next disk: disk n of N'"): the accessible name is
**"Next: disk n of N"** (+ " (wraps)"), so the visible words "Next: disk n" start the name (WCAG 2.5.3, label in
name; "Next disk: disk 2 of 2" does not contain "Next: disk 2"). `nextLabel` returns both strings.

**Plan ruling** (spec §2.1's table): no width gives three chips any more, so `MAX_CHIPS` becomes 2; `splitChips` keeps
its default and hands at most two chips to the header.

- [ ] **Step 1: Write the failing tests**

In `src/lib/drive-chips.test.ts`, change the import on line 2 to:

```ts
import { MAX_CHIPS, chipSlots, diskLine, diskText, driveChips, nextLabel, preloadText, protectTag, splitChips, toDriveChip } from './drive-chips';
```

Replace the test at lines 72-74 (`it('leaves the disk number off a one-disk game', …)`) with:

```ts
  it('carries the disk number and the title\'s disk count on every title, one-disk ones included (C8 Ruling 4)', () => {
    expect(chip(loaded).disk).toMatchObject({ diskNo: 1, diskCount: 2 });
    expect(chip({ ...loaded, mountedDiskCount: 1 }).disk).toMatchObject({ diskNo: 1, diskCount: 1 });
  });

  it('says how long ago an offline board was seen, and nothing while it is online', () => {
    expect(chip(loaded).seen).toBeNull();
    expect(chip({ ...loaded, lastSeenAt: new Date(NOW - 5 * 60_000) }).seen).toBe('5m ago');
    expect(chip({ ...loaded, lastSeenAt: null }).seen).toBe('never');
  });
```

Replace the whole `describe('chipSlots', …)` block (lines 172-191) with:

```ts
describe('chipSlots (C8 spec §2.1: the 240 px chip)', () => {
  it.each([
    [390, 0], [1279, 0], [1280, 1], [1535, 1], [1536, 1], [1919, 1], [1920, 2], [2560, 2],
  ])('a member at %ipx has room for %i chip(s), whatever the board count', (w, n) => {
    for (const boards of [1, 2, 5]) expect(chipSlots(w, false, boards), `${boards} boards`).toBe(n);
  });

  it.each([
    [1280, 1, 1], [1280, 2, 0], [1280, 4, 0], [1535, 2, 0], [1536, 2, 1], [1919, 3, 1], [1920, 2, 2], [2560, 4, 2],
  ])('with the Admin item, at %ipx with %i board(s): %i chip(s) -- none at 1280-1535 once "+k" is needed', (w, boards, n) => {
    expect(chipSlots(w, true, boards)).toBe(n);
  });

  it('below xl there is never a chip, and never more than MAX_CHIPS', () => {
    expect(chipSlots(1279, true, 1)).toBe(0);
    expect(MAX_CHIPS).toBe(2);
    expect(chipSlots(10_000)).toBeLessThanOrEqual(MAX_CHIPS);
    expect(chipSlots(10_000, true, 9)).toBeLessThanOrEqual(MAX_CHIPS);
  });
});
```

Replace the two `splitChips` tests (lines 194-200) with:

```ts
  it('shows every chip when there are two or fewer', () => {
    expect(splitChips([1, 2])).toEqual({ shown: [1, 2], rest: [] });
  });

  it('shows two and puts the rest behind "+k"', () => {
    expect(splitChips([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2], rest: [3, 4, 5] });
  });
```

Append at the end of the file:

```ts
describe('diskLine: the card\'s second line, in words for every phase (C8 spec §3.3)', () => {
  it('a loaded disk is its title and "disk n of N", "disk 1 of 1" included', () => {
    expect(diskLine(chip(loaded))).toEqual({ kind: 'title', title: 'Turrican', count: 'disk 1 of 2' });
    expect(diskLine(chip({ ...loaded, mountedDiskCount: 1 }))).toEqual({ kind: 'title', title: 'Turrican', count: 'disk 1 of 1' });
  });
  it('an unknown count leaves the count off rather than guessing', () => {
    expect(diskLine(chip({ ...loaded, mountedDiskCount: null }))).toEqual({ kind: 'title', title: 'Turrican', count: null });
  });
  it('an empty drive, a load and an eject are words', () => {
    expect(diskLine(chip(empty))).toEqual({ kind: 'text', text: 'Drive empty' });
    expect(diskLine(chip({ ...loaded, desiredDiskId: 'disk-2', desiredSha256: B, desiredGameTitle: 'Lotus' })))
      .toEqual({ kind: 'text', text: 'Loading Lotus…' });
    expect(diskLine(chip({ ...loaded, desiredDiskId: 'disk-2', desiredSha256: B, desiredGameTitle: null })))
      .toEqual({ kind: 'text', text: 'Loading a disk…' });
    expect(diskLine(chip({ ...loaded, desiredDiskId: null, desiredSha256: null })))
      .toEqual({ kind: 'text', text: 'Ejecting Turrican…' });
  });
  it('a digest without a disk row (older firmware) is "A disk", with no count and nothing to link', () => {
    expect(diskLine(chip({ ...loaded, mountedDiskId: null, mountedGameId: null, mountedGameTitle: null })))
      .toEqual({ kind: 'text', text: 'A disk' });
  });
});

describe('nextLabel: the Next button\'s words and its accessible name (Plan ruling, WCAG 2.5.3)', () => {
  it('the name starts with the visible words, then the count, then the wrap', () => {
    expect(nextLabel({ diskNo: 2, diskCount: 3, wraps: false, preload: null }))
      .toEqual({ text: 'Next: disk 2', name: 'Next: disk 2 of 3' });
    expect(nextLabel({ diskNo: 1, diskCount: 2, wraps: true, preload: 'ready' }))
      .toEqual({ text: 'Next: disk 1', name: 'Next: disk 1 of 2 (wraps)' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/drive-chips.test.ts`
Expected: FAIL — `diskLine` and `nextLabel` are not exported, `seen` and `diskCount` are undefined, `chipSlots(1536)`
returns 2, `splitChips` shows three.

- [ ] **Step 3: Implement**

In `src/lib/drive-chips.ts`:

Line 1 becomes `import { deviceState, isOnline, relative, type DeviceState } from '@/lib/device-state';`.

In `DriveChipDisk`, replace the `diskNo` member (lines 45-46) with:

```ts
  /** The disk's number in its title as reported (mountedDiskNo), or null when unknown. Shown on every title, a
   *  one-disk title included ("disk 1 of 1", C8 Ruling 4). */
  diskNo: number | null;
  /** How many disks its title has (mountedDiskCount, already in the live fingerprint), or null when unknown. */
  diskCount: number | null;
```

In `DriveChip`, after `df1: string | null;` (line 93) add:

```ts
  /**
   * While offline: how long ago the board was last heard from, `relative()`'s words ("5m ago"). Null while online.
   * The same text the live fingerprint hashes for every offline board, so the card's offline line never freezes.
   */
  seen: string | null;
```

In `toDriveChip`, in the `disk` object replace `diskNo: (r.mountedDiskCount ?? 0) > 1 ? r.mountedDiskNo : null,` with

```ts
          diskNo: r.mountedDiskNo,
          diskCount: r.mountedDiskCount,
```

and in the returned object, replace `online: isOnline(r.lastSeenAt, now),` with

```ts
    online: isOnline(r.lastSeenAt, now),
    seen: isOnline(r.lastSeenAt, now) ? null : relative(r.lastSeenAt, now),
```

Replace `export const MAX_CHIPS = 3;` and the whole `chipSlots` doc comment and function (lines 152-183) with:

```ts
/** At most `max` chips in the header; the rest go behind a "+k" chip. No width fits three 240 px chips. */
export const MAX_CHIPS = 2;

/**
 * How many chips fit beside the wordmark at a viewport width (0 below xl, where the compact control is used
 * instead). `showAdmin` is the layout's own flag (the Admin item widens the pill) and `boards` how many boards the org
 * has (whether a "+k" chip has to fit too).
 *
 * C8 (spec §2.1), by arithmetic on 2026-10-26: the chips start 16 px after the wordmark (x = 168) and stop 16 px
 * short of the viewport-centred pill (left edge 481 / 609 / 801 for a member, 443 / 571 / 763 with Admin, at 1280 /
 * 1536 / 1920). The widest chip is its 240 px cap, chips sit 6 px apart, and "+k" keeps its compact ~45 px. So
 * n chips + "+k" end at 168 + 246n + 45:
 *   - member:     1 + "+k" ends at 459 (<= 465) / 459 (<= 593) / 2 + "+k" 705 (<= 785)  -> 1 / 1 / 2
 *   - with Admin: one board alone ends at 408 (<= 427), but 1 + "+k" at 459 runs past 427 at 1280 -> 0 there,
 *                 the compact control instead; 459 (<= 555) at 1536; 705 (<= 747) at 1920    -> 0 or 1 / 1 / 2
 * drive-chips.spec measures the widest case for both, at all three widths; Task 2 of the C8 plan records the measured
 * widths here. The CSS in drive-chips.tsx mirrors these breakpoints literally (Tailwind cannot read them from here).
 */
export function chipSlots(viewportWidth: number, showAdmin = false, boards = 1): number {
  if (viewportWidth >= 1920) return 2;
  if (viewportWidth >= 1536) return 1;
  if (viewportWidth >= 1280) return showAdmin && boards >= 2 ? 0 : 1;
  return 0;
}
```

After `protectTag` (end of file) append:

```ts
/** The card's second line (C8 spec §3.3): the title (a link when there is a game) and its count, or words. */
export type DiskLine = { kind: 'title'; title: string; count: string | null } | { kind: 'text'; text: string };

export function diskLine(c: DriveChip): DiskLine {
  switch (c.phase) {
    case 'empty': return { kind: 'text', text: 'Drive empty' };
    case 'loading': return { kind: 'text', text: `Loading ${c.loadingTitle ?? 'a disk'}…` };
    case 'ejecting': return { kind: 'text', text: `Ejecting ${c.disk?.title ?? 'a disk'}…` };
    case 'loaded':
      if (!c.disk) return { kind: 'text', text: 'A disk' };
      return {
        kind: 'title',
        title: c.disk.title,
        count: c.disk.diskNo !== null && c.disk.diskCount !== null ? `disk ${c.disk.diskNo} of ${c.disk.diskCount}` : null,
      };
  }
}

/**
 * The Next button's words (the Devices card's) and its accessible name. The name starts with the visible words, so a
 * speech user can say what they see (WCAG 2.5.3); the count and the wrap follow.
 */
export function nextLabel(next: NextInfo): { text: string; name: string } {
  return {
    text: `Next: disk ${next.diskNo}`,
    name: `Next: disk ${next.diskNo} of ${next.diskCount}${next.wraps ? ' (wraps)' : ''}`,
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/drive-chips.test.ts` → PASS.
Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint; echo "exit $?"` → all green; lint
`✖ 12 problems (0 errors, 12 warnings)`, `exit 0`. (`src/components/shell/drive-chips.tsx` still compiles: it calls
`chipSlots(window.innerWidth, showAdmin)` and reads `disk.diskNo`, both still valid.)

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/drive-chips.ts src/lib/drive-chips.test.ts
git commit -m "C8: drive chip data: disk n of N on every title, the offline seen text, the disk line and Next words, slots for a 240 px chip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 2: The chip's look (40 px, 14 px name, mono disk, WP tag) and the re-derived slots, measured

**Files:**
- Create: `src/components/shell/drive-chips.test.ts`, `e2e/c8-drive-menu.spec.ts`
- Modify: `src/components/shell/drive-chips.tsx:54-226` (the blocks named in Step 3), `src/lib/drive-chips.ts`
  (`chipSlots` comment, Step 5), `e2e/drive-chips.spec.ts:314-370`, `:391-405`, `:453-463`

**Interfaces:**
- Consumes: Task 1's `chipSlots(w, showAdmin, boards)`, `MAX_CHIPS`, `diskText`, `protectTag`.
- Produces (inside `drive-chips.tsx`, used again by Tasks 3 and 5):
  - `CHIP_CLASS` (string): the board chip's look, also the compact control's.
  - `MORE_CLASS` (string): the "+k" chip's.
  - `ChipFace({ chip, ids }: { chip: DriveChip; ids: 'chip' | 'compact' })`: dot, name, disk, tag, chevron, with the
    `drive-chip-*-<id>` ids (`ids="chip"`) or the `drives-compact-*` ids (`ids="compact"`).
  - `CHIP_VISIBILITY = ['flex', 'hidden min-[1920px]:flex']`, `moreVisibility(n: number): string`.
  - The `late` rule: `chipSlots(1280, showAdmin, chips.length) === 0` puts `drive-chips` on `2xl:flex` and the compact
    wrapper on `2xl:hidden` (instead of `xl:`).
  - e2e helpers in `e2e/c8-drive-menu.spec.ts`: `LIVE`, `sha`, `setDevice`, `onlineBoard`, `mountAndConverge`,
    `loadedBoard`, `chip`, `panel`.

**Plan ruling** (spec §2, "padding `0 10px 0 12px`, gap 8 px" for the chip): the "+k" chip keeps today's compact
`px-2 gap-1 text-[12px]` at the new 40 px height. With the board chip's padding and gap it measures about 61 px, and
one 240 px chip plus a 61 px "+k" ends at 475, past the member pill's 465 limit at 1280 (and the centring test's 16 px
gaps fail). At ~45 px it ends at 459.

**Plan ruling** (spec §2, the sr-only "write-protected" / "writable"): the sr-only word sits **beside** the
`drive-chip-wp-<id>` span, not inside it, so every existing `toHaveText('WP')` keeps its meaning.

**Plan ruling** (spec §2, `max-w-[240px]`): the cap is `lg:max-w-[240px]`, because below lg the compact control,
which shares `CHIP_CLASS`, fills the 390 px header row (`max-lg:w-full`).

- [ ] **Step 1: Write the failing tests**

`src/components/shell/drive-chips.test.ts` (new):

```ts
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DriveChip } from '@/lib/drive-chips';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => '/library',
}));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {}, message: () => {} } }));

const { DriveChips } = await import('./drive-chips');

/** A converged, online board holding disk 1 of a two-disk title, protected. */
const base: DriveChip = {
  id: 'dev-a', name: 'Bench', shortName: 'Bench', online: true, state: 'converged', phase: 'loaded',
  disk: { id: 'disk-1', gameId: 'gam-1', title: 'Turrican', diskNo: 1, diskCount: 2, writeProtected: true, readOnly: null },
  loadingTitle: null, canGoTo: true, canToggleProtect: true, canEject: true,
  next: { diskNo: 2, diskCount: 2, wraps: false, preload: null }, df1: null, seen: null,
};
const two = [base, { ...base, id: 'dev-b', name: 'Shelf', shortName: 'Shelf' }];
const chips = (list: DriveChip[], showAdmin = false) =>
  renderToStaticMarkup(createElement(DriveChips, { chips: list, showAdmin }));
/** The opening tag of the element carrying `testId`. */
const openTag = (html: string, testId: string) =>
  html.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

describe('the chip (C8 spec §2, Rulings 2, 3)', () => {
  it('is 40 px (44 below lg), capped at 240 px from lg, surface-2 on the line, ink-bordered surface when open', () => {
    const t = openTag(chips([base]), 'drive-chip-dev-a');
    for (const c of ['h-10', 'max-lg:h-11', 'lg:max-w-[240px]', 'bg-(--surface-2)', 'border-(--line)',
      'data-[popup-open]:bg-(--surface)', 'data-[popup-open]:border-(--ink)']) expect(t, c).toContain(c);
  });
  it('shows the name, the disk in mono, the WP tag with its word beside it, and no "n/N"', () => {
    const html = chips([base]);
    expect(openTag(html, 'drive-chip-name-dev-a')).toContain('max-w-[6rem]');
    expect(html).toMatch(/data-testid="drive-chip-name-dev-a"[^>]*>Bench</);
    expect(openTag(html, 'drive-chip-disk-dev-a')).toContain('font-mono');
    expect(html).toMatch(/data-testid="drive-chip-disk-dev-a"[^>]*>Turrican</);
    expect(html).toMatch(/data-testid="drive-chip-wp-dev-a"[^>]*>WP<\/span><span class="sr-only">write-protected<\/span>/);
    expect(html).not.toMatch(/\d+\s*\/\s*\d+/);
  });
  it('an offline board wears the hollow ring and the word', () => {
    const html = chips([{ ...base, online: false, seen: '5m ago' }]);
    expect(html).toContain('border:1.5px solid var(--muted)');
    expect(html).toContain('<span class="sr-only">Offline</span>');
  });
});

describe('slots (C8 spec §2.1)', () => {
  it('a member: chips from xl, the compact control below it; the second chip from 1920; "+k" until 1920 with two', () => {
    const html = chips(two);
    expect(openTag(html, 'drive-chips')).toContain('xl:flex');
    expect(openTag(html, 'drive-chips')).not.toContain('2xl:flex');
    expect(openTag(html, 'drive-chip-dev-b')).toContain('hidden min-[1920px]:flex');
    expect(openTag(html, 'drive-chip-more')).toContain('flex min-[1920px]:hidden');
    expect(html).toContain('xl:hidden');
  });
  it('the super-admin with two or more boards: no chip below 2xl, the compact control until then', () => {
    const html = chips(two, true);
    expect(openTag(html, 'drive-chips')).toContain('2xl:flex');
    expect(html).toContain('2xl:hidden');
  });
  it('the super-admin with one board keeps the chip from xl', () => {
    expect(openTag(chips([base], true), 'drive-chips')).not.toContain('2xl:flex');
  });
  it('"+k" shows one number per band: n-1 below 1920, n-2 from it', () => {
    const html = chips([...two, { ...base, id: 'dev-c', name: 'Zed', shortName: 'Zed' }]);
    expect(html).toMatch(/<span class="min-\[1920px\]:hidden">\+2<\/span><span class="hidden min-\[1920px\]:inline">\+1<\/span>/);
    expect(openTag(html, 'drive-chip-more')).toContain('px-2');
  });
  it('renders no third chip: MAX_CHIPS is 2', () => {
    expect(chips([...two, { ...base, id: 'dev-c', name: 'Zed', shortName: 'Zed' }])).not.toContain('data-testid="drive-chip-dev-c"');
  });
});
```

`e2e/c8-drive-menu.spec.ts` (new):

```ts
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded, hydrated } from './device-helpers';

/**
 * Phase C8 (spec 2026-10-26-phase-c8-drive-menu-design.md §9.5): the header drive chip and its panel, measured.
 * Every state is driven the way a real board drives it (a mount through the app, then /api/device/status); only
 * online/offline is written into the row, as drive-chips.spec does. The DB is the live one: every assertion is about
 * rows the test made. Names are C8-NN so batches can select them with -g.
 */
test.afterAll(cleanupSeeded);

// LiveRefresh's 3 s tick plus a request and a re-render.
const LIVE = { timeout: 8_000 };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function setDevice(deviceId: string, patch: Partial<typeof devices.$inferInsert>) {
  await getDb().update(devices).set(patch).where(eq(devices.id, deviceId));
}

/** A paired board, online, carrying `name` as its alias (register names every board "Device <MAC>"). */
async function onlineBoard(page: Page, request: APIRequestContext, name: string) {
  const board = await pairDevice(page, request, name);
  await setDevice(board.deviceId, { name, lastSeenAt: new Date() });
  return board;
}

/** Mount through the app, then have the board report it holds the disk. */
async function mountAndConverge(
  page: Page, request: APIRequestContext,
  board: { deviceId: string; token: string }, disk: { diskId: string; sha256: string },
) {
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId: disk.diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token),
    data: { mountedSha256: disk.sha256, mountedDiskId: disk.diskId, version },
  })).status()).toBe(204);
}

/** A board named `name`, online, that reported holding disk 1 of a `disks`-disk title (protected, seedDisk's default). */
async function loadedBoard(page: Page, request: APIRequestContext, orgId: string, name: string, disks = 2) {
  const board = await onlineBoard(page, request, name);
  const tag = runTag();
  const title = `C8 ${name} ${tag.slice(-5)}`;
  const s1 = sha(`c8-${tag}-1`);
  const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: s1 });
  for (let n = 2; n <= disks; n++) await addDisk(orgId, gameId, { diskNo: n, sha256: sha(`c8-${tag}-${n}`) });
  await mountAndConverge(page, request, board, { diskId, sha256: s1 });
  return { ...board, title, gameId, diskId, sha256: s1 };
}

const chip = (page: Page, id: string) => page.getByTestId(`drive-chip-${id}`);
const panel = (page: Page, id: string) => page.getByTestId(`drive-chip-menu-${id}`);

// ---- The chip (spec §2, §2.1) ---------------------------------------------------------------------------------

test('C8-01a the chip at 1280: 40 px, the whole name at 14 px / 600, the disk in 13 px mono, the WP tag, no "n/N"', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'WifiFloppy1', 2);
  await page.goto('/library');
  const c = chip(page, b.deviceId);
  await expect(c).toHaveAttribute('data-phase', 'loaded');
  const box = (await c.boundingBox())!;
  expect(Math.abs(box.height - 40), `height ${box.height}`).toBeLessThanOrEqual(0.5);
  expect(box.width).toBeLessThanOrEqual(240.5);
  const name = page.getByTestId(`drive-chip-name-${b.deviceId}`);
  await expect(name).toHaveText('WifiFloppy1');
  await expect(name).toHaveCSS('font-size', '14px');
  await expect(name).toHaveCSS('font-weight', '600');
  // Whole, not "WifiFlop…" (spec §1: today's 3.5rem cap cut it).
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const disk = page.getByTestId(`drive-chip-disk-${b.deviceId}`);
  await expect(disk).toHaveText(b.title);
  await expect(disk).toHaveCSS('font-size', '13px');
  await expect(disk).toHaveClass(/font-mono/);
  const wp = page.getByTestId(`drive-chip-wp-${b.deviceId}`);
  await expect(wp).toHaveText('WP');
  await expect(wp).toHaveCSS('font-size', '11px');
  await expect(c).toContainText('write-protected');
  expect(await c.evaluate((el: HTMLElement) => el.innerText)).not.toMatch(/\d+\s*\/\s*\d+/);
});

test('C8-11 the super-admin with two boards: the compact control at 1280, one chip and "+k" from 1536', async ({ page, request }) => {
  test.setTimeout(90_000);
  await signInAsSuperAdmin(page);
  const ids: string[] = [];
  // The super-admin's org outlives this test: its boards go at the end of THIS test (cleanupSeeded removes disks).
  try {
    for (const n of ['Aaaa C8 admin one', 'Aaab C8 admin two']) ids.push((await onlineBoard(page, request, n)).deviceId);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/library');
    await expect(page.getByTestId('drives-compact')).toBeVisible();
    await expect(page.getByTestId('drive-chips')).toBeHidden();
    for (const id of ids) await expect(chip(page, id)).toBeHidden();
    await page.setViewportSize({ width: 1536, height: 800 });
    await page.goto('/library');
    await expect(page.getByTestId('drives-compact')).toBeHidden();
    await expect(chip(page, ids[0])).toBeVisible();
    await expect(page.getByTestId('drive-chip-more')).toBeVisible();
  } finally {
    if (ids.length) await getDb().delete(devices).where(inArray(devices.id, ids));
  }
});
```

`e2e/drive-chips.spec.ts`, the worst-case loop. Replace line 315 with

```ts
  // C8 (spec §2.1): the 240 px chip. The super-admin with these four boards gets the compact control at 1280.
  const slotsAt = who === 'super-admin' ? { 1280: 0, 1536: 1, 1920: 2 } : { 1280: 1, 1536: 1, 1920: 2 };
```

and replace lines 340-365 (from `for (const width of [1280, 1536, 1920] as const) {` through the loop's closing `}`)
with:

```ts
        for (const width of [1280, 1536, 1920] as const) {
          await page.setViewportSize({ width, height: 800 });
          await page.goto('/library');
          if (slotsAt[width] === 0) {
            // No chip fits beside the Admin pill once "+k" is needed: the compact control instead (spec §2.1).
            await expect(page.getByTestId('drives-compact')).toBeVisible();
            await expect(page.getByTestId('drives-compact')).toContainText('Drives');
            await expect(page.getByTestId('drive-chips')).toBeHidden();
            continue;
          }
          await expect(page.getByTestId('drive-chip-more')).toBeVisible();
          // The worst case really is on screen: exactly this width's slots,
          // every one ours, naming its disk and wearing its tag.
          const visible = await page.getByTestId('drive-chips').evaluate((el) =>
            [...el.children].filter((c) => (c as HTMLElement).offsetWidth > 0)
              .map((c) => c.getAttribute('data-testid')!).filter((t) => t !== 'drive-chip-more'));
          expect(visible.map((t) => t.replace('drive-chip-', '')), `chips at ${width}`).toEqual(ids.slice(0, slotsAt[width]));
          for (const id of ids.slice(0, slotsAt[width])) {
            await expect(chip(page, id)).toHaveAttribute('data-phase', 'loaded');
            await expect(page.getByTestId(`drive-chip-wp-${id}`)).toHaveText('WP');
          }
          const more = page.getByTestId('drive-chip-more');
          expect((await more.evaluate((el: HTMLElement) => el.innerText)).trim(), `"+k" at ${width}`)
            .toBe(`+${4 - slotsAt[width]}`);
          const g = await chipGaps(page);
          // Logged for the chipSlots comment (C8 plan Task 2 Step 5): every painted chip's and "+k"'s width.
          const widths = await page.getByTestId('drive-chips').evaluate((el) => [...el.children]
            .map((c) => Math.round(c.getBoundingClientRect().width * 10) / 10).filter((w) => w > 0));
          console.log(`${who} ${width}: widths ${JSON.stringify(widths)} gaps ${JSON.stringify(g)}`);
          expect(g.right, `gap to the pill at ${width}: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(16);
          expect(g.left, `gap to the wordmark at ${width}: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(16);
          // The "+k" list is chosen from the same slots in JS: it holds exactly the rest.
          await more.click();
          for (const id of ids.slice(slotsAt[width])) await expect(page.getByTestId(`drive-entry-${id}`)).toBeVisible();
          for (const id of ids.slice(0, slotsAt[width])) await expect(page.getByTestId(`drive-entry-${id}`)).toHaveCount(0);
          await page.keyboard.press('Escape');
        }
```

The "+k" numbers test: replace lines 395-396 with

```ts
  // 4 boards (C8 spec §2.1): 1 chip + "+3" at 1280 and 1536, 2 + "+2" at 1920.
  for (const [width, label] of [[1280, '+3'], [1536, '+3'], [1920, '+2']] as const) {
```

The admin-plane test: replace line 457 `await expect(chip(page, deviceId)).toBeVisible();` with

```ts
  // The super-admin's org may hold other boards: with two or more the compact control stands in at 1280 (C8 §2.1).
  await expect(page.locator(`[data-testid="drive-chip-${deviceId}"]:visible, [data-testid="drives-compact"]:visible`).first()).toBeVisible();
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/components/shell/drive-chips.test.ts`
Expected: FAIL — the chip still has `h-9`, the name `max-w-[3.5rem]`, no `2xl:flex` for the super-admin, and a third
chip is still rendered.

- [ ] **Step 3: Implement** (still on the Base UI Menu; Task 3 swaps the primitive)

In `src/components/shell/drive-chips.tsx`:

Replace the `DriveChips` function (lines 54-88) with:

```tsx
export function DriveChips({ chips, showAdmin = false }: { chips: DriveChip[]; showAdmin?: boolean }) {
  // Zero paired devices: nothing at all, not an empty "Drives" control.
  if (chips.length === 0) return null;
  const { shown } = splitChips(chips);
  // The super-admin with two or more boards: one chip plus "+k" does not fit beside the Admin pill at 1280-1535
  // (chipSlots), so the compact control stays until 2xl. Literal classes, chosen on the server: the first paint is right.
  const late = chipSlots(1280, showAdmin, chips.length) === 0;
  return (
    <>
      <div className={late ? 'hidden min-w-0 items-center gap-1.5 2xl:flex' : 'hidden min-w-0 items-center gap-1.5 xl:flex'}
           data-testid="drive-chips">
        {shown.map((c, i) => <Chip key={c.id} chip={c} className={CHIP_VISIBILITY[i]} />)}
        {chips.length > 1 && <MoreChip chips={chips} showAdmin={showAdmin} />}
      </div>
      {/* Below lg the chip slot of the header's single row (C7 spec §2.2): full width, 44 px. From lg to xl (2xl in
          the late case) it follows the wordmark. */}
      <div className={late ? 'min-w-0 flex-1 lg:flex-none 2xl:hidden' : 'min-w-0 flex-1 lg:flex-none xl:hidden'}>
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="drives-compact" className={`${CHIP_CLASS} flex max-lg:w-full`}>
            {/* The dot summarises: filled when every board is online, a ring
                when any is not -- each board's own reading is in the list. */}
            <StatusDot online={chips.every((c) => c.online)} />
            <span className="font-semibold">Drives</span>
            <span className="font-mono text-[13px] text-(--muted)">{chips.length}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          </DropdownMenuTrigger>
          {/* align="end": on a phone the trigger is at the right edge, and
              Base UI does NOT clamp an over-wide popup back on screen
              (HANDOFF §3t, proven by mutation) -- anchored at the start it
              would open off the right of the viewport. */}
          <MenuPopup testId="drives-compact-menu" align="end">
            <DriveList chips={chips} />
          </MenuPopup>
        </DropdownMenu>
      </div>
    </>
  );
}
```

Replace lines 90-106 (`CHIP_VISIBILITY`, `CHIP_VISIBILITY_ADMIN`, `moreVisibility`) with:

```tsx
/**
 * Tailwind needs literal class names, so chipSlots' breakpoints (drive-chips.ts) are spelled out here once more:
 * chip i shows from the width at which slot i opens -- 1 / 1 / 2 at xl / 2xl / 1920 for a member and (once the late
 * rule above has moved the whole group to 2xl) for the super-admin. Change one, change the other.
 */
const CHIP_VISIBILITY = ['flex', 'hidden min-[1920px]:flex'] as const;

/** "+k" is drawn only while some board has no chip of its own at this width: with two boards, until 1920. */
function moreVisibility(n: number): string {
  return n > 2 ? 'flex' : 'flex min-[1920px]:hidden';
}
```

In `MoreChip`, replace the `DropdownMenuTrigger` element (lines 121-142) with:

```tsx
      <DropdownMenuTrigger data-testid="drive-chip-more" title="More drives"
                           className={`${MORE_CLASS} ${moreVisibility(n)}`}>
        {/* One number per band, each bounded by its own variant: one chip below 1920, two from it. */}
        <span className="min-[1920px]:hidden">{label(1)}</span>
        <span className="hidden min-[1920px]:inline">{label(2)}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </DropdownMenuTrigger>
```

Replace `MoreList` (lines 150-152) with:

```tsx
function MoreList({ chips, showAdmin }: { chips: DriveChip[]; showAdmin: boolean }) {
  return <DriveList chips={splitChips(chips, chipSlots(window.innerWidth, showAdmin, chips.length)).rest} />;
}
```

Replace `CHIP_CLASS` and `CHIP_STYLE` (lines 154-167) with:

```tsx
// The board's drive chip (C8 spec §2, Rulings 2, 25): surface-2 on the line, the board's surface on an ink border
// while its panel is open. Colours are classes, not inline styles, so data-[popup-open] can change them. No `display`
// here: every caller supplies its own (`flex`, or a breakpoint-switched `hidden min-[1920px]:flex`). The 240 px cap
// is the width chipSlots is measured against; below lg the compact control that shares this look fills its row.
const CHIP_CLASS =
  'h-10 max-lg:h-11 lg:max-w-[240px] min-w-0 items-center gap-2 rounded-[10px] border border-(--line) bg-(--surface-2) pl-3 pr-2.5 text-[14px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';
// "+k" keeps its compact padding (Plan ruling): about 45 px, which is what lets one 240 px chip plus "+k" clear the
// member pill by 16 px at 1280.
const MORE_CLASS =
  'h-10 items-center gap-1 rounded-[10px] border border-(--line) bg-(--surface-2) px-2 text-[12px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';
```

In `StatusDot`, `h-[7px] w-[7px]` becomes `size-2` (8 px, spec §2).

Replace `Chip` (lines 183-226) with:

```tsx
/** What a chip says (C8 spec §2): the dot, the name, the disk, the WP/RW tag and the chevron. Also the compact
 *  control's face for one board (Task 5), under its own ids: the xl chip is mounted at the same time, and duplicate
 *  ids would break strict-mode getByTestId. */
function ChipFace({ chip, ids }: { chip: DriveChip; ids: 'chip' | 'compact' }) {
  const tag = protectTag(chip);
  const tid = (part: 'name' | 'disk' | 'wp') => (ids === 'chip' ? `drive-chip-${part}-${chip.id}` : `drives-compact-${part}`);
  return (
    <>
      <StatusDot online={chip.online} />
      <span className="max-w-[6rem] shrink-0 truncate font-semibold" data-testid={tid('name')}>{chip.shortName}</span>
      <span className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-(--muted)" data-testid={tid('disk')}>
        {diskText(chip)}
      </span>
      {tag && (
        <>
          <span className="shrink-0 rounded-[5px] bg-(--track) px-1.5 font-mono text-[11px] font-semibold leading-4 text-(--muted)"
                data-testid={tid('wp')}>
            {tag}
          </span>
          <span className="sr-only">{tag === 'WP' ? 'write-protected' : 'writable'}</span>
        </>
      )}
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
    </>
  );
}

function Chip({ chip, className }: { chip: DriveChip; className: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`drive-chip-${chip.id}`}
        data-phase={chip.phase}
        data-online={chip.online ? 'true' : 'false'}
        // The alias, in full, where a truncated chip cannot fit it --
        // several identical floppies say nothing on their own.
        title={`${chip.name} — ${chip.online ? 'online' : 'offline'}`}
        className={`${CHIP_CLASS} ${className}`}
        style={chip.online ? undefined : { opacity: 0.8 }}
      >
        <ChipFace chip={chip} ids="chip" />
      </DropdownMenuTrigger>
      <MenuPopup testId={`drive-chip-menu-${chip.id}`} align="start">
        <DriveEntry chip={chip} />
      </MenuPopup>
    </DropdownMenu>
  );
}
```

In the component's doc comment (lines 47-52) replace the paragraph "HOW MANY chips is measured … never passes
MAX_CHIPS." with: "HOW MANY chips is measured, not assumed (see chipSlots in drive-chips.ts): one 240 px chip plus
"+k" at xl and 2xl, two from 1920 (C8 spec §2.1); the super-admin with two or more boards keeps the compact control
until 2xl."

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/components/shell/drive-chips.test.ts src/lib/drive-chips.test.ts` → PASS.
If the `data-[popup-open]` or `aria-haspopup` expectations fail because the shadcn `DropdownMenuTrigger` merges its own
classes first, read the rendered tag and keep the asserted classes present; do not weaken the assertion.
Then the whole unit suite, `npx tsc --noEmit`, `pnpm lint` (12 warnings, exit 0).

e2e, one at a time, each timed:
1. `time PORT=3100 npx playwright test e2e/c8-drive-menu.spec.ts --project=desktop -g "C8-01a|C8-11"` → `2 passed`.
2. `time PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "the chips stay|centred|long names|first-paint|exactly one number|390px|admin plane"`
   → `9 passed` (check with `--list` first).
3. `time PORT=3100 npx playwright test e2e/header-overlap.spec.ts --project=desktop` → `5 passed`.

- [ ] **Step 5: Record the measured widths**

From run 2's output, copy the `member <width>: widths […] gaps {…}` and `super-admin …` lines. In
`src/lib/drive-chips.ts`, append to the `chipSlots` doc comment, after "Task 2 of the C8 plan records the measured
widths here.", one line per run in this form (the numbers are the logged ones):

```
 * Measured <date> in Chromium (drive-chips.spec, the widest case): member 1280 widths [240, 45] gaps {left 19, right 19};
 * member 1536 …; member 1920 …; super-admin 1536 …; super-admin 1920 ….
```

The rule if the measurement disagrees with the arithmetic: if any `g.right` or `g.left` is under 16 the test is red,
so there is nothing to record. Then recompute the slots from the measured widths with the comment's formula, change
`chipSlots`, `CHIP_VISIBILITY`, `moreVisibility`, the unit tables and `slotsAt` together, and report the new table as a
**Plan ruling** for the controller to relay (spec §2.1: "the measurement wins").

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/components/shell/drive-chips.tsx src/components/shell/drive-chips.test.ts src/lib/drive-chips.ts \
  e2e/c8-drive-menu.spec.ts e2e/drive-chips.spec.ts
git commit -m "C8: the drive chip takes the board's look at 40 px with a 240 px cap; slots re-derived and measured

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 3: The panel on Base UI Popover: head row, the card, the four actions, the focus rules

**Files:**
- Modify: `src/components/shell/drive-chips.tsx` (whole file, below), `src/components/games/write-protect-toggle.tsx:38-46`,
  `src/app/globals.css` (insert after line 388), `src/components/shell/drive-chips.test.ts` (append),
  `e2e/drive-chips.spec.ts:8`, `:68-103`, `:122-151`, `:153-181`, `:183-209`, `:211-229`, `e2e/next-disk.spec.ts:49-77`,
  `e2e/c8-drive-menu.spec.ts` (append)

**Interfaces:**
- Consumes: Task 1's `diskLine`, `nextLabel`, `DriveChip.seen`; Task 2's `CHIP_CLASS`, `MORE_CLASS`, `ChipFace`,
  `CHIP_VISIBILITY`, `moreVisibility`, the `late` rule; `statusPill(online)` (`@/lib/devices-look`),
  `driveDiskColor(gameId)` (`@/lib/library-look`), `DiskIcon` (`@/components/ui/disk-icon`), `requestEject`,
  `requestNextDisk`, `requestWriteProtect` (`@/components/devices/device-actions`), `Popover` (`@base-ui/react/popover`).
- Produces:
  - `WpSwitch({ on, small }: { on: boolean; small?: boolean })` (`@/components/games/write-protect-toggle`).
  - `DriveCard({ chip, close }: { chip: DriveChip; close: () => void })`, exported from
    `@/components/shell/drive-chips` for the render tests.
  - Inside `drive-chips.tsx`: `type Panel`, `usePanel(): Panel`, `PanelPopup`, `PanelCards`, `PanelHead`,
    `usePanelAction(allowed, request)`, `CompactControl({ chips })` (Task 5 changes its face).
  - CSS: `.drive-panel`.
  - The gear's href: `/devices?settings=<id>` (Task 4 makes `/devices` answer it).

**Plan ruling** (spec §6 Outside press, Ruling 20): Base UI 1.7's `finalFocus` function receives the interaction type,
not the close reason, so the spec's fallback is used: `onOpenChange(open, details)` stores `details.reason` in a ref,
and `finalFocus` returns `false` for `'outside-press'` (then, one frame later, focuses the chip only if focus is on
`<body>`), `false` for `'focus-out'` (Tab already moved focus on) and for a link press (`'navigate'`, set by
`close()`), and `true` (the chip) otherwise.

**Plan ruling** (spec §9.4, "the three actions still `data-disabled=""` (`goto` is plain text …)"): whenever there is
no title link (empty, loading, ejecting, an unknown row, or a disk with no game), the words of the disk line sit in a
`span` that carries `drive-goto-<id>` and `data-disabled=""`. "Drive empty" is therefore both
`drive-entry-disk-<id>`'s text and `drive-goto-<id>`'s.

**Plan ruling** (spec §6, Ruling 21): the rescue runs in two places. The chip's own `usePanel()` cleanup (the chip
unmounts with its popup when the board vanishes) focuses `wordmark-home` one frame later if focus is on `<body>` and
the panel was open. `PanelCards` re-checks after its card list changes (a "+k"/compact panel that lost one card) and
focuses the popup. Both read refs through a module-level function, so the react-hooks lint rules see no `.current` in
a cleanup.

**Plan ruling** (spec §9.4 next-disk and write-protect): because the panel now stays open after an action, the specs
stop re-clicking the chip between steps (a second click would close it).

- [ ] **Step 1: Write the failing tests**

Append to `src/components/shell/drive-chips.test.ts`, after the existing `const { DriveChips } = await import(…)` line
change it to `const { DriveChips, DriveCard } = await import('./drive-chips');`, and at the end of the file add:

```ts
const card = (c: DriveChip) => renderToStaticMarkup(createElement(DriveCard, { chip: c, close: () => {} }));
const emptyChip: DriveChip = {
  ...base, phase: 'empty', state: 'empty', disk: null, canGoTo: false, canToggleProtect: false, canEject: false, next: null,
};

describe('the chip opens a dialog, not a menu (Ruling 1)', () => {
  it('announces a dialog and renders no panel while closed', () => {
    const html = chips([base]);
    expect(openTag(html, 'drive-chip-dev-a')).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('drive-entry-dev-a');
  });
});

describe('DriveCard (C8 spec §3.3, §4, §5)', () => {
  it('a loaded board: a section named for the board, its name linking to its card, " · DF0", the title link, the count', () => {
    const html = card(base);
    expect(openTag(html, 'drive-entry-dev-a')).toMatch(/^<section\b/);
    expect(openTag(html, 'drive-entry-dev-a')).toContain('aria-label="Bench controls"');
    expect(openTag(html, 'drive-entry-link-dev-a')).toContain('href="/devices#device-dev-a"');
    expect(html).toContain('· DF0');
    expect(openTag(html, 'drive-goto-dev-a')).toContain('href="/games/gam-1"');
    expect(html).toMatch(/data-testid="drive-entry-disk-dev-a"[^>]*><a[^>]*>Turrican<\/a> · disk 1 of 2<\/span>/);
    expect(html).toMatch(/data-testid="drive-entry-status-dev-a"[^>]*><span[^>]*><\/span>Online<\/span>/);
    expect(html).not.toContain('drive-entry-offline-dev-a');
  });
  it('a loaded board: the switch on and live, Next in the card\'s words, Eject live, the gear to its Board settings', () => {
    const html = card(base);
    const sw = openTag(html, 'drive-protect-dev-a');
    expect(sw).toContain('role="switch"');
    expect(sw).toContain('aria-checked="true"');
    expect(sw).toContain('data-protected="true"');
    expect(sw).not.toContain('aria-disabled');
    expect(html).toMatch(/data-testid="drive-protect-dev-a"[^>]*>.*Write-protect/);
    const next = openTag(html, 'drive-next-dev-a');
    expect(next).toContain('aria-label="Next: disk 2 of 2"');
    expect(html).toMatch(/data-testid="drive-next-dev-a"[^>]*>Next: disk 2<\/button>/);
    expect(openTag(html, 'drive-eject-dev-a')).not.toContain('aria-disabled');
    expect(html).toMatch(/data-testid="drive-eject-dev-a"[^>]*>.*Eject<\/button>/);
    const gear = openTag(html, 'drive-settings-dev-a');
    expect(gear).toContain('href="/devices?settings=dev-a"');
    expect(gear).toContain('aria-label="Bench board settings"');
  });
  it('an empty drive: "Drive empty" in words, the switch neutral and off, no Next, Eject there but off, the gear live', () => {
    const html = card(emptyChip);
    expect(html).toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Drive empty<\/span>/);
    const sw = openTag(html, 'drive-protect-dev-a');
    for (const a of ['aria-checked="false"', 'aria-disabled="true"', 'data-disabled=""']) expect(sw, a).toContain(a);
    expect(html).toContain('(shown once the board holds a disk)');
    expect(html).not.toContain('drive-next-dev-a');
    const ej = openTag(html, 'drive-eject-dev-a');
    expect(ej).toContain('aria-disabled="true"');
    expect(ej).toContain('title="The drive is empty"');
    expect(ej).not.toMatch(/\sdisabled(=|\s|>)/);   // never native disabled
    expect(openTag(html, 'drive-settings-dev-a')).not.toContain('aria-disabled');
  });
  it('an offline board: the pill says Offline, the line says when and what happens, every action stays live', () => {
    const html = card({ ...base, online: false, seen: '5m ago' });
    expect(html).toMatch(/data-testid="drive-entry-status-dev-a"[^>]*><span[^>]*><\/span>Offline<\/span>/);
    expect(html).toMatch(/data-testid="drive-entry-offline-dev-a"[^>]*>Offline, last seen 5m ago\. Changes reach it when it reconnects\.</);
    for (const id of ['drive-protect-dev-a', 'drive-next-dev-a', 'drive-eject-dev-a']) {
      expect(openTag(html, id), id).not.toContain('aria-disabled');
    }
  });
  it('an HFE: the switch on, off, and why', () => {
    const html = card({ ...base, canToggleProtect: false, disk: { ...base.disk!, readOnly: 'HFE' } });
    const sw = openTag(html, 'drive-protect-dev-a');
    expect(sw).toContain('aria-checked="true"');
    expect(sw).toContain('aria-disabled="true"');
    expect(sw).toContain('title="HFE disks are always read-only"');
    expect(html).toContain('(HFE, always read-only)');
  });
  it('loading and ejecting are words; a title with no game is plain text', () => {
    expect(card({ ...emptyChip, phase: 'loading', state: 'pending', loadingTitle: 'Lotus', canEject: true }))
      .toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Loading Lotus…<\/span>/);
    expect(card({ ...base, phase: 'ejecting', state: 'pending', canToggleProtect: false, next: null }))
      .toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Ejecting Turrican…<\/span>/);
    expect(card({ ...base, canGoTo: false, disk: { ...base.disk!, gameId: null } }))
      .toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Turrican<\/span> · disk 1 of 2/);
  });
  it('the preload and DF1 lines keep their ids', () => {
    const html = card({ ...base, next: { ...base.next!, preload: 'ready' }, df1: 'DF1: next disk of the set — empty' });
    expect(openTag(html, 'drive-preload-dev-a')).toContain('data-preload="ready"');
    expect(html).toContain('Disk 2 ready (instant swap)');
    expect(html).toMatch(/data-testid="drive-entry-df1-dev-a"[^>]*>DF1: next disk of the set — empty</);
  });
});
```

Append to `e2e/c8-drive-menu.spec.ts`:

```ts
// ---- The panel (spec §3-§7) ----------------------------------------------------------------------------------

async function openPanel(page: Page, id: string) {
  await hydrated(page, `drive-chip-${id}`);
  await chip(page, id).click();
  await expect(panel(page, id)).toBeVisible();
}

/** Count `method` requests whose path matches `path`, from now on. */
function countRequests(page: Page, method: string, path: RegExp) {
  const seen = { n: 0 };
  page.on('request', (r) => { if (r.method() === method && path.test(new URL(r.url()).pathname)) seen.n++; });
  return seen;
}

/** Hold every `method` request to `glob` for `ms`, so a second press lands while the first is in flight. */
async function slow(page: Page, glob: string, method: string, ms = 1_200) {
  await page.route(glob, async (route) => {
    if (route.request().method() !== method) return route.continue();
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

/** A point in the header just right of the wordmark, where nothing focusable is (checked, not assumed). */
async function blankHeaderPoint(page: Page) {
  const wm = (await page.getByTestId('wordmark-home').boundingBox())!;
  const p = { x: Math.round(wm.x + wm.width + 6), y: Math.round(wm.y + wm.height / 2) };
  expect(await page.evaluate(({ x, y }) =>
    !document.elementFromPoint(x, y)?.closest('a,button,input,select,textarea,[tabindex]'), p), 'a blank point').toBe(true);
  return p;
}

test('C8-01b the panel at 1280: 440 px, "Controlling" and "Manage devices", and the board\'s card', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'WifiFloppy1', 2);
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  const p = panel(page, b.deviceId);
  await expect(p).toHaveAttribute('role', 'dialog');
  await expect(p).toHaveAccessibleName('WifiFloppy1 drive');
  await expect(chip(page, b.deviceId)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect.poll(async () => Math.round((await p.boundingBox())!.width)).toBe(440);
  await expect(p).toContainText('Controlling');
  const manage = page.getByTestId('drive-panel-manage');
  await expect(manage).toHaveText('Manage devices');
  await expect(manage).toHaveAttribute('href', '/devices');
  const entry = page.getByTestId(`drive-entry-${b.deviceId}`);
  await expect(entry).toHaveAccessibleName('WifiFloppy1 controls');
  await expect(entry.locator('svg').first()).toBeVisible();                      // the disk icon
  await expect(entry).toContainText('WifiFloppy1 · DF0');
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`${b.title} · disk 1 of 2`);
  await expect(page.getByTestId(`drive-entry-status-${b.deviceId}`)).toHaveText('Online');
  await expect(page.getByTestId(`drive-protect-${b.deviceId}`)).toHaveAttribute('role', 'switch');
  await expect(page.getByTestId(`drive-next-${b.deviceId}`)).toHaveText('Next: disk 2');
  await expect(page.getByTestId(`drive-eject-${b.deviceId}`)).toHaveText('Eject');
  await expect(page.getByTestId(`drive-settings-${b.deviceId}`)).toHaveAccessibleName('WifiFloppy1 board settings');
  // Hover (desktop only: the mobile project never hovers): Manage devices underlines.
  await manage.hover();
  await expect(manage).toHaveCSS('text-decoration-line', 'underline');
  await manage.click();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(p).toHaveCount(0);
});

test('C8-02 a one-disk title reads "disk 1 of 1", and offers no Next', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Single', 1);
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`${b.title} · disk 1 of 1`);
  await expect(page.getByTestId(`drive-next-${b.deviceId}`)).toHaveCount(0);
});

test('C8-03 Write-protect: one PATCH on a double press, busy while it runs, flipped by the refresh, panel and focus kept', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 1);
  await page.goto('/library');
  const patches = countRequests(page, 'PATCH', /^\/api\/disks\/[^/]+$/);
  await slow(page, '**/api/disks/*', 'PATCH');
  await openPanel(page, b.deviceId);
  const sw = page.getByTestId(`drive-protect-${b.deviceId}`);
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.dblclick();
  await expect(sw).toHaveAttribute('aria-busy', 'true');
  await expect(sw).toHaveAttribute('aria-disabled', 'true');
  await expect(sw).toHaveAttribute('aria-checked', 'false', LIVE);
  await expect(sw).not.toHaveAttribute('aria-busy', 'true');
  expect(patches.n).toBe(1);
  await expect(panel(page, b.deviceId)).toBeVisible();
  await expect(sw).toBeFocused();
  await expect(page.getByTestId(`drive-chip-wp-${b.deviceId}`)).toHaveText('RW');
});

test('C8-04 Eject: "Ejecting…" while it runs, one POST on a double press, the panel stays, focus stays through empty', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 1);
  await page.goto('/library');
  const posts = countRequests(page, 'POST', /^\/api\/devices\/[^/]+\/eject$/);
  await slow(page, '**/api/devices/*/eject', 'POST');
  await openPanel(page, b.deviceId);
  const ej = page.getByTestId(`drive-eject-${b.deviceId}`);
  await ej.dblclick();
  await expect(ej).toHaveText('Ejecting…');
  await expect(ej).toHaveAttribute('aria-busy', 'true');
  await expect(chip(page, b.deviceId)).toHaveAttribute('data-phase', 'ejecting', LIVE);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`Ejecting ${b.title}…`);
  expect(posts.n).toBe(1);
  await expect(panel(page, b.deviceId)).toBeVisible();
  await expect(ej).toBeFocused();
  // The board reports the drive empty: Eject turns off under the focus, and the focus stays on it.
  expect((await request.post('/api/device/status', {
    headers: authHeader(b.token), data: { mountedSha256: null, mountedDiskId: null },
  })).status()).toBe(204);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText('Drive empty', LIVE);
  await expect(ej).toHaveAttribute('aria-disabled', 'true');
  await expect(ej).toBeFocused();
});

test('C8-05 Next: one POST on a double press; when the button goes with the loading refresh, focus is on Eject', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 2);
  await page.goto('/library');
  const posts = countRequests(page, 'POST', /^\/api\/devices\/[^/]+\/next$/);
  await slow(page, '**/api/devices/*/next', 'POST');
  await openPanel(page, b.deviceId);
  const next = page.getByTestId(`drive-next-${b.deviceId}`);
  await expect(next).toHaveAccessibleName('Next: disk 2 of 2');
  await next.dblclick();
  await expect(next).toHaveText('Switching…');
  await expect(next).toHaveCount(0, LIVE);
  await expect(page.getByTestId(`drive-entry-disk-${b.deviceId}`)).toHaveText(`Loading ${b.title}…`);
  expect(posts.n).toBe(1);
  await expect(page.getByTestId(`drive-eject-${b.deviceId}`)).toBeFocused();
});

test('C8-06 a dropped connection: the toast, and neither Eject nor Write-protect is left busy (Review Focus 5)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Bench', 1);
  await page.goto('/library');
  await page.route('**/api/devices/*/eject', (r) => r.abort());
  await page.route('**/api/disks/*', (r) => (r.request().method() === 'PATCH' ? r.abort() : r.continue()));
  await openPanel(page, b.deviceId);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Could not reach the server' });
  const ej = page.getByTestId(`drive-eject-${b.deviceId}`);
  await ej.click();
  await expect(toast.first()).toBeVisible();
  await expect(ej).toHaveText('Eject');
  await expect(ej).not.toHaveAttribute('aria-busy', 'true');
  await expect(ej).not.toHaveAttribute('aria-disabled', 'true');
  const sw = page.getByTestId(`drive-protect-${b.deviceId}`);
  await sw.click();
  await expect(toast).toHaveCount(2);
  await expect(sw).not.toHaveAttribute('aria-busy', 'true');
  await expect(sw).not.toHaveAttribute('aria-disabled', 'true');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(panel(page, b.deviceId)).toBeVisible();
});

test('C8-08 focus: open -> the popup; Escape and a blank press -> the chip; the search field keeps its focus; Tab past the gear closes', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await onlineBoard(page, request, 'Bench');
  await page.goto('/library');
  const c = chip(page, deviceId);
  const p = panel(page, deviceId);
  await hydrated(page, `drive-chip-${deviceId}`);

  await c.click();
  await expect(p).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(p).toHaveCount(0);
  await expect(c).toBeFocused();

  await c.click();
  const pt = await blankHeaderPoint(page);
  await page.mouse.click(pt.x, pt.y);
  await expect(p).toHaveCount(0);
  await expect(c).toBeFocused();

  // Review Focus 2: a press on the search field closes the panel and leaves the caret there.
  await c.click();
  await expect(p).toBeVisible();
  await page.getByTestId('search-input').click();
  await expect(p).toHaveCount(0);
  await expect(page.getByTestId('search-input')).toBeFocused();

  // Keyboard: Enter opens on the popup too; Tab walks the panel to the gear, and one more Tab leaves and closes it.
  await c.focus();
  await page.keyboard.press('Enter');
  await expect(p).toBeFocused();
  const gear = page.getByTestId(`drive-settings-${deviceId}`);
  for (let i = 0; i < 10 && !(await gear.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(gear).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(p).toHaveCount(0);
  expect(await page.evaluate(() => {
    const a = document.activeElement;
    return !!a && a !== document.body && !a.closest('[data-drive-panel]');
  })).toBe(true);
});

test('C8-09 live: the board goes offline under an open panel -> "Offline" and the line, panel open, focus unchanged', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Attic', 1);
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  await expect(panel(page, b.deviceId)).toBeFocused();
  await setDevice(b.deviceId, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });
  await expect(page.getByTestId(`drive-entry-status-${b.deviceId}`)).toHaveText('Offline', LIVE);
  await expect(page.getByTestId(`drive-entry-offline-${b.deviceId}`))
    .toHaveText(/^Offline, last seen \d+[smhd] ago\. Changes reach it when it reconnects\.$/);
  await expect(panel(page, b.deviceId)).toBeVisible();
  await expect(panel(page, b.deviceId)).toBeFocused();
});

test('C8-10 two boards at 1280: the chip\'s panel is its board\'s card only; "+1" holds the other under one head row', async ({ page, request }) => {
  await signUpFresh(page);
  const a = await onlineBoard(page, request, 'Aa C8 first');
  const b = await onlineBoard(page, request, 'Ab C8 second');
  await page.goto('/library');
  await expect(chip(page, b.deviceId)).toBeHidden();
  const more = page.getByTestId('drive-chip-more');
  await expect(more.locator('span:visible')).toHaveText('+1');
  await openPanel(page, a.deviceId);
  await expect(panel(page, a.deviceId).locator('section[data-testid^="drive-entry-"]')).toHaveCount(1);
  await expect(panel(page, a.deviceId).getByTestId(`drive-entry-${a.deviceId}`)).toBeVisible();
  await page.keyboard.press('Escape');
  await hydrated(page, 'drive-chip-more');
  await more.click();
  const list = page.getByTestId('drive-chip-more-menu');
  await expect(list).toHaveAccessibleName('Drives');
  await expect(list.getByTestId('drive-panel-manage')).toHaveCount(1);
  await expect(list.locator('section[data-testid^="drive-entry-"]')).toHaveCount(1);
  await expect(list.getByTestId(`drive-entry-${b.deviceId}`)).toBeVisible();
});

test('C8-14 an offline board: every action allowed, and Eject sends its request', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'Attic', 2);
  await setDevice(b.deviceId, { lastSeenAt: new Date(Date.now() - 60 * 60_000) });
  await page.goto('/library');
  await openPanel(page, b.deviceId);
  for (const id of ['protect', 'next', 'eject']) {
    await expect(page.getByTestId(`drive-${id}-${b.deviceId}`)).not.toHaveAttribute('aria-disabled', 'true');
  }
  const posts = countRequests(page, 'POST', /^\/api\/devices\/[^/]+\/eject$/);
  await page.getByTestId(`drive-eject-${b.deviceId}`).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Eject requested' }).first()).toBeVisible();
  expect(posts.n).toBe(1);
});

test('C8-16 the board is deleted while its panel is open: focus lands on the wordmark, not <body> (Review Focus 3)', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId } = await onlineBoard(page, request, 'Doomed');
  await page.goto('/library');
  await openPanel(page, deviceId);
  await expect(panel(page, deviceId)).toBeFocused();
  await getDb().delete(devices).where(eq(devices.id, deviceId));
  await expect(chip(page, deviceId)).toHaveCount(0, LIVE);
  await expect(page.getByTestId('wordmark-home')).toBeFocused();
});
```

`e2e/drive-chips.spec.ts`:

Line 8 becomes `import { pairDevice, seedDisk, authHeader, cleanupSeeded, df1OnBoard, hydrated } from './device-helpers';`.

Replace the empty-board test (lines 68-103) with:

```ts
test('an empty board: the chip shows its name and "empty", and the panel is reachable by keyboard with every action off',
  async ({ page, request }) => {
    await signUpFresh(page);
    const { deviceId } = await onlineBoard(page, request, 'Bench');
    await page.goto('/library');

    const c = chip(page, deviceId);
    await expect(c).toBeVisible();
    await expect(page.getByTestId(`drive-chip-name-${deviceId}`)).toHaveText('Bench');
    await expect(page.getByTestId(`drive-chip-disk-${deviceId}`)).toHaveText('empty');
    await expect(c).toHaveAttribute('data-online', 'true');
    await expect(c).toHaveAttribute('title', /Bench/);
    // C8 Ruling 1: a dialog of controls, not a menu.
    await expect(c).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(c).toHaveAttribute('aria-expanded', 'false');

    // Keyboard: focus, Enter opens, Escape closes and gives the focus back to the chip.
    await hydrated(page, `drive-chip-${deviceId}`);
    await c.focus();
    await page.keyboard.press('Enter');
    await expect(menu(page, deviceId)).toBeVisible();
    await expect(c).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId(`drive-entry-status-${deviceId}`)).toHaveText('Online');
    await expect(page.getByTestId(`drive-entry-disk-${deviceId}`)).toHaveText('Drive empty');
    for (const action of ['goto', 'protect', 'eject']) {
      await expect(page.getByTestId(`drive-${action}-${deviceId}`)).toHaveAttribute('data-disabled', '');
    }
    await page.keyboard.press('Escape');
    await expect(menu(page, deviceId)).toHaveCount(0);
    await expect(c).toHaveAttribute('aria-expanded', 'false');
    await expect(c).toBeFocused();

    // A press outside, on nothing focusable, closes it too, and focus goes to the chip (C8 Ruling 20).
    await c.click();
    await expect(menu(page, deviceId)).toBeVisible();
    const wm = (await page.getByTestId('wordmark-home').boundingBox())!;
    await page.mouse.click(wm.x + wm.width + 6, wm.y + wm.height / 2);
    await expect(menu(page, deviceId)).toHaveCount(0);
    await expect(c).toBeFocused();
  });
```

In the mount test, after line 135 (`…toHaveText('loading…');`) insert:

```ts
    // The card says what was asked for, in words (C8 spec §3.3).
    await hydrated(page, `drive-chip-${board.deviceId}`);
    await chip(page, board.deviceId).click();
    await expect(page.getByTestId(`drive-entry-disk-${board.deviceId}`)).toHaveText(`Loading Chipgame ${tag.slice(-5)}…`);
    await page.keyboard.press('Escape');
```

Replace the write-protect test (lines 153-181) with:

```ts
test('the write-protect switch flips the DISK between protected and writable, with the panel left open', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const board = await onlineBoard(page, request, 'Bench');
  const tag = runTag();
  const s = sha(`chip-wp-${tag}`);
  const disk = { sha256: s, ...(await seedDisk(orgId, { title: `Wp ${tag.slice(-5)}`, diskNo: 1, sha256: s })) };
  await mountAndConverge(page, request, board, disk);
  await page.goto('/library');

  const wpTag = page.getByTestId(`drive-chip-wp-${board.deviceId}`);
  const item = page.getByTestId(`drive-protect-${board.deviceId}`);
  await expect(wpTag).toHaveText('WP');

  await hydrated(page, `drive-chip-${board.deviceId}`);
  await chip(page, board.deviceId).click();
  await expect(item).toHaveAttribute('role', 'switch');
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await expect(item).toHaveAttribute('data-protected', 'true');
  await item.click();
  await expect(wpTag).toHaveText('RW', LIVE);
  // C8 §4.1: the panel stays open; the switch moves when the rows say so.
  await expect(menu(page, board.deviceId)).toBeVisible();
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await expect(item).toHaveAttribute('data-protected', 'false');
  await item.click();
  await expect(wpTag).toHaveText('WP', LIVE);
  await expect(item).toHaveAttribute('aria-checked', 'true');

  // It is the disk's own flag -- the game page's toggle agrees.
  await page.goto(`/games/${disk.gameId}`);
  await expect(page.getByTestId(`wp-${disk.diskId}`)).toHaveAttribute('data-protected', 'true');
});
```

In the eject test, after line 195 (`…drive-eject-…).click();`) insert
`  await expect(menu(page, board.deviceId)).toBeVisible();   // C8 Ruling 9: the panel stays open after Eject` and
put `await hydrated(page, \`drive-chip-${board.deviceId}\`);` before line 194's `chip(…).click()`.

In the offline test, after line 227 insert:

```ts
  await expect(page.getByTestId(`drive-entry-offline-${board.deviceId}`))
    .toHaveText(/^Offline, last seen \d+[smhd] ago\. Changes reach it when it reconnects\.$/);
```

`e2e/next-disk.spec.ts`: replace lines 59-77 (from `await page.goto('/library');` through the test's end) with:

```ts
  await page.goto('/library');
  await hydrated(page, `drive-chip-${deviceId}`);
  await chip(page, deviceId).click();
  await expect(menu(page, deviceId)).toBeVisible();
  const nextItem = page.getByTestId(`drive-next-${deviceId}`);
  // C8: the card's words, the count and the wrap in the name (Plan ruling: the name starts with the visible words).
  await expect(nextItem).toHaveText('Next: disk 2');
  await expect(nextItem).toHaveAccessibleName('Next: disk 2 of 2');

  await nextItem.click();
  await expect.poll(() => desiredDiskIdOf(deviceId)).toBe(disk2.diskId);

  // Board reports disk 2: converged, and the still-open panel now offers the WRAP back to disk 1.
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: sha(`${tag}-2`), mountedDiskId: disk2.diskId },
  })).status()).toBe(204);

  await expect(menu(page, deviceId)).toBeVisible();
  await expect(page.getByTestId(`drive-next-${deviceId}`)).toHaveText('Next: disk 1', LIVE);
  await expect(page.getByTestId(`drive-next-${deviceId}`)).toHaveAccessibleName('Next: disk 1 of 2 (wraps)');
});
```

and add `hydrated` to that file's `./device-helpers` import (read the import line first and append `, hydrated` inside
its braces).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/components/shell/drive-chips.test.ts`
Expected: FAIL — `DriveCard` is not exported; the chip announces `menu`.

- [ ] **Step 3: Implement**

`src/components/games/write-protect-toggle.tsx`, replace `WpSwitch` (lines 38-46) with:

```tsx
export function WpSwitch({ on, small = false }: { on: boolean; small?: boolean }) {
  // `small`: the header drive panel's 28 x 16 switch (C8 spec §3.3); 32 x 18 everywhere else.
  return (
    <span aria-hidden="true" className={`flex shrink-0 box-border p-0.5 ${small ? 'h-4 w-7' : 'h-[18px] w-8'}`}
          style={{ justifyContent: on ? 'flex-end' : 'flex-start', background: on ? 'var(--ink)' : 'var(--line-strong)',
                   borderRadius: 999 }}>
      <span className={`${small ? 'size-3' : 'size-3.5'} rounded-full`} style={{ background: '#FFFDF8', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
    </span>
  );
}
```

`src/app/globals.css`, insert after line 388 (the end of the `.seg` components layer):

```css
/* The header drive panel (C8 spec §3.1, §8, Ruling 22): never taller than the room Base UI measured, and below lg
   never down under the fixed bottom tab bar (60 px header, ~4.5rem bar, the safe area, a 16 px gutter). In CSS
   rather than an arbitrary utility, so env() is not taken apart by the class scanner. */
@layer components {
  .drive-panel { max-height: var(--available-height); }
  @media (width < 64rem) {
    .drive-panel {
      max-height: min(var(--available-height), calc(100dvh - 60px - 4.5rem - env(safe-area-inset-bottom) - 16px));
    }
  }
}
```

`src/components/shell/drive-chips.tsx`, the whole file:

```tsx
'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDownIcon } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { DiskIcon } from '@/components/ui/disk-icon';
import { WpSwitch } from '@/components/games/write-protect-toggle';
import { requestEject, requestNextDisk, requestWriteProtect } from '@/components/devices/device-actions';
import { statusPill } from '@/lib/devices-look';
import { driveDiskColor } from '@/lib/library-look';
import {
  chipSlots, diskLine, diskText, nextLabel, preloadText, protectTag, splitChips, type DriveChip,
} from '@/lib/drive-chips';

/**
 * Every paired wifi-floppy as a chip in the header (HANDOFF §4 backlog, 2026-09-25), in the board's look since C8
 * (spec 2026-10-26-phase-c8-drive-menu-design.md): the status dot, the name, the disk, the WP/RW tag. A chip opens a
 * PANEL (a Base UI Popover, role="dialog" -- Ruling 1): a "Controlling" / "Manage devices" head row and that board's
 * card, with Go to disk (the title), Write-protect, Next, Eject and the board-settings gear. No "current drive": each
 * chip's panel is its own board's card; "+k" and the compact control hold one card per board. /devices stays where
 * devices are managed.
 *
 * Every state carries BOTH of its values on screen -- online is a filled dot and offline a hollow ring (shape, not
 * only colour) and a pill in words, an empty drive says so, a settled disk wears WP or RW -- because an icon that is
 * simply absent is not a reading.
 *
 * The props come from the (app) layout, derived from the same rows the live fingerprint hashes, so LiveRefresh's
 * router.refresh() is what keeps a chip and an open panel current. There is deliberately no optimistic state: after
 * an eject the card reads "Ejecting …" because the layout says desired != mounted, and "Drive empty" only once the
 * BOARD has reported it. The panel holds busy flags only. Its open state lives in each Popover.Root, keyed by the
 * board id (or, for the compact control, by nothing that changes), so a refresh re-renders it and never remounts it.
 *
 * Two presentations, one set of props, switched by CSS at `xl` (`2xl` for the super-admin with two or more boards):
 *   - chips beside the wordmark, then a "+k" chip for the boards that did not get one;
 *   - below that, ONE compact control. Below lg it fills the header row's middle -- NOT in the fixed bottom bar.
 * Popups render their contents only while open, so the two never put a board's controls in the DOM twice.
 *
 * HOW MANY chips is measured, not assumed (see chipSlots in drive-chips.ts): one 240 px chip plus "+k" at xl and
 * 2xl, two from 1920 (C8 spec §2.1); the super-admin with two or more boards keeps the compact control until 2xl.
 */
export function DriveChips({ chips, showAdmin = false }: { chips: DriveChip[]; showAdmin?: boolean }) {
  // Zero paired devices: nothing at all, not an empty "Drives" control.
  if (chips.length === 0) return null;
  const { shown } = splitChips(chips);
  // The super-admin with two or more boards: one chip plus "+k" does not fit beside the Admin pill at 1280-1535
  // (chipSlots), so the compact control stays until 2xl. Literal classes, chosen on the server: the first paint is right.
  const late = chipSlots(1280, showAdmin, chips.length) === 0;
  return (
    <>
      <div className={late ? 'hidden min-w-0 items-center gap-1.5 2xl:flex' : 'hidden min-w-0 items-center gap-1.5 xl:flex'}
           data-testid="drive-chips">
        {shown.map((c, i) => <Chip key={c.id} chip={c} className={CHIP_VISIBILITY[i]} />)}
        {chips.length > 1 && <MoreChip chips={chips} showAdmin={showAdmin} />}
      </div>
      {/* Below lg the chip slot of the header's single row (C7 spec §2.2): full width, 44 px. From lg to xl (2xl in
          the late case) it follows the wordmark. */}
      <div className={late ? 'min-w-0 flex-1 lg:flex-none 2xl:hidden' : 'min-w-0 flex-1 lg:flex-none xl:hidden'}>
        <CompactControl chips={chips} />
      </div>
    </>
  );
}

/**
 * Tailwind needs literal class names, so chipSlots' breakpoints (drive-chips.ts) are spelled out here once more:
 * chip i shows from the width at which slot i opens -- 1 / 1 / 2 at xl / 2xl / 1920 for a member and (once the late
 * rule above has moved the whole group to 2xl) for the super-admin. Change one, change the other.
 */
const CHIP_VISIBILITY = ['flex', 'hidden min-[1920px]:flex'] as const;

/** "+k" is drawn only while some board has no chip of its own at this width: with two boards, until 1920. */
function moreVisibility(n: number): string {
  return n > 2 ? 'flex' : 'flex min-[1920px]:hidden';
}

// The board's drive chip (C8 spec §2, Rulings 2, 25): surface-2 on the line, the board's surface on an ink border
// while its panel is open. Colours are classes, not inline styles, so data-[popup-open] can change them. No `display`
// here: every caller supplies its own (`flex`, or a breakpoint-switched `hidden min-[1920px]:flex`). The 240 px cap
// is the width chipSlots is measured against; below lg the compact control that shares this look fills its row.
const CHIP_CLASS =
  'h-10 max-lg:h-11 lg:max-w-[240px] min-w-0 items-center gap-2 rounded-[10px] border border-(--line) bg-(--surface-2) pl-3 pr-2.5 text-[14px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';
// "+k" keeps its compact padding (C8 plan ruling): about 45 px, which is what lets one 240 px chip plus "+k" clear
// the member pill by 16 px at 1280.
const MORE_CLASS =
  'h-10 items-center gap-1 rounded-[10px] border border-(--line) bg-(--surface-2) px-2 text-[12px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';

function StatusDot({ online }: { online: boolean }) {
  // Filled vs hollow -- tellable apart without colour -- and the word itself
  // for a screen reader, which cannot see either.
  return (
    <>
      <span aria-hidden className="size-2 shrink-0 rounded-full"
            style={online
              ? { background: 'var(--online-dot)', boxShadow: '0 0 0 3px rgb(63 191 85 / 0.18)' }
              : { border: '1.5px solid var(--muted)' }} />
      <span className="sr-only">{online ? 'Online' : 'Offline'}</span>
    </>
  );
}

/** What a chip says (C8 spec §2): the dot, the name, the disk, the WP/RW tag and the chevron. Also the compact
 *  control's face for one board, under its own ids: the xl chip is mounted at the same time, and duplicate ids
 *  would break strict-mode getByTestId. */
function ChipFace({ chip, ids }: { chip: DriveChip; ids: 'chip' | 'compact' }) {
  const tag = protectTag(chip);
  const tid = (part: 'name' | 'disk' | 'wp') => (ids === 'chip' ? `drive-chip-${part}-${chip.id}` : `drives-compact-${part}`);
  return (
    <>
      <StatusDot online={chip.online} />
      <span className="max-w-[6rem] shrink-0 truncate font-semibold" data-testid={tid('name')}>{chip.shortName}</span>
      <span className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-(--muted)" data-testid={tid('disk')}>
        {diskText(chip)}
      </span>
      {tag && (
        <>
          <span className="shrink-0 rounded-[5px] bg-(--track) px-1.5 font-mono text-[11px] font-semibold leading-4 text-(--muted)"
                data-testid={tid('wp')}>
            {tag}
          </span>
          <span className="sr-only">{tag === 'WP' ? 'write-protected' : 'writable'}</span>
        </>
      )}
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
    </>
  );
}

// ---- One panel's open state and focus rules (spec §6) ---------------------------------------------------------

/** Why the panel last closed: Base UI's reason, 'navigate' for a link inside it, null while it is open. */
type CloseWhy = string | null;

type Panel = {
  open: boolean;
  onOpenChange: (open: boolean, details: Popover.Root.ChangeEventDetails) => void;
  /** Close for a link press: the destination's own focus rule applies, so focus is not sent back to the trigger. */
  close: () => void;
  finalFocus: () => boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  popupRef: RefObject<HTMLDivElement | null>;
};

/**
 * Ruling 20 (Base UI's finalFocus function gets the interaction type, not the reason -- C8 plan ruling): after an
 * outside press the pressed element keeps the focus if it took it (the search field), otherwise the trigger gets it;
 * after Tab out ('focus-out') or a link, focus is already where it should be; otherwise the trigger.
 */
function finalFocusFor(why: RefObject<CloseWhy>, trigger: RefObject<HTMLButtonElement | null>): boolean {
  const reason = why.current;
  if (reason === 'navigate' || reason === 'focus-out') return false;
  if (reason !== 'outside-press') return true;
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (!a || a === document.body) trigger.current?.focus();
  });
  return false;
}

/** Ruling 21: the trigger unmounted while its panel was open (the board was deleted elsewhere). */
function rescueIfOpen(why: RefObject<CloseWhy>) {
  if (why.current !== null) return;
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (!a || a === document.body) document.querySelector<HTMLElement>('[data-testid="wordmark-home"]')?.focus();
  });
}

function usePanel(): Panel {
  const [open, setOpen] = useState(false);
  // 'never' until first opened, so an unmount of a never-opened chip rescues nothing.
  const why = useRef<CloseWhy>('never');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => rescueIfOpen(why), []);
  return {
    open,
    onOpenChange: (next, details) => {
      why.current = next ? null : details.reason;
      setOpen(next);
    },
    close: () => {
      why.current = 'navigate';
      setOpen(false);
    },
    finalFocus: () => finalFocusFor(why, triggerRef),
    triggerRef,
    popupRef,
  };
}

/** The popup every panel uses (spec §3.1): 440 px, clamped on screen, focus on the popup itself on open (Ruling 19). */
function PanelPopup({ panel, testId, label, align, children }: {
  panel: Panel; testId: string; label: string; align: 'start' | 'end'; children: ReactNode;
}) {
  return (
    <Popover.Portal>
      <Popover.Positioner side="bottom" sideOffset={6} align={align} collisionPadding={16} className="z-50">
        <Popover.Popup
          ref={panel.popupRef}
          tabIndex={-1}
          aria-label={label}
          data-testid={testId}
          data-drive-panel=""
          initialFocus={panel.popupRef}
          finalFocus={panel.finalFocus}
          className="drive-panel flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-2xl border border-(--line) bg-(--surface) p-2 text-(--ink) outline-none"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}

/** One head row, then one card per board (Ruling 7). */
function PanelCards({ chips, panel }: { chips: DriveChip[]; panel: Panel }) {
  const ids = chips.map((c) => c.id).join(' ');
  const popupRef = panel.popupRef;
  // Ruling 21, second half: a card that vanished with the focus in it leaves this panel open with focus on <body>.
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body) popupRef.current?.focus();
  }, [ids, popupRef]);
  return (
    <>
      <PanelHead close={panel.close} />
      {chips.map((c) => <DriveCard key={c.id} chip={c} close={panel.close} />)}
    </>
  );
}

function PanelHead({ close }: { close: () => void }) {
  return (
    <div className="flex items-center justify-between px-2.5 pb-0.5 pt-2">
      {/* Plain text, not a heading: one per panel, no section structure (spec §3.2). */}
      <span className="text-[12px] font-medium text-(--muted-2)">Controlling</span>
      <Link href="/devices" data-testid="drive-panel-manage" onClick={close}
            className="flex items-center text-[13px] font-semibold text-(--accent-amber) underline-offset-2 hover:underline max-lg:min-h-11">
        Manage devices
      </Link>
    </div>
  );
}

// ---- The triggers ---------------------------------------------------------------------------------------------

function Chip({ chip, className }: { chip: DriveChip; className: string }) {
  const p = usePanel();
  return (
    <Popover.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Popover.Trigger
        ref={p.triggerRef}
        data-testid={`drive-chip-${chip.id}`}
        data-phase={chip.phase}
        data-online={chip.online ? 'true' : 'false'}
        // The alias, in full, where a truncated chip cannot fit it --
        // several identical floppies say nothing on their own.
        title={`${chip.name} — ${chip.online ? 'online' : 'offline'}`}
        className={`${CHIP_CLASS} ${className}`}
        style={chip.online ? undefined : { opacity: 0.8 }}
      >
        <ChipFace chip={chip} ids="chip" />
      </Popover.Trigger>
      <PanelPopup panel={p} testId={`drive-chip-menu-${chip.id}`} label={`${chip.name} drive`} align="start">
        <PanelCards chips={[chip]} panel={p} />
      </PanelPopup>
    </Popover.Root>
  );
}

/**
 * The overflow chip. Its NUMBER is switched by CSS, so it is right on the first paint at every width; its LIST is
 * chosen in JS from the same slots, which is safe because the list only exists once someone has opened it -- after
 * hydration, with a real viewport to read.
 */
function MoreChip({ chips, showAdmin }: { chips: DriveChip[]; showAdmin: boolean }) {
  const p = usePanel();
  const n = chips.length;
  const label = (slots: number) => `+${Math.max(0, n - slots)}`;
  return (
    <Popover.Root open={p.open} onOpenChange={p.onOpenChange}>
      {/* No aria-label: the other display:none number is out of the
          accessibility tree, so the name is exactly the "+k" on screen. */}
      <Popover.Trigger ref={p.triggerRef} data-testid="drive-chip-more" title="More drives"
                       className={`${MORE_CLASS} ${moreVisibility(n)}`}>
        {/* One number per band, each bounded by its own variant: one chip below 1920, two from it. */}
        <span className="min-[1920px]:hidden">{label(1)}</span>
        <span className="hidden min-[1920px]:inline">{label(2)}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </Popover.Trigger>
      <PanelPopup panel={p} testId="drive-chip-more-menu" label="Drives" align="start">
        <MoreCards chips={chips} showAdmin={showAdmin} panel={p} />
      </PanelPopup>
    </Popover.Root>
  );
}

function MoreCards({ chips, showAdmin, panel }: { chips: DriveChip[]; showAdmin: boolean; panel: Panel }) {
  return <PanelCards chips={splitChips(chips, chipSlots(window.innerWidth, showAdmin, chips.length)).rest} panel={panel} />;
}

/** Below xl: one control for every board (spec §8). */
function CompactControl({ chips }: { chips: DriveChip[] }) {
  const p = usePanel();
  return (
    <Popover.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Popover.Trigger ref={p.triggerRef} data-testid="drives-compact" className={`${CHIP_CLASS} flex max-lg:w-full`}>
        {/* The dot summarises: filled when every board is online, a ring when any is not -- each board's own reading
            is in its card. The number is how many boards, not the removed "n of N" position (Ruling 5). */}
        <StatusDot online={chips.every((c) => c.online)} />
        <span className="font-semibold">Drives</span>
        <span className="font-mono text-[13px] text-(--muted)">{chips.length}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </Popover.Trigger>
      {/* align="end": on a phone the trigger reaches the right edge; collisionPadding keeps the popup 16 px in. */}
      <PanelPopup panel={p} testId="drives-compact-menu" label="Drives" align="end">
        <PanelCards chips={chips} panel={p} />
      </PanelPopup>
    </Popover.Root>
  );
}

// ---- The card and its actions (spec §3.3, §4) -----------------------------------------------------------------

/**
 * Ruling 16: every action is busy from the press until its refresh lands -- aria-disabled (focus stays on it) plus a
 * guard (aria-disabled does not stop a click) plus aria-busy; try/catch/finally so a dropped connection never leaves
 * it busy; the request*() helpers already toast their own failures.
 */
function usePanelAction(allowed: boolean, request: () => Promise<boolean>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const inFlight = useRef(false);
  const off = !allowed || busy || pending;
  async function run() {
    if (off || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (await request()) start(() => router.refresh());
    } catch {
      toast.error('Something went wrong', { description: 'Try again.' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { run, off, busy: busy || pending };
}

/** Ruling 17: data-disabled mirrors aria-disabled, so the existing assertions keep their meaning. Never `disabled`. */
function offAttrs(off: boolean, busy: boolean) {
  return { 'aria-disabled': off || undefined, 'data-disabled': off ? '' : undefined, 'aria-busy': busy || undefined };
}

const ACTION =
  'flex h-9 items-center justify-center gap-2 rounded-[9px] border border-(--line) bg-(--surface) px-3 text-[13px] font-medium text-(--ink) outline-none hover:bg-(--track) focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-(--surface) max-lg:h-11';
const EJECT =
  'flex h-9 items-center justify-center gap-1.5 rounded-[9px] bg-(--ink) px-3.5 text-[13px] font-semibold text-(--surface) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] focus-visible:ring-offset-2 aria-disabled:cursor-default aria-disabled:opacity-50 max-lg:h-11';
const GEAR =
  'flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-(--line) bg-(--surface) text-(--ink) outline-none hover:bg-(--track) focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] max-lg:size-11';

/** DriveBox's "no reading yet" switch, at the panel's 28 x 16: knob left on the track. */
function NeutralSwitch() {
  return (
    <span aria-hidden="true" className="box-border flex h-4 w-7 shrink-0 items-center justify-start rounded-full p-0.5"
          style={{ background: 'var(--track)' }}>
      <span className="size-3 rounded-full" style={{ background: '#FFFDF8', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
    </span>
  );
}

/** One board's card (spec §3.3). Exported for the render tests. */
export function DriveCard({ chip, close }: { chip: DriveChip; close: () => void }) {
  const disk = chip.disk;
  const line = diskLine(chip);
  const pill = statusPill(chip.online);
  const hfe = chip.phase === 'loaded' && disk?.readOnly === 'HFE';
  // The switch's reading: on/off once a settled disk has a known flag (an HFE is always on); null draws the neutral one.
  const wpOn = chip.phase === 'loaded' && disk && (disk.readOnly !== null || disk.writeProtected !== null)
    ? disk.readOnly !== null || disk.writeProtected === true
    : null;

  const protect = usePanelAction(chip.canToggleProtect,
    () => (disk ? requestWriteProtect(disk.id, !disk.writeProtected) : Promise.resolve(false)));
  const next = usePanelAction(chip.next !== null, () => requestNextDisk(chip.id));
  const eject = usePanelAction(chip.canEject, () => requestEject(chip.id));

  // Ruling 18: Next unmounts on the loading refresh; if it held the focus, the same card's Eject takes it.
  const ejectRef = useRef<HTMLButtonElement>(null);
  const hadNext = useRef(chip.next !== null);
  useEffect(() => {
    const had = hadNext.current;
    hadNext.current = chip.next !== null;
    if (!had || chip.next !== null) return;
    const a = document.activeElement;
    if (!a || a === document.body) ejectRef.current?.focus();
  }, [chip.next]);

  const nextWords = chip.next ? nextLabel(chip.next) : null;

  return (
    <section data-testid={`drive-entry-${chip.id}`} aria-label={`${chip.name} controls`}
             className="flex flex-col gap-3 rounded-xl bg-(--surface-2) p-3.5">
      <div className="flex items-center gap-3">
        {disk ? (
          <DiskIcon size={44} color={driveDiskColor(disk.gameId)} wp={disk.readOnly !== null || disk.writeProtected === true} />
        ) : (
          <span aria-hidden="true" className="box-border h-[45px] w-11 shrink-0 rounded-[5px]"
                style={{ border: '1.5px dashed #C4B9A2' }} />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline">
            {/* The board's name goes to its card on /devices (operator, 2026-10-01); Ruling 13: no ↗. */}
            <Link href={`/devices#device-${chip.id}`} data-testid={`drive-entry-link-${chip.id}`} onClick={close}
                  className="min-w-0 truncate text-[15px] font-semibold text-(--ink) underline-offset-2 hover:underline">
              {chip.name}
            </Link>
            <span aria-hidden="true" className="shrink-0 whitespace-pre font-mono text-[12px] font-medium text-(--muted-2)">
              {' · DF0'}
            </span>
          </span>
          <span data-testid={`drive-entry-disk-${chip.id}`} className="truncate font-mono text-[12px] text-(--muted)">
            {line.kind === 'title' && chip.canGoTo && disk?.gameId ? (
              <Link href={`/games/${disk.gameId}`} data-testid={`drive-goto-${chip.id}`} onClick={close}
                    className="underline-offset-2 hover:underline">{line.title}</Link>
            ) : (
              // No link (Plan ruling): the words carry Go to disk's id, marked off, so it still reads as unavailable.
              <span data-testid={`drive-goto-${chip.id}`} data-disabled="">{line.kind === 'title' ? line.title : line.text}</span>
            )}
            {line.kind === 'title' && line.count && ` · ${line.count}`}
          </span>
          {chip.next?.preload && (
            <span className="text-[12px] text-(--muted)" data-testid={`drive-preload-${chip.id}`} data-preload={chip.next.preload}>
              {preloadText(chip.next.diskNo, chip.next.preload)}
            </span>
          )}
          {chip.df1 && (
            <span className="truncate text-[12px] text-(--muted)" data-testid={`drive-entry-df1-${chip.id}`}>{chip.df1}</span>
          )}
        </div>
        {/* Both values, in words -- the Devices card's pill (statusPill). */}
        <span data-testid={`drive-entry-status-${chip.id}`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold"
              style={{ background: pill.bg, color: pill.fg }}>
          <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: pill.dot }} />
          {pill.label}
        </span>
      </div>

      {!chip.online && (
        // Ruling 10: every control stays live; this says why that is safe.
        <p data-testid={`drive-entry-offline-${chip.id}`} className="text-[12px] text-(--amber-text)">
          Offline, last seen {chip.seen}. Changes reach it when it reconnects.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={wpOn === true}
          data-testid={`drive-protect-${chip.id}`}
          data-protected={disk && chip.phase === 'loaded' && disk.writeProtected !== null
            ? String(disk.readOnly !== null || disk.writeProtected) : undefined}
          title={hfe ? 'HFE disks are always read-only' : undefined}
          {...offAttrs(protect.off, protect.busy)}
          onClick={() => void protect.run()}
          className={`${ACTION} min-w-[9rem] flex-1 justify-start`}
        >
          {wpOn === null ? <NeutralSwitch /> : <WpSwitch on={wpOn} small />}
          Write-protect
          {hfe && <span className="sr-only"> (HFE, always read-only)</span>}
          {wpOn === null && <span className="sr-only"> (shown once the board holds a disk)</span>}
        </button>
        {nextWords && (
          <button type="button" data-testid={`drive-next-${chip.id}`} {...offAttrs(next.off, next.busy)}
                  aria-label={next.busy ? undefined : nextWords.name} title={nextWords.name}
                  onClick={() => void next.run()} className={ACTION}>
            {next.busy ? 'Switching…' : nextWords.text}
          </button>
        )}
        {/* Always rendered (Ruling 9): an empty drive shows it off, not a "Mount a disk" and not nothing. */}
        <button ref={ejectRef} type="button" data-testid={`drive-eject-${chip.id}`} {...offAttrs(eject.off, eject.busy)}
                title={chip.canEject ? undefined : 'The drive is empty'}
                onClick={() => void eject.run()} className={EJECT}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 5l7 9H5z" /><rect x="5" y="16.5" width="14" height="2.5" rx="1" />
          </svg>
          {eject.busy ? 'Ejecting…' : 'Eject'}
        </button>
        {/* Ruling 12: the board's existing Board settings modal, opened on /devices (Task 4 of the C8 plan). */}
        <Link href={`/devices?settings=${chip.id}`} data-testid={`drive-settings-${chip.id}`} onClick={close}
              aria-label={`${chip.name} board settings`} className={GEAR}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
```

Notes for this step:
- If `Popover.Root.ChangeEventDetails` does not resolve as a type, import it as
  `import type { PopoverRootChangeEventDetails } from '@base-ui/react/popover';` (check
  `node_modules/@base-ui/react/popover/index.parts.d.ts` for the exported name) and use that in `Panel`.
- If `pnpm lint` reports a new warning in `usePanel` or `DriveCard` (react-hooks `refs`, `exhaustive-deps`), fix it
  in the code, never with a disable comment, and keep the count at 12.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/components/shell/drive-chips.test.ts src/lib/drive-chips.test.ts` → PASS.
If the `aria-checked`/`aria-disabled` regexes fail on attribute order, read the rendered tag and keep the asserted
attributes; never drop one. Then the whole unit suite, `npx tsc --noEmit`, `pnpm lint` (12 warnings, exit 0).

Pin Base UI's Tab behaviour (spec §6, "Tab past the last control"): run `C8-08` (below). If the panel stays open
after the Tab past the gear, add to `usePanel` a `focusout` listener on the popup that closes the panel (setting
`why.current = 'focus-out'`) when `event.relatedTarget` is outside both the popup and the trigger, and say so in the
task report.

e2e, one at a time, each timed:
1. `time PORT=3100 npx playwright test e2e/c8-drive-menu.spec.ts --project=desktop -g "C8-0[1-6]"` → `7 passed`
   (01a, 01b, 02, 03, 04, 05, 06).
2. `time PORT=3100 npx playwright test e2e/c8-drive-menu.spec.ts --project=desktop -g "C8-0[89]|C8-1[0146]"` → `6 passed`
   (08, 09, 10, 11, 14, 16).
3. `time PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "fresh org|empty board|name in its menu|mount shows|write-protect|eject reads|offline board|DF1 On"`
   → `8 passed`.
4. `time PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "the chips stay|centred|long names|first-paint|exactly one number|390px|admin plane"`
   → `9 passed`.
5. `time PORT=3100 npx playwright test e2e/next-disk.spec.ts --project=desktop` → `7 passed`.
6. `time PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "admin plane|no chip|drive"` →
   check the count with `--list` first; all pass.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/shell/drive-chips.tsx src/components/shell/drive-chips.test.ts \
  src/components/games/write-protect-toggle.tsx src/app/globals.css \
  e2e/c8-drive-menu.spec.ts e2e/drive-chips.spec.ts e2e/next-disk.spec.ts
git commit -m "C8: the drive menu becomes the board's panel: a Popover dialog with Manage devices and one card per board, busy actions, focus rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 4: `/devices?settings=<id>` opens that board's Board settings and strips the parameter

**Files:**
- Modify: `src/components/devices/device-list.tsx:2-4`, `:48`, `:245-257`; `src/components/devices/device-card.tsx:25-38`,
  `:85`; `src/components/devices/board-settings.tsx:2`, `:27`, after `:52`; `e2e/c8-drive-menu.spec.ts` (append)

**Interfaces:**
- Consumes: the gear's href `/devices?settings=<id>` (Task 3); `useSearchParams` (`next/navigation`).
- Produces: `DeviceCard`'s new optional prop `openSettings?: boolean`; `BoardSettings`'s new optional prop
  `openOnArrival?: boolean`. `src/app/(app)/devices/page.tsx` is not changed.

**Plan ruling** (spec §4.4, "the page passes `searchParams.settings` down"): `DeviceList` reads the parameter with
`useSearchParams()` instead. A server prop is fixed by the RSC payload and does not change when the parameter is
stripped with `replaceState`, so after the first arrival the prop would still say `<id>`, and a second press on the same
board's gear (a client navigation to the same `?settings=<id>`) would change nothing and open nothing (Review Focus 1).
`useSearchParams` follows `replaceState` (Next 16 docs, "Native History API"): null after the strip, `<id>` again on
the next press. The page stays as it is.

**Plan ruling** (spec §4.4, "`show()` in an effect"): the modal opens in a `requestAnimationFrame` started by the
effect, and the frame is **not** cancelled on cleanup. Calling `setState` in the effect body trips the repo's
react-hooks `set-state-in-effect` rule, and cancelling would let the re-render that the strip causes take the open
back. Opening twice (StrictMode in dev) is harmless.

- [ ] **Step 1: Write the failing test**

Append to `e2e/c8-drive-menu.spec.ts`:

```ts
test('C8-07 the gear opens the board\'s Board settings on /devices, strips the URL, works again from /devices, and a foreign id opens nothing', async ({ page, request }) => {
  test.setTimeout(60_000);
  await signUpFresh(page);
  const { deviceId } = await onlineBoard(page, request, 'Bench');
  await page.goto('/library');
  await openPanel(page, deviceId);
  const gear = page.getByTestId(`drive-settings-${deviceId}`);
  await expect(gear).toHaveAttribute('href', `/devices?settings=${deviceId}`);
  await gear.click();
  const dialog = page.getByTestId('board-settings-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-device-id', deviceId);
  await expect(page).toHaveURL(new RegExp(`/devices#device-${deviceId}$`));
  expect(page.url()).not.toContain('settings=');
  await page.getByTestId('board-settings-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`board-settings-${deviceId}`)).toBeFocused();

  // Review Focus 1: the same gear again, from /devices, after the strip.
  await openPanel(page, deviceId);
  await page.getByTestId(`drive-settings-${deviceId}`).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-device-id', deviceId);
  expect(page.url()).not.toContain('settings=');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`board-settings-${deviceId}`)).toBeFocused();

  // An id that is not this org's: nothing opens and the parameter goes.
  await page.goto('/devices?settings=dev_not_this_orgs');
  await expect(page).toHaveURL(/\/devices$/);
  await page.waitForTimeout(1_000);
  await expect(dialog).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `time PORT=3100 npx playwright test e2e/c8-drive-menu.spec.ts --project=desktop -g "C8-07"`
Expected: FAIL — `/devices?settings=<id>` opens no dialog.

- [ ] **Step 3: Implement**

`src/components/devices/board-settings.tsx`: the signature on line 27 becomes

```tsx
export function BoardSettings({ device, openOnArrival = false }: {
  device: DeviceListItem;
  /** The header drive panel's gear (C8 spec §4.4, Ruling 12) landed here as /devices?settings=<this id>. */
  openOnArrival?: boolean;
}) {
```

line 2 adds `useEffect` to the React import
(`import { useEffect, useMemo, useRef, useState, useTransition, type RefObject } from 'react';`), and after `show()`
(which ends on line 52) insert:

```tsx
  // Opened once on arrival from the header's gear: the card into the middle of the view, then the modal, with its own
  // initial focus; Cancel returns focus to this card's Board settings button (finalFocus). In a frame, because
  // setting state in the effect body trips react-hooks/set-state-in-effect; NOT cancelled on cleanup, because
  // DeviceList strips the parameter in the same commit and that re-render must not take the open back.
  useEffect(() => {
    if (!openOnArrival) return;
    requestAnimationFrame(() => {
      document.getElementById(`device-${id}`)?.scrollIntoView({ block: 'center' });
      setDraft(device.bootDisk);
      setFailed(null);
      setOpen(true);
    });
  }, [openOnArrival, id, device.bootDisk]);
```

`src/components/devices/device-card.tsx`: add to the destructured props on line 26
(`{ device, now, firmware, selection, onCancelUpdate, next, sendLine, transfer, uploadLine, openSettings }`) and to
the props type after `uploadLine?: …;` (line 37):

```tsx
    /** True once, when the header drive panel's gear asked for this board's Board settings (C8 spec §4.4). */
    openSettings?: boolean;
```

and line 85 becomes `<BoardSettings device={device} openOnArrival={openSettings} />`.

`src/components/devices/device-list.tsx`: line 4 becomes `import { useRouter, useSearchParams } from 'next/navigation';`.
After `const router = useRouter();` (line 48) insert:

```tsx
  // The header drive panel's gear links to /devices?settings=<id> (C8 spec §4.4, Ruling 12). Read here, on the client,
  // rather than as the page's searchParams prop: the prop would still hold <id> after the strip below, so a second
  // press on the same gear would change nothing (C8 plan ruling). The matching card opens its Board settings; any id
  // (known or not) leaves the URL -- the known one for its card's anchor, as the board-name link does.
  const arrival = useSearchParams().get('settings');
  useEffect(() => {
    if (arrival === null) return;
    const known = devices.some((d) => d.id === arrival);
    window.history.replaceState(null, '', known ? `/devices#device-${arrival}` : '/devices');
  }, [arrival, devices]);
```

and in the `DeviceCard` element (lines 246-256) add the prop `openSettings={arrival === d.id}` after
`uploadLine={uploadLineById[d.id] ?? null}`.

- [ ] **Step 4: Run the tests to see them pass**

Unit: `pnpm test --testTimeout=30000 src/components/devices/board-settings.test.ts` → PASS (unchanged behaviour when the
prop is absent); then the whole suite, `npx tsc --noEmit`, `pnpm lint` (12 warnings, exit 0).

e2e, one at a time, each timed:
1. `time PORT=3100 npx playwright test e2e/c8-drive-menu.spec.ts --project=desktop -g "C8-07"` → `1 passed`.
2. `time PORT=3100 npx playwright test e2e/devices-page.spec.ts --project=desktop -g "Board settings"` → check the
   count with `--list`; all pass.
3. `time PORT=3100 npx playwright test e2e/device-delete.spec.ts --project=desktop` → `3 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/devices/device-list.tsx src/components/devices/device-card.tsx \
  src/components/devices/board-settings.tsx e2e/c8-drive-menu.spec.ts
git commit -m "C8: /devices?settings=<id> opens that board's Board settings once and strips the parameter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 5: Below xl: the compact control becomes the board's chip for one board; the phone panel

**Files:**
- Create: `e2e/c8-drive-menu.mobile.spec.ts`
- Modify: `src/components/shell/drive-chips.tsx` (`CompactControl` only), `src/components/shell/drive-chips.test.ts`
  (append), `e2e/drive-chips.spec.ts:440-447`, `e2e/c8-drive-menu.spec.ts` (append)

**Interfaces:**
- Consumes: Task 2's `ChipFace` (`ids="compact"`), `CHIP_CLASS`; Task 3's `usePanel`, `PanelPopup`, `PanelCards`,
  `StatusDot`, `.drive-panel`.
- Produces: `drives-compact-name`, `drives-compact-disk`, `drives-compact-wp` on the compact control with one board.

**Plan ruling** (Review Focus 4, spec §8 "lg→xl it follows the wordmark (unchanged)"): with one board the compact
control is up to 240 px wide from lg (today's "● Drives 1" is 90 px). `C8-17` measures it at 1024 and 1180 with the
widest case. If a tab of the in-flow pill is clipped or the pill runs under the search box, cap the control between
lg and xl (`lg:max-w-[<n>px] xl:max-w-[240px]` on the compact trigger only), lowering `<n>` from 240 in 20 px steps
until `C8-17` passes, and report the value as a Plan ruling for the controller to relay.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/shell/drive-chips.test.ts`:

```ts
describe('the compact control below xl (C8 spec §8, Rulings 5, 6)', () => {
  it('one board: that board\'s chip -- name, disk, tag -- under the compact ids, never the xl chip\'s', () => {
    const html = chips([base]);
    expect(html).toMatch(/data-testid="drives-compact-name"[^>]*>Bench</);
    expect(html).toMatch(/data-testid="drives-compact-disk"[^>]*>Turrican</);
    expect(html).toMatch(/data-testid="drives-compact-wp"[^>]*>WP</);
    expect(html.match(/data-testid="drive-chip-name-dev-a"/g)?.length).toBe(1);   // the xl chip's only
    expect(openTag(html, 'drives-compact')).toContain('title="Bench — online"');
  });
  it('two or more boards: "Drives n", a count of boards', () => {
    const html = chips(two);
    expect(html).not.toContain('drives-compact-name');
    expect(html).toMatch(/data-testid="drives-compact"[^>]*>.*Drives<\/span><span[^>]*>2<\/span>/);
  });
});
```

`e2e/c8-drive-menu.mobile.spec.ts` (new):

```ts
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded, hydrated } from './device-helpers';

/**
 * Phase C8 on a phone (spec §8, §9.5 C8-12, C8-13): the `mobile` project (390 x 844, touch). Touch never hovers, so
 * nothing here asserts a hover style. The DB is the live one: every assertion is about rows the test made.
 */
test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function onlineBoard(page: Page, request: APIRequestContext, name: string) {
  const board = await pairDevice(page, request, name);
  await getDb().update(devices).set({ name, lastSeenAt: new Date() }).where(eq(devices.id, board.deviceId));
  return board;
}

async function loadedBoard(page: Page, request: APIRequestContext, orgId: string, name: string, disks = 2) {
  const board = await onlineBoard(page, request, name);
  const tag = runTag();
  const title = `C8 ${name} ${tag.slice(-5)}`;
  const s1 = sha(`c8m-${tag}-1`);
  const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: s1 });
  for (let n = 2; n <= disks; n++) await addDisk(orgId, gameId, { diskNo: n, sha256: sha(`c8m-${tag}-${n}`) });
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: s1, mountedDiskId: diskId, version },
  })).status()).toBe(204);
  return { ...board, title };
}

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
/** The fixed bottom bar: nav -> clamp -> bar (C7). */
const bar = (page: Page) => page.getByRole('navigation', { name: 'Main' }).locator('xpath=../..');

async function openCompact(page: Page) {
  await hydrated(page, 'drives-compact');
  await page.getByTestId('drives-compact').tap();
  await expect(page.getByTestId('drives-compact-menu')).toBeVisible();
}

test('C8-12 one board at 390: the compact control is the board\'s chip; the panel fits, stops above the bar, 44 px targets', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const b = await loadedBoard(page, request, orgId, 'C8 Phone board', 2);
  await page.goto('/library');
  const compact = page.getByTestId('drives-compact');
  await expect(page.getByTestId('drives-compact-name')).toHaveText('C8 Phone board');
  await expect(page.getByTestId('drives-compact-disk')).toHaveText(b.title);
  await expect(page.getByTestId('drives-compact-wp')).toHaveText('WP');
  expect((await compact.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await openCompact(page);
  const p = page.getByTestId('drives-compact-menu');
  await expect.poll(async () => {
    const box = (await p.boundingBox())!;
    return box.width <= 358.5 && box.x >= 15.5 && box.x + box.width <= 390 - 15.5;
  }, { message: 'panel inside the 16 px gutters' }).toBe(true);
  const barTop = (await bar(page).boundingBox())!.y;
  const pb = (await p.boundingBox())!;
  expect(pb.y + pb.height, 'the panel ends above the tab bar').toBeLessThanOrEqual(barTop + 0.5);
  for (const id of ['drive-panel-manage', `drive-protect-${b.deviceId}`, `drive-next-${b.deviceId}`,
    `drive-eject-${b.deviceId}`, `drive-settings-${b.deviceId}`]) {
    await expect.poll(async () => (await page.getByTestId(id).boundingBox())!.height, { message: id }).toBeGreaterThanOrEqual(44);
  }
  expect((await page.getByTestId(`drive-settings-${b.deviceId}`).boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await noSideways(page);
});

test('C8-13 two boards at 390: "Drives 2", two cards under one head row, and the panel scrolls inside itself when short', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 560 });
  const { orgId } = await signUpFresh(page);
  const a = await loadedBoard(page, request, orgId, 'C8 Phone A', 2);
  const b = await loadedBoard(page, request, orgId, 'C8 Phone B', 2);
  await page.goto('/library');
  const compact = page.getByTestId('drives-compact');
  await expect(compact).toContainText('Drives');
  await expect(compact).toContainText('2');
  await expect(page.getByTestId('drives-compact-name')).toHaveCount(0);
  await openCompact(page);
  const p = page.getByTestId('drives-compact-menu');
  await expect(p.getByTestId('drive-panel-manage')).toHaveCount(1);
  await expect(p.locator('section[data-testid^="drive-entry-"]')).toHaveCount(2);
  for (const id of [a.deviceId, b.deviceId]) await expect(p.getByTestId(`drive-entry-${id}`)).toBeAttached();
  expect(await p.evaluate((el) => el.scrollHeight > el.clientHeight), 'taller than the room: it scrolls').toBe(true);
  const barTop = (await bar(page).boundingBox())!.y;
  const pb = (await p.boundingBox())!;
  expect(pb.y + pb.height).toBeLessThanOrEqual(barTop + 0.5);
  await p.getByTestId(`drive-eject-${b.deviceId}`).scrollIntoViewIfNeeded();
  await expect(p.getByTestId(`drive-eject-${b.deviceId}`)).toBeInViewport();
  await noSideways(page);
});
```

Append to `e2e/c8-drive-menu.spec.ts`:

```ts
test('C8-17 one board, long name and title, at 1024 and 1180: the compact chip leaves the pill whole and clear of search (Review Focus 4)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  await loadedBoard(page, request, orgId, 'A rather long board name', 1);
  for (const width of [1024, 1180]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/library');
    await expect(page.getByTestId('drives-compact-name')).toBeVisible();
    await page.waitForTimeout(150);   // HeaderStart's ResizeObserver settles on the real pill
    const m = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('[data-testid="app-header"]')!;
      const nav = header.querySelector('nav')!;
      const clamp = nav.parentElement!.getBoundingClientRect();
      const search = header.querySelector('[data-testid="search-input"]')!.getBoundingClientRect();
      const compact = header.querySelector('[data-testid="drives-compact"]')!.getBoundingClientRect();
      const tabs = [...nav.querySelectorAll('a')].filter((a) => a.offsetWidth > 0).map((a) => a.getBoundingClientRect());
      return {
        clampL: clamp.left, clampR: clamp.right, searchL: search.left, compactR: compact.right,
        clipped: tabs.filter((t) => t.left < clamp.left - 0.5 || t.right > clamp.right + 0.5).length,
      };
    });
    expect(m.clampR, `${width}: pill under the search box ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.searchL + 0.5);
    expect(m.clampL, `${width}: pill into the chip ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(m.compactR - 0.5);
    expect(m.clipped, `${width}: a tab is clipped ${JSON.stringify(m)}`).toBe(0);
  }
});
```

`e2e/drive-chips.spec.ts`, in the 390 test replace lines 440-447 (the clamp and the 32 px poll) with:

```ts
  // The panel keeps the 16 px gutters (C8 spec §8, collisionPadding), and every action is 44 px below lg.
  await expect.poll(async () => {
    const box = (await list.boundingBox())!;
    return box.x >= 15.5 && box.x + box.width <= 390 - 15.5;
  }).toBe(true);
  await expect.poll(async () => (await page.getByTestId(`drive-eject-${a.deviceId}`).boundingBox())!.height)
    .toBeGreaterThanOrEqual(44);
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/components/shell/drive-chips.test.ts` → FAIL (no `drives-compact-name`).

- [ ] **Step 3: Implement**

Replace `CompactControl` in `src/components/shell/drive-chips.tsx` with:

```tsx
/** Below xl: one control (spec §8). One board: that board's chip (Ruling 6). Two or more: "Drives n" (Ruling 5). */
function CompactControl({ chips }: { chips: DriveChip[] }) {
  const p = usePanel();
  const one = chips.length === 1 ? chips[0] : null;
  return (
    <Popover.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Popover.Trigger
        ref={p.triggerRef}
        data-testid="drives-compact"
        title={one ? `${one.name} — ${one.online ? 'online' : 'offline'}` : undefined}
        className={`${CHIP_CLASS} flex max-lg:w-full`}
        style={one && !one.online ? { opacity: 0.8 } : undefined}
      >
        {one ? (
          <ChipFace chip={one} ids="compact" />
        ) : (
          <>
            {/* The dot summarises: filled when every board is online, a ring when any is not -- each board's own
                reading is in its card. The number is how many boards, not the removed "n of N" position. */}
            <StatusDot online={chips.every((c) => c.online)} />
            <span className="font-semibold">Drives</span>
            <span className="font-mono text-[13px] text-(--muted)">{chips.length}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          </>
        )}
      </Popover.Trigger>
      {/* align="end": on a phone the trigger reaches the right edge; collisionPadding keeps the popup 16 px in. */}
      <PanelPopup panel={p} testId="drives-compact-menu" label="Drives" align="end">
        <PanelCards chips={chips} panel={p} />
      </PanelPopup>
    </Popover.Root>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Unit: `pnpm test --testTimeout=30000 src/components/shell/drive-chips.test.ts` → PASS; the whole suite,
`npx tsc --noEmit`, `pnpm lint` (12 warnings, exit 0).

e2e, one at a time, each timed:
1. `time PORT=3100 npx playwright test e2e/c8-drive-menu.mobile.spec.ts --project=mobile` → `2 passed`. If C8-13's
   panel does not scroll at 560 px, the cards are shorter than estimated: lower the height to 480 and re-run; the
   assertion stays.
2. `time PORT=3100 npx playwright test e2e/c8-drive-menu.spec.ts --project=desktop -g "C8-17"` → `1 passed` (if not,
   the Plan ruling's capping procedure).
3. `time PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "390px"` → `1 passed`.
4. `time PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-01"` → `2 passed` (C7-01,
   C7-01b).
5. `time PORT=3100 npx playwright test e2e/header-overlap.spec.ts --project=desktop` → `5 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/shell/drive-chips.tsx src/components/shell/drive-chips.test.ts \
  e2e/c8-drive-menu.mobile.spec.ts e2e/c8-drive-menu.spec.ts e2e/drive-chips.spec.ts
git commit -m "C8: below xl one board's compact control is its chip; the phone panel stops above the tab bar with 44 px targets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 6: Final pass: contrast, by-hand checks at 1280 and 390, every drive-chip, header and device e2e in batches

**Files:**
- Modify: `e2e/contrast.spec.ts` (append one test); `README.md` / `docs/*.md` only if Step 4's grep finds wording.
- Create and delete (never committed): `e2e/zz-c8-shots.spec.ts`, `e2e/zz-c8-shots.mobile.spec.ts`

**Interfaces:**
- Consumes: every task's DOM; `legible()` and `hydrated()`; the imports `contrast.spec.ts` already has
  (`signUpFresh`, `runTag`, `pairDevice`, `seedDisk`, `authHeader`, `hydrated`, `getDb`, `devices`, `eq`, `createHash`).
- Produces: nothing later work uses.

- [ ] **Step 1: Write the failing test**

Append to `e2e/contrast.spec.ts`:

```ts
// Phase C8 (spec §9.5 C8-15, Ruling 23): the drive panel's text on its real elements -- Manage devices
// (--accent-amber) on the popup's --surface, the disk line (--muted) on the card's --surface-2, the offline line
// (--amber-text) on --surface-2, and both pills' words on their pills.
test('C8-15 the drive panel pairs are legible: Manage devices, the disk line, the offline line, both pills', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const on = await pairDevice(page, request, 'Aa contrast on');
  const off = await pairDevice(page, request, 'Ab contrast off');
  await getDb().update(devices).set({ name: 'Aa contrast on', lastSeenAt: new Date() }).where(eq(devices.id, on.deviceId));
  await getDb().update(devices).set({ name: 'Ab contrast off', lastSeenAt: new Date(Date.now() - 60 * 60_000) })
    .where(eq(devices.id, off.deviceId));
  const tag = runTag();
  const s = createHash('sha256').update(`c8-contrast-${tag}`).digest('hex');
  const { diskId } = await seedDisk(orgId, { title: `Contrast ${tag.slice(-5)}`, diskNo: 1, sha256: s });
  const res = await page.request.post(`/api/devices/${on.deviceId}/mount`, { data: { diskId } });
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(on.token), data: { mountedSha256: s, mountedDiskId: diskId, version },
  })).status()).toBe(204);

  await page.goto('/library');
  await hydrated(page, `drive-chip-${on.deviceId}`);
  await page.getByTestId(`drive-chip-${on.deviceId}`).click();
  await expect(page.getByTestId(`drive-chip-menu-${on.deviceId}`)).toBeVisible();
  await page.mouse.move(0, 0);
  await legible(page, 'drive', [
    ['Manage devices', '[data-testid="drive-panel-manage"]'],
    ['disk line', `[data-testid="drive-entry-disk-${on.deviceId}"]`],
    ['Online pill', `[data-testid="drive-entry-status-${on.deviceId}"]`],
  ]);
  await page.keyboard.press('Escape');
  // At 1280 the second board is behind "+1".
  await hydrated(page, 'drive-chip-more');
  await page.getByTestId('drive-chip-more').click();
  await expect(page.getByTestId('drive-chip-more-menu')).toBeVisible();
  await page.mouse.move(0, 0);
  await legible(page, 'drive', [
    ['offline line', `[data-testid="drive-entry-offline-${off.deviceId}"]`],
    ['Offline pill', `[data-testid="drive-entry-status-${off.deviceId}"]`],
  ]);
});
```

- [ ] **Step 2: Run it to see it fail or pass**

`time PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "C8-15"` → 1 test. If it already passes,
Tasks 3 and 5 built the looks to the tokens: record the logged ratios in the report (Manage devices is expected near
4.86:1 by the token's own note).

- [ ] **Step 3: Implement** — only what Step 2 shows is wrong. Expected: nothing. A failed ratio is fixed in the
  component's colour toward the spec's token (for Manage devices, `--amber-text`, and report it as a Plan ruling
  against Ruling 23), never by lowering 4.5 and never by pointing a selector elsewhere.

- [ ] **Step 4: The gates, the words, the by-hand check, the regression**

The gates: `pnpm test --testTimeout=30000` (whole), `npx tsc --noEmit`, then `pnpm lint; echo "exit $?"` →
`✖ 12 problems (0 errors, 12 warnings)` and `exit 0`.

The words: `grep -n "drive menu\|Drives control\|Go to disk\|Next disk:" README.md docs/*.md src/lib/help/topics.tsx`.
Expected: the `next-disk` help topic still reads "the board's card, the drive menu, or a Next-disk card" and the
button it names says "Next: disk N" in both places (spec §10: nothing changes). Reword a README or `docs/*.md` hit only
if it describes today's panel wrongly. Then
`grep -rn "DropdownMenu" src/components/shell/drive-chips.tsx` → no hit.

By hand, on the dev server (3100), with screenshots for the operator in the session scratchpad only (they must never
show an email address or the live operator's boards; the e2e fake names are fine):

1. Write `e2e/zz-c8-shots.spec.ts` (desktop, 1280 × 800) and `e2e/zz-c8-shots.mobile.spec.ts` (390 × 844). Each signs
   up fresh, pairs a board named `Shot board` holding disk 1 of a two-disk title (the `loadedBoard` helper's steps)
   and a second board `Shot offline` set offline, then shoots: the closed header; a chip's open panel; the "+1" panel;
   the empty-drive panel (after Eject and an empty report); the offline card; `/devices` with Board settings opened
   from the gear. Each call:
   `await page.screenshot({ path: '<scratchpad>/c8-shots/<width>-<name>.png', fullPage: false, mask: [page.locator('[data-testid="account-email"], [data-testid="admin-email"]')], maskColor: '#F6F2E9' });`
   (`<scratchpad>` is the absolute scratchpad directory of this session).
2. Run each once: `time PORT=3100 npx playwright test e2e/zz-c8-shots.spec.ts --project=desktop`, then
   `time PORT=3100 npx playwright test e2e/zz-c8-shots.mobile.spec.ts --project=mobile`.
3. Open every PNG. Confirm no email address is readable. Then compare with the spec and the operator's screenshot
   (`design-approved/drive-menu-simple-operator-2026-10-25.png` in the session scratchpad): the chip "● name disk WP ⌄"
   with no "n/N"; the open chip on an ink border; "Controlling" left, amber "Manage devices" right; the card's icon,
   "<name> · DF0", "<title> · disk 1 of 2", the pill, the wide Write-protect switch, Next, the ink Eject, the square
   gear; at 390 the panel inside the gutters, above the tab bar, the actions wrapping with Write-protect first.
4. Keyboard by hand at 1280 in the same headed run or with `page.keyboard`: Tab to a chip, Enter, Tab through the
   panel; every control shows a focus ring and the order is Manage devices → name → title → Write-protect → Next →
   Eject → gear.
5. Delete both files: `rm e2e/zz-c8-shots.spec.ts e2e/zz-c8-shots.mobile.spec.ts`, and confirm
   `git status --short e2e` does not list them. Record what you saw on each shot, and give the scratchpad path.

The regression — every drive-chip, header and device spec (Global Constraints' grep list), ONE run at a time, each
timed and under 9 minutes, `--list` first so each file is covered whole:

1. `e2e/c8-drive-menu.spec.ts --project=desktop`: `--list` → 15 tests (01a, 01b, 02–11, 14, 16, 17; recount if not).
   Then `-g "C8-0[1-6]"` → 7 passed; then `-g "C8-0[7-9]|C8-1"` → 8 passed.
2. `time PORT=3100 npx playwright test e2e/c8-drive-menu.mobile.spec.ts --project=mobile` → 2 passed.
3. `e2e/drive-chips.spec.ts` in Task 3's two halves → 8 + 9 passed.
4. `time PORT=3100 npx playwright test e2e/next-disk.spec.ts e2e/header-overlap.spec.ts e2e/shell.spec.ts --project=desktop`
   → 7 + 5 + 2 passed.
5. `e2e/c7-phone.mobile.spec.ts --project=mobile`: `--list`, then `-g "C7-0[1-4]"`, then `-g "C7-0[5-9]|C7-1[01]"`
   → all pass; together they cover the listed count.
6. `e2e/c6-admin-layout.spec.ts --project=desktop`: `--list`, then two `-g` halves chosen from the listed titles so
   each is 13 or fewer → all pass.
7. `e2e/c5-layout.spec.ts --project=desktop`: `--list`, then halves of 17 or fewer → all pass.
8. `time PORT=3100 npx playwright test e2e/breadcrumb.spec.ts e2e/library-paging.spec.ts --project=desktop` → 5 + 8.
9. `e2e/collections.spec.ts --project=desktop`: `--list`, then two halves → all pass.
10. `e2e/contrast.spec.ts --project=desktop`: `--list` (19 tests with C8-15), then
    `-g "sign-in text|sign-up text|shell and an empty library|library card|admin sans subtitle|toast description|search panel metadata|header focus|Devices pairs"`,
    then `-g "Upload pairs|Disk files pairs|open popover|Settings pairs|Help pairs|Search panel pairs|Sign-in and Create account pairs|Admin pairs|phone shell pairs|C8-15"`
    → all pass; check that the two slices cover the count.
11. `time PORT=3100 npx playwright test e2e/devices-page.spec.ts --project=desktop --list`, then halves of about 20
    tests by `-g` → all pass; then `e2e/device-delete.spec.ts` → 3 passed.

- [ ] **Step 5: Commit** — re-check `git status --short` (the shots specs must be gone), then:

```bash
git add e2e/contrast.spec.ts
git commit -m "C8: the drive panel's text pairs measured; final drive-chip, header and device regression and the lint gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

(Add `README.md` or a `docs/*.md` file to `git add` only if Step 4's grep changed it. The HANDOFF entry for C8, which
records the Rulings, the Plan rulings and the backlog item "DriveBox / NextDiskButton / BoardSettings still use native
`disabled`" (spec §11), is the controller's after the merge, not this task's.)

---

## Self-review (against the spec)

- §0 invariants → Global Constraints. Test ids kept: every §9.1 id is rendered by Task 3's `drive-chips.tsx`
  (`drive-goto` on the words when there is no link; `drive-entry` on the `section`); new ids §9.2 → Tasks 3, 5. No
  optimistic state: `usePanelAction` refreshes only; C8-03/04 assert the flip and the empty arrive by refresh.
  Show both values: chip ring/dot + sr-only word, WP/RW + sr-only word (2), pill + offline line, neutral switch +
  sr-only reason, "Drive empty" (3). aria-disabled + guard + try/catch/finally: `usePanelAction`, `offAttrs` (3), unit
  test "never native disabled", C8-03–06. Admin plane: `drive-chips.spec` "admin plane", `c6-admin-layout` (3, 6).
  Self-host: no new URL, font, package.
- §1 measurements → the baselines the tests replace (the 3.8 s live update → C8-09's 8 s LIVE; focus after Escape and
  outside press → C8-08; no busy state → C8-03/04/05; offline actions live → C8-14).
- §2 chip → Task 2 (look, `lg:max-w-[240px]`, no count, unit + C8-01a). §2.1 slots → Task 1 (`chipSlots`), Task 2
  (CSS, `late`, worst-case test, the measurement record, C8-11).
- §3.1 Popover frame → Task 3 `PanelPopup` (side, offset, align, collisionPadding, z-50, 440 px, p-2, 16 px radius,
  surface, line, shadow, gap-1.5, `.drive-panel` max-height). §3.2 head row → `PanelHead` (C8-01b, hover underline
  asserted in the desktop spec). §3.3 card → `DriveCard` (unit tests per state, C8-01b, C8-02).
- §4 actions → `usePanelAction` (Ruling 16); 4.1 → protect (C8-03, C8-06); 4.2 → eject (C8-04, C8-06, C8-14); 4.3 →
  next (C8-05, next-disk.spec); 4.4 → gear (3) + `/devices?settings=` (4, C8-07); 4.5 → title link (drive-chips.spec
  mount test).
- §5 states → `DriveCard` unit tests (loaded, empty, loading, ejecting, offline, HFE, no-game title) and diskLine's
  unknown-row case (1); several boards → C8-10, C8-13.
- §6 focus → `usePanel` / `finalFocusFor` / `rescueIfOpen` / `PanelCards` / DriveCard's Next effect (3); C8-08 (open,
  Escape, blank press, search field, Tab out), C8-04 (after Eject), C8-05 (after Next), C8-03 (after Write-protect),
  C8-07 (after the gear), C8-16 (board vanishes), C8-09 (live updates keep focus). The Tab-out fallback is a stated
  rule in Task 3 Step 4.
- §7 live → state in each `Popover.Root` keyed by `chip.id` (Chip) or the stable compact element; no server copy;
  `seen` and `diskCount` derive from fingerprinted fields (1); C8-09.
- §8 phone → Task 5 (one-board face, Drives n, align end, `.drive-panel` below lg, 44 px targets, no sideways scroll;
  C8-12, C8-13, drive-chips 390 test); the lg–xl width risk → C8-17.
- §9.4 spec updates → drive-chips.spec (2, 3, 5), next-disk.spec (3); header-overlap and C7-01 re-run (2, 5, 6);
  c6-admin-layout re-run (3, 6). §9.5 → C8-01 (split a/b), 02–14 as named, C8-15 in contrast.spec (6), plus C8-16 and
  C8-17 for Review Focus 3 and 4. Unit list → Task 1 (`diskLine`, `chipSlots`, `diskCount`, `seen`), Task 2/3/5 render
  tests.
- §10 help → Task 6 Step 4 grep. §11 out of scope → none built (no Switch drive, Pair, Mount, Reading, DF1 controls,
  optimistic switch, header modal); the native-`disabled` backlog goes to HANDOFF (Task 6 note).
- **Plan rulings to relay**: `diskNo` kept on one-disk titles (1); the Next button's accessible name "Next: disk n of N"
  for WCAG 2.5.3, against the spec's "Next disk: disk n of N" (1); `MAX_CHIPS` 2 (1); "+k" keeps its compact padding
  (2); the sr-only WP word beside the tag (2); `lg:max-w-[240px]` (2); the measured-slots rule (2); Base UI's
  `finalFocus` gets no reason, so the `onOpenChange` reason ref (3); `drive-goto` on the words without a link (3); the
  two rescue paths (3); specs stop re-clicking an open panel (3); `useSearchParams` instead of the page prop, against
  spec §4.4 (4); the arrival open in an uncancelled frame (4); the lg–xl cap rule (5); a failed Manage devices ratio
  would move it to `--amber-text` (6).
- Type consistency: `DriveChipDisk.diskCount`, `DriveChip.seen`, `DiskLine`, `diskLine`, `nextLabel`,
  `chipSlots(w, showAdmin, boards)`, `MAX_CHIPS` (1) are used in Tasks 2, 3, 5 with those names; `CHIP_CLASS`,
  `MORE_CLASS`, `ChipFace({ chip, ids })`, `CHIP_VISIBILITY`, `moreVisibility(n)` (2) keep their names in Task 3's whole
  file; `Panel`, `usePanel`, `PanelPopup`, `PanelCards`, `PanelHead`, `usePanelAction`, `offAttrs`, `DriveCard`,
  `CompactControl`, `WpSwitch({ on, small })` (3) are used in Task 5 as defined; `openSettings` (DeviceCard) and
  `openOnArrival` (BoardSettings) (4). The e2e helpers `LIVE`, `sha`, `setDevice`, `onlineBoard`, `mountAndConverge`,
  `loadedBoard`, `chip`, `panel` (2) and `openPanel`, `countRequests`, `slow`, `blankHeaderPoint` (3) are defined
  before their first use; the mobile file defines its own `onlineBoard`, `loadedBoard`, `noSideways`, `bar`,
  `openCompact`.
- Review Focus → 1: Task 4 (`C8-07`'s second press). 2: Task 3 (`C8-08`). 3: Task 3 (`C8-16`). 4: Task 5 (`C8-17`).
  5: Task 3 (`C8-06`'s Write-protect half).
- Placeholder scan: every code step carries its code. Three steps decide by measurement with a stated rule rather
  than code: Task 2 Step 5 (record the logged widths; a red gap means recompute the table by the comment's formula),
  Task 3 Step 4 (the `focusout` fallback if Base UI keeps the panel open on Tab out), and Task 5's lg–xl cap (20 px
  steps until C8-17 passes). None is open-ended.
