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
  // Sorts BEFORE "Rainbow Islands" alphabetically (its sort_title is
  // derived straight from the title by seedDisk), and has nothing to do
  // with "rainbow" in its own name. If the ranking's
  // `CASE WHEN title ILIKE ... THEN 0 ELSE 1` clause were ever deleted and
  // the query fell back to its secondary `ORDER BY sort_title` alone, this
  // attribute-only match would wrongly sort first -- so only the ranking
  // clause, and nothing else, can make the assertion below pass.
  const { gameId: attrMatchId } = await seedDisk(u.orgId, { title: `Apidya ${run}`, diskNo: 1, sha256: sha('4') });

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

test('"/" focuses the search box, and does not type itself into it', async ({ page }) => {
  // The negative case below (not hijacking another input) existed from the
  // start; this positive one did not, so the shortcut could have been broken
  // outright and the suite would still have been green.
  await signUpFresh(page);
  await page.goto('/library');
  await page.locator('body').click();
  await page.keyboard.press('/');

  await expect(page.getByTestId('search-input')).toBeFocused();
  // Focused AND empty: preventDefault has to run, or the keystroke that
  // opened the box also lands in it and every search starts with a slash.
  await expect(page.getByTestId('search-input')).toHaveValue('');
});

test('the pill advertises the "/" shortcut until it is in use', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  const hint = page.getByTestId('search-hint');
  await expect(hint).toBeVisible();

  // Once focused the hint has served its purpose and would sit in the way of
  // the text.
  await page.getByTestId('search-input').focus();
  await expect(hint).toHaveCount(0);
});

