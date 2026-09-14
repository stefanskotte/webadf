import { sql } from 'drizzle-orm';
import {
  pgTable, text, integer, boolean, timestamp, index, primaryKey,
} from 'drizzle-orm/pg-core';
import { blobs, games } from './catalog';

/**
 * GLOBAL, like openretro_* and tosec_entries: a Demozoo production describes
 * bytes, so one import serves every organization. Ids are Demozoo's own.
 * Only Amiga productions (platforms 5, 6, 26) are stored.
 */
export const demozooProductions = pgTable('demozoo_productions', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  // src/lib/demozoo/title-key.ts. The only thing matching ever compares.
  titleKey: text('title_key').notNull(),
  releaseYear: integer('release_year'),
  // Demozoo's supertype: 'production' | 'graphics' | 'music'. Only
  // 'production' is ever a candidate (spec §5.2).
  supertype: text('supertype').notNull(),
  types: text('types').array().notNull().default(sql`'{}'::text[]`),
  // Author nick names, in Demozoo's order. text[] because names contain commas.
  groups: text('groups').array().notNull().default(sql`'{}'::text[]`),
  isGame: boolean('is_game').notNull().default(false),
  // Stamped by every import that writes the row; rows older than the run's
  // start are gone from Demozoo and are deleted when the run finishes.
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('dz_prod_title_key_idx').on(t.titleKey)]);

/** At most 5 per production (extract.ts MAX_SCREENSHOTS), in Demozoo id order. */
export const demozooScreenshots = pgTable('demozoo_screenshots', {
  id: integer('id').primaryKey(),
  productionId: integer('production_id').notNull()
    .references(() => demozooProductions.id, { onDelete: 'cascade' }),
  standardUrl: text('standard_url').notNull(),
  ordinal: integer('ordinal').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('dz_shot_prod_idx').on(t.productionId)]);

/**
 * One row per screenshot we have REQUESTED. `sha1` is sha1(standard_url): an
 * identifier that fits imageStore and /api/images, NOT a digest of the bytes.
 * A failed request leaves storage_key null and failed_at set; it is retried
 * after 24 h. Every row counts against the rolling-hour budget.
 */
export const demozooImages = pgTable('demozoo_images', {
  sha1: text('sha1').primaryKey(),
  screenshotId: integer('screenshot_id').notNull(),
  productionId: integer('production_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  storageKey: text('storage_key'),
  sizeBytes: integer('size_bytes'),
  sourceUrl: text('source_url').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  failedAt: timestamp('failed_at', { withTimezone: true }),
}, (t) => [
  index('dz_img_prod_idx').on(t.productionId),
  index('dz_img_fetched_idx').on(t.fetchedAt),
]);

/**
 * Single row, id = 1. step: 'fetched' (raw export in our store) ->
 * 'extracted' (demozoo/amiga.json in our store, writing) -> 'applied'.
 * last_attempt_at gates the weekly fetch, and is set BEFORE the request so a
 * failure also waits a week.
 */
export const demozooImport = pgTable('demozoo_import', {
  id: integer('id').primaryKey(),
  step: text('step').notNull().default('applied'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  runStartedAt: timestamp('run_started_at', { withTimezone: true }),
  productionsWritten: integer('productions_written').notNull().default(0),
  screenshotsWritten: integer('screenshots_written').notNull().default(0),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
});

/** Computed facts about bytes: GLOBAL. Cascades with the blob and the production. */
export const demozooSuggestions = pgTable('demozoo_suggestions', {
  sha256: text('sha256').notNull().references(() => blobs.sha256, { onDelete: 'cascade' }),
  productionId: integer('production_id').notNull()
    .references(() => demozooProductions.id, { onDelete: 'cascade' }),
  // 'tosec_title' | 'volume_name' | 'filename'
  source: text('source').notNull(),
}, (t) => [
  primaryKey({ columns: [t.sha256, t.productionId] }),
  index('dz_sugg_prod_idx').on(t.productionId),
]);

/** "Not this", per ORG'S GAME. Also how an org hides a global automatic link. */
export const demozooDismissals = pgTable('demozoo_dismissals', {
  orgId: text('org_id').notNull(),
  gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  productionId: integer('production_id').notNull()
    .references(() => demozooProductions.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.gameId, t.productionId] })]);
