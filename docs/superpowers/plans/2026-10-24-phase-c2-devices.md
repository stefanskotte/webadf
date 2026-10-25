# Phase C2 Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** The Devices page takes the approved ModernDevicesV2 layout — one wide card per board with the drive
picture and its live OLED, the DF0 drive box, the DF1 modes, the Network checklist and the Transfer box — plus the
Board settings and Board display modals, with every existing behaviour kept.

**Architecture:** Presentation and wiring on Phase B's tokens and C1's pieces. Pure look rules in a new
`src/lib/devices-look.ts` (plus small additions to `library-look.ts`, `second-drive.ts`, `network-checklist.ts` and a
new `display-elements.ts`); a shared `src/components/ui/modal.tsx` on Base UI Dialog; new card parts
(`drive-art.tsx`, `drive-glass.tsx`, `drive-box.tsx`, `transfer-box.tsx`, `board-settings.tsx`, `pairing.tsx`) in
`src/components/devices/`. One query gains two fields (`mountedGameId`, `desiredGameId` from the org-scoped joins).
No schema, no migration, no new route; every request keeps its route and body.

**Tech Stack:** Next.js 16.3.2 App Router (read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`
before Task 7's `loading.tsx`), Base UI 1.7 (read `node_modules/@base-ui/react/docs/react/components/dialog.md` before
Task 1's `Modal`), Tailwind v4, drizzle-orm/Postgres, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-phase-c2-devices-design.md`

## Global Constraints

- Texts, test ids and orders exactly as the spec writes them; every id in spec §11.1 must still resolve, once per
  card (or once per page for page-level ids); ids move only as spec §11.4 says.
- Colours only through tokens (Phase B §4, C1's five, this spec's `--fw-line` and `--modal-foot`) or the look
  modules; no `#7A7262`/`#A39B8B` text (Phase B ruling 4: `--muted-2`). The drive art and the OLED frame are the only
  literal-colour drawings (pictures of hardware).
- "Show both values of a state": no state is expressed by an element's absence; never put `w-full` (or any width or
  layout utility) on an `sr-only` element.
- Requests unchanged: boot-disk, second-drive, display, eject, eject DF1, mount, next, write-protect, alias, pair,
  firmware-update POST/DELETE, device DELETE keep their routes and bodies. `mountedGameId` / `desiredGameId` come
  from the org-scoped `mountedGame` / `desiredGame` aliases only, never from `devices.*GameId`.
- Self-host parity: no new package, no external URL, no font, no our-deployment-only path.
- Firmware, `wifi-floppy/`, the board and the Amiga are not touched.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): real `pnpm install --offline`, `.env.local` (never
  print it), `npx next typegen`, the `adf-archive` symlink.
- House rules, every task: stage files by name (never `git add -A`, never anything under `wifi-floppy/`), no `git
  stash` in any form; stop only your own PIDs, never pattern-kill; e2e with `PORT=3100`, ONE run at a time, each
  command under 9 minutes (split long specs with `-g`), in the foreground; the e2e DB is the live production DB shared
  with other runs, so assert relative to rows you seeded (run tags, seeded boards), never absolute counts; no commit
  after a red run; commit trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`.
- **Known pre-existing e2e failures** (leave them, report their result, do not chase): `time-machine.spec.ts:212` and
  `:268` (not this area; not run here), `display-layout.spec.ts:287` (in a touched spec: run it, record pass/fail, and
  investigate only if its failure CHANGES — a new assertion or line fails). `mobile.spec.ts:133` is the exception:
  this area owns it and Task 2 rewrites it (spec Ruling 2), so it must pass from Task 2 on.

## Review Focus

1. Every spec §11.1 id exists exactly once per card/page (`device-last-seen-<id>` only while offline; one `device-protection-<id>` in every state); moved ids only per §11.4.
2. Both modals: Cancel, X, Escape and the backdrop send nothing; dismissal is blocked while a request runs; focus returns to the opener; closing the display modal discards unsaved edits.
3. Every state is shown in words in both values (protection `—`, Transfer running / not running, NFC unknown, Network note, Disk at startup unknown), and no `sr-only` element carries a width utility.
4. The same requests as today (routes and bodies), and `mountedGameId`/`desiredGameId` only from the org-scoped joins (`devices-page` "another organization's game" still shows nothing of it).
5. e2e assertions stay relative to seeded rows on the shared production DB; runs are serialised, on PORT=3100, each under 9 minutes.

## Common commands

- Unit: `pnpm test <path>`; db: `pnpm test:db <path>`; types: `npx tsc --noEmit`; lint: `pnpm lint`.
- e2e desktop: `PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<title part>"]`.
- e2e mobile: `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "<title part>"`.
- Screenshots: `PORT=3100 pnpm screenshots` (own config, own demo account; Task 7 only).
- The `-g` patterns below are starting points, not verified titles: before running, check with
  `npx playwright test e2e/<name>.spec.ts --list -g "<pattern>"` that the pattern selects what the task needs, and
  that a file split into several runs is covered whole.

