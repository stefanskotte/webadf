# Phase C7 Phone layouts (390 px) and About into Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below `lg` both shells become the InfPhone phone shell (one 60 px header row, a four-tab bottom bar whose
`More` opens a menu), search below `sm` opens from a 44 px button, every control the spec names is 44 px below `sm`,
Library, Devices, Upload and Admin Invites get their phone layouts, and About becomes Settings' `#about` section with
`/about` a 307 redirect. Nothing at 1024 px and wider changes except the (i) leaving and About joining Settings, and
`pnpm lint` stays at zero errors.

**Architecture:** CSS-first, on Phase B and C1–C6's pieces. `TopNav` keeps one `nav aria-label="Main"`; below `lg` a
`.nav-tabs` rule in `globals.css` turns the `.seg` pill into a four-cell bar and a Base UI menu (`DropdownMenu`) holds
Help, Settings, About this server, Admin and Sign out. The two layouts move every `sm:` shell rule to `lg:`. Pure rules
live in new client-safe files (`src/lib/nav-tabs.ts`, `src/lib/drop-hint.ts`) and in `src/lib/library-table.ts`
(`titleMeta`). About is `src/components/prefs/about-view.tsx` (markup, no database) plus `about-server.tsx` (the reads,
streamed in a `<Suspense>`); `/about` is a `redirects()` entry in `next.config.ts`. No schema, no migration, no new
route, no new package.

**Tech Stack:** Next.js 16.3.2 App Router. Read before Task 2's redirect:
`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/redirects.md` (read for this plan:
redirects run before the filesystem and before Proxy, `permanent: false` answers 307, query strings pass through).
Read before Task 1's layout edits and Task 2's page edits: `.../03-file-conventions/layout.md` and `page.md`. Also
React 19.2 (`flushSync` from `react-dom`), Tailwind v4, Base UI 1.7 (`@base-ui/react/menu` through
`src/components/ui/dropdown-menu.tsx`, `@base-ui/react/unstable-use-media-query`), sonner 2.0.8 (`offset`,
`mobileOffset`), dnd-kit, vitest (`renderToStaticMarkup` render tests in a node environment, no DOM), and Playwright
1.62.

**Spec:** `docs/superpowers/specs/2026-10-26-phase-c7-phone-about-design.md`. It is binding: read all of it,
including §16's task split, the "Review Focus candidates" and the 30 Rulings. Where this plan resolves a spec gap or
a conflict it says so in a line starting **Plan ruling**, and the controller relays those to the operator.

## Global Constraints

- Every `data-testid` in spec §13.1 keeps its name and its meaning. The new ids are §13.2's: `search-open`,
  `search-cancel`, `nav-more`, `nav-more-menu`, `more-help`, `more-settings`, `more-about`, `more-admin`,
  `more-sign-out`, `collections-new`, `df1-change-<id>`, `settings-about`, plus the element ids `about`,
  `about-heading`, `search-row` and `collection-create-form`. The one id removed is `about-link` (Task 2). The data
  attributes this plan adds (`data-tab-bar`, `data-current`, `data-meta`, `data-tile`, `data-about-bone`) are not
  test ids. Keep every existing `data-testid` unless the spec removes it.
- **Nothing at 1024 px and wider changes** (spec §0, Ruling 11), except that the header loses the (i) and Settings gains
  the About section and its list item. Every `lg:` value written in this plan is the value that is there today.
- One `nav aria-label="Main"` in the DOM. A control that exists at only one size is hidden with `max-lg:hidden` /
  `lg:hidden` (`display: none`), never duplicated.
- Same requests, bodies, guards, confirms and toast words everywhere. The one new toast is Plan ruling Task 1
  (sign-out failure).
- **Busy controls use `aria-disabled` plus a guard in the handler, never native `disabled`**: Chromium blurs a focused
  button the moment it becomes disabled, and focus falls to `<body>`. This applies to every control this phase writes
  or rewrites. A control whose busy state this phase does not touch keeps its attribute (spec §12, "Busy: unchanged").
- **Every request sits in `try/catch/finally`**, so a dropped connection never leaves a control busy.
- **Focus never falls to `<body>`.** When a control goes away, the fallback is a heading with a visible ring (the
  page `h1`, or a card's `h2` built with `SETTINGS_H2`), or the control that opened what closed.
- **Live regions are present from first paint** (render the `role="status"` element empty; never mount it with its
  text).
- **Call `hydrated(page, testId, handler)` from `e2e/device-helpers.ts` before a synthetic event or `setInputFiles`**,
  and before the first tap or click on a client control that has a test id.
- "Show both values of a state": every state renders a word in each value. No `sr-only` element carries a width or
  layout utility (`w-*`, `h-*`, `flex`, `grid`, `p-*`, `m-*`, `absolute`).
- In-app dialogs and menus only; never a new `window.confirm` or `alert`.
- Phone touch target: 44 px (`min-h-11`, plus `min-w-11` for icon-only buttons) for every control the spec names, from
  0 to 639 px. Prose links and the "?" are exempt (Rulings 14, 29). Nothing scrolls the page sideways at 360, 390 or
  414 px.
- Colours only through tokens. A dark filled control carries `text-white`, or here `text-(--surface)` on `bg-(--ink)`
  in classes, because an inline colour beats a responsive class: **any colour that changes between widths lives in a
  class, never in an inline `style`.**
- **Self-hosted deployments keep full parity**: no new external URL, font, package or our-deployment-only word; the
  About section keeps the Repository link and the `Hosted` / `Self-hosted` reading (`SELFHOSTED`) unchanged.
- No schema change, no DB migration, no new API route, no new package. If a task believes one is needed, STOP and
  report. A subagent never runs `drizzle-kit`, `pnpm db:migrate` or writes under `drizzle/`.
- Firmware, `wifi-floppy/`, the board and the Amiga are not touched.
- Next.js 16.3: read the guide named in Tech Stack in `node_modules/next/dist/docs/` before writing a redirect, a
  layout, a page or a `loading.tsx`, and heed its deprecation notices.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): a real `pnpm install --offline`, `.env.local` present
  (never print it, never `cat` it, never echo a value from it), `npx next typegen`, and the `adf-archive` symlink.
- **Unit tests: `pnpm test --testTimeout=30000 <files>`**, with no `--` before the flag. Types: `npx tsc --noEmit`. The
  whole unit suite (`pnpm test --testTimeout=30000`) is green before each commit; no commit follows a red run.
- **Lint today: `✖ 12 problems (0 errors, 12 warnings)`** (measured on `d93de6e`). It must read exactly that after
  every task and exit 0: no new error and no new warning. An import a task stops using is removed in that task.
- **e2e: `PORT=3100`, one run at a time, in the foreground (never `run_in_background`), and every command under 9
  minutes.** The suite hits the **LIVE production DB**: assert only about rows a test made (fresh sign-ups,
  `runTag()`), never absolute counts. Run big specs by `--project` and by `-g` halves, checking each pattern first
  with `--list`. `admin-scan` takes 8.7 min and `tosec-scan` 14.6 min when run whole: never run either whole.
- **The `mobile` Playwright project only runs files ending in `mobile.spec.ts`** (390 × 844, `hasTouch`,
  `isMobile`). Every other spec runs in `desktop` (1280 × 720) and sets a phone width with `setViewportSize`.
- House rules, every task: re-check `git status --short` before staging (other sessions change this tree), then
  **`git add <paths>`, never `-A` or `.`**, and never anything under `wifi-floppy/` or `.superpowers/`. No `git stash`
  in any form. Stop only your own PIDs; never pattern-kill. Every commit message ends with exactly these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`
- **Screenshots never show an email address or board name**: mask them (Task 9), and none is committed.
- A renamed visible word is grepped across the WHOLE repo (scripts, docs, CI, e2e), not only `e2e/`, excluding
  `node_modules`, `.next` and `docs/superpowers/`. This phase renames the e2e test titles it rewrites, the help text of
  topics `about` and `preferences`, and two README lines. It renames no product word.

## Review Focus

1. **`/about` bookmarked, or `/settings#about` reloaded, on a phone**: the section list is `hidden` below `lg` but still
   mounted, and its arrival jump must put the About heading in view. That only works if `#about` exists in the
   first render, so the card and its heading sit outside the `Suspense` that streams the groups (Plan ruling,
   Task 2). Pinned in Task 2's `about-page.spec` test at 390 and in `C7-07`.
2. **Search on a phone: type, then tap a result.** The page navigates once, the row closes and focus lands on the
   search button rather than on `<body>`. Pinned in Task 3's `C7-03b`, which compares `history.length` before and after.
3. **The Send tile with no board** (`send-dropzone` with no targets): it says `Pair a board first`, a tap opens no file
   chooser, and the reason stays on screen. Pinned in Task 7's `C7-06b`.
4. **360 px (small Android) with a board**: the header row (home, a full-width chip, search) and the four tabs fit,
   with nothing scrolling sideways. Pinned in Task 1's `C7-01b`; every area's touch sweep (`C7-09*`) also measures 360
   and 414.
5. **Rename a collection on a phone**: the field opens on a line under the chip row (not inside a chip that scrolls),
   Enter saves, and focus returns to the chip's ⋯ rather than to `<body>`. Pinned in Task 5's `C7-04b`.

## Common commands

- Unit: `pnpm test --testTimeout=30000 <path> [<path> …]`; all of them: `pnpm test --testTimeout=30000`; types:
  `npx tsc --noEmit`; lint: `pnpm lint` (then `echo "exit $?"` prints `exit 0`).
- e2e, mobile project: `PORT=3100 npx playwright test e2e/<name>.mobile.spec.ts --project=mobile [-g "<pattern>"]`.
- e2e, desktop project: `PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<pattern>"]`.
- Before each `-g` run, check that the pattern selects what the step says with
  `npx playwright test <file> --project=<p> --list [-g "<pattern>"]`. `-g` is a case-sensitive RegExp, so a pattern
  holds no unescaped `(`, `)`, `?` or `+`. If a count differs from the step, recount with `--list` before calling it a
  failure.
- The new phone spec is **`e2e/c7-phone.mobile.spec.ts`**, and its tests are named `C7-01` … `C7-11` so a batch can
  select them: `-g "C7-0[1-4]"` and `-g "C7-0[5-9]|C7-1[01]"`.
- Per-test times for sizing batches, estimated from earlier runs: a sign-up is about 5 s, a pairing 1 s, a phone
  layout test 15–40 s, a touch-sweep test 40–90 s and a `header-overlap` sweep 40–90 s. A file of more than about 15
  tests is split into `-g` halves.

## File map

| File | Task | What changes |
|---|---|---|
| `src/lib/nav-tabs.ts` + `.test.ts` (new) | 1 | `isMoreCurrent`, `isMoreItemCurrent`, `moreItems` |
| `src/components/shell/top-nav.tsx` + `top-nav.test.ts` (new) | 1 | tab look, tab bar marks, `More` menu |
| `src/components/sign-out-button.tsx` | 1 | `useSignOut()` (try/catch/finally, guard), used by the menu too |
| `src/app/(app)/layout.tsx`, `src/app/(admin)/layout.tsx` | 1, 2 | `sm:` → `lg:` shell, 60 px row, header controls from `lg`; (i) out (2) |
| `src/components/shell/header-start.tsx`, `drive-chips.tsx` | 1 | lane and chip slot below `lg` |
| `src/app/globals.css` | 1, 4 | `.nav-tabs`, `--toast-bottom` (1); `.seg` 44 + wrap below `sm` (4) |
| `src/components/ui/sonner.tsx` | 1 | `offset` / `mobileOffset` |
| `src/lib/help/topics.tsx` | 1, 2 | `preferences` (the gear), `about` (where it lives) |
| `src/components/prefs/about-view.tsx` + `.test.ts`, `about-server.tsx` (new) | 2 | the About card, bone, groups; the reads |
| `src/app/(app)/settings/page.tsx`, `loading.tsx`, `loading.test.ts` | 2 | the section, list item, fifth bone |
| `next.config.ts`, `README.md`, `.github/workflows/image.yml` | 2 | redirect; wording and comments |
| `src/app/(app)/about/page.tsx`, `src/components/shell/about-link.tsx` | 2 | deleted |
| `src/components/shell/side-nav.tsx`, `side-nav.test.ts` | 2 | doc comment, fixture route |
| `src/components/shell/search-box.tsx` | 1, 3 | interim width (1); opener, row, Cancel, scrim (3) |
| `src/components/help/help-tip.tsx`, `help-browser.tsx` | 4 | 40 px hit area; hash jump and 44 px controls |
| `src/app/(app)/disks/[id]/files/loading.tsx` + test | 4 | the stacked Disk card bone |
| the §3.2 controls (table in Task 4) | 4 | `max-sm:min-h-11` |
| `src/components/collections/collection-rail.tsx`, `src/app/(app)/library/loading.tsx` + test | 5 | chips, phone rename and create |
| `src/lib/library-table.ts` + test, `src/components/library/game-table.tsx` | 5 | `titleMeta`, the three-column phone row |
| `src/app/(app)/devices/page.tsx`, `src/components/devices/*`, `src/components/nfc/fob-button.tsx` | 6 | head, card sizes, DF1 disclosure |
| `src/lib/drop-hint.ts` + test, `src/components/ingest/drop-card.tsx` + test, `dropzone.tsx`, `url-fetch.tsx`, `src/components/send/send-panel.tsx`, `src/app/(app)/ingest/page.tsx` | 7 | tiles |
| `src/components/admin/admin-nav.tsx` + test, `src/app/(admin)/admin/invites/page.tsx`, `copy-invite-buttons.tsx`, `revoke-invite-button.tsx` | 8 | wrap, stacked Invites |
| `e2e/c7-phone.mobile.spec.ts` (new) | 1–8 | spec §14's tests |
| the e2e sites of spec §13.4 | 1–9 | as each task lists |

---

### Task 1: The phone shell, in both shells: the 60 px row, the tab bar, `More`, toasts above the bar

**Files:**
- Create: `src/lib/nav-tabs.ts`, `src/lib/nav-tabs.test.ts`, `src/components/shell/top-nav.test.ts`,
  `e2e/c7-phone.mobile.spec.ts`
- Modify: `src/components/shell/top-nav.tsx` (whole file), `src/components/sign-out-button.tsx` (whole file),
  `src/app/(app)/layout.tsx:51-152`, `src/app/(admin)/layout.tsx:27-100`, `src/components/shell/header-start.tsx:72`,
  `src/components/shell/drive-chips.tsx:66-71`, `src/components/shell/search-box.tsx:323` and `:348`,
  `src/app/globals.css` (after line 308, and at the end of the `@layer components` block that ends at line 363),
  `src/components/ui/sonner.tsx:29-72`, `src/lib/help/topics.tsx:669`, `e2e/mobile.spec.ts:86-108`,
  `e2e/shell.spec.ts:35-46`, `e2e/header-overlap.spec.ts`, `e2e/drive-chips.spec.ts:407-428`,
  `e2e/c6-admin-layout.spec.ts:97-118`

**Interfaces:**
- Consumes: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`
  (`@/components/ui/dropdown-menu`); `Menu as MenuPrimitive` (`@base-ui/react/menu`, for `LinkItem`); `MENU_ITEM`
  (`@/components/ui/menu-item-look`); `cn` (`@/lib/utils`); `signOut` (`@/lib/auth-client`).
- Produces:
  - `isMoreCurrent(pathname: string): boolean`, `isMoreItemCurrent(pathname: string, href: string): boolean`,
    `type MoreItem = { id: 'more-help' | 'more-settings' | 'more-about' | 'more-admin'; href: string; label: string }`,
    `moreItems(showAdmin: boolean): MoreItem[]` (`@/lib/nav-tabs`)
  - `useSignOut(): { busy: boolean; run: () => Promise<void> }` (`@/components/sign-out-button`)
  - `TopNav({ showAdmin })`: one `nav aria-label="Main"` with class `seg nav-tabs lg:w-max`, the links, and the
    `nav-more` trigger; each tab holds a `span[data-tab-bar]`
  - CSS: `.nav-tabs` (below `lg`), the token `--toast-bottom`
  - e2e helpers in `e2e/c7-phone.mobile.spec.ts`: `noSideways(page)`, `tabs(page)`, `ADMIN_PAGES`

**Plan ruling** (spec §2.3, "`more-sign-out` … the `SignOutButton` action, same words and flow", against the
constraint "try/catch/finally on every request"): the header button and the menu item share `useSignOut()`, which
wraps today's `await signOut(); router.push('/sign-in')` in try/catch/finally with an in-flight guard and
`aria-disabled` while busy. A failure, which today was an unhandled rejection that showed nothing, now toasts
`Could not sign out` with the description `Check the connection and try again.` These are new words; relay them.

**Plan ruling** (spec §2.3, "The item for the current page carries `aria-current`"): `About this server` links to
`/settings#about`, and `usePathname()` cannot see a hash, so that item is never marked current. `Settings` is marked
on `/settings*`, `Help` on `/help*` and `Admin` on `/admin*`.

**Plan ruling** (spec §2.2, "a 44 × 44 hit area around the 26 px `Logo`"): `Logo` takes one numeric `size`, and from
`lg` the wordmark must not change, so it stays `size={24}` at every width. The hit area is 44 × 44.

**Plan ruling** (help text follows behaviour): topic `preferences` says "Settings (the gear at the top)". Below `lg`
the gear is in `More`, so the sentence becomes "Settings (the gear at the top; More, then Settings, on a phone)".
The spec's §10.5 table does not list this line.

**Plan ruling** (Task 2 owns the (i)): in this task the (i) stays inside the `lg:flex` group beside the gear (hidden
below `lg`, unchanged from `lg`). Task 2 deletes it, so `about-page`, the 1280 half of `shell.spec` and
`contrast.spec:370` keep passing between the two tasks.

- [ ] **Step 1: Write the failing tests**

`src/lib/nav-tabs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isMoreCurrent, isMoreItemCurrent, moreItems } from './nav-tabs';

describe('isMoreCurrent (C7 spec §2.3)', () => {
  it('is current on Settings, Help and Admin and every page under them', () => {
    for (const p of ['/settings', '/help', '/admin', '/admin/users', '/admin/firmware']) expect(isMoreCurrent(p), p).toBe(true);
  });
  it('is not current on the three other tabs, a title, a disk, or a lookalike path', () => {
    for (const p of ['/library', '/devices', '/ingest', '/games/g1', '/disks/d1/files', '/helpers', '/administrator']) {
      expect(isMoreCurrent(p), p).toBe(false);
    }
  });
});

describe('isMoreItemCurrent', () => {
  it('marks the page the item names, and the pages under it', () => {
    expect(isMoreItemCurrent('/settings', '/settings')).toBe(true);
    expect(isMoreItemCurrent('/admin/users', '/admin')).toBe(true);
    expect(isMoreItemCurrent('/help', '/settings')).toBe(false);
  });
  it('never marks an item with a hash: the pathname cannot tell one (Plan ruling)', () => {
    expect(isMoreItemCurrent('/settings', '/settings#about')).toBe(false);
  });
});

describe('moreItems', () => {
  it("is Help, Settings, About this server for a member, in the spec's order", () => {
    expect(moreItems(false).map((i) => [i.id, i.href, i.label])).toEqual([
      ['more-help', '/help', 'Help'],
      ['more-settings', '/settings', 'Settings'],
      ['more-about', '/settings#about', 'About this server'],
    ]);
  });
  it('adds Admin last only when the server said so', () => {
    expect(moreItems(true).map((i) => i.id)).toEqual(['more-help', 'more-settings', 'more-about', 'more-admin']);
    expect(moreItems(true)[3].href).toBe('/admin');
  });
});
```

`src/components/shell/top-nav.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nav = vi.hoisted(() => ({ path: '/library' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock('@/lib/auth-client', () => ({ signOut: async () => ({}) }));

const { TopNav } = await import('./top-nav');
const render = (path: string, showAdmin = false) => {
  nav.path = path;
  return renderToStaticMarkup(createElement(TopNav, { showAdmin }));
};
/** Each link's opening tag and its text (a tab holds an empty bar span before the word). */
const links = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>(?:<span[^>]*><\/span>)?([^<]*)<\/a>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
const more = (html: string) => html.match(/<button[^>]*data-testid="nav-more"[^>]*>/)?.[0] ?? '';

describe('TopNav (C7 spec §2.3, Rulings 4, 5, 8)', () => {
  it('is one Main nav: the .seg pill from lg, the tab bar below it', () => {
    const html = render('/library');
    expect(html.match(/<nav /g)?.length).toBe(1);
    expect(html).toContain('<nav aria-label="Main" class="seg nav-tabs lg:w-max">');
  });
  it('keeps Library, Devices, Upload, Help (+ Admin); Help and Admin are in More below lg', () => {
    const member = links(render('/library'));
    expect(member.map((l) => l.text)).toEqual(['Library', 'Devices', 'Upload', 'Help']);
    expect(member[3].attrs).toContain('max-lg:hidden');
    for (const l of member.slice(0, 3)) expect(l.attrs).not.toContain('max-lg:hidden');
    const admin = links(render('/library', true));
    expect(admin.map((l) => l.text)).toEqual(['Library', 'Devices', 'Upload', 'Help', 'Admin']);
    expect(admin[4].attrs).toContain('max-lg:hidden');
  });
  it('More is a menu button shown below lg only, current on Settings, Help and Admin', () => {
    expect(more(render('/library'))).toContain('lg:hidden');
    expect(more(render('/library'))).toContain('aria-haspopup="menu"');
    expect(more(render('/library'))).not.toContain('aria-current');
    for (const p of ['/settings', '/help', '/admin/users']) expect(more(render(p, true)), p).toContain('aria-current="page"');
    expect(render('/library')).toMatch(/data-testid="nav-more"[^>]*>(?:<span[^>]*><\/span>)?More<\/button>/);
  });
  it('every tab carries its bar: amber on the current one, transparent on the others', () => {
    const html = render('/devices');
    expect(html.match(/data-tab-bar=""/g)?.length).toBe(5);   // four links + More
    expect(html).toMatch(/aria-current="page"[^>]*><span aria-hidden="true" data-tab-bar="" class="[^"]*" style="background:var\(--accent-amber\)"><\/span>Devices/);
    expect(html.match(/background:var\(--accent-amber\)/g)?.length).toBe(1);
    expect(html.match(/background:transparent/g)?.length).toBe(4);
  });
  it('the menu items are not in the page while the menu is closed', () => {
    expect(render('/library', true)).not.toContain('more-help');
  });
});
```

`e2e/c7-phone.mobile.spec.ts` (new):

```ts
import { test, expect, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, hydrated, pairDevice } from './device-helpers';

/**
 * Phase C7 (spec 2026-10-26-phase-c7-phone-about-design.md §14): the phone pass, measured rather than read off
 * classes. The `mobile` project runs this file (390 x 844, hasTouch, isMobile); a test that needs another width sets
 * it. The DB is the live one: every assertion is about rows the test made. Names are C7-NN so batches can select
 * them with -g.
 */
test.afterAll(async () => { await cleanupSeeded(); });

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
/** The bar's visible cells: below lg, Library, Devices, Upload, More. */
const tabs = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).locator(':scope > a, :scope > button').filter({ visible: true });
const ADMIN_PAGES = ['/admin', '/admin/users', '/admin/invites', '/admin/scan', '/admin/firmware'];

// ---- The shell (spec §2, Rulings 1-5, 8, 15) ---------------------------------------------------------------

test('C7-01 header at 390: one row of at most 60 px; home and the chip on it, 44 px; no gear, Sign out or (i)', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request, 'C7 Phone');
  await page.goto('/library');
  const header = (await page.getByTestId('app-header').boundingBox())!;
  expect(header.height).toBeLessThanOrEqual(61);
  const home = (await page.getByTestId('wordmark-home').boundingBox())!;
  const chip = (await page.getByTestId('drives-compact').boundingBox())!;
  for (const [name, b] of [['home', home], ['chip', chip]] as const) {
    expect(b.height, name).toBeGreaterThanOrEqual(44);
    expect(b.y, name).toBeGreaterThanOrEqual(header.y - 0.5);
    expect(b.y + b.height, name).toBeLessThanOrEqual(header.y + header.height + 0.5);
  }
  expect(home.width).toBeGreaterThanOrEqual(44);
  expect(chip.x).toBeGreaterThanOrEqual(home.x + home.width);
  await expect(page.getByTestId('wordmark-home')).toHaveAccessibleName('webfloppy');
  for (const id of ['settings-link', 'sign-out', 'about-link']) await expect(page.getByTestId(id)).toBeHidden();
  await noSideways(page);
});

test('C7-01b at 360 px with a board, the header row and the four tabs fit and nothing scrolls sideways (Review Focus 4)', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signUpFresh(page);
  await pairDevice(page, request, 'A board with a rather long name for a small phone');
  for (const path of ['/library', '/settings']) {
    await page.goto(path);
    expect((await page.getByTestId('app-header').boundingBox())!.height, path).toBeLessThanOrEqual(61);
    await expect(tabs(page)).toHaveCount(4);
    for (const t of await tabs(page).all()) {
      const b = (await t.boundingBox())!;
      expect(b.x, path).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, path).toBeLessThanOrEqual(360);
    }
    await noSideways(page);
  }
});

test('C7-02 bottom bar: four tabs at least 44 x 70, the current one per route, More current on Help and Settings', async ({ page }) => {
  await signUpFresh(page);
  for (const [path, current] of [
    ['/library', 'Library'], ['/devices', 'Devices'], ['/ingest', 'Upload'], ['/help', 'More'], ['/settings', 'More'],
  ] as const) {
    await page.goto(path);
    await expect(tabs(page)).toHaveText(['Library', 'Devices', 'Upload', 'More']);
    for (const t of await tabs(page).all()) {
      const b = (await t.boundingBox())!;
      expect(b.height, path).toBeGreaterThanOrEqual(44);
      expect(b.width, path).toBeGreaterThanOrEqual(70);
    }
    await expect(tabs(page).and(page.locator('[aria-current="page"]'))).toHaveText([current]);
    expect(await page.getByRole('navigation', { name: 'Main' }).evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
  }
});

test('C7-02b the More menu: items at least 44 px and on screen, each reaches its page, Sign out signs out', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  const open = async () => {
    await hydrated(page, 'nav-more');
    await page.getByTestId('nav-more').tap();
    await expect(page.getByTestId('nav-more-menu')).toBeVisible();
  };
  await open();
  await expect(page.getByTestId('more-admin')).toHaveCount(0);   // a member has no Admin
  for (const id of ['more-help', 'more-settings', 'more-about', 'more-sign-out']) {
    const item = page.getByTestId(id);
    await expect(item).toBeVisible();
    // The popup opens with a zoom-in-95 animation: a box read mid-animation is 95 % of the truth.
    await expect.poll(async () => (await item.boundingBox())!.height, { message: id }).toBeGreaterThanOrEqual(44);
    const b = (await item.boundingBox())!;
    expect(b.x, id).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, id).toBeLessThanOrEqual(390);
    expect(b.y, id).toBeGreaterThanOrEqual(0);
  }
  await page.getByTestId('more-help').tap();
  await expect(page).toHaveURL(/\/help$/);
  await open();
  await expect(page.getByTestId('more-help')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('more-settings').tap();
  await expect(page).toHaveURL(/\/settings$/);
  await open();
  await page.getByTestId('more-about').tap();
  await expect(page).toHaveURL(/\/settings#about$/);
  await open();
  await page.getByTestId('more-sign-out').tap();
  await expect(page).toHaveURL(/\/sign-in/);
});

test('C7-02c the admin bar: four tabs that fit on every admin page, More current, Admin current in the menu', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsSuperAdmin(page);
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(tabs(page)).toHaveText(['Library', 'Devices', 'Upload', 'More']);
    await expect(tabs(page).and(page.locator('[aria-current="page"]'))).toHaveText(['More']);
    expect(await page.getByRole('navigation', { name: 'Main' }).evaluate((n) => n.scrollWidth <= n.clientWidth), path).toBe(true);
    await noSideways(page);
  }
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').tap();
  await expect(page.getByTestId('more-admin')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('more-settings')).toBeVisible();
  await expect(page.getByTestId('more-sign-out')).toBeVisible();
});

test('C7-10 a toast ends above the bottom bar at 390 and at 900 px', async ({ page }) => {
  await signUpFresh(page);
  await page.route('**/api/disks/create', (r) => r.abort());
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/library');
    // createAdf's own wait (e2e/helpers.ts): a click before hydration opens nothing.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="create-adf"]');
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
    });
    await page.getByTestId('create-adf').click();
    await page.getByTestId('create-adf-size-dd').click();
    await page.getByTestId('create-adf-fs-ffs').click();
    await page.getByTestId('create-adf-submit').click();
    const shown = page.locator('[data-sonner-toast]').filter({ hasText: 'Could not reach the server' }).first();
    await expect(shown).toBeVisible();
    const bar = page.getByRole('navigation', { name: 'Main' }).locator('xpath=../..');   // nav -> clamp -> fixed bar
    await expect.poll(async () => {
      const t = (await shown.boundingBox())!;
      const b = (await bar.boundingBox())!;
      return Math.round(b.y - (t.y + t.height));
    }, { message: `toast bottom vs bar top at ${width}` }).toBeGreaterThanOrEqual(0);
  }
});
```

