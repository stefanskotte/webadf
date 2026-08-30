# Plan 3b rulings — device UI

Decisions taken during implementation, preserved here because the SDD ledger lives in
gitignored `.superpowers/` and does not survive the session. Same purpose as
`2026-08-29-device-plane-rulings.md`.

**Pattern across this plan, worth knowing before writing the next one:** every defect found
was in plan text, not in implementer work on correct instructions. Three of my own fix
instructions were wrong and were caught by implementers who said so instead of complying.

## Pre-flight

- **PF-2.** `listDevices` aliased and joined `disks` twice while selecting nothing from either.
  Removed; the game titles come from joining `games` directly on the ids `devices` already
  carries.
- **PF-3.** `PageProps<'/games/[id]'>` is ambient and generated from the routes that *exist*,
  so it cannot resolve until the page file is created and Next regenerates. Noted in the plan
  so nobody "fixes" it by importing `PageProps`, which is wrong in this repo.

## During implementation

- **T1-1.** `deviceState` correctly returns `pending` for an eject in progress, but the card's
  heading was unconditionally "Mounting…". Same state, opposite words. Fixed before the card
  was built.
- **T2-1 (live).** The production database holds **three devices whose `desired_game_id`
  belongs to another organization** — leftover e2e data; the column has no foreign key. Both a
  reviewer and I confirmed that dropping the org-scoped join in `listDevices` leaks a real
  foreign title. **That predicate is preventing an active leak, not a theoretical one.**
- **T2-2.** Neither a swapped desired/mounted title nor removal of that predicate would have
  been caught by any planned test. Behaviours added for both.
- **T34-1.** Spec §5 requires the pairing code be shown "with its expiry"; the implementation
  discarded the `expiresAt` the endpoint returns. Ten-minute TTL, so someone reading the code
  eleven minutes later saw an identical interface. Same class of error the parent spec forbids
  for device state. Now a live countdown that removes the code at zero.
- **T34-4.** No behaviour touched the pairing flow at all, so that fix shipped untested. Covered
  via Playwright's `page.clock`, which makes a ten-minute TTL reachable.
- **T5-1 / T5-2.** The "N online" count and `stale`-keeps-polling were both replaceable with the
  suite still green. `stale` keeping the poll alive is deliberate: a stale device is unresolved,
  and stopping would mean someone who power-cycles it never sees the page reconcile.
- **T6-2.** `getGameDetail`'s org scoping on the disk query was unverified — no helper creates a
  disk whose `org_id` diverges from its game's. A test now seeds exactly that.
- **T6-3.** The holder map shows only the first device by name when two hold the same disk
  content. Ruled **against** building multi-holder display (scope creep); documented instead.

## T6-5 — the ruling most likely to be questioned later

Spec §4 originally said the multi-device mount action was a **dropdown**, and the user approved
that wording. It was built, and measurement showed a wrong-target bug: with two disk rows, the
open popup covered the next row's Mount button and `elementFromPoint` there resolved to the
*first* row's menu item — clicking what looked like disk 2's Mount silently mounted disk 1.

**`modal={true}` does not fix it.** `MenuPositioner`'s `z-50` is unconditional, so the popup
outranks the row beneath regardless; the backdrop only shields plain background content, which
is why outside-click works while the wrong-target bug survives. Nor does placement: `bottom`
covers the row below, `top` the row above, horizontal is fragile at narrow widths. **Any overlay
anchored to a row in a tight list overlaps something.**

Replaced with an **inline expansion** — the row grows, rows below are pushed down — which makes
the overlap structurally impossible rather than guarded against. A `boundingBox()` assertion now
states the geometric property directly. Spec §4 carries the reasoning.

Two process notes from this episode, both reusable:

- A test passing **in isolation** but failing in the full file was floating-ui not yet having
  settled into the overlapping position. Isolation passes are not proof for anything positional.
- A **stale `.next` cache** made a client-component mutation appear to pass. `rm -rf .next`
  before mutation-proving any client component, or the proof is worthless.
