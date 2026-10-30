import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, games } from '@/db/schema/catalog';
import { collectionGames, collections } from '@/db/schema/collections';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch, type BatchOp } from '@/lib/adffs/write';
import { readVolume } from '@/lib/adffs';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

/**
 * Files 2, Task 11: the Directory Opus layout end to end at 1280 x 800 -- the source pane's dark title bar, the device
 * column, the six-by-three grid, LIBRARY:'s collections as folders, filing titles by Copy, Move and drag, collection
 * Makedir/Rename/Delete, Create ADF…, a STASH: image filed into a collection, Files… into a title's first collection,
 * and a disk reached through a collection. Every filing is checked on collection_games, not only on the pane.
 *
 * Covered elsewhere and not repeated here: the Library rail's inline name clash (collections.spec.ts "a name another
 * collection has…"), the Library tray's one Added for a disk it already had (library-add.spec.ts), a drop and a strip
 * through a collection path (files-strip.spec.ts), the phone (files-2.mobile.spec.ts).
 */

test.use({ viewport: { width: 1280, height: 800 } });
test.afterAll(cleanupSeeded);

const enc = (s: string) => new TextEncoder().encode(s);

/** ReadMe, the folder S, C/Assign, and a Workbench icon (for Show .info). */
const STANDARD: BatchOp[] = [
  { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') },
  { op: 'mkdir', parentPath: '', name: 'S' },
  { op: 'mkdir', parentPath: '', name: 'C' },
  { op: 'add', parentPath: 'C', name: 'Assign', bytes: enc('assign stub') },
  { op: 'add', parentPath: '', name: 'Disk.info', bytes: enc('icon') },
];

/** A real FFS disk built from `ops`, stored, and seeded as a one-disk title of this org. */
async function seedTitle(orgId: string, title: string, ops: BatchOp[] = []) {
  const r = applyBatch(ops)(formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 24) }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const seeded = await seedDisk(orgId, { title, diskNo: 1, sha256, sizeBytes: r.adf.length, writeProtected: false });
  return { ...seeded, sha256, path: `LIBRARY:/${seeded.gameId}/${seeded.diskId}` };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  // Hydrated, so clicks, keys and drags reach React's handlers.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const rowNames = (page: Page, side: 'left' | 'right') =>
  page.getByTestId(`pane-${side}`).getByTestId('pane-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-name')));
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });
const crumb = (page: Page, side: 'left' | 'right', i: number) => page.getByTestId(`pane-${side}-crumb-${i}`);
const activeTestId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null);

/**
 * A real HTML5 drag with the mouse. Shift is pressed once the drag is under way, as a person holds it to make the drop
 * a move: in Chromium a mousedown with Shift already held never starts a drag of a draggable row.
 */
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

async function newCollection(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/collections', { data: { name } });
  expect(res.ok()).toBe(true);
  return (await res.json()).id as string;
}
async function file(page: Page, collectionId: string, gameId: string) {
  expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId } })).ok()).toBe(true);
}
async function filedIn(collectionId: string): Promise<string[]> {
  return (await getDb().select({ g: collectionGames.gameId }).from(collectionGames)
    .where(eq(collectionGames.collectionId, collectionId))).map((r) => r.g).sort();
}
async function storedNames(diskId: string): Promise<string[]> {
  const [d] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  const vol = readVolume(await diskStore.read(d.sha256));
  if (!vol.ok) throw new Error('no volume');
  return vol.root.map((e) => e.name);
}
async function gameNamed(orgId: string, title: string): Promise<string> {
  const [g] = await getDb().select({ id: games.id }).from(games).where(and(eq(games.orgId, orgId), eq(games.title, title)));
  expect(g, `a title named ${title}`).toBeTruthy();
  return g.id;
}

