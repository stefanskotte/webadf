import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded, hydrated } from './device-helpers';

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
