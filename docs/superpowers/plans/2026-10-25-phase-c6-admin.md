# Phase C6 Admin (Overview, Users, Invites, Scan, Firmware) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The five super-admin pages take the approved InfAdminOverview / InfAdminUsers / InfAdminInvites /
InfAdminScan / InfAdminFirmware layouts under the app's own header, with every guard, request, toast and pinned word
of the shipped plane kept, two additive reads (`adminCounts` gains `newestUserAt` and `blobsUnchecked`; the release
list gains an optional `show` filter), and `pnpm lint` at zero errors.

**Architecture:** Presentation and wiring on Phase B's tokens and C1–C5's pieces (`PageHeader size="lg"`, `.seg` /
`.seg-item`, `TopNav`, `SettingsLink`, `SignOutButton`, the shared `Modal`, `legible()`). Pure rules in new
client-safe files (`src/lib/admin-overview-look.ts`, `src/lib/admin-scan-look.ts`) and in `src/lib/admin-firmware.ts`
(`parseShow`, `firmwareHref`). New components: `AdminSections` (rewrites `src/components/admin/admin-nav.tsx`),
`AdminPageHead`, `PagerLink`, `InviteIssueProvider` + `NewInvitePanel`, `pageHeading()`. `PageHeader` gains
`subtitleFont` and a visible h1 ring. The user delete and Promote dialogs move onto `Modal`. No schema, no migration,
no new route, no new package.

**Tech Stack:** Next.js 16.3.2 App Router (before Task 1's `loading.tsx` read
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`; before Task 1's `metadata`
exports read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`; before Task 1's
layout edit read `.../03-file-conventions/layout.md`; before Task 6's `searchParams` change read
`.../03-file-conventions/page.md`), React 19, Tailwind v4, Base UI 1.7 (`@base-ui/react/dialog` through
`src/components/ui/modal.tsx`), drizzle-orm (node-postgres), vitest (`renderToStaticMarkup` render tests, node
environment — no DOM; `*.db.test.ts` under `pnpm test:db`), Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-10-25-phase-c6-admin-design.md` (binding; read it whole, including §13's task
split and the 39 Rulings). Where this plan resolves a spec gap it says so in a line starting **Plan ruling**; the
controller relays those to the operator.

## Global Constraints

- Texts, test ids and orders exactly as the spec writes them; every id in spec §10.1 keeps its name and meaning (each
  `count-*`, `scan-*`, `set-entries` still an element holding only the digits); ids move only as §10.4 says. New ids
  are §10.2's plus `fw-promote-done-close` (Plan ruling, Task 6) and the element ids `identity-heading`,
  `details-heading`, `demos-heading`, `dat-heading`, `openretro-heading`. The data attributes this plan names
  (`data-warn`, `data-attn`, `data-dist`, `data-admin-pill`, `data-users-foot`, `data-state`, `data-source`,
  `data-count-label`, `data-fw-part`, `data-fw-meta`, `data-skeleton-row`) are not test ids and carry no state of
  their own beyond what the visible words say.
- **The destructive guards are not weakened** (spec §0): user delete keeps a centered modal and the exact typed-email
  gate (`typed === email`, no trim, no case fold) and names the blast radius in numbers; Promote keeps its modal, the
  notes rule (`looksLikeTestBuild`, 1–2000 characters) and the server's checks; Revoke and Run now keep no confirm.
  `requireSuperAdmin()` stays in `(admin)/layout.tsx` and every `/api/admin` route. **Never weaken a super-admin guard
  or a guard test** (`admin-guard`, `admin-delete`, `admin-invites`, `admin-scan`, `admin-firmware`): if one fails,
  fix the product, not the test.
- Same requests, bodies and toasts word for word: `DELETE /api/admin/users/:id` (409 / error / success toasts),
  `POST /api/admin/invites`, `DELETE /api/admin/invites/:code` (409 refresh), `POST /api/admin/scan`,
  `POST /api/admin/tosec` (raw text, one file at a time), `POST /api/admin/openretro` (binary),
  `POST /api/admin/firmware/:id/promote` (`{notes}`, `redirect: 'manual'`, `SIGNED_OUT`, `errorText`).
- **No schema change, no DB migration.** If a task believes one is needed, STOP and report: a subagent never runs
  `drizzle-kit`, `pnpm db:migrate` or writes under `drizzle/`. Never migrate a database.
- Busy controls are `aria-disabled` + a guard in the handler, never native `disabled={busy}` (Chromium blurs a focused
  button the moment it becomes disabled, and focus falls to `<body>`). Native `disabled` stays only on the two
  not-armed gates spec §3.4 / §6.5 name (`Delete permanently`, `fw-promote-confirm`). Every request sits in
  try/catch/finally so a dropped connection never leaves a control busy. Focus never goes to `<body>`: a control that
  disappears hands focus to the page h1 (visible ring, Task 1).
- Colours only through tokens (spec §1.5's mapping, plus `--bar-ok` from Task 1) — no `#7A7262` / `#A39B8B` /
  `#F6F2E9` / `#EFE9DD` / `#B5541A` / `#4F9D4A` literals in components. Dark filled buttons carry the class
  `text-white` (globals.css' hover rule keys on it) with an inline `color: 'var(--surface)'`; the red
  `Delete permanently` keeps white text. A hover colour lives in a class, never only in an inline style (an inline
  colour beats the hover class).
- "Show both values of a state": every state renders a word in each value; an absent element never stands for one.
  No `sr-only` element carries a width or layout utility.
- In-app dialogs only; never `window.confirm` / `alert`.
- WCAG AA 4.5:1 for every text pair in spec §11, pinned in `src/lib/design-tokens.test.ts` and measured on the page in
  `e2e/contrast.spec.ts` with `legible()` (never lower 4.5, never point a selector at a different element to pass).
- Nothing scrolls the page sideways at 390 px (`document.documentElement.scrollWidth <= clientWidth`); the full phone
  pass is C7.
- Self-host parity: no new package, no external URL, no font; the GitHub release link stays
  `WEBADF_FIRMWARE_REPO`-driven.
- Firmware, `wifi-floppy/`, the board and the Amiga are not touched.
- Next.js 16.3: read the guide named in Tech Stack in `node_modules/next/dist/docs/` before writing a `loading.tsx`,
  a `metadata` export, a layout or a page's `searchParams`; heed deprecation notices.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): real `pnpm install --offline`, `.env.local` present
  (never print it, never `cat` it, never echo a value from it), `npx next typegen`, the `adf-archive` symlink.
- House rules, every task: stage files by name (`git add <path> …`, never `git add -A` / `git add .`, never anything
  under `wifi-floppy/` or `.superpowers/`); no `git stash` in any form; stop only your own PIDs, never pattern-kill;
  re-check `git status --short` before staging (other sessions change this tree).
- e2e: `PORT=3100 npx playwright test <file> --project=desktop|mobile`; the desktop project unless a step says mobile;
  ONE run at a time, in the foreground (never `run_in_background`), each command under 9 minutes (batches of about
  6 minutes, sized below from per-test times; split big files with `-g`). The e2e DB is the **live production DB**
  shared with other runs: assert relative to rows you made (fresh sign-ups, `runTag()`, fixed `0.0.0+e2e6x`
  versions), never absolute counts, and branch on live values the page itself shows (both values) where a state
  cannot be forced. Wait for hydration (`hydrated()` in `e2e/device-helpers.ts`, or a `toPass` retry where the
  control has no test id) before a synthetic event on a client control. `loading.tsx` makes `notFound()` pages HTTP
  200 — assert the not-found card, never a 404 status. Admin e2e sign in with `signInAsSuperAdmin()`
  (`e2e/admin-helpers.ts`).
- Every task's e2e list names every spec file that selects anything it changes (grepped for each changed test id and
  visible word; the lists below are that grep). A renamed visible word is grepped across the WHOLE repo (scripts,
  docs, CI, e2e), not only `e2e/` — the C5 bootstrap-log rename broke the docker smoke grep. This phase renames:
  `Issue invite` → `Issue an invite` (e2e only: `admin-invites.spec.ts:12`, `contrast.spec.ts:236`), the admin
  header's `Back to library` (no reader), the Users heads `Games` / `Devices` → `Titles` / `Boards`, `GitHub` →
  `GitHub release`, `Promote to release` → `Promote to release…`, `Delete` → `Delete…`, the scan notes and the TOSEC
  fetch line's `--` → `—`. `grep -rn` for each (excluding `node_modules`, `.next`, `docs/superpowers/`) found no
  reader outside the two e2e sites; re-run that grep in the task that renames and stop if it finds one.
- Unit and static checks: `pnpm test` (vitest), `npx tsc --noEmit`, `pnpm lint`. **Lint today:** `✖ 14 problems (2
  errors, 12 warnings)` — the two `react-hooks/purity` errors at `src/app/(admin)/admin/page.tsx:51` and
  `src/app/(admin)/admin/scan/page.tsx:167`. Task 1 fixes both (Ruling 3); from then on lint must read
  `✖ 12 problems (0 errors, 12 warnings)` and exit 0 — no new error, no new warning.
- DB tests: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db <file>` (a throwaway local Postgres in
  Docker; never the live DB). If Docker is not running, start Docker Desktop first; do not skip the db test.
- Whole `pnpm test` green before each commit; no commit after a red run. Every commit message ends with the two
  trailer lines `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`.

## Review Focus

1. **Promote while the list shows only Test builds** (`?show=test`): the refresh after a promote removes the row,
   and the dialog lives in that row, so the done text (the GitHub step the operator still has to run) would vanish
   unread. Under `show=test` the refresh waits for Close (`refreshOnDone={false}`); elsewhere it refreshes at once, as
   `admin-firmware.spec` pins. Pinned in Task 6's Promote test (run under `?show=test`).
2. **A dropped connection mid-request must not leave a control busy or drop focus** (Issue an invite, Revoke, Run
   now, Delete permanently, Promote, the two imports): try/catch/finally, `aria-disabled` while busy. Pinned in Task 4
   (Revoke with the route aborted: toast, `Revoke` again, no `aria-disabled`, focus still on it) and Task 3 (Delete
   with a 500: toast, dialog open, `Delete permanently` again).
3. **Focus after a control vanishes**: the deleted user's row, a revoked code's buttons and a promoted row's trigger
   all go with `router.refresh()`, which lands *after* the dialog has closed — a "trigger still in the document"
   check at close time finds it still there and focus then falls to `<body>`. Success is recorded in a ref and the h1
   is chosen (Plan ruling, Tasks 3, 4, 6). Pinned in Tasks 3, 4 and 6 (`h1` focused).
4. **The allowlisted admin's row**: its `Delete…` is `aria-disabled`; neither a click nor Enter opens the dialog
   (the server's 409 stays as the backstop). Pinned in Task 3 (forced click and Enter, no dialog).
5. **A hand-edited Firmware URL** (`?show=nope&page=999`, `?show=test&page=0`): `parseShow` reads anything unknown as
   `all`, `clampPage` clamps against the *filtered* count, the page is 200 with `Page M of M`. Pinned in
   `admin-firmware.test.ts` (Task 6, unit) and Task 6's filter e2e.

## Common commands

- Unit: `pnpm test <path>`; all: `pnpm test`; db: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db
  <path>`; types: `npx tsc --noEmit`; lint: `pnpm lint`.
- e2e desktop: `PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<title part>"]`. No admin
  spec is a `*mobile.spec.ts`, so `--project=mobile` runs none of them; the 390 px checks use `setViewportSize` in the
  desktop project (as C5 did).
- Screenshots: `PORT=3100 pnpm screenshots` (own config, 1440 × 900, own demo account; Task 7 only).
- Before each `-g` run, check with `npx playwright test e2e/<name>.spec.ts --project=desktop --list [-g "<pattern>"]`
  that the pattern selects what the step says. If a count differs, recount with `--list` before calling it a failure.
- Per-test times used to size the batches (measured on earlier runs): an admin sign-in ~4 s; an `admin-guard` /
  `admin-invites` / `admin-delete` / `admin-firmware` test 5–15 s; a `header-overlap` sweep 40–90 s; `admin-scan`'s
  "Run now" and "self-made" tests up to 280 s each (each gets its own run); a contrast screen test 15–40 s.

## File map

| File | Task | What |
|---|---|---|
| `src/app/(admin)/layout.tsx` | 1 | header: `TopNav showAdmin`, gear, Sign out; Back to library goes |
| `src/components/admin/admin-nav.tsx` + `admin-nav.test.ts` | 1 | rewritten: `AdminSections` |
| `src/components/admin/admin-page-head.tsx` | 1 | new `AdminPageHead`, `ADMIN_BODY` |
| `src/components/shell/page-header.tsx` + `page-header.test.ts` | 1 | `subtitleFont`; h1 ring |
| `src/app/globals.css`, `src/lib/design-tokens.test.ts` | 1 | `--bar-ok`; §11 pairs |
| `src/app/(admin)/loading.tsx` + `loading.test.ts` | 1 | the admin frame skeleton |
| the five `src/app/(admin)/admin/**/page.tsx` | 1 | `AdminPageHead`, `metadata`; `nowMs()` in Overview and Scan (lint) |
| `e2e/c6-admin-layout.spec.ts` | 1–7 | new tests (12 at the end) |
| `src/lib/admin-queries.ts`, `src/lib/admin-counts.db.test.ts` | 2 | `newestUserAt`, `blobsUnchecked` |
| `src/lib/admin-overview-look.ts` + `.test.ts` | 2 | `overviewTiles`, `serverAttention`, dot / reason colours |
| `src/app/(admin)/admin/page.tsx` | 2 | tiles, Boards by firmware, Needs attention |
| `src/app/(admin)/admin/users/page.tsx` | 3 | the table, Admin pill, footer, pager |
| `src/components/admin/pager-link.tsx` + `.test.ts` | 3, 6 | `PagerLink` (Users, Firmware) |
| `src/components/admin/page-heading.ts` | 3 | `pageHeading()` (the h1 focus fallback) |
| `src/components/admin/delete-user-dialog.tsx` | 3 | onto `Modal` |
| `e2e/admin-helpers.ts` | 3 | `adminUsersPageOf`, `gotoAdminUserRow` |
| `src/components/admin/invite-issue.tsx`, `issue-invite-button.tsx`, `revoke-invite-button.tsx`, `copy-invite-buttons.tsx` + `copy-invite-buttons.test.ts` | 4 | provider, panel, button, Revoke, `look` / `linkLabel` |
| `src/app/(admin)/admin/invites/page.tsx` | 4 | head, panel, note, table |
| `e2e/admin-invites.spec.ts`, `e2e/contrast.spec.ts:236` | 4 | the button rename |
| `src/lib/admin-scan-look.ts` + `.test.ts` | 5 | `scanCoverage`, `enrichCoverage`, `scanNotes`, `plural` |
| `src/app/(admin)/admin/scan/page.tsx`, `src/components/admin/run-scan-button.tsx`, `dat-upload.tsx`, `openretro-upload.tsx` | 5 | cards, notes, imports, sets |
| `src/lib/admin-firmware.ts`, `admin-firmware.test.ts`, `src/lib/firmware-releases.ts`, `admin-firmware.db.test.ts` | 6 | `parseShow`, `firmwareHref`, the `show` filter |
| `src/app/(admin)/admin/firmware/page.tsx`, `src/components/admin/promote-release-button.tsx` | 6 | filter, rows, pager, Promote on `Modal` |
| `e2e/contrast.spec.ts`, `e2e/screenshots.shots.ts`, `docs/screenshots/admin.png` | 7 | the Admin pairs, the shot |

---

### Task 1: Shell and shared — the admin header, `AdminSections`, `AdminPageHead`, `PageHeader subtitleFont` + h1 ring, `--bar-ok`, the loading frame, titles, and lint to zero errors

**Files:**
- Create: `src/components/admin/admin-page-head.tsx`, `src/components/admin/admin-nav.test.ts`,
  `src/app/(admin)/loading.test.ts`, `e2e/c6-admin-layout.spec.ts`
- Modify: `src/app/(admin)/layout.tsx` (whole file), `src/components/admin/admin-nav.tsx` (whole file),
  `src/components/shell/page-header.tsx:5-84`, `src/components/shell/page-header.test.ts` (append),
  `src/app/globals.css` (webadf `:root`, after `--search-scrim` at line 307), `src/lib/design-tokens.test.ts`
  (value table, `pairs`), `src/app/(admin)/loading.tsx` (whole file), `src/app/(admin)/admin/page.tsx:1-64`,
  `src/app/(admin)/admin/users/page.tsx:1-42`, `src/app/(admin)/admin/invites/page.tsx:1-30`,
  `src/app/(admin)/admin/scan/page.tsx:1-75,166-168`, `src/app/(admin)/admin/firmware/page.tsx:1-52`

**Interfaces:**
- Consumes: `TopNav({ showAdmin })` (`@/components/shell/top-nav`), `SettingsLink`, `SignOutButton`
  (`@/components/sign-out-button`), `SearchBox`, `Logo`, `PageHeader`, `Bone`, `nowMs()` (`@/lib/clock`).
- Produces:
  - `ADMIN_SECTIONS: readonly { href: string; label: string }[]` and `AdminSections()` (`@/components/admin/admin-nav`;
    `AdminNav` is removed — its only caller was the layout)
  - `AdminPageHead(props: { title: string; subtitle?: string; subtitleFont?: 'mono' | 'sans'; actions?: React.ReactNode })`
    and `ADMIN_BODY = 'flex flex-col gap-6 px-4 pb-10 sm:px-7'` (`@/components/admin/admin-page-head`)
  - `PageHeader` prop `subtitleFont?: 'mono' | 'sans'` (default `mono`)
  - token `--bar-ok: #4F9D4A`
  - every admin page's `metadata.title`: `Admin · Overview` / `Admin · Users` / `Admin · Invites` / `Admin · Scan` /
    `Admin · Firmware`

