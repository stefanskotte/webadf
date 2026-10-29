import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume, readFile, type AdfEntry } from '@/lib/adffs';
import { signUpFresh, runTag, createAdf, openTitleMenu, openVersion } from './helpers';
import { cleanupSeeded, pairDevice, hydrated } from './device-helpers';

/**
 * Task 6: the time machine, end to end -- history, browsing an old version
 * read-only, restoring one, and the mounted-disk refusal deferred from piece
 * 2b's own acceptance list (spec §4).
 *
 * Every disk here is made through `createAdf(page)` (FFS, root at block 880),
 * exactly as e2e/disk-files-edit.spec.ts does, not seeded: seedDisk's rows
 * are byte-less and give this file nothing to actually edit through the UI,
 * which is how every version in a disk's history here gets created.
 */

test.afterAll(cleanupSeeded);

/** The one disk `createAdf(page)` just made for this org -- see disk-files-edit.spec.ts's identical helper for why the wait lives here. */
async function authoredDisk(page: Page, orgId: string) {
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, orgId), eq(games.authored, true)));
  if (!game) throw new Error(`no authored game for org ${orgId} after createAdf`);
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  if (!disk) throw new Error(`authored game ${game.id} has no disk row`);
  return disk;
}

async function diskRow(id: string) {
  return (await getDb().select().from(disks).where(eq(disks.id, id)))[0];
}

async function fetchAdf(page: Page, diskId: string): Promise<Uint8Array> {
  const res = await page.request.get(`/api/disks/${diskId}/adf`);
  expect(res.status()).toBe(200);
  return new Uint8Array(await res.body());
}

function findByName(entries: AdfEntry[], name: string): AdfEntry | null {
  for (const e of entries) if (e.name === name) return e;
  return null;
}

/** The same 15 s bound as disk-files-edit.spec.ts: a restore is a server round trip and then the pane's reload. */
const AFTER_EDIT = { timeout: 15_000 };

/**
 * Add one file to the disk's root, each a new version. Through the file route rather than a page: since Files
 * increment 1 the disk's head is edited in Files, and what this file tests is the History, not how a version is made.
 */
async function uploadFile(page: Page, diskId: string, name: string, content: string) {
  const res = await page.request.post(`/api/disks/${diskId}/files`, {
    multipart: { parentBlock: '880', name, file: { name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) } },
  });
  expect(res.ok()).toBe(true);
}

/** Files with the disk on the right, and its strip's History open over the pane. */
async function openHistory(page: Page, disk: { id: string; gameId: string }) {
  await page.goto(`/files?left=LIBRARY:&right=${encodeURIComponent(`LIBRARY:/${disk.gameId}/${disk.id}`)}&active=right`);
  await hydrated(page, 'disk-strip-history-toggle');
  await page.getByTestId('disk-strip-history-toggle').click();
  await expect(page.getByTestId('history-panel')).toBeVisible();
}

const paneRow = (page: Page, name: string) => page.getByTestId('pane-right').locator(`[data-testid="pane-row"][data-name="${name}"]`);

test('history lists what changed, newest first, with version 0 as uploaded', async ({ page }) => {
  test.setTimeout(60_000); // same two uploads as the browsing test below; see its measurement
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await uploadFile(page, disk.id, 'FIRST.TXT', 'the first file');
  await uploadFile(page, disk.id, 'SECOND.TXT', 'the second file');

  await openHistory(page, disk);
  const panel = page.getByTestId('history-panel');
  const rows = panel.locator('li[data-testid^="version-"]');
  await expect(rows).toHaveCount(3);

  // Newest first: version 2 (the second upload) is the first row and the head.
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'version-2');
  await expect(rows.nth(0)).toHaveAttribute('data-head', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'version-1');
  await expect(rows.nth(2)).toHaveAttribute('data-testid', 'version-0');

  // The newest version reports SECOND.TXT as added.
  await expect(page.getByTestId('changes-2')).toContainText('SECOND.TXT');

  // Version 0 is labelled as the upload, not as an edit.
  await expect(page.getByTestId('version-0')).toContainText('As uploaded');
});

test('the library card reaches the history, and the wordmark leads back', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  // The gallery is where people start, and before this the history was only
  // reachable by opening the title, then the disk, then scrolling (operator,
  // 2026-09-21).
  await openTitleMenu(page, disk.gameId);
  const history = page.getByTestId(`history-${disk.gameId}`);
  await expect(history).toBeVisible();
  await history.click();

  // Files with the disk on the right, its History open over the pane.
  await expect(page).toHaveURL(/\/files\?left=LIBRARY.*#disk-history$/);
  await expect(page.getByTestId('disk-strip-right')).toBeVisible();
  await expect(page.getByTestId('history-panel')).toBeVisible();
  // The card must not ALSO navigate to the title: the button lives inside the
  // card's own <a href>, and an unstopped click would do both.
  await expect(page).not.toHaveURL(new RegExp(`/games/${disk.gameId}`));

  // And the way home, from a page deep in the app.
  await page.getByTestId('wordmark-home').click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByTestId('game-card')).toHaveCount(1);
});

