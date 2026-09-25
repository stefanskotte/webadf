import { deviceState, isOnline, type DeviceState } from '@/lib/device-state';
// The same predicate DeviceCard (also client-rendered) already imports.
import { isDefaultDeviceName } from '@/lib/device-name';
// Type-only: live-state.ts pulls in node:crypto, and this module's output is
// handed to a client component. The import is erased at compile time.
import type { LiveStateRow } from '@/lib/live-state';

/**
 * What a drive chip in the header says about one board (HANDOFF §4 backlog,
 * "Every wifi-floppy as a small floppy chip beside the top menu"; operator
 * approved the pictogram-free design 2026-09-25).
 *
 * Derived on the server, in the (app) layout, from the SAME liveStateRows the
 * live fingerprint hashes -- so a chip is exactly as fresh as everything else
 * LiveRefresh keeps current, with no poll of its own on every page.
 *
 * The phase is deviceState() re-read for a header, not a second classifier:
 * 'pending' and 'stale' both mean "desired and mounted differ", and which of
 * the two words to show -- loading or ejecting -- depends only on whether
 * anything is desired, exactly as DeviceCard decides "Mounting…" vs
 * "Ejecting…". Whether the board is still talking is a separate reading
 * (`online`), shown on the chip in its own right.
 */
export type DrivePhase = 'empty' | 'loaded' | 'loading' | 'ejecting';

export interface DriveChipDisk {
  /** The disk row the board REPORTED (mountedDiskId). */
  id: string;
  /** For "Go to disk" -- the game page is where a disk lives (disk-row.tsx). */
  gameId: string | null;
  title: string;
  /** Only on a multi-disk game; "disk 1" of a one-disk game says nothing. */
  diskNo: number | null;
  writeProtected: boolean | null;
  /** An HFE is always write-protected (spec D2); the PATCH refuses to unprotect one. */
  readOnly: boolean;
}

export interface DriveChip {
  id: string;
  /** The full alias -- the chip's `title` and the top of its menu. */
  name: string;
  /**
   * What fits on the chip itself. An unnamed board's default "Device
   * AA:BB:CC:DD:EE:FF" truncates to "Device A…" -- the same for every board,
   * which is exactly the several-identical-floppies problem the alias exists
   * to solve -- so it is shortened to the MAC's distinguishing tail instead.
   */
  shortName: string;
  online: boolean;
  state: DeviceState;
  phase: DrivePhase;
  /**
   * The disk in the drive as the BOARD reported it -- null when empty, and
   * null while loading (the reported disk then is the OLD one, and naming it
   * under "loading…" would describe the wrong disk, the same controller
   * ruling DeviceCard's write-protect tag follows).
   */
  disk: DriveChipDisk | null;
  /** While loading: the title of what was asked for, labelled as asked-for. */
  loadingTitle: string | null;
  canGoTo: boolean;
  canToggleProtect: boolean;
  canEject: boolean;
}

export function toDriveChip(r: LiveStateRow, now: number): DriveChip {
  const state = deviceState(r, now);
  const phase: DrivePhase =
    state === 'empty' ? 'empty'
    : state === 'converged' ? 'loaded'
    // pending or stale: something is outstanding. Nothing desired means the
    // outstanding thing is an eject.
    : r.desiredSha256 === null ? 'ejecting' : 'loading';

  // A board on older firmware can report a digest without a disk id; then
  // the chip knows SOMETHING is in the drive but not which row, and every
  // action that needs the row stays off rather than guessing one.
  const disk: DriveChipDisk | null =
    (phase === 'loaded' || phase === 'ejecting') && r.mountedDiskId
      ? {
          id: r.mountedDiskId,
          gameId: r.mountedGameId,
          title: r.mountedGameTitle ?? 'Untitled',
          diskNo: (r.mountedDiskCount ?? 0) > 1 ? r.mountedDiskNo : null,
          writeProtected: r.mountedDiskWriteProtected,
          readOnly: r.mountedImageFormat === 'hfe',
        }
      : null;

  return {
    id: r.id,
    name: r.name,
    shortName: isDefaultDeviceName(r.name, r.macAddress) && r.macAddress
      ? `…${r.macAddress.slice(-5)}`
      : r.name,
    online: isOnline(r.lastSeenAt, now),
    state,
    phase,
    disk,
    loadingTitle: phase === 'loading' ? r.desiredGameTitle : null,
    canGoTo: disk !== null && disk.gameId !== null,
    // Only once the board has CONVERGED on the disk. While ejecting, the
    // device no longer desires it, so the PATCH's desiredVersion bump would
    // not even reach this board -- a toggle there would change the disk's
    // flag somewhere else while looking like it acted here.
    canToggleProtect: phase === 'loaded' && disk !== null && disk.writeProtected !== null && !disk.readOnly,
    // The same condition DeviceCard draws its Eject button on. It is a
    // desired-state write, so an offline board can still be asked.
    canEject: r.desiredSha256 !== null || r.mountedSha256 !== null,
  };
}

/** Ordered like /devices (listDevices orders by name), id as the tiebreak. */
export function driveChips(rows: readonly LiveStateRow[], now: number): DriveChip[] {
  return rows
    .map((r) => toDriveChip(r, now))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** At most `max` chips in the header; the rest go behind a "+k" chip. */
export const MAX_CHIPS = 3;

/**
 * How many chips fit beside the wordmark at a viewport width (0 below xl,
 * where the compact "Drives" control is used instead).
 *
 * Measured 2026-09-25 in Chromium, not guessed. The chips start at x=132,
 * after the wordmark, and must stop short of the nav pill, which is centred
 * on the VIEWPORT (the layout's comment on why) and 248px wide -- 322px with
 * the Admin item. A chip with a long name and a long title is ~187px, the
 * "+k" chip ~50-65px. So, with Admin (the tighter case):
 *   - 1280 (xl):   pill at 479 -> ONE chip + "+k" ends at 373
 *   - 1536 (2xl):  pill at 607 -> TWO + "+k" end at 566
 *   - 1920:        pill at 799 -> THREE + "+k" end at 775, the design's maximum
 * Two at 1280 would end near 560, well into the pill.
 * The CSS in drive-chips.tsx mirrors these breakpoints literally (Tailwind
 * cannot read them from here); the e2e layout test proves 1280.
 */
export function chipSlots(viewportWidth: number): number {
  if (viewportWidth >= 1920) return 3;
  if (viewportWidth >= 1536) return 2;
  if (viewportWidth >= 1280) return 1;
  return 0;
}

export function splitChips<T>(chips: readonly T[], max = MAX_CHIPS): { shown: T[]; rest: T[] } {
  return { shown: chips.slice(0, max), rest: chips.slice(max) };
}

/**
 * The text a chip shows where the disk goes. Every phase has words: an empty
 * drive says "empty" rather than showing nothing (show both values of a
 * state -- an absent label is not a reading).
 */
export function diskText(c: DriveChip): string {
  switch (c.phase) {
    case 'empty': return 'empty';
    case 'loading': return 'loading…';
    case 'ejecting': return 'ejecting…';
    case 'loaded': return c.disk ? c.disk.title : 'a disk';
  }
}

/** The disk's own write-protect, as the chip's short tag. Null when there is no settled disk to describe. */
export function protectTag(c: DriveChip): 'WP' | 'RW' | null {
  if (c.phase !== 'loaded' || !c.disk) return null;
  if (c.disk.readOnly || c.disk.writeProtected === true) return 'WP';
  if (c.disk.writeProtected === false) return 'RW';
  return null;
}
