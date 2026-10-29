import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';
import { boardQueue, boardSays, boardTakesNext, boardUploads } from './amiga-board';

/**
 * Files increment 3, Task 2: NET: in the panes. A paired board on firmware 1.15.0+ is a BRD row under NET: with its key
 * digits; Copy → into its queue sends (one queued row per file, a folder's files by their paths), Move into it and
 * anything out of it are refused in words, the pane re-reads the queue as the board takes files, Delete cancels what
 * waits and clears what finished, and files from the computer dropped on the queue are sent too. Task 7 adds the rest
 * end to end: which boards NET: lists, a drop on the Send zone the board takes, the 32-file queue refused whole from
 * both ways in, the device card's lines and the retired Upload page's URLs landing in Files. (A folder copied from a
 * disk into NET: is send-to-amiga.spec.ts's "Files: a folder copied from a disk…".)
 */

test.afterAll(cleanupSeeded);

const LIVE = 15_000;
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  // Hydrated, so clicks, drops and pickers reach React's handlers.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}
/** The panes the page shows now, read from its URL (the router may spell the colon either way). */
const panes = (page: Page) => {
  const sp = new URL(page.url()).searchParams;
  return { path: new URL(page.url()).pathname, left: sp.get('left'), right: sp.get('right'), active: sp.get('active') };
};

async function queued(orgId: string, deviceId: string) {
  const rows = await getDb().select().from(transfers).where(and(eq(transfers.orgId, orgId), eq(transfers.deviceId, deviceId)));
  return Object.fromEntries(rows.map((r) => [r.path, { status: r.status, size: r.sizeBytes, comment: r.comment }]));
}

