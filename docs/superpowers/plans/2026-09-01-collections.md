# User-Defined Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person make their own categories, drag games into them, and reorder both the games inside a collection and the collections themselves.

**Architecture:** Two per-tenant tables (`collections`, `collection_games`) and a collections rail added beside the *existing* library grid and table, which are reused rather than rebuilt. Ordering is an integer `sortKey` rewritten wholesale on each move. The one genuinely hard part is not the UI: `mergeDuplicates` in `src/lib/tosec-apply.ts` DELETES `games` rows, so membership rows must join its repointing batch or a TOSEC scan silently destroys hand-made collections.

**Tech Stack:** Next.js 16.3.2 (App Router, Server Components) · React 19.2 · Tailwind 4 · shadcn v4 (**Base UI, not Radix**) · Drizzle 0.45 · Postgres (Neon HTTP) · **`@dnd-kit/core` + `@dnd-kit/sortable` (new dependency)** · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-09-01-collections-design.md` — **§3 is the reason this plan is shaped the way it is; read it before Task 3.**

## Global Constraints

- **A collection is human-authored and cannot be recomputed.** Every other grouping in this app derives from disk content; losing a collection is losing work nobody can regenerate. That is why §3's merge integration is the highest-value task here, not the UI.
- **`mergeDuplicates` must delete-then-update, in that order** (D-4-1). A collection holding both the survivor and the absorbed game makes a bare repoint violate the primary key, and `db.batch()` is atomic, so the whole merge aborts and the sweeper hot-loops.
- **A reorder can NEVER change membership** (D-4-4). Unknown ids, duplicates and omissions are all rejected.
- **`collection_games` carries no `orgId`** (D-4-5). It is reachable only through a collection; every query scopes through `collections`.
- **`db.transaction()` THROWS on neon-http**; `db.batch()` is the atomic primitive. `getDb().execute()` returns `{ rows }`, never an array.
- **Every catalog query goes through `orgFilter()`** (`src/db/scope.ts`), which throws on an empty org id. Cross-tenant access answers **404, never 403**.
- **Vitest never opens a database connection** and has no `DATABASE_URL`. Pure logic → Vitest; anything touching Postgres or a page → Playwright.
- Next 16: `params`/`searchParams`/`cookies()`/`headers()` are Promises. `PageProps`/`RouteContext` are ambient — **never import them**.
- **shadcn v4 here is `@base-ui/react`, not Radix.**
- **`--accent-amber` (`#f5822e`) is fill-only** and fails WCAG AA as text; amber text is `--amber-text`. The grey ramp (`--muted` `#4c5966`, `--muted-2` `#5f6874`, `--faint` `#666d75`) is contrast-checked — **do not lighten it**.
- Every e2e spec cleans up what it seeded. The suite runs **`workers: 1`** against a live database; `e2e/global-teardown.ts` sweeps `@example.test` accounts afterwards.
- Run `pnpm vitest run`, `pnpm build` and the affected e2e before each commit. **3 pre-existing lint errors are the baseline; add none.**

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/collection-order.ts` | **Create.** Pure: validate a submitted id list against current membership, and produce the new `sortKey` assignments. |
| `src/lib/collection-order.test.ts` | **Create.** |
| `src/db/schema/collections.ts` | **Create.** `collections`, `collectionGames`. |
| `src/db/index.ts` | **Modify.** Register the schema. |
| `src/lib/collections.ts` | **Create.** All database access for collections: list, create, rename, delete, add, remove, reorder. |
| `src/lib/tosec-apply.ts` | **Modify.** `mergeDuplicates` gains the two membership statements. **The critical change.** |
| `src/lib/admin-delete.ts` | **Modify.** `deleteUserCascade` gains `collections`. |
| `src/lib/queries.ts` | **Modify.** `listGames` accepts an optional `collectionId` filter. |
| `src/app/api/collections/route.ts` | **Create.** `POST` create. |
| `src/app/api/collections/order/route.ts` | **Create.** `PATCH` reorder collections. |
| `src/app/api/collections/[id]/route.ts` | **Create.** `PATCH` rename, `DELETE`. |
| `src/app/api/collections/[id]/games/route.ts` | **Create.** `POST` add. |
| `src/app/api/collections/[id]/games/[gameId]/route.ts` | **Create.** `DELETE` remove. |
| `src/app/api/collections/[id]/order/route.ts` | **Create.** `PATCH` reorder games. |
| `src/app/(app)/library/page.tsx` | **Modify.** Read `?collection=`, load collections, render the rail. |
| `src/components/collections/collection-rail.tsx` | **Create.** Client: the sortable rail and drop targets. |
| `src/components/collections/collection-provider.tsx` | **Create.** Client: the `DndContext` wrapping rail and grid. |
| `src/components/library/game-grid.tsx` | **Modify.** Cards become draggable; sortable when filtered. |
| `e2e/collections.spec.ts` | **Create.** |

---

### Task 1: The ordering rule, in isolation

**Files:**
- Create: `src/lib/collection-order.ts`, `src/lib/collection-order.test.ts`

**Interfaces:**
- Produces:

```ts
export type ReorderError =
  | { ok: false; reason: 'unknown-id'; id: string }
  | { ok: false; reason: 'duplicate-id'; id: string }
  | { ok: false; reason: 'missing-id'; id: string };
