// A6 Upload staging (spec 2026-10-23): one list on the Upload page for disks into the library, files to the Amiga
// and files from the Amiga. Sends and Amiga files are seeded straight into the test org's tables (the board-route
// flows they stand for are covered by send-to-amiga.spec.ts and from-amiga.spec.ts); library rows come from a real drop.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';
import { getDb } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { disks } from '@/db/schema/catalog';

test.describe.configure({ timeout: 90_000 });
const LIVE = 15_000;
const DAY = 86_400_000;
const uploadIds: string[] = [];

test.afterAll(async () => {
  if (uploadIds.length) await getDb().delete(amigaUploads).where(inArray(amigaUploads.id, uploadIds)).catch(() => undefined);
  await cleanupSeeded();   // the devices go, and their transfers with them (cascade)
});

/** The board reports Network mode on a firmware that can take files (an online send target), and its key digits. */
async function boardSays(request: APIRequestContext, token: string, upKey = 'ab12') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.19.0+gabc1234', secondDrive: 'net', driveVersion: 0, upKey } })).status()).toBe(204);
}

async function seedSend(orgId: string, deviceId: string, o: { path: string; status: string; savedAs?: string; at?: number }) {
  const id = randomUUID();
  const at = new Date(o.at ?? Date.now());
  await getDb().insert(transfers).values({
    id, orgId, deviceId, createdByUserId: 'e2e-staging', path: o.path, sizeBytes: 11, crc32: 0,
    blobSha256: '0'.repeat(64), status: o.status, savedAs: o.savedAs ?? null, createdAt: at,
    expiresAt: new Date(at.getTime() + 7 * DAY), finishedAt: o.status === 'queued' ? null : at,
  });
  return id;
}

async function seedUpload(orgId: string, deviceId: string, deviceName: string,
  o: { path: string; status: 'receiving' | 'stored' | 'failed'; size?: number; received?: number; at?: number }) {
  const id = randomUUID();
  const at = new Date(o.at ?? Date.now());
  const size = o.size ?? 11;
  await getDb().insert(amigaUploads).values({
    id, orgId, deviceId, deviceName, path: o.path, sizeBytes: size, amigaDate: '17000.600.0', status: o.status,
    receivedBytes: o.received ?? (o.status === 'receiving' ? 0 : size), errorCode: o.status === 'failed' ? 'crc' : null,
    blobSha256: o.status === 'stored' ? '0'.repeat(64) : null, createdAt: at, storedAt: o.status === 'stored' ? at : null,
    expiresAt: new Date(at.getTime() + (o.status === 'receiving' ? DAY : 30 * DAY)),
  });
  uploadIds.push(id);
  return id;
}

const ADF_BYTES = 901_120;
function fakeAdf(): Buffer {
  const b = Buffer.alloc(ADF_BYTES);
  b.write(`DOS\0webadf-staging-${Date.now()}-${Math.random()}`, 0);
  return b;
}
/** A real pick on the library drop area; answers the library row's key. */
async function dropAdf(page: Page, name: string): Promise<{ key: string; sha: string }> {
  const buffer = fakeAdf();
  const sha = createHash('sha256').update(buffer).digest('hex');
  // Hydrated first: a pick on server-rendered HTML has no change handler yet, and the drop silently does nothing.
  // The server render says "Reading the list…"; an empty text or a row exists only once the client has run.
  await expect(page.locator('[data-testid="staging-empty"], [data-testid="staging-row"]').first()).toBeVisible({ timeout: LIVE });
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  const key = `lib:${sha}`;
  await expect(page.locator(`[data-testid="staging-row"][data-key="${key}"]`)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  return { key, sha };
}
const row = (page: Page, key: string) => page.locator(`[data-testid="staging-row"][data-key="${key}"]`);

test('all three kinds share one list, with a count per filter', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const send = await seedSend(orgId, deviceId, { path: 'Sent.txt', status: 'delivered', savedAs: 'Sent.txt' });
  const up = await seedUpload(orgId, deviceId, 'Bench', { path: 'Disks/Got.adf', status: 'stored', size: ADF_BYTES });
  await page.goto('/ingest');
  await expect(row(page, `send:${send}`)).toHaveAttribute('data-state', 'delivered', { timeout: LIVE });
  await dropAdf(page, 'Staged Game (1991)(Acme).adf');
  await expect(page.getByTestId('staging-filter-all')).toHaveText(/3$/);
  await expect(page.getByTestId('staging-filter-lib')).toHaveText(/1$/);
  await expect(page.getByTestId('staging-filter-out')).toHaveText(/1$/);
  await expect(page.getByTestId('staging-filter-in')).toHaveText(/1$/);
  await expect(page.getByTestId(`staging-status-send:${send}`)).toContainText('Delivered');
  await expect(row(page, `amiga:${up}`)).toContainText('from Bench');
  await page.getByTestId('staging-filter-in').click();
  await expect(page.getByTestId('staging-row')).toHaveCount(1);
  await expect(page.getByTestId('staging-row')).toHaveAttribute('data-key', `amiga:${up}`);
});

