import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, blobs } from '@/db/schema/catalog';
import { makeSortTitle } from '@/lib/tosec';
import { applyMatch } from '@/lib/tosec-apply';
import { unlinkDemozoo } from '@/lib/demozoo/apply';
import { diskStore } from '@/lib/storage';
import { signUpFresh } from './helpers';
import { seedDisk, addDisk, cleanupSeeded } from './device-helpers';
import { seedProduction, seedDemozooImage, seedSuggestion, linkAutomatic, cleanupDemozoo } from './demozoo-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';
import { signInAsSuperAdmin } from './admin-helpers';

// e2e/device-helpers.ts's cleanupSeeded() deletes the `blobs` DB row it
// tracks but never uploads real bytes for a seedDisk-created blob, so it has
// no reason to call diskStore.remove either -- nothing is ever there. The
// re-sweep test below is the one test in this file that writes REAL bytes
// (diskStore.put), so it alone is responsible for removing them again.
const storedDiskShas: string[] = [];

test.afterAll(async () => {
  await cleanupDemozoo();
  await cleanupTosec();
  await cleanupSeeded();
  for (const sha256 of storedDiskShas.splice(0)) {
    try { await diskStore.remove(sha256); } catch { /* best effort */ }
  }
});

const freshSha = () => createHash('sha256').update(randomUUID()).digest('hex');
const tag = () => Math.random().toString(36).slice(2, 8);

// Same reset tosec-scan.spec.ts's own tests rely on: importDat()'s UNSCOPED
// match_checked_at reset means any DAT import anywhere in the suite can hand
// the whole live database back to phase 2 mid-run, so a sweep here can
// genuinely run past Playwright's default 30s test timeout though it
// comfortably fits inside sweep()'s own 240s budget.
const SWEEP_TIMEOUT_MS = 280_000;

/**
 * Drive /api/admin/scan to completion. sweep()'s own budget (240s) can
 * leave `done: false` after one call when the live database has a large
 * backlog -- the admin page's own "Run now" polls the same way (see
 * admin-scan.spec.ts) -- so this repeats the POST rather than trusting one
 * call to have finished every phase.
 */
async function runSweepUntilDone(adminPage: Page, maxCalls = 5) {
  for (let i = 0; i < maxCalls; i++) {
    const res = await adminPage.request.post('/api/admin/scan');
    expect(res.ok()).toBe(true);
    const json = await res.json();
    if (json.done) return json;
  }
  throw new Error(`sweep did not report done after ${maxCalls} calls`);
}

/** Give a blob a known sha1 directly, so the sweeper's hash-match phase can find it. */
async function fakeHashes(sha256: string) {
  const sha1 = createHash('sha1').update(sha256).digest('hex');
  await getDb().update(blobs)
    .set({ sha1, md5: null, crc32: null, hashedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
  return sha1;
}

test('a suggestion links on "Use this": the game is retitled and the panel shows', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `wayfarer-${t}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `Wayfarer ${t}`, releaseYear: 1992, groups: ['Spaceballs'] });
  await seedDemozooImage(pid);
  await seedSuggestion(sha256, pid);

  await page.goto(`/games/${gameId}`);
  const card = page.getByTestId('demozoo-suggestion').filter({ hasText: `Wayfarer ${t}` });
  await expect(card).toBeVisible();
  await card.getByTestId('demozoo-use').click();

  await expect(page.getByTestId('demozoo-panel')).toHaveAttribute('data-link-source', 'confirmed');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Wayfarer ${t}`);
  await expect(page.getByTestId('demozoo-fact-by')).toHaveText('Spaceballs');
  await expect(page.getByTestId('demozoo-credit').getByRole('link', { name: 'Demozoo' }))
    .toHaveAttribute('href', `https://demozoo.org/productions/${pid}/`);
});

