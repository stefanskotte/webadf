import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice, setBrowse } from './device-helpers';
import { boardQueue, boardSays, boardServes, fakeBoardTiming, type BoardRequest, type FakeEntry, type VolumeNext } from './amiga-board';

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

test('on Files a card fills, finishes and fades; the status row does not say it', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await stashPack(page, ['one.txt', 'two.txt']);
    fakeBoardTiming.queueLimit = 1;
    await rowAt(page, 'left', 'Pack').click();
    await page.getByTestId('files-copy').click();
    const card = page.getByTestId('transfers-card').first();
    await expect(card.getByTestId('transfers-card-line')).toContainText('1 of 2 files', { timeout: LIVE });
    expect(Number(await card.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    await expect(page.getByTestId('files-busy')).toHaveText('');
    fakeBoardTiming.queueLimit = Infinity;
    await expect(card.getByTestId('transfers-card-result')).toHaveText('Copied 2 to A500', { timeout: 30_000 });
    await expect(page.getByTestId('transfers-announce')).toHaveText('Copied 2 to A500');
    // A clean finish fades after 6 s.
    await expect(page.getByTestId('transfers-card')).toHaveCount(0, { timeout: 12_000 });
  } finally { fakeBoardTiming.queueLimit = Infinity; await board.stop(); }
});

test('Cancel the rest asks first; what arrived stays, the rest never goes, and the card stays', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await stashPack(page, ['one.txt', 'two.txt', 'three.txt']);
    fakeBoardTiming.queueLimit = 1;
    await rowAt(page, 'left', 'Pack').click();
    await page.getByTestId('files-copy').click();
    const card = page.getByTestId('transfers-card').first();
    await expect(card.getByTestId('transfers-card-line')).toContainText('1 of 3 files', { timeout: LIVE });

    await card.getByTestId('transfers-cancel').click();
    await expect(page.getByTestId('transfers-cancel-text')).toHaveText('Cancel the rest of this copy? What has arrived stays.');
    await page.getByTestId('transfers-cancel-yes').click();
    await expect(page.getByTestId('transfers-cancel-dialog')).toBeHidden({ timeout: LIVE });
    await expect(card.getByTestId('transfers-card-result')).toHaveText('Cancelled: 1 of 3 copied', { timeout: LIVE });
    await expect(card).toHaveAttribute('data-state', 'kept');

    // Nothing more goes, even with the board free to take it: asked again and again for a second, it stays so.
    fakeBoardTiming.queueLimit = Infinity;
    for (let k = 0; k < 5; k++) {
      expect(await boardQueue(request, token)).toMatch(/^NEXT -/);
      expect((fs['Work:Tools/Pack'] ?? []).filter((e) => !e.dir)).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 250));
    }
    // A cancelled card stays until closed.
    await card.getByTestId('transfers-close').click();
    await expect(page.getByTestId('transfers-card')).toHaveCount(0);
  } finally { fakeBoardTiming.queueLimit = Infinity; await board.stop(); }
});
