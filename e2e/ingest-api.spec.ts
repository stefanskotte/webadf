import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { inArray, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, disks } from '@/db/schema/catalog';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded } from './device-helpers';

// These specs create their rows through the REAL ingest flow, so no helper
// ever learns their ids -- cleanupSeeded reaches them by purging the whole
// catalog of every org signUpFresh made in this file (see purgeSignedUpOrgs).

test.afterAll(cleanupSeeded);

test('check reports an unknown hash as missing', async ({ page }) => {
  await signUpFresh(page); // seeds the session cookie into the context

  const sha = createHash('sha256').update(`unique-${Date.now()}`).digest('hex');
  const res = await page.request.post('/api/ingest/check', { data: { hashes: [sha] } });

  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ known: [], missing: [sha] });
});

test('check rejects a malformed hash with 400', async ({ page }) => {
  await signUpFresh(page);
  const res = await page.request.post('/api/ingest/check', { data: { hashes: ['nope'] } });
  expect(res.status()).toBe(400);
});

// Named "endpoints" but only ever called /check, and asserted
// `not.toBe(200)` -- which a 500 satisfies just as happily as a redirect. Now
// it covers all three routes and asserts the status they are actually
// supposed to return.
test('ingest endpoints reject an anonymous caller', async ({ request }) => {
  const sha = 'a'.repeat(64);
  const routes: Array<[string, unknown]> = [
    ['/api/ingest/check', { hashes: [sha] }],
    ['/api/ingest/presign', { files: [{ sha256: sha, sizeBytes: 901_120 }] }],
    ['/api/ingest/complete', { files: [{ sha256: sha, sizeBytes: 901_120, filename: 'x.adf' }] }],
  ];

  for (const [path, data] of routes) {
    const res = await request.post(path, { data, maxRedirects: 0 });
    // requireOrg() redirects an unauthenticated caller; Next answers a route
    // handler redirect with 307 and a Location header. Asserting the exact
    // status means a 500 (an unhandled crash before the auth check) fails
    // this test instead of passing it.
    expect(res.status(), `${path} must redirect an anonymous caller`).toBe(307);
    expect(res.headers()['location'], `${path} must redirect to sign-in`).toContain('/sign-in');
  }
});

// Presigns and uploads one file for real, straight to Blob (never through a
// function) -- exactly the client flow, so /complete's verification has real
// bytes to stat, read back and hash.
async function uploadDisk(page: Page, content: Buffer) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presignRes = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: content.length }] },
  });
  const { uploads } = await presignRes.json();
  const putRes = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  if (!putRes.ok) throw new Error(`test setup: blob PUT failed with ${putRes.status}`);
  return { sha256, sizeBytes: content.length };
}

test('completing the same payload twice creates exactly one game and N disks', async ({ page }) => {
  await signUpFresh(page);

  // Suffix must not end in "-<digits>": parseTosecName strips a trailing -N
  // (1..99) as a disk number, so a random draw of 1-99 would silently rewrite
  // the title and the locator would miss. runTag() cannot parse as one.
  const gameName = `Idempotency Test ${runTag()}`;
  const disk1 = await uploadDisk(page, Buffer.from(`disk1-${Date.now()}-${Math.random()}`));
  const disk2 = await uploadDisk(page, Buffer.from(`disk2-${Date.now()}-${Math.random()}`));

  const files = [
    { ...disk1, filename: `${gameName} (Disk 1 of 2).adf` },
    { ...disk2, filename: `${gameName} (Disk 2 of 2).adf` },
  ];

  const first = await page.request.post('/api/ingest/complete', { data: { files } });
  expect(first.status()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.created).toBe(1);
  expect(firstBody.disks).toBe(2);
  expect(firstBody.rejected).toEqual([]);

  // Retry with the IDENTICAL payload -- exactly what the Task 9 CLI does
  // when a batch call errors or times out after the writes already landed.
  const second = await page.request.post('/api/ingest/complete', { data: { files } });
  expect(second.status()).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.rejected).toEqual([]);

  // The assertion that matters: query the real rows, not the response.
  const db = getDb();
  const diskRows = await db.select().from(disks)
    .where(inArray(disks.sha256, [disk1.sha256, disk2.sha256]));

  expect(diskRows).toHaveLength(2); // not 4 -- the retry did not duplicate
  const gameIds = new Set(diskRows.map((d) => d.gameId));
  expect(gameIds.size).toBe(1); // both disks belong to exactly one game
});

