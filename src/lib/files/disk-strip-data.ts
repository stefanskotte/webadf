// The disk strip's server half (Files increment 1, Task 9): what a pane inside a disk shows above its rows besides the
// listing. The same reads the old Browse page made for its Disk card and History, so the two can never disagree.
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, games, blobs } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { devices } from '@/db/schema/devices';
import { orgFilter } from '@/db/scope';
import { isLocal } from '@/lib/remote-hidden';
import { nowMs } from '@/lib/clock';
import { listDevices } from '@/lib/queries';
import { mountChoices } from '@/lib/mount-choice';
import { kindFromSetName, pickKind } from '@/lib/game-kind';
import { isHdAdf } from '@/lib/disk-format';
import { titleDiskColor } from '@/lib/library-look';
import { loadHistory, type HistoryVersion } from '@/lib/disk-history/history';
import type { StripData } from './types';

/**
 * A disk of this library by id: its title and format, or null. The entitlement is the boundary, not the disk row (the
 * pair every disk read uses), and a hidden remote stand-in is not a disk of this library -- both 404 like a foreign id.
 */
export async function libraryDiskOf(orgId: string, diskId: string): Promise<{ gameId: string; imageFormat: string } | null> {
  const [row] = await getDb()
    .select({ gameId: disks.gameId, imageFormat: disks.imageFormat })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId), isLocal(disks)))
    .limit(1);
  return row ?? null;
}

/**
 * The strip for one disk, or null when it is not this library's. A history that cannot be loaded (a broken chain, an
 * unreadable blob) degrades to `historyUnavailable` rather than failing the strip: the disk's current bytes may be
 * perfectly fine, and the old page made the same call.
 */
export async function diskStripData(orgId: string, diskId: string): Promise<StripData | null> {
  const db = getDb();
  const [disk] = await db
    .select({ sha256: disks.sha256, gameId: disks.gameId, imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes,
      authored: games.authored })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .leftJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, orgId)))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId), isLocal(disks)))
    .limit(1);
  if (!disk) return null;

  const [deviceRows, kindRows, deviceNames] = await Promise.all([
    listDevices(orgId),
    db.select({ setName: tosecEntries.setName })
      .from(disks)
      .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
      .innerJoin(tosecEntries, eq(tosecEntries.id, blobs.tosecEntryId))
      .where(and(eq(disks.gameId, disk.gameId), eq(disks.orgId, orgId))),
    db.select({ id: devices.id, name: devices.name }).from(devices).where(orgFilter(devices, orgId))
      .then((rows) => new Map(rows.map((d) => [d.id, d.name] as const))),
  ]);

  let history: HistoryVersion[] = [];
  let historyUnavailable = false;
  try {
    history = await loadHistory(orgId, diskId, deviceNames);
  } catch (err) {
    console.error(`disk strip: history unavailable for disk ${diskId}`, err);
    historyUnavailable = true;
  }

  const choices = mountChoices(deviceRows,
    { id: diskId, sha256: disk.sha256, imageFormat: disk.imageFormat, sizeBytes: disk.sizeBytes }, nowMs());
  const kind = pickKind(kindRows.map((r) => kindFromSetName(r.setName)));
  return {
    diskId, choices, history, historyUnavailable,
    headSeq: history.find((v) => v.isHead)?.seq ?? null,
    color: titleDiskColor({ id: diskId, hasHd: isHdAdf(disk), kind, formats: [disk.imageFormat], authored: disk.authored ?? false }),
  };
}
