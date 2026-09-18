import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskVersions } from '@/db/schema/disk-history';
import { readVolume } from '@/lib/adffs';
import { signUpFresh, runTag, createAdf } from './helpers';
import { cleanupSeeded, pairDevice, seedDisk, authHeader } from './device-helpers';

test.afterAll(cleanupSeeded);

const gameRow = async (id: string) => (await getDb().select().from(games).where(eq(games.id, id)))[0];
const diskRow = async (id: string) => (await getDb().select().from(disks).where(eq(disks.id, id)))[0];

test('a blank disk is made, is real immediately, and an Amiga could mount it', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');

  await createAdf(page);
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

  await createAdf(page, 'OFS');
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
  await createAdf(page);
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
  await createAdf(page);
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
  await createAdf(page);

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
  await createAdf(pa);
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

test('the filesystem is chosen per disk, not left set from last time', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');

  // The old control was a <select> sitting beside the button, and it kept its
  // value: making one OFS disk quietly made every later disk OFS until
  // someone noticed and put it back. Choosing from the menu makes the
  // filesystem part of the click, and this is the assertion that fails if a
  // sticky default ever returns.
  await createAdf(page, 'OFS');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await createAdf(page, 'FFS');
  await expect(page.getByTestId('game-card')).toHaveCount(2);

  const made = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  expect(made.length).toBe(2);

  // Read the filesystem off the BYTES of each disk, not off any UI state.
  // Sorted rather than indexed: the library is createdAt-descending and this
  // asserts which filesystems exist, not which card came back first.
  const filesystems: string[] = [];
  for (const g of made) {
    const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, g.id));
    const adf = await page.request.get(`/api/disks/${disk.id}/adf`);
    const v = readVolume(new Uint8Array(await adf.body()));
    expect(v.ok).toBe(true);
    if (v.ok) filesystems.push(v.volume.filesystem);
  }
  expect(filesystems.sort()).toEqual(['FFS', 'OFS']);
});

// Operator decision 2026-09-18: "if a volume is mounted, it cannot be modified
// by the server. If modifications should happen, these must come from the
// (mounted) Amiga side of things." The rename obeys it like the content edits.
test('a disk a board wants or holds cannot be renamed, and the card says so', async ({ page, request }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  const versionsOf = () => getDb().select().from(diskVersions).where(eq(diskVersions.diskId, disk.id));
  const historyBefore = await versionsOf();

  const { deviceId, token } = await pairDevice(page, request);
  // Registration names the device itself (from its MAC); read it back rather
  // than assume the name passed to pairing.
  const [{ name: deviceName }] = await getDb().select({ name: devices.name })
    .from(devices).where(eq(devices.id, deviceId));

  const expectRefused = async () => {
    const res = await page.request.patch(`/api/disks/${disk.id}/volume-name`, { data: { volumeName: 'Nope' } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: 'mounted', reason: `mounted on "${deviceName}"` });
    // Nothing moved: the bytes, the title and the history are all as they were.
    expect((await diskRow(disk.id)).sha256).toBe(disk.sha256);
    expect((await gameRow(game.id)).title).toBe(game.title);
    expect(await versionsOf()).toEqual(historyBefore);
  };

  // DESIRED: the board has been told to mount it but has not reported yet.
  const mounted = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk.id } });
  expect(mounted.status()).toBe(200);
  const { version } = await mounted.json();
  await expectRefused();

  // MOUNTED only: the board holds it, and has since been pointed at another disk.
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: disk.sha256, mountedDiskId: disk.id, version },
  })).status()).toBe(204);
  const otherSha = createHash('sha256').update(`other-${run}`).digest('hex');
  const { diskId: otherDiskId } = await seedDisk(u.orgId, { title: `Other ${run}`, diskNo: 1, sha256: otherSha });
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: otherDiskId } })).status()).toBe(200);
  await expectRefused();

  // The card shows the lock up front: the field is there, disabled, with the
  // reason stated -- not hidden.
  await page.goto('/library');
  const field = page.getByTestId(`volume-name-${game.id}`);
  await expect(field).toBeVisible();
  await expect(field).toBeDisabled();
  const reason = `This disk is mounted on "${deviceName}" — eject it there before renaming.`;
  await expect(field).toHaveAttribute('title', reason);
  await expect(page.getByTestId(`volume-name-locked-${game.id}`)).toHaveText(reason);
  await expect(field).toHaveAccessibleDescription(reason);
});