**Plan ruling** (spec §13's split vs this plan): the two `react-hooks/purity` fixes (Ruling 3) move from the Overview
and Scan tasks into this first task, with `pnpm lint` as their RED/GREEN, so every later task starts from a lint that
exits 0 and any new error is that task's own.

**Plan ruling** (spec §1.3 "Every admin page starts with it"): this task already swaps all five pages from
`PageHeader eyebrow="Admin"` to `AdminPageHead`, with each page's **current** subtitle; Tasks 2–6 change the subtitles
with the rest of each page. So the tabs and titles exist from Task 1 on, and Task 1's tests can pin them.

- [ ] **Step 1: Write the failing tests**

`src/components/admin/admin-nav.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nav = vi.hoisted(() => ({ path: '/admin' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));

const { AdminSections } = await import('./admin-nav');
const { AdminPageHead, ADMIN_BODY } = await import('./admin-page-head');

/** The text of every link marked current, whatever order React writes the attributes in. */
const current = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].filter((m) => m[0].includes('aria-current="page"')).map((m) => m[1]);

describe('AdminSections (C6 spec §1.2, Ruling 2)', () => {
  it('is the labelled .seg nav of the five sections, in order, in a scroll clamp', () => {
    const html = renderToStaticMarkup(createElement(AdminSections));
    expect(html).toContain('aria-label="Admin sections"');
    expect(html).toContain('data-testid="admin-sections"');
    expect(html).toMatch(/class="seg w-max"/);
    expect(html).toMatch(/^<div class="max-w-full overflow-x-auto"/);
    expect([...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]))
      .toEqual(['Overview', 'Users', 'Invites', 'Scan', 'Firmware']);
    expect(html.match(/class="seg-item whitespace-nowrap"/g)?.length).toBe(5);
  });
  it('marks exactly the current page (exact match: /admin is a prefix of the others)', () => {
    for (const [path, label] of [['/admin', 'Overview'], ['/admin/users', 'Users'], ['/admin/invites', 'Invites'],
      ['/admin/scan', 'Scan'], ['/admin/firmware', 'Firmware']] as const) {
      nav.path = path;
      expect(current(renderToStaticMarkup(createElement(AdminSections)))).toEqual([label]);
    }
    nav.path = '/admin/elsewhere';
    expect(current(renderToStaticMarkup(createElement(AdminSections)))).toEqual([]);
  });
  it('has no count badge (Ruling 2)', () => {
    nav.path = '/admin';
    expect(renderToStaticMarkup(createElement(AdminSections))).not.toMatch(/live</);
  });
});

describe('AdminPageHead (C6 spec §1.3, Ruling 6)', () => {
  it('is the lg PageHeader with the server eyebrow, then the tabs in the page gutter', () => {
    nav.path = '/admin/scan';
    const html = renderToStaticMarkup(createElement(AdminPageHead, {
      title: 'Scan', subtitle: 'A sentence.', subtitleFont: 'sans', actions: createElement('button', null, 'Run now'),
    }));
    expect(html).toContain('>Admin · this server</span>');
    expect(html).toContain('sm:text-[44px]');
    expect(html).toContain('>Scan</h1>');
    expect(html).toContain('>A sentence.</span>');
    expect(html).toContain('<button>Run now</button>');
    expect(html.indexOf('</h1>')).toBeLessThan(html.indexOf('data-testid="admin-sections"'));
    expect(html).toContain('class="flex flex-col items-start px-4 pb-6 sm:px-7"');
    expect(ADMIN_BODY).toBe('flex flex-col gap-6 px-4 pb-10 sm:px-7');
  });
});
```

`src/components/shell/page-header.test.ts` — append:

```ts
describe('PageHeader subtitleFont and the h1 ring (C6 spec §1.4, Rulings 4, 5)', () => {
  const r = (p: { subtitleFont?: 'mono' | 'sans' } = {}) =>
    renderToStaticMarkup(createElement(PageHeader, { title: 'Scan', size: 'lg', subtitle: 'A sentence.', ...p }));
  it('mono by default; sans is Geist 14 px in --muted', () => {
    expect(r()).toContain('class="mt-1 font-mono text-[13px]"');
    const sans = r({ subtitleFont: 'sans' });
    expect(sans).toContain('class="mt-1 text-[14px]" style="color:var(--muted)"');
    expect(sans).not.toContain('font-mono');
  });
  it('the h1 shows a visible ring when focused (it is only ever focused by script)', () => {
    const html = r();
    expect(html).not.toContain('focus:outline-none');
    expect(html).toContain('rounded-[6px] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)');
    expect(html).toContain('tabindex="-1"');
  });
});
```

`src/app/(admin)/loading.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AdminLoading from './loading';

describe('AdminLoading (C6 spec §1.7, Ruling 37)', () => {
  const html = renderToStaticMarkup(createElement(AdminLoading));
  it('keeps page-skeleton and the status wrapper', () => {
    expect(html).toContain('data-testid="page-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading…');
  });
  it("draws the admin frame: an lg head, the tabs bone, one card of six rows", () => {
    expect(html).toContain('h-[30px] w-56 sm:h-[44px]');
    expect(html).toContain('h-[42px] w-[420px] max-w-full');
    expect(html).toContain('rounded-[16px]');
    expect(html.match(/data-skeleton-row/g)?.length).toBe(6);
  });
  it("is not PageSkeleton (its md header bones would jump when the 44 px heading lands)", () => {
    expect(html).not.toContain('sm:h-[34px]');
  });
});
```

`src/lib/design-tokens.test.ts` — in the value table, after `['--on-ink-muted', '#A39B8B'], ['--on-ink-accent', '#EE8A2A'],`
add:

```ts
    ['--bar-ok', '#4F9D4A'],
```

and at the end of `pairs`, after the `// Settings / Help / Search / Sign in spec §11` block, add:

```ts
    // Admin spec §11 (its other pairs are already above: muted-2 / amber-text on the grounds, danger-strong on
    // danger-bg, success-fg on surface, surface on ink, white on danger-fg)
    ['--ink', '--warning-bg'], ['--muted', '--warning-bg'], ['--danger-fg', '--surface-2'],
```

`e2e/c6-admin-layout.spec.ts` (new):

```ts
import { test, expect } from '@playwright/test';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, cleanupTestReleases } from './device-helpers';

// Phase C6 (spec 2026-10-25-phase-c6-admin-design.md §10.4): the admin layout. The DB is the live one: every
// assertion is about rows a test made, or follows a value the page itself shows (both values of a state).
test.afterAll(async () => { await cleanupTestReleases(); await cleanupSeeded(); });

const PAGES = [
  ['/admin', 'Overview'], ['/admin/users', 'Users'], ['/admin/invites', 'Invites'],
  ['/admin/scan', 'Scan'], ['/admin/firmware', 'Firmware'],
] as const;

// ---- Shell (spec §1, Rulings 1, 2, 6, 36) -----------------------------------------------------------------

test('the admin header carries the Main nav with Admin current, the gear and Sign out, and no drive chips', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path] of PAGES) {
    await page.goto(path);
    const header = page.getByTestId('admin-header');
    const main = header.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link')).toHaveText(['Library', 'Devices', 'Upload', 'Help', 'Admin']);
    await expect(main.locator('[aria-current="page"]')).toHaveText(['Admin']);
    await expect(header.getByTestId('settings-link')).toBeVisible();
    await expect(header.getByTestId('sign-out')).toBeVisible();
    await expect(header.getByTestId('search-input')).toBeVisible();
    await expect(header.getByText('Back to library')).toHaveCount(0);
    await expect(header).toContainText('webfloppy admin');
    await expect(page.locator('[data-testid^=drive-chip]')).toHaveCount(0);
    await expect(page.getByTestId('drives-compact')).toHaveCount(0);
  }
});

test('every admin page opens with the Admin sections tabs, the current one marked, and its own title', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path, name] of PAGES) {
    await page.goto(path);
    const tabs = page.getByTestId('admin-sections');
    await expect(tabs).toHaveAttribute('aria-label', 'Admin sections');
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Users', 'Invites', 'Scan', 'Firmware']);
    await expect(tabs.locator('[aria-current="page"]')).toHaveText([name]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText('Admin · this server', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(`Admin · ${name} · WebFloppy`);
  }
});
```

- [ ] **Step 2: Run them to see them fail, and lint to see the two errors**

Run: `pnpm test src/components/admin/admin-nav.test.ts src/components/shell/page-header.test.ts "src/app/(admin)/loading.test.ts" src/lib/design-tokens.test.ts`
Expected: FAIL — `admin-nav.test.ts`: `Cannot find module './admin-page-head'`; page-header: `expected '…' not to
contain 'focus:outline-none'` and the sans `toContain`; loading: `expected '…' to contain 'h-[30px] w-56 sm:h-[44px]'`;
design-tokens: `--bar-ok is %s` fails (`expected undefined to be '#4F9D4A'`).

Run: `pnpm lint`
Expected: FAIL — `✖ 14 problems (2 errors, 12 warnings)`; the errors are `react-hooks/purity` "Cannot call impure
function" at `src/app/(admin)/admin/page.tsx` 51 and `src/app/(admin)/admin/scan/page.tsx` 167.

- [ ] **Step 3: Implement**

`src/components/admin/admin-nav.tsx` (whole file):

```tsx
'use client';
import { Link } from '@/components/shell/link';
import { usePathname } from 'next/navigation';

/**
 * The in-page Admin sections tabs (C6 spec §1.2, Ruling 2): the header holds the app's Main nav now, so the five
 * sections move under each page's heading. Exact match on href, not startsWith: '/admin' is a prefix of every other
 * entry, so startsWith would light up Overview everywhere. No count badge (Ruling 2): the Overview tile, its
 * attention item and the Invites subtitle already say "0 live" in words.
 */
export const ADMIN_SECTIONS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/invites', label: 'Invites' },
  { href: '/admin/scan', label: 'Scan' },
  { href: '/admin/firmware', label: 'Firmware' },
] as const;

export function AdminSections() {
  const pathname = usePathname();
  return (
    // The clamp scrolls on a phone (five tabs are ~420 px); w-max keeps the track as wide as its items.
    <div className="max-w-full overflow-x-auto">
      <nav aria-label="Admin sections" data-testid="admin-sections" className="seg w-max">
        {ADMIN_SECTIONS.map((item) => (
          <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}
                className="seg-item whitespace-nowrap">
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
```

`src/components/admin/admin-page-head.tsx`:

```tsx
import { PageHeader } from '@/components/shell/page-header';
import { AdminSections } from '@/components/admin/admin-nav';

/** Every admin page's body: the page gutter, a column, 24 px between blocks (C6 spec §1.3). */
export const ADMIN_BODY = 'flex flex-col gap-6 px-4 pb-10 sm:px-7';

/** Every admin page opens with this (C6 spec §1.3, Ruling 6): the lg heading under `Admin · this server`, then the tabs. */
export function AdminPageHead({ title, subtitle, subtitleFont, actions }: {
  title: string; subtitle?: string; subtitleFont?: 'mono' | 'sans'; actions?: React.ReactNode;
}) {
  return (
    <>
      <PageHeader size="lg" eyebrow="Admin · this server" title={title} subtitle={subtitle}
                  subtitleFont={subtitleFont} actions={actions} />
      {/* A column with items-start: the clamp's max-w-full then caps it at the gutter and it scrolls inside. */}
      <div className="flex flex-col items-start px-4 pb-6 sm:px-7">
        <AdminSections />
      </div>
    </>
  );
}
```

`src/components/shell/page-header.tsx` — the props gain `subtitleFont`, the h1 its ring, the subtitle its font:

```tsx
  size = 'md',
  flush = false,
  subtitleFont = 'mono',
}: {
```

(after `flush?: boolean;` in the props type add)

```tsx
  /** `sans` is a sentence in Geist 14 px (Admin Overview and Scan); `mono` the summary line (C6 spec §1.4, Ruling 4). */
  subtitleFont?: 'mono' | 'sans';
```

the h1's class string `` `focus:outline-none ${lg `` becomes:

```tsx
            className={`rounded-[6px] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring) ${lg
```

and the h1's comment line `tabIndex={-1}   // a programmatic focus target …` stays; add above the className:
`// A visible ring (C6 Ruling 5): only a script focuses it, as the fallback after a removal.`

and the subtitle block becomes:

```tsx
        {subtitle && (subtitleFont === 'sans' ? (
          <span className="mt-1 text-[14px]" style={{ color: 'var(--muted)' }}>{subtitle}</span>
        ) : (
          <span
            className={lg ? 'mt-1 font-mono text-[13px]' : 'mt-1 font-mono text-[11.5px]'}
            style={{ color: 'var(--on-dark-muted)' }}
          >
            {subtitle}
          </span>
        ))}
```

`src/app/globals.css` — after the `--search-scrim:` line (307) add:

```css
  --bar-ok:        #4F9D4A;   /* the green fill of the admin coverage and firmware bars; decoration beside a number */
```

`src/app/(admin)/loading.tsx` (whole file):

```tsx
import { Bone } from '@/components/shell/skeleton';

// Any admin page while it loads (C6 spec §1.7, Ruling 37): the admin frame -- the lg head in PageHeader's gutter,
// the tabs, one card of rows. Not PageSkeleton: its md header bones would jump when the 44 px heading lands.
// page-skeleton and the status wrapper are kept.
export default function AdminLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <div role="status" aria-busy="true" data-testid="page-skeleton">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2 px-4 pb-5 pt-6 sm:px-7">
        <Bone className="h-[13px] w-40" />
        <Bone className="h-[30px] w-56 sm:h-[44px]" />
        <Bone className="h-[13px] w-72 max-w-full" />
      </div>
      <div className="px-4 pb-6 sm:px-7">
        <Bone className="h-[42px] w-[420px] max-w-full" style={{ borderRadius: 12 }} />
      </div>
      <div className="px-4 pb-10 sm:px-7">
        <div className="flex flex-col gap-3 rounded-[16px] p-5" style={card}>
          {Array.from({ length: 6 }, (_, i) => <div key={i} data-skeleton-row><Bone className="h-11 w-full" /></div>)}
        </div>
      </div>
    </div>
  );
}
```

`src/app/(admin)/layout.tsx` (whole file):

```tsx
import { requireSuperAdmin } from '@/lib/superadmin';
import { TopNav } from '@/components/shell/top-nav';
import { SearchBox } from '@/components/shell/search-box';
import { SettingsLink } from '@/components/shell/settings-link';
import { SignOutButton } from '@/components/sign-out-button';
import { Logo } from '@/components/shell/logo';

/**
 * The admin shell. Deliberately NOT the (app) shell: there is no active organization here, so the drive chips and
 * the drive menu would be showing a tenant context these pages do not have. Since C6 (spec §1.1, Ruling 1) it
 * carries the app's own Main nav (TopNav, with Admin current on every /admin page), the gear and Sign out; the five
 * admin sections are the in-page tabs under each heading (AdminSections).
 *
 * requireSuperAdmin() is called here and *also* independently by every /api/admin route. A layout guard is not an
 * API guard -- a page render and a later fetch are separate requests, and only the second is what an attacker sends.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { email } = await requireSuperAdmin();
  return (
    <>
      {/* The bottom padding is the room the fixed mobile nav bar occupies (see the wrapper below). It lives here,
          once, rather than on each admin page, which would otherwise each have to remember it. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {/* Below sm the header wraps: wordmark on line one, then the search box, the operator's email, the gear and
            Sign out. They do not fit on one line at 390px, and nowrap would push the last of them off-screen. */}
        <header
          data-testid="admin-header"
          className="relative flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:h-[72px] sm:flex-nowrap sm:gap-4 sm:px-7 sm:py-0"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}
        >
          <span
            className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-[18px] font-bold tracking-[-0.02em]"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}
          >
            <Logo size={24} />
            <span>webfloppy <span style={{ color: 'var(--muted)' }}>admin</span></span>
          </span>
          {/* In flow from sm, centred in the space between the wordmark and the right-hand group, and absolutely
              centred on the bar only from 2xl, where that measures clear of the search box (Phase B final review F1:
              centred from sm, the pill ran ~40px under the search box at 1280, and clicks on its hidden part went to
              the input). The app shell does the same from xl; this bar's right group is wider (the email), so it
              waits until 2xl. Below sm the same wrapper becomes a fixed bottom bar instead of a strip painted over
              the wordmark (spec D-6-2). e2e/header-overlap.spec.ts pins it. */}
          <div
            // h-[34px] matching the flow content's height, with items-center, so the pill's centre lines up with the
            // search box's. From 2xl, pointer-events-none on the full-width wrapper, auto on the pill: there the
            // wrapper spans the header and would otherwise swallow clicks meant for the search box behind it.
            //
            // 2xl:top-[19px] is (72 - 34) / 2: the 72px bar's middle. Below sm the bar's look comes from
            // --nav-scrim / --nav-scrim-hairline, a light surface like the header itself.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md sm:static sm:z-auto sm:min-w-0 sm:flex-1 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none 2xl:pointer-events-none 2xl:absolute 2xl:inset-x-0 2xl:top-[19px] 2xl:bottom-auto 2xl:h-[34px]"
          >
            {/* The pill scrolls inside this clamp wherever the space left for it is short (the phone bar, and the
                in-flow bar at narrow sm widths), rather than the bar scrolling around it -- a justify-center scroll
                container puts the start of its own content out of reach once it overflows. */}
            <div className="pointer-events-auto max-w-full overflow-x-auto">
              {/* Every page under this layout passed requireSuperAdmin(), so Admin is shown (TopNav's own rule). */}
              <TopNav showAdmin />
            </div>
          </div>
          {/* Wraps onto its own full-width line below sm; ml-auto is inert there and still does the work at sm and up. */}
          <div className="ml-auto flex w-full flex-wrap items-center gap-3 sm:w-auto sm:shrink-0 sm:flex-nowrap sm:gap-4">
            <SearchBox />
            {/* Hidden from sm until xl: with it, the bar has no room for the pill between the wordmark and the search
                box. It is a label, not a control; below sm it has its own wrapped line again. */}
            <span
              className="max-w-[180px] truncate font-mono text-[11.5px] sm:hidden xl:block"
              style={{ color: 'var(--muted)' }}
              data-testid="admin-email"
            >
              {email}
            </span>
            <SettingsLink />
            <SignOutButton />
          </div>
        </header>
        {children}
      </div>
    </>
  );
}
```

The five pages — each `PageHeader` import becomes `import { AdminPageHead } from '@/components/admin/admin-page-head';`,
each `<PageHeader eyebrow="Admin" title="X" subtitle={…} actions={…} />` becomes `<AdminPageHead title="X"
subtitle={…} actions={…} />` (same subtitle and actions as today), and each page gains, after its
`export const dynamic = 'force-dynamic';`:

```tsx
export const metadata = { title: 'Admin · Overview' };   // users: 'Admin · Users', invites: 'Admin · Invites', scan: 'Admin · Scan', firmware: 'Admin · Firmware'
```

`src/app/(admin)/admin/page.tsx` — add `import { nowMs } from '@/lib/clock';` and replace line 51:

```tsx
  // One `now` for every rule on the page, read once per request (Ruling 3), so the tiles, the distribution and the
  // attention list agree.
  const now = nowMs();
```

`src/app/(admin)/admin/scan/page.tsx` — add `import { nowMs } from '@/lib/clock';`; after the `demozooState` line add
`const now = nowMs();` and line 167 becomes `{demozooStatusText(demozooState, now)}`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/components/admin/admin-nav.test.ts src/components/shell/page-header.test.ts "src/app/(admin)/loading.test.ts" src/lib/design-tokens.test.ts`
Expected: PASS.

Run: `pnpm test`, then `npx tsc --noEmit`, then `pnpm lint`
Expected: all green; lint `✖ 12 problems (0 errors, 12 warnings)`, exit 0.

e2e, one at a time (the specs that select the admin header, the admin headings or the admin pages' tabs):
1. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/header-overlap.spec.ts --project=desktop` → `3 passed` (the admin sweep
   measures `TopNav` in the admin header at 640–1920; spec Ruling 1's cost: if a width fails, report the width and
   the two edges — do not change the test).
3. `PORT=3100 npx playwright test e2e/admin-guard.spec.ts --project=desktop` → `9 passed`.
4. `PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "admin plane never renders"` → `1 passed`.
5. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "sees the scan status page|Demozoo status line"` → `2 passed` (`heading /scan/i` stays unique).
6. `PORT=3100 npx playwright test e2e/admin-firmware.spec.ts --project=desktop -g "Page 1 of"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/layout.tsx" src/components/admin/admin-nav.tsx src/components/admin/admin-nav.test.ts \
  src/components/admin/admin-page-head.tsx src/components/shell/page-header.tsx src/components/shell/page-header.test.ts \
  src/app/globals.css src/lib/design-tokens.test.ts "src/app/(admin)/loading.tsx" "src/app/(admin)/loading.test.ts" \
  "src/app/(admin)/admin/page.tsx" "src/app/(admin)/admin/users/page.tsx" "src/app/(admin)/admin/invites/page.tsx" \
  "src/app/(admin)/admin/scan/page.tsx" "src/app/(admin)/admin/firmware/page.tsx" e2e/c6-admin-layout.spec.ts
git commit -m "C6: admin header takes the Main nav, gear and Sign out; Admin sections tabs, AdminPageHead, titles, the admin loading frame; lint at zero errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 2: Overview — `adminCounts` + `newestUserAt` / `blobsUnchecked`, the six tile links, Boards by firmware, Needs attention with the two server items

**Files:**
- Create: `src/lib/admin-overview-look.ts`, `src/lib/admin-overview-look.test.ts`, `src/lib/admin-counts.db.test.ts`
- Modify: `src/lib/admin-queries.ts:24-72` (`AdminCounts`, `adminCounts`), `src/app/(admin)/admin/page.tsx` (whole
  file), `e2e/c6-admin-layout.spec.ts` (append)

**Interfaces:**
- Consumes: `AdminPageHead`, `ADMIN_BODY` (Task 1); `needsAttention`, `orderDistribution`, `versionLabel`,
  `type AttentionKind` (`@/lib/admin-board-health`); `nowMs()`.
- Produces:
  - `AdminCounts` gains `newestUserAt: string | null` (`YYYY-MM-DD`, UTC) and `blobsUnchecked: number`
  - `type NotePart = string | { id: string; value: number }`;
    `type OverviewTile = { label: string; id: string; value: number; href: string; warn: boolean; note: NotePart[] }`;
    `overviewTiles(c: { users: number; orgs: number; games: number; disks: number; blobs: number; liveInvites: number; blobsUnchecked: number; newestUserAt: string | null }, b: { paired: number; online: number }) → OverviewTile[]`
  - `type ServerAttention = { id: 'attention-invites' | 'attention-scan'; href: string; title: string; text: string; bg: string; dot: string }`;
    `serverAttention(c: { liveInvites: number; blobsUnchecked: number }) → ServerAttention[]`
  - `ATTENTION_DOT: Record<AttentionKind, string>`, `REASON_FG: Record<AttentionKind, string>` (all `@/lib/admin-overview-look`)
  - DOM hooks later tasks read: tile links carry `data-warn="true|false"`; attention items' words carry
    `data-attn="title"` / `data-attn="text"`; ` · current` carries `data-dist="current"`.

**Plan ruling** (spec §2.2 "`newestUserAt`, ISO date"): `newestUserAt` is computed in SQL as
`to_char(max(created_at), 'YYYY-MM-DD')`, a string, not a `Date`. `auth.user.created_at` is a `timestamp without time
zone` and a raw `execute()` hands it back in a driver-dependent shape; the page only ever shows the date.

**Plan ruling** (spec §2.2, `<count-disks>63</> disks`): one disk reads `1 disk`, as the attention item's
`1 blob not yet scanned` does.

- [ ] **Step 1: Write the failing tests**

`src/lib/admin-overview-look.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { overviewTiles, serverAttention, ATTENTION_DOT, REASON_FG } from '@/lib/admin-overview-look';

const COUNTS = { users: 12, orgs: 9, games: 40, disks: 63, blobs: 70, liveInvites: 3, blobsUnchecked: 0, newestUserAt: '2026-10-25' };
const BOARDS = { paired: 4, online: 2 };

describe('overviewTiles (C6 spec §2.2, Ruling 13)', () => {
  it('six links in the board order, each value the digits only', () => {
    const t = overviewTiles(COUNTS, BOARDS);
    expect(t.map((x) => [x.label, x.id, x.value, x.href])).toEqual([
      ['Users', 'count-users', 12, '/admin/users'],
      ['Organizations', 'count-orgs', 9, '/admin/users'],
      ['Titles', 'count-games', 40, '/admin/scan'],
      ['Blobs', 'count-blobs', 70, '/admin/scan'],
      ['Boards online', 'count-boardsOnline', 2, '/admin/firmware'],
      ['Live invites', 'count-liveInvites', 3, '/admin/invites'],
    ]);
  });
  it('notes: newest date, the nested disks and paired figures keep their ids', () => {
    const t = overviewTiles(COUNTS, BOARDS);
    expect(t[0].note).toEqual(['newest 2026-10-25']);
    expect(t[1].note).toEqual(['every library on this server']);
    expect(t[2].note).toEqual([{ id: 'count-disks', value: 63 }, ' disks']);
    expect(t[4].note).toEqual(['of ', { id: 'count-boardsPaired', value: 4 }, ' paired']);
    expect(overviewTiles({ ...COUNTS, disks: 1 }, BOARDS)[2].note).toEqual([{ id: 'count-disks', value: 1 }, ' disk']);
    expect(overviewTiles({ ...COUNTS, newestUserAt: null }, BOARDS)[0].note).toEqual(['none yet']);
  });
  it('both values of each warning: Blobs warns while any is unscanned, Live invites at 0', () => {
    expect(overviewTiles(COUNTS, BOARDS).map((x) => x.warn)).toEqual([false, false, false, false, false, false]);
    expect(overviewTiles(COUNTS, BOARDS)[3].note).toEqual(['all scanned']);
    expect(overviewTiles(COUNTS, BOARDS)[5].note).toEqual(['each code works once']);
    const w = overviewTiles({ ...COUNTS, blobsUnchecked: 12, liveInvites: 0 }, BOARDS);
    expect(w[3]).toMatchObject({ warn: true, note: ['12 not yet scanned'] });
    expect(w[5]).toMatchObject({ warn: true, note: ['nobody can sign up'] });
  });
});

describe('serverAttention (C6 spec §2.4, Ruling 16)', () => {
  it('nothing when invites are live and every blob is scanned', () => {
    expect(serverAttention({ liveInvites: 2, blobsUnchecked: 0 })).toEqual([]);
  });
  it('no live invites first, then the unscanned blobs, with the board words', () => {
    expect(serverAttention({ liveInvites: 0, blobsUnchecked: 12 })).toEqual([
      { id: 'attention-invites', href: '/admin/invites', title: 'No live invite codes',
        text: 'Registration is invite-only. Issue one before sharing the sign-up link.',
        bg: 'var(--warning-bg)', dot: 'var(--fetch-dot)' },
      { id: 'attention-scan', href: '/admin/scan', title: '12 blobs not yet scanned',
        text: 'The nightly scan picks them up, or run it now.', bg: 'var(--surface-2)', dot: 'var(--dash)' },
    ]);
  });
  it('one blob reads in the singular', () => {
    expect(serverAttention({ liveInvites: 1, blobsUnchecked: 1 })).toEqual([expect.objectContaining({
      title: '1 blob not yet scanned', text: 'The nightly scan picks it up, or run it now.' })]);
  });
  it('dots and reason colours by kind', () => {
    expect(ATTENTION_DOT).toEqual({ error: 'var(--danger-fg)', behind: 'var(--fetch-dot)', offline: 'var(--dash)' });
    expect(REASON_FG).toEqual({ error: 'var(--danger-fg)', behind: 'var(--amber-text)', offline: 'var(--muted)' });
  });
});
```

`src/lib/admin-counts.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_admin_counts_test';
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
const { user } = await import('@/db/schema/auth');
const { blobs } = await import('@/db/schema/catalog');
const Q = await import('./admin-queries');
const { scanStatus } = await import('./tosec-sweep');

const db = () => getDb();
const sha = (c: string) => c.repeat(64);

describe('adminCounts: newestUserAt and blobsUnchecked (C6 spec §2.2, Ruling 14)', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('an empty database: no newest user, nothing unchecked', async () => {
    const c = await Q.adminCounts();
    expect(c.newestUserAt).toBeNull();
    expect(c.blobsUnchecked).toBe(0);
  });

  it("newestUserAt is the newest account's date; blobsUnchecked is scanStatus' own unchecked", async () => {
    const now = new Date();
    await db().insert(user).values([
      { id: 'u1', name: 'Old', email: 'old@example.test', emailVerified: true, createdAt: new Date('2026-01-02T03:00:00Z'), updatedAt: now },
      { id: 'u2', name: 'New', email: 'new@example.test', emailVerified: true, createdAt: new Date('2026-10-25T23:30:00Z'), updatedAt: now },
    ]);
    await db().insert(blobs).values([
      { sha256: sha('a'), sizeBytes: 1, storageKey: sha('a') },                                                    // unchecked
      { sha256: sha('b'), sizeBytes: 1, storageKey: sha('b'), matchState: 'none', matchCheckedAt: now, hashedAt: now }, // decided
      { sha256: sha('c'), sizeBytes: 1, storageKey: sha('c'), derivedFromSha256: sha('a') },                          // a restore's copy: never counted
    ]);
    const c = await Q.adminCounts();
    expect(c.newestUserAt).toBe('2026-10-25');
    expect(c.blobsUnchecked).toBe(1);
    expect(c.blobsUnchecked).toBe((await scanStatus()).unchecked);
    expect(c.users).toBe(2);
    expect(c.blobs).toBe(3);   // the plain count is unchanged: every row
  });
});
```

`e2e/c6-admin-layout.spec.ts` — append:

```ts
// ---- Overview (spec §2, Rulings 13–16) --------------------------------------------------------------------

test('Overview: six tiles that are links, the nested figures digits only, the firmware card and its footnote', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const TILES = [
    ['count-users', 'Users', '/admin/users'], ['count-orgs', 'Organizations', '/admin/users'],
    ['count-games', 'Titles', '/admin/scan'], ['count-blobs', 'Blobs', '/admin/scan'],
    ['count-boardsOnline', 'Boards online', '/admin/firmware'], ['count-liveInvites', 'Live invites', '/admin/invites'],
  ] as const;
  for (const [id, label, href] of TILES) {
    const tile = page.locator(`a:has(> [data-testid="${id}"])`);
    await expect(tile).toHaveAttribute('href', href);
    await expect(tile.locator(':scope > span').first()).toHaveText(label);
    await expect(page.getByTestId(id)).toHaveText(/^\d+$/);
    await expect(tile).toHaveAttribute('data-warn', /^(true|false)$/);
  }
  for (const id of ['count-disks', 'count-boardsPaired', 'count-boardsSeen7d']) {
    await expect(page.getByTestId(id)).toHaveText(/^\d+$/);
  }
  await expect(page.locator('a:has(> [data-testid="count-users"]) > span:last-child'))
    .toHaveText(/^(newest \d{4}-\d{2}-\d{2}|none yet)$/);
  await expect(page.locator('a:has(> [data-testid="count-games"])')).toContainText(/\d+ disks?$/);
  await expect(page.locator('a:has(> [data-testid="count-boardsOnline"])')).toContainText(/of \d+ paired$/);
  // Both values of the warning: it follows the number.
  const live = Number(await page.getByTestId('count-liveInvites').textContent());
  await expect(page.locator('a:has(> [data-testid="count-liveInvites"])'))
    .toHaveAttribute('data-warn', live === 0 ? 'true' : 'false');

  await expect(page.getByRole('heading', { name: 'Boards by firmware' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Firmware registry' })).toHaveAttribute('href', '/admin/firmware');
  await expect(page.getByText(/^Boards that reported in the last 7 days: \d+\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /overview/i })).toHaveCount(1);

  await page.locator('a:has(> [data-testid="count-users"])').click();
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test('Needs attention: the server items follow the tile numbers and come first, then the boards', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const live = Number(await page.getByTestId('count-liveInvites').textContent());
  const invites = page.getByTestId('attention-invites');
  if (live === 0) {
    await expect(invites).toHaveAttribute('href', '/admin/invites');
    await expect(invites).toContainText('No live invite codes');
  } else {
    await expect(invites).toHaveCount(0);
  }
  const note = (await page.locator('a:has(> [data-testid="count-blobs"]) > span:last-child').textContent()) ?? '';
  const scan = page.getByTestId('attention-scan');
  const unchecked = /^(\d+) not yet scanned$/.exec(note)?.[1];
  if (unchecked) {
    await expect(scan).toHaveAttribute('href', '/admin/scan');
    await expect(scan.locator('[data-attn="title"]')).toHaveText(new RegExp(`^${unchecked} blobs? not yet scanned$`));
  } else {
    expect(note).toBe('all scanned');
    await expect(scan).toHaveCount(0);
  }
  // Order: server items, then board rows; "Nothing needs attention." only when there is nothing else.
  const order = await page.getByTestId('attention').locator(':scope > li').evaluateAll((lis) =>
    lis.map((li) => li.getAttribute('data-testid') ?? li.firstElementChild?.getAttribute('data-testid') ?? ''));
  const firstRow = order.indexOf('attention-row');
  const lastServer = Math.max(order.lastIndexOf('attention-invites'), order.lastIndexOf('attention-scan'));
  if (firstRow !== -1) expect(lastServer).toBeLessThan(firstRow);
  expect(order.includes('attention-empty')).toBe(order.length === 1);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/lib/admin-overview-look.test.ts`
Expected: FAIL — `Cannot find module '@/lib/admin-overview-look'`.

Run: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db src/lib/admin-counts.db.test.ts`
Expected: FAIL — `expected undefined to be null` (and `expected undefined to be 1`).

- [ ] **Step 3: Implement**

`src/lib/admin-queries.ts` — `AdminCounts` becomes:

```ts
export interface AdminCounts {
  users: number; orgs: number; games: number; disks: number;
  blobs: number; liveInvites: number;
  /** The newest account's creation date, `YYYY-MM-DD` (UTC), or null with no users (C6 Ruling 14). */
  newestUserAt: string | null;
  /** Blobs the identity scan has not checked yet: scanStatus()'s exact `unchecked` predicate (C6 Ruling 14). */
  blobsUnchecked: number;
}
```

and in `adminCounts()` the select gains two columns (the doc comment's "Six count(*) reads" becomes "Seven count(*)
reads and the newest sign-up date"), the generic type gains `newest_user_at: string | null; blobs_unchecked: number;`,
and the return gains the two fields:

```ts
      (select count(*)::int from invites
        where consumed_at is null and revoked_at is null
          and expires_at > now())                                  as live_invites,
      -- A string, not a timestamp: created_at has no time zone, and the page only shows the date.
      (select to_char(max(created_at), 'YYYY-MM-DD') from auth."user") as newest_user_at,
      -- scanStatus()'s `unchecked`, word for word (tosec-sweep.ts): a restore's re-dated copy is never a blob to scan.
      (select count(*)::int from blobs where match_checked_at is null
        and derived_from_sha256 is null)                             as blobs_unchecked
  `);
  const row = rows[0];
  return {
    users: Number(row.users), orgs: Number(row.orgs), games: Number(row.games),
    disks: Number(row.disks), blobs: Number(row.blobs),
    liveInvites: Number(row.live_invites),
    newestUserAt: row.newest_user_at ?? null,
    blobsUnchecked: Number(row.blobs_unchecked),
  };
```

`src/lib/admin-overview-look.ts`:

```ts
// The admin Overview's look rules (C6 spec §2): pure and client-safe. Plain numbers in, so this file never imports
// the quarantined admin-queries module.
import type { AttentionKind } from '@/lib/admin-board-health';

export type NotePart = string | { id: string; value: number };
export type OverviewTile = { label: string; id: string; value: number; href: string; warn: boolean; note: NotePart[] };

type Counts = {
  users: number; orgs: number; games: number; disks: number; blobs: number; liveInvites: number;
  blobsUnchecked: number; newestUserAt: string | null;
};

/** The six tiles (Ruling 13): disks and paired boards ride in the notes, each still a digits-only element with its id. */
export function overviewTiles(c: Counts, b: { paired: number; online: number }): OverviewTile[] {
  return [
    { label: 'Users', id: 'count-users', value: c.users, href: '/admin/users', warn: false,
      note: [c.newestUserAt ? `newest ${c.newestUserAt}` : 'none yet'] },
    { label: 'Organizations', id: 'count-orgs', value: c.orgs, href: '/admin/users', warn: false,
      note: ['every library on this server'] },
    { label: 'Titles', id: 'count-games', value: c.games, href: '/admin/scan', warn: false,
      note: [{ id: 'count-disks', value: c.disks }, c.disks === 1 ? ' disk' : ' disks'] },
    { label: 'Blobs', id: 'count-blobs', value: c.blobs, href: '/admin/scan', warn: c.blobsUnchecked > 0,
      note: [c.blobsUnchecked > 0 ? `${c.blobsUnchecked} not yet scanned` : 'all scanned'] },
    { label: 'Boards online', id: 'count-boardsOnline', value: b.online, href: '/admin/firmware', warn: false,
      note: ['of ', { id: 'count-boardsPaired', value: b.paired }, ' paired'] },
    { label: 'Live invites', id: 'count-liveInvites', value: c.liveInvites, href: '/admin/invites',
      warn: c.liveInvites === 0, note: [c.liveInvites === 0 ? 'nobody can sign up' : 'each code works once'] },
  ];
}

export type ServerAttention = {
  id: 'attention-invites' | 'attention-scan'; href: string; title: string; text: string; bg: string; dot: string;
};

/** The two server-level items above the board rows (Ruling 16), in this order. */
export function serverAttention(c: { liveInvites: number; blobsUnchecked: number }): ServerAttention[] {
  const out: ServerAttention[] = [];
  if (c.liveInvites === 0) {
    out.push({ id: 'attention-invites', href: '/admin/invites', title: 'No live invite codes',
      text: 'Registration is invite-only. Issue one before sharing the sign-up link.',
      bg: 'var(--warning-bg)', dot: 'var(--fetch-dot)' });
  }
  if (c.blobsUnchecked > 0) {
    const one = c.blobsUnchecked === 1;
    out.push({ id: 'attention-scan', href: '/admin/scan', title: `${c.blobsUnchecked} ${one ? 'blob' : 'blobs'} not yet scanned`,
      text: `The nightly scan picks ${one ? 'it' : 'them'} up, or run it now.`, bg: 'var(--surface-2)', dot: 'var(--dash)' });
  }
  return out;
}

/** A board row's dot, by its first reason (reasons come error, behind, offline). */
export const ATTENTION_DOT: Record<AttentionKind, string> = {
  error: 'var(--danger-fg)', behind: 'var(--fetch-dot)', offline: 'var(--dash)',
};
/** Each reason's words colour (A7's, kept). */
export const REASON_FG: Record<AttentionKind, string> = {
  error: 'var(--danger-fg)', behind: 'var(--amber-text)', offline: 'var(--muted)',
};
```

`src/app/(admin)/admin/page.tsx` (whole file):

```tsx
import { Fragment } from 'react';
import { Link } from '@/components/shell/link';
import {
  adminCounts, adminBoardCounts, adminFirmwareDistribution, adminAttentionCandidates,
} from '@/lib/admin-queries';
import { readCurrentRelease } from '@/lib/firmware-releases';
import { needsAttention, orderDistribution, versionLabel } from '@/lib/admin-board-health';
import { nowMs } from '@/lib/clock';
import { overviewTiles, serverAttention, ATTENTION_DOT, REASON_FG } from '@/lib/admin-overview-look';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';

// Counts are read live on every render; nothing here is cached. cacheComponents stays off in this project (see
// next.config.ts), and an operator looking at a database overview wants the number as it is now.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Overview' };

const CARD = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' } as const;
const RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';

export default async function AdminOverviewPage() {
  // One `now` for every rule on the page, read once per request (Ruling 3), so the tiles, the distribution and the
  // attention list agree.
  const now = nowMs();
  const [counts, boards, dist, candidates, current] = await Promise.all([
    adminCounts(), adminBoardCounts(now), adminFirmwareDistribution(now), adminAttentionCandidates(now),
    readCurrentRelease(),
  ]);
  const attention = needsAttention(candidates, current, now);
  const distribution = orderDistribution(dist, current?.sequence ?? null);
  const tiles = overviewTiles(counts, boards);
  const server = serverAttention(counts);
  return (
    <>
      <AdminPageHead
        title="Overview"
        subtitleFont="sans"
        subtitle="Every organization at once. These numbers cross the tenant boundary — only server admins see this area."
      />
      <div className={ADMIN_BODY}>
        {/* Six tiles, each a link (Ruling 13). The value span holds only the digits: admin-guard reads ^\d+$. */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map((t) => (
            <Link
              key={t.id}
              href={t.href}
              data-warn={t.warn ? 'true' : 'false'}
              // Shadows as classes, not inline: an inline shadow would beat the hover.
              className={`flex flex-col gap-2.5 rounded-[16px] bg-(--surface) p-[18px] shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--dash),0_12px_24px_-14px_rgb(36_33_27/0.3)] ${RING}`}
            >
              <span className="text-[13px] font-medium" style={{ color: 'var(--muted-2)' }}>{t.label}</span>
              <span
                data-testid={t.id}
                className="text-[40px] font-bold leading-none tabular-nums"
                style={{ fontFamily: 'var(--font-display)', color: t.warn ? 'var(--amber-text)' : 'var(--ink)' }}
              >
                {t.value}
              </span>
              <span className="text-[12px] [overflow-wrap:anywhere]"
                    style={{ color: t.warn ? 'var(--amber-text)' : 'var(--muted-2)' }}>
                {t.note.map((p, i) => (typeof p === 'string'
                  ? <Fragment key={i}>{p}</Fragment>
                  : <span key={i} data-testid={p.id}>{p.value}</span>))}
              </span>
            </Link>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start">
          {/* Boards by firmware (Ruling 15): A7's facts with the board's dots and bars. */}
          <section aria-labelledby="fw-dist-heading" className="flex flex-col gap-3 rounded-[20px] p-5" style={CARD}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="fw-dist-heading" className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
                Boards by firmware
              </h2>
              <Link href="/admin/firmware"
                    className={`text-[13px] font-semibold text-(--amber-text) hover:underline ${RING}`}>
                Firmware registry
              </Link>
            </div>
            <div data-testid="fw-dist" className="flex flex-col gap-2.5">
              {distribution.length === 0 ? (
                <div className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid="fw-dist-empty">
                  No board has been seen in the last 7 days.
                </div>
              ) : distribution.map((row) => (
                <div
                  key={row.version ?? '\u0000null'}
                  className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_60px] items-center gap-3.5 text-[13px]"
                  data-testid="fw-dist-row"
                  data-version={row.version ?? ''}
                  data-count={row.count}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="size-[7px] shrink-0 rounded-full"
                          style={{ background: row.current ? 'var(--online-dot)' : 'var(--dash)' }} />
                    <span className="min-w-0 font-mono [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}
                          title={row.version ?? undefined}>
                      {versionLabel(row.version)}
                    </span>
                    {row.current && (
                      <span data-dist="current" className="shrink-0 text-[12px]" style={{ color: 'var(--success-fg)' }}>
                        {' · current'}
                      </span>
                    )}
                    {!row.recognised && row.version !== null && (
                      <span className="shrink-0 text-[12px]" style={{ color: 'var(--muted-2)' }}>{' · unrecognised'}</span>
                    )}
                  </span>
                  <span aria-hidden className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
                    <span className="block h-2"
                          style={{ width: `${Math.max(2, row.share * 100)}%`, background: row.current ? 'var(--bar-ok)' : 'var(--dash)' }} />
                  </span>
                  <span className="text-right font-mono tabular-nums" style={{ color: 'var(--muted)' }}>{row.count}</span>
                </div>
              ))}
            </div>
            <p className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
              Boards that reported in the last 7 days: <span data-testid="count-boardsSeen7d">{boards.seen7d}</span>.
            </p>
          </section>

          {/* Needs attention (Ruling 16): server items first, as links; then A7's board rows, not links. */}
          <section aria-labelledby="attention-heading" className="flex flex-col gap-2.5 rounded-[20px] p-5" style={CARD}>
            <h2 id="attention-heading" className="mb-1 text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
              Needs attention
            </h2>
            <ul data-testid="attention" className="flex flex-col gap-2.5">
              {server.map((s) => (
                <li key={s.id}>
                  <Link href={s.href} data-testid={s.id}
                        className={`flex items-start gap-3 rounded-[12px] px-3.5 py-3 hover:shadow-[0_0_0_1px_var(--dash)] ${RING}`}
                        style={{ background: s.bg }}>
                    <span aria-hidden className="mt-[5px] size-2 shrink-0 rounded-full" style={{ background: s.dot }} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span data-attn="title" className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{s.title}</span>
                      <span data-attn="text" className="text-[13px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{s.text}</span>
                    </span>
                  </Link>
                </li>
              ))}
              {attention.map((row) => (
                <li key={row.deviceId} data-testid="attention-row" data-device-id={row.deviceId}
                    className="flex items-start gap-3 rounded-[12px] px-3.5 py-3" style={{ background: 'var(--surface-2)' }}>
                  <span aria-hidden className="mt-[5px] size-2 shrink-0 rounded-full"
                        style={{ background: ATTENTION_DOT[row.reasons[0]?.kind ?? 'offline'] }} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span data-attn="title" className="text-[14px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
                      {row.name}
                    </span>
                    <span className="text-[13px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{row.ownerEmail ?? '—'}</span>
                    <ul className="flex flex-col gap-0.5">
                      {row.reasons.map((reason) => (
                        <li key={reason.kind} data-kind={reason.kind} className="text-[13px] [overflow-wrap:anywhere]"
                            style={{ color: REASON_FG[reason.kind] }}>
                          {reason.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
              {server.length === 0 && attention.length === 0 && (
                <li className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid="attention-empty">
                  Nothing needs attention.
                </li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/lib/admin-overview-look.test.ts` → PASS.
