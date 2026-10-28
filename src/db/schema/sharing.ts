import { pgTable, text, boolean, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { collections } from './collections';

/** Owner side (spec §3.1): one row per person a library is shared with. Codes/tokens stored as sha256 hex only. */
export const libraryShares = pgTable('library_shares', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  label: text('label').notNull(),
  everything: boolean('everything').notNull().default(false),
  claimCodeHash: text('claim_code_hash'),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }).notNull(),
  tokenHash: text('token_hash'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedByUrl: text('claimed_by_url'),
  claimedByName: text('claimed_by_name'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
}, (t) => [
  index('library_shares_org_idx').on(t.orgId),
  uniqueIndex('library_shares_code_idx').on(t.claimCodeHash),
  uniqueIndex('library_shares_token_idx').on(t.tokenHash),
]);

export const libraryShareCollections = pgTable('library_share_collections', {
  shareId: text('share_id').notNull().references(() => libraryShares.id, { onDelete: 'cascade' }),
  collectionId: text('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.shareId, t.collectionId] }), index('library_share_collections_coll_idx').on(t.collectionId)]);

/** Recipient side (spec §4.1). token_enc: AES-256-GCM, key HKDF(BETTER_AUTH_SECRET, 'webadf-share-token'). */
export const remoteLibraries = pgTable('remote_libraries', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  baseUrl: text('base_url').notNull(),
  tokenEnc: text('token_enc').notNull(),
  tlsPin: text('tls_pin'),
  name: text('name').notNull(),
  status: text('status').notNull().default('ok'),   // 'ok' | 'unreachable' | 'ended' | 'protocol'
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  lastError: text('last_error'),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  addedBy: text('added_by').notNull(),
}, (t) => [index('remote_libraries_org_idx').on(t.orgId)]);
