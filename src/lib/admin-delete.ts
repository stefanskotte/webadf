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

import { eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { entitlements, games, disks } from '@/db/schema/catalog';
import { devices, pairingCodes, invites } from '@/db/schema/devices';
import { user, member, organization } from '@/db/schema/auth';

export interface DeleteUserResult {
  orgId: string | null;
  games: number;
  disks: number;
  devices: number;
  /** Organizations removed because this user was their last member. */
  orgsRemoved: number;
}

/**
 * Delete a user and everything their organization owns.
 *
 * ATOMICITY. The plan called for "one transaction", which this driver cannot
 * do: drizzle's neon-http session throws "No transactions support in neon-http
 * driver" from .transaction(). db.batch() is the atomic primitive that does
 * exist -- neon's HTTP client wraps a batch in a single server-side
 * transaction -- so every delete below is built up first and then submitted as
 * one batch. It is non-interactive, which is why the reads that decide the
 * shape of the batch all happen before it.
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

  const stmts: BatchItem<'pg'>[] = [];
  // Indices are collected per organization and summed at the end. A single
  // variable would silently report only the last org's counts if a user ever
  // did hold two memberships -- the exact case the loop exists to handle.
  const gamesIdx: number[] = [];
  const disksIdx: number[] = [];
  const devicesIdx: number[] = [];

  for (const orgId of orgIds) {
    // entitlements first: they reference blobs, and clearing them is what
    // makes a blob reclaimable later by the backlog GC. Never blobs themselves.
    stmts.push(db.delete(entitlements).where(eq(entitlements.orgId, orgId)));

    // games cascades to disks via disks.game_id ON DELETE CASCADE...
    gamesIdx.push(stmts.push(
      db.delete(games).where(eq(games.orgId, orgId)).returning({ id: games.id }),
    ) - 1);
    // ...but a disk carries its OWN org_id, which is not required to match its
    // game's. This second delete catches a disk left behind because its game
    // belonged to a different organization. Not hypothetical bookkeeping: the
    // devices table already holds rows pointing at another org's game (see
    // HANDOFF's note on listDevices), so cross-org drift in this data is real.
    disksIdx.push(stmts.push(
      db.delete(disks).where(eq(disks.orgId, orgId)).returning({ id: disks.id }),
    ) - 1);

    devicesIdx.push(stmts.push(
      db.delete(devices).where(eq(devices.orgId, orgId)).returning({ id: devices.id }),
    ) - 1);
    stmts.push(db.delete(pairingCodes).where(eq(pairingCodes.orgId, orgId)));
    stmts.push(db.delete(invites).where(eq(invites.orgId, orgId)));
  }

  // The user last among the auth rows, so its cascade (session, account,
  // member, invitation) runs after everything scoped to the org is gone.
  stmts.push(db.delete(user).where(eq(user.id, userId)));

  if (soleOrgIds.length > 0) {
    stmts.push(db.delete(organization).where(inArray(organization.id, soleOrgIds)));
  }

  const results = await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);

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
