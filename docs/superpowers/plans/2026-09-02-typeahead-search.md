# Typeahead Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Spotlight-style search pill in the shell header that finds a title by any fragment of its name, publisher, genre or description — or a collection by name — and takes you there with the keyboard.

**Architecture:** One org-scoped `GET /api/search` returning two result groups, driven by a client component that debounces and **aborts** in flight. Matching is `ILIKE '%q%'`; ranking (name-match before attribute-match) is done in SQL so a `LIMIT` can never truncate a name match away. Search navigates, it never filters the library grid.

**Tech Stack:** Next.js 16.3.2 (App Router) · React 19.2 · Tailwind 4 · Drizzle 0.45 · Postgres (Neon HTTP) · `pg_trgm` · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-09-02-typeahead-search-design.md` — **§3 is why this plan is shaped the way it is; read it before Task 3.**

## Global Constraints

- **`orgFilter()` (`src/db/scope.ts`) is the only way to scope a catalog query.** It throws on an empty org id. Every query here goes through it.
- **`disks.orgId` can diverge from its game's org** (D-5-5). Nothing in the schema prevents it; only the write path keeps it true. **Any join to `disks` must carry `eq(disks.orgId, orgId)` as well as the `gameId` predicate.** This is the one mistake in this increment that fails silently.
- **Cross-tenant access returns nothing, never a distinguishing status** (D-5-6). Titles are not digests; D13's global oracle covers `/api/ingest/check` only.
- **`db.transaction()` THROWS on neon-http.** `db.batch()` is the atomic primitive; concurrent reads use `Promise.all`. `getDb().execute()` returns `{ rows }`, never an array.
- **A non-unique `ORDER BY` paired with `LIMIT` is a known bug class here** (`adminListUsers`, `mergeDuplicates`). Every ordering ends in `id`.
- Next 16: `params`/`searchParams`/`cookies()`/`headers()` are Promises. `PageProps`/`RouteContext` are ambient — **never import them**.
- **shadcn v4 here is `@base-ui/react`, not Radix.**
- **`--accent-amber` (`#f5822e`) is fill-only** and fails WCAG AA as text; amber text is `--amber-text`. The grey ramp (`--muted` `#4c5966`, `--muted-2` `#5f6874`, `--faint` `#666d75`) is contrast-checked — **do not lighten it**.
- **A panel over the page gradient uses `--glass-strong` (0.80), not `--glass`.** The auth panel and this one both float over a gradient whose top stop is `#1b2534`; only the stronger fill keeps `--ink` above 10:1. See `e2e/contrast.spec.ts`.
- Every e2e spec cleans up what it seeds. The suite runs **`workers: 1`** against a live database; `signUpFresh` registers its org and `cleanupSeeded` purges it.
- Run `pnpm vitest run`, `pnpm build` and the affected e2e before each commit. **3 pre-existing lint errors are the baseline; add none.**

### Two deliberate deviations from the spec, decided while planning

1. **Ranking is done in SQL, not in TypeScript.** §9 lists the ranking rule under Vitest. Ranking in JS would mean fetching N candidates ordered by `sortTitle` and re-sorting them, so a `LIMIT` could truncate away the very name-match that should have ranked first. `ORDER BY (CASE WHEN title ILIKE … THEN 0 ELSE 1 END), sort_title, id` is correct at any size. Ranking is therefore covered by the Playwright test in Task 6, not by Vitest.
2. **`q` is not lowercased.** §4 says trimmed, lowercased, capped. `ILIKE` is already case-insensitive, so lowercasing changes no result and only invites the reader to think matching is case-sensitive somewhere. Trim, collapse whitespace, cap, escape — no case change.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/search-query.ts` | **Create.** Pure: normalise raw input, escape LIKE metacharacters, build the pattern. No database. |
| `src/lib/search-query.test.ts` | **Create.** |
| `drizzle/0012_<generated>.sql` | **Create** via `drizzle-kit generate --custom`. `CREATE EXTENSION pg_trgm` + two GIN indexes. |
| `src/lib/search.ts` | **Create.** The two org-scoped queries and the result types. |
| `src/app/api/search/route.ts` | **Create.** `GET`, `requireOrg`, returns `{ titles, collections }`. |
| `src/components/shell/search-box.tsx` | **Create.** Client: the pill, the panel, debounce, abort, keyboard. |
| `src/app/(app)/layout.tsx` | **Modify.** Render `<SearchBox />` between `<TopNav />` and `<SignOutButton />`. |
| `src/app/(admin)/layout.tsx` | **Modify.** Same. |
| `e2e/search.spec.ts` | **Create.** |

---

### Task 1: Normalising and escaping the query

**Files:**
- Create: `src/lib/search-query.ts`
- Test: `src/lib/search-query.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_QUERY_LEN: number`, `normalizeQuery(raw: string): string`, `escapeLike(s: string): string`, `likePattern(raw: string): string | null`.

- [ ] **Step 1: Write the failing test**

`src/lib/search-query.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeQuery, escapeLike, likePattern, MAX_QUERY_LEN } from './search-query';

