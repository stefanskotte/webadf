import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, disks } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { seedDisk, cleanupSeeded, pairDevice, authHeader } from './device-helpers';
import { parseLikeFirmware } from '@/lib/adfmfm/firmware-parser';
import { sparseAdf as sparseAdfBytes } from '@/lib/hfe/__fixtures__/source';

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

  test('a server-side refusal reaches the row, even when the browser check is bypassed and the whole batch is refused', async ({ page }) => {
    await signUpFresh(page);
    await page.goto('/ingest');
    const bytes = hfeFixture('clean');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // A batch that is refused ENTIRELY -- the real shape /complete answers
    // with when every file in it fails validation (Finding 1) -- is 409, not
    // 200. post()'s old throw-on-any-non-OK behaviour surfaced that 409 as a
    // plain transport error before the per-file rejectedReasons handling
    // ever ran, so a refused row that had already been marked 'deduped'
    // stayed showing 'deduped' (looked like success), and any other refused
    // row landed 'failed' with no note. The browser's own inspectHfe would
    // accept this fixture (it's the clean/valid one), so the only way to
    // reach that code path from the UI is a refusal that originates on the
    // server -- exactly what the CLI path exercises for real. Routed here
    // instead of relying on a second real upload of the same bytes deduping
    // (which the DB state at the moment this test runs cannot guarantee),
    // so the assertion is about the client's handling of the response shape,
    // not about store state left behind by other tests.
    const reason = "HFE v3 isn't supported yet — test";
    await page.route('**/api/ingest/complete', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ created: 0, rejected: [sha256], rejectedReasons: { [sha256]: reason } }),
      }),
    );

    await page.getByTestId('file-input').setInputFiles({
      name: 'Server Refusal Test.hfe', mimeType: 'application/octet-stream', buffer: bytes,
    });

    const row = page.getByTestId('ingest-row').first();
    await expect(row.locator('[data-state="failed"]')).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('ingest-note')).toHaveText(reason);
  });
});

/** Upload the clean fixture through the real UI and wait until /complete has written the disk row. */
test.describe('HFE batch and size limits', () => {
  test('/complete refuses more than 50 .hfe files in one call before touching storage', async ({ page }) => {
    await signUpFresh(page);
    const files = (n: number) => Array.from({ length: n }, (_, i) =>
      ({ sha256: fakeSha(), sizeBytes: 2_049_024, filename: `Cap ${i}.hfe` }));
    const over = await page.request.post('/api/ingest/complete', { data: { files: files(51) } });
    expect(over.status()).toBe(400);
    expect(await over.json()).toEqual({ error: 'too_many_hfe', max: 50 });
    // At the cap the call proceeds: nothing is stored, so every file is
    // refused as not-stored (409), not refused as a batch.
    const at = await page.request.post('/api/ingest/complete', { data: { files: files(50) } });
    expect(at.status()).toBe(409);
    // Only .hfe names count: 51 more .adf names ride along without a 400.
    const mixed = [...files(50), ...Array.from({ length: 51 }, (_, i) =>
      ({ sha256: fakeSha(), sizeBytes: 901_120, filename: `Cap ${i}.adf` }))];
    expect((await page.request.post('/api/ingest/complete', { data: { files: mixed } })).status()).toBe(409);
  });

  test('presign admits a 2.25 MiB image and refuses one byte more', async ({ page }) => {
    await signUpFresh(page);
    const sign = (sizeBytes: number) => page.request.post('/api/ingest/presign',
      { data: { files: [{ sha256: fakeSha(), sizeBytes }] } });
    // 84 cylinders at the board's longest track: refused under the old 2 MiB cap.
    expect((await sign(1024 + 84 * 2 * 13_312)).status()).toBe(200);
    expect((await sign(2_359_296)).status()).toBe(200);
    expect((await sign(2_359_297)).status()).toBe(400);
  });

  test('an oversize file fails on its row with the size and the limit', async ({ page }) => {
    await signUpFresh(page);
    await page.goto('/ingest');
    await page.getByTestId('file-input').setInputFiles({
      name: 'Too Big.adf', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2_516_582, 1),
    });
    await expect(page.getByTestId('ingest-row').first().getByTestId('ingest-note'))
      .toHaveText('Too Big.adf is 2.4 MB; the limit is 2.25 MB');
  });

  test('the dropzone splits a drop of 51 HFEs so every one lands', async ({ page }) => {
    test.setTimeout(120_000); // 51 browser-side inspections of ~2 MB each
    const { orgId } = await signUpFresh(page);
    await page.goto('/ingest');
    // Same bytes, 51 names, 51 games: one call carrying all of them would be
    // refused as too_many_hfe and not one disk would land.
    // Written to disk: Playwright refuses more than 50 MB of in-memory buffers.
    const buffer = hfeFixture('clean');
    const paths = Array.from({ length: 51 }, (_, i) => {
      const p = test.info().outputPath(
        `HFE Split ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)} (1993)(Webadf).hfe`);
      writeFileSync(p, buffer);
      return p;
    });
    await page.getByTestId('file-input').setInputFiles(paths);
    await expect.poll(async () => (await getDb().select({ id: disks.id }).from(disks)
      .where(eq(disks.orgId, orgId))).length, { timeout: 90_000 }).toBe(51);
  });
});

