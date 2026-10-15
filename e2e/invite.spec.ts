import { test, expect } from '@playwright/test';
import { mintInviteCode, paceSignUp } from './helpers';

test('sign-up without an invite code is rejected', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(`no-invite-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Invite code').fill('AAAAAAAA');
  await page.getByRole('button', { name: 'Sign up' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).not.toHaveURL(/\/library/);
});

test('an invite code cannot be used twice', async ({ page, browser }) => {
  // First use succeeds via the helper, which mints and consumes a fresh code.
  const { inviteCode } = await import('./helpers').then((m) => m.signUpFresh(page));

  const ctx = await browser.newContext();
  const second = await ctx.newPage();
  await second.goto('/sign-up');
  await second.getByLabel('Email').fill(`reuse-${Date.now()}@example.test`);
  await second.getByLabel('Password').fill('correct-horse-battery-staple');
  await second.getByLabel('Invite code').fill(inviteCode);
  await second.getByRole('button', { name: 'Sign up' }).click();

  await expect(second.getByRole('alert')).toBeVisible();
  await expect(second).not.toHaveURL(/\/library/);
  await ctx.close();
});

// The property that actually matters for D13: a single leaked or guessed
// invite code must not be able to mint more than one account, no matter how
// many sign-ups race to redeem it at once. This is a regression test for a
// bug found in review -- an earlier implementation validated the code with a
// plain SELECT in `user.create.before` and only wrote `consumedAt` later, in
// `user.create.after`, by which point the user, credential and session
// already existed. That left a window between the read and the write where
// concurrent callers could all observe the code as unconsumed and all
// succeed. Hits the API directly (bypassing the UI form) so all N requests
// are genuinely in flight together, the same shape as the concurrent-claim
// proof in e2e/pairing.spec.ts's underlying implementation.
test('a leaked invite code can only create one account under concurrent sign-ups', async ({ request }) => {
  const inviteCode = await mintInviteCode();
  const attempts = 10;
  // Against a production-mode server (the self-hosting stack) the sign-up rate limit is shared with the sign-ups
  // before this one; start from an empty window. A no-op unless E2E_SIGNUP_GAP_MS is set.
  await paceSignUp(Number(process.env.E2E_SIGNUP_GAP_MS ?? 0) * 3);

  const responses = await Promise.all(
    Array.from({ length: attempts }, (_, i) => request.post('/api/auth/sign-up/email', {
      data: {
        email: `race-${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}@example.test`,
        password: 'correct-horse-battery-staple',
        name: 'race',
        inviteCode,
      },
    })),
  );

  const statuses = responses.map((r) => r.status());
  const successes = statuses.filter((s) => s === 200).length;
  const failures = statuses.filter((s) => s !== 200).length;

  expect(successes).toBe(1);
  expect(failures).toBe(attempts - 1);
});

test('sign-up prefills the invite code from ?invite=', async ({ page }) => {
  await page.goto('/sign-up?invite=ABCD2345');
  await expect(page.getByLabel('Invite code')).toHaveValue('ABCD2345');
});

// A production build prerenders pages; a client page reading useSearchParams under a fallback-less Suspense
// prerendered to nothing, so the HTML had no form until the JavaScript ran. The page reads searchParams on the
// server now: the HTML itself carries the form and the invite code.
test('the sign-up HTML carries the form with the invite code (no empty shell)', async ({ request }) => {
  const res = await request.get('/sign-up?invite=ABCD2345');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('Create your library');
  expect(html).toMatch(/<input[^>]*id="invite-code"[^>]*value="ABCD2345"|<input[^>]*value="ABCD2345"[^>]*id="invite-code"/);
});
