import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
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
//
// Files increment 1 (Task 11): the same, in the Files manager -- the disk on the right, and a second view of it on
// the left where a test needs a destination. The Browse page's name filter and its Hide .info switch have no Files
// counterpart in increment 1 (the .info choice returns as a Files setting in increment 4), so their two tests are
// gone; see the Task 11 report.

test.afterAll(cleanupSeeded);

// Several edits per test, and an Undo is a restore (the heaviest disk route), each
// with its refresh against the live database: 30 s is not enough (measured ~50 s).
test.describe.configure({ timeout: 90_000 });

/** Same budget as disk-files-edit.spec.ts: an edit plus the refresh behind it. */
const AFTER_EDIT = { timeout: 15_000 };

const row = (page: Page, name: string, side: 'left' | 'right' = 'right') =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);

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

/** The disk open in Files: on the right, and on the left at `left` (LIBRARY: by default), the right pane active. */
async function openInFiles(page: Page, disk: { id: string; gameId: string }, left = 'LIBRARY:') {
  const right = `LIBRARY:/${disk.gameId}/${disk.id}`;
  await page.goto(`/files?${new URLSearchParams({ left, right, active: 'right' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

/** A fresh org with one blank disk holding C/Copy, C/Copy.info, ReadMe, Notes.txt and Disk.info, open in Files. */
async function seeded(page: Page, left?: (disk: { id: string; gameId: string }) => string) {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  await addFiles(page, disk.id, ['C/Copy', 'C/Copy.info', 'ReadMe', 'Notes.txt', 'Disk.info'], ['C']);
  await openInFiles(page, disk, left?.(disk));
  await expect(row(page, 'ReadMe')).toBeVisible();
  return disk;
}

test('several files download as one zip, move in one go, and Undo puts them back', async ({ page }) => {
  // The left pane shows C on the same disk: the destination of the move.
  const disk = await seeded(page, (d) => `LIBRARY:/${d.gameId}/${d.id}/C`);

  await row(page, 'ReadMe').click();
  await row(page, 'Notes.txt').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'C').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane-right-foot')).toContainText('3 of 4 selected');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('files-download').click()]);
  const zip = new Uint8Array(readFileSync(await dl.path()));
  expect(dl.suggestedFilename()).toMatch(/\.zip$/);
  const names = Object.keys(unzipSync(zip)).sort();
  expect(names).toEqual(['C/', 'C/Copy', 'C/Copy.info', 'Notes.txt', 'ReadMe']);

  // Move ReadMe and Notes.txt into C (the left pane).
  await row(page, 'C').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane-right-foot')).toContainText('2 of 4 selected');
  await page.getByTestId('files-move').click();
  const toast = page.locator('[data-sonner-toast]', { hasText: 'Moved 2 items' });
  await expect(toast).toBeVisible(AFTER_EDIT);
  await expect(row(page, 'ReadMe')).toHaveCount(0, AFTER_EDIT);
  await expect(row(page, 'ReadMe', 'left')).toBeVisible();
  let after = await volumeOf(page, disk.id);
  expect(at(after.root, 'C/ReadMe')).not.toBeNull();
  expect(at(after.root, 'C/Notes.txt')).not.toBeNull();
  await expect(page.getByTestId('pane-right-foot')).not.toContainText('selected');

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
  await row(page, 'C').click();
  await row(page, 'ReadMe').click({ modifiers: ['ControlOrMeta'] });
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-text')).toHaveText(/^Delete 2 items from .+\? A new version keeps the old ones\.$/);
  await page.getByTestId('files-delete-confirm').click();
  await expect(row(page, 'C')).toHaveCount(0, AFTER_EDIT);
  const after = await volumeOf(page, disk.id);
  expect(after.root.map((e) => e.name).sort()).toEqual(['Disk.info', 'Notes.txt']);
});

test('protection bits are changed on the disk itself', async ({ page }) => {
  const disk = await seeded(page);
  const cell = row(page, 'ReadMe').locator('td').nth(3);
  await expect(cell).toHaveText('----rwed');
  await row(page, 'ReadMe').click();
  await page.getByTestId('files-protect').click();
  await page.getByTestId('files-protect-bit-s').click();
  await page.getByTestId('files-protect-bit-d').click();
  await page.getByTestId('files-protect-save').click();
  await expect(cell).toHaveText('-s--rwe-', AFTER_EDIT);
  expect(at((await volumeOf(page, disk.id)).root, 'ReadMe')!.protection).toBe('-s--rwe-');
});

test('"new in vN" marks what each version added', async ({ page }) => {
  const disk = await seeded(page);   // the files went on in version 1
  await addFiles(page, disk.id, ['Later']);
  await page.reload();
  await expect(row(page, 'ReadMe').getByTestId('pane-new-ReadMe')).toHaveText('new in v1');
  await expect(row(page, 'Later').getByTestId('pane-new-Later')).toHaveText('new in v2');
  // Inside a folder too: C/Copy went on in version 1.
  await row(page, 'C').dblclick();
  await expect(row(page, 'Copy').getByTestId('pane-new-Copy')).toHaveText('new in v1');
});

test('Undo after a drop takes the dropped files off again', async ({ page }) => {
  const disk = await seeded(page);
  await synthDrop(page, [{ name: 'Dropped', kind: 'file', content: 'dropped here' }], '[data-testid="pane-right"]');
  await page.getByTestId('files-drop-review').getByTestId('drop-commit').click();
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
