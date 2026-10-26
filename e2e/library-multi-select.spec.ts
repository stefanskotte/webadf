import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded, hydrated, pairDevice, authHeader } from './device-helpers';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

// Library multi-select (spec docs/superpowers/specs/2026-10-26-library-multi-select-design.md §8 e2e).
// Tests are named MS-NN so batches can select them.
test.describe.configure({ timeout: 120_000 });
test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(`multisel-${s}`).digest('hex');

/** `n` one-disk titles "<prefix> 01 <run>" … in the signed-up org. */
async function seedTitles(orgId: string, prefix: string, n: number) {
  const run = runTag();
  const out: { gameId: string; diskId: string; title: string; sha: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const title = `${prefix} ${String(i).padStart(2, '0')} ${run}`;
    const s = sha(`${run}-${prefix}-${i}`);
    const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: s });
    out.push({ gameId, diskId, title, sha: s });
  }
  return out;
}
/** A collection through the app's own route, optionally holding `gameIds`. */
async function makeCollection(page: Page, name: string, gameIds: string[] = []) {
  const res = await page.request.post('/api/collections', { data: { name } });
  expect(res.status()).toBe(200);
  const { id } = await res.json() as { id: string };
  for (const gameId of gameIds) {
    expect((await page.request.post(`/api/collections/${id}/games`, { data: { gameId } })).status()).toBe(200);
  }
  return { id, name };
}
const card = (page: Page, gameId: string) => page.locator(`[data-testid="game-card"][data-game-id="${gameId}"]`);
const row = (page: Page, gameId: string) => page.locator(`[data-testid="game-row"][data-game-id="${gameId}"]`);
const boxOf = (host: Locator) => host.getByTestId('select-title');
const railRow = (page: Page, collectionId: string) => page.locator(`[data-testid="collection-row"][data-collection-id="${collectionId}"]`);
/** 24 a page, by title: 26 titles make two pages. */
async function smallPages(page: Page) {
  const res = await page.request.patch('/api/me/prefs', { data: { library: { pageSize: 24, sort: { key: 'title', dir: 'asc' } } } });
  expect(res.status()).toBe(200);
}
const bar = (page: Page) => page.getByTestId('library-selection-bar');
const count = (page: Page) => page.getByTestId('library-selection-count');
/** The bodies of every /api/games/bulk request the page sends. */
function bulkRequests(page: Page) {
  const sent: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/games/bulk')) sent.push(r.postData() ?? ''); });
  return sent;
}
const toggle = (page: Page) => page.getByTestId('library-select-toggle');
async function startSelecting(page: Page) {
  await hydrated(page, 'library-select-toggle');
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
}

test('MS-01 the Select titles toggle: only with titles, pressed while selecting, Cancel on a second press', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await page.goto('/library');
  await expect(page.getByTestId('game-grid')).toHaveAttribute('data-empty', 'library');
  await expect(toggle(page)).toHaveCount(0);   // an empty library has nothing to select

  const [a] = await seedTitles(orgId, 'Toggle', 1);
  await page.goto('/library');
  await expect(card(page, a.gameId)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toHaveAttribute('aria-label', 'Select titles');
  // Directly before the Grid/Table toggle, and the same size as its buttons at 1280.
  const box = (await toggle(page).boundingBox())!;
  const grid = (await page.getByRole('link', { name: 'Grid view' }).boundingBox())!;
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([Math.round(grid.width), Math.round(grid.height)]);
  expect(box.x).toBeLessThan(grid.x);

  await startSelecting(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toBeFocused();

  // The collections overview (an empty inbox in the grid) has no titles to select, and no toggle.
  await makeCollection(page, `Filed ${runTag()}`, [a.gameId]);
  await page.goto('/library');
  await expect(page.getByTestId('category-overview')).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  // The table's root lists the collection as a folder but no title: no toggle either.
  await page.goto('/library?view=table');
  await expect(page.getByTestId('folder-row')).toHaveCount(1);
  await expect(toggle(page)).toHaveCount(0);
});

/**
 * Drag with the real pointer (collections.spec.ts's dragOnto): dnd-kit's MouseSensor has an 8 px activation
 * constraint, so the steps are what would make a drag register.
 */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
}