test('"Not this" stays gone after a reload', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: `nope-${tag()}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `Wrong Demo ${tag()}` });
  await seedSuggestion(sha256, pid);

  await page.goto(`/games/${gameId}`);
  await page.locator(`[data-testid="demozoo-suggestion"][data-production-id="${pid}"]`).getByTestId('demozoo-dismiss').click();
  await expect(page.locator(`[data-production-id="${pid}"]`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`[data-production-id="${pid}"]`)).toHaveCount(0);
});

test('Unlink restores the filename-derived title', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `original-${t}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `Linked Title ${t}` });
  await seedSuggestion(sha256, pid);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('demozoo-use').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Linked Title ${t}`);
  await page.getByTestId('demozoo-unlink').click();
  // seedDisk's entitlement filename is `${title}-${diskNo}.adf`, which parseTosecName reads back as the title.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`original-${t}`);
});

test('a hand-edited title survives a Demozoo link', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: `edited-${tag()}`, diskNo: 1, sha256 });
  const res = await page.request.patch(`/api/games/${gameId}`, { data: { title: 'My Own Name' } });
  expect(res.status()).toBe(200);
  const pid = await seedProduction({ title: `Demozoo Name ${tag()}` });
  await seedSuggestion(sha256, pid);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('demozoo-use').first().click();
  await expect(page.getByTestId('demozoo-panel')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Own Name');
});

test('a confirmation in one org is not a link in another', async ({ page, browser }) => {
  const a = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId: gameA } = await seedDisk(a.orgId, { title: `shared-${tag()}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `Shared Demo ${tag()}` });
  await seedSuggestion(sha256, pid);
  expect((await page.request.post(`/api/games/${gameA}/demozoo`, { data: { productionId: pid } })).status()).toBe(200);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await signUpFresh(pageB);
  const { gameId: gameB } = await seedDisk(b.orgId, { title: `shared-b-${tag()}`, diskNo: 1, sha256 });
  await pageB.goto(`/games/${gameB}`);
  await expect(pageB.getByTestId('demozoo-panel')).toHaveCount(0);
  await expect(pageB.locator(`[data-testid="demozoo-suggestion"][data-production-id="${pid}"]`)).toBeVisible();
  await ctxB.close();
});

