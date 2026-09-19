# Live device state in every open browser — design

**Date:** 2026-09-19
**Status:** approach approved by the operator in conversation (polling fingerprint, ~3 s, no upload
progress); this document awaits the operator's review.

## 1. The problem

Every page in the app is a server component rendered once. It refreshes only after the user's own
action (`router.refresh()` in the component that made the change). A second browser keeps showing
whatever was true when it loaded. The operator saw this with two computers: the mount state
disagreed until one of them was reloaded.

What changes the state without the viewing browser doing anything:
- a mount, eject or write-protect change made in another browser (or another tab);
- the board converging: it reports that a disk finished loading, or that it ejected;
- the board's own writes: since write-back piece 2b a save changes the disk's digest and history;
- a device going online or offline. This is derived from `lastSeenAt` against `STALE_AFTER_MS`
  (60 s) in `src/lib/device-state.ts`, so it **changes with time alone**, with no row changing.

Where the state is shown: the devices page (`device-card.tsx`), the game page (`mount-action.tsx`,
`write-protect-toggle.tsx`, `disk-row.tsx`), the library cards, and the files page (the lock on a
mounted disk).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| L1 | **Poll a fingerprint; re-render when it changes.** | A server push (SSE or WebSocket) would still have to poll the database to learn of a change, since Neon over HTTP has no LISTEN/NOTIFY. Polling is the same cost with none of the connection handling, and `router.refresh()` reuses every page's existing server rendering, so no page needs a second, client-side copy of the state. |
| L2 | **Every 3 s, only while the tab is visible.** | The operator said 3 s is fine. A hidden tab costs nothing, and it checks at once when it becomes visible again, so a tab brought to the front is never stale for 3 s. |
| L3 | **The fingerprint covers what the pages show about devices and mounted disks, and nothing else.** | Refreshing on unrelated changes (other users' library edits, the admin plane) would re-render pages for nothing. Anything that is not device state already refreshes after the user's own actions. |
| L4 | **Online/offline is computed at request time and included in the fingerprint.** | It changes without any row changing (§1). Using the same `deviceState()` the pages use means the fingerprint changes exactly when a page would render differently. |
| L5 | **No upload progress (the cloud) in the browser.** | The operator does not need it now. The server could only infer it from open `disk_write_sessions` rows; it can be added to the fingerprint later. |

## 3. Components

### 3.1 `src/lib/live-state.ts` (pure core plus one query)

- `liveStateRows(db, orgId)`: one query over the org's `devices`. For each device: `id`,
  `desiredDiskId`, `desiredSha256`, `desiredVersion`, `mountedSha256`, `mountedVersion`,
  `lastSeenAt`, `name`, `lastError`, `lastErrorAt`. It left-joins `disks` on `desiredDiskId` for
  that disk's `sha256` and `writeProtected`. Ordered by device id, so the output does not depend
  on row order.
- `liveFingerprint(rows, now)`: pure. It builds one canonical string per device:
  `id|desiredDiskId|desiredSha|desiredVersion|mountedSha|mountedVersion|deviceState(row, now)|diskSha|diskWP|name|lastError|lastErrorAt|online|staleRelative`.
  It joins them and returns a short hash (sha-256, the first 16 hex characters). `lastSeenAt`
  itself is **not** part of it, since it moves every 25 s; only what the pages actually derive
  from it is:
  - `online`: `'1'`/`'0'`, from `isOnline(lastSeenAt, now)` (`src/lib/device-state.ts`) -- the same
    predicate `devices/page.tsx`'s header count uses, so the two can never disagree. Needed
    because a converged device going offline does not change `deviceState()` at all, and the
    header's online count would otherwise freeze.
  - `staleRelative`: for a device whose `deviceState()` is `'stale'`, the exact
    `relative(lastSeenAt, now)` text (`'5m ago'`, etc.) `DeviceCard` renders; `''` otherwise. Also
    from `src/lib/device-state.ts`, imported back into `DeviceCard` so the card and the
    fingerprint use one function and can never drift apart.
- The disk's own `sha256` is included because a board's write moves it (§1) even while the
  device row's desired/mounted digests follow a moment later.
- `lastError`/`lastErrorAt` are included because `DeviceCard` renders `lastError` in every state:
  a status report that only sets an error, with every other hashed field unchanged, must still
  change the fingerprint.

### 3.2 `GET /api/live-state`

- Authenticated by the session (`requireOrg`), scoped to the active organisation. Answers
  `200 {"fingerprint": "<16 hex>"}` with `Cache-Control: no-store`. An unauthenticated request gets
  the same answer every API route gives today (redirect/401 per `requireOrg`).
- No request body, no parameters.

### 3.3 `src/components/shell/live-refresh.tsx` (client, in the app layout)

- Mounted once in `src/app/(app)/layout.tsx`, so every page under it is covered. It renders
  nothing.
- On mount it fetches the fingerprint and remembers it without refreshing. After that it fetches
  every 3000 ms while `document.visibilityState === 'visible'`. When the fingerprint differs from
  the last one, it calls `router.refresh()` and remembers the new value.
- On `visibilitychange` to visible it fetches at once, then resumes the interval. While hidden, no
  requests are made.
- At most one request in flight at a time: a tick that finds one still pending is skipped.
- A failed fetch (network, 401, 5xx) is ignored silently and retried on the next tick. It never
  throws, never toasts, and never refreshes.
- It does not refresh while the user is typing in a form on the page. If `document.activeElement`
  is an `input`, `textarea` or contenteditable element, the refresh is deferred until focus leaves
  it. Otherwise a rename field could be re-rendered mid-edit. The fingerprint is still recorded,
  and the deferred refresh runs on the first tick after focus leaves.

## 4. Error handling

| Failure | Behaviour |
|---|---|
| fetch fails or times out | ignored; retried next tick; no refresh |
| 401 (session ended) | ignored; the next navigation hits `requireOrg` and signs out as today |
| a refresh is already running | the next tick compares against the fingerprint recorded after it |
| the user is typing | refresh deferred until focus leaves the field (§3.3) |

## 5. Testing

- **vitest** (`src/lib/live-state.test.ts`):
  - the fingerprint is stable for identical rows in any input order;
  - it changes when any of these change: desired disk, desired or mounted digest, desired or
    mounted version, write-protect, the disk's digest, the device name, `lastError`,
    `lastErrorAt`;
  - it changes when time alone moves a device across `STALE_AFTER_MS` (the same rows, `now` moved
    past the threshold);
  - it changes when time alone moves a **converged** device across the online/offline boundary
    (`deviceState()` itself does not move, only `online`);
  - it changes when time alone moves a **stale** device's relative-time text (e.g. `now` moving
    from 5 minutes to 6 minutes past `lastSeenAt`, both already well past the threshold);
  - it does **not** change when only `lastSeenAt` moves within the threshold.
