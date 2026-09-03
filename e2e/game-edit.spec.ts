import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { games, blobs } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';

test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });

// The scan sweeps the live database, whose own budget is 240 s.
const SWEEP_TIMEOUT_MS = 280_000;

const freshSha = () => randomUUID().replace(/-/g, '').padEnd(64, '0');

async function fakeHashes(sha256: string) {
  const sha1 = createHash('sha1').update(sha256).digest('hex');
  await getDb().update(blobs)
    .set({ sha1, md5: null, crc32: null, hashedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
  return sha1;
}

/**
 * Sign back in as the tenant.
 *
 * signInAsSuperAdmin replaces the PAGE's session with the operator's, and
 * /games/[id] is org-scoped -- the operator is not a member of the tenant's
 * organization, so the page 404s for them and none of the editor's controls
 * exist to click. Any test that runs a scan and then goes back to a game page
 * needs this. (openretro.spec.ts keeps its own copy for the same reason.)
 */
async function signInAs(page: import('@playwright/test').Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/library/, { timeout: 15_000 });
}

const gameRow = async (id: string) =>
  (await getDb().select().from(games).where(eq(games.id, id)))[0];

test('an edit is saved, shown, and stamped to the group it belongs to', async ({ page }) => {
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: 'editable', diskNo: 1, sha256: freshSha() });

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-field-description').fill('A hand-written note.');
  await page.getByTestId('edit-save').click();

  await expect(page.getByTestId('game-description')).toContainText('A hand-written note.');

  const g = await gameRow(gameId);
  expect(g.description).toBe('A hand-written note.');
  // ONLY prose. Stamping identity here would freeze the title and publisher
  // against every future scan because someone typed a sentence.
  expect(g.proseSource).toBe('human');
  expect(g.metadataSource).toBe('filename');
  expect(g.factsSource).toBeNull();
});

test('a hand-written description does not credit OpenRetro', async ({ page }) => {
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: 'uncredited', diskNo: 1, sha256: freshSha() });

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-field-description').fill('Written by a person, not a scraper.');
  await page.getByTestId('edit-save').click();

  await expect(page.getByTestId('game-description')).toContainText('not a scraper');
  // The facts block renders for hand-written content now, and it carries an
  // attribution line. Crediting OpenRetro for a sentence someone typed is the
  // inverse of behaving well about attribution.
  await expect(page.getByTestId('openretro-credit')).toHaveCount(0);
});

test('editing prose does not stop a scan correcting the title', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  // THE POINT OF PER-GROUP AUTHORITY, and the test that fails against the
  // single whole-row guard this increment replaced.
  const u = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(u.orgId, { title: 'badlynamed', diskNo: 1, sha256 });
  const sha1 = await fakeHashes(sha256);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-field-description').fill('My own words.');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('game-description')).toContainText('My own words.');

  await seedTosecEntry({
    gameName: 'Ruff n Tumble (1994)(Renegade)',
    romName: `Ruff n Tumble (1994)(Renegade)-${sha1.slice(0, 8)}.adf`,
    sha1, title: 'Ruff n Tumble', sortTitle: 'ruff n tumble',
    year: 1994, publisher: 'Renegade',
  });

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const g = await gameRow(gameId);
  // The scan corrected the identity it owns...
  expect(g.title).toBe('Ruff n Tumble');
  expect(g.publisher).toBe('Renegade');
  expect(g.metadataSource).toBe('tosec');
  // ...and left the prose alone, because a person owns that group.
  expect(g.description).toBe('My own words.');
  expect(g.proseSource).toBe('human');
});

test('an edited title survives the scan that would have renamed it', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const u = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(u.orgId, { title: 'wrongname', diskNo: 1, sha256 });
  const sha1 = await fakeHashes(sha256);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-field-title').fill('The Real Name');
  await page.getByTestId('edit-save').click();
  // The panel closes only after the PATCH resolves -- without this the row is
  // read before the request has landed.
  await expect(page.getByTestId('edit-panel')).toHaveCount(0);

  const afterEdit = await gameRow(gameId);
  expect(afterEdit.title).toBe('The Real Name');
  expect(afterEdit.metadataSource).toBe('human');
  // sortTitle is NOT NULL, orders games_org_sort_idx and is half the key
  // mergeDuplicates collapses on -- an edit that skipped it would leave the
  // row sorting and merging under its old name.
  expect(afterEdit.sortTitle).toBe('real name, the');

  await seedTosecEntry({
    gameName: 'Something Else (1993)(Someone)',
    romName: `Something Else (1993)(Someone)-${sha1.slice(0, 8)}.adf`,
    sha1, title: 'Something Else', sortTitle: 'something else',
    year: 1993, publisher: 'Someone',
  });
  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const g = await gameRow(gameId);
  expect(g.title).toBe('The Real Name');
  expect(g.metadataSource).toBe('human');
});

