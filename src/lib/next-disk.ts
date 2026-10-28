import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { isLocal } from '@/lib/remote-hidden';
import { devices } from '@/db/schema/devices';
import { isHdAdf, isServable } from '@/lib/disk-format';
import { LEGACY_BOARD_TRACK_MAX_BYTES } from '@/lib/adfmfm/constants';

/**
 * "Next disk" (multi-disk spec §2): the one rule the tap, the web action and
 * the poll all use, so the board, the chip and the card can never disagree
 * about what "next" is.
 */
export type NextCandidate = {
  id: string; diskNo: number; sha256: string;
  imageFormat: string; sizeBytes: number; maxTrackBits: number | null;
};
export type BoardCaps = { trackMaxBytes: number | null; playsHd: boolean };
export type NextResult =
  | { kind: 'disk'; disk: NextCandidate; diskCount: number; wraps: boolean }
  | { kind: 'single' }
  | { kind: 'nothing_mounted' };

/** The same two checks setDesired makes in its UPDATE (mount.ts), in JS. */
export function boardHolds(d: NextCandidate, b: BoardCaps): boolean {
  if (!isServable(d)) return false;
  if (isHdAdf(d) && !b.playsHd) return false;
  if (d.maxTrackBits !== null && (b.trackMaxBytes ?? LEGACY_BOARD_TRACK_MAX_BYTES) * 8 < d.maxTrackBits) return false;
  return true;
}

// Plan R5: disks has no timestamp, so a duplicate disk number resolves to the lowest id.
const older = (a: NextCandidate, b: NextCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function nextDisk(all: NextCandidate[], currentId: string | null, b: BoardCaps): NextResult {
  const current = currentId ? all.find((d) => d.id === currentId) : undefined;
  if (!current) return { kind: 'nothing_mounted' };
  const diskCount = new Set(all.map((d) => d.diskNo)).size;
  // One row per disk number -- the oldest -- among the disks this board can hold.
  const byNo = new Map<number, NextCandidate>();
  for (const d of [...all].filter((x) => boardHolds(x, b)).sort(older)) {
    if (!byNo.has(d.diskNo)) byNo.set(d.diskNo, d);
  }
  const canon = [...byNo.values()].sort((x, y) => x.diskNo - y.diskNo);
  const after = canon.find((d) => d.diskNo > current.diskNo);
  const target = after ?? canon[0];
  if (!target || target.diskNo === current.diskNo) return { kind: 'single' };
  return { kind: 'disk', disk: target, diskCount, wraps: !after };
}

export type NextDeviceInput = { id: string; desiredDiskId: string | null; mountedDiskId: string | null } & BoardCaps;

/**
 * The disk a device is "currently on" for next-disk purposes: the WANTED
 * disk if a swap is in flight, else the mounted one (spec §2) -- so a
 * second tap during a swap counts from the disk already being moved to.
 */
export function currentDiskId(d: { desiredDiskId: string | null; mountedDiskId: string | null }): string | null {
  return d.desiredDiskId ?? d.mountedDiskId;
}

/**
 * The next disk for each of `devs`, in two queries whatever their number:
 * the current disks, then every disk of their titles. Org-scoped on both.
 */
export async function readNextForDevices(orgId: string, devs: NextDeviceInput[]): Promise<Map<string, NextResult>> {
  const out = new Map<string, NextResult>();
  const currentIds = [...new Set(devs.map(currentDiskId).filter((x): x is string => x !== null))];
  if (currentIds.length === 0) {
    for (const d of devs) out.set(d.id, { kind: 'nothing_mounted' });
    return out;
  }
  const db = getDb();
  // A hidden remote disk (library sharing, spec §4.1) has no next disk: its siblings are hidden too, and mounting
  // one straight from here would skip asking the owner again. Reads as nothing mounted, as for an unknown disk.
  const cur = await db.select({ id: disks.id, gameId: disks.gameId }).from(disks)
    .where(and(eq(disks.orgId, orgId), inArray(disks.id, currentIds), isLocal(disks)));
  const gameOf = new Map(cur.map((r) => [r.id, r.gameId]));
  const gameIds = [...new Set(cur.map((r) => r.gameId))];
  const rows = gameIds.length === 0 ? [] : await db.select({
    id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo,
    sha256: disks.sha256, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes,
    maxTrackBits: disks.maxTrackBits,
  }).from(disks).where(and(eq(disks.orgId, orgId), inArray(disks.gameId, gameIds), isLocal(disks)));
  for (const d of devs) {
    const c = currentDiskId(d);
    const g = c ? gameOf.get(c) : undefined;
    out.set(d.id, g ? nextDisk(rows.filter((r) => r.gameId === g), c, d) : { kind: 'nothing_mounted' });
  }
  return out;
}

/**
 * The minimal shape the poll route carries as `next` (multi-disk plan R1):
 * just enough for the board to preload -- a desired-shaped object would not
 * fit the byte budget (device-limits.test.ts). Resolved on delivery only,
 * never per tick -- see the poll route's comment where this is called.
 */
export async function readNextForPoll(deviceId: string, orgId: string): Promise<{ diskId: string; sha256: string; diskNo: number } | null> {
  const [dev] = await getDb().select({
    id: devices.id, desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId,
    trackMaxBytes: devices.trackMaxBytes, playsHd: devices.playsHd,
  }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!dev) return null;
  const r = (await readNextForDevices(orgId, [dev])).get(dev.id);
  return r?.kind === 'disk' ? { diskId: r.disk.id, sha256: r.disk.sha256, diskNo: r.disk.diskNo } : null;
}

/**
 * The preload line's three states, and null for none at all:
 *  - 'ready': the board verified THIS next disk in its idle slot;
 *  - 'loading': the board says a preload is in progress;
 *  - 'waiting': anything else a 1.6.0+ board reports -- nothing preloaded
 *    ('none'), or a ready record of a disk that is no longer next. "Loading"
 *    there would be false, possibly forever (a gate that never opens, a
 *    blocked digest), so it says only what is true: not preloaded yet;
 *  - null: a board too old to report `preload` -- the line is hidden.
 */
export type PreloadLine = 'ready' | 'loading' | 'waiting';

export type NextInfo = { diskNo: number; diskCount: number; wraps: boolean; preload: PreloadLine | null };

/** What the chip and the card show (plan R3). */
export function nextInfo(r: NextResult | undefined, preloadSha256: string | null, preloadState: string | null): NextInfo | null {
  if (!r || r.kind !== 'disk') return null;
  const preload: PreloadLine | null = preloadState === null ? null
    : preloadState === 'ready' && preloadSha256 === r.disk.sha256 ? 'ready'
    : preloadState === 'loading' ? 'loading'
    : 'waiting';
  return { diskNo: r.disk.diskNo, diskCount: r.diskCount, wraps: r.wraps, preload };
}
