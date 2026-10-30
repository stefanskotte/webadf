import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { remoteRequests } from '@/db/schema/remote-requests';
import { formatVolume } from '@/lib/adffs/format';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice, setBrowse } from './device-helpers';
import { boardSays, boardServes, boardServesOne, boardTakesRequests, type BoardRequest, type FakeEntry } from './amiga-board';

/**
 * NET: volumes (spec 2026-10-30 §4-§5, plan Task 9): Files browsing a board's Amiga against a fake board that answers
 * through the device routes as firmware 1.22.0 with Transfer 2.3 would -- the volumes, a drawer, the 2-minute memory and
 * Refresh, copies to STASH: (a file, a drawer walked, one after the memory ran out, a Download) and to LIBRARY:, browsing
 * switched off with Queue still working, a board that never answers, and the read-only bank.
 */

test.afterAll(cleanupSeeded);

const LIVE = 15_000;
const FW = '1.22.0+gabc1234';
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);

const ADF = Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: 'NetVolBlank' }));
const FS: Record<string, FakeEntry[]> = {
  '': [{ name: 'Work', device: 'DH1:' }, { name: 'Workbench', device: 'DH0:' }],
  'Work:': [
    { name: 'Programs', dir: true },
    { name: 'a.lha', data: Buffer.from('an lha archive, as far as this test knows') },
    { name: 'b.txt', data: Buffer.from('bee') },
    { name: 'c.txt', data: Buffer.from('downloaded from the amiga') },
    { name: 'Blank.adf', data: ADF },
  ],
  'Work:Programs': [{ name: 'Tool', data: Buffer.from('a tool'), protection: 0x40, comment: 'handy' }, { name: 'Sub', dir: true }],
  'Work:Programs/Sub': [{ name: 'deep.txt', data: Buffer.from('two drawers down') }],
  'Workbench:': [{ name: 'S', dir: true }],
};

/** A fresh org with one board that can be browsed: firmware 1.22.0, Transfer running protocol 3, browsing on. */
async function browsable(page: Page, request: APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500');
  await boardSays(request, token, FW);
  await setBrowse(deviceId, { firmware: FW, rx: 'c', rxProto: 3, browseOn: true });
  return { orgId, deviceId, token };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

/** The fake board serving `FS` until the returned stop() (which also hands back what it served). */
function serving(request: APIRequestContext, token: string, maxMs = 60_000) {
  let done = false;
  const served: BoardRequest[] = [];
  const run = boardServes(request, token, FS, () => done, served, maxMs);
  return { served, stop: async () => { done = true; return run; } };
}

/** The board's remembered answer for `path` was given `ageMs` ago (the 2-minute memory, spec V3, without the wait). */
async function age(deviceId: string, kind: 'vols' | 'dir', path: string, ageMs: number) {
  await getDb().update(remoteRequests).set({ answeredAt: new Date(Date.now() - ageMs) })
    .where(and(eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.kind, kind), sql`lower(${remoteRequests.amigaPath}) = lower(${path})`,
      eq(remoteRequests.status, 'done')));
}

test('NET:/<board> lists its Amiga\'s volumes, as folders with their device and free space, then Queue', async ({ page, request }) => {
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, 'STASH:', `NET:/${deviceId}`, 'right');
  await expect(page.getByTestId('pane-pending')).toContainText('Reading volumes from A500');

  const board = serving(request, token);
  await expect(rowAt(page, 'right', 'Work')).toBeVisible({ timeout: LIVE });
  await expect(rowAt(page, 'right', 'Workbench')).toBeVisible();
  await expect(rowAt(page, 'right', 'Queue')).toBeVisible();
  await expect(rowAt(page, 'right', 'Work')).toContainText('DH1: ·');
  await expect(rowAt(page, 'right', 'Workbench')).toContainText('DH0: ·');
  await expect(page.getByTestId('pane-pending')).toHaveCount(0);
  await expect(page.getByTestId('net-browse-reason')).toHaveCount(0);
  expect((await board.stop()).map((r) => r.kind)).toEqual(['VOLS']);
});

