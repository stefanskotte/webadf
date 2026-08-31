import { getDb } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { openretroEntries, openretroDiskSha1, openretroImages } from '@/db/schema/openretro';
import { imageStore } from '@/lib/storage';

const seededUuids: string[] = [];
const seededSha1s: string[] = [];
const storedImages: string[] = [];

/**
 * A one-pixel PNG. Small enough to be inline, real enough that the route
 * serves genuine bytes with a genuine content type.
 */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Seed one OpenRetro parent entry directly.
 *
 * Image sha1s default to NULL on purpose. ensureImage() would otherwise make
 * a real request to openretro.org, and no test in this suite may reach a
 * third party -- the whole point of the enrichment being polite is that it
 * never fires without an operator asking for it. A test that wants images
 * seeds openretro_images rows with seedOpenRetroImage instead.
 */
export async function seedOpenRetroEntry(opts: {
  uuid?: string; gameName: string; slug?: string | null;
  publisher?: string | null; developer?: string | null; year?: number | null;
  players?: string | null; tags?: string | null; chipset?: string | null;
  languages?: string | null; description?: string | null; longDescription?: string | null;
  holUrl?: string | null;
}) {
  const uuid = opts.uuid ?? crypto.randomUUID();
  await getDb().insert(openretroEntries).values({
    uuid, gameName: opts.gameName, slug: opts.slug ?? null,
    publisher: opts.publisher ?? null, developer: opts.developer ?? null,
    year: opts.year ?? null, players: opts.players ?? null, tags: opts.tags ?? null,
    chipset: opts.chipset ?? null, languages: opts.languages ?? null,
    description: opts.description ?? null, longDescription: opts.longDescription ?? null,
    holUrl: opts.holUrl ?? null,
    frontSha1: null, titleSha1: null, screenshotSha1s: null,
  }).onConflictDoNothing();
  seededUuids.push(uuid);
  return uuid;
}

/** Map a disk sha1 onto an entry, as the importer's flattened variant list does. */
export async function seedOpenRetroSha1(sha1: string, entryUuid: string) {
  await getDb().insert(openretroDiskSha1).values({ sha1, entryUuid });
  seededSha1s.push(sha1);
}

/**
 * An already-stored image, so the game page renders one without any fetch.
 *
 * Writes the BYTES to the real store as well as the row, because the row
 * alone would leave /api/images/<sha1> answering 404 and an <img> assertion
 * passing on an image that never loaded.
 */
export async function seedOpenRetroImage(opts: {
  sha1: string; entryUuid: string; kind: 'front' | 'title' | 'screenshot'; ordinal?: number;
}) {
  await imageStore.put(opts.sha1, new Uint8Array(TINY_PNG), 'image/png');
  storedImages.push(opts.sha1);
  await getDb().insert(openretroImages).values({
    sha1: opts.sha1, entryUuid: opts.entryUuid, kind: opts.kind, ordinal: opts.ordinal ?? 0,
    storageKey: `oagd/${opts.sha1}`,
    sizeBytes: 1234, sourceUrl: `https://openretro.org/image/${opts.sha1}?size=400`,
  }).onConflictDoNothing();
}

export async function cleanupOpenRetro() {
  const db = getDb();
  for (const sha1 of storedImages.splice(0)) {
    try { await imageStore.remove(sha1); } catch { /* best effort */ }
  }
  const uuids = seededUuids.splice(0);
  const sha1s = seededSha1s.splice(0);
  for (const sha1 of sha1s) {
    try { await db.delete(openretroDiskSha1).where(eq(openretroDiskSha1.sha1, sha1)); } catch { /* best effort */ }
  }
  if (uuids.length > 0) {
    try { await db.delete(openretroImages).where(inArray(openretroImages.entryUuid, uuids)); } catch { /* best effort */ }
    try { await db.delete(openretroEntries).where(inArray(openretroEntries.uuid, uuids)); } catch { /* best effort */ }
  }
}
