import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { disks } from '@/db/schema/catalog';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch, type BatchOp } from '@/lib/adffs/write';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

/**
 * Files increment 4: the Files settings applied by the page and the manager (Task 5) -- panes on opening (also after
 * Back), the filter per pane (hidden rows are never acted on; it clears on another folder and keeps after an op; `/`
 * and Escape), Show .info in both panes, the Comment column, Delete without a confirm on a disk, and the clash answer
 * for a move and for a STASH: drop. Task 9 adds the Settings card, the pane "?", the dropped mark and the phone.
 */

test.afterAll(cleanupSeeded);

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A real FFS disk built from `ops`, stored, and seeded as a one-disk title of this org (files.spec.ts's). */
async function seedTitle(orgId: string, title: string, ops: BatchOp[]) {
  const r = applyBatch(ops)(formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 24), density: 'dd' }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const seeded = await seedDisk(orgId, { title, diskNo: 1, sha256, sizeBytes: r.adf.length, writeProtected: false });
  return { ...seeded, sha256, path: `LIBRARY:/${seeded.gameId}/${seeded.diskId}` };
}

async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await hydrated(page);
}

async function setPrefs(page: Page, data: unknown) {
  const res = await page.request.patch('/api/me/prefs', { data });
  expect(res.ok()).toBe(true);
}

const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const rowNames = (page: Page, side: 'left' | 'right') =>
  page.getByTestId(`pane-${side}`).getByTestId('pane-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-name')));
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

async function stored(diskId: string) {
  const [d] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  const vol = readVolume(await diskStore.read(d.sha256));
  if (!vol.ok) throw new Error('no volume');
  return { sha256: d.sha256, root: vol.root };
}

const names = (list: AdfEntry[]) => list.map((e) => e.name).sort();

async function stashRows(orgId: string) {
  const rows = await getDb().select().from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')));
  return Object.fromEntries(rows.map((r) => [r.path, { kind: r.kind, size: r.sizeBytes, sha: r.blobSha256 }]));
}

test('the panes setting opens /files, also after Back', async ({ page }) => {
  await signUpFresh(page);
  await setPrefs(page, { files: { panes: { left: 'NET', right: 'STASH' } } });
  const made = await page.request.post('/api/files/ops', { data: { op: 'makedir', dest: 'STASH:', name: 'Box' } });
  expect(made.ok()).toBe(true);

  await page.goto('/files');
  await hydrated(page);
  await expect(page.getByTestId('pane-left-dev-NET')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pane-right-dev-STASH')).toHaveAttribute('aria-pressed', 'true');

  await row(page, 'right', 'Box').dblclick();
  await expect(page.getByTestId('pane-right-crumb-1')).toHaveText('Box');
  await page.goBack();
  // Back to the bare /files: the setting's panes again, not STASH: | LIBRARY:.
  await expect(page.getByTestId('pane-right-crumb-1')).toHaveCount(0);
  await expect(page.getByTestId('pane-right-dev-STASH')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 'right', 'Box')).toBeVisible();
  await expect(page.getByTestId('pane-left-dev-NET')).toHaveAttribute('aria-pressed', 'true');

  // A link naming a pane keeps it; the other comes from the setting.
  await page.goto('/files?left=LIBRARY:');
  await hydrated(page);
  await expect(page.getByTestId('pane-left-dev-LIBRARY')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pane-right-dev-STASH')).toHaveAttribute('aria-pressed', 'true');
});

test('a filter that hides a picked file leaves it out of Delete', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Filt-${runTag()}`, [
    { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') },
    { op: 'mkdir', parentPath: '', name: 'Tools' },
  ]);
  await openFiles(page, 'STASH:', a.path, 'right');

  await row(page, 'right', 'ReadMe').click();
  await row(page, 'right', 'Tools').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane-right-foot')).toHaveText(/^2 of 2 selected/);
  await page.getByTestId('pane-right-filter').fill('too');
  await expect(row(page, 'right', 'ReadMe')).toHaveCount(0);
  await expect(page.getByTestId('pane-right-foot')).toHaveText(/^1 of 1 selected/);

  await page.getByTestId('files-delete').click();
  const dialog = page.getByTestId('files-delete-dialog');
  await expect(dialog.getByTestId('files-delete-text')).toContainText('Tools');
  await expect(dialog.getByTestId('files-delete-text')).not.toContainText('ReadMe');
  await dialog.getByTestId('files-delete-confirm').click();
  await expect(toast(page, /^Deleted 1 item from /)).toBeVisible({ timeout: 15_000 });
  expect(names((await stored(a.diskId)).root)).toEqual(['ReadMe']);
});

test('the filter clears on another folder and keeps after a copy', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `FiA-${tag}`, [{ op: 'add', parentPath: '', name: 'DoIt', bytes: enc('do it\n') }]);
  const b = await seedTitle(orgId, `FiB-${tag}`, [
    { op: 'mkdir', parentPath: '', name: 'Docs' },
    { op: 'add', parentPath: '', name: 'Notes', bytes: enc('notes\n') },
  ]);
  await openFiles(page, a.path, b.path, 'right');

  const filter = page.getByTestId('pane-right-filter');
  await filter.fill('do');
  await expect.poll(() => rowNames(page, 'right')).toEqual(['Docs']);
  await expect(page.getByTestId('pane-right-foot')).toHaveText('1 of 2 shown');

  await row(page, 'left', 'DoIt').click();
  await page.getByTestId('files-copy').click();
  await expect(toast(page, /^Copied 1 item to /)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => rowNames(page, 'right')).toEqual(['Docs', 'DoIt']);
  await expect(filter).toHaveValue('do');
  await expect(page.getByTestId('pane-right-foot')).toHaveText('2 of 3 shown');

  await row(page, 'right', 'Docs').dblclick();
  await expect(page.getByTestId('pane-right-crumb-3')).toHaveText('Docs');
  await expect(filter).toHaveValue('');
});

test('/ focuses the filter; Escape clears it, then gives the keys back', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Keys-${runTag()}`, [
    { op: 'add', parentPath: '', name: 'Alpha', bytes: enc('a') },
    { op: 'add', parentPath: '', name: 'Beta', bytes: enc('b') },
  ]);
  await openFiles(page, 'STASH:', a.path, 'right');

  await page.getByTestId('files-manager').focus();
  await page.keyboard.press('/');
  const filter = page.getByTestId('pane-right-filter');
  await expect(filter).toBeFocused();
  await page.keyboard.type('x');
  await expect(filter).toHaveValue('x');
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(filter).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('files-manager')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'right', 'Beta')).toHaveAttribute('data-cursor', 'true');
  await expect(row(page, 'right', 'Beta')).toHaveAttribute('aria-selected', 'true');
});

