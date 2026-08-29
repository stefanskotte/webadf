import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, blobs, games } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// This is the reference-client spec for the whole device protocol (task 7):
// mount, fetch, report, converge, eject, driven end to end with no hardware
// involved. Tasks 3-6 each proved one endpoint in isolation; nothing until
// this file has proved they compose across a real request sequence.

function anyRealAdf(): Buffer {
  const dir = 'adf-archive';
  const name = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.adf'));
  if (!name) throw new Error('no ADF in adf-archive/ — this spec needs one');
  return readFileSync(`${dir}/${name}`);
}

/**
 * Find a genuine two-disk set in adf-archive/ by the `_D1`/`_D2` naming
 * convention parseTosecName already understands (see src/lib/tosec.ts) --
 * ingesting both together lands one game with two disks, which is exactly
 * what behaviour 3 (the swap) needs. Not hardcoded to one filename so this
 * spec keeps working if the archive's contents change, as long as some
 * pair still exists.
 */
function twoDiskSet(): { name: string; d1: Buffer; d2: Buffer } {
  const dir = 'adf-archive';
  const names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.adf'));
  for (const n1 of names) {
    const m = n1.match(/^(.+)_D1\.adf$/i);
    if (!m) continue;
    const n2 = names.find((x) => x.toLowerCase() === `${m[1]}_D2.adf`.toLowerCase());
    if (n2) return { name: m[1], d1: readFileSync(`${dir}/${n1}`), d2: readFileSync(`${dir}/${n2}`) };
  }
  throw new Error('no _D1/_D2 pair found in adf-archive/ — behaviour 3 needs one');
}

// Copied from e2e/device-image.spec.ts rather than imported: that file does
// not export it, and device-image.spec.ts's own header comment records the
// same choice one level up (copied from ingest-api.spec.ts rather than
// reinvented). Same reasoning applies here — presign 400s on a re-PUT of an
// already-stored key (allowOverwrite: false), and several adf-archive/ files
// are already stored blobs from earlier sessions, so /check must be asked
// first.
async function uploadDisk(page: Page, content: Buffer) {
  const sha256 = createHash('sha256').update(content).digest('hex');

  const checkRes = await page.request.post('/api/ingest/check', { data: { hashes: [sha256] } });
  const { known } = await checkRes.json();
  const createdBlob = !known.includes(sha256);

  if (createdBlob) {
    const presignRes = await page.request.post('/api/ingest/presign', {
      data: { files: [{ sha256, sizeBytes: content.length }] },
    });
    const { uploads } = await presignRes.json();
    const putRes = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
    if (!putRes.ok) throw new Error(`test setup: blob PUT failed with ${putRes.status}`);
  }

  return { sha256, sizeBytes: content.length, createdBlob };
}

// device-helpers.ts's cleanupSeeded only tracks what seedDisk/addDisk/
// pairDevice insert directly. /api/ingest/complete inserts games/disks/
// entitlements rows of its own (behaviours 1 and 3 both drive it for real
// bytes), so this file must remove those itself — same split as
// device-image.spec.ts.
const ingestCleanup = {
  orgShaPairs: [] as Array<{ orgId: string; sha256: string }>,
  ownedBlobShas: [] as string[],
};

async function ingestComplete(page: Page, orgId: string, files: Array<{ sha256: string; sizeBytes: number; filename: string }>) {
  const res = await page.request.post('/api/ingest/complete', { data: { files } });
  expect(res.status()).toBe(200);
  for (const f of files) ingestCleanup.orgShaPairs.push({ orgId, sha256: f.sha256 });
  return res;
}

