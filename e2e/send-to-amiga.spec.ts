// PaulaNET Phase 4 increment 3 (spec 2026-10-16 §4, §7 e2e): the web side of sending to the Amiga. The board is
// simulated through its own routes (status, poll, queue, chunk, done), as e2e/device-send.spec.ts does. Since Files
// increment 3 a file goes in through Files' "Send files to the Amiga" zone and waits as a row of NET:/<board>; the
// Staging list's Cancel is Delete there, and its Retry and Clear finished are retired (R4: a file is sent again).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { signUpFresh } from './helpers';
import { createHash } from 'node:crypto';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { addFile, makeDirectory, readVolume, setComment } from '@/lib/adffs';
import { pairDevice, authHeader, cleanupSeeded, seedDisk } from './device-helpers';
import { boardQueue, boardTakesNext } from './amiga-board';
import { runTag } from './helpers';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

/** The board reports Network mode on 1.15.0 and its receiver state (since=999999 answers at once). */
async function boardSays(request: APIRequestContext, token: string, rx: 'c' | 'r' | 'u' | '-', firmware = '1.15.0+gabc1234') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: firmware, secondDrive: 'net', driveVersion: 0 } })).status()).toBe(204);
  expect((await request.get(`/api/device/poll?since=999999&xferAck=0&rx=${rx}`, { headers: authHeader(token) })).status()).toBe(200);
}

/** Files with STASH: on the left and the board's queue on the right, hydrated so a pick has its change handler. */
async function openQueue(page: Page, deviceId: string) {
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: `NET:/${deviceId}`, active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}
/** A file picked on the Send zone ("Choose files"). */
async function sendFile(page: Page, name: string, buffer: Buffer) {
  await page.getByTestId('files-send-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
}
/** A row of the board's queue, in the right pane. */
const qRow = (page: Page, name: string) => page.getByTestId('pane-right').locator(`[data-testid="pane-row"][data-name="${name}"]`);
const qRows = (page: Page) => page.getByTestId('pane-right').getByTestId('pane-row');
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });
/** The transfer row the board's queue holds under `path`. */
async function transferOf(deviceId: string, path: string) {
  const [r] = await getDb().select({ id: transfers.id, status: transfers.status }).from(transfers)
    .where(and(eq(transfers.deviceId, deviceId), eq(transfers.path, path)));
  return r;
}
async function deleteInQueue(page: Page, text: string) {
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-text')).toHaveText(text);
  await page.getByTestId('files-delete-confirm').click();
}

test('a file picked on the Send zone waits in NET:, the board takes it, and its row reads Delivered with its saved name', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'r');
  await openQueue(page, deviceId);
  await expect(page.getByTestId('files-drop-stash')).toBeVisible();          // the STASH: zone beside it is unchanged
  await expect(page.getByTestId('files-send-board')).toContainText('Bench');
  await expect(page.getByTestId('files-send-receiver')).toHaveText('• Transfer is not running on the Amiga');

  await sendFile(page, 'Café.txt', Buffer.from('hello amiga'));
  await expect(toast(page, 'Queued 1 file for Bench')).toBeVisible({ timeout: LIVE });
  await expect(qRow(page, 'Café.txt')).toContainText('Waiting', { timeout: LIVE });
  await expect(page.getByTestId('files-send-receiver')).toHaveText('• Start Transfer on the Amiga');
  expect((await transferOf(deviceId, 'Café.txt')).status).toBe('queued');

  await boardSays(request, token, 'c');
  await page.reload();
  await expect(page.getByTestId('files-send-receiver')).toHaveText('✓ Transfer is running on the Amiga', { timeout: LIVE });
  await boardTakesNext(request, token, { ok: true, savedAs: 'Café_2.txt' });
  await expect(qRow(page, 'Café.txt')).toContainText('Delivered · saved as Café_2.txt', { timeout: LIVE });
  // Finished: Delete on it only clears the row, it cancels nothing.
  await qRow(page, 'Café.txt').click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-text')).toHaveText('Clear 1 finished file?');
});

