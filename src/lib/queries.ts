import { sql, desc, eq, and, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { openretroEntries, openretroImages } from '@/db/schema/openretro';
import { orgFilter } from '@/db/scope';

export interface GameListItem {
  id: string; title: string; year: number | null; publisher: string | null;
  diskCount: number; coverAssetId: string | null;
  sizeBytes: number; sha256Prefix: string | null;
}

export async function listGames(orgId: string, opts: { limit?: number } = {}): Promise<GameListItem[]> {
  return getDb()
    .select({
      id: games.id, title: games.title, year: games.year, publisher: games.publisher,
      coverAssetId: games.coverAssetId,
      diskCount: sql<number>`count(${disks.id})::int`,
      sizeBytes: sql<number>`coalesce(sum(${disks.sizeBytes}), 0)::bigint`,
      sha256Prefix: sql<string | null>`min(${disks.sha256})`,
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
}

export interface DeviceListItem {
  id: string; name: string;
  firmwareVersion: string | null; macAddress: string | null;
  rssi: number | null; psramFree: number | null;
  lastSeenAt: Date | null; lastError: string | null; lastErrorAt: Date | null;
  desiredSha256: string | null; mountedSha256: string | null;
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
}
export interface GameImage {
  sha1: string; url: string; kind: string; ordinal: number;
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
    })
    .from(disks)
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

      const imgs = await db
        .select({
          sha1: openretroImages.sha1, url: openretroImages.url,
          kind: openretroImages.kind, ordinal: openretroImages.ordinal,
        })
        .from(openretroImages)
        .where(eq(openretroImages.entryUuid, entry.uuid))
        .orderBy(openretroImages.ordinal);

      front = imgs.find((i) => i.kind === 'front') ?? null;
      titleShot = imgs.find((i) => i.kind === 'title') ?? null;
      screenshots = imgs.filter((i) => i.kind === 'screenshot');
    }
  }

  return {
    ...game, languages, front, title_: titleShot, screenshots, links, disks: diskRows,
  };
}
