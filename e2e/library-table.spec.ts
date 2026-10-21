import { test, expect, type Page, type Locator } from '@playwright/test';
import { eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { collections, collectionGames } from '@/db/schema/collections';
import { signUpFresh, runTag, createAdf } from './helpers';
import { cleanupSeeded, seedDisk, addDisk, pairDevice, authHeader } from './device-helpers';

// The library table as the grid condensed (operator design 2026-10-21):
// collections as folder rows at the root with an up row back, the card's
// controls on every row, drag onto a rail collection, the view toggle that
// keeps the collection, and the per-user default view.

/** Collections made here, removed after the run; see collections.spec.ts on why under a real org only. */
const seededCollectionIds: string[] = [];

test.afterAll(async () => {
  const ids = seededCollectionIds.splice(0);
  if (ids.length > 0) {
    try { await getDb().delete(collections).where(inArray(collections.id, ids)); } catch (e) {
      console.warn('collections cleanup: best effort —', (e as Error).message);
    }
  }
  await cleanupSeeded();
});

const sha = (s: string) => createHash('sha256').update(`libtable-${s}`).digest('hex');

async function apiCreateCollection(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/collections', { data: { name } });
  if (res.status() !== 200) throw new Error(`test setup: create collection failed with ${res.status()}`);
  const { id } = await res.json() as { id: string };
  seededCollectionIds.push(id);
  return id;
}

async function apiAddGame(page: Page, collectionId: string, gameId: string) {
  const res = await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId } });
  if (res.status() !== 200) throw new Error(`test setup: add game failed with ${res.status()}`);
}

async function membership(collectionId: string): Promise<string[]> {
  const rows = await getDb().select({ gameId: collectionGames.gameId }).from(collectionGames)
    .where(eq(collectionGames.collectionId, collectionId));
  return rows.map((r) => r.gameId);
}

const row = (page: Page, title: string) => page.getByTestId('game-row').filter({ hasText: title });
const folder = (page: Page, id: string) => page.locator(`[data-testid="folder-row"][data-collection-id="${id}"]`);
const railRow = (page: Page, id: string) => page.locator(`[data-testid="collection-row"][data-collection-id="${id}"]`);

/** The rows' test ids in rendered order, e.g. ['folder-row', 'folder-row', 'game-row']. */
async function rowKinds(page: Page): Promise<string[]> {
  return page.getByTestId('game-table').locator('[data-testid="up-row"], [data-testid="folder-row"], [data-testid="game-row"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
}

/** The real pointer, past dnd-kit's 8px threshold first (collections.spec.ts dragOnto explains the steps). */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag: source or target is not visible');
  // Pressed on the title cell, away from the controls at the row's end.
  const sx = from.x + 120;
  const sy = from.y + from.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 2 });
  await page.mouse.up();
}

test('the table root lists collections as folders before the uncategorized titles, and a folder opens', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const inbox = await seedDisk(u.orgId, { title: `Loose ${run}`, diskNo: 1, sha256: sha(`loose-${run}`) });
  const filed = await seedDisk(u.orgId, { title: `Filed ${run}`, diskNo: 1, sha256: sha(`filed-${run}`) });
  await addDisk(u.orgId, filed.gameId, { diskNo: 2, sha256: sha(`filed2-${run}`) });
  const first = await apiCreateCollection(page, `Alpha ${run}`);
  const second = await apiCreateCollection(page, `Beta ${run}`);
  await apiAddGame(page, first, filed.gameId);

  await page.goto('/library?view=table');
  // Folders first, in the collections' own order, then the inbox's one title.
  expect(await rowKinds(page)).toEqual(['folder-row', 'folder-row', 'game-row']);
  await expect(page.getByTestId('folder-row').first()).toHaveAttribute('data-collection-id', first);
  await expect(folder(page, first).getByTestId('folder-titles')).toHaveText('1 title');
  await expect(folder(page, first).getByTestId('folder-disks')).toHaveText('2');
  await expect(folder(page, second).getByTestId('folder-titles')).toHaveText('0 titles');
  await expect(folder(page, first)).toHaveAttribute('aria-label', `Open collection Alpha ${run}, 1 title, 2 disks`);
  await expect(row(page, `Loose ${run}`)).toHaveAttribute('href', `/games/${inbox.gameId}`);
  // No SHA-256 column any more, and no overview mosaics.
  await expect(page.getByTestId('game-table')).not.toContainText('SHA-256');
  await expect(page.getByTestId('category-overview')).toHaveCount(0);

  // A folder is a link reachable from the keyboard: focus it, Enter opens it,
  // and the table is kept.
  await folder(page, first).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`view=table.*collection=${first}`));
  expect(await rowKinds(page)).toEqual(['up-row', 'game-row']);
  await expect(row(page, `Filed ${run}`)).toBeVisible();

  // ...and the up row leads back to the root, still in the table.
  await expect(page.getByTestId('up-row')).toHaveAccessibleName('Up to Library');
  await page.getByTestId('up-row').click();
  await expect(page).toHaveURL(/\/library\?view=table$/);
  expect(await rowKinds(page)).toEqual(['folder-row', 'folder-row', 'game-row']);
});