export type ReorderResult =
  | { ok: true; assignments: Array<{ id: string; sortKey: number }> }
  | ReorderError;

export function planReorder(current: string[], submitted: string[]): ReorderResult;
```

This is the whole of D-4-4, expressed as a pure function so the rule is tested without a database. Everything the endpoints do with ordering is `planReorder` plus a `db.batch()`.

- [ ] **Step 1: Write the failing test**

`src/lib/collection-order.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planReorder } from './collection-order';

/** Shorthand: assert success and return the assignments. */
function ok(current: string[], submitted: string[]) {
  const r = planReorder(current, submitted);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.assignments;
}

describe('planReorder', () => {
  it('numbers a reordered list from zero, in submitted order', () => {
    expect(ok(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([
      { id: 'c', sortKey: 0 },
      { id: 'a', sortKey: 1 },
      { id: 'b', sortKey: 2 },
    ]);
  });

  it('accepts an unchanged order', () => {
    // Dragging an item and dropping it back where it started is an ordinary
    // gesture; it must not be an error.
    expect(ok(['a', 'b'], ['a', 'b'])).toEqual([
      { id: 'a', sortKey: 0 },
      { id: 'b', sortKey: 1 },
    ]);
  });

  it('handles an empty collection', () => {
    expect(ok([], [])).toEqual([]);
  });

  it('REJECTS an id that is not a member', () => {
    // D-4-4. This is what makes it safe to accept a whole list from a
    // client: a reorder must never be a way to ADD a game.
    expect(planReorder(['a', 'b'], ['a', 'b', 'intruder']))
      .toEqual({ ok: false, reason: 'unknown-id', id: 'intruder' });
  });

  it('REJECTS a duplicated id', () => {
    // Two rows for one game would violate the primary key; catching it here
    // means the batch never runs rather than aborting halfway.
    expect(planReorder(['a', 'b'], ['a', 'a']))
      .toEqual({ ok: false, reason: 'duplicate-id', id: 'a' });
  });

  it('REJECTS a list that omits an existing member', () => {
    // Deliberately strict: treating an omission as a removal would make a
    // dropped element in a client-side drag silently delete a game from a
    // collection, which is unrecoverable work.
    expect(planReorder(['a', 'b', 'c'], ['a', 'b']))
      .toEqual({ ok: false, reason: 'missing-id', id: 'c' });
  });

  it('reports the FIRST offending id, deterministically', () => {
    // So the same bad request always produces the same error, whatever the
    // iteration order of the underlying sets.
    expect(planReorder(['a', 'b'], ['x', 'y']))
      .toEqual({ ok: false, reason: 'unknown-id', id: 'x' });
  });

  it('is not fooled by a list of the right LENGTH with the wrong members', () => {
    // The cheap check -- comparing lengths -- passes here. Only membership
    // comparison catches it.
    expect(planReorder(['a', 'b'], ['a', 'z']))
      .toEqual({ ok: false, reason: 'unknown-id', id: 'z' });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/collection-order.test.ts`
Expected: FAIL — cannot resolve `./collection-order`.

- [ ] **Step 3: Implement**

`src/lib/collection-order.ts`:

```ts
// The rule that makes it safe to accept a whole ordered list from a client.
//
// Reordering sends the COMPLETE list of ids rather than a move instruction,
// which is simple and cheap at this scale (design section 4) but means the
// request could otherwise add, remove or duplicate a member as a side effect
// of "reordering". This function is the guard: the submitted list must be a
// permutation of the current membership, nothing more and nothing less.
//
// Pure, so the rule is tested without a database -- everything the reorder
// endpoints do is this function plus a db.batch().

export type ReorderError =
  | { ok: false; reason: 'unknown-id'; id: string }
  | { ok: false; reason: 'duplicate-id'; id: string }
  | { ok: false; reason: 'missing-id'; id: string };

export type ReorderResult =
  | { ok: true; assignments: Array<{ id: string; sortKey: number }> }
  | ReorderError;

/**
 * @param current   ids currently in the collection, in any order
 * @param submitted the client's desired order
 */
export function planReorder(current: string[], submitted: string[]): ReorderResult {
  const members = new Set(current);
  const seen = new Set<string>();

  for (const id of submitted) {
    if (!members.has(id)) return { ok: false, reason: 'unknown-id', id };
    if (seen.has(id)) return { ok: false, reason: 'duplicate-id', id };
    seen.add(id);
  }

  // Checked AFTER the loop above so an unknown id is reported in preference
  // to a missing one -- an intruder is the more alarming of the two, and a
  // deterministic precedence keeps the same bad request producing the same
  // error every time.
  for (const id of current) {
    if (!seen.has(id)) return { ok: false, reason: 'missing-id', id };
  }

  return {
    ok: true,
    assignments: submitted.map((id, sortKey) => ({ id, sortKey })),
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/collection-order.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/collection-order.ts src/lib/collection-order.test.ts
git commit -m "Add the reorder rule: a submitted list must be a permutation of the membership"
```

---

### Task 2: Schema and migration

**Files:**
- Create: `src/db/schema/collections.ts`
- Modify: `src/db/index.ts`

**Interfaces:**
- Produces: `collections`, `collectionGames`.

- [ ] **Step 1: Create the tables**

`src/db/schema/collections.ts`:

```ts
import { pgTable, text, integer, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { games } from './catalog';

/**
 * PER-TENANT, unlike blobs and tosec_entries which are global because they
 * are content-addressed. A collection is one person's opinion about their
 * library, not a property of any bytes -- and unlike every other grouping in
 * this app it cannot be recomputed from the disks, so losing one is losing
 * work nobody can regenerate.
 */
export const collections = pgTable('collections', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  sortKey: integer('sort_key').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('collections_org_sort_idx').on(t.orgId, t.sortKey)]);

/**
 * Membership. Carries NO org_id: it is reachable only through a collection,
 * which has one, and duplicating the column would invite exactly the drift
 * disks.org_id already causes elsewhere in this codebase (see
 * src/lib/admin-delete.ts). Every query scopes through `collections`.
 */
export const collectionGames = pgTable('collection_games', {
  collectionId: text('collection_id').notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),

  // ON DELETE CASCADE is DELIBERATE and is the opposite of the ruling on
  // disks.game_id, where a cascade destroyed a disk and a destroyed disk is
  // indistinguishable from an eject. Losing a collection entry when its game
  // is genuinely gone is CORRECT. This is a safety net for any future delete
  // path that forgets mergeDuplicates' repointing (design section 3.1); it
  // does not mask that requirement, because within one batch the repointing
  // UPDATE runs before the DELETE and the cascade finds nothing left.
  gameId: text('game_id').notNull()
    .references(() => games.id, { onDelete: 'cascade' }),

  sortKey: integer('sort_key').notNull().default(0),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // A game may be in many collections, never twice in one. This constraint is
  // exactly what makes mergeDuplicates need delete-then-update rather than a
  // bare repoint.
  primaryKey({ columns: [t.collectionId, t.gameId] }),
  index('collection_games_sort_idx').on(t.collectionId, t.sortKey),
  index('collection_games_game_idx').on(t.gameId),
]);
```

- [ ] **Step 2: Register the schema**

In `src/db/index.ts`, add `import * as collections from './schema/collections';` and spread it into the `schema` object beside `...openretro`.

- [ ] **Step 3: Generate the migration — do NOT push**

Run `pnpm db:generate` and **paste the complete SQL into your report**. Do **not** run `pnpm db:push`: it mutates the live database that serves production. The controller reviews the SQL and applies it.

If the SQL contains a `DROP`, or any `ALTER` to an existing table beyond adding the two new tables, say so prominently — this migration should create two tables and nothing else.

- [ ] **Step 4: Commit**

```bash
pnpm vitest run && pnpm build
git add src/db/schema/collections.ts src/db/index.ts drizzle
git commit -m "Add the collections and collection_games tables"
```

---

### Task 3: Survive the merge — the critical task

**Files:**
- Modify: `src/lib/tosec-apply.ts`, `src/lib/admin-delete.ts`

**Interfaces:**
- Consumes: `collectionGames` (Task 2).

**Read `docs/superpowers/specs/2026-09-01-collections-design.md` §3 before writing anything.** This task is the reason the whole increment is more than CRUD.

- [ ] **Step 1: Add the two statements to `mergeDuplicates`**

In `src/lib/tosec-apply.ts`, inside the `for (const gone of absorbed)` loop, **before** the existing `db.delete(games)` statement, add:

```ts
    // Collections are HUMAN-authored and cannot be recomputed, unlike every
    // other grouping in this app. A membership row left pointing at `gone`
    // would be destroyed by the cascade below, silently removing a game from
    // someone's collection with no error and nothing to recover from.
    //
    // TWO statements, and the ORDER MATTERS. If a collection already holds
    // the survivor as well as `gone`, a bare repoint produces two rows with
    // the same (collection_id, game_id) and violates the primary key --
    // which, because db.batch() is atomic, aborts the ENTIRE merge. The
    // sweeper does not stamp a blob whose applyMatch threw, so it would retry
    // that merge on every pass forever. Deleting the would-be duplicates
    // first makes the repoint always legal.
    stmts.push(db.delete(collectionGames).where(and(
      eq(collectionGames.gameId, gone),
      inArray(
        collectionGames.collectionId,
        db.select({ id: collectionGames.collectionId })
          .from(collectionGames)
          .where(eq(collectionGames.gameId, survivor)),
      ),
    )));
    stmts.push(db.update(collectionGames)
      .set({ gameId: survivor })
      .where(eq(collectionGames.gameId, gone)));
```

Add `import { collectionGames } from '@/db/schema/collections';` at the top.

**Note on the subquery:** drizzle supports a select as the argument to `inArray`. If the driver rejects it, fall back to reading the survivor's collection ids with a `db.select()` BEFORE the batch is built — `applyMatch` already performs reads before assembling `stmts`, so that pattern is established in this file. Do not restructure the batch itself.

- [ ] **Step 2: Add collections to the user cascade**

In `src/lib/admin-delete.ts`, inside the `for (const orgId of orgIds)` loop, add alongside the other per-org deletes:

```ts
    // collection_games follows by cascade from collections.id.
    stmts.push(db.delete(collections).where(eq(collections.orgId, orgId)));
```

with the matching import. Place it **before** the `db.delete(games)` statement: both would work (the game cascade would also clear membership), but deleting the collections first means the rows go away for the reason they actually belong to this org, rather than incidentally.

**This also covers the e2e teardown**, because `e2e/global-teardown.ts` calls `deleteUserCascade`. No teardown change is needed.

- [ ] **Step 3: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/tosec-apply.ts src/lib/admin-delete.ts
git commit -m "Repoint collection membership through a TOSEC merge, and delete it with an org"
```

The behaviour here is proved by e2e in Task 8, not by unit tests — both functions need a live database.

---

### Task 4: Collection queries

**Files:**
- Create: `src/lib/collections.ts`
- Modify: `src/lib/queries.ts`

**Interfaces:**
- Consumes: `collections`, `collectionGames` (Task 2), `planReorder` (Task 1), `orgFilter` (`src/db/scope.ts`).
- Produces:

```ts
export interface CollectionListItem { id: string; name: string; sortKey: number; gameCount: number }

export async function listCollections(orgId: string): Promise<CollectionListItem[]>;
export async function createCollection(orgId: string, name: string): Promise<CollectionListItem>;
export async function renameCollection(orgId: string, id: string, name: string): Promise<boolean>;
export async function deleteCollection(orgId: string, id: string): Promise<boolean>;
export async function addGameToCollection(orgId: string, id: string, gameId: string): Promise<boolean>;
export async function removeGameFromCollection(orgId: string, id: string, gameId: string): Promise<boolean>;
export async function reorderCollections(orgId: string, ids: string[]): Promise<ReorderResult>;
/** null means: no such collection for this org. Distinct from a rejected list. */
export async function reorderCollectionGames(
  orgId: string, id: string, ids: string[],
): Promise<ReorderResult | null>;
```

Each returns `false` — or, for `reorderCollectionGames`, `null` — rather than throwing when the
collection does not belong to `orgId`, so every route can answer **404 without distinguishing
"absent" from "someone else's"**.

**`null` and a `ReorderResult` error are NOT interchangeable here**, and conflating them is the
easy mistake: "this collection is not yours" must be a 404, while "your list has an id that is not
a member" must be a 400. Returning a `ReorderResult` for both would turn every cross-tenant probe
into a 400 that confirms the collection exists.

- [ ] **Step 1: Implement**

`src/lib/collections.ts`. Key points, each of which the reviewer will check:

- **Every function starts by resolving the collection under `orgFilter(collections, orgId, eq(collections.id, id))`.** A membership write must never be reachable by id alone.
- `listCollections` returns the game count via a correlated subquery, ordered by `(sortKey, id)` — **`sortKey` alone is not a total order**, and `admin-queries.ts`'s `adminListUsers` documents this exact class of bug (a non-unique ORDER BY with a first-row pick reshuffling between renders).
- `createCollection` assigns `sortKey` as `max(sortKey) + 1` within the org so a new collection lands at the end.
- `addGameToCollection` verifies the game is in the same org (`orgFilter(games, orgId, eq(games.id, gameId))`) and inserts with `.onConflictDoNothing()` — **re-adding is a no-op, not an error** (§6.1). Its `sortKey` is `max + 1` within the collection.
- Both reorder functions read the current membership, call `planReorder`, and on success write every assignment in one `db.batch()`.

```ts
// Illustrative shape for the reorder half; the rest follows the same pattern.
export async function reorderCollectionGames(
  orgId: string, id: string, ids: string[],
): Promise<ReorderResult | null> {
  const db = getDb();
  const owned = await db.select({ id: collections.id }).from(collections)
    .where(orgFilter(collections, orgId, eq(collections.id, id))).limit(1);
  // null, NOT a ReorderResult error: the route turns this into 404. A 400
  // here would confirm to another tenant that the collection exists.
  if (owned.length === 0) return null;

  const current = await db.select({ gameId: collectionGames.gameId })
    .from(collectionGames).where(eq(collectionGames.collectionId, id));

  const plan = planReorder(current.map((c) => c.gameId), ids);
  if (!plan.ok) return plan;
  if (plan.assignments.length === 0) return plan;

  const stmts = plan.assignments.map((a) =>
    db.update(collectionGames).set({ sortKey: a.sortKey })
      .where(and(eq(collectionGames.collectionId, id), eq(collectionGames.gameId, a.id))),
  );
  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return plan;
}
```

- [ ] **Step 2: Filter `listGames` by collection**

In `src/lib/queries.ts`, give `listGames` an optional `collectionId` in its existing `opts`:

```ts
export async function listGames(
  orgId: string, opts: { limit?: number; collectionId?: string } = {},
): Promise<GameListItem[]>
```

When `collectionId` is set, `innerJoin` `collectionGames` on `collectionGames.gameId = games.id` and `collectionGames.collectionId = <id>`, and order by `collectionGames.sortKey` then `games.id` instead of `desc(games.createdAt)`.

**The collection is NOT trusted from the caller**: the page resolves it through `listCollections` first, so an id from another tenant never reaches this query. Add a comment saying so, because the join itself has no `orgId` predicate — `collection_games` has no such column by design (D-4-5).

Leave the unfiltered path byte-identical. **A library with no collections must behave exactly as it does today.**

- [ ] **Step 3: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/collections.ts src/lib/queries.ts
git commit -m "Add collection queries, and let listGames filter to one"
```

---

### Task 5: The API routes

**Files:**
- Create: `src/app/api/collections/route.ts`, `src/app/api/collections/order/route.ts`, `src/app/api/collections/[id]/route.ts`, `src/app/api/collections/[id]/games/route.ts`, `src/app/api/collections/[id]/games/[gameId]/route.ts`, `src/app/api/collections/[id]/order/route.ts`

**Read `src/app/api/disks/[id]/route.ts` first** — it is this repo's established shape for a zod-validated, org-scoped mutation route.

**Interfaces:**
- Consumes: everything from Task 4.

- [ ] **Step 1: Implement all six routes**

Each route: `export const maxDuration = 60;`, `await requireOrg()`, zod-parse the body, call the Task 4 function, and translate the result:

| Result | Response |
|---|---|
| success | `200` with the created/updated row, or `{ ok: true }` |
| `false` or `null` (not this org's, or absent) | **`404 { error: 'not_found' }`** |
| `{ reason: 'unknown-id' }` from a reorder | `400 { error: 'unknown_id', id }` |
| `{ reason: 'duplicate-id' }` | `400 { error: 'duplicate_id', id }` |
| `{ reason: 'missing-id' }` | `400 { error: 'missing_id', id }` |
| malformed JSON | `400 { error: 'invalid_json' }` |
| failed zod parse | `400 { error: 'invalid_body', detail }` |

**404 never 403**, uniformly — the response must not reveal that another tenant's collection exists.

Body schemas:

```ts
const createBody = z.object({ name: z.string().trim().min(1).max(80) });
const renameBody = createBody;
const addBody = z.object({ gameId: z.string().min(1) });
const orderBody = z.object({ ids: z.array(z.string().min(1)).max(5000) });
```

The `.max(5000)` on `ids` bounds an unbounded client array before it reaches a `db.batch()` that would build one statement per element.

**Route-file placement matters:** `src/app/api/collections/order/route.ts` must not be shadowed by `[id]`. Next resolves static segments before dynamic ones, so `/api/collections/order` reaches the static file — but a `PATCH` to `/api/collections/order` must NOT be handled by `[id]/route.ts`. Verify this by hand after implementing: `PATCH /api/collections/order` with a body of `{ ids: [] }` must reorder, not attempt to rename a collection named `order`.

- [ ] **Step 2: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/app/api/collections
git commit -m "Add the collections API, answering 404 rather than 403 across tenants"
```

---

### Task 6: The dependency and the drag context

**Files:**
- Modify: `package.json`
- Create: `src/components/collections/collection-provider.tsx`

- [ ] **Step 1: Add dnd-kit**

```bash
pnpm add -w @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

`-w` is required: this is a pnpm workspace and a bare `pnpm add` refuses at the root.

Report the resolved versions and the added bundle size in your report.

- [ ] **Step 2: The provider**

`src/components/collections/collection-provider.tsx`, `'use client'`. One `DndContext` wrapping both the rail and the grid, because a card is dragged FROM the grid TO the rail and a single context is what makes that possible.

It owns:
- `sensors` — `PointerSensor` with an activation distance of ~8 px, so a click on a card still navigates to the game instead of starting a drag. **This is the detail most likely to be got wrong**: without an activation constraint the library becomes unclickable.
- `onDragEnd`, which distinguishes three cases by the drag data:
  1. a game dropped on a collection → `POST /api/collections/<id>/games`
  2. a game dropped on another game, while filtered → `PATCH /api/collections/<id>/order`
  3. a collection dropped on another collection → `PATCH /api/collections/order`
- Optimistic local state, reconciled with `router.refresh()` in a `finally`, and a `toast.error` on failure — matching `dat-upload.tsx`'s error handling.

- [ ] **Step 3: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add package.json pnpm-lock.yaml src/components/collections/collection-provider.tsx
git commit -m "Add dnd-kit and the shared drag context"
```

---

### Task 7: The rail, and draggable cards

**Files:**
- Create: `src/components/collections/collection-rail.tsx`
- Modify: `src/app/(app)/library/page.tsx`, `src/components/library/game-grid.tsx`

- [ ] **Step 1: The rail**

`src/components/collections/collection-rail.tsx`, `'use client'`. A `SortableContext` listing the collections, each row a drop target (`useDroppable`) and a drag handle (`useSortable`). Each row: name, game count, and a link that sets `?collection=<id>`. Plus an "All games" row that clears the filter, and a create control (an inline input, not a modal — the repo has no dialog pattern for this and one is not worth introducing).

Testids: `collection-rail`, `collection-row` with `data-collection-id`, `collection-name`, `collection-count`, `collection-create`, `collection-all`.

Rename and delete live in a small menu per row. **Deleting asks for confirmation** — it destroys human-authored work — and the confirm copy must say the games themselves are not deleted, because that is the reasonable fear.

- [ ] **Step 2: The page**

In `src/app/(app)/library/page.tsx`: read `sp.collection`, call `listCollections(orgId)`, resolve the requested id **against that list** (an unknown or other-tenant id falls back to unfiltered — never a 404, since a stale link should not break the library), pass `collectionId` to `listGames`, and render the rail beside the existing grid or table inside the provider.

**When no collection is selected the page must render exactly as it does today.**

- [ ] **Step 3: Draggable cards**

In `src/components/library/game-grid.tsx`, wrap each card in `useSortable` keyed by the game id, with drag data `{ type: 'game', id }`. When `collectionId` is set the grid is a `SortableContext`; when it is not, cards are draggable but not sortable — there is no order to change in the recently-added view.

Keep the existing `Link` navigation working: the 8 px activation constraint from Task 6 is what allows both.

- [ ] **Step 4: The per-card remove control**

Design §6.1 requires it and nothing else in this plan delivers it. **Only when a collection is
selected**, each card carries a small remove control (`data-testid={`remove-from-collection-${g.id}`}`)
calling `DELETE /api/collections/<collectionId>/games/<gameId>`, then `router.refresh()`.

Two things it must get right:

- **It is offered ONLY inside a collection's view.** "Remove" is meaningless in the unfiltered
  library, where there is no collection to remove from.
- **Its label and confirm copy must never suggest deleting the game.** Use "Remove from
  collection". This is the one control in the app a person could plausibly mistake for destroying
  a disk, and the underlying route does not touch `games` at all.

Stop the click reaching the card's `Link` (`e.preventDefault(); e.stopPropagation();`), or removing
a game also navigates to it.

- [ ] **Step 5: Verify and commit**

```bash
pnpm vitest run && pnpm build && pnpm lint
git add src/components/collections "src/app/(app)/library/page.tsx" src/components/library/game-grid.tsx
git commit -m "Add the collections rail, draggable cards, and per-card removal"
```

---

### Task 8: End-to-end tests

**Files:**
- Create: `e2e/collections.spec.ts`

**Read `e2e/tosec-scan.spec.ts` first** — it has the merge-triggering pattern the two most important tests here need, including `seedTosecEntry` and the `fakeHashes` helper.

- [ ] **Step 1: Write the specs**

Cover, with `cleanupSeeded` and a collections cleanup in `afterAll`:

1. **Create, rename, delete.** Deleting a collection removes its rows but **leaves every game** — assert the games still exist afterwards.
2. **Add a game and filter to it.** Drag is hard to drive reliably; use the API for the add, then assert the filtered grid shows exactly that game. A separate test drives the actual drag with `dragTo` and asserts the count changes.
3. **Reorder persists.** `PATCH .../order`, reload, assert the order survives.
3b. **The per-card remove control removes from the collection and NOT the library.** Click it, then
   assert the game is gone from the filtered view AND still present with no collection selected.
4. **A reorder cannot change membership.** Post a list with an extra id → 400 `unknown_id`; with a duplicate → 400 `duplicate_id`; omitting one → 400 `missing_id`. Then assert the membership is **unchanged** after all three.
5. **THE MERGE TEST (design §3.1).** Two games, both in one collection, that a TOSEC scan will collapse into one. Run `POST /api/admin/scan`. Assert the merge actually fired (one `games` row survives), and that the collection now holds **exactly one** entry pointing at the survivor. **Assert the merge fired first**, or the test passes on a no-op.
6. **The repoint half.** Only the absorbed game is in the collection; after the merge the entry points at the survivor and the collection still has one game.
7. **Cross-tenant.** Org B gets 404 from every route with org A's collection id, and sees none of org A's collections in the rail.
8. **User deletion removes collections** via `deleteUserCascade`.

- [ ] **Step 2: Run everything**

```bash
pnpm vitest run && pnpm build && pnpm e2e
```

Report the counts. The suite runs `workers: 1` and takes ~19 minutes.

- [ ] **Step 3: Commit**

```bash
git add e2e/collections.spec.ts
git commit -m "Cover collections end to end, including the TOSEC merge hazard"
```

---

### Task 9: Documentation

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/specs/2026-09-01-collections-design.md`

- [ ] **Step 1: Record it**

Add a `### 3g. User-defined collections` section to `HANDOFF.md`, matching `3e`/`3f`'s voice. It must state, prominently:

- **`mergeDuplicates` now repoints `collection_games`, delete-then-update.** Anyone adding another table that holds a `games.id` must join that same batch, and this is now the second such table — say so, because the pattern is the point.
- `collection_games.gameId` cascades **deliberately**, and why that is the opposite of the `disks.gameId` ruling.
- A reorder rejects unknown ids, duplicates **and omissions**, so it can never change membership.
- `dnd-kit` is the repo's first DnD dependency.

Update the status table. Mark the backlog entry done.

- [ ] **Step 2: Mark the spec delivered**

Add a "What this increment delivered" section, including anything that changed shape during implementation.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md docs/superpowers/specs/2026-09-01-collections-design.md
git commit -m "Record user-defined collections as delivered"
```

---

## Done when

- `pnpm vitest run` green, `pnpm e2e` green, `pnpm build` clean, lint no worse than baseline.
- **A TOSEC merge collapsing two games that are both in one collection was observed to leave exactly one entry**, with the merge proven to have fired.
- A reorder was observed to reject an extra id, a duplicate and an omission, leaving membership unchanged in all three cases.
- Deleting a collection was observed to leave its games intact.
- A library with no collections renders exactly as it did before this increment.
