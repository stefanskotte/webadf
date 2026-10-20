// Uploads from the Amiga (spec 2026-10-18 §10 increment 3): the From the Amiga area, driven by a simulated board over
// its own routes (status, open, chunk, close), as e2e/send-to-amiga.spec.ts drives sending.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { crc32 } from 'node:zlib';
import { signUpFresh } from './helpers';
import { formatVolume } from '@/lib/adffs/format';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

/** The board reports its firmware, Network mode and its key digits. */
async function boardSays(request: APIRequestContext, token: string, firmware = '1.19.0+gabc1234', upKey = 'ab12') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: firmware, secondDrive: 'net', driveVersion: 0, upKey } })).status()).toBe(204);
}
/** What a 1.19.0 board does for one PUT: open, 16 KB chunks, close. */
async function boardUploads(request: APIRequestContext, token: string, path: string, data: Buffer, date = '17000.600.0') {
  const open = await request.post('/api/device/upload', { headers: authHeader(token), data: { size: data.length, date, protection: 0, path, comment: '' } });
  expect(open.status()).toBe(200);
  const { id, offset } = (await open.json()) as { id: string; offset: number };
  for (let at = offset; at < data.length; at += 16_384) {
    const r = await request.post(`/api/device/upload/${id}?offset=${at}`, {
      headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: data.subarray(at, Math.min(at + 16_384, data.length)),
    });
    expect(r.status()).toBe(200);
  }
  expect((await request.post(`/api/device/upload/${id}/close`, { headers: authHeader(token), data: { crc32: crc32(data) >>> 0 } })).status()).toBe(200);
  return id;
}

test('a file from the Amiga appears with its board, downloads as an attachment, and Delete removes it', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await page.goto('/ingest');
  await expect(page.getByTestId('from-amiga-empty')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('from-amiga-key')).toContainText('AB12');            // the digits Receive shows
  const id = await boardUploads(request, token, 'Docs/Café.txt', Buffer.from('hello from the Amiga\n'));
  const row = page.getByTestId(`from-amiga-row-${id}`);
  await expect(row).toHaveAttribute('data-status', 'stored', { timeout: LIVE });
  await expect(row).toContainText('Docs/Café.txt');
  await expect(row).toContainText('from Bench');
  const [saved] = await Promise.all([page.waitForEvent('download'), page.getByTestId(`from-amiga-download-${id}`).click()]);
  expect(saved.suggestedFilename()).toBe('Café.txt');                                  // the fetch, then a blob saved under the Amiga name
  const dl = await page.request.get(`/api/uploads/${id}/file`);
  expect(dl.headers()['content-disposition']).toBe("attachment; filename=\"Caf_.txt\"; filename*=UTF-8''Caf%C3%A9.txt");   // ASCII fallback, then the UTF-8 name
  expect(dl.headers()['x-content-type-options']).toBe('nosniff');
  expect(dl.headers()['content-type']).toBe('application/octet-stream');
  expect((await dl.body()).toString()).toBe('hello from the Amiga\n');
  await expect(page.getByTestId(`from-amiga-library-${id}`)).toHaveCount(0);       // not a disk image
  await page.getByTestId(`from-amiga-delete-${id}`).click();
  await expect(row).toHaveCount(0, { timeout: LIVE });
});

test('an ADF goes to the library with one click, and the row says In library', async ({ page, request }) => {
  test.setTimeout(120_000);   // 55 chunks of 16 KB, each one a round trip to the database
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const adf = Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: 'FromAmiga' }));
  const id = await boardUploads(request, token, 'Disks/FromAmiga.adf', adf);
  await page.goto('/ingest');
  await page.getByTestId(`from-amiga-library-${id}`).click();
  await expect(page.getByTestId(`from-amiga-in-library-${id}`)).toBeVisible({ timeout: LIVE });
  await page.getByTestId(`from-amiga-in-library-${id}`).click();
  await expect(page).toHaveURL(/\/games\//);
});

test('Clear all names the count, spares a file still arriving and one that arrived during the confirm', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const a = await boardUploads(request, token, 'A.txt', Buffer.from('a'));
  const b = await boardUploads(request, token, 'B.txt', Buffer.from('b'));
  const open = await request.post('/api/device/upload', { headers: authHeader(token), data: { size: 20000, date: '1.2.3', protection: 0, path: 'Moving.bin', comment: '' } });
  const { id: moving } = (await open.json()) as { id: string };
  expect((await request.post(`/api/device/upload/${moving}?offset=0`, {
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.alloc(16_384, 1) })).status()).toBe(200);
  await page.goto('/ingest');
  await expect(page.getByTestId(`from-amiga-state-${moving}`)).toContainText('Arriving 81 %', { timeout: LIVE });
  await page.getByTestId('from-amiga-clear').click();
  await expect(page.getByTestId('from-amiga-confirm')).toContainText('Clear 2 files from the Amiga?');
  const late = await boardUploads(request, token, 'Late.txt', Buffer.from('late'));   // arrives while the confirm is open
  await page.getByTestId('from-amiga-confirm-yes').click();
  await expect(page.getByTestId(`from-amiga-row-${a}`)).toHaveCount(0, { timeout: LIVE });
  await expect(page.getByTestId(`from-amiga-row-${b}`)).toHaveCount(0);
  await expect(page.getByTestId(`from-amiga-row-${moving}`)).toBeVisible();
  await expect(page.getByTestId(`from-amiga-row-${late}`)).toBeVisible({ timeout: LIVE });
});

