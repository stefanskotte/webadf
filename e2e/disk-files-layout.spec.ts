import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { signUpFresh, createAdf, openVersion } from './helpers';
import { cleanupSeeded, pairDevice } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

/**
 * Phase C4: the disk page in the ModernDiskFiles layout (spec 2026-10-25-phase-c4-disk-files-design.md). Every disk
 * is made through createAdf (FFS, root 880) and edited through the API, so each test owns its rows on the shared DB.
 *
 * Files increment 1 (Task 11): the head of a disk is now Files -- the Disk card is the disk strip above the pane, the
 * Files card is the pane, the row menus and the selection strip are the button column and its dialogs, and the History
 * opens over the pane. Only the per-version page (?version=N, R3) is still the Browse layout, and is tested as such.
 * What had no Files counterpart by design is gone (the name filter, the Hide .info switch -- a Files setting in
 * increment 4 -- the Add file button, R5 makes a drop the way in, and the History column beside the files); see the
 * Task 11 report.
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

/** The disk open in Files, on the right, hydrated so clicks and keys reach React. */
async function openInFiles(page: Page, disk: { id: string; gameId: string }) {
  const right = `LIBRARY:/${disk.gameId}/${disk.id}`;
  await page.goto(`/files?${new URLSearchParams({ left: 'LIBRARY:', right, active: 'right' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

const paneRow = (page: Page, name: string) =>
  page.getByTestId('pane-right').locator(`[data-testid="pane-row"][data-name="${name}"]`);
const bodyFocused = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null);

test('the disk strip and the pane header: one h1, the facts, usage words, the drive in words, Download; History over the pane', async ({ page }) => {
  const { disk } = await freshDisk(page);
  await openInFiles(page, disk);
  const strip = page.getByTestId('disk-strip-right');
  await expect(strip).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('Files');
  await expect(page.getByTestId('pane-right-crumb-2')).toHaveText(/Disk 1/);
  await expect(page.getByTestId('pane-right-meta')).toHaveText(/^\d+ KB free · FFS DD$/);
  await expect(strip.getByTestId('disk-strip-usage')).toHaveText(/^\d+ of 880 KB · \d+ KB free$/);
  const meter = strip.getByTestId('disk-strip-meter');
  await expect(meter).toHaveAttribute('role', 'meter');
  await expect(meter).toHaveAttribute('aria-label', 'Disk space used');
  await expect(meter).toHaveAttribute('aria-valuemin', '0');
  await expect(meter).toHaveAttribute('aria-valuemax', '880');
  await expect(meter).toHaveAttribute('aria-valuenow', /^\d+$/);
  await expect(meter).toHaveAttribute('aria-valuetext', /^\d+ KB used of 880 KB$/);
  await expect(strip.getByTestId('disk-strip-light')).toHaveAttribute('data-state', 'none');
  await expect(strip.getByTestId('disk-strip-drive')).toHaveText('Not in a drive');
  await expect(strip.getByTestId('disk-strip-adf')).toHaveAttribute('href', `/api/disks/${disk.id}/adf`);
  // The History opens over its own pane at every width, not in a column beside the files.
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    if ((await strip.getByTestId('disk-strip-history-toggle').getAttribute('aria-expanded')) !== 'true') {
      await strip.getByTestId('disk-strip-history-toggle').click();
    }
    const pane = (await page.getByTestId('pane-right').boundingBox())!;
    const history = (await page.getByTestId('disk-strip-history').boundingBox())!;
    expect(history.x, `at ${width}`).toBeGreaterThanOrEqual(pane.x - 1);
    expect(history.x + history.width, `at ${width}`).toBeLessThanOrEqual(pane.x + pane.width + 1);
  }
});

test('the version banner: the board words, Back to current returns to the head', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'FIRST.TXT', content: 'one' }]);
  await page.goto(`/disks/${disk.id}/files?version=0`);
  const banner = page.getByTestId('version-banner');
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner).toContainText('You’re browsing version 0');
  await expect(banner).toContainText('It’s read-only — restore it to make it current.');
  await page.getByTestId('version-banner-back').click();
  // The head of a disk is Files, the disk on the right.
  await expect(page).toHaveURL(/\/files\?/);
  await expect.poll(() => new URL(page.url()).searchParams.get('right')).toBe(`LIBRARY:/${disk.gameId}/${disk.id}`);
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
  await expect(paneRow(page, 'FIRST.TXT')).toBeVisible();
});

test('the pane: the column heads, Makedir in the button column, and a foot that counts', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'Tool', content: 'exe' }, { name: 'Tool.info', content: 'icn' },
    { name: 'Docs', dir: true }]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openInFiles(page, disk);
  const heads = page.getByTestId('pane-right').locator('thead th button:visible');
  await expect(heads).toHaveText(['Name▲', 'Size', 'Protection', 'Date']);
  await expect(page.getByTestId('pane-right-sort-name')).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByTestId('files-makedir')).toHaveText('Makedir');
  await expect(page.getByTestId('files-makedir')).toBeEnabled();
  await expect(page.getByTestId('pane-right-foot')).toHaveText('1 folder · 2 files');
  await paneRow(page, 'Tool').click();
  await expect(page.getByTestId('pane-right-foot')).toHaveText('1 of 3 selected · 3 B');
});

test('Cancel in the delete or rename dialog returns focus to the button that opened it', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'A.TXT' }]);
  await openInFiles(page, disk);
  await paneRow(page, 'A.TXT').click();
  for (const [opener, dialog] of [['files-delete', 'files-delete-dialog'], ['files-rename', 'files-name-dialog']]) {
    await page.getByTestId(opener).click();
    await expect(page.getByTestId(dialog)).toBeVisible();
    await page.getByTestId(dialog).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId(dialog)).toHaveCount(0);
    await expect(page.getByTestId(opener)).toBeFocused();
  }
});

test('read-only states say why in the header, and the foot counts the selection', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'A.TXT' }, { name: 'B.TXT' }]);
  await openInFiles(page, disk);
  await paneRow(page, 'A.TXT').click();
  await paneRow(page, 'B.TXT').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane-right-foot')).toHaveText('2 of 2 selected · 2 B');
  await paneRow(page, 'B.TXT').click({ modifiers: ['ControlOrMeta'] });
  await paneRow(page, 'A.TXT').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane-right-foot')).toHaveText('0 folders · 2 files');
  // The per-version page is still the Browse layout (R3), read-only and saying so.
  await page.goto(`/disks/${disk.id}/files?version=0`);
  await expect(page.getByTestId('file-edit-disabled')).toContainText('read-only');
  await expect(page.getByTestId('files-card').getByTestId('file-edit-disabled')).toHaveCount(1);
  await expect(page.getByTestId('upload-trigger')).toBeDisabled();
  await expect(page.getByTestId('file-tree')).toContainText("This disk's root directory is empty.");
});

test('the button column holds the actions in the board order; Rename focuses its field, Escape returns to Rename', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'NOTES.TXT', content: 'hello' }]);
  await openInFiles(page, disk);
  await paneRow(page, 'NOTES.TXT').click();
  await expect(page.getByTestId('files-actions').locator('button:visible'))
    .toHaveText(['← Copy', '← Move', 'Delete', 'Rename', 'Makedir', 'Protect', 'Info', 'Download', 'Swap ⇄']);
  // One file downloads by its path (R4).
  const [dl, res] = await Promise.all([page.waitForEvent('download'),
    page.waitForResponse((r) => r.url().includes('/api/files/download?')), page.getByTestId('files-download').click()]);
  expect(dl.suggestedFilename()).toBe('NOTES.TXT');
  expect(res.url()).toContain(`/api/files/download?path=${encodeURIComponent(`LIBRARY:/${disk.gameId}/${disk.id}/NOTES.TXT`)}`);
  await page.getByTestId('files-rename').click();
  await expect(page.getByTestId('files-name-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('files-name-dialog')).toHaveCount(0);
  await expect(page.getByTestId('files-rename')).toBeFocused();
});

test('a deleted row hands focus to the manager, never to the body', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'GONE.TXT' }, { name: 'KEPT.TXT' }]);
  await openInFiles(page, disk);
  await paneRow(page, 'GONE.TXT').click();
  await page.getByTestId('files-delete').click();
  await page.getByTestId('files-delete-confirm').click();
  await expect(paneRow(page, 'GONE.TXT')).toHaveCount(0, AFTER_EDIT);
  await expect(page.getByTestId('files-delete-dialog')).toHaveCount(0);
  expect(await bodyFocused(page)).toBe(false);
  await expect(page.getByTestId('files-manager')).toBeFocused();
});

test('rows: one line at lg, a second line below; glyphs, eight protection cells, names that fit', async ({ page }) => {
  const long = 'A_Thirty_Character_Name_Here01';            // 30 = MAX_NAME_LENGTH
  const { disk } = await freshDisk(page, [{ name: 'Prog' }, { name: 'Prog.info' }, { name: long }, { name: 'Sub', dir: true }]);
  await openInFiles(page, disk);
  const glyph = (name: string) => paneRow(page, name).locator('td').nth(1).locator('span[aria-hidden]').first();
  await expect(glyph('Prog')).toHaveText('EXE');
  await expect(glyph('Prog.info')).toHaveText('ICN');
  await expect(glyph('Sub')).toHaveText('DIR');
  const cells = paneRow(page, 'Prog').locator('td').nth(3);
  await expect(cells).toHaveText('----rwed');
  await expect(cells.locator('span > span')).toHaveCount(8);
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    const h = (await paneRow(page, 'Prog').boundingBox())!.height;
    expect(h, `one line at ${width}`).toBeLessThan(48);
    await expect(paneRow(page, 'Prog').getByTestId('pane-row-sub')).toBeHidden();
  }
  // Below lg one pane, the size and date on a second line under the name; nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(paneRow(page, 'Prog').getByTestId('pane-row-sub')).toBeVisible();
  const nameBox = (await paneRow(page, long).boundingBox())!;
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('the edit guard: a disk a running Amiga holds has every writing button off, reading ones on', async ({ page, request }) => {
  const { disk } = await freshDisk(page, [{ name: 'HELD.TXT' }]);
  const { deviceId } = await pairDevice(page, request, `Board guard`);
  const mount = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk.id } });
  expect(mount.ok()).toBe(true);
  await openInFiles(page, disk);
  await expect(page.getByTestId('pane-right-readonly')).toContainText('mounted on');
  // Asked for, not yet confirmed by the board: the light is not 'in' (driveLight's wording).
  await expect(page.getByTestId('disk-strip-light')).not.toHaveAttribute('data-state', 'in');
  await expect(page.getByTestId('disk-strip-light')).not.toHaveAttribute('data-state', 'none');
  await paneRow(page, 'HELD.TXT').click();
  for (const id of ['rename', 'move', 'protect', 'delete', 'makedir']) {
    await expect(page.getByTestId(`files-${id}`), id).toBeDisabled();
    await expect(page.getByTestId(`files-${id}`), id).toHaveAttribute('title', /mounted on/);
  }
  // Download and Info read, they do not write: they stay available.
  await expect(page.getByTestId('files-download')).toBeEnabled();
  await expect(page.getByTestId('files-info')).toBeEnabled();
});

test('History: the head open, older versions closed, counts as chips, Current in words', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await openInFiles(page, disk);
  await page.getByTestId('disk-strip-history-toggle').click();
  const panel = page.getByTestId('disk-strip-history');
  await expect(panel.getByRole('heading', { level: 2, name: 'History' })).toBeVisible();
  await expect(panel.getByTestId('version-2')).toHaveAttribute('data-head', 'true');
  await expect(panel.getByTestId('version-toggle-2')).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByTestId('version-toggle-1')).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByTestId('changes-1')).toHaveCount(0);
  await expect(panel.getByTestId('current-2')).toHaveText('Current');
  await expect(panel.getByTestId('version-counts-2')).toContainText('+1');
  await expect(panel.getByTestId('version-2')).toContainText('Version 2 · Edited in browser');
  await openVersion(page, 1);
  await expect(panel.getByTestId('changes-1')).toContainText('ONE.TXT');
  await expect(panel.getByTestId('restore-1')).toHaveText('Restore…');
});

test('Restore… asks in a dialog that focuses Cancel; Escape cancels and focus returns', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await openInFiles(page, disk);
  await page.getByTestId('disk-strip-history-toggle').click();
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

test('Restore this version from the banner lands on the current version, in Files', async ({ page }) => {
  test.setTimeout(120_000);
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }, { name: 'TWO.TXT' }]);
  await page.goto(`/disks/${disk.id}/files?version=1`);
  await page.getByTestId('version-banner-restore').click();
  await expect(page.getByTestId('restore-dialog')).toContainText('Restore version 1?');
  await page.getByTestId('restore-confirm').click();
  await expect(page).toHaveURL(/\/files\?/, AFTER_EDIT);
  await expect.poll(() => new URL(page.url()).searchParams.get('right')).toBe(`LIBRARY:/${disk.gameId}/${disk.id}`);
  await expect(page.getByTestId('version-banner')).toHaveCount(0);
  await expect(paneRow(page, 'ONE.TXT')).toBeVisible(AFTER_EDIT);
  await expect(paneRow(page, 'TWO.TXT')).toHaveCount(0);
  await page.getByTestId('disk-strip-history-toggle').click();
  await expect(page.getByTestId('disk-strip-history').getByTestId('version-3')).toContainText('Restored to version 1');
  expect(await bodyFocused(page)).toBe(false);
});

test('the drop review: the board words with free space, staged rows, and the reason when editing is off', async ({ page }) => {
  const { disk } = await freshDisk(page, [{ name: 'ONE.TXT' }]);
  await openInFiles(page, disk);
  await synthDrop(page, [{ name: 'NEW.TXT', kind: 'file', content: 'new' }], '[data-testid="pane-right"]');
  const review = page.getByTestId('files-drop-review');
  await expect(review).toContainText('Check the names before they are written. Every change is saved as a new version.');
  const strip = review.getByTestId('drop-strip');
  await expect(review.getByTestId('drop-staging')).toHaveAttribute('aria-label', 'Add files to this disk');
  await expect(strip).toContainText('1 item staged below — drop more to add to the same batch.');
  await expect(review.getByTestId('drop-staging-list')).toBeVisible();
  // Cleared, the strip says where files go and how much room there is; a drop on it stages again.
  await review.getByTestId('drop-clear').click();
  await expect(strip).toContainText('Drop files, folders or an .lha / .lzh / .zip here or on a folder to add them to');
  await expect(strip).toContainText(/\d+ KB free on this disk · every change is saved as a new version/);
  await synthDrop(page, [{ name: 'NEW.TXT', kind: 'file', content: 'new' }], '[data-testid="files-drop-review"] [data-testid="drop-strip"]');
  await expect(strip).toContainText('1 item staged below — drop more to add to the same batch.');
  await review.getByTestId('drop-commit').click();
  await expect(review).toHaveCount(0, AFTER_EDIT);
  await expect(paneRow(page, 'NEW.TXT')).toBeVisible(AFTER_EDIT);
  expect(await bodyFocused(page)).toBe(false);
  await page.goto(`/disks/${disk.id}/files?version=0`);
  await expect(page.getByTestId('drop-strip').getByTestId('drop-disabled')).toContainText('read-only');
});
