import { type Page, expect } from '@playwright/test';
import { mintInviteCode } from './helpers';

// Must match SUPERADMIN_EMAILS in .env.local. Production's allowlist holds a
// different value on purpose (see the super-admin rulings, Ruling 1): sharing
// one value would either put a test account in production's allowlist or leave
// the e2e suite unable to sign in as an admin.
export const SUPERADMIN_EMAIL = 'admin@example.test';
const PASSWORD = 'correct-horse-battery-staple';

/**
 * Sign in as the allowlisted admin, creating the account on first run.
 *
 * The admin's address is fixed (it has to match the allowlist) and
 * `user.email` is unique, so this cannot use signUpFresh's throwaway-address
 * approach: the first run signs up, every later run signs in.
 */
export async function signInAsSuperAdmin(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(SUPERADMIN_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Either we land in the app, or the account does not exist yet.
  const landed = await page.waitForURL(/\/library/, { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  if (!landed) {
    const code = await mintInviteCode();
    await page.goto('/sign-up');
    await page.getByLabel('Email').fill(SUPERADMIN_EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByLabel('Invite code').fill(code);
    await page.getByRole('button', { name: /sign up/i }).click();
    await expect(page).toHaveURL(/\/library/, { timeout: 15_000 });
  }
  return { email: SUPERADMIN_EMAIL };
}