test('a dropped disk offers Open title, which goes to the title it became', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await page.goto('/ingest');
  const { key, sha } = await dropAdf(page, 'Opened Game (1992)(Acme).adf');
  const [d] = await getDb().select({ gameId: disks.gameId }).from(disks).where(and(eq(disks.orgId, orgId), eq(disks.sha256, sha)));
  expect(d).toBeTruthy();
  const open = page.getByTestId(`staging-open-${key}`);
  await expect(open).toHaveAttribute('href', `/games/${d.gameId}`);
  await expect(row(page, key)).toContainText('into the library · ');
});

test('Clear finished removes what is finished and keeps a stored file from the Amiga', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const send = await seedSend(orgId, deviceId, { path: 'Done.txt', status: 'delivered', savedAs: 'Done.txt' });
  const bad = await seedUpload(orgId, deviceId, 'Bench', { path: 'Broken.txt', status: 'failed' });
  const kept = await seedUpload(orgId, deviceId, 'Bench', { path: 'Keep.txt', status: 'stored' });
  await page.goto('/ingest');
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (2)', { timeout: LIVE });
  await page.getByTestId('staging-clear-finished').click();
  await expect(page.getByTestId('staging-row')).toHaveCount(1, { timeout: LIVE });
  await expect(page.getByTestId('staging-row')).toHaveAttribute('data-key', `amiga:${kept}`);
  await expect(page.getByTestId('staging-clear-finished')).toHaveCount(0);
  await page.waitForTimeout(11_000);   // one idle poll later the server agrees (Review Focus 2)
  await expect(page.getByTestId('staging-row')).toHaveCount(1);
  await expect(page.getByTestId('staging-row')).toHaveAttribute('data-key', `amiga:${kept}`);
  expect(await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.id, send))).toHaveLength(0);
  const [b] = await getDb().select({ status: amigaUploads.status }).from(amigaUploads).where(eq(amigaUploads.id, bad));
  expect(b.status).toBe('deleted');
});

test('Stop asks first, then deletes the part that arrived', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const id = await seedUpload(orgId, deviceId, 'Bench', { path: 'Moving.bin', status: 'receiving', size: 20_000, received: 16_384 });
  const key = `amiga:${id}`;
  await page.goto('/ingest');
  await expect(page.getByTestId(`staging-status-${key}`)).toContainText('Arriving · 81 %', { timeout: LIVE });
  await page.getByTestId(`staging-stop-${key}`).click();
  await expect(page.getByTestId('staging-confirm')).toContainText('Stop receiving Moving.bin? The part that arrived is deleted.');
  await page.getByTestId('staging-confirm-yes').click();
  await expect(row(page, key)).toHaveCount(0, { timeout: LIVE });
  await expect(page.getByTestId('staging-confirm')).toHaveCount(0);
  const [r] = await getDb().select({ status: amigaUploads.status }).from(amigaUploads).where(eq(amigaUploads.id, id));
  expect(r.status).toBe('deleted');
});

test('a second board\'s send shows its board while the picker points at the first', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const bench = await pairDevice(page, request, 'Bench');
  const den = await pairDevice(page, request, 'Den');
  await boardSays(request, bench.token, 'ab12');
  await boardSays(request, den.token, 'cd34');
  const send = await seedSend(orgId, den.deviceId, { path: 'ForDen.txt', status: 'queued' });
  await page.goto('/ingest');
  await expect(page.getByTestId('send-board-picker')).toBeVisible();
  await expect(page.getByTestId(`send-board-${bench.deviceId}`).locator('input')).toBeChecked();
  await expect(row(page, `send:${send}`)).toContainText('to Den', { timeout: LIVE });
  await expect(page.getByTestId(`staging-status-send:${send}`)).toHaveText(/Waiting for the Amiga/);
  // Each board's key, as Transfer on the Amiga shows it ("Trusted board AB12").
  await expect(page.getByTestId('from-amiga-key')).toHaveText(['Bench: board key AB12', 'Den: board key CD34']);
});

