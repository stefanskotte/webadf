# WebFloppy redesign, Phase C area 3: Upload — design

Date: 2026-10-25. Roadmap Phase C step 3 (`2026-10-23-webfloppy-redesign-roadmap-design.md`): "Upload (send &
receive, the A6 staging list)". A **layout pass**: the behaviour is A6's (`2026-10-23-upload-staging-design.md`,
shipped df042b6) and stays A6's — the same rows, states, words, polling, routes and request bodies. Builds on Phase B
(`2026-10-24-phase-b-foundation-design.md`: tokens, `.glass-card`, `.wf-modal`, `.seg`/`.seg-item`, `DiskIcon`), C1
(`PageHeader size="lg"`, `library-look.ts`, `StateCard`) and C2 (`.seg--sm`, `driveDiskColor`, `--modal-foot`, the
roving radiogroup pattern of `boot-disk-setting.tsx`, the loading/empty-state pattern). Nothing here re-invents them.

Written under the operator's unattended authorization of 2026-10-24. Every design call is mine and is listed under
**Rulings** at the end, with what it costs if wrong.

Target board (session scratchpad `design-approved/`): **`InfUploadTransfer`** (APPROVED, inferred) is the page to
build. `ModernHeader` is the shell (Phase B already built it), `InfStates` and `InfPhone` (its Upload screen) are
context for states and the phone.

Measured against `5291ce2` (branch `feat/phase-c3-upload`).

## 0. Invariants

- Every `data-testid` in §9.1 keeps its name and its meaning. Ids that move onto a different element keep their names;
  the e2e sites that change because of a move or a control-type change are listed in §9.4.
- No schema change, no migration, no new route, no new package. `GET /api/staging`, `POST /api/staging/clear`, the
  ingest routes (`check`, `presign`, `complete`, `url`), `POST /api/transfers`, the per-row routes (cancel, retry,
  delete incl. `?only=receiving`, add to library, send, download) keep their routes and bodies. `StagingProvider`
  and its poll (3 s while anything moves, 10 s idle, paused while hidden) are unchanged.
- Self-host parity: no external URL, no font, no our-deployment-only path.
- Firmware, `wifi-floppy/`, the board and the Amiga are untouched.
- Behaviour kept: hashing in the browser, `.adz/.dms/.dmz` to ADF before hashing, HFE inspection, the size screen,
  the 500-item batches with ≤ 50 HFEs, upload concurrency 6, the represign on 403, `/complete`'s 409-with-reasons as
  data, the disk-set suggestion, the URL fetch and its refusals, `?board=` / `?from=` opening the filter, the board
  choice remembered in the browser (`useSendBoard`), the 4 MB send screen, "Show offline (N)", the signed-out answer
  rule, the change clock (`begin`/`end`), Clear finished by row keys (never a stored Amiga file), Stop's 409.
- "Show both values of a state": every state renders a word in each of its values; an absent element never stands
  for one value. `w-full` (or any width or layout utility) is never put on an `sr-only` element.
- In-app dialogs only; never `window.confirm`.

## 1. Page (`src/app/(app)/ingest/page.tsx`; board: `main`)

- `PageHeader size="lg"`: eyebrow **`Move files`** (Ruling 2), h1 `Upload`, subtitle (PageHeader's mono 13 px
  `var(--muted)`) unchanged: `Disks into the library, files to and from the Amiga — all through one staging list.`
  No page-level help (there is no `upload` topic; Ruling 27). The comment about the `/ingest` route stays.
- Body inside the page gutter (`px-4 sm:px-7`, `pb-10`), a column, gap 24 px:
  1. the two drop cards: `grid gap-5 lg:grid-cols-2 lg:items-stretch` — side by side from 1024 px, stacked below
     (Ruling 3);
  2. the Staging section (§4).
- `StagingProvider` wraps both, as today. `UploadCard` (`upload-card.tsx`) and `DropArea` (`drop-area.tsx`) are
  replaced by `DropCard` (§2) and deleted once unused.

## 2. Drop cards (`src/components/ingest/drop-card.tsx`, new; board: the two dashed `section`s)

One shell for both cards, so they read alike:

- `section` with `aria-labelledby` its `h2`, `data-testid` = the card's drop id (`dropzone` / `send-dropzone`, moved
  here from the inner label: Ruling 4), `data-over="true|false"`.
- Look: `relative p-6 rounded-[20px]`, `var(--surface)`, `1.5px dashed var(--dash)` (new token `#C4B9A2`), flex,
  gap 20, `items-center`; below `sm` `p-5`, gap 16. While a drag is over the card (`dragenter`/`dragover` until
  `dragleave`/`drop`): border `var(--ink)`, fill `var(--surface-2)` (pointer feedback, Ruling 29). Hover: border ink
  (board `.m-drop:hover`).
