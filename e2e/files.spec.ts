import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch, type BatchOp } from '@/lib/adffs/write';
import { readVolume, type AdfEntry } from '@/lib/adffs';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk } from './device-helpers';

/**
 * Files increment 1, Task 11: the two-pane manager end to end at the desktop width -- copy, clash, move by drag,
 * delete, sort, protect, the keys, a disk in a drive, the old address, and Info. Every write is checked on the stored
 * bytes as well as on the pane.
 *
 * Covered elsewhere and not repeated here: Files… from the title page, the strip and the redirect of the versionless
 * Browse address (files-strip.spec.ts); Undo, the TOSEC confirm, the own-copy notice, "new in vN" and the drop review
 * (files-parity.spec.ts); the phone layout (files.mobile.spec.ts).
 */

test.afterAll(cleanupSeeded);

const enc = (s: string) => new TextEncoder().encode(s);

/** ReadMe, the folder S, and C/Assign: the shape sharing.spec.ts's adfWithFiles uses, plus a folder with a file in it. */
const STANDARD: BatchOp[] = [
  { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('hello\n') },
  { op: 'mkdir', parentPath: '', name: 'S' },
  { op: 'mkdir', parentPath: '', name: 'C' },
  { op: 'add', parentPath: 'C', name: 'Assign', bytes: enc('assign stub') },
];

/** A real FFS disk built from `ops`, stored, and seeded as a one-disk title of this org. */
async function seedTitle(orgId: string, title: string, ops: BatchOp[] = STANDARD, density: 'dd' | 'hd' = 'dd') {
  const r = applyBatch(ops)(formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 24), density }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  const seeded = await seedDisk(orgId, { title, diskNo: 1, sha256, sizeBytes: r.adf.length, writeProtected: false });
  return { ...seeded, sha256, path: `LIBRARY:/${seeded.gameId}/${seeded.diskId}` };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  // Hydrated, so clicks, keys and drags reach React's handlers.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

const row = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
const rowNames = (page: Page, side: 'left' | 'right') =>
  page.getByTestId(`pane-${side}`).getByTestId('pane-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-name')));
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

/**
 * A real HTML5 drag with the mouse. Shift is pressed once the drag is under way, as a person holds it to make the drop
 * a move: in Chromium a mousedown with Shift already held never starts a drag of a draggable row (measured here).
 */
async function dragRows(page: Page, source: Locator, target: Locator, { shift = false } = {}) {
  const s = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(s.x + 40, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 60, s.y + s.height / 2, { steps: 4 });
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(t.x + 40, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

async function stored(diskId: string) {
  const [d] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  const vol = readVolume(await diskStore.read(d.sha256));
  if (!vol.ok) throw new Error('no volume');
  return { sha256: d.sha256, root: vol.root };
}

function at(list: AdfEntry[], path: string): AdfEntry | null {
  const [head, ...rest] = path.split('/');
  const e = list.find((x) => x.name === head) ?? null;
  return e && rest.length ? at(e.children, rest.join('/')) : e;
}

test('copy a file between disks makes one version', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `CopyA-${tag}`);
  const b = await seedTitle(orgId, `CopyB-${tag}`, []);
  await openFiles(page, 'LIBRARY:', a.path, 'right');

  // The left pane walks from LIBRARY: into disk B by double-clicks: the title, then its disk.
  await row(page, 'left', `CopyB-${tag}`).dblclick();
  await expect(page.getByTestId('pane-left-crumb-1')).toHaveText(`CopyB-${tag}`);
  await page.getByTestId('pane-left').getByTestId('pane-row').filter({ hasText: 'Disk 1' }).dblclick();
  await expect(page.getByTestId('disk-strip-left')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('left')).toBe(b.path);

  await row(page, 'right', 'ReadMe').click();
  await expect(row(page, 'right', 'ReadMe')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('pane-right-foot')).toHaveText('1 of 3 selected · 6 B');
  const copy = page.getByTestId('files-copy');
  await expect(copy).toHaveText('← Copy');
  await copy.click();
  await expect(toast(page, /^Copied 1 item to .*Disk 1.* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'ReadMe')).toHaveCount(1);
  await expect(page.getByTestId('disk-strip-left').getByTestId('disk-strip-history-toggle')).toHaveText('History · v1');
  // The source is untouched: no version, same bytes.
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-strip-history-toggle')).toHaveText('History');
  expect((await stored(a.diskId)).sha256).toBe(a.sha256);
  expect((await stored(b.diskId)).root.map((e) => e.name)).toEqual(['ReadMe']);
});