async function uploadHfeThroughUi(page: import('@playwright/test').Page, orgId: string, title: string) {
  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles({
    name: `${title} (1993)(Webadf).hfe`, mimeType: 'application/octet-stream', buffer: hfeFixture('clean'),
  });
  // Not the row state: "deduped" shows before /complete runs.
  await expect.poll(async () => (await getDb().select({ id: disks.id }).from(disks).where(eq(disks.orgId, orgId))).length,
    { timeout: 30_000 }).toBe(1);
}

test.describe('an HFE on the game page', () => {
  test('shows the tag, the notice and Read-only, offers Extract, and no Browse or write-protect toggle', async ({ page }) => {
    const { orgId } = await signUpFresh(page);
    await uploadHfeThroughUi(page, orgId, 'HFE Row');
    const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks).where(eq(disks.orgId, orgId));
    await page.goto(`/games/${d.gameId}`);
    await expect(page.getByTestId(`hfe-tag-${d.id}`)).toHaveText('HFE');
    await expect(page.getByTestId(`hfe-notice-${d.id}`)).toContainText("Weak-bit copy protections aren't supported");
    await expect(page.getByTestId(`hfe-readonly-${d.id}`)).toHaveText('Read-only (HFE)');
    await expect(page.getByTestId(`wp-${d.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`browse-${d.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`extract-${d.id}`)).toBeVisible();

    // The file browser URL, typed by hand, lands back on the game page.
    await page.goto(`/disks/${d.id}/files`);
    await expect(page).toHaveURL(new RegExp(`/games/${d.gameId}`));
  });

  test('Extract as ADF creates a browsable ADF disk in the same game whose bytes are the source', async ({ page }) => {
    const { orgId } = await signUpFresh(page);
    await uploadHfeThroughUi(page, orgId, 'HFE Extract');
    const [h] = await getDb().select({ id: disks.id, gameId: disks.gameId, sha256: disks.sha256 }).from(disks).where(eq(disks.orgId, orgId));
    await page.goto(`/games/${h.gameId}`);
    await page.getByTestId(`extract-${h.id}`).click();

    const expectedSha = createHash('sha256').update(sparseAdfBytes()).digest('hex');
    await expect.poll(async () => (await getDb().select({ sha: disks.sha256, f: disks.imageFormat, g: disks.gameId })
      .from(disks).where(and(eq(disks.orgId, orgId), eq(disks.imageFormat, 'adf')))))
      .toEqual([{ sha: expectedSha, f: 'adf', g: h.gameId }]);

    const [x] = await getDb().select({ id: disks.id }).from(disks).where(and(eq(disks.orgId, orgId), eq(disks.imageFormat, 'adf')));
    await page.reload();
    await expect(page.getByTestId(`browse-${x.id}`)).toBeVisible();
    // The HFE is untouched.
    const [again] = await getDb().select({ sha: disks.sha256 }).from(disks).where(eq(disks.id, h.id));
    expect(again.sha).toBe(h.sha256);
    // Extracting twice is idempotent: still exactly one ADF row.
    const second = await page.request.post(`/api/disks/${h.id}/extract`);
    expect(second.status()).toBe(200);
    expect(await getDb().select().from(disks).where(and(eq(disks.orgId, orgId), eq(disks.imageFormat, 'adf')))).toHaveLength(1);
  });

  test('extracting to an ADF whose blob already has a verdict puts it back in front of the sweeper', async ({ browser }) => {
    // Spec D7. The extracted bytes are fixed, so after the first run ever the
    // ADF blob exists and is decided. The sweeper only picks up a null cursor,
    // so without the reset a second org's extracted disk is never identified.
    test.setTimeout(120_000); // two sign-ups and two uploads
    const expectedSha = createHash('sha256').update(sparseAdfBytes()).digest('hex');
    const extractIn = async (title: string) => {
      const page = await (await browser.newContext()).newPage();
      const { orgId } = await signUpFresh(page);
      await uploadHfeThroughUi(page, orgId, title);
      const [h] = await getDb().select({ id: disks.id }).from(disks).where(eq(disks.orgId, orgId));
      expect((await page.request.post(`/api/disks/${h.id}/extract`)).status()).toBe(200);
      await page.context().close();
    };
    await extractIn('HFE Verdict A'); // guarantees the ADF blob exists

    // A sentinel verdict no real sweep would write, so "changed" is provable
    // even if the sweeper re-decides the blob before we look.
    const sentinel = new Date('2001-01-01T00:00:00Z');
    const [before] = await getDb().select({ at: blobs.matchCheckedAt, st: blobs.matchState, e: blobs.tosecEntryId })
      .from(blobs).where(eq(blobs.sha256, expectedSha));
    await getDb().update(blobs).set({ matchCheckedAt: sentinel, matchState: 'none', tosecEntryId: null })
      .where(eq(blobs.sha256, expectedSha));
    try {
      await extractIn('HFE Verdict B');
      await expect.poll(async () => {
        const [b] = await getDb().select({ at: blobs.matchCheckedAt }).from(blobs).where(eq(blobs.sha256, expectedSha));
        return b.at === null || b.at.getTime() !== sentinel.getTime();
      }, { timeout: 20_000 }).toBe(true);
    } finally {
      // Only undo our own stamp; a verdict the sweeper wrote since is genuine.
      await getDb().update(blobs).set({ matchCheckedAt: before.at, matchState: before.st, tosecEntryId: before.e })
        .where(and(eq(blobs.sha256, expectedSha), eq(blobs.matchCheckedAt, sentinel)));
    }
  });

  test('download names the file .hfe and serves the original bytes', async ({ page }) => {
    const { orgId } = await signUpFresh(page);
    await uploadHfeThroughUi(page, orgId, 'HFE Download');
    const [d] = await getDb().select({ id: disks.id }).from(disks).where(eq(disks.orgId, orgId));
    const res = await page.request.get(`/api/disks/${d.id}/adf`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain('.hfe');
    expect(Buffer.compare(await res.body(), hfeFixture('clean'))).toBe(0);
  });

  test('a paired device fetches WFMF for an HFE its org owns: computed length, firmware-acceptable', async ({ page, request }) => {
    const { orgId } = await signUpFresh(page);
    const { token } = await pairDevice(page, request);
    await uploadHfeThroughUi(page, orgId, 'HFE Device');
    const [d] = await getDb().select({ sha: disks.sha256 }).from(disks).where(eq(disks.orgId, orgId));
    const res = await request.get(`/api/device/image/${d.sha}`, { headers: authHeader(token) });
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(res.headers()['content-length']).toBe(String(body.length));
    expect(parseLikeFirmware([new Uint8Array(body)]).ok).toBe(true);
  });
});
