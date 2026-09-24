import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

const fakeSha = () => createHash('sha256').update(randomUUID()).digest('hex');

const hfeFixture = (name: 'clean' | 'v3' | 'pc') =>
  gunzipSync(readFileSync(`src/lib/hfe/__fixtures__/${name}.hfe.gz`));

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

test.describe('uploading HFE', () => {
  test('a v1 Amiga HFE lands read-only with the weak-bit notice; a second org dedupes and is still validated', async ({ browser }) => {
    for (let i = 0; i < 2; i++) {
      const page = await (await browser.newContext()).newPage();
      const { orgId } = await signUpFresh(page);
      await page.goto('/ingest');
      await page.getByTestId('file-input').setInputFiles({
        name: `HFE Test ${i} (1993)(Webadf).hfe`, mimeType: 'application/octet-stream', buffer: hfeFixture('clean'),
      });
      const row = page.getByTestId('ingest-row').first();
      await expect(row.getByTestId('ingest-note')).toContainText("Weak-bit copy protections aren't supported");
      // Polled, not read once: a row shows "deduped" (the fixture is fixed, so
      // every run after the first dedupes) BEFORE /complete has written it.
      await expect.poll(() => getDb().select({ f: disks.imageFormat, wp: disks.writeProtected, x: disks.extractable })
        .from(disks).where(eq(disks.orgId, orgId)), { timeout: 30_000 })
        .toEqual([{ f: 'hfe', wp: true, x: true }]);
      await page.context().close();
    }
  });

  test('v3 and PC HFE files are refused on the row, with the reason, and never uploaded', async ({ page }) => {
    const { orgId } = await signUpFresh(page);
    await page.goto('/ingest');
    await page.getByTestId('file-input').setInputFiles([
      { name: 'V3 Disk.hfe', mimeType: 'application/octet-stream', buffer: hfeFixture('v3') },
      { name: 'PC Disk.hfe', mimeType: 'application/octet-stream', buffer: hfeFixture('pc') },
    ]);
    await expect(page.getByTestId('ingest-row')).toHaveCount(2);
    await expect(page.getByText("HFE v3 isn't supported yet")).toBeVisible();
    await expect(page.getByText('Not an Amiga disk: track 0 has no Amiga boot sectors.')).toBeVisible();
    expect(await getDb().select().from(disks).where(eq(disks.orgId, orgId))).toHaveLength(0);
  });

  test('the server refuses a v3 HFE sent straight to the API (the CLI path)', async ({ page }) => {
    await signUpFresh(page);
    const bytes = hfeFixture('v3');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const check = await page.request.post('/api/ingest/check', { data: { hashes: [sha256] } });
    if (!(await check.json()).known.includes(sha256)) {
      const { uploads } = await (await page.request.post('/api/ingest/presign', { data: { files: [{ sha256, sizeBytes: bytes.length }] } })).json();
      const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(bytes) });
      expect(put.ok || put.status === 400).toBe(true); // 400: already stored by an earlier run
    }
    const res = await page.request.post('/api/ingest/complete', {
      data: { files: [{ sha256, sizeBytes: bytes.length, filename: 'V3 Direct.hfe' }] },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).rejectedReasons[sha256]).toMatch(/^HFE v3 isn't supported yet/);
  });
});
