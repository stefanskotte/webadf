import { test, expect, type Page, type Locator } from '@playwright/test';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { games, blobs } from '@/db/schema/catalog';
import { collections, collectionGames } from '@/db/schema/collections';
import { user } from '@/db/schema/auth';
import { signUpFresh, runTag } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';

/**
 * Collections created by this file, tracked so the run cleans up after
 * itself rather than relying on the global teardown alone.
 *
 * EVERY collection here is created under an org that signUpFresh really
 * made, never under a placeholder org id. That is deliberate and is the one
 * fixture rule this file must not break: global-teardown reaches collections
 * only through deleteUserCascade, which finds them through a real user's
 * membership. A collection filed under an invented org id would be
 * unreachable by both this list and the teardown, and would sit in the live
 * database forever -- the exact shape that let 4,144 invite codes pile up.
 */
const seededCollectionIds: string[] = [];

test.afterAll(async () => {
  const db = getDb();
  const ids = seededCollectionIds.splice(0);
  if (ids.length > 0) {
    // collection_games follows by ON DELETE CASCADE (src/db/schema/collections.ts).
    try { await db.delete(collections).where(inArray(collections.id, ids)); } catch (e) {
      console.warn('collections cleanup: best effort —', (e as Error).message);
    }
  }
  await cleanupTosec();
  await cleanupSeeded();
});

/** Create a collection through the real route, and register it for cleanup. */
async function apiCreateCollection(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/collections', { data: { name } });
  if (res.status() !== 200) throw new Error(`test setup: create collection failed with ${res.status()}`);
  const created = await res.json();
  seededCollectionIds.push(created.id as string);
  return created.id as string;
}

async function apiAddGame(page: Page, collectionId: string, gameId: string) {
  const res = await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId } });
  if (res.status() !== 200) throw new Error(`test setup: add game failed with ${res.status()}`);
}

/** The membership of one collection, in stored order. */
async function membership(collectionId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ gameId: collectionGames.gameId, sortKey: collectionGames.sortKey })
    .from(collectionGames)
    .where(eq(collectionGames.collectionId, collectionId))
    .orderBy(collectionGames.sortKey, collectionGames.gameId);
  return rows.map((r) => r.gameId);
}

/** The rail row for a collection id, whatever it is currently named. */
function railRow(page: Page, collectionId: string): Locator {
  return page.locator(`[data-testid="collection-row"][data-collection-id="${collectionId}"]`);
}

/**
 * Drag with the real pointer, not `locator.dragTo()`.
 *
 * dnd-kit's PointerSensor is configured with an 8px activation constraint
 * (src/components/collections/collection-provider.tsx) -- without it every
 * click on a card, which is a Link, would start a drag instead of
 * navigating. That constraint means the sensor has to actually SEE movement
 * accumulate: a single jump from source to target is one pointermove, and
 * the intermediate `steps` below are what make the drag register at all.
 */
async function dragOnto(
  page: Page, source: Locator, target: Locator,
  // Runs while the pointer is HELD over the target, before the release --
  // the only moment the drop-target highlight exists to be asserted on.
  opts: { whileOver?: () => Promise<void> } = {},
) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag: source or target is not visible');

  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Past the 8px threshold first, then across to the target.
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(tx, ty, { steps: 15 });
  await page.mouse.move(tx, ty, { steps: 2 });
  if (opts.whileOver) await opts.whileOver();
  await page.mouse.up();
}

/**
 * The game ids of the cards in the grid, in RENDERED order.
 *
 * Read off each card's own href rather than its visible title: the card is
 * the <a> itself, and a title read out of the DOM would have to pick between
 * the cover overlay's copy of it and the caption's.
 */
async function cardGameIds(page: Page): Promise<string[]> {
  return page.getByTestId('game-card').evaluateAll((els) =>
    els.map((el) => (el.getAttribute('href') ?? '').replace('/games/', '')));
}

// ---------------------------------------------------------------------------

