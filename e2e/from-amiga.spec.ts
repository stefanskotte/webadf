// Uploads from the Amiga (spec 2026-10-18 §10 increment 3), shown as the Staging list's "← From Amiga" rows (spec
// 2026-10-23 §2), driven by a simulated board over its own routes (status, open, chunk, close), as
// e2e/send-to-amiga.spec.ts drives sending.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { crc32 } from 'node:zlib';
import { signUpFresh } from './helpers';
import { formatVolume } from '@/lib/adffs/format';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

/** The Staging list's row of one file from the Amiga (key `amiga:<id>`), its status, and one of its actions. */
const row = (page: Page, id: string) => page.locator(`[data-testid="staging-row"][data-key="amiga:${id}"]`);
const status = (page: Page, id: string) => page.getByTestId(`staging-status-amiga:${id}`);
const act = (page: Page, a: string, id: string) => page.getByTestId(`staging-${a}-amiga:${id}`);

/** The board reports its firmware, Network mode and its key digits. */
async function boardSays(request: APIRequestContext, token: string, firmware = '1.19.0+gabc1234', upKey = 'ab12') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: firmware, secondDrive: 'net', driveVersion: 0, upKey } })).status()).toBe(204);
}
/**
 * The open body as the firmware writes it: a raw JSON string, application/json, with every non-ASCII character
 * (the board's Latin-1 bytes) escaped \u00XX. Playwright's `data: {...}` would send raw UTF-8 instead.
 */
function amigaJson(o: object): string {
  return JSON.stringify(o).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
async function boardOpens(request: APIRequestContext, token: string, path: string, size: number, date = '17000.600.0') {
  const open = await request.post('/api/device/upload', { headers: { ...authHeader(token), 'content-type': 'application/json' },
    data: amigaJson({ size, date, protection: 0, path, comment: '' }) });
  expect(open.status()).toBe(200);
  return (await open.json()) as { id: string; offset: number };
}
/** Chunks of 16 KB from `from`, at most `max` of them. */
async function boardSendsChunks(request: APIRequestContext, token: string, id: string, data: Buffer, from = 0, max = Infinity) {
  for (let at = from, n = 0; at < data.length && n < max; at += 16_384, n++) {
    const r = await request.post(`/api/device/upload/${id}?offset=${at}`, {
      headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: data.subarray(at, Math.min(at + 16_384, data.length)),
    });
    expect(r.status()).toBe(200);
  }
}
const boardCloses = (request: APIRequestContext, token: string, id: string, crc: number) =>
  request.post(`/api/device/upload/${id}/close`, { headers: authHeader(token), data: { crc32: crc } });
/** What a 1.19.0 board does for one PUT: open, 16 KB chunks, close. */
async function boardUploads(request: APIRequestContext, token: string, path: string, data: Buffer, date = '17000.600.0') {
  const { id, offset } = await boardOpens(request, token, path, data.length, date);
  await boardSendsChunks(request, token, id, data, offset);
  expect((await boardCloses(request, token, id, crc32(data) >>> 0)).status()).toBe(200);
  return id;
}

test('a file from the Amiga appears with its board, downloads as an attachment, and Delete removes it', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await page.goto('/ingest');
  await expect(page.getByTestId('staging-empty')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('from-amiga-key')).toContainText('AB12');            // the digits Transfer shows
  const id = await boardUploads(request, token, 'Docs/Café.txt', Buffer.from('hello from the Amiga\n'));
  await expect(row(page, id)).toHaveAttribute('data-state', 'stored', { timeout: LIVE });
  await expect(row(page, id)).toHaveAttribute('data-kind', 'in');
  await expect(row(page, id)).toContainText('Docs/Café.txt');
  await expect(row(page, id)).toContainText('from Bench');
  await expect(status(page, id)).toHaveText('Stored');
  const [saved] = await Promise.all([page.waitForEvent('download'), act(page, 'download', id).click()]);
  expect(saved.suggestedFilename()).toBe('Café.txt');                                  // the fetch, then a blob saved under the Amiga name
  const dl = await page.request.get(`/api/uploads/${id}/file`);
  expect(dl.headers()['content-disposition']).toBe("attachment; filename=\"Caf_.txt\"; filename*=UTF-8''Caf%C3%A9.txt");   // ASCII fallback, then the UTF-8 name
  expect(dl.headers()['x-content-type-options']).toBe('nosniff');
  expect(dl.headers()['content-type']).toBe('application/octet-stream');
  expect((await dl.body()).toString()).toBe('hello from the Amiga\n');
  await expect(act(page, 'add', id)).toHaveCount(0);       // not a disk image
  await act(page, 'delete', id).click();
  await expect(page.getByTestId('staging-confirm')).toContainText('Delete Docs/Café.txt? It is the only copy.');
  await page.getByTestId('staging-confirm-yes').click();
  await expect(row(page, id)).toHaveCount(0, { timeout: LIVE });
});