test('clash asks; Keep both adds ReadMe_1', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `ClashA-${tag}`);
  const b = await seedTitle(orgId, `ClashB-${tag}`, [{ op: 'add', parentPath: '', name: 'ReadMe', bytes: enc('B was here\n') }]);
  await openFiles(page, b.path, a.path, 'right');

  await row(page, 'right', 'ReadMe').click();
  await page.getByTestId('files-copy').click();
  const dialog = page.getByTestId('files-clash-dialog');
  await expect(dialog.getByTestId('files-clash-text')).toContainText('ReadMe');
  expect((await stored(b.diskId)).sha256).toBe(b.sha256);   // asked first: nothing written yet
  await dialog.getByTestId('files-clash-keep-both').click();
  await expect(dialog).toHaveCount(0);
  await expect(toast(page, /^Copied 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'ReadMe_1')).toHaveCount(1);
  await expect(row(page, 'left', 'ReadMe')).toHaveCount(1);
  expect((await stored(b.diskId)).root.map((e) => e.name).sort()).toEqual(['ReadMe', 'ReadMe_1']);
});

test('move a folder between disks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `MoveA-${tag}`);
  const b = await seedTitle(orgId, `MoveB-${tag}`, []);
  await openFiles(page, b.path, a.path, 'right');

  // Shift-drag C (with C/Assign inside) from disk A's pane onto disk B's: a move. Dropped on the foot, not a row.
  await dragRows(page, row(page, 'right', 'C'), page.getByTestId('pane-left-foot'), { shift: true });
  await expect(toast(page, /^Moved 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'right', 'C')).toHaveCount(0);
  await expect(row(page, 'left', 'C')).toHaveCount(1);

  const from = await stored(a.diskId);
  const to = await stored(b.diskId);
  expect(at(from.root, 'C')).toBeNull();
  expect(at(to.root, 'C')?.kind).toBe('dir');
  expect(at(to.root, 'C/Assign')?.kind).toBe('file');
});

test('delete asks first', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Del-${runTag()}`);
  await openFiles(page, 'STASH:', a.path, 'right');

  await row(page, 'right', 'ReadMe').click();
  await page.keyboard.press('Delete');
  const dialog = page.getByTestId('files-delete-dialog');
  await expect(dialog.getByTestId('files-delete-text')).toContainText('ReadMe');
  expect((await stored(a.diskId)).sha256).toBe(a.sha256);   // nothing gone until confirmed
  await dialog.getByTestId('files-delete-confirm').click();
  await expect(row(page, 'right', 'ReadMe')).toHaveCount(0, { timeout: 15_000 });
  await expect(toast(page, /^Deleted 1 item from .* — saved as version 1\./)).toBeVisible();
  expect(at((await stored(a.diskId)).root, 'ReadMe')).toBeNull();
});

test('sort headers flip asc/desc and are remembered', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Sort-${runTag()}`, [
    ...STANDARD, { op: 'add', parentPath: '', name: 'Notes', bytes: enc('a longer file than the ReadMe\n') },
  ]);
  await openFiles(page, 'STASH:', a.path, 'right');
  const size = page.getByTestId('pane-right-sort-size');
  await expect(page.getByTestId('pane-right-sort-name')).toHaveAttribute('aria-sort', 'ascending');
  await expect.poll(() => rowNames(page, 'right')).toEqual(['C', 'S', 'Notes', 'ReadMe']);

  // Size starts biggest first, then flips; folders stay on top either way.
  await size.getByRole('button').click();
  await expect(size).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByTestId('pane-right-sort-name')).toHaveAttribute('aria-sort', 'none');
  await expect.poll(() => rowNames(page, 'right')).toEqual(['C', 'S', 'Notes', 'ReadMe']);
  await size.getByRole('button').click();
  await expect(size).toHaveAttribute('aria-sort', 'ascending');
  await expect.poll(() => rowNames(page, 'right')).toEqual(['C', 'S', 'ReadMe', 'Notes']);
  await size.getByRole('button').click();
  await expect(size).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(async () => (await (await page.request.get('/api/me/prefs')).json()).files.sort.library)
    .toEqual({ key: 'size', dir: 'desc' });

  await page.reload();
  await expect(page.getByTestId('pane-right-sort-size')).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => rowNames(page, 'right')).toEqual(['C', 'S', 'Notes', 'ReadMe']);
});

