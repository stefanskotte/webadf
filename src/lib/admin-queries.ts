// Unscoped queries. EVERY other query in this codebase goes through
// orgFilter() (src/db/scope.ts, "the single chokepoint for tenant
// isolation"); these deliberately do not, which is why they live here and
// nowhere else.
//
// IMPORT BOUNDARY: only src/app/(admin)/** and src/app/api/admin/** may
// import this module. A helper in src/lib/queries.ts that grew an unscoped
// variant would be a cross-tenant leak the same shape as the one plan 3b's
// review caught; keeping the unscoped set in a quarantined module is what
// makes that mistake visible in review rather than invisible in a diff.

import { sql, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { user, member, organization } from '@/db/schema/auth';
import { invites } from '@/db/schema/devices';

export interface AdminCounts {
  users: number; orgs: number; games: number; disks: number;
  blobs: number; liveInvites: number;
}

export interface AdminUserRow {
  userId: string; email: string; name: string | null; createdAt: Date;
  orgId: string | null; orgName: string | null;
  games: number; disks: number; devices: number;
}

export type InviteState = 'live' | 'consumed' | 'expired';

export interface AdminInviteRow {
  code: string; state: InviteState; createdAt: Date; expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * Six count(*) reads in one round trip -- the admin dashboard's headline
 * numbers. `getDb().execute()` on the neon-http driver resolves to an object
 * with a `.rows` array (see NeonHttpQueryResult in drizzle-orm/neon-http),
 * not to the rows themselves, so the row is pulled off `.rows[0]`. Every
 * count still gets an explicit ::int cast -- Postgres returns count(*) as
 * bigint, which the driver hands back as a string without it -- and each
 * value is additionally wrapped in Number() as a second line of defense.
 */
export async function adminCounts(): Promise<AdminCounts> {
  const { rows } = await getDb().execute<{
    users: number; orgs: number; games: number; disks: number;
    blobs: number; live_invites: number;
  }>(sql`
    select
      (select count(*)::int from auth."user")                       as users,
      (select count(*)::int from auth.organization)                 as orgs,
      (select count(*)::int from games)                             as games,
      (select count(*)::int from disks)                             as disks,
      (select count(*)::int from blobs)                             as blobs,
      (select count(*)::int from invites
        where consumed_at is null and expires_at > now())           as live_invites
  `);
  const row = rows[0];
  return {
    users: Number(row.users), orgs: Number(row.orgs), games: Number(row.games),
    disks: Number(row.disks), blobs: Number(row.blobs),
    liveInvites: Number(row.live_invites),
  };
}

/**
 * auth.user left-joined to auth.member and auth.organization -- left, not
 * inner, because a user whose organization bootstrap failed (see
 * bootstrapOrganization / the session.create.before self-heal in
 * src/lib/auth.ts) still has a row here, and this list is exactly where an
 * operator wants to see them. orgId/orgName are nullable for that reason.
 *
 * games/disks/devices are correlated subqueries keyed off the joined
 * member row's organization_id rather than a join-and-group-by. Note: the
 * organization plugin's addMember API allows a user to hold more than one
 * membership, even though nothing in this app's own sign-up/invite flow
 * creates a second one today (see the "multiple memberships" comment on
 * lookupActiveOrgId in src/lib/auth.ts). A plain left join -- which is what
 * this function and the brief both use -- would fan a user with two
 * memberships out into two rows. That is a known, accepted limitation for
 * this task rather than one hidden behind a DISTINCT or a LATERAL join.
 *
 * Ordered by created_at DESC so a newly created account is on page one,
 * with user.id as a tiebreaker. The tiebreaker is NOT cosmetic: created_at
 * is not unique in the live database (measured 2026-08-31 -- five groups of
 * users share a timestamp, one of them three ways, because the e2e suite
 * signs accounts up in bursts). ORDER BY on a non-unique key with
 * LIMIT/OFFSET is an unstable sort: Postgres may order tied rows differently
 * between the query for page N and the query for page N+1, which silently
 * shows one user twice and skips another entirely. Since this list is how an
 * operator finds a user in order to delete them, a silently skipped row is
 * the bad direction to fail in. (created_at, id) is unique because id is the
 * primary key, so the order is now total.
 *
 * Pagination (limit/offset) is required, not optional: production holds
 * 2,863 users.
 */
export async function adminListUsers(opts: { limit: number; offset: number }): Promise<AdminUserRow[]> {
  return getDb()
    .select({
      userId: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      orgId: organization.id,
      orgName: organization.name,
      games: sql<number>`(select count(*)::int from games where org_id = ${member.organizationId})`,
      disks: sql<number>`(select count(*)::int from disks where org_id = ${member.organizationId})`,
      devices: sql<number>`(select count(*)::int from devices where org_id = ${member.organizationId})`,
    })
    .from(user)
    .leftJoin(member, eq(member.userId, user.id))
    .leftJoin(organization, eq(organization.id, member.organizationId))
    .orderBy(desc(user.createdAt), desc(user.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

/** Total user count, for computing page count against adminListUsers' pagination. */
export async function adminCountUsers(): Promise<number> {
  const { rows } = await getDb().execute<{ count: number }>(
    sql`select count(*)::int as count from auth."user"`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Invite codes with their state derived once in SQL, not recomputed from
 * three columns on the page (and risking disagreeing with itself). Live
 * codes first -- the ones an operator can actually act on -- then newest
 * first.
 */
export async function adminListInvites(limit: number = 200): Promise<AdminInviteRow[]> {
  const state = sql<InviteState>`case
    when ${invites.consumedAt} is not null then 'consumed'
    when ${invites.expiresAt} <= now()     then 'expired'
    else 'live'
  end`;

  return getDb()
    .select({
      code: invites.code,
      state,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      consumedAt: invites.consumedAt,
    })
    .from(invites)
    .orderBy(sql`(${state} = 'live') desc`, desc(invites.createdAt))
    .limit(limit);
}
