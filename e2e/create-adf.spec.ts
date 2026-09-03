import { test, expect } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { readVolume } from '@/lib/adffs';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const gameRow = async (id: string) => (await getDb().select().from(games).where(eq(games.id, id)))[0];
const diskRow = async (id: string) => (await getDb().select().from(disks).where(eq(disks.id, id)))[0];

test('a blank disk is made, is real immediately, and an Amiga could mount it', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');

  await page.getByTestId('create-adf').click();
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  // Real the moment it appears (operator's ruling): rows exist, bytes exist.
  // Scoped to THIS test's org. Every create-adf test makes a disk called
  // 'Empty', so an unscoped lookup picks an arbitrary one -- it passes in
  // isolation, where only one exists, and fails in the full suite.
  const created = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  expect(created.length).toBe(1);
  const game = created[0];
  expect(game.authored).toBe(true);
  // OUTSIDE MACHINE_SOURCES, so no scan will ever retitle it and
  // mergeDuplicates will never absorb it -- a merge DELETES the losing row.
  expect(game.metadataSource).toBe('human');

  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  expect(disk.sizeBytes).toBe(901_120);

  // The bytes are a real, mountable volume -- not an empty file with a row
  // pointing at it.
  const adf = await page.request.get(`/api/disks/${disk.id}/adf`);
  expect(adf.status()).toBe(200);
  const v = readVolume(new Uint8Array(await adf.body()));
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  expect(v.volume.name).toBe('Empty');
  expect(v.volume.filesystem).toBe('FFS');   // the default, per the ruling
  expect(v.root).toEqual([]);
});

test('OFS is selectable, and it really is OFS on the disk', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');

  await page.getByTestId('create-adf-fs').selectOption('OFS');
  await page.getByTestId('create-adf').click();
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  const adf = await page.request.get(`/api/disks/${disk.id}/adf`);
  const v = readVolume(new Uint8Array(await adf.body()));
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  expect(v.volume.filesystem).toBe('OFS');
});

test('renaming on the card rewrites the disk under a new digest', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await page.goto('/library');
  await page.getByTestId('create-adf').click();
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [before] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));

  const name = `Workbench ${run}`.slice(0, 30);
  const field = page.getByTestId(`volume-name-${game.id}`);
  await field.fill(name);
  await field.press('Enter');
  await expect.poll(async () => (await gameRow(game.id)).title).toBe(name);

  const after = await diskRow(before.id);
  // THE POINT: blobs are content-addressed, so an edit cannot be in place.
  expect(after.sha256).not.toBe(before.sha256);
  // ...and disks.id is unchanged, which is the standing rule -- readDesired
  // joins on devices.desiredDiskId and a re-keyed disk reads as an eject.
  expect(after.id).toBe(before.id);

  const adf = await page.request.get(`/api/disks/${before.id}/adf`);
  const v = readVolume(new Uint8Array(await adf.body()));
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  expect(v.volume.name).toBe(name);
});

test('typing in the name field neither navigates nor drags the card', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await page.getByTestId('create-adf').click();
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));

  // The field sits INSIDE the card's <a href>, which is also a dnd-kit
  // draggable. Clicking into it must not follow the link.
  await page.getByTestId(`volume-name-${game.id}`).click();
  await expect(page).toHaveURL(/\/library/);
  await expect(page.getByTestId(`volume-name-${game.id}`)).toBeFocused();
});

test('a disk made inside a collection lands in that collection, first', async ({ page }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  void u;
  const created = await page.request.post('/api/collections', { data: { name: `Made ${run}` } });
  const collectionId = (await created.json()).id as string;

  await page.goto(`/library?collection=${collectionId}`);
  await page.getByTestId('create-adf').click();

  // "Created where you stand." It has to be visible where it was made, or it
  // cannot be named.
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(page.getByTestId('game-card').first()).toContainText('made here');

  await page.request.delete(`/api/collections/${collectionId}`);
});

test('an uploaded title gets no rename field, and another tenant cannot rename', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const ua = await signUpFresh(pa);
  await signUpFresh(pb);

  await pa.goto('/library');
  await pa.getByTestId('create-adf').click();
  await expect(pa.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, ua.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));

  // Another tenant gets 404, never 403 -- the response must not confirm the
  // disk exists.
  const cross = await pb.request.patch(`/api/disks/${disk.id}/volume-name`, { data: { volumeName: 'Theirs' } });
  expect(cross.status()).toBe(404);
  expect((await diskRow(disk.id)).sha256).toBe(disk.sha256);

  // An empty name is refused: it would leave the volume nameless on a real
  // Amiga, and the catalog title derives from it.
  const empty = await pa.request.patch(`/api/disks/${disk.id}/volume-name`, { data: { volumeName: '   ' } });
  expect(empty.status()).toBe(400);

  await a.close();
  await b.close();
});