test('Protect two files', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Prot-${runTag()}`, [
    ...STANDARD, { op: 'add', parentPath: '', name: 'Notes', bytes: enc('notes\n') },
  ]);
  await openFiles(page, 'STASH:', a.path, 'right');
  const protection = (name: string) => row(page, 'right', name).locator('td').nth(3);
  await expect(protection('ReadMe')).toHaveText('----rwed');

  await row(page, 'right', 'ReadMe').click();
  await row(page, 'right', 'Notes').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane-right-foot')).toContainText('2 of 4 selected');
  await page.getByTestId('files-protect').click();
  const dialog = page.getByTestId('files-protect-dialog');
  await expect(dialog).toContainText('Protection of 2 items');
  await expect(dialog.getByTestId('files-protect-bit-d')).toHaveAttribute('data-state', 'on');
  await dialog.getByTestId('files-protect-bit-d').click();
  await expect(dialog.getByTestId('files-protect-bit-d')).toHaveAttribute('data-state', 'off');
  await dialog.getByTestId('files-protect-save').click();
  await expect(toast(page, /^Protection set on 2 items — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(protection('ReadMe')).toHaveText('----rwe-');
  await expect(protection('Notes')).toHaveText('----rwe-');

  const { root } = await stored(a.diskId);
  expect(at(root, 'ReadMe')!.protection).toBe('----rwe-');
  expect(at(root, 'Notes')!.protection).toBe('----rwe-');
  expect(at(root, 'C/Assign')!.protection).toBe('----rwed');   // only the picked ones
});

test('keyboard: arrows, Space, F5, Tab, Enter, Backspace', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedTitle(orgId, `KeysA-${tag}`);
  const b = await seedTitle(orgId, `KeysB-${tag}`, []);
  await openFiles(page, b.path, a.path, 'right');
  const manager = page.getByTestId('files-manager');
  await manager.focus();

  // Rows: C, S, ReadMe. The cursor starts on the first; ↓ moves it and picks what it lands on.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'right', 'ReadMe')).toHaveAttribute('data-cursor', 'true');
  await expect(row(page, 'right', 'ReadMe')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Space');                   // Space lets it go...
  await expect(row(page, 'right', 'ReadMe')).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Space');                   // ...and picks it again
  await expect(row(page, 'right', 'ReadMe')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 'right', 'S')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'right', 'ReadMe')).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('ArrowDown');

  // F5 copies to the other pane (and does not reload the page).
  await page.keyboard.press('F5');
  await expect(toast(page, /^Copied 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'ReadMe')).toHaveCount(1);
  expect((await stored(b.diskId)).root.map((e) => e.name)).toEqual(['ReadMe']);

  // Tab from the manager switches the active pane; again, back.
  await manager.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('pane-left')).toHaveAttribute('data-active', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('active')).toBe('left');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('pane-right')).toHaveAttribute('data-active', 'true');

  // Enter opens the folder under the cursor (C, the first row); Backspace goes back up.
  await expect(row(page, 'right', 'C')).toHaveAttribute('data-cursor', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('pane-right-crumb-3')).toHaveText('C');
  await expect(row(page, 'right', 'Assign')).toHaveCount(1);
  await expect.poll(() => new URL(page.url()).searchParams.get('right')).toBe(`${a.path}/C`);
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('pane-right-crumb-3')).toHaveCount(0);
  await expect(row(page, 'right', 'ReadMe')).toHaveCount(1);
  await expect.poll(() => new URL(page.url()).searchParams.get('right')).toBe(a.path);
});

test('a disk in a drive is read-only', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const held = await seedTitle(orgId, `Held-${tag}`);
  const free = await seedTitle(orgId, `Free-${tag}`, [{ op: 'add', parentPath: '', name: 'Other', bytes: enc('other\n') }]);
  const { deviceId } = await pairDevice(page, request, 'Held Bench');
  await getDb().update(devices).set({
    name: 'Held Bench', lastSeenAt: new Date(),
    desiredGameId: held.gameId, desiredDiskId: held.diskId, desiredSha256: held.sha256, desiredDiskNo: 1,
    mountedGameId: held.gameId, mountedDiskId: held.diskId, mountedSha256: held.sha256, mountedDiskNo: 1,
  }).where(eq(devices.id, deviceId));
  await openFiles(page, free.path, held.path, 'right');

  const reason = 'This disk is in a drive (mounted on "Held Bench"). Eject it to change it.';
  await expect(page.getByTestId('pane-right-readonly')).toHaveText(reason);
  await expect(page.getByTestId('pane-left-readonly')).toHaveCount(0);
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-strip-light')).toHaveAttribute('data-state', 'in');
  await expect(page.getByTestId('disk-strip-left').getByTestId('disk-strip-light')).toHaveAttribute('data-state', 'none');

  // Into it: refused before anything is sent, the reason on the button.
  await row(page, 'left', 'Other').click();
  const copy = page.getByTestId('files-copy');
  await expect(copy).toHaveText('Copy →');
  await expect(copy).toBeDisabled();
  await expect(copy).toHaveAttribute('title', reason);
  await expect(page.getByTestId('files-move')).toBeDisabled();

  // Inside it: nothing that writes; reading still works.
  await row(page, 'right', 'ReadMe').click();
  for (const id of ['files-move', 'files-delete', 'files-rename', 'files-protect']) {
    await expect(page.getByTestId(id), id).toBeDisabled();
  }
  await expect(page.getByTestId('files-info')).toBeEnabled();
  await expect(page.getByTestId('files-download')).toBeEnabled();

  // Out of it: a copy works, and the held disk is unchanged.
  await expect(copy).toHaveText('← Copy');
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(toast(page, /^Copied 1 item to .* — saved as version 1\./)).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 'left', 'ReadMe')).toHaveCount(1);
  expect((await stored(held.diskId)).sha256).toBe(held.sha256);
  expect((await stored(free.diskId)).root.map((e) => e.name).sort()).toEqual(['Other', 'ReadMe']);
});

test('/disks/<id>/files redirects to Files; ?version=1 still shows the old page', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Ver-${runTag()}`);
  expect((await page.request.post(`/api/disks/${a.diskId}/files`, { multipart: { parentBlock: '880', name: 'Edited' } })).status()).toBe(200);

  // R3: a version of the History keeps today's read-only page.
  await page.goto(`/disks/${a.diskId}/files?version=1`);
  await expect(page).toHaveURL(new RegExp(`/disks/${a.diskId}/files\\?version=1$`));
  await expect(page.getByTestId('version-banner')).toHaveAttribute('data-version', '1');
  await expect(page.getByTestId('files-manager')).toHaveCount(0);

  // Without a version: Files, the disk on the right, its edit in the pane and the strip at v1.
  await page.goto(`/disks/${a.diskId}/files`);
  await expect.poll(() => {
    const u = new URL(page.url());
    return [u.pathname, u.searchParams.get('left'), u.searchParams.get('right'), u.searchParams.get('active')];
  }).toEqual(['/files', 'STASH:', a.path, 'right']);
  await expect(row(page, 'right', 'Edited')).toHaveCount(1);
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-strip-history-toggle')).toHaveText('History · v1');
});

