import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, notInArray } from 'drizzle-orm';
import type { Page, APIRequestContext } from '@playwright/test';
import { getDb } from '@/db';
import { blobs, disks, games, entitlements } from '@/db/schema/catalog';
import { devices, pairingCodes } from '@/db/schema/devices';
import { diskVersions } from '@/db/schema/disk-history';
import { firmwareReleases } from '@/db/schema/firmware';
import { collections } from '@/db/schema/collections';
import { organization, member, user } from '@/db/schema/auth';
import { diskStore } from '@/lib/storage';
import { signedUpOrgIds } from './helpers';   // also a side effect: loads .env.local before @/db is used

// Playwright runs one module instance per spec file with fullyParallel: false,
// so module-level state is per-file and cleanupSeeded() in an afterAll removes
// exactly what that file made.
const seeded = {
  gameIds: [] as string[],
  diskIds: [] as string[],
  shas: [] as string[],
  deviceIds: [] as string[],
  // Not in the original brief's registry list, but pairDevice inserts a row
  // here on every call (register/route.ts consumes it) and the brief's own
  // scope line ("games, disks, entitlements, blobs, devices and pairing
  // codes") names it explicitly. Tracked and deleted the same way as the
  // rest so the scope statement and the code agree.
  pairingCodes: [] as string[],
};

/** Pair a device against the signed-in page's org and return its bearer token. */
export async function pairDevice(page: Page, request: APIRequestContext, name = 'Test Device') {
  const pair = await page.request.post('/api/devices/pair', { data: { name } });
  if (pair.status() !== 200) throw new Error(`pair failed: ${pair.status()}`);
  const { code } = await pair.json();
  seeded.pairingCodes.push(code);

  // A bare request context, not the page's — the device has no session.
  const mac = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '3.0.0', macAddress: mac },
  });
  if (reg.status() !== 200) throw new Error(`register failed: ${reg.status()}`);
  const { token, deviceId } = await reg.json();
  seeded.deviceIds.push(deviceId as string);
  return { deviceId: deviceId as string, token: token as string };
}

/**
 * Insert one game + disk + blob + entitlement directly. Faster than the real
 * ingest flow and enough for protocol tests, which are not about ingest.
 */
export async function seedDisk(
  orgId: string,
  // sizeBytes defaults to a standard 901,120-byte DD image. Callers proving
  // F-1 (an unencodable disk must not become mountable) pass a smaller value
  // — the blob is sized to match, same as a real truncated ingest would be.
  opts: { title: string; diskNo: number; sha256: string; sizeBytes?: number },
) {
  const db = getDb();
  const gameId = `gam_${randomUUID()}`;
  const diskId = randomUUID();
  const sizeBytes = opts.sizeBytes ?? 901120;

  await db.insert(blobs).values({
    sha256: opts.sha256, sizeBytes, storageKey: `adf/${opts.sha256}`,
  }).onConflictDoNothing();

  // games has NO diskCount column — it is derived. sortTitle IS NOT NULL.
  // metadataSource must mirror what /api/ingest/complete writes for a
  // freshly-created game ('filename') -- applyMatch (tosec-apply.ts) only
  // ever retitles a game whose metadataSource is exactly 'filename', by
  // design: an unrecognized value (including NULL) is treated as a human
  // edit and left alone. A seeded game with NULL here is a row shape the
  // real app never produces (every real games row has metadataSource set),
  // and silently makes it impossible for any TOSEC match to correct it.
  await db.insert(games).values({
    id: gameId, orgId, title: opts.title, sortTitle: opts.title.toLowerCase(),
    metadataSource: 'filename',
  });

  await db.insert(disks).values({
    id: diskId, gameId, orgId, diskNo: opts.diskNo, sha256: opts.sha256,
    label: `${opts.title} (Disk ${opts.diskNo})`, sizeBytes,
  });

  await db.insert(entitlements).values({
    orgId, sha256: opts.sha256, sourceFilename: `${opts.title}-${opts.diskNo}.adf`,
  }).onConflictDoNothing();

  seeded.shas.push(opts.sha256);
  seeded.gameIds.push(gameId);
  seeded.diskIds.push(diskId);

  return { gameId, diskId };
}

