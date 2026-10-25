import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, games } from '@/db/schema/catalog';
import { diskVersions, diskWriteTracks } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { readVolume } from '@/lib/adffs';
import { HD_TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { signUpFresh, runTag, createAdf, libRows, stagingReady, openRowMenu } from './helpers';
import { seedDisk, cleanupSeeded, pairDevice, authHeader } from './device-helpers';

test.afterAll(cleanupSeeded);

const HD_BYTES = 1_802_240;
const UNSUPPORTED = "Update the drive's firmware to play HD disks";
const fakeSha = () => createHash('sha256').update(randomUUID()).digest('hex');

// A synthetic HD ADF: the same bytes every run, so the blob store dedupes it.
// Never a real disk (adfmfm spec §14).
function hdAdf(): Buffer {
  const b = Buffer.alloc(HD_BYTES);
  let x = 0x0badf00d;
  for (let i = 0; i < b.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

// The CLI's path: check, presign, PUT, complete. Same as hfe-disks.spec.ts.
async function uploadViaApi(page: Page, bytes: Buffer, filename: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const check = await page.request.post('/api/ingest/check', { data: { hashes: [sha256] } });
  if (!(await check.json()).known.includes(sha256)) {
    const { uploads } = await (await page.request.post('/api/ingest/presign', {
      data: { files: [{ sha256, sizeBytes: bytes.length }] },
    })).json();
    const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(bytes) });
    expect(put.ok || put.status === 400).toBe(true); // 400: already stored by an earlier run
  }
  const res = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: bytes.length, filename }] },
  });
  expect(res.status()).toBe(200);
  return sha256;
}

test('an uploaded HD ADF is tagged HD, can be made writable, and opens in the file browser', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await page.goto('/ingest');
  await stagingReady(page);
  await page.getByTestId('file-input').setInputFiles({
    name: 'HD Test (1994)(Webadf).adf', mimeType: 'application/octet-stream', buffer: hdAdf(),
  });
  await expect(libRows(page).first().getByTestId('ingest-hd-tag')).toBeVisible();
  await expect.poll(() => getDb().select({ id: disks.id }).from(disks).where(eq(disks.orgId, orgId)),
    { timeout: 30_000 }).toHaveLength(1);
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId, size: disks.sizeBytes, f: disks.imageFormat })
    .from(disks).where(eq(disks.orgId, orgId));
  expect(d).toMatchObject({ size: HD_BYTES, f: 'adf' });

  await page.goto(`/games/${d.gameId}`);
  await expect(page.getByTestId(`hd-tag-${d.id}`)).toBeVisible();
  const wp = page.getByTestId(`wp-${d.id}`);
  // Protected by default like every disk, and now a real toggle (HD writes spec §5.3).
  await expect(wp).toHaveAttribute('data-protected', 'true');
  await expect(wp).not.toHaveAttribute('data-locked', 'true');
  await expect(wp).toBeEnabled();
  await wp.click();
  await expect(wp).toHaveAttribute('data-protected', 'false');

  await page.goto('/library?view=table');
  await expect(page.getByTestId('game-hd-tag')).toBeVisible();

  await page.goto(`/disks/${d.id}/files`);
  await expect(page.getByTestId('hd-not-browsable')).toHaveCount(0);
  // These bytes are noise with no DOS signature: the ordinary "no filesystem"
  // answer any such disk gets, not a refusal because it is HD.
  await expect(page.getByTestId('file-edit-disabled')).toContainText('no filesystem');
});

