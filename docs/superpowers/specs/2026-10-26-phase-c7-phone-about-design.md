# WebFloppy redesign, Phase C area 7: Phone layouts (390 px) and About into Settings — design

Date: 2026-10-26. Roadmap Phase C step 7 (`2026-10-23-webfloppy-redesign-roadmap-design.md`): "Phone layouts (390 px) — a
pass over everything; to iterate later. C7 also moves About into Settings (operator 2026-10-25)". Steps 8 (header drive
menu, simple) and 9 (GitHub page) come after this one and are out of scope here.

A **phone pass** over pages whose layouts C1–C6 already shipped, plus one move: the About page becomes the last-but-one
section of Settings. The same requests, words, guards and data; no new behaviour except the phone shell's `More` menu
(Ruling 4), the phone search opener (Ruling 6) and the `/about` redirect (Ruling 22). Builds on Phase B (tokens, `.seg`,
the header, `TopNav` moved by CSS, `--nav-scrim`), C1 (`PageHeader`, the ⋯ title menu, the rail), C2 (the shared
`Modal`, full screen below `sm`), C3 (drop cards, staging rows), C4 (Disk card, Files header), C5 (`SideNav`, the Help
disclosure, the search panel, the auth frame) and C6 (admin header, `admin-sections`, stacked Users rows). Nothing here
re-invents them.

The operator said "to iterate later": this pass fixes what is measured broken or cramped and follows the board where the
board draws something; it does not redesign a page the board does not draw. Every design call is mine, written under the
operator's unattended authorization of 2026-10-24, and listed under **Rulings** at the end with what it costs if wrong.

Target board (session scratchpad `design-approved/`): **`InfPhone`** (APPROVED, "Inferred phone"): three 390 × 844
screens — Library, Devices, Upload — sharing a 60 px header (logo, a full-width drive chip, a 44 px search button) and a
76 px bottom bar of four tabs (Library, Devices, Upload, **More**; current = ink 700 with a 32 × 4 accent bar above the
label). The area boards (`ModernLibrary`, `InfLibraryTable`, `ModernDevicesV2`, `InfUploadTransfer`, `ModernDiskFiles`,
`InfSettings`, `InfHelp`, `InfSearch`, `InfSignIn`, `InfAdmin*`) give each page's content; `InfSettings` draws `About
this server` in the section list between Firmware updates and Delete account (its anchor `#server`; this spec uses
`#about`, Ruling 21).

Measured against `36eed90` (branch `feat/phase-c7-phone`), §1.

## 0. Invariants

- Every `data-testid` in §13.1 keeps its name and its meaning. Ids that move onto a different element keep their names;
  the e2e sites that change are listed in §13.4. One id is removed: `about-link` (§13.3).
- No schema change, no migration, no new API route, no new package. `/about` becomes a redirect (next.config, Ruling 22);
  its page file goes. Every request, guard, confirm and toast word is unchanged.
- **Nothing at 1024 px and wider changes** except: the header loses the (i) (Ruling 20), Settings gains the About section
  and its list item (§10). The 1280 e2e project sees the same header, nav, gear and Sign out.
- One `nav aria-label="Main"` in the DOM (Phase B: the nav is moved by CSS, never duplicated; `mobile.spec` "only one
  nav"). Items that exist only at one size are hidden with `display:none` (`max-lg:hidden` / `lg:hidden`), so
  `getByRole` never sees two of a name at one width.
- Self-host parity: no new external URL, font or our-deployment-only word. The About section keeps the existing
  Repository link and the `Hosted` / `Self-hosted` reading (`SELFHOSTED`), unchanged.
- Firmware, `wifi-floppy/`, the board and the Amiga are untouched.
- "Show both values of a state": every state renders a word in each of its values (the tab bar's current tab is marked by
  weight, colour, the bar and `aria-current`; the `More` tab says which page it covers, §2.3). No `sr-only` element carries
  a width or layout utility.
- In-app dialogs and menus only; never `window.confirm`. Busy controls stay `aria-disabled` + guard.
- **Phone touch target: 44 px** (`min-h-11`, and `min-w-11` for icon buttons) for every control named in this spec.
  Text links inside prose and the "?" (Ruling 14) are the exceptions.
- Nothing scrolls the page sideways at 360, 390 or 414 px.

## 1. What was measured

A temporary Playwright capture (`e2e/zz-c7-audit.spec.ts`, deleted after) against a dev server on port 3100, with the
`mobile` project's settings (390 × 844, `hasTouch`, `isMobile`), on a fresh user (signUpFresh: four titles, one with a
70-character name; two collections; one paired, online board with a mounted disk; one Create-ADF disk) and on the
allowlisted admin. Per page: `scrollWidth - clientWidth`, every visible element past either viewport edge (and whether a
scroll container clips it), every interactive element under 44 px in either dimension, overlapping header controls,
every fixed/sticky element, and whether the last control is reachable above the fixed bar after a scroll to the end. A
second probe measured the header nav at 640–1279 px with a board, without one, as a member and as the admin. Screenshots
were looked at, kept in the session scratchpad only (they show addresses), and never committed.

**What is fine today** (no change needed beyond the shared rules): no page scrolls sideways at 390 (0 px on all 20
captures); the bottom-bar padding works (the last control ends 53–82 px above the bar on every page); the shared `Modal`
is full screen and covers the bar; the Create ADF sheet, the title ⋯ menu, the help popover, the search panel, sign-in
and sign-up, Settings' stacked rows, Help's `Topics · 17` disclosure, the Admin Overview tiles, the stacked Users rows
and the firmware rows all fit.

**Measured problems** (390 × 844 unless a width is given; numbers are CSS px):

