# Typeahead search — design

**Written 2026-09-02.** Implements the "Typeahead search with debounce, over titles and
descriptions" backlog entry, requested by the operator 2026-08-31 and re-specified 2026-09-02 as
a Spotlight-style overlay.

---

## 1. What this is for

The library is a flat grid ordered by ingest date, optionally filtered to one collection. Finding
a specific title means scrolling or knowing which collection it is in. The operator asked for a
rounded search box "much like the menu is — think spotlight search on mac, which just works".

"Just works" is the actual requirement, and it decomposes into three things this design commits
to: you can type a fragment from the **middle** of a name and still find it; results appear
without a submit; and the thing you want is reachable with the keyboard alone.

**A finder, not a filter.** Search does not change what the library grid shows. It is an overlay
that takes you somewhere — a title's page, or a collection's filtered view. The grid, the
collection rail and the `?collection=` param are untouched by this increment.

---

## 2. Scope

**In:**

- A rounded search pill in the shell header, present on every `(app)` and `(admin)` page.
- A floating result panel: titles, and collections, as two labelled groups.
- Matching **anywhere in the text** (infix), over `games.title`, `publisher`, `genre`,
  `description`, and `collections.name`.

  **`description` is matched but must not be advertised.** It is written only for blobs OpenRetro
  recognises: 2 of the 9 rows in the live database have one, and 0 have `history`. A UI that says
  "searches descriptions" would today be describing a search of two rows. It costs nothing to
  include in the predicate and it will improve on its own as enrichment lands, but the placeholder
  says "Search titles" for a reason.
- Keyboard: `⌘K` / `Ctrl+K` and `/` to focus; `↑` `↓` to move; `Enter` to open; `Escape` to
  dismiss.
- `GET /api/search`, org-scoped.
- Migration 0012: `pg_trgm` plus trigram indexes (see §5, including why it buys nothing today).

**Out, deliberately:**

- **Searching disk filenames.** `disks.tosecName` and `entitlements.sourceFilename` are both
  searchable in principle, but a disk is not a page you can navigate to — it lives inside a title
  — so it needs a third result shape and a "jump to the title, scrolled to that disk" behaviour
  that nothing else in the app does yet.
- **Typo tolerance.** `pg_trgm` similarity scoring would give it, but on a library of tens of
  titles nearly everything is "similar" to everything, and a confidently wrong first result is
  worse than no result. The extension lands here; using it for fuzzy ranking is a later decision.
- **Filtering the grid from a query.** No `?q=` on `/library`. If that is wanted later it is
  additive: the route already returns the ids.
- **Search history, recent searches, saved searches.** Each is per-tenant state and none was
  asked for.
- **Rate limiting.** See §6.

---

## 3. The isolation this has to get right

A search endpoint is the widest read surface in the app: it is fired on every keystroke, it takes
free text, and it reaches four tables. Three things make it safe, and only the first is obvious.

### 3.1 `orgFilter()` is the chokepoint

Every catalog read goes through `orgFilter(table, orgId)` (`src/db/scope.ts`), which **throws** on
an empty org id rather than silently matching every row. Both queries here use it, and the route
sits behind `requireOrg()`, so there is no anonymous path and no path that forgets the predicate
without failing loudly.

### 3.2 `disks.orgId` can diverge from its game's org, so a join on `gameId` alone is not scoped

**This is the non-obvious one.** Nothing in the schema guarantees `disks.org_id` matches the org
of the game it points at — there is no CHECK and no composite foreign key, and only the write path
(`/api/ingest/complete`) keeps it true. `src/lib/admin-delete.ts` documents that drift as real, and
`listGames` and `withDerived` both already scope the disks join on **`gameId` AND `disks.orgId`**
for exactly this reason.

**Any disk count, cover or kind attached to a search result must scope the same way.** Reusing
`withDerived` gets this for free; a hand-rolled join is where it would break silently — the result
would still belong to the right org, but its disk count and its cover could come from another
tenant's disk of the same game id.

### 3.3 Global tables are reached only *through* the org's own disks

`blobs`, `openretro_images` and `tosec_entries` are global by design: they are content-addressed,
so two tenants uploading the same bytes share a row. `withDerived` reaches them **from** `disks`
already filtered by org, never the other way round. Search keeps that direction. Reversing it —
matching a global table first and joining back — would be a leak even with `orgFilter` present.

### 3.4 It must not become an existence oracle

`/api/ingest/check` is a deliberate global cross-tenant oracle on digests (D13). **Titles are not
digests and no equivalent decision covers them.** Another org's title returns nothing, and
"nothing" is indistinguishable from "you have no such title": same status, same body shape, no
404 that separates the cases, and no error text that differs between them.

### 3.5 `collection_games` is reached only through an org-scoped collection

