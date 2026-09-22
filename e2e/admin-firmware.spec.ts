import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { publishTestRelease, cleanupTestReleases } from './device-helpers';

// firmware_releases is global, so these rows are visible to every org while
// they exist. The window closes with this file, not with the whole suite.
test.afterAll(cleanupTestReleases);

/**
 * /admin/firmware is read-only. Publishing happens from the operator's Mac,
 * because the signing key is there (spec D3) -- a browser publish would
 * either skip the signature or need the key uploaded, and uploading it is the
 * one thing that makes an offline key pointless.
 */

test('an ordinary user cannot reach the firmware page', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/admin/firmware');
  // The admin layout redirects a non-admin to /library rather than answering,
  // so the response never confirms that /admin/firmware exists.
  await expect(page).toHaveURL(/\/library/);
});

test('an admin sees published releases newest first', async ({ page }) => {
  await publishTestRelease('0.0.0+e2e10');
  await publishTestRelease('0.0.0+e2e11');
  await signInAsSuperAdmin(page);

  await page.goto('/admin/firmware');
  const rows = page.getByTestId('firmware-release-row');
  await expect(rows.first()).toContainText('0.0.0+e2e11');
});

test('a security release is marked as one', async ({ page }) => {
  await publishTestRelease('0.0.0+e2e12', { security: true });
  await signInAsSuperAdmin(page);

  await page.goto('/admin/firmware');
  await expect(page.getByTestId('firmware-release-row').first()).toContainText(/security/i);
});
