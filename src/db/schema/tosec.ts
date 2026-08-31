import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * GLOBAL, not per-tenant -- deliberately the same class as `blobs`. TOSEC
 * identity is a property of bytes, so one import serves every organization
 * and two tenants can never disagree about what the same bytes are.
 */
export const tosecEntries = pgTable('tosec_entries', {
  // Derived from (setName, romName) so re-importing the same set updates
  // rows instead of duplicating them.
  id: text('id').primaryKey(),
  setName: text('set_name').notNull(),
  setVersion: text('set_version'),
  gameName: text('game_name').notNull(),
  romName: text('rom_name').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  // Lowercase hex, or null when the DAT omitted it. Never '' -- see
  // tosec-dat.ts's hash(): an empty string would compare equal by accident.
  crc32: text('crc32'),
  md5: text('md5'),
  sha1: text('sha1'),
  // Parsed from gameName by parseTosecName at import time.
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  publisher: text('publisher'),
  diskNo: integer('disk_no'),
  diskCount: integer('disk_count'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tosec_sha1_idx').on(t.sha1),
  index('tosec_md5_idx').on(t.md5),
  index('tosec_crc_size_idx').on(t.crc32, t.sizeBytes),
]);