| # | Where | Measured | §  |
|---|---|---|---|
| P1 | Header nav, 640–1023 px | the pill (317 px; 394 as admin; 393 admin shell) is clamped and scrolls: with a board it shows **0 px at 640 and 1 px at 700**, 69 at 768, 101 at 800, 201 at 900, 301 at 1000; without a board 31 / 91 / 159 / 291 / 317; the admin shell 18 / 78 / 146 / 278 / 378. It fits from 1024 in every case. | 2 |
| P2 | Admin phone bar | five items, 393 px in a 366 px clamp: scrolls 27 px; the current tab **Admin** is cut at the right edge and Library at the left | 2 |
| P3 | Phone header | two rows, **104 px** (113 with a board), 12–13 % of the screen; the board's is one 60 px row | 2 |
| P4 | Bottom bar | four `.seg` items **34 px** tall (Library 78 × 34 … Help 62 × 34) in a 59 px bar | 2 |
| P5 | Header controls | wordmark link 125 × 27, `drives-compact` 90 × 36, search 169 × 40, (i) 36 × 36, gear 36 × 36, Sign out 85 × 36 | 2 |
| P6 | Library table | 760 px rows in a 358 px card: names cut to ~40 px (`Gam…`, `Utilit…`, `Turrican 179…`); each row's ⋯ at x 715–759, off screen until scrolled | 4.3 |
| P7 | Library rail | a vertical list above the grid: with two collections the first title starts at **y ≈ 640** (each collection +38 px); grip 20 × 28, collection ⋯ 28 × 28, New collection field 36, Add 36 × 36 | 4.2 |
| P8 | Upload | the two drop cards stack to ~620 px; the Staging list starts at **y ≈ 890**, below the first screen | 7 |
| P9 | Devices head | `Write a Next-disk card` (185 × 40) and `Pair a device` (133 × 40) wrap their labels onto two lines inside 40 px buttons | 6.1 |
| P10 | Devices card | DF1 radios 32 px in two wrapped rows; `Rename` 32 × 32; `Board settings` 131 × 32; `Change display` 124 × 28; protection 82 × 38, `Change disk` 106 × 38, `Eject` 80 × 38 | 6.2 |
| P11 | Admin Invites | an 880 px table in a 358 px card: `Copy code` / `Copy link` / `Revoke` (30 px tall) sit off screen until the card is scrolled sideways | 11.3 |
| P12 | Admin sections | 414 px tabs in a 358 px clamp: `Firmware` cut, no sign it scrolls; tabs 34 px | 11.1 |
| P13 | Segmented controls everywhere | 32–36 px: Settings radios 32, staging filter 32, firmware filter 32, board-settings `Disk at startup` 32, auth switch 36, admin tabs 34, view toggle 44 × 40 | 3.1 |
| P14 | Row buttons | Title disk row 38 (Download, Browse, Mount, Send, Protected, delete 38 × 38); Disk card 38 (`Pair a device`, download 38 × 38); Files header 36 (`Hide .info files`, `New folder`, `Add file`); Settings 36 (`Change password…`), 38 (`Delete account…`); Users `Delete…` 72 × 34; Firmware `Promote to release…` 32, `Older` 60 × 32; modal Close 36 × 36, Cancel / Save 38; `Clear finished` 34; `Change image…` 26 | 3.2 |
| P15 | "?" | 24 × 24 on every page (C5 deferred minor) | 3.3 |
| P16 | Pager size | `pager-size` select 59 × 34 | 4.1 |

