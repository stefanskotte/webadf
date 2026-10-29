// Uploads from the Amiga (spec 2026-10-18 §10 increment 3), driven by a simulated board over its own routes (status,
// open, chunk, close), as e2e/send-to-amiga.spec.ts drives sending. They were the Upload page's "← From Amiga" rows;
// since Files increment 3 they are rows of STASH: in Files (R10), acted on by the button column. The Staging list's
// Clear finished and Stop are retired with it: a failed or arriving file is Deleted like any other.
import { test, expect, type Page } from '@playwright/test';
import { crc32 } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { signUpFresh } from './helpers';
import { formatVolume } from '@/lib/adffs/format';
import { FAILED_ROW } from '@/lib/files/pane-rules';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';
import { boardSays, boardOpens, boardSendsChunks, boardCloses, boardUploads, boardQueue } from './amiga-board';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right' = 'left') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  // Hydrated, so clicks reach React's handlers.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
/** A row of the left pane, where these tests keep STASH:. */
const row = (page: Page, name: string) => rowAt(page, 'left', name);
const sizeOf = (r: ReturnType<Page['locator']>) => r.locator('td:nth-child(3)');
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });
/** One upload's status in the database (stored, receiving, failed, deleted). */
const statusOf = async (id: string) =>
  (await getDb().select({ s: amigaUploads.status }).from(amigaUploads).where(eq(amigaUploads.id, id)))[0]?.s;

async function deleteRow(page: Page, name: string, text: string) {
  await row(page, name).click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-text')).toHaveText(text);
  await page.getByTestId('files-delete-confirm').click();
}

test('a file from the Amiga is in STASH: with its board, downloads as an attachment, and Delete removes it', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Docs/Café.txt', Buffer.from('hello from the Amiga\n'));
  await openFiles(page, 'STASH:', 'NET:');
  await expect(rowAt(page, 'right', 'Bench')).toContainText('key AB12');          // the digits Transfer shows
  await row(page, 'Docs').dblclick();
  const f = row(page, 'Café.txt');
  await expect(f).toContainText('from Bench');
  await expect(sizeOf(f)).toHaveText('21 B');
  await f.click();
  await expect(page.getByTestId('files-addlib')).toBeDisabled();                    // not a disk image
  const [saved] = await Promise.all([page.waitForEvent('download'), page.getByTestId('files-download').click()]);
  expect(saved.suggestedFilename()).toBe('Café.txt');                                // the fetch, then a blob saved under the Amiga name
  const dl = await page.request.get(`/api/files/download?path=${encodeURIComponent('STASH:/Docs/Café.txt')}`);
  expect(dl.headers()['content-disposition']).toBe("attachment; filename*=UTF-8''Caf%C3%A9.txt");
  expect(dl.headers()['x-content-type-options']).toBe('nosniff');
  expect(dl.headers()['content-type']).toBe('application/octet-stream');
  expect((await dl.body()).toString()).toBe('hello from the Amiga\n');

  await deleteRow(page, 'Café.txt', 'Delete “Café.txt” from STASH:? This cannot be undone.');
  await expect(f).toHaveCount(0, { timeout: LIVE });
  expect(await statusOf(id)).toBe('deleted');
});

test('an ADF goes to the library with one click, and the toast then offers Open title', async ({ page, request }) => {
  test.setTimeout(120_000);   // 55 chunks of 16 KB, each one a round trip to the database
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const adf = Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: 'FromAmiga' }));
  await boardUploads(request, token, 'Disks/FromAmiga.adf', adf);
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await row(page, 'Disks').dblclick();
  await row(page, 'FromAmiga.adf').click();
  await page.getByTestId('files-addlib').click();
  const added = toast(page, 'Added 1 disk to the library');
  await expect(added).toBeVisible({ timeout: LIVE });
  await expect(row(page, 'FromAmiga.adf')).toContainText('in the library');
  await added.getByRole('button', { name: 'Open title' }).click();
  await expect(page).toHaveURL(/\/games\//);
});

