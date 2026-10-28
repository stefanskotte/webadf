import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { getDb } from '@/db';
import { atomic } from '@/db/atomic';
import { collections } from '@/db/schema/collections';
import { libraryShares, libraryShareCollections } from '@/db/schema/sharing';
import { tokensMatch } from '@/lib/device-token';
import { hashSecret, mintClaimCode, mintShareToken } from './tokens';

export type ShareStatus = 'waiting' | 'expired' | 'claimed' | 'revoked';

export type ShareRow = {
  id: string;
  label: string;
  everything: boolean;
  collectionIds: string[];
  status: ShareStatus;
  claimExpiresAt: Date;
  claimedAt: Date | null;
  claimedByUrl: string | null;
  claimedByName: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

const CLAIM_TTL_MS = 7 * 86_400_000;
const BUMP_EVERY_MS = 60_000;

type Row = typeof libraryShares.$inferSelect;

function statusOf(r: Row, now: Date): ShareStatus {
  if (r.revokedAt) return 'revoked';
  if (r.claimedAt) return 'claimed';
  if (r.claimExpiresAt.getTime() <= now.getTime()) return 'expired';
  return 'waiting';
}

function toRow(r: Row, collectionIds: string[], now: Date): ShareRow {
  return {
    id: r.id, label: r.label, everything: r.everything, collectionIds,
    status: statusOf(r, now), claimExpiresAt: r.claimExpiresAt, claimedAt: r.claimedAt,
    claimedByUrl: r.claimedByUrl, claimedByName: r.claimedByName, lastUsedAt: r.lastUsedAt, createdAt: r.createdAt,
  };
}

/** True when every id is a collection of orgId (ids are de-duplicated first). */
async function allOwnedCollections(orgId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const found = await getDb().select({ id: collections.id }).from(collections)
    .where(and(eq(collections.orgId, orgId), inArray(collections.id, ids)));
  return found.length === ids.length;
}

export async function createShare(
  orgId: string,
  userId: string,
  input: { label: string; everything: boolean; collectionIds: string[] },
): Promise<{ ok: true; share: ShareRow; code: string } | { ok: false; reason: 'bad_label' | 'no_scope' | 'bad_collection' }> {
  const label = input.label.trim();
  if (label.length < 1 || label.length > 60) return { ok: false, reason: 'bad_label' };
  const ids = input.everything ? [] : [...new Set(input.collectionIds)];
  if (!input.everything && ids.length === 0) return { ok: false, reason: 'no_scope' };
  if (!(await allOwnedCollections(orgId, ids))) return { ok: false, reason: 'bad_collection' };

  const code = mintClaimCode();
  const id = randomUUID();
  const now = new Date();
  await atomic((tx) => [
    tx.insert(libraryShares).values({
      id, orgId, label, everything: input.everything, claimCodeHash: code.hash,
      claimExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS), createdAt: now, createdBy: userId,
    }),
    ...(ids.length ? [tx.insert(libraryShareCollections).values(ids.map((collectionId) => ({ shareId: id, collectionId })))] : []),
  ]);
  const [row] = await getDb().select().from(libraryShares).where(eq(libraryShares.id, id));
  return { ok: true, share: toRow(row, ids, now), code: code.plaintext };
}

export async function listShares(orgId: string, now: Date = new Date()): Promise<ShareRow[]> {
  const db = getDb();
  const rows = await db.select().from(libraryShares).where(eq(libraryShares.orgId, orgId)).orderBy(asc(libraryShares.createdAt));
  if (rows.length === 0) return [];
  const links = await db.select().from(libraryShareCollections)
    .where(inArray(libraryShareCollections.shareId, rows.map((r) => r.id)));
  const by = new Map<string, string[]>();
  for (const l of links) by.set(l.shareId, [...(by.get(l.shareId) ?? []), l.collectionId]);
  return rows.map((r) => toRow(r, (by.get(r.id) ?? []).sort(), now));
}

