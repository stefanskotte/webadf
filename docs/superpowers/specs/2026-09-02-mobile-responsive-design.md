# Mobile responsive design — spec

**Written 2026-09-02.** Requested by the operator: "spec and implement a suitable mobile
responsive design — free reign to omit/modify/simplify elements, but maintain the same
functionality as the desktop version."

## 1. What this is for

Today the app *renders* on a phone and is unusable on one. The whole UI is written at one
width: **four responsive utilities exist in our own code** (`admin/page.tsx:27`,
`admin/scan/page.tsx:54,70`, `game-facts.tsx:47`); everything else in `src/components/` is
fixed. This increment makes every existing function reachable at 390px without removing any
of them.

The `viewport` meta is NOT the problem — Next emits `width=device-width, initial-scale=1` and
nothing overrides it.

## 2. Scope

**In:** the two shells' headers, `/library` (rail, grid, table), `/games/[id]`,
`/disks/[id]/files`, `/devices`, `/ingest`, the four `/admin` pages, and touch drag.

**Out:** a native app, gestures beyond drag, offline, and any change to what the pages *do*.
No route, no API and no data shape changes in this increment.

## 3. The constraint that shapes everything

**Every e2e spec runs at Playwright's default 1280×720 — `playwright.config.ts` sets no
viewport.** So:

- **Desktop rules must stay byte-identical.** Every mobile rule is written as the unprefixed
  base with a `sm:`/`md:` override restoring today's desktop value, never the reverse. A
  regression at 1280 means the change was written backwards.
- **Mobile is currently untested by anything.** This increment therefore adds a second
  Playwright project pinned to 390×844, running a small mobile-only spec. Without it, every
  claim in this document is unverified for the width it is about.

## 4. Decisions

- **D-6-1. One nav element, never two.** `shell.spec.ts` and `admin-guard.spec.ts` locate nav
  links by role and name; a second, mobile copy makes those locators strict-mode-ambiguous and
  fails the suite at 1280. The nav is rendered once and *moved* with CSS.
- **D-6-2. On mobile the nav becomes a fixed bottom bar.** It is the one element that must be
  reachable from every page, it is currently absolutely centred (which at 390px lands it on top
  of the wordmark and the search box, with clicks going to whichever paints last), and the
  bottom edge is where a thumb is. Same component, same links, same `aria-current`; position
  only.
- **D-6-3. The file tree row goes to two lines, and does NOT scroll horizontally.** Its fixed
  columns total ~312px inside a 310px card, so the name column is negative at depth 0 and
  worse at every nesting level. Horizontal scroll would push Download off-screen, which is the
  row's only action. Line 1 is the name; line 2 is `size · protection · date` plus Download.
- **D-6-4. The directory toggle stays the only `<button>` in a row.** `adf-browser.spec.ts:75`
  does `.getByRole('button')` scoped to a row; any second button breaks it. The download
  affordance stays an `<a>`.
- **D-6-5. Wide tables scroll, and are given a real minimum.** The admin tables are already in
  `overflow-x-auto` cards but are `w-full`, so they compress to 390px and crush their cells
  instead of scrolling. They get `min-w-[640px]`, which makes the existing scroll real.
  `game-table` is inside `overflow-hidden` and is genuinely clipped today — it gets the
  wrapper it never had.
- **D-6-6. `PointerSensor` is REPLACED by `MouseSensor`, not supplemented.** `PointerSensor`
  keys on `onPointerDown` with no `pointerType` check, so adding a `TouchSensor` beside it
  double-activates on touch. Mouse keeps `{ distance: 8 }`; touch gets
  `{ delay: 250, tolerance: 8 }` — press-and-hold to drag, move-immediately to scroll.
  `tolerance` is required on dnd-kit's delay form, not optional.
- **D-6-7. The existing drag e2e must keep passing unchanged.** `collections.spec.ts` drives
  `page.mouse`, which emits `pointerType: "mouse"` and satisfies `MouseSensor`; `TouchSensor`
  is inert for it. **A delay on the mouse path would break it** — the test moves immediately
  without holding. The delay goes on touch only.
- **D-6-8. Breakpoint is `sm` (640px) for content, `md` (768px) for the library's two-column
  split.** The rail plus grid needs more than 640px to be worth keeping side by side.
- **D-6-9. The page gutter becomes `px-4 sm:px-7`.** `px-7` costs 56 of 390px — 14% of the
  screen — and appears in 11 places.

## 5. Per-surface treatment

| Surface | Breaks at 390px | Treatment |
|---|---|---|
| Both headers | nav pill (~330–400px) painted over wordmark + search | nav to fixed bottom bar; header keeps wordmark + search + actions on one wrapped row |
| `SearchBox` | `w-48` fixed; panel `w-80` | `w-full sm:w-48`; panel `w-[min(20rem,calc(100vw-2rem))]` |
| `PageHeader` | `flex items-end justify-between`, `text-[34px]` | `flex-col items-start gap-3 sm:flex-row`, `text-[26px] sm:text-[34px]` |
| `/library` | rail `w-56 shrink-0` + `ml-7` leaves ~66px of grid | `flex-col md:flex-row`; rail full-width above the grid |
| `GameGrid` | `grid-cols-5` → ~60px cards | `grid-cols-2 sm:grid-cols-3 md:grid-cols-5` |
| `GameTable` | ~590px of fixed tracks inside `overflow-hidden` — clipped, unreachable | `overflow-x-auto` wrapper + `min-w-[600px]` rows |
| `/games/[id]` disk row | 5 controls on one line leave <60px for the name | `flex-col gap-3 sm:flex-row`; controls to a wrapped second row |
| `/disks/[id]/files` | name column is NEGATIVE at depth 0 | two-line row per D-6-3 |
| `/ingest` | `grid-cols-[1fr_90px_100px_90px_120px]` = 400px fixed, in `overflow-hidden` | stack to a card per row below `sm`; stat tiles `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` |
| `/devices` | header collision only | PageHeader treatment |
| `/admin` tables | `w-full` crushes cells; Delete scrolls out of view | `min-w-[640px]` per D-6-5; hide the email below `sm` |

## 6. What this does not defend against

- **A real device.** Everything here is verified in Chromium at 390×844 with touch emulation.
  Emulated touch is not a finger, and `hover:` states have no analogue on a phone.
- **Landscape phones and tablets** are not separately designed; they fall between the `sm` and
  `md` rules.
- **The drag delay is a guess at 250ms.** It is the conventional value, not a measured one.

## 7. Testing

- A `mobile` Playwright project at 390×844 with `hasTouch: true`, running `e2e/mobile.spec.ts`:
  the nav reaches every route from the bottom bar; the library grid shows two columns; a file
  tree row shows its name AND its Download control; the game table is reachable by scrolling;
  a touch drag on the library grid **scrolls** rather than picking a card up, and a
  press-and-hold **drags**.
- The existing suite must stay green at 1280 **unchanged** — no spec edited to accommodate a
  mobile rule. Editing one is the signal that a rule was written backwards.
