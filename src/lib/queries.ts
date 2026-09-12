import { sql, desc, eq, and, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { collectionGames } from '@/db/schema/collections';
import { openretroEntries, openretroImages } from '@/db/schema/openretro';
import { pickCover, type CoverCandidate } from '@/lib/cover-pick';
import { kindFromSetName, pickKind } from '@/lib/game-kind';
import { tosecEntries } from '@/db/schema/tosec';
import { orgFilter } from '@/db/scope';

export interface GameListItem {
  id: string; title: string; year: number | null; publisher: string | null;
  diskCount: number; coverAssetId: string | null;
  /**
   * Made here rather than uploaded. The grid offers an inline volume rename
   * only for these: renaming rewrites the disk's bytes, and "which disk?" has
   * no answer on a multi-disk title.
   */
  authored: boolean;
  /**
   * Aggregated with min() like sha256Prefix, so it means something only where
   * a title has ONE disk -- which is exactly the authored case the inline
   * rename uses it for. Do not reach for it on a multi-disk title.
   */
  diskId: string | null;
  /**
   * Our own image route, or null when nothing has been enriched for this
   * game -- which is the MAJORITY case (OpenRetro recognises 4 of 61 real
   * disks), so the grid's gradient stays the normal appearance, not an
   * error state.
   */
  coverUrl: string | null;
  /**
   * 'Game' | 'Demo' | 'App' | 'Educational' | 'Coverdisk', from the TOSEC set
   * that recognised the disks -- or null, which is the case for over half a
   * real library (TOSEC matches 45.9% of the operator's archive).
   */
  kind: string | null;
  sizeBytes: number; sha256Prefix: string | null;
}

/**
 * `opts.collectionId`, when set, filters to one collection's members and
 * orders by their position in it instead of recency. The unfiltered path
 * below is left byte-identical to before this option existed -- a library
 * with no collections must behave exactly as it did before -- which is why
 * the two branches are written out separately rather than sharing a partial
 * query builder chain.
 *
 * The collection id is NOT trusted from the caller here: every route reaches
 * this through listCollections (src/lib/collections.ts) first, which is
 * itself org-scoped, so an id belonging to another tenant never arrives as
 * opts.collectionId. The join added below carries no org_id predicate of its
 * own, because collection_games has no such column by design (D-4-5) --
 * collections.org_id is what scopes it, and that check already happened
 * upstream of this function.
 */
export async function listGames(
  orgId: string, opts: { limit?: number; collectionId?: string; uncategorized?: boolean } = {},
): Promise<GameListItem[]> {
  const db = getDb();

  if (opts.uncategorized) {
    // Titles in no collection at all -- the library's inbox. NOT EXISTS
    // rather than a left join with a null check: the join form would have to
    // sit inside the GROUP BY that counts disks, and a title in two
    // collections would then fan the disk count out. `collection_games` has
    // no org_id column (D-4-5), so this subquery is scoped through the
    // collections table, or a title filed in ANOTHER tenant's collection
    // would wrongly read as uncategorized here.
    const rows = await db
      .select({
        id: games.id, title: games.title, year: games.year, publisher: games.publisher,
        coverAssetId: games.coverAssetId, authored: games.authored,
        diskCount: sql<number>`count(${disks.id})::int`,
        sizeBytes: sql<number>`coalesce(sum(${disks.sizeBytes}), 0)::bigint`,
        sha256Prefix: sql<string | null>`min(${disks.sha256})`,
        diskId: sql<string | null>`min(${disks.id})`,
      })
      .from(games)
      .leftJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
      .where(and(orgFilter(games, orgId), sql`not exists (
        select 1 from collection_games cg
        join collections co on co.id = cg.collection_id
        where cg.game_id = ${games.id} and co.org_id = ${orgId}
      )`))
      .groupBy(games.id)
      .orderBy(desc(games.createdAt))
      .limit(opts.limit ?? 200);

    return withDerived(orgId, rows);
  }

  if (opts.collectionId) {
    const collectionId = opts.collectionId;
    const rows = await db
      .select({
        id: games.id, title: games.title, year: games.year, publisher: games.publisher,
        coverAssetId: games.coverAssetId, authored: games.authored,
        diskCount: sql<number>`count(${disks.id})::int`,
        sizeBytes: sql<number>`coalesce(sum(${disks.sizeBytes}), 0)::bigint`,
        sha256Prefix: sql<string | null>`min(${disks.sha256})`,
        diskId: sql<string | null>`min(${disks.id})`,
      })
      .from(games)
      .leftJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
      .innerJoin(collectionGames, and(
        eq(collectionGames.gameId, games.id),
        eq(collectionGames.collectionId, collectionId),
      ))
      .where(orgFilter(games, orgId))
      // collectionGames.sortKey has to join the GROUP BY alongside games.id:
      // it isn't functionally dependent on games' own primary key, only on
      // the (collectionId, gameId) pair the inner join above already fixed
      // to at most one row per game, so grouping by both does not fan out.
      .groupBy(games.id, collectionGames.sortKey)
      .orderBy(collectionGames.sortKey, games.id)
      .limit(opts.limit ?? 200);

    return withDerived(orgId, rows);
  }

  const rows = await db
    .select({
      id: games.id, title: games.title, year: games.year, publisher: games.publisher,
      coverAssetId: games.coverAssetId, authored: games.authored,
      diskCount: sql<number>`count(${disks.id})::int`,
      sizeBytes: sql<number>`coalesce(sum(${disks.sizeBytes}), 0)::bigint`,
      sha256Prefix: sql<string | null>`min(${disks.sha256})`,
      diskId: sql<string | null>`min(${disks.id})`,
    })
    .from(games)
    // Scoped on both columns, not just gameId -- belt and braces alongside the
    // WHERE below. Nothing in the schema (no CHECK, no composite FK) currently
    // guarantees disks.org_id matches its game's org_id; only the write path
    // (/api/ingest/complete) keeps that true today. Scoping the join itself
    // means a future write path that got that wrong can never leak another
    // tenant's disk into this count or its sha256Prefix.
    .leftJoin(disks, and(eq(disks.gameId, games.id), eq(disks.orgId, orgId)))
    .where(orgFilter(games, orgId))
    .groupBy(games.id)
    .orderBy(desc(games.createdAt))     // recently added first (spec §10, D9)
    .limit(opts.limit ?? 200);

  return withDerived(orgId, rows);
}

/**
 * Whole-library totals, for the overview that replaces an empty inbox.
 *
 * Counted in the database rather than derived from listGames, which is capped
 * at 200 rows: a library past that cap would otherwise report its own page
 * size as its size.
 */
export async function countAllGames(orgId: string): Promise<{ titles: number; disks: number }> {
  const db = getDb();
  const [t] = await db.select({ n: sql<number>`count(*)::int` })
    .from(games).where(orgFilter(games, orgId));
  const [d] = await db.select({ n: sql<number>`count(*)::int` })
    .from(disks).where(orgFilter(disks, orgId));
  return { titles: t?.n ?? 0, disks: d?.n ?? 0 };
}

/**
 * Attach each game's cover image and its kind, as SEPARATE queries rather
 * than more joins on the aggregate above.
 *
 * That aggregate already groups by games.id to count disks and sum sizes.
 * Reaching the images from there means two further joins (blobs, then
 * openretro_images) inside the same GROUP BY, and since a game can have
 * several disks and each entry several images, the fan-out would multiply the
 * very rows count() and sum() are computing -- silently inflating every disk
 * count and every size on the page. Aggregating over a fan-out is a classic
 * way to get quietly wrong numbers, and the page's subtitle is built from
 * exactly those sums.
 *
 * One extra round trip over at most `limit` games is the cheaper mistake.
 *
 * Covers and kinds are two queries rather than one for the same reason: a
 * game with five images and four TOSEC-matched disks would return twenty rows
 * from a single joined query, and each half would have to de-duplicate the
 * other's fan-out. Two narrow queries run concurrently are simpler and cost
 * one round trip, not two, in wall-clock terms.
 */
async function withDerived<T extends { id: string }>(
  orgId: string, rows: T[],
): Promise<Array<T & { coverUrl: string | null; kind: string | null }>> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const db = getDb();

  const [images, sets] = await Promise.all([
    db.select({
      gameId: disks.gameId,
      sha1: openretroImages.sha1,
      kind: openretroImages.kind,
      ordinal: openretroImages.ordinal,
    })
      .from(disks)
      .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
      // blobs, openretro_images and tosec_entries are all GLOBAL tables, so
      // the org scope has to come from the disks side -- the same reasoning
      // as the leftJoin above.
      .innerJoin(openretroImages, eq(openretroImages.entryUuid, blobs.openretroEntryId))
      .where(and(inArray(disks.gameId, ids), eq(disks.orgId, orgId))),

    db.select({ gameId: disks.gameId, setName: tosecEntries.setName })
      .from(disks)
      .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
      .innerJoin(tosecEntries, eq(tosecEntries.id, blobs.tosecEntryId))
      .where(and(inArray(disks.gameId, ids), eq(disks.orgId, orgId))),
  ]);

  const coversByGame = new Map<string, CoverCandidate[]>();
  for (const f of images) {
    const list = coversByGame.get(f.gameId) ?? [];
    list.push({ sha1: f.sha1, kind: f.kind, ordinal: f.ordinal });
    coversByGame.set(f.gameId, list);
  }

  const kindsByGame = new Map<string, Array<string | null>>();
  for (const s of sets) {
    const list = kindsByGame.get(s.gameId) ?? [];
    list.push(kindFromSetName(s.setName));
    kindsByGame.set(s.gameId, list);
  }

  return rows.map((r) => {
    const chosen = pickCover(coversByGame.get(r.id) ?? []);
    return {
      ...r,
      coverUrl: chosen ? `/api/images/${chosen.sha1}` : null,
      kind: pickKind(kindsByGame.get(r.id) ?? []),
    };
  });
}

