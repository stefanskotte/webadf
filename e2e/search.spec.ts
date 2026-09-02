import { test, expect, type Page } from '@playwright/test';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { collections } from '@/db/schema/collections';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

// Cmd+K on macOS, Ctrl+K everywhere else -- the component's own listener
// accepts either (e.metaKey || e.ctrlKey), so the test has to pick the one
// that matches the platform this suite is actually running on.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Collections created by this file, tracked the same way collections.spec.ts
 * does: EVERY one here is filed under an org signUpFresh really made, never
 * a placeholder id, so this list and cleanupSeeded's org purge can both
 * reach it. See that file's comment on seededCollectionIds for the reason.
 */
const seededCollectionIds: string[] = [];

test.afterAll(async () => {
  const db = getDb();
  const ids = seededCollectionIds.splice(0);
  if (ids.length > 0) {
    try { await db.delete(collections).where(inArray(collections.id, ids)); } catch (e) {
      console.warn('collections cleanup: best effort —', (e as Error).message);
    }
  }
  await cleanupSeeded();
});

async function apiCreateCollection(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/collections', { data: { name } });
  if (res.status() !== 200) throw new Error(`test setup: create collection failed with ${res.status()}`);
  const created = await res.json();
  seededCollectionIds.push(created.id as string);
  return created.id as string;
}

const sha = (tag: string) => randomUUID().replace(/-/g, '').padEnd(64, tag);

// ---------------------------------------------------------------------------

test('typing finds a title, and Enter opens it', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Zool ${run}`, diskNo: 1, sha256: sha('1') });

  const input = page.getByTestId('search-input');
  await input.fill('Zool');

  const result = page.getByTestId('search-result').first();
  await expect(result).toHaveAttribute('data-result-id', gameId);
  await input.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/games/${gameId}$`));
});

test('a middle-of-string fragment matches', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Giana Sisters - Special Edition ${run}`, diskNo: 1, sha256: sha('2') });

  await page.getByTestId('search-input').fill('sisters');

  const result = page.getByTestId('search-result').first();
  await expect(result).toContainText('Giana Sisters');
});

test('an attribute match works and ranks below a name match', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId: nameMatchId } = await seedDisk(u.orgId, { title: `Rainbow Islands ${run}`, diskNo: 1, sha256: sha('3') });
  const { gameId: attrMatchId } = await seedDisk(u.orgId, { title: `Turrican II ${run}`, diskNo: 1, sha256: sha('4') });

  // seedDisk sets no publisher -- write it directly, as the brief says to.
  await getDb().update(games).set({ publisher: 'Rainbow Arts' }).where(eq(games.id, attrMatchId));

  await page.getByTestId('search-input').fill('rainbow');

  const results = page.getByTestId('search-result');
  await expect(results).toHaveCount(2);
  await expect(results.first()).toHaveAttribute('data-result-id', nameMatchId);
  await expect(results.last()).toHaveAttribute('data-result-id', attrMatchId);
});

test('a collection result navigates to ?collection=<id>', async ({ page }) => {
  const run = runTag();
  await signUpFresh(page);
  const id = await apiCreateCollection(page, `Arcade Faves ${run}`);

  const input = page.getByTestId('search-input');
  await input.fill('Arcade Faves');

  const result = page.getByTestId('search-result').first();
  await expect(result).toHaveAttribute('data-result-kind', 'collection');
  await expect(result).toHaveAttribute('data-result-id', id);
  await input.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/library\\?collection=${id}$`));
});

