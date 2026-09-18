import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq, asc } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { diskVersions } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { decodeDelta } from '@/lib/disk-history/delta';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// cleanupSeeded (e2e/device-helpers.ts) now reclaims this file's delta blobs
// itself, via the shared reclaimDeltaBlobs helper, before it deletes the
// seeded disks -- checked against every OTHER disk's history first, since a
// delta's sha depends only on the edit, not on which disk it landed on.
test.afterAll(cleanupSeeded);

async function versions(diskId: string) {
  return getDb().select().from(diskVersions)
    .where(eq(diskVersions.diskId, diskId)).orderBy(asc(diskVersions.seq));
}

test('a rename is recorded as a browser version on top of version 0', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `Hist${runTag().slice(0, 6)}` });
  const original = sha(adf);
  await diskStore.put(original, adf);
  const { diskId } = await seedDisk(orgId, { title: `History ${runTag()}`, diskNo: 1, sha256: original });

  const res = await page.request.patch(`/api/disks/${diskId}/volume-name`, { data: { volumeName: 'Renamed' } });
  expect(res.status()).toBe(200);
  const { sha256: renamed } = await res.json();

  const rows = await versions(diskId);
  expect(rows.map((r) => [r.seq, r.kind, r.source])).toEqual([
    [0, 'snapshot', 'original'],
    [1, 'delta', 'browser'],
  ]);
  expect(rows[0].imageSha256).toBe(original);
  expect(rows[0].blobSha256).toBe(original);
  expect(rows[1].imageSha256).toBe(renamed);
  expect(rows[1].userId).not.toBeNull();
  expect(rows[1].sectorCount).toBeGreaterThan(0);

  // The delta is a real WDLD blob in the store, and only names changed sectors.
  const delta = decodeDelta(await diskStore.read(rows[1].blobSha256));
  expect(delta.sectors.length).toBe(rows[1].sectorCount);

  const [disk] = await getDb().select().from(disks).where(eq(disks.id, diskId));
  expect(disk.sha256).toBe(renamed);
});

test('renaming to the same name records nothing', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const adf = formatVolume({ filesystem: 'OFS', volumeName: 'Same' });
  const s = sha(adf);
  await diskStore.put(s, adf);
  const { diskId } = await seedDisk(orgId, { title: `Same ${runTag()}`, diskNo: 1, sha256: s });
  const res = await page.request.patch(`/api/disks/${diskId}/volume-name`, { data: { volumeName: 'Same' } });
  expect(res.status()).toBe(200);
  expect(await versions(diskId)).toEqual([]);
});
