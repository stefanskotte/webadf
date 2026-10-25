# Phase C5 Settings, Help + "?" popover, Search, Sign in & sign up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings, the Help page, the "?" popover, the header search and the two auth pages take the approved
InfSettings / InfHelp / InfSearch / InfSignIn layouts, with every A2 / context-help / A3 / better-auth behaviour,
request, guard and word kept, and one additive change to the search response (four fields per title).

**Architecture:** Presentation and wiring on Phase B's tokens and C1–C4's pieces. Pure rules in new client-safe files
(`src/lib/settings-look.ts`, `src/lib/side-nav.ts`, `src/lib/search-look.ts`, `src/lib/auth-errors.ts`) and in
`src/lib/help/match.ts` / `topics.tsx`. New components: `SegRadioGroup` (`src/components/ui/seg-radio-group.tsx`),
`SideNav` (`src/components/shell/side-nav.tsx`), `HelpBrowser` (`src/components/help/help-browser.tsx`), `AuthSwitch`
and `SignInForm` (under `src/app/(auth)/`), `settings/loading.tsx`. `PageHeader` gains `flush`, `SortSelect` gains
`bare`, `Logo` gains `tone`. One server change: `search()` selects `authored`, `hasHd`, `hasHfe` and reads kinds through
`kindsForGames` (moved out of `withDerived`, not copied). No schema, no migration, no new route, no new package.

**Tech Stack:** Next.js 16.3.2 App Router (before Task 2's `settings/loading.tsx` read
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`; before Task 2's and Task 6's
`metadata` exports read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`; before
Task 6's layout read `.../03-file-conventions/layout.md` and `.../03-file-conventions/page.md`), React 19, Tailwind v4,
Base UI 1.7 (`@base-ui/react/popover`, `@base-ui/react/unstable-use-media-query`), better-auth (client
`signIn.email` / `signUp.email`), vitest (`renderToStaticMarkup` render tests, node environment — no DOM), Playwright
1.62.

**Spec:** `docs/superpowers/specs/2026-10-25-phase-c5-settings-help-search-signin-design.md` (binding; read it whole,
including the 41 Rulings). Where this plan resolves a spec gap it says so in a line starting **Plan ruling**; the
controller relays those to the operator.

## Global Constraints

- Texts, test ids and orders exactly as the spec writes them; every id in spec §9.1 keeps its name and meaning; ids
  move only as §9.4 says. New ids are §9.2's, plus the data attributes this plan names (`data-disk-color`, `data-tile`,
  `data-hero`, `data-skeleton-*`), which are not test ids and carry no state of their own.
- Same requests, bodies and guards (spec §0): `PATCH /api/me/prefs` one field per change through `savePrefs` with the
  `pending` counter and the put-back on failure; `POST /api/me/prefs/firmware-skip-password` `{password}` with its 401 /
  429 / redirect handling; better-auth `changePassword({ revokeOtherSessions: true })`, `revokeOtherSessions`,
  `listSessions`; `DELETE /api/me/account` `{password, confirm: "DELETE"}` then `window.location.assign('/sign-in')`;
  `GET /api/search?q=` with the 150 ms debounce, the abort, the stale-response guard, `TITLE_LIMIT` 8,
  `COLLECTION_LIMIT` 4, `HELP_HIT_LIMIT` 3 and `orgFilter`; `signIn.email` → `router.push('/')`; `signUp.email` with
  `inviteCode` → `router.push('/library')`; the server-read `?invite=` prefill.
- **No DB migration.** If a task believes one is needed, STOP and report: the controller migrates production; a
  subagent never runs `drizzle-kit` or writes under `drizzle/`.
