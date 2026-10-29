import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { readVolume, readFile, type AdfEntry } from '@/lib/adffs';
import { signUpFresh, runTag, createAdf } from './helpers';
import { cleanupSeeded, pairDevice } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

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
 *
 * Files increment 1 (Task 11): the edits are made in the Files manager, the disk open in its right pane -- the
 * Browse page's toolbar and row menus are gone from the head of a disk (its address redirects to Files). A file
 * from the computer arrives through the drop review (R5), as it does in Files.
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

/**
 * How long a tree assertion that follows an edit may wait. NOT the 5 s default.
 *
 * An edit here is two server round trips before the page can change: the
 * edit request itself, then the `router.refresh()` that re-renders the files
 * page (file-actions.tsx). Against the live database from a dev machine,
 * measured 2026-09-19 over 77 traced edits: the edit took 1.7-4.4 s, the
 * refresh 0.8-1.9 s, and click-to-refresh-complete reached 4.95 s -- right
 * on the default 5 s, which is what made this file fail one run in three,
 * a different test each time. Every refresh that completed carried the
 * edited tree (75 of 75); the failures were refreshes still streaming when
 * the default timeout expired, NOT stale data. Same 15 s, for the same
 * reason, as mobile.spec.ts's upload and disk-drag-drop.spec.ts's commit.
 */
const AFTER_EDIT = { timeout: 15_000 };