describe('normalizeQuery', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeQuery('  giana   sisters ')).toBe('giana sisters');
  });

  it('caps length so one request cannot carry an essay', () => {
    expect(normalizeQuery('x'.repeat(500))).toHaveLength(MAX_QUERY_LEN);
  });

  it('does NOT change case -- ILIKE is case-insensitive and pretending otherwise misleads', () => {
    expect(normalizeQuery('Giana')).toBe('Giana');
  });

  it('reduces a whitespace-only query to empty', () => {
    expect(normalizeQuery('   \t \n ')).toBe('');
  });
});

describe('escapeLike', () => {
  // Not a tenancy control -- orgFilter is a separate conjunct and a wildcard
  // cannot cross an org boundary. This stops ONE keystroke matching the
  // caller's whole library on an endpoint fired per character.
  it('escapes the LIKE metacharacters', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes the escape character FIRST, or the escapes get double-escaped', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Giana Sisters - Special Edition')).toBe('Giana Sisters - Special Edition');
  });
});

describe('likePattern', () => {
  it('wraps an escaped query in infix wildcards', () => {
    expect(likePattern('sisters')).toBe('%sisters%');
  });

  it('returns null for an empty query, so the caller can skip the database', () => {
    expect(likePattern('')).toBeNull();
    expect(likePattern('   ')).toBeNull();
  });

  it('a query that is only wildcards still cannot match everything', () => {
    expect(likePattern('%')).toBe('%\\%%');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/search-query.test.ts`
Expected: FAIL — `Failed to resolve import "./search-query"`.

- [ ] **Step 3: Write the implementation**

`src/lib/search-query.ts`:

```ts
/**
 * Turning a keystroke into a SQL pattern, with no database in sight.
 *
 * Separate from search.ts so the rules are testable without a connection --
 * Vitest has no DATABASE_URL and never opens one.
 */

/** Long enough for any real title, short enough that one request stays small. */
export const MAX_QUERY_LEN = 100;

/**
 * Trim, collapse runs of whitespace, cap the length.
 *
 * Deliberately does NOT change case: the predicate uses ILIKE, which is
 * already case-insensitive, and lowercasing here would imply case matters
 * somewhere that it does not.
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LEN);
}

/**
 * Escape the three characters LIKE treats as special.
 *
 * The backslash MUST be escaped first. Escaping `%` first would turn `\` into
 * `\\` afterwards and double-escape the escapes this function just added.
 *
 * This is not a tenancy control -- orgFilter() is a separate conjunct and no
 * wildcard can cross an org boundary. It exists because a single unescaped
 * `%` makes every keystroke match the caller's entire library, which is the
 * wrong shape for an endpoint fired once per character.
 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * The infix pattern for a raw query, or null when there is nothing to search.
 *
 * null is the caller's signal to return empty results WITHOUT querying: an
 * empty query would otherwise become '%%' and match every row the caller owns.
 */
export function likePattern(raw: string): string | null {
  const q = normalizeQuery(raw);
  if (q === '') return null;
  return `%${escapeLike(q)}%`;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run src/lib/search-query.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the escaping with a mutation**

Delete the `.replace(/\\/g, '\\\\')` clause, re-run, and confirm **"escapes the escape character FIRST"** fails by name. Restore it.

- [ ] **Step 6: Commit**

```bash
pnpm vitest run && pnpm build && pnpm lint
git add src/lib/search-query.ts src/lib/search-query.test.ts
git commit -m "Turn a keystroke into a SQL pattern, safely"
```

---

### Task 2: The migration — `pg_trgm` and the trigram indexes

**Files:**
- Create: `drizzle/0012_<generated name>.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: the `pg_trgm` extension and two GIN indexes. No TypeScript.

**Read §5 of the spec first.** At 9 rows this index buys nothing measurable; it ships now so that adding it later is not a migration run during a performance problem.

- [ ] **Step 1: Generate an empty custom migration**

```bash
npx drizzle-kit generate --custom --name=search_trgm
```

This writes `drizzle/0012_search_trgm.sql` (empty) and appends an entry to `drizzle/meta/_journal.json`. `drizzle-kit generate` alone cannot produce this: an extension is not derivable from the schema files.

- [ ] **Step 2: Write the SQL**

Into `drizzle/0012_search_trgm.sql`:

```sql
-- Infix search (D-5-2): ILIKE '%foo%' cannot use games_org_sort_idx, which is
-- a btree on (org_id, sort_title). A GIN trigram index can.
--
-- HONEST NOTE (spec section 5): at the current size -- 9 games, and 61 disks in
-- the operator's full archive -- Postgres will very likely choose a sequential
-- scan regardless, and it will be instant. This is here so that adding it is
-- not a migration run during a future performance problem, not because it
-- speeds anything up today.
--
-- Additive: no table is altered and no row moves.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS games_title_trgm_idx
  ON games USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS games_publisher_trgm_idx
  ON games USING gin (publisher gin_trgm_ops);
```

- [ ] **Step 3: Verify it is additive before anyone runs it**

```bash
grep -iE "drop|alter table|delete|truncate" drizzle/0012_search_trgm.sql
```

Expected: no output. If anything matches, stop — this migration must only add.

- [ ] **Step 4: STOP. This is a controller checkpoint, not an implementer action.**

**Do not apply this yourself, and do not run `pnpm db:push`.** `db:push` diffs the schema files and would not create the extension anyway. The live database is also the e2e database; Task 6 cannot pass until this is applied. Hand back to the controller, who applies it after review and confirms with:

```sql
select count(*)::int from pg_extension where extname = 'pg_trgm';   -- expect 1
select indexname from pg_indexes where tablename = 'games';         -- expect the two new names
```

- [ ] **Step 5: Commit**

```bash
git add drizzle/0012_search_trgm.sql drizzle/meta/_journal.json
git commit -m "Add pg_trgm and trigram indexes for infix title search"
```

---

### Task 3: The queries

**Files:**
- Create: `src/lib/search.ts`

**Interfaces:**
- Consumes: `likePattern` from `src/lib/search-query.ts`.
- Produces:
  - `interface SearchTitle { id: string; title: string; year: number | null; publisher: string | null; diskCount: number }`
  - `interface SearchCollectionHit { id: string; name: string; gameCount: number }`
  - `interface SearchResults { titles: SearchTitle[]; collections: SearchCollectionHit[] }`
  - `async function search(orgId: string, raw: string): Promise<SearchResults>`
  - `const TITLE_LIMIT = 8`, `const COLLECTION_LIMIT = 4`

**This is the task §3 of the spec is about. Read it.**

- [ ] **Step 1: Write the implementation**

`src/lib/search.ts`:

```ts
// Everything the typeahead reads, and the only place tenancy is decided for it.
//
// A search endpoint is the widest read surface in this app: fired on every
// keystroke, free text, reaching four tables. Three rules keep it safe and
// only the first is obvious (spec section 3):
//
//  1. orgFilter() scopes every query and THROWS on an empty org id.
//  2. disks.orgId can diverge from its game's org -- nothing in the schema
//     prevents it -- so the disks join carries orgId as well as gameId. A join
//     on gameId alone would still return the right org's games, with another
//     tenant's disk counted in them. That is the failure that would be silent.
//  3. Global content-addressed tables are never matched first and joined back.
//     This file does not touch blobs, tosec_entries or openretro_images at all.
//
// collection_games is never queried: it has no org_id by design (D-4-5) and
// only collection NAMES are matched here.

import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { collections } from '@/db/schema/collections';
import { orgFilter } from '@/db/scope';
import { likePattern } from '@/lib/search-query';

/** Enough to choose from, few enough that the panel never scrolls. */
export const TITLE_LIMIT = 8;
export const COLLECTION_LIMIT = 4;

export interface SearchTitle {
  id: string; title: string; year: number | null; publisher: string | null; diskCount: number;
}
export interface SearchCollectionHit { id: string; name: string; gameCount: number }
export interface SearchResults { titles: SearchTitle[]; collections: SearchCollectionHit[] }

export const EMPTY_RESULTS: SearchResults = { titles: [], collections: [] };

export async function search(orgId: string, raw: string): Promise<SearchResults> {
  const pattern = likePattern(raw);
  // No pattern means nothing to search. Return without a round trip: '%%'
  // would match every row this caller owns, on every empty keystroke.
  if (pattern === null) return EMPTY_RESULTS;

  const db = getDb();

  const [titles, collectionHits] = await Promise.all([
    db
      .select({
        id: games.id,
        title: games.title,
        year: games.year,
        publisher: games.publisher,
        diskCount: sql<number>`count(${disks.id})::int`,
      })
      .from(games)
      // BOTH predicates, deliberately. disks.orgId is an independent column
      // and admin-delete.ts documents its drift from a game's org as real, so
      // eq(disks.gameId, games.id) alone would let another tenant's disk be
      // counted into this org's result. listGames and withDerived scope this
      // join the same way and for the same reason.
      .leftJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
      .where(orgFilter(games, orgId, or(
        ilike(games.title, pattern),
        ilike(games.publisher, pattern),
        ilike(games.genre, pattern),
        // Matched, but never advertised: description is written only for
        // blobs OpenRetro recognises -- 2 of 9 rows today. It costs nothing
        // here and improves on its own as enrichment lands.
        ilike(games.description, pattern),
      )))
      .groupBy(games.id)
      // Ranking lives in SQL, not in TypeScript, so the LIMIT can never
      // truncate away the very name-match that should have ranked first --
      // which is exactly what fetching N by sort_title and re-sorting in JS
      // would do. The trailing id is not decoration: a non-unique ORDER BY
      // with a LIMIT has already produced two bugs in this codebase.
      .orderBy(sql`(case when ${games.title} ilike ${pattern} then 0 else 1 end)`,
               asc(games.sortTitle), asc(games.id))
      .limit(TITLE_LIMIT),

    db
      .select({
        id: collections.id,
        name: collections.name,
        gameCount: sql<number>`(
          select count(*)::int from collection_games
          where collection_games.collection_id = ${collections.id}
        )`,
      })
      .from(collections)
      .where(orgFilter(collections, orgId, ilike(collections.name, pattern)))
      .orderBy(asc(collections.name), asc(collections.id))
      .limit(COLLECTION_LIMIT),
  ]);

  return { titles, collections: collectionHits };
}
```

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit && pnpm build`
Expected: clean. Vitest cannot cover this file — it opens a database connection, and Vitest has no `DATABASE_URL`. Task 6 is its test.

- [ ] **Step 3: Prove the ILIKE escape reaches Postgres correctly**

`ilike()` binds `pattern` as a parameter, so the `\%` produced by Task 1 arrives literally. Confirm by hand against the dev server once Task 4 exists — Task 6 Step 1 test 10 automates it.

- [ ] **Step 4: Commit**

```bash
pnpm vitest run && pnpm build && pnpm lint
git add src/lib/search.ts
git commit -m "Search titles and collections, scoped to one org"
```

---

### Task 4: The route

**Files:**
- Create: `src/app/api/search/route.ts`

**Interfaces:**
- Consumes: `search`, `EMPTY_RESULTS` from `src/lib/search.ts`.
- Produces: `GET /api/search?q=<string>` → `200 {titles, collections}`.

- [ ] **Step 1: Write the route**

```ts
import { requireOrg } from '@/lib/session';
import { search, EMPTY_RESULTS } from '@/lib/search';

export const maxDuration = 60;

/**
 * Fired on every keystroke, so it does the least it can: one org id from the
 * session, one query, one shape of answer.
 *
 * There is no 404 and no error that distinguishes "you have no such title"
 * from "that title belongs to someone else" -- both are an empty array with a
 * 200 (D-5-6). /api/ingest/check is a deliberate global existence oracle on
 * DIGESTS (D13); titles are not digests and no equivalent decision covers
 * them, so this one is scoped and says nothing.
 */
export async function GET(request: Request) {
  const { orgId } = await requireOrg();

  const q = new URL(request.url).searchParams.get('q');
  if (q === null) return Response.json(EMPTY_RESULTS);

  return Response.json(await search(orgId, q));
}
```

- [ ] **Step 2: Verify by hand against the dev server**

With `pnpm dev` running and a signed-in browser session, in the browser console:

```js
await (await fetch('/api/search?q=' + encodeURIComponent('a'))).json()
```

Expected: `{titles: [...], collections: [...]}`. Then `?q=` (empty) → both arrays empty. Then `?q=%25` (a literal `%`) → empty, **not** your whole library.

- [ ] **Step 3: Commit**

```bash
pnpm vitest run && pnpm build && pnpm lint
git add src/app/api/search/route.ts
git commit -m "Answer a search with nothing when it is not yours"
```

---

### Task 5: The pill, the panel, and the keyboard

**Files:**
- Create: `src/components/shell/search-box.tsx`
- Modify: `src/app/(app)/layout.tsx`, `src/app/(admin)/layout.tsx`

**Interfaces:**
- Consumes: `GET /api/search`; the `SearchTitle` / `SearchCollectionHit` shapes from Task 3 (redeclared locally — this is a client file and must not import from a module that reaches `@/db`).
- Produces: `<SearchBox />`, default export none. Testids: `search-input`, `search-panel`, `search-result` with `data-result-kind` (`title` | `collection`) and `data-result-id`, `search-empty`.

- [ ] **Step 1: Write the component**

`src/components/shell/search-box.tsx`, `'use client'`:

Requirements, each of which Task 6 tests:

- **Debounce 150 ms AND abort the in-flight request.** Keep an `AbortController` in a ref; every keystroke aborts the previous fetch before starting the next. Additionally discard any response whose query no longer equals the current input — abort is not instantaneous and a response can still land.
- A `useEffect` cleanup aborts on unmount.
- `⌘K` / `Ctrl+K` and `/` focus the input from anywhere. **The `/` handler must ignore the event when `document.activeElement` is an `input`, `textarea`, or `[contenteditable]`**, or it steals the key from the collection rename field and the create-collection input.
- `↑` / `↓` move a single highlight across both groups as one flat list; `Enter` navigates via `router.push`; `Escape` clears the panel and blurs.
- The highlight resets to index 0 on every new result set.
- Errors render one line inside the panel. **No toast** (D-5-8) — a toast per failed keystroke is its own denial of service.

- **The empty state.** When a non-empty query returns nothing, render one line —
  `No titles match "foo"` — under `data-testid="search-empty"`. An empty query renders no panel at
  all, which is a different thing and must not show that line.

**The debounce and the abort, in full, because this is where the bug lives:**

```tsx
const [q, setQ] = useState('');
const [results, setResults] = useState<SearchResults>({ titles: [], collections: [] });
const [highlight, setHighlight] = useState(0);
const abortRef = useRef<AbortController | null>(null);

useEffect(() => {
  const query = q.trim();
  if (query === '') {
    abortRef.current?.abort();
    setResults({ titles: [], collections: [] });
    return;
  }

  const timer = setTimeout(async () => {
    // Abort the PREVIOUS request, not this one. Without this a fast typist
    // has several in flight at once and they resolve in arrival order, not
    // in the order they were sent.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`,
                              { signal: controller.signal });
      if (!res.ok) { setError('Search is unavailable'); return; }
      const body = (await res.json()) as SearchResults;
      // Belt and braces over the abort: aborting is not instantaneous, and a
      // response for an older query can still land after a newer one. Compare
      // against the CURRENT input and drop anything that no longer matches.
      if (controller.signal.aborted) return;
      setResults(body);
      setHighlight(0);          // Enter right after typing always opens the top row
      setError(null);
    } catch (e) {
      // An abort is the normal path here, not a failure -- never surface it.
      if ((e as Error).name !== 'AbortError') setError('Could not reach the server');
    }
  }, 150);

  return () => clearTimeout(timer);
}, [q]);

