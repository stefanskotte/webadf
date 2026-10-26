import { test, expect, type Page } from '@playwright/test';
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
// By title: the cards carry no data-game-id until Task 3 adds the boxes.
const card = (page: Page, title: string) => page.getByTestId('game-card').filter({ hasText: title });
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
  await expect(card(page, a.title)).toBeVisible();
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
