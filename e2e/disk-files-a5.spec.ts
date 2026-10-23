import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { signUpFresh, createAdf } from './helpers';
import { cleanupSeeded } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

// A5 Disk files (roadmap 2026-10-23): name filter, hide .info, multi-select
// with bulk Download / Move / Delete, protection bits, "new in vN", and Undo.
// Every edit is checked on the disk's bytes, read back through /adf.

test.afterAll(cleanupSeeded);

// Several edits per test, and an Undo is a restore (the heaviest disk route), each
// with its refresh against the live database: 30 s is not enough (measured ~50 s).
test.describe.configure({ timeout: 90_000 });

/** Same budget as disk-files-edit.spec.ts: an edit plus the refresh behind it. */
const AFTER_EDIT = { timeout: 15_000 };

const row = (page: Page, name: string) => page.locator(`[data-testid="fs-entry"][data-name="${name}"]`);

async function authoredDisk(page: Page, orgId: string) {
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games).where(and(eq(games.orgId, orgId), eq(games.authored, true)));
  if (!game) throw new Error(`no authored game for org ${orgId}`);
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  return disk;
}

async function volumeOf(page: Page, diskId: string) {
  const res = await page.request.get(`/api/disks/${diskId}/adf`);
  expect(res.status()).toBe(200);
  const v = readVolume(new Uint8Array(await res.body()));
  if (!v.ok) throw new Error(v.reason);
  return v;
}

function at(list: AdfEntry[], path: string): AdfEntry | null {
  const [head, ...rest] = path.split('/');
  const e = list.find((x) => x.name === head) ?? null;
  return e && rest.length ? at(e.children, rest.join('/')) : e;
}

/** Files written in one commit through the batch route, as a drop would. */
async function addFiles(page: Page, diskId: string, files: string[], dirs: string[] = []) {
  const manifest = [
    ...dirs.map((path) => ({ op: 'mkdir', path })),
    ...files.map((path) => ({ op: 'add', path })),
  ];
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    manifest: JSON.stringify(manifest),
  };
  for (const path of files) {
    multipart[path] = { name: path.split('/').pop()!, mimeType: 'application/octet-stream', buffer: Buffer.from(`content of ${path}`) };
  }
  const res = await page.request.post(`/api/disks/${diskId}/files/batch`, { multipart });
  expect(res.status()).toBe(200);
}

/** A fresh org with one blank disk holding C/Copy, C/Copy.info, ReadMe, Notes.txt and Disk.info. */
async function seeded(page: Page) {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  await addFiles(page, disk.id, ['C/Copy', 'C/Copy.info', 'ReadMe', 'Notes.txt', 'Disk.info'], ['C']);
  await page.goto(`/disks/${disk.id}/files`);
  await expect(row(page, 'ReadMe')).toBeVisible();
  return disk;
}

test('the name filter keeps matches and opens the folders that hold them', async ({ page }) => {
  await seeded(page);
  // A selection the filter hides is still said, so a bulk Delete never surprises.
  await row(page, 'ReadMe').locator('[data-testid^="fs-select-"]').check();
  await page.getByTestId('fs-filter').fill('copy');
  await expect(page.getByTestId('fs-selection-hidden')).toHaveText('(1 not shown)');
  await expect(row(page, 'C')).toBeVisible();
  await expect(row(page, 'Copy')).toBeVisible();
  await expect(row(page, 'Copy.info')).toBeVisible();
  await expect(row(page, 'ReadMe')).toHaveCount(0);

  await page.getByTestId('fs-filter').fill('zzz');
  await expect(page.getByTestId('fs-filter-empty')).toHaveText('No files match "zzz".');

  await page.getByTestId('fs-filter').press('Escape');
  await expect(row(page, 'ReadMe')).toBeVisible();
  await expect(row(page, 'Copy')).toHaveCount(0);   // C is closed again
});

test('Hide .info files hides icon files everywhere, and is remembered', async ({ page }) => {
  await seeded(page);
  await row(page, 'C').locator('[data-testid^="fs-toggle-"]').click();
  await expect(row(page, 'Copy.info')).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH' && r.ok()),
    page.getByTestId('fs-hide-info').check(),
  ]);
  await expect(row(page, 'Copy.info')).toHaveCount(0);
  await expect(row(page, 'Disk.info')).toHaveCount(0);
  await expect(row(page, 'Copy')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('fs-hide-info')).toBeChecked();
  await expect(row(page, 'Disk.info')).toHaveCount(0);
  await expect(row(page, 'ReadMe')).toBeVisible();
});

