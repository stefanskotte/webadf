import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice, setBrowse } from './device-helpers';
import { boardSays, boardServes, fakeBoardTiming, type BoardRequest, type FakeEntry, type VolumeNext } from './amiga-board';

/**
 * The progress panel (spec 2026-11-01-progress-panel): a Files job against a fake board that answers as firmware 1.23
 * with Transfer 2.6 -- the card on every page, its pill, what a reload keeps, and Cancel the rest.
 */

test.afterAll(cleanupSeeded);

const LIVE = 15_000;
const FW = '1.23.0+gabc1234';
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);

function amiga(): Record<string, FakeEntry[]> {
  return {
    '': [{ name: 'Work', device: 'DH1:' }],
    'Work:': [{ name: 'Tools', dir: true }],
    'Work:Tools': [{ name: 'x.lha', data: Buffer.from('old x') }],
  };
}

async function writable(page: Page, request: APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500');
  await boardSays(request, token, FW);
  await setBrowse(deviceId, { firmware: FW, rx: 'c', rxProto: 5, browseOn: true, writeOn: true });
  return { orgId, deviceId, token };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

function serving(request: APIRequestContext, token: string, fs: Record<string, FakeEntry[]>, maxMs = 120_000) {
  let done = false;
  const served: BoardRequest[] = [];
  const queue: VolumeNext[] = [];
  const run = boardServes(request, token, fs, () => done, served, maxMs, { queue });
  return { served, queue, stop: async () => { done = true; return run; } };
}

/** A STASH: drawer Pack holding `names` (the zone drops into STASH:; the ops route moves them in), the left pane in STASH:. */
async function stashPack(page: Page, names: string[]) {
  await page.getByTestId('files-stash-input').setInputFiles(names.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
  await expect(rowAt(page, 'left', names[names.length - 1])).toBeVisible({ timeout: LIVE });
  expect((await page.request.post('/api/files/ops', { data: { op: 'makedir', dest: 'STASH:', name: 'Pack' } })).ok()).toBe(true);
  expect((await page.request.post('/api/files/ops', { data: { op: 'move', sources: names.map((n) => `STASH:/${n}`), dest: 'STASH:/Pack', onClash: 'ask' } })).ok()).toBe(true);
  await page.getByTestId('files-refresh').click();
  await expect(rowAt(page, 'left', 'Pack')).toBeVisible({ timeout: LIVE });
}

test('a copy onto a volume shows in the panel, on the Library page too; collapsed stays collapsed after a reload', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await stashPack(page, ['one.txt', 'two.txt']);
    fakeBoardTiming.queueHeld = true;
    await rowAt(page, 'left', 'Pack').click();
    await page.getByTestId('files-copy').click();
    const panel = page.getByRole('region', { name: 'Transfers' });
    const card = panel.getByTestId('transfers-card').first();
    await expect(card.getByTestId('transfers-card-title')).toHaveText('Copying to A500 · Work:Tools/Pack', { timeout: LIVE });
    await expect(card.getByTestId('transfers-card-line')).toContainText('0 of 2 files');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    await expect(card.getByTestId('transfers-cancel')).toHaveText('Cancel the rest');

    // Collapsed: the pill alone -- and so after a reload, and on another page.
    const pill = page.getByTestId('transfers-pill');
    await pill.click();
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
    await expect(pill).toHaveText('1 job · 0 %');
    await expect(page.getByTestId('transfers-cards')).toBeHidden();
    await page.reload();
    await expect(pill).toHaveAttribute('aria-expanded', 'false', { timeout: LIVE });
    await page.goto('/library');
    await expect(pill).toHaveText('1 job · 0 %', { timeout: LIVE });
    await pill.click();
    await expect(panel.getByTestId('transfers-card-title').first()).toHaveText('Copying to A500 · Work:Tools/Pack');

    fakeBoardTiming.queueHeld = false;
    await expect(panel.getByTestId('transfers-card-result').first()).toHaveText('Copied 2 to A500', { timeout: 30_000 });
    await expect.poll(() => (fs['Work:Tools/Pack'] ?? []).map((e) => e.name).sort(), { timeout: LIVE }).toEqual(['one.txt', 'two.txt']);
  } finally { fakeBoardTiming.queueHeld = false; await board.stop(); }
});
