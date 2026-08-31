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

  // Content hashes beyond sha256, for TOSEC matching. Computed SERVER-SIDE
  // only -- at ingest inside verify()'s existing read-back, or by the
  // sweeper. No client ever supplies these (design §7).
  crc32: text('crc32'),
  md5: text('md5'),
  sha1: text('sha1'),
  hashedAt: timestamp('hashed_at', { withTimezone: true }),

  // The TOSEC identity of these bytes. Global on purpose: one match serves
  // every tenant holding this sha256.
  tosecEntryId: text('tosec_entry_id'),
  // 'matched' | 'none' | 'ambiguous'. NOT inferable from tosecEntryId alone:
  // "considered and found absent" and "not yet considered" are different
  // facts, and telling them apart is what makes the miss rate measurable.
  matchState: text('match_state'),
  matchCheckedAt: timestamp('match_checked_at', { withTimezone: true }),

  // Enrichment cursor. Mirrors tosecEntryId / matchState / matchCheckedAt
  // exactly, so the sweeper's resumable pattern applies unchanged. No foreign
  // key, for the same reason: a re-import may drop an entry and a dangling
  // reference must degrade to "unenriched", never block.
  openretroEntryId: text('openretro_entry_id'),
  enrichState: text('enrich_state'),            // 'enriched' | 'none' | 'ambiguous'
  enrichCheckedAt: timestamp('enrich_checked_at', { withTimezone: true }),
}, (t) => [
  index('blobs_hashed_at_idx').on(t.hashedAt),
  index('blobs_match_checked_idx').on(t.matchCheckedAt),
  index('blobs_enrich_checked_idx').on(t.enrichCheckedAt),
]);

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
  developer: text('developer'),
  players: text('players'),
  // Empty until a Hall of Light increment fills them. Added now so that
  // increment needs no migration -- OpenRetro carries hol_url, so it will be
  // an exact lookup rather than a title search.
  description: text('description'),
  history: text('history'),
  // Which source last wrote the facts, and which wrote the prose. Separate,
  // so OpenRetro's publisher/year survive a later prose import and vice versa.
  factsSource: text('facts_source'),
  proseSource: text('prose_source'),
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

  // Org-scoped on purpose. This must never live on `blobs`, which is global and
  // content-addressed -- 26 blobs are already shared across organizations, so a
  // flag there would apply one tenant's choice to every other tenant holding
  // the same disk. Defaults to protected: games shipped read-only.
  writeProtected: boolean('write_protected').notNull().default(true),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
}, (t) => [
  index('disks_game_idx').on(t.gameId),
  index('disks_org_idx').on(t.orgId),
]);
