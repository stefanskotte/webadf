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
  mountedSha256: text('mounted_sha256'),
  // The exact disks row the device reports holding, resolved by recordStatus
  // from the status POST's mountedDiskId. Exists for the same reason
  // desiredDiskId does: (gameId, diskNo, orgId) is not unique, so plan 3b's
  // §7 rendering must not have to resolve (orgId, mountedSha256) back to a
  // disk row -- that lookup is exactly the non-unique one desiredDiskId was
  // added to avoid.
  mountedDiskId: text('mounted_disk_id'),
  // The desired_version the device had converged to when it sent this report
  // -- echoes the status payload's `version` field (spec §4). Nullable: a
  // device that has never sent it (or an older firmware) simply has none.
  mountedVersion: integer('mounted_version'),

  // --- firmware updates (spec 2026-09-22-firmware-update-server-design) ---

  /**
   * What this board's firmware can do, as IT reports. Absent or 0 means it
   * cannot be updated -- which is every board in the field today, and is what
   * keeps the Update control invisible rather than dead. The capability gate
   * protects the poll as well as the UI: a device that cannot report update
   * state can never be targeted, so it can never busy-loop the hold (spec 4.2).
   */
  updateProtocol: integer('update_protocol'),

  /**
   * The release this board should end up running. Null means no update is
   * wanted. It is CLEARED by recordStatus the moment the device reports this
   * exact version -- completion is derived from what the board is running,
   * never from the board claiming success.
   */
  desiredFirmwareVersion: text('desired_firmware_version'),
  desiredFirmwareSetAt: timestamp('desired_firmware_set_at', { withTimezone: true }),
  /** Who asked. The super-admin plane has no audit log; this does not repeat that. */
  desiredFirmwareSetByUserId: text('desired_firmware_set_by_user_id'),

  /**
   * 'queued' | 'downloading' | 'applying' | 'failed', as the device reports.
   * Null means nothing in flight -- and, while desiredFirmwareVersion is set,
   * null specifically means "not acknowledged yet", which is what releases the
   * poll's hold exactly once (spec 4.2).
   */
  firmwareUpdateState: text('firmware_update_state'),
  firmwareUpdateError: text('firmware_update_error'),

  // Desired state. Null across all three means ejected -- there is no separate
  // "ejected" flag, because "no disk is desired" and "eject" are the same fact.
  desiredSha256: text('desired_sha256'),
  desiredGameId: text('desired_game_id'),
  desiredDiskNo: integer('desired_disk_no'),
  // Primary-key reference to the exact disks row desired. (gameId, diskNo, orgId)
  // is not guaranteed unique -- re-ingesting a corrected image for the same
  // game and disk number lands a second disks row instead of replacing the
  // first (see src/app/api/ingest/complete/route.ts's stableId keyed on sha).
  // readDesired joins on this column so it can never pick the wrong row.
  desiredDiskId: text('desired_disk_id'),
  desiredSetAt: timestamp('desired_set_at', { withTimezone: true }),

  // Monotonic. The long-poll compares the device's `since` against this; an
  // integer is unambiguous where a timestamp is not, under clock skew or two
  // updates in the same millisecond.
  desiredVersion: integer('desired_version').notNull().default(0),

  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
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
