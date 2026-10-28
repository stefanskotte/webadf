import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signUpFresh } from './helpers';
import { hydrated } from './device-helpers';

/**
 * Library sharing, the owner's side (spec §3.4, Task 4): Settings › Sharing's New share / Edit collections / Revoke /
 * Delete, the owner's /api/shares routes, and the /s/<code> landing page. Run with
 * `bash scripts/e2e-local.sh e2e/sharing-owner.spec.ts` (its own Postgres).
 */
test.describe.configure({ timeout: 90_000 });

test('Settings › Sharing: new share, edit, revoke, delete; the landing page', async ({ page, browser }) => {
  await signUpFresh(page);
  for (const name of ['Games', 'Demos']) {
    const r = await page.request.post('/api/collections', { data: { name } });
    expect(r.ok()).toBe(true);
  }

  await page.goto('/settings/library');
  await expect(page.getByTestId('settings-sections').getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  const card = page.getByTestId('sharing-settings');
  await expect(card.getByTestId('sharing-empty')).toBeVisible();
  // Nothing shared yet: the server does not ping itself on load (final review 10); Check asks, and the line settles
  // on an answer (this dev server is http: on loopback, so it is red here).
  await expect(card.getByTestId('sharing-reach')).toHaveAttribute('data-state', 'idle');
  await hydrated(page, 'sharing-reach-check');
  await card.getByTestId('sharing-reach-check').click();
  await expect(card.getByTestId('sharing-reach')).toHaveAttribute('data-state', /^(ok|failed)$/, { timeout: 20_000 });

  // New share for Rob, Games only.
  await hydrated(page, 'sharing-new');
  await card.getByTestId('sharing-new').click();
  const dlg = page.getByTestId('sharing-new-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('sharing-label').fill('Rob');
  await expect(dlg.getByTestId('sharing-save')).toBeDisabled();
  await dlg.locator('label', { hasText: 'Games' }).getByTestId('sharing-collection').check();
  await dlg.getByTestId('sharing-save').click();

  const created = page.getByTestId('sharing-created-dialog');
  await expect(created).toBeVisible();
  const link = await created.getByTestId('sharing-link').inputValue();
  expect(link).toMatch(/^http:\/\/localhost:\d+\/s\/wfsc_[A-Za-z0-9_-]{43}$/);
  await expect(created.getByTestId('sharing-expiry')).toContainText(/^It works once\. Unclaimed links expire on \d{1,2} \w{3} \d{4}\.$/);
  await created.getByRole('button', { name: 'Done' }).click();
  await expect(created).toBeHidden();

  const row = card.getByTestId('sharing-row').filter({ hasText: 'Rob' });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('sharing-status')).toContainText('Waiting to be claimed, until');
  await expect(row.getByTestId('sharing-scope')).toHaveText('Games');
  // Live shares cannot be deleted.
  await expect(row.getByTestId('sharing-delete')).toHaveCount(0);

  // Edit collections → Everything.
  await row.getByTestId('sharing-edit').click();
  const edit = page.getByTestId('sharing-edit-dialog');
  await expect(edit).toBeVisible();
  await edit.getByTestId('sharing-everything').check();
  await edit.getByTestId('sharing-save').click();
  await expect(edit).toBeHidden();
  await expect(row.getByTestId('sharing-scope')).toHaveText('Everything');

  // Revoke with the spec's confirm text.
  await row.getByTestId('sharing-revoke').click();
  const revoke = page.getByTestId('sharing-revoke-dialog');
  await expect(revoke.getByTestId('sharing-revoke-text'))
    .toHaveText('Rob loses access immediately. Disks Rob has changed stay theirs.');
  await revoke.getByTestId('sharing-revoke-confirm').click();
  await expect(revoke).toBeHidden();
  await expect(row.getByTestId('sharing-status')).toHaveText('Revoked');
  await expect(row.getByTestId('sharing-edit')).toHaveCount(0);

  // Delete removes the row.
  await row.getByTestId('sharing-delete').click();
  await expect(card.getByTestId('sharing-row')).toHaveCount(0);
  await expect(card.getByTestId('sharing-empty')).toBeVisible();

  // The landing page, signed out (a fresh context): headers, generic text, the address form.
  const path = new URL(link).pathname;
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  const res = await visitor.goto(`${path}#pin=${'P'.repeat(43)}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['referrer-policy']).toBe('no-referrer');
  // next.config asks for no-store; `next dev` rewrites a page's Cache-Control to no-cache (production keeps no-store).
  expect(res?.headers()['cache-control']).toMatch(/no-store|no-cache/);
  await expect(visitor.getByTestId('landing-text'))
    .toHaveText('A WebFloppy library was shared with you. Open your WebFloppy and paste this link in Remote › Add.');
  // After hydration the shown link is the whole address, fragment included.
  await expect(visitor.getByTestId('landing-link')).toHaveValue(new RegExp(`${path}#pin=P{43}$`));
  const full = await visitor.getByTestId('landing-link').inputValue();
  await visitor.route('https://my-floppy.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }));
  await visitor.getByTestId('landing-address').fill('my-floppy.test');
  await hydrated(visitor, 'landing-form', 'onSubmit');
  await visitor.getByTestId('landing-go').click();
  await expect(visitor).toHaveURL(`https://my-floppy.test/remote/add#link=${encodeURIComponent(full)}`);
  await anon.close();
});

test('/api/shares: validation, and another org\'s or an unknown share is 404', async ({ page }) => {
  await signUpFresh(page);
  const bad = await page.request.post('/api/shares', { data: { label: 'X', everything: 'yes', collectionIds: [] } });
  expect(bad.status()).toBe(400);
  const noScope = await page.request.post('/api/shares', { data: { label: 'X', everything: false, collectionIds: [] } });
  expect(noScope.status()).toBe(400);
  expect((await noScope.json()).error).toBe('no_scope');
  const foreignCollection = await page.request.post('/api/shares', { data: { label: 'X', everything: false, collectionIds: [randomUUID()] } });
  expect(foreignCollection.status()).toBe(400);

  const ok = await page.request.post('/api/shares', { data: { label: 'Ann', everything: true } });
  expect(ok.ok()).toBe(true);
  const { share, link } = await ok.json() as { share: { id: string }; link: string };
  expect(link).toMatch(/\/s\/wfsc_/);
  // A live share is not deletable.
  expect((await page.request.delete(`/api/shares/${share.id}`)).status()).toBe(409);

  const unknown = randomUUID();
  expect((await page.request.patch(`/api/shares/${unknown}`, { data: { everything: true } })).status()).toBe(404);
  expect((await page.request.delete(`/api/shares/${unknown}`)).status()).toBe(404);
  expect((await page.request.post(`/api/shares/${unknown}/revoke`)).status()).toBe(404);

  // Another account cannot see or touch Ann's share.
  const other = await page.context().browser()!.newContext();
  const p2 = await other.newPage();
  await signUpFresh(p2);
  const list = await (await p2.request.get('/api/shares')).json() as { shares: unknown[] };
  expect(list.shares).toEqual([]);
  expect((await p2.request.patch(`/api/shares/${share.id}`, { data: { everything: true } })).status()).toBe(404);
  expect((await p2.request.post(`/api/shares/${share.id}/revoke`)).status()).toBe(404);
  expect((await p2.request.delete(`/api/shares/${share.id}`)).status()).toBe(404);
  await other.close();
});