`collections` carries `orgId`, so `orgFilter` covers it. `collection_games` deliberately has **no**
`orgId` (D-4-5) and is reachable only through a collection.

**Corrected 2026-09-02, during Task 3's review.** An earlier draft of this section said
`collection_games` "is never queried" — which contradicted §7.2 of this same spec, where a
collection result row shows its member count. The count has to come from somewhere. It comes from a
subquery correlated on `collections.id` **inside** the `orgFilter(collections, orgId, …)` predicate,
so the id it keys on is already org-scoped — the safe shape this section always demanded, described
by a sentence that had gone stale. `listCollections` (`src/lib/collections.ts`) counts members the
same way.

The rule that matters is unchanged and is the one to carry forward: **`collection_games` is never
keyed on a collection id that has not itself been through `orgFilter`.**

---

## 4. Matching

`q` is trimmed, lowercased, capped at **100 characters**, and `%`, `_` and `\` are escaped before
reaching SQL.

The escaping is **not** a tenancy control — an injected wildcard cannot cross an org boundary,
because `orgFilter` is a separate conjunct. It is there because a single unescaped `%` makes every
keystroke match the caller's entire library, which is the wrong shape for an endpoint fired per
character.

An empty or whitespace-only `q` returns empty groups **without touching the database**.

**Ranking.** Results are ordered by:

1. Titles matching on `title` before titles matching only on an attribute — a person typing
   "rainbow" who gets *Turrican II* should see why, and a name match is the stronger signal.
2. Then `(sortTitle, id)`.

The second column is not decoration. A non-unique `ORDER BY` paired with a `LIMIT` has already
produced two bugs in this codebase (`adminListUsers`, and `mergeDuplicates`' survivor pick), and
this query has both.

**Caps:** 8 titles, 4 collections. Enough to choose from, small enough that the panel never
scrolls.

---

## 5. The migration, and an honest note about it

**Migration 0012:** `CREATE EXTENSION IF NOT EXISTS pg_trgm`, then GIN trigram indexes on
`games.title` and `games.publisher`. Additive; no table is altered and no data moves. `pg_trgm` is
already available on this Neon instance (verified 2026-09-02, `pg_available_extensions`).

**At today's size this index buys nothing measurable.** The live database holds 9 games; the
operator's full archive is 61 disks. Postgres will very likely choose a sequential scan for a
per-org predicate over that many rows no matter what indexes exist, and it will be instant.

It is in this increment anyway, for one reason: the backlog entry warns specifically against
discovering later that `ILIKE '%foo%'` cannot use `games_org_sort_idx`, and adding the extension
during a later performance panic is a worse moment to be running migrations than now. **If the
operator prefers to defer it, the feature is unaffected** — the query is identical either way, and
the extension can be added later with no code change.

---

## 6. What this does not defend against

Stated so nobody assumes otherwise:

- **No rate limiting.** The endpoint is authenticated and org-scoped, and a caller can already
  enumerate their own library from `/library`. Adding a limiter would be the app's first, and
  there is no existing pattern to follow.
- **No timing side-channel defence.** A search that matches nothing may return marginally faster
  than one that matches. Distinguishing "no match in my org" from "no match anywhere" this way
  requires a cross-tenant comparison the attacker cannot make without another account, and the
  signal is drowned by network variance.

---

## 7. Surfaces

### 7.1 The pill

A `rounded-full` input in the shell header, immediately right of `TopNav`, sharing its fill
(`rgb(255 255 255 / 0.12)`) and hairline border so the two read as one group. Placeholder
"Search titles". Present in both `(app)/layout.tsx` and `(admin)/layout.tsx`.

`⌘K` / `Ctrl+K` and `/` focus it from anywhere in the app. `/` must not steal the key while the
caller is typing in another input — the handler ignores the event when the active element is an
`input`, `textarea` or `contenteditable`.

### 7.2 The panel

A floating card below the pill, `--glass-strong` (0.80) rather than `--glass`, matching the auth
panel: it overlays the page gradient at whatever scroll position, and only the stronger fill keeps
`--ink` legible over the dark top. Two labelled groups, **Titles** then **Collections**, each
omitted when empty.

A title row shows title, and `year · publisher · N disks` where present. A collection row shows
name and member count. Selecting a title goes to `/games/<id>`; selecting a collection goes to
`/library?collection=<id>`.

**States:** idle (no panel), results, "No titles match *foo*", and a one-line error. **Errors do
not raise a toast** — a toast per failed keystroke is its own denial of service.

### 7.3 Keyboard

`↑`/`↓` move a highlight across both groups as one list; `Enter` opens the highlight; `Escape`
closes the panel and blurs; clicking outside closes. The highlight resets to the first row on
every new result set, so `Enter` immediately after typing always opens the top result.

---

## 8. The client

**Debounce ~150 ms, and abort the in-flight request.** Debounce alone is not enough: without
`AbortController` a fast typist gets responses out of order and the panel flickers back to a stale
result. Each keystroke aborts the previous fetch, and a response whose query no longer matches the
current input is discarded even if it arrives.

This is the single most likely bug in the increment and §9 tests it directly.

---

## 9. Testing

**Vitest** (pure, no database): query normalisation and wildcard escaping; the ranking rule
(name-match before attribute-match, then `sortTitle`, then `id`); the "empty query returns empty
without querying" branch.

**Playwright:**

1. Typing shows matching titles; `Enter` navigates to that title.
2. A middle-of-string fragment matches — "sisters" finds "Giana Sisters".
3. An attribute match works and ranks below a name match.
4. A collection result navigates to `?collection=<id>`.
5. `Escape` closes; `⌘K` focuses; `/` does **not** hijack typing in another input.
6. **Out-of-order responses do not win.** Delay one response with `page.route`, type past it, and
   assert the panel shows the newer query's results.
7. **Cross-tenant:** org B searching org A's exact title gets an empty result, with the same
   status and body shape as a genuine miss.
8. **Defence in depth:** a game whose disk's `org_id` has drifted from its game's org is neither
   surfaced nor counted. `game-detail.spec.ts` already has the sibling of this test for the disk
   list; search gets its own.

---

## 10. Decisions

- **D-5-1. Search is a finder, not a filter.** It navigates; it never changes what the library
  grid renders. Keeps `?collection=` and the rail as the only things that filter, and lets the
  feature work from Devices and Admin.
- **D-5-2. Infix matching, via `pg_trgm`.** Prefix-only would ship with no migration but fails the
  "just works" requirement the operator actually stated: "sisters" must find "Giana Sisters".
- **D-5-3. The trigram index ships now, though it buys nothing at current scale.** Additive and
  reversible; the alternative is running a migration during a future performance problem. See §5.
- **D-5-4. No typo tolerance in this increment.** On tens of rows, similarity scoring surfaces
  confident nonsense. The extension is present; using it for fuzzy ranking is a later decision.
- **D-5-5. Anything attaching a disk count, cover or kind must scope the disks join on `orgId` as
  well as `gameId`.** `disks.orgId` can drift; see §3.2. Reuse `withDerived`.
- **D-5-6. Titles are not digests.** D13's global existence oracle covers `/api/ingest/check`
  only; search is org-scoped and returns nothing rather than distinguishing absence from
  ownership.
- **D-5-7. Wildcards are escaped for shape, not for isolation.** `%` and `_` cannot cross an org
  boundary, but unescaped they make one keystroke match the whole library.
- **D-5-8. Errors do not toast.** One line in the panel. A toast per keystroke is its own problem.

---

## 11. What this increment delivered

**Delivered 2026-09-02 on `feat/typeahead-search`, all 7 tasks.** Plan:
`docs/superpowers/plans/2026-09-02-typeahead-search.md`. Everything in §§1–10 shipped as
specified except where noted below.

**Files:** `src/lib/search-query.ts` (pure normalisation and escaping), `src/lib/search.ts`
(the two org-scoped queries), `src/app/api/search/route.ts`, `src/components/shell/
search-box.tsx`, `drizzle/0012_search_trgm.sql`, and `e2e/search.spec.ts`. The pill is
rendered from both `(app)` and `(admin)` layouts.

### Two deliberate deviations, decided while planning

1. **Ranking is done in SQL, not in TypeScript.** §9 lists the ranking rule under Vitest,
   which implies ranking in the client. Doing it there means fetching N candidates ordered by
   `sortTitle` and re-sorting them — so the `LIMIT` can truncate away the very name-match that
   should have ranked first. `ORDER BY (CASE WHEN title ILIKE … THEN 0 ELSE 1 END),
   sort_title, id` is correct at any size. **Ranking is therefore covered by Playwright, not
   by Vitest**, which is the only reason §9's split does not match what shipped.
2. **`q` is not lowercased.** §4 says trimmed, lowercased, capped. `ILIKE` is already
   case-insensitive, so lowercasing changes no result and only invites the next reader to
   think matching is case-sensitive somewhere. Trim, collapse whitespace, cap, escape — no
   case change.

### What changed shape during implementation

- **The empty-state line is gated on a completed response for the current query**, not on
  "results are empty". §7.2 describes the line but not its gate; without one, `search-empty`
  renders on the very next React commit — before the debounce elapses, let alone before a
  request is made. It then flashes on every search, and **a completely broken `/api/search`
  would still render it**, so a test asserting only its appearance proves nothing.
- **The abort needed a second guard.** §8 specifies aborting the in-flight request, which is
  necessary and not sufficient: aborting is not instantaneous, so an older query's response
  can still land after a newer one has started. Each landing response is compared against
  `currentQueryRef` — the trimmed query as of the most recent keystroke, held outside React
  state so the fetch callback can read it synchronously — and dropped if it no longer matches.
  Both guards ship, not either.
- **`search-box.tsx` redeclares the two result shapes rather than importing them** from
  `src/lib/search.ts`. That module reaches `@/db`; this is a client component, and the import
  would drag the database into the browser bundle. Kept in sync by hand, deliberately.
- **`EMPTY_RESULTS` is a frozen module-level constant**, shared across every empty-query call
  for the life of a warm lambda. It is frozen two levels deep on purpose: an unfrozen shared
  object would let one future `results.titles.push(...)` corrupt every org's "no results"
  response.
- **`games.description` is matched but not advertised** (§4 lists it as a match target). It is
  written only for blobs OpenRetro recognises — a handful of rows today — so it ships as a
  quiet bonus that improves as enrichment lands, not as a promise.

### D-5-3 in practice

The migration is applied to the live database as of 2026-09-02: `pg_trgm` installed,
`games_title_trgm_idx` and `games_publisher_trgm_idx` created. §5's honest note stands
unchanged — at this size Postgres will choose a sequential scan regardless. It is here so
that adding it later is not a migration run during a performance problem.

### §8's second guard is not observable from an e2e test, and that is a finding

§8 specifies aborting the in-flight request. Implementation added a second guard behind it —
each landing response is compared against `currentQueryRef`, the trimmed query as of the most
recent keystroke, held outside React state so the fetch callback can read it synchronously —
because aborting is not instantaneous and a response can already be queued when `abort()` is
called.

**The first guard makes the second untestable from outside the browser.** Once the page
aborts, Chromium emits `requestfailed` with `net::ERR_ABORTED` and **never a `response`
event**. `route.fulfill()` still resolves, but into a dead request. So a Playwright test
cannot deliver a stale answer to the client at all while the abort works, and
`page.waitForResponse` on the superseded URL can only ever time out — which is exactly how it
was first written, and it hung for the full 30-second timeout.

`e2e/search.spec.ts` therefore asserts the abort **directly**, on its failure reason, raced
against the response so the mutation is fast and self-describing: delete the
`AbortController` and the test fails in 8 s with `responded:200` instead of
`failed:net::ERR_ABORTED`. **That mutation was run.** `currentQueryRef` is deliberately
uncovered: it defends a sub-millisecond window that cannot be forced open from outside the
browser, and this repo has no React component-test infrastructure (vitest is node-only, no
testing-library) in which it could be. Adding that infrastructure for one guard was judged
out of scope; the guard stays because it is cheap and correct, not because a test demands it.

### Three other tests passed while proving nothing

- **The out-of-order test raced nothing** before the above was even reached: two `fill()`
  calls inside the 150 ms debounce cleared the first timer before it fired, so the held route
  was never hit. It now waits for the debounced request to actually be **sent**
  (`waitForRequest`) before typing the next query. Its fixture was also one the *fresh* answer
  matched — "gia" is a substring of "giana" — so stale and fresh could share a top row and the
  assertion could not fail however broken the guard was. There is now a distinct fixture and
  an unmistakable `STALE ROW` body, asserted absent from the whole panel.
- **The empty-state test asserted a line that rendered before any request was made**, so a
  completely broken `/api/search` would have satisfied it. It now holds the response and
  asserts `search-empty` is absent while the request is genuinely in flight. The response
  listener is armed *before* the gate is released — otherwise `route.fulfill`'s promise chain
  can complete before an `await` started afterwards begins listening, and the event is missed.
- **The ranking test's fixture would have satisfied the assertion for the wrong reason.**
  `Turrican II` sorts after `Rainbow Islands` alphabetically, so deleting the
  `CASE WHEN … THEN 0 ELSE 1` clause and falling back to `ORDER BY sort_title` alone would
  still have passed. The attribute-only match is now `Apidya`, which sorts *first*.
- **`contrast.spec.ts`'s `probe()` measured the wrong pixels.** It walked outward for the
  first background with alpha > 0.5 and skipped translucent layers entirely, so for the search
  panel's highlighted row it measured the **plain** panel underneath — a higher, wrong ratio
  for exactly the row a bug is most likely to ship on, since highlight defaults to index 0. It
  now collects every layer out to the opaque backstop and composites them back-to-front with
  the standard "over" operator.

The pattern, stated once so it need not be rediscovered: **a typeahead test that does not
force the race window open is not testing the race**, a fixture that would satisfy the
assertion for the wrong reason is not a fixture, and an assertion nobody has watched fail is
not yet a test.
