import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, games } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { addFile, makeDirectory } from '@/lib/adffs/write';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded, hydrated } from './device-helpers';

/**
 * Library sharing end to end (spec §7, Task 11): two orgs on ONE server, sharing over real HTTP to itself
 * (http://localhost:3100, allowed only by playwright.config's WEBADF_SHARE_TEST_INSECURE / _PRIVATE_ADDRESSES).
 * Owner shares "Shared" (not "Private") with Rob; Rob's org adds the link, browses, downloads, mounts on a simulated
 * board, writes (D2: the disk becomes Rob's, Uncategorized), loses a title, then the share; a third org cannot reuse
 * the link. Run with `bash scripts/e2e-local.sh e2e/sharing.spec.ts` (its own Postgres).
 */
test.describe.configure({ timeout: 240_000 });
test.afterAll(cleanupSeeded);

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A formatted FFS disk with something in its root: a file and a directory. */
function adfWithFiles(volumeName: string): Uint8Array {
  let adf = formatVolume({ filesystem: 'FFS', volumeName });
  const f = addFile(adf, ROOT_BLOCK, 'ReadMe', new TextEncoder().encode(`Hello from ${volumeName}\n`));
  if (!f.ok) throw new Error(`addFile: ${f.reason}`);
  adf = f.adf;
  const d = makeDirectory(adf, ROOT_BLOCK, 'S');
  if (!d.ok) throw new Error(`makeDirectory: ${d.reason}`);
  return d.adf;
}

async function seedAdf(orgId: string, title: string, volume: string) {
  const adf = adfWithFiles(volume);
  const s = sha(adf);
  await diskStore.put(s, adf);
  const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: s });
  return { gameId, diskId, adf, sha256: s };
}

async function collection(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/collections', { data: { name } });
  expect(r.ok()).toBe(true);
  return (await r.json() as { id: string }).id;
}

async function file(page: Page, collectionId: string, gameId: string) {
  const r = await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId } });
  expect(r.ok()).toBe(true);
}

/** The board: report what it holds for this mount version (as device-write.spec.ts's mountedWritableDisk does). */
async function boardHolds(request: APIRequestContext, token: string, deviceId: string) {
  const [dev] = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  expect(dev.desiredDiskId).not.toBeNull();
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: dev.desiredSha256, mountedDiskId: dev.desiredDiskId, version: dev.desiredVersion },
  })).status()).toBe(204);
  return { diskId: dev.desiredDiskId!, sha256: dev.desiredSha256!, version: dev.desiredVersion };
}

