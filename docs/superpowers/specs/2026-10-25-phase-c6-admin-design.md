# WebFloppy redesign, Phase C area 6: Admin (Overview, Users, Invites, Scan, Firmware) — design

Date: 2026-10-25. Roadmap Phase C step 6 (`2026-10-23-webfloppy-redesign-roadmap-design.md`): "Admin (Overview, Users,
Invites, Scan, Firmware)".

A **layout pass** over the super-admin plane whose behaviour already shipped: the plane itself (HANDOFF "Super-admin
plane", spec `2026-08-31-super-admin-plane-design.md`: `requireSuperAdmin()` in the layout and in every `/api/admin`
route, the redirect-not-404 non-disclosure, the typed-email user delete, the allowlist 409), TOSEC / OpenRetro / Demozoo
scanning, the firmware registry, and A7 Admin on top (HANDOFF "A7 Admin", spec `2026-10-24-admin-a7-design.md`, merge
4c37c0e: board tiles, Boards by firmware, Needs attention; invite Revoked state, Used by, Copy code / Copy link; firmware
Current / Release / Test tags, boards per version, GitHub link, paging, Promote to release; the Demozoo status line). The
same requests, words where pinned, guards and data, with two additive reads (Rulings 14, 30). Builds on Phase B (tokens,
`.seg` / `.seg-item`, `TopNav`, `SettingsLink`, `SignOutButton`, the admin header frame), C1 (`PageHeader size="lg"`,
`StateCard`), C2 (the shared `Modal`), C3/C4 (names wrap, focus to a heading with a visible ring, contrast measured on
real elements), C5 (`legible()`, busy = `aria-disabled` + guard, try/catch/finally). Nothing here re-invents them.

Written under the operator's unattended authorization of 2026-10-24. Every design call is mine and is listed under
**Rulings** at the end, with what it costs if wrong.

Target boards (session scratchpad `design-approved/`, all **Inf** = inferred, APPROVED): **`InfAdminOverview`**,
**`InfAdminUsers`**, **`InfAdminInvites`**, **`InfAdminScan`**, **`InfAdminFirmware`**. `ModernHeader` (`active="admin"`)
is the shell, `InfStates` the states, `InfPhone` the phone frame (no admin screen; §9).

Measured against `39b33bd` (branch `feat/phase-c6-admin`).

## 0. Invariants

- Every `data-testid` in §10.1 keeps its name and its meaning. Ids that move onto a different element keep their names;
  the e2e sites that change are listed in §10.4.
- No schema change, no migration, no new route, no new package. Kept as shipped: `requireSuperAdmin()` in
  `(admin)/layout.tsx` (redirect `/sign-in` signed out, `/library` for a non-admin) and in every `/api/admin` route;
  `DELETE /api/admin/users/:id` (409 allowlisted), `POST /api/admin/invites`, `DELETE /api/admin/invites/:code` (409
  consumed, 404 unknown, 204), `POST /api/admin/scan`, `POST /api/admin/tosec` (raw text body, files one at a time),
  `POST /api/admin/openretro` (binary body), `POST /api/admin/firmware/:id/promote` (`{notes}`, `redirect: 'manual'`, the
  signed-out / 409 / error-code handling), `/api/cron/scan`'s secret. Every toast's words.
- **The destructive guards are not weakened.** User delete keeps its centered modal and the exact typed-email gate
  (`typed === email`, no trim, no case fold) and names the blast radius in numbers; Promote keeps its modal, the notes
  rule (`looksLikeTestBuild`, 1–2000 characters) and the server's sha256 / bench-marker checks; Revoke and Run now keep
  no confirm, as shipped (Ruling 20). Nothing is drawn over another table row.
- The admin plane renders no drive chips and no drive menu, and keeps the non-disclosure: no admin markup reaches a
  non-admin (`admin-guard.spec`, `drive-chips.spec:449`).
- Self-host parity: no new external URL, no font; the existing GitHub release link stays `WEBADF_FIRMWARE_REPO`-driven
  (Ruling 33).
- Firmware, `wifi-floppy/`, the board and the Amiga are untouched.
- "Show both values of a state": every state renders a word in each of its values; an absent element never stands for
  one value. No `sr-only` element carries a width or layout utility.
- In-app dialogs only; never `window.confirm`. Busy controls are `aria-disabled` + a guard, never native `disabled`;
  every request sits in try/catch/finally so a dropped connection never leaves a control busy.
- `pnpm lint` passes: the two `react-hooks/purity` errors in this area (`admin/page.tsx:51`, `admin/scan/page.tsx:167`)
  are fixed here (Ruling 3) and no new one is added.

## 1. Shell and shared bits

### 1.1 Admin header (`src/app/(admin)/layout.tsx`; board: `ModernHeader active="admin"`; Ruling 1)

Same `header data-testid="admin-header"`, same 72 px bar, wrapper offsets, below-`sm` wrap and fixed bottom bar, same
`2xl` centring rule for the pill (the comment block stays true). Content, in order:

