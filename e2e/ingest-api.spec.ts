import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { inArray, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, disks } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';

test('check reports an unknown hash as missing', async ({ page, request }) => {
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

test('ingest endpoints reject an anonymous caller', async ({ request }) => {
  const res = await request.post('/api/ingest/check', {
    data: { hashes: ['a'.repeat(64)] },
    maxRedirects: 0,
  });
  expect(res.status()).not.toBe(200);
});

// Presigns and uploads one file for real, straight to Blob (never through a
// function) -- exactly the client flow, so /complete's diskStore.exists()
// check has real bytes to find.
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

  const gameName = `Idempotency Test ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
  const filename = `Shared Game ${Date.now()}-${Math.floor(Math.random() * 1e6)}.adf`;
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
