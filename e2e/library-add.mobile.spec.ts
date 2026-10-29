import { test, expect } from '@playwright/test';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded } from './device-helpers';

/**
 * The Library's Add disks ▾ on a phone (Files increment 3, Task 5): a phone has no OS drag, so the file picker is
 * the way in. The button and its items are 44 px targets, and the tray fits 390 px without a sideways scroll.
 */
test.afterAll(cleanupSeeded);

test('Add disks ▾ → Browse files… adds a disk, and the tray fits the phone', async ({ page }) => {
  const tag = runTag();
  await signUpFresh(page);
  await page.goto('/library');

  const button = page.getByTestId('library-add-disks');
  await expect(button).toBeVisible();
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const browse = page.getByTestId('library-add-browse');
  await expect(browse).toBeVisible();
  // Polled: the popup opens with a zoom-in from 95 %, so a box read mid-animation is short of its size.
  await expect.poll(async () => (await browse.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => (await page.getByTestId('library-add-url').boundingBox())!.height).toBeGreaterThanOrEqual(44);

  const adf = Buffer.alloc(901_120);
  adf.write(`DOS\0webadf-library-add-phone-${tag}`, 0);
  const chooser = page.waitForEvent('filechooser');
  await browse.click();
  await (await chooser).setFiles({ name: `LibAdd Phone ${tag} (1990)(X).adf`, mimeType: 'application/octet-stream', buffer: adf });

  const tray = page.getByTestId('library-tray');
  await expect(page.getByTestId('library-tray-summary')).toHaveText('1 added', { timeout: 30_000 });
  await expect(page.getByTestId('game-card').filter({ hasText: `LibAdd Phone ${tag}` })).toHaveCount(1);
  const box = (await tray.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // Above the bottom tab bar, and its Close is a finger's target.
  await tray.scrollIntoViewIfNeeded();
  const bar = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
  const shown = (await tray.boundingBox())!;
  expect(shown.y + shown.height).toBeLessThanOrEqual(bar.y + 1);
  const close = page.getByTestId('library-tray-close');
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const open = page.locator('[data-testid^="library-tray-open-"]');
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(tray).toHaveCount(0);
});