test('a drawer opens from the Amiga; Parent shows the remembered one at once with its age; Refresh and Ctrl-R ask again', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, 'STASH:', `NET:/${deviceId}`, 'right');
  const board = serving(request, token);
  await rowAt(page, 'right', 'Work').dblclick({ timeout: LIVE });
  await expect(rowAt(page, 'right', 'Programs')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('pane-right-net-title')).toHaveText('A500 · Work:');
  await rowAt(page, 'right', 'Programs').dblclick();
  await expect(rowAt(page, 'right', 'Tool')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('pane-right-net-title')).toHaveText('A500 · Work:Programs');
  expect((await board.stop()).map((r) => `${r.kind} ${r.path}`)).toEqual(['VOLS ', 'DIR Work:', 'DIR Work:Programs']);

  // Work: was read 30 s ago (within the 2 minutes): Parent lists it without asking the Amiga, and says how old it is.
  await age(deviceId, 'dir', 'Work:', 30_000);
  await page.getByTestId('files-parent').click();
  await expect(rowAt(page, 'right', 'Programs')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('pane-right-net-title')).toHaveText('A500 · Work:');
  await expect(page.getByTestId('pane-right-read-ago')).toContainText('read');
  expect(await boardTakesRequests(request, token)).toEqual([]);

  // Refresh asks the Amiga afresh: the pending line, one new DIR, and the answer replaces the remembered rows.
  await page.getByTestId('files-refresh').click();
  await expect(page.getByTestId('pane-pending')).toContainText('Reading Work: from A500');
  let asked: BoardRequest[] = [];
  await expect.poll(async () => (asked = await boardTakesRequests(request, token)).length, { timeout: LIVE }).toBe(1);
  expect(asked.map((r) => `${r.kind} ${r.path}`)).toEqual(['DIR Work:']);
  await boardServesOne(request, token, FS, asked[0]);
  await expect(page.getByTestId('pane-pending')).toHaveCount(0, { timeout: LIVE });
  await expect(page.getByTestId('pane-right-read-ago')).toHaveCount(0);

  // Ctrl-R (Cmd-R) does the same from the keyboard, and the browser does not reload the page.
  await rowAt(page, 'right', 'a.lha').click();
  await page.keyboard.press('ControlOrMeta+r');
  await expect(page.getByTestId('pane-pending')).toContainText('Reading Work: from A500');
  await expect.poll(async () => (asked = await boardTakesRequests(request, token)).length, { timeout: LIVE }).toBe(1);
  expect(asked.map((r) => `${r.kind} ${r.path}`)).toEqual(['DIR Work:']);
  await boardServesOne(request, token, FS, asked[0]);
  await expect(page.getByTestId('pane-pending')).toHaveCount(0, { timeout: LIVE });
  await expect(rowAt(page, 'right', 'Programs')).toBeVisible();
});

test('Copy to STASH: a file, a drawer walked whole, a file after the memory ran out, and Download of a file', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
  const board = serving(request, token, 140_000);
  await expect(rowAt(page, 'right', 'a.lha')).toBeVisible({ timeout: LIVE });

  // One file: the status row follows the board, then STASH: lists it.
  await rowAt(page, 'right', 'a.lha').click();
  await page.getByTestId('files-copy').click();
  await expect(page.getByTestId('files-busy')).toContainText('Copied 1', { timeout: LIVE });
  await expect(rowAt(page, 'left', 'a.lha')).toBeVisible({ timeout: LIVE });

  // A drawer: Programs and the drawer in it are read (fresh) before the copy is posted; its files keep their places.
  await rowAt(page, 'right', 'Programs').click();
  await page.getByTestId('files-copy').click();
  await expect(page.getByTestId('files-busy')).toContainText(/Copying \d of 2 from A500|Copied 2/, { timeout: LIVE });
  await expect(page.getByTestId('files-busy')).toContainText('Copied 2', { timeout: LIVE });
  await rowAt(page, 'left', 'Programs').dblclick({ timeout: LIVE });
  await expect(rowAt(page, 'left', 'Tool')).toBeVisible({ timeout: LIVE });
  await rowAt(page, 'left', 'Sub').dblclick();
  await expect(rowAt(page, 'left', 'deep.txt')).toBeVisible({ timeout: LIVE });
  await page.getByTestId('pane-left-crumb-0').click();
  await setBrowse(deviceId);   // still seen: this test outlasts the 60 s a board counts as online

  // The listing the copy expands from is older than 2 minutes: the pane asks the Amiga for it again, then copies.
  const before = board.served.length;
  await age(deviceId, 'dir', 'Work:', 150_000);
  await rowAt(page, 'right', 'b.txt').click();
  await page.getByTestId('files-copy').click();
  await expect(page.getByTestId('files-busy')).toContainText('Copied 1', { timeout: LIVE });
  await expect(rowAt(page, 'left', 'b.txt')).toBeVisible({ timeout: LIVE });
  expect(board.served.slice(before).map((r) => `${r.kind} ${r.path}`)).toEqual(['DIR Work:', 'GET Work:b.txt']);

  // Download: a one-file copy into STASH:, then the browser's download of what arrived.
  await rowAt(page, 'right', 'c.txt').click();
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByTestId('files-download').click();
  expect((await download).suggestedFilename()).toBe('c.txt');
  await expect(rowAt(page, 'left', 'c.txt')).toBeVisible({ timeout: LIVE });
  await board.stop();
});

