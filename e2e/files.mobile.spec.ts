import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch } from '@/lib/adffs/write';
import { readVolume } from '@/lib/adffs';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

/**
 * Files on a phone (spec 2026-10-29 §5, Files increment 1 Task 10): below lg one pane at a time, a Left | Right switch,
 * the button column as a bottom bar, and Copy to… / Move to… through a picker instead of the other pane. The `mobile`
 * project runs this file at 390 x 844 with touch.
 */

test.afterAll(cleanupSeeded);

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

/** A real FFS disk, stored and seeded as a one-disk title of this org; `withFile` puts ReadMe on it. */
async function seedRealDisk(orgId: string, title: string, withFile: boolean) {
  const r = applyBatch(withFile ? [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: new TextEncoder().encode('hello\n') }] : [])(
    formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 20) }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  return seedDisk(orgId, { title, diskNo: 1, sha256, writeProtected: false });
}

async function storedNames(diskId: string): Promise<string[]> {
  const [d] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  const vol = readVolume(await diskStore.read(d.sha256));
  if (!vol.ok) throw new Error('no volume');
  return vol.root.map((e) => e.name);
}

const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).getByTestId('pane-row').filter({ hasText: name });

test('at 390: one pane, the side switch, the bottom bar; Copy to… copies a file into the other disk', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const from = await seedRealDisk(orgId, `PhoneA-${tag}`, true);
  const to = await seedRealDisk(orgId, `PhoneB-${tag}`, false);

  // Files… from the disk's title page: the disk on the right, LIBRARY: on the left.
  await page.goto(`/games/${from.gameId}`);
  await page.getByTestId(`files-${from.diskId}`).click();
  await expect(page).toHaveURL(/\/files\?.*active=right/);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });

  // One pane: the active one. The switch says which, and each half is a finger's height.
  await expect(page.getByTestId('pane-right')).toBeVisible();
  await expect(page.getByTestId('pane-left')).toBeHidden();
  const sw = page.getByTestId('files-side-switch');
  await expect(sw).toBeVisible();
  await expect(sw.getByTestId('files-side-right')).toHaveAttribute('aria-pressed', 'true');
  for (const s of ['left', 'right']) expect((await sw.getByTestId(`files-side-${s}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // The bottom bar under the pane: Copy to…, Move to…, Delete, More; the desktop column's own buttons are gone.
  const bar = page.getByTestId('files-actions');
  for (const id of ['files-phone-copy', 'files-phone-move', 'files-phone-delete', 'files-more']) {
    await expect(bar.getByTestId(id), id).toBeVisible();
    expect((await bar.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(44);
  }
  for (const id of ['files-copy', 'files-move', 'files-delete', 'files-rename', 'files-swap']) await expect(page.getByTestId(id), id).toBeHidden();
  expect((await bar.boundingBox())!.y).toBeGreaterThan((await page.getByTestId('pane-right').boundingBox())!.y);

  // Rows a finger can hit, the size under the name, nothing scrolling sideways.
  const readme = row(page, 'right', 'ReadMe');
  expect((await readme.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(readme).toContainText('6 B');
  await noSideways(page);
  // Every button in the manager -- device, up, crumbs, the Name sort, the strip's -- is a finger's height (C7-09a's
  // measure, here on a disk with rows).
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="files-manager"] button')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && !el.closest('p, [aria-hidden="true"]') && r.height < 43.5;
    })
    .map((el) => el.dataset.testid ?? (el.textContent ?? '').trim()))).toEqual([]);

  // More holds the rest, each item 44 px.
  await bar.getByTestId('files-more').tap();
  for (const id of ['rename', 'makedir', 'protect', 'info', 'download']) {
    const item = page.getByTestId(`files-more-${id}`);
    await expect(item, id).toBeVisible();
    // Polled: the menu opens with a zoom, and mid-animation an item measures short.
    await expect.poll(async () => (await item.boundingBox())!.height, { message: id }).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('files-more-rename')).toBeHidden();

  // With nothing picked, Copy to… is dimmed (aria-disabled, not disabled) and a tap says why rather than nothing.
  await expect(bar.getByTestId('files-phone-copy')).toHaveAttribute('aria-disabled', 'true');
  await bar.getByTestId('files-phone-copy').tap({ force: true });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Select something first' })).toBeVisible();

  // A tap picks a file; Copy to… opens the picker at the other pane's place (LIBRARY:), which is not a disk.
  await readme.tap();
  await expect(readme).toHaveAttribute('aria-selected', 'true');
  await bar.getByTestId('files-phone-copy').tap();
  const picker = page.getByTestId('files-copy-to');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('LIBRARY:');
  await expect(picker.getByTestId('files-copy-to-here')).toBeDisabled();
  await expect(picker.getByTestId('files-copy-to-reason')).toHaveText('Open a disk to copy into it');
  await noSideways(page);

  // Drill into the other title, then its disk; "Copy here".
  const folder = (name: string) => picker.getByTestId('files-copy-to-folder').filter({ hasText: name });
  await folder(`PhoneB-${tag}`).tap();
  await expect(picker.getByTestId('files-copy-to-crumb-1')).toHaveText(`PhoneB-${tag}`);
  expect((await folder('Disk 1').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await folder('Disk 1').tap();
  await expect(picker.getByTestId('files-copy-to-crumb-2')).toHaveText(/Disk 1/);   // the seeded disk's label names its title too
  await expect(picker.getByTestId('files-copy-to-here')).toHaveText('Copy here');
  await picker.getByTestId('files-copy-to-here').tap();
  await expect(picker).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Copied 1 item to .*Disk 1.* — saved as version 1\./ }))
    .toBeVisible({ timeout: 15_000 });

  // The other pane went to where the copy landed: switch to it and the file is there; on the stored bytes too.
  await page.getByTestId('files-side-left').tap();
  await expect(page.getByTestId('pane-left')).toBeVisible();
  await expect(page.getByTestId('pane-right')).toBeHidden();
  await expect(row(page, 'left', 'ReadMe')).toHaveCount(1);
  await expect.poll(() => new URL(page.url()).searchParams.get('active')).toBe('left');
  expect(await storedNames(to.diskId)).toContain('ReadMe');
  expect(await storedNames(from.diskId)).toContain('ReadMe');   // a copy, not a move
  await noSideways(page);

  // The strip's History opens over this short pane whole, not cut off at the pane's foot: its first version is the
  // element under a finger at that row.
  await page.getByTestId('disk-strip-left').getByTestId('disk-strip-history-toggle').tap();
  const v0 = page.getByTestId('disk-strip-history').getByTestId('version-0');
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });   // the copy's toast sits there
  await v0.scrollIntoViewIfNeeded();
  const b0 = (await v0.boundingBox())!;
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="version-0"]'),
    [b0.x + b0.width / 2, b0.y + b0.height / 2])).toBe(true);
});

test('at 390: a tap on a folder row opens it; Move to… moves into a folder the picker drills to', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const r = applyBatch([
    { op: 'add', parentPath: '', name: 'ReadMe', bytes: new TextEncoder().encode('hello\n') },
    { op: 'mkdir', parentPath: '', name: 'src' },
  ])(formatVolume({ filesystem: 'FFS', volumeName: `Mv${tag.slice(0, 6)}` }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const { gameId, diskId } = await seedDisk(orgId, { title: `PhoneMv-${tag}`, diskNo: 1, sha256, writeProtected: false });
  const disk = `LIBRARY:/${gameId}/${diskId}`;
  await page.goto(`/files?left=${encodeURIComponent(disk)}&right=${encodeURIComponent(disk)}&active=right`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });

  // A tap on a folder goes into it; the up button (44 px) comes back.
  await row(page, 'right', 'src').tap();
  await expect(page.getByTestId('pane-right-crumb-3')).toHaveText('src');
  expect((await page.getByTestId('pane-right-up').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('pane-right-up').tap();
  await expect(row(page, 'right', 'ReadMe')).toHaveCount(1);

  // Move to…: the picker starts on the disk (the other pane), drills into src, "Move here".
  await row(page, 'right', 'ReadMe').tap();
  await page.getByTestId('files-phone-move').tap();
  const picker = page.getByTestId('files-copy-to');
  await expect(picker.getByTestId('files-copy-to-here')).toHaveText('Move here');
  await picker.getByTestId('files-copy-to-folder').filter({ hasText: 'src' }).tap();
  await expect(picker.getByTestId('files-copy-to-crumb-3')).toHaveText('src');
  await picker.getByTestId('files-copy-to-here').tap();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Moved 1 item to .*Disk 1.* — saved as version 1\./ })).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'right', 'ReadMe')).toHaveCount(0);
  await page.getByTestId('files-side-left').tap();
  await expect(page.getByTestId('pane-left-crumb-3')).toHaveText('src');
  await expect(row(page, 'left', 'ReadMe')).toHaveCount(1);
  await noSideways(page);
});