test('an automatic link shows on the game page and as the grid cover', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `auto-${t}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `Auto Demo ${t}` });
  const sha1 = await seedDemozooImage(pid);
  await linkAutomatic(sha256, pid);

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId('demozoo-panel')).toHaveAttribute('data-link-source', 'automatic');

  await page.goto('/library');
  const cover = page.getByTestId('game-card').filter({ hasText: `auto-${t}` }).getByTestId('cover-image');
  await expect(cover).toHaveAttribute('src', `/api/images/${sha1}`);
  await expect.poll(() => cover.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});

test('bulk accept links exactly the ticked rows', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const shaKeep = freshSha(); const shaSkip = freshSha();
  const { gameId: keep } = await seedDisk(user.orgId, { title: `keep-${t}`, diskNo: 1, sha256: shaKeep });
  const { gameId: skip } = await seedDisk(user.orgId, { title: `skip-${t}`, diskNo: 1, sha256: shaSkip });
  const pKeep = await seedProduction({ title: `Keep Demo ${t}` });
  const pSkip = await seedProduction({ title: `Skip Demo ${t}` });
  await seedSuggestion(shaKeep, pKeep);
  await seedSuggestion(shaSkip, pSkip);

  await page.goto('/library');
  await page.getByTestId('demozoo-badge').click();
  await expect(page).toHaveURL(/\/library\/demozoo$/);
  const skipRow = page.locator(`[data-testid="review-item"][data-game-id="${skip}"]`);
  await expect(skipRow.getByTestId('review-check')).toBeChecked();
  await skipRow.getByTestId('review-check').uncheck();
  await page.getByTestId('review-accept').click();

  await expect(page.locator(`[data-testid="review-item"][data-game-id="${keep}"]`)).toHaveCount(0);
  await expect(skipRow).toBeVisible();
  await page.goto(`/games/${keep}`);
  await expect(page.getByTestId('demozoo-panel')).toHaveAttribute('data-link-source', 'confirmed');
});

test('spec §10: "Not this" stays gone after a REAL re-sweep, not just a reload', async ({ page, browser }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const t = tag();
  const title = `Resweep Demo ${t}`;

  // Real, uniquely-marked 901,120-byte content: demozooMatchPhase's
  // filename branch calls diskStore.read (matchOne, src/lib/demozoo/sweep.ts)
  // and the TOSEC hash phase ahead of it (tosec-sweep.ts phase 1) does too --
  // a seeded row with no stored bytes would make phase 1 fail the read and
  // stamp hashedAt with null hashes, and phase 2 would then short-circuit to
  // 'none' without ever reaching the candidate query, which would make this
  // test pass trivially. The marker keeps the bytes (and so the sha256)
  // unique to each run.
  const bytes = new Uint8Array(901_120);
  bytes.set(Buffer.from(`resweep-${t}-${randomUUID()}`), 450_000);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await diskStore.put(sha256, bytes);
  storedDiskShas.push(sha256);

  const { gameId } = await seedDisk(user.orgId, { title, diskNo: 1, sha256, sizeBytes: bytes.byteLength });
  // entitlements.sourceFilename is `${title}-${diskNo}.adf` (seedDisk), which
  // parseTosecName reads back as `title` -- the 'filename' suggestion source.
  const pid = await seedProduction({ title });

  // A separate context signed in as super-admin: running the sweep on the
  // org user's own `page` would replace their session, and this test needs
  // it alive afterward to dismiss the suggestion and reload as that user.
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await signInAsSuperAdmin(adminPage);

  await runSweepUntilDone(adminPage);
  const db = getDb();
  let blob = (await db.select().from(blobs).where(eq(blobs.sha256, sha256)))[0];
  expect(blob.matchCheckedAt, 'the TOSEC hash/match phases must have run first').not.toBeNull();
  expect(blob.demozooState, 'the real Demozoo match phase must find this production by filename').toBe('suggested');
  expect(blob.demozooProductionId).toBeNull();

  await page.goto(`/games/${gameId}`);
  await page.locator(`[data-testid="demozoo-suggestion"][data-production-id="${pid}"]`).getByTestId('demozoo-dismiss').click();
  await expect(page.locator(`[data-production-id="${pid}"]`)).toHaveCount(0);

  // Force demozooMatchPhase to reconsider this blob. matchOne
  // unconditionally deletes and re-inserts demozoo_suggestions for the blob
  // on every pass (it has no notion of a per-game dismissal, which lives in
  // demozoo_dismissals instead) -- this is exactly the scenario spec §10
  // guards against: the RAW suggestion row comes back, and only the
  // per-game dismissal is what must keep it off this game's page.
  await db.update(blobs).set({ demozooCheckedAt: null }).where(eq(blobs.sha256, sha256));
  await runSweepUntilDone(adminPage);
  await adminCtx.close();

  blob = (await db.select().from(blobs).where(eq(blobs.sha256, sha256)))[0];
  expect(blob.demozooState, 'the phase must actually have re-run, not been skipped').toBe('suggested');

  await page.reload();
  await expect(page.locator(`[data-testid="demozoo-suggestion"][data-production-id="${pid}"]`)).toHaveCount(0);
});

// --- Additional controller-rulings coverage (Task 15 brief + controller notes) ---

test('R6: a Demozoo confirmation and a dismissal survive a TOSEC merge', async ({ page, browser }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const t = tag();
  const shaA = freshSha();
  const shaB = freshSha();
  await seedDisk(user.orgId, { title: `merge-a-${t}`, diskNo: 1, sha256: shaA });
  const { gameId: gameB } = await seedDisk(user.orgId, { title: `merge-b-${t}`, diskNo: 1, sha256: shaB });

  // gameA is retitled to this by the real TOSEC hash match below. gameB is
  // confirmed to a Demozoo production carrying the SAME title/year: confirming
  // sets gameB.metadataSource to 'demozoo', which TOSEC_RETITLABLE_SOURCES
  // deliberately excludes (R5-revised) -- gameB's own TOSEC match never
  // touches its title -- so this is the only way for gameA and gameB to end
  // up sharing (sortTitle, year) and actually collide in mergeDuplicates.
  const mergeTitle = `Merge Target ${t}`;
  const mergeSortTitle = makeSortTitle(mergeTitle);
  const mergeYear = 1991;

  const pConfirmed = await seedProduction({ title: mergeTitle, releaseYear: mergeYear });
  expect((await page.request.post(`/api/games/${gameB}/demozoo`, { data: { productionId: pConfirmed } })).status()).toBe(200);
  const pDismissed = await seedProduction({ title: `Not This One ${t}` });
  await seedSuggestion(shaB, pDismissed);
  expect((await page.request.post(`/api/games/${gameB}/demozoo/dismiss`, { data: { productionId: pDismissed } })).status()).toBe(200);

  const sha1A = await fakeHashes(shaA);
  const sha1B = await fakeHashes(shaB);
  await seedTosecEntry({
    setName: `e2e-set-demozoo-merge-${t}`,
    gameName: `${mergeTitle} A`, romName: `${mergeTitle} A.adf`,
    sha1: sha1A, title: mergeTitle, sortTitle: mergeSortTitle, year: mergeYear,
  });
  await seedTosecEntry({
    setName: `e2e-set-demozoo-merge-${t}`,
    gameName: `${mergeTitle} B`, romName: `${mergeTitle} B.adf`,
    sha1: sha1B, title: mergeTitle, sortTitle: mergeSortTitle, year: mergeYear,
  });

  // A separate context for the admin sweep: signing in as super-admin on the
  // page above would replace the org user's own session, and this test needs
  // that session alive afterward to view the survivor's game page.
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await signInAsSuperAdmin(adminPage);
  expect((await adminPage.request.post('/api/admin/scan')).ok()).toBe(true);
  await adminCtx.close();

  const db = getDb();
  const rows = await db.select().from(games).where(eq(games.orgId, user.orgId));
  expect(rows).toHaveLength(1);
  expect(rows[0].demozooLinkSource).toBe('confirmed');
  expect(rows[0].demozooProductionId).toBe(pConfirmed);
  const survivorId = rows[0].id;

  await page.goto(`/games/${survivorId}`);
  await expect(page.getByTestId('demozoo-panel')).toHaveAttribute('data-link-source', 'confirmed');
  await expect(page.getByTestId('demozoo-credit').getByRole('link', { name: 'Demozoo' }))
    .toHaveAttribute('href', `https://demozoo.org/productions/${pConfirmed}/`);

  // Clear the confirmed link so the suggestions view (and the carried-forward
  // dismissal) becomes observable in the UI.
  await page.getByTestId('demozoo-unlink').click();
  await expect(page.getByTestId('demozoo-panel')).toHaveCount(0);
  await expect(page.getByTestId('demozoo-suggestions')).toBeVisible();
  await expect(page.locator(`[data-testid="demozoo-suggestion"][data-production-id="${pDismissed}"]`)).toHaveCount(0);
});

