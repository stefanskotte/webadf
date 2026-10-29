import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { signUpFresh } from './helpers';
import { authHeader, cleanupSeeded, pairDevice } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';
import { boardSays } from './amiga-board';

/**
 * Files increment 3, Task 2: NET: in the panes. A paired board on firmware 1.15.0+ is a BRD row under NET: with its key
 * digits; Copy → into its queue sends (one queued row per file, a folder's files by their paths), Move into it and
 * anything out of it are refused in words, the pane re-reads the queue as the board takes files, Delete cancels what
 * waits and clears what finished, and files from the computer dropped on the queue are sent too. Task 7 covers the
 * rest of NET: (the Send drop zone, the phone picker's Send here, redirects).
 */

test.afterAll(cleanupSeeded);

const LIVE = 15_000;
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

/** The board takes its queue's NEXT file whole and says it was saved as `savedAs` (send-to-amiga.spec.ts's way). */
async function boardTakesNext(request: APIRequestContext, token: string, savedAs: string) {
  const text = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  const m = /^NEXT (\S+) (\d+) /.exec(text);
  expect(m, text).not.toBeNull();
  const [, id, size] = m!;
  for (let off = 0; off < Number(size); off += 16_384) {
    expect((await request.get(`/api/device/send/${id}?offset=${off}&length=16384`, { headers: authHeader(token) })).status()).toBe(200);
  }
  expect((await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: { ok: true, savedAs } })).status()).toBe(204);
  return id;
}

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
  const took = await boardTakesNext(request, token, 'enigma_2.mod');
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
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toBe('NEXT -\nLIST 0\n');

  // Files from the computer dropped on the queue are sent to the board (C2), not stored in STASH:.
  await synthDrop(page, [{ name: 'Drop.txt', kind: 'file', content: 'dropped' }], '[data-testid="pane-right"]');
  await expect(toast(page, 'Queued 1 file to A500 bench.')).toBeVisible({ timeout: LIVE });
  await expect(rowAt(page, 'right', 'Drop.txt')).toContainText('Waiting');
  expect((await queued(orgId, deviceId))['Drop.txt']).toEqual({ status: 'queued', size: 7, comment: '' });
  await expect(rowAt(page, 'left', 'Drop.txt')).toHaveCount(0);
});