`e2e/mobile.spec.ts`: add `hydrated` to the device-helpers import (`import { cleanupSeeded, seedDisk, addDisk, pairDevice, authHeader, hydrated } from './device-helpers';`) and replace lines 86-108 (the test `the bottom bar reaches every route, and there is only one nav`) with:

```ts
test('the bottom bar reaches every route through four tabs and More, and there is only one nav', async ({ page }) => {
  await seedLibrary(page, 2);
  await page.goto('/library');

  // One site nav, not a desktop copy plus a mobile copy -- a duplicate
  // would make getByRole('link') ambiguous here AND in the 1280 specs. The
  // library's pager is a <nav> of its own (aria-label "Pages"), so it is left
  // out by name rather than counted.
  const navs = page.locator('nav:not([aria-label="Pages"])');
  await expect(navs).toHaveCount(1);

  const bar = navs;
  const box = (await bar.boundingBox())!;
  // Actually at the bottom of the 844px viewport, not merely styled for it.
  expect(box.y + box.height).toBeGreaterThan(760);

  // C7 (spec §2.3): Library, Devices, Upload and More, each a finger's height.
  const tabs = bar.locator(':scope > a, :scope > button').filter({ visible: true });
  await expect(tabs).toHaveText(['Library', 'Devices', 'Upload', 'More']);
  for (const t of await tabs.all()) expect((await t.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await page.getByRole('link', { name: 'Devices' }).tap();
  await expect(page).toHaveURL(/\/devices$/);
  await page.getByRole('link', { name: 'Upload' }).tap();
  await expect(page).toHaveURL(/\/ingest$/);
  await page.getByRole('link', { name: 'Library' }).tap();
  await expect(page).toHaveURL(/\/library/);
  // Help lives in More now.
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').tap();
  await page.getByTestId('more-help').tap();
  await expect(page).toHaveURL(/\/help$/);
});
```

`e2e/shell.spec.ts`: replace lines 35-46 (the test `below sm the search box keeps 16px from the (i) button, …`) with:

```ts
test('below lg the header is one 60 px row (home, search); from lg the search box keeps 16px from the next control', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/library');
  const header = (await page.getByTestId('app-header').boundingBox())!;
  expect(header.height, 'one row').toBeLessThanOrEqual(61);
  const home = (await page.getByTestId('wordmark-home').boundingBox())!;
  // The search control is the field until Task 3 and the 44 px button after it: whichever is shown.
  const search = (await page.getByTestId('app-header')
    .locator('[data-testid="search-open"]:visible, [data-testid="search-input"]:visible').first().boundingBox())!;
  expect(Math.abs((home.y + home.height / 2) - (search.y + search.height / 2)), 'same line at 390').toBeLessThan(4);

  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto('/library');
  const box = (await page.getByTestId('search-input').boundingBox())!;
  const next = (await page.getByTestId('about-link').boundingBox())!;
  // Same line, and spec §6.1's 16px between them (mr-2 + the group's gap-2).
  expect(Math.abs((box.y + box.height / 2) - (next.y + next.height / 2)), 'same line at 1280').toBeLessThan(4);
  expect(next.x - (box.x + box.width), 'gap at 1280').toBeCloseTo(16, 0);
});
```

`e2e/header-overlap.spec.ts`: add `import { cleanupSeeded, pairDevice } from './device-helpers';` and
`test.afterAll(async () => { await cleanupSeeded(); });` after the imports; change line 17 to
`const WIDTHS = [1024, 1180, 1280, 1440, 1536, 1920];` and add a sentence to the doc comment: `Below lg (C7 spec §2.1,
Ruling 1) the nav is the bottom tab bar instead; the tablet sweep at the end pins that.` Append:

```ts
// C7 (spec §2.1, Ruling 1): below lg the nav is the bottom tab bar: four tabs, every one fully on screen, no
// scrolling inside it, and a header of one 60 px row.
const TABLET = [640, 768, 1000];

async function tabletSweep(page: Page, shell: 'app' | 'admin', path: string) {
  const failures: string[] = [];
  for (const width of TABLET) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(path);
    const nav = page.getByTestId(`${shell}-header`).getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    const m = await nav.evaluate((n) => ({
      bottom: n.getBoundingClientRect().bottom,
      fits: n.scrollWidth <= n.clientWidth,
      cells: [...n.children].filter((c) => (c as HTMLElement).offsetWidth > 0)
        .map((c) => ({ l: c.getBoundingClientRect().left, r: c.getBoundingClientRect().right })),
      vw: window.innerWidth,
      header: n.closest('header')!.getBoundingClientRect().height,
    }));
    if (m.bottom < 800 - 80) failures.push(`${width}: the bar is not at the bottom (nav bottom ${m.bottom.toFixed(1)})`);
    if (!m.fits) failures.push(`${width}: the tabs scroll`);
    if (m.cells.length !== 4) failures.push(`${width}: ${m.cells.length} tabs, not 4`);
    if (m.cells.some((c) => c.l < 0 || c.r > m.vw + 0.5)) failures.push(`${width}: a tab is off screen`);
    if (m.header > 61) failures.push(`${width}: the header is ${m.header.toFixed(1)} px tall`);
  }
  expect(failures, failures.join('\n')).toEqual([]);
}

test('below lg, a member with a board: the tab bar at the bottom, four whole tabs, a one-row header', async ({ page, request }) => {
  test.setTimeout(90_000);
  await signUpFresh(page);
  await pairDevice(page, request, 'Tablet board');
  await tabletSweep(page, 'app', '/library');
});

test('below lg, the super-admin in the app shell and in the admin shell: the same', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsSuperAdmin(page);
  await tabletSweep(page, 'app', '/library');
  await tabletSweep(page, 'admin', '/admin');
});
```

`e2e/drive-chips.spec.ts`: rename the test at line 407 to
`'at 390px one Drives control on the header row lists every board, and nothing overflows'` and replace lines 421-428
(from `// On the wordmark's line, clear of it, and clear of the search box below.` through
`expect(trigger.y + trigger.height).toBeLessThanOrEqual(search.y);`) with:

```ts
  // On the header's single 60 px row (C7 spec §2.2, §5): after the home link, 44 px tall, filling the middle, and
  // clear of the search control on its right (the field until C7 Task 3, the 44 px button after it).
  const header = (await page.getByTestId('app-header').boundingBox())!;
  const wordmark = (await page.getByTestId('wordmark-home').boundingBox())!;
  const trigger = (await compact.boundingBox())!;
  const search = (await page.getByTestId('app-header')
    .locator('[data-testid="search-open"]:visible, [data-testid="search-input"]:visible').first().boundingBox())!;
  expect(trigger.height).toBeGreaterThanOrEqual(44);
  expect(trigger.x).toBeGreaterThanOrEqual(wordmark.x + wordmark.width);
  expect(trigger.x + trigger.width).toBeLessThanOrEqual(search.x);
  for (const b of [wordmark, trigger, search]) expect(b.y + b.height).toBeLessThanOrEqual(header.y + header.height + 0.5);
```

`e2e/c6-admin-layout.spec.ts`: replace lines 97-118 (the test `at 390px the admin header fits: …`) with:

```ts
test('at 390px the admin header is one row: no overflow, no gear or Sign out there; they are in the More menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const header = page.getByTestId('admin-header');
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(61);
  await expect(header.getByTestId('settings-link')).toBeHidden();
  await expect(header.getByTestId('sign-out')).toBeHidden();
  await expect(header.getByTestId('admin-email')).toBeHidden();
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  expect(o.sw).toBeLessThanOrEqual(o.cw);
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').click();
  await expect(page.getByTestId('nav-more-menu')).toBeVisible();
  await expect(page.getByTestId('more-settings')).toBeVisible();
  await expect(page.getByTestId('more-sign-out')).toBeVisible();
  await expect(page.getByTestId('more-admin')).toHaveAttribute('aria-current', 'page');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/nav-tabs.test.ts src/components/shell/top-nav.test.ts`
Expected: FAIL. `nav-tabs.test.ts` fails with `Cannot find module './nav-tabs'`; `top-nav.test.ts` fails with
`expected '…' to contain '<nav aria-label="Main" class="seg nav-tabs lg:w-max">'`.

Run: `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-0[12]|C7-10"`
Expected: FAIL (`6` tests). C7-01's header is 104–113 px tall; C7-02 finds five tabs, not `More`; C7-10's toast
overlaps the bar.

- [ ] **Step 3: Implement**

`src/lib/nav-tabs.ts`:

```ts
// The phone and tablet tab bar's rules (C7 spec §2.3, Rulings 4, 8): pure and client-safe.

/** The routes the bar's More tab stands for. More is current on any of them. */
export const MORE_ROUTES = ['/help', '/settings', '/admin'] as const;

const under = (pathname: string, route: string) => pathname === route || pathname.startsWith(`${route}/`);

/** Whether the More tab is the current one. The menu items name the page, so the reading is in words too. */
export function isMoreCurrent(pathname: string): boolean {
  return MORE_ROUTES.some((r) => under(pathname, r));
}

/**
 * Whether a More menu item is the current page. An item with a hash (About this server) is never current: a pathname
 * cannot see a hash, and Settings already names /settings (Plan ruling, C7 Task 1).
 */
export function isMoreItemCurrent(pathname: string, href: string): boolean {
  return !href.includes('#') && under(pathname, href);
}

export type MoreItem = { id: 'more-help' | 'more-settings' | 'more-about' | 'more-admin'; href: string; label: string };

/** The More menu's links, in the spec's order. Admin is included only when the server decided so (`showAdmin`). */
export function moreItems(showAdmin: boolean): MoreItem[] {
  return [
    { id: 'more-help', href: '/help', label: 'Help' },
    { id: 'more-settings', href: '/settings', label: 'Settings' },
    { id: 'more-about', href: '/settings#about', label: 'About this server' },
    ...(showAdmin ? [{ id: 'more-admin' as const, href: '/admin', label: 'Admin' }] : []),
  ];
}
```

`src/components/sign-out-button.tsx` (whole file):

```tsx
'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

/**
 * Sign out, for the header button (from lg) and the More menu's item (below lg): one flow, the same words. The
 * request sits in try/catch/finally with an in-flight guard, so a dropped connection says so and never leaves the
 * control busy (Plan ruling, C7 Task 1: the failure toast is new).
 */
export function useSignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await signOut();
      router.push('/sign-in');
    } catch {
      toast.error('Could not sign out', { description: 'Check the connection and try again.' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}

export function SignOutButton() {
  const s = useSignOut();
  return (
    <Button
      variant="ghost"
      // The ghost variant's colours are set here for the header.
      data-testid="sign-out"
      aria-disabled={s.busy || undefined}
      className="h-9 rounded-[10px] px-3.5 text-[14px] font-medium text-(--muted) hover:bg-(--track) hover:text-(--ink)"
      onClick={() => void s.run()}
    >
      Sign out
    </Button>
  );
}
```

`src/components/shell/top-nav.tsx` (whole file):

```tsx
"use client";
import { usePathname } from "next/navigation";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Link } from '@/components/shell/link';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_ITEM } from "@/components/ui/menu-item-look";
import { cn } from "@/lib/utils";
import { useSignOut } from "@/components/sign-out-button";
import { isMoreCurrent, isMoreItemCurrent, moreItems } from "@/lib/nav-tabs";

const ITEMS = [
  { href: "/library", label: "Library", phone: true },
  { href: "/devices", label: "Devices", phone: true },
  // Label only -- the route stays /ingest. "Ingest" was jargon for what is
  // plainly an upload; the route and the /api/ingest/* namespace are
  // referenced by the CLI, the proxy matcher and the design docs, so renaming
  // those is a separate, much wider decision.
  { href: "/ingest", label: "Upload", phone: true },
  // Below lg Help is in the More menu (C7 spec §2.3, Ruling 4).
  { href: "/help", label: "Help", phone: false },
];

// Rendered only when the layout says so. `showAdmin` is decided on the server
// by isSuperAdminEmail(); this component must never work it out for itself,
// because a client component cannot read SUPERADMIN_EMAILS and shipping the
// allowlist to the browser to let it try would publish the very thing the
// env var exists to keep out of the database and off the wire.
//
// Hiding the link is presentation, NOT access control -- /admin is guarded by
// requireSuperAdmin() in the (admin) layout, and each /api/admin route guards
// itself. What omitting it preserves is non-disclosure: the plane redirects a
// non-admin to /library rather than 404ing precisely so the response never
// confirms /admin exists, and a link rendered for everyone would leak that in
// the markup anyway.
const ADMIN_ITEM = { href: "/admin", label: "Admin", phone: false };

/**
 * The tab's mark below lg (C7 Ruling 5): a 32 x 4 bar above the word, --accent-amber on the current tab (4.86:1 on the
 * surface; the board's #EE8A2A is 2.49:1) and transparent on the others. Weight, ink and aria-current mark it too.
 * Empty and aria-hidden, so a tab's text and accessible name are just its word.
 */
function TabBar({ current }: { current: boolean }) {
  return (
    <span aria-hidden="true" data-tab-bar="" className="hidden h-1 w-8 rounded-full max-lg:block"
          style={{ background: current ? "var(--accent-amber)" : "transparent" }} />
  );
}

/**
 * The bar's fourth tab below lg (C7 spec §2.3, Ruling 4): a menu of Help, Settings, About this server, Admin (only
 * when the server said so) and Sign out. Current on /settings, /help and /admin. From lg the header carries Help,
 * the gear and Sign out instead, and this button is display:none.
 */
function MoreTab({ showAdmin, pathname }: { showAdmin: boolean; pathname: string }) {
  const current = isMoreCurrent(pathname);
  const signOut = useSignOut();
  // MENU_ITEM is 44 px below sm and 36 px from sm; this menu exists only below lg, so 44 px throughout.
  const item = cn(MENU_ITEM, "sm:h-11");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="nav-more" aria-haspopup="menu" aria-current={current ? "page" : undefined}
                           className="seg-item whitespace-nowrap lg:hidden">
        <TabBar current={current} />
        More
      </DropdownMenuTrigger>
      {/* side="top", align="end": the tab is at the bottom right, and Base UI does not pull an over-wide popup back on
          screen by itself (HANDOFF §3t), so the width is capped to the viewport less its gutters. */}
      <DropdownMenuContent side="top" align="end" data-testid="nav-more-menu"
                           className="w-[min(280px,calc(100vw-32px))] rounded-2xl"
                           style={{ background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", boxShadow: "var(--shadow-card)" }}>
        {moreItems(showAdmin).map((it) => {
          const here = isMoreItemCurrent(pathname, it.href);
          return (
            <MenuPrimitive.LinkItem key={it.id} data-testid={it.id} closeOnClick render={<Link href={it.href} />}
                                    aria-current={here ? "page" : undefined}
                                    className={cn("flex w-full items-center outline-none", item, here ? "font-semibold" : "font-medium")}>
              {it.label}
            </MenuPrimitive.LinkItem>
          );
        })}
        <DropdownMenuSeparator className="my-1" style={{ background: "var(--line)" }} />
        <DropdownMenuItem data-testid="more-sign-out" aria-disabled={signOut.busy || undefined}
                          onClick={() => void signOut.run()} className={cn(item, "font-medium")}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopNav({ showAdmin = false }: { showAdmin?: boolean }) {
  const pathname = usePathname();
  const items = showAdmin ? [...ITEMS, ADMIN_ITEM] : ITEMS;
  return (
    <nav
      aria-label="Main"
      // From lg: the .seg pill, w-max so it stays as wide as its items when the layout clamps it and scrolls. Below lg:
      // .nav-tabs (globals.css) makes the same element a four-cell tab bar (C7 spec §2.3). One nav at every width:
      // a second, phone-only copy would make getByRole('link') ambiguous in the 1280 suite.
      className="seg nav-tabs lg:w-max"
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={item.phone ? "seg-item whitespace-nowrap" : "seg-item whitespace-nowrap max-lg:hidden"}
          >
            <TabBar current={active} />
            {item.label}
          </Link>
        );
      })}
      <MoreTab showAdmin={showAdmin} pathname={pathname} />
    </nav>
  );
}
```

`src/app/globals.css`: after the `--bar-ok:` line (308), inside the same `:root` block, add:

```css
  --toast-bottom:  24px;      /* sonner's bottom offset from lg; below lg it clears the tab bar (C7 spec §3.4) */
```

and after that `:root` block's closing `}` (line 309), add:

```css
/* Below lg the tab bar is fixed at the bottom: toasts sit above it, not over the tabs (C7 spec §3.4, Ruling 15). */
@media (width < 64rem) {
  :root { --toast-bottom: calc(4.75rem + env(safe-area-inset-bottom)); }
}
```

At the end of the `@layer components` block that holds `.seg` (before its closing `}` at line 363), add:

```css
  /* The phone and tablet tab bar (C7 spec §2.3, Ruling 1): below lg TopNav's .seg pill becomes four equal cells, each
     a 52 px column of the 32 x 4 mark and an 11 px word. A tablet does not stretch four tabs over 1000 px. */
  @media (width < 64rem) {
    .nav-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); width: 100%; max-width: 560px;
      margin-inline: auto; padding: 0; gap: 0; background: transparent; border-radius: 0; }
    .nav-tabs .seg-item { height: 52px; min-height: 52px; flex-direction: column; justify-content: center; gap: 3px;
      padding: 0; border-radius: 10px; font-size: 11px; font-weight: 500; color: var(--muted-2);
      background: transparent; box-shadow: none; }
    .nav-tabs .seg-item:hover { background: transparent; color: var(--ink); }
    .nav-tabs .seg-item[aria-current="page"] { color: var(--ink); font-weight: 700; background: transparent; box-shadow: none; }
  }
```

`src/components/ui/sonner.tsx`: in the `<Sonner …>` props, after `className="toaster group"`, add:

```tsx
      // Above the phone and tablet tab bar (C7 spec §3.4, Ruling 15): sonner's own mobile breakpoint is 600 px, and the
      // bar is there up to 1023 px, so the desktop offset reads --toast-bottom, which globals.css raises below lg.
      offset={{ bottom: "var(--toast-bottom)" }}
      mobileOffset={{ bottom: "calc(4.75rem + env(safe-area-inset-bottom))" }}
```

`src/app/(app)/layout.tsx`: replace lines 51-152 (from the comment `{/* The bottom padding is the room …` through
`</header>`) with:

```tsx
      {/* The bottom padding is the room the fixed tab bar occupies below lg (see the wrapper below). It lives here,
          once, rather than on each page: every page under this layout is behind that bar, and a page that forgot the
          padding would hide its own last row under it. 4.5rem >= the bar's 6 + 52 + 8 px. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {/* Below lg one 60 px row (C7 spec §2.2, Rulings 1-3): home, the drive chip filling the middle, search. The
            gear, Sign out and the (i) are in the bar's More menu there. From lg this is today's 72 px bar. */}
        <header
          data-testid="app-header"
          className="relative flex h-[60px] items-center gap-2.5 border-b px-4 lg:h-[72px] lg:gap-4 lg:px-7"
          style={{ background: "var(--surface)", borderColor: "var(--line)" }}
        >
          {/* The wordmark and, after it, a lane that centres the drive chips
              between the wordmark and the pill -- see HeaderStart for the
              geometry (from xl). Below lg the lane is a plain flex row whose
              chip slot fills the middle. */}
          <HeaderStart pillEstimate={showAdmin ? 394 : 317}>
            {/* The wordmark is the way home (operator, 2026-09-21). 44 x 44 at
                least for a finger; the word shows from sm and is sr-only below
                it, so the link keeps its name. */}
            <Link
              href="/library"
              data-testid="wordmark-home"
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2.5 text-[18px] font-bold tracking-[-0.02em] sm:justify-start"
              style={{ color: "var(--ink)", fontFamily: "var(--font-display)" }}
            >
              <Logo size={24} />
              <span className="max-sm:sr-only">webfloppy</span>
            </Link>
            {/* The chip slot: below lg it fills the row (the compact Drives
                control is full width, 44 px); from lg HeaderStart centres the
                chips beside the wordmark as before. No board: empty space. */}
            <div className="flex min-w-0 flex-1 items-center lg:justify-center">
              <DriveChips chips={chips} showAdmin={showAdmin} />
            </div>
          </HeaderStart>
        {/* The nav is centred on the VIEWPORT from xl, which means taking it
            out of flow (mx-auto and a 1fr/auto/1fr grid were both tried and
            measured first; see git history). Between lg and xl it is in flow,
            flex-1, and the pill scrolls inside its clamp when space is short
            (Phase B final review F1: centred, it ran under the search box).

            Below lg the same wrapper is the fixed bottom tab bar (C7 spec §2.3,
            Ruling 1): with a board the header pill showed 0 px of 317 at
            640-700 and was clipped up to 1000; from 1024 it fits in every case.
            Moved by CSS, never duplicated -- a second, phone copy of the nav
            would make getByRole('link') ambiguous under strict mode and fail
            the suite at 1280. e2e/header-overlap.spec.ts pins both. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's. From xl,
            // pointer-events-none on the full-width wrapper, auto on the pill:
            // there the wrapper spans the header and would otherwise swallow
            // clicks meant for the search box behind it.
            //
            // xl:top-[19px] is (72 - 34) / 2: the 72px bar's middle. Below lg
            // the bar's look comes from --nav-scrim / --nav-scrim-hairline.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-2 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md lg:static lg:z-auto lg:min-w-0 lg:flex-1 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none xl:pointer-events-none xl:absolute xl:inset-x-0 xl:top-[19px] xl:bottom-auto xl:h-[34px]"
          >
            {/* data-nav-pill: what HeaderStart measures. Full width below lg,
                so the tab bar can take its 560 px. */}
            <div data-nav-pill className="pointer-events-auto max-w-full overflow-x-auto max-lg:w-full">
              <TopNav showAdmin={showAdmin} />
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <SearchBox />
            {/* From lg only: below it these are the More menu's (C7 spec §2.2). */}
            <span className="hidden items-center gap-2 lg:flex">
              <AboutLink />
              <SettingsLink />
              <SignOutButton />
            </span>
          </div>
        </header>
```

`src/app/(admin)/layout.tsx`: replace lines 27-100 (from `{/* The bottom padding …` through `</header>`) with:

```tsx
      {/* The bottom padding is the room the fixed tab bar occupies below lg. It
          lives here, once, rather than on each admin page. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {/* Below lg one 60 px row (C7 spec §2.2, §11.1, Ruling 8): the logo and
            "admin", then search. The gear and Sign out are in the bar's More
            menu there, where Admin is current. */}
        <header
          data-testid="admin-header"
          className="relative flex h-[60px] items-center gap-2.5 border-b px-4 lg:h-[72px] lg:gap-4 lg:px-7"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}
        >
          <span
            className="flex min-h-11 shrink-0 items-center gap-2.5 whitespace-nowrap text-[18px] font-bold tracking-[-0.02em]"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}
          >
            <Logo size={24} />
            {/* "webfloppy" from sm; below it the logo and "admin" say where you are. */}
            <span><span className="max-sm:sr-only">webfloppy </span><span style={{ color: 'var(--muted)' }}>admin</span></span>
          </span>
          {/* In flow from lg, centred in the space between the wordmark and the
              right-hand group, and absolutely centred on the bar only from 2xl,
              where that measures clear of the search box (Phase B final review
              F1). This bar's right group is wider than the app's (the email),
              so it waits until 2xl. Below lg the same wrapper is the fixed
              bottom tab bar (C7 spec §2.3). e2e/header-overlap.spec.ts pins it. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's. From 2xl,
            // pointer-events-none on the full-width wrapper, auto on the pill.
            //
            // 2xl:top-[19px] is (72 - 34) / 2: the 72px bar's middle.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-2 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md lg:static lg:z-auto lg:min-w-0 lg:flex-1 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none 2xl:pointer-events-none 2xl:absolute 2xl:inset-x-0 2xl:top-[19px] 2xl:bottom-auto 2xl:h-[34px]"
          >
            <div className="pointer-events-auto max-w-full overflow-x-auto max-lg:w-full">
              {/* Every page under this layout passed requireSuperAdmin(), so Admin is shown (TopNav's own rule). */}
              <TopNav showAdmin />
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 lg:gap-4">
            <SearchBox />
            {/* From xl only: a label, not a control; below lg the address is on Settings. */}
            <span
              className="hidden max-w-[180px] truncate font-mono text-[11.5px] xl:block"
              style={{ color: 'var(--muted)' }}
              data-testid="admin-email"
            >
              {email}
            </span>
            {/* From lg only: below it these are the More menu's. */}
            <span className="hidden items-center gap-4 lg:flex">
              <SettingsLink />
              <SignOutButton />
            </span>
          </div>
        </header>
```