test('Escape closes the panel, and Cmd/Ctrl+K focuses the input', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Escape Target ${run}`, diskNo: 1, sha256: sha('5') });

  const input = page.getByTestId('search-input');
  await input.fill('Escape Target');
  await expect(page.getByTestId('search-result').first()).toBeVisible();

  await input.press('Escape');
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
  await expect(input).not.toBeFocused();

  await page.keyboard.press(`${MOD}+k`);
  await expect(input).toBeFocused();
});

test('"/" does not hijack typing in another input', async ({ page }) => {
  await signUpFresh(page);

  const createInput = page.getByTestId('collection-create');
  await createInput.click();
  await createInput.press('/');

  expect(await createInput.inputValue()).toContain('/');
  await expect(page.getByTestId('search-input')).not.toBeFocused();
});

test('out-of-order responses do not win: a slow answer for a shorter query never replaces a newer one', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Giana Sisters ${run}`, diskNo: 1, sha256: sha('6') });

  // Hold the response for "gia" until well after "giana" has been typed
  // and answered. The route pattern matches the real request URL exactly,
  // including its (unencoded, here -- "gia" has nothing to encode) query
  // string.
  await page.route('**/api/search?q=gia', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });

  await page.getByTestId('search-input').fill('gia');
  await page.getByTestId('search-input').fill('giana');

  // The slow answer for the shorter query must never replace the newer one.
  await expect(page.getByTestId('search-result').first()).toContainText('Giana');
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('search-result').first()).toContainText('Giana');
});

test('the empty state says so, and is distinct from an empty query', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Present ${run}`, diskNo: 1, sha256: sha('7') });

  const input = page.getByTestId('search-input');

  // A query matching nothing: the empty-state message, not a blank panel.
  await input.fill(`Nothing Matches This ${run}`);
  await expect(page.getByTestId('search-empty')).toBeVisible();
  await expect(page.getByTestId('search-panel')).toBeVisible();

  // Clearing the field back to empty: no panel at all, not even the
  // empty-state message -- these are different states.
  await input.fill('');
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
  await expect(page.getByTestId('search-empty')).toHaveCount(0);
});

test('cross-tenant search returns nothing, in the exact shape of a genuine miss', async ({ browser }) => {
  const run = runTag();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const a = await signUpFresh(pageA);
  await signUpFresh(pageB);
  const title = `Tenant Exclusive ${run}`;
  await seedDisk(a.orgId, { title, diskNo: 1, sha256: sha('8') });

  // B searches A's EXACT title.
  const resExact = await pageB.request.get(`/api/search?q=${encodeURIComponent(title)}`);
  expect(resExact.status()).toBe(200);
  const bodyExact = await resExact.json();

  // A genuine miss, from the same org, for comparison.
  const resMiss = await pageB.request.get(`/api/search?q=${encodeURIComponent(`Nothing At All ${run}`)}`);
  expect(resMiss.status()).toBe(200);
  const bodyMiss = await resMiss.json();

  expect(bodyExact).toEqual({ titles: [], collections: [] });
  expect(bodyExact).toEqual(bodyMiss);

  await ctxA.close();
  await ctxB.close();
});

test('a lone "%" matches nothing rather than the caller\'s whole library', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Percent Guard ${run}`, diskNo: 1, sha256: sha('9') });

  const res = await page.request.get('/api/search?q=%25');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.titles).toEqual([]);
});

test('defence in depth: a drifted disk is neither surfaced nor counted', async ({ browser }) => {
  const run = runTag();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const a = await signUpFresh(pageA);
  const b = await signUpFresh(pageB);
  const title = `Drifted ${run}`;
  const { gameId, diskId } = await seedDisk(a.orgId, { title, diskNo: 1, sha256: sha('a') });

  // Nothing in the schema stops a disks row's org_id from diverging from its
  // game's org -- see game-detail.spec.ts's sibling test. Written directly:
  // game_id still names org A's game, but org_id now names org B.
  await getDb().update(disks).set({ orgId: b.orgId }).where(eq(disks.id, diskId));

  // B's search for the title returns nothing -- the game itself is org A's.
  const resB = await pageB.request.get(`/api/search?q=${encodeURIComponent(title)}`);
  expect(resB.status()).toBe(200);
  expect((await resB.json()).titles).toEqual([]);

  // A still sees its own game, but the drifted disk is not counted: the
  // join requires disks.orgId = the caller's org, which this row no longer
  // satisfies, so the title's diskCount reports 0 rather than 1.
  const resA = await pageA.request.get(`/api/search?q=${encodeURIComponent(title)}`);
  expect(resA.status()).toBe(200);
  const bodyA = await resA.json();
  expect(bodyA.titles).toHaveLength(1);
  expect(bodyA.titles[0].id).toBe(gameId);
  expect(bodyA.titles[0].diskCount).toBe(0);

  await ctxA.close();
  await ctxB.close();
});
