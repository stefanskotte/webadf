import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

// Context help (spec docs/superpowers/specs/2026-10-05-context-help-design.md).

test.afterAll(cleanupSeeded);

test('a help button opens a short explanation that links to its /help section', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request);
  await page.goto('/devices');
  await page.getByTestId('help-tip-boards').first().click();
  const pop = page.getByTestId('help-pop-boards');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Pair it once');
  // Fully on screen, desktop and phone (both projects run this).
  await expect(pop).toBeInViewport({ ratio: 1 });
  await page.getByTestId('help-more-boards').click();
  await expect(page).toHaveURL(/\/help#boards$/);
  // Not hidden under the sticky header.
  await expect(page.getByTestId('help-section-boards').getByRole('heading')).toBeInViewport();
});

test('/help lists every topic', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/help');
  for (const id of ['boards', 'nfc', 'next-disk', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display', 'second-drive', 'cover-image']) {
    await expect(page.getByTestId(`help-section-${id}`)).toBeVisible();
  }
});

test('keyboard: Enter opens the "?", Esc closes it and returns focus', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request);
  await page.goto('/devices');
  const tip = page.getByTestId('help-tip-boards').first();
  await tip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('help-pop-boards')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help-pop-boards')).toBeHidden();
  await expect(tip).toBeFocused();
});

test('the help button does not trigger the control beside it', async ({ page, request }) => {
  // The Display "?" sits beside the Display toggle; opening help must not expand the editor.
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const r = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, displayLayouts: true, displayVersion: 0 },
  });
  expect(r.status()).toBe(204);
  await page.goto('/devices');
  await page.getByTestId('help-tip-display').first().click();
  await expect(page.getByTestId('help-pop-display')).toBeVisible();
  await expect(page.getByTestId(`display-canvas-${deviceId}`)).toHaveCount(0);
});

test('signed out, /help goes to sign-in like every app page', async ({ page }) => {
  await page.goto('/help');
  await expect(page).toHaveURL(/\/sign-in/);
});