async function cleanupIngest(): Promise<void> {
  const db = getDb();
  try {
    for (const { orgId, sha256 } of ingestCleanup.orgShaPairs) {
      await db.delete(disks).where(and(eq(disks.orgId, orgId), eq(disks.sha256, sha256)));
      await db.delete(entitlements).where(and(eq(entitlements.orgId, orgId), eq(entitlements.sha256, sha256)));
      await db.delete(games).where(eq(games.orgId, orgId));
    }
    if (ingestCleanup.ownedBlobShas.length) {
      for (const sha256 of ingestCleanup.ownedBlobShas) {
        await db.delete(blobs).where(eq(blobs.sha256, sha256));
      }
    }
  } catch (e) {
    console.warn('cleanupIngest: best effort, continuing —', (e as Error).message);
  } finally {
    ingestCleanup.orgShaPairs.length = 0;
    ingestCleanup.ownedBlobShas.length = 0;
  }
}

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

/** Resolve the disks.id landed by /api/ingest/complete for a given digest. */
async function diskIdFor(orgId: string, sha256: string): Promise<string> {
  const rows = await getDb()
    .select({ id: disks.id })
    .from(disks)
    .where(and(eq(disks.orgId, orgId), inArray(disks.sha256, [sha256])));
  if (!rows[0]) throw new Error(`test setup: no disks row landed for ${sha256}`);
  return rows[0].id;
}

test.afterAll(cleanupSeeded);
test.afterAll(cleanupIngest);

test('behaviour 1: a full mount cycle converges', async ({ page, request }) => {
  test.setTimeout(60_000); // the final poll holds for 25 s waiting on a 204

  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  const adf = anyRealAdf();
  const { sha256, sizeBytes, createdBlob } = await uploadDisk(page, adf);
  await ingestComplete(page, orgId, [{ sha256, sizeBytes, filename: `Mount Cycle ${randomUUID()}.adf` }]);
  if (createdBlob) ingestCleanup.ownedBlobShas.push(sha256);
  const diskId = await diskIdFor(orgId, sha256);

  const mount = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();

  const poll1 = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(poll1.status()).toBe(200);
  const state1 = await poll1.json();
  expect(state1.desired.sha256).toBe(sha256);
  expect(state1.version).toBe(mount.version);

  const image = await request.get(`/api/device/image/${sha256}`, { headers: authHeader(token) });
  expect(image.status()).toBe(200);
  const bytes = await image.body();
  expect(bytes.length).toBe(2_027_536);
  expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x57, 0x46, 0x4d, 0x46]); // 'WFMF'

  const report = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: sha256 },
  });
  expect(report.status()).toBe(204);

  // The device already has this version — a poll at it must hold and 204,
  // never repeat the same instruction.
  const poll2 = await request.get(`/api/device/poll?since=${state1.version}`, {
    headers: authHeader(token), timeout: 45_000,
  });
  expect(poll2.status()).toBe(204);

  // Convergence: what the device reported now equals what was desired. This
  // equality is what plan 3b's UI will read as "synced" rather than "pending".
  const row = await deviceRow(deviceId);
  expect(row.mountedSha256).toBe(row.desiredSha256);
  expect(row.mountedSha256).toBe(sha256);
});

test('behaviour 2: eject completes the cycle', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Cycle ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const mount = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  await request.get(`/api/device/poll?since=0`, { headers: authHeader(token) }); // establish it saw the mount

  const eject = await (await page.request.post(`/api/devices/${deviceId}/eject`)).json();
  expect(eject.version).toBeGreaterThan(mount.version);

  const poll = await request.get(`/api/device/poll?since=${mount.version}`, { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  const state = await poll.json();
  expect(state.desired).toBeNull();
  expect(state.version).toBe(eject.version);

  const report = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null },
  });
  expect(report.status()).toBe(204);

  const row = await deviceRow(deviceId);
  expect(row.desiredSha256).toBeNull();
  expect(row.mountedSha256).toBeNull();
});

