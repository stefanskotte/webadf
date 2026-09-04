import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { readVolume, readFile, type AdfEntry } from '@/lib/adffs';
import { signUpFresh, runTag, createAdf } from './helpers';
import { cleanupSeeded, pairDevice } from './device-helpers';

/**
 * Task 12: prove the write routes end to end, ON THE BYTES.
 *
 * Every test here reads the disk back through `GET /api/disks/[id]/adf` and
 * parses it with `readVolume`/`readFile` -- the same reader the rest of the
 * app trusts -- rather than taking the page's word for what happened. A page
 * can show what you expect while the disk underneath it is wrong; that is
 * exactly the gap task-9's mutation testing (write.test.ts, adffs:verify)
 * closed for the pure functions, and this is its equivalent one layer up,
 * through the real routes and the real UI.
 *
 * Every disk here is made through `createAdf(page)` (FFS, root at block 880,
 * D-3-5), not seeded -- seedDisk's rows are byte-less and 503 on /adf, which
 * is useless for a test that has to read real bytes back.
 */

test.afterAll(cleanupSeeded);

/**
 * The one disk `createAdf(page)` just made for this org.
 *
 * THE WAIT LIVES HERE, not at the call sites, because forgetting it is
 * silent and confusing. `createAdf()` returns the moment it clicks the menu
 * item, but the disk is made by a request still in flight -- so a database
 * query fired immediately after it finds nothing, and `game.id` throws
 * "Cannot read properties of undefined". That is what all seven tests in
 * this file did on their first real run. `create-adf.spec.ts` waits for the
 * card before touching the database; this helper makes that wait
 * impossible to omit.
 */
async function authoredDisk(page: Page, orgId: string) {
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, orgId), eq(games.authored, true)));
  // A clear message beats a TypeError on undefined: if this ever fires, the
  // disk was not created, and the server log is where the reason is.
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

test('uploading a file adds it to the disk, and it reads back byte for byte', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('file-toolbar')).toBeVisible();

  const content = Buffer.from('Hello, Amiga! This file came from an e2e run.');
  await page.getByTestId('upload-input').setInputFiles({
    name: 'HELLO.TXT', mimeType: 'application/octet-stream', buffer: content,
  });
  await expect(page.getByTestId('upload-name')).toHaveValue('HELLO.TXT');
  await page.getByTestId('upload-submit').click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="HELLO.TXT"]')).toBeVisible();

  // disks.id NEVER changes; disks.sha256 always does -- a re-keyed row reads
  // as an eject in the device protocol (disk-write.ts).
  const after = await diskRow(disk.id);
  expect(after.id).toBe(disk.id);
  expect(after.sha256).not.toBe(disk.sha256);

  const adf = await fetchAdf(page, disk.id);
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  const entry = findByName(volume.root, 'HELLO.TXT');
  expect(entry).not.toBeNull();
  expect(entry!.kind).toBe('file');
  expect(entry!.sizeBytes).toBe(content.length);

  // THE POINT: the bytes themselves, read back out of the disk -- not the
  // page's word that an upload happened.
  const fileBytes = readFile(adf, entry!.block);
  expect(fileBytes).not.toBeNull();
  expect(Buffer.from(fileBytes!.bytes).equals(content)).toBe(true);
});

test('deleting a file changes the digest but leaves the id alone', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await page.goto(`/disks/${disk.id}/files`);
  const content = Buffer.from('to be deleted');
  await page.getByTestId('upload-input').setInputFiles({
    name: 'DOOMED', mimeType: 'application/octet-stream', buffer: content,
  });
  await page.getByTestId('upload-submit').click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="DOOMED"]')).toBeVisible();

  const afterUpload = await diskRow(disk.id);
  const uploadedAdf = await fetchAdf(page, disk.id);
  const uploadedVolume = readVolume(uploadedAdf);
  expect(uploadedVolume.ok).toBe(true);
  if (!uploadedVolume.ok) return;
  const entry = findByName(uploadedVolume.root, 'DOOMED')!;

  await page.getByTestId(`fs-delete-${entry.block}`).click();
  await expect(page.getByTestId(`fs-delete-confirm-${entry.block}`)).toBeVisible();
  await page.getByTestId(`fs-delete-confirm-${entry.block}`).click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="DOOMED"]')).toHaveCount(0);

  const afterDelete = await diskRow(disk.id);
  expect(afterDelete.id).toBe(disk.id);
  expect(afterDelete.sha256).not.toBe(afterUpload.sha256);

  const finalAdf = await fetchAdf(page, disk.id);
  const finalVolume = readVolume(finalAdf);
  expect(finalVolume.ok).toBe(true);
  if (!finalVolume.ok) return;
  expect(findByName(finalVolume.root, 'DOOMED')).toBeNull();
});

