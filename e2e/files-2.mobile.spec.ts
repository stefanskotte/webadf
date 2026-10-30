import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { collectionGames } from '@/db/schema/collections';
import { formatVolume } from '@/lib/adffs/format';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

/**
 * Files 2 on a phone (Task 11): titles filed into a collection through Move to…'s picker, and Makedir… under More
 * making a collection on LIBRARY:. The `mobile` project runs this file at 390 x 844 with touch.
 */

test.afterAll(cleanupSeeded);

/** A blank FFS disk, stored and seeded as a one-disk title of this org. */
async function seedTitle(orgId: string, title: string) {
  const adf = formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 24) });
  const sha256 = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(sha256, adf);
  return seedDisk(orgId, { title, diskNo: 1, sha256, writeProtected: false });
}

/** Files at the given places, hydrated so taps reach React's handlers (as files.spec.ts's; D8: copied, not shared). */
async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

async function newCollection(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/collections', { data: { name } });
  expect(res.ok()).toBe(true);
  return (await res.json()).id as string;
}
async function file(page: Page, collectionId: string, gameId: string) {
  expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId } })).ok()).toBe(true);
}
async function filedIn(collectionId: string): Promise<string[]> {
  return (await getDb().select({ g: collectionGames.gameId }).from(collectionGames)
    .where(eq(collectionGames.collectionId, collectionId))).map((r) => r.g).sort();
}

const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);

test('Move to… files a title into a collection', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  const demos = await newCollection(page, 'Demos');
  const gamesC = await newCollection(page, 'Games');
  await file(page, demos, t1.gameId);
  await openFiles(page, `LIBRARY:/${demos}`, 'STASH:', 'left');
  await expect(page.getByTestId('pane-left')).toBeVisible();
  await expect(page.getByTestId('pane-right')).toBeHidden();

  // A tap on a title opens it; its checkbox picks it.
  const t1Row = row(page, 'left', `Alpha-${tag}`);
  await t1Row.getByRole('checkbox').tap();
  await expect(t1Row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('files-phone-move')).not.toHaveAttribute('aria-disabled', 'true');
  const picker = page.getByTestId('files-copy-to');
  const here = picker.getByTestId('files-copy-to-here');

  // Copy to… the library's root: it is there already.
  await page.getByTestId('files-phone-copy').tap();
  await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('STASH:');   // the other pane's place
  await picker.getByTestId('files-copy-to-dev-LIBRARY').tap();
  await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('LIBRARY:');
  await expect(picker.getByTestId('files-copy-to-crumb-1')).toHaveCount(0);
  await expect(here).toHaveText('Copy here');
  await expect(here).toBeDisabled();
  await expect(picker.getByTestId('files-copy-to-reason')).toHaveText('It is in the library already');
  await picker.getByTestId('files-copy-to-close').tap();
  await expect(picker).toBeHidden();
  await expect(t1Row).toHaveAttribute('aria-selected', 'true');

  // Move to…: the root takes it (out of Demos, into no collection); Games takes it too. Games it is.
  await page.getByTestId('files-phone-move').tap();
  await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('STASH:');
  await expect(here).toBeDisabled();   // STASH: takes files, not titles
  await picker.getByTestId('files-copy-to-dev-LIBRARY').tap();
  await expect(picker.getByTestId('files-copy-to-dev-LIBRARY')).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('LIBRARY:');
  await expect(here).toHaveText('Move here');
  await expect(here).toBeEnabled();
  // Collections first, in the Library's order.
  await expect(picker.getByTestId('files-copy-to-folder').first()).toHaveAttribute('data-name', 'Demos');
  await picker.getByTestId('files-copy-to-folder').filter({ hasText: 'Games' }).tap();
  await expect(picker.getByTestId('files-copy-to-crumb-1')).toHaveText('Games');
  await expect(here).toBeEnabled();
  await here.tap();
  await expect(picker).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Moved 1 title to Games.' })).toBeVisible({ timeout: 15_000 });
  expect(await filedIn(gamesC)).toEqual([t1.gameId]);
  expect(await filedIn(demos)).toEqual([]);
  await expect(t1Row).toHaveCount(0);

  // The other pane went to Games: switch to it and the title is there.
  await page.getByTestId('files-side-right').tap();
  await expect(page.getByTestId('pane-right-crumb-1')).toHaveText('Games');
  await expect(row(page, 'right', `Alpha-${tag}`)).toHaveCount(1);
});

test('Makedir… on LIBRARY: makes a collection', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'LIBRARY:', 'STASH:', 'left');
  await page.getByTestId('files-more').tap();
  const item = page.getByTestId('files-more-makedir');
  await expect(item).toBeVisible();
  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  await item.tap();
  const dialog = page.getByTestId('files-name-dialog');
  await expect(dialog).toContainText('New collection');
  await page.getByTestId('files-name-input').fill('Phone');
  await expect(page.getByTestId('files-name-save')).toHaveText('Make collection');
  await page.getByTestId('files-name-save').tap();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Made the collection Phone.' })).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'Phone')).toHaveAttribute('data-kind', 'collection');
  await expect(row(page, 'left', 'Phone').getByTestId('pane-row-sub')).toHaveText('0 titles');
});