test('two organizations uploading the same file each get their own game, sharing one blobs row', async ({ browser }) => {
  const context1 = await browser.newContext();
  const context2 = await browser.newContext();
  const page1 = await context1.newPage();
  const page2 = await context2.newPage();

  const { orgId: org1 } = await signUpFresh(page1);
  const { orgId: org2 } = await signUpFresh(page2);
  expect(org1).not.toBe(org2);

  const content = Buffer.from(`shared-disk-${Date.now()}-${Math.random()}`);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const filename = `Shared Game ${runTag()}.adf`;
  const sizeBytes = content.length;

  // Org 1 does the full presign -> upload -> complete round trip.
  const presign1 = await page1.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes }] },
  });
  const { uploads } = await presign1.json();
  const put1 = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  expect(put1.ok).toBe(true);

  const complete1 = await page1.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes, filename }] },
  });
  expect(complete1.status()).toBe(200);

  // Org 2 uploads the identical bytes. /check must report it as already
  // known -- cross-tenant dedupe on the global blobs table -- so org 2
  // never needs to presign or re-upload, only to register its own
  // entitlement and game.
  const check2 = await page2.request.post('/api/ingest/check', { data: { hashes: [sha256] } });
  expect(await check2.json()).toEqual({ known: [sha256], missing: [] });

  const complete2 = await page2.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes, filename }] },
  });
  expect(complete2.status()).toBe(200);
  const body2 = await complete2.json();
  expect(body2.rejected).toEqual([]);

  // The property this whole design rests on: one blobs row, but the
  // catalog rows are never shared across tenants.
  const db = getDb();
  const blobRows = await db.select().from(blobs).where(eq(blobs.sha256, sha256));
  expect(blobRows).toHaveLength(1);

  const diskRows = await db.select().from(disks).where(eq(disks.sha256, sha256));
  expect(diskRows).toHaveLength(2); // one disk row per tenant

  const gameIds = new Set(diskRows.map((d) => d.gameId));
  expect(gameIds.size).toBe(2); // each tenant's disk points at its own game

  const orgIds = new Set(diskRows.map((d) => d.orgId));
  expect(orgIds).toEqual(new Set([org1, org2])); // never merged across tenants

  await context1.close();
  await context2.close();
});


// --- Content addressing (whole-branch review C1) ---------------------------
//
// Before these fixes, /complete called diskStore.exists() -- head() collapsed
// to a boolean, with the size it had just fetched thrown away -- and wrote a
// blobs row for whatever the client said was there. A PUT of mismatched bytes
// under a claimed hash was accepted with a 200, and the key was then
// permanently unwritable (allowOverwrite: false), so the legitimate owner of
// those bytes could never store them.

test('complete rejects a size that does not match the stored bytes', async ({ page }) => {
  await signUpFresh(page);

  const content = Buffer.from(`size-claim-${Date.now()}-${Math.random()}`);
  const { sha256, sizeBytes } = await uploadDisk(page, content);
  const filename = `Size Claim ${runTag()}.adf`;

  // Same real bytes, a lie about how many there are.
  const bad = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: sizeBytes + 1, filename }] },
  });
  expect(bad.status()).toBe(409); // nothing landed
  const badBody = await bad.json();
  expect(badBody.rejected).toEqual([sha256]);
  expect(badBody.rejectedReasons[sha256]).toBe('size-mismatch');

  // The row that must NOT have been written.
  const db = getDb();
  expect(await db.select().from(blobs).where(eq(blobs.sha256, sha256))).toHaveLength(0);

  // The bytes are authentic, just wrongly described, so they were kept rather
  // than deleted: describing them correctly now succeeds without re-uploading.
  const good = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes, filename }] },
  });
  expect(good.status()).toBe(200);
  expect((await good.json()).rejected).toEqual([]);

  const rows = await db.select().from(blobs).where(eq(blobs.sha256, sha256));
  expect(rows).toHaveLength(1);
  expect(rows[0].sizeBytes).toBe(sizeBytes); // the store's size, not a claim
  // gzip_size_bytes is recorded at ingest (Spec) so the compression decision
  // can be revisited with data. It was never written before this pass.
  expect(rows[0].gzipSizeBytes).not.toBeNull();
  expect(rows[0].gzipSizeBytes).toBeGreaterThan(0);
});

test('complete rejects bytes that do not hash to the key they were stored under, and frees the key', async ({ page }) => {
  await signUpFresh(page);

  const real = Buffer.from(`authentic-${Date.now()}-${Math.random()}`);
  const sha256 = createHash('sha256').update(real).digest('hex');
  // Different content, SAME length -- so a size-only check would wave it
  // through and only the digest can catch it.
  const impostor = Buffer.alloc(real.length, 0x41);
  expect(createHash('sha256').update(impostor).digest('hex')).not.toBe(sha256);

  const filename = `Poisoned ${runTag()}.adf`;

  // Claim the hash, upload something else. The store accepts this: it does no
  // content addressing of its own.
  const presign = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: impostor.length }] },
  });
  const { uploads } = await presign.json();
  const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(impostor) });
  expect(put.status).toBe(200);

  const res = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: impostor.length, filename }] },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.rejected).toEqual([sha256]);
  expect(body.rejectedReasons[sha256]).toBe('digest-mismatch');

  const db = getDb();
  expect(await db.select().from(blobs).where(eq(blobs.sha256, sha256))).toHaveLength(0);

  // The second half of the finding: the key must not stay wedged. Rejected
  // content is deleted, so the real owner of these bytes can still store
  // them. Before the fix this PUT answered 400 "This blob already exists"
  // forever.
  const presign2 = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: real.length }] },
  });
  const { uploads: uploads2 } = await presign2.json();
  const put2 = await fetch(uploads2[0].url, { method: 'PUT', body: new Uint8Array(real) });
  expect(put2.status, 'the poisoned key must have been freed').toBe(200);

  const ok = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: real.length, filename }] },
  });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).rejected).toEqual([]);
});

test('complete rejects a hash whose bytes were never stored', async ({ page }) => {
  await signUpFresh(page);
  const sha256 = createHash('sha256').update(`never-uploaded-${Date.now()}`).digest('hex');

  const res = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: 4096, filename: `Ghost ${runTag()}.adf` }] },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.rejected).toEqual([sha256]);
  expect(body.rejectedReasons[sha256]).toBe('not-stored');
});
