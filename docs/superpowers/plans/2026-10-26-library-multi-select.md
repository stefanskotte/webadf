# Library multi-select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Select titles** toggle in the library header turns on a selection mode: every title on the page gets a
checkbox (grid card corner, a leading table track), a sticky ink bar shows "n titles selected" with **Move to
collection…**, **Delete…** and **Cancel**, and nothing is written until the operation's own dialog is confirmed. One new
route, `POST /api/games/bulk`, moves or deletes up to 1,000 titles, org-scoped on every id, all or nothing; a bulk
delete keeps (never ejects) a title a board holds, and previews what it will do (`dryRun`).

**Architecture:** Server: a pure planner `planBulkDelete` (`src/lib/bulk-delete-plan.ts`) decides which titles a board
holds; `deleteGames` (`src/lib/disk-delete.ts`) reads, plans, previews or deletes in one transaction and releases
entitlements once over the union of shas; `moveGamesToCollection` (`src/lib/collections.ts`) inserts and removes
memberships in one transaction; `src/app/api/games/bulk/route.ts` validates with a zod union on `op`. Client: a pure
reducer and the dialog words (`src/lib/library-selection.ts`); a `LibrarySelectionProvider` that page.tsx mounts around
the header and the collections provider (the view key clears it in render); the header `SelectToggle`; a
`SelectionScope` column that owns Escape; `SelectBox` / `PageSelectBox`; the grid card and table row become a
`<label>` while selecting with drag disabled and the ⋯ controls replaced by a spacer; `LibrarySelectionBar` hosts the
bar and the two `Modal` dialogs. No schema change, no migration, no new package.

**Tech Stack:** Next.js 16.3.2 App Router, React 19.2.8, Tailwind v4, Base UI 1.7.0 Dialog (through
`src/components/ui/modal.tsx`), dnd-kit core 6 / sortable 10, lucide-react 1.33 (`ListChecks`, `CheckIcon`,
`MinusIcon`), sonner, zod 4, drizzle on node-postgres, vitest 4 (node; render tests with `renderToStaticMarkup`),
Playwright 1.62. **Read for this plan** (do it again before Tasks 1 and 2):
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (a Route Handler is
`export async function POST(request: Request)`; `ctx.params` is a Promise and is not needed for a static segment;
`/api/games/bulk` is a static segment beside `[id]`, and the static one wins);
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md` (`router.refresh()` re-renders the
server components and keeps client `useState`); `node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`
(the `useLayoutEffect` cleanup reset). That guide **assumes Cache Components**, and this app does not enable it
(`next.config.ts` has no `cacheComponents`): measured in `node_modules/next/dist/client/components/layout-router.js`,
the `<Activity>` wrapper is only added under `process.env.__NEXT_CACHE_COMPONENTS`, and
`bfcache-state-manager.js` keeps `MAX_BF_CACHE_ENTRIES = process.env.__NEXT_CACHE_COMPONENTS ? 3 : 1`. So leaving
`/library` **unmounts** the page and Back mounts it fresh; only a search-param change (`?page=`, `?view=`,
`?collection=`, sort) keeps client state, because the router keys the tree without search params (spec §0, true).

**Spec:** `docs/superpowers/specs/2026-10-26-library-multi-select-design.md`. It is binding: read all of it, including
§8's test lists and the 20 Rulings. Where this plan resolves a gap or a conflict it says so in a line starting **Plan
ruling**; the controller relays those to the operator.

## Global Constraints

- **Keep every existing library, table and collection test id**, with its element and meaning while *not*
  selecting: `game-card`, `game-row`, `game-grid`, `game-table`, `folder-row`, `up-row`, `folder-glyph`,
  `folder-titles`, `folder-disks`, `grid-kind`, `grid-disks`, `game-kind`, `game-hd-tag`, `drive-ring`,
  `row-drag-overlay`, `set-drop-target`, `table-empty-note`, `title-menu-<id>`, `title-menu-panel`,
  `volume-name-<id>`, `volume-name-locked-<id>`, `collection-rail`, `collection-row` (+ `data-collection-id`),
  `collection-count`, `collection-uncategorized`, `collection-all`, `category-overview`, `pager-*`, `active-org`.
  New ids (spec §9): `library-select-toggle`, `library-selection-bar`, `library-select-page`,
  `library-selection-count`, `library-selection-offpage`, `library-bulk-move`, `library-bulk-delete`,
  `library-selection-cancel`, `select-title`, `bulk-move-dialog`, `bulk-move-close`, `bulk-move-cancel`,
  `bulk-move-confirm`, `bulk-delete-dialog`, `bulk-delete-close`, `bulk-delete-cancel`, `bulk-delete-confirm`,
  `bulk-delete-list`, `bulk-delete-kept`, plus this plan's `table-select-page` and `bulk-delete-retry` (Plan rulings in
  Tasks 3 and 5). `data-game-id` is added to every card and row in both modes; it is an attribute, not a test id.
- **Never migrate a database.** No schema change, no `drizzle/` file, no `drizzle-kit`, no `pnpm db:migrate`. If a
  task believes one is needed, STOP and report.
- **Busy controls use `aria-disabled` plus a guard in the handler, never native `disabled`** (Chromium blurs a
  focused control the moment it becomes disabled and focus falls to `<body>`). The shared `Modal`'s own close button
  keeps its existing `disabled={!dismissible}`; this plan does not edit `modal.tsx`.
- **Every request is wrapped in `try { … } catch { … } finally { … }`**, so a dropped connection never leaves a
  control busy.
- **Focus never falls to `<body>`.** Toggle on → the bar's `library-select-page`. Bar Cancel / Escape / toggle press →
  `library-select-toggle`. Dialog Cancel / close / Escape → the bar button that opened it. A successful OK → the toggle,
  or the page `h1` when the toggle is gone (spec §1.6, §5).
- **Live regions are present from first paint.** The bar (with its `role="status"` count) is rendered in the DOM from
  the page's first paint whenever the page has titles, `hidden` while not selecting (Plan ruling, Task 4). The delete
  preview's "Checking the drives…" `role="status"` is in the dialog body from the dialog's first paint.
- **Call `hydrated(page, testId, handler)` from `e2e/device-helpers.ts` before the first click, tap or key on a client
  control with a test id** (`library-select-toggle` with `onClick`; `select-title` with `onChange`).
- **Self-host parity**: no new external URL, font, service, env var or cron. The route uses `requireOrg`, drizzle and
  `getDb().transaction` exactly as the existing routes do on both drivers. **Never delete a blob.**
- **No `react-hooks/set-state-in-effect`:** the view-key clear happens in render (a key compare), the preview fetch
  sets state only after an `await`.
- Colours only through tokens, in classes (`bg-(--ink)`, `border-(--muted-2)`), never an inline `style` for a colour
  that changes between states.
- No `sr-only` element carries a layout or width utility (the C4 `w-full` lesson).
- **Unit tests: `pnpm test --testTimeout=30000 <files>`**, with no `--` before the flag; all of them:
  `pnpm test --testTimeout=30000`. Types: `npx tsc --noEmit`. The whole unit suite is green before each commit.
- **DB tests** (`*.db.test.ts`) run against the local docker Postgres from `scripts/dev-db.sh`, each file in a database
  of its own that it creates and drops (as `src/lib/library-paging.db.test.ts` does). First `docker info >/dev/null &&
  echo up` (if Docker is not running, STOP and report; never point a db test at `.env.local`), then:
  `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db --testTimeout=30000 <files>`.
- **Lint today: `✖ 12 problems (0 errors, 12 warnings)`** (measured on `12f9f36`, this branch's head when the plan
  was written). After every task it must read exactly that and exit 0: `pnpm lint; echo "exit $?"`.
- **e2e: `PORT=3100`, one run at a time, in the foreground (never `run_in_background`), each run under 9 minutes, and
  every run timed** (prefix with `time`; record the wall time in the task report). The suite hits the **LIVE
  production DB**: every new spec file has `test.afterAll(async () => { await cleanupSeeded(); })`, every test signs up
  fresh (`signUpFresh`), and assertions are only about rows the test made (`runTag()`), never absolute counts.
- **The `mobile` Playwright project only runs files ending in `mobile.spec.ts`** (390 × 844, `hasTouch`, `isMobile`).
  It emulates touch, so `hover:` never applies there: hover assertions go in desktop specs only. Every other spec runs
  in `desktop` (1280 × 720).
- **Known slow specs each run ALONE with `--project`:** `collections` (desktop, about 5 min), `library-paging`,
  `devices-page`, `upload-staging`.
- Worktree setup before the first e2e (memory `worktree-e2e-setup`): `node_modules` is a real install (`pnpm install
  --offline` if it is a symlink), `.env.local` present (never print it, never `cat` it, never echo a value from it),
  `npx next typegen`, and the `adf-archive` symlink. All four are present in this worktree today.
- House rules, every task: re-check `git status --short` before staging (other sessions change this tree), then
  **`git add <paths>`, never `-A` or `.`**, and never anything under `wifi-floppy/` or `.superpowers/`. No `git stash`
  in any form. Stop only your own PIDs; never pattern-kill. **Every commit message ends with exactly this one line:**
  `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`
- Screenshots never show an email address or a real board name (the e2e fake names are fine); no screenshot is
  committed.

## Review Focus

1. **Shared bytes between a deleted title and a title a board holds.** Two titles can have the same sha (a duplicate
   upload). `ejectHolders` matches a board by `desiredSha256` as well as by disk id, so the late-holder safety net
   would eject the board that holds the *kept* (or the unselected) title — exactly what Ruling 12 forbids. A person
   expects the board to keep running. **Plan ruling:** the net matches by disk id, and by sha only for shas no other
   disk of the org uses. Pinned in Task 1's db test "a board holding an unselected title that shares bytes with a
   deleted one is not ejected".
2. **Escape pressed inside the Move or Delete dialog.** The dialogs are rendered from the bar, inside the
   `SelectionScope` column, and React bubbles a portalled `keydown` through the component tree, so the scope's Escape
   handler would also end the whole selection. A person expects Escape to close only the dialog. Pinned in Task 4's
   `MS-07` and Task 5's `MS-10`.
3. **A double press on a dialog's confirm.** A second click before the first response must not send a second POST.
   Pinned in Task 4's `MS-07` (one `op: "move"` request after a `dblclick`).
4. **Deleting every title of the view.** The refresh after the OK removes the toggle (no titles, no toggle) while it
   holds focus, and focus would fall to `<body>`; it must land on the `h1`. Pinned in Task 5's `MS-12`.
5. **The connection drops on a confirm.** The dialog must stay open, the confirm must come back from "Deleting…"
   (busy cleared in `finally`), the selection must be kept, and a second press must work. Pinned in Task 5's `MS-13`.

## Common commands

- Unit: `pnpm test --testTimeout=30000 <path> [<path> …]`; types `npx tsc --noEmit`; lint
  `pnpm lint; echo "exit $?"` → `✖ 12 problems (0 errors, 12 warnings)` and `exit 0`.
- DB: `docker info >/dev/null && echo up`, then
  `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db --testTimeout=30000 <path> [<path> …]`.
- e2e, desktop: `time PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<pattern>"]`.
- e2e, mobile: `time PORT=3100 npx playwright test e2e/<name>.mobile.spec.ts --project=mobile [-g "<pattern>"]`.
- Before each `-g` run, check what the pattern selects with `npx playwright test <file> --project=<p> --list
  [-g "<pattern>"]`. `-g` is a case-sensitive RegExp: a pattern holds no unescaped `(`, `)`, `?` or `+`.
- The new specs are **`e2e/library-multi-select.spec.ts`** (desktop, tests `MS-01` … `MS-14`) and
  **`e2e/library-multi-select.mobile.spec.ts`** (mobile, `MS-M1`, `MS-M2`). Per-test cost from earlier runs: a
  sign-up about 5 s, one `seedDisk` about 0.3 s, 26 seeded titles about 10 s, a pairing 1 s.

## File map

| File | Task | What changes |
|---|---|---|
| `src/lib/bulk-delete-plan.ts` + `.test.ts` (new) | 1 | `planBulkDelete`, `PlanGame`, `PlanDevice`, `PlanSession`, `HoldWhere`, `KeptTitle`, `BulkDeletePlan` |
| `src/lib/disk-delete.ts` | 1 | `deleteGames` (+ `BulkDeletePreview`, `BulkDeleteResult`); `ejectHolders` / `releaseEntitlements` reused unchanged |
| `src/lib/collections.ts` | 1 | `moveGamesToCollection`, `MoveResult` |
| `src/lib/library-bulk.db.test.ts`, `src/lib/library-bulk-late.db.test.ts` (new) | 1 | move and delete against a real Postgres |
| `src/app/api/games/bulk/route.ts` + `route.test.ts` (new) | 1 | `POST`, zod union, 400 / 404 |
| `src/lib/library-selection.ts` + `.test.ts` (new) | 2, 4, 5 | reducer, view key, cap, page state, counts (2); move words (4); delete words (5) |
| `src/components/library/selection-provider.tsx` (new) | 2 | `LibrarySelectionProvider`, `useLibrarySelection`, `SelectionScope` |
| `src/components/library/select-toggle.tsx` + `.test.ts` (new) | 2 | the header toggle and its focus rescue |
| `src/app/(app)/library/page.tsx` | 2, 4 | provider, toggle, scope (2); the bar (4) |
| `src/components/library/select-box.tsx` (new) | 3 | `SelectBox`, `PageSelectBox` |
| `src/components/library/title-controls.tsx` | 3 | `TitleName plain`, `TitleControls selecting` (the spacer) |
| `src/components/library/game-grid.tsx`, `game-table.tsx` | 3 | the `<label>` cards and rows, drag off, the 28 px track, `table-select-page` |
| `src/components/library/library-selection-bar.tsx` (new) | 4, 5 | the bar and the dialogs' host (4); Delete wired (5) |
| `src/components/library/bulk-move-dialog.tsx` (new) | 4 | the Move dialog |
| `src/components/library/bulk-delete-dialog.tsx` (new) | 5 | the Delete dialog with its preview |
| `src/lib/help/topics.tsx` + `topics.test.ts` | 5 | one short paragraph on selecting |
| `e2e/library-multi-select.spec.ts` (new) | 2–5 | MS-01 (2); MS-02–04 (3); MS-05–08 (4); MS-09–14 (5) |
| `e2e/library-multi-select.mobile.spec.ts` (new) | 6 | MS-M1, MS-M2 |
| `e2e/contrast.spec.ts` | 7 | one appended test (MS-C1) |

---

### Task 1: The server: `planBulkDelete`, `deleteGames`, `moveGamesToCollection` and `POST /api/games/bulk`

**Files:**
- Create: `src/lib/bulk-delete-plan.ts`, `src/lib/bulk-delete-plan.test.ts`
- Modify: `src/lib/disk-delete.ts` (imports at lines 9-17; append after `deleteGame`, end of file)
- Modify: `src/lib/collections.ts` (append at the end of the file)
- Create: `src/lib/library-bulk.db.test.ts`, `src/lib/library-bulk-late.db.test.ts`
- Create: `src/app/api/games/bulk/route.ts`, `src/app/api/games/bulk/route.test.ts`

**Interfaces:**
- Consumes: `holdsByGame(rows: readonly HoldDeviceRow[], pageDisks: readonly DiskRef[], now: number):
  Record<string, Hold[]>`, `holdLabel(h: Hold, diskCount: number): string`, the types `HoldDeviceRow` and `DiskRef`
  (`@/lib/drive-holds`); `atomic` (`@/db/atomic`); `orgFilter` (`@/db/scope`); the module-private `ejectHolders(orgId,
  diskIds, shas): Promise<string[]>` and `releaseEntitlements(orgId, shas): Promise<string[]>` already in
  `disk-delete.ts`; `requireOrg()` (`@/lib/session`); `nowMs()` (`@/lib/clock`).
- Produces (later tasks import only the **types**, with `import type`):
  - `@/lib/bulk-delete-plan`: `interface PlanGame { id: string; title: string; year: number | null }`,
    `interface PlanDevice extends HoldDeviceRow { df1DiskId: string | null; df1Sha256: string | null }`,
    `interface PlanSession { deviceId: string; deviceName: string; diskId: string }`,
    `interface HoldWhere { deviceName: string; drive: 'DF0' | 'DF1'; label: string }`,
    `interface KeptTitle { id: string; title: string; holds: HoldWhere[] }`,
    `interface BulkDeletePlan { deletable: PlanGame[]; deletableDiskIds: string[]; deletableShas: string[]; kept: KeptTitle[] }`,
    `planBulkDelete(games, disks, devices, sessions, now): BulkDeletePlan`.
  - `@/lib/disk-delete`: `interface BulkDeletePreview { deletable: { titles: number; disks: number }; titles: PlanGame[]; kept: KeptTitle[]; missing: string[] }`,
    `interface BulkDeleteResult { deleted: string[]; diskIds: string[]; kept: KeptTitle[]; missing: string[]; ejected: string[]; releasedSha256: string[] }`,
    `deleteGames(orgId: string, ids: string[], opts: { dryRun: true; now: number }): Promise<BulkDeletePreview>` and
    `deleteGames(orgId: string, ids: string[], opts: { dryRun?: false; now: number }): Promise<BulkDeleteResult>`.
  - `@/lib/collections`: `interface MoveResult { added: number; alreadyThere: number; removedFrom: number; missing: string[] }`,
    `moveGamesToCollection(orgId: string, ids: string[], to: string, from?: string): Promise<MoveResult | null>`.
  - `POST /api/games/bulk` with body `{ op: 'move', gameIds, to, from? }` → `200 MoveResult` / `400` / `404`, and
    `{ op: 'delete', gameIds, dryRun? }` → `200 BulkDeletePreview | BulkDeleteResult` / `400`.

**Plan ruling** (Review Focus 1, against spec §3.3 step 4 "the same `ejectHolders(orgId, deletableDiskIds,
deletableShas)`"): the safety net is passed the deletable disk ids and only the deletable shas that **no other disk of
the org** uses (one `selectDistinct` read). `ejectHolders` matches `desiredSha256` too, and with a sha shared by a kept
or an unselected title it would eject the board holding that one. Single delete is unchanged (spec §11).

**Plan ruling** (spec §3.2 "in one transaction (`atomic`)"): `moveGamesToCollection` uses `getDb().transaction(async
(tx) => …)` directly, which is what `atomic()` wraps: the insert's sort keys come from a `max(sort_key)` read inside the
same transaction, and `atomic()` takes a list of statements built before any of them runs.

**Plan ruling** (spec §8 DB list "titles, disks, history, write sessions and memberships gone"): a write session can
never be gone after a bulk delete, because an open session keeps its title (Ruling 12). The test asserts history and
memberships gone, and the session's title kept.

**Plan ruling** (spec §8 "A late holder is ejected and named"): no seam is added to `deleteGames`. The late-holder test
lives in its own file, `library-bulk-late.db.test.ts`, which `vi.mock`s `@/lib/bulk-delete-plan` so the plan sees no
boards: that is exactly a board that mounted after the read.

- [ ] **Step 1: Write the failing planner tests**

Create `src/lib/bulk-delete-plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planBulkDelete, type PlanDevice } from './bulk-delete-plan';

// spec §3.3 step 2, Ruling 12: which selected titles a board holds (and so are kept), by the card's own DF0 rule
// (holdsByGame), DF1's pick or content, and an open write session.
const NOW = Date.UTC(2026, 9, 26, 12);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const game = (id: string, year: number | null = 1990) => ({ id, title: `T ${id}`, year });
const disk = (gameId: string, n: number, sha256: string) => ({ id: `${gameId}-d${n}`, gameId, diskNo: n, sha256 });
const board = (o: Partial<PlanDevice> = {}): PlanDevice => ({
  id: 'b1', name: 'A500', desiredSha256: null, mountedSha256: null, lastSeenAt: new Date(NOW),
  desiredDiskId: null, mountedDiskId: null, df1DiskId: null, df1Sha256: null, ...o,
});
// g2 is a two-disk title.
const GAMES = [game('g1'), game('g2'), game('g3')];
const DISKS = [disk('g1', 1, A), disk('g2', 1, B), disk('g2', 2, C), disk('g3', 1, D)];