// Was "Clear finished clears a failed file and keeps the stored ones and one still arriving". Clear finished retired
// with the Staging list; in STASH: a failed file is Deleted like any other, and Delete on one still arriving stops it
// (Stop's job): the part that arrived goes and the board hears gone.
test('a failed file and one still arriving show their marks; Delete clears the failed one alone, and stops the arriving one', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const a = await boardUploads(request, token, 'A.txt', Buffer.from('a'));
  const b = await boardUploads(request, token, 'B.txt', Buffer.from('b'));
  const bad = Buffer.from('broken');
  const { id: failed } = await boardOpens(request, token, 'Bad.txt', bad.length);
  await boardSendsChunks(request, token, failed, bad);
  expect((await boardCloses(request, token, failed, ((crc32(bad) >>> 0) ^ 1) >>> 0)).status()).toBe(409);
  const { id: moving } = await boardOpens(request, token, 'Moving.bin', 20000, '1.2.3');
  expect((await request.post(`/api/device/upload/${moving}?offset=0`, {
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.alloc(16_384, 1) })).status()).toBe(200);
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await expect(row(page, 'Moving.bin')).toContainText('arriving 81%');
  await expect(row(page, 'Bad.txt')).toContainText('failed — damaged on the way: send it again');

  await deleteRow(page, 'Bad.txt', 'Delete “Bad.txt” from STASH:? This cannot be undone.');
  await expect(row(page, 'Bad.txt')).toHaveCount(0, { timeout: LIVE });
  await expect(row(page, 'A.txt')).toBeVisible();
  await expect(row(page, 'B.txt')).toBeVisible();
  await expect(row(page, 'Moving.bin')).toBeVisible();
  expect([await statusOf(a), await statusOf(b), await statusOf(failed), await statusOf(moving)])
    .toEqual(['stored', 'stored', 'deleted', 'receiving']);

  await deleteRow(page, 'Moving.bin', 'Delete “Moving.bin” from STASH:? This cannot be undone.');
  await expect(row(page, 'Moving.bin')).toHaveCount(0, { timeout: LIVE });
  expect((await request.post(`/api/device/upload/${moving}?offset=16384`, {
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.alloc(3_616, 1) })).status()).toBe(404);
});

// Was "Send to an Amiga queues the file for another board" (the row's board menu): a copy into that board under NET:.
test('a file from one board is sent to another by a copy into its NET: queue', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  const den = await pairDevice(page, request, 'Den');
  await boardSays(request, token); await boardSays(request, den.token, '1.19.0+gabc1234', 'cd34');
  await boardUploads(request, token, 'Docs/Note.txt', Buffer.from('note'));
  await openFiles(page, 'STASH:', `NET:/${den.deviceId}`);
  await row(page, 'Docs').click();
  await page.getByTestId('files-copy').click();
  await expect(toast(page, 'Queued 1 file to Den.')).toBeVisible({ timeout: LIVE });
  expect(await boardQueue(request, den.token)).toMatch(/^NEXT \S+ 4 [0-9a-f]+ 0 13:Docs\/Note\.txt /);
  await expect(rowAt(page, 'right', 'Docs/Note.txt')).toContainText('Waiting');
});