test('an ADF goes to the library with one click, and the row then offers Open title', async ({ page, request }) => {
  test.setTimeout(120_000);   // 55 chunks of 16 KB, each one a round trip to the database
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const adf = Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: 'FromAmiga' }));
  const id = await boardUploads(request, token, 'Disks/FromAmiga.adf', adf);
  await page.goto('/ingest');
  await expect(status(page, id)).toHaveText('Stored · a disk image', { timeout: LIVE });
  await act(page, 'add', id).click();
  await expect(act(page, 'open', id)).toBeVisible({ timeout: LIVE });
  await expect(act(page, 'add', id)).toHaveCount(0);
  await act(page, 'open', id).click();
  await expect(page).toHaveURL(/\/games\//);
});

// Was "Clear all names the count, spares a file still arriving and one that arrived during the confirm". Clear all and
// its confirm are gone (spec 2026-10-23 decision 2): Clear finished clears the failed file only, and never a stored one
// or one still arriving.
test('Clear finished clears a failed file and keeps the stored ones and one still arriving', async ({ page, request }) => {
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
  await page.goto('/ingest');
  await expect(status(page, moving)).toContainText('Arriving · 81 %', { timeout: LIVE });
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (1)');
  const late = await boardUploads(request, token, 'Late.txt', Buffer.from('late'));   // arrives just before the click
  await page.getByTestId('staging-clear-finished').click();
  await expect(page.getByTestId('staging-confirm')).toHaveCount(0);                   // no confirm: nothing kept goes
  await expect(row(page, failed)).toHaveCount(0, { timeout: LIVE });
  await expect(row(page, a)).toBeVisible();
  await expect(row(page, b)).toBeVisible();
  await expect(row(page, moving)).toBeVisible();
  await expect(row(page, late)).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (0)');
  await expect(page.getByTestId('staging-clear-finished')).toBeDisabled();
  // A file still arriving can be stopped (a stalled one is otherwise stuck for 24 h); the board then hears gone.
  await act(page, 'stop', moving).click();
  await expect(page.getByTestId('staging-confirm')).toContainText('Stop receiving Moving.bin? The part that arrived is deleted.');
  await page.getByTestId('staging-confirm-yes').click();
  await expect(row(page, moving)).toHaveCount(0, { timeout: LIVE });
  expect((await request.post(`/api/device/upload/${moving}?offset=16384`, {
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.alloc(3_616, 1) })).status()).toBe(404);
});

test('Send to an Amiga queues the file for another board', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  const { token: den } = await pairDevice(page, request, 'Den');
  await boardSays(request, token); await boardSays(request, den, '1.19.0+gabc1234', 'cd34');
  const id = await boardUploads(request, token, 'Docs/Note.txt', Buffer.from('note'));
  await page.goto('/ingest');
  await act(page, 'send', id).selectOption({ label: 'Den' });
  await expect(page.getByText('Queued for Den')).toBeVisible({ timeout: LIVE });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(den) })).body()).toString('latin1');
  expect(q).toMatch(/^NEXT \S+ 4 [0-9a-f]+ 0 13:Docs\/Note\.txt /);
});

