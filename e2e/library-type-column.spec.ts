import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { seedDisk, addDisk, cleanupSeeded } from './device-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';

test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });

const freshSha = () => createHash('sha256').update(randomUUID()).digest('hex');

/**
 * Point a blob straight at a TOSEC entry.
 *
 * Deliberately not by running the sweeper: this spec is about what the table
 * renders from a given database state, not about the matching pipeline, which
 * tosec-scan.spec.ts already covers.
 */
async function linkBlobToEntry(sha256: string, entryId: string) {
  await getDb().update(blobs)
    .set({ tosecEntryId: entryId, matchState: 'matched', matchCheckedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
}

async function seedTyped(orgId: string, title: string, setName: string) {
  const sha256 = freshSha();
  const seeded = await seedDisk(orgId, { title, diskNo: 1, sha256 });
  const entryId = await seedTosecEntry({
    setName, gameName: `${title} (1992)(Test)`, romName: `${title}-${randomUUID()}.adf`,
    title, sortTitle: title.toLowerCase(), year: 1992,
  });
  await linkBlobToEntry(sha256, entryId);
  return { ...seeded, sha256 };
}

test('the table shows a type derived from the TOSEC set', async ({ page }) => {
  const user = await signUpFresh(page);
  await seedTyped(user.orgId, 'atypedgame', 'Commodore Amiga - Games - [ADF]');
  await seedTyped(user.orgId, 'atypeddemo', 'Commodore Amiga - Demos - Various - [ADF]');
  await seedTyped(user.orgId, 'atypedapp', 'Commodore Amiga - Applications - [ADF]');

  await page.goto('/library?view=table');
  await expect(page.getByTestId('game-table')).toBeVisible();

  for (const [title, expected] of [
    ['atypedgame', 'Game'], ['atypeddemo', 'Demo'], ['atypedapp', 'App'],
  ] as const) {
    const row = page.getByTestId('game-row').filter({ hasText: title });
    await expect(row.getByTestId('game-kind')).toHaveText(expected);
  }
});

test('an unmatched game shows a dash, not a made-up type', async ({ page }) => {
  // The majority case on a real library: TOSEC recognises 45.9% of it.
  const user = await signUpFresh(page);
  await seedDisk(user.orgId, { title: 'untypedgame', diskNo: 1, sha256: freshSha() });

  await page.goto('/library?view=table');
  const row = page.getByTestId('game-row').filter({ hasText: 'untypedgame' });
  await expect(row.getByTestId('game-kind')).toHaveText('—');
});

test('a multi-disk game gets one type, and its disk count is not inflated', async ({ page }) => {
  // Two queries feed this table -- the aggregate that counts disks, and the
  // one that derives the type. A join done wrong in either fans out and
  // corrupts the other's numbers.
  const user = await signUpFresh(page);
  const first = await seedTyped(user.orgId, 'multidisk', 'Commodore Amiga - Games - [ADF]');

  const second = freshSha();
  await addDisk(user.orgId, first.gameId, { diskNo: 2, sha256: second });
  const entryId = await seedTosecEntry({
    setName: 'Commodore Amiga - Games - [ADF]',
    gameName: 'multidisk (1992)(Test)(Disk 2 of 2)',
    romName: `multidisk-d2-${randomUUID()}.adf`,
    title: 'multidisk', sortTitle: 'multidisk', year: 1992,
  });
  await linkBlobToEntry(second, entryId);

  await page.goto('/library?view=table');
  const row = page.getByTestId('game-row').filter({ hasText: 'multidisk' });
  await expect(row.getByTestId('game-kind')).toHaveText('Game');
  await expect(row).toContainText('2');
});
