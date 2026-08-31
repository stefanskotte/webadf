import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded } from './device-helpers';
import { ALPHABET } from '@/lib/invites';

test.afterAll(cleanupSeeded);

const CODE_RE = new RegExp(`^[${ALPHABET}]{8}$`);

async function issueCode(page: import('@playwright/test').Page): Promise<string> {
  await page.getByRole('button', { name: /issue invite/i }).click();
  const code = (await page.getByTestId('new-invite-code').textContent())?.trim() ?? '';
  expect(code).toMatch(CODE_RE);
  return code;
}

test('issuing shows a code that then appears in the list', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const code = await issueCode(page);
  await expect(page.getByTestId(`invite-${code}`)).toBeVisible();
});

test('a live code is exactly what the sign-up gate accepts', async ({ page, context }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const code = await issueCode(page);

  // The other half of the revoke test below: proving a freshly issued code
  // really does work means the revoked one failing is about the revoke, not
  // about invites being broken generally.
  const consumer = await context.browser()!.newPage();
  await consumer.goto('/sign-up');
  await consumer.getByLabel('Email').fill(`invited-${Date.now()}@example.test`);
  await consumer.getByLabel('Password').fill('correct-horse-battery-staple');
  await consumer.getByLabel('Invite code').fill(code);
  await consumer.getByRole('button', { name: /sign up/i }).click();
  await expect(consumer).toHaveURL(/\/library/, { timeout: 15_000 });
  await consumer.close();
});

test('a revoked code disappears and no longer works at sign-up', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const code = await issueCode(page);

  await page.getByTestId(`revoke-${code}`).click();
  await expect(page.getByTestId(`invite-${code}`)).toHaveCount(0);

  // The real proof: it is dead as a credential, not merely hidden.
  await page.context().clearCookies();
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(`revoked-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Invite code').fill(code);
  await page.getByRole('button', { name: /sign up/i }).click();
  await expect(page.getByText(/invalid or already used/i)).toBeVisible();
});

test('a consumed code cannot be revoked', async ({ page, context }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const code = await issueCode(page);

  const consumer = await context.browser()!.newPage();
  await consumer.goto('/sign-up');
  await consumer.getByLabel('Email').fill(`consumer-${Date.now()}@example.test`);
  await consumer.getByLabel('Password').fill('correct-horse-battery-staple');
  await consumer.getByLabel('Invite code').fill(code);
  await consumer.getByRole('button', { name: /sign up/i }).click();
  await expect(consumer).toHaveURL(/\/library/, { timeout: 15_000 });
  await consumer.close();

  // 409, not a silent 204: the row is the record that an account was created
  // against this code, and the operator should be told the difference.
  const res = await page.request.delete(`/api/admin/invites/${code}`);
  expect(res.status()).toBe(409);
});

test('revoking a code that does not exist is a 404', async ({ page }) => {
  await signInAsSuperAdmin(page);
  const res = await page.request.delete('/api/admin/invites/ZZZZZZZZ');
  expect(res.status()).toBe(404);
});

test('a non-admin cannot reach the invite API even though the page guard is separate', async ({ page }) => {
  await signUpFresh(page);
  // This codebase answers an unauthorized API caller with a redirect, not a
  // JSON error (see the anonymous-caller test in mount-actions.spec.ts), so
  // the redirect must not be followed or Playwright reports the 200 of the
  // page it lands on. /library, not /sign-in: the caller IS signed in, just
  // not an admin, and the response must not confirm /api/admin exists.
  const post = await page.request.post('/api/admin/invites', { maxRedirects: 0 });
  expect(post.status()).toBe(307);
  expect(post.headers()['location']).toContain('/library');

  const del = await page.request.delete('/api/admin/invites/AAAAAAAA', { maxRedirects: 0 });
  expect(del.status()).toBe(307);
  expect(del.headers()['location']).toContain('/library');
});

test('an anonymous caller cannot reach the invite API at all', async ({ request }) => {
  // DELETE is asserted as well as POST, and deliberately so: POST also calls
  // requireOrg() for the issuing org, which redirects an anonymous caller by
  // itself -- so POST alone would still pass with requireSuperAdmin() removed
  // (measured, by removing it). DELETE has no such second guard, which makes
  // it the one that actually proves this route is protected.
  for (const method of ['post', 'delete'] as const) {
    const path = method === 'post' ? '/api/admin/invites' : '/api/admin/invites/AAAAAAAA';
    const res = await request[method](path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(307);
    expect(res.headers()['location'], path).toContain('/sign-in');
  }
});
