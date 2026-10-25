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
  await expect(page.getByTestId('game-card')).toHaveCount(1, { timeout: 15_000 });
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

test('an -lh1- (LHarc 1.x) .lzh dropped on a folder unpacks byte-exact, not "unsupported method -lh1-"', async ({ page }) => {
  // The operator's real .lzh was refused this way (2026-10-18). lh1.lzh was
  // made by `lha -ao1`; the hashes are of what `lha -x` extracts from it.
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  const mk = await page.request.post(`/api/disks/${disk.id}/files`, {
    multipart: { parentBlock: String(ROOT_BLOCK), name: 'Old' },
  });
  expect(mk.ok()).toBe(true);
  const vol = readVolume(await fetchAdf(page, disk.id));
  if (!vol.ok) throw new Error('fresh disk unreadable');
  const old = child(vol.root, 'Old')!;

  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId(`fs-drop-${old.block}`)).toBeVisible();
  await synthDrop(page, [{ name: 'lh1.lzh', kind: 'file', bytes: fixture('lh1.lzh') }],
    `[data-testid="fs-drop-${old.block}"]`);

  await expect(page.getByTestId('drop-staging-list')).toBeVisible();
  await expect(page.getByTestId('drop-archive-skipped')).toHaveCount(0);
  await expect(page.getByTestId('drop-summary')).toContainText('5 files');
  await page.getByTestId('drop-commit').click();
  await expect(page.getByTestId('drop-staging-list')).toHaveCount(0, { timeout: 30_000 });

  const adf = await fetchAdf(page, disk.id);
  const after = readVolume(adf);
  if (!after.ok) throw new Error('disk unreadable after the write');
  const dir = child(after.root, 'Old')!.children;
  const { createHash } = await import('node:crypto');
  const sha = (name: string) => {
    const e = child(dir, name);
    expect(e, `${name} was written into Old`).toBeTruthy();
    return createHash('sha256').update(readFile(adf, e!.block)!.bytes).digest('hex');
  };
  expect(sha('window.txt')).toBe('badfef05be618145887b45b0187bcc65b23ef3657f4295bec85e1ede76bf4362');
  expect(sha('binary.bin')).toBe('a7c35abd0bd59226acda8532ac9e8187f6c9b7658cff7f4bcce859462858e1c7');
  expect(sha('repeat.bin')).toBe('c4b7a5d1f967cc1a7ad546417e15647e9563f56d0434a1fa84ce680b5825bb59');
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

test('a staged batch keeps its folder: a drop on another folder is refused, and changing the destination drops earlier decisions', async ({ page }) => {
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  for (const name of ['A', 'B']) {
    const res = await page.request.post(`/api/disks/${disk.id}/files`, { multipart: { parentBlock: String(ROOT_BLOCK), name } });
    expect(res.ok()).toBe(true);
  }
  const vol = readVolume(await fetchAdf(page, disk.id));
  if (!vol.ok) throw new Error('fresh disk unreadable');
  const a = child(vol.root, 'A')!; const b = child(vol.root, 'B')!;
  // X.TXT exists in BOTH folders, holding different bytes.
  for (const [dir, text] of [[a, 'old A'], [b, 'old B']] as const) {
    const res = await page.request.post(`/api/disks/${disk.id}/files`, {
      multipart: { parentBlock: String(dir.block), name: 'X.TXT',
                   file: { name: 'X.TXT', mimeType: 'application/octet-stream', buffer: Buffer.from(text) } },
    });
    expect(res.ok()).toBe(true);
  }

  await page.goto(`/disks/${disk.id}/files`);
  await synthDrop(page, [{ name: 'X.TXT', kind: 'file', content: 'new' }], `[data-testid="fs-drop-${a.block}"]`);
  await expect(page.getByTestId('drop-destination-select')).toHaveValue(String(a.block));
  await page.getByTestId('stage-replace-0').click();
  await expect(page.getByTestId('stage-resolution-0')).toHaveText('Will replace existing');

  // A second drop aimed at B: refused, nothing from it staged, batch still /A.
  await synthDrop(page, [{ name: 'other.txt', kind: 'file', content: 'zzz' }], `[data-testid="fs-drop-${b.block}"]`);
  await expect(page.getByTestId('drop-destination-refused')).toContainText('This batch goes to /A');
  await expect(page.getByTestId('drop-destination-select')).toHaveValue(String(a.block));
  await expect(page.locator('[data-testid^="stage-row-"]')).toHaveCount(1);
  await expect(page.getByTestId('stage-resolution-0')).toHaveText('Will replace existing');

  // Retargeting by hand to B: the "replace" was decided for /A/X.TXT, so it
  // must not carry over to /B/X.TXT unreviewed.
  await page.getByTestId('drop-destination-select').selectOption(String(b.block));
  await expect(page.getByTestId('stage-resolution-0')).toHaveCount(0);
  await expect(page.getByTestId('stage-conflict-0')).toBeVisible();
  await expect(page.getByTestId('drop-commit')).toBeDisabled();
  await expect(page.getByTestId('drop-destination-refused')).toHaveCount(0);

  // Nothing was written anywhere.
  const now = readVolume(await fetchAdf(page, disk.id));
  if (!now.ok) throw new Error('unreadable');
  const adf = await fetchAdf(page, disk.id);
  for (const [name, text] of [['A', 'old A'], ['B', 'old B']] as const) {
    const x = child(child(now.root, name)!.children, 'X.TXT')!;
    expect(new TextDecoder().decode(readFile(adf, x.block)!.bytes)).toBe(text);
    expect(child(child(now.root, name)!.children, 'other.txt')).toBeUndefined();
  }
});

test('a typed rename AmigaDOS cannot hold is flagged on its row and blocks Add', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  await authoredDisk(page, u.orgId).then((d) => page.goto(`/disks/${d.id}/files`));
  // Over 30 characters, so the row's name is editable.
  await synthDrop(page, [{ name: `${'n'.repeat(36)}.txt`, kind: 'file', content: 'x' }], '[data-testid="file-tree"]');
  await expect(page.getByTestId('drop-commit')).toBeEnabled();

  await page.getByTestId('stage-name-0').fill('Work:Bad');
  await expect(page.getByTestId('stage-name-error-0')).toHaveText('name AmigaDOS cannot hold');
  await expect(page.getByTestId('drop-commit')).toBeDisabled();

  await page.getByTestId('stage-name-0').fill('Fine.txt');
  await expect(page.getByTestId('stage-name-error-0')).toHaveCount(0);
  await expect(page.getByTestId('drop-commit')).toBeEnabled();
});

