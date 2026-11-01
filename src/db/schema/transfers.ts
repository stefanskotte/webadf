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
  /** queued | sending | delivered | failed | cancelled | expired | skipped (a copy onto a volume answered Skip) */
  status: text('status').notNull().default('queued'),
  errorCode: text('error_code'),
  errorText: text('error_text'),
  savedAs: text('saved_as'),
  /** The offset of the last chunk the board fetched: progress, one chunk behind. */
  bytesSent: integer('bytes_sent').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  /**
   * NET: volumes phase 2 (spec 2026-10-31 §4.1): a copy onto one of the Amiga's volumes. `amiga_dest` is the absolute
   * Amiga path (`Work:Tools/x`, Latin-1 characters), `on_clash` keep | replace | skip; both null for an ordinary send
   * into ReceiveDir. `job_id`: the Files operation the row belongs to (its progress, plan W6); `move_source`: the Files
   * path a move removes once every row of its job naming it is delivered (plan W7). A board is offered such a row only
   * while it reports writing on (rxv=4, write=1).
   */
  amigaDest: text('amiga_dest'),
  onClash: text('on_clash'),
  jobId: text('job_id'),
  moveSource: text('move_source'),
  /**
   * Spec 2026-10-31 §9: the entry of `move_source` this row copies, as its path from the moved entry (`Pack/sub/x`, the
   * first part the moved entry's own name as it was collected), so the move removes exactly what was copied.
   */
  moveItem: text('move_item'),
  /**
   * The last chunk the board fetched for this row (plan 2026-11-01-net-consistency, item 8): a `sending` row is a file
   * moving only while this is recent, so one left sending when Transfer stopped holds nothing up (amiga_uploads.active_at's twin).
   */
  activeAt: timestamp('active_at', { withTimezone: true }),
},(t) => [index('transfers_device_idx').on(t.deviceId, t.status, t.createdAt), index('transfers_job_idx').on(t.jobId)]);
