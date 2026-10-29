import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, disks, games } from '@/db/schema/catalog';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch } from '@/lib/adffs/write';
import { readVolume, readFile } from '@/lib/adffs';
import { walkDirectory } from '@/lib/adffs/dir';
import { diskStore } from '@/lib/storage';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

/**
 * Files increment 1, Task 9b: what only the old Browse page had, now in Files -- Undo in the toast, the TOSEC-identity
 * confirm, the own-copy notice, "new in vN", and the drop review for files from the computer.
 */

test.afterAll(cleanupSeeded);

const LHA = [...new Uint8Array(readFileSync(join(process.cwd(), 'src/lib/archive/fixtures/h1.lha')))];

/** A real FFS disk holding ReadMe and src/readme.txt, stored, and seeded as a one-disk title of this org. */
async function seedRealDisk(orgId: string, tag: string) {
  const r = applyBatch([
    { op: 'add', parentPath: '', name: 'ReadMe', bytes: new TextEncoder().encode('hello\n') },
    { op: 'mkdir', parentPath: '', name: 'src' },
    { op: 'add', parentPath: 'src', name: 'readme.txt', bytes: new TextEncoder().encode('old\n') },
  ])(formatVolume({ filesystem: 'FFS', volumeName: `Par${tag.slice(0, 6)}` }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  return { ...(await seedDisk(orgId, { title: `Parity-${tag}`, diskNo: 1, sha256, writeProtected: false })), sha256 };
}

async function openDisk(page: Page, gameId: string, diskId: string) {
  await page.goto(`/files?left=STASH:&right=${encodeURIComponent(`LIBRARY:/${gameId}/${diskId}`)}&active=right`);
  // Hydrated, so a click or a synthetic drop reaches React's handlers.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

const rightRow = (page: Page, name: string) => page.getByTestId('pane-right').getByTestId('pane-row').filter({ hasText: name });

async function storedRoot(diskId: string) {
  const [d] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, diskId));
  const bytes = await diskStore.read(d.sha256);
  const vol = readVolume(bytes);
  if (!vol.ok) throw new Error('no volume');
  return { bytes, root: vol.root };
}

test('Undo in the toast after a delete puts the file back', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const { gameId, diskId } = await seedRealDisk(orgId, runTag());
  await openDisk(page, gameId, diskId);

  await rightRow(page, 'ReadMe').click();
  await page.getByTestId('files-delete').click();
  await page.getByTestId('files-delete-confirm').click();
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: /Deleted 1 item .+ — saved as version 1\./ });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(rightRow(page, 'ReadMe')).toHaveCount(0);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Undone')).toBeVisible({ timeout: 15_000 });
  await expect(rightRow(page, 'ReadMe')).toHaveCount(1);
  // On the stored bytes, not just the pane: the restore is the newest version, the file is back.
  expect((await storedRoot(diskId)).root.map((e) => e.name)).toContain('ReadMe');
  await expect(page.getByTestId('disk-strip-history-toggle')).toHaveText('History · v2');
});

test('a disk recognised by TOSEC asks before its first edit, once', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const { gameId, diskId, sha256 } = await seedRealDisk(orgId, runTag());
  const rom = 'Parity Game (1990)(Pub)[!].adf';
  await getDb().update(disks).set({ tosecName: rom }).where(eq(disks.id, diskId));
  await getDb().update(blobs).set({ matchState: 'matched', matchCheckedAt: new Date() }).where(eq(blobs.sha256, sha256));
  await openDisk(page, gameId, diskId);

  await page.getByTestId('pane-right').click();
  await page.getByTestId('files-makedir').click();
  const ask = page.getByTestId('identity-confirm-dialog');
  await expect(ask).toContainText(rom);
  await page.getByTestId('identity-confirm-cancel').click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId('files-name-input')).toHaveCount(0);   // Cancel: nothing opened, nothing written

  await page.getByTestId('files-makedir').click();
  await page.getByTestId('identity-confirm-proceed').click();
  await page.getByTestId('files-name-input').fill('Saves');
  await page.getByTestId('files-name-save').click();
  await expect(rightRow(page, 'Saves')).toHaveCount(1, { timeout: 15_000 });

  // Confirmed for this disk on this visit: the next edit goes straight on.
  await rightRow(page, 'ReadMe').click();
  await page.getByTestId('files-delete').click();
  await expect(page.getByTestId('files-delete-dialog')).toBeVisible();
  await expect(ask).toHaveCount(0);
});