test('a collection is created, renamed and deleted from the rail, and its games survive', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const a = await seedDisk(u.orgId, { title: `Alpha ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'a') });
  const b = await seedDisk(u.orgId, { title: `Beta ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'b') });

  await page.goto('/library');

  // A library with no collections still renders: the rail is present and
  // says so, and both games are in the grid exactly as before this feature.
  await expect(page.getByTestId('collection-rail')).toBeVisible();
  await expect(page.getByText('No collections yet')).toBeVisible();
  await expect(page.getByTestId('game-card')).toHaveCount(2);

  // Create.
  const name = `Demos ${run}`;
  await page.getByTestId('collection-create').fill(name);
  await page.getByTestId('collection-create').press('Enter');

  const row = page.getByTestId('collection-row').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  const id = await row.getAttribute('data-collection-id');
  expect(id).toBeTruthy();
  seededCollectionIds.push(id!);
  await expect(row.getByTestId('collection-count')).toHaveText('0');

  // The count is live: file a game and the rail picks it up on refresh.
  await apiAddGame(page, id!, a.gameId);
  await page.reload();
  await expect(railRow(page, id!).getByTestId('collection-count')).toHaveText('1');

  // Rename, through the per-row menu.
  const renamed = `Cracktros ${run}`;
  await page.getByTestId(`collection-menu-${id}`).click();
  await page.getByTestId(`collection-rename-${id}`).click();
  const input = railRow(page, id!).locator('input');
  await expect(input).toBeVisible();
  await input.fill(renamed);
  await input.press('Enter');
  await expect(railRow(page, id!).getByTestId('collection-name')).toHaveText(renamed);
  expect((await getDb().select().from(collections).where(eq(collections.id, id!)))[0].name).toBe(renamed);

  // Delete. The confirm is a window.confirm, so the dialog must be handled
  // or Playwright dismisses it and the delete never fires.
  page.once('dialog', (d) => {
    // The one thing the copy has to say, because it is the reasonable fear.
    expect(d.message()).toContain('not deleted');
    void d.accept();
  });
  await page.getByTestId(`collection-menu-${id}`).click();
  await page.getByTestId(`collection-delete-${id}`).click();
  await expect(railRow(page, id!)).toHaveCount(0);

  const db = getDb();
  expect(await db.select().from(collections).where(eq(collections.id, id!))).toHaveLength(0);
  expect(await db.select().from(collectionGames).where(eq(collectionGames.collectionId, id!))).toHaveLength(0);

  // THE POINT: deleting a collection deletes no games.
  const surviving = await db.select().from(games).where(inArray(games.id, [a.gameId, b.gameId]));
  expect(surviving).toHaveLength(2);
});

test('filtering to a collection shows exactly its games', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const a = await seedDisk(u.orgId, { title: `Filtered ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'c') });
  await seedDisk(u.orgId, { title: `Unfiled ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'd') });

  const id = await apiCreateCollection(page, `Filter ${run}`);
  await apiAddGame(page, id, a.gameId);

  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(2);

  await page.goto(`/library?collection=${id}`);
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(page.getByTestId('game-card')).toContainText(`Filtered ${run}`);

  // A stale or foreign id must not break the library: it falls back to
  // unfiltered rather than 404ing.
  await page.goto(`/library?collection=${randomUUID()}`);
  await expect(page.getByTestId('game-card')).toHaveCount(2);
});

test('dragging a card onto a rail collection files it there', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Dragged ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'e') });

  const id = await apiCreateCollection(page, `Drop target ${run}`);
  await page.goto('/library');
  await expect(railRow(page, id).getByTestId('collection-count')).toHaveText('0');

  await dragOnto(page, page.getByTestId('game-card').first(), railRow(page, id));

  // The rail count is OPTIMISTIC -- the provider bumps it before the POST
  // lands -- so it proves the drop was understood, not that anything was
  // written. The membership has to be polled for the write itself.
  await expect(railRow(page, id).getByTestId('collection-count')).toHaveText('1', { timeout: 10_000 });
  await expect.poll(async () => await membership(id), { timeout: 10_000 })
    .toEqual([gameId]);
});

