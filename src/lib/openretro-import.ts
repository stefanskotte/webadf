import { sql, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { openretroEntries, openretroDiskSha1 } from '@/db/schema/openretro';
import { readOpenRetroDb } from '@/lib/openretro-db';
import { chunk } from '@/lib/chunk';

const INSERT_CHUNK = 250;
/**
 * The sha1 -> entry table is two narrow columns and ~195,000 rows, so it is
 * chunked far more coarsely than the 21-column entries table. At 250 the
 * rebuild alone costs ~780 sequential round trips over the neon-http driver,
 * and the whole import measured 120 s against a 300 s route ceiling that also
 * has to absorb a 29 MB upload. 2,000 rows x 2 columns is 4,000 bind
 * parameters, comfortably inside Postgres's 65,535 limit.
 */
const PAIR_CHUNK = 2000;
const sqlExcluded = (col: string) => sql.raw(`excluded."${col}"`);

/**
 * Load an uploaded Amiga.sqlite. Idempotent: entries are keyed by OpenRetro's
 * own uuid, so re-importing a newer sync updates in place.
 *
 * A variant's chipset is copied onto its parent entry. Variants are not stored
 * as rows: their durable contribution is the sha1 -> parent mapping.
 */
export async function importOpenRetro(bytes: Uint8Array) {
  const data = readOpenRetroDb(bytes);
  const db = getDb();

  const chipsetByParent = new Map<string, string>();
  for (const v of data.variants) {
    if (v.parentUuid && v.chipset && !chipsetByParent.has(v.parentUuid)) {
      chipsetByParent.set(v.parentUuid, v.chipset);
    }
  }

  // Deduped by uuid before chunking, following ingest/complete's precedent --
  // a duplicate key inside one chunk makes Postgres abort the whole INSERT.
  const rows = [...new Map(data.games.map((g) => [g.uuid, {
    uuid: g.uuid, gameName: g.gameName, slug: g.slug,
    publisher: g.publisher, developer: g.developer, year: g.year,
    languages: g.languages, players: g.players, tags: g.tags,
    chipset: chipsetByParent.get(g.uuid) ?? null,
    frontSha1: g.frontSha1, titleSha1: g.titleSha1,
    screenshotSha1s: g.screenshotSha1s.length > 0 ? g.screenshotSha1s.join(',') : null,
    holUrl: g.holUrl, mobygamesUrl: g.mobygamesUrl, lemonUrl: g.lemonUrl,
    wikipediaUrl: g.wikipediaUrl, longplayUrl: g.longplayUrl,
    description: g.description, longDescription: g.longDescription,
  }])).values()];

  for (const part of chunk(rows, INSERT_CHUNK)) {
    await db.insert(openretroEntries).values(part).onConflictDoUpdate({
      target: openretroEntries.uuid,
      set: {
        gameName: sqlExcluded('game_name'), slug: sqlExcluded('slug'),
        publisher: sqlExcluded('publisher'), developer: sqlExcluded('developer'),
        year: sqlExcluded('year'), languages: sqlExcluded('languages'),
        players: sqlExcluded('players'), tags: sqlExcluded('tags'),
        chipset: sqlExcluded('chipset'),
        frontSha1: sqlExcluded('front_sha1'), titleSha1: sqlExcluded('title_sha1'),
        screenshotSha1s: sqlExcluded('screenshot_sha1s'),
        holUrl: sqlExcluded('hol_url'), mobygamesUrl: sqlExcluded('mobygames_url'),
        lemonUrl: sqlExcluded('lemon_url'), wikipediaUrl: sqlExcluded('wikipedia_url'),
        longplayUrl: sqlExcluded('longplay_url'),
        description: sqlExcluded('description'),
        longDescription: sqlExcluded('long_description'),
      },
    });
  }

  // The sha1 index is rebuilt wholesale: a variant can move between parents
  // between syncs, and reconciling that incrementally is more code than
  // rebuilding a table this size.
  await db.execute(sql`delete from openretro_disk_sha1`);
  const pairs = [...new Map(data.variants.flatMap((v) =>
    v.parentUuid ? v.fileSha1s.map((s) => [`${s}:${v.parentUuid}`, { sha1: s, entryUuid: v.parentUuid! }] as const) : [],
  )).values()];
  for (const part of chunk(pairs, PAIR_CHUNK)) {
    await db.insert(openretroDiskSha1).values(part);
  }

  // A new sync invalidates every prior enrichment verdict, exactly as a DAT
  // import invalidates every match verdict. Hashes are NOT touched.
  await db.update(blobs).set({
    enrichCheckedAt: null, enrichState: null, openretroEntryId: null,
  }).where(isNotNull(blobs.enrichCheckedAt));

  return { games: rows.length, sha1s: pairs.length, version: data.version };
}
