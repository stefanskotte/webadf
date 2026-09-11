import { test, expect, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const cursorOf = (l: Locator) =>
  l.evaluate((el) => getComputedStyle(el).cursor);
const shadowOf = (l: Locator) =>
  l.evaluate((el) => getComputedStyle(el).boxShadow);

/**
 * The operator's report was that buttons and labels are hard to tell apart on
 * a glass design where both sit pale on a pale card. The pointer and the hover
 * ARE the distinction, so these assert the distinction exists rather than
 * asserting a particular shade -- a test pinned to an exact rgba would fail on
 * any future restyle while telling nobody anything about affordance.
 */
test('an enabled button shows a pointer and changes under the cursor', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  await pairDevice(page, request);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `Affordance-${tag}`, diskNo: 1, sha256: sha(tag),
  });

  await page.goto(`/games/${gameId}`);
  const mount = page.getByTestId(`mount-${diskId}`);
  await expect(mount).toBeVisible();

  expect(await cursorOf(mount)).toBe('pointer');

  const rest = await shadowOf(mount);
  await mount.hover();
  await expect.poll(() => shadowOf(mount)).not.toBe(rest);
});

test('a link styled as a button gets the same treatment, not just <button>', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `AffordanceLink-${tag}`, diskNo: 1, sha256: sha(tag),
  });

  await page.goto(`/games/${gameId}`);
  // Download is an <a>, deliberately -- it must be a real request so the
  // browser streams the file. Anchors get a pointer for free, so the thing
  // worth checking is that it also HOVERS like its neighbours; without that it
  // reads as the odd one out in a row of controls.
  const download = page.getByTestId(`download-${diskId}`);
  await expect(download).toBeVisible();

  const rest = await shadowOf(download);
  await download.hover();
  await expect.poll(() => shadowOf(download)).not.toBe(rest);
});

test('a disabled control says so with the cursor, and does not light up', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId, diskId } = await seedDisk(orgId, {
    title: `AffordanceOff-${tag}`, diskNo: 1, sha256: sha(tag),
  });
  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId(`disk-${diskId}`)).toBeVisible();

  // Disable a real control in place rather than hunting for a transiently
  // disabled one: what is under test is the rule, and the rule keys on the
  // attribute. A disabled control that lights up under the cursor is a worse
  // lie than one with no affordance at all.
  const wp = page.getByTestId(`wp-${diskId}`);
  await wp.evaluate((el) => el.setAttribute('disabled', ''));

  expect(await cursorOf(wp)).toBe('not-allowed');
  const rest = await shadowOf(wp);
  await wp.hover({ force: true });
  expect(await shadowOf(wp)).toBe(rest);
});
