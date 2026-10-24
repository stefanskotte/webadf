# WebFloppy redesign — roadmap

Status: approved by the operator 2026-10-23 ("this is fine, save the plan"). Start: when the operator says go.

The approved design is the Modern page of the canvas https://claude.ai/artifact/66QQLv1VK4Ye2gBNaV4F6S ("WebFloppy —
redesign"), fully reviewed 2026-10-22 (HANDOFF 3ce). The product is renamed **WebFloppy** with this build.

## Decisions

- **Features first, then design** (operator 2026-10-23). The features the design shows but the app lacks are built in
  today's look first; the new design is then applied on top and wired to them.
- **Area by area, live as each lands.** No long-lived redesign branch and no per-user "new design" switch: each
  project is merged to master (production) when its e2e specs for the touched areas pass.
- **Search inside disks is deferred** (operator): it needs a real file indexer (about a week). Backlog.
- **NFC "Scan again" is dropped** (operator 2026-10-23): the board reads the I2C bus at every start; the status line
  is enough. Removed from the Devices v2 board on the canvas.

## Phase A — missing features, in today's look

Found by comparing every approved board with the app (2026-10-23). Each item ships on its own.

| # | Area | Features | Size | Process |
|---|---|---|---|---|
| A1 | States | `error.tsx` / `not-found.tsx` / `global-error.tsx` with "Try again" and a reference id; `loading.tsx` skeletons instead of blank pages | S–M | short design in chat |
| A2 | Settings / account | change password (better-auth); session count + "Sign out everywhere else"; delete my own account (reuse `lib/admin-delete.ts`, reset the org's boards); Preferences save as you change ("All changes saved") | S, S, M, S | short design in chat |
| A3 | Library | "Move to collection…" action (API exists: `api/collections/[id]/games`); Undo in the mount toast (cancel exists in `card-mount-button.tsx`); header search also finds Help topics (client-side, `lib/help/topics.tsx`) and shows a title's collection | S each | short design in chat |
| A4 | Devices | "Re-insert last disk" on an empty drive (store the last ejected disk; eject clears `mounted_*` today); "Any disk" shown as a read-only DF1 choice (today `df1` covers next-of-set and any) | S–M | short design in chat |
| A5 | Disk files | filter by name; hide `.info` icons; multi-select with bulk Download / Move / Delete; edit protection bits on existing entries (PATCH route today does rename/replace/move only); "new in vN" badge on rows; Undo after a drop-add | S–M each | short design in chat |
| A6 | Upload | ONE staging list for to-library / to-Amiga / from-Amiga (today three cards: Dropzone, SendPanel, FromAmigaCard), with filters, counts, "Clear finished", and "Open title" after an ingest | M | **full spec** |
| A7 | Admin | Overview: boards online / paired, boards by firmware (7 days), "Needs attention"; Invites: copy code / sign-up link, "Used by", a revoked state (needs `revoked_at`; revoke deletes the row today); Firmware: Current / Release / Test tags, boards per version, **Promote to release** (today: edit the notes by hand), GitHub link, paging; Scan: a Demozoo row | S–M each | short design in chat |

Already in the app (not to be planned again): header search with `/` (titles, collections); Disk at startup; network
checklist; OLED display editor; NFC/I2C status; Transfer status on the card; firmware queue + cancel; device rename;
header drive chips; Mount in DF1; write NFC tag; version history + restore; new folder / add / rename / move files;
table view with folders; per-page and view/sort/start-page preferences; collections create/reorder; Create ADF; title
editing, Demozoo identify, extract HFE; From-the-Amiga actions; admin user delete, TOSEC/OpenRetro import; "?" help
tips; invite sign-up.

## Phase B — design foundation

New colour tokens (ground #F3EFE6, surface #FFFDF8, line #E4DCCB, ink #24211B, muted #5B5446/#7A7262, accent #B5541A),
fonts (Bricolage Grotesque, Geist, Geist Mono via `next/font`), the new header (logo + WebFloppy wordmark, drive menu,
nav, search, the **gear (Settings) at the far right before Sign out**), the rename to **WebFloppy** (about 6 visible
places: title metadata, wordmarks, About, Help, a hint), and shared building blocks (buttons, cards, pills, segmented
controls, modals, the disk icon). The whole app takes the new look with today's page layouts.

Known cost: about 600 inline `var(--…)` styles and 68 `glass-card` uses (`src/app/globals.css` holds the tokens);
about 8 e2e specs check colours or layout (`contrast`, `button-affordance`, `shell`, `mobile`, `collections`,
`devices-page`, `send-to-amiga`, `library-mount`) and are updated here. Everything else selects by `data-testid`,
which the restyle keeps.

## Phase C — the new layouts, area by area

1. Library (grid; table with folders, the "↑ Library" up row and paging) and Title detail.
2. Devices (DF1 modes, network checklist, Transfer box, Board settings modal, Board display modal).
3. Upload (send & receive, the A6 staging list).
4. Disk files (history & time machine as on the Disk files board).
5. Settings, Help + "?" popover, Search, Sign in & sign up.
6. Admin (Overview, Users, Invites, Scan, Firmware).
7. Phone layouts (390 px) — a pass over everything; to iterate later.

Each area: a short spec, a plan, the build, the e2e specs for that area, merge.

## Backlog (not in this roadmap)

- Search inside disks: a `blob_files` index (path, name, kind, size; optional excerpt of small text files) filled by a
  resumable sweep like the TOSEC one plus an ingest hook; a third group in `lib/search.ts`; blob-GC and admin-delete
  upkeep. About a week.
- Forgot password by email: the app sends no email today; needs a mail provider, with a self-host path (parity rule).
- DF1 "Any disk" writable: DF1 write-back in firmware and server.
- Library multi-select (operator 2026-10-25): an icon at the top of the grid and table views turns on "multi
  operations"; a checkbox then appears in each title's left corner, and the top bar expands to the operations (Move to
  collection, Delete). Nothing changes until OK is pressed; Cancel leaves everything as it was. Bulk routes for move
  and delete are needed (today both act on one title). **Placement (operator 2026-10-25): build it right after the
  redesign (Phase C) finishes**; the design is inferred in the current style and UX, and the OK confirmation is an
  in-app dialog (`.wf-modal`), never a browser `confirm()`.