test('a failed refresh keeps the rows and says so until the next good one (Review Focus 4)', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');
  const { key } = await dropAdf(page, 'Kept Game (1993)(Acme).adf');
  await page.route('**/api/staging', (r) => r.fulfill({ status: 500, body: 'boom' }));
  await expect(page.getByTestId('staging-refresh-failed')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('staging-refresh-failed')).toHaveText("Couldn't refresh");
  await expect(row(page, key)).toBeVisible();
  await page.unroute('**/api/staging');
  await expect(page.getByTestId('staging-refresh-failed')).toHaveCount(0, { timeout: LIVE });
  await expect(row(page, key)).toBeVisible();
});

test('the list keeps refreshing while a file for the Amiga is still going up', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await page.goto('/ingest');
  await expect(page.getByTestId('send-board')).toContainText('Bench', { timeout: LIVE });
  await expect(page.getByTestId('staging-empty')).toBeVisible({ timeout: LIVE });   // hydrated (see dropAdf)
  // A slow link: the upload's POST is held for 20 s before it reaches the server.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/transfers?**', async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    await Promise.race([held, new Promise((t) => setTimeout(t, 20_000))]);
    await r.continue();
  });
  await page.getByTestId('send-file-input').setInputFiles({ name: 'Slow.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1000, 7) });
  await expect(page.locator('[data-testid="staging-row"][data-key^="up:"]')).toHaveAttribute('data-state', 'uploading');
  // Meanwhile a file arrives from the Amiga: the poll still paints it, before the upload settles.
  const up = await seedUpload(orgId, deviceId, 'Bench', { path: 'Arrived.txt', status: 'stored' });
  await expect(row(page, `amiga:${up}`)).toBeVisible({ timeout: LIVE });
  await expect(page.locator('[data-testid="staging-row"][data-key^="up:"]')).toHaveAttribute('data-state', 'uploading');
  release();
  await expect(page.locator('[data-testid="staging-row"][data-key^="up:"]')).toHaveCount(0, { timeout: LIVE });
  await expect(page.locator('[data-testid="staging-row"][data-kind="out"]')).toContainText('Slow.bin');
});

test('the drop cards: whole-card drop targets with Browse files, the inline URL field, and Working… while busy', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/ingest');
  await expect(page.locator('[data-testid="staging-empty"], [data-testid="staging-row"]').first()).toBeVisible({ timeout: LIVE });
  const add = page.getByTestId('dropzone');
  const send = page.getByTestId('send-dropzone');
  await expect(add).toHaveJSProperty('tagName', 'SECTION');
  await expect(send).toHaveJSProperty('tagName', 'SECTION');
  const a = (await add.boundingBox())!, s = (await send.boundingBox())!;
  expect(Math.abs(a.y - s.y)).toBeLessThan(2);                         // side by side from lg (Ruling 3)
  await expect(page.getByTestId('add-browse')).toHaveText('Browse files');
  await expect(page.getByLabel('Or fetch from a URL')).toHaveAttribute('placeholder', 'or paste a URL…');
  // Hold /check so the drop stays busy: Browse files says so (Ruling 7).
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/ingest/check', async (route) => { await held; await route.continue(); });
  await page.getByTestId('file-input').setInputFiles({ name: 'busy.adf', mimeType: 'application/octet-stream', buffer: fakeAdf() });
  await expect(page.getByTestId('add-browse')).toHaveText('Working…');
  await expect(page.getByTestId('add-browse')).toHaveAttribute('aria-disabled', 'true');
  release();
  await expect(page.getByTestId('add-browse')).toHaveText('Browse files', { timeout: 30_000 });
});

test('the Send card names its one board and whether Transfer runs, beside Choose files', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await page.goto('/ingest');
  await expect(page.getByTestId('send-browse')).toHaveText('Choose files');
  await expect(page.getByTestId('send-board')).toHaveText(/^To Bench · /);
  await expect(page.getByTestId('send-receiver')).toHaveText(/^[✓•] /);
  await expect(page.getByTestId('help-tip-send')).toBeVisible();
});
