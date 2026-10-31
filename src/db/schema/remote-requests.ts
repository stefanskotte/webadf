import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { devices } from './devices';

/**
 * NET: volumes (spec 2026-10-30 §4.1): one request from Files to a board's Transfer. kind vols | dir | get; status
 * waiting (not yet fetched by the board) | sent | fetching (get: GOT seen) | done | failed. `answer`: the parsed
 * volumes or entries (vols/dir); `target`: where a get's file goes ({fetchId, dest, rel, replace}); `upload_id`: the
 * amiga_uploads row a get's file arrives in.
 */
export const remoteRequests = pgTable('remote_requests', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  /** The Amiga's own path, `Work:Programs` (vols: ''). Latin-1 characters, as UTF-8 text. */
  amigaPath: text('amiga_path').notNull().default(''),
  status: text('status').notNull().default('waiting'),
  errorCode: text('error_code'),
  errorText: text('error_text'),
  answer: jsonb('answer'),
  pieces: integer('pieces').notNull().default(0),
  cut: boolean('cut').notNull().default(false),
  target: jsonb('target'),
  fetchId: text('fetch_id'),
  uploadId: text('upload_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  /**
   * The last sign of life: taken by the board, a piece of its answer (any kind), and for a get its GOT, its upload
   * opened or a chunk stored. A get's 10-minute timeout and a listing's 60 s run from it (A500 bench 2026-10-31).
   */
  activeAt: timestamp('active_at', { withTimezone: true }),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
}, (t) => [
  index('remote_requests_device_idx').on(t.deviceId, t.status, t.createdAt),
  index('remote_requests_path_idx').on(t.deviceId, t.kind, t.amigaPath, t.createdAt),
  index('remote_requests_fetch_idx').on(t.fetchId),
  // Every chunk of every upload looks up its get (if any) by upload_id.
  index('remote_requests_upload_idx').on(t.uploadId),
]);
