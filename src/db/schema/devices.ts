import { pgTable, text, timestamp, index, integer } from 'drizzle-orm/pg-core';

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),          // normalized, uppercase
  orgId: text('org_id').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedByUserId: text('consumed_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('invites_org_idx').on(t.orgId)]);

export const devices = pgTable('devices', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),   // sha-256 hex of the plaintext
  firmwareVersion: text('firmware_version'),
  macAddress: text('mac_address'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  rssi: integer('rssi'),
  psramFree: integer('psram_free'),
  mountedGameId: text('mounted_game_id'),
  mountedDiskNo: integer('mounted_disk_no'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('devices_org_idx').on(t.orgId)]);

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  orgId: text('org_id').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('pairing_codes_org_idx').on(t.orgId)]);

export const mountJobs = pgTable('mount_jobs', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  gameId: text('game_id').notNull(),
  diskNo: integer('disk_no').notNull(),
  sha256: text('sha256').notNull(),
  state: text('state').notNull().default('queued'),  // queued|claimed|done|failed
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('mount_jobs_device_state_idx').on(t.deviceId, t.state),
  index('mount_jobs_org_idx').on(t.orgId),
]);