// The board <select> is gone (spec 2026-10-23 decision 3): every board's files show, each naming its board, and the
// device card's link (?from=) opens the list on From the Amiga.
test("every board's files show with their board, the device card's line, and the update an older Network board needs", async ({ page, request }) => {
  await signUpFresh(page);
  const bench = await pairDevice(page, request, 'Bench');
  const den = await pairDevice(page, request, 'Den');
  const old = await pairDevice(page, request, 'Old');
  await boardSays(request, bench.token); await boardSays(request, den.token, '1.19.0+gabc1234', 'cd34');
  await boardSays(request, old.token, '1.18.2+gabc1234', 'ef56');
  const fromBench = await boardUploads(request, bench.token, 'Bench.txt', Buffer.from('b'));
  const fromDen = await boardUploads(request, den.token, 'Den.txt', Buffer.from('d'));
  await page.goto('/ingest');
  await expect(row(page, fromBench)).toContainText('from Bench', { timeout: LIVE });
  await expect(row(page, fromDen)).toContainText('from Den');
  await expect(page.getByTestId('staging-filter-all')).toHaveAttribute('aria-checked', 'true');
  await page.goto('/devices');
  await expect(page.getByTestId(`device-upload-${bench.deviceId}`)).toHaveText('1 file from the Amiga');
  await expect(page.getByTestId(`device-upload-${old.deviceId}`)).toHaveText('Update to 1.19.0 to send files from the Amiga');
  await page.getByTestId(`device-upload-${bench.deviceId}`).click();
  await expect(page).toHaveURL(new RegExp(`/ingest\\?from=${bench.deviceId}#from-amiga`));
  await expect(page.getByTestId('staging-filter-in')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, fromBench)).toBeVisible({ timeout: LIVE });
  await expect(row(page, fromDen)).toBeVisible();
});

// Was "Clear all with a board filter on spares the other board's finished file". The board filter is gone; the same
// check now holds for the list's filter: Clear finished clears only what the filter shows (spec 2026-10-23 §2).
test('Clear finished under From the Amiga spares a finished send to the Amiga', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const bad = Buffer.from('broken');
  const { id: failed } = await boardOpens(request, token, 'Bad.txt', bad.length);
  await boardSendsChunks(request, token, failed, bad);
  expect((await boardCloses(request, token, failed, ((crc32(bad) >>> 0) ^ 1) >>> 0)).status()).toBe(409);
  const sent = await page.request.post(`/api/transfers?deviceId=${deviceId}&name=Out.txt`, { data: Buffer.from('o'),
    headers: { 'content-type': 'application/octet-stream' } });
  expect(sent.status()).toBe(201);
  const sendId = ((await sent.json()) as { ids: string[] }).ids[0];
  expect((await page.request.delete(`/api/transfers/${sendId}`)).status()).toBe(200);   // cancelled: finished
  await page.goto('/ingest');
  const sendRow = page.locator(`[data-testid="staging-row"][data-key="send:${sendId}"]`);
  await expect(sendRow).toHaveAttribute('data-state', 'cancelled', { timeout: LIVE });
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (2)');
  await page.getByTestId('staging-filter-in').click();
  await expect(sendRow).toHaveCount(0);
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (1)');
  await page.getByTestId('staging-clear-finished').click();
  await expect(row(page, failed)).toHaveCount(0, { timeout: LIVE });
  // The next list read after the filter click (the next poll) is the server's word: the send was not cleared.
  const next = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/staging' && r.request().method() === 'GET',
    { timeout: LIVE });
  await page.getByTestId('staging-filter-all').click();
  await expect(sendRow).toBeVisible({ timeout: LIVE });
  await next;
  await expect(sendRow).toBeVisible();
  await expect(row(page, failed)).toHaveCount(0);
});

