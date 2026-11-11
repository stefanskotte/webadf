// Fitted as (2026-11-11, Pillock in the WifiFloppy thread): where the board sits, inside the Amiga or in an external
// drive case. No database import here: client components read these; the write is in fitted-as-store.ts.
//
// The board never chooses its drive number. It answers on whatever select line its cable brings to its SEL0 input:
// the internal connector's SEL0 makes it DF0; an external case wires the DB23 port's SEL1 there, so the Amiga sees
// DF1 (the board answers the drive ID that Kickstart asks DF1-DF3 for). The external port carries no SEL0, so the
// board cannot tell where it is fitted -- hence a setting, used only to NAME the drive. Its own second drive comes
// from a tap on the internal connector (CN11 pin 12, SEL1); an external case would need SEL2 wired instead, which
// common cases do not pass, so External keeps the second drive Off.

export type FittedAs = 'internal' | 'external';
export type DriveName = 'DF0' | 'DF1';

/** A stored value, or 'internal' for anything else (every board before this setting). */
export function asFittedAs(v: string | null | undefined): FittedAs {
  return v === 'external' ? 'external' : 'internal';
}

/** What the Amiga calls the board's main drive. */
export function mainDrive(f: FittedAs | null | undefined): DriveName {
  return f === 'external' ? 'DF1' : 'DF0';
}

export const FITTED_AS_OPTIONS: { value: FittedAs; label: string }[] = [
  { value: 'internal', label: 'Inside the Amiga' },
  { value: 'external', label: 'External drive case' },
];

export const FITTED_AS_HINT: Record<FittedAs, string> = {
  internal: 'On the internal floppy connector: the Amiga sees the board as DF0.',
  external: 'On the external floppy port: the Amiga sees the board as DF1, and the board has no second drive.',
};

/** Why the second drive cannot be switched on: the reason under the setting, and the refused save's. */
export const EXTERNAL_NO_SECOND_DRIVE = 'The board is fitted in an external case, which has no line for a second drive';