`src/components/shell/header-start.tsx`: line 72 becomes

```tsx
      className="flex min-w-0 flex-1 items-center gap-2.5 lg:flex-none lg:gap-4 xl:flex-1 xl:max-w-[calc(50%-var(--nav-pill-w)/2-1rem)]"
```

and in the doc comment replace "Between sm and xl the pill is in flow" with "Between lg and xl the pill is in flow",
and the last paragraph's "Below sm the cap is off: the zone fills the wordmark's line and the compact control keeps
its own ml-auto to sit at the right end of it, as before." with "Below lg the cap is off and the zone is a plain row:
the wordmark, then the chip slot filling the rest (C7 spec §2.2)."

`src/components/shell/drive-chips.tsx`: replace lines 66-71 (the comment `{/* ml-auto below sm puts it …` through the
`<DropdownMenuTrigger data-testid="drives-compact" …>` line) with:

```tsx
      {/* Below lg the chip slot of the header's single row (C7 spec §2.2, §5, Ruling 3): full width, 44 px, the same
          content until C8. From lg to xl it follows the wordmark as before. */}
      <div className="min-w-0 flex-1 lg:flex-none xl:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="drives-compact" className={`${CHIP_CLASS} flex max-lg:h-11 max-lg:w-full`} style={CHIP_STYLE}>
```

and in the component's doc comment replace "On a phone that sits on the header's top line -- NOT in the fixed bottom
bar, which already scrolls with four items at 390px." with "Below lg it fills the header row's middle -- NOT in the
fixed bottom bar."

`src/components/shell/search-box.tsx` (interim, so the field fits the one row until Task 3): line 323
`<div className="mr-2 w-full sm:w-auto">` becomes `<div className="lg:mr-2">`, and in the input's className at line
348 `h-10 w-full rounded-[10px]` becomes `h-10 w-40 rounded-[10px]`.

`src/lib/help/topics.tsx:669`: `Settings (the gear at the top) lists every preference in one place, and` becomes
`Settings (the gear at the top; More, then Settings, on a phone) lists every preference in one place, and`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/nav-tabs.test.ts src/components/shell/top-nav.test.ts`
Expected: PASS. If the `aria-haspopup` assertion fails because Base UI writes the attribute in a different form, read
the rendered trigger and match what it writes; the trigger must announce a menu.

Run: `pnpm test --testTimeout=30000`, then `npx tsc --noEmit`, then `pnpm lint`
Expected: all green; lint `✖ 12 problems (0 errors, 12 warnings)`, exit 0.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-0[12]|C7-10"` → `6 passed`. If
   `hydrated(page, 'nav-more')` times out, list the trigger's React props (`Object.keys(el[__reactProps$…])` in a
   quick `page.evaluate`) and pass a handler it has as the third argument. Use the same handler at every `nav-more`
   site in this plan.
2. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "bottom bar reaches"` → `1 passed`.
3. `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → `2 passed`.
4. `PORT=3100 npx playwright test e2e/header-overlap.spec.ts --project=desktop -g "app shell"` → `2 passed`; then
   `PORT=3100 npx playwright test e2e/header-overlap.spec.ts --project=desktop -g "admin shell|below lg"` → `3 passed`.
   A desktop width that fails is reported with its width and edges; the test is not changed.
5. `PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "390px|admin plane"` → `2 passed`.
6. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "390"` → `6 passed` (the header
   test, the two loading-frame tests at 390, and the three phone tests).
7. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "390"` → `6 passed` (regression: the
   search field still shows at 390 until Task 3).

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/nav-tabs.ts src/lib/nav-tabs.test.ts src/components/shell/top-nav.tsx src/components/shell/top-nav.test.ts \
  src/components/sign-out-button.tsx "src/app/(app)/layout.tsx" "src/app/(admin)/layout.tsx" \
  src/components/shell/header-start.tsx src/components/shell/drive-chips.tsx src/components/shell/search-box.tsx \
  src/app/globals.css src/components/ui/sonner.tsx src/lib/help/topics.tsx e2e/c7-phone.mobile.spec.ts \
  e2e/mobile.spec.ts e2e/shell.spec.ts e2e/header-overlap.spec.ts e2e/drive-chips.spec.ts e2e/c6-admin-layout.spec.ts
git commit -m "C7: the phone shell below lg in both shells: one 60 px row, the four-tab bar with More, header controls from lg, toasts above the bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 2: About into Settings: the `#about` section, the list item, the redirect, the (i) and the page removed, every reference

**Files:**
- Create: `src/components/prefs/about-view.tsx`, `src/components/prefs/about-view.test.ts`,
  `src/components/prefs/about-server.tsx`
- Delete: `src/app/(app)/about/page.tsx` (and its now-empty folder), `src/components/shell/about-link.tsx`
- Modify: `src/app/(app)/settings/page.tsx` (lines 1-51), `src/app/(app)/settings/loading.tsx:3-35`,
  `src/app/(app)/settings/loading.test.ts:13-20`, `src/app/(app)/layout.tsx` (the `AboutLink` import and use),
  `next.config.ts:7-29`, `src/lib/help/topics.tsx:613-619`, `src/components/shell/side-nav.tsx:18`,
  `src/components/shell/side-nav.test.ts:11,27,28`, `README.md:263-265`, `.github/workflows/image.yml:47`,
  `e2e/about-page.spec.ts:1-42`, `e2e/c5-layout.spec.ts:74-88`, `e2e/shell.spec.ts` (the Task 1 test's 1280 half),
  `e2e/contrast.spec.ts:370`, `e2e/devices-page.spec.ts:683`, `e2e/c7-phone.mobile.spec.ts` (C7-02b, append C7-07)

**Interfaces:**
- Consumes: `SETTINGS_CARD`, `CARD_STYLE`, `SETTINGS_H2` (`@/lib/settings-look`); `HelpTip`; `Bone`; the About libs
  (`buildInfo`, `hostingMode`, `HOSTED_LABEL`, `SELF_HOSTED_LABEL`, `libraryUsage`, `firmwareSummary`, `settle`,
  `formatBytes`); `storageLabel` (`@/lib/storage`); `requireOrg()`; and from Task 1 `noSideways`, `hydrated`.
- Produces:
  - `AboutCard({ children })`, `AboutBone()`,
    `AboutGroupsView(props: { build: BuildInfo; hosted: boolean; node: string; storage: string; usage: Settled<LibraryUsage>; firmware: Settled<FirmwareFacts> })`,
    `type Settled<T> = { ok: true; value: T } | { ok: false }`,
    `type FirmwareFacts = { latest: { version: string; sequence: number } | null; boards: number; behind: number }`
    (`@/components/prefs/about-view`)
  - `AboutServer({ orgId }: { orgId: string })` (`@/components/prefs/about-server`)
  - DOM: `section#about[data-testid="settings-about"]`, `h2#about-heading` (focusable, with a ring), the six group ids
  - the redirect `/about` → `/settings#about` (307)

**Plan ruling** (spec §10.1, "an async server component rendered inside `<Suspense>`", against §10.3's "SideNav's
arrival jump … puts a full load of `/settings#about` on the section"): SideNav jumps and observes once, on mount,
and finds only the ids that exist then. A section that streamed in later would be missed by the jump, by the "in
view" mark and by the click focus. So the card, its `id`, its `h2` and its "?" render with the rest of Settings
(`AboutCard`), and only the six groups stream (`<Suspense fallback={<AboutBone />}>` inside the card). Ruling 23 still
holds: the account cards never wait for `libraryUsage` or `firmwareSummary`.

**Plan ruling** (spec §10.1, "Each group: an `h3`"): each group keeps its `about-*` test id on a `div` (today's
`section.glass-card`), with a 1 px `--hairline` top rule from the second group on, and no glass card.

**Plan ruling** (user instruction: README in the final task; spec §10.5 puts it here): this task changes README
lines 263-265 as §10.5 says, and Task 9 re-greps README and `docs/` for any wording the About move or the shell
touched.

- [ ] **Step 1: Write the failing tests**

`src/components/prefs/about-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutBone, AboutCard, AboutGroupsView } from './about-view';

const build = {
  commit: 'abc1234def', shortCommit: 'abc1234', commitUrl: 'https://github.com/stefanskotte/webadf/commit/abc1234def',
  builtAt: '2026-10-26T10:00:00.000Z', nextVersion: '16.3.2',
};
type ViewProps = Parameters<typeof AboutGroupsView>[0];
const view = (over: Partial<ViewProps> = {}) => renderToStaticMarkup(createElement(AboutGroupsView, {
  build, hosted: false, node: '22.0.0', storage: 'Local disk',
  usage: { ok: true, value: { titles: 2, disks: 3, versions: 4, bytes: 901120 } },
  firmware: { ok: true, value: { latest: { version: '1.21.1', sequence: 119 }, boards: 0, behind: 0 } },
  ...over,
}));

describe('AboutCard (C7 spec §10.1, Rulings 21, 24)', () => {
  const html = renderToStaticMarkup(createElement(AboutCard, null, 'BODY'));
  it('is section #about, labelled by its focusable heading, in the Settings card look', () => {
    expect(html).toMatch(/^<section id="about" aria-labelledby="about-heading" data-testid="settings-about" class="scroll-mt-6 rounded-\[20px\] p-5 sm:p-6"/);
    expect(html).toContain('<h2 id="about-heading" tabindex="-1"');
    expect(html).toContain('focus:outline-(--ring)');
    expect(html).toContain('>About this server</h2>');
    expect(html).toContain('data-testid="help-tip-about"');
    expect(html.indexOf('</h2>')).toBeLessThan(html.indexOf('BODY'));
  });
});

describe('AboutGroupsView', () => {
  it('keeps the six groups in order, with every id and word, as h3 groups split by hairlines, no glass cards', () => {
    const html = view();
    const ids = [...html.matchAll(/data-testid="about-(web-app|hosting|platform|firmware|library|about-webadf)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']);
    for (const w of ['Web app', 'Hosting', 'Platform', 'Board firmware', 'Your library', 'WebFloppy', 'Self-hosted',
      'Node.js 22.0.0', 'Next.js 16.3.2', 'PostgreSQL', 'Local disk', 'MIT', 'Repository', '1.21.1 (sequence 119)',
      'No boards paired', 'An Amiga floppy library that mounts disks on real Amigas over Wi-Fi.']) {
      expect(html, w).toContain(w);
    }
    expect(html).toContain('data-testid="about-commit"');
    expect(html).toContain('href="https://github.com/stefanskotte/webadf/commit/abc1234def"');
    expect(html).toContain('data-testid="about-hosting-mode"');
    expect(html).toContain('data-testid="about-library-bytes" data-bytes="901120"');
    for (const id of ['titles', 'disks', 'versions']) expect(html).toContain(`data-testid="about-library-${id}"`);
    expect(html.match(/<h3 /g)?.length).toBe(6);
    expect(html.match(/border-t pt-4/g)?.length).toBe(5);
    expect(html).not.toContain('glass-card');
  });
  it('reads Hosted when hosted', () => {
    expect(view({ hosted: true })).toContain('Hosted (webadf.vercel.app)');
  });
  it('a failed read blanks only its own group', () => {
    const html = view({ usage: { ok: false }, firmware: { ok: false } });
    expect(html.match(/>unavailable</g)?.length).toBe(2);
    expect(html).toContain('data-testid="about-web-app"');
    expect(html).not.toContain('about-library-titles');
  });
});

describe('AboutBone', () => {
  it('is an aria-hidden column of bones', () => {
    const html = renderToStaticMarkup(createElement(AboutBone));
    expect(html).toMatch(/^<div data-about-bone="" aria-hidden="true"/);
    expect(html.match(/motion-safe:animate-pulse/g)?.length).toBe(6);
  });
});
```

`src/app/(app)/settings/loading.test.ts`: the second `it` becomes

```ts
  it("is the page's grid: five nav bones from lg, a heading, five cards, the first with four rows", () => {
    expect(html).toContain('lg:grid-cols-[240px_minmax(0,860px)]');
    expect(html.match(/data-skeleton-nav/g)?.length).toBe(5);
    expect(html.match(/data-skeleton-card/g)?.length).toBe(5);
    expect(html.match(/data-skeleton-row/g)?.length).toBe(4);
    expect(html).toContain('h-[30px]');
    expect(html).toContain('sm:h-[44px]');
  });
```

`src/components/shell/side-nav.test.ts`: in the fixture (line 11) `{ href: '/about', label: 'About this server' }`
becomes `{ href: '/help', label: 'Help' }`; lines 27-28 become
`expect(html).toMatch(/<a [^>]*href="\/help"/);` and `expect(html).not.toMatch(/href="\/help"[^>]*aria-current/);`.
(The test is about route items in general.)

`e2e/about-page.spec.ts`: after line 8 (`import { signUpFresh, createAdf } from './helpers';`) add
`import { hydrated } from './device-helpers';`; replace lines 10-27 (the first test) with:

```ts
test('Settings > About this server: the list jumps to #about, focuses its heading, and shows the six groups', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/settings');
  // The nav and the radios hydrate in the same pass (c5-layout's Settings test).
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  await page.getByTestId('settings-nav').getByRole('link', { name: 'About this server' }).click();
  await expect(page).toHaveURL(/\/settings#about$/);
  await expect(page.locator('#about-heading')).toBeFocused();
  for (const id of ['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']) {
    await expect(page.getByTestId(`about-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('about-about-webadf')).toContainText('WebFloppy');
  await expect(page.getByTestId('about-commit')).toHaveText(/\S/);
  await expect(page.getByTestId('about-hosting-mode')).toHaveText(/^(Hosted \(webadf\.vercel\.app\)|Self-hosted)$/);
  await expect(page.getByTestId('about-firmware')).toContainText('No boards paired');
  await expect(page.getByTestId('about-library-disks')).toHaveText('0');
  await expect(page.getByTestId('about-library-bytes')).toHaveText('0 B');
  const text = await page.locator('body').innerText();
  for (const secret of ['postgres://', 'postgresql://', 'vercel_blob_rw_', 'BETTER_AUTH', 'DATABASE_URL']) {
    expect(text).not.toContain(secret);
  }
});