- The whole card handles `dragover` (`preventDefault`) and `drop` (`onFiles(e.dataTransfer.files)`), unless
  `disabled`; a drop while disabled is ignored, as today's disabled input ignores a pick.
- Left: `DiskIcon` `size={84}` (`56` below `sm`), `aria-hidden` by its own root; colour/set/title per card.
- Right column (flex-1, `min-w-0`, gap 8):
  - `h2` Bricolage 22/700 ink (20 below `sm`), then the card's help tip (if any) beside it, never inside it.
  - hint `${testId}-hint` (`dropzone-hint` / `send-dropzone-hint`) 13 px `var(--muted)`.
  - the card's controls (children).
- Props: `testId`, `headingId`, `title`, `help?`, `hint`, `disk: { color: DiskColor; set: string; title: string }`,
  `disabled?`, `onFiles?` (absent → not a drop target), `children`.

### 2.1 Add disks to the library (`dropzone.tsx`, `url-fetch.tsx`)

- Disk: `black`, set `ADF · ADZ · DMS · HFE`, title `Add to library`. `h2` `Add disks to the library`. No help tip.
- Hint (Ruling 5): `ADF, ADZ, DMS, DMZ or HFE. Hashed in your browser first — only missing disks upload.`
- Controls row (flex, gap 8, `flex-wrap`; below `sm` a column):
  - **Browse files** `add-browse`: a `<label htmlFor="add-file-input">`, ink 38 px (`h-[38px] rounded-[10px] px-3.5`,
    13/600 `var(--surface)`), `inline-flex items-center`. While a drop or fetch runs (`busy`): text `Working…`,
    `aria-disabled="true"`, 50 % opacity (Ruling 7). Focus ring on the label while its input has focus
    (`has-[:focus-visible]:ring-2`).
  - `file-input` (`id="add-file-input"`, `type=file multiple`, `accept` unchanged, `disabled={busy}`): `sr-only`, no
    other class.
  - **URL form** `url-fetch-form` (flex-1, `min-w-[220px]`; full width below `sm`), Ruling 6: a 38 px field
    (`h-[38px] rounded-[10px] px-2.5`, `var(--surface-2)`, `1px solid var(--line)`, flex, gap 6; `h-11` below `sm`)
    holding `url-input` (transparent, borderless, 13 px ink, `placeholder="or paste a URL…"`, placeholder
    `var(--muted-2)`, `aria-label="Or fetch from a URL"`, `aria-describedby` the hint and the status) and
    `url-fetch` (inside the field at its right: `h-7 rounded-[8px] px-2.5`, `var(--surface)`, line border, 12/600 ink;
    `h-9` below `sm`, so the field is 44 px: `url-upload` "fit a 390 px screen" asks ≥ 44) with `Fetch` / `Working…`.
    Enter submits (a form). Disabled rules unchanged.
  - Under the row, 12 px `var(--muted-2)`, `id="ingest-url-hint"`: `A URL can also be a .zip or .lha of them, up to
    20 MB, from a public http(s) address.`
  - `url-status` (`role="status"`, `aria-live="polite"`, `min-h-[1em]`, 12 px): words unchanged; colour
    `var(--danger-fg)` / `var(--success-fg)` / `var(--muted-2)` by tone.
- `SetSuggestion` stays under the controls, inside the card (restyle: tokens only; ids and words unchanged).

### 2.2 Send files to the Amiga (`send-panel.tsx`)

- Disk: `blue`, set `Any file · 4 MB`, title `To the Amiga`. `h2` `Send files to the Amiga`, the `send` help tip.
- Hint: `Any file up to 4 MB. It waits here until Transfer on the Amiga takes it, into the folder Transfer saves to.`
- **No board** (`targets.length === 0`): disk `grey`; instead of the hint, `send-no-board` (13 px muted, words and the
  `Devices` link unchanged); no Choose files; the card is not a drop target (`onFiles` absent). Ruling 10.
- Otherwise the controls (flex, gap 10, `flex-wrap`, `items-center`):
  - **Choose files** `send-browse`: `<label htmlFor="send-file-input">`, the same ink 38 px look; `send-file-input`
    `sr-only` (`resetAfterPick` kept).
  - The board line (Ruling 8), 13 px, a span per part so each keeps its id:
    - one board: `send-board` `` `To ${name} · ${targetState(t, now)}` `` (name 600 ink, `overflow-wrap: anywhere`;
      the rest `var(--muted)`);
    - `send-receiver` (`role="status"`, `data-ok`): `` `${ok ? '✓' : '•'} ${text}` `` from `receiverLine`, colour
      `var(--success-fg)` when ok else `var(--warning-fg)`, 13/500; the mark is text, so both values read without
      colour.
  - Two or more boards: under the controls, `send-board-picker` — a `fieldset` (sr-only `legend` `Board to send to`),
    `var(--surface-2)` 12 px-radius box `p-2.5`, gap 4; each `send-board-<id>` a `label` row (32 px min, 13 px) with a
    native radio (`accent-color: var(--ink)`), the name (600 ink, wraps), `targetState` (12 px; `var(--success-fg)`
    online, else `var(--muted-2)`), and `Name it` (12 px underline muted) for a default name; then
    `send-show-offline` `Show offline (N)` (12 px underline muted). Logic unchanged. Ruling 9.