test('the source has the dark title bar; a click in the other pane or Tab makes it the source', async ({ page }) => {
  await signUpFresh(page);
  await openFiles(page, 'STASH:', 'LIBRARY:', 'left');
  await expect(page.getByTestId('pane-left-title')).toHaveAttribute('data-role', 'source');
  await expect(page.getByTestId('pane-right-title')).toHaveAttribute('data-role', 'destination');
  // The source bar is ink, the destination the soft tint: never the same paint.
  const bg = (side: string) => page.getByTestId(`pane-${side}-title`).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg('left')).not.toBe(await bg('right'));
  const sourceBg = await bg('left');

  await page.getByTestId('pane-right-foot').click();
  await expect(page.getByTestId('pane-right-title')).toHaveAttribute('data-role', 'source');
  await expect(page.getByTestId('pane-left-title')).toHaveAttribute('data-role', 'destination');
  expect(await bg('right')).toBe(sourceBg);
  await expect.poll(() => new URL(page.url()).searchParams.get('active')).toBe('right');

  await page.getByTestId('files-manager').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('pane-left-title')).toHaveAttribute('data-role', 'source');
  await expect(page.getByTestId('pane-right-title')).toHaveAttribute('data-role', 'destination');
  await expect(page.getByTestId('files-copy')).toHaveText('Copy');
  await expect(page.getByTestId('files-move')).toHaveText('Move');
});

test('the device column moves the source pane to a device root and shows it pressed', async ({ page }) => {
  await signUpFresh(page);
  const demos = await newCollection(page, 'Demos');
  await openFiles(page, 'STASH:', 'NET:', 'left');
  await expect(page.getByTestId('files-dev-STASH')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('files-dev-LIBRARY')).toHaveAttribute('aria-pressed', 'false');

  await page.getByTestId('files-dev-LIBRARY').click();
  await expect(crumb(page, 'left', 0)).toHaveText('LIBRARY:');
  await expect(crumb(page, 'right', 0)).toHaveText('NET:');            // the destination stays where it was
  await expect(page.getByTestId('files-dev-LIBRARY')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('files-dev-STASH')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => new URL(page.url()).searchParams.get('left')).toBe('LIBRARY:');

  // From inside a collection, the device button goes back to the device's root.
  await row(page, 'left', 'Demos').dblclick();
  await expect(crumb(page, 'left', 1)).toHaveText('Demos');
  await expect.poll(() => new URL(page.url()).searchParams.get('left')).toBe(`LIBRARY:/${demos}`);
  await page.getByTestId('files-dev-LIBRARY').click();
  await expect(crumb(page, 'left', 1)).toHaveCount(0);
  await expect(crumb(page, 'left', 0)).toHaveText('LIBRARY:');

  // It follows the SOURCE: with the right pane the source, the right pane moves and the left stays.
  await page.getByTestId('pane-right-foot').click();
  await expect(page.getByTestId('files-dev-NET')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('files-dev-STASH').click();
  await expect(crumb(page, 'right', 0)).toHaveText('STASH:');
  await expect(crumb(page, 'left', 0)).toHaveText('LIBRARY:');
  await expect(page.getByTestId('pane-right-title')).toHaveAttribute('data-role', 'source');
});

test('the grid: All, None, Parent, Root, Swap, Show .info, Filter…', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `Grid-${tag}`, STANDARD);
  await openFiles(page, 'STASH:', a.path, 'right');
  const foot = page.getByTestId('pane-right-foot');

  // All picks every drawn row; None lets them go.
  await page.getByTestId('files-all').click();
  await expect(foot).toContainText('4 of 4 selected');
  for (const n of ['C', 'S', 'Disk.info', 'ReadMe']) await expect(row(page, 'right', n)).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('files-none').click();
  await expect(foot).not.toContainText('selected');
  for (const n of ['C', 'S', 'Disk.info', 'ReadMe']) await expect(row(page, 'right', n)).toHaveAttribute('aria-selected', 'false');

  // Parent from a folder: the disk's root.
  await row(page, 'right', 'C').dblclick();
  await expect(crumb(page, 'right', 3)).toHaveText('C');
  await page.getByTestId('files-parent').click();
  await expect(crumb(page, 'right', 3)).toHaveCount(0);
  await expect(row(page, 'right', 'ReadMe')).toHaveCount(1);

  // Root from a folder: the device's root, LIBRARY:.
  await row(page, 'right', 'C').dblclick();
  await expect(crumb(page, 'right', 3)).toHaveText('C');
  await page.getByTestId('files-root').click();
  await expect(crumb(page, 'right', 1)).toHaveCount(0);
  await expect(crumb(page, 'right', 0)).toHaveText('LIBRARY:');
  await expect(page.getByTestId('files-root')).toHaveAttribute('aria-disabled', 'true');

  // Back into the disk for Show .info and Filter…
  await row(page, 'right', `Grid-${tag}`).dblclick();
  await page.getByTestId('pane-right').getByTestId('pane-row').filter({ hasText: 'Disk 1' }).dblclick();
  await expect(row(page, 'right', 'Disk.info')).toHaveCount(1);
  const showInfo = page.getByTestId('files-showinfo');
  await expect(showInfo).toHaveAttribute('aria-pressed', 'true');
  await showInfo.click();
  await expect(showInfo).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, 'right', 'Disk.info')).toHaveCount(0);
  await expect(row(page, 'right', 'ReadMe')).toHaveCount(1);
  await showInfo.click();
  await expect(showInfo).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 'right', 'Disk.info')).toHaveCount(1);

  await page.getByTestId('files-filter').click();
  await expect(page.getByTestId('pane-right-filter')).toBeFocused();

  // Swap: the panes trade places; the source stays on its side.
  await page.getByTestId('files-swap').click();
  await expect(crumb(page, 'left', 1)).toHaveText(`Grid-${tag}`);
  await expect(crumb(page, 'right', 0)).toHaveText('STASH:');
  await expect.poll(() => new URL(page.url()).searchParams.get('left')).toBe(a.path);
  await expect.poll(() => new URL(page.url()).searchParams.get('right')).toBe('STASH:');
});

