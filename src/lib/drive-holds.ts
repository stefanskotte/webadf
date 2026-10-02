import { deviceState, isOnline, type DeviceStateRow } from '@/lib/device-state';

/**
 * Which library titles are in a drive, for the card ring and its Eject.
 *
 * Pure, like mount-choice.ts, and for the same reason: every rule here is a
 * judgement about desired-versus-reported state. A converged board holds what
 * it REPORTS; a board with a request outstanding is fetching what was ASKED
 * for -- that is the disk the person is waiting on, so that card rings
 * (dashed) and the old one no longer does. A request to empty the drive
 * (desired null) rings nothing: the disk is on its way out.
 */
export interface HoldDeviceRow extends DeviceStateRow {
  id: string;
  name: string;
  desiredDiskId: string | null;
  mountedDiskId: string | null;
}

export interface DiskRef { id: string; gameId: string; diskNo: number }

export interface Hold {
  deviceId: string;
  deviceName: string;
  diskId: string;
  diskNo: number;
  /** 'mounted': the board confirmed it. 'fetching': asked for, not confirmed yet. */
  state: 'mounted' | 'fetching';
  /** False when the board has not been heard from lately (device-state.ts). */
  online: boolean;
}

export function holdsByGame(
  rows: readonly HoldDeviceRow[], disksById: ReadonlyMap<string, DiskRef>, now: number,
): Record<string, Hold[]> {
  const out: Record<string, Hold[]> = {};
  for (const row of rows) {
    const s = deviceState(row, now);
    if (s === 'empty') continue;
    const diskId = s === 'converged' ? row.mountedDiskId : row.desiredDiskId;
    // Off the page (a title this view does not show), or an eject in flight.
    const disk = diskId ? disksById.get(diskId) : undefined;
    if (!disk) continue;
    (out[disk.gameId] ??= []).push({
      deviceId: row.id, deviceName: row.name, diskId: disk.id, diskNo: disk.diskNo,
      state: s === 'converged' ? 'mounted' : 'fetching',
      online: isOnline(row.lastSeenAt, now),
    });
  }
  return out;
}

/** "In WifiFloppy1 — disk 2", the words on the card's Eject and its ring. */
export function holdLabel(h: Hold, diskCount: number): string {
  const where = h.state === 'mounted' ? `In ${h.deviceName}` : `Fetching to ${h.deviceName}`;
  const disk = diskCount > 1 ? ` — disk ${h.diskNo}` : '';
  return `${where}${disk}${h.online ? '' : ' (offline)'}`;
}
