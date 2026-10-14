// DF1 any disk (spec docs/superpowers/specs/2026-10-14-df1-any-disk-design.md §3): who may mount what into DF1,
// the words for each refusal, and the card's DF1 line. Pure and client-safe -- no database import -- so the Mount
// buttons, the device card, the drive menu and the server action read ONE set of rules and can never disagree.
import { firmwareAtLeast } from '@/lib/firmware-version';
import { adfDensity } from '@/lib/disk-format';
import type { NextInfo } from '@/lib/next-disk';

/** The firmware that keeps a disk mounted into DF1 in DF1's own slot (spec §5). */
export const DF1_PICK_FW = '1.12.0';

/** Why a disk cannot go into DF1, first match wins: the setting, the board, then the disk. */
export type Df1Refusal = 'df1_off' | 'waiting' | 'firmware_too_old' | 'not_dd' | 'in_df0';

export const DF1_REFUSAL_TEXT: Record<Df1Refusal, string> = {
  df1_off: 'DF1 is off',
  // Plan ruling 6: On chosen, not yet applied -- the card's own wording (secondDriveStatus).
  waiting: 'Waiting for the board',
  firmware_too_old: `Needs firmware ${DF1_PICK_FW}`,
  not_dd: 'DF1 takes standard DD disks only',
  in_df0: 'Already in DF0',
};

export interface Df1Board {
  secondDrive: string;
  secondDriveReported: string | null;
  secondDriveVersion: number;
  secondDriveAppliedVersion: number | null;
  firmwareVersion: string | null;
  desiredDiskId: string | null;
  mountedDiskId: string | null;
  df1DiskId: string | null;
}

export interface Df1Disk { id: string; imageFormat: string; sizeBytes: number }

/** Spec §3.1 rule 3: an ADF of exactly 901,120 bytes. No HD, HFE, extended or long-track image. */
export function isStandardDd(d: { imageFormat: string; sizeBytes: number }): boolean {
  return d.imageFormat === 'adf' && adfDensity(d.sizeBytes) === 'dd';
}

/**
 * Spec §3.1, all four rules (the org rule is the caller's: the disk passed in is already this org's row).
 * Rule 4 compares disk ROWS: the same image under another row may go to DF1 (spec §8.2).
 */
export function df1Refusal(b: Df1Board, d: Df1Disk): Df1Refusal | null {
  if (b.secondDrive !== 'df1') return 'df1_off';
  if (b.secondDriveReported !== 'df1' || b.secondDriveAppliedVersion !== b.secondDriveVersion) return 'waiting';
  if (!firmwareAtLeast(b.firmwareVersion, DF1_PICK_FW)) return 'firmware_too_old';
  if (!isStandardDd(d)) return 'not_dd';
  if ((b.desiredDiskId ?? b.mountedDiskId) === d.id) return 'in_df0';
  return null;
}

export interface Df1Option {
  enabled: boolean;
  /** The refusal in words while disabled; null while enabled. */
  reason: string | null;
  /** This disk is the one in DF1: the button takes it out. */
  isThisDisk: boolean;
}

/** What a Mount button offers for DF1, or null: the board's setting is not On (D1, plan ruling 6). */
export function df1Option(b: Df1Board, d: Df1Disk): Df1Option | null {
  if (b.secondDrive !== 'df1') return null;
  if (b.df1DiskId === d.id) return { enabled: true, reason: null, isThisDisk: true };
  const r = df1Refusal(b, d);
  return { enabled: r === null, reason: r === null ? null : DF1_REFUSAL_TEXT[r], isThisDisk: false };
}

/** Exactly the fields above, for a client component's props (a DeviceListItem also carries a layout blob). */
export function df1BoardOf(b: Df1Board): Df1Board {
  return {
    secondDrive: b.secondDrive, secondDriveReported: b.secondDriveReported,
    secondDriveVersion: b.secondDriveVersion, secondDriveAppliedVersion: b.secondDriveAppliedVersion,
    firmwareVersion: b.firmwareVersion, desiredDiskId: b.desiredDiskId, mountedDiskId: b.mountedDiskId,
    df1DiskId: b.df1DiskId,
  };
}

export interface Df1Line {
  df1DiskId: string | null;
  df1PickTitle: string | null;
  df1PickDiskNo: number | null;
  df1PickSha256: string | null;
  /** What the board reports DF1 holds. */
  df1Sha256: string | null;
}

/**
 * The DF1 line on the card and in the drive menu (spec §3.3), both states in words. A pick reads "loading" until
 * the board reports holding exactly its digest.
 */
export function df1LineText(d: Df1Line, next: NextInfo | null): string {
  if (d.df1DiskId !== null) {
    const what = `${d.df1PickTitle ?? 'A disk'}${d.df1PickDiskNo !== null ? ` disk ${d.df1PickDiskNo}` : ''}`;
    const held = d.df1PickSha256 !== null && d.df1Sha256 === d.df1PickSha256;
    return `DF1: ${what} — read-only${held ? '' : ', loading'}`;
  }
  if (d.df1Sha256 === null) return 'DF1: next disk of the set — empty';
  return next?.preload === 'ready'
    ? `DF1: next disk of the set — disk ${next.diskNo}`
    : 'DF1: next disk of the set — ready';
}