test('an HD disk mounts only on a board reporting playsHd, follows the library\'s write-protect flag, and is served as WFAD', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const sha256 = await uploadViaApi(page, hdAdf(), 'HD Mount (1994)(Webadf).adf');
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks).where(eq(disks.orgId, orgId));
  // The row is writable: the board is told so (HD writes spec §5.3).
  await getDb().update(disks).set({ writeProtected: false }).where(eq(disks.id, d.id));

  const report = (extra: Record<string, unknown>) => request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, ...extra },
  });
  const mount = () => page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: d.id } });

  // A board that has never reported playsHd: refused, and said why -- in the
  // API and in the game page's mount toast.
  let res = await mount();
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'hd_unsupported', reason: UNSUPPORTED });
  await page.goto(`/games/${d.gameId}`);
  await page.getByTestId(`mount-${d.id}`).click();
  await expect(page.getByText(UNSUPPORTED)).toBeVisible();

  // It reports the capability: accepted.
  expect((await report({ firmwareVersion: '9.9.9+e2e', playsHd: true })).status()).toBe(204);
  res = await mount();
  expect(res.status()).toBe(200);

  const poll = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll.desired).toMatchObject({ sha256, diskId: d.id, writeProtected: false });

  const img = await request.get(`/api/device/image/${sha256}`, { headers: authHeader(token) });
  expect(img.status()).toBe(200);
  const body = await img.body();
  expect(img.headers()['content-length']).toBe('1802256');
  expect(body.length).toBe(1_802_256);
  // The spec's header table, byte for byte: WFAD, 1, 160, 22.
  expect([...body.subarray(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x16, 0, 0, 0]);
  expect(body.subarray(16).equals(hdAdf())).toBe(true);

  // A rollback to a build without the responder: refused again.
  expect((await report({ firmwareVersion: '9.9.8+e2e' })).status()).toBe(204);
  res = await mount();
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('hd_unsupported');

  // Same board, same still-entitled sha256, fetched directly (not through
  // mount): the image route must refuse HD bytes to a board that cannot play
  // them, even though desiredSha256 was set before the rollback (F4).
  const rolledBack = await request.get(`/api/device/image/${sha256}`, { headers: authHeader(token) });
  expect(rolledBack.status()).toBe(422);
  expect(await rolledBack.json()).toEqual({ error: 'hd_unsupported', reason: UNSUPPORTED });
});

test('every browser write path works on an HD disk, whose root is block 1760', async ({ page }) => {
  // A dozen-plus round trips against the live database, each one an
  // applyDiskEdit over a 1.76 MB image (twice hfe-disks.spec.ts:201's DD
  // ones) plus a full-image GET or two: measured at ~53 s against the
  // default 30 s test timeout, same reason that test sets its own.
  test.setTimeout(120_000);
  const { orgId } = await signUpFresh(page);
  // A fixed timestamp: the same bytes every run, so the blob store dedupes it.
  const bytes = Buffer.from(formatVolume({
    filesystem: 'FFS', volumeName: 'HDEdit', density: 'hd', now: new Date(Date.UTC(2026, 8, 27)),
  }));
  await uploadViaApi(page, bytes, 'HD Edit (2026)(Webadf).adf');
  const [d] = await getDb().select({ id: disks.id, sha256: disks.sha256 }).from(disks).where(eq(disks.orgId, orgId));

  const off = await page.request.patch(`/api/disks/${d.id}`, { data: { writeProtected: false } });
  expect(off.status()).toBe(200);
  expect((await off.json()).writeProtected).toBe(false);

  // Review Focus 2: a page that still says 880 is not naming a directory here.
  const stale = await page.request.post(`/api/disks/${d.id}/files`, { multipart: { parentBlock: '880', name: 'X' } });
  expect(stale.status()).toBe(400);
  expect(await stale.json()).toMatchObject({ error: 'edit_failed', reason: 'not-a-directory' });
  expect((await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, d.id)))[0].sha256).toBe(d.sha256);

  expect((await page.request.post(`/api/disks/${d.id}/files`, {
    multipart: { parentBlock: '1760', name: 'DIR' },
  })).status()).toBe(200);
  expect((await page.request.post(`/api/disks/${d.id}/files`, {
    multipart: {
      parentBlock: '1760', name: 'HELLO.TXT',
      file: { name: 'HELLO.TXT', mimeType: 'application/octet-stream', buffer: Buffer.from('hello hd') },
    },
  })).status()).toBe(200);

  const adf = new Uint8Array(await (await page.request.get(`/api/disks/${d.id}/adf`)).body());
  expect(adf.length).toBe(HD_BYTES);
  const v = readVolume(adf);
  if (!v.ok) throw new Error(`expected a volume, got ${v.reason}`);
  expect(v.rootBlock).toBe(1760);
  const hello = v.root.find((e) => e.name === 'HELLO.TXT')!;
  const dir = v.root.find((e) => e.name === 'DIR')!;

  const got = await page.request.get(`/api/disks/${d.id}/files/${hello.block}`);
  expect(got.status()).toBe(200);
  expect((await got.body()).toString()).toBe('hello hd');

  // A batch mkdir (files/batch, D-DD-3) lands under the HD root too --
  // `applyBatch` resolves an empty parentPath from the volume's own
  // rootBlock, not a DD constant.
  const batch = await page.request.post(`/api/disks/${d.id}/files/batch`, {
    multipart: { manifest: JSON.stringify([{ op: 'mkdir', path: 'BATCHDIR' }]) },
  });
  expect(batch.status()).toBe(200);
  const afterBatch = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${d.id}/adf`)).body()));
  if (!afterBatch.ok) throw new Error(`expected a volume, got ${afterBatch.reason}`);
  expect(afterBatch.root.some((e) => e.name === 'BATCHDIR' && e.kind === 'dir')).toBe(true);

  // A stale DD root as a move target is not found here either.
  const beforeStaleMove = (await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, d.id)))[0].sha256;
  const staleMove = await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { toParent: 880 } });
  expect(staleMove.status()).toBe(400);
  expect(await staleMove.json()).toMatchObject({ error: 'edit_failed', reason: 'not-found' });
  expect((await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, d.id)))[0].sha256).toBe(beforeStaleMove);

  expect((await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { name: 'RENAMED.TXT' } })).status()).toBe(200);
  expect((await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { toParent: dir.block } })).status()).toBe(200);
  expect((await page.request.patch(`/api/disks/${d.id}/files/${hello.block}`, { data: { toParent: 1760 } })).status()).toBe(200);
  expect((await page.request.patch(`/api/disks/${d.id}/volume-name`, { data: { volumeName: 'HDRenamed' } })).status()).toBe(200);
  expect((await page.request.delete(`/api/disks/${d.id}/files/${dir.block}`)).status()).toBe(200);

  // Version 1 is the disk right after DIR was made: DIR, and no HELLO.TXT.
  const restore = await page.request.post(`/api/disks/${d.id}/restore`, { data: { seq: 1 } });
  expect(restore.status()).toBe(200);
  const back = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${d.id}/adf`)).body()));
  if (!back.ok) throw new Error(`expected a volume, got ${back.reason}`);
  expect(back.root.map((e) => e.name)).toEqual(['DIR']);
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function upload(request: APIRequestContext, token: string,
                q: { diskId: string; mount: number; track: number; seq: number }, data: Uint8Array) {
  return request.post(
    `/api/device/write?disk=${q.diskId}&mount=${q.mount}&track=${q.track}&session=boot-1&seq=${q.seq}`,
    { headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.from(data) });
}