test('MS-02 grid: a box on every card, a click ticks instead of navigating, the ⋯ menu is gone, a drag files nothing', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b] = await seedTitles(orgId, 'Grid', 2);
  const target = await makeCollection(page, `Drop ${runTag()}`);
  const filed: string[] = [];
  page.on('request', (r) => { if (/\/api\/collections\/[^/]+\/games/.test(r.url())) filed.push(r.url()); });
  await page.goto('/library');
  await expect(card(page, a.gameId)).toHaveAttribute('href', /\/games\//);
  await expect(page.getByTestId(`title-menu-${a.gameId}`)).toBeVisible();

  await startSelecting(page);
  for (const t of [a, b]) {
    await expect(boxOf(card(page, t.gameId))).toBeVisible();
    await expect(boxOf(card(page, t.gameId))).not.toBeChecked();   // both states drawn: an empty box, never nothing
    await expect(card(page, t.gameId)).toHaveAttribute('data-selected', 'false');
    await expect(page.getByTestId(`title-menu-${t.gameId}`)).toHaveCount(0);
  }
  await expect(card(page, a.gameId)).not.toHaveAttribute('href', /.*/);
  await expect(boxOf(card(page, a.gameId))).toHaveAttribute('aria-label', new RegExp(`^Select ${a.title}`));
  // The box sits in the card's top-left corner.
  const cb = (await card(page, a.gameId).boundingBox())!;
  const bb = (await boxOf(card(page, a.gameId)).boundingBox())!;
  expect(bb.x - cb.x).toBeLessThan(24);
  expect(bb.y - cb.y).toBeLessThan(24);

  await hydrated(page, 'select-title', 'onChange');
  await card(page, a.gameId).click({ position: { x: cb.width / 2, y: cb.height / 3 } });   // on the cover, not the box
  await expect(page).toHaveURL(/\/library$/);
  await expect(boxOf(card(page, a.gameId))).toBeChecked();
  await expect(card(page, a.gameId)).toHaveAttribute('data-selected', 'true');
  await boxOf(card(page, a.gameId)).click();
  await expect(boxOf(card(page, a.gameId))).not.toBeChecked();

  // Drag is off while selecting: a card dropped on the rail files nothing.
  await dragOnto(page, card(page, b.gameId), railRow(page, target.id));
  await page.waitForTimeout(1000);   // a drop would have POSTed by now
  expect(filed).toEqual([]);
  await expect(railRow(page, target.id).getByTestId('collection-count')).toHaveText('0');

  // Keyboard: Space on the focused box ticks it.
  await boxOf(card(page, b.gameId)).focus();
  await page.keyboard.press('Space');
  await expect(boxOf(card(page, b.gameId))).toBeChecked();

  // The toggle unmounting under its own focus (the view emptied by a refresh): focus goes to the h1, never <body>.
  await toggle(page).focus();
  for (const t of [a, b]) expect((await page.request.delete(`/api/games/${t.gameId}`)).status()).toBe(200);
  // Depends on Next's debug global (window.next.router), verified on Next 16.3.2; fail clearly if a Next upgrade drops it.
  expect(await page.evaluate(() => typeof (window as unknown as { next?: { router?: { refresh?: unknown } } }).next?.router?.refresh),
    'window.next.router.refresh is missing: Next changed its debug global, so this test needs another way to refresh').toBe('function');
  await page.evaluate(() => (window as unknown as { next: { router: { refresh(): void } } }).next.router.refresh());
  await expect(toggle(page)).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});

test('MS-03 table: a leading box track on title rows, none on folders, the header ticks the page, a row click ticks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Row', 3);
  const folder = await makeCollection(page, `Folder ${runTag()}`, [c.gameId]);
  await page.goto('/library?view=table');
  await expect(row(page, a.gameId)).toHaveAttribute('href', /\/games\//);
  await startSelecting(page);

  const folderRow = page.locator(`[data-testid="folder-row"][data-collection-id="${folder.id}"]`);
  await expect(folderRow).toBeVisible();
  await expect(folderRow.getByTestId('select-title')).toHaveCount(0);
  const rb = (await row(page, a.gameId).boundingBox())!;
  const bb = (await boxOf(row(page, a.gameId)).boundingBox())!;
  expect(bb.x - rb.x).toBeLessThan(40);   // the leading 28 px track, after the row's 18 px padding
  await expect(page.getByTestId(`title-menu-${a.gameId}`)).toHaveCount(0);

  await hydrated(page, 'select-title', 'onChange');
  await row(page, a.gameId).click({ position: { x: rb.width / 2, y: rb.height / 2 } });
  await expect(page).not.toHaveURL(/\/games\//);
  await expect(boxOf(row(page, a.gameId))).toBeChecked();
  await expect(row(page, a.gameId)).toHaveAttribute('data-selected', 'true');

  const all = page.getByTestId('table-select-page');
  expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);   // one of two
  await all.click();
  for (const t of [a, b]) await expect(boxOf(row(page, t.gameId))).toBeChecked();
  await expect(all).toBeChecked();
  await all.click();
  for (const t of [a, b]) await expect(boxOf(row(page, t.gameId))).not.toBeChecked();
});

