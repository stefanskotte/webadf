import { deviceState, isOnline, relative, type DeviceState } from '@/lib/device-state';
// The same predicate DeviceCard (also client-rendered) already imports.
import { isDefaultDeviceName } from '@/lib/device-name';
// Type-only: live-state.ts pulls in node:crypto, and this module's output is
// handed to a client component. The import is erased at compile time.
import type { LiveStateRow } from '@/lib/live-state';
// Type-only, for the same reason: drive-chips.ts is handed to a client component.
import type { NextInfo, PreloadLine } from '@/lib/next-disk';
import { df1LineText } from '@/lib/df1-pick';

/** The preload line's words (nextInfo's PreloadLine) -- one place, so the
 *  drive chip and the device card can never word a state differently. Here
 *  rather than in next-disk.ts, which reads the database and must stay out of
 *  the client bundle. */
export function preloadText(diskNo: number, preload: PreloadLine): string {
  return preload === 'ready' ? `Disk ${diskNo} ready (instant swap)`
    : preload === 'loading' ? `Disk ${diskNo} loading…`
    : `Disk ${diskNo} not preloaded yet`;
}

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
  /** The disk's number in its title as reported (mountedDiskNo), or null when unknown. Shown on every title, a
   *  one-disk title included ("disk 1 of 1", C8 Ruling 4). */
  diskNo: number | null;
  /** How many disks its title has (mountedDiskCount, already in the live fingerprint), or null when unknown. */
  diskCount: number | null;
  writeProtected: boolean | null;
  /**
   * Why this disk can never be made writable, or null: an HFE (spec D2). The
   * PATCH refuses to unprotect one. HD disks are ordinary here (HD writes
   * spec §5.3).
   */
  readOnly: 'HFE' | null;
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
  /**
   * The next-disk verdict (multi-disk plan R3), set only once the board has
   * CONVERGED on its current disk -- the same gate canToggleProtect uses, for
   * the same reason: while loading or ejecting, "next" would describe a swap
   * layered on top of one already in flight.
   */
  next: NextInfo | null;
  /**
   * DF1 (spec 2026-10-14 §3.3, plan ruling 7): the card's DF1 line while the board runs On -- the next disk of the
   * set, or the disk mounted into DF1, both in words. Null when DF1 is not On: there is no DF1 to describe.
   */
  df1: string | null;
  /**
   * While offline: how long ago the board was last heard from, `relative()`'s words ("5m ago"). Null while online.
   * The same text the live fingerprint hashes for every offline board, so the card's offline line never freezes.
   */
  seen: string | null;
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
          diskNo: r.mountedDiskNo,
          diskCount: r.mountedDiskCount,
          writeProtected: r.mountedDiskWriteProtected,
          readOnly: r.mountedImageFormat === 'hfe' ? 'HFE' : null,
        }
      : null;

  return {
    id: r.id,
    name: r.name,
    shortName: isDefaultDeviceName(r.name, r.macAddress) && r.macAddress
      ? `…${r.macAddress.slice(-5)}`
      : r.name,
    online: isOnline(r.lastSeenAt, now),
    seen: isOnline(r.lastSeenAt, now) ? null : relative(r.lastSeenAt, now),
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
    next: phase === 'loaded' ? r.next : null,
    df1: r.secondDriveReported === 'df1' ? df1LineText(r, r.next) : null,
  };
}

/** Ordered like /devices (listDevices orders by name), id as the tiebreak. */
export function driveChips(rows: readonly LiveStateRow[], now: number): DriveChip[] {
  return rows
    .map((r) => toDriveChip(r, now))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** At most `max` chips in the header; the rest go behind a "+k" chip. No width fits three 240 px chips. */
export const MAX_CHIPS = 2;

/**
 * How many chips fit beside the wordmark at a viewport width (0 below xl, where the compact control is used
 * instead). `showAdmin` is the layout's own flag (the Admin item widens the pill) and `boards` how many boards the org
 * has (whether a "+k" chip has to fit too).
 *
 * C8 (spec §2.1), by arithmetic on 2026-10-26: the chips start 16 px after the wordmark (x = 168) and stop 16 px
 * short of the viewport-centred pill (left edge 481 / 609 / 801 for a member, 443 / 571 / 763 with Admin, at 1280 /
 * 1536 / 1920). The widest chip is its 240 px cap, chips sit 6 px apart, and "+k" keeps its compact ~45 px. So
 * n chips + "+k" end at 168 + 246n + 45:
 *   - member:     1 + "+k" ends at 459 (<= 465) / 459 (<= 593) / 2 + "+k" 705 (<= 785)  -> 1 / 1 / 2
 *   - with Admin: one board alone ends at 408 (<= 427), but 1 + "+k" at 459 runs past 427 at 1280 -> 0 there,
 *                 the compact control instead; 459 (<= 555) at 1536; 705 (<= 747) at 1920    -> 0 or 1 / 1 / 2
 * drive-chips.spec measures the widest case for both, at all three widths.
 * Measured 2026-10-26 in Chromium (widths of each painted chip and "+k"; gaps to the wordmark / the pill, px). "+k" is
 * 50.1 px, not the ~45 estimated, so member 1280 clears the pill by only 16.36 px (the test demands 16):
 *   member 1280 [240, 50.1] gaps 16.3 / 16.4;  1536 [240, 50.1] 80.3 / 80.4;  1920 [240, 240, 50.1] 53.3 / 53.3
 *   super-admin 1536 [240, 50.1] 61.3 / 61.3;  1920 [240, 240, 50.1] 34.3 / 34.3  (1280: compact control, no chip)
 * Any widening of the chip, "+k" or the gaps at 1280 breaks the member case first. The CSS in drive-chips.tsx mirrors these breakpoints literally (Tailwind cannot read them from here).
 */
export function chipSlots(viewportWidth: number, showAdmin = false, boards = 1): number {
  if (viewportWidth >= 1920) return 2;
  if (viewportWidth >= 1536) return 1;
  if (viewportWidth >= 1280) return showAdmin && boards >= 2 ? 0 : 1;
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

/** The card's second line (C8 spec §3.3): the title (a link when there is a game) and its count, or words. */
export type DiskLine = { kind: 'title'; title: string; count: string | null } | { kind: 'text'; text: string };

export function diskLine(c: DriveChip): DiskLine {
  switch (c.phase) {
    case 'empty': return { kind: 'text', text: 'Drive empty' };
    case 'loading': return { kind: 'text', text: `Loading ${c.loadingTitle ?? 'a disk'}…` };
    case 'ejecting': return { kind: 'text', text: `Ejecting ${c.disk?.title ?? 'a disk'}…` };
    case 'loaded':
      if (!c.disk) return { kind: 'text', text: 'A disk' };
      return {
        kind: 'title',
        title: c.disk.title,
        // Only a sane pair: stale data ("disk 3 of 2", "disk 1 of 0") is left off rather than shown.
        count: c.disk.diskNo !== null && c.disk.diskCount !== null && c.disk.diskNo >= 1 && c.disk.diskNo <= c.disk.diskCount
          ? `disk ${c.disk.diskNo} of ${c.disk.diskCount}` : null,
      };
  }
}

/**
 * The Next button's words (the Devices card's) and its accessible name. The name starts with the visible words, so a
 * speech user can say what they see (WCAG 2.5.3); the count and the wrap follow.
 */
export function nextLabel(next: NextInfo): { text: string; name: string } {
  return {
    text: `Next: disk ${next.diskNo}`,
    name: `Next: disk ${next.diskNo} of ${next.diskCount}${next.wraps ? ' (wraps)' : ''}`,
  };
}
