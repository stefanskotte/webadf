# Editing a title's details by hand — spec

**Written 2026-09-03.** Requested by the operator 2026-09-01: every field an enrichment would
write is already there and already rendered, and there is no way to fill one in by hand.

## 1. What this is for

A person can correct or supply a title's details, and a scan never silently undoes their work.
Two operator rulings shape it (2026-09-03): **authority is per group, not per row**, and **an
edit is reversible** — there is a way to hand a group back to the scanners.

## 2. The mechanism already exists

`MACHINE_SOURCES = ['filename', 'tosec', 'openretro']` (`src/lib/tosec-apply.ts`). A sweep only
writes rows whose source column is one of those. Writing any other value — `'human'` — makes
that group immune. This increment is the UI for a rule that shipped before it.

## 3. Three groups, and which column each stamps

| Group | Fields | Column | Written today by |
|---|---|---|---|
| **identity** | `title` (+ derived `sortTitle`), `year`, `publisher` | `metadataSource` | TOSEC `applyMatch`, and OpenRetro for `publisher` |
| **facts** | `developer`, `players`, `genre`, `chipset` | `factsSource` | OpenRetro |
| **prose** | `description`, `history` | `proseSource` | OpenRetro (`description` only) |

**An edit stamps ONLY the groups it changed.** Fixing a typo in a description must not freeze
a publisher against every future scan.

**`publisher` belongs to identity even though OpenRetro writes it.** It is TOSEC's column
first, and a person correcting a publisher means it, so it is guarded by `metadataSource` on
both write paths — which is why §4 has to split OpenRetro's single statement.

## 4. The guard change, and the bug it avoids

Today OpenRetro's whole write is gated on `metadataSource IN MACHINE_SOURCES`, so **a typo fix
in a title would also freeze that game's facts and prose** — the per-group columns exist but
nothing reads them. Per the operator's ruling, `applyEnrichment` splits into three statements
guarded by the column that owns each group.

**The trap, measured against live data before writing a line:** `metadata_source` is never
NULL (`'filename'` at ingest), so `NULL` there genuinely means human. **`facts_source` and
`prose_source` are NULL on 7 of the 9 live games**, where NULL means *never written*, not
*human*. A naive `inArray(factsSource, MACHINE_SOURCES)` guard would therefore have **excluded
every never-enriched row and silently stopped OpenRetro enriching 78% of the archive**. Their
guard must be `IS NULL OR IN MACHINE_SOURCES`. The "including NULL" rule in `tosec-apply`'s
comment is correct for `metadataSource` and **inverted** for the other two.

## 5. Reset — handing a group back

Per group: clear authority **and restore the stored values**, so "use scanned data" means what
it says rather than "wait for a sweep that may never come".

- **identity** → `metadataSource = 'filename'`, never NULL (NULL means human here).
- **facts** / **prose** → the column back to `NULL`, its never-written state.

Values are restored by reading this game's own matched entry (`blobs.tosecEntryId` /
`blobs.openretroEntryId` via its disks) and updating **this game's** columns directly.
**`applyMatch` is deliberately NOT reused**: it applies across every tenant holding those bytes
and can merge duplicate games, which is far more than a person asked for by pressing undo on
one title.

Reset with no stored entry clears authority and says so; it cannot invent data.

## 6. Editing a title is the sharp edge

`sortTitle` is `NOT NULL`, is what `games_org_sort_idx` orders by, and `(sortTitle, year)` is
the exact key `mergeDuplicates` collapses on. So a title edit **must** write `sortTitle` too,
via the existing `makeSortTitle` (`src/lib/tosec.ts`) so human rows sort like machine ones.

It also changes merge behaviour permanently: a human-edited row is **always** the survivor and
never the one a sweep deletes, and **two** human-edited rows in one duplicate set do not merge
at all. That is correct, and the UI must not imply otherwise.

## 7. Boundaries

- `PATCH /api/games/[id]` and `POST /api/games/[id]/reset`, both org-scoped through
  `orgFilter()`; another tenant's id is a 404, never a 403.
- Editing never touches `games.id`, any disk, or any device. Ids are not rewritten here for the
  same reason `tosec-apply` refuses to: a re-keyed disk reads as an eject.
- `year` is validated (1978–2100 or empty); `title` may not be blank, because `sortTitle`
  derives from it and the column is `NOT NULL`.

## 8. Testing

Vitest for the pure part: which groups a diff touches, `sortTitle` derivation, validation.
Playwright for the rule that matters — **edit a description, run a scan, and watch the
publisher still update while the description survives.** That single test is the whole point of
per-group authority, and it fails against today's single guard.
