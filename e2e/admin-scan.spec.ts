import { test, expect } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded } from './device-helpers';
import { trackTosecSet, cleanupTosec } from './tosec-helpers';

test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });

test('the admin sees the scan status page', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/scan');
  await expect(page.getByRole('heading', { name: /scan/i })).toBeVisible();
  await expect(page.getByTestId('scan-blobs')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('scan-unchecked')).toHaveText(/^\d+$/);
});

test('a non-admin cannot reach the scan page or its APIs', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/admin/scan');
  await expect(page).toHaveURL(/\/library/);

  // 307 with maxRedirects:0 -- this codebase redirects unauthorized API
  // callers rather than returning a 4xx (see e2e/admin-invites.spec.ts).
  for (const path of ['/api/admin/scan', '/api/admin/tosec']) {
    const res = await page.request.post(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(307);
    expect(res.headers()['location'], path).toContain('/library');
  }
});

test('the cron route refuses a caller with no secret', async ({ request }) => {
  expect((await request.get('/api/cron/scan')).status()).toBe(401);
  const bad = await request.get('/api/cron/scan', { headers: { authorization: 'Bearer nope' } });
  expect(bad.status()).toBe(401);
});

test('the operator can run a scan by clicking Run now', async ({ page }) => {
  // sweep() is bounded at its own DEFAULT_BUDGET_MS (~240s) against live
  // data, and this click drives a real request through to completion -- so
  // the wall-clock budget is raised for this one assertion rather than the
  // assertion being dropped or the request being faked. This test is about
  // the BUTTON actually working end to end, not about scan results: results
  // depend on whatever is currently unswept in the live database and
  // asserting on their exact values here would make this flaky.
  test.setTimeout(280_000);

  await signInAsSuperAdmin(page);
  await page.goto('/admin/scan');

  const button = page.getByTestId('run-scan');
  await expect(button).toHaveText('Run now');
  await button.click();
  await expect(button).toHaveText('Scanning…');
  // sonner's <Toaster/> is now mounted in src/app/layout.tsx (see
  // e2e/admin-invites.spec.ts's "a success toast is actually visible"
  // test, which was the regression that proved it), so the toast this
  // click fires is now assertable -- but exact counts are not: results
  // depend on whatever is currently unswept in the live database, and
  // asserting on precise numbers here would make this flaky. The button's
  // own busy -> idle transition, plus the page still rendering afterwards,
  // remains the primary assertion; the toast check below is a real but
  // loosely-worded addition, not a replacement for it.
  await expect(button).toHaveText('Run now', { timeout: 250_000 });
  await expect(page.getByText(/Scan complete|Batch done/)).toBeVisible();
  await expect(page.getByTestId('scan-blobs')).toHaveText(/^\d+$/);
});

test('the operator can import a DAT by choosing a file', async ({ page }) => {
  // A tiny, hand-built, valid ClrMamePro DAT -- same shape as
  // tosec-dat.test.ts's CMP fixture, which parseDat is unit-tested against.
  // A distinctive, run-unique setName means this can be asserted on
  // precisely and cleaned up precisely, with nothing on disk.
  const setName = `E2E Admin Scan Upload ${Date.now()}`;
  const datText = `clrmamepro (
\tname "${setName}"
\tdescription "${setName}"
\tversion 2026-01-01
)

game (
\tname "Test Game One (1990)(Test Publisher)"
\tdescription "Test Game One (1990)(Test Publisher)"
\trom ( name "Test Game One (1990)(Test Publisher).adf" size 901120 crc AABBCCDD )
)
`;
  trackTosecSet(setName);

  await signInAsSuperAdmin(page);
  await page.goto('/admin/scan');

  await page.getByTestId('dat-upload').setInputFiles({
    name: 'test.dat', mimeType: 'text/plain', buffer: Buffer.from(datText),
  });

  // The Toaster is now mounted (see the "Run now" test's comment above), so
  // the success toast is asserted directly below. The table assertion stays
  // too, and is still the one that actually proves dat-upload.tsx's
  // router.refresh() re-rendered the page with the imported set.
  await expect(page.getByText(`Imported 1 entries from 1 file`)).toBeVisible();
  const row = page.getByRole('row', { name: setName });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // Assert the Entries cell specifically, not the whole row: the row also
  // renders setVersion "2026-01-01", which contains the substring "1", so
  // `row.toContainText('1')` used to pass regardless of what Entries said.
  await expect(row.getByTestId('set-entries')).toHaveText('1');
});

test('a disk somebody made is excluded from the coverage rate', async ({ page }) => {
  test.setTimeout(280_000);
  // A self-made disk hashes to something no DAT contains, so the sweeper
  // stamps match_state 'none' -- correctly. It must not count as a MISS: a
  // disk the operator authored is in no preservation set and never will be,
  // and counting it would make the reported coverage fall every time they
  // make one, reporting their own work as a gap in the archive.
  const u = await signUpFresh(page);
  await page.goto('/library');
  await page.getByTestId('create-adf').click();
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));

  await signInAsSuperAdmin(page);
  // SWEEP UNTIL THIS BLOB IS DECIDED, rather than assuming one pass reaches
  // it. The sweeper works to a budget against a shared live database, so how
  // much it gets through depends on what else is unchecked at the time --
  // one run decided it when this was written and did not on the run before.
  for (let i = 0; i < 4; i++) {
    expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);
    const [b] = await getDb().select().from(blobs).where(eq(blobs.sha256, disk.sha256));
    if (b.matchState !== null) break;
  }
  const [decided] = await getDb().select().from(blobs).where(eq(blobs.sha256, disk.sha256));
  // 'none' is the CORRECT verdict for a disk nobody published -- the point is
  // what the rate then does with it, not that it went unmatched.
  expect(decided.matchState).toBe('none');

  await page.goto('/admin/scan');
  // The page names what it left out rather than quietly reporting a nicer
  // number -- a rate that silently excludes things is one nobody can check.
  await expect(page.getByText(/self-made disks? excluded/)).toBeVisible();
});