test('"/" does not hijack typing in another input', async ({ page }) => {
  await signUpFresh(page);

  const createInput = page.getByTestId('collection-create');
  await createInput.click();
  await createInput.press('/');

  // toHaveValue polls/retries; a one-shot inputValue() snapshot would not.
  await expect(createInput).toHaveValue(/\//);
  await expect(page.getByTestId('search-input')).not.toBeFocused();
});

test('out-of-order responses do not win: a superseded request is aborted and its answer never paints', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Giana Sisters ${run}`, diskNo: 1, sha256: sha('6') });
  // A DISTINCT fixture that "gia" matches but "giana" does not -- "gia" is
  // itself a substring of "giana", so without this the stale and fresh
  // answers could share the exact same top row and the assertion below
  // could never fail no matter how badly the guard in search-box.tsx was
  // broken. Its real id is reused below so the fixture is genuinely seeded
  // (and genuinely cleaned up), even though its title is overridden in the
  // held response to be unmistakable.
  const { gameId: staleGameId } = await seedDisk(u.orgId, { title: `Nostalgia ${run}`, diskNo: 1, sha256: sha('6b') });

  // WHAT THIS TEST CAN AND CANNOT OBSERVE, because an earlier version of it
  // asserted something impossible and hung for the full 30s timeout:
  //
  // search-box.tsx has TWO guards. The first is the AbortController, which
  // cancels the superseded request. The second is a currentQueryRef
  // comparison on each landing response, for the sub-millisecond window in
  // which a response is already queued when abort() is called.
  //
  // The first guard makes the second UNOBSERVABLE from here. Once the page
  // aborts, Chromium emits `requestfailed` (net::ERR_ABORTED) and NEVER a
  // `response` event -- route.fulfill() still resolves, but it resolves into
  // a dead request. So `waitForResponse` on the superseded URL can never
  // fire, and a stale answer cannot be delivered over the network at all
  // while the abort works. That is the guard doing its job, not a flake.
  //
  // So this asserts the abort DIRECTLY (its failure reason), which is
  // sensitive to the guard being removed: without the AbortController the
  // superseded request completes with a 200 instead of failing. The
  // currentQueryRef guard is deliberately not covered here -- it defends a
  // window that cannot be forced open from outside the browser.
  let releaseStale: () => void = () => {};
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
  // Resolved once route.fulfill has actually returned, so the assertions
  // below wait on a real event rather than a guessed sleep.
  let markFulfilled: () => void = () => {};
  const staleFulfilled = new Promise<void>((resolve) => { markFulfilled = resolve; });

  // route.fulfill, not route.continue: the stale body is fully under this
  // test's control, so there is no ambiguity about what "the stale row" is.
  await page.route('**/api/search?q=gia', async (route) => {
    await staleGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        titles: [{ id: staleGameId, title: `STALE ROW ${run}`, year: null, publisher: null, diskCount: 1 }],
        collections: [],
      }),
    });
    markFulfilled();
  });

  await page.getByTestId('search-input').fill('gia');
  // Force the race window open deterministically: wait for the debounced
  // request to actually be SENT before typing the next query. Two fill()
  // calls landing within the 150ms debounce would otherwise clear the "gia"
  // timer before it ever fired -- the held route would never be hit at all,
  // and the test would pass having raced nothing.
  await page.waitForRequest('**/api/search?q=gia');

  // Armed BEFORE the keystroke that triggers the abort, or the event is
  // missed entirely. Raced against the response rather than awaited alone:
  // if the abort is ever removed, the superseded request COMPLETES instead
  // of failing, and racing the two makes that a fast, self-describing
  // failure ("responded:200") rather than a 30-second timeout on an event
  // that is never coming.
  const staleSettled = Promise.race([
    page.waitForEvent('requestfailed', (r) => r.url().includes('/api/search?q=gia'))
      .then((r) => `failed:${r.failure()?.errorText}`),
    page.waitForResponse('**/api/search?q=gia').then((r) => `responded:${r.status()}`),
  ]);

  await page.getByTestId('search-input').fill('giana');
  // The real, un-intercepted answer for "giana".
  await expect(page.getByTestId('search-result').first()).toContainText('Giana Sisters');

  // Release the held answer for the superseded query, well after "giana" has
  // been typed and answered. This has to happen BEFORE awaiting the race
  // above: with the abort removed there is no requestfailed event, and the
  // response cannot arrive until the gate opens -- awaiting first would hang
  // on exactly the mutation this is meant to catch.
  releaseStale();

  // Guard 1, asserted on the reason and not merely on "it did not arrive":
  // typing a newer query cancelled the older request.
  expect(await staleSettled).toBe('failed:net::ERR_ABORTED');
  await staleFulfilled;
  // A negative ("this never painted") needs a window to be meaningful. This
  // one is a completed in-page round trip rather than a magic number: the
  // stale delivery, if it were ever going to happen, was queued before this
  // fetch was even issued, so this request finishing means the browser has
  // moved past it.
  await page.evaluate(() => fetch('/api/search?q=zzbarrier').then((r) => r.json()));

  // The answer to the shorter, superseded query must never have painted the
  // panel -- neither as the top row nor anywhere else in it.
  await expect(page.getByText(`STALE ROW ${run}`)).toHaveCount(0);
  await expect(page.getByTestId('search-result').first()).toContainText('Giana Sisters');
});

test('the empty state says so, and is distinct from an empty query', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Present ${run}`, diskNo: 1, sha256: sha('7') });

  const input = page.getByTestId('search-input');
  const query = `Nothing Matches This ${run}`;
  const pattern = `**/api/search?q=${encodeURIComponent(query)}`;

  // Hold the response so the in-flight window is directly observable.
  // Under the earlier broken form, search-empty rendered on the very next
  // React commit -- before the debounce even elapsed, let alone before any
  // request was made -- so asserting toBeVisible() right after fill()
  // would pass in milliseconds with /api/search never called at all.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(pattern, async (route) => {
    await gate;
    await route.continue();
  });

  await input.fill(query);
  await page.waitForRequest(pattern);
  // Still in flight: nothing to show yet, and specifically not the
  // empty-state line.
  await expect(page.getByTestId('search-empty')).toHaveCount(0);

  // Same ordering concern as the out-of-order test above: arm the
  // listener before releasing the gate.
  const responded = page.waitForResponse(pattern);
  release();
  await responded;
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
  // The whole shape, not just titles -- a leaked '%' would match every
  // collection too, and a titles-only assertion would miss that.
  expect(body).toEqual({ titles: [], collections: [] });
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
