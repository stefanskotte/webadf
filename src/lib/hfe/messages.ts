// Every sentence a person reads about an HFE disk. Spec D3/D5/D6 give the
// wording; tests compare against these constants, so copy changes happen here.

export const HFE_V3_REFUSAL =
  "HFE v3 isn't supported yet — it can carry weak-bit and variable-density protections the board can't replay. Save it as HFE v1 (e.g. with HxC or Greaseweazle) if the disk doesn't need them.";

export const NOT_AMIGA = 'Not an Amiga disk: track 0 has no Amiga boot sectors.';

export const WEAK_BIT_NOTICE =
  "Weak-bit copy protections aren't supported — some protected titles may not load.";

export const NOT_EXTRACTABLE = 'Not a standard AmigaDOS disk — play only';

export const HFE_READ_ONLY = 'HFE disks are read-only. Extract it as an ADF to change its files.';

export function extraCylindersNotice(cylinders: number): string {
  return `cylinders 80–${cylinders - 1} present: not served by the board`;
}
