import {
  pgTable, text, integer, timestamp, index, unique, primaryKey, foreignKey, customType,
} from 'drizzle-orm/pg-core';
import { disks } from './catalog';
import { devices } from './devices';

// Staged track bytes are the ONE bytea in this schema, deliberately (write-back
// spec §3.4): transient scratch, at most 160 x 5,632 bytes per open session,
// deleted at close. Disk images and history deltas live in the blob store.
const bytea = customType<{ data: Uint8Array; driverData: Buffer | string }>({
  dataType() { return 'bytea'; },
  toDriver(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); },
  fromDriver(v) {
    // neon-http returns bytea as a '\x..' hex string; the pg driver as a Buffer.
    if (typeof v === 'string') return Uint8Array.from(Buffer.from(v.slice(2), 'hex'));
    return new Uint8Array(v);
  },
});

/**
 * A disk's history, one row per version (write-back spec §3.4). Version 0 is
 * the image when history began (a snapshot of the blob the disk held then);
 * each later version is a snapshot or a sector delta, per chain.ts. Rows die
 * with the disk.
 */
export const diskVersions = pgTable('disk_versions', {
  id: text('id').primaryKey(),
  diskId: text('disk_id').notNull().references(() => disks.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind').notNull(),                 // 'snapshot' | 'delta'
  blobSha256: text('blob_sha256').notNull(),    // snapshot: the image; delta: the WDLD blob
  imageSha256: text('image_sha256').notNull(),  // the COMPLETE image at this version
  source: text('source').notNull(),             // 'original' | 'amiga' | 'browser' | 'rewind'
  deviceId: text('device_id'),
  userId: text('user_id'),
  rewindOf: integer('rewind_of'),
  sectorCount: integer('sector_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('disk_versions_disk_seq').on(t.diskId, t.seq),
  index('disk_versions_image_idx').on(t.imageSha256),
]);

/** An open write session: one per (device, mount). The idempotence key's high-water mark. */
export const diskWriteSessions = pgTable('disk_write_sessions', {
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  mount: integer('mount').notNull(),
  diskId: text('disk_id').notNull().references(() => disks.id, { onDelete: 'cascade' }),
  lastSeq: integer('last_seq').notNull().default(0),
  // Board-chosen per boot: a new token at the same mount is a new session, so a
  // rebooted board's seq 1 is never mistaken for a duplicate of the old one's.
  token: text('token').notNull(),
  // The disk's sha256 when the session opened: the image the board's tracks were
  // written over. Close overlays onto this, not onto a head that moved since.
  baseSha256: text('base_sha256').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.deviceId, t.mount] })]);

/** Tracks uploaded in an open session. A later upload of a track replaces it. */
export const diskWriteTracks = pgTable('disk_write_tracks', {
  deviceId: text('device_id').notNull(),
  mount: integer('mount').notNull(),
  track: integer('track').notNull(),
  data: bytea('data').notNull(),
}, (t) => [
  primaryKey({ columns: [t.deviceId, t.mount, t.track] }),
  foreignKey({
    columns: [t.deviceId, t.mount],
    foreignColumns: [diskWriteSessions.deviceId, diskWriteSessions.mount],
  }).onDelete('cascade'),
]);