test('browsing an old version shows its tree read-only, with no edit controls', async ({ page }) => {
  // Measured 2026-10-25 against the shared remote DB, six runs: sign-up 6.5-7.8 s, createAdf ~5 s, each upload
  // 6.5-7.4 s, so 26.3 to 38.4 s end to end -- at or past Playwright's 30 s default. Worst case 38.4 s + 50% = 60 s.
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await uploadFile(page, disk.id, 'FIRST.TXT', 'the first file');
  await uploadFile(page, disk.id, 'SECOND.TXT', 'the second file');

  // Version 1: right after the first upload, before the second file existed.
  await page.goto(`/disks/${disk.id}/files?version=1`);

  await expect(page.locator('[data-testid="fs-entry"][data-name="FIRST.TXT"]')).toBeVisible();
  await expect(page.locator('[data-testid="fs-entry"][data-name="SECOND.TXT"]')).toHaveCount(0);

  await expect(page.getByTestId('version-banner')).toHaveAttribute('data-version', '1');
  await expect(page.getByTestId('version-banner')).toContainText('version 1');

  // No edit control offered: the toolbar states why, and every trigger is disabled.
  await expect(page.getByTestId('file-edit-disabled')).toContainText('version 1');
  await expect(page.getByTestId('file-edit-disabled')).toContainText('read-only');
  await expect(page.getByTestId('upload-trigger')).toBeDisabled();
  await expect(page.getByTestId('new-folder-trigger')).toBeDisabled();
});

// The heaviest test in this file: a sign-up, a created disk, two uploads
// (each two round trips to the live database, ~3 s apiece -- see
// disk-files-edit.spec.ts's own measured note), a restore that materialises
// an old version, and then a whole 880 KB image downloaded back. That is
// comfortably past Playwright's 30 s default, and it timed out on the image
// fetch with everything else already green. The budget is the only thing
// raised here; every assertion still has its own AFTER_EDIT window.
test.describe(() => {
  test.setTimeout(120_000);

test('restoring an old version brings its content back as a new version', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await uploadFile(page, disk.id, 'FIRST.TXT', 'the first file');
  await uploadFile(page, disk.id, 'SECOND.TXT', 'the second file');
  await openHistory(page, disk);

  const beforeRestore = await diskRow(disk.id);
  // Browser edits keep the volume's creation date, so this is also version 1's.
  const before = readVolume(await fetchAdf(page, disk.id));
  if (!before.ok) throw new Error('fixture: the disk should read before the restore');
  const createdBefore = before.volume.createdAt!.getTime();

  await openVersion(page, 1);
  await page.getByTestId('restore-1').click();
  await expect(page.getByTestId('restore-dialog')).toBeVisible();
  await expect(page.getByTestId('restore-dialog')).toContainText('Restore version 1?');
  await page.getByTestId('restore-confirm').click();
  await expect(page.getByTestId('restore-dialog')).toHaveCount(0, AFTER_EDIT);

  // SECOND.TXT (added in version 2) is gone from the disk; FIRST.TXT remains -- the pane reloads after the restore.
  await expect(paneRow(page, 'SECOND.TXT')).toHaveCount(0, AFTER_EDIT);
  await expect(paneRow(page, 'FIRST.TXT')).toBeVisible();

  // Nothing was deleted from history: four entries now (0, 1, 2, 3), and the
  // disk got a genuinely new digest, not a reuse of version 1's own.
  const panel = page.getByTestId('history-panel');
  await expect(panel.locator('li[data-testid^="version-"]')).toHaveCount(4, AFTER_EDIT);
  await expect(page.getByTestId('version-3')).toContainText('Restored to version 1');
  await expect(page.getByTestId('version-3')).toHaveAttribute('data-head', 'true');

  const afterRestore = await diskRow(disk.id);
  expect(afterRestore.id).toBe(disk.id);
  expect(afterRestore.sha256).not.toBe(beforeRestore.sha256);

  // THE POINT: the bytes themselves, not the page's word for it.
  const adf = await fetchAdf(page, disk.id);
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  expect(findByName(volume.root, 'SECOND.TXT')).toBeNull();
  const first = findByName(volume.root, 'FIRST.TXT');
  expect(first).not.toBeNull();
  const bytes = readFile(adf, first!.block);
  expect(bytes).not.toBeNull();
  expect(Buffer.from(bytes!.bytes).toString()).toBe('the first file');

  // The restored volume is one tick (1/50 s) younger, so a running Amiga takes
  // it for a new volume instead of the one it remembers (HANDOFF 3ar).
  expect(volume.volume.createdAt!.getTime() - createdBefore).toBe(20);
});

});