// Unmounting mid-flight must not leave a fetch running against a dead component.
useEffect(() => () => abortRef.current?.abort(), []);
```

Styling, matching `top-nav.tsx` and the auth panel:

```tsx
// The pill: same fill and hairline as TopNav so the two read as one group.
<div className="relative">
  <input
    data-testid="search-input"
    placeholder="Search titles"
    className="h-[34px] w-56 rounded-full border px-4 text-[13px] outline-none transition-colors"
    style={{
      background: 'rgb(255 255 255 / 0.12)',
      borderColor: 'rgb(255 255 255 / 0.16)',
      color: 'var(--on-dark)',
    }}
  />
  {/* The panel floats over the page gradient, so --glass-strong (0.80), not
      --glass (0.62): at 0.62 over --grad-top the --ink rows fall under AA.
      e2e/contrast.spec.ts measures exactly this class of mistake. */}
  <div
    data-testid="search-panel"
    className="absolute right-0 top-[42px] z-50 w-80 rounded-xl border p-1.5"
    style={{
      background: 'var(--glass-strong)',
      borderColor: 'var(--hairline-strong)',
      boxShadow: 'var(--shadow-card)',
      backdropFilter: 'blur(12px)',
    }}
  >
    {/* group label */}
    <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.09em]"
         style={{ color: 'var(--faint)' }}>Titles</div>
    {/* a row */}
    <button
      data-testid="search-result"
      data-result-kind="title"
      data-result-id={t.id}
      className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left"
      style={highlighted ? { background: 'rgb(30 45 60 / 0.08)' } : undefined}
    >
      <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{t.title}</span>
      <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
        {[t.year, t.publisher, `${t.diskCount} disk${t.diskCount === 1 ? '' : 's'}`]
          .filter(Boolean).join(' · ')}
      </span>
    </button>
  </div>