test('several files download as one zip, move in one go, and Undo puts them back', async ({ page }) => {
  const disk = await seeded(page);
  const v = await volumeOf(page, disk.id);
  const readMe = at(v.root, 'ReadMe')!.block;
  const notes = at(v.root, 'Notes.txt')!.block;
  const c = at(v.root, 'C')!.block;

  await page.getByTestId(`fs-select-${readMe}`).check();
  await page.getByTestId(`fs-select-${notes}`).check();
  await page.getByTestId(`fs-select-${c}`).check();
  await expect(page.getByTestId('fs-selection-count')).toHaveText('3 items selected');

  const href = await page.getByTestId('fs-bulk-download').getAttribute('href');
  const zip = await page.request.get(href!);
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  const names = Object.keys(unzipSync(new Uint8Array(await zip.body()))).sort();
  expect(names).toEqual(['C/', 'C/Copy', 'C/Copy.info', 'Notes.txt', 'ReadMe']);

  // Move ReadMe and Notes.txt into C (C itself is not offered as its own destination).
  await page.getByTestId(`fs-select-${c}`).uncheck();
  await page.getByTestId('fs-bulk-move').click();
  await page.getByTestId('fs-bulk-move-target').selectOption({ label: '/C' });
  await page.getByTestId('fs-bulk-move-submit').click();
  const toast = page.locator('[data-sonner-toast]', { hasText: 'Moved 2 items' });
  await expect(toast).toBeVisible(AFTER_EDIT);
  await expect(row(page, 'ReadMe')).toHaveCount(0, AFTER_EDIT);
  let after = await volumeOf(page, disk.id);
  expect(at(after.root, 'C/ReadMe')).not.toBeNull();
  expect(at(after.root, 'C/Notes.txt')).not.toBeNull();
  await expect(page.getByTestId('fs-selection-bar')).toHaveCount(0);

  await toast.hover();   // a hovered toast stays up
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Undone')).toBeVisible(AFTER_EDIT);
  await expect(row(page, 'ReadMe')).toBeVisible(AFTER_EDIT);
  after = await volumeOf(page, disk.id);
  expect(at(after.root, 'ReadMe')).not.toBeNull();
  expect(at(after.root, 'C/ReadMe')).toBeNull();
});

test('a bulk delete says what it removes, and removes it from the disk', async ({ page }) => {
  const disk = await seeded(page);
  const v = await volumeOf(page, disk.id);
  await page.getByTestId(`fs-select-${at(v.root, 'C')!.block}`).check();
  await page.getByTestId(`fs-select-${at(v.root, 'ReadMe')!.block}`).check();
  await page.getByTestId('fs-bulk-delete').click();
  await expect(page.getByTestId('fs-bulk-delete-summary')).toHaveText('Delete 3 files and 1 folder?');
  await page.getByTestId('fs-bulk-delete-confirm').click();
  await expect(row(page, 'C')).toHaveCount(0, AFTER_EDIT);
  const after = await volumeOf(page, disk.id);
  expect(after.root.map((e) => e.name).sort()).toEqual(['Disk.info', 'Notes.txt']);
});

test('protection bits are changed on the disk itself', async ({ page }) => {
  const disk = await seeded(page);
  const block = at((await volumeOf(page, disk.id)).root, 'ReadMe')!.block;
  await expect(page.getByTestId(`fs-protect-${block}`)).toHaveText('----rwed');
  await page.getByTestId(`fs-protect-${block}`).click();
  await page.getByTestId('fs-protect-bit-s').click();
  await page.getByTestId('fs-protect-bit-d').click();
  await page.getByTestId(`fs-protect-save-${block}`).click();
  await expect(page.getByTestId(`fs-protect-${block}`)).toHaveText('-s--rwe-', AFTER_EDIT);
  expect(at((await volumeOf(page, disk.id)).root, 'ReadMe')!.protection).toBe('-s--rwe-');
});

test('"new in vN" marks what each version added', async ({ page }) => {
  const disk = await seeded(page);   // the files went on in version 1
  await addFiles(page, disk.id, ['Later']);
  await page.reload();
  const v = await volumeOf(page, disk.id);
  await expect(page.getByTestId(`fs-new-${at(v.root, 'ReadMe')!.block}`)).toHaveText('new in v1');
  await expect(page.getByTestId(`fs-new-${at(v.root, 'Later')!.block}`)).toHaveText('new in v2');
});

test('Undo after a drop takes the dropped files off again', async ({ page }) => {
  const disk = await seeded(page);
  await synthDrop(page, [{ name: 'Dropped', kind: 'file', content: 'dropped here' }]);
  await page.getByTestId('drop-commit').click();
  const toast = page.locator('[data-sonner-toast]', { hasText: 'Added 1 item' });
  await expect(toast).toBeVisible(AFTER_EDIT);
  await expect(row(page, 'Dropped')).toBeVisible(AFTER_EDIT);
  await toast.hover();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Dropped')).toHaveCount(0, AFTER_EDIT);
  expect(at((await volumeOf(page, disk.id)).root, 'Dropped')).toBeNull();
});

test('an Undo is refused once something else has changed the disk', async ({ page }) => {
  const disk = await seeded(page);   // version 1
  await addFiles(page, disk.id, ['Second']);   // version 2: the Undo of version 1 is now stale
  const res = await page.request.post(`/api/disks/${disk.id}/restore`, { data: { seq: 0, ifHead: 1 } });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'changed_since' });
  expect(at((await volumeOf(page, disk.id)).root, 'Second')).not.toBeNull();
});