Run: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db src/lib/admin-counts.db.test.ts src/lib/invites.db.test.ts` → PASS (invites' `liveInvites excludes revoked codes` still reads the same field).
Run: `pnpm test`, `npx tsc --noEmit`, `pnpm lint` → green; lint `✖ 12 problems (0 errors, 12 warnings)`.

e2e, one at a time (specs that select `count-*`, `fw-dist*`, `attention*` or visit `/admin`):
1. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Overview:|Needs attention:"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/admin-guard.spec.ts --project=desktop` → `9 passed` (the seeded `fw-dist-row`
   with `[title=…]` `0.0.0`, `attention-row` `[data-kind="error"]`, the `^\d+$` ids, `heading /overview/i`).
3. `PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "admin plane never renders"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-queries.ts src/lib/admin-counts.db.test.ts src/lib/admin-overview-look.ts \
  src/lib/admin-overview-look.test.ts "src/app/(admin)/admin/page.tsx" e2e/c6-admin-layout.spec.ts
git commit -m "C6 Overview: six tile links, Boards by firmware with dots and bars, Needs attention with the two server items; adminCounts gains newestUserAt and blobsUnchecked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 3: Users — the table, the Admin pill and its disabled `Delete…`, the footer and pager, the delete dialog on `Modal`

**Files:**
- Create: `src/components/admin/pager-link.tsx`, `src/components/admin/pager-link.test.ts`,
  `src/components/admin/page-heading.ts`
- Modify: `src/app/(admin)/admin/users/page.tsx` (whole file), `src/components/admin/delete-user-dialog.tsx` (whole
  file), `e2e/admin-helpers.ts` (append two helpers, one import), `e2e/c6-admin-layout.spec.ts` (imports, append)

**Interfaces:**
- Consumes: `AdminPageHead`, `ADMIN_BODY` (Task 1); `Modal` (`@/components/ui/modal`); `isSuperAdminEmail`
  (`@/lib/superadmin`, server only).
- Produces:
  - `PagerLink(props: { href: string | null; label: string; testId?: string })` (`@/components/admin/pager-link`): a
    `Link` (with `data-testid={testId}`) when `href` is a string; a `span aria-disabled="true"` with **no** test id when
    `href` is null. Task 6 uses it.
  - `pageHeading(): HTMLElement | null` (`@/components/admin/page-heading`): the page's h1. Tasks 4 and 6 use it.
  - `DeleteUserDialog` gains the prop `isAdmin: boolean`.
  - e2e: `adminUsersPageOf(email: string): Promise<number>` and `gotoAdminUserRow(page: Page, email: string): Promise<void>`
    (`e2e/admin-helpers.ts`); Task 7 uses the second.
  - DOM hooks: the Admin pill `data-admin-pill`; the footer sentence `data-users-foot`.

**Plan ruling** (spec §3.4 "`finalFocus` = the trigger when it is still in the document, else the page h1"): the
dialog closes (and `finalFocus` runs) *before* `router.refresh()` removes the deleted row, so at that moment the
trigger is still in the document and focus would go to it, then fall to `<body>` when the row goes. A successful
delete sets a ref and `finalFocus` returns the h1; otherwise the trigger if it is still in the document, else the h1.

**Plan ruling** (spec §3.4 "the fetch sits in try/catch/finally"): the shipped code catches only the `fetch()` call; a
connection that drops while the body is read (`res.json()`) escaped as an unhandled rejection. The whole request now
sits in one try with one catch, which raises the existing `Could not reach the server` toast word for word.

**Plan ruling** (the Admin pill's e2e): the allowlisted account was created long ago, so its row is on a late page of
a newest-first list. `adminUsersPageOf` counts the rows ordered before it with `adminListUsers`' own order
(`created_at desc, id desc`); `gotoAdminUserRow` tries that page and its two neighbours (a user with two memberships
fans out into two rows, so the count can be one off).

- [ ] **Step 1: Write the failing tests**

`src/components/admin/pager-link.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PagerLink } from './pager-link';

