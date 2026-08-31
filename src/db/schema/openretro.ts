import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * GLOBAL, not per-tenant -- the same class as blobs and tosec_entries. An
 * OpenRetro record describes bytes, so one import serves every organization.
 *
 * One row per PARENT game (_type "1"). Variant rows are not stored: their only
 * durable contribution is the sha1 -> parent mapping, which is flattened into
 * openretro_disk_sha1 below, plus chipset, which is copied onto the entry.
 */
export const openretroEntries = pgTable('openretro_entries', {
  uuid: text('uuid').primaryKey(),
  gameName: text('game_name').notNull(),
  slug: text('slug'),
  publisher: text('publisher'),
  developer: text('developer'),
  year: integer('year'),
  languages: text('languages'),
  players: text('players'),
  tags: text('tags'),
  chipset: text('chipset'),
  frontSha1: text('front_sha1'),
  titleSha1: text('title_sha1'),
  // Comma-joined, in order. MUST be persisted, not held in memory: the import
  // and the sweeper that fetches these images are separate requests, so an
  // in-memory list would be gone by the time anything needed it.
  screenshotSha1s: text('screenshot_sha1s'),
  // Outbound links, stored verbatim. hol_url is the one that matters: it makes
  // the deferred Hall of Light increment an exact lookup instead of a title
  // search. The rest cost nothing and are useful on a game page.
  holUrl: text('hol_url'),
  mobygamesUrl: text('mobygames_url'),
  lemonUrl: text('lemon_url'),
  wikipediaUrl: text('wikipedia_url'),
  longplayUrl: text('longplay_url'),
  // Prose, carried by 1,706 of the 3,697 parent records. `long_description`
  // is the fuller of the two and is what the catalog prefers; `description`
  // is a shorter blurb some entries carry instead.
  description: text('description'),
  longDescription: text('long_description'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
});

/** sha1 of a disk -> the parent entry it belongs to. Flattened from variants. */
export const openretroDiskSha1 = pgTable('openretro_disk_sha1', {
  sha1: text('sha1').notNull(),
  entryUuid: text('entry_uuid').notNull(),
}, (t) => [
  index('oagd_sha1_idx').on(t.sha1),
  index('oagd_entry_idx').on(t.entryUuid),
]);

/**
 * One row per image we have actually stored, keyed by OpenRetro's own sha1.
 * `kind` is 'front' | 'title' | 'screenshot'. Global for the same reason the
 * entries are: the same cover serves every tenant holding that game.
 */
export const openretroImages = pgTable('openretro_images', {
  sha1: text('sha1').primaryKey(),
  entryUuid: text('entry_uuid').notNull(),
  kind: text('kind').notNull(),
  ordinal: integer('ordinal').notNull().default(0),
  storageKey: text('storage_key').notNull(),
  // The public URL in OUR store. Persisted because it cannot be derived: it
  // embeds the Blob store id. Rendering from source_url instead would hotlink
  // openretro.org on every page view, which is the thing storing these
  // locally exists to avoid.
  url: text('url').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sourceUrl: text('source_url').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('oagd_img_entry_idx').on(t.entryUuid)]);
