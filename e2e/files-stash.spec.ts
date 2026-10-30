import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { disks } from '@/db/schema/catalog';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch, type BatchOp } from '@/lib/adffs/write';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';
import { boardSays, boardUploads } from './amiga-board';

/**
 * Files increment 2, Task 8: files from the computer into STASH: -- the top drop zone ("Drop files into STASH:":
 * a drop, Browse files, Paste URL) and a drop on a STASH: pane's folder. Every landing is checked on the stored rows
 * and bytes as well as on the pane.
 *
 * Task 9: STASH: with a disk beside it -- copies both ways keep the comment, an archive opens read-only and a file
 * copies out with its date, a file from the Amiga names its board, Add to library, Makedir/Rename/Delete, and the
 * desktop layout's geometry with the drop zone above the manager. Files… opening STASH: | the disk is
 * files-strip.spec.ts's first test and is not repeated.
 */

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function openStash(page: Page, left = 'STASH:') {
  await page.goto(`/files?${new URLSearchParams({ left, right: 'LIBRARY:', active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

const row = (page: Page, name: string) => page.getByTestId('pane-left').locator(`[data-testid="pane-row"][data-name="${name}"]`);
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

/** The org's live STASH: rows, path → kind, size and blob. */
async function stashRows(orgId: string) {
  const rows = await getDb().select().from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')));
  return Object.fromEntries(rows.map((r) => [r.path, { kind: r.kind, size: r.sizeBytes, sha: r.blobSha256, source: r.source }]));
}

test('a drop on the zone stores files, a folder and an empty file in STASH:; a clash asks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openStash(page);
  const zone = page.getByTestId('files-drop-stash');
  await expect(zone).toContainText('Drop files into STASH:');

  await synthDrop(page, [
    { name: 'notes.txt', kind: 'file', content: 'hello from the computer' },
    { name: 'README', kind: 'file', content: '' },
    { name: 'Mods', kind: 'dir', children: [
      { name: 'enigma.mod', kind: 'file', content: 'not really a module' },
      { name: 'Empty', kind: 'dir' },
    ] },
  ], '[data-testid="files-drop-stash"]');
  await expect(toast(page, 'Added 3 items to STASH:')).toBeVisible();
  await expect(row(page, 'notes.txt')).toBeVisible();
  await expect(row(page, 'README')).toBeVisible();
  await expect(row(page, 'Mods')).toBeVisible();

  const rows = await stashRows(orgId);
  expect(rows['notes.txt']).toMatchObject({ kind: 'file', size: 23, sha: sha('hello from the computer'), source: 'browser' });
  expect(rows['README']).toMatchObject({ kind: 'file', size: 0, sha: sha('') });
  expect(rows['Mods/enigma.mod']).toMatchObject({ kind: 'file', sha: sha('not really a module') });
  expect(rows['Mods/Empty']).toMatchObject({ kind: 'dir' });
  expect(new TextDecoder().decode(await diskStore.read(sha('hello from the computer')))).toBe('hello from the computer');

  // ReadMe is README to an Amiga: the Clash dialog asks before anything goes up; Keep both stores it as ReadMe_1.
  await synthDrop(page, [{ name: 'ReadMe', kind: 'file', content: 'second' }], '[data-testid="files-drop-stash"]');
  const clash = page.getByTestId('files-clash-dialog');
  await expect(clash.getByTestId('files-clash-text')).toContainText('ReadMe');
  await clash.getByTestId('files-clash-keep-both').click();
  await expect(toast(page, 'Added 1 item to STASH:')).toBeVisible();
  await expect(page.getByTestId('files-stash-report')).toContainText('ReadMe stored as ReadMe_1');
  await expect(row(page, 'ReadMe_1')).toBeVisible();
  expect((await stashRows(orgId))['ReadMe_1']).toMatchObject({ size: 6, sha: sha('second') });

  // Browse files: the same path, into the STASH: root.
  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'picked.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('picked') }]);
  await expect(row(page, 'picked.bin')).toBeVisible();
  expect((await stashRows(orgId))['picked.bin']).toMatchObject({ size: 6, sha: sha('picked') });
});

test('a drop on a STASH: pane lands in the folder it was dropped on', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openStash(page);
  await synthDrop(page, [{ name: 'Mods', kind: 'dir', children: [{ name: 'a.mod', kind: 'file', content: 'a' }] }],
    '[data-testid="files-drop-stash"]');
  await expect(row(page, 'Mods')).toBeVisible();

  // Onto the Mods row: into Mods.
  await synthDrop(page, [{ name: 'b.mod', kind: 'file', content: 'bb' }], '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Mods"]');
  await expect(toast(page, 'Added 1 item to STASH:/Mods')).toBeVisible();
  // Onto the pane itself: into the folder it shows.
  await synthDrop(page, [{ name: 'Docs', kind: 'dir', children: [{ name: 'c.txt', kind: 'file', content: 'ccc' }] }], '[data-testid="pane-left"]');
  await expect(row(page, 'Docs')).toBeVisible();

  await expect.poll(async () => Object.keys(await stashRows(orgId)).sort())
    .toEqual(['Docs', 'Docs/c.txt', 'Mods', 'Mods/a.mod', 'Mods/b.mod']);
  await row(page, 'Mods').dblclick();
  await expect(row(page, 'b.mod')).toBeVisible();
});

test('the zone refuses a folder of more than 200 items, and a URL on a private address, in words', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openStash(page);

  await synthDrop(page, [
    { name: 'Huge', kind: 'dir', children: Array.from({ length: 200 }, (_, i) => ({ name: `f${i}`, kind: 'file' as const, content: '' })) },
  ], '[data-testid="files-drop-stash"]');
  await expect(toast(page, 'Nothing was added.')).toBeVisible();
  await expect(page.getByTestId('files-stash-report')).toContainText('Huge: Drop folders of up to 200 items at a time');
  expect(await stashRows(orgId)).toEqual({});

  await page.getByTestId('files-stash-url-input').fill('http://127.0.0.1/secret.lha');
  await page.getByTestId('files-stash-url-fetch').click();
  await expect(page.getByTestId('files-stash-url-status'))
    .toHaveText('That address points to a private or local network, which is not fetched.');
  expect(await stashRows(orgId)).toEqual({});
});

// ---- Task 9 -----------------------------------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);

/** ReadMe, the folder S, and C/Assign with a comment (files.spec.ts's shape, plus the comment a copy must keep). */
const STANDARD: BatchOp[] = [
  { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') },
  { op: 'mkdir', parentPath: '', name: 'S' },
  { op: 'mkdir', parentPath: '', name: 'C' },
  { op: 'add', parentPath: 'C', name: 'Assign', bytes: enc('assign stub'), comment: 'assigns a logical device' },
];

/** A real FFS disk built from `ops`, stored, and seeded as a one-disk title of this org. */
async function seedTitle(orgId: string, title: string, ops: BatchOp[] = STANDARD) {
  const r = applyBatch(ops)(formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 24) }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const seeded = await seedDisk(orgId, { title, diskNo: 1, sha256, sizeBytes: r.adf.length, writeProtected: false });
  return { ...seeded, sha256, path: `LIBRARY:/${seeded.gameId}/${seeded.diskId}` };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

async function storedRoot(diskId: string): Promise<AdfEntry[]> {
  const [d] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  const vol = readVolume(await diskStore.read(d.sha256));
  if (!vol.ok) throw new Error('no volume');
  return vol.root;
}
function at(list: AdfEntry[], path: string): AdfEntry | null {
  const [head, ...rest] = path.split('/');
  const e = list.find((x) => x.name === head) ?? null;
  return e && rest.length ? at(e.children, rest.join('/')) : e;
}

/** Browse files in the drop zone: the files go into the STASH: root. */
async function browse(page: Page, files: { name: string; buffer: Buffer }[]) {
  await page.getByTestId('files-stash-input').setInputFiles(files.map((f) => ({ ...f, mimeType: 'application/octet-stream' })));
}

test('the bank sits under both panes; at 1280 x 800 its last row is on screen (R9)', async ({ page }) => {
  await signUpFresh(page);
  for (const [width, height] of [[1024, 800], [1280, 800], [1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await openStash(page);
    // At 1280 x 800 the grid's last row and the status row are on screen as the page opens, panes at least 300 px
    // tall (controller ruling, Task 8 round 1); from 1440 x 900 up the whole manager is.
    if (width === 1280 && height === 800) {
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const del = (await page.getByTestId('files-delete').boundingBox())!;
      const busy = (await page.getByTestId('files-busy').boundingBox())!;
      const pane = (await page.getByTestId('pane-left').boundingBox())!;
      expect(del.y + del.height, `${width} x ${height}: the grid's last row, unscrolled`).toBeLessThanOrEqual(height);
      expect(busy.y + busy.height, `${width} x ${height}: the status row, unscrolled`).toBeLessThanOrEqual(height);
      expect(pane.height, `${width} x ${height}: the pane, unscrolled`).toBeGreaterThanOrEqual(300);
    }
    if (width >= 1440) {
      const bottom = await page.evaluate(() => window.scrollY + document.querySelector('[data-testid="files-busy"]')!.getBoundingClientRect().bottom);
      expect(bottom, `${width} x ${height}: the whole manager`).toBeLessThanOrEqual(height);
    }
    await page.getByTestId('files-manager').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const g = await page.evaluate(() => {
      const box = (el: Element) => el.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('[data-testid="files-grid"] button')];
      return {
        bank: box(document.querySelector('[data-testid="files-bank"]')!),
        busy: box(document.querySelector('[data-testid="files-busy"]')!),
        left: box(document.querySelector('[data-testid="pane-left"]')!), right: box(document.querySelector('[data-testid="pane-right"]')!),
        overflowing: buttons.filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.getAttribute('data-testid')),
        cols: new Set(buttons.map((b) => Math.round(box(b).left))).size,
        lowest: Math.max(...buttons.map((b) => box(b).bottom)),
      };
    });
    const at = `${width} x ${height}`;
    expect(g.bank.top, `${at}: the bank under the panes`).toBeGreaterThanOrEqual(Math.max(g.left.bottom, g.right.bottom) - 1);
    expect(g.busy.top, `${at}: the status row under the bank`).toBeGreaterThanOrEqual(g.bank.bottom - 1);
    expect(g.lowest, `${at}: the grid inside the bank`).toBeLessThanOrEqual(g.bank.bottom);
    expect(g.cols, `${at}: six columns`).toBe(6);
    expect(g.overflowing, `${at}: a label wider than its cell`).toEqual([]);
    expect(g.left.height, `${at}: the pane's height`).toBeGreaterThanOrEqual(300);
    if (width === 1280 && height === 800) expect(g.bank.bottom, `${at}: the bank's last row`).toBeLessThanOrEqual(height);
    // 1366 x 768: the page may scroll, but the grid's last row is reachable and on screen once it has.
    if (width === 1366 && height === 768) {
      await page.getByTestId('files-delete').scrollIntoViewIfNeeded();
      const del = await page.getByTestId('files-delete').boundingBox();
      expect(del!.y + del!.height, `${at}: the grid's last row`).toBeLessThanOrEqual(height);
    }
  }
});