- **e2e** (`e2e/live-state.spec.ts`), two browser contexts signed in to the same org:
  - A mounts a disk on a paired device; B, which never reloads and never clicks, shows it as
    requested within 5 s (the 3 s interval plus slack).
  - A turns the disk's write-protect off; B's toggle reflects it within 5 s.
  - A device status report sent through the device API (a converged mount) moves B's device
    card from "pending" to "mounted" within 5 s.
  - A device status report that changes only `error` (nothing else in the body) makes B's
    `device-error-<id>` element appear within 5 s.
  - An idle page makes requests to `/api/live-state` only, and does not re-render while nothing
    changes. The test counts RSC refetches over 10 s: zero.
- The existing suite stays green. Specs that assert on a page right after an action are
  unaffected: a refresh re-renders the same data.

## 6. Out of scope

- The board's upload progress (the cloud) in the browser (L5).
- Live updates for anything that is not device or mounted-disk state (L3). In particular, the
  write-protect flag of a disk **no device has asked for** is not watched. That flag changes only
  from a browser, never from a board, and the browser that changed it has already refreshed.
- Push transports (SSE, WebSockets) (L1).
- A game renamed while a device is pending on it: the fingerprint does not include the desired
  game's title, only its id/disk/digest, so a rename made in another browser while a mount is in
  flight is not itself a reason to re-render. Rare, and the next unrelated re-render (or a manual
  reload) shows the new title.