test('LIBRARY: lists collections as folders before the titles; a title in two collections is in both', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  await seedTitle(orgId, `Beta-${tag}`);
  const demos = await newCollection(page, 'Demos');
  const gamesC = await newCollection(page, 'Games');
  await file(page, demos, t1.gameId);
  await file(page, gamesC, t1.gameId);
  await openFiles(page, 'LIBRARY:', 'STASH:', 'left');

  // Collections first (in the Library's order), then only the titles in no collection.
  await expect.poll(() => rowNames(page, 'left')).toEqual(['Demos', 'Games', `Beta-${tag}`]);
  for (const c of ['Demos', 'Games']) {
    await expect(row(page, 'left', c)).toHaveAttribute('data-kind', 'collection');
    await expect(row(page, 'left', c).locator('td').nth(2)).toHaveText('1 title');
  }
  await expect(row(page, 'left', `Beta-${tag}`)).toHaveAttribute('data-kind', 'title');

  await row(page, 'left', 'Demos').dblclick();
  await expect(crumb(page, 'left', 1)).toHaveText('Demos');
  await expect.poll(() => rowNames(page, 'left')).toEqual([`Alpha-${tag}`]);
  await crumb(page, 'left', 0).click();
  await row(page, 'left', 'Games').dblclick();
  await expect(crumb(page, 'left', 1)).toHaveText('Games');
  await expect.poll(() => rowNames(page, 'left')).toEqual([`Alpha-${tag}`]);
  // Through the collection, the title opens to its disks.
  await row(page, 'left', `Alpha-${tag}`).dblclick();
  await expect(crumb(page, 'left', 2)).toHaveText(`Alpha-${tag}`);
  await expect.poll(() => new URL(page.url()).searchParams.get('left')).toBe(`LIBRARY:/${gamesC}/${t1.gameId}`);
});

test('Move a title between collections and back to the root', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  const demos = await newCollection(page, 'Demos');
  const gamesC = await newCollection(page, 'Games');
  await file(page, demos, t1.gameId);
  await openFiles(page, `LIBRARY:/${demos}`, `LIBRARY:/${gamesC}`, 'left');

  await row(page, 'left', `Alpha-${tag}`).click();
  await expect(page.getByTestId('files-move')).toBeEnabled();
  await page.getByTestId('files-move').click();
  await expect(toast(page, 'Moved 1 title to Games.')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', `Alpha-${tag}`)).toHaveCount(0);
  await expect(row(page, 'right', `Alpha-${tag}`)).toHaveCount(1);
  expect(await filedIn(demos)).toEqual([]);
  expect(await filedIn(gamesC)).toEqual([t1.gameId]);

  // The left pane (the source) to LIBRARY:'s root by the device column; then the right pane the source, Move → root.
  await page.getByTestId('files-dev-LIBRARY').click();
  await expect(crumb(page, 'left', 1)).toHaveCount(0);
  await expect(row(page, 'left', 'Demos')).toBeVisible();            // the root has loaded (a root-only row)
  await expect(row(page, 'left', `Alpha-${tag}`)).toHaveCount(0);   // filed: not among the root's titles
  await row(page, 'right', `Alpha-${tag}`).click();
  await expect(page.getByTestId('pane-right-title')).toHaveAttribute('data-role', 'source');
  await page.getByTestId('files-move').click();
  await expect(toast(page, 'Moved 1 title to LIBRARY:.')).toBeVisible({ timeout: 15_000 });
  expect(await filedIn(gamesC)).toEqual([]);
  await expect(row(page, 'left', `Alpha-${tag}`)).toHaveAttribute('data-kind', 'title');
  await expect(row(page, 'right', `Alpha-${tag}`)).toHaveCount(0);
});

