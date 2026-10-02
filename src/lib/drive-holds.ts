import { deviceState, isOnline, type DeviceStateRow } from '@/lib/device-state';

/**
 * Which library titles are in a drive, for the card ring and its Eject.
 *
 * Pure, like mount-choice.ts, and it follows the same rules (the title page and
 * the card must never disagree): a converged board holds what it REPORTS; a
 * board with a request outstanding is fetching what was ASKED for -- that is
 * the disk the person is waiting on, so that card rings (dashed) and the old
 * one no longer does; an offline board with a request outstanding has it
 * "requested — not confirmed". A request to empty the drive (desired null)
 * rings nothing: the disk is on its way out. The disk id is matched first, and
 * the digest only when the id is null, exactly as mount-choice.ts does.
 */
export interface HoldDeviceRow extends DeviceStateRow {
  id: string;
  name: string;
  desiredDiskId: string | null;
  mountedDiskId: string | null;
}

export interface DiskRef { id: string; gameId: string; diskNo: number; sha256: string }

export interface Hold {
  deviceId: string;
  deviceName: string;
  diskId: string;
  diskNo: number;
  /** 'mounted': confirmed. 'fetching': asked for, board online. 'requested': asked for, board offline. */
  state: 'mounted' | 'fetching' | 'requested';
  /** False when the board has not been heard from lately (device-state.ts). */
  online: boolean;
  /**
   * For a Cancel while the board still holds a confirmed OTHER disk: that disk,
   * which the Cancel asks for again instead of emptying the drive
   * (mount-choice.ts revertDiskId). Null when nothing confirmed is in the drive.
   */
  revertDiskId: string | null;
}

export function holdsByGame(
  rows: readonly HoldDeviceRow[], pageDisks: readonly DiskRef[], now: number,
): Record<string, Hold[]> {
  const byId = new Map(pageDisks.map((d) => [d.id, d]));
  const bySha = new Map<string, DiskRef>();
  for (const d of pageDisks) if (!bySha.has(d.sha256)) bySha.set(d.sha256, d);

  const out: Record<string, Hold[]> = {};
  for (const row of rows) {
    const s = deviceState(row, now);
    if (s === 'empty') continue;
    const converged = s === 'converged';
    const diskId = converged ? row.mountedDiskId : row.desiredDiskId;
    const sha = converged ? row.mountedSha256 : row.desiredSha256;
    // Off the page (a title this view does not show), or an eject in flight.
    const disk = diskId !== null ? byId.get(diskId) : sha !== null ? bySha.get(sha) : undefined;
    if (!disk) continue;
    (out[disk.gameId] ??= []).push({
      deviceId: row.id, deviceName: row.name, diskId: disk.id, diskNo: disk.diskNo,
      state: converged ? 'mounted' : s === 'pending' ? 'fetching' : 'requested',
      online: isOnline(row.lastSeenAt, now),
      revertDiskId: !converged && row.mountedDiskId !== null && row.mountedDiskId !== disk.id
        ? row.mountedDiskId : null,
    });
  }
  return out;
}

/** "In WifiFloppy1 — disk 2": the words on the card's Eject, its picker and the ring. */
export function holdLabel(h: Hold, diskCount: number): string {
  const disk = diskCount > 1 ? ` — disk ${h.diskNo}` : '';
  if (h.state === 'requested') return `Requested on ${h.deviceName}${disk} — not confirmed`;
  if (h.state === 'fetching') return `Fetching to ${h.deviceName}${disk}`;
  return `In ${h.deviceName}${disk}${h.online ? '' : ' (offline)'}`;
}

/** What the card's button does to this hold: Eject a confirmed disk, Cancel a request. */
export function holdAction(h: Hold): 'Eject' | 'Cancel' {
  return h.state === 'mounted' ? 'Eject' : 'Cancel';
}
