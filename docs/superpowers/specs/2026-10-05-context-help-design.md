# Context help: "?" popovers and a /help page

Status: approved in conversation on 2026-10-05, section by section. The written spec is awaiting the operator's review.

## 1. What this is for

The operator's backlog note (HANDOFF, 2026-09-28) is the starting point. Several controls mean little until you know what
they do; "Write a Next-disk card" on the Devices page is the example. The fix has two layers:

- a small **"?" beside the control**, opening a one-to-two sentence popover with a "More" link;
- a **/help page** with one section per feature, for the how and the why.

Done means:

- Each of the 8 topics below has a "?" at the places listed in §4.
- The popover opens by tap, click or keyboard, and it fits on a 390 px screen.
- "More" lands on the matching section of /help.
- Every statement in the help matches the shipped behaviour.

The readers are Amiga users, not developers.

## 2. Decisions

| Decision | By |
|---|---|
| Both layers: popovers for "what is this", /help for "how and why" | operator, recommended |
| The 8 topics in §3 | operator |
| One typed module is the single source for popovers and page (approach A, not MDX, not inline text) | operator, recommended |
| Plain tone, `short` ≤ 2 sentences, `body` ~80–200 words, no jargon without a one-clause gloss | operator |
| Help that cannot be confirmed against code/HANDOFF is left out, never guessed | this design |

## 3. Topics

Ids are fixed. Each is listed with what its `body` covers.

| Id | Title | Body covers |
|---|---|---|
| `boards` | Boards | Pairing; online/offline; firmware updates and their states (offered, downloading, trying the new version, confirmed, reverted), and that a new version that fails to start reverts by itself |
| `nfc` | NFC cards | Linking a sticker or fob to a disk; tapping it to mount; what the Next-disk card does |
| `next-disk` | Next disk and preloading | Moving through a multi-disk game; the preload line; why a swap waits for the drive light |
| `write-back` | Saves and the time machine | Amiga saves reach the server; the history; restore; why a restored disk gets a new date |
| `write-protect` | Write protection | RW and WP, like the tab on a real floppy; what the Amiga can and cannot do in each |
| `disk-sets` | Disk sets | Grouping disks without "disk N of M" (e.g. a Workbench install); Add disks; Reorder |
| `hd-hfe` | HD disks and HFE images | HD disks; what an HFE image is (a disk stored as its magnetic signal); long tracks and copy protection; Extract as ADF |
| `display` | The board's display | Panel type; placing elements; previewing; why the boot and connecting screens stay on the default layout |

## 4. Design

**`src/lib/help/topics.tsx`**
- A `const` object keyed by topic id. Each entry has:
  - `title: string`;
  - `short: string` (plain text, at most 2 sentences);
  - `body: ReactNode` (paragraphs and short lists; an optional "Good to know" list; no images).
- `type HelpTopicId = keyof typeof HELP_TOPICS`, so a misspelt id is a type error.
- An ordered list of ids drives the /help table of contents.

**`src/components/help/help-tip.tsx`** (client component)
- Props: `{ topic: HelpTopicId }`.
- Renders a small round "?" button: a lucide icon, the existing style tokens, and `aria-label="About <title>"`.
- The button opens a base-ui `Popover`, the same primitive `create-adf.tsx` uses. The popover holds:
  - the title;
  - the `short`;
  - a "More about <title> →" link to `/help#<id>`.
- Opens by tap, click and keyboard. Closes with Esc or a tap outside.
- Stays inside the viewport at 390 px.
- `data-testid`s: `help-tip-<id>` (button), `help-pop-<id>` (popover), `help-more-<id>` (link). On a page with
  repeated tips (one per device card), the test uses the first.

**`/help`** (`src/app/(app)/help/page.tsx`, signed-in like the rest of the app)
- A one-paragraph intro.
- A table of contents.
- One `<section id="<id>">` per topic, holding its title and `body`.

**Navigation:** a "Help" item at the end of `top-nav.tsx`'s ITEMS.

**Placement** (one "?" per feature per page; in tight rows the "?" goes on the heading or label, not in the row):

| Topic | Next to |
|---|---|
| `boards` | the Devices page heading; the firmware update state on each device card |
| `nfc` | the NFC fob button (`nfc/fob-button.tsx`); "Write a Next-disk card" (`devices/next-disk-button.tsx`) |
| `next-disk` | the preload line on the device card and in the drive chips |
| `write-back` | the History panel heading (`disks/history-panel.tsx`) |
| `write-protect` | the WP/RW toggle (`games/write-protect-toggle.tsx`) |
| `disk-sets` | the Disk set section heading (`games/disk-set-section.tsx`) |
| `hd-hfe` | Extract as ADF (`games/extract-action.tsx`) |
| `display` | the Display section toggle (`devices/display-editor.tsx`) |

## 5. Content rules

- Plain words. A technical term that cannot be avoided (HFE, Copylock) is explained in one clause. Internal words never
  appear: PSRAM, TBYB, poll, sha256, cursor.
- `short` answers "what is this?" in at most 2 sentences. `body` answers "how do I use it, and why does it behave like
  this?".
- **Accuracy:** each topic is written against its source (code and HANDOFF), and the plan names the source per topic.
  A claim that cannot be confirmed is left out.
- Voice, from the approved samples:
  - `nfc`: "Stick an NFC sticker or fob on a real floppy case, link it to a disk here, and tapping it on the board
    mounts that disk. A Next-disk card instead tells the board to move to the next disk of a multi-disk game."
  - `write-protect`: "RW lets the Amiga save to this disk, and the changes are sent back here. WP makes the disk
    read-only for the Amiga, like sliding the tab on a real floppy."

## 6. Testing

- **Unit (vitest):** every topic has a non-empty title, a non-empty body, and a `short` of 1–2 sentences; the
  table-of-contents order lists every id exactly once.
- **Type check:** every `<HelpTip topic>` in the app is a valid id.
- **e2e:** on /devices, open the boards "?" at desktop and at 390 px. The popover is visible inside the viewport, and
  "More" navigates to /help with `#boards` in view. /help lists all 8 sections.
- The full e2e suite runs before merging.

## 7. Out of scope

- Search inside help.
- Images or screenshots.
- Translations.
- Help for admin pages.
- First-run tours or onboarding.