test('MS-04 a selection keeps across pages and grid/table, ends on another view and on Back from a title', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(orgId, 'Keep', 26);   // page 1: 01-24, page 2: 25-26
  await smallPages(page);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, t[0].gameId)).click();

  await page.getByTestId('pager-next').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await boxOf(card(page, t[25].gameId)).click();
  await page.getByRole('link', { name: 'Table view' }).click();
  await expect(page).toHaveURL(/view=table/);
  await expect(boxOf(row(page, t[25].gameId))).toBeChecked();
  await page.getByTestId('pager-page-1').click();
  await expect(boxOf(row(page, t[0].gameId))).toBeChecked();
  await expect(boxOf(row(page, t[1].gameId))).not.toBeChecked();

  // Another view ends it: nothing was changed, so no prompt.
  await page.getByTestId('collection-all').click();
  await expect(page).toHaveURL(/collection=all/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('select-title')).toHaveCount(0);

  // Back from a title never revives an old selection.
  await startSelecting(page);
  await page.getByTestId('select-title').first().click();
  await page.getByTestId('search-input').fill(t[3].title);
  await expect(page.getByTestId('search-result').first()).toHaveAttribute('data-result-id', t[3].gameId);
  await page.getByTestId('search-input').press('Enter');
  await expect(page).toHaveURL(new RegExp(`/games/${t[3].gameId}`));
  await page.goBack();
  await expect(page).toHaveURL(/\/library/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('select-title')).toHaveCount(0);
});

test('MS-05 Cancel changes nothing: no request is sent, both titles stay, focus goes to the toggle', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b] = await seedTitles(orgId, 'Cancel', 2);
  await makeCollection(page, `Target ${runTag()}`);
  const sent = bulkRequests(page);
  await page.goto('/library');
  await expect(bar(page)).toBeHidden();
  await startSelecting(page);
  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId('library-select-page')).toBeFocused();
  await expect(count(page)).toHaveText('No titles selected');
  for (const id of ['library-bulk-move', 'library-bulk-delete']) {
    await expect(page.getByTestId(id)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(id)).toHaveAttribute('title', 'Select titles first');
  }
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await boxOf(card(page, b.gameId)).click();
  await expect(count(page)).toHaveText('2 titles selected');

  await page.getByTestId('library-bulk-move').click();
  await expect(page.getByTestId('bulk-move-dialog')).toBeVisible();
  await page.getByTestId('bulk-move-cancel').click();
  await expect(page.getByTestId('bulk-move-dialog')).toBeHidden();
  await expect(page.getByTestId('library-bulk-move')).toBeFocused();
  await expect(count(page)).toHaveText('2 titles selected');

  await page.getByTestId('library-selection-cancel').click();
  await expect(bar(page)).toBeHidden();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(card(page, a.gameId)).toBeVisible();
  await expect(card(page, b.gameId)).toBeVisible();
  expect(sent).toEqual([]);
});

test('MS-06 grid, Move: two titles from Uncategorized into a collection; they leave the inbox, the rail counts follow', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Move', 3);
  const dst = await makeCollection(page, `Shooters ${runTag()}`);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await boxOf(card(page, b.gameId)).click();
  await page.getByTestId('library-bulk-move').click();

  const dlg = page.getByTestId('bulk-move-dialog');
  await expect(dlg).toContainText('Move to collection');
  await expect(dlg).toContainText('2 titles go into the collection you pick. Titles already in other collections stay there too.');
  const confirm = page.getByTestId('bulk-move-confirm');
  await expect(confirm).toHaveText('Move 2 titles');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await dlg.getByRole('radio', { name: dst.name }).check();
  await expect(confirm).not.toHaveAttribute('aria-disabled', /.*/);
  await confirm.click();

  await expect(page.getByText(`Moved 2 titles to ${dst.name}`)).toBeVisible();
  await expect(dlg).toBeHidden();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(card(page, a.gameId)).toHaveCount(0);
  await expect(card(page, b.gameId)).toHaveCount(0);
  await expect(card(page, c.gameId)).toBeVisible();
  await expect(railRow(page, dst.id).getByTestId('collection-count')).toHaveText('2');
  await expect(page.getByTestId('collection-uncategorized')).toHaveText(/Uncategorized\s*1$/);
});