test('Copy or Move a title into a collection it is already in skips it', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  const demos = await newCollection(page, 'Demos');
  const gamesC = await newCollection(page, 'Games');
  await file(page, demos, t1.gameId);
  await file(page, gamesC, t1.gameId);
  await openFiles(page, `LIBRARY:/${demos}`, `LIBRARY:/${gamesC}`, 'left');

  await row(page, 'left', `Alpha-${tag}`).click();
  await expect(page.getByTestId('files-copy')).toBeEnabled();
  await page.getByTestId('files-copy').click();
  await expect(toast(page, /^Skipped 1 \(already there\)\.$/)).toBeVisible({ timeout: 15_000 });
  expect(await filedIn(demos)).toEqual([t1.gameId]);
  expect(await filedIn(gamesC)).toEqual([t1.gameId]);

  // A Move onto the collection it is in already leaves it where it was too: never taken out of Demos. (The Copy's
  // toast goes first, so the Move's is its own.)
  await expect(toast(page, /^Skipped 1/)).toHaveCount(0, { timeout: 15_000 });
  await row(page, 'left', `Alpha-${tag}`).click();
  await page.getByTestId('files-move').click();
  await expect(toast(page, /^Skipped 1 \(already there\)\.$/)).toBeVisible({ timeout: 15_000 });
  expect(await filedIn(demos)).toEqual([t1.gameId]);
  expect(await filedIn(gamesC)).toEqual([t1.gameId]);
  await expect(row(page, 'left', `Alpha-${tag}`)).toHaveCount(1);
});

test('a filter that hides a picked title leaves it out of a Move', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  const t2 = await seedTitle(orgId, `Beta-${tag}`);
  const demos = await newCollection(page, 'Demos');
  const gamesC = await newCollection(page, 'Games');
  // Beta filed first: the collection's own order (Beta, Alpha) is not the drawn order (Alpha, Beta, by name), so a Move
  // that read the picks against the listing rather than the drawn rows would carry the wrong title.
  await file(page, demos, t2.gameId);
  await file(page, demos, t1.gameId);
  await openFiles(page, `LIBRARY:/${demos}`, `LIBRARY:/${gamesC}`, 'left');
  await expect.poll(() => rowNames(page, 'left')).toEqual([`Alpha-${tag}`, `Beta-${tag}`]);

  await page.getByTestId('files-all').click();
  await expect(page.getByTestId('pane-left-foot')).toContainText('2 of 2 selected');
  await page.getByTestId('pane-left-filter').fill('Alpha');
  await expect(row(page, 'left', `Beta-${tag}`)).toHaveCount(0);
  await expect(page.getByTestId('pane-left-foot')).toContainText('1 of 1 selected');
  await page.getByTestId('files-move').click();
  await expect(toast(page, 'Moved 1 title to Games.')).toBeVisible({ timeout: 15_000 });
  expect(await filedIn(gamesC)).toEqual([t1.gameId]);
  expect(await filedIn(demos)).toEqual([t2.gameId]);
});

test('drag a title onto a collection row files it; Shift-drop moves it', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  const t2 = await seedTitle(orgId, `Beta-${tag}`);
  const demos = await newCollection(page, 'Demos');
  const gamesC = await newCollection(page, 'Games');
  await file(page, demos, t1.gameId);
  await openFiles(page, 'LIBRARY:', 'LIBRARY:', 'left');
  await expect.poll(() => rowNames(page, 'left')).toEqual(['Demos', 'Games', `Beta-${tag}`]);

  // T2 from the root onto the right pane's Demos row: a copy files it, and the root no longer lists it.
  await dragRows(page, row(page, 'left', `Beta-${tag}`), row(page, 'right', 'Demos'));
  await expect(toast(page, 'Copied 1 title to Demos.')).toBeVisible({ timeout: 15_000 });
  expect(await filedIn(demos)).toEqual([t1.gameId, t2.gameId].sort());
  await expect(row(page, 'left', `Beta-${tag}`)).toHaveCount(0);
  await expect(row(page, 'right', 'Demos').locator('td').nth(2)).toHaveText('2 titles');

  // T1 out of Demos onto the Games row with Shift: a move.
  await row(page, 'left', 'Demos').dblclick();
  await expect(crumb(page, 'left', 1)).toHaveText('Demos');
  await dragRows(page, row(page, 'left', `Alpha-${tag}`), row(page, 'right', 'Games'), { shift: true });
  await expect(toast(page, 'Moved 1 title to Games.')).toBeVisible({ timeout: 15_000 });
  expect(await filedIn(demos)).toEqual([t2.gameId]);
  expect(await filedIn(gamesC)).toEqual([t1.gameId]);
  await expect(row(page, 'left', `Alpha-${tag}`)).toHaveCount(0);
});

