import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { readDesired } from '@/lib/mount';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

test('mount sets the desired disk and bumps the version', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const before = await deviceRow(deviceId);
  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();

  const after = await deviceRow(deviceId);
  expect(after.desiredSha256).not.toBeNull();
  expect(after.desiredDiskId).toBe(diskId);
  expect(after.desiredDiskNo).toBe(1);
  expect(after.desiredVersion).toBe(version);
  expect(version).toBeGreaterThan(before.desiredVersion);

  // desiredSetAt is read by nothing in this task, but it is still state a
  // human or a future debugging session relies on -- a mutation that drops
  // it from the UPDATE must not go unnoticed.
  expect(after.desiredSetAt).not.toBeNull();
  expect(after.desiredSetAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

test('mounting disk 2 of a multi-disk game records the disk actually mounted, not a hardcoded disk 1', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { gameId } = await seedDisk(orgId, { title: `Multi ${runTag()}`, diskNo: 1, sha256: sha(`${runTag()}-d1`) });
  const { diskId: disk2Id } = await addDisk(orgId, gameId, { diskNo: 2, sha256: sha(`${runTag()}-d2`) });

  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk2Id } });
  expect(res.status()).toBe(200);

  const row = await deviceRow(deviceId);
  expect(row.desiredDiskId).toBe(disk2Id);
  expect(row.desiredDiskNo).toBe(2);
});

test('readDesired resolves the disk actually mounted by primary key, even when (game, diskNo) is not unique', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const shaA = sha(`${runTag()}-dupA`);
  const shaB = sha(`${runTag()}-dupB`);
  const { gameId } = await seedDisk(orgId, { title: `Dup ${runTag()}`, diskNo: 1, sha256: shaA });
  // A second disks row for the SAME game and SAME disk number -- e.g. a
  // corrected re-ingest of the same physical disk under an unchanged disk
  // number. (gameId, diskNo, orgId) is not unique in the schema (only
  // disks.id is), so readDesired must resolve to the exact row that was
  // mounted rather than whichever row a non-key join happens to pick.
  const { diskId: diskIdB } = await addDisk(orgId, gameId, {
    diskNo: 1, sha256: shaB, label: 'Corrected copy', writeProtected: false,
  });

  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: diskIdB } });
  expect(res.status()).toBe(200);

  const state = await readDesired(deviceId);
  expect(state?.desired?.sha256).toBe(shaB);
  expect(state?.desired?.label).toBe('Corrected copy');
  expect(state?.desired?.writeProtected).toBe(false);
});

test('mounting the same disk twice still bumps the version, so a failed mount can be retried', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const a = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  const b = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  expect(b.version).toBeGreaterThan(a.version);
});

test('eject nulls the desired disk and bumps the version', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const mounted = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  const afterMount = await deviceRow(deviceId);

  const res = await page.request.post(`/api/devices/${deviceId}/eject`);
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect(version).toBeGreaterThan(mounted.version);

  const row = await deviceRow(deviceId);
  expect(row.desiredSha256).toBeNull();
  expect(row.desiredGameId).toBeNull();
  expect(row.desiredDiskNo).toBeNull();
  expect(row.desiredDiskId).toBeNull();

  // clearDesired must touch desiredSetAt too, not just the null-out columns.
  expect(row.desiredSetAt).not.toBeNull();
  expect(row.desiredSetAt!.getTime()).toBeGreaterThanOrEqual(afterMount.desiredSetAt!.getTime());
});

test('one organization cannot mount to, or eject, another organization’s device', async ({ page, request, browser }) => {
  const { orgId: orgA } = await signUpFresh(page);
  const { diskId: diskA } = await seedDisk(orgA, { title: `A ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const { orgId: orgB } = await signUpFresh(pageB);
  const { deviceId: deviceB } = await pairDevice(pageB, request);
  const { diskId: diskB } = await seedDisk(orgB, { title: `B ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  // A aims at B's device — 404, not 403: A learns nothing about whether it exists.
  expect((await page.request.post(`/api/devices/${deviceB}/mount`, { data: { diskId: diskA } })).status()).toBe(404);
  expect((await page.request.post(`/api/devices/${deviceB}/eject`)).status()).toBe(404);

  // B aims its own device at A's disk — also 404.
  expect((await pageB.request.post(`/api/devices/${deviceB}/mount`, { data: { diskId: diskA } })).status()).toBe(404);

  // B's own disk on B's own device still works, proving the 404s were the org
  // check and not a broken route.
  expect((await pageB.request.post(`/api/devices/${deviceB}/mount`, { data: { diskId: diskB } })).status()).toBe(200);
  await ctxB.close();
});

test('a disk the encoder cannot serve is never mountable (F-1)', async ({ page, request }) => {
  // Ingest accepts 1 byte to 2 MiB, but encodeDisk throws on anything that is
  // not exactly a standard 901,120-byte DD image. Without the sizeBytes guard
  // in setDesired, this mount would succeed, the poll would succeed, and
  // /api/device/image/<sha256> would 500 forever with no signal to a human.
  // Prove it bites by temporarily removing the size check in setDesired --
  // this test then fails with 200 instead of 404.
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, {
    title: `Truncated ${runTag()}`, diskNo: 1, sha256: sha(runTag()), sizeBytes: 500_000,
  });

  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  expect(res.status()).toBe(404);

  const row = await deviceRow(deviceId);
  expect(row.desiredSha256).toBeNull();
});

test('an unknown device id and an unknown disk id are both plain 404s', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  expect((await page.request.post(`/api/devices/00000000-0000-4000-8000-000000000000/mount`, { data: { diskId } })).status()).toBe(404);
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: '00000000-0000-4000-8000-000000000000' } })).status()).toBe(404);
});

test('the write-protect toggle updates the disk and is org-scoped', async ({ page, request, browser }) => {
  const { orgId } = await signUpFresh(page);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  // Defaults to protected — games shipped read-only.
  let row = (await getDb().select().from(disks).where(eq(disks.id, diskId)))[0];
  expect(row.writeProtected).toBe(true);

  const res = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ id: diskId, writeProtected: false });

  row = (await getDb().select().from(disks).where(eq(disks.id, diskId)))[0];
  expect(row.writeProtected).toBe(false);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signUpFresh(pageB);
  expect((await pageB.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: true } })).status()).toBe(404);
  await ctxB.close();
});

test('mount, eject and the write-protect toggle all reject an anonymous caller', async ({ request }) => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const [path, method] of [
    [`/api/devices/${id}/mount`, 'post'],
    [`/api/devices/${id}/eject`, 'post'],
    [`/api/disks/${id}`, 'patch'],
  ] as const) {
    const res = await request[method](path, { data: { diskId: id, writeProtected: true }, maxRedirects: 0 });
    expect(res.status(), `${path} must redirect an anonymous caller`).toBe(307);
    expect(res.headers()['location'], path).toContain('/sign-in');
  }
});
