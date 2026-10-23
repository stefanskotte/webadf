import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { collectionGames } from '@/db/schema/collections';
import { ARM_DELAY_MS } from '@/lib/set-folder';
import { signUpFresh, runTag, createAdf } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';

// Library paging (operator 2026-10-22): a page at a time in the grid and the table, the size a per-user setting
// (library.pageSize: 24/48/96/192/all, default 48) set in Preferences or by the pager's Per page.

// Seeding 26-30 titles row by row takes a while on the dev server.
test.describe.configure({ timeout: 120_000 });

test.afterAll(async () => { await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(`paging-${s}`).digest('hex');
const pad = (i: number) => String(i).padStart(2, '0');

/** `n` single-disk titles "<prefix> 01 <run>" .. and A-to-Z order with 24 a page, so the pages are known. */
async function seedTitles(page: Page, orgId: string, prefix: string, n: number) {
  const run = runTag();
  const out: { gameId: string; title: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const title = `${prefix} ${pad(i)} ${run}`;
    const { gameId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`${run}-${prefix}-${i}`) });
    out.push({ gameId, title });
  }
  const res = await page.request.patch('/api/me/prefs', { data: { library: { pageSize: 24, sort: { key: 'title', dir: 'asc' } } } });
  expect(res.status()).toBe(200);
  return out;
}

const cards = (page: Page) => page.getByTestId('game-card');
const rows = (page: Page) => page.getByTestId('game-row');
const gridIds = (page: Page) => cards(page).evaluateAll((els) =>
  els.map((el) => new URL(el.getAttribute('href') ?? '', 'http://x').pathname.split('/').pop() ?? ''));
const prefs = async (page: Page) => (await (await page.request.get('/api/me/prefs')).json()).library;

test('the grid shows a page at a time, and Next and the numbers move through them', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(page, orgId, 'Grid', 30);

  await page.goto('/library?collection=all');
  await expect(cards(page)).toHaveCount(24);
  await expect(page.getByText('30 titles · 30 disks')).toBeVisible();   // the whole view, not the page
  expect(await gridIds(page)).toEqual(t.slice(0, 24).map((x) => x.gameId));
  await expect(page.getByTestId('pager-page-1')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('pager-next').click();
  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  await expect(cards(page)).toHaveCount(6);
  expect(await gridIds(page)).toEqual(t.slice(24).map((x) => x.gameId));
  await expect(page.getByTestId('pager-next')).toHaveCount(0);

  await page.getByTestId('pager-page-1').click();
  await expect(cards(page)).toHaveCount(24);
  await expect(page).not.toHaveURL(/page=/);
});

test('a page past the end shows the last page, and junk is page 1', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await seedTitles(page, orgId, 'Stale', 26);
  await page.goto('/library?collection=all&page=9');
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByTestId('pager-page-2')).toHaveAttribute('aria-current', 'page');
  await page.goto('/library?collection=all&page=abc');
  await expect(cards(page)).toHaveCount(24);
});

test('switching to the table keeps the page; the table pages the same titles, with the folders on page 1 only', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(page, orgId, 'Table', 30);
  // One title filed, so the root (the inbox) holds 29 and lists the collection as a folder.
  const res = await page.request.post('/api/collections', { data: { name: `Paged ${runTag()}` } });
  const { id } = await res.json() as { id: string };
  expect((await page.request.post(`/api/collections/${id}/games`, { data: { gameId: t[0].gameId } })).status()).toBe(200);

  await page.goto('/library?page=2');
  await expect(cards(page)).toHaveCount(5);
  await page.getByLabel('Table view').click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByTestId('folder-row')).toHaveCount(0);

  await page.getByTestId('pager-page-1').click();
  await expect(rows(page)).toHaveCount(24);
  await expect(page.getByTestId('folder-row')).toHaveCount(1);
});

test('Per page saves the setting and starts again at page 1', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await seedTitles(page, orgId, 'Size', 30);
  await page.goto('/library?collection=all&page=2');
  await expect(cards(page)).toHaveCount(6);

  await page.getByTestId('pager-size').selectOption('48');
  await expect(page).not.toHaveURL(/page=/);
  await expect(cards(page)).toHaveCount(30);
  await expect(page.getByTestId('pager-next')).toHaveCount(0);
  expect((await prefs(page)).pageSize).toBe(48);

  // ...and it is the same setting the table uses.
  await page.goto('/library?collection=all&view=table');
  await expect(rows(page)).toHaveCount(30);
});

