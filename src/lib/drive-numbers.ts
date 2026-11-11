// Drive numbers (2026-11-11; replaces "Fitted as", same day): which DF numbers the board's two drives are. No
// database import here: client components read these; the write is in drive-numbers-store.ts.
//
// The board never chooses a number. Its main drive answers on whatever select line its cable brings to the main
// select input, its second drive on whatever reaches pin 12 (SEL1 on the A500's internal connector), and the Amiga
// names a drive by its select line. So the second drive is always the next number: DF0 + DF1 inside a wedge, DF1 + DF2
// on a wedge's external port (or a big box's second internal position), DF2 + DF3 on a big box's external port (some
// big boxes set their external port's numbers with a motherboard jumper), DF3 alone at the end of a chain. The board
// cannot see which lines it has (the external port carries no SEL0), hence a setting, used only to NAME the drives;
// the board is sent nothing. Its existing readings (a select seen on the second input; another drive answering
// there) say whether the second drive can work where it is.

export type DriveBase = 0 | 1 | 2 | 3;
export type DriveName = 'DF0' | 'DF1' | 'DF2' | 'DF3';

/** A stored value, or 0 (DF0 + DF1, every board before this setting) for anything else. */
export function asDriveBase(v: unknown): DriveBase {
  return v === 1 || v === 2 || v === 3 ? v : 0;
}

/** What the Amiga calls the board's main drive. */
export function mainDrive(base?: DriveBase | null): DriveName {
  return `DF${base ?? 0}` as DriveName;
}

/** What the Amiga calls the board's second drive; null at DF3, the last drive an Amiga has. */
export function secondDriveName(base?: DriveBase | null): DriveName | null {
  const b = base ?? 0;
  return b >= 3 ? null : `DF${b + 1}` as DriveName;
}

/**
 * A text written for the usual board (DF0 main, DF1 second), with this board's numbers: DF0 -> its main drive, DF1 ->
 * its second. One pass, so a renamed DF1 is never renamed again. At DF3 there is no second drive to name; "DF1" is then
 * left alone (no second-drive text is shown for such a board).
 */
export function nameDrives(text: string, base?: DriveBase | null): string {
  const b = base ?? 0;
  if (b === 0) return text;
  return text.replace(/\bDF([01])\b/g, (_, d: string) => (d === '0' ? mainDrive(b) : secondDriveName(b) ?? 'DF1'));
}

export const DRIVE_BASE_OPTIONS: { value: DriveBase; label: string }[] = [
  { value: 0, label: 'DF0 + DF1' },
  { value: 1, label: 'DF1 + DF2' },
  { value: 2, label: 'DF2 + DF3' },
  { value: 3, label: 'DF3 only' },
];

export const DRIVE_BASE_HINT: Record<DriveBase, string> = {
  0: 'On the internal floppy connector, the usual place.',
  1: 'On a wedge Amiga’s external port (A500, A600, A1200), or a big box’s second internal drive position.',
  2: 'On a big box’s external port (A2000, A3000, A4000) when it has two internal drives. Check its drive jumper.',
  3: 'Last on a chain of external drives: the board is DF3 and has no second drive.',
};

/** Why the second drive cannot be switched on at DF3: the card's line and the refused save's reason. */
export const NO_SECOND_DRIVE = 'The board is DF3, the last drive an Amiga has, so it has no second drive';
