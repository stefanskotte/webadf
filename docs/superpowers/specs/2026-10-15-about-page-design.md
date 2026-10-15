# About page: versions, hosting, platform and your library's storage

**Date:** 2026-10-15 · **Status:** design approved in chat, spec awaiting review

## Why

After the server-override bench (HANDOFF 3bn) the operator ruled that the device card's
"Custom server · certificate not checked" line goes: on a self-hosted server every board would carry
it, so it says nothing. Whether a server is self-hosted belongs to the server, not to each board.
The operator asked for one place that says what this server is: software versions, hosted or
self-hosted, storage used, and what the app and its platform are. It is reached from an (i) icon at
the top right.

## Decisions

| | Decision |
|---|---|
| D1 | **The card's server line is removed.** `device-card.tsx` stops rendering "Custom server" / "… · certificate not checked"; the `own-server` help topic loses its "On the card" paragraph; the e2e assertions at `e2e/devices-page.spec.ts:493-496` become "no server line". The `devices.server_custom` / `server_tls` columns and the board's status report stay (no migration, no firmware change); the board still logs the `noverify` warning at boot and on every connect. |
| D2 | **Self-hosted is the default.** `SELFHOSTED=false` marks our deployment (set in the Vercel project's env, Production and Preview); any other value, or none, means **Self-hosted**. A self-hoster sets nothing, and a future Docker image needs no marker. A local `pnpm dev` reads Self-hosted, which is true. If our Vercel env ever loses the variable, production says Self-hosted -- wrong but harmless, and visible. |
| D3 | **A page at `/about`, for every signed-in user, scoped to their own org** (operator chose option A; it can widen later). Server-wide totals stay on `/admin`. |
| D4 | **The (i) icon** sits in the header between the search box and Sign out, on every screen size, as a link with `aria-label="About this server"`. |
| D5 | **No secrets, no addresses.** The page states kinds, never values: "PostgreSQL", never the connection string or host; "Vercel Blob", never the token or store URL. |
| D6 | **No new tables.** Everything is computed per request from existing rows and build-time constants. |
| D7 | **Self-hosting parity (spec 2026-10-15-board-server-override D8).** Every section works on a self-hosted server; nothing depends on a Vercel-only variable without a fallback. |

## What the page shows

**Web app.** Short commit sha (links to `github.com/stefanskotte/webadf/commit/<sha>` when it is
40 hex characters) and build time. Both are fixed at BUILD time in `next.config.ts` and exposed as
server env (`WEBADF_COMMIT`, `WEBADF_BUILT_AT`), so a running server reports what it was built from:
commit = `VERCEL_GIT_COMMIT_SHA` → `GIT_SHA` (a build argument, for a Docker build without `.git`)
→ `git rev-parse HEAD` → `unknown`. Built at = the build's own clock, ISO 8601, shown in UTC (rendered on
the server, so no time-zone guess).

**Hosting.** "Hosted (webadf.vercel.app)" when `SELFHOSTED=false`, otherwise "Self-hosted". One
function, `hostingMode(env)`, decides it; nothing else reads `SELFHOSTED`.

**Platform.** Runtime "Node.js <process.versions.node>", database "PostgreSQL", file storage
"Vercel Blob" (the only backend today; the line reads from the storage module, so a second backend
changes it in one place), and the Next.js version from `next/package.json`.

**Firmware.** The newest release this org may install, with the same rule the Devices page uses
(stable for everyone; TEST builds only for `FIRMWARE_BENCH_ORGS`): version, sequence, published
date. Then "N of M boards are behind", or "No boards paired".

**Your library.** Titles, disks, history versions, and bytes stored. Bytes = the sum of
`blobs.size_bytes` over the DISTINCT blobs this org's current disks and history versions point at --
a blob two of your disks share counts once; a blob you share with another org counts in full for
each (it is yours too). Shown as KB/MB/GB with the exact byte count in a `title`.

**About.** One line on what webadf is, "MIT licence", links to Help and the repository.

## Structure

- `src/lib/about/build-info.ts` -- `buildInfo()`: commit, short commit, built-at, from the build-time env.
- `src/lib/about/hosting.ts` -- `hostingMode(env)`: `'hosted' | 'self-hosted'`.
- `src/lib/about/library-usage.ts` -- `libraryUsage(orgId)`: one query, four numbers.
- `src/lib/about/firmware-summary.ts` -- reuses `firmware-releases.ts` for the org's newest
  installable release and the boards-behind count (no second copy of the bench-org rule).
- `src/app/(app)/about/page.tsx` -- server component; each section loads independently.
- `src/components/shell/about-link.tsx` -- the (i) icon link; used in `src/app/(app)/layout.tsx`.
- Help: an `about` topic (what each line means, where "Self-hosted" comes from).
- README "Running it": `SELFHOSTED` is not needed for self-hosting; our deployment sets it to `false`.

## Errors

Each section is rendered from its own loader inside its own boundary. A loader that throws shows
"unavailable" for that section only; the rest of the page renders. A missing commit reads "unknown",
never an empty string.

## Testing

- vitest: `hostingMode` (`false` → hosted; `true`, unset, empty, `FALSE`, junk → self-hosted --
  the comparison is exact, lowercase `false`); the commit fallback chain (each step, and `unknown`);
  byte formatting.
- vitest against the database: `libraryUsage` counts a shared blob once and ignores other orgs' rows.
- e2e (`e2e/about-page.spec.ts`, plus the edited `devices-page.spec.ts`): the (i) opens `/about`;
  all six sections render; a fresh org shows zero disks and "No boards paired"; the page text
  contains no `postgres://`, `vercel_blob_rw_`, `BETTER_AUTH`; a board reporting `server_tls=noverify`
  shows no server line on its card.

## Rollout

Set `SELFHOSTED=false` in the Vercel project (Production and Preview) BEFORE the merge deploys, so
production never shows "Self-hosted". This is an outward change and is asked for at that step.

## Not in scope

Server-wide storage for admins, a Docker image, a second storage backend, the board-side
"name the certificate failure" log fix and the first-click "Pair a device" bug (HANDOFF 3bn
follow-ups a and b).