// The board <select> went with spec 2026-10-23 decision 3; every board's files show in STASH:, each naming its board,
// and the device card's line opens Files on STASH: beside that board's queue.
test("every board's files show with their board, the device card's line, and the update an older Network board needs", async ({ page, request }) => {
  await signUpFresh(page);
  const bench = await pairDevice(page, request, 'Bench');
  const den = await pairDevice(page, request, 'Den');
  const old = await pairDevice(page, request, 'Old');
  await boardSays(request, bench.token); await boardSays(request, den.token, '1.19.0+gabc1234', 'cd34');
  await boardSays(request, old.token, '1.18.2+gabc1234', 'ef56');
  await boardUploads(request, bench.token, 'Bench.txt', Buffer.from('b'));
  await boardUploads(request, den.token, 'Den.txt', Buffer.from('d'));
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await expect(row(page, 'Bench.txt')).toContainText('from Bench');
  await expect(row(page, 'Den.txt')).toContainText('from Den');
  await page.goto('/devices');
  await expect(page.getByTestId(`device-upload-${bench.deviceId}`)).toHaveText('1 file from the Amiga');
  await expect(page.getByTestId(`device-upload-${old.deviceId}`)).toHaveText('Update to 1.19.0 to send files from the Amiga');
  await page.getByTestId(`device-upload-${bench.deviceId}`).click();
  await expect.poll(() => {
    const u = new URL(page.url());
    return [u.pathname, u.searchParams.get('left'), u.searchParams.get('right'), u.searchParams.get('active')];
  }).toEqual(['/files', 'STASH:', `NET:/${bench.deviceId}`, 'left']);
  await expect(row(page, 'Bench.txt')).toBeVisible({ timeout: LIVE });
  await expect(row(page, 'Den.txt')).toBeVisible();
});

test('the Delete confirm closes on Escape without deleting', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Keep.txt', Buffer.from('keep'));
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await row(page, 'Keep.txt').click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByRole('dialog', { name: 'Delete this item?' })).toBeVisible();
  await expect(page.getByTestId('files-delete-text')).toHaveText('Delete “Keep.txt” from STASH:? This cannot be undone.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('files-delete-dialog')).toHaveCount(0);
  await expect(row(page, 'Keep.txt')).toBeVisible();
  expect(await statusOf(id)).toBe('stored');
});

// Signed out, the fetch follows the redirect to the sign-in page: a 200 with HTML. That is not a success.
test('an action answered by the sign-in page (200 text/html) says signed out and keeps the file', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Kept.txt', Buffer.from('kept'));
  await page.route('**/api/files/ops', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Sign in</title>' })
    : route.continue());
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await deleteRow(page, 'Kept.txt', 'Delete “Kept.txt” from STASH:? This cannot be undone.');
  await expect(toast(page, 'Signed out — sign in again')).toBeVisible({ timeout: LIVE });
  await expect(row(page, 'Kept.txt')).toBeVisible();
  expect(await statusOf(id)).toBe('stored');
});

test('a download the server answers 404 to gives a toast, not a saved file', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await boardUploads(request, token, 'Gone.txt', Buffer.from('gone'));
  await page.route('**/api/files/download?**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await row(page, 'Gone.txt').click();
  const saved = page.waitForEvent('download', { timeout: 1500 }).then(() => true, () => false);
  await page.getByTestId('files-download').click();
  await expect(toast(page, 'That is no longer there.')).toBeVisible({ timeout: LIVE });
  expect(await saved).toBe(false);
});

