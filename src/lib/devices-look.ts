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

/**
 * The card's firmware words (operator 2026-11-12, "firmware in words"): the cell text without its build suffix
 * ("1.24.2+ged0ecc5e" reads "1.24.2"), and each part of the line starting with a capital: "1.24.2 · Up to date",
 * "Downloading 1.24.2", "Unknown". The full version stays in the cell's title and in Board settings. Dropping the
 * suffix is what stops the line wrapping mid-word at 390 px.
 */
export function firmwareCardText(s: string): string {
  return firmwareCellText(s)
    .replace(/(\d+\.\d+\.\d+[0-9A-Za-z.-]*)\+[0-9A-Za-z.-]+/g, '$1')
    .replace(/(^|· )([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

/** A firmware version without its build suffix, for a button's words: "1.24.2+ged0ecc5e" -> "1.24.2". */
export function shortVersion(v: string): string {
  return v.replace(/\+.*$/, '');
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
    return { label: 'In the drive', labelTone: 'muted-2', title: 'No disk', meta: 'Pick a game in the Library and press Mount.' };
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

/**
 * The Signal fact (spec §2.1, in words since 2026-11-12): lit bars (0..3), a word from the same thresholds as the
 * bars -- Good (3), Fair (2), Weak (1 or 0) -- and the reading in dBm for the cell's title. None, a dash and no title
 * while offline or unreported.
 */
export function signalCell(rssi: number | null, online: boolean): { lit: number; text: string; title: string | null } {
  if (!online || rssi === null || rssiBars(rssi) < 0) return { lit: 0, text: '—', title: null };
  const lit = rssiBars(rssi);
  return { lit, text: lit === 3 ? 'Good' : lit === 2 ? 'Fair' : 'Weak', title: `${rssi} dBm` };
}

/** The Network fact in words (2026-11-12): both values, "Wi-Fi" while online and "Not connected" while offline. The
 *  MAC address lives in Board settings. */
export function networkCell(online: boolean): string {
  return online ? 'Wi-Fi' : 'Not connected';
}

/**
 * Whether the card offers "Get started" (2026-11-12): until the board's first disk. There is no "ever mounted" column,
 * so the signal is that the board holds no disk, none is on its way, and none was ever ejected from it (lastDiskId is
 * set by every web eject and kept). A disk deleted from the library clears lastDiskId, so the block can come back for
 * an empty board whose only disk was deleted; Dismiss hides it for good in that browser.
 */
export function needsGetStarted(d: Pick<DeviceListItem, 'desiredSha256' | 'mountedSha256' | 'lastDiskId'>): boolean {
  return d.desiredSha256 === null && d.mountedSha256 === null && d.lastDiskId === null;
}
