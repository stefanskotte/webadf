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

### 3.5 `collection_games` is never touched

`collections` carries `orgId`, so `orgFilter` covers it. `collection_games` deliberately has **no**
`orgId` (D-4-5) and is reachable only through a collection. This increment matches collection
*names* only, so it never queries that table. If a later change wants a member count in the result
row, it must scope through `collections`, not by collection id alone.

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
