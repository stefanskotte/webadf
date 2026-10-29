import { test, expect, type Locator, type Page } from '@playwright/test';
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
 * for a move and for a STASH: drop. Task 9 adds the Settings card, the pane "?", the dropped mark, Keep both and
 * Replace on Copy, Move and a drag, Undo after a delete that did not ask, and `/` and F5 with the left pane active.
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

/** files.spec.ts's real HTML5 drag with the mouse (a copy: no Shift). */
async function dragRows(page: Page, source: Locator, target: Locator) {
  await page.getByTestId('files-manager').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const s = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(s.x + 40, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 60, s.y + s.height / 2, { steps: 4 });
  await page.mouse.move(t.x + 40, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
}

/** /settings with the Files card hydrated, so a click reaches its handlers. */
async function openSettings(page: Page) {
  await page.goto('/settings');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="pref-files-left"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

/** A click on a Files card control, and its save landed. */
async function saveClick(page: Page, testId: string) {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/me/prefs') && r.request().method() === 'PATCH'),
    page.getByTestId(testId).click(),
  ]);
  await expect(page.getByTestId('files-prefs-state')).toHaveText('All changes saved');
}

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

test('the Files card saves each row and survives a reload; /files opens with its panes', async ({ page }) => {
  await signUpFresh(page);
  await openSettings(page);
  // Today's behaviour by default.
  await expect(page.getByTestId('pref-files-left')).toHaveAttribute('data-value', 'STASH');
  await expect(page.getByTestId('pref-files-right')).toHaveAttribute('data-value', 'LIBRARY');
  await expect(page.getByTestId('pref-files-on-clash')).toHaveAttribute('data-value', 'ask');
  await expect(page.getByTestId('pref-files-confirm-delete')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('pref-files-confirm-delete-state')).toHaveText('Asks');

  await saveClick(page, 'pref-files-left-NET');
  await saveClick(page, 'pref-files-right-STASH');
  await saveClick(page, 'pref-files-on-clash-skip');
  await saveClick(page, 'pref-files-confirm-delete');
  await expect(page.getByTestId('pref-files-confirm-delete-state')).toHaveText("Doesn't ask");

  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('pref-files-left')).toHaveAttribute('data-value', 'NET');
  await expect(page.getByTestId('pref-files-right')).toHaveAttribute('data-value', 'STASH');
  await expect(page.getByTestId('pref-files-on-clash')).toHaveAttribute('data-value', 'skip');
  await expect(page.getByTestId('pref-files-confirm-delete')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('pref-files-confirm-delete-state')).toHaveText("Doesn't ask");

  // The side list has Files, and it moves focus to the card's heading.
  await page.setViewportSize({ width: 1280, height: 800 });
  const files = page.getByTestId('settings-nav').getByRole('link', { name: 'Files', exact: true });
  await files.click();
  await expect(page).toHaveURL(/#files$/);
  await expect(page.locator('#files-heading')).toBeFocused();

  // R5: the bare /files opens on the chosen panes.
  await page.goto('/files');
  await hydrated(page);
  await expect(page.getByTestId('pane-left-dev-NET')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pane-right-dev-STASH')).toHaveAttribute('aria-pressed', 'true');
});

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
  // The Files card shows the same stored value, the right way round.
  await openSettings(page);
  await expect(page.getByTestId('pref-files-show-info')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('pref-files-show-info-state')).toHaveText('Hidden');
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
  // Undo puts it back: the disk, and the pane.
  await done.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, /^Undone$/)).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'right', 'ReadMe')).toBeVisible();
  expect(names((await stored(a.diskId)).root)).toEqual(['ReadMe']);

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

