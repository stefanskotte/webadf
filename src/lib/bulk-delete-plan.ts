import { holdLabel, holdsByGame, type DiskRef, type HoldDeviceRow } from '@/lib/drive-holds';

/**
 * Which titles of a bulk delete a board holds, and so are KEPT (spec 2026-10-26 library multi-select §3.3, Ruling 12).
 *
 * Pure, so it is tested without a database. A title is held when any of its disks is:
 *  - in DF0 by the card's own rule (holdsByGame: mounted, fetching or requested; an eject in flight holds nothing);
 *  - DF1's pick (df1DiskId) or DF1's reported content (df1Sha256 equal to one of its disks' sha);
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

  // Devices first, in their order, so one title held twice lists DF0 before DF1 for the same board.
  for (const dev of devices) {
    const df0 = holdsByGame([dev], disks, now);
    for (const [gameId, holds] of Object.entries(df0)) {
      for (const h of holds) {
        add(gameId, { deviceName: h.deviceName, drive: 'DF0', label: holdLabel(h, disksOf.get(gameId)?.length ?? 1) });
      }
    }
    const pick = dev.df1DiskId !== null ? diskById.get(dev.df1DiskId) : undefined;
    const content = pick ?? (dev.df1Sha256 !== null ? disks.find((d) => d.sha256 === dev.df1Sha256) : undefined);
    if (content) add(content.gameId, { deviceName: dev.name, drive: 'DF1', label: `In ${dev.name}${diskWords(content.gameId, content)}` });
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