test('Makedir on LIBRARY: makes a collection; Rename renames it; Delete asks and keeps its titles', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  await newCollection(page, 'Demos');
  await openFiles(page, 'LIBRARY:', 'STASH:', 'left');
  const manager = page.getByTestId('files-manager');
  const dialog = page.getByTestId('files-name-dialog');

  await manager.focus();
  await page.keyboard.press('F7');
  await expect(dialog).toContainText('New collection');
  await page.getByTestId('files-name-input').fill('Utilities');
  await page.getByTestId('files-name-save').click();
  await expect(toast(page, 'Made the collection Utilities.')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'Utilities')).toHaveAttribute('data-kind', 'collection');

  // A name another collection has, in any case: said under the field, nothing sent.
  await manager.focus();
  await page.keyboard.press('F7');
  await page.getByTestId('files-name-input').fill('demos');
  await expect(page.getByTestId('files-name-problem')).toHaveText('A collection with that name already exists.');
  await expect(page.getByTestId('files-name-save')).toBeDisabled();
  // One made since the pane was listed: the server's refusal comes back under the field, and the dialog stays open.
  await newCollection(page, 'Late');
  await page.getByTestId('files-name-input').fill('LATE');
  await expect(page.getByTestId('files-name-problem')).toHaveCount(0);
  await page.getByTestId('files-name-save').click();
  await expect(page.getByTestId('files-name-problem')).toHaveText('A collection with that name already exists.');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('files-name-input')).toHaveValue('LATE');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // F2 renames the picked collection.
  await row(page, 'left', 'Utilities').click();
  await page.keyboard.press('F2');
  await expect(dialog).toContainText('Rename Utilities');
  await page.getByTestId('files-name-input').fill('Tools');
  await page.getByTestId('files-name-save').click();
  await expect(toast(page, 'Renamed Utilities to Tools.')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'Tools')).toHaveCount(1);
  await expect(row(page, 'left', 'Utilities')).toHaveCount(0);
  const [tools] = await getDb().select({ id: collections.id }).from(collections)
    .where(and(eq(collections.orgId, orgId), eq(collections.name, 'Tools')));
  expect(tools).toBeTruthy();

  // Delete asks, in the Library's words; its title stays in the library, back at the root.
  await file(page, tools.id, t1.gameId);
  await openFiles(page, 'LIBRARY:', 'STASH:', 'left');
  await expect(row(page, 'left', `Alpha-${tag}`)).toHaveCount(0);
  await row(page, 'left', 'Tools').click();
  await page.keyboard.press('Delete');
  const confirm = page.getByTestId('files-delete-dialog');
  await expect(confirm.getByTestId('files-delete-text')).toHaveText('Delete the collection “Tools”? Its titles stay in the library.');
  await confirm.getByTestId('files-delete-confirm').click();
  await expect(toast(page, 'Deleted 1 collection.')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'Tools')).toHaveCount(0);
  await expect(row(page, 'left', `Alpha-${tag}`)).toHaveAttribute('data-kind', 'title');
  expect(await getDb().select().from(collections).where(eq(collections.id, tools.id))).toHaveLength(0);
  expect(await getDb().select({ id: games.id }).from(games).where(eq(games.id, t1.gameId))).toHaveLength(1);
});

