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
import { synthDrop } from './drag-drop-helpers';

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

  // Files… from the disk's title page: the disk on the right, STASH: on the left.
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
  // measure, here on a disk with rows). A pane's "?" is 24 px drawn with a 40 px hit area around it, and C7-09a skips it too.
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="files-manager"] button')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && !el.matches('[data-testid^="help-tip-"]') && !el.closest('p, [aria-hidden="true"]') && r.height < 43.5;
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

  // A tap picks a file; Copy to… opens the picker at the other pane's place (STASH:), which takes files. Its LIBRARY:
  // chip goes to the library, which is not a disk.
  await readme.tap();
  await expect(readme).toHaveAttribute('aria-selected', 'true');
  await bar.getByTestId('files-phone-copy').tap();
  const picker = page.getByTestId('files-copy-to');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('STASH:');
  await expect(picker.getByTestId('files-copy-to-dev-STASH')).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByTestId('files-copy-to-here')).toBeEnabled();
  expect((await picker.getByTestId('files-copy-to-dev-LIBRARY').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await picker.getByTestId('files-copy-to-dev-LIBRARY').tap();
  await expect(picker.getByTestId('files-copy-to-crumb-0')).toHaveText('LIBRARY:');
  await expect(picker.getByTestId('files-copy-to-dev-LIBRARY')).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByTestId('files-copy-to-here')).toBeDisabled();
  await expect(picker.getByTestId('files-copy-to-reason')).toHaveText('Open a disk or STASH: to copy into it');
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
  // To the middle of the window: scrolled only "if needed" it stops at the bottom edge, under the fixed tab bar,
  // since the pane's header grew a filter row (increment 4).
  await v0.evaluate((el) => el.scrollIntoView({ block: 'center' }));
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
  // A Date ▼ sort remembered from a desktop: no Date column on a phone, so the one sort button must say it.
  expect((await page.request.patch('/api/me/prefs', { data: { files: { sort: { library: { key: 'date', dir: 'desc' } } } } })).ok()).toBe(true);
  await page.goto(`/files?left=${encodeURIComponent(disk)}&right=${encodeURIComponent(disk)}&active=right`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });

  const sortBtn = page.getByTestId('pane-right-sort-phone');
  await expect(sortBtn).toHaveText('Date▼');
  expect((await sortBtn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sortBtn.tap();
  await expect(sortBtn).toHaveText('Date▲');
  // Saved through the same prefs path as a desktop header click.
  await expect.poll(async () => (await (await page.request.get('/api/me/prefs')).json()).files.sort.library)
    .toEqual({ key: 'date', dir: 'asc' });
  await sortBtn.tap();
  await expect(sortBtn).toHaveText('Size▼');

  // Keys pressed in the portalled More menu are the menu's, never the manager's: with ReadMe picked, Delete and F2
  // there open no dialog (the menu does not claim them, so they would bubble to the manager through the portal).
  await row(page, 'right', 'ReadMe').tap();
  await page.getByTestId('files-more').tap();
  await expect(page.getByTestId('files-more-rename')).toBeVisible();
  await page.getByTestId('files-more-rename').focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('F2');
  await page.waitForTimeout(300);   // a dialog would open on the next render; give it the chance to
  await expect(page.getByTestId('files-delete-dialog')).toHaveCount(0);
  await expect(page.getByTestId('files-name-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('files-more-rename')).toBeHidden();
  await row(page, 'right', 'ReadMe').tap();   // let it go again
  await expect(row(page, 'right', 'ReadMe')).toHaveAttribute('aria-selected', 'false');

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

// ---- The disk page's phone tests (mobile.spec.ts), moved here with Files increment 1 (Task 11). ----------------

/** A disk with C/SetPatch, README and DOOMED, open in Files on the right at 390, hydrated. */
async function openPhoneDisk(page: Page, orgId: string, title: string) {
  const r = applyBatch([
    { op: 'mkdir', parentPath: '', name: 'C' },
    { op: 'add', parentPath: 'C', name: 'SetPatch', bytes: new TextEncoder().encode('x') },
    { op: 'add', parentPath: '', name: 'README', bytes: new TextEncoder().encode('yy') },
    { op: 'add', parentPath: '', name: 'DOOMED', bytes: new TextEncoder().encode('to be renamed') },
  ])(formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 20) }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const d = await seedDisk(orgId, { title, diskNo: 1, sha256, writeProtected: false });
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: `LIBRARY:/${d.gameId}/${d.diskId}`, active: 'right' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  return d;
}

/** Every box of `ids` lies inside the 390 px viewport. */
async function onScreen(page: Page, ids: string[]) {
  for (const id of ids) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, id).toBeLessThanOrEqual(390);
  }
}

test('at 390: a row shows its name, and More → Download downloads it', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openPhoneDisk(page, orgId, `PhoneDl-${runTag()}`);
  // The regression that mattered on the Browse page: fixed columns wider than the card, the name computed to a negative
  // width and the row's controls clipped away. Here: the name in view, and Download reachable and in view.
  const readme = row(page, 'right', 'README');
  await expect(readme.getByText('README', { exact: true })).toBeVisible();
  const box = (await readme.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await readme.tap();
  await expect(readme).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('files-more').tap();
  await expect(page.getByTestId('files-more-download')).toBeVisible();
  await onScreen(page, ['files-more-download']);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('files-more-download').tap()]);
  expect(dl.suggestedFilename()).toBe('README');
  // A folder row is one unambiguous target: a tap opens it.
  await row(page, 'right', 'C').tap();
  await expect(row(page, 'right', 'SetPatch')).toBeVisible();
  await noSideways(page);
});