## 3. Shared look rules (`src/lib/upload-look.ts`, new)

Pure, client-safe, unit-tested:

- `directionPill(kind: 'lib' | 'out' | 'in')` → `{ label, arrow, bg, fg }`:
  `lib` `To library` `↓` `var(--track)` / `var(--muted)`; `out` `To Amiga` `→` `var(--to-amiga-bg)` /
  `var(--accent-blue)`; `in` `From Amiga` `←` `var(--from-amiga-bg)` / `var(--from-amiga-fg)`.
- `toneLook(tone: Tone)` → `{ fg, dot }`: `done` `var(--success-fg)` / `var(--online-dot)`; `busy`
  `var(--warning-fg)` / `var(--fetch-dot)`; `wait` `var(--muted)` / `var(--dash)`; `fail` `var(--danger-fg)` /
  `var(--danger-fg)` (Ruling 28).
- `rowDiskColor(v: ViewRow): DiskColor` (Ruling 17): failed (`tone === 'fail'`) → `cream`; a known title
  (`v.gameId`) → `driveDiskColor(v.gameId)`; else `out` → `blue`; `in` → `black` for a disk image, `grey` otherwise;
  `lib` → `black`.
- `filterAfterKey(current: StagingFilter, key: string): StagingFilter | null` — ArrowRight/ArrowDown → next,
  ArrowLeft/ArrowUp → previous, wrapping, in the order `all, in, out, lib`; Home → `all`; End → `lib`; else null.
- `FILTERS` (moved from `staging-list.tsx`, labels unchanged) and `EMPTY_UNDER` (unchanged words).

`src/lib/upload-staging.ts`: `ViewRow` gains `pct: number | null` — the server row's `pct` while `sending` or
`receiving`, else `null` (library and send-upload rows: `null`). Nothing else in the model changes.

## 4. Staging section (`staging-list.tsx`; board: `section[aria-label="Staging"]`)

`section` `id="from-amiga"` (the Devices Transfer box links `/ingest?from=<id>#from-amiga`), `aria-labelledby=
"staging-heading"`, `scroll-mt-24`: `p-5` (`p-4` below `sm`), 20 px radius, `var(--surface)`,
`box-shadow: 0 0 0 1px var(--line)`, column, gap 12.

### 4.1 Header row (flex, gap 12, `items-center`, `flex-wrap`)

- `h2#staging-heading` `Staging` 16/600 ink, `tabIndex={-1}` (a focus target, §6.3), then the `from-amiga` help tip.
- **Filter** `staging-filters` (Ruling 11): `div role="radiogroup" aria-label="Show"`, class `seg seg--sm`,
  `data-value` = the filter. Four `button role="radio"` `seg-item`, `aria-checked`, roving `tabIndex` (0 on the
  checked one, −1 on the rest), in the order of `FILTERS`: `staging-filter-all` `All`, `-in` `From the Amiga`,
  `-out` `To the Amiga`, `-lib` `To the library`. Each item: the label, then the count
  `<span className="font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>` (the item's text ends with the count,
  as `upload-staging.spec` reads `/3$/`). A click selects; `filterAfterKey` on keydown moves focus and selects. Below
  `sm` the group may wrap (`flex-wrap`).
- A spacer (`flex-1`).
- **Refresh state** `staging-refresh`, 12 px, `data-state` (Ruling 13):
  - before the first answer: `Reading…` (`var(--muted-2)`);
  - the last read was good: `Up to date` (`var(--muted-2)`);
  - the last read failed: the inner span `staging-refresh-failed` `Couldn't refresh` (600, `var(--danger-fg)`,
    `role="status"`); the next good read turns it back to `Up to date`.
- **Clear finished** `staging-clear-finished` (Ruling 12): always rendered; `h-[34px] rounded-[9px] px-3`,
  transparent, `1px solid var(--line)`, 13/500 ink, hover `var(--track)`; text `` `Clear finished (${n})` ``;
  `disabled` when `n === 0` or while clearing (then text `var(--muted-2)`, `cursor-default`). Logic unchanged.

### 4.2 The list (`ul[aria-label="Staging"]` `staging-list`)

