import { bigint, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { devices } from './devices';

/**
 * Files sent from the web app to a board's Amiga (PaulaNET Phase 4, spec 2026-10-16 §4). The board fetches the
 * queue, streams each file to Receive on the Amiga and reports the outcome; bytes live in the disk store under
 * blob_sha256 (blob GC keeps them while a row names them).
 */
export const transfers = pgTable('transfers', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').notNull(),
  /** Cleaned: Latin-1 only, '/'-separated parts of 1..30 bytes, at most 255 (cleanAmigaPath). */
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  crc32: bigint('crc32', { mode: 'number' }).notNull(),
  /** AmigaDOS protection bits as stored on disk (0 = rwed allowed). */
  protection: bigint('protection', { mode: 'number' }).notNull().default(0),
  comment: text('comment').notNull().default(''),
  blobSha256: text('blob_sha256').notNull(),
  /** queued | sending | delivered | failed | cancelled | expired */
  status: text('status').notNull().default('queued'),
  errorCode: text('error_code'),
  errorText: text('error_text'),
  savedAs: text('saved_as'),
  /** The offset of the last chunk the board fetched: progress, one chunk behind. */
  bytesSent: integer('bytes_sent').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [index('transfers_device_idx').on(t.deviceId, t.status, t.createdAt)]);