describe('PagerLink (C6 spec §3.3, §6.4, Ruling 12)', () => {
  it('a page to go to is a 32 px link carrying its test id', () => {
    const html = renderToStaticMarkup(createElement(PagerLink, { href: '/admin/users?page=2', label: 'Next', testId: 'x-next' }));
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/admin/users?page=2"');
    expect(html).toContain('data-testid="x-next"');
    expect(html).toContain('h-8');
    expect(html).toContain('>Next</a>');
  });
  it('an end is an aria-disabled span of the same size, with no test id (admin-firmware counts the id as absent)', () => {
    const html = renderToStaticMarkup(createElement(PagerLink, { href: null, label: 'Newer', testId: 'fw-page-newer' }));
    expect(html).toMatch(/^<span /);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('data-testid');
    expect(html).toContain('background:var(--surface-2)');
    expect(html).toContain('color:var(--muted-2)');
    expect(html).toContain('>Newer</span>');
  });
});
```

`e2e/admin-helpers.ts` — change the drizzle import to `import { inArray, sql } from 'drizzle-orm';` and append:

```ts
/**
 * The /admin/users page that holds `email`'s row: the rows adminListUsers puts before it (created_at desc, id desc),
 * 50 to a page. A user with two memberships shows twice, so this can be one off; gotoAdminUserRow allows for that.
 */
export async function adminUsersPageOf(email: string): Promise<number> {
  const { rows } = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n from auth."user" u, auth."user" a
    where a.email = ${email} and (u.created_at > a.created_at or (u.created_at = a.created_at and u.id > a.id))`);
  return Math.floor(Number(rows[0]?.n ?? 0) / ADMIN_PER_PAGE) + 1;
}

/** Open the Users page that shows `email`'s row (that page, else a neighbour); throws when none does. */
export async function gotoAdminUserRow(page: Page, email: string): Promise<void> {
  const p = await adminUsersPageOf(email);
  for (const n of [p, p + 1, p - 1].filter((x) => x >= 1)) {
    await page.goto(`/admin/users?page=${n}`);
    if (await page.getByTestId(`user-row-${email}`).count()) return;
  }
  throw new Error(`no /admin/users page shows ${email}`);
}
```

`e2e/c6-admin-layout.spec.ts` — the imports become:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin, SUPERADMIN_EMAIL, gotoAdminUserRow } from './admin-helpers';
import { cleanupSeeded, cleanupTestReleases, hydrated } from './device-helpers';
```

and append:

```ts
// ---- Users (spec §3, Rulings 7–12) ------------------------------------------------------------------------

test("Users: the board's columns, the Admin pill with a Delete… that does nothing, the footer and the pager", async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  await expect(page.getByText(/^\d+ users · newest first · page 1 of \d+$/)).toBeVisible();
  await expect(page.locator('section[aria-label="Users"] th'))
    .toHaveText(['Email', 'Organization', 'Joined', 'Titles', 'Disks', 'Boards', 'Action']);
  await expect(page.locator('[data-users-foot]')).toHaveText(
    'Deleting a user removes their organization, titles, disks and boards. Disk images are kept: other libraries may share them.');
  // Page 1: Previous is a disabled span (both values: a word in each), Next a link.
  await expect(page.getByRole('link', { name: 'Previous' })).toHaveCount(0);
  await expect(page.getByText('Previous', { exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/admin/users?page=2');

  // An ordinary row has no pill and an armed Delete….
  const other = page.getByTestId('admin-user-row').filter({ hasNot: page.locator('[data-admin-pill]') }).first();
  await expect(other.locator('[data-testid^="delete-user-"]')).toHaveText('Delete…');
  await expect(other.locator('[data-testid^="delete-user-"]')).not.toHaveAttribute('aria-disabled', 'true');

  // The allowlisted account: the pill says why, and Delete… neither clicks nor Enters into the dialog.
  await gotoAdminUserRow(page, SUPERADMIN_EMAIL);
  await expect(page.getByTestId(`user-row-${SUPERADMIN_EMAIL}`).locator('[data-admin-pill]')).toHaveText('Admin');
  const del = page.getByTestId(`delete-user-${SUPERADMIN_EMAIL}`);
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await expect(del).toHaveAttribute('title', 'An admin account cannot be deleted');
  await hydrated(page, `delete-user-${SUPERADMIN_EMAIL}`);
  await del.click({ force: true });   // force: Playwright waits forever for an aria-disabled control to enable
  await del.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('delete-user-dialog')).toHaveCount(0);
});

test('Delete…: the dialog opens on the field, Escape returns to the trigger, a failure keeps it open, a delete leaves focus on the heading', async ({ page }) => {
  const victim = await signUpFresh(page);
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  const id = `delete-user-${victim.email}`;
  const trigger = page.getByTestId(id);
  await hydrated(page, id);
  await trigger.click();
  const dialog = page.getByTestId('delete-user-dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete this account?' })).toBeVisible();
  await expect(dialog).toContainText(victim.email);
  await expect(page.getByLabel('Type the email to confirm')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // A server failure: the toast, the dialog stays, the button reads Delete permanently again.
  await page.route(`**/api/admin/users/**`, (r) => r.fulfill({ status: 500, body: '' }));
  await trigger.click();
  await page.getByLabel('Type the email to confirm').fill(victim.email);
  const confirm = dialog.getByRole('button', { name: /delete permanently/i });
  await confirm.click();
  await expect(page.getByText('Could not delete the user')).toBeVisible();
  await expect(confirm).toHaveText('Delete permanently');
  await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
  await page.unroute(`**/api/admin/users/**`);

  await confirm.click();
  await expect(page.getByTestId(`user-row-${victim.email}`)).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/components/admin/pager-link.test.ts`
Expected: FAIL — `Cannot find module './pager-link'`.

Run: `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Users:|Delete…:"`
Expected: FAIL — the column heads read `Games … Devices`; `[data-users-foot]` not found.

- [ ] **Step 3: Implement**

`src/components/admin/page-heading.ts`:

```ts
/** The page's h1: where focus goes when the control that held it is removed (C6 spec §8). Client-side only. */
export function pageHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>('h1');
}
```

`src/components/admin/pager-link.tsx`:

```tsx
import { Link } from '@/components/shell/link';

const BOX = 'inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] font-medium';

/**
 * One pager end (C6 spec §3.3, §6.4, Ruling 12): a link to the page, or at an end an aria-disabled span of the same
 * size -- a disabled link is not a thing, and admin-guard clicks `link 'Next'`. The span never carries the test id:
 * admin-firmware counts `fw-page-newer` as absent on page 1.
 */
export function PagerLink({ href, label, testId }: { href: string | null; label: string; testId?: string }) {
  if (href === null) {
    return (
      <span aria-disabled="true" className={BOX}
            style={{ background: 'var(--surface-2)', color: 'var(--muted-2)', border: '1px solid var(--line)' }}>
        {label}
      </span>
    );
  }
  return (
    // Colours as classes: an inline background would beat the hover.
    <Link href={href} data-testid={testId}
          className={`${BOX} border border-(--line) bg-(--surface) text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)`}>
      {label}
    </Link>
  );
}
```

`src/components/admin/delete-user-dialog.tsx` (whole file):

```tsx
'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { pageHeading } from '@/components/admin/page-heading';

/**
 * Confirmation for the one irreversible action in this app, on the shared Modal (C6 spec §3.4, Ruling 7).
 *
 * A CENTERED modal, not a popup anchored to the row's button. Plan 3b's rulings record a real wrong-target bug from
 * the latter shape: an open dropdown covered the NEXT row's Mount button, so clicking what looked like disk 2's
 * control silently acted on disk 1. That failure mode is intolerable here -- the action is a permanent delete -- so
 * nothing is drawn over the table's other rows.
 *
 * The typed-email gate is the real protection: the operator must type THIS row's address exactly, so even a
 * mis-aimed click cannot delete the wrong account. The blast radius is named in numbers, because "delete user"
 * understates what actually goes.
 *
 * An allowlisted address (`isAdmin`, decided on the server) gets an aria-disabled trigger that does nothing; the
 * server's 409 stays as the backstop (Ruling 10).
 */
export function DeleteUserDialog({
  userId, email, games, disks, devices, orgName, isAdmin,
}: {
  userId: string; email: string; games: number; disks: number; devices: number; orgName: string | null;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Set by a successful delete: the row (and this trigger) goes with the refresh that lands AFTER the dialog closes,
  // so the h1 takes focus rather than a trigger about to vanish (Plan ruling, Task 3).
  const deleted = useRef(false);

  // Exact match. Not trimmed and not case-folded: this is a confirmation gesture, and making it forgiving is making
  // it easier to do by accident.
  const armed = typed === email;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setTyped('');
  }

  function finalFocus(): HTMLElement | null {
    if (deleted.current) return pageHeading();
    return trigger.current && document.contains(trigger.current) ? trigger.current : pageHeading();
  }

  async function onDelete() {
    if (!armed || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (res.status === 409) {
        toast.error('That account is allowlisted', {
          description: 'Deleting it would free an admin address for whoever registers it next.',
        });
        return;
      }
      if (!res.ok) {
        toast.error('Could not delete the user', { description: `The server answered ${res.status}.` });
        return;
      }
      const removed = await res.json();
      toast.success(`Deleted ${email}`, {
        description: `${removed.games} games, ${removed.disks} disks, ${removed.devices} devices.`,
      });
      deleted.current = true;
      setOpen(false);
      setTyped('');
      router.refresh();
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid={`delete-user-${email}`}
        aria-label={`Delete ${email}`}
        aria-disabled={isAdmin ? 'true' : undefined}
        title={isAdmin ? 'An admin account cannot be deleted' : undefined}
        onClick={() => { if (isAdmin) return; deleted.current = false; setOpen(true); }}
        className="h-[34px] rounded-[9px] px-3 text-[13px] font-medium text-(--danger-fg) hover:bg-(--danger-bg) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) aria-disabled:cursor-default aria-disabled:text-(--muted-2) aria-disabled:hover:bg-transparent"
      >
        Delete…
      </button>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        width={440}
        testId="delete-user-dialog"
        closeTestId="delete-user-close"
        title="Delete this account?"
        subtitle={<span className="font-mono [overflow-wrap:anywhere]">{email}</span>}
        dismissible={!busy}
        initialFocus={field}
        finalFocus={finalFocus}
        footer={(
          <div className="flex w-full items-center justify-end gap-2.5">
            <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) onOpenChange(false); }}
                    className="h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60">
              Cancel
            </button>
            {/* Native disabled is the typed gate (not focused while not armed); busy is aria-disabled + the guard. */}
            <button type="button" onClick={onDelete} disabled={!armed} aria-disabled={busy || undefined}
                    className="h-[38px] rounded-[10px] px-4 text-[13px] font-semibold text-white disabled:opacity-50 aria-disabled:opacity-60"
                    style={{ background: 'var(--danger-fg)' }}>
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        )}
      >
        <div className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--muted)' }}>
          <p>
            This permanently removes <strong>{email}</strong>
            {orgName ? <> and the organization <strong>{orgName}</strong></> : null}, along with{' '}
            <strong>{games}</strong> games, <strong>{disks}</strong> disks and{' '}
            <strong>{devices}</strong> devices. It cannot be undone.
          </p>
          <p>
            Stored disk images are <em>not</em> deleted — they are shared between
            organizations, so removing them would damage other libraries.
          </p>
          <label htmlFor={`confirm-${userId}`} className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            Type the email to confirm
          </label>
          <input
            ref={field}
            id={`confirm-${userId}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="-mt-2 h-10 rounded-[10px] px-3 font-mono text-[13px]"
            style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
        </div>
      </Modal>
    </>
  );
}
```

`src/app/(admin)/admin/users/page.tsx` (whole file):

```tsx
import { adminListUsers, adminCountUsers } from '@/lib/admin-queries';
import { isSuperAdminEmail } from '@/lib/superadmin';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { DeleteUserDialog } from '@/components/admin/delete-user-dialog';
import { PagerLink } from '@/components/admin/pager-link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Users' };

const PER_PAGE = 50;
const NUM = 'px-3.5 py-3 text-right font-mono tabular-nums';

/**
 * Pagination is required, not decorative: the database holds thousands of users (nearly all of them e2e accounts),
 * and rendering them all would be a multi-megabyte response.
 *
 * `page` is clamped at both ends. A hand-typed `?page=0` or `?page=99999` is not an error worth a 404 -- it is a URL
 * someone edited -- so it resolves to the first or last page instead of an empty table that looks like data loss.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise. Do NOT import PageProps -- it is ambient.
  searchParams: Promise<{ page?: string }>;
}) {
  const total = await adminCountUsers();
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));

  const raw = Number.parseInt((await searchParams).page ?? '1', 10);
  const page = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), lastPage) : 1;

  const rows = await adminListUsers({ limit: PER_PAGE, offset: (page - 1) * PER_PAGE });

  return (
    <>
      <AdminPageHead title="Users" subtitle={`${total} users · newest first · page ${page} of ${lastPage}`} />
      <div className={ADMIN_BODY}>
        {/* Still a real table (Ruling 8): header association, and getByRole('row') semantics. It scrolls sideways
            inside the card on a narrow screen; the page does not. 760px is the seven columns at honest widths, and
            only a floor: a long e2e address is one unbreakable token unless it wraps, which it does. */}
        <section aria-label="Users" className="overflow-hidden rounded-[16px]"
                 style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[14px]" style={{ color: 'var(--ink)' }}>
              <thead>
                <tr className="h-11 border-b text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
                  <th scope="col" className="px-5 text-left font-medium">Email</th>
                  <th scope="col" className="px-3.5 text-left font-medium">Organization</th>
                  <th scope="col" className="w-[120px] px-3.5 text-left font-medium">Joined</th>
                  <th scope="col" className="w-[70px] px-3.5 text-right font-medium">Titles</th>
                  <th scope="col" className="w-[70px] px-3.5 text-right font-medium">Disks</th>
                  <th scope="col" className="w-20 px-3.5 text-right font-medium">Boards</th>
                  <th scope="col" className="w-[150px] px-3.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  // Server-side, on a page only admins see (Ruling 10): the allowlist never reaches a non-admin.
                  const isAdmin = isSuperAdminEmail(r.email);
                  return (
                    // The row keeps the countable testid plus a data-email hook; the email cell carries the per-email
                    // testid (one element cannot have both).
                    <tr key={r.userId} data-testid="admin-user-row" data-email={r.email}
                        className="border-b hover:bg-(--surface-2)" style={{ borderColor: 'var(--hairline)' }}>
                      <td className="px-5 py-3" data-testid={`user-row-${r.email}`}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="[overflow-wrap:anywhere]">{r.email}</span>
                          {isAdmin && (
                            <span data-admin-pill className="rounded-full px-[7px] py-px text-[11px] font-semibold"
                                  style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
                              Admin
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>
                        {/* Null when the organization bootstrap failed. Say so rather than rendering an empty cell --
                            this list is exactly where such an account should be visible. */}
                        {r.orgName ?? <span style={{ color: 'var(--amber-text)' }}>no organization</span>}
                      </td>
                      <td className="px-3.5 py-3 font-mono text-[13px]" style={{ color: 'var(--muted)' }}>
                        {r.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td className={NUM}>{r.games}</td>
                      <td className={NUM}>{r.disks}</td>
                      <td className={NUM}>{r.devices}</td>
                      <td className="px-3.5 py-3 text-right">
                        <DeleteUserDialog userId={r.userId} email={r.email} games={r.games} disks={r.disks}
                                          devices={r.devices} orgName={r.orgName} isAdmin={isAdmin} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-t px-5 py-2.5 text-[13px]"
               style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
            {/* Ruling 11: the dialog's own facts. Shared images are kept for good; unreferenced ones go weekly. */}
            <p data-users-foot>
              Deleting a user removes their organization, titles, disks and boards. Disk images are kept: other
              libraries may share them.
            </p>
            <div className="flex gap-1.5">
              <PagerLink href={page > 1 ? `/admin/users?page=${page - 1}` : null} label="Previous" />
              <PagerLink href={page < lastPage ? `/admin/users?page=${page + 1}` : null} label="Next" />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
```

(`[data-users-foot]`'s `toHaveText` normalises the line break in the JSX text to one space.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/components/admin/pager-link.test.ts` → PASS. Then `pnpm test`, `npx tsc --noEmit`, `pnpm lint`
(`0 errors, 12 warnings`).

e2e, one at a time (specs that select `admin-user-row`, `user-row-*`, `delete-user-*`, `Type the email to confirm`,
`Delete permanently`, `Previous` / `Next`):
1. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Users:|Delete…:"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/admin-delete.spec.ts --project=desktop` → `5 passed` (typed gate:
   `toBeDisabled` / `toBeEnabled` on the native gate).
3. `PORT=3100 npx playwright test e2e/collections.spec.ts --project=desktop -g "deleting a user deletes their collections"` → `1 passed`.
4. `PORT=3100 npx playwright test e2e/admin-guard.spec.ts --project=desktop -g "user list paginates|paging forward|out-of-range"` → `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/admin/users/page.tsx" src/components/admin/delete-user-dialog.tsx \
  src/components/admin/pager-link.tsx src/components/admin/pager-link.test.ts src/components/admin/page-heading.ts \
  e2e/admin-helpers.ts e2e/c6-admin-layout.spec.ts
git commit -m "C6 Users: the board's table with Titles and Boards, the Admin pill and its disabled Delete…, the footer and pager; the delete dialog on Modal with its focus rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 4: Invites — `InviteIssueProvider`, **Issue an invite**, the new-code panel, the none-live note, the table, Revoke's busy and focus

**Files:**
- Create: `src/components/admin/invite-issue.tsx`, `src/components/admin/copy-invite-buttons.test.ts`
- Modify: `src/components/admin/issue-invite-button.tsx` (whole file), `src/components/admin/revoke-invite-button.tsx`
  (whole file), `src/components/admin/copy-invite-buttons.tsx:10-42`, `src/app/(admin)/admin/invites/page.tsx` (whole
  file), `e2e/admin-invites.spec.ts:12`, `e2e/contrast.spec.ts:236`, `e2e/c6-admin-layout.spec.ts` (imports, append)

**Interfaces:**
- Consumes: `AdminPageHead`, `ADMIN_BODY` (Task 1); `pageHeading()` (Task 3); `type InviteState`
  (`@/lib/admin-queries`).
- Produces:
  - `InviteIssueProvider({ children })`, `useInviteIssue(): { code: string | null; setCode: (code: string) => void }`,
    `NewInvitePanel()` (`@/components/admin/invite-issue`)
  - `CopyInviteButtons` props `look?: 'row' | 'button'` (default `row`), `linkLabel?: string` (default `Copy link`)
  - DOM hook: each state pill carries `data-state="live|consumed|expired|revoked"` (Task 7 measures them).

**Plan ruling** (spec §4.2 "`new-invite-panel` … `role="status"`"): a live region that appears together with its
content is not reliably announced (the C5 lesson: "a live region from the start"). The panel itself takes no role; a
persistent `sr-only` `role="status"` span, rendered by `NewInvitePanel` from the first paint, reads
`New invite code ABCD2345, single use, expires in 7 days` after an issue. `sr-only` is absolutely positioned, so it
adds no gap to the page column.

**Plan ruling** (spec §4.3 "Focus: after a revoke … focus moves to the page h1"): the button unmounts with the
refresh, so the h1 takes focus as soon as the server says revoked (204) or used (409), before `router.refresh()`.
A failure keeps focus on the button.

- [ ] **Step 1: Write the failing tests**

`src/components/admin/copy-invite-buttons.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyInviteButtons } from './copy-invite-buttons';

describe('CopyInviteButtons look and linkLabel (C6 spec §4.2, §4.3, Ruling 18)', () => {
  it("a row's pair: 30 px, transparent, Copy code / Copy link, ids with the code", () => {
    const html = renderToStaticMarkup(createElement(CopyInviteButtons, { code: 'ABCD2345' }));
    expect(html).toContain('data-testid="invite-copy-code-ABCD2345"');
    expect(html).toContain('data-testid="invite-copy-link-ABCD2345"');
    expect(html).toContain('>Copy code</button>');
    expect(html).toContain('>Copy link</button>');
    expect(html.match(/h-\[30px\]/g)?.length).toBe(2);
  });
  it("the panel's pair: 38 px outline buttons, Copy sign-up link, ids without the code", () => {
    const html = renderToStaticMarkup(createElement(CopyInviteButtons, {
      code: 'ABCD2345', idPrefix: 'new-invite-copy', look: 'button', linkLabel: 'Copy sign-up link',
    }));
    expect(html).toContain('data-testid="new-invite-copy-code"');
    expect(html).toContain('data-testid="new-invite-copy-link"');
    expect(html).toContain('>Copy sign-up link</button>');
    expect(html.match(/h-\[38px\]/g)?.length).toBe(2);
    expect(html).toContain('border-(--line)');
  });
});
```

`e2e/admin-invites.spec.ts:12` — `{ name: /issue invite/i }` → `{ name: /issue an invite/i }`.
`e2e/contrast.spec.ts:236` — the same change.

`e2e/c6-admin-layout.spec.ts` — the imports become:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh, mintInviteCode } from './helpers';
import { signInAsSuperAdmin, SUPERADMIN_EMAIL, gotoAdminUserRow } from './admin-helpers';
import { cleanupSeeded, cleanupTestReleases, hydrated } from './device-helpers';
import { ALPHABET } from '@/lib/invites';
```

and append:

```ts
// ---- Invites (spec §4, Rulings 17–20) ---------------------------------------------------------------------

test('Invites: Issue an invite shows the new-code panel under the tabs; the none-live note follows the live count', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const sub = (await page.getByText(/^\d+ live · \d+ total · invite-only$/).textContent()) ?? '';
  const live = Number(/^(\d+) live/.exec(sub)?.[1]);
  await expect(page.getByTestId('invites-none-live')).toHaveCount(live === 0 ? 1 : 0);
  await expect(page.locator('section[aria-label="Invite codes"] th'))
    .toHaveText(['Code', 'State', 'Issued', 'Expires', 'Used by', 'Action']);
  await expect(page.getByTestId('new-invite-panel')).toHaveCount(0);

  const button = page.getByRole('button', { name: 'Issue an invite' });
  const panel = page.getByTestId('new-invite-panel');
  // No test id on the button (spec §10): retry the click until hydration has wired it.
  await expect(async () => {
    await button.click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(panel).toContainText('New code · single use · expires in 7 days');
  const code = (await page.getByTestId('new-invite-code').textContent())?.trim() ?? '';
  expect(code).toMatch(new RegExp(`^[${ALPHABET}]{8}$`));
  await expect(page.getByTestId('new-invite-copy-code')).toHaveText('Copy code');
  await expect(page.getByTestId('new-invite-copy-link')).toHaveText('Copy sign-up link');
  await expect(page.getByRole('status').filter({ hasText: `New invite code ${code}` })).toHaveCount(1);
  // Under the tabs, not beside the button.
  const tabs = (await page.getByTestId('admin-sections').boundingBox())!;
  expect((await panel.boundingBox())!.y).toBeGreaterThan(tabs.y + tabs.height - 1);
  await expect(button).toBeFocused();
  await expect(page.getByTestId('invites-none-live')).toHaveCount(0);
  await expect(page.getByTestId(`invite-${code}`).locator('[data-state]')).toHaveText('Live');
});

test('Invites: a dropped revoke keeps the button; a revoke leaves the row Revoked with no action and focus on the heading', async ({ page }) => {
  const code = await mintInviteCode();
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const revoke = page.getByTestId(`revoke-${code}`);
  await hydrated(page, `revoke-${code}`);

  await page.route(`**/api/admin/invites/${code}`, (r) => r.abort());
  await revoke.click();
  await expect(page.getByText('Could not reach the server')).toBeVisible();
  await expect(revoke).toHaveText('Revoke');
  await expect(revoke).not.toHaveAttribute('aria-disabled', 'true');
  await expect(revoke).toBeFocused();
  await page.unroute(`**/api/admin/invites/${code}`);

  await revoke.click();
  await expect(page.getByTestId(`invite-${code}`).locator('[data-state]')).toHaveText('Revoked');
  await expect(revoke).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/components/admin/copy-invite-buttons.test.ts`
Expected: FAIL — `expected undefined to be 2` (no `h-[30px]` yet) and no `Copy sign-up link`.

Run: `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Invites:"`
Expected: FAIL — the subtitle still reads `… registration is invite-only (D13)`; no `Issue an invite` button.

- [ ] **Step 3: Implement**

First re-run the rename grep (Global Constraints) and stop if it finds a reader the plan does not list:
`grep -rn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -i "issue invite" . | grep -v "^./docs/superpowers/"`
→ expected only the two e2e lines changed above (now `issue an invite`) and `src/components/admin/issue-invite-button.tsx`.

`src/components/admin/copy-invite-buttons.tsx` — the signature and the render become:

```tsx
/**
 * Copy code / Copy link for one invite. The link uses window.location.origin so a self-hosted instance copies its
 * own address. `look`: `row` (the table's 30 px transparent pair) or `button` (the new-code panel's 38 px outline
 * pair, C6 spec §4.2); `linkLabel` names the link button (the panel says `Copy sign-up link`, Ruling 18).
 */
export function CopyInviteButtons({ code, idPrefix, look = 'row', linkLabel = 'Copy link' }: {
  code: string; idPrefix?: string; look?: 'row' | 'button'; linkLabel?: string;
}) {
```

(the `tid`, `copied`, `timer`, `useEffect` and `copy` bodies stay as they are) and:

```tsx
  const cls = look === 'button'
    ? 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-3.5 text-[13px] font-medium text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)'
    : 'h-[30px] rounded-[8px] px-2.5 text-[13px] font-medium text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
  return (
    <span className={look === 'button' ? 'inline-flex flex-wrap items-center gap-2' : 'inline-flex items-center gap-1'}>
      <button type="button" onClick={() => copy('code')} data-testid={tid('code')} className={cls}>
        {copied === 'code' ? 'Copied' : 'Copy code'}
      </button>
      <button type="button" onClick={() => copy('link')} data-testid={tid('link')} className={cls}>
        {copied === 'link' ? 'Copied' : linkLabel}
      </button>
    </span>
  );
```

`src/components/admin/invite-issue.tsx`:

```tsx
'use client';

import { createContext, useContext, useState } from 'react';
import { CopyInviteButtons } from '@/components/admin/copy-invite-buttons';

type InviteIssue = { code: string | null; setCode: (code: string) => void };
const InviteIssueContext = createContext<InviteIssue | null>(null);

/**
 * The just-issued code, shared by the header's Issue an invite button and the panel under the tabs (C6 spec §4.1,
 * Ruling 18). Client state survives router.refresh(), so the code stays until the next issue or a reload.
 */
export function InviteIssueProvider({ children }: { children: React.ReactNode }) {
  const [code, setCode] = useState<string | null>(null);
  return <InviteIssueContext.Provider value={{ code, setCode }}>{children}</InviteIssueContext.Provider>;
}

export function useInviteIssue(): InviteIssue {
  const ctx = useContext(InviteIssueContext);
  if (!ctx) throw new Error('useInviteIssue outside InviteIssueProvider');
  return ctx;
}

/**
 * The status panel after an issue (C6 spec §4.2). The sr-only live region exists from the first paint so the code
 * is announced when it arrives (Plan ruling, Task 4); sr-only is absolute, so it takes no place in the column.
 */
export function NewInvitePanel() {
  const { code } = useInviteIssue();
  return (
    <>
      <span role="status" className="sr-only">
        {code ? `New invite code ${code}, single use, expires in 7 days` : ''}
      </span>
      {code && (
        <div data-testid="new-invite-panel" className="flex flex-wrap items-center gap-4 rounded-[14px] px-[18px] py-4"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--mounted-line)' }}>
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: 'var(--online-dot)' }} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px]" style={{ color: 'var(--muted)' }}>New code · single use · expires in 7 days</span>
            <span data-testid="new-invite-code" className="font-mono text-[22px] font-semibold tracking-[0.12em]"
                  style={{ color: 'var(--ink)' }}>{code}</span>
          </div>
          <span className="flex-1" />
          <CopyInviteButtons code={code} idPrefix="new-invite-copy" look="button" linkLabel="Copy sign-up link" />
        </div>
      )}
    </>
  );
}
```

`src/components/admin/issue-invite-button.tsx` (whole file):

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PlusIcon } from 'lucide-react';
import { useInviteIssue } from '@/components/admin/invite-issue';

/**
 * Issues a code (C6 spec §4.1, Ruling 17); the code shows in NewInvitePanel under the tabs. No countdown: an invite
 * lives seven days, so a ticking clock would be theatre. Busy is aria-disabled + the guard, so focus stays here.
 */
export function IssueInviteButton() {
  const { setCode } = useInviteIssue();
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/invites', { method: 'POST' });
      if (!res.ok) {
        toast.error('Could not issue an invite', { description: `The server answered ${res.status}.` });
        return;
      }
      const body = await res.json();
      setCode(body.code);
      router.refresh();
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} aria-disabled={busy || undefined}
            className="inline-flex h-[42px] items-center gap-2 rounded-[10px] px-[18px] text-[14px] font-semibold text-white aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
            style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
      <PlusIcon aria-hidden className="size-4" />
      {busy ? 'Issuing…' : 'Issue an invite'}
    </button>
  );
}
```

`src/components/admin/revoke-invite-button.tsx` (whole file):

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { pageHeading } from '@/components/admin/page-heading';

/** Revoke a live code (no confirm, as shipped: Ruling 20). The button goes with the refresh, so the h1 takes focus. */
export function RevokeInviteButton({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/invites/${code}`, { method: 'DELETE' });
      if (res.status === 409) {
        // Somebody signed up with it between the render and the click. Say so plainly: the code is gone as a
        // credential either way, but an account now exists because of it, and that is the operator's business.
        toast.error('Already used', { description: 'Someone signed up with this code, so it cannot be revoked.' });
        pageHeading()?.focus();
        router.refresh();
        return;
      }
      if (!res.ok && res.status !== 204) {
        toast.error('Could not revoke the code', { description: `The server answered ${res.status}.` });
        return;
      }
      toast.success(`Revoked ${code}`);
      pageHeading()?.focus();
      router.refresh();
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} aria-disabled={busy || undefined} data-testid={`revoke-${code}`}
            className="h-[30px] rounded-[8px] px-2.5 text-[13px] font-medium text-(--danger-fg) hover:bg-(--danger-bg) aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
      {busy ? 'Revoking…' : 'Revoke'}
    </button>
  );
}
```

`src/app/(admin)/admin/invites/page.tsx` (whole file):

```tsx
import { adminListInvites, type InviteState } from '@/lib/admin-queries';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { IssueInviteButton } from '@/components/admin/issue-invite-button';
import { InviteIssueProvider, NewInvitePanel } from '@/components/admin/invite-issue';
import { CopyInviteButtons } from '@/components/admin/copy-invite-buttons';
import { RevokeInviteButton } from '@/components/admin/revoke-invite-button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Invites' };