test('Create ADF in STASH:, LIBRARY: root and a collection; refused on NET:', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const demos = await newCollection(page, 'Demos');
  await openFiles(page, 'STASH:', 'NET:', 'left');
  const create = page.getByTestId('files-createadf');
  const dialog = page.getByTestId('files-create-adf');
  expect((await page.request.patch('/api/me/prefs', { data: { files: { onClash: 'ask' } } })).ok()).toBe(true);   // explicit, not the default

  // STASH:: Work, OFS → Work.adf, picked, the keys back on the manager.
  await create.click();
  await expect(dialog).toContainText('In STASH:');
  await page.getByTestId('files-create-adf-name').fill('Work');
  await page.getByTestId('files-create-adf-fs-ofs').click();
  await page.getByTestId('files-create-adf-submit').click();
  await expect(toast(page, 'Made Work.adf in STASH:.')).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'left', 'Work.adf')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => activeTestId(page)).toBe('files-manager');
  const [up] = await getDb().select({ sha: amigaUploads.blobSha256 }).from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), eq(amigaUploads.path, 'Work.adf'), ne(amigaUploads.status, 'deleted')));
  expect(up).toBeTruthy();
  const made = await diskStore.read(up.sha!);
  expect(made.length).toBe(901_120);
  expect([...made.subarray(0, 4)]).toEqual([0x44, 0x4f, 0x53, 0x00]);   // DOS\0: OFS

  // With the clash setting Ask (the default), the same name is refused inline and Create stays off.
  await create.click();
  await page.getByTestId('files-create-adf-name').fill('work');
  await expect(page.getByTestId('files-create-adf-problem')).toHaveText('Something with that name is already there.');
  await expect(page.getByTestId('files-create-adf-submit')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // LIBRARY: root: a new title, picked; the toast opens it.
  await page.getByTestId('files-dev-LIBRARY').click();
  await expect(crumb(page, 'left', 0)).toHaveText('LIBRARY:');
  await create.click();
  await expect(dialog).toContainText('In LIBRARY:');
  await page.getByTestId('files-create-adf-name').fill('Scratch');
  await page.getByTestId('files-create-adf-submit').click();
  const madeTitle = toast(page, 'Made Scratch in LIBRARY:.');
  await expect(madeTitle).toBeVisible({ timeout: 15_000 });
  await expect(madeTitle.getByRole('button', { name: 'Open title' })).toBeVisible();
  await expect(row(page, 'left', 'Scratch')).toHaveAttribute('data-kind', 'title');
  await expect(row(page, 'left', 'Scratch')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => activeTestId(page)).toBe('files-manager');

  // In a collection: made there and filed.
  await row(page, 'left', 'Demos').dblclick();
  await expect(crumb(page, 'left', 1)).toHaveText('Demos');
  await create.click();
  await expect(dialog).toContainText('In Demos');
  await page.getByTestId('files-create-adf-name').fill('Filed');
  await page.getByTestId('files-create-adf-submit').click();
  await expect(toast(page, 'Made Filed in Demos.')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'Filed')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => activeTestId(page)).toBe('files-manager');
  expect(await filedIn(demos)).toEqual([await gameNamed(orgId, 'Filed')]);

  // A title's disk list: go up first.
  await crumb(page, 'left', 0).click();
  await row(page, 'left', 'Scratch').dblclick();
  await expect(crumb(page, 'left', 1)).toHaveText('Scratch');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Go up to the library or a collection');

  // NET:: never.
  await page.getByTestId('files-dev-NET').click();
  await expect(crumb(page, 'left', 0)).toHaveText('NET:');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Disks are made in STASH: or LIBRARY:');
  await create.click({ force: true });   // aria-disabled: a press says why, and opens nothing
  await expect(toast(page, 'Disks are made in STASH: or LIBRARY:')).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test('a STASH: disk image moved onto a collection is added to the library and filed there', async ({ page }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const demos = await newCollection(page, 'Demos');
  await openFiles(page, 'STASH:', `LIBRARY:/${demos}`, 'left');
  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'Moved.adf', mimeType: 'application/octet-stream',
    buffer: Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: `M${tag.slice(-8)}` })) }]);
  await expect(row(page, 'left', 'Moved.adf')).toBeVisible({ timeout: 15_000 });

  await row(page, 'left', 'Moved.adf').click();
  await expect(page.getByTestId('files-move')).toBeEnabled();
  await page.getByTestId('files-move').click();
  await expect(toast(page, 'Moved 1 disk to Demos.')).toBeVisible({ timeout: 15_000 });
  const titles = page.getByTestId('pane-right').locator('[data-testid="pane-row"][data-kind="title"]');
  await expect(titles).toHaveCount(1);
  const filed = await filedIn(demos);
  expect(filed).toHaveLength(1);
  const [g] = await getDb().select({ title: games.title, orgId: games.orgId }).from(games).where(eq(games.id, filed[0]));
  expect(g.orgId).toBe(orgId);
  await expect(titles).toHaveAttribute('data-name', g.title);
  await expect(row(page, 'left', 'Moved.adf')).toHaveCount(0);
});