test('at 390: Makedir, Rename and Delete dialogs fit a phone, and their edits land on the disk', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const { diskId } = await openPhoneDisk(page, orgId, `PhoneEd-${runTag()}`);

  // Makedir from More: the name dialog's field and buttons fit; the folder is made.
  await page.getByTestId('files-more').tap();
  await page.getByTestId('files-more-makedir').tap();
  await expect(page.getByTestId('files-name-dialog')).toBeVisible();
  await onScreen(page, ['files-name-input', 'files-name-save']);
  await page.getByTestId('files-name-input').fill('Phone');
  await page.getByTestId('files-name-save').tap();
  await expect(row(page, 'right', 'Phone')).toBeVisible({ timeout: 15_000 });

  // Rename from More.
  await row(page, 'right', 'DOOMED').tap();
  await page.getByTestId('files-more').tap();
  await page.getByTestId('files-more-rename').tap();
  await onScreen(page, ['files-name-input', 'files-name-save']);
  await page.getByTestId('files-name-input').fill('KEPT');
  await page.getByTestId('files-name-save').tap();
  await expect(row(page, 'right', 'KEPT')).toBeVisible({ timeout: 15_000 });

  // Delete from the bar: the confirm fits; cancelled, nothing goes.
  await row(page, 'right', 'KEPT').tap();
  await page.getByTestId('files-phone-delete').tap();
  await onScreen(page, ['files-delete-confirm', 'files-delete-close']);
  await page.getByTestId('files-delete-dialog').getByRole('button', { name: 'Cancel' }).tap();
  await expect(page.getByTestId('files-delete-dialog')).toHaveCount(0);
  await noSideways(page);
  expect((await storedNames(diskId)).sort()).toEqual(['C', 'KEPT', 'Phone', 'README']);
});

test('at 390: the drop review fits a phone, staged list and all', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openPhoneDisk(page, orgId, `PhoneDrop-${runTag()}`);
  // A long name the review must shorten for AmigaDOS: a name field, a note and buttons on the row.
  await synthDrop(page, [{
    name: 'Utilities', kind: 'dir',
    children: [{ name: 'A name long enough that it has to be shortened for AmigaDOS', kind: 'file', content: 'hi' }],
  }], '[data-testid="pane-right"]');
  const review = page.getByTestId('files-drop-review');
  const list = review.getByTestId('drop-staging-list');
  await expect(list).toBeVisible();
  await onScreen(page, ['drop-staging-list', 'drop-commit', 'drop-strip']);
  await noSideways(page);
  await review.getByTestId('drop-clear').tap();
  await expect(list).toHaveCount(0);
  await review.getByTestId('files-drop-review-cancel').tap();
  await expect(review).toHaveCount(0);
  // (The Browse page's press-and-hold drag of an entry onto a folder has no Files counterpart on a phone by design:
  // a phone moves files with Move to…, which the second test above covers.)
});

// Files increment 2 (Task 9): STASH: on a phone.
test('at 390: the STASH: drop zone stacks above the switch; Copy to… copies a STASH: file into a disk', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const to = await seedRealDisk(orgId, `PhoneStash-${runTag()}`, false);
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: `LIBRARY:/${to.gameId}/${to.diskId}`, active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-side-switch"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });

  // The zone first, then the Left | Right switch, then the pane: one column, nothing side by side. On a phone the
  // card is display: contents (its tile, hint and URL field are items of the zone's grid), so the grid is measured.
  await expect(page.getByTestId('files-stash-browse')).toBeVisible();
  await expect(page.getByTestId('files-stash-url-input')).toBeVisible();
  const zone = (await page.getByTestId('files-drop-stash').locator('xpath=..').boundingBox())!;
  const sw = (await page.getByTestId('files-side-switch').boundingBox())!;
  expect(zone.y + zone.height).toBeLessThanOrEqual(sw.y);
  expect(zone.x).toBeGreaterThanOrEqual(0);
  expect(zone.x + zone.width).toBeLessThanOrEqual(390);
  await noSideways(page);

  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('from the phone') }]);
  await expect(row(page, 'left', 'a.txt')).toBeVisible({ timeout: 15_000 });
  await row(page, 'left', 'a.txt').tap();
  await expect(row(page, 'left', 'a.txt')).toHaveAttribute('aria-selected', 'true');

  // Copy to… opens on the other pane's place, the disk; Copy here.
  await page.getByTestId('files-phone-copy').tap();
  const picker = page.getByTestId('files-copy-to');
  await expect(picker.getByTestId('files-copy-to-here')).toHaveText('Copy here');
  await noSideways(page);
  await picker.getByTestId('files-copy-to-here').tap();
  await expect(picker).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Copied 1 item to .*Disk 1.* — saved as version 1\./ }))
    .toBeVisible({ timeout: 15_000 });
  expect(await storedNames(to.diskId)).toEqual(['a.txt']);
  await noSideways(page);
});