test('NET: in the panes: a board row with its key; Copy → queues, the pane follows the board, Delete cancels or clears', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500 bench');
  await boardSays(request, token, '1.19.0+gabc1234', 'ab12');

  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: 'NET:', active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  // Files into STASH: to send: two files and a folder holding one.
  await synthDrop(page, [
    { name: 'notes.txt', kind: 'file', content: 'hello amiga' },
    { name: 'Mods', kind: 'dir', children: [{ name: 'enigma.mod', kind: 'file', content: 'not really a module' }] },
  ], '[data-testid="files-drop-stash"]');
  await expect(toast(page, 'Added 2 items to STASH:')).toBeVisible({ timeout: LIVE });

  // The device buttons, NET: between STASH: and LIBRARY:; the board under NET: with its marks.
  const devs = page.getByTestId('pane-right').locator('[data-testid^="pane-right-dev-"]');
  await expect(devs).toHaveText(['STASH:', 'NET:', 'LIBRARY:']);
  const board = rowAt(page, 'right', 'A500 bench');
  await expect(board).toHaveAttribute('data-kind', 'board');
  await expect(board).toContainText('BRD');
  await expect(board).toContainText('key AB12');
  // NET: itself takes nothing: Copy says to open a board.
  await rowAt(page, 'left', 'notes.txt').click();
  await expect(page.getByTestId('files-copy')).toBeDisabled();
  await expect(page.getByTestId('files-copy')).toHaveAttribute('title', 'Open a board to send files to it.');

  await board.dblclick();
  await expect(page.getByTestId('pane-right-crumb-1')).toHaveText('A500 bench');
  await expect(page).toHaveURL(new RegExp(`right=NET%3A%2F${deviceId}`));

  // Move into NET: is refused in words (C16); Copy sends both, the folder's file by its path.
  await rowAt(page, 'left', 'notes.txt').click();
  await rowAt(page, 'left', 'Mods').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('files-move')).toBeDisabled();
  await expect(page.getByTestId('files-move')).toHaveAttribute('title', 'Files sent to the Amiga stay where they are — use Copy');
  await page.getByTestId('files-copy').click();
  await expect(toast(page, 'Queued 2 files to A500 bench.')).toBeVisible({ timeout: LIVE });
  await expect(rowAt(page, 'right', 'notes.txt')).toContainText('Waiting');
  await expect(rowAt(page, 'right', 'Mods/enigma.mod')).toContainText('Waiting');
  expect(await queued(orgId, deviceId)).toEqual({
    'notes.txt': { status: 'queued', size: 11, comment: '' },
    'Mods/enigma.mod': { status: 'queued', size: 19, comment: '' },
  });
  // The originals stay in STASH:.
  await expect(rowAt(page, 'left', 'notes.txt')).toBeVisible();

  // Nothing comes out of NET:, and its rows are not renamed (R5).
  await rowAt(page, 'right', 'notes.txt').click();
  await expect(page.getByTestId('files-copy')).toHaveAttribute('title', 'Files waiting for the Amiga cannot be copied out');
  await expect(page.getByTestId('files-download')).toBeDisabled();
  await expect(page.getByTestId('files-rename')).toHaveAttribute('title', 'Not in NET:');
  await expect(rowAt(page, 'right', 'notes.txt')).toHaveAttribute('draggable', 'false');

  // The board takes the oldest; the pane reads it delivered without a reload (the poll).
  const took = await boardTakesNext(request, token, { ok: true, savedAs: 'enigma_2.mod' });
  const [taken] = await getDb().select({ path: transfers.path }).from(transfers).where(eq(transfers.id, took));
  expect(taken.path).toBe('Mods/enigma.mod');   // queued in the order the rows are drawn: the folder first
  await expect(rowAt(page, 'right', 'Mods/enigma.mod')).toContainText('Delivered · saved as enigma_2.mod', { timeout: LIVE });

  // Delete on a finished row and a waiting one: one is cleared, the other cancelled.
  await rowAt(page, 'right', 'notes.txt').click();
  await rowAt(page, 'right', 'Mods/enigma.mod').click({ modifiers: ['ControlOrMeta'] });
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-text')).toHaveText('Cancel 1 waiting file and clear 1 finished?');
  await expect(page.getByTestId('files-delete-confirm')).toHaveText('Cancel / clear');
  await page.getByTestId('files-delete-confirm').click();
  await expect(toast(page, 'Cancelled or cleared 2 items on A500 bench.')).toBeVisible({ timeout: LIVE });
  await expect(rowAt(page, 'right', 'Mods/enigma.mod')).toHaveCount(0);
  await expect(rowAt(page, 'right', 'notes.txt')).toContainText('Cancelled');
  expect(await queued(orgId, deviceId)).toEqual({ 'notes.txt': { status: 'cancelled', size: 11, comment: '' } });
  expect(await boardQueue(request, token)).toBe('NEXT -\nLIST 0\n');

  // Files from the computer dropped on the queue are sent to the board (C2), not stored in STASH:.
  await synthDrop(page, [{ name: 'Drop.txt', kind: 'file', content: 'dropped' }], '[data-testid="pane-right"]');
  await expect(toast(page, 'Queued 1 file to A500 bench.')).toBeVisible({ timeout: LIVE });
  await expect(rowAt(page, 'right', 'Drop.txt')).toContainText('Waiting');
  expect((await queued(orgId, deviceId))['Drop.txt']).toEqual({ status: 'queued', size: 7, comment: '' });
  await expect(rowAt(page, 'left', 'Drop.txt')).toHaveCount(0);
});