test('an empty inbox in the table shows the folders, not the overview', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const g = await seedDisk(u.orgId, { title: `Tidy ${run}`, diskNo: 1, sha256: sha(`tidy-${run}`) });
  const id = await apiCreateCollection(page, `Shelf ${run}`);
  await apiAddGame(page, id, g.gameId);

  await page.goto('/library?view=table');
  await expect(page.getByTestId('category-overview')).toHaveCount(0);
  expect(await rowKinds(page)).toEqual(['folder-row']);
  // The grid keeps its overview.
  await page.getByLabel('Grid view').click();
  await expect(page.getByTestId('category-overview')).toBeVisible();
});

test('All titles in the table: an up row, then every title flat', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const a = await seedDisk(u.orgId, { title: `Everywhere A ${run}`, diskNo: 1, sha256: sha(`all-a-${run}`) });
  await seedDisk(u.orgId, { title: `Everywhere B ${run}`, diskNo: 1, sha256: sha(`all-b-${run}`) });
  const id = await apiCreateCollection(page, `Some ${run}`);
  await apiAddGame(page, id, a.gameId);

  await page.goto('/library?view=table');
  // The rail keeps the table.
  await page.getByTestId('collection-all').click();
  await expect(page).toHaveURL(/collection=all/);
  await expect(page).toHaveURL(/view=table/);
  expect(await rowKinds(page)).toEqual(['up-row', 'game-row', 'game-row']);
  await page.getByTestId('up-row').click();
  await expect(page).toHaveURL(/\/library\?view=table$/);
});

test('a row carries the card controls, and its delete asks first without leaving the library', async ({ page, request }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const t = `Controls ${run}`;
  const { gameId, diskId } = await seedDisk(u.orgId, { title: t, diskNo: 1, sha256: sha(`ctl-${run}`) });
  const { deviceId, token } = await pairDevice(page, request, `Bench ${run.slice(0, 6)}`);
  const id = await apiCreateCollection(page, `Parity ${run}`);
  await apiAddGame(page, id, gameId);

  await page.goto(`/library?view=table&collection=${id}`);
  const r = row(page, t);
  // The card's order: history, mount, (fob only with a reader), remove, delete.
  const controls = await r.locator('button').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(controls).toEqual([`history-${gameId}`, `card-mount-${gameId}`, `remove-from-collection-${gameId}`, `delete-game-${gameId}`]);
  // No reader in this org: no fob button, as on the card.
  await expect(r.getByTestId(`fob-${gameId}`)).toHaveCount(0);

  // Mount from the row: the marker goes on the row and the click stays here.
  await r.getByTestId(`card-mount-${gameId}`).click();
  await expect(page.getByText('Mount requested')).toBeVisible();
  await expect(page).toHaveURL(/\/library/);
  await expect(r).toHaveAttribute('data-drive', 'fetching');
  await expect(r.getByTestId('drive-ring')).toBeVisible();
  // The board confirms: solid, and the row's control is Eject.
  const [board] = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  expect(board.desiredDiskId).toBe(diskId);
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: board.desiredSha256, mountedDiskId: diskId, version: board.desiredVersion },
  })).status()).toBe(204);
  await page.reload();
  await expect(r).toHaveAttribute('data-drive', 'mounted');
  await expect(r.getByTestId(`card-eject-${gameId}`)).toBeVisible();

  // Delete asks, and Cancel keeps the title.
  await r.getByTestId(`delete-game-${gameId}`).click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await expect(page).toHaveURL(/\/library/);
  await page.getByTestId('delete-cancel').click();
  await expect(page.getByTestId('delete-dialog')).toHaveCount(0);
  await r.getByTestId(`delete-game-${gameId}`).click();
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('game-row')).toHaveCount(0);
  expect(await getDb().select().from(games).where(eq(games.id, gameId))).toHaveLength(0);
});