test('Files… on a filed title\'s disk opens it inside its first collection; an old link\'s Parent goes to LIBRARY:', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  // Games is made first and T1 filed there first; Demos comes first only by its sortKey.
  const gamesC = await newCollection(page, 'Games');
  const demos = await newCollection(page, 'Demos');
  await file(page, gamesC, t1.gameId);
  await file(page, demos, t1.gameId);
  await getDb().update(collections).set({ sortKey: 0 }).where(eq(collections.id, demos));
  await getDb().update(collections).set({ sortKey: 1 }).where(eq(collections.id, gamesC));

  await page.goto(`/games/${t1.gameId}`);
  const link = page.getByTestId(`files-${t1.diskId}`);
  expect(await link.getAttribute('href')).toContain(encodeURIComponent(`LIBRARY:/${demos}/${t1.gameId}/${t1.diskId}`));
  await link.click();
  await expect(page).toHaveURL(/\/files\?/);
  await expect(crumb(page, 'right', 0)).toHaveText('LIBRARY:');
  await expect(crumb(page, 'right', 1)).toHaveText('Demos');
  await expect(crumb(page, 'right', 2)).toHaveText(`Alpha-${tag}`);
  await expect(crumb(page, 'right', 3)).toHaveText(/Disk 1/);   // the seeded disk's label names its title too

  // The old, unfiled address still opens the disk; Parent twice goes up through the title to LIBRARY:.
  await openFiles(page, 'STASH:', t1.path, 'right');
  await expect(crumb(page, 'right', 2)).toHaveText(/Disk 1/);
  await page.getByTestId('files-parent').click();
  await expect(crumb(page, 'right', 1)).toHaveText(`Alpha-${tag}`);
  await expect(crumb(page, 'right', 2)).toHaveCount(0);
  await page.getByTestId('files-parent').click();
  await expect(crumb(page, 'right', 1)).toHaveCount(0);
  await expect(crumb(page, 'right', 0)).toHaveText('LIBRARY:');
});

test('a disk inside a collection path: copy a file in, Undo, and "new in v1"', async ({ page }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const t1 = await seedTitle(orgId, `Alpha-${tag}`);
  const demos = await newCollection(page, 'Demos');
  await file(page, demos, t1.gameId);
  await openFiles(page, 'STASH:', `LIBRARY:/${demos}/${t1.gameId}/${t1.diskId}`, 'left');
  await expect(crumb(page, 'right', 3)).toHaveText(/Disk 1/);
  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('a note') }]);
  await expect(row(page, 'left', 'note.txt')).toBeVisible({ timeout: 15_000 });

  await row(page, 'left', 'note.txt').click();
  await page.getByTestId('files-copy').click();
  const copied = toast(page, /^Copied 1 item to .* — saved as version 1\./);
  await expect(copied).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'right', 'note.txt').getByTestId('pane-new-note.txt')).toHaveText('new in v1');
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-strip-history-toggle')).toHaveText('History · v1');
  expect(await storedNames(t1.diskId)).toContain('note.txt');

  await copied.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Undone')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'right', 'note.txt')).toHaveCount(0);
  expect(await storedNames(t1.diskId)).not.toContain('note.txt');
});

test('Rename and Delete of a title say where to do it', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  await seedTitle(orgId, `Beta-${tag}`);
  await openFiles(page, 'LIBRARY:', 'STASH:', 'left');
  await row(page, 'left', `Beta-${tag}`).click();
  await expect(row(page, 'left', `Beta-${tag}`)).toHaveAttribute('aria-selected', 'true');
  for (const id of ['files-rename', 'files-delete']) {
    await expect(page.getByTestId(id), id).toBeDisabled();
    await expect(page.getByTestId(id), id).toHaveAttribute('title', 'Rename or delete titles on the Library page');
  }
  // The keys say it too, and open nothing.
  await page.keyboard.press('Delete');
  await expect(toast(page, 'Rename or delete titles on the Library page')).toBeVisible();
  await expect(page.getByTestId('files-delete-dialog')).toHaveCount(0);
});