export interface DeviceListItem {
  id: string; name: string;
  firmwareVersion: string | null; macAddress: string | null;
  rssi: number | null; psramFree: number | null;
  lastSeenAt: Date | null; lastError: string | null; lastErrorAt: Date | null;
  desiredSha256: string | null; mountedSha256: string | null;
  // The exact disk ROWS, which the digests above cannot stand in for: two rows
  // can share one digest (identical bytes re-uploaded under a second title),
  // and the mount picker has to tell them apart or it lights up both.
  desiredDiskId: string | null; mountedDiskId: string | null;
  // The disk a human asked for, when one is asked for.
  desiredGame: string | null; desiredDiskNo: number | null; desiredDiskCount: number | null;
  // The disk the device says it holds, when it says it holds one.
  mountedGame: string | null; mountedDiskNo: number | null;
}

/**
 * Every paired device with both halves of its state.
 *
 * The desired disk and the mounted disk are joined SEPARATELY, through aliases,
 * because they are frequently different rows -- that difference is the whole
 * point of the devices page. Joining once and reusing the row would collapse
 * exactly the distinction the parent spec's §7 requires us to show.
 *
 * Both joins are keyed on the disk id rather than (gameId, diskNo): that pair
 * has no unique constraint, and a corrected re-upload creates a second row.
 */