test('a board writes an HD disk: 11,264-byte tracks, a close, a version with 22 sectors changed', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `HDW${runTag().slice(0, 8)}`, density: 'hd' });
  const original = sha(adf);
  await diskStore.put(original, adf);
  const { diskId } = await seedDisk(orgId, {
    title: `HD Write ${runTag()}`, diskNo: 1, sha256: original, sizeBytes: HD_BYTES, writeProtected: false,
  });
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, playsHd: true } })).status()).toBe(204);
  const { version: mount } = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: original, mountedDiskId: diskId, version: mount } })).status()).toBe(204);

  // Review Focus 1: a DD track's 5,632 bytes on an HD disk would overlay at
  // the wrong offset. Refused, and nothing staged.
  const dd = await upload(request, token, { diskId, mount, track: 0, seq: 1 }, new Uint8Array(5_632));
  expect(dd.status()).toBe(400);
  expect((await dd.json()).error).toBe('invalid_body');
  expect(await getDb().select().from(diskWriteTracks).where(eq(diskWriteTracks.deviceId, deviceId))).toEqual([]);

  // The last track: its bytes are the last 11,264 of the image (Review Focus 4).
  const written = new Uint8Array(HD_TRACK_DATA_BYTES).fill(0x5a);
  const up = await upload(request, token, { diskId, mount, track: 159, seq: 2 }, written);
  expect(up.status()).toBe(200);

  const expected = adf.slice();
  expected.set(written, 159 * HD_TRACK_DATA_BYTES);
  const want = sha(expected);
  const close = await request.post(
    `/api/device/write/close?disk=${diskId}&mount=${mount}&session=boot-1&seq=2&sha256=${want}`,
    { headers: authHeader(token) });
  expect(close.status()).toBe(200);
  expect((await close.json()).sha256).toBe(want);

  const rows = await getDb().select().from(diskVersions)
    .where(eq(diskVersions.diskId, diskId)).orderBy(asc(diskVersions.seq));
  expect(rows.map((r) => [r.seq, r.source])).toEqual([[0, 'original'], [1, 'amiga']]);
  expect(rows[1].sectorCount).toBe(22);
  const [disk] = await getDb().select().from(disks).where(eq(disks.id, diskId));
  expect(disk.sha256).toBe(want);
  expect(disk.sizeBytes).toBe(HD_BYTES);

  // The new head goes back to the board as WFAD, like any HD disk.
  const img = await request.get(`/api/device/image/${want}`, { headers: authHeader(token) });
  expect(img.status()).toBe(200);
  expect(img.headers()['content-length']).toBe('1802256');
});

