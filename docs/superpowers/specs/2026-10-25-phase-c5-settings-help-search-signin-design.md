# WebFloppy redesign, Phase C area 5: Settings, Help + "?" popover, Search, Sign in & sign up — design

Date: 2026-10-25. Roadmap Phase C step 5 (`2026-10-23-webfloppy-redesign-roadmap-design.md`): "Settings, Help + '?'
popover, Search, Sign in & sign up".

A **layout pass** over four screens whose behaviour already shipped: Settings is A2's (`/settings`, HANDOFF "A2
Settings / account": preferences that save as they change, change password, session count + Sign out everywhere else,
firmware password, delete account); Help and the "?" popover are context help's (HANDOFF "Context help", spec
`2026-10-05-context-help-design.md`, `src/lib/help/topics.tsx`); the header search is A3's (titles with their
collections, collections, a client-side Help group; `lib/search.ts`, `lib/help/match.ts`); sign-in and sign-up are
better-auth's email flows with the invite gate (`src/lib/auth.ts`). The same requests, words, guards and data, with one
additive change to the search response (Ruling 24). Builds on Phase B (tokens, `.glass-card`, `.wf-modal`, `.seg` /
`.seg-item`, `DiskIcon`, the header, `Logo`), C1 (`PageHeader size="lg"`, `titleDiskColor`, `StateCard`), C2 (`.seg--sm`,
the shared `Modal`, the roving radiogroup), C3/C4 (names wrap, focus to a heading with a visible ring, the per-area
`loading.tsx`, contrast measured on real elements). Nothing here re-invents them.

Written under the operator's unattended authorization of 2026-10-24. Every design call is mine and is listed under
**Rulings** at the end, with what it costs if wrong.

Target boards (session scratchpad `design-approved/`, all **Inf** = inferred, APPROVED): **`InfSettings`**,
**`InfHelp`** (its right column is the "?" popover's specimen, Ruling 17), **`InfSearch`**, **`InfSignIn`** (both its
`mode` values). `ModernHeader` is the shell and the two entry points (the search field with its `/` key, the gear;
Phase B built them), `InfStates` the states, `InfPhone` the phone frame (no screen of these four; §8).

Measured against `74004f5` (branch `feat/phase-c5-settings-help-search-signin`).

## 0. Invariants

- Every `data-testid` in §9.1 keeps its name and its meaning. Ids that move onto a different element, or onto a
  different control type, keep their names; the e2e sites that change are listed in §9.4.
- No schema change, no migration, no new route, no new package. Kept as shipped: `PATCH /api/me/prefs` (one field per
  change, `savePrefs`, the `pending` counter, the put-back on failure), `POST /api/me/prefs/firmware-skip-password`
  (`{password}`; its 401 / 429 / redirect handling), better-auth's `changePassword` (`revokeOtherSessions: true`),
  `revokeOtherSessions`, `listSessions`, `DELETE /api/me/account` (`{password, confirm: "DELETE"}`, the full-page
  `/sign-in` load after), `GET /api/search?q=` (debounce 150 ms, abort, the stale-response guard, `TITLE_LIMIT` 8,
  `COLLECTION_LIMIT` 4, `HELP_HIT_LIMIT` 3, org scoping), `signIn.email` → `router.push('/')`, `signUp.email` with the
  `inviteCode` extra field → `router.push('/library')`, the server-read `?invite=` prefill.
- Behaviour kept: `/` and Cmd/Ctrl+K focus the search (not from another input), `search-hint` shows only while idle,
  Escape clears and blurs, Enter opens the highlighted row, the empty line waits for a real response, `/help#<id>`
  anchors, every help topic on the one page, the "?" never triggers the control beside it (click/pointer stopped),
  the popover opens inside a modal without closing it, signed-out `/help` → `/sign-in`.