test('Send files to the Amiga: a file and a folder dropped on the zone queue with their paths; a drop that does not fit sends nothing', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500 bench');
  await boardSays(request, token, '1.19.0+gabc1234', 'ab12');
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: 'NET:', active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  const zone = page.getByTestId('files-drop-send');
  await expect(zone).toContainText('Send files to the Amiga');
  await expect(page.getByTestId('files-send-board')).toContainText('A500 bench');

  // Over the 4 MB cap: refused whole, nothing queued (the small file beside it is not sent either).
  await synthDrop(page, [
    { name: 'small.txt', kind: 'file', content: 'tiny' },
    { name: 'big.bin', kind: 'file', content: 'x'.repeat(4_194_305) },
  ], '[data-testid="files-drop-send"]');
  await expect(toast(page, 'big.bin is over 4 MB — nothing was sent')).toBeVisible({ timeout: LIVE });
  expect(await queued(orgId, deviceId)).toEqual({});

  // A file and a folder: the folder's file goes by its path.
  await synthDrop(page, [
    { name: 'notes.txt', kind: 'file', content: 'hello amiga' },
    { name: 'Mods', kind: 'dir', children: [{ name: 'enigma.mod', kind: 'file', content: 'not really a module' }] },
  ], '[data-testid="files-drop-send"]');
  await expect(toast(page, 'Queued 2 files for A500 bench')).toBeVisible({ timeout: LIVE });
  expect(await queued(orgId, deviceId)).toEqual({
    'notes.txt': { status: 'queued', size: 11, comment: '' },
    'Mods/enigma.mod': { status: 'queued', size: 19, comment: '' },
  });

  // Show queue takes the right pane to the board, listing what was queued.
  await toast(page, 'Queued 2 files for A500 bench').getByRole('button', { name: 'Show queue' }).click();
  await expect(page).toHaveURL(new RegExp(`right=NET%3A%2F${deviceId}`));
  await expect(rowAt(page, 'right', 'Mods/enigma.mod')).toContainText('Waiting', { timeout: LIVE });

  // The picker sends too, and a pane showing the board reloads.
  await page.getByTestId('files-send-input').setInputFiles([{ name: 'picked.txt', mimeType: 'text/plain', buffer: Buffer.from('picked') }]);
  await expect(rowAt(page, 'right', 'picked.txt')).toContainText('Waiting', { timeout: LIVE });
});

test('Send files to the Amiga: with no board that can receive, the zone says so and links to Devices', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/files');
  const empty = page.getByTestId('files-send-no-board');
  await expect(empty).toContainText('No board can receive files yet. Sending needs a board on firmware 1.15.0 or newer.');
  await expect(empty.getByRole('link', { name: 'Devices' })).toHaveAttribute('href', '/devices');
  await expect(page.getByTestId('files-send-input')).toHaveCount(0);
});

test('NET: lists a board on 1.15.0 and not one below', async ({ page, request }) => {
  await signUpFresh(page);
  const now = await pairDevice(page, request, 'New enough');
  await boardSays(request, now.token, '1.15.0+gabc1234');
  const old = await pairDevice(page, request, 'Too old');
  await boardSays(request, old.token, '1.14.0+gdef5678');
  await openFiles(page, 'NET:', 'STASH:', 'left');
  const boards = page.getByTestId('pane-left').locator('[data-testid="pane-row"][data-kind="board"]');
  await expect(boards).toHaveCount(1);
  await expect(boards).toHaveAttribute('data-name', 'New enough');
  await expect(rowAt(page, 'left', 'Too old')).toHaveCount(0);
});

