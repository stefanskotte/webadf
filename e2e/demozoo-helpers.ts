import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { demozooProductions, demozooImages, demozooSuggestions } from '@/db/schema/demozoo';
import { imageStore } from '@/lib/storage';
import { titleKey } from '@/lib/demozoo/title-key';
import { TINY_PNG } from './openretro-helpers';

// Demozoo ids are well under 1,000,000 today; 2e9 keeps seeds clear of the live import.
const seededIds: number[] = [];
const storedImages: string[] = [];

export async function seedProduction(opts: { title: string; releaseYear?: number | null; groups?: string[]; types?: string[] }): Promise<number> {
  const id = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
  await getDb().insert(demozooProductions).values({
    id, title: opts.title, titleKey: titleKey(opts.title), releaseYear: opts.releaseYear ?? null,
    supertype: 'production', types: opts.types ?? ['Demo'], groups: opts.groups ?? ['Test Group'], isGame: false,
  });
  seededIds.push(id);
  return id;
}

/** Writes the bytes as well as the row, so an <img> assertion cannot pass against a 404. */
export async function seedDemozooImage(productionId: number, ordinal = 1): Promise<string> {
  const url = `https://media.demozoo.test/${randomUUID()}.png`;
  const sha1 = createHash('sha1').update(url).digest('hex');
  const { key } = await imageStore.put(sha1, new Uint8Array(TINY_PNG), 'image/png');
  storedImages.push(sha1);
  // screenshotId is a plain int4 with no FK, so it only needs to be unique
  // enough not to collide within a run -- but productionId * 10 (the brief's
  // original formula) overflows int4 outright, since seeded production ids
  // already sit at ~2e9: folding productionId down first keeps the product
  // well under 2^31-1 while still varying with both the production and the
  // ordinal.
  const screenshotId = (productionId % 200_000_000) * 10 + ordinal;
  await getDb().insert(demozooImages).values({
    sha1, screenshotId, productionId, ordinal,
    storageKey: key, sizeBytes: TINY_PNG.byteLength, sourceUrl: url,
  });
  return sha1;
}

export async function seedSuggestion(sha256: string, productionId: number, source: 'tosec_title' | 'volume_name' | 'filename' = 'tosec_title') {
  await getDb().insert(demozooSuggestions).values({ sha256, productionId, source });
  await getDb().update(blobs).set({ demozooState: 'suggested', demozooCheckedAt: new Date() }).where(eq(blobs.sha256, sha256));
}

export async function linkAutomatic(sha256: string, productionId: number) {
  await getDb().update(blobs)
    .set({ demozooState: 'applied', demozooProductionId: productionId, demozooCheckedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
}

/** Productions cascade their suggestions, screenshots and dismissals. Run BEFORE cleanupSeeded. */
export async function cleanupDemozoo() {
  const db = getDb();
  for (const sha1 of storedImages.splice(0)) { try { await imageStore.remove(sha1); } catch { /* best effort */ } }
  const ids = seededIds.splice(0);
  if (ids.length === 0) return;
  try { await db.delete(demozooImages).where(inArray(demozooImages.productionId, ids)); } catch { /* best effort */ }
  try { await db.update(blobs).set({ demozooProductionId: null, demozooState: null }).where(inArray(blobs.demozooProductionId, ids)); } catch { /* best effort */ }
  try { await db.delete(demozooProductions).where(inArray(demozooProductions.id, ids)); } catch { /* best effort */ }
}