test('copy STASH: → disk and back keeps the comment', async ({ page }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const d = await seedTitle(orgId, `StashCopy-${runTag()}`);
  await openFiles(page, 'STASH:', d.path, 'left');
  await browse(page, [{ name: 'a.txt', buffer: Buffer.from('aaa') }]);
  await expect(rowAt(page, 'left', 'a.txt')).toBeVisible();

  // Info on a.txt in STASH: sets its comment.
  await rowAt(page, 'left', 'a.txt').click();
  await page.getByTestId('files-info').click();
  const info = page.getByTestId('files-info-dialog');
  await info.getByTestId('files-info-comment').fill('bench');
  await info.getByTestId('files-info-save').click();
  await expect(info).toHaveCount(0, { timeout: 15_000 });
  await expect(rowAt(page, 'left', 'a.txt')).toContainText('bench');   // STASH: shows the Comment column

  // Copy into the disk (STASH: is the source): the comment goes with it.
  await rowAt(page, 'left', 'a.txt').click();
  await expect(page.getByTestId('files-copy')).toHaveText('Copy');
  await expect(page.getByTestId('pane-left-title')).toHaveAttribute('data-role', 'source');
  await page.getByTestId('files-copy').click();
  await expect(toast(page, /^Copied 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await rowAt(page, 'right', 'a.txt').dblclick();
  await expect(page.getByTestId('files-info-comment')).toHaveValue('bench');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('files-info-dialog')).toHaveCount(0);
  expect(at(await storedRoot(d.diskId), 'a.txt')!.comment).toBe('bench');

  // Copy the folder C from the disk (now the source) into STASH:: Assign keeps its comment there.
  await rowAt(page, 'right', 'C').click();
  await expect(page.getByTestId('files-copy')).toHaveText('Copy');
  await expect(page.getByTestId('pane-right-title')).toHaveAttribute('data-role', 'source');
  await page.getByTestId('files-copy').click();
  await expect(toast(page, /^Copied 1 item to STASH:/)).toBeVisible({ timeout: 15_000 });
  await rowAt(page, 'left', 'C').dblclick();
  await expect(rowAt(page, 'left', 'Assign')).toContainText('assigns a logical device');
  const rows = await getDb().select().from(amigaUploads).where(and(eq(amigaUploads.orgId, orgId), eq(amigaUploads.path, 'C/Assign')));
  expect(rows.map((r) => [r.comment, r.source])).toEqual([['assigns a logical device', 'copy']]);
});

test('an archive opens read-only and a file copies out of it with its date', async ({ page }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const d = await seedTitle(orgId, `StashZip-${runTag()}`, []);
  await openFiles(page, 'STASH:', d.path, 'left');
  await browse(page, [{ name: 't.zip', buffer: readFileSync('src/lib/archive/fixtures/t.zip') }]);
  await expect(rowAt(page, 'left', 't.zip')).toHaveAttribute('data-kind', 'archive');

  await rowAt(page, 'left', 't.zip').dblclick();
  await expect(page.getByTestId('pane-left-readonly')).toHaveText('Archives are read-only — copy files out of them.');
  await rowAt(page, 'left', 'src').dblclick();
  await rowAt(page, 'left', 'readme.txt').click();
  await expect(page.getByTestId('files-delete')).toBeDisabled();       // nothing in an archive changes
  await page.getByTestId('files-copy').click();
  await expect(toast(page, /^Copied 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  // The member's date travels (R10): the zip says 2026-09-11.
  await expect(rowAt(page, 'right', 'readme.txt').locator('td:nth-child(5)')).toHaveText('2026-09-11');
  expect(at(await storedRoot(d.diskId), 'readme.txt')!.sizeBytes).toBe(135);
});

test('a file from the Amiga lands in STASH: with its board', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await boardUploads(request, token, 'Up/hi.txt', Buffer.from('hi'));
  await openStash(page);
  await row(page, 'Up').dblclick();
  await expect(row(page, 'hi.txt')).toContainText('from Bench');
  await expect(row(page, 'hi.txt').locator('td:nth-child(3)')).toHaveText('2 B');
});

test('Add to library from STASH:', async ({ page }) => {
  test.setTimeout(60_000);
  await signUpFresh(page);
  await openStash(page);
  await browse(page, [{ name: 'Game.adf', buffer: Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: `G${runTag().slice(-8)}` })) },
    { name: 'notes.txt', buffer: Buffer.from('not a disk') }]);
  await expect(row(page, 'Game.adf')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'notes.txt')).toBeVisible();

  // Off for a file that is not a disk image; on for the image.
  await row(page, 'notes.txt').click();
  await expect(page.getByTestId('files-addlib')).toBeDisabled();
  await row(page, 'Game.adf').click();
  await expect(page.getByTestId('files-addlib')).toBeEnabled();
  await page.getByTestId('files-addlib').click();
  const added = toast(page, 'Added 1 disk to the library');
  await expect(added).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'Game.adf')).toContainText('in the library');
  await added.getByRole('button', { name: 'Open title' }).click();
  await expect(page).toHaveURL(/\/games\//);
});

test('Makedir, Rename and Delete in STASH:', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openStash(page);
  await page.getByTestId('pane-left-foot').click();
  await page.getByTestId('files-manager').focus();

  await page.keyboard.press('F7');
  await page.getByTestId('files-name-input').fill('Box');
  await page.getByTestId('files-name-save').click();
  await expect(toast(page, 'Made the folder Box.')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'Box')).toBeVisible();

  await row(page, 'Box').click();
  await page.getByTestId('files-manager').focus();
  await page.keyboard.press('F2');
  await page.getByTestId('files-name-input').fill('Crate');
  await page.getByTestId('files-name-save').click();
  await expect(toast(page, 'Renamed Box to Crate.')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'Crate')).toBeVisible();
  await expect(row(page, 'Box')).toHaveCount(0);
  expect(Object.keys(await stashRows(orgId))).toEqual(['Crate']);

  await row(page, 'Crate').click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-text')).toContainText('Crate');
  await page.getByTestId('files-delete-confirm').click();
  await expect(row(page, 'Crate')).toHaveCount(0, { timeout: 15_000 });
  expect(await stashRows(orgId)).toEqual({});
});
