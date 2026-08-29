import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk } from './device-helpers';

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
  expect(after.desiredDiskNo).toBe(1);
  expect(after.desiredVersion).toBe(version);
  expect(version).toBeGreaterThan(before.desiredVersion);
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
  const res = await page.request.post(`/api/devices/${deviceId}/eject`);
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect(version).toBeGreaterThan(mounted.version);

  const row = await deviceRow(deviceId);
  expect(row.desiredSha256).toBeNull();
  expect(row.desiredGameId).toBeNull();
  expect(row.desiredDiskNo).toBeNull();
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
