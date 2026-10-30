import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice, setBrowse } from './device-helpers';
import { boardSays, boardServes, type BoardRequest, type FakeEntry } from './amiga-board';

/**
 * NET: volumes on a phone (spec 2026-10-30 §5, plan Task 9): one pane at a time, Refresh in the More sheet, Copy to…
 * out of a volume into STASH:, and the read-only commands dimmed and saying why when tapped. The fake board answers
 * through the device routes as files-net-volumes.spec.ts's does.
 */

test.afterAll(cleanupSeeded);

const LIVE = 15_000;
const FW = '1.22.0+gabc1234';
const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

const FS: Record<string, FakeEntry[]> = {
  '': [{ name: 'Work', device: 'DH1:' }, { name: 'Workbench', device: 'DH0:' }],
  'Work:': [{ name: 'Programs', dir: true }, { name: 'a.lha', data: Buffer.from('an lha archive, as far as this test knows') }],
  'Work:Programs': [],
};

async function browsable(page: Page, request: APIRequestContext) {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500');
  await boardSays(request, token, FW);
  await setBrowse(deviceId, { firmware: FW, rx: 'c', rxProto: 3, browseOn: true });
  return { deviceId, token };
}

async function openFiles(page: Page, right: string) {
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right, active: 'right' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

function serving(request: APIRequestContext, token: string) {
  let done = false;
  const served: BoardRequest[] = [];
  const run = boardServes(request, token, FS, () => done, served, 60_000);
  return { served, stop: async () => { done = true; return run; } };
}

test('at 390: a board lists its volumes then Queue, and Refresh in the More sheet asks the Amiga again', async ({ page, request }) => {
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, `NET:/${deviceId}`);
  await expect(page.getByTestId('pane-pending')).toContainText('Reading volumes from A500');
  const board = serving(request, token);
  await expect(row(page, 'right', 'Work')).toBeVisible({ timeout: LIVE });
  await expect(row(page, 'right', 'Workbench')).toBeVisible();
  await expect(row(page, 'right', 'Queue')).toBeVisible();
  await expect(row(page, 'right', 'Work')).toContainText('DH1: ·');

  await page.getByTestId('files-more').tap();
  await page.getByTestId('files-more-refresh').tap();
  await expect.poll(() => board.served.length, { timeout: LIVE }).toBe(2);
  await expect(page.getByTestId('pane-pending')).toHaveCount(0, { timeout: LIVE });
  await expect(row(page, 'right', 'Work')).toBeVisible();
  expect((await board.stop()).map((r) => r.kind)).toEqual(['VOLS', 'VOLS']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('at 390: Copy to… takes a file out of a volume into STASH:', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, `NET:/${deviceId}/Work`);
  const board = serving(request, token);
  await expect(row(page, 'right', 'a.lha')).toBeVisible({ timeout: LIVE });
  await row(page, 'right', 'a.lha').tap();
  await page.getByTestId('files-phone-copy').tap();
  const picker = page.getByTestId('files-copy-to');
  await picker.getByTestId('files-copy-to-dev-STASH').tap();
  await expect(picker.getByTestId('files-copy-to-here')).toHaveText('Copy here');
  await picker.getByTestId('files-copy-to-here').tap();
  await expect(picker).toBeHidden({ timeout: LIVE });
  await expect(page.getByTestId('files-busy')).toContainText('Copied 1', { timeout: 30_000 });
  await page.getByTestId('files-side-left').tap();
  await expect(row(page, 'left', 'a.lha')).toBeVisible({ timeout: LIVE });
  expect((await board.stop()).map((r) => r.kind)).toContain('GET');
});

test('at 390: on a volume Move to…, Delete, Rename and Makedir are dimmed and a tap says Read-only for now', async ({ page, request }) => {
  const { deviceId, token } = await browsable(page, request);
  await openFiles(page, `NET:/${deviceId}/Work`);
  const board = serving(request, token);
  await expect(row(page, 'right', 'a.lha')).toBeVisible({ timeout: LIVE });
  await row(page, 'right', 'a.lha').tap();
  for (const id of ['move', 'delete']) await expect(page.getByTestId(`files-phone-${id}`)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('files-phone-copy')).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('files-phone-delete').tap({ force: true });   // dimmed, not disabled: a tap says why
  await expect(toast(page, 'Read-only for now')).toBeVisible();
  await page.getByTestId('files-more').tap();
  for (const id of ['rename', 'makedir']) await expect(page.getByTestId(`files-more-${id}`)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('files-more-refresh')).not.toHaveAttribute('aria-disabled', 'true');
  await board.stop();
});
