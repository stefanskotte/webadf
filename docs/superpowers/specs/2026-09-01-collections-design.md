# User-defined collections, with drag-and-drop — design

**Written 2026-09-01.** Increment 4 of the operator's four-item batch, and the last of them.
Implements the "User-defined collections, with drag-and-drop" backlog entry.

---

## 1. What this is for

The operator wants their own categories — "My favorite games - AGA" — and wants to move games
into them by dragging. Nothing in the catalog today lets a person impose their own structure: the
library is one flat list ordered by ingest date, and every other grouping in the system
(`games`, TOSEC identity, OpenRetro enrichment) is machine-derived from disk content.

Collections are therefore the first **human-authored** structure in this app, and that is what
makes their failure mode different from everything preceding them: a machine-derived grouping can
be recomputed from the disks, and a collection cannot. Losing one is losing work nobody can
regenerate. §3 is about exactly that.

**Purely organisational.** Collections have nothing to do with devices, mounting or the disk
protocol. No device endpoint reads them.

---

## 2. Scope

**In:**

- Create, rename and delete a collection.
- Add a game to a collection by dragging its card onto the collection.
- Remove a game from a collection.
- **Reorder games within a collection** by dragging.
- **Reorder the collections themselves** by dragging.
- Filter the library to one collection by selecting it.

**Out, deliberately:**

- **Smart or saved-filter collections** ("everything AGA from 1992"). A different feature with a
  different data model; nothing here forecloses it.
- **Nesting.** No collection contains another. Adding it later means a nullable `parentId`, which
  this schema can take without migration pain.
- **Sharing across organizations.** Collections are per-tenant, full stop.
- **Any device interaction** — mounting a whole collection, queueing it, etc.

---

## 3. The hazard this design exists to survive

**Two production paths delete `games` rows**, and a collection entry pointing at a deleted game is
the whole risk surface.

### 3.1 `mergeDuplicates` — the one that will actually bite

`src/lib/tosec-apply.ts`'s `mergeDuplicates` collapses two `games` rows that resolve to the same
`(sortTitle, year)`: it moves the disks to a survivor, repoints `devices.desiredGameId` and
`mountedGameId`, and then **deletes the absorbed row**. That repointing batch already exists
precisely because those columns have no foreign key and would otherwise dangle.

**`collection_games` must join that batch**, or a TOSEC scan silently removes entries from a
person's collection — with no error, no log, and nothing to recover from.

**And there is a trap inside the trap.** If a collection already contains the survivor *and* the
absorbed game, repointing produces two identical rows and violates the primary key. So the merge
needs **two statements, in this order**:

1. `DELETE FROM collection_games WHERE game_id = <gone> AND collection_id IN
   (SELECT collection_id FROM collection_games WHERE game_id = <survivor>)`
2. `UPDATE collection_games SET game_id = <survivor> WHERE game_id = <gone>`

Getting the order wrong, or omitting (1), fails the whole batch — and `db.batch()` is atomic on
neon-http, so the merge would abort and the sweeper would retry it forever. That is a hot loop,
not a lost row, which is at least loud.

**This is the single most important requirement in this document.** It gets a dedicated e2e:
a merge that collapses two games while both are in the same collection must leave exactly one
entry and lose nothing.

### 3.2 `deleteUserCascade` — the tidy one

`src/lib/admin-delete.ts` deletes everything an organization owns when a user is removed. It gains
`collections` (and `collection_games` follows by cascade). Because `e2e/global-teardown.ts` reuses
`deleteUserCascade`, this also stops the e2e suite leaking collections into the live database —
the teardown needs no separate change.

### 3.3 The foreign key, and why cascade is right here

`collection_games.gameId` references `games.id` **`ON DELETE CASCADE`**.

This is the opposite of the ruling on `disks.gameId`, where a cascade destroyed a disk and a
destroyed disk is indistinguishable from an eject. The asymmetry is deliberate: **losing a
collection entry when its game is genuinely gone is correct**, whereas losing a disk is data loss
with a protocol consequence. The cascade is a safety net for any future delete path that forgets
§3.1 — and it does not mask §3.1, because within one batch the repointing UPDATE runs before the
DELETE, so the cascade finds nothing left to remove.

`collection_games.collectionId` references `collections.id` `ON DELETE CASCADE` for the ordinary
reason: deleting a collection removes its membership rows.

---

## 4. Ordering

**Integer `sortKey`, rewritten wholesale on each move.** The client sends the complete ordered list
of ids; the server writes `sortKey` 0..n-1 in one `db.batch()`.

Considered and rejected:

- **Fractional keys** (a float between neighbours) write one row per move but drift toward
  precision limits and need periodic rebalancing — machinery for a scale this does not have.
- **A linked list** (`prevId`) is correct by construction but makes every read walk the chain, and
  one broken link is unrecoverable.

At this scale — a handful of collections, tens to hundreds of games in one — rewriting the list is
a few hundred bytes of SQL and removes every question about ties, drift and rebalancing.

**The reorder endpoint validates membership**: every id in the submitted list must already belong
to the collection, and the list must contain no duplicates. A reorder must never be able to *add*
a game, which is what makes it safe to accept a whole list from a client.

---

## 5. Schema

