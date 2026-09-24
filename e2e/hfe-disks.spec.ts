import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { signUpFresh } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const fakeSha = () => createHash('sha256').update(randomUUID()).digest('hex');

test.describe('an HFE disk is read-only on every path', () => {
  test('write-protect cannot be turned off; turning it on is harmless', async ({ page }) => {
    const { orgId } = await signUpFresh(page);
    const { diskId } = await seedDisk(orgId, { title: 'HFE WP', diskNo: 1, sha256: fakeSha(), sizeBytes: 2_049_024, imageFormat: 'hfe' });
    const off = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } });
    expect(off.status()).toBe(409);
    expect((await off.json()).error).toBe('hfe_read_only');
    const on = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: true } });
    expect(on.status()).toBe(200);
  });

  test('file add, volume rename and restore are refused before any bytes are read', async ({ page }) => {
    const { orgId } = await signUpFresh(page);
    // A digest with no blob behind it: a route that tried to read the bytes would answer 503, not 409.
    const { diskId } = await seedDisk(orgId, { title: 'HFE RO', diskNo: 1, sha256: fakeSha(), sizeBytes: 2_049_024, imageFormat: 'hfe' });

    const mkdir = await page.request.post(`/api/disks/${diskId}/files`, { multipart: { parentBlock: '880', name: 'x' } });
    expect(mkdir.status()).toBe(409);
    expect(await mkdir.json()).toMatchObject({ error: 'edit_failed', reason: 'hfe_read_only' });

    const rename = await page.request.patch(`/api/disks/${diskId}/volume-name`, { data: { volumeName: 'X' } });
    expect(rename.status()).toBe(409);
    expect((await rename.json()).error).toBe('hfe_read_only');

    const restore = await page.request.post(`/api/disks/${diskId}/restore`, { data: { seq: 0 } });
    expect(restore.status()).toBe(409);
    expect((await restore.json()).error).toBe('hfe_read_only');
  });
});