test('remove from collection on a row takes it out of the collection, not the library', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const t = `Removable ${run}`;
  const { gameId } = await seedDisk(u.orgId, { title: t, diskNo: 1, sha256: sha(`rm-${run}`) });
  const id = await apiCreateCollection(page, `Out ${run}`);
  await apiAddGame(page, id, gameId);

  await page.goto(`/library?view=table&collection=${id}`);
  await row(page, t).getByTestId(`remove-from-collection-${gameId}`).click();
  await expect(page.getByTestId('game-row')).toHaveCount(0);
  // An emptied collection says so, rather than showing an up row alone (final review M2).
  await expect(page.getByTestId('table-empty-note')).toContainText('No titles in this collection yet');
  await expect(page).toHaveURL(new RegExp(`collection=${id}`));
  expect(await membership(id)).toEqual([]);
  expect(await getDb().select().from(games).where(eq(games.id, gameId))).toHaveLength(1);
});

test('an authored title renames in place on its row', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library?view=table');
  await createAdf(page);
  const field = page.getByTestId('game-row').first().locator('[data-testid^="volume-name-"]');
  await expect(field).toBeVisible();
  // Typing in it does not open the title.
  await field.click();
  await expect(page).toHaveURL(/\/library/);
});

test('dragging a row onto a rail collection files it there', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const t = `Dragged row ${run}`;
  const { gameId } = await seedDisk(u.orgId, { title: t, diskNo: 1, sha256: sha(`drag-${run}`) });
  const id = await apiCreateCollection(page, `Row target ${run}`);

  await page.goto('/library?view=table');
  await expect(railRow(page, id).getByTestId('collection-count')).toHaveText('0');
  await dragOnto(page, row(page, t), railRow(page, id));

  await expect.poll(async () => await membership(id), { timeout: 10_000 }).toEqual([gameId]);
  // It leaves the inbox: the row is gone and the folder counts it.
  await expect(row(page, t)).toHaveCount(0, { timeout: 10_000 });
  await expect(folder(page, id).getByTestId('folder-titles')).toHaveText('1 title');
  // The drag did not fall through to the row's link.
  await expect(page).toHaveURL(/\/library\?view=table$/);
});

test('the view toggle keeps the collection you are in', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Kept ${run}`, diskNo: 1, sha256: sha(`kept-${run}`) });
  const id = await apiCreateCollection(page, `Stay ${run}`);
  await apiAddGame(page, id, gameId);

  await page.goto(`/library?collection=${id}`);
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await page.getByLabel('Table view').click();
  await expect(page).toHaveURL(new RegExp(`view=table&collection=${id}`));
  expect(await rowKinds(page)).toEqual(['up-row', 'game-row']);
  await page.getByLabel('Grid view').click();
  await expect(page).toHaveURL(new RegExp(`view=grid&collection=${id}`));
  await expect(page.getByTestId('game-card')).toHaveCount(1);
});

test('Library opens in Table: /library opens in the table, and ?view=grid still shows the grid', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await expect(page.getByTestId('game-grid')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  await page.getByTestId('pref-library-view').selectOption('table');
  await page.getByTestId('prefs-save').click();
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  expect((await (await page.request.get('/api/me/prefs')).json()).library.view).toBe('table');

  await page.goto('/library');
  await expect(page.getByTestId('game-table')).toBeVisible();
  await expect(page.getByLabel('Table view')).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/library?view=grid');
  await expect(page.getByTestId('game-grid')).toBeVisible();
});

test('with a reader in the org, a row shows the fob button in the card\'s place', async ({ page, request }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, nfcReader: 'present' },
  })).status()).toBe(204);
  const { gameId } = await seedDisk(u.orgId, { title: `Fob row ${run}`, diskNo: 1, sha256: sha(`fob-${run}`) });

  await page.goto('/library?view=table');
  const controls = await row(page, `Fob row ${run}`).locator('button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(controls).toEqual([`history-${gameId}`, `card-mount-${gameId}`, `fob-${gameId}`, `delete-game-${gameId}`]);
});