test('Titles per page in Preferences: All shows every title on one page, with no page numbers', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await seedTitles(page, orgId, 'Prefs', 30);
  await page.goto('/settings');
  await expect(page.getByTestId('pref-library-page-size')).toHaveValue('24');
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH'), page.getByTestId('pref-library-page-size').selectOption('all')]);
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  expect((await prefs(page)).pageSize).toBe('all');

  await page.goto('/library?collection=all');
  await expect(cards(page)).toHaveCount(30);
  await expect(page.getByTestId('pager-page-1')).toHaveCount(0);
  await expect(page.getByTestId('pager-size')).toHaveValue('all');
});

test('a new sort starts again at page 1', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(page, orgId, 'Sorted', 30);
  await page.goto('/library?collection=all&page=2');
  await expect(cards(page)).toHaveCount(6);
  await page.getByTestId('library-sort').selectOption({ label: 'Title Z–A' });
  await expect(page).not.toHaveURL(/page=/);
  await expect(cards(page)).toHaveCount(24);
  await expect.poll(async () => (await gridIds(page))[0]).toBe(t[29].gameId);
});

// --- a drag inside one page of a collection --------------------------------------------------------------------

type Box = { x: number; y: number; width: number; height: number };
const at = (b: Box, fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
async function walk(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n);
    await page.waitForTimeout(16);
  }
  return to;
}
async function pickUp(page: Page, source: Locator) {
  const p = at((await source.boundingBox())!, 0.5, 0.5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  return walk(page, p, { x: p.x + 12, y: p.y + 12 });
}
async function membership(collectionId: string): Promise<string[]> {
  const r = await getDb().select({ gameId: collectionGames.gameId }).from(collectionGames)
    .where(eq(collectionGames.collectionId, collectionId)).orderBy(collectionGames.sortKey, collectionGames.gameId);
  return r.map((x) => x.gameId);
}

test('dragging inside page 2 of a collection reorders those titles and leaves page 1 in place', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const t = await seedTitles(page, orgId, 'Drag', 26);
  const res = await page.request.post('/api/collections', { data: { name: `Drag ${runTag()}` } });
  const { id } = await res.json() as { id: string };
  // Filed in the database directly, in order: 26 API calls cost more than the drag being tested.
  await getDb().insert(collectionGames).values(t.map((x, i) => ({ collectionId: id, gameId: x.gameId, sortKey: i })));
  const before = t.map((x) => x.gameId);
  expect(await membership(id)).toEqual(before);

  await page.goto(`/library?collection=${id}&page=2`);
  await expect(cards(page)).toHaveCount(2);
  // The 26th title onto the 25th's LEFT edge: it takes the 25th's place (an edge never arms a set).
  const card = (title: string) => cards(page).filter({ hasText: title });
  const slot = (await card(t[24].title).boundingBox())!;
  const p = await pickUp(page, card(t[25].title));
  await walk(page, p, at(slot, 0.1, 0.5));
  await page.waitForTimeout(ARM_DELAY_MS + 300);
  await page.mouse.up();

  const expected = [...before.slice(0, 24), before[25], before[24]];
  // 15 s: on a cold dev server the order route compiles on this, its first call.
  await expect.poll(() => membership(id), { timeout: 15_000 }).toEqual(expected);   // the WHOLE collection, page 1 untouched
  await expect.poll(() => gridIds(page)).toEqual([before[25], before[24]]);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
});

// Operator 2026-10-22: a card says what is known -- year, publisher, or "made here" -- and nothing at all when
// nothing is, rather than "unidentified".
test('a card with nothing known shows no "unidentified" line, and a disk made here still says so', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const run = runTag();
  await seedDisk(orgId, { title: `Plain ${run}`, diskNo: 1, sha256: sha(`plain-${run}`) });
  await page.goto('/library?collection=all');
  const plain = cards(page).filter({ hasText: `Plain ${run}` });
  await expect(plain).toHaveCount(1);
  await expect(plain).not.toContainText('unidentified');
  await createAdf(page);
  await expect(cards(page)).toHaveCount(2);   // the new disk is in, on this page
  await expect(cards(page).filter({ hasText: 'made here' })).toHaveCount(1);
});
