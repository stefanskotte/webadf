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

  // Demozoo (spec §4). demozoo_production_id holds the AUTOMATIC link only --
  // a person's confirmation lives on the org's game, never here.
  demozooProductionId: integer('demozoo_production_id'),
  demozooState: text('demozoo_state'),   // 'applied' | 'suggested' | 'none' | 'skipped_game'
  demozooCheckedAt: timestamp('demozoo_checked_at', { withTimezone: true }),
}, (t) => [
  index('blobs_hashed_at_idx').on(t.hashedAt),
  index('blobs_match_checked_idx').on(t.matchCheckedAt),
  index('blobs_enrich_checked_idx').on(t.enrichCheckedAt),
  index('blobs_demozoo_checked_idx').on(t.demozooCheckedAt),
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
  /**
   * Made HERE, rather than uploaded. Two things need to know:
   *
   *  - the library card offers an inline volume rename only for these, since
   *    renaming rewrites the disk's bytes and "which disk?" has no answer on
   *    a multi-disk title;
   *  - a disk somebody made is in no preservation set, so it must be excluded
   *    from the TOSEC coverage rate on /admin/scan -- otherwise that rate
   *    falls every time the operator makes a disk, which would report their
   *    own work as a gap in the archive.
   *
   * Distinct from metadataSource 'human', which only says a person last wrote
   * the metadata -- true of any title whose details were edited by hand.
   */
  authored: boolean('authored').notNull().default(false),
  // An org's confirmed Demozoo production (spec §6.2). Org-scoped by living on
  // the game; the global automatic link is blobs.demozoo_production_id.
  demozooProductionId: integer('demozoo_production_id'),
  demozooLinkSource: text('demozoo_link_source'),   // 'confirmed'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('games_org_sort_idx').on(t.orgId, t.sortTitle),
  index('games_org_created_idx').on(t.orgId, t.createdAt),
  // Declared so `drizzle-kit push` doesn't treat these (created directly by
  // 0012_search_trgm.sql, outside the schema until now) as drift and drop
  // them -- push diffs against the schema files, not the migration history.
  index('games_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
  index('games_publisher_trgm_idx').using('gin', t.publisher.op('gin_trgm_ops')),
]);

/** What a disk row's bytes are (HFE spec D2). Re-exported by src/lib/disk-format.ts. */
export type ImageFormat = 'adf' | 'hfe';

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

  // 'adf' | 'hfe' (spec D2). Every ADF-assuming gate branches on this --
  // never on sizeBytes. An HFE row is always write-protected (see
  // /api/disks/[id] PATCH) and never enters disk history.
  imageFormat: text('image_format').$type<ImageFormat>().notNull().default('adf'),
  // HFE only (spec D5): could every AmigaDOS sector be decoded at ingest?
  // Null on an ADF, where the question does not arise.
  extractable: boolean('extractable'),
  extractReason: text('extract_reason'),
  // HFE only: the longest served side, in bits (inspectHfe). Null on an ADF,
  // whose tracks are all the nominal 101,344. The mount gate refuses a board
  // whose reported trackMaxBytes cannot hold it.
  maxTrackBits: integer('max_track_bits'),
}, (t) => [
  index('disks_game_idx').on(t.gameId),
  index('disks_org_idx').on(t.orgId),
]);
