// Demozoo screenshots, copied into OUR image store (operator ruling). The same
// rules as openretro-images.ts, none optional: one request at a time with a
// delay, our User-Agent, never re-fetch a stored image, a rolling-hour cap.

import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, games } from '@/db/schema/catalog';
import { demozooImages, demozooScreenshots, demozooSuggestions } from '@/db/schema/demozoo';
import { imageStore } from '@/lib/storage';
import type { SweepResult } from '@/lib/tosec-sweep';
import { DEMOZOO_USER_AGENT } from './fetch-export';
import { MAX_SCREENSHOTS } from './extract';

export const DEMOZOO_IMAGES_PER_ROLLING_HOUR = 60;
const DELAY_MS = 500;
const RETRY_FAILED_AFTER_MS = 24 * 3_600_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An identifier that fits imageStore and /api/images -- NOT a digest of the bytes. */
export const imageKeyFor = (url: string) => createHash('sha1').update(url).digest('hex');

export async function ensureDemozooImage(
  s: { id: number; productionId: number; standardUrl: string; ordinal: number },
  deps: { fetch: typeof fetch; wait: (ms: number) => Promise<void> } = { fetch: globalThis.fetch, wait: sleep },
): Promise<{ stored: boolean; bytes: number }> {
  const db = getDb();
  const sha1 = imageKeyFor(s.standardUrl);
  const prior = await db.select({ storageKey: demozooImages.storageKey, failedAt: demozooImages.failedAt })
    .from(demozooImages).where(eq(demozooImages.sha1, sha1)).limit(1);
  if (prior[0]?.storageKey) return { stored: false, bytes: 0 };
  if (prior[0]?.failedAt && Date.now() - prior[0].failedAt.getTime() < RETRY_FAILED_AFTER_MS) return { stored: false, bytes: 0 };

  const row = { sha1, screenshotId: s.id, productionId: s.productionId, ordinal: s.ordinal, sourceUrl: s.standardUrl };
  await deps.wait(DELAY_MS);
  const res = await deps.fetch(s.standardUrl, { headers: { 'user-agent': DEMOZOO_USER_AGENT } });
  if (!res.ok) {
    await db.insert(demozooImages).values({ ...row, storageKey: null, sizeBytes: null, fetchedAt: new Date(), failedAt: new Date() })
      .onConflictDoUpdate({ target: demozooImages.sha1, set: { fetchedAt: new Date(), failedAt: new Date() } });
    return { stored: false, bytes: 0 };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const stored = await imageStore.put(sha1, bytes, res.headers.get('content-type') ?? 'image/png');
  await db.insert(demozooImages).values({ ...row, storageKey: stored.key, sizeBytes: bytes.byteLength, fetchedAt: new Date(), failedAt: null })
    .onConflictDoUpdate({ target: demozooImages.sha1, set: { storageKey: stored.key, sizeBytes: bytes.byteLength, fetchedAt: new Date(), failedAt: null } });
  return { stored: true, bytes: bytes.byteLength };
}

/** The politeness cap, separated from the database so it can be tested. */
export async function fetchWithinBudget<T>(
  items: T[], budget: number, overDeadline: () => boolean,
  ensure: (item: T) => Promise<{ stored: boolean }>,
): Promise<{ attempted: number; stored: number }> {
  let attempted = 0, stored = 0;
  for (const item of items) {
    if (attempted >= budget || overDeadline()) break;
    attempted++;
    try { if ((await ensure(item)).stored) stored++; }
    catch (err) { console.error('demozoo: screenshot fetch failed', err); }
  }
  return { attempted, stored };
}

async function budgetRemaining(): Promise<number> {
  const since = new Date(Date.now() - 3_600_000);
  const rows = await getDb().select({ n: sql<number>`count(*)::int` }).from(demozooImages)
    .where(gt(demozooImages.fetchedAt, since));
  return Math.max(0, DEMOZOO_IMAGES_PER_ROLLING_HOUR - (rows[0]?.n ?? 0));
}

/**
 * Only productions someone might see: automatic links, confirmations and
 * suggestions -- never the catalogue. First screenshots of every production
 * before anyone's second, so suggestion cards fill in first.
 */
export async function demozooImagePhase(spent: () => number, budgetMs: number, out: SweepResult): Promise<void> {
  const budget = await budgetRemaining();
  if (budget === 0) return;
  const db = getDb();

  const wantedIds = [...new Set([
    ...(await db.selectDistinct({ id: blobs.demozooProductionId }).from(blobs).where(isNotNull(blobs.demozooProductionId))).map((r) => r.id!),
    ...(await db.selectDistinct({ id: games.demozooProductionId }).from(games).where(isNotNull(games.demozooProductionId))).map((r) => r.id!),
    ...(await db.selectDistinct({ id: demozooSuggestions.productionId }).from(demozooSuggestions)).map((r) => r.id),
  ])];
  if (wantedIds.length === 0) return;

  const todo = await db.select({
    id: demozooScreenshots.id, productionId: demozooScreenshots.productionId,
    standardUrl: demozooScreenshots.standardUrl, ordinal: demozooScreenshots.ordinal,
  }).from(demozooScreenshots)
    .where(and(
      inArray(demozooScreenshots.productionId, wantedIds),
      lte(demozooScreenshots.ordinal, MAX_SCREENSHOTS),
      sql`not exists (select 1 from demozoo_images i where i.screenshot_id = ${demozooScreenshots.id}
            and (i.storage_key is not null or i.failed_at > now() - interval '24 hours'))`,
    ))
    .orderBy(demozooScreenshots.ordinal, demozooScreenshots.productionId)
    .limit(budget);

  const r = await fetchWithinBudget(todo, budget, () => spent() >= budgetMs, (s) => ensureDemozooImage(s));
  out.demozooImagesStored += r.stored;
}