test('the rail highlights the collection a dragged title will actually land in', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: `Aimed ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'b') });

  // TWO collections, adjacent in the rail. One target is not a test: the bug
  // being guarded is not "nothing highlights", it is "the wrong one does".
  const missId = await apiCreateCollection(page, `Not this one ${run}`);
  const hitId = await apiCreateCollection(page, `This one ${run}`);

  await page.goto('/library');
  await expect(railRow(page, hitId)).toBeVisible();
  // Nothing is armed until a drag starts.
  await expect(railRow(page, hitId)).not.toHaveAttribute('data-drop-target', 'true');

  await dragOnto(page, page.getByTestId('game-card').first(), railRow(page, hitId), {
    whileOver: async () => {
      await expect(railRow(page, hitId)).toHaveAttribute('data-drop-target', 'true');
      await expect(railRow(page, missId)).not.toHaveAttribute('data-drop-target', 'true');
    },
  });

  // ...and the row that was highlighted is the row that got it. This pairing
  // is the whole point: a highlight computed independently of dnd-kit's own
  // collision detection could point confidently at the wrong row.
  await expect.poll(async () => await membership(hitId), { timeout: 10_000 }).toEqual([gameId]);
  expect(await membership(missId)).toEqual([]);

  // The highlight is released with the pointer.
  await expect(railRow(page, hitId)).not.toHaveAttribute('data-drop-target', 'true');
});

test('a reorder persists across a reload', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const seeded = [];
  for (const [i, letter] of ['1', '2', '3'].entries()) {
    seeded.push(await seedDisk(u.orgId, {
      title: `Ordered ${letter} ${run}`, diskNo: 1,
      sha256: randomUUID().replace(/-/g, '').padEnd(64, String(i)),
    }));
  }

  const id = await apiCreateCollection(page, `Ordered ${run}`);
  for (const s of seeded) await apiAddGame(page, id, s.gameId);
  const original = seeded.map((s) => s.gameId);
  expect(await membership(id)).toEqual(original);

  const reversed = [...original].reverse();
  const res = await page.request.patch(`/api/collections/${id}/order`, { data: { ids: reversed } });
  expect(res.status()).toBe(200);
  expect(await membership(id)).toEqual(reversed);

  // ...and the grid renders it that way, which is the half a stored sortKey
  // nobody reads would not prove.
  await page.goto(`/library?collection=${id}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  expect(await cardGameIds(page)).toEqual(reversed);
});

test('the per-card control removes a game from the collection, not from the library', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const a = await seedDisk(u.orgId, { title: `Removable ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'f') });
  const b = await seedDisk(u.orgId, { title: `Stays ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, '7') });

  const id = await apiCreateCollection(page, `Removals ${run}`);
  await apiAddGame(page, id, a.gameId);
  await apiAddGame(page, id, b.gameId);

  await page.goto(`/library?collection=${id}`);
  await expect(page.getByTestId('game-card')).toHaveCount(2);

  await page.getByTestId(`remove-from-collection-${a.gameId}`).click();
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(page.getByTestId('game-card')).toContainText(`Stays ${run}`);
  expect(await membership(id)).toEqual([b.gameId]);

  // ...and the game itself is untouched: still in the library, still a row.
  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  await expect(page.getByTestId('game-card').filter({ hasText: `Removable ${run}` })).toHaveCount(1);
  expect(await getDb().select().from(games).where(eq(games.id, a.gameId))).toHaveLength(1);

  // The control is offered ONLY inside a collection: "remove from collection"
  // means nothing in the unfiltered library, and there is no id to remove from.
  await expect(page.getByTestId(`remove-from-collection-${b.gameId}`)).toHaveCount(0);
});

