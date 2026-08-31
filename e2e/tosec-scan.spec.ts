import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { games, disks, blobs, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk, pairDevice } from './device-helpers';
import { seedTosecEntry, trackTosecSet, cleanupTosec } from './tosec-helpers';

test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });

// Every test below calls /api/admin/scan. Part A's importDat() reset is
// deliberately UNSCOPED (it clears match_checked_at on every blob with a
// verdict, not just the ones a given DAT actually touches -- see the
// comment on that reset), so any DAT import ANYWHERE in this suite --
// including admin-scan.spec.ts's own DAT-upload test, running concurrently
// in a different worker (fullyParallel: false only serializes tests WITHIN
// one file, not across files) -- can hand the live database's real ~860+
// blobs back to phase 2 mid-run. sweep()'s own budget is 240s and its
// match phase issues one candidate query per blob rather than batching, so
// a resweep of that size can genuinely run past Playwright's default 30s
// test timeout though it comfortably fits inside sweep()'s own budget.
// Matches the precedent already set by admin-scan.spec.ts's "Run now" test.
const SWEEP_TIMEOUT_MS = 280_000;

/** Give a blob known hashes directly, so the sweeper's match phase can run. */
async function fakeHashes(sha256: string) {
  const sha1 = createHash('sha1').update(sha256).digest('hex');
  await getDb().update(blobs)
    .set({ sha1, md5: null, crc32: null, hashedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
  return sha1;
}

test('a hash match retitles a badly named disk', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
  // Deliberately the badly-named case: "stateart" carries no year, no publisher.
  await seedDisk(user.orgId, { title: 'stateart', diskNo: 1, sha256 });
  const sha1 = await fakeHashes(sha256);

  await seedTosecEntry({
    gameName: 'State of the Art (1992)(Spaceballs)',
    romName: 'State of the Art (1992)(Spaceballs).adf',
    sha1, title: 'State of the Art', sortTitle: 'state of the art',
    year: 1992, publisher: 'Spaceballs',
  });

  await signInAsSuperAdmin(page);
  const res = await page.request.post('/api/admin/scan');
  expect(res.ok()).toBe(true);

  const db = getDb();
  const rows = await db.select().from(games).where(eq(games.orgId, user.orgId));
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe('State of the Art');
  expect(rows[0].year).toBe(1992);
  expect(rows[0].publisher).toBe('Spaceballs');
  expect(rows[0].metadataSource).toBe('tosec');
});

test('two games TOSEC resolves to one are merged, keeping every disk', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const shaA = randomUUID().replace(/-/g, '').padEnd(64, '0');
  const shaB = randomUUID().replace(/-/g, '').padEnd(64, '1');
  await seedDisk(user.orgId, { title: 'turrican2', diskNo: 1, sha256: shaA });
  await seedDisk(user.orgId, { title: 'Turrican II', diskNo: 2, sha256: shaB });

  for (const [sha, diskNo] of [[shaA, 1], [shaB, 2]] as const) {
    const sha1 = await fakeHashes(sha);
    await seedTosecEntry({
      gameName: `Turrican II (1991)(Rainbow Arts)(Disk ${diskNo} of 2)`,
      romName: `Turrican II (1991)(Rainbow Arts)(Disk ${diskNo} of 2).adf`,
      sha1, title: 'Turrican II', sortTitle: 'turrican ii',
      year: 1991, publisher: 'Rainbow Arts', diskNo, diskCount: 2,
    });
  }

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const db = getDb();
  const rows = await db.select().from(games).where(eq(games.orgId, user.orgId));
  expect(rows).toHaveLength(1);
  const kept = await db.select().from(disks).where(eq(disks.gameId, rows[0].id));
  expect(kept).toHaveLength(2);
});