// Was "Cancel takes a waiting file out of the board's queue": Cancel is Delete in NET: (R4).
test('Delete takes a waiting file out of the board\'s queue; a cancel after delivery says it already finished', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await openQueue(page, deviceId);
  await sendFile(page, 'One.bin', Buffer.alloc(100, 1));
  await expect(qRow(page, 'One.bin')).toContainText('Waiting', { timeout: LIVE });
  await qRow(page, 'One.bin').click();
  await deleteInQueue(page, 'Cancel 1 waiting file?');
  await expect(qRow(page, 'One.bin')).toContainText('Cancelled', { timeout: LIVE });
  expect((await transferOf(deviceId, 'One.bin')).status).toBe('cancelled');
  expect(await boardQueue(request, token)).toBe('NEXT -\nLIST 0\n');

  // Review Focus 2, through Files: a Delete that arrives after the board delivered clears the finished row and never
  // turns the delivery into a cancel. (Sent by request: the pane re-reads the queue every few seconds, so a click
  // there is a race.)
  await sendFile(page, 'Two.bin', Buffer.alloc(100, 2));
  await expect(qRow(page, 'Two.bin')).toContainText('Waiting', { timeout: LIVE });
  const two = await transferOf(deviceId, 'Two.bin');
  await boardTakesNext(request, token, { ok: true, savedAs: 'Two.bin' });
  await expect(qRow(page, 'Two.bin')).toContainText('Delivered · saved as Two.bin', { timeout: LIVE });
  expect((await transferOf(deviceId, 'Two.bin')).status).toBe('delivered');
  const late = await page.request.post('/api/files/ops', { data: { op: 'delete', sources: [`NET:/${deviceId}/${two.id}`] } });
  expect(late.status()).toBe(200);
  expect(await late.json()).toMatchObject({ items: [{ ok: true }] });
  expect(await transferOf(deviceId, 'Two.bin')).toBeUndefined();
  expect(await boardQueue(request, token)).toBe('NEXT -\nLIST 0\n');
  await expect(qRow(page, 'Two.bin')).toHaveCount(0, { timeout: LIVE });
});

// Was "a failure shows Transfer's reason, and Retry queues the file again". Retry is retired (R4): the person sends
// the file again, and that is a new row beside the failed one, which says why.
test('a failure shows Transfer\'s reason, and sending the file again queues a new row', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await openQueue(page, deviceId);
  await sendFile(page, 'Full.bin', Buffer.alloc(300, 3));
  await expect(qRow(page, 'Full.bin')).toContainText('Waiting', { timeout: LIVE });
  await boardTakesNext(request, token, { ok: false, code: 'space', text: 'disk full' });
  await expect(qRow(page, 'Full.bin')).toContainText('Failed · not enough space on the Amiga', { timeout: LIVE });
  await sendFile(page, 'Full.bin', Buffer.alloc(300, 3));
  await expect(qRows(page)).toHaveCount(2, { timeout: LIVE });
  await expect(qRow(page, 'Full.bin').filter({ hasText: 'Waiting' })).toHaveCount(1);
  expect(await boardQueue(request, token)).toMatch(/^NEXT \S+ 300 [0-9a-f]+ [0-9a-f]+ 8:Full\.bin /);
});

test('a file over 4 MB is refused in the browser, and a board below 1.15.0 is never offered', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await openQueue(page, deviceId);
  await sendFile(page, 'Big.bin', Buffer.alloc(4_194_305));
  await expect(toast(page, 'Big.bin is over 4 MB — nothing was sent')).toBeVisible({ timeout: LIVE });
  expect(await transferOf(deviceId, 'Big.bin')).toBeUndefined();

  await boardSays(request, token, 'c', '1.13.0+gdef5678');
  await page.goto(`/files?${new URLSearchParams({ left: 'NET:', right: 'STASH:', active: 'left' })}`);
  await expect(page.getByTestId('files-send-no-board')).toContainText('1.15.0');
  await expect(page.getByTestId('pane-left').getByTestId('pane-row')).toHaveCount(0);
});

async function seedSendDisk(orgId: string, title: string) {
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SendTest' });
  const mk = makeDirectory(adf, 880, 'mods'); if (!mk.ok) throw new Error(mk.reason); adf = mk.adf;
  const v = readVolume(adf); if (!v.ok) throw new Error('no volume');
  const mods = v.root.find((e) => e.name === 'mods')!.block;
  const a = addFile(adf, mods, 'a.txt', new TextEncoder().encode('hello'), 0x40); if (!a.ok) throw new Error(a.reason); adf = a.adf;
  // A comment, so a send from the disk shows it travels with the file (Files increment 3, R2).
  const v2 = readVolume(adf); if (!v2.ok) throw new Error('no volume');
  const file = v2.root.find((e) => e.name === 'mods')!.children.find((e) => e.name === 'a.txt')!.block;
  const c = setComment(adf, mods, file, 'a note'); if (!c.ok) throw new Error(c.reason); adf = c.adf;
  const sha = createHash('sha256').update(adf).digest('hex');
  if (!(await diskStore.stat(sha))) await diskStore.put(sha, adf);
  return { ...(await seedDisk(orgId, { title, diskNo: 1, sha256: sha })), mods };
}

