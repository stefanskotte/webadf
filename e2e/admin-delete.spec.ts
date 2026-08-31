import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db';
import { blobs, games, disks } from '@/db/schema/catalog';
import { user } from '@/db/schema/auth';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

test.afterAll(cleanupSeeded);

test('deleting a user removes their library but never a shared blob', async ({ page, browser }) => {
  // One sha256, deliberately shared by two orgs -- seedDisk's blobs insert is
  // onConflictDoNothing, so the second org reuses the same blob row. This is
  // the dedupe case the parent spec records as already live (26+ shared blobs).
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');

  const victim = await signUpFresh(page);
  await seedDisk(victim.orgId, { title: `Victim ${Date.now()}`, diskNo: 1, sha256 });

  const other = await browser.newPage();
  const otherUser = await signUpFresh(other);
  await seedDisk(otherUser.orgId, { title: `Other ${Date.now()}`, diskNo: 1, sha256 });
  await other.close();

  const db = getDb();
  expect((await db.select().from(blobs).where(eq(blobs.sha256, sha256))).length).toBe(1);

  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  await page.getByTestId(`delete-user-${victim.email}`).click();
  await page.getByLabel(/type the email/i).fill(victim.email);
  await page.getByRole('button', { name: /delete permanently/i }).click();
  await expect(page.getByTestId(`user-row-${victim.email}`)).toHaveCount(0);

  // Their catalog rows are gone...
  expect(await db.select().from(games).where(eq(games.orgId, victim.orgId))).toHaveLength(0);
  expect(await db.select().from(disks).where(eq(disks.orgId, victim.orgId))).toHaveLength(0);
  // ...and so is the auth row itself, not merely the row on the page.
  expect(await db.select().from(user).where(eq(user.email, victim.email))).toHaveLength(0);

  // ...and the shared blob survived. Deleting it would corrupt the other org.
  expect(await db.select().from(blobs).where(eq(blobs.sha256, sha256))).toHaveLength(1);

  // The OTHER organization is untouched. This is what catches an unscoped
  // delete -- one missing org_id predicate here destroys every tenant, and
  // the blob assertion alone would not notice.
  expect(await db.select().from(games).where(eq(games.orgId, otherUser.orgId))).toHaveLength(1);
  expect(await db.select().from(disks).where(eq(disks.orgId, otherUser.orgId))).toHaveLength(1);
  expect(await db.select().from(user).where(eq(user.email, otherUser.email))).toHaveLength(1);
});

test('the dialog refuses until the email is typed exactly', async ({ page }) => {
  const victim = await signUpFresh(page);
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  await page.getByTestId(`delete-user-${victim.email}`).click();
  const confirm = page.getByRole('button', { name: /delete permanently/i });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/type the email/i).fill('not-the-email@example.test');
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/type the email/i).fill(victim.email);
  await expect(confirm).toBeEnabled();
});

test('an allowlisted account cannot be deleted through the API', async ({ page }) => {
  const admin = await signInAsSuperAdmin(page);
  const rows = await getDb().select({ id: user.id }).from(user).where(eq(user.email, admin.email));
  expect(rows).toHaveLength(1);

  // Deleting it would not revoke anyone's admin -- the allowlist matches on
  // the ADDRESS -- it would just free that address for whoever registers it
  // next. The plane's bootstrap ordering exists for exactly that reason.
  const res = await page.request.delete(`/api/admin/users/${rows[0].id}`);
  expect(res.status()).toBe(409);
  expect(await getDb().select().from(user).where(eq(user.email, admin.email))).toHaveLength(1);
});

test('a non-admin cannot delete a user through the API', async ({ page }) => {
  await signUpFresh(page);
  // The id is deliberately one that does not exist: the guard must reject
  // before any lookup, so a 404-because-missing would be the wrong reason to
  // pass. Route param is a USER id, not an org id.
  //
  // 307, not a 4xx, and maxRedirects:0 -- see admin-invites.spec.ts for why
  // the plan's expected status list was wrong for this codebase.
  const res = await page.request.delete('/api/admin/users/usr_does_not_exist', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toContain('/library');
});

test('an anonymous caller cannot delete a user', async ({ request }) => {
  const res = await request.delete('/api/admin/users/usr_does_not_exist', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toContain('/sign-in');
});
