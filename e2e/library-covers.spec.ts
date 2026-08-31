import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';
import {
  seedOpenRetroEntry, seedOpenRetroImage, cleanupOpenRetro, TINY_PNG,
} from './openretro-helpers';

test.afterAll(async () => { await cleanupOpenRetro(); await cleanupSeeded(); });

const freshSha = () => createHash('sha256').update(randomUUID()).digest('hex');

/**
 * Point a blob at an OpenRetro entry directly.
 *
 * Deliberately NOT by running the sweeper: this spec is about what the grid
 * renders from a given database state, and driving a full scan would make it
 * depend on the whole match/enrich pipeline as well.
 */
async function linkBlobToEntry(sha256: string, entryUuid: string) {
  await getDb().update(blobs)
    .set({ openretroEntryId: entryUuid, enrichState: 'enriched', enrichCheckedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
}

test('a game with a stored cover shows it in the grid', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'covered', diskNo: 1, sha256 });

  const uuid = await seedOpenRetroEntry({ gameName: 'Covered Game', slug: 'covered-game' });
  const coverSha1 = createHash('sha1').update(`front-${gameId}`).digest('hex');
  await seedOpenRetroImage({ sha1: coverSha1, entryUuid: uuid, kind: 'front' });
  await linkBlobToEntry(sha256, uuid);

  await page.goto('/library');
  const card = page.getByTestId('game-card').filter({ hasText: 'covered' });
  const image = card.getByTestId('cover-image');
  await expect(image).toHaveAttribute('src', `/api/images/${coverSha1}`);

  // The <img> tag alone proves nothing -- a broken image is still an element.
  // Assert the browser actually decoded pixels.
  await expect
    .poll(async () => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);

  // And the route really returns the bytes we stored.
  const res = await page.request.get(`/api/images/${coverSha1}`);
  expect(res.status()).toBe(200);
  expect((await res.body()).byteLength).toBe(TINY_PNG.byteLength);
});

test('the front cover wins over a screenshot for the same game', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'ranked', diskNo: 1, sha256 });

  const uuid = await seedOpenRetroEntry({ gameName: 'Ranked Game' });
  const shot = createHash('sha1').update(`shot-${gameId}`).digest('hex');
  const front = createHash('sha1').update(`cover-${gameId}`).digest('hex');
  // Screenshot seeded FIRST, so passing would be impossible on insertion order.
  await seedOpenRetroImage({ sha1: shot, entryUuid: uuid, kind: 'screenshot', ordinal: 1 });
  await seedOpenRetroImage({ sha1: front, entryUuid: uuid, kind: 'front' });
  await linkBlobToEntry(sha256, uuid);

  await page.goto('/library');
  const card = page.getByTestId('game-card').filter({ hasText: 'ranked' });
  await expect(card.getByTestId('cover-image')).toHaveAttribute('src', `/api/images/${front}`);
});

test('a game with no images keeps its gradient and its title overlay', async ({ page }) => {
  // The majority case, and the one most likely to be broken by accident:
  // OpenRetro recognises 4 of 61 real disks, so most cards look like this.
  const user = await signUpFresh(page);
  await seedDisk(user.orgId, { title: 'plaincard', diskNo: 1, sha256: freshSha() });

  await page.goto('/library');
  const card = page.getByTestId('game-card').filter({ hasText: 'plaincard' });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('cover-image')).toHaveCount(0);
  // The overlay title is what the gradient card shows; losing it would leave
  // an unlabelled coloured rectangle.
  await expect(card.getByText('plaincard', { exact: true }).first()).toBeVisible();
});

test('the disk-count badge survives on a card that has a cover', async ({ page }) => {
  const user = await signUpFresh(page);
  const shaA = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: 'twodisk', diskNo: 1, sha256: shaA });
  const { addDisk } = await import('./device-helpers');
  await addDisk(user.orgId, gameId, { diskNo: 2, sha256: freshSha() });

  const uuid = await seedOpenRetroEntry({ gameName: 'Two Disk Game' });
  const front = createHash('sha1').update(`two-${gameId}`).digest('hex');
  await seedOpenRetroImage({ sha1: front, entryUuid: uuid, kind: 'front' });
  await linkBlobToEntry(shaA, uuid);

  await page.goto('/library');
  const card = page.getByTestId('game-card').filter({ hasText: 'twodisk' });
  await expect(card.getByTestId('cover-image')).toBeVisible();
  // Disk count comes from the aggregate query; a cover join done wrong would
  // fan out and inflate it. Two disks must still read exactly 2.
  await expect(card.getByText('2', { exact: true })).toBeVisible();
});
