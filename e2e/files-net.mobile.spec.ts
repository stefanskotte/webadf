import { test, expect, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice } from './device-helpers';
import { boardSays } from './amiga-board';

/**
 * Files increment 3, Task 2, on a phone: NET: in the one-pane layout and the Copy to… picker. A board is a place the
 * picker walks into; inside it the button reads Send here, Move to… is refused in words, and the send lands in the
 * board's queue, which the other side then shows.
 */

test.afterAll(cleanupSeeded);

const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);

test('at 390: Copy to… walks into a board under NET: and sends; Move to… there is refused', async ({ page, request }) => {
  test.setTimeout(90_000);
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'A500 bench');
  await boardSays(request, token);
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: 'LIBRARY:', active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('to the amiga') }]);
  await expect(row(page, 'left', 'a.txt')).toBeVisible({ timeout: 15_000 });
  await row(page, 'left', 'a.txt').tap();

  // Move to… into a board: the picker walks there, and says why not.
  await page.getByTestId('files-phone-move').tap();
  let picker = page.getByTestId('files-copy-to');
  await picker.getByTestId('files-copy-to-dev-NET').tap();
  await picker.locator('[data-testid="files-copy-to-folder"][data-name="A500 bench"]').tap();
  await expect(picker.getByTestId('files-copy-to-reason')).toHaveText('Files sent to the Amiga stay where they are — use Copy');
  await expect(picker.getByTestId('files-copy-to-here')).toBeDisabled();
  await picker.getByTestId('files-copy-to-close').tap();
  await expect(picker).toBeHidden();

  // Copy to…: NET: itself asks for a board; inside one, Send here.
  await page.getByTestId('files-phone-copy').tap();
  picker = page.getByTestId('files-copy-to');
  await picker.getByTestId('files-copy-to-dev-NET').tap();
  await expect(picker.getByTestId('files-copy-to-reason')).toHaveText('Open a board to send files to it');
  await picker.locator('[data-testid="files-copy-to-folder"][data-name="A500 bench"]').tap();
  await expect(picker.getByTestId('files-copy-to-here')).toHaveText('Send here');
  await picker.getByTestId('files-copy-to-here').tap();
  await expect(picker).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Queued 1 file to A500 bench.' })).toBeVisible({ timeout: 15_000 });

  // The other side went to the board: its queue, one pane at a time.
  await page.getByTestId('files-side-right').tap();
  await expect(row(page, 'right', 'a.txt')).toContainText('Waiting', { timeout: 15_000 });
  await expect(page.getByTestId('pane-right-crumb-1')).toHaveText('A500 bench');
  const box = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(box).toBeLessThanOrEqual(390);
});

test('at 390: the two drop zones stack and the Send zone has 44 px targets and no sideways scroll', async ({ page, request }) => {
  await signUpFresh(page);
  const a = await pairDevice(page, request, 'A500 bench');
  await boardSays(request, a.token);
  const b = await pairDevice(page, request, 'A1200');
  await boardSays(request, b.token);
  await page.goto('/files');
  await expect(page.getByTestId('files-drop-send')).toBeVisible();
  await expect(page.getByTestId('files-drop-stash')).toBeAttached();
  const picker = page.getByTestId('files-send-board-picker');
  await expect(picker).toBeVisible();
  for (const label of await picker.locator('label').all()) {
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const tile = (await page.getByTestId('files-send-browse').boundingBox())!;
  expect(tile.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The picker sends from a phone.
  await page.getByTestId('files-send-input').setInputFiles([{ name: 'p.txt', mimeType: 'text/plain', buffer: Buffer.from('phone') }]);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Queued 1 file for/ })).toBeVisible({ timeout: 15_000 });
});