---

### Task 1: Look rules, tokens, data and the shared Modal (no visible change)

**Files:** new `src/lib/devices-look.ts` + `devices-look.test.ts` — `firmwareCellText(s)` (spec §2.2),
`driveBoxText(device, state)` → `{ label, labelTone: 'muted-2' | 'muted' | 'amber', title, meta }` (spec §4.2 table;
the words are moved from `device-card.tsx`'s `heading`/`bigText`/`subText`, which then call it), `statusPill(online)`
→ `{ label, bg, fg, dot, halo }` (§2.1), `signalCell(rssi, online)` → `{ lit: 0..3, text }` via `rssiBars` (§2.1);
new `src/lib/display-elements.ts` + test — `ELEMENT_LOOK: Record<ElementName, { label; hint }>` (spec §10.3 words);
`src/lib/library-look.ts` + its test — `driveDiskColor(gameId)` (§4.3); `src/lib/second-drive.ts` + test —
`secondDriveHelp(shown, hasPick)` (§5.1, the four sentences moved out of `second-drive-setting.tsx`, which then calls
it); `src/lib/network-checklist.ts` + test — `splitCheckLine(text)` (§6); `src/app/globals.css` — `--fw-line:
#F1D3A4`, `--modal-foot: #FBF8F1` (webadf `:root`, a comment line each), `.seg--sm` and `[aria-checked="true"]` on
the `.seg-item` active rule (§5.1); `src/lib/design-tokens.test.ts` — the spec §12 pairs that involve tokens;
`src/lib/queries.ts` — `DeviceListItem.mountedGameId` (`mountedGame.id`) and `desiredGameId` (`desiredGame.id`);
`src/app/(app)/devices/page.tsx` — `transferById: Record<string, { running: boolean }>` beside `sendLineById` (spec §7),
passed through `DeviceList` to `DeviceCard` (unused until Task 3); new `src/components/ui/modal.tsx` (spec §10.1:
`Modal` with `open`, `onOpenChange`, `title`, `subtitle?`, `badge?`, `footer`, `width: 620 | 940`, `testId`,
`dismissible`, `closeTestId`, `finalFocus?`, children), not yet used.
**Interfaces:** `driveBoxText(d: DeviceListItem, s: DeviceState)`; `driveDiskColor(id: string | null): DiskColor`;
`secondDriveHelp(shown: 'off' | 'df1' | 'any' | 'net', hasPick: boolean): string`; `splitCheckLine(t: string): {
label: string | null; detail: string }`.
**Tests first:** `devices-look.test.ts` — every state row of spec §4.2 (incl. the `0 of` count rule and "currently
holding"), `firmwareCellText` on `fw 1.21.0 · up to date`, `fw unknown`, an update label; `signalCell` at
-44/-65/-75/-90/null/offline; `display-elements.test.ts` — every `ELEMENT_NAMES` entry has a label and hint;
`driveDiskColor` stable, null → cream, in the four colours; `secondDriveHelp` four modes × pick (byte-identical to
today's strings); `splitCheckLine` on the three checklist lines and a line without `": "`; design-tokens pairs ≥ 4.5.
Regression e2e (desktop): `devices-page -g "four device states|desired title|another organization|pending eject"`,
`second-drive -g "Any disk|setting reads"`.
Run: unit; tsc; lint; the two e2e runs, one at a time.

### Task 2: Page shell, card head and facts, firmware banner, pairing, offline strip

**Files:** `src/app/(app)/devices/page.tsx` (`PageHeader size="lg"`, `PairingProvider` around header + list, the
actions per spec §1, `FirmwareNotice` moves into `DeviceList`, the empty card moves into `DeviceList` as a
placeholder kept with today's words until Task 7); new `src/components/devices/pairing.tsx` (`PairingProvider`,
`usePairing`, `PairAnotherButton` `pair-another`); `pair-button.tsx` (state from the context; look spec §1.2);
`device-list.tsx` (grid rules spec §1, the `pair-another-card` aside for exactly one board, banner + its
`firmware-notice-update` opening `update-dialog` with the one board ticked, update bar/dialog restyle spec §1.3);
`firmware-notice.tsx` (spec §1.3 look and words, `onUpdateOne?`/`oneName?` props); `device-card.tsx` (the `article`
shell spec §2, top-row slot, info column spec §2.1 — heading row without the Board settings button yet, status pill,
`dl` with `device-seen-<id>`, `device-signal-<id>`, `device-firmware-<id>` + spec §2.2 extras — and the offline
strip spec §9.3; the lower half keeps today's bezel, words, DF1, Disk at startup, NFC and delete components in place
until Tasks 3–6 replace them); `device-alias.tsx` (spec §2.1: `h2`, pencil icon, `sr-only` word, input sizes);
`e2e/devices-page.spec.ts` (`:285` rewritten per spec §11.4, using a full-width check instead of the drawer part,
which Task 6 adds back as the modal); `e2e/mobile.spec.ts:133` rewritten (spec Ruling 2); `src/lib/help/topics.tsx`
(`boards`: firmware paragraph names the banner's `Update <name>` for a single board).
**Tests first:** unit — `firmware-notice` render test (`renderToStaticMarkup`): the `Firmware … is available`
/ `Security update … is available` line and the `1 of 1 device is behind` part; the action only with `oneName`.
New desktop e2e in `devices-page.spec.ts`: with one board, `pair-another` opens the header's `pair-name` form (one
form on the page) and with two boards `pair-another-card` is absent; with one updatable board,
`firmware-notice-update` reads `Update <name>` and opens `update-dialog` listing that board; an offline board shows
`device-offline-<id>` with `<name> is offline` and an online one does not.
Specs: `devices-page -g "heading|empty-state|subtitle|online count|badge|pairing|Cancel closes|phone|custom server|org B"`,
`devices-page -g "three paired|pair-another|firmware-notice|offline strip"`, `device-alias`, `pairing`,
`devices-firmware`, `firmware-update-loop`, `drive-chips -g "devices#|link"`, `help -g "help button opens|keyboard"`.
Mobile: `mobile.spec.ts -g "Devices|write-next-card"`.
Run: unit; tsc; lint; the e2e list, one at a time.

### Task 3: Drive tile and DF0 drive box (and the standalone Transfer box)

**Files:** new `src/components/devices/drive-art.tsx` (spec §3: the board's SVG, `useId` gradients, LED colour,
disk sliver, `tall` for 128×64, `role="img"` + `aria-label`); new `drive-glass.tsx` (the wasm screen moved from
`drive-bezel.tsx`: tick, `stripRotation`, paint; the `device-oled-<id>` button placed in percentages, hover ring off
under reduced motion); delete `drive-bezel.tsx` once unused; `drive-front.tsx` (the tile `device-bezel-<id>`: art,
glass, caption, `display-toggle-<id>` `Change display` + `display` help tip; it still opens today's drawer below the
tile until Task 6); new `drive-box.tsx` (spec §4: `device-disk-<id>` always visible, `DiskIcon` /
placeholder, `driveBoxText`, `device-disk-title-<id>` link, preload line, the protection switch
`device-protection-<id>` wired to `requestWriteProtect`, `next-disk-<id>`, `device-change-disk-<id>`, `eject-<id>`
with `requestEject`, `reinsert-<id>`, `device-open-library-<id>`); `reinsert-button.tsx`, `next-disk-button.tsx`
(look only); new `transfer-box.tsx` (spec §7, used here standalone under the drive box); `device-card.tsx` (wires
tile, drive box, `device-error-<id>` and `device-last-boot-<id>` strips spec §4.5, the standalone Transfer box;
deletes the old words block, the protection tag and the old send/upload lines); `src/lib/help/topics.tsx`
(`display` first paragraph: "Press Change display under the drive, or its screen"); `e2e/devices-page.spec.ts:464`
rewritten (spec §11.4).
**Tests first:** unit — `drive-art.test.ts` (`renderToStaticMarkup`): viewBox `0 0 304 132` vs `0 0 304 153` for
`tall`, the `aria-label` in both values, two renders have different gradient ids; `drive-box` texts are covered by
Task 1's `driveBoxText` test. New desktop e2e in `devices-page.spec.ts`: on a converged board with a writable disk,
`device-protection-<id>` reads `Writable`, a click turns it `Protected` and the disk row's `writeProtected` is true;
`device-disk-title-<id>` links to `/games/<gameId>`; on an empty board `device-protection-<id>` is disabled with `—`
and `device-open-library-<id>` goes to `/library`.
Specs: `devices-page -g "four device states|stale card|last_error|eject|desired title|another organization|pending eject"`,
`devices-page -g "write-protect|bezel|upright|protection switch|disk title"`, `reinsert`, `next-disk -g "device card|preload"`,
`live-state`, `write-protect-live`, `send-to-amiga -g "card|Devices|device"`, `from-amiga -g "Devices|card"`,
`drive-chips -g "eject|link"`. Mobile: `mobile.spec.ts -g "Devices"`.
Run: unit; tsc; lint; the e2e list, one at a time.

### Task 4: DF1 box, Network checklist, Transfer in Network

**Files:** `src/components/devices/second-drive-setting.tsx` (spec §5: the `device-df1-<id>` box, header row, the
readings line folding `second-drive-readings.tsx` into it (delete that file once unused), the `second-drive-<id>`
radiogroup of four `seg-item` radios in board order with roving arrow keys, `second-drive-net-note-<id>`, the DF1
contents row with `eject-df1-<id>`, error/refused/override unchanged); `network-checklist.tsx` and
`driver-line.tsx` (spec §6: `ul`/`li`, round marks, `splitCheckLine`, `network` help tip; texts unchanged);
`transfer-box.tsx` placed in the Network panel when the board reports Network (`device-card.tsx` then skips the
standalone one); `e2e/device-helpers.ts` (`pickSecondDrive(page, id, mode)`); `e2e/second-drive.spec.ts` (every site
in spec §11.4); `src/lib/help/topics.tsx` (`second-drive` / `network`: the four choices named as the radios read).
**Tests first:** unit — `second-drive-setting` render test of the radiogroup (`renderToStaticMarkup` with a
capable board on `df1` + pick): `data-value="any"`, four radios in the board order with their texts, `aria-checked`
on `-any` only; with `secondDriveNetCapable=false` the `-net` radio is disabled and the note renders. New desktop e2e
in `second-drive.spec.ts`: focus on the checked radio, ArrowRight selects the next mode and saves it (row's
`secondDrive` changes), and a Network board shows `device-transfer-<id>` inside `device-df1-<id>`.
Specs: `second-drive -g "without DF1|switching DF1|seen DF1|failed save|help tip|Network needs|firmware guard|choosing Network|checklist"`,
`second-drive -g "setting reads|mounted into DF1|mounting into DF0|deleting the disk|before 1.12.0|netPick|Any disk|arrow"`,
`help -g "caveats|lists every topic"`, `mount-to-device -g "DF1"`, `send-to-amiga`, `from-amiga`, `next-disk -g "preload"`.
Run: unit; tsc; lint; the e2e list, one at a time.

### Task 5: Board settings modal

**Files:** new `src/components/devices/board-settings.tsx` (spec §8 on `Modal`: header, Disk at startup radiogroup
with draft and Save, the fixed/unknown/error variants, NFC reader row or `device-nfc-unknown-<id>`, footer with
`device-delete-<id>`, `board-settings-cancel`, `board-settings-save`; toast and refresh on save); `boot-disk-setting.tsx`
(becomes the modal's controlled section: `value`, `onChange`, `error`; the PATCH moves to the modal's Save);
`delete-device-dialog.tsx` (split: `DeleteDeviceConfirm` controlled, opened from the modal; same words and ids,
portalled, `wf-modal`); `device-card.tsx` (`board-settings-<id>` button in the heading row with the attention dot
spec §2.1; removes the card's Disk at startup, NFC line and trash icon); `e2e/device-helpers.ts`
(`openBoardSettings(page, id)`); `e2e/devices-page.spec.ts:561`, `:584`, `:603`, `:651` and `e2e/device-delete.spec.ts:14`
(spec §11.4); `src/lib/help/topics.tsx` (`boards`: Disk at startup and Deleting a board name **Board settings**;
`nfc`: "No reader found?" names Board settings and the dot).
**Tests first:** unit — `board-settings` render test of the closed trigger and attention dot (present only when
`describeI2cScan(...).ok === false`). New desktop e2e in `devices-page.spec.ts`: in Board settings, `board-settings-save`
is disabled until a choice changes; Cancel and Escape close without any `/boot-disk` request (route spy) and focus
returns to `board-settings-<id>`; Save closes, toasts `Disk at startup saved. The board uses it at its next start.`
and the row's `bootDisk` is `empty`.
Specs: `devices-page -g "I2C|PN532|Disk at startup|previous start|Board settings"`, `device-delete`, `help -g "boards|nfc|keyboard"`,
`nfc-tap -g "reader state"`, `next-disk -g "Next-card write"`, `devices-page -g "badge|four device states"`. Mobile:
`mobile.spec.ts -g "Devices|write-next-card"`.
Run: unit; tsc; lint; the e2e list, one at a time.

### Task 6: Board display modal

**Files:** `src/components/devices/display-editor.tsx` (spec §10: the editor inside `Modal` width 940, header with
subtitle, `display-unsaved-<id>` pill, `display-status-<id>`, close; the two-column body; Preview as / Panel / scale
radiogroups with their item ids and `data-value`; Rotation select kept; `display-snap-<id>` switch; element rows with
`ELEMENT_LOOK` names and hints, hidden rows disabled at 45 %; `display-shown-count-<id>`; footer Reset / Cancel /
Save to board; Save keeps the modal open; the no-support variant; the `BEZEL_EDGE` drawer frame and its toggle
markup go); `drive-front.tsx` (opens the modal from `display-toggle-<id>` and `device-oled-<id>`; mounts the editor
only while open); `src/lib/help/topics.tsx` (`display`: element names as the list reads them — Track, NFC, Status;
the modal's Save to board); `e2e/devices-page.spec.ts:498` rewritten and `:285`'s modal half added back (spec §11.4);
`e2e/display-layout.spec.ts:50`, `:165`, `:189`; `e2e/screenshots.shots.ts` (Devices: wait `display-drawer-<id>`, no
`tall`).
**Tests first:** unit — `display-elements` is covered by Task 1; a `display-editor` render test is not possible
(wasm); so e2e first. New desktop e2e in `display-layout.spec.ts`: with an unsaved width change, Escape closes the
modal, no `/display` request is sent (route spy) and reopening shows the board's value; the modal stays open after
Save with `display-status-<id>` `Waiting for the board`; `display-shown-count-<id>` changes when an element is
unticked.
Specs: `display-layout -g "without display|saved from the editor|rejects|invalid layout|poll wakes|Cancel throws|Escape"`,
`display-layout -g "1.10.0|before 1.10.0|1.15.0|before 1.15.0|1.17.0|head element|before 1.17.0"` (`:287` is the
known pre-existing failure: record it), `devices-page -g "bezel|three paired|upright"`, `help -g "does not trigger"`.
Mobile: `mobile.spec.ts -g "Devices"`.
Run: tsc; lint; the e2e list, one at a time.

### Task 7: States, contrast, phone, the e2e regression and screenshots

**Files:** new `src/app/(app)/devices/loading.tsx` (`devices-skeleton`, spec §9.2) + `loading.test.ts` beside it;
`device-list.tsx` (the empty card spec §9.1: `devices-empty`, `data-empty="devices"`, outline drawing, words,
`pair-another`) + a render test `devices-empty.test.ts`; `e2e/contrast.spec.ts` (a Devices test on a seeded org with
one online board holding a disk, one offline board, and a Network board: every spec §12 pair measured on the real
elements — drive-box label, tile caption, offline strip heading and body, Online and Offline pills, a not-OK
checklist mark, the DF1 tile, a modal footer — each ≥ 4.5); `e2e/mobile.spec.ts` only if a Devices test needs a
selector update from Tasks 2–6.
**Tests first:** unit `devices/loading.test.ts` (skeleton shape: tile bone, heading bone, aside bone at `lg`,
`devices-skeleton`), `devices-empty.test.ts` (outline first, words and button in order, `data-empty`).
Specs: `devices-page -g "empty-state"`, `states`, `contrast`, `shell`, `button-affordance`. Mobile: `mobile.spec.ts`
in two `-g` runs covering every Devices and library test it holds (check with `--list`).
**Final regression**, every spec touched in Tasks 1–6, one run at a time, each under 9 minutes, split with `-g` and
checked with `--list` so each file is covered whole: `devices-page` (three runs), `second-drive` (two),
`display-layout` (two; `:287` recorded), `device-delete`, `device-alias`, `pairing`, `reinsert`, `next-disk`,
`devices-firmware`, `firmware-update-loop`, `send-to-amiga`, `from-amiga`, `live-state`, `write-protect-live`,
`nfc-tap`, `drive-chips`, `mount-to-device`, `help`, and `help.mobile.spec.ts --project=mobile`.
Then `PORT=3100 pnpm screenshots` and compare `docs/screenshots/devices.png` and `docs/screenshots/display-editor.png`
with ModernDevicesV2 and its display state by eye; commit only those two PNGs by name (the run regenerates the
others too: restore them with `git checkout -- docs/screenshots/<name>.png`, never with stash).
Run: unit; tsc; lint; the e2e list; screenshots.
