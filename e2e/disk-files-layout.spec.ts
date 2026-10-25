import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { signUpFresh, createAdf, openRowMenu, openVersion } from './helpers';
import { cleanupSeeded, hydrated, pairDevice } from './device-helpers';

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

test('a row menu holds the row actions in the board order; Rename focuses its field, Escape returns to ⋯', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'NOTES.TXT', content: 'hello' }]);
  const b = (await blocks(page, disk.id))['NOTES.TXT'].block;
  await page.goto(`/disks/${disk.id}/files`);
  await hydrated(page, `fs-more-${b}`, 'onPointerDown');
  const panel = await openRowMenu(page, b);
  await expect(panel.getByRole('menuitem')).toHaveText(['Download', 'Rename', 'Move to…', 'Protection bits…', 'Delete']);
  await expect(page.getByTestId(`fs-download-${b}`)).toHaveAttribute('href', `/api/disks/${disk.id}/files/${b}`);
  await page.getByTestId(`fs-rename-${b}`).click();
  await expect(page.getByTestId(`fs-rename-name-${b}`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`fs-more-${b}`)).toBeFocused();
});

test('a deleted row hands focus to the Files heading, never to the body', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'GONE.TXT' }, { name: 'KEPT.TXT' }]);
  const b = (await blocks(page, disk.id))['GONE.TXT'].block;
  await page.goto(`/disks/${disk.id}/files`);
  await hydrated(page, `fs-more-${b}`, 'onPointerDown');
  await openRowMenu(page, b);
  await page.getByTestId(`fs-delete-${b}`).click();
  await expect(page.getByTestId(`fs-delete-cancel-${b}`)).toBeFocused();
  await page.getByTestId(`fs-delete-confirm-${b}`).click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="GONE.TXT"]')).toHaveCount(0, AFTER_EDIT);
  await expect(page.locator('#files-heading')).toBeFocused();
});

test('rows: the grid from md, a two-line card below; glyphs, eight protection chips, the .info badge, names wrap', async ({ page }) => {
  const long = 'A_Thirty_Character_Name_Here01';            // 30 = MAX_NAME_LENGTH
  const { disk } = await freshDisk(page, [{ name: 'Prog' }, { name: 'Prog.info' }, { name: long }, { name: 'Sub', dir: true }]);
  const b = await blocks(page, disk.id);
  // Hide .info on, so Prog carries the .info badge (restore the preference at the end).
  await page.goto(`/disks/${disk.id}/files`);
  const sw = page.getByTestId('fs-hide-info');
  const was = await sw.getAttribute('aria-checked');
  if (was !== 'true') await sw.click();
  await expect(page.getByTestId(`fs-info-${b.Prog.block}`)).toHaveText('.info');
  await expect(page.getByTestId(`fs-glyph-${b.Prog.block}`)).toHaveText('EXE');
  await expect(page.getByTestId(`fs-glyph-${b.Sub.block}`)).toHaveText('DIR');
  await expect(page.getByTestId(`fs-protect-${b.Prog.block}`)).toHaveText('----rwed');
  await expect(page.getByTestId(`fs-protect-${b.Prog.block}`).locator('span')).toHaveCount(8);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const row = page.locator(`[data-testid="fs-entry"][data-name="Prog"]`);
    const h = (await row.boundingBox())!.height;
    expect(h, `one line at ${width}`).toBeLessThan(48);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const name = page.locator(`[data-testid="fs-entry"][data-name="${long}"]`);
  const nameBox = (await name.boundingBox())!;
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(390);
  const more = (await page.getByTestId(`fs-more-${b[long].block}`).boundingBox())!;
  expect(more.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (was !== 'true') await sw.click();
});

test('the edit guard: a disk a running Amiga holds has its row-menu edit actions and the bulk Move/Delete disabled', async ({ page, request }) => {
  const { disk } = await freshDisk(page, [{ name: 'HELD.TXT' }]);
  const b = (await blocks(page, disk.id))['HELD.TXT'].block;
  const { deviceId } = await pairDevice(page, request, `Board guard`);
  const mount = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk.id } });
  expect(mount.ok()).toBe(true);
  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('file-edit-disabled')).toContainText('mounted on');
  await hydrated(page, `fs-more-${b}`, 'onPointerDown');
  await openRowMenu(page, b);
  for (const id of ['rename', 'move', 'protect-item', 'delete']) {
    await expect(page.getByTestId(`fs-${id}-${b}`), id).toHaveAttribute('aria-disabled', 'true');
  }
  // Download reads, it does not write: it stays available.
  await expect(page.getByTestId(`fs-download-${b}`)).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.getByTestId(`fs-select-${b}`).check();
  await expect(page.getByTestId('fs-bulk-move')).toBeDisabled();
  await expect(page.getByTestId('fs-bulk-delete')).toBeDisabled();
});

test('History: the head open, older versions closed, counts as chips, Current in words', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('history-panel').getByRole('heading', { level: 2, name: 'History' })).toBeVisible();
  await expect(page.getByTestId('version-2')).toHaveAttribute('data-head', 'true');
  await expect(page.getByTestId('version-toggle-2')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('version-toggle-1')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('changes-1')).toHaveCount(0);
  await expect(page.getByTestId('current-2')).toHaveText('Current');
  await expect(page.getByTestId('version-counts-2')).toContainText('+1');
  await expect(page.getByTestId('version-2')).toContainText('Version 2 · Edited in browser');
  await openVersion(page, 1);
  await expect(page.getByTestId('changes-1')).toContainText('ONE.TXT');
  await expect(page.getByTestId('restore-1')).toHaveText('Restore…');
});

test('Restore… asks in a dialog that focuses Cancel; Escape cancels and focus returns', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await page.goto(`/disks/${disk.id}/files`);
  await openVersion(page, 1);
  await page.getByTestId('restore-1').click();
  const dialog = page.getByTestId('restore-dialog');
  await expect(dialog).toContainText('Restore version 1?');
  await expect(dialog).toContainText('This is saved as a new version, so nothing after it is lost.');
  await expect(page.getByTestId('restore-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('restore-1')).toBeFocused();
});

test('Restore this version from the banner lands on the current version, focus on the h1', async ({ page }) => {
  test.setTimeout(120_000);
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await page.goto(`/disks/${disk.id}/files?version=1`);
  await page.getByTestId('version-banner-restore').click();
  await expect(page.getByTestId('restore-dialog')).toContainText('Restore version 1?');
  await page.getByTestId('restore-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/disks/${disk.id}/files$`), AFTER_EDIT);
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
  await expect(page.getByTestId('version-3')).toContainText('Restored to version 1', AFTER_EDIT);
  await expect(page.locator('[data-testid="fs-entry"][data-name="TWO.TXT"]')).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});