</div>
```

Selecting a title → `/games/<id>`. Selecting a collection → `/library?collection=<id>`.

- [ ] **Step 2: Wire it into both layouts**

In `src/app/(app)/layout.tsx` and `src/app/(admin)/layout.tsx`, between `<TopNav … />` and the right-hand group:

```tsx
<SearchBox />
```

`TopNav`'s `nav` carries `mx-auto`, which absorbs the free space — so the brand stays left and the search sits immediately left of the sign-out group. Nothing else in the header changes.

- [ ] **Step 3: Verify in a real browser**

`pnpm dev`, sign in, then check by hand: typing shows results; `↑`/`↓` move the highlight; `Enter` navigates; `Escape` closes; `⌘K` focuses; **typing `/` inside the collection "New collection" input types a slash and does not jump focus.**

**Do not skip this.** The collections increment shipped three defects that build and Vitest could not see (HANDOFF 3g), all of them in drag and keyboard behaviour.

- [ ] **Step 4: Commit**

```bash
pnpm vitest run && pnpm build && pnpm lint
git add src/components/shell/search-box.tsx "src/app/(app)/layout.tsx" "src/app/(admin)/layout.tsx"
git commit -m "Add the search pill, its panel and its keyboard"
```

---

### Task 6: End-to-end tests

**Files:**
- Create: `e2e/search.spec.ts`

**Read `e2e/collections.spec.ts` first** — it has the two-org pattern, `expect.poll`, and the `signUpFresh`/`cleanupSeeded` contract this file needs.

- [ ] **Step 1: Write the specs**

Cover, with `test.afterAll(cleanupSeeded)`:

1. **Typing finds a title, `Enter` opens it.** Assert the URL becomes `/games/<id>`.
2. **A middle-of-string fragment matches.** Seed "Giana Sisters - Special Edition", type `sisters`, assert it appears. This is D-5-2 and the whole reason for Task 2.
3. **An attribute match works and ranks BELOW a name match.** Seed one game titled `Rainbow Islands` and another titled `Turrican II` with `publisher: 'Rainbow Arts'` (update the row directly via Drizzle — `seedDisk` sets no publisher). Type `rainbow`; assert both appear and that the **first** `search-result` is `Rainbow Islands`.
4. **A collection result navigates to `?collection=<id>`.**
5. **`Escape` closes the panel; `⌘K` focuses the input.**
6. **`/` does not hijack typing in another input.** Focus the collection-create input, press `/`, assert its value contains `/` and `search-input` is not focused.
7. **Out-of-order responses do not win.** The classic typeahead bug, and the one most worth a test:

```ts
// Hold the response for "gia" until after "giana" has been typed and answered.
await page.route('**/api/search?q=gia', async (route) => {
  await new Promise((r) => setTimeout(r, 1200));
  await route.continue();
});
await page.getByTestId('search-input').fill('gia');
await page.getByTestId('search-input').fill('giana');
// The slow answer for the shorter query must never replace the newer one.
await expect(page.getByTestId('search-result').first()).toContainText('Giana');
await page.waitForTimeout(1500);
await expect(page.getByTestId('search-result').first()).toContainText('Giana');
```

8. **The empty state says so.** A query matching nothing renders `search-empty`; an EMPTY query
   renders no panel and no `search-empty`.
9. **Cross-tenant returns nothing.** Two browser contexts. Org B searches org A's **exact** title; assert `200`, `titles: []`, and that the response is byte-identical in shape to a genuine miss.
10. **A lone `%` matches nothing.** `GET /api/search?q=%25` returns empty rather than the caller's whole library.
11. **Defence in depth: a drifted disk is neither surfaced nor counted.** Seed a game in org A, then set that disk's `org_id` to org B directly via Drizzle. Assert org B's search for the title returns nothing, **and** that org A's result reports `diskCount: 0` rather than counting a disk that now claims to belong elsewhere. `game-detail.spec.ts` has the sibling of this test for the disk list.

- [ ] **Step 2: Run everything**

```bash
pnpm vitest run && pnpm build && pnpm e2e
```

Report the counts. The suite runs `workers: 1` and takes ~20 minutes.

- [ ] **Step 3: Commit**

```bash
git add e2e/search.spec.ts
git commit -m "Cover search end to end, including tenancy and stale responses"
```

---

### Task 7: Documentation

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/specs/2026-09-02-typeahead-search-design.md`

