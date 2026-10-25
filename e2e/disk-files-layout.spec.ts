import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { signUpFresh, createAdf } from './helpers';
import { cleanupSeeded, hydrated } from './device-helpers';

/**
 * Phase C4: the disk page in the ModernDiskFiles layout (spec 2026-10-25-phase-c4-disk-files-design.md). Every disk
 * is made through createAdf (FFS, root 880) and edited through the API, so each test owns its rows on the shared DB.
 */
test.describe.configure({ timeout: 90_000 });
test.afterAll(cleanupSeeded);
const AFTER_EDIT = { timeout: 15_000 };

async function freshDisk(page: Page, files: { name: string; dir?: boolean; content?: string }[] = []) {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games).where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  for (const f of files) {
    const res = await page.request.post(`/api/disks/${disk.id}/files`, { multipart: f.dir
      ? { parentBlock: '880', name: f.name }
      : { parentBlock: '880', name: f.name, file: { name: f.name, mimeType: 'application/octet-stream',
          buffer: Buffer.from(f.content ?? 'x') } } });
    expect(res.status()).toBe(200);
  }
  return { u, disk };
}

async function blocks(page: Page, diskId: string): Promise<Record<string, AdfEntry>> {
  const v = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${diskId}/adf`)).body()));
  if (!v.ok) throw new Error('fixture: the disk should read');
  return Object.fromEntries(v.root.map((e) => [e.name, e]));
}

test('the Disk card: the breadcrumb, one h1, facts, usage words with a meter, the drive light in words, Download', async ({ page }) => {
  const { disk } = await freshDisk(page);
  await page.goto(`/disks/${disk.id}/files`);
  const card = page.getByTestId('disk-card');
  await expect(card).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(card.locator('h1')).toBeVisible();
  await expect(page.getByTestId('breadcrumb').getByRole('listitem')).toHaveCount(3);
  await expect(page.getByTestId('volume-header')).toContainText('FFS');
  await expect(page.getByTestId('volume-header')).toContainText('DD · 880 KB');
  await expect(page.getByTestId('volume-usage-text')).toContainText('KB used of 880 KB');
  await expect(page.getByTestId('volume-usage-meter')).toHaveAttribute('role', 'meter');
  await expect(page.getByTestId('drive-light')).toHaveAttribute('data-state', 'none');
  await expect(page.getByTestId(`holder-${disk.id}`)).toHaveText('Not in a drive');
  await expect(page.getByTestId(`download-${disk.id}`)).toHaveAttribute('href', `/api/disks/${disk.id}/adf`);
  // The page is two columns from xl: History sits to the right of the files at 1440.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const files = (await page.getByTestId('file-tree').boundingBox())!;
  const history = (await page.getByTestId('history-panel').boundingBox())!;
  expect(history.x).toBeGreaterThan(files.x + files.width - 1);
  await page.setViewportSize({ width: 1100, height: 1000 });
  const below = (await page.getByTestId('history-panel').boundingBox())!;
  expect(below.y).toBeGreaterThan((await page.getByTestId('file-tree').boundingBox())!.y);
});

test('the version banner: the board words, Back to current returns to the head', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'FIRST.TXT', content: 'one' }]);
  await page.goto(`/disks/${disk.id}/files?version=0`);
  const banner = page.getByTestId('version-banner');
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner).toContainText('You’re browsing version 0');
  await expect(banner).toContainText('It’s read-only — restore it to make it current.');
  await page.getByTestId('version-banner-back').click();
  await expect(page).toHaveURL(new RegExp(`/disks/${disk.id}/files$`));
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
});

test('the Files header: heading, filter, the Hide .info switch, Add file and New folder, and a footer that counts', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'Tool', content: 'exe' }, { name: 'Tool.info', content: 'icn' },
    { name: 'Docs', dir: true }]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/disks/${disk.id}/files`);
  const card = page.getByTestId('files-card');
  await expect(card.getByRole('heading', { level: 2, name: 'Files' })).toBeVisible();
  await expect(page.getByTestId('fs-filter')).toHaveAttribute('placeholder', 'Filter by name');
  const sw = page.getByTestId('fs-hide-info');
  await expect(sw).toHaveAttribute('role', 'switch');
  await expect(sw).toHaveText('Hide .info files');
  await expect(page.getByTestId('upload-trigger')).toHaveText(/Add file/);
  await expect(page.getByTestId('new-folder-trigger')).toHaveText(/New folder/);
  await expect(page.getByTestId('file-toolbar')).toBeVisible();
  await expect(page.getByTestId('fs-columns')).toContainText('Protection');
  await hydrated(page, 'fs-hide-info');
  const wasHiding = (await sw.getAttribute('aria-checked')) === 'true';
  if (wasHiding) await sw.click();                          // a fresh account starts from the default
  await expect(page.getByTestId('fs-footer')).toHaveText('1 folder · 2 files shown');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('fs-footer')).toHaveText('1 folder · 1 file shown · 1 .info file hidden');
  await sw.click();                                         // leave the preference as found
});

test('read-only states say why in the header, and the selection strip keeps A5 words', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'A.TXT' }, { name: 'B.TXT' }]);
  const b = await blocks(page, disk.id);
  await page.goto(`/disks/${disk.id}/files`);
  await hydrated(page, `fs-select-${b['A.TXT'].block}`, 'onChange');
  await page.getByTestId(`fs-select-${b['A.TXT'].block}`).check();
  await page.getByTestId(`fs-select-${b['B.TXT'].block}`).check();
  await expect(page.getByTestId('fs-selection-count')).toHaveText('2 items selected');
  await expect(page.getByTestId('fs-selection-clear')).toHaveAttribute('aria-label', 'Clear selection');
  await page.getByTestId('fs-selection-clear').click();
  await expect(page.getByTestId('fs-selection-bar')).toHaveCount(0);
  await expect(page.locator('#files-heading')).toBeFocused();
  await page.goto(`/disks/${disk.id}/files?version=0`);
  await expect(page.getByTestId('file-edit-disabled')).toContainText('read-only');
  await expect(page.getByTestId('files-card').getByTestId('file-edit-disabled')).toHaveCount(1);
  await expect(page.getByTestId('upload-trigger')).toBeDisabled();
  await expect(page.getByTestId('file-tree')).toContainText("This disk's root directory is empty.");
});