test('an NFC tap of an HD disk on a board without playsHd is refused, not dropped', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: 'HD Tap', diskNo: 1, sha256: fakeSha(), sizeBytes: HD_BYTES });
  const res = await request.post('/api/device/tap', { headers: authHeader(token), data: { diskId } });
  expect(res.status()).toBe(200);
  // 'too_long': the one refusal a pre-1.4.0 board shows (src/lib/nfc/rules.ts tapRefusalOutcome).
  expect((await res.json()).outcome).toBe('too_long');
});

test('a blank HD disk is made, edited in the browser, and its history lists and restores the changes', async ({ page }) => {
  // A create, an upload, a rename and a restore -- each its own edit round
  // trip over a 1.76 MB image, plus two full-image GETs -- against the live
  // database. The DD equivalent (time-machine.spec.ts's restore test) needs
  // the same 120 s budget for fewer, smaller round trips; the default 30 s
  // this test hit twice was the test's own budget, not a stuck restore.
  test.setTimeout(120_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page, 'FFS', 'hd');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games).where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  expect(disk.sizeBytes).toBe(HD_BYTES);

  const AFTER_EDIT = { timeout: 15_000 };
  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('file-toolbar')).toBeVisible();
  await expect(page.getByTestId('file-edit-disabled')).toHaveCount(0);

  // Through the toolbar: it must post the HD root, 1760.
  await page.getByTestId('upload-input').setInputFiles({
    name: 'HELLO.TXT', mimeType: 'application/octet-stream', buffer: Buffer.from('hello hd'),
  });
  await expect(page.getByTestId('upload-name')).toHaveValue('HELLO.TXT');
  await page.getByTestId('upload-submit').click();
  const row = page.locator('[data-testid="fs-entry"][data-name="HELLO.TXT"]');
  await expect(row).toBeVisible(AFTER_EDIT);

  const v = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body()));
  if (!v.ok) throw new Error(`expected a volume, got ${v.reason}`);
  const block = v.root.find((e) => e.name === 'HELLO.TXT')!.block;
  await openRowMenu(page, block);
  await page.getByTestId(`fs-rename-${block}`).click();
  await page.getByTestId(`fs-rename-name-${block}`).fill('NEWNAME.TXT');
  await page.getByTestId(`fs-rename-submit-${block}`).click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="NEWNAME.TXT"]')).toBeVisible(AFTER_EDIT);

  // History: file-level changes, newest first (HD writes spec §5.2).
  const panel = page.getByTestId('history-panel');
  await expect(panel.locator('[data-testid^="version-"]')).toHaveCount(3);
  await expect(page.getByTestId('version-2')).toHaveAttribute('data-head', 'true');
  await expect(page.getByTestId('changes-2')).toContainText('NEWNAME.TXT');
  await expect(page.getByTestId('changes-1')).toContainText('HELLO.TXT');

  // Restore version 1 from the panel: HELLO.TXT is back under its first name.
  await page.getByTestId('restore-1').click();
  await expect(page.getByTestId('restore-dialog')).toBeVisible();
  await page.getByTestId('restore-confirm').click();
  await expect(page.getByTestId('restore-dialog')).toHaveCount(0, AFTER_EDIT);
  await expect(page.locator('[data-testid="fs-entry"][data-name="HELLO.TXT"]')).toBeVisible(AFTER_EDIT);
  const back = readVolume(new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body()));
  if (!back.ok) throw new Error(`expected a volume, got ${back.reason}`);
  expect(back.root.map((e) => e.name)).toEqual(['HELLO.TXT']);
});