/** The disk open in Files, on the right, hydrated so clicks, keys and drops reach React. */
async function openInFiles(page: Page, disk: { id: string; gameId: string }) {
  const right = `LIBRARY:/${disk.gameId}/${disk.id}`;
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right, active: 'right' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

const paneRow = (page: Page, name: string) =>
  page.getByTestId('pane-right').locator(`[data-testid="pane-row"][data-name="${name}"]`);

/** A file from the computer dropped on the right pane, through the drop review. */
async function dropFile(page: Page, name: string, content: Buffer) {
  await synthDrop(page, [{ name, kind: 'file', bytes: [...content] }], '[data-testid="pane-right"]');
  const review = page.getByTestId('files-drop-review');
  await expect(review.getByTestId('drop-staging-list')).toContainText(name);
  await review.getByTestId('drop-commit').click();
  await expect(review).toHaveCount(0, AFTER_EDIT);
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

  await openInFiles(page, disk);
  const content = Buffer.from('Hello, Amiga! This file came from an e2e run.');
  await dropFile(page, 'HELLO.TXT', content);
  await expect(paneRow(page, 'HELLO.TXT')).toBeVisible(AFTER_EDIT);

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

  await openInFiles(page, disk);
  await dropFile(page, 'DOOMED', Buffer.from('to be deleted'));
  await expect(paneRow(page, 'DOOMED')).toBeVisible(AFTER_EDIT);
  const afterUpload = await diskRow(disk.id);

  await paneRow(page, 'DOOMED').click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-dialog')).toContainText('DOOMED');
  await page.getByTestId('files-delete-confirm').click();
  await expect(paneRow(page, 'DOOMED')).toHaveCount(0, AFTER_EDIT);

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

  await openInFiles(page, disk);
  const content = Buffer.from('rename me');
  await dropFile(page, 'OLDNAME', content);
  await expect(paneRow(page, 'OLDNAME')).toBeVisible(AFTER_EDIT);

  const uploadedAdf = await fetchAdf(page, disk.id);
  const uploadedVolume = readVolume(uploadedAdf);
  expect(uploadedVolume.ok).toBe(true);
  if (!uploadedVolume.ok) return;
  const block = findByName(uploadedVolume.root, 'OLDNAME')!.block;

  await paneRow(page, 'OLDNAME').click();
  await page.getByTestId('files-rename').click();
  await expect(page.getByTestId('files-name-input')).toHaveValue('OLDNAME');
  await page.getByTestId('files-name-input').fill('NEWNAME');
  await page.getByTestId('files-name-save').click();
  await expect(paneRow(page, 'NEWNAME')).toBeVisible(AFTER_EDIT);
  await expect(paneRow(page, 'OLDNAME')).toHaveCount(0);

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

  await openInFiles(page, disk);
  await page.getByTestId('files-makedir').click();
  await page.getByTestId('files-name-input').fill('STUFF');
  await page.getByTestId('files-name-save').click();

  const dirRow = paneRow(page, 'STUFF');
  await expect(dirRow).toBeVisible(AFTER_EDIT);
  await expect(dirRow).toHaveAttribute('data-kind', 'dir');

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

  // Files' own route refuses the same way, naming the holder.
  const right = `LIBRARY:/${disk.gameId}/${disk.id}`;
  const op = await page.request.post('/api/files/ops', { data: { op: 'makedir', dest: right, name: 'Nope' } });
  expect(op.status()).toBe(409);
  expect((await op.json()).detail).toMatch(/^mounted on "/);

  const unchanged = await diskRow(disk.id);
  expect(unchanged.sha256).toBe(disk.sha256);
  expect(unchanged.id).toBe(disk.id);

  // The pane itself says so, computed the same way, before any control can
  // even be pressed: every button that writes is off, with the reason.
  await openInFiles(page, disk);
  await expect(page.getByTestId('pane-right-readonly')).toContainText('mounted on');
  await expect(page.getByTestId('files-makedir')).toBeDisabled();
  await expect(page.getByTestId('files-makedir')).toHaveAttribute('title', /mounted on/);
  // A computer drop is refused too, with nothing staged.
  await synthDrop(page, [{ name: 'Nope.txt', kind: 'file', content: 'x' }], '[data-testid="pane-right"]');
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'mounted on' })).toBeVisible();
  await expect(page.getByTestId('files-drop-review')).toHaveCount(0);
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

  await openInFiles(page, disk);

  // Attempt one, cancelled: no edit reaches the disk at all. Files asks
  // before the name, so Cancel opens nothing.
  await page.getByTestId('files-makedir').click();
  await expect(page.getByTestId('identity-confirm-dialog')).toBeVisible();
  await page.getByTestId('identity-confirm-cancel').click();
  await expect(page.getByTestId('identity-confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('files-name-dialog')).toHaveCount(0);

  const afterCancel = await diskRow(disk.id);
  expect(afterCancel.sha256).toBe(disk.sha256);

  // Attempt two, confirmed: the edit proceeds, and the disk is genuinely
  // rewritten under a new digest -- the confirmation is not just cosmetic.
  await page.getByTestId('files-makedir').click();
  await expect(page.getByTestId('identity-confirm-dialog')).toBeVisible();
  await page.getByTestId('identity-confirm-proceed').click();
  await page.getByTestId('files-name-input').fill('Proceeded');
  await page.getByTestId('files-name-save').click();
  await expect(paneRow(page, 'Proceeded')).toBeVisible(AFTER_EDIT);

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

  // maxRedirects: 0 on every call here, deliberately. requireOrg() redirects
  // to /sign-in on a missing/unscoped session, and Playwright's
  // request.*() follow redirects by default -- so a 404 assertion alone
  // would just as happily pass if the handler redirected and the redirect
  // target happened to answer 404, and would MISS a redirect that resolved
  // to 200 (sign-in HTML, not JSON, but still status 200). Pinning
  // maxRedirects to 0 turns any such redirect into an unmissable 3xx
  // instead of letting it hide behind a followed response. Do not "simplify"
  // this away: it is what makes the 404 below mean what it says.
  const post = await pb.request.post(`/api/disks/${disk.id}/files`, {
    multipart: { parentBlock: '880', name: 'Intruder' },
    maxRedirects: 0,
  });
  expect(post.status()).toBe(404);

  const patch = await pb.request.patch(`/api/disks/${disk.id}/files/880`, {
    data: { name: 'Intruder' },
    maxRedirects: 0,
  });
  expect(patch.status()).toBe(404);

  const del = await pb.request.delete(`/api/disks/${disk.id}/files/880`, {
    maxRedirects: 0,
  });
  expect(del.status()).toBe(404);

  const get = await pb.request.get(`/api/disks/${disk.id}/files/880`, {
    maxRedirects: 0,
  });
  expect(get.status()).toBe(404);
  // Belt and braces on the one route that can legitimately return bytes:
  // even at 404 this pins the response to the JSON error shape the route
  // actually emits, so a future regression that swaps in disk bytes (or a
  // followed sign-in redirect, which would arrive as text/html) fails on
  // content, not just on a status code that two different bugs could both
  // produce.
  expect(get.headers()['content-type']).toContain('application/json');
  expect(await get.json()).toEqual({ error: 'not_found' });

  const unchanged = await diskRow(disk.id);
  expect(unchanged.sha256).toBe(disk.sha256);
  expect(unchanged.id).toBe(disk.id);

  await a.close();
  await b.close();
});
