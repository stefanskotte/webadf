import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume, readFile } from '@/lib/adffs';
import { walkDirectory } from '@/lib/adffs/dir';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { diskStore } from '@/lib/storage';
import { signUpFresh, createAdf } from './helpers';
import { cleanupSeeded } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

test.afterAll(cleanupSeeded);

/** The fixture the unit tests use, and one the real `lha` produced. */
const LHA = [...new Uint8Array(readFileSync(
  join(process.cwd(), 'src/lib/archive/fixtures/h1.lha')))];

async function authoredDisk(page: Page, orgId: string) {
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, orgId), eq(games.authored, true)));
  if (!game) throw new Error('no authored game after createAdf');
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  if (!disk) throw new Error('authored game has no disk row');
  return disk;
}

test('an .lha expands into staging, and only the kept members are written', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);
  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('drop-strip')).toBeVisible();

  // Dropped as ONE file. It must arrive as its members, because an archive is
  // a container of paths and bytes exactly like the folder drop it reuses.
  await synthDrop(page, [{ name: 'h1.lha', kind: 'file', bytes: LHA }]);

  const list = page.getByTestId('drop-staging-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('readme.txt');
  await expect(list).toContainText('deep.txt');
  // The archive itself is not a row: it was expanded, not staged.
  await expect(list).not.toContainText('h1.lha');

  // "Pick a few files out of an archive" -- leave one behind. The pre-existing
  // Skip control could never do this: it only appears on a collision, and none
  // of these collide with anything.
  const rows = page.locator('[data-testid^="stage-row-"]');
  const count = await rows.count();
  let excludedAt = -1;
  for (let i = 0; i < count; i++) {
    if ((await rows.nth(i).innerText()).includes('tiny.txt')) { excludedAt = i; break; }
  }
  expect(excludedAt, 'the fixture must contain tiny.txt or this test proves nothing')
    .toBeGreaterThanOrEqual(0);
  await page.getByTestId(`stage-include-${excludedAt}`).click();
  await expect(rows.nth(excludedAt)).toHaveAttribute('data-excluded', 'true');

  await page.getByTestId('drop-commit').click();
  await expect(page.getByTestId('drop-staging-list')).toHaveCount(0, { timeout: 30_000 });

  // ON THE BYTES, read back out of the stored image -- the same standard the
  // file-operations and drag-drop suites hold, and the only one that proves
  // the decompressor and the writer agree.
  const stored = await diskStore.read((await getDb().select().from(disks)
    .where(eq(disks.id, disk.id)))[0].sha256);
  const vol = readVolume(stored);
  expect(vol.ok).toBe(true);
  if (!vol.ok) return;

  const src = vol.root.find((e) => e.name === 'src');
  expect(src, 'the archive\'s own directory must have been created').toBeTruthy();
  if (!src) return;
  const inSrc = walkDirectory(stored, src.block);
  const names = inSrc.root.map((e) => e.name);
  expect(names).toContain('readme.txt');
  // The whole point of the exclusion: it is absent from the DISK, not merely
  // greyed out in a list.
  expect(names).not.toContain('tiny.txt');

  const readme = inSrc.root.find((e) => e.name === 'readme.txt')!;
  const bytes = readFile(stored, readme.block);
  expect(new TextDecoder('latin1').decode(bytes!.bytes))
    .toBe('The quick brown fox jumps over the lazy dog. '.repeat(3).trimEnd() + '\n');

  // No protection bits in this archive (macOS `lha` writes no 0x40 header), so
  // the file must wear the AmigaDOS default rather than anything invented.
  expect(readme.protection).toBe('----rwed');
});
