// PaulaNET Phase 4 increment 3 (spec 2026-10-16 §4, §7 e2e): the web side of sending to the Amiga. The board is
// simulated through its own routes (status, poll, queue, chunk, done), as e2e/device-send.spec.ts does.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh, stagingReady, openRowMenu } from './helpers';
import { createHash } from 'node:crypto';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { addFile, makeDirectory, readVolume } from '@/lib/adffs';
import { pairDevice, authHeader, cleanupSeeded, seedDisk } from './device-helpers';
import { runTag } from './helpers';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

/** The Staging list's rows of files to the Amiga (sends, keyed `send:<id>`), newest first. */
const sendRows = (page: Page, state?: string) =>
  page.locator(`[data-testid="staging-row"][data-key^="send:"]${state ? `[data-state="${state}"]` : ''}`);
const sendRow = (page: Page, id: string) => page.locator(`[data-testid="staging-row"][data-key="send:${id}"]`);
const keyId = async (row: ReturnType<Page['locator']>) => (await row.getAttribute('data-key'))!.replace('send:', '');

/** The board reports Network mode on 1.15.0 and its receiver state (since=999999 answers at once). */
async function boardSays(request: APIRequestContext, token: string, rx: 'c' | 'r' | 'u' | '-', firmware = '1.15.0+gabc1234') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: firmware, secondDrive: 'net', driveVersion: 0 } })).status()).toBe(204);
  expect((await request.get(`/api/device/poll?since=999999&xferAck=0&rx=${rx}`, { headers: authHeader(token) })).status()).toBe(200);
}

/** The board takes the queue's NEXT file whole and posts the outcome. */
async function boardTakesNext(request: APIRequestContext, token: string,
  outcome: { ok: true; savedAs: string } | { ok: false; code: string; text: string }) {
  const text = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  const m = /^NEXT (\S+) (\d+) /.exec(text);
  expect(m, text).not.toBeNull();
  const [, id, size] = m!;
  for (let off = 0; off < Number(size); off += 16_384) {
    expect((await request.get(`/api/device/send/${id}?offset=${off}&length=16384`, { headers: authHeader(token) })).status()).toBe(200);
  }
  expect((await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: outcome })).status()).toBe(204);
  return id;
}

async function dropFile(page: Page, name: string, buffer: Buffer) {
  await stagingReady(page);   // a pick before hydration has no change handler yet
  await page.getByTestId('send-file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
}

test('a file dropped under Send to Amiga waits, the board takes it, and it reads delivered with its saved name', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'r');
  await page.goto('/ingest');
  await expect(page.getByRole('heading', { name: 'Add disks to the library' })).toBeVisible();
  await expect(page.getByTestId('dropzone')).toBeVisible();          // the library upload is unchanged
  await expect(page.getByTestId('send-board')).toContainText('Bench');
  await expect(page.getByTestId('send-receiver')).toHaveText('• Transfer is not running on the Amiga');

  await dropFile(page, 'Café.txt', Buffer.from('hello amiga'));
  const row = sendRows(page).first();
  await expect(row).toHaveAttribute('data-state', 'queued', { timeout: LIVE });
  await expect(row).toContainText('Café.txt');
  await expect(row).toContainText('Waiting for the Amiga');
  await expect(page.getByTestId('send-receiver')).toHaveText('• Start Transfer on the Amiga', { timeout: LIVE });

  await boardSays(request, token, 'c');
  await expect(page.getByTestId('send-receiver')).toHaveText('✓ Transfer is running on the Amiga', { timeout: LIVE });
  const id = await boardTakesNext(request, token, { ok: true, savedAs: 'Café_2.txt' });
  await expect(page.getByTestId(`staging-status-send:${id}`)).toHaveText('Delivered', { timeout: LIVE });
  await expect(sendRow(page, id)).toContainText('to Bench · saved as Café_2.txt');
  await expect(page.getByTestId(`staging-cancel-send:${id}`)).toHaveCount(0);
});

