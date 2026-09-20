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
| L2 | **Every 3 s while the tab is visible AND in use; every 30 s after ten minutes without input** (operator, 2026-09-20). | The operator said 3 s is fine for someone using the app. A hidden tab costs nothing, and it checks at once when it becomes visible again, so a tab brought to the front is never stale for 3 s. A VISIBLE tab nobody is looking at is the case 3 s gets wrong: it polls for as long as it is open (~1,200 requests an hour, each a session lookup plus a query) and keeps the database awake all night. Idleness is measured from the last input in that tab, not from the last change on the server -- a board mounting a disk on its own must not make the tab consider itself in use. "Input" is deliberately broad, so a visible tab nobody is looking at is actually true as written rather than true only of a tab nobody's mouse is anywhere near: pointer move or down, a key, the wheel, a scroll, a touch, and returning to the tab all count (§3.3); a pointer move alone, at any rate, is enough to stay active. Any of these polls at once and restores 3 s, so coming back never costs 30 s of staleness. The rule is `src/lib/live-poll.ts`, pure and tested, including a clock that jumps backwards (a laptop waking, an NTP step), which reads as input just now rather than as ten minutes of idleness -- the component feeds it `performance.now()`, not `Date.now()`, so that jump is never visible to it in the first place. |
| L3 | **The fingerprint covers what the pages show about devices and mounted disks, and nothing else.** | Refreshing on unrelated changes (other users' library edits, the admin plane) would re-render pages for nothing. Anything that is not device state already refreshes after the user's own actions. |
| L4 | **Online/offline is computed at request time and included in the fingerprint.** | It changes without any row changing (§1). Using the same `deviceState()` the pages use means the fingerprint changes exactly when a page would render differently. |
| L5 | **No upload progress (the cloud) in the browser.** | The operator does not need it now. The server could only infer it from open `disk_write_sessions` rows; it can be added to the fingerprint later. |

## 3. Components

### 3.1 `src/lib/live-state.ts` (pure core plus one query)

- `liveStateRows(db, orgId)`: one query over the org's `devices`. For each device: `id`,
  `desiredDiskId`, `desiredSha256`, `desiredVersion`, `mountedDiskId`, `mountedSha256`,
  `mountedVersion`, `lastSeenAt`, `name`, `firmwareVersion`, `lastError`, `lastErrorAt`. It
  left-joins `disks` on `desiredDiskId` **and** the org (`disks.orgId`) for that disk's `sha256` and
  `writeProtected`, so a `desiredDiskId` that somehow named a row in another org can never pull that
  row's `sha256`/`writeProtected` into this org's fingerprint. Ordered by device id, so the output
  does not depend on row order.
- `liveFingerprint(rows, now)`: pure. It builds one canonical string per device:
  `id|desiredDiskId|desiredSha|desiredVersion|mountedDiskId|mountedSha|mountedVersion|deviceState(row, now)|diskSha|diskWP|name|firmwareVersion|lastError|lastErrorAt|online|staleRelative`.
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

- Scoped to the active organisation, checked the same way `requireOrg()` is (`auth.api.getSession`
  against the session's `activeOrganizationId`) -- but unlike a page under `(app)`, a missing
  session or active organisation answers `401 {"error": "unauthorized"}` with
  `Cache-Control: no-store`, not `requireOrg()`'s redirect. A `fetch()` follows a redirect and
  resolves it as a 200 carrying the sign-in page's HTML, which LiveRefresh would try to parse as
  JSON; a 401 is a plain non-2xx answer LiveRefresh already ignores by design (§4).
- Otherwise answers `200 {"fingerprint": "<16 hex>"}` with `Cache-Control: no-store`.
- No request body, no parameters.

### 3.3 `src/components/shell/live-refresh.tsx` (client, in the app layout)

- Mounted once in `src/app/(app)/layout.tsx`, so every page under it is covered. It renders
  nothing.
- Its baseline is not its own first fetch, but the fingerprint the layout computed server-side for
  THIS render (`liveFingerprint`/`liveStateRows` -- the same functions `/api/live-state` uses),
  passed down as an `initial` prop. Seeding from the server closes a window a first-fetch baseline
  would leave open: a change landing between the server render and the client's first tick (client
  hydration plus one round trip, unbounded on a slow device or network) would otherwise be folded
  straight into that baseline and never surface until some later, unrelated change gave the poller
  something to compare against. After mount it fetches while
  `document.visibilityState === 'visible'`, at the rate `livePollDelay` gives for how recently this
  tab saw input (L2): every 3000 ms while in use, every 30000 ms once ten minutes have passed with
  none. Each answer is compared against that baseline; when the fingerprint differs from the last
  one, it calls `router.refresh()` and remembers the new value. A fresh `initial` (from that
  `router.refresh()` or a full navigation) is re-adopted as the baseline with nothing owed.
- On `visibilitychange` to visible it fetches at once, then resumes polling, and counts the return
  itself as input (a tab brought to the front is being looked at, whatever the last pointer event
  says). While hidden, no requests are made.
- The timer is a self-scheduling `setTimeout`, re-armed after each tick at whatever the rate is by
  then (`livePollDelay`), rather than a fixed `setInterval`: a tab that goes idle slows down without
  the polling loop being torn down and rebuilt. "Input", for L2's purposes, is any of: `pointerdown`,
  `keydown`, `wheel`, `scroll`, `touchstart`, `pointermove`, or the tab becoming visible again --
  spelled out here so "a visible tab nobody is looking at" (L2) is true as written: a tab with the
  mouse merely resting over it, generating none of these, counts as unused. All are watched with
  passive, capturing listeners; `pointermove` additionally self-throttles inside its handler (a
  ref comparison, no write, unless at least ~30 s have passed since the last recorded input), since
  it fires on every pixel of movement and a high-rate move stream must cost one comparison per
  event, not one ref write.
- Idleness is timed with `performance.now()`, not `Date.now()`, for both the last-input timestamp
  and the comparison against it: a monotonic clock so a laptop waking (a forward jump in wall-clock
  time) cannot make an active tab read as ten minutes idle. `src/lib/live-poll.ts` itself stays
  clock-agnostic -- it takes two numbers and does not care which clock produced them.
- At most one request in flight at a time: a tick that finds one still pending is skipped.
- A failed fetch (network, 401, 5xx) is ignored silently and retried on the next tick. It never
  throws, never toasts, and never refreshes.
- It does not refresh while the user is typing in a form on the page. If `document.activeElement`
  is an `input`, `textarea` or contenteditable element, the refresh is deferred until focus leaves
  it. Otherwise a rename field could be re-rendered mid-edit. The fingerprint is still recorded,
  and the deferred refresh runs on the first tick after focus leaves. The one exception is the
  header search box (`SearchBox`, mounted in the layout): its input carries `data-live-ok`, and an
  element with that attribute is never treated as "typing" here -- focus lingering there is not the
  same thing as an in-progress edit the way it is for a rename field, and must not hold back live
  updates for the rest of the page.

## 4. Error handling

| Failure | Behaviour |
|---|---|
| fetch times out | `AbortSignal.timeout(10_000)` aborts the fetch; the same `catch` that handles a network failure ignores it and retries next tick |
| fetch fails (network, 5xx) | ignored; retried next tick; no refresh |
| 401 (session ended) | the route answers this directly (§3.2), never a redirect; ignored like any other non-2xx; the next navigation hits `requireOrg` and signs out as today |
| a refresh is already running | the next tick compares against the fingerprint recorded after it |
| the user is typing | refresh deferred until focus leaves the field (§3.3); the header search box is exempt (§3.3) |

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
- **vitest** (`src/lib/live-poll.test.ts`), the L2 rate rule in isolation:
  - `livePollDelay` returns the fast rate for any gap under the ten-minute threshold, and the slow
    rate once it is reached or passed;
  - a `now` before `lastInputAt` (a clock that jumped backwards) reads as input just now, never as
    idleness;
  - the three constants (`LIVE_POLL_MS`, `LIVE_IDLE_POLL_MS`, `LIVE_IDLE_AFTER_MS`) are pinned to
    3 s / 30 s / 10 min, so a later change to any of them is deliberate.
- **e2e** (`e2e/live-state.spec.ts`), two browser contexts signed in to the same org:
  - A mounts a disk on a paired device; B, which never reloads and never clicks, shows it as
    requested within 5 s (the 3 s interval plus slack).
  - A turns the disk's write-protect off; B's toggle reflects it within 5 s.
  - A device status report sent through the device API (a converged mount) moves B's device
    card from "pending" to "mounted" within 5 s.
  - A device status report that changes only `error` (nothing else in the body) makes B's
    `device-error-<id>` element appear within 5 s.
  - An idle page makes requests to `/api/live-state` only, and does not re-render while nothing
    changes. The test counts RSC refetches over 15 s: zero (widened from an earlier 10 s, which
    against the live production database's real round trips could land exactly on the boundary of
    the poll-count assertion with no margin).
  - A single-browser test drives the whole L2 transition using Playwright's clock API (`page.clock`),
    which can jump the tab's `performance.now()`/`Date.now()` forward without the test actually
    waiting ten minutes: it measures the fast rate active, `fastForward()`s past the idle threshold
    (once, since a recursive `setTimeout` chain only needs its next-due tick fired, not replayed
    tick by tick), measures the slow rate idle, then dispatches a real `page.mouse.move` and
    confirms it polls immediately and is back to the fast rate.
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
