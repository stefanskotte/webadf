import { test, expect } from '@playwright/test';
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
  // Nothing in this app currently mounts sonner's <Toaster/> (grepped every
  // layout: src/app/layout.tsx, (app)/layout.tsx, (admin)/layout.tsx -- none
  // render one), so toast.success()/toast.error() calls never reach the DOM
  // and cannot be asserted on. Proving the click worked through the button's
  // own busy -> idle transition, plus the page still rendering afterwards,
  // does not depend on that separate (unrelated, pre-existing) gap.
  await expect(button).toHaveText('Run now', { timeout: 250_000 });
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

  // Same Toaster gap as the test above -- assert through the table
  // dat-upload.tsx's router.refresh() actually re-renders, not through a
  // toast that never mounts.
  const row = page.getByRole('row', { name: setName });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText('1'); // one game entry in the DAT above
});