test('Info edits a comment', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const a = await seedTitle(orgId, `Info-${runTag()}`);
  await openFiles(page, 'STASH:', a.path, 'right');

  await row(page, 'right', 'ReadMe').click();
  await page.getByTestId('files-info').click();
  const dialog = page.getByTestId('files-info-dialog');
  await expect(dialog).toContainText('6 B (6 bytes)');
  await expect(dialog.getByTestId('files-info-comment')).toHaveValue('');
  await dialog.getByTestId('files-info-comment').fill('Read me before anything else');
  await expect(dialog.getByTestId('files-info-count')).toHaveText('28/79');
  await dialog.getByTestId('files-info-save').click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(toast(page, /^Comment saved on ReadMe — saved as version 1\./)).toBeVisible();

  // Opened again (double-click opens a file's Info): the comment is there, and on the disk.
  await row(page, 'right', 'ReadMe').dblclick();
  await expect(page.getByTestId('files-info-comment')).toHaveValue('Read me before anything else');
  expect(at((await stored(a.diskId)).root, 'ReadMe')!.comment).toBe('Read me before anything else');
});

test('a download over the cap says so in words and saves nothing; a smaller one still saves (final review)', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  // A folder of 1,000 empty files is 1,001 entries: one over the zip's cap, on any server. An HD disk has the room.
  const many: BatchOp[] = [{ op: 'mkdir', parentPath: '', name: 'Many' },
    ...Array.from({ length: 1000 }, (_, i): BatchOp => ({ op: 'add', parentPath: 'Many', name: `F${i}`, bytes: new Uint8Array(0) }))];
  const a = await seedTitle(orgId, `Cap-${tag}`, [...STANDARD, ...many], 'hd');
  await openFiles(page, 'STASH:', a.path, 'right');
  const saved: string[] = [];
  page.on('download', (d) => saved.push(d.suggestedFilename()));

  await row(page, 'right', 'Many').click();
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes('/api/files/download?')),
    page.getByTestId('files-download').click()]);
  expect(res.status()).toBe(413);
  await expect(toast(page, 'Too big to download at once — select fewer files (4 MB).')).toBeVisible();
  expect(saved).toEqual([]);

  await row(page, 'right', 'ReadMe').click();
  await row(page, 'right', 'C').click({ modifiers: ['ControlOrMeta'] });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('files-download').click()]);
  expect(dl.suggestedFilename()).toMatch(/\.zip$/);
});
