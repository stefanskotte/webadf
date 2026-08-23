import {
  pgTable, text, integer, bigint, timestamp, boolean, primaryKey, index,
} from 'drizzle-orm/pg-core';

/** GLOBAL, not per-tenant. One row per unique disk image in the whole system. */
export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  sizeBytes: integer('size_bytes').notNull(),
  gzipSizeBytes: integer('gzip_size_bytes'),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Proves a tenant uploaded these exact bytes. Gates every presigned GET. */
export const entitlements = pgTable('entitlements', {
  orgId: text('org_id').notNull(),
  sha256: text('sha256').notNull().references(() => blobs.sha256),
  sourceFilename: text('source_filename').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.sha256] }),
  index('entitlements_org_idx').on(t.orgId),
]);

export const games = pgTable('games', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  publisher: text('publisher'),
  genre: text('genre'),
  chipset: text('chipset'),
  coverAssetId: text('cover_asset_id'),
  metadataSource: text('metadata_source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('games_org_sort_idx').on(t.orgId, t.sortTitle),
  index('games_org_created_idx').on(t.orgId, t.createdAt),
]);

export const disks = pgTable('disks', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  diskNo: integer('disk_no').notNull(),
  sha256: text('sha256').notNull().references(() => blobs.sha256),
  label: text('label'),
  tosecName: text('tosec_name'),
  isBoot: boolean('is_boot').notNull().default(false),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
}, (t) => [
  index('disks_game_idx').on(t.gameId),
  index('disks_org_idx').on(t.orgId),
]);