test('renaming rewrites the entry on the bytes, not just on the page', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await page.goto(`/disks/${disk.id}/files`);
  const content = Buffer.from('rename me');
  await page.getByTestId('upload-input').setInputFiles({
    name: 'OLDNAME', mimeType: 'application/octet-stream', buffer: content,
  });
  await page.getByTestId('upload-submit').click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="OLDNAME"]')).toBeVisible();

  const uploadedAdf = await fetchAdf(page, disk.id);
  const uploadedVolume = readVolume(uploadedAdf);
  expect(uploadedVolume.ok).toBe(true);
  if (!uploadedVolume.ok) return;
  const entry = findByName(uploadedVolume.root, 'OLDNAME')!;
  const block = entry.block;

  await page.getByTestId(`fs-rename-${block}`).click();
  await page.getByTestId(`fs-rename-name-${block}`).fill('NEWNAME');
  await page.getByTestId(`fs-rename-submit-${block}`).click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="NEWNAME"]')).toBeVisible();
  await expect(page.locator('[data-testid="fs-entry"][data-name="OLDNAME"]')).toHaveCount(0);

  const adf = await fetchAdf(page, disk.id);
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  expect(findByName(volume.root, 'OLDNAME')).toBeNull();
  const renamed = findByName(volume.root, 'NEWNAME');
  expect(renamed).not.toBeNull();
  // A rename relinks the hash chain and never touches data blocks (D-W-6) --
  // same header block, same bytes, same size.
  expect(renamed!.block).toBe(block);
  expect(renamed!.sizeBytes).toBe(content.length);
  expect(Buffer.from(readFile(adf, block)!.bytes).equals(content)).toBe(true);
});

test('a new folder is a real directory on the disk, not just a row on the page', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await page.goto(`/disks/${disk.id}/files`);
  await page.getByTestId('new-folder-trigger').click();
  await page.getByTestId('new-folder-name').fill('STUFF');
  await page.getByTestId('new-folder-submit').click();

  const dirRow = page.locator('[data-testid="fs-entry"][data-name="STUFF"]');
  await expect(dirRow).toBeVisible();
  await expect(dirRow.locator('[data-testid^="fs-toggle-"]')).toHaveCount(1);

  const adf = await fetchAdf(page, disk.id);
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  const dir = findByName(volume.root, 'STUFF');
  expect(dir).not.toBeNull();
  expect(dir!.kind).toBe('dir');
  expect(dir!.children).toEqual([]);
});

test('editing a mounted disk is refused with 409, not propagated to the device', async ({ page, request }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  // A bare request context, not the page's -- pairDevice registers a device,
  // which has no browser session (same reasoning as delete-disk.spec.ts's
  // mounted-device test).
  const { deviceId } = await pairDevice(page, request, `Board ${runTag()}`);

  const mount = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk.id } });
  expect(mount.ok()).toBe(true);

  // D-W-4: refused before anything is read or written -- no version bump on
  // the device, no propagation, just a flat refusal naming the holder.
  const res = await page.request.post(`/api/disks/${disk.id}/files`, {
    multipart: { parentBlock: '880', name: 'Nope' },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error).toBe('edit_failed');
  expect(body.reason).toMatch(/^mounted on "/);

  const unchanged = await diskRow(disk.id);
  expect(unchanged.sha256).toBe(disk.sha256);
  expect(unchanged.id).toBe(disk.id);

  // The page itself says so, computed the same way, before any control can
  // even be pressed (D-W-3/D-W-4 rationale in file-actions.tsx).
  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('file-edit-disabled')).toContainText('mounted on');
  await expect(page.getByTestId('upload-trigger')).toBeDisabled();
  await expect(page.getByTestId('new-folder-trigger')).toBeDisabled();
});