test('Cancel takes a waiting file out of the board\'s queue; a cancel after delivery says it already finished', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'One.bin', Buffer.alloc(100, 1));
  const row = sendRows(page).first();
  await expect(row).toHaveAttribute('data-state', 'queued', { timeout: LIVE });
  const id = await keyId(row);
  await page.getByTestId(`staging-cancel-send:${id}`).click();
  await expect(page.getByTestId(`staging-status-send:${id}`)).toHaveText('Cancelled', { timeout: LIVE });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toBe('NEXT -\nLIST 0\n');

  // Review Focus 2: a cancel that arrives after the board delivered is refused, and the row stays Delivered. (Sent by
  // request, not by the button: the page refreshes every 3 s, so whether the button is still there is a race.)
  await dropFile(page, 'Two.bin', Buffer.alloc(100, 2));
  const two = sendRows(page, 'queued').first();
  await expect(two).toBeVisible({ timeout: LIVE });
  const twoId = await keyId(two);
  await boardTakesNext(request, token, { ok: true, savedAs: 'Two.bin' });
  const late = await page.request.delete(`/api/transfers/${twoId}`);
  expect(late.status()).toBe(409);
  expect(await late.json()).toEqual({ error: 'not_waiting' });
  await expect(page.getByTestId(`staging-status-send:${twoId}`)).toHaveText('Delivered', { timeout: LIVE });
  await expect(sendRow(page, twoId)).toContainText('saved as Two.bin');
});

test('a failure shows Transfer\'s reason, and Retry queues the file again', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'Full.bin', Buffer.alloc(300, 3));
  await expect(sendRows(page, 'queued')).toHaveCount(1, { timeout: LIVE });
  const id = await boardTakesNext(request, token, { ok: false, code: 'space', text: 'disk full' });
  await expect(page.getByTestId(`staging-status-send:${id}`)).toHaveText('Failed · not enough space on the Amiga', { timeout: LIVE });
  await page.getByTestId(`staging-retry-send:${id}`).click();
  await expect(sendRows(page, 'queued')).toHaveCount(1, { timeout: LIVE });
});

test('a file over 4 MB is refused in the browser, and a board below 1.15.0 is never offered', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'Big.bin', Buffer.alloc(4_194_305));
  const up = page.locator('[data-testid="staging-row"][data-key^="up:"]');
  await expect(up).toHaveAttribute('data-state', 'failed');
  await expect(up).toContainText('Failed · Over 4 MB: too large to send.');

  await boardSays(request, token, 'c', '1.13.0+gdef5678');
  await page.goto('/ingest');
  await expect(page.getByTestId('send-no-board')).toContainText('1.15.0');
});

async function seedSendDisk(orgId: string, title: string) {
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SendTest' });
  const mk = makeDirectory(adf, 880, 'mods'); if (!mk.ok) throw new Error(mk.reason); adf = mk.adf;
  const v = readVolume(adf); if (!v.ok) throw new Error('no volume');
  const mods = v.root.find((e) => e.name === 'mods')!.block;
  const a = addFile(adf, mods, 'a.txt', new TextEncoder().encode('hello'), 0x40); if (!a.ok) throw new Error(a.reason); adf = a.adf;
  const sha = createHash('sha256').update(adf).digest('hex');
  if (!(await diskStore.stat(sha))) await diskStore.put(sha, adf);
  return { ...(await seedDisk(orgId, { title, diskNo: 1, sha256: sha })), mods };
}

test('Browse: Send on a folder queues its files with their paths and protection', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token, 'c');
  const { diskId, mods } = await seedSendDisk(orgId, `S${runTag().slice(0, 6)}`);
  await page.goto(`/disks/${diskId}/files`);
  await openRowMenu(page, mods);
  await page.getByTestId(`fs-send-${mods}`).click();
  await expect(page.getByText('Queued for Bench')).toBeVisible();
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toMatch(/^NEXT \S+ 5 [0-9a-f]+ 40 10:mods\/a\.txt 0:\n/);
  await page.getByRole('button', { name: 'See queue' }).click();
  await expect(page).toHaveURL(/\/ingest\?board=/);
  await expect(page.getByTestId('staging-filter-out')).toHaveAttribute('aria-checked', 'true');   // the queue: To the Amiga
  await expect(sendRows(page, 'queued')).toContainText('mods/a.txt', { timeout: LIVE });
});