- [ ] **Step 1: Record it**

Add a `### 3h. Typeahead search` section to `HANDOFF.md`, matching `3f`/`3g`'s voice. It must state prominently:

- **`disks.orgId` can diverge from its game's org, so a join on `gameId` alone is not scoped** (D-5-5). This is now the third place that rule is load-bearing — `listGames`, `withDerived`, and search — so say that the rule is the point, not the site.
- Ranking is in SQL so a `LIMIT` cannot truncate a name match away.
- The endpoint is not an existence oracle; D13 covers digests only.
- `pg_trgm` is now installed, and honestly: it buys nothing at current scale.
- Debounce alone is not enough; the abort is what stops stale results winning.

Update the status table. Mark the "Typeahead search with debounce" backlog entry done.

- [ ] **Step 2: Mark the spec delivered**

Add a "What this increment delivered" section, including the two planning deviations recorded in this plan's Global Constraints (SQL ranking; no lowercasing) and anything else that changed shape during implementation.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md docs/superpowers/specs/2026-09-02-typeahead-search-design.md
git commit -m "Record typeahead search as delivered"
```

---

## Done when

- `pnpm vitest run` green, `pnpm e2e` green, `pnpm build` clean, lint no worse than baseline.
- **Typing a middle-of-string fragment was observed to find a title** — "sisters" finds "Giana Sisters".
- **A stale response was observed losing to a newer one**, driven by a delayed route.
- **Org B was observed getting an empty result for org A's exact title**, with no status or body difference from a genuine miss.
- **A disk whose `org_id` drifted was observed being neither surfaced nor counted.**
- `/` was observed typing a slash into the collection-create input rather than stealing focus.