test('/about is a 307 to /settings#about: signed in it lands on the section at 1280 and 390, signed out on sign-in (Review Focus 1)', async ({ page, browser }) => {
  await signUpFresh(page);
  const res = await page.request.get('/about', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toMatch(/\/settings#about$/);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/about');
    await expect(page).toHaveURL(/\/settings#about$/);
    // Below lg the section list is hidden but mounted: its arrival jump still lands here.
    await expect(page.locator('#about-heading')).toBeInViewport();
  }
  const other = await browser.newContext();
  const anon = await other.newPage();
  await anon.goto('/about');
  await expect(anon).toHaveURL(/\/sign-in/);
  await other.close();
});
```

and in the second test (`stored bytes are a sum …`) line 35 `await page.goto('/about');` becomes:

```ts
  await page.goto('/about');
  await expect(page).toHaveURL(/\/settings#about$/);   // the redirect (C7 spec §10.3)
```

`e2e/c5-layout.spec.ts`: line 75 `await expect(about).toHaveAttribute('href', '/about');` becomes
`await expect(about).toHaveAttribute('href', '#about');`, and after line 87
(`await expect(about).not.toHaveAttribute('aria-current', 'true');`) add:

```ts
  // C7 (spec §10.2): About this server is an in-page section now; a click marks it and focuses its heading.
  await about.click();
  await expect(page).toHaveURL(/#about$/);
  await expect(page.locator('#about-heading')).toBeFocused();
  await expect(about).toHaveAttribute('aria-current', 'true');
```

`e2e/shell.spec.ts`: in the Task 1 test, `const next = (await page.getByTestId('about-link').boundingBox())!;` becomes
`const next = (await page.getByTestId('settings-link').boundingBox())!;`.

`e2e/contrast.spec.ts`: delete line 370 (`'[data-testid=about-link]',`).

`e2e/devices-page.spec.ts:683`: the test name's `(the About page says how this server is hosted)` becomes
`(About this server says how this server is hosted)`. No logic changes.

`e2e/c7-phone.mobile.spec.ts`: in C7-02b, after `await expect(page).toHaveURL(/\/settings#about$/);` add
`await expect(page.locator('#about-heading')).toBeInViewport();`, and append:

```ts
// ---- About into Settings (spec §10, Rulings 20-25) ---------------------------------------------------------

test('C7-07 Settings at 390: About this server is the fourth card with its six groups; More and /about land on it', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const order = await page.evaluate(() => [...document.querySelectorAll('section[id]')].map((s) => s.id)
    .filter((id) => ['prefs', 'account', 'firmware', 'about', 'danger'].includes(id)));
  expect(order).toEqual(['prefs', 'account', 'firmware', 'about', 'danger']);
  for (const id of ['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']) {
    await expect(page.getByTestId(`about-${id}`)).toBeAttached();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').tap();
  await page.getByTestId('more-about').tap();
  await expect(page).toHaveURL(/\/settings#about$/);
  await expect(page.locator('#about-heading')).toBeInViewport();
  await page.goto('/about');
  await expect(page).toHaveURL(/\/settings#about$/);
  await expect(page.locator('#about-heading')).toBeInViewport();
  await noSideways(page);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/components/prefs/about-view.test.ts "src/app/(app)/settings/loading.test.ts" src/components/shell/side-nav.test.ts`
Expected: FAIL. `about-view.test.ts` fails with `Cannot find module './about-view'`; the loading test fails with
`expected 4 to be 5`. `side-nav.test.ts` passes already (its fixture change is a rename), which is fine.

Run: `PORT=3100 npx playwright test e2e/about-page.spec.ts --project=desktop -g "307"` → FAIL (`/about` answers 200).

- [ ] **Step 3: Implement**

`src/components/prefs/about-view.tsx`:

```tsx
import { Link } from '@/components/shell/link';
import { HelpTip } from '@/components/help/help-tip';
import { Bone } from '@/components/shell/skeleton';
import { CARD_STYLE, SETTINGS_CARD, SETTINGS_H2 } from '@/lib/settings-look';
import { formatBytes } from '@/lib/about/format-bytes';
import { HOSTED_LABEL, SELF_HOSTED_LABEL } from '@/lib/about/hosting';
import type { BuildInfo } from '@/lib/about/build-info';
import type { LibraryUsage } from '@/lib/about/library-usage';

// Settings > About this server (C7 spec §10.1; content moved from the old /about page, every id and word kept). This
// file is markup only and reads no database, so it renders in a unit test; about-server.tsx does the reads.

export type Settled<T> = { ok: true; value: T } | { ok: false };
export type FirmwareFacts = { latest: { version: string; sequence: number } | null; boards: number; behind: number };

/**
 * The card, its id and its heading render with the rest of Settings; only the groups stream (Plan ruling, C7 Task 2).
 * SideNav jumps to and observes the ids that exist when it mounts, so #about and #about-heading must be there then.
 */
export function AboutCard({ children }: { children: React.ReactNode }) {
  return (
    <section id="about" aria-labelledby="about-heading" data-testid="settings-about" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="flex items-center gap-1.5">
        <h2 id="about-heading" tabIndex={-1} className={SETTINGS_H2} style={{ color: 'var(--ink)' }}>About this server</h2>
        <HelpTip topic="about" />
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** The groups' place while their reads run (Ruling 23): the card is already there, so only its body is a bone. */
export function AboutBone() {
  return (
    <div data-about-bone="" aria-hidden="true" className="flex flex-col gap-3">
      {Array.from({ length: 6 }, (_, i) => <Bone key={i} className={i % 2 ? 'h-3 w-1/2' : 'h-3 w-2/3'} />)}
    </div>
  );
}

function Group({ id, title, first = false, children }: { id: string; title: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div data-testid={`about-${id}`} className={first ? undefined : 'border-t pt-4'}
         style={first ? undefined : { borderColor: 'var(--hairline)' }}>
      <h3 className="mb-2 text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]" style={{ color: 'var(--ink)' }}>{children}</dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{children}</dd>
    </>
  );
}

const UNAVAILABLE = <span style={{ color: 'var(--muted)' }}>unavailable</span>;

/** The six groups (spec 2026-10-15-about-page): build, hosting, platform, firmware, this org's library, WebFloppy. */
export function AboutGroupsView({ build, hosted, node, storage, usage, firmware }: {
  build: BuildInfo; hosted: boolean; node: string; storage: string;
  usage: Settled<LibraryUsage>; firmware: Settled<FirmwareFacts>;
}) {
  return (
    <>
      <Group id="web-app" title="Web app" first>
        <Row label="Commit">
          <span data-testid="about-commit">
            {build.commitUrl ? <a href={build.commitUrl} className="underline">{build.shortCommit}</a> : build.shortCommit}
          </span>
        </Row>
        <Row label="Built">
          {build.builtAt
            ? <time dateTime={build.builtAt}>{new Date(build.builtAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</time>
            : 'unknown'}
        </Row>
      </Group>

      <Group id="hosting" title="Hosting">
        <Row label="This server"><span data-testid="about-hosting-mode">{hosted ? HOSTED_LABEL : SELF_HOSTED_LABEL}</span></Row>
      </Group>

      <Group id="platform" title="Platform">
        {/* Template strings: React writes <!-- --> between two adjacent text nodes. */}
        <Row label="Runtime">{`Node.js ${node}`}</Row>
        <Row label="Framework">{`Next.js ${build.nextVersion}`}</Row>
        <Row label="Database">PostgreSQL</Row>
        <Row label="File storage">{storage}</Row>
      </Group>

      <Group id="firmware" title="Board firmware">
        {firmware.ok ? (
          <>
            <Row label="Newest">
              {firmware.value.latest ? `${firmware.value.latest.version} (sequence ${firmware.value.latest.sequence})` : 'none published'}
            </Row>
            <Row label="Your boards">
              {firmware.value.boards === 0 ? 'No boards paired' : `${firmware.value.behind} of ${firmware.value.boards} behind`}
            </Row>
          </>
        ) : <Row label="Firmware">{UNAVAILABLE}</Row>}
      </Group>

      <Group id="library" title="Your library">
        {usage.ok ? (
          <>
            <Row label="Titles"><span data-testid="about-library-titles">{usage.value.titles}</span></Row>
            <Row label="Disks"><span data-testid="about-library-disks">{usage.value.disks}</span></Row>
            <Row label="History versions"><span data-testid="about-library-versions">{usage.value.versions}</span></Row>
            <Row label="Stored">
              <span data-testid="about-library-bytes" data-bytes={usage.value.bytes}
                    title={`${usage.value.bytes.toLocaleString('en-GB')} bytes`}>
                {formatBytes(usage.value.bytes)}
              </span>
            </Row>
          </>
        ) : <Row label="Library">{UNAVAILABLE}</Row>}
      </Group>

      <Group id="about-webadf" title="WebFloppy">
        <Row label="What">An Amiga floppy library that mounts disks on real Amigas over Wi-Fi.</Row>
        <Row label="Licence">MIT</Row>
        <Row label="More">
          <Link href="/help" className="underline">Help</Link> · <a href="https://github.com/stefanskotte/webadf" className="underline">Repository</a>
        </Row>
      </Group>
    </>
  );
}
```

`src/components/prefs/about-server.tsx`:

```tsx
import { Suspense } from 'react';
import { buildInfo } from '@/lib/about/build-info';
import { hostingMode } from '@/lib/about/hosting';
import { libraryUsage } from '@/lib/about/library-usage';
import { firmwareSummary } from '@/lib/about/firmware-summary';
import { settle } from '@/lib/about/settle';
import { storageLabel } from '@/lib/storage';
import { AboutBone, AboutCard, AboutGroupsView } from './about-view';

/** The groups' reads, moved from the old /about page: each settles on its own, so one failing read blanks only its group. */
async function AboutGroups({ orgId }: { orgId: string }) {
  const [usage, firmware] = await Promise.all([settle(libraryUsage(orgId)), settle(firmwareSummary(orgId))]);
  return (
    <AboutGroupsView build={buildInfo()} hosted={hostingMode() === 'hosted'} node={process.versions.node}
                     storage={storageLabel()} usage={usage} firmware={firmware} />
  );
}

/**
 * Settings > About this server (C7 spec §10, Rulings 21-24): the card renders with Settings, and its groups stream in
 * their own Suspense, so the account cards never wait for libraryUsage's blob sum.
 */
export function AboutServer({ orgId }: { orgId: string }) {
  return (
    <AboutCard>
      <Suspense fallback={<AboutBone />}>
        <AboutGroups orgId={orgId} />
      </Suspense>
    </AboutCard>
  );
}
```

`src/app/(app)/settings/page.tsx`: add `import { AboutServer } from '@/components/prefs/about-server';` after the
`DeleteAccount` import; the comment on line 14 becomes
`// The board's section list (C5 spec §2.1, Ruling 2; C7 §10.2): in-page anchors, About this server among them.`;
line 21 becomes `{ href: '#about', label: 'About this server', focusId: 'about-heading' },`; the page's doc comment
becomes `… Preferences, Sign-in & password, Firmware updates, About this server, Delete account (C7 spec §10.2). …`;
`const { userId, email } = await requireOrg();` becomes `const { userId, email, orgId } = await requireOrg();`; and
between `<FirmwarePasswordSetting … />` and `<DeleteAccount />` add `<AboutServer orgId={orgId} />`.

`src/app/(app)/settings/loading.tsx`: the comment's `four cards` becomes `five cards (C7: About this server before
the danger card)`, and `{[0, 1, 2, 3].map((c) => (` becomes `{[0, 1, 2, 3, 4].map((c) => (`.

`src/app/(app)/layout.tsx`: delete the line `import { AboutLink } from "@/components/shell/about-link";` and the
`<AboutLink />` line inside the `lg:flex` span; that span's comment becomes
`{/* From lg only: below it these are the More menu's (C7 spec §2.2). The (i) is gone at every width (Ruling 20). */}`.

Delete `src/app/(app)/about/page.tsx` (`git rm "src/app/(app)/about/page.tsx"`) and
`src/components/shell/about-link.tsx` (`git rm src/components/shell/about-link.tsx`).

`next.config.ts`: the comment at line 7 `// The About page's build facts, fixed now so the running server reports its`
becomes `// About this server's build facts (Settings), fixed now so the running server reports its`; and in
`nextConfig`, after the `env: { … },` block, add:

```ts
  // /about became Settings' About this server section (C7 spec §10.3, Ruling 22). A config redirect runs before the
  // filesystem and before Proxy, so a bookmark, the Help topic's link and a signed-out visit all work (the signed-out
  // one then goes on to /sign-in, like any Settings visit). 307, not 308: browsers cache a 308 for good.
  async redirects() {
    return [{ source: '/about', destination: '/settings#about', permanent: false }];
  },
```

`src/lib/help/topics.tsx`: line 613 becomes
`// Sources: spec 2026-10-15-about-page-design.md; src/lib/about/*; src/components/prefs/about-server.tsx (C7 spec 2026-10-26 §10).`,
and the `about` body gains, as its first paragraph:

```tsx
        <p>
          You find it at the end of Settings, above Delete account.
        </p>
```

`src/components/shell/side-nav.tsx:18`: `A route item (\`/about\`) is never current.` becomes
`A route item (a route such as /help) is never current.`

`README.md:263-265` becomes:

```
A self-hosted copy needs no extra setting: Settings → About this server reads
**Self-hosted** unless `SELFHOSTED=false`, which only our own deployment sets. A Docker build
without `.git` can pass `GIT_SHA` so About this server shows the commit.
```

`.github/workflows/image.yml:47`: `(the About page links it)` becomes `(Settings' About section links it)`.

Then grep the whole repo for what this task removed (expect only historic `docs/superpowers/` and HANDOFF hits):
`grep -rn "about-link\|AboutLink\|'/about'\|\"/about\"\|About page" --include=*.ts --include=*.tsx --include=*.md --include=*.yml --include=*.css . | grep -v node_modules | grep -v "\.next/" | grep -v "docs/superpowers/" | grep -v HANDOFF.md`
Expected hits: `next.config.ts` (the redirect), the `About page spec` comments in `src/lib/about/*.ts` and
`src/lib/storage/*.ts` (they name the historic spec, leave them), and `e2e/about-page.spec.ts` (`/about` in the
redirect tests). Anything else is a reference the spec missed: fix it the same way and report it.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/components/prefs/about-view.test.ts "src/app/(app)/settings/loading.test.ts" src/components/shell/side-nav.test.ts`
Expected: PASS.

Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint` → green; lint `✖ 12 problems (0 errors, 12
warnings)`. If `npx tsc` reports the typed route `/about` missing somewhere, re-run `npx next typegen` first.

Check the redirect by hand on the dev server (3100): `curl -sI http://localhost:3100/about | grep -i -E "^(HTTP|location)"`
→ `HTTP/1.1 307` and `location: /settings#about`. If the `location` comes back without `#about`, use spec Ruling
22's fallback: remove the `redirects()` entry and keep `src/app/(app)/about/page.tsx` as
`import { redirect } from 'next/navigation'; export default function About() { redirect('/settings#about'); }`,
then re-run this step and report it.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/about-page.spec.ts --project=desktop` → `4 passed`.
2. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Settings: the section list"` → `1 passed`.
3. `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → `2 passed`.
4. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "header focus|Settings pairs"` → `2 passed`.
5. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-02b|C7-07"` → `2 passed`.
6. `PORT=3100 npx playwright test e2e/user-settings.spec.ts --project=desktop --list`, then run it whole if `--list`
   shows 15 tests or fewer, or in two `-g` halves → all pass (regression: the Settings page grew a card).
7. `PORT=3100 npx playwright test e2e/devices-page.spec.ts --project=desktop -g "custom server"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/prefs/about-view.tsx src/components/prefs/about-view.test.ts src/components/prefs/about-server.tsx \
  "src/app/(app)/settings/page.tsx" "src/app/(app)/settings/loading.tsx" "src/app/(app)/settings/loading.test.ts" \
  "src/app/(app)/layout.tsx" next.config.ts src/lib/help/topics.tsx src/components/shell/side-nav.tsx \
  src/components/shell/side-nav.test.ts README.md .github/workflows/image.yml e2e/about-page.spec.ts \
  e2e/c5-layout.spec.ts e2e/shell.spec.ts e2e/contrast.spec.ts e2e/devices-page.spec.ts e2e/c7-phone.mobile.spec.ts
git commit -m "C7: About moves into Settings as #about (card first, groups streamed), /about a 307, the (i) and the old page removed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

(The two `git rm` deletions are already staged by `git rm`.)

---

### Task 3: Search below `sm`: the 44 px opener, the swapped row with Cancel, the transparent phone scrim

**Files:**
- Modify: `src/components/shell/search-box.tsx` (imports, the shortcuts effect at 195-214, `select` at 271-279, the
  Escape branch at 309-312, and the returned markup at 319-431), `e2e/c5-layout.spec.ts:544-560` and `:667-…`,
  `e2e/c7-phone.mobile.spec.ts` (imports; append C7-03, C7-03b)

**Interfaces:**
- Consumes: Task 1's 60 px header (`relative`, so the row and the panel anchor to it); `noSideways`, `hydrated`.
- Produces: `button[data-testid="search-open"]` (`aria-label="Search"`, `aria-expanded`, `aria-controls="search-row"`),
  `div#search-row`, `button[data-testid="search-cancel"]`; `search-input` 44 px tall below `sm`.

**Plan ruling** (spec §2.4, "Escape … behave[s] as today"): below `sm`, Escape does what Cancel does (clears, closes
the row, focuses `search-open`), because a hidden field cannot hold focus and today's blur would drop it to `<body>`.
Choosing a result below `sm` also closes the row and focuses `search-open`. From `sm`, both are exactly today's.

**Plan ruling** (spec §2.4, "`search-open` swaps the header row's content"): the row is drawn by SearchBox itself, as
an absolutely positioned layer over the header (`max-sm:absolute max-sm:inset-0`, on `--surface`), so the server
layouts need no client state. The opener's tap opens the row and focuses the field inside `flushSync`, in the same
gesture, because iOS raises the keyboard only for a focus made inside the tap.

- [ ] **Step 1: Write the failing tests**

`e2e/c7-phone.mobile.spec.ts`: add `import { randomBytes } from 'node:crypto';` at the top, change the helpers import
to `import { signUpFresh, runTag } from './helpers';` and the device-helpers import to
`import { cleanupSeeded, hydrated, pairDevice, seedDisk } from './device-helpers';`, and append:

```ts
// ---- Search below sm (spec §2.4, Rulings 6, 7) -------------------------------------------------------------

test('C7-03 search at 390: the button opens the field focused, the panel sits under the row, a tap outside closes it, Cancel returns focus', async ({ page }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  await seedDisk(u.orgId, { title: `Phone Search ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await page.goto('/library');
  const open = page.getByTestId('search-open');
  const input = page.getByTestId('search-input');
  const ob = (await open.boundingBox())!;
  expect(ob.width).toBeGreaterThanOrEqual(44);
  expect(ob.height).toBeGreaterThanOrEqual(44);
  await expect(input).toBeHidden();
  await hydrated(page, 'search-open');
  await open.tap();
  await expect(input).toBeFocused();
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('search-cancel')).toBeVisible();
  await input.fill(`Phone Search ${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  const header = (await page.getByTestId('app-header').boundingBox())!;
  const p = (await panel.boundingBox())!;
  expect(p.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(p.x).toBeGreaterThanOrEqual(0);
  expect(p.x + p.width).toBeLessThanOrEqual(390);
  // The phone scrim is there and colourless (C5 deferred: iOS tap-away); a tap on it closes the panel.
  await expect(page.getByTestId('search-scrim')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.touchscreen.tap(195, 700);
  await expect(panel).toBeHidden();
  // Cancel clears, closes the row, and hands focus back to the button.
  await input.tap();
  await page.getByTestId('search-cancel').tap();
  await expect(input).toBeHidden();
  await expect(open).toBeVisible();
  await expect(open).toBeFocused();
  await open.tap();
  await expect(input).toHaveValue('');
  await noSideways(page);
});

test('C7-03b search at 390: a tapped result navigates once, the row closes, focus is not on the body (Review Focus 2)', async ({ page }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  const { gameId } = await seedDisk(u.orgId, { title: `Phone Result ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await page.goto('/library');
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').tap();
  await page.getByTestId('search-input').fill(`Phone Result ${run}`);
  const result = page.locator(`[data-testid="search-result"][data-result-id="${gameId}"]`);
  await expect(result).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await result.tap();
  await expect(page).toHaveURL(new RegExp(`/games/${gameId}`));
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await expect(page.getByTestId('search-input')).toBeHidden();
  await expect(page.getByTestId('search-open')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});
```

`e2e/c5-layout.spec.ts`, the test `Search: at 390 px the panel stays on screen and below the box` (line 544): after
`await hydrated(page, 'search-input', 'onChange');` add

```ts
  // C7 (spec §2.4): below sm the field opens from the 44 px button.
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').click();
  await expect(page.getByTestId('search-input')).toBeFocused();
```

and its last line `await expect(page.getByTestId('search-scrim')).toBeHidden();` becomes
`await expect(page.getByTestId('search-scrim')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');   // there, colourless (C7 Ruling 7)`.

The test at line 667 is renamed
`'at 390 px: Settings stacks with no list, Help folds its topics, Search has a colourless scrim and no keys, sign-in has no hero'`;
before its `await page.getByTestId('search-input').fill(`Phone Find ${run}`);` add

```ts
  await hydrated(page, 'search-open');
  await page.getByTestId('search-open').click();
```

and its `await expect(page.getByTestId('search-scrim')).toBeHidden();` becomes
`await expect(page.getByTestId('search-scrim')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');`.

- [ ] **Step 2: Run them to see them fail**

Run: `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-03"`
Expected: FAIL (`2` tests): `getByTestId('search-open')` resolves to no element.

- [ ] **Step 3: Implement** — in `src/components/shell/search-box.tsx`:

Imports: add `import { flushSync } from 'react-dom';` after the React import.

After `const inputRef = useRef<HTMLInputElement>(null);` add:

```tsx
  const openerRef = useRef<HTMLButtonElement>(null);
  // Below sm the field lives behind the search-open button and opens as a row over the header (C7 spec §2.4, Ruling 6);
  // from sm it always shows, as before. The max-sm: classes below read this state, so it is inert from sm.
  const [phoneOpen, setPhoneOpen] = useState(false);
```

After the `reset()` function add:

```tsx
  /** Below sm (the opener's width): read when a key or a choice decides where focus goes. */
  const isPhone = () => window.matchMedia('(max-width: 639.98px)').matches;

  // flushSync: the field must be displayed before focus() runs, inside the tap's own gesture -- iOS raises the
  // keyboard only for a focus made there.
  function openPhone() {
    flushSync(() => setPhoneOpen(true));
    inputRef.current?.focus();
  }

  /** Close the phone row and hand focus to the opener: the field just went, and focus must not fall to <body>. */
  function closePhone() {
    flushSync(() => setPhoneOpen(false));
    openerRef.current?.focus();
  }
```

The shortcuts effect (lines 195-214) becomes:

```tsx
  // Global shortcuts: Cmd/Ctrl+K always focuses; `/` focuses UNLESS focus is
  // already inside another input, textarea or contenteditable -- otherwise
  // this steals the key from the collection rename field and the
  // create-collection input on /library. Below sm either one opens the row first.
  useEffect(() => {
    function focusField() {
      if (window.matchMedia('(max-width: 639.98px)').matches) flushSync(() => setPhoneOpen(true));
      inputRef.current?.focus();
    }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusField();
        return;
      }
      if (e.key === '/') {
        const active = document.activeElement;
        const tag = active?.tagName;
        const isEditable =
          tag === 'INPUT' || tag === 'TEXTAREA' || (active as HTMLElement | null)?.isContentEditable;
        if (isEditable) return;
        e.preventDefault();
        focusField();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
```

`select` (lines 271-279) becomes:

```tsx
  function select(entry: Entry) {
    // The page's loading placeholders (loading.tsx) confirm the press landed.
    router.push(hrefOf(entry));
    // SearchBox lives in the layout, so navigating does not unmount it -- without reset() here the request for
    // whatever was typed keeps running and can repopulate the panel with the PREVIOUS search's rows the next time it
    // opens.
    reset();
    // Below sm the row closes and focus goes to the opener (Plan ruling, C7 Task 3); from sm, as before.
    if (phoneOpen && isPhone()) closePhone();
    else inputRef.current?.blur();
  }
```

The Escape branch (lines 309-312) becomes:

```tsx
    if (e.key === 'Escape') {
      reset();
      if (phoneOpen && isPhone()) closePhone();
      else inputRef.current?.blur();
    }
```

The returned markup (lines 319-431) becomes:

```tsx
  return (
    // Static, so the panel anchors to the header (both shells' headers are `relative`); see the plan ruling in C5
    // Task 5. lg:mr-2 keeps the field 16 px clear of the gear group (they sit 8 px apart).
    <div className="lg:mr-2">
      {/* Below sm: a 44 px button that opens the row (C7 spec §2.4). Hidden while the row is open and from sm. */}
      <button ref={openerRef} type="button" data-testid="search-open" aria-label="Search" aria-expanded={phoneOpen}
              aria-controls="search-row" onClick={openPhone}
              className={`${phoneOpen ? 'hidden' : 'flex'} size-11 items-center justify-center rounded-[10px] text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) sm:hidden`}>
        <SearchIcon aria-hidden className="size-5" />
      </button>
      {/* Below sm, while open, the row covers the header's 60 px row: the field, then Cancel. From sm it is a plain
          block holding the field, as before. */}
      <div id="search-row"
           className={phoneOpen
             ? 'max-sm:absolute max-sm:inset-0 max-sm:z-50 max-sm:flex max-sm:items-center max-sm:gap-2.5 max-sm:bg-(--surface) max-sm:px-4'
             : 'max-sm:hidden'}>
        <div className="relative max-sm:min-w-0 max-sm:flex-1">
          <SearchIcon aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
                      style={{ color: 'var(--muted-2)' }} />
          <input
            ref={inputRef}
            data-testid="search-input"
            // LiveRefresh's typing() guard skips this box (src/components/shell/live-refresh.tsx): it lives in the
            // layout, and focus lingering here must not hold back live updates the way a rename field should.
            data-live-ok
            role="combobox"
            aria-expanded={listboxShown}
            aria-controls={listboxShown ? 'search-listbox' : undefined}
            aria-autocomplete="list"
            aria-activedescendant={listboxShown ? `search-opt-${active}` : undefined}
            aria-label="Search titles"
            title="Search titles — press / to focus"
            placeholder="Search titles"
            value={q}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => { setFocused(true); if (q.trim() !== '') setOpen(true); }}
            onBlur={() => { setFocused(false); setOpen(false); }}
            // w-48 (not w-56) from sm: at w-56 the admin shell's centred pill and this input overlapped by 15px at
            // 1280. 44 px tall below sm (a finger). The focus ring is a box-shadow in the full --ring (>= 3:1, WCAG
            // 1.4.11).
            className="h-11 w-full rounded-[10px] border pl-9 pr-4 text-[14px] outline-none transition-colors placeholder:text-(--muted-2) focus-visible:ring-2 focus-visible:ring-(--ring) sm:h-10 sm:w-48 sm:pr-9"
            style={{ background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--ink)' }}
          />
          {/* The "/" shortcut, advertised while the box is idle (aria-hidden: the title attribute says it). Hidden
              below sm: a phone has no key to press. */}
          {!focused && q === '' && (
            <kbd aria-hidden data-testid="search-hint"
                 className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border px-1.5 font-mono text-[11px] leading-[15px] sm:block"
                 style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
              /
            </kbd>
          )}
        </div>
        {/* Today's Escape, for a thumb: clears, closes the row, focus back on the opener. */}
        <button type="button" data-testid="search-cancel" onClick={() => { reset(); closePhone(); }}
                className="h-11 shrink-0 rounded-[10px] px-3 text-[14px] font-semibold text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) sm:hidden">
          Cancel
        </button>
      </div>

      {panelOpen && (
        // From sm a light scrim (C5 spec §5.3); below sm the same scrim, colourless, so a tap outside the panel
        // closes it (C7 Ruling 7: iOS's tap-away did not blur). Not a focus trap: this is a combobox popup.
        <div data-testid="search-scrim" aria-hidden onPointerDown={() => setOpen(false)}
             className="fixed inset-x-0 bottom-0 top-[60px] z-40 bg-transparent sm:bg-(--search-scrim) lg:top-[72px]" />
      )}

      {panelOpen && (
        <div
          data-testid="search-panel"
          // No press inside the panel may blur the input (Ruling 22): the row would vanish under the pointer.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-4 right-4 top-[calc(100%+4px)] z-50 flex flex-col overflow-hidden rounded-[16px] border sm:left-auto sm:w-[min(600px,calc(100vw-32px))] lg:right-7 lg:top-[64px] lg:w-[min(600px,calc(100vw-56px))]"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)', boxShadow: 'var(--shadow-card)' }}
        >
```

Everything inside the panel (the error / empty / listbox branches and `search-keys`) stays as it is, except the
result `Link`'s `onClick={() => { reset(); inputRef.current?.blur(); }}`, which becomes
`onClick={() => { reset(); if (phoneOpen && isPhone()) closePhone(); else inputRef.current?.blur(); }}`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint` → green; lint `✖ 12 problems (0 errors, 12 warnings)`.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-03"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Search"` → all pass (`--list` first).
3. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "at 390 px: Settings stacks"` → `1 passed`.
4. `PORT=3100 npx playwright test e2e/search.spec.ts --project=desktop` → `13 passed` (1280 regression).
5. `PORT=3100 npx playwright test e2e/shell.spec.ts e2e/drive-chips.spec.ts --project=desktop -g "header is one|390px"` → `2 passed`.
6. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "search panel|Search panel|header focus"` → `3 passed`.
7. `PORT=3100 npx playwright test e2e/identify-search.spec.ts --project=desktop -g "390"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/shell/search-box.tsx e2e/c5-layout.spec.ts e2e/c7-phone.mobile.spec.ts
git commit -m "C7: search below sm opens from a 44 px button into a row with Cancel; the phone scrim closes the panel on a tap outside

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 4: Shared sizes: `.seg` 44 px and wrapping, the named 44 px controls, the "?" hit area, the Disk files bone, the Help hash jump, the first touch sweep

**Files:**
- Modify: `src/app/globals.css` (end of the `.seg` `@layer components` block), `src/components/help/help-tip.tsx:21`,
  `src/components/help/help-browser.tsx` (imports, after line 34, lines 53 and 67),
  `src/app/(app)/disks/[id]/files/loading.tsx:14-18`, `src/app/(app)/disks/[id]/files/loading.test.ts`, the control
  table below, `e2e/c7-phone.mobile.spec.ts` (imports; append the sweep helpers, C7-09a, C7-11)

**Interfaces:**
- Consumes: nothing new.
- Produces: e2e helpers `smallTargets(page): Promise<string[]>` and `touchSweep(page, label): Promise<void>` in
  `e2e/c7-phone.mobile.spec.ts`. Tasks 5–8 call `touchSweep` for their pages.

**Plan ruling** (spec §14.9 against Rulings 13 and 29): the sweep measures every `button`, `a.btn-like`,
`[role="radio"]`, `[role="tab"]`, `select` and `summary`, and the `auth-switch` links, outside a `p`, outside the "?"
and outside `aria-hidden`. Each area's page joins the sweep in the task that fixes that area (this task: a title, its
disk files, Settings, Help, sign-in, sign-up). A failure the spec did not name is fixed in its own component with
`max-sm:min-h-11` (and `max-sm:min-w-11` if it is icon-only), and the report lists it. The 44 is never lowered and a
selector is never narrowed to make a control pass. A control whose `::before` hit area is absolutely positioned
counts that area, so the firmware switch's 44 px hit row passes as the spec wants.

- [ ] **Step 1: Write the failing tests**

`src/app/(app)/disks/[id]/files/loading.test.ts` — append inside the `describe`:

```ts
  it('below lg the disk bone is the stacked Disk card: a 56 px disk beside a 26 px heading, then the space bar (C7 spec §8)', () => {
    const disk = html.slice(html.indexOf('data-skeleton-disk'), html.indexOf('grid-cols-[minmax(0,1fr)]'));
    expect(disk).toContain('h-14 w-14 shrink-0 sm:h-[76px] sm:w-[76px]');
    expect(disk).toContain('h-[27px] w-1/2 sm:h-[36px]');
    expect(disk.indexOf('h-14 w-14')).toBeLessThan(disk.indexOf('h-2 w-full'));
  });
```

`e2e/c7-phone.mobile.spec.ts`: the helpers import becomes `import { signUpFresh, runTag, createAdf } from './helpers';`,
and append:

```ts
// ---- Touch targets (spec §3, §14.9, Rulings 12-14, 29) ------------------------------------------------------

/** Every control a finger presses -- outside prose, the "?" and aria-hidden -- whose hit area is under 44 px tall. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = 'button, a.btn-like, [role="radio"], [role="tab"], select, summary, [data-testid="auth-switch"] a';
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.matches('[data-testid^="help-tip-"]') || el.closest('p, [aria-hidden="true"], [data-sonner-toaster]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === 'hidden') continue;   // not shown
      // A ::before hit area (the "?", the firmware switch) counts: its negative insets grow the target.
      const b = getComputedStyle(el, '::before');
      const grow = b.position === 'absolute'
        ? Math.max(0, -(parseFloat(b.top) || 0)) + Math.max(0, -(parseFloat(b.bottom) || 0)) : 0;
      const h = r.height + grow;
      if (h < 43.5) {
        const name = el.dataset.testid ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 32);
        out.push(`${name} (${Math.round(h)} px)`);
      }
    }
    return out;
  });
}

/** spec §14.9 on the page as it stands: no small control at 390, no sideways scroll at 360, 390 or 414. Soft, so one
 *  run lists every failure; ends at 390. */
async function touchSweep(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect.soft(await smallTargets(page), `${label}: controls under 44 px`).toEqual([]);
  for (const width of [360, 390, 414]) {
    await page.setViewportSize({ width, height: 844 });
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `${label} scrolls sideways at ${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

test('C7-09a touch targets and no sideways scroll: a title, its disk files, Settings, Help, sign-in, sign-up', async ({ page }) => {
  test.setTimeout(150_000);
  await signUpFresh(page);
  await createAdf(page, 'FFS');
  const title = await page.locator('a[href^="/games/"]').first().getAttribute('href');
  await page.goto(title!);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await touchSweep(page, 'title page');
  const files = await page.locator('[data-testid^="browse-"]').first().getAttribute('href');
  await page.goto(files!);
  await expect(page.getByTestId('disk-card')).toBeVisible();
  await touchSweep(page, 'disk files');
  for (const path of ['/settings', '/help']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await touchSweep(page, path);
  }
  await page.context().clearCookies();
  for (const path of ['/sign-in', '/sign-up']) {
    await page.goto(path);
    await expect(page.getByTestId('auth-switch')).toBeVisible();
    await touchSweep(page, path);
  }
});

test('C7-11 Help at 390: a /help#topic load leaves the topic at the top after the Topics list closes', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/help#second-drive');
  await expect(page.getByTestId('help-nav-toggle')).toHaveText('Topics · 17');
  await expect(page.locator('details:has([data-testid="help-nav-toggle"])')).not.toHaveAttribute('open');
  await expect.poll(async () => Math.round((await page.locator('#second-drive').boundingBox())!.y)).toBeLessThan(200);
  await expect(page.locator('#second-drive')).toBeInViewport();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 "src/app/(app)/disks/[id]/files/loading.test.ts"` → FAIL
(`expected '…' to contain 'h-14 w-14 shrink-0 sm:h-[76px] sm:w-[76px]'`).

Run: `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-09a|C7-11"` → FAIL. C7-09a
lists the §1 P13–P16 controls (Settings radios 32 px, `Change password…` 36 px, `Download` 38 px, `help-nav-toggle`
40 px and so on). C7-11's topic lands below `y` 200 once the list closes. Save the C7-09a list: it is this task's
checklist.

- [ ] **Step 3: Implement**

`src/app/globals.css` — at the end of the `.seg` `@layer components` block (after Task 1's `.nav-tabs` media block):

```css
  /* Below sm every segmented item is a finger's height, and a track that runs out of room wraps (C7 spec §3.1,
     Ruling 12): the auth switch, Settings' radios, the DF1 / Disk-at-startup / display radios, the staging filter,
     the view toggle, admin-sections, the firmware filter. After the rules above, so it wins at the same specificity;
     .nav-tabs (the tab bar) sets its own 52 px. */
  @media (width < 40rem) {
    .seg, .seg--sm { flex-wrap: wrap; }
    .seg-item, :where(.seg--sm) .seg-item { min-height: 44px; height: auto; }
  }
```

`src/components/help/help-tip.tsx:21`: at the start of the trigger's className, `inline-flex size-6` becomes
`relative inline-flex size-6`, and before `${className ?? ''}` add
`max-sm:before:absolute max-sm:before:-inset-2 max-sm:before:content-[''] `. The doc comment's
`24 px for WCAG 2.2's target size.` becomes `24 px for WCAG 2.2's target size; below sm a 40 x 40 hit area around it
(C7 Ruling 14).`

`src/components/help/help-browser.tsx`: `import { useState, useSyncExternalStore } from 'react';` becomes
`import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';`; after `const navOpen = navPick ?? !hydrated;`
(line 34) add:

```tsx
  // C7 (spec §9.2, Ruling 26): on a phone the Topics list closes right after hydration, and the articles move up under
  // a reader who loaded /help#topic. Put the topic back at the top in the same frame, once.
  const jumped = useRef(false);
  useLayoutEffect(() => {
    if (jumped.current || !hydrated || lg || navPick !== null) return;
    jumped.current = true;
    const id = window.location.hash.slice(1);
    if (id && id in HELP_TOPICS) document.getElementById(id)?.scrollIntoView();
  }, [hydrated, lg, navPick]);
```

and add `max-sm:min-h-11` to the filter label at line 53 (`flex h-[38px] items-center …` → `flex h-[38px] items-center … max-sm:min-h-11`) and to the summary at line 67 (`flex h-10 cursor-pointer …` → `flex h-10 cursor-pointer … max-sm:min-h-11`).

`src/app/(app)/disks/[id]/files/loading.tsx`: replace lines 14-18 (the `data-skeleton-disk` block) with:

```tsx
        {/* The Disk card's shape (disk-card.tsx): below lg it stacks -- a 56 px disk beside the 26 px heading, then the
            space bar -- so a phone does not jump ~90 px when the page lands (C7 spec §8, Ruling 27). */}
        <div data-skeleton-disk className="flex flex-col gap-4 rounded-[20px] p-4 sm:px-6 sm:py-5 lg:flex-row lg:items-center lg:gap-6" style={card}>
          <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
            <Bone className="h-14 w-14 shrink-0 sm:h-[76px] sm:w-[76px]" />
            <div className="flex flex-1 flex-col gap-2"><Bone className="h-[27px] w-1/2 sm:h-[36px]" /><Bone className="h-3 w-2/3" /></div>
          </div>
          <Bone className="h-2 w-full lg:w-[300px]" />
        </div>
```

The named controls (spec §3.2, P14–P16; Ruling 13) — in each file, append the classes to the element's existing
className string (a `const` where the table names one):

| File | Element | Append |
|---|---|---|
| `src/components/games/disk-row.tsx:69` | `GHOST` (Download, Browse) | ` max-sm:min-h-11` |
| `src/components/games/write-protect-toggle.tsx:29` | the Protected / Writable button | `max-sm:min-h-11` |
| `src/components/games/mount-action.tsx:18` | `BTN` (Mount, Eject, each drive) | ` max-sm:min-h-11` |
| `src/components/games/mount-action.tsx:123` | the `btn-like` button | `max-sm:min-h-11` |
| `src/components/library/delete-disk-dialog.tsx:74` | the delete trigger (`size-[38px]`) | `max-sm:size-11` |
| `src/components/nfc/fob-button.tsx:77` | the disk fob trigger (`size-[38px]`) | `max-sm:size-11` |
| `src/components/disks/disk-card.tsx:111` | `download-<diskId>` (`h-[38px] w-[38px]`) | `max-sm:size-11` |
| `src/components/disks/file-actions.tsx:348,350,352` | `field`, `ink`, `outline` | ` max-sm:min-h-11` each |
| `src/components/disks/file-tree.tsx:560` | the `fs-filter` label (`h-9`) | `max-sm:min-h-11` |
| `src/components/disks/file-tree.tsx:577` | `fs-hide-info` (`h-9`) | `max-sm:min-h-11` |
| `src/lib/settings-look.ts:41,45` | `OUTLINE_BTN`, `INK_BTN` (Change password…, Cancel, Save) | ` max-sm:min-h-11` each |
| `src/components/prefs/delete-account.tsx` | `account-delete-open` (`h-[38px]`) | `max-sm:min-h-11` |
| `src/components/prefs/firmware-password-setting.tsx:124` | `fw-skip-password` (the switch) | `relative max-sm:before:absolute max-sm:before:inset-x-0 max-sm:before:-inset-y-[9px] max-sm:before:content-['']` |
| `src/components/ui/modal.tsx:69` | the `Dialog.Close` (`size-9`) | `max-sm:size-11` |
| `src/components/ui/modal.tsx:77` | the footer `div` (Close, Cancel, Save to board, Delete device…) | `max-sm:[&_a]:min-h-11 max-sm:[&_button]:min-h-11` |
| `src/components/admin/delete-user-dialog.tsx:94` | `delete-user-<email>` (`h-[34px]`) | `max-sm:min-h-11` |
| `src/components/admin/promote-release-button.tsx:110` | `fw-promote-<id>` (`h-8`) | `max-sm:min-h-11` |
| `src/components/admin/pager-link.tsx:3` | `BOX` (Newer, Older) | ` max-sm:min-h-11` |
| `src/components/ingest/staging-list.tsx:244` | `staging-clear-finished` (`h-[34px]`) | `max-sm:min-h-11` |
| `src/components/games/cover-control.tsx:69` | `buttonClass` (Change image…, Revert) | ` max-sm:min-h-11` |
| `src/components/library/library-pager.tsx:90` | `pager-size` (`h-[34px]`) | `max-sm:min-h-11` |
| `src/components/prefs/sort-select.tsx:64` | the `toolbar` branch (`library-sort`, `browse-sort`) | ` max-sm:min-h-11` |
| `src/components/library/create-adf.tsx:92` | the `create-adf` trigger (`h-10`) | ` max-sm:min-h-11` |

(The view toggle already reaches 44 × 44 below `sm`: `w-11` plus the `.seg-item` rule's 44 px minimum. Its
`view-toggle.test.ts` stays unchanged.)

Then re-run C7-09a and fix whatever it still lists, as the Plan ruling above says.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 "src/app/(app)/disks/[id]/files/loading.test.ts" src/components/library/view-toggle.test.ts`
→ PASS. Then `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint` → green; lint unchanged.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-09a|C7-11"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "popover: a 24 px|Help at|390"` → all pass
   (the "?" box stays 24 px; the pseudo-element does not grow it). Check the pattern with `--list` first.
3. `PORT=3100 npx playwright test e2e/help.mobile.spec.ts --project=mobile` → `1 passed`.
4. `PORT=3100 npx playwright test e2e/disk-files-layout.spec.ts --project=desktop -g "390"` → all pass.
5. `PORT=3100 npx playwright test e2e/cover-override.spec.ts --project=desktop -g "phone"` → all pass.
6. `PORT=3100 npx playwright test e2e/nfc-fob-button.spec.ts --project=desktop -g "390"` → all pass.
7. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Settings"` → all pass (1280 Settings).
8. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "file tree row|file toolbar|disk set at 390"` → `3 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/app/globals.css src/components/help/help-tip.tsx src/components/help/help-browser.tsx \
  "src/app/(app)/disks/[id]/files/loading.tsx" "src/app/(app)/disks/[id]/files/loading.test.ts" \
  src/components/games/disk-row.tsx src/components/games/write-protect-toggle.tsx src/components/games/mount-action.tsx \
  src/components/library/delete-disk-dialog.tsx src/components/nfc/fob-button.tsx src/components/disks/disk-card.tsx \
  src/components/disks/file-actions.tsx src/components/disks/file-tree.tsx src/lib/settings-look.ts \
  src/components/prefs/delete-account.tsx src/components/prefs/firmware-password-setting.tsx src/components/ui/modal.tsx \
  src/components/admin/delete-user-dialog.tsx src/components/admin/promote-release-button.tsx \
  src/components/admin/pager-link.tsx src/components/ingest/staging-list.tsx src/components/games/cover-control.tsx \
  src/components/library/library-pager.tsx src/components/prefs/sort-select.tsx src/components/library/create-adf.tsx \
  e2e/c7-phone.mobile.spec.ts
git commit -m "C7: 44 px phone targets: .seg items and wrap, the named buttons, the ? hit area; the stacked Disk files bone; the Help hash jump

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

(Add to `git add` any further component the sweep sent you to; name it in the report.)

---

### Task 5: Library: collections as one row of chips below `md`, the three-column table row below `sm`, the chip bone

**Files:**
- Modify: `src/components/collections/collection-rail.tsx` (whole file), `src/lib/library-table.ts` (append),
  `src/lib/library-table.test.ts` (append), `src/components/library/game-table.tsx:25-35,77-83,109-152,185-229`,
  `src/app/(app)/library/loading.tsx:10-16`, `src/app/(app)/library/loading.test.ts`, `e2e/mobile.spec.ts:271-291`,
  `e2e/c7-phone.mobile.spec.ts` (append `touchDragTo`, C7-04, C7-04b, C7-04c, C7-09b)

**Interfaces:**
- Consumes: `useCollectionsContext`, `useSortable` (unchanged drop targets); `useMediaQuery`
  (`@base-ui/react/unstable-use-media-query`); `fmtSize` (`@/lib/format`); `touchSweep`, `hydrated`, `seedDisk`,
  `runTag`, `randomBytes`.
- Produces:
  - `titleMeta(g: Pick<GameListItem, 'kind' | 'year' | 'publisher' | 'diskCount' | 'sizeBytes' | 'hasHd'>): string`
    (`@/lib/library-table`)
  - DOM: every rail row, Uncategorized and All titles carry `data-current="true|false"`; `collections-new`;
    `form#collection-create-form`; the rename field `input[aria-label="Collection name"]`; a phone row's fact line
    `[data-meta]`.

**Plan ruling** (spec §4.2, "Rename shows today's inline field on a line under the chip row"; "`+ New` toggles
today's create form … on a line under the row"): the rename and create fields render once each. On a phone they sit
under the chip row; from `md` they keep their rail places. That one field cannot be in two places by CSS without
duplicating `collection-create` or the rename input, so the rail decides with `useMediaQuery('(min-width: 768px)')`.
Both can only be opened after hydration, by a tap, so the media query has its client value by then and there is no
first-paint jump. The rename field gains `aria-label="Collection name"`, and both fields are `aria-disabled` +
`readOnly` while busy, never native `disabled`. When a rename or a create ends by key (Enter, Escape) or by a
create, focus goes to the row's ⋯ or to `collections-new`.

**Plan ruling** (spec §0 "never `window.confirm`" against §4.2 "same items Rename / Delete"): collection Delete still
uses today's `window.confirm`, which `collections.spec.ts:181-186` pins. The spec says every confirm is unchanged and
this phase adds no behaviour, so it stays. Relay it to the operator for the backlog (an in-app dialog like the
others).

**Plan ruling** (spec §4.3, "a 12 px meta line joining the hidden facts"): the hidden columns are Type, Year,
Publisher, Disks and Size, so the line is Type (when known), year, publisher, `N disk(s)` and the size (`+ HD`),
skipping empty ones: `Game · 1991 · Team 17 · 2 disks · 1.72 MB`. A folder row reads `Collection · 3 titles`, where
`3 titles` is today's `folder-titles` element moved onto the meta line below `sm`.

- [ ] **Step 1: Write the failing tests**

`src/lib/library-table.test.ts` — change the import to `import { tableRows, emptyTableNote, titleMeta } from './library-table';`
and append:

```ts
describe('titleMeta (C7 spec §4.3, Plan ruling)', () => {
  const g = { kind: 'Game', year: 1991, publisher: 'Team 17', diskCount: 2, sizeBytes: 1_802_240, hasHd: false };
  it('joins the hidden columns with " · ", in column order', () => {
    expect(titleMeta(g)).toBe('Game · 1991 · Team 17 · 2 disks · 1.72 MB');
  });
  it('skips what is unknown, and says 1 disk and HD in words', () => {
    expect(titleMeta({ ...g, kind: null, year: null, publisher: null, diskCount: 1, sizeBytes: 901_120 })).toBe('1 disk · 880 KB');
    expect(titleMeta({ ...g, hasHd: true })).toBe('Game · 1991 · Team 17 · 2 disks · 1.72 MB HD');
  });
});
```

`src/app/(app)/library/loading.test.ts` — the first `it` becomes:

```ts
  it('lays out the collections as the page does: a chip row below md, the 240 px rail beside the grid from md', () => {
    const html = renderToStaticMarkup(createElement(LibraryLoading));
    // The page's own row (library/page.tsx): a column below md, rail + grid side by side from md up.
    expect(html).toContain('flex flex-col gap-4 md:flex-row md:items-start');
    // Below md (C7 spec §4.2): one 44 px chip row.
    const chips = html.match(/<[^>]*data-testid="library-skeleton-chips"[^>]*>/)?.[0] ?? '';
    expect(chips).toContain('md:hidden');
    const chipHtml = html.slice(html.indexOf('library-skeleton-chips'), html.indexOf('library-skeleton-rail'));
    expect(chipHtml.match(/h-11/g)?.length).toBe(4);
    // From md: the rail's shape (collection-rail.tsx), 240 px with six 38 px row bones.
    const rail = html.match(/<[^>]*data-testid="library-skeleton-rail"[^>]*>/)?.[0] ?? '';
    expect(rail).toContain('md:w-60');
    expect(rail).toContain('hidden');
    expect(rail).toContain('md:flex');
    const railHtml = html.slice(html.indexOf('library-skeleton-rail'), html.indexOf('min-w-0 flex-1'));
    expect(railHtml.match(/h-\[38px\]/g)?.length).toBe(6);
    expect(html.indexOf('library-skeleton-rail')).toBeLessThan(html.indexOf('min-w-0 flex-1'));
  });
```

`e2e/mobile.spec.ts`: replace lines 271-291 (the test `the table view keeps every column reachable by scrolling`) with:

```ts
test('the table view at 390: each name wraps whole with its facts under it, the ⋯ is in view, nothing scrolls sideways', async ({ page }) => {
  const { u, run } = await seedLibrary(page, 3);
  const long = `Mobile ${run} A very long title that has to wrap onto a second line`.slice(0, 70);
  await seedDisk(u.orgId, { title: long, diskNo: 1, sha256: sha(`${run}-long`) });
  await page.goto('/library');
  // getByLabel, not a testid: the toggle is two <Link>s identified by
  // aria-label (view-toggle.tsx), which is also how view-toggle.spec.ts
  // finds them.
  await page.getByLabel('Table view').tap();
  const table = page.getByTestId('game-table');
  await expect(table).toBeVisible();
  const row = page.getByTestId('game-row').filter({ hasText: long });
  await expect(row).toBeVisible();
  // C7 (spec §4.3, Ruling 17): the whole name, no ellipsis; the hidden columns' facts on a line under it.
  const name = row.getByText(long, { exact: true });
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true);
  await expect(row.locator('[data-meta]')).toContainText('1 disk');
  const menu = (await row.locator('[data-testid^="title-menu-"]').boundingBox())!;
  expect(menu.width).toBeGreaterThanOrEqual(44);
  expect(menu.x + menu.width).toBeLessThanOrEqual(390);
  expect(await table.evaluate((el) => {
    const box = el.querySelector('[class*="overflow-x-auto"]') as HTMLElement;
    return box.scrollWidth <= box.clientWidth;
  })).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
```

`e2e/c7-phone.mobile.spec.ts` — append:

```ts
// ---- Library (spec §4, Rulings 16, 17) ---------------------------------------------------------------------

/** A real finger via CDP (mobile.spec's touchDrag, in two dimensions): press, hold past the 250 ms delay, walk, lift. */
async function touchDragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  await page.waitForTimeout(holdMs);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }],
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const newCollection = async (page: Page, name: string) =>
  (await (await page.request.post('/api/collections', { data: { name } })).json()).id as string;
const chipOf = (page: Page, id: string) => page.locator(`[data-testid="collection-row"][data-collection-id="${id}"]`);

test('C7-04 Library at 390: the collections are one row of 44 px chips, the current one in view with its ⋯; + New makes one', async ({ page }) => {
  await signUpFresh(page);
  const run = runTag();
  const ids: string[] = [];
  for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) ids.push(await newCollection(page, `${n} collection ${run}`));
  const last = ids[ids.length - 1];
  await page.goto(`/library?collection=${last}`);
  const rail = page.getByTestId('collection-rail');
  const chips = rail.locator('[data-testid="collection-uncategorized"], [data-testid="collection-row"], [data-testid="collection-all"], [data-testid="collections-new"]');
  await expect(chips).toHaveCount(ids.length + 3);
  const ys = new Set<number>();
  for (const c of await chips.all()) {
    const b = (await c.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    ys.add(Math.round(b.y));
  }
  expect(ys.size, 'one line').toBe(1);
  await expect(chipOf(page, last)).toHaveAttribute('data-current', 'true');
  await expect(chipOf(page, last)).toBeInViewport();
  // Only the current collection shows its ⋯, 44 x 44, with today's Rename and Delete.
  await expect(page.getByTestId(`collection-menu-${ids[0]}`)).toBeHidden();
  const menu = page.getByTestId(`collection-menu-${last}`);
  const mb = (await menu.boundingBox())!;
  expect(mb.width).toBeGreaterThanOrEqual(44);
  expect(mb.height).toBeGreaterThanOrEqual(44);
  await hydrated(page, `collection-menu-${last}`);
  await menu.tap();
  await expect(page.getByTestId(`collection-rename-${last}`)).toBeVisible();
  await expect(page.getByTestId(`collection-delete-${last}`)).toBeVisible();
  await page.keyboard.press('Escape');
  // + New opens today's form under the row, focused; a create closes it and the chip appears.
  await expect(page.getByTestId('collection-create')).toBeHidden();
  await hydrated(page, 'collections-new');
  await page.getByTestId('collections-new').tap();
  const field = page.getByTestId('collection-create');
  await expect(field).toBeFocused();
  const fb = (await field.boundingBox())!;
  expect(fb.y).toBeGreaterThanOrEqual((await chipOf(page, last).boundingBox())!.y + 44);
  expect(fb.height).toBeGreaterThanOrEqual(44);
  await field.fill(`Foxtrot ${run}`);
  await field.press('Enter');
  await expect(rail.locator('[data-testid="collection-row"]').filter({ hasText: `Foxtrot ${run}` })).toHaveCount(1);
  await expect(page.getByTestId('collection-create')).toBeHidden();
  await expect(page.getByTestId('collections-new')).toBeFocused();
  await noSideways(page);
});

test('C7-04b Library at 390: Rename opens a field under the chip row; Enter saves and focus returns to the ⋯ (Review Focus 5)', async ({ page }) => {
  await signUpFresh(page);
  const run = runTag();
  const id = await newCollection(page, `Rename me ${run}`);
  await page.goto(`/library?collection=${id}`);
  await hydrated(page, `collection-menu-${id}`);
  await page.getByTestId(`collection-menu-${id}`).tap();
  await page.getByTestId(`collection-rename-${id}`).tap();
  const field = page.getByRole('textbox', { name: 'Collection name' });
  await expect(field).toBeFocused();
  const chip = (await chipOf(page, id).boundingBox())!;
  const f = (await field.boundingBox())!;
  expect(f.y).toBeGreaterThanOrEqual(chip.y + chip.height);
  expect(f.height).toBeGreaterThanOrEqual(44);
  await field.fill(`Renamed ${run}`);
  await field.press('Enter');
  await expect(chipOf(page, id).getByTestId('collection-name')).toHaveText(`Renamed ${run}`);
  await expect(page.getByTestId(`collection-menu-${id}`)).toBeFocused();
});

test('C7-04c Library at 390: a card held and dropped on a chip is filed into that collection', async ({ page }) => {
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  const run = runTag();
  await seedDisk(u.orgId, { title: `Drop ${run}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  const id = await newCollection(page, `Target ${run}`);
  await page.goto('/library');
  const card = page.getByTestId('game-card').filter({ hasText: `Drop ${run}` });
  await expect(card).toBeVisible();
  await expect(chipOf(page, id)).toBeInViewport();
  const from = (await card.boundingBox())!;
  const to = (await chipOf(page, id).boundingBox())!;
  const filed = page.waitForResponse((r) => r.url().includes(`/api/collections/${id}/games`) && r.request().method() === 'POST');
  await touchDragTo(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 },
    { x: to.x + to.width / 2, y: to.y + to.height / 2 }, 400);
  expect((await filed).status()).toBe(200);
});

test('C7-09b touch targets and no sideways scroll: the Library grid and table', async ({ page }) => {
  test.setTimeout(120_000);
  const u = await signUpFresh(page);
  const run = runTag();
  for (let i = 0; i < 3; i++) await seedDisk(u.orgId, { title: `Sweep ${run} ${i}`, diskNo: 1, sha256: randomBytes(32).toString('hex') });
  await newCollection(page, `Sweep set ${run}`);
  await page.goto('/library');
  await expect(page.getByTestId('game-card').first()).toBeVisible();
  await touchSweep(page, 'library grid');
  await page.getByLabel('Table view').tap();
  await expect(page.getByTestId('game-table')).toBeVisible();
  await touchSweep(page, 'library table');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/library-table.test.ts "src/app/(app)/library/loading.test.ts"` → FAIL
(`titleMeta is not a function`; `library-skeleton-chips` not found).

Run: `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-04|C7-09b"` → FAIL (`4` tests).

- [ ] **Step 3: Implement**

`src/lib/library-table.ts` — add `import { fmtSize } from '@/lib/format';` and
`import type { GameListItem } from '@/lib/queries';` (type-only: this file stays client-safe) and append:

```ts
/**
 * A phone row's fact line (C7 spec §4.3, Ruling 17): the columns a row folds away below sm -- Type, Year, Publisher,
 * Disks, Size -- joined with " · ", unknown ones skipped.
 */
export function titleMeta(g: Pick<GameListItem, 'kind' | 'year' | 'publisher' | 'diskCount' | 'sizeBytes' | 'hasHd'>): string {
  return [
    g.kind,
    g.year != null ? String(g.year) : null,
    g.publisher,
    `${g.diskCount} ${g.diskCount === 1 ? 'disk' : 'disks'}`,
    `${fmtSize(g.sizeBytes)}${g.hasHd ? ' HD' : ''}`,
  ].filter((s): s is string => !!s).join(' · ');
}
```

`src/components/library/game-table.tsx`:

- Lines 25-35 become:

```tsx
// The grid condensed (operator design 2026-10-21), restyled to the approved board (InfLibraryTable, spec §3): one row
// per title with the card's features, and the collections as folders.
//
// TYPE sits between title and year: it qualifies what the row IS, so it belongs next to the name rather than out
// among the numbers. 104px, not the board's 96: "Educational" is the longest label and at 96 its pill ran into the
// YEAR column (Ruling 12). SIZE 96 so "1.72 MB HD" fits. The last track holds the ⋯ trigger.
//
// Below sm (C7 spec §4.3, Ruling 17) a row is three tracks -- the icon, the name over a line of the facts the other
// columns held (titleMeta), the ⋯ -- and nothing scrolls sideways; from sm it is today's 760 px table.
const COLS = 'grid-cols-[40px_minmax(0,1fr)_44px] sm:grid-cols-[36px_minmax(0,1fr)_104px_56px_150px_52px_96px_44px]';
const MIN_W = 'sm:min-w-[760px]';
const ROW = `grid ${COLS} ${MIN_W} items-center gap-x-3 border-b px-4 font-sans text-[13px] sm:gap-x-[14px] sm:px-[18px]`;
/** A column the phone row folds into its fact line. */
const WIDE = 'max-sm:hidden';
const HOVER = 'hover:bg-[color:var(--surface-2)]';
const ROW_BORDER = { borderColor: 'var(--hairline)' };
```

  and add `titleMeta` to the `@/lib/library-table` import.
- The column header (lines 77-83): the header `div`'s className gains `max-sm:hidden` (it keeps `grid ${COLS} ${MIN_W} h-11 …`),
  and the comment above `<div className="overflow-x-auto">` becomes `{/* From sm the fixed tracks total ~770px and the
  card clips (overflow-hidden rounds its corners), so this wrapper scrolls the last columns into reach. Below sm the
  row is three tracks and nothing overflows (C7 Ruling 17). */}`.
- `UpRow` (lines 109-119): `className={`${ROW} ${HOVER} h-11`}` stays; the label span's `col-span-7` becomes
  `col-span-2 sm:col-span-7`.
- `FolderRow` (lines 126-152): the Link's `className={`${ROW} ${HOVER} h-[46px]`}` becomes
  `className={`${ROW} ${HOVER} min-h-[56px] py-2 sm:h-[46px] sm:min-h-0 sm:py-0`}`; the name `span` block becomes:

```tsx
      <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
        <span className="text-[14px] font-semibold [overflow-wrap:anywhere] sm:truncate" style={{ color: 'var(--ink)' }}>{c.name}</span>
        {/* Below sm the fact line (Plan ruling, C7 Task 5); from sm the count beside the name, as before. */}
        <span data-meta="" className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
          <span className="sm:hidden">Collection · </span>
          <span data-testid="folder-titles">{titles}</span>
        </span>
      </span>
      <span className={`text-[12px] ${WIDE}`} style={{ color: 'var(--muted-2)' }}>Collection</span>
      <span className={WIDE} /><span className={WIDE} />
      <span className={`text-right font-mono ${WIDE}`} style={{ color: 'var(--muted)' }} data-testid="folder-disks">
        {disks ?? ''}
      </span>
      {/* Size is blank: no folder aggregate yet (Ruling 14). */}
      <span className={WIDE} />
      <span aria-hidden className="text-right" style={{ color: 'var(--muted-2)' }}>›</span>
```

- `TitleRow` (lines 185-229): `className={`${ROW} ${HOVER} h-[46px]`}` becomes
  `className={`${ROW} ${HOVER} min-h-[56px] py-2 sm:h-[46px] sm:min-h-0 sm:py-0`}`; the name `span` becomes:

```tsx
      <span className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {/* Below sm the whole name wraps (no ellipsis); from sm it truncates in its column, as before. */}
          <TitleName game={g} className="text-[14px] font-semibold [overflow-wrap:anywhere] sm:truncate sm:text-[13px] sm:font-medium" />
          <DriveBadge holds={drives?.holds[g.id]} diskCount={g.diskCount} inline />
        </span>
        <span data-meta="" className="text-[12px] sm:hidden" style={{ color: 'var(--muted-2)' }}>{titleMeta(g)}</span>
      </span>
```

  and the five column cells gain `WIDE`: `<span data-testid="game-kind">` → `<span data-testid="game-kind" className={WIDE}>`;
  the year span's `style=…` gains `className={WIDE}`; the publisher's `className="truncate"` → `className={`truncate ${WIDE}`}`;
  the disks span's `className="text-right font-mono"` → `className={`text-right font-mono ${WIDE}`}`; the size span's
  `className="flex items-center justify-end gap-1.5 text-right font-mono"` →
  `className={`flex items-center justify-end gap-1.5 text-right font-mono ${WIDE}`}`.

`src/app/(app)/library/loading.tsx`: replace lines 10-16 (the row `div` and the rail bone) with:

```tsx
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {/* Below md the collections are one 44 px chip row (collection-rail.tsx, C7 spec §4.2). */}
        <div className="flex gap-2 overflow-hidden px-4 sm:px-7 md:hidden" data-testid="library-skeleton-chips">
          {[28, 24, 24, 20].map((w, i) => <Bone key={i} className="h-11 shrink-0 rounded-full" style={{ width: `${w * 4}px` }} />)}
        </div>
        {/* From md, collection-rail.tsx's box: a caption and six 38 px rows, no card. */}
        <div className="ml-7 hidden w-60 shrink-0 flex-col gap-1 px-1 md:flex md:w-60"
             data-testid="library-skeleton-rail">
          <Bone className="mb-1.5 h-3 w-24" />
          {Array.from({ length: 6 }, (_, i) => <Bone key={i} className="h-[38px] w-full" />)}
        </div>
```

(and the comment above the component: `the rail stacks above the grid below md` → `below md the collections are a chip
row above the grid`).

`src/components/collections/collection-rail.tsx` (whole file):

```tsx
'use client';

// The left rail on /library: the org's collections, each one both a drop
// target for a dragged game card (case 1 in collection-provider's onDragEnd)
// and a sortable item among its siblings (case 3). A single `useSortable`
// per row supplies both -- dnd-kit's sortable hook already registers a
// draggable AND a droppable at the same id internally, so there is no
// separate useDroppable call here. `attributes`/`listeners` (the actual drag
// activators) go ONLY on the small grip handle, not the whole row: the row
// also hosts a Link, a rename input and a menu, and none of those should
// have to survive an 8px-pointer-move-then-release to register as a click.
//
// Below md (C7 spec §4.2, Ruling 16) the same rows are the board's chip row: one line that scrolls sideways,
// Uncategorized, the collections, All titles, + New. Chips stay drop targets; the grip is not drawn, so a phone does
// not reorder; only the current collection shows its ⋯. One DOM at every width: the classes switch at md.

import { Link } from '@/components/shell/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { collectionDot } from '@/lib/library-look';
import { viewHref, isCurrentView, type LibraryView } from '@/lib/library-view';
import {
  useCollectionsContext,
  type CollectionSummary,
  type CollectionDragData,
  type CollectionsDragData,
} from './collection-provider';

/** A rail row from md; a chip below it (44 px, round, a hairline on the surface). */
const ROW = 'flex min-w-0 shrink-0 items-center gap-2.5 text-[14px] md:h-[38px] md:rounded-[10px] md:px-3 md:hover:bg-(--track) max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:border max-md:border-(--line) max-md:bg-(--surface) max-md:px-3 max-md:text-[13px]';
/** The current row: a raised surface from md, an ink chip below it. In classes, so each width keeps its own look. */
const CURRENT = 'md:bg-(--surface) md:shadow-[0_1px_2px_rgb(36_33_27/.1),0_0_0_1px_var(--line)] max-md:border-(--ink) max-md:bg-(--ink)';
/** A row's words: ink, and the surface on the ink chip. */
const NAME = 'min-w-0 truncate text-(--ink) max-md:group-data-[current=true]:text-(--surface)';
/** The count stays --muted-2 on the rail (an earlier draft flipped it to #fff and lost it); on the ink chip, on-ink. */
const COUNT = 'shrink-0 font-mono text-[12px] text-(--muted-2) max-md:group-data-[current=true]:text-(--on-ink-muted)';
const FIELD = 'h-9 min-w-0 flex-1 rounded-[9px] px-2.5 text-[13px] max-md:h-11 max-md:text-[14px] aria-disabled:opacity-60';

/** The 8x8 rounded square in front of every rail row (spec 1.2). */
function Dot({ color }: { color: string }) {
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: color }} />;
}

export function CollectionRail({ viewMode = 'grid' }: { viewMode?: 'grid' | 'table' }) {
  const { collections, view, uncategorizedCount } = useCollectionsContext();
  const searchParams = useSearchParams();
  // Where the rename and create fields go (Plan ruling, C7 Task 5): in the rail from md, under the chip row below it.
  // Both open only on a tap after hydration, so this has its client value by then.
  const isMd = useMediaQuery('(min-width: 768px)', {});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);

  // Preserves every other query param (view, q) while only ever touching
  // `collection` -- so switching slices never drops the grid/table toggle.
  const hrefFor = (v: LibraryView) => viewHref(v, new URLSearchParams(searchParams.toString()));
  const current = (v: LibraryView) => isCurrentView(view, v);
  const inbox = current({ kind: 'uncategorized' });
  const all = current({ kind: 'all' });
  const renaming = collections.find((c) => c.id === renamingId) ?? null;

  // Below md the current chip is scrolled into view on load, without moving the page (spec §4.2).
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) return;
    scroller.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [view]);

  function endRename(id: string, refocus: boolean) {
    setRenamingId(null);
    // Ended by Enter or Escape: back to the row's ⋯, never to <body>. A blur already put focus somewhere else.
    if (refocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="collection-menu-${id}"]`)?.focus());
  }
  function endNew() {
    setNewOpen(false);
    requestAnimationFrame(() => newRef.current?.focus());
  }

  return (
    <aside className="flex shrink-0 flex-col md:ml-7 md:w-60 md:gap-0.5" data-testid="collection-rail">
      <div className="px-3 py-2 text-[12px] font-medium max-md:hidden" style={{ color: 'var(--muted-2)' }}>Collections</div>

      {/* Below md the chip row; from md `contents`, so its children are the rail's own rows, in today's order. */}
      <div ref={scroller} className="flex gap-2 overflow-x-auto px-4 pb-1 sm:px-7 md:contents">
        {/* The inbox, and the landing view. It sits with the collections
            rather than apart from them because it behaves like one: it has a
            count, it is a place titles are, and filing one into a collection
            takes it out of here. It is NOT a drop target -- "uncategorize this"
            is a removal, which the collection's own menu already does. */}
        <Link
          href={hrefFor({ kind: 'uncategorized' })}
          data-testid="collection-uncategorized"
          data-current={inbox}
          aria-current={inbox ? 'page' : undefined}
          className={`group ${ROW} justify-between ${inbox ? CURRENT : ''}`}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Dot color="#C4B9A2" />
            <span className={NAME} style={{ fontWeight: inbox ? 600 : 500 }}>Uncategorized</span>
          </span>
          <span className={COUNT}>{uncategorizedCount}</span>
        </Link>

        <div className="my-1 h-px max-md:hidden" style={{ background: 'var(--line)' }} />

        {collections.length === 0 ? (
          <p className="px-3 py-1 text-[12px] max-md:hidden" style={{ color: 'var(--muted-2)' }}>
            No collections yet
          </p>
        ) : (
          <SortableContext items={collections.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-0.5 max-md:contents">
              {collections.map((c) => (
                <CollectionRow
                  key={c.id}
                  collection={c}
                  active={current({ kind: 'collection', id: c.id })}
                  href={hrefFor({ kind: 'collection', id: c.id })}
                  renaming={renamingId === c.id && isMd}
                  onRename={() => setRenamingId(c.id)}
                  onRenameEnd={(refocus) => endRename(c.id, refocus)}
                />
              ))}
            </div>
          </SortableContext>
        )}

        <div className="my-1 h-px max-md:hidden" style={{ background: 'var(--line)' }} />

        {/* From md the form lives here; below md it opens under the row from + New. */}
        {!(newOpen && !isMd) && (
          <div className="max-md:hidden"><CreateCollectionForm /></div>
        )}

        {/* Last, and below the divider: the whole library in one list is an
            escape hatch, not the place you work. Kept because it is the only
            view that shows a title filed in two collections once, and the only
            one where "where did that disk go" has a single answer. */}
        <div className="my-1 h-px max-md:hidden" style={{ background: 'var(--line)' }} />
        <Link
          href={hrefFor({ kind: 'all' })}
          data-testid="collection-all"
          data-current={all}
          aria-current={all ? 'page' : undefined}
          className={`group ${ROW} ${all ? CURRENT : ''}`}
        >
          <Dot color="var(--ink)" />
          <span className={NAME} style={{ fontWeight: all ? 600 : 500 }}>All titles</span>
        </Link>

        <button ref={newRef} type="button" data-testid="collections-new" aria-expanded={newOpen}
                aria-controls="collection-create-form" onClick={() => setNewOpen((o) => !o)}
                className={`${ROW} font-medium text-(--ink) md:hidden`}>
          <Plus size={14} aria-hidden /> New
        </button>
      </div>

      {renaming && !isMd && (
        <div className="px-4 pt-2 sm:px-7 md:hidden">
          <RenameField collection={renaming} onEnd={(refocus) => endRename(renaming.id, refocus)} />
        </div>
      )}
      {newOpen && !isMd && (
        <div className="px-4 pt-2 sm:px-7 md:hidden">
          <CreateCollectionForm phone onDone={endNew} />
        </div>
      )}

      <p className="mx-3 mt-3 hidden text-[12px] leading-[1.5] md:block" style={{ color: 'var(--muted-2)' }}>
        {viewMode === 'table'
          ? 'Drag a row onto a collection to file it.'
          : 'Drag titles onto a collection to file them. Drag collections to reorder.'}
      </p>
    </aside>
  );
}

function CollectionRow({
  collection,
  active,
  href,
  renaming,
  onRename,
  onRenameEnd,
}: {
  collection: CollectionSummary;
  active: boolean;
  href: string;
  /** The inline field (from md only; below md the rail draws it under the chip row). */
  renaming: boolean;
  onRename: () => void;
  onRenameEnd: (refocus: boolean) => void;
}) {
  const router = useRouter();
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
    isOver, active: dragActive,
  } = useSortable({
    id: collection.id,
    data: { type: 'collection', id: collection.id } satisfies CollectionDragData,
  });

  /**
   * Which row a dragged card will actually land in.
   *
   * Driven by dnd-kit's own `isOver` -- the SAME value onDragEnd resolves the
   * drop from -- so the highlight cannot disagree with where the title really
   * goes. `isOver` is equally true while REORDERING the rail, where a drop
   * moves the collection rather than filing anything into it, so the active
   * drag has to be a game for the row to arm.
   */
  const draggingGame =
    (dragActive?.data.current as CollectionsDragData | undefined)?.type === 'game';
  const isDropTarget = draggingGame && isOver;
  // While a card is over the current row it shows as a target, not as current (its words stay ink on surface-2).
  const showCurrent = active && !isDropTarget;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    // Armed rows get a whisper so the rail reads as live; the one under the
    // pointer gets an unmissable ring. Geometry NEVER changes -- no padding
    // or size shift -- because moving a drop target out from under the cursor
    // mid-drag is how you make a drop land somewhere the person did not aim.
    // The current row's own look is a class (CURRENT), so each width keeps its own.
    background: isDropTarget ? 'var(--surface-2)' : draggingGame && !active ? 'rgb(36 33 27 / 0.05)' : undefined,
    boxShadow: isDropTarget ? '0 0 0 1px var(--ink)' : undefined,
  };

  async function onDelete() {
    // The reasonable fear here is "did this delete my disks" -- it doesn't,
    // and the confirm copy says so explicitly. (window.confirm is today's, pinned by collections.spec; C7 Plan ruling.)
    const confirmed = window.confirm(
      `Delete "${collection.name}"? This deletes only the collection -- the titles in it are not deleted.`,
    );
    if (!confirmed) return;
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collection.id}`, { method: 'DELETE' });
      } catch {
        toast.error('Could not reach the server', { description: 'The collection was not deleted.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not delete the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
      // If this was the filtered collection, the stale `?collection=` param
      // is left in the URL on purpose: page.tsx resolves it against a fresh
      // listCollections() on refresh and quietly falls back to unfiltered
      // (requirement carried from earlier reviews) -- no redirect needed here.
    } finally {
      router.refresh();
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="collection-row"
      data-collection-id={collection.id}
      data-current={showCurrent}
      data-drop-target={isDropTarget ? 'true' : undefined}
      className={`group flex shrink-0 items-center gap-1 md:h-[38px] md:rounded-[10px] md:pl-1 md:pr-1.5 md:hover:bg-(--track) max-md:h-11 max-md:rounded-full max-md:border max-md:border-(--line) max-md:bg-(--surface) max-md:pl-3 max-md:pr-0 ${showCurrent ? CURRENT : ''}`}
    >
      {/*
        `touchAction: 'none'` is load-bearing for the TouchSensor's press-and-hold: dnd-kit only calls preventDefault()
        on a touchmove that is still `cancelable`, and opting the handle out of browser gestures is what keeps that
        first post-hold move cancelable. Not drawn below md: a phone does not reorder (C7 Ruling 16).
      */}
      <button
        type="button"
        aria-label={`Reorder ${collection.name}`}
        {...attributes}
        {...listeners}
        style={{ touchAction: 'none', color: 'var(--muted-2)' }}
        className="grid h-7 w-5 shrink-0 cursor-grab place-items-center opacity-60 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing max-md:hidden"
      >
        <GripVertical size={13} />
      </button>

      {renaming ? (
        <RenameField collection={collection} onEnd={onRenameEnd} inline />
      ) : (
        <Link
          href={href}
          aria-current={active ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-1.5 max-md:flex-none max-md:gap-2 max-md:pl-0"
        >
          <Dot color={collectionDot(collection.id)} />
          <span
            data-testid="collection-name"
            className={`${NAME} flex-1 text-[14px] max-md:flex-none max-md:text-[13px]`}
            style={{ fontWeight: active ? 600 : 500 }}
          >
            {collection.name}
          </span>
          <span data-testid="collection-count" className={COUNT}>
            {collection.gameCount}
          </span>
        </Link>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`collection-menu-${collection.id}`}
          aria-label={`More actions for ${collection.name}`}
          // Below md only the current collection's chip shows its ⋯ (44 x 44); from md every row has it, as before.
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-(--muted) hover:bg-(--track) max-md:size-11 max-md:rounded-full max-md:group-data-[current=true]:text-(--surface) max-md:hover:bg-transparent ${active ? '' : 'max-md:hidden'}`}
        >
          <MoreHorizontal size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)' }}
        >
          <DropdownMenuItem data-testid={`collection-rename-${collection.id}`} onClick={onRename}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`collection-delete-${collection.id}`}
            variant="destructive"
            onClick={onDelete}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Rename a collection: inline in its rail row from md, on a line under the chip row below md (C7 spec §4.2). One field
 * either way. Enter saves and Escape cancels (focus back on the ⋯); a blur saves and leaves focus where it went.
 */
function RenameField({ collection, onEnd, inline = false }: {
  collection: CollectionSummary; onEnd: (refocus: boolean) => void; inline?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(collection.name);
  const [busy, setBusy] = useState(false);
  const ended = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  // Opened from the ⋯ menu, which hands focus back to its trigger as it closes: take it after that (two frames).
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => field.current?.focus()); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, []);

  async function submit(refocus: boolean) {
    if (ended.current) return;   // Enter then the unmount's blur: one request
    ended.current = true;
    const trimmed = name.trim();
    if (!trimmed || trimmed === collection.name) { onEnd(refocus); return; }
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collection.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'The collection was not renamed.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not rename the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
    } finally {
      setBusy(false);
      onEnd(refocus);
      router.refresh();
    }
  }

  return (
    <input
      ref={field}
      autoFocus
      aria-label="Collection name"
      value={name}
      readOnly={busy}
      aria-disabled={busy || undefined}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => void submit(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void submit(true); }
        if (e.key === 'Escape') { e.preventDefault(); ended.current = true; onEnd(true); }
      }}
      className={inline
        ? 'h-8 min-w-0 flex-1 rounded-lg border px-2 text-[14px] aria-disabled:opacity-60'
        : 'h-11 w-full rounded-[10px] border px-3 text-[14px] aria-disabled:opacity-60'}
      style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)', color: 'var(--ink)' }}
    />
  );
}

