import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

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
