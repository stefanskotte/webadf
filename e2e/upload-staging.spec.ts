// A6 Upload staging (spec 2026-10-23): one list on the Upload page for disks into the library, files to the Amiga
// and files from the Amiga. Sends and Amiga files are seeded straight into the test org's tables (the board-route
// flows they stand for are covered by send-to-amiga.spec.ts and from-amiga.spec.ts); library rows come from a real drop.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { signUpFresh, libRows } from './helpers';
import { pairDevice, authHeader, cleanupSeeded, hydrated } from './device-helpers';
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
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (0)');
  await expect(page.getByTestId('staging-clear-finished')).toBeDisabled();
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
  await expect(page.getByTestId('add-browse').locator('input')).toBeDisabled();
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

/** Dispatch a drag event with one file on a drop card; answers whether the page cancelled it (preventDefault). */
async function dragOn(page: Page, testId: string, type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', file?: { name: string; bytes: number[] }): Promise<boolean> {
  return page.evaluate(([tid, t, f]) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)!;
    const dt = new DataTransfer();
    if (f) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/octet-stream' }));
    const ev = new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [testId, type, file] as const);
}
const adfFile = (name: string) => ({ name, bytes: Array.from(fakeAdf()) });

test('a drop on the library card: dragenter lights it, a drop stages the disk, a drop while busy adds nothing', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/ingest');
  await expect(page.locator('[data-testid="staging-empty"], [data-testid="staging-row"]').first()).toBeVisible({ timeout: LIVE });
  await hydrated(page, 'dropzone', 'onDrop');
  const add = page.getByTestId('dropzone');
  await dragOn(page, 'dropzone', 'dragenter');
  await expect(add).toHaveAttribute('data-over', 'true');
  await dragOn(page, 'dropzone', 'dragleave');
  await expect(add).toHaveAttribute('data-over', 'false');
  // Hold /check: the first drop stays busy, so the second is ignored and does not light the card.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/ingest/check', async (route) => { await held; await route.continue(); });
  await dragOn(page, 'dropzone', 'drop', adfFile('first.adf'));
  await expect(page.getByTestId('add-browse')).toHaveText('Working…');
  await dragOn(page, 'dropzone', 'dragenter');
  await expect(add).toHaveAttribute('data-over', 'false');          // disabled: no invitation to drop
  expect(await dragOn(page, 'dropzone', 'drop', adfFile('second.adf'))).toBe(true);   // cancelled, but ignored
  release();
  await expect(libRows(page).first()).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(libRows(page)).toHaveCount(1);
});

test('a drop on the Send card queues the file for the paired board; keyboard reaches both pickers', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/ingest');
  await hydrated(page, 'send-dropzone', 'onDrop');
  await dragOn(page, 'send-dropzone', 'dragenter');
  await expect(page.getByTestId('send-dropzone')).toHaveAttribute('data-over', 'true');
  await dragOn(page, 'send-dropzone', 'drop', { name: 'note.txt', bytes: [1, 2, 3] });
  await expect(page.locator('[data-testid="staging-row"][data-kind="out"]')).toHaveCount(1, { timeout: LIVE });
  // Tab reaches the hidden input inside each Browse label.
  await page.getByTestId('add-browse').locator('input').focus();
  await expect(page.getByTestId('add-browse').locator('input')).toBeFocused();
  await page.keyboard.press('Tab');                                  // the next stop after Browse files is the URL field
  await expect(page.getByTestId('url-input')).toBeFocused();
  await page.getByTestId('send-browse').locator('input').focus();
  await expect(page.getByTestId('send-file-input')).toBeFocused();
});

test('the Send card without a board is not a drop target, but still cancels a drop so the tab never navigates', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');
  await expect(page.locator('[data-testid="staging-empty"], [data-testid="staging-row"]').first()).toBeVisible({ timeout: LIVE });
  const url = page.url();
  await expect(page.getByTestId('send-dropzone')).toHaveAttribute('data-drop', 'off');
  expect(await dragOn(page, 'send-dropzone', 'dragover')).toBe(true);
  expect(await dragOn(page, 'send-dropzone', 'drop', { name: 'x.txt', bytes: [1] })).toBe(true);
  await expect(page.getByTestId('send-dropzone')).toHaveAttribute('data-over', 'false');
  expect(page.url()).toBe(url);
});