test('two orgs: share, claim, browse, download, mount, write (D2), unshare, revoke, reuse', async ({ browser, request }) => {
  const tag = runTag();

  // ---- Owner: "Shared" holds title A (two disks), "Private" holds title P; a share for Rob covers Shared only.
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const { orgId: ownerOrg } = await signUpFresh(owner);
  const a = await seedAdf(ownerOrg, `Shared Game ${tag}`, 'SHARED1');
  const a2adf = adfWithFiles('SHARED2');
  const a2sha = sha(a2adf);
  await diskStore.put(a2sha, a2adf);
  const { diskId: a2DiskId } = await addDisk(ownerOrg, a.gameId, { diskNo: 2, sha256: a2sha, label: 'Disk 2' });
  const p = await seedAdf(ownerOrg, `Private Game ${tag}`, 'PRIVATE');
  const sharedId = await collection(owner, 'Shared');
  const privateId = await collection(owner, 'Private');
  await file(owner, sharedId, a.gameId);
  await file(owner, privateId, p.gameId);

  const made = await owner.request.post('/api/shares', { data: { label: 'Rob', everything: false, collectionIds: [sharedId] } });
  expect(made.ok()).toBe(true);
  const { share, link } = await made.json() as { share: { id: string }; link: string };
  expect(link).toMatch(/^http:\/\/localhost:\d+\/s\/wfsc_/);

  // ---- Recipient: Remote › Add with the link wrapped in spaces (Review Focus 4).
  const robCtx = await browser.newContext({ acceptDownloads: true });
  const rob = await robCtx.newPage();
  const { orgId: robOrg } = await signUpFresh(rob);
  await rob.goto('/remote/add');
  await hydrated(rob, 'remote-add-form', 'onSubmit');
  await rob.getByTestId('remote-add-link').fill(`   ${link}   `);
  await expect(rob.getByTestId('remote-add-confirm')).toContainText('localhost');
  await rob.getByTestId('remote-add-submit').click();
  await expect(rob).toHaveURL(/\/remote\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const libId = new URL(rob.url()).pathname.split('/').pop()!;

  // The library: the Shared title only.
  await expect(rob.getByTestId('remote-marker').first()).toBeVisible();
  const cards = rob.getByTestId('remote-title-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute('data-title-id', a.gameId);
  await expect(cards.first()).toContainText(`Shared Game ${tag}`);
  await expect(rob.getByText(`Private Game ${tag}`)).toHaveCount(0);
  // Only the shared collection, and the owner's counts for the scope.
  const rail = rob.getByTestId('remote-collections');
  await expect(rail.getByTestId('remote-collection')).toHaveCount(1);
  await expect(rail.getByTestId('remote-collection')).toHaveAttribute('data-collection-id', sharedId);
  await expect(rail).not.toContainText('Private');
  await expect(rob.getByText('1 title · 2 disks')).toBeVisible();
  // The collection view, the table view and a search all answer from the owner.
  await rail.getByTestId('remote-collection').click();
  await expect(rob).toHaveURL(new RegExp(`collection=${sharedId}`));
  await expect(rob.getByTestId('remote-title-card')).toHaveCount(1);
  await rob.goto(`/remote/${libId}?view=table`);
  await expect(rob.getByTestId('remote-title-row')).toHaveCount(1);
  await rob.goto(`/remote/${libId}?q=${encodeURIComponent('Private')}`);
  await expect(rob.getByTestId('remote-titles-empty')).toBeVisible();
  await rob.goto(`/remote/${libId}?q=${encodeURIComponent(`Shared Game ${tag}`)}`);
  await expect(rob.getByTestId('remote-title-card')).toHaveCount(1);
  // The /remote list card.
  await rob.goto('/remote');
  const card = rob.getByTestId('remote-library-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('remote-library-host')).toHaveText(/localhost/);
  await expect(card.getByTestId('remote-library-collections')).toContainText('Shared');
  await expect(card.getByTestId('remote-status')).toHaveAttribute('data-status', 'ok');
  await rob.goto(`/remote/${libId}`);

  // The title page lists both disks.
  await cards.first().click();
  await expect(rob).toHaveURL(new RegExp(`/remote/${libId}/titles/${a.gameId}$`));
  await expect(rob.getByTestId('remote-title-name')).toHaveText(`Shared Game ${tag}`);
  const rows = rob.getByTestId('remote-disk-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-disk-id', a.diskId);
  await expect(rows.nth(1)).toHaveAttribute('data-disk-id', a2DiskId);

  // Download: the owner's exact bytes, through Rob's server.
  await hydrated(rob, `remote-download-${a.diskId}`);
  const dl = rob.waitForEvent('download');
  await rob.getByTestId(`remote-download-${a.diskId}`).click();
  const got = readFileSync((await (await dl).path())!);
  expect(sha(new Uint8Array(got))).toBe(a.sha256);

  // The files page lists the root.
  await rob.getByTestId(`remote-files-${a.diskId}`).click();
  await expect(rob.getByTestId('remote-disk')).toBeVisible();
  await expect(rob.locator('[data-testid="remote-file-entry"][data-name="ReadMe"]')).toBeVisible();
  await expect(rob.locator('[data-testid="remote-file-entry"][data-name="S"]')).toHaveAttribute('data-kind', 'dir');

  // ---- Mount disk 1 in DF0 on Rob's board, then the board writes a track (D2).
  const { deviceId, token } = await pairDevice(rob, request);
  await rob.goto(`/remote/${libId}/titles/${a.gameId}`);
  await hydrated(rob, `mount-${a.diskId}`);
  const mount1 = rob.waitForResponse((r) => r.url().includes(`/api/remote/${libId}/disks/${a.diskId}/mount`));
  await rob.getByTestId(`mount-${a.diskId}`).click();
  expect((await mount1).status()).toBe(200);
  const held = await boardHolds(request, token, deviceId);
  expect(held.sha256).toBe(a.sha256);
  const [hidden1] = await getDb().select().from(disks).where(eq(disks.id, held.diskId));
  expect(hidden1.remoteLibraryId).toBe(libId);
  expect(hidden1.orgId).toBe(robOrg);

  const written = new Uint8Array(TRACK_DATA_BYTES).fill(0x5a);
  const up = await request.post(
    `/api/device/write?disk=${held.diskId}&mount=${held.version}&track=40&session=boot-1&seq=1`,
    { headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.from(written) });
  expect(up.status()).toBe(200);
  const expected = a.adf.slice(); expected.set(written, 40 * TRACK_DATA_BYTES);
  const close = await request.post(
    `/api/device/write/close?disk=${held.diskId}&mount=${held.version}&session=boot-1&seq=1&sha256=${sha(expected)}`,
    { headers: authHeader(token) });
  expect(close.status()).toBe(200);

  // D2: Rob's own disk now, in his library under Uncategorized.
  const [local] = await getDb().select().from(disks).where(eq(disks.id, held.diskId));
  expect(local.remoteLibraryId).toBeNull();
  expect(local.sha256).toBe(sha(expected));
  await rob.goto('/library');
  const localCard = rob.getByTestId('game-card').filter({ hasText: `Shared Game ${tag}` });
  await expect(localCard).toHaveCount(1);
  await expect(localCard).toHaveAttribute('data-game-id', local.gameId);
  // The owner's disk is untouched.
  const [ownerDisk] = await getDb().select().from(disks).where(eq(disks.id, a.diskId));
  expect(ownerDisk.sha256).toBe(a.sha256);

  // ---- Mount disk 2: a hidden copy, held by the board.
  await rob.goto(`/remote/${libId}/titles/${a.gameId}`);
  await hydrated(rob, `mount-${a2DiskId}`);
  const mount2 = rob.waitForResponse((r) => r.url().includes(`/api/remote/${libId}/disks/${a2DiskId}/mount`));
  await rob.getByTestId(`mount-${a2DiskId}`).click();
  expect((await mount2).status()).toBe(200);
  const held2 = await boardHolds(request, token, deviceId);
  expect(held2.sha256).toBe(a2sha);
  expect(await getDb().select({ id: disks.id }).from(disks)
    .where(and(eq(disks.orgId, robOrg), eq(disks.remoteLibraryId, libId)))).toHaveLength(1);
  // The hidden copy reaches no local view (Review Focus 2): Rob's own title still shows only the disk he wrote.
  await rob.goto(`/games/${local.gameId}`);
  await expect(rob.getByTestId(`disk-${held.diskId}`)).toBeVisible();
  await expect(rob.getByTestId(`disk-${held2.diskId}`)).toHaveCount(0);
  await rob.goto('/library');
  await expect(rob.getByTestId('game-card').filter({ hasText: `Shared Game ${tag}` })).toHaveCount(1);
  // Device state does show it, marked remote.
  await rob.goto('/devices');
  await expect(rob.getByText(`Shared Game ${tag} (remote)`).first()).toBeVisible();

  // ---- The owner takes A out of Shared: Mount (which always re-asks the owner) says "No longer shared".
  await rob.goto(`/remote/${libId}/titles/${a.gameId}`);   // the title listing is cached; Mount is not
  await hydrated(rob, `mount-${a.diskId}`);
  expect((await owner.request.delete(`/api/collections/${sharedId}/games/${a.gameId}`)).ok()).toBe(true);
  const refused = rob.waitForResponse((r) => r.url().includes(`/api/remote/${libId}/disks/${a.diskId}/mount`));
  await rob.getByTestId(`mount-${a.diskId}`).click();
  expect((await refused).status()).toBe(404);
  await expect(rob.getByText('No longer shared')).toBeVisible();
  // The board still holds disk 2: nothing was mounted.
  const [stillDev] = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  expect(stillDev.desiredDiskId).toBe(held2.diskId);

  // ---- The owner revokes. Rob's next page load that reaches the owner shows Access ended (listings already fetched
  // within the last minute are served from the 60 s cache, by design; a search is a new listing).
  const revoked = await owner.request.post(`/api/shares/${share.id}/revoke`);
  expect(revoked.ok()).toBe(true);
  await rob.goto(`/remote/${libId}?q=${encodeURIComponent('after revoke')}`);
  await expect(rob.getByTestId('remote-ended')).toBeVisible();
  await expect(rob.getByTestId('remote-ended')).toContainText('Access ended');
  // Hidden copies gone, the board told to eject first; the D2 disk stays Rob's.
  expect(await getDb().select({ id: disks.id }).from(disks)
    .where(and(eq(disks.orgId, robOrg), eq(disks.remoteLibraryId, libId)))).toHaveLength(0);
  expect(await getDb().select({ id: games.id }).from(games)
    .where(and(eq(games.orgId, robOrg), eq(games.remoteLibraryId, libId)))).toHaveLength(0);
  const [ejected] = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  expect(ejected.desiredDiskId).toBeNull();
  expect(ejected.desiredVersion).toBeGreaterThan(held2.version);
  const [kept] = await getDb().select().from(disks).where(eq(disks.id, held.diskId));
  expect(kept?.sha256).toBe(sha(expected));
  await rob.goto('/library');
  await expect(rob.getByTestId('game-card').filter({ hasText: `Shared Game ${tag}` })).toHaveCount(1);
  // And /remote lists it as ended.
  await rob.goto('/remote');
  await expect(rob.getByTestId('remote-library-card')).toHaveCount(1);
  await expect(rob.getByTestId('remote-library-card').getByTestId('remote-status')).toHaveAttribute('data-status', 'ended');

  // ---- A third org reusing the claimed link: the one answer.
  const thirdCtx = await browser.newContext();
  const third = await thirdCtx.newPage();
  await signUpFresh(third);
  await third.goto('/remote/add');
  await hydrated(third, 'remote-add-form', 'onSubmit');
  await third.getByTestId('remote-add-link').fill(link);
  await third.getByTestId('remote-add-submit').click();
  await expect(third.getByTestId('remote-add-error')).toHaveText('This link was already used, has expired or was revoked');

  await thirdCtx.close();
  await robCtx.close();
  await ownerCtx.close();
});
