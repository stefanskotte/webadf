import { test, expect, type Page } from '@playwright/test';
import { type FakeEntry } from './amiga-board';
import { cleanupSeeded } from './device-helpers';
import { cards, LIVE, rowAt, seedTitle, serving, writable } from './files-disks-helpers';
import { DISKS_ONTO_VOLUME, DISKS_STAY_IN_LIBRARY } from '@/lib/files/shelf-rules';

/** Big copies part 2 on a phone (spec 2026-11-02): one pane at a time, so Copy to… picks the drawer the disks land in. */

test.afterAll(cleanupSeeded);

const names = (fs: Record<string, FakeEntry[]>, at: string) => (fs[at] ?? []).map((e) => e.name).sort();

function amiga(): Record<string, FakeEntry[]> {
  return { '': [{ name: 'Work', device: 'DH1:' }], 'Work:': [{ name: 'Monkey', dir: true }], 'Work:Monkey': [] };
}

async function openFiles(page: Page, left: string, right: string) {
  await page.goto(`/files?${new URLSearchParams({ left, right, active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

test('at 390: DSK rows go by Copy to… into a drawer on a volume, not STASH:; Move to… says the disks stay', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, token } = await writable(page, request);
  const { gameId } = await seedTitle(orgId, 'Monkey Island', ['Disk 1', 'Disk 2', 'Disk 3']);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, `LIBRARY:/${gameId}`, 'STASH:');
    await rowAt(page, 'left', 'Disk 1').getByRole('checkbox').tap();
    await rowAt(page, 'left', 'Disk 2').getByRole('checkbox').tap();
    await expect(page.getByTestId('files-phone-move')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('files-phone-copy')).not.toHaveAttribute('aria-disabled', 'true');

    await page.getByTestId('files-phone-copy').tap();
    const picker = page.getByTestId('files-copy-to');
    const here = picker.getByTestId('files-copy-to-here');
    await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('STASH:');
    await expect(here).toBeDisabled();
    await expect(picker.getByTestId('files-copy-to-reason')).toHaveText(DISKS_ONTO_VOLUME);
    await picker.getByTestId('files-copy-to-dev-NET').tap();
    await picker.getByTestId('files-copy-to-folder').filter({ hasText: 'A500' }).tap();
    await picker.getByTestId('files-copy-to-folder').filter({ hasText: 'Work' }).tap({ timeout: LIVE });
    await picker.getByTestId('files-copy-to-folder').filter({ hasText: 'Monkey' }).tap({ timeout: LIVE });
    await expect(picker.getByTestId('files-copy-to-crumb-3')).toHaveText('Monkey', { timeout: LIVE });
    await expect(here).toBeEnabled();
    await here.tap();
    await expect(picker).toBeHidden({ timeout: LIVE });
    await expect(cards(page).first()).toContainText('Copied 6 to A500', { timeout: 60_000 });
    expect(names(fs, 'Work:Monkey')).toEqual(['Disk 1', 'Disk 2']);
    expect(names(fs, 'Work:Monkey/Disk 2')).toEqual(['C', 'Disk.info', 'Empty', 'ReadMe']);

    await rowAt(page, 'left', 'Disk 3').getByRole('checkbox').tap();
    await page.getByTestId('files-phone-move').tap({ force: true });   // dimmed, not disabled: a tap says why
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: DISKS_STAY_IN_LIBRARY })).toBeVisible();
  } finally { await board.stop(); }
});

test('at 390: a TTL row goes by Copy to… too, and Move to… onto a volume is refused in the picker', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { orgId, deviceId, token } = await writable(page, request);
  await seedTitle(orgId, 'Monkey Island', ['Disk 1', 'Disk 2']);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'LIBRARY:', `NET:/${deviceId}/Work/Monkey`);
    await rowAt(page, 'left', 'Monkey Island').getByRole('checkbox').tap();
    const picker = page.getByTestId('files-copy-to');
    const here = picker.getByTestId('files-copy-to-here');

    await page.getByTestId('files-phone-move').tap();
    await expect(picker.getByTestId('files-copy-to-reason')).toHaveText(DISKS_STAY_IN_LIBRARY, { timeout: LIVE });
    await expect(here).toBeDisabled();
    await picker.getByTestId('files-copy-to-close').tap();
    await expect(picker).toBeHidden();

    await page.getByTestId('files-phone-copy').tap();
    await expect(here).toBeEnabled({ timeout: LIVE });
    await here.tap();
    await expect(picker).toBeHidden({ timeout: LIVE });
    await expect(cards(page).first()).toContainText('Copied 6 to A500', { timeout: 60_000 });
    expect(names(fs, 'Work:Monkey')).toEqual(['Disk 1', 'Disk 2']);
  } finally { await board.stop(); }
});
