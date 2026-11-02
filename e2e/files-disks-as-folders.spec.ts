import { test, expect, type Locator, type Page } from '@playwright/test';
import { fakeBoardTiming, type FakeEntry } from './amiga-board';
import { cleanupSeeded } from './device-helpers';
import { cards, LIVE, queuedPerDest, rowAt, seedTitle, serving, writable } from './files-disks-helpers';
import { OTHER_PANE_OPENING } from '@/lib/files/pane-rules';
import { DISKS_ONTO_VOLUME, DISKS_STAY_IN_LIBRARY } from '@/lib/files/shelf-rules';

/**
 * Big copies part 2 (spec 2026-11-02): DSK and TTL rows copied onto a NET: volume arrive as a drawer per disk. The
 * operator's own case first: a drawer made in Files, then the disks copied into it. The fake board answers as firmware
 * 1.23 with Transfer on protocol 5. The phone is files-disks-as-folders.mobile.spec.ts.
 */

test.use({ viewport: { width: 1280, height: 800 } });
test.afterAll(cleanupSeeded);

const FOUR = ['Disk 1', 'Disk 2', 'Disk 3', 'Disk 4'];
const inDisk = ['C', 'Disk.info', 'Empty', 'ReadMe'];
const names = (fs: Record<string, FakeEntry[]>, at: string) => (fs[at] ?? []).map((e) => e.name).sort();
/** A drawer's rows after the copy: every file and drawer of the disk. */
const arrivedWhole = (fs: Record<string, FakeEntry[]>, at: string) => {
  expect(names(fs, at)).toEqual(inDisk);
  expect(names(fs, `${at}/C`)).toEqual(['Assign']);
  expect(names(fs, `${at}/Empty`)).toEqual([]);
};

function amiga(): Record<string, FakeEntry[]> {
  return { '': [{ name: 'Work', device: 'DH1:' }], 'Work:': [{ name: 'c.txt', data: Buffer.from('see') }] };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

/** A real HTML5 drag with the mouse (files-2.spec.ts): Shift is pressed once it is under way. */
async function dragRows(page: Page, source: Locator, target: Locator, { shift = false } = {}) {
  await page.getByTestId('files-manager').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const s = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(s.x + 40, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 60, s.y + s.height / 2, { steps: 4 });
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(t.x + 40, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

test('four disks in Monkey: two DSK rows copied into a drawer made here arrive as Disk 1 and Disk 2, one card', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, deviceId, token } = await writable(page, request);
  const { gameId } = await seedTitle(orgId, 'Monkey Island', FOUR);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, `LIBRARY:/${gameId}`, `NET:/${deviceId}/Work`, 'right');
    await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });
    await page.getByTestId('files-makedir').click();
    await page.getByTestId('files-name-input').fill('Monkey');
    await page.getByTestId('files-name-save').click();
    await expect(rowAt(page, 'right', 'Monkey')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'right', 'Monkey').dblclick();
    await expect(page.getByTestId('pane-right')).toContainText('Work:Monkey', { timeout: LIVE });

    // Held, so what arrives is seen on its way, without a Refresh.
    fakeBoardTiming.queueHeld = true;
    await rowAt(page, 'left', 'Disk 1').click();
    await rowAt(page, 'left', 'Disk 2').click({ modifiers: ['ControlOrMeta'] });
    await expect(rowAt(page, 'left', 'Disk 2')).toHaveAttribute('aria-selected', 'true');
    // Copy waits for the drawer's own listing (the test below), then aims there.
    await expect(page.getByTestId('files-copy')).not.toHaveAttribute('aria-disabled', 'true', { timeout: LIVE });
    const before = await cards(page).count();
    await page.getByTestId('files-copy').click();
    // From the click: the drawer read fresh, the disks decoded and stored, the pane read again.
    await expect(rowAt(page, 'right', 'Disk 1')).toBeVisible({ timeout: 45_000 });
    await expect(rowAt(page, 'right', 'Disk 2')).toBeVisible({ timeout: LIVE });
    await expect(rowAt(page, 'right', 'Disk 1')).toContainText('Waiting');
    await expect(cards(page)).toHaveCount(before + 1, { timeout: LIVE });
    await expect(cards(page).first()).toContainText('0 of 6 files', { timeout: LIVE });

    fakeBoardTiming.queueHeld = false;
    await expect(cards(page).first()).toContainText('Copied 6 to A500', { timeout: 60_000 });
    await expect(cards(page)).toHaveCount(before + 1);
    arrivedWhole(fs, 'Work:Monkey/Disk 1');
    arrivedWhole(fs, 'Work:Monkey/Disk 2');
    // Only the two picked, each its own drawer.
    expect(names(fs, 'Work:Monkey')).toEqual(['Disk 1', 'Disk 2']);
    await expect(rowAt(page, 'left', 'Disk 1')).toBeVisible();   // the library keeps them
  } finally { fakeBoardTiming.queueHeld = false; await board.stop(); }
});

