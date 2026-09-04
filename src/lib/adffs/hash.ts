// The AmigaDOS directory hash.
//
// Shared by the fixture builder (synthetic.ts) and production write paths --
// one implementation, so a fixture and a written disk cannot disagree about
// which hash bucket a name lands in.

import { HASH_TABLE_SIZE } from './constants';

/**
 * The AmigaDOS directory hash. INTL folds the extended Latin range as well as
 * ASCII, which is why 6 archive disks need the second variant.
 */
export function nameHash(name: string, intl: boolean): number {
  let hash = name.length;
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    const upper = intl
      ? ((c >= 0x61 && c <= 0x7a) || (c >= 0xe0 && c <= 0xfe && c !== 0xf7) ? c - 32 : c)
      : (c >= 0x61 && c <= 0x7a ? c - 32 : c);
    hash = ((hash * 13) + upper) >>> 0;
    hash = hash & 0x7ff;
  }
  return hash % HASH_TABLE_SIZE;
}
