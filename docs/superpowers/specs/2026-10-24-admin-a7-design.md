# A7 Admin: overview, invites, firmware, scan — design

Date: 2026-10-24. Roadmap item A7 (`2026-10-23-webfloppy-redesign-roadmap-design.md`), built in today's look (Phase C
restyles it). The approved canvas boards are Admin ×5. Written under the operator's unattended authorization of
2026-10-24 ("proceed all the way and including Phase C, you are free to implement as you see fit"): the design calls
below are mine and are listed as rulings at the end for the operator to review.

All four pages sit under `(admin)` (guarded by `requireSuperAdmin()` in the layout). New unscoped queries go in
`src/lib/admin-queries.ts` (the only cross-tenant module). Every new API route calls `requireSuperAdmin()` itself.

## 1. Overview (`/admin`)

Keeps the six count tiles. Adds, below them:

- **Boards** tiles: `Paired` (rows in `devices`), `Online now` (`last_seen_at` within `STALE_AFTER_MS`, 60 s, the
  same rule as the Devices page), `Seen in 7 days`. Test ids `count-boardsPaired`, `count-boardsOnline`,
  `count-boardsSeen7d`.
- **Boards by firmware (seen in the last 7 days)**: one row per `firmware_version` among devices seen in 7 days,
  newest release first (by the release's `sequence`; versions with no release row last, as "unrecognised"), each with
  its count and a bar sized to the largest count. Versions show the semver part with the full string in `title`.
  A row is tagged `Current` when the version is the current release (§3). Empty: "No board has been seen in the last
  7 days." Test ids `fw-dist`, `fw-dist-row` (with `data-version`), `fw-dist-empty`.
- **Needs attention**: at most 20 boards, each with the board name, the owner's email, and its reasons, from:
  - `Error <relative time>: <last_error>` when `last_error_at` is within 24 h;
  - `Behind: runs <v>, current is <v>` when it was seen in 7 days and runs an older release than the current one
    (by sequence; an unrecognised version counts as behind);
  - `Offline <relative time>` when it was seen in the last 7 days but not in the last 24 h.
  Sorted: errors first, then behind, then offline; then most recently seen. Empty: "Nothing needs attention." Test
  ids `attention`, `attention-row` (with `data-device-id`), `attention-empty`. There are no actions here; the row links
  to nothing (the operator's own boards are on /devices; others are other people's).

"Current release" everywhere = the highest-sequence release that is not a TEST build and not an e2e version — what
an organization outside `FIRMWARE_BENCH_ORGS` sees as latest.

## 2. Invites (`/admin/invites`)

- **Revoked state.** Migration 0049 adds `invites.revoked_at timestamptz null`. Revoke (`DELETE
  /api/admin/invites/[code]`, unchanged URL and answers: 204, 404, 409 when consumed) now sets `revoked_at = now()`
  where `consumed_at is null and revoked_at is null` instead of deleting (a second revoke of a revoked code: 204,
  idempotent). `claimInvite` adds `revoked_at is null`. `adminListInvites` state order: `revoked`, `consumed`,
  `expired`, `live`. `adminCounts().liveInvites` excludes revoked codes. Label "Revoked", muted.
- **Used by.** `user.create.after` records the consumer: `update invites set consumed_by_user_id = <user.id> where
  code = <normalised code from the body> and consumed_by_user_id is null` (best effort, logged, never throws — the
  same rule as the bootstrap beside it). The list joins `auth.user` for the email; column "Used by" shows the email,
  or "—" for codes consumed before this change. A consumed code also shows its `consumed_at` date.
- **Copy.** A live row has **Copy code** and **Copy link** (`<origin>/sign-up?invite=<code>`, built from
  `window.location.origin` so a self-hosted instance copies its own address). The button reads "Copied" for 2 s.
  Test ids `invite-copy-code-<code>`, `invite-copy-link-<code>`. The new-code panel after Issue gets the same two
  buttons.
- Columns: Code, State, Used by, Issued, Expires, Action.

## 3. Firmware (`/admin/firmware`)

- **Tags** on each row: `Current` (§1's rule), `Release` (not a TEST build) or `Test` (notes start "TEST build"),
  and the existing `Security`. Test ids `fw-tag-current`, `fw-tag-release`, `fw-tag-test` inside the row.
- **Boards** on each row: "N boards" = devices whose `firmware_version` equals the row's version (all paired boards,
  any last-seen), test id `fw-boards`.
- **GitHub link** on a Release row with a plain `x.y.z` semver: `https://github.com/<repo>/releases/tag/fw-<semver>`,
  `<repo>` = `WEBADF_FIRMWARE_REPO` or `stefanskotte/webadf` (the importer's rule, shared as one constant). Test id
  `fw-github`.
- **Promote to release** on a Test row. A modal holds the notes with the leading "TEST build" and the punctuation
  and spaces after it removed, editable; **Promote** saves them. Server (`POST /api/admin/firmware/[id]/promote`,
  body `{ notes: string }`, 1..2000 chars after trim):
  - 404 unknown id; 409 when the row is not a TEST build (already promoted);
  - 400 when the new notes are empty or still start with "TEST build";
  - reads the image bytes from storage and runs `refuseImageMarkers(bytes, newNotes)`: a bench-only image (debug
    command, DF1-default, PaulaNET loopback, A2B discard markers) is refused 409 with that reason — promotion can
    never ship a build the publisher would have refused as a release;
  - else updates `notes` (notes are not part of the signed manifest, so the signature stays valid) and answers the
    row. The modal then says: "Promoted. The GitHub release is made from the build folder: run `pnpm
    firmware:publish --github-only`." (A browser has no build folder and no `gh`; this is the existing repair path.)
  Test ids `fw-promote-<id>`, `fw-promote-dialog`, `fw-promote-notes`, `fw-promote-confirm`, `fw-promote-error`,
  `fw-promote-done`.
- **Paging**: 25 per page, `?page=N` (1-based, clamped), newest first, "Newer" / "Older" links with test ids
  `fw-page-newer`, `fw-page-older`, and "Page N of M".
- The read-only comment at the top of the page changes: publishing still happens from the Mac (the key), promotion
  is a notes edit.

## 4. Scan (`/admin/scan`)

A **Demozoo** row beside the TOSEC fetch line, from the single `demozoo_import` row (`readDemozooImportState()`,
`.catch(() => null)` like TOSEC's):

- `Demozoo: applied <relative> · <N> productions · <M> screenshots · last checked <relative>` when `applied_at` is
  set; `Demozoo: fetched <relative>, not applied yet` when step is `fetched`/`extracted`; `Demozoo: never fetched` when
  there is no row; `Demozoo: unreadable` when the read fails. Test id `demozoo-status`.
- No button: the daily cron owns it (fetches at most weekly).

## 5. Testing

- Unit: the attention reasons and their order; the version ordering of the distribution; the promote notes
  stripping; the GitHub URL rule; the paging clamp.
- DB: board counts and the 7-day distribution across two orgs; attention rows (error, behind, offline, healthy board
  absent); revoke keeps the row as revoked and `claimInvite` refuses it; Used by recorded; promote refused for a
  release row, for notes still "TEST build", and for a marker image; promote of a plain test image updates notes only
  (sha, signature, sequence unchanged).
- e2e (`admin-guard`, `admin-invites`, `admin-firmware`, `admin-scan`, `invite`): overview board tiles and a seeded
  distribution row; revoke shows Revoked and the code no longer signs up; Used by shows the new user's email; copy
  buttons write the clipboard (desktop project with clipboard permission); a seeded TEST release promotes and turns
  into Release; paging links; the Demozoo line shows.

## Out of scope

A firmware channel column (the "TEST build" notes convention stays the one source); creating the GitHub release from
the browser; per-day firmware history; actions on attention rows; an admin audit log.

## Rulings (operator to review)

1. "Boards by firmware (7 days)" = the current distribution among boards seen in 7 days, not a per-day history (no
   data source exists; a snapshot table is not worth it yet). Cost if wrong: a new table and a chart.
2. "Needs attention" = error in 24 h, behind the current release, or offline 1–7 days; 20 rows max. Cost: thresholds.
3. Revoke keeps the row (`revoked_at`), and a second revoke is a 204. Cost: none to undo; the migration stays.
4. Promote stays a notes edit (no channel column), refuses bench-marker images, and leaves the GitHub release to
   `pnpm firmware:publish --github-only`. Cost if wrong: a channel column refactor across visibility, manifest and
   GitHub rules.
5. Copy link uses the browser's origin (self-host parity). Cost: none.