// A500 flow, review of Task 3: a drawer is entered and Copy pressed before the Amiga has answered. The pane's title names
// the drawer while its listing is still the parent, and the disks went to the parent.
test('a drawer still being read: Copy and a drop on the pane wait, then the disks go into that drawer, not its parent', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, deviceId, token } = await writable(page, request);
  const { gameId } = await seedTitle(orgId, 'Monkey Island', ['Disk 1', 'Disk 2']);
  const fs = amiga();
  fs['Work:'].push({ name: 'Monkey', dir: true });
  fs['Work:Monkey'] = [];
  let board = serving(request, token, fs);
  try {
    await openFiles(page, `LIBRARY:/${gameId}`, `NET:/${deviceId}/Work`, 'right');
    await expect(rowAt(page, 'right', 'Monkey')).toBeVisible({ timeout: LIVE });
    // No board now: the read of a drawer never read before waits for it.
    await board.stop();
    await rowAt(page, 'right', 'Monkey').dblclick();
    await expect(page.getByTestId('pane-right')).toContainText('Work:Monkey', { timeout: LIVE });
    await expect(rowAt(page, 'right', 'c.txt')).toBeVisible();   // the parent's rows, still shown
    await rowAt(page, 'left', 'Disk 1').click();
    const copy = page.getByTestId('files-copy');
    await expect(copy).toHaveAttribute('aria-disabled', 'true');
    await expect(copy).toHaveAttribute('title', OTHER_PANE_OPENING);
    await dragRows(page, rowAt(page, 'left', 'Disk 1'), rowAt(page, 'right', 'c.txt'));
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: OTHER_PANE_OPENING })).toBeVisible({ timeout: LIVE });
    expect(await queuedPerDest(orgId, deviceId)).toEqual({});

    board = serving(request, token, fs);
    await expect(copy).not.toHaveAttribute('aria-disabled', 'true', { timeout: LIVE });
    await copy.click();
    await expect(cards(page).first()).toContainText('Work:Monkey', { timeout: 45_000 });
    await expect(cards(page).first()).toContainText('Copied 3 to A500', { timeout: 60_000 });
    const dests = Object.keys(await queuedPerDest(orgId, deviceId)).sort();
    expect(dests).toEqual(['C/Assign', 'Disk.info', 'ReadMe'].map((f) => `Work:Monkey/Disk 1/${f}`));
    expect(names(fs, 'Work:')).toEqual(['Monkey', 'c.txt']);
  } finally { await board.stop(); }
});

test('Copy from a TTL row: each disk straight into the destination; Move says the disks stay, on TTL and DSK rows', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, deviceId, token } = await writable(page, request);
  const { gameId } = await seedTitle(orgId, 'Monkey Island', ['Disk 1', 'Disk 2']);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'LIBRARY:', `NET:/${deviceId}/Work`, 'left');
    await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'left', 'Monkey Island').click();
    await expect(page.getByTestId('files-move')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('files-move')).toHaveAttribute('title', DISKS_STAY_IN_LIBRARY);
    await page.getByTestId('files-copy').click();
    await expect(cards(page).first()).toContainText('Copied 6 to A500', { timeout: 60_000 });
    arrivedWhole(fs, 'Work:Disk 1');
    arrivedWhole(fs, 'Work:Disk 2');
    // No title drawer, and nothing else on the volume.
    expect(names(fs, 'Work:')).toEqual(['Disk 1', 'Disk 2', 'c.txt']);

    await page.goto(`/files?${new URLSearchParams({ left: `LIBRARY:/${gameId}`, right: `NET:/${deviceId}/Work`, active: 'left' })}`);
    await expect(rowAt(page, 'left', 'Disk 1')).toBeVisible({ timeout: LIVE });
    await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'left', 'Disk 1').click();
    await expect(page.getByTestId('files-move')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('files-move')).toHaveAttribute('title', DISKS_STAY_IN_LIBRARY);
    await expect(page.getByTestId('files-copy')).not.toHaveAttribute('aria-disabled', 'true');

    // With a non-volume opposite, Copy says where disks go and Move still says they stay.
    await openFiles(page, `LIBRARY:/${gameId}`, 'STASH:', 'left');
    await rowAt(page, 'left', 'Disk 1').click();
    await expect(page.getByTestId('files-copy')).toHaveAttribute('title', DISKS_ONTO_VOLUME);
    await expect(page.getByTestId('files-move')).toHaveAttribute('title', DISKS_STAY_IN_LIBRARY);
  } finally { await board.stop(); }
});