test('a title page: Send .adf to Amiga queues the whole disk as <name>.adf', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token, 'c');
  const title = `S${runTag().slice(0, 6)}`;
  const { gameId, diskId } = await seedSendDisk(orgId, title);
  await page.goto(`/games/${gameId}`);
  await page.getByTestId(`send-adf-${diskId}`).click();
  await expect(page.getByText('Queued for Bench')).toBeVisible();
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toContain(` 901120 ${`${title}-1.adf`.length}:${title}-1.adf\n`);
});

test('the board\'s card says what waits and whether Transfer runs, and links to the queue', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'r');
  expect((await page.request.post(`/api/transfers?deviceId=${deviceId}&name=a.txt`, { data: Buffer.from('a'),
    headers: { 'content-type': 'application/octet-stream' } })).status()).toBe(201);
  await page.goto('/devices');
  await expect(page.getByTestId(`device-send-${deviceId}`)).toHaveText('1 file waiting · Transfer not running');
  await boardSays(request, token, 'c');
  await expect(page.getByTestId(`device-send-${deviceId}`)).toHaveText('1 file waiting · Transfer running', { timeout: LIVE });
  await page.getByTestId(`device-send-${deviceId}`).click();
  await expect(page).toHaveURL(new RegExp(`/ingest\\?board=${deviceId}$`));
  await expect(page.getByTestId('send-board')).toContainText('Bench');
  await expect(page.getByTestId('staging-filter-out')).toHaveAttribute('aria-checked', 'true');
});

test('a long queue: the waiting file is first, and Clear finished removes the finished rows while it stays', async ({ page, request }) => {
  test.setTimeout(120_000);   // 14 rows made through the routes, each a request or several
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token, 'c');
  const post = async (name: string) => {
    const res = await page.request.post(`/api/transfers?deviceId=${deviceId}&name=${name}`, { data: Buffer.from(name),
      headers: { 'content-type': 'application/octet-stream' } });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { ids: string[] }).ids[0];
  };
  // One delivered and one failed through the board's own routes, eleven cancelled, then one left waiting: 14 rows.
  await post('Delivered.bin'); await boardTakesNext(request, token, { ok: true, savedAs: 'Delivered.bin' });
  await post('Failed.bin'); await boardTakesNext(request, token, { ok: false, code: 'space', text: 'disk full' });
  for (let i = 0; i < 11; i++) expect((await page.request.delete(`/api/transfers/${await post(`C${i}.bin`)}`)).status()).toBe(200);
  const waiting = await post('Waiting.bin');

  await page.goto('/ingest');
  await expect(sendRows(page)).toHaveCount(14, { timeout: LIVE });
  // Newest first: the waiting row, made last, leads the many finished ones.
  await expect(sendRows(page).first()).toHaveAttribute('data-key', `send:${waiting}`);
  // On a desktop the rows scroll inside a bounded list (36rem) rather than growing the page (Task 6 ruling 1).
  const box = await page.getByTestId('staging-list').evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight,
    height: el.getBoundingClientRect().height, overflowY: getComputedStyle(el).overflowY }));
  expect(box.overflowY).toBe('auto');
  expect(box.client).toBeLessThan(box.scroll);
  expect(box.height).toBeLessThanOrEqual(36 * 16 + 2);   // the box itself stops at 36rem (+ its 1 px borders)

  const clear = page.getByTestId('staging-clear-finished');
  await expect(clear).toHaveText('Clear finished (13)');
  await clear.click();
  await expect(sendRows(page)).toHaveCount(1, { timeout: LIVE });
  await expect(sendRow(page, waiting)).toHaveAttribute('data-state', 'queued');
  await expect(clear).toHaveText('Clear finished (0)');
  await expect(clear).toBeDisabled();
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toMatch(new RegExp(`^NEXT ${waiting} `));
});
