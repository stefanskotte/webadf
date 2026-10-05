import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, cleanupSeeded } from './device-helpers';

// Context help at phone width (spec 2026-10-05-context-help §4: fits 390 px, tap to open).

test.afterAll(cleanupSeeded);

test('at phone width a tapped "?" is fully on screen and its More link works', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request);
  await page.goto('/devices');
  // The device card's "?" sits at the card's right edge -- the hard case for a popover.
  await page.getByTestId('help-tip-boards').last().tap();
  const pop = page.getByTestId('help-pop-boards');
  await expect(pop).toBeVisible();
  await expect(pop).toBeInViewport({ ratio: 1 });
  await page.getByTestId('help-more-boards').tap();
  await expect(page).toHaveURL(/\/help#boards$/);
  await expect(page.getByTestId('help-section-boards').getByRole('heading')).toBeInViewport();
});