test('a DSK row dragged onto a volume copies it; with Shift it says the disks stay; onto STASH: it says where they go', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, deviceId, token } = await writable(page, request);
  const { gameId } = await seedTitle(orgId, 'Monkey Island', ['Disk 1', 'Disk 2']);
  const fs = amiga();
  const board = serving(request, token, fs);
  const toast = (text: string) => page.locator('[data-sonner-toast]').filter({ hasText: text });
  try {
    await openFiles(page, `LIBRARY:/${gameId}`, `NET:/${deviceId}/Work`, 'left');
    await expect(rowAt(page, 'right', 'c.txt')).toBeVisible({ timeout: LIVE });
    await expect(rowAt(page, 'left', 'Disk 1')).toHaveAttribute('draggable', 'true');

    await dragRows(page, rowAt(page, 'left', 'Disk 2'), rowAt(page, 'right', 'c.txt'), { shift: true });
    await expect(toast(DISKS_STAY_IN_LIBRARY)).toBeVisible({ timeout: LIVE });
    expect(await queuedPerDest(orgId, deviceId)).toEqual({});

    await dragRows(page, rowAt(page, 'left', 'Disk 1'), rowAt(page, 'right', 'c.txt'));
    await expect(cards(page).first()).toContainText('Copied 3 to A500', { timeout: 60_000 });
    arrivedWhole(fs, 'Work:Disk 1');
    expect(names(fs, 'Work:')).toEqual(['Disk 1', 'c.txt']);

    await openFiles(page, `LIBRARY:/${gameId}`, 'STASH:', 'left');
    await expect(rowAt(page, 'left', 'Disk 2')).toBeVisible({ timeout: LIVE });
    await dragRows(page, rowAt(page, 'left', 'Disk 2'), page.getByTestId('pane-right'));
    await expect(toast(DISKS_ONTO_VOLUME)).toBeVisible({ timeout: LIVE });
  } finally { await board.stop(); }
});

test('a clash on one of a title\'s disks: Skip on one and Replace on another hold per disk, and a refused disk is named', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, deviceId, token } = await writable(page, request);
  const { diskIds } = await seedTitle(orgId, 'Monkey Island', ['Disk 1', 'Disk 2', 'Disk 3', 'Bad:Label']);
  const fs = amiga();
  fs['Work:'].push({ name: 'Monkey', dir: true });
  fs['Work:Monkey'] = [{ name: 'Disk 1', dir: true }, { name: 'Disk 2', dir: true }];
  fs['Work:Monkey/Disk 1'] = [{ name: 'ReadMe', data: Buffer.from('old one') }];
  fs['Work:Monkey/Disk 2'] = [{ name: 'ReadMe', data: Buffer.from('old two') }, { name: 'keep.txt', data: Buffer.from('mine') }];
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'LIBRARY:', `NET:/${deviceId}/Work/Monkey`, 'left');
    await expect(rowAt(page, 'right', 'Disk 1')).toBeVisible({ timeout: LIVE });
    await rowAt(page, 'left', 'Monkey Island').click();
    await page.getByTestId('files-copy').click();

    await expect(page.getByTestId('files-clash-text')).toContainText('Disk 1', { timeout: LIVE });
    await page.getByTestId('files-clash-skip').click();
    await expect(page.getByTestId('files-clash-text')).toContainText('Disk 2', { timeout: LIVE });
    await page.getByTestId('files-clash-replace').click();

    // The refused disk by its name, never its id.
    const failures = page.getByTestId('files-failures');
    await expect(failures).toContainText('Bad:Label', { timeout: 30_000 });
    const line = (await failures.textContent())!;
    for (const id of diskIds) expect(line).not.toContain(id);
    expect(line).not.toMatch(/disk_|[0-9a-f]{8}-[0-9a-f]{4}/);

    await expect(cards(page).first()).toContainText('Copied', { timeout: 60_000 });
    const queued = await queuedPerDest(orgId, deviceId);
    // Nothing under the skipped drawer; every file of the others queued exactly once.
    expect(Object.keys(queued).filter((d) => d.startsWith('Work:Monkey/Disk 1/'))).toEqual([]);
    expect(queued).toEqual(Object.fromEntries(['Disk 2', 'Disk 3'].flatMap((d) =>
      ['C/Assign', 'Disk.info', 'ReadMe'].map((f) => [`Work:Monkey/${d}/${f}`, 1]))));
    // Skip left the old file; Replace overwrote its name and left the others in the folder; the new disk came whole.
    expect(names(fs, 'Work:Monkey/Disk 1')).toEqual(['ReadMe']);
    expect(fs['Work:Monkey/Disk 1'][0].data!.toString()).toBe('old one');
    expect(fs['Work:Monkey/Disk 2'].find((e) => e.name === 'ReadMe')!.data!.toString()).toContain('read me, Disk 2');
    expect(names(fs, 'Work:Monkey/Disk 2')).toEqual([...inDisk, 'keep.txt'].sort());
    arrivedWhole(fs, 'Work:Monkey/Disk 3');
    expect(names(fs, 'Work:Monkey')).toEqual(['Disk 1', 'Disk 2', 'Disk 3']);
  } finally { await board.stop(); }
});