test('a reorder can never change membership', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const a = await seedDisk(u.orgId, { title: `Member A ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, '8') });
  const b = await seedDisk(u.orgId, { title: `Member B ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, '9') });
  const stranger = await seedDisk(u.orgId, { title: `Stranger ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'e') });

  const id = await apiCreateCollection(page, `Strict ${run}`);
  await apiAddGame(page, id, a.gameId);
  await apiAddGame(page, id, b.gameId);
  const before = await membership(id);
  expect(before).toEqual([a.gameId, b.gameId]);

  const cases: Array<[string, string[], string]> = [
    ['an id that is not a member', [a.gameId, b.gameId, stranger.gameId], 'unknown_id'],
    ['the same id twice', [a.gameId, a.gameId], 'duplicate_id'],
    ['a member left out', [a.gameId], 'missing_id'],
  ];

  for (const [what, ids, error] of cases) {
    const res = await page.request.patch(`/api/collections/${id}/order`, { data: { ids } });
    expect(res.status(), what).toBe(400);
    expect((await res.json()).error, what).toBe(error);
    // Rejected is not enough: the membership must be untouched after each.
    expect(await membership(id), what).toEqual(before);
  }
});

// The two merge tests below run a real sweep. Both use the long timeout for
// the reason tosec-scan.spec.ts documents at length: a DAT import anywhere in
// the suite resets every blob's match verdict, so a sweep here can be handed
// the live database's whole blob population and legitimately run for minutes.
const SWEEP_TIMEOUT_MS = 280_000;

/** Give a blob known hashes directly, so the sweeper's match phase can run. */
async function fakeHashes(sha256: string) {
  const sha1 = createHash('sha1').update(sha256).digest('hex');
  await getDb().update(blobs)
    .set({ sha1, md5: null, crc32: null, hashedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
  return sha1;
}

/**
 * Two seeded games in one org that a TOSEC scan will collapse into one, both
 * pointed at the same title. Returns them in mergeDuplicates' OWN survivor
 * order -- (createdAt, id), the order that function sorts by -- so a test
 * never has to guess which row a sweep will keep.
 */
async function seedMergePair(orgId: string, setName: string, title: string) {
  const shas = [
    randomUUID().replace(/-/g, '').padEnd(64, '3'),
    randomUUID().replace(/-/g, '').padEnd(64, '4'),
  ];
  const seeded = [
    await seedDisk(orgId, { title: `${title} lower`, diskNo: 1, sha256: shas[0] }),
    await seedDisk(orgId, { title: `${title} UPPER`, diskNo: 2, sha256: shas[1] }),
  ];

  for (const [i, sha] of shas.entries()) {
    const sha1 = await fakeHashes(sha);
    await seedTosecEntry({
      // setName must be unique per test: seedTosecEntry derives its row id
      // from (setName, romName) and NOT from the sha1, so two tests sharing
      // both would collide onto one row and its onConflictDoNothing would
      // silently keep the first test's hash -- making a match here impossible
      // no matter what the sweeper does. tosec-scan.spec.ts found this the
      // hard way.
      setName,
      gameName: `${title} (1991)(Rainbow Arts)(Disk ${i + 1} of 2)`,
      romName: `${title} (1991)(Rainbow Arts)(Disk ${i + 1} of 2).adf`,
      sha1, title, sortTitle: title.toLowerCase(),
      year: 1991, publisher: 'Rainbow Arts', diskNo: i + 1, diskCount: 2,
    });
  }

  // mergeDuplicates orders by (games.createdAt, games.id) and, with no
  // human-edited row among them, keeps the first. Reading that order back
  // rather than assuming it makes these tests independent of insert timing.
  const ordered = await getDb()
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.orgId, orgId), inArray(games.id, seeded.map((s) => s.gameId))))
    .orderBy(games.createdAt, games.id);

  return { survivor: ordered[0].id, absorbed: ordered[1].id };
}

test('a merge that collapses two games in ONE collection leaves exactly one entry', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const run = runTag();
  const u = await signUpFresh(page);
  const title = `Turrican Merge ${run}`;
  const { survivor, absorbed } = await seedMergePair(u.orgId, `e2e-collections-merge-${run}`, title);

  // BOTH in one collection -- the hard case (design section 3.1). A bare
  // repoint here would violate collection_games' primary key, and because
  // db.batch() is atomic that aborts the whole merge and the sweeper retries
  // it forever.
  const id = await apiCreateCollection(page, `Merge ${run}`);
  await apiAddGame(page, id, survivor);
  await apiAddGame(page, id, absorbed);
  expect(await membership(id)).toHaveLength(2);

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const db = getDb();
  // ASSERT THE MERGE ACTUALLY FIRED FIRST. Without this the collection
  // assertion below passes on a no-op sweep and proves nothing.
  const remaining = await db.select().from(games).where(eq(games.orgId, u.orgId));
  expect(remaining).toHaveLength(1);
  expect(remaining[0].id).toBe(survivor);

  expect(await membership(id)).toEqual([survivor]);
});

test('a merge repoints a collection entry onto the surviving game', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const run = runTag();
  const u = await signUpFresh(page);
  const title = `Repoint Merge ${run}`;
  const { survivor, absorbed } = await seedMergePair(u.orgId, `e2e-collections-repoint-${run}`, title);

  // ONLY the absorbed game is filed. Its row must MOVE to the survivor; the
  // ON DELETE CASCADE on collection_games.game_id would otherwise take it
  // out silently, which is the failure this whole integration exists to stop.
  const id = await apiCreateCollection(page, `Repoint ${run}`);
  await apiAddGame(page, id, absorbed);
  expect(await membership(id)).toEqual([absorbed]);

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const db = getDb();
  const remaining = await db.select().from(games).where(eq(games.orgId, u.orgId));
  expect(remaining).toHaveLength(1);
  expect(remaining[0].id).toBe(survivor);

  expect(await membership(id)).toEqual([survivor]);
});

test('another org gets 404 from every collection route, and sees none of them', async ({ browser }) => {
  const run = runTag();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const a = await signUpFresh(pageA);
  const b = await signUpFresh(pageB);
  const mine = await seedDisk(a.orgId, { title: `Tenant A ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, '5') });
  const theirs = await seedDisk(b.orgId, { title: `Tenant B ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, '6') });

  const id = await apiCreateCollection(pageA, `Private ${run}`);
  await apiAddGame(pageA, id, mine.gameId);

  // 404, never 403: B must not be able to tell "someone else's" from "absent".
  expect((await pageB.request.patch(`/api/collections/${id}`, { data: { name: 'stolen' } })).status()).toBe(404);
  expect((await pageB.request.post(`/api/collections/${id}/games`, { data: { gameId: theirs.gameId } })).status()).toBe(404);
  expect((await pageB.request.delete(`/api/collections/${id}/games/${mine.gameId}`)).status()).toBe(404);
  expect((await pageB.request.patch(`/api/collections/${id}/order`, { data: { ids: [mine.gameId] } })).status()).toBe(404);
  expect((await pageB.request.delete(`/api/collections/${id}`)).status()).toBe(404);

  // None of it landed.
  expect(await membership(id)).toEqual([mine.gameId]);
  expect((await getDb().select().from(collections).where(eq(collections.id, id)))[0].name).toBe(`Private ${run}`);

  // ...and B's rail does not list it.
  expect(await (await pageB.request.get('/api/collections')).json()).toHaveLength(0);
  await pageB.goto('/library');
  await expect(pageB.getByTestId('collection-rail')).toBeVisible();
  await expect(pageB.getByTestId('collection-row')).toHaveCount(0);

  // A still has it, and filtering to it still works for A.
  await pageA.goto(`/library?collection=${id}`);
  await expect(pageA.getByTestId('game-card')).toHaveCount(1);

  await ctxA.close();
  await ctxB.close();
});

test('deleting a user deletes their collections', async ({ page }) => {
  const run = runTag();
  const victim = await signUpFresh(page);
  const seededGame = await seedDisk(victim.orgId, { title: `Doomed ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, '2') });
  const id = await apiCreateCollection(page, `Doomed ${run}`);
  await apiAddGame(page, id, seededGame.gameId);

  const db = getDb();
  expect(await db.select().from(collections).where(eq(collections.orgId, victim.orgId))).toHaveLength(1);

  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  await page.getByTestId(`delete-user-${victim.email}`).click();
  await page.getByLabel(/type the email/i).fill(victim.email);
  await page.getByRole('button', { name: /delete permanently/i }).click();
  await expect(page.getByTestId(`user-row-${victim.email}`)).toHaveCount(0);

  expect(await db.select().from(user).where(eq(user.email, victim.email))).toHaveLength(0);
  expect(await db.select().from(collections).where(eq(collections.orgId, victim.orgId))).toHaveLength(0);
  expect(await db.select().from(collectionGames).where(eq(collectionGames.collectionId, id))).toHaveLength(0);
});