export async function updateShareScope(
  orgId: string, shareId: string, input: { everything: boolean; collectionIds: string[] },
): Promise<boolean> {
  const ids = input.everything ? [] : [...new Set(input.collectionIds)];
  const [own] = await getDb().select({ id: libraryShares.id }).from(libraryShares)
    .where(and(eq(libraryShares.id, shareId), eq(libraryShares.orgId, orgId)));
  if (!own) return false;
  if (!(await allOwnedCollections(orgId, ids))) return false;
  await atomic((tx) => [
    tx.update(libraryShares).set({ everything: input.everything }).where(eq(libraryShares.id, shareId)),
    tx.delete(libraryShareCollections).where(eq(libraryShareCollections.shareId, shareId)),
    ...(ids.length ? [tx.insert(libraryShareCollections).values(ids.map((collectionId) => ({ shareId, collectionId })))] : []),
  ]);
  return true;
}

/** Idempotent: an already revoked share answers true and keeps its first timestamp. */
export async function revokeShare(orgId: string, shareId: string): Promise<boolean> {
  const db = getDb();
  const [own] = await db.select({ id: libraryShares.id }).from(libraryShares)
    .where(and(eq(libraryShares.id, shareId), eq(libraryShares.orgId, orgId)));
  if (!own) return false;
  await db.update(libraryShares).set({ revokedAt: new Date() })
    .where(and(eq(libraryShares.id, shareId), isNull(libraryShares.revokedAt)));
  return true;
}

/** Only a revoked share or an unclaimed share whose code has expired may be deleted. */
export async function deleteShare(orgId: string, shareId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await getDb().delete(libraryShares).where(and(
    eq(libraryShares.id, shareId), eq(libraryShares.orgId, orgId),
    or(
      isNotNull(libraryShares.revokedAt),
      and(isNull(libraryShares.claimedAt), lt(libraryShares.claimExpiresAt, now)),
    ),
  )).returning({ id: libraryShares.id });
  return rows.length > 0;
}

/** One atomic UPDATE (as claimInvite): of two racing claims with one code, exactly one matches. */
export async function claimShare(
  code: string, claimant: { url: string; name: string }, now: Date = new Date(),
): Promise<{ ok: true; token: string; orgId: string; shareId: string } | { ok: false }> {
  const token = mintShareToken();
  const rows = await getDb().update(libraryShares).set({
    claimCodeHash: null, tokenHash: token.hash, claimedAt: now,
    claimedByUrl: claimant.url, claimedByName: claimant.name,
  }).where(and(
    eq(libraryShares.claimCodeHash, hashSecret(code)),
    isNull(libraryShares.revokedAt),
    gt(libraryShares.claimExpiresAt, now),
  )).returning({ id: libraryShares.id, orgId: libraryShares.orgId });
  const row = rows[0];
  if (!row) return { ok: false };
  return { ok: true, token: token.plaintext, orgId: row.orgId, shareId: row.id };
}

export type ShareAuth = { shareId: string; orgId: string; everything: boolean };

export async function authenticateShare(bearer: string | null, now: Date = new Date()): Promise<ShareAuth | null> {
  const m = bearer ? /^Bearer\s+(wfst_\S+)$/i.exec(bearer) : null;
  if (!m) return null;
  const hash = hashSecret(m[1]);
  const db = getDb();
  const [row] = await db.select().from(libraryShares).where(eq(libraryShares.tokenHash, hash));
  if (!row || !row.tokenHash || !tokensMatch(row.tokenHash, hash) || row.revokedAt) return null;
  // At most once a minute; the WHERE makes concurrent requests a no-op for all but one.
  await db.update(libraryShares).set({ lastUsedAt: now }).where(and(
    eq(libraryShares.id, row.id),
    or(isNull(libraryShares.lastUsedAt), lt(libraryShares.lastUsedAt, new Date(now.getTime() - BUMP_EVERY_MS))),
  ));
  return { shareId: row.id, orgId: row.orgId, everything: row.everything };
}
