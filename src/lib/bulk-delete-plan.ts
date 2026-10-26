import { isOnline } from '@/lib/device-state';
import { holdLabel, holdsByGame, type DiskRef, type HoldDeviceRow } from '@/lib/drive-holds';

/**
 * Which titles of a bulk delete a board holds, and so are KEPT (spec 2026-10-26 library multi-select §3.3, Ruling 12).
 *
 * Pure, so it is tested without a database. A title is held when any of its disks is:
 *  - in DF0 by the card's own rule (holdsByGame: mounted, fetching or requested), and ALSO the disk reported mounted
 *    in every state (an eject in flight, an offline board with a request outstanding);
 *  - DF1's pick (df1DiskId) and, separately, DF1's reported content (df1Sha256) when that is not the pick's bytes;
 *  - the disk of an open disk_write_sessions row (a board writing back).
 * A held title is kept whole, every disk of it, and the plan says where so the person knows what to eject.
 */
export interface PlanGame { id: string; title: string; year: number | null }
export interface PlanDevice extends HoldDeviceRow { df1DiskId: string | null; df1Sha256: string | null }
export interface PlanSession { deviceId: string; deviceName: string; diskId: string }
export interface HoldWhere { deviceName: string; drive: 'DF0' | 'DF1'; label: string }
export interface KeptTitle { id: string; title: string; holds: HoldWhere[] }
export interface BulkDeletePlan {
  /** In request order. */
  deletable: PlanGame[];
  deletableDiskIds: string[];
  /** Distinct, first seen first. */
  deletableShas: string[];
  /** In request order. */
  kept: KeptTitle[];
}

export function planBulkDelete(
  games: readonly PlanGame[], disks: readonly DiskRef[], devices: readonly PlanDevice[],
  sessions: readonly PlanSession[], now: number,
): BulkDeletePlan {
  const disksOf = new Map<string, DiskRef[]>();
  for (const d of disks) {
    const list = disksOf.get(d.gameId) ?? [];
    list.push(d);
    disksOf.set(d.gameId, list);
  }
  const diskById = new Map(disks.map((d) => [d.id, d] as const));
  const where = new Map<string, HoldWhere[]>();
  const add = (gameId: string, h: HoldWhere) => {
    const list = where.get(gameId) ?? [];
    list.push(h);
    where.set(gameId, list);
  };
  const diskWords = (gameId: string, d: DiskRef) => ((disksOf.get(gameId)?.length ?? 1) > 1 ? ` — disk ${d.diskNo}` : '');

  const byDiskOrSha = (id: string | null, sha: string | null): DiskRef | undefined =>
    id !== null ? diskById.get(id) : sha !== null ? disks.find((d) => d.sha256 === sha) : undefined;

  // Devices first, in their order, so one title held twice lists DF0 before DF1 for the same board.
  for (const dev of devices) {
    const df0 = holdsByGame([dev], disks, now);
    const held = new Set<string>();
    for (const [gameId, holds] of Object.entries(df0)) {
      for (const h of holds) {
        held.add(h.diskId);
        add(gameId, { deviceName: h.deviceName, drive: 'DF0', label: holdLabel(h, disksOf.get(gameId)?.length ?? 1) });
      }
    }
    // Controller amendment to Ruling 12: the disk a board reports MOUNTED holds in every state, alongside a requested
    // or fetching one -- an offline or stale board, or an eject in flight, still has it in the drive.
    const mounted = byDiskOrSha(dev.mountedDiskId, dev.mountedSha256);
    if (mounted && !held.has(mounted.id)) {
      const label = holdLabel({
        deviceId: dev.id, deviceName: dev.name, diskId: mounted.id, diskNo: mounted.diskNo, state: 'mounted',
        online: isOnline(dev.lastSeenAt, now), revertDiskId: null,
      }, disksOf.get(mounted.gameId)?.length ?? 1);
      add(mounted.gameId, { deviceName: dev.name, drive: 'DF0', label });
    }
    // DF1: the pick AND, separately, what the board reports in the drive when that is another disk.
    const pick = dev.df1DiskId !== null ? diskById.get(dev.df1DiskId) : undefined;
    if (pick) add(pick.gameId, { deviceName: dev.name, drive: 'DF1', label: `In ${dev.name}${diskWords(pick.gameId, pick)}` });
    if (dev.df1Sha256 !== null && pick?.sha256 !== dev.df1Sha256) {
      const content = disks.find((d) => d.sha256 === dev.df1Sha256);
      if (content) add(content.gameId, { deviceName: dev.name, drive: 'DF1', label: `In ${dev.name}${diskWords(content.gameId, content)}` });
    }
  }
  for (const s of sessions) {
    const d = diskById.get(s.diskId);
    if (d) add(d.gameId, { deviceName: s.deviceName, drive: 'DF0', label: `Writing on ${s.deviceName}` });
  }

  const deletable: PlanGame[] = [];
  const kept: KeptTitle[] = [];
  for (const g of games) {
    const holds = where.get(g.id);
    if (holds) kept.push({ id: g.id, title: g.title, holds });
    else deletable.push(g);
  }
  const ids = new Set(deletable.map((g) => g.id));
  const gone = disks.filter((d) => ids.has(d.gameId));
  return {
    deletable,
    deletableDiskIds: gone.map((d) => d.id),
    deletableShas: [...new Set(gone.map((d) => d.sha256))],
    kept,
  };
}