```ts
export const collections = pgTable('collections', {
  id: text('id').primaryKey(),
  // Per-TENANT, unlike blobs and tosec_entries which are global because they
  // are content-addressed. A collection is one person's opinion, not a
  // property of any bytes.
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  sortKey: integer('sort_key').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('collections_org_sort_idx').on(t.orgId, t.sortKey)]);

export const collectionGames = pgTable('collection_games', {
  collectionId: text('collection_id').notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  // ON DELETE CASCADE deliberately -- see section 3.3. Losing a collection
  // entry when its game is gone is correct; this is NOT the disks.gameId case.
  gameId: text('game_id').notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  sortKey: integer('sort_key').notNull().default(0),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // A game may be in many collections, never twice in one. This constraint is
  // what makes section 3.1's delete-then-repoint necessary.
  primaryKey({ columns: [t.collectionId, t.gameId] }),
  index('collection_games_sort_idx').on(t.collectionId, t.sortKey),
  index('collection_games_game_idx').on(t.gameId),
]);
```

`collection_games` carries **no `orgId`**. It is reachable only through a collection, which has
one, and duplicating the column would create exactly the drift `disks.orgId` already causes
elsewhere in this codebase. Every query scopes through `collections`.

---

## 6. Surfaces

### 6.1 The rail on `/library`

A collections rail down the left of the existing library page. The grid and table are **reused,
not rebuilt** — the rail is added beside them and the page gains a `?collection=<id>` search param.

- Dragging a game card onto a collection adds it. **Dropping a game that is already there is a
  no-op, not an error** — the insert is `onConflictDoNothing` against the primary key. A person
  dragging a card they have already filed should see nothing happen, not a failure toast.
- Selecting a collection filters the grid or table to its games, in `sortKey` order.
- While filtered, dragging cards reorders the collection.
- **While filtered, each card carries a remove control** (a small × on the card). Removal is only
  offered inside a collection's view, because "remove" is meaningless without knowing which
  collection it means — and it must never be confusable with deleting the game.
- Dragging collections reorders the rail.
- A collection shows its game count.

**When no collection is selected the page behaves exactly as it does today**, including the
existing recently-added ordering. A library with no collections must look untouched.

### 6.2 Routes

All org-scoped through `orgFilter()`, all answering **404 rather than 403** so no response
confirms another tenant's collection exists.

| Route | Purpose |
|---|---|
| `POST /api/collections` | create; `{ name }` |
| `PATCH /api/collections/[id]` | rename; `{ name }` |
| `DELETE /api/collections/[id]` | delete, cascading its membership rows |
| `POST /api/collections/[id]/games` | add; `{ gameId }` |
| `DELETE /api/collections/[id]/games/[gameId]` | remove |
| `PATCH /api/collections/order` | reorder collections; `{ ids: string[] }` |
| `PATCH /api/collections/[id]/order` | reorder games; `{ ids: string[] }` |

Both reorder endpoints take the **complete** ordered list, per §4, and reject any id that is not
already a member.

### 6.3 The dependency

`@dnd-kit/core` and `@dnd-kit/sortable`, roughly 30 KB together. This is the repo's **first
drag-and-drop dependency**: shadcn v4 here is `@base-ui/react`, and neither it nor Radix ships a
DnD primitive.

Native HTML5 drag would cover "drop a card onto a collection" with no dependency at all, and was
the alternative — but it degrades badly for the reordering half (no touch support, no live
reorder preview), and reordering is explicitly in scope.

---

## 7. Testing

**Vitest, for the pure logic:**

- Rewriting an ordered id list to `sortKey` 0..n-1.
- Moving an item within a list produces the expected order.
- A submitted list containing an id that is not a member is rejected.
- A submitted list containing duplicates is rejected.
- A submitted list that omits an existing member is rejected — a reorder must not be a way to
  silently drop a game.

**Playwright, for everything touching the database or the DOM:**

- Create, rename, delete a collection; deleting removes its membership rows but **never a game**.
- Drag a game into a collection; it appears when the collection is filtered.
- Reorder within a collection; the order survives a reload.
- Reorder the rail; that order survives a reload.
- **The merge test of §3.1**: two games in one collection, collapsed by a TOSEC scan, leaves
  exactly one entry. Assert the merge actually fired, or the test passes on a no-op.
- **A merge where only the absorbed game is in the collection** leaves the entry pointing at the
  survivor — the repoint half, distinct from the dedupe half above.
- Cross-tenant: org B gets 404 for every route, and cannot see org A's collections in the rail.
- Deleting a user removes their collections (`deleteUserCascade`).

---

## 8. Decisions

- **D-4-1. `collection_games` joins `mergeDuplicates`' repointing batch, delete-then-update.**
  Without it a TOSEC scan silently removes a person's hand-made entries. The delete must precede
  the update or the primary key rejects the whole atomic batch.
- **D-4-2. `gameId` cascades on delete**, unlike `disks.gameId`. Losing a collection entry when the
  game is gone is correct; losing a disk is an eject.
- **D-4-3. Integer sort keys rewritten wholesale**, not fractional keys or a linked list. No drift,
  no rebalancing, trivial at this scale.
- **D-4-4. A reorder can never change membership.** The endpoint rejects unknown ids, duplicates
  and omissions, which is what makes accepting a whole client-supplied list safe.
- **D-4-5. `collection_games` carries no `orgId`.** It is reachable only through a collection;
  a duplicated column would invite the same drift `disks.orgId` already causes here.
- **D-4-6. `dnd-kit` is added** because reordering is in scope; native HTML5 drag would have
  sufficed for adding alone.
- **D-4-7. Collections are invisible to the device plane.** No endpoint, no protocol change.