test('Show .info hides icon files in both panes and is remembered', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const ops: BatchOp[] = [
    { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') },
    { op: 'add', parentPath: '', name: 'ReadMe.info', bytes: enc('icon') },
  ];
  const a = await seedTitle(orgId, `InfA-${tag}`, ops);
  const b = await seedTitle(orgId, `InfB-${tag}`, ops);
  await openFiles(page, a.path, b.path, 'left');
  await expect(row(page, 'right', 'ReadMe.info')).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH'),
    page.getByTestId('pane-left-show-info').click(),
  ]);
  await expect(row(page, 'left', 'ReadMe.info')).toHaveCount(0);
  await expect(row(page, 'right', 'ReadMe.info')).toHaveCount(0);
  await expect(page.getByTestId('pane-right-foot')).toHaveText('1 of 2 shown · 1 .info file hidden');
  await expect(page.getByTestId('pane-right-show-info')).toHaveAttribute('aria-checked', 'false');

  await page.reload();
  await hydrated(page);
  await expect(row(page, 'left', 'ReadMe')).toBeVisible();
  await expect(row(page, 'left', 'ReadMe.info')).toHaveCount(0);
  const prefs = await (await page.request.get('/api/me/prefs')).json();
  expect(prefs.browse.hideInfo).toBe(true);
});

test('with Ask before deleting off, a disk delete runs at once with Undo; STASH: still asks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `NoAsk-${runTag()}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') }]);
  await setPrefs(page, { files: { confirmDelete: false } });
  await openFiles(page, 'STASH:', a.path, 'right');

  await row(page, 'right', 'ReadMe').click();
  await page.keyboard.press('Delete');
  const done = toast(page, /^Deleted 1 item from .* — saved as version 1\./);
  await expect(done).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('files-delete-dialog')).toHaveCount(0);
  await expect(done.getByRole('button', { name: 'Undo' })).toBeVisible();
  expect((await stored(a.diskId)).root).toEqual([]);

  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') }]);
  await row(page, 'left', 'keep.txt').click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-dialog').getByTestId('files-delete-text')).toContainText('keep.txt');
});

test('with Skip set, a move onto a clash asks nothing and leaves the source', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `SkA-${tag}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('from A\n') }]);
  const b = await seedTitle(orgId, `SkB-${tag}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('B was here\n') }]);
  await setPrefs(page, { files: { onClash: 'skip' } });
  await openFiles(page, b.path, a.path, 'right');

  await row(page, 'right', 'ReadMe').click();
  await page.getByTestId('files-move').click();
  await expect(toast(page, /Moved|Nothing/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('files-clash-dialog')).toHaveCount(0);
  expect(names((await stored(a.diskId)).root)).toEqual(['ReadMe']);
  expect((await stored(b.diskId)).sha256).toBe(b.sha256);
});

test('with Replace set, a STASH: drop onto a clash replaces without asking', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await setPrefs(page, { files: { onClash: 'replace' } });
  await openFiles(page, 'STASH:', 'LIBRARY:', 'left');
  const input = page.getByTestId('files-stash-input');
  await input.setInputFiles([{ name: 'ReadMe', mimeType: 'text/plain', buffer: Buffer.from('first') }]);
  await expect(row(page, 'left', 'ReadMe')).toBeVisible();
  await input.setInputFiles([{ name: 'ReadMe', mimeType: 'text/plain', buffer: Buffer.from('second one') }]);
  await expect.poll(async () => (await stashRows(orgId))['ReadMe']?.sha).toBe(sha('second one'));
  await expect(page.getByTestId('files-clash-dialog')).toHaveCount(0);
  expect(Object.keys(await stashRows(orgId))).toEqual(['ReadMe']);
});

test('Comment column: Always shows it on a disk, Never hides it in STASH:', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Com-${runTag()}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') }]);
  await openFiles(page, 'STASH:', a.path, 'right');
  await expect(page.getByTestId('pane-left-col-comment')).toBeVisible();
  await expect(page.getByTestId('pane-right-col-comment')).toHaveCount(0);

  await setPrefs(page, { files: { comments: 'always' } });
  await page.reload();
  await hydrated(page);
  await expect(page.getByTestId('pane-right-col-comment')).toBeVisible();
  await expect(page.getByTestId('pane-left-col-comment')).toBeVisible();

  await setPrefs(page, { files: { comments: 'never' } });
  await page.reload();
  await hydrated(page);
  await expect(page.getByTestId('pane-left-col-comment')).toHaveCount(0);
  await expect(page.getByTestId('pane-right-col-comment')).toHaveCount(0);
});
