import { pgTable, text, integer, boolean, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Published firmware releases, newest by `sequence`.
 *
 * GLOBAL, not org-scoped (spec D5): firmware is a product artifact, while
 * devices belong to orgs. Publishing requires super-admin; reading the list,
 * and seeing whether your own devices are behind, requires only membership.
 * Note that this is therefore NOT covered by the @example.test email boundary
 * that protects the rest of the schema from the e2e suite -- anything the
 * suite seeds here must be cleaned up by its own prefix (see
 * E2E_RELEASE_PREFIX in e2e/device-helpers.ts).
 *
 * `sequence` is the ordering authority and is assigned server-side as max+1.
 * It exists so that "is this board behind?" is a lookup rather than a version
 * comparison -- a bench build `1.0.0+gabc-dirty` would compare EQUAL to
 * released `1.0.0`, and reporting that board as up to date is the exact lie
 * this increment was built to remove. It is also what increment 2's
 * anti-rollback rule will read.
 *
 * `signature` is recorded but NOT verified by anything yet (spec §4). It is
 * stored from the first release so that increment 2 adds a check rather than
 * having to re-sign a registry's worth of history.
 */
export const firmwareReleases = pgTable('firmware_releases', {
  id: text('id').primaryKey(),
  /** The full reported string, e.g. `1.0.0+gd16a1da` -- what a device sends. */
  version: text('version').notNull(),
  /** Server-assigned, max+1 at publish. Never supplied by a client. */
  sequence: integer('sequence').notNull(),
  /** The hand-set half, e.g. `1.0.0`. Display, and the monotonicity check. */
  semver: text('semver').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** Private blob store pathname. Nothing serves it in this increment. */
  blobPath: text('blob_path').notNull(),
  /** ed25519 over the artifact's sha256, base64. Signed offline (spec D3). */
  signature: text('signature').notNull(),
  signingKeyId: text('signing_key_id').notNull(),
  notes: text('notes'),
  security: boolean('security').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  publishedByUserId: text('published_by_user_id').notNull(),
}, (t) => [
  unique('firmware_releases_version_key').on(t.version),
  unique('firmware_releases_sequence_key').on(t.sequence),
]);