test('a TOSEC-matched disk warns before the first edit drops its identity (D-W-3)', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await getDb().update(disks)
    .set({ tosecName: 'Workbench 1.3 (1988-06-24)(Commodore)[cr WOC].adf' })
    .where(eq(disks.id, disk.id));
  // tosecName alone is NOT what makes this disk "matched" -- it also holds
  // the uploaded/authored filename for every disk that has never matched
  // anything (fix round 3). The real verdict lives on the blob, so it has
  // to be stamped too, or this test would pass even if the page ignored
  // matchState entirely and warned on every disk regardless.
  await getDb().update(blobs)
    .set({ matchState: 'matched', matchCheckedAt: new Date() })
    .where(eq(blobs.sha256, disk.sha256));

  await page.goto(`/disks/${disk.id}/files`);

  // Attempt one, cancelled: no edit reaches the disk at all.
  await page.getByTestId('new-folder-trigger').click();
  await page.getByTestId('new-folder-name').fill('Cancelled');
  await page.getByTestId('new-folder-submit').click();
  await expect(page.getByTestId('identity-confirm-dialog')).toBeVisible();
  await page.getByTestId('identity-confirm-cancel').click();
  await expect(page.getByTestId('identity-confirm-dialog')).toHaveCount(0);
  await expect(page.locator('[data-testid="fs-entry"][data-name="Cancelled"]')).toHaveCount(0);

  const afterCancel = await diskRow(disk.id);
  expect(afterCancel.sha256).toBe(disk.sha256);

  // Attempt two, confirmed: the edit proceeds, and the disk is genuinely
  // rewritten under a new digest -- the confirmation is not just cosmetic.
  await page.getByTestId('new-folder-trigger').click();
  await page.getByTestId('new-folder-name').fill('Proceeded');
  await page.getByTestId('new-folder-submit').click();
  await expect(page.getByTestId('identity-confirm-dialog')).toBeVisible();
  await page.getByTestId('identity-confirm-proceed').click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="Proceeded"]')).toBeVisible();

  const afterProceed = await diskRow(disk.id);
  expect(afterProceed.id).toBe(disk.id);
  expect(afterProceed.sha256).not.toBe(disk.sha256);

  const adf = await fetchAdf(page, disk.id);
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  expect(findByName(volume.root, 'Proceeded')).not.toBeNull();
});

test('another tenant gets 404 on every write route, never the disk', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const ua = await signUpFresh(pa);
  await signUpFresh(pb);

  await pa.goto('/library');
  await createAdf(pa);
  const disk = await authoredDisk(pa, ua.orgId);

  const post = await pb.request.post(`/api/disks/${disk.id}/files`, {
    multipart: { parentBlock: '880', name: 'Intruder' },
  });
  expect(post.status()).toBe(404);

  const patch = await pb.request.patch(`/api/disks/${disk.id}/files/880`, {
    data: { name: 'Intruder' },
  });
  expect(patch.status()).toBe(404);

  const del = await pb.request.delete(`/api/disks/${disk.id}/files/880`);
  expect(del.status()).toBe(404);

  const get = await pb.request.get(`/api/disks/${disk.id}/files/880`);
  // TEMP DIAGNOSTIC -- remove after establishing why this returns 200.
  console.log('DIAG status', get.status());
  console.log('DIAG url', get.url());
  console.log('DIAG content-type', get.headers()['content-type']);
  console.log('DIAG body', (await get.body()).toString('utf8').slice(0, 500));
  expect(get.status()).toBe(404);

  const unchanged = await diskRow(disk.id);
  expect(unchanged.sha256).toBe(disk.sha256);
  expect(unchanged.id).toBe(disk.id);

  await a.close();
  await b.close();
});