test('a sweep is NEVER observable as an eject', async ({ page, request }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  // The hazard this whole design is shaped around. devices.desiredDiskId has
  // no foreign key and readDesired joins on it; if a sweep re-keyed disks the
  // join would return nothing, and "no disk desired" IS eject.
  const user = await signUpFresh(page);
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '2');
  const { diskId, gameId } = await seedDisk(user.orgId, { title: 'stateart', diskNo: 1, sha256 });
  // pairDevice is the only device-creating helper this repo has: it goes
  // through the real pair + register flow and registers the id for cleanup.
  const device = await pairDevice(page, request, 'Eject canary');

  const db = getDb();
  await db.update(devices).set({
    desiredSha256: sha256, desiredDiskId: diskId, desiredDiskNo: 1, desiredVersion: 7,
  }).where(eq(devices.id, device.deviceId));

  const sha1 = await fakeHashes(sha256);
  // setName MUST differ from "a hash match retitles a badly named disk"
  // above: seedTosecEntry defaults setName to 'e2e-set' and derives its row
  // id from stableId('tosec', setName, romName) alone -- the sha1 plays no
  // part in the id. Reusing that test's identical romName under the same
  // default setName would collide onto the SAME row, and its
  // .onConflictDoNothing() would silently keep whichever entry landed
  // first (that test's sha1, not this one's), making a match here
  // impossible regardless of what sweep()/applyMatch() actually do. Found
  // via the premise assertion below failing deterministically -- in
  // isolation, with no other test or file involved -- until this was fixed.
  await seedTosecEntry({
    setName: 'e2e-set-eject',
    gameName: 'State of the Art (1992)(Spaceballs)',
    romName: 'State of the Art (1992)(Spaceballs).adf',
    sha1, title: 'State of the Art', sortTitle: 'state of the art',
    year: 1992, publisher: 'Spaceballs',
  });

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  // Prove the premise first: the match actually fired and retitled the
  // game. Without this, a sweep()/applyMatch() that silently no-ops on this
  // exact fixture would leave every assertion below trivially true -- the
  // device invariants hold whether or not anything happened at all. This
  // test's whole value is being trustworthy on its own, not borrowing
  // credibility from "a hash match retitles a badly named disk" above.
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  expect(game.title, 'the rename this test depends on must actually have fired').toBe('State of the Art');
  expect(game.metadataSource).toBe('tosec');

  const after = (await db.select().from(devices).where(eq(devices.id, device.deviceId)))[0];
  expect(after.desiredDiskId, 'a sweep must not move desired state').toBe(diskId);
  expect(after.desiredSha256).toBe(sha256);
  expect(after.desiredVersion, 'a sweep must not bump the version').toBe(7);
  // The disk row itself must still exist under the same id.
  expect(await db.select().from(disks).where(eq(disks.id, diskId))).toHaveLength(1);
});

// --- Part A regression: importing a DAT must invalidate every prior verdict ---

test('importing a DAT retroactively matches a blob already decided against no TOSEC data', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '4');
  await seedDisk(user.orgId, { title: 'noimportyet', diskNo: 1, sha256 });
  const sha1 = await fakeHashes(sha256);

  await signInAsSuperAdmin(page);
  // First sweep: tosec_entries is empty (from this test's point of view --
  // no entry anywhere matches this sha1), so the blob is decided 'none'.
  // This mirrors the live database's actual starting state: 860 blobs
  // stamped 'none' against an empty tosec_entries table.
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const db = getDb();
  const before = (await db.select().from(games).where(eq(games.orgId, user.orgId)))[0];
  expect(before.title, 'the premise this test depends on: nothing has matched yet').toBe('noimportyet');

  // Import a DAT THROUGH THE REAL ROUTE -- not seedTosecEntry, which writes
  // tosec_entries directly and would never exercise importDat()'s reset.
  // setName must be distinct from every other test's: stableId('tosec',
  // setName, romName) collides across a shared setName, silently keeping
  // whichever entry landed first (see the eject test's comment above).
  const setName = 'e2e-part-a-set';
  trackTosecSet(setName);
  const dat = `clrmamepro (
\tname "${setName}"
\tdescription "${setName}"
\tversion 2026-01-01
)

game (
\tname "Dat Import Redux (1993)(Test Co)"
\tdescription "Dat Import Redux (1993)(Test Co)"
\trom ( name "Dat Import Redux (1993)(Test Co).adf" size 901120 sha1 ${sha1} )
)
`;
  const importRes = await page.request.post('/api/admin/tosec', {
    headers: { 'content-type': 'text/plain' },
    data: dat,
  });
  expect(importRes.ok(), await importRes.text()).toBe(true);
  expect((await importRes.json()).imported).toBe(1);

  // Second sweep: without Part A, match_checked_at is already set from the
  // first sweep and this blob is skipped forever -- the newly imported
  // entry, which genuinely matches, would never be considered and the title
  // would stay 'noimportyet'.
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const after = (await db.select().from(games).where(eq(games.orgId, user.orgId)))[0];
  expect(after.title).toBe('Dat Import Redux');
  expect(after.metadataSource).toBe('tosec');
});

