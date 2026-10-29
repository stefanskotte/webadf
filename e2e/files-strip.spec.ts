import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { formatVolume } from '@/lib/adffs/format';
import { addFile } from '@/lib/adffs/write';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

/**
 * Files increment 1, Task 9: the disk strip above a pane inside a disk, Files… on the title page, the Browse address
 * redirecting to Files, and files from the computer dropped into a disk folder (R5) through the drop review (Task 9b).
 */

test.afterAll(cleanupSeeded);

/** A real FFS disk with one file, stored, and seeded as a one-disk title of this org. */
async function seedRealDisk(orgId: string, tag: string) {
  let adf = formatVolume({ filesystem: 'FFS', volumeName: `Vol${tag.slice(0, 6)}` });
  const f = addFile(adf, ROOT_BLOCK, 'ReadMe', new TextEncoder().encode('hello\n'));
  if (!f.ok) throw new Error(f.reason);
  adf = f.adf;
  const sha256 = createHash('sha256').update(adf).digest('hex');
  await diskStore.put(sha256, adf);
  return { ...(await seedDisk(orgId, { title: `Strip-${tag}`, diskNo: 1, sha256, writeProtected: false })), sha256 };
}

/** Wait until the manager has hydrated, so a synthetic drop reaches React's handlers. */
async function managerReady(page: Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

test('Files… opens the disk on the right with its strip; the Browse address lands there too', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId, diskId } = await seedRealDisk(orgId, tag);

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId(`browse-${diskId}`)).toHaveCount(0);
  const link = page.getByTestId(`files-${diskId}`);
  await expect(link).toHaveText('Files…');
  await link.click();
  await expect.poll(() => {
    const q = new URL(page.url()).searchParams;
    return [new URL(page.url()).pathname, q.get('left'), q.get('right'), q.get('active')];
  }).toEqual(['/files', 'LIBRARY:', `LIBRARY:/${gameId}/${diskId}`, 'right']);

  const strip = page.getByTestId('disk-strip-right');
  await expect(strip).toBeVisible();
  await expect(page.getByTestId('disk-strip-left')).toHaveCount(0);   // LIBRARY: itself is not a disk
  await expect(strip).toContainText(`Strip-${tag}`);
  await expect(strip.getByTestId('disk-strip-drive')).toHaveText('Not in a drive');
  await expect(strip.getByTestId('disk-strip-usage')).toHaveText(/^\d+ of 880 KB · \d+ KB free$/);
  await expect(strip.getByTestId('disk-strip-adf')).toHaveAttribute('href', `/api/disks/${diskId}/adf`);
  await expect(strip.getByTestId('disk-strip-volume')).toHaveText(`Vol${tag.slice(0, 6)}`);
  await expect(strip.getByTestId('disk-strip-history-toggle')).toHaveText('History');   // never changed yet
  await expect(page.getByTestId('pane-row').filter({ hasText: 'ReadMe' })).toHaveCount(1);

  // The old address, without a version: Files, the disk on the right.
  await page.goto(`/disks/${diskId}/files`);
  await expect(page).toHaveURL(/\/files\?left=LIBRARY/);
  await expect(page.getByTestId('disk-strip-right')).toBeVisible();
});

test('files dropped from the computer land in the folder the pane shows, as a new version', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId, diskId } = await seedRealDisk(orgId, tag);
  await page.goto(`/files?left=LIBRARY:&right=${encodeURIComponent(`LIBRARY:/${gameId}/${diskId}`)}&active=right`);
  await managerReady(page);

  // Above the disks there is nowhere to put a file: said, and the tab stays on Files.
  await synthDrop(page, [{ name: 'Nope.txt', kind: 'file', content: 'x' }], '[data-testid="pane-left"]');
  await expect(page.getByText('Open a disk to drop files into it')).toBeVisible();
  await expect(page).toHaveURL(/\/files\?/);

  // The Browse page's review opens over the panes (Task 9b); nothing is written until it is confirmed.
  await synthDrop(page, [{ name: 'Notes.txt', kind: 'file', content: 'dropped from the computer' }], '[data-testid="pane-right"]');
  const review = page.getByTestId('files-drop-review');
  await expect(review.getByTestId('drop-staging-list')).toContainText('Notes.txt');
  await review.getByTestId('drop-commit').click();
  await expect(review).toHaveCount(0);
  await expect(page.getByText(/^Added 1 item to .+ — saved as version 1\.$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('pane-right').getByTestId('pane-row').filter({ hasText: 'Notes.txt' })).toHaveCount(1);
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-strip-history-toggle')).toHaveText('History · v1');

  // The History opens over the pane, the drop as the current version.
  await page.getByTestId('disk-strip-history-toggle').click();
  const panel = page.getByTestId('disk-strip-history');
  await expect(panel.getByTestId('version-1')).toHaveAttribute('data-head', 'true');
  await expect(panel.getByTestId('changes-1')).toContainText('Notes.txt');

  // A name already there is a clash the review holds back until it is answered.
  await synthDrop(page, [{ name: 'readme', kind: 'file', content: 'clash' }], '[data-testid="pane-right"]');
  await expect(review.getByTestId('stage-conflict-0')).toContainText('ReadMe');
  await expect(review.getByTestId('drop-commit')).toBeDisabled();
});

test('a disk in a drive: the chip says which, Eject to edit replaces Mount, and the volume name is locked', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { deviceId } = await pairDevice(page, request, 'Strip Bench');
  const { gameId, diskId, sha256 } = await seedRealDisk(orgId, tag);
  await getDb().update(devices).set({
    name: 'Strip Bench', lastSeenAt: new Date(), desiredGameId: gameId, desiredDiskId: diskId, desiredSha256: sha256, desiredDiskNo: 1,
    mountedGameId: gameId, mountedDiskId: diskId, mountedSha256: sha256, mountedDiskNo: 1,
  }).where(eq(devices.id, deviceId));

  await page.goto(`/files?left=LIBRARY:&right=${encodeURIComponent(`LIBRARY:/${gameId}/${diskId}`)}&active=right`);
  const strip = page.getByTestId('disk-strip-right');
  await expect(strip.getByTestId('disk-strip-drive')).toHaveText('In DF0: of Strip Bench');
  await expect(strip.getByTestId(`mount-${diskId}`)).toHaveCount(0);
  await expect(strip.getByTestId('disk-strip-volume-edit')).toBeDisabled();
  await expect(page.getByTestId('pane-right-readonly')).toBeVisible();

  const eject = strip.getByTestId('disk-strip-eject');
  await expect(eject).toHaveText('Eject to edit');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/eject`) && r.request().method() === 'POST'),
    eject.click(),
  ]);
  const [row] = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  expect(row.desiredDiskId).toBeNull();
});