test('behaviour 3: a swap delivers the second disk, and diskCount is 2', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  const set = twoDiskSet();
  const up1 = await uploadDisk(page, set.d1);
  const up2 = await uploadDisk(page, set.d2);
  await ingestComplete(page, orgId, [
    { sha256: up1.sha256, sizeBytes: up1.sizeBytes, filename: `${set.name}_D1.adf` },
    { sha256: up2.sha256, sizeBytes: up2.sizeBytes, filename: `${set.name}_D2.adf` },
  ]);
  if (up1.createdBlob) ingestCleanup.ownedBlobShas.push(up1.sha256);
  if (up2.createdBlob) ingestCleanup.ownedBlobShas.push(up2.sha256);

  const disk1Id = await diskIdFor(orgId, up1.sha256);
  const disk2Id = await diskIdFor(orgId, up2.sha256);

  const mount1 = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk1Id } })).json();
  const poll1 = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll1.desired.sha256).toBe(up1.sha256);
  expect(poll1.desired.diskNo).toBe(1);

  const mount2 = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: disk2Id } })).json();
  expect(mount2.version).toBeGreaterThan(mount1.version);

  const poll2 = await request.get(`/api/device/poll?since=${mount1.version}`, { headers: authHeader(token) });
  expect(poll2.status()).toBe(200);
  const state2 = await poll2.json();
  expect(state2.desired.sha256).toBe(up2.sha256);
  expect(state2.desired.diskNo).toBe(2);
  // THE assertion this behaviour exists for: diskCount is a correlated
  // subquery in readDesired, and the single easiest thing in this plan to
  // get silently wrong (e.g. by returning the literal 1).
  expect(state2.desired.diskCount).toBe(2);
});

test('behaviour 4: write protection reaches the device', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `WP ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const patchFalse = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } });
  expect(patchFalse.status()).toBe(200);

  const mount1 = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  const poll1 = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll1.desired.writeProtected).toBe(false);

  const patchTrue = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: true } });
  expect(patchTrue.status()).toBe(200);

  const mount2 = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  expect(mount2.version).toBeGreaterThan(mount1.version);

  const poll2 = await request.get(`/api/device/poll?since=${poll1.version}`, { headers: authHeader(token) });
  expect(poll2.status()).toBe(200);
  const state2 = await poll2.json();
  expect(state2.desired.writeProtected).toBe(true);
});

test('behaviour 5: cross-tenant isolation across the whole flow', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const { orgId: orgA } = await signUpFresh(pageA);
  const { orgId: orgB } = await signUpFresh(pageB);
  const { deviceId: deviceA, token: tokenA } = await pairDevice(pageA, ctxA.request);
  const { deviceId: deviceB, token: tokenB } = await pairDevice(pageB, ctxB.request);

  const shaA = sha(`${runTag()}-a`);
  const shaB = sha(`${runTag()}-b`);
  const { diskId: diskA } = await seedDisk(orgA, { title: `Iso A ${runTag()}`, diskNo: 1, sha256: shaA });
  const { diskId: diskB } = await seedDisk(orgB, { title: `Iso B ${runTag()}`, diskNo: 1, sha256: shaB });

  await pageA.request.post(`/api/devices/${deviceA}/mount`, { data: { diskId: diskA } });
  await pageB.request.post(`/api/devices/${deviceB}/mount`, { data: { diskId: diskB } });

  // A's device polling never sees B's state.
  const pollA = await (await ctxA.request.get('/api/device/poll?since=0', { headers: authHeader(tokenA) })).json();
  expect(pollA.desired.sha256).toBe(shaA);
  expect(pollA.desired.sha256).not.toBe(shaB);

  // B's device polling never sees A's state either — proves the isolation
  // runs both directions, not just the one this test happens to check first.
  const pollB = await (await ctxB.request.get('/api/device/poll?since=0', { headers: authHeader(tokenB) })).json();
  expect(pollB.desired.sha256).toBe(shaB);
  expect(pollB.desired.sha256).not.toBe(shaA);

  // A's device cannot fetch B's image, even by digest alone.
  const fetchAtoB = await ctxA.request.get(`/api/device/image/${shaB}`, { headers: authHeader(tokenA) });
  expect(fetchAtoB.status()).toBe(404);

  await ctxA.close();
  await ctxB.close();
});