// --- Part B regression: ingesting a disk must let an already-matched blob re-apply ---

test('a disk landed after its blob was already matched still gets retitled', async ({ page }) => {
  test.setTimeout(SWEEP_TIMEOUT_MS);
  const user = await signUpFresh(page);

  const content = Buffer.from(`part-b-${Date.now()}-${Math.random()}`);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const sizeBytes = content.length;

  // Real bytes, genuinely uploaded: the SECOND /complete call below is a
  // dedup hit, and verify()'s dedup path only ever stat()s the store -- it
  // never re-reads -- so it only succeeds against bytes that are really
  // there.
  const presign = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes }] },
  });
  const { uploads } = await presign.json();
  const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  expect(put.ok).toBe(true);

  // First /complete call: "[cr].adf" parses to an EMPTY title (nothing but
  // a bracket clause), so /complete's skippedTitle path registers the blob
  // and its entitlement for real -- verify() reads the bytes and records
  // genuine crc32/md5/sha1 -- but deliberately creates no game or disk. This
  // is "a blob... with no disk" using the real ingest path rather than a
  // direct DB write, so it exercises the exact route Part B's fix lives in.
  const first = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes, filename: '[cr].adf' }] },
  });
  expect(first.status(), await first.text()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.disks).toBe(0);
  expect(firstBody.skippedTitle).toEqual([sha256]);

  const sha1 = createHash('sha1').update(content).digest('hex');
  const setName = 'e2e-part-b-set';
  trackTosecSet(setName);
  await seedTosecEntry({
    setName,
    gameName: 'Cross-Org Redux (1994)(ReTest)',
    romName: 'Cross-Org Redux (1994)(ReTest).adf',
    sha1, title: 'Cross-Org Redux', sortTitle: 'cross-org redux',
    year: 1994, publisher: 'ReTest',
  });

  await signInAsSuperAdmin(page);
  // First sweep: the blob IS matched (a genuine candidate exists), but
  // there is no disk anywhere for applyMatch to rewrite -- "matched against
  // nothing".
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const db = getDb();
  const decided = (await db.select().from(blobs).where(eq(blobs.sha256, sha256)))[0];
  expect(decided.matchState, 'the premise this test depends on: the blob must actually match').toBe('matched');

  // Second /complete call, same sha256 -- a dedup hit -- with a real,
  // badly-named filename this time. This is the upload that finally lands
  // a disk for these already-decided bytes, exactly the operator's actual
  // sequence: import DATs, run the scan, THEN upload ADFs.
  const filename = `Badly Named Upload ${Date.now()}.adf`;
  const second = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes, filename }] },
  });
  expect(second.status(), await second.text()).toBe(200);

  const disk = (await db.select().from(disks).where(eq(disks.sha256, sha256)))[0];
  expect(disk, 'the disk this test depends on must have landed').toBeTruthy();
  const seeded = (await db.select().from(games).where(eq(games.id, disk.gameId)))[0];
  expect(seeded.title, 'the premise: freshly landed, still filename-derived').not.toBe('Cross-Org Redux');

  try {
    // Second sweep: without Part B, match_checked_at was already set by the
    // first sweep and this blob is skipped forever -- the game landed by
    // the second /complete call would stay badly named.
    expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

    const after = (await db.select().from(games).where(eq(games.id, disk.gameId)))[0];
    expect(after.title).toBe('Cross-Org Redux');
    expect(after.metadataSource).toBe('tosec');
  } finally {
    // This test bypasses seedDisk/cleanupSeeded by going through the real
    // ingest route, so it cleans up after itself in FK order.
    await db.delete(disks).where(eq(disks.sha256, sha256));
    await db.delete(games).where(eq(games.id, disk.gameId));
    await db.delete(entitlements).where(eq(entitlements.sha256, sha256));
    await db.delete(blobs).where(eq(blobs.sha256, sha256));
  }
});