// Live first, then newest first -- adminListInvites orders it that way in SQL so this page never recomputes the
// state from three columns and disagrees with the query about which codes are actually usable. Sentence case;
// `Revoked` and `Used` are pinned (Ruling 19).
const STATE_LOOK: Record<InviteState, { label: string; bg: string; fg: string }> = {
  live: { label: 'Live', bg: 'var(--success-bg)', fg: 'var(--success-fg)' },
  consumed: { label: 'Used', bg: 'var(--track)', fg: 'var(--muted)' },
  expired: { label: 'Expired', bg: 'var(--surface-2)', fg: 'var(--muted-2)' },
  revoked: { label: 'Revoked', bg: 'var(--danger-bg)', fg: 'var(--danger-strong)' },
};
const TH = 'px-3.5 text-left font-medium';
const DATE = 'px-3.5 py-3 font-mono text-[13px]';

export default async function AdminInvitesPage() {
  const invites = await adminListInvites();
  const live = invites.filter((i) => i.state === 'live').length;

  return (
    <InviteIssueProvider>
      <AdminPageHead title="Invites" subtitle={`${live} live · ${invites.length} total · invite-only`}
                     actions={<IssueInviteButton />} />
      <div className={ADMIN_BODY}>
        <NewInvitePanel />
        {live === 0 && (
          // The other value ("N live") is the subtitle's.
          <div role="note" data-testid="invites-none-live" className="flex items-center gap-3 rounded-[14px] px-[18px] py-4 text-[14px]"
               style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}>
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: 'var(--fetch-dot)' }} />
            <span>No live invite codes. Nobody can sign up until one is issued — registration is invite-only by design.</span>
          </div>
        )}
        <section aria-label="Invite codes" className="overflow-hidden rounded-[16px]"
                 style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          {/* 880px: an eight-character code, a state pill, two ISO dates that must never wrap mid-token, an email with
              its consumed date, and three actions. It scrolls inside the card on a phone; the page does not. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-[14px]" style={{ color: 'var(--ink)' }}>
              <thead>
                <tr className="h-11 border-b text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
                  <th scope="col" className="px-5 text-left font-medium">Code</th>
                  <th scope="col" className={`${TH} w-[120px]`}>State</th>
                  <th scope="col" className={`${TH} w-[150px]`}>Issued</th>
                  <th scope="col" className={`${TH} w-[150px]`}>Expires</th>
                  <th scope="col" className={`${TH} w-[220px]`}>Used by</th>
                  <th scope="col" className="w-[240px] px-3.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {invites.length === 0 ? (
                  <tr data-testid="invites-empty">
                    <td colSpan={6} className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted)' }}>
                      No invite codes yet. Issue one to let someone sign up.
                    </td>
                  </tr>
                ) : invites.map((i) => {
                  const look = STATE_LOOK[i.state];
                  return (
                    <tr key={i.code} data-testid={`invite-${i.code}`} className="border-b" style={{ borderColor: 'var(--hairline)' }}>
                      <td className="px-5 py-3 font-mono text-[15px] tracking-[0.1em]">{i.code}</td>
                      <td className="px-3.5 py-3">
                        <span data-state={i.state} className="rounded-full px-[9px] py-0.5 text-[12px] font-semibold"
                              style={{ background: look.bg, color: look.fg }}>
                          {look.label}
                        </span>
                      </td>
                      <td className={DATE} style={{ color: 'var(--muted)' }}>{i.createdAt.toISOString().slice(0, 10)}</td>
                      <td className={DATE} style={{ color: 'var(--muted)' }}>{i.expiresAt.toISOString().slice(0, 10)}</td>
                      <td className="px-3.5 py-3" data-testid={`invite-used-by-${i.code}`}>
                        {i.state === 'consumed' ? (
                          <div className="flex flex-col">
                            <span className="text-[14px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{i.usedByEmail ?? '—'}</span>
                            {i.consumedAt && (
                              <span className="font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>
                                {i.consumedAt.toISOString().slice(0, 10)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--muted-2)' }}>—</span>
                        )}
                      </td>
                      <td className="px-3.5 py-3">
                        {/* Only a live code is revocable; a non-live row's state pill is the word. */}
                        {i.state === 'live' ? (
                          <span className="flex flex-wrap items-center justify-end gap-1">
                            <CopyInviteButtons code={i.code} />
                            <RevokeInviteButton code={i.code} />
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </InviteIssueProvider>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/components/admin/copy-invite-buttons.test.ts` → PASS. Then `pnpm test`, `npx tsc --noEmit`,
`pnpm lint` (`0 errors, 12 warnings`).

e2e, one at a time (specs that select `new-invite-*`, `invite-*`, `revoke-*`, the button name or the toasts):
1. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Invites:"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/admin-invites.spec.ts --project=desktop` → `10 passed`.
3. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "toast description is legible"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/invite-issue.tsx src/components/admin/issue-invite-button.tsx \
  src/components/admin/revoke-invite-button.tsx src/components/admin/copy-invite-buttons.tsx \
  src/components/admin/copy-invite-buttons.test.ts "src/app/(admin)/admin/invites/page.tsx" \
  e2e/admin-invites.spec.ts e2e/contrast.spec.ts e2e/c6-admin-layout.spec.ts
git commit -m "C6 Invites: Issue an invite with the new-code panel under the tabs, the none-live note, state pills, the board's column order; Revoke keeps focus on failure and hands it to the heading

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 5: Scan — `admin-scan-look.ts`, the three source cards, the status lines, the import cards with **Choose** buttons, the TOSEC sets card

**Files:**
- Create: `src/lib/admin-scan-look.ts`, `src/lib/admin-scan-look.test.ts`
- Modify: `src/app/(admin)/admin/scan/page.tsx` (whole file), `src/components/admin/run-scan-button.tsx` (whole file),
  `src/components/admin/dat-upload.tsx:7-99` (signature, guard, markup), `src/components/admin/openretro-upload.tsx:13-76`
  (same), `e2e/c6-admin-layout.spec.ts` (append)

**Interfaces:**
- Consumes: `AdminPageHead`, `ADMIN_BODY` (Task 1); `type ScanStatus` (`@/lib/tosec-sweep`, type only);
  `demozooStatusText`, `readTosecFetchState`, `readDemozooImportState`, `nowMs()`.
- Produces:
  - `plural(n: number, one: string, many: string) → string`
  - `interface Coverage { decided: number; matched: number; genuineNone: number; authoredDecided: number; recognisedPct: number | null; okW: number; missW: number }`
  - `scanCoverage(s: Pick<ScanStatus, 'matched' | 'none' | 'ambiguous' | 'unreadable' | 'authoredNone'>) → Coverage`
  - `enrichCoverage(s: Pick<ScanStatus, 'enriched' | 'enrichNone' | 'enrichAmbiguous'>) → Coverage`
  - `type ScanNoteKind = 'unchecked' | 'unreadable' | 'no-openretro' | 'enrich' | 'done'`;
    `scanNotes(s: Pick<ScanStatus, 'unchecked' | 'unreadable' | 'openretroEntries' | 'enrichUnchecked'>) → { kind: ScanNoteKind; text: string }[]`
    (all `@/lib/admin-scan-look`)
  - `DatUpload({ labelledBy: string })`, `OpenRetroUpload({ labelledBy: string })`
  - DOM hooks (Task 7): a card's source line `data-source`, a count's label `data-count-label`.

**Plan ruling** (spec §5.3, singular forms): the table gives the plural words only; one blob reads `1 blob could not
be read from storage and was stamped hashed with no hash — it always reports as no match, not a genuine TOSEC miss.`
and `1 blob still to enrich. …`; `unchecked` already names its singular.

**Plan ruling** (spec §5.4, OpenRetro busy): as the DAT card, the trigger reads `Importing…` while busy and the
status line beside it says `Importing — a full Amiga.sqlite takes about a minute…`. Each card's `role="status"` line
is rendered from the first paint, empty while idle (a live region from the start).

**Plan ruling** (spec §5.4, "the trigger … calls `input.click()`"): the import logic (sequential files, one bad file
does not stop the rest, a network failure stops the run, the toasts, the `finally` reset) is kept verbatim; only the
markup, the busy guard (`onChange` returns while busy) and the removal of native `disabled` on the input change.

- [ ] **Step 1: Write the failing tests**

`src/lib/admin-scan-look.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scanCoverage, enrichCoverage, scanNotes, plural } from '@/lib/admin-scan-look';

describe('scanCoverage (C6 spec §5.6, Ruling 22): the page arithmetic, moved verbatim', () => {
  it('takes the unreadable and self-made blobs out of `none` and out of `decided`', () => {
    const c = scanCoverage({ matched: 46, none: 50, ambiguous: 4, unreadable: 2, authoredNone: 3 });
    expect(c).toMatchObject({ decided: 95, matched: 46, genuineNone: 45, authoredDecided: 3, recognisedPct: 48 });
    expect(c.okW).toBeCloseTo((46 / 95) * 100, 6);
    expect(c.missW).toBeCloseTo((45 / 95) * 100, 6);
  });
  it('the min() caps: more unreadable than none, and self-made capped by what is left', () => {
    const c = scanCoverage({ matched: 10, none: 4, ambiguous: 1, unreadable: 9, authoredNone: 5 });
    expect(c).toMatchObject({ genuineNone: 0, authoredDecided: 0, decided: 11 });
    expect(scanCoverage({ matched: 0, none: 6, ambiguous: 0, unreadable: 2, authoredNone: 9 }))
      .toMatchObject({ authoredDecided: 4, genuineNone: 0, decided: 0, recognisedPct: null });
  });
  it('nothing decided: no percentage and empty bars', () => {
    expect(scanCoverage({ matched: 0, none: 0, ambiguous: 0, unreadable: 0, authoredNone: 0 }))
      .toEqual({ decided: 0, matched: 0, genuineNone: 0, authoredDecided: 0, recognisedPct: null, okW: 0, missW: 0 });
  });
});

describe('enrichCoverage', () => {
  it('enriched over enriched + not in OpenRetro + ambiguous', () => {
    expect(enrichCoverage({ enriched: 30, enrichNone: 8, enrichAmbiguous: 2 }))
      .toMatchObject({ decided: 40, matched: 30, genuineNone: 8, authoredDecided: 0, recognisedPct: 75, okW: 75, missW: 20 });
    expect(enrichCoverage({ enriched: 0, enrichNone: 0, enrichAmbiguous: 0 }).recognisedPct).toBeNull();
  });
});

describe('scanNotes (C6 spec §5.3, Ruling 24)', () => {
  const quiet = { unchecked: 0, unreadable: 0, openretroEntries: 100, enrichUnchecked: 0 };
  it('done, and only done, when nothing is left', () => {
    expect(scanNotes(quiet)).toEqual([{ kind: 'done', text: 'Every blob is processed; the nightly run picks up new uploads.' }]);
  });
  it('every note that applies, in order, with the board words', () => {
    expect(scanNotes({ unchecked: 3, unreadable: 12, openretroEntries: 0, enrichUnchecked: 40 })).toEqual([
      { kind: 'unchecked', text: '3 blobs still to process. Each run is bounded and resumable — run it again, or leave it to the nightly run.' },
      { kind: 'unreadable', text: '12 blobs could not be read from storage and were stamped hashed with no hash — they always report as no match, not a genuine TOSEC miss.' },
      { kind: 'no-openretro', text: 'No OpenRetro metadata loaded. Nothing can be enriched until an Amiga.sqlite is uploaded below.' },
    ]);
    expect(scanNotes({ ...quiet, enrichUnchecked: 40 })).toEqual([
      { kind: 'enrich', text: '40 blobs still to enrich. Image fetching is capped per run on purpose, so a first pass over a large library takes several runs — or several nights.' },
    ]);
  });
  it('one blob reads in the singular', () => {
    expect(scanNotes({ unchecked: 1, unreadable: 1, openretroEntries: 5, enrichUnchecked: 1 }).map((n) => n.text)).toEqual([
      '1 blob still to process. Each run is bounded and resumable — run it again, or leave it to the nightly run.',
      '1 blob could not be read from storage and was stamped hashed with no hash — it always reports as no match, not a genuine TOSEC miss.',
      '1 blob still to enrich. Image fetching is capped per run on purpose, so a first pass over a large library takes several runs — or several nights.',
    ]);
  });
  it('plural', () => {
    expect(plural(1, 'disk', 'disks')).toBe('disk');
    expect(plural(0, 'disk', 'disks')).toBe('disks');
    expect(plural(2, 'disk', 'disks')).toBe('disks');
  });
});
```

`e2e/c6-admin-layout.spec.ts` — append:

```ts
// ---- Scan (spec §5, Rulings 21–26) ------------------------------------------------------------------------

test('Scan: three source cards with every count, the status lines, Choose buttons over hidden inputs, the sets card', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/scan');
  await expect(page.getByTestId('run-scan')).toHaveText('Run now');
  const identity = page.getByTestId('scan-identity');
  await expect(identity.getByRole('heading', { name: 'Identity' })).toBeVisible();
  await expect(identity.locator('[data-source]')).toHaveText(/^TOSEC · \d+ entries$/);
  await expect(identity).toContainText(/(\d+% recognised|— nothing decided yet)/);
  for (const id of ['scan-blobs', 'scan-hashed', 'scan-matched', 'scan-none', 'scan-ambiguous', 'scan-unreadable', 'scan-unchecked']) {
    await expect(identity.getByTestId(id)).toHaveText(/^\d+$/);
  }
  const details = page.getByTestId('scan-details');
  await expect(details.getByTestId('scan-openretroEntries')).toHaveText(/^\d+$/);
  for (const id of ['scan-enriched', 'scan-enrichNone', 'scan-enrichAmbiguous', 'scan-enrichUnchecked', 'scan-imagesStored']) {
    await expect(details.getByTestId(id)).toHaveText(/^\d+$/);
  }
  await expect(details.getByTestId('scan-imageMb')).toHaveText(/^\d+\.\d MB$/);
  await expect(page.getByTestId('scan-demos').getByTestId('demozoo-status')).toHaveText(/^Demozoo:/);

  // The status lines follow the counts on the page (both values of "anything left to do").
  const notes = page.getByTestId('scan-notes');
  await expect(notes).toHaveAttribute('role', 'status');
  const kinds = await notes.getByTestId('scan-note').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  const unchecked = Number(await page.getByTestId('scan-unchecked').textContent());
  const unreadable = Number(await page.getByTestId('scan-unreadable').textContent());
  expect(kinds.includes('unchecked')).toBe(unchecked > 0);
  expect(kinds.includes('unreadable')).toBe(unreadable > 0);
  expect(kinds.includes('done')).toBe(kinds.length === 1 && kinds[0] === 'done');

  // The Choose buttons are the tab stops; the inputs are not.
  await expect(page.getByTestId('dat-upload')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByTestId('openretro-upload')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByTestId('dat-choose')).toHaveText('Choose .dat files');
  await expect(page.getByTestId('openretro-choose')).toHaveText('Choose Amiga.sqlite');
  await hydrated(page, 'dat-choose');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('dat-choose').click();
  expect((await chooser).isMultiple()).toBe(true);
  await expect(page.getByTestId('tosec-fetch-status')).toContainText('TOSEC:');
  await expect(page.getByTestId('openretro-hint')).toContainText('Run FS-UAE Launcher once');

  await expect(page.getByRole('heading', { name: 'TOSEC sets' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="sets-heading"] th')).toHaveText(['Set', 'Version', 'Entries']);
  await expect(page.getByRole('heading', { name: /scan/i })).toHaveCount(1);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/lib/admin-scan-look.test.ts`
Expected: FAIL — `Cannot find module '@/lib/admin-scan-look'`.

Run: `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Scan:"`
Expected: FAIL — `scan-identity` not found.

- [ ] **Step 3: Implement**

`src/lib/admin-scan-look.ts`:

```ts
// The admin Scan page's rules (C6 spec §5.6): pure and client-safe. The coverage arithmetic is the page's, moved
// verbatim (A7 and the TOSEC scan design), so the card's "% recognised" uses the same corrected `decided`.
import type { ScanStatus } from '@/lib/tosec-sweep';

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface Coverage {
  decided: number; matched: number; genuineNone: number; authoredDecided: number;
  /** matched / decided, rounded; null with nothing decided. */
  recognisedPct: number | null;
  /** The bar's two fills, in percent of the track. */
  okW: number; missW: number;
}

function withWidths(c: Pick<Coverage, 'decided' | 'matched' | 'genuineNone' | 'authoredDecided'>): Coverage {
  if (c.decided <= 0) return { ...c, recognisedPct: null, okW: 0, missW: 0 };
  return {
    ...c,
    recognisedPct: Math.round((c.matched / c.decided) * 100),
    okW: (c.matched / c.decided) * 100,
    missW: (c.genuineNone / c.decided) * 100,
  };
}

export function scanCoverage(s: Pick<ScanStatus, 'matched' | 'none' | 'ambiguous' | 'unreadable' | 'authoredNone'>): Coverage {
  // A blob whose bytes could not be read is stamped hashed (so the sweeper does not spin on it forever) with null
  // hashes, and phase 2's short circuit then always files it under match_state = 'none' -- so `none` conflates
  // "TOSEC does not know this disk" with "the object store failed us". Every checked-unreadable blob is counted in
  // both `none` and `unreadable`; subtracting min(unreadable, none) removes exactly that overlap (capped so a
  // still-unchecked unreadable blob, not yet folded into `none`, cannot drive the count negative).
  const unreadableDecided = Math.min(s.unreadable, s.none);
  // ...and the same treatment for disks somebody MADE here: a disk the operator authored is in no preservation set
  // and never will be, so counting it would report their own work as a gap in the archive. Capped against what is
  // left after the unreadable subtraction so the two corrections cannot overlap into a negative count.
  const authoredDecided = Math.min(s.authoredNone, Math.max(0, s.none - unreadableDecided));
  const excluded = unreadableDecided + authoredDecided;
  const genuineNone = s.none - excluded;
  const decided = s.matched + s.none + s.ambiguous - excluded;
  return withWidths({ decided, matched: s.matched, genuineNone, authoredDecided });
}

export function enrichCoverage(s: Pick<ScanStatus, 'enriched' | 'enrichNone' | 'enrichAmbiguous'>): Coverage {
  return withWidths({
    decided: s.enriched + s.enrichNone + s.enrichAmbiguous, matched: s.enriched, genuineNone: s.enrichNone,
    authoredDecided: 0,
  });
}

export type ScanNoteKind = 'unchecked' | 'unreadable' | 'no-openretro' | 'enrich' | 'done';

/** Every status line that applies, in this order; `done` alone when none does (Ruling 24). */
export function scanNotes(
  s: Pick<ScanStatus, 'unchecked' | 'unreadable' | 'openretroEntries' | 'enrichUnchecked'>,
): { kind: ScanNoteKind; text: string }[] {
  const out: { kind: ScanNoteKind; text: string }[] = [];
  if (s.unchecked > 0) {
    out.push({ kind: 'unchecked', text: `${s.unchecked} ${plural(s.unchecked, 'blob', 'blobs')} still to process. Each run is bounded and resumable — run it again, or leave it to the nightly run.` });
  }
  if (s.unreadable > 0) {
    const one = s.unreadable === 1;
    out.push({ kind: 'unreadable', text: `${s.unreadable} ${one ? 'blob' : 'blobs'} could not be read from storage and ${one ? 'was' : 'were'} stamped hashed with no hash — ${one ? 'it always reports' : 'they always report'} as no match, not a genuine TOSEC miss.` });
  }
  if (s.openretroEntries === 0) {
    out.push({ kind: 'no-openretro', text: 'No OpenRetro metadata loaded. Nothing can be enriched until an Amiga.sqlite is uploaded below.' });
  } else if (s.enrichUnchecked > 0) {
    out.push({ kind: 'enrich', text: `${s.enrichUnchecked} ${plural(s.enrichUnchecked, 'blob', 'blobs')} still to enrich. Image fetching is capped per run on purpose, so a first pass over a large library takes several runs — or several nights.` });
  }
  if (out.length === 0) out.push({ kind: 'done', text: 'Every blob is processed; the nightly run picks up new uploads.' });
  return out;
}
```

`src/components/admin/run-scan-button.tsx` (whole file):

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PlayIcon } from 'lucide-react';

/** Run now (C6 spec §5.1, Ruling 21: the words stay after a run). Busy is aria-disabled + the guard; no confirm (Ruling 20). */
export function RunScanButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/scan', { method: 'POST' });
      if (!res.ok) {
        toast.error('The scan failed', { description: `The server answered ${res.status}.` });
        return;
      }
      const r = await res.json();
      toast.success(
        r.done ? 'Scan complete' : 'Batch done — more to do',
        {
          description: `${r.hashed} hashed · ${r.matched} matched · ${r.none} unmatched · `
            + `${r.ambiguous} ambiguous · ${r.merged} merged`,
        },
      );
      router.refresh();
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} aria-disabled={busy || undefined} data-testid="run-scan"
            className="inline-flex h-[42px] items-center gap-2 rounded-[10px] px-[18px] text-[14px] font-semibold text-white aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
            style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
      <PlayIcon aria-hidden className="size-3.5" />
      {/* A pass is bounded at ~240 s, so say it is working rather than looking hung. */}
      {busy ? 'Scanning…' : 'Run now'}
    </button>
  );
}
```

`src/components/admin/dat-upload.tsx` — `export function DatUpload() {` becomes
`export function DatUpload({ labelledBy }: { labelledBy: string }) {`; the first line of `onChange` becomes
`if (busy) return;` followed by the existing `const files = …` (the rest of `onChange` is unchanged); the returned
markup becomes:

```tsx
  return (
    <div className="flex flex-col gap-2.5">
      {/* Hidden, not a tab stop: the Choose button is (C6 spec §5.4, Ruling 25). setInputFiles still reaches it. */}
      <input
        ref={input}
        type="file"
        accept=".dat,.xml"
        multiple
        onChange={onChange}
        data-testid="dat-upload"
        className="sr-only"
        tabIndex={-1}
        aria-labelledby={labelledBy}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="dat-choose" aria-disabled={busy || undefined}
                onClick={() => { if (!busy) input.current?.click(); }}
                className="h-10 rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[14px] font-medium text-(--ink) hover:bg-(--track) aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
          {busy ? 'Importing…' : 'Choose .dat files'}
        </button>
        {/* A live region from the first paint, empty while idle. */}
        <span role="status" className="text-[13px]" style={{ color: 'var(--muted)' }}>
          {busy ? `Importing ${progress ?? '…'}` : ''}
        </span>
      </div>
    </div>
  );
```

`src/components/admin/openretro-upload.tsx` — `export function OpenRetroUpload() {` becomes
`export function OpenRetroUpload({ labelledBy }: { labelledBy: string }) {`; the first line of `onChange` becomes
`if (busy) return;` followed by the existing `const file = …` (the rest unchanged); the returned markup becomes:

```tsx
  return (
    <div className="flex flex-col gap-2.5">
      <input
        ref={input}
        type="file"
        accept=".sqlite"
        onChange={onChange}
        data-testid="openretro-upload"
        className="sr-only"
        tabIndex={-1}
        aria-labelledby={labelledBy}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="openretro-choose" aria-disabled={busy || undefined}
                onClick={() => { if (!busy) input.current?.click(); }}
                className="h-10 rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[14px] font-medium text-(--ink) hover:bg-(--track) aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
          {busy ? 'Importing…' : 'Choose Amiga.sqlite'}
        </button>
        <span role="status" className="text-[13px]" style={{ color: 'var(--muted)' }}>
          {busy ? 'Importing — a full Amiga.sqlite takes about a minute…' : ''}
        </span>
      </div>
    </div>
  );
```

`src/app/(admin)/admin/scan/page.tsx` (whole file):

```tsx
import { scanStatus } from '@/lib/tosec-sweep';
import { nowMs } from '@/lib/clock';
import { readTosecFetchState } from '@/lib/tosec-fetch';
import { readDemozooImportState } from '@/lib/demozoo/import';
import { demozooStatusText } from '@/lib/demozoo/status';
import { scanCoverage, enrichCoverage, scanNotes, plural, type Coverage, type ScanNoteKind } from '@/lib/admin-scan-look';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { DatUpload } from '@/components/admin/dat-upload';
import { RunScanButton } from '@/components/admin/run-scan-button';
import { OpenRetroUpload } from '@/components/admin/openretro-upload';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Scan' };

const CARD = 'flex flex-col gap-3.5 rounded-[20px] p-5';
const CARD_STYLE = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' } as const;
type Tone = 'ok' | 'miss' | 'plain';
const SQUARE: Record<Tone, string> = { ok: 'var(--bar-ok)', miss: 'var(--fetch-dot)', plain: 'var(--dash)' };
const NOTE_DOT: Record<ScanNoteKind, string> = {
  unchecked: 'var(--fetch-dot)', unreadable: 'var(--danger-fg)', 'no-openretro': 'var(--dash)', enrich: 'var(--dash)',
  done: 'var(--online-dot)',
};

function CardHead({ id, title, source }: { id: string; title: string; source: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id={id} className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h2>
      <span data-source className="font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>{source}</span>
    </div>
  );
}

function Figure({ c }: { c: Coverage }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[40px] font-bold leading-none" style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
        {c.recognisedPct === null ? '—' : `${c.recognisedPct}%`}
      </span>
      <span className="text-[18px]" style={{ color: 'var(--muted-2)' }}>
        {c.recognisedPct === null ? ' nothing decided yet' : ' recognised'}
      </span>
    </div>
  );
}

/** Decoration beside the figure and the counts (they carry the values). */
function Bar({ c }: { c: Coverage }) {
  return (
    <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
      <span style={{ width: `${c.okW}%`, background: 'var(--bar-ok)' }} />
      <span style={{ width: `${c.missW}%`, background: 'var(--fetch-dot)' }} />
    </div>
  );
}

function Count({ label, id, value, tone = 'plain' }: { label: string; id: string; value: number; tone?: Tone }) {
  return (
    <div className="flex justify-between gap-2 text-[13px]">
      <span data-count-label className="flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
        <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: SQUARE[tone] }} />
        {label}
      </span>
      <span data-testid={id} className="font-mono tabular-nums" style={{ color: 'var(--ink)' }}>{value}</span>
    </div>
  );
}

export default async function AdminScanPage() {
  const s = await scanStatus();
  // The table may not exist yet (deploy before migration): the page must not 500 over a status line.
  const fetchState = await readTosecFetchState().catch(() => null);
  // null = never fetched; 'unreadable' = the read failed. Distinct on purpose.
  const demozooState = await readDemozooImportState().catch(() => 'unreadable' as const);
  const now = nowMs();   // read once per request (Ruling 3)
  const identity = scanCoverage(s);
  const details = enrichCoverage(s);
  const notes = scanNotes(s);

  return (
    <>
      <AdminPageHead
        title="Scan"
        subtitleFont="sans"
        subtitle="Recognises disks against TOSEC, then fills in years, publishers and covers from OpenRetro and Demozoo."
        actions={<RunScanButton />}
      />
      <div className={ADMIN_BODY}>
        {/* Three source cards (Rulings 22, 23); every count keeps its id and holds only the digits. */}
        <div className="grid gap-5 lg:grid-cols-3">
          <section aria-labelledby="identity-heading" data-testid="scan-identity" className={CARD} style={CARD_STYLE}>
            <CardHead id="identity-heading" title="Identity" source={`TOSEC · ${s.tosecEntries} entries`} />
            <Figure c={identity} />
            <Bar c={identity} />
            {/* Named rather than silently deducted: a rate that quietly excludes things is a rate nobody can check. */}
            {identity.authoredDecided > 0 && (
              <span data-testid="scan-excluded" className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
                {identity.authoredDecided} self-made {plural(identity.authoredDecided, 'disk', 'disks')} excluded
              </span>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Count label="Blobs" id="scan-blobs" value={s.blobs} />
              <Count label="Hashed" id="scan-hashed" value={s.hashed} />
              <Count label="Matched" id="scan-matched" value={s.matched} tone="ok" />
              <Count label="No match" id="scan-none" value={s.none} tone="miss" />
              <Count label="Ambiguous" id="scan-ambiguous" value={s.ambiguous} />
              <Count label="Unreadable" id="scan-unreadable" value={s.unreadable} />
              <Count label="Unchecked" id="scan-unchecked" value={s.unchecked} />
            </div>
          </section>

          <section aria-labelledby="details-heading" data-testid="scan-details" className={CARD} style={CARD_STYLE}>
            <CardHead id="details-heading" title="Details"
                      source={<>OpenRetro · <span data-testid="scan-openretroEntries">{s.openretroEntries}</span> entries</>} />
            <Figure c={details} />
            <Bar c={details} />
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Count label="Enriched" id="scan-enriched" value={s.enriched} tone="ok" />
              <Count label="Not in OpenRetro" id="scan-enrichNone" value={s.enrichNone} tone="miss" />
              <Count label="Ambiguous" id="scan-enrichAmbiguous" value={s.enrichAmbiguous} />
              <Count label="Unchecked" id="scan-enrichUnchecked" value={s.enrichUnchecked} />
              {/* The storage cost of copying someone else's images into our own store stays a number on the page. */}
              <div className="flex flex-col gap-0.5">
                <Count label="Images stored" id="scan-imagesStored" value={s.imagesStored} />
                <span data-testid="scan-imageMb" className="self-end text-[12px]" style={{ color: 'var(--muted-2)' }}>
                  {(s.imageBytes / (1024 * 1024)).toFixed(1)} MB
                </span>
              </div>
            </div>
          </section>

          <section aria-labelledby="demos-heading" data-testid="scan-demos" className={CARD} style={CARD_STYLE}>
            <CardHead id="demos-heading" title="Demos" source="Demozoo · weekly" />
            {/* No figure (Ruling 23): there is no per-blob Demozoo verdict to count. */}
            <p data-testid="demozoo-status" className="text-[14px] leading-[1.5]" style={{ color: 'var(--muted)' }}>
              {demozooStatusText(demozooState, now)}
            </p>
          </section>
        </div>

        <ul data-testid="scan-notes" role="status" className="flex flex-col gap-2 text-[14px]" style={{ color: 'var(--muted)' }}>
          {notes.map((n) => (
            <li key={n.kind} data-testid="scan-note" data-kind={n.kind} className="flex items-center gap-2.5">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: NOTE_DOT[n.kind] }} />
              <span style={n.kind === 'unreadable' ? { color: 'var(--amber-text)' } : undefined}>{n.text}</span>
            </li>
          ))}
        </ul>

        <div className="grid gap-5 md:grid-cols-2 md:items-start">
          <section aria-labelledby="dat-heading" className="flex flex-col items-start gap-2.5 rounded-[20px] p-5" style={CARD_STYLE}>
            <h2 id="dat-heading" className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>Import a TOSEC DAT</h2>
            <p className="text-[14px] leading-[1.5]" style={{ color: 'var(--muted)' }}>
              One or more .dat files, ClrMamePro or XML. Importing a set again updates it in place.
            </p>
            <DatUpload labelledBy="dat-heading" />
            <div className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid="tosec-fetch-status">
              {fetchState?.release ? (
                <div>
                  TOSEC: release {fetchState.release}
                  {fetchState.importedAt ? ` imported ${fetchState.importedAt.toISOString().slice(0, 10)}` : ''}
                </div>
              ) : (
                <div>TOSEC: not fetched yet — the monthly fetch runs on the 2nd</div>
              )}
              {(fetchState?.lastResult?.startsWith('TOSEC fetch failed:') || fetchState?.lastResult?.startsWith('failed:')) && (
                <div>
                  Last automatic fetch ({fetchState.lastAttemptAt?.toISOString().slice(0, 10)}): {fetchState.lastResult}
                </div>
              )}
            </div>
          </section>
          <section aria-labelledby="openretro-heading" className="flex flex-col items-start gap-2.5 rounded-[20px] p-5" style={CARD_STYLE}>
            <h2 id="openretro-heading" className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>Import OpenRetro metadata</h2>
            <p className="text-[14px] leading-[1.5]" style={{ color: 'var(--muted)' }}>
              The Amiga.sqlite that FS-UAE Launcher syncs. A newer sync updates entries in place.
            </p>
            <OpenRetroUpload labelledBy="openretro-heading" />
            <p className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid="openretro-hint">
              Run FS-UAE Launcher once to produce <strong>Amiga.sqlite</strong>; find it in FS-UAE&apos;s data folder and upload it here.
            </p>
          </section>
        </div>

        {/* The only place the loaded sets are listed (Ruling 26); admin-scan reads its rows by role. */}
        <section aria-labelledby="sets-heading" className="overflow-hidden rounded-[16px]" style={CARD_STYLE}>
          <h2 id="sets-heading" className="px-5 pb-3 pt-4 text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>TOSEC sets</h2>
          <div className="overflow-x-auto">
            {/* Two of the three columns are long single tokens ("Commodore Amiga - Games - [ADF]",
                "TOSEC-v2023-01-08"): 640px keeps both on one line and lets the card scroll on a phone. */}
            <table className="w-full min-w-[640px] text-[14px]" style={{ color: 'var(--ink)' }}>
              <thead>
                <tr className="h-11 border-b text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
                  <th scope="col" className="px-5 text-left font-medium">Set</th>
                  <th scope="col" className="px-3.5 text-left font-medium">Version</th>
                  <th scope="col" className="px-5 text-right font-medium">Entries</th>
                </tr>
              </thead>
              <tbody>
                {s.sets.length === 0 ? (
                  <tr>
                    <td className="px-5 py-3" colSpan={3} style={{ color: 'var(--muted)' }}>
                      No DAT sets loaded. Nothing can be matched until one is uploaded.
                    </td>
                  </tr>
                ) : (
                  s.sets.map((set) => (
                    <tr key={`${set.setName}:${set.setVersion}`} className="border-b" style={{ borderColor: 'var(--hairline)' }}>
                      <td className="px-5 py-3 [overflow-wrap:anywhere]">{set.setName}</td>
                      <td className="px-3.5 py-3 font-mono text-[13px]" style={{ color: 'var(--muted)' }}>{set.setVersion ?? '—'}</td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums" data-testid="set-entries">{set.entries}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/lib/admin-scan-look.test.ts` → PASS. Then `pnpm test`, `npx tsc --noEmit`, `pnpm lint`
(`0 errors, 12 warnings`).

Re-run the rename grep for the scan words and stop on a reader the plan does not list:
`grep -rn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -e "still to process" -e "not fetched yet" -e "Select one or more .dat" -e "Select the Amiga.sqlite" -e "of decided blobs unmatched" . | grep -v "^./docs/superpowers/"`
→ only `src/lib/admin-scan-look.ts` and `src/app/(admin)/admin/scan/page.tsx`.

e2e, one at a time (specs that select `scan-*`, `run-scan`, `demozoo-status`, `dat-upload`, `set-entries`, the sets
rows, `self-made disks excluded`, `heading /scan/i`):
1. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Scan:"` → `1 passed`.
2. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "sees the scan status page|Demozoo status line|non-admin cannot reach the scan|cron route refuses|import a DAT"` → `5 passed`.
3. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "run a scan by clicking Run now"` → `1 passed` (up to 280 s, alone).
4. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "excluded from the coverage rate"` → `1 passed` (up to 280 s, alone).

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-scan-look.ts src/lib/admin-scan-look.test.ts "src/app/(admin)/admin/scan/page.tsx" \
  src/components/admin/run-scan-button.tsx src/components/admin/dat-upload.tsx src/components/admin/openretro-upload.tsx \
  e2e/c6-admin-layout.spec.ts
git commit -m "C6 Scan: Identity, Details and Demos source cards with every count, the status lines, Choose buttons over hidden inputs, the TOSEC sets card; coverage arithmetic moved into admin-scan-look

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 6: Firmware — `parseShow` / `firmwareHref`, the filtered `countReleases` / `listReleasesFull`, the filter, rows and tags, the pager, Promote on `Modal`

**Files:**
- Modify: `src/lib/admin-firmware.ts` (append), `src/lib/admin-firmware.test.ts` (imports, append),
  `src/lib/firmware-releases.ts:180-214` (`listReleasesFull`, `countReleases`, a `showSql` helper),
  `src/lib/admin-firmware.db.test.ts` (append one `it`), `src/app/(admin)/admin/firmware/page.tsx` (whole file),
  `src/components/admin/promote-release-button.tsx` (whole file), `e2e/c6-admin-layout.spec.ts` (imports, append)

**Interfaces:**
- Consumes: `AdminPageHead`, `ADMIN_BODY` (Task 1); `PagerLink`, `pageHeading()` (Task 3); `Modal`;
  `TEST_BUILD_NOTES_PATTERN` (`@/lib/firmware-releases`).
- Produces:
  - `type FirmwareShow = 'all' | 'releases' | 'test'`; `parseShow(raw: string | string[] | undefined) → FirmwareShow`;
    `firmwareHref(show: FirmwareShow, page?: number) → string` (`@/lib/admin-firmware`)
  - `listReleasesFull(opts: { limit: number; offset: number; show?: FirmwareShow })`,
    `countReleases(opts?: { show?: FirmwareShow }) → Promise<number>`
  - `PromoteReleaseButton` gains the prop `refreshOnDone: boolean`
  - DOM hooks (Task 7): row parts `data-fw-part="left|middle|right"`, the meta line `data-fw-meta`.

**Plan ruling** (spec §6.1, a registry with test builds but no real release): the subtitle reads
`<N> published · no current release yet` (today's `current is none (no release yet)`, in the new `current <v>` form).

**Plan ruling** (spec §6.5 "the footer one **Close** … which takes focus"): the Modal's header × is also a button
named `Close`, so the footer's carries `data-testid="fw-promote-done-close"` for the test to tell them apart.

**Plan ruling** (spec §6.5 finalFocus, same race as Task 3): a promote (or a 409 `not_test_build`) sets a ref and
`finalFocus` returns the h1 — the row is a Release after the refresh and has no trigger.

**Plan ruling** (spec §6.2 + §6.5, Review Focus 1): under `?show=test` a promoted row leaves the list on refresh,
unmounting the dialog with its done text. The page passes `refreshOnDone={show !== 'test'}`; with `false` the
refresh runs when the dialog closes. Everywhere else it refreshes at once, as `admin-firmware.spec:83` pins (the row
reads Release while the dialog is still open).

- [ ] **Step 1: Write the failing tests**

`src/lib/admin-firmware.test.ts` — the import becomes:

```ts
import {
  stripTestPrefix, looksLikeTestBuild, githubReleaseUrl, clampPage, firmwareRepo, parseShow, firmwareHref,
  FIRMWARE_PAGE_SIZE, FIRMWARE_REPO_DEFAULT,
} from './admin-firmware';
```

and append:

```ts
describe('parseShow (C6 spec §6.2, Ruling 27)', () => {
  it('releases and test are themselves; anything else, or nothing, is all', () => {
    expect(parseShow('releases')).toBe('releases');
    expect(parseShow('test')).toBe('test');
    expect(parseShow(['test', 'releases'])).toBe('test');
    for (const raw of [undefined, '', 'all', 'nope', 'TEST', 'Releases', [] as string[]]) expect(parseShow(raw)).toBe('all');
  });
});

describe('firmwareHref', () => {
  it('drops show=all and page 1, keeps the rest in show-then-page order', () => {
    expect(firmwareHref('all')).toBe('/admin/firmware');
    expect(firmwareHref('all', 1)).toBe('/admin/firmware');
    expect(firmwareHref('all', 3)).toBe('/admin/firmware?page=3');
    expect(firmwareHref('test')).toBe('/admin/firmware?show=test');
    expect(firmwareHref('releases', 2)).toBe('/admin/firmware?show=releases&page=2');
  });
});
```

`src/lib/admin-firmware.db.test.ts` — inside the describe, after the `boards per version` test, append:

```ts
  it('?show= filters by the TEST build notes pattern, newest first, and counts what it shows (C6 Ruling 30)', async () => {
    // From the rows above: 1.0.1..1.0.27 (seq 1-27), a TEST build (28), an e2e version with no notes (29).
    expect(await countReleases()).toBe(29);
    expect(await countReleases({ show: 'all' })).toBe(29);
    expect(await countReleases({ show: 'test' })).toBe(1);
    expect(await countReleases({ show: 'releases' })).toBe(28);
    expect((await listReleasesFull({ limit: 25, offset: 0, show: 'test' })).map((r) => r.sequence)).toEqual([28]);
    const rel1 = await listReleasesFull({ limit: 25, offset: 0, show: 'releases' });
    expect(rel1).toHaveLength(25);
    expect(rel1.map((r) => r.sequence).slice(0, 3)).toEqual([29, 27, 26]);
    expect(rel1.some((r) => (r.notes ?? '').startsWith('TEST build'))).toBe(false);
    expect((await listReleasesFull({ limit: 25, offset: 25, show: 'releases' })).map((r) => r.sequence)).toEqual([3, 2, 1]);
    // The unfiltered list is unchanged.
    expect((await listReleasesFull({ limit: 25, offset: 0 })).map((r) => r.sequence)[1]).toBe(28);
  });
```

`e2e/c6-admin-layout.spec.ts` — the device-helpers import becomes
`import { cleanupSeeded, cleanupTestReleases, hydrated, publishTestRelease, publishTestReleaseWithBlob } from './device-helpers';`
and append:

```ts
// ---- Firmware (spec §6, Rulings 27–31) --------------------------------------------------------------------

const fwRow = (page: import('@playwright/test').Page, version: string) =>
  page.locator(`[data-testid="firmware-release-row"][data-version="${version}"]`);

test('Firmware: All / Releases / Test builds filter on the server, the pager keeps it, a garbage URL clamps', async ({ page }) => {
  await publishTestRelease('0.0.0+e2e60', { notes: 'TEST build c6 filter' });
  await publishTestRelease('0.0.0+e2e61');
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware');
  await expect(page.getByTestId('fw-filter')).toHaveAttribute('aria-label', 'Show releases');
  await expect(page.getByTestId('fw-filter').getByRole('link')).toHaveText(['All', 'Releases', 'Test builds']);
  await expect(page.getByTestId('fw-filter-all')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Test builds reach only the bench organizations. Promote to release… offers one to every organization.')).toBeVisible();
  await expect(page.getByText(/^\d+ published · (current \S+|no current release yet)$/)).toBeVisible();
  await expect(fwRow(page, '0.0.0+e2e60').getByTestId('fw-tag-test')).toHaveText('Test build · bench orgs only');
  await expect(fwRow(page, '0.0.0+e2e61').getByTestId('fw-tag-release')).toHaveText('Release');

  await page.getByTestId('fw-filter-test').click();
  await expect(page).toHaveURL(/\/admin\/firmware\?show=test$/);
  await expect(page.getByTestId('fw-filter-test')).toHaveAttribute('aria-current', 'page');
  await expect(fwRow(page, '0.0.0+e2e60')).toHaveCount(1);
  await expect(fwRow(page, '0.0.0+e2e61')).toHaveCount(0);
  const allTest = await page.getByTestId('firmware-release-row')
    .evaluateAll((rows) => rows.every((r) => !!r.querySelector('[data-testid="fw-tag-test"]')));
  expect(allTest).toBe(true);

  await page.getByTestId('fw-filter-releases').click();
  await expect(page).toHaveURL(/\/admin\/firmware\?show=releases$/);
  await expect(fwRow(page, '0.0.0+e2e61')).toHaveCount(1);
  await expect(fwRow(page, '0.0.0+e2e60')).toHaveCount(0);
  const older = page.getByTestId('fw-page-older');
  if (await older.count()) await expect(older).toHaveAttribute('href', '/admin/firmware?show=releases&page=2');

  const res = await page.goto('/admin/firmware?show=nope&page=999');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('fw-filter-all')).toHaveAttribute('aria-current', 'page');
  const text = await page.getByText(/^Page \d+ of \d+$/).textContent();
  const [, n, m] = /^Page (\d+) of (\d+)$/.exec(text ?? '') ?? [];
  expect(n).toBe(m);
  await expect(page.getByTestId('fw-page-older')).toHaveCount(0);
  await page.getByTestId('fw-filter-all').click();
  await expect(page).toHaveURL(/\/admin\/firmware$/);
});

test('Promote to release… under Test builds: notes take focus, Escape returns, the done text stays until Close, then the heading', async ({ page }) => {
  const version = await publishTestReleaseWithBlob('0.0.0+e2e62', { notes: 'TEST build c6 focus' });
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware?show=test');
  const trigger = fwRow(page, version).getByRole('button', { name: 'Promote to release' });
  await expect(trigger).toHaveText('Promote to release…');
  const dialog = page.getByTestId('fw-promote-dialog');
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(dialog.getByRole('heading', { name: 'Promote to release' })).toBeVisible();
  await expect(dialog).toContainText(version);
  await expect(dialog.getByTestId('fw-promote-notes')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByTestId('fw-promote-notes').fill('c6 focus release');
  await dialog.getByTestId('fw-promote-confirm').click();
  await expect(dialog.getByTestId('fw-promote-done')).toBeVisible();
  // Under show=test the refresh waits for Close, so the done text is still there to read.
  await page.waitForTimeout(1_500);
  await expect(dialog.getByTestId('fw-promote-done')).toBeVisible();
  await expect(page.getByTestId('fw-promote-done-close')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(fwRow(page, version)).toHaveCount(0);   // a release now: not in Test builds
  await expect(page.locator('h1')).toBeFocused();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/lib/admin-firmware.test.ts`
Expected: FAIL — `parseShow is not a function` / `firmwareHref is not a function`.

Run: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db src/lib/admin-firmware.db.test.ts`
Expected: FAIL — `expected 29 to be 1` (the filter is ignored).

- [ ] **Step 3: Implement**

`src/lib/admin-firmware.ts` — append:

```ts
/** The Firmware list's filter (C6 spec §6.2, Ruling 27). */
export type FirmwareShow = 'all' | 'releases' | 'test';

/** `?show=` as a filter: `releases` and `test` are themselves; anything else, or nothing, is `all`. */
export function parseShow(raw: string | string[] | undefined): FirmwareShow {
  const s = Array.isArray(raw) ? raw[0] : raw;
  return s === 'releases' || s === 'test' ? s : 'all';
}

/** The Firmware page's URL for a filter and page: `all` and page 1 are left out, so the plain URL stays plain. */
export function firmwareHref(show: FirmwareShow, page = 1): string {
  const q = new URLSearchParams();
  if (show !== 'all') q.set('show', show);
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return s ? `/admin/firmware?${s}` : '/admin/firmware';
}
```

`src/lib/firmware-releases.ts` — add `import type { FirmwareShow } from '@/lib/admin-firmware';` with the imports;
above `listReleasesFull` add:

```ts
/**
 * The admin list's `?show=` filter (C6 Ruling 30): the same TEST_BUILD_NOTES_PATTERN isTestBuild and
 * releaseVisibleToSql use. `all` (or nothing) adds no condition, so the default query is today's.
 */
function showSql(show: FirmwareShow = 'all'): SQL | undefined {
  if (show === 'test') return sql`${firmwareReleases.notes} like ${TEST_BUILD_NOTES_PATTERN}`;
  if (show === 'releases') {
    return sql`(${firmwareReleases.notes} is null or ${firmwareReleases.notes} not like ${TEST_BUILD_NOTES_PATTERN})`;
  }
  return undefined;
}
```

`listReleasesFull`'s signature becomes `opts: { limit: number; offset: number; show?: FirmwareShow },` and its query
gains `.where(showSql(opts.show))` between `.leftJoin(…)` and `.orderBy(…)`; `countReleases` becomes:

```ts
/** Release rows, for /admin/firmware's page count -- all of them, or those the `show` filter keeps. */
export async function countReleases(opts: { show?: FirmwareShow } = {}): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(firmwareReleases).where(showSql(opts.show));
  return Number(row.n);
}
```

`src/components/admin/promote-release-button.tsx` (whole file):

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/modal';
import { looksLikeTestBuild } from '@/lib/admin-firmware';
import { pageHeading } from '@/components/admin/page-heading';

/**
 * Promote a TEST build to a release (A7 spec §3; C6 spec §6.5 on the shared Modal): the notes with "TEST build"
 * removed, editable; Promote saves them through POST /api/admin/firmware/[id]/promote.
 *
 * Rendered on EVERY row, with `canPromote` saying whether the trigger shows: after a promote, router.refresh()
 * re-renders the row as a Release, and were the component rendered only on Test rows it would unmount right then and
 * the done text (the GitHub step the operator still has to run) would vanish before anyone read it.
 * `refreshOnDone` is false under the Test builds filter, where the refreshed list no longer holds the row at all:
 * the refresh then waits until the dialog closes.
 */
export function PromoteReleaseButton({
  id, version, initialNotes, canPromote, refreshOnDone,
}: {
  id: string; version: string; initialNotes: string; canPromote: boolean; refreshOnDone: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  // The row stops being a Test build (promoted, or a 409 says it already was): its trigger goes, so the h1 takes focus.
  const gone = useRef(false);
  // A refresh still owed because refreshOnDone was false.
  const owed = useRef(false);

  useEffect(() => { if (done) closeBtn.current?.focus(); }, [done]);

  const trimmed = notes.trim();
  const armed = trimmed.length > 0 && trimmed.length <= 2000 && !looksLikeTestBuild(trimmed);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setError(null);
      setDone(false);
      if (owed.current) { owed.current = false; router.refresh(); }
    }
  }

  function finalFocus(): HTMLElement | null {
    if (gone.current) return pageHeading();
    return trigger.current && document.contains(trigger.current) ? trigger.current : pageHeading();
  }

  function refresh() {
    if (refreshOnDone) router.refresh(); else owed.current = true;
  }

  async function onPromote() {
    if (busy || !armed) return;
    setBusy(true);
    setError(null);
    try {
      // redirect: 'manual' -- a signed-out session is answered with requireSuperAdmin()'s redirect to /sign-in, and
      // a followed redirect is a 200 HTML page that must never read as "Promoted".
      const res = await fetch(`/api/admin/firmware/${id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notes }),
        redirect: 'manual',
      });
      if (res.type === 'opaqueredirect' || res.redirected || res.status === 401 || res.status === 403) {
        setError(SIGNED_OUT);
        return;
      }
      const body = (await res.json().catch(() => null)) as { id?: string; error?: string; reason?: string } | null;
      if (res.ok) {
        // Done only for the row's own JSON: anything else (an HTML page, an empty body) is not a promote.
        if (body?.id !== id) { setError(SIGNED_OUT); return; }
        gone.current = true;
        setDone(true);
        refresh();
        return;
      }
      setError(errorText(res.status, body));
      if (res.status === 409 && body?.error === 'not_test_build') { gone.current = true; refresh(); }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const OUTLINE = 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60';

  return (
    <>
      {canPromote && (
        <button
          ref={trigger}
          type="button"
          onClick={() => { setNotes(initialNotes); gone.current = false; setOpen(true); }}
          data-testid={`fw-promote-${id}`}
          className="h-8 rounded-[8px] border border-(--line) px-2.5 text-[13px] font-medium text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
        >
          Promote to release…
        </button>
      )}
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        width={620}
        testId="fw-promote-dialog"
        closeTestId="fw-promote-close"
        title="Promote to release"
        subtitle={<span className="font-mono [overflow-wrap:anywhere]">{version}</span>}
        dismissible={!busy}
        initialFocus={field}
        finalFocus={finalFocus}
        footer={done ? (
          <div className="flex w-full justify-end">
            <button ref={closeBtn} type="button" data-testid="fw-promote-done-close" onClick={() => onOpenChange(false)} className={OUTLINE}>
              Close
            </button>
          </div>
        ) : (
          <div className="flex w-full items-center justify-end gap-2.5">
            <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) onOpenChange(false); }} className={OUTLINE}>
              Cancel
            </button>
            {/* Native disabled is the notes gate (not focused while not armed); busy is aria-disabled + the guard. */}
            <button type="button" onClick={onPromote} disabled={!armed} aria-disabled={busy || undefined}
                    data-testid="fw-promote-confirm"
                    className="h-[38px] rounded-[10px] px-4 text-[13px] font-semibold text-white disabled:opacity-50 aria-disabled:opacity-60"
                    style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
              {busy ? 'Promoting…' : 'Promote'}
            </button>
          </div>
        )}
      >
        {done ? (
          <p className="px-6 py-5 text-[14px]" style={{ color: 'var(--ink)' }} data-testid="fw-promote-done">
            Promoted. The GitHub release is made from the build folder: run{' '}
            <code className="font-mono">pnpm firmware:publish --github-only</code>.
          </p>
        ) : (
          <div className="flex flex-col gap-3 px-6 py-5">
            <p className="text-[14px]" style={{ color: 'var(--muted)' }} data-testid="fw-promote-scope">
              Every organization&apos;s boards will be offered this build.
            </p>
            <label htmlFor={`fw-notes-${id}`} className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              Release notes
            </label>
            <textarea
              ref={field}
              id={`fw-notes-${id}`}
              data-testid="fw-promote-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              maxLength={2000}
              className="-mt-2 rounded-[10px] px-3 py-2 text-[14px]"
              style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' }}
            />
            {error && (
              <p role="alert" className="text-[13px]" style={{ color: 'var(--danger-fg)' }} data-testid="fw-promote-error">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

const SIGNED_OUT = 'Signed out — sign in again';

function errorText(status: number, body: { error?: string; reason?: string } | null): string {
  switch (body?.error) {
    case 'invalid_notes': return 'Notes must be 1 to 2000 characters.';
    case 'still_test_build': return 'Notes must not start with "TEST build" (in any case).';
    case 'image_mismatch': return 'The stored image does not match the release\'s sha256; it cannot be promoted.';
    case 'not_found': return 'This release no longer exists.';
    case 'not_test_build': return 'This release is no longer a TEST build; it was already promoted.';
    case 'bench_image': return `This image is a bench-only build and cannot be a release: ${body.reason}`;
    case 'image_too_large': return 'The stored image is over the 2 MB limit.';
    case 'blob_unavailable': return 'The image could not be read from storage. Try again.';
    default: return `Could not promote: the server answered ${status}.`;
  }
}
```

`src/app/(admin)/admin/firmware/page.tsx` (whole file):

```tsx
import { Link } from '@/components/shell/link';
import { listReleasesFull, countReleases, readCurrentRelease } from '@/lib/firmware-releases';
import { adminBoardsByVersion } from '@/lib/admin-queries';
import { fmtSize, fmtTimeUtc } from '@/lib/format';
import { signatureLabel } from '@/lib/firmware-state';
import { isTestBuild } from '@/lib/firmware-github-release';
import {
  FIRMWARE_PAGE_SIZE, clampPage, firmwareRepo, githubReleaseUrl, stripTestPrefix, parseShow, firmwareHref,
  type FirmwareShow,
} from '@/lib/admin-firmware';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { PromoteReleaseButton } from '@/components/admin/promote-release-button';
import { PagerLink } from '@/components/admin/pager-link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Firmware' };

const PILL = 'rounded-full px-[9px] py-px text-[12px] font-semibold';
const FILTERS: readonly { show: FirmwareShow; label: string; testId: string }[] = [
  { show: 'all', label: 'All', testId: 'fw-filter-all' },
  { show: 'releases', label: 'Releases', testId: 'fw-filter-releases' },
  { show: 'test', label: 'Test builds', testId: 'fw-filter-test' },
];

/**
 * Publishing happens from the operator's Mac, because the signing key is there (spec D3) -- a browser publish would
 * either skip the signature or need the key uploaded, and uploading it is the one thing that makes an offline key
 * pointless.
 *
 * The one write here is Promote to release (A7 spec §3): a notes edit on a TEST build, through
 * POST /api/admin/firmware/[id]/promote. Notes are not part of the signed manifest, so the signature stays valid;
 * the route calls requireSuperAdmin() itself, as every /api/admin route does. The (admin) layout's
 * requireSuperAdmin() guards this page.
 *
 * `?show=` filters on the server (C6 Ruling 27): a client filter over a 25-row page would hide releases on other
 * pages. The pager counts the filtered rows and keeps the filter; the subtitle's total is the whole registry.
 */
export default async function AdminFirmwarePage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise. Do NOT import PageProps -- it is ambient.
  searchParams: Promise<{ page?: string | string[]; show?: string | string[] }>;
}) {
  const sp = await searchParams;
  const show = parseShow(sp.show);
  const [total, shown, current] = await Promise.all([
    countReleases(), show === 'all' ? Promise.resolve(null) : countReleases({ show }), readCurrentRelease(),
  ]);
  const pages = Math.max(1, Math.ceil((shown ?? total) / FIRMWARE_PAGE_SIZE));
  const page = clampPage(sp.page, pages);
  const releases = await listReleasesFull({
    limit: FIRMWARE_PAGE_SIZE, offset: (page - 1) * FIRMWARE_PAGE_SIZE, show,
  });
  const boards = await adminBoardsByVersion(releases.map((r) => r.version));
  const repo = firmwareRepo();
  const subtitle = total === 0
    ? 'No releases published · nothing to compare devices against'
    : `${total} published · ${current ? `current ${current.version}` : 'no current release yet'}`;

  return (
    <>
      <AdminPageHead title="Firmware" subtitle={subtitle} />
      <div className={ADMIN_BODY}>
        <div className="flex flex-wrap items-center gap-3">
          <nav aria-label="Show releases" data-testid="fw-filter" className="flex gap-0.5 rounded-[10px] p-[3px]"
               style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
            {FILTERS.map((f) => {
              const cur = f.show === show;
              return (
                <Link key={f.show} href={firmwareHref(f.show)} data-testid={f.testId} aria-current={cur ? 'page' : undefined}
                      className={`inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) ${cur
                        ? 'bg-(--ink) font-semibold text-(--surface)'
                        : 'font-medium text-(--muted) hover:bg-(--track)'}`}>
                  {f.label}
                </Link>
              );
            })}
          </nav>
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }}>
            Test builds reach only the bench organizations. Promote to release… offers one to every organization.
          </span>
        </div>

        <section aria-label="Releases" className="flex flex-col gap-2.5">
          {total === 0 ? (
            <div className="rounded-[16px] p-6 text-[13px]" style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)', color: 'var(--muted)' }}>
              No releases published yet. Every paired device will read as an{' '}
              <strong>unrecognised build</strong> until there is something to compare it
              against. Build the firmware, then run <code>pnpm firmware:publish</code>.
            </div>
          ) : releases.length === 0 ? (
            <div data-testid="fw-filter-empty" className="rounded-[16px] p-6 text-[13px]"
                 style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)', color: 'var(--muted)' }}>
              {show === 'test' ? 'No test builds published.' : 'No releases published.'}
            </div>
          ) : releases.map((r) => {
            const test = isTestBuild(r.notes);
            const github = githubReleaseUrl(r.semver, r.notes, repo);
            const n = boards.get(r.version) ?? 0;
            return (
              <article
                key={r.id}
                data-testid="firmware-release-row"
                data-version={r.version}
                className="flex flex-col gap-2.5 rounded-[16px] px-5 py-4 md:flex-row md:items-start md:gap-5"
                style={{ background: 'var(--surface)', boxShadow: `0 0 0 1px ${r.isCurrent ? 'var(--mounted-line)' : 'var(--line)'}` }}
              >
                <div data-fw-part="left" className="flex shrink-0 flex-col gap-1.5 md:w-[220px]">
                  <span className="flex items-center gap-2 font-mono text-[15px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
                    <span aria-hidden className="size-2 shrink-0 rounded-full"
                          style={{ background: r.isCurrent ? 'var(--online-dot)' : test ? 'var(--fetch-dot)' : 'var(--dash)' }} />
                    <span className="min-w-0">{r.version}</span>
                  </span>
                  <span data-fw-meta className="font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>
                    {`seq ${r.sequence} · ${fmtSize(r.sizeBytes)} · ${fmtTimeUtc(r.publishedAt)}`}
                  </span>
                  {/* Who shipped it, and the signature said out loud rather than implied by a padlock (Ruling 29). */}
                  <span className="text-[12px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted-2)' }}>
                    {`${r.publishedByEmail ?? 'unknown publisher'} · ${signatureLabel(r.signingKeyId, r.signatureFormat)}`}
                  </span>
                </div>
                <div data-fw-part="middle" className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {r.isCurrent ? (
                      // One pill that holds both ids (Ruling 28): Current keeps its meaning, so does release.
                      <span className={PILL} style={{ background: 'var(--success-bg)', color: 'var(--success-fg)' }}>
                        <span data-testid="fw-tag-current">Current</span> <span data-testid="fw-tag-release">release</span>
                      </span>
                    ) : test ? (
                      <span data-testid="fw-tag-test" className={PILL} style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}>
                        Test build · bench orgs only
                      </span>
                    ) : (
                      <span data-testid="fw-tag-release" className={PILL} style={{ background: 'var(--track)', color: 'var(--muted)' }}>
                        Release
                      </span>
                    )}
                    {r.security && (
                      <span className={PILL} style={{ background: 'var(--danger-bg)', color: 'var(--danger-strong)' }}>Security</span>
                    )}
                  </div>
                  {r.notes && (
                    <p className="text-[14px] leading-[1.5] [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>{r.notes}</p>
                  )}
                </div>
                <div data-fw-part="right" className="flex shrink-0 flex-col gap-1.5 md:items-end">
                  <span className="text-[12px] tabular-nums" style={{ color: 'var(--muted-2)' }} data-testid="fw-boards">
                    {n} {n === 1 ? 'board' : 'boards'}
                  </span>
                  <PromoteReleaseButton id={r.id} version={r.version} initialNotes={stripTestPrefix(r.notes ?? '')}
                                        canPromote={test} refreshOnDone={show !== 'test'} />
                  {github && (
                    <a href={github} target="_blank" rel="noopener noreferrer" data-testid="fw-github"
                       className="text-[13px] font-semibold text-(--amber-text) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
                      GitHub release
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        {/* The board's "load as you scroll" is not built (Ruling 27): admin-firmware pins Page N of M. */}
        <div data-testid="fw-pager" className="flex items-center gap-2.5 text-[13px]">
          <PagerLink href={page > 1 ? firmwareHref(show, page - 1) : null} label="Newer" testId="fw-page-newer" />
          <span style={{ color: 'var(--muted)' }}>Page {page} of {pages}</span>
          <PagerLink href={page < pages ? firmwareHref(show, page + 1) : null} label="Older" testId="fw-page-older" />
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/lib/admin-firmware.test.ts` → PASS.
Run: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh start) pnpm test:db src/lib/admin-firmware.db.test.ts` → PASS.
Run: `pnpm test`, `npx tsc --noEmit`, `pnpm lint` (`0 errors, 12 warnings`).

e2e, one at a time (specs that select `firmware-release-row`, `fw-*`, `Page N of M`, `Promote to release`):
1. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "Firmware:|Promote to release… under"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/admin-firmware.spec.ts --project=desktop` → `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-firmware.ts src/lib/admin-firmware.test.ts src/lib/firmware-releases.ts \
  src/lib/admin-firmware.db.test.ts "src/app/(admin)/admin/firmware/page.tsx" \
  src/components/admin/promote-release-button.tsx e2e/c6-admin-layout.spec.ts
git commit -m "C6 Firmware: All / Releases / Test builds filter on the server, the board's rows and tags, a pager that keeps the filter; Promote on Modal with its focus rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 7: States, contrast on real elements, the 390 px check, `admin.png`, the lint gate, the regression

**Files:**
- Modify: `e2e/contrast.spec.ts` (imports, `afterAll`, one test), `e2e/c6-admin-layout.spec.ts` (one test),
  `e2e/screenshots.shots.ts` (imports, `shoot`'s `mask` option, one shot)
- Add: `docs/screenshots/admin.png`

**Interfaces:**
- Consumes: every test id and DOM hook of Tasks 1–6 (`data-warn`, `data-attn`, `data-dist`, `data-admin-pill`,
  `data-users-foot`, `data-state`, `data-source`, `data-count-label`, `data-fw-part`, `data-fw-meta`);
  `gotoAdminUserRow` (Task 3); `legible()` (`e2e/contrast.spec.ts`).
- Produces: nothing later tasks use.

**Plan ruling** (spec §11 "Measured on real elements: … the no-live note … `attention-invites`", and the warning
tiles): those exist only while the live database has no live invite or has unscanned blobs, and the suite cannot
revoke the operator's real codes to force it. They are measured when present (and the run logs which were); their
pairs (`--warning-fg` / `--ink` / `--muted` on `--warning-bg`, `--amber-text` on `--surface`) are pinned in
`design-tokens.test.ts` by Task 1 either way. Every other §11 element is seeded by the test and always measured.

**Plan ruling** (spec Ruling 38, `admin.png` of the Overview at 1280): the capture runs against the live production
database and the README image is public, while Needs attention shows real boards' names and their owners' email
addresses. The shot masks every `attention-row` (Playwright's `mask`, painted in `--surface-2`, the rows' own fill),
so the image shows the layout and the counts but no person's address or board name. Relay this to the operator.

- [ ] **Step 1: Write the failing tests**

`e2e/contrast.spec.ts` — the device-helpers import becomes
`import { cleanupSeeded, seedDisk, pairDevice, authHeader, openBoardSettings, hydrated, seedDevices, publishTestRelease, cleanupTestReleases } from './device-helpers';`,
add `import { readCurrentRelease } from '@/lib/firmware-releases';`, `import { revokeInvite } from '@/lib/invites';`,
change `import { signUpFresh, runTag, createAdf, openRowMenu, openVersion } from './helpers';` to also import
`mintInviteCode`, change `import { signInAsSuperAdmin } from './admin-helpers';` to
`import { signInAsSuperAdmin, SUPERADMIN_EMAIL, gotoAdminUserRow } from './admin-helpers';`, add
`await cleanupTestReleases();` as the first line of the `afterAll` body, and append:

```ts
// Phase C6 spec §11, measured on real elements. Seeded: a board with an error on the current release (an attention
// row and, with a current release, ` · current`), a TEST build, a live code, a revoked code and the fresh sign-up's
// used code. Live-data-only elements (warning tiles, the no-live note, attention-invites) are measured when present.
test('the Admin pairs are legible: tiles, firmware rows, attention, Users, Invites, Scan, Firmware, tabs', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const u = await signUpFresh(page);
  const current = await readCurrentRelease();
  const [errored] = await seedDevices(u.orgId, 1, current?.version ?? '0.0.0+e2e-c6-contrast');
  await getDb().update(devices).set({ lastError: 'e2e contrast', lastErrorAt: new Date() }).where(eq(devices.id, errored));
  await publishTestRelease('0.0.0+e2e63', { notes: 'TEST build c6 contrast' });
  await mintInviteCode();
  const revoked = await mintInviteCode();
  await revokeInvite(revoked);

  await page.context().clearCookies();
  await signInAsSuperAdmin(page);
  const when = async (area: string, pairs: ReadonlyArray<readonly [string, string]>) => {
    for (const pair of pairs) {
      if (await page.locator(pair[1]).count()) await legible(page, area, [pair]);
      else console.log(`${area.padEnd(9)} ${pair[0].padEnd(36)} not on the page in this database state`);
    }
  };

  await page.goto('/admin');
  await page.mouse.move(0, 0);
  const row = `[data-testid="attention-row"][data-device-id="${errored}"]`;
  await legible(page, 'overview', [
    ['tile label', 'a:has(> [data-testid="count-users"]) > span:first-child'],
    ['tile value', '[data-testid="count-users"]'],
    ['tile note', 'a:has(> [data-testid="count-users"]) > span:last-child'],
    ['firmware row count', '[data-testid="fw-dist-row"] > span:last-child'],
    ['attention title (surface-2)', `${row} [data-attn="title"]`],
    ['attention reason (surface-2)', `${row} [data-kind="error"]`],
    ['tab (current)', '[data-testid="admin-sections"] a[aria-current="page"]'],
    ['tab', '[data-testid="admin-sections"] a:not([aria-current])'],
  ]);
  await when('overview', [
    [' · current', '[data-dist="current"]'],
    ['warning tile value', 'a[data-warn="true"] > span:nth-child(2)'],
    ['warning tile note', 'a[data-warn="true"] > span:last-child'],
    ['attention title (warning-bg)', '[data-testid="attention-invites"] [data-attn="title"]'],
    ['attention text (warning-bg)', '[data-testid="attention-invites"] [data-attn="text"]'],
  ]);

  await gotoAdminUserRow(page, SUPERADMIN_EMAIL);
  await page.mouse.move(0, 0);
  await legible(page, 'users', [
    ['column head', 'section[aria-label="Users"] th'],
    ['joined date', '[data-testid="admin-user-row"] td:nth-child(3)'],
    ['Admin pill', '[data-admin-pill]'],
    ['Delete… trigger', '[data-testid^="delete-user-"]:not([aria-disabled])'],
    ['footer', '[data-users-foot]'],
  ]);

  await page.goto('/admin/invites');
  await page.mouse.move(0, 0);
  await legible(page, 'invites', [
    ['Live pill', '[data-state="live"]'],
    ['Used pill', `[data-testid="invite-${u.inviteCode}"] [data-state="consumed"]`],
    ['Revoked pill', `[data-testid="invite-${revoked}"] [data-state="revoked"]`],
  ]);
  await when('invites', [['no-live note', '[data-testid="invites-none-live"] > span:last-child']]);

  await page.goto('/admin/scan');
  await page.mouse.move(0, 0);
  await legible(page, 'scan', [
    ['source line', '[data-testid="scan-identity"] [data-source]'],
    ['count label', '[data-testid="scan-identity"] [data-count-label]'],
    ['count value', '[data-testid="scan-blobs"]'],
    ['status line', '[data-testid="scan-note"] > span:last-child'],
  ]);

  await page.goto('/admin/firmware');
  await page.mouse.move(0, 0);
  await legible(page, 'firmware', [
    ['meta line', '[data-testid="firmware-release-row"] [data-fw-meta]'],
    ['Test build tag', '[data-testid="firmware-release-row"][data-version="0.0.0+e2e63"] [data-testid="fw-tag-test"]'],
    ['filter (current)', '[data-testid="fw-filter"] a[aria-current="page"]'],
    ['filter (other)', '[data-testid="fw-filter"] a:not([aria-current])'],
  ]);
  await page.goto('/admin/firmware?show=releases');
  await page.mouse.move(0, 0);
  await when('firmware', [
    ['Current release tag', '[data-testid="fw-tag-current"]'],
    ['GitHub release', '[data-testid="fw-github"]'],
  ]);
});
```

`e2e/c6-admin-layout.spec.ts` — append:

```ts
// ---- Phone (spec §9: only what the boards and today's specs pin; the full pass is C7) -------------------------

test('at 390 px: the bottom bar holds the Main nav, tabs and tables scroll inside themselves, nothing scrolls the page sideways', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsSuperAdmin(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const noSideways = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const [path] of PAGES) {
    await page.goto(path);
    const main = page.getByTestId('admin-header').getByRole('navigation', { name: 'Main' });
    expect((await main.boundingBox())!.y).toBeGreaterThan(844 - 120);   // the fixed bottom bar
    const clamp = (await page.getByTestId('admin-sections').locator('xpath=..').boundingBox())!;
    expect(clamp.x + clamp.width).toBeLessThanOrEqual(390 - 16 + 1);
    await noSideways();
  }

  await page.goto('/admin');
  const box = (id: string) => page.locator(`a:has(> [data-testid="${id}"])`).boundingBox();
  const [a, b, c] = [(await box('count-users'))!, (await box('count-orgs'))!, (await box('count-games'))!];
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);                     // two tiles per row
  expect(c.y).toBeGreaterThan(a.y + a.height - 1);
  const fw = (await page.getByRole('heading', { name: 'Boards by firmware' }).boundingBox())!;
  const att = (await page.getByRole('heading', { name: 'Needs attention' }).boundingBox())!;
  expect(att.y).toBeGreaterThan(fw.y);                              // the cards stack

  await page.goto('/admin/users');
  expect(await page.locator('section[aria-label="Users"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await page.goto('/admin/invites');
  expect(await page.locator('section[aria-label="Invite codes"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);

  await page.goto('/admin/firmware');
  const first = page.getByTestId('firmware-release-row').first();
  const left = (await first.locator('[data-fw-part="left"]').boundingBox())!;
  const right = (await first.locator('[data-fw-part="right"]').boundingBox())!;
  expect(right.y).toBeGreaterThan(left.y + left.height - 1);       // a column below md
  await noSideways();
});
```

`e2e/screenshots.shots.ts` — the Playwright import becomes `import { test, expect, type Page, type Locator } from '@playwright/test';`,
add `import { signInAsSuperAdmin } from './admin-helpers';`; `shoot`'s signature becomes
`async function shoot(page: Page, name: string, opts: { tall?: boolean; mask?: Locator[] } = {}) {` and its screenshot
line becomes `await page.screenshot({ path: file, mask: opts.mask, maskColor: '#F6F2E9' });` (the `--surface-2`
value: the masked rows read as blank cards); at the end of the `capture the README screenshots` test, after the
settings shot, add:

```ts
  // --- the admin Overview (C6, Ruling 38) ------------------------------------
  // Live database: Needs attention names real boards and their owners' addresses, so those rows are masked in the
  // public README image (Plan ruling, Task 7).
  await signInAsSuperAdmin(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin');
  await expect(page.getByTestId('admin-sections')).toBeVisible();
  await shoot(page, 'admin', { mask: [page.getByTestId('attention-row')] });
  await page.setViewportSize({ width: 1440, height: 900 });
```

- [ ] **Step 2: Run them to see them fail or pass**

`PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Admin pairs"` → 1 test; it must be green
after Step 3. If it already passes, Tasks 1–6 built the looks to the tokens — record the logged ratios and the
"not on the page" lines in the report.

`PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "at 390 px"` → 1 test, same rule.

- [ ] **Step 3: Implement** — only what Step 2 shows is wrong. Expected: nothing. A failed ratio is fixed in the
  component's colour (to the spec §11 token), never by lowering 4.5 or by pointing the selector elsewhere. A selector
  that finds nothing because the DOM differs from Tasks 2–6's markup is corrected to the real element the §11 row
  names, and the report says so. A page that scrolls sideways at 390 is fixed where it overflows (a missing
  `min-w-0`, an unwrapped token), never by hiding overflow on `body`.

- [ ] **Step 4: Run the tests to see them pass, then the lint gate and the regression**

- `pnpm test` (whole), `npx tsc --noEmit`, and **the lint gate**: `pnpm lint` → `✖ 12 problems (0 errors, 12
  warnings)`, exit code 0 (`pnpm lint; echo "exit $?"` prints `exit 0`). Any error is this phase's to fix before the
  commit.
- `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Admin pairs"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "at 390 px"` → `1 passed`.

**States** (spec §7), checked once by hand on the dev server (3100) and recorded in the report: a slow admin page
shows the admin loading frame under the admin header (open `/admin/scan` with the network throttled to Slow 3G in
the browser's devtools: the skeleton has the lg head bones, the tabs bone and six rows); the error view keeps the
admin header and `Back to admin`; `/admin/users?page=0` and `/admin/firmware?page=9999` clamp (no not-found card).
The empty states (`fw-dist-empty`, `attention-empty`, `invites-empty`, the sets' empty row, `— nothing decided
yet`, the empty-registry card, `fw-filter-empty`) cannot be produced on the live DB; they are server markup each
task wrote from the spec's words — read them once against spec §7.

**Final regression** — every spec this area touches, ONE run at a time, each command under 9 minutes, `--list` first
so each file is covered whole:

1. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop` → `12 passed` (shell 2, Overview 2,
   Users 2, Invites 2, Scan 1, Firmware 2, phone 1; ~4 min).
2. `PORT=3100 npx playwright test e2e/admin-guard.spec.ts --project=desktop` → `9 passed`; then
   `PORT=3100 npx playwright test e2e/admin-delete.spec.ts --project=desktop` → `5 passed`.
3. `PORT=3100 npx playwright test e2e/admin-invites.spec.ts --project=desktop` → `10 passed`; then
   `PORT=3100 npx playwright test e2e/admin-firmware.spec.ts --project=desktop` → `6 passed`.
4. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "sees the scan status page|Demozoo status line|non-admin cannot reach the scan|cron route refuses|import a DAT"` → `5 passed`.
5. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "run a scan by clicking Run now"` → `1 passed` (alone).
6. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "excluded from the coverage rate"` → `1 passed` (alone).
7. `PORT=3100 npx playwright test e2e/header-overlap.spec.ts --project=desktop` → `3 passed`; then
   `PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "admin plane never renders"` → `1 passed`; then
   `PORT=3100 npx playwright test e2e/collections.spec.ts --project=desktop -g "deleting a user deletes their collections"` → `1 passed`.
8. `PORT=3100 npx playwright test e2e/states.spec.ts --project=desktop` → `5 passed`.
9. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop --list` → note the count (one more than
   before C6); run it in two slices, each under 9 minutes (`-g` is a case-sensitive RegExp, so no `?` in a pattern):
   `-g "sign-in text|sign-up text|shell and an empty library|library card|toast description|search panel metadata|header focus|Devices pairs|Upload pairs"`,
   then `-g "Disk files pairs|open popover|Settings pairs|Help pairs|Search panel pairs|Sign-in and Create account pairs|Admin pairs"`
   → all pass; check with `--list` that the two slices together cover the whole count (recount if not).
10. `PORT=3100 npx playwright test e2e/demozoo.spec.ts --project=desktop --list`, `e2e/openretro.spec.ts`,
    `e2e/tosec-scan.spec.ts` (API only; they call `/api/admin/scan`, whose behaviour is unchanged): run each file
    alone, splitting with `-g` by title where `--list` shows more than ~6 minutes of sweeps → all pass. A sweep that
    times out against a large live backlog is recorded with its time, not chased (the C2–C5 ledgers' rule).

Phone by hand (390 × 844, the dev server on 3100): each admin page — the header wraps (wordmark, then search, email,
gear, Sign out), the Main nav sits in the fixed bottom bar, the tabs scroll inside their clamp, the PageHeader stacks
(title, subtitle, then Issue an invite / Run now); the new-code panel wraps (code, then the copy buttons); both
modals are full screen. Record what you saw.

Then `PORT=3100 pnpm screenshots` and compare `docs/screenshots/admin.png` with InfAdminOverview by eye (six tiles in
one row at 1280, the firmware card left, Needs attention right with its board rows masked). Commit ONLY `admin.png`;
the run regenerates the others too — restore each with `git checkout -- docs/screenshots/<name>.png` (never with
stash) and confirm `git status --short docs/screenshots` lists only `?? docs/screenshots/admin.png`. Open the PNG and
confirm no email address and no board name is readable in it before staging.

- [ ] **Step 5: Commit** — re-check `git status --short`, then:

```bash
git add e2e/contrast.spec.ts e2e/c6-admin-layout.spec.ts e2e/screenshots.shots.ts docs/screenshots/admin.png
git commit -m "C6: Admin contrast measured on real elements, the 390 px check, admin.png with the attention rows masked; lint gate at zero errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

## Self-review (against the spec)

- §0 invariants → Global Constraints; the guards stay (Tasks 3, 6 keep the typed gate and the notes rule as native
  `disabled` gates, the 409s, `redirect: 'manual'`); lint to zero → Task 1 (moved early: plan ruling), gate in Task 7.
- §1.1 header, §1.2 `AdminSections`, §1.3 `AdminPageHead`, §1.4 `subtitleFont` + ring, §1.5 `--bar-ok`, §1.6 titles,
  §1.7 loading → Task 1.
- §2 Overview (`nowMs`, `adminCounts` + two fields, tiles, firmware card, Needs attention) → Tasks 1 (lint) and 2
  (`newestUserAt` as a date string, `1 disk`: plan rulings).
- §3 Users (table, pill, disabled Delete…, footer, pager, `DeleteUserDialog` on `Modal`, focus) → Task 3 (the
  close-before-refresh focus race, the one-try fetch, the admin's page helper: plan rulings).
- §4 Invites (provider, button, panel, note, table, `look` / `linkLabel`, Revoke, the two renames) → Task 4 (the
  persistent live region, h1 before refresh: plan rulings).
- §5 Scan (`nowMs`, `admin-scan-look`, cards, notes, imports, sets) → Tasks 1 (lint) and 5 (singular words, the
  OpenRetro busy line, the import logic kept: plan rulings).
- §6 Firmware (`parseShow`, the filtered reads, filter, rows, tags, pager, Promote on `Modal`) → Task 6 (subtitle
  without a current release, `fw-promote-done-close`, focus via a ref, deferred refresh under Test builds: plan
  rulings).
- §7 states → Task 1 (loading), each page task (its empty markup), Task 7 (the by-hand check). §8 focus → Tasks 3, 4,
  5, 6. §9 phone → Task 7. §10 ids → every task; §10.4 renames → Task 4. §11 contrast → Task 1 (unit pairs), Task 7
  (on the page; live-only elements measured when present: plan ruling). Ruling 38 → Task 7 (masked: plan ruling).
- c6-admin-layout counts: 2 after Task 1 → 4 after Task 2 → 6 after Task 3 → 8 after Task 4 → 9 after Task 5 → 11
  after Task 6 → 12 after Task 7. If a count differs, recount with `--list` before calling it a failure.
