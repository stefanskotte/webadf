import { type Page, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { user } from '@/db/schema/auth';
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

/** The admin user list's page size (src/app/(admin)/admin/users/page.tsx). */
export const ADMIN_PER_PAGE = 50;

const seededUserIds: string[] = [];

/**
 * Insert `count` bare users straight into auth."user".
 *
 * The pagination specs need MORE THAN ONE PAGE of users to exist, and until
 * the global teardown landed they got that for free: every run left its
 * accounts behind, so the table held 4,600 of them and a second page was
 * always there. That was the leak passing as a fixture -- the specs never
 * created what they asserted on, and cleaning the database up correctly broke
 * them. A test must bring its own data.
 *
 * Bare rows are enough: adminListUsers LEFT JOINs member and organization, so
 * a user with neither still renders a row. Going through the real sign-up
 * flow fifty-one times would add minutes to the suite for no extra coverage.
 */
export async function seedUsers(count: number): Promise<string[]> {
  const rows = Array.from({ length: count }, () => {
    const id = `u_${randomUUID()}`;
    return { id, name: 'Pagination Fixture', email: `page-${id}@example.test` };
  });
  await getDb().insert(user).values(rows);
  seededUserIds.push(...rows.map((r) => r.id));
  return rows.map((r) => r.id);
}

/** Remove only what seedUsers inserted. The teardown would catch these too. */
export async function cleanupSeededUsers(): Promise<void> {
  const ids = seededUserIds.splice(0);
  if (ids.length === 0) return;
  try {
    await getDb().delete(user).where(inArray(user.id, ids));
  } catch (e) {
    console.warn('cleanupSeededUsers: best effort —', (e as Error).message);
  }
}
