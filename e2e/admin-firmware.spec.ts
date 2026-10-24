import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { publishTestRelease, publishTestReleaseWithBlob, cleanupTestReleases } from './device-helpers';

// firmware_releases is global, so these rows are visible to every org while
// they exist. The window closes with this file, not with the whole suite.
test.afterAll(cleanupTestReleases);

/**
 * Publishing happens from the operator's Mac, because the signing key is
 * there (spec D3) -- a browser publish would either skip the signature or
 * need the key uploaded, and uploading it is the one thing that makes an
 * offline key pointless. The page's one write is Promote to release (A7 spec
 * §3), a notes edit on a TEST build.
 *
 * firmware_releases is shared with the live registry: every assertion below
 * is about a row this file seeded, found by its data-version, never a total.
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

const row = (page: import('@playwright/test').Page, version: string) =>
  page.locator(`[data-testid="firmware-release-row"][data-version="${version}"]`);

test('a TEST build is tagged Test, shows its boards, and promotes to a release through the modal', async ({ page }) => {
  // With a blob: the promote route reads the image to refuse a bench-marker build.
  const version = await publishTestReleaseWithBlob('0.0.0+e2e13', { notes: 'TEST build e2e promote' });
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware');

  const r = row(page, version);
  await expect(r.getByTestId('fw-tag-test')).toBeVisible();
  await expect(r.getByTestId('fw-tag-release')).toHaveCount(0);
  // No board reports this seeded version.
  await expect(r.getByTestId('fw-boards')).toHaveText('0 boards');
  // A TEST build never has a GitHub release.
  await expect(r.getByTestId('fw-github')).toHaveCount(0);

  const dialog = page.getByTestId('fw-promote-dialog');
  // A click before hydration does nothing; retry until the modal opens.
  await expect(async () => {
    await r.getByRole('button', { name: 'Promote to release' }).click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();

  const notes = dialog.getByTestId('fw-promote-notes');
  // "TEST build" and the space after it are removed.
  await expect(dialog.getByTestId('fw-promote-scope')).toHaveText("Every organization's boards will be offered this build.");
  await expect(notes).toHaveValue('e2e promote');
  await notes.fill('TEST build still');
  await expect(dialog.getByTestId('fw-promote-confirm')).toBeDisabled();
  await notes.fill('e2e promoted to a release');
  await dialog.getByTestId('fw-promote-confirm').click();

  await expect(dialog.getByTestId('fw-promote-done')).toHaveText(
    'Promoted. The GitHub release is made from the build folder: run pnpm firmware:publish --github-only.',
  );
  await expect(r.getByTestId('fw-tag-release')).toBeVisible();
  await expect(r.getByTestId('fw-tag-test')).toHaveCount(0);
  await expect(r).toContainText('e2e promoted to a release');
  await expect(r.getByRole('button', { name: 'Promote to release' })).toHaveCount(0);
});

test('a promote from a signed-out session says so, never "Promoted"', async ({ page }) => {
  const version = await publishTestReleaseWithBlob('0.0.0+e2e15', { notes: 'TEST build e2e signed out' });
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware');

  const r = row(page, version);
  const dialog = page.getByTestId('fw-promote-dialog');
  await expect(async () => {
    await r.getByRole('button', { name: 'Promote to release' }).click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.context().clearCookies();
  await dialog.getByTestId('fw-promote-confirm').click();

  await expect(dialog.getByTestId('fw-promote-error')).toHaveText('Signed out — sign in again');
  await expect(dialog.getByTestId('fw-promote-done')).toHaveCount(0);
  await expect(r.getByTestId('fw-tag-test')).toBeVisible();
});

test('the list pages: "Page 1 of", no Newer on page 1, and a garbage ?page= clamps', async ({ page }) => {
  await publishTestRelease('0.0.0+e2e14');
  await signInAsSuperAdmin(page);

  await page.goto('/admin/firmware');
  await expect(page.getByText(/^Page 1 of \d+$/)).toBeVisible();
  await expect(page.getByTestId('fw-page-newer')).toHaveCount(0);
  // The seeded release has the highest sequence, so it is on page 1.
  await expect(row(page, '0.0.0+e2e14')).toHaveCount(1);

  for (const p of ['0', '-1', 'abc']) {
    const res = await page.goto(`/admin/firmware?page=${p}`);
    expect(res?.status(), p).toBe(200);
    await expect(page.getByText(/^Page 1 of \d+$/)).toBeVisible();
  }
  const res = await page.goto('/admin/firmware?page=9999');
  expect(res?.status()).toBe(200);
  // Past the end reads as the last page: "Page M of M", and no Older link.
  const text = await page.getByText(/^Page \d+ of \d+$/).textContent();
  const [, n, m] = /^Page (\d+) of (\d+)$/.exec(text ?? '') ?? [];
  expect(n).toBe(m);
  await expect(page.getByTestId('fw-page-older')).toHaveCount(0);
});