test('a file dropped on the Send zone waits in NET:, the board takes it, and its row reads Delivered with the saved name', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await openFiles(page, 'STASH:', 'LIBRARY:', 'left');

  await synthDrop(page, [{ name: 'hello.txt', kind: 'file', content: 'hello amiga' }], '[data-testid="files-drop-send"]');
  const sent = toast(page, 'Queued 1 file for Bench');
  await expect(sent).toBeVisible({ timeout: LIVE });
  await sent.getByRole('button', { name: 'Show queue' }).click();
  await expect.poll(() => panes(page).right).toBe(`NET:/${deviceId}`);
  await expect(rowAt(page, 'right', 'hello.txt')).toContainText('Waiting', { timeout: LIVE });
  expect(await boardQueue(request, token)).toMatch(/^NEXT \S+ 11 [0-9a-f]+ [0-9a-f]+ 9:hello\.txt 0:\n/);

  // Transfer saves it under another name (one was there): the row says which, without a reload.
  await boardTakesNext(request, token, { ok: true, savedAs: 'hello_2.txt' });
  await expect(rowAt(page, 'right', 'hello.txt')).toContainText('Delivered · saved as hello_2.txt', { timeout: LIVE });

  // A file the Amiga could not save says why (R4: no Retry; the person sends it again).
  await page.getByTestId('files-send-input').setInputFiles([{ name: 'full.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300, 3) }]);
  await expect(rowAt(page, 'right', 'full.bin')).toContainText('Waiting', { timeout: LIVE });
  await boardTakesNext(request, token, { ok: false, code: 'space', text: 'disk full' });
  await expect(rowAt(page, 'right', 'full.bin')).toContainText('Failed · not enough space on the Amiga', { timeout: LIVE });
});

test('more than 32 files for one board are refused whole: from the computer, and by Copy from STASH:', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await openFiles(page, 'STASH:', `NET:/${deviceId}`, 'left');
  const words = "The board's queue holds 32 files / 16 MB; wait for it to empty or cancel some.";
  const many = Array.from({ length: 33 }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}.txt`, content: `file ${i}` }));

  // 33 picked on the Send zone: nothing goes up.
  await page.getByTestId('files-send-input').setInputFiles(many.map((f) => ({ name: f.name, mimeType: 'text/plain', buffer: Buffer.from(f.content) })));
  await expect(toast(page, words)).toBeVisible({ timeout: LIVE });
  expect(await queued(orgId, deviceId)).toEqual({});
  expect(await boardQueue(request, token)).toBe('NEXT -\nLIST 0\n');
  await expect(toast(page, words)).toHaveCount(0, { timeout: 20_000 });   // gone, so the next one is the copy's

  // A folder of 33 in STASH: copied into the board: refused whole by the server, nothing queued, the folder kept.
  await synthDrop(page, [{ name: 'Many', kind: 'dir', children: many.map((f) => ({ ...f, kind: 'file' as const })) }], '[data-testid="files-drop-stash"]');
  await expect(rowAt(page, 'left', 'Many')).toBeVisible({ timeout: LIVE });
  await rowAt(page, 'left', 'Many').click();
  await page.getByTestId('files-copy').click();
  await expect(toast(page, words)).toBeVisible({ timeout: LIVE });
  expect(await queued(orgId, deviceId)).toEqual({});
  expect(await boardQueue(request, token)).toBe('NEXT -\nLIST 0\n');
  await expect(page.getByTestId('pane-right').getByTestId('pane-row')).toHaveCount(0);
  await expect(rowAt(page, 'left', 'Many')).toBeVisible();
});

test('the device card\'s lines open Files: the send line on the board\'s queue, the Amiga\'s files in STASH:', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  expect((await page.request.post(`/api/transfers?deviceId=${deviceId}&name=a.txt`, { data: Buffer.from('a'),
    headers: { 'content-type': 'application/octet-stream' } })).status()).toBe(201);
  await boardUploads(request, token, 'Up.txt', Buffer.from('from the amiga'));

  await page.goto('/devices');
  await expect(page.getByTestId(`device-send-${deviceId}`)).toContainText('1 file waiting');
  await page.getByTestId(`device-send-${deviceId}`).click();
  await expect.poll(() => panes(page)).toEqual({ path: '/files', left: 'STASH:', right: `NET:/${deviceId}`, active: 'right' });
  await expect(rowAt(page, 'right', 'a.txt')).toContainText('Waiting', { timeout: LIVE });

  await page.goto('/devices');
  await page.getByTestId(`device-upload-${deviceId}`).click();
  await expect.poll(() => panes(page)).toEqual({ path: '/files', left: 'STASH:', right: `NET:/${deviceId}`, active: 'left' });
  await expect(rowAt(page, 'left', 'Up.txt')).toBeVisible({ timeout: LIVE });
});

test('the Upload page\'s URLs land in Files: ?board= on the queue, ?from= on STASH:, the bare one on Files', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);

  const hop = await page.request.get(`/ingest?board=${deviceId}`, { maxRedirects: 0 });
  expect(hop.status()).toBe(307);
  await page.goto(`/ingest?board=${deviceId}`);
  await expect.poll(() => panes(page)).toEqual({ path: '/files', left: 'STASH:', right: `NET:/${deviceId}`, active: 'right' });
  await expect(page.getByTestId('pane-right-crumb-1')).toHaveText('Bench');

  await page.goto(`/ingest?from=${deviceId}`);
  await expect.poll(() => panes(page)).toEqual({ path: '/files', left: 'STASH:', right: `NET:/${deviceId}`, active: 'left' });

  await page.goto('/ingest');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/files');
  await expect(page.getByTestId('files-manager')).toBeVisible();
});