test('R11: unlink when the org confirmed the automatic link\'s own production shows no panel, not the automatic link', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `same-link-${t}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `Same Production ${t}` });
  await linkAutomatic(sha256, pid);
  expect((await page.request.post(`/api/games/${gameId}/demozoo`, { data: { productionId: pid } })).status()).toBe(200);

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId('demozoo-panel')).toHaveAttribute('data-link-source', 'confirmed');

  await page.getByTestId('demozoo-unlink').click();
  await expect(page.getByTestId('demozoo-panel')).toHaveCount(0);
  // seedDisk's entitlement filename is `${title}-${diskNo}.adf`, read back by
  // parseTosecName -- proves the title was re-derived, not left on Demozoo's.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`same-link-${t}`);
  await page.reload();
  await expect(page.getByTestId('demozoo-panel')).toHaveCount(0);
});

test('R5: a TOSEC re-match does not retitle a confirmed Demozoo title, but Unlink still falls back to it', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = freshSha();
  const t = tag();
  const { gameId } = await seedDisk(user.orgId, { title: `r5-${t}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `Demozoo Owns This ${t}`, releaseYear: 1994, groups: ['Demozoo Group'] });
  expect((await page.request.post(`/api/games/${gameId}/demozoo`, { data: { productionId: pid } })).status()).toBe(200);

  const db = getDb();
  const before = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  expect(before.title).toBe(`Demozoo Owns This ${t}`);
  expect(before.metadataSource).toBe('demozoo');

  const tosecTitle = `TOSEC Wants This ${t}`;
  const entryId = await seedTosecEntry({
    setName: `e2e-set-r5-${t}`, gameName: tosecTitle, romName: `${tosecTitle}.adf`,
    title: tosecTitle, sortTitle: makeSortTitle(tosecTitle), year: 1985, publisher: 'Some Publisher',
  });

  // applyMatch itself is called directly -- there is no UI trigger for
  // applying one specific TOSEC match, only the sweep, which fuzzy-matches
  // and would need a real hash lookup this test doesn't otherwise need.
  await applyMatch(sha256, entryId);

  const afterMatch = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  expect(afterMatch.title, 'a TOSEC retitle must not overwrite a confirmed Demozoo title').toBe(`Demozoo Owns This ${t}`);
  expect(afterMatch.metadataSource).toBe('demozoo');
  expect(afterMatch.year).toBe(1994);
  expect(afterMatch.publisher).toBe('Demozoo Group');

  // blobs.tosecEntryId is stamped by the real sweep (tosec-sweep.ts), not by
  // applyMatch -- set it directly so unlinkDemozoo's re-derive branch below
  // has a TOSEC identity to fall back to.
  await db.update(blobs).set({ tosecEntryId: entryId }).where(eq(blobs.sha256, sha256));
  const ok = await unlinkDemozoo(user.orgId, gameId);
  expect(ok).toBe(true);

  const afterUnlink = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  expect(afterUnlink.title, 'Unlink can still fall back to TOSEC even though TOSEC could not overwrite Demozoo directly').toBe(tosecTitle);
  expect(afterUnlink.metadataSource).toBe('tosec');
  expect(afterUnlink.year).toBe(1985);
  expect(afterUnlink.publisher).toBe('Some Publisher');
});