- Colours only through tokens (Phase B §4, C1–C4's, the seven of Task 1) — no `#7A7262` / `#A39B8B` / `#F6F2E9` /
  `#EFE9DD` / `#B5541A` literals in components; `DiskIcon` and `Logo` are the only literal-colour drawings.
- "Show both values of a state": `prefs-state` (three words), `fw-password-state` (`Password asked` / `Password not
  asked`), `sessions-count` (`Signed in on N browsers` / `Signed in on this browser only`), radios (checked fill vs
  track), the "?" (track vs ink), the nav's current item (surface + ring + 600 vs plain) all carry words or a visible
  fill in each value. No `sr-only` element carries a width or layout utility.
- Focus never falls to `<body>` (C3/C4): **Plan ruling** a button that is clicked and then waits (`password-save`,
  `fw-skip-password-confirm`, `account-delete-submit` while busy, the firmware switch while busy, the two auth submits)
  takes `aria-disabled={busy}` and guards its handler, never `disabled={busy}` — Chromium blurs a focused button the
  moment it becomes `disabled`, which drops focus to `<body>` and breaks spec §6.5 ("focus stays on the submit").
  `account-delete-submit` keeps `disabled={!ready}` (it is not focused while not ready).
- Dark filled buttons carry the class `text-white` (globals.css' hover rule keys on it) with an inline
  `color: 'var(--surface)'`, which wins over the class.
- WCAG AA 4.5:1 for every text pair in spec §11, pinned in `src/lib/design-tokens.test.ts` and measured on the page in
  `e2e/contrast.spec.ts`; non-text 3:1 for the focus ring and the switch's off border. Keyboard: every control
  reachable by Tab; radios rove (one tab stop); search options are not tab stops (Ruling 21).
- Nothing scrolls sideways at 390 px (`document.documentElement.scrollWidth <= clientWidth`); the full phone pass is C7.
- In-app dialogs only; never `window.confirm` / `alert`.
- Self-host parity: no new package, no external URL, no font, no our-deployment-only words.
- Firmware, `wifi-floppy/`, the board and the Amiga are not touched.
- Next.js 16.3: read the guide named in Tech Stack in `node_modules/next/dist/docs/` before writing a `loading.tsx`,
  a `metadata` export, a layout or a page; heed deprecation notices.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): real `pnpm install --offline`, `.env.local` present
  (never print it, never `cat` it), `npx next typegen`, the `adf-archive` symlink.
- House rules, every task: stage files by name (never `git add -A`, never anything under `wifi-floppy/` or
  `.superpowers/`); no `git stash` in any form; stop only your own PIDs, never pattern-kill; e2e with `PORT=3100`,
  desktop project unless a step says mobile, ONE run at a time, each command under 9 minutes (split with `-g`, the
  splits below are sized for that), in the foreground (never `run_in_background`); the e2e DB is the live production
  DB shared with other runs, so assert relative to rows you made (fresh sign-ups, `runTag()`), never absolute counts;
  wait for hydration (`hydrated()` in `e2e/device-helpers.ts`) before the first event on a client control;
  `loading.tsx` makes `notFound()` pages HTTP 200 — assert the not-found card, never a 404 status; whole `pnpm test`
  green before each commit; no commit after a red run; every commit message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc` (two trailer lines).
- Unit and static checks: `pnpm test` (vitest), `npx tsc --noEmit`, `pnpm lint`. **Known pre-existing lint errors:**
  `src/app/(admin)/admin/page.tsx:51` and `src/app/(admin)/admin/scan/page.tsx:167` — exactly those two, no new ones.
- **Known e2e flake:** `help.spec.ts` "keyboard: Enter opens the "?", Esc closes it and returns focus" is
  order-dependent; if it fails in a whole-file run, rerun that one test alone once (`-g "Enter opens"`) before
  reporting it.

## Review Focus

1. **A press on a search row must not close the panel under the pointer** (the new blur-closes rule, Ruling 22): the
   panel's `onMouseDown` prevents the input's blur, the click navigates and clears; refocusing the field with a query
   shows the panel again; Tab away closes it. Pinned in Task 5's "panel closes" test.
2. **The last Settings section cannot scroll to the top**, so a scroll-derived "current" would mark Firmware when the
   person clicked Delete account. A click pins the clicked item for 600 ms (`SideNav`'s lock). Pinned in Task 2's
   section-list test.
3. **A failed or slow save must never drop focus to `<body>`** (radios, the firmware switch, password Change, auth
   submits): `aria-disabled` while busy, opener refocus after a form closes, heading focus after Sign out everywhere
   else. Pinned in Task 2's focus test and Task 6's sign-in test.
4. **The Help filter's zero-match case** shows `0 of 17 topics`, the empty line, the four group names with no items,
   no articles — and Escape brings all 17 back; hidden articles are `display:none` (out of the tab order). Pinned in
   Task 3's filter test.
5. **A rate-limited sign-up** (self-host stack, `E2E_SIGNUP_GAP_MS`) now reads `Too many attempts. Wait a minute and
   try again.` (Ruling 34), so `signUpFresh`'s retry detection, which looked for better-auth's `Too many requests`,
   must look for `/Too many/` in the alert; and `docs/self-hosting.md`'s troubleshooting row must quote the new words.
   Pinned in Task 6 (helper edit + doc edit + the error-words unit test).

## Common commands

- Unit: `pnpm test <path>`; all: `pnpm test`; types: `npx tsc --noEmit`; lint: `pnpm lint`.
- e2e desktop: `PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<title part>"]`.
- e2e mobile (only files named `*mobile.spec.ts` run there): `PORT=3100 npx playwright test e2e/<name>.spec.ts
  --project=mobile [-g "<title part>"]`.
- Screenshots: `PORT=3100 pnpm screenshots` (own config, 1440 × 900, own demo account; Task 7 only).
- The `-g` patterns and counts below come from the current titles and the tests this plan adds; before running, check
  with `npx playwright test e2e/<name>.spec.ts --project=desktop --list [-g "<pattern>"]` that the pattern selects
  what the step says. If a count differs, recount with `--list` before calling it a failure.

## File map

| File | Task | What |
|---|---|---|
| `src/lib/settings-look.ts` + `.test.ts` | 1 | `radioAfterKey`, `prefsStateLook`, card / row / field / button classes |
| `src/lib/side-nav.ts` + `.test.ts` | 1 | `currentSection` |
| `src/components/ui/seg-radio-group.tsx` + `.test.ts` | 1 | new `SegRadioGroup` |
| `src/components/shell/side-nav.tsx` + `.test.ts` | 1 | new `SideNav` |
| `src/components/shell/page-header.tsx` + `page-header.test.ts` | 1 | `flush` |
| `src/components/prefs/sort-select.tsx` + `sort-select.test.ts` | 1 | `bare` |
| `src/app/globals.css`, `src/lib/design-tokens.test.ts` | 1 | seven tokens; §11 pairs |
| `src/app/(app)/settings/page.tsx` | 2 | grid, aside, metadata |
| `src/components/prefs/preferences-form.tsx`, `account-security.tsx`, `firmware-password-setting.tsx`, `delete-account.tsx` | 2 | the four cards |
| `src/app/(app)/settings/loading.tsx` + `loading.test.ts` | 2 | skeleton |
| `e2e/c5-layout.spec.ts` | 2–7 | new tests |
| `e2e/account.spec.ts`, `user-settings.spec.ts`, `library-table.spec.ts`, `library-paging.spec.ts` | 2 | §9.4 radio sites |
| `src/lib/help/topics.tsx`, `topics.test.ts`, `match.ts`, `match.test.ts` | 3, 7 | `HELP_GROUPS`, `helpGroupOf`, `filterHelpTopics`; the `preferences` source comment (7) |
| `src/components/help/help-browser.tsx`, `src/app/(app)/help/page.tsx` | 3 | the Help page |
| `src/components/help/help-tip.tsx`, `help-tip.test.ts` | 4 | the "?" and popover |
| `e2e/contrast.spec.ts` | 4, 5, 7 | `legible()` + popover (4), `:263` probe (5), four screens (7) |
| `src/lib/queries.ts`, `src/lib/search.ts` | 5 | `kindsForGames`; four fields |
| `src/lib/search-look.ts` + `.test.ts`, `src/components/shell/search-box.tsx` | 5 | the combobox panel |
| `src/lib/auth-errors.ts` + `.test.ts` | 6 | `authErrorText` |
| `src/components/shell/logo.tsx` + `logo.test.ts` | 6 | `tone="light"` |
| `src/app/(auth)/layout.tsx`, `auth-switch.tsx` + `auth-switch.test.ts`, `auth-look.ts` | 6 | frame, hero, switch |
| `src/app/(auth)/sign-in/page.tsx`, `sign-in/sign-in-form.tsx`, `sign-up/page.tsx`, `sign-up/sign-up-form.tsx` | 6 | forms |
| `e2e/helpers.ts`, `admin-helpers.ts`, `admin-invites.spec.ts`, `invite.spec.ts`, `screenshots.shots.ts` | 6, 7 | button rename; retry detection; new shots (7) |
| `docs/self-hosting.md` | 6 | the rate-limit row's words |
| `docs/screenshots/help.png`, `settings.png`, `sign-in.png` | 7 | regenerated / new |

---

### Task 1: Shared bits — `SegRadioGroup`, `SideNav`, `PageHeader flush`, `SortSelect bare`, the seven tokens (no visible change)

**Files:**
- Create: `src/lib/settings-look.ts`, `src/lib/settings-look.test.ts`, `src/lib/side-nav.ts`, `src/lib/side-nav.test.ts`,
  `src/components/ui/seg-radio-group.tsx`, `src/components/ui/seg-radio-group.test.ts`,
  `src/components/shell/side-nav.tsx`, `src/components/shell/side-nav.test.ts`,
  `src/components/shell/page-header.test.ts`, `src/components/prefs/sort-select.test.ts`
- Modify: `src/components/shell/page-header.tsx` (prop `flush`), `src/components/prefs/sort-select.tsx` (props `bare`,
  `labelledBy`), `src/app/globals.css` (webadf `:root`, after `--on-ink-fill`), `src/lib/design-tokens.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `radioAfterKey<V>(values: readonly V[], current: V, key: string, mods?: { alt?: boolean; ctrl?: boolean; meta?: boolean }) → V | null`
  - `type PrefsSaveState = 'saved' | 'saving' | 'failed'`; `prefsStateLook(s: PrefsSaveState) → { text: string; dot: string; fg: string }`
  - class strings `SETTINGS_CARD`, `SETTINGS_H2`, `SETTINGS_ROW`, `FIELD`, `OUTLINE_BTN`, `INK_BTN`, and style objects
    `CARD_STYLE`, `FIELD_STYLE`, `OUTLINE_STYLE`, `INK_STYLE` (all from `@/lib/settings-look`)
  - `currentSection(ids: readonly string[], visible: ReadonlySet<string> | null, hash: string) → string | null` (`@/lib/side-nav`)
  - `SegRadioGroup<V extends string>(props: { value: V; options: readonly { value: V; label: string }[]; onChange: (v: V) => void; 'aria-labelledby': string; 'aria-describedby'?: string; testId: string; disabled?: boolean })`
  - `type SideNavItem = { href: string; label: string; focusId?: string; tone?: 'danger' }`;
    `type SideNavGroup = { label?: string; testId?: string; items: SideNavItem[] }`;
    `SideNav(props: { label: string; testId: string; groups: SideNavGroup[]; size?: 'md' | 'sm' })`
  - `PageHeader` prop `flush?: boolean`; `SortSelect` props `bare?: boolean`, `labelledBy?: string`
  - tokens `--danger-line`, `--danger-strong`, `--prose`, `--on-ink-2`, `--on-ink-muted`, `--on-ink-accent`, `--search-scrim`

**Plan ruling** (spec §1.2's `top` slot): `SideNav` has no `top` slot. Help's filter must sit outside the phone
`details` that folds the nav (§3.2), so Help places the filter in its own aside above the nav (Task 3); the slot would
have no caller. `SideNav` also takes no sticky classes: each page's aside is the sticky element.

**Plan ruling** (spec §1.2 "An item is a `Link`"): an in-page item (`#prefs`, `#boards`) is a plain `<a href="#…">`
so the browser does the jump the spec describes; a route item (`/about`) is `Link`.

- [ ] **Step 1: Write the failing tests**

`src/lib/settings-look.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { radioAfterKey, prefsStateLook } from '@/lib/settings-look';

const V = ['library', 'devices', 'upload'] as const;

describe('radioAfterKey (C5 spec §1.1)', () => {
  it('arrows move and wrap; Home and End jump', () => {
    expect(radioAfterKey(V, 'library', 'ArrowRight')).toBe('devices');
    expect(radioAfterKey(V, 'library', 'ArrowDown')).toBe('devices');
    expect(radioAfterKey(V, 'upload', 'ArrowRight')).toBe('library');
    expect(radioAfterKey(V, 'library', 'ArrowLeft')).toBe('upload');
    expect(radioAfterKey(V, 'devices', 'ArrowUp')).toBe('library');
    expect(radioAfterKey(V, 'devices', 'Home')).toBe('library');
    expect(radioAfterKey(V, 'devices', 'End')).toBe('upload');
  });
  it('ignores other keys and any key with Alt, Ctrl or Meta', () => {
    expect(radioAfterKey(V, 'library', 'Enter')).toBeNull();
    expect(radioAfterKey(V, 'library', ' ')).toBeNull();
    expect(radioAfterKey(V, 'library', 'ArrowRight', { alt: true })).toBeNull();
    expect(radioAfterKey(V, 'library', 'Home', { ctrl: true })).toBeNull();
    expect(radioAfterKey(V, 'library', 'End', { meta: true })).toBeNull();
  });
  it('a value outside the list starts from the first (forward) or the last (back)', () => {
    expect(radioAfterKey(V, 'nope' as never, 'ArrowRight')).toBe('library');
    expect(radioAfterKey(V, 'nope' as never, 'ArrowLeft')).toBe('upload');
    expect(radioAfterKey([] as string[], 'x', 'ArrowRight')).toBeNull();
  });
});

describe('prefsStateLook (spec §2.2, Ruling 7)', () => {
  it("keeps A2's three words, each with its dot and colour", () => {
    expect(prefsStateLook('saved')).toEqual({ text: 'All changes saved', dot: 'var(--online-dot)', fg: 'var(--success-fg)' });
    expect(prefsStateLook('saving')).toEqual({ text: 'Saving…', dot: 'var(--fetch-dot)', fg: 'var(--muted)' });
    expect(prefsStateLook('failed')).toEqual({ text: "Couldn't save. Try again", dot: 'var(--danger-fg)', fg: 'var(--danger-fg)' });
  });
});
```

`src/lib/side-nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { currentSection } from '@/lib/side-nav';

const IDS = ['prefs', 'account', 'firmware', 'danger'];

describe('currentSection (C5 spec §1.2, Ruling 2)', () => {
  it('before any scroll: the hash target, else the first', () => {
    expect(currentSection(IDS, null, '#firmware')).toBe('firmware');
    expect(currentSection(IDS, null, 'firmware')).toBe('firmware');
    expect(currentSection(IDS, null, '')).toBe('prefs');
    expect(currentSection(IDS, null, '#about')).toBe('prefs');
  });
  it('after a scroll: the topmost section in view, in list order', () => {
    expect(currentSection(IDS, new Set(['danger', 'account']), '#prefs')).toBe('account');
    expect(currentSection(IDS, new Set(['firmware']), '')).toBe('firmware');
  });
  it('nothing in view keeps what was current (null); an empty list has none', () => {
    expect(currentSection(IDS, new Set(), '#danger')).toBeNull();
    expect(currentSection([], null, '#x')).toBeNull();
  });
});
```

`src/components/ui/seg-radio-group.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SegRadioGroup } from './seg-radio-group';

const OPTIONS = [{ value: 'grid', label: 'Grid' }, { value: 'table', label: 'Table' }] as const;
const render = (value: string) => renderToStaticMarkup(createElement(SegRadioGroup<string>, {
  value, options: OPTIONS, onChange: () => {}, 'aria-labelledby': 'lbl', 'aria-describedby': 'hint', testId: 'pref-library-view',
}));

describe('SegRadioGroup (C5 spec §1.1)', () => {
  it('is a labelled .seg--sm radiogroup that names its value', () => {
    const html = render('table');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-labelledby="lbl"');
    expect(html).toContain('aria-describedby="hint"');
    expect(html).toContain('data-testid="pref-library-view"');
    expect(html).toContain('data-value="table"');
    expect(html).toMatch(/class="seg seg--sm flex-wrap"/);
  });
  it('one radio per option, checked by value, the only tab stop on the checked one', () => {
    const html = render('table');
    expect(html.match(/role="radio"/g)?.length).toBe(2);
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="pref-library-view-table"/);
    expect(html).toMatch(/aria-checked="false"[^>]*tabindex="-1"[^>]*data-testid="pref-library-view-grid"/);
    expect(html).toMatch(/tabindex="0"[^>]*data-testid="pref-library-view-table"/);
  });
  it('no checked radio: the first is the tab stop', () => {
    expect(render('nope')).toMatch(/tabindex="0"[^>]*data-testid="pref-library-view-grid"/);
  });
});
```

(The attribute order in the regexes is the order the component writes them in Step 3: `role`, `aria-checked`,
`tabindex`, `disabled`, `data-testid`. If React writes them in another order, fix the regex, not the assertion.)

`src/components/shell/side-nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SideNav } from './side-nav';

const html = renderToStaticMarkup(createElement(SideNav, {
  label: 'Settings sections', testId: 'settings-nav',
  groups: [{ label: 'Your account', testId: 'g-1', items: [
    { href: '#prefs', label: 'Preferences', focusId: 'prefs-heading' },
    { href: '#account', label: 'Sign-in & password' },
    { href: '/about', label: 'About this server' },
    { href: '#danger', label: 'Delete account', tone: 'danger' },
  ] }],
}));

describe('SideNav (C5 spec §1.2)', () => {
  it('is a labelled nav with its group label', () => {
    expect(html).toContain('<nav aria-label="Settings sections" data-testid="settings-nav"');
    expect(html).toContain('data-testid="g-1"');
    expect(html).toContain('>Your account</span>');
  });
  it('marks the first in-page item current on the server (no hash, no scroll yet)', () => {
    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    expect(html).toMatch(/<a href="#prefs" aria-current="true"/);
  });
  it('a route item is a link and never current; danger is red in both values', () => {
    expect(html).toMatch(/<a [^>]*href="\/about"/);
    expect(html).not.toMatch(/href="\/about"[^>]*aria-current/);
    expect(html).toMatch(/href="#danger"[^>]*color:var\(--danger-fg\)/);
  });
  it('names wrap rather than truncate', () => {
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).not.toContain('truncate');
  });
});
```

`src/components/shell/page-header.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageHeader } from './page-header';

describe('PageHeader flush (C5 spec §1.3)', () => {
  it('drops only the outer gutter', () => {
    const flush = renderToStaticMarkup(createElement(PageHeader, { title: 'Settings', eyebrow: 'Your account', size: 'lg', flush: true, help: 'preferences' }));
    const normal = renderToStaticMarkup(createElement(PageHeader, { title: 'Settings', eyebrow: 'Your account', size: 'lg' }));
    expect(normal).toContain('px-4 pb-5 pt-6 sm:px-7');
    expect(flush).not.toContain('pt-6');
    expect(flush).not.toContain('sm:px-7');
    expect(flush).toContain('tabindex="-1"');
    expect(flush).toContain('data-testid="help-tip-preferences"');
    expect(flush).toContain('sm:text-[44px]');
  });
});
```

`src/components/prefs/sort-select.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SortSelect } from './sort-select';
import { BROWSE_SORT_OPTIONS, DEFAULT_PREFS } from '@/lib/user-prefs-schema';

describe('SortSelect bare (C5 spec §1.4)', () => {
  const html = renderToStaticMarkup(createElement(SortSelect, {
    bare: true, labelledBy: 'lbl', describedBy: 'hint', options: BROWSE_SORT_OPTIONS, value: DEFAULT_PREFS.browse.sort,
    onChange: () => {}, testId: 'pref-browse-sort',
  }));
  it('renders only the select, labelled and described by the caller', () => {
    expect(html.startsWith('<select')).toBe(true);
    expect(html).not.toContain('<label');
    expect(html).toContain('aria-labelledby="lbl"');
    expect(html).toContain('aria-describedby="hint"');
    expect(html).toContain('data-testid="pref-browse-sort"');
  });
  it("takes the board's 36 px look, full width below sm", () => {
    expect(html).toContain('h-9 w-full min-w-[180px] rounded-[10px]');
    expect(html).toContain('sm:w-auto');
  });
});
```

`src/lib/design-tokens.test.ts` — add to the value table (after `['--on-ink-fill', '#3E3B36']`):

```ts
    ['--danger-line', '#F2C9BF'], ['--danger-strong', '#9A2A1C'], ['--prose', '#3E392F'], ['--on-ink-2', '#E8E1D2'],
    ['--on-ink-muted', '#A39B8B'], ['--on-ink-accent', '#EE8A2A'],
```

add to `pairs` (after the Disk files block):

```ts
    // Settings / Help / Search / Sign in spec §11
    ['--ink', '--surface-2'], ['--muted', '--ground'], ['--muted', '--surface-2'], ['--muted-2', '--surface'],
    ['--muted-2', '--ground'], ['--success-fg', '--surface'], ['--danger-fg', '--ground'], ['--danger-fg', '--track'],
    ['--danger-strong', '--surface'], ['--danger-strong', '--danger-bg'], ['--prose', '--surface'],
    ['--on-ink-2', '--ink'], ['--on-ink-accent', '--ink'], ['--on-ink-muted', '--ink'],
```

and, after the `--ring` test:

```ts
  // The switch's off track border is the non-text indicator of "off" (C5 spec §11): 3:1 on the card.
  it('--muted-2 (the switch\'s off border) clears 3:1 on --surface', () => {
    expect(ratio(tok('--muted-2'), tok('--surface'))).toBeGreaterThanOrEqual(3);
  });
  it('--search-scrim is the 12 % ink scrim (C5 spec §1.5)', () => {
    expect(css).toMatch(/--search-scrim:\s*rgb\(36 33 27 \/ 0\.12\)/);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/lib/settings-look.test.ts src/lib/side-nav.test.ts src/components/ui/seg-radio-group.test.ts src/components/shell/side-nav.test.ts src/components/shell/page-header.test.ts src/components/prefs/sort-select.test.ts src/lib/design-tokens.test.ts`
Expected: FAIL — `Cannot find module '@/lib/settings-look'` (and `side-nav`, `seg-radio-group`, `./side-nav`);
page-header: `expected '…' not to contain 'pt-6'`; sort-select: `expected false to be true` (it starts with `<span`);
design-tokens: `--danger-line is not set as a #rrggbb hex in globals.css` and the `--search-scrim` match.

- [ ] **Step 3: Implement**

`src/lib/settings-look.ts`:

```ts
// Settings' look rules (Phase C5 spec §1.1, §2): pure and client-safe.

export type RadioMods = { alt?: boolean; ctrl?: boolean; meta?: boolean };

/**
 * The radio a key moves to in a roving radiogroup (spec §1.1): Right/Down next, Left/Up previous (wrapping), Home/End
 * first/last. Null for any other key, and for any key held with Alt, Ctrl or Meta (those belong to the browser).
 */
export function radioAfterKey<V>(values: readonly V[], current: V, key: string, mods: RadioMods = {}): V | null {
  if (mods.alt || mods.ctrl || mods.meta || values.length === 0) return null;
  if (key === 'Home') return values[0];
  if (key === 'End') return values[values.length - 1];
  const dir = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (!dir) return null;
  const at = values.indexOf(current);
  if (at < 0) return values[dir > 0 ? 0 : values.length - 1];
  return values[(at + dir + values.length) % values.length];
}

export type PrefsSaveState = 'saved' | 'saving' | 'failed';

/** The Preferences save line (Ruling 7): A2's words, the board's dot. */
export function prefsStateLook(s: PrefsSaveState): { text: string; dot: string; fg: string } {
  if (s === 'saving') return { text: 'Saving…', dot: 'var(--fetch-dot)', fg: 'var(--muted)' };
  if (s === 'failed') return { text: "Couldn't save. Try again", dot: 'var(--danger-fg)', fg: 'var(--danger-fg)' };
  return { text: 'All changes saved', dot: 'var(--online-dot)', fg: 'var(--success-fg)' };
}

/** A Settings card (spec §2.1): surface, a 1px line ring, 20px corners; clear of the top when it is the hash target. */
export const SETTINGS_CARD = 'scroll-mt-6 rounded-[20px] p-5 sm:p-6';
export const CARD_STYLE = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' } as const;
/** Every card's h2: a programmatic focus target (the section list, Sign out everywhere else) with a visible ring. */
export const SETTINGS_H2 =
  'rounded-[6px] text-[17px] font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)';
/** Words left, control right from sm; stacked (words, then control) below it. */
export const SETTINGS_ROW = 'grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-5';
export const FIELD =
  'h-10 w-full rounded-[10px] border px-3 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const FIELD_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
export const OUTLINE_BTN =
  'h-9 shrink-0 justify-self-start rounded-[9px] border px-3 text-[13px] font-medium disabled:opacity-60 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const OUTLINE_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
/** `text-white` is the hover rule's key for dark buttons (globals.css); the inline colour wins over it. */
export const INK_BTN =
  'h-9 rounded-[9px] px-3.5 text-[13px] font-semibold text-white disabled:opacity-60 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const INK_STYLE = { background: 'var(--ink)', color: 'var(--surface)' } as const;
```

`src/lib/side-nav.ts`:

```ts
/**
 * The section a side list marks current (C5 spec §1.2, Ruling 2). Before any scroll (`visible` null): the hash
 * target if it is one of `ids`, else the first. After: the topmost section in view, in list order; null when none is
 * in view, so the caller keeps what it had.
 */
export function currentSection(ids: readonly string[], visible: ReadonlySet<string> | null, hash: string): string | null {
  if (ids.length === 0) return null;
  if (visible === null) {
    const target = hash.replace(/^#/, '');
    return ids.includes(target) ? target : ids[0];
  }
  return ids.find((id) => visible.has(id)) ?? null;
}
```

`src/components/ui/seg-radio-group.tsx`:

```tsx
'use client';

import { useRef, type KeyboardEvent } from 'react';
import { radioAfterKey } from '@/lib/settings-look';

/**
 * The C2/C3 roving radiogroup as one component (C5 spec §1.1, Ruling 4), used by Settings' three Preferences rows.
 * One tab stop (the checked radio, else the first); the arrows, Home and End move focus AND select, as a radiogroup
 * does, so each step calls onChange. A key with Alt, Ctrl or Meta is left to the browser.
 */
export function SegRadioGroup<V extends string>({
  value, options, onChange, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, testId, disabled = false,
}: {
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  'aria-labelledby': string;
  'aria-describedby'?: string;
  testId: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const values = options.map((o) => o.value);
  const stop = values.includes(value) ? value : values[0];

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = radioAfterKey(values, value, e.key, { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    if (next === null) return;
    e.preventDefault();
    if (disabled) return;
    ref.current?.querySelector<HTMLElement>(`[data-testid="${testId}-${next}"]`)?.focus();
    if (next !== value) onChange(next);
  }

  return (
    <div ref={ref} role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}
         data-testid={testId} data-value={value} onKeyDown={onKeyDown} className="seg seg--sm flex-wrap">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value}
                tabIndex={o.value === stop ? 0 : -1} disabled={disabled} data-testid={`${testId}-${o.value}`}
                onClick={() => { if (o.value !== value) onChange(o.value); }}
                className="seg-item whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) disabled:opacity-60">
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

`src/components/shell/side-nav.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from '@/components/shell/link';
import { currentSection } from '@/lib/side-nav';

export type SideNavItem = { href: string; label: string; focusId?: string; tone?: 'danger' };
export type SideNavGroup = { label?: string; testId?: string; items: SideNavItem[] };

const ITEM =
  'flex w-full items-center px-3 text-left text-[14px] hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
/** After a click the browser's jump fires scroll events; they must not re-mark the section (the last card cannot reach the top). */
const CLICK_LOCK_MS = 600;

/**
 * The section list Settings and Help have on their boards (C5 spec §1.2). "Current" is the section in view: an
 * IntersectionObserver over the in-page targets marks the topmost one in the top 40 % of the viewport; before any
 * scroll, the hash target, else the first. A route item (`/about`) is never current. A click lets the browser jump,
 * then focuses the target's heading so the keyboard continues from there.
 */
export function SideNav({ label, testId, groups, size = 'md' }: {
  label: string; testId: string; groups: SideNavGroup[]; size?: 'md' | 'sm';
}) {
  const ids = groups.flatMap((g) => g.items).filter((i) => i.href.startsWith('#')).map((i) => i.href.slice(1));
  const key = ids.join(' ');
  const [current, setCurrent] = useState<string | null>(null);
  const lockUntil = useRef(0);

  useEffect(() => {
    const list = key ? key.split(' ') : [];
    if (list.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    let scrolled = false;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      if (performance.now() < lockUntil.current) return;
      const next = currentSection(list, scrolled ? visible : null, window.location.hash);
      if (next) setCurrent(next);
    }, { rootMargin: '0px 0px -60% 0px' });
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    const onScroll = () => { scrolled = true; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { io.disconnect(); window.removeEventListener('scroll', onScroll); };
  }, [key]);

  const shown = current ?? ids[0] ?? null;
  const height = size === 'sm' ? 'min-h-[34px] rounded-[9px] py-1.5' : 'min-h-[38px] rounded-[10px] py-2';

  return (
    <nav aria-label={label} data-testid={testId} className="flex flex-col gap-0.5">
      {groups.map((g, gi) => (
        <div key={g.label ?? gi} data-testid={g.testId} className="flex flex-col gap-0.5">
          {g.label && (
            <span className="px-3 pb-1 pt-2.5 text-[12px] font-medium" style={{ color: 'var(--muted-2)' }}>{g.label}</span>
          )}
          {g.items.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => {
                const inPage = it.href.startsWith('#');
                const isCurrent = inPage && it.href.slice(1) === shown;
                const style = {
                  background: isCurrent ? 'var(--surface)' : undefined,
                  boxShadow: isCurrent ? '0 0 0 1px var(--line)' : undefined,
                  color: it.tone === 'danger' ? 'var(--danger-fg)'
                    : isCurrent || size === 'sm' ? 'var(--ink)' : 'var(--muted)',
                  overflowWrap: 'anywhere' as const,
                };
                const cls = `${ITEM} ${height} ${isCurrent ? 'font-semibold' : 'font-medium'}`;
                return (
                  <li key={it.href}>
                    {inPage ? (
                      <a href={it.href} aria-current={isCurrent ? 'true' : undefined} className={cls} style={style}
                         onClick={() => {
                           const id = it.href.slice(1);
                           lockUntil.current = performance.now() + CLICK_LOCK_MS;
                           setCurrent(id);
                           requestAnimationFrame(() =>
                             document.getElementById(it.focusId ?? id)?.focus({ preventScroll: true }));
                         }}>
                        {it.label}
                      </a>
                    ) : (
                      <Link href={it.href} className={cls} style={style}>{it.label}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}
```

`src/components/shell/page-header.tsx`: add `flush = false,` to the destructured props, the prop type
`/** Drops the outer gutter: the page's own column supplies it (Settings, Help; C5 spec §1.3). */ flush?: boolean;`,
and change the root `div`'s `className` to:

```tsx
    <div className={`flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-0 ${flush ? '' : 'px-4 pb-5 pt-6 sm:px-7'}`}>
```

`src/components/prefs/sort-select.tsx`: add to the props `bare = false, labelledBy,` and to the type
`/** Only the select: the caller labels it (Settings' rows, C5 spec §1.4). */ bare?: boolean; labelledBy?: string;`.
Before the existing `return`, add:

```tsx
  if (bare) {
    return (
      <select
        data-testid={testId}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        value={sortOptionId(value)}
        disabled={disabled}
        onChange={(e) => {
          const next = sortFromOptionId(options, e.target.value);
          if (next) onChange(next);
        }}
        className="h-9 w-full min-w-[180px] rounded-[10px] border px-3 text-[13px] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) sm:w-auto"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
      >
        {options.map((o) => (
          <option key={sortOptionId(o.sort)} value={sortOptionId(o.sort)}>{o.label}</option>
        ))}
      </select>
    );
  }
```

(`useId()` stays called above it unconditionally — hooks before the early return.)

`src/app/globals.css`, in the webadf `:root` after `--on-ink-fill`:

```css
  --danger-line:   #F2C9BF;   /* the Delete account card's ring and its button's border; decoration (C5 spec §1.5) */
  --danger-strong: #9A2A1C;   /* the Delete account h2, the sign-in error: 7.59 surface / 6.17 danger-bg */
  --prose:         #3E392F;   /* help article body text: 11.28 surface */
  --on-ink-2:      #E8E1D2;   /* the "?" popover's text, the sign-in hero's sub line: 12.33 on ink */
  --on-ink-muted:  #A39B8B;   /* the sign-in hero's footer line: 5.82 on ink */
  --on-ink-accent: #EE8A2A;   /* the popover's link: 6.35 on ink */
  --search-scrim:  rgb(36 33 27 / 0.12);   /* the light scrim under the open search panel; decoration */
```

- [ ] **Step 4: Run the tests to see them pass**

Run: the Step 2 command → PASS. Then `npx tsc --noEmit` (no errors), `pnpm lint` (only the two known errors),
`pnpm test` (all green).

No e2e in this task: nothing on any page changes yet (`flush`, `bare` and the new components have no caller).

- [ ] **Step 5: Commit** — the ten created and four modified files above by name, message
  `C5: shared bits — SegRadioGroup, SideNav, PageHeader flush, SortSelect bare, seven tokens` plus the two trailer
  lines.

---

### Task 2: Settings — the grid, the section list, the four cards, the focus rules, the skeleton

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`, `src/components/prefs/preferences-form.tsx`,
  `src/components/prefs/account-security.tsx`, `src/components/prefs/firmware-password-setting.tsx`,
  `src/components/prefs/delete-account.tsx`
- Create: `src/app/(app)/settings/loading.tsx`, `src/app/(app)/settings/loading.test.ts`, `e2e/c5-layout.spec.ts`
- Modify (spec §9.4): `e2e/account.spec.ts:30,33,41,43`, `e2e/user-settings.spec.ts:42,55,67`,
  `e2e/library-table.spec.ts:274`, `e2e/library-paging.spec.ts:114,115`

**Interfaces:**
- Consumes (Task 1): `SegRadioGroup`, `SideNav` / `SideNavGroup`, `PageHeader flush`, `SortSelect bare`,
  `prefsStateLook`, `SETTINGS_CARD`, `CARD_STYLE`, `SETTINGS_H2`, `SETTINGS_ROW`, `FIELD`, `FIELD_STYLE`, `OUTLINE_BTN`,
  `OUTLINE_STYLE`, `INK_BTN`, `INK_STYLE`, tokens `--danger-line`, `--danger-strong`.
- Produces: section ids `prefs`, `account`, `firmware`, `danger`; heading ids `prefs-heading`, `account-heading`,
  `firmware-heading`, `danger-heading`; test ids `settings-nav`, `settings-skeleton`, `pref-<row>-<value>`;
  `e2e/c5-layout.spec.ts` with its header (imports, `afterAll`, `prefsSaved`) for Tasks 3–7 to append to (Task 5 adds
  `sha`).

**Plan ruling** (spec §2.7 "inside `PageSkeleton`"): the skeleton does NOT use `PageSkeleton`. `PageSkeleton` always
renders `HeaderSkeleton` (an outer-gutter eyebrow + title + subtitle), but Settings' heading sits inside the main
column beside the aside (`flush`), so the header bones would appear twice and the page would jump on landing — the
defect C4 fixed the same way (`disks/[id]/files/loading.tsx`). It uses the same `role="status"` wrapper and
`Loading…` text instead.

**Plan ruling** (spec §2.6): a successful firmware turn-on (the confirm form unmounts) returns focus to the switch,
like Cancel does; the spec names only Cancel/Escape, and without this focus falls to `<body>`.

- [ ] **Step 1: Write the failing tests**

`src/app/(app)/settings/loading.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsLoading from './loading';

describe('SettingsLoading (C5 spec §2.7)', () => {
  const html = renderToStaticMarkup(createElement(SettingsLoading));
  it('is the settings-skeleton status', () => {
    expect(html).toContain('data-testid="settings-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading…');
  });
  it("is the page's grid: five nav bones from lg, a heading, four cards, the first with four rows", () => {
    expect(html).toContain('lg:grid-cols-[240px_minmax(0,860px)]');
    expect(html.match(/data-skeleton-nav/g)?.length).toBe(5);
    expect(html.match(/data-skeleton-card/g)?.length).toBe(4);
    expect(html.match(/data-skeleton-row/g)?.length).toBe(4);
    expect(html).toContain('h-[30px]');
    expect(html).toContain('sm:h-[44px]');
  });
  it('has no outer page-header bones (the heading is in the main column)', () => {
    expect(html).not.toContain('sm:h-[34px]');
    expect(html.match(/pt-6/g)?.length).toBe(1);
  });
});
```

`e2e/c5-layout.spec.ts` (new):

```ts
import { test, expect, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, hydrated } from './device-helpers';

/**
 * Phase C5: Settings, Help + the "?" popover, the header search, Sign in & Create account in the InfSettings /
 * InfHelp / InfSearch / InfSignIn layouts (spec 2026-10-25-phase-c5-settings-help-search-signin-design.md). Every
 * test signs up fresh (or stays signed out) and asserts only on rows it made: the e2e DB is the shared live one.
 */
test.describe.configure({ timeout: 90_000 });
test.afterAll(async () => { await cleanupSeeded(); });

const prefsSaved = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH');

// ---- Settings (spec §2) ---------------------------------------------------------------------------------------

test('Settings: a preference radiogroup moves and saves with the arrows, Home and End, and ignores a modified key', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const group = page.getByTestId('pref-library-page-size');
  await hydrated(page, 'pref-library-page-size', 'onKeyDown');
  await expect(group).toHaveAttribute('data-value', '48');
  await expect(page.getByTestId('pref-library-page-size-48')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('pref-library-page-size-24')).toHaveAttribute('tabindex', '-1');

  await page.getByTestId('pref-library-page-size-48').focus();
  await Promise.all([prefsSaved(page), page.keyboard.press('ArrowRight')]);
  await expect(group).toHaveAttribute('data-value', '96');
  await expect(page.getByTestId('pref-library-page-size-96')).toBeFocused();
  await expect(page.getByTestId('pref-library-page-size-96')).toHaveAttribute('aria-checked', 'true');
  await Promise.all([prefsSaved(page), page.keyboard.press('End')]);
  await expect(group).toHaveAttribute('data-value', 'all');
  await Promise.all([prefsSaved(page), page.keyboard.press('ArrowRight')]);   // wraps to the first
  await expect(group).toHaveAttribute('data-value', '24');
  await page.keyboard.press('Alt+ArrowRight');                               // left to the browser
  await expect(group).toHaveAttribute('data-value', '24');
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  expect((await (await page.request.get('/api/me/prefs')).json()).library.pageSize).toBe(24);
});

test('Settings: the firmware setting is a switch with words in both values; Escape closes its form and returns focus', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const sw = page.getByRole('switch', { name: "Don't ask for my password when updating board firmware" });
  await expect(sw).toHaveAttribute('data-testid', 'fw-skip-password');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('fw-password-state')).toHaveText('Password asked');
  await hydrated(page, 'fw-skip-password');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('fw-skip-password-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('fw-skip-password-input')).toHaveCount(0);
  await expect(sw).toBeFocused();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('fw-password-state')).toHaveText('Password asked');
});

test('Settings: the section list marks the section in view, and a click moves focus to its heading', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/settings');
  const nav = page.getByTestId('settings-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Preferences' })).toHaveAttribute('aria-current', 'true');
  const about = nav.getByRole('link', { name: 'About this server' });
  await expect(about).toHaveAttribute('href', '/about');
  // The nav and the radios hydrate in the same pass (no Suspense boundary between them).
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  const danger = nav.getByRole('link', { name: 'Delete account' });
  await danger.click();
  await expect(page).toHaveURL(/#danger$/);
  await expect(page.locator('#danger-heading')).toBeFocused();
  // The last card cannot scroll to the top; the click still marks it, and nothing else.
  await expect(danger).toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(800);   // past SideNav's 600 ms click lock: a scroll-derived mark would land by now
  await expect(danger).toHaveAttribute('aria-current', 'true');
  await expect(nav.getByRole('link', { name: 'Preferences' })).not.toHaveAttribute('aria-current', 'true');
  await expect(about).not.toHaveAttribute('aria-current', 'true');
});

test('Settings: closing a form hands focus back to its opener; Sign out everywhere else hands it to the heading', async ({ page, browser }) => {
  const { email, password } = await signUpFresh(page);
  // A second browser, so Sign out everywhere else shows.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto('/sign-in');
  await p2.getByLabel('Email').fill(email);
  await p2.getByLabel('Password').fill(password);
  await p2.getByRole('button', { name: 'Sign in' }).click();
  await expect(p2).toHaveURL(/\/library/);

  await page.goto('/settings');
  await hydrated(page, 'password-change-open');
  await page.getByTestId('password-change-open').click();
  await expect(page.getByTestId('password-current')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('password-form')).toHaveCount(0);
  await expect(page.getByTestId('password-change-open')).toBeFocused();

  await page.getByTestId('account-delete-open').click();
  await expect(page.getByTestId('account-delete-password')).toBeFocused();
  await page.getByTestId('delete-account').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('account-delete-open')).toBeFocused();

  await expect(page.getByTestId('sessions-count')).toHaveText('Signed in on 2 browsers');
  await page.getByTestId('sessions-revoke').click();
  await expect(page.getByTestId('sessions-count')).toHaveText('Signed in on this browser only');
  await expect(page.locator('#account-heading')).toBeFocused();
  await other.close();
});
```

The §9.4 sites (Ruling 4). In each file add `hydrated` to the `./device-helpers` import (`user-settings.spec.ts`
already imports `cleanupSeeded` from it; `library-paging.spec.ts` imports `seedDisk, cleanupSeeded`;
`library-table.spec.ts` imports `cleanupSeeded, seedDisk, …`; `account.spec.ts` imports `seedDisk, pairDevice,
authHeader, cleanupSeeded`), and:

- `e2e/account.spec.ts:30` → `await hydrated(page, 'pref-library-view-table');` then
  `await Promise.all([prefsSaved(page), page.getByTestId('pref-library-view-table').click()]);`
- `e2e/account.spec.ts:33` → `await expect(page.getByTestId('pref-library-view')).toHaveAttribute('data-value', 'table');`
- `e2e/account.spec.ts:41` → `await hydrated(page, 'pref-library-view-table');` then
  `await page.getByTestId('pref-library-view-table').click();`
- `e2e/account.spec.ts:43` → `await expect(page.getByTestId('pref-library-view')).toHaveAttribute('data-value', 'grid');`
- `e2e/user-settings.spec.ts:42`, `:55`, `:67` → before each, `await hydrated(page, 'pref-start-page-devices');`
  (`-upload` at :55), and in the `Promise.all` replace `page.getByTestId('pref-start-page').selectOption('devices')`
  with `page.getByTestId('pref-start-page-devices').click()` (`:55`: `pref-start-page-upload`; `:67`:
  `pref-start-page-devices`).
- `e2e/library-table.spec.ts:274` → `await hydrated(page, 'pref-library-view-table');` before it, and
  `page.getByTestId('pref-library-view').selectOption('table')` → `page.getByTestId('pref-library-view-table').click()`.
- `e2e/library-paging.spec.ts:114` → `await expect(page.getByTestId('pref-library-page-size')).toHaveAttribute('data-value', '24');`
- `e2e/library-paging.spec.ts:115` → `await hydrated(page, 'pref-library-page-size-all');` before it, and
  `page.getByTestId('pref-library-page-size').selectOption('all')` → `page.getByTestId('pref-library-page-size-all').click()`.

Then: `grep -n "selectOption" e2e/account.spec.ts e2e/user-settings.spec.ts e2e/library-table.spec.ts e2e/library-paging.spec.ts | grep -E "pref-(start-page|library-view|library-page-size)"`
Expected: no output.

- [ ] **Step 2: Run them to see them fail**

- `pnpm test "src/app/(app)/settings/loading.test.ts"` → FAIL (`Failed to resolve import "./loading"`).
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Settings"` → 4 failed (no
  `pref-library-page-size` radiogroup / no `switch` role / no `settings-nav` / focus not returned).

- [ ] **Step 3: Implement**

`src/app/(app)/settings/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { requireOrg } from '@/lib/session';
import { auth } from '@/lib/auth';
import { getUserPrefs } from '@/lib/user-prefs';
import { PageHeader } from '@/components/shell/page-header';
import { SideNav, type SideNavGroup } from '@/components/shell/side-nav';
import { PreferencesForm } from '@/components/prefs/preferences-form';
import { FirmwarePasswordSetting } from '@/components/prefs/firmware-password-setting';
import { AccountSecurity } from '@/components/prefs/account-security';
import { DeleteAccount } from '@/components/prefs/delete-account';

export const metadata = { title: 'Settings' };

// The board's section list (C5 spec §2.1, Ruling 2): in-page anchors, About this server as a route.
const SECTIONS: SideNavGroup[] = [{
  label: 'Your account',
  items: [
    { href: '#prefs', label: 'Preferences', focusId: 'prefs-heading' },
    { href: '#account', label: 'Sign-in & password', focusId: 'account-heading' },
    { href: '#firmware', label: 'Firmware updates', focusId: 'firmware-heading' },
    { href: '/about', label: 'About this server' },
    { href: '#danger', label: 'Delete account', focusId: 'danger-heading', tone: 'danger' },
  ],
}];

/**
 * The person's own settings (A2; layout C5, board InfSettings): Preferences, Sign-in & password, Firmware updates,
 * Delete account. All of it belongs to the signed-in user -- not the org, not a board -- and follows them to any
 * browser. From lg a sticky section list sits beside the cards; below lg the cards stand alone.
 */
export default async function SettingsPage() {
  const { userId, email } = await requireOrg();
  const [prefs, sessions] = await Promise.all([
    getUserPrefs(userId),
    auth.api.listSessions({ headers: await headers() }),
  ]);
  return (
    <div className="px-4 pb-10 pt-6 sm:px-7 lg:grid lg:grid-cols-[240px_minmax(0,860px)] lg:items-start lg:gap-8">
      <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
        <SideNav label="Settings sections" testId="settings-nav" groups={SECTIONS} />
      </aside>
      <div className="flex min-w-0 flex-col gap-5">
        <PageHeader flush size="lg" eyebrow="Your account" title="Settings" help="preferences" />
        <PreferencesForm prefs={prefs} />
        <AccountSecurity email={email} sessionCount={sessions.length} />
        <FirmwarePasswordSetting skipPassword={prefs.firmware.skipPassword} />
        <DeleteAccount />
      </div>
    </div>
  );
}
```

`src/components/prefs/preferences-form.tsx` — keep lines 1–55 (imports, the doc comment, state, `pending`, `change`)
with these edits: replace the `SortSelect` import line with
`import { SortSelect } from '@/components/prefs/sort-select';` plus
`import { SegRadioGroup } from '@/components/ui/seg-radio-group';` and
`import { CARD_STYLE, SETTINGS_CARD, SETTINGS_H2, SETTINGS_ROW, prefsStateLook } from '@/lib/settings-look';`;
replace the seven `useId()` lines with:

```tsx
  const startLabel = useId(); const startHint = useId();
  const viewLabel = useId(); const viewHint = useId();
  const sizeLabel = useId(); const sizeHint = useId();
  const libLabel = useId(); const libHint = useId();
  const browseLabel = useId(); const browseHint = useId();
```

and replace the `return (…)` (lines 56–127) with:

```tsx
  const look = prefsStateLook(state);
  return (
    <section id="prefs" aria-labelledby="prefs-heading" data-testid="preferences" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="prefs-heading" tabIndex={-1} className={SETTINGS_H2} style={{ color: 'var(--ink)' }}>Preferences</h2>
        <span data-testid="prefs-state" role="status" aria-live="polite" className="flex items-center gap-1.5 text-[12px]"
              style={{ color: look.fg }}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: look.dot }} />
          {look.text}
        </span>
      </div>
      <p className="mb-2 mt-1 text-[13px]" style={{ color: 'var(--muted-2)' }}>
        Yours alone, on every browser you sign in from. Others in your organization keep their own.
      </p>
      <PrefRow labelId={startLabel} hintId={startHint} label="Start page"
               hint="Where you land after signing in, and when you open the site's address.">
        <SegRadioGroup testId="pref-start-page" aria-labelledby={startLabel} aria-describedby={startHint}
                       value={draft.startPage} options={START_PAGES.map((p) => ({ value: p, label: START_PAGE_LABELS[p] }))}
                       onChange={(startPage: StartPage) => void change({ ...draft, startPage })} />
      </PrefRow>
      <PrefRow labelId={viewLabel} hintId={viewHint} label="Library opens in"
               hint="How the library first shows. The grid and table buttons on the library switch views without changing this.">
        <SegRadioGroup testId="pref-library-view" aria-labelledby={viewLabel} aria-describedby={viewHint}
                       value={draft.library.view} options={LIBRARY_VIEWS.map((v) => ({ value: v, label: LIBRARY_VIEW_LABELS[v] }))}
                       onChange={(view: LibraryViewMode) => void change({ ...draft, library: { ...draft.library, view } })} />
      </PrefRow>
      <PrefRow labelId={sizeLabel} hintId={sizeHint} label="Titles per page"
               hint="In the grid and the table alike. The pager under the library changes it too.">
        <SegRadioGroup testId="pref-library-page-size" aria-labelledby={sizeLabel} aria-describedby={sizeHint}
                       value={String(draft.library.pageSize)}
                       options={LIBRARY_PAGE_SIZES.map((s) => ({ value: String(s), label: pageSizeLabel(s) }))}
                       onChange={(v) => {
                         const pageSize = LIBRARY_PAGE_SIZES.find((s) => String(s) === v);
                         if (pageSize !== undefined) void change({ ...draft, library: { ...draft.library, pageSize } });
                       }} />
      </PrefRow>
      <PrefRow labelId={libLabel} hintId={libHint} label="Library order"
               hint="The library and Uncategorized. A collection keeps its own order.">
        <SortSelect bare labelledBy={libLabel} describedBy={libHint} options={LIBRARY_SORT_OPTIONS} value={draft.library.sort}
                    onChange={(sort) => void change({ ...draft, library: { ...draft.library, sort } })}
                    testId="pref-library-sort" />
      </PrefRow>
      <PrefRow labelId={browseLabel} hintId={browseHint} label="Disk file list order" hint="Folders always come first.">
        <SortSelect bare labelledBy={browseLabel} describedBy={browseHint} options={BROWSE_SORT_OPTIONS} value={draft.browse.sort}
                    onChange={(sort) => void change({ ...draft, browse: { ...draft.browse, sort } })}
                    testId="pref-browse-sort" />
      </PrefRow>
    </section>
  );
}

/** One Preferences row (spec §2.2): the label and hint on the left, the control on the right; stacked below sm. */
function PrefRow({ labelId, hintId, label, hint, children }: {
  labelId: string; hintId: string; label: string; hint: string; children: React.ReactNode;
}) {
  return (
    <div className={`${SETTINGS_ROW} border-t py-3.5`} style={{ borderColor: 'var(--hairline)' }}>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span id={labelId} className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{label}</span>
        <span id={hintId} className="text-[13px]" style={{ color: 'var(--muted-2)' }}>{hint}</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
```

(`state` stays `useState<'saved' | 'saving' | 'failed'>`; `PrefsSaveState` is the same union. The `toast.error` in
`change` stays.)

`src/components/prefs/account-security.tsx` — keep lines 1–8 (`'use client'`, imports, `MIN_PASSWORD`) and
`browsers()`, add `useEffect, useRef` to the react import, replace `field`/`fieldStyle`/`primary` with
`import { CARD_STYLE, FIELD, FIELD_STYLE, INK_BTN, INK_STYLE, OUTLINE_BTN, OUTLINE_STYLE, SETTINGS_CARD, SETTINGS_H2 } from '@/lib/settings-look';`,
and replace the component body from `async function revokeOthers` to the end with:

```tsx
  const openerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The form replaces its opener; when it closes, the opener comes back and takes focus (spec §2.6).
  const refocus = useRef(false);
  useEffect(() => {
    if (!open && refocus.current) { refocus.current = false; openerRef.current?.focus(); }
  }, [open]);

  function closeForm() { refocus.current = true; setOpen(false); setError(null); }

  async function revokeOthers() {
    if (revoking) return;
    setRevoking(true);
    setRevokeError(null);
    const { error: err } = await authClient.revokeOtherSessions();
    setRevoking(false);
    if (err) { setRevokeError("Couldn't sign out the other browsers. Try again."); return; }
    setSessions(1);
    headingRef.current?.focus();   // the focused button is about to go
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (next.length < MIN_PASSWORD) { setError(`The new password needs at least ${MIN_PASSWORD} characters.`); return; }
    if (next !== confirm) { setError("The new passwords don't match."); return; }
    setBusy(true);
    const { error: err } = await authClient.changePassword({
      currentPassword: current, newPassword: next, revokeOtherSessions: true,
    });
    setBusy(false);
    if (err) {
      setError(err.code === 'INVALID_PASSWORD' ? 'That is not your current password.'
        : err.status === 429 ? 'Too many attempts. Wait a minute and try again.'
          : "Couldn't change the password. Try again.");
      return;
    }
    setCurrent(''); setNext(''); setConfirm('');
    setSessions(1);
    setDone(true);
    refocus.current = true;
    setOpen(false);
  }

  const label = 'text-[13px] font-medium';
  return (
    <section id="account" aria-labelledby="account-heading" data-testid="account-security" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="grid grid-cols-1 items-center gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <h2 id="account-heading" ref={headingRef} tabIndex={-1} className={`${SETTINGS_H2} col-span-full mb-1.5 justify-self-start`}
            style={{ color: 'var(--ink)' }}>
          Sign-in &amp; password
        </h2>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }}>Email</span>
          <span data-testid="account-email" className="text-[14px] font-medium" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{email}</span>
        </div>
        {!open && (
          <button ref={openerRef} type="button" onClick={() => { setOpen(true); setDone(false); }}
                  data-testid="password-change-open" className={OUTLINE_BTN} style={OUTLINE_STYLE}>
            Change password…
          </button>
        )}
        {done && !open && (
          <span role="status" data-testid="password-done" className="col-span-full text-[13px]" style={{ color: 'var(--success-fg)' }}>
            Password changed. Your other browsers were signed out.
          </span>
        )}
        {open && (
          <form onSubmit={(e) => void changePassword(e)} data-testid="password-form"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeForm(); } }}
                className="col-span-full flex max-w-[400px] flex-col gap-2.5">
            <label htmlFor={currentId} className={label} style={{ color: 'var(--ink)' }}>Current password</label>
            <input id={currentId} type="password" autoComplete="current-password" value={current} required autoFocus
                   onChange={(e) => setCurrent(e.target.value)} data-testid="password-current" className={FIELD} style={FIELD_STYLE} />
            <label htmlFor={nextId} className={label} style={{ color: 'var(--ink)' }}>New password</label>
            <input id={nextId} type="password" autoComplete="new-password" value={next} required
                   onChange={(e) => setNext(e.target.value)} data-testid="password-new" className={FIELD} style={FIELD_STYLE} />
            <label htmlFor={confirmId} className={label} style={{ color: 'var(--ink)' }}>New password again</label>
            <input id={confirmId} type="password" autoComplete="new-password" value={confirm} required
                   onChange={(e) => setConfirm(e.target.value)} data-testid="password-confirm" className={FIELD} style={FIELD_STYLE} />
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
              At least {MIN_PASSWORD} characters. Your other browsers will be signed out.
            </span>
            {error && <span role="alert" data-testid="password-error" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</span>}
            <div className="flex items-center gap-2.5">
              <button type="submit" aria-disabled={busy} data-testid="password-save" className={INK_BTN} style={INK_STYLE}>
                {busy ? 'Changing…' : 'Change password'}
              </button>
              <button type="button" onClick={closeForm} className={OUTLINE_BTN} style={OUTLINE_STYLE}>Cancel</button>
            </div>
          </form>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }}>Browsers</span>
          <span data-testid="sessions-count" className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>{browsers(sessions)}</span>
        </div>
        {sessions > 1 && (
          <button type="button" onClick={() => void revokeOthers()} aria-disabled={revoking} data-testid="sessions-revoke"
                  className={OUTLINE_BTN} style={OUTLINE_STYLE}>
            {revoking ? 'Signing out…' : 'Sign out everywhere else'}
          </button>
        )}
        {revokeError && (
          <span role="alert" className="col-span-full text-[13px]" style={{ color: 'var(--danger-fg)' }}>{revokeError}</span>
        )}
      </div>
    </section>
  );
}
```

`src/components/prefs/firmware-password-setting.tsx` — keep lines 1–36 (imports, the doc comment with "Password
asked" / "Password not asked", state, `disarm`) with these edits: add `useRef` to the react import; add
`import { CARD_STYLE, FIELD, FIELD_STYLE, INK_BTN, INK_STYLE, OUTLINE_BTN, OUTLINE_STYLE, SETTINGS_CARD, SETTINGS_H2, SETTINGS_ROW } from '@/lib/settings-look';`;
rename `boxId` to `labelId`; add after the state lines:

```tsx
  const switchRef = useRef<HTMLButtonElement>(null);
  /** Cancel, Escape, and a successful turn-on all close the confirm form: focus goes back to the switch (spec §2.6). */
  function closeConfirm() { disarm(); switchRef.current?.focus(); }
  function onSwitch() {
    if (busy) return;
    if (!on && !arming) { setArming(true); return; }
    if (arming) { closeConfirm(); return; }
    void turnOff();
  }
```

keep `turnOff` and `turnOn` unchanged except, in `turnOn`, replace the success line `disarm();` with `closeConfirm();`;
and replace the `return (…)` with:

```tsx
  const checked = on || arming;
  return (
    <section id="firmware" aria-labelledby="firmware-heading" data-testid="firmware-prefs" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className={SETTINGS_ROW}>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h2 id="firmware-heading" tabIndex={-1} className={`${SETTINGS_H2} justify-self-start`} style={{ color: 'var(--ink)' }}>
            Firmware updates
          </h2>
          <span id={labelId} className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>
            Don&apos;t ask for my password when updating board firmware
          </span>
          <p id={warnId} className="text-[13px]" style={{ color: 'var(--muted-2)' }}>
            With this on, anyone using your signed-in browser can update your boards&apos; firmware.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <span data-testid="fw-password-state" role="status" aria-live="polite" className="text-[12px] font-semibold"
                style={{ color: on ? 'var(--amber-text)' : 'var(--muted)' }}>
            {on ? 'Password not asked' : 'Password asked'}
          </span>
          {/* Ruling 10: on = the password is NOT asked (A2's stored meaning). The off track carries a --muted-2 border
              (5.58:1 on the card) so "off" is visible as well as said. */}
          <button ref={switchRef} type="button" role="switch" aria-checked={checked} aria-labelledby={labelId}
                  aria-describedby={warnId} aria-disabled={busy} data-testid="fw-skip-password" onClick={onSwitch}
                  className="flex h-[26px] w-11 shrink-0 rounded-full border p-[3px] aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
                  style={checked
                    ? { background: 'var(--ink)', borderColor: 'var(--ink)' }
                    : { background: 'var(--line-strong)', borderColor: 'var(--muted-2)' }}>
            <span aria-hidden className={`size-[18px] rounded-full ${checked ? 'ml-auto' : ''}`}
                  style={{ background: 'var(--surface)', boxShadow: '0 1px 2px rgb(0 0 0 / .25)' }} />
          </button>
        </div>
        {arming && (
          // A <form>, so Enter in the password field confirms.
          <form className="col-span-full flex flex-wrap items-end gap-2.5"
                onSubmit={(e) => { e.preventDefault(); void turnOn(); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); } }}>
            <label htmlFor={pwId} className="flex flex-col gap-1.5 text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
              Confirm with your password
              <input id={pwId} type="password" data-testid="fw-skip-password-input" value={password}
                     autoFocus autoComplete="current-password"
                     onChange={(e) => setPassword(e.target.value)} className={`${FIELD} sm:w-[260px]`} style={FIELD_STYLE} />
            </label>
            <button type="submit" data-testid="fw-skip-password-confirm" aria-disabled={busy || password.length === 0}
                    className={INK_BTN} style={INK_STYLE}>
              {busy ? 'Checking…' : 'Turn off the password'}
            </button>
            <button type="button" onClick={closeConfirm} className={OUTLINE_BTN} style={OUTLINE_STYLE}>Cancel</button>
            {error && (
              <span className="basis-full text-[13px]" data-testid="fw-skip-password-error" role="alert"
                    style={{ color: 'var(--danger-fg)' }}>{error}</span>
            )}
          </form>
        )}
      </div>
    </section>
  );
```

(The switch is 44 × 26 with a 1 px border and 3 px padding: an 18 px knob fills the 18 px inner height exactly. The
spec's 20 px knob assumes no border; the border is Ruling 10's. `turnOn` already returns early on `busy ||
password.length === 0`, which is what makes `aria-disabled` safe on its submit.)

`src/components/prefs/delete-account.tsx` — keep lines 1–27 (imports, `ERRORS`, the doc comment, state, `ready`) with
these edits: add `useEffect, useRef` to the react import; replace `field`/`fieldStyle` with
`import { CARD_STYLE, FIELD, FIELD_STYLE, OUTLINE_BTN, OUTLINE_STYLE, SETTINGS_CARD, SETTINGS_H2, SETTINGS_ROW } from '@/lib/settings-look';`;
in `submit`, change the first line to `if (!ready || busy) return;`; add before `submit`:

```tsx
  const openerRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!open && refocus.current) { refocus.current = false; openerRef.current?.focus(); }
  }, [open]);
  function close() { refocus.current = true; setOpen(false); setPassword(''); setConfirm(''); setError(null); }
```

and replace the `return (…)` with:

```tsx
  return (
    <section id="danger" aria-labelledby="danger-heading" data-testid="delete-account" className={SETTINGS_CARD}
             style={{ ...CARD_STYLE, boxShadow: '0 0 0 1px var(--danger-line)' }}>
      <div className={SETTINGS_ROW}>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h2 id="danger-heading" tabIndex={-1} className={`${SETTINGS_H2} justify-self-start`} style={{ color: 'var(--danger-strong)' }}>
            Delete account
          </h2>
          <p className="text-[13px]" style={{ color: 'var(--muted-2)' }}>
            Removes your library, boards and uploads. Paired boards go back to setup mode. This cannot be undone.
          </p>
        </div>
        {!open && (
          <button ref={openerRef} type="button" onClick={() => setOpen(true)} data-testid="account-delete-open"
                  className="h-[38px] justify-self-start rounded-[10px] border px-3.5 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
                  style={{ background: 'var(--surface)', borderColor: 'var(--danger-line)', color: 'var(--danger-fg)' }}>
            Delete account…
          </button>
        )}
        {open && (
          <form onSubmit={(e) => void submit(e)} className="col-span-full flex max-w-[400px] flex-col gap-2.5"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
            <label htmlFor={pwId} className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>Your password</label>
            <input id={pwId} type="password" autoComplete="current-password" value={password} autoFocus
                   onChange={(e) => setPassword(e.target.value)} data-testid="account-delete-password" className={FIELD} style={FIELD_STYLE} />
            <label htmlFor={confirmId} className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>Type DELETE to confirm</label>
            <input id={confirmId} type="text" autoComplete="off" spellCheck={false} value={confirm}
                   onChange={(e) => setConfirm(e.target.value)} data-testid="account-delete-confirm"
                   className={`${FIELD} font-mono`} style={FIELD_STYLE} />
            {error && <span role="alert" data-testid="account-delete-error" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</span>}
            <div className="flex items-center gap-2.5">
              <button type="submit" disabled={!ready} aria-disabled={busy} data-testid="account-delete-submit"
                      className="h-9 rounded-[9px] px-3.5 text-[13px] font-semibold text-white disabled:opacity-50 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
                      style={{ background: 'var(--danger-fg)', color: '#FFFFFF' }}>
                {busy ? 'Deleting…' : 'Delete my account'}
              </button>
              <button type="button" onClick={close} className={OUTLINE_BTN} style={OUTLINE_STYLE}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
```

`src/app/(app)/settings/loading.tsx`:

```tsx
import { Bone } from '@/components/shell/skeleton';

// Settings while it loads (C5 spec §2.7, Ruling 37): the page's own grid -- five nav bones from lg, then the heading
// and four cards in the main column. Not PageSkeleton: its outer header bones have no counterpart here (the heading is
// in the main column, `PageHeader flush`), and would make the page jump when it lands -- the C4 disk page's lesson.
// Same status wrapper. Nested under (app)/loading.tsx like the other areas', so status codes do not change.
export default function SettingsLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <div role="status" aria-busy="true" data-testid="settings-skeleton">
      <span className="sr-only">Loading…</span>
      <div className="px-4 pb-10 pt-6 sm:px-7 lg:grid lg:grid-cols-[240px_minmax(0,860px)] lg:items-start lg:gap-8">
        <div className="hidden flex-col gap-0.5 lg:flex">
          {Array.from({ length: 5 }, (_, i) => <div key={i} data-skeleton-nav><Bone className="h-[38px] w-full" /></div>)}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Bone className="h-[13px] w-24" />
            <Bone className="h-[30px] w-48 sm:h-[44px]" />
          </div>
          {[0, 1, 2, 3].map((c) => (
            <div key={c} data-skeleton-card className="flex flex-col gap-3 rounded-[20px] p-5 sm:p-6" style={card}>
              {c === 0 ? (
                <>
                  <Bone className="h-[17px] w-32" />
                  {Array.from({ length: 4 }, (_, i) => <div key={i} data-skeleton-row><Bone className="h-12 w-full" /></div>)}
                </>
              ) : (
                <>
                  <Bone className="h-3 w-1/3" />
                  <Bone className="h-3 w-2/3" />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test "src/app/(app)/settings/loading.test.ts" src/lib/settings-look.test.ts src/components/ui/seg-radio-group.test.ts` → PASS.
- `npx tsc --noEmit`; `pnpm lint` (only the two known errors); `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Settings"` → `4 passed`.
- `PORT=3100 npx playwright test e2e/account.spec.ts --project=desktop` → `5 passed`.
- `PORT=3100 npx playwright test e2e/user-settings.spec.ts --project=desktop` → all pass (`--list` first; 4 today).
- `PORT=3100 npx playwright test e2e/library-table.spec.ts --project=desktop -g "Library opens in Table"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/library-paging.spec.ts --project=desktop -g "Titles per page in Preferences"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → `2 passed` (the gear's `aria-current`).

- [ ] **Step 5: Commit** — `src/app/(app)/settings/page.tsx`, `src/app/(app)/settings/loading.tsx`,
  `src/app/(app)/settings/loading.test.ts`, the four `src/components/prefs/*.tsx` above, `e2e/c5-layout.spec.ts`,
  `e2e/account.spec.ts`, `e2e/user-settings.spec.ts`, `e2e/library-table.spec.ts`, `e2e/library-paging.spec.ts`,
  message `C5 Settings: section list, four cards, radiogroups, firmware switch, focus rules, skeleton` plus the two
  trailer lines.

---

### Task 3: The Help page — four groups, the article cards, the filter, the phone disclosure

**Files:**
- Modify: `src/lib/help/topics.tsx` (after `HelpTopicId`: `HELP_GROUPS`, `HELP_ORDER`, `helpGroupOf`),
  `src/lib/help/topics.test.ts`, `src/lib/help/match.ts` (`filterHelpTopics`), `src/lib/help/match.test.ts`,
  `src/app/(app)/help/page.tsx`
- Create: `src/components/help/help-browser.tsx`
- Modify: `e2e/c5-layout.spec.ts` (append)

**Interfaces:**
- Consumes (Task 1): `SideNav` (`size="sm"`), `SideNavGroup`, `PageHeader flush`, token `--prose`.
- Produces: `type HelpGroupId = 'drives' | 'disks' | 'network' | 'server'`;
  `type HelpGroup = { id: HelpGroupId; name: string; topics: readonly HelpTopicId[] }`;
  `HELP_GROUPS: readonly HelpGroup[]`; `HELP_ORDER` (now the groups flattened); `helpGroupOf(id: HelpTopicId) → HelpGroup`;
  `filterHelpTopics(raw: string) → { active: boolean; ids: ReadonlySet<HelpTopicId> }`; test ids `help-nav`,
  `help-nav-toggle`, `help-group-<id>`, `help-filter`, `help-filter-count`, `help-filter-empty`; element ids
  `help-h-<id>`, `help-articles`.

**Plan ruling** (spec §3.4 contradiction): with a query that matches nothing, "a group with none is not shown" would
hide every group, while the next bullet says "the nav shows its groups' names only". The zero-match case wins: all
four group names show, with no items under them, so the nav still says what exists.

**Plan ruling** (spec §3.2 one nav, two places): the nav is rendered once, inside a `<details>`. From `lg` the
details is held open (`useMediaQuery('(min-width: 1024px)')` from `@base-ui/react/unstable-use-media-query`, the
hook `create-adf.tsx` already uses) and its summary is `lg:hidden`; below `lg` it is closed by default. Two copies of
the nav would make `help-nav` and every topic link ambiguous under Playwright's strict mode. Cost: before hydration a
desktop shows no topic list for a moment.

- [ ] **Step 1: Write the failing tests**

`src/lib/help/topics.test.ts` — change the import to
`import { HELP_TOPICS, HELP_ORDER, HELP_GROUPS, helpGroupOf, type HelpTopicId } from './topics';` and append:

```ts
describe('help groups (C5 spec §3.1, Ruling 14)', () => {
  it("are the board's four, in its order, with these topics", () => {
    expect(HELP_GROUPS.map((g) => [g.id, g.name])).toEqual([
      ['drives', 'Drives'], ['disks', 'Library and disks'], ['network', 'Amiga networking'], ['server', 'This server'],
    ]);
    expect(HELP_GROUPS[0].topics).toEqual(['boards', 'display', 'second-drive', 'next-disk', 'nfc', 'write-protect']);
    expect(HELP_GROUPS[1].topics).toEqual(['library', 'write-back', 'disk-sets', 'hd-hfe', 'cover-image']);
    expect(HELP_GROUPS[2].topics).toEqual(['network', 'send', 'from-amiga']);
    expect(HELP_GROUPS[3].topics).toEqual(['preferences', 'own-server', 'about']);
  });
  it('put every topic in exactly one group, and HELP_ORDER is the groups flattened', () => {
    const all = HELP_GROUPS.flatMap((g) => g.topics);
    expect([...all].sort()).toEqual([...IDS].sort());
    expect(new Set(all).size).toBe(17);
    expect(HELP_ORDER).toEqual(all);
    expect(helpGroupOf('library').name).toBe('Library and disks');
    expect(helpGroupOf('write-protect').id).toBe('drives');
  });
});
```

`src/lib/help/match.test.ts` — change the import to `import { matchHelpTopics, filterHelpTopics } from './match';` and
append:

```ts
describe('filterHelpTopics (C5 spec §3.4, Ruling 15)', () => {
  it('is inactive under two characters, and filters nothing', () => {
    expect(filterHelpTopics('')).toEqual({ active: false, ids: new Set() });
    expect(filterHelpTopics(' d ').active).toBe(false);
  });
  it('matches every word in title or short text, with no limit', () => {
    // e2e/c5-layout.spec.ts's filter test relies on this exact set.
    expect(filterHelpTopics('drive')).toEqual({ active: true, ids: new Set(['second-drive', 'boards', 'network', 'send']) });
    expect(filterHelpTopics('disk').ids.size).toBeGreaterThan(3);   // more than the header's three
  });
  it('active with no match is a real answer: zero topics', () => {
    expect(filterHelpTopics('zzqx')).toEqual({ active: true, ids: new Set() });
  });
});
```

`e2e/c5-layout.spec.ts` — append:

```ts
// ---- Help (spec §3) -------------------------------------------------------------------------------------------

const articles = (page: Page) => page.locator('article[data-testid^="help-section-"]:visible');

test('Help: topics in four groups, the one arrived at marked current, each article named by its group', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/help#write-protect');
  const nav = page.getByTestId('help-nav');
  await expect(nav).toBeVisible();
  for (const g of ['drives', 'disks', 'network', 'server']) await expect(page.getByTestId(`help-group-${g}`)).toBeVisible();
  await expect(page.getByTestId('help-group-drives').getByRole('link')).toHaveCount(6);
  await expect(page.locator('#help-h-write-protect')).toBeInViewport();
  await expect(nav.getByRole('link', { name: 'Write protection' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('help-section-write-protect')).toContainText('Help · Drives');
  await expect(page.getByTestId('help-section-library')).toContainText('Help · Library and disks');
  const order = await page.locator('article[data-testid^="help-section-"]').evaluateAll((els) => els.map((e) => e.id));
  expect(order).toHaveLength(17);
  expect(order.slice(0, 3)).toEqual(['boards', 'display', 'second-drive']);
  await expect(page.getByTestId('help-nav-toggle')).toBeHidden();   // the phone summary is not drawn from lg
});

test('Help: the filter keeps only matching topics, says how many, and Escape brings all 17 back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUpFresh(page);
  await page.goto('/help');
  const filter = page.getByTestId('help-filter');
  await hydrated(page, 'help-filter', 'onChange');
  await filter.fill('d');
  await expect(page.getByTestId('help-filter-count')).toHaveCount(0);
  await expect(articles(page)).toHaveCount(17);
  // filterHelpTopics('drive') is second-drive, boards, network, send (pinned in src/lib/help/match.test.ts).
  await filter.fill('drive');
  await expect(page.getByTestId('help-filter-count')).toHaveText('4 of 17 topics');
  await expect(articles(page)).toHaveCount(4);
  await expect(page.getByTestId('help-section-library')).toBeHidden();
  await expect(page.getByTestId('help-group-disks')).toHaveCount(0);
  await expect(page.getByTestId('help-nav').getByRole('link')).toHaveCount(4);
  await filter.fill('zzqx');
  await expect(page.getByTestId('help-filter-empty')).toHaveText('No topic matches “zzqx”. Clear the search to see all 17.');
  await expect(articles(page)).toHaveCount(0);
  await expect(page.getByTestId('help-filter-count')).toHaveText('0 of 17 topics');
  await expect(page.getByTestId('help-group-server')).toBeVisible();
  await expect(page.getByTestId('help-nav').getByRole('link')).toHaveCount(0);
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(articles(page)).toHaveCount(17);
  await expect(page.getByTestId('help-filter-empty')).toHaveCount(0);
});

test('Help at 390 px: the filter and a closed Topics disclosure sit above the articles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpFresh(page);
  await page.goto('/help');
  await hydrated(page, 'help-filter', 'onChange');
  const toggle = page.getByTestId('help-nav-toggle');
  await expect(toggle).toHaveText('Topics · 17');
  await expect(page.getByTestId('help-nav')).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId('help-nav')).toBeVisible();
  await page.getByTestId('help-filter').fill('drive');
  await expect(toggle).toHaveText('Topics · 4 of 17');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
```

- [ ] **Step 2: Run them to see them fail**

- `pnpm test src/lib/help/topics.test.ts src/lib/help/match.test.ts` → FAIL (`HELP_GROUPS` is undefined /
  `filterHelpTopics is not a function`).
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Help"` → 3 failed (no `help-nav`).

- [ ] **Step 3: Implement**

`src/lib/help/topics.tsx` — replace the `HELP_ORDER` declaration at the end (lines 686–689) with:

```tsx
export type HelpGroupId = 'drives' | 'disks' | 'network' | 'server';
export type HelpGroup = { id: HelpGroupId; name: string; topics: readonly HelpTopicId[] };

/**
 * The Help page's groups, in the board's order (C5 spec §3.1, Ruling 14): Library joins the disks group and Display
 * joins Drives, the two topics the board's groups left out. HELP_ORDER is these flattened -- one source for the page,
 * its section list and the header search's Help ranking.
 */
export const HELP_GROUPS: readonly HelpGroup[] = [
  { id: 'drives', name: 'Drives', topics: ['boards', 'display', 'second-drive', 'next-disk', 'nfc', 'write-protect'] },
  { id: 'disks', name: 'Library and disks', topics: ['library', 'write-back', 'disk-sets', 'hd-hfe', 'cover-image'] },
  { id: 'network', name: 'Amiga networking', topics: ['network', 'send', 'from-amiga'] },
  { id: 'server', name: 'This server', topics: ['preferences', 'own-server', 'about'] },
];

export const HELP_ORDER: readonly HelpTopicId[] = HELP_GROUPS.flatMap((g) => g.topics);

export function helpGroupOf(id: HelpTopicId): HelpGroup {
  const g = HELP_GROUPS.find((x) => x.topics.includes(id));
  if (!g) throw new Error(`help topic ${id} is in no group`);
  return g;
}
```

`src/lib/help/match.ts` — append:

```ts
/**
 * The Help page's filter (C5 spec §3.4, Ruling 15): the header search's matcher with no limit. `active` once the
 * query has two characters (A3's rule); an active filter with no ids is a real "no topic matches" answer.
 */
export function filterHelpTopics(raw: string): { active: boolean; ids: ReadonlySet<HelpTopicId> } {
  const active = raw.toLowerCase().split(/\s+/).filter(Boolean).join('').length >= 2;
  return { active, ids: new Set(active ? matchHelpTopics(raw, Infinity) : []) };
}
```

`src/components/help/help-browser.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { SearchIcon } from 'lucide-react';
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query';
import { PageHeader } from '@/components/shell/page-header';
import { SideNav, type SideNavGroup } from '@/components/shell/side-nav';
import { HELP_GROUPS, HELP_ORDER, HELP_TOPICS, helpGroupOf, type HelpTopicId } from '@/lib/help/topics';
import { filterHelpTopics } from '@/lib/help/match';

const TOTAL = HELP_ORDER.length;
const CARD = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
/** The board's article look on the seventeen bodies, applied from the wrapper -- the bodies themselves are not edited. */
const PROSE = [
  'flex max-w-[68ch] flex-col gap-3 text-[15px] leading-[1.6]',
  '[&_strong]:font-semibold [&_strong]:text-(--ink)',
  '[&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2.5 [&_ul]:pl-[22px] [&_ol]:flex [&_ol]:flex-col [&_ol]:gap-2.5 [&_ol]:pl-[22px]',
  '[&_a]:font-semibold [&_a]:text-(--amber-text) [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-(--ink)',
  '[&_code]:font-mono [&_code]:text-[14px]',
].join(' ');

/**
 * The Help page (C5 spec §3; board InfHelp): every topic on the one page as an article card (Ruling 12), a grouped
 * topic list sticky from lg (Ruling 13), and the board's "Search help" filter (Ruling 15). Below lg the filter and a
 * closed "Topics · 17" disclosure sit above the articles; the nav inside it is the same single nav.
 */
export function HelpBrowser() {
  const [q, setQ] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const lg = useMediaQuery('(min-width: 1024px)', {});
  const f = filterHelpTopics(q);
  const shown = (id: HelpTopicId) => !f.active || f.ids.has(id);
  const none = f.active && f.ids.size === 0;

  const groups: SideNavGroup[] = HELP_GROUPS
    .filter((g) => none || g.topics.some(shown))
    .map((g) => ({
      label: g.name,
      testId: `help-group-${g.id}`,
      items: none ? [] : g.topics.filter(shown).map((id) => ({ href: `#${id}`, label: HELP_TOPICS[id].title, focusId: `help-h-${id}` })),
    }));

  return (
    <div className="px-4 pb-10 pt-6 sm:px-7 lg:grid lg:grid-cols-[260px_minmax(0,720px)] lg:items-start lg:gap-8">
      <aside className="mb-5 flex flex-col lg:sticky lg:top-6 lg:mb-0 lg:self-start">
        <div className="mb-2 flex flex-col gap-1">
          <label className="flex h-[38px] items-center gap-2 rounded-[10px] border px-2.5 focus-within:ring-2 focus-within:ring-(--ring)"
                 style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
            <SearchIcon aria-hidden className="size-3.5 shrink-0" style={{ color: 'var(--muted-2)' }} />
            <input type="search" data-testid="help-filter" aria-label="Search help" placeholder="Search help"
                   aria-controls="help-articles" value={q} onChange={(e) => setQ(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setQ(''); } }}
                   className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-(--muted-2)"
                   style={{ color: 'var(--ink)' }} />
          </label>
          {f.active && (
            <span role="status" data-testid="help-filter-count" className="px-1 text-[12px]" style={{ color: 'var(--muted-2)' }}>
              {f.ids.size} of {TOTAL} topics
            </span>
          )}
        </div>
        <details open={lg || navOpen} onToggle={(e) => { if (!lg) setNavOpen(e.currentTarget.open); }}>
          <summary data-testid="help-nav-toggle" className="flex h-10 cursor-pointer items-center px-1 text-[14px] font-semibold lg:hidden"
                   style={{ color: 'var(--ink)' }}>
            {f.active ? `Topics · ${f.ids.size} of ${TOTAL}` : `Topics · ${TOTAL}`}
          </summary>
          <SideNav label="Help topics" testId="help-nav" groups={groups} size="sm" />
        </details>
      </aside>
      <div className="flex min-w-0 flex-col gap-5">
        <PageHeader flush size="lg" title="Help" subtitle="What the less obvious parts of WebFloppy do, and why." />
        <div id="help-articles" className="flex flex-col gap-5">
          {none && (
            <p data-testid="help-filter-empty" className="text-[13px]" style={{ color: 'var(--muted)' }}>
              No topic matches “{q.trim()}”. Clear the search to see all {TOTAL}.
            </p>
          )}
          {HELP_ORDER.map((id) => {
            const t = HELP_TOPICS[id];
            return (
              // `hidden` (display:none), not the attribute: the card's own `flex` would override [hidden].
              <article key={id} id={id} data-testid={`help-section-${id}`} aria-labelledby={`help-h-${id}`}
                       className={`${shown(id) ? 'flex' : 'hidden'} scroll-mt-6 flex-col gap-4 rounded-[20px] p-5 sm:p-8`} style={CARD}>
                <span className="text-[13px] font-medium" style={{ color: 'var(--muted-2)' }}>Help · {helpGroupOf(id).name}</span>
                <h2 id={`help-h-${id}`} tabIndex={-1}
                    className="rounded-[6px] text-[24px] font-bold leading-[1.05] tracking-[-0.02em] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring) sm:text-[30px]"
                    style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)', overflowWrap: 'anywhere' }}>
                  {t.title}
                </h2>
                <div className={PROSE} style={{ color: 'var(--prose)' }}>{t.body}</div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

(The empty line quotes `q.trim()` so the test's `“zzqx”` matches what was typed without its spaces. The spec's
`${q}` is the query; trimming only drops edge whitespace.)

`src/app/(app)/help/page.tsx`:

```tsx
import { HelpBrowser } from '@/components/help/help-browser';

export const metadata = { title: 'Help' };

// Every help topic on one page (spec 2026-10-05-context-help; layout C5 §3, board InfHelp). The "?" popovers and the
// header search link here as /help#<id>; scroll-mt-6 keeps an article's heading clear of the top when it is the
// target (the header is not sticky).
export default function HelpPage() {
  return <HelpBrowser />;
}
```

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test src/lib/help` → PASS; `npx tsc --noEmit`; `pnpm lint` (two known); `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Help"` → `3 passed`.
- `PORT=3100 npx playwright test e2e/help.spec.ts --project=desktop` → `6 passed` (the known flake: rerun
  `-g "Enter opens"` alone once if it fails).
- `PORT=3100 npx playwright test e2e/help.mobile.spec.ts --project=mobile` → `1 passed`.
- `PORT=3100 npx playwright test e2e/library-a3.spec.ts --project=desktop -g "help topics"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → `2 passed` (`Help · WebFloppy`).

- [ ] **Step 5: Commit** — `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`, `src/lib/help/match.ts`,
  `src/lib/help/match.test.ts`, `src/components/help/help-browser.tsx`, `src/app/(app)/help/page.tsx`,
  `e2e/c5-layout.spec.ts`, message `C5 Help: four groups, article cards, Search help filter, phone Topics disclosure`
  plus the two trailer lines.

---

### Task 4: The "?" — the round trigger and the ink popover

**Files:**
- Modify: `src/components/help/help-tip.tsx`, `src/components/help/help-tip.test.ts`, `e2e/c5-layout.spec.ts`
  (append), `e2e/contrast.spec.ts` (the `legible` helper + one test)

**Interfaces:**
- Consumes (Task 1): tokens `--on-ink-2`, `--on-ink-accent`. (Task 2): the "?" in Settings' `PageHeader`
  (`help-tip-preferences`).
- Produces: in `e2e/contrast.spec.ts`,
  `async function legible(page: Page, area: string, pairs: ReadonlyArray<readonly [name: string, selector: string]>): Promise<void>`
  (probes each, logs the ratio, requires > 4.5) — Tasks 5 and 7 use it.

- [ ] **Step 1: Write the failing tests**

`src/components/help/help-tip.test.ts` — append inside the `describe`:

```ts
  it('is the round track button with a text "?", 24 px, ink when open (C5 spec §4.1, Ruling 18)', () => {
    const html = renderToStaticMarkup(createElement(HelpTip, { topic: 'display' }));
    expect(html).toContain('size-6');
    expect(html).toContain('rounded-full');
    expect(html).toContain('bg-(--track)');
    expect(html).toContain('data-[popup-open]:bg-(--ink)');
    expect(html).toMatch(/<span aria-hidden="true">\?<\/span>/);
    expect(html).not.toContain('<svg');
    expect(html).toContain('aria-label="About The board&#x27;s display"');
  });
```

`e2e/c5-layout.spec.ts` — append:

```ts
// ---- The "?" (spec §4) ----------------------------------------------------------------------------------------

test('the "?" popover: a 24 px round trigger, the ink card, and a uniquely named link to the topic', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  const tip = page.getByTestId('help-tip-preferences');
  await expect(tip).toHaveAccessibleName('About Preferences');
  const box = (await tip.boundingBox())!;
  expect(Math.round(box.width)).toBe(24);
  expect(Math.round(box.height)).toBe(24);
  await expect(tip.locator('svg')).toHaveCount(0);
  await hydrated(page, 'help-tip-preferences');
  await tip.click();
  await expect(tip).toHaveAttribute('data-popup-open', '');
  const pop = page.getByTestId('help-pop-preferences');
  await expect(pop).toBeVisible();
  await expect(pop).toBeInViewport({ ratio: 1 });
  const more = page.getByTestId('help-more-preferences');
  await expect(more).toHaveAccessibleName('Read the full topic: Preferences');
  await expect(more).toHaveAttribute('href', '/help#preferences');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(tip).toBeFocused();
});
```

`e2e/contrast.spec.ts` (it already imports `hydrated` and `signUpFresh`) — add after `ratio()`:

```ts
/** C5: probe each [name, selector] and require AA. The selector must find a painted element; never loosen 4.5. */
async function legible(page: Page, area: string, pairs: ReadonlyArray<readonly [string, string]>) {
  for (const [name, sel] of pairs) {
    const p = await probe(page, sel);
    expect(p, `${area}: ${name} (${sel}) not found or transparent`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`${area.padEnd(9)} ${name.padEnd(36)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 32)}"`);
    expect(r, `${area}: ${name}`).toBeGreaterThan(4.5);
  }
}
```

and at the end of the file:

```ts
// Phase C5 spec §11: the "?" and its open popover (the ink card).
test('the "?" and its open popover are legible: glyph on the track, title, text and link on ink', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  await hydrated(page, 'help-tip-preferences');
  await page.mouse.move(0, 0);
  await legible(page, 'help tip', [['"?" glyph (idle, on the track)', '[data-testid="help-tip-preferences"] > span']]);
  await page.getByTestId('help-tip-preferences').click();
  await expect(page.getByTestId('help-pop-preferences')).toBeVisible();
  await legible(page, 'popover', [
    ['"?" glyph (open, surface on ink)', '[data-testid="help-tip-preferences"] > span'],
    ['title', '[data-testid="help-pop-preferences"] h2'],
    ['text', '[data-testid="help-pop-preferences"] p'],
    ['Read the full topic', '[data-testid="help-more-preferences"]'],
  ]);
});
```

(Base UI renders `Popover.Title` as `h2` and `Popover.Description` as `p` —
`node_modules/@base-ui/react/popover/title/PopoverTitle.js`.)

- [ ] **Step 2: Run them to see them fail**

- `pnpm test src/components/help/help-tip.test.ts` → FAIL (`expected … to contain 'size-6'`; it has `h-6 w-6` and an svg).
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "popover"` → 1 failed (`svg` count 1).

- [ ] **Step 3: Implement** — `src/components/help/help-tip.tsx`:

```tsx
'use client';
import { Popover } from '@base-ui/react/popover';
import { Link } from '@/components/shell/link';
import { HELP_TOPICS, type HelpTopicId } from '@/lib/help/topics';

/**
 * A "?" that explains the control beside it (spec 2026-10-05-context-help; look C5 §4, board InfHelp's right
 * column). Tap, click or keyboard opens it -- never hover-only, because a phone has no hover. Clicks are stopped
 * here so a "?" inside a clickable row, card or toggle never also triggers the thing it explains. The round track
 * button turns ink when hovered or open (both values visible, Ruling 18); 24 px for WCAG 2.2's target size.
 */
export function HelpTip({ topic, className }: { topic: HelpTopicId; className?: string }) {
  const t = HELP_TOPICS[topic];
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid={`help-tip-${topic}`}
        aria-label={`About ${t.title}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle font-sans text-[12px] font-bold leading-none bg-(--track) text-(--muted) hover:bg-(--ink) hover:text-(--surface) data-[popup-open]:bg-(--ink) data-[popup-open]:text-(--surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) ${className ?? ''}`}
      >
        <span aria-hidden="true">?</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} collisionPadding={16} className="z-50">
          <Popover.Popup
            data-testid={`help-pop-${topic}`}
            className="flex w-[min(320px,calc(100vw-32px))] flex-col gap-2.5 rounded-[14px] p-4 outline-none"
            style={{ background: 'var(--ink)', boxShadow: '0 20px 40px -12px rgb(36 33 27 / .5)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <Popover.Title className="text-[14px] font-semibold" style={{ color: 'var(--surface)' }}>{t.title}</Popover.Title>
            <Popover.Description className="text-[13px] leading-[1.5]" style={{ color: 'var(--on-ink-2)' }}>{t.short}</Popover.Description>
            <Link href={`/help#${topic}`} data-testid={`help-more-${topic}`}
                  className="self-start text-[13px] font-semibold underline-offset-2 hover:underline"
                  style={{ color: 'var(--on-ink-accent)' }}>
              Read the full topic<span className="sr-only">: {t.title}</span>
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
```

(Ruling 19: the visible words are `Read the full topic`; the `sr-only` title makes the name unique. The 35 call sites
pass `className` for placement only; check with `grep -rn "<HelpTip" src | grep className` that none passes a colour
or size that would now fight the track fill — if one does, record it in the report rather than editing the site.)

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test src/components/help` → PASS; `npx tsc --noEmit`; `pnpm lint`; `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "popover"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "popover are legible"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/help.spec.ts --project=desktop` → `6 passed` (flake rule).
- `PORT=3100 npx playwright test e2e/help.mobile.spec.ts --project=mobile` → `1 passed`.
- `PORT=3100 npx playwright test e2e/devices-page.spec.ts --project=desktop -g "help tip"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/second-drive.spec.ts --project=desktop -g "help tip opens|focus stays on the radio"` → `2 passed`.
- `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop -g "Send card names its one board"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/cover-override.spec.ts --project=desktop -g "390 px phone"` → `1 passed`.

(Spec §9's `upload-staging -g help` selects no test — no title says "help"; the one test that touches a "?" there is
"the Send card names its one board…", run above.)

- [ ] **Step 5: Commit** — `src/components/help/help-tip.tsx`, `src/components/help/help-tip.test.ts`,
  `e2e/c5-layout.spec.ts`, `e2e/contrast.spec.ts`, message `C5 "?": round track trigger, ink popover, Read the full
  topic` plus the two trailer lines.

---

### Task 5: Search — the combobox, the 600 px panel and its scrim, rows with disks and kinds, the four new fields

**Files:**
- Modify: `src/lib/queries.ts` (export `kindsForGames`; `withDerived` calls it), `src/lib/search.ts`,
  `src/components/shell/search-box.tsx`, `e2e/contrast.spec.ts:263`, `e2e/c5-layout.spec.ts` (append)
- Create: `src/lib/search-look.ts`, `src/lib/search-look.test.ts`

**Interfaces:**
- Consumes (Task 1): token `--search-scrim`. Existing: `titleDiskColor` (`@/lib/library-look`), `DiskIcon`,
  `matchHelpTopics`, `HELP_TOPICS`, `kindFromSetName` / `pickKind` (`@/lib/game-kind`), `isHdAdfSql`
  (`@/lib/disk-format-sql`).
- Produces: `kindsForGames(orgId: string, ids: string[]) → Promise<Map<string, string | null>>` (`@/lib/queries`);
  `SearchTitle` gains `authored: boolean; hasHd: boolean; hasHfe: boolean; kind: string | null` (server and the
  client redeclaration); `searchKindWord(t: { kind?: string | null; authored?: boolean }) → string`,
  `searchTitleSub(t: { kind?: string | null; authored?: boolean; year: number | null; publisher: string | null; diskCount: number; collections?: string[] | null }) → string`,
  `searchEmptyText(q: string) → string` (`@/lib/search-look`); test ids `search-scrim`, `search-group-<kind>`
  (`title` / `collection` / `help`), `search-result-sub`, `search-error`, `search-keys`; element ids `search-listbox`,
  `search-opt-<i>`; data attributes `data-disk-color` (a title row's icon), `data-tile` (a letter tile).

**Plan ruling** (spec §5.3 panel position): the panel is `absolute` against the header, not `fixed`. Both shells'
headers (`app-header`, `admin-header`) are `relative`, 72 px from `sm`, and not sticky: a `fixed` panel would stay
put while the page scrolls the field away. With the search box's wrapper `static`, `absolute top-[64px] right-7`
lands exactly where the spec's `fixed` would at scroll 0. Below `sm` the panel is `left-4 right-4 top-[calc(100%+4px)]`
of the header: the spec's `right-0 w-[calc(100vw-2rem)]` of the wrapper would push its left edge off-screen, because
below `sm` the box shares its line with the About / Settings / Sign out buttons, so the wrapper's right edge is not the
header's. The scrim stays `fixed` from `sm`, as the spec says.

**Plan ruling** (spec §5.2): the whole panel (not only the rows) takes `onMouseDown={(e) => e.preventDefault()}`, so a
press on the footer, a group label or the list's scrollbar never blurs the input and closes the panel.

- [ ] **Step 1: Write the failing tests**

`src/lib/search-look.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { searchKindWord, searchTitleSub, searchEmptyText } from '@/lib/search-look';

const t = (o: Partial<Parameters<typeof searchTitleSub>[0]> = {}) =>
  ({ kind: null, authored: false, year: null, publisher: null, diskCount: 1, collections: [], ...o });

describe('search rows (C5 spec §5.4, Ruling 25)', () => {
  it('the kind word: the kind, else Made here, else Unidentified', () => {
    expect(searchKindWord({ kind: 'Game', authored: true })).toBe('Game');
    expect(searchKindWord({ kind: null, authored: true })).toBe('Made here');
    expect(searchKindWord({ kind: null, authored: false })).toBe('Unidentified');
    expect(searchKindWord({})).toBe('Unidentified');   // an older server sends neither
  });
  it("a title's sub line leads with the kind, then year, publisher, disks, where it lives", () => {
    expect(searchTitleSub(t({ kind: 'Game', year: 1991, publisher: 'Psygnosis', diskCount: 2, collections: ['Shelf', 'Faves'] })))
      .toBe('Game · 1991 · Psygnosis · 2 disks · in Shelf, Faves');
    expect(searchTitleSub(t())).toBe('Unidentified · 1 disk · Uncategorized');
    expect(searchTitleSub(t({ publisher: '', collections: null }))).toBe('Unidentified · 1 disk');
  });
  it('the empty line names what was searched (Ruling 28)', () => {
    expect(searchEmptyText('zool')).toBe('Nothing in your library or Help matches “zool”.');
  });
});
```

`e2e/c5-layout.spec.ts` — add to the imports `import { eq } from 'drizzle-orm';`, `import { getDb } from '@/db';`,
`import { blobs } from '@/db/schema/catalog';`, `import { randomUUID } from 'node:crypto';`, change the helpers import
to `import { signUpFresh, runTag } from './helpers';`, the device-helpers import to
`import { cleanupSeeded, hydrated, seedDisk } from './device-helpers';`, add
`import { seedTosecEntry, cleanupTosec } from './tosec-helpers';`, change the `afterAll` to
`test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });`, add after `prefsSaved`
`const sha = (tag: string) => randomUUID().replace(/-/g, '').padEnd(64, tag);`, and append:

```ts
// ---- Search (spec §5) -----------------------------------------------------------------------------------------

test('Search: the field is a combobox over a listbox of option links; the arrows move aria-activedescendant', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  // The query is one ILIKE substring (search-query.ts), so the run tag sits between the shared word and the name.
  const a = await seedDisk(u.orgId, { title: `Combo ${run} Alpha`, diskNo: 1, sha256: sha('a') });
  await seedDisk(u.orgId, { title: `Combo ${run} Beta`, diskNo: 1, sha256: sha('b') });
  const input = page.getByRole('combobox', { name: 'Search titles' });
  await expect(input).toHaveAttribute('data-testid', 'search-input');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.fill(`Combo ${run}`);   // both seeded titles, nothing else (the run tag is unique)
  await expect(page.locator('[data-testid="search-result"][data-result-kind="title"]')).toHaveCount(2);
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toHaveAttribute('aria-controls', 'search-listbox');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await expect(page.getByTestId('search-group-title')).toHaveText('Titles');
  const first = page.getByRole('option').first();
  await expect(first).toHaveAttribute('id', 'search-opt-0');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(first).toHaveAttribute('tabindex', '-1');
  await expect(first).toHaveAttribute('href', `/games/${a.gameId}`);
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-0');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-opt-1');
  await expect(page.locator('#search-opt-1')).toHaveAttribute('aria-selected', 'true');
});

test('Search: the panel closes when focus leaves or the scrim is pressed, keeps the query, opens again on focus; a row press navigates', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Scrim Target ${run}`, diskNo: 1, sha256: sha('s') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings');   // its aside below y=320 is empty: a press there lands on nothing but the scrim
  const input = page.getByTestId('search-input');
  await hydrated(page, 'search-input', 'onChange');
  await input.fill(`Scrim Target ${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('search-scrim')).toBeVisible();
  await expect(page.getByTestId('search-keys')).toContainText('Esc to close');
  expect(Math.round((await panel.boundingBox())!.width)).toBe(600);

  await page.mouse.click(150, 600);   // the scrim
  await expect(panel).toHaveCount(0);
  await expect(input).toHaveValue(`Scrim Target ${run}`);
  await input.focus();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(panel).toHaveCount(0);
  await expect(input).toHaveValue(`Scrim Target ${run}`);

  // A press on a row keeps the input focused (the panel would otherwise vanish under the pointer); the click opens it.
  await input.focus();
  const row = page.locator(`[data-testid="search-result"][data-result-id="${gameId}"]`);
  await row.hover();
  await page.mouse.down();
  await expect(input).toBeFocused();
  await expect(panel).toBeVisible();
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`/games/${gameId}$`));
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
});

test("Search: a row shows its disk, kind and facts; a help row its '?' tile; the API carries the four new fields", async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const plain = await seedDisk(u.orgId, { title: `Rowfacts ${run} Plain`, diskNo: 1, sha256: sha('p') });
  const typedSha = sha('t');
  const typed = await seedDisk(u.orgId, { title: `Rowfacts ${run} Typed`, diskNo: 1, sha256: typedSha });
  const entryId = await seedTosecEntry({
    setName: 'Commodore Amiga - Games - [ADF]', gameName: `Rowfacts ${run} Typed (1991)(Test)`, romName: `rowfacts-${run}.adf`,
    title: `Rowfacts ${run} Typed`, sortTitle: `rowfacts ${run} typed`, year: 1991,
  });
  await getDb().update(blobs).set({ tosecEntryId: entryId, matchState: 'matched', matchCheckedAt: new Date() })
    .where(eq(blobs.sha256, typedSha));

  const body = await (await page.request.get(`/api/search?q=${encodeURIComponent(`Rowfacts ${run}`)}`)).json();
  const byId = Object.fromEntries((body.titles as { id: string }[]).map((x) => [x.id, x]));
  expect(byId[plain.gameId]).toMatchObject({ authored: false, hasHd: false, hasHfe: false, kind: null });
  expect(byId[typed.gameId]).toMatchObject({ authored: false, hasHd: false, hasHfe: false, kind: 'Game' });

  await page.getByTestId('search-input').fill(`Rowfacts ${run}`);
  const row = (id: string) => page.locator(`[data-testid="search-result"][data-result-id="${id}"]`);
  await expect(row(plain.gameId).getByTestId('search-result-sub')).toHaveText(/^Unidentified · .*Uncategorized$/);
  await expect(row(typed.gameId).getByTestId('search-result-sub')).toHaveText(/^Game · /);
  await expect(row(plain.gameId).locator('[data-disk-color]')).toHaveAttribute('data-disk-color', 'cream');
  await expect(row(typed.gameId).locator('[data-disk-color]')).not.toHaveAttribute('data-disk-color', 'cream');

  await page.getByTestId('search-input').fill('preload');
  const help = page.locator('[data-testid="search-result"][data-result-kind="help"]').first();
  await expect(help.locator('[data-tile]')).toHaveText('?');
  await expect(page.getByTestId('search-group-help')).toHaveText('Help');
});

test('Search: an empty answer names what was searched', async ({ page }) => {
  await signUpFresh(page);
  const q = `Nothing Here ${runTag()}`;
  await page.getByTestId('search-input').fill(q);
  await expect(page.getByTestId('search-empty')).toHaveText(`Nothing in your library or Help matches “${q}”.`);
});
```

(Titles are matched as one ILIKE substring of the whole query, so each seeded title carries `<word> <run>` as a
contiguous run; the run tag keeps the shared DB's other rows and every help topic out.)

`e2e/contrast.spec.ts:263` (spec §9.4) — replace the probe selector line with
`const p = await probe(page, '[data-testid="search-result-sub"]');` and the comment above it ("The metadata line is
the second (last) span…") with
`// The sub line of the top, highlighted-by-default row (the DiskIcon now comes first in the row, so span:last-child`
`// would land on its label).`

- [ ] **Step 2: Run them to see them fail**

- `pnpm test src/lib/search-look.test.ts` → FAIL (`Cannot find module '@/lib/search-look'`).
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Search"` → 4 failed (no `combobox`
  role, no scrim, no `kind` in the API body, the old empty words).

- [ ] **Step 3: Implement**

`src/lib/queries.ts` — add, above `withDerived`:

```ts
/**
 * Each title's kind by the library's rule: kindFromSetName per disk (its blob's TOSEC set), pickKind over a title's
 * disks. Scoped by BOTH the game ids and the org on the disk row (a drifted disk is never read). Shared by the list
 * queries (withDerived) and the header search (search.ts, C5 spec §5.5).
 */
export async function kindsForGames(orgId: string, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const sets = await getDb().select({ gameId: disks.gameId, setName: tosecEntries.setName })
    .from(disks)
    .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
    .innerJoin(tosecEntries, eq(tosecEntries.id, blobs.tosecEntryId))
    .where(and(inArray(disks.gameId, ids), eq(disks.orgId, orgId)));
  const byGame = new Map<string, Array<string | null>>();
  for (const s of sets) {
    const list = byGame.get(s.gameId) ?? [];
    list.push(kindFromSetName(s.setName));
    byGame.set(s.gameId, list);
  }
  for (const id of ids) out.set(id, pickKind(byGame.get(id) ?? []));
  return out;
}
```

and in `withDerived`: replace the second `Promise.all` element (the `db.select({ gameId: disks.gameId, setName: … })`
query, lines 351–355) with `kindsForGames(orgId, ids),`, rename the destructured `sets` to `kinds`, delete the
`kindsByGame` block (lines 376–381), and in the returned row replace
`kind: pickKind(kindsByGame.get(r.id) ?? []),` with `kind: kinds.get(r.id) ?? null,`. (`kindFromSetName` / `pickKind`
stay imported: `getGameDetail` at ~line 803 still uses them.)

`src/lib/search.ts` — add imports `import { isHdAdfSql } from '@/lib/disk-format-sql';` and
`import { kindsForGames } from '@/lib/queries';`; extend the interface:

```ts
export interface SearchTitle {
  id: string; title: string; year: number | null; publisher: string | null; diskCount: number;
  /** This org's collections the title is in, in the rail's order; empty = Uncategorized (A3). */
  collections: string[];
  /** C5 (Ruling 24): so the panel draws the title's disk in its card's colour and leads its sub line with the kind. */
  authored: boolean; hasHd: boolean; hasHfe: boolean; kind: string | null;
}
```

in the titles `select({…})` add after `diskCount`:

```ts
        authored: games.authored,
        // Over the same org-scoped disk join as diskCount, so neither is fanned out (listGames' aggregates).
        hasHd: sql<boolean>`coalesce(bool_or(${isHdAdfSql()}), false)`,
        hasHfe: sql<boolean>`coalesce(bool_or(${disks.imageFormat} = 'hfe'), false)`,
```

and replace `const [titles, collectionHits] = await Promise.all([` with `const [rows, collectionHits] = await
Promise.all([`, and the final `return` with:

```ts
  // One small query over the <= 8 ids, by the library's rule (C5 spec §5.5).
  const kinds = await kindsForGames(orgId, rows.map((r) => r.id));
  return { titles: rows.map((r) => ({ ...r, kind: kinds.get(r.id) ?? null })), collections: collectionHits };
```

(`TITLE_LIMIT`'s comment "few enough that the panel never scrolls" becomes "Enough to choose from; the panel scrolls
past 620 px (C5 Ruling 26)".)

`src/lib/search-look.ts`:

```ts
// The header search's row words (C5 spec §5.4, §5.6): pure and client-safe -- search-box.tsx must not import
// '@/lib/search' (it reaches the database).

/** The title's kind; else Made here (authored); else Unidentified, so a cream disk is explained in words (Ruling 25). */
export function searchKindWord(t: { kind?: string | null; authored?: boolean }): string {
  return t.kind ?? (t.authored ? 'Made here' : 'Unidentified');
}

export function searchTitleSub(t: {
  kind?: string | null; authored?: boolean; year: number | null; publisher: string | null; diskCount: number;
  collections?: string[] | null;
}): string {
  const where = t.collections ? (t.collections.length > 0 ? `in ${t.collections.join(', ')}` : 'Uncategorized') : null;
  return [searchKindWord(t), t.year, t.publisher, `${t.diskCount} disk${t.diskCount === 1 ? '' : 's'}`, where]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');
}

/** Ruling 28: titles, collections and Help are all searched, so the line says so and names the query. */
export function searchEmptyText(q: string): string {
  return `Nothing in your library or Help matches “${q}”.`;
}
```

`src/components/shell/search-box.tsx` — keep the file header comment (lines 1–12), the fetch / abort / shortcut
logic (lines 40–169: state, `clearSearchState`, `reset`, the debounced fetch effect, the unmount abort, the `/` and
Cmd/Ctrl+K effect) and every comment in them, unchanged. Change:

1. Imports (lines 14–18) become:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SearchIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';
import { DiskIcon } from '@/components/ui/disk-icon';
import { matchHelpTopics } from '@/lib/help/match';
import { HELP_TOPICS, type HelpTopicId } from '@/lib/help/topics';
import { titleDiskColor } from '@/lib/library-look';
import { searchEmptyText, searchTitleSub } from '@/lib/search-look';
```

2. `interface SearchTitle` gains, after `collections: string[];`:
   `authored?: boolean; hasHd?: boolean; hasHfe?: boolean; kind?: string | null;` (optional on the client: a page
   loaded before a deploy may meet an older server for one request).

3. After `const EMPTY_RESULTS…` add:

```tsx
type Entry =
  | { kind: 'title'; item: SearchTitle }
  | { kind: 'collection'; item: SearchCollectionHit }
  | { kind: 'help'; item: { id: HelpTopicId } };

/** Where a row goes: the same three destinations as before (Ruling 23 makes them real links). */
function hrefOf(e: Entry): string {
  if (e.kind === 'title') return `/games/${e.item.id}`;
  if (e.kind === 'help') return `/help#${e.item.id}`;
  return `/library?collection=${e.item.id}`;
}

const GROUP_LABEL = { title: 'Titles', collection: 'Collections', help: 'Help' } as const;

function LetterTile({ letter }: { letter: string }) {
  return (
    <span data-tile className="flex size-[30px] items-center justify-center rounded-[8px] font-mono text-[12px] font-semibold"
          style={{ background: 'var(--track)', color: 'var(--muted)' }}>{letter}</span>
  );
}

/** A row's icon, name and sub line (spec §5.4). */
function rowParts(e: Entry): { id: string; name: string; sub: string; clamp: boolean; icon: React.ReactNode } {
  if (e.kind === 'title') {
    const t = e.item;
    const color = titleDiskColor({ id: t.id, hasHd: !!t.hasHd, hasHfe: !!t.hasHfe, kind: t.kind, authored: !!t.authored });
    return {
      id: t.id, name: t.title, sub: searchTitleSub(t), clamp: false,
      icon: <span data-disk-color={color}><DiskIcon size={30} color={color} hd={!!t.hasHd} stack={t.diskCount} mounted={false} /></span>,
    };
  }
  if (e.kind === 'collection') {
    const c = e.item;
    return { id: c.id, name: c.name, sub: `${c.gameCount} title${c.gameCount === 1 ? '' : 's'}`, clamp: false, icon: <LetterTile letter="C" /> };
  }
  const h = HELP_TOPICS[e.item.id];
  return { id: e.item.id, name: h.title, sub: h.short, clamp: true, icon: <LetterTile letter="?" /> };
}
```

4. After `const [focused, setFocused] = useState(false);` add
   `const [open, setOpen] = useState(false);   // Ruling 22: cleared on blur and by the scrim; the query stays`.

5. Type `flat` as `Entry[]` (replace the inline union in its declaration with `Entry`); delete `helpHits` (the groups
   below replace it).

6. After `const showPanel = …;` add:

```tsx
  const panelOpen = open && showPanel;

  // Ruling 26: the list scrolls past 620 px, so the arrows keep the highlighted option in view.
  useEffect(() => {
    if (!panelOpen) return;
    document.getElementById(`search-opt-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight, panelOpen]);
```

7. In `onChange`, add `setOpen(true);` as its first line.

8. `select(entry)` becomes:

```tsx
  function select(entry: Entry) {
    // The page's loading placeholders (loading.tsx) confirm the press landed.
    router.push(hrefOf(entry));
    // SearchBox lives in the layout, so navigating does not unmount it -- without reset() here the request for
    // whatever was typed keeps running and can repopulate the panel with the PREVIOUS search's rows the next time it
    // opens.
    reset();
    inputRef.current?.blur();
  }
```

9. In `onKeyDown`, the ArrowDown and ArrowUp branches start with `setOpen(true);` (after the `flat.length === 0`
   return), and the Enter branch reads `const entry = panelOpen ? flat[highlight] : undefined;`.

10. Replace the whole `return (…)` with:

```tsx
  const groups = (['title', 'collection', 'help'] as const)
    .map((kind) => ({ kind, rows: flat.map((entry, index) => ({ entry, index })).filter((r) => r.entry.kind === kind) }))
    .filter((g) => g.rows.length > 0);

  return (
    // Static from sm, so the panel anchors to the header (both shells' headers are `relative`); see the plan ruling in
    // C5 Task 5. Full width below sm, where the header wraps the box onto a line it shares with the icon buttons;
    // mr-2 keeps it 16px clear of them (they sit 8px apart).
    <div className="mr-2 w-full sm:w-auto">
      <div className="relative w-full sm:w-auto">
        <SearchIcon aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
                    style={{ color: 'var(--muted-2)' }} />
        <input
          ref={inputRef}
          data-testid="search-input"
          // LiveRefresh's typing() guard skips this box (src/components/shell/live-refresh.tsx): it lives in the
          // layout, and focus lingering here must not hold back live updates the way a rename field should.
          data-live-ok
          role="combobox"
          aria-expanded={panelOpen}
          aria-controls="search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={panelOpen && flat.length > 0 ? `search-opt-${highlight}` : undefined}
          aria-label="Search titles"
          title="Search titles — press / to focus"
          placeholder="Search titles"
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); if (q.trim() !== '') setOpen(true); }}
          onBlur={() => { setFocused(false); setOpen(false); }}
          // w-48 (not w-56): at w-56 the admin shell's centred pill and this input overlapped by 15px at 1280. The
          // focus ring is a box-shadow in the full --ring (>= 3:1 on the bar, WCAG 1.4.11).
          className="h-10 w-full rounded-[10px] border pl-9 pr-4 text-[14px] outline-none transition-colors placeholder:text-(--muted-2) focus-visible:ring-2 focus-visible:ring-(--ring) sm:w-48 sm:pr-9"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--ink)' }}
        />
        {/* The "/" shortcut, advertised while the box is idle (aria-hidden: the title attribute says it). Hidden below
            sm: a phone has no key to press. */}
        {!focused && q === '' && (
          <kbd aria-hidden data-testid="search-hint"
               className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border px-1.5 font-mono text-[11px] leading-[15px] sm:block"
               style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
            /
          </kbd>
        )}
      </div>

      {panelOpen && (
        // A light scrim from sm (spec §5.3). Not a focus trap: this is a combobox popup, not a dialog. A press on it
        // also blurs the input, which closes the panel on its own; the handler makes the close not depend on that.
        <div data-testid="search-scrim" aria-hidden onPointerDown={() => setOpen(false)}
             className="fixed inset-x-0 bottom-0 top-[72px] z-40 hidden sm:block" style={{ background: 'var(--search-scrim)' }} />
      )}

      {panelOpen && (
        <div
          data-testid="search-panel"
          // No press inside the panel may blur the input (Ruling 22): the row would vanish under the pointer.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-4 right-4 top-[calc(100%+4px)] z-50 flex flex-col overflow-hidden rounded-[16px] border sm:left-auto sm:right-7 sm:top-[64px] sm:w-[min(600px,calc(100vw-56px))]"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)', boxShadow: 'var(--shadow-card)' }}
        >
          {error ? (
            <div data-testid="search-error" className="px-[18px] py-4 text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</div>
          ) : showEmpty ? (
            <div data-testid="search-empty" className="px-[18px] py-4 text-[13px]" style={{ color: 'var(--muted)' }}>
              {searchEmptyText(trimmed)}
            </div>
          ) : (
            <div role="listbox" id="search-listbox" aria-label="Search results"
                 className="max-h-[min(620px,calc(100dvh-160px))] overflow-y-auto p-2">
              {groups.map((g) => (
                <div key={g.kind} role="group" aria-labelledby={`search-group-${g.kind}`}>
                  <div id={`search-group-${g.kind}`} data-testid={`search-group-${g.kind}`}
                       className="px-2.5 pb-1 pt-2.5 text-[12px] font-medium" style={{ color: 'var(--muted-2)' }}>
                    {GROUP_LABEL[g.kind]}
                  </div>
                  {g.rows.map(({ entry, index }) => {
                    const p = rowParts(entry);
                    const highlighted = index === highlight;
                    return (
                      <Link key={`${entry.kind}-${p.id}`} href={hrefOf(entry)} role="option" id={`search-opt-${index}`}
                            aria-selected={highlighted} tabIndex={-1}
                            data-testid="search-result" data-result-kind={entry.kind} data-result-id={p.id}
                            onMouseEnter={() => setHighlight(index)}
                            onClick={() => { reset(); inputRef.current?.blur(); }}
                            className="flex min-h-[50px] items-center gap-3 rounded-[10px] px-2.5 py-1.5"
                            style={highlighted ? { background: 'var(--surface-2)' } : undefined}>
                        <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center">{p.icon}</span>
                        <span className="flex min-w-0 flex-1 flex-col gap-px">
                          <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{p.name}</span>
                          {/* --muted, not --muted-2: 6.71:1 on the highlighted row's --surface-2. */}
                          <span data-testid="search-result-sub" className={`text-[12px]${p.clamp ? ' line-clamp-2' : ''}`}
                                style={{ color: 'var(--muted)' }}>{p.sub}</span>
                        </span>
                        {highlighted && (
                          <kbd aria-hidden className="hidden rounded-[6px] border px-[7px] font-mono text-[12px] sm:block"
                               style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>↵</kbd>
                        )}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <div data-testid="search-keys"
               className="hidden min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-[12px] sm:flex"
               style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
            {([['↑ ↓', 'to move'], ['↵', 'to open'], ['Esc', 'to close'], ['/', 'from anywhere']] as const).map(([k, w]) => (
              <span key={k}><kbd className="font-mono">{k}</kbd> {w}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
```

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test src/lib/search-look.test.ts src/lib/client-bundle-boundary.test.ts` → PASS (the boundary test proves
  `search-box.tsx` still reaches no `@/db`).
- `npx tsc --noEmit`; `pnpm lint` (two known); `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Search"` → `4 passed`.
- `PORT=3100 npx playwright test e2e/search.spec.ts --project=desktop` → `13 passed` (incl. `:271` empty state,
  `:313` cross-tenant, `:355` drifted disk).
- `PORT=3100 npx playwright test e2e/library-a3.spec.ts --project=desktop -g "search"` → `2 passed`.
- `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "search panel metadata"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/header-overlap.spec.ts --project=desktop` → `3 passed`.
- `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → `2 passed`.
- `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "bottom bar"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/library.spec.ts --project=desktop` → all pass (`--list`; `withDerived` now
  reads kinds through `kindsForGames`).

- [ ] **Step 5: Commit** — `src/lib/queries.ts`, `src/lib/search.ts`, `src/lib/search-look.ts`,
  `src/lib/search-look.test.ts`, `src/components/shell/search-box.tsx`, `e2e/contrast.spec.ts`,
  `e2e/c5-layout.spec.ts`, message `C5 Search: combobox, 600 px panel with scrim, disk and kind rows, kindsForGames`
  plus the two trailer lines.

---

### Task 6: Sign in & Create account — the split frame, the hero, the switch, the forms, the error words, the rename

**Files:**
- Create: `src/lib/auth-errors.ts`, `src/lib/auth-errors.test.ts`, `src/components/shell/logo.test.ts`,
  `src/app/(auth)/auth-switch.tsx`, `src/app/(auth)/auth-switch.test.ts`, `src/app/(auth)/auth-look.ts`,
  `src/app/(auth)/sign-in/sign-in-form.tsx`
- Modify: `src/components/shell/logo.tsx` (`tone`), `src/app/(auth)/layout.tsx`, `src/app/(auth)/sign-in/page.tsx`,
  `src/app/(auth)/sign-up/page.tsx`, `src/app/(auth)/sign-up/sign-up-form.tsx`, `docs/self-hosting.md:234`
- Modify (Ruling 35; every e2e use of the old label): `e2e/helpers.ts:105,107-112`, `e2e/admin-helpers.ts:39`,
  `e2e/admin-invites.spec.ts:54,75,89,166`, `e2e/invite.spec.ts:9,25,81`, `e2e/screenshots.shots.ts:132`,
  `e2e/c5-layout.spec.ts` (append)

**Interfaces:**
- Consumes (Task 1): tokens `--danger-strong`, `--on-ink-2`, `--on-ink-muted`. Existing: `DiskIcon`, `signIn`,
  `signUp` (`@/lib/auth-client`).
- Produces: `authErrorText(kind: 'in' | 'up', error: { code?: string | null; message?: string | null; status?: number } | null | undefined) → string`;
  `Logo` prop `tone?: 'dark' | 'light'`; `AuthSwitch({ current }: { current: 'in' | 'up' })`; `SignInForm()`; test ids
  `auth-hero`, `auth-switch`, `sign-in-form`, `sign-up-form`, `auth-error`; element ids `invite-code-hint`,
  `password-hint`; data attribute `data-hero` (`tagline` / `sub` / `foot`).

**Plan ruling** (spec §9.4 / Ruling 35 undercount): the old label has **ten** e2e sites in five files, not six:
`helpers.ts` ×2, `invite.spec.ts` ×2, `screenshots.shots.ts` ×1, `admin-helpers.ts` ×1 and `admin-invites.spec.ts`
×4 (all `/sign up/i`, which "Create account" does not match). Plus `invite.spec.ts:81` asserts the old h1
`Create your library`, which Ruling 30 renames to `Create your account`. All are changed here.

**Plan ruling** (Ruling 34 vs. the self-host stack): `signUpFresh` detected a rate-limited sign-up by better-auth's
`Too many requests`; the alert now says `Too many attempts. Wait a minute and try again.`, so the helper matches
`/Too many/` in the alert. `docs/self-hosting.md`'s troubleshooting row quotes the new words.

- [ ] **Step 1: Write the failing tests**

`src/lib/auth-errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { authErrorText } from '@/lib/auth-errors';

describe('authErrorText (C5 spec §6.3–6.4, Ruling 34)', () => {
  it("the board's words by code", () => {
    expect(authErrorText('in', { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401, message: 'Invalid email or password' }))
      .toBe('The email or password is not right.');
    expect(authErrorText('up', { code: 'INVALID_INVITE_CODE', status: 400, message: 'Invalid invite code' }))
      .toBe('That invite code is not valid, or it has been used.');
  });
  it('429 is the same sentence on both pages', () => {
    expect(authErrorText('in', { status: 429, message: 'Too many requests. Please try again later.' }))
      .toBe('Too many attempts. Wait a minute and try again.');
    expect(authErrorText('up', { status: 429 })).toBe('Too many attempts. Wait a minute and try again.');
  });
  it("anything else: better-auth's message, else the page's own fallback", () => {
    expect(authErrorText('up', { code: 'USER_ALREADY_EXISTS', status: 422, message: 'User already exists' })).toBe('User already exists');
    expect(authErrorText('in', { status: 500 })).toBe("Couldn't sign in. Try again.");
    expect(authErrorText('up', null)).toBe("Couldn't create the account. Try again.");
  });
  it("a code only maps on its own page", () => {
    expect(authErrorText('up', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'm' })).toBe('m');
    expect(authErrorText('in', { code: 'INVALID_INVITE_CODE', message: 'm' })).toBe('m');
  });
});
```

`src/components/shell/logo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Logo } from './logo';

describe('Logo tone (C5 spec §6.1)', () => {
  it('dark (default): ink body, cream label -- the header and favicon mark, unchanged', () => {
    const html = renderToStaticMarkup(createElement(Logo, { size: 34 }));
    expect(html).toMatch(/<path d="M5 0 H88[^"]*" fill="#24211B"/);
    expect(html).toContain('fill="#FBF8F1"');
  });
  it('light: surface body, ink lower label, for the ink hero', () => {
    const html = renderToStaticMarkup(createElement(Logo, { size: 34, tone: 'light' }));
    expect(html).toMatch(/<path d="M5 0 H88[^"]*" fill="#FFFDF8"/);
    expect(html).toMatch(/<path d="M12 48[^"]*" fill="#24211B"/);
  });
});
```

`src/app/(auth)/auth-switch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthSwitch } from './auth-switch';

describe('AuthSwitch (C5 spec §6.2, Ruling 31)', () => {
  it('is a nav of two links; only the current page is aria-current', () => {
    const html = renderToStaticMarkup(createElement(AuthSwitch, { current: 'up' }));
    expect(html).toContain('<nav aria-label="Account" data-testid="auth-switch"');
    expect(html).toMatch(/href="\/sign-in"[^>]*>Sign in</);
    expect(html).toMatch(/href="\/sign-up"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/sign-up"/);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });
});
```

`e2e/c5-layout.spec.ts` — append:

```ts
// ---- Sign in & Create account (spec §6) -----------------------------------------------------------------------

test('Sign in: the split page, the switch, the heading, and the error in words with focus kept on the button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/sign-in');
  await expect(page).toHaveTitle('Sign in · WebFloppy');
  await expect(page.getByTestId('auth-hero')).toBeVisible();
  await expect(page.getByTestId('auth-hero')).toContainText('Invite-only — ask the person who runs this server for a code.');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
  const sw = page.getByTestId('auth-switch');
  await expect(sw.getByRole('link', { name: 'Sign in' })).toHaveAttribute('aria-current', 'page');
  await expect(sw.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/sign-up');
  await hydrated(page, 'sign-in-form', 'onSubmit');
  await page.getByLabel('Email').fill(`nobody-${runTag()}@example.test`);
  await page.getByLabel('Password').fill('not-a-real-password');
  const submit = page.getByRole('button', { name: 'Sign in' });
  await submit.click();
  const err = page.getByTestId('auth-error');
  await expect(err).toHaveText('The email or password is not right.');
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(submit).toBeFocused();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('Create account: invite code first with its hint, the words for a bad code, the page title', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/sign-up?invite=ABCD2345');
  await expect(page).toHaveTitle('Create account · WebFloppy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your account');
  await expect(page.getByTestId('auth-switch').getByRole('link', { name: 'Create account' })).toHaveAttribute('aria-current', 'page');
  const ids = await page.getByTestId('sign-up-form').locator('input').evaluateAll((els) => els.map((e) => e.id));
  expect(ids).toEqual(['invite-code', 'email', 'password']);
  await expect(page.getByLabel('Invite code')).toHaveValue('ABCD2345');
  await expect(page.getByLabel('Invite code')).toHaveAccessibleDescription('Ask the person who runs this server for one. Each code works once.');
  await expect(page.getByLabel('Password')).toHaveAccessibleDescription('At least 8 characters.');
  await hydrated(page, 'sign-up-form', 'onSubmit');
  await page.getByLabel('Invite code').fill('AAAAAAAA');
  await page.getByLabel('Email').fill(`badcode-${runTag()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('auth-error')).toHaveText('That invite code is not valid, or it has been used.');
  await expect(page).toHaveURL(/\/sign-up/);
});
```

The rename (Ruling 35), every site:

- `e2e/helpers.ts:105` and `:110` → `await page.getByRole('button', { name: 'Create account' }).click();`
- `e2e/helpers.ts:108` → `const refused = page.getByRole('alert').filter({ hasText: /Too many/ });`
- `e2e/invite.spec.ts:9` → `await page.getByRole('button', { name: 'Create account' }).click();`
- `e2e/invite.spec.ts:25` → `await second.getByRole('button', { name: 'Create account' }).click();`
- `e2e/invite.spec.ts:81` → `expect(html).toContain('Create your account');`
- `e2e/screenshots.shots.ts:132` → `await page.getByRole('button', { name: 'Create account' }).click();`
- `e2e/admin-helpers.ts:39` → `await page.getByRole('button', { name: /create account/i }).click();`
- `e2e/admin-invites.spec.ts:54`, `:75`, `:89`, `:166` → `{ name: /create account/i }` (same receiver each line:
  `consumer`, `page`, `consumer`, `consumer`).

Then: `grep -rnE "'Sign up'|/sign up/i|Create your library|Too many requests" e2e`
Expected: no output.

- [ ] **Step 2: Run them to see them fail**

- `pnpm test src/lib/auth-errors.test.ts src/components/shell/logo.test.ts "src/app/(auth)/auth-switch.test.ts"` →
  FAIL (no `@/lib/auth-errors`, no `./auth-switch`; the light logo has an ink body).
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Sign in:|Create account:"` → 2 failed
  (no title, no hero).

- [ ] **Step 3: Implement**

`src/lib/auth-errors.ts`:

```ts
// The sign-in and sign-up error lines (C5 spec §6.3–6.4, Ruling 34): the board's words for the codes this app knows,
// better-auth's own English for any other. Pure and client-safe.

export type AuthErrorLike = { code?: string | null; message?: string | null; status?: number } | null | undefined;

export function authErrorText(kind: 'in' | 'up', error: AuthErrorLike): string {
  if (kind === 'in' && error?.code === 'INVALID_EMAIL_OR_PASSWORD') return 'The email or password is not right.';
  if (kind === 'up' && error?.code === 'INVALID_INVITE_CODE') return 'That invite code is not valid, or it has been used.';
  if (error?.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error?.message) return error.message;
  return kind === 'in' ? "Couldn't sign in. Try again." : "Couldn't create the account. Try again.";
}
```

`src/components/shell/logo.tsx` — signature becomes
`export function Logo({ size = 24, className, tone = 'dark' }: { size?: number; className?: string; tone?: 'dark' | 'light' })`;
add after `const detailed = size >= 40;`:

```tsx
  // `light` is the board's inverted mark for the ink sign-in hero (C5 spec §6.1): a surface body and an ink lower
  // label. The favicon (icon.svg) and the header keep the dark one.
  const body = tone === 'light' ? '#FFFDF8' : '#24211B';
  const label = tone === 'light' ? '#24211B' : '#FBF8F1';
```

and use `fill={body}` on the body `path` and the shutter-slot `rect`, `fill={label}` on the `M12 48` label path. Add a
line to the doc comment: `tone="light" draws it for an ink ground (the sign-in hero).`

`src/app/(auth)/auth-look.ts`:

```ts
// The sign-in / Create account form look (C5 spec §6.3–6.4). Shared by the two forms.
export const AUTH_FORM = 'flex flex-col gap-4';
export const AUTH_H1 = 'text-[34px] font-bold tracking-[-0.01em]';
/** One field: its label, the input, an optional hint -- siblings, so the label names the field and nothing more. */
export const AUTH_FIELD_WRAP = 'flex flex-col gap-1.5';
export const AUTH_LABEL = 'text-[13px] font-medium';
export const AUTH_FIELD =
  'h-[46px] w-full rounded-[12px] border px-3.5 text-[15px] font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const AUTH_FIELD_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
export const AUTH_HINT = 'text-[12px]';
export const AUTH_ERROR = 'rounded-[10px] px-3 py-2.5 text-[13px]';
export const AUTH_ERROR_STYLE = { background: 'var(--danger-bg)', color: 'var(--danger-strong)' } as const;
/** `text-white` keys globals.css' dark-button hover; the inline surface colour wins. aria-disabled, not disabled, so
 *  the clicked button keeps focus while the request runs (spec §6.5). */
export const AUTH_SUBMIT =
  'h-12 rounded-[12px] text-[15px] font-semibold text-white aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const AUTH_SUBMIT_STYLE = { background: 'var(--ink)', color: 'var(--surface)' } as const;
```

`src/app/(auth)/auth-switch.tsx`:

```tsx
import { Link } from '@/components/shell/link';

/**
 * Sign in / Create account (C5 spec §6.2, Ruling 31): two routes, so a nav of two links with aria-current, drawn as
 * the board's segmented tabs (.seg's surface look follows aria-current="page").
 */
export function AuthSwitch({ current }: { current: 'in' | 'up' }) {
  const item = 'seg-item h-9 px-[18px] text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
  return (
    <nav aria-label="Account" data-testid="auth-switch" className="seg self-start rounded-[12px] p-1">
      <Link href="/sign-in" aria-current={current === 'in' ? 'page' : undefined} className={item} style={{ color: 'var(--ink)' }}>
        Sign in
      </Link>
      <Link href="/sign-up" aria-current={current === 'up' ? 'page' : undefined} className={item} style={{ color: 'var(--ink)' }}>
        Create account
      </Link>
    </nav>
  );
}
```

`src/app/(auth)/layout.tsx` — keep the existing doc comment, add one paragraph to it
(`Since C5 (2026-10-25) the frame is the board's split page from lg (InfSignIn): an ink hero beside the form; below lg
a logo row above the form.`), and replace the function with:

```tsx
import { Logo } from '@/components/shell/logo';
import { DiskIcon } from '@/components/ui/disk-icon';

export default function AuthLayout({ children }: LayoutProps<'/'>) {
  const display = { fontFamily: 'var(--font-display)' };
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_560px]" style={{ background: 'var(--ground)' }}>
      <section aria-label="About WebFloppy" data-testid="auth-hero" className="hidden flex-col justify-between p-16 lg:flex"
               style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
        <div className="flex items-center gap-2.5">
          <Logo size={34} tone="light" />
          <span className="text-[24px] font-bold tracking-[-0.02em]" style={display}>webfloppy</span>
        </div>
        <div className="flex flex-col gap-7">
          {/* Decoration with neutral labels (Ruling 32). Each disk sits in its own positioned box: DiskIcon's root is
              position:relative, which would override an `absolute` class on it. */}
          <div aria-hidden className="relative h-[200px]">
            <div className="absolute left-0 top-8 -rotate-[10deg]">
              <DiskIcon size={130} color="red" stack={6} set="Your games" title="Six-disk game" />
            </div>
            <div className="absolute left-[130px] top-0 rotate-[4deg]">
              <DiskIcon size={150} color="blue" set="Saves come back" title="Version 8" />
            </div>
            <div className="absolute left-[290px] top-10 rotate-[14deg]">
              <DiskIcon size={120} color="green" wp set="Utilities" title="Workbench" />
            </div>
          </div>
          {/* A paragraph set large, not a heading (Ruling 30): the form's h1 is the page's one heading. */}
          <p data-hero="tagline" className="max-w-[560px] text-[52px] font-bold leading-[1.02] tracking-[-0.02em]" style={display}>
            Your Amiga disks, on a floppy drive that lives on the network.
          </p>
          <p data-hero="sub" className="max-w-[520px] text-[16px] leading-[1.55]" style={{ color: 'var(--on-ink-2)' }}>
            Keep the library here, mount any disk in DF0 from your phone, and get every save back as a new version.
          </p>
        </div>
        {/* Ruling 33: no external link (self-host parity), no our-deployment-only words. */}
        <p data-hero="foot" className="text-[13px]" style={{ color: 'var(--on-ink-muted)' }}>
          Invite-only — ask the person who runs this server for a code.
        </p>
      </section>
      <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col justify-center gap-6 px-4 py-10 sm:p-10 lg:min-h-0 lg:max-w-none lg:p-16">
        <div className="flex items-center gap-2.5 lg:hidden">
          <Logo size={26} />
          <span className="text-[20px] font-bold tracking-[-0.02em]" style={{ ...display, color: 'var(--ink)' }}>webfloppy</span>
        </div>
        {children}
      </main>
    </div>
  );
}
```

`src/app/(auth)/sign-in/page.tsx`:

```tsx
import { AuthSwitch } from '../auth-switch';
import { SignInForm } from './sign-in-form';

// A server page so it can carry its own title (Ruling 36); the form is the client part.
export const metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <>
      <AuthSwitch current="in" />
      <SignInForm />
    </>
  );
}
```

`src/app/(auth)/sign-in/sign-in-form.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth-client';
import { authErrorText } from '@/lib/auth-errors';
import {
  AUTH_ERROR, AUTH_ERROR_STYLE, AUTH_FIELD, AUTH_FIELD_STYLE, AUTH_FIELD_WRAP, AUTH_FORM, AUTH_H1, AUTH_LABEL, AUTH_SUBMIT,
  AUTH_SUBMIT_STYLE,
} from '../auth-look';

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const { error: err } = await signIn.email({ email, password });
    setBusy(false);
    if (err) { setError(authErrorText('in', err)); return; }
    // "/" sends the person to their chosen start page (src/app/page.tsx).
    router.push('/');
  }

  return (
    <form onSubmit={onSubmit} data-testid="sign-in-form" className={AUTH_FORM}>
      <h1 className={AUTH_H1} style={{ color: 'var(--ink)' }}>Welcome back</h1>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="email" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Email</label>
        <input id="email" type="email" autoComplete="email" required value={email}
               onChange={(e) => setEmail(e.target.value)} className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
      </div>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="password" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Password</label>
        <input id="password" type="password" autoComplete="current-password" required minLength={8} value={password}
               onChange={(e) => setPassword(e.target.value)} className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
      </div>
      {error && <p role="alert" data-testid="auth-error" className={AUTH_ERROR} style={AUTH_ERROR_STYLE}>{error}</p>}
      <button type="submit" aria-disabled={busy} className={AUTH_SUBMIT} style={AUTH_SUBMIT_STYLE}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
```

(`getByLabel('Email')` / `getByLabel('Password')` and the contrast probe's `label[for="email"]` /
`label[for="password"]` all resolve through `htmlFor`.)

`src/app/(auth)/sign-up/page.tsx` — add `import { AuthSwitch } from '../auth-switch';`,
`export const metadata = { title: 'Create account' };`, and return
`<><AuthSwitch current="up" /><SignUpForm initialInviteCode={…same expression…} /></>`.

`src/app/(auth)/sign-up/sign-up-form.tsx` — replace the imports of `Button`, `Input`, `Label` with
`import { authErrorText } from '@/lib/auth-errors';` and
`import { AUTH_ERROR, AUTH_ERROR_STYLE, AUTH_FIELD, AUTH_FIELD_STYLE, AUTH_FIELD_WRAP, AUTH_FORM, AUTH_H1, AUTH_HINT, AUTH_LABEL, AUTH_SUBMIT, AUTH_SUBMIT_STYLE } from '../auth-look';`;
in `onSubmit` add `if (busy) return;` after `e.preventDefault();`, rename the destructured `error` to `err` and
replace the error line with `if (err) { setError(authErrorText('up', err)); return; }`; replace the `return (…)` with:

```tsx
  return (
    <form onSubmit={onSubmit} data-testid="sign-up-form" className={AUTH_FORM}>
      <h1 className={AUTH_H1} style={{ color: 'var(--ink)' }}>Create your account</h1>
      {/* Ruling 35: the invite code first (board order), still prefilled from ?invite= on the server. */}
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="invite-code" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Invite code</label>
        <input id="invite-code" type="text" autoComplete="off" spellCheck={false} required value={inviteCode}
               aria-describedby="invite-code-hint" onChange={(e) => setInviteCode(e.target.value)}
               className={`${AUTH_FIELD} font-mono text-[16px] tracking-[0.12em]`} style={AUTH_FIELD_STYLE} />
        <p id="invite-code-hint" className={AUTH_HINT} style={{ color: 'var(--muted-2)' }}>
          Ask the person who runs this server for one. Each code works once.
        </p>
      </div>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="email" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Email</label>
        <input id="email" type="email" autoComplete="email" required value={email}
               onChange={(e) => setEmail(e.target.value)} className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
      </div>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="password" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Password</label>
        <input id="password" type="password" autoComplete="new-password" required minLength={8} value={password}
               aria-describedby="password-hint" onChange={(e) => setPassword(e.target.value)}
               className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
        <p id="password-hint" className={AUTH_HINT} style={{ color: 'var(--muted-2)' }}>At least 8 characters.</p>
      </div>
      {error && <p role="alert" data-testid="auth-error" className={AUTH_ERROR} style={AUTH_ERROR_STYLE}>{error}</p>}
      <button type="submit" aria-disabled={busy} className={AUTH_SUBMIT} style={AUTH_SUBMIT_STYLE}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
```

(Each hint is a sibling of its label, not inside it, so the field's name stays `Invite code` / `Password` —
`signUpFresh`'s `getByLabel` calls depend on that — and the hint reaches it only as its description.)

`docs/self-hosting.md:234` — the first cell becomes
`` `Too many attempts. Wait a minute and try again.` at sign-up or sign-in `` (the second cell unchanged).

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test src/lib/auth-errors.test.ts src/components/shell/logo.test.ts "src/app/(auth)"` → PASS.
- `npx tsc --noEmit`; `pnpm lint` (two known); `pnpm test` → PASS.
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "Sign in:|Create account:"` → `2 passed`.
- `PORT=3100 npx playwright test e2e/invite.spec.ts --project=desktop` → `5 passed`.
- `PORT=3100 npx playwright test e2e/auth.spec.ts --project=desktop` → `4 passed`.
- `PORT=3100 npx playwright test e2e/admin-invites.spec.ts --project=desktop` → `10 passed`.
- `PORT=3100 npx playwright test e2e/admin-guard.spec.ts --project=desktop` → `9 passed`.
- `PORT=3100 npx playwright test e2e/account.spec.ts --project=desktop` → `5 passed`.
- `PORT=3100 npx playwright test e2e/user-settings.spec.ts --project=desktop` → all pass (sign-in by the new form).
- `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "sign-in|sign-up"` → `2 passed`.
- A sample of `signUpFresh` callers: `PORT=3100 npx playwright test e2e/search.spec.ts --project=desktop -g "typing finds a title"`
  → `1 passed`; `PORT=3100 npx playwright test e2e/library-a3.spec.ts --project=desktop -g "collection, or Uncategorized"`
  → `1 passed`; `PORT=3100 npx playwright test e2e/help.spec.ts --project=desktop -g "lists every topic"` → `1 passed`.

- [ ] **Step 5: Commit** — the seven created files, `src/components/shell/logo.tsx`, `src/app/(auth)/layout.tsx`,
  `src/app/(auth)/sign-in/page.tsx`, `src/app/(auth)/sign-up/page.tsx`, `src/app/(auth)/sign-up/sign-up-form.tsx`,
  `docs/self-hosting.md`, `e2e/helpers.ts`, `e2e/admin-helpers.ts`, `e2e/admin-invites.spec.ts`, `e2e/invite.spec.ts`,
  `e2e/screenshots.shots.ts`, `e2e/c5-layout.spec.ts`, message `C5 Sign in & Create account: split frame, hero,
  switch, forms, error words, Create account rename` plus the two trailer lines.

---

### Task 7: States, contrast, phone, the help-text comment, the screenshots, the regression

**Files:**
- Modify: `e2e/contrast.spec.ts` (four tests), `e2e/c5-layout.spec.ts` (one phone test), `e2e/screenshots.shots.ts`
  (two new shots), `src/lib/help/topics.tsx` (the `preferences` source comment)
- Regenerate / add: `docs/screenshots/help.png`, `docs/screenshots/settings.png`, `docs/screenshots/sign-in.png`

**Interfaces:**
- Consumes: `legible()` (Task 4); every test id and element id of Tasks 2–6; `data-hero` (Task 6); `data-disk-color`
  (Task 5).
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

`e2e/contrast.spec.ts` — append (`seedDisk` and `runTag` are already imported):

```ts
// Phase C5 spec §11, measured on real elements.
test('the Settings pairs are legible: hint, intro, radios, save line, state words, nav, Delete account', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  await page.goto('/settings');
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  await page.mouse.move(0, 0);
  const hint = await page.getByTestId('pref-start-page').getAttribute('aria-describedby');
  await legible(page, 'settings', [
    ['row hint', `[id="${hint}"]`],
    ['intro', '[data-testid="preferences"] > p'],
    ['checked radio', '[data-testid="pref-start-page-library"]'],
    ['unchecked radio', '[data-testid="pref-start-page-devices"]'],
    ['save line', '[data-testid="prefs-state"]'],
    ['firmware state words', '[data-testid="fw-password-state"]'],
    ['nav item (current)', '[data-testid="settings-nav"] a[aria-current="true"]'],
    ['nav item', '[data-testid="settings-nav"] a:not([aria-current])'],
    ['Delete account h2', '#danger-heading'],
    ['Delete account… button', '[data-testid="account-delete-open"]'],
    ['email', '[data-testid="account-email"]'],
  ]);
});

test('the Help pairs are legible: eyebrow, body, body link, nav item and the current one, filter count', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  await page.goto('/help#network');
  await page.mouse.move(0, 0);
  await legible(page, 'help', [
    ['eyebrow', '[data-testid="help-section-network"] > span:first-child'],
    ['body paragraph', '[data-testid="help-section-network"] > div p'],
    ['body link', '[data-testid="help-section-network"] > div a'],
    ['nav item (current)', '[data-testid="help-nav"] a[aria-current="true"]'],
    ['nav item', '[data-testid="help-nav"] a:not([aria-current])'],
    ['group label', '[data-testid="help-group-drives"] > span'],
  ]);
  await hydrated(page, 'help-filter', 'onChange');
  await page.getByTestId('help-filter').fill('drive');
  await legible(page, 'help', [['filter count', '[data-testid="help-filter-count"]']]);
});

test('the Search panel pairs are legible: title, sub line on the highlighted row, group label, footer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Panel Pairs ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'e') });
  await page.getByTestId('search-input').fill(`Panel Pairs ${run}`);
  await expect(page.getByTestId('search-result').first()).toBeVisible();
  await legible(page, 'search', [
    ['title name', '[data-testid="search-result"] span:has(> [data-testid="search-result-sub"]) > span:first-child'],
    ['sub line (highlighted row)', '[data-testid="search-result-sub"]'],
    ['group label', '[data-testid="search-group-title"]'],
    ['key footer', '[data-testid="search-keys"] > span'],
  ]);
});

test('the Sign-in and Create account pairs are legible: switch, error, hint, and the hero at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sign-in');
  await legible(page, 'sign-in', [
    ['switch (current)', '[data-testid="auth-switch"] a[aria-current="page"]'],
    ['switch (other)', '[data-testid="auth-switch"] a:not([aria-current])'],
    ['hero tagline', '[data-hero="tagline"]'],
    ['hero sub line', '[data-hero="sub"]'],
    ['hero footer', '[data-hero="foot"]'],
  ]);
  await hydrated(page, 'sign-in-form', 'onSubmit');
  await page.getByLabel('Email').fill(`nobody-${runTag()}@example.test`);
  await page.getByLabel('Password').fill('not-a-real-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('auth-error')).toBeVisible();
  await legible(page, 'sign-in', [['error', '[data-testid="auth-error"]']]);
  await page.goto('/sign-up');
  await legible(page, 'sign-up', [['invite hint', '#invite-code-hint'], ['password hint', '#password-hint']]);
});
```

`e2e/c5-layout.spec.ts` — append:

```ts
// ---- Phone (spec §8: only what the boards and today's specs pin; the full pass is C7) -------------------------

test('at 390 px: Settings stacks with no list, Help folds its topics, Search has no scrim or keys, sign-in has no hero', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const noSideways = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto('/sign-in');
  await expect(page.getByTestId('auth-hero')).toBeHidden();
  await expect(page.getByTestId('auth-switch')).toBeVisible();
  await noSideways();

  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Phone Find ${run}`, diskNo: 1, sha256: sha('f') });
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav')).toBeHidden();
  expect(await page.locator('h1').evaluate((h) => getComputedStyle(h).fontSize)).toBe('30px');
  // A row stacks: its control sits under its words.
  const words = (await page.getByTestId('pref-start-page').locator('xpath=../..').locator('span').first().boundingBox())!;
  const control = (await page.getByTestId('pref-start-page').boundingBox())!;
  expect(control.y).toBeGreaterThan(words.y + words.height - 1);
  await noSideways();

  await page.goto('/help');
  await expect(page.getByTestId('help-nav-toggle')).toHaveText('Topics · 17');
  await noSideways();

  await page.getByTestId('search-input').fill(`Phone Find ${run}`);
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('search-scrim')).toBeHidden();
  await expect(page.getByTestId('search-keys')).toBeHidden();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await noSideways();
});
```

`e2e/screenshots.shots.ts` — at the top of the `capture the README screenshots` test, before
`inviteCode = await mintInviteCode();`, add:

```ts
  // --- signed out: the sign-in page (C5, Ruling 38) -------------------------
  await page.goto('/sign-in');
  await expect(page.getByTestId('auth-hero')).toBeVisible();
  await shoot(page, 'sign-in');
```

and after `await shoot(page, 'help');`, add:

```ts
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await shoot(page, 'settings', { tall: true });
```

`src/lib/help/topics.tsx` — the `preferences` source comment (the three `//` lines above `preferences: {`) gains, at
its end: `// components/ui/seg-radio-group.tsx (Start page, Library opens in, Titles per page are radio rows; C5 spec`
`// docs/superpowers/specs/2026-10-25-phase-c5-settings-help-search-signin-design.md §10).` — the topic's words do
not change (spec §10: every sentence in it stays true; check by reading it against the new Settings page once).

- [ ] **Step 2: Run them to see them fail or pass**

`PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Settings pairs|Help pairs|Search panel pairs|Sign-in and Create account pairs"`
→ 4 tests; they must be green after Step 3. If they already pass, the tokens and looks of Tasks 1–6 are right —
record the logged ratios in the report. A failure is fixed in the component's colour, never by lowering 4.5 or by
pointing the selector at a different element.

`PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "at 390 px"` → 1 test, same rule.

- [ ] **Step 3: Implement** — only what Step 2 shows is wrong. Expected: nothing (Tasks 2–6 built the looks to the
  spec's tokens). If a selector misses because the DOM differs (e.g. the intro `p` is not a direct child of the
  `preferences` section), adjust the selector to the real element the spec's §11 row names, and say so in the report.

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test` (whole), `npx tsc --noEmit`, `pnpm lint` (only the two known errors).
- `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Settings pairs|Help pairs|Search panel pairs|Sign-in and Create account pairs"` → `4 passed`.
- `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop -g "at 390 px"` → `1 passed`.

**Final regression** — every spec this area touches, ONE run at a time, each command under 9 minutes, checked with
`--list` first so each file is covered whole:

1. `PORT=3100 npx playwright test e2e/c5-layout.spec.ts --project=desktop` → `15 passed` (Settings 4, Help 3, "?" 1,
   Search 4, auth 2, phone 1).
2. `e2e/account.spec.ts` → `5 passed`; then `e2e/user-settings.spec.ts` → all (`--list`, 4 today).
3. `e2e/library-table.spec.ts -g "Library opens in Table"` → `1 passed`; `e2e/library-paging.spec.ts -g "Titles per page in Preferences"` → `1 passed`.
4. `e2e/help.spec.ts` → `6 passed` (the known order-dependent flake "keyboard: Enter opens the "?"…": rerun
   `-g "Enter opens"` alone once before reporting it); `e2e/help.mobile.spec.ts --project=mobile` → `1 passed`.
5. `e2e/devices-page.spec.ts -g "help tip"` → `1 passed`; `e2e/second-drive.spec.ts -g "help tip opens|focus stays on the radio"`
   → `2 passed`; `e2e/upload-staging.spec.ts -g "Send card names its one board"` → `1 passed`;
   `e2e/cover-override.spec.ts -g "390 px phone"` → `1 passed`.
6. `e2e/search.spec.ts` → `13 passed`.
7. `e2e/library-a3.spec.ts -g "search"` → `2 passed`; `e2e/shell.spec.ts` → `2 passed`; `e2e/header-overlap.spec.ts`
   → `3 passed`.
8. `e2e/auth.spec.ts` → `4 passed`; `e2e/invite.spec.ts` → `5 passed`; `e2e/admin-guard.spec.ts` → `9 passed`.
9. `e2e/admin-invites.spec.ts` → `10 passed`.
10. `e2e/contrast.spec.ts` → all pass (`--list`: 9 before C5, + 1 popover (Task 4) + 4 (this task); the sign-in /
    sign-up loop makes two tests from one `test(` call).
11. `e2e/states.spec.ts` → `5 passed`.
12. `e2e/mobile.spec.ts --project=mobile`: `--list` the titles and run them in `-g` slices, each under 9 minutes
    (suggested: `-g "bottom bar|library grid|Devices cards|HFE|file tree row|table view"`, then
    `-g "touch drag|Create ADF|file toolbar|drop strip|Demozoo"`, then the rest by name) → all pass except anything
    the C2–C4 ledgers already list as pre-existing elsewhere (record, do not chase).
13. `e2e/library.spec.ts` → all pass (`withDerived`'s kinds now come through `kindsForGames`).

Phone by hand (390 × 844, the dev server on 3100): Settings with a 60-character email (sign up with one) wraps the
email, the cards stack, the radiogroups wrap; the firmware row wraps (words, then state + switch); Help's articles are
`p-5` with 24 px titles; the "?" on Settings opens fully on screen; the search panel spans the width under the field;
`/sign-in` and `/sign-up` show the logo row, the switch and the form. Record what you saw.

Then `PORT=3100 pnpm screenshots` and compare `docs/screenshots/help.png`, `settings.png` and `sign-in.png` with
InfHelp, InfSettings and InfSignIn by eye (Help: the grouped list at the left, Boards' article card; Settings: the
section list, the four cards, the radio rows; Sign in: the ink hero with three disks beside the form). Commit ONLY
those three PNGs; the run regenerates the others too — restore each with `git checkout -- docs/screenshots/<name>.png`
(never with stash) and confirm `git status --short docs/screenshots` lists only `help.png`, `settings.png` and
`sign-in.png`.

- [ ] **Step 5: Commit** — `e2e/contrast.spec.ts`, `e2e/c5-layout.spec.ts`, `e2e/screenshots.shots.ts`,
  `src/lib/help/topics.tsx`, `docs/screenshots/help.png`, `docs/screenshots/settings.png`,
  `docs/screenshots/sign-in.png`, message `C5: contrast on four screens, phone check, help source note, screenshots`
  plus the two trailer lines.

---

## Self-review (against the spec)

- §1.1 `SegRadioGroup` + `radioAfterKey`, §1.2 `SideNav` + `currentSection`, §1.3 `flush`, §1.4 `bare`, §1.5 tokens →
  Task 1 (the `top` slot dropped: plan ruling).
- §2.1–2.6 Settings, §2.7 loading → Task 2 (skeleton without `PageSkeleton`: plan ruling). §9.4 Settings sites → Task 2.
- §3.1 groups, §3.2–3.5 the page, filter, arrival → Task 3 (zero-match nav and the one-nav `details`: plan rulings).
- §4 the "?" → Task 4 (+ its contrast test, §13 item 4).
- §5.1–5.6 search, §5.5 data, `contrast.spec:263` → Task 5 (panel anchored to the header; whole-panel mousedown: plan
  rulings).
- §6 auth, Ruling 35 rename (ten sites), `invite.spec:81`, the rate-limit words in the helper and the self-host doc →
  Task 6.
- §7 states (Settings loading in Task 2; error.tsx / signed-out unchanged), §8 phone, §10 help text, §11 contrast on
  the page, Ruling 38 screenshots, the full regression → Task 7.
- c5-layout counts: 4 after Task 2 → 7 after Task 3 → 8 after Task 4 → 12 after Task 5 → 14 after Task 6 → 15 after
  Task 7. If a count differs, recount with `--list` before calling it a failure.
