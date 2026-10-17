/**
 * Disk sets (spec 2026-09-28-disk-sets §3, Task 6): the two org-scoped reads
 * behind the upload-page suggestion and the manual "add to a set" search.
 *
 * disks.orgId can drift from its game's own orgId (nothing in the schema
 * prevents it -- src/lib/search.ts's header documents the same fact), so
 * every join onto disks here carries BOTH gameId and orgId, never gameId
 * alone.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, entitlements } from '@/db/schema/catalog';
import { orgFilter } from '@/db/scope';
import { likePattern } from '@/lib/search-query';
import { volumeNameOf } from '@/lib/disk-label';
import { diskStore } from '@/lib/storage';
import { suggestSet, type SuggestInput, type Suggestion } from '@/lib/disk-set-suggest';

/**
 * The volume name, normalised to null on a blank or whitespace-only label
 * (controller ruling: real Amiga disks often carry one) as well as on any
 * read failure -- suggestSet falls back to the filename only for null, never
 * for '', so an unnormalised blank label would suppress that fallback.
 */
async function readVolumeName(sha256: string): Promise<string | null> {
  try {
    return volumeNameOf(await diskStore.read(sha256));
  } catch {
    return null;
  }
}

/**
 * Slack taken off the client's `since` before it is compared with
 * games.created_at (server clock): a browser clock a few minutes fast would
 * otherwise put this very upload's titles "before" the drop (final review m3).
 */
export const SINCE_SLACK_MS = 5 * 60 * 1000;

/**
 * The org's disks that just landed with the given hashes, whose game (a) was
 * created no earlier than `since` (P3 -- this call's own batch, not the
 * org's whole history), (b) has exactly one disk in total, not merely one
 * among `sha256s`, and (c) has never been arranged by a person
 * (disk_order_source IS NULL). Read for each: its volume label and this
 * org's own filename for it, then handed to the pure suggestSet.
 */
export async function suggestFromUpload(
  orgId: string, sha256s: string[], since: Date, paths: Record<string, string> | undefined,
): Promise<Suggestion> {
  const db = getDb();
  const floor = new Date(since.getTime() - SINCE_SLACK_MS);

  const found = await db.select({
    diskId: disks.id, gameId: disks.gameId, sha256: disks.sha256,
    sourceFilename: entitlements.sourceFilename, tosecName: disks.tosecName,
  })
    .from(disks)
    .innerJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, orgId)))
    .leftJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(
      eq(disks.orgId, orgId),
      inArray(disks.sha256, sha256s),
      gte(games.createdAt, floor),
      isNull(games.diskOrderSource),
      sql`(select count(*) from disks d2 where d2.game_id = ${games.id} and d2.org_id = ${orgId}) = 1`,
    ));

  // suggestSet reads row order as upload order, and the query has none: put
  // the rows back in the order the client sent the hashes (its drop order),
  // tie-broken by disk id for the same bytes under two titles (I2).
  const pos = new Map(sha256s.map((s, i) => [s, i]));
  const rows = [...found].sort((a, b) =>
    (pos.get(a.sha256) ?? Infinity) - (pos.get(b.sha256) ?? Infinity) || (a.diskId < b.diskId ? -1 : a.diskId > b.diskId ? 1 : 0));

  // sha256s is capped at 32 by the route, but disks.sha256 is not unique per
  // game: stableId('disk', gameId, sha256) means the same bytes uploaded
  // under two filenames are two different one-disk games, so this join can
  // return more rows than hashes. That would silently break the "at most 32
  // disks per request" constraint (and read the store more than 32 times);
  // refuse the suggestion instead of reading past it.
  if (rows.length > 32) return null;

  // One read per DISTINCT hash, not per row: several disk rows can share a
  // sha256 (see above), and the volume name depends only on the bytes. Fired
  // together, not one after another, for every hash this batch touches.
  const distinctShas = [...new Set(rows.map((r) => r.sha256))];
  const reads = new Map(distinctShas.map((s) => [s, readVolumeName(s)]));
  await Promise.all(reads.values());

  const inputs: SuggestInput[] = await Promise.all(rows.map(async (r) => ({
    diskId: r.diskId,
    gameId: r.gameId,
    // The entitlement is this org's own record of what it called the file;
    // a disk somehow missing one (should not happen post-ingest) falls
    // back to the catalog filename rather than dropping out of the batch.
    filename: r.sourceFilename ?? r.tosecName ?? '',
    volumeName: await reads.get(r.sha256)!,
    relativePath: paths?.[r.sha256],
  })));
  return suggestSet(inputs);
}

