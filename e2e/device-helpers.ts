import { randomUUID } from 'node:crypto';
import type { Page, APIRequestContext } from '@playwright/test';
import { getDb } from '@/db';
import { blobs, disks, games, entitlements } from '@/db/schema/catalog';
import './helpers';   // side effect: loads .env.local before @/db is used

/** Pair a device against the signed-in page's org and return its bearer token. */
export async function pairDevice(page: Page, request: APIRequestContext, name = 'Test Device') {
  const pair = await page.request.post('/api/devices/pair', { data: { name } });
  if (pair.status() !== 200) throw new Error(`pair failed: ${pair.status()}`);
  const { code } = await pair.json();

  // A bare request context, not the page's — the device has no session.
  const mac = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '3.0.0', macAddress: mac },
  });
  if (reg.status() !== 200) throw new Error(`register failed: ${reg.status()}`);
  const { token, deviceId } = await reg.json();
  return { deviceId: deviceId as string, token: token as string };
}

/**
 * Insert one game + disk + blob + entitlement directly. Faster than the real
 * ingest flow and enough for protocol tests, which are not about ingest.
 */
export async function seedDisk(
  orgId: string,
  opts: { title: string; diskNo: number; sha256: string },
) {
  const db = getDb();
  const gameId = `gam_${randomUUID()}`;
  const diskId = randomUUID();

  await db.insert(blobs).values({
    sha256: opts.sha256, sizeBytes: 901120, storageKey: `adf/${opts.sha256}`,
  }).onConflictDoNothing();

  // games has NO diskCount column — it is derived. sortTitle IS NOT NULL.
  await db.insert(games).values({
    id: gameId, orgId, title: opts.title, sortTitle: opts.title.toLowerCase(),
  });

  await db.insert(disks).values({
    id: diskId, gameId, orgId, diskNo: opts.diskNo, sha256: opts.sha256,
    label: `${opts.title} (Disk ${opts.diskNo})`, sizeBytes: 901120,
  });

  await db.insert(entitlements).values({
    orgId, sha256: opts.sha256, sourceFilename: `${opts.title}-${opts.diskNo}.adf`,
  }).onConflictDoNothing();

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

  return { diskId };
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}
