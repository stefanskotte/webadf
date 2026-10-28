// blobs is deliberately absent and must stay absent. It is keyed by sha256
// alone, has no orgId, and is the content-addressed dedupe store -- the
// parent spec records 26+ blobs already shared across organizations.
// Deleting one because this tenant held the last reference would silently
// corrupt a different tenant's library, turning a cleanup into data loss for
// someone who did nothing. Orphaned blobs are a storage cost, not a
// correctness problem; reclaiming them needs cross-org reference counting
// and is backlog (spec S8).
//
// The database backs this up independently: entitlements.sha256 and
// disks.sha256 both reference blobs.sha256 with NO cascade, so a blob with a
// live reference cannot be deleted even by accident. That is a second lock,
// not a reason to relax the first -- the rows referencing it are exactly what
// this function removes.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { atomic } from '@/db/atomic';
import { getDb } from '@/db';
import { entitlements, games, disks } from '@/db/schema/catalog';
import { devices, pairingCodes, invites } from '@/db/schema/devices';
import { user, member, organization } from '@/db/schema/auth';
import { collections } from '@/db/schema/collections';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { libraryShares, remoteLibraries } from '@/db/schema/sharing';

export interface DeleteUserResult {
  orgId: string | null;
  games: number;
  disks: number;
  devices: number;
  /** Organizations removed because this user was their last member. */
  orgsRemoved: number;
}

/**
 * How many OTHER people share an organization with `userId` (across every membership). Self-service delete refuses
 * when this is above zero: deleteUserCascade below removes everything each of the user's organizations owns, which
 * would be the other members' library too. Nothing in the app adds a second member today, so this is 0 in practice.
 */
export async function otherMemberCount(userId: string): Promise<number> {
  const db = getDb();
  const mine = db.select({ id: member.organizationId }).from(member).where(eq(member.userId, userId));
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${member.userId})::int` })
    .from(member)
    .where(and(inArray(member.organizationId, mine), ne(member.userId, userId)));
  return Number(row?.n ?? 0);
}

/**
 * Delete a user and everything their organization owns.
 *
 * ATOMICITY. Every delete below is built up first and then submitted
 * through atomic(): one transaction, all or nothing, results in order. The
 * reads that decide the shape of the statements all happen before it, outside
 * the transaction, and every statement is built from the transaction handle.
 *
 * THE ORGANIZATION IS NOT CASCADED, contrary to the plan's text. auth.user has
 * cascading children (session, account, member, invitation), but
 * auth.organization has no foreign key to auth.user at all -- deleting the user
 * removes their membership and leaves the organization behind as an orphan.
 * Verified against the schema; the live counts show the same asymmetry from
 * the other side (2,863 users against 2,862 organizations). So the org is
 * deleted explicitly, and only when this user was its last member: an
 * organization with someone else still in it is that person's, not ours to
 * remove.
 *
 * RACE. Between the reads and the batch, someone could join an organization
 * this call is about to delete. The window is milliseconds, the only writer is
 * a sign-up, and nothing in this app's flow adds a second member to an existing
 * org today (see Ruling 4). Recorded rather than defended against.
 */
export async function deleteUserCascade(userId: string): Promise<DeleteUserResult> {
  const db = getDb();

  // A user normally has exactly one membership, but the schema permits more,
  // so this handles the set rather than assuming the first row is the whole
  // story.
  const memberships = await db
    .select({ orgId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  const orgIds = [...new Set(memberships.map((m) => m.orgId))];

  // Which of those organizations this user is the LAST member of. Only those
  // get removed along with them.
  const soleOrgIds: string[] = [];
  if (orgIds.length > 0) {
    const counts = await db
      .select({ orgId: member.organizationId, n: sql<number>`count(*)::int` })
      .from(member)
      .where(inArray(member.organizationId, orgIds))
      .groupBy(member.organizationId);
    for (const c of counts) if (Number(c.n) === 1) soleOrgIds.push(c.orgId);
  }

  // Indices are collected per organization and summed at the end. A single
  // variable would silently report only the last org's counts if a user ever
  // did hold two memberships -- the exact case the loop exists to handle.
  const gamesIdx: number[] = [];
  const disksIdx: number[] = [];
  const devicesIdx: number[] = [];

  const results = await atomic((tx) => {
  const stmts: PromiseLike<unknown>[] = [];
  for (const orgId of orgIds) {
    // entitlements first: they reference blobs, and clearing them is what
    // makes a blob reclaimable later by the backlog GC. Never blobs themselves.
    stmts.push(tx.delete(entitlements).where(eq(entitlements.orgId, orgId)));

    // collection_games follows by cascade from collections.id. Placed before
    // the games delete below: both would work (the games cascade would also
    // clear membership), but deleting collections first removes the rows for
    // the reason they actually belong to this org, rather than incidentally.
    stmts.push(tx.delete(collections).where(eq(collections.orgId, orgId)));

    // games cascades to disks via disks.game_id ON DELETE CASCADE...
    gamesIdx.push(stmts.push(
      tx.delete(games).where(eq(games.orgId, orgId)).returning({ id: games.id }),
    ) - 1);
    // ...but a disk carries its OWN org_id, which is not required to match its
    // game's. This second delete catches a disk left behind because its game
    // belonged to a different organization. Not hypothetical bookkeeping: the
    // devices table already holds rows pointing at another org's game (see
    // HANDOFF's note on listDevices), so cross-org drift in this data is real.
    disksIdx.push(stmts.push(
      tx.delete(disks).where(eq(disks.orgId, orgId)).returning({ id: disks.id }),
    ) - 1);

    // The org's From the Amiga area (spec 2026-10-18): its device_id is set null when a board goes, so the org's
    // own delete is what removes it (chunks follow by cascade). Blobs are left to the weekly GC, as everywhere here.
    stmts.push(tx.delete(amigaUploads).where(eq(amigaUploads.orgId, orgId)));

    // Library sharing: the org's shares as an owner (their collection links follow by cascade), and the libraries it
    // added as a recipient. remote_libraries AFTER games and disks: hidden rows name it with no cascade.
    stmts.push(tx.delete(libraryShares).where(eq(libraryShares.orgId, orgId)));
    stmts.push(tx.delete(remoteLibraries).where(eq(remoteLibraries.orgId, orgId)));

    devicesIdx.push(stmts.push(
      tx.delete(devices).where(eq(devices.orgId, orgId)).returning({ id: devices.id }),
    ) - 1);
    stmts.push(tx.delete(pairingCodes).where(eq(pairingCodes.orgId, orgId)));
    stmts.push(tx.delete(invites).where(eq(invites.orgId, orgId)));
  }

  // The user last among the auth rows, so its cascade (session, account,
  // member, invitation) runs after everything scoped to the org is gone.
  stmts.push(tx.delete(user).where(eq(user.id, userId)));

  if (soleOrgIds.length > 0) {
    stmts.push(tx.delete(organization).where(inArray(organization.id, soleOrgIds)));
  }

  return stmts;
  });

  const total = (idx: number[]) =>
    idx.reduce((n, i) => n + (results[i] as unknown[]).length, 0);
  return {
    orgId: orgIds[0] ?? null,
    games: total(gamesIdx),
    disks: total(disksIdx),
    devices: total(devicesIdx),
    orgsRemoved: soleOrgIds.length,
  };
}
