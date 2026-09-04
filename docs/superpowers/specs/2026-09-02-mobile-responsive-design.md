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
- **D-6-4. The directory toggle stays the only `<button>` in a row.** **Superseded by task 11
  (2026-09-04) — a row can now hold more than one button, so the toggle is targeted by its own
  testid instead.** `adf-browser.spec.ts:75` does `.getByRole('button')` scoped to a row; any
  second button breaks it. The download affordance stays an `<a>`.
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

---

## 8. What this increment delivered, and where this spec was wrong

**Delivered 2026-09-02 on `feat/mobile-responsive`.** Implemented by four agents working
concurrently over disjoint files; every correction below came from one of them pushing back
on this document rather than following it.

### Corrections to §4 and §5

- **§5's `/library` row was incomplete.** It said `flex-col md:flex-row`. `items-start` has to
  move under `md:` as well: on a column it governs the HORIZONTAL axis, so left unprefixed it
  shrink-wraps the rail and the grid to their content width instead of filling the screen.
- **D-6-5's prose was looser than its own table row.** A scroll wrapper alone does not fix
  `game-table`: the `min-w` has to be on the ROWS, or the `1fr` title track absorbs the
  shortfall and the container never overflows, so the scroll never engages.
- **"Hide the admin email below `sm`" was wrong and was not done.** The users table's email is
  what the delete gate requires you to type to confirm; hiding it is a functional regression.
  D-6-5's minimum width is the whole treatment.
- **One blanket `min-w-[640px]` was wrong for the users table.** Seven columns need ~708px, so
  it got 720; invites and scan kept 640. Sized per table, not per spec.
- **§5 said `/devices` breaks by "header collision only".** The device card's mono
  MAC/firmware/RSSI line also overflows its card: a flex item will not shrink below its
  content, so the CARD grew instead of the line wrapping. Fixed with `min-w-0` + `break-words`,
  and the same applies to `volume-header` and `game-facts` — Amiga volume names have no spaces
  to break at.
- **§6 called the 250ms delay "a guess".** It is dnd-kit's own current default for touch, so it
  is conventional in a stronger sense than this document claimed.

### The nav bar's colour is not a glass token, deliberately

The implementation brief asked for "a translucent backdrop consistent with the app's glass
tokens". That would have been unreadable. The `--glass-*` tokens are WHITE surfaces meant for
dark text; the nav pill's labels are the light `--on-dark` ramp, tuned against the gradient's
dark TOP band. The bar is fixed to the BOTTOM of the viewport, where the fixed gradient has
run down to `--grad-bot` (#eef1f2) — white glass there leaves the labels at roughly 1.5:1.
Two new tokens, `--nav-scrim` (`--grad-top` at 0.90) and `--nav-scrim-hairline`, carry the
dark band down with the bar so the pill's existing colours keep the ratio they were designed
for.

### `touch-action` is on the grip and NOT on the cards, and the asymmetry is the point

`AbstractPointerSensor.handleMove` suppresses scrolling only via
`if (event.cancelable) event.preventDefault()`. Once a browser has committed a gesture to a
scroll its `touchmove` stops being cancelable, so a rail reorder would drag while the page
scrolled out from under it — `touch-action: none` on the rail grip is what guarantees the
first post-hold move is still cancelable. Its cost is that a swipe beginning exactly on the
20×24px grip scrolls nothing, which is why the drag activators live on the grip alone.

The grid cards get NO `touch-action`, for the same reason inverted: their listeners cover the
whole card, so `none` there would kill scrolling of the entire library. The 250ms/8px hold is
what separates the two gestures instead.

### `sm:contents` is how desktop stayed byte-identical

The mobile-only groupings (the file tree's second line, the disk row's control cluster) are
wrapped in a div that is `sm:contents` — at desktop widths the wrapper generates NO BOX, so
the original row lays out exactly as it did before rather than being re-derived from new
rules. This is why the 1280 suite needed no edits.

### Verification

- **177 Playwright tests: 172 desktop at 1280×720, 5 mobile at 390×844 with touch.** No
  existing spec was edited — which was the stated signal that a rule had been written
  backwards, and it never fired.
- **The touch test was mutation-proven.** Reverting the touch path to a distance-only
  constraint makes the card's opacity go to 0.4 — it picks the card up instead of scrolling,
  exactly the failure the backlog predicted — and the test fails on it.
- **Not verified: a real phone.** Everything above is Chromium at 390×844 with emulated touch.
  Emulated touch is not a finger, `hover:` has no analogue on a phone, and no physical device
  has loaded this build.