Not measured on a device (reasoned, verified by the build's own test): sonner toasts sit at the bottom edge with a 16 px
mobile offset, i.e. over the bottom bar while shown (§3.4).

Handed to this phase by earlier phases (HANDOFF "Phase B" … "Phase C6", and each spec's "area 7"):

| From | Item | Here |
|---|---|---|
| Phase B | the app nav fits 640–~1000 only by scrolling; "area 7 decides bottom bar up to md or a narrower search" | P1, Ruling 1 |
| Phase B | `.seg` toggle 40/48 px and wraps at 390 | P13, Ruling 12 |
| C1 §10 | the nav's 640–1000 px clamp | P1 |
| C1 deferred | ⋯ / grip touch targets below md | P7, Ruling 16 |
| C2 §13 | InfPhone's "Change second drive" button | §6.2, Ruling 18 |
| C3 Ruling 30 | InfPhone's two 96 px tile buttons and action-less staging cards | §7, Ruling 19 |
| C4 deferred | the disk-files skeleton stacks the disk icon below lg (~90 px phone jump) | §8, Ruling 27 |
| C4 Ruling 18 | a multi-file picker for a phone that cannot drop | not here (§15) |
| C5 §12 | the header itself: field width, InfPhone's search icon, the bottom bar | §2 |
| C5 deferred | "?" 24 px target; auth switch links 36 px | P15, P13 |
| C5 deferred | no scrim below sm (iOS tap-away leaves the panel open) | §2.4, Ruling 7 |
| C5 deferred | phone `/help#topic` reload jumps when the Topics list closes | §9.2, Ruling 26 |
| C5 §12 | the About page layout | §10 |
| C6 §12 | the app header and the phone bottom bar's design | §2 |
| C6 deferred | 30 px row buttons; the weak ARIA assertion at 390; no by-hand phone pass | §11, §14 |

## 2. The phone shell (both shells: `(app)/layout.tsx`, `(admin)/layout.tsx`; board: InfPhone header and bar)

### 2.1 Where it applies (Ruling 1)

The phone shell — the 60 px header row and the fixed bottom bar — applies **below `lg` (1024 px)**, not below `sm` as
today. From `lg` the header is exactly today's 72 px bar (pill in flow to `xl`, absolute from `xl`; admin: to `2xl`).
Every `sm:` that the two layouts use for the shell becomes `lg:` (the wrapper's `pb-[…] sm:pb-0` → `lg:pb-0`, the
header's `sm:h-[72px] sm:flex-nowrap …`, the bar wrapper's `sm:static …`). Page content keeps its own `sm:` / `md:`
rules: this moves the shell, not the pages.

### 2.2 Header row below `lg` (Rulings 2, 3, 6)

`header` (`app-header` / `admin-header`): one row, `h-[60px]`, `px-4`, flex, `items-center`, gap 10, `var(--surface)`,
`border-b 1px var(--line)`. In order:

- **Home**: `wordmark-home` (`Link /library`), a 44 × 44 hit area around the 26 px `Logo`; the word `webfloppy` is shown
  from `sm` and is `sr-only` below `sm` (the link keeps its name). Admin shell: the logo and the word ` admin` always
  (there is no chip there), the `webfloppy` word from `sm`.
- **Chip slot** (app shell only), `flex-1 min-w-0`: today's `drives-compact` control, now `h-11 w-full` (44 px), its
  content unchanged (C8 gives it the board's name / disk / `WP` content). No board: the slot is empty space.
- **Search**: below `sm` a 44 × 44 icon button `search-open` (`aria-label="Search"`, `aria-expanded`), §2.4; from `sm` the
  field as today.
- Gear, Sign out and the admin address are **not** in the header below `lg` (`max-lg:hidden`); they are in `More` (§2.3).
  The (i) is gone at every width (§10.4).

The `HeaderStart` lane geometry (pill estimate, centring) applies from `lg` only; below `lg` the lane is a plain flex
row.

### 2.3 Bottom bar below `lg` (Rulings 4, 5)

The same `nav aria-label="Main"` (`TopNav`), in the same fixed wrapper (`z-40`, `--nav-scrim`, `border-t 1px
var(--nav-scrim-hairline)`, `backdrop-blur-md`), restyled below `lg` to the board's tab bar:

- wrapper: `px-2 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))]`; the `nav` is `grid grid-cols-4 w-full
  max-w-[560px] mx-auto` (a tablet does not stretch four tabs over 1000 px).
- four cells: **Library**, **Devices**, **Upload**, **More**. Help and Admin are `max-lg:hidden` (they live in More); More
  is `lg:hidden`. From `lg`, `TopNav` is today's `.seg` pill with Library, Devices, Upload, Help (+ Admin), unchanged.
- a tab (`a`, or the More `button`): `h-[52px]`, flex column, `items-center justify-center`, gap 3, `rounded-[10px]`,
  11 px; above the label a `span aria-hidden` 32 × 4 `rounded-full`. Current: ink, 700, the bar `var(--accent-amber)`
  (Ruling 5), `aria-current="page"`. Other: `var(--muted-2)`, 500, the bar transparent. Focus ring as `.seg-item`.
- **More** (`button nav-more`, `aria-haspopup="menu"`): its label is `More`; it is current (bar, weight, `aria-current`
  `"page"`) on `/settings*`, `/help*` and `/admin*`. It opens `nav-more-menu`, a Base UI menu (the app's `DropdownMenu`,
  `side="top"`, `align="end"`, `w-[min(280px,calc(100vw-32px))]`), items 44 px (`menu-item-look`), in order:
  `more-help` Help → `/help`; `more-settings` Settings → `/settings`; `more-about` About this server →
  `/settings#about`; `more-admin` Admin → `/admin` (only when `showAdmin`, decided on the server as today); a separator;
  `more-sign-out` Sign out (the `SignOutButton` action, same words and flow). The item for the current page carries
  `aria-current="page"` and a 600 weight (both values in words: the item names the page).

The layouts' bottom padding stays `pb-[calc(4.5rem+env(safe-area-inset-bottom))]` (72 px ≥ the bar's 6 + 52 + 8 = 66),
`lg:pb-0`.

### 2.4 Search below `sm` (Rulings 6, 7)

`search-open` swaps the header row's content for the search row: the existing field (`search-input`, same element, same
handlers) at `flex-1`, `h-11`, focused, and a 44 px text button `search-cancel` **Cancel** (clears, closes, blurs, focus
back to `search-open` — today's Escape). The panel opens full width under the 60 px row as C5 drew it. Escape, Enter,
arrows, `/` and Cmd/Ctrl+K behave as today; `/` from a page opens the row first. Below `sm` a transparent scrim
(`search-scrim`, no colour) under the panel closes it on a tap outside (C5 deferred: iOS tap-away). From `sm` the field
is always visible, as today; `search-open` and `search-cancel` are `sm:hidden`.

### 2.5 Loading

`(app)/loading.tsx` and the per-area skeletons sit under the layout's header, so they need no header bones; the admin
loading frame (C6 §1.7) is unchanged.

## 3. Shared rules

### 3.1 Segmented controls (`globals.css`; Ruling 12)

Below `sm`: `.seg-item` and `:where(.seg--sm) .seg-item` get `min-height: 44px` (`height: auto`), and `.seg` /
`.seg--sm` get `flex-wrap: wrap`. Covers the auth switch, Settings' radios, the DF1 and Disk-at-startup radiogroups, the
display editor's radios, the staging filter, the view toggle, `admin-sections`, the firmware filter. `TopNav` below `lg`
is not a `.seg` (§2.3).

### 3.2 Buttons (Ruling 13)

Below `sm`, each control in P14 / P9 / P10 / P11 gets `max-sm:min-h-11` (44 px; icon-only ones also `max-sm:min-w-11`):
the title disk row's actions and delete; the Disk card's mount / download; the Files header's switch row, New folder,
Add file; Settings' Change password… and Delete account…; the board-settings and display modal footers (Close, Cancel,
Save to board, Delete device…) and the `Modal` close (36 → 44); Users' `Delete…`; Invites' row buttons; Firmware's
`Promote to release…` and the pager links; `Clear finished`; `Change image…`; the pager-size select. Inputs that are a
form's main field (`collection-create`, `fs-filter`, `help-filter` wrappers) are 44 px tall. Nothing changes from `sm`.

### 3.3 The "?" (`help-tip.tsx`; Ruling 14)

The 24 px circle stays; below `sm` its hit area grows to 40 × 40 with a centred `before:` pseudo-element (`before:absolute
before:-inset-2`, the trigger `relative`). The popover anchors to the circle as today.

### 3.4 Toasts (`components/ui/sonner.tsx`; Ruling 15)

The `Toaster` gets `mobileOffset={{ bottom: 'calc(4.75rem + env(safe-area-inset-bottom))' }}` and an `offset` whose
`bottom` is the same below `lg` and 24 px from `lg` (a `--toast-bottom` custom property set in `globals.css` under a
`max-width: 1023px` media query), so a toast and its Undo sit above the bottom bar, not over the tabs.

## 4. Library (`/library`; boards: InfPhone Library, ModernLibrary, InfLibraryTable)

### 4.1 Head

Unchanged layout (PageHeader, Sort + Create ADF row, view toggle). The view toggle's two links are 44 × 44 (§3.1);
`library-sort` and `create-adf` 44 px tall below `sm`; `pager-size` 44 px (P16).

### 4.2 Collections as chips (`collection-rail.tsx`; Ruling 16)

Below `md` (where the rail is already a band above the titles), the rail becomes the board's **chip row**: one line,
`overflow-x-auto`, `px-4`, gap 8, scroll-snap off, no caption. Chips, in order: `collection-uncategorized`
(`Uncategorized`), each collection (`Link`, `collection-name` + `collection-count` inside, the dot), `collection-all`
(`All titles`), then `collections-new` (`+ New`). A chip: `h-11` (44 px; the board's 34 is below the target), `px-3`,
`rounded-full`, 13 px, `whitespace-nowrap`; current = ink fill, `var(--surface)` text, 600, `aria-current="page"`;
other = `var(--surface)`, `1px solid var(--line)`, ink, 500. The current chip scrolls into view on load
(`scrollIntoView({inline:'nearest'})`).

- The **current collection's** ⋯ (`collection-menu-<id>`, 44 × 44, same items Rename / Delete) sits directly after its
  chip; other chips have none. Rename shows today's inline field on a line under the chip row.
- `+ New` toggles today's create form (`collection-create` + Add, 44 px) on a line under the row; focus moves to the
  field; Escape or a create closes it.
- Each chip stays a `useSortable` **drop target** (a held card dropped on a chip files it, as on a rail row); the grip is
  not rendered below `md`, so collections are not reordered on a phone (Ruling 16).
- From `md` the rail is today's 240 px column, unchanged.

The library `loading.tsx` matches: below `md` a 44 px chip-row bone instead of six 38 px row bones (`loading.test.ts`).

### 4.3 Table below `sm` (`game-table.tsx`; Ruling 17)

Below `sm` the table drops `min-w-[760px]` and the Type / Year / Publisher / Disks / Size columns: each row (folder rows
and `game-row`) is `grid grid-cols-[40px_minmax(0,1fr)_44px]`, `min-h-[56px]`, `py-2`: the icon; a column with the name
(14/600, wraps, `overflow-wrap:anywhere`, no ellipsis) and a 12 px `var(--muted-2)` meta line joining the hidden facts
with ` · ` (folder: `Collection · 3 titles`; title: `1991 · Team 17 · 2 disks · 1.7 MB`, skipping empty ones); the ⋯
(`title-menu-<id>`, 44 × 44). The column header row is hidden below `sm`. The `↑ Library` up row and the pager are
unchanged. From `sm` the table is today's. Nothing scrolls sideways inside the card below `sm`.

### 4.4 Grid and title page

The grid is already two columns (`mobile.spec`); the card ⋯ is 44. Title page (`/games/[id]`): the hero and disk rows
stack as today; the row actions follow §3.2.

## 5. Header drive control

Only the geometry of §2.2 (a full-width 44 px `drives-compact` in the chip slot). Its menu (`drives-compact-menu`) is
unchanged; C8 replaces the content.

## 6. Devices (`/devices`; board: InfPhone Devices, ModernDevicesV2)

### 6.1 Head (P9)

Below `sm` the head's actions stack under the subtitle, each full width, 44 px, its label on one line: `write-next-card`
then `pair-device` (the "?" beside the first). From `sm` unchanged.

### 6.2 Card (P10; Ruling 18)

- `alias-edit` 44 × 44; `board-settings` 44 px; `display-toggle` 44 px; the drive row's protection, `Change disk`,
  `Eject` 44 px, in the board's two-column grid where they wrap (`grid grid-cols-2 gap-2`, Eject last, ink).
- **Second drive** below `sm`: the DF1 box shows its header (`DF1`, `Second drive (DF1)`, "?"), the current mode as one
  13/600 line (`DF1 · Network (PaulaNET)`; `second-drive-status` and the checklist lines as today), and a full-width 44 px
  button `df1-change-<id>` **Change second drive** (`aria-expanded`, `aria-controls` the radiogroup). The radiogroup
  (`second-drive-<id>`, same radios, same roving keys, same `aria-disabled` while saving) is hidden until the button is
  pressed; then it shows in place, one radio per row (44 px), and the button reads **Done**. A choice saves as today and
  does not close it. From `sm` the button is hidden and the radiogroup always shows, as today.
- Board settings and display modals: full screen as today; footer and close per §3.2.

## 7. Upload (`/ingest`; board: InfPhone Upload; Ruling 19)

Below `sm` the two drop cards become the board's **tiles**: a two-column grid (gap 10), each `dropzone` / `send-dropzone`
section a 96 px tile (`rounded-[14px]`, the dashed border, centred column, gap 6): a 34 px `DiskIcon` and a 13/600 label,
`Add to library` / `Send to Amiga`. The whole tile is the label of the card's existing hidden file input (the same input
`Browse files` / `Choose files` use today; no second input), so a tap opens the picker; a disabled send card (no board)
says why in the tile's label (`Pair a board first`, today's words where they exist). Under the tiles, full width: one 12
px `var(--muted)` hint line per tile (today's hint words, shortened only by dropping the second sentence), then the URL
row (`url-upload` and Fetch, unchanged, 44 px), then, with more than one board, the send board picker. The section
headings stay in the DOM (`sr-only`, no layout utility) so `aria-labelledby` keeps naming each drop target. Drops still
land on the tiles (a phone rarely drops; a tablet in phone width can).

Staging rows keep their actions (Ruling 19): the board's action-less cards would remove Stop / Delete / Retry on a phone.
The filter wraps with 44 px items (§3.1); `Clear finished` 44 px. From `sm` the page is C3's.

## 8. Disk files (`/disks/[id]/files`)

Controls per §3.2 (Disk card, Files header, row ⋯ already 44). The loading skeleton below `lg` matches the stacked Disk
card (56 px disk beside a 26 px h1 bone, then the space bar), removing C4's ~90 px jump (Ruling 27).

## 9. Settings, Help, Search, Sign in

### 9.1 Settings

Stacked cards as C5 (no section list below `lg`), plus the About section (§10). Radios 44 (§3.1), buttons 44 (§3.2), the
firmware switch row's hit area 44 tall.

### 9.2 Help (Ruling 26)

As C5. When the Topics disclosure closes after hydration on a load with a `#topic` hash, the page scrolls the target
back to the top (`scrollIntoView`) in the same frame, so the closing list does not leave the reader above the topic.
`help-nav-toggle` 44 px; `help-filter` 44 px.

### 9.3 Search

§2.4.

### 9.4 Sign in / Create account

As C5 (no hero below `lg`); the `auth-switch` items 44 px (§3.1).

## 10. About into Settings (Rulings 20–25)

### 10.1 The section (`src/components/prefs/about-server.tsx`, new; content moved from `(app)/about/page.tsx`)

`section id="about" aria-labelledby="about-heading" data-testid="settings-about"`, the Settings card look (`rounded-[20px]
p-6`, `p-5` below `sm`, surface, line ring, `scroll-mt-6`). Head: `h2#about-heading` **About this server** (17/600,
`tabIndex={-1}`, the h2 ring) with `HelpTip topic="about"`. Body (column, gap 16): today's six groups with **every test
id and word kept** — `about-web-app` (Commit `about-commit`, Built), `about-hosting` (`about-hosting-mode`),
`about-platform`, `about-firmware`, `about-library` (`about-library-titles` / `-disks` / `-versions` / `-bytes` with
`data-bytes`), `about-about-webadf` (What, Licence, More: Help · Repository). Each group: an `h3` 13/600 ink and today's
`dl` (`grid-cols-[max-content_1fr] gap-x-4 gap-y-1`, 13 px, labels `var(--muted)`, values wrap), separated by a 1 px
`var(--hairline)` rule instead of six glass cards. Same reads, same `settle()` per group, same `unavailable` word.

It is an async server component rendered inside `<Suspense>` with a one-card bone (the account cards do not wait for
`libraryUsage` / `firmwareSummary`; Ruling 23). It takes `orgId` from the page's `requireOrg()`.

### 10.2 Place

Settings' main column order: Preferences, Sign-in & password, Firmware updates, **About this server**, Delete account (the
board's order). The `SECTIONS` item becomes `{ href: '#about', label: 'About this server', focusId: 'about-heading' }` —
an in-page section like the others, so it can be current. `settings/loading.tsx` gains a fifth card bone before the
danger card (`loading.test.ts`).

### 10.3 `/about` (Ruling 22)

`next.config.ts` gains `redirects()` → `[{ source: '/about', destination: '/settings#about', permanent: false }]`
(307). `src/app/(app)/about/page.tsx` is deleted. A signed-out visit goes `/about` → `/settings#about` → `/sign-in` as
any Settings visit does. SideNav's arrival jump (C5) puts a full load of `/settings#about` on the section, also below
`lg` (the list is `hidden`, still mounted).

### 10.4 The (i) goes (Ruling 20)

`src/components/shell/about-link.tsx` is deleted and `<AboutLink />` leaves `(app)/layout.tsx`. About is reached from the
Settings list (from `lg`), the `More` menu's `About this server` (below `lg`), the Help topic's "?", search's Help group,
and `/about`.

### 10.5 Every other reference (grep of the whole repo at `36eed90`)

| File | Change |
|---|---|
| `README.md:263-265` | "the About page (the (i) at the top right)" → "Settings → About this server"; "so the About page shows the commit" → "so About this server shows the commit" |
| `.github/workflows/image.yml:47` | comment "the About page links it" → "Settings' About section links it" |
| `next.config.ts:7` | comment "The About page's build facts" → "About this server's build facts (Settings)" |
| `src/lib/help/topics.tsx:613-614` | the source comment names `src/components/prefs/about-server.tsx` and this spec; the body gains a first sentence: `You find it at the end of Settings, above Delete account.` (help text changes with what it describes) |
| `src/components/shell/side-nav.tsx:18` | doc comment's example `(/about)` → `(a route such as /help)` |
| `src/components/shell/side-nav.test.ts:11,27,28` | fixture route `/about` → `/help` (the test is about route items in general) |
| `src/app/(app)/settings/page.tsx:14,21` | comment and the item (§10.2) |
| `e2e/about-page.spec.ts` | §13.4 |
| `e2e/c5-layout.spec.ts:74-75,87` | §13.4 |
| `e2e/shell.spec.ts:35-46` | §13.4 |
| `e2e/contrast.spec.ts:370` | §13.4 |
| `e2e/devices-page.spec.ts:683` | test name only ("the About page says") → "About this server says"; no logic |
| `docs/superpowers/specs/*`, `docs/superpowers/plans/*`, `HANDOFF.md` | historic records: not rewritten; HANDOFF's C7 entry records the move |

`docs/self-hosting.md`, `scripts/`, `wifi-floppy/` and the proxy matcher hold no `/about` or `about-link` reference.

## 11. Admin (Rulings 8, 9)

### 11.1 Header and sections

The admin shell takes §2: one 60 px row (logo, ` admin`, search), the four-tab bar with More (Help, Settings, About this
server, Admin, Sign out — Admin is current through More). `admin-sections` wraps below `sm` (§3.1: two rows of 44 px
tabs) instead of scrolling in its clamp; the clamp's `overflow-x-auto` stays for widths where one row nearly fits.

### 11.2 Users

As C6 (rows stack below `sm`); `Delete…` 44 px.

### 11.3 Invites (P11; Ruling 9)

Below `sm` the Invites rows stack like Users (C6 Ruling 8 amended): the table keeps explicit `table` / `row` / `cell`
roles; each row is a column — the code (mono 16) with its state pill; a `data-label` line each for Issued, Expires, Used
by; then the actions in a wrapping row, 44 px: `Copy code`, `Copy link`, `Revoke`. The header row is hidden below `sm`.
Nothing scrolls sideways inside the card. From `sm` the table scrolls inside its card as today.

### 11.4 Scan, Firmware, Overview

Scan's TOSEC sets table (640 px, read-only) keeps scrolling inside its card. Firmware: filter 44 (§3.1), `Promote to
release…` and the pager 44 (§3.2). Overview unchanged.

## 12. States

- **Loading**: library rail bone (§4.2), disk-files skeleton (§8), Settings' fifth bone and the About section's own
  Suspense bone (§10). No header bones.
- **Error**: A1's `error.tsx` per segment, unchanged; the About section's per-group `unavailable` unchanged.
- **Empty**: no board → empty chip slot; no collections → chips `Uncategorized`, `All titles`, `+ New`; no send board →
  the send tile says so.
- **Busy**: unchanged (aria-disabled + guard); a busy radio in the opened DF1 group as today.
- **Signed out**: `/about` → `/settings#about` → `/sign-in`.

## 13. Test ids

### 13.1 Kept (name and meaning)

Shell: `app-header`, `admin-header`, `wordmark-home`, `drives-compact`, `drives-compact-menu`, `search-input`,
`search-panel`, `search-scrim`, `search-keys`, `search-hint`, `settings-link`, `sign-out` (the header controls, from
`lg`), `admin-email`, `page-skeleton`. Library: `collection-rail`, `collection-uncategorized`, `collection-all`,
`collection-name`, `collection-count`, `collection-menu-<id>`, `collection-rename-<id>`, `collection-delete-<id>`,
`collection-create`, `game-table`, `game-row`, `folder-row`, `title-menu-<id>`, `pager-size`. Devices: every C2 id,
`second-drive-<id>` and its radios, `second-drive-status-<id>`. Upload: `dropzone`, `send-dropzone`, their `-hint`
ids, the file inputs, `url-upload`. About: `about-web-app`, `about-hosting`, `about-platform`, `about-firmware`,
`about-library`, `about-about-webadf`, `about-commit`, `about-hosting-mode`, `about-library-titles`,
`about-library-disks`, `about-library-versions`, `about-library-bytes`. Admin: every C6 id.

### 13.2 New

`search-open`, `search-cancel`, `nav-more`, `nav-more-menu`, `more-help`, `more-settings`, `more-about`, `more-admin`,
`more-sign-out`, `collections-new`, `df1-change-<id>`, `settings-about`. Element ids: `about`, `about-heading`.

### 13.3 Removed

`about-link` (the (i)). Its four e2e sites change (§13.4).

### 13.4 Specs that change, and why

| Spec | Change |
|---|---|
| `about-page.spec.ts:10-27` | "the (i) opens About" → at 1280: Settings list `About this server` → `/settings#about`, `#about-heading` focused, the six groups visible; plus `goto('/about')` lands on `/settings#about` with `settings-about` in view (desktop and 390) |
| `about-page.spec.ts:35` | `goto('/about')` still works (redirect); expect the URL `/settings#about` |
| `shell.spec.ts:35-46` | the 16 px search-to-(i) check → search-to-gear at 1280; at 390 the header is one 60 px row: `wordmark-home`, `drives-compact` (when present) and `search-open` on one line |
| `contrast.spec.ts:370` | drop `[data-testid=about-link]` from the header focus list; add the tab bar's current and other tab and a `More` menu item (390) |
| `c5-layout.spec.ts:74-87` | `About this server` → `href="#about"`; clicking it marks it current and focuses `#about-heading` |
| `c5-layout.spec.ts:544-560, 667-…` | at 390 tap `search-open` before filling `search-input`; the panel sits below the 60 px row; `search-scrim` is present but transparent |
| `c6-admin-layout.spec.ts:97-118` | at 390 the admin header is one row with no gear / Sign out; they are `more-settings` / `more-sign-out` in `nav-more-menu` |
| `c6-admin-layout.spec.ts:604-640` | the bar holds four tabs that fit (no scroll), More current on `/admin*`; `admin-sections` wraps (no clipped tab); Invites stacks (replace the "still scrolls" assertion) |
| `drive-chips.spec.ts:407-445` | at 390 the compact control sits on the header's single row between `wordmark-home` and `search-open`, 44 px tall (replace "above the search box") |
| `header-overlap.spec.ts` | `WIDTHS` from 1024 up only; a new sweep at 640 / 768 / 1000: the bar is at the bottom, its four tabs are fully visible, the header is one row |
| `mobile.spec.ts:86-108` | the bar's tabs are Library, Devices, Upload, More, each ≥ 44 tall; More opens the menu and `more-help` reaches `/help` |
| `mobile.spec.ts:271-291` | "keeps every column reachable by scrolling" → below sm each row's name wraps whole, the meta line shows, the ⋯ is in view, nothing scrolls sideways |
| `mobile.spec.ts:849-…` | the two drop targets are tiles side by side (same `y`, each ≥ 96 tall) above the URL row |
| `library/loading.test.ts`, `settings/loading.test.ts` | the chip-row bone; the fifth card bone |
| `side-nav.test.ts` | fixture route (§10.5) |
| `e2e/c7-phone.spec.ts` (new) | §14 |

Regression only: `mobile.spec` (rest), `help.mobile.spec`, `url-upload -g 390`, `upload-staging -g 390`,
`identify-search -g 390`, `nfc-fob-button -g 390`, `cover-override -g phone`, `disk-files-layout -g 390`,
`devices-page -g "390|whole width"`, `second-drive` (desktop: the radiogroup is unchanged from `sm`), `collections`
(desktop rail), `library-table`, `search`, `shell`, `states`, `admin-*`.

## 14. Testing (`e2e/c7-phone.spec.ts`, `mobile` project settings)

One test per area, each asserting what was broken, by measurement, not by class:

1. Header at 390: one row ≤ 60 px; `wordmark-home`, chip, `search-open` on one line; each ≥ 44 × 44; no gear, Sign out
   or (i) visible. At 640, 768, 1000 (member with a board; admin): the four tabs fully visible (`scrollWidth ≤
   clientWidth` on the nav), header one row. At 1024 and 1280: today's header (`header-overlap` holds).
2. Bottom bar: four tabs, each cell ≥ 44 tall and ≥ 70 wide; current tab per route (`aria-current`); More current on
   `/help`, `/settings`, `/admin`; the menu's five items (four for a member) ≥ 44, on screen, each reaching its page;
   `more-sign-out` signs out; `more-about` lands on `#about` with the heading in view.
3. Search at 390: `search-open` → field focused, panel below the row, on screen; `search-cancel` clears and returns focus;
   a tap on the page outside closes the panel.
4. Library at 390: chips one row, each ≥ 44, current chip in view; the current collection's ⋯ ≥ 44 opens Rename /
   Delete; `+ New` makes a collection; a held card dropped on a chip files it; the table: a 70-character name wraps
   whole, meta line present, ⋯ in view, `scrollWidth ≤ clientWidth` in the card.
5. Devices at 390: the two head buttons one line each (height ≤ 48) and full width; `df1-change` opens the radiogroup,
   radios ≥ 44, a choice saves; Rename, Board settings, Change display, Eject ≥ 44.
6. Upload at 390: tiles side by side, ≥ 96 tall; a tap on a tile opens the chooser (`filechooser` event); Staging's top
   is within 844 px of the page top with no rows.
7. Settings at 390 and 1280: About is the fourth card, its six groups present; `/about` → `/settings#about`; the list item
   is current when clicked (1280).
8. Admin at 390: no tab clipped (bar, `admin-sections`); Invites rows stacked with Copy code / Copy link / Revoke ≥ 44 in
   view; no sideways scroll on all five pages.
9. Touch-target sweep at 390 over every page of §1: every `button`, `a.btn-like`, `[role=radio]`, `[role=tab]`, `select`
   and `summary` outside prose and outside the "?" is ≥ 44 tall (listed failures, soft asserts), and no page scrolls
   sideways at 360, 390, 414.
10. Toast at 390: a toast's box ends above the bar's top.

Screenshots for the operator's by-hand pass (C6 deferred): the build saves 390 shots of each page to the session
scratchpad only; none is committed (they show addresses). `pnpm lint` stays at zero errors.

## 15. Not in this phase

- The drive chip's content (board name, disk, `WP`) and its menu's look — C8.
- README screenshots and wording beyond §10.5 — C9.
- Reordering collections on a phone (Ruling 16); a multi-file picker into a disk's staging list (C4 Ruling 18).
- Removing Stop / Delete / Retry from staging cards (Ruling 19).
- A phone layout for the Library head (Sort / Create ADF / toggle stay three controls on two lines; not measured broken).
- `viewport-fit=cover` and top safe-area insets (Ruling 28).
- Swipe gestures, pull to refresh, a PWA manifest.
- Toast restyle to the board's ink toast (shell-wide, later).
- Admin audit log; search inside disks; forgot-password email (backlog).

## 16. Suggested task split

1. **Shell** (both layouts): `lg` breakpoint move, the 60 px row, `TopNav` tab look + More + `nav-more-menu`, the header
   controls hidden below `lg`, `--toast-bottom` + `Toaster` offsets; `mobile.spec:86`, `shell`, `header-overlap`,
   `drive-chips -g 390`, `c6-admin-layout -g 390` updates.
2. **Search opener**: `search-open` / `search-cancel`, the swap, the phone scrim; `c5-layout -g Search` updates, `search`
   regression.
3. **Shared sizes**: `.seg` 44 + wrap, the 44 px button list, the "?" hit area; touch sweep test.
4. **Library**: chips (+ loading bone), table below `sm`; `mobile.spec:271`, `collections`, `library-table` regression.
5. **Devices**: head buttons, card sizes, `df1-change`; `second-drive`, `devices-page` regression.
6. **Upload**: tiles, hint lines, URL row; `mobile.spec:849`, `url-upload`, `upload-staging` regression.
7. **About into Settings**: `about-server.tsx`, Suspense, list item, loading bone, redirect, page and (i) deleted, help
   text, README / workflow / config comments, side-nav fixture; `about-page`, `c5-layout`, `contrast` updates.
8. **Admin**: Invites stacking, sections wrap; `c6-admin-layout` updates.
9. **Disk files skeleton, Help hash jump, toast test, screenshots, lint gate.**

## Review Focus candidates

Inputs a phone user hits that the tests may miss:

- A finger tap on a chip in a row that is also scrolling sideways (does a short horizontal swipe navigate?), and a held
  card dragged onto a chip that is scrolled out of view.
- The More menu opened while the on-screen keyboard is up (search open), and rotating the phone with the menu open.
- `search-open` → type → tap a result: the keyboard closes and the page navigates once, not twice; Cancel with an
  in-flight request.
- iOS Safari's own bottom toolbar and home indicator against the 66 px bar (no `viewport-fit=cover`): the bar must not
  sit under the toolbar.
- The DF1 group opened, then the board goes offline / another tab changes the mode (LiveRefresh re-renders the card).
- A tile tap with a board that just went away (send tile disabled mid-tap), and a drop on a tile from a tablet.
- `/about` bookmarked while signed out; `/settings#about` reload on a phone (the hidden SideNav's arrival jump).
- An admin with a long address and a long org name in a stacked Invites / Users row at 360 px.
- Toast Undo tapped while the bottom bar is under it at 1023 px (sonner's own mobile breakpoint is 600 px).
- 360 px (small Android) and 414 px, not only 390; a tablet at 768 and 1000 px in portrait.

## Rulings (operator to review)

1. **The phone shell (60 px header row + bottom tab bar) applies below `lg` (1024), not below `sm`.** — measured: with a
   board the header nav shows 0 px of 317 at 640–700 and is clipped up to 1000; it fits from 1024 in every case (member,
   admin, both shells). Phase B left "bottom bar up to md or a narrower search" to this area: a bar up to `md` would still
   clip 158–248 px at 768–800, and a narrower search alone cannot free 286 px at 640. — cost if wrong: a 768–1023 tablet
   gets a tab bar instead of a header pill; `header-overlap`'s 640 / 768 widths change meaning.
2. **The phone header is the board's single row: logo, the drive chip filling the middle, a 44 px search button**; the
   wordmark word is shown from `sm` only. — InfPhone; 104–113 px → 60 px. — cost if wrong: the word `webfloppy` is not
   visible on a phone (the logo and the tab bar say where you are).
3. **C7 sets only the chip slot's geometry (full width, 44 px); the chip keeps today's `Drives n` content until C8.** —
   the roadmap gives the chip's content and menu to C8; doing both here would build it twice. — cost if wrong: between
   C7 and C8 a phone shows a wide chip reading `Drives 1`.
4. **The bar's fourth tab is the board's `More`, and it opens a menu (Help, Settings, About this server, Admin, Sign out)
   rather than linking to Settings.** — the board's `More` links to its Settings board, but Help, Admin and Sign out need
   a place on a phone and a menu reaches each in two taps without inventing a "More" page. The header gear and Sign out
   stay from `lg`. — cost if wrong: Help is two taps away on a phone (it was one); a menu component more in the shell.
5. **The current tab's bar is `--accent-amber` (#B5541A), not the board's #EE8A2A.** — the bar is the tab's main visual
   marker; #EE8A2A is 2.49:1 on the surface (non-text needs 3:1), #B5541A 4.86:1. Weight, ink and
   `aria-current` also mark it. — cost if wrong: a slightly darker orange than drawn.
6. **Below `sm` search is a 44 px button that swaps the header row for the field and a Cancel button; from `sm` the field
   shows as today.** — InfPhone; the same `search-input` element and handlers, so no search behaviour changes. — cost if
   wrong: one more tap to search on a phone; three e2e sites tap `search-open` first.
7. **Below `sm` a transparent scrim under the open search panel closes it on a tap outside.** — C5's deferred iOS
   tap-away bug; the scrim stays colourless, as C5 ruled for phones. — cost if wrong: a tap outside the panel that was
   meant for the page closes the panel first.
8. **The admin shell takes the same phone shell, with Admin reached through More (More is current on `/admin*`).** — the
   five-item pill scrolled 27 px and cut the current tab; four tabs always fit. — cost if wrong: on a phone the admin
   plane is two taps away from the app (one before).
9. **Invites rows stack below `sm` like Users (C6 Ruling 8 amended), keeping explicit table roles.** — the row actions sat
   off screen (880 px table) at 30 px; C6 kept the sideways scroll and deferred the 30 px buttons here. The read-only
   TOSEC sets table keeps scrolling. — cost if wrong: two stacked-table patterns to keep in step.
10. **`admin-sections` wraps onto two rows below `sm` instead of scrolling.** — `Firmware` was cut with no sign of more;
    wrapping shows all five. — cost if wrong: about 50 px more head on admin pages.
11. **Nothing at `lg` and wider changes except the (i) leaving and About joining Settings.** — the phone pass must not move
    the 1280 suite. — cost if wrong: none.
12. **Below `sm` every `.seg` item is 44 px tall and the track wraps.** — one rule fixes P13 on every page (Phase B's
    deferred "40/48 px and wraps"). — cost if wrong: segmented rows are taller on a phone; wrapped radiogroups take two
    lines more often.
13. **Below `sm` the named row and footer buttons are 44 px; from `sm` nothing changes.** — P14; per-control
    `max-sm:min-h-11` rather than a global button rule, so menus, chips inside rows and table cells are not inflated. —
    cost if wrong: a control left off the list stays small (the touch sweep, §14.9, lists them).
14. **The "?" keeps its 24 px circle and gets a 40 × 40 hit area below `sm`.** — it sits beside headings and controls with
    8 px gaps; a 44 px area would overlap its neighbours' areas. — cost if wrong: still under 44 (WCAG 2.5.8's 24 px is
    met; 2.5.5's 44 is not).
15. **Toasts sit above the bottom bar** (`mobileOffset` and a `--toast-bottom` offset below `lg`). — a toast over the tabs
    hides the nav while it shows, and its Undo shares the tabs' place. — cost if wrong: toasts appear ~60 px higher on a
    tablet.
16. **Below `md` the collections rail is the board's chip row; only the current collection shows its ⋯; `+ New` opens
    today's form; collections are not reordered on a phone.** — P7 (the first title at y ≈ 640 with two collections, +38
    per collection) and C1's deferred 20 / 28 px grip and ⋯; chips stay drop targets. Reorder needs a drag along a
    scrolling row or new Move items — new behaviour, iterate later. — cost if wrong: a phone user cannot reorder (from
    `md` they can); one tap more to rename another collection (open it first).
17. **Below `sm` the table shows the name (wrapping), a meta line with the hidden columns' facts and the ⋯; no sideways
    scroll.** — P6: names cut to 40 px and the ⋯ off screen; C1 kept the sideways scroll "so a phone can reach every
    column", but the facts are now on the meta line. — cost if wrong: no column sorting by eye on a phone;
    `mobile.spec:271` is rewritten.
18. **Devices below `sm`: the board's `Change second drive` button discloses the DF1 radiogroup in place (no modal); the
    head buttons stack full width.** — C2 handed the board's button here; a disclosure keeps the radiogroup's ids, keys
    and save path untouched, and the closed state shows the mode in words. — cost if wrong: one more tap to change DF1 on
    a phone.
19. **Upload below `sm`: the board's two 96 px tiles side by side, each the label of its card's existing file input, with
    the hint lines and the URL row under them; staging rows keep their actions.** — P8 (staging at y ≈ 890); C3 Ruling 30
    handed the tiles here. The board's action-less staging cards would remove Stop / Delete / Retry on a phone. — cost if
    wrong: the tiles' hints are shorter than the cards' (second sentences dropped); `mobile.spec:849` is rewritten.
20. **The header's (i) is removed at every width.** — the operator's order (2026-10-25). — cost if wrong: About is one
    tap further on a desktop (gear, then the list item).
21. **About is a Settings section `#about` ("About this server"), between Firmware updates and Delete account, listed as an
    in-page item.** — InfSettings' order; the operator named `/settings#about` (the board's anchor is `#server`). — cost
    if wrong: none.
22. **`/about` is a temporary (307) redirect in `next.config.ts`; the page file goes.** — a config redirect needs no route
    and runs before auth, so bookmarks, the Help topic and search keep working; 307 because a 308 is cached by browsers
    for good, and the operator revises decisions after seeing them. If the build finds the client router drops the hash
    on a soft navigation, the fallback is a server `redirect('/settings#about')` in the page instead (no in-app link
    points at `/about` any more, so only full loads use it). — cost if wrong: one extra round trip per `/about` load.
23. **The About section streams in its own `<Suspense>`; the account cards do not wait for it.** — `libraryUsage` sums
    blob sizes; Settings should not slow down for a section at its end. — cost if wrong: a bone flashes at the bottom.
24. **The six About groups become one card with `h3` groups and hairline rules, every test id and word kept.** — six
    glass cards inside a Settings card would be cards in a card. — cost if wrong: none.
25. **The help topic `about` says where About now lives; README, the image workflow comment and the next.config comment
    follow; historic specs, plans and HANDOFF entries are not rewritten.** — the rule that help text changes with the
    behaviour it describes; history stays history. — cost if wrong: an old spec still says `/about`.
26. **Help: when the Topics disclosure closes after hydration on a `#topic` load, the target is scrolled back into view.**
    — C5's deferred phone jump; one call, no layout change. — cost if wrong: none.
27. **The disk-files skeleton matches the stacked Disk card below `lg`.** — C4's deferred ~90 px jump on a phone. — cost
    if wrong: one skeleton more to keep in step.
28. **No `viewport-fit=cover`**: the root layout keeps Next's default viewport, so iOS keeps the bar out of the home
    indicator area and `env(safe-area-inset-bottom)` stays 0 outside standalone mode. — opting in would also need top
    insets in both headers and every full-screen modal: a separate change. — cost if wrong: a standalone (home-screen)
    web app shows the bar a few px higher than a native app would.
29. **Touch targets are 44 px for the controls this spec names, not by a global rule; prose links and the "?" are
    exempt.** — the operator's measure ("tap targets under 44 px for primary controls"); a global rule would inflate
    menus and inline links. — cost if wrong: a secondary control stays at 36–40 px.
30. **No migration, no new API route, no new package.** — cost if wrong: none.
