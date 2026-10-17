// PaulaNET Phase 4 increment 3 (spec 2026-10-16 §4, §7 e2e): the web side of sending to the Amiga. The board is
// simulated through its own routes (status, poll, queue, chunk, done), as e2e/device-send.spec.ts does.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

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
  await page.getByTestId('send-file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
}

test('a file dropped under Send to Amiga waits, the board takes it, and it reads delivered with its saved name', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'r');
  await page.goto('/ingest');
  await expect(page.getByRole('heading', { name: 'Add to library' })).toBeVisible();
  await expect(page.getByTestId('dropzone')).toBeVisible();          // the library upload is unchanged
  await expect(page.getByTestId('send-board')).toContainText('Bench');
  await expect(page.getByTestId('send-receiver')).toHaveText('• Receive is not running on the Amiga');

  await dropFile(page, 'Café.txt', Buffer.from('hello amiga'));
  const row = page.locator('[data-testid^="send-row-"]').first();
  await expect(row).toHaveAttribute('data-status', 'queued', { timeout: LIVE });
  await expect(row).toContainText('Café.txt');
  await expect(row).toContainText('Waiting');
  await expect(page.getByTestId('send-receiver')).toHaveText('• Start Receive on the Amiga', { timeout: LIVE });

  await boardSays(request, token, 'c');
  await expect(page.getByTestId('send-receiver')).toHaveText('✓ Receive is running on the Amiga', { timeout: LIVE });
  const id = await boardTakesNext(request, token, { ok: true, savedAs: 'Café_2.txt' });
  await expect(page.getByTestId(`send-state-${id}`)).toHaveText('Delivered · saved as Café_2.txt', { timeout: LIVE });
  await expect(page.getByTestId(`send-cancel-${id}`)).toHaveCount(0);
});

test('Cancel takes a waiting file out of the board\'s queue; a cancel after delivery says it already finished', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'One.bin', Buffer.alloc(100, 1));
  const row = page.locator('[data-testid^="send-row-"]').first();
  await expect(row).toHaveAttribute('data-status', 'queued', { timeout: LIVE });
  const id = (await row.getAttribute('data-testid'))!.replace('send-row-', '');
  await page.getByTestId(`send-cancel-${id}`).click();
  await expect(page.getByTestId(`send-state-${id}`)).toHaveText('Cancelled', { timeout: LIVE });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toBe('NEXT -\nLIST 0\n');

  // Review Focus 2: a cancel that arrives after the board delivered is refused, and the row stays Delivered. (Sent by
  // request, not by the button: the page refreshes every 3 s, so whether the button is still there is a race.)
  await dropFile(page, 'Two.bin', Buffer.alloc(100, 2));
  const two = page.locator('[data-testid^="send-row-"][data-status="queued"]').first();
  await expect(two).toBeVisible({ timeout: LIVE });
  const twoId = (await two.getAttribute('data-testid'))!.replace('send-row-', '');
  await boardTakesNext(request, token, { ok: true, savedAs: 'Two.bin' });
  const late = await page.request.delete(`/api/transfers/${twoId}`);
  expect(late.status()).toBe(409);
  expect(await late.json()).toEqual({ error: 'not_waiting' });
  await expect(page.getByTestId(`send-state-${twoId}`)).toHaveText('Delivered · saved as Two.bin', { timeout: LIVE });
});

test('a failure shows Receive\'s reason, and Retry queues the file again', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'Full.bin', Buffer.alloc(300, 3));
  await expect(page.locator('[data-testid^="send-row-"][data-status="queued"]')).toHaveCount(1, { timeout: LIVE });
  const id = await boardTakesNext(request, token, { ok: false, code: 'space', text: 'disk full' });
  await expect(page.getByTestId(`send-state-${id}`)).toHaveText('Failed · not enough space on the Amiga', { timeout: LIVE });
  await page.getByTestId(`send-retry-${id}`).click();
  await expect(page.locator('[data-testid^="send-row-"][data-status="queued"]')).toHaveCount(1, { timeout: LIVE });
});

test('a file over 4 MB is refused in the browser, and a board below 1.15.0 is never offered', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'Big.bin', Buffer.alloc(4_194_305));
  await expect(page.getByTestId('send-upload')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('send-upload')).toContainText('Over 4 MB: too large to send.');

  await boardSays(request, token, 'c', '1.13.0+gdef5678');
  await page.goto('/ingest');
  await expect(page.getByTestId('send-no-board')).toContainText('1.15.0');
});
