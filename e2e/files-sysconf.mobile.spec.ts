import { expect, test } from '@playwright/test';
import { signUpFresh } from './helpers';

/** Create SysConf on a phone: under More, and a finger can paint the pointer (spec 2026-11-04). */
test('under More; a tap paints a cell; it creates the file', async ({ page }) => {
  await signUpFresh(page);
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: 'NET:', active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  await page.getByTestId('files-more').tap();
  await page.getByTestId('files-more-createsysconf').tap();
  const dialog = page.getByTestId('files-sysconf');
  await expect(dialog).toBeVisible();
  await page.getByTestId('pointer-ink-1').tap();
  const cell = page.getByTestId('pointer-cell-15-15');
  await cell.scrollIntoViewIfNeeded();
  const box = (await cell.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(14);
  await cell.tap();
  await expect(cell).toHaveAttribute('data-ink', 'R');
  await page.getByTestId('files-sysconf-submit').tap();
  await expect(dialog).toHaveCount(0);
  const res = await page.request.get('/api/files/download?path=STASH%3A%2Fsystem-configuration');
  expect((await res.body()).length).toBe(232);
});
