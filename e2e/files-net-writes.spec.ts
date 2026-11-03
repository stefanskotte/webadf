import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice, setBrowse } from './device-helpers';
import { boardSays, boardServes, boardUploads, fakeBoardTiming, type BoardRequest, type FakeEntry, type VolumeNext } from './amiga-board';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { listStash } from '@/lib/stash';

/**
 * NET: volumes phase 2 (spec 2026-10-31 §4, plan Task 9): Files changing the Amiga's own disks against a fake board that
 * answers as firmware 1.23 with Transfer 2.5 would -- Makedir, Rename, Protect, a comment, Delete with its confirm and a
 * big drawer's delete counting up then stopping at a file in use, a copy from STASH: onto a volume with each clash
 * answer, moves both ways, and the write buttons greyed with the words when writing is off or Transfer is too old.
 */

test.afterAll(cleanupSeeded);

const LIVE = 15_000;
const FW = '1.23.0+gabc1234';
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
/** The newest card of the progress panel (spec 2026-11-01-progress-panel): where a job's progress and result are said. */
const busy = (page: Page) => page.getByTestId('transfers-card').first();

/** A fresh Amiga for each test (the fake board changes it). */
function amiga(): Record<string, FakeEntry[]> {
  return {
    '': [{ name: 'Work', device: 'DH1:' }],
    'Work:': [
      { name: 'a.lha', data: Buffer.from('an archive') },
      { name: 'a.lha.info', data: Buffer.from('icon') },
      { name: 'c.txt', data: Buffer.from('see') },
      { name: 'Tools', dir: true },
      { name: 'Big', dir: true },
    ],
    'Work:Tools': [{ name: 'x.lha', data: Buffer.from('old x') }],
    'Work:Big': Array.from({ length: 120 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}`, data: Buffer.from(`${i}`), busy: i === 100 })),
  };
}

/** A fresh org with one board that can write: firmware 1.23.0, Transfer on protocol 5 (2.6) with browsing and writing on. */
async function writable(page: Page, request: APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500');
  await boardSays(request, token, FW);
  await setBrowse(deviceId, { firmware: FW, rx: 'c', rxProto: 5, browseOn: true, writeOn: true });
  return { orgId, deviceId, token };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

/** The fake board serving `fs` (requests and its queue) until stop(). */
function serving(request: APIRequestContext, token: string, fs: Record<string, FakeEntry[]>, maxMs = 120_000) {
  let done = false;
  const served: BoardRequest[] = [];
  const queue: VolumeNext[] = [];
  const run = boardServes(request, token, fs, () => done, served, maxMs, { queue });
  return { served, queue, stop: async () => { done = true; return run; } };
}

test('writing off, or Transfer too old: the write buttons are greyed with the words, Copy still works', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { deviceId, token } = await writable(page, request);
  await setBrowse(deviceId, { writeOn: false });
  const fs = amiga();
  const board = serving(request, token, fs);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
  await expect(rowAt(page, 'right', 'a.lha')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('pane-right-readonly')).toHaveText('Writing is off in Transfer.');
  await rowAt(page, 'right', 'c.txt').click();
  for (const cmd of ['delete', 'move', 'rename', 'makedir', 'protect']) {
    await expect(page.getByTestId(`files-${cmd}`)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(`files-${cmd}`)).toHaveAttribute('title', 'Writing is off in Transfer');
  }
  await expect(page.getByTestId('files-copy')).not.toHaveAttribute('aria-disabled', 'true');

  // Transfer 2.4 (protocol 3): it reads, and the buttons say what writes.
  await setBrowse(deviceId, { rxProto: 3, writeOn: false });
  await page.getByTestId('files-refresh').click();
  await expect(page.getByTestId('pane-right-readonly')).toHaveText('Transfer 2.5 or newer writes to the Amiga.', { timeout: LIVE });
  await rowAt(page, 'right', 'c.txt').click();
  await expect(page.getByTestId('files-delete')).toHaveAttribute('title', 'Transfer 2.5 or newer writes to the Amiga');
  // The board root says it too, under its volumes.
  await page.getByTestId('pane-right-up-row').click();
  await expect(page.getByTestId('net-browse-reason')).toHaveText('Transfer 2.5 or newer writes to the Amiga', { timeout: LIVE });
  await board.stop();
});

test('Makedir, Rename (its icon along), Protect and a comment reach the Amiga', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
  await expect(rowAt(page, 'right', 'a.lha')).toBeVisible({ timeout: LIVE });

  await page.getByTestId('files-makedir').click();
  await page.getByTestId('files-name-input').fill('New Drawer');
  await page.getByTestId('files-name-save').click();
  await expect(busy(page)).toContainText('Made Work:New Drawer', { timeout: LIVE });
  await expect(rowAt(page, 'right', 'New Drawer')).toBeVisible({ timeout: LIVE });
  expect(fs['Work:'].some((e) => e.name === 'New Drawer' && e.dir)).toBe(true);

  await rowAt(page, 'right', 'a.lha').click();
  await page.getByTestId('files-rename').click();
  await page.getByTestId('files-name-input').fill('b.lha');
  await page.getByTestId('files-name-save').click();
  await expect(busy(page)).toContainText('Renamed Work:a.lha to Work:b.lha', { timeout: LIVE });
  await expect(rowAt(page, 'right', 'b.lha')).toBeVisible({ timeout: LIVE });
  expect(fs['Work:'].map((e) => e.name)).toEqual(expect.arrayContaining(['b.lha', 'b.lha.info']));

  await rowAt(page, 'right', 'b.lha').click();
  await page.getByTestId('files-protect').click();
  await page.getByTestId('files-protect-bit-a').click();
  await page.getByTestId('files-protect-save').click();
  await expect(busy(page)).toContainText('Protected Work:b.lha', { timeout: LIVE });
  expect(fs['Work:'].find((e) => e.name === 'b.lha')!.protection).toBe(0x10);

  await rowAt(page, 'right', 'b.lha').click();
  await page.getByTestId('files-info').click();
  await page.getByTestId('files-info-comment').fill('from the web');
  await page.getByTestId('files-info-save').click();
  await expect(busy(page)).toContainText('Comment on Work:b.lha', { timeout: LIVE });
  expect(fs['Work:'].find((e) => e.name === 'b.lha')!.comment).toBe('from the web');
  expect(board.served.filter((r) => r.kind !== 'DIR' && r.kind !== 'VOLS').map((r) => r.kind))
    .toEqual(['MKDIR', 'RENAME', 'RENAME', 'PROTECT', 'NOTE']);
  await board.stop();
});

test('Delete asks first and cannot be undone; a big drawer counts up, then stops at a file in use', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
  await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });

  await rowAt(page, 'right', 'c.txt').click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-text')).toHaveText('Delete “c.txt” from the Amiga? This cannot be undone.');
  await page.getByTestId('files-delete-confirm').click();
  await expect(busy(page)).toContainText('Deleted Work:c.txt', { timeout: LIVE });
  await expect(rowAt(page, 'right', 'c.txt')).toHaveCount(0, { timeout: LIVE });

  fakeBoardTiming.delMs = 2_500;
  try {
    await rowAt(page, 'right', 'Big').click();
    await page.getByTestId('files-delete').click();
    await expect(page.getByTestId('files-delete-text')).toHaveText('Delete the drawer “Big” and everything in it from the Amiga? This cannot be undone.');
    await page.getByTestId('files-delete-confirm').click();
    await expect(busy(page)).toContainText('removed 50 so far', { timeout: LIVE });
    await expect(busy(page)).toContainText('Removed 100, then stopped at Big/f100: In use on the Amiga', { timeout: 30_000 });
  } finally { fakeBoardTiming.delMs = 0; }
  expect(fs['Work:Big'].map((e) => e.name)).toEqual(Array.from({ length: 20 }, (_, i) => `f${100 + i}`));
  await board.stop();
});

// A500 bench 2026-10-31: Workbench:WebTest/Many (597 entries, drawers inside, its icon beside it) took 89 s; Transfer
// said DEL every 100 and the server kept the count, yet the status row said only "Deleting … on Webfloppy1…".
test('a big drawer with drawers inside and its icon: the status row counts what Transfer has removed', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  fs['Work:'].push({ name: 'Many', dir: true }, { name: 'Many.info', data: Buffer.from('icon') });
  fs['Work:Many'] = [{ name: 'A', dir: true }, { name: 'B', dir: true }, { name: 'top.txt', data: Buffer.from('t') }];
  fs['Work:Many/A'] = Array.from({ length: 150 }, (_, i) => ({ name: `a${i}`, data: Buffer.from('a') }));
  fs['Work:Many/B'] = Array.from({ length: 150 }, (_, i) => ({ name: `b${i}`, data: Buffer.from('b') }));
  const board = serving(request, token, fs);
  // ~8 s a hundred: the whole delete outlasts the pane's 20 s give-up.
  Object.assign(fakeBoardTiming, { delEvery: 100, delBeforeMs: 8_000, delMs: 0 });
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
    await expect(rowAt(page, 'right', 'Many')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'right', 'Many').click();
    await page.getByTestId('files-delete').click();
    await page.getByTestId('files-delete-confirm').click();
    await expect(busy(page)).toContainText('Deleting Work:Many on A500…', { timeout: LIVE });
    await expect(busy(page)).toContainText('Deleting Work:Many on A500… removed 100 so far', { timeout: LIVE });
    // The drawer read again meanwhile waits for the delete, says how far it got, and is not given up on.
    await page.getByTestId('files-refresh').click();
    const pending = page.getByTestId('pane-right').getByTestId('pane-pending');
    await expect(pending).toHaveText(/^Reading Work: from A500 once it has deleted Many… removed [12]00 so far$/, { timeout: LIVE });
    await expect(pending).toHaveText('Reading Work: from A500 once it has deleted Many… removed 200 so far', { timeout: LIVE });
    await expect(busy(page)).toContainText('removed 200 so far');
    await expect(busy(page)).toContainText('Deleted Work:Many (304)', { timeout: 40_000 });
    await expect(rowAt(page, 'right', 'Many')).toHaveCount(0, { timeout: LIVE });
    await expect(page.getByText(/didn.t answer/)).toHaveCount(0);
  } finally { Object.assign(fakeBoardTiming, { delEvery: 50, delBeforeMs: 0, delMs: 0 }); await board.stop(); }
});

test('a refused Copy keeps what was picked, to try again', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const board = serving(request, token, amiga());
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await page.getByTestId('files-stash-input').setInputFiles([{ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') }]);
    await expect(rowAt(page, 'left', 'keep.txt')).toBeVisible({ timeout: LIVE });
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'left', 'keep.txt').click();
    await page.route('**/api/files/ops', (r) => r.fulfill({ status: 409, json: { error: 'conflict' } }), { times: 1 });
    const read = page.waitForResponse((r) => r.url().includes('/api/files/list') && decodeURIComponent(r.url()).includes('path=STASH:'), { timeout: LIVE });
    await page.getByTestId('files-copy').click();
    await read;
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({ timeout: LIVE });
    await expect(page.getByTestId('pane-left')).toContainText('1 of 1 selected', { timeout: LIVE });
  } finally { await board.stop(); }
});

test('Copy from STASH: onto a volume: each clash answer, and the queue line the board relays', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
  await page.getByTestId('files-stash-input').setInputFiles([
    { name: 'x.lha', mimeType: 'application/octet-stream', buffer: Buffer.from('new x') },
    { name: 'y.txt', mimeType: 'application/octet-stream', buffer: Buffer.from('why') },
  ]);
  await expect(rowAt(page, 'left', 'x.lha')).toBeVisible({ timeout: LIVE });
  await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });

  // No clash: copied, with the board's own path on the line.
  await rowAt(page, 'left', 'y.txt').click();
  await page.getByTestId('files-copy').click();
  await expect(busy(page)).toContainText('Copied 1 to A500', { timeout: LIVE });
  await expect(rowAt(page, 'right', 'y.txt')).toBeVisible({ timeout: LIVE });

  // A clash asks; Skip leaves the old file, Replace replaces it, Keep both keeps both.
  const copyX = async (answer: 'skip' | 'replace' | 'keep-both') => {
    await rowAt(page, 'left', 'x.lha').click();
    await page.getByTestId('files-copy').click();
    await expect(page.getByTestId('files-clash-text')).toBeVisible({ timeout: LIVE });
    await page.getByTestId(`files-clash-${answer}`).click();
  };
  await copyX('skip');
  // Skip sends nothing: the toast says so.
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Skipped 1/ })).toBeVisible({ timeout: LIVE });
  expect(fs['Work:Tools'].find((e) => e.name === 'x.lha')!.data!.toString()).toBe('old x');
  await copyX('replace');
  await expect(busy(page)).toContainText('Copied 1 to A500', { timeout: LIVE });
  await expect.poll(() => fs['Work:Tools'].find((e) => e.name === 'x.lha')!.data!.toString(), { timeout: LIVE }).toBe('new x');
  await copyX('keep-both');
  await expect(busy(page)).toContainText('Copied 1 to A500', { timeout: LIVE });
  await expect(rowAt(page, 'right', 'x_1.lha')).toBeVisible({ timeout: LIVE });
  // The fake board notes a file only after its done POST returns, which the page can see first: wait for the note.
  await expect.poll(() => board.queue.map((q) => `${q.dest} ${q.mode} ${q.outcome}`), { timeout: LIVE }).toEqual([
    'Work:Tools/y.txt keep delivered', 'Work:Tools/x.lha replace delivered', 'Work:Tools/x_1.lha keep delivered',
  ]);
  await board.stop();
});

// Plan 2026-11-01-net-consistency, item 14: a board the copy waits on goes offline -- the panel's card says so (and the panel asks
// every 15 s rather than every 2 s), then finishes once the board is back.
test('a copy onto a volume whose board goes offline says so, then finishes once it is back', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await page.getByTestId('files-stash-input').setInputFiles([{ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('late') }]);
    await expect(rowAt(page, 'left', 'late.txt')).toBeVisible({ timeout: LIVE });
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    fakeBoardTiming.queueHeld = true;
    await rowAt(page, 'left', 'late.txt').click();
    await page.getByTestId('files-copy').click();
    await expect(busy(page)).toContainText('0 of 1 file', { timeout: LIVE });
    await getDb().update(devices).set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }).where(eq(devices.id, deviceId));
    await expect(busy(page)).toContainText('Waiting for A500 (offline)', { timeout: LIVE });
    await setBrowse(deviceId);
    fakeBoardTiming.queueHeld = false;
    await expect(busy(page)).toContainText('Copied 1 to A500', { timeout: 40_000 });
    expect(fs['Work:Tools'].some((e) => e.name === 'late.txt')).toBe(true);
  } finally { fakeBoardTiming.queueHeld = false; await board.stop(); }
});

// Plan 2026-11-01-net-consistency, item 15: firmware and Transfer both carry a 0-byte FILE, so an empty file is copied.
test('an empty STASH: file copied onto a volume arrives there, empty', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await page.getByTestId('files-stash-input').setInputFiles([{ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }]);
    await expect(rowAt(page, 'left', 'empty.txt')).toBeVisible({ timeout: LIVE });
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'left', 'empty.txt').click();
    await page.getByTestId('files-copy').click();
    await expect(busy(page)).toContainText('Copied 1 to A500', { timeout: LIVE });
    expect(fs['Work:Tools'].find((e) => e.name === 'empty.txt')?.data?.length).toBe(0);
  } finally { await board.stop(); }
});

// A500 bench 2026-10-31: a STASH: drawer of 7 files copied onto Workbench:WebTest said only "Copying 3 of 7…" while the
// destination pane said "Nothing here." until a Refresh. The drawer arrives as a row with the copy's progress, without a
// Refresh, and once the copy is through the pane reads the drawer from the Amiga.
test('a STASH: drawer copied onto a drawer arrives there as a row with its progress, then as the Amiga lists it', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    // A STASH: drawer of two files (the zone drops into STASH: itself; the ops route moves them into the drawer).
    await page.getByTestId('files-stash-input').setInputFiles([
      { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
      { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
    ]);
    await expect(rowAt(page, 'left', 'two.txt')).toBeVisible({ timeout: LIVE });
    expect((await page.request.post('/api/files/ops', { data: { op: 'makedir', dest: 'STASH:', name: 'Pack' } })).ok()).toBe(true);
    expect((await page.request.post('/api/files/ops', { data: { op: 'move', sources: ['STASH:/one.txt', 'STASH:/two.txt'], dest: 'STASH:/Pack', onClash: 'ask' } })).ok()).toBe(true);
    await page.getByTestId('files-refresh').click();
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'left', 'Pack').click();
    await expect(rowAt(page, 'left', 'two.txt')).toHaveCount(0);
    fakeBoardTiming.queueHeld = true;
    await rowAt(page, 'left', 'Pack').click();
    await page.getByTestId('files-copy').click();
    await expect(busy(page)).toContainText('0 of 2 files', { timeout: LIVE });
    // No Refresh: the destination shows the drawer on its way.
    await expect(rowAt(page, 'right', 'Pack')).toContainText('Waiting', { timeout: LIVE });
    fakeBoardTiming.queueHeld = false;
    await expect(busy(page)).toContainText('Copied 2 to A500', { timeout: 30_000 });
    await expect.poll(() => (fs['Work:Tools/Pack'] ?? []).map((e) => e.name).sort(), { timeout: LIVE }).toEqual(['one.txt', 'two.txt']);
    // Through: the Amiga's own row (no progress mark) replaces it.
    await expect(rowAt(page, 'right', 'Pack')).toBeVisible({ timeout: LIVE });
    await expect(rowAt(page, 'right', 'Pack')).not.toContainText(/Waiting|Sending/, { timeout: LIVE });
  } finally { fakeBoardTiming.queueHeld = false; await board.stop(); }
});

test('Move a volume\'s file into STASH: (deleted on the Amiga once stored), and one from STASH: onto a volume', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
  await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });

  await rowAt(page, 'right', 'c.txt').click();
  await page.getByTestId('files-move').click();
  await expect(rowAt(page, 'left', 'c.txt')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => fs['Work:'].some((e) => e.name === 'c.txt'), { timeout: LIVE }).toBe(false);

  // Back onto the volume, into Tools: delivered there, then gone from STASH:.
  await rowAt(page, 'right', 'Tools').dblclick();
  await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
  await rowAt(page, 'left', 'c.txt').click();
  await page.getByTestId('files-move').click();
  await expect(busy(page)).toContainText('Copied 1 to A500', { timeout: 30_000 });
  await expect(rowAt(page, 'left', 'c.txt')).toHaveCount(0, { timeout: LIVE });
  expect(fs['Work:Tools'].some((e) => e.name === 'c.txt')).toBe(true);
  await board.stop();
});

// Plan 2026-11-01-vol-to-vol-staging: a copy between two volumes holds the file as internal staging, never as a STASH:
// row -- not while it goes up, not once stored, not after. A person's own STASH: file is the only row there throughout.
test('Copy between two volumes: STASH: open meanwhile shows nothing of it, at any point', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, deviceId, token } = await writable(page, request);
  const fs = amiga();
  fs[''].push({ name: 'Data', device: 'DH2:' });
  fs['Data:'] = [];
  await boardUploads(request, token, 'keep.txt', Buffer.from('keep'));
  let release: () => void = () => {};
  const held = new Promise<void>((reached) => {
    fakeBoardTiming.beforeClose = (r) => {
      if (r.path !== 'Work:c.txt') return Promise.resolve();
      reached();
      return new Promise<void>((go) => { release = go; });
    };
  });
  const board = serving(request, token, fs);
  const stash = await page.context().newPage();
  const stashRows = async () => (await listStash(getDb(), orgId)).map((r) => r.path).sort();
  try {
    await openFiles(page, `NET:/${deviceId}/Data`, `NET:/${deviceId}/Work`, 'right');
    await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'right', 'c.txt').click();
    await page.getByTestId('files-copy').click();
    await held;
    // Every byte is up, the close not sent: STASH: holds the person's file and nothing else.
    expect(await stashRows()).toEqual(['keep.txt']);
    await openFiles(stash, 'STASH:', 'STASH:', 'left');
    await expect(rowAt(stash, 'left', 'keep.txt')).toBeVisible({ timeout: LIVE });
    await expect(stash.getByTestId('pane-left').getByTestId('pane-row')).toHaveCount(1);
    release();
    await expect(busy(page)).toContainText('Copied 1', { timeout: 60_000 });
    expect(fs['Data:'].some((e) => e.name === 'c.txt')).toBe(true);
    expect(fs['Work:'].some((e) => e.name === 'c.txt')).toBe(true);
    expect(await stashRows()).toEqual(['keep.txt']);
    await stash.reload();
    await expect(rowAt(stash, 'left', 'keep.txt')).toBeVisible({ timeout: LIVE });
    await expect(stash.getByTestId('pane-left').getByTestId('pane-row')).toHaveCount(1);
  } finally { fakeBoardTiming.beforeClose = null; release(); await board.stop(); }
});

// Spec 2026-10-31 §9 (protocol 5): a Move removes only what it copied. A file saved into the source drawer while the
// move runs survives -- on the Amiga (DELETE … one per copied file, the drawer last: Transfer answers notempty) and in
// STASH: -- and the status row says what was kept. On Transfer 2.5 a Move off a volume is refused before anything moves.
test.describe('safe moves (protocol 5)', () => {
  test.afterEach(() => { fakeBoardTiming.onRequest = null; fakeBoardTiming.queueHeld = false; });
  const pack = (fs: Record<string, FakeEntry[]>, vol = 'Work') => {
    fs[`${vol}:`].push({ name: 'Pack', dir: true });
    fs[`${vol}:Pack`] = [{ name: 'one.txt', data: Buffer.from('one') }, { name: 'two.txt', data: Buffer.from('two') }];
  };
  /** On the first GET the fake Transfer serves, someone saves new.txt into Work:Pack on the Amiga. */
  const saveIntoPackMidMove = (fs: Record<string, FakeEntry[]>) => {
    fakeBoardTiming.onRequest = (r) => {
      if (r.kind === 'GET' && !fs['Work:Pack'].some((e) => e.name === 'new.txt')) fs['Work:Pack'].push({ name: 'new.txt', data: Buffer.from('new') });
    };
  };
  const deletes = (served: BoardRequest[]) => served.filter((r) => r.kind === 'DELETE').map((r) => `${r.path}${r.one ? ' one' : ''}`);

  test('a drawer moved from a volume into STASH:: a file saved into it meanwhile stays on the Amiga, and the row says so', async ({ page, request }) => {
    test.setTimeout(150_000);
    const { orgId, deviceId, token } = await writable(page, request);
    const fs = amiga(); pack(fs);
    const board = serving(request, token, fs);
    try {
      await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
      await expect(rowAt(page, 'right', 'Pack')).toBeVisible({ timeout: LIVE });
      saveIntoPackMidMove(fs);
      await rowAt(page, 'right', 'Pack').click();
      await page.getByTestId('files-move').click();
      await expect(busy(page)).toContainText('Kept Work:Pack: something new is in it', { timeout: 60_000 });
      expect(fs['Work:Pack'].map((e) => e.name)).toEqual(['new.txt']);
      expect((await listStash(getDb(), orgId)).map((r) => r.path).sort()).toEqual(['Pack/one.txt', 'Pack/two.txt']);
      expect(deletes(board.served)).toEqual(['Work:Pack/one.txt one', 'Work:Pack/two.txt one', 'Work:Pack one']);
      expect(fs['Work:'].some((e) => e.name === 'a.lha.info')).toBe(true);
    } finally { await board.stop(); }
  });

  test('a drawer moved between two volumes: a file saved into it meanwhile stays where it was', async ({ page, request }) => {
    test.setTimeout(150_000);
    const { deviceId, token } = await writable(page, request);
    const fs = amiga(); pack(fs);
    fs[''].push({ name: 'Data', device: 'DH2:' });
    fs['Data:'] = [];
    const board = serving(request, token, fs);
    try {
      await openFiles(page, `NET:/${deviceId}/Data`, `NET:/${deviceId}/Work`, 'right');
      await expect(rowAt(page, 'right', 'Pack')).toBeVisible({ timeout: LIVE });
      saveIntoPackMidMove(fs);
      await rowAt(page, 'right', 'Pack').click();
      await page.getByTestId('files-move').click();
      await expect(busy(page)).toContainText('Kept Work:Pack: something new is in it', { timeout: 90_000 });
      expect((fs['Data:Pack'] ?? []).map((e) => e.name).sort()).toEqual(['one.txt', 'two.txt']);
      expect(fs['Work:Pack'].map((e) => e.name)).toEqual(['new.txt']);
    } finally { await board.stop(); }
  });

  test('a STASH: drawer moved onto a volume: a file put into it meanwhile stays in STASH:, and the row says so', async ({ page, request }) => {
    test.setTimeout(150_000);
    const { orgId, deviceId, token } = await writable(page, request);
    const fs = amiga();
    const board = serving(request, token, fs);
    try {
      await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
      await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
      await page.getByTestId('files-stash-input').setInputFiles([
        { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
        { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
      ]);
      await expect(rowAt(page, 'left', 'two.txt')).toBeVisible({ timeout: LIVE });
      expect((await page.request.post('/api/files/ops', { data: { op: 'makedir', dest: 'STASH:', name: 'Pack' } })).ok()).toBe(true);
      expect((await page.request.post('/api/files/ops', { data: { op: 'move', sources: ['STASH:/one.txt', 'STASH:/two.txt'], dest: 'STASH:/Pack', onClash: 'ask' } })).ok()).toBe(true);
      await page.getByTestId('files-refresh').click();
      await expect(rowAt(page, 'left', 'Pack')).toBeVisible({ timeout: LIVE });
      fakeBoardTiming.queueHeld = true;
      await rowAt(page, 'left', 'Pack').click();
      await page.getByTestId('files-move').click();
      await expect(busy(page)).toContainText('0 of 2 files', { timeout: LIVE });
      // Meanwhile a file goes into the drawer being moved.
      await page.getByTestId('files-stash-input').setInputFiles([{ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('new') }]);
      await expect.poll(async () => (await listStash(getDb(), orgId)).some((r) => r.path === 'new.txt'), { timeout: LIVE }).toBe(true);
      expect((await page.request.post('/api/files/ops', { data: { op: 'move', sources: ['STASH:/new.txt'], dest: 'STASH:/Pack', onClash: 'ask' } })).ok()).toBe(true);
      fakeBoardTiming.queueHeld = false;
      await expect(busy(page)).toContainText('Kept STASH:/Pack: something new is in it', { timeout: 60_000 });
      expect((await listStash(getDb(), orgId)).map((r) => r.path).filter((p) => p.startsWith('Pack/'))).toEqual(['Pack/new.txt']);
      expect((fs['Work:Tools/Pack'] ?? []).map((e) => e.name).sort()).toEqual(['one.txt', 'two.txt']);
    } finally { await board.stop(); }
  });

  test('Transfer 2.5 (protocol 4): a Move off a volume is refused with the words, nothing is deleted; Copy works', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { deviceId, token } = await writable(page, request);
    await setBrowse(deviceId, { rxProto: 4 });
    const fs = amiga();
    const board = serving(request, token, fs);
    try {
      await openFiles(page, 'STASH:', `NET:/${deviceId}/Work`, 'right');
      await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });
      await rowAt(page, 'right', 'c.txt').click();
      await page.getByTestId('files-move').click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Move needs Transfer 2.6 — use Copy.' })).toBeVisible({ timeout: LIVE });
      await rowAt(page, 'right', 'c.txt').click();
      await page.getByTestId('files-copy').click();
      await expect(rowAt(page, 'left', 'c.txt')).toBeVisible({ timeout: 30_000 });
      expect(fs['Work:'].some((e) => e.name === 'c.txt')).toBe(true);
      expect(board.served.filter((r) => r.kind === 'DELETE')).toEqual([]);
    } finally { await board.stop(); }
  });
});