export async function listDevices(orgId: string): Promise<DeviceListItem[]> {
  // Only the game titles are needed, and devices already carries
  // desired_game_id / mounted_game_id, so join games directly. Aliasing disks
  // as well would add two joins nothing selects from.
  const desiredGame = alias(games, 'desired_game');
  const mountedGame = alias(games, 'mounted_game');

  return getDb()
    .select({
      id: devices.id, name: devices.name,
      firmwareVersion: devices.firmwareVersion, macAddress: devices.macAddress,
      rssi: devices.rssi, psramFree: devices.psramFree,
      lastSeenAt: devices.lastSeenAt,
      lastError: devices.lastError, lastErrorAt: devices.lastErrorAt,
      desiredSha256: devices.desiredSha256, mountedSha256: devices.mountedSha256,
      desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId,
      desiredGame: desiredGame.title,
      desiredDiskNo: devices.desiredDiskNo,
      desiredDiskCount: sql<number | null>`(
        select count(*)::int from disks dc
        where dc.game_id = ${devices.desiredGameId} and dc.org_id = ${devices.orgId}
      )`,
      mountedGame: mountedGame.title,
      mountedDiskNo: devices.mountedDiskNo,
    })
    .from(devices)
    // Both joins are org-scoped in the ON clause itself, not just filtered
    // afterwards: desired_game_id/mounted_game_id are plain text columns with
    // no foreign key, so nothing at the database level stops a device row
    // from naming another org's game.
    .leftJoin(desiredGame, and(eq(desiredGame.id, devices.desiredGameId), eq(desiredGame.orgId, orgId)))
    .leftJoin(mountedGame, and(eq(mountedGame.id, devices.mountedGameId), eq(mountedGame.orgId, orgId)))
    .where(orgFilter(devices, orgId))
    .orderBy(devices.name);
}

export interface GameDetailDisk {
  id: string; diskNo: number; label: string | null;
  sha256: string; sizeBytes: number; isBoot: boolean; writeProtected: boolean;
  /**
   * The best known name for the disk -- NOT necessarily TOSEC's, despite the
   * column name. /api/ingest/complete seeds it with the uploaded filename and
   * applyMatch overwrites it with the canonical rom name once the identity
   * scan matches these bytes. Equal to sourceFilename until then.
   */
  tosecName: string | null;
  /**
   * What THIS organization called the file when it uploaded it. Per-tenant on
   * purpose: the same bytes can be uploaded under different names by
   * different tenants, and `blobs` carries no filename at all.
   */
  sourceFilename: string | null;
}
export interface GameImage {
  sha1: string;
  /** Our own streaming route. Content-addressed, so it is derived, not stored. */
  url: string;
  kind: string; ordinal: number;
}
/** OpenRetro's outbound links, plus its own page, for the attribution row. */
export interface GameLinks {
  slug: string | null; holUrl: string | null; mobygamesUrl: string | null;
  lemonUrl: string | null; wikipediaUrl: string | null; longplayUrl: string | null;
}
export interface GameDetail {
  id: string; title: string; year: number | null; publisher: string | null;
  genre: string | null; chipset: string | null; coverAssetId: string | null;
  developer: string | null; players: string | null;
  description: string | null; history: string | null;
  factsSource: string | null; proseSource: string | null;
  /** Who owns title/year/publisher. Needed by the editor to say so, and to
   *  offer handing the group back. Never NULL in practice -- ingest writes
   *  'filename' -- so a NULL here really would mean a human took the row. */
  metadataSource: string | null;
  languages: string | null;
  front: GameImage | null; title_: GameImage | null; screenshots: GameImage[];
  links: GameLinks | null;
  disks: GameDetailDisk[];
}

