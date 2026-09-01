import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

/**
 * Upload real bytes through the real ingest flow.
 *
 * seedDisk writes a blobs ROW but never PUTs anything, so a download of a
 * seeded disk would correctly 503. This route is about bytes, so the bytes
 * have to exist.
 */
async function uploadDisk(page: import('@playwright/test').Page, content: Buffer) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: content.length }] },
  });
  expect(presign.ok()).toBe(true);
  const { uploads } = await presign.json();
  const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  if (!put.ok) throw new Error(`test setup: PUT failed ${put.status}`);
  return sha256;
}

/** A real 901,120-byte image, unique per test so no two share a digest. */
function adfBytes(): Buffer {
  const buf = Buffer.alloc(901_120);
  buf.write(`DOS\0${randomUUID()}`, 0);
  return buf;
}

test('a human downloads the raw ADF, with the canonical name', async ({ page }) => {
  const user = await signUpFresh(page);
  const content = adfBytes();
  const sha256 = await uploadDisk(page, content);
  const filename = `Turrican II (1991)(Rainbow Arts).adf`;
  const res = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: content.length, filename }] },
  });
  expect(res.status()).toBe(200);

  const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];
  // NOT null. /api/ingest/complete seeds disks.tosecName with the UPLOADED
  // filename, and the identity scan later overwrites it with the canonical
  // one -- so the column holds "best known name", not "TOSEC's name", and is
  // only truly canonical after a match. Pinned here because the column's own
  // name suggests otherwise.
  expect(row.tosecName).toBe(filename);

  const dl = await page.request.get(`/api/disks/${row.id}/adf`);
  expect(dl.status()).toBe(200);
  expect(dl.headers()['content-type']).toBe('application/x-amiga-disk-file');
  expect(dl.headers()['content-disposition']).toContain(`filename="${filename}"`);

  // The bytes must be the disk, not a truncated stream or the MFM encoding
  // that /api/device/image serves for the same disk.
  const body = await dl.body();
  expect(body.byteLength).toBe(901_120);
  expect(createHash('sha256').update(body).digest('hex')).toBe(sha256);
});

test('the TOSEC name wins over the uploaded one once the disk is identified', async ({ page }) => {
  const user = await signUpFresh(page);
  const content = adfBytes();
  const sha256 = await uploadDisk(page, content);
  await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: content.length, filename: 'Stateart.adf' }] },
  });

  const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];
  const canonical = 'State of the Art (1992-12-29)(Spaceballs)[f mem SR].adf';
  await getDb().update(disks).set({ tosecName: canonical }).where(eq(disks.id, row.id));

  const dl = await page.request.get(`/api/disks/${row.id}/adf`);
  expect(dl.headers()['content-disposition']).toContain(`filename="${canonical}"`);
  void user;
});

test('another tenant gets 404, not 403 and not the bytes', async ({ browser }) => {
  // The boundary. A 403 would confirm the disk exists; only 404 reveals
  // nothing about another organization's library.
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pageA = await a.newPage();
    await signUpFresh(pageA);
    const content = adfBytes();
    const sha256 = await uploadDisk(pageA, content);
    await pageA.request.post('/api/ingest/complete', {
      data: { files: [{ sha256, sizeBytes: content.length, filename: 'Private.adf' }] },
    });
    const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];

    // Proven reachable by its owner first, so the 404 below cannot pass for
    // the trivial reason that the id is wrong.
    expect((await pageA.request.get(`/api/disks/${row.id}/adf`)).status()).toBe(200);

    const pageB = await b.newPage();
    await signUpFresh(pageB);
    const denied = await pageB.request.get(`/api/disks/${row.id}/adf`);
    expect(denied.status()).toBe(404);
    expect((await denied.body()).byteLength).toBeLessThan(1000);
  } finally {
    await a.close();
    await b.close();
  }
});

test('an anonymous caller cannot download', async ({ request }) => {
  const res = await request.get(`/api/disks/${randomUUID()}/adf`, { maxRedirects: 0 });
  // requireOrg redirects to sign-in rather than answering.
  expect([302, 303, 307]).toContain(res.status());
});

test('the game page shows both names and offers the download', async ({ page }) => {
  const user = await signUpFresh(page);
  const content = adfBytes();
  const sha256 = await uploadDisk(page, content);
  await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: content.length, filename: 'Stateart.adf' }] },
  });
  const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];
  const canonical = 'State of the Art (1992-12-29)(Spaceballs).adf';
  await getDb().update(disks).set({ tosecName: canonical }).where(eq(disks.id, row.id));

  await page.goto(`/games/${row.gameId}`);
  await expect(page.getByTestId(`tosec-name-${row.id}`)).toHaveText(canonical);
  await expect(page.getByTestId(`source-name-${row.id}`)).toContainText('Stateart.adf');
  await expect(page.getByTestId(`download-${row.id}`))
    .toHaveAttribute('href', `/api/disks/${row.id}/adf`);
  void user;
});
