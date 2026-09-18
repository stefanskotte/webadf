import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, asc } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskVersions, diskWriteSessions, diskWriteTracks } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const deltaShas: string[] = [];

test.afterAll(async () => {
  for (const s of deltaShas) { try { await diskStore.remove(s); } catch { /* ignore */ } }
  await cleanupSeeded();
});

/** A signed-up org, a paired device, a writable disk with real bytes, mounted and reported. */
async function mountedWritableDisk(page: import('@playwright/test').Page,
                                   request: import('@playwright/test').APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `W${runTag().slice(0, 8)}` });
  const original = sha(adf);
  await diskStore.put(original, adf);
  const { diskId } = await seedDisk(orgId, { title: `Write ${runTag()}`, diskNo: 1, sha256: original });
  expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);
  const mounted = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const { version } = await mounted.json();
  // The board reports what it holds before it uploads (plan 2b does the same).
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: original, mountedDiskId: diskId, version },
  })).status()).toBe(204);
  return { orgId, deviceId, token, diskId, adf, original, mount: version as number };
}

function upload(request: import('@playwright/test').APIRequestContext, token: string,
                q: { diskId: string; mount: number; track: number; seq: number }, data: Uint8Array) {
  return request.post(
    `/api/device/write?disk=${q.diskId}&mount=${q.mount}&track=${q.track}&seq=${q.seq}`,
    { headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.from(data) });
}

test('an upload and a close make a new version the board can download', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const written = new Uint8Array(TRACK_DATA_BYTES).fill(0x5a);

  const up = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 40, seq: 1 }, written);
  expect(up.status()).toBe(200);

  const expected = m.adf.slice(); expected.set(written, 40 * TRACK_DATA_BYTES);
  const want = sha(expected);
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${want}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(200);
  expect((await close.json()).sha256).toBe(want);

  const [disk] = await getDb().select().from(disks).where(eq(disks.id, m.diskId));
  expect(disk.sha256).toBe(want);
  const [dev] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  expect(dev.mountedSha256).toBe(want);
  expect(dev.desiredSha256).toBe(want);

  const rows = await getDb().select().from(diskVersions)
    .where(eq(diskVersions.diskId, m.diskId)).orderBy(asc(diskVersions.seq));
  expect(rows.map((r) => [r.seq, r.source])).toEqual([[0, 'original'], [1, 'amiga']]);
  expect(rows[1].deviceId).toBe(m.deviceId);
  expect(rows[1].sectorCount).toBe(11);
  if (rows[1].kind === 'delta') deltaShas.push(rows[1].blobSha256);

  // The session is gone, and the new image is downloadable by the board.
  expect(await getDb().select().from(diskWriteSessions)
    .where(eq(diskWriteSessions.deviceId, m.deviceId))).toEqual([]);
  expect((await request.get(`/api/device/image/${want}`, { headers: authHeader(m.token) })).status()).toBe(200);
});

test('a repeated seq is accepted and changes nothing', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const a = new Uint8Array(TRACK_DATA_BYTES).fill(1);
  const b = new Uint8Array(TRACK_DATA_BYTES).fill(2);
  expect((await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 7, seq: 1 }, a)).status()).toBe(200);
  const dup = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 7, seq: 1 }, b);
  expect(dup.status()).toBe(200);
  expect((await dup.json()).duplicate).toBe(true);

  const expected = m.adf.slice(); expected.set(a, 7 * TRACK_DATA_BYTES);   // a, not b
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${sha(expected)}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(200);
  const rows = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, m.diskId));
  for (const r of rows) if (r.kind === 'delta') deltaShas.push(r.blobSha256);
});

test('a write-protected disk refuses uploads', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  await page.request.patch(`/api/disks/${m.diskId}`, { data: { writeProtected: true } });
  const res = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 0, seq: 1 },
                           new Uint8Array(TRACK_DATA_BYTES));
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('write_protected');
});

test('an upload for a mount the board does not hold is refused', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const res = await upload(request, m.token, { diskId: m.diskId, mount: m.mount + 1, track: 0, seq: 1 },
                           new Uint8Array(TRACK_DATA_BYTES));
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('not_mounted');
});

test('a short body and a bad query are 400s', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const short = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 0, seq: 1 },
                             new Uint8Array(100));
  expect(short.status()).toBe(400);
  const bad = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 160, seq: 1 },
                           new Uint8Array(TRACK_DATA_BYTES));
  expect(bad.status()).toBe(400);
});

test('a close whose digest disagrees: the server image wins and the board re-downloads', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 3, seq: 1 },
               new Uint8Array(TRACK_DATA_BYTES).fill(9));
  const [before] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${'0'.repeat(64)}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(409);
  const body = await close.json();
  expect(body.error).toBe('mismatch');
  const [after] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  expect(after.desiredVersion).toBe(before.desiredVersion + 1);
  expect(after.desiredSha256).toBe(body.sha256);
  expect(after.lastError).toContain('mismatch');
  const rows = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, m.diskId));
  for (const r of rows) if (r.kind === 'delta') deltaShas.push(r.blobSha256);
});