test('R15: a skipped_game disk keeps its game out of the review queue, and Use returns 404', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const shaGame = freshSha();
  const shaSuggested = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: `mixed-${t}`, diskNo: 1, sha256: shaGame });
  await addDisk(user.orgId, gameId, { diskNo: 2, sha256: shaSuggested });
  await getDb().update(blobs).set({ demozooState: 'skipped_game', demozooCheckedAt: new Date() }).where(eq(blobs.sha256, shaGame));
  const pid = await seedProduction({ title: `Would-be Suggestion ${t}` });
  await seedSuggestion(shaSuggested, pid);

  // A positive control in the SAME org: without it, "no review-item for
  // gameId" would pass just as well if /library/demozoo rendered nothing at
  // all (a broken page, an empty queue for an unrelated reason). This game
  // has an ordinary, unblocked suggestion and MUST appear.
  const shaOrdinary = freshSha();
  const { gameId: ordinaryGameId } = await seedDisk(user.orgId, { title: `ordinary-${t}`, diskNo: 1, sha256: shaOrdinary });
  const pOrdinary = await seedProduction({ title: `Ordinary Suggestion ${t}` });
  await seedSuggestion(shaOrdinary, pOrdinary);

  await page.goto('/library/demozoo');
  await expect(page.locator(`[data-testid="review-item"][data-game-id="${ordinaryGameId}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="review-item"][data-game-id="${gameId}"]`)).toHaveCount(0);

  const res = await page.request.post(`/api/games/${gameId}/demozoo`, { data: { productionId: pid } });
  expect(res.status()).toBe(404);
});

test('R16: "Restore original title" repairs a game left with a Demozoo title and no link', async ({ page }) => {
  const user = await signUpFresh(page);
  const t = tag();
  const sha256 = freshSha();
  const { gameId } = await seedDisk(user.orgId, { title: `restore-${t}`, diskNo: 1, sha256 });

  // Simulate a later Demozoo import re-matching this blob away from its link
  // (R16): metadataSource still reads 'demozoo', but nothing links any more.
  await getDb().update(games).set({
    metadataSource: 'demozoo', title: `Stale Demozoo Title ${t}`, sortTitle: makeSortTitle(`Stale Demozoo Title ${t}`),
  }).where(eq(games.id, gameId));

  await page.goto(`/games/${gameId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Stale Demozoo Title ${t}`);
  const restore = page.getByRole('button', { name: 'Restore original title' });
  await expect(restore).toBeVisible();
  await restore.click();

  // seedDisk's entitlement filename is `${title}-${diskNo}.adf`, which
  // parseTosecName reads back as the original title.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`restore-${t}`);
});
