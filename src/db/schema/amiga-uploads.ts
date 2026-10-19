import { bigint, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { bytea, devices } from './devices';

/**
 * The org's "From the Amiga" area (spec 2026-10-18 §4, U6): files a board's Receive sent up. `receiving` while its
 * chunks stage in amiga_upload_chunks (as write-back stages tracks: functions are stateless and blob stores cannot
 * append), `stored` once the close checked size and CRC-32 and put the bytes in the disk store under blob_sha256 (blob
 * GC keeps them while the row is not deleted), `failed` (crc, expired) or `deleted`.
 */
export const amigaUploads = pgTable('amiga_uploads', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
  /** The board's name when the upload opened: the row still names it after the board is unpaired or renamed. */
  deviceName: text('device_name').notNull(),
  /** UTF-8, decoded from Latin-1 and cleaned (cleanAmigaPath). Data only: never a storage key. */
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** Set at the close: the CRC-32 Receive sent -- which the bytes matched (stored) or did not (failed, crc). */
  crc32: bigint('crc32', { mode: 'number' }),
  protection: bigint('protection', { mode: 'number' }).notNull().default(0),
  comment: text('comment').notNull().default(''),
  /** The Amiga's DateStamp, days.mins.ticks: it identifies the file for resume, nothing else. */
  amigaDate: text('amiga_date').notNull(),
  /** receiving | stored | failed | deleted */
  status: text('status').notNull().default('receiving'),
  receivedBytes: integer('received_bytes').notNull().default(0),
  errorCode: text('error_code'),
  blobSha256: text('blob_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  storedAt: timestamp('stored_at', { withTimezone: true }),
  /** receiving: the 24 h resume window; stored: the 30 days it is kept. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Set by Add to library. */
  libraryDiskId: text('library_disk_id'),
}, (t) => [
  index('amiga_uploads_org_idx').on(t.orgId, t.createdAt),
  index('amiga_uploads_device_idx').on(t.deviceId, t.status),
]);

/** One staged 16 KB chunk (the last may be shorter), deleted at the close. */
export const amigaUploadChunks = pgTable('amiga_upload_chunks', {
  uploadId: text('upload_id').notNull().references(() => amigaUploads.id, { onDelete: 'cascade' }),
  offset: integer('offset').notNull(),
  data: bytea('data').notNull(),
}, (t) => [primaryKey({ columns: [t.uploadId, t.offset] })]);
