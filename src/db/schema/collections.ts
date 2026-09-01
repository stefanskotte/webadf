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