Flex column, no outer border (the board's rows sit on the section), `md:max-h-[36rem] md:overflow-y-auto`
(Ruling 26; `send-to-amiga` "a long queue" measures it). Rows per §5. Under the rows:

- `staging-empty` (§6.1) or `staging-reading` (§6.2) when there are no rows to show.

### 4.3 Footer

A row (flex, gap 4 16, `flex-wrap`), 12 px `var(--muted-2)`:
- the footnote, words unchanged: `Files from the Amiga are kept 30 days. Anything here can go on to another place: a
  file from the Amiga into the library, a library disk to the Amiga.`
- each board with a key: `from-amiga-key` `` `${name}: board key ` `` + `<strong>` (600 ink) the digits — text
  unchanged (`Bench: board key AB12`), Ruling 15.

## 5. Rows (`src/components/ingest/staging-row.tsx`, new, from `staging-list.tsx`'s `Row`)

`li` `data-testid="staging-row"`, `data-kind`, `data-state`, `data-key` (unchanged). `rounded-[10px] px-2 py-2`,
`border-b 1px var(--hairline)`, hover `var(--modal-foot)`.

### 5.1 Parts, in DOM order

| Part | Id | Look |
|---|---|---|
| disk | — | `DiskIcon size={32}` `color={rowDiskColor(v)}`, no set/title (decorative) |
| direction pill | `staging-dir-<key>` | `rounded-full px-[9px] py-0.5`, 12/600, `directionPill(kind)` bg/fg; `<span aria-hidden>{arrow}</span>` then the label; `justify-self-start`, no wrap |
| name block | — | column, gap 2, `min-w-0`: the name (mono 13/500 ink, `overflow-wrap: anywhere`, Ruling 19) + `ingest-note` (12 px muted, after the name, as today); then `staging-where-<key>` (12 px `var(--muted-2)`, wraps) — `v.where` |
| size | `staging-size-<key>` | mono 12 `var(--muted-2)`, right-aligned; `ingest-hd-tag` after it when HD (today's rule) |
| status block | — | column, gap 5: `staging-status-<key>` (flex, gap 6, 12/600, `toneLook(tone).fg`; a 7 px dot `toneLook(tone).dot`, `aria-hidden`; then the status text, or `Failed · ` + `ingest-note` for a refused library file, as today); then, only when `v.pct !== null`, `staging-progress-<key>` (`aria-hidden`, 5 px `var(--track)` rounded bar, inner `var(--fetch-dot)` at `width: ${pct}%`; Ruling 20) |
| actions | `staging-actions-<key>` | flex, gap 6, `flex-wrap`, `justify-end` (xl) / `justify-start` (below) — §5.3 |

### 5.2 Layout (Ruling 18)

- **From `xl` (1280 px)**: one line, the board's grid:
  `xl:grid-cols-[40px_140px_minmax(0,1fr)_90px_190px_400px]`, gap 14, `items-center`, `min-h-[58px]`.
- **Below `xl`**: a three-line card in the same `li`: `grid-cols-[40px_minmax(0,1fr)_auto]`, gap 6 12:
  disk `row-span-3 self-start`; name block `col-start-2 row-start-1`; pill `col-start-3 row-start-1 justify-self-end`;
  status block `col-start-2 row-start-2`; size `col-start-3 row-start-2`; actions `col-span-2 col-start-2
  row-start-3`. Every placement class is reset with its `xl:` counterpart (`xl:col-auto xl:row-auto
  xl:col-start-auto xl:row-start-auto xl:row-span-1 xl:col-span-1`), so the DOM order is the line order at `xl`.
- Nothing scrolls sideways at any width; long names and where lines wrap (Ruling 19).

### 5.3 Actions (words, ids, `aria-label`s and handlers unchanged; look per Ruling 21)

Base look `act`: `h-8 rounded-[8px] px-2.5`, `var(--surface)`, `1px solid var(--line)`, 12/500, ink; hover
`var(--track)`; `disabled:opacity-50`.

| Action | Id | Look |
|---|---|---|
| Open title | `staging-open-<key>` | a `Link` with `act` (was an underlined link) |
| Add to library | `staging-add-<key>` | `act` |
| Download | `staging-download-<key>` | `act` |
| Send to Amiga… | `staging-send-<key>` | the native `select` (Ruling 23) with `act` plus `pr-7` and a 12 px chevron background (`appearance-none`, an inline SVG chevron in `var(--muted)` drawn as a sibling `span aria-hidden` over the right edge, `pointer-events-none`); first option `Send to Amiga…`, then `targetLabel(t)` per target (Name (MAC), kept) |
| Delete | `staging-delete-<key>` | `act`, text `var(--danger-fg)` |
| Stop | `staging-stop-<key>` | `act`, text `var(--danger-fg)` (Ruling 21) |
| Cancel | `staging-cancel-<key>` | `act`, text `var(--danger-fg)` |
| Retry | `staging-retry-<key>` | ink fill, `var(--surface)` text, no border (the row's one recovery step) |
| Clear | `staging-clear-<key>` | `act` |

The order per row is `stagingView`'s, unchanged. A receiving row offers Stop only (Ruling 22).

### 5.4 Confirm (`staging-confirm.tsx`; Ruling 24)

Keeps its own focus handling (Cancel takes focus on open — `from-amiga` asserts it; Escape cancels; Tab stays
inside; the opener gets focus back when it still exists). Restyle: panel `glass-card wf-modal`, `max-w-[440px]`,
`p-6`; the question `h2` Bricolage 20/700 ink, `overflow-wrap: anywhere`; footer gap 10, `justify-end`:
`staging-confirm-cancel` secondary 38 px (`var(--surface)`, line border, 13/600 ink) `Cancel`;
`staging-confirm-yes` 38 px `var(--danger-fg)` fill, white 13/600, the verb (`Delete` / `Stop`). Backdrop
`var(--scrim)`. Words and ids unchanged.

## 6. States

### 6.1 Empty

`li` `staging-empty` (only once the client has an answer or holds rows, as today — `stagingReady` waits on it):
`py-10`, centred column, gap 10: `DiskIcon` `cream` 48 px, then the text 14 px `var(--muted)`, words unchanged —
`Nothing here yet. Drop disks for the library, or files for the Amiga.`, or under a filter `Nothing to the library
right now.` / `Nothing to the Amiga right now.` / `Nothing from the Amiga right now.` (`EMPTY_UNDER`).

### 6.2 Reading / unreadable (Ruling 14)

`li` `staging-reading`, 13 px `var(--muted)`, `px-2 py-3`, while there are no rows and no answer yet:
- no read has failed yet: `Reading the list…` (the server render says this; not `staging-empty`, so the hydration
  wait holds);
- the first read failed (`!loaded && refreshFailed`): `Couldn't read the list. It tries again every few seconds.`
  (`data-state="failed"`).

### 6.3 Focus after a removal (Ruling 25)

When the confirm closes after a Delete or Stop and its opener is no longer in the document (the row went), focus
moves to `#staging-heading`. A row's Clear that removes the focused row does the same.

### 6.4 Loading (`src/app/(app)/ingest/loading.tsx`, new; Ruling 31)

`data-testid="upload-skeleton"` inside `PageSkeleton`: a 44 px heading bone and a subtitle bone, then
`grid gap-5 lg:grid-cols-2` of two card bones (`h-[134px] rounded-[20px]`, `1.5px dashed var(--line-strong)`, each
holding an 84 px square bone and three line bones), then a section bone (`rounded-[20px]`, surface, line ring)
holding a 34 px header bone and four `data-skeleton-row` 58 px row bones. Nested under `(app)/loading.tsx` like the
library's and the devices', so status codes do not change.

### 6.5 Not found / error

Unchanged (A1's `error.tsx`; the page has no not-found case).

## 7. Tokens (`src/app/globals.css`, webadf `:root`, a comment line each; Ruling 28)

| Token | Value | Use |
|---|---|---|
| `--dash` | `#C4B9A2` | the drop cards' dashed border, the waiting dot |
| `--to-amiga-bg` | `#DCE8F5` | the `To Amiga` pill (text `--accent-blue`) |
| `--from-amiga-bg` | `#E5F0DF` | the `From Amiga` pill |
| `--from-amiga-fg` | `#2C5E24` | its text |

The board's `#7A7262` captions are `--muted-2` (Phase B ruling 4); its fail text `#9A2A1C` is `--danger-fg`; its row
divider `#F0EADF` is `--hairline`; its row hover `#FBF8F1` is `--modal-foot`; its progress `#EFE9DD` / `#E9A23B` are
`--track` / `--fetch-dot`.

## 8. Contrast pairs (WCAG 2.x; in `design-tokens.test.ts` and measured on the page in `contrast.spec.ts`)

| Pair | Ratio | Where |
|---|---|---|
| `--muted` `#5B5446` on `--track` `#EFE9DD` | 6.20 | `To library` pill |
| `--accent-blue` `#1D4F86` on `--to-amiga-bg` `#DCE8F5` | 6.72 | `To Amiga` pill |
| `--from-amiga-fg` `#2C5E24` on `--from-amiga-bg` `#E5F0DF` | 6.53 | `From Amiga` pill |
| `--success-fg` `#1F6A2A` on `--surface` / `--modal-foot` | 6.55 / 6.28 | done status, receiver ✓ line |
| `--warning-fg` `#7A4A08` on `--surface` / `--modal-foot` | 7.35 / 7.04 | moving status, receiver • line |
| `--muted` on `--surface` / `--modal-foot` | 7.37 / 7.07 | waiting status, drop-card hints, empty text |
| `--danger-fg` `#B3341F` on `--surface` / `--modal-foot` | 6.03 / 5.78 | failed status, Delete/Stop/Cancel, `Couldn't refresh` |
| `--muted-2` `#6E6657` on `--surface` / `--modal-foot` | 5.58 / 5.35 | where line, size, footnote, refresh state, disabled Clear finished |
| `--muted-2` on `--track` | 4.69 | an unchecked filter's count |
| `--muted-2` on `--surface-2` | 5.08 | the URL placeholder, picker states |
| ink `#24211B` on `--track` | 13.28 | filter labels |
| ink on `--surface-2` | 14.37 | URL text, picker names |
| `--surface` on ink | 15.79 | Browse files, Choose files, Retry |
| white on `--danger-fg` | 6.13 | the confirm's yes |

The page measurement covers, on real elements: the three pills, a done / moving / waiting / failed status, a where
line on a hovered row (`--modal-foot`), a size, an unchecked filter count, the footnote, the Send card's receiver line,
a Delete action, Browse files, and the drop-card hint. The dashed border, the dots and the progress bar are non-text
decoration beside words that carry the state (WCAG 1.4.11 does not apply to them).

## 9. Test ids

### 9.1 Kept (name and meaning)

Drop cards: `dropzone` (moved: the library card section), `file-input`, `url-fetch-form`, `url-input`, `url-fetch`,
`url-status`, `set-suggestion*`, `send-dropzone` (moved: the Send card section), `send-file-input`, `send-no-board`,
`send-board`, `send-receiver` (+ `data-ok`), `send-board-picker`, `send-board-<id>`, `send-show-offline`.
Staging: `staging-list`, `staging-row` (+ `data-kind`, `data-state`, `data-key`), `staging-status-<key>`,
`staging-filter-<all|in|out|lib>` (now `role="radio"` with `aria-checked`; text still ends with the count),
`staging-clear-finished` (now always present), `staging-empty`, `staging-refresh-failed`,
`staging-<open|add|download|send|delete|stop|cancel|retry|clear>-<key>`, `staging-confirm`, `staging-confirm-yes`,
`staging-confirm-cancel`, `from-amiga-key`, `ingest-note`, `ingest-hd-tag`, `help-tip-send`, `help-tip-from-amiga`.
Elsewhere (untouched): `send-adf-<id>`, `send-board-select`, `device-send-<id>`, `device-upload-<id>`.

### 9.2 New

`add-browse`, `send-browse`, `dropzone-hint`, `send-dropzone-hint`, `staging-filters` (+ `data-value`), `staging-refresh` (+ `data-state`),
`staging-reading` (+ `data-state`), `staging-dir-<key>`, `staging-where-<key>`, `staging-size-<key>`,
`staging-progress-<key>`, `staging-actions-<key>`, `upload-skeleton`; `data-over` on both drop cards.

### 9.3 Removed

None.

### 9.4 Specs that change, and why

| Spec | Change |
|---|---|
| `from-amiga.spec.ts:162`, `:168` | `toHaveAttribute('aria-pressed', 'true')` → `('aria-checked', 'true')` (Ruling 11) |
| `send-to-amiga.spec.ts:151`, `:181` | same |
| `from-amiga.spec.ts:125`, `send-to-amiga.spec.ts:217`, `upload-staging.spec.ts:117` | `staging-clear-finished` `toHaveCount(0)` → `toBeDisabled()` and `toHaveText('Clear finished (0)')` (Ruling 12) |
| `upload-staging.spec.ts` | new tests (plan Tasks 3–5): filter arrows, Clear finished (0), refresh state words, unreadable first read, row parts and the xl one-line layout, progress bar width, focus after Delete, Browse files `Working…` |
| `contrast.spec.ts` | new Upload test (§8) |
| `screenshots.shots.ts` | a new `upload` shot after the demo ingest (Ruling 32) |

Regression only (no edit expected): `ingest-ui`, `url-upload` (its `getByLabel('Or fetch from a URL')` and the 390 px
Fetch box hold by §2.1), `hd-disks -g "uploaded HD ADF"`, `hfe-disks` (the upload tests), `disk-sets -g "upload:"`,
`mobile.spec.ts:836` (stacked drop cards, a 200-byte saved path wraps) and its nav test, `states`, `shell`, `help`,
`devices-page -g "Transfer|from the Amiga"` (the Devices links into this page).

## 10. Phone (390 px) — only what the boards and today's specs pin

Area 7 owns the phone pass. Here: the drop cards stack full width (`mobile.spec.ts:836` asserts `send-dropzone`
below `dropzone`), each with a 56 px disk; Browse files and the URL field stack (`url-upload`: Fetch in view, ≥ 44 px,
no overflow); the filter wraps; rows are the three-line card (§5.2) with their actions wrapping on line 3; the confirm
fits (`w-full max-w-[440px]` in a `p-4` scrim). Nothing scrolls the page sideways. InfPhone's two 96 px tile
buttons and action-less staging cards are area 7 (Ruling 30).

## 11. Help (`src/lib/help/topics.tsx`; the text changes with what it describes)

- `send`, "Three ways to send": `On the Upload page, drop files on <em>Send files to the Amiga</em>, or press
  <em>Choose files</em>; with more than one board, pick the board under it.` (rest unchanged). GoodToKnow "Clear
  finished drops …" unchanged.
- `from-amiga`, "Your board, and only yours": `The same four digits appear under the Staging list on the Upload page,
  so check they match your board.` (was "appear on this page").
- `from-amiga`, "In the list": add `<em>Show</em> picks which rows the list holds: All, From the Amiga, To the Amiga or
  To the library.` after the existing two sentences.
- The `send` and `from-amiga` source comments name `upload-look.ts`, `staging-row.tsx` and this spec.
- No other topic mentions the Upload page's layout (`disk-sets` "the upload page suggests…" stays true).

## 12. Out of scope

- The header, nav and the phone bottom bar (Phase B; area 7).
- Toasts restyled to the board's ink toast (shell-wide, later).
- Persisting library rows, byte-level upload progress, a per-board filter, a "Send to Amiga" menu on library rows
  (A6's out-of-scope list).
- Moving `StagingConfirm` or `SetSuggestion` onto the shared `Modal`.
- The disk pages' Send controls (`send-button.tsx`), the Devices Transfer box.

## Rulings (operator to review)

1. **A layout pass on A6, nothing more.** Rows, states, words, polling, routes, bodies and the provider stay as A6
   shipped them; where the board and A6 disagree on behaviour, A6 wins and the ruling says so. Cost: the page differs
   from the board in a few words (Ruling 16).
2. **Eyebrow `Move files`** (board; was `Add disks`), `PageHeader size="lg"`; the subtitle keeps PageHeader's mono
   13 px like the other redesigned pages (board: sans 14). Cost: one font differs from the board.
3. **The drop cards sit side by side from `lg` (1024 px)**, not from `sm` (640 px) as A6 had: an 84 px disk, a 22 px
   heading and the Browse + URL row need about 450 px each. Cost: tablets in portrait see them stacked.
4. **The whole dashed card is the drop target** (board), so `dropzone` / `send-dropzone` move from the inner label to
   the `section`. The file picker opens from Browse files / Choose files only; a click on empty card space no longer
   opens it (the card now also holds the URL field, which a wrapping label would hijack). Cost: one fewer way to open
   the picker.
5. **The library card's hint says only what a drop takes** (`ADF, ADZ, DMS, DMZ or HFE`): the board's ".zip / .lha
   of them" is true only for a URL (`DISK_IMAGE_PATTERN` filters drops), so that half moves to the URL hint. Cost: the
   hint reads differently from the board.
6. **The URL field sits inline beside Browse files** (board), keeps its **Fetch** button inside the field (the board
   has none; a field with no visible submit is undiscoverable on a phone), and keeps the accessible name `Or fetch
   from a URL` (`url-upload.spec` finds it by that label). The board's placeholder `or paste a URL…` is used. Cost:
   the field is busier than drawn.
7. **Browse files reads `Working…` while a drop or fetch runs** (today the input is silently disabled). Both values
   in words. Cost: none.
8. **The Send card's board line keeps today's words**: `To <name> · online` and the full receiver sentence with its
   `✓` / `•` mark (`Transfer is running on the Amiga`), not the board's short `To WifiFloppy1 · Transfer running` with
   a dot. `send-to-amiga.spec` asserts the exact sentences, and the mark reads without colour. Cost: a longer line.
9. **Two or more boards: a compact radio list inside the Send card** (board silent), native radios, names (with
   `Name it` for a default name) — the `Name (MAC)` labels stay where boards must be told apart without context, the
   per-row Send to Amiga… menu. Cost: the card grows with many boards; "Show offline (N)" keeps it short.
10. **No board that can take files: the Send card keeps its shape** with a grey disk, the `send-no-board` sentence
    and its Devices link, no Choose files, and it is not a drop target. Cost: an inert card.
11. **The filter becomes a radiogroup** (board `role="radiogroup"`), on `.seg .seg--sm` like C2's DF1 radios, with
    roving arrow keys (selecting a filter sends nothing, so arrows select at once). The board's `surface-2` strip is
    the C2 `track` strip. Four e2e sites move from `aria-pressed` to `aria-checked`. Cost: spec churn.
12. **Clear finished is always shown, with its count**; at `(0)` it is disabled. Hiding it at zero expressed "nothing
    to clear" by absence. The board's label has no count; the count stays (three specs read it). Cost: three specs
    change from "absent" to "disabled, (0)".
13. **The refresh state is shown in words in all three values**: `Reading…`, `Up to date`, `Couldn't refresh`. Today
    only the failure shows. `staging-refresh-failed` stays as the failed value's id. Cost: one more word in the header.
14. **A first read that fails says so** (`Couldn't read the list. It tries again every few seconds.`) instead of
    `Reading the list…` forever — A6's deferred minor. Cost: none.
15. **The board keys (`Bench: board key AB12`) move to the footer line** beside the 30-day note; the board does not
    draw them, and the header row has no room. Text unchanged. Cost: further from the From the Amiga rows.
16. **Row words stay A6's**: `Arriving · N %` (board `Uploading · 47%`), `Stored · a disk image` (board `Stored · an
    ADF`), `Added` (board `Added · 2 disks`: a row is one file), `into the library · <title>` (board `· Games`, a
    collection the row does not know), `from <board>` (board adds the Amiga folder, which the server does not keep).
    Specs and Help use today's words. Cost: words differ from the board.
17. **Each row gets the board's 32 px disk**, coloured by `rowDiskColor`: a failed row cream, a row with a title the
    title's `driveDiskColor` (as on the Devices drive box), else To Amiga blue, a disk image from the Amiga black,
    another Amiga file grey, a library row black. Cost: an untyped title is cream in the library but coloured here
    (C2 Ruling 9's mismatch, again).
18. **The board's one-line grid from `xl` (1280 px) only**; below it each row is a three-line card (the phone board's
    staging card, with its actions). At 1024–1279 a 400 px action column leaves the name about 50 px. Cost: laptops
    narrower than 1280 see the stacked rows.
19. **Names and where lines wrap; nothing is cut with an ellipsis** (board: `nowrap` + ellipsis). A saved path or a
    long Amiga name must be readable whole, and there is no hover on a phone; `mobile.spec.ts:836` reads a 200-byte
    saved path. Cost: taller rows than drawn.
20. **The progress bar shows only when a percent is known** (sending, receiving), `aria-hidden`, under the status
    that says the percent. Checking / Uploading library rows have no bar (the browser has no byte progress — A6 out
    of scope). Cost: the library side looks less lively than the board.
21. **Row actions are the board's 32 px outline buttons; destructive ones are red**: Delete and Cancel (board) and
    also **Stop** (the board drew it ink, but it deletes what arrived and asks first). **Retry is ink-filled**, the
    row's one recovery step. **Open title** is a link styled as the button. Cost: Stop differs from the board.
22. **A receiving row offers Stop only** (board: Stop and Delete). Deleting a file still arriving *is* Stop; two
    buttons for one act invite the wrong confirm. Cost: one action fewer than drawn.
23. **Send to Amiga… stays a native `select`**, styled as the board's outline button with a chevron: keyboard, screen
    readers and phones get their native picker, and `from-amiga.spec` picks by `selectOption`. Options keep
    `targetLabel` (`Name (MAC)`). Cost: the open list is the platform's, not ours.
24. **The confirm keeps its own markup**, restyled (440 px, Bricolage question, danger yes): the shared `Modal`
    focuses its first tabbable element (the close X), and this confirm must focus Cancel (`from-amiga.spec`
    asserts it). C2 Ruling 31 kept two dialogs off `Modal` for the same kind of reason. Cost: a third modal mechanism
    lives on.
25. **After a Delete, Stop or Clear removes the focused row, focus goes to the Staging heading** — A6's deferred
    minor (focus fell to `body`). Cost: none.
26. **The list keeps its 36rem scroll box from `md`** (`send-to-amiga` "a long queue" measures it); the board lets the
    section grow to the page bottom. Cost: a second scroll area on a tall screen.
27. **No help tip on the library card** (there is no `upload` topic and HD/HFE notes sit on the rows); `send` beside
    the Send heading and `from-amiga` beside Staging, as today. The board draws none. Cost: two "?" more than drawn.
28. **Four new tokens** (`--dash`, `--to-amiga-bg`, `--from-amiga-bg`, `--from-amiga-fg`) for the board's literals;
    the board's fail text `#9A2A1C` and fail dot `#D2503A` become `--danger-fg` (6.03 on the surface, no new red).
    The other `#C4B9A2` literals (collection rail, devices empty outline, drive box placeholder) are left for their
    areas. Cost: a slightly brighter red than drawn.
29. **Drag-over is pointer feedback** (ink border, `surface-2` fill), not a state that needs words; the card's words
    stay. `data-over` exposes it to tests. Cost: none.
30. **Phone: the drop cards stay full stacked cards** at 390 px (`mobile.spec.ts:836` pins "stacked"); InfPhone's two
    96 px tile buttons and its action-less staging cards are area 7's call. Cost: a long phone page until then.
31. **`ingest/loading.tsx` gives the page its own skeleton** (`upload-skeleton`), nested like the library's and the
    devices', so a slow first render shows the two cards and the list instead of the generic bones. Cost: one more
    skeleton to keep in step with the page.
32. **A new `docs/screenshots/upload.png`**, taken right after the screenshot run's demo ingest (the list holds its
    done rows); only that PNG is committed. Cost: one more picture to regenerate.
33. **No migration, no new route, no new package.** Nothing in this area needs one. Cost: none.
