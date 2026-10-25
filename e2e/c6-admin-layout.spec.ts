import { test, expect } from '@playwright/test';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, cleanupTestReleases } from './device-helpers';

// Phase C6 (spec 2026-10-25-phase-c6-admin-design.md §10.4): the admin layout. The DB is the live one: every
// assertion is about rows a test made, or follows a value the page itself shows (both values of a state).
test.afterAll(async () => { await cleanupTestReleases(); await cleanupSeeded(); });

const PAGES = [
  ['/admin', 'Overview'], ['/admin/users', 'Users'], ['/admin/invites', 'Invites'],
  ['/admin/scan', 'Scan'], ['/admin/firmware', 'Firmware'],
] as const;

// ---- Shell (spec §1, Rulings 1, 2, 6, 36) -----------------------------------------------------------------

test('the admin header carries the Main nav with Admin current, the gear and Sign out, and no drive chips', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path] of PAGES) {
    await page.goto(path);
    const header = page.getByTestId('admin-header');
    const main = header.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link')).toHaveText(['Library', 'Devices', 'Upload', 'Help', 'Admin']);
    await expect(main.locator('[aria-current="page"]')).toHaveText(['Admin']);
    await expect(header.getByTestId('settings-link')).toBeVisible();
    await expect(header.getByTestId('sign-out')).toBeVisible();
    await expect(header.getByTestId('search-input')).toBeVisible();
    await expect(header.getByText('Back to library')).toHaveCount(0);
    await expect(header).toContainText('webfloppy admin');
    await expect(page.locator('[data-testid^=drive-chip]')).toHaveCount(0);
    await expect(page.getByTestId('drives-compact')).toHaveCount(0);
  }
});

test('every admin page opens with the Admin sections tabs, the current one marked, and its own title', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path, name] of PAGES) {
    await page.goto(path);
    const tabs = page.getByTestId('admin-sections');
    await expect(tabs).toHaveAttribute('aria-label', 'Admin sections');
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Users', 'Invites', 'Scan', 'Firmware']);
    await expect(tabs.locator('[aria-current="page"]')).toHaveText([name]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText('Admin · this server', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(`Admin · ${name} · WebFloppy`);
  }
});