/**
 * One game and its disks. Null when the game does not exist OR belongs to
 * another organization -- deliberately indistinguishable, so the page 404s
 * either way and an id from another tenant reveals nothing.
 */
export async function getGameDetail(orgId: string, gameId: string): Promise<GameDetail | null> {
  const db = getDb();

  const gameRows = await db
    .select({
      id: games.id, title: games.title, year: games.year, publisher: games.publisher,
      genre: games.genre, chipset: games.chipset, coverAssetId: games.coverAssetId,
      developer: games.developer, players: games.players,
      description: games.description, history: games.history,
      factsSource: games.factsSource, proseSource: games.proseSource,
      metadataSource: games.metadataSource,
    })
    .from(games)
    .where(orgFilter(games, orgId, eq(games.id, gameId)))
    .limit(1);

  const game = gameRows[0];
  if (!game) return null;

  const diskRows = await db
    .select({
      id: disks.id, diskNo: disks.diskNo, label: disks.label,
      sha256: disks.sha256, sizeBytes: disks.sizeBytes,
      isBoot: disks.isBoot, writeProtected: disks.writeProtected,
      tosecName: disks.tosecName,
      sourceFilename: entitlements.sourceFilename,
    })
    .from(disks)
    // Scoped on BOTH columns of the entitlement's primary key. Joining on
    // sha256 alone would pull in another tenant's filename for shared bytes,
    // and 26 blobs in this system are already shared across organizations.
    .leftJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    // Scoped on orgId as well as gameId, matching listGames' reasoning: nothing
    // in the schema guarantees disks.org_id matches its game's org_id.
    .where(orgFilter(disks, orgId, eq(disks.gameId, gameId)))
    .orderBy(disks.diskNo);

  // The OpenRetro entry reached through this game's own disks: disk -> blob
  // -> the entry the sweeper decided those bytes are. Scoped through
  // diskRows, which is already org-filtered above, so no cross-tenant row can
  // be reached even though blobs and openretro_* are global tables.
  const shas = [...new Set(diskRows.map((d) => d.sha256))];
  let front: GameImage | null = null;
  let titleShot: GameImage | null = null;
  let screenshots: GameImage[] = [];
  let links: GameLinks | null = null;
  let languages: string | null = null;

  if (shas.length > 0) {
    const entryRows = await db
      .select({
        uuid: openretroEntries.uuid, slug: openretroEntries.slug,
        languages: openretroEntries.languages,
        holUrl: openretroEntries.holUrl, mobygamesUrl: openretroEntries.mobygamesUrl,
        lemonUrl: openretroEntries.lemonUrl, wikipediaUrl: openretroEntries.wikipediaUrl,
        longplayUrl: openretroEntries.longplayUrl,
      })
      .from(blobs)
      .innerJoin(openretroEntries, eq(openretroEntries.uuid, blobs.openretroEntryId))
      .where(inArray(blobs.sha256, shas))
      .limit(1);

    const entry = entryRows[0];
    if (entry) {
      languages = entry.languages;
      links = {
        slug: entry.slug, holUrl: entry.holUrl, mobygamesUrl: entry.mobygamesUrl,
        lemonUrl: entry.lemonUrl, wikipediaUrl: entry.wikipediaUrl,
        longplayUrl: entry.longplayUrl,
      };

      const rows = await db
        .select({
          sha1: openretroImages.sha1,
          kind: openretroImages.kind, ordinal: openretroImages.ordinal,
        })
        .from(openretroImages)
        .where(eq(openretroImages.entryUuid, entry.uuid))
        .orderBy(openretroImages.ordinal);
      const imgs: GameImage[] = rows.map((i) => ({ ...i, url: `/api/images/${i.sha1}` }));

      front = imgs.find((i) => i.kind === 'front') ?? null;
      titleShot = imgs.find((i) => i.kind === 'title') ?? null;
      screenshots = imgs.filter((i) => i.kind === 'screenshot');
    }
  }

  return {
    ...game, languages, front, title_: titleShot, screenshots, links, disks: diskRows,
  };
}