test('MS-07 inside a collection, Move leaves it; Escape in the dialog closes only the dialog; a double press sends one request', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Inside', 3);
  const src = await makeCollection(page, `Source ${runTag()}`, [a.gameId, b.gameId, c.gameId]);
  const dst = await makeCollection(page, `Dest ${runTag()}`);
  const sent = bulkRequests(page);
  await page.goto(`/library?collection=${src.id}`);
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await boxOf(card(page, b.gameId)).click();
  await page.getByTestId('library-bulk-move').click();
  const dlg = page.getByTestId('bulk-move-dialog');
  await expect(dlg).toContainText(`2 titles leave ${src.name} and go into the collection you pick.`);
  await expect(dlg.getByRole('radio', { name: src.name })).toHaveCount(0);   // never the one you are in

  // Review Focus 2: Escape inside the dialog bubbles through React's portal tree; only the dialog closes.
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(bar(page)).toBeVisible();
  await expect(count(page)).toHaveText('2 titles selected');
  await expect(page.getByTestId('library-bulk-move')).toBeFocused();

  await page.getByTestId('library-bulk-move').click();
  await dlg.getByRole('radio', { name: dst.name }).check();
  // Review Focus 3: a double press sends one move.
  await page.getByTestId('bulk-move-confirm').dblclick();
  await expect(page.getByText(`Moved 2 titles to ${dst.name}`)).toBeVisible();
  expect(sent.filter((s) => s.includes('"op":"move"'))).toHaveLength(1);
  expect(JSON.parse(sent[0])).toMatchObject({ op: 'move', to: dst.id, from: src.id });
  await expect(card(page, a.gameId)).toHaveCount(0);
  await expect(card(page, c.gameId)).toBeVisible();
  await expect(railRow(page, dst.id).getByTestId('collection-count')).toHaveText('2');
  await expect(railRow(page, src.id).getByTestId('collection-count')).toHaveText('1');
});

test('MS-08 All on this page, its indeterminate state, the count of titles on other pages, Escape from the bar', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(orgId, 'Pages', 26);
  await smallPages(page);
  await page.goto('/library');
  await startSelecting(page);
  const all = page.getByTestId('library-select-page');
  await hydrated(page, 'library-select-page', 'onChange');
  await all.click();
  await expect(count(page)).toHaveText('24 titles selected');
  await expect(all).toBeChecked();

  await page.getByTestId('pager-next').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(count(page)).toHaveText('24 titles selected · 24 on other pages');
  await expect(page.getByTestId('library-selection-offpage')).toHaveText(/·\s*24 on other pages$/);
  await expect(all).not.toBeChecked();
  await boxOf(card(page, t[25].gameId)).click();
  expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
  await expect(count(page)).toHaveText('25 titles selected · 24 on other pages');

  // Escape with focus in the bar ends selecting; focus goes to the toggle.
  await all.focus();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

const confirmDelete = (page: Page) => page.getByTestId('bulk-delete-confirm');
async function openDelete(page: Page) {
  await page.getByTestId('library-bulk-delete').click();
  await expect(page.getByTestId('bulk-delete-dialog')).toBeVisible();
}

test('MS-09 table, Delete: the preview counts, OK removes the rows, focus goes to the toggle', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b, c] = await seedTitles(orgId, 'Del', 3);
  await page.goto('/library?view=table');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(row(page, a.gameId)).click();
  await boxOf(row(page, b.gameId)).click();
  await openDelete(page);
  const dlg = page.getByTestId('bulk-delete-dialog');
  await expect(dlg).toContainText('Delete titles?');
  await expect(dlg).toContainText('2 titles and their 2 disks will be removed from your library.');
  await expect(page.getByTestId('bulk-delete-list')).toContainText(a.title);
  await expect(page.getByTestId('bulk-delete-list')).toContainText(b.title);
  await expect(page.getByTestId('bulk-delete-kept')).toHaveCount(0);
  await expect(dlg).toContainText('The disk image itself is kept if anyone else has the same one.');
  await expect(dlg).not.toContainText('ejected');
  await expect(confirmDelete(page)).toHaveText('Delete 2 titles');
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 2 titles')).toBeVisible();
  await expect(dlg).toBeHidden();
  await expect(row(page, a.gameId)).toHaveCount(0);
  await expect(row(page, b.gameId)).toHaveCount(0);
  await expect(row(page, c.gameId)).toBeVisible();
  await expect(toggle(page)).toBeFocused();
});