function CreateCollectionForm({ phone = false, onDone }: { phone?: boolean; onDone?: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    let created = false;
    try {
      let res: Response;
      try {
        res = await fetch('/api/collections', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'The collection was not created.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not create the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
      setName('');
      created = true;
    } finally {
      setBusy(false);
      router.refresh();
      // Below md a create closes the form and focus goes back to + New; a failure keeps it open to try again.
      if (created) onDone?.();
    }
  }

  return (
    <form id={phone ? 'collection-create-form' : undefined} onSubmit={onSubmit}
          onKeyDown={(e) => { if (phone && e.key === 'Escape') { e.preventDefault(); onDone?.(); } }}
          className="flex items-center gap-1.5 px-1 py-1 max-md:px-0">
      <input
        data-testid="collection-create"
        aria-label="New collection name"
        value={name}
        autoFocus={phone}
        readOnly={busy}
        aria-disabled={busy || undefined}
        onChange={(e) => setName(e.target.value)}
        placeholder="New collection"
        className={FIELD}
        style={{ background: 'var(--surface)', border: '1px dashed var(--line-strong)', color: 'var(--ink)' }}
      />
      <button
        type="submit"
        aria-label="Add collection"
        aria-disabled={busy || undefined}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border aria-disabled:opacity-50 max-md:size-11"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
      >
        <Plus size={16} aria-hidden />
      </button>
    </form>
  );
}
```

(`id` on the phone form only, so the desktop and phone forms never share an id. The phone `+ New` names it with
`aria-controls`.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/library-table.test.ts "src/app/(app)/library/loading.test.ts"` → PASS;
then `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint` → green; lint unchanged.

Before the e2e runs, grep the desktop specs that read the elements this task hides below `sm` or `md`:
`grep -rn "game-kind\|folder-disks\|folder-titles\|collection-create\|Reorder " e2e | grep -v mobile.spec`. Each hit
runs at 1280, where nothing changed; if one sets a phone width, run it and fix the test only if it asserted the old
phone layout. Name it in the report.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-04|C7-09b"` → `4 passed`.
2. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "table view at 390|library grid|touch drag|in a collection at 390|card held and dropped"` → `5 passed`.
3. `PORT=3100 npx playwright test e2e/collections.spec.ts --project=desktop -g "created, renamed|filtering to a collection|dragging a card onto|Uncategorized: a card|All titles: a card|failed add|rail highlights|reorder persists|per-card control"` → `9 passed`.
4. `PORT=3100 npx playwright test e2e/collections.spec.ts --project=desktop -g "reorder can never|merge that collapses|merge repoints|another org|deleting a user|landing view|overview card|All titles sits|inside a collection the heading"` → `9 passed`.
5. `PORT=3100 npx playwright test e2e/library-table.spec.ts --project=desktop` → `15 passed`.
6. `PORT=3100 npx playwright test e2e/library-a3.spec.ts e2e/view-toggle.spec.ts --project=desktop` → all pass (`--list` first; split if over 15).
7. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "library card"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/collections/collection-rail.tsx src/lib/library-table.ts src/lib/library-table.test.ts \
  src/components/library/game-table.tsx "src/app/(app)/library/loading.tsx" "src/app/(app)/library/loading.test.ts" \
  e2e/mobile.spec.ts e2e/c7-phone.mobile.spec.ts
git commit -m "C7: Library on a phone: collections as one row of 44 px chips with + New and rename under it; three-column table rows with a facts line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 6: Devices: the head buttons stacked full width, 44 px card controls, `Change second drive` disclosing the DF1 radios

**Files:**
- Modify: `src/app/(app)/devices/page.tsx:89`, `src/components/nfc/fob-button.tsx:62-66`,
  `src/components/devices/pair-button.tsx:84-90`, `src/components/devices/device-alias.tsx:116-118`,
  `src/components/devices/board-settings.tsx:106-108`, `src/components/devices/drive-front.tsx:40-42`,
  `src/components/devices/box-button.ts:2`, `src/components/devices/drive-box.tsx:96,116-118,128-130`,
  `src/components/devices/second-drive-setting.tsx` (state, lines 119-157),
  `src/components/devices/second-drive-setting.test.ts` (append), `e2e/c7-phone.mobile.spec.ts` (imports; append
  C7-05, C7-09c)

**Interfaces:**
- Consumes: `BOX_BTN`, `BOX_BTN_STYLE`; Task 4's `.seg` rule (radios 44 px below `sm`); `touchSweep`.
- Produces: `button[data-testid="df1-change-<id>"]` (`aria-expanded`, `aria-controls="second-drive-group-<id>"`);
  the radiogroup gains `id="second-drive-group-<id>"`; the mode line `[data-df1-mode]` (not a test id).

**Plan ruling** (spec §6.2, "`df1-change-<id>`, `aria-controls` the radiogroup"): the radiogroup gets the element id
`second-drive-group-<id>` for `aria-controls`. The closed state's line reads `DF1 · <the checked radio's label>`
(`DF1 · Network (PaulaNET)`). It is `sm:hidden` and keeps today's `second-drive-status` line beside it. The
disclosure is local state, so a LiveRefresh re-render after a save keeps it open (spec: "a choice saves as today and
does not close it").

- [ ] **Step 1: Write the failing tests**

`src/components/devices/second-drive-setting.test.ts` — append:

```ts
describe('SecondDriveSetting below sm (C7 spec §6.2, Ruling 18)', () => {
  it('says the mode in one line and offers Change second drive, which controls the radiogroup', () => {
    const html = render(board({ secondDrive: 'net', secondDriveReported: 'net', df1DiskId: null }));
    expect(html).toMatch(/<span data-df1-mode="" class="[^"]*sm:hidden[^"]*"[^>]*>DF1 · Network \(PaulaNET\)<\/span>/);
    const btn = html.match(/<button[^>]*data-testid="df1-change-d1"[^>]*>[^<]*<\/button>/)![0];
    expect(btn).toContain('aria-expanded="false"');
    expect(btn).toContain('aria-controls="second-drive-group-d1"');
    expect(btn).toContain('sm:hidden');
    expect(btn).toContain('>Change second drive</button>');
    expect(html).toMatch(/<div[^>]*class="[^"]*max-sm:hidden[^"]*"[^>]*>\s*<div role="radiogroup"[^>]*id="second-drive-group-d1"/);
  });
});
```

`e2e/c7-phone.mobile.spec.ts`: add `import { eq } from 'drizzle-orm';`, `import { getDb } from '@/db';` and
`import { devices } from '@/db/schema/devices';`; the device-helpers import becomes
`import { authHeader, cleanupSeeded, hydrated, pairDevice, seedDisk } from './device-helpers';`; append:

```ts
// ---- Devices (spec §6, Ruling 18) --------------------------------------------------------------------------

/** One board with an NFC reader (so Write a Next-disk card shows), DF1-capable firmware and a disk in DF0. */
async function deviceWithDisk(page: Page, request: Parameters<typeof pairDevice>[1], orgId: string) {
  const { deviceId, token } = await pairDevice(page, request, 'C7 Devices');
  const sha = randomBytes(32).toString('hex');
  const { gameId, diskId } = await seedDisk(orgId, { title: `C7 Disk ${runTag()}`, diskNo: 1, sha256: sha });
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: sha, nfcReader: 'present', preload: null, firmwareVersion: '1.21.1+gabc1234', secondDrive: 'off', driveVersion: 0 },
  })).status()).toBe(204);
  // devices-page.spec's setDevice: desired = mounted, so the card is converged and offers Eject.
  await getDb().update(devices).set({
    desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha, desiredDiskNo: 1,
    mountedGameId: gameId, mountedDiskId: diskId, mountedSha256: sha, mountedDiskNo: 1,
    lastSeenAt: new Date(), desiredVersion: 1,
  }).where(eq(devices.id, deviceId));
  return deviceId;
}

test('C7-05 Devices at 390: the head buttons one line each and full width; Change second drive opens the radios; card controls 44 px', async ({ page, request }) => {
  const u = await signUpFresh(page);
  const id = await deviceWithDisk(page, request, u.orgId);
  await page.goto('/devices');
  for (const tid of ['write-next-card', 'pair-device']) {
    const b = (await page.getByTestId(tid).boundingBox())!;
    expect(b.height, `${tid} one line`).toBeLessThanOrEqual(48);
    expect(b.height, tid).toBeGreaterThanOrEqual(44);
    expect(b.width, `${tid} full width`).toBeGreaterThan(300);
  }
  for (const tid of [`alias-edit-${id}`, `board-settings-${id}`, `display-toggle-${id}`, `device-protection-${id}`,
    `device-change-disk-${id}`, `eject-${id}`]) {
    const b = (await page.getByTestId(tid).boundingBox())!;
    expect(b.height, tid).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width, tid).toBeLessThanOrEqual(390);
  }
  // DF1: closed, it says the mode in words; the button opens the radios in place, one per row, 44 px.
  const group = page.getByTestId(`second-drive-${id}`);
  await expect(group).toBeHidden();
  const change = page.getByTestId(`df1-change-${id}`);
  await expect(change).toHaveText('Change second drive');
  await hydrated(page, `df1-change-${id}`);
  await change.tap();
  await expect(change).toHaveAttribute('aria-expanded', 'true');
  await expect(change).toHaveText('Done');
  await expect(group).toBeVisible();
  for (const m of ['off', 'df1', 'net', 'any']) {
    expect((await page.getByTestId(`second-drive-${id}-${m}`).boundingBox())!.height, m).toBeGreaterThanOrEqual(44);
  }
  // A choice saves as today and does not close the group.
  const saved = page.waitForResponse((r) => r.url().includes(`/api/devices/${id}/second-drive`) && r.request().method() === 'PATCH');
  await page.getByTestId(`second-drive-${id}-net`).tap();
  expect((await saved).ok()).toBe(true);
  await expect(group).toBeVisible();
  await expect(page.getByTestId(`second-drive-${id}-net`)).toHaveAttribute('aria-checked', 'true');
  await noSideways(page);
});

test('C7-09c touch targets and no sideways scroll: Devices with a board holding a disk', async ({ page, request }) => {
  test.setTimeout(90_000);
  const u = await signUpFresh(page);
  await deviceWithDisk(page, request, u.orgId);
  await page.goto('/devices');
  await expect(page.getByTestId('pair-device')).toBeVisible();
  await touchSweep(page, 'devices');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/components/devices/second-drive-setting.test.ts` → FAIL (no `df1-change-d1`).
Run: `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-05|C7-09c"` → FAIL (`2` tests).

- [ ] **Step 3: Implement**

`src/app/(app)/devices/page.tsx:89` — the `actions` prop becomes:

```tsx
        actions={(
          // Below sm the head's actions stack under the subtitle, full width and one line each (C7 spec §6.1); from sm
          // a row, as before. The "?" stays beside the first.
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
            {writers.length > 0 && (
              <div className="flex items-center gap-2">
                <FobButton mode="next" testId="write-next-card" title="Next-disk card" disks={[]} devices={writers} />
                <span style={{ color: 'var(--muted)' }}><HelpTip topic="nfc" /></span>
              </div>
            )}
            <PairButton />
          </div>
        )}
```

`src/components/nfc/fob-button.tsx:63`: the `write-next-card` button's className
`flex h-10 items-center gap-1.5 rounded-[10px] border px-3.5 text-[14px] font-medium` becomes
`flex h-10 items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-3.5 text-[14px] font-medium max-sm:min-h-11 max-sm:flex-1 max-sm:justify-center`.

`src/components/devices/pair-button.tsx` (the last `return`, lines 86-90): the className
`` `flex items-center gap-1.5 ${inkButton}` `` becomes
`` `flex items-center justify-center gap-1.5 whitespace-nowrap ${inkButton} max-sm:min-h-11 max-sm:w-full` ``.

`src/components/devices/device-alias.tsx:118`: `grid size-8 shrink-0 place-items-center …` gains `max-sm:size-11`.

`src/components/devices/board-settings.tsx:108`: `relative inline-flex h-8 shrink-0 …` gains `max-sm:min-h-11`.

`src/components/devices/drive-front.tsx:42`: `flex h-7 items-center gap-1.5 rounded-[7px] px-2 …` gains `max-sm:min-h-11`.

`src/components/devices/box-button.ts:2`: `BOX_BTN` gains ` max-sm:min-h-11 max-sm:justify-center`.

`src/components/devices/drive-box.tsx`: the actions row `<div className="flex flex-wrap items-center gap-2">`
(line 96) becomes
`<div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">` with the comment
`{/* Below sm the board's two-column grid of 44 px buttons, Eject last (C7 spec §6.2); from sm a wrapped row. */}`;
the Eject button's `flex h-[38px] items-center gap-1.5 …` and the Open library link's `flex h-[38px] items-center …`
each gain `max-sm:min-h-11 max-sm:justify-center`.

`src/components/devices/second-drive-setting.tsx`: after
`const [wantAny, setWantAny] = useState(false);` add

```tsx
  // Below sm the radios hide behind "Change second drive" (C7 spec §6.2, Ruling 18). Local state: a save's refresh
  // re-renders this card and keeps it open.
  const [phoneOpen, setPhoneOpen] = useState(false);
```

and replace lines 119-157 (from the `<span aria-hidden="true" …>DF1</span>` block's parent through the radiogroup's
closing `</div>`) so the header column and the radios read:

```tsx
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-[10px] font-mono text-[12px] font-semibold"
                style={{ background: 'var(--track)', color: 'var(--muted)' }}>DF1</span>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="flex items-center gap-1 text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
              Second drive (DF1)
              <HelpTip topic="second-drive" />
            </span>
            {/* Below sm the mode in words while the radios are closed (both values: the radios say it from sm). */}
            <span data-df1-mode="" className="text-[13px] font-semibold sm:hidden" style={{ color: 'var(--ink)' }}>
              {`DF1 · ${RADIOS.find((r) => r.value === shown)?.label ?? ''}`}
            </span>
            {device.secondDriveCapable && (
              <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`second-drive-help-${id}`}>
                {secondDriveHelp(shown, hasPick)}
              </span>
            )}
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
              {sel1 && (
                <>
                  <span data-testid={`device-sel1-${id}`} data-value={String(device.sel1Wired)}>{sel1Text(device.sel1Wired!)}</span>
                  {' · '}
                  <span data-testid={`device-df1seen-${id}`} data-value={String(device.df1Seen)}>{df1SeenText(device.df1Seen!)}</span>
                  {' · '}
                </>
              )}
              <span data-testid={`second-drive-status-${id}`}>{secondDriveStatus(device)}</span>
            </span>
          </div>
        </div>
        <button type="button" data-testid={`df1-change-${id}`} aria-expanded={phoneOpen}
                aria-controls={`second-drive-group-${id}`} onClick={() => setPhoneOpen((o) => !o)}
                className={`${BOX_BTN} w-full sm:hidden`} style={BOX_BTN_STYLE}>
          {phoneOpen ? 'Done' : 'Change second drive'}
        </button>
        <div className={`flex min-w-0 flex-col gap-1 lg:items-end ${phoneOpen ? '' : 'max-sm:hidden'}`}>
          <div role="radiogroup" aria-label="Second drive mode" id={`second-drive-group-${id}`} data-testid={`second-drive-${id}`} data-value={shown}
               onKeyDown={onKeyDown} className="seg seg--sm max-w-full flex-wrap max-sm:flex-col max-sm:items-stretch">
            {RADIOS.map((r) => (
              <button key={r.value} type="button" role="radio" aria-checked={shown === r.value}
                      tabIndex={r.value === stop ? 0 : -1} disabled={radioDisabled(r.value)} aria-disabled={saving}
                      data-testid={`second-drive-${id}-${r.value}`}
                      onClick={() => { if (!saving) void choose(r.value); }}
                      className="seg-item whitespace-nowrap disabled:opacity-50">
                {r.label}
              </button>
            ))}
          </div>
```

(The `second-drive-net-note` block and everything after it stay as they are. Import `BOX_BTN` alongside
`BOX_BTN_STYLE`: `import { BOX_BTN, BOX_BTN_STYLE } from '@/components/devices/box-button';`. The radios keep native
`disabled` only for "the board cannot take this", which is today's rule and not a busy state.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/components/devices/second-drive-setting.test.ts src/components/devices/board-settings.test.ts`
→ PASS; then `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint` → green; lint unchanged.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-05|C7-09c"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "Devices cards are one per row|write-next-card|press-and-hold inside"` → `3 passed`.
3. `PORT=3100 npx playwright test e2e/second-drive.spec.ts --project=desktop -g "without DF1 support|switching DF1 on|refuses the switch|failed save shows|help tip opens|Network needs 1.11.0|firmware guard per version|choosing Network|checklist reads|refuses Network"` → `10 passed`.
4. `PORT=3100 npx playwright test e2e/second-drive.spec.ts --project=desktop -g "setting reads Off|mounted into DF1|mounting into DF0|deleting the disk in DF1|before 1.12.0|netPick|Any disk shows|Any disk on a board|arrow keys move|Transfer box inside|during a DF1 save|failed Any disk save"` → `12 passed`.
5. `PORT=3100 npx playwright test e2e/devices-page.spec.ts --project=desktop -g "390|whole width|eject"` → all pass (`--list` first).
6. `PORT=3100 npx playwright test e2e/device-alias.spec.ts e2e/pairing.spec.ts --project=desktop` → all pass (`--list` first; split if over 15).
7. `PORT=3100 npx playwright test e2e/nfc-fob-button.spec.ts --project=desktop -g "390"` → all pass.
8. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Devices pairs"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add "src/app/(app)/devices/page.tsx" src/components/nfc/fob-button.tsx src/components/devices/pair-button.tsx \
  src/components/devices/device-alias.tsx src/components/devices/board-settings.tsx src/components/devices/drive-front.tsx \
  src/components/devices/box-button.ts src/components/devices/drive-box.tsx src/components/devices/second-drive-setting.tsx \
  src/components/devices/second-drive-setting.test.ts e2e/c7-phone.mobile.spec.ts
git commit -m "C7: Devices on a phone: head buttons full width on one line, 44 px card controls, Change second drive discloses the DF1 radios

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 7: Upload: two 96 px tiles side by side below `sm`, the hint lines and the URL row under them

**Files:**
- Create: `src/lib/drop-hint.ts`, `src/lib/drop-hint.test.ts`
- Modify: `src/components/ingest/drop-card.tsx` (whole file), `src/components/ingest/drop-card.test.ts` (render
  helper, append), `src/components/ingest/dropzone.tsx:423-442`, `src/components/ingest/url-fetch.tsx:68-106`,
  `src/components/send/send-panel.tsx:25-35,83-129`, `src/app/(app)/ingest/page.tsx:30-35`,
  `e2e/mobile.spec.ts:849-874`, `e2e/c7-phone.mobile.spec.ts` (imports; append C7-06, C7-06b, C7-09d)

**Interfaces:**
- Consumes: `DiskIcon`, `HelpTip`; `touchSweep`, `noSideways`, `hydrated`, `stagingReady`.
- Produces:
  - `splitHint(text: string): { first: string; rest: string }` (`@/lib/drop-hint`)
  - `DropCard` gains the prop `tileCol: 1 | 2`; `drop-card.tsx` exports `TILE: Record<1 | 2, string>`, `TILE_LOOK`
    and `INK_LABEL` (colours now in classes), and `INK_STYLE` (only `--tw-ring-color`)
  - DOM: below `sm` the file labels `add-browse` / `send-browse` are the tiles (`data-tile` = their word); with no
    board a `div[data-tile="Pair a board first"]` is the Send tile

**Plan ruling** (spec §7, "Under the tiles, full width: one … hint line per tile, then the URL row … then … the send
board picker", with "the whole tile is the label of the card's existing hidden file input"): the hints, the URL row
and the picker live inside each card's `section`. That section is the drop target: `hydrated(…, 'onDrop')`,
`data-over` and `aria-labelledby` all key on it, so it cannot move. With one DOM and no duplicated ids, CSS can only
place those children under both tiles if the section is `display: contents` below `sm`. So it is: its children
(tile label, icon, hint, URL row, picker) become items of the page's two-column grid and are placed with
`order` / `col-span`. Drag events still bubble through the section, so drops still land on it. Below `sm` the
section therefore draws no box of its own, and the tests measure the tiles (`add-browse`, `send-browse`). Risk to
relay: older WebKit dropped the region role of a `display: contents` element. The tile label's own accessible name
(`Add to library`, `Send to Amiga`) still names each picker. Task 9's by-hand check confirms VoiceOver if the
operator has an iPhone to hand.

**Plan ruling** (spec §7, `today's words where they exist`): the disabled Send tile says `Pair a board first`, the
spec's words. The full reason stays in the hint line under the tiles (`send-no-board`, today's words).

- [ ] **Step 1: Write the failing tests**

`src/lib/drop-hint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitHint } from './drop-hint';

describe('splitHint (C7 spec §7: a phone keeps the first sentence)', () => {
  it("splits today's two hints after their first sentence", () => {
    expect(splitHint('ADF, ADZ, DMS, DMZ or HFE. Hashed in your browser first — only missing disks upload.')).toEqual({
      first: 'ADF, ADZ, DMS, DMZ or HFE.', rest: 'Hashed in your browser first — only missing disks upload.',
    });
    expect(splitHint('Any file up to 4 MB. It waits here until Transfer on the Amiga takes it, into the folder Transfer saves to.').first)
      .toBe('Any file up to 4 MB.');
  });
  it('a one-sentence hint has no rest', () => {
    expect(splitHint('Only this.')).toEqual({ first: 'Only this.', rest: '' });
  });
});
```

`src/components/ingest/drop-card.test.ts`: in the `render` helper add `tileCol: 1,` after `onFiles: () => undefined,`,
change the hint to `hint: 'A hint. A second sentence.'`, keep the existing three tests (their `'A hint.'` checks
still hold), and append:

```ts
describe('DropCard below sm (C7 spec §7, Ruling 19)', () => {
  it('the section is display:contents on a phone and a group for the drag look', () => {
    expect(render()).toMatch(/<section[^>]*class="group [^"]*max-sm:contents/);
  });
  it('the heading stays in the DOM for aria-labelledby, visually hidden on a phone', () => {
    expect(render()).toMatch(/<h2 id="add-heading" class="[^"]*max-sm:sr-only/);
  });
  it('the 34 px disk sits in the tile cell of its column, under the label (no pointer events)', () => {
    expect(render({ tileCol: 2 })).toMatch(/<span aria-hidden="true" class="[^"]*pointer-events-none[^"]*max-sm:col-start-2 max-sm:row-start-1[^"]*sm:hidden"/);
  });
  it('a phone keeps the first sentence of the hint; the rest is there from sm', () => {
    const html = render();
    expect(html).toContain('data-testid="dropzone-hint"');
    expect(html).toContain('A hint.<span class="max-sm:hidden"> A second sentence.</span>');
  });
});
```

`e2e/mobile.spec.ts`: rename the test at line 849 to
`'the Upload page puts its two drop tiles side by side at 390px, and a 200-byte saved path wraps'` and replace its
last four lines (from `const add = await page.getByTestId('dropzone').boundingBox();` through the `overflow`
expectation) with:

```ts
  // C7 (spec §7, Ruling 19): the two file labels are the board's tiles, side by side, at least 96 px tall, the URL
  // row under them.
  const add = (await page.getByTestId('add-browse').boundingBox())!;
  const send = (await page.getByTestId('send-browse').boundingBox())!;
  expect(Math.abs(add.y - send.y)).toBeLessThan(1);
  expect(send.x).toBeGreaterThan(add.x + add.width - 1);
  for (const t of [add, send]) expect(t.height).toBeGreaterThanOrEqual(96);
  expect((await page.getByTestId('url-fetch-form').boundingBox())!.y).toBeGreaterThan(add.y + add.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
```

`e2e/c7-phone.mobile.spec.ts`: the helpers import becomes
`import { signUpFresh, runTag, createAdf, stagingReady } from './helpers';`; append:

```ts
// ---- Upload (spec §7, Ruling 19) ---------------------------------------------------------------------------

async function sendBoard(page: Page, request: Parameters<typeof pairDevice>[1]) {
  const { token } = await pairDevice(page, request, 'C7 Upload');
  await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.21.1+gabc1234', secondDrive: 'net', driveVersion: 0 } });
  await request.get('/api/device/poll?since=999999&xferAck=0&rx=c', { headers: authHeader(token) });
}

test('C7-06 Upload at 390: two 96 px tiles side by side; a tap opens its chooser; Staging starts on the first screen', async ({ page, request }) => {
  await signUpFresh(page);
  await sendBoard(page, request);
  await page.goto('/ingest');
  await stagingReady(page);
  const add = page.getByTestId('add-browse');
  const send = page.getByTestId('send-browse');
  const a = (await add.boundingBox())!;
  const s = (await send.boundingBox())!;
  expect(Math.abs(a.y - s.y)).toBeLessThan(1);
  expect(s.x).toBeGreaterThan(a.x + a.width - 1);
  for (const t of [a, s]) {
    expect(t.height).toBeGreaterThanOrEqual(96);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x + t.width).toBeLessThanOrEqual(390);
  }
  await hydrated(page, 'file-input', 'onChange');
  for (const [tile, input] of [[add, 'file-input'], [send, 'send-file-input']] as const) {
    const chooser = page.waitForEvent('filechooser');
    await tile.tap();
    expect(await (await chooser).element().getAttribute('data-testid')).toBe(input);
  }
  expect((await page.locator('#staging-heading').boundingBox())!.y).toBeLessThan(844);
  await noSideways(page);
});

test('C7-06b Upload at 390 with no board: the Send tile says Pair a board first, opens no chooser, and the hint says why (Review Focus 3)', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');
  await stagingReady(page);
  const tile = page.locator('[data-tile="Pair a board first"]');
  await expect(tile).toBeVisible();
  const a = (await page.getByTestId('add-browse').boundingBox())!;
  const t = (await tile.boundingBox())!;
  expect(Math.abs(a.y - t.y)).toBeLessThan(1);
  expect(t.height).toBeGreaterThanOrEqual(96);
  expect(await tile.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"Pair a board first"');
  let opened = false;
  page.on('filechooser', () => { opened = true; });
  await tile.tap();
  await page.waitForTimeout(300);
  expect(opened).toBe(false);
  await expect(page.getByTestId('send-no-board')).toBeVisible();
});

test('C7-09d touch targets and no sideways scroll: Upload with a board', async ({ page, request }) => {
  test.setTimeout(90_000);
  await signUpFresh(page);
  await sendBoard(page, request);
  await page.goto('/ingest');
  await stagingReady(page);
  await touchSweep(page, 'upload');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/lib/drop-hint.test.ts src/components/ingest/drop-card.test.ts` → FAIL
(`Cannot find module './drop-hint'`; no `max-sm:contents`).
Run: `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-06|C7-09d"` → FAIL (`3` tests).

- [ ] **Step 3: Implement**

`src/lib/drop-hint.ts`:

```ts
/**
 * A drop card's hint on a phone keeps its first sentence (C7 spec §7, Ruling 19: "today's hint words, shortened only
 * by dropping the second sentence"). `rest` is '' when there is only one.
 */
export function splitHint(text: string): { first: string; rest: string } {
  const t = text.trim();
  const m = /^(.+?[.!?])\s+(.+)$/s.exec(t);
  return m ? { first: m[1], rest: m[2] } : { first: t, rest: '' };
}
```

`src/components/ingest/drop-card.tsx` (whole file):

```tsx
'use client';
import { useState } from 'react';
import { DiskIcon } from '@/components/ui/disk-icon';
import type { DiskColor } from '@/lib/disk-icon';
import { splitHint } from '@/lib/drop-hint';

/**
 * The shared look of Browse files and Choose files (C3 spec §2.1, §2.2): an ink pill around a hidden file input. The
 * colours are classes, not an inline style, so that below sm the same label can be the board's tile (C7 Ruling 19).
 */
export const INK_LABEL = 'inline-flex h-[38px] shrink-0 cursor-pointer items-center rounded-[10px] bg-(--ink) px-3.5 text-[13px] font-semibold text-(--surface) has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-50';
export const INK_STYLE = { '--tw-ring-color': 'var(--ring)' } as React.CSSProperties;

/** Below sm a tile's grid cell: column 1 (Add) or 2 (Send) of the page's first row. */
export const TILE = {
  1: 'max-sm:col-start-1 max-sm:row-start-1',
  2: 'max-sm:col-start-2 max-sm:row-start-1',
} as const;

/**
 * Below sm the board's 96 px tile (C7 spec §7): dashed, on the surface, its 13/600 word at the bottom. The word is CSS
 * content from data-tile, so the label's own text ("Browse files", which the 1440 tests read) is unchanged.
 */
export const TILE_LOOK = 'max-sm:h-24 max-sm:w-full max-sm:flex-col max-sm:justify-end max-sm:rounded-[14px] max-sm:border-[1.5px] max-sm:border-dashed max-sm:border-(--dash) max-sm:bg-(--surface) max-sm:px-2 max-sm:pb-3 max-sm:text-[13px] max-sm:text-(--ink) max-sm:before:content-[attr(data-tile)] max-sm:group-data-[over=true]:border-(--ink) max-sm:group-data-[over=true]:bg-(--surface-2)';

/**
 * The Upload page's drop card (C3 spec §2): the whole dashed card takes a drop; its controls open the picker. Below sm
 * (C7 Plan ruling, Task 7) the section is display:contents, so its children are items of the page's two-column grid:
 * the file label is the tile, the 34 px disk sits on it, the hint and the controls go under both tiles.
 */
export function DropCard({ testId, headingId, title, help, hint, disk, tileCol, disabled, onFiles, children }: {
  testId: string; headingId: string; title: string; help?: React.ReactNode; hint: React.ReactNode;
  disk: { color: DiskColor; set: string; title: string }; tileCol: 1 | 2; disabled?: boolean;
  onFiles?: (files: FileList) => void; children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const drop = !!onFiles && !disabled;
  // Only a drag that carries files is the card's business; a dragged link belongs to the URL field (final review M3).
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const h = typeof hint === 'string' ? splitHint(hint) : null;
  return (
    <section aria-labelledby={headingId} data-testid={testId} data-over={String(over)} data-drop={onFiles ? 'on' : 'off'}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); if (drop && !over) setOver(true); }}
      onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); if (drop && !over) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setOver(false); if (drop) onFiles(e.dataTransfer.files); }}
      className="group relative flex min-w-0 items-center gap-4 rounded-[20px] border-[1.5px] border-dashed border-[var(--dash)] bg-[var(--surface)] p-5 hover:border-[var(--ink)] data-[over=true]:border-[var(--ink)] data-[over=true]:bg-[var(--surface-2)] max-sm:contents sm:gap-5 sm:p-6">
      <span aria-hidden="true" className={`pointer-events-none z-10 mt-[18px] self-start justify-self-center ${TILE[tileCol]} sm:hidden`}>
        <DiskIcon color={disk.color} size={34} />
      </span>
      <span className="hidden shrink-0 sm:block"><DiskIcon color={disk.color} size={84} set={disk.set} title={disk.title} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 max-sm:contents">
        <div className="flex items-center gap-1 max-sm:contents">
          <h2 id={headingId} className="text-[20px] font-bold max-sm:sr-only sm:text-[22px]"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>{title}</h2>
          {help}
        </div>
        <div data-testid={`${testId}-hint`} className="text-[13px] max-sm:order-1 max-sm:col-span-2 max-sm:text-[12px]" style={{ color: 'var(--muted)' }}>
          {h ? <>{h.first}{h.rest && <span className="max-sm:hidden">{` ${h.rest}`}</span>}</> : hint}
        </div>
        {children}
      </div>
    </section>
  );
}
```

`src/components/ingest/dropzone.tsx` — the returned `DropCard` (lines 426-441) becomes:

```tsx
    <DropCard testId="dropzone" headingId="add-heading" title="Add disks to the library"
      hint="ADF, ADZ, DMS, DMZ or HFE. Hashed in your browser first — only missing disks upload."
      disk={{ color: 'black', set: 'ADF · ADZ · DMS · HFE', title: 'Add to library' }} tileCol={1}
      disabled={busy} onFiles={(f) => void handleFiles(f)}>
      <div className="flex flex-col gap-2 max-sm:contents sm:flex-row sm:flex-wrap sm:items-center">
        {/* Below sm this label is the Add tile (C7 spec §7); its word is data-tile, so its text stays "Browse files". */}
        <label htmlFor="add-file-input" data-testid="add-browse" data-tile={busy ? 'Working…' : 'Add to library'}
               className={`${INK_LABEL} ${TILE_LOOK} ${TILE[1]}`} style={INK_STYLE}>
          <span className="max-sm:hidden">{busy ? 'Working…' : 'Browse files'}</span>
          <input id="add-file-input" type="file" multiple accept=".adf,.dsk,.adz,.dms,.dmz,.hfe" className="sr-only"
                 data-testid="file-input" disabled={busy}
                 onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); }} />
        </label>
        <UrlFetch busy={busy} setBusy={setBusy} onRows={addFetchedRows} />
      </div>
      {suggestion && (
        <div className="max-sm:order-2 max-sm:col-span-2">
          <SetSuggestion suggestion={suggestion} onDone={() => setSuggestion(null)} />
        </div>
      )}
    </DropCard>
```

and the import becomes `import { DropCard, INK_LABEL, INK_STYLE, TILE, TILE_LOOK } from './drop-card';`. (The file
input keeps its native `disabled={busy}`: `upload-staging.spec` pins it, and it is not a focus target.)

`src/components/ingest/url-fetch.tsx`: the form's className gains `max-sm:order-2 max-sm:col-span-2`; the
`ingest-url-hint` span's `basis-full text-[12px]` becomes `basis-full text-[12px] max-sm:order-2 max-sm:col-span-2`;
the `url-status` paragraph's `min-h-[1em] basis-full text-[12px]` becomes
`min-h-[1em] basis-full text-[12px] max-sm:order-2 max-sm:col-span-2`.

`src/components/send/send-panel.tsx`: the import becomes
`import { DropCard, INK_LABEL, INK_STYLE, TILE, TILE_LOOK } from '@/components/ingest/drop-card';`; add above the
component:

```tsx
/** Below sm the "?" sits in the Send tile's top-right corner (C7 spec §7): a sibling of the label, so a tap on it
 *  opens its popover and not the file chooser. */
const SEND_HELP = 'max-sm:z-20 max-sm:col-start-2 max-sm:row-start-1 max-sm:m-1.5 max-sm:self-start max-sm:justify-self-end';
```

both `help={<HelpTip topic="send" />}` become `help={<HelpTip topic="send" className={SEND_HELP} />}`; both
`DropCard`s gain `tileCol={2}`; the no-board return (lines 25-35) becomes:

```tsx
  if (targets.length === 0) {
    return (
      <DropCard testId="send-dropzone" headingId="send-heading" title="Send files to the Amiga" help={<HelpTip topic="send" className={SEND_HELP} />}
        disk={{ color: 'grey', set: 'Any file · 4 MB', title: 'To the Amiga' }} tileCol={2}
        hint={
          <p data-testid="send-no-board">
            No board can receive files yet. Sending needs a board on firmware {XFER_FW} or newer.{' '}
            <Link href="/devices" className="font-semibold underline underline-offset-2" style={{ color: 'var(--ink)' }}>Devices</Link>
          </p>
        }>
        {/* Below sm the Send tile, unpressable: it says why, and the hint under the tiles names the fix (C7 Task 7). */}
        <div data-tile="Pair a board first" className={`hidden ${TILE_LOOK} ${TILE[2]} max-sm:flex max-sm:items-center`} />
      </DropCard>
    );
  }
```

and in the board case (lines 88-128) the wrapper `div`'s
`flex flex-wrap items-center gap-x-2.5 gap-y-2` gains `max-sm:contents`; the `send-browse` label becomes

```tsx
        <label htmlFor="send-file-input" data-testid="send-browse" data-tile="Send to Amiga"
               className={`${INK_LABEL} ${TILE_LOOK} ${TILE[2]}`} style={INK_STYLE}>
          <span className="max-sm:hidden">Choose files</span>
          <input id="send-file-input" type="file" multiple className="sr-only" data-testid="send-file-input"
                 onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); e.target.value = ''; }} />
        </label>
```

the `send-board` span's `text-[13px]` becomes `text-[13px] max-sm:order-3 max-sm:col-span-2`; the `send-receiver`
span's `text-[13px] font-medium` becomes `text-[13px] font-medium max-sm:order-3 max-sm:col-span-2`; and the
`send-board-picker` fieldset's `flex flex-col gap-1 rounded-[12px] p-2.5` becomes
`flex flex-col gap-1 rounded-[12px] p-2.5 max-sm:order-4 max-sm:col-span-2`.

`src/app/(app)/ingest/page.tsx:30-35` — the comment and grid become:

```tsx
        {/* The two drop cards side by side from 1024 px (spec 2026-10-25 §1), stacked from sm; below sm the board's two
            96 px tiles side by side with the hint lines, the URL row and the board picker under them (C7 spec §7,
            Ruling 19). Then the one Staging list. */}
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-2 sm:grid-cols-1 sm:gap-5 lg:grid-cols-2 lg:items-stretch">
```

Then grep for other `DropCard` callers that now need `tileCol` (`grep -rn "<DropCard" src`): expect only
`dropzone.tsx` and `send-panel.tsx`. `npx tsc --noEmit` reports any other.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/lib/drop-hint.test.ts src/components/ingest/drop-card.test.ts` → PASS; then
`pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint` → green; lint unchanged.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-06|C7-09d"` → `3 passed`.
2. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "Upload page puts|drop strip"` → `2 passed`.
3. `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop -g "drop cards|Send card names|link dragged|390"` → all pass (`--list` first).
4. `PORT=3100 npx playwright test e2e/url-upload.spec.ts --project=desktop` → `5 passed`.
5. `PORT=3100 npx playwright test e2e/send-to-amiga.spec.ts --project=desktop` → all pass (`--list` first; split if over 15).
6. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Upload pairs"` → `1 passed` (Browse keeps ink on surface from sm).
7. `PORT=3100 npx playwright test e2e/hfe-disks.spec.ts --project=desktop -g "dropzone"` → `1 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/drop-hint.ts src/lib/drop-hint.test.ts src/components/ingest/drop-card.tsx src/components/ingest/drop-card.test.ts \
  src/components/ingest/dropzone.tsx src/components/ingest/url-fetch.tsx src/components/send/send-panel.tsx \
  "src/app/(app)/ingest/page.tsx" e2e/mobile.spec.ts e2e/c7-phone.mobile.spec.ts
git commit -m "C7: Upload on a phone: the two file labels are 96 px tiles side by side, hints, URL row and picker under them; Staging on the first screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 8: Admin: `admin-sections` wraps below `sm`, Invites rows stack with 44 px actions

**Files:**
- Modify: `src/components/admin/admin-nav.tsx:22-24`, `src/components/admin/admin-nav.test.ts` (the `.seg` class
  assertion), `src/app/(admin)/admin/invites/page.tsx:19-20,41-102`, `src/components/admin/copy-invite-buttons.tsx:37-38`,
  `src/components/admin/revoke-invite-button.tsx:49`, `e2e/c6-admin-layout.spec.ts:604-640`,
  `e2e/c7-phone.mobile.spec.ts` (imports; append C7-08, C7-09e)

**Interfaces:**
- Consumes: Task 4's `.seg` wrap rule; Task 1's admin shell; `touchSweep`, `tabs`, `ADMIN_PAGES`, `noSideways`.
- Produces: the Invites table with explicit `table` / `rowgroup` / `row` / `columnheader` / `cell` roles, stacked
  below `sm`.

- [ ] **Step 1: Write the failing tests**

`src/components/admin/admin-nav.test.ts`: `expect(html).toMatch(/class="seg w-max"/);` becomes
`expect(html).toMatch(/class="seg w-max max-sm:w-full"/);`.

`e2e/c7-phone.mobile.spec.ts`: the helpers import becomes
`import { signUpFresh, runTag, createAdf, stagingReady, mintInviteCode } from './helpers';` and add
`import { revokeInvite } from '@/lib/invites';`; append:

```ts
// ---- Admin (spec §11, Rulings 8-10) ------------------------------------------------------------------------

test('C7-08 Admin at 390: no tab clipped, Invites rows stacked with Copy code / Copy link / Revoke 44 px in view, no sideways scroll', async ({ page }) => {
  test.setTimeout(120_000);
  const code = await mintInviteCode();
  try {
    await signInAsSuperAdmin(page);
    for (const path of ADMIN_PAGES) {
      await page.goto(path);
      const sections = page.getByTestId('admin-sections').getByRole('link');
      await expect(sections).toHaveCount(5);
      for (const s of await sections.all()) {
        const b = (await s.boundingBox())!;
        expect(b.x, path).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, path).toBeLessThanOrEqual(390);
        expect(b.height, path).toBeGreaterThanOrEqual(44);
      }
      for (const t of await tabs(page).all()) expect((await t.boundingBox())!.x + (await t.boundingBox())!.width).toBeLessThanOrEqual(390);
      await noSideways(page);
    }
    await page.goto('/admin/invites');
    await expect(page.getByTestId(`invite-${code}`)).toBeVisible();
    for (const id of [`invite-copy-code-${code}`, `invite-copy-link-${code}`, `revoke-${code}`]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.height, id).toBeGreaterThanOrEqual(44);
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, id).toBeLessThanOrEqual(390);
    }
    expect(await page.locator('section[aria-label="Invite codes"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
    // Still a table to a screen reader.
    await expect(page.locator('section[aria-label="Invite codes"]').getByRole('row').first()).toBeAttached();
  } finally {
    await revokeInvite(code);
  }
});

test('C7-09e touch targets and no sideways scroll: the five admin pages', async ({ page }) => {
  test.setTimeout(150_000);
  await signInAsSuperAdmin(page);
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByTestId('admin-sections')).toBeVisible();
    await touchSweep(page, path);
  }
});
```

`e2e/c6-admin-layout.spec.ts` — the test at line 604: rename it
`'at 390 px: the bottom tab bar, admin-sections wrapped with every tab on screen, Invites stacked, nothing scrolls the page sideways'`;
replace the two lines `const clamp = …` and `expect(clamp.x + clamp.width).toBeLessThanOrEqual(390 - 16 + 1);` with:

```ts
    // C7 (spec §11.1, Ruling 10): the five tabs wrap onto two rows of 44 px instead of scrolling in the clamp.
    for (const s of await page.getByTestId('admin-sections').getByRole('link').all()) {
      const b = (await s.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(390 - 16 + 1);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
```

and replace

```ts
  // Users stacks its rows below sm (its own test below); Invites still scrolls inside its card.
  await page.goto('/admin/invites');
  expect(await page.locator('section[aria-label="Invite codes"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
```

with

```ts
  // Users and (C7 Ruling 9) Invites stack their rows below sm: nothing scrolls inside the card.
  await page.goto('/admin/invites');
  expect(await page.locator('section[aria-label="Invite codes"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test --testTimeout=30000 src/components/admin/admin-nav.test.ts` → FAIL.
Run: `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-08|C7-09e"` → FAIL
(`Firmware` sits past 390; the copy buttons are 30 px).

- [ ] **Step 3: Implement**

`src/components/admin/admin-nav.tsx`: the comment on line 22 becomes
`// The clamp scrolls where one row nearly fits; below sm the track wraps onto two rows of 44 px (C7 Ruling 10), so it
// is the clamp's width there rather than w-max.` and line 24's `className="seg w-max"` becomes
`className="seg w-max max-sm:w-full"`.

`src/components/admin/copy-invite-buttons.tsx:38`: the `link` look `h-[30px] rounded-[8px] px-2.5 …` gains
`max-sm:min-h-11`, and the `button` look `h-[38px] rounded-[10px] …` (line 37) gains `max-sm:min-h-11`.

`src/components/admin/revoke-invite-button.tsx:49`: `h-[30px] rounded-[8px] px-2.5 …` gains `max-sm:min-h-11`.

`src/app/(admin)/admin/invites/page.tsx`: after `const DATE = …` (line 20) add:

```tsx
// Below sm each row stacks like Users (C6 Ruling 8 amended; C7 Ruling 9): the code and its pill, then a labelled line
// each for Issued, Expires and Used by, then the actions in a wrapping row. Explicit roles keep it a table.
const LABEL = 'max-sm:before:mr-1.5 max-sm:before:font-sans max-sm:before:text-[12px] max-sm:before:text-(--muted-2) max-sm:before:content-[attr(data-label)]';
```

`DATE` becomes `'px-3.5 py-3 font-mono text-[13px] max-sm:basis-full max-sm:p-0'`, and the table (lines 43-102,
from `{/* 880px: …` through `</div>` before `</section>`) becomes:

```tsx
          {/* From sm, 880px: an eight-character code, a state pill, two ISO dates that must never wrap mid-token, an email
              with its consumed date, and three actions. It scrolls inside the card; the page does not. Below sm the rows
              stack (see LABEL) and nothing scrolls sideways. */}
          <div className="overflow-x-auto">
            <table role="table" className="w-full text-[14px] max-sm:block sm:min-w-[880px]" style={{ color: 'var(--ink)' }}>
              <thead role="rowgroup" className="max-sm:sr-only">
                <tr role="row" className="h-11 border-b text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
                  <th role="columnheader" scope="col" className="px-5 text-left font-medium">Code</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[120px]`}>State</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[150px]`}>Issued</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[150px]`}>Expires</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[220px]`}>Used by</th>
                  <th role="columnheader" scope="col" className="w-[240px] px-3.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody role="rowgroup" className="max-sm:block">
                {invites.length === 0 ? (
                  <tr role="row" data-testid="invites-empty" className="max-sm:block">
                    <td role="cell" colSpan={6} className="px-5 py-4 text-[13px] max-sm:block" style={{ color: 'var(--muted)' }}>
                      No invite codes yet. Issue one to let someone sign up.
                    </td>
                  </tr>
                ) : invites.map((i) => {
                  const look = STATE_LOOK[i.state];
                  return (
                    <tr key={i.code} role="row" data-testid={`invite-${i.code}`}
                        className="border-b max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:px-5 max-sm:py-3"
                        style={{ borderColor: 'var(--hairline)' }}>
                      <td role="cell" className="px-5 py-3 font-mono text-[15px] tracking-[0.1em] max-sm:p-0 max-sm:text-[16px]">{i.code}</td>
                      <td role="cell" className="px-3.5 py-3 max-sm:p-0">
                        <span data-state={i.state} className="rounded-full px-[9px] py-0.5 text-[12px] font-semibold"
                              style={{ background: look.bg, color: look.fg }}>
                          {look.label}
                        </span>
                      </td>
                      <td role="cell" data-label="Issued" className={`${DATE} ${LABEL}`} style={{ color: 'var(--muted)' }}>{i.createdAt.toISOString().slice(0, 10)}</td>
                      <td role="cell" data-label="Expires" className={`${DATE} ${LABEL}`} style={{ color: 'var(--muted)' }}>{i.expiresAt.toISOString().slice(0, 10)}</td>
                      <td role="cell" data-label="Used by" className={`px-3.5 py-3 max-sm:flex max-sm:basis-full max-sm:flex-wrap max-sm:items-baseline max-sm:p-0 ${LABEL}`}
                          data-testid={`invite-used-by-${i.code}`}>
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
                      <td role="cell" className="px-3.5 py-3 max-sm:basis-full max-sm:p-0">
                        {/* Only a live code is revocable; a non-live row's state pill is the word. */}
                        {i.state === 'live' ? (
                          <span className="flex flex-wrap items-center justify-end gap-1 max-sm:justify-start max-sm:gap-2">
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
```

Before the e2e runs, grep the admin-invites specs for selectors the roles or the stacking could change
(`grep -n "getByRole('row')\|getByRole('cell')\|locator('td\|th')" e2e/admin-invites.spec.ts e2e/c6-admin-layout.spec.ts e2e/contrast.spec.ts`):
the explicit roles equal the implicit ones, so they should match as before.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test --testTimeout=30000 src/components/admin/admin-nav.test.ts src/components/admin/copy-invite-buttons.test.ts`
→ PASS; then `pnpm test --testTimeout=30000`, `npx tsc --noEmit`, `pnpm lint` → green; lint unchanged.

e2e, one at a time:
1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile -g "C7-08|C7-09e"` → `2 passed`.
2. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "390|Invites"` → all pass (`--list` first).
3. `PORT=3100 npx playwright test e2e/admin-invites.spec.ts --project=desktop` → `10 passed`.
4. `PORT=3100 npx playwright test e2e/c6-admin-layout.spec.ts --project=desktop -g "admin header carries|Admin sections tabs|Overview|Users|Firmware"` → all pass (`--list` first).
5. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Admin pairs"` → `1 passed`.
6. `PORT=3100 npx playwright test e2e/admin-guard.spec.ts --project=desktop` → `9 passed`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/admin/admin-nav.tsx src/components/admin/admin-nav.test.ts "src/app/(admin)/admin/invites/page.tsx" \
  src/components/admin/copy-invite-buttons.tsx src/components/admin/revoke-invite-button.tsx \
  e2e/c6-admin-layout.spec.ts e2e/c7-phone.mobile.spec.ts
git commit -m "C7: Admin on a phone: the sections wrap onto two rows of 44 px tabs; Invites rows stack with 44 px Copy code, Copy link and Revoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 9: Final pass: contrast at 390, the by-hand phone check, every phone e2e in batches, the README and docs sweep, the lint gate

**Files:**
- Modify: `e2e/contrast.spec.ts` (append one test), `README.md` / `docs/*.md` only if Step 4's grep finds wording
- Create and delete (never committed): `e2e/zz-c7-shots.mobile.spec.ts`

**Interfaces:**
- Consumes: every task's DOM (`nav-more`, `data-tab-bar`, the tiles, the chips); `legible()` and `hydrated()`.
- Produces: nothing later work uses.

- [ ] **Step 1: Write the failing test**

`e2e/contrast.spec.ts` — append:

```ts
// Phase C7 (spec §2.3, Ruling 5): the phone shell's text on real elements at 390 -- the current tab (ink 700) and
// another (--muted-2) on the bar's --nav-scrim, and a More menu item on the popup's surface.
test('the phone shell pairs are legible at 390: the current tab, another tab, a More menu item', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpFresh(page);
  await page.goto('/library');
  await page.mouse.move(0, 0);
  await legible(page, 'phone', [
    ['tab (current)', 'nav[aria-label="Main"] a[aria-current="page"]'],
    ['tab', 'nav[aria-label="Main"] a:not([aria-current]):not(.max-lg\\:hidden)'],
  ]);
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').click();
  await expect(page.getByTestId('nav-more-menu')).toBeVisible();
  await legible(page, 'phone', [['More menu item', '[data-testid="more-help"]']]);
});
```

- [ ] **Step 2: Run it to see it fail or pass**

`PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "phone shell pairs"` → 1 test. If it already
passes, Tasks 1–8 built the looks to the tokens: record the logged ratios in the report.

- [ ] **Step 3: Implement** — only what Step 2 shows is wrong. Expected: nothing. A failed ratio is fixed in the
  component's colour, toward the spec's token, never by lowering 4.5 and never by pointing a selector elsewhere.

- [ ] **Step 4: The gates, the sweep of words, the by-hand check, the regression**

The gates: `pnpm test --testTimeout=30000` (whole), `npx tsc --noEmit`, then `pnpm lint; echo "exit $?"` →
`✖ 12 problems (0 errors, 12 warnings)` and `exit 0`.

The sweep of words (README and docs wording the About move or the shell touched):
`grep -n "About page\|(i)\|/about\b\|the gear\|bottom bar\|top right" README.md docs/*.md`
Expected: no hit that describes today's app wrongly. Reword any hit to "Settings → About this server", "the gear
(More on a phone)" or "the tab bar". Then
`grep -rn "about-link\|AboutLink" --include=*.ts --include=*.tsx . | grep -v node_modules | grep -v "\.next/"` → no hit.

By hand at 390 × 844 on the dev server (3100), in the Playwright mobile project, with screenshots for the operator
saved to the session scratchpad directory only (they must never show an email address or board name):

1. Write `e2e/zz-c7-shots.mobile.spec.ts`. It signs up fresh, pairs one board named `Shot board`, seeds three titles
   and two collections, then for `/library`, `/library` in table view, a title page, its disk files, `/devices`,
   `/ingest`, `/settings`, `/settings#about`, `/help`, the More menu open, the search row open, and (signed in as
   the super-admin) the five admin pages, calls
   `await page.screenshot({ path: '<scratchpad>/c7-shots/<name>.png', fullPage: true, mask: [page.locator('[data-testid="account-email"], [data-testid="admin-email"], [data-testid^="device-name-"], [data-testid="drives-compact"], [data-testid^="drive-entry"], [data-testid="send-board"], [data-testid^="send-board-"], [data-testid="staging-row"], [data-testid^="holder-"], [data-testid$="-drives"], [data-testid^="user-row-"], [data-testid^="invite-used-by-"], [data-testid="attention-row"]')], maskColor: '#F6F2E9' });`
   (`<scratchpad>` is the absolute scratchpad directory of this session).
2. Run it once: `PORT=3100 npx playwright test e2e/zz-c7-shots.mobile.spec.ts --project=mobile`.
3. Open every PNG and confirm by eye that no email address and no board name is readable. If one is, add its
   element to the mask, re-run, and look again. Then compare each shot with spec §2–§11: one 60 px header row, four
   tabs with the amber mark on the current one, chips on one line, wrapped table names, the stacked Devices head,
   the tiles side by side, About as the fourth Settings card, Invites stacked.
4. Delete the file: `rm e2e/zz-c7-shots.mobile.spec.ts`, and confirm `git status --short e2e` does not list it.
   Record in the report what you saw on each page, and give the scratchpad path of the shots.

The regression: every phone spec, plus the desktop specs this phase touched. ONE run at a time, each under 9 minutes,
`--list` first so each file is covered whole:

1. `PORT=3100 npx playwright test e2e/c7-phone.mobile.spec.ts --project=mobile --list` → note the count (22:
   C7-01, 01b, 02, 02b, 02c, 03, 03b, 04, 04b, 04c, 05, 06, 06b, 07, 08, 09a-09e, 10, 11; recount if not). The first
   pattern selects 10 and the second 12.
   Then `-g "C7-0[1-4]"` → all pass; then `-g "C7-0[5-9]|C7-1[01]"` → all pass. If a half runs over about 7 minutes,
   split it again by single `C7-NN` names.
2. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "bottom bar reaches|library grid is two columns|Devices cards are one per row|HFE that cannot|file tree row|table view at 390|touch drag scrolls|Create ADF panel"` → `8 passed`.
3. `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "file toolbar|drop strip|Demozoo review|write-next-card|press-and-hold inside|disk set at 390|card held and dropped|in a collection at 390|Upload page puts"` → `9 passed` (2 and 3 together cover all 17; check with `--list`).
4. `PORT=3100 npx playwright test e2e/help.mobile.spec.ts --project=mobile` → `1 passed`.
5. `PORT=3100 npx playwright test e2e/url-upload.spec.ts e2e/upload-staging.spec.ts e2e/identify-search.spec.ts e2e/nfc-fob-button.spec.ts --project=desktop -g "390"` → all pass.
6. `PORT=3100 npx playwright test e2e/cover-override.spec.ts e2e/disk-files-layout.spec.ts e2e/devices-page.spec.ts --project=desktop -g "phone|390|whole width"` → all pass.
7. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts e2e/c6-admin-layout.spec.ts e2e/drive-chips.spec.ts --project=desktop -g "390"` → all pass.
8. `PORT=3100 npx playwright test e2e/header-overlap.spec.ts e2e/shell.spec.ts e2e/about-page.spec.ts e2e/states.spec.ts --project=desktop` → all pass (5 + 2 + 4 + 5).
9. `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop --list` → note the count (one more than
   before C7, and the sign-in and sign-up loop counts as two). Run it in two slices: `-g "sign-in text|sign-up text|shell and an empty library|library card|admin sans subtitle|toast description|search panel metadata|header focus|Devices pairs"`,
   then `-g "Upload pairs|Disk files pairs|open popover|Settings pairs|Help pairs|Search panel pairs|Sign-in and Create account pairs|Admin pairs|phone shell pairs"`
   → all pass. Check with `--list` that the two slices together cover the count.
10. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop --list`, then the rest of c5-layout (33
    tests) in two halves by `-g` → all pass; the same for `e2e/c6-admin-layout.spec.ts` (24 tests).
11. `PORT=3100 npx playwright test e2e/search.spec.ts e2e/library-table.spec.ts --project=desktop` → `28 passed`.
12. `PORT=3100 npx playwright test e2e/admin-delete.spec.ts e2e/admin-firmware.spec.ts e2e/admin-guard.spec.ts --project=desktop` → all pass.
13. `PORT=3100 npx playwright test e2e/admin-scan.spec.ts --project=desktop -g "sees the scan status page|Demozoo status line|non-admin cannot reach the scan|cron route refuses|import a DAT"` → `5 passed`.
    (Never run admin-scan or tosec-scan whole.)

- [ ] **Step 5: Commit** — re-check `git status --short` (the shots spec must be gone), then:

```bash
git add e2e/contrast.spec.ts
git commit -m "C7: the phone shell's text pairs measured at 390; final phone regression and the lint gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

(Add `README.md` or a `docs/*.md` file to `git add` only if Step 4's sweep changed it. The HANDOFF entry for C7,
which records the About move, is the controller's after the merge, not this task's.)

---

## Self-review (against the spec)

- §0 invariants → Global Constraints. One nav: Task 1 (`top-nav.test.ts` counts `<nav`, `mobile.spec` "only one nav").
  Nothing at `lg`+ changes: every `lg:` value is today's; the 1280 regressions are in each task and in Task 9.
- §1 measurements P1–P16 → P1, P2, P3, P4, P5: Task 1. P6, P7: Task 5. P8: Task 7. P9, P10: Task 6. P11, P12:
  Task 8. P13–P16: Task 4. Handed-on items: the bar to `lg` (Ruling 1, Task 1); `.seg` 40/48 (Task 4); ⋯ and grip
  below `md` (Task 5); `Change second drive` (Task 6); the tiles (Task 7); the Disk files bone (Task 4); the 44 px "?"
  and auth switch (Task 4); the phone scrim (Task 3); the Help hash jump (Task 4); the About page (Task 2); Invites
  30 px buttons and the by-hand phone pass (Tasks 8, 9).
- §2 shell → Task 1 (2.1–2.3, 2.5 unchanged), Task 3 (2.4). §3.1–3.3 → Task 4. §3.4 → Task 1.
- §4 Library → Task 5 (4.1's sizes in Task 4). §5 → Task 1. §6 → Task 6. §7 → Task 7. §8 → Task 4. §9 → Tasks 2, 3,
  4. §10 → Task 2 (10.5's README in Task 2, re-swept in Task 9: plan ruling). §11 → Tasks 1 (11.1 shell) and 8. §12
  states → Task 2 (About bone), 4 (Disk files bone), 5 (chip bone; empty chips = Uncategorized, All titles, + New),
  7 (no-board tile). §13.2 ids → Tasks 1, 2, 3, 5, 6; §13.3 `about-link` removed → Task 2; §13.4 e2e sites →
  `about-page` (2), `shell` (1, 2), `contrast:370` (2), `c5-layout:74-87` (2), `c5-layout:544-560, 667` (3),
  `c6-admin-layout:97-118` (1), `:604-640` (8), `drive-chips:407-445` (1), `header-overlap` (1),
  `mobile.spec:86-108` (1), `:271-291` (5), `:849` (7), `library/loading.test` (5), `settings/loading.test` (2),
  `side-nav.test` (2), `e2e/c7-phone…` (1–8).
- §14's tests → `C7-01` (1), `C7-02`, `02b`, `02c` (1, 2), `C7-03` (3), `C7-04` (5), `C7-05` (6), `C7-06` (7), `C7-07`
  (2), `C7-08` (8), `C7-09a`–`e` (4–8), `C7-10` (1); `C7-11` adds Ruling 26's check. The 640 / 768 / 1000 widths of
  test 1 are `header-overlap`'s tablet sweep (§13.4 puts them there).
- **Plan rulings to relay**: the spec file is `e2e/c7-phone.mobile.spec.ts`, not `c7-phone.spec.ts`, because the
  mobile project runs only `*mobile.spec.ts`. Also: the sign-out failure toast (1); About this server never marked
  current in More (1); Logo stays 24 px (1); the `preferences` help sentence (1); the (i) kept until Task 2 (1);
  About's card outside the Suspense (2); groups on `div`s (2); README in Task 2 and re-swept in Task 9 (2); phone
  Escape and result focus (3); the row drawn by SearchBox (3); the sweep's scope and its fix procedure (4);
  rename and create placed by `useMediaQuery` (5); collection Delete keeps `window.confirm` (5); the meta line's
  Type (5); `second-drive-group-<id>` (6); the section `display: contents` below `sm` and its WebKit risk (7);
  `Pair a board first` (7).
- Type consistency: `isMoreCurrent` / `isMoreItemCurrent` / `moreItems` / `MoreItem` (Task 1) are used only in
  `top-nav.tsx`; `useSignOut` (1) in `top-nav.tsx` and `sign-out-button.tsx`; `AboutCard` / `AboutBone` /
  `AboutGroupsView` / `Settled` / `FirmwareFacts` (2) in `about-server.tsx` and its test; `titleMeta` (5) in
  `game-table.tsx`; `splitHint` (7) in `drop-card.tsx`; `TILE` / `TILE_LOOK` / `INK_LABEL` / `INK_STYLE` (7) in
  `dropzone.tsx` and `send-panel.tsx`; `DropCard`'s new required `tileCol` has both callers updated in Task 7. The
  e2e helpers: `noSideways`, `tabs`, `ADMIN_PAGES` (1); `smallTargets`, `touchSweep` (4); `touchDragTo`,
  `newCollection`, `chipOf` (5); `deviceWithDisk` (6); `sendBoard` (7). Each is defined before its first use, and each
  task updates the file's import lines for exactly what it adds, so no unused import reaches lint.
- Review Focus → 1: Task 2 (`about-page` at 390, `C7-07`). 2: Task 3 (`C7-03b`). 3: Task 7 (`C7-06b`). 4: Task 1
  (`C7-01b`) and the sweeps. 5: Task 5 (`C7-04b`). The other spec candidates are covered or out of scope: a chip
  drop (`C7-04c`), More with the keyboard up (search and More are separate taps; the scrim closes the panel), iOS's
  toolbar (Ruling 28, no `viewport-fit`), DF1 kept open across a save's refresh (`C7-05`), tablet widths
  (`header-overlap`), toast Undo at 1023 (`C7-10` at 900, under `--toast-bottom`), long Invites addresses at 360
  (`C7-09e`'s 360 sweep).
- Placeholder scan: each step names its file, its lines or anchor text, and the code. Two steps carry a decision by
  measurement with a stated rule rather than code. Task 4's sweep may list controls the spec did not name; the fix is
  `max-sm:min-h-11` in that component, never a lower 44. Task 2's redirect falls back to Ruling 22's server
  `redirect()` if the hash is dropped. Neither is open-ended.