export interface CandidateDisk { id: string; diskNo: number; sourceFilename: string | null; tosecName: string | null }
export interface CandidateTitle { gameId: string; title: string; disks: CandidateDisk[] }

/** How many titles one page of the "Add disks…" list shows, and its ceiling. */
export const CANDIDATE_PAGE = 20;
export const CANDIDATE_MAX = 200;

/**
 * Up to `limit` of the org's titles, excluding `exclude`, matching `q` against
 * the title, a disk's tosec_name, or the entitlement's source_filename -- or,
 * for an empty `q`, simply the newest. `more` says whether titles beyond
 * `limit` exist: the dialog then offers "Show more". Without it a list cut at
 * 20 looked complete -- the operator (2026-10-10) ticked all 20 titles of a
 * 35-disk upload, and the other 13 silently stayed behind in Uncategorized.
 * Every returned title carries ALL of its
 * disks, not only the ones that matched: the caller is picking a whole title
 * to fold in, same as addDisksToSet does.
 *
 * `q` reaches ILIKE only through likePattern(), which escapes `%` and `_`
 * (src/lib/search-query.ts) so the caller's own text can never act as a
 * wildcard; every value below is a bound parameter or a drizzle column/table
 * reference, never a spliced string.
 */
export async function searchCandidates(
  orgId: string, q: string, exclude: string | null, limit: number = CANDIDATE_PAGE,
): Promise<{ titles: CandidateTitle[]; more: boolean }> {
  const max = Math.min(Math.max(Math.trunc(limit) || CANDIDATE_PAGE, 1), CANDIDATE_MAX);
  const db = getDb();
  const pattern = likePattern(q);

  const matches = pattern
    ? or(
        ilike(games.title, pattern),
        sql`exists (
          select 1 from ${disks}
          where ${disks.gameId} = ${games.id} and ${disks.orgId} = ${orgId}
          and (${disks.tosecName} ilike ${pattern} or exists (
            select 1 from ${entitlements}
            where ${entitlements.sha256} = ${disks.sha256} and ${entitlements.orgId} = ${orgId}
            and ${entitlements.sourceFilename} ilike ${pattern}
          ))
        )`,
      )
    : undefined;

  const titleRows = await db.select({ id: games.id, title: games.title })
    .from(games)
    .where(orgFilter(games, orgId, and(exclude ? ne(games.id, exclude) : undefined, matches)))
    .orderBy(desc(games.createdAt), asc(games.id))
    // One extra row answers "is there more?" without a count(*).
    .limit(max + 1);

  const more = titleRows.length > max;
  if (more) titleRows.length = max;
  if (titleRows.length === 0) return { titles: [], more: false };

  const gameIds = titleRows.map((r) => r.id);
  const diskRows = await db.select({
    gameId: disks.gameId, id: disks.id, diskNo: disks.diskNo,
    tosecName: disks.tosecName, sourceFilename: entitlements.sourceFilename,
  })
    .from(disks)
    .leftJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(inArray(disks.gameId, gameIds), eq(disks.orgId, orgId)))
    .orderBy(asc(disks.diskNo));

  const byGame = new Map<string, CandidateDisk[]>();
  for (const d of diskRows) {
    const list = byGame.get(d.gameId) ?? [];
    list.push({ id: d.id, diskNo: d.diskNo, sourceFilename: d.sourceFilename ?? null, tosecName: d.tosecName });
    byGame.set(d.gameId, list);
  }
  return { titles: titleRows.map((t) => ({ gameId: t.id, title: t.title, disks: byGame.get(t.id) ?? [] })), more };
}