test('Copy a disk image from a volume to LIBRARY: makes a title', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, 'LIBRARY:', `NET:/${deviceId}/Work`, 'right');
  const board = serving(request, token);
  await expect(rowAt(page, 'right', 'Blank.adf')).toBeVisible({ timeout: LIVE });
  const titles = page.getByTestId('pane-left').locator('[data-testid="pane-row"][data-kind="title"]');
  await expect(titles).toHaveCount(0);
  await rowAt(page, 'right', 'Blank.adf').click();
  await page.getByTestId('files-copy').click();
  await expect(page.getByTestId('files-busy')).toContainText('Copied 1', { timeout: 30_000 });
  await expect(titles).toHaveCount(1, { timeout: LIVE });
  expect((await board.stop()).map((r) => r.kind)).toContain('GET');
});

test('browsing off: the board says why in place of its volumes, and Queue still sends', async ({ page, request }) => {
  const { deviceId, token } = await browsable(page, request);
  await setBrowse(deviceId, { browseOn: false });
  await openFiles(page, 'STASH:', `NET:/${deviceId}`, 'right');
  await expect(page.getByTestId('net-browse-reason')).toHaveText('Switch on browsing in Transfer on A500');
  await expect(page.getByTestId('pane-pending')).toHaveCount(0);
  const rows = page.getByTestId('pane-right').getByTestId('pane-row');
  await expect(rows).toHaveCount(1);
  await expect(rowAt(page, 'right', 'Queue')).toBeVisible();
  expect(await boardTakesRequests(request, token)).toEqual([]);   // nothing was asked of the Amiga

  await rowAt(page, 'right', 'Queue').dblclick();
  await expect(page).toHaveURL(new RegExp(`right=NET%3A%2F${deviceId}%2FQueue`));
  await expect(page.getByTestId('pane-right-crumb-2')).toHaveText('Queue');
  await page.getByTestId('files-send-input').setInputFiles([{ name: 'q.txt', mimeType: 'text/plain', buffer: Buffer.from('queued') }]);
  await expect(rowAt(page, 'right', 'q.txt')).toContainText('Waiting', { timeout: LIVE });
});

test('a board that never answers: after 20 s the pane says so, and stops asking', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { deviceId } = await browsable(page, request);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
  await expect(page.getByTestId('pane-pending')).toContainText('Reading Work: from A500');
  await expect(page.getByTestId('pane-right-error')).toHaveText('A500 didn\'t answer — Refresh to try again', { timeout: 25_000 });
  await expect(page.getByTestId('pane-pending')).toHaveCount(0);
  // Best effort: the pane no longer asks for the listing once it gave up.
  let asks = 0;
  page.on('request', (r) => { if (r.url().includes('/api/files/list') && r.url().includes(encodeURIComponent(deviceId))) asks++; });
  await page.waitForTimeout(2_000);
  expect(asks).toBe(0);
});

test('a volume is read-only: Delete, Move, Rename and Makedir say so', async ({ page, request }) => {
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
  const board = serving(request, token);
  await expect(rowAt(page, 'right', 'a.lha')).toBeVisible({ timeout: LIVE });
  await rowAt(page, 'right', 'a.lha').click();
  for (const cmd of ['delete', 'move', 'rename', 'makedir']) {
    await expect(page.getByTestId(`files-${cmd}`)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(`files-${cmd}`)).toHaveAttribute('title', 'Read-only for now');
  }
  // Copy and Refresh are not.
  await expect(page.getByTestId('files-copy')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('files-refresh')).not.toHaveAttribute('aria-disabled', 'true');
  await board.stop();
});
