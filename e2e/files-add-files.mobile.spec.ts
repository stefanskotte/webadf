import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch } from '@/lib/adffs/write';
import { readVolume } from '@/lib/adffs';
import { diskStore } from '@/lib/storage';
import { signUpFresh, createAdf, runTag } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk } from './device-helpers';

/**
 * Putting files from a phone into a disk (tester report 2026-11-14/15: "It confused me on a phone trying to add files
 * to a blank ADF"). A phone has no drag from the OS, and the only file picker on the Files page was the top tile, which
 * fills STASH:, not the disk the pane shows. Inside a disk the pane now has "Add files to <title> · <disk>", which opens
 * the phone's picker and the same review a drop opens, aimed at the folder shown. Runs at 390 x 844 with touch.
 */

test.afterAll(cleanupSeeded);

const LIVE = { timeout: 20_000 };

async function storedRoot(diskId: string) {
  const [d] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  const vol = readVolume(await diskStore.read(d.sha256));
  if (!vol.ok) throw new Error('no volume');
  return vol.root;
}

const hydrated = (page: Page, testId: string) => page.waitForFunction((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
}, testId);

test('a blank ADF made on the phone: Add files to it puts the picked files on the disk, not in STASH:', async ({ page }) => {
  test.setTimeout(120_000);
  await signUpFresh(page);
  await createAdf(page);

  // The new title, then its disk's Files…: Files opens with the disk in the right pane.
  await page.locator('a[href*="/games/"]').first().click();
  await page.waitForURL(/\/games\//);
  const title = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();
  await page.locator('[data-testid^="files-"]').first().click();
  await expect(page).toHaveURL(/\/files\?.*active=right/);
  const diskId = decodeURIComponent(new URL(page.url()).searchParams.get('right')!).split('/').at(-1)!;
  await hydrated(page, 'files-manager');

  // Inside the disk: the button names the disk by its title and label, a finger's height, with words saying where the
  // files go. It is the pane's, not the top tile's: the tile still says STASH:.
  const add = page.getByTestId('pane-right-add-files');
  await expect(add).toHaveText(`Add files to ${title} · Disk 1`);
  await expect(add).not.toHaveAttribute('aria-disabled');
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('pane-right-add-files-hint')).toHaveText('Pick files on this phone: they go inside this disk, in the folder shown above.');
  await expect(page.getByTestId('files-stash-browse')).toHaveAttribute('data-tile', 'Into STASH:');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // The tap opens the phone's picker (a chooser event), and the picked files open the review for this disk.
  const chooser = page.waitForEvent('filechooser');
  await add.tap();
  await (await chooser).setFiles([
    { name: 'ReadMe.txt', mimeType: 'text/plain', buffer: Buffer.from('hello amiga\n') },
    { name: 'Notes', mimeType: 'application/octet-stream', buffer: Buffer.from('second file') },
  ]);
  const review = page.getByTestId('files-drop-review');
  await expect(review).toBeVisible();
  await expect(review.getByRole('heading', { name: `Add files to ${title} · Disk 1` })).toBeVisible();
  await review.getByTestId('drop-commit').tap();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Added 2 items to Disk 1 — saved as version 1\./ })).toBeVisible(LIVE);
  await expect(review).toBeHidden();

  // On the disk -- the pane and the stored image -- and nothing in STASH:.
  const rows = page.getByTestId('pane-right').getByTestId('pane-row');
  await expect(rows.filter({ hasText: 'ReadMe.txt' })).toBeVisible(LIVE);
  await expect(rows.filter({ hasText: 'Notes' })).toBeVisible();
  expect((await storedRoot(diskId)).map((e) => e.name).sort()).toEqual(['Notes', 'ReadMe.txt']);
  await page.getByTestId('files-side-left').tap();
  await expect(page.getByTestId('pane-left-crumb-0')).toHaveText('STASH:');
  await expect(page.getByTestId('pane-left').getByTestId('pane-row').filter({ hasText: 'ReadMe.txt' })).toHaveCount(0);

  // Outside a disk there is no such button: STASH: (the left pane) and the title's own level.
  await expect(page.getByTestId('pane-left-add-files')).toHaveCount(0);
  await page.getByTestId('files-side-right').tap();
  await page.getByTestId('pane-right-crumb-1').tap();
  await expect(page.getByTestId('pane-right').getByTestId('pane-row').filter({ hasText: 'Disk 1' })).toBeVisible(LIVE);
  await expect(page.getByTestId('pane-right-add-files')).toHaveCount(0);
});

test('inside a folder of a disk, Add files names the folder and writes into it', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const name = `AddTo-${tag}`;
  const r = applyBatch([{ op: 'mkdir', parentPath: '', name: 'Docs' }])(formatVolume({ filesystem: 'FFS', volumeName: name.slice(0, 20) }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const seeded = await seedDisk(orgId, { title: name, diskNo: 1, sha256, writeProtected: false });

  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: `LIBRARY:/${seeded.gameId}/${seeded.diskId}/Docs`, active: 'right' })}`);
  await hydrated(page, 'files-manager');
  const add = page.getByTestId('pane-right-add-files');
  // A seeded disk's label already names its title ("<title> (Disk 1)"): said once.
  await expect(add).toHaveText(`Add files to ${name} (Disk 1)/Docs`);

  await page.getByTestId('pane-right-add-files-input').setInputFiles([{ name: 'Inside', mimeType: 'text/plain', buffer: Buffer.from('in Docs') }]);
  const review = page.getByTestId('files-drop-review');
  await expect(review).toBeVisible();
  await review.getByTestId('drop-commit').tap();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Added 1 item to Docs — saved as version 1\./ })).toBeVisible(LIVE);
  await expect(page.getByTestId('pane-right').getByTestId('pane-row').filter({ hasText: 'Inside' })).toBeVisible(LIVE);
  const docs = (await storedRoot(seeded.diskId)).find((e) => e.name === 'Docs')!;
  expect(docs.children.map((e) => e.name)).toEqual(['Inside']);
});

test('a disk in a drive: Add files is there but dimmed, and a tap says why instead of opening the picker', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const name = `Held-${runTag()}`;
  const adf = formatVolume({ filesystem: 'FFS', volumeName: name.slice(0, 20) });
  const sha256 = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(sha256, adf);
  const held = await seedDisk(orgId, { title: name, diskNo: 1, sha256, writeProtected: false });
  const { deviceId } = await pairDevice(page, request, 'Held Phone');
  await getDb().update(devices).set({
    name: 'Held Phone', lastSeenAt: new Date(),
    desiredGameId: held.gameId, desiredDiskId: held.diskId, desiredSha256: sha256, desiredDiskNo: 1,
    mountedGameId: held.gameId, mountedDiskId: held.diskId, mountedSha256: sha256, mountedDiskNo: 1,
  }).where(eq(devices.id, deviceId));

  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: `LIBRARY:/${held.gameId}/${held.diskId}`, active: 'right' })}`);
  await hydrated(page, 'files-manager');
  const add = page.getByTestId('pane-right-add-files');
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  let chose = false;
  page.on('filechooser', () => { chose = true; });
  await add.tap({ force: true });   // aria-disabled, which Playwright's actionability counts as disabled
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'This disk is in a drive (mounted on "Held Phone"). Eject it to change it.' })).toBeVisible();
  await expect(page.getByTestId('files-drop-review')).toHaveCount(0);
  expect(chose).toBe(false);
});
