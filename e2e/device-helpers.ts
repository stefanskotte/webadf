import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Page, APIRequestContext } from '@playwright/test';
import { getDb } from '@/db';
import { blobs, disks, games, entitlements } from '@/db/schema/catalog';
import { devices, pairingCodes } from '@/db/schema/devices';
import './helpers';   // side effect: loads .env.local before @/db is used

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
  await db.insert(games).values({
    id: gameId, orgId, title: opts.title, sortTitle: opts.title.toLowerCase(),
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
  } catch (e) {
    console.warn('cleanupSeeded: best effort, continuing —', (e as Error).message);
  } finally {
    seeded.gameIds.length = 0;
    seeded.diskIds.length = 0;
    seeded.shas.length = 0;
    seeded.deviceIds.length = 0;
    seeded.pairingCodes.length = 0;
  }
}
