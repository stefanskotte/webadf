import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, blobs, games } from '@/db/schema/catalog';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function anyRealAdf(): Buffer {
  const dir = 'adf-archive';
  const name = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.adf'));
  if (!name) throw new Error('no ADF in adf-archive/ — this spec needs one');
  return readFileSync(`${dir}/${name}`);
}

// Copied from e2e/ingest-api.spec.ts rather than reinvented — presigns and
// uploads one file for real, straight to Blob (never through a function), so
// /complete's verification (and this spec's GET) has real bytes to work with.
//
// Deviation from the original: ingest-api.spec.ts always uploads randomized
// throwaway content, so its sha256 is always new. This spec needs a genuine
// Amiga ADF (encodeDisk rejects arbitrary bytes), and adf-archive/ content is
// fixed, so its sha256 is the same on every run against the same real Blob
// store, and the blob it names may already exist from an earlier run (it
// does — a `blobs` row for adf-archive's first file already existed before
// this spec was ever written). diskStore.uploadUrl signs with
// allowOverwrite:false, so a re-PUT of an already-stored key 400s. A real
// client would call /check first and skip uploading what is already known;
// this helper now does the same, which is the genuine flow /check exists
// for, not a workaround. It also reports whether IT was the one that created
// the blobs row, so the caller can decide whether cleanup owns it.
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

// Behaviours 1 and 3 both drive the genuine ingest flow: /api/ingest/complete
// inserts games/disks/entitlements rows that device-helpers.ts's
// cleanupSeeded never learns about (it only tracks what
// seedDisk/addDisk/pairDevice insert), so this spec must be able to remove
// them itself. Behaviour 3 (cross-tenant) needs real bytes in Blob -- not
// seedDisk's fabricated storage_key -- so that a broken entitlement check
// would actually be caught handing back org A's real disk, not merely some
// non-404 status.
const ingestCleanup = {
  orgShaPairs: [] as Array<{ orgId: string; sha256: string }>,
  ownedBlobShas: [] as string[],
};

async function cleanupIngest(): Promise<void> {
  const db = getDb();
  try {
    for (const { orgId, sha256 } of ingestCleanup.orgShaPairs) {
      await db.delete(disks).where(and(eq(disks.orgId, orgId), eq(disks.sha256, sha256)));
      await db.delete(entitlements).where(and(eq(entitlements.orgId, orgId), eq(entitlements.sha256, sha256)));
      // Each of these orgs is freshly signed up and ingested exactly one
      // file, so the game this disk belonged to has no other disk left once
      // the row above is gone — safe to delete unconditionally by orgId.
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

test.afterAll(cleanupSeeded);
test.afterAll(cleanupIngest);

test('a device fetches a disk its org owns', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);

  const adf = anyRealAdf();
  const { sha256, sizeBytes, createdBlob } = await uploadDisk(page, adf);
  const filename = `Device Image Test ${randomUUID()}.adf`;
  const complete = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes, filename }] },
  });
  expect(complete.status()).toBe(200);
  ingestCleanup.orgShaPairs.push({ orgId, sha256 });
  if (createdBlob) ingestCleanup.ownedBlobShas.push(sha256);

  const res = await request.get(`/api/device/image/${sha256}`, { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/octet-stream');

  const body = await res.body();
  expect(body.length).toBe(2_027_536);
  expect([body[0], body[1], body[2], body[3]]).toEqual([0x57, 0x46, 0x4d, 0x46]); // 'WFMF'
});

test('a digest the org does not hold is a 404, not a 403 and not a 500', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);

  const unclaimed = sha(`unclaimed-${randomUUID()}`);
  const res = await request.get(`/api/device/image/${unclaimed}`, { headers: authHeader(token) });
  expect(res.status()).toBe(404);
});

test('cross-tenant: org B cannot fetch org A\'s actual disk bytes', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const { orgId: orgA } = await signUpFresh(pageA);
  await signUpFresh(pageB);
  const { token: tokenB } = await pairDevice(pageB, contextB.request);

  // Genuine ingest flow, same as behaviour 1 -- real bytes really do land in
  // Blob under org A's entitlement. A test that only checked the status code
  // against a seedDisk-fabricated (byte-less) blob could pass for the wrong
  // reason: diskStore.read() throwing on missing bytes looks identical, from
  // the status code alone, to the entitlement check correctly rejecting the
  // request. Only real bytes behind the digest can distinguish "the check
  // fired" from "the check fired AND no bytes came back."
  const adf = anyRealAdf();
  const { sha256, sizeBytes, createdBlob } = await uploadDisk(pageA, adf);
  const filename = `Cross Tenant Test ${randomUUID()}.adf`;
  const complete = await pageA.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes, filename }] },
  });
  expect(complete.status()).toBe(200);
  ingestCleanup.orgShaPairs.push({ orgId: orgA, sha256 });
  if (createdBlob) ingestCleanup.ownedBlobShas.push(sha256);

  // The assertion that matters: org B's device, org A's disk.
  const res = await contextB.request.get(`/api/device/image/${sha256}`, { headers: authHeader(tokenB) });
  expect(res.status()).toBe(404);
  // Belt and braces: prove no WFMF container leaked even if a future
  // refactor changed the status code out from under the first assertion.
  // The status proves the check fired; the length proves no bytes leaked.
  const body = await res.body();
  expect(body.length).not.toBe(2_027_536);

  await contextA.close();
  await contextB.close();
});

test('a malformed digest is a 400', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);

  const bad = [
    'not-a-digest',
    'a'.repeat(63),
    'A'.repeat(64), // uppercase hex — the route requires lowercase
  ];
  for (const digest of bad) {
    const res = await request.get(`/api/device/image/${digest}`, { headers: authHeader(token) });
    expect(res.status(), digest).toBe(400);
  }
});

test('bad credentials are a 401', async ({ request }) => {
  const digest = 'a'.repeat(64);
  const cases: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['malformed header', { Authorization: 'Basic abc' }],
    ['unknown token', authHeader(`wadf_${randomUUID()}`)],
  ];
  for (const [label, headers] of cases) {
    const res = await request.get(`/api/device/image/${digest}`, { headers });
    expect(res.status(), label).toBe(401);
  }
});