test('the tree says when it can take a drop, and its list holds only list items', async ({ page }) => {
  test.setTimeout(60_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  for (const name of ['Docs', 'Tools']) {
    const mk = await page.request.post(`/api/disks/${disk.id}/files`, { multipart: { parentBlock: String(ROOT_BLOCK), name } });
    expect(mk.ok()).toBe(true);
  }
  for (const name of ['a.txt', 'b.txt']) {
    const up = await page.request.post(`/api/disks/${disk.id}/files`, {
      multipart: { parentBlock: String(ROOT_BLOCK), name, file: { name, mimeType: 'text/plain', buffer: Buffer.from(name) } },
    });
    expect(up.ok()).toBe(true);
  }
  await page.goto(`/disks/${disk.id}/files`);
  // The staging area registers its receiver in an effect, after the tree is already hydrated: until then a
  // drop on the tree reaches nothing. The tree exposes the moment it can.
  await expect(page.getByTestId('file-tree')).toHaveAttribute('data-native-drop', 'ready');
  // Every direct child of the files list is a list item (folders and files alike).
  const list = page.getByRole('list').filter({ has: page.locator('[data-testid="fs-entry"]') }).first();
  await expect(list).toHaveAttribute('data-testid', 'file-tree');
  const roles = await page.getByTestId('file-tree').evaluate((el) => [...el.children].map((c) => c.getAttribute('role')));
  expect(roles.length).toBeGreaterThanOrEqual(4);
  expect(roles.every((r) => r === 'listitem'), `roles: ${JSON.stringify(roles)}`).toBe(true);
});
