import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded } from './device-helpers';

// Per-user preferences (HANDOFF §4 "Per-user web app settings"): the start
// page and the library sort, stored server-side so they follow the user.

test.afterAll(cleanupSeeded);

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// The real ingest round trip, as library.spec.ts does it.
async function pushGame(page: Page, title: string) {
  const content = Buffer.from(`${title}-${Date.now()}-${Math.random()}`);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', { data: { files: [{ sha256, sizeBytes: content.length }] } });
  const { uploads } = await presign.json();
  const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  if (!put.ok) throw new Error(`test setup: blob PUT failed with ${put.status}`);
  const res = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: content.length, filename: `${title}.adf` }] },
  });
  if (res.status() !== 200) throw new Error(`test setup: /complete failed with ${res.status()}`);
}

test('the chosen start page is where the root URL and sign-in land', async ({ page }) => {
  const { email, password } = await signUpFresh(page);

  // Default: today's behaviour.
  await page.goto('/');
  await expect(page).toHaveURL(/\/library/);

  await page.getByTestId('settings-link').click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  await page.getByTestId('pref-start-page').selectOption('devices');
  await expect(page.getByTestId('prefs-state')).toHaveText('Unsaved changes');
  await page.getByTestId('prefs-save').click();
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');

  await page.goto('/');
  await expect(page).toHaveURL(/\/devices/);

  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/devices/);

  // And Upload, whose route is /ingest.
  await page.goto('/settings');
  await page.getByTestId('pref-start-page').selectOption('upload');
  await page.getByTestId('prefs-save').click();
  await expect(page.getByTestId('prefs-state')).toHaveText('All changes saved');
  await page.goto('/');
  await expect(page).toHaveURL(/\/ingest/);
});

test('a changed library sort survives a reload and a new browser for the same user', async ({ page, browser }) => {
  const { email, password } = await signUpFresh(page);
  const run = runTag();
  const first = `Aardvark Sort ${run}`;
  const second = `Zebra Sort ${run}`;
  await pushGame(page, first);
  await pushGame(page, second);

  const titles = (p: Page) => p.getByTestId('game-card').filter({ hasText: run });

  // Default: newest added first.
  await page.goto('/library');
  await expect(page.getByTestId('library-sort')).toHaveValue('added-desc');
  await expect(titles(page).first()).toContainText(second);

  await page.getByTestId('library-sort').selectOption('title-asc');
  await expect(titles(page).first()).toContainText(first);
  await expect(titles(page).last()).toContainText(second);

  await page.reload();
  await expect(page.getByTestId('library-sort')).toHaveValue('title-asc');
  await expect(titles(page).first()).toContainText(first);

  // A different browser: nothing carried over but the account.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await signIn(p2, email, password);
  await expect(p2).toHaveURL(/\/library/);
  await expect(p2.getByTestId('library-sort')).toHaveValue('title-asc');
  await expect(titles(p2).first()).toContainText(first);

  // The Preferences page shows the same choice.
  await p2.goto('/settings');
  await expect(p2.getByTestId('pref-library-sort')).toHaveValue('title-asc');
  await other.close();
});