// Same reasoning as the restore test above (HANDOFF §4l): fetchAdf downloads
// the same ~880 KB image, which alone is well inside 30 s but leaves no slack
// once the setup, mount, and two restore round trips ahead of it are counted.
test.describe(() => {
  test.setTimeout(120_000);

test('restore is refused while a board holds the disk, and succeeds once ejected', async ({ page, request }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await uploadFile(page, disk.id, 'ONLY.TXT', 'the only file');
  const beforeAttempt = await diskRow(disk.id);

  // A bare request context, not the page's -- pairDevice registers a device,
  // which has no browser session (same reasoning as device-write.spec.ts).
  const { deviceId } = await pairDevice(page, request, `Board ${runTag()}`);
  const mount = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk.id } });
  expect(mount.ok()).toBe(true);

  // D-W-4, same as every other route that rewrites a disk's bytes: refused
  // before anything is read or written, naming the holder.
  const refused = await page.request.post(`/api/disks/${disk.id}/restore`, {
    data: { seq: 0 }, maxRedirects: 0,
  });
  expect(refused.status()).toBe(409);
  const refusedBody = await refused.json();
  expect(refusedBody.error).toBe('mounted');
  expect(refusedBody.reason).toMatch(/^mounted on "/);

  const unchanged = await diskRow(disk.id);
  expect(unchanged.sha256).toBe(beforeAttempt.sha256);
  expect(unchanged.id).toBe(disk.id);

  // The panel says so too, before anyone even tries.
  await openHistory(page, disk);
  await expect(page.getByTestId('history-mounted-notice')).toContainText('mounted on');
  await openVersion(page, 0);
  await expect(page.getByTestId('restore-0')).toBeDisabled();

  // Eject, and the identical request now succeeds.
  const eject = await page.request.post(`/api/devices/${deviceId}/eject`);
  expect(eject.ok()).toBe(true);

  const allowed = await page.request.post(`/api/disks/${disk.id}/restore`, {
    data: { seq: 0 }, maxRedirects: 0,
  });
  expect(allowed.status()).toBe(200);

  const restored = await diskRow(disk.id);
  expect(restored.sha256).not.toBe(unchanged.sha256);
  const adf = await fetchAdf(page, disk.id);
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  expect(findByName(volume.root, 'ONLY.TXT')).toBeNull();
});

});

// A board that mounts the disk while the confirm is open: the 409 disables both Restore buttons, and a disabled button
// cannot take focus back -- so focus lands on the History heading, never <body>.
test('a board mounting the disk during the restore confirm sends focus to the History heading', async ({ page, request }) => {
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  await uploadFile(page, disk.id, 'ONLY.TXT', 'the only file');
  const { deviceId } = await pairDevice(page, request, `Board ${runTag()}`);

  await openHistory(page, disk);
  await openVersion(page, 0);
  await page.getByTestId('restore-0').click();
  await expect(page.getByTestId('restore-dialog')).toBeVisible();
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk.id } })).ok()).toBe(true);
  await page.getByTestId('restore-confirm').click();

  await expect(page.getByTestId('restore-0')).toBeDisabled();
  await expect(page.getByTestId('restore-dialog')).toBeHidden();
  await expect(page.locator('#history-heading')).toBeFocused();
});

test('another tenant gets 404 from restore and from browsing history', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const ua = await signUpFresh(pa);
  await signUpFresh(pb);

  await pa.goto('/library');
  await createAdf(pa);
  const disk = await authoredDisk(pa, ua.orgId);
  await uploadFile(pa, disk.id, 'FIRST.TXT', 'the first file');

  // Same maxRedirects: 0 rationale as disk-files-edit.spec.ts's tenant test:
  // requireOrg() redirects an unscoped session to /sign-in, and Playwright
  // follows redirects by default -- pinning this to 0 is what makes a 404
  // here mean what it says, rather than a followed sign-in page that
  // happens to also answer 404 or, worse, 200.
  const restore = await pb.request.post(`/api/disks/${disk.id}/restore`, {
    data: { seq: 0 }, maxRedirects: 0,
  });
  expect(restore.status()).toBe(404);
  expect(await restore.json()).toEqual({ error: 'not_found' });

  // A1: the app streams behind loading.tsx, so a notFound() page is HTTP 200 with the not-found card; the API route
  // above still answers 404.
  await pb.goto(`/disks/${disk.id}/files?version=0`);
  await expect(pb.getByTestId('not-found-page')).toBeVisible();
  await expect(pb.getByTestId('file-tree')).toHaveCount(0);

  const unchanged = await diskRow(disk.id);
  expect(unchanged.id).toBe(disk.id);

  await a.close();
  await b.close();
});