test('a file that fails its CRC shows as failed, is neither copied, downloaded nor added, can be deleted, and the board hears crc', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const data = Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: 'Damaged' }).subarray(0, 40_000));
  const { id } = await boardOpens(request, token, 'Disks/Damaged.adf', data.length);
  await boardSendsChunks(request, token, id, data);
  const close = await boardCloses(request, token, id, ((crc32(data) >>> 0) ^ 1) >>> 0);
  expect(close.status()).toBe(409);
  expect(await close.json()).toEqual({ code: 'crc' });
  // The board's queue on the right: a copy there would otherwise be offered.
  await openFiles(page, 'STASH:', `NET:/${deviceId}`);
  await row(page, 'Disks').dblclick();
  const f = row(page, 'Damaged.adf');
  await expect(f).toContainText('failed — damaged on the way: send it again');
  await f.click();
  for (const action of ['files-copy', 'files-download']) {
    await expect(page.getByTestId(action)).toBeDisabled();
    await expect(page.getByTestId(action)).toHaveAttribute('title', FAILED_ROW);
  }
  await expect(page.getByTestId('files-addlib')).toBeDisabled();
  // Dragged onto the board's queue, it says the same, not the copy's "not found".
  await page.evaluate(() => {
    // The panes' own drag, dispatched: one DataTransfer from the row's dragstart to the other pane's drop.
    const dt = new DataTransfer();
    document.querySelector('[data-testid="pane-left"] [data-testid="pane-row"][data-name="Damaged.adf"]')!
      .dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const to = document.querySelector('[data-testid="pane-right"]')!;
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(toast(page, FAILED_ROW)).toBeVisible();
  await expect(page.getByTestId('pane-right').getByTestId('pane-row')).toHaveCount(0);
  expect((await page.request.get(`/api/files/download?path=${encodeURIComponent('STASH:/Disks/Damaged.adf')}`)).status()).toBe(404);
  // A failed file had Clear on the Staging list; in STASH: it is Deleted.
  await deleteRow(page, 'Damaged.adf', 'Delete “Damaged.adf” from STASH:? This cannot be undone.');
  await expect(f).toHaveCount(0, { timeout: LIVE });
  expect(await statusOf(id)).toBe('deleted');
});

test('a file the board stopped sending resumes at the next chunk and is listed once', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const data = Buffer.alloc(20_000, 7);
  const first = await boardOpens(request, token, 'Docs/Big.bin', data.length);
  expect(first.offset).toBe(0);
  await boardSendsChunks(request, token, first.id, data, 0, 1);   // one chunk, then the board goes away
  const again = await boardOpens(request, token, 'Docs/Big.bin', data.length);
  expect(again).toEqual({ id: first.id, offset: 16_384 });
  await boardSendsChunks(request, token, again.id, data, again.offset);
  expect((await boardCloses(request, token, again.id, crc32(data) >>> 0)).status()).toBe(200);
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await row(page, 'Docs').dblclick();
  await expect(page.getByTestId('pane-left').getByTestId('pane-row')).toHaveCount(1);
  await expect(row(page, 'Big.bin')).not.toContainText('arriving');
  await expect(sizeOf(row(page, 'Big.bin'))).toHaveText('20 KB');
  expect((await getDb().select({ id: amigaUploads.id }).from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), eq(amigaUploads.path, 'Docs/Big.bin')))).length).toBe(1);
  const dl = await page.request.get(`/api/files/download?path=${encodeURIComponent('STASH:/Docs/Big.bin')}`);
  expect(Buffer.from(await dl.body()).equals(data)).toBe(true);
});

test('a STASH: pane shows a file arriving move on as the board sends it, without a reload, and stored once it closes', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const data = Buffer.alloc(40_000, 3);
  const { id } = await boardOpens(request, token, 'Slow.bin', data.length);
  await boardSendsChunks(request, token, id, data, 0, 1);
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await expect(row(page, 'Slow.bin')).toContainText('arriving 40%');
  await boardSendsChunks(request, token, id, data, 16_384, 1);
  await expect(row(page, 'Slow.bin')).toContainText('arriving 81%', { timeout: LIVE });
  await boardSendsChunks(request, token, id, data, 32_768);
  expect((await boardCloses(request, token, id, crc32(data) >>> 0)).status()).toBe(200);
  await expect(row(page, 'Slow.bin')).not.toContainText('arriving', { timeout: LIVE });
});

test('an empty file is stored and listed as 0 B', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const { id } = await boardOpens(request, token, 'Empty.txt', 0);
  expect((await boardCloses(request, token, id, 0)).status()).toBe(200);
  await openFiles(page, 'STASH:', 'LIBRARY:');
  await expect(sizeOf(row(page, 'Empty.txt'))).toHaveText('0 B');
  expect(await statusOf(id)).toBe('stored');
});
