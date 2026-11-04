import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { applyBatch } from '@/lib/adffs/write';
import { formatVolume } from '@/lib/adffs/format';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

/** Create SysConf (spec 2026-11-04): in the bank in place of Filter…, into the active pane, 232 bytes. */
test.use({ viewport: { width: 1280, height: 800 } });
test.afterAll(cleanupSeeded);

async function seedTitle(orgId: string, title: string) {
  const r = applyBatch([{ op: 'mkdir', parentPath: '', name: 'Devs' }])(formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 24) }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const seeded = await seedDisk(orgId, { title, diskNo: 1, sha256, sizeBytes: r.adf.length, writeProtected: false });
  return { ...seeded, path: `LIBRARY:/${seeded.gameId}/${seeded.diskId}` };
}
async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}
const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const button = (page: Page) => page.getByTestId('files-createsysconf');
const dialog = (page: Page) => page.getByTestId('files-sysconf');
const submit = (page: Page) => page.getByTestId('files-sysconf-submit');
const bytesOf = async (page: Page, path: string) => {
  const res = await page.request.get(`/api/files/download?path=${encodeURIComponent(path)}`);
  expect(res.ok()).toBe(true);
  return new Uint8Array(await res.body());
};
const ask = async (page: Page) => expect((await page.request.patch('/api/me/prefs', { data: { files: { onClash: 'ask' } } })).ok()).toBe(true);

test('replaces Filter… in the bank, and the filter box and / still work', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await expect(page.getByTestId('files-bank')).not.toContainText('Filter…');
  await expect(button(page)).toHaveText('Create SysConf…');
  await page.getByTestId('files-manager').focus();
  await page.keyboard.press('/');
  await expect(page.getByTestId('pane-left-filter')).toBeFocused();
});

test('creates the file in STASH:, 232 bytes, and a choice reaches its byte', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await button(page).click();
  await expect(dialog(page)).toContainText('STASH:');
  await expect(dialog(page)).toContainText('232 bytes');
  await page.getByTestId('sysconf-font-9').click();
  await submit(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page, 'left', 'system-configuration')).toHaveCount(1);
  const b = await bytesOf(page, 'STASH:/system-configuration');
  expect(b.length).toBe(232);
  expect(b[0]).toBe(9);
});

test('creates in a drawer on a disk, as a new version', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitle(orgId, `Boot-${runTag()}`);
  await openFiles(page, `${t.path}/Devs`, 'STASH:', 'left');
  await button(page).click();
  await submit(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page, 'left', 'system-configuration')).toHaveCount(1);
  expect((await bytesOf(page, `${t.path}/Devs/system-configuration`)).length).toBe(232);
});

test('a clash keeps the drawn pointer, and Replace writes it', async ({ page }) => {
  await signUpFresh(page);
  await ask(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await button(page).click();
  await submit(page).click();
  await expect(row(page, 'left', 'system-configuration')).toHaveCount(1);

  await button(page).click();
  await page.getByTestId('pointer-ink-1').click();
  await page.getByTestId('pointer-cell-15-15').click();
  await expect(page.getByTestId('pointer-cell-15-15')).toHaveAttribute('data-ink', 'R');
  await submit(page).click();
  await expect(page.getByTestId('files-sysconf-clash')).toContainText('already here');
  await page.getByTestId('files-sysconf-back').click();
  await expect(page.getByTestId('pointer-cell-15-15')).toHaveAttribute('data-ink', 'R');
  await submit(page).click();
  await page.getByTestId('files-sysconf-replace').click();
  await expect(dialog(page)).toHaveCount(0);
  const b = await bytesOf(page, 'STASH:/system-configuration');
  // Row 15's plane 0, low bit: colour 1 (R) at the last cell.
  expect(b[28 + 4 + 15 * 4 + 1] & 1).toBe(1);
});

test('dragging paints every cell it crosses, and the hot spot tool sets the hot spot', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await button(page).click();
  await page.getByTestId('pointer-ink-1').click();
  const from = (await page.getByTestId('pointer-cell-10-3').boundingBox())!;
  const to = (await page.getByTestId('pointer-cell-13-3').boundingBox())!;
  await page.mouse.move(from.x + 3, from.y + 3);
  await page.mouse.down();
  await page.mouse.move(to.x + 3, to.y + 3, { steps: 12 });
  await page.mouse.up();
  for (const x of [10, 11, 12, 13]) await expect(page.getByTestId(`pointer-cell-${x}-3`)).toHaveAttribute('data-ink', 'R');
  await page.getByTestId('pointer-hotspot').click();
  await page.getByTestId('pointer-cell-8-8').click();
  await expect(page.getByTestId('pointer-hotspot-at')).toHaveText('Hot spot: X 8, Y 8');
  await expect(page.getByTestId('pointer-cell-8-8')).toHaveAttribute('data-hot', '');
});

test('Standard pointer brings back the Workbench arrow after Clear', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await button(page).click();
  await expect(page.getByTestId('pointer-cell-0-0')).toHaveAttribute('data-ink', 'R');
  await page.getByTestId('pointer-clear').click();
  await expect(page.getByTestId('pointer-cell-0-0')).toHaveAttribute('data-ink', '.');
  await page.getByTestId('pointer-standard').click();
  await expect(page.getByTestId('pointer-cell-0-0')).toHaveAttribute('data-ink', 'R');
  await expect(page.getByTestId('pointer-cell-1-0')).toHaveAttribute('data-ink', 'W');
});

test('a fast drag leaves no gap', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await button(page).click();
  await page.getByTestId('pointer-ink-1').click();
  const from = (await page.getByTestId('pointer-cell-1-14').boundingBox())!;
  const to = (await page.getByTestId('pointer-cell-14-14').boundingBox())!;
  await page.mouse.move(from.x + 3, from.y + 3);
  await page.mouse.down();
  await page.mouse.move(to.x + 3, to.y + 3);   // one event across 14 cells
  await page.mouse.up();
  for (let x = 1; x <= 14; x++) await expect(page.getByTestId(`pointer-cell-${x}-14`)).toHaveAttribute('data-ink', 'R');
});

test('a bad value turns Create off with the reason, and fixing it turns it on', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await button(page).click();
  await page.getByTestId('sysconf-key-delay').fill('');
  await expect(page.getByTestId('files-sysconf-problem')).toContainText('Key repeat delay');
  await expect(submit(page)).toBeDisabled();
  await page.getByTestId('sysconf-key-delay').fill('0.5');
  await expect(page.getByTestId('files-sysconf-problem')).toHaveCount(0);
  await expect(submit(page)).toBeEnabled();
});

test('a shelf says why', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'LIBRARY:', 'STASH:', 'left');
  await expect(button(page)).toHaveAttribute('aria-disabled', 'true');
  await button(page).click({ force: true });   // aria-disabled: it stays clickable and says why
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Open a disk, STASH: or an Amiga volume to make it there' })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});

test('a double click on Create sends one request', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'NET:', 'left');
  let sent = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/files/ops') && r.postData()?.includes('create-sysconf')) sent++; });
  await button(page).click();
  await submit(page).dblclick();
  await expect(dialog(page)).toHaveCount(0);
  expect(sent).toBe(1);
});