test('a close against a head that moved answers 409 conflict and keeps the session to retry', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const written = new Uint8Array(TRACK_DATA_BYTES).fill(0x33);
  expect((await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 12, seq: 1 }, written)).status()).toBe(200);

  // Plant a history whose last image is NOT the disk's head: exactly what
  // recordVersion sees when another writer moved the disk after it was read.
  const planted = randomUUID();
  await getDb().insert(diskVersions).values({
    id: planted, diskId: m.diskId, orgId: m.orgId, seq: 0, kind: 'snapshot',
    blobSha256: 'f'.repeat(64), imageSha256: 'f'.repeat(64), source: 'original', sectorCount: 0,
  });

  const expected = m.adf.slice(); expected.set(written, 12 * TRACK_DATA_BYTES);
  const want = sha(expected);
  const [before] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  const close = () => request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${want}`,
    { headers: authHeader(m.token) });

  const refused = await close();
  expect(refused.status()).toBe(409);
  expect(refused.headers()['cache-control']).toBe('no-store');
  expect((await refused.json()).error).toBe('conflict');

  // Nothing moved: the session and its track are still staged, the device is untouched.
  const sessions = await getDb().select().from(diskWriteSessions)
    .where(and(eq(diskWriteSessions.deviceId, m.deviceId), eq(diskWriteSessions.mount, m.mount)));
  expect(sessions).toHaveLength(1);
  const staged = await getDb().select().from(diskWriteTracks)
    .where(and(eq(diskWriteTracks.deviceId, m.deviceId), eq(diskWriteTracks.mount, m.mount)));
  expect(staged.map((t) => t.track)).toEqual([12]);
  const [after] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  expect([after.mountedSha256, after.desiredSha256, after.desiredVersion, after.lastError])
    .toEqual([before.mountedSha256, before.desiredSha256, before.desiredVersion, before.lastError]);
  const [disk] = await getDb().select().from(disks).where(eq(disks.id, m.diskId));
  expect(disk.sha256).toBe(m.original);

  // Once the history agrees with the head again, the same close succeeds.
  await getDb().delete(diskVersions).where(eq(diskVersions.id, planted));
  const retried = await close();
  expect(retried.status()).toBe(200);
  expect((await retried.json()).sha256).toBe(want);
  const rows = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, m.diskId));
  for (const r of rows) if (r.kind === 'delta') deltaShas.push(r.blobSha256);
});

test('a close after the board was pointed at another disk leaves that disk desired', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const written = new Uint8Array(TRACK_DATA_BYTES).fill(0x44);
  expect((await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 20, seq: 1 }, written)).status()).toBe(200);

  // D7's swap: the browser points the board at disk B before it closes A's session.
  const otherSha = createHash('sha256').update(`other-${runTag()}`).digest('hex');
  const { diskId: otherDiskId } = await seedDisk(m.orgId, { title: `Other ${runTag()}`, diskNo: 1, sha256: otherSha });
  expect((await page.request.post(`/api/devices/${m.deviceId}/mount`, { data: { diskId: otherDiskId } })).status()).toBe(200);
  const [before] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  expect(before.desiredDiskId).toBe(otherDiskId);

  const expected = m.adf.slice(); expected.set(written, 20 * TRACK_DATA_BYTES);
  const want = sha(expected);
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${want}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(200);
  expect((await close.json()).sha256).toBe(want);

  const [after] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  expect(after.desiredDiskId).toBe(otherDiskId);
  expect(after.desiredSha256).toBe(otherSha);
  expect(after.desiredVersion).toBe(before.desiredVersion);
  expect(after.mountedSha256).toBe(want);          // what the board holds right now
  const [disk] = await getDb().select().from(disks).where(eq(disks.id, m.diskId));
  expect(disk.sha256).toBe(want);                  // A's write still recorded
  const rows = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, m.diskId));
  for (const r of rows) if (r.kind === 'delta') deltaShas.push(r.blobSha256);
});

test('an open session survives a version bump the board acknowledged', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const a = new Uint8Array(TRACK_DATA_BYTES).fill(0x61);
  const b = new Uint8Array(TRACK_DATA_BYTES).fill(0x62);
  expect((await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 5, seq: 1 }, a)).status()).toBe(200);

  // A bump that is not a remount (write-protect toggle, another board's close),
  // and the board's status report acknowledging it.
  const bumped = m.mount + 1;
  await getDb().update(devices).set({ desiredVersion: bumped }).where(eq(devices.id, m.deviceId));
  expect((await request.post('/api/device/status', {
    headers: authHeader(m.token), data: { mountedSha256: m.original, mountedDiskId: m.diskId, version: bumped },
  })).status()).toBe(204);

  // The session opened under the old mount is still the one being written.
  const second = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 6, seq: 2 }, b);
  expect(second.status()).toBe(200);
  expect((await second.json()).staged).toBe(6);

  const expected = m.adf.slice();
  expected.set(a, 5 * TRACK_DATA_BYTES); expected.set(b, 6 * TRACK_DATA_BYTES);
  const want = sha(expected);
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=2&sha256=${want}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(200);
  expect((await close.json()).sha256).toBe(want);

  // With no session left, the stale mount cannot open a new one.
  const stale = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 7, seq: 3 }, a);
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toBe('not_mounted');
  expect(await getDb().select().from(diskWriteSessions)
    .where(eq(diskWriteSessions.deviceId, m.deviceId))).toEqual([]);
  const rows = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, m.diskId));
  for (const r of rows) if (r.kind === 'delta') deltaShas.push(r.blobSha256);
});

test('no token is refused', async ({ request }) => {
  const res = await request.post('/api/device/write?disk=x&mount=1&track=0&seq=1', { data: Buffer.alloc(5632) });
  expect([401, 404]).toContain(res.status());
  expect(res.headers()['cache-control']).toBe('no-store');
});