/**
 * Add a second disk to an EXISTING game. Used to exercise multi-disk games
 * and, deliberately, to create two disks rows sharing the same (gameId,
 * diskNo) -- e.g. a corrected re-ingest of the same physical disk under the
 * same disk number. That triple is not unique in the schema (only disks.id
 * is), so tests that mount one of two such rows can prove readDesired
 * resolves to the exact row mounted rather than an arbitrary one.
 */
export async function addDisk(
  orgId: string,
  gameId: string,
  opts: { diskNo: number; sha256: string; label?: string; writeProtected?: boolean },
) {
  const db = getDb();
  const diskId = randomUUID();

  await db.insert(blobs).values({
    sha256: opts.sha256, sizeBytes: 901120, storageKey: `adf/${opts.sha256}`,
  }).onConflictDoNothing();

  await db.insert(disks).values({
    id: diskId, gameId, orgId, diskNo: opts.diskNo, sha256: opts.sha256,
    label: opts.label ?? `Disk ${opts.diskNo}`, sizeBytes: 901120,
    ...(opts.writeProtected !== undefined ? { writeProtected: opts.writeProtected } : {}),
  });

  await db.insert(entitlements).values({
    orgId, sha256: opts.sha256, sourceFilename: `disk-${opts.diskNo}-${opts.sha256}.adf`,
  }).onConflictDoNothing();

  seeded.shas.push(opts.sha256);
  seeded.diskIds.push(diskId);

  return { diskId };
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Remove the delta blobs (disk_versions.kind = 'delta') belonging to
 * `diskIds`, but only the ones no disk_versions row OUTSIDE that set still
 * names -- the same "only what nothing else references" rule
 * purgeSignedUpOrgs below already applies to ordinary blobs.
 *
 * A delta encodes only sector indices and changed bytes, never its base disk
 * (src/lib/disk-history/delta.ts), so the SAME edit applied to two different
 * disks produces the SAME content-addressed sha. Deleting every delta sha
 * found on `diskIds` without checking every OTHER disk's history first could
 * delete bytes a disk outside this cleanup's scope still needs.
 *
 * MUST be called before the caller deletes `diskIds` from `disks` -- once
 * those rows are gone, disk_versions cascades away with them (see
 * src/db/schema/disk-history.ts) and this query would have nothing left to
 * find, or to check against. This is exactly the bug fixed here: cleanupSeeded
 * and purgeSignedUpOrgs both used to delete `disks` (and, transitively, its
 * disk_versions rows) with no chance for anything to reclaim the delta
 * objects those rows were the only record of -- so every run leaked them,
 * silently, into the live blob store.
 *
 * Returns the number of blob-store objects ACTUALLY removed, not the number
 * of candidates, so a caller can log a truthful count.
 */
export async function reclaimDeltaBlobs(diskIds: string[]): Promise<number> {
  if (diskIds.length === 0) return 0;
  const db = getDb();

  const candidates = await db.selectDistinct({ sha: diskVersions.blobSha256 })
    .from(diskVersions)
    .where(and(eq(diskVersions.kind, 'delta'), inArray(diskVersions.diskId, diskIds)));
  if (candidates.length === 0) return 0;

  const shas = candidates.map((c) => c.sha);
  // Any OTHER disk -- test or real, in or out of this run -- whose history
  // still names one of these shas. Not scoped to kind = 'delta': the only
  // fact that matters is whether the exact bytes at this sha are still
  // referenced from anywhere outside `diskIds`.
  const stillNamed = await db.selectDistinct({ sha: diskVersions.blobSha256 })
    .from(diskVersions)
    .where(and(inArray(diskVersions.blobSha256, shas), notInArray(diskVersions.diskId, diskIds)));
  const keep = new Set(stillNamed.map((r) => r.sha));

  let removed = 0;
  for (const sha256 of shas) {
    if (keep.has(sha256)) continue;
    try { await diskStore.remove(sha256); removed++; } catch { /* never uploaded, or already gone */ }
  }
  // Visible, not silent: this is per-spec, best-effort cleanup with no other
  // reporting path, and the whole point of this helper is that a delta blob
  // must be reclaimed HERE, before the caller's disks delete takes the only
  // disk_versions record of it with it. A silent no-op would look identical
  // to a real reclaim from the outside.
  if (removed > 0) console.log(`reclaimDeltaBlobs: removed ${removed} of ${shas.length} candidate delta blob(s)`);
  return removed;
}

/**
 * Remove the whole catalog of every org signUpFresh created in this spec file.
 *
 * This is the half `seeded` above cannot cover. Four specs -- ingest-api,
 * ingest-ui, library, and parts of tosec-scan/device-image/device-protocol --
 * create their rows through the REAL ingest flow (presign -> PUT -> complete),
 * so the application writes them and no helper ever learns their ids. Before
 * this, those rows survived until global-teardown swept the whole run, which
 * worked but left the guarantee resting on one mechanism: a teardown that is
 * deliberately best-effort and never fails a run.
 *
 * THE SAFETY BOUNDARY IS THE EMAIL DOMAIN, exactly as in e2e/global-teardown.ts,
 * and it is enforced here in SQL rather than assumed: an org is purged only if
 * it has at least one member and EVERY member is @example.test. An org id that
 * somehow reached this list without being a test org -- the operator's own --
 * is skipped rather than trusted. Nothing here may ever widen that predicate.
 *
 * The auth schema is untouched: users and organizations are better-auth's, and
 * global-teardown is still what removes them.
 */
async function purgeSignedUpOrgs(): Promise<void> {
  const orgIds = signedUpOrgIds.splice(0);
  if (orgIds.length === 0) return;
  const db = getDb();

  // Every member of every candidate org, so the predicate below is decided
  // from data rather than from the id looking test-shaped. Bound parameters
  // throughout -- an org id is a value, never spliced into SQL text.
  const members = await db
    .select({ orgId: member.organizationId, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(inArray(member.organizationId, orgIds));

  const seen = new Set<string>();
  const tainted = new Set<string>();
  for (const m of members) {
    seen.add(m.orgId);
    if (!m.email.endsWith('@example.test')) tainted.add(m.orgId);
  }
  // At least one member, and not one of them outside the test domain.
  const purgeable = [...seen].filter((id) => !tainted.has(id));
  if (purgeable.length === 0) return;

  // Collect the shas AND disk ids BEFORE the rows go -- afterwards there is
  // no way back to them, and an object left in storage with no row is an
  // invisible leak.
  const shas = new Set<string>();
  const diskIds: string[] = [];
  for (const r of await db.select({ id: disks.id, sha256: disks.sha256 }).from(disks).where(inArray(disks.orgId, purgeable))) {
    shas.add(r.sha256);
    diskIds.push(r.id);
  }
  for (const r of await db.select({ sha256: entitlements.sha256 }).from(entitlements).where(inArray(entitlements.orgId, purgeable))) {
    shas.add(r.sha256);
  }

  // Delta blobs, before the disks delete below cascades their disk_versions
  // rows away and takes with it the only record of where they live.
  await reclaimDeltaBlobs(diskIds);

  // collection_games follows by cascade from collections.id, and again from
  // games.id -- but the collections rows themselves are reachable only here.
  await db.delete(collections).where(inArray(collections.orgId, purgeable));
  await db.delete(disks).where(inArray(disks.orgId, purgeable));
  await db.delete(entitlements).where(inArray(entitlements.orgId, purgeable));
  await db.delete(games).where(inArray(games.orgId, purgeable));

  if (shas.size === 0) return;

  // A blob is GLOBAL and content-addressed: the same bytes can be shared with
  // another tenant, including the operator's real library, and dropping one
  // still referenced would corrupt them. Only what NOTHING references now.
  const all = [...shas];
  const stillUsed = new Set<string>([
    ...(await db.select({ sha256: disks.sha256 }).from(disks).where(inArray(disks.sha256, all))).map((r) => r.sha256),
    ...(await db.select({ sha256: entitlements.sha256 }).from(entitlements).where(inArray(entitlements.sha256, all))).map((r) => r.sha256),
    // Any disk's history, as a version's blob or its image: an earlier version
    // a surviving disk still needs to rebuild.
    ...(await db.select({ sha256: diskVersions.blobSha256 }).from(diskVersions).where(inArray(diskVersions.blobSha256, all))).map((r) => r.sha256),
    ...(await db.select({ sha256: diskVersions.imageSha256 }).from(diskVersions).where(inArray(diskVersions.imageSha256, all))).map((r) => r.sha256),
  ]);
  const orphaned = all.filter((sha) => !stillUsed.has(sha));
  if (orphaned.length === 0) return;

  // Bytes first, then the row. A removed object with a surviving row is
  // recoverable and visible; a deleted row whose object survives is not,
  // because the sha is the only handle anything has on it.
  for (const sha256 of orphaned) {
    try { await diskStore.remove(sha256); } catch { /* often never PUT at all */ }
  }
  await db.delete(blobs).where(inArray(blobs.sha256, orphaned));
}

/**
 * Remove everything this spec file seeded, in foreign-key order.
 *
 * disks and entitlements both reference blobs.sha256, so blobs go last.
 * Never touches the auth schema: signUpFresh's users and organizations are
 * better-auth's to manage and are left in place.
 *
 * Best-effort — a failure here must not fail a passing spec, because the rows
 * are inert either way and a cleanup error would mask a real result.
 */
export async function cleanupSeeded(): Promise<void> {
  const db = getDb();
  try {
    if (seeded.deviceIds.length) {
      await db.delete(devices).where(inArray(devices.id, seeded.deviceIds));
    }
    if (seeded.pairingCodes.length) {
      await db.delete(pairingCodes).where(inArray(pairingCodes.code, seeded.pairingCodes));
    }
    if (seeded.diskIds.length) {
      // Before the delete below cascades disk_versions away and takes the
      // only record of any delta blobs with it.
      await reclaimDeltaBlobs(seeded.diskIds);
      await db.delete(disks).where(inArray(disks.id, seeded.diskIds));
    }
    if (seeded.shas.length) {
      await db.delete(entitlements).where(inArray(entitlements.sha256, seeded.shas));
    }
    if (seeded.gameIds.length) {
      await db.delete(games).where(inArray(games.id, seeded.gameIds));
    }
    if (seeded.shas.length) {
      await db.delete(blobs).where(inArray(blobs.sha256, seeded.shas));
    }
    // The rows this file created through the REAL ingest flow, which no
    // helper ever saw the ids of. Runs last: it reclaims blobs by asking what
    // is still referenced, and the deletes above change that answer.
    await purgeSignedUpOrgs();
  } catch (e) {
    console.warn('cleanupSeeded: best effort, continuing —', (e as Error).message);
  } finally {
    seeded.gameIds.length = 0;
    seeded.diskIds.length = 0;
    seeded.shas.length = 0;
    seeded.deviceIds.length = 0;
    seeded.pairingCodes.length = 0;
    signedUpOrgIds.length = 0;
  }
}

// --- firmware releases -------------------------------------------------
//
// firmware_releases is GLOBAL, not org-scoped, so the @example.test email
// boundary that protects everything else in this suite does NOT cover it.
// The version prefix is the only guard, and it is applied on both sides:
// publishTestRelease refuses to write anything without it, and
// cleanupTestReleases deletes by exactly it. Widening either is how the
// operator's real registry -- the one the Devices tab compares every board
// against -- would start accumulating rows from a test run.

/** Every release this suite publishes carries this prefix. Nothing else may use it. */
export const E2E_RELEASE_PREFIX = '0.0.0-e2e';

/**
 * Inserted directly rather than through publishRelease(), for two reasons:
 * the publish rules refuse a semver below the current maximum (so a suite
 * publishing real-looking versions would be ordered against whatever the
 * operator last shipped), and they require version to start with `semver+`
 * (which a prefixed test version deliberately does not).
 */
export async function publishTestRelease(
  version: string,
  opts: { security?: boolean; notes?: string } = {},
): Promise<void> {
  if (!version.startsWith(E2E_RELEASE_PREFIX)) {
    throw new Error(`e2e releases must start with ${E2E_RELEASE_PREFIX}, got ${version}`);
  }
  const db = getDb();
  // max+1 across the WHOLE table, so a seeded release is always newest.
  //
  // That is what makes the specs deterministic AND what makes them visible:
  // while these rows exist, they are the newest release production compares
  // every real board against. The window is bounded by cleanupTestReleases in
  // each spec's afterAll -- not only by the global teardown, which runs once
  // at the very end of a multi-minute suite.
  const rows = await db.select({ sequence: firmwareReleases.sequence }).from(firmwareReleases);
  const sequence = rows.reduce((m, r) => (r.sequence > m ? r.sequence : m), 0) + 1;
  await db.insert(firmwareReleases).values({
    id: randomUUID(),
    version,
    semver: '0.0.0',
    sequence,
    sha256: 'e'.repeat(64),
    sizeBytes: 1024,
    blobPath: `firmware/${version}.uf2`,
    signature: 'ZTJlLXRlc3Q=',
    signingKeyId: 'e2e',
    notes: opts.notes ?? null,
    security: opts.security ?? false,
    publishedByUserId: 'e2e',
  })
    // The version strings are fixed literals, so a run whose cleanup did not
    // complete would make every later run die on a duplicate-key error that
    // names nothing about firmware. Same idiom seedDisk already uses.
    .onConflictDoNothing();
}

/** Blob objects this suite put in the firmware store, removed alongside the rows. */
const seededFirmwareBlobs: string[] = [];

/**
 * A seeded release whose blob ACTUALLY EXISTS.
 *
 * publishTestRelease records a blobPath with no object behind it, which is
 * fine for the UI specs and useless for the download path -- a test that
 * asserted on 200 bytes with that fixture would fail for the wrong reason.
 */
export async function publishTestReleaseWithBlob(version: string): Promise<string> {
  if (!version.startsWith(E2E_RELEASE_PREFIX)) {
    throw new Error(`e2e releases must start with ${E2E_RELEASE_PREFIX}, got ${version}`);
  }
  const { put } = await import('@vercel/blob');
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from(`e2e firmware ${version}`);
  const blobPath = `firmware/${version}.uf2`;
  // allowOverwrite because a previous run's object may survive -- the same
  // re-runnability reasoning that gave publishTestRelease its onConflictDoNothing.
  await put(blobPath, bytes, {
    access: 'private', contentType: 'application/octet-stream',
    addRandomSuffix: false, allowOverwrite: true,
  });
  seededFirmwareBlobs.push(blobPath);

  const db = getDb();
  const rows = await db.select({ sequence: firmwareReleases.sequence }).from(firmwareReleases);
  const sequence = rows.reduce((m, r) => (r.sequence > m ? r.sequence : m), 0) + 1;
  await db.insert(firmwareReleases).values({
    id: randomUUID(), version, semver: '0.0.0', sequence,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength, blobPath,
    signature: 'ZTJlLXRlc3Q=', signingKeyId: 'e2e', notes: null,
    security: false, publishedByUserId: 'e2e',
  }).onConflictDoNothing();
  return version;
}

/** Removes every release this suite published. Called from the global teardown. */
export async function cleanupTestReleases(): Promise<number> {
  // Objects first: an orphaned firmware blob in the operator's private store
  // is exactly the kind of leftover this teardown exists to prevent, and the
  // row is what remembers where it is.
  if (seededFirmwareBlobs.length > 0) {
    const { del } = await import('@vercel/blob');
    for (const path of seededFirmwareBlobs.splice(0)) {
      await del(path).catch(() => { /* never uploaded, or already gone */ });
    }
  }
  const removed = await getDb()
    .delete(firmwareReleases)
    .where(like(firmwareReleases.version, `${E2E_RELEASE_PREFIX}%`))
    .returning({ id: firmwareReleases.id });
  return removed.length;
}

/** Sets desired firmware directly, the way the batch route does. */
export async function setDesiredFirmware(deviceId: string, version: string): Promise<void> {
  await getDb().update(devices)
    .set({
      desiredFirmwareVersion: version,
      desiredFirmwareSetAt: new Date(),
      desiredFirmwareSetByUserId: 'e2e',
      // Null so the poll reads this as unacknowledged and releases its hold
      // once -- a leftover state from a previous attempt would mean the
      // device is never told about the new one.
      firmwareUpdateState: null,
      firmwareUpdateError: null,
    })
    .where(eq(devices.id, deviceId));
}

/**
 * What firmware a device has been told to run, straight from the row.
 *
 * Used instead of a poll when a test asserts that NOTHING was written: a poll
 * with no update pending holds for the full 25 s by design, so using it to
 * prove an absence times the test out rather than answering the question.
 */
export async function desiredFirmwareOf(deviceId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ want: devices.desiredFirmwareVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row?.want ?? null;
}