test('Send to an Amiga queues the file for another board', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  const { token: den } = await pairDevice(page, request, 'Den');
  await boardSays(request, token); await boardSays(request, den, '1.19.0+gabc1234', 'cd34');
  const id = await boardUploads(request, token, 'Docs/Note.txt', Buffer.from('note'));
  await page.goto('/ingest');
  await page.getByTestId(`from-amiga-send-${id}`).selectOption({ label: 'Den' });
  await expect(page.getByText('Queued for Den')).toBeVisible({ timeout: LIVE });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(den) })).body()).toString('latin1');
  expect(q).toMatch(/^NEXT \S+ 4 [0-9a-f]+ 0 13:Docs\/Note\.txt /);
});

test("the board filter, the device card's line, and the update an older Network board needs", async ({ page, request }) => {
  await signUpFresh(page);
  const bench = await pairDevice(page, request, 'Bench');
  const den = await pairDevice(page, request, 'Den');
  const old = await pairDevice(page, request, 'Old');
  await boardSays(request, bench.token); await boardSays(request, den.token, '1.19.0+gabc1234', 'cd34');
  await boardSays(request, old.token, '1.18.2+gabc1234', 'ef56');
  const fromBench = await boardUploads(request, bench.token, 'Bench.txt', Buffer.from('b'));
  const fromDen = await boardUploads(request, den.token, 'Den.txt', Buffer.from('d'));
  await page.goto('/ingest');
  await page.getByTestId('from-amiga-board').selectOption({ label: 'Den (key CD34)' });
  await expect(page.getByTestId(`from-amiga-row-${fromBench}`)).toHaveCount(0, { timeout: LIVE });
  await expect(page.getByTestId(`from-amiga-row-${fromDen}`)).toBeVisible();
  await page.goto('/devices');
  await expect(page.getByTestId(`device-upload-${bench.deviceId}`)).toHaveText('1 file from the Amiga');
  await expect(page.getByTestId(`device-upload-${old.deviceId}`)).toHaveText('Update to 1.19.0 to send files from the Amiga');
  await page.getByTestId(`device-upload-${bench.deviceId}`).click();
  await expect(page).toHaveURL(new RegExp(`/ingest\\?from=${bench.deviceId}#from-amiga`));
  await expect(page.getByTestId(`from-amiga-row-${fromBench}`)).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId(`from-amiga-row-${fromDen}`)).toHaveCount(0);
});
test('Clear all with a board filter on leaves the other board\'s finished file', async ({ page, request }) => {
  await signUpFresh(page);
  const bench = await pairDevice(page, request, 'Bench');
  const den = await pairDevice(page, request, 'Den');
  await boardSays(request, bench.token); await boardSays(request, den.token, '1.19.0+gabc1234', 'cd34');
  const fromBench = await boardUploads(request, bench.token, 'Bench.txt', Buffer.from('b'));
  const fromDen = await boardUploads(request, den.token, 'Den.txt', Buffer.from('d'));
  await page.goto('/ingest');
  await expect(page.getByTestId(`from-amiga-row-${fromDen}`)).toBeVisible({ timeout: LIVE });
  await page.getByTestId('from-amiga-board').selectOption({ label: 'Bench (key AB12)' });
  await expect(page.getByTestId(`from-amiga-row-${fromDen}`)).toHaveCount(0, { timeout: LIVE });
  await page.getByTestId('from-amiga-clear').click();
  await expect(page.getByTestId('from-amiga-confirm')).toContainText('Clear 1 file from the Amiga?');
  await page.getByTestId('from-amiga-confirm-yes').click();
  await expect(page.getByTestId(`from-amiga-row-${fromBench}`)).toHaveCount(0, { timeout: LIVE });
  await page.getByTestId('from-amiga-board').selectOption({ label: 'All boards' });
  await expect(page.getByTestId(`from-amiga-row-${fromDen}`)).toBeVisible({ timeout: LIVE });
});

test('the Clear all confirm focuses Cancel and Escape closes it without clearing', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Keep.txt', Buffer.from('keep'));
  await page.goto('/ingest');
  await expect(page.getByTestId(`from-amiga-row-${id}`)).toBeVisible({ timeout: LIVE });
  await page.getByTestId('from-amiga-clear').click();
  await expect(page.getByTestId('from-amiga-confirm-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('from-amiga-confirm')).toHaveCount(0);
  await expect(page.getByTestId('from-amiga-clear')).toBeFocused();
  await expect(page.getByTestId(`from-amiga-row-${id}`)).toBeVisible();
});

test('a download the server answers 404 to gives a toast, not a saved file', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Gone.txt', Buffer.from('gone'));
  await page.route(`**/api/uploads/${id}/file`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
  await page.goto('/ingest');
  await expect(page.getByTestId(`from-amiga-row-${id}`)).toBeVisible({ timeout: LIVE });
  let saved = false;
  page.on('download', () => { saved = true; });
  await page.getByTestId(`from-amiga-download-${id}`).click();
  await expect(page.getByText('That file is no longer here.')).toBeVisible({ timeout: LIVE });
  expect(saved).toBe(false);
});
