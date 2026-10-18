import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume, readFile, type AdfEntry } from '@/lib/adffs';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { signUpFresh, createAdf } from './helpers';
import { cleanupSeeded } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

/**
 * Browse: an .lha/.lzh dropped ONTO A FOLDER in the file tree unpacks into
 * that folder (operator, 2026-10-17). Before this, only the staging strip
 * below the tree took a drop; a drop on the tree itself was not handled at
 * all, which a browser answers by opening the file.
 */

test.afterAll(cleanupSeeded);

const fixture = (n: string) => [...new Uint8Array(readFileSync(join(process.cwd(), 'src/lib/archive/fixtures', n)))];

async function authoredDisk(page: Page, orgId: string) {
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, orgId), eq(games.authored, true)));
  if (!game) throw new Error('no authored game after createAdf');
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  if (!disk) throw new Error('authored game has no disk row');
  return disk;
}

async function fetchAdf(page: Page, diskId: string): Promise<Uint8Array> {
  const res = await page.request.get(`/api/disks/${diskId}/adf`);
  expect(res.status()).toBe(200);
  return new Uint8Array(await res.body());
}

function child(entries: AdfEntry[], name: string): AdfEntry | undefined {
  return entries.find((e) => e.name === name);
}

test('an .lha dropped on a folder row unpacks into THAT folder, after showing what it will write', async ({ page }) => {
  // Sign-up, a disk, a folder, a decode and a commit, each read back off the
  // bytes: the default 30 s is too close to how long that honestly takes.
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  const mk = await page.request.post(`/api/disks/${disk.id}/files`, {
    multipart: { parentBlock: String(ROOT_BLOCK), name: 'Tools' },
  });
  expect(mk.ok()).toBe(true);
  const before = readVolume(await fetchAdf(page, disk.id));
  if (!before.ok) throw new Error('fresh disk unreadable');
  const tools = child(before.root, 'Tools')!;

  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId(`fs-drop-${tools.block}`)).toBeVisible();

  await synthDrop(page, [{ name: 'h1.lha', kind: 'file', bytes: fixture('h1.lha') }],
    `[data-testid="fs-drop-${tools.block}"]`);

  // Nothing is written yet: the staging list is the confirmation, aimed at the
  // folder the archive was dropped on.
  const list = page.getByTestId('drop-staging-list');
  await expect(list).toBeVisible();
  await expect(page.getByTestId('drop-destination-select')).toHaveValue(String(tools.block));
  await expect(page.getByTestId('drop-summary')).toHaveText('4 files and 2 folders · 782 bytes');
  await expect(list).toContainText('src/readme.txt');
  await expect(list).toContainText('src/sub/deep.txt');
  const unchanged = readVolume(await fetchAdf(page, disk.id));
  expect(unchanged.ok && child(child(unchanged.root, 'Tools')!.children, 'src')).toBeFalsy();

  await page.getByTestId('drop-commit').click();
  await expect(page.getByTestId('drop-staging-list')).toHaveCount(0, { timeout: 30_000 });

  // Listed in Browse, inside Tools.
  await page.getByTestId(`fs-toggle-${tools.block}`).click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="src"]')).toBeVisible();

  // And on the bytes: Tools/src/readme.txt, decoded exactly.
  const adf = await fetchAdf(page, disk.id);
  const after = readVolume(adf);
  if (!after.ok) throw new Error('disk unreadable after the write');
  const src = child(child(after.root, 'Tools')!.children, 'src');
  expect(src, 'the archive unpacked into the folder it was dropped on').toBeTruthy();
  expect(child(after.root, 'src'), 'and not into the root').toBeUndefined();
  const readme = child(src!.children, 'readme.txt')!;
  const bytes = readFile(adf, readme.block);
  expect(new TextDecoder('latin1').decode(bytes!.bytes))
    .toBe('The quick brown fox jumps over the lazy dog. '.repeat(3).trimEnd() + '\n');
  expect(child(child(src!.children, 'sub')!.children, 'deep.txt')).toBeTruthy();
});

test('an archive that does not fit, or is not an archive, is refused and writes nothing', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  const shaBefore = disk.sha256;

  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('file-tree')).toBeVisible();

  // 653 bytes of .lha holding a 1 MiB member: what decides fit is the
  // decoded size, in blocks, and a blank DD disk has 1,756 free.
  await synthDrop(page, [{ name: 'toobig.lha', kind: 'file', bytes: fixture('toobig.lha') }],
    '[data-testid="file-tree"]');
  await expect(page.getByTestId('drop-capacity-warning')).toBeVisible();
  await expect(page.getByTestId('drop-commit')).toBeDisabled();
  await page.getByTestId('drop-clear').click();
  await expect(page.getByTestId('drop-staging-list')).toHaveCount(0);

  // Not an archive at all, despite its name: refused by name, nothing staged.
  const junk = [...new TextEncoder().encode('this is not an LHA archive, only text')];
  await synthDrop(page, [{ name: 'broken.lzh', kind: 'file', bytes: junk }], '[data-testid="file-tree"]');
  await expect(page.getByText('Could not read that archive')).toBeVisible();
  await expect(page.getByTestId('drop-staging-list')).toHaveCount(0);

  const [row] = await getDb().select().from(disks).where(eq(disks.id, disk.id));
  expect(row.sha256).toBe(shaBefore);
});

test('a plain file dropped on a folder row is staged into that folder, as a file', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  const mk = await page.request.post(`/api/disks/${disk.id}/files`, {
    multipart: { parentBlock: String(ROOT_BLOCK), name: 'Docs' },
  });
  expect(mk.ok()).toBe(true);
  const vol = readVolume(await fetchAdf(page, disk.id));
  if (!vol.ok) throw new Error('fresh disk unreadable');
  const docs = child(vol.root, 'Docs')!;

  await page.goto(`/disks/${disk.id}/files`);
  await synthDrop(page, [{ name: 'notes.txt', kind: 'file', content: 'hello amiga' }],
    `[data-testid="fs-drop-${docs.block}"]`);
  await expect(page.getByTestId('drop-destination-select')).toHaveValue(String(docs.block));
  await expect(page.getByTestId('drop-summary')).toHaveText('1 file and 0 folders · 11 bytes');
  await page.getByTestId('drop-commit').click();
  await expect(page.getByTestId('drop-staging-list')).toHaveCount(0, { timeout: 30_000 });

  const after = readVolume(await fetchAdf(page, disk.id));
  if (!after.ok) throw new Error('disk unreadable after the write');
  expect(child(child(after.root, 'Docs')!.children, 'notes.txt')).toBeTruthy();
});