test('MS-10 keyboard only: Tab to a box, Space, Delete…, Escape closes the dialog and focus returns to Delete…', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await seedTitles(orgId, 'Keys', 2);
  await page.goto('/library');
  await hydrated(page, 'library-select-toggle');
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('library-select-page')).toBeFocused();
  // All on this page, Move…, Delete…, Cancel, then the first title's box.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  await expect(page.getByTestId('select-title').first()).toBeFocused();
  await page.keyboard.press('Space');
  await expect(count(page)).toHaveText('1 title selected');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('library-bulk-delete')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('bulk-delete-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bulk-delete-dialog')).toBeHidden();
  await expect(page.getByTestId('library-bulk-delete')).toBeFocused();
  await expect(bar(page)).toBeVisible();   // Review Focus 2: only the dialog closed
  await expect(count(page)).toHaveText('1 title selected');
});

test('MS-11 a title in a drive is kept: the preview says where, OK deletes only the rest, the board is not ejected', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const [held, free] = await seedTitles(orgId, 'Held', 2);
  const board = await pairDevice(page, request, 'Bench MS');
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId: held.diskId } });
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: held.sha, mountedDiskId: held.diskId, version },
  })).status()).toBe(204);

  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, held.gameId)).click();
  await openDelete(page);
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('Nothing to delete: every selected title is in a drive. Eject it there first.');
  await expect(confirmDelete(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('bulk-delete-cancel').click();

  await boxOf(card(page, free.gameId)).click();
  await openDelete(page);
  await expect(page.getByTestId('bulk-delete-kept')).toContainText('1 title is in a drive and will be kept:');
  await expect(page.getByTestId('bulk-delete-kept')).toContainText(`${held.title} — In Bench MS (DF0)`);
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('1 title and its 1 disk will be removed from your library.');
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 1 title')).toBeVisible();   // the held title was never sent
  await expect(card(page, free.gameId)).toHaveCount(0);
  await expect(card(page, held.gameId)).toBeVisible();
  const [row0] = await getDb().select({ d: devices.desiredDiskId }).from(devices).where(eq(devices.id, board.deviceId));
  expect(row0.d).toBe(held.diskId);
});

test('MS-12 deleting every title of the view puts focus on the h1, never on the page body', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await seedTitles(orgId, 'Last', 2);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'library-select-page', 'onChange');
  await page.getByTestId('library-select-page').click();
  await openDelete(page);
  await expect(confirmDelete(page)).toHaveText('Delete 2 titles');
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 2 titles')).toBeVisible();
  await expect(page.getByTestId('game-grid')).toHaveAttribute('data-empty', 'library');
  await expect(toggle(page)).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});

test('MS-13 a dropped connection on OK keeps the dialog and the selection, and a second press works', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b] = await seedTitles(orgId, 'Drop', 2);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await openDelete(page);
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');   // the preview has answered
  await page.route('**/api/games/bulk', (r) => r.abort('failed'));
  await confirmDelete(page).click();
  await expect(page.getByText('Could not reach the server')).toBeVisible();
  await expect(page.getByText('Trying again is safe.')).toBeVisible();
  await expect(page.getByTestId('bulk-delete-dialog')).toBeVisible();
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');
  await expect(confirmDelete(page)).not.toHaveAttribute('aria-disabled', /.*/);
  await page.unroute('**/api/games/bulk');
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 1 title')).toBeVisible();
  await expect(card(page, a.gameId)).toHaveCount(0);
  await expect(card(page, b.gameId)).toBeVisible();
});

test('MS-14 a failed preview deletes nothing and offers Try again', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'Retry', 1);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await page.route('**/api/games/bulk', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await openDelete(page);
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('Could not check the drives.');
  await expect(confirmDelete(page)).toHaveAttribute('aria-disabled', 'true');
  await page.unroute('**/api/games/bulk');
  await page.getByTestId('bulk-delete-retry').click();
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText('1 title and its 1 disk will be removed from your library.');
  await page.getByTestId('bulk-delete-close').click();
  await expect(page.getByTestId('library-bulk-delete')).toBeFocused();
  await page.reload();
  await expect(card(page, a.gameId)).toBeVisible();
});

