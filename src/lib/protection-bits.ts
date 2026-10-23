/**
 * The eight AmigaDOS protection flags the disk browser shows and edits (A5),
 * in `protectionString`'s order (adffs/dir.ts). The low four (rwed) are
 * INVERTED on disk: a set bit forbids the action, so "allowed" is bit clear.
 */
export const PROTECTION_FLAGS = [
  { letter: 'h', bit: 0x80, inverted: false, label: 'Hidden' },
  { letter: 's', bit: 0x40, inverted: false, label: 'Script' },
  { letter: 'p', bit: 0x20, inverted: false, label: 'Pure (can be made resident)' },
  { letter: 'a', bit: 0x10, inverted: false, label: 'Archived' },
  { letter: 'r', bit: 0x08, inverted: true, label: 'Readable' },
  { letter: 'w', bit: 0x04, inverted: true, label: 'Writable' },
  { letter: 'e', bit: 0x02, inverted: true, label: 'Executable' },
  { letter: 'd', bit: 0x01, inverted: true, label: 'Deletable' },
] as const;

/** "-s--rwed" -> 0x40: the inverse of `protectionString` for the low eight bits. */
export function bitsFromProtection(shown: string): number {
  let bits = 0;
  PROTECTION_FLAGS.forEach((f, i) => {
    const on = shown[i] === f.letter;
    if (on !== f.inverted) bits |= f.bit;
  });
  return bits;
}
