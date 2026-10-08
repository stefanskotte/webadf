import { pgTable, text, timestamp, index, integer, boolean, customType } from 'drizzle-orm/pg-core';

// bytea, used by devices.display_layout (a <=132-byte layout blob) and by
// disk-history's staged track bytes. Kept here because disk-history already
// imports this module (it references devices).
export const bytea = customType<{ data: Uint8Array; driverData: Buffer | string }>({
  dataType() { return 'bytea'; },
  toDriver(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); },
  fromDriver(v) {
    // neon-http returns bytea as a '\x..' hex string; the pg driver as a Buffer.
    if (typeof v === 'string') return Uint8Array.from(Buffer.from(v.slice(2), 'hex'));
    return new Uint8Array(v);
  },
});

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
   * The longest track (bytes a side) this board's firmware holds, as IT
   * reports in every status (TRACK_MAX_BYTES, psram_image.h). Null means a
   * build from before the field existed, which held 13312
   * (LEGACY_BOARD_TRACK_MAX_BYTES). The mount gate compares it with
   * disks.max_track_bits, so a board is never sent an image it would reject.
   */
  trackMaxBytes: integer('track_max_bytes'),

  /**
   * Whether this board's firmware answers the Amiga's drive-ID read as HD for
   * an HD disk (the drive_id PIO responder, WF_DRIVE_ID), as IT reports in
   * every status (HD spec §4.3, §5.5). False for every board before 1.4.0 and
   * for a build with the responder off. setDesired refuses an HD disk
   * anywhere else (hd_unsupported): without the ID the Amiga reads it with DD
   * geometry and fails at the first block where the layouts differ.
   */
  playsHd: boolean('plays_hd').notNull().default(false),

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
   * Monotonic, bumped every time the desired firmware CHANGES -- set, changed,
   * or cancelled. The device echoes back the highest it has seen as
   * firmwareInstructionAck, and the poll releases its hold while
   * firmwareInstructionVersion > firmwareInstructionAck.
   *
   * This is a CURSOR, not a flag, and that is the whole point. The first
   * design used "firmwareUpdateState is null" to mean "has not seen it",
   * which cannot express: a second request while the first is in flight, a
   * retry of a version the board already failed, or a cancellation a board
   * has already acknowledged (it would simply never hear about it and would
   * flash the withdrawn release at the next eject). Every other wake on this
   * route is an edge-triggered cursor comparison; this one now matches.
   *
   * Deliberately NOT desiredVersion: the device echoes that back as
   * mountedVersion and the server reads it for an upload's
   * not_mounted/behind verdict (HANDOFF 4g), so bumping it to announce
   * firmware could strand an Amiga write mid-session.
   */
  firmwareInstructionVersion: integer('firmware_instruction_version').notNull().default(0),
  /** The highest instruction version the device says it has seen. */
  firmwareInstructionAck: integer('firmware_instruction_ack').notNull().default(0),

  // --- NFC tap-to-mount (spec 2026-09-25) ---

  // 'present' | 'absent' as the board last reported; NULL = a board that has
  // never said (older firmware).
  nfcReader: text('nfc_reader'),
  // The write request (spec §5.3): a cursor the board echoes as ?nfcAck=,
  // never a flag -- a cancel and a retry are both just the next seq.
  nfcWriteSeq: integer('nfc_write_seq').notNull().default(0),
  nfcWriteDiskId: text('nfc_write_disk_id'),
  nfcWriteExpiresAt: timestamp('nfc_write_expires_at', { withTimezone: true }),
  nfcWriteResultSeq: integer('nfc_write_result_seq'),
  nfcWriteResult: text('nfc_write_result'),
  nfcWriteResultUid: text('nfc_write_result_uid'),
  lastTapAt: timestamp('last_tap_at', { withTimezone: true }),
  lastTapOutcome: text('last_tap_outcome'),
  // What an armed NFC write puts on the tag (multi-disk spec §3.4): 'disk' =
  // nfcWriteDiskId, 'next' = the universal Next-disk card (no disk id).
  nfcWriteKind: text('nfc_write_kind').notNull().default('disk'),
  // What the board says its idle slot holds (spec §3.5, plan R3): 'loading',
  // 'ready', or 'none' (it reported nothing preloaded). NULL = firmware too
  // old to report -- the UI then says nothing rather than guessing.
  preloadSha256: text('preload_sha256'),
  preloadState: text('preload_state'),

  // --- OLED display layouts (spec 2026-10-04-oled-layouts §7) ---

  /** '128x32' | '128x64': the panel the user says this board has. */
  displayPanel: text('display_panel').notNull().default('128x32'),
  /** The layout blob (spec §5), validated by the board's own C validator; null = the panel's default. */
  displayLayout: bytea('display_layout'),
  /**
   * Cursor, bumped on every save or reset. The board echoes the highest
   * version it has HANDLED (applied or rejected) as ?displayAck=, and the poll
   * wakes while displayVersion > displayAck -- so a rejected layout cannot loop.
   */
  displayVersion: integer('display_version').notNull().default(0),
  /** The board's displayAck as it last reported in a status; null = never reported. */
  displayAppliedVersion: integer('display_applied_version'),
  /** Why the board rejected the layout at displayAppliedVersion; null = applied. */
  displayError: text('display_error'),
  /** The capability, as the board reports; null = never said, false = firmware before 1.7.0. */
  displayLayouts: boolean('display_layouts'),

  // --- DF1 second drive (spec 2026-10-08) ---
  /** A SEL1 select reached the board since its last boot; null = firmware before 1.7.6. */
  sel1Wired: boolean('sel1_wired'),
  /** A real drive stepped as DF1 while the board's own DF1 was off; null = firmware before 1.7.6. */
  df1Seen: boolean('df1_seen'),

  /**
   * 'queued' | 'downloading' | 'applying' | 'failed', as the device reports.
   * Null means nothing in flight. It is telemetry for the operator -- it no
   * longer decides whether the poll wakes, which is what the cursor above is
   * for.
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