// Was the Clear all confirm's test; Clear all is gone, and the list's one confirm (Delete, Stop) keeps its behaviour.
test('the Delete confirm focuses Cancel and Escape closes it without deleting', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Keep.txt', Buffer.from('keep'));
  await page.goto('/ingest');
  await expect(row(page, id)).toBeVisible({ timeout: LIVE });
  await act(page, 'delete', id).click();
  await expect(page.getByRole('dialog', { name: 'Delete Keep.txt? It is the only copy.' })).toBeVisible();   // named by its question
  await expect(page.getByTestId('staging-confirm-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('staging-confirm')).toHaveCount(0);
  await expect(act(page, 'delete', id)).toBeFocused();
  await expect(row(page, id)).toBeVisible();
});

// Signed out, the fetch follows the redirect to the sign-in page: a 200 with HTML. That is not a success.
test('an action answered by the sign-in page (200 text/html) says signed out and keeps the row', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Kept.txt', Buffer.from('kept'));
  await page.route(`**/api/uploads/${id}`, (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Sign in</title>' })
    : route.continue());
  await page.goto('/ingest');
  await expect(row(page, id)).toBeVisible({ timeout: LIVE });
  await act(page, 'delete', id).click();
  await page.getByTestId('staging-confirm-yes').click();
  await expect(page.getByText('Signed out — sign in again')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('staging-confirm')).toHaveCount(0);
  await expect(row(page, id)).toBeVisible();
  await expect(status(page, id)).toHaveText('Stored');
});

// The file finished while the Stop confirm was open: Stop must not delete the only copy.
test('Stop on a file that finished while the confirm was open keeps it and says so', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const data = Buffer.alloc(20_000, 1);
  const { id } = await boardOpens(request, token, 'Late.bin', data.length, '1.2.3');
  await boardSendsChunks(request, token, id, data, 0, 1);
  await page.goto('/ingest');
  await expect(status(page, id)).toContainText('Arriving · 81 %', { timeout: LIVE });
  await act(page, 'stop', id).click();
  await expect(page.getByRole('dialog', { name: 'Stop receiving Late.bin? The part that arrived is deleted.' })).toBeVisible();
  await boardSendsChunks(request, token, id, data, 16_384);                 // the rest arrives meanwhile
  expect((await boardCloses(request, token, id, crc32(data) >>> 0)).status()).toBe(200);
  await page.getByTestId('staging-confirm-yes').click();
  await expect(page.getByText('It finished arriving; it was kept.')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('staging-confirm')).toHaveCount(0);
  await expect(status(page, id)).toHaveText('Stored', { timeout: LIVE });
  expect((await page.request.get(`/api/uploads/${id}/file`)).status()).toBe(200);
});

test('a download the server answers 404 to gives a toast, not a saved file', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const id = await boardUploads(request, token, 'Gone.txt', Buffer.from('gone'));
  await page.route(`**/api/uploads/${id}/file`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
  await page.goto('/ingest');
  await expect(row(page, id)).toBeVisible({ timeout: LIVE });
  const saved = page.waitForEvent('download', { timeout: 1500 }).then(() => true, () => false);
  await act(page, 'download', id).click();
  await expect(page.getByText('That file is no longer here.')).toBeVisible({ timeout: LIVE });
  expect(await saved).toBe(false);
});

test('a file that fails its CRC shows as failed, is neither downloadable nor addable, can be cleared, and the board hears crc', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const data = Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: 'Damaged' }).subarray(0, 40_000));
  const { id } = await boardOpens(request, token, 'Disks/Damaged.adf', data.length);
  await boardSendsChunks(request, token, id, data);
  const close = await boardCloses(request, token, id, ((crc32(data) >>> 0) ^ 1) >>> 0);
  expect(close.status()).toBe(409);
  expect(await close.json()).toEqual({ code: 'crc' });
  await page.goto('/ingest');
  await expect(row(page, id)).toHaveAttribute('data-state', 'failed', { timeout: LIVE });
  await expect(status(page, id)).toContainText('Failed');
  await expect(status(page, id)).toContainText('damaged on the way: send it again');
  await expect(act(page, 'download', id)).toHaveCount(0);
  await expect(act(page, 'add', id)).toHaveCount(0);
  expect((await page.request.get(`/api/uploads/${id}/file`)).status()).toBe(404);
  // A failed file is finished: it has Clear (spec 2026-10-23 §2), where the old card offered Delete.
  await act(page, 'clear', id).click();
  await expect(row(page, id)).toHaveCount(0, { timeout: LIVE });
});

test('a file the board stopped sending resumes at the next chunk and is listed once', async ({ page, request }) => {
  await signUpFresh(page);
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
  await page.goto('/ingest');
  await expect(row(page, first.id)).toHaveAttribute('data-state', 'stored', { timeout: LIVE });
  await expect(page.locator('[data-testid="staging-row"][data-kind="in"]')).toHaveCount(1);
  const dl = await page.request.get(`/api/uploads/${first.id}/file`);
  expect(Buffer.from(await dl.body()).equals(data)).toBe(true);
});

test('an empty file is stored and listed as 0 B', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const { id } = await boardOpens(request, token, 'Empty.txt', 0);
  expect((await boardCloses(request, token, id, 0)).status()).toBe(200);
  await page.goto('/ingest');
  await expect(row(page, id)).toHaveAttribute('data-state', 'stored', { timeout: LIVE });
  await expect(row(page, id)).toContainText('0 B');
});