// Files increment 1 (Task 9) made the head of a disk the Files manager; Send on a folder returned with NET: in Files
// increment 3 (Task 7) as a copy of the folder into the board's queue: its files go by their paths inside it, with
// their protection and comment, and the board takes them as before.
test('Files: a folder copied from a disk into NET:/<board> queues its files with their paths, protection and comment', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token, 'c');
  const { gameId, diskId } = await seedSendDisk(orgId, `S${runTag().slice(0, 6)}`);
  await page.goto(`/files?${new URLSearchParams({ left: `LIBRARY:/${gameId}/${diskId}`, right: `NET:/${deviceId}`, active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  const row = (side: 'left' | 'right', name: string) =>
    page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
  await row('left', 'mods').click();
  await page.getByTestId('files-copy').click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Queued 1 file to Bench.' })).toBeVisible({ timeout: LIVE });
  // size 5, crc, protection 0x40, the path inside the folder, the comment.
  expect(await boardQueue(request, token)).toMatch(/^NEXT \S+ 5 [0-9a-f]+ 40 10:mods\/a\.txt 6:a note\n/);
  await expect(row('right', 'mods/a.txt')).toContainText('Waiting', { timeout: LIVE });

  await boardTakesNext(request, token, { ok: true, savedAs: 'a.txt' });
  await expect(row('right', 'mods/a.txt')).toContainText('Delivered · saved as a.txt', { timeout: LIVE });
  // The disk is unchanged: a send is a copy.
  await expect(row('left', 'mods')).toBeVisible();
});

test('a title page: Send .adf to Amiga queues the whole disk as <name>.adf, and See queue opens it in NET:', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token, 'c');
  const title = `S${runTag().slice(0, 6)}`;
  const { gameId, diskId } = await seedSendDisk(orgId, title);
  await page.goto(`/games/${gameId}`);
  await page.getByTestId(`send-adf-${diskId}`).click();
  const sent = toast(page, 'Queued for Bench');
  await expect(sent).toBeVisible();
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toContain(` 901120 ${`${title}-1.adf`.length}:${title}-1.adf\n`);
  await sent.getByRole('button', { name: 'See queue' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('right')).toBe(`NET:/${deviceId}`);
  await expect(qRow(page, `${title}-1.adf`)).toContainText('Waiting', { timeout: LIVE });
});

test('the board\'s card says what waits and whether Transfer runs, and links to the queue in NET:', async ({ page, request }) => {
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
  await expect.poll(() => {
    const u = new URL(page.url());
    return [u.pathname, u.searchParams.get('right'), u.searchParams.get('active')];
  }).toEqual(['/files', `NET:/${deviceId}`, 'right']);
  await expect(page.getByTestId('pane-right-crumb-1')).toHaveText('Bench');
  await expect(qRow(page, 'a.txt')).toContainText('Waiting', { timeout: LIVE });
  await expect(page.getByTestId('files-send-board')).toContainText('Bench');
});

// Was "…and Clear finished removes the finished rows while it stays". Clear finished is retired (R4): the finished rows
// are selected and Deleted, which clears them and leaves the waiting one. The bounded Staging list box went with it.
test('a long queue: the waiting file is first by date, and Delete clears the finished rows while it stays', async ({ page, request }) => {
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
  // Cancelled through Files' Delete, as the pane's Delete sends it.
  const cancel = async (id: string) => (await page.request.post('/api/files/ops', { data: { op: 'delete', sources: [`NET:/${deviceId}/${id}`] } })).status();
  for (let i = 0; i < 11; i++) expect(await cancel(await post(`C${i}.bin`))).toBe(200);
  const waiting = await post('Waiting.bin');

  await openQueue(page, deviceId);
  await expect(qRows(page)).toHaveCount(14, { timeout: LIVE });
  await expect(page.getByTestId('pane-right-meta')).toContainText('1 waiting');
  // Newest first: the waiting row, made last, leads the many finished ones.
  const byDate = page.getByTestId('pane-right-sort-date');
  await byDate.getByRole('button').click();
  if ((await byDate.getAttribute('aria-sort')) !== 'descending') await byDate.getByRole('button').click();
  await expect(byDate).toHaveAttribute('aria-sort', 'descending');
  await expect(qRows(page).first()).toHaveAttribute('data-name', 'Waiting.bin');
  await expect(qRows(page).first()).toContainText('Waiting');

  // The thirteen finished rows: Delete clears them, and cancels nothing.
  await qRows(page).nth(1).click();
  await qRows(page).nth(13).click({ modifiers: ['Shift'] });
  await deleteInQueue(page, 'Clear 13 finished files?');
  await expect(qRows(page)).toHaveCount(1, { timeout: LIVE });
  await expect(qRow(page, 'Waiting.bin')).toContainText('Waiting');
  expect((await transferOf(deviceId, 'Waiting.bin')).status).toBe('queued');
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toMatch(new RegExp(`^NEXT ${waiting} `));
});