test('with Replace set, a clash only the server sees (a race) follows the setting too', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await setPrefs(page, { files: { onClash: 'replace' } });
  // No pane shows STASH:, so the manager reads it afresh for each drop -- through the route below.
  await openFiles(page, 'LIBRARY:', 'LIBRARY:', 'left');
  const input = page.getByTestId('files-stash-input');
  await input.setInputFiles([{ name: 'ReadMe', mimeType: 'text/plain', buffer: Buffer.from('first') }]);
  await expect.poll(async () => (await stashRows(orgId))['ReadMe']?.sha).toBe(sha('first'));
  await expect(toast(page, /Added/)).toBeVisible();
  // STASH: reads as empty, so the manager sees no clash up front; only the server's commit finds ReadMe.
  const stashList = (u: URL) => u.pathname === '/api/files/list' && (u.searchParams.get('path') ?? '').startsWith('STASH:');
  await page.route(stashList, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), entries: [] } });
  });
  const sent: unknown[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/files/stash/commit')) sent.push(r.postDataJSON()?.onClash); });
  await input.setInputFiles([{ name: 'ReadMe', mimeType: 'text/plain', buffer: Buffer.from('second one') }]);
  await expect.poll(async () => (await stashRows(orgId))['ReadMe']?.sha).toBe(sha('second one'));
  expect(sent).toEqual(['replace']);
  await expect(page.getByTestId('files-clash-dialog')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
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

test('at 1280×800 the busy line is on screen', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  // Hold the drop's upload so the busy words stay up to be measured.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/files/stash/presign', async (route) => { await held; await route.continue(); });
  await openFiles(page, 'STASH:', 'LIBRARY:', 'left');
  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'Busy.txt', mimeType: 'text/plain', buffer: Buffer.from('busy') }]);
  const busy = page.getByTestId('files-busy');
  await expect(busy).toHaveText(/Reading 1 of 1…/);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const box = (await busy.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  // Above Copy, at the top of the button column.
  expect(box.y).toBeLessThan((await page.getByTestId('files-copy').boundingBox())!.y);
  release();
  await expect(row(page, 'left', 'Busy.txt')).toBeVisible();
});

test('with the left pane active, / focuses its filter, and F5 and Delete leave a filtered-out row alone', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `KfA-${tag}`, [
    { op: 'add', parentPath: '', name: 'Alpha', bytes: enc('a') },
    { op: 'add', parentPath: '', name: 'Beta', bytes: enc('b') },
  ]);
  const b = await seedTitle(orgId, `KfB-${tag}`, []);
  await openFiles(page, a.path, b.path, 'left');
  const manager = page.getByTestId('files-manager');
  const filter = page.getByTestId('pane-left-filter');
  const pickBothThenFilter = async () => {
    await filter.fill('');
    await row(page, 'left', 'Alpha').click();
    await row(page, 'left', 'Beta').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('pane-left-foot')).toHaveText(/^2 of 2 selected/);
    await manager.focus();
    await page.keyboard.press('/');
    await expect(filter).toBeFocused();
    await expect(page.getByTestId('pane-right-filter')).not.toBeFocused();
    await page.keyboard.type('alp');
    await expect(row(page, 'left', 'Beta')).toHaveCount(0);
    await expect(page.getByTestId('pane-left-foot')).toHaveText(/^1 of 1 selected/);
    await manager.focus();
  };

  await pickBothThenFilter();
  await page.keyboard.press('F5');
  await expect(toast(page, /^Copied 1 item to /)).toBeVisible({ timeout: 15_000 });
  expect(names((await stored(b.diskId)).root)).toEqual(['Alpha']);

  await pickBothThenFilter();
  await page.keyboard.press('Delete');
  const dialog = page.getByTestId('files-delete-dialog');
  await expect(dialog.getByTestId('files-delete-text')).toContainText('Alpha');
  await expect(dialog.getByTestId('files-delete-text')).not.toContainText('Beta');
  await dialog.getByTestId('files-delete-confirm').click();
  await expect(toast(page, /^Deleted 1 item from /)).toBeVisible({ timeout: 15_000 });
  expect(names((await stored(a.diskId)).root)).toEqual(['Beta']);
});

test('with Keep both set, Copy and a drag onto a clash keep both without asking', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `KbA-${tag}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('from A\n') }]);
  const b = await seedTitle(orgId, `KbB-${tag}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('B was here\n') }]);
  await setPrefs(page, { files: { onClash: 'keep-both' } });
  await openFiles(page, b.path, a.path, 'right');

  await row(page, 'right', 'ReadMe').click();
  await page.getByTestId('files-copy').click();
  await expect(toast(page, /^Copied 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('files-clash-dialog')).toHaveCount(0);
  expect(names((await stored(b.diskId)).root)).toEqual(['ReadMe', 'ReadMe_1']);

  await dragRows(page, row(page, 'right', 'ReadMe'), page.getByTestId('pane-left-foot'));
  await expect(toast(page, /^Copied 1 item to .* — saved as version 2\./)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('files-clash-dialog')).toHaveCount(0);
  expect(names((await stored(b.diskId)).root)).toEqual(['ReadMe', 'ReadMe_1', 'ReadMe_2']);
  await expect(row(page, 'left', 'ReadMe_2')).toBeVisible();
  // B's own ReadMe is untouched; the source is untouched.
  expect((await stored(b.diskId)).root.find((e) => e.name === 'ReadMe')!.sizeBytes).toBe('B was here\n'.length);
  expect((await stored(a.diskId)).sha256).toBe(a.sha256);
});

