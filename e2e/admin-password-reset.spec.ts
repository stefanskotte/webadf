import { test, expect, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin, SUPERADMIN_EMAIL } from './admin-helpers';

// Admin resets another user's password (operator 2026-10-26): the admin's own current password is required; the new
// one is generated, shown once, and the user is signed out everywhere.
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const TEMP = /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

test('an admin resets a password with their own: the user is signed out, the old password fails, the new one works', async ({ page, browser }) => {
  const victim = await signUpFresh(page);   // this page stays signed in as the victim
  const admin = await browser.newPage();
  await signInAsSuperAdmin(admin);
  await admin.goto('/admin/users');

  await admin.getByTestId(`reset-password-${victim.email}`).click();
  const dlg = admin.getByTestId('reset-password-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Your password')).toBeFocused();

  // A wrong admin password changes nothing.
  await dlg.getByLabel('Your password').fill('not-the-admin-password');
  await dlg.getByTestId('reset-password-confirm').click();
  await expect(dlg.getByTestId('reset-password-error')).toHaveText('That is not your password. Nothing was changed.');
  await page.reload();
  await expect(page).toHaveURL(/\/library/);

  // The right one (Enter submits) shows the new password once.
  await dlg.getByLabel('Your password').fill(ADMIN_PASSWORD);
  await dlg.getByLabel('Your password').press('Enter');
  const value = dlg.getByTestId('reset-password-value');
  await expect(value).toHaveText(TEMP);
  const temp = (await value.textContent())!;
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toBeHidden();
  await expect(admin.getByTestId(`reset-password-${victim.email}`)).toBeFocused();

  // The victim's open session is gone.
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in/);
  // The old password no longer works; the new one does.
  await signIn(page, victim.email, victim.password);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, victim.email, temp);
  await expect(page).toHaveURL(/\/library/, { timeout: 15_000 });

  // The admin's own account is refused even with the right password: that is Settings › Account.
  const meId = await admin.evaluate(async () => (await (await fetch('/api/auth/get-session')).json()).user.id as string);
  const self = await admin.request.post(`/api/admin/users/${meId}/password`, { data: { password: ADMIN_PASSWORD } });
  expect(self.status()).toBe(409);
  expect(await self.json()).toEqual({ error: 'self' });
  // And the admin was not signed out by any of this.
  await admin.reload();
  await expect(admin).toHaveURL(/\/admin\/users/);
  expect(SUPERADMIN_EMAIL).toBeTruthy();
  await admin.close();
});

test('a signed-in non-admin cannot reach the reset route', async ({ page }) => {
  const u = await signUpFresh(page);
  const res = await page.request.post('/api/admin/users/anything/password', { data: { password: u.password }, maxRedirects: 0 });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toMatch(TEMP);
});