- Self-host parity: no external URL (the board's GitHub link is dropped, Ruling 33), no font, no our-deployment-only
  words ("while in testing" is ours, Ruling 33).
- Firmware, `wifi-floppy/`, the board and the Amiga are untouched.
- "Show both values of a state": every state renders a word in each of its values; an absent element never stands for
  one value. No `sr-only` element carries a width or layout utility.
- In-app dialogs only; never `window.confirm`.

## 1. Shared bits

### 1.1 `SegRadioGroup` (`src/components/ui/seg-radio-group.tsx`, new; Ruling 4)

The C2/C3 roving radiogroup as one component, used here by the three Preferences radiogroups only (C2's and C3's stay as
they are). Props: `value`, `options: {value, label}[]`, `onChange`, `aria-labelledby`, `aria-describedby?`, `testId`,
`disabled?`. Markup: `div role="radiogroup"` `class="seg seg--sm flex-wrap"` `data-testid={testId}` `data-value={value}`;
each option `button type="button" role="radio" aria-checked` `class="seg-item"` `data-testid={`${testId}-${value}`}`.
Keys: Arrow Right/Down next, Left/Up previous (wrapping), Home/End first/last — each moves focus AND selects (a
radiogroup's rule); a key with Alt, Ctrl or Meta is ignored; Tab enters on the checked radio, or on the first when none
is checked (the fallback tab stop). Pure helper `radioAfterKey(values, current, key, mods)` in
`src/lib/settings-look.ts`, unit-tested.

### 1.2 `SideNav` (`src/components/shell/side-nav.tsx`, new; Rulings 2, 13)

The 240/260 px section list both Settings and Help have on the boards. `nav aria-label={label}` `data-testid={testId}`;
groups of items, each group an optional label (`span` 12/500 `var(--muted-2)`, `px-3 pt-2.5 pb-1`) and a `ul`. An item is
a `Link` 38 px (Settings) or 34 px (Help), `px-3`, `rounded-[10px]`/`[9px]`, 14 px, flex `items-center`, text-left,
`overflow-wrap:anywhere` (names wrap: a two-line item grows): current = `var(--surface)` fill, `box-shadow: 0 0 0 1px
var(--line)`, 600 ink, `aria-current="true"`; other = transparent, 500, `var(--muted)` (Settings) / ink (Help); hover
`var(--track)`; `tone="danger"` = `var(--danger-fg)` text in both values. Focus `focus-visible:outline-2
focus-visible:outline-offset-2 focus-visible:outline-(--ring)`.

"Current" is the section in view (Ruling 2): an `IntersectionObserver` over the targets (`rootMargin: '0px 0px -60%
0px'`) marks the topmost intersecting one; before any scroll, the `location.hash` target, else the first. An item whose
`href` is another route (Settings' `About this server`) is never current. Clicking an in-page item lets the browser
jump, then focuses the target's heading (`tabIndex={-1}`, visible ring), so the keyboard continues from there.

`lg:sticky lg:top-6 lg:self-start`, `flex flex-col gap-0.5`. A `top` slot renders above the groups (Help's filter).

### 1.3 `PageHeader flush` (`src/components/shell/page-header.tsx`)

One prop: `flush` drops the outer `px-4 pb-5 pt-6 sm:px-7` (the page's column supplies the gutter), so the heading can
sit in the main column beside a `SideNav` as both boards draw it. Everything else (eyebrow, h1 `tabIndex={-1}`, the
`help` "?", `size="lg"`) unchanged. Settings and Help use `flush size="lg"`; no other page changes.

### 1.4 `SortSelect bare` (`src/components/prefs/sort-select.tsx`)

`bare` renders only the `select` (no own label) with `aria-labelledby` / `aria-describedby` from the caller, look:
`h-9 rounded-[10px] border px-3 text-[13px]`, `var(--surface)`, `var(--line)` border, ink; `min-w-[180px]`, `w-full`
below `sm`. Other callers unchanged.

### 1.5 Tokens (`src/app/globals.css`, webadf `:root`, a comment line each; Ruling 39)

| Token | Value | For |
|---|---|---|
| `--danger-line` | `#F2C9BF` | the Delete account card's ring and its button's border (decoration) |
| `--danger-strong` | `#9A2A1C` | the Delete account h2; the sign-in error text (7.59 surface / 6.17 danger-bg) |
| `--prose` | `#3E392F` | help article body text (11.28 surface) |
| `--on-ink-2` | `#E8E1D2` | the popover's text, the sign-in hero's sub line (12.33 on ink) |
| `--on-ink-muted` | `#A39B8B` | the sign-in hero's footer line (5.82 on ink) |
| `--on-ink-accent` | `#EE8A2A` | the popover's link (6.35 on ink) |
| `--search-scrim` | `rgb(36 33 27 / 0.12)` | the light scrim under the open search panel (decoration) |

Every other board literal maps to an existing token (`#7A7262` → `--muted-2`, `#F6F2E9` → `--surface-2`, `#EFE9DD` →
`--track`, `#F0EADF` → `--hairline`, `#B5541A` text → `--amber-text`, `#D3C8B2` → `--line-strong`, `#3FBF55` →
`--online-dot`, `#C4B9A2` → `--dash`).

## 2. Settings (`src/app/(app)/settings/page.tsx`; board: InfSettings)

### 2.1 Page

`export const metadata = { title: 'Settings' }` (the root template makes it `Settings · WebFloppy`; Ruling 36). Same
data (`requireOrg`, `getUserPrefs`, `listSessions`). Inside the page gutter (`px-4 sm:px-7`, `pt-6 pb-10`):
`lg:grid lg:grid-cols-[240px_minmax(0,860px)] lg:gap-8 lg:items-start`:

- **Aside** (from `lg` only; `hidden lg:block`; Ruling 2): `SideNav label="Settings sections" testId="settings-nav"`,
  one group `Your account`: `Preferences` → `#prefs`, `Sign-in & password` → `#account`, `Firmware updates` →
  `#firmware`, `About this server` → `/about` (a route link), `Delete account` → `#danger` (`tone="danger"`).
- **Main** (flex column, gap 20): `PageHeader flush size="lg" eyebrow="Your account" title="Settings"
  help="preferences"`, then the four cards in today's order. Each card: `section` with `id` (`prefs`, `account`,
  `firmware`, `danger`), `aria-labelledby` its h2, `scroll-mt-6`, `rounded-[20px] p-6` (`p-5` below `sm`),
  `var(--surface)`, `box-shadow: 0 0 0 1px var(--line)`. Every h2 is 17/600 ink, `tabIndex={-1}`, `rounded-[6px]`,
  `focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)`.

### 2.2 Preferences (`preferences-form.tsx`; `data-testid="preferences"` on the section)

- **Head row** (flex, `items-baseline`, `justify-between`, gap 12, `flex-wrap`): `h2#prefs-heading` `Preferences`, and
  `prefs-state` (`role="status" aria-live="polite"`, flex, gap 6, `items-center`, 12 px): a 6 px dot (`aria-hidden`) and
  A2's words — `All changes saved` (dot `--online-dot`, words `--success-fg`), `Saving…` (dot `--fetch-dot`, words
  `--muted`), `Couldn't save. Try again` (dot and words `--danger-fg`). Ruling 7.
- **Intro** 13 px `var(--muted-2)`, `mb-2`: `Yours alone, on every browser you sign in from. Others in your organization
  keep their own.` (A2's words, the board's too).
- **Rows**, each `grid grid-cols-[minmax(0,1fr)_auto] gap-5 items-center py-3.5 border-t 1px var(--hairline)`; below
  `sm` one column, gap 10 (the control under its words). Left: a column, gap 3 — the label `span` (`id`, 14/600 ink)
  and the hint `span` (`id`, 13 px `var(--muted-2)`). Right: the control, labelled by the label id and described by the
  hint id. In this order (Ruling 5):

| Row | Control | Id | Values (words) | Hint (A2's, except Ruling 6) |
|---|---|---|---|---|
| Start page | `SegRadioGroup` | `pref-start-page` | `library` Library · `devices` Devices · `upload` Upload | Where you land after signing in, and when you open the site’s address. |
| Library opens in | `SegRadioGroup` | `pref-library-view` | `grid` Grid · `table` Table | How the library first shows. The grid and table buttons on the library switch views without changing this. |
| Titles per page | `SegRadioGroup` | `pref-library-page-size` | `24` · `48` · `96` · `192` · `all` All (`pageSizeLabel`) | In the grid and the table alike. The pager under the library changes it too. |
| Library order | `SortSelect bare` | `pref-library-sort` | the nine `LIBRARY_SORT_OPTIONS` | The library and Uncategorized. A collection keeps its own order. |
| Disk file list order | `SortSelect bare` | `pref-browse-sort` | the six `BROWSE_SORT_OPTIONS` | Folders always come first. |

Selecting a radio (click, Space, or an arrow key) calls today's `change(...)` with that field; the group's
`data-value` and `aria-checked` follow `draft` (so a failed save puts the checked radio back, as the select did). No
Save button (`prefs-save` stays absent).

### 2.3 Sign-in & password (`account-security.tsx`; `data-testid="account-security"`)

`grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 gap-y-3 items-center` (one column below `sm`):

- `h2#account-heading` `Sign-in & password` (`col-span-full`, `mb-1.5`).
- **Email**: a column, gap 2: `Email` 13 px `var(--muted-2)`; `account-email` 14/500 ink, Geist (no longer mono),
  `overflow-wrap:anywhere`. Right: `password-change-open` **Change password…** (36 px `rounded-[9px] px-3`,
  `var(--surface)`, `1px solid var(--line)`, 13/500 ink; Ruling 9).
- **Browsers** (Ruling 8): a column, gap 2: `Browsers` 13 px `var(--muted-2)`; `sessions-count` 14/500 ink with A2's
  sentence (`Signed in on 2 browsers` / `Signed in on this browser only`). Right, only while more than one:
  `sessions-revoke` **Sign out everywhere else** (same look; `Signing out…` while busy). The revoke error (`role="alert"`,
  13 px `var(--danger-fg)`) spans the row under it.
- `password-done` (`role="status"`, 13 px `var(--success-fg)`, words unchanged) spans the row under Email after a change.
- **The form** `password-form` (open): replaces the Email row's button and spans the grid (`col-span-full`), column,
  gap 10, `max-w-[400px]`: three label/field pairs (labels 13/500 ink; fields 40 px `rounded-[10px] px-3`,
  `var(--surface)`, `1px solid var(--line)`, 14 px ink) — `Current password`, `New password`, `New password again` (ids
  and autocomplete unchanged); the line `At least 8 characters. Your other browsers will be signed out.` (12 px
  `var(--muted-2)`); `password-error` (`role="alert"`, 13 px `var(--danger-fg)`); buttons (gap 10): `password-save`
  **Change password** / `Changing…` (36 px ink fill, `var(--surface)` 13/600) and **Cancel** (36 px outline). Every
  rule and message is A2's.

### 2.4 Firmware updates (`firmware-password-setting.tsx`; `data-testid="firmware-prefs"`; Ruling 10)

`grid grid-cols-[minmax(0,1fr)_auto] gap-5 items-center` (one column below `sm`):

- Left, column, gap 3: `h2#firmware-heading` `Firmware updates`; the label `span#<labelId>` 14/500 ink `Don't ask for my
  password when updating board firmware`; the warning `p#<warnId>` 13 px `var(--muted-2)` (A2's words).
- Right, flex, gap 10, `items-center`: `fw-password-state` (`role="status"`, 12/600; `Password not asked` in
  `var(--amber-text)`, `Password asked` in `var(--muted)`), then `fw-skip-password`: `button role="switch"
  aria-checked={on || arming}` `aria-labelledby={labelId}` `aria-describedby={warnId}`, 44 × 26, `rounded-full p-[3px]`,
  flex; on: ink track, knob at the end; off: `var(--line-strong)` track with `1px solid var(--muted-2)`, knob at the
  start; knob 20 px `var(--surface)` with `0 1px 2px rgb(0 0 0 / .25)`; `disabled` while busy. A click runs today's
  `onChange` branches (arm / disarm / turn off).
- The confirm form (armed), `col-span-full`, flex, gap 10, `items-end`, `flex-wrap`: the label `Confirm with your
  password` (13/500 ink) over `fw-skip-password-input` (40 px field as §2.3), `fw-skip-password-confirm` **Turn off the
  password** / `Checking…` (36 px ink fill), **Cancel** (36 px outline), `fw-skip-password-error` (`role="alert"`, 13 px
  `var(--danger-fg)`, `basis-full`).

### 2.5 Delete account (`delete-account.tsx`; `data-testid="delete-account"`; Ruling 11)

Card ring `0 0 0 1px var(--danger-line)`. `grid grid-cols-[minmax(0,1fr)_auto] gap-5 items-center` (one column below
`sm`): left column, gap 3: `h2#danger-heading` `Delete account` in `var(--danger-strong)`; 13 px `var(--muted-2)` `Removes
your library, boards and uploads. Paired boards go back to setup mode. This cannot be undone.` (A2's words). Right:
`account-delete-open` **Delete account…** (38 px `rounded-[10px] px-3.5`, `var(--surface)`, `1px solid var(--danger-line)`,
13/600 `var(--danger-fg)`).

Open: the inline form (A2's, ids and words unchanged) replaces the button, `col-span-full`, column, gap 10,
`max-w-[400px]`: `Your password` + `account-delete-password`, `Type DELETE to confirm` + `account-delete-confirm` (40 px
fields as §2.3, the second mono), `account-delete-error` (`role="alert"`), `account-delete-submit` **Delete my
account** / `Deleting…` (36 px, `var(--danger-fg)` fill, white 13/600; disabled until both are filled, as today) and
**Cancel** (36 px outline).

### 2.6 Focus (C3/C4: never to `<body>`)

Opening a form focuses its first field (`password-current`, `fw-skip-password-input` — as today, `account-delete-password`).
Cancel and Escape (inside a form) close it and return focus to its opener (`password-change-open`, `fw-skip-password`,
`account-delete-open`). A successful password change returns focus to `password-change-open` (the done line
announces). A successful Sign out everywhere else removes the focused button, so focus goes to `#account-heading`.

### 2.7 Loading (`src/app/(app)/settings/loading.tsx`, new; Ruling 37)

`data-testid="settings-skeleton"` inside `PageSkeleton`, the page's grid: from `lg` a column of five 38 px bones (240 px
wide); the main column a 13 px eyebrow bone, a 44 px heading bone (30 px below `sm`), then four card bones
(`rounded-[20px]`, surface, line ring, `p-6`): the first with a 17 px heading bone and four `data-skeleton-row` 48 px
row bones, the others two line bones each.

## 3. Help page (`src/app/(app)/help/page.tsx` + `src/components/help/help-browser.tsx`, new; board: InfHelp)

### 3.1 Groups (`src/lib/help/topics.tsx`; Ruling 14)

`HELP_GROUPS` (exported, in display order), each `{ id, name, topics }`:

| id | name | topics |
|---|---|---|
| `drives` | Drives | `boards`, `display`, `second-drive`, `next-disk`, `nfc`, `write-protect` |
| `disks` | Library and disks | `library`, `write-back`, `disk-sets`, `hd-hfe`, `cover-image` |
| `network` | Amiga networking | `network`, `send`, `from-amiga` |
| `server` | This server | `preferences`, `own-server`, `about` |

`HELP_ORDER` becomes `HELP_GROUPS.flatMap((g) => g.topics)` (one source); `helpGroupOf(id)`. A unit test pins that every
`HELP_TOPICS` id is in exactly one group and that `HELP_ORDER` holds all seventeen.

### 3.2 Page

`metadata` unchanged (`Help`). `HelpBrowser` (client; topic bodies are client-safe — the header search already imports
the module) renders, inside the page gutter (`px-4 sm:px-7`, `pt-6 pb-10`), `lg:grid
lg:grid-cols-[260px_minmax(0,720px)] lg:gap-8 lg:items-start`:

- **Aside** (Ruling 13) — `SideNav label="Help topics" testId="help-nav"`, items 34 px, one group per `HELP_GROUPS`
  entry (`help-group-<id>`), items `#<topicId>` with the topic's title. Its `top` slot: the **filter** (§3.4). Below `lg`
  the aside sits above the articles as a full-width block: the filter, then a `details` (`help-nav-toggle` on its
  `summary`, 40 px, 14/600 ink, `Topics · 17` / while filtering `Topics · 3 of 17`) holding the same `nav`, closed by
  default.
- **Main** (flex column, gap 20): `PageHeader flush size="lg" title="Help" subtitle="What the less obvious parts of
  WebFloppy do, and why."` (today's words), then the articles in `HELP_ORDER`.

### 3.3 Article (one per topic; Ruling 12)

`article` `id={id}` `data-testid={`help-section-${id}`}` `aria-labelledby={`help-h-${id}`}` `scroll-mt-6`
`rounded-[20px] p-8` (`p-5` below `sm`), `var(--surface)`, `box-shadow: 0 0 0 1px var(--line)`, flex column, gap 16:

- eyebrow 13/500 `var(--muted-2)`: `` `Help · ${group.name}` ``;
- `h2#help-h-<id>` (`tabIndex={-1}`, focus ring as §2.1): Bricolage 30/700 (24 below `sm`), `leading-[1.05]`,
  `-0.02em`, ink, `overflow-wrap:anywhere` — the topic title;
- the body (`max-w-[68ch]`, flex column, gap 12, 15 px `leading-[1.6]` `var(--prose)`; the board's look applied by
  descendant classes on this wrapper, not by editing the seventeen bodies): `strong` ink 600; `em` as is; `ul`/`ol`
  `pl-[22px]` with 10 px between items; `a` `var(--amber-text)` 600 underlined (`underline-offset-2`), hover ink;
  `code` Geist Mono 14 px.

Topic bodies, their words and their source comments do not change in this area (§10).

### 3.4 Filter (Ruling 15)

In the aside's top slot, `mb-2`: a 38 px field (`rounded-[10px] px-2.5`, `var(--surface)`, `1px solid var(--line)`, flex,
gap 8) with a 14 px search glyph (`aria-hidden`, `var(--muted-2)`) and `input type="search"` `data-testid="help-filter"`
(`aria-label="Search help"`, `placeholder="Search help"` in `var(--muted-2)`, 13 px ink, transparent, borderless;
`aria-controls` the article list; Escape clears). Matching is `matchHelpTopics(q, Infinity)` (title, then short text,
every word; two characters at least — A3's rule). While a query of two or more characters is in it:

- the nav lists only the matching topics (a group with none is not shown) and the articles not matching get `hidden`;
- `help-filter-count` (`role="status"`, 12 px `var(--muted-2)`, under the field): `3 of 17 topics`;
- no match: `help-filter-empty` (13 px `var(--muted)`, in the main column where the articles were) `` `No topic matches
  “${q}”. Clear the search to see all 17.` `` and the nav shows its groups' names only.

Under two characters nothing is filtered and `help-filter-count` is absent (the full list is the other value, and the
`Topics · 17` summary says it on a phone).

### 3.5 Arrival

`/help#<id>` (the popover's link, a Help search result, an in-body link) lands on that article, its heading clear of
the top (`scroll-mt-6`); `help.spec` and `help.mobile.spec` pin `toBeInViewport()` of that heading. The nav marks it
current (§1.2).

## 4. The "?" (`src/components/help/help-tip.tsx`; board: InfHelp's right column)

### 4.1 Trigger (Ruling 18)

`Popover.Trigger` (same `data-testid`, `aria-label={`About ${t.title}`}`, the click/pointer stops): 24 × 24
`rounded-full`, `var(--track)` fill, centred text `?` (Geist 12/700, `var(--muted)`, `aria-hidden`; the lucide icon goes);
hover and open (`data-[popup-open]`) = ink fill, `var(--surface)` glyph; `focus-visible:outline-2
focus-visible:outline-offset-2 focus-visible:outline-(--ring)`. `className` passthrough unchanged, so the 35 call sites
keep their placement.

### 4.2 Popup

`help-pop-<topic>`: `w-[min(320px,calc(100vw-32px))]`, `rounded-[14px] p-4`, ink fill, no border, `box-shadow: 0 20px
40px -12px rgb(36 33 27 / .5)`, flex column, gap 10, `outline-none`; Positioner unchanged (`sideOffset 6`,
`collisionPadding 16`, `z-50`):

- `Popover.Title` 14/600 `var(--surface)` — the topic title;
- `Popover.Description` 13 px `leading-[1.5]` `var(--on-ink-2)` — `short`, unchanged;
- `help-more-<topic>`: `Link` to `/help#<topic>`, 13/600 `var(--on-ink-accent)`, hover underline: `Read the full topic`
  + `<span className="sr-only">: {t.title}</span>` (Ruling 19).

Focus, Escape (returns to the trigger), outside click and the inside-a-modal behaviour are Base UI's, as today.

## 5. Search (`src/components/shell/search-box.tsx`; board: InfSearch)

### 5.1 The field (Ruling 20)

The header's `search-input` stays the one input, with Phase B's size, place, placeholder `Search titles`,
`aria-label`, `title`, `search-hint` and `data-live-ok`. It becomes a combobox (Ruling 21): `role="combobox"`
`aria-expanded={panelOpen}` `aria-controls="search-listbox"` `aria-autocomplete="list"` `aria-activedescendant` = the
highlighted option's id while the panel is open.

### 5.2 Open and close (Ruling 22)

`panelOpen = open && showPanel` (today's `showPanel` rule unchanged: a query, and an error, a hit or a real empty
answer). New: the `open` flag — set by typing and by focusing the input with a query in it; cleared by the
input losing focus to anything outside the panel (the query stays; refocusing shows it again) and by a scrim click.
Escape (clears and blurs) and choosing a row (navigates, clears, blurs) are unchanged. Rows take `onMouseDown={(e) =>
e.preventDefault()}` so a click never blurs the input first.

### 5.3 Scrim and panel

- `search-scrim` (while open, from `sm`): `fixed inset-x-0 bottom-0 top-[72px] z-40`, `var(--search-scrim)`,
  `aria-hidden`; a pointer-down on it closes the panel (§5.2). Not a focus trap: this is a combobox popup, not a dialog.
- `search-panel`: from `sm` `fixed top-[64px] right-4 sm:right-7 z-50 w-[min(600px,calc(100vw-56px))]` (the board's
  600 px card overlapping the header's bottom edge by 8 px); below `sm` today's `absolute` under the wrapped input,
  `w-[calc(100vw-2rem)]`. `rounded-[16px]`, `var(--surface)`, `1px solid var(--line)`, `box-shadow:
  var(--shadow-card)`, flex column, `overflow-hidden`.
- **List** (`div role="listbox" id="search-listbox" aria-label="Search results"`, `p-2`,
  `max-h-[min(620px,calc(100dvh-160px))] overflow-y-auto`; Ruling 26): groups in today's order — Titles, Collections,
  Help — each `div role="group" aria-labelledby` its label (`search-group-<kind>`, 12/500 `var(--muted-2)`, `px-2.5
  pt-2.5 pb-1`, sentence case: `Titles`, `Collections`, `Help`). The highlighted option is scrolled into view
  (`block: 'nearest'`) when the arrows move it.
- **Footer** `search-keys` (from `sm`; `hidden` below: a phone has no keys), 40 px, `px-4`, flex, gap 16, `flex-wrap`,
  `border-t 1px var(--hairline)`, 12 px `var(--muted-2)`: `↑ ↓ to move` · `↵ to open` · `Esc to close` · `/ from
  anywhere`, each key in a `kbd` (Geist Mono). Ruling 27.

### 5.4 Rows (Rulings 23–25)

Each result is a `Link` (`href` = today's destination: `/games/<id>`, `/library?collection=<id>`, `/help#<id>`)
`role="option"` `id={`search-opt-${i}`}` `aria-selected={highlighted}` `tabIndex={-1}` `data-testid="search-result"`
`data-result-kind` `data-result-id` (kept); its click runs `reset()` and blur (the Link navigates); Enter in the input
pushes the highlighted row's `href` (as today). Look: `min-h-[50px] px-2.5 py-1.5`, flex, gap 12, `items-center`,
`rounded-[10px]`; highlighted `var(--surface-2)`; `onMouseEnter` highlights (as today).

- **Icon** (`aria-hidden`, 30 px): a title → `DiskIcon size={30} color={titleDiskColor(t)} hd={t.hasHd}
  stack={t.diskCount} mounted={false}` with no labels; a collection → a 30 px `rounded-[8px]` `var(--track)` tile with
  `C` (Geist Mono 12/600 `var(--muted)`); a help topic → the same tile with `?`.
- **Text** (flex-1, `min-w-0`, column, gap 1): the name 14/600 ink, `overflow-wrap:anywhere` (wraps; no ellipsis); the
  sub line `search-result-sub` 12 px `var(--muted)`:
  - title: `[kindWord, year, publisher, `${n} disk(s)`, `in A, B` | `Uncategorized`].join(' · ')` — `kindWord` = the
    title's kind (`Game`, `Demo`, …), else `Made here` when authored, else `Unidentified`;
  - collection: `14 titles` (today's);
  - help: the topic's `short`, `line-clamp-2`.
- **`↵`** (from `sm`, highlighted row only): a `kbd` 12 px Geist Mono `var(--muted)` on `var(--surface)`, `1px solid
  var(--line)`, `rounded-[6px] px-[7px]`, `aria-hidden`.

### 5.5 Data (Ruling 24)

`SearchTitle` gains `authored: boolean`, `hasHd: boolean`, `hasHfe: boolean`, `kind: string | null`. In `search()`: the
title query adds `authored: games.authored` and the library's own `hasHd` / `hasHfe` aggregates (`bool_or(isHdAdfSql())`,
`bool_or(disks.imageFormat = 'hfe')`, over the same org-scoped disk join, so the count is not fanned out); a second
query over the ≤ 8 ids reads the kinds by the library's rule (`kindFromSetName` per disk via its blob's set name,
`pickKind`), through a helper exported from `src/lib/queries.ts` (`kindsForGames(orgId, ids)`, the code `withDerived`
already runs, moved, not copied). The redeclared client interface in `search-box.tsx` gains the same four fields. A
cross-tenant or drifted disk stays invisible (`search.spec:313`, `:355` regression).

### 5.6 States

- Error: `search-error` (`px-2.5 py-2`, 13 px `var(--danger-fg)`) with today's words (`Search is unavailable` / `Could
  not reach the server`); no rows.
- Empty: `search-empty` (`px-2.5 py-2`, 13 px `var(--muted)`) `` `Nothing in your library or Help matches “${q}”.` ``
  (Ruling 28); still only after a real response.
- In flight: nothing new (the panel stays as it was, or absent before the first answer — `search.spec:271` pins it).

## 6. Sign in & sign up (`src/app/(auth)/…`; board: InfSignIn, `mode` in / up)

### 6.1 Frame (`(auth)/layout.tsx`; Ruling 29)

`div` `min-h-dvh` `lg:grid lg:grid-cols-[minmax(0,1fr)_560px]`, `var(--ground)`:

- **Hero** `section aria-label="About WebFloppy"` `data-testid="auth-hero"` (from `lg`; `hidden lg:flex`): ink fill,
  `p-16`, flex column, `justify-between`, `var(--surface)` text:
  - top: `Logo` 34 px drawn light (a `tone="light"` prop: surface body, ink lower label — the board's inverted mark;
    the favicon and header keep the dark one) + `webfloppy` Bricolage 24/700 `-0.02em`;
  - middle (column, gap 28): three `DiskIcon`s (`aria-hidden`, absolute in a 200 px box, rotated −10° / 4° / 14°,
    sizes 130 / 150 / 120): red `stack={6}` set `Your games` title `Six-disk game`, blue set `Saves come back` title
    `Version 8`, green `wp` set `Utilities` title `Workbench` (Ruling 32); then the tagline `p` (not a heading;
    Ruling 30) Bricolage 52/700 `leading-[1.02]` `-0.02em` `max-w-[560px]`: `Your Amiga disks, on a floppy drive that
    lives on the network.`; then 16 px `leading-[1.55]` `var(--on-ink-2)` `max-w-[520px]`: `Keep the library here,
    mount any disk in DF0 from your phone, and get every save back as a new version.`;
  - bottom: 13 px `var(--on-ink-muted)`: `Invite-only — ask the person who runs this server for a code.` (Ruling 33).
- **Main** `main` (`flex flex-col justify-center gap-6 p-16`; `px-4 py-10` below `sm`, `p-10` `sm`–`lg`;
  `max-w-[440px] mx-auto w-full lg:max-w-none`): below `lg` first a row (flex, gap 10) with `Logo` 26 px +
  `webfloppy` Bricolage 20/700 (`lg:hidden`), then the page.

### 6.2 The switch (Ruling 31)

`AuthSwitch current="in" | "up"` (`src/app/(auth)/auth-switch.tsx`, new): `nav aria-label="Account"`
`data-testid="auth-switch"`, `.seg` (`self-start`, `p-1`, `rounded-[12px]`, `var(--track)`), two `Link`s `.seg-item`
(36 px, `px-[18px]`, 14/600 ink): `Sign in` → `/sign-in`, `Create account` → `/sign-up`; the current one
`aria-current="page"` (`.seg`'s surface + shadow look).

### 6.3 Sign in (`sign-in/page.tsx` → server page + `sign-in-form.tsx`, client; Ruling 36)

The page exports `metadata = { title: 'Sign in' }` and renders `AuthSwitch current="in"` and `SignInForm`. The form
(`form` `data-testid="sign-in-form"`, flex column, gap 16; the old glass panel goes):

- `h1` Bricolage 34/700 `-0.01em` ink `Welcome back` (Ruling 30).
- `Email` — `label[for=email]` 13/500 ink, column gap 6, over `input#email type="email" autoComplete="email" required`:
  46 px, `rounded-[12px] px-3.5`, `var(--surface)`, `1px solid var(--line)`, 15 px ink, `focus-visible` ring.
- `Password` — `input#password type="password" autoComplete="current-password" required minLength={8}`, same look.
- `auth-error` (`role="alert"`, `px-3 py-2.5 rounded-[10px]`, `var(--danger-bg)`, 13 px `var(--danger-strong)`), words by
  code (Ruling 34): `INVALID_EMAIL_OR_PASSWORD` → `The email or password is not right.`; status 429 → `Too many attempts.
  Wait a minute and try again.`; anything else → `error.message`, else `Couldn't sign in. Try again.`
- Submit 48 px, `rounded-[12px]`, ink fill, 15/600 `var(--surface)`: `Sign in` / `Signing in…`.

No "Forgot your password?" line (Ruling 41).

### 6.4 Create account (`sign-up/page.tsx` + `sign-up-form.tsx`)

The page keeps its server-read `?invite=`, adds `metadata = { title: 'Create account' }` and `AuthSwitch current="up"`.
The form (`data-testid="sign-up-form"`), board order (Ruling 35):

- `h1` `Create your account`.
- `Invite code` — `input#invite-code type="text" autoComplete="off" spellCheck={false} required`, prefilled; 46 px,
  Geist Mono 16 px, `tracking-[0.12em]`, no placeholder; hint `p` (`aria-describedby`) 12 px `var(--muted-2)`: `Ask the
  person who runs this server for one. Each code works once.`
- `Email` (`autoComplete="email"`), `Password` (`autoComplete="new-password"`, `minLength={8}`) with hint `At least 8
  characters.` (12 px `var(--muted-2)`, `aria-describedby`).
- `auth-error`: `INVALID_INVITE_CODE` → `That invite code is not valid, or it has been used.`; 429 → as §6.3; else
  `error.message`, else `Couldn't create the account. Try again.`
- Submit `Create account` / `Creating…` (Ruling 35).

### 6.5 Focus

The h1 is not focused on load (the email field is the first stop; `autoFocus` not added — a phone keyboard popping over
the hero is worse). After an error, focus stays on the submit button and the alert announces itself.

## 7. States

- **Settings**: loading §2.7; a failed `listSessions` or prefs read: A1's `error.tsx` (`StateCard`), as today;
  signed out: `/sign-in` (`requireOrg`).
- **Help**: static page; the generic `(app)/loading.tsx` while the layout resolves (Ruling 37); no not-found.
- **Search**: §5.6.
- **Sign in / up**: no loading file; the form is the page. Errors §6.3–6.4.

## 8. Phone (390 px) — only what the boards and today's specs pin

Area 7 owns the phone pass. Here: Settings has no aside; the heading is 30 px; cards `p-5`; every row stacks (words,
then the control); radiogroups wrap (`flex-wrap`), selects full width; the switch row wraps (words, then state +
switch). Help: filter and the closed `Topics · 17` disclosure above the articles; articles `p-5`, h2 24 px; the "?"
popover fits (`help.mobile.spec`). Search: today's wrapped full-width field; the panel full width under it, no scrim, no
key footer, no `↵`. Sign in / up: no hero; the logo row, the switch, the form at `max-w-[440px]`. Nothing scrolls the
page sideways (`mobile.spec` regression).

## 9. Test ids

### 9.1 Kept (name and meaning)

Settings: `preferences`, `prefs-state` (same three texts), `pref-start-page`, `pref-library-view`,
`pref-library-page-size` (these three now the radiogroup, + `data-value`), `pref-library-sort`, `pref-browse-sort`
(still selects), `account-security`, `account-email`, `password-change-open`, `password-form`, `password-current`,
`password-new`, `password-confirm`, `password-error`, `password-save`, `password-done`, `sessions-count` (same texts),
`sessions-revoke`, `firmware-prefs`, `fw-skip-password` (now `role="switch"`; `.check()` / `.uncheck()` /
`toBeChecked()` still apply), `fw-password-state`, `fw-skip-password-input`, `fw-skip-password-confirm`,
`fw-skip-password-error`, `delete-account`, `account-delete-open`, `account-delete-password`, `account-delete-confirm`,
`account-delete-error`, `account-delete-submit`, `help-tip-preferences`; `prefs-save` stays absent.
Help: `help-section-<id>` (now the `article`), `help-tip-<topic>`, `help-pop-<topic>`, `help-more-<topic>`.
Search: `search-input`, `search-hint`, `search-panel`, `search-result` (+ `data-result-kind`, `data-result-id`; now a
link with `role="option"`), `search-empty`.
Shell: `settings-link`, `sign-out`, `about-link`, `wordmark-home`, `app-header`.
Auth (not ids, but pinned by specs): the labels `Email`, `Password`, `Invite code`; `label[for=email]`,
`label[for=password]`, `input#invite-code`; the submit `button[type=submit]` named `Sign in`; one `h1`.

### 9.2 New

`settings-nav`, `settings-skeleton`, `pref-start-page-<value>`, `pref-library-view-<value>`,
`pref-library-page-size-<value>`, `help-nav`, `help-nav-toggle`, `help-group-<id>`, `help-filter`, `help-filter-count`,
`help-filter-empty`, `search-scrim`, `search-group-<kind>`, `search-result-sub`, `search-error`, `search-keys`,
`auth-hero`, `auth-switch`, `sign-in-form`, `sign-up-form`, `auth-error`. Element ids: `prefs-heading`,
`account-heading`, `firmware-heading`, `danger-heading`, `help-h-<id>`, `search-listbox`, `search-opt-<i>`.

### 9.3 Removed

None.

### 9.4 Specs that change, and why

| Spec | Change |
|---|---|
| `account.spec.ts:30`, `:41` | `pref-library-view` `.selectOption('table')` → click `pref-library-view-table` (Ruling 4) |
| `account.spec.ts:33`, `:43` | `toHaveValue('table'|'grid')` → `toHaveAttribute('data-value', …)` |
| `user-settings.spec.ts:42`, `:55`, `:67` | `pref-start-page` `.selectOption(x)` → click `pref-start-page-<x>` |
| `library-table.spec.ts:274` | `pref-library-view` → click `pref-library-view-table` |
| `library-paging.spec.ts:114`, `:115` | `pref-library-page-size` `toHaveValue('24')` → `data-value`; `.selectOption('all')` → click `-all` |
| `helpers.ts:105`, `:110`; `invite.spec.ts:9`, `:25`; `screenshots.shots.ts:132` | button `Sign up` → `Create account` (Ruling 35) |
| `admin-helpers.ts:39` | `/sign up/i` → `/create account/i` |
| `contrast.spec.ts:263` | probe `[data-testid="search-result-sub"]` (the DiskIcon now comes first in the row, so `span:last-child` would hit its label) |
| `e2e/c5-layout.spec.ts` (new) | the plan's new tests (radiogroup keys, switch, nav current, help filter, search combobox + scrim + close rules + row icon colour, auth switch + error words) |
| `contrast.spec.ts` | new Settings, Help + popover, Search panel and Sign-in tests (§11) |
| `screenshots.shots.ts` | `help.png` regenerated; new `settings.png` and `sign-in.png` (Ruling 38) |

Regression only (no edit expected): `help` (all seventeen visible, `#boards` heading in view, Escape returns focus, the
"?" does not trigger its control), `help.mobile`, `devices-page -g "help tip"` (popover inside the modal),
`second-drive -g help`, `upload-staging -g help`, `cover-override -g phone`, `search` (all thirteen; its Enter, Escape,
`/`, Cmd+K, hint, abort, empty-state and tenancy cases), `library-a3 -g search` (the Help group and `in <collection>`),
`shell` (gear `aria-current`, `/help` title), `header-overlap`, `auth`, `invite`, `account`, `user-settings`,
`contrast -g "sign-in|sign-up|focus"`, `states`, `mobile`.

## 10. Help text (`src/lib/help/topics.tsx`; the text changes with what it describes)

- `preferences`: unchanged words. `Settings (the gear at the top) lists every preference in one place` stays true; the
  Firmware paragraph keeps `Password asked` / `Password not asked`; the option words are the same. The source comment
  adds `seg-radio-group.tsx` and this spec.
- `library`: `<em>Library opens in</em> under Preferences in Settings` stays true.
- The header search's own description lives in no topic; none changes. The Help page's structure is described nowhere
  in the topics.

## 11. Contrast pairs (WCAG 2.x; in `design-tokens.test.ts` and measured on the page in `contrast.spec.ts`)

| Pair | Ratio | Where |
|---|---|---|
| ink on `--surface` / `--surface-2` / `--track` / ground | 15.79 / 14.37 / 13.28 / 13.99 | labels, h2s, checked / unchecked radios, help nav, highlighted search row, auth switch, sign-in h1 |
| `--muted` on ground / `--track` / `--surface-2` | 6.53 / 6.20 / 6.71 | Settings nav items, the "?" glyph, letter tiles, search sub on the highlighted row |
| `--muted-2` on `--surface` / ground | 5.58 / 4.94 | hints, intro, eyebrows, group labels, search footer, auth hints |
| `--success-fg` `#1F6A2A` on `--surface` | 6.55 | `All changes saved`, `password-done` |
| `--danger-fg` `#B3341F` on `--surface` / ground / `--track` | 6.03 / 5.34 / 5.07 | Delete account… button, nav Delete account (idle / hovered), errors |
| `--danger-strong` `#9A2A1C` on `--surface` / `--danger-bg` | 7.59 / 6.17 | Delete account h2, `auth-error` |
| white on `--danger-fg` | 6.13 | Delete my account |
| `--amber-text` on `--surface` | 5.57 | `Password not asked`, help body links |
| `--prose` `#3E392F` on `--surface` | 11.28 | help body |
| `--surface` on ink | 15.79 | popover title, hero text, submit buttons, Change password |
| `--on-ink-2` `#E8E1D2` on ink | 12.33 | popover text, hero sub line |
| `--on-ink-accent` `#EE8A2A` on ink | 6.35 | `Read the full topic` |
| `--on-ink-muted` `#A39B8B` on ink | 5.82 | hero footer |

Measured on real elements: a Settings hint, a checked and an unchecked radio, `prefs-state`, the Delete account h2 and
button, the switch's state words; a help eyebrow, body paragraph, body link, a nav item and the current one, a "?"
trigger; the open popover's text and link; a search title, its sub line on the highlighted row, a group label, the
footer; the sign-in h1, a hint (sign-up), `auth-error`, the switch's two links, and at 1280 the hero tagline, sub line
and footer. Non-text: the switch's off track carries the `--muted-2` border (5.58 on the surface); the `--danger-line`
ring, the dots, the scrim and the disks are decoration beside words that carry the state.

## 12. Out of scope

- Search inside disks (the board's "Files inside disks" group; roadmap backlog) and any `blob_files` index.
- Forgot password by email (the board's `Reset it by email`; no mail provider, self-host parity; backlog).
- The header itself (field width, the phone search icon of InfPhone, the bottom bar): Phase B and area 7.
- Moving Settings' inline forms or the restore/confirm dialogs onto the shared `Modal`.
- The About page (`/about`) layout: only linked from the Settings nav.
- Rewriting the seventeen help bodies; per-topic "related" boxes.
- Migrating C2/C3's hand-rolled radiogroups onto `SegRadioGroup`.

## 13. Suggested task split

1. **Shared bits**: `SegRadioGroup` + `radioAfterKey` (unit), `SideNav` (current-section logic as a pure
   `currentSection(entries, hash)` helper, unit), `PageHeader flush`, `SortSelect bare`, the seven tokens + their pairs
   in `design-tokens.test.ts`. Testable alone (unit + a component render in vitest).
2. **Settings**: page grid, aside, the four cards, radiogroups, the switch, focus rules, `settings/loading.tsx`;
   the §9.4 Settings sites (`account`, `user-settings`, `library-table`, `library-paging`); new tests in
   `c5-layout.spec.ts` (keys, `data-value` after a failed save, switch `.check()`, nav current, focus after revoke).
3. **Help page**: `HELP_GROUPS` (+ unit), `HelpBrowser`, articles, filter, phone disclosure; `help` /
   `help.mobile` regression + filter tests.
4. **The "?" popover**: trigger and popup restyle; every `help-tip` site regression (`help`, `devices-page -g help`,
   `second-drive -g help`, `cover-override -g phone`); a contrast test of the open popover.
5. **Search**: combobox ARIA, open/close rules, scrim, 600 px panel, row icons and sub lines, footer, empty words;
   `search.ts` additive fields + `kindsForGames` (unit + `search.spec` regression incl. tenancy); `contrast.spec:263`.
6. **Sign in & sign up**: the frame, hero, `Logo tone="light"`, `AuthSwitch`, server page + client forms, error
   mapping (pure `authErrorText(kind, error)`, unit), the six button-name sites; `auth`, `invite`, `account`,
   `user-settings`, `admin-guard` regression.
7. **States, contrast, phone, screenshots, help text**: §11 contrast tests on all four screens, the 390 px checks,
   `help.png` / `settings.png` / `sign-in.png`, the `preferences` source comment.

## Rulings (operator to review)

1. **A layout pass on A2, context help, A3's search and the auth forms, nothing more.** Requests, words, guards and
   data stay; where the board and today disagree on behaviour, today wins and a ruling says so. Cost: the screens
   differ from the boards in the places below.
2. **Settings gets the board's sticky section list from `lg` only, and "current" follows the scroll** (the section in
   view; the hash or the first before any scroll). Below `lg` there is no list: four cards fit on a phone without one.
   `About this server` is a link to `/about` (the board lists it; no section holds it). Cost: a phone has no jump list.
3. **The Settings and Help headings sit in the main column through a `flush` `PageHeader`**, as both boards draw them,
   keeping the eyebrow, the `tabIndex={-1}` h1 and the `preferences` "?". Cost: one more prop on a shared component.
4. **Start page, Library opens in and Titles per page become the board's segmented radiogroups** (one shared
   `SegRadioGroup`, C2's key rules, `data-value`); arrows select and so save at each step. Ten e2e sites in four files
   click a radio instead of `selectOption`. Cost: spec churn; an arrow-key walk sends one save per step (the `pending`
   counter already settles them).
5. **Titles per page keeps its row** (the board has four rows; A2 added a fifth), placed after Library opens in. Cost:
   none.
6. **The two sort orders stay selects** (`SortSelect bare`): nine library orders and six file orders carry a direction
   the board's four and three segments drop. Their hints stay A2's; Disk file list order gains the board's `Folders
   always come first.` (true: `browse-sort.ts`). Cost: two controls look different from the board.
7. **The save line keeps A2's three words with the board's dot**, at the end of the Preferences heading row; the board's
   `Preferences saved` is not used (`All changes saved` is pinned by specs and Help). Cost: none.
8. **`Browsers` labels the session line, and the value keeps A2's sentence** (`Signed in on 2 browsers`), so
   `sessions-count`'s text is unchanged; `Sign out everywhere else` still shows only with two or more browsers — the
   sentence `Signed in on this browser only` is the other value in words. The email is no longer mono. Cost: the board
   splits `Signed in on` / `2 browsers`.
9. **Change password… and Delete account… keep their ellipsis and A2's inline forms** (the board is silent on what they
   open); not moved into a modal. Cost: the card grows when a form opens.
10. **Firmware updates is the board's switch with A2's meaning and label**: on = `Password not asked`, the label `Don't
    ask for my password when updating board firmware`, the state words beside it. The board's `Ask for the password
    before updating` (on = ask) would invert the stored meaning and `user-settings`' `check()`. The off track gets a
    `--muted-2` border (the board's is 1.63:1). Cost: the label reads differently from the board.
11. **The Delete account card takes the board's red ring and red heading; the words say it** (`--danger-line` ring is
    1.49:1, decoration). Cost: none.
12. **Every help topic stays on the one page, each in the board's article card**, instead of the board's one topic at a
    time: `/help#<id>` anchors from 35 "?" links and the search, `help.spec`'s "lists every topic", and the browser's
    find all depend on it. Cost: a long page where the board shows one article.
13. **The Help nav is the board's grouped topic list, sticky from `lg`, current by scroll**; below `lg` it folds into a
    closed `Topics · 17` disclosure under the filter. Cost: one tap more on a phone.
14. **Four groups in the board's order; Library joins Disks (renamed `Library and disks`) and Display joins Drives** —
    the board's groups leave out those two topics. `HELP_ORDER` becomes the groups flattened, one source. Cost: the
    page order changes (Drives first) and the header search's Help ranking follows it.
15. **The board's `Search help` filters by title and short text** (A3's matcher with no limit), hiding both list items
    and articles, with `3 of 17 topics` / `No topic matches …` in words. Cost: a word only in a topic's body is not
    found (browser find still finds it).
16. **No "Going the other way?" box under an article**: there is no per-topic link data, and the bodies already link
    each other inline. Cost: one cross-link the board drew is missing.
17. **The board's right-hand "Help on a control" column is the popover's specimen, not page content.** Cost: none.
18. **The "?" is the board's round `--track` button with a text `?`, but 24 px, not 22** (WCAG 2.2 target size), ink
    when hovered or open (both values visible); it keeps `About <title>` as its name. Cost: 2 px larger than drawn.
19. **The popover is the board's ink card; its link reads `Read the full topic`** with the title as screen-reader text
    (`: Library`), so the link's name is unique across a page with many "?". Cost: none.
20. **The header field stays the search input; the board's 600 px card opens under it with a light scrim**, without the
    board's second input inside the card (two inputs would split focus, `/`, Cmd+K and every `search-input` test). The
    field keeps Phase B's width. Cost: the card's top row (query + `Esc`) is not drawn; `Esc to close` moves to the
    footer.
21. **The search becomes a real combobox** (`role="combobox"`, a `listbox`, `option`s, `aria-activedescendant`); options
    are not tab stops. The board is silent; today a screen reader hears unlabelled buttons. Cost: Tab no longer walks
    the rows (arrows do, as today).
22. **The panel closes when focus leaves the search or the scrim is clicked, keeping the query**; focusing the field
    shows it again. Today it stayed open behind whatever you clicked. Escape still clears. Cost: none expected; one more
    state.
23. **Results are links** (`role="option"`), so a title can be opened in a new tab; Enter still pushes the highlighted
    one. Cost: none.
24. **`/api/search` adds four fields per title (`authored`, `hasHd`, `hasHfe`, `kind`)** — additive, same org scope, one
    small extra query for kinds — so a title's disk in the panel is the colour of its card (`titleDiskColor`) and the
    sub line can lead with the kind, as the board's `Game · 1991 · …`. The roadmap's "no data change" holds: no schema,
    no stored data. Cost: one more query per search (≤ 8 ids).
25. **Collections and Help rows get the board's letter tiles (`C`, `?`); names wrap, help text clamps to two lines**
    (C3 Ruling 19; the board's ellipsis is not used). An untyped title's sub line says `Unidentified` (or `Made here`),
    so a cream disk is explained in words. Cost: a long name takes two lines.
26. **The panel scrolls past 620 px and keeps the highlighted row in view**: with icons, 15 rows no longer fit the old
    "never scrolls" height. Cost: none.
27. **The key footer and the `↵` badge show from `sm` only** (a phone has no keys), with `Esc to close` added. Cost:
    none.
28. **The empty line names what was searched**: `Nothing in your library or Help matches “q”.` (`No titles match` was
    wrong once collections and Help joined). Cost: words differ from A3.
29. **Sign in and Create account take the board's split page from `lg`**; below it the hero folds to a logo row above
    the form. Cost: phones never see the hero.
30. **The form's heading is the page's h1** (`Welcome back` / `Create your account`); the hero tagline is a paragraph
    set large. The board makes the tagline the h1, which would greet a screen reader with marketing before the form.
    Cost: none (the contrast probe of `h1` reads ink on the ground, 13.99).
31. **The Sign in / Create account switch is a `nav` of two links with `aria-current`**, styled as the board's segmented
    tabs: they are two routes, not two panels of one page. Cost: no tab-key semantics (none needed).
32. **The hero disks carry neutral labels** (`Your games`, `Version 8`, `Workbench`) rather than the board's real game
    titles. Cost: less evocative.
33. **The hero footer says `Invite-only — ask the person who runs this server for a code.`** with no link: the board's
    GitHub URL is external (parity rule) and `/help#own-server` needs a sign-in; `while in testing` describes only our
    deployment. Cost: a self-hoster who wants the source finds it elsewhere.
34. **Sign-in and sign-up errors take the board's words by code** (`INVALID_EMAIL_OR_PASSWORD`, `INVALID_INVITE_CODE`,
    429), falling back to better-auth's message; specs assert only `role="alert"`. Focus stays on the submit. Cost: a
    new better-auth code shows its own English.
35. **The sign-up submit reads `Create account` and the invite code comes first** (board), still prefilled from
    `?invite=`, with the board's hint. Six e2e call sites rename the button. Cost: churn in the shared sign-up helper.
36. **Sign-in becomes a server page plus a client form** (as sign-up already is) so it can export `metadata`; Settings
    and Create account get titles too. Cost: none.
37. **`settings/loading.tsx` gives Settings its own skeleton; Help keeps the generic one** (it reads no data). Cost: one
    more skeleton to keep in step.
38. **`help.png` is regenerated; `settings.png` and `sign-in.png` are new** (desktop 1280). Cost: two more PNGs.
39. **Seven new tokens** (§1.5); every other board literal maps to an existing token. Cost: none.
40. **No migration, no new route, no new package.** Nothing in this area needs one. Cost: none.
41. **No `Forgot your password?` line** under the sign-in form: there is no reset path at all yet (email reset is
    backlog; no admin reset exists), so any sentence would promise one. Cost: no hint for a forgotten password.