test("an own copy of a shared library's title says whose it was", async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const { gameId, diskId } = await seedRealDisk(orgId, runTag());
  await getDb().update(games).set({ copiedFrom: 'Bob' }).where(eq(games.id, gameId));
  await openDisk(page, gameId, diskId);
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-copied-from')).toHaveText("Your copy of Bob's library");
});

test('an entry a version added is marked "new in vN"', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const { gameId, diskId } = await seedRealDisk(orgId, runTag());
  await openDisk(page, gameId, diskId);

  await page.getByTestId('pane-right').click();
  await page.getByTestId('files-makedir').click();
  await page.getByTestId('files-name-input').fill('Fresh');
  await page.getByTestId('files-name-save').click();
  await expect(rightRow(page, 'Fresh').getByTestId('pane-new-Fresh')).toHaveText('new in v1', { timeout: 15_000 });
  await expect(rightRow(page, 'ReadMe').getByTestId('pane-new-ReadMe')).toHaveCount(0);   // on the disk as uploaded
});

test('an .lha dropped on a disk pane opens the review; a clash offers rename, skip and replace', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const { gameId, diskId } = await seedRealDisk(orgId, runTag());
  await openDisk(page, gameId, diskId);

  await synthDrop(page, [{ name: 'h1.lha', kind: 'file', bytes: LHA }], '[data-testid="pane-right"]');
  const review = page.getByTestId('files-drop-review');
  const list = review.getByTestId('drop-staging-list');
  await expect(list).toContainText('src/readme.txt');
  await expect(list).not.toContainText('h1.lha');   // expanded, not staged as one file
  await expect(review.getByTestId('drop-destination-select')).toHaveValue(String(880));   // the folder the pane shows

  const rows = review.locator('[data-testid^="stage-row-"]');
  const at = async (text: string) => {
    for (let i = 0; i < await rows.count(); i++) if ((await rows.nth(i).innerText()).includes(text)) return i;
    throw new Error(`no staged row for ${text}`);
  };
  const readme = await at('src/readme.txt');
  // The clash: a name field to rename, Skip, and Replace (a file over a file).
  await expect(review.getByTestId(`stage-conflict-${readme}`)).toBeVisible();
  await expect(review.getByTestId(`stage-name-${readme}`)).toBeEditable();
  await expect(review.getByTestId(`stage-skip-${readme}`)).toBeVisible();
  await expect(review.getByTestId(`stage-replace-${readme}`)).toBeVisible();
  await expect(review.getByTestId('drop-commit')).toBeDisabled();

  await review.getByTestId(`stage-replace-${readme}`).click();
  await review.getByTestId(`stage-skip-${await at('📁 src')}`).click();   // "Use existing folder"
  await review.getByTestId('drop-commit').click();
  await expect(review).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /^Added \d+ items to .+ — saved as version 1\./ })
    .getByRole('button', { name: 'Undo' })).toBeVisible();

  const { bytes, root } = await storedRoot(diskId);
  const src = root.find((e) => e.name === 'src')!;
  const inSrc = walkDirectory(bytes, src.block).root;
  expect(inSrc.map((e) => e.name).sort()).toEqual(['noise.bin', 'readme.txt', 'sub', 'tiny.txt']);
  const replaced = readFile(bytes, inSrc.find((e) => e.name === 'readme.txt')!.block)!;
  expect(new TextDecoder('latin1').decode(replaced.bytes)).toBe('The quick brown fox jumps over the lazy dog. '.repeat(3).trimEnd() + '\n');
});
