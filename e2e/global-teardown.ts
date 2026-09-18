import { sql, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, disks, entitlements } from '@/db/schema/catalog';
import { deleteUserCascade } from '@/lib/admin-delete';
import { selectUnreferencedBlobs } from '@/lib/blob-gc';
import { diskStore } from '@/lib/storage';

/**
 * Remove everything the suite created, from the live database it ran against.
 *
 * This runs in TEARDOWN rather than being threaded through the helpers on
 * purpose. Per-spec cleanup already exists (cleanupSeeded) and is worth
 * keeping for within-run tidiness, but it only ever removes what a spec
 * remembered to register -- and four specs create data through the REAL
 * ingest flow and register nothing at all. Before this file, one run of the
 * suite left roughly 70 users, orgs, games and disks behind permanently.
 *
 * THE SAFETY BOUNDARY IS THE EMAIL DOMAIN, and it is the only thing standing
 * between this and the operator's real library. Every account the suite
 * creates is @example.test (see signUpFresh and SUPERADMIN_EMAIL); the
 * operator's account is not. Nothing here may ever widen that predicate.
 */

/** Accounts the suite creates. The operator's real address is not one. */
const TEST_EMAIL = '%@example.test';

/**
 * The allowlisted admin, which signInAsSuperAdmin creates once and REUSES on
 * every later run. Deleting it would not lose data, but the next run would
 * pay a sign-up for it again -- and, more to the point, its address has to
 * keep matching SUPERADMIN_EMAILS in .env.local for the admin specs to work
 * at all. Left in place deliberately.
 */
const KEEP = 'admin@example.test';

/**
 * NO INVITE CODE MAY SURVIVE THIS SUITE. That is the security-relevant half
 * of this teardown, not the row count: registration is invite-only, each
 * unconsumed unexpired code is a working credential to create an account in
 * production, and invite-only registration is what bounds the ingest
 * existence oracle (D13).
 *
 * Two populations exist and NEITHER is reachable by deleteUserCascade, which
 * only ever deletes invites belonging to the org of the user it is deleting:
 *
 *  - Codes minted under a PLACEHOLDER org id. mintInviteCode issues under
 *    'e2e-seed-org' because its callers are trying to create their first real
 *    org and have none yet; ad-hoc scripts have used others. No organization
 *    row has these ids, so no cascade can ever match them. 4,144 had
 *    accumulated. Matching on "the org does not exist" rather than on a list
 *    of known placeholders means a future helper inventing its own id is
 *    caught automatically.
 *
 *  - Codes belonging to the KEPT admin account below. Because that account
 *    deliberately survives, admin-invites.spec.ts's real issued codes survive
 *    with it -- 14 of them were live.
 */

export default async function globalTeardown() {
  const db = getDb();
  let users = 0;
  let games = 0;
  let orphanBlobs = 0;
  let objectsRemoved = 0;

  try {
    const doomed = await db.execute<{ id: string }>(sql`
      select id from auth."user"
      where email like ${TEST_EMAIL} and email <> ${KEEP}`);

    // Delta blobs live only in the blob store (never a `blobs` row), and the
    // disk_versions rows naming them cascade away with the user below -- after
    // which nothing could ever find them again.
    const deltas = await db.execute<{ sha: string }>(sql`
      select distinct v.blob_sha256 as sha from disk_versions v
      join disks d on d.id = v.disk_id
      join auth."member" m on m.organization_id = d.org_id
      join auth."user" u on u.id = m.user_id
      where v.kind = 'delta' and u.email like ${TEST_EMAIL} and u.email <> ${KEEP}`);
    for (const { sha } of deltas.rows) {
      try { await diskStore.remove(sha); } catch { /* never uploaded, or already gone */ }
    }

    for (const row of doomed.rows) {
      try {
        // The application's OWN cascade, already covered by
        // admin-delete.spec.ts -- orgs, members, games, disks, entitlements,
        // devices, pairing codes, collections and invites. Reusing it means
        // the teardown cannot drift from the behaviour the app actually has.
        //
        // Collections are reachable ONLY through a real user's org, so a
        // fixture that ever creates one under a placeholder org id would
        // leak it permanently -- the same shape that let 4,144 invite codes
        // accumulate. e2e/collections.spec.ts creates them under signUpFresh
        // orgs for exactly that reason.
        const result = await deleteUserCascade(row.id);
        users++;
        games += result.games;
      } catch (err) {
        // Best effort, and deliberately per-user: one undeletable account
        // must not abandon the other few thousand.
        console.warn(`teardown: could not delete user ${row.id} —`, (err as Error).message);
      }
    }

    // Every invite whose org does not exist (placeholder ids), plus every
    // invite belonging to the kept admin. See the comment on KEEP above.
    const codes = await db.execute<{ code: string }>(sql`
      delete from invites i
      where not exists (
              select 1 from auth."organization" o where o.id = i.org_id)
         or i.org_id in (
              select m.organization_id from auth."member" m
              join auth."user" u on u.id = m.user_id
              where u.email = ${KEEP})
      returning i.code`);

    // The kept admin signs in afresh on every run, so its sessions only ever
    // accumulate -- 486 had built up from one row per suite run. Deleting
    // them logs nobody out who will not simply sign in again.
    const sessions = await db.execute(sql`
      delete from auth."session" s
      using auth."user" u
      where u.id = s.user_id and u.email = ${KEEP}`);

    // Blobs are NOT part of that cascade, by design: admin-delete refuses to
    // touch a global content-addressed table, because a blob can be shared
    // across organizations. Only blobs that NOTHING references anywhere are
    // reclaimable, and that rule is tested in src/lib/blob-gc.test.ts.
    const [stored, diskRefs, entRefs] = await Promise.all([
      db.select({ sha256: blobs.sha256 }).from(blobs),
      db.select({ sha256: disks.sha256 }).from(disks),
      db.select({ sha256: entitlements.sha256 }).from(entitlements),
    ]);

    const unreferenced = selectUnreferencedBlobs(
      stored.map((b) => b.sha256),
      diskRefs.map((d) => d.sha256),
      entRefs.map((e) => e.sha256),
    );

    if (unreferenced.length > 0) {
      // Bytes first, then the row. A removed object with a surviving row is
      // recoverable -- the sweeper reports it as unreadable and a human can
      // see it. A deleted row whose object survives is an invisible leak
      // nothing will ever find again, because the sha is the only handle.
      for (const sha256 of unreferenced) {
        try {
          await diskStore.remove(sha256);
          objectsRemoved++;
        } catch {
          // The object may never have been uploaded: most specs seed a blobs
          // row without ever PUTting bytes. Not an error.
        }
      }
      await db.delete(blobs).where(inArray(blobs.sha256, unreferenced));
      orphanBlobs = unreferenced.length;
    }

    console.log(
      `teardown: removed ${users} test users, ${games} games, `
      + `${codes.rows.length} invite codes, ${sessions.rowCount ?? 0} stale sessions, `
      + `${orphanBlobs} unreferenced blobs (${objectsRemoved} objects), `
      + `${deltas.rows.length} delta blobs`,
    );
  } catch (err) {
    // Never fail the run on teardown: the tests already passed or failed on
    // their own merits, and reporting a cleanup problem as a suite failure
    // would hide that result.
    console.warn('teardown: aborted —', (err as Error).message);
  }
}