test('with Replace set, a drag and a Move onto a clash overwrite without asking', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `RpA-${tag}`, [
    { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('from A, the longer one\n') },
    { op: 'add', parentPath: '', name: 'Other', bytes: enc('AAAAAAAA') },
  ]);
  const b = await seedTitle(orgId, `RpB-${tag}`, [
    { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('B\n') },
    { op: 'add', parentPath: '', name: 'Other', bytes: enc('B') },
  ]);
  await setPrefs(page, { files: { onClash: 'replace' } });
  await openFiles(page, b.path, a.path, 'right');
  const sizeIn = async (diskId: string, name: string) => (await stored(diskId)).root.find((e) => e.name === name)?.sizeBytes;

  // A drag (a copy): B's ReadMe becomes A's; A keeps its own.
  await dragRows(page, row(page, 'right', 'ReadMe'), page.getByTestId('pane-left-foot'));
  await expect(toast(page, /^Copied 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('files-clash-dialog')).toHaveCount(0);
  expect(await sizeIn(b.diskId, 'ReadMe')).toBe('from A, the longer one\n'.length);
  expect(names((await stored(b.diskId)).root)).toEqual(['Other', 'ReadMe']);
  expect((await stored(a.diskId)).sha256).toBe(a.sha256);

  // Move: B's Other becomes A's, and A's is gone.
  await row(page, 'right', 'Other').click();
  await page.getByTestId('files-move').click();
  await expect(toast(page, /^Moved 1 item to /)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('files-clash-dialog')).toHaveCount(0);
  expect(await sizeIn(b.diskId, 'Other')).toBe(8);
  expect(names((await stored(a.diskId)).root)).toEqual(['ReadMe']);
  expect(names((await stored(b.diskId)).root)).toEqual(['Other', 'ReadMe']);
});

test('the ? on each pane names its device', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Help-${runTag()}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') }]);
  await openFiles(page, 'STASH:', a.path, 'right');
  const left = page.getByTestId('pane-left');
  const right = page.getByTestId('pane-right');
  await expect(left.getByTestId('help-tip-stash-net')).toBeVisible();
  await expect(left.getByTestId('help-tip-files')).toHaveCount(0);
  await expect(right.getByTestId('help-tip-files')).toBeVisible();
  await expect(right.getByTestId('help-tip-stash-net')).toHaveCount(0);

  // NET: is STASH: and NET:'s topic too; the LIBRARY: list is Files'.
  await page.getByTestId('pane-left-dev-NET').click();
  await expect(page.getByTestId('pane-left-dev-NET')).toHaveAttribute('aria-pressed', 'true');
  await expect(left.getByTestId('help-tip-stash-net')).toBeVisible();
  await page.getByTestId('pane-left-dev-LIBRARY').click();
  await expect(page.getByTestId('pane-left-dev-LIBRARY')).toHaveAttribute('aria-pressed', 'true');
  await expect(left.getByTestId('help-tip-files')).toBeVisible();
  await expect(left.getByTestId('help-tip-stash-net')).toHaveCount(0);

  await right.getByTestId('help-tip-files').click();
  const pop = page.getByTestId('help-pop-files');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Read the full topic');
  await pop.getByTestId('help-more-files').click();
  await expect(page).toHaveURL(/\/help#files$/);
});

test('STASH: rows dropped from the computer say dropped; a file copied in does not', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Drop-${runTag()}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') }]);
  await openFiles(page, 'STASH:', a.path, 'right');
  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'Mine.txt', mimeType: 'text/plain', buffer: Buffer.from('mine') }]);
  await expect(row(page, 'left', 'Mine.txt').getByTestId('pane-mark')).toHaveText('dropped');

  await row(page, 'right', 'ReadMe').click();
  await page.getByTestId('files-copy').click();
  await expect(row(page, 'left', 'ReadMe')).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'ReadMe').getByTestId('pane-mark')).toHaveCount(0);
  await expect(row(page, 'left', 'Mine.txt').getByTestId('pane-mark')).toHaveText('dropped');
});
