// Original drive (rev C, 2026-11-19; wifi-floppy/hardware/rev-c/README.md "Original drive connector"). A rev C board
// can carry the Amiga's own floppy drive on its EXT DRV connector, and a PCA9536 expander tells it whether one is
// plugged in. Auto (the default): a drive found at power-on becomes DF0, the board's main drive DF1 and its second
// drive DF2. Off: the original drive is never used. Operator ruling 2026-11-19: the setting and the drive's presence
// take effect ONLY at power-on, never live. No database import here: client components read these; the write is in
// orig-drive-store.ts.

export type OrigDriveMode = 'auto' | 'off';

/** A stored or reported mode, or null for anything this server does not know. */
export function asOrigDriveMode(v: string | null): OrigDriveMode | null {
  return v === 'auto' || v === 'off' ? v : null;
}

export const ORIG_DRIVE_OPTIONS: { value: OrigDriveMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
];

export const ORIG_DRIVE_HINT: Record<OrigDriveMode, string> = {
  auto: 'A drive plugged into the board’s EXT DRV connector becomes DF0, and the board answers as DF1 + DF2.',
  off: 'The original drive is never used: the board is DF0 + DF1.',
};

/** The ruling of 2026-11-19, said wherever the setting is. */
export const ORIG_DRIVE_APPLIES = 'Applies the next time the Amiga is switched on.';

/** Why Drive numbers cannot change while the original drive is in use: the control's line and the refused save. */
export const ORIG_DRIVE_ACTIVE_REASON = 'The original drive is DF0, so the board is DF1 + DF2';

export type SaveOrigDriveOutcome = { version: number } | 'not_found' | 'not_capable';

/** What the board is doing now, in words: both values of each state (in use, or why not). */
export function origDriveStatus(d: {
  origDriveReported: OrigDriveMode | null; origDrivePresent: boolean; origDriveActive: boolean;
}): string {
  if (d.origDriveActive) return 'In use as DF0';
  if (d.origDriveReported === 'off') return 'Off';
  if (!d.origDrivePresent) return 'No drive found at power-on';
  // Present but not active: auto chosen after the power-on that found it, or a board that has not said yet.
  return 'Drive found, not in use until the Amiga is switched on again';
}

/** A saved setting the board has not acked yet: the version moved past the board's origAck. */
export function origDrivePending(d: { origDriveVersion: number; origDriveAppliedVersion: number }): boolean {
  return d.origDriveVersion > d.origDriveAppliedVersion;
}
