import type { DeviceState } from '@/lib/device-state';
import type { DeviceListItem } from '@/lib/queries';
import { rssiBars } from '@/lib/live-display';

/**
 * Pure look rules for the Devices page (spec docs/superpowers/specs/2026-10-24-phase-c2-devices-design.md): the words
 * and colours a card shows, kept out of the components so they can be pinned by unit tests.
 */

/** The firmware cell's text (spec §2.2): a leading `fw ` goes; an update label passes through unchanged. */
export function firmwareCellText(s: string): string {
  return s.startsWith('fw ') ? s.slice(3) : s;
}

export type DriveBoxText = {
  label: string;
  labelTone: 'muted-2' | 'muted' | 'amber';
  title: string;
  meta: string;
};

/**
 * The drive box's three lines (spec §4.2), moved out of the card's inline heading / bigText / subText with the same
 * words. A pending state is a MOUNT when a disk is desired and an EJECT when none is: same state, opposite words.
 */
export function driveBoxText(
  d: Pick<DeviceListItem, 'mountedGame' | 'mountedDiskNo' | 'mountedSha256' | 'desiredGame' | 'desiredDiskNo'
    | 'desiredDiskCount' | 'desiredSha256'>,
  state: DeviceState,
): DriveBoxText {
  if (state === 'empty') {
    return { label: 'In the drive', labelTone: 'muted-2', title: 'No disk', meta: 'Mount a disk from any title in the library.' };
  }
  if (state === 'converged') {
    // desiredDiskCount is a SQL count(*), so it is 0 -- never null -- when nothing is desired; compare numerically.
    const count = (d.desiredDiskCount ?? 0) > 0 ? ` of ${d.desiredDiskCount}` : '';
    return {
      label: 'In the drive', labelTone: 'muted-2', title: d.mountedGame ?? 'Unknown',
      meta: `disk ${d.mountedDiskNo ?? '?'}${count}`,
    };
  }
  if (state === 'pending') {
    if (d.desiredSha256 === null) {
      return {
        label: 'Ejecting…', labelTone: 'muted', title: d.mountedGame ?? 'a disk',
        meta: `Removing disk ${d.mountedDiskNo ?? '?'}`,
      };
    }
    return {
      label: 'Mounting…', labelTone: 'muted', title: d.desiredGame ?? 'Unknown',
      meta: `disk ${d.desiredDiskNo ?? '?'}`
        + (d.mountedSha256 ? ` · currently holding ${d.mountedGame ?? 'a disk'} disk ${d.mountedDiskNo ?? '?'}` : ''),
    };
  }
  // stale: what was requested. The "last seen" fact lives in the offline strip, not here.
  return { label: 'Requested', labelTone: 'amber', title: d.desiredGame ?? 'Unknown', meta: `disk ${d.desiredDiskNo ?? '?'}` };
}

/** The status pill (spec §2.1). Both values are always drawn (Ruling 10: no "Reading"). */
export function statusPill(online: boolean): { label: string; bg: string; fg: string; dot: string; halo: string } {
  return online
    ? { label: 'Online', bg: 'var(--success-bg)', fg: 'var(--success-fg)', dot: 'var(--online-dot)', halo: 'rgb(63 191 85 / .2)' }
    : { label: 'Offline', bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', dot: 'var(--danger-fg)', halo: 'rgb(179 52 31 / .2)' };
}

/** The Signal fact (spec §2.1): lit bars (0..3) and the reading, or none and a dash while offline or unreported. */
export function signalCell(rssi: number | null, online: boolean): { lit: number; text: string } {
  if (!online || rssi === null) return { lit: 0, text: '—' };
  return { lit: Math.max(0, rssiBars(rssi)), text: `${rssi} dBm` };
}