- the wordmark span (unchanged: `Logo 24` + `webfloppy` + ` admin` in `var(--muted)`);
- the pill clamp holding **`TopNav showAdmin`** (the app's Main nav: Library, Devices, Upload, Help, Admin) instead of
  `AdminNav`; `Admin` is current on every `/admin*` page (`TopNav`'s `startsWith`);
- the right group: `SearchBox`, `admin-email` (same visibility: below `sm` and from `xl`), `SettingsLink` (the gear),
  `SignOutButton`. **Back to library** goes (Library is in the nav).

### 1.2 `AdminSections` (`src/components/admin/admin-nav.tsx`, rewritten; board: `nav "Admin sections"`; Ruling 2)

`nav aria-label="Admin sections"` `data-testid="admin-sections"` `class="seg w-max"` inside a clamp `max-w-full
overflow-x-auto` (`self-start`): five `Link`s `.seg-item whitespace-nowrap` — Overview `/admin`, Users `/admin/users`,
Invites `/admin/invites`, Scan `/admin/scan`, Firmware `/admin/firmware`; exact-match `aria-current="page"` (today's
rule: `/admin` is a prefix of the others). `.seg`'s look is the board's (track, 34 px items, current = surface + shadow,
600 ink; others 500 `var(--muted)`). No count badge (Ruling 2).

### 1.3 `AdminPageHead` (`src/components/admin/admin-page-head.tsx`, new)

`PageHeader size="lg" eyebrow="Admin · this server"` + the caller's `title`, `subtitle`, `subtitleFont`, `actions`, then
`AdminSections` under it (`px-4 sm:px-7 pb-6`). Every admin page starts with it. Page body: `px-4 sm:px-7 pb-10`, flex
column, gap 24 (`gap-6`).

### 1.4 `PageHeader` (`src/components/shell/page-header.tsx`; Rulings 4, 5)

- `subtitleFont?: 'mono' | 'sans'` (default `mono`, today's look): `sans` = Geist 14 px `var(--muted)` (`mt-1`). Overview
  and Scan use `sans` (their board subtitles are sentences); Users, Invites, Firmware keep mono 13.
- The h1's `focus:outline-none` becomes `rounded-[6px] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)`:
  the h1 is only ever focused programmatically (the fallback after a removal), and C3–C5 give that target a visible ring.

### 1.5 Token (`src/app/globals.css`, webadf `:root`; Ruling 34)

| Token | Value | For |
|---|---|---|
| `--bar-ok` | `#4F9D4A` | the green fill of the coverage and firmware bars (decoration; the number beside it carries the value) |

Every other board literal maps to an existing token: `#7A7262` → `--muted-2`, `#5B5446` → `--muted`, `#EFE9DD` →
`--track`, `#F6F2E9` → `--surface-2`, `#F0EADF` → `--hairline`, `#C4B9A2` → `--dash`, `#E9A23B` → `--fetch-dot`,
`#3FBF55` → `--online-dot`, `#9CCB98` → `--mounted-line`, `#FBEBD3` / `#7A4A08` → `--warning-bg` / `--warning-fg`
(also for the board's `#5A3606` note text), `#DDF0DC` / `#1F6A2A` → `--success-bg` / `--success-fg`, `#F8E1DB` /
`#9A2A1C` → `--danger-bg` / `--danger-strong`, `#B3341F` → `--danger-fg`, `#B5541A` text and `#8A3A0E` → `--amber-text`
(Ruling 35), `#A39B8B` (disabled) → `--muted-2` on `--surface-2`.

### 1.6 Titles (Ruling 36)

Each page exports `metadata`: `Admin · Overview`, `Admin · Users`, `Admin · Invites`, `Admin · Scan`, `Admin ·
Firmware` (the root template appends ` · WebFloppy`).

### 1.7 Loading (`src/app/(admin)/loading.tsx`, rewritten; Ruling 37)

Same `role="status" aria-busy="true"` wrapper, `data-testid="page-skeleton"` kept, `Loading…` sr-only. Not
`PageSkeleton` (its header bones are `md`): the admin frame — in the PageHeader gutter (`px-4 pb-5 pt-6 sm:px-7`) a 13 px
eyebrow bone (w-40), a 44 px heading bone (30 px below `sm`, w-56), a 13 px subtitle bone (w-72); then (`px-4 sm:px-7
pb-6`) a 42 px × 420 px `rounded-[12px]` tabs bone (`max-w-full`); then one card bone (`rounded-[16px]`, surface, line
ring, `p-5`, gap 12) with six `data-skeleton-row` 44 px bones.

## 2. Overview (`src/app/(admin)/admin/page.tsx`; board: InfAdminOverview)

### 2.1 Head

`AdminPageHead title="Overview" subtitleFont="sans" subtitle="Every organization at once. These numbers cross the
tenant boundary — only server admins see this area."` (the board's words; today's say the same). No actions.

Data: `const now = nowMs()` (`@/lib/clock`; Ruling 3) then today's `Promise.all` (`adminCounts()`,
`adminBoardCounts(now)`, `adminFirmwareDistribution(now)`, `adminAttentionCandidates(now)`, `readCurrentRelease()`),
`needsAttention(..., now)`, `orderDistribution(...)`. `adminCounts()` gains two fields (Ruling 14).

### 2.2 Tiles (Ruling 13)

`grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6`. Each tile is a `Link` (`m-stat`): `rounded-[16px] p-[18px]`,
`var(--surface)`, `box-shadow: 0 0 0 1px var(--line)`; hover `0 0 0 1px var(--dash), 0 12px 24px -14px rgb(36 33 27 /
.3)`; `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)`; column, gap 10:
label 13/500 `var(--muted-2)`; value Bricolage 40/700 `leading-none` `tabular-nums` (ink, or `var(--amber-text)` when the
tile warns) — the value `span` carries the test id and holds only the digits; note 12 px (`var(--muted-2)`, or
`var(--amber-text)` when it warns), `overflow-wrap:anywhere`.

| Label | Value (id) | Note (ids inside) | Warns | Goes to |
|---|---|---|---|---|
| Users | `count-users` | `newest 2026-10-25` (`newestUserAt`, ISO date) / `none yet` | — | `/admin/users` |
| Organizations | `count-orgs` | `every library on this server` | — | `/admin/users` |
| Titles | `count-games` | `<count-disks>63</> disks` | — | `/admin/scan` |
| Blobs | `count-blobs` | `<n> not yet scanned` / `all scanned` | n > 0 | `/admin/scan` |
| Boards online | `count-boardsOnline` | `of <count-boardsPaired>4</> paired` | — | `/admin/firmware` |
| Live invites | `count-liveInvites` | `nobody can sign up` / `each code works once` | 0 | `/admin/invites` |

`count-boardsSeen7d` moves into the firmware card's footnote (§2.3).

### 2.3 Boards by firmware (`section aria-labelledby="fw-dist-heading"`; Ruling 15)

Under the tiles, `grid gap-6 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start`; left column. Card `rounded-[20px] p-5`,
surface, line ring, column, gap 12:

- head (flex, `items-baseline`, `justify-between`, gap 12, `flex-wrap`): `h2#fw-dist-heading` `Boards by firmware`
  15/600 ink; `Link` `/admin/firmware` `Firmware registry` 13/600 `var(--amber-text)`, hover underline.
- `fw-dist` (column, gap 10) — rows `fw-dist-row` (`data-version`, `data-count` kept): `grid
  grid-cols-[minmax(0,200px)_minmax(0,1fr)_60px] gap-3.5 items-center`, 13 px:
  - version cell (flex, gap 8, `items-center`, `min-w-0`): a 7 px dot (`aria-hidden`; `--online-dot` current, else
    `--dash`); the label `span` mono ink `title={row.version}` holding exactly `versionLabel(row.version)` (pinned:
    `[title=...]` has text `0.0.0`), `overflow-wrap:anywhere`; then a sibling `span` 12 px: ` · current`
    (`var(--success-fg)`) when current, ` · unrecognised` (`var(--muted-2)`) when not recognised.
  - bar (`aria-hidden`): 8 px `var(--track)` `rounded-full overflow-hidden`, fill `max(2, share × 100)%` —
    `--bar-ok` for current, `--dash` otherwise.
  - count: mono 13 `var(--muted)`, right, `tabular-nums`.
  - `fw-dist-empty` (13 px `var(--muted)`, words unchanged) when there is no row.
- footnote 12 px `var(--muted-2)`: `Boards that reported in the last 7 days: <span count-boardsSeen7d>N</span>.`

### 2.4 Needs attention (`section aria-labelledby="attention-heading"`; Ruling 16)

Right column (under the firmware card below `lg`). Card `rounded-[20px] p-5`, column, gap 10: `h2#attention-heading`
`Needs attention` 15/600 ink (`mb-1`), then `attention` (`ul`, column, gap 10). Items, server first, then today's
device rows in today's order (`sortAttention`, 20 max). Each item `li`: `rounded-[12px] px-3.5 py-3`, flex, gap 12,
`items-start`; an 8 px dot (`mt-[5px]`, `aria-hidden`); a column (gap 2, `min-w-0`): title 14/600 ink, text 13 px
`var(--muted)`, `overflow-wrap:anywhere`.

- `attention-invites` (live invites = 0): a `Link` `/admin/invites` filling the item, `var(--warning-bg)`, dot
  `--fetch-dot`: `No live invite codes` / `Registration is invite-only. Issue one before sharing the sign-up link.`
- `attention-scan` (`blobsUnchecked` > 0): a `Link` `/admin/scan`, `var(--surface-2)`, dot `--dash`: `1 blob not yet
  scanned` / `12 blobs not yet scanned` and `The nightly scan picks them up, or run it now.` (`it` for one).
- `attention-row` (kept: `data-device-id`), not a link (Ruling 16), `var(--surface-2)`, dot by the first reason's kind
  (`--danger-fg` error, `--fetch-dot` behind, `--dash` offline): title = the board name; then the owner email (13 px
  `var(--muted)`, or `—`); then today's reasons `ul` — `li data-kind` with today's text, 13 px: error `var(--danger-fg)`,
  behind `var(--amber-text)`, offline `var(--muted)`.
- `attention-empty` `Nothing needs attention.` (13 px `var(--muted)`, words unchanged) when there is no item at all.

Hover on the two link items: `box-shadow: 0 0 0 1px var(--dash)`; focus ring as the tiles.

## 3. Users (`src/app/(admin)/admin/users/page.tsx`; board: InfAdminUsers)

### 3.1 Head

`AdminPageHead title="Users" subtitle={`${total} users · newest first · page ${page} of ${lastPage}`}` (mono; the board's
order). Paging, clamping, `PER_PAGE` 50 and the query unchanged.

### 3.2 The table (Rulings 8, 9)

`section aria-label="Users"` `rounded-[16px]`, surface, line ring, `overflow-hidden`. Inside, `div overflow-x-auto` around
`table` `w-full min-w-[760px]` 14 px ink (still a real table: Ruling 8):

- `thead` row 44 px, `border-b 1px var(--line)`, 12/500 `var(--muted-2)`, `th scope="col"` `px-5` (first) / `px-3.5`:
  `Email` · `Organization` · `Joined` (w 120) · `Titles` (w 70, right) · `Disks` (w 70, right) · `Boards` (w 80, right)
  · `Action` (w 150, right). Board words (Ruling 9).
- `admin-user-row` (`tr`, `data-email` kept): `border-b 1px var(--hairline)`, cells `py-3` (row ≥ 52 px), hover
  `var(--surface-2)`:
  - `user-row-<email>` (`td`): flex, gap 8, `flex-wrap`: the address (14 px ink, Geist, `overflow-wrap:anywhere`; no
    ellipsis) and, for an allowlisted address (`isSuperAdminEmail(r.email)`, server-side), the **Admin** pill (`rounded-full
    px-[7px] py-px`, ink fill, 11/600 `var(--surface)`; Ruling 10).
  - organization: `var(--muted)`, wraps; null → `no organization` in `var(--amber-text)` (unchanged).
  - joined: mono 13 `var(--muted)`, ISO date.
  - titles / disks / boards: mono 14 ink, right, `tabular-nums` (`r.games`, `r.disks`, `r.devices`).
  - action: `DeleteUserDialog`'s trigger (§3.4).

### 3.3 Footer (inside the card, outside the scroller)

`border-t 1px var(--hairline)`, `min-h-[52px] px-5 py-2.5`, flex, gap 12, `items-center`, `justify-between`,
`flex-wrap`, 13 px `var(--muted-2)`: `Deleting a user removes their organization, titles, disks and boards. Disk images
are kept: other libraries may share them.` (Ruling 11); then the pager (flex, gap 6): `Previous` / `Next` — enabled: a
`Link` to `?page=N`, 32 px `rounded-[8px] px-3`, surface, `1px solid var(--line)`, 13/500 ink; at an end: a `span
aria-disabled="true"` of the same size, `var(--surface-2)` fill, `var(--muted-2)` text (Ruling 12). The words stay
`Previous` / `Next` (pinned).

### 3.4 Delete (`delete-user-dialog.tsx` onto the shared `Modal`; Ruling 7)

- Trigger `delete-user-<email>` (kept): `button` **Delete…**, 34 px `rounded-[9px] px-3`, transparent, 13/500
  `var(--danger-fg)`, hover `var(--danger-bg)`, `aria-label={`Delete ${email}`}`, focus ring. For an allowlisted row:
  `aria-disabled="true"`, `var(--muted-2)`, `title="An admin account cannot be deleted"`, and a click does nothing (the
  server still answers 409; the Admin pill says why in words).
- The dialog: `Modal width={440} testId="delete-user-dialog" closeTestId="delete-user-close" title="Delete this
  account?" dismissible={!busy}`, `subtitle` = the address (mono 13 `var(--muted)`, wraps). Body (column, gap 12, 14 px
  `var(--muted)`): today's two paragraphs, same words and numbers (`This permanently removes …`, `Stored disk images are
  not deleted — …`); the label `Type the email to confirm` (13/600 ink, `for` the field) over the field (40 px
  `rounded-[10px] px-3`, surface, `1px solid var(--line)`, mono 13 ink, `autoComplete="off"`, `spellCheck={false}`).
  Footer (gap 10, `justify-end`): **Cancel** (38 px outline) and **Delete permanently** / `Deleting…` (38 px
  `rounded-[10px] px-4`, `var(--danger-fg)` fill, white 13/600): native `disabled` while not armed (as today, the gate),
  `aria-disabled` + guard while busy.
- Request, 409 / error / success toasts, `router.refresh()` unchanged; the fetch sits in try/catch/finally.
- Focus: on open the field (`initialFocus`); Escape and the backdrop cancel (not while busy); Tab stays inside (Base
  UI); on close `finalFocus` = the trigger when it is still in the document, else the page h1 (the row is gone after a
  delete).

## 4. Invites (`src/app/(admin)/admin/invites/page.tsx`; board: InfAdminInvites)

### 4.1 Head and the issue flow (Rulings 17, 18)

The page body is wrapped in `InviteIssueProvider` (client, `src/components/admin/invite-issue.tsx`, new): it owns the
just-issued code, so the header's button and the panel under the tabs share it. `IssueInviteButton` and
`NewInvitePanel` read it with `useInviteIssue()`.

`AdminPageHead title="Invites" subtitle={`${live} live · ${invites.length} total · invite-only`} actions={<IssueInviteButton
/>}`. The button: 42 px `rounded-[10px] px-[18px]`, ink fill, 14/600 `var(--surface)`, a 16 px plus glyph
(`aria-hidden`): **Issue an invite** / `Issuing…` (busy: `aria-disabled` + guard). Same request, toasts, `router.refresh()`.

### 4.2 The state line under the tabs

- `new-invite-panel` (only after an issue in this visit; `role="status"`): `rounded-[14px] px-[18px] py-4`, surface,
  `box-shadow: 0 0 0 1px var(--mounted-line)`, flex, gap 16, `items-center`, `flex-wrap`: an 8 px `--online-dot` dot
  (`aria-hidden`); a column (gap 2): 13 px `var(--muted)` `New code · single use · expires in 7 days`, then
  `new-invite-code` mono 22/600 `tracking-[0.12em]` ink (its text is exactly the code); a spacer; `CopyInviteButtons
  idPrefix="new-invite-copy" look="button"`: `new-invite-copy-code` **Copy code** and `new-invite-copy-link` **Copy
  sign-up link** (38 px `rounded-[10px] px-3.5`, surface, `1px solid var(--line)`, 13/500 ink); each reads `Copied` for
  2 s after a copy (unchanged).
- `invites-none-live` (`live === 0`, server): `role="note"`, `rounded-[14px] px-[18px] py-4`, `var(--warning-bg)`, flex,
  gap 12, `items-center`, 14 px `var(--warning-fg)`: an 8 px `--fetch-dot` dot and `No live invite codes. Nobody can
  sign up until one is issued — registration is invite-only by design.` The other value (`N live`) is the subtitle's.

### 4.3 The table (Ruling 19)

`section aria-label="Invite codes"` (card as §3.2), `table` `min-w-[880px]`, head as §3.2: `Code` · `State` (w 120) ·
`Issued` (w 150) · `Expires` (w 150) · `Used by` (w 220) · `Action` (w 240, right) — the board's order. Rows
`invite-<code>` (`tr`), `border-b 1px var(--hairline)`, `py-3`:

- code: mono 15 `tracking-[0.1em]` ink.
- state: a pill `rounded-full px-[9px] py-0.5` 12/600 (`STATE_LOOK`, sentence case — `Revoked` and `Used` are pinned):
  `Live` `--success-bg` / `--success-fg`; `Used` `--track` / `--muted`; `Expired` `--surface-2` / `--muted-2`; `Revoked`
  `--danger-bg` / `--danger-strong`.
- issued / expires: mono 13 `var(--muted)`, ISO date.
- `invite-used-by-<code>` (kept): consumed → the email (14 px `var(--muted)`, `overflow-wrap:anywhere`) over the
  consumed date (mono 12 `var(--muted-2)`); otherwise `—` in `var(--muted-2)`.
- action (live only, flex, gap 4, `justify-end`, `flex-wrap`): `invite-copy-code-<code>` **Copy code**,
  `invite-copy-link-<code>` **Copy link** (30 px `rounded-[8px] px-2.5`, transparent, 13/500 ink, hover `var(--track)`),
  `revoke-<code>` **Revoke** / `Revoking…` (same size, 13/500 `var(--danger-fg)`, hover `var(--danger-bg)`; busy:
  `aria-disabled` + guard). A non-live row's cell is empty: its state pill is the word.
- No code at all: one row `invites-empty`, `colSpan`, 13 px `var(--muted)`: `No invite codes yet. Issue one to let someone
  sign up.`

Revoke's request, 409 / error / success toasts and refresh are unchanged. Focus: after a revoke (or a 409 refresh) the
button is gone, so focus moves to the page h1.

## 5. Scan (`src/app/(admin)/admin/scan/page.tsx`; board: InfAdminScan)

### 5.1 Head (Ruling 21)

`AdminPageHead title="Scan" subtitleFont="sans" subtitle="Recognises disks against TOSEC, then fills in years,
publishers and covers from OpenRetro and Demozoo." actions={<RunScanButton />}`. `RunScanButton` (`run-scan`): 42 px ink
button as §4.1 with a 14 px play glyph; **Run now** / `Scanning…` (the words stay; the board's `Run again` is not used:
`admin-scan.spec` waits for `Run now` after the run). Busy: `aria-disabled` + guard. Request and toasts unchanged.

Data: `scanStatus()`, `readTosecFetchState()`, `readDemozooImportState()` as today; `const now = nowMs()` (Ruling 3)
for `demozooStatusText(state, now)`. The correction arithmetic (`unreadableDecided`, `authoredDecided`, `excluded`,
`genuineNone`, `decided`) moves verbatim into `scanCoverage(s)` (§5.6).

### 5.2 Source cards (`grid gap-5 lg:grid-cols-3`; Rulings 22, 23)

Each `section aria-labelledby` its h2: `rounded-[20px] p-5`, surface, line ring, column, gap 14. Head row (flex,
`items-baseline`, `justify-between`, gap 12, `flex-wrap`): h2 16/600 ink; the source line mono 12 `var(--muted-2)`.

- **Identity** (`scan-identity`): source `TOSEC · {tosecEntries} entries`.
  - Figure: `46%` Bricolage 40/700 `leading-none` ink + ` recognised` 18 px `var(--muted-2)` — `matched / decided`
    rounded; with `decided === 0`: `—` and ` nothing decided yet`.
  - Bar (`aria-hidden`): 10 px, flex, gap 2, `rounded-full overflow-hidden`, `var(--track)`: `--bar-ok` at matched %,
    `--fetch-dot` at genuine-none %; the rest (ambiguous) is the track.
  - `scan-excluded` (only when `authoredDecided > 0`; 12 px `var(--muted-2)`): `3 self-made disks excluded` (today's
    words, moved from the subtitle; pinned by `/self-made disks? excluded/`).
  - Counts (`grid grid-cols-2 gap-x-4 gap-y-2`): each a row (flex, `justify-between`, 13 px): left (flex, gap 6, `var(--muted)`)
    an 8 px `rounded-[2px]` square (`aria-hidden`; `--bar-ok` ok, `--fetch-dot` miss, else `--dash`) + the label; right
    the value mono ink `tabular-nums` carrying the id and only the digits: `Blobs` `scan-blobs` · `Hashed` `scan-hashed` ·
    `Matched` `scan-matched` (ok) · `No match` `scan-none` (miss) · `Ambiguous` `scan-ambiguous` · `Unreadable`
    `scan-unreadable` · `Unchecked` `scan-unchecked`.
- **Details** (`scan-details`): source `OpenRetro · <span scan-openretroEntries>N</span> entries`. Figure `enriched /
  (enriched + enrichNone + enrichAmbiguous)` ` recognised` (same empty rule); bar enriched / not-in-OpenRetro. Counts:
  `Enriched` `scan-enriched` (ok) · `Not in OpenRetro` `scan-enrichNone` (miss) · `Ambiguous` `scan-enrichAmbiguous` ·
  `Unchecked` `scan-enrichUnchecked` · `Images stored` `scan-imagesStored` with `scan-imageMb` (`1.2 MB`, 12 px
  `var(--muted-2)`) under it (the storage cost stays a number on the page).
- **Demos** (`scan-demos`): source `Demozoo · weekly`. No figure and no bar (Ruling 23): the body is `demozoo-status`
  (kept; 14 px `var(--muted)`, `leading-[1.5]`, text starts `Demozoo:`, words from `demozooStatusText`).

### 5.3 Status lines (`scan-notes`, `role="status"`; Ruling 24)

`ul` column, gap 8, 14 px `var(--muted)`; each `li` `scan-note` (`data-kind`) flex, gap 10, `items-center` with an 8 px
dot (`aria-hidden`); today's four notes, board words where it has them:

| Kind | When | Dot | Words |
|---|---|---|---|
| `unchecked` | `unchecked > 0` | `--fetch-dot` | `1 blob still to process. Each run is bounded and resumable — run it again, or leave it to the nightly run.` (`blobs` for more) |
| `unreadable` | `unreadable > 0` | `--danger-fg`, text `var(--amber-text)` | `12 blobs could not be read from storage and were stamped hashed with no hash — they always report as no match, not a genuine TOSEC miss.` |
| `no-openretro` | `openretroEntries === 0` | `--dash` | `No OpenRetro metadata loaded. Nothing can be enriched until an Amiga.sqlite is uploaded below.` |
| `enrich` | `enrichUnchecked > 0` and entries loaded | `--dash` | `40 blobs still to enrich. Image fetching is capped per run on purpose, so a first pass over a large library takes several runs — or several nights.` |
| `done` | none of the above | `--online-dot` | `Every blob is processed; the nightly run picks up new uploads.` |

### 5.4 Imports (`grid gap-5 md:grid-cols-2`; Ruling 25)

Two cards (`section aria-labelledby`, as §5.2, `items-start`, gap 10):

- **Import a TOSEC DAT** (`DatUpload`): `p` 14 px `leading-[1.5]` `var(--muted)` `One or more .dat files, ClrMamePro or
  XML. Importing a set again updates it in place.`; the input `dat-upload` (kept: `type="file" accept=".dat,.xml"
  multiple`, `class="sr-only"`, `tabIndex={-1}`, `aria-labelledby` the h2); the trigger `dat-choose` **Choose .dat
  files** (40 px `rounded-[10px] px-4`, surface, `1px solid var(--line)`, 14/500 ink) calls `input.click()`; busy: the
  trigger reads `Importing…` (`aria-disabled`, guard), and a `role="status"` line (13 px `var(--muted)`) says
  `Importing test.dat (1/3)`. `onChange` returns early while busy. Then `tosec-fetch-status` (kept, 12 px
  `var(--muted-2)`, today's words with `—` for today's `--`).
- **Import OpenRetro metadata** (`OpenRetroUpload`): `The Amiga.sqlite that FS-UAE Launcher syncs. A newer sync updates
  entries in place.`; `openretro-upload` (kept, as above, `accept=".sqlite"`); `openretro-choose` **Choose
  Amiga.sqlite**; busy `Importing — a full Amiga.sqlite takes about a minute…`; then `openretro-hint` (kept words, 12 px
  `var(--muted-2)`).

### 5.5 TOSEC sets (`section aria-labelledby="sets-heading"`; Ruling 26)

Card as §3.2 with a head row (`px-5 pt-4 pb-3`): `h2#sets-heading` `TOSEC sets` 16/600; the table (still a `table`:
`getByRole('row', { name })` reads it) `min-w-[640px]`, head as §3.2: `Set` · `Version` · `Entries` (right). Rows:
the set name 14 ink (wraps), version mono 13 `var(--muted)` (`—` when null), `set-entries` mono ink right. Empty: today's
row words.

### 5.6 `src/lib/admin-scan-look.ts` (new, pure, unit-tested)

- `scanCoverage(s: ScanStatus): { decided; matched; genuineNone; authoredDecided; recognisedPct: number | null; okW;
  missW }` — today's page arithmetic, moved verbatim (the `min()` caps included).
- `enrichCoverage(s)` — the same shape for OpenRetro.
- `scanNotes(s): { kind; text }[]` — §5.3, `done` when empty.
- `plural(n, one, many)`.

## 6. Firmware (`src/app/(admin)/admin/firmware/page.tsx`; board: InfAdminFirmware)

### 6.1 Head

`AdminPageHead title="Firmware" subtitle` (mono): `114 published · current 1.20.2+g68b7b8e`; empty registry: today's
`No releases published · nothing to compare devices against`. (The board's `signed …` part is in each row; Ruling 29.)

### 6.2 Filter (Ruling 27)

A row (flex, gap 12, `items-center`, `flex-wrap`): `fw-filter` — `nav aria-label="Show releases"`, `rounded-[10px]
p-[3px]`, surface, `1px solid var(--line)`, flex, gap 2 — three `Link`s (`fw-filter-all` **All**, `fw-filter-releases`
**Releases**, `fw-filter-test` **Test builds**) to `?show=` (`all` drops the param), 32 px `rounded-[8px] px-3`, 13 px:
current `aria-current="page"`, ink fill, 600 `var(--surface)`; others transparent, 500 `var(--muted)`, hover
`var(--track)`. Then the note 13 px `var(--muted-2)`: `Test builds reach only the bench organizations. Promote to
release… offers one to every organization.`

Server side: `?show=` parsed by `parseShow(raw): 'all' | 'releases' | 'test'` (anything else → `all`; in
`src/lib/admin-firmware.ts`, unit-tested); `countReleases({ show })` and `listReleasesFull({ limit, offset, show })` gain
an optional filter — `test`: `notes like TEST_BUILD_NOTES_PATTERN`; `releases`: `notes is null or notes not like …` (the
same pattern `isTestBuild` and `releaseVisibleToSql` use). `clampPage` runs against the filtered count. The subtitle's
total stays the whole registry. Empty filtered page: `fw-filter-empty` (card, 13 px `var(--muted)`): `No test builds
published.` / `No releases published.`

### 6.3 Rows (`section aria-label="Releases"`, column, gap 10; Ruling 28)

`firmware-release-row` (`article`, `data-version` kept): `rounded-[16px] px-5 py-4`, surface, `box-shadow: 0 0 0 1px`
`var(--mounted-line)` for the current release, else `var(--line)`. From `md`: flex, gap 20, `items-start`; below `md`:
column, gap 10.

- **Left** (`md:w-[220px] shrink-0`, column, gap 6): the version (flex, gap 8, `items-center`, mono 15/600 ink,
  `overflow-wrap:anywhere`) with an 8 px dot (`aria-hidden`; `--online-dot` current, `--fetch-dot` test, `--dash`
  release); `seq 114 · 724 KB · 2026-10-21 14:02 UTC` (mono 12 `var(--muted-2)`, `fmtSize`, `fmtTimeUtc`); then
  `publisher · signature` (12 px `var(--muted-2)`, wraps: `publishedByEmail ?? 'unknown publisher'`,
  `signatureLabel(...)`).
- **Middle** (flex-1, `min-w-0`, column, gap 6): tags (flex, gap 6, `flex-wrap`), each a pill `rounded-full px-[9px]
  py-px` 12/600:
  - current: one pill `--success-bg` / `--success-fg` reading `Current release`, made of `<span fw-tag-current>Current</span>`
    + ` ` + `<span fw-tag-release>release</span>` (both ids keep their meaning on one pill);
  - release, not current: `fw-tag-release` `Release`, `--track` / `--muted`;
  - test: `fw-tag-test` `Test build · bench orgs only`, `--warning-bg` / `--warning-fg`;
  - security: `Security`, `--danger-bg` / `--danger-strong`.
  Then the notes `p` 14 px `leading-[1.5]` ink, `overflow-wrap:anywhere` (as today: only when present).
- **Right** (`shrink-0`, column, gap 6, `md:items-end`): `fw-boards` `0 boards` / `1 board` (12 px `var(--muted-2)`, words
  unchanged); the Promote trigger (§6.5) on a test build; `fw-github` **GitHub release** (a release with a plain semver;
  13/600 `var(--amber-text)`, hover underline, `target="_blank" rel="noopener noreferrer"`, unchanged href).

### 6.4 Pager (`fw-pager`)

Under the list, flex, gap 10, `items-center`, 13 px: `fw-page-newer` **Newer** / `Page 1 of 4` (its own `span`,
`var(--muted)`, text exactly `Page N of M` — pinned) / `fw-page-older` **Older** — enabled links and end spans as §3.3.
Links keep `show`. The board's "load as you scroll" is not built (Ruling 27).

### 6.5 Promote (`promote-release-button.tsx` onto the shared `Modal`; Ruling 7)

- Trigger `fw-promote-<id>` (kept; still rendered on every row so the done text survives the refresh, `canPromote`
  shows it): **Promote to release…** 32 px `rounded-[8px] px-2.5`, transparent, `1px solid var(--line)`, 13/500 ink.
- `Modal width={620} testId="fw-promote-dialog" closeTestId="fw-promote-close" title="Promote to release"
  dismissible={!busy}`, `subtitle` = the version (mono 13 `var(--muted)`, wraps). Body (column, gap 12):
  `fw-promote-scope` (14 px `var(--muted)`, words unchanged); label `Release notes` (13/600 ink) over
  `fw-promote-notes` (`textarea rows=5 maxLength=2000`, `rounded-[10px] px-3 py-2`, surface, `1px solid var(--line)`, 14 px
  ink); `fw-promote-error` (`role="alert"`, 13 px `var(--danger-fg)`; today amber) with today's words. Footer: **Cancel**
  (38 px outline) and `fw-promote-confirm` **Promote** / `Promoting…` (38 px ink fill, 13/600 `var(--surface)`; native
  `disabled` while not armed, `aria-disabled` + guard while busy).
- Done: the body is `fw-promote-done` (14 px ink, words unchanged, `code` mono) and the footer one **Close** (38 px
  outline), which takes focus.
- Focus: on open the textarea; Escape / backdrop cancel (not while busy); on close `finalFocus` = the trigger when it is
  still in the document, else the page h1 (after a promote the row is a Release and has no trigger).
- Request, `redirect: 'manual'`, `SIGNED_OUT`, `errorText`, the 409 refresh, unchanged; try/catch/finally.

## 7. States

- **Loading**: §1.7, for every admin page.
- **Error**: A1's `(admin)/error.tsx` (`ErrorView`, `Back to admin`) unchanged; the admin header stays.
- **Empty**: Overview `fw-dist-empty`, `attention-empty`; Invites `invites-empty`, `invites-none-live`; Scan the sets
  table's empty row, `decided === 0` figures (`— nothing decided yet`); Firmware today's empty-registry card (surface
  card `rounded-[16px] p-6`, words unchanged) and `fw-filter-empty`.
- **Guarded**: signed out → `/sign-in`; non-admin → `/library` (layout; unchanged). No not-found: out-of-range pages
  clamp.

## 8. Focus and keyboard

- Tabs, tiles, attention links, pagers, filters: links in DOM order; `aria-current` on the current tab and filter.
- Modals (§3.4, §6.5): Base UI focus handling as described; never to `<body>`.
- A removed control (Revoke, the last Delete…, a promoted row's trigger): focus to the page h1 (visible ring, §1.4).
- File imports: the visible `Choose …` button is the tab stop; the input is not.
- Run now / Issue an invite keep focus while busy and after.

## 9. Phone (390 px) — only what the boards and today's specs pin

Area 7 owns the phone pass. Here: the admin header wraps as today, its fixed bottom bar now holds the Main nav;
`admin-sections` scrolls inside its clamp; the PageHeader stacks (title, subtitle, then the action); tiles are two per
row; the firmware and attention cards stack; the Users and Invites tables scroll sideways inside their cards (the page
does not), their footers wrap; firmware rows are a column; the Scan cards and imports are one per row; the new-code
panel wraps (code, then the copy buttons); both modals are full screen (`Modal`'s rule). Nothing scrolls the page
sideways.

## 10. Test ids

### 10.1 Kept (name and meaning)

Shell: `admin-header`, `admin-email`, `page-skeleton` (the admin loading wrapper), `search-input`, `settings-link`,
`sign-out`.
Overview: `count-users`, `count-orgs`, `count-games`, `count-disks`, `count-blobs`, `count-liveInvites`,
`count-boardsPaired`, `count-boardsOnline`, `count-boardsSeen7d` (each still an element holding only the digits),
`fw-dist`, `fw-dist-row` (+ `data-version`, `data-count`, the `[title=<version>]` label), `fw-dist-empty`, `attention`,
`attention-row` (+ `data-device-id`, `li[data-kind]` with today's text), `attention-empty`.
Users: `admin-user-row` (+ `data-email`), `user-row-<email>`, `delete-user-<email>`; the label `Type the email to
confirm`, the button `Delete permanently`, the links `Previous` / `Next`.
Invites: `new-invite-code`, `new-invite-copy-code`, `new-invite-copy-link`, `invite-<code>`, `invite-used-by-<code>`,
`invite-copy-code-<code>`, `invite-copy-link-<code>`, `revoke-<code>`; the state words `Live` / `Used` / `Expired` /
`Revoked`; the toasts.
Scan: `run-scan` (`Run now` / `Scanning…`), `scan-blobs`, `scan-hashed`, `scan-matched`, `scan-none`, `scan-ambiguous`,
`scan-unreadable`, `scan-unchecked`, `scan-enriched`, `scan-enrichNone`, `scan-enrichAmbiguous`, `scan-enrichUnchecked`,
`scan-openretroEntries`, `scan-imagesStored`, `scan-imageMb`, `tosec-fetch-status`, `demozoo-status`, `openretro-hint`,
`dat-upload`, `openretro-upload`, `set-entries`; the sets table's rows; the `self-made disk(s) excluded` words.
Firmware: `firmware-release-row` (+ `data-version`), `fw-tag-current`, `fw-tag-release`, `fw-tag-test`, `fw-boards`,
`fw-github`, `fw-promote-<id>`, `fw-promote-dialog`, `fw-promote-scope`, `fw-promote-notes`, `fw-promote-error`,
`fw-promote-done`, `fw-promote-confirm`, `fw-page-newer`, `fw-page-older`; the text `Page N of M`; the button name
`Promote to release` (substring of `Promote to release…`).

### 10.2 New

`admin-sections`, `attention-invites`, `attention-scan`, `delete-user-dialog`, `delete-user-close`,
`new-invite-panel`, `invites-none-live`, `invites-empty`, `scan-identity`, `scan-details`, `scan-demos`,
`scan-excluded`, `scan-notes`, `scan-note` (+ `data-kind`), `dat-choose`, `openretro-choose`, `fw-filter`,
`fw-filter-all`, `fw-filter-releases`, `fw-filter-test`, `fw-filter-empty`, `fw-pager`, `fw-promote-close`. Element ids:
`fw-dist-heading`, `attention-heading`, `sets-heading`.

### 10.3 Removed

None. (`Back to library` in the admin header was text, not an id; no spec reads it.)

### 10.4 Specs that change, and why

| Spec | Change |
|---|---|
| `admin-invites.spec.ts:12` | button `/issue invite/i` → `/issue an invite/i` (Ruling 17) |
| `contrast.spec.ts:236` | the same button name |
| `e2e/c6-admin-layout.spec.ts` (new) | the plan's new tests: header nav + `Admin` current + no chips, `admin-sections` current per page, Overview tile links + attention server items, Admin pill + disabled Delete…, delete-modal focus (open, Escape, return, h1 after a delete), new-code panel + none-live note, Scan cards/notes/choose buttons, firmware filter + pager keeping `show`, promote-modal focus, h1 after a revoke, nothing scrolls sideways at 390 |
| `contrast.spec.ts` | a new Admin test (§11) |
| `screenshots.shots.ts` | new `admin.png` (Overview, 1280; Ruling 38) |

Regression only (no edit expected): `admin-guard` (all; `heading /overview/i` stays unique, `link 'Next'`), `admin-delete`
(typed gate, `toBeDisabled` / `toBeEnabled` on the native `disabled` gate), `admin-scan` (all; `heading /scan/i` stays
unique — no h2 contains "scan"; the 280 s Run now), `admin-firmware` (all), `admin-invites` (the rest),
`collections -g "delete"` (the admin delete at :680), `header-overlap` (the admin sweep now measures `TopNav` in the
admin header), `drive-chips -g "admin"`, `states`, `demozoo`, `openretro`, `tosec-scan` (API only).

## 11. Contrast pairs (WCAG 2.x; in `design-tokens.test.ts` and measured on the page in `contrast.spec.ts`)

| Pair | Ratio | Where |
|---|---|---|
| ink on `--surface` / `--surface-2` / `--warning-bg` | 15.79 / 14.37 / 13.70 | tile values, table cells, attention titles, notes |
| `--muted` on `--surface` / `--surface-2` / `--warning-bg` / `--track` | 7.37 / 6.71 / 6.40 / 6.20 | org, dates, attention text, tab items, `Used` / `Release` pills |
| `--muted-2` on `--surface` / `--surface-2` | 5.58 / 5.08 | tile labels and notes, source lines, footnotes, column heads, `Expired`, disabled pager |
| `--amber-text` on `--surface` / `--surface-2` | 5.57 / 5.07 | warning tiles, `Firmware registry`, `GitHub release`, `behind` reason, `no organization` |
| `--warning-fg` on `--warning-bg` | 6.38 | no-live note, `Test build` tag |
| `--success-fg` on `--success-bg` | 5.57 | `Live`, `Current release` |
| `--danger-strong` on `--danger-bg` | 6.17 | `Revoked`, `Security` |
| `--danger-fg` on `--surface` / `--surface-2` | 6.03 / 5.48 | Delete…, Revoke, `error` reason, hovered-row Delete… |
| white on `--danger-fg` | 6.13 | Delete permanently |
| `--surface` on ink | 15.79 | Admin pill, Issue an invite, Run now, current filter, Promote |
| `--success-fg` on `--surface` | 6.55 | ` · current` |

Measured on real elements: a tile label, value and warning note; a firmware row's count and ` · current`; an attention
title and text on `--surface-2` and on `--warning-bg` (`attention-invites`); a Users column head, a joined date, the
Admin pill, a Delete… trigger, the footer; the no-live note; the `Live`, `Used`, `Revoked` pills; a Scan source line, a
count label and value, a status line; a firmware meta line, the `Test build` and `Current release` tags, `GitHub
release`, the current filter link and another; an `admin-sections` item and the current one. The dots, bars and rings
are decoration beside the numbers and words that carry the state.

## 12. Out of scope

- An admin audit log (the plane's remaining gap; HANDOFF "Super-admin plane").
- A count badge on the Invites tab (Ruling 2); a per-day firmware history (A7: none exists).
- Demozoo recognition counts and percentages (no per-blob Demozoo data; Ruling 23).
- Infinite scroll on Firmware (Ruling 27); search or sort on Users.
- A password step-up on Promote (A7 deferred minor; behaviour, not layout).
- The app header (`(app)/layout.tsx`) and `HeaderStart`; the phone bottom bar's design (area 7).

## 13. Suggested task split

1. **Shell and shared**: the admin header (TopNav, gear, Sign out), `AdminSections`, `AdminPageHead`, `PageHeader
   subtitleFont` + the h1 ring (unit), `--bar-ok` (+ `design-tokens.test.ts`), `(admin)/loading.tsx`, the five
   `metadata` titles; `header-overlap`, `drive-chips -g admin`, `admin-guard` regression.
2. **Overview**: `nowMs()` (lint), `adminCounts` + `newestUserAt` / `blobsUnchecked` (db test), tiles, the firmware
   card, Needs attention with the two server items; `admin-guard` regression; new layout tests.
3. **Users**: the table, Admin pill and disabled Delete…, footer and pager, `DeleteUserDialog` on `Modal` with its
   focus rules; `admin-delete`, `collections -g delete` regression.
4. **Invites**: `InviteIssueProvider`, the button, panel, none-live note, the table, `CopyInviteButtons look` +
   `linkLabel`, Revoke busy/focus; the two §10.4 renames; `admin-invites` regression.
5. **Scan**: `nowMs()` (lint), `admin-scan-look.ts` (unit: the arithmetic moved, notes), the three cards, status lines,
   import cards with Choose buttons, the sets card; `admin-scan` regression (the 280 s test in its own run).
6. **Firmware**: `parseShow` (unit), the filtered `countReleases` / `listReleasesFull` (db test in
   `admin-firmware.db.test.ts`), filter, rows and tags, pager, the Promote modal on `Modal`; `admin-firmware` regression.
7. **Contrast, phone, screenshot, lint gate**: §11 test, the 390 px checks, `admin.png`, `pnpm lint` clean.

## Rulings (operator to review)

1. **The admin header takes the board's app header: the Main nav (`TopNav` with Admin, current) in the pill, the gear and
   Sign out at the right; Back to library goes.** No drive menu or chips (no tenant here; `drive-chips.spec`), the
   wordmark keeps ` admin`, and the bar's frame, wrap and `2xl` centring stay, so `header-overlap` measures the same
   box. — the board draws ModernHeader `active="admin"`, and the app's nav, gear and Sign out were missing from the
   plane. — cost if wrong: the pill is 394 px against AdminNav's narrower one; if `header-overlap` fails at a width, the
   right group or the `2xl` threshold has to change.
2. **The five sections become the board's in-page `Admin sections` tabs under each page's heading, with no count
   badge.** — the header now holds the Main nav; the board's `0 live` badge appears on one board only and would need a
   query on every page, while the Overview tile, its attention item and the Invites subtitle already say it in words. —
   cost if wrong: one board detail missing; a later badge needs `adminCounts` on every page.
3. **The two `react-hooks/purity` errors are fixed with the codebase's `nowMs()` (`@/lib/clock`), read once per request
   in the page body and passed in** — the pattern `9442e3c` set for seven other pages; what is shown is unchanged. —
   cost if wrong: none expected; the rule may flag a future inline `Date.now()` again.
4. **`PageHeader` gains `subtitleFont`**: Overview and Scan take the board's prose subtitle, the others its mono summary.
   — the boards differ per page. — cost if wrong: one more prop on a shared component.
5. **`PageHeader`'s h1 gets a visible focus ring instead of `outline-none`** — it is only focused programmatically, as the
   fallback after a removal, and C3–C5 give that target a ring. — cost if wrong: every page's h1 shows a ring when a
   script focuses it (no user tab stop changes).
6. **Every admin page opens with `AdminPageHead` (eyebrow `Admin · this server`, 44 px Bricolage h1).** — the boards'
   head on all five. — cost if wrong: none.
7. **User delete and Promote move onto the shared `Modal` (440 / 620), keeping every word, the typed-email gate and the
   notes rule.** — it brings the focus trap A7 left as a deferred minor, Escape that respects busy, and focus back to
   the opener (or the h1 when the opener is gone). The board's inline "Delete with everything?" row confirm is not
   used: a typed address is the plane's real protection, and the shipped dialog was centered precisely so nothing
   covers another row. — cost if wrong: both are full screen on a phone.
8. **Users and Invites stay real `<table>`s, styled as the board's grid, scrolling sideways inside their cards on a
   narrow screen.** — header association for screen readers, and `getByRole('row')` semantics; area 7 owns phone
   cards. — cost if wrong: a phone scrolls the table.
9. **The Users columns take the board's words — Titles, Boards — over the same counts** (`games`, `devices`). — the
   product's words since Phase B. — cost if wrong: none.
10. **An allowlisted account shows the board's Admin pill and its Delete… is `aria-disabled`** with the reason in its
    title; the server's 409 is unchanged. Decided on the server by `isSuperAdminEmail`, on a page only admins see. —
    the board draws it, and a request that can only fail is a dead end. — cost if wrong: the allowlist becomes visible
    in this list (admins only).
11. **The Users footer explains the blast radius in the dialog's own facts**: `Disk images are kept: other libraries may
    share them.` — the board's `Shared blobs stay until the weekly clean-up` reverses the meaning (shared blobs are kept
    for good; unreferenced ones go). — cost if wrong: none.
12. **Pagers are links with an `aria-disabled` span at the ends, the board's 32 px buttons in look.** — `admin-guard`
    clicks `link 'Next'`; a disabled link is not a thing. — cost if wrong: none.
13. **The Overview's six tiles are the board's links; disks and paired boards move into notes, seen-in-7-days into the
    firmware card's footnote, each keeping its id on a digits-only element.** — the board merges nine tiles into six,
    and `admin-guard` reads the ids as `^\d+$`. — cost if wrong: two figures are smaller than they were.
14. **`adminCounts()` gains `newestUserAt` and `blobsUnchecked`** (two scalar subqueries; `blobsUnchecked` uses
    `scanStatus`'s exact `unchecked` predicate) for the Users note, the Blobs warning and the attention item. — additive
    reads, no schema, no stored data. — cost if wrong: one wider query per Overview load.
15. **Boards by firmware keeps A7's facts with the board's dots and bars**: current is green with ` · current`, an
    unrecognised version says so; there is no `· test` marker. — the distribution carries no TEST flag and the board's
    is inferred. — cost if wrong: a bench build on a board is not marked on the Overview (it is on Firmware).
16. **Needs attention adds two server items on top (no live invites; blobs not yet scanned), as links; the board rows
    stay per device and are not links.** — the board's items are server-level, A7's device rows are pinned by
    `admin-guard`, and an admin cannot open another organization's device page. The board's aggregate "1 board behind"
    is not added (each board's own row says it). — cost if wrong: a fleet of behind boards is a long list (20 max).
17. **The button reads `Issue an invite` (board)**; two e2e sites rename. — the board's words. — cost if wrong: churn.
18. **The new code moves from beside the button into the board's status panel under the tabs**, shared through a small
    client provider; the panel's link button says `Copy sign-up link`, the rows keep `Copy link`. — the board; the
    header has no room for an 8-character code and two buttons on a phone. — cost if wrong: one more client wrapper.
19. **Invite rows take the board's order (Used by after the dates) and keep A7's Copy code / Copy link beside Revoke.**
    State pills are sentence case (`Revoked`, `Used` are pinned), coloured per state. — A7 shipped the copy buttons on
    rows and `admin-invites` uses them. — cost if wrong: a 240 px action column instead of the board's 120.
20. **Revoke and Run now stay without a confirm, as shipped.** (Operator confirmed 2026-10-25: "skip the confirm, its fine".) — the task keeps guards and confirmations as they are;
    adding one would be behaviour, and `admin-invites` / `admin-scan` click straight through. A revoked code can be
    replaced by issuing another; a scan is bounded and resumable. — cost if wrong: a mis-click revokes a live code.
21. **Run now keeps its words after a run** (the board's `Run again` is not used). — `admin-scan` waits for `Run now`
    after the 240 s run. — cost if wrong: none.
22. **Scan's tiles become the board's three source cards; every count keeps its id**, and Identity also lists Blobs,
    Hashed and Unreadable (the board shows four counts). The miss rate in the subtitle becomes the card's `% recognised`
    (`matched / decided`, the same corrected `decided`), and `self-made disks excluded` moves into that card. — the
    board, without dropping a number A7 or the scan shows today. — cost if wrong: the subtitle no longer states TOSEC's
    entry count and miss rate (the card does).
23. **The Demos card shows Demozoo's status line, not a percentage.** — there is no per-blob Demozoo verdict to count
    (`Linked / To review / Declined` do not exist as data); inventing them is out of a layout pass. — cost if wrong: the
    third card is emptier than drawn.
24. **Scan's notes become the board's status lines, all of them, and a `done` line when none applies.** — the board shows
    one; today shows up to four; both values of "anything left to do" are shown. — cost if wrong: none.
25. **File imports get the board's `Choose …` buttons over hidden inputs that keep their ids**; the input is not a tab
    stop and the busy state is `aria-disabled` + guard. — the board; `setInputFiles` works on the hidden input. — cost
    if wrong: none.
26. **The TOSEC sets table stays, as its own card** (the board does not draw it). — `admin-scan` reads its rows and it is
    the only place the loaded sets are listed. — cost if wrong: the page is longer than drawn.
27. **Firmware gets the board's All / Releases / Test builds filter as server-side links (`?show=`), and keeps the
    pager instead of loading on scroll.** — a client filter over a 25-row page would hide releases on other pages; the
    predicate is the registry's own `TEST_BUILD_NOTES_PATTERN`; `admin-firmware` pins `Page N of M`, Newer and Older. —
    cost if wrong: `countReleases` / `listReleasesFull` take one optional parameter.
28. **The current release shows one `Current release` pill that holds both `fw-tag-current` and `fw-tag-release`**; a
    test build reads `Test build · bench orgs only`; Security stays a pill. — the board's single pill without changing
    either id's meaning. — cost if wrong: a nested span.
29. **Each row keeps its publisher and signature in the left column; the header does not repeat the current signing
    key.** — the board's `signed wf-…` subtitle would need the current release's key read separately; the row already
    says it for every release. — cost if wrong: the subtitle is shorter than drawn.
30. **`countReleases` / `listReleasesFull` gain the optional `show` filter** — additive, read-only, defaulting to today's
    query. — cost if wrong: a db test more.
31. **Promote's trigger reads `Promote to release…`** (it opens a dialog). — the board; `admin-firmware`'s role name is a
    substring. — cost if wrong: none.
32. **Promote's error turns `--danger-fg` with `role="alert"`, and Delete permanently turns `--danger-fg`** (both were
    amber). — the board's red for destructive and failed; amber means "behind / warning" elsewhere. — cost if wrong:
    none.
33. **The GitHub release link stays**, `WEBADF_FIRMWARE_REPO`-driven as A7 shipped it. — it points at the registry's own
    source, and a self-hoster's fork sets it; parity holds. — cost if wrong: an external link on an admin page.
34. **One new token, `--bar-ok`** (the board's bar green); every other literal maps to an existing token. — cost if
    wrong: none.
35. **The board's warning colours `#B5541A` (text) and `#8A3A0E` map to `--amber-text`** — `#B5541A` is 4.86:1 on the
    surface but under 4.5 on `--surface-2`; one amber for warnings keeps the pairs few. — cost if wrong: the warning
    tiles are a shade darker than drawn.
36. **Each admin page gets a title (`Admin · Overview` …).** — browser tabs read `WebFloppy` for all five today. — cost if
    wrong: none.
37. **`(admin)/loading.tsx` draws the admin frame (lg head, tabs, a card of rows) and keeps `page-skeleton`.** — the
    generic `md` header bones would jump when a 44 px heading lands. — cost if wrong: one skeleton to keep in step.
38. **One screenshot, `admin.png` (Overview, 1280).** — cost if wrong: one more PNG.
39. **No migration, no new route, no new package.** Nothing in this area needs one. — cost if wrong: none.