test('the filter is a radiogroup: arrows move and select, the tab stop follows the checked one', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  await seedUpload(orgId, deviceId, 'Bench', { path: 'In.txt', status: 'stored' });
  await page.goto('/ingest');
  const group = page.getByTestId('staging-filters');
  await expect(group).toHaveAttribute('role', 'radiogroup');
  await expect(page.getByTestId('staging-filter-all')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('staging-filter-all')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('staging-filter-in')).toHaveAttribute('tabindex', '-1');
  await hydrated(page, 'staging-filters', 'onKeyDown');
  await page.getByTestId('staging-filter-all').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('staging-filter-in')).toBeFocused();
  await expect(page.getByTestId('staging-filter-in')).toHaveAttribute('aria-checked', 'true');
  await expect(group).toHaveAttribute('data-value', 'in');
  // Exactly one radio is a tab stop, and it is the checked one.
  const tabStops = async (checked: string) => {
    for (const id of ['all', 'in', 'out', 'lib']) {
      await expect(page.getByTestId(`staging-filter-${id}`)).toHaveAttribute('tabindex', id === checked ? '0' : '-1');
      await expect(page.getByTestId(`staging-filter-${id}`)).toHaveAttribute('aria-checked', id === checked ? 'true' : 'false');
    }
  };
  await tabStops('in');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('staging-filter-all')).toBeFocused();
  await tabStops('all');
  await page.keyboard.press('ArrowLeft');                            // wraps to the last
  await expect(page.getByTestId('staging-filter-lib')).toBeFocused();
  await tabStops('lib');
  await page.keyboard.press('ArrowRight');                           // and forward to the first
  await expect(page.getByTestId('staging-filter-all')).toBeFocused();
  await tabStops('all');
  // A browser shortcut (Alt+ArrowLeft is Back) is not swallowed.
  await page.keyboard.press('Alt+ArrowRight');
  await expect(group).toHaveAttribute('data-value', 'all');
  await page.keyboard.press('End');
  await expect(page.getByTestId('staging-filter-lib')).toHaveAttribute('aria-checked', 'true');
  await tabStops('lib');
  await expect(page.getByTestId('staging-empty')).toHaveText('Nothing to the library right now.');
});

test('Clear finished is shown at (0), disabled, and the refresh state reads Up to date', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');
  await expect(page.getByTestId('staging-empty')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (0)');
  await expect(page.getByTestId('staging-clear-finished')).toBeDisabled();
  await expect(page.getByTestId('staging-refresh')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('staging-refresh')).toHaveText('Up to date');
});

test('a first read that fails says so instead of reading forever, then the list arrives', async ({ page }) => {
  await signUpFresh(page);
  let failed = 0;
  await page.route('**/api/staging', async (route) => {
    if (failed++ === 0) return route.fulfill({ status: 503, body: 'down' });
    return route.continue();
  });
  await page.goto('/ingest');
  await expect(page.getByTestId('staging-reading')).toHaveAttribute('data-state', 'failed', { timeout: LIVE });
  await expect(page.getByTestId('staging-reading')).toHaveText("Couldn't read the list. It tries again every few seconds.");
  await expect(page.getByTestId('staging-empty')).toBeVisible({ timeout: 20_000 });   // the 10 s idle poll
  await expect(page.getByTestId('staging-reading')).toHaveCount(0);
});

test('the board keys sit in the footer beside the 30-day note', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token, 'ab12');
  await page.goto('/ingest');
  const key = page.getByTestId('from-amiga-key');
  await expect(key).toHaveText('Bench: board key AB12', { timeout: LIVE });
  const note = page.getByText('Files from the Amiga are kept 30 days.', { exact: false });
  const k = (await key.boundingBox())!, n = (await note.boundingBox())!;
  expect(k.y).toBeGreaterThan((await page.getByTestId('staging-list').boundingBox())!.y);
  expect(Math.abs(k.y - n.y)).toBeLessThan(40);
});

test('a row at 1440 px is one line: disk, pill, name and where, size, status with its bar, actions', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const id = await seedUpload(orgId, deviceId, 'Bench', { path: 'Moving.bin', status: 'receiving', size: 20_000, received: 16_384 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/ingest');
  const key = `amiga:${id}`;
  await expect(page.getByTestId(`staging-status-${key}`)).toContainText('Arriving · 81 %', { timeout: LIVE });
  await expect(page.getByTestId(`staging-dir-${key}`)).toHaveText('←From Amiga');
  await expect(page.getByTestId(`staging-where-${key}`)).toHaveText('from Bench');
  await expect(page.getByTestId(`staging-size-${key}`)).toContainText('KB');
  const bar = page.getByTestId(`staging-progress-${key}`).locator('span');
  expect(await bar.evaluate((el) => el.style.width)).toBe('81%');
  const mid = async (sel: string) => { const b = (await page.getByTestId(sel).boundingBox())!; return b.y + b.height / 2; };
  const y = await mid(`staging-dir-${key}`);
  for (const sel of [`staging-size-${key}`, `staging-actions-${key}`]) expect(Math.abs((await mid(sel)) - y)).toBeLessThan(12);
});

test('below xl the row stacks: the actions sit under the name', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const id = await seedUpload(orgId, deviceId, 'Bench', { path: 'Keep.txt', status: 'stored' });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/ingest');
  const key = `amiga:${id}`;
  await expect(page.getByTestId(`staging-actions-${key}`)).toBeVisible({ timeout: LIVE });
  const where = (await page.getByTestId(`staging-where-${key}`).boundingBox())!;
  const acts = (await page.getByTestId(`staging-actions-${key}`).boundingBox())!;
  expect(acts.y).toBeGreaterThan(where.y + where.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