describe('planBulkDelete', () => {
  it('nothing held: every title is deletable, in request order, with its disks and its distinct shas', () => {
    const p = planBulkDelete(GAMES, [...DISKS, disk('g3', 2, D)], [], [], NOW);
    expect(p.deletable.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
    expect(p.deletableDiskIds).toEqual(['g1-d1', 'g2-d1', 'g2-d2', 'g3-d1', 'g3-d2']);
    expect(p.deletableShas).toEqual([A, B, C, D]);
    expect(p.kept).toEqual([]);
  });

  it('DF0 mounted (a converged board) keeps the title and says where, in holdLabel words', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({
      desiredSha256: A, mountedSha256: A, desiredDiskId: 'g1-d1', mountedDiskId: 'g1-d1',
    })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g1', title: 'T g1', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'In A500' }] }]);
    expect(p.deletable.map((g) => g.id)).toEqual(['g2', 'g3']);
    expect(p.deletableDiskIds).not.toContain('g1-d1');
    expect(p.deletableShas).not.toContain(A);
  });

  it('DF0 fetching (asked for, board online) keeps the title', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ desiredSha256: D, desiredDiskId: 'g3-d1' })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'Fetching to A500' }] }]);
  });

  it('DF0 requested (asked for, board offline) keeps the title', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({
      desiredSha256: D, desiredDiskId: 'g3-d1', lastSeenAt: new Date(NOW - 3_600_000),
    })], [], NOW);
    expect(p.kept[0].holds).toEqual([{ deviceName: 'A500', drive: 'DF0', label: 'Requested on A500 — not confirmed' }]);
  });

  it('an eject in flight holds nothing: the title is deletable', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ mountedSha256: A, mountedDiskId: 'g1-d1' })], [], NOW);
    expect(p.kept).toEqual([]);
    expect(p.deletable.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it("DF1's pick keeps the title, and says DF1", () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ df1DiskId: 'g3-d1' })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF1', label: 'In A500' }] }]);
  });

  it("DF1's reported content keeps the title, matched by sha", () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ df1Sha256: A })], [], NOW);
    expect(p.kept.map((k) => k.id)).toEqual(['g1']);
    expect(p.kept[0].holds[0].drive).toBe('DF1');
  });

  it('an open write session keeps the title: "Writing on <board>"', () => {
    const p = planBulkDelete(GAMES, DISKS, [], [{ deviceId: 'b1', deviceName: 'A500', diskId: 'g3-d1' }], NOW);
    expect(p.kept).toEqual([{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'Writing on A500' }] }]);
  });

  it('a multi-disk title held by one disk is kept whole, and the label names the disk', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({
      desiredSha256: C, mountedSha256: C, desiredDiskId: 'g2-d2', mountedDiskId: 'g2-d2',
    })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g2', title: 'T g2', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'In A500 — disk 2' }] }]);
    expect(p.deletableDiskIds).toEqual(['g1-d1', 'g3-d1']);
    expect(p.deletableShas).toEqual([A, D]);
  });

  it('kept titles keep request order, and one title held twice lists both holds', () => {
    const p = planBulkDelete([game('g3'), game('g1')], DISKS, [
      board({ desiredSha256: A, mountedSha256: A, desiredDiskId: 'g1-d1', mountedDiskId: 'g1-d1' }),
      board({ id: 'b2', name: 'A1200', df1DiskId: 'g1-d1' }),
      board({ id: 'b3', name: 'CD32', df1DiskId: 'g3-d1' }),
    ], [], NOW);
    expect(p.kept.map((k) => k.id)).toEqual(['g3', 'g1']);
    expect(p.kept[1].holds.map((h) => `${h.deviceName} ${h.drive}`)).toEqual(['A500 DF0', 'A1200 DF1']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/bulk-delete-plan.test.ts`
Expected: FAIL — `Failed to resolve import "./bulk-delete-plan"`.

- [ ] **Step 3: Write the planner**

Create `src/lib/bulk-delete-plan.ts`:

```ts
import { holdLabel, holdsByGame, type DiskRef, type HoldDeviceRow } from '@/lib/drive-holds';

/**
 * Which titles of a bulk delete a board holds, and so are KEPT (spec 2026-10-26 library multi-select §3.3, Ruling 12).
 *
 * Pure, so it is tested without a database. A title is held when any of its disks is:
 *  - in DF0 by the card's own rule (holdsByGame: mounted, fetching or requested; an eject in flight holds nothing);
 *  - DF1's pick (df1DiskId) or DF1's reported content (df1Sha256 equal to one of its disks' sha);
 *  - the disk of an open disk_write_sessions row (a board writing back).
 * A held title is kept whole, every disk of it, and the plan says where so the person knows what to eject.
 */
export interface PlanGame { id: string; title: string; year: number | null }
export interface PlanDevice extends HoldDeviceRow { df1DiskId: string | null; df1Sha256: string | null }
export interface PlanSession { deviceId: string; deviceName: string; diskId: string }
export interface HoldWhere { deviceName: string; drive: 'DF0' | 'DF1'; label: string }
export interface KeptTitle { id: string; title: string; holds: HoldWhere[] }
export interface BulkDeletePlan {
  /** In request order. */
  deletable: PlanGame[];
  deletableDiskIds: string[];
  /** Distinct, first seen first. */
  deletableShas: string[];
  /** In request order. */
  kept: KeptTitle[];
}

export function planBulkDelete(
  games: readonly PlanGame[], disks: readonly DiskRef[], devices: readonly PlanDevice[],
  sessions: readonly PlanSession[], now: number,
): BulkDeletePlan {
  const disksOf = new Map<string, DiskRef[]>();
  for (const d of disks) {
    const list = disksOf.get(d.gameId) ?? [];
    list.push(d);
    disksOf.set(d.gameId, list);
  }
  const diskById = new Map(disks.map((d) => [d.id, d] as const));
  const where = new Map<string, HoldWhere[]>();
  const add = (gameId: string, h: HoldWhere) => {
    const list = where.get(gameId) ?? [];
    list.push(h);
    where.set(gameId, list);
  };
  const diskWords = (gameId: string, d: DiskRef) => ((disksOf.get(gameId)?.length ?? 1) > 1 ? ` — disk ${d.diskNo}` : '');

  // Devices first, in their order, so one title held twice lists DF0 before DF1 for the same board.
  for (const dev of devices) {
    const df0 = holdsByGame([dev], disks, now);
    for (const [gameId, holds] of Object.entries(df0)) {
      for (const h of holds) {
        add(gameId, { deviceName: h.deviceName, drive: 'DF0', label: holdLabel(h, disksOf.get(gameId)?.length ?? 1) });
      }
    }
    const pick = dev.df1DiskId !== null ? diskById.get(dev.df1DiskId) : undefined;
    const content = pick ?? (dev.df1Sha256 !== null ? disks.find((d) => d.sha256 === dev.df1Sha256) : undefined);
    if (content) add(content.gameId, { deviceName: dev.name, drive: 'DF1', label: `In ${dev.name}${diskWords(content.gameId, content)}` });
  }
  for (const s of sessions) {
    const d = diskById.get(s.diskId);
    if (d) add(d.gameId, { deviceName: s.deviceName, drive: 'DF0', label: `Writing on ${s.deviceName}` });
  }

  const deletable: PlanGame[] = [];
  const kept: KeptTitle[] = [];
  for (const g of games) {
    const holds = where.get(g.id);
    if (holds) kept.push({ id: g.id, title: g.title, holds });
    else deletable.push(g);
  }
  const ids = new Set(deletable.map((g) => g.id));
  const gone = disks.filter((d) => ids.has(d.gameId));
  return {
    deletable,
    deletableDiskIds: gone.map((d) => d.id),
    deletableShas: [...new Set(gone.map((d) => d.sha256))],
    kept,
  };
}
```

- [ ] **Step 4: Run the planner tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/bulk-delete-plan.test.ts` → PASS (10 tests).

- [ ] **Step 5: Write the failing DB tests**

Create `src/lib/library-bulk.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

// Library multi-select (spec 2026-10-26 §3, §8 DB): the bulk move and the bulk delete against real Postgres, in a
// database of their own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_library_bulk_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq, sql } = await import('drizzle-orm');
const { games, disks, blobs, entitlements } = await import('@/db/schema/catalog');
const { collections, collectionGames } = await import('@/db/schema/collections');
const { devices } = await import('@/db/schema/devices');
const { diskVersions, diskWriteSessions } = await import('@/db/schema/disk-history');
const { moveGamesToCollection } = await import('./collections');
const { deleteGames } = await import('./disk-delete');

const ORG = 'org-bulk';
const OTHER = 'org-bulk-other';
const NOW = Date.UTC(2026, 9, 26, 12);
const sha = (n: number) => String(n).padStart(64, '0');

/** A title with one disk per entry of `shas` (disk ids `<id>-d1`, `<id>-d2`, …), its blobs and its entitlements. */
async function seedTitle(id: string, org: string, shas: number[]) {
  const db = getDb();
  await db.insert(games).values({ id, orgId: org, title: `T ${id}`, sortTitle: `t ${id}`, year: 1990 });
  for (const [i, n] of shas.entries()) {
    await db.insert(blobs).values({ sha256: sha(n), sizeBytes: 100, storageKey: sha(n) }).onConflictDoNothing();
    await db.insert(disks).values({ id: `${id}-d${i + 1}`, gameId: id, orgId: org, diskNo: i + 1, sha256: sha(n), sizeBytes: 100 });
    await db.insert(entitlements).values({ orgId: org, sha256: sha(n), sourceFilename: `${id}.adf` }).onConflictDoNothing();
  }
}
async function coll(id: string, org: string, members: string[] = []) {
  await getDb().insert(collections).values({ id, orgId: org, name: `C ${id}` });
  if (members.length > 0) {
    await getDb().insert(collectionGames).values(members.map((gameId, i) => ({ collectionId: id, gameId, sortKey: i })));
  }
}
async function members(id: string) {
  const rows = await getDb().select({ gameId: collectionGames.gameId, sortKey: collectionGames.sortKey })
    .from(collectionGames).where(eq(collectionGames.collectionId, id))
    .orderBy(collectionGames.sortKey, collectionGames.gameId);
  return rows.map((r) => r.gameId);
}
async function sortKeys(id: string) {
  const rows = await getDb().select({ gameId: collectionGames.gameId, sortKey: collectionGames.sortKey })
    .from(collectionGames).where(eq(collectionGames.collectionId, id));
  return Object.fromEntries(rows.map((r) => [r.gameId, r.sortKey]));
}
async function board(id: string, o: Partial<typeof devices.$inferInsert> = {}) {
  await getDb().insert(devices).values({ id, orgId: ORG, name: `Board ${id}`, tokenHash: `h-${id}`, lastSeenAt: new Date(NOW), ...o });
}
const gameIds = async (org: string) =>
  (await getDb().select({ id: games.id }).from(games).where(eq(games.orgId, org)).orderBy(games.id)).map((r) => r.id);
const entitled = async (org: string) =>
  (await getDb().select({ s: entitlements.sha256 }).from(entitlements).where(eq(entitlements.orgId, org))).map((r) => r.s).sort();
const blobCount = async () => (await getDb().select({ n: sql<number>`count(*)::int` }).from(blobs))[0].n;

describe('library bulk operations (db)', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });
  beforeEach(async () => {
    await getDb().execute(sql.raw('truncate table collection_games, collections, disk_write_sessions, disk_versions, '
      + 'devices, entitlements, disks, games, blobs cascade'));
  });

  describe('moveGamesToCollection', () => {
    it('from All titles or Uncategorized: adds to the target and takes the titles out of none', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]);
      await coll('cA', ORG, ['g1']); await coll('cB', ORG);
      expect(await moveGamesToCollection(ORG, ['g1', 'g2'], 'cB')).toEqual({ added: 2, alreadyThere: 0, removedFrom: 0, missing: [] });
      expect(await members('cB')).toEqual(['g1', 'g2']);
      expect(await members('cA')).toEqual(['g1']);
    });

    it('inside a collection: added to the target and removed from the one you are in', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]); await seedTitle('g3', ORG, [3]);
      await coll('cA', ORG, ['g1', 'g2', 'g3']); await coll('cB', ORG);
      expect(await moveGamesToCollection(ORG, ['g1', 'g3'], 'cB', 'cA')).toEqual({ added: 2, alreadyThere: 0, removedFrom: 2, missing: [] });
      expect(await members('cA')).toEqual(['g2']);
      expect(await members('cB')).toEqual(['g1', 'g3']);
    });

    it('a title already in the target is counted, and the new ones append in request order', async () => {
      for (const id of ['g1', 'g2', 'g3', 'g9']) await seedTitle(id, ORG, [Number(id.slice(1))]);
      await coll('cB', ORG, ['g9', 'g1']);   // g9 sortKey 0, g1 sortKey 1
      expect(await moveGamesToCollection(ORG, ['g3', 'g1', 'g2'], 'cB')).toEqual({ added: 2, alreadyThere: 1, removedFrom: 0, missing: [] });
      // max(sort_key) was 1: g3 is 1 + 1 + 0, g2 is 1 + 1 + 2 (spec §3.2 step 1).
      expect(await sortKeys('cB')).toEqual({ g9: 0, g1: 1, g3: 2, g2: 4 });
    });

    it("another org's game id is reported missing and never inserted", async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('x1', OTHER, [50]);
      await coll('cB', ORG);
      expect(await moveGamesToCollection(ORG, ['x1', 'g1'], 'cB')).toEqual({ added: 1, alreadyThere: 0, removedFrom: 0, missing: ['x1'] });
      expect(await members('cB')).toEqual(['g1']);
    });

    it("another org's target or source is null, with nothing written", async () => {
      await seedTitle('g1', ORG, [1]);
      await coll('cA', ORG, ['g1']); await coll('cX', OTHER);
      expect(await moveGamesToCollection(ORG, ['g1'], 'cX')).toBeNull();
      expect(await moveGamesToCollection(ORG, ['g1'], 'cA', 'cX')).toBeNull();
      expect(await moveGamesToCollection(ORG, ['g1'], 'nope')).toBeNull();
      expect(await members('cX')).toEqual([]);
      expect(await members('cA')).toEqual(['g1']);
    });

    it('running it twice ends in the same state (Ruling 15)', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]);
      await coll('cA', ORG, ['g1', 'g2']); await coll('cB', ORG);
      await moveGamesToCollection(ORG, ['g1', 'g2'], 'cB', 'cA');
      const again = await moveGamesToCollection(ORG, ['g1', 'g2'], 'cB', 'cA');
      expect(again).toEqual({ added: 0, alreadyThere: 2, removedFrom: 0, missing: [] });
      expect(await members('cA')).toEqual([]);
      expect(await members('cB')).toEqual(['g1', 'g2']);
    });

    it('a failure inside the transaction writes nothing: the add is rolled back with the remove', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g-boom', ORG, [2]);
      await coll('cA', ORG, ['g1', 'g-boom']); await coll('cB', ORG);
      // A trigger in THIS throwaway database only: a delete of g-boom's membership raises.
      await getDb().execute(sql.raw("create or replace function bulk_test_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$"));
      await getDb().execute(sql.raw("create trigger bulk_test_boom before delete on collection_games for each row when (old.game_id = 'g-boom') execute function bulk_test_boom()"));
      try {
        await expect(moveGamesToCollection(ORG, ['g1', 'g-boom'], 'cB', 'cA')).rejects.toThrow();
        expect(await members('cB')).toEqual([]);
        expect(await members('cA')).toEqual(['g1', 'g-boom']);
      } finally {
        await getDb().execute(sql.raw('drop trigger if exists bulk_test_boom on collection_games'));
      }
    });
  });

  describe('deleteGames', () => {
    it('deletes the titles, their disks, history and memberships, and releases their entitlements', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2, 3]); await seedTitle('g8', ORG, [8]);
      await coll('cA', ORG, ['g1', 'g8']);
      await getDb().insert(diskVersions).values({ id: 'v1', diskId: 'g1-d1', orgId: ORG, seq: 1, kind: 'snapshot',
        blobSha256: sha(1), imageSha256: sha(1), source: 'original', sectorCount: 1760 });
      const r = await deleteGames(ORG, ['g1', 'g2'], { now: NOW });
      expect(r).toMatchObject({ deleted: ['g1', 'g2'], kept: [], missing: [], ejected: [] });
      expect(r.diskIds.sort()).toEqual(['g1-d1', 'g2-d1', 'g2-d2']);
      expect(r.releasedSha256.sort()).toEqual([sha(1), sha(2), sha(3)]);
      expect(await gameIds(ORG)).toEqual(['g8']);
      expect(await members('cA')).toEqual(['g8']);
      expect(await getDb().select().from(diskVersions)).toEqual([]);
      expect(await entitled(ORG)).toEqual([sha(8)]);
    });

    it("another org's id is untouched and reported missing, like an id that does not exist", async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('x1', OTHER, [50]);
      const r = await deleteGames(ORG, ['x1', 'g1', 'nope'], { now: NOW });
      expect(r.deleted).toEqual(['g1']);
      expect(r.missing).toEqual(['x1', 'nope']);
      expect(await gameIds(OTHER)).toEqual(['x1']);
      expect(await entitled(OTHER)).toEqual([sha(50)]);
    });

    it('a sha shared by two deleted titles is released once', async () => {
      await seedTitle('g1', ORG, [5]); await seedTitle('g2', ORG, [5]);
      const r = await deleteGames(ORG, ['g1', 'g2'], { now: NOW });
      expect(r.releasedSha256).toEqual([sha(5)]);
      expect(await entitled(ORG)).toEqual([]);
    });

    it('a sha shared with a surviving disk keeps its entitlement', async () => {
      await seedTitle('g1', ORG, [5]); await seedTitle('g9', ORG, [5]);
      const r = await deleteGames(ORG, ['g1'], { now: NOW });
      expect(r.releasedSha256).toEqual([]);
      expect(await entitled(ORG)).toEqual([sha(5)]);
    });

    it("a sha named only by a surviving disk's history keeps its entitlement", async () => {
      await seedTitle('g1', ORG, [5]); await seedTitle('g9', ORG, [9]);
      await getDb().insert(diskVersions).values({ id: 'v9', diskId: 'g9-d1', orgId: ORG, seq: 1, kind: 'snapshot',
        blobSha256: sha(5), imageSha256: sha(5), source: 'original', sectorCount: 1760 });
      await deleteGames(ORG, ['g1'], { now: NOW });
      expect(await entitled(ORG)).toEqual([sha(5), sha(9)]);
    });

    it('titles a board holds are kept, with where: DF0 mounted, DF1 pick, an open write session', async () => {
      for (const [id, n] of [['g1', 1], ['g2', 2], ['g3', 3], ['g4', 4]] as const) await seedTitle(id, ORG, [n]);
      await board('b1', { name: 'A500', desiredSha256: sha(1), desiredDiskId: 'g1-d1', mountedSha256: sha(1), mountedDiskId: 'g1-d1' });
      await board('b2', { name: 'A1200', df1DiskId: 'g2-d1' });
      await board('b3', { name: 'CD32' });
      await getDb().insert(diskWriteSessions).values({ deviceId: 'b3', mount: 1, diskId: 'g3-d1', token: 't', baseSha256: sha(3) });
      const r = await deleteGames(ORG, ['g1', 'g2', 'g3', 'g4'], { now: NOW });
      expect(r.deleted).toEqual(['g4']);
      expect(r.kept).toEqual([
        { id: 'g1', title: 'T g1', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'In A500' }] },
        { id: 'g2', title: 'T g2', holds: [{ deviceName: 'A1200', drive: 'DF1', label: 'In A1200' }] },
        { id: 'g3', title: 'T g3', holds: [{ deviceName: 'CD32', drive: 'DF0', label: 'Writing on CD32' }] },
      ]);
      expect(r.ejected).toEqual([]);
      expect(await gameIds(ORG)).toEqual(['g1', 'g2', 'g3']);
      const [b1] = await getDb().select().from(devices).where(eq(devices.id, 'b1'));
      expect(b1.desiredDiskId).toBe('g1-d1');   // never ejected (Ruling 12)
      expect((await getDb().select().from(diskWriteSessions)).length).toBe(1);
    });

    it('dryRun writes nothing and returns the counts, the deletable titles in request order, kept and missing', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2, 3]); await seedTitle('g3', ORG, [4]);
      await board('b1', { name: 'A500', df1DiskId: 'g3-d1' });
      const p = await deleteGames(ORG, ['g2', 'g1', 'g3', 'nope'], { dryRun: true, now: NOW });
      expect(p).toEqual({
        deletable: { titles: 2, disks: 3 },
        titles: [{ id: 'g2', title: 'T g2', year: 1990 }, { id: 'g1', title: 'T g1', year: 1990 }],
        kept: [{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF1', label: 'In A500' }] }],
        missing: ['nope'],
      });
      expect(await gameIds(ORG)).toEqual(['g1', 'g2', 'g3']);
      expect(await entitled(ORG)).toEqual([sha(1), sha(2), sha(3), sha(4)]);
    });

    it('a board holding an unselected title that shares bytes with a deleted one is not ejected (Review Focus 1)', async () => {
      await seedTitle('g1', ORG, [7]); await seedTitle('g2', ORG, [7]);
      await board('b1', { name: 'A500', desiredSha256: sha(7), desiredDiskId: 'g1-d1', mountedSha256: sha(7),
        mountedDiskId: 'g1-d1', desiredVersion: 3 });
      const r = await deleteGames(ORG, ['g2'], { now: NOW });
      expect(r.deleted).toEqual(['g2']);
      expect(r.ejected).toEqual([]);
      const [b1] = await getDb().select().from(devices).where(eq(devices.id, 'b1'));
      expect(b1).toMatchObject({ desiredDiskId: 'g1-d1', desiredSha256: sha(7), desiredVersion: 3 });
      expect(await entitled(ORG)).toEqual([sha(7)]);
    });

    it('never deletes a blob', async () => {
      await seedTitle('g1', ORG, [1]); await seedTitle('g2', ORG, [2]);
      const before = await blobCount();
      await deleteGames(ORG, ['g1', 'g2'], { now: NOW });
      expect(await blobCount()).toBe(before);
    });

    it('a second run of the same delete reports the titles missing and writes nothing (Ruling 15)', async () => {
      await seedTitle('g1', ORG, [1]);
      await deleteGames(ORG, ['g1'], { now: NOW });
      expect(await deleteGames(ORG, ['g1'], { now: NOW })).toEqual({
        deleted: [], diskIds: [], kept: [], missing: ['g1'], ejected: [], releasedSha256: [],
      });
    });
  });
});
```

Create `src/lib/library-bulk-late.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';

// The late-holder safety net (spec §3.3 step 4): a board that mounts one of the titles AFTER deleteGames read the
// devices is ejected and named, as single delete does. Simulated by a plan that saw no boards -- exactly what a read
// taken before that mount looks like. A file of its own because vi.mock applies to the whole file.
vi.mock('@/lib/bulk-delete-plan', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/bulk-delete-plan')>();
  return {
    ...real,
    planBulkDelete: (...a: Parameters<typeof real.planBulkDelete>) => real.planBulkDelete(a[0], a[1], [], a[3], a[4]),
  };
});

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_library_bulk_late_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { games, disks, blobs, entitlements } = await import('@/db/schema/catalog');
const { devices } = await import('@/db/schema/devices');
const { deleteGames } = await import('./disk-delete');

const ORG = 'org-bulk-late';
const NOW = Date.UTC(2026, 9, 26, 12);
const S = '7'.repeat(64);

describe('deleteGames: a board that mounted after the read', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    const db = getDb();
    await db.insert(games).values({ id: 'g1', orgId: ORG, title: 'Late', sortTitle: 'late' });
    await db.insert(blobs).values({ sha256: S, sizeBytes: 100, storageKey: S });
    await db.insert(disks).values({ id: 'g1-d1', gameId: 'g1', orgId: ORG, diskNo: 1, sha256: S, sizeBytes: 100 });
    await db.insert(entitlements).values({ orgId: ORG, sha256: S, sourceFilename: 'late.adf' });
    await db.insert(devices).values([
      { id: 'b1', orgId: ORG, name: 'A500', tokenHash: 'h-b1', lastSeenAt: new Date(NOW), desiredSha256: S,
        desiredDiskId: 'g1-d1', desiredVersion: 4 },
      { id: 'b2', orgId: ORG, name: 'A1200', tokenHash: 'h-b2', lastSeenAt: new Date(NOW), df1DiskId: 'g1-d1', df1Version: 2 },
    ]);
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('ejects DF0 and DF1, bumps both cursors, names both boards, and deletes the title', async () => {
    const r = await deleteGames(ORG, ['g1'], { now: NOW });
    expect(r.deleted).toEqual(['g1']);
    expect([...r.ejected].sort()).toEqual(['A1200', 'A500']);
    const [b1] = await getDb().select().from(devices).where(eq(devices.id, 'b1'));
    const [b2] = await getDb().select().from(devices).where(eq(devices.id, 'b2'));
    expect(b1).toMatchObject({ desiredDiskId: null, desiredSha256: null, desiredVersion: 5 });
    expect(b2).toMatchObject({ df1DiskId: null, df1Version: 3 });
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `docker info >/dev/null && echo up`, then
`TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db --testTimeout=30000 src/lib/library-bulk.db.test.ts src/lib/library-bulk-late.db.test.ts`
Expected: FAIL — `moveGamesToCollection is not a function` and `deleteGames is not a function`.

- [ ] **Step 7: Write `moveGamesToCollection`**

Append to `src/lib/collections.ts` (its imports already hold `and`, `eq`, `inArray`, `sql`, `getDb`, `games`,
`collections`, `collectionGames`, `orgFilter`):

```ts
/** What a bulk move did (spec 2026-10-26 library multi-select §3.2). */
export interface MoveResult { added: number; alreadyThere: number; removedFrom: number; missing: string[] }

/**
 * Library multi-select's Move to collection (spec §3.2, Rulings 11, 15, 18): every owned title in `ids` goes into
 * `to`, and inside a collection (`from`) leaves that one. The single move's own meaning, made plural: from All titles
 * or Uncategorized it only adds, and a title is never taken out of its other collections.
 *
 * Null when `to` or `from` is not this org's collection (the route's 404), with nothing written. An id this org does
 * not own -- absent or another tenant's, indistinguishable on purpose -- is reported in `missing` and never written.
 *
 * All or nothing in ONE transaction. getDb().transaction directly (what atomic() wraps): the new sort keys come from a
 * max(sort_key) read inside the same transaction, after the target's existing members (Plan ruling). A title already
 * in `to` is a quiet no-op (the composite PK, ON CONFLICT DO NOTHING), so running it twice gives the same end state.
 */
export async function moveGamesToCollection(
  orgId: string, ids: string[], to: string, from?: string,
): Promise<MoveResult | null> {
  const db = getDb();
  const wanted = from === undefined ? [to] : [to, from];
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, inArray(collections.id, wanted)));
  const have = new Set(owned.map((c) => c.id));
  if (!have.has(to) || (from !== undefined && !have.has(from))) return null;

  const mine = new Set((await db.select({ id: games.id }).from(games)
    .where(orgFilter(games, orgId, inArray(games.id, ids)))).map((g) => g.id));
  const ownedIds = ids.filter((id) => mine.has(id));
  const missing = ids.filter((id) => !mine.has(id));
  if (ownedIds.length === 0) return { added: 0, alreadyThere: 0, removedFrom: 0, missing };

  return db.transaction(async (tx) => {
    const [{ maxSort }] = await tx
      .select({ maxSort: sql<number>`coalesce(max(${collectionGames.sortKey}), -1)::int` })
      .from(collectionGames)
      .where(eq(collectionGames.collectionId, to));
    const added = await tx.insert(collectionGames)
      .values(ownedIds.map((gameId, i) => ({ collectionId: to, gameId, sortKey: maxSort + 1 + i })))
      .onConflictDoNothing()
      .returning({ gameId: collectionGames.gameId });
    let removedFrom = 0;
    if (from !== undefined) {
      const gone = await tx.delete(collectionGames)
        .where(and(eq(collectionGames.collectionId, from), inArray(collectionGames.gameId, ownedIds)))
        .returning({ gameId: collectionGames.gameId });
      removedFrom = gone.length;
    }
    return { added: added.length, alreadyThere: ownedIds.length - added.length, removedFrom, missing };
  });
}
```

- [ ] **Step 8: Write `deleteGames`**

In `src/lib/disk-delete.ts`:

Replace line 9 (`import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';`) with:

```ts
import { and, eq, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import { atomic } from '@/db/atomic';
```

Replace line 13 (`import { diskVersions } from '@/db/schema/disk-history';`) with:

```ts
import { diskVersions, diskWriteSessions } from '@/db/schema/disk-history';
import { planBulkDelete, type KeptTitle, type PlanGame } from '@/lib/bulk-delete-plan';
```

Append at the end of the file:

```ts
/** A bulk delete's preview (`dryRun`, spec §3.3 step 3): what OK would do now, changing nothing. */
export interface BulkDeletePreview {
  deletable: { titles: number; disks: number };
  /** The deletable titles, in request order. */
  titles: PlanGame[];
  kept: KeptTitle[];
  missing: string[];
}

/** What a bulk delete did (spec §3.3 step 6). */
export interface BulkDeleteResult {
  deleted: string[];
  diskIds: string[];
  kept: KeptTitle[];
  missing: string[];
  ejected: string[];
  releasedSha256: string[];
}

/**
 * Library multi-select's Delete (spec 2026-10-26 §3.3, Rulings 12, 13, 15, 18, 19).
 *
 * Every id is org-checked in ONE read; an id not returned is `missing`, absent or another tenant's alike, and never
 * written to. A title a board holds (planBulkDelete) is KEPT and reported, never ejected -- unlike deleteGame. The
 * rest goes all or nothing in one transaction, with deleteGame's own drift guard on disks.org_id (D-5-5) set-wise.
 * Entitlements are released once over the union of the deleted shas, by the existing releaseEntitlements. A blob is
 * never deleted.
 *
 * The late-holder safety net is ejectHolders, which normally does nothing (the held titles were taken out). It is
 * passed the deletable disk ids, and by sha only the shas no other disk of this org uses: ejectHolders also matches
 * desiredSha256, and a sha shared with a kept or an unselected title would eject the board holding THAT one
 * (Plan ruling, Review Focus 1).
 */
export async function deleteGames(orgId: string, ids: string[], opts: { dryRun: true; now: number }): Promise<BulkDeletePreview>;
export async function deleteGames(orgId: string, ids: string[], opts: { dryRun?: false; now: number }): Promise<BulkDeleteResult>;
export async function deleteGames(
  orgId: string, ids: string[], opts: { dryRun?: boolean; now: number },
): Promise<BulkDeletePreview | BulkDeleteResult> {
  const db = getDb();
  const ownedRows = await db.select({ id: games.id, title: games.title, year: games.year }).from(games)
    .where(and(eq(games.orgId, orgId), inArray(games.id, ids)));
  const byId = new Map(ownedRows.map((g) => [g.id, g] as const));
  const owned = ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const missing = ids.filter((id) => !byId.has(id));
  const ownedIds = owned.map((g) => g.id);

  const diskRows = ownedIds.length === 0 ? [] : await db
    .select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo, sha256: disks.sha256 }).from(disks)
    .where(and(eq(disks.orgId, orgId), inArray(disks.gameId, ownedIds)));
  const boards = await db.select({
    id: devices.id, name: devices.name, desiredSha256: devices.desiredSha256, mountedSha256: devices.mountedSha256,
    lastSeenAt: devices.lastSeenAt, desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId,
    df1DiskId: devices.df1DiskId, df1Sha256: devices.df1Sha256,
  }).from(devices).where(eq(devices.orgId, orgId));
  const sessions = diskRows.length === 0 ? [] : await db
    .select({ deviceId: diskWriteSessions.deviceId, deviceName: devices.name, diskId: diskWriteSessions.diskId })
    .from(diskWriteSessions)
    .innerJoin(devices, and(eq(devices.id, diskWriteSessions.deviceId), eq(devices.orgId, orgId)))
    .where(inArray(diskWriteSessions.diskId, diskRows.map((d) => d.id)));

  const plan = planBulkDelete(owned, diskRows, boards, sessions, opts.now);

  if (opts.dryRun) {
    return {
      deletable: { titles: plan.deletable.length, disks: plan.deletableDiskIds.length },
      titles: plan.deletable,
      kept: plan.kept,
      missing,
    };
  }
  if (plan.deletable.length === 0) {
    return { deleted: [], diskIds: [], kept: plan.kept, missing, ejected: [], releasedSha256: [] };
  }

  const deletableIds = plan.deletable.map((g) => g.id);
  const sharedRows = plan.deletableShas.length === 0 ? [] : await db.selectDistinct({ sha256: disks.sha256 }).from(disks)
    .where(and(eq(disks.orgId, orgId), inArray(disks.sha256, plan.deletableShas), notInArray(disks.gameId, deletableIds)));
  const shared = new Set(sharedRows.map((r) => r.sha256));
  const ejected = await ejectHolders(orgId, plan.deletableDiskIds, plan.deletableShas.filter((s) => !shared.has(s)));

  const [goneDisks, goneGames] = await atomic((tx) => [
    tx.delete(disks).where(and(eq(disks.orgId, orgId), inArray(disks.gameId, deletableIds)))
      .returning({ id: disks.id, sha256: disks.sha256 }),
    tx.delete(games).where(and(eq(games.orgId, orgId), inArray(games.id, deletableIds),
      sql`not exists (select 1 from ${disks} "d" where "d"."game_id" = ${games.id})`)).returning({ id: games.id }),
  ]) as [{ id: string; sha256: string }[], { id: string }[]];

  const releasedSha256 = await releaseEntitlements(orgId, [...new Set(goneDisks.map((d) => d.sha256))]);
  const gone = new Set(goneGames.map((g) => g.id));
  return {
    deleted: deletableIds.filter((id) => gone.has(id)),
    diskIds: goneDisks.map((d) => d.id),
    kept: plan.kept,
    missing,
    ejected,
    releasedSha256,
  };
}
```

- [ ] **Step 9: Run the DB tests to see them pass**

Run: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db --testTimeout=30000 src/lib/library-bulk.db.test.ts src/lib/library-bulk-late.db.test.ts`
Expected: PASS (17 + 1 tests). Then the existing delete unit tests, unchanged:
`pnpm test --testTimeout=30000 src/lib/disk-delete.test.ts src/lib/disk-delete-disk.test.ts` → PASS.

- [ ] **Step 10: Write the failing route tests**

Create `src/app/api/games/bulk/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/games/bulk (spec 2026-10-26 library multi-select §3.1, §3.4): validation, the session's org, and the
// mapping to the two library functions (their org scoping is tested against Postgres in library-bulk.db.test.ts).
vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
vi.mock('@/lib/clock', () => ({ nowMs: () => 1_000 }));
const moveGamesToCollection = vi.fn();
const deleteGames = vi.fn();
vi.mock('@/lib/collections', () => ({ moveGamesToCollection: (...a: unknown[]) => moveGamesToCollection(...a) }));
vi.mock('@/lib/disk-delete', () => ({ deleteGames: (...a: unknown[]) => deleteGames(...a) }));

const { POST } = await import('./route');
const req = (body: unknown) => new Request('http://x/api/games/bulk', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const MOVED = { added: 2, alreadyThere: 0, removedFrom: 0, missing: [] };

beforeEach(() => { moveGamesToCollection.mockReset(); deleteGames.mockReset(); });

describe('POST /api/games/bulk', () => {
  it('move: the session org, the ids deduplicated in first order, to and from; 200 with the result', async () => {
    moveGamesToCollection.mockResolvedValue(MOVED);
    const res = await POST(req({ op: 'move', gameIds: ['a', 'b', 'a'], to: 'c1', from: 'c0', orgId: 'evil' }));
    expect(moveGamesToCollection).toHaveBeenCalledWith('org-1', ['a', 'b'], 'c1', 'c0');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MOVED);
  });

  it('move without from passes undefined', async () => {
    moveGamesToCollection.mockResolvedValue(MOVED);
    await POST(req({ op: 'move', gameIds: ['a'], to: 'c1' }));
    expect(moveGamesToCollection).toHaveBeenCalledWith('org-1', ['a'], 'c1', undefined);
  });

  it("a collection this org does not own is 404 not_found", async () => {
    moveGamesToCollection.mockResolvedValue(null);
    const res = await POST(req({ op: 'move', gameIds: ['a'], to: 'theirs' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('to === from is 400 same_collection, and nothing is called', async () => {
    const res = await POST(req({ op: 'move', gameIds: ['a'], to: 'c1', from: 'c1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'same_collection' });
    expect(moveGamesToCollection).not.toHaveBeenCalled();
  });

  it('delete with dryRun previews, with the request clock', async () => {
    deleteGames.mockResolvedValue({ deletable: { titles: 1, disks: 1 }, titles: [], kept: [], missing: [] });
    const res = await POST(req({ op: 'delete', gameIds: ['a', 'a', 'b'], dryRun: true }));
    expect(deleteGames).toHaveBeenCalledWith('org-1', ['a', 'b'], { dryRun: true, now: 1_000 });
    expect(res.status).toBe(200);
  });

  it('delete without dryRun deletes', async () => {
    deleteGames.mockResolvedValue({ deleted: ['a'], diskIds: [], kept: [], missing: [], ejected: [], releasedSha256: [] });
    const res = await POST(req({ op: 'delete', gameIds: ['a'] }));
    expect(deleteGames).toHaveBeenCalledWith('org-1', ['a'], { now: 1_000 });
    expect(await res.json()).toMatchObject({ deleted: ['a'] });
  });

  it('a body that is not JSON is 400 invalid_json', async () => {
    const res = await POST(req('{'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it.each([
    ['an empty list', { op: 'delete', gameIds: [] }],
    ['1,001 ids', { op: 'delete', gameIds: Array.from({ length: 1001 }, (_, i) => `g${i}`) }],
    ['an unknown op', { op: 'archive', gameIds: ['a'] }],
    ['a move with no target', { op: 'move', gameIds: ['a'] }],
    ['an empty id', { op: 'delete', gameIds: [''] }],
  ])('%s is 400 invalid_body, and nothing is called', async (_n, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
    expect(moveGamesToCollection).not.toHaveBeenCalled();
    expect(deleteGames).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/app/api/games/bulk/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 12: Write the route**

Create `src/app/api/games/bulk/route.ts`:

```ts
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { nowMs } from '@/lib/clock';
import { moveGamesToCollection } from '@/lib/collections';
import { deleteGames } from '@/lib/disk-delete';

export const maxDuration = 60;

const gameIds = z.array(z.string().min(1).max(64)).min(1).max(1000);
const body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move'), gameIds, to: z.string().min(1), from: z.string().min(1).optional() }),
  z.object({ op: z.literal('delete'), gameIds, dryRun: z.boolean().optional() }),
]);

/**
 * Library multi-select (spec 2026-10-26 §3): move or delete up to 1,000 titles in one request. A static segment
 * beside games/[id], so it wins over the dynamic one; it defines POST only.
 *
 * The org comes from the session, never the body (zod strips unknown keys). Every id is org-checked by the library
 * function in one read; an unknown or foreign id is reported `missing`, never written. A foreign `to`/`from` is 404
 * for the whole move with nothing written (404, never 403). Duplicate ids are dropped here, keeping first order.
 * Both operations are idempotent (Ruling 15), which is what lets the client say "Trying again is safe".
 */
export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }
  const req = parsed.data;
  const ids = [...new Set(req.gameIds)];

  if (req.op === 'move') {
    if (req.from !== undefined && req.from === req.to) {
      return Response.json({ error: 'same_collection' }, { status: 400 });
    }
    const result = await moveGamesToCollection(orgId, ids, req.to, req.from);
    if (!result) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(result);
  }

  const now = nowMs();
  return Response.json(req.dryRun
    ? await deleteGames(orgId, ids, { dryRun: true, now })
    : await deleteGames(orgId, ids, { now }));
}
```

- [ ] **Step 13: Run everything to see it pass**

Run: `pnpm test --testTimeout=30000 src/app/api/games/bulk/route.test.ts` → PASS (12 tests).
Run: `pnpm test --testTimeout=30000` (whole; `client-bundle-boundary.test.ts` included), `npx tsc --noEmit`,
`pnpm lint; echo "exit $?"` → green; lint `✖ 12 problems (0 errors, 12 warnings)`, `exit 0`.
Run the DB pair once more (Step 9's command) → PASS.

- [ ] **Step 14: Commit**

```bash
git status --short
git add src/lib/bulk-delete-plan.ts src/lib/bulk-delete-plan.test.ts src/lib/disk-delete.ts src/lib/collections.ts \
  src/lib/library-bulk.db.test.ts src/lib/library-bulk-late.db.test.ts \
  src/app/api/games/bulk/route.ts src/app/api/games/bulk/route.test.ts
git commit -m "Multi-select: POST /api/games/bulk -- org-scoped bulk move and bulk delete, held titles kept, a dryRun preview

Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 2: The selection state, the provider, the header toggle and the Escape scope

**Files:**
- Create: `src/lib/library-selection.ts`, `src/lib/library-selection.test.ts`
- Create: `src/components/library/selection-provider.tsx`
- Create: `src/components/library/select-toggle.tsx`, `src/components/library/select-toggle.test.ts`
- Modify: `src/app/(app)/library/page.tsx` (imports at lines 1-24; the `return` from line 151 to the end)
- Create: `e2e/library-multi-select.spec.ts` (MS-01)

**Interfaces:**
- Consumes: `LibraryView` (type, `@/lib/library-view`); `pageHeading(): HTMLElement | null`
  (`@/components/admin/page-heading`); `ListChecks` (`lucide-react`).
- Produces:
  - `@/lib/library-selection`: `SELECTION_CAP = 1000`, `CAP_TITLE = 'Up to 1,000 titles at a time'`,
    `interface SelectedTitle { title: string; year: number | null; diskCount: number }`,
    `interface PageTitle extends SelectedTitle { id: string }`,
    `interface SelectionState { viewKey: string; selecting: boolean; selected: ReadonlyMap<string, SelectedTitle> }`,
    `type SelectionAction = { type: 'start' } | { type: 'cancel' } | { type: 'toggle'; title: PageTitle } | { type: 'togglePage'; page: readonly PageTitle[] } | { type: 'view'; viewKey: string }`,
    `viewKeyOf(view: LibraryView): string`, `initSelection(viewKey: string): SelectionState`,
    `selectionReducer(s: SelectionState, a: SelectionAction): SelectionState`,
    `pageCheck(selected, pageIds: readonly string[]): 'none' | 'some' | 'all'`,
    `canSelectPage(selected, pageIds: readonly string[]): boolean`, `offPageCount(selected, pageIds): number`,
    `titlesWord(n: number): string`, `disksWord(n: number): string`, `countText(n: number): string`,
    `offPageText(k: number): string`.
  - `@/components/library/selection-provider`: `LibrarySelectionProvider({ viewKey, pageTitles, canSelect, children })`,
    `useLibrarySelection(): LibrarySelection` with
    `interface LibrarySelection { selecting: boolean; selected: ReadonlyMap<string, SelectedTitle>; pageTitles: readonly PageTitle[]; dispatch(a: SelectionAction): void; toggleRef: RefObject<HTMLButtonElement | null>; start(): void; cancel(): void; end(): void; focusTarget(): HTMLElement | null }`
    (outside a provider it returns an inert value with `selecting: false`, so `GameGrid` / `GameTable` keep working
    anywhere), and `SelectionScope({ className, children })`.
  - `@/components/library/select-toggle`: `SelectToggle()`.

**Plan ruling** (spec §1.5 "a new client provider … It keeps `selecting` and `selected`" and §8 "selection-provider
reducer"): the reducer and its helpers live in the pure `src/lib/library-selection.ts`, so they are unit-tested in
node without a DOM; the provider holds them in a `useState` and applies the reducer.

**Plan ruling** (spec §1.5 "when the page is hidden by Activity", §0): measured, this app does not run Activity
(`cacheComponents` is off), so leaving `/library` unmounts the provider and Back mounts it fresh. The spec's
`useLayoutEffect` cleanup is still written (it is the documented guard, and costs nothing if Cache Components is ever
turned on); MS-04 in Task 3 proves Back clears the selection either way.

**Plan ruling** (spec §1.1 "It appears only when the grid or table shows at least one title"): `canSelect` is
`!showOverview && games.length > 0`, computed in page.tsx and passed to the provider, which reports `selecting` as
`state.selecting && canSelect`; a view that empties while selecting therefore shows no bar and no boxes.

- [ ] **Step 1: Write the failing unit tests**

Create `src/lib/library-selection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SELECTION_CAP, canSelectPage, countText, initSelection, offPageCount, offPageText, pageCheck, selectionReducer,
  titlesWord, disksWord, viewKeyOf, type PageTitle, type SelectionState,
} from './library-selection';

const t = (id: string): PageTitle => ({ id, title: `T ${id}`, year: 1990, diskCount: 1 });
const on = (s: SelectionState) => selectionReducer(s, { type: 'start' });
const ids = (s: SelectionState) => [...s.selected.keys()];

describe('library selection (spec §1.5, §8 unit)', () => {
  it('the view key names one view: a collection, All titles or Uncategorized', () => {
    expect(viewKeyOf({ kind: 'uncategorized' })).toBe('uncategorized');
    expect(viewKeyOf({ kind: 'all' })).toBe('all');
    expect(viewKeyOf({ kind: 'collection', id: 'c1' })).toBe('collection:c1');
  });

  it('starts off; start turns selecting on with nothing selected; toggling before start does nothing', () => {
    const s = initSelection('all');
    expect(s).toEqual({ viewKey: 'all', selecting: false, selected: new Map() });
    expect(selectionReducer(s, { type: 'toggle', title: t('a') })).toBe(s);
    expect(on(s).selecting).toBe(true);
  });

  it('toggle adds then removes, keeping insertion order and the title facts', () => {
    let s = on(initSelection('all'));
    s = selectionReducer(s, { type: 'toggle', title: t('b') });
    s = selectionReducer(s, { type: 'toggle', title: t('a') });
    expect(ids(s)).toEqual(['b', 'a']);
    expect(s.selected.get('a')).toEqual({ title: 'T a', year: 1990, diskCount: 1 });
    s = selectionReducer(s, { type: 'toggle', title: t('b') });
    expect(ids(s)).toEqual(['a']);
  });

  it('cancel clears and ends selecting; a new view key clears it, the same key keeps it', () => {
    let s = selectionReducer(on(initSelection('all')), { type: 'toggle', title: t('a') });
    expect(selectionReducer(s, { type: 'view', viewKey: 'all' })).toBe(s);
    expect(selectionReducer(s, { type: 'view', viewKey: 'collection:c1' })).toEqual(initSelection('collection:c1'));
    s = selectionReducer(s, { type: 'cancel' });
    expect(s).toEqual(initSelection('all'));
  });

  it('the page select-all: none, some (indeterminate), all; it toggles exactly the page', () => {
    const page = [t('a'), t('b'), t('c')];
    let s = selectionReducer(on(initSelection('all')), { type: 'toggle', title: t('x') });   // off this page
    expect(pageCheck(s.selected, ['a', 'b', 'c'])).toBe('none');
    s = selectionReducer(s, { type: 'toggle', title: t('a') });
    expect(pageCheck(s.selected, ['a', 'b', 'c'])).toBe('some');
    s = selectionReducer(s, { type: 'togglePage', page });
    expect(pageCheck(s.selected, ['a', 'b', 'c'])).toBe('all');
    expect(ids(s)).toEqual(['x', 'a', 'b', 'c']);
    s = selectionReducer(s, { type: 'togglePage', page });
    expect(ids(s)).toEqual(['x']);
    expect(pageCheck(new Map(), [])).toBe('none');
  });

  it('caps a selection at 1,000: one more title, or a page that would pass it, is refused', () => {
    let s = on(initSelection('all'));
    s = selectionReducer(s, { type: 'togglePage', page: Array.from({ length: SELECTION_CAP - 1 }, (_, i) => t(`g${i}`)) });
    expect(s.selected.size).toBe(999);
    expect(canSelectPage(s.selected, ['p1', 'p2'])).toBe(false);
    expect(selectionReducer(s, { type: 'togglePage', page: [t('p1'), t('p2')] })).toBe(s);
    s = selectionReducer(s, { type: 'toggle', title: t('last') });
    expect(s.selected.size).toBe(1000);
    expect(selectionReducer(s, { type: 'toggle', title: t('over') })).toBe(s);
    expect(selectionReducer(s, { type: 'toggle', title: t('last') }).selected.size).toBe(999);   // unticking still works
  });

  it('counts the selected titles that are not on this page', () => {
    const s = new Map([['a', t('a')], ['x', t('x')], ['y', t('y')]]);
    expect(offPageCount(s, ['a', 'b'])).toBe(2);
    expect(offPageCount(s, ['a', 'x', 'y'])).toBe(0);
  });

  it('the words', () => {
    expect(countText(0)).toBe('No titles selected');
    expect(countText(1)).toBe('1 title selected');
    expect(countText(1200)).toBe('1,200 titles selected');
    expect(offPageText(4)).toBe(' · 4 on other pages');
    expect(titlesWord(1)).toBe('1 title');
    expect(disksWord(19)).toBe('19 disks');
  });
});
```

Create `src/components/library/select-toggle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LibrarySelectionProvider, useLibrarySelection } from './selection-provider';
import { SelectToggle } from './select-toggle';

const html = (canSelect = true) => renderToStaticMarkup(createElement(LibrarySelectionProvider,
  { viewKey: 'all', pageTitles: [{ id: 'g1', title: 'Lemmings', year: 1991, diskCount: 1 }], canSelect },
  createElement(SelectToggle)));

describe('SelectToggle (spec §1.1)', () => {
  it('is one .seg icon button the size of the Grid/Table toggle, named, titled and unpressed', () => {
    const button = html().match(/<button [^>]*>/)?.[0] ?? '';
    expect(html()).toMatch(/^<div class="seg">/);
    expect(button).toContain('data-testid="library-select-toggle"');
    expect(button).toContain('aria-label="Select titles"');
    expect(button).toContain('title="Select titles"');
    expect(button).toContain('aria-pressed="false"');
    expect(button).toContain('class="seg-item seg-item--icon h-10 w-11 sm:h-8 sm:w-9"');
    expect(button).not.toContain('disabled');
    expect(html()).toMatch(/<svg [^>]*aria-hidden="true"/);
  });

  it('outside a provider the selection reads as off, so the grid and table work anywhere', () => {
    function Probe() { return createElement('span', null, String(useLibrarySelection().selecting)); }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>false</span>');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/library-selection.test.ts src/components/library/select-toggle.test.ts`
Expected: FAIL — `Failed to resolve import "./library-selection"` and `"./selection-provider"`.

- [ ] **Step 3: Write the pure state**

Create `src/lib/library-selection.ts`:

```ts
// Library multi-select (spec 2026-10-26): the selection's state and words. Pure -- no React, no database -- so it is
// unit-tested in node and imported by the client components. Server result types come in with `import type` only.
import type { LibraryView } from '@/lib/library-view';

/** One request's cap, the same as the disk files' bulk route (Ruling 6). */
export const SELECTION_CAP = 1000;
export const CAP_TITLE = 'Up to 1,000 titles at a time';

/** What the dialogs need to name a title that is not on the current page. */
export interface SelectedTitle { title: string; year: number | null; diskCount: number }
export interface PageTitle extends SelectedTitle { id: string }

export interface SelectionState {
  /** The view the selection belongs to (Ruling 4): another view clears it. */
  viewKey: string;
  selecting: boolean;
  /** In insertion order. */
  selected: ReadonlyMap<string, SelectedTitle>;
}

export type SelectionAction =
  | { type: 'start' }
  | { type: 'cancel' }
  | { type: 'toggle'; title: PageTitle }
  | { type: 'togglePage'; page: readonly PageTitle[] }
  | { type: 'view'; viewKey: string };

export function viewKeyOf(view: LibraryView): string {
  return view.kind === 'collection' ? `collection:${view.id}` : view.kind;
}

export function initSelection(viewKey: string): SelectionState {
  return { viewKey, selecting: false, selected: new Map() };
}

const facts = ({ title, year, diskCount }: PageTitle): SelectedTitle => ({ title, year, diskCount });

export function pageCheck(selected: ReadonlyMap<string, unknown>, pageIds: readonly string[]): 'none' | 'some' | 'all' {
  const n = pageIds.filter((id) => selected.has(id)).length;
  if (pageIds.length > 0 && n === pageIds.length) return 'all';
  return n === 0 ? 'none' : 'some';
}

/** Whether ticking every title of this page keeps the selection within the cap. */
export function canSelectPage(selected: ReadonlyMap<string, unknown>, pageIds: readonly string[]): boolean {
  return selected.size + pageIds.filter((id) => !selected.has(id)).length <= SELECTION_CAP;
}

export function offPageCount(selected: ReadonlyMap<string, unknown>, pageIds: readonly string[]): number {
  const here = new Set(pageIds);
  let n = 0;
  for (const id of selected.keys()) if (!here.has(id)) n++;
  return n;
}

export function selectionReducer(s: SelectionState, a: SelectionAction): SelectionState {
  switch (a.type) {
    case 'start':
      return s.selecting ? s : { ...s, selecting: true, selected: new Map() };
    case 'cancel':
      return initSelection(s.viewKey);
    case 'view':
      return a.viewKey === s.viewKey ? s : initSelection(a.viewKey);
    case 'toggle': {
      if (!s.selecting) return s;
      const next = new Map(s.selected);
      if (next.has(a.title.id)) next.delete(a.title.id);
      else if (next.size >= SELECTION_CAP) return s;
      else next.set(a.title.id, facts(a.title));
      return { ...s, selected: next };
    }
    case 'togglePage': {
      if (!s.selecting) return s;
      const pageIds = a.page.map((p) => p.id);
      const next = new Map(s.selected);
      if (pageCheck(s.selected, pageIds) === 'all') {
        for (const id of pageIds) next.delete(id);
        return { ...s, selected: next };
      }
      if (!canSelectPage(s.selected, pageIds)) return s;
      for (const p of a.page) if (!next.has(p.id)) next.set(p.id, facts(p));
      return { ...s, selected: next };
    }
  }
}

const n0 = (n: number) => n.toLocaleString('en-US');
export const titlesWord = (n: number) => `${n0(n)} ${n === 1 ? 'title' : 'titles'}`;
export const disksWord = (n: number) => `${n0(n)} ${n === 1 ? 'disk' : 'disks'}`;
export const countText = (n: number) => (n === 0 ? 'No titles selected' : `${titlesWord(n)} selected`);
/** The disk files' "(n not shown)" in this bar's words, so a Delete never surprises (spec §1.3). */
export const offPageText = (k: number) => ` · ${n0(k)} on other pages`;
```

- [ ] **Step 4: Write the provider and the scope**

Create `src/components/library/selection-provider.tsx`:

```tsx
'use client';

import {
  createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject,
} from 'react';
import { pageHeading } from '@/components/admin/page-heading';
import {
  initSelection, selectionReducer, type PageTitle, type SelectedTitle, type SelectionAction,
} from '@/lib/library-selection';

export interface LibrarySelection {
  selecting: boolean;
  selected: ReadonlyMap<string, SelectedTitle>;
  /** The titles on this page, in the page's order: what "All on this page" ticks. */
  pageTitles: readonly PageTitle[];
  dispatch: (a: SelectionAction) => void;
  /** The header toggle, where Cancel and a finished operation put focus. */
  toggleRef: RefObject<HTMLButtonElement | null>;
  start: () => void;
  /** Ends selecting and clears it, nothing sent (spec §1.6), and puts focus on the toggle, else the h1. */
  cancel: () => void;
  /** Ends selecting and clears it, leaving focus to the caller (a dialog's finalFocus). */
  end: () => void;
  /** The toggle when it is on the page, else the h1: never <body>. */
  focusTarget: () => HTMLElement | null;
}

const OFF: LibrarySelection = {
  selecting: false, selected: new Map(), pageTitles: [], dispatch: () => {}, toggleRef: { current: null },
  start: () => {}, cancel: () => {}, end: () => {}, focusTarget: () => null,
};

const Ctx = createContext<LibrarySelection | null>(null);

/** The selection, or a selection that is always off outside the library page's provider. */
export function useLibrarySelection(): LibrarySelection {
  return useContext(Ctx) ?? OFF;
}

/**
 * Library multi-select (spec 2026-10-26 §1.5): one selection per view, shared by the header toggle, the bar, the grid
 * and the table. page.tsx mounts it around both the PageHeader and the CollectionsProvider.
 *
 * It survives paging, grid/table, sort and router.refresh() -- search-param navigations keep client state in this
 * Next.js. A new view key (another collection, All titles, Uncategorized) clears it, decided in render, never by an
 * effect that sets state. Leaving /library unmounts the page here (no Activity: cacheComponents is off), and the
 * layout-effect cleanup drops the selection too if Activity ever hides the page instead (preserving-ui-state.md).
 */
export function LibrarySelectionProvider({ viewKey, pageTitles, canSelect, children }: {
  viewKey: string;
  pageTitles: PageTitle[];
  /** The page shows at least one title (not an empty view, not the collections overview). */
  canSelect: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState(() => initSelection(viewKey));
  if (state.viewKey !== viewKey) setState(initSelection(viewKey));
  const dispatch = useCallback((a: SelectionAction) => setState((s) => selectionReducer(s, a)), []);
  useLayoutEffect(() => () => setState((s) => initSelection(s.viewKey)), []);

  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useCallback((): HTMLElement | null => {
    const t = toggleRef.current;
    return t && t.isConnected ? t : pageHeading();
  }, []);
  const start = useCallback(() => dispatch({ type: 'start' }), [dispatch]);
  const end = useCallback(() => dispatch({ type: 'cancel' }), [dispatch]);
  const cancel = useCallback(() => { dispatch({ type: 'cancel' }); focusTarget()?.focus(); }, [dispatch, focusTarget]);

  const selecting = state.selecting && canSelect;
  const value = useMemo<LibrarySelection>(() => ({
    selecting, selected: state.selected, pageTitles, dispatch, toggleRef, start, cancel, end, focusTarget,
  }), [selecting, state.selected, pageTitles, dispatch, start, cancel, end, focusTarget]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The grid/table column. Escape there ends selecting (spec §1.1) -- from the bar, a checkbox or a row -- but never
 * from inside a dialog or a menu: their keydown bubbles here through React's portal tree, and Escape in the Move or
 * Delete dialog must close only that dialog (Review Focus 2).
 */
export function SelectionScope({ className, children }: { className: string; children: ReactNode }) {
  const { selecting, cancel } = useLibrarySelection();
  return (
    <div
      className={className}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !selecting || e.defaultPrevented) return;
        if (e.target instanceof Element && e.target.closest('[role="dialog"],[role="menu"]')) return;
        e.preventDefault();
        cancel();
      }}
    >
      {children}
    </div>
  );
}
```

If `pnpm lint` (Step 10) reports `react-hooks/set-state-in-effect` on the `useLayoutEffect` cleanup, delete that one
line and its comment clause and report it as a Plan ruling: with Activity off (measured, Tech Stack) leaving `/library`
unmounts the provider, so the cleanup has nothing to clear today, and MS-04 proves Back starts clean.

- [ ] **Step 5: Write the toggle**

Create `src/components/library/select-toggle.tsx`:

```tsx
'use client';

import { useLayoutEffect } from 'react';
import { ListChecks } from 'lucide-react';
import { pageHeading } from '@/components/admin/page-heading';
import { useLibrarySelection } from './selection-provider';

/**
 * "Select titles" (spec §1.1, Ruling 1): the header icon, directly before the Grid/Table toggle and the same size
 * (44 x 40 below sm, 36 x 32 from sm). Pressed on, the bar, the checkboxes and the label cards appear; pressed again
 * it is Cancel. `.seg-item[aria-pressed="true"]` draws the pressed look (globals.css).
 *
 * The page only renders it while it shows titles. When a refresh empties the view while it holds focus (the last
 * titles deleted, Review Focus 4), it unmounts under the focus: the h1 takes it, never <body>.
 */
export function SelectToggle() {
  const { selecting, start, cancel, toggleRef } = useLibrarySelection();
  useLayoutEffect(() => {
    const el = toggleRef.current;
    return () => {
      if (!el || document.activeElement !== el) return;
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) pageHeading()?.focus();
      });
    };
  }, [toggleRef]);
  return (
    <div className="seg">
      <button
        ref={toggleRef}
        type="button"
        data-testid="library-select-toggle"
        aria-label="Select titles"
        title="Select titles"
        aria-pressed={selecting}
        onClick={() => (selecting ? cancel() : start())}
        className="seg-item seg-item--icon h-10 w-11 sm:h-8 sm:w-9"
      >
        <ListChecks size={16} aria-hidden />
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Run the unit tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/library-selection.test.ts src/components/library/select-toggle.test.ts`
→ PASS (8 + 2 tests).

- [ ] **Step 7: Mount it on the library page**

In `src/app/(app)/library/page.tsx`:

After line 24 (`import { resolvePage, librarySubtitle } from '@/lib/library-paging';`) add:

```ts
import { LibrarySelectionProvider, SelectionScope } from '@/components/library/selection-provider';
import { SelectToggle } from '@/components/library/select-toggle';
import { viewKeyOf } from '@/lib/library-selection';
```

Directly before `return (` (line 151) add:

```ts
  // Library multi-select (spec 2026-10-26 §1.1, §1.5): the toggle shows only while the grid or table shows titles;
  // the selection belongs to this view and names each title so a dialog can list titles on other pages.
  const canSelect = !showOverview && games.length > 0;
  const pageTitles = games.map((g) => ({ id: g.id, title: g.title, year: g.year, diskCount: g.diskCount }));
```

In the returned JSX:
- wrap everything after the `active-org` span — the `<PageHeader … />` and the `<CollectionsProvider …>…</CollectionsProvider>` —
  in `<LibrarySelectionProvider viewKey={viewKeyOf(view)} pageTitles={pageTitles} canSelect={canSelect}>` … `</LibrarySelectionProvider>`;
- in the header `actions`, replace `<ViewToggle mode={viewMode} view={view} page={paging.page} />` with
  `{canSelect && <SelectToggle />}` followed by that same `<ViewToggle … />` line;
- replace the content column's opening `<div className="min-w-0 flex-1">` with `<SelectionScope className="min-w-0 flex-1">`
  and its matching `</div>` (the one right after the `LibraryPager` block, before the row's closing `</div>`) with
  `</SelectionScope>`.

- [ ] **Step 8: Write the first e2e test**

Create `e2e/library-multi-select.spec.ts`:

```ts
import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded, hydrated } from './device-helpers';

// Library multi-select (spec docs/superpowers/specs/2026-10-26-library-multi-select-design.md §8 e2e).
// Tests are named MS-NN so batches can select them.
test.describe.configure({ timeout: 120_000 });
test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(`multisel-${s}`).digest('hex');

/** `n` one-disk titles "<prefix> 01 <run>" … in the signed-up org. */
async function seedTitles(orgId: string, prefix: string, n: number) {
  const run = runTag();
  const out: { gameId: string; diskId: string; title: string; sha: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const title = `${prefix} ${String(i).padStart(2, '0')} ${run}`;
    const s = sha(`${run}-${prefix}-${i}`);
    const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: s });
    out.push({ gameId, diskId, title, sha: s });
  }
  return out;
}
/** A collection through the app's own route, optionally holding `gameIds`. */
async function makeCollection(page: Page, name: string, gameIds: string[] = []) {
  const res = await page.request.post('/api/collections', { data: { name } });
  expect(res.status()).toBe(200);
  const { id } = await res.json() as { id: string };
  for (const gameId of gameIds) {
    expect((await page.request.post(`/api/collections/${id}/games`, { data: { gameId } })).status()).toBe(200);
  }
  return { id, name };
}
/** 24 a page, A to Z, so the pages are known. */
async function smallPages(page: Page) {
  const res = await page.request.patch('/api/me/prefs', { data: { library: { pageSize: 24, sort: { key: 'title', dir: 'asc' } } } });
  expect(res.status()).toBe(200);
}
/** The bodies of every POST to the bulk route from here on. */
function bulkRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/games/bulk')) seen.push(r.postData() ?? ''); });
  return seen;
}
const card = (page: Page, id: string) => page.locator(`[data-testid="game-card"][data-game-id="${id}"]`);
const row = (page: Page, id: string) => page.locator(`[data-testid="game-row"][data-game-id="${id}"]`);
const boxOf = (l: Locator) => l.getByTestId('select-title');
const toggle = (page: Page) => page.getByTestId('library-select-toggle');
const bar = (page: Page) => page.getByTestId('library-selection-bar');
const count = (page: Page) => page.getByTestId('library-selection-count');
function railRow(page: Page, collectionId: string): Locator {
  return page.locator(`[data-testid="collection-row"][data-collection-id="${collectionId}"]`);
}
async function startSelecting(page: Page) {
  await hydrated(page, 'library-select-toggle');
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
}

test('MS-01 the Select titles toggle: only with titles, pressed while selecting, Cancel on a second press', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await page.goto('/library');
  await expect(page.getByTestId('game-grid')).toHaveAttribute('data-empty', 'library');
  await expect(toggle(page)).toHaveCount(0);   // an empty library has nothing to select

  const [a] = await seedTitles(orgId, 'Toggle', 1);
  await page.goto('/library');
  await expect(card(page, a.gameId)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toHaveAttribute('aria-label', 'Select titles');
  // Directly before the Grid/Table toggle, and the same size as its buttons at 1280.
  const box = (await toggle(page).boundingBox())!;
  const grid = (await page.getByRole('link', { name: 'Grid view' }).boundingBox())!;
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([Math.round(grid.width), Math.round(grid.height)]);
  expect(box.x).toBeLessThan(grid.x);

  await startSelecting(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toBeFocused();

  // The collections overview (an empty inbox in the grid) has no titles to select, and no toggle.
  await makeCollection(page, `Filed ${runTag()}`, [a.gameId]);
  await page.goto('/library');
  await expect(page.getByTestId('category-overview')).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  // The table's root lists the collection as a folder but no title: no toggle either.
  await page.goto('/library?view=table');
  await expect(page.getByTestId('folder-row')).toHaveCount(1);
  await expect(toggle(page)).toHaveCount(0);
});
```

- [ ] **Step 9: Run it, and the header regression**

Run: `npx tsc --noEmit` → clean. Then
`time PORT=3100 npx playwright test e2e/library-multi-select.spec.ts --project=desktop -g "MS-01"` → 1 passed.
The header gained a button, so run the specs that measure it, one run at a time:
`time PORT=3100 npx playwright test e2e/view-toggle.spec.ts e2e/header-overlap.spec.ts e2e/states.spec.ts --project=desktop`
→ all pass; `time PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile --list` then run it in
two `-g` halves of at most 17 tests each, chosen from the listed titles → all pass.

- [ ] **Step 10: The gates and the commit**

Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint; echo "exit $?"` → green; lint
`✖ 12 problems (0 errors, 12 warnings)`, `exit 0`.

```bash
git status --short
git add src/lib/library-selection.ts src/lib/library-selection.test.ts src/components/library/selection-provider.tsx \
  src/components/library/select-toggle.tsx src/components/library/select-toggle.test.ts "src/app/(app)/library/page.tsx" \
  e2e/library-multi-select.spec.ts
git commit -m "Multi-select: the selection state per view, the Select titles toggle in the library header, Escape scope

Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 3: Selecting in the grid and the table: the boxes, the label cards and rows, drag and controls off

**Files:**
- Create: `src/components/library/select-box.tsx`
- Modify: `src/components/library/title-controls.tsx` (`TitleName` at lines 214-218, `TitleControls` at 235-246)
- Modify: `src/components/library/game-grid.tsx` (`CardBody`, `DraggableCard`, `SortableCard`; a new `SelectableCard`)
- Modify: `src/components/library/game-table.tsx` (constants at lines 31-38, `GameTable`, `UpRow`, `FolderRow`, `TitleRow`)
- Modify: `e2e/library-multi-select.spec.ts` (MS-02 … MS-04)

**Interfaces:**
- Consumes: `useLibrarySelection()` and its `selecting`, `selected`, `pageTitles`, `dispatch` (Task 2);
  `SELECTION_CAP`, `CAP_TITLE`, `pageCheck`, `canSelectPage` (Task 2); `titleLabel(g)` (`title-controls.tsx`);
  `CheckIcon`, `MinusIcon` (`lucide-react`).
- Produces:
  - `@/components/library/select-box`: `SelectBox({ game }: { game: Pick<GameListItem, 'id' | 'title' | 'year' | 'diskCount'> })`
    (`data-testid="select-title"`), and `PageSelectBox({ testId, label, onInk, inputRef }: { testId: string; label?: string; onInk?: boolean; inputRef?: RefObject<HTMLInputElement | null> })`.
  - `TitleName({ game, className, plain })` and `TitleControls({ …, selecting })` (the spacer).
  - While selecting, every `game-card` / `game-row` is a `<label>` with `data-game-id` and `data-selected="true" | "false"`;
    every card and row carries `data-game-id` in both modes.

**Plan ruling** (spec §1.2 "on a `var(--surface)` disc with a `var(--line-strong)` ring", §5 "3:1 non-text"):
`--line-strong` (#D3C8B2) measures **1.63:1** on `--surface` (#FFFDF8), under the 3:1 the spec asks
`contrast.spec.ts` to prove. The unchecked box's ring is **`--muted-2`** (#6E6657, 5.58:1 on `--surface`, its own
token note). The checked box and the selected card's outline stay `--primary-action` as specified.

**Plan ruling** (spec §1.2 "The header row (from sm) carries the select-all checkbox", and §1.3's "All on this page"
in the bar): the two controls are one state. The header's gets `data-testid="table-select-page"` (not in §9) and the
name "Select all titles on this page", so the two never share a name.

**Plan ruling** (spec §1.2 `aria-label={`Select ${titleLabel(g)}`}` vs §5 "Select Turrican (1990)"): the code formula
wins; `titleLabel` reads "Turrican, 1990", so the name is "Select Turrican, 1990".

**Plan ruling** (spec §1.4 "TitleControls gets `selecting`"): while selecting it renders a spacer the size of the ⋯
trigger, so a card's footer and the table's ⋯ track keep their size and nothing shifts.

- [ ] **Step 1: Write the failing e2e tests**

Append to `e2e/library-multi-select.spec.ts`:

```ts
/**
 * Drag with the real pointer (collections.spec.ts's dragOnto): dnd-kit's MouseSensor has an 8 px activation
 * constraint, so the steps are what would make a drag register.
 */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
}

test('MS-02 grid: a box on every card, a click ticks instead of navigating, the ⋯ menu is gone, a drag files nothing', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b] = await seedTitles(orgId, 'Grid', 2);
  const target = await makeCollection(page, `Drop ${runTag()}`);
  const filed: string[] = [];
  page.on('request', (r) => { if (/\/api\/collections\/[^/]+\/games/.test(r.url())) filed.push(r.url()); });
  await page.goto('/library');
  await expect(card(page, a.gameId)).toHaveAttribute('href', /\/games\//);
  await expect(page.getByTestId(`title-menu-${a.gameId}`)).toBeVisible();

  await startSelecting(page);
  for (const t of [a, b]) {
    await expect(boxOf(card(page, t.gameId))).toBeVisible();
    await expect(boxOf(card(page, t.gameId))).not.toBeChecked();   // both states drawn: an empty box, never nothing
    await expect(card(page, t.gameId)).toHaveAttribute('data-selected', 'false');
    await expect(page.getByTestId(`title-menu-${t.gameId}`)).toHaveCount(0);
  }
  await expect(card(page, a.gameId)).not.toHaveAttribute('href', /.*/);
  await expect(boxOf(card(page, a.gameId))).toHaveAttribute('aria-label', new RegExp(`^Select ${a.title}`));
  // The box sits in the card's top-left corner.
  const cb = (await card(page, a.gameId).boundingBox())!;
  const bb = (await boxOf(card(page, a.gameId)).boundingBox())!;
  expect(bb.x - cb.x).toBeLessThan(24);
  expect(bb.y - cb.y).toBeLessThan(24);

  await hydrated(page, 'select-title', 'onChange');
  await card(page, a.gameId).click({ position: { x: cb.width / 2, y: cb.height / 3 } });   // on the cover, not the box
  await expect(page).toHaveURL(/\/library$/);
  await expect(boxOf(card(page, a.gameId))).toBeChecked();
  await expect(card(page, a.gameId)).toHaveAttribute('data-selected', 'true');
  await boxOf(card(page, a.gameId)).click();
  await expect(boxOf(card(page, a.gameId))).not.toBeChecked();

  // Drag is off while selecting: a card dropped on the rail files nothing.
  await dragOnto(page, card(page, b.gameId), railRow(page, target.id));
  await page.waitForTimeout(1000);   // a drop would have POSTed by now
  expect(filed).toEqual([]);
  await expect(railRow(page, target.id).getByTestId('collection-count')).toHaveText('0');
});

test('MS-03 table: a leading box track on title rows, none on folders, the header ticks the page, a row click ticks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Row', 3);
  const folder = await makeCollection(page, `Folder ${runTag()}`, [c.gameId]);
  await page.goto('/library?view=table');
  await expect(row(page, a.gameId)).toHaveAttribute('href', /\/games\//);
  await startSelecting(page);

  const folderRow = page.locator(`[data-testid="folder-row"][data-collection-id="${folder.id}"]`);
  await expect(folderRow).toBeVisible();
  await expect(folderRow.getByTestId('select-title')).toHaveCount(0);
  const rb = (await row(page, a.gameId).boundingBox())!;
  const bb = (await boxOf(row(page, a.gameId)).boundingBox())!;
  expect(bb.x - rb.x).toBeLessThan(40);   // the leading 28 px track, after the row's 18 px padding
  await expect(page.getByTestId(`title-menu-${a.gameId}`)).toHaveCount(0);

  await hydrated(page, 'select-title', 'onChange');
  await row(page, a.gameId).click({ position: { x: rb.width / 2, y: rb.height / 2 } });
  await expect(page).not.toHaveURL(/\/games\//);
  await expect(boxOf(row(page, a.gameId))).toBeChecked();
  await expect(row(page, a.gameId)).toHaveAttribute('data-selected', 'true');

  const all = page.getByTestId('table-select-page');
  expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);   // one of two
  await all.click();
  for (const t of [a, b]) await expect(boxOf(row(page, t.gameId))).toBeChecked();
  await expect(all).toBeChecked();
  await all.click();
  for (const t of [a, b]) await expect(boxOf(row(page, t.gameId))).not.toBeChecked();
});

test('MS-04 a selection keeps across pages and grid/table, ends on another view and on Back from a title', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(orgId, 'Keep', 26);   // page 1: 01-24, page 2: 25-26
  await smallPages(page);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, t[0].gameId)).click();

  await page.getByTestId('pager-next').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await boxOf(card(page, t[25].gameId)).click();
  await page.getByRole('link', { name: 'Table view' }).click();
  await expect(page).toHaveURL(/view=table/);
  await expect(boxOf(row(page, t[25].gameId))).toBeChecked();
  await page.getByTestId('pager-page-1').click();
  await expect(boxOf(row(page, t[0].gameId))).toBeChecked();
  await expect(boxOf(row(page, t[1].gameId))).not.toBeChecked();

  // Another view ends it: nothing was changed, so no prompt.
  await page.getByTestId('collection-all').click();
  await expect(page).toHaveURL(/collection=all/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('select-title')).toHaveCount(0);

  // Back from a title never revives an old selection.
  await startSelecting(page);
  await page.getByTestId('select-title').first().click();
  await page.getByTestId('search-input').fill(t[3].title);
  await expect(page.getByTestId('search-result').first()).toHaveAttribute('data-result-id', t[3].gameId);
  await page.getByTestId('search-input').press('Enter');
  await expect(page).toHaveURL(new RegExp(`/games/${t[3].gameId}`));
  await page.goBack();
  await expect(page).toHaveURL(/\/library/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('select-title')).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `time PORT=3100 npx playwright test e2e/library-multi-select.spec.ts --project=desktop -g "MS-0[2-4]"`
Expected: 3 failed — no `select-title` (MS-02, MS-03), no `data-game-id` on the cards (MS-04).

- [ ] **Step 3: The boxes**

Create `src/components/library/select-box.tsx`:

```tsx
'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { CheckIcon, MinusIcon } from 'lucide-react';
import type { GameListItem } from '@/lib/queries';
import { CAP_TITLE, SELECTION_CAP, canSelectPage, pageCheck } from '@/lib/library-selection';
import { titleLabel } from './title-controls';
import { useLibrarySelection } from './selection-provider';

// Real <input type="checkbox">es (spec §1.2, §5), drawn 22 px with appearance-none. Both states are drawn: an
// unticked box is an empty ring, never nothing (the "show both values" rule). The unticked ring is --muted-2, which
// clears 3:1 on the surface; --line-strong would not (Plan ruling, Task 3).
const BOX = 'peer size-[22px] shrink-0 cursor-pointer appearance-none rounded-[6px] border-2 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 aria-disabled:cursor-default aria-disabled:opacity-50';
const ON_SURFACE = 'border-(--muted-2) bg-(--surface) checked:border-(--primary-action) checked:bg-(--primary-action) '
  + 'indeterminate:border-(--primary-action) indeterminate:bg-(--primary-action) focus-visible:outline-(--ring)';
const ON_INK = 'border-(--surface) bg-transparent checked:bg-(--surface) indeterminate:bg-(--surface) '
  + 'focus-visible:outline-(--surface)';

function Box({ input, onInk }: { input: ReactNode; onInk: boolean }) {
  const mark = `pointer-events-none absolute inset-0 m-auto size-3.5 opacity-0 ${onInk ? 'text-(--ink)' : 'text-white'}`;
  return (
    <span className="relative inline-grid size-[22px] shrink-0">
      {input}
      <CheckIcon aria-hidden strokeWidth={3} className={`${mark} peer-checked:opacity-100`} />
      <MinusIcon aria-hidden strokeWidth={3} className={`${mark} peer-indeterminate:opacity-100`} />
    </span>
  );
}

/** One title's box. At the 1,000 cap an unticked box is aria-disabled and says why (Ruling 6). */
export function SelectBox({ game: g }: { game: Pick<GameListItem, 'id' | 'title' | 'year' | 'diskCount'> }) {
  const sel = useLibrarySelection();
  const checked = sel.selected.has(g.id);
  const capped = !checked && sel.selected.size >= SELECTION_CAP;
  return (
    <Box onInk={false} input={(
      <input
        type="checkbox"
        data-testid="select-title"
        aria-label={`Select ${titleLabel(g)}`}
        checked={checked}
        aria-disabled={capped || undefined}
        title={capped ? CAP_TITLE : undefined}
        onChange={() => {
          if (capped) return;
          sel.dispatch({ type: 'toggle', title: { id: g.id, title: g.title, year: g.year, diskCount: g.diskCount } });
        }}
        className={`${BOX} ${ON_SURFACE}`}
      />
    )} />
  );
}

/**
 * "All on this page" (spec §1.3): ticked when every title of the page is, indeterminate when some are; it toggles
 * exactly this page. Refused, aria-disabled and titled, when ticking the page would pass the cap.
 */
export function PageSelectBox({ testId, label, onInk = false, inputRef }: {
  testId: string;
  /** The accessible name when no visible <label> wraps it. */
  label?: string;
  onInk?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const sel = useLibrarySelection();
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  const ids = sel.pageTitles.map((t) => t.id);
  const state = pageCheck(sel.selected, ids);
  const blocked = state !== 'all' && !canSelectPage(sel.selected, ids);
  // `indeterminate` is a DOM property with no attribute: set after every render that changes it.
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [ref, state]);
  return (
    <Box onInk={onInk} input={(
      <input
        ref={ref}
        type="checkbox"
        data-testid={testId}
        aria-label={label}
        checked={state === 'all'}
        aria-disabled={blocked || undefined}
        title={blocked ? CAP_TITLE : undefined}
        onChange={() => { if (!blocked) sel.dispatch({ type: 'togglePage', page: sel.pageTitles }); }}
        className={`${BOX} ${onInk ? ON_INK : ON_SURFACE}`}
      />
    )} />
  );
}
```

- [ ] **Step 4: The plain name and the controls spacer**

In `src/components/library/title-controls.tsx`, replace `TitleName` with its doc comment (lines 214-218) with:

```tsx
/**
 * The title's name: the inline rename on an authored single-disk title, else plain text. `plain` while selecting
 * (spec §1.4): the card is a <label>, and nothing interactive sits inside it.
 */
export function TitleName({ game: g, className, plain = false }: { game: GameListItem; className: string; plain?: boolean }) {
  if (!plain && g.authored && g.diskId) return <VolumeNameField game={g} />;
  return <span className={className} style={{ color: 'var(--ink)' }}>{g.title}</span>;
}
```

and replace `TitleControls` with its doc comment (lines 235-246) with:

```tsx
/**
 * A title's controls on a card and on a table row: the ⋯ menu (title-menu.tsx, spec §2), which holds Mount / Eject,
 * Write to NFC tag, Version history, Move to collection…, Remove from collection and Delete title in that order.
 * While selecting (multi-select spec §1.4, Ruling 7) it is a spacer the trigger's size: hidden rather than inert, so
 * nothing interactive sits inside the card's <label>, and the footer and the table's ⋯ track keep their size.
 */
export function TitleControls({ game: g, collectionId, fob, drives, view = null, selecting = false }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext;
  /** The library view to carry into the history link when it is not the person's default (trail.ts, final review M1). */
  view?: TrailView;
  selecting?: boolean;
}) {
  if (selecting) return <span aria-hidden data-controls-spacer="" className="h-11 w-11 shrink-0 sm:h-8 sm:w-8" />;
  return <TitleMenu game={g} collectionId={collectionId} fob={fob} drives={drives} view={view} />;
}
```

- [ ] **Step 5: The grid**

In `src/components/library/game-grid.tsx`:

Add to the imports:

```ts
import { useLibrarySelection } from './selection-provider';
import { SelectBox } from './select-box';
```

In `CardBody`, change the signature to

```tsx
function CardBody({ game: g, collectionId, fob, drives, selecting = false }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext; selecting?: boolean;
}) {
```

change `<TitleName game={g} className="truncate text-[14px] font-semibold" />` to
`<TitleName game={g} className="truncate text-[14px] font-semibold" plain={selecting} />`, and change
`<TitleControls game={g} collectionId={collectionId} fob={fob} drives={drives} view={trailView} />` to
`<TitleControls game={g} collectionId={collectionId} fob={fob} drives={drives} view={trailView} selecting={selecting} />`.

Insert after `SetDropHint` (before the `DraggableCard` doc comment):

```tsx
/**
 * A card while selecting (multi-select spec §1.2, §1.4, Rulings 3, 7): a <label> wrapping its box, so a click
 * anywhere on it ticks the title and never navigates; drag is off (the caller's hook is disabled). The box sits on a
 * surface disc in the cover's top-left corner; a ticked card is outlined.
 */
function SelectableCard({ ref, game: g, collectionId, fob, drives, pendingHide }: {
  ref: (el: HTMLElement | null) => void;
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext; pendingHide: PendingHide | null;
}) {
  const checked = useLibrarySelection().selected.has(g.id);
  return (
    <label
      ref={ref}
      data-testid="game-card"
      data-game-id={g.id}
      data-selected={checked ? 'true' : 'false'}
      data-drive={driveState(drives, g.id)}
      className={`${CARD_CLASS} cursor-pointer ${checked ? 'outline-2 outline-(--primary-action)' : ''}`}
      style={pendingHideStyle(pendingHide)}
    >
      <span className="absolute left-3 top-3 z-10 grid size-[30px] place-items-center rounded-full bg-(--surface)">
        <SelectBox game={g} />
      </span>
      <CardBody game={g} collectionId={collectionId} fob={fob} drives={drives} selecting />
      <DriveRing holds={drives?.holds[g.id]} />
    </label>
  );
}
```

In `DraggableCard`, after `const trailView = useTrailView();` add `const { selecting } = useLibrarySelection();`;
change `useDraggable({ id: g.id, data })` to `useDraggable({ id: g.id, data, disabled: selecting })` and
`useDroppable({ id: g.id, data })` to `useDroppable({ id: g.id, data, disabled: selecting })`; directly after the
`setNodeRef` `useCallback` line add

```tsx
  if (selecting) return <SelectableCard ref={setNodeRef} game={g} fob={fob} drives={drives} pendingHide={pendingHide} />;
```

and on its `<Link>` add `data-game-id={g.id}` after `data-testid="game-card"`.

In `SortableCard`, after `const trailView = useTrailView();` add `const { selecting } = useLibrarySelection();`; add
`disabled: selecting,` to the `useSortable({ … })` options; after the `const style = …` line add

```tsx
  if (selecting) {
    return <SelectableCard ref={setNodeRef} game={g} collectionId={collectionId} fob={fob} drives={drives} pendingHide={pendingHide} />;
  }
```

and on its `<Link>` add `data-game-id={g.id}` after `data-testid="game-card"`.

- [ ] **Step 6: The table**

In `src/components/library/game-table.tsx`:

Add to the imports:

```ts
import { useLibrarySelection } from './selection-provider';
import { PageSelectBox, SelectBox } from './select-box';
```

Replace lines 31-33 (`COLS`, `MIN_W`, `ROW`) with:

```ts
const COLS = 'grid-cols-[40px_minmax(0,1fr)_44px] sm:grid-cols-[36px_minmax(0,1fr)_104px_56px_150px_52px_96px_44px]';
const MIN_W = 'sm:min-w-[760px]';
// While selecting (multi-select spec §1.2, Ruling 3): a leading 28 px box track; the DiskIcon and its ring stay where
// they are, and the ⋯ track stays (empty), so nothing shifts sideways inside the row.
const COLS_SELECT = 'grid-cols-[28px_40px_minmax(0,1fr)_44px] sm:grid-cols-[28px_36px_minmax(0,1fr)_104px_56px_150px_52px_96px_44px]';
const MIN_W_SELECT = 'sm:min-w-[802px]';
const rowClass = (selecting: boolean) =>
  `grid ${selecting ? COLS_SELECT : COLS} ${selecting ? MIN_W_SELECT : MIN_W} items-center gap-x-3 border-b px-4 font-sans text-[13px] sm:gap-x-[14px] sm:px-[18px]`;
```

In `GameTable`, after `const { collections, view, pendingHide: hidden } = useCollectionsContext();` add
`const { selecting } = useLibrarySelection();`. Replace the header row's opening `<div …>` (its two lines) and the
line after it (`<span /><span>Name</span><span>Type</span><span>Year</span><span>Publisher</span>`) with:

```tsx
        <div className={`grid ${selecting ? COLS_SELECT : COLS} ${selecting ? MIN_W_SELECT : MIN_W} h-11 items-center gap-x-[14px] border-b px-[18px] font-sans text-[12px] font-medium max-sm:hidden`}
             style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
          {selecting && (
            <span className="grid place-items-center">
              <PageSelectBox testId="table-select-page" label="Select all titles on this page" />
            </span>
          )}
          <span /><span>Name</span><span>Type</span><span>Year</span><span>Publisher</span>
```

In the `rows.map`, pass `selecting={selecting}` to `UpRow` and to `FolderRow`.

Replace `UpRow` with:

```tsx
/** Back to the library root -- the folder listing -- from a collection or All titles. */
function UpRow({ href, selecting }: { href: string; selecting: boolean }) {
  return (
    <Link href={href} data-testid="up-row" aria-label="Up to Library" className={`${rowClass(selecting)} ${HOVER} h-11`} style={ROW_BORDER}>
      {/* The box track, empty: a navigation row is not selectable (it ends selecting, Ruling 4). */}
      {selecting && <span />}
      {/* One arrow, the text's (final review M8: the icon and "↑" drew two; Ruling 13). */}
      <span />
      <span className="col-span-2 text-[14px] font-medium sm:col-span-7" style={{ color: 'var(--muted)' }}>
        ↑ Library
      </span>
    </Link>
  );
}
```

In `FolderRow`, add `selecting` to its props (`{ collection: c, disks, href, selecting }: { collection: CollectionSummary; disks?: number; href: string; selecting: boolean }`),
change `className={`${ROW} ${HOVER} min-h-[56px] …`}` to `className={`${rowClass(selecting)} ${HOVER} min-h-[56px] py-2 sm:h-[46px] sm:min-h-0 sm:py-0`}`,
and insert `{selecting && <span />}` as the Link's first child (before the `folder-glyph` svg comment).

Replace `TitleRow` (its doc comment stays) with the function below and the new `RowCells` after it:

```tsx
function TitleRow({ game: g, collectionId, fob, drives, pendingHide }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext; pendingHide: PendingHide | null;
}) {
  const trailView = useTrailView();
  const { selecting, selected } = useLibrarySelection();
  // See DraggableCard (game-grid.tsx) on why `role` is discarded rather than spread.
  const data = { type: 'game', id: g.id, title: g.title, diskCount: g.diskCount } satisfies GameDragData;
  const { attributes: dragAttributes, listeners, setNodeRef, isDragging } = useDraggable({ id: g.id, data, disabled: selecting });
  const attributes = { ...dragAttributes, role: undefined };
  // The row itself stays put while it is dragged -- RowDragOverlay carries
  // the title to the rail -- so it only fades, like a card does.
  const held = drives?.holds[g.id]?.some((h) => h.state === 'mounted');
  const style = { ...ROW_BORDER, ...(held ? { background: 'var(--mounted-bg)' } : {}), opacity: isDragging ? 0.4 : 1, ...pendingHideStyle(pendingHide) };
  const cls = `${rowClass(selecting)} ${HOVER} min-h-[56px] py-2 sm:h-[46px] sm:min-h-0 sm:py-0`;

  if (selecting) {
    // Multi-select (spec §1.2, Ruling 3): a <label> wrapping the box in the leading track, so a click anywhere on the
    // row ticks it and never navigates; drag is off.
    const checked = selected.has(g.id);
    return (
      <label ref={setNodeRef} data-testid="game-row" data-game-id={g.id} data-selected={checked ? 'true' : 'false'}
             data-drive={driveState(drives, g.id)}
             className={`${cls} cursor-pointer ${checked ? 'outline-2 -outline-offset-2 outline-(--primary-action)' : ''}`}
             style={style}>
        <span className="grid place-items-center"><SelectBox game={g} /></span>
        <RowCells game={g} collectionId={collectionId} fob={fob} drives={drives} selecting />
      </label>
    );
  }

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}${fromQuery(collectionId, trailView)}`}
      // The title, not the whole row: a screen reader otherwise reads every cell and every button as the link's name
      // (final review M5).
      aria-label={titleLabel(g)}
      data-testid="game-row"
      data-game-id={g.id}
      data-drive={driveState(drives, g.id)}
      aria-hidden={pendingHide ? true : undefined}
      // See DraggableCard on why an anchor must opt out of native dragging.
      draggable={false}
      className={cls}
      style={style}
      {...attributes}
      {...listeners}
    >
      <RowCells game={g} collectionId={collectionId} fob={fob} drives={drives} selecting={false} />
    </Link>
  );
}

/** A title row's cells after the box track: the same in both modes but for the plain name and the ⋯ spacer. */
function RowCells({ game: g, collectionId, fob, drives, selecting }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext; selecting: boolean;
}) {
  const trailView = useTrailView();
  return (
    <>
      <div className="relative h-[27px] w-[26px]">
        {/* mounted={false}: the row's one DF0 mark is the pill after the name (the grid card's rule, Task 2). */}
        <DiskIcon color={titleDiskColor(g)} size={26} hd={g.hasHd} stack={g.diskCount} mounted={false} />
        {/* The card's ring, drawn round the disk; the label says it to a screen reader. Both inside this cell: a
            bare child of the row would take a grid column of its own. */}
        <DriveRing holds={drives?.holds[g.id]} compact />
        <HoldsLabel game={g} drives={drives} />
      </div>
      <span className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {/* Below sm the whole name wraps (no ellipsis); from sm it truncates in its column, as before. */}
          <TitleName game={g} plain={selecting} className="text-[14px] font-semibold [overflow-wrap:anywhere] sm:truncate sm:text-[13px] sm:font-medium" />
          <DriveBadge holds={drives?.holds[g.id]} diskCount={g.diskCount} inline />
        </span>
        <span data-meta="" className="text-[12px] sm:hidden" style={{ color: 'var(--muted-2)' }}>{titleMeta(g)}</span>
      </span>
      <span data-testid="game-kind" className={WIDE}>
        {g.kind
          ? (
            <span className="rounded-full px-2 py-0.5 text-[12px] font-medium"
                  style={{ background: kindTag(g.kind).bg, color: kindTag(g.kind).fg }}>
              {g.kind}
            </span>
            )
          /* An em dash, not a guess. TOSEC recognises 45.9% of a real
             archive, so "unknown" is the common case and must read as
             "not identified" rather than as a category of its own. */
          : <span style={{ color: 'var(--muted-2)' }}>—</span>}
      </span>
      <span className={WIDE} style={{ color: g.year ? 'var(--ink)' : 'var(--muted-2)' }}>{g.year ?? '—'}</span>
      <span className={`truncate ${WIDE}`} style={{ color: g.publisher ? 'var(--muted)' : 'var(--muted-2)' }}>{g.publisher ?? '—'}</span>
      <span className={`text-right font-mono ${WIDE}`}
            style={{ color: g.diskCount > 1 ? 'var(--amber-text)' : 'var(--ink)' }}>
        {g.diskCount}
      </span>
      <span className={`flex items-center justify-end gap-1.5 text-right font-mono ${WIDE}`} style={{ color: 'var(--ink)' }}>
        {fmtSize(g.sizeBytes)}{g.hasHd && <HdTag testId="game-hd-tag" />}
      </span>
      {/* Inside the row's <a href>, as on the card: each control stops every
          pointer event before it reaches the anchor or dnd-kit. */}
      <span className="flex justify-self-end">
        <TitleControls game={g} collectionId={collectionId} fob={fob} drives={drives} view={trailView} selecting={selecting} />
      </span>
    </>
  );
}
```

`ROW` is no longer referenced; check with `grep -n '\bROW\b' src/components/library/game-table.tsx` → only
`ROW_BORDER` hits.

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx tsc --noEmit` → clean; `pnpm test --testTimeout=30000 src/components/library` → PASS (the existing
`title-menu.test.ts`, `view-toggle.test.ts`, `empty-library.test.ts` unchanged).
Run: `time PORT=3100 npx playwright test e2e/library-multi-select.spec.ts --project=desktop -g "MS-0[1-4]"` → 4 passed.

- [ ] **Step 8: The grid and table regression**

One run at a time, each timed:
1. `time PORT=3100 npx playwright test e2e/library.spec.ts e2e/library-a3.spec.ts e2e/library-table.spec.ts e2e/library-type-column.spec.ts --project=desktop` → all pass.
2. `time PORT=3100 npx playwright test e2e/library-mount.spec.ts e2e/library-covers.spec.ts e2e/nfc-fob-button.spec.ts e2e/view-toggle.spec.ts --project=desktop` → all pass.
3. `time PORT=3100 npx playwright test e2e/disk-sets.spec.ts --project=desktop --list`, then two `-g` halves of at
   most 13 tests chosen from the listed titles → all pass (card-on-card sets and the drag preview).
4. `time PORT=3100 npx playwright test e2e/collections.spec.ts --project=desktop` (alone, about 5 min) → all pass.

- [ ] **Step 9: The gates and the commit**

Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint; echo "exit $?"` → green; lint
`✖ 12 problems (0 errors, 12 warnings)`, `exit 0`.

```bash
git status --short
git add src/components/library/select-box.tsx src/components/library/title-controls.tsx \
  src/components/library/game-grid.tsx src/components/library/game-table.tsx e2e/library-multi-select.spec.ts
git commit -m "Multi-select: boxes on every card and row; while selecting a title is a label, drag and the menu are off

Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 4: The selection bar and the Move to collection dialog

**Files:**
- Modify: `src/lib/library-selection.ts` + `.test.ts` (append `moveToast`)
- Create: `src/components/library/library-selection-bar.tsx`, `src/components/library/bulk-move-dialog.tsx`
- Modify: `src/app/(app)/library/page.tsx` (inside `SelectionScope`, before the grid/table conditional)
- Modify: `e2e/library-multi-select.spec.ts` (MS-05 … MS-08)

**Interfaces:**
- Consumes: `useLibrarySelection()` (Task 2), `PageSelectBox` (Task 3), `countText`, `offPageText`, `offPageCount`,
  `titlesWord` (Task 2), `useCollectionsContext().collections: CollectionSummary[]`
  (`@/components/collections/collection-provider`), `Modal` (`@/components/ui/modal`; props `open`, `onOpenChange`,
  `title`, `subtitle`, `footer`, `width`, `testId`, `dismissible`, `closeTestId`, `finalFocus`, `initialFocus`),
  `MoveResult` (type, `@/lib/collections`, Task 1), `useRouter` (`next/navigation`), `toast` (`sonner`).
- Produces: `moveToast(r: MoveResult, name: string): string`;
  `LibrarySelectionBar({ collectionId, collectionName }: { collectionId: string | null; collectionName: string | null })`;
  `BulkMoveDialog(props)` with
  `{ open: boolean; onClose: () => void; ids: string[]; collectionId: string | null; collectionName: string | null; targets: CollectionSummary[]; busy: boolean; setBusy: (b: boolean) => void; onMoved: () => void; finalFocus: () => HTMLElement | null }`.
  Task 5 adds the Delete dialog into `LibrarySelectionBar`: the bar's `open('delete', …)`, its `deleteRef`, `busy`,
  `finished()` and `finalFocusFor(deleteRef)` are what it uses.

**Plan ruling** (spec §1.3 "It is sticky … Its contents" and the "live regions are present from first paint" rule):
`LibrarySelectionBar` is rendered whenever the page has titles and stays in the DOM, `hidden` while not selecting. So
the count's `role="status"` exists before its first change, and the two `Modal`s it hosts stay mounted through their
close (their `finalFocus` runs) even though selecting ends at the same moment. "The bar appears" means it becomes
visible.

**Plan ruling** (spec §2.1 "One `role="radio"` row per collection"): the rows are native `<input type="radio">`s in
labels inside the `role="radiogroup" aria-label="Collection"` div, so arrow keys move between them natively; their
accessible name is the collection's name (the count is `aria-hidden`, as in the single dialog).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/library-selection.test.ts` (and add `moveToast` to its import list):

```ts
describe('move words (spec §2.3)', () => {
  it('names how many went where, and adds what was already there or already gone', () => {
    expect(moveToast({ added: 12, alreadyThere: 0, removedFrom: 0, missing: [] }, 'Shooters')).toBe('Moved 12 titles to Shooters');
    expect(moveToast({ added: 9, alreadyThere: 3, removedFrom: 9, missing: [] }, 'X')).toBe('Moved 12 titles to X, 3 were already there');
    expect(moveToast({ added: 1, alreadyThere: 1, removedFrom: 0, missing: ['g'] }, 'X'))
      .toBe('Moved 2 titles to X, 1 was already there, 1 was already gone');
  });
});
```

Append to `e2e/library-multi-select.spec.ts`:

```ts
test('MS-05 Cancel changes nothing: no request is sent, both titles stay, focus goes to the toggle', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b] = await seedTitles(orgId, 'Cancel', 2);
  await makeCollection(page, `Target ${runTag()}`);
  const sent = bulkRequests(page);
  await page.goto('/library');
  await expect(bar(page)).toBeHidden();
  await startSelecting(page);
  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId('library-select-page')).toBeFocused();
  await expect(count(page)).toHaveText('No titles selected');
  for (const id of ['library-bulk-move', 'library-bulk-delete']) {
    await expect(page.getByTestId(id)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(id)).toHaveAttribute('title', 'Select titles first');
  }
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await boxOf(card(page, b.gameId)).click();
  await expect(count(page)).toHaveText('2 titles selected');

  await page.getByTestId('library-bulk-move').click();
  await expect(page.getByTestId('bulk-move-dialog')).toBeVisible();
  await page.getByTestId('bulk-move-cancel').click();
  await expect(page.getByTestId('bulk-move-dialog')).toBeHidden();
  await expect(page.getByTestId('library-bulk-move')).toBeFocused();
  await expect(count(page)).toHaveText('2 titles selected');

  await page.getByTestId('library-selection-cancel').click();
  await expect(bar(page)).toBeHidden();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(card(page, a.gameId)).toBeVisible();
  await expect(card(page, b.gameId)).toBeVisible();
  expect(sent).toEqual([]);
});

test('MS-06 grid, Move: two titles from Uncategorized into a collection; they leave the inbox, the rail counts follow', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Move', 3);
  const dst = await makeCollection(page, `Shooters ${runTag()}`);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await boxOf(card(page, b.gameId)).click();
  await page.getByTestId('library-bulk-move').click();

  const dlg = page.getByTestId('bulk-move-dialog');
  await expect(dlg).toContainText('Move to collection');
  await expect(dlg).toContainText('2 titles go into the collection you pick. Titles already in other collections stay there too.');
  const confirm = page.getByTestId('bulk-move-confirm');
  await expect(confirm).toHaveText('Move 2 titles');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await dlg.getByRole('radio', { name: dst.name }).check();
  await expect(confirm).not.toHaveAttribute('aria-disabled', /.*/);
  await confirm.click();

  await expect(page.getByText(`Moved 2 titles to ${dst.name}`)).toBeVisible();
  await expect(dlg).toBeHidden();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(card(page, a.gameId)).toHaveCount(0);
  await expect(card(page, b.gameId)).toHaveCount(0);
  await expect(card(page, c.gameId)).toBeVisible();
  await expect(railRow(page, dst.id).getByTestId('collection-count')).toHaveText('2');
  await expect(page.getByTestId('collection-uncategorized')).toHaveText(/Uncategorized\s*1$/);
});

test('MS-07 inside a collection, Move leaves it; Escape in the dialog closes only the dialog; a double press sends one request', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Inside', 3);
  const src = await makeCollection(page, `Source ${runTag()}`, [a.gameId, b.gameId, c.gameId]);
  const dst = await makeCollection(page, `Dest ${runTag()}`);
  const sent = bulkRequests(page);
  await page.goto(`/library?collection=${src.id}`);
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await boxOf(card(page, b.gameId)).click();
  await page.getByTestId('library-bulk-move').click();
  const dlg = page.getByTestId('bulk-move-dialog');
  await expect(dlg).toContainText(`2 titles leave ${src.name} and go into the collection you pick.`);
  await expect(dlg.getByRole('radio', { name: src.name })).toHaveCount(0);   // never the one you are in

  // Review Focus 2: Escape inside the dialog bubbles through React's portal tree; only the dialog closes.
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(bar(page)).toBeVisible();
  await expect(count(page)).toHaveText('2 titles selected');
  await expect(page.getByTestId('library-bulk-move')).toBeFocused();

  await page.getByTestId('library-bulk-move').click();
  await dlg.getByRole('radio', { name: dst.name }).check();
  // Review Focus 3: a double press sends one move.
  await page.getByTestId('bulk-move-confirm').dblclick();
  await expect(page.getByText(`Moved 2 titles to ${dst.name}`)).toBeVisible();
  expect(sent.filter((s) => s.includes('"op":"move"'))).toHaveLength(1);
  expect(JSON.parse(sent[0])).toMatchObject({ op: 'move', to: dst.id, from: src.id });
  await expect(card(page, a.gameId)).toHaveCount(0);
  await expect(card(page, c.gameId)).toBeVisible();
  await expect(railRow(page, dst.id).getByTestId('collection-count')).toHaveText('2');
  await expect(railRow(page, src.id).getByTestId('collection-count')).toHaveText('1');
});

test('MS-08 All on this page, its indeterminate state, the count of titles on other pages, Escape from the bar', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(orgId, 'Pages', 26);
  await smallPages(page);
  await page.goto('/library');
  await startSelecting(page);
  const all = page.getByTestId('library-select-page');
  await hydrated(page, 'library-select-page', 'onChange');
  await all.click();
  await expect(count(page)).toHaveText('24 titles selected');
  await expect(all).toBeChecked();

  await page.getByTestId('pager-next').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(count(page)).toHaveText('24 titles selected · 24 on other pages');
  await expect(page.getByTestId('library-selection-offpage')).toHaveText(/·\s*24 on other pages$/);
  await expect(all).not.toBeChecked();
  await boxOf(card(page, t[25].gameId)).click();
  expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
  await expect(count(page)).toHaveText('25 titles selected · 24 on other pages');

  // Escape with focus in the bar ends selecting; focus goes to the toggle.
  await all.focus();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/library-selection.test.ts` → FAIL (`moveToast` is not exported).
Run: `time PORT=3100 npx playwright test e2e/library-multi-select.spec.ts --project=desktop -g "MS-0[5-8]"` → 4 failed
(no `library-selection-bar`).

- [ ] **Step 3: The move words**

Append to `src/lib/library-selection.ts` (and add `import type { MoveResult } from '@/lib/collections';` under the
existing `import type` line):

```ts
const wasWere = (n: number) => `${n} ${n === 1 ? 'was' : 'were'}`;

/** The Move toast (spec §2.3): every owned title ended up in the target; the rest of the line says how. */
export function moveToast(r: MoveResult, name: string): string {
  let s = `Moved ${titlesWord(r.added + r.alreadyThere)} to ${name}`;
  if (r.alreadyThere > 0) s += `, ${wasWere(r.alreadyThere)} already there`;
  if (r.missing.length > 0) s += `, ${wasWere(r.missing.length)} already gone`;
  return s;
}
```

- [ ] **Step 4: The Move dialog**

Create `src/components/library/bulk-move-dialog.tsx`:

```tsx
'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import type { CollectionSummary } from '@/components/collections/collection-provider';
import type { MoveResult } from '@/lib/collections';
import { moveToast, titlesWord } from '@/lib/library-selection';

const FOOT_PLAIN = 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60';
const FOOT_PRIMARY = 'h-[38px] rounded-[10px] bg-(--primary-action) px-4 text-[13px] font-semibold text-white aria-disabled:opacity-50';

/**
 * Move to collection, for a selection (spec §2.1, Rulings 8, 9, 10, 11): one dialog picks the target and confirms.
 * The single move's meaning made plural: inside a collection the titles leave it; from All titles or Uncategorized
 * they only go in. Targets are every collection but the one you are in; Uncategorized is never one.
 *
 * Busy is aria-disabled plus a ref guard, the Modal not dismissible, the request in try/catch/finally (Ruling 16).
 * A failure keeps the dialog open so OK can be pressed again ("Trying again is safe": Ruling 15).
 */
export function BulkMoveDialog({
  open, onClose, ids, collectionId, collectionName, targets, busy, setBusy, onMoved, finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  ids: string[];
  collectionId: string | null;
  collectionName: string | null;
  targets: CollectionSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onMoved: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const guard = useRef(false);
  const n = ids.length;
  const off = busy || target === null;

  function close() {
    if (busy) return;
    setTarget(null);
    onClose();
  }

  async function confirm() {
    if (target === null || guard.current) return;
    guard.current = true;
    setBusy(true);
    const name = targets.find((t) => t.id === target)?.name ?? 'the collection';
    try {
      const res = await fetch('/api/games/bulk', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'move', gameIds: ids, to: target, ...(collectionId ? { from: collectionId } : {}) }),
      });
      if (!res.ok) {
        toast.error('Could not move the titles', { description: `The server answered ${res.status}.` });
        return;
      }
      toast.success(moveToast(await res.json() as MoveResult, name));
      setTarget(null);
      onMoved();
    } catch {
      toast.error('Could not reach the server', { description: 'Trying again is safe.' });
    } finally {
      setBusy(false);
      guard.current = false;
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) close(); }}
      width={440}
      testId="bulk-move-dialog"
      closeTestId="bulk-move-close"
      title="Move to collection"
      dismissible={!busy}
      finalFocus={finalFocus}
      subtitle={collectionId
        ? <>{titlesWord(n)} leave <em>{collectionName}</em> and go into the collection you pick.</>
        : `${titlesWord(n)} go into the collection you pick. Titles already in other collections stay there too.`}
      footer={(
        <div className="flex w-full items-center justify-end gap-2.5">
          <button type="button" data-testid="bulk-move-cancel" aria-disabled={busy || undefined} onClick={close}
                  className={FOOT_PLAIN}>
            Cancel
          </button>
          <button type="button" data-testid="bulk-move-confirm" aria-disabled={off || undefined}
                  onClick={() => { if (!off) void confirm(); }} className={FOOT_PRIMARY}>
            {busy ? 'Moving…' : `Move ${titlesWord(n)}`}
          </button>
        </div>
      )}
    >
      <div role="radiogroup" aria-label="Collection" className="flex flex-col gap-1 px-4 py-3">
        {targets.map((c) => (
          <label key={c.id}
                 className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 hover:bg-(--track) has-checked:bg-(--track) sm:min-h-10">
            <input type="radio" name="bulk-move-target" value={c.id} checked={target === c.id}
                   onChange={() => { if (!busy) setTarget(c.id); }}
                   className="size-4 accent-(--primary-action)" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-(--ink)">{c.name}</span>
            <span aria-hidden className="font-mono text-[12px] text-(--muted)">
              {c.gameCount} {c.gameCount === 1 ? 'title' : 'titles'}
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: The bar**

Create `src/components/library/library-selection-bar.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useCollectionsContext } from '@/components/collections/collection-provider';
import { countText, offPageCount, offPageText } from '@/lib/library-selection';
import { useLibrarySelection } from './selection-provider';
import { PageSelectBox } from './select-box';
import { BulkMoveDialog } from './bulk-move-dialog';

// 30 px from sm, 44 px below; flex-1 on the phone's second line (spec §1.3, §6, Ruling 20).
const BTN = 'grid h-11 flex-1 place-items-center rounded-[7px] px-3 text-[13px] font-semibold sm:h-[30px] sm:flex-none '
  + 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--surface) '
  + 'aria-disabled:cursor-default aria-disabled:opacity-50';
const PLAIN = `${BTN} bg-(--on-ink-fill) text-(--surface)`;
const DANGER = `${BTN} bg-(--danger-fg) text-white`;

/**
 * The selection bar (spec §1.3, Rulings 2, 5, 6) and the host of its dialogs. Always in the DOM while the page has
 * titles, hidden while not selecting (Plan ruling, Task 4): the count's live region exists before it first changes,
 * and the dialogs stay mounted through their close. Sticky at the top of the grid/table column, so the operations stay
 * in reach down a 48-title page. Nothing is sent from here: only a dialog's confirm writes.
 */
export function LibrarySelectionBar({ collectionId, collectionName }: {
  /** The collection you are in, or null in All titles / Uncategorized. */
  collectionId: string | null;
  collectionName: string | null;
}) {
  const router = useRouter();
  const sel = useLibrarySelection();
  const { collections } = useCollectionsContext();
  const [dialog, setDialog] = useState<'move' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const pageBox = useRef<HTMLInputElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  // Set by a successful OK: the dialog's close then hands focus to the toggle (or the h1), not to its opener.
  const done = useRef(false);

  const ids = useMemo(() => [...sel.selected.keys()], [sel.selected]);
  const n = ids.length;
  const off = offPageCount(sel.selected, sel.pageTitles.map((t) => t.id));
  const targets = collections.filter((c) => c.id !== collectionId);
  const moveReason = n === 0 ? 'Select titles first' : targets.length === 0 ? 'Make a collection first' : null;
  const deleteReason = n === 0 ? 'Select titles first' : null;

  // Toggle on puts focus on "All on this page" (spec §1.1). Focus only; no state is set here.
  useEffect(() => { if (sel.selecting) pageBox.current?.focus(); }, [sel.selecting]);

  function open(which: 'move' | 'delete', reason: string | null) {
    if (reason || busy) return;
    done.current = false;
    setDialog(which);
  }
  /** After a successful OK (spec §1.6): selecting ends, the dialog closes, the library refreshes. */
  function finished() {
    done.current = true;
    setDialog(null);
    sel.end();
    router.refresh();
  }
  const finalFocusFor = (opener: RefObject<HTMLButtonElement | null>) => (): HTMLElement | null =>
    done.current ? sel.focusTarget() : opener.current;

  return (
    <>
      <div
        role="region"
        aria-label="Selected titles"
        data-testid="library-selection-bar"
        hidden={!sel.selecting}
        className="sticky top-0 z-20 mx-4 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-(--ink) px-4 py-2 text-[13px] text-(--surface) sm:mx-7"
      >
        <label className="flex min-h-11 cursor-pointer items-center gap-2 font-semibold sm:min-h-[30px]">
          <PageSelectBox testId="library-select-page" onInk inputRef={pageBox} />
          All on this page
        </label>
        <span role="status" aria-live="polite" data-testid="library-selection-count" className="min-w-0 flex-1 font-semibold">
          {countText(n)}
          {off > 0 && <span data-testid="library-selection-offpage">{offPageText(off)}</span>}
        </span>
        <div className="flex w-full gap-2 sm:w-auto">
          <button ref={moveRef} type="button" data-testid="library-bulk-move" className={PLAIN}
                  aria-disabled={moveReason || busy ? 'true' : undefined} title={moveReason ?? undefined}
                  onClick={() => open('move', moveReason)}>
            Move to collection…
          </button>
          <button ref={deleteRef} type="button" data-testid="library-bulk-delete" className={DANGER}
                  aria-disabled={deleteReason || busy ? 'true' : undefined} title={deleteReason ?? undefined}
                  onClick={() => open('delete', deleteReason)}>
            Delete…
          </button>
          <button type="button" data-testid="library-selection-cancel" className={PLAIN}
                  aria-disabled={busy || undefined} onClick={() => { if (!busy) sel.cancel(); }}>
            Cancel
          </button>
        </div>
      </div>
      <BulkMoveDialog
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        ids={ids}
        collectionId={collectionId}
        collectionName={collectionName}
        targets={targets}
        busy={busy}
        setBusy={setBusy}
        onMoved={finished}
        finalFocus={finalFocusFor(moveRef)}
      />
    </>
  );
}
```

(Until Task 5 the Delete… button opens nothing; Task 5 adds its dialog here.)

- [ ] **Step 6: Put the bar on the page**

In `src/app/(app)/library/page.tsx`, add `import { LibrarySelectionBar } from '@/components/library/library-selection-bar';`
to the imports, and as the first child of `<SelectionScope className="min-w-0 flex-1">` (before `{showOverview`) add:

```tsx
            {canSelect && (
              <LibrarySelectionBar collectionId={filteredCollectionId}
                                   collectionName={view.kind === 'collection' ? heading : null} />
            )}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/library-selection.test.ts` → PASS; `npx tsc --noEmit` → clean.
Run: `time PORT=3100 npx playwright test e2e/library-multi-select.spec.ts --project=desktop -g "MS-0[5-8]"` → 4 passed.
Then `-g "MS-0[1-4]"` → 4 passed (the bar sits above the grid now).

- [ ] **Step 8: The gates and the commit**

Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint; echo "exit $?"` → green; lint
`✖ 12 problems (0 errors, 12 warnings)`, `exit 0`. Then
`time PORT=3100 npx playwright test e2e/library-table.spec.ts e2e/states.spec.ts e2e/breadcrumb.spec.ts --project=desktop` → all pass.

```bash
git status --short
git add src/lib/library-selection.ts src/lib/library-selection.test.ts src/components/library/library-selection-bar.tsx \
  src/components/library/bulk-move-dialog.tsx "src/app/(app)/library/page.tsx" e2e/library-multi-select.spec.ts
git commit -m "Multi-select: the sticky selection bar and the Move to collection dialog

Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 5: The Delete dialog: the preview, the kept titles, the OK, the help paragraph

**Files:**
- Modify: `src/lib/library-selection.ts` + `.test.ts` (append the delete words)
- Create: `src/components/library/bulk-delete-dialog.tsx`
- Modify: `src/components/library/library-selection-bar.tsx` (the Delete dialog)
- Modify: `src/lib/help/topics.tsx` (the `library` topic's Sources comment and body), `src/lib/help/topics.test.ts`
- Modify: `e2e/library-multi-select.spec.ts` (MS-09 … MS-14)

**Interfaces:**
- Consumes: `BulkDeletePreview`, `BulkDeleteResult` (types, `@/lib/disk-delete`), `KeptTitle`, `HoldWhere` (types,
  `@/lib/bulk-delete-plan`) (Task 1); `titlesWord`, `disksWord` (Task 2); the bar's `open`, `deleteRef`, `busy`,
  `setBusy`, `finished`, `finalFocusFor`, `ids` (Task 4); `Modal`; `pairDevice`, `authHeader` (`e2e/device-helpers.ts`).
- Produces: `holdText(h: HoldWhere): string`, `keptLine(k: KeptTitle): string`, `keptIntro(n: number): string`,
  `deleteToast(r: BulkDeleteResult): { title: string; description: string | undefined }`, `NOTHING_TO_DELETE`;
  `BulkDeleteDialog(props)` with
  `{ open: boolean; onClose: () => void; ids: string[]; busy: boolean; setBusy: (b: boolean) => void; onDeleted: () => void; finalFocus: () => HTMLElement | null }`.

**Plan ruling** (spec §2.2 "offers a **Try again** button"): the button gets `data-testid="bulk-delete-retry"`
(not in §9), so the failed-preview test can press it.

**Plan ruling** (spec §7 "gains one paragraph on selecting titles"): the `library` topic's body is 260 words today
(measured with the test's own `bodyText`), and `topics.test.ts` caps every body at 280. The paragraph is therefore 20
words, and the test still passes at exactly 280.

**Plan ruling** (spec §2.2 "On open it previews"): every open mounts a fresh dialog (`key` bumped by the opener), so its
preview state starts at "Checking the drives…" without an effect setting state; the fetch runs in an effect with an
`AbortController` and sets state only after it answers.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/library-selection.test.ts` (and add `deleteToast`, `keptIntro`, `keptLine` to its import list):

```ts
describe('delete words (spec §2.2, §2.3)', () => {
  const kept = { id: 'k', title: 'Turrican', holds: [{ deviceName: 'A500', drive: 'DF0' as const, label: 'In A500' },
    { deviceName: 'A1200', drive: 'DF1' as const, label: 'In A1200' }] };
  it('a kept title says where it is, drive by drive', () => {
    expect(keptLine(kept)).toBe('Turrican — In A500 (DF0) · In A1200 (DF1)');
    expect(keptIntro(1)).toBe('1 title is in a drive and will be kept:');
    expect(keptIntro(2)).toBe('2 titles are in a drive and will be kept:');
  });
  it('the toast counts what went, and says what was kept, already gone or ejected', () => {
    const base = { deleted: ['a', 'b'], diskIds: [], kept: [], missing: [], ejected: [], releasedSha256: [] };
    expect(deleteToast(base)).toEqual({ title: 'Deleted 2 titles', description: undefined });
    expect(deleteToast({ ...base, kept: [kept, { ...kept, id: 'l', title: 'Lotus II' }], missing: ['m'], ejected: ['A500'] })).toEqual({
      title: 'Deleted 2 titles',
      description: 'Kept 2 that are in a drive: Turrican, Lotus II. 1 was already gone. Ejected from A500.',
    });
  });
});
```

In `src/lib/help/topics.test.ts`, after the test `library describes the table: …` add:

```ts
  it('library describes selecting: the toggle, nothing until you confirm, titles in a drive kept (multi-select 2026-10-26)', () => {
    const b = bodyText('library').replace(/\s+/g, ' ');
    for (const w of ['Select titles', 'move or delete', 'nothing changes until you confirm', 'in a drive are kept']) expect(b).toContain(w);
  });
```

Append to `e2e/library-multi-select.spec.ts` (and add `pairDevice, authHeader` to its `./device-helpers` import, plus
`import { eq } from 'drizzle-orm'; import { getDb } from '@/db'; import { devices } from '@/db/schema/devices';` at the top):

```ts
const confirmDelete = (page: Page) => page.getByTestId('bulk-delete-confirm');
async function openDelete(page: Page) {
  await page.getByTestId('library-bulk-delete').click();
  await expect(page.getByTestId('bulk-delete-dialog')).toBeVisible();
}

test('MS-09 table, Delete: the preview counts, OK removes the rows, focus goes to the toggle', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Del', 3);
  await page.goto('/library?view=table');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(row(page, a.gameId)).click();
  await boxOf(row(page, b.gameId)).click();
  await openDelete(page);
  const dlg = page.getByTestId('bulk-delete-dialog');
  await expect(dlg).toContainText('Delete titles?');
  await expect(dlg).toContainText('2 titles and their 2 disks will be removed from your library.');
  await expect(page.getByTestId('bulk-delete-list')).toContainText(a.title);
  await expect(page.getByTestId('bulk-delete-list')).toContainText(b.title);
  await expect(page.getByTestId('bulk-delete-kept')).toHaveCount(0);
  await expect(dlg).toContainText('The disk image itself is kept if anyone else has the same one.');
  await expect(dlg).not.toContainText('ejected');
  await expect(confirmDelete(page)).toHaveText('Delete 2 titles');
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 2 titles')).toBeVisible();
  await expect(dlg).toBeHidden();
  await expect(row(page, a.gameId)).toHaveCount(0);
  await expect(row(page, b.gameId)).toHaveCount(0);
  await expect(row(page, c.gameId)).toBeVisible();
  await expect(toggle(page)).toBeFocused();
});

test('MS-10 keyboard only: Tab to a box, Space, Delete…, Escape closes the dialog and focus returns to Delete…', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await seedTitles(orgId, 'Keys', 2);
  await page.goto('/library');
  await hydrated(page, 'library-select-toggle');
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('library-select-page')).toBeFocused();
  // All on this page, Move…, Delete…, Cancel, then the first title's box.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  await expect(page.getByTestId('select-title').first()).toBeFocused();
  await page.keyboard.press('Space');
  await expect(count(page)).toHaveText('1 title selected');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('library-bulk-delete')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('bulk-delete-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bulk-delete-dialog')).toBeHidden();
  await expect(page.getByTestId('library-bulk-delete')).toBeFocused();
  await expect(bar(page)).toBeVisible();   // Review Focus 2: only the dialog closed
  await expect(count(page)).toHaveText('1 title selected');
});

test('MS-11 a title in a drive is kept: the preview says where, OK deletes only the rest, the board is not ejected', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const [held, free] = await seedTitles(orgId, 'Held', 2);
  const board = await pairDevice(page, request, 'Bench MS');
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId: held.diskId } });
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: held.sha, mountedDiskId: held.diskId, version },
  })).status()).toBe(204);

  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, held.gameId)).click();
  await openDelete(page);
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('Nothing to delete: every selected title is in a drive. Eject it there first.');
  await expect(confirmDelete(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('bulk-delete-cancel').click();

  await boxOf(card(page, free.gameId)).click();
  await openDelete(page);
  await expect(page.getByTestId('bulk-delete-kept')).toContainText('1 title is in a drive and will be kept:');
  await expect(page.getByTestId('bulk-delete-kept')).toContainText(`${held.title} — In Bench MS (DF0)`);
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('1 title and its 1 disk will be removed from your library.');
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');
  await confirmDelete(page).click();
  await expect(page.getByText(`Kept 1 that is in a drive: ${held.title}.`)).toBeVisible();
  await expect(card(page, free.gameId)).toHaveCount(0);
  await expect(card(page, held.gameId)).toBeVisible();
  const [row0] = await getDb().select({ d: devices.desiredDiskId }).from(devices).where(eq(devices.id, board.deviceId));
  expect(row0.d).toBe(held.diskId);
});

test('MS-12 deleting every title of the view puts focus on the h1, never on the page body', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await seedTitles(orgId, 'Last', 2);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'library-select-page', 'onChange');
  await page.getByTestId('library-select-page').click();
  await openDelete(page);
  await expect(confirmDelete(page)).toHaveText('Delete 2 titles');
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 2 titles')).toBeVisible();
  await expect(page.getByTestId('game-grid')).toHaveAttribute('data-empty', 'library');
  await expect(toggle(page)).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});

test('MS-13 a dropped connection on OK keeps the dialog and the selection, and a second press works', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b] = await seedTitles(orgId, 'Drop', 2);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await openDelete(page);
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');   // the preview has answered
  await page.route('**/api/games/bulk', (r) => r.abort('failed'));
  await confirmDelete(page).click();
  await expect(page.getByText('Could not reach the server')).toBeVisible();
  await expect(page.getByText('Trying again is safe.')).toBeVisible();
  await expect(page.getByTestId('bulk-delete-dialog')).toBeVisible();
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');
  await expect(confirmDelete(page)).not.toHaveAttribute('aria-disabled', /.*/);
  await page.unroute('**/api/games/bulk');
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 1 title')).toBeVisible();
  await expect(card(page, a.gameId)).toHaveCount(0);
  await expect(card(page, b.gameId)).toBeVisible();
});

test('MS-14 a failed preview deletes nothing and offers Try again', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'Retry', 1);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await page.route('**/api/games/bulk', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await openDelete(page);
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('Could not check the drives.');
  await expect(confirmDelete(page)).toHaveAttribute('aria-disabled', 'true');
  await page.unroute('**/api/games/bulk');
  await page.getByTestId('bulk-delete-retry').click();
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('1 title and its 1 disk will be removed from your library.');
  await page.getByTestId('bulk-delete-close').click();
  await expect(page.getByTestId('library-bulk-delete')).toBeFocused();
  await page.reload();
  await expect(card(page, a.gameId)).toBeVisible();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/library-selection.test.ts src/lib/help/topics.test.ts` → FAIL
(`deleteToast` not exported; the help words missing).
Run: `time PORT=3100 npx playwright test e2e/library-multi-select.spec.ts --project=desktop -g "MS-09|MS-1"` → 6 failed
(no `bulk-delete-dialog`).

- [ ] **Step 3: The delete words**

Append to `src/lib/library-selection.ts` (and add `import type { BulkDeleteResult } from '@/lib/disk-delete';` and
`import type { HoldWhere, KeptTitle } from '@/lib/bulk-delete-plan';` under the existing `import type` lines):

```ts
export const NOTHING_TO_DELETE = 'Nothing to delete: every selected title is in a drive. Eject it there first.';
export const holdText = (h: HoldWhere) => `${h.label} (${h.drive})`;
/** "Turrican — In A500 (DF0)": the kept line, in holdLabel's words, so the person knows what to eject (spec §2.2). */
export const keptLine = (k: KeptTitle) => `${k.title} — ${k.holds.map(holdText).join(' · ')}`;
export const keptIntro = (n: number) => `${titlesWord(n)} ${n === 1 ? 'is' : 'are'} in a drive and will be kept:`;

/** The Delete toast (spec §2.3). */
export function deleteToast(r: BulkDeleteResult): { title: string; description: string | undefined } {
  const parts: string[] = [];
  if (r.kept.length > 0) {
    parts.push(`Kept ${r.kept.length} that ${r.kept.length === 1 ? 'is' : 'are'} in a drive: ${r.kept.map((k) => k.title).join(', ')}.`);
  }
  if (r.missing.length > 0) parts.push(`${wasWere(r.missing.length)} already gone.`);
  if (r.ejected.length > 0) parts.push(`Ejected from ${r.ejected.join(', ')}.`);
  return { title: `Deleted ${titlesWord(r.deleted.length)}`, description: parts.length > 0 ? parts.join(' ') : undefined };
}
```

- [ ] **Step 4: The Delete dialog**

Create `src/components/library/bulk-delete-dialog.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import type { BulkDeletePreview, BulkDeleteResult } from '@/lib/disk-delete';
import { NOTHING_TO_DELETE, deleteToast, disksWord, keptIntro, keptLine, titlesWord } from '@/lib/library-selection';

const FOOT_PLAIN = 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60';
const FOOT_DANGER = 'h-[38px] rounded-[10px] bg-(--danger-fg) px-4 text-[13px] font-semibold text-white aria-disabled:opacity-50';

type Preview = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: BulkDeletePreview };

/**
 * Delete, for a selection (spec §2.2, Rulings 12, 13, 14): on open it previews through the same route (`dryRun`),
 * which changes nothing and covers the titles on other pages too. Titles a board holds are KEPT and named with where
 * they are; the confirm counts only the rest. OK sends the whole selection again and the server re-decides, so a
 * stale preview can never delete a disk mounted since.
 *
 * Mounted fresh on every open (the bar bumps its key), so the preview starts at "Checking the drives…" without an
 * effect setting state; the fetch sets state only after it answers. Busy as in the Move dialog (Ruling 16).
 */
export function BulkDeleteDialog({ open, onClose, ids, busy, setBusy, onDeleted, finalFocus }: {
  open: boolean;
  onClose: () => void;
  ids: string[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDeleted: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const guard = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    void (async () => {
      let next: Preview = { state: 'failed' };
      try {
        const res = await fetch('/api/games/bulk', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'delete', gameIds: ids, dryRun: true }), signal: ctl.signal,
        });
        if (res.ok) next = { state: 'ready', data: await res.json() as BulkDeletePreview };
      } catch {
        // A dropped connection, or this effect cleaned up: "Could not check the drives." unless aborted.
      } finally {
        if (!ctl.signal.aborted) setPreview(next);
      }
    })();
    return () => ctl.abort();
  }, [open, attempt, ids]);

  const deletable = preview.state === 'ready' ? preview.data.deletable.titles : 0;
  const off = busy || deletable === 0;

  function close() { if (!busy) onClose(); }

  async function confirm() {
    if (off || guard.current) return;
    guard.current = true;
    setBusy(true);
    try {
      const res = await fetch('/api/games/bulk', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'delete', gameIds: ids }),
      });
      if (!res.ok) {
        toast.error('Could not delete the titles', { description: `The server answered ${res.status}.` });
        return;
      }
      const t = deleteToast(await res.json() as BulkDeleteResult);
      toast.success(t.title, t.description ? { description: t.description } : undefined);
      onDeleted();
    } catch {
      toast.error('Could not reach the server', { description: 'Trying again is safe.' });
    } finally {
      setBusy(false);
      guard.current = false;
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) close(); }}
      width={440}
      testId="bulk-delete-dialog"
      closeTestId="bulk-delete-close"
      title="Delete titles?"
      dismissible={!busy}
      initialFocus={cancelRef}
      finalFocus={finalFocus}
      footer={(
        <div className="flex w-full items-center justify-end gap-2.5">
          <button ref={cancelRef} type="button" data-testid="bulk-delete-cancel" aria-disabled={busy || undefined}
                  onClick={close} className={FOOT_PLAIN}>
            Cancel
          </button>
          <button type="button" data-testid="bulk-delete-confirm" aria-disabled={off || undefined}
                  onClick={() => { if (!off) void confirm(); }} className={FOOT_DANGER}>
            {busy ? 'Deleting…' : `Delete ${titlesWord(deletable)}`}
          </button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3 px-6 py-5 text-[14px] text-(--muted)">
        {preview.state === 'loading' && <p role="status">Checking the drives…</p>}
        {preview.state === 'failed' && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert">Could not check the drives.</p>
            <button type="button" data-testid="bulk-delete-retry" className={FOOT_PLAIN}
                    onClick={() => { setPreview({ state: 'loading' }); setAttempt((n) => n + 1); }}>
              Try again
            </button>
          </div>
        )}
        {preview.state === 'ready' && (
          <>
            {deletable === 0
              ? <p className="text-(--ink)">{NOTHING_TO_DELETE}</p>
              : (
                <p>
                  <strong className="text-(--ink)">{titlesWord(deletable)}</strong> and {deletable === 1 ? 'its' : 'their'}{' '}
                  <strong className="text-(--ink)">{disksWord(preview.data.deletable.disks)}</strong> will be removed from your library.
                </p>
                )}
            {preview.data.titles.length > 0 && (
              <ul data-testid="bulk-delete-list" className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto text-[13px]">
                {preview.data.titles.map((t) => (
                  <li key={t.id} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate text-(--ink)">{t.title}</span>
                    <span className="shrink-0 font-mono text-[12px]">{t.year ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.data.kept.length > 0 && (
              <div data-testid="bulk-delete-kept" className="flex flex-col gap-1 text-[13px]">
                <p className="font-semibold text-(--ink)">{keptIntro(preview.data.kept.length)}</p>
                <ul className="flex flex-col gap-0.5">
                  {preview.data.kept.map((k) => <li key={k.id}>{keptLine(k)}</li>)}
                </ul>
              </div>
            )}
            <ul className="flex flex-col gap-1 text-[12.5px]">
              {/* Not "Any device holding it will be ejected": a held title is kept (Ruling 12). */}
              <li>The disk image itself is kept if anyone else has the same one.</li>
              <li>You can upload it again.</li>
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: Wire it into the bar**

In `src/components/library/library-selection-bar.tsx`:

Add `import { BulkDeleteDialog } from './bulk-delete-dialog';` to the imports.

After `const [busy, setBusy] = useState(false);` add `const [deleteOpens, setDeleteOpens] = useState(0);`.

Replace `open` with:

```tsx
  function open(which: 'move' | 'delete', reason: string | null) {
    if (reason || busy) return;
    done.current = false;
    // A fresh Delete dialog per open: its preview starts again from "Checking the drives…".
    if (which === 'delete') setDeleteOpens((n) => n + 1);
    setDialog(which);
  }
```

After the `<BulkMoveDialog … />` element add:

```tsx
      <BulkDeleteDialog
        key={deleteOpens}
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        ids={ids}
        busy={busy}
        setBusy={setBusy}
        onDeleted={finished}
        finalFocus={finalFocusFor(deleteRef)}
      />
```

and delete the line `(Until Task 5 the Delete… button opens nothing; Task 5 adds its dialog here.)` if it was copied
into the file.

- [ ] **Step 6: The help paragraph**

In `src/lib/help/topics.tsx`, in the `library` topic's Sources comment (line 27, which ends `library-table.ts (folders
on page 1 only).`) append ` Selecting: select-toggle.tsx, library-selection-bar.tsx, bulk-*-dialog.tsx,
bulk-delete-plan.ts (held titles kept).` and, after the `<strong>Filing.</strong>` paragraph's closing `</p>`, add:

```tsx
        <p>
          <strong>Selecting.</strong> <em>Select titles</em> ticks titles to move or delete; nothing changes until you
          confirm. Titles in a drive are kept.
        </p>
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/library-selection.test.ts src/lib/help/topics.test.ts` → PASS (the
`library: a body of roughly 80-200 words` test included; if it reports 281 or more, the paragraph was typed with an
extra word — compare it with Step 6 character by character).
Run: `npx tsc --noEmit` → clean.
Run: `time PORT=3100 npx playwright test e2e/library-multi-select.spec.ts --project=desktop -g "MS-09|MS-1"` → 6 passed.

- [ ] **Step 8: The gates, the help regression and the commit**

Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint; echo "exit $?"` → green; lint
`✖ 12 problems (0 errors, 12 warnings)`, `exit 0`. Then
`time PORT=3100 npx playwright test e2e/help.spec.ts e2e/delete-disk.spec.ts --project=desktop` → all pass (the single
delete dialog is untouched).

```bash
git status --short
git add src/lib/library-selection.ts src/lib/library-selection.test.ts src/components/library/bulk-delete-dialog.tsx \
  src/components/library/library-selection-bar.tsx src/lib/help/topics.tsx src/lib/help/topics.test.ts \
  e2e/library-multi-select.spec.ts
git commit -m "Multi-select: the Delete dialog -- a preview that names titles in a drive, OK deletes the rest, focus never on body

Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 6: The phone (390): the toggle, the two-line bar, 44 px targets, a full-screen dialog, taps

**Files:**
- Create: `e2e/library-multi-select.mobile.spec.ts`
- Modify (only if Step 2 names it): `src/components/library/library-selection-bar.tsx`, `select-toggle.tsx`,
  `game-grid.tsx`, `game-table.tsx`

**Interfaces:**
- Consumes: every test id of Tasks 2–5; `hydrated`, `seedDisk`, `cleanupSeeded` (`e2e/device-helpers.ts`);
  `signUpFresh`, `runTag` (`e2e/helpers.ts`).
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the mobile spec**

Create `e2e/library-multi-select.mobile.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded, hydrated } from './device-helpers';

// Library multi-select at 390 (spec §6, Ruling 20; §8 e2e 8). The mobile project emulates touch: tap, never hover.
test.describe.configure({ timeout: 120_000 });
test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(`multisel-m-${s}`).digest('hex');
async function seedTitles(orgId: string, prefix: string, n: number) {
  const run = runTag();
  const out: { gameId: string; title: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const title = `${prefix} ${String(i).padStart(2, '0')} ${run}`;
    const { gameId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`${run}-${prefix}-${i}`) });
    out.push({ gameId, title });
  }
  return out;
}
const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;

test('MS-M1 at 390: a 44 x 40 toggle, the bar on two lines with 44 px buttons, nothing sideways, a full-screen dialog', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'Phone', 2);
  await page.goto('/library');
  const t = await box(page, 'library-select-toggle');
  expect([Math.round(t.width), Math.round(t.height)]).toEqual([44, 40]);

  await hydrated(page, 'library-select-toggle');
  await page.getByTestId('library-select-toggle').tap();
  await expect(page.getByTestId('library-selection-bar')).toBeVisible();
  const all = await box(page, 'library-select-page');
  const buttons = await Promise.all(['library-bulk-move', 'library-bulk-delete', 'library-selection-cancel'].map((id) => box(page, id)));
  for (const b of buttons) {
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(Math.round(b.y)).toBe(Math.round(buttons[0].y));   // one line of three
    expect(b.y).toBeGreaterThan(all.y + all.height);           // below "All on this page": the second line
  }
  const bar = await box(page, 'library-selection-bar');
  expect(bar.x).toBeGreaterThanOrEqual(16);
  expect(bar.x + bar.width).toBeLessThanOrEqual(390 - 16);
  await noSideways(page);

  // A tap on the card ticks it.
  await hydrated(page, 'select-title', 'onChange');
  const card = page.locator(`[data-testid="game-card"][data-game-id="${a.gameId}"]`);
  await card.tap();
  await expect(card).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('library-selection-count')).toHaveText('1 title selected');

  // The dialog is full screen below sm.
  await page.getByTestId('library-bulk-delete').tap();
  const d = await box(page, 'bulk-delete-dialog');
  expect([Math.round(d.x), Math.round(d.y), Math.round(d.width), Math.round(d.height)]).toEqual([0, 0, 390, 844]);
  const confirm = await box(page, 'bulk-delete-confirm');
  expect(confirm.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('bulk-delete-close').tap();
  await expect(page.getByTestId('bulk-delete-dialog')).toBeHidden();
  await noSideways(page);
});

test('MS-M2 at 390 the table row is four tracks with the box first; a tap ticks; the facts line stays', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'PhoneRow', 2);
  await page.goto('/library?view=table');
  await hydrated(page, 'library-select-toggle');
  await page.getByTestId('library-select-toggle').tap();
  const row = page.locator(`[data-testid="game-row"][data-game-id="${a.gameId}"]`);
  await expect(row.locator('[data-meta]')).toBeVisible();
  const cols = await row.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(4);
  const rb = (await row.boundingBox())!;
  const bb = (await row.getByTestId('select-title').boundingBox())!;
  expect(bb.x - rb.x).toBeLessThan(28);
  expect(rb.height).toBeGreaterThanOrEqual(44);
  await hydrated(page, 'select-title', 'onChange');
  await row.tap();
  await expect(row).toHaveAttribute('data-selected', 'true');
  await noSideways(page);
});
```

- [ ] **Step 2: Run it**

Run: `time PORT=3100 npx playwright test e2e/library-multi-select.mobile.spec.ts --project=mobile` → 2 passed.
Expected to pass as built (Tasks 2–5 wrote the 390 sizes). If an assertion fails, fix it in the class that owns it,
never in the test, and record each fix in the report:

| Failing assertion | Owner and fix |
|---|---|
| toggle not 44 × 40 | `select-toggle.tsx`: the button's `h-10 w-11` (the `.seg` wrapper's padding is outside the button) |
| a bar button under 44 px | `library-selection-bar.tsx` `BTN`: `h-11` before `sm:h-[30px]` |
| the buttons not on one line below the select-all | the buttons' wrapper `w-full sm:w-auto` and each `flex-1` |
| bar inside 16 px gutters | the bar's `mx-4 sm:mx-7` |
| row tracks ≠ 4 | `game-table.tsx` `COLS_SELECT`'s base `grid-cols-[28px_40px_minmax(0,1fr)_44px]` |
| sideways scroll | the element whose `getBoundingClientRect().right` exceeds 390: find it with `page.evaluate` over `document.querySelectorAll('*')` and narrow its width with `min-w-0` / `truncate` |

- [ ] **Step 3: The phone regression**

Run: `time PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile --list`, then two `-g` halves
of at most 17 tests chosen from the listed titles → all pass. Then
`time PORT=3100 npx playwright test e2e/mobile.spec.ts e2e/help.mobile.spec.ts --project=mobile` → all pass.

- [ ] **Step 4: The gates and the commit**

Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint; echo "exit $?"` → green; lint
`✖ 12 problems (0 errors, 12 warnings)`, `exit 0`.

```bash
git status --short
git add e2e/library-multi-select.mobile.spec.ts
# plus any component Step 2 changed, by name
git commit -m "Multi-select: the phone at 390 -- the toggle, the two-line bar, 44 px targets, the full-screen dialog, taps

Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 7: Final pass: contrast, by-hand checks at 1280 and 390, every library, collections and table e2e in batches

**Files:**
- Modify: `e2e/contrast.spec.ts` (append one test)
- Create and delete (never committed): `e2e/zz-ms-shots.spec.ts`, `e2e/zz-ms-shots.mobile.spec.ts`

**Interfaces:**
- Consumes: every task's DOM; `legible()`, `ratio()` and the imports `contrast.spec.ts` already has (`signUpFresh`,
  `runTag`, `seedDisk`, `hydrated`, `createHash`).
- Produces: nothing later work uses.

- [ ] **Step 1: Write the contrast test**

Append to `e2e/contrast.spec.ts`:

```ts
// Library multi-select (spec §5): the bar's text on ink, the box ring (3:1 non-text) on its surface disc, and the
// ticked card's outline (3:1) against the page ground. The ring is --muted-2, not --line-strong (Plan ruling, Task 3).
test('MS-C1 the selection pairs: the bar on ink, the box ring on its disc, the selected outline on the ground', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const s1 = createHash('sha256').update(`ms-contrast-1-${tag}`).digest('hex');
  const s2 = createHash('sha256').update(`ms-contrast-2-${tag}`).digest('hex');
  const { gameId } = await seedDisk(orgId, { title: `Contrast sel ${tag.slice(-5)}`, diskNo: 1, sha256: s1 });
  await seedDisk(orgId, { title: `Contrast two ${tag.slice(-5)}`, diskNo: 1, sha256: s2 });
  // A collection to move to, so Move… is enabled (a disabled control is exempt and drawn at half opacity).
  expect((await page.request.post('/api/collections', { data: { name: `Contrast ${tag.slice(-5)}` } })).status()).toBe(200);
  await page.goto('/library');
  await hydrated(page, 'library-select-toggle');
  await page.getByTestId('library-select-toggle').click();
  await hydrated(page, 'select-title', 'onChange');
  await page.locator(`[data-testid="game-card"][data-game-id="${gameId}"] [data-testid="select-title"]`).click();
  await page.mouse.move(0, 0);
  await legible(page, 'select', [
    ['count on ink', '[data-testid="library-selection-count"]'],
    ['All on this page on ink', '[data-testid="library-selection-bar"] label'],
    ['Move… on its fill', '[data-testid="library-bulk-move"]'],
    ['Delete… on danger', '[data-testid="library-bulk-delete"]'],
    ['Cancel on its fill', '[data-testid="library-selection-cancel"]'],
  ]);
  const c = await page.evaluate((id) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const hex = (s: string) => { const h = s.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-testid="game-card"] [data-testid="select-title"]')];
    const unticked = boxes.find((b) => !b.checked)!;
    const disc = unticked.parentElement!.parentElement!;
    const card = document.querySelector<HTMLElement>(`[data-testid="game-card"][data-game-id="${id}"]`)!;
    return {
      ring: rgb(getComputedStyle(unticked).borderTopColor),
      disc: rgb(getComputedStyle(disc).backgroundColor),
      outline: rgb(getComputedStyle(card).outlineColor),
      ground: hex(getComputedStyle(document.documentElement).getPropertyValue('--ground')),
    };
  }, gameId);
  const ring = ratio(c.ring, c.disc);
  const outline = ratio(c.outline, c.ground);
  console.log(`select    box ring on its disc                  ${ring.toFixed(2)}:1`);
  console.log(`select    selected outline on the ground        ${outline.toFixed(2)}:1`);
  expect(ring).toBeGreaterThanOrEqual(3);
  expect(outline).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: Run it**

`time PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "MS-C1"` → 1 passed. Record the logged
ratios in the report (expected: the ring about 5.6:1, the outline about 14:1, the count about 15:1). A failed ratio is
fixed in the component's class toward a stronger token and reported as a Plan ruling — never by lowering the bar and
never by pointing a selector elsewhere.

- [ ] **Step 3: By hand, at 1280 and at 390**

On the dev server (3100), screenshots for the operator in the session scratchpad only (no email address, no real
board; the fake names are fine):

1. Write `e2e/zz-ms-shots.spec.ts` (desktop, 1280 × 800 via `page.setViewportSize`) and
   `e2e/zz-ms-shots.mobile.spec.ts` (390 × 844). Each signs up fresh, seeds four titles and one collection (the
   `seedTitles` and `makeCollection` helpers copied from `library-multi-select.spec.ts`), and shoots: the grid not
   selecting; the grid selecting with two ticked (the outline and the disc); the table selecting with one ticked; the
   bar with " · k on other pages" (24 a page, 26 titles, page 2); the Move dialog with a target picked; the Delete
   dialog's preview. Each call:
   `await page.screenshot({ path: '<scratchpad>/ms-shots/<width>-<name>.png', fullPage: false, mask: [page.locator('[data-testid="account-email"], [data-testid="admin-email"]')], maskColor: '#F6F2E9' });`
   (`<scratchpad>` is the absolute scratchpad directory of this session).
2. Run each once: `time PORT=3100 npx playwright test e2e/zz-ms-shots.spec.ts --project=desktop`, then
   `time PORT=3100 npx playwright test e2e/zz-ms-shots.mobile.spec.ts --project=mobile`.
3. Open every PNG. Confirm no email address is readable. Compare with the spec: the toggle directly before Grid/Table;
   the ink bar under the header, above the grid, sticky; the box in the cover's top-left corner on a surface disc, an
   empty ring when unticked; the ticked card outlined in ink; the table's leading track with the DiskIcon unmoved; at
   390 the bar on two lines, the buttons sharing the second line, the dialog full screen.
4. Keyboard at 1280 (in the shots spec or by `page.keyboard`): Tab from the toggle (Enter) through the bar into the
   grid; every control shows a focus ring; the order is All on this page → Move… → Delete… → Cancel → the first
   title's box.
5. Delete both files: `rm e2e/zz-ms-shots.spec.ts e2e/zz-ms-shots.mobile.spec.ts`; `git status --short e2e` must not
   list them. Record what each shot showed, and give the scratchpad path.

- [ ] **Step 4: The gates and the regression in batches**

The gates: `pnpm test --testTimeout=30000` (whole), `npx tsc --noEmit`, `pnpm lint; echo "exit $?"` →
`✖ 12 problems (0 errors, 12 warnings)` and `exit 0`; the DB pair:
`TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db --testTimeout=30000 src/lib/library-bulk.db.test.ts src/lib/library-bulk-late.db.test.ts` → PASS.

The words: `grep -n "Select titles\|selecting" README.md docs/*.md` — reword a README or `docs/*.md` line only if it
describes the library header or the card controls wrongly now; expected: no hit needs a change.

Every library, collections and table spec, ONE run at a time, each timed and under 9 minutes, `--list` first so every
file is covered whole:

1. `e2e/library-multi-select.spec.ts --project=desktop`: `--list` → 14 tests. Then `-g "MS-0[1-4]"` → 4 passed;
   `-g "MS-0[5-8]"` → 4 passed; `-g "MS-09|MS-1"` → 6 passed.
2. `time PORT=3100 npx playwright test e2e/library-multi-select.mobile.spec.ts --project=mobile` → 2 passed.
3. `time PORT=3100 npx playwright test e2e/library.spec.ts e2e/library-a3.spec.ts e2e/library-table.spec.ts e2e/library-type-column.spec.ts --project=desktop` → all pass.
4. `time PORT=3100 npx playwright test e2e/library-mount.spec.ts e2e/library-covers.spec.ts e2e/nfc-fob-button.spec.ts e2e/view-toggle.spec.ts e2e/states.spec.ts e2e/breadcrumb.spec.ts --project=desktop` → all pass.
5. `time PORT=3100 npx playwright test e2e/library-paging.spec.ts --project=desktop` (alone) → 8 passed.
6. `time PORT=3100 npx playwright test e2e/collections.spec.ts --project=desktop` (alone, about 5 min) → all pass.
7. `e2e/disk-sets.spec.ts --project=desktop`: `--list`, then two `-g` halves of at most 13 → all pass.
8. `time PORT=3100 npx playwright test e2e/delete-disk.spec.ts e2e/create-adf.spec.ts e2e/header-overlap.spec.ts e2e/help.spec.ts --project=desktop` → all pass.
9. `e2e/c5-layout.spec.ts --project=desktop`: `--list`, then halves of at most 17 → all pass.
10. `e2e/c7-phone.mobile.spec.ts --project=mobile`: `--list`, then halves of at most 17 → all pass; then
    `time PORT=3100 npx playwright test e2e/mobile.spec.ts e2e/help.mobile.spec.ts --project=mobile` → all pass.
11. `e2e/contrast.spec.ts --project=desktop`: `--list` (19 tests with MS-C1), then
    `-g "sign-in text|sign-up text|shell and an empty library|library card|admin sans subtitle|toast description|search panel metadata|header focus|Devices pairs"`,
    then `-g "Upload pairs|Disk files pairs|open popover|Settings pairs|Help pairs|Search panel pairs|Sign-in and Create account pairs|Admin pairs|phone shell pairs|C8-15|MS-C1"`
    → all pass; check that the two slices cover the listed count.

- [ ] **Step 5: Commit** — re-check `git status --short` (the shots specs must be gone), then:

```bash
git add e2e/contrast.spec.ts
git commit -m "Multi-select: the selection pairs measured; the final library, collections and table regression

Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

(Add a `README.md` or `docs/*.md` file only if Step 4's grep changed it. The HANDOFF entry, with the Rulings, the Plan
rulings and the operator questions on Rulings 8 and 12, is the controller's after the merge, not this task's. The spec's
§12 item 6, a whole-branch review, is the controller's too.)

---

## Self-review (against the spec)

- §0 measured facts → Tech Stack (search-param navigation keeps state: true; Activity: not on in this app, measured,
  Plan ruling in Task 2). Single delete and single move unchanged (no task edits `deleteGame`, `title-menu.tsx`,
  `move-to-collection.tsx`, `delete-disk-dialog.tsx`).
- §1.1 toggle → Task 2 (`SelectToggle`, before `ViewToggle`, `ListChecks` 16 px, `aria-pressed`, title, sizes, only
  with titles; MS-01). Focus to "All on this page" → Task 4 bar effect (MS-05). Pressed again = Cancel → Task 2
  (MS-01). Escape → Task 2 `SelectionScope` (MS-08 from the bar; MS-07 / MS-10 prove it never fires in a dialog).
- §1.2 checkboxes → Task 3 (`SelectBox` on a surface disc top-left, both states, outline + `data-selected`; table
  `COLS_SELECT` both widths, header box, folder/up rows empty cell, ⋯ track kept; real inputs inside a `<label>`
  root, never an anchor; MS-02, MS-03, MS-M2).
- §1.3 bar → Task 4 (region, ink, sticky, margins, select-all with indeterminate and cap, count status + off-page,
  Move… / Delete… / Cancel with reasons, 30 / 44 px, two lines below sm; MS-05, MS-08, MS-M1).
- §1.4 while selecting → Task 3 (click toggles, drag `disabled`, controls → spacer, rename plain, ring and pill and
  `HoldsLabel` stay; rail live; MS-02's drag). §1.5 scope → Task 2 reducer + provider (view key in render, kept on
  page / view / sort / refresh, cleared on leaving, no cross-page select-all; MS-04). Missing titles at OK → Task 1
  `missing` + Task 4/5 toasts.
- §1.6 Cancel and OK → Tasks 4, 5 (nothing sent before a confirm, MS-05's request count; dialog Cancel keeps the
  selection and returns focus to the opener; success ends, toasts, refreshes, focuses the toggle or the h1; MS-06,
  MS-09, MS-12).
- §2.1 Move → Task 4 (subtitles, radiogroup without the current collection or Uncategorized, nothing preselected,
  "Make a collection first", confirm label and `aria-disabled`, `from` only inside a collection; MS-06, MS-07).
  §2.2 Delete → Task 5 (preview on open, loading / failed + Try again / ready, counts, list `max-h-[40vh]`, kept lines
  in `holdLabel` words, the two kept bullets without the eject line, confirm counts deletable, all-held message, OK
  sends the whole selection; MS-09, MS-11, MS-14). §2.3 → `moveToast`, `deleteToast`, the error toasts (unit tests,
  MS-13). §2.4 busy → both dialogs (aria-disabled + ref guard, `dismissible={!busy}`, try/catch/finally, bar buttons
  `aria-disabled` while busy, "Moving…" / "Deleting…"; MS-07's dblclick, MS-13).
- §3 API → Task 1 (schema verbatim, `requireOrg`, `invalid_json` / `invalid_body` / `same_collection` / 404, dedupe,
  one org-scoped read per id list, collections proven by `orgFilter`; move in one transaction with appended sort keys
  and ON CONFLICT; delete read → plan → dryRun / safety net → one transaction → union release; codes per §3.4).
- §4 states → Tasks 2–5 (each row of the table has an assertion: MS-01, MS-05, MS-02/03, the cap in unit tests,
  MS-06, MS-11/14, MS-07/13, MS-01's empty and overview cases).
- §5 accessibility → names (Task 3 Plan ruling), keyboard (MS-10), live region (Task 4 Plan ruling, the preview's own
  status), focus (MS-05/06/07/09/10/12), contrast (Task 7 MS-C1, Task 3 Plan ruling on the ring), no `sr-only` with a
  layout utility (none added).
- §6 phone → Task 6 (MS-M1, MS-M2) on sizes written in Tasks 2–4. §7 self-host → Global Constraints; help paragraph →
  Task 5 (Plan ruling on the word cap). §8 tests → unit (Task 1 planner, Task 2 reducer, Tasks 4/5 words), DB
  (Task 1, including the foreign-id and held-title tests and Review Focus 1), route (Task 1), e2e 1–8 → MS-05, MS-06,
  MS-07, MS-09, MS-04 (+ MS-08), MS-02, MS-10, MS-M1. §9 test ids → Global Constraints; kept ids unchanged while not
  selecting (Task 3 keeps every `<Link>`). §10 no migration → Global Constraints. §11 → nothing out of scope built.
- **Plan rulings to relay:** the Activity measurement and the kept cleanup (2); the reducer in `src/lib` (2);
  `canSelect` gates `selecting` (2); the ring `--muted-2` instead of `--line-strong` (3); `table-select-page` and its
  name (3); "Select Turrican, 1990" (3); the controls spacer (3); the bar always in the DOM, `hidden` (4); native radios
  (4); `bulk-delete-retry` (5); the 20-word help paragraph (5); a fresh Delete dialog per open (5); the safety net by
  disk id and unshared shas only (1); `getDb().transaction` for the move (1); "write sessions gone" unreachable (1);
  the late-holder test through `vi.mock` (1).
- Type consistency: `PlanGame`, `PlanDevice`, `PlanSession`, `HoldWhere`, `KeptTitle`, `BulkDeletePlan`,
  `planBulkDelete` (1) are used by `deleteGames` (1) and as types by `library-selection.ts` (5); `BulkDeletePreview`,
  `BulkDeleteResult`, `MoveResult` (1) are what the dialogs parse (4, 5); `SelectionState`, `SelectionAction`,
  `PageTitle`, `SelectedTitle`, `SELECTION_CAP`, `CAP_TITLE`, `pageCheck`, `canSelectPage`, `offPageCount`,
  `titlesWord`, `disksWord`, `countText`, `offPageText`, `viewKeyOf` (2) keep their names in 3–5;
  `LibrarySelection` with `selecting`, `selected`, `pageTitles`, `dispatch`, `toggleRef`, `start`, `cancel`, `end`,
  `focusTarget` (2) is used as defined in 3 and 4; `SelectBox`, `PageSelectBox({ testId, label, onInk, inputRef })`
  (3) are used by the table (3) and the bar (4); `TitleName({ plain })`, `TitleControls({ selecting })` (3);
  `moveToast` (4), `deleteToast`, `keptLine`, `keptIntro`, `holdText`, `NOTHING_TO_DELETE` (5); the bar's `open`,
  `finished`, `finalFocusFor`, `deleteRef`, `busy`, `setBusy`, `ids` (4) are what Task 5 wires. The e2e helpers
  `seedTitles`, `makeCollection`, `smallPages`, `bulkRequests`, `card`, `row`, `boxOf`, `toggle`, `bar`, `count`,
  `railRow`, `startSelecting` (2), `dragOnto` (3), `confirmDelete`, `openDelete` (5) are defined before first use.
- Review Focus → 1: Task 1 db test. 2: Task 4 MS-07, Task 5 MS-10. 3: Task 4 MS-07. 4: Task 5 MS-12. 5: Task 5 MS-13.
- Placeholder scan: every code step carries its code. Two steps decide by measurement with a stated rule rather than
  code: Task 6 Step 2 (a failing 390 assertion is fixed in the class its table names) and Task 7 Step 2 (a failing
  ratio moves the component to a stronger token, reported). Neither is open-ended.