test('MS-15 moving every title out of the collection puts focus on the h1, never on the page body', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a, b] = await seedTitles(orgId, 'Out', 2);
  const src = await makeCollection(page, `Src ${runTag()}`, [a.gameId, b.gameId]);
  const dst = await makeCollection(page, `Dst ${runTag()}`);
  await page.goto(`/library?collection=${src.id}`);
  await startSelecting(page);
  await hydrated(page, 'library-select-page', 'onChange');
  await page.getByTestId('library-select-page').click();
  await page.getByTestId('library-bulk-move').click();
  await page.getByTestId('bulk-move-dialog').getByRole('radio', { name: dst.name }).check();
  await page.getByTestId('bulk-move-confirm').click();
  await expect(page.getByText(`Moved 2 titles to ${dst.name}`)).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});

test('MS-16 an OK whose 200 answer is not JSON says the titles may have changed and to refresh, not "could not reach"', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'Junk', 2);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await openDelete(page);
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');
  await page.route('**/api/games/bulk', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>' }));
  await confirmDelete(page).click();
  await expect(page.getByText("The server's answer could not be read. Check the library to see what was deleted.")).toBeVisible();
  await expect(page.getByText('Could not reach the server')).toHaveCount(0);
  await expect(page.getByTestId('bulk-delete-dialog')).toBeHidden();
});

test('MS-17 a Move whose 200 answer is not JSON says the titles may have moved and to refresh', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const [a] = await seedTitles(orgId, 'JunkMove', 1);
  const dst = await makeCollection(page, `Junk ${runTag()}`);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, a.gameId)).click();
  await page.getByTestId('library-bulk-move').click();
  const dlg = page.getByTestId('bulk-move-dialog');
  for (const r of await dlg.getByRole('radio').all()) await expect(r).not.toHaveAttribute('aria-disabled', /.*/);
  await dlg.getByRole('radio', { name: dst.name }).check();
  await page.route('**/api/games/bulk', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>' }));
  await page.getByTestId('bulk-move-confirm').click();
  await expect(page.getByText("The server's answer could not be read. Check the library to see what was moved.")).toBeVisible();
  await expect(page.getByText('Could not reach the server')).toHaveCount(0);
});

test('MS-18 a title shown as kept stays kept: its drive empties before OK, OK still deletes only what the preview listed', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const [held, free] = await seedTitles(orgId, 'Late', 2);
  const board = await pairDevice(page, request, 'Bench Late');
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId: held.diskId } });
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: held.sha, mountedDiskId: held.diskId, version },
  })).status()).toBe(204);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'select-title', 'onChange');
  await boxOf(card(page, held.gameId)).click();
  await boxOf(card(page, free.gameId)).click();
  await openDelete(page);
  await expect(page.getByTestId('bulk-delete-kept')).toContainText(held.title);
  await expect(confirmDelete(page)).toHaveText('Delete 1 title');
  // The drive empties after the preview: eject, and the board reports it.
  expect((await page.request.post(`/api/devices/${board.deviceId}/eject`, { data: {} })).status()).toBe(200);
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token), data: { mountedSha256: null, mountedDiskId: null },
  })).status()).toBe(204);
  await confirmDelete(page).click();
  await expect(page.getByText('Deleted 1 title')).toBeVisible();
  await expect(card(page, free.gameId)).toHaveCount(0);
  await expect(card(page, held.gameId)).toBeVisible();
});

test('MS-19 the view empties while the Delete dialog is open: the dialog closes, no stale "Delete 2 titles"', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(orgId, 'Vanish', 2);
  await page.goto('/library');
  await startSelecting(page);
  await hydrated(page, 'library-select-page', 'onChange');
  await page.getByTestId('library-select-page').click();
  await openDelete(page);
  await expect(confirmDelete(page)).toHaveText('Delete 2 titles');
  for (const x of t) expect((await page.request.delete(`/api/games/${x.gameId}`)).status()).toBe(200);
  await page.evaluate(() => (window as unknown as { next: { router: { refresh(): void } } }).next.router.refresh());
  await expect(page.getByTestId('bulk-delete-dialog')).toBeHidden();
  await expect(page.locator('h1')).toBeFocused();
});