test('handing identity back restores what the scan found', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const u = await signUpFresh(page);
  const sha256 = freshSha();
  const { gameId } = await seedDisk(u.orgId, { title: 'restorable', diskNo: 1, sha256 });
  const sha1 = await fakeHashes(sha256);
  await seedTosecEntry({
    gameName: 'Cannon Fodder (1993)(Virgin)',
    romName: `Cannon Fodder (1993)(Virgin)-${sha1.slice(0, 8)}.adf`,
    sha1, title: 'Cannon Fodder', sortTitle: 'cannon fodder',
    year: 1993, publisher: 'Virgin',
  });
  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);
  // Back to the tenant before touching the page: see signInAs above.
  await signInAs(page, u.email, u.password);

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-field-title').fill('Mistake');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('edit-panel')).toHaveCount(0);
  expect((await gameRow(gameId)).title).toBe('Mistake');

  // "Use scanned data" has to actually bring the data back. Clearing the
  // authority alone would mean "your mistake stays until some future sweep",
  // which is not what the control says.
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-reset-identity').click();

  await expect.poll(async () => (await gameRow(gameId)).title).toBe('Cannon Fodder');
  const g = await gameRow(gameId);
  expect(g.publisher).toBe('Virgin');
  expect(g.year).toBe(1993);
  expect(g.sortTitle).toBe('cannon fodder');
  // Back under machine authority -- and NOT null, which in this column would
  // mean a human still owned it.
  expect(g.metadataSource).toBe('tosec');
});

test('saving an untouched form stamps nothing', async ({ page }) => {
  const u = await signUpFresh(page);
  const { gameId } = await seedDisk(u.orgId, { title: 'untouched', diskNo: 1, sha256: freshSha() });

  await page.goto(`/games/${gameId}`);
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('edit-panel')).toHaveCount(0);

  // Opening the editor and saving must not freeze the row. If it did, merely
  // looking would cost a title every future correction.
  const g = await gameRow(gameId);
  expect(g.metadataSource).toBe('filename');
  expect(g.factsSource).toBeNull();
  expect(g.proseSource).toBeNull();
});

test('the API refuses an empty title and another tenant entirely', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const ua = await signUpFresh(pa);
  await signUpFresh(pb);
  const { gameId } = await seedDisk(ua.orgId, { title: 'guarded', diskNo: 1, sha256: freshSha() });

  // sortTitle derives from the title and the column is NOT NULL.
  const empty = await pa.request.patch(`/api/games/${gameId}`, { data: { title: '   ' } });
  expect(empty.status()).toBe(400);

  const badYear = await pa.request.patch(`/api/games/${gameId}`, { data: { year: 1492 } });
  expect(badYear.status()).toBe(400);

  // Another tenant gets 404, never 403 -- the response must not confirm that
  // this id exists.
  const cross = await pb.request.patch(`/api/games/${gameId}`, { data: { publisher: 'Theirs' } });
  expect(cross.status()).toBe(404);
  const crossReset = await pb.request.post(`/api/games/${gameId}/reset`, { data: { group: 'identity' } });
  expect(crossReset.status()).toBe(404);
  expect((await gameRow(gameId)).publisher).toBeNull();

  // And the source columns are not settable by a request body.
  const forged = await pa.request.patch(`/api/games/${gameId}`, {
    data: { metadataSource: 'tosec', factsSource: 'openretro' },
  });
  expect(forged.status()).toBe(200);
  const g = await gameRow(gameId);
  expect(g.metadataSource).toBe('filename');
  expect(g.factsSource).toBeNull();

  await a.close();
  await b.close();
});
